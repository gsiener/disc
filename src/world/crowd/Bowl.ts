import type { Ctx } from '../../core/Ctx';
import { fbm2, clamp, smoothstep } from '../../util/Noise';

/**
 * SHARED BOWL LAYOUT — the seat grid the crowd sits in.
 *
 * The Stadium system owns the physical bowl (decks, risers, roof, rails). The
 * crowd only needs to know *where the seats are*, so the two systems agree on
 * the constants below. Resolution order at init:
 *
 *   1. `ctx.sys.stadium.bowl`            — a partial `BowlSpec`; we adopt it.
 *   2. `ctx.sys.stadium.getBowl?.()`     — same, as a getter.
 *   3. `ctx.sys.stadium.seatLayout`      — same, alternate property name.
 *   4. the `BOWL` default below.
 *
 * If Stadium exposes nothing, Crowd also builds its own minimal seating deck
 * (see Deck.ts) so the stands are never a floating wall of people — that
 * fallback is skipped the moment Stadium advertises a bowl of any kind
 * (`bowl` / `seatLayout` / `hasBowl`), so the two never double up.
 *
 * Geometry, all metres, origin at field centre, +Z down the field:
 *
 *   field 100 (Z) x 37 (X), touchlines |x| = 18.5, back of endzone |z| = 50
 *   inner rail of the sideline stands   |x| = innerHalfX
 *   inner rail of the endline stands    |z| = innerHalfZ
 *   corners are a fillet of radius cornerR on that inner rail
 *   row k floor  y = frontY + k * rowRise, at outward offset k * rowDepth
 *   a seated spectator's hips sit `sitHeight` above their row's floor
 *   seats are laid at `seatPitch` along each row, grouped into `sections`
 *   separated by `aisle`-wide stair gaps.
 */
