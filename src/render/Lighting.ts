import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import type { Ctx, System } from '../core/Ctx';
import { clamp } from '../util/Noise';
import {
  applyDerived, evaluate, makeSunState, reconcileDirection, type SunState,
} from './lighting/Solar';
import { AmbientRig } from './lighting/Ambient';
import { TowerRig } from './lighting/Towers';
import { Exposure } from './lighting/Exposure';

/**
 * The lighting rig.
 *
 * Four things live here, and they are deliberately in one system because they
 * have to agree with each other frame by frame:
 *
 *  1. **Sun** — cascaded shadow maps (three/addons/csm). Direction and colour
 *     come from the sky over `sun:changed`; if no sky is present we run our own
 *     solar model so the frame is never unlit.
 *  2. **Indirect** — an order-2 SH probe re-projected whenever the sun moves,
 *     plus a hemisphere wrap and an IBL that follows `env:ready`.
 *  3. **Night** — four floodlight towers with real spot lights, overlapping
 *     shadows, emissive lenses and scatter cones.
 *  4. **Exposure** — solved from the estimated irradiance so midday and a
 *     floodlit 21:30 are both correctly exposed.
 *
 * Two invariants worth knowing before editing:
 *
 *  - *Every lit material in the scene must be registered with CSM.* A material
 *    that misses the `USE_CSM` define takes the stock directional-light path and
 *    sums all N cascades as N separate suns. That is why `syncMaterials` walks
 *    the graph before every render rather than once at init: peers build their
 *    meshes on their own schedule, and some of them stream in later.
 *  - *Light counts never change after init.* Adding or removing a light rewrites
 *    every program in the scene. Day/night is expressed purely as intensity,
 *    shadow intensity and shadow auto-update.
 */

/** Cascades stop mattering past here; the far stands sit around 120 m. */
const CSM_MAX_FAR = 160;
/** 0 = uniform splits, 1 = logarithmic. Tuned so a 3 m subject and a 120 m
 *  stand both land on usable texel densities with only four cascades. */
const SPLIT_LAMBDA = 0.65;
/** Clamp for the log term — camera.near is 0.15 m, which would push cascade 0
 *  absurdly tight and starve everything behind it. */
const SPLIT_NEAR = 0.5;

type LitMaterial = THREE.Material & { userData: Record<string, unknown> };

export class LightingSystem implements System {
  readonly name = 'lighting';
  readonly order = 1;

  /** Live sun state. Peers may read this (`ctx.sys.lighting`). */
  readonly sun: SunState = makeSunState();
  /** 0 = day, 1 = night. Peers use it for headlights, crowd flash, etc. */
  get nightFactor(): number { return this.sun.night; }

  csm: CSM | null = null;
  readonly towers = new TowerRig();
  private ambient!: AmbientRig;
  private readonly exposure = new Exposure();

  private ctx!: Ctx;
  private hour = 16.5;
  private skyDriven = false;
  private pendingSun: { dir?: THREE.Vector3; color?: THREE.Color; intensity?: number } | null = null;
  private snapExposure = true;
  private projectedDir = new THREE.Vector3(0, -1, 0);
  private projectedI = -1;
  private frames = 0;

  private csmSizes: number[] = [];
  private sceneHookInstalled: ((...a: any[]) => void) | null = null;
  private prevSceneHook: ((...a: any[]) => void) | null = null;
  private unsub: Array<() => void> = [];

  /* ---------------------------------------------------------------- init */

  init(ctx: Ctx): void {
    this.ctx = ctx;

    this.ambient = new AmbientRig(ctx.scene);
    this.buildCsm(ctx);
    this.towers.build(ctx);

    // Adopt anything a peer published before we were constructed.
    if (ctx.scene.environment) this.ambient.adoptEnvironment(ctx.scene, ctx.scene.environment, 1);

    this.unsub.push(ctx.events.on('shot:apply', (p: any) => {
      if (typeof p?.shot?.hour === 'number') this.hour = p.shot.hour;
      this.snapExposure = true;
    }));
    this.unsub.push(ctx.events.on('shot:applied', () => {
      this.csm?.updateFrustums();
      this.tuneCascades();
      this.snapExposure = true;
    }));
    this.unsub.push(ctx.events.on('sun:changed', (p: any) => this.onSunChanged(p)));
    this.unsub.push(ctx.events.on('env:ready', (p: any) => {
      const tex = p?.texture as THREE.Texture | undefined;
      if (tex) this.ambient.adoptEnvironment(ctx.scene, tex, ctx.scene.environmentIntensity ?? 1);
    }));

    this.refreshSun(true);
    this.installSceneHook(ctx);
    this.syncMaterials(ctx.scene);
  }

