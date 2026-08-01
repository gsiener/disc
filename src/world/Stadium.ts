import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';
import type { Shot } from '../capture/Shots';
import { StadiumMaterials } from './stadium/Materials';
import { buildBowl } from './stadium/Bowl';
import { buildRoof } from './stadium/Roof';
import { buildScreens, type ScreensBuild } from './stadium/Screens';
import { buildTowers, type TowersBuild } from './stadium/Towers';
import { buildSideline } from './stadium/Sideline';
import { buildExterior, setExteriorNight } from './stadium/Exterior';
import {
  bowlRows, ringSamples, sampleSeats, seatLayout, bowlSpec,
  type SeatSample, type StadiumBowlSpec, type StadiumSeatLayout,
} from './stadium/Layout';

export {
  FLOODLIGHT_TOWERS, SCREENS, BOWL, ROOF, CLUB, ROWS, SIT_HEIGHT,
  sampleSeats, seatLayout, bowlSpec, sectionAt,
  rowY, rowOffset, rowTread, rowRise, bowlRows, roofYAt,
  DECK_TOP_Y, OUTER_OFF, FACADE_OFF,
  type FloodlightTower, type SeatSample, type StadiumBowlSpec, type StadiumSeatLayout,
} from './stadium/Layout';

/**
 * The venue.
 *
 * Built once at init into a handful of welded buffers and instanced meshes:
 *
 *   bowl      raked concrete deck, ~19 k instanced seats coloured from a seat
 *             map that spells the club name out in contrasting seats, aisle
 *             stairs with painted nosings, handrails, six vomitories, section
 *             and row numbering.
 *   roof      cantilever ring canopy on 44 radial trusses and 22 lattice
 *             columns. Casts the hard shadow line across the stands at low sun.
 *   screens   pitch-side LED ring, roof ribbon board and four corner
 *             jumbotrons, all through one LED-dot shader. The perimeter ring
 *             also drives four RectAreaLights so the boards spill onto the turf.
 *   towers    four floodlight masts. LightingSystem places the real lights from
 *             the exported FLOODLIGHT_TOWERS constant so beams and hardware
 *             agree — see src/world/stadium/Layout.ts.
 *   sideline  benches, canopies, coolers, jugs, kit bags, cone stacks, medical
 *             carts, hung camera gantries with operators, boom op, reporter,
 *             endline photographer pit, substitution-box markings.
 *   exterior  hardstand, car parks with cars and lighting columns, trees, a
 *             low-rise city edge and hills fading into aerial perspective.
 *
 * ---------------------------------------------------------------------------
 * SEAT LAYOUT API — for the Crowd system
 * ---------------------------------------------------------------------------
 * Read seat placement off this system rather than re-deriving the bowl. Every
 * one of these is populated in `init()` and never mutated afterwards, and each
 * is defensively available both as a property and as a getter:
 *
 *   ctx.sys.stadium.seats         SeatSample[]        every modelled seat
 *   ctx.sys.stadium.seatLayout    StadiumSeatLayout   seats + row/section structure
 *   ctx.sys.stadium.bowl          StadiumBowlSpec     flat numeric summary
 *   ctx.sys.stadium.hasBowl       true                a real deck exists — do not
 *                                                     build a fallback one
 *   ctx.sys.stadium.getSeats()  /  .getSeatLayout()  /  .getBowl()
 *
 * `StadiumBowlSpec` is field-for-field the same shape as `crowd/Bowl.ts`'s
 * `BowlSpec`, so it can be adopted wholesale. Full contract, including what
 * `pos`/`yaw`/`row`/`t`/`seg`/`tier`/`section` mean, is documented at the
 * bottom of `src/world/stadium/Layout.ts`.
 */
export class StadiumSystem implements System {
  readonly name = 'stadium';
  readonly order = 4;

  private mats = new StadiumMaterials();
  private root = new THREE.Group();
  private screens: ScreensBuild | null = null;
  private towers: TowersBuild | null = null;
  private exterior: THREE.Group | null = null;

