import * as THREE from 'three';
import type { Ctx } from '../../core/Ctx';
import { envFromFn } from '../../util/Tex';
import { clamp, mix, smoothstep } from '../../util/Noise';
import {
  FLOOD_COLOR, TURF_BOUNCE, horizonColor, zenithColor, type SunState,
} from './Solar';
import { EnvMeter } from './EnvMeter';

/**
 * Indirect light — and, more importantly, *how much of it there is*.
 *
 * ## The energy budget
 *
 * Three independent things add irradiance to every lit surface in this scene:
 * the image-based light (`scene.environment`, owned by the sky), an order-2 SH
 * probe, and a hemisphere wrap. Each of them, left to itself, describes the
 * whole sky. Summed, they were putting more light into shadow than the sun was
 * putting on the lit side, and a shadow that removes 40 % of the light is a
 * shadow you cannot see. That is the single reason the frame read as flat and
 * milky: not the grade, not the fog — the shadow terminator had almost no
 * contrast to carry.
 *
 * So the three terms are now solved against one budget instead of stacked. The
 * budget is physical: diffuse sky irradiance on a horizontal surface is about
 * 22 % of the sun's own horizontal irradiance under a high clear sun, rising to
 * unity as the sun reaches the horizon, and after sunset it is whatever the
 * twilight sky plus the floodlight bounce comes to. `EnvMeter` measures what
 * the IBL actually delivers so the split can be solved in real units for any
 * environment map anyone hands us, on any radiance scale.
 *
 * ## The shape
 *
 * A hemisphere light alone gives a vertical gradient and nothing else, which is
 * the cue that reads as "engine default". The SH probe carries the shape the
 * IBL cannot: a turf-coloured bounce lobe below the horizon that puts warm grass
 * green under chins, jaws and forearms, and a circumsolar lobe above it. When a
 * real environment map is present the probe's sky half is deliberately
 * *under*-weighted — the IBL already has the sky, and duplicating it is what
 * caused the problem above — so most of the probe's budget lands in the bounce,
 * which is exactly where an outdoor sports look lives.
 */

const N_SAMPLES = 768;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Fibonacci sphere — even coverage with no pole clumping, and deterministic. */
const DIRS = (() => {
  const out = new Float32Array(N_SAMPLES * 3);
  for (let i = 0; i < N_SAMPLES; i++) {
    const y = 1 - (2 * i + 1) / N_SAMPLES;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = GOLDEN * i;
    out[i * 3] = Math.cos(th) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(th) * r;
  }
  return out;
})();

const _basis: number[] = new Array(9).fill(0);
const _n = new THREE.Vector3();
const _rgb: [number, number, number] = [0, 0, 0];

/** Rec.709 luminance. */
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Diffuse reflectance of the turf, as a luminance. Drives the bounce budget. */
const TURF_LUMA = luma(TURF_BOUNCE.r, TURF_BOUNCE.g, TURF_BOUNCE.b);

/**
 * Irradiance an order-2 SH probe delivers to a surface with the given normal,
 * as a luminance. Mirrors three's `shGetIrradianceAt` exactly — if these two
 * ever disagree the whole budget is solved against a number the shader does not
 * use, so it is written out longhand rather than approximated by the DC term.
 */
function shIrradianceLuma(c: THREE.Vector3[], nx: number, ny: number, nz: number): number {
  let r = 0, g = 0, b = 0;
  const add = (v: THREE.Vector3, k: number) => { r += v.x * k; g += v.y * k; b += v.z * k; };
  add(c[0], 0.886227);
  add(c[1], 2.0 * 0.511664 * ny);
  add(c[2], 2.0 * 0.511664 * nz);
  add(c[3], 2.0 * 0.511664 * nx);
  add(c[4], 2.0 * 0.429043 * nx * ny);
  add(c[5], 2.0 * 0.429043 * ny * nz);
  add(c[6], 0.743125 * nz * nz - 0.247708);
  add(c[7], 2.0 * 0.429043 * nx * nz);
  add(c[8], 0.429043 * (nx * nx - ny * ny));
  return luma(r, g, b);
}

/* --------------------------------------------------------------- budget */

/**
 * How much diffuse sky there should be, as a multiple of the sun's own
 * irradiance on a horizontal surface. 0.22 under a high clear sun (a real clear
 * sky runs 0.13–0.20; a touch more keeps shadow detail legible on a screen the
 * critic may be viewing in a bright room), climbing to parity as the sun sits on
 * the horizon and every photon has come through a hundred kilometres of air.
 */
