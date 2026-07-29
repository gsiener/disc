import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import type { Ctx, System } from '../core/Ctx';
import { clamp } from '../util/Noise';
import {
  applyDerived, evaluate, makeSunState, reconcileDirection, type SunState,
} from './lighting/Solar';
import { AmbientRig } from './lighting/Ambient';
import { TowerRig, tierFor } from './lighting/Towers';
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

/**
 * Hard ceiling on cascade coverage.
 *
 * This was 160 m — chosen for a bowl whose far stands sit at 120 — and the
 * establishing shot parks its camera 212 m from its target. Every cascade
 * therefore ended *behind* the camera's own subject, so the one frame whose
 * entire job is to sell scale had no cast sun in it at all: the car park, the
 * trees, the roof and the masts were lit but ungrounded, and the only dark
 * shapes on the tarmac were the approach roads painted into the ground texture.
 * `fitCascadesToShot` still sizes the set to the subject, so a portrait keeps
 * its centimetre texels; this only stops the clamp from eating the wide.
 */
const CSM_MAX_FAR = 620;
/** 0 = uniform splits, 1 = logarithmic. Tuned so a 3 m subject and a 120 m
 *  stand both land on usable texel densities with only four cascades. */
const SPLIT_LAMBDA = 0.65;
/** Clamp for the log term — camera.near is 0.15 m, which would push cascade 0
 *  absurdly tight and starve everything behind it. */
const SPLIT_NEAR = 0.5;
/**
 * Subject distance past which a shot is treated as an establishing wide: the
 * splits are pushed out ahead of the subject (nothing in those frames is close
 * to the lens) and every cascade is allocated at full resolution rather than the
 * near-cascade-only budget, because in a wide it is the *far* cascade that has
 * to resolve a parked car.
 */
