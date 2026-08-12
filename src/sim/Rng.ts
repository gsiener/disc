/**
 * src/sim/Rng.ts — the reference's random stream, in one place.
 *
 * xorshift128: small, fast, and deterministic across runs and machines. Every
 * golden in this repository is a claim about the sequence this produces, which
 * is why it lives in a module that **imports nothing**. That is the whole
 * interface: a caller needs the seed and nothing else, and there is no import
 * graph underneath this file that could drag a renderer into a headless
 * process (ADR-0008) or a second definition into the goldens.
 *
 * It used to exist three times — here in spirit, as `SeededRng` in
 * `Playbook.ts`, and as `Rng` in `core/Ctx.ts` — and the copy that existed to
 * keep the reference headless was defeated by `Game.ts` and `Locomotion.ts`
 * importing the engine's copy anyway. See #42. The client's `core/Ctx.ts` still
 * declares its own; it is the legacy preview's, and it is not what the port
 * mirrors.
 *
 * `SeededRng` is the name the Swift port names as its counterpart and the name
 * nine golden generators import. It is an alias, kept so that the port and the
 * fixtures point at one class rather than a chain of mirrors.
 */

/**
 * The narrow surface the simulation actually consumes.
 *
 * Anything holding a real `ctx.rand` can be passed wherever a `RandomSource` is
 * expected — the shapes match structurally, which is what lets the engine's
 * generator drive the reference without the reference knowing the engine exists.
 * `pick` is deliberately absent: it is sugar over `next`, the simulation does
 * not use it, and leaving it out keeps this the smallest thing a caller can
 * satisfy.
 */
export interface RandomSource {
  next(): number;
  range(lo: number, hi: number): number;
  int(lo: number, hi: number): number;
  gauss(): number;
  fork(salt: number): RandomSource;
}

export class Rng implements RandomSource {
  private a: number; private b: number; private c: number; private d: number;
  constructor(seed = 0x9e3779b9) {
    this.a = seed >>> 0; this.b = (seed ^ 0x85ebca6b) >>> 0;
    this.c = (seed ^ 0xc2b2ae35) >>> 0; this.d = (seed ^ 0x27d4eb2f) >>> 0;
    // Sixteen discarded draws. Without them a low seed's first values correlate
    // with the seed, and the fixtures pin the warmed stream — so this loop is
    // load-bearing for every golden in the repository, not hygiene.
    for (let i = 0; i < 16; i++) this.next();
  }
  next(): number {
    let t = this.d;
    const s = this.a;
    this.d = this.c; this.c = this.b; this.b = s;
    t ^= t << 11; t ^= t >>> 8;
    this.a = (t ^ s ^ (s >>> 19)) >>> 0;
    return this.a / 4294967296;
  }
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  int(lo: number, hi: number): number { return Math.floor(this.range(lo, hi + 1)); }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  /** Box-Muller, mean 0 sigma 1. */
  gauss(): number {
    const u = Math.max(1e-7, this.next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  /**
   * A child stream salted off this one's current state.
   *
   * Note it does **not** advance the parent — two forks with the same salt from
   * the same point are the same stream, which is what makes a per-player or
   * per-system fork reproducible regardless of what else drew in between.
   */
  fork(salt: number): Rng { return new Rng((this.a ^ (salt * 0x9e3779b9)) >>> 0); }
}

/**
 * The port's counterpart and the goldens' import name.
 *
 * `swift/Sources/UltimateSim/Rng.swift` mirrors this class. Keep them
 * bit-identical: a one-constant drift here invalidates every fixture at once
 * and the failure reads as a physics bug.
 */
export { Rng as SeededRng };
