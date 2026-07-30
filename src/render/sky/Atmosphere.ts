import * as THREE from 'three';
import { clamp, smoothstep, mix } from '../../util/Noise';

/**
 * Analytic daylight model — Preetham-family scattering, evaluated identically on
 * the CPU (here) and on the GPU (SkyMaterial.ts). Having one numerically-matched
 * implementation on each side is what lets the environment map, the
 * aerial-perspective fog and the drawn sky agree; if they disagree the horizon
 * shows a visible seam between "sky" and "distant stuff".
 *
 * Everything is parameterised on *solar elevation* rather than on the clock, so
 * the same tuning curve serves dawn and dusk and there is no discontinuity when
 * a shot picks an hour between the keyframes.
 *
 * ## Why this is not textbook Preetham
 *
 * The classic three.js `Sky` shader computes `pow(base * (1 - Fex), 1.5)` and
 * then undoes most of that with a `pow(colour, 1/(1.2 + 1.2·sunfade))` at the
 * very end. Net exponent ≈ 0.6–0.9. Ship the 1.5 without the compensating
 * gamma — which is what happens the moment you drop the shader into a real post
 * chain and let the grade own the tone curve — and the horizon comes out nine
 * times brighter than the zenith instead of three. Under AgX, which desaturates
 * hard above ~1.0 scene-linear, that is a white sky. It is exactly what this
 * project's frames were showing.
 *
 * So three things changed:
 *
 *  1. **Range compression is applied to luminance, not per channel.** `pow(y,P)`
 *     with the chroma ratios preserved keeps the horizon/zenith ratio near 3:1
 *     while a sunset stays as saturated as the physics says it is. A per-channel
 *     `pow` desaturates every pixel it compresses, which is the one thing this
 *     sky could not afford.
 *  2. **The sun path is spectral.** Radiance is multiplied by `sunT`, the
 *     per-channel transmittance along the ray *to the sun*. That is the actual
 *     mechanism that reddens a low sun, and it replaces the `pow(base*Fex, 0.5)`
 *     fudge the original used to fake it.
 *  3. **There is a multiple-scattering term.** Pure single scattering paints the
 *     entire sunset sky orange, because every scattering event is fed by the
 *     same reddened beam. Real skies stay blue overhead because that light has
 *     bounced several times, high up, through much less air. `msT` models that
 *     with a fraction of the sun-path optical depth, carrying the Rayleigh
 *     spectrum, whitening toward the horizon where the bounce count is high.
 *
 * Radiance is scene-linear, pre-tone-map, and sized so a sunlit pitch at ~0.18
 * sits under a zenith of ~0.22 and a horizon of ~0.8.
 */

const DEG = Math.PI / 180;

/* ----------------------------------------------------------- sun ephemeris */

/** Mid-August, ~40°N. Gives sunrise ≈ 05:55, solar noon 13:09, sunset ≈ 20:10. */
const LATITUDE = 40 * DEG;
const DECLINATION = 15 * DEG;
const SOLAR_NOON = 13.15;
/**
 * Rotation from "azimuth measured west of south" into world azimuth (measured
 * from +Z toward +X). Chosen so the setting sun sits ~30° off the endzone
 * camera axis: low raking light across the field with the disc of the sun just
 * inside frame, which is the shot the brief asks for.
 */
const AZIMUTH_OFFSET = 128 * DEG;

export interface SunPos {
  dir: THREE.Vector3;
  /** Degrees above the horizon. */
  elevation: number;
  /** World azimuth in radians, from +Z toward +X. */
  azimuth: number;
}

export function sunPosition(hour: number, out?: SunPos): SunPos {
  const H = (hour - SOLAR_NOON) * 15 * DEG;
  const sinEl = Math.sin(LATITUDE) * Math.sin(DECLINATION)
    + Math.cos(LATITUDE) * Math.cos(DECLINATION) * Math.cos(H);
  const el = Math.asin(clamp(sinEl, -1, 1));
  const az = Math.atan2(
    Math.sin(H),
    Math.cos(H) * Math.sin(LATITUDE) - Math.tan(DECLINATION) * Math.cos(LATITUDE),
  ) + AZIMUTH_OFFSET;
  const ce = Math.cos(el);
  const dir = out?.dir ?? new THREE.Vector3();
  dir.set(Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce);
  const res = out ?? { dir, elevation: 0, azimuth: 0 };
  res.dir = dir;
  res.elevation = el / DEG;
  res.azimuth = az;
  return res;
}