function skyToSunRatio(elevDeg: number): number {
  return mix(0.22, 1.0, smoothstep(30, 0, elevDeg));
}

/** Absolute floor: the twilight sky is still a light source after the sun is not. */
function twilightIrradiance(elevDeg: number): number {
  return mix(0.010, 0.185, smoothstep(-13, 2, elevDeg));
}

/**
 * The floodlight rig used to be folded into the indirect budget in three
 * separate places — a flat 0.12 × irradiance in the budget itself, a flood term
 * inside the ground-bounce colour, and a sky-glow term in the probe's upper
 * hemisphere — which between them put the indirect within touching distance of
 * the direct. A shadow that removes a third of the light is not a shadow, and
 * that is why the night frame had none.
 *
 * There is now exactly one path per receiver orientation, and both are derived
 * rather than dialled:
 *
 *  - **Up-facing** surfaces see the sky. At night that is the twilight floor
 *    plus the genuine glow a lit bowl throws back off its own roof, haze and
 *    stand fronts — a few per cent of the rig, not twelve.
 *  - **Side- and down-facing** surfaces see the pitch. That is the physically
 *    real one: irradiance on the grass × turf albedo × the half-space form
 *    factor. It is budgeted separately because the previous single-scalar
 *    normalisation (probe intensity solved from the *up* irradiance alone) could
 *    not express "black sky, bright ground" — push the bounce up and the sky
 *    normalisation pushed it straight back down again.
 *
 * Measured at pitch centre this lands the night key:fill near 6:1 on a vertical
 * surface, which is a hard lighting environment, which is what a stadium is.
 */
const RIG_SKYGLOW = 0.035;
/**
 * Irradiance a vertical surface just above an infinite Lambertian plane receives
 * as a fraction of that plane's radiosity. Exactly 0.5 for the ideal half-space;
 * a shade under, here, because a pitch is not infinite and an object standing on
 * it occludes part of its own bounce.
 */
const BOUNCE_FF = 0.42;

/** Sky-budget split: IBL / SH probe / hemisphere wrap. Sums to 1. */
const SHARE_ENV = 0.52;
const SHARE_PROBE = 0.40;
const SHARE_HEMI = 0.08;

/**
 * Share of the bounce budget the probe carries. A peer's PMREM already has a
 * ground hemisphere baked into it, so when one is bound the probe only makes up
 * the difference; on our own fallback it carries the lot.
 */
const BOUNCE_PROBE_FOREIGN = 0.55;
const BOUNCE_PROBE_OWN = 0.92;

/** Sky weight in the probe's own analytic environment when a real IBL exists. */
const PROBE_SKY_WEIGHT = 0.42;

export interface AmbientTuning {
  /** Overall multiplier on the solved indirect budget. */
  gain: number;
  /** Extra multiplier on the turf bounce lobe alone. */
  bounce: number;
}

export class AmbientRig {
  readonly probe: THREE.LightProbe;
  readonly hemi: THREE.HemisphereLight;

  /** Analytic environment state, refreshed whenever the sun moves. */
  private zenith = new THREE.Color();
  private horizon = new THREE.Color();
  private groundLit = new THREE.Color();
  private sunDir = new THREE.Vector3(0, 1, 0);
  private sunCol = new THREE.Color(1, 1, 1);
  private sunI = 0;
  private skyWeight = 1;

  /** Sky-hemisphere and ground-hemisphere SH, projected but not yet scaled. */
  private readonly shSky = Array.from({ length: 9 }, () => new THREE.Vector3());
  private readonly shGnd = Array.from({ length: 9 }, () => new THREE.Vector3());

  /** Our own PMREM, used only while nobody else has published one. */
  private ownEnv: THREE.Texture | null = null;
  private ownEnvHour = -999;
  private foreignEnv = false;
  private readonly meter = new EnvMeter();

  /**
   * Total diffuse irradiance (luminance) the solved rig puts on an up-facing
   * surface. This is what `Exposure` must be metered from — before, it was
   * metered from the probe alone while the IBL quietly added twice as much
   * again, so every frame was mis-exposed by roughly a third of a stop.
   */
  irradianceUp = 0;
  /** Same, on a vertical surface. Faces and jerseys live here. */
  irradianceSide = 0;

  /**
   * Every term the solve produced, so the key:fill ratio can be *read* rather
   * than guessed at. `LightingSystem.lightReport()` turns this into the ratio.
   */
  readonly report = {
    skyBudget: 0, bounceBudget: 0, envUp: 0, probeUp: 0, probeSide: 0,
    hemiUp: 0, pitchIrr: 0, towerIrr: 0, sunUpIrr: 0,
  };

