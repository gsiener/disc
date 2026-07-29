import type { QualitySettings } from '../../core/Ctx';

/**
 * ============================================================================
 *  STADIUM LAYOUT — the single source of truth for where the venue is.
 * ============================================================================
 *
 * Everything here is derived from the pitch. Change `FIELD` or `RUNOFF` and the
 * wall, the rake, the roof, the masts, the video boards and the exterior apron
 * all move together — there are no free-floating magic heights left in the
 * stadium modules.
 *
 * Other systems may import from this module (it is data + pure maths, no
 * Three.js scene graph, no side effects). In particular:
 *
 *   • `FLOODLIGHT_TOWERS` is the contract with the Lighting system.
 *     StadiumSystem draws the *hardware* (mast, lattice, fixtures, ladders,
 *     service platforms). LightingSystem creates the actual lights. Put a
 *     SpotLight at `tower.head`, aim it at `tower.aim`, and the beam will line
 *     up with the modelled fixture cluster. `fixtures` tells you how many
 *     individual lamps are modelled if you want to fan several lights out;
 *     `spread` is the half-width of the cluster in metres.
 *
 *   • `sampleSeats()` / `SEAT_LAYOUT` is the contract with the Crowd system —
 *     see "SEAT LAYOUT API" at the bottom of this file.
 *
 * ---------------------------------------------------------------------------
 * PROPORTION
 * ---------------------------------------------------------------------------
 * A real venue sits *tight* around its pitch. The numbers below are checked
 * against that, in metres:
 *
 *   pitch                 37 (X) × 100 (Z)
 *   run-off apron         5.0 m all round        → perimeter wall at ±23.5, ±55
 *   row 0 nose            2.5 m past the wall    → 7.5 m from the touchline
 *   lower tier            17 rows, 0.82 tread, 0.32→0.44 rise   (≈ 26° rake)
 *   cross-aisle           2.4 m landing, 0.85 m step up to the upper tier
 *   upper tier             9 rows, 0.86 tread, 0.52→0.66 rise   (≈ 35° rake)
 *   back row deck          ≈ 14.1 m  at 26.6 m out from the wall
 *   roof leading edge      ≈ 18.3 m, 5.6 m out — it overhangs the front rows
 *   roof trailing edge     ≈ 21.7 m, past the parapet, on an outer colonnade
 *
 * A 1.8 m player on the pitch is a shade over half a row-riser tall as seen
 * against the front rows, the mid-bowl seat (row 13) sits 7 m up and 13 m back
 * — a 22° depression on to the near touchline, which is what a real mid-tier
 * seat looks like.
 *
 * Plan geometry is a rounded rectangle ("the bowl"). Rows are exact outward
 * Minkowski offsets of that rectangle, so row r is simply the same rounded rect
 * with (hx, hz, r) each grown by that row's offset. That makes seat placement,
 * step ribbons, the roof ring and the LED ring all share one parameterisation.
 */

/* ------------------------------------------------------------------ field */

/** Regulation: 100 × 37 with 18 m endzones. Origin at field centre, Y up. */
export const FIELD = { halfW: 18.5, halfL: 50, endzone: 18 } as const;

/** Run-off apron between the painted lines and the perimeter wall. */
export const RUNOFF = { side: 5.0, end: 5.0 } as const;

/* ------------------------------------------------------------------- bowl */

export const BOWL = {
  /** Inner face of the perimeter wall, X and Z half-extents, plan corner radius. */
  hx: FIELD.halfW + RUNOFF.side,
  hz: FIELD.halfL + RUNOFF.end,
  cornerR: 9.0,
  /** Top of the pitch-side perimeter wall (LED boards sit against it). */
  wallY: 1.22,
  /** Seat-to-seat spacing along a row. */
  seatPitch: 0.55,
  /** Gangway between the wall and the nose of row 0. */
  frontGap: 2.5,
  /** Deck height of row 0. */
  firstRowY: 1.50,

  /* lower tier */
  lowerRows: 17,
  lowerTread: 0.82,
  lowerRise0: 0.32,
  lowerRise1: 0.44,

  /* cross-aisle: an extra landing depth and step-up folded into the last
   * lower-tier row, so the two tiers stay one continuous offset ribbon. */
  breakTread: 2.40,
  breakRise: 0.85,

  /* upper tier */
  upperRows: 9,
  upperTread: 0.86,
  upperRise0: 0.52,
  upperRise1: 0.66,

  /** Walkway behind the back row, then the parapet. */
  concourseW: 3.0,
  parapetH: 1.15,

  /** Mean tread — kept for peers that want one number. Prefer `rowTread(i)`. */
  rowDepth: 0.93,
} as const;

