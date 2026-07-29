import * as THREE from 'three';
import type { Ctx, System, QualityTier } from '../core/Ctx';
import { envFromFn } from '../util/Tex';
import { clamp, mix } from '../util/Noise';
import { SkyState } from './sky/Atmosphere';
import { createSkyMaterial } from './sky/SkyMaterial';
import { bakeCloudTextures, cloudCoverAt, type CloudTextures } from './sky/CloudNoise';
import { installAerialPerspective, updateAerial } from './sky/Aerial';

/**
 * Sky, atmosphere and image-based lighting.
 *
 * This system owns *time of day*. It converts a shot's `hour` into a solar
 * position, retunes the scattering model for that elevation, redraws the dome,
 * rebuilds the aerial-perspective fog, rebakes the PMREM environment and tells
 * everyone else where the key light is:
 *
 *   emits `sun:changed` { dir, color, intensity, hour, elevation, night }
 *          `env:ready`  { texture }
 *
 * `dir` points *towards* the light (place a DirectionalLight at dir · d).
 * `color` is normalised to a max component of 1 — all brightness lives in
 * `intensity` — so a consumer can drop both straight onto a light. After
 * sunset the key becomes the moon: cool and dim, on purpose, so the stadium
 * rigs take over.
 */

interface TierCfg { cloudSteps: number; lightSteps: number; volume: number; env: number }

const TIERS: Record<QualityTier, TierCfg> = {
  low: { cloudSteps: 14, lightSteps: 3, volume: 40, env: 64 },
  medium: { cloudSteps: 22, lightSteps: 4, volume: 48, env: 96 },
  high: { cloudSteps: 32, lightSteps: 5, volume: 64, env: 128 },
  ultra: { cloudSteps: 44, lightSteps: 6, volume: 64, env: 128 },
};

export class SkySystem implements System {
  readonly name = 'sky';
  readonly order = 0;

  private state = new SkyState();
  private dome!: THREE.Mesh;
  private mat!: THREE.ShaderMaterial;
  private tex: CloudTextures | null = null;
  private env: THREE.Texture | null = null;
  private fog!: THREE.FogExp2;
  private cfg: TierCfg = TIERS.high;
  private ctx!: Ctx;
  private pendingEnv = false;
  private envAt = -1;

  init(ctx: Ctx): void {
    this.ctx = ctx;
    this.cfg = TIERS[ctx.quality.tier] ?? TIERS.high;

    // Must happen before any other system compiles a material.
    installAerialPerspective();

    this.tex = bakeCloudTextures(this.cfg.volume);

    this.mat = createSkyMaterial({
      cloudSteps: this.cfg.cloudSteps,
      cloudLightSteps: this.cfg.lightSteps,
      clouds: true,
    });
    this.mat.uniforms.uShape.value = this.tex.shape;
    this.mat.uniforms.uDetail.value = this.tex.detail;
    this.mat.uniforms.uWeather.value = this.tex.weather;

    this.dome = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.mat);
    this.dome.name = 'sky';
    this.dome.frustumCulled = false;
    this.dome.matrixAutoUpdate = false;
    this.dome.renderOrder = -1000;
    this.dome.castShadow = false;
    this.dome.receiveShadow = false;
    const S = 40;
    this.dome.onBeforeRender = (_r, _s, camera) => {
      this.dome.matrixWorld.makeScale(S, S, S).setPosition(camera.position);
    };
    ctx.scene.add(this.dome);

    this.fog = new THREE.FogExp2(0x9fc0e8, 0.0016);
    ctx.scene.fog = this.fog;

    const hour = Number(new URLSearchParams(location.search).get('skyHour'));
    this.setHour(Number.isFinite(hour) && hour > 0 ? hour : 17.5, ctx);

