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

/** Scene-scale correction on the sky model's fog density — see `pushState`. */
const AERIAL_SCALE = 0.32;

/**
 * How hard the sky pushes back against the camera's auto-exposure, as an
 * exponent on `renderer.toneMappingExposure`. 0 = none (sky is pure radiance,
 * exposure does what it likes to it), 1 = the sky renders at a fixed screen
 * brightness no matter what the exposure solver decides.
 *
 * It is not zero because the exposure solver is metering the *pitch*, and the
 * pitch is what it should be metering. Between 16:00 and 19:00 the sun drops
 * four stops and the solver correctly opens up by 2.8× to keep the turf at
 * middle grey — which lands a golden-hour sky at three times the radiance AgX
 * can still hold a hue at, and every time of day converges on the same white
 * band. Compensating most of the way is what lets 16:00, 18:00 and 19:30 read as
 * three different times of day instead of three exposures of one.
 *
 * The residual 0.15 is deliberate: a low sun still gives a *slightly* hotter
 * sky, which is the correct cue, just not a four-stop one.
 */
const EXPOSURE_TRACK = 0.85;

interface TierCfg { cloudSteps: number; lightSteps: number; volume: number; env: number }

/**
 * Cloud march budget. The step count is what decides whether a cloud edge reads
 * as an edge or as dither noise: the march is jittered by a full step to trade
 * banding for grain, and near the horizon a step is a kilometre and a half, so
 * too few steps put visible speckle along every silhouette. These are sized off
 * measured frame time, not guessed — the whole sky costs ~0.6 ms at `low`.
 */
const TIERS: Record<QualityTier, TierCfg> = {
  low: { cloudSteps: 24, lightSteps: 4, volume: 40, env: 64 },
  medium: { cloudSteps: 30, lightSteps: 4, volume: 48, env: 96 },
  high: { cloudSteps: 36, lightSteps: 5, volume: 64, env: 128 },
  ultra: { cloudSteps: 48, lightSteps: 6, volume: 64, env: 128 },
};