const WIDE_SUBJECT = 90;

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
  private csmBase = 2048;
  private csmHalf = 1024;
  /** Lower bound on the split ladder; raised for establishing wides. */
  private splitNear = SPLIT_NEAR;
  private sceneHookInstalled: ((...a: any[]) => void) | null = null;
  private prevSceneHook: ((...a: any[]) => void) | null = null;
  private unsub: Array<() => void> = [];
  /** Forces an indirect re-solve even when the sun has not moved. */
  private ambientDirty = true;
  private debugMode: 'full' | 'direct' | 'indirect' = 'full';

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
      this.ambientDirty = true;
      if (p?.shot) this.fitCascadesToShot(p.shot);
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
      this.ambientDirty = true;
    }));

    this.refreshSun(true);
    this.installSceneHook(ctx);
    this.syncMaterials(ctx.scene);
  }

  /**
   * Shadow maps are texture units, and a fragment shader gets sixteen of them.
   *
   * The scene spends two on the area-light LTC pair, one on the environment and
   * five or six on a physical material's map set, so the shadow budget is seven
   * — total, across the cascade set *and* the floodlight rig, because they
   * compile into the same program even though they are never both casting.
   *
   * Four towers is the look of a night game and the shot list has one; a fourth
   * cascade is a texel-density refinement on shots whose subject the cascades
   * are already fitted to. Given seven, the towers get four and the sun gets
   * three. Exceeding this does not degrade — it fails to link, and the material
   * that loses the draw is whichever one happens to compile last.
   */
  private cascadeBudget(ctx: Ctx): number {
    const towers = tierFor(ctx).shadowCasters;
    return clamp(7 - towers, 1, 4);
  }

  private buildCsm(ctx: Ctx): void {
    const cascades = clamp(Math.min(ctx.quality.shadowCascades, this.cascadeBudget(ctx)), 1, 4);
    const base = clamp(ctx.quality.shadowMapSize, 256, 4096);
    // The near cascade gets the full budget; the rest run at half, which is
    // where the memory goes at ultra (a 4096 map is 134 MB of colour + depth).
    const half = Math.max(256, base >> 1);
    this.csmBase = base;
    this.csmHalf = half;
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
      // A cascade fitted to a 400 m frustum slice is a ~700 m ortho box, and the
      // light is parked `lightMargin` behind its far corner. 520 m of depth
      // range clipped the back half of exactly the cascade the establishing shot
      // depends on, so the range now covers the widest set `CSM_MAX_FAR` allows.
      // Ortho depth is linear, so this costs no precision worth measuring.
      lightNear: 1,
      lightFar: 1800,
      lightMargin: 420,
      lightDirection: new THREE.Vector3(0, -1, 0),
      customSplitsCallback: (n, near, far, target) => {
        const nn = Math.max(near, SPLIT_NEAR, this.splitNear);
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
   *
   * `radius` is in *texels*, so a constant value would make the near cascade's
   * penumbra a centimetre and the far one's half a metre. That is the wrong way
   * round from what an eye expects — but it is also, by luck, close to right:
   * contact shadows should be tight and distant ones should not shimmer. What it
   * must not do is grow without limit, so the far cascades are held down.
   */
  private tuneCascades(): void {
    const csm = this.csm;
    if (!csm) return;
    for (let i = 0; i < csm.lights.length; i++) {
      const l = csm.lights[i];
      const cam = l.shadow.camera as THREE.OrthographicCamera;
      const texel = Math.max(1e-4, (cam.right - cam.left) / this.csmSizes[i]);
      // Normal-offset is the only bias that survives a grazing sun without
      // detaching the shadow from the contact point, so it carries the load and
      // the depth bias stays near zero. Scaled by 1/sin(elevation) because a
      // low sun stretches the depth gradient across the same texel.
      const graze = clamp(1 / Math.max(0.22, Math.abs(this.sun.dir.y)), 1, 3.4);
      l.shadow.normalBias = clamp(texel * 1.15 * graze, 0.006, 0.30);
      l.shadow.bias = -0.000008 * (1 + i * 0.6);
      // Keep the world-space penumbra from exploding on the far cascades: they
      // cover ten times the ground, so a constant texel radius is ten times the
      // blur, and a 60 cm-soft shadow under a player's foot reads as fog.
      const worldBlur = 0.055;                       // metres, roughly a foot's edge
      l.shadow.radius = clamp(worldBlur / texel, 0.9, 2.4);
    }
  }

  /**
   * Cascade coverage follows the shot.
   *
   * `maxFar` is what actually decides shadow texel density: four cascades spread
   * across 160 m give a portrait shot 4 cm texels under a chin, which is a
   * smeared grey blob rather than a contact shadow. Every named shot knows how
   * far away its subject is — that is what `focus` is — so the cascade set is
   * fitted to it and the far stands simply stop casting sun shadows they were
   * never going to be judged on.
   */
  private fitCascadesToShot(shot: { pos?: readonly number[]; target?: readonly number[]; focus?: number }): void {
    const csm = this.csm;
    if (!csm) return;
    let subject = shot.focus ?? 0;
    let camDist = 0;
    if (shot.pos && shot.target) {
      const dx = shot.pos[0] - shot.target[0];
      const dy = shot.pos[1] - shot.target[1];
      const dz = shot.pos[2] - shot.target[2];
      camDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    // `focus` is where the lens is looking, not how far the *set* extends. In a
    // wide the two differ by an order of magnitude, and it is the camera-to-
    // target distance that says how much world has to cast.
    if (!(subject > 0)) subject = camDist;
    else if (camDist > subject) subject = Math.max(subject, camDist * 0.9);
    if (!(subject > 0)) subject = 40;

    csm.maxFar = clamp(subject * 1.9 + 8, 16, CSM_MAX_FAR);
    // In a wide, cascade 0 is spent on air. Pushing the whole split ladder out
    // ahead of the subject moves two more cascades onto the geometry that is
    // actually in frame, which is worth more than the near cascade it costs.
    this.splitNear = subject > WIDE_SUBJECT
      ? clamp(subject * 0.16, SPLIT_NEAR, csm.maxFar * 0.25)
      : SPLIT_NEAR;
    // …and in a wide the far cascade is the one that has to resolve a car, so
    // it gets the full map instead of the half the near-shot budget gives it.
    const wide = subject > WIDE_SUBJECT;
    const cap = Math.min(this.csmBase, 2048);
    for (let i = 0; i < csm.lights.length; i++) {
      const want = wide ? cap : (i === 0 ? this.csmBase : this.csmHalf);
      if (this.csmSizes[i] === want) continue;
      this.csmSizes[i] = want;
      const sh = csm.lights[i].shadow;
      sh.mapSize.set(want, want);
      // Three only allocates the render target once; force a re-alloc.
      sh.map?.dispose();
      sh.map = null;
    }
    csm.updateFrustums();
    this.tuneCascades();
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
    if (force || moved || this.ambientDirty) {
      if (!this.ambient.hasForeignEnv) this.ambient.ensureFallbackEnv(this.ctx, this.hour);
      // The sun's irradiance on a horizontal surface is what the indirect budget
      // is expressed against — see Ambient.ts.
      const sunUp = sun.intensity * Math.max(0, sun.dir.y)
        * (0.2126 * sun.color.r + 0.7152 * sun.color.g + 0.0722 * sun.color.b);
      this.ambient.update(this.ctx, sun, this.towers.irradiance, this.ctx.scene.environment, sunUp);
      this.projectedDir.copy(sun.dir);
      this.projectedI = sun.intensity;
      this.ambientDirty = false;
    }

    if (this.debugMode !== 'full') this.applyDebugMode();
  }

  /** Mutes one half of the transport. See `setDebugMode`. */
  private applyDebugMode(): void {
    const direct = this.debugMode === 'direct';
    if (direct) {
      this.ambient.probe.intensity = 0;
      this.ambient.hemi.intensity = 0;
      this.ctx.scene.environmentIntensity = 0;
      return;
    }
    if (this.csm) for (const l of this.csm.lights) l.intensity = 0;
    for (const s of this.towers.spots) s.intensity = 0;
    // Board spill is a light, not a bounce — it belongs on the direct side.
    this.ctx.scene.traverse((o) => {
      if ((o as THREE.RectAreaLight).isRectAreaLight) (o as THREE.RectAreaLight).intensity = 0;
    });
  }

  lateUpdate(dt: number, ctx: Ctx): void {
    this.frames++;
    this.duckTypeSky();
    this.refreshSun(false);

    this.exposure.evaluate(this.sun, this.ambient.irradianceUp, this.towers.irradiance);
    ctx.renderer.toneMappingExposure = this.exposure.step(dt, this.snapExposure || this.frames < 3);
    this.snapExposure = false;

    if (ctx.scene.onBeforeRender !== this.sceneHookInstalled) this.installSceneHook(ctx);
    this.csm?.update();
  }

  resize(_w: number, _h: number, _ctx: Ctx): void {
    this.csm?.updateFrustums();
    this.tuneCascades();
  }

  /* --------------------------------------------------------------- debug */

  /**
   * Renders only one half of the light transport.
   *
   * The ratio between key and fill is the single number that decides whether a
   * shadow is visible, and until now it was being *guessed at* — the floodlight
   * rig had leaked into the indirect budget in three separate places precisely
   * because nothing in the build could show you what the split actually was.
   * `'direct'` kills every indirect term, `'indirect'` kills every light, and
   * the two frames divide to give the ratio at any pixel in the image.
   */
  setDebugMode(mode: 'full' | 'direct' | 'indirect'): void {
    this.debugMode = mode;
    this.ambientDirty = true;
    this.snapExposure = true;
  }

  /**
   * The solved light budget, in irradiance units, plus the key:fill ratio it
   * implies at pitch centre. `fillSide` is the number that matters for a
   * standing player: it is what the shadowed side of him receives.
   */
  lightReport(): {
    hour: number; elevation: number; night: number;
    keyUp: number; towerIrr: number; fillUp: number; fillSide: number;
    ratioUp: number; ratioSide: number;
    exposure: number; terms: Record<string, number>;
  } {
    const sun = this.sun;
    const lumaCol = 0.2126 * sun.color.r + 0.7152 * sun.color.g + 0.0722 * sun.color.b;
    const keyUp = sun.intensity * Math.max(0, sun.dir.y) * lumaCol;
    const tower = this.towers.irradiance;
    const fillUp = this.ambient.irradianceUp;
    const fillSide = this.ambient.irradianceSide;
    // A vertical surface at pitch centre sees the sun/rig at a cosine of roughly
    // the elevation's complement; for the ratio that decides shadow visibility
    // the useful comparison is total key against total fill on the same normal.
    const keySide = sun.intensity * Math.sqrt(Math.max(0, 1 - sun.dir.y * sun.dir.y)) * lumaCol
      + tower * 0.62;
    return {
      hour: this.hour,
      elevation: (sun.elevation * 180) / Math.PI,
      night: sun.night,
      keyUp: keyUp + tower,
      towerIrr: tower,
      fillUp,
      fillSide,
      ratioUp: fillUp > 1e-6 ? (keyUp + tower) / fillUp : Infinity,
      ratioSide: fillSide > 1e-6 ? keySide / fillSide : Infinity,
      exposure: this.exposure.value,
      terms: { ...this.ambient.report },
    };
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
