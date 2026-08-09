/**
 * Goldens for the AI's pure functions — `src/sim/AI.ts` lines 281–652.
 *
 * These are all functions of ratings and geometry with no state, so the fixture is a
 * table rather than a trace. The one thing that is *not* a plain function is
 * `makeAttributes`, and it is the most important entry here: it consumes a seeded RNG,
 * and **the order of its draws is behaviour**. The reference builds one object literal
 * and JavaScript evaluates its properties top to bottom, so reordering a single line
 * gives a different player from the same seed while still producing a completely
 * plausible one. A whole-sheet comparison from a fixed seed is what pins that.
 *
 * `tickStamina` mutates its player, so it is sampled as a short trace instead: the drain
 * and recover branches are on opposite sides of a load threshold, and a fixture that only
 * sampled one of them would miss a flipped comparison entirely.
 */

import {
  baseMaxSpeed, effectiveMaxSpeed, effectiveAccel, effectiveDecel, turnRateOf,
  reachHeight, layoutExtend, effectiveDecision,
  discStakes, shouldBid, possessionValue, maxThrowRange, throwFlightTime, throwReleaseSpeed,
  catchProbability, tickStamina, boundaryRoom, makeAttributes, makePlayer,
  THROW_TYPES, type ThrowType, type Archetype, type AIPlayer,
} from '../../src/sim/AI.ts';
import { SeededRng } from '../../src/sim/Playbook.ts';

const ARCHETYPES: Archetype[] = ['handler', 'cutter', 'deep', 'utility'];

/** A player with a known sheet, so the capability functions vary only in `energy`. */
function probe(energy: number): AIPlayer {
  const p = makePlayer(1, 0, 'cutter', new SeededRng(12345), 72);
  p.energy = energy;
  return p;
}

const ENERGIES = [0, 0.12, 0.25, 0.5, 0.75, 1, 1.5, -0.5];