  /** 0 = full daylight, 1 = full night. Drives every emitter in the venue. */
  private night = 0;
  private targetNight = 0;
  private nextJumboAt = -1;
  private rows = 30;
  /** Every mesh this system re-emitted as cullable pieces (seats + exterior). */
  private shards: THREE.InstancedMesh[] = [];
  /** Off restores the "every seat always casts" path, for the A/B. */
  private seatShadowBand = true;
  /** What `Bowl.ts` decided about seat shadow casting for this tier. */
  private seatsCast = false;

  /* ------------------------------------------- seat layout API (see above) */
  /** Every modelled seat, row-major from row 0. Read-only for peers. */
  seats: SeatSample[] = sampleSeats();
  /** Seats + row/section structure + exact per-row heights. */
  seatLayout: StadiumSeatLayout = seatLayout();
  /** Flat numeric summary, shaped like `crowd/Bowl.ts`'s `BowlSpec`. */
  bowl: StadiumBowlSpec = bowlSpec();
  /** Tells peers not to build a fallback deck of their own. */
  readonly hasBowl = true;
  seatCount = this.seats.length;

  getSeats(): SeatSample[] { return this.seats; }
  getSeatLayout(): StadiumSeatLayout { return this.seatLayout; }
  getBowl(): StadiumBowlSpec { return this.bowl; }

  init(ctx: Ctx): void {
    this.root.name = 'stadium';
    this.mats.build(ctx);

    const rows = bowlRows(ctx.quality);
    const ringN = ringSamples(ctx.quality);
    this.rows = rows;

    const bowl = buildBowl(ctx, this.mats, rows, ringN);
    this.seatCount = bowl.seatCount;
    this.root.add(bowl.group);

    this.root.add(buildRoof(ctx, this.mats, rows, ringN));

    this.screens = buildScreens(ctx, this.mats, rows, ringN);
    this.root.add(this.screens.group);

    this.towers = buildTowers(ctx, this.mats);
    this.root.add(this.towers.group);

    this.root.add(buildSideline(ctx, this.mats).group);

    this.exterior = buildExterior(ctx, this.mats);
    this.root.add(this.exterior);

    this.shardSeats(ctx);
    this.shardExterior(ctx);

    ctx.scene.add(this.root);

    ctx.events.on('shot:apply', (p: { name: string; shot: Shot }) => {
      this.targetNight = nightFromHour(p.shot.hour);
      this.night = this.targetNight;
      this.applyNight();
      this.nextJumboAt = -1;
    });
    ctx.events.on('sun:changed', (p: { dir?: THREE.Vector3; hour?: number }) => {
      if (p?.dir) this.targetNight = clamp01((0.10 - p.dir.y) / 0.22);
      else if (typeof p?.hour === 'number') this.targetNight = nightFromHour(p.hour);
    });

    this.applyNight();
    this.screens.refresh(ctx);
  }

  /**
   * Cut the seat bowl into angular wedges so it can be view-culled.
   *
   * `Bowl.ts` builds ~16 k seats as one `InstancedMesh` with
   * `frustumCulled = false`, which at `ultra` is the largest single triangle
   * line in the venue: 1.18 M triangles submitted to the beauty pass, to GTAO's
   * G-buffer, and — because nothing could cull it — to *every* shadow cascade,
   * twice a frame. Measured at 9.44 M of the frame's 32 M.
   *
   * None of that geometry changes here. The wedges share the same geometry and
   * material and carry the same matrices and colours; they simply have honest
   * bounding spheres, so three drops the ones behind the camera in the beauty
   * pass and the ones outside a cascade's own box in that cascade's shadow map.
   * A wedge that is culled from a shadow camera could not have written into that
   * map anyway, which is why this is free rather than a trade.
   */
  private shardSeats(ctx: Ctx): void {
    const src = this.root.getObjectByName('seats') as THREE.InstancedMesh | undefined;
    if (!src || !(src as any).isInstancedMesh || src.count < 512) return;
    const parent = src.parent ?? this.root;
    this.seatsCast = src.castShadow;

    // 16 wedges is where the return flattens: a 22.5° slice of a 30-row stand is
    // still compact enough for a tight sphere, and the worst case adds 15 draw
    // calls to a pass that is drawing 258 for this system already.
    const SHARDS = 16;
    const n = src.count;
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    const hasCol = !!src.instanceColor;

    const bucket = new Int32Array(n);
    const counts = new Int32Array(SHARDS);
    for (let i = 0; i < n; i++) {
      src.getMatrixAt(i, m);
      const x = m.elements[12], z = m.elements[14];
      let s = Math.floor(((Math.atan2(z, x) + Math.PI) / (2 * Math.PI)) * SHARDS);
      s = s < 0 ? 0 : s >= SHARDS ? SHARDS - 1 : s;
      bucket[i] = s;
      counts[s]++;
    }

    this.shards.push(...emit(src, parent, bucket, counts, SHARDS, 'seats', 1.0, m, col, hasCol));
    parent.remove(src);
    src.dispose();
    if (ctx.debug) console.log(`[stadium] seats: 1 mesh -> ${this.shards.length} cullable wedges`);
  }

