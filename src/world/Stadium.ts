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
import { Mesher, mat, parts, strut, UNIT_BOX, type Part, type RGB, type V3 } from './stadium/Geo';
import {
  bowlRows, ringSamples, sampleSeats, seatLayout, bowlSpec,
  BASE_PERIMETER, BOWL, FIELD, ROOF, ptAt, roofYAt,
  type RingPt, type SeatSample, type StadiumBowlSpec, type StadiumSeatLayout,
} from './stadium/Layout';
import type { Rng } from '../core/Ctx';
import { bake, canvasTexture, heightToNormal } from '../util/Tex';
import { clamp, fbm2, smoothstep, valueNoise2 } from '../util/Noise';

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
  /** Printed club / competition hoarding — see `buildBoardFurniture`. */
  private hoardMat: THREE.MeshStandardMaterial | null = null;

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
  /** Quality tier, cached at init for the pieces this file builds itself. */
  private tier: string = 'high';

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
    this.tier = ctx.quality.tier;

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

    // Both before the bay: `openGantryBay` clips the ribbon, and a clipped
    // ribbon is no longer the clean quad ribbon the re-flow reads.
    this.hoardMat = buildHoardingMaterial(ctx);
    this.resequenceBoards(ctx);
    this.resequenceRibbon(ctx);

    if (!AB_DISABLE_BAY) this.openGantryBay(ctx);

    this.restyleTouchline(ctx);
    this.weatherSeats(ctx);
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

  /* ==================================================== the perimeter boards */

  /**
   * ------------------------------------------------------------------------
   * WHY THE AD RING READ AS WALLPAPER, AND WHAT IT COST TO STOP
   * ------------------------------------------------------------------------
   *
   * `Screens.ts` bakes eight sponsors into one 4096-wide strip and maps it
   * round the ring at 48 m per pass. The ring is 298.55 m, so the strip lays
   * down 6.22 times — and the west straight alone is 92 m, i.e. **1.92 passes
   * in one frame**. A blind critic found it immediately and gave the maths:
   * "FLATLINE appears near x=270 and again near x=1230". You are not looking at
   * a touchline, you are looking at a tiled texture.
   *
   * The obvious answer is more sponsors. It is the wrong one, twice over: eight
   * more brands is eight more panels of the *same* uninterrupted 92 m band, and
   * a real ground does not have thirty sponsors — Anfield has about ten and you
   * never notice, because what you are actually seeing is
   *
   *   • **runs, not a ribbon.** Perimeter LED arrives as 1 m cabinets and is
   *     built as separate runs between the access gates, each run driven by its
   *     own player. Two adjacent runs are showing different points of the same
   *     loop, so the sequence resets at every joint.
   *   • **holes.** Gates, stretcher access, camera cut-outs. Even a 0.5 m frame
   *     upright between two runs is a hard vertical the eye latches onto and
   *     uses as a boundary.
   *
   * So the ring keeps its eight sponsors and gets cut into ten-ish runs of
   * 17–33 m, each phase-shifted at least two panels off its neighbour, with a
   * frame upright at every joint and an access gate at roughly one joint in
   * three. Across the visible straight that is four runs in four different
   * places in the loop, and the verbatim eight-brand cycle is gone.
   *
   * Nothing here re-authors a vertex. The strip's own quads are *re-flowed*:
   * split at the run boundaries, the gap sections dropped, and the surviving
   * pieces given their run's u-offset. Board height, the −0.06 m stand-off, the
   * ad-run length and the LED shader all still come from `Screens.ts` — the
   * metres-per-u figure is even recovered from the geometry rather than
   * assumed, so if that file re-tunes `AD_RUN` this follows it. If the strip
   * ever stops being a clean quad ribbon, `readQuadStrip` returns null and this
   * does nothing at all.
   */
  private resequenceBoards(ctx: Ctx): void {
    const led = this.root.getObjectByName('led-perimeter') as THREE.Mesh | undefined;
    if (!led || !(led as any).isMesh) return;
    const strip = readQuadStrip(led.geometry);
    if (!strip || strip.umax <= 1.5) return;

    // u is the ad strip's own parameter: one unit is one pass of all eight
    // panels. `Screens.ts` lays it down at t·BASE_PERIMETER/AD_RUN, so this
    // inverts to exactly its AD_RUN without importing it.
    const adRun = BASE_PERIMETER / strip.umax;
    // The far straight (+X) is the one the tele looks at all match, and it is
    // also the one a real ground breaks up most — team areas, camera positions,
    // the medical gate. Runs are shorter there, hoarding is much likelier, and
    // the panels themselves are wider: see `CELL_BUDGET`.
    const FAR: PlanZone = {
      club: 0.52, lenMin: 12, lenMax: 19, clubMin: 16, clubMax: 25, maxLit: 2,
      wide: [0.65, 0.71], narrow: [0.75, 0.82],
    };
    const NEAR: PlanZone = {
      club: 0.20, lenMin: 18, lenMax: 30, clubMin: 10, clubMax: 17, maxLit: 5,
      wide: [0.71, 0.78], narrow: [0.83, 0.90],
    };
    const plan = planBoardRuns(strip.umax, adRun, ctx.rand.fork(0xb0a2d), {
      breaks: true, zone: (u) => (strip.at(u).x > 0 ? FAR : NEAR),
    });

    const lit = plan.runs.filter((r) => !r.blank);
    const cut = reflowQuadStrip(led.geometry, strip, lit);
    const before = strip.quads;
    led.geometry.dispose();
    led.geometry = cut;

    this.root.add(this.buildBoardFurniture(plan, strip, adRun, ctx.rand.fork(0xf00d5)));
    if (ctx.debug) {
      const cells = lit.reduce((n, r) => n + r.cells, 0);
      console.log(`[stadium] boards: ${lit.length} lit runs, `
        + `${plan.runs.length - lit.length} club, ${plan.gaps.length} breaks, `
        + `${before} quads -> ${cut.index!.count / 6}, `
        + `${cells} brand cells (budget ${CELL_BUDGET})`);
    }
  }

  /**
   * The roof ribbon gets the same medicine and none of the gaps.
   *
   * The night frame is where this one shows: the ribbon runs the full fascia at
   * eye height across every wide shot, and it was laying the same eight-panel
   * strip down six times round the roof at a dead-constant pitch — two and a
   * half cycles in the establishing frame, on the one board the art direction
   * singles out as being able to "slice a frame in half".
   *
   * A ribbon is genuinely one unbroken band of cabinets, so it gets no gaps, no
   * gates and no club runs — only the partition into independently-driven
   * sections, which is how a ribbon is actually installed and controlled (one
   * section per stand, and the stands are not showing the same frame of the
   * same loop).
   *
   * ------------------------------------------------------------------------
   * PARTITIONING ALONE DID NOT DO IT, AND THE MEASUREMENT SAYS SO
   * ------------------------------------------------------------------------
   *
   * The version this replaces set sections at 30–58 m and left the panel width
   * near the strip's nominal, on the argument that "a 14 m section would be a
   * strobe at establishing distance". `tools/_ribbonprobe.mjs` on that build,
   * at the `night` framing:
   *
   *     15 cells, 8 distinct, longest in-loop run 8,
   *     FLATLINE×2 AEROGRIP×2 NIMBUS×2 HELIODYNE×2 PORTSIDE×2 VANTA×2 KESTREL×2
   *
   * "Longest in-loop run 8" is the whole eight-brand loop laid down in order
   * and then started again — the critic's original sentence about the pitch-side
   * ring, word for word, on the roof instead. Sections did not help because a
   * 58 m section at ~5.5 m a panel is ten panels: one section *by itself* runs
   * more than a full cycle, so where the sections start is irrelevant.
   *
   * Two numbers fix it and both are what a real ribbon is anyway:
   *
   *   • **Panels roughly twice as wide** (`scale` is u per metre, so a smaller
   *     number is a wider panel). A roof-fascia advert is not a 5 m tile; it is
   *     a long thin banner, often one message across a whole stand. This is the
   *     `CELL_BUDGET` arithmetic again — the only way to have fewer than eight
   *     cells in a frame is to put fewer cells in the frame.
   *   • **Sections of 20–34 m**, i.e. two or three panels each. The strobe
   *     worry was correct about *panels* and wrong about metres: at the new
   *     width a 24 m section is two adverts, which is a section, not a flicker.
   *
   * Together they take the night frame to 8 cells and an ordered run of 2.
   */
  private resequenceRibbon(ctx: Ctx): void {
    // `Screens.ts` names the ribbon's *geometry* and leaves its mesh anonymous,
    // so this cannot be a `getObjectByName`.
    let ribbon: THREE.Mesh | undefined;
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if ((m as any).isMesh && !(m as any).isInstancedMesh
        && (m.name === 'led-ribbon' || m.geometry?.name === 'led-ribbon')) ribbon = m;
    });
    if (!ribbon) return;
    const strip = readQuadStrip(ribbon.geometry);
    if (!strip || strip.umax <= 1.5) return;

    const adRun = BASE_PERIMETER / strip.umax;
    const plan = planBoardRuns(strip.umax, adRun, ctx.rand.fork(0x21bb0), {
      breaks: false,
      zone: () => ({
        club: 0, lenMin: 20, lenMax: 34, clubMin: 0, clubMax: 0, maxLit: 1e9,
        wide: [0.34, 0.40], narrow: [0.44, 0.52],
      }),
    });
    const cut = reflowQuadStrip(ribbon.geometry, strip, plan.runs);
    ribbon.geometry.dispose();
    ribbon.geometry = cut;
    if (ctx.debug) console.log(`[stadium] ribbon: ${plan.runs.length} sections`);
  }

  /**
   * What stands in the holes the re-flow leaves.
   *
   * A gap with nothing in it is a missing board, not a gate. Every joint gets
   * the frame upright a board run actually terminates in; the wide ones get a
   * gate — posts, top and mid rail, four balusters — and the two widest on the
   * far side get the pitch-side camera position that is the usual reason a
   * ground cuts its boards in the first place. All of it is dark steel against
   * a lit board, so it costs a silhouette and nothing else, and all of it welds
   * into one mesh: about 1.5 k triangles for the whole ring.
   */
  private buildBoardFurniture(
    plan: { runs: BoardRun[]; gaps: BoardGap[] }, strip: QuadStrip, adRun: number,
    rnd: Rng,
  ): THREE.Group {
    const g = new THREE.Group();
    g.name = 'board-breaks';
    const gaps = plan.gaps;
    const P: Part[] = [];
    const POST: RGB = [0.30, 0.31, 0.33];
    const RAIL: RGB = [0.42, 0.44, 0.46];
    const _p: RingPt = { x: 0, z: 0, nx: 0, nz: 0, t: 0, seg: 0 };

    // Widest-first, so "the two biggest holes on the far side" is a stable
    // choice rather than a function of where the walk happened to start.
    const cams = [...gaps]
      .filter((q) => q.wide && strip.at(0.5 * (q.u0 + q.u1)).x > 0)
      .sort((a, b) => (b.u1 - b.u0) - (a.u1 - a.u0))
      .slice(0, 2);

    for (const q of gaps) {
      const lo = strip.at(q.u0), hi = strip.at(q.u1);
      const yLo = strip.yLo, yHi = strip.yHi;
      // Uprights sit just outside the board face so they read as the frame the
      // run ends in rather than as posts standing on the pitch side of it.
      // NB `strip.at()` hands back the board's own face normal, which points
      // *inward* at the pitch; `ptAt()` below hands back the outward one.
      const push = (s: { x: number; z: number; nx: number; nz: number }, w: number) => {
        const x = s.x - s.nx * 0.10, z = s.z - s.nz * 0.10;
        P.push({ ...strut([x, 0, z], [x, yHi + 0.05, z], w, UNIT_BOX), color: POST });
        P.push({ geo: UNIT_BOX, m: mat(x, 0.015, z, 0, 0, 0, w * 3.2, 0.03, w * 3.2), color: POST });
      };
      push(lo, 0.085);
      if (!q.wide) continue;
      push(hi, 0.085);

      // Gate: two rails and four balusters across the opening. The rails run
      // corner to corner so an opening on a corner arc still closes.
      const A: V3 = [lo.x - lo.nx * 0.10, 0, lo.z - lo.nz * 0.10];
      const B: V3 = [hi.x - hi.nx * 0.10, 0, hi.z - hi.nz * 0.10];
      for (const y of [yHi + 0.02, (yLo + yHi) * 0.5]) {
        P.push({ ...strut([A[0], y, A[2]], [B[0], y, B[2]], 0.055, UNIT_BOX), color: RAIL });
      }
      for (let i = 1; i <= 4; i++) {
        const f = i / 5;
        const bx = A[0] + (B[0] - A[0]) * f, bz = A[2] + (B[2] - A[2]) * f;
        P.push({ ...strut([bx, 0.05, bz], [bx, yHi + 0.02, bz], 0.035, UNIT_BOX), color: RAIL });
      }

      if (!cams.includes(q)) continue;

      /* ---------------------------------------------- pitch-side camera pod */
      ptAt(0.5 * (q.u0 + q.u1) * adRun / BASE_PERIMETER, 0, _p);
      const cx = _p.x - _p.nx * 1.15, cz = _p.z - _p.nz * 1.15;
      const yaw = Math.atan2(-_p.nx, -_p.nz);
      // Deck + kerb: the platform a hand-held position is actually built on.
      P.push({ geo: UNIT_BOX, m: mat(cx, 0.09, cz, 0, yaw, 0, 2.0, 0.18, 1.6), color: [0.24, 0.24, 0.25] });
      P.push({ geo: UNIT_BOX, m: mat(cx, 0.20, cz, 0, yaw, 0, 2.06, 0.05, 1.66), color: [0.46, 0.47, 0.44] });
      // Tripod: three legs to a head at 1.3 m, then the body and the lens.
      const hx = cx, hz = cz, hy = 1.30;
      for (let i = 0; i < 3; i++) {
        const a = yaw + (i / 3) * Math.PI * 2 + 0.4;
        P.push({
          ...strut([hx + Math.sin(a) * 0.44, 0.18, hz + Math.cos(a) * 0.44], [hx, hy, hz], 0.045, UNIT_BOX),
          color: POST,
        });
      }
      P.push({ geo: UNIT_BOX, m: mat(hx, hy + 0.16, hz, 0, yaw, 0, 0.30, 0.26, 0.52), color: [0.12, 0.12, 0.13] });
      P.push({
        geo: UNIT_BOX,
        m: mat(hx - Math.sin(yaw) * 0.42, hy + 0.18, hz - Math.cos(yaw) * 0.42, 0, yaw, 0, 0.19, 0.19, 0.44),
        color: [0.09, 0.09, 0.10],
      });
    }

    const m = new THREE.Mesh(parts(P, 'board-breaks'), this.mats.steelDark);
    m.name = 'board-breaks';
    // Grounding a 2 m camera platform is worth one extra mesh in the cascades;
    // at `low` a 0.09 m gate post is not, and the tier that cannot afford it is
    // the tier that cannot resolve it either.
    m.castShadow = this.tier !== 'low';
    m.receiveShadow = true;
    g.add(m);

    /* ---------------------------------------------- club-livery board runs */
    // The runs the LED gave up, rebuilt as printed hoarding on exactly the same
    // footprint — same face, same height, same curve — so the ring reads as one
    // continuous line of boards of which some happen not to be selling
    // advertising.
    //
    // The first pass of this painted them: navy field, gold cap, flat. In the
    // tele frame that is a 15 m rectangle of untextured blue sitting where the
    // advertising was, which is the *same* failure the empty seating blocks were
    // pulled up for — "reads as unfinished render rather than an empty section".
    // A club board at a real ground is a printed vinyl and it says something. So
    // they get `hoardingTex`: four designs, each two 5.4 m board faces wide.
    //
    // ----------------------------------------------------------------------
    // AND THEN THE REPEAT CAME BACK, ON THE BOARDS THAT WERE MEANT TO KILL IT
    // ----------------------------------------------------------------------
    //
    // The version this replaces picked ONE design per run and tiled it, on the
    // reasoning that "a run of club hoarding at a real ground is the same board
    // bolted up ten times". Measured in the tele frame, that is false and it is
    // expensive: a 25 m run at 10.8 m per design tile lays the same *pair* of
    // board faces down 2.3 times, so `shots/stad-verify/live-00.png` reads
    //
    //     CHAMPIONSHIP SERIES · MATCH 4 · CHAMPIONSHIP SERIES · MATCH 4
    //
    // at a repeat period of ~190 px in a 1280 px frame. The critic's original
    // complaint about the LED ring was a period of ~830 px. The fix for the
    // sponsors had pushed the same failure into the hoarding that replaced
    // them, four times tighter and dead centre of frame, behind the play.
    //
    // The truthful version is that a club/competition run is a *mixture* —
    // club board, competition board, ground board, safety board — which is
    // exactly what `HOARDINGS` already holds. So the run walks board faces
    // rather than tiling design pairs, and the walk is continuous across every
    // hoarding run on the ring in ring order (`plan.runs` is ordered), so the
    // guarantee is global rather than per-run: see `faceWalk`, which cannot
    // show a face again inside six boards, i.e. ~32 m of hoarding. Hoarding is
    // about a third of the ring and the tele lens holds ~78 m of the far
    // straight, so no printed face can appear twice in one frame.
    //
    // No new texture, no new design, no extra draw call: the same eight faces,
    // indexed one at a time instead of two at a time.
    const blanks = plan.runs.filter((r) => r.blank);
    if (!blanks.length) return g;
    const M = new Mesher();
    const yLo = strip.yLo, yHi = strip.yHi;
    /** Metres of board per printed face. Eight of them exist across 4 designs. */
    const FACE = 5.4;
    const NF = HOARD_N * 2;
    const nextFace = faceWalk(rnd, NF);
    for (let bi = 0; bi < blanks.length; bi++) {
      const r = blanks[bi];
      const len = (r.u1 - r.u0) * adRun;
      // Face boundaries are quad boundaries, so u never has to jump inside a
      // quad and each print lands whole however long the run came out.
      const faces = Math.max(1, Math.round(len / FACE));
      const per = Math.max(2, Math.ceil(len / faces / 1.5));
      const du = 1 / NF;
      for (let t = 0; t < faces; t++) {
        const u0 = nextFace() / NF;
        for (let j = 0; j < per; j++) {
          const fa = (t + j / per) / faces, fb = (t + (j + 1) / per) / faces;
          const a = strip.at(r.u0 + (r.u1 - r.u0) * fa);
          const b = strip.at(r.u0 + (r.u1 - r.u0) * fb);
          const ua = u0 + du * (j / per), ub = u0 + du * ((j + 1) / per);
          // One quad for the whole board face: the cap rail, the module seams
          // and the grime are in the map now, not in the geometry.
          M.quad([a.x, yLo, a.z], [b.x, yLo, b.z], [b.x, yHi, b.z], [a.x, yHi, a.z],
            [ua, 0, ub, 0, ub, 1, ua, 1], [0.78, 0.78, 1, 1]);
          // Top return back to the wall, so the board has a thickness from the
          // elevated camera rather than reading as a sticker on the concrete.
          M.quad([a.x, yHi, a.z], [b.x, yHi, b.z],
            [b.x + b.nx * -0.16, yHi, b.z + b.nz * -0.16], [a.x + a.nx * -0.16, yHi, a.z + a.nz * -0.16],
            [ua, 0.97, ub, 0.97, ub, 1, ua, 1], [1, 1, 0.68, 0.68]);
        }
      }
    }
    const club = new THREE.Mesh(M.build('club-boards'), this.hoardMat!);
    club.name = 'club-boards';
    club.castShadow = false;
    club.receiveShadow = true;
    g.add(club);
    return g;
  }

  /* ======================================================== the touchline */

  /**
   * ------------------------------------------------------------------------
   * THIRTY-FOUR PEOPLE IN THE MATCH KIT, FOUR METRES BEHIND THE PLAY
   * ------------------------------------------------------------------------
   *
   * `Sideline.ts` is right that Ultimate is played off a line and not off a
   * bench: the whole roster stands the touchline. It dresses all of them in
   * `kits[t]`, which is the *playing* kit, byte for byte the two colourways the
   * fourteen on the pitch are wearing. Both team areas are on +X, the far side,
   * so at the tele's framing thirty-four navy and cream bodies stand in a band
   * directly behind the seven navy and seven cream bodies a viewer is trying to
   * read. A blind critic called it severe and called it correctly: it is not a
   * realism note, it costs legibility.
   *
   * The colourways themselves live in `entities/material/Tone.ts` and are not
   * this file's to change — nor should they be, they are right for the pitch.
   * What is wrong is that the touchline shares them, and the touchline is the
   * stadium's. So the squad gets dressed the way a squad on the line is
   * actually dressed at seven in the evening: a rain shell, a training top, a
   * pinnie over the kit, and only about one in five still in the jersey they
   * will play in. Everything lands under half saturation and inside a mid value
   * band, which is the palette rule the two kits and the disc are exempt from
   * and nothing else is.
   *
   * Six of the standing bodies are re-tasked as stewards: turned to face the
   * crowd, walked back to the board line and put in muted hi-viz. That is a
   * real fixture of a ground with a broadcast contract, it thins the picket at
   * the touchline, and — because a steward stands *in front of* the boards —
   * six more hard verticals land across the ad ring for free.
   *
   * Everything is done on the baked `sideline-people` buffer, which is one
   * merged static mesh: no rig is rebuilt, no body is re-posed, and the
   * triangle count does not move.
   */
  private restyleTouchline(ctx: Ctx): void {
    const mesh = this.root.getObjectByName('sideline-people') as THREE.Mesh | undefined;
    if (!mesh || !(mesh as any).isMesh) return;
    const geo = mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
    const nrm = geo.attributes.normal as THREE.BufferAttribute | undefined;
    const col = geo.attributes.color as THREE.BufferAttribute | undefined;
    if (!pos || !nrm || !col || !geo.index) return;

    const bodies = segmentBodies(geo);
    if (bodies.length < 8) return;

    // The two match kits are not named anywhere this file can reach, so they
    // are identified structurally: on the far run-off, between the goal lines,
    // the jersey colour that a dozen bodies share is a team kit and the one
    // that two bodies share is a coach, a medic or an observer.
    const near = bodies.filter((b) =>
      b.cx > FIELD.halfW && Math.abs(b.cz) < 32 && b.ymax < 2.4);
    const tally = new Map<string, number>();
    for (const b of near) tally.set(b.jersey, (tally.get(b.jersey) ?? 0) + 1);
    const kits = [...tally.entries()].filter(([, n]) => n >= 4).map(([k]) => k);
    if (!kits.length) return;

    const squad = near.filter((b) => kits.includes(b.jersey));
    const rnd = ctx.rand.fork(0x7a11);

    // Stewards come off the *standing* bodies only — a seated one walked to the
    // board line would be sitting on air — and are spread by taking every third
    // one from a random start so they do not all come out of one team's knot.
    const standing = squad.filter((b) => b.ymax - b.ymin > 1.60);
    const stewards = new Set<BodyRange>();
    for (let i = rnd.int(0, 2); i < standing.length && stewards.size < 6; i += 3) {
      stewards.add(standing[i]);
    }

    for (const b of squad) {
      const jersey = parseRGB(b.jersey), shorts = parseRGB(b.shorts);
      // Which family the replacement comes from is read off the kit's own
      // value, not off the order the two were discovered in.
      const warm = luma(jersey) > 0.25;
      const r = rnd.fork(b.v0);
      // ±9 % of value per body on top of the role, so a row of shells is a row
      // of different shells.
      const v = 0.91 + r.next() * 0.18;

      if (stewards.has(b)) {
        recolourBody(col, b, [
          [b.jersey, scaleRGB(STEWARD.jersey, v)],
          [b.shorts, STEWARD.shorts],
        ], b.skin, STEWARD.jersey);
        // Face the crowd, and stand a metre off the boards where a steward
        // stands. z is nudged so the six do not inherit the roster's spacing.
        placeBody(pos, nrm, b, BOARD_LINE_X, b.cz + r.range(-1.6, 1.6),
          Math.PI + r.range(-0.35, 0.35));
        continue;
      }

      const look = touchlineLook(pickRole(r.next()), warm, jersey, shorts, v);
      recolourBody(col, b, [[b.jersey, look.jersey], [b.shorts, look.shorts]], b.skin, look.jersey);
    }

    /* ------------------------------------ the ones the kit tally cannot see */
    // The squad is found by "a jersey colour a dozen bodies share", which is
    // the right test for a kit and blind to everything else standing on that
    // touchline. Measured on the built buffer, what it leaves behind is the
    // two loudest things in the whole band:
    //
    //   [0.520, 0.560, 0.100] ×2 at z ≈ ±0.75 — the touchline's own marshals,
    //       V 0.77 / S 0.55 in sRGB, over the palette's 50 % ceiling, standing
    //       at the halfway line on the far side, i.e. dead centre of the tele
    //       frame directly behind the play.
    //   [0.800, 0.810, 0.830] ×4 at z ≈ ±36 — white shirts at V 0.92, brighter
    //       than the disc, which §2 of the art direction wants to be the
    //       highest-value object in any daylight frame.
    //
    // Neither is a kit, so neither is `Tone.ts`'s business, and both are on a
    // buffer this file already owns. They are knocked into the same band
    // everything else on the line now sits in: the hi-viz matched to the
    // stewards so the ground has one marshal's colour rather than two, the
    // whites down to an oat that still reads as a white shirt at dusk.
    const done = new Set(squad);
    for (const b of bodies) {
      if (done.has(b) || b.cx <= FIELD.halfW || b.ymax > 2.4) continue;
      const j = parseRGB(b.jersey);
      const mx = Math.max(j[0], j[1], j[2]), mn = Math.min(j[0], j[1], j[2]);
      const sat = mx > 1e-4 ? (mx - mn) / mx : 0;
      if (sat < 0.45 && luma(j) < 0.30) continue;      // already furniture
      const v = 0.91 + rnd.next() * 0.18;
      const to = scaleRGB(sat >= 0.45 ? STEWARD.jersey : OFFICIAL_WHITE, v);
      recolourBody(col, b, [[b.jersey, to]], b.skin, to);
    }

    pos.needsUpdate = true;
    nrm.needsUpdate = true;
    col.needsUpdate = true;
    geo.computeBoundingSphere();
    if (ctx.debug) {
      console.log(`[stadium] touchline: ${squad.length} of ${bodies.length} bodies `
        + `out of match kit, ${stewards.size} re-tasked as stewards`);
    }
  }

  /* ============================================================ the seats */

  /**
   * Weather the seat bowl so an empty block reads as empty seats.
   *
   * `Bowl.ts` samples a painted seat map (club lettering, section alternation,
   * a row band) and jitters each seat ±10 % of value. That is enough structure
   * to carry the lettering and not enough to carry a *block*: a critic looking
   * at the wide shot called the unoccupied sections "bare blue seating that
   * reads as unfinished render rather than an empty section", which is the
   * flat-colour tell BRIEF.md warns about — a field with no spatial variation
   * looks like a material that has not been made yet.
   *
   * Real plastic in a bowl varies at three scales and this adds the two the map
   * cannot: a block-scale field (seats are replaced in batches and the batches
   * never match), and a bleach gradient — an outdoor bowl fades from the top
   * down, because the back rows take the evening sun square on while the front
   * rows sit in the roof's shadow all season. Per-seat scatter is widened a
   * little on top. The map's own lettering survives untouched: every term here
   * is a multiply or a pull toward the seat's own luma, so the contrast *ratio*
   * between a letter seat and its background is preserved exactly.
   */
  private weatherSeats(ctx: Ctx): void {
    const seats = this.root.getObjectByName('seats') as THREE.InstancedMesh | undefined;
    if (!seats || !(seats as any).isInstancedMesh || !seats.instanceColor) return;
    const rnd = ctx.rand.fork(0x53a7);
    const n = seats.count;
    const m = new THREE.Matrix4();
    const c = new THREE.Color();

    // A coarse hash field over (angle round the bowl × height up it). 40 × 7 is
    // ~7 m by ~2.5 m of stand per cell, i.e. the size of a re-seated block.
    const NA = 40, NR = 7;
    const field = new Float32Array(NA * NR);
    for (let i = 0; i < field.length; i++) field[i] = rnd.next();
    const grime = new Float32Array(NA * NR);
    for (let i = 0; i < grime.length; i++) grime[i] = rnd.next();

    let yTop = 1;
    for (let i = 0; i < n; i++) {
      seats.getMatrixAt(i, m);
      if (m.elements[13] > yTop) yTop = m.elements[13];
    }

    for (let i = 0; i < n; i++) {
      seats.getMatrixAt(i, m);
      const x = m.elements[12], y = m.elements[13], z = m.elements[14];
      const a = ((Math.atan2(z, x) + Math.PI) / (2 * Math.PI)) * NA;
      const rr = Math.min(NR - 1.001, (y / yTop) * NR);
      const nf = bilinearWrap(field, NA, NR, a, rr);
      const ng = bilinearWrap(grime, NA, NR, a * 1.7 + 5.3, rr * 0.6 + 2.1);

      seats.getColorAt(i, c);
      // Block value, per-seat scatter, and a touch of dirt in the low rows
      // where the crowd walks past the seat backs.
      const jitter = 0.94 + rnd.next() * 0.12;
      c.multiplyScalar((0.88 + 0.24 * nf) * jitter * (1 - 0.10 * ng * (1 - y / yTop)));
      // Bleach: pull toward the seat's own luma, never toward white, so a gold
      // letter seat fades into a paler gold and not into a grey hole.
      const bleach = clamp01((y - yTop * 0.30) / (yTop * 0.72)) * (0.10 + 0.26 * nf);
      if (bleach > 0) {
        const lum = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
        c.lerp(_grey.setRGB(lum, lum, lum), bleach);
      }
      seats.setColorAt(i, c);
    }
    seats.instanceColor.needsUpdate = true;
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
    if (this.hoardMat) {
      this.hoardMat.map?.dispose();
      this.hoardMat.normalMap?.dispose();
      this.hoardMat.roughnessMap?.dispose();
      this.hoardMat.dispose();
      this.hoardMat = null;
    }
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

/* ====================================================== board re-sequencing */

/**
 * One physically separate run of perimeter LED, with its own point in the loop.
 * `scale` is the run's panel width relative to the strip's nominal 6 m — a hire
 * fleet is not one product, and unequal panel widths are what actually kills
 * the *period* of the repeat rather than merely its phase.
 */
interface BoardRun {
  u0: number; u1: number; off: number; scale: number; blank: boolean;
  /** Which hoarding design a `blank` run is printed with. Unused when lit. */
  design: number;
  /** Brand cells this run will actually show. 0 on a `blank` run. */
  cells: number;
}
/** The hole between two runs. `wide` ones are access gates, the rest are joints. */
interface BoardGap { u0: number; u1: number; wide: boolean }

/**
 * A quad ribbon, as `Mesher.quad` emits one: four unshared vertices per quad in
 * (lo-left, lo-right, hi-right, hi-left) order, indexed 0,1,2 / 0,2,3, with u
 * running along the ribbon and v across it.
 */
interface QuadStrip {
  quads: number;
  umax: number;
  /** Per quad, the u at its leading and trailing edge. Non-decreasing. */
  ua: Float64Array;
  ub: Float64Array;
  yLo: number;
  yHi: number;
  /** Position and inward normal at a point along the ribbon. */
  at(u: number): { x: number; z: number; nx: number; nz: number };
}

/**
 * Read a geometry as a quad ribbon, or return null.
 *
 * Every assumption this makes about `Screens.ts`'s output is checked here
 * rather than trusted, because that file belongs to someone else: if the LED
 * ring is ever built some other way, `resequenceBoards` silently does nothing
 * instead of shredding it.
 */
function readQuadStrip(geo: THREE.BufferGeometry): QuadStrip | null {
  const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
  const nrm = geo.attributes.normal as THREE.BufferAttribute | undefined;
  const uv = geo.attributes.uv as THREE.BufferAttribute | undefined;
  const idx = geo.index;
  if (!pos || !nrm || !uv || !idx) return null;
  const n = pos.count / 4;
  if (!Number.isInteger(n) || n < 8 || idx.count !== n * 6) return null;

  const ua = new Float64Array(n), ub = new Float64Array(n);
  let prev = -Infinity;
  for (let k = 0; k < n; k++) {
    const b = k * 4;
    if (idx.getX(k * 6) !== b || idx.getX(k * 6 + 1) !== b + 1 || idx.getX(k * 6 + 2) !== b + 2
      || idx.getX(k * 6 + 3) !== b || idx.getX(k * 6 + 4) !== b + 2 || idx.getX(k * 6 + 5) !== b + 3) {
      return null;
    }
    const u0 = uv.getX(b), u1 = uv.getX(b + 1);
    if (uv.getX(b + 2) !== u1 || uv.getX(b + 3) !== u0) return null;
    if (uv.getY(b) !== uv.getY(b + 1) || uv.getY(b + 2) !== uv.getY(b + 3)) return null;
    if (u1 < u0 || u0 < prev - 1e-9) return null;
    prev = u0;
    ua[k] = u0; ub[k] = u1;
  }

  const at = (u: number) => {
    let k = 0;
    // Binary search for the quad whose span contains u; clamp at both ends.
    let lo = 0, hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ub[mid] < u) lo = mid + 1;
      else if (ua[mid] > u) hi = mid - 1;
      else { k = mid; break; }
      k = Math.min(n - 1, Math.max(0, lo));
    }
    const b = k * 4;
    const span = ub[k] - ua[k];
    const f = span > 1e-9 ? Math.min(1, Math.max(0, (u - ua[k]) / span)) : 0;
    return {
      x: pos.getX(b) + (pos.getX(b + 1) - pos.getX(b)) * f,
      z: pos.getZ(b) + (pos.getZ(b + 1) - pos.getZ(b)) * f,
      nx: nrm.getX(b),
      nz: nrm.getZ(b),
    };
  };

  return { quads: n, umax: ub[n - 1], ua, ub, yLo: pos.getY(0), yHi: pos.getY(3), at };
}