/** Total seating rows. Deliberately **not** quality dependent: the building is
 *  the same shape at every tier, only its tessellation and seat detail change. */
export const ROWS = BOWL.lowerRows + BOWL.upperRows;

/** Row index whose tread carries the cross-aisle landing. */
export const CROSS_AISLE_ROW = BOWL.lowerRows - 1;

/* ------------------------------------------------------------ rake profile */

const OFF = new Float64Array(ROWS + 2);
const YY = new Float64Array(ROWS + 2);
const TREAD = new Float64Array(ROWS + 1);
const SEAT_TREAD = new Float64Array(ROWS + 1);
const RISE = new Float64Array(ROWS + 1);

{
  const L = BOWL.lowerRows, U = BOWL.upperRows;
  for (let i = 0; i <= ROWS; i++) {
    if (i < L) {
      const t = L > 1 ? i / (L - 1) : 0;
      SEAT_TREAD[i] = BOWL.lowerTread;
      TREAD[i] = BOWL.lowerTread + (i === CROSS_AISLE_ROW ? BOWL.breakTread : 0);
      RISE[i] = BOWL.lowerRise0 + (BOWL.lowerRise1 - BOWL.lowerRise0) * t
        + (i === CROSS_AISLE_ROW ? BOWL.breakRise : 0);
    } else {
      const j = i - L;
      const t = U > 1 ? Math.min(1, j / (U - 1)) : 0;
      SEAT_TREAD[i] = BOWL.upperTread;
      TREAD[i] = BOWL.upperTread;
      RISE[i] = BOWL.upperRise0 + (BOWL.upperRise1 - BOWL.upperRise0) * t;
    }
  }
  OFF[0] = BOWL.frontGap;
  YY[0] = BOWL.firstRowY;
  for (let i = 0; i <= ROWS; i++) { OFF[i + 1] = OFF[i] + TREAD[i]; YY[i + 1] = YY[i] + RISE[i]; }
}

const clampRow = (i: number) => (i < 0 ? 0 : i > ROWS ? ROWS : i | 0);

/** Outward offset of row i's nose from the wall face. */
export function rowOffset(i: number): number { return OFF[clampRow(i)]; }
/** Deck (tread) height of row i. `rows` is accepted and ignored — the rake is fixed. */
export function rowY(i: number, _rows?: number): number { return YY[clampRow(i)]; }
/** Riser height between row i and row i+1 (includes the cross-aisle step). */
export function rowRise(i: number, _rows?: number): number { return RISE[clampRow(i)]; }
/** Full tread depth of row i, nose to nose (includes the cross-aisle landing). */
export function rowTread(i: number): number { return TREAD[clampRow(i)]; }
/** The seat-bearing part of row i's tread — never includes the landing. */
export function rowSeatDepth(i: number): number { return SEAT_TREAD[clampRow(i)]; }
/** True where the tread carries the mid-bowl walkway rather than seats behind it. */
export function isCrossAisleRow(i: number): boolean { return i === CROSS_AISLE_ROW; }

/** Deck height at the back of the last row (top of the seating). */
export const DECK_TOP_Y = YY[ROWS];
/** Outward offset of the back of the last row. */
export const OUTER_OFF = OFF[ROWS];
/** Outward offset of the outer face of the parapet. */
export const FACADE_OFF = OUTER_OFF + BOWL.concourseW + 0.30;

/** Rows are fixed; the tier only changes how finely the ribbon is tessellated. */
export function bowlRows(_q: QualitySettings): number { return ROWS; }

/** Ring tessellation (samples around the plan outline) for the deck ribbons. */
export function ringSamples(q: QualitySettings): number {
  switch (q.tier) {
    case 'low': return 152;
    case 'medium': return 208;
    case 'high': return 288;
    default: return 352;
  }
}

/* --------------------------------------------------------- plan outline */

export type SegKind = 'line' | 'arc';