  /**
   * The same treatment for the car parks and treelines outside the bowl.
   *
   * Each of those is one `InstancedMesh` spanning the whole site — six of them
   * are 3.4 M triangles a frame at broadcast, from a camera that cannot see a
   * single car because the stand is in the way. A site-wide bounding sphere can
   * never be culled, and neither can it be excluded from a shadow cascade fitted
   * to the pitch. Cut on a coarse XZ grid, each cluster gets a sphere the size
   * of one car park, and the cascades that do not reach it stop drawing it.
   */
  private shardExterior(ctx: Ctx): void {
    if (!this.exterior) return;
    const targets: THREE.InstancedMesh[] = [];
    this.exterior.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if ((im as any).isInstancedMesh && im.count >= 24 && /^(cars|trees|park)-/.test(im.name)) {
        targets.push(im);
      }
    });

    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    const G = 4;                          // 4 × 4 cells over each prop's extent
    for (const src of targets) {
      const parent = src.parent;
      if (!parent) continue;
      const n = src.count;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < n; i++) {
        src.getMatrixAt(i, m);
        const x = m.elements[12], z = m.elements[14];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      const sx = Math.max(1e-3, maxX - minX), sz = Math.max(1e-3, maxZ - minZ);
      const bucket = new Int32Array(n);
      const counts = new Int32Array(G * G);
      for (let i = 0; i < n; i++) {
        src.getMatrixAt(i, m);
        const gx = Math.min(G - 1, Math.floor(((m.elements[12] - minX) / sx) * G));
        const gz = Math.min(G - 1, Math.floor(((m.elements[14] - minZ) / sz) * G));
        const k = gz * G + gx;
        bucket[i] = k;
        counts[k]++;
      }
      let used = 0;
      for (let k = 0; k < G * G; k++) if (counts[k]) used++;
      if (used < 2) continue;             // one cluster — nothing to gain

      const hasCol = !!src.instanceColor;
      // Trees and cars are 2–6 m tall and the sphere comes off instance origins.
      this.shards.push(
        ...emit(src, parent, bucket, counts, G * G, src.name, 3.5, m, col, hasCol));
      parent.remove(src);
      src.dispose();
    }
    if (ctx.debug) console.log(`[stadium] exterior: ${targets.length} meshes sharded`);
  }

  /**
   * Debug: put the seat bowl back on the old always-submitted path so a single
   * page session can photograph both and diff. See `world/Grass.ts setCulling`.
   */
  setCulling(on: boolean): void {
    for (const m of this.shards) m.frustumCulled = on;
    this.seatShadowBand = on;
    if (!on) {
      for (const m of this.shards) if (m.name.startsWith('seats.')) m.castShadow = this.seatsCast;
    }
  }

  /**
   * Distance-band the seat bowl's shadow casting.
   *
   * `Bowl.ts` turns `castShadow` on for all ~16 k seats at `ultra`, and it is
   * right to: at 4096 the near rows do get a readable rake of seat-back shadow.
   * What it cannot know is that the *far* rows do not. A seat 60 m out is two
   * pixels wide, its cascade texel is wider than its back, and — decisively —
   * the spectator sitting in it casts no shadow at all, so there is nothing for
   * its shadow to be consistent with.
   *
   * Measured on the shot rig, switching every seat off entirely moved 0.098 % of
   * broadcast pixels and 0.145 % of the aerial, all of it single-pixel dither on
   * far handrails and stair nosings — and took 5.03 M triangles a frame with it.
   * Banding at 40 m keeps the rows where the rake is legible and drops the rest,
   * so the visible half of the trade is bought back and most of the cost stays
   * gone. `castShadow` is read fresh when the shadow render list is built, so
   * flipping it per frame is free.
   */
  private bandSeatShadows(ctx: Ctx): void {
    // Below `ultra`, Bowl.ts turns seat shadows off outright because the cascade
    // texel is coarser than a seat back — banding must never switch them back on.
    if (!this.seatShadowBand || !this.seatsCast) return;
    const cam = ctx.camera.position;
    for (const m of this.shards) {
      if (!m.name.startsWith('seats.')) continue;
      const s = m.boundingSphere;
      const d = s ? Math.max(0, cam.distanceTo(s.center) - s.radius) : 0;
      m.castShadow = d < SEAT_SHADOW_DIST;
    }
  }

  lateUpdate(dt: number, ctx: Ctx): void {
    this.bandSeatShadows(ctx);
    if (!this.screens) return;
    const t = ctx.time;
    this.screens.perimeter.uniforms.uTime.value = t;
    this.screens.ribbon.uniforms.uTime.value = t;

    if (Math.abs(this.night - this.targetNight) > 1e-3) {
      this.night += (this.targetNight - this.night) * Math.min(1, dt * 1.5);
      this.applyNight();
    }
    if (t >= this.nextJumboAt) {
      this.nextJumboAt = t + 0.2;
      this.screens.refresh(ctx);
    }
  }

  private applyNight(): void {
    const k = clamp01(this.night);
    this.screens?.setNight(k);
    this.towers?.setNight(k);
    if (this.exterior) setExteriorNight(this.exterior, k);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.mats.dispose();
  }
}

