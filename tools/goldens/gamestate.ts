/**
 * Goldens for the `GameState` port.
 *
 * `GameState` is a state machine, not a formula, so the fixture is not a table of
 * inputs and outputs — it is a **script**. Each scenario is a list of actions, and
 * after every single action the reference's snapshot, its return value and every
 * event it emitted are recorded. The Swift side replays the identical script and
 * compares all three.
 *
 * Why that shape and not spot-checks of individual methods:
 *
 *  - The bugs worth catching in a state machine are *ordering* bugs. A method that
 *    is correct in isolation and sets a flag one line too late produces a machine
 *    that works until the third turnover. Only a trace catches that.
 *  - Rejections are behaviour. `release()` in the wrong phase must return
 *    `{ok: false}` and change nothing, and a port that quietly allowed it would pass
 *    any fixture that only exercised legal sequences. So the scripts deliberately
 *    attempt illegal actions and record the refusal.
 *  - Emitted events are the renderer's entire contract with the sim. A renamed or
 *    reordered event breaks the game without changing a single number, so the event
 *    names and their order are compared too.
 *
 * Both formats are scripted. The reference hardcodes seven a side and a module-level
 * `FIELD`; the Swift port threads a `GameFormat` instead, and the only way to know
 * that rewrite did not change regulation behaviour is to run the regulation script
 * through both and compare. The minis scenarios then check the parameterisation
 * actually took, using the same geometry `GameFormat.minis` declares.
 */

import { GameState, type CallType } from '../../src/sim/GameState.ts';
import { FIELD } from '../../src/sim/Rules.ts';

/** Spelled inline in the reference's signature rather than exported. */
type PullSpotChoice = 'brick' | 'sideline';

type V = [number, number, number];

/** One scripted action. Mirrored exactly by `GameStateTests.Action` in Swift. */
type Action =
  | { op: 'startGame' }
  | { op: 'setLine'; team: 0 | 1; ids: number[] }
  | { op: 'step'; dt: number }
  | { op: 'pull'; puller: number; from: V; vel?: V }
  | { op: 'pullCaught'; player: number; at: V }
  | { op: 'pullDropped'; player: number; at: V }
  | { op: 'pullLanded'; at: V }
  | { op: 'pullOutOfBounds'; crossing: V; choice?: PullSpotChoice }
  | { op: 'choosePullSpot'; choice: PullSpotChoice }
  | { op: 'pickUp'; player: number; at?: V }
  | { op: 'check' }
  | { op: 'setPivot'; at: V }
  | { op: 'release'; player?: number; pos?: V; vel?: V }
  | { op: 'catch'; player: number; at: V }
  | { op: 'drop'; player: number; at: V }
  | { op: 'ground'; at: V }
  | { op: 'outOfBounds'; crossing: V }
  | { op: 'caughtOutOfBounds'; player: number; at: V }
  | { op: 'block'; defender: number; at: V }
  | { op: 'advanceAfterScore' }
  | { op: 'resumeFromHalftime' }
  | { op: 'callTimeout'; team: 0 | 1; player?: number }
  | { op: 'endTimeout' }
  | { op: 'makeCall'; type: CallType; caller: number; against: number; at?: V }
  | { op: 'resolveCall'; contested: boolean; receiver?: number }
  | { op: 'applySoftCap' }
  | { op: 'applyHardCap' };

function v(a: V) {
  return { x: a[0], y: a[1], z: a[2] };
}

/**
 * `defaultRoster` numbers a team from `team * 7`, so home is 0..6 and away is 7..13.
 *
 * Worth spelling out: the first version of this file assumed away was 100..106, and
 * every away id was therefore an unknown player. The machine correctly refused those
 * actions, so the fixture generated cleanly and recorded a scenario in which the pull
 * never happened. A golden can be perfectly self-consistent and still be a recording
 * of nothing.
 */
const H = (i: number) => i;
const A = (i: number) => 7 + i;

/**
 * A whole point, from pull to goal, on the regulation field.
 *
 * Written out longhand rather than generated because the *sequence* is the thing
 * under test. A loop would produce a trace with no turnover, no rejection and no
 * score, which is most of the machine.
 */
