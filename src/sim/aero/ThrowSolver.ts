/**
 * The AI's release solver: "put the disc HERE" -> the six numbers a thrower sets.
 *
 * This used to live inside `GameSystem.aiThrow`, private, and was transcribed by
 * hand into `tools/goldens/throwsolver.ts` so the Swift port had something to be
 * differentially tested against. It lives here now because two separate bugs in
 * it were only findable by driving it directly, and because a golden that
 * IMPORTS its reference cannot drift from it the way a transcription can.
 *
 * ----------------------------------------------------------------- the three bugs
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
 *
 * **3. Elevation alone cannot make a short throw, and the search answered a
 * too-SHORT ask as though it were a too-LONG one.** The scan above brackets on a
 * rising crossing, so it records nothing when the flattest legal launch already
 * carries further than the ask — and control then fell through to the branch that
 * throws as far as the arm can. A one metre dump to a receiver standing there was
 * released as a 19.6 m bomb. Live, 9-13% of every AI throw overshot its aim by
 * more than three metres and 42% of asks under 6 m did.
 *
 * The bracketing is half the story. The other half is that `aiThrow` clamps
 * `powerForSpeed` at 0.12, and 12% power on a backhand is 13.8 m/s, which carries
 * 4.8 m at its very worst angle — the throw is not reachable at any elevation. The
 * human path had already solved exactly this by driving an ABSOLUTE release speed
 * from `MIN_THROW_SPEED` (`Game.ts:humanReleaseParams`) and the AI path never got
 * the fix, so a human could throw a 10 m dump and the AI physically could not. So
 * the solver now solves the release speed too, downward, against the shortest
 * carry it can measure. Three faces, one wrong assumption: that the only free
 * variable is the angle.
 */

import type { ThrowRequest } from '../DiscRuntime.ts';
import { STANDING_CATCH_FLOOR } from '../Rules.ts';
import { throwSpeed } from './Throws.ts';

