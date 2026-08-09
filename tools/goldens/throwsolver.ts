/**
 * Goldens for the AI throw solver — `Game.ts:aiThrow`.
 *
 * **This is the first differential fixture the integration layer has ever had,
 * and it exists because the layer was invented rather than ported.** For most of
 * this project `Engine.swift` carried a header saying `src/sim/Game.ts` was "not
 * a port target … integration glue rather than simulation", and on the strength
 * of that nobody read it. The throw solver inside it is not glue: it turns the
 * point the AI asked for into a disc, and the Swift side had a lerp in its place.
 *
 * Mutation testing then found the replacement could be broken in four different
 * ways without failing any of 2.2 million assertions, because every one of those
 * assertions was a component golden that the wiring never touches. Property
 * checks were added, and they help, but the honest answer for a function that is
 * a transcription of a reference function is a differential fixture. This is it.
 *
 * `aiThrow` USED to be private to `GameSystem`, and this fixture used to carry a
 * hand transcription of it — with the risk, stated here in full, that a
 * transcription can drift from its original. It no longer has to: the solve moved
 * out into `src/sim/aero/ThrowSolver.ts`, and this file imports it. What is left
 * below is only the part of `aiThrow` that is not the solve — the arm's spin, the
 * power for the asked-for speed, and the catch plane — and every one of those is
 * three lines quoted beside the reference.
 *
 * The sweep covers every throw type the AI uses, headings all round the clock
 * (a disc banks, so lateral error changes sign with the heading, and a forehand
 * and a backhand curve opposite ways), and ranges as a fraction of the AI's own
 * `maxThrowRange`. The long fractions are deliberately included even though the
 * reference cannot make those throws: `maxThrowRange` and the flight model
 * disagree above about a third of the former, so the AI asks for hucks that land
 * badly short. That shortfall is reference behaviour — measured identically in
 * both languages — and pinning it here means a future change to either model is
 * a visible diff rather than a silent one.
 */

import * as THREE from 'three';
import { DiscRuntime, type ThrowRequest } from '../../src/entities/Disc.ts';
import { powerForSpeed } from '../../src/sim/aero/Throws.ts';
import { solveRelease } from '../../src/sim/aero/ThrowSolver.ts';
import { maxThrowRange, throwFlightTime, type AIPlayer } from '../../src/sim/AI.ts';

const clampNum = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const FIXED_DT = 1 / 120;

/** A fixed arm, so the fixture does not move when the roster generator does. */
const arm = {
  id: 0, team: 0, energy: 1,
  attr: {
    throwPower: 70, speed: 70, acceleration: 70, agility: 70, catching: 70,
    jumping: 70, defAwareness: 70, decision: 70, stamina: 70, height: 180,
  },
} as unknown as AIPlayer;

const TYPES = ['backhand', 'forehand', 'hammer', 'scoober', 'push'] as const;
const FRACTIONS = [0.15, 0.3, 0.35, 0.5, 0.7, 0.9];
const HEADINGS = 8;

/**
 * The non-solve half of `Game.ts:aiThrow`, lines 1517-1541. The 1.02 on power,
 * the 0.12 floor, the 0.45/0.55 spin from the arm and the 0.35 m catch-plane
 * floor are the reference's; everything after them is `solveRelease` itself,
 * imported.
 */
function solve(
  rt: DiscRuntime, from: THREE.Vector3, aim: THREE.Vector3, type: string, speed: number,
): ThrowRequest | null {
  const tx = aim.x - from.x, tz = aim.z - from.z;
  const want = Math.hypot(tx, tz);
  if (want < 0.4) return null;

  const spin = clampNum(0.45 + 0.55 * (arm.attr.throwPower / 100), 0, 1);
  const power = clampNum(powerForSpeed(type as never, speed) * 1.02, 0.12, 1);
  const catchY = Math.max(0.35, aim.y);

  const req = {
    type, from, aim: new THREE.Vector3(), power, angle: 0.02, spin, hand: 'R', bank: 0,
  } as unknown as ThrowRequest;
  solveRelease(rt, req, Math.atan2(tx, tz), want, catchY);
  return req;
}

/**
 * One sweep at a given wind.
 *
 * **The wind has to be part of the fixture.** `aiThrow` bisects against the same
 * `DiscRuntime` the match flies in, and that runtime carries the match's breeze —
 * so the solved elevation is a function of the wind, not just of the aim. A first
 * version of this fixture was generated in still air and compared against a Swift
 * engine that had just been given weather; it disagreed by up to 0.6 rad of launch
 * elevation, and both sides were right. The bisection's seventh halving is a
 * discrete branch, so a nudged probe selects a neighbouring angle rather than
 * drifting by an ulp.
 */