/**
 * Moon rides ~118° of azimuth off the sun, low enough (26°) to actually land in
 * a broadcast frame rather than above every camera's top edge.
 */
export function moonPosition(sun: SunPos, out = new THREE.Vector3()): THREE.Vector3 {
  const az = sun.azimuth - 118 * DEG;
  const el = 26 * DEG;
  const ce = Math.cos(el);
  return out.set(Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce);
}

/* ------------------------------------------------------- scattering params */

export interface SkyTuning {
  /** Aerosol load. Low = deep blue crisp day, high = milky warm haze. */
  turbidity: number;
  /** Artistic Rayleigh multiplier — the main "how blue / how red" knob. */
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  /** Scales the compressed radiance field into the tonemapper's happy range. */
  exposure: number;
  /** Weight of the multiple-scattering term — the thing that keeps a sunset
   *  zenith blue instead of orange. */
  msStrength: number;
  /** 0..1 cloud cover. */
  cloudCoverage: number;
  cloudDensity: number;
  /** Fog thickness at ground level, per metre. */
  fogDensity: number;
}

interface Key extends SkyTuning { el: number }

/**
 * Keyframes over solar elevation. Each entry is a *look*, not a measurement:
 *  65°  harsh midday   — thin air, tight blue, small hot sun, hard cloud edges
 *  40°  afternoon      — the broadcast default
 *  9°   golden hour    — mie takes over, long warm gradient
 *  -1°  sunset         — maximum rayleigh, red belt on the horizon
 *  -18° night          — handled mostly by the night branch, kept dim here
 *
 * `exposure` climbs as the sun drops because the physical radiance collapses by
 * two orders of magnitude between noon and sunset — but only *part* of the way,
 * and that is a change from the first pass. The camera's own auto-exposure is
 * already opening up two and a half stops between 16:30 and 19:24 (it is
 * metering the pitch, which is what it should meter), and `EXPOSURE_TRACK` in
 * Sky.ts cancels 85 % of that back out of the dome. Compensating a *second*
 * time here is what put the 19:24 sky at 0.61 display luma — brighter than
 * anything else in the establishing wide including the floodlit bowl it is
 * supposed to be a backdrop for, and far enough up AgX's shoulder that it had
 * lost most of its chroma and read as flat tan. Roughly a third of a stop has
 * come out of the whole low-sun end of the table: the dusk sky now sits under
 * the lit pitch, and it keeps the amber it is entitled to.
 *
 * `cloudCoverage` comes *down*, hard, and that is the single biggest change in
 * this file. Rendering the dome with the cloud march switched off gave a clean
 * dusk gradient — (0.32, 0.44, 0.61) at 40° up, (0.61, 0.54, 0.43) at the
 * horizon — and switching it back on flattened the whole hemisphere to
 * (0.38, 0.37, 0.41). That is not a cloud *layer*, it is overcast: at 0.36–0.42
 * the field cleared its threshold nearly everywhere, so the sky was a
 * full-hemisphere sheet of thin grey stratus with a couple of wisps at the
 * edges where it happened to thin out. It is the "flat tan card" the round-2
 * review is looking at. A summer-evening sky wants roughly a quarter of the
 * hemisphere in cloud and the rest genuinely open, which is what these numbers
 * now produce.
 */
