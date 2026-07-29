import * as THREE from 'three';
import { clamp, smoothstep, mix } from '../../util/Noise';

/**
 * Analytic daylight model — Preetham/Hosek-family single-scattering, evaluated
 * identically on the CPU (here) and on the GPU (SkyMaterial.ts). Having one
 * numerically-matched implementation on each side is what lets the environment
 * map, the aerial-perspective fog and the drawn sky agree; if they disagree the
 * horizon shows a visible seam between "sky" and "distant stuff".
 *
 * Everything is parameterised on *solar elevation* rather than on the clock, so
 * the same tuning curve serves dawn and dusk and there is no discontinuity when
 * a shot picks an hour between the keyframes.
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

/** Moon rides ~125° of azimuth off the sun at a comfortable broadcast altitude. */
export function moonPosition(sun: SunPos, out = new THREE.Vector3()): THREE.Vector3 {
  const az = sun.azimuth - 125 * DEG;
  const el = 41 * DEG;
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
  /** Scales the whole radiance field into the tonemapper's happy range. */
  exposure: number;
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
 */
const KEYS: Key[] = [
  { el: -18, turbidity: 2.4, rayleigh: 0.9, mieCoefficient: 0.0040, mieDirectionalG: 0.80, exposure: 0.030, cloudCoverage: 0.42, cloudDensity: 0.75, fogDensity: 0.0016 },
  { el: -7, turbidity: 3.2, rayleigh: 2.0, mieCoefficient: 0.0055, mieDirectionalG: 0.83, exposure: 0.032, cloudCoverage: 0.44, cloudDensity: 0.85, fogDensity: 0.0019 },
  { el: -1, turbidity: 4.6, rayleigh: 3.3, mieCoefficient: 0.0092, mieDirectionalG: 0.865, exposure: 0.034, cloudCoverage: 0.46, cloudDensity: 0.95, fogDensity: 0.0024 },
  { el: 4, turbidity: 4.3, rayleigh: 3.0, mieCoefficient: 0.0082, mieDirectionalG: 0.855, exposure: 0.032, cloudCoverage: 0.45, cloudDensity: 1.0, fogDensity: 0.0022 },
  { el: 10, turbidity: 3.7, rayleigh: 2.45, mieCoefficient: 0.0062, mieDirectionalG: 0.835, exposure: 0.030, cloudCoverage: 0.44, cloudDensity: 1.0, fogDensity: 0.0019 },
  { el: 22, turbidity: 3.0, rayleigh: 1.85, mieCoefficient: 0.0046, mieDirectionalG: 0.795, exposure: 0.0275, cloudCoverage: 0.42, cloudDensity: 1.0, fogDensity: 0.0015 },
  { el: 42, turbidity: 2.5, rayleigh: 1.45, mieCoefficient: 0.0036, mieDirectionalG: 0.755, exposure: 0.0255, cloudCoverage: 0.40, cloudDensity: 1.0, fogDensity: 0.0012 },
  { el: 66, turbidity: 2.1, rayleigh: 1.25, mieCoefficient: 0.0030, mieDirectionalG: 0.725, exposure: 0.0235, cloudCoverage: 0.38, cloudDensity: 1.0, fogDensity: 0.0010 },
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

export function sunIntensityAt(zenithCos: number): number {
  const z = clamp(zenithCos, -1, 1);
  return EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(z)) / STEEPNESS)));
}

function hgPhase(cosTheta: number, g: number): number {
  const g2 = g * g;
  return ONE_OVER_4PI * ((1 - g2) / Math.pow(1 - 2 * g * cosTheta + g2, 1.5));
}