/** The one thing the solver needs from a disc runtime. */
export interface ThrowProbe {
  probeThrow(
    req: ThrowRequest, catchY: number, maxT?: number,
  ): { dist: number; lat: number; x: number; z: number };
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
 * Slowest release the solver will ask an arm for, m/s, and how many times one
 * solve may reach for it. See `solveRelease`'s THROW SOFTER note.
 *
 * This is the same 9 m/s as `MIN_THROW_SPEED` in `Game.ts`, and it is the same
 * number for the same reason: every throw spec's own speed floor is a twenty
 * metre throw, so a solver that can only move within the spec's band cannot make
 * a dump at all. The human path was given an absolute release speed for exactly
 * this and the AI path was not; below, it is.
 */
export const SOLVE_SPEED_MIN = 9;
export const SOLVE_SPEED_DROPS = 2;
/**
 * Residual drift on a calm or near-calm day is still worth a heading trim —
 * but a CLAMPED one, unchanged from before issue #32. Unclamped, this was
 * once the whole correction and it was aiming hucks off the field.
 */
export const SOLVE_HEADING_TRIM = 0.15;
/**
 * Crosswind, m/s, below which `solveRelease` does not run the wind secant at
 * all and falls back to `SOLVE_HEADING_TRIM`'s calm-day clamp — the same
 * deadband `EnginePoint.solvedPull` uses for its own wind correction, and the
 * same reasoning: a calm day's residual is the disc's own fade, which was
 * there before any of this, and running the wind secant on it would change
 * the throw solved for every match that does not have a wind problem, to fix
 * the one axis that does.
 */
export const SOLVE_WIND_DEADBAND = 2;
/**
 * Finite-difference step for the heading secant, rad. See `solveRelease`'s
 * wind note — heading runs its own secant, after bank's, on the axis bank
 * cannot reach (a crosswind's rigid push on the whole flight, as opposed to
 * the disc's own curve, which bank corrects).
 */
export const SOLVE_HEADING_PROBE = 0.05;
/** Most heading one secant step may ask for, rad — the secant is local. */
export const SOLVE_HEADING_STEP = 0.5;
/**
 * Total heading offset from the caller's own aim, rad — a sanity ceiling on
 * the secant, not a tuning knob it is expected to reach in ordinary play.
 * Issue #32's own probe (`tools/_wind_probe.ts`, kept as the friction-log
 * artifact) converged as far out as 1.35-1.4 rad against a 9.5 m/s crosswind
 * on a 25-32 m huck — a straight-line ask that, before this fix, left `lat`
 * (the pre-secant residual) at 37 m on a 32 m throw. 1.0 rad cut that
 * convergence off early and left several such throws 10-20 m long; this is
 * set just past what the measured worst case needed, not so wide that a
 * throw the model cannot make quietly becomes a throw at a different spot.
 */
export const SOLVE_HEADING_MAX = 1.4;
/**
 * **How far under the throwing hand the solved catch plane is forced to sit, m —
 * and the bug it exists to close.**
 *
 * `probeThrow` reports the distance at which a flight DESCENDS through the catch
 * plane (`pos.y <= catchY && prevY > catchY`) and falls through to the ground
 * contact when that crossing never happens. `AI.ts` used to ask for `aimY = 1.35`
 * — a chest — while `Game.releaseOrigin` puts the disc in a standing player's
 * hand at `hipHeight * 1.10`, about 1.05 m. A throw that is never above 1.35 m
 * cannot descend through 1.35 m, so on every flat throw in the game the crossing
 * test could not fire and the solver was silently solving for the disc to hit the
 * TURF at the receiver's feet.
 *
 * It reads back through the whole offence. `AI.predictCatchPoint` takes the
 * first sample at or under `CATCH_FLOOR` = 0.85 m as the rendezvous, and a disc
 * released at 1.05 m and aimed into the ground at 22 m falls through 0.85 m
 * after nine metres — so the intended receiver turned round and ran back to meet
 * a disc twelve metres short of where it was thrown. Median over 379
 * completions: aimed 9.9 m, caught at 6.8 m.
 *
 * Clamping the plane under the release makes the crossing test unconditional (a
 * disc released above the plane always descends through it before the ground),
 * which is what makes the elevation scan a well-posed search at all. Measured
 * after the clamp, the same backhand holds 0.9-1.3 m for the whole flight at
 * every distance from 6 m to 30 m, and grounded throwaways fell from 2.7% of
 * throws to 0.2%.
 *
 * **This clamp is now the BACKSTOP, not the cap.** It repaired the flight and left
 * the ask wrong: `aimY` stayed at a height no flat throw reaches, so caller and
 * callee disagreed by more than half a metre on every throw in the game — 1699 of
 * 1699 over the eleven canonical matches — and nothing anywhere said so. A callee
 * that silently repairs its caller's input makes the input unobservable, which is
 * why this took days to find from the other end.
 *
 * `Game.aiThrow` caps the plane itself now, against the release height it just
 * computed, and `SimChecks/CatchBandTests` asserts at that seam that the solver is
 * never handed a plane the throw cannot descend through. Bit-identical — the plane
 * used is the plane that was always used — and red for every throw in the game
 * before the cap moved. The clamp stays for callers that are not `aiThrow`.
 */
export const SOLVE_CATCH_DROP = 0.25;
/**
 * At and beyond this ask, the solver throws the LOFTED root. See the note in
 * `solveElevation`.
 */
export const SOLVE_LOFT_RANGE = 25;

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
  lofted = false,
): { angle: number; lat: number; reach: number; floor: number } {
  req.aim.set(Math.sin(heading), 0, Math.cos(heading));
  const step = (SOLVE_ELEV_HI - SOLVE_ELEV_LO) / SOLVE_ELEV_SCAN;

  let prevA = SOLVE_ELEV_LO;
  let prevD = -Infinity;
  let peakA = SOLVE_ELEV_LO;
  let peakD = -Infinity;
  let peakLat = 0;
  let minA = SOLVE_ELEV_LO;
  let minD = Infinity;
  let minLat = 0;
  let loA = NaN;
  let hiA = NaN;
  let rising = true;
  let fallLoA = NaN;
  let fallHiA = NaN;
  let riseLoA = NaN;
  let riseHiA = NaN;

  for (let i = 0; i <= SOLVE_ELEV_SCAN; i++) {
    const a = SOLVE_ELEV_LO + step * i;
    req.angle = a;
    const r = probe.probeThrow(req, catchY, 6);
    if (r.dist > peakD) { peakD = r.dist; peakA = a; peakLat = r.lat; }
    if (r.dist < minD) { minD = r.dist; minA = a; minLat = r.lat; }
    if (i > 0 && r.dist >= want && prevD < want && !lofted) { loA = prevA; hiA = a; break; }
    if (i > 0 && r.dist >= want && prevD < want && lofted && Number.isNaN(riseLoA)) {
      riseLoA = prevA; riseHiA = a;
    }
    /**
     * A FALLING CROSSING IS A ROOT TOO, and it is only ever the fallback.
     *
     * The rising crossing above is the flat root of a normal throw and it still
     * wins outright: for any carry curve that starts BELOW the ask — every throw
     * long enough to need a peak — no falling crossing can exist before it, so
     * this records nothing and the scan is bit-for-bit what it was.
     *
     * It exists for an INVERTED disc, whose carry falls across the whole bracket
     * rather than peaking inside it. A hammer at the power floor carries 11.1 m
     * flat and 7 m lofted, so an 8 m hammer has a root at 0.6 rad and the
     * rising-only scan walked past it into the out-of-range branch and threw the
     * 11.5 m peak instead. Measured: `hammer want=8 -> flew 11.47`.
     *
     * Only the FIRST one is kept, and the scan keeps going, because a rising root
     * further up the bracket is the better answer where both exist: under about
     * 10 m/s the carry curve has a step in it — below some elevation the disc
     * lands on the ground without ever climbing back through the catch plane —
     * and the falling "crossing" over that step is a bisection across a
     * discontinuity, which lands anywhere. The rising root above the step is a
     * real one.
     */
    if (i > 0 && r.dist <= want && prevD > want && Number.isNaN(fallLoA)) {
      fallLoA = prevA; fallHiA = a;
    }
    prevA = a;
    prevD = r.dist;
  }

  /**
   * A HUCK IS A LOFTED DISC, and the flat root is the wrong one for it.
   *
   * The scan above prefers the flat root for the reasons in bug 1 of the header,
   * and that is right for every throw a receiver catches in front of him. It is
   * wrong for a deep shot. Measured off the real integrator through this solver
   * (`tools/_lanearc.ts`), the flat root delivers a 30 m backhand at a constant
   * 1.0-1.1 m above the grass for the whole flight — a laser through seven
   * defenders at chest height. Once `AI.flightPath` was corrected to model that
   * honestly, the AI could see the coverage and stopped throwing deep at all:
   * hucks went from 4.8 a match to 0.3, because the model was right and the
   * throw was bad. A real huck goes OVER the defence and comes down on a
   * streaking receiver, which is the falling root — same distance, launched up.
   *
   * So a deep ask takes the falling root when one exists, and falls back to the
   * flat one when it does not (near the arm's limit the two converge and only
   * the flat one is bracketed).
   */
  if (lofted && !Number.isNaN(fallLoA)) {
    loA = fallLoA; hiA = fallHiA; rising = false;
  } else if (lofted && !Number.isNaN(riseLoA)) {
    loA = riseLoA; hiA = riseHiA;
  } else if (Number.isNaN(loA) && !Number.isNaN(fallLoA)) {
    loA = fallLoA; hiA = fallHiA; rising = false;
  }

  /**
   * NO CROSSING. There are two ways to fail to bracket a root, they are opposite
   * failures, and this used to answer both of them with the peak.
   *
   * The scan brackets on a RISING crossing, so it records nothing when the ask is
   * shorter than ANYTHING this release can throw — and a too-short ask then fell
   * through to `peakA`, the maximum-distance angle. Measured, at the power floor:
   * a 1 m dump was answered with a 19.6 m bomb, a 3 m reset with the same one, and
   * 42% of the AI's asks under 6 m overshot their aim by more than three metres. A
   * too-short ask is not a too-long one and must not be answered as one.
   *
   * So the trough is tracked alongside the peak, and the two cases are told apart
   * by it: below the trough, throw it as SHORT as it goes; above the peak, as FAR
   * as it goes. Both are what a player does with an ask they cannot meet, and only
   * the second one was ever implemented. (Note the trough is not always at
   * `SOLVE_ELEV_LO`: under about 10 m/s the flattest launches fall out of the sky
   * onto the ground rather than descending back through the catch plane, and the
   * shortest flight is a small floater a few hundredths of a radian off flat.)
   *
   * The caller then does the real work — it drops the release SPEED and solves
   * again, because an angle alone cannot make a five metre throw out of an arm
   * released at fourteen metres a second.
   */
  if (Number.isNaN(loA)) {
    if (minD >= want) {
      req.angle = minA;
      return { angle: minA, lat: minLat, reach: peakD, floor: minD };
    }
    req.angle = peakA;
    return { angle: peakA, lat: peakLat, reach: peakD, floor: minD };
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
    // Which half to keep depends on which way the carry runs across the cell.
    if ((err < 0) === rising) loA = mid; else hiA = mid;
  }
  req.angle = bestA;
  return { angle: bestA, lat: bestLat, reach: peakD, floor: minD };
}