const KEYS: Key[] = [
  { el: -18, turbidity: 2.4, rayleigh: 1.00, mieCoefficient: 0.0040, mieDirectionalG: 0.800, exposure: 0.122, msStrength: 0.075, cloudCoverage: 0.16, cloudDensity: 0.75, fogDensity: 0.0016 },
  { el: -7, turbidity: 3.0, rayleigh: 1.90, mieCoefficient: 0.0052, mieDirectionalG: 0.820, exposure: 0.124, msStrength: 0.075, cloudCoverage: 0.19, cloudDensity: 0.85, fogDensity: 0.0019 },
  { el: -1, turbidity: 4.4, rayleigh: 2.50, mieCoefficient: 0.0090, mieDirectionalG: 0.845, exposure: 0.110, msStrength: 0.085, cloudCoverage: 0.22, cloudDensity: 0.95, fogDensity: 0.0024 },
  { el: 4, turbidity: 4.2, rayleigh: 2.40, mieCoefficient: 0.0084, mieDirectionalG: 0.840, exposure: 0.091, msStrength: 0.085, cloudCoverage: 0.23, cloudDensity: 1.0, fogDensity: 0.0022 },
  { el: 10, turbidity: 3.7, rayleigh: 2.10, mieCoefficient: 0.0068, mieDirectionalG: 0.825, exposure: 0.076, msStrength: 0.085, cloudCoverage: 0.22, cloudDensity: 1.0, fogDensity: 0.0019 },
  { el: 22, turbidity: 2.8, rayleigh: 1.75, mieCoefficient: 0.0044, mieDirectionalG: 0.790, exposure: 0.066, msStrength: 0.085, cloudCoverage: 0.20, cloudDensity: 1.0, fogDensity: 0.0015 },
  { el: 42, turbidity: 2.4, rayleigh: 1.45, mieCoefficient: 0.0035, mieDirectionalG: 0.755, exposure: 0.052, msStrength: 0.085, cloudCoverage: 0.18, cloudDensity: 1.0, fogDensity: 0.0012 },
  { el: 66, turbidity: 2.1, rayleigh: 1.28, mieCoefficient: 0.0029, mieDirectionalG: 0.725, exposure: 0.044, msStrength: 0.085, cloudCoverage: 0.16, cloudDensity: 1.0, fogDensity: 0.0010 },
];

export function tuningForElevation(el: number): SkyTuning {
  let i = 0;
  while (i < KEYS.length - 2 && el > KEYS[i + 1].el) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = smoothstep(a.el, b.el, el);
  return {
    turbidity: mix(a.turbidity, b.turbidity, t),
    rayleigh: mix(a.rayleigh, b.rayleigh, t),
    mieCoefficient: mix(a.mieCoefficient, b.mieCoefficient, t),
    mieDirectionalG: mix(a.mieDirectionalG, b.mieDirectionalG, t),
    exposure: mix(a.exposure, b.exposure, t),
    msStrength: mix(a.msStrength, b.msStrength, t),
    cloudCoverage: mix(a.cloudCoverage, b.cloudCoverage, t),
    cloudDensity: mix(a.cloudDensity, b.cloudDensity, t),
    fogDensity: mix(a.fogDensity, b.fogDensity, t),
  };
}

/* ------------------------------------------------------------- scattering */

// Preetham primaries at 680/550/450 nm.
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const RAYLEIGH_ZENITH = 8.4e3;
const MIE_ZENITH = 1.25e3;
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000.0;

const THREE_OVER_16PI = 0.05968310365946075;
const ONE_OVER_4PI = 0.07957747154594767;

/**
 * λ⁻⁴ shape of the multiple-scattering source, normalised to blue. The artistic
 * `rayleigh` multiplier cancels out of the ratio, so this really is a constant —
 * and it is what makes the twilight zenith blue rather than orange.
 */
export const BETA_RN: readonly [number, number, number] = [
  TOTAL_RAYLEIGH[0] / TOTAL_RAYLEIGH[2],
  TOTAL_RAYLEIGH[1] / TOTAL_RAYLEIGH[2],
  1,
];
/**
 * What multiply-scattered light converges on once it has bounced enough to
 * forget its spectrum. Two regimes, blended on solar elevation:
 *
 *  - **High sun** — the bounces happen in the aerosol layer near the ground, lit
 *    by an almost-white sun, so the horizon whitens. This is real: a clear
 *    midday horizon is pale, not blue.
 *  - **Low sun** — the aerosol layer is in shadow and the multiply-scattered
 *    light comes from the air *above* it, which is still lit and still blue. So
 *    the twilight horizon away from the sun goes mauve, not khaki, and the frame
 *    gets the warm-to-cool banding that says "dusk" rather than "dust".
 */
export const HAZE_DAY: readonly [number, number, number] = [0.86, 0.94, 1.0];
export const HAZE_DUSK: readonly [number, number, number] = [0.60, 0.70, 1.0];
/**
 * Fraction of the sun-path optical depth the multi-scatter term walks — two
 * values, blended along the same horizon weight as the haze tint.
 *
 * Looking *up*, the light that has bounced reaches you from the twilight arch
 * tens of kilometres above, where the sun is still well clear of the local
 * horizon and its path through air is a fraction of the one at ground level.
 * That light is barely reddened, so the twilight zenith stays blue.
 *
 * Looking *along* the horizon you are staring down the length of the aerosol
 * layer, and everything scattered into your eye there has itself come through
 * the same grazing sun path the direct beam did. That light is thoroughly
 * reddened, which is what makes the whole horizon ring warm at dusk and not
 * just the few degrees around the sun.
 *
 * Use one number for both and you have to pick which half of the sky to get
 * wrong: long gives a khaki zenith, short gives a grey horizon.
 */