export interface BowlSpec {
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

export const BOWL: BowlSpec = {
  innerHalfX: 31,
  innerHalfZ: 60,
  cornerR: 16,
  frontY: 1.35,
  rowRise: 0.42,
  rowDepth: 0.92,
  rows: 30,
  seatPitch: 0.52,
  sitHeight: 0.42,
  sections: 34,
  aisle: 1.0,
};

/**
 * A seat slot, however it was sourced. `y` is the deck (tread) height — the
 * spectator's hips go SIT_HEIGHT above it.
 */
export interface SeatSet {
  n: number;
  x: Float32Array; y: Float32Array; z: Float32Array; yaw: Float32Array;
  /** 0 at the front row, 1 at the back. */
  rowT: Float32Array;
  /** Normalised parameter around the bowl, for sectioning and clustering. */
  t: Float32Array;
  corner: Float32Array;
  /** Source of the layout, for logging. */
  fromPeer: boolean;
}

/** Hips above the row's deck for a seated spectator. */
export const SIT_HEIGHT = 0.44;

/**
 * Prefers the Stadium system's own seat slots (`stadium.seats`, an array of
 * `{pos:[x,y,z], yaw, row, t, seg}`) so spectators land on seats that actually
 * exist — aisles, vomitories and the front kerb are already cut out of it.
 * Falls back to the shared BOWL layout when no stadium is present.
 */
export function peerSeats(ctx: Ctx): SeatSet | null {
  const st = ctx.sys['stadium'] as any;
  let raw: any[] | null = null;
  try {
    const s = st?.seats ?? st?.seatSlots ?? st?.getSeats?.() ?? null;
    if (Array.isArray(s) && s.length > 32) raw = s;
  } catch { raw = null; }
  if (!raw) return null;

  const n = raw.length;
  const out: SeatSet = {
    n, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
    yaw: new Float32Array(n), rowT: new Float32Array(n), t: new Float32Array(n),
    corner: new Float32Array(n), fromPeer: true,
  };
  let maxRow = 1;
  for (let i = 0; i < n; i++) maxRow = Math.max(maxRow, raw[i].row | 0);
  for (let i = 0; i < n; i++) {
    const s = raw[i];
    const p = s.pos ?? s.position ?? s;
    out.x[i] = p[0] ?? p.x ?? 0;
    out.y[i] = p[1] ?? p.y ?? 0;
    out.z[i] = p[2] ?? p.z ?? 0;
    out.yaw[i] = s.yaw ?? 0;
    out.rowT[i] = (s.row | 0) / maxRow;
    const t = typeof s.t === 'number' ? s.t : 0;
    out.t[i] = t - Math.floor(t);
    // Odd segment indices on a rounded-rect plan are the corner arcs.
    out.corner[i] = typeof s.seg === 'number' ? (s.seg & 1) : 0;
  }
  return out;
}

/** Generates a seat set from our own bowl spec (no stadium present). */
export function ownSeats(spec: BowlSpec, fit: SeatWalkOpts): SeatSet {
  const xs: number[] = [], ys: number[] = [], zs: number[] = [], ya: number[] = [];
  const rt: number[] = [], ts: number[] = [], cn: number[] = [];
  const rowsMax = Math.max(1, fit.rows - 1);
  walkSeats(spec, fit, (x, y, z, yaw, row, _sec, t, corner) => {
    xs.push(x); ys.push(y); zs.push(z); ya.push(yaw);
    rt.push(row / rowsMax); ts.push(t); cn.push(corner);
  });
  return {
    n: xs.length, x: new Float32Array(xs), y: new Float32Array(ys), z: new Float32Array(zs),
    yaw: new Float32Array(ya), rowT: new Float32Array(rt), t: new Float32Array(ts),
    corner: new Float32Array(cn), fromPeer: false,
  };
}

/** Reads a peer-supplied bowl off `ctx.sys.stadium`, falling back to BOWL. */
export function resolveBowl(ctx: Ctx): { spec: BowlSpec; fromPeer: boolean; peerHasDeck: boolean } {
  const st = ctx.sys['stadium'] as any;
  let raw: any = null;
  try {
    raw = st?.bowl ?? st?.getBowl?.() ?? st?.seatLayout ?? st?.getSeatLayout?.() ?? null;
  } catch { raw = null; }
  const peerHasDeck = !!(st && (raw || Array.isArray(st.seats) || st.hasBowl === true));
  if (!raw || typeof raw !== 'object') return { spec: { ...BOWL }, fromPeer: false, peerHasDeck };
  const spec: BowlSpec = { ...BOWL };
  for (const k of Object.keys(BOWL) as (keyof BowlSpec)[]) {
    const v = raw[k];
    if (typeof v === 'number' && isFinite(v) && v !== 0) spec[k] = v;
  }
  spec.rows = Math.max(3, Math.round(spec.rows));
  spec.sections = Math.max(6, Math.round(spec.sections));
  return { spec, fromPeer: true, peerHasDeck: true };
}

/* ------------------------------------------------------------------- path */

/** A point on a row's rounded-rectangle rail: position, outward normal, cornerness. */
export interface PathPt { x: number; z: number; nx: number; nz: number; corner: number }

export interface RowPath {
  /** Total arc length of the closed rail. */
  len: number;
  ax: number; az: number; r: number;
  /** Straight half-lengths (constant across rows because r grows with the offset). */
  xc: number; zc: number;
}

export function rowPath(s: BowlSpec, row: number): RowPath {
  const o = row * s.rowDepth;
  const ax = s.innerHalfX + o;
  const az = s.innerHalfZ + o;
  const r = s.cornerR + o;
  const xc = s.innerHalfX - s.cornerR;
  const zc = s.innerHalfZ - s.cornerR;
  const len = 4 * xc + 4 * zc + 2 * Math.PI * r;
  return { len, ax, az, r, xc, zc };
}

const HALF_PI = Math.PI / 2;

/** Arc-length lookup along a row rail. `s` in [0, len). */
export function pathAt(p: RowPath, s: number, out: PathPt): PathPt {
  const { ax, az, r, xc, zc } = p;
  const arc = r * HALF_PI;
  const straightZ = 2 * zc;
  const straightX = 2 * xc;
  let t = s % p.len;
  if (t < 0) t += p.len;

  // 1: +X straight (z: -zc -> +zc)
  if (t < straightZ) {
    out.x = ax; out.z = -zc + t; out.nx = 1; out.nz = 0; out.corner = 0; return out;
  }
  t -= straightZ;
  // 2: +X+Z arc
  if (t < arc) {
    const a = t / r;
    out.x = xc + r * Math.cos(a); out.z = zc + r * Math.sin(a);
    out.nx = Math.cos(a); out.nz = Math.sin(a); out.corner = 1; return out;
  }
  t -= arc;
  // 3: +Z straight (x: xc -> -xc)
  if (t < straightX) {
    out.x = xc - t; out.z = az; out.nx = 0; out.nz = 1; out.corner = 0; return out;
  }
  t -= straightX;
  // 4: -X+Z arc
  if (t < arc) {
    const a = HALF_PI + t / r;
    out.x = -xc + r * Math.cos(a); out.z = zc + r * Math.sin(a);
    out.nx = Math.cos(a); out.nz = Math.sin(a); out.corner = 1; return out;
  }
  t -= arc;
  // 5: -X straight (z: zc -> -zc)
  if (t < straightZ) {
    out.x = -ax; out.z = zc - t; out.nx = -1; out.nz = 0; out.corner = 0; return out;
  }
  t -= straightZ;
  // 6: -X-Z arc
  if (t < arc) {
    const a = Math.PI + t / r;
    out.x = -xc + r * Math.cos(a); out.z = -zc + r * Math.sin(a);
    out.nx = Math.cos(a); out.nz = Math.sin(a); out.corner = 1; return out;
  }
  t -= arc;
  // 7: -Z straight (x: -xc -> xc)
  if (t < straightX) {
    out.x = -xc + t; out.z = -az; out.nx = 0; out.nz = -1; out.corner = 0; return out;
  }
  t -= straightX;
  // 8: +X-Z arc
  const a = 3 * HALF_PI + t / r;
  out.x = xc + r * Math.cos(a); out.z = -zc + r * Math.sin(a);
  out.nx = Math.cos(a); out.nz = Math.sin(a); out.corner = 1;
  return out;
}

/* ------------------------------------------------------------------ seats */

export interface SeatWalkOpts {
  rows: number;
  /** Multiplier on seatPitch — the lever that trades crowd density for budget. */
  pitchScale: number;
}

export type SeatVisitor = (
  x: number, y: number, z: number, yaw: number,
  row: number, section: number, tNorm: number, corner: number,
) => void;

/**
 * Walks every seat in the bowl in (section, row, seat) order so that runs of
 * consecutive seats form compact spatial blocks — which is what makes the
 * near-LOD block gather cheap.
 */
export function walkSeats(s: BowlSpec, o: SeatWalkOpts, visit: SeatVisitor): void {
  const pt: PathPt = { x: 0, z: 0, nx: 0, nz: 0, corner: 0 };
  const pitch = s.seatPitch * o.pitchScale;
  const aisle = s.aisle * Math.min(2, o.pitchScale);
  for (let sec = 0; sec < s.sections; sec++) {
    for (let row = 0; row < o.rows; row++) {
      const p = rowPath(s, row);
      const s0 = (sec / s.sections) * p.len + aisle * 0.5;
      const s1 = ((sec + 1) / s.sections) * p.len - aisle * 0.5;
      const span = s1 - s0;
      const n = Math.floor(span / pitch);
      if (n <= 0) continue;
      const start = (s0 + s1) * 0.5 - (n - 1) * pitch * 0.5;
      const y = s.frontY + row * s.rowRise;
      for (let i = 0; i < n; i++) {
        const arc = start + i * pitch;
        pathAt(p, arc, pt);
        const yaw = Math.atan2(-pt.nx, -pt.nz);
        visit(pt.x, y, pt.z, yaw, row, sec, (arc / p.len) % 1, pt.corner);
      }
    }
  }
}

/** Seat count for a given rows/pitch combination. */
export function seatCapacity(s: BowlSpec, o: SeatWalkOpts): number {
  let n = 0;
  const pitch = s.seatPitch * o.pitchScale;
  const aisle = s.aisle * Math.min(2, o.pitchScale);
  for (let row = 0; row < o.rows; row++) {
    const p = rowPath(s, row);
    const span = p.len / s.sections - aisle;
    n += Math.max(0, Math.floor(span / pitch)) * s.sections;
  }
  return n;
}

/**
 * Picks rows-used and seat pitch so occupied seats land just under `budget`.
 * Lower tiers first close the upper deck (a half-full stadium is plausible),
 * then thin the pitch — never leave one whole side empty.
 */
export function fitBowl(s: BowlSpec, budget: number, fill: number): SeatWalkOpts {
  const want = budget / Math.max(0.35, fill);
  let rows = s.rows;
  let pitchScale = 1;
  if (seatCapacity(s, { rows, pitchScale }) > want) {
    const minRows = Math.max(4, Math.round(s.rows * 0.34));
    while (rows > minRows && seatCapacity(s, { rows: rows - 1, pitchScale }) > want) rows--;
    for (let i = 0; i < 24 && seatCapacity(s, { rows, pitchScale }) > want; i++) pitchScale *= 1.1;
  }
  return { rows, pitchScale };
}

/* ------------------------------------------------------------- occupancy */

/**
 * Relative demand for a seat, *unnormalised* — the caller scales the whole
 * field by one number so the total lands on its instance budget (see
 * `CrowdSystem.generate`, which sums this over every seat first).
 *
 * Real stands do not empty out evenly. They empty in blocks: a section nobody
 * bought, the top of the upper tier, the corners, the row behind a stanchion.
 * The cluster field is therefore pushed through a hard smoothstep so it is
 * mostly near 0 or near 1 rather than a uniform sprinkle — a thinly but
 * *evenly* populated bowl is the single most artificial-looking crowd there is,
 * and at the low tier (900 of ~19 000 seats) an even sprinkle is all you would
 * ever get without this.
 */
export function seatWeight(rowT: number, tNorm: number, corner: number, x: number): number {
  // Two scales: broad blocks a section wide, and finer holes within them.
  const broad = fbm2(tNorm * 7.5, rowT * 2.2, { octaves: 3, seed: 991 }) * 0.5 + 0.5;
  const fine = fbm2(tNorm * 31, rowT * 9.0, { octaves: 2, seed: 613 }) * 0.5 + 0.5;
  const block = smoothstep(0.36, 0.60, broad) * (0.55 + 0.75 * smoothstep(0.30, 0.72, fine));
  let p = 0.055 + 1.55 * block;
  // Stands fill from the front. Sell the lower bowl out first and let the top
  // of the upper tier be the part with the holes in it — that is both what
  // happens and what puts the bodies where a broadcast camera is looking.
  p *= 1 - 0.78 * smoothstep(0.30, 0.98, rowT);     // upper tier thins out
  p *= 1 - 0.42 * corner;                           // corners fill last
  p *= 1 - 0.14 * smoothstep(0.0, 0.07, rowT);      // front-row rail seats
  p *= 1 + 0.28 * smoothstep(42, 8, Math.abs(x));   // halfway-line premium
  return Math.max(0, p);
}

/** `seatWeight` scaled by the caller's density and clamped to a probability. */
export function occupancy(
  rowT: number, tNorm: number, corner: number, base: number, x: number,
): number {
  return clamp(base * seatWeight(rowT, tNorm, corner, x), 0, 1);
}