export interface Seg {
  kind: SegKind;
  /** Base length (row 0 of the *wall* outline). */
  len: number;
  /** t at the start of this segment, normalised over the base perimeter. */
  t0: number;
  t1: number;
  /* line */
  ax?: number; az?: number; bx?: number; bz?: number; nx?: number; nz?: number;
  /* arc */
  cx?: number; cz?: number; a0?: number; a1?: number;
}

const hx = BOWL.hx, hz = BOWL.hz, R = BOWL.cornerR;
const sx = hx - R, sz = hz - R;   // straight half-lengths
const HALF_PI = Math.PI / 2;

function mkSegs(): Seg[] {
  const raw: Seg[] = [
    { kind: 'line', ax: hx, az: -sz, bx: hx, bz: sz, nx: 1, nz: 0, len: 2 * sz, t0: 0, t1: 0 },
    { kind: 'arc', cx: sx, cz: sz, a0: 0, a1: HALF_PI, len: R * HALF_PI, t0: 0, t1: 0 },
    { kind: 'line', ax: sx, az: hz, bx: -sx, bz: hz, nx: 0, nz: 1, len: 2 * sx, t0: 0, t1: 0 },
    { kind: 'arc', cx: -sx, cz: sz, a0: HALF_PI, a1: Math.PI, len: R * HALF_PI, t0: 0, t1: 0 },
    { kind: 'line', ax: -hx, az: sz, bx: -hx, bz: -sz, nx: -1, nz: 0, len: 2 * sz, t0: 0, t1: 0 },
    { kind: 'arc', cx: -sx, cz: -sz, a0: Math.PI, a1: 3 * HALF_PI, len: R * HALF_PI, t0: 0, t1: 0 },
    { kind: 'line', ax: -sx, az: -hz, bx: sx, bz: -hz, nx: 0, nz: -1, len: 2 * sx, t0: 0, t1: 0 },
    { kind: 'arc', cx: sx, cz: -sz, a0: 3 * HALF_PI, a1: 2 * Math.PI, len: R * HALF_PI, t0: 0, t1: 0 },
  ];
  const P = raw.reduce((s, g) => s + g.len, 0);
  let acc = 0;
  for (const g of raw) { g.t0 = acc / P; acc += g.len; g.t1 = acc / P; }
  return raw;
}

export const SEGS: readonly Seg[] = mkSegs();
export const BASE_PERIMETER = SEGS.reduce((s, g) => s + g.len, 0);

/** Segment indices by role, for placing lettering and furniture. */
export const SIDE = {
  posX: 0, cornerPXPZ: 1, posZ: 2, cornerNXPZ: 3,
  negX: 4, cornerNXNZ: 5, negZ: 6, cornerPXNZ: 7,
} as const;

export interface RingPt { x: number; z: number; nx: number; nz: number; t: number; seg: number }

/** Point on the outline offset outward by `off`, at normalised base param t. */
export function ptAt(t: number, off: number, out: RingPt): RingPt {
  const tt = t - Math.floor(t);
  let s = SEGS[SEGS.length - 1];
  let si = SEGS.length - 1;
  for (let i = 0; i < SEGS.length; i++) {
    if (tt < SEGS[i].t1) { s = SEGS[i]; si = i; break; }
  }
  const f = (tt - s.t0) / (s.t1 - s.t0);
  if (s.kind === 'line') {
    const nx = s.nx!, nz = s.nz!;
    out.x = s.ax! + (s.bx! - s.ax!) * f + nx * off;
    out.z = s.az! + (s.bz! - s.az!) * f + nz * off;
    out.nx = nx; out.nz = nz;
  } else {
    const a = s.a0! + (s.a1! - s.a0!) * f;
    const ca = Math.cos(a), sa = Math.sin(a);
    out.x = s.cx! + (R + off) * ca;
    out.z = s.cz! + (R + off) * sa;
    out.nx = ca; out.nz = sa;
  }
  out.t = tt; out.seg = si;
  return out;
}

/** Perimeter length of the outline offset outward by `off`. */
export function perimeterAt(off: number): number {
  return 4 * sz + 4 * sx + 2 * Math.PI * (R + off);
}

