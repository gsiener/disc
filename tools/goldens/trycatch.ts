/**
 * Goldens for the catch decision — `Game.ts:tryCatch`, lines 1798-1892.
 *
 * The second differential fixture for the integration layer, and the one mutation
 * testing asked for by name: with 2.2 million assertions green, the defender
 * attacking gate could be deleted, the catch roll replaced with certainty, the
 * `p * 0.55` interception split flattened, and `CATCH_REACH` widened from 0.82 m
 * to 2 m — all silently, because every assertion was a component golden and this
 * is the function that decides what the components add up to: every catch, drop,
 * block and interception in the game.
 *
 * `tryCatch` is private to `GameSystem` and welded to Locomotion and GameState, so
 * — as with `aiThrow` in throwsolver.ts — the decision is transcribed here against
 * plain values, and the one numerical dependency, `catchProbability`, is imported
 * from the reference rather than copied. The Swift side extracts the identical
 * seam (`CatchDecision.decide`), so both languages test the same function shape.
 *
 * The scenarios are hand-built rather than swept combinatorially, one per branch
 * that has to survive: the eligibility geometry (reach, height window, layout
 * stretch), the passive-defender gate at 0.55 m, taker selection under the
 * defence's +0.25 score penalty, the difficulty sum (height, layout, contest,
 * speed), and every roll outcome — catch, drop, "keeps flying" at full stretch,
 * interception vs block vs through, pull catch/drop/touch. Each scenario is
 * evaluated at a fixed grid of rolls so the fixture pins the *thresholds*, not
 * just one draw: a mutation that moves `p`, the 0.55 split, or the 0.85 drop
 * line flips a recorded outcome somewhere on the grid.
 */

import { catchProbability, type AIPlayer } from '../../src/sim/AI.ts';

const clampNum = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** How close a passive defender must be to be in the catch at all. `Game.ts`. */
const PASSIVE_DEFENDER_GAP = 0.55;
const CATCH_REACH = 0.82;
const LAYOUT_REACH = 1.55;
/** What a full-extension bid costs, scaled across the reach band. `Game.ts`. */
const LAYOUT_STRETCH = 0.90;

interface Body {
  id: number;
  team: number;
  x: number;
  z: number;
  state: string;
  prone: boolean;
  airborne: boolean;
  groundY: number;
  hipHeight: number;
  reachTop: number;
  attacking: boolean;
  catching: number;
  energy: number;
}

/** The roll grid every scenario is evaluated at. Dense enough that any plausible
 * shift of `p`, the interception split or the drop threshold crosses a point. */
const ROLLS = [0.02, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.98];

function scratch(b: Body): AIPlayer {
  return { id: b.id, team: b.team, energy: b.energy, attr: { catching: b.catching } } as unknown as AIPlayer;
}

/** The transcription of the decision in `tryCatch`. Every constant is the
 * reference's; the shape matches Swift's `CatchDecision.decide`. */