  readonly tuning: AmbientTuning = { gain: 1, bounce: 1 };

  constructor(scene: THREE.Scene) {
    this.probe = new THREE.LightProbe(new THREE.SphericalHarmonics3(), 1);
    this.probe.name = 'lighting.probe';
    this.hemi = new THREE.HemisphereLight(0x9fc4f0, 0x46612f, 0.3);
    this.hemi.name = 'lighting.hemi';
    this.hemi.position.set(0, 40, 0);
    scene.add(this.probe, this.hemi);
  }

  /**
   * Radiance of the analytic environment in direction (x,y,z). Shared by the SH
   * projection and the fallback PMREM bake so both describe the same world.
   * `skyWeight` is what lets the probe lean into the bounce when a real IBL is
   * already carrying the sky; it is 1 for the fallback bake.
   */
  private radiance(x: number, y: number, z: number, out: [number, number, number], skyWeight: number): void {
    const sd = this.sunDir;
    const cosSun = x * sd.x + y * sd.y + z * sd.z;

    if (y >= 0) {
      // Sky: zenith→horizon gradient, sharpened near the horizon band.
      const t = Math.pow(1 - y, 2.4);
      let r = this.zenith.r + (this.horizon.r - this.zenith.r) * t;
      let g = this.zenith.g + (this.horizon.g - this.zenith.g) * t;
      let b = this.zenith.b + (this.horizon.b - this.zenith.b) * t;

      // Circumsolar aureole — the reason ambient is directional at all.
      if (cosSun > 0) {
        const tight = Math.pow(cosSun, 26) * 2.4;
        const broad = Math.pow(cosSun, 3.5) * 0.30;
        const k = (tight + broad) * this.sunI * 0.30;
        r += this.sunCol.r * k; g += this.sunCol.g * k; b += this.sunCol.b * k;
      }

      // NB: no floodlight term here. The rig's glow reaches an up-facing surface
      // through `RIG_SKYGLOW` in the budget below and nowhere else — injecting it
      // into the probe's own radiance as well was one of the three places it was
      // being counted, and the one that did the most damage, because it landed in
      // the hemisphere the whole probe is normalised against.
      out[0] = r * skyWeight; out[1] = g * skyWeight; out[2] = b * skyWeight;
      return;
    }

    // Ground: turf albedo re-emitting whatever landed on it, with a crude
    // horizon-to-nadir occlusion falloff so it does not read as a light box.
    // The bounce is strongest looking back toward the sun's side of the pitch,
    // which is what gives a player's jaw a warm edge on one side and a cool one
    // on the other instead of a uniform green wash.
    const facing = 0.82 + 0.34 * clamp(-(x * sd.x + z * sd.z), -1, 1);
    const occl = (0.42 + 0.58 * (1 + y)) * facing * this.tuning.bounce;
    out[0] = this.groundLit.r * occl;
    out[1] = this.groundLit.g * occl;
    out[2] = this.groundLit.b * occl;
  }

