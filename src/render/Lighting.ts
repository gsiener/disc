import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import type { Ctx, System } from '../core/Ctx';
import { clamp, smoothstep } from '../util/Noise';
import { envFromFn } from '../util/Tex';
import {
  applyDerived, evaluate, makeSunState, reconcileDirection,
  FLOOD_COLOR, TURF_BOUNCE, horizonColor, zenithColor, type SunState,
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

/* ------------------------------------------------------ night environment */

/**
 * THE NIGHT IBL, AND WHY THE RIG HAS TO OWN IT.
 *
 * `scene.environment` is the sky's PMREM. In daylight that is exactly right —
 * the sky *is* the environment. After the sun sets it stops being true: the
 * environment a stadium sits in at 21:30 is four blazing racks at 37 m, a
 * floodlit pitch that is by a long way the brightest surface for a kilometre,
 * a ring of lit stand fronts, and only then a very dark blue sky. The sky
 * system knows about none of that, so at night every reflective surface in the
 * frame was mirroring `Atmosphere.GLOW_DOME` — a warm sodium-orange dome —
 * measured on the night frame at #322b2b, sat 0.15, R > G > B. That is the
 * wrong hue for a metal-halide venue and it lands on the things that show a
 * reflection most: the disc (metalness 1), mast steel (0.85), the roof deck
 * (0.62), seats, shoes, hair, eyes, car paint.
 *
 * So at night the rig bakes its own environment. Five components, each one a
 * thing you can point at in a real night frame:
 *
 *   1. a very dark desaturated blue sky, hue straight off `Solar`'s ramps;
 *   2. a glow dome — the rig's uplight scattering back over the bowl, cool at
 *      altitude and warmed at the rim by the pitch it has bounced off;
 *   3. a ring of lit stand fronts just above the horizon;
 *   4. the four fixture racks, as small bright discs at their true bearings;
 *   5. below the horizon, the floodlit pitch, which is what uplights jaws,
 *      forearms, hoardings and the underside of the roof.
 *
 * ## Why the components are budgeted rather than authored in absolute units
 *
 * The physically true radiance of a rack seen from the pitch is ~400 — three
 * orders of magnitude over the turf. Putting that in the map would double the
 * rig's diffuse contribution and, worse, add it *unshadowed*, which is exactly
 * the mistake the fake RectAreaLight fill made: light arriving from the same
 * direction as the key, through the occluder. `AmbientRig` guards against that
 * by normalising `scene.environmentIntensity` so the IBL delivers its share of
 * the sky budget and no more — so an over-bright map does not get brighter, it
 * just gets renormalised until everything else in it is crushed to nothing.
 *
 * The only quantity that survives that normalisation is the map's *internal*
 * contrast. So each component is scaled, at bake time, to deliver an explicit
 * share of the two budgets `AmbientRig` has already solved: the sky hemisphere
 * against `report.skyBudget`, the ground hemisphere against
 * `report.bounceBudget`.
 *
 * `lightReport().envIntensity` reads back what the solve then chose. It is not
 * 1 and cannot be — see `AMB_SHARE_ENV_BOUNCE` — but it is the number to watch:
 * it measured 0.27 when the ground half was authored at the share `Ambient.ts`
 * assumes, and 0.50 at the share this file actually uses, and every stop it
 * loses is a stop off the four heads that are the whole point of the bake.
 */

/** Where the night IBL is sampled from: the middle of the pitch, chest high. */
const ENV_ORIGIN = new THREE.Vector3(0, 1.4, 0);
/**
 * Half-width of a tower's fixture rack, metres. `Towers.RACK_W` is 10 m, and
 * that is what sets the angular size of the head in the map — ~6° across from
 * the middle of the pitch, which is a small bright source, not a point.
 */
const HEAD_HALF_W = 5.0;
/** Shares of the map's own up-irradiance. Sum to 1. */
const W_SKY_BASE = 0.28;
const W_DOME = 0.30;
const W_BOWL = 0.17;
const W_HEADS = 0.25;
/**
 * Scale height of the glow dome in sin(elevation): `exp(-h * 5)` is half gone
 * by 8° and a tenth by 26°. Light pollution over a venue is a *low* dome —
 * spread it up the sky and it stops reading as spill and starts reading as
 * overcast, which is the failure mode the drawn sky is in.
 */
const DOME_K = 5.0;
/**
 * `Ambient.SHARE_ENV` — the IBL's share of the sky budget — duplicated here on
 * purpose. It only *sizes* the bake, so if it drifts the cost is a proportional
 * error in the map's ground:sky ratio, not a blow-up, and
 * `lightReport().envIntensity` shows it immediately.
 */
const AMB_SHARE_ENV = 0.52;
/**
 * How much of the bounce budget our own ground hemisphere carries — and why it
 * is a seventh of the 0.45 `Ambient.ts` assumes a foreign PMREM brings.
 *
 * `scene.environmentIntensity` is solved from the map's *up* irradiance, and
 * `EnvMeter` reads that from the roughness-1 mip of the PMREM chain. That mip
 * is a GGX convolution, not a cosine one, so radiance in the **ground**
 * hemisphere leaks into the up-facing sample and drags the whole map's
 * intensity down with it. Measured on this bake, authoring the pitch at the
 * full 0.45 share: 0.172 of leak against a 0.065 sky budget — 73 % of the
 * measurement — `environmentIntensity` solved to 0.27, and everything the map
 * exists for (the four heads, the dome, the blue) came back a stop and a half
 * dimmer than authored.
 *
 * Worse, the side irradiance that buys you *saturates*. With
 * `upLuma = E_sky + leak * G` and `i = B / upLuma`, the env's contribution to a
 * vertical surface is `sigma * G * B / (B + leak * G)`, which tends to
 * `sigma * B / leak` however hard you push `G`. The ceiling here measured 0.073
 * against the 0.102 the budget wanted, so the bright ground was a knob that
 * only cost.
 *
 * So the ground half is a *hue* term, not an energy term: enough that jaws,
 * hoardings and the underside of the roof reflect lit grass rather than
 * nothing. At 0.06 the numbers come out right on their own and no compensation
 * anywhere else is needed — `environmentIntensity` solves to 1.29 (the bake and
 * the solve agree), and `lightReport().ratioSide` lands on **5.93** against the
 * art direction's 6:1 for a floodlit pitch, which is closer than the 5.68 this
 * frame ran at before the night IBL existed. Both numbers move together if you
 * touch this constant, so re-measure both.
 */
const AMB_SHARE_ENV_BOUNCE = 0.06;

/** Deterministic Fibonacci sphere used to solve the component scales. */
const SOLVE_N = 1024;
const SOLVE_DIRS = (() => {
  const out = new Float32Array(SOLVE_N * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < SOLVE_N; i++) {
    const y = 1 - (2 * i + 1) / SOLVE_N;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    out[i * 3] = Math.cos(th) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(th) * r;
  }
  return out;
})();

const REC709 = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const _envZen = new THREE.Color();
const _envHor = new THREE.Color();
/**
 * The rim of the glow dome, linear. Rig light that has gone up, come back down
 * off the haze and bounced off grass and tarmac on the way — warm neutral, and
 * the only warm thing in a correct night sky.
 */
const DOME_RIM = new THREE.Color(0.62, 0.50, 0.34);
/** Lit stand fronts and crowd wall: concrete under rig spill. Hue only. */
const BOWL_TINT = new THREE.Color(0.55, 0.52, 0.48);
/** The floodlit sward — turf albedo under metal halide. Hue only. */
const GROUND_TINT = new THREE.Color(
  TURF_BOUNCE.r * FLOOD_COLOR.r, TURF_BOUNCE.g * FLOOD_COLOR.g, TURF_BOUNCE.b * FLOOD_COLOR.b,
);

interface HeadDisc { x: number; y: number; z: number; cosOuter: number; cosInner: number }

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

  /** The last PMREM a peer (the sky) published. Handed back when day returns. */
  private skyEnv: THREE.Texture | null = null;
  /** Our own night PMREM — see the NIGHT IBL note above. */
  private nightEnv: THREE.Texture | null = null;
  private nightEnvBound = false;
  private nightEnvHour = -999;
  private nightEnvRatio = -1;
  private nightEnvFrame = -999;
  private headDiscs: HeadDisc[] = [];

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
      if (tex) {
        this.skyEnv = tex;
        this.ambient.adoptEnvironment(ctx.scene, tex, ctx.scene.environmentIntensity ?? 1);
        // The sky assigns `scene.environment` itself before emitting, so a
        // rebake silently unbinds the night map. Put it straight back.
        this.nightEnvBound = false;
        this.syncNightEnv(ctx);
      }
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
      /**
       * The ceiling used to be 0.30 m and the multiplier 1.15, and with the far
       * cascades allocated at half resolution that is what the broadcast frame
       * was actually running: a 0.13 m texel × 1.15 × 1.71 (a 36° sun) is a
       * 25 cm normal offset, and 25 cm at a 46 m subject is eight screen pixels
       * of clean turf between a shoe and its own shadow. Every player in the
       * primary angle was floating. Contact is the one thing the brief says
       * matters more than the big shadow, so the offset is now sized to the
       * thing it has to ground — a foot — rather than to whatever the cascade
       * happened to be allocated: 0.11 m hard ceiling, and the multiplier down
       * to 0.80, which the doubled far-cascade resolution in `fitCascadesToShot`
       * pays for. Acne is held off by the normal offset still scaling with
       * texel size and by the depth bias below, which does the last millimetre.
       */
      l.shadow.normalBias = clamp(texel * 0.80 * graze, 0.005, 0.11);
      l.shadow.bias = -0.000012 * (1 + i * 0.6);
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

    this.towers.update(sun.towers, this.ctx, sun.towersVisual);
    // Before the indirect solve — it reads `scene.environment` as an argument.
    this.syncNightEnv(this.ctx);

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

  /* ------------------------------------------------------ night environment */

  /**
   * Bind the right environment for the hour: the sky's PMREM in daylight, ours
   * once the sun is properly down. See the NIGHT IBL note at the top.
   *
   * The takeover is conditional on a peer having published an environment at
   * all. `AmbientRig.adoptEnvironment` is one-way — it latches `foreignEnv` and
   * drops its own fallback bake — so without a sky texture to hand back there
   * would be nothing to return to in the morning, and a stripped build would be
   * lit by a night map at noon. In that case we simply leave the fallback alone.
   */
  private syncNightEnv(ctx: Ctx): void {
    if (this.sun.night <= 0.5) {
      if (this.nightEnvBound) {
        if (this.skyEnv) this.ambient.adoptEnvironment(ctx.scene, this.skyEnv, 1);
        this.nightEnvBound = false;
        this.ambientDirty = true;
      }
      return;
    }
    if (!this.skyEnv) return;

    // The two budgets the bake is sized against. `AmbientRig` solves them from
    // the sun and the rig — never from the environment — so they do not move in
    // response to our own bake and this cannot chase its own tail. Before the
    // first solve they are zero; the estimate below stands in for one frame and
    // the hysteresis re-bakes once the real numbers land.
    const rep = this.ambient.report;
    const sky = rep.skyBudget > 1e-5 ? rep.skyBudget : 0.012 + 0.035 * this.towers.irradiance;
    const bounce = rep.bounceBudget > 1e-5 ? rep.bounceBudget : 0.066 * this.towers.irradiance;
    const ratio = bounce / Math.max(sky, 1e-5);

    const stale = !this.nightEnv
      || Math.abs(this.hour - this.nightEnvHour) > 0.2
      || Math.abs(ratio - this.nightEnvRatio) > this.nightEnvRatio * 0.12;
    if (stale && this.frames !== this.nightEnvFrame) {
      this.bakeNightEnv(ctx, sky, bounce);
      this.nightEnvHour = this.hour;
      this.nightEnvRatio = ratio;
      this.nightEnvFrame = this.frames;
      this.nightEnvBound = false;
    }
    if (this.nightEnv && !this.nightEnvBound) {
      this.ambient.adoptEnvironment(ctx.scene, this.nightEnv, 1);
      this.nightEnvBound = true;
      this.ambientDirty = true;
    }
  }

  /**
   * Bake the stadium-at-night environment.
   *
   * Every component is authored as a *shape* — a colour and an angular
   * distribution — and then scaled so it delivers an explicit share of a budget
   * `AmbientRig` has already solved. The sky hemisphere is solved against
   * `skyBudget` on an up-facing normal, the ground hemisphere against
   * `bounceBudget` on a vertical one, both by numeric integration over the same
   * Fibonacci set, so the shapes can be changed freely without anybody having
   * to re-derive a magic constant.
   */
  private bakeNightEnv(ctx: Ctx, skyBudget: number, bounceBudget: number): void {
    const deg = (this.sun.elevation * 180) / Math.PI;
    const zen = zenithColor(deg, _envZen);
    const hor = horizonColor(deg, _envHor);

    // The four racks at their true bearings and true angular size. A 10 m rack
    // at ~90 m is ~6° across: small enough to read as a source, wide enough to
    // survive the PMREM chain instead of aliasing into a flickering texel.
    this.headDiscs.length = 0;
    for (const s of this.towers.spots) {
      const dx = s.position.x - ENV_ORIGIN.x;
      const dy = s.position.y - ENV_ORIGIN.y;
      const dz = s.position.z - ENV_ORIGIN.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(d > 1)) continue;
      const ang = Math.atan2(HEAD_HALF_W, d);
      this.headDiscs.push({
        x: dx / d, y: dy / d, z: dz / d,
        cosInner: Math.cos(ang * 0.6), cosOuter: Math.cos(ang * 1.6),
      });
    }
    const heads = this.headDiscs;

    /* --------------------------------------------------------- shapes */

    const base = (h: number, out: [number, number, number]) => {
      const t = Math.pow(1 - h, 2.4);
      out[0] = zen.r + (hor.r - zen.r) * t;
      out[1] = zen.g + (hor.g - zen.g) * t;
      out[2] = zen.b + (hor.b - zen.b) * t;
    };
    const dome = (h: number, out: [number, number, number]) => {
      // Cool at altitude, warmed at the rim by the pitch the light bounced off
      // on its way up. That warm lower edge is the only warm thing in a correct
      // night sky, and the drawn sky currently applies it to the whole dome.
      const k = smoothstep(0.0, 0.34, h);
      const a = Math.exp(-h * DOME_K);
      out[0] = (DOME_RIM.r + (FLOOD_COLOR.r - DOME_RIM.r) * k) * a;
      out[1] = (DOME_RIM.g + (FLOOD_COLOR.g - DOME_RIM.g) * k) * a;
      out[2] = (DOME_RIM.b + (FLOOD_COLOR.b - DOME_RIM.b) * k) * a;
    };
    const bowl = (h: number, out: [number, number, number]) => {
      // Stand fronts and the crowd wall: a ring from the horizon to ~15°.
      const a = smoothstep(-0.03, 0.025, h) * smoothstep(0.26, 0.06, h);
      out[0] = BOWL_TINT.r * a; out[1] = BOWL_TINT.g * a; out[2] = BOWL_TINT.b * a;
    };
    const head = (x: number, y: number, z: number, out: [number, number, number]) => {
      let a = 0;
      for (let i = 0; i < heads.length; i++) {
        const hd = heads[i];
        const c = x * hd.x + y * hd.y + z * hd.z;
        if (c > hd.cosOuter) a += smoothstep(hd.cosOuter, hd.cosInner, c);
      }
      out[0] = FLOOD_COLOR.r * a; out[1] = FLOOD_COLOR.g * a; out[2] = FLOOD_COLOR.b * a;
    };
    const ground = (y: number, out: [number, number, number]) => {
      // The floodlit pitch. Grazing directions look at the dark run-off and the
      // far side of the bowl, so the sward only fills the steeper half — which
      // is also what keeps the bounce off a vertical surface honest.
      const a = smoothstep(-0.02, -0.24, y);
      out[0] = GROUND_TINT.r * a; out[1] = GROUND_TINT.g * a; out[2] = GROUND_TINT.b * a;
    };

    /* ---------------------------------------------------------- solve */

    const w = (4 * Math.PI) / SOLVE_N;
    const c: [number, number, number] = [0, 0, 0];
    let upBase = 0, upDome = 0, upBowl = 0, upHead = 0, sideGnd = 0;
    for (let i = 0; i < SOLVE_N; i++) {
      const x = SOLVE_DIRS[i * 3], y = SOLVE_DIRS[i * 3 + 1], z = SOLVE_DIRS[i * 3 + 2];
      if (y >= 0) {
        base(y, c); upBase += REC709(c[0], c[1], c[2]) * y * w;
        dome(y, c); upDome += REC709(c[0], c[1], c[2]) * y * w;
        bowl(y, c); upBowl += REC709(c[0], c[1], c[2]) * y * w;
        head(x, y, z, c); upHead += REC709(c[0], c[1], c[2]) * y * w;
      } else if (x > 0) {
        // Irradiance on a vertical surface, from the ground hemisphere only.
        ground(y, c); sideGnd += REC709(c[0], c[1], c[2]) * x * w;
      }
    }
    const skyTotal = AMB_SHARE_ENV * skyBudget;
    const s = (want: number, got: number) => (got > 1e-12 ? want / got : 0);
    const kBase = s(W_SKY_BASE * skyTotal, upBase);
    const kDome = s(W_DOME * skyTotal, upDome);
    const kBowl = s(W_BOWL * skyTotal, upBowl);
    const kHead = s(W_HEADS * skyTotal, upHead);
    const kGnd = s(AMB_SHARE_ENV_BOUNCE * bounceBudget, sideGnd);

    /* ----------------------------------------------------------- bake */

    const size = ctx.quality.tier === 'low' ? 48 : 96;
    const acc: [number, number, number] = [0, 0, 0];
    const prev = this.nightEnv;
    this.nightEnv = envFromFn(ctx.renderer, size, (x, y, z, out) => {
      if (y >= 0) {
        base(y, acc); out[0] = acc[0] * kBase; out[1] = acc[1] * kBase; out[2] = acc[2] * kBase;
        dome(y, acc); out[0] += acc[0] * kDome; out[1] += acc[1] * kDome; out[2] += acc[2] * kDome;
        bowl(y, acc); out[0] += acc[0] * kBowl; out[1] += acc[1] * kBowl; out[2] += acc[2] * kBowl;
        head(x, y, z, acc);
        out[0] += acc[0] * kHead; out[1] += acc[1] * kHead; out[2] += acc[2] * kHead;
      } else {
        ground(y, acc); out[0] = acc[0] * kGnd; out[1] = acc[1] * kGnd; out[2] = acc[2] * kGnd;
      }
    });
    if (prev) {
      if (ctx.scene.environment === prev) ctx.scene.environment = this.nightEnv;
      prev.dispose();
    }
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
    exposure: number; nightEnv: boolean; envIntensity: number;
    terms: Record<string, number>;
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
      // `nightEnv` says the rig owns the environment; `envIntensity` is the
      // scalar the indirect solve chose for it. Near 1 means the bake and the
      // solve agree — see the NIGHT IBL note for why that is the check.
      nightEnv: this.nightEnvBound,
      envIntensity: this.ctx?.scene.environmentIntensity ?? 1,
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
    if (this.nightEnv) {
      if (this.ctx && this.ctx.scene.environment === this.nightEnv) {
        this.ctx.scene.environment = this.skyEnv;
      }
      this.nightEnv.dispose();
      this.nightEnv = null;
    }
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