/** Relative optical depth along a ray leaving the ground at elevation `dirY`. */
function opticalInverse(dirY: number): number {
  const zenith = Math.acos(Math.max(0, dirY));
  return 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - (zenith * 180) / Math.PI, -1.253));
}

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

  betaR = new Float32Array(3);
  betaM = new Float32Array(3);
  sunE = 0;

  /** Colour of direct sunlight at the ground, normalised to max component 1. */
  sunColor = new THREE.Color(1, 1, 1);
  /** DirectionalLight intensity that matches the sky's own exposure. */
  sunIntensity = 3.4;
  /** Unclamped extincted solar radiance — what the clouds are lit by. */
  sunRadiance = new THREE.Color(1, 1, 1);

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
    this.night = smoothstep(-1.5, -8.0, el);

    const t = this.tuning;
    const mieC = 0.434 * (0.2 * t.turbidity * 1e-17);
    for (let i = 0; i < 3; i++) {
      this.betaR[i] = TOTAL_RAYLEIGH[i] * t.rayleigh;
      this.betaM[i] = mieC * MIE_CONST[i] * t.mieCoefficient;
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
    const lum = 0.2126 * fex[0] + 0.7152 * fex[1] + 0.0722 * fex[2];

    const day = smoothstep(-1.6, 3.5, this.sun.elevation);
    if (this.night > 0.98) {
      // Moonlight key: cool, dim, so stadium rigs dominate.
      this.sunColor.setRGB(0.55, 0.68, 1.0, THREE.LinearSRGBColorSpace);
      this.sunIntensity = 0.28;
    } else {
      this.sunColor.setRGB(soft[0] / m, soft[1] / m, soft[2] / m, THREE.LinearSRGBColorSpace);
      this.sunIntensity = mix(0.28, 4.3 * Math.max(lum, 0.02), day);
      if (this.night > 0) {
        const c = new THREE.Color(0.55, 0.68, 1.0);
        this.sunColor.lerp(c, this.night);
      }
    }
    // Radiance the cloud layer is lit by (not normalised — clouds want the
    // absolute value so a low sun genuinely under-lights them).
    const s = this.sunE * this.tuning.exposure * 0.55;
    this.sunRadiance.setRGB(fex[0] * s, fex[1] * s, fex[2] * s, THREE.LinearSRGBColorSpace);
    if (this.night > 0) {
      const moon = 0.055 * this.night;
      this.sunRadiance.lerp(new THREE.Color(moon * 0.62, moon * 0.74, moon), this.night);
    }
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

    // Turf bounce for the lower env hemisphere.
    const a = [0.055, 0.082, 0.030];
    const sun = Math.max(0, this.sun.dir.y);
    this.ground.setRGB(
      a[0] * (this.horizon.r * 1.6 + this.sunRadiance.r * sun * 2.2),
      a[1] * (this.horizon.g * 1.6 + this.sunRadiance.g * sun * 2.2),
      a[2] * (this.horizon.b * 1.6 + this.sunRadiance.b * sun * 2.2),
      THREE.LinearSRGBColorSpace,
    );
  }

  /** Preetham in-scattering for one direction. Mirror of the GLSL in SkyMaterial. */
  radiance(dx: number, dy: number, dz: number, out: [number, number, number]): void {
    const t = this.tuning;
    const inv = opticalInverse(dy);
    const sR = RAYLEIGH_ZENITH * inv, sM = MIE_ZENITH * inv;
    const cosTheta = dx * this.sun.dir.x + dy * this.sun.dir.y + dz * this.sun.dir.z;
    const rp = THREE_OVER_16PI * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2));
    const mp = hgPhase(cosTheta, t.mieDirectionalG);
    const upDotSun = clamp(this.sun.dir.y, -1, 1);
    const sunsetMix = clamp(Math.pow(1 - upDotSun, 5), 0, 1);

    for (let i = 0; i < 3; i++) {
      const bR = this.betaR[i], bM = this.betaM[i];
      const fex = Math.exp(-(bR * sR + bM * sM));
      const num = bR * rp + bM * mp;
      const den = bR + bM;
      const base = this.sunE * (num / den);
      let lin = Math.pow(Math.max(0, base * (1 - fex)), 1.5);
      const alt = Math.pow(Math.max(0, base * fex), 0.5);
      lin *= mix(1, alt, sunsetMix);
      out[i] = (lin + 0.06 * fex) * t.exposure;
    }

    if (this.night > 0) {
      const n = this.night;
      const h = clamp(dy, 0, 1);
      const zen = [0.0042, 0.0068, 0.0155];
      const hor = [0.0135, 0.0190, 0.0330];
      // Residual twilight in the sun's azimuth, plus warm city glow.
      const l = Math.hypot(this.sun.dir.x, this.sun.dir.z) || 1;
      const hl = Math.hypot(dx, dz) || 1;
      const az = ((this.sun.dir.x / l) * (dx / hl) + (this.sun.dir.z / l) * (dz / hl));
      const tw = Math.pow(Math.max(0, az), 3) * Math.exp(-h * 7)
        * smoothstep(-16, -3, this.sun.elevation);
      const glow = [0.10, 0.045, 0.020];
      const city = Math.exp(-h * 13) * 0.9;
      for (let i = 0; i < 3; i++) {
        const nightC = mix(hor[i], zen[i], Math.pow(h, 0.55))
          + glow[i] * tw
          + [0.028, 0.017, 0.008][i] * city;
        out[i] = mix(out[i], nightC, n);
      }
    }
  }
}