/**
 * Re-emit one `InstancedMesh` as one mesh per non-empty bucket, sharing its
 * geometry and material and preserving every matrix and colour. Bucket
 * membership is the only thing that decides which mesh an instance lands in, so
 * the union of the results is the original, instance for instance.
 */
function emit(
  src: THREE.InstancedMesh, parent: THREE.Object3D, bucket: Int32Array,
  counts: Int32Array, nb: number, nameBase: string, pad: number,
  m: THREE.Matrix4, col: THREE.Color, hasCol: boolean,
): THREE.InstancedMesh[] {
  const out: Array<THREE.InstancedMesh | null> = [];
  for (let s = 0; s < nb; s++) {
    if (!counts[s]) { out.push(null); continue; }
    const im = new THREE.InstancedMesh(src.geometry, src.material, counts[s]);
    im.name = `${nameBase}.${s}`;
    im.castShadow = src.castShadow;
    im.receiveShadow = src.receiveShadow;
    im.renderOrder = src.renderOrder;
    im.frustumCulled = true;
    im.count = 0;                        // doubles as the write cursor below
    out.push(im);
  }
  for (let i = 0; i < bucket.length; i++) {
    const im = out[bucket[i]];
    if (!im) continue;
    const w = im.count++;
    src.getMatrixAt(i, m);
    im.setMatrixAt(w, m);
    if (hasCol) { src.getColorAt(i, col); im.setColorAt(w, col); }
  }
  const kept: THREE.InstancedMesh[] = [];
  for (const im of out) {
    if (!im) continue;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    // The sphere is measured from instance origins; `pad` restores the body of
    // the prop standing on each one.
    if (im.boundingSphere) im.boundingSphere.radius += pad;
    parent.add(im);
    kept.push(im);
  }
  return kept;
}

/**
 * Range past which a seat stops casting. 40 m is where a 0.45 m seat back falls
 * under the far cascade's texel and the rake stops being readable — see
 * `bandSeatShadows`.
 */
const SEAT_SHADOW_DIST = 40;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Dusk begins around 19:00 and it is fully dark by 20:30. */
function nightFromHour(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 20.5 || h <= 5.0) return 1;
  if (h >= 18.6) return clamp01((h - 18.6) / 1.9);
  if (h <= 6.6) return clamp01((6.6 - h) / 1.6);
  return 0;
}
