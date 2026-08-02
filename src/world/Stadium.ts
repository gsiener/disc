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
import { Mesher, parts, strut, UNIT_BOX, type Part, type RGB, type V3 } from './stadium/Geo';
import {
  bowlRows, ringSamples, sampleSeats, seatLayout, bowlSpec,
  BOWL, ROOF, roofYAt,
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
 *             Over the west straight the cantilever is cut back to a rear
 *             canopy so the broadcast rig can rise off its 15 m seat — see
 *             `openGantryBay`, which is the reason this file is not just glue.
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

    if (!AB_DISABLE_BAY) this.openGantryBay(ctx);

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
   * ------------------------------------------------------------------------
   * THE BROADCAST GANTRY BAY — why the west canopy stops short
   * ------------------------------------------------------------------------
   *
   * The tele rig runs a dolly line at x = -42, z ∈ ±36, and it wants to be able
   * to sit *high* on it. That is not a taste call: from a 15 m seat the play
   * subtends ~43° across and ~5° up, an 8:1 angular aspect being fitted into a
   * 16:9 frame, so fitting the width spends ~29° of height on ~5° of play and
   * the surplus splits above and below. Raising the seat is the only lever that
   * moves it — y 15 → 25 took dead foreground 35.5 % → 28.6 % *and* improved
   * the framing guarantee, 98.92 % → 99.46 %.
   *
   * It could not be taken, because this building was in the way, and the
   * headless camera suite could never see that because it has no stadium:
   *
   *   y ≈ 15      clear — the rig sits in the pocket between the cross-aisle
   *               and the truss work, which is exactly where it was placed.
   *   y ≈ 18-20   the radial trusses and the purlin field. Measured with the
   *               probe: 89 % of rays to the pitch die on `roof-purlins` and
   *               `roof-trusses`.
   *   y ≈ 22-26   the camera is above the canopy looking down through it —
   *               100 % of rays die on `roof-deck`. `shots/tele-y25/live-03.png`
   *               is that frame: standing seams, no pitch.
   *   any y ≥ 18 at z ≈ ±36 — the two hung camera pods, which sat at exactly
   *               the dolly's end stops and 12 m in front of the lens.
   *
   * So the west stand gets what a venue with a broadcast contract actually has:
   * **the canopy over the main camera side is a rear canopy only.** It is cut
   * back from a 25.8 m cantilever to a 10.4 m one over the whole straight run,
   * finished with a clad edge girder, a maintenance rail and raking brackets,
   * closed at both ends where it meets the full-depth corner canopy, and the
   * camera pods rehung off the new edge — behind the lens instead of in front
   * of it. The rig now has open sky from y = 13 up.
   *
   * Three things this is careful not to do:
   *
   *   • **It does not touch the east side.** The far stand is in shot in every
   *     broadcast frame; the corners keep their full cantilever too, so the
   *     bowl still closes visually from every establishing angle.
   *   • **It does not rebuild anything.** `Roof.ts`, `Screens.ts` and
   *     `Sideline.ts` are other agents' files. The canopy, ribbon, purlins and
   *     seams are *clipped* against one convex box (`subtractBox`), the radial
   *     trusses inside the bay swap to a clipped copy of their own geometry,
   *     and the pods are translated. Every vertex that survives is the vertex
   *     those files authored.
   *   • **It does not undo the wedge/shard work.** Nothing here re-merges an
   *     InstancedMesh, and the cut *removes* triangles: 15.4 m of canopy,
   *     fascia, gutter, ribbon, purlins and seams over a 92 m run, against
   *     ~1.1 k triangles of new edge furniture.
   */
  private openGantryBay(ctx: Ctx): void {
    const box = bayBox();
    let removed = 0;

    /* --- canopy, seams, purlins, ribbon: clipped against the bay box ------ */
    const roof = this.root.getObjectByName('roof');
    const clip: THREE.Mesh[] = [];
    const want = /^(roof-deck|roof-seams|roof-purlins|roof-chords|led-ribbon)$/;
    for (const g of [roof, this.screens?.group]) {
      g?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!(m as any).isMesh || (m as any).isInstancedMesh) return;
        if (want.test(m.name) || want.test(m.geometry?.name ?? '')) clip.push(m);
      });
    }
    for (const m of clip) {
      const cut = subtractBox(m.geometry, box);
      if (!cut) continue;
      removed += cut.removed;
      m.geometry.dispose();
      m.geometry = cut.geo;
    }

    /* --- radial trusses: the ones over the bay lose their cantilever ------ */
    removed += this.stubBayTrusses(roof);

    /* --- the hung camera pods move back onto the new edge ----------------- */
    this.rehangCameraPods();

    /* --- and the cut gets a building's worth of edge --------------------- */
    this.root.add(this.buildBayEdge());

    if (ctx.debug) console.log(`[stadium] gantry bay: -${removed} triangles`);
  }

  /**
   * Swap the trusses inside the bay for a clipped copy of themselves.
   *
   * A truss is instanced, so it cannot be cut per-instance — but it is also
   * authored in local coordinates where +X *is* the outward offset from the
   * wall, so one clip of the shared geometry at `x = BAY.edgeOff` produces
   * exactly the stub the bay needs. Two InstancedMeshes come out of one: the
   * full truss everywhere else, the stub over the straight.
   */
  private stubBayTrusses(roof: THREE.Object3D | undefined): number {
    const src = roof?.getObjectByName('roof-trusses') as THREE.InstancedMesh | undefined;
    if (!src || !(src as any).isInstancedMesh) return 0;
    const m = new THREE.Matrix4();
    const keep: THREE.Matrix4[] = [], bay: THREE.Matrix4[] = [];
    for (let i = 0; i < src.count; i++) {
      src.getMatrixAt(i, m);
      const x = m.elements[12], z = m.elements[14];
      (x < -BOWL.hx + 0.5 && Math.abs(z) < BAY.halfZ - 0.01 ? bay : keep).push(m.clone());
    }
    if (!bay.length) return 0;

    // Local +X is the outward offset, so the bay box collapses to one plane.
    const local: Box = {
      min: [-1e4, -1e4, -1e4],
      max: [BAY.edgeOff, 1e4, 1e4],
    };
    const stubGeo = subtractBox(src.geometry, local);
    if (!stubGeo) return 0;

    const parent = src.parent ?? this.root;
    const emitIM = (name: string, geo: THREE.BufferGeometry, list: THREE.Matrix4[]) => {
      const im = new THREE.InstancedMesh(geo, src.material, list.length);
      im.name = name;
      im.castShadow = src.castShadow;
      im.receiveShadow = src.receiveShadow;
      im.frustumCulled = false;
      for (let i = 0; i < list.length; i++) im.setMatrixAt(i, list[i]);
      im.instanceMatrix.needsUpdate = true;
      parent.add(im);
    };
    emitIM('roof-trusses', src.geometry, keep);
    emitIM('roof-trusses.bay', stubGeo.geo, bay);
    parent.remove(src);
    return stubGeo.removed * bay.length;
  }

  /**
   * Move the two hung camera pods from the old canopy edge to the new one.
   *
   * `Sideline.ts` hangs them 2.4 m behind the *original* leading edge, at
   * x ≈ -31.5 — which after the retraction is thin air, and which was in any
   * case 10 m in front of the lens at the dolly's end stops (that pale slab
   * across `shots/gantry-before/y18-z30.png` is one of them). Nothing else the
   * touchline builds reaches 12 m, so height alone identifies them, and the
   * operators come along because they are vertices in the same buffers.
   */
  private rehangCameraPods(): void {
    const side = this.root.getObjectByName('sideline');
    if (!side) return;
    const dx = PODS.dx, dy = PODS.dy;
    // Two meshes sharing a buffer would otherwise be translated twice.
    const seen = new Set<THREE.BufferGeometry>();
    side.traverse((o) => {
      // Instanced props share one buffer across every copy — moving vertices
      // there would move all of them, so they are never candidates.
      if ((o as any).isInstancedMesh) return;
      const geo = (o as THREE.Mesh).geometry;
      const pos = geo?.attributes?.position as THREE.BufferAttribute | undefined;
      if (!pos || seen.has(geo)) return;
      seen.add(geo);
      let moved = false;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) <= PODS.pickY) continue;
        pos.setXYZ(i, pos.getX(i) + dx, pos.getY(i) + dy, pos.getZ(i));
        moved = true;
      }
      if (moved) { pos.needsUpdate = true; geo.computeBoundingSphere(); }
    });
  }

  /**
   * The edge the cut leaves behind, so it reads as a building and not a hole.
   *
   * Clad edge girder capping the exposed deck sandwich, a maintenance rail on
   * top of it, raking brackets back under the retained canopy, and a closure
   * panel at each end where the retracted straight meets the full-depth corner.
   * All of it is behind the lens from every seat on the dolly line, so it is
   * one small welded mesh and one steel mesh — about 1.1 k triangles.
   */
  private buildBayEdge(): THREE.Group {
    const g = new THREE.Group();
    g.name = 'bay-gantry';

    const xEdge = -(BOWL.hx + BAY.edgeOff);          // -44.5
    const xFront = -(BOWL.hx + ROOF.frontOff);       // -29.1
    const yU = roofYAt(BAY.edgeOff);                 // retained soffit
    const yT = yU + ROOF.thickness;
    const yUF = ROOF.frontY, yTF = ROOF.frontY + ROOF.thickness;
    const hz = BAY.halfZ;
    const CLAD: RGB = [0.60, 0.61, 0.63];
    const SOFFIT: RGB = [0.50, 0.51, 0.53];

    const M = new Mesher();
    // Edge girder: a 2.0 m deep clad band across the cut face, standing a
    // little proud of the deck so it throws its own shadow line under the
    // canopy the way the original fascia did.
    M.box(xEdge - 0.42, (yU - 1.20 + yT) / 2, 0,
      0.94, yT - (yU - 1.20), hz * 2, 0.55, CLAD);
    // Bottom flange, and a capping upstand that hides the top-skin edge.
    M.box(xEdge - 0.42, yU - 1.28, 0, 1.34, 0.20, hz * 2, 0.55, SOFFIT);
    M.box(xEdge - 0.62, yT + 0.13, 0, 0.52, 0.26, hz * 2, 0.55, SOFFIT);

    // Closure panels where the retracted straight meets the corner canopy.
    // Without these the cut is an open sandwich seen from the corner seats.
    const A: V3 = [xFront, yUF, hz], D: V3 = [xFront, yTF, hz];
    const C: V3 = [xEdge, yT, hz], B: V3 = [xEdge, yU, hz];
    const uv = [0, 0, 0, 1, 8, 1, 8, 0];
    M.quad(A, D, C, B, uv, [0.8, 1, 1, 0.8], SOFFIT);
    const at = (p: V3): V3 => [p[0], p[1], -p[2]];
    M.quad(at(B), at(C), at(D), at(A), uv, [0.8, 1, 1, 0.8], SOFFIT);

    const clad = new THREE.Mesh(M.build('bay-edge'), this.mats.roofDeck);
    clad.name = 'bay-edge';
    clad.castShadow = true;
    clad.receiveShadow = true;
    g.add(clad);

    /* -------------------------------------------------- steel: rail + ribs */
    const steel: Part[] = [];
    const RAIL: RGB = [0.62, 0.64, 0.67];
    const RIB: RGB = [0.55, 0.57, 0.60];
    const yRail = yT + 0.26;
    const xRail = xEdge - 0.62;
    // Maintenance rail along the top of the girder: two runs plus stanchions.
    for (const h of [1.05, 0.55]) {
      steel.push({
        ...strut([xRail, yRail + h, -hz], [xRail, yRail + h, hz], 0.055, UNIT_BOX),
        color: RAIL,
      });
    }
    const posts = Math.round((hz * 2) / 3.2);
    for (let i = 0; i <= posts; i++) {
      const z = -hz + (i / posts) * hz * 2;
      steel.push({
        ...strut([xRail, yRail, z], [xRail, yRail + 1.05, z], 0.05, UNIT_BOX),
        color: RAIL,
      });
    }
    // Raking brackets back under the retained canopy, on the truss module.
    const ribs = Math.round((hz * 2) / 6.8);
    for (let i = 0; i <= ribs; i++) {
      const z = -hz + (i / ribs) * hz * 2;
      steel.push({
        ...strut([xEdge - 0.9, yU - 1.15, z], [xEdge - 4.6, yU - 0.25, z], 0.17, UNIT_BOX),
        color: RIB,
      });
      steel.push({
        ...strut([xEdge - 0.9, yU - 1.15, z], [xEdge - 0.9, yU - 0.15, z], 0.14, UNIT_BOX),
        color: RIB,
      });
    }
    const rail = new THREE.Mesh(parts(steel, 'bay-steel'), this.mats.steelDark);
    rail.name = 'bay-steel';
    rail.castShadow = false;
    rail.receiveShadow = true;
    g.add(rail);

    return g;
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

/* ========================================================== the gantry bay */

/** Flip to photograph the venue with the bay closed again, for an A/B. */
const AB_DISABLE_BAY = false;

/**
 * Where the west canopy stops, and how much air the rig gets.
 *
 * `edgeOff` is the only number with a constraint behind it. The dolly line sits
 * at outward offset 18.5 (x = -42), and a camera at the top of the corridor has
 * to be in open sky *at its own offset*, not merely see past the leading edge —
 * so the cut has to run past the rig, not up to it. 21.0 leaves 2.5 m of
 * clearance behind the highest seat and still keeps a 10.4 m canopy over the
 * back rows, with the column line at offset 30.6 carrying it.
 *
 * `halfZ` is the straight run of the -X side exactly (`hz - cornerR`). Ending
 * the bay on the tangent point is both the right architecture — that is where a
 * real building puts the movement joint — and the right optics: at z = ±36 with
 * the lens at its 30° stop the frame edge reaches z ≈ ±46 at the old leading
 * edge, which is precisely where the corner arc begins.
 */
const BAY = {
  edgeOff: 21.0,
  halfZ: BOWL.hz - BOWL.cornerR,
  /** Floor of the cut. The lowest thing the canopy carries is at 16.57 m. */
  floorY: 12.8,
} as const;

/** Where the hung camera pods go, and what identifies them. */
const PODS = {
  /** Nothing else the touchline builds gets within 8 m of this. */
  pickY: 12.0,
  dx: -15.5,
  dy: 2.16,
} as const;

interface Box { min: [number, number, number]; max: [number, number, number] }

/** The volume the bay removes, in world space. */
function bayBox(): Box {
  return {
    min: [-(BOWL.hx + BAY.edgeOff), BAY.floorY, -BAY.halfZ],
    max: [-20, 40, BAY.halfZ],
  };
}

/** position / normal / uv / colour for one vertex, flat. */
type Vtx = number[];
const VN = 11;

/**
 * Subtract an axis-aligned box from a triangle soup.
 *
 * Six half-space splits in sequence: whatever falls *outside* a plane is kept
 * immediately, whatever falls inside is passed to the next plane, and whatever
 * survives all six was inside the box and is dropped. Triangles whose own AABB
 * misses the box skip the whole thing and keep their original indices, so the
 * source vertex buffer survives intact and only the handful of triangles the
 * cut actually crosses get new vertices.
 *
 * Returns null when the box misses the geometry entirely.
 */
function subtractBox(src: THREE.BufferGeometry, box: Box): { geo: THREE.BufferGeometry; removed: number } | null {
  const pos = src.attributes.position as THREE.BufferAttribute | undefined;
  const idx = src.index;
  if (!pos || !idx) return null;
  const bs = src.boundingSphere ?? (src.computeBoundingSphere(), src.boundingSphere);
  if (bs) {
    const c = bs.center, r = bs.radius;
    if (c.x + r < box.min[0] || c.x - r > box.max[0]
      || c.y + r < box.min[1] || c.y - r > box.max[1]
      || c.z + r < box.min[2] || c.z - r > box.max[2]) return null;
  }

  const nrm = src.attributes.normal as THREE.BufferAttribute | undefined;
  const uv = src.attributes.uv as THREE.BufferAttribute | undefined;
  const col = src.attributes.color as THREE.BufferAttribute | undefined;
  const base = pos.count;
  const out: number[] = [];
  const extra: Vtx[] = [];
  let removed = 0;

  const read = (i: number): Vtx => [
    pos.getX(i), pos.getY(i), pos.getZ(i),
    nrm ? nrm.getX(i) : 0, nrm ? nrm.getY(i) : 1, nrm ? nrm.getZ(i) : 0,
    uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0,
    col ? col.getX(i) : 1, col ? col.getY(i) : 1, col ? col.getZ(i) : 1,
  ];

  // Plane k: axis a, sign s, value v. "Inside" is s * (p[a] - v) <= 0, so the
  // six of them together are exactly the closed box.
  const planes: [number, number, number][] = [
    [0, -1, box.min[0]], [0, 1, box.max[0]],
    [1, -1, box.min[1]], [1, 1, box.max[1]],
    [2, -1, box.min[2]], [2, 1, box.max[2]],
  ];

  const push = (t: Vtx[]) => {
    for (const v of t) { out.push(base + extra.length); extra.push(v); }
  };

  const a3: Vtx[] = [], keepQ: Vtx[][] = [], nextQ: Vtx[][] = [];
  for (let i = 0; i < idx.count; i += 3) {
    const i0 = idx.getX(i), i1 = idx.getX(i + 1), i2 = idx.getX(i + 2);
    const x0 = pos.getX(i0), y0 = pos.getY(i0), z0 = pos.getZ(i0);
    const x1 = pos.getX(i1), y1 = pos.getY(i1), z1 = pos.getZ(i1);
    const x2 = pos.getX(i2), y2 = pos.getY(i2), z2 = pos.getZ(i2);
    if (Math.min(x0, x1, x2) >= box.max[0] || Math.max(x0, x1, x2) <= box.min[0]
      || Math.min(y0, y1, y2) >= box.max[1] || Math.max(y0, y1, y2) <= box.min[1]
      || Math.min(z0, z1, z2) >= box.max[2] || Math.max(z0, z1, z2) <= box.min[2]) {
      out.push(i0, i1, i2);
      continue;
    }
    a3.length = 0;
    a3.push(read(i0), read(i1), read(i2));
    keepQ.length = 0;
    keepQ.push(a3.slice());
    for (const [ax, sg, val] of planes) {
      nextQ.length = 0;
      for (const t of keepQ) splitTri(t, ax, sg, val, push, nextQ);
      keepQ.length = 0;
      for (const t of nextQ) keepQ.push(t);
      if (!keepQ.length) break;
    }
    removed += keepQ.length;     // pieces that were inside every plane
  }

  const n = base + extra.length;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(grow(pos, extra, 0, 3, n), 3));
  if (nrm) geo.setAttribute('normal', new THREE.Float32BufferAttribute(grow(nrm, extra, 3, 3, n), 3));
  if (uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(grow(uv, extra, 6, 2, n), 2));
  if (col) geo.setAttribute('color', new THREE.Float32BufferAttribute(grow(col, extra, 8, 3, n), 3));
  geo.setIndex(out);
  geo.computeBoundingSphere();
  geo.name = src.name;
  return { geo, removed };
}