/**
 * Base parameters for `n` ring samples, distributed so the *offset* rows come
 * out evenly spaced rather than the base outline.
 *
 * Sampling uniformly in t is a trap on a rounded rectangle: the corner arcs are
 * a small slice of the base perimeter but grow to a 40 m radius by the back of
 * the roof, so a uniform walk leaves the corners visibly faceted while the
 * straights are over-tessellated. Weighting each segment by its length at
 * `refOff` fixes both at once. Returns n+1 values, closing on 1.
 */
export function ringTable(n: number, refOff = OUTER_OFF * 0.55): Float64Array {
  const w: number[] = [];
  let total = 0;
  for (const s of SEGS) {
    const len = s.kind === 'line' ? s.len : (R + refOff) * HALF_PI;
    w.push(len);
    total += len;
  }
  // Proportional allocation with a floor of 2 samples per segment.
  const counts = w.map((v) => Math.max(2, Math.round((v / total) * n)));
  const sum = counts.reduce((a, b) => a + b, 0);
  const out = new Float64Array(sum + 1);
  let k = 0;
  for (let si = 0; si < SEGS.length; si++) {
    const s = SEGS[si];
    for (let j = 0; j < counts[si]; j++) out[k++] = s.t0 + (s.t1 - s.t0) * (j / counts[si]);
  }
  out[k] = 1;
  return out;
}

/**
 * Walks the offset outline at constant world spacing, reporting the *base*
 * parameter t for each step so patterns (seat lettering, section numbering)
 * stay locked to the plan rather than stretching with the offset.
 */
export function walkRow(
  off: number, spacing: number,
  cb: (x: number, z: number, nx: number, nz: number, t: number, seg: number, k: number) => void,
): void {
  let k = 0;
  for (let si = 0; si < SEGS.length; si++) {
    const s = SEGS[si];
    const segLen = s.kind === 'line' ? s.len : (R + off) * HALF_PI;
    const n = Math.max(1, Math.round(segLen / spacing));
    const step = segLen / n;
    for (let j = 0; j < n; j++) {
      const f = (j + 0.5) * step / segLen;
      const t = s.t0 + (s.t1 - s.t0) * f;
      if (s.kind === 'line') {
        const nx = s.nx!, nz = s.nz!;
        cb(s.ax! + (s.bx! - s.ax!) * f + nx * off, s.az! + (s.bz! - s.az!) * f + nz * off, nx, nz, t, si, k++);
      } else {
        const a = s.a0! + (s.a1! - s.a0!) * f;
        const ca = Math.cos(a), sa = Math.sin(a);
        cb(s.cx! + (R + off) * ca, s.cz! + (R + off) * sa, ca, sa, t, si, k++);
      }
    }
  }
}

/* ------------------------------------------------- aisles and vomitories */

/** Aisle centres, in base-parameter space. Seats are cut around these. */
export const AISLE_COUNT = 28;
export const AISLES: readonly number[] = Array.from(
  { length: AISLE_COUNT }, (_, i) => (i + 0.5) / AISLE_COUNT,
);
/** Half-width of an aisle, in metres at the wall. */
export const AISLE_HALF = 0.72;

/**
 * Vomitory (tunnel) mouths. A vom replaces the treads of rows
 * [row0, row0+span) at one aisle with a flat landing, and puts a dark tunnel
 * mouth at the outer end — by then the rake has climbed far enough above the
 * landing to give the portal real headroom.
 *
 * Four open into the upper tier straight off the cross-aisle (the classic
 * "walk up out of the dark into the bowl" shot); two more sit low in the
 * lower tier, tunnelling out under the upper deck.
 */
export const VOMS: readonly { aisle: number; row0: number; span: number; halfW: number }[] = [
  { aisle: 3, row0: BOWL.lowerRows, span: 6, halfW: 1.9 },
  { aisle: 10, row0: BOWL.lowerRows, span: 6, halfW: 1.9 },
  { aisle: 17, row0: BOWL.lowerRows, span: 6, halfW: 1.9 },
  { aisle: 24, row0: BOWL.lowerRows, span: 6, halfW: 1.9 },
  { aisle: 7, row0: 8, span: 7, halfW: 1.55 },
  { aisle: 21, row0: 8, span: 7, halfW: 1.55 },
];

/** Ground-level gate portals in the outer facade, in base-parameter space. */
export const GATES: readonly number[] = [0.03, 0.16, 0.28, 0.40, 0.53, 0.66, 0.78, 0.90];