  private buildCsm(ctx: Ctx): void {
    const cascades = clamp(ctx.quality.shadowCascades, 1, 4);
    const base = clamp(ctx.quality.shadowMapSize, 256, 4096);
    // The near cascade gets the full budget; the rest run at half, which is
    // where the memory goes at ultra (a 4096 map is 134 MB of colour + depth).
    const half = Math.max(256, base >> 1);
    this.csmSizes = [];
    for (let i = 0; i < cascades; i++) this.csmSizes.push(i === 0 ? base : half);

    const csm = new CSM({
      camera: ctx.camera,
      parent: ctx.scene,
      cascades,
      maxFar: CSM_MAX_FAR,
      mode: 'custom',
      // NOTE: this is the *snapping* resolution, not the allocation. Keeping it
      // at the smallest cascade size means cascade 0 snaps on a 2-texel grid,
      // which is still texel-aligned, so nothing crawls when the camera moves.
      shadowMapSize: half,
      lightIntensity: 1,
      lightNear: 1,
      lightFar: 520,
      lightMargin: 140,
      lightDirection: new THREE.Vector3(0, -1, 0),
      customSplitsCallback: (n, near, far, target) => {
        const nn = Math.max(near, SPLIT_NEAR);
        for (let i = 1; i < n; i++) {
          const f = i / n;
          const log = nn * Math.pow(far / nn, f);
          const uni = nn + (far - nn) * f;
          target.push(THREE.MathUtils.lerp(uni, log, SPLIT_LAMBDA) / far);
        }
        target.push(1);
      },
    });
    // Must be set before any material is registered — it is a shader define.
    csm.fade = true;
    csm.updateFrustums();

    for (let i = 0; i < csm.lights.length; i++) {
      const l = csm.lights[i];
      l.name = `sun.cascade.${i}`;
      l.shadow.mapSize.set(this.csmSizes[i], this.csmSizes[i]);
      l.castShadow = true;
    }
    this.csm = csm;
    this.tuneCascades();
  }

  /**
   * Bias and filter width scale with the cascade's world-space texel size.
   * A single global bias is what produces either acne in cascade 0 or
   * peter-panning in cascade 3 — there is no value that is right for both.
   */
  private tuneCascades(): void {
    const csm = this.csm;
    if (!csm) return;
    for (let i = 0; i < csm.lights.length; i++) {
      const l = csm.lights[i];
      const cam = l.shadow.camera as THREE.OrthographicCamera;
      const texel = Math.max(1e-4, (cam.right - cam.left) / this.csmSizes[i]);
      l.shadow.normalBias = clamp(texel * 1.65, 0.008, 0.28);
      l.shadow.bias = -0.000014 * (1 + i * 0.75);
      l.shadow.radius = 1.05 + i * 0.45;
    }
  }

  /* --------------------------------------------------------------- events */

  private onSunChanged(p: any): void {
    if (!p) return;
    this.skyDriven = true;
    const next: { dir?: THREE.Vector3; color?: THREE.Color; intensity?: number } = {};
    if (typeof p.hour === 'number') this.hour = p.hour;
    if (p.dir && typeof p.dir.x === 'number') next.dir = new THREE.Vector3(p.dir.x, p.dir.y, p.dir.z);
    if (p.color !== undefined) {
      next.color = p.color instanceof THREE.Color
        ? p.color.clone()
        : new THREE.Color().set(p.color as THREE.ColorRepresentation);
    }
    if (typeof p.intensity === 'number' && isFinite(p.intensity)) next.intensity = p.intensity;
    this.pendingSun = next;
  }

  /** Last-resort bridge: a sky that never emits but exposes its sun publicly. */
  private duckTypeSky(): void {
    if (this.skyDriven) return;
    const sky = this.ctx.sys['sky'] as any;
    if (!sky) return;
    const d = sky.sunDir ?? sky.sunDirection ?? sky.sun?.direction ?? sky.sun?.dir;
    if (d && typeof d.x === 'number') {
      this.pendingSun = { dir: new THREE.Vector3(d.x, d.y, d.z) };
      this.skyDriven = true;
    }
  }

  /* ---------------------------------------------------------------- ticks */

  private refreshSun(force: boolean): void {
    const sun = this.sun;
    evaluate(this.hour, sun);

    const p = this.pendingSun;
    if (p) {
      if (p.dir) reconcileDirection(p.dir, this.hour, sun.dir);
      applyDerived(this.hour, sun);
      if (p.color) sun.color.copy(p.color);
      if (p.intensity !== undefined) {
        // Treat the sky's intensity as a relative opinion, not an absolute:
        // peers scale differently and auto-exposure would just fight it.
        sun.intensity *= clamp(p.intensity / 3.0, 0.45, 1.8);
      }
      this.pendingSun = null;
    }

    const csm = this.csm;
    if (csm) {
      csm.lightDirection.copy(sun.dir).negate().normalize();
      const day = 1 - sun.night;
      for (const l of csm.lights) {
        l.color.copy(sun.color);
        l.intensity = sun.intensity;
        l.shadow.intensity = 0.94 * day;
        // Freeze the cascade depth passes at night: the moon does not cast a
        // shadow anyone can see under 84 floodlights, and this is four passes.
        l.shadow.autoUpdate = day > 0.02 || this.frames < 2;
      }
    }

    this.towers.update(sun.towers, this.ctx);

    // Re-project the SH only when it would actually change.
    const moved = this.projectedDir.dot(sun.dir) < 0.99996
      || Math.abs(this.projectedI - sun.intensity) > 0.02;
    if (force || moved) {
      this.ambient.update(sun, this.towers.irradiance);
      this.projectedDir.copy(sun.dir);
      this.projectedI = sun.intensity;
      if (!this.ambient.hasForeignEnv) this.ambient.ensureFallbackEnv(this.ctx, this.hour);
    }

    const envI = 0.95 - 0.25 * sun.night;
    this.ambient.setEnvIntensity(this.ctx.scene, envI);
  }