function decide(
  disc: { x: number; y: number; z: number; vx: number; vy: number; vz: number },
  pull: boolean, offence: number | null, bodies: Body[], roll: number,
): { taker: number; outcome: string; difficulty: number; p: number; laidOut: boolean; contest: number } | null {
  let best: Body | null = null;
  let bestScore = Infinity;
  let bestHigh = 0;
  let bestLaidOut = false;
  let bestReach = 0;

  for (const b of bodies) {
    if (b.state === 'fall' || b.state === 'recovery') continue;
    const laidOut = b.state === 'layout' || (b.prone && b.airborne);
    const gap = Math.hypot(disc.x - b.x, disc.z - b.z);
    if (gap > (laidOut ? LAYOUT_REACH : CATCH_REACH)) continue;
    const top = b.reachTop + 0.16;
    const bot = b.groundY + (laidOut ? 0.02 : 0.20);
    if (disc.y > top || disc.y < bot) continue;
    if (b.team !== offence) {
      if (!b.attacking && gap > PASSIVE_DEFENDER_GAP) continue;
    }
    const high = clampNum((disc.y - (b.groundY + b.hipHeight + 0.35)) / 0.9, 0, 1);
    const score = gap + high * 0.4 + (b.team === offence ? 0 : 0.25);
    if (score < bestScore) {
      bestScore = score; best = b; bestHigh = high; bestLaidOut = laidOut; bestReach = gap;
    }
  }
  if (!best) return null;

  const speed = Math.hypot(disc.vx, disc.vy, disc.vz);
  /**
   * The contest that prices DIFFICULTY applies the same gate the block does: a
   * defender who is not playing the disc cannot take it, cannot deflect it and
   * does nothing to the receiver's hands. See `Game.catchContest`, which is a
   * different question from `contestCount` — that one asks whether the disc came
   * down in a crowd, which is what decides whether a call is available.
   */
  let contest = 0;
  for (const b of bodies) {
    if (b.team === best.team) continue;
    const gap = Math.hypot(b.x - disc.x, b.z - disc.z);
    if (gap >= 1.9) continue;
    if (!b.attacking && gap > PASSIVE_DEFENDER_GAP) continue;
    contest++;
  }
  contest = Math.min(2, contest) * 0.30;
  const stretch = bestLaidOut
    ? LAYOUT_STRETCH * clampNum((bestReach - CATCH_REACH) / (LAYOUT_REACH - CATCH_REACH), 0, 1)
    : 0;
  const difficulty = clampNum(
    0.12 + bestHigh * 0.55 + stretch + contest
    + clampNum((speed - 17) / 22, 0, 0.45),
    0, 1.7,
  );
  let p = catchProbability(scratch(best), difficulty);
  if (best.team !== offence) p *= 0.62;

  const r = (outcome: string) => ({ taker: best.id, outcome, difficulty, p, laidOut: bestLaidOut, contest });
  if (best.team !== offence) {
    if (pull) return r(roll < p ? 'pull-touch' : 'none');
    if (roll < p * 0.55) return r('interception');
    if (roll < p) return r('block');
    return r('none');
  }
  if (roll < p) return r(pull ? 'pull-catch' : 'catch');
  if (difficulty < 0.85) return r(pull ? 'pull-drop' : 'drop');
  return r('none');
}

/** A standing body with sane heights. Standing reach for a ~1.8 m frame. */
function body(o: Partial<Body> & { id: number; team: number }): Body {
  return {
    x: 0, z: 0, state: 'run', prone: false, airborne: false,
    groundY: 0, hipHeight: 0.95, reachTop: 2.35, attacking: false,
    catching: 70, energy: 1,
    ...o,
  };
}