export const MS_DEPTH_ZENITH = 0.05;
export const MS_DEPTH_HORIZON = 0.30;
/** Luminance compression exponent. 1 = physical, 0.6 = flat. */
export const COMPRESS = 0.72;

export function sunIntensityAt(zenithCos: number): number {
  const z = clamp(zenithCos, -1, 1);
  return EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(z)) / STEEPNESS)));
}

function hgPhase(cosTheta: number, g: number): number {
  const g2 = g * g;
  return ONE_OVER_4PI * ((1 - g2) / Math.pow(Math.max(1 - 2 * g * cosTheta + g2, 1e-4), 1.5));
}

/** Relative optical depth along a ray leaving the ground at elevation `dirY`. */
function opticalInverse(dirY: number): number {
  const zenith = Math.acos(Math.max(0, dirY));
  return 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - (zenith * 180) / Math.PI, -1.253));
}

const LUM = [0.2126, 0.7152, 0.0722];

/**
 * Everything the sky shader and the env bake need for one instant in time.
 * Colours are linear radiance, pre-tonemap.
 */
export class SkyState {
  hour = 17.5;
  sun: SunPos = { dir: new THREE.Vector3(0, 1, 0), elevation: 90, azimuth: 0 };
  moonDir = new THREE.Vector3(0, 1, 0);
  tuning: SkyTuning = tuningForElevation(45);
  /** 0 = full day, 1 = full night. */
  night = 0;
  /** 0 away from the horizon, 1 through the golden-hour / twilight window. */
  dusk = 0;

  betaR = new Float32Array(3);
  betaM = new Float32Array(3);
  /** Colour the multi-scatter term whitens toward. See HAZE_DAY / HAZE_DUSK. */
  hazeTint = new Float32Array(HAZE_DAY);
  /** Per-channel transmittance along the ray to the sun. Reddens the key. */
  sunT = new Float32Array(3);
  /** Multi-scatter transmittance looking up, and looking along the horizon. */
  msT = new Float32Array(3);
  msTH = new Float32Array(3);
  sunE = 0;

  /** Colour of direct sunlight at the ground, normalised to max component 1. */
  sunColor = new THREE.Color(1, 1, 1);
  /** DirectionalLight intensity that matches the sky's own exposure. */
  sunIntensity = 3.4;
  /** Unclamped extincted solar radiance — what the clouds are lit by. */
  sunRadiance = new THREE.Color(1, 1, 1);
  /** Radiance of the solar disc itself, already exposure-scaled. Clips, by design. */
  sunDisc = new THREE.Color(1, 1, 1);

  zenith = new THREE.Color();
  horizon = new THREE.Color();
  sunGlow = new THREE.Color();
  ground = new THREE.Color();

  setHour(hour: number): this {
    this.hour = hour;
    sunPosition(hour, this.sun);
    moonPosition(this.sun, this.moonDir);
    const el = this.sun.elevation;
    this.tuning = tuningForElevation(el);
    // Night starts the moment the disc touches the horizon and is complete by
    // the end of civil twilight; `dusk` peaks through the golden hour so peers
    // can drive warm-grade and lamp-warmup behaviour off one number.
    this.night = smoothstep(0.5, -7.5, el);
    this.dusk = smoothstep(20, 2, el) * (1 - this.night);

    const t = this.tuning;
    const hz = smoothstep(2, 26, el);
    for (let i = 0; i < 3; i++) this.hazeTint[i] = mix(HAZE_DUSK[i], HAZE_DAY[i], hz);

    const mieC = 0.434 * (0.2 * t.turbidity * 1e-17);
    const invSun = opticalInverse(this.sun.dir.y);
    for (let i = 0; i < 3; i++) {
      this.betaR[i] = TOTAL_RAYLEIGH[i] * t.rayleigh;
      this.betaM[i] = mieC * MIE_CONST[i] * t.mieCoefficient;
      const tau = (this.betaR[i] * RAYLEIGH_ZENITH + this.betaM[i] * MIE_ZENITH) * invSun;
      this.sunT[i] = Math.exp(-tau);
      this.msT[i] = Math.exp(-tau * MS_DEPTH_ZENITH);
      this.msTH[i] = Math.exp(-tau * MS_DEPTH_HORIZON);
    }
    this.sunE = sunIntensityAt(this.sun.dir.y);

    this.computeSunLight();
    this.computeAerial();
    return this;
  }