    ctx.events.on('shot:apply', (p: { shot?: { hour?: number } }) => {
      const h = p?.shot?.hour;
      if (typeof h === 'number') this.setHour(h, ctx);
    });
  }

  lateUpdate(_dt: number, ctx: Ctx): void {
    this.mat.uniforms.uTime.value = ctx.time;
    // Env bakes are deferred one frame so a shot change does not stall the
    // frame that requested it; capture always settles for far longer.
    if (this.pendingEnv) { this.pendingEnv = false; this.bakeEnv(ctx); }
  }

  dispose(): void {
    this.tex?.dispose();
    this.env?.dispose();
    this.mat.dispose();
    this.dome.geometry.dispose();
  }

  /* ------------------------------------------------------------- internals */

  private setHour(hour: number, ctx: Ctx): void {
    if (Math.abs(hour - this.state.hour) < 1e-4 && this.envAt >= 0) return;
    const st = this.state;
    st.setHour(hour);

    const u = this.mat.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(st.sun.dir);
    (u.uMoonDir.value as THREE.Vector3).copy(st.moonDir);
    (u.uBetaR.value as THREE.Vector3).set(st.betaR[0], st.betaR[1], st.betaR[2]);
    (u.uBetaM.value as THREE.Vector3).set(st.betaM[0], st.betaM[1], st.betaM[2]);
    u.uSunE.value = st.sunE;
    u.uMieG.value = st.tuning.mieDirectionalG;
    u.uExposure.value = st.tuning.exposure;
    u.uNight.value = st.night;
    u.uSunElev.value = st.sun.elevation;
    u.uCoverage.value = st.tuning.cloudCoverage;
    u.uCloudDensity.value = st.tuning.cloudDensity;
    (u.uSunRadiance.value as THREE.Color).copy(st.sunRadiance);
    (u.uGround.value as THREE.Color).copy(st.ground);
    (u.uHorizon.value as THREE.Color).copy(st.horizon);

    // Cloud ambient: tops see the zenith, bases see the horizon plus turf bounce.
    (u.uAmbTop.value as THREE.Color).setRGB(
      st.zenith.r * 1.55 + st.horizon.r * 0.25,
      st.zenith.g * 1.55 + st.horizon.g * 0.25,
      st.zenith.b * 1.55 + st.horizon.b * 0.25,
      THREE.LinearSRGBColorSpace,
    );
    (u.uAmbBot.value as THREE.Color).setRGB(
      st.horizon.r * 0.32 + st.ground.r * 0.55,
      st.horizon.g * 0.32 + st.ground.g * 0.55,
      st.horizon.b * 0.32 + st.ground.b * 0.55,
      THREE.LinearSRGBColorSpace,
    );

    // Aerial perspective. Haze thickens and warms as the sun drops; at night it
    // thins right out so the stadium rigs read as distinct pools of light.
    const el = st.sun.elevation;
    updateAerial({
      sky: st.zenith,
      horizon: st.horizon,
      sunGlow: st.sunGlow,
      sunDir: st.sun.dir,
      density: st.tuning.fogDensity * mix(1, 0.55, st.night),
      heightFalloff: mix(0.020, 0.0125, clamp((el + 10) / 60, 0, 1)),
      sunGlowExponent: mix(4.5, 9.0, clamp(el / 40, 0, 1)),
      maxOpacity: 0.94,
    });
    this.fog.color.copy(st.horizon);
    this.fog.density = st.tuning.fogDensity;

    ctx.events.emit('sun:changed', {
      dir: st.sun.dir.clone(),
      color: st.sunColor.clone(),
      intensity: st.sunIntensity,
      hour,
      elevation: el,
      night: st.night,
    });

    this.pendingEnv = true;
    if (this.envAt < 0) this.bakeEnv(ctx);   // first frame needs it synchronously
  }

  /**
   * PMREM the analytic sky. This is what makes every other material in the game
   * sit in the scene — roughness response, fresnel rim, metal — so it is worth
   * more than the dome itself and gets rebuilt on every hour change.
   */
  private bakeEnv(ctx: Ctx): void {
    const st = this.state;
    if (this.envAt === st.hour) return;
    this.envAt = st.hour;

    const cov = st.tuning.cloudCoverage;
    const time = ctx.time;
    const sun = st.sun.dir;
    const cloudLit: [number, number, number] = [0, 0, 0];
    const zen: [number, number, number] = [st.zenith.r, st.zenith.g, st.zenith.b];
    const grd: [number, number, number] = [st.ground.r, st.ground.g, st.ground.b];
    const sr: [number, number, number] = [st.sunRadiance.r, st.sunRadiance.g, st.sunRadiance.b];

    const prev = this.env;
    this.env = envFromFn(ctx.renderer, this.cfg.env, (x, y, z, out) => {
      st.radiance(x, y, z, out);

      const c = cloudCoverAt(x, y, z, cov, time);
      if (c > 0.001) {
        const fwd = clamp(x * sun.x + y * sun.y + z * sun.z, 0, 1);
        const silver = 0.5 + 1.6 * Math.pow(fwd, 5);
        for (let i = 0; i < 3; i++) {
          cloudLit[i] = sr[i] * silver + zen[i] * 0.85;
          out[i] = mix(out[i], cloudLit[i], c * 0.8);
        }
      }

      if (y < 0.02) {
        const t = clamp((0.02 - y) / 0.06, 0, 1);
        for (let i = 0; i < 3; i++) out[i] = mix(out[i], grd[i], t);
      }
    });

    ctx.scene.environment = this.env;
    ctx.scene.environmentIntensity = 1;
    prev?.dispose();
    ctx.events.emit('env:ready', { texture: this.env });
  }
}