/** Original attribute followed by the clip's new vertices, as one array. */
function grow(
  src: THREE.BufferAttribute, extra: Vtx[], off: number, size: number, n: number,
): Float32Array {
  const a = new Float32Array(n * size);
  for (let i = 0; i < src.count; i++) {
    a[i * size] = src.getX(i);
    if (size > 1) a[i * size + 1] = src.getY(i);
    if (size > 2) a[i * size + 2] = src.getZ(i);
  }
  for (let k = 0; k < extra.length; k++) {
    const b = (src.count + k) * size;
    for (let c = 0; c < size; c++) a[b + c] = extra[k][off + c];
  }
  return a;
}

/**
 * Split one triangle by one axis-aligned plane. Pieces on the outside go
 * straight to `keep`; pieces on the inside go to `inside` for the next plane.
 */
function splitTri(
  t: Vtx[], ax: number, sg: number, val: number,
  keep: (t: Vtx[]) => void, inside: Vtx[][],
): void {
  const f0 = sg * (t[0][ax] - val), f1 = sg * (t[1][ax] - val), f2 = sg * (t[2][ax] - val);
  const n = (f0 > 0 ? 1 : 0) + (f1 > 0 ? 1 : 0) + (f2 > 0 ? 1 : 0);
  if (n === 0) { inside.push(t); return; }
  if (n === 3) { keep(t); return; }

  // Rotate so the odd-one-out is first; winding is preserved by rotation.
  const f = [f0, f1, f2];
  let k = 0;
  for (let i = 0; i < 3; i++) if ((f[i] > 0) === (n === 1)) k = i;
  const L = t[k], A = t[(k + 1) % 3], B = t[(k + 2) % 3];
  const fL = f[k], fA = f[(k + 1) % 3], fB = f[(k + 2) % 3];
  const P = mixV(L, A, fL / (fL - fA));
  const Q = mixV(L, B, fL / (fL - fB));
  if (n === 1) { keep([L, P, Q]); inside.push([P, A, B], [P, B, Q]); }
  else { inside.push([L, P, Q]); keep([P, A, B]); keep([P, B, Q]); }
}

function mixV(a: Vtx, b: Vtx, t: number): Vtx {
  const o = new Array<number>(VN);
  for (let i = 0; i < VN; i++) o[i] = a[i] + (b[i] - a[i]) * t;
  return o;
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