function sweep(wind: { x: number; z: number }): unknown {
  // Separate runtimes for probing and flying. This was first done on a hunch that a
  // flight ageing the runtime — `clock`, `sinceRelease`, the trail, `wear` — was moving
  // the next case's probe. It is not: the fixture is byte-identical either way. Kept
  // because it matches how the engine uses them, and recorded because a hunch that was
  // checked and found wrong is worth exactly as much as one that was right.
  const probeRt = new DiscRuntime();
  const flyRt = new DiscRuntime();
  probeRt.wind.set(wind.x, 0, wind.z);
  flyRt.wind.set(wind.x, 0, wind.z);
  const cases: unknown[] = [];

  for (const type of TYPES) {
    const reach = maxThrowRange(arm, type as never, 0);
    for (const fraction of FRACTIONS) {
      const range = reach * fraction;
      for (let step = 0; step < HEADINGS; step++) {
        const h = (step * Math.PI) / 4;
        const from = new THREE.Vector3(0, 1.35, 0);
        /**
         * Axis-aligned aims are SNAPPED TO EXACT ZEROS. `sin(6 * PI/4)` leaves a
         * residue of ~5e-15 in the off-axis component, and `atan2(-30, -5.5e-15)`
         * is one of the few arguments where V8 and Darwin libm disagree by an
         * ulp; `atan2(x, 0)` and `atan2(0, z)` are exact special cases in both.
         * This removes one seed of cross-libm disagreement; the stability filter
         * below handles the ones that live inside the integrator.
         */
        const snap = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v);
        const aim = new THREE.Vector3(
          snap(Math.sin(h)) * range, 1.35, snap(Math.cos(h)) * range);
        const speed = range / Math.max(0.2, throwFlightTime(arm, type as never, range));
        const req = solve(probeRt, from, aim, type, speed);
        if (!req) continue;

        /**
         * KNIFE-EDGE CASES ARE FILTERED OUT, and the filter is the fixture's
         * honesty rather than a loss of coverage. `probeThrow` reports the
         * descent through the catch plane, which is a discrete threshold: a
         * flight that GRAZES the plane crosses it metres apart under a last-ulp
         * libm difference, so the solved heading correction — which reads `lat`
         * off that crossing — is not a reproducible number across V8 and Darwin
         * for such a case. Measured directly when the release-speed model first
         * reached this power band: a forehand at 30 m along the -x axis solved
         * 5e-3 rad apart on two correct implementations, while the same physical
         * flight rotated 45 degrees agreed to 1e-15. The test suite's own header
         * documents this failure mode ("a nudged probe picks a neighbouring
         * angle rather than drifting by an ulp"); the fixture now excludes what
         * it cannot pin. Detection: re-solve with the aim jittered by a
         * micrometre; a smooth case moves the solved heading by ~1e-8, a grazing
         * one by ~1e-3, so the 1e-5 bar has two decades of margin either side.
         */
        const jittered = [
          solve(probeRt, from, new THREE.Vector3(aim.x + 1e-6, aim.y, aim.z), type, speed),
          solve(probeRt, from, new THREE.Vector3(aim.x, aim.y, aim.z + 1e-6), type, speed),
        ];
        const unstable = jittered.some((q) =>
          !q
          || Math.abs(q.angle - req.angle) > 1e-5
          || Math.abs(q.aim.x - req.aim.x) > 1e-5
          || Math.abs(q.aim.z - req.aim.z) > 1e-5);
        if (unstable) continue;

        // Fly the solved release to rest. The closest approach is what the
        // solver is actually promising; the landing point is where it ends up.
        const vel = flyRt.release(req);
        const released = { x: vel.x, y: vel.y, z: vel.z };
        let closest = Infinity;
        let steps = 0;
        for (let i = 0; i < 120 * 8; i++) {
          flyRt.step(FIXED_DT);
          steps++;
          const d = Math.hypot(flyRt.state.pos.x - aim.x, flyRt.state.pos.z - aim.z);
          if (d < closest) closest = d;
          if (flyRt.state.atRest) break;
        }

        cases.push({
          type,
          reach,
          fraction,
          range,
          speed,
          from: { x: from.x, y: from.y, z: from.z },
          aim: { x: aim.x, y: aim.y, z: aim.z },
          solved: {
            power: req.power,
            angle: req.angle,
            spin: req.spin,
            bank: req.bank,
            aimX: req.aim.x,
            aimZ: req.aim.z,
          },
          released,
          flight: {
            closest,
            steps,
            restX: flyRt.state.pos.x,
            restZ: flyRt.state.pos.z,
          },
        });
      }
    }
  }

  return { wind, cases };
}

export function throwSolverGoldens(): unknown {
  return {
    note:
      'Game.ts:aiThrow solved against the reference DiscRuntime, then flown to rest. '
      + 'The solve itself is src/sim/aero/ThrowSolver.ts and is imported, not '
      + 'transcribed; probeThrow, release and powerForSpeed are imported too. '
      + 'Two sweeps: still air, and a breeze of the size '
      + 'the match actually sets, because the solver bisects against the runtime that '
      + 'carries the wind. Fractions above ~0.35 of maxThrowRange land short on '
      + 'purpose: the AI range model and the flight model disagree there, in both '
      + 'languages.',
    sweeps: [sweep({ x: 0, z: 0 }), sweep({ x: 1.2, z: -0.8 })],
  };
}