  /**
   * Direct sun colour is the transmittance along the path to the sun. Uses a
   * *physical* rayleigh (1.0) rather than the artistic sky value, otherwise the
   * key light goes tomato-red an hour before the sky justifies it.
   */
  private computeSunLight(): void {
    const inv = opticalInverse(this.sun.dir.y);
    const sR = RAYLEIGH_ZENITH * inv, sM = MIE_ZENITH * inv;
    const mieC = 0.434 * (0.2 * this.tuning.turbidity * 1e-17);
    const fex = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const tau = TOTAL_RAYLEIGH[i] * sR + mieC * MIE_CONST[i] * this.tuning.mieCoefficient * sM;
      fex[i] = Math.exp(-tau);
    }
    // Slight de-saturation: raw Preetham extinction is harsher than film.
    const soft = fex.map((v) => Math.pow(v, 0.78));
    const m = Math.max(soft[0], soft[1], soft[2], 1e-5);
    const lum = LUM[0] * fex[0] + LUM[1] * fex[1] + LUM[2] * fex[2];

    const day = smoothstep(-1.6, 3.5, this.sun.elevation);
    if (this.night > 0.98) {
      // Moonlight key: cool, dim, so stadium rigs dominate.
      this.sunColor.setRGB(0.55, 0.68, 1.0, THREE.LinearSRGBColorSpace);
      this.sunIntensity = 0.24;
    } else {
      this.sunColor.setRGB(soft[0] / m, soft[1] / m, soft[2] / m, THREE.LinearSRGBColorSpace);
      this.sunIntensity = mix(0.24, 4.3 * Math.max(lum, 0.02), day);
      if (this.night > 0) {
        const c = new THREE.Color(0.55, 0.68, 1.0);
        this.sunColor.lerp(c, this.night);
      }
    }

    // Radiance the cloud layer is lit by (not normalised — clouds want the
    // absolute value so a low sun genuinely under-lights them). The 0.19 puts a
    // side-lit cumulus flank near 0.6 and a forward-scattering rim well over 1,
    // which is what a silver lining is.
    const s = this.sunE * this.tuning.exposure * 0.19;
    this.sunRadiance.setRGB(fex[0] * s, fex[1] * s, fex[2] * s, THREE.LinearSRGBColorSpace);
    if (this.night > 0) {
      const moon = 0.10 * this.night;
      this.sunRadiance.lerp(new THREE.Color(moon * 0.62, moon * 0.74, moon), this.night);
    }