interface Scenario {
  name: string;
  disc: { x: number; y: number; z: number; vx: number; vy: number; vz: number };
  pull: boolean;
  offence: number | null;
  bodies: Body[];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'routine chest-high catch, lone receiver',
    disc: { x: 0.3, y: 1.2, z: 0, vx: 10, vy: 0, vz: 4 },
    pull: false, offence: 0,
    bodies: [body({ id: 1, team: 0 })],
  },
  {
    name: 'high disc raises difficulty',
    disc: { x: 0.2, y: 2.2, z: 0.2, vx: 12, vy: -2, vz: 3 },
    pull: false, offence: 0,
    bodies: [body({ id: 1, team: 0 })],
  },
  {
    name: 'a layout on a slow disc is hard but still droppable — difficulty 0.67',
    disc: { x: 1.2, y: 0.6, z: 0.3, vx: 15, vy: -1, vz: 6 },
    pull: false, offence: 0,
    bodies: [body({ id: 1, team: 0, state: 'layout', airborne: true, groundY: 0, hipHeight: 0.4, reachTop: 1.4 })],
  },
  {
    name: 'a layout on a hot disc crosses 0.85: a miss keeps flying, never a drop',
    disc: { x: 1.2, y: 0.6, z: 0.3, vx: 24, vy: -1, vz: 8 },
    pull: false, offence: 0,
    bodies: [body({ id: 1, team: 0, state: 'layout', airborne: true, groundY: 0, hipHeight: 0.4, reachTop: 1.4 })],
  },
  {
    name: 'layout reach takes a disc a standing body cannot',
    disc: { x: 1.1, y: 0.9, z: 0, vx: 13, vy: 0, vz: 5 },
    pull: false, offence: 0,
    bodies: [
      body({ id: 1, team: 0, x: 0, state: 'layout', airborne: true, hipHeight: 0.4, reachTop: 1.4 }),
      body({ id: 2, team: 0, x: 2.3 }),
    ],
  },
  {
    name: 'standing gap 1.0 is out of reach — pins CATCH_REACH',
    disc: { x: 1.0, y: 1.2, z: 0, vx: 10, vy: 0, vz: 4 },
    pull: false, offence: 0,
    bodies: [body({ id: 1, team: 0 })],
  },
  {
    name: 'disc above everyone — no taker',
    disc: { x: 0.2, y: 2.7, z: 0, vx: 9, vy: 1, vz: 3 },
    pull: false, offence: 0,
    bodies: [body({ id: 1, team: 0 }), body({ id: 2, team: 1, x: 0.4, attacking: true })],
  },
  {
    name: 'disc at the ankles of a standing body — below the window',
    disc: { x: 0.2, y: 0.12, z: 0, vx: 8, vy: -1, vz: 2 },
    pull: false, offence: 0,
    bodies: [body({ id: 1, team: 0 })],
  },
  {
    name: 'passive defender inside a body width can play it',
    disc: { x: 0.3, y: 1.3, z: 0, vx: 14, vy: 0, vz: 5 },
    pull: false, offence: 0,
    bodies: [body({ id: 9, team: 1, x: 0.1 })],
  },
  {
    name: 'passive defender at 0.7 m is gated out — pins the 0.55 gate',
    disc: { x: 0.0, y: 1.3, z: 0, vx: 14, vy: 0, vz: 5 },
    pull: false, offence: 0,
    bodies: [body({ id: 9, team: 1, x: 0.7 })],
  },
  {
    name: 'attacking defender at 0.7 m: interception / block / through',
    disc: { x: 0.0, y: 1.4, z: 0, vx: 16, vy: 0, vz: 6 },
    pull: false, offence: 0,
    bodies: [body({ id: 9, team: 1, x: 0.7, attacking: true })],
  },
  {
    name: 'receiver and attacking defender both on it — the +0.25 penalty decides',
    disc: { x: 0.0, y: 1.3, z: 0, vx: 13, vy: 0, vz: 5 },
    pull: false, offence: 0,
    bodies: [
      body({ id: 1, team: 0, x: 0.5 }),
      body({ id: 9, team: 1, x: 0.45, attacking: true }),
    ],
  },
  {
    name: 'defender clearly first to the disc takes it despite the penalty',
    disc: { x: 0.0, y: 1.3, z: 0, vx: 13, vy: 0, vz: 5 },
    pull: false, offence: 0,
    bodies: [
      body({ id: 1, team: 0, x: 0.78 }),
      body({ id: 9, team: 1, x: 0.15, attacking: true }),
    ],
  },
  {
    name: 'two markers inside 1.9 m make it a contest',
    disc: { x: 0.2, y: 1.4, z: 0, vx: 12, vy: 0, vz: 4 },
    pull: false, offence: 0,
    bodies: [
      body({ id: 1, team: 0 }),
      body({ id: 9, team: 1, x: 1.2, z: 0.5 }),
      body({ id: 10, team: 1, x: -1.0, z: -0.8 }),
      body({ id: 11, team: 1, x: 1.7, z: 0.6 }),
    ],
  },
  {
    name: 'a hot disc: speed past 17 m/s stacks difficulty',
    disc: { x: 0.3, y: 1.5, z: 0, vx: 24, vy: -1, vz: 9 },
    pull: false, offence: 0,
    bodies: [body({ id: 1, team: 0 })],
  },
  {
    name: 'bodies mid-fall and mid-recovery cannot take it',
    disc: { x: 0.2, y: 1.2, z: 0, vx: 10, vy: 0, vz: 4 },
    pull: false, offence: 0,
    bodies: [
      body({ id: 1, team: 0, state: 'fall' }),
      body({ id: 2, team: 0, x: 0.3, state: 'recovery' }),
      body({ id: 3, team: 0, x: 0.6 }),
    ],
  },
  {
    name: 'prone and airborne counts as laid out without the state name',
    disc: { x: 1.3, y: 0.5, z: 0, vx: 14, vy: -2, vz: 5 },
    pull: false, offence: 0,
    bodies: [body({ id: 1, team: 0, state: 'jump', prone: true, airborne: true, hipHeight: 0.4, reachTop: 1.3 })],
  },
  {
    name: 'butter-fingered and tired receiver',
    disc: { x: 0.4, y: 1.8, z: 0.2, vx: 15, vy: -1, vz: 6 },
    pull: false, offence: 0,
    bodies: [body({ id: 1, team: 0, catching: 45, energy: 0.55 })],
  },
  {
    name: 'sure hands at full energy',
    disc: { x: 0.4, y: 1.8, z: 0.2, vx: 15, vy: -1, vz: 6 },
    pull: false, offence: 0,
    bodies: [body({ id: 1, team: 0, catching: 92 })],
  },
  {
    name: 'pull: the receiving team catches or drops it',
    disc: { x: 0.3, y: 1.6, z: 0, vx: 9, vy: -3, vz: 8 },
    pull: true, offence: 1,
    bodies: [body({ id: 8, team: 1 })],
  },
  {
    name: 'pull: the pulling team touching it is WFDF 12.5, at any roll under p',
    disc: { x: 0.2, y: 1.4, z: 0, vx: 9, vy: -3, vz: 8 },
    pull: true, offence: 1,
    bodies: [body({ id: 2, team: 0, x: 0.1, attacking: true })],
  },
  {
    name: 'a contested jump ball above the hips',
    disc: { x: 0.1, y: 2.3, z: 0, vx: 11, vy: -2, vz: 4 },
    pull: false, offence: 0,
    bodies: [
      body({ id: 1, team: 0, x: 0.2, state: 'jump', airborne: true, reachTop: 2.75 }),
      body({ id: 9, team: 1, x: 0.35, state: 'jump', airborne: true, attacking: true, reachTop: 2.8 }),
    ],
  },
];