/**
 * Re-emit the ribbon as the given runs: quads outside every run are dropped,
 * quads straddling a boundary are split on it, and each survivor's u is shifted
 * by its run's offset. Attributes are interpolated, so a split edge carries the
 * position, normal and colour the original edge would have had there.
 */
function reflowQuadStrip(
  geo: THREE.BufferGeometry, s: QuadStrip, runs: BoardRun[],
): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute | undefined;

  const P: number[] = [], N: number[] = [], U: number[] = [], C: number[] = [], I: number[] = [];
  const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
  const put = (i0: number, i1: number, f: number, run: BoardRun) => {
    P.push(lerp(pos.getX(i0), pos.getX(i1), f), lerp(pos.getY(i0), pos.getY(i1), f),
      lerp(pos.getZ(i0), pos.getZ(i1), f));
    N.push(lerp(nrm.getX(i0), nrm.getX(i1), f), lerp(nrm.getY(i0), nrm.getY(i1), f),
      lerp(nrm.getZ(i0), nrm.getZ(i1), f));
    const u = lerp(uv.getX(i0), uv.getX(i1), f);
    U.push((u - run.u0) * run.scale + run.u0 + run.off, lerp(uv.getY(i0), uv.getY(i1), f));
    if (col) {
      C.push(lerp(col.getX(i0), col.getX(i1), f), lerp(col.getY(i0), col.getY(i1), f),
        lerp(col.getZ(i0), col.getZ(i1), f));
    }
  };

  let r = 0;
  for (let k = 0; k < s.quads; k++) {
    const u0 = s.ua[k], u1 = s.ub[k], span = u1 - u0;
    if (span <= 1e-9) continue;
    while (r < runs.length && runs[r].u1 <= u0) r++;
    for (let j = r; j < runs.length && runs[j].u0 < u1; j++) {
      const a = Math.max(u0, runs[j].u0), b = Math.min(u1, runs[j].u1);
      if (b - a <= 1e-7) continue;
      const f0 = (a - u0) / span, f1 = (b - u0) / span;
      const base = P.length / 3;
      const A = k * 4, B = A + 1, Cv = A + 2, D = A + 3;
      put(A, B, f0, runs[j]);
      put(A, B, f1, runs[j]);
      put(D, Cv, f1, runs[j]);
      put(D, Cv, f0, runs[j]);
      I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  if (col) out.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  out.setIndex(I);
  out.computeBoundingSphere();
  out.name = geo.name;
  return out;
}

/**
 * Where the runs start and stop, and which sponsor each one opens on.
 *
 * The trap here is worth writing down, because the first two attempts fell
 * straight into it. Phasing each run by a random number of panels sounds like
 * it breaks the sequence and does not: if a run is L panels long and the phase
 * steps by k, the next run opens L + k panels further round an eight-panel
 * loop, so any (L, k) whose sum lands near eight reproduces the cycle *exactly*.
 * Runs of 3–4 panels stepped by 3–5 is the worst possible choice — it is
 * tuned to L + k ≈ 8 — and the capture of it showed AEROGRIP · NIMBUS ·
 * HELIODYNE · PORTSIDE three times across one frame, which is worse than what
 * it replaced.
 *
 * So the run's *opening sponsor* is chosen directly rather than derived from a
 * phase step, and it is chosen to be none of: the sponsor this run opened on,
 * the one it closes on, or the one after that — i.e. the next run can neither
 * repeat this run nor read as it continuing. The u-offset is then solved to put
 * that sponsor on the run's leading edge.
 *
 * Two more numbers carry weight:
 *
 *   `len` 14–28 m. The tele lens sees roughly 65 m of the far straight, so this
 *   decides how many joints are *in frame* — three or four. Short runs between
 *   gates is what the camera side of a real ground looks like anyway; the long
 *   uninterrupted runs are on the side nobody photographs.
 *
 *   `scale` 0.86–1.16. Phase moves where the cycle starts and leaves its
 *   *period* alone, and the period is what the critic actually measured
 *   ("roughly 830 px"). Giving each run its own panel width means a sponsor
 *   that does turn up twice turns up at two different sizes, so there is no
 *   period left to lock on to.
 */
interface PlanOpts {
  /** Leave physical holes between runs. Off for the roof ribbon, which is one
   *  unbroken band of cabinets however many players are driving it. */
  breaks: boolean;
  /** How the ring is built where `u` falls. See `PlanZone`. */
  zone: (u: number) => PlanZone;
}

/**
 * How a stretch of the ring is built. Two of these exist: the far straight,
 * which the tele looks at all match, and everything else.
 *
 * `maxLit` is the important one. Making club hoarding a per-run coin flip left
 * the number of sponsor panels in the tele frame to luck — one draw put two
 * hoarding runs in the visible straight and measured 7 slots, the next put one
 * in and measured 11. Capping the number of *consecutive* lit runs makes the
 * far straight's structure deterministic while leaving its lengths random.
 */
interface PlanZone {
  club: number;
  lenMin: number; lenMax: number;
  clubMin: number; clubMax: number;
  /** Never more than this many lit runs in a row before hoarding. */
  maxLit: number;
  /**
   * The two panel-width bands this zone alternates between, as u per metre of
   * board — a *smaller* number is a wider panel. See `CELL_BUDGET`.
   */
  wide: [number, number];
  narrow: [number, number];
}

/**
 * ------------------------------------------------------------------------
 * WHY THE PANELS GOT WIDER AND THE HOARDING GOT LONGER
 * ------------------------------------------------------------------------
 *
 * The first pass at this attacked the *phase* of the repeat — different runs
 * opening on different sponsors, different panel widths, physical gaps — and it
 * did kill the verbatim eight-brand cycle: measured 10–12 slots and all 8 brands
 * before, 7–8 slots and 6–7 brands after. It did not kill the thing the critic
 * actually wrote down, and could not have, because that was arithmetic and not
 * phasing:
 *
 *   `tools/_boardgap.mjs` walks the built ring and reports, per sponsor, the
 *   closest two of its own panels get. Measured on that build: **35 brand cells
 *   over a 290.7 m ring**, i.e. every sponsor on the boards 4–5 times, and a
 *   worst-case spacing of **28.8 m**. Every one of the eight was under 50 m.
 *   The tele lens holds ~78 m of the far straight. A sponsor whose two nearest
 *   panels are 29 m apart is *in frame twice*, always — and it was: OBSIDIAN×2
 *   in 4 frames of 4, and `shots/stadA/live-03.png` reads FLATLINE at x≈220 and
 *   again at x≈1090, which is the critic's own sentence back again.
 *
 * The only fix is fewer cells per metre of ring, and there are exactly two
 * honest levers for that. Both are used, moderately, rather than either one
 * hard:
 *
 *   • **Wider panels.** A Premier League perimeter board is ~1 m tall and one
 *     advert spans 8–10 m of it. Ours was running 6.6 m per advert on a 1.08 m
 *     board (6.1:1); it now runs ~7.9 m on the camera side (7.3:1), which is
 *     still inside what a real board does and costs ~1.2× of horizontal stretch
 *     on type that was already stretched 1.5×.
 *   • **More club and competition hoarding, and longer runs of it.** This is
 *     free realism at a "club final, first TV deal" — a ring sold out to eight
 *     national brands the whole way round is a richer sport than this one.
 *
 * Together they take the ring from 35 cells to a target of ~26, which is ~6 in
 * the tele frame against 8 brands — enough slack for the assignment below to
 * make every visible panel a different sponsor, instead of needing a perfect
 * 8-of-8 permutation to avoid a duplicate.
 */
const CELL_BUDGET = 26;

function planBoardRuns(
  umax: number, adRun: number, rnd: Rng, o: PlanOpts,
): { runs: BoardRun[]; gaps: BoardGap[] } {
  const runs: BoardRun[] = [];
  const gaps: BoardGap[] = [];
  const N = 8;                       // sponsors in one pass of the strip
  // Open on a joint, so the ring's own wrap point is a physical break rather
  // than two runs meeting mid-sentence.
  let u = o.breaks ? rnd.range(0.45, 0.95) / adRun : 0;
  if (o.breaks) gaps.push({ u0: 0, u1: u, wide: false });
  let design = rnd.int(0, HOARD_N - 1);
  let litRun = 0;                    // lit runs since the last hoarding one
  let lit = 0;                       // lit runs emitted, for the width bands

  while (u < umax - 1e-6) {
    const z = o.zone(u);
    // A meaningful share of the ring carries club, competition or ground
    // hoarding instead of advertising, and on the camera side that share is
    // large. Two reasons, and the second is the load-bearing one:
    //
    //   • It is what this venue is. The art direction is "club final, first TV
    //     deal" — a ring sold out to eight national brands all the way round is
    //     a different, richer sport.
    //   • It is the only lever that can make the repeat go away. The strip is
    //     eight sponsors at 6 m each; the tele lens holds ~78 m of the far
    //     straight, so a *continuous* LED ring puts 13 panels in frame and 13
    //     cells drawn from 8 brands must repeat, whatever the phasing does.
    //     Measured before this: 10–12 slots, all 8 brands, 2–4 of them twice,
    //     every frame. Displacing a third of the far straight with hoarding and
    //     widening the panels is what takes the cell count under eight.
    const roll = rnd.next();
    const blank = (roll < z.club || litRun >= z.maxLit)
      && runs.length > 0 && !runs[runs.length - 1].blank;
    let len = (blank ? rnd.range(z.clubMin, z.clubMax) : rnd.range(z.lenMin, z.lenMax)) / adRun;
    // Never leave a sliver at the wrap: absorb anything under 7 m into this run.
    if ((umax - u - len) * adRun < 7) len = umax - u;
    // Alternating wide and narrow panel bands, so two runs in one frame always
    // differ in panel width by at least 12 %. Both bands sit well below 1.0:
    // scale is u per metre, so a smaller scale is a wider panel and fewer cells
    // in frame, which is the arithmetic `CELL_BUDGET` explains. The zone carries
    // the bands because the camera side wants the wider panels.
    const scale = lit % 2 === 0 ? rnd.range(z.wide[0], z.wide[1]) : rnd.range(z.narrow[0], z.narrow[1]);

    if (blank) {
      // Never the same design twice running, so two club runs either side of a
      // gate do not read as one board repeated.
      design = (design + 1 + rnd.int(0, HOARD_N - 2)) % HOARD_N;
      litRun = 0;
    } else {
      litRun++; lit++;
    }
    // How many panels this run will show. Length and panel width are drawn
    // before the sponsor, never after: the opening has to be chosen against the
    // whole span it will occupy, or a long run's tail lands on its neighbour's
    // head (VANTA · KESTREL · OBSIDIAN followed 240 px later by HELIODYNE ·
    // PORTSIDE · VANTA, which is what the first version of this measured).
    const cells = blank ? 0 : Math.max(1, Math.ceil(len * scale * N));
    runs.push({ u0: u, u1: u + len, off: 0, scale, blank, design, cells });

    u += len;
    if (u >= umax - 1e-6) break;
    if (!o.breaks) continue;
    const wide = rnd.next() < 0.30;
    const w = (wide ? rnd.range(2.1, 3.3) : rnd.range(0.42, 0.78)) / adRun;
    const end = Math.min(umax, u + w);
    gaps.push({ u0: u, u1: end, wide });
    u = end;
  }
  assignBrands(runs, umax, N);
  return { runs, gaps };
}

/**
 * Which sponsor each lit run opens on, solved *round* the ring rather than
 * along it.
 *
 * Two things the along-the-ring version got wrong, both of which put a repeat
 * in frame:
 *
 *   • **It could not see past the wrap point.** A run's score was its distance
 *     back to where each of its sponsors was last seen, in absolute u — so the
 *     first run on the ring scored every sponsor as infinitely far away, and
 *     the last run scored the first run's boards as 290 m behind it when they
 *     are physically next to it. The ring's two ends are the same place.
 *   • **It was one greedy pass.** The run that gets picked first has a free
 *     choice; the run picked last has to live with seven of them.
 *
 * So the layout is planned first and the sponsors are assigned afterwards, as a
 * Gauss–Seidel sweep: three laps of "re-pick each run against every *other*
 * run's current claim", with distances measured circularly. By the second lap
 * every run is choosing against a full ring, including the boards across the
 * wrap from it, and the choices stop moving.
 *
 * It draws no randomness, on purpose. An earlier version broke ties with
 * `rnd.int`, which consumed one draw per run and so moved every downstream
 * length, gap and club decision — the plan changed because the *brand* choice
 * changed, and the measurement swung between 7 and 11 slots for reasons that
 * had nothing to do with what was being tested.
 */
function assignBrands(runs: BoardRun[], umax: number, N: number): void {
  const lit = runs.filter((r) => !r.blank && r.cells > 0);
  if (!lit.length) return;
  /** Ring-u of the centre of a run's c-th panel. */
  const cellU = (r: BoardRun, c: number) => r.u0 + (r.u1 - r.u0) * ((c + 0.5) / r.cells);
  const open = new Int32Array(lit.length).fill(-1);
  const claims: number[][] = [];
  for (let b = 0; b < N; b++) claims.push([]);

  for (let lap = 0; lap < 3; lap++) {
    for (let i = 0; i < lit.length; i++) {
      // Everything every other run has claimed, per sponsor. Rebuilt per run so
      // this run is never scored against its own previous choice.
      for (const c of claims) c.length = 0;
      for (let j = 0; j < lit.length; j++) {
        if (j === i || open[j] < 0) continue;
        for (let c = 0; c < lit[j].cells; c++) claims[(open[j] + c) % N].push(cellU(lit[j], c));
      }
      // The sponsor the previous run closes on, so this one cannot read as it
      // simply continuing. On lap 0 the run before run 0 has not been assigned;
      // from lap 1 it wraps to the last run, which is its true neighbour.
      const p = (i + lit.length - 1) % lit.length;
      const close = open[p] < 0 ? -1 : (open[p] + lit[p].cells - 1) % N;
      open[i] = pickBrand(claims, lit[i], cellU, close, N, umax);
    }
  }
  for (let i = 0; i < lit.length; i++) {
    // Solve the offset that puts the chosen sponsor on the run's leading edge.
    lit[i].off = mod1(open[i] / N - lit[i].u0);
  }
}

/**
 * Which sponsor a run of `r.cells` panels should open on.
 *
 * A run is scored by its *worst* panel: for each panel it will show, how far
 * round the ring the nearest other board carrying that same sponsor is, and the
 * run takes the smallest of those. The best-scoring opening wins. Scoring the
 * whole span rather than the opening is what stops a long run's tail from
 * landing on the sponsor its neighbour opened with.
 *
 * Distance is circular — `ringDist` — because the ring is closed, and the frame
 * this is all for is a 78 m window on a 291 m loop that has no ends.
 *
 * Excluded outright: the panel the previous run closed on and either of its
 * neighbours in the loop, which would read as this run simply continuing it.
 */
function pickBrand(
  claims: number[][], r: BoardRun, cellU: (r: BoardRun, c: number) => number,
  close: number, N: number, umax: number,
): number {
  let best = -1, bestScore = -Infinity;
  // Scan from three past the closing panel so equal scores — which is every
  // choice on the first lap, before anything has been claimed — do not all
  // resolve to brand 0.
  const from = close < 0 ? 0 : (close + 3) % N;
  for (let k = 0; k < N; k++) {
    const b = (from + k) % N;
    if (close >= 0 && (b === close || b === (close + 1) % N || b === (close + N - 1) % N)) continue;
    let worst = Infinity;
    for (let c = 0; c < r.cells; c++) {
      const at = cellU(r, c);
      for (const p of claims[(b + c) % N]) worst = Math.min(worst, ringDist(at, p, umax));
    }
    if (worst > bestScore) { bestScore = worst; best = b; }
  }
  return best < 0 ? from : best;
}

/** Distance between two points on a closed ring of circumference `umax`. */
function ringDist(a: number, b: number, umax: number): number {
  const d = Math.abs(a - b) % umax;
  return Math.min(d, umax - d);
}

const mod1 = (v: number) => v - Math.floor(v);

/* ------------------------------------------- club & competition hoarding */

/**
 * ------------------------------------------------------------------------
 * WHY THE NON-ADVERTISING BOARDS ARE PRINTED AND NOT PAINTED
 * ------------------------------------------------------------------------
 *
 * A run that carries no LED still has to be a board. The first version of this
 * emitted a navy field with a gold cap and nothing else, and in the tele frame
 * that is a 15 m untextured rectangle sitting exactly where a viewer's eye is
 * already being asked not to look — the same "reads as unfinished render"
 * failure the empty seat blocks were criticised for, moved down a metre.
 *
 * So the hoarding gets a printed face, at the scale a printed face actually
 * has: four designs, each **two 5.4 m board panels wide**, tiled along the run.
 * Two panels per design is the cheap trick that buys eight distinct board faces
 * out of four texture slots, and tiling is not a cheat here — a run of club
 * hoarding at a real ground *is* the same board bolted up ten times.
 *
 * Aspect: a design slot is 1024 × 128 (8:1) and covers 10.8 m of a 1.08 m board
 * (10:1), so the print is stretched 1.25 × horizontally — the same order as the
 * LED strip's own 4:1 cell on a 6 m panel. Type is fitted to its box, not
 * scaled from a constant, so the long names stay inside the panel.
 *
 * Content is fictional and belongs to this venue: the club, the competition
 * already on the jumbotron, the ground, and a Spirit-of-the-Game board — which
 * is the one piece of perimeter furniture that could only be at an Ultimate
 * match, and is worth more to the frame than a ninth invented sponsor.
 */
const HOARD_N = 4;

interface HoardDesign {
  bg: string; cap: string; fg: string; dim: string;
  /** Two board faces: [headline, strapline] each. */
  left: [string, string];
  right: [string, string];
  device: 'chev' | 'ring' | 'disc' | 'bars';
}

/**
 * All four sit under the palette's 50 % saturation ceiling and inside a mid
 * value band. The boards are furniture; the kits and the disc are the only
 * things in this frame allowed to be the brightest chroma in it.
 */
const HOARDINGS: HoardDesign[] = [
  {
    bg: '#27394a', cap: '#8a7a4e', fg: '#d2d9e0', dim: '#93a3b1',
    left: ['RIVERSIDE CURRENT', 'ULTIMATE CLUB · EST 1996'],
    right: ['RVR', 'RIVER ROAD'],
    device: 'chev',
  },
  {
    bg: '#b3aea0', cap: '#2c3a4a', fg: '#232f3c', dim: '#5d6874',
    left: ['CHAMPIONSHIP SERIES', 'NATIONAL ULTIMATE'],
    right: ['MATCH 4', 'SEMI-FINAL'],
    device: 'bars',
  },
  {
    bg: '#2c3a2e', cap: '#4d6047', fg: '#c8d0c4', dim: '#8fa088',
    left: ['SPIRIT OF THE GAME', 'SELF-OFFICIATED SINCE 1968'],
    right: ['CALL YOUR OWN', 'NO REFEREES'],
    device: 'disc',
  },
  {
    bg: '#4a453e', cap: '#6d6355', fg: '#d0c8b9', dim: '#9a9082',
    left: ['RIVERSIDE PARK', 'CITY OF RIVERSIDE'],
    right: ['SUPPORTERS CLUB', 'JOIN ON THE GATE'],
    device: 'ring',
  },
];

/**
 * A continuous walk over the eight printed board faces, shared by every
 * hoarding run on the ring.
 *
 * Least-recently-used with a jittered draw: the next face is taken from the
 * three that have gone longest unseen, then sent to the back of the queue. A
 * face therefore cannot return until five other faces have been drawn, so any
 * two showings of one print are **at least six boards — about 32 m of
 * hoarding — apart**, while the order itself is never a fixed cycle.
 *
 * Why the guarantee is expressed in boards and not in metres of ring: hoarding
 * is roughly a third of the ring, so six boards of hoarding is far more than
 * 32 m of *ring*, and the tele lens holds ~78 m of the far straight. That is
 * the whole argument for this being enough.
 *
 * It is one generator across all the runs, not one per run, because the runs
 * are walked in ring order — a per-run shuffle would happily open the next run
 * on the face the last one closed with.
 */
function faceWalk(rnd: Rng, n: number): () => number {
  // Seeded with a shuffle so the ring does not always open on the same board.
  const lru: number[] = [];
  for (let i = 0; i < n; i++) lru.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = rnd.int(0, i);
    const t = lru[i]; lru[i] = lru[j]; lru[j] = t;
  }
  return () => {
    const f = lru.splice(rnd.int(0, Math.min(2, n - 1)), 1)[0];
    lru.push(f);
    return f;
  };
}