function pointScript(): Action[] {
  const gl = FIELD.GOAL_LINE;
  return [
    { op: 'startGame' },
    // The pull, caught cleanly.
    { op: 'pull', puller: A(0), from: [0, 1, -FIELD.END_LINE], vel: [0, 8, 20] },
    { op: 'step', dt: 2.0 },
    { op: 'pullCaught', player: H(0), at: [2, 1, -10] },

    // An illegal release before the check — must be refused and change nothing.
    { op: 'check' },
    { op: 'setPivot', at: [2, 0, -10] },

    // Two completions upfield.
    { op: 'release', player: H(0), pos: [2, 1, -10], vel: [0, 2, 14] },
    { op: 'step', dt: 1.2 },
    { op: 'catch', player: H(1), at: [4, 1, 6] },
    { op: 'release', player: H(1), pos: [4, 1, 6], vel: [3, 2, 12] },
    { op: 'step', dt: 1.0 },
    { op: 'catch', player: H(2), at: [8, 1, 20] },

    // A goal.
    { op: 'release', player: H(2), pos: [8, 1, 20], vel: [0, 2, 14] },
    { op: 'step', dt: 1.1 },
    { op: 'catch', player: H(3), at: [6, 1, gl + 4] },
    { op: 'advanceAfterScore' },
  ];
}

/** Every way a possession can end badly. */
function turnoverScript(): Action[] {
  return [
    { op: 'startGame' },
    { op: 'pull', puller: A(0), from: [0, 1, -FIELD.END_LINE], vel: [0, 8, 20] },
    { op: 'step', dt: 2.0 },
    { op: 'pullCaught', player: H(0), at: [0, 1, -10] },
    { op: 'check' },

    // Thrown away — grounded in bounds.
    { op: 'release', player: H(0), pos: [0, 1, -10], vel: [0, 2, 12] },
    { op: 'step', dt: 1.4 },
    { op: 'ground', at: [1, 0, 4] },

    // The other team picks it up where it landed and throws it out of bounds.
    { op: 'pickUp', player: A(1), at: [1, 0, 4] },
    { op: 'check' },
    { op: 'release', player: A(1), pos: [1, 1, 4], vel: [20, 2, 0] },
    { op: 'step', dt: 0.8 },
    { op: 'outOfBounds', crossing: [FIELD.SIDELINE, 0, 6] },

    // Back the other way: a drop.
    { op: 'pickUp', player: H(2) },
    { op: 'check' },
    { op: 'release', player: H(2), vel: [0, 2, 10] },
    { op: 'step', dt: 0.9 },
    { op: 'drop', player: H(3), at: [2, 1, 12] },

    // And an interception.
    { op: 'pickUp', player: A(2) },
    { op: 'check' },
    { op: 'release', player: A(2), vel: [0, 2, -10] },
    { op: 'step', dt: 0.7 },
    { op: 'block', defender: H(4), at: [0, 1, 6] },
  ];
}

/**
 * The stall count, run to expiry.
 *
 * Stepped in uneven slices on purpose. The count is a `floor` of elapsed time with an
 * epsilon added *before* flooring, so a tick landing exactly on a boundary resolves
 * upward — a port that added the epsilon after, or used a different rounding, agrees
 * on round numbers and disagrees here.
 */
function stallScript(): Action[] {
  const acts: Action[] = [
    { op: 'startGame' },
    { op: 'pull', puller: A(0), from: [0, 1, -FIELD.END_LINE], vel: [0, 8, 20] },
    { op: 'step', dt: 2.0 },
    { op: 'pullCaught', player: H(0), at: [0, 1, -10] },
    { op: 'check' },
  ];
  for (const dt of [0.5, 0.5, 0.999, 0.001, 1.0, 0.3333333333333333, 2.0, 1.5, 1.0, 1.0, 1.0, 1.0]) {
    acts.push({ op: 'step', dt });
  }
  return acts;
}

/** Calls, contested and uncontested, plus timeouts. */
function callScript(): Action[] {
  return [
    { op: 'startGame' },
    { op: 'pull', puller: A(0), from: [0, 1, -FIELD.END_LINE], vel: [0, 8, 20] },
    { op: 'step', dt: 2.0 },
    { op: 'pullCaught', player: H(0), at: [0, 1, -10] },
    { op: 'check' },
    { op: 'step', dt: 3.0 },

    // A foul on the thrower, uncontested: play resumes where it was.
    { op: 'makeCall', type: 'foul', caller: H(0), against: A(1), at: [0, 1, -10] },
    { op: 'resolveCall', contested: false },
    { op: 'step', dt: 1.0 },

    // A travel call, contested.
    { op: 'makeCall', type: 'travel', caller: A(1), against: H(0) },
    { op: 'resolveCall', contested: true },

    // A timeout, then resume.
    { op: 'callTimeout', team: 0, player: H(0) },
    { op: 'endTimeout' },
    { op: 'check' },
    { op: 'step', dt: 2.0 },

    // A pick.
    { op: 'makeCall', type: 'pick', caller: H(1), against: A(2) },
    { op: 'resolveCall', contested: false },
  ];
}