/* ------------------------------------------------------------------ roof */

/**
 * Cantilever ring canopy. Heights hang off the top of the seating rather than
 * being authored absolutely — that is what stops the roof floating in the air
 * above a shallow bowl, which is the single loudest proportion error a stadium
 * can make.
 */
export const ROOF = {
  /** Outward offset of the roof's leading (cantilever) edge from the wall. */
  frontOff: 5.6,
  /** Outward offset of the rear edge, past the parapet. */
  backPad: 1.8,
  /** Leading edge sits a storey and a half above the back row. */
  frontY: DECK_TOP_Y + 4.2,
  backY: DECK_TOP_Y + 7.6,
  /** Depth of the vertical fascia hung off the leading edge (ribbon board). */
  fasciaH: 1.40,
  thickness: 0.80,
  /** Number of radial trusses around the ring. */
  trusses: 44,
} as const;

export function roofBackOff(_rows?: number): number {
  return OUTER_OFF + BOWL.concourseW + ROOF.backPad;
}

/** Underside height of the canopy at outward offset `off`. */
export function roofYAt(off: number): number {
  const b = roofBackOff();
  const f = (off - ROOF.frontOff) / Math.max(1e-6, b - ROOF.frontOff);
  return ROOF.frontY + (ROOF.backY - ROOF.frontY) * f;
}

/** Offset at which the outer colonnade props the canopy. */
export const COLUMN_OFF = roofBackOff() - 0.8;

/* ------------------------------------------------------- floodlight towers */

export interface FloodlightTower {
  /** Stable index 0..3, corner order (+X+Z), (-X+Z), (-X-Z), (+X-Z). */
  id: number;
  /** Ground position of the mast centre. */
  base: readonly [number, number];
  /** Centre of the modelled fixture cluster — put your light source here. */
  head: readonly [number, number, number];
  /** Point the cluster is aimed at (roughly the far third of the pitch). */
  aim: readonly [number, number, number];
  /** How many individual lamp housings are modelled on the head. */
  fixtures: number;
  /** Half-width of the fixture cluster, metres. Fan multiple lights inside this. */
  spread: number;
}

/** Head height — tall enough to read as a mast, short enough that the roof
 *  still dominates the silhouette. */
const MAST_HEAD_Y = ROOF.backY + 15.0;

function tower(id: number, sxs: number, szs: number): FloodlightTower {
  // Just outside the roof's corner, on the 45° diagonal.
  const rad = R + roofBackOff() + 5.0;
  const bx = (sx + rad * Math.SQRT1_2) * sxs;
  const bz = (sz + rad * Math.SQRT1_2) * szs;
  return {
    id,
    base: [bx, bz],
    head: [bx * 0.955, MAST_HEAD_Y, bz * 0.955],
    aim: [-sxs * 10, 0.9, -szs * 14],
    fixtures: 24,
    spread: 6.2,
  };
}

/**
 * The four masts. Positions are on the corner diagonals, clear of the roof.
 * LightingSystem: create one (or a small fan of) SpotLight per entry at `head`
 * looking at `aim`. Angle ≈ 0.34 rad covers the pitch from these positions.
 */
export const FLOODLIGHT_TOWERS: readonly FloodlightTower[] = [
  tower(0, 1, 1), tower(1, -1, 1), tower(2, -1, -1), tower(3, 1, -1),
];

/** Downward tilt of a fixture cluster, derived from head height vs aim point. */
export const MAST_TILT = (() => {
  const t = FLOODLIGHT_TOWERS[0];
  const dx = t.aim[0] - t.head[0], dz = t.aim[2] - t.head[2];
  return Math.atan2(t.head[1] - t.aim[1], Math.hypot(dx, dz));
})();

/* ------------------------------------------------------------- jumbotrons */

export interface ScreenPlacement {
  /** Screen centre. */
  pos: readonly [number, number, number];
  /** Yaw so the screen faces the field centre. */
  yaw: number;
  w: number;
  h: number;
  /** Roof top-skin height directly under the screen — where its legs land. */
  baseY: number;
}

