/**
 * THE CATCH BAND — one band, and the two assertions that keep it one.
 *
 * Issue #4. The rules engine owns the height a catch is paid out at, and for most of
 * this project every consumer carried its own number instead: `1.45`, `1.35`, `0.12`,
 * `0.85`, `0.20`, `0.35` and a horizontal `1.9` have all stood in for it in different
 * files. That has produced the same bug twice, from opposite ends, five days apart:
 *
 *   - **6 August.** `AI.predictCatchPoint` scanned for the first flight sample under a
 *     floor of its own — `0.12` — and the rules refuse a standing catch below
 *     `groundY + 0.20`. So receivers were sent to meet the disc where the only legal
 *     catch is a dive. 80 % of all bids were for a disc predicted to arrive under
 *     0.2 m, and the offence laid out 4.5 times a minute. The friction entry
 *     (`20260806171905-ai-predictcatchpoint-aimed`) diagnosed it exactly, proposed a
 *     shared constant and this assertion, and nothing was implemented.
 *
 *   - **9 August.** `ThrowSolver.probeThrow` reports the distance at which a flight
 *     *descends through* the catch plane, and falls through to ground contact when that
 *     crossing never happens. The plane it was handed was `aimY = 1.35`, and a disc
 *     released from a standing hand at ~1.05 m never rises to 1.35 m — so the crossing
 *     could not fire and every flat throw in the game was solved to land at the
 *     receiver's ankles. Median over 379 completions: aimed 9.9 m, caught at 6.8 m.
 *
 * Both are one fact about the rules, written down separately in three files and
 * disagreeing each time. This fixture is what stops a fourth copy appearing.
 *
 * ------------------------------------------------------------------ what it asserts
 *
 * **1. The band is one band.** Every constant in the family, imported live from the
 * module that owns it, plus the relationships between them — the AI's rendezvous floor
 * is strictly inside the band the rules pay, the last-chance height is the rules' floor
 * plus a frame, the aim height is inside the band. `SimChecks/CatchBandTests` binds each
 * to the live Swift symbol, so a drift on either side is red.
 *
 * **2. `predictCatchPoint` never returns a height the rules will not pay a catch at.**
 * The assertion the 6 August entry asked for, and it is not vacuous: the disc-peer
 * branch of that function reported the raw height of the first sample under the floor
 * while the glide branch clamped, so at a 1/30 s step on a descending disc it returned
 * heights well below its own floor — 47 % of 536 k rendezvous over the eleven canonical
 * matches, down to 0.013 m. The grid below is synthetic *on purpose*: descent rates are
 * swept past the point where one sample step crosses the whole band, which is the case
 * a match only produces occasionally and a fixture can produce every time.
 *
 * **3. The solver is never handed an aim plane the throw cannot reach.** The one the
 * entry did not ask for and the one that would have caught the second occurrence: a throw
 * that never rises above the aim plane cannot descend through it, and `probeThrow` answers
 * that case with the ground contact rather than an error. `Game.aiThrow` caps the plane
 * against its own release height, and the sweep below asserts at that seam — over release
 * heights a real roster produces — that the plane sits under the release and that the
 * flown flight rises above it. Before the cap moved out of `solveRelease`, the plane
 * handed in was `AIM_HEIGHT` unmodified and this was red for 1699 of 1699 live throws.
 *
 * -------------------------------------------------------------------- the honest limit
 *
 * `SOLVE_REACH` below flies the reference's own `DiscRuntime`, so it pins the reference's
 * answers; the Swift side re-flies the same asks through its own runtime and compares
 * within the tolerance the check states. The rendezvous grid is exact — it is arithmetic
 * on a synthesised path, with no integrator in it — so that half is bit-compared.
 */

import * as THREE from 'three';