const _c0 = new THREE.Color();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _c3 = new THREE.Color();

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
  /** Current inverse-exposure compensation. See EXPOSURE_TRACK. */
  private expComp = 1;

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
    // Drawn LAST among opaque geometry, not first. The vertex shader parks the
    // dome on the far plane and the material keeps depth *testing* on with
    // writes off, so the raymarched cloud layer only shades pixels the stadium
    // did not already cover. In a bowl that is most of the frame: `broadcast`
    // sees about two per cent sky, and shading the cloud march behind the stands
    // was costing more than every other pass in the chain put together.
    this.dome.renderOrder = 1000;
    this.dome.castShadow = false;
    this.dome.receiveShadow = false;
    // GTAO rebuilds its G-buffer with a MeshNormalMaterial override; a dome at
    // infinity contributes nothing to occlusion and would just be overdraw.
    this.dome.userData.noAO = true;
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

    // Track the auto-exposure. See EXPOSURE_TRACK.
    const cam = clamp(ctx.renderer.toneMappingExposure || 1, 0.2, 12);
    const comp = Math.pow(cam, -EXPOSURE_TRACK);
    if (Math.abs(comp - this.expComp) > this.expComp * 0.004) {
      this.expComp = comp;
      this.pushState();
    }

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
    this.pushState();

    ctx.events.emit('sun:changed', {
      dir: st.sun.dir.clone(),
      color: st.sunColor.clone(),
      intensity: st.sunIntensity,
      hour,
      elevation: st.sun.elevation,
      night: st.night,
      dusk: st.dusk,
    });

    this.pendingEnv = true;
    if (this.envAt < 0) this.bakeEnv(ctx);   // first frame needs it synchronously
  }

  /**
   * Push the current sky state into the dome's uniforms and into the shared
   * aerial-perspective block. Split out of `setHour` because it also has to run
   * whenever the camera's exposure moves — see EXPOSURE_TRACK.
   */
  private pushState(): void {
    const st = this.state;
    const k = this.expComp;

    const u = this.mat.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(st.sun.dir);
    (u.uMoonDir.value as THREE.Vector3).copy(st.moonDir);
    (u.uBetaR.value as THREE.Vector3).set(st.betaR[0], st.betaR[1], st.betaR[2]);
    (u.uBetaM.value as THREE.Vector3).set(st.betaM[0], st.betaM[1], st.betaM[2]);
    (u.uSunT.value as THREE.Vector3).set(st.sunT[0], st.sunT[1], st.sunT[2]);
    (u.uMsT.value as THREE.Vector3).set(st.msT[0], st.msT[1], st.msT[2]);
    (u.uMsTH.value as THREE.Vector3).set(st.msTH[0], st.msTH[1], st.msTH[2]);
    (u.uHaze.value as THREE.Vector3).set(st.hazeTint[0], st.hazeTint[1], st.hazeTint[2]);
    (u.uSunDisc.value as THREE.Vector3).set(st.sunDisc.r * k, st.sunDisc.g * k, st.sunDisc.b * k);
    u.uMs.value = st.tuning.msStrength;
    u.uSunE.value = st.sunE;
    u.uMieG.value = st.tuning.mieDirectionalG;
    u.uExposure.value = st.tuning.exposure * k;
    u.uNight.value = st.night;
    u.uSunElev.value = st.sun.elevation;
    u.uCoverage.value = st.tuning.cloudCoverage;
    u.uCloudDensity.value = st.tuning.cloudDensity;
    (u.uSunRadiance.value as THREE.Color).copy(st.sunRadiance).multiplyScalar(k);
    (u.uGround.value as THREE.Color).copy(st.ground).multiplyScalar(k);
    (u.uHorizon.value as THREE.Color).copy(st.horizon).multiplyScalar(k);

    // Cloud ambient: tops see the zenith, bases see the horizon plus turf bounce.
    (u.uAmbTop.value as THREE.Color).setRGB(
      (st.zenith.r * 1.55 + st.horizon.r * 0.25) * k,
      (st.zenith.g * 1.55 + st.horizon.g * 0.25) * k,
      (st.zenith.b * 1.55 + st.horizon.b * 0.25) * k,
      THREE.LinearSRGBColorSpace,
    );
    (u.uAmbBot.value as THREE.Color).setRGB(
      (st.horizon.r * 0.32 + st.ground.r * 0.55) * k,
      (st.horizon.g * 0.32 + st.ground.g * 0.55) * k,
      (st.horizon.b * 0.32 + st.ground.b * 0.55) * k,
      THREE.LinearSRGBColorSpace,
    );

    // Aerial perspective. Haze thickens and warms as the sun drops; at night it
    // thins right out so the stadium rigs read as distinct pools of light.
    //
    // The tuning table's `fogDensity` is a *sky-dome* number — the density that
    // makes the horizon band read correctly over tens of kilometres. Applied to
    // scene geometry it is far too thick: the far stands are 150 m away, not
    // 15 km. AERIAL_SCALE brings it back to a stadium-sized atmosphere.
    //
    // It is deliberately looser than it had to be before. The scattering model
    // now lands the horizon around 0.8 scene-linear instead of 3.4, so the fog
    // colour is only ~4–5× the sunlit pitch rather than ~20×; the same optical
    // depth that used to bleach the frame now reads as depth. The near field
    // stays clean and saturated, and the far side of the bowl still desaturates
    // toward whatever the sky is doing in that direction.
    // The fog has to converge on the pixel the *drawn* dome would have produced,
    // so it carries the same exposure compensation the dome does — otherwise the
    // far stands meet the sky on a visible step.
    const el = st.sun.elevation;
    const density = st.tuning.fogDensity * AERIAL_SCALE * mix(1, 0.55, st.night);
    updateAerial({
      sky: _c0.copy(st.zenith).multiplyScalar(k),
      horizon: _c1.copy(st.horizon).multiplyScalar(k),
      ground: _c2.copy(st.ground).multiplyScalar(k),
      sunGlow: _c3.copy(st.sunGlow).multiplyScalar(k),
      sunDir: st.sun.dir,
      density,
      heightFalloff: mix(0.020, 0.0125, clamp((el + 10) / 60, 0, 1)),
      sunGlowExponent: mix(4.5, 9.0, clamp(el / 40, 0, 1)),
      maxOpacity: 0.88,
    });
    this.fog.color.copy(_c1);
    this.fog.density = density;
  }

  /**
   * PMREM the analytic sky. This is what makes every other material in the game
   * sit in the scene — roughness response, fresnel rim, metal — so it is worth
   * more than the dome itself and gets rebuilt on every hour change.
   *
   * Four things go in, in order of how much they matter to a material:
   *  1. the scattering field, sampled per texel from the same `SkyState` the
   *     dome runs, so a mirror reflects the sky the camera can see;
   *  2. a solar lobe carrying the disc's *integrated* energy spread over ~2.4°
   *     — the disc itself is sub-texel at this resolution and would alias into
   *     a flickering dot, but without it every glossy surface loses its
   *     specular sun and reads dull;
   *  3. average cloud cover, which is all a PMREM-blurred map can carry of a
   *     cloud field, complete with the forward-scattering brightening;
   *  4. the ground bounce below the horizon.
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
    // Solid angle of the drawn disc over the solid angle of the lobe below.
    const SUN_LOBE_COS = Math.cos(2.4 * Math.PI / 180);
    const lobe: [number, number, number] = [
      st.sunDisc.r * 0.030, st.sunDisc.g * 0.030, st.sunDisc.b * 0.030,
    ];

    const prev = this.env;
    this.env = envFromFn(ctx.renderer, this.cfg.env, (x, y, z, out) => {
      st.radiance(x, y, z, out);

      const sd = x * sun.x + y * sun.y + z * sun.z;
      if (sd > SUN_LOBE_COS) {
        const k = (sd - SUN_LOBE_COS) / (1 - SUN_LOBE_COS);
        const w = k * k * (3 - 2 * k);
        for (let i = 0; i < 3; i++) out[i] += lobe[i] * w;
      }

      const c = cloudCoverAt(x, y, z, cov, time);
      if (c > 0.001) {
        const fwd = clamp(sd, 0, 1);
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