/**
 * Solve power, elevation, bank and heading for a throw of `want` metres along `heading0`.
 *
 * `req` is a scratch request the caller owns: `type`, `from`, `power`, `spin` and
 * `hand` must be set, `aim` must be a writable vector, and `angle` and `bank` are
 * written by the solve. The returned solution is also left on `req`.
 *
 * `catchY0` is the height the caller would like the disc delivered at; the solve
 * uses it clamped under the release, which is the precondition `probeThrow`'s
 * crossing test needs. See `SOLVE_CATCH_DROP`.
 *
 * `wind` is the match wind (m/s, world frame — the same `world.wind` `AI.ts`
 * already reads for formation and zone-defence choices). It is optional and
 * defaults to still air, which reproduces every calm-day call bit-for-bit.
 *
 * -------------------------------------------------------------- the wind term
 *
 * See `.agents/friction-log/20260810-throwsolver-wind-blind/` — issue #32.
 * Before `wind` was a parameter, every throw was AIMED as if the air were
 * still. The elevation bisection already probes the real, wind-integrated
 * flight through `probe.probeThrow` (so range itself came out right even
 * before this fix — a tailwind carries, a headwind doesn't), but *heading*
 * started at the straight line to the target and only ever moved by a
 * tightly clamped one-shot trim (0.15 rad), sized to mop up the disc's own
 * aerodynamic fade and never revisited once the match wind grew past a
 * breeze. Under real wind the two are not remotely the same size: pooled
 * across four seeds, `tools/test-ai.ts`'s windy run measured **51.6%
 * completion over 153 throws** against a 70-98% band, and a direct probe of
 * this solver found `lat` (the pre-trim residual) reaching **37 m on a 32 m
 * throw** into a crosswind — the old trim was being asked to correct a miss
 * longer than the throw itself with 0.15 rad of budget.
 *
 * The fix is a second secant, on heading, that only runs when there is a real
 * crosswind to answer. It is gated on `windCross` — the wind's component
 * perpendicular to `heading0`, the same quantity `AI.ts`'s `chooseFormation`
 * and `shouldPlayZone` already read off `world.wind` — past a 2 m/s deadband,
 * the same one `EnginePoint.solvedPull` uses for exactly the same reason: a
 * calm-day throw's residual is the disc's own fade, a metre or so, and
 * chasing it with the same tool a crosswind needs changes nine matches in ten
 * that do not have this problem, for one that does.
 *
 * It runs AFTER bank has already settled, with bank held fixed, rather than
 * jointly with bank inside the per-pass loop above (tried first, on the
 * theory that curve and wind are just two contributions to the same `lat`).
 * That version made the worst case WORSE — 35.7 m on a throw that was 10.2 m
 * off before touching heading at all — because a large *tailwind* alone (no
 * crosswind) already pushes bank to its cap chasing the disc's own curve at
 * the flatter angle a tailwind solves for, and letting heading chase that
 * same stale residual every pass fed a real oscillation, not a convergence.
 * Fixing bank first and only then chasing whatever crosswind leaves is what
 * actually converges; the deadband above is what keeps it from ever running
 * on the tailwind-only case that broke the joint version.
 *
 * It is also not a closed-form lead angle (a pilot's `asin(crosswind /
 * airspeed)` wind-correction angle was tried too). It got the *direction* of
 * the correction wrong often enough on this disc's curve to make the miss
 * worse than doing nothing: unlike an aircraft, the disc's own bank already
 * curves its ground track, so which way the aim needs to move depends on the
 * interaction between that curve and the wind, not the wind alone, and a
 * formula that only sees the wind cannot read that off. The secant reads the
 * sign off the flight the disc is actually going to make, same as bank's.
 */