function cornerScreen(sxs: number, szs: number, w: number, h: number): ScreenPlacement {
  // Sat on the roof at the corner, over the back of the deck rather than
  // cantilevered above the bowl — a board that overhangs the seating reads as
  // a slab hanging in mid-air from every outside camera.
  const off = roofBackOff() - 3.4;
  const rad = R + off;
  const px = (sx + rad * Math.SQRT1_2) * sxs;
  const pz = (sz + rad * Math.SQRT1_2) * szs;
  const baseY = roofYAt(off) + ROOF.thickness;
  return { pos: [px, baseY + h / 2 + 0.7, pz], yaw: Math.atan2(-px, -pz), w, h, baseY };
}

/**
 * Corner video boards, mounted on the roof so they clear the canopy from every
 * seat. The (+X,−Z) board sits dead centre of the `stadium` establishing shot.
 */
export const SCREENS: readonly ScreenPlacement[] = [
  cornerScreen(1, -1, 19.5, 11.0),
  cornerScreen(-1, 1, 19.5, 11.0),
  cornerScreen(1, 1, 14.0, 7.9),
  cornerScreen(-1, -1, 14.0, 7.9),
];

/* --------------------------------------------------------------- palette */

/** Home / away club colours, reused by seats, LED boards and bunting. */
export const CLUB = {
  primary: 0x11314f,
  primaryDark: 0x0b2137,
  secondary: 0x1d5c86,
  accent: 0xd9a441,
  light: 0xdfe6ea,
  concrete: 0x9a978f,
  steel: 0xb9bcc0,
} as const;

/* ==========================================================================
 *  SEAT LAYOUT API  —  the contract with the Crowd system
 * ==========================================================================
 *
 * Stable names, in preference order. All of them are also republished on the
 * live system instance as `ctx.sys.stadium.<name>`:
 *
 *   ctx.sys.stadium.seats        SeatSample[]        every seat, world space
 *   ctx.sys.stadium.seatLayout   StadiumSeatLayout   seats + row/section structure
 *   ctx.sys.stadium.bowl         StadiumBowlSpec     the flat numeric summary
 *   ctx.sys.stadium.hasBowl      true                "I built a real deck"
 *   ctx.sys.stadium.getSeats()   / .getSeatLayout() / .getBowl()   same, as getters
 *
 * Module-level equivalents for anyone who would rather not go through `sys`:
 *
 *   import { sampleSeats, seatLayout, bowlSpec } from './stadium/Layout';
 *
 * Guarantees:
 *   • `seats` is non-empty, deterministic, and ordered row-major from row 0.
 *   • Aisles, vomitories and the front kerb are already cut out of it — every
 *     entry is a seat that physically exists in the rendered deck.
 *   • `pos` is the seat pan's *deck* height (the tread the seat stands on), not
 *     the pan top. Sit a spectator's hips ~0.44 m above it (`bowl.sitHeight`).
 *   • `yaw` is a Y rotation such that the spectator's local +Z faces the pitch.
 *   • `row` is 0 at the front. `t` is the normalised parameter round the plan
 *     (0..1, stable across rows). `seg` is the plan segment: even = straight,
 *     odd = corner arc.
 *   • Nothing here mutates after `StadiumSystem.init()` resolves.
 */

export interface SeatSample {
  /** Seat pan centre, world space. y is the deck the seat stands on. */
  pos: [number, number, number];
  /** Yaw such that +Z local points at the pitch. */
  yaw: number;
  row: number;
  /** Normalised base parameter — useful for banding a crowd by section. */
  t: number;
  seg: number;
  /** 0 for the lower tier, 1 for the upper tier. */
  tier: number;
  /** Section index 0..AISLE_COUNT-1, matching the printed section plates. */
  section: number;
}

/**
 * The flat numeric summary, shaped to match `src/world/crowd/Bowl.ts`'s
 * `BowlSpec` field-for-field so it can be adopted wholesale. Rises and treads
 * vary per row in the real deck; these are the means. Use `seatLayout.rowY[]` /
 * `rowOffset[]` if you need exact values.
 */
export interface StadiumBowlSpec {
  innerHalfX: number;
  innerHalfZ: number;
  cornerR: number;
  frontY: number;
  rowRise: number;
  rowDepth: number;
  rows: number;
  seatPitch: number;
  sitHeight: number;
  sections: number;
  aisle: number;
}

/** Hips above the deck for a seated spectator. */
export const SIT_HEIGHT = 0.44;

