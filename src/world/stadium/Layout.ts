import type { QualitySettings } from '../../core/Ctx';

/**
 * ============================================================================
 *  STADIUM LAYOUT — the single source of truth for where the venue is.
 * ============================================================================
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
 *   • `sampleSeats()` yields seat positions + facing for the Crowd system, so
 *     spectators land on the seats that are actually there (aisles, vomitories
 *     and the front kerb are already excluded).
 *
 * Plan geometry is a rounded rectangle ("the bowl"). Rows are exact outward
 * Minkowski offsets of that rectangle, so row r is simply the same rounded rect
 * with (hx, hz, r) each grown by r * rowDepth. That makes seat placement,
 * step ribbons, the roof ring and the LED ring all share one parameterisation.
 */

/* ------------------------------------------------------------------ field */

/** Regulation: 100 × 37 with 18 m endzones. Origin at field centre, Y up. */
export const FIELD = { halfW: 18.5, halfL: 50, endzone: 18 } as const;

/* ------------------------------------------------------------------- bowl */

export const BOWL = {
  /** Inner face of the perimeter wall, X and Z half-extents, plan corner radius. */
  hx: 24.0,
  hz: 55.0,
  cornerR: 12.0,
  /** Top of the pitch-side perimeter wall (LED boards sit against it). */
  wallY: 1.22,
  /** Tread depth of one seating row. */
  rowDepth: 0.94,
  /** Seat-to-seat spacing along a row. */
  seatPitch: 0.56,
  /** Deck height of row 0. */
  firstRowY: 1.46,
  /** Riser height at the first row → at the last row (rake steepens with row). */
  riseNear: 0.27,
  riseFar: 0.66,
  /** Gangway between the wall and row 0. */
  frontGap: 1.5,
} as const;

export function bowlRows(q: QualitySettings): number {
  switch (q.tier) {
    case 'low': return 17;
    case 'medium': return 23;
    case 'high': return 28;
    default: return 30;
  }
}

/** Ring tessellation (samples around the plan outline) for the deck ribbons. */
export function ringSamples(q: QualitySettings): number {
  switch (q.tier) {
    case 'low': return 132;
    case 'medium': return 200;
    case 'high': return 280;
    default: return 340;
  }
}

/** Riser height between row i and row i+1. */
export function rowRise(i: number, rows: number): number {
  const t = rows > 1 ? i / (rows - 1) : 0;
  return BOWL.riseNear + (BOWL.riseFar - BOWL.riseNear) * t;
}

/** Deck (tread) height of row i. */
export function rowY(i: number, rows: number): number {
  let y = BOWL.firstRowY;
  for (let k = 0; k < i; k++) y += rowRise(k, rows);
  return y;
}

/** Outward offset of row i from the wall face. */
export function rowOffset(i: number): number {
  return BOWL.frontGap + i * BOWL.rowDepth;
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
 */
export const VOMS: readonly { aisle: number; row0: number; span: number; halfW: number }[] = [
  { aisle: 3, row0: 6, span: 8, halfW: 1.75 },
  { aisle: 10, row0: 6, span: 8, halfW: 1.75 },
  { aisle: 17, row0: 6, span: 8, halfW: 1.75 },
  { aisle: 24, row0: 6, span: 8, halfW: 1.75 },
  { aisle: 7, row0: 5, span: 8, halfW: 1.55 },
  { aisle: 21, row0: 5, span: 8, halfW: 1.55 },
];

/* ------------------------------------------------------------------ roof */

export const ROOF = {
  /** Outward offset of the roof's leading (cantilever) edge from the wall. */
  frontOff: 8.0,
  /** Outward offset of the rear edge, past the back of the seating deck. */
  backPad: 5.0,
  frontY: 20.4,
  backY: 27.6,
  /** Depth of the vertical fascia hung off the leading edge (ribbon board). */
  fasciaH: 1.55,
  thickness: 0.9,
  /** Number of radial trusses around the ring. */
  trusses: 44,
} as const;

export function roofBackOff(rows: number): number {
  return rowOffset(rows) + ROOF.backPad;
}

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

function tower(id: number, sxs: number, szs: number): FloodlightTower {
  const cx = sx + 0, cz = sz + 0;
  // Just outside the widest part of the bowl corner, on the 45° diagonal.
  const rad = R + rowOffset(30) + 9.5;
  const bx = (cx + rad * Math.SQRT1_2) * sxs;
  const bz = (cz + rad * Math.SQRT1_2) * szs;
  const headY = 43.5;
  return {
    id,
    base: [bx, bz],
    head: [bx * 0.955, headY, bz * 0.955],
    aim: [-sxs * 12, 0.9, -szs * 16],
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

/* ------------------------------------------------------------- jumbotrons */

export interface ScreenPlacement {
  /** Screen centre. */
  pos: readonly [number, number, number];
  /** Yaw so the screen faces the field centre. */
  yaw: number;
  w: number;
  h: number;
}

function cornerScreen(sxs: number, szs: number, w: number, h: number, y: number): ScreenPlacement {
  // Sat on the roof at the corner, clear of the canopy's trailing edge.
  const rad = R + roofBackOff(30) - 4.5;
  const px = (sx + rad * Math.SQRT1_2) * sxs;
  const pz = (sz + rad * Math.SQRT1_2) * szs;
  return { pos: [px, y, pz], yaw: Math.atan2(-px, -pz), w, h };
}

/**
 * Corner video boards, mounted on the roof so they clear the canopy from every
 * seat. The (+X,−Z) board sits dead centre of the `stadium` establishing shot.
 */
export const SCREENS: readonly ScreenPlacement[] = [
  cornerScreen(1, -1, 27, 15.2, 35.6),
  cornerScreen(-1, 1, 27, 15.2, 35.6),
  cornerScreen(1, 1, 19, 10.7, 33.4),
  cornerScreen(-1, -1, 19, 10.7, 33.4),
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

/* ------------------------------------------------- seat sampling for peers */

export interface SeatSample {
  /** Seat pan centre, world space. */
  pos: [number, number, number];
  /** Yaw such that +Z local points at the pitch. */
  yaw: number;
  row: number;
  /** Normalised base parameter — useful for banding a crowd by section. */
  t: number;
  seg: number;
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

/**
 * Every seat in the bowl, in deterministic order. The Crowd system can walk
 * this and place spectators on a subset. Seat pan top is at `pos.y`.
 */
export function sampleSeats(rows: number): SeatSample[] {
  const out: SeatSample[] = [];
  for (let r = 0; r < rows; r++) {
    const off = rowOffset(r) + BOWL.rowDepth * 0.60;
    const y = rowY(r, rows);
    walkRow(off, BOWL.seatPitch, (x, z, nx, nz, t, seg) => {
      if (inAisle(t, off) || inVom(t, r)) return;
      out.push({ pos: [x, y, z], yaw: Math.atan2(-nx, -nz), row: r, t, seg });
    });
  }
  return out;
}

export { inAisle, inVom };