  /**
   * Recompute the analytic environment, project it into SH, then solve the
   * indirect terms against two budgets — sky for up-facing surfaces, pitch
   * bounce for side- and down-facing ones.
   *
   * @param envTex      the environment map actually bound on the scene.
   * @param sunUpIrr    the sun's irradiance on a horizontal surface (luminance).
   */
  update(
    ctx: Ctx, sun: SunState, towerIrradiance: number,
    envTex: THREE.Texture | null, sunUpIrr: number,
  ): void {
    const deg = (sun.elevation * 180) / Math.PI;
    zenithColor(deg, this.zenith);
    horizonColor(deg, this.horizon);
    this.sunDir.copy(sun.dir);
    this.sunCol.copy(sun.color);
    this.sunI = sun.intensity;

    // The *colour* the turf throws back. Magnitude is solved below against the
    // bounce budget, so this only has to be right in hue: warmed by the sun term
    // in daylight (a sunlit lawn bounces yellow-green, not the pigment green of
    // the blade) and pushed cool by the metal-halide rig at night.
    const skyIrr = 0.55 * this.zenith.r + 0.45 * this.horizon.r;
    const skyIrrG = 0.55 * this.zenith.g + 0.45 * this.horizon.g;
    const skyIrrB = 0.55 * this.zenith.b + 0.45 * this.horizon.b;
    const sunOnGround = this.sunI * Math.max(0, sun.dir.y);
    const warm = this.sunCol;
    this.groundLit.setRGB(
      TURF_BOUNCE.r * (sunOnGround * 0.30 * (0.7 + 0.6 * warm.r) + skyIrr * 1.25 + FLOOD_COLOR.r * towerIrradiance * 0.20),
      TURF_BOUNCE.g * (sunOnGround * 0.30 * (0.7 + 0.6 * warm.g) + skyIrrG * 1.25 + FLOOD_COLOR.g * towerIrradiance * 0.20),
      TURF_BOUNCE.b * (sunOnGround * 0.30 * (0.7 + 0.6 * warm.b) + skyIrrB * 1.25 + FLOOD_COLOR.b * towerIrradiance * 0.20),
    );

    /* ----------------------------------------------------------- budgets */

    const measured = this.foreignEnv ? this.meter.measure(ctx.renderer, envTex) : null;
    this.skyWeight = measured ? PROBE_SKY_WEIGHT : 1;

    // Up-facing: sky only, plus the rig's genuine glow off roof and haze.
    const skyBudget = Math.max(
      1e-4,
      (Math.max(skyToSunRatio(deg) * sunUpIrr, twilightIrradiance(deg))
        + RIG_SKYGLOW * towerIrradiance) * this.tuning.gain,
    );
    // Side/down-facing: what the pitch is throwing. Everything that lands on the
    // grass — sun, sky, floodlights — times turf albedo times the form factor.
    const pitchIrr = sunUpIrr + skyBudget + towerIrradiance;
    const bounceBudget = TURF_LUMA * pitchIrr * BOUNCE_FF
      * this.tuning.bounce * this.tuning.gain;

    // If there is no measurable IBL, the probe inherits its share rather than
    // leaving the frame a fifth of a stop dark.
    const wEnv = measured ? SHARE_ENV : 0;
    const wProbe = SHARE_PROBE + (measured ? 0 : SHARE_ENV);
    const wHemi = SHARE_HEMI;

    /* --------------------------------------------------------------- IBL */

    let envUp = 0, envSide = 0;
    if (measured && measured.upLuma > 1e-6) {
      const i = clamp((wEnv * skyBudget) / measured.upLuma, 0.02, 3.0);
      ctx.scene.environmentIntensity = i;
      envUp = measured.upLuma * i;
      envSide = luma(measured.side.r, measured.side.g, measured.side.b) * i;
    } else if (this.foreignEnv) {
      // Unreadable environment: leave it near unity and let the probe make up
      // the difference on the next line rather than fight it.
      ctx.scene.environmentIntensity = 1;
    }

    /* -------------------------------------------------------------- probe */

    // Two lobes, two scales, one probe. `LightProbe.intensity` is a single
    // scalar, so with one projection the bounce could only ever be a fixed
    // multiple of the sky — which at night means "black sky" and "bright
    // bounce" are not simultaneously expressible, and whichever one you solve
    // for, the other is wrong by the same ratio. Scaling the two coefficient
    // sets before summing them costs one extra 9-vector add and makes both
    // budgets hold exactly. Intensity therefore stays at 1.
    this.project();
    const rawSkyUp = shIrradianceLuma(this.shSky, 0, 1, 0);
    const rawGndSide = 0.5 * (shIrradianceLuma(this.shGnd, 1, 0, 0)
      + shIrradianceLuma(this.shGnd, 0, 0, 1));
    const probeBounce = bounceBudget * (measured ? BOUNCE_PROBE_FOREIGN : BOUNCE_PROBE_OWN);
    const kSky = rawSkyUp > 1e-9 ? clamp((wProbe * skyBudget) / rawSkyUp, 0, 400) : 0;
    const kGnd = rawGndSide > 1e-9 ? clamp(probeBounce / rawGndSide, 0, 400) : 0;

    const c = this.probe.sh.coefficients;
    for (let j = 0; j < 9; j++) {
      c[j].set(
        this.shSky[j].x * kSky + this.shGnd[j].x * kGnd,
        this.shSky[j].y * kSky + this.shGnd[j].y * kGnd,
        this.shSky[j].z * kSky + this.shGnd[j].z * kGnd,
      );
    }
    this.probe.intensity = 1;
    const probeUp = shIrradianceLuma(c, 0, 1, 0);
    const probeSide = 0.5 * (shIrradianceLuma(c, 1, 0, 0) + shIrradianceLuma(c, 0, 0, 1));

    /* --------------------------------------------------------------- wrap */

    // Hemisphere stays as a small guaranteed wrap under the probe: it costs one
    // uniform and it keeps back-facing geometry off pure black if the probe is
    // ever swamped by a peer's environment map. Its ground half carries the
    // remainder of the bounce budget rather than an arbitrary 1.6× of the bounce
    // colour, which was the third of the three uncounted floodlight paths.
    this.hemi.color.copy(this.horizon).lerp(this.zenith, 0.35);
    const hemiSky = luma(this.hemi.color.r, this.hemi.color.g, this.hemi.color.b);
    this.hemi.intensity = hemiSky > 1e-6 ? clamp((wHemi * skyBudget) / hemiSky, 0, 20) : 0;
    const hemiUp = hemiSky * this.hemi.intensity;

    const hemiBounce = Math.max(0, bounceBudget - probeBounce);
    const gLum = luma(this.groundLit.r, this.groundLit.g, this.groundLit.b);
    const gScale = (this.hemi.intensity > 1e-6 && gLum > 1e-9)
      ? clamp(hemiBounce / (this.hemi.intensity * gLum), 0, 80) : 0;
    this.hemi.groundColor.copy(this.groundLit).multiplyScalar(gScale);

    this.irradianceUp = envUp + probeUp + hemiUp;
    this.irradianceSide = envSide + probeSide + 0.5 * (hemiUp + hemiBounce);

    const r = this.report;
    r.skyBudget = skyBudget;
    r.bounceBudget = bounceBudget;
    r.envUp = envUp;
    r.probeUp = probeUp;
    r.probeSide = probeSide;
    r.hemiUp = hemiUp;
    r.pitchIrr = pitchIrr;
    r.towerIrr = towerIrradiance;
    r.sunUpIrr = sunUpIrr;
  }