    // The disc. Deliberately far above white so bloom has a genuine highlight,
    // but built from the physical transmittance so a low sun is orange rather
    // than the tomato the artistic rayleigh would make of it.
    //
    // 1.35 → 1.9 to hold the disc where it was after a third of a stop came out
    // of the low-sun `exposure` keys. The sky around it is meant to come down;
    // the sun itself is meant to stay the one thing in an outdoor frame that is
    // allowed to clip.
    const d = this.sunE * this.tuning.exposure * 1.9 * (1 - this.night);
    this.sunDisc.setRGB(fex[0] * d, fex[1] * d, fex[2] * d, THREE.LinearSRGBColorSpace);
  }

  /** Cheap 3-colour fit of the sky used for aerial perspective. */
  private computeAerial(): void {
    const rgb: [number, number, number] = [0, 0, 0];
    this.radiance(0, 1, 0, rgb);
    this.zenith.setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace);

    // Horizon away from the sun, averaged over a few azimuths.
    const sx = this.sun.dir.x, sz = this.sun.dir.z;
    const l = Math.hypot(sx, sz) || 1;
    let hr = 0, hg = 0, hb = 0;
    const AZ = [Math.PI * 0.5, Math.PI, Math.PI * 1.5];
    for (const a of AZ) {
      const c = Math.cos(a), s = Math.sin(a);
      const dx = (sx / l) * c - (sz / l) * s;
      const dz = (sx / l) * s + (sz / l) * c;
      this.radiance(dx * 0.9994, 0.035, dz * 0.9994, rgb);
      hr += rgb[0]; hg += rgb[1]; hb += rgb[2];
    }
    this.horizon.setRGB(hr / 3, hg / 3, hb / 3, THREE.LinearSRGBColorSpace);

    // Excess radiance looking straight at the sun's horizon point.
    this.radiance((sx / l) * 0.9994, 0.035, (sz / l) * 0.9994, rgb);
    this.sunGlow.setRGB(
      Math.max(0, rgb[0] - this.horizon.r),
      Math.max(0, rgb[1] - this.horizon.g),
      Math.max(0, rgb[2] - this.horizon.b),
      THREE.LinearSRGBColorSpace,
    );

    // Turf bounce: the radiance leaving the pitch, which is what the lower half
    // of the environment map, the ambient under a cloud base and every
    // downward-looking fog ray actually see. It is albedo times the irradiance
    // landing on it, so it cannot exceed the pitch's own rendered value — a
    // bounce brighter than the surface it came off is the fastest way to turn a
    // stadium into a lightbox.
    const alb = [0.090, 0.160, 0.050];
    const sun = Math.max(0, this.sun.dir.y);
    this.ground.setRGB(
      alb[0] * (this.horizon.r * 0.5 + this.sunRadiance.r * sun * 0.35),
      alb[1] * (this.horizon.g * 0.5 + this.sunRadiance.g * sun * 0.35),
      alb[2] * (this.horizon.b * 0.5 + this.sunRadiance.b * sun * 0.35),
      THREE.LinearSRGBColorSpace,
    );
  }

  /**
   * In-scattered radiance for one direction. Mirror of `atmosphere()` in
   * SkyMaterial.ts — keep the two in step or the env map and the dome disagree.
   */
  radiance(dx: number, dy: number, dz: number, out: [number, number, number]): void {
    const t = this.tuning;
    const inv = opticalInverse(dy);
    const cosTheta = dx * this.sun.dir.x + dy * this.sun.dir.y + dz * this.sun.dir.z;
    const rp = THREE_OVER_16PI * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2));
    const mp = hgPhase(cosTheta, t.mieDirectionalG);

    // Optical *thickness* of the view ray, per channel: 0 straight up in clean
    // air, 1 along the horizon. It is both the in-scatter weight and the
    // "how many bounces" proxy the multi-scatter whitening keys off.
    const opa = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      opa[i] = 1 - Math.exp(-(this.betaR[i] * RAYLEIGH_ZENITH + this.betaM[i] * MIE_ZENITH) * inv);
    }
    const w = Math.pow(opa[1], 1.5);

    let y = 0;
    for (let i = 0; i < 3; i++) {
      const single = this.sunT[i] * (this.betaR[i] * rp + this.betaM[i] * mp)
        / (this.betaR[i] + this.betaM[i]);
      const ms = mix(this.msT[i], this.msTH[i], w);
      const multi = t.msStrength * ms * mix(BETA_RN[i], this.hazeTint[i], w);
      out[i] = Math.max(0, this.sunE * (single + multi) * opa[i]);
      y += LUM[i] * out[i];
    }
    // Compress luminance, keep chroma. A per-channel pow() would desaturate
    // every pixel it compressed — and the sunset is the whole point.
    const k = Math.pow(Math.max(y, 1e-6), COMPRESS) / Math.max(y, 1e-6) * t.exposure;
    for (let i = 0; i < 3; i++) out[i] *= k;

    if (this.night > 0) {
      const n = this.night;
      const h = clamp(dy, 0, 1);
      const zen = [0.0034, 0.0053, 0.0122];
      const hor = [0.0092, 0.0132, 0.0248];
      // Residual twilight in the sun's azimuth, plus warm city glow hugging the
      // skyline. Both are tight so the sky above them stays genuinely dark.
      const l = Math.hypot(this.sun.dir.x, this.sun.dir.z) || 1;
      const hl = Math.hypot(dx, dz) || 1;
      const az = ((this.sun.dir.x / l) * (dx / hl) + (this.sun.dir.z / l) * (dz / hl));
      const tw = Math.pow(Math.max(0, az), 2.2) * Math.exp(-h * 5.5)
        * smoothstep(-15, -1, this.sun.elevation);
      const glow = [0.62, 0.24, 0.10];
      const city = Math.exp(-h * 22) * 0.85;
      for (let i = 0; i < 3; i++) {
        const nightC = mix(hor[i], zen[i], Math.pow(h, 0.55))
          + glow[i] * tw
          + [0.0125, 0.0072, 0.0032][i] * city;
        out[i] = mix(out[i], nightC, n);
      }
    }
  }
}