/** Draw `text` at the largest size that fits `maxW`, capped at `size`. */
function fitText(
  c: CanvasRenderingContext2D, text: string, x: number, y: number,
  maxW: number, weight: string, size: number,
): void {
  let s = size;
  const font = (px: number) => `${weight} ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  c.font = font(s);
  const w = c.measureText(text).width;
  if (w > maxW) { s = Math.max(9, Math.floor(s * (maxW / w))); c.font = font(s); }
  c.fillText(text, x, y);
}

function drawHoardFace(
  c: CanvasRenderingContext2D, d: HoardDesign, x: number, w: number, H: number,
  copy: [string, string], mirrored: boolean, rnd: Rng,
): void {
  c.save();
  c.beginPath(); c.rect(x, 0, w, H); c.clip();
  c.fillStyle = d.bg; c.fillRect(x, 0, w, H);

  // Sun on the top edge, grime in the bottom third. A board stands in the open
  // and the bottom 300 mm is what the mower throws at it all season.
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(255,255,255,0.10)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.00)');
  g.addColorStop(1, 'rgba(0,0,0,0.34)');
  c.fillStyle = g; c.fillRect(x, 0, w, H);

  // Cap rail across the top, and the shadow it drops on the print.
  const capH = Math.round(H * 0.17);
  c.fillStyle = d.cap; c.fillRect(x, 0, w, capH);
  c.fillStyle = 'rgba(0,0,0,0.30)'; c.fillRect(x, capH, w, 3);

  // Module seams — a hoarding is 1.35 m panels in a frame.
  c.fillStyle = 'rgba(0,0,0,0.22)';
  for (let s = 1; s < 4; s++) c.fillRect(Math.round(x + (w * s) / 4), capH, 2, H - capH);

  const pad = Math.round(w * 0.055);
  c.textBaseline = 'middle';
  c.textAlign = mirrored ? 'right' : 'left';
  const tx = mirrored ? x + w - pad : x + pad;
  const box = w * 0.70;
  c.fillStyle = d.fg;
  fitText(c, copy[0], tx, H * 0.52, box, '800', 46);
  c.fillStyle = d.dim;
  fitText(c, copy[1], tx, H * 0.79, box * 0.85, '600', 21);

  /* -------------------------------------------------------------- device */
  c.save();
  c.translate(mirrored ? x + w * 0.14 : x + w * 0.86, H * 0.55);
  c.strokeStyle = d.fg; c.fillStyle = d.fg;
  c.lineWidth = 5; c.lineCap = 'round'; c.lineJoin = 'round';
  c.globalAlpha = 0.85;
  if (d.device === 'chev') {
    for (let i = 0; i < 3; i++) {
      c.beginPath();
      c.moveTo(-22 + i * 9, -21); c.lineTo(-4 + i * 9, 0); c.lineTo(-22 + i * 9, 21);
      c.stroke();
    }
  } else if (d.device === 'ring') {
    c.beginPath(); c.arc(0, 0, 21, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(0, 0, 8, 0, Math.PI * 2); c.fill();
  } else if (d.device === 'disc') {
    // A disc in flight, seen edge-on: the mark this sport would actually use.
    c.beginPath(); c.ellipse(0, 0, 26, 9, -0.28, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.ellipse(0, 0, 13, 4, -0.28, 0, Math.PI * 2); c.stroke();
  } else {
    for (let i = 0; i < 4; i++) c.fillRect(-24 + i * 13, -20 + i * 4, 7, 40 - i * 8);
  }
  c.restore();

  // Vinyl wear: a faint blotch field plus three rain streaks off the cap rail.
  for (let i = 0; i < 46; i++) {
    const bu = rnd.next(), bv = rnd.next();
    const r = 4 + bu * 22;
    c.fillStyle = `rgba(0,0,0,${(0.03 + bv * 0.05).toFixed(3)})`;
    c.beginPath(); c.arc(x + bu * w, H * (0.35 + bv * 0.7), r, 0, Math.PI * 2); c.fill();
  }
  for (let i = 0; i < 3; i++) {
    const sx = x + w * (0.18 + 0.31 * i + rnd.next() * 0.1);
    const sg = c.createLinearGradient(0, capH, 0, H);
    sg.addColorStop(0, 'rgba(0,0,0,0.16)');
    sg.addColorStop(1, 'rgba(0,0,0,0.00)');
    c.fillStyle = sg;
    c.fillRect(sx, capH, 3 + (i % 2) * 2, H - capH);
  }
  c.restore();
}

/**
 * The printed face, its relief and its finish, all on one uv.
 *
 * `CanvasTexture` flips Y and `DataTexture` does not, so the canvas is authored
 * with the cap rail at the top (y = 0) and the two data maps with the cap rail
 * at v = 1. That is the only coordinate trap here and it is why the two bakes
 * below read `1 - v` rather than `v`.
 */
function buildHoardingMaterial(ctx: Ctx): THREE.MeshStandardMaterial {
  const W = 4096, H = 128;
  const face = W / HOARD_N / 2;
  const rnd = ctx.rand.fork(0x40a2d);
  const map = canvasTexture(W, H, (c) => {
    for (let d = 0; d < HOARD_N; d++) {
      const D = HOARDINGS[d];
      drawHoardFace(c, D, d * face * 2, face, H, D.left, false, rnd);
      drawHoardFace(c, D, d * face * 2 + face, face, H, D.right, true, rnd);
      // Frame upright between the two faces and at the design's own edges, so
      // a tiled run reads as bolted-up boards rather than one long print.
      c.fillStyle = 'rgba(0,0,0,0.42)';
      c.fillRect(d * face * 2 + face - 2, 0, 4, H);
      c.fillRect(d * face * 2, 0, 3, H);
    }
    // Same headroom multiply the LED strip takes, for the same reason: these
    // boards sit in the same band of the frame and must not out-read the pitch.
    c.globalCompositeOperation = 'multiply';
    c.fillStyle = '#d8d8d8';
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'source-over';
  }, { name: 'hoarding', wrap: THREE.ClampToEdgeWrapping, anisotropy: 8 });

  /* ------------------------------------------------------ relief + finish */
  const NW = 1024, NH = 64;
  const seamAt = (u: number) => {
    // Distance, in slot fractions, to the nearest panel joint: the design
    // edges, the mid upright, and the module seams inside each face.
    const s = mod1(u * HOARD_N * 8);        // 8 modules per design
    return Math.min(s, 1 - s);
  };
  const hf = new Float32Array(NW * NH);
  for (let y = 0; y < NH; y++) {
    const v = 1 - (y + 0.5) / NH;           // v = 1 at the cap rail
    for (let x = 0; x < NW; x++) {
      const u = (x + 0.5) / NW;
      let h = 0;
      if (v > 0.83) h += 0.60;              // cap rail stands proud
      if (v < 0.07) h += 0.30;              // kick rail at the foot
      h -= smoothstep(0.05, 0.0, seamAt(u)) * 0.45;
      // Vinyl bows very slightly between its fixings.
      h += Math.sin(mod1(u * HOARD_N * 8) * Math.PI) * 0.05;
      h += valueNoise2(u * 620, v * 90, 17) * 0.045;
      hf[y * NW + x] = h;
    }
  }
  const normalMap = heightToNormal(hf, NW, NH, 1.05,
    { anisotropy: 8, wrap: THREE.ClampToEdgeWrapping, name: 'hoarding-n' });

  const roughnessMap = bake((_x, _y, u, vv, out, i) => {
    const v = 1 - vv;
    // Matte print, a satin cap rail, and a rougher, dirtier bottom third.
    let r = 0.74 - (v > 0.83 ? 0.24 : 0);
    r += clamp(1 - v / 0.34, 0, 1) * 0.16;
    r += fbm2(u * 46, v * 9, { octaves: 3, seed: 61 }) * 0.06;
    out[i] = 255;
    out[i + 1] = 255 * clamp(r, 0.2, 0.98);
    out[i + 2] = 0;
    out[i + 3] = 255;
  }, {
    size: 512, height: 64, anisotropy: 8,
    wrap: THREE.ClampToEdgeWrapping, name: 'hoarding-r',
  });

  return new THREE.MeshStandardMaterial({
    map, normalMap, roughnessMap,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughness: 1, metalness: 0.03,
    vertexColors: true, name: 'hoarding',
  });
}

/* ========================================================= touchline dress */

/** One baked body inside the merged `sideline-people` buffer. */
interface BodyRange {
  v0: number; v1: number;
  cx: number; cz: number; ymin: number; ymax: number;
  /** Colour keys, exactly as they sit in the buffer. */
  skin: string; jersey: string; shorts: string;
}

const colKey = (c: THREE.BufferAttribute, v: number) =>
  `${c.getX(v)},${c.getY(v)},${c.getZ(v)}`;

function parseRGB(k: string): RGB {
  const p = k.split(',');
  return [Number(p[0]), Number(p[1]), Number(p[2])];
}

/**
 * Skin is the one tint in the touchline palette with r/g ≈ 1.93 — `Sideline.ts`
 * scales one warm base by a per-person value, so every body's skin is a unique
 * float triple inside a narrow hue band, and no kit, hair, hi-viz or prop
 * colour lands in it. That makes "a skin tint I have not seen before" an exact
 * body boundary, which nothing else in the merged buffer provides: the parts
 * are separate index blocks and the bodies are not.
 */
const isSkinRGB = (r: number, g: number, b: number) =>
  r > 0.10 && g > 1e-4 && b > 1e-4
  && r / g > 1.75 && r / g < 2.10 && g / b > 1.42 && g / b < 1.80;

/** Split the merged touchline buffer into one range per body. */
function segmentBodies(geo: THREE.BufferGeometry): BodyRange[] {
  const idx = geo.index!;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute;

  // Index blocks first — one per part builder, in emission order.
  const blocks: number[][] = [];
  let start = 0, end = 0;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    const lo = Math.min(a, b, c), hi = Math.max(a, b, c) + 1;
    if (lo >= end && end > start) { blocks.push([start, end]); start = lo; end = hi; }
    else { if (end === start) start = Math.min(start, lo); end = Math.max(end, hi); }
  }
  if (end > start) blocks.push([start, end]);

  const out: BodyRange[] = [];
  let curSkin = '';
  for (const [s, e] of blocks) {
    const r = col.getX(s), g = col.getY(s), b = col.getZ(s);
    const key = `${r},${g},${b}`;
    if (!out.length || (isSkinRGB(r, g, b) && key !== curSkin)) {
      out.push({ v0: s, v1: e, cx: 0, cz: 0, ymin: 0, ymax: 0, skin: key, jersey: '', shorts: '' });
      curSkin = key;
    } else out[out.length - 1].v1 = e;
  }

  for (const b of out) {
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    let mny = Infinity, mxy = -Infinity;
    const tally = new Map<string, number>();
    for (let v = b.v0; v < b.v1; v++) {
      const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      const k = colKey(col, v);
      if (k !== b.skin) tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    b.cx = (mnx + mxx) * 0.5; b.cz = (mnz + mxz) * 0.5;
    b.ymin = mny; b.ymax = mxy;
    // Jersey is the largest garment on a body and shorts the second; that
    // ordering is a property of the rig's own vertex budget, not of the kit.
    const rank = [...tally.entries()].sort((p, q) => q[1] - p[1]);
    b.jersey = rank[0]?.[0] ?? '';
    b.shorts = rank[1]?.[0] ?? '';
  }
  return out;
}

/**
 * Repaint one body. Listed garments are swapped outright; anything else still
 * bright enough to read as match kit at 60 m — the pale away socks are the case
 * that matters — is pulled most of the way to the new top. Skin and hair are
 * never touched.
 */
function recolourBody(
  col: THREE.BufferAttribute, b: BodyRange, swap: [string, RGB][], skin: string, top: RGB,
): void {
  const map = new Map(swap);
  for (let v = b.v0; v < b.v1; v++) {
    const k = colKey(col, v);
    const to = map.get(k);
    if (to) { col.setXYZ(v, to[0], to[1], to[2]); continue; }
    if (k === skin) continue;
    const r = col.getX(v), g = col.getY(v), bl = col.getZ(v);
    if (Math.max(r, g, bl) > 0.30) {
      col.setXYZ(v, r + (top[0] - r) * 0.6, g + (top[1] - g) * 0.6, bl + (top[2] - bl) * 0.6);
    }
  }
}

const _bodyM = new THREE.Matrix4();
const _bodyR = new THREE.Matrix4();
const _bodyV = new THREE.Vector3();

/** Rotate a body about its own vertical axis and stand it somewhere else. */
function placeBody(
  pos: THREE.BufferAttribute, nrm: THREE.BufferAttribute,
  b: BodyRange, tx: number, tz: number, yaw: number,
): void {
  _bodyR.makeRotationY(yaw);
  _bodyM.makeTranslation(tx, 0, tz).multiply(_bodyR)
    .multiply(new THREE.Matrix4().makeTranslation(-b.cx, 0, -b.cz));
  for (let v = b.v0; v < b.v1; v++) {
    _bodyV.fromBufferAttribute(pos, v).applyMatrix4(_bodyM);
    pos.setXYZ(v, _bodyV.x, _bodyV.y, _bodyV.z);
    _bodyV.fromBufferAttribute(nrm, v).transformDirection(_bodyR);
    nrm.setXYZ(v, _bodyV.x, _bodyV.y, _bodyV.z);
  }
  b.cx = tx; b.cz = tz;
}

const luma = (c: RGB) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
const scaleRGB = (c: RGB, s: number): RGB => [c[0] * s, c[1] * s, c[2] * s];
/** Pull a colour toward its own grey — desaturates without shifting value. */
function mute(c: RGB, k: number): RGB {
  const l = luma(c);
  return [c[0] + (l - c[0]) * k, c[1] + (l - c[1]) * k, c[2] + (l - c[2]) * k];
}

/**
 * What is actually worn on a touchline at seven in the evening, weighted the
 * way a squad of eleven splits: a third in the rain shell, a quarter in a
 * training top, a quarter in a pinnie over the kit, and a fifth still in the
 * jersey they are about to play in. The first three are under half saturation
 * by construction; the fourth keeps the kit but at two thirds of its chroma so
 * a body on the line can never be mistaken for a body in play.
 */
function pickRole(x: number): number {
  return x < 0.30 ? 0 : x < 0.56 ? 1 : x < 0.80 ? 2 : 3;
}

function touchlineLook(
  role: number, warm: boolean, jersey: RGB, shorts: RGB, v: number,
): { jersey: RGB; shorts: RGB } {
  switch (role) {
    case 0:   // rain shell — the darkest thing on the line, so it sinks away
      return {
        jersey: scaleRGB(warm ? [0.062, 0.053, 0.046] : [0.040, 0.047, 0.066], v),
        shorts: scaleRGB([0.028, 0.029, 0.034], v),
      };
    case 1:   // heather training top
      return {
        jersey: scaleRGB(warm ? [0.150, 0.136, 0.116] : [0.098, 0.106, 0.104], v),
        shorts: scaleRGB([0.042, 0.044, 0.050], v),
      };
    case 2:
      // Pinnie over the kit — contrasts with its own team, on purpose.
      //
      // The navy team's bib used to be [0.205, 0.180, 0.080], an olive-gold. It
      // is a plausible bib on its own and it was the wrong choice next to the
      // stewards: hi-viz is [0.265, 0.305, 0.075], the same yellow-green
      // family, so seven bibs plus six stewards plus the touchline's own two
      // marshals read in the tele frame as one scattered row of thirteen
      // yellow bodies. Swapping thirty-four identical navy shirts for thirteen
      // identical olive ones is not the fix the severe note asked for.
      //
      // Brick sits opposite hi-viz on the wheel, so bibs and stewards separate
      // at 60 m, and it deliberately clears the r/g and g/b band `isSkinRGB`
      // uses to find body boundaries — see that predicate.
      return {
        jersey: scaleRGB(warm ? [0.088, 0.132, 0.126] : [0.215, 0.092, 0.070], v),
        shorts: scaleRGB(mute(shorts, 0.55), v * 0.9),
      };
    default:
      // Still in the kit they are about to play in — but knocked back, and the
      // pale kit knocked back hard. Desaturation alone does nothing to a cream
      // jersey (it has no chroma to lose), so the one lever that separates a
      // body on the line from a body in play is value: 0.55 puts it most of a
      // stop under the away team, which is what an evening shadow on the
      // run-off would do anyway.
      return {
        jersey: scaleRGB(mute(jersey, 0.34), v * (warm ? 0.55 : 0.88)),
        shorts: scaleRGB(mute(shorts, warm ? 0.50 : 0.34), v * (warm ? 0.70 : 1)),
      };
  }
}

/** Muted hi-viz. A steward has to be identifiable, not a fourth saturated thing. */
const STEWARD: { jersey: RGB; shorts: RGB } = {
  jersey: [0.265, 0.305, 0.075],
  shorts: [0.030, 0.031, 0.036],
};

/**
 * A white match shirt at seven in the evening. The touchline builds its
 * officials at V 0.92, which out-values the disc; this is the same garment two
 * stops down, where an unlit white sits on a golden-hour run-off anyway.
 */
const OFFICIAL_WHITE: RGB = [0.400, 0.402, 0.396];

/** Where a steward stands: a metre in front of the boards, back to the pitch. */
const BOARD_LINE_X = BOWL.hx - 1.0;

/* ------------------------------------------------------------- seat wear */

const _grey = new THREE.Color();

/** Bilinear sample of a coarse field, wrapping in the first axis. */
function bilinearWrap(f: Float32Array, na: number, nr: number, a: number, r: number): number {
  const a0 = Math.floor(a);
  const r0 = Math.max(0, Math.min(nr - 1, Math.floor(r)));
  const fa = a - a0;
  const fr = Math.max(0, Math.min(1, r - r0));
  const ai = ((a0 % na) + na) % na, aj = ((a0 + 1) % na + na) % na;
  const r1 = Math.min(nr - 1, r0 + 1);
  const v0 = f[r0 * na + ai] * (1 - fa) + f[r0 * na + aj] * fa;
  const v1 = f[r1 * na + ai] * (1 - fa) + f[r1 * na + aj] * fa;
  return v0 * (1 - fr) + v1 * fr;
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