export function bowlSpec(): StadiumBowlSpec {
  return {
    innerHalfX: BOWL.hx + BOWL.frontGap,
    innerHalfZ: BOWL.hz + BOWL.frontGap,
    cornerR: BOWL.cornerR + BOWL.frontGap,
    frontY: BOWL.firstRowY,
    rowRise: (DECK_TOP_Y - BOWL.firstRowY) / ROWS,
    rowDepth: (OUTER_OFF - BOWL.frontGap) / ROWS,
    rows: ROWS,
    seatPitch: BOWL.seatPitch,
    sitHeight: SIT_HEIGHT,
    sections: AISLE_COUNT,
    aisle: AISLE_HALF * 2,
  };
}

export interface StadiumSeatLayout {
  /** Bump when the shape of this object changes incompatibly. */
  readonly version: 2;
  readonly spec: StadiumBowlSpec;
  readonly seats: readonly SeatSample[];
  readonly rows: number;
  readonly sections: number;
  readonly lowerRows: number;
  readonly upperRows: number;
  readonly crossAisleRow: number;
  /** Exact deck height of each row, index 0..rows (rows = top of the deck). */
  readonly rowY: readonly number[];
  /** Exact outward offset of each row's nose from the perimeter wall. */
  readonly rowOffset: readonly number[];
  /** Inner face of the perimeter wall. */
  readonly wall: { hx: number; hz: number; cornerR: number; y: number };
}

function inAisle(t: number, off: number): boolean {
  const half = AISLE_HALF / perimeterAt(off);
  for (const a of AISLES) {
    let d = Math.abs(t - a);
    if (d > 0.5) d = 1 - d;
    if (d < half) return true;
  }
  return false;
}

function inVom(t: number, row: number): boolean {
  for (const v of VOMS) {
    if (row < v.row0 || row >= v.row0 + v.span) continue;
    const c = AISLES[v.aisle % AISLES.length];
    const half = v.halfW / perimeterAt(rowOffset(v.row0));
    let d = Math.abs(t - c);
    if (d > 0.5) d = 1 - d;
    if (d < half) return true;
  }
  return false;
}

/** Section index for a base parameter — matches the printed section plates. */
export function sectionAt(t: number): number {
  const tt = t - Math.floor(t);
  return Math.min(AISLE_COUNT - 1, Math.floor(tt * AISLE_COUNT));
}

let _seats: SeatSample[] | null = null;

/**
 * Every seat in the bowl, in deterministic row-major order. The argument is
 * accepted for backwards compatibility and ignored — the rake is fixed.
 * The array is built once and shared; treat it as read-only.
 */
export function sampleSeats(_rows?: number): SeatSample[] {
  if (_seats) return _seats;
  const out: SeatSample[] = [];
  for (let r = 0; r < ROWS; r++) {
    const off = rowOffset(r) + rowSeatDepth(r) * 0.60;
    const y = rowY(r);
    const tier = r < BOWL.lowerRows ? 0 : 1;
    walkRow(off, BOWL.seatPitch, (x, z, nx, nz, t, seg) => {
      if (inAisle(t, off) || inVom(t, r)) return;
      out.push({ pos: [x, y, z], yaw: Math.atan2(-nx, -nz), row: r, t, seg, tier, section: sectionAt(t) });
    });
  }
  _seats = out;
  return out;
}

let _layout: StadiumSeatLayout | null = null;

/** The full documented seat layout. Built once, then shared. */
export function seatLayout(): StadiumSeatLayout {
  if (_layout) return _layout;
  const ys: number[] = [], offs: number[] = [];
  for (let i = 0; i <= ROWS; i++) { ys.push(rowY(i)); offs.push(rowOffset(i)); }
  _layout = {
    version: 2,
    spec: bowlSpec(),
    seats: sampleSeats(),
    rows: ROWS,
    sections: AISLE_COUNT,
    lowerRows: BOWL.lowerRows,
    upperRows: BOWL.upperRows,
    crossAisleRow: CROSS_AISLE_ROW,
    rowY: ys,
    rowOffset: offs,
    wall: { hx: BOWL.hx, hz: BOWL.hz, cornerR: BOWL.cornerR, y: BOWL.wallY },
  };
  return _layout;
}

export { inAisle, inVom };
