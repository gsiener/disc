import * as THREE from 'three';
import type { Ctx } from '../../core/Ctx';
import { envFromFn } from '../../util/Tex';
import { clamp } from '../../util/Noise';
import {
  FLOOD_COLOR, TURF_BOUNCE, horizonColor, zenithColor, type SunState,
} from './Solar';

/**
 * Indirect light.
 *
 * A hemisphere light alone gives you a vertical gradient and nothing else —
 * every surface facing sideways gets the same fill regardless of whether it is
 * looking into the sun's half of the sky or away from it, which is exactly the
 * cue that makes a render read as "engine default". So the primary indirect
 * term here is a real order-2 spherical-harmonic probe, projected each time the
 * sun moves from an analytic environment: sky gradient, circumsolar lobe, and a
 * turf-coloured bounce lobe below the horizon that puts grass green under
 * chins, jaws and forearms.
 *
 * The same analytic environment doubles as the fallback IBL when no peer
 * publishes `env:ready`, so specular and diffuse indirect always agree.
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

export interface AmbientTuning {
  /** Overall multiplier on the SH probe. */
  probe: number;
  /** Multiplier on the belt-and-braces hemisphere wrap. */
  hemi: number;
  /** scene.environmentIntensity. */
  env: number;
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
  private towerFill = 0;
  private nightF = 0;

  /** Our own PMREM, used only while nobody else has published one. */
  private ownEnv: THREE.Texture | null = null;
  private ownEnvHour = -999;
  private foreignEnv = false;

  readonly tuning: AmbientTuning = { probe: 1, hemi: 1, env: 1 };

  constructor(scene: THREE.Scene) {
    this.probe = new THREE.LightProbe(new THREE.SphericalHarmonics3(), 1);
    this.probe.name = 'lighting.probe';
    this.hemi = new THREE.HemisphereLight(0x9fc4f0, 0x46612f, 0.6);
    this.hemi.name = 'lighting.hemi';
    this.hemi.position.set(0, 40, 0);
    scene.add(this.probe, this.hemi);
  }

  /**
   * Radiance of the analytic environment in direction (x,y,z). Shared by the SH
   * projection and the fallback PMREM bake so both describe the same world.
   */
  private radiance(x: number, y: number, z: number, out: [number, number, number]): void {
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

      // Sky glow spilling off the lit pitch at night, strongest near the horizon.
      if (this.towerFill > 0) {
        const k = this.towerFill * 0.055 * Math.pow(1 - y, 3);
        r += FLOOD_COLOR.r * k; g += FLOOD_COLOR.g * k; b += FLOOD_COLOR.b * k;
      }
      out[0] = r; out[1] = g; out[2] = b;
      return;
    }

    // Ground: turf albedo re-emitting whatever landed on it, with a crude
    // horizon-to-nadir occlusion falloff so it does not read as a light box.
    const occl = 0.42 + 0.58 * (1 + y);
    out[0] = this.groundLit.r * occl;
    out[1] = this.groundLit.g * occl;
    out[2] = this.groundLit.b * occl;
  }

  /** Recompute the analytic environment + project it into SH. */
  update(sun: SunState, towerIrradiance: number): void {
    const deg = (sun.elevation * 180) / Math.PI;
    zenithColor(deg, this.zenith);
    horizonColor(deg, this.horizon);
    this.sunDir.copy(sun.dir);
    this.sunCol.copy(sun.color);
    this.sunI = sun.intensity;
    this.towerFill = clamp(towerIrradiance / 2.0, 0, 1.4);
    this.nightF = sun.night;

    // What the turf is actually throwing back up.
    const skyIrr = 0.55 * this.zenith.r + 0.45 * this.horizon.r;
    const skyIrrG = 0.55 * this.zenith.g + 0.45 * this.horizon.g;
    const skyIrrB = 0.55 * this.zenith.b + 0.45 * this.horizon.b;
    const sunOnGround = this.sunI * Math.max(0, sun.dir.y);
    this.groundLit.setRGB(
      TURF_BOUNCE.r * (sunOnGround * 0.26 + skyIrr * 1.35 + FLOOD_COLOR.r * towerIrradiance * 0.20),
      TURF_BOUNCE.g * (sunOnGround * 0.26 + skyIrrG * 1.35 + FLOOD_COLOR.g * towerIrradiance * 0.20),
      TURF_BOUNCE.b * (sunOnGround * 0.26 + skyIrrB * 1.35 + FLOOD_COLOR.b * towerIrradiance * 0.20),
    );

    this.project();

    // Hemisphere stays as a small guaranteed wrap under the probe: it costs one
    // uniform and it keeps back-facing geometry off pure black if the probe is
    // ever swamped by a peer's environment map.
    this.hemi.color.copy(this.horizon).lerp(this.zenith, 0.35);
    this.hemi.groundColor.copy(this.groundLit).multiplyScalar(1.6);
    this.hemi.intensity = (0.34 + 0.30 * sun.night) * this.tuning.hemi;
  }

  private project(): void {
    const c = this.probe.sh.coefficients;
    for (let j = 0; j < 9; j++) c[j].set(0, 0, 0);

    const w = (4 * Math.PI) / N_SAMPLES;
    for (let i = 0; i < N_SAMPLES; i++) {
      const x = DIRS[i * 3], y = DIRS[i * 3 + 1], z = DIRS[i * 3 + 2];
      this.radiance(x, y, z, _rgb);
      _n.set(x, y, z);
      THREE.SphericalHarmonics3.getBasisAt(_n, _basis);
      for (let j = 0; j < 9; j++) {
        const s = _basis[j] * w;
        c[j].x += _rgb[0] * s;
        c[j].y += _rgb[1] * s;
        c[j].z += _rgb[2] * s;
      }
    }
    this.probe.intensity = this.tuning.probe;
  }

  /* ------------------------------------------------------------- IBL */

  /** A peer published a real environment map — hand ownership over to it. */
  adoptEnvironment(scene: THREE.Scene, tex: THREE.Texture, intensity: number): void {
    this.foreignEnv = true;
    scene.environment = tex;
    scene.environmentIntensity = intensity;
    this.disposeOwnEnv();
  }

  get hasForeignEnv(): boolean { return this.foreignEnv; }

  /**
   * Bakes a PMREM from the analytic environment when nobody else has. Re-bakes
   * only when the sun has moved appreciably — the cost is a 128×64 float
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
    const next = envFromFn(ctx.renderer, size, (x, y, z, out) => this.radiance(x, y, z, out));
    this.disposeOwnEnv();
    this.ownEnv = next;
    this.ownEnvHour = hour;
    ctx.scene.environment = next;
  }

  setEnvIntensity(scene: THREE.Scene, v: number): void {
    scene.environmentIntensity = v * this.tuning.env;
  }

  private disposeOwnEnv(): void {
    if (this.ownEnv) { this.ownEnv.dispose(); this.ownEnv = null; }
  }

  dispose(): void {
    this.disposeOwnEnv();
    this.probe.removeFromParent();
    this.hemi.removeFromParent();
  }
}