export function solveRelease(
  probe: ThrowProbe, req: ThrowRequest, heading0: number, want: number, catchY0: number,
  wind: { x: number; z: number } = { x: 0, z: 0 },
): ReleaseSolution {
  // Both of these are properties of the throw, not of the caller — see
  // `SOLVE_CATCH_DROP` and the loft note in `solveElevation`.
  // The floor is the RULES' floor, imported rather than retyped: under it there is
  // no standing catch to solve for. The ceiling is the release less the drop, which
  // is what makes `probeThrow`'s descending-crossing test fire at all.
  const catchY = clampNum(catchY0, STANDING_CATCH_FLOOR, req.from.y - SOLVE_CATCH_DROP);
  const lofted = want >= SOLVE_LOFT_RANGE;
  const windCross = -wind.x * Math.cos(heading0) + wind.z * Math.sin(heading0);
  let bank = 0;
  let angle = 0.02;
  let lat = 0;
  let lifts = 0;
  let drops = 0;
  let heading = heading0;

  for (let pass = 0; pass < SOLVE_PASSES; pass++) {
    req.bank = bank;
    const e = solveElevation(probe, req, heading, want, catchY, lofted);
    angle = e.angle;
    lat = e.lat;

    /**
     * THROW SOFTER RATHER THAN LONGER — the mirror of the lift below, and the
     * half of the problem that the lift could never have reached.
     *
     * `powerForSpeed` is clamped to a floor of 0.12 in `aiThrow`, and 12% power on
     * a backhand is still 13.8 m/s, which carries about 19 m at the best angle and
     * never less than 4.8 m at the worst. The AI asks for dumps and resets of one
     * to four metres — to a NAMED receiver standing there — and no launch elevation
     * in a human wrist's range can make that throw at that speed. Measured in live
     * play before this: 9.4% of all AI throws overshot their aim by more than three
     * metres, and among asks under 6 m it was 42%, the worst of them a 0.8 m reset
     * released as a 20.7 m bomb.
     *
     * The human path solved exactly this and the AI path never got the fix: a human
     * release drives an ABSOLUTE speed from `MIN_THROW_SPEED` rather than a power
     * across the throw's own band (`Game.ts:humanReleaseParams`), which is what puts
     * a tap at a few metres instead of twenty. `ThrowRequest.speed` is that same
     * override, so the solver reaches for it here — measuring the shortest carry the
     * scan could find and scaling the speed toward the ask, carry going roughly as
     * speed squared. It floors at `SOLVE_SPEED_MIN`, which is a person's slowest
     * throw and therefore the shortest pass the game has.
     *
     * It is deliberately a SOLVED speed rather than the speed the AI asked for.
     * `throwReleaseSpeed` is a model of pace fitted at throwing distances; below the
     * spec floor it is extrapolating into a band it was never fitted in. The carry
     * the probe measures is not.
     */
    const cur = req.speed ?? throwSpeed(req.type, req.power);
    if (e.floor > want + SOLVE_REACH_TOL && cur > SOLVE_SPEED_MIN && drops < SOLVE_SPEED_DROPS) {
      drops++;
      req.speed = clampNum(
        cur * Math.sqrt(want / Math.max(0.5, e.floor)), SOLVE_SPEED_MIN, cur);
      pass--;
      continue;
    }

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
     *
     * `drops === 0` because the two are opposite corrections and the lift acts on
     * `power`, which an absolute `speed` has already overridden: after a drop the
     * lift could only be a no-op spent against the pass budget.
     */
    if (drops === 0 && e.reach < want - SOLVE_REACH_TOL
      && req.power < 1 && lifts < SOLVE_POWER_LIFTS) {
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
    req.aim.set(Math.sin(heading), 0, Math.cos(heading));
    const r2 = probe.probeThrow(req, catchY, 6);
    const slope = (r2.lat - lat) / SOLVE_BANK_PROBE;
    req.bank = bank;
    if (Math.abs(slope) < 1e-3) break;
    bank = clampNum(
      bank + clampNum(-lat / slope, -SOLVE_BANK_STEP, SOLVE_BANK_STEP),
      -SOLVE_BANK_MAX, SOLVE_BANK_MAX,
    );
  }

  /**
   * Secant on HEADING, the wind's own axis — see `.agents/friction-log/
   * 20260810-throwsolver-wind-blind/` (issue #32).
   *
   * Bank, above, corrects the disc's own curve by changing the flight — right
   * for that (a thrower banks, per the header above) and left exactly as it
   * was, at `heading0`, so a calm-day throw solves bit-identically to before
   * this fix. Bank is the wrong tool for a crosswind's rigid push on the whole
   * flight, though, which is why it alone left `lat` up to 37 m on a 32 m
   * throw once the match wind cleared 4.5 m/s (issue #20's zone threshold):
   * bank pegged at its own cap with the wind's contribution to `lat` still
   * sitting there afterward, unaddressed by anything.
   *
   * This phase runs AFTER bank has settled, with bank held fixed, and closes
   * whatever `lat` bank left — the calm-day residue `SOLVE_HEADING_TRIM` used
   * to mop up in one clamped step, and now also the wind's own contribution,
   * which needed far more than 0.15 rad on the measurements above. It is a
   * proper secant rather than a closed-form lead angle (a pilot's
   * `asin(crosswind / airspeed)` wind-correction angle was tried first and got
   * the *sign* wrong often enough to make the miss worse — it only sees the
   * wind, not the interaction between the wind and the disc's own bank-driven
   * curve, which is exactly the part a measured secant does not need to know).
   * Running it as its OWN loop rather than folding it into the bank secant
   * above matters: doing both every pass off the same stale `lat` measurement
   * let the two corrections fight — measured, it made the worst case WORSE
   * (35.7 m on a throw that was 10.2 m off before touching heading at all).
   * Fixing bank first and only then chasing the remainder with heading is
   * what converges. And it only runs past `SOLVE_WIND_DEADBAND` — see the
   * function header — because a big TAILWIND ALONE (no crosswind at all)
   * already pushes bank to its cap on some throws, chasing the disc's own
   * curve at the flatter angle a tailwind solves for, and this secant
   * chasing that same non-wind residual is exactly the runaway the previous
   * paragraph describes. `windCross` is zero for a pure tailwind, so the gate
   * keeps this phase out of that case entirely and it falls through to the
   * ordinary calm-day trim below instead.
   */
  if (Math.abs(windCross) > SOLVE_WIND_DEADBAND) {
    /**
     * THE SECANT MUST READ ITS ERROR IN THE TARGET'S FRAME, NOT THE CANDIDATE
     * HEADING'S OWN FRAME — the bug that made the first version of this loop
     * actively worse than doing nothing.
     *
     * `solveElevation(..., h, want, ...)` bisects so the flight covers `want`
     * metres MEASURED ALONG `h` — so its own `lat` is the residual PERPENDICULAR
     * TO `h`, whatever `h` currently is. Rotate `h` by half a radian and that
     * residual can read as zero while the disc lands 15 m from the receiver,
     * because "zero" only ever meant "on the line this throw is currently
     * aimed along," and the line moved. `worldLat0` below fixes that: it always
     * measures the landing point's sideways offset from the ORIGINAL target
     * line (`heading0`, `want`), regardless of which heading actually got
     * probed. That is the quantity that must go to zero, and it is a different
     * quantity from `solveElevation`'s own `lat` for any `h !== heading0`.
     */
    const ux0 = Math.sin(heading0);
    const uz0 = Math.cos(heading0);
    const worldLat0 = (h: number): { lat0: number; angle: number } => {
      req.bank = bank;
      /**
       * `solveElevation` bisects so the flight covers ITS `want` ARGUMENT
       * measured along `h`, not along `heading0`. What has to land at the
       * FIXED target `T = want·(sin(heading0), cos(heading0))` is the flight
       * itself, and `T`'s own projection onto `h` is `want·cos(h - heading0)`
       * — smaller than `want` whenever `h` has rotated away from `heading0`,
       * which is exactly the case this phase exists for. Handing raw `want`
       * to a rotated `h` throws PAST `T` by construction (measured: 19-22 m
       * past a 25-32 m throw at the `SOLVE_HEADING_MAX` corner) — this is
       * that correction.
       */
      const wantAlongH = want * Math.cos(h - heading0);
      const e2 = solveElevation(probe, req, h, wantAlongH, catchY, lofted);
      req.angle = e2.angle;
      req.aim.set(Math.sin(h), 0, Math.cos(h));
      const r = probe.probeThrow(req, catchY, 6);
      const dx = r.x - req.from.x;
      const dz = r.z - req.from.z;
      return { lat0: -dx * uz0 + dz * ux0, angle: e2.angle };
    };

    let cur = worldLat0(heading);
    angle = cur.angle;
    for (let hpass = 0; hpass < SOLVE_PASSES && Math.abs(cur.lat0) > SOLVE_LAT_TOL; hpass++) {
      const trial = worldLat0(heading + SOLVE_HEADING_PROBE);
      const slope = (trial.lat0 - cur.lat0) / SOLVE_HEADING_PROBE;
      if (Math.abs(slope) < 1e-3) break;
      heading = clampNum(
        heading + clampNum(-cur.lat0 / slope, -SOLVE_HEADING_STEP, SOLVE_HEADING_STEP),
        heading0 - SOLVE_HEADING_MAX, heading0 + SOLVE_HEADING_MAX,
      );
      cur = worldLat0(heading);
      angle = cur.angle;
    }
    lat = cur.lat0;
  } else if (Math.abs(lat) > SOLVE_LAT_TOL && want > 1) {
    heading -= clampNum(Math.atan2(lat, want), -SOLVE_HEADING_TRIM, SOLVE_HEADING_TRIM);
  }

  req.bank = bank;
  req.angle = angle;
  req.aim.set(Math.sin(heading), 0, Math.cos(heading));
  return { angle, bank, heading };
}