  /**
   * Projects the analytic environment into two coefficient sets — the sky
   * hemisphere and the ground hemisphere — so each can be scaled to its own
   * budget before they are summed into the probe.
   */
  private project(): void {
    for (let j = 0; j < 9; j++) { this.shSky[j].set(0, 0, 0); this.shGnd[j].set(0, 0, 0); }

    const w = (4 * Math.PI) / N_SAMPLES;
    const sw = this.skyWeight;
    for (let i = 0; i < N_SAMPLES; i++) {
      const x = DIRS[i * 3], y = DIRS[i * 3 + 1], z = DIRS[i * 3 + 2];
      this.radiance(x, y, z, _rgb, sw);
      _n.set(x, y, z);
      THREE.SphericalHarmonics3.getBasisAt(_n, _basis);
      const dst = y >= 0 ? this.shSky : this.shGnd;
      for (let j = 0; j < 9; j++) {
        const s = _basis[j] * w;
        dst[j].x += _rgb[0] * s;
        dst[j].y += _rgb[1] * s;
        dst[j].z += _rgb[2] * s;
      }
    }
  }

  /* ------------------------------------------------------------- IBL */

  /** A peer published a real environment map — hand ownership over to it. */
  adoptEnvironment(scene: THREE.Scene, tex: THREE.Texture, _intensity: number): void {
    this.foreignEnv = true;
    scene.environment = tex;
    this.disposeOwnEnv();
  }

  get hasForeignEnv(): boolean { return this.foreignEnv; }

  /**
   * Bakes a PMREM from the analytic environment when nobody else has. Re-bakes
   * only when the sun has moved appreciably — the cost is a small float
   * equirect plus PMREM, which is cheap but not free.
   */
  ensureFallbackEnv(ctx: Ctx, hour: number): void {
    if (this.foreignEnv) return;
    if (ctx.scene.environment && ctx.scene.environment !== this.ownEnv) {
      // Something else set it directly without an event — respect that.
      this.foreignEnv = true;
      this.disposeOwnEnv();
      return;
    }
    if (this.ownEnv && Math.abs(hour - this.ownEnvHour) < 0.2) return;

    const size = ctx.quality.tier === 'low' ? 32 : 64;
    const next = envFromFn(ctx.renderer, size, (x, y, z, out) => this.radiance(x, y, z, out, 1));
    this.disposeOwnEnv();
    this.ownEnv = next;
    this.ownEnvHour = hour;
    ctx.scene.environment = next;
  }

  private disposeOwnEnv(): void {
    if (this.ownEnv) { this.ownEnv.dispose(); this.ownEnv = null; }
  }

  dispose(): void {
    this.disposeOwnEnv();
    this.meter.dispose();
    this.probe.removeFromParent();
    this.hemi.removeFromParent();
  }
}