export function aiMathGoldens() {
  // Capability: one row per energy, all eight functions, on one fixed rating sheet.
  const capability = ENERGIES.map((e) => {
    const p = probe(e);
    return {
      energy: e,
      baseMaxSpeed: baseMaxSpeed(p.attr),
      effectiveMaxSpeed: effectiveMaxSpeed(p),
      effectiveAccel: effectiveAccel(p),
      effectiveDecel: effectiveDecel(p),
      turnRateOf: turnRateOf(p),
      reachHeight: reachHeight(p),
      layoutExtend: layoutExtend(p),
      effectiveDecision: effectiveDecision(p),
    };
  });

  // The rating sheet itself, so the capability rows above are anchored to known inputs.
  const probeAttrs = probe(1).attr;

  // possessionValue across the whole range, including past 64 where the second term
  // takes over — that is the branch a clamp-at-64 port gets wrong while looking right.
  const possession: { yards: number; want: number }[] = [];
  for (let y = -10; y <= 100; y += 2) possession.push({ yards: y, want: possessionValue(y) });
  for (const y of [63.9, 64, 64.1, 81.9, 82, 82.1]) {
    possession.push({ yards: y, want: possessionValue(y) });
  }

  // discStakes on both attack directions, across and past the 25 m scale.
  const stakes: { z: number; dir: number; want: number }[] = [];
  for (let z = -60; z <= 60; z += 5) {
    for (const dir of [1, -1]) stakes.push({ z, dir, want: discStakes(z, dir as 1 | -1) });
  }

  // shouldBid over the full decision cube. Both sides of BID_LEAD, of standing reach
  // plus hesitation, and of extended reach.
  const bids: {
    energy: number; short: number; deadline: number; stakes: number; want: boolean;
  }[] = [];
  const p1 = probe(1);
  for (const short of [0, 0.5, 0.81, 0.82, 0.9, 1.0, 1.16, 1.17, 1.54, 1.55, 1.6, 3.0]) {
    for (const deadline of [-0.1, 0, 0.2, 0.44, 0.45, 0.46, 1.0]) {
      for (const st of [0, 0.5, 1, 1.5, -1]) {
        bids.push({
          energy: 1, short, deadline, stakes: st,
          want: shouldBid(p1, short, deadline, st),
        });
      }
    }
  }

  /**
   * Throw range, flight time and RELEASE SPEED across every type, both wind clamp edges.
   *
   * `throwReleaseSpeed` was in no fixture at all until now, and it decides how hard
   * every AI throw leaves the hand. Mutation-tested to prove it: the stretch term's
   * two smoothstep weights were changed in the Swift port alone and the whole suite
   * stayed green at 2.24 million assertions. The distances below are chosen to
   * evaluate it non-trivially — 20 m sits inside `smoothstep(15, 23, d)`, 25 m inside
   * `smoothstep(23, 40, d)`, 45 and 80 saturate both, 0 and 5 are under them — and the
   * type sweep is what evaluates the hammer's 0.8 zip factor, which the trace fixtures
   * never reached at all.
   */
  const throwRows: {
    type: ThrowType; energy: number; windAlong: number; d: number;
    range: number; flight: number; releaseSpeed: number;
  }[] = [];
  for (const type of THROW_TYPES) {
    for (const energy of [0.12, 0.6, 1]) {
      const p = probe(energy);
      for (const windAlong of [-20, -8, -3, 0, 3, 8, 20]) {
        throwRows.push({
          type, energy, windAlong, d: 25,
          range: maxThrowRange(p, type, windAlong),
          flight: throwFlightTime(p, type, 25),
          releaseSpeed: throwReleaseSpeed(p, type, 25),
        });
      }
      for (const d of [0, 5, 20, 45, 80]) {
        throwRows.push({
          type, energy, windAlong: 0, d,
          range: maxThrowRange(p, type, 0),
          flight: throwFlightTime(p, type, d),
          releaseSpeed: throwReleaseSpeed(p, type, d),
        });
      }
    }
  }

  // Catch probability, including both clamp rails and past the difficulty clamp.
  const catches: { energy: number; difficulty: number; want: number }[] = [];
  for (const energy of [0.12, 0.5, 1]) {
    const p = probe(energy);
    for (const difficulty of [-1, 0, 0.4, 1, 1.5, 1.8, 2.5]) {
      catches.push({ energy, difficulty, want: catchProbability(p, difficulty) });
    }
  }

  // tickStamina as a trace: mutation, and both branches of the load threshold. The
  // player's speed is set directly each step so the load is what we intend it to be.
  const staminaTrace: { step: number; speed: number; energy: number }[] = [];
  {
    const p = probe(1);
    const vmax = effectiveMaxSpeed(p);
    // Sprint hard, then stand still, then jog just under and just over the threshold.
    const plan = [
      ...Array(120).fill(1.0),
      ...Array(60).fill(0.0),
      ...Array(30).fill(0.41),
      ...Array(30).fill(0.43),
      ...Array(60).fill(1.2),
    ];
    plan.forEach((frac, i) => {
      p.vel.x = frac * vmax;
      p.vel.z = 0;
      tickStamina(p, 1 / 60);
      if (i % 10 === 0) staminaTrace.push({ step: i, speed: p.vel.x, energy: p.energy });
    });
    staminaTrace.push({ step: plan.length, speed: p.vel.x, energy: p.energy });
  }

  // boundaryRoom on a grid of positions and directions, including the degenerate
  // zero-length direction and the exact axis cases the epsilons branch on.
  const room: { px: number; pz: number; dx: number; dz: number; want: number }[] = [];
  for (const px of [-18, -5, 0, 5, 18]) {
    for (const pz of [-49, -20, 0, 20, 49]) {
      for (const [dx, dz] of [
        [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [0.6, -0.8], [0, 0],
        [1e-7, 1], [1, 1e-7],
      ]) {
        room.push({ px, pz, dx, dz, want: boundaryRoom(px, pz, dx, dz) });
      }
    }
  }

  // makeAttributes: the whole sheet, per archetype, per overall, from a fixed seed.
  // This is the entry that pins the RNG draw ORDER — reorder one line in the port and
  // every field below shifts.
  const sheets = ARCHETYPES.flatMap((archetype) =>
    [55, 72, 90].map((overall) => ({
      archetype, overall, seed: 777,
      attr: makeAttributes(new SeededRng(777), archetype, overall),
    })),
  );

  // makePlayer draws handedness from the same stream after the sheet, so a roster built
  // from one seed pins both the sheet order and the draw that follows it.
  const roster = ARCHETYPES.map((archetype) => {
    const rng = new SeededRng(4242);
    return Array.from({ length: 6 }, (_, i) => {
      const p = makePlayer(i, 0, archetype, rng, 72);
      return {
        id: p.id, archetype: p.archetype, handed: p.handed, role: p.role,
        energy: p.energy, attr: p.attr,
      };
    });
  });

  return {
    note:
      'Generated by tools/gen-goldens.ts from src/sim/AI.ts (lines 281-652). Pure '
      + 'arithmetic is bit-exact; Math.log/cos in gauss and Math.hypot in tickStamina '
      + 'and boundaryRoom get a stated tolerance. The makeAttributes sheets pin the RNG '
      + 'draw order, which is behaviour and not style.',
    probeAttrs,
    capability,
    possession,
    stakes,
    bids,
    throwRows,
    catches,
    staminaTrace,
    room,
    sheets,
    roster,
  };
}