import {
  PRONE_CATCH_FLOOR, STANDING_CATCH_FLOOR, CATCH_CONTEST_RADIUS,
} from '../../src/sim/Rules.ts';
import {
  AIM_HEIGHT, CATCH_CEILING, CATCH_DEAD, CATCH_FLOOR, CATCH_PLANE_DROP, HAND_HEIGHT,
  createTeamAI, maxThrowRange, throwFlightTime,
  type AIPlayer, type AIWorld, type CatchPoint, type FlightSample,
} from '../../src/sim/AI.ts';
import { SOLVE_CATCH_DROP, solveRelease } from '../../src/sim/aero/ThrowSolver.ts';
import { SeededRng, type AttackDir } from '../../src/sim/Playbook.ts';
import { DiscRuntime, type ThrowRequest } from '../../src/sim/DiscRuntime.ts';
import { powerForSpeed } from '../../src/sim/aero/Throws.ts';

const clampNum = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const DT = 1 / 120;

/* ------------------------------------------------------------------ the band itself */

function band(): Record<string, number> {
  return {
    // The rules layer, which owns it.
    STANDING_CATCH_FLOOR,
    PRONE_CATCH_FLOOR,
    CATCH_CONTEST_RADIUS,
    // The AI's rendezvous band, which must sit inside it.
    CATCH_FLOOR,
    CATCH_CEILING,
    CATCH_DEAD,
    // The aim, and the two numbers it is derived from.
    AIM_HEIGHT,
    HAND_HEIGHT,
    CATCH_PLANE_DROP,
    // The solver's own drop, which must agree with the AI's.
    SOLVE_CATCH_DROP,
  };
}

/* -------------------------------------------------------- the rendezvous grid, exact */

/**
 * A straight-line descending flight, sampled the way `DiscRuntime.predictPath` samples.
 *
 * Deliberately not an integrator. The property under test is what `predictCatchPoint`
 * does with a path, and an integrator would make the fixture a test of the integrator
 * instead — and would hide the case that matters, which is a sample step big enough to
 * skip the whole band. Both engines build this from the same four multiplications in the
 * same order, so the path is bit-identical before `predictCatchPoint` ever sees it.
 */
function syntheticPath(y0: number, vy: number, vz: number, step: number): FlightSample[] {
  const out: FlightSample[] = [];
  for (let i = 0; i <= 180; i++) {
    const t = i * step;
    out.push({ t, x: 0, y: y0 + vy * t, z: vz * t });
  }
  return out;
}

/** Start heights, descent rates and horizontal speeds. */
const Y0 = [3.2, 2.0, 1.5, 1.2, 0.95];
const VY = [-1.5, -3.0, -6.0, -12.0, -24.0];
const VZ = [6, 14, 24];
const STEP = 1 / 30;