export function tryCatchGoldens(): unknown {
  return {
    note:
      'Game.ts:tryCatch as a pure decision, evaluated on hand-built scenarios at a '
      + 'fixed grid of rolls. The decision logic is transcribed in '
      + 'tools/goldens/trycatch.ts (tryCatch is private and welded to Locomotion); '
      + 'catchProbability is imported from the reference. Swift mirrors the seam as '
      + 'CatchDecision.decide. difficulty and p are compared to 1e-12 rather than '
      + 'bit-exactly: the disc speed goes through Math.hypot here and Vec3d.length '
      + 'there, and the two round a genuine ulp apart. Everything downstream is '
      + 'multiply-add-clamp, so an ulp stays an ulp.',
    rolls: ROLLS,
    scenarios: SCENARIOS.map((s) => {
      const first = decide(s.disc, s.pull, s.offence, s.bodies, ROLLS[0]);
      return {
        name: s.name,
        disc: s.disc,
        pull: s.pull,
        offence: s.offence,
        bodies: s.bodies,
        taker: first ? first.taker : null,
        difficulty: first ? first.difficulty : null,
        p: first ? first.p : null,
        // The two facts `decide` knows and used not to hand out. `Engine.grade` on the
        // Swift side re-derived both by hand off the same body array, which is how the
        // grade came to be asking `contestCount` — a different question — while its own
        // comment claimed it was asking this one. Recorded here so the port cannot drift
        // from the decision again without a golden moving.
        laidOut: first ? first.laidOut : null,
        contest: first ? first.contest : null,
        outcomes: ROLLS.map((roll) => {
          const d = decide(s.disc, s.pull, s.offence, s.bodies, roll);
          return d ? d.outcome : 'no-taker';
        }),
      };
    }),
  };
}