/** A pull that sails out of bounds, and the receiving team's choice of spot. */
function pullOobScript(): Action[] {
  return [
    { op: 'startGame' },
    { op: 'pull', puller: A(0), from: [0, 1, -FIELD.END_LINE], vel: [25, 8, 20] },
    { op: 'step', dt: 1.5 },
    { op: 'pullOutOfBounds', crossing: [FIELD.SIDELINE, 0, 8] },
    { op: 'choosePullSpot', choice: 'brick' },
    { op: 'check' },
    { op: 'step', dt: 1.0 },
  ];
}

/** Caps and halftime — the game-length machinery. */
function capScript(): Action[] {
  return [
    { op: 'startGame' },
    { op: 'applySoftCap' },
    { op: 'step', dt: 1.0 },
    { op: 'applyHardCap' },
    { op: 'step', dt: 1.0 },
    { op: 'resumeFromHalftime' },
  ];
}

/** Actions that must be refused. Each one is attempted from a fresh game. */
function rejectionScript(): Action[] {
  return [
    // Nothing has started, so none of these may do anything.
    { op: 'release', player: H(0) },
    { op: 'catch', player: H(1), at: [0, 1, 0] },
    { op: 'block', defender: A(0), at: [0, 1, 0] },
    { op: 'check' },
    { op: 'drop', player: H(0), at: [0, 1, 0] },
    { op: 'endTimeout' },
    { op: 'resolveCall', contested: false },

    { op: 'startGame' },
    // Started, but the pull has not been thrown.
    { op: 'release', player: H(0) },
    { op: 'catch', player: H(1), at: [0, 1, 0] },
    { op: 'pickUp', player: H(0) },

    { op: 'pull', puller: A(0), from: [0, 1, -FIELD.END_LINE], vel: [0, 8, 20] },
    // A second pull while the first is airborne.
    { op: 'pull', puller: A(1), from: [0, 1, -FIELD.END_LINE], vel: [0, 8, 20] },
    { op: 'step', dt: 2.0 },
    { op: 'pullCaught', player: H(0), at: [0, 1, -10] },
    // A release before the check.
    { op: 'release', player: H(0) },
    // An unknown player.
    { op: 'check' },
    { op: 'release', player: 9999 },
    // Someone else's player throwing.
    { op: 'release', player: A(3) },
    // More timeouts than the rules allow.
    { op: 'callTimeout', team: 0 },
    { op: 'endTimeout' },
    { op: 'callTimeout', team: 0 },
    { op: 'endTimeout' },
    { op: 'callTimeout', team: 0 },
    { op: 'endTimeout' },
    { op: 'callTimeout', team: 0 },
    { op: 'endTimeout' },
  ];
}

/*
 * There is deliberately no minis scenario here.
 *
 * The reference reads its geometry from a module-level `FIELD` fixed to the regulation
 * field, so running a minis script through it does not produce minis behaviour — it
 * produces regulation behaviour with minis-shaped inputs. A golden generated that way
 * would encode the wrong pitch as the truth and then assert the Swift port against it,
 * which is worse than not testing minis at all: it would fail the correct
 * implementation and pass a broken one.
 *
 * Minis is a Swift-side addition with no reference, so it is checked the only honest
 * way available — as properties of the geometry itself, in `GameStateTests.minis()`.
 */