function rendezvous(): unknown[] {
  const rng = new SeededRng(4040);
  const ai = createTeamAI(0, 1 as AttackDir, rng.fork(1), {
    formation: 'vertical', force: 'forehand', aggression: 1, zoneBias: 0, seed: 1,
  });
  const out: unknown[] = [];
  let id = 0;
  for (const y0 of Y0) {
    for (const vy of VY) {
      for (const vz of VZ) {
        const path = syntheticPath(y0, vy, vz, STEP);
        const world = {
          time: 0,
          players: [] as AIPlayer[],
          disc: {
            pos: { x: 0, y: y0, z: 0 }, vel: { x: 0, y: vy, z: vz },
            state: 'flight', carrier: null, thrownBy: -1, intendedReceiver: -1, stall: 0,
          },
          possession: 0,
          phase: 'live',
          wind: { x: 0, z: 0 },
          score: [0, 0],
          scoreCap: 15,
          rand: rng.fork(2),
          sys: {
            disc: {
              predictPath: (_s: unknown, _h: number, _st: number) => path,
            },
          },
        } as unknown as AIWorld;
        // `predictCatchPoint` is private to `TeamAI`; the fixture reaches it directly
        // rather than through a whole team update, because what is under test is the
        // scan and not the twenty decisions downstream of it. A rename breaks the
        // generator loudly, which is the only guarantee a cast can offer.
        const cp = (ai as unknown as {
          predictCatchPoint(w: AIWorld): CatchPoint;
        }).predictCatchPoint(world);
        out.push({
          id: id++, y0, vy, vz, step: STEP,
          y: cp.y, z: cp.z, t: cp.t, lastZ: cp.lastZ, lastT: cp.lastT,
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------ the solve, and whether it is reachable */

/** A fixed arm, so the fixture does not move when the roster generator does. */
const arm = {
  id: 0, team: 0, energy: 1,
  attr: {
    throwPower: 70, speed: 70, acceleration: 70, agility: 70, catching: 70,
    jumping: 70, defAwareness: 70, decision: 70, stamina: 70, height: 180,
  },
} as unknown as AIPlayer;

/**
 * Release heights a real roster actually produces.
 *
 * `Locomotion` puts the hip at `0.53 * height` and `Game.releaseOrigin` puts the hand at
 * `hipHeight * 1.10`, over a roster drawn around 1.72-1.90 m — so 1.00 to 1.11 m, with
 * the AI's own model (`HAND_HEIGHT`) at 1.05 in the middle. **The throwsolver fixture
 * sweeps a release of 1.35 m**, which is why it never saw this: at 1.35 m of release a
 * 1.35 m ask clamps to 1.10 and the crossing test fires. The bug needs a real body.
 */
const RELEASES = [1.00, 1.05, 1.11];
const TYPES = ['backhand', 'forehand', 'hammer', 'scoober', 'push'] as const;
const FRACTIONS = [0.1, 0.3, 0.5, 0.9];

function solves(): unknown[] {
  const probeRt = new DiscRuntime();
  const flyRt = new DiscRuntime();
  const out: unknown[] = [];
  let id = 0;

  for (const fromY of RELEASES) {
    for (const type of TYPES) {
      const reach = maxThrowRange(arm, type as never, 0);
      for (const fraction of FRACTIONS) {
        const want = reach * fraction;
        if (want < 0.4) continue;
        const from = new THREE.Vector3(0, fromY, 0);
        const speed = want / Math.max(0.2, throwFlightTime(arm, type as never, want));
        const spin = clampNum(0.45 + 0.55 * (arm.attr.throwPower / 100), 0, 1);
        const power = clampNum(powerForSpeed(type as never, speed) * 1.02, 0.12, 1);
        // Exactly what `Game.aiThrow` does with the AI's ask: cap it against the
        // release height *here*, at the site that knows it, rather than leaving
        // `solveRelease` to repair it silently.
        const plane = clampNum(AIM_HEIGHT, STANDING_CATCH_FLOOR, fromY - SOLVE_CATCH_DROP);

        const req = {
          type, from, aim: new THREE.Vector3(), power, angle: 0.02, spin,
          hand: 'R', bank: 0,
        } as unknown as ThrowRequest;
        solveRelease(probeRt, req, 0, want, plane);

        flyRt.release(req);
        let peak = -Infinity;
        let closest = Infinity;
        for (let i = 0; i < 120 * 8; i++) {
          flyRt.step(DT);
          if (flyRt.state.pos.y > peak) peak = flyRt.state.pos.y;
          const d = Math.hypot(flyRt.state.pos.x - 0, flyRt.state.pos.z - want);
          if (d < closest) closest = d;
          if (flyRt.state.atRest) break;
        }
        // `asked` is what the AI wants and `plane` is what the solver is handed.
        // Before the cap moved to the call site those were the same number, and it
        // was above the release on every throw in the game.
        out.push({ id: id++, fromY, type, want, asked: AIM_HEIGHT, plane, peak, closest });
      }
    }
  }
  return out;
}

export function catchBandGoldens(): unknown {
  return {
    note:
      'Issue #4 — the catch height band, its consumers, and the two invariants that '
      + 'keep them one band. Generated by tools/goldens/catchband.ts; asserted by '
      + 'swift/Sources/SimChecks/CatchBandTests.swift.',
    band: band(),
    rendezvous: rendezvous(),
    solves: solves(),
  };
}