  lateUpdate(dt: number, ctx: Ctx): void {
    this.frames++;
    this.duckTypeSky();
    this.refreshSun(false);

    // Ambient DC term, roughly: the probe's band-0 luminance back out of SH.
    const c0 = this.ambient.probe.sh.coefficients[0];
    const ambientE = 0.886227 * (0.2126 * c0.x + 0.7152 * c0.y + 0.0722 * c0.z)
      * this.ambient.probe.intensity * Math.PI * 0.32;

    this.exposure.evaluate(this.sun, ambientE, this.towers.irradiance);
    ctx.renderer.toneMappingExposure = this.exposure.step(dt, this.snapExposure || this.frames < 3);
    this.snapExposure = false;

    if (ctx.scene.onBeforeRender !== this.sceneHookInstalled) this.installSceneHook(ctx);
    this.csm?.update();
  }

  resize(_w: number, _h: number, _ctx: Ctx): void {
    this.csm?.updateFrustums();
    this.tuneCascades();
  }

  /* ----------------------------------------------------- CSM material glue */

  /**
   * Installed on the scene rather than driven from `lateUpdate` because the
   * camera director runs after us in the system order; this fires immediately
   * before the renderer projects the scene, so the cascades always match the
   * camera that is about to be used.
   */
  private installSceneHook(ctx: Ctx): void {
    const prev = ctx.scene.onBeforeRender;
    this.prevSceneHook = prev === this.sceneHookInstalled ? this.prevSceneHook : prev;
    const self = this;
    const fn = function (this: THREE.Scene, renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, rt: any) {
      self.prevSceneHook?.call(this, renderer, scene, camera, rt);
      self.syncMaterials(scene);
      camera.updateMatrixWorld();
      self.csm?.update();
    };
    ctx.scene.onBeforeRender = fn as typeof ctx.scene.onBeforeRender;
    this.sceneHookInstalled = fn;
  }

  private syncMaterials(scene: THREE.Scene): void {
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      if (Array.isArray(m)) { for (const x of m) this.register(x); }
      else this.register(m);
    });
  }

  /**
   * Public escape hatch for peers that build materials outside the graph.
   *
   * Two shapes have to be handled. Some peers install `onBeforeCompile` as an
   * accessor pair that composes whatever is assigned to it (they anticipated
   * CSM clobbering them) — for those we simply assign and let them compose,
   * because wrapping a getter that mints a fresh closure per read both defeats
   * identity checks and recurses. Everything else gets a plain chain, with the
   * previous hook preserved and re-applied if a peer later overwrites us.
   */
  register(mat: THREE.Material): void {
    const ud = (mat as LitMaterial).userData;
    if (ud.__csmSelfChained) return;
    if (ud.__csmFn && ud.__csmFn === mat.onBeforeCompile) return;
    const csm = this.csm;
    if (!csm || !isLit(mat)) return;

    const desc = Object.getOwnPropertyDescriptor(mat, 'onBeforeCompile');
    if (desc && (desc.get || desc.set)) {
      ud.__csmSelfChained = true;
      csm.setupMaterial(mat);
      mat.needsUpdate = true;
      return;
    }

    const prev = mat.onBeforeCompile;
    csm.setupMaterial(mat);
    const csmFn = mat.onBeforeCompile;
    const chained = function (this: THREE.Material, shader: any, renderer: any) {
      csmFn.call(this, shader, renderer);
      if (prev && prev !== csmFn) prev.call(this, shader, renderer);
    };
    mat.onBeforeCompile = chained as typeof mat.onBeforeCompile;
    ud.__csmFn = chained;
    mat.needsUpdate = true;
  }

  /* -------------------------------------------------------------- teardown */

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    if (this.ctx && this.sceneHookInstalled && this.ctx.scene.onBeforeRender === this.sceneHookInstalled) {
      this.ctx.scene.onBeforeRender = (this.prevSceneHook ?? (() => {})) as typeof this.ctx.scene.onBeforeRender;
    }
    this.csm?.remove();
    this.csm?.dispose();
    this.csm = null;
    this.towers.dispose();
    this.ambient?.dispose();
  }
}

function isLit(m: THREE.Material): boolean {
  const a = m as any;
  return !!(a.isMeshStandardMaterial || a.isMeshPhysicalMaterial || a.isMeshPhongMaterial
    || a.isMeshLambertMaterial || a.isMeshToonMaterial
    || (a.isShaderMaterial && a.lights === true));
}
