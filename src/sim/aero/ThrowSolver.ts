/**
 * The AI's release solver: "put the disc HERE" -> the six numbers a thrower sets.
 *
 * This used to live inside `GameSystem.aiThrow`, private, and was transcribed by
 * hand into `tools/goldens/throwsolver.ts` so the Swift port had something to be
 * differentially tested against. It lives here now because two separate bugs in
 * it were only findable by driving it directly, and because a golden that
 * IMPORTS its reference cannot drift from it the way a transcription can.
 *
 * ------------------------------------------------------------------ the two bugs
 *
 * **1. Range is not monotonic in launch elevation, and the old search assumed it
 * was.** A 20.5 m/s backhand carries, as the launch angle sweeps -0.34 -> +0.62
 * rad: 5.5, 8.3, 17.7, 27.0, 38.9, 36.8, 33.5, 30.3, 27.0, 23.5, 19.9, 16.5,
 * 13.6 m. It peaks near -0.02 rad and falls away on both sides, so almost every
 * reachable distance has TWO solutions — a flat one on the near side of the peak
 * and a lofted one beyond it. A plain bisection with `if (err < 0) lo = mid`
 * believes distance rises with angle all the way, so it walks past the peak and
 * lands on the lofted root every time. Measured on that same throw: the lofted
 * root flies with 3.0 m of lateral curve where the flat one has 0.5 m, hangs in
 * the air long enough for a defender to arrive, and is the reason a 32 m huck
 * finished five metres off its receiver. A real huck is a flat fast disc, so the
 * search scans up to the peak and brackets the FLAT root; only when the target is
 * genuinely out of range does it fall back to the peak (i.e. throw as far as the
 * arm can, which is the right thing to do with an unreachable ask).
 *
 * **2. There was no bank axis, so the solver paid for curve with heading.** The
 * only correction available was to rotate the aim against the drift, which points
 * the disc at a patch of grass and hopes the curve brings it back. On a huck that
 * is a throw aimed fifteen degrees off the receiver, and roughly a third of them
 * left the field. A thrower does not do this: a thrower BANKS the disc, so the
 * curve is cancelled at the source and the aim still points at the human catching
 * it. So bank is solved for, by a secant on the probe's own lateral error.
 *
 * Solving it rather than tabulating it is what makes it correct for free. The
 * sign of a disc's curve depends on the spin (a forehand and a backhand roll
 * opposite ways), on the hand (a lefty mirrors both), AND on the speed — the same
 * backhand drifts +3.2 m at 22 m/s and -12.2 m at 26 m/s, because below the
 * turnover it is still fading and above it it is rolling over. A signed constant
 * per throw type gets the slow half of that backwards. The secant reads the sign
 * off the flight the disc is actually going to make.
 */

import type { ThrowRequest } from '../../entities/Disc.ts';

/** The one thing the solver needs from a disc runtime. */
export interface ThrowProbe {
  probeThrow(
    req: ThrowRequest, catchY: number, maxT?: number,
  ): { dist: number; lat: number };
}

/* ------------------------------------------------------------------ tuning */

/** Launch-elevation bracket, rad. Unchanged: this is the range of a human wrist. */
export const SOLVE_ELEV_LO = -0.34;
export const SOLVE_ELEV_HI = 0.62;
/**
 * Coarse steps across the bracket, used to find the flat root's cell. Twelve is
 * the point where the peak stops being straddled: the peak is about 0.1 rad wide
 * at half height and the bracket is 0.96 rad, so a step of 0.08 rad resolves it.
 * The scan STOPS at the first crossing, so a dump costs two probes and only a
 * near-maximum throw pays for all twelve.
 */
export const SOLVE_ELEV_SCAN = 12;
/** Halvings inside the bracketed cell. Five takes 0.08 rad to 2.5 mrad. */
export const SOLVE_ELEV_HALVINGS = 5;
/** Elevation solves, each of which may be followed by a bank correction. */
export const SOLVE_PASSES = 3;
/** Lateral error the solver stops caring about, m. */
export const SOLVE_LAT_TOL = 0.25;
/** Finite-difference step for the bank secant, rad. */
export const SOLVE_BANK_PROBE = 0.05;
/** Most bank one secant step may ask for, rad — the secant is local, the curve is not. */
export const SOLVE_BANK_STEP = 0.30;
/**
 * Bank ceiling, rad. Twenty degrees of hyzer is a hard huck; past that the disc
 * stops flying and starts knifing, and the solver would be buying line-holding
 * with distance it cannot spare.
 */
export const SOLVE_BANK_MAX = 0.35;
/**
 * How far short the flight may fall before the solver reaches for more arm, m.
 * Under this it is inside a receiver's own reach and not worth another 18 probes.
 */
export const SOLVE_REACH_TOL = 0.5;
/** How many times one solve may lift the power. See `solveRelease`. */
export const SOLVE_POWER_LIFTS = 2;
/**
 * Residual drift is still worth a heading trim — but a CLAMPED one. Unclamped,
 * this was the whole correction and it was aiming hucks off the field.
 */
export const SOLVE_HEADING_TRIM = 0.15;

export interface ReleaseSolution {
  /** Launch elevation above the throw's own spec elevation, rad. */
  angle: number;
  /** Bank about the flight axis at release, rad. */
  bank: number;
  /** Aim heading, rad, as atan2(x, z). */
  heading: number;
}

const clampNum = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Solve the launch elevation that carries `want` metres, preferring the flat root.
 *
 * Mutates `req.angle` and `req.aim` as it probes — the caller owns both and they
 * are left holding the solved values.
 */