function runScenario(label: string, format: 'sevens' | 'minis', actions: Action[]) {
  const events: { name: string }[] = [];
  // `emitPhysicsEvents` on, because the physics events are exactly the ones the
  // renderer consumes and therefore the ones a rename would break silently.
  const g = new GameState({
    rules: { emitPhysicsEvents: true },
    emit: (evt: string) => {
      events.push({ name: evt });
    },
  });

  const steps: unknown[] = [];
  for (const a of actions) {
    events.length = 0;
    let result: { ok: boolean; note?: string } | null = null;

    switch (a.op) {
      case 'startGame': g.startGame(); break;
      case 'setLine': g.setLine(a.team, a.ids); break;
      case 'step': g.step(a.dt); break;
      case 'pull': result = g.pull(a.puller, v(a.from), a.vel ? v(a.vel) : undefined); break;
      case 'pullCaught': result = g.pullCaught(a.player, v(a.at)); break;
      case 'pullDropped': result = g.pullDropped(a.player, v(a.at)); break;
      case 'pullLanded': result = g.pullLanded(v(a.at)); break;
      case 'pullOutOfBounds': result = g.pullOutOfBounds(v(a.crossing), a.choice); break;
      case 'choosePullSpot': result = g.choosePullSpot(a.choice); break;
      case 'pickUp': result = g.pickUp(a.player, a.at ? v(a.at) : undefined); break;
      case 'check': result = g.check(); break;
      case 'setPivot': g.setPivot(v(a.at)); break;
      case 'release':
        result = g.release({
          playerId: a.player,
          pos: a.pos ? v(a.pos) : undefined,
          vel: a.vel ? v(a.vel) : undefined,
        });
        break;
      case 'catch': result = g.catchDisc(a.player, v(a.at)); break;
      case 'drop': result = g.drop(a.player, v(a.at)); break;
      case 'ground': result = g.ground(v(a.at)); break;
      case 'outOfBounds': result = g.outOfBounds(v(a.crossing)); break;
      case 'caughtOutOfBounds': result = g.caughtOutOfBounds(a.player, v(a.at)); break;
      case 'block': result = g.block(a.defender, v(a.at)); break;
      case 'advanceAfterScore': g.advanceAfterScore(); break;
      case 'resumeFromHalftime': g.resumeFromHalftime(); break;
      case 'callTimeout': result = g.callTimeout(a.team, a.player); break;
      // Returns void in the reference, like setPivot and the caps.
      case 'endTimeout': g.endTimeout(); break;
      case 'makeCall':
        result = g.makeCall(a.type, a.caller, a.against, a.at ? v(a.at) : undefined);
        break;
      case 'resolveCall':
        result = g.resolveCall(a.contested, a.receiver !== undefined ? { receiverId: a.receiver } : undefined);
        break;
      case 'applySoftCap': g.applySoftCap(); break;
      case 'applyHardCap': g.applyHardCap(); break;
    }

    const s = g.snapshot();
    steps.push({
      op: a.op,
      ok: result === null ? null : result.ok,
      events: events.map((e) => e.name),
      snap: {
        phase: s.phase,
        clock: s.clock,
        point: s.point,
        half: s.half,
        score: s.score,
        possession: s.possession,
        thrower: s.thrower,
        stall: s.stall,
        attackDir: s.attackDir,
        pullingTeam: s.pullingTeam,
        target: s.target,
        cap: s.cap,
      },
    });
  }

  // Final stats, which are the accumulated consequence of the whole trace. A single
  // miscounted completion is invisible in any one snapshot and obvious here.
  const teams = [0, 1].map((t) => {
    const ts = g.teamStats(t as 0 | 1);
    return {
      score: ts.score, goals: ts.goals, assists: ts.assists, blocks: ts.blocks,
      attempts: ts.attempts, completions: ts.completions, throwaways: ts.throwaways,
      drops: ts.drops, stallOuts: ts.stallOuts,
      turnoversCommitted: ts.turnoversCommitted, turnoversForced: ts.turnoversForced,
      yardsThrown: ts.yardsThrown, yardsReceived: ts.yardsReceived,
      timeOfPossession: ts.timeOfPossession, possessions: ts.possessions,
    };
  });

  return { label, format, actions, steps, teams, logLines: g.getLog().length };
}

export function gameStateGoldens() {
  return {
    note:
      'Generated by tools/gen-goldens.ts from src/sim/GameState.ts. A scripted action '
      + 'trace: after every action the snapshot, the return value and the emitted event '
      + 'names are recorded. Clocks and yardages are sums of exact inputs and are '
      + 'compared bit-for-bit; the Swift side states a tolerance only where it can '
      + 'justify one.',
    scenarios: [
      runScenario('a point from pull to goal', 'sevens', pointScript()),
      runScenario('every way a possession ends badly', 'sevens', turnoverScript()),
      runScenario('the stall count to expiry', 'sevens', stallScript()),
      runScenario('calls and timeouts', 'sevens', callScript()),
      runScenario('a pull out of bounds', 'sevens', pullOobScript()),
      runScenario('soft cap, hard cap, halftime', 'sevens', capScript()),
      runScenario('actions that must be refused', 'sevens', rejectionScript()),
    ],
  };
}
