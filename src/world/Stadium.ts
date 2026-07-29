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

  lateUpdate(dt: number, ctx: Ctx): void {
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

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Dusk begins around 19:00 and it is fully dark by 20:30. */
function nightFromHour(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 20.5 || h <= 5.0) return 1;
  if (h >= 18.6) return clamp01((h - 18.6) / 1.9);
  if (h <= 6.6) return clamp01((6.6 - h) / 1.6);
  return 0;
}