function solveElevation(
  probe: ThrowProbe, req: ThrowRequest, heading: number, want: number, catchY: number,
): { angle: number; lat: number; reach: number } {
  req.aim.set(Math.sin(heading), 0, Math.cos(heading));
  const step = (SOLVE_ELEV_HI - SOLVE_ELEV_LO) / SOLVE_ELEV_SCAN;

  let prevA = SOLVE_ELEV_LO;
  let prevD = -Infinity;
  let peakA = SOLVE_ELEV_LO;
  let peakD = -Infinity;
  let peakLat = 0;
  let loA = NaN;
  let hiA = NaN;

  for (let i = 0; i <= SOLVE_ELEV_SCAN; i++) {
    const a = SOLVE_ELEV_LO + step * i;
    req.angle = a;
    const r = probe.probeThrow(req, catchY, 6);
    if (r.dist > peakD) { peakD = r.dist; peakA = a; peakLat = r.lat; }
    if (i > 0 && r.dist >= want && prevD < want) { loA = prevA; hiA = a; break; }
    prevA = a;
    prevD = r.dist;
  }

  // Out of range: throw it as far as it goes. The AI's own range model is more
  // optimistic than the flight model above about a third of `maxThrowRange`, so
  // this branch is taken on purpose and often, and it is what a player does with
  // an ask they cannot meet.
  if (Number.isNaN(loA)) {
    req.angle = peakA;
    return { angle: peakA, lat: peakLat, reach: peakD };
  }

  let bestA = loA;
  let bestErr = Infinity;
  let bestLat = 0;
  for (let i = 0; i < SOLVE_ELEV_HALVINGS; i++) {
    const mid = (loA + hiA) * 0.5;
    req.angle = mid;
    const r = probe.probeThrow(req, catchY, 6);
    const err = r.dist - want;
    if (Math.abs(err) < Math.abs(bestErr)) { bestErr = err; bestA = mid; bestLat = r.lat; }
    if (err < 0) loA = mid; else hiA = mid;
  }
  req.angle = bestA;
  return { angle: bestA, lat: bestLat, reach: peakD };
}

/**
 * Solve power, elevation, bank and heading for a throw of `want` metres along `heading0`.
 *
 * `req` is a scratch request the caller owns: `type`, `from`, `power`, `spin` and
 * `hand` must be set, `aim` must be a writable vector, and `angle` and `bank` are
 * written by the solve. The returned solution is also left on `req`.
 */
export function solveRelease(
  probe: ThrowProbe, req: ThrowRequest, heading0: number, want: number, catchY: number,
): ReleaseSolution {
  let bank = 0;
  let angle = 0.02;
  let lat = 0;
  let lifts = 0;

  for (let pass = 0; pass < SOLVE_PASSES; pass++) {
    req.bank = bank;
    const e = solveElevation(probe, req, heading0, want, catchY);
    angle = e.angle;
    lat = e.lat;

    /**
     * THROW HARDER RATHER THAN SHORTER.
     *
     * The release speed the AI asks for comes from `throwFlightTime`, and above
     * about a third of `maxThrowRange` that model and the flight model disagree:
     * the AI asks for a 42 m huck at 22.7 m/s, which no launch angle carries past
     * about 34 m. The solver used to answer that by flying as far as it could and
     * saying nothing, so the deep game was a stream of discs that fell in front of
     * the receiver — 60% of hucks hit the ground uncaught, measured.
     *
     * An arm that can throw harder should. Carry goes roughly as speed squared, so
     * the lift is `sqrt(want / reach)` on power, capped at full. Two lifts is
     * enough to close any gap `maxThrowRange` will ever open; a throw that is still
     * short at full power is genuinely beyond the arm and flies at the peak angle,
     * which is what a player does with a shot they cannot quite make.
     */
    if (e.reach < want - SOLVE_REACH_TOL && req.power < 1 && lifts < SOLVE_POWER_LIFTS) {
      lifts++;
      req.power = clampNum(
        req.power * Math.sqrt(want / Math.max(1, e.reach)), req.power, 1);
      pass--;
      continue;
    }

    if (Math.abs(lat) <= SOLVE_LAT_TOL || pass === SOLVE_PASSES - 1) break;

    // Secant on bank. One extra probe buys the local dLat/dBank, which is what
    // makes this correct for either hand, either spin and either side of the
    // turnover speed without a table of signs.
    req.bank = bank + SOLVE_BANK_PROBE;
    req.angle = angle;
    req.aim.set(Math.sin(heading0), 0, Math.cos(heading0));
    const r2 = probe.probeThrow(req, catchY, 6);
    const slope = (r2.lat - lat) / SOLVE_BANK_PROBE;
    req.bank = bank;
    if (Math.abs(slope) < 1e-3) break;
    bank = clampNum(
      bank + clampNum(-lat / slope, -SOLVE_BANK_STEP, SOLVE_BANK_STEP),
      -SOLVE_BANK_MAX, SOLVE_BANK_MAX,
    );
  }

  let heading = heading0;
  if (Math.abs(lat) > SOLVE_LAT_TOL && want > 1) {
    heading -= clampNum(Math.atan2(lat, want), -SOLVE_HEADING_TRIM, SOLVE_HEADING_TRIM);
  }

  req.bank = bank;
  req.angle = angle;
  req.aim.set(Math.sin(heading), 0, Math.cos(heading));
  return { angle, bank, heading };
}
