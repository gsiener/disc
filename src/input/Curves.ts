/**
 * Pure input maths — dead zones, response curves, angle helpers.
 *
 * Nothing in here touches the DOM, allocates per call (unless you ask it to) or
 * uses randomness, so it is unit-testable under node and identical on every
 * machine. All stick shaping goes through here so a pad, the keyboard emulation
 * and the AI all land on the same numbers.
 */

export interface Vec2 { x: number; y: number }

export function vec2(x = 0, y = 0): Vec2 { return { x, y }; }

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** Hermite smoothstep of an already-normalised t (clamped to 0..1). */
export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Wrap to (-pi, pi] in O(1) — no unbounded loops. */
export function wrapAngle(a: number): number {
  return a - TAU * Math.round(a / TAU);
}

/** Shortest signed rotation that takes `from` to `to`. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function moveTowards(cur: number, target: number, maxDelta: number): number {
  const d = target - cur;
  if (d > maxDelta) return cur + maxDelta;
  if (d < -maxDelta) return cur - maxDelta;
  return target;
}

/* ------------------------------------------------------------- dead zones */

export interface StickConfig {
  /** Radial inner dead zone. Magnitudes at or below this read as zero. */
  inner: number;
  /** Radial outer dead zone. Magnitudes at or above this saturate to 1. */
  outer: number;
  /** Weight of the exponential term of the response curve, 0..1. */
  expo: number;
  /** Exponent of the exponential term (>1 = finer control near centre). */
  power: number;
}

/** Movement stick: generous centre, soft ramp, saturates before the physical stop. */
export const DEFAULT_STICK: StickConfig = { inner: 0.18, outer: 0.95, expo: 0.62, power: 2.6 };
/** Aim stick: tighter dead zone — you want the disc angle to answer immediately. */
export const DEFAULT_AIM_STICK: StickConfig = { inner: 0.14, outer: 0.92, expo: 0.45, power: 2.0 };
/** Analogue trigger: small dead zone, close to linear so sprint intensity is readable. */
export const DEFAULT_TRIGGER: StickConfig = { inner: 0.06, outer: 0.94, expo: 0.3, power: 1.8 };

/**
 * Response curve. A pure power curve feels dead near the centre and a linear
 * ramp gives you no fine control, so blend the two:
 *
 *     f(t) = (1 - expo) * t + expo * t^power
 *
 * f(0) = 0, f(1) = 1, monotonically increasing for power >= 1, expo in 0..1.
 */
export function responseCurve(t: number, expo: number, power: number): number {
  const x = clamp01(t);
  const e = clamp01(expo);
  return (1 - e) * x + e * Math.pow(x, power);
}

/**
 * Radial (not per-axis) dead zone. The magnitude is remapped through the
 * response curve; the *direction* is passed through untouched, which is the
 * whole point — a square dead zone eats diagonals and makes 45 degree runs
 * snap to the axes.
 *
 * Writes into `out` and returns it; never allocates.
 */
export function applyStick(x: number, y: number, cfg: StickConfig, out: Vec2): Vec2 {
  const r = Math.sqrt(x * x + y * y);
  if (r <= cfg.inner || r <= 1e-9) { out.x = 0; out.y = 0; return out; }
  const span = Math.max(1e-6, cfg.outer - cfg.inner);
  const t = clamp01((r - cfg.inner) / span);
  const m = responseCurve(t, cfg.expo, cfg.power);
  const s = m / r;
  out.x = x * s;
  out.y = y * s;
  return out;
}

/** 1-D version, for triggers. Sign preserved. */
export function applyTrigger(v: number, cfg: StickConfig): number {
  const a = Math.abs(v);
  if (a <= cfg.inner) return 0;
  const span = Math.max(1e-6, cfg.outer - cfg.inner);
  const t = clamp01((a - cfg.inner) / span);
  const m = responseCurve(t, cfg.expo, cfg.power);
  return v < 0 ? -m : m;
}

/** Magnitude of a Vec2. */
export function mag2(v: Vec2): number { return Math.sqrt(v.x * v.x + v.y * v.y); }

/** Normalise in place; leaves a zero vector alone. Returns the old magnitude. */
export function normalize2(v: Vec2): number {
  const m = mag2(v);
  if (m > 1e-9) { v.x /= m; v.y /= m; }
  return m;
}

/** Clamp a vector into the unit disc, in place. */
export function clampUnit(v: Vec2): Vec2 {
  const m = mag2(v);
  if (m > 1) { v.x /= m; v.y /= m; }
  return v;
}
