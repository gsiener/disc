/**
 * tools/test-rules.ts — numeric verification of src/sim/Rules.ts + GameState.ts
 *
 *   node tools/test-rules.ts            full run
 *   node tools/test-rules.ts --quiet    suppress the play-by-play
 *
 * Everything is driven at the engine's fixed 1/120 s timestep. No Math.random:
 * the scripted game uses a local xorshift seeded from a constant.
 */

import {
  FIELD, DEFAULT_RULES, makeRules, brickMark, boundaryCrossing, isInBounds, isGoal,
  isInEndzone, endzoneOf, goalLineZ, stallCountFor, resumeStallCount, markerStatus,
  putIntoPlaySpot, isTravel, effectiveTarget, isGameOver, distXZ, doubleTeamOffender,
  type Dir, type TeamId, type Vec3,
} from '../src/sim/Rules.ts';
import { GameState, computePlusMinus, type Phase, type PlayerStats } from '../src/sim/GameState.ts';

/* ---------------------------------------------------------------- harness */

const QUIET = process.argv.includes('--quiet');
let pass = 0;
let fail = 0;
const failures: string[] = [];
let section = '';

function group(name: string): void {
  section = name;
  console.log(`\n\x1b[1m── ${name} ──\x1b[0m`);
}
function ok(cond: boolean, label: string, detail = ''): void {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${label}${detail ? `  ${detail}` : ''}`); }
  else { fail++; failures.push(`[${section}] ${label} ${detail}`); console.log(`  \x1b[31mFAIL\x1b[0m ${label}  ${detail}`); }
}
function eq(actual: unknown, expected: unknown, label: string): void {
  ok(Object.is(actual, expected), label, `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}
function near(actual: number, expected: number, tol: number, label: string): void {
  ok(Math.abs(actual - expected) <= tol, label, `got ${actual.toFixed(6)} want ${expected.toFixed(6)} ±${tol}`);
}

/** Deterministic xorshift32 — no Math.random anywhere in this file. */
class R {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 1; }
  next(): number {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
  int(a: number, b: number): number { return a + Math.floor(this.next() * (b - a + 1)); }
}

const DT = 1 / 120;

/** Step at the engine timestep. Stops early when the phase changes. */
function advance(gs: GameState, seconds: number, stopOnPhaseChange = true): number {
  const start = gs.phase;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    gs.step(DT);
    if (stopOnPhaseChange && gs.phase !== start) return i + 1;
  }
  return n;
}
/** Step regardless of phase changes. */
function advanceThrough(gs: GameState, seconds: number): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) gs.step(DT);
}

function v(x: number, y: number, z: number): Vec3 { return { x, y, z }; }

/* ==================================================================== 1 */

group('1. Field geometry & rules constants');
{
  eq(FIELD.CENTRAL_LENGTH + 2 * FIELD.ENDZONE_DEPTH, FIELD.LENGTH, '64 + 18 + 18 = 100 m');
  eq(FIELD.GOAL_LINE, FIELD.CENTRAL_LENGTH / 2, 'goal line at |z| = 32');
  eq(FIELD.END_LINE, FIELD.LENGTH / 2, 'end line at |z| = 50');
  eq(FIELD.SIDELINE, FIELD.WIDTH / 2, 'sideline at |x| = 18.5');
  eq(FIELD.BRICK_Z, FIELD.GOAL_LINE - FIELD.BRICK_IN, 'brick 18 m in from the goal line -> |z| = 14');
  eq(DEFAULT_RULES.stallMax, 10, 'stall max = 10');
  eq(DEFAULT_RULES.markerRange, 3, 'marker must be within 3 m');
  eq(DEFAULT_RULES.gameTo, 15, 'game to 15');
  eq(DEFAULT_RULES.halftimeAt, 8, 'halftime at 8');

  ok(isInBounds(v(0, 0, 0)), 'centre is in bounds');
  ok(isInBounds(v(18.5, 0, 50)), 'corner (18.5, 50) is on the line = in');
  ok(!isInBounds(v(18.6, 0, 0)), 'x = 18.6 is out');
  ok(!isInBounds(v(0, 0, 50.1)), 'z = 50.1 is out');

  eq(endzoneOf(40), 1, 'z = 40 is the +Z endzone');
  eq(endzoneOf(-40), -1, 'z = -40 is the -Z endzone');
  eq(endzoneOf(0), 0, 'z = 0 is the playing field proper');
  ok(isInEndzone(v(0, 0, 32), 1), 'goal line counts as endzone');
  ok(isGoal(v(-10, 1, 45), 1), 'catch at z=45 attacking +Z is a goal');
  ok(!isGoal(v(-10, 1, 45), -1), 'same catch attacking -Z is not a goal');
  ok(!isGoal(v(-19, 1, 45), 1), 'catch outside the sideline is not a goal');

  eq(brickMark(1).z, -14, 'brick for a team attacking +Z is z = -14');
  eq(brickMark(-1).z, 14, 'brick for a team attacking -Z is z = +14');
  eq(brickMark(1).x, 0, 'brick sits on the centre line');
  eq(goalLineZ(1), 32, 'goalLineZ(+1) = 32');

  const c1 = boundaryCrossing(v(0, 0, 0), v(25, 0, 0));
  ok(!!c1 && c1.edge === 'sideline+x', 'straight-across exit hits the +x sideline');
  near(c1!.point.x, 18.5, 1e-12, '  crossing x');
  const c2 = boundaryCrossing(v(10, 0, 45), v(10, 0, 60));
  ok(!!c2 && c2.edge === 'endline+z', 'over the back exits the +z end line');
  near(c2!.point.z, 50, 1e-12, '  crossing z');
  const c3 = boundaryCrossing(v(0, 0, 0), v(37, 0, 60));
  ok(!!c3 && c3.edge === 'sideline+x', 'diagonal exits the sideline before the end line');
  near(c3!.point.x, 18.5, 1e-12, '  diagonal crossing x');
  near(c3!.point.z, 30, 1e-12, '  diagonal crossing z');
  eq(boundaryCrossing(v(0, 0, 0), v(1, 0, 1)), null, 'segment that stays inside never crosses');

  const r = makeRules();
  const walked = putIntoPlaySpot(v(4, 0, 44), 1 as Dir, r);
  near(walked.z, 32, 1e-12, 'possession gained in your attacking endzone is carried to the goal line');
  near(walked.x, 4, 1e-12, '  x is preserved');
  /**
   * USAU 12.A — the endzone you are DEFENDING. This is a different rule from
   * 12.B above and for a long time only 12.B was implemented, so an
   * interception in your own endzone was put into play where it was caught and
   * the offence started a possession pinned against its own end line.
   *
   * 12.A is a CHOICE: 12.A.1 establish a pivot on the spot, or 12.A.2 "carry
   * the disc directly to the closest point on the goal line and put it into
   * play at that spot". Both are legal, so this asserts the sim's choice rather
   * than a rule — and it asserts that the other choice is still reachable,
   * because a rule that offers two options and implements one is only half
   * modelled.
   */
  const own = putIntoPlaySpot(v(4, 0, -44), 1 as Dir, r);
  near(own.z, -32, 1e-12, 'possession in your defending endzone is walked out to the goal line (12.A.2)');
  near(own.x, 4, 1e-12, '  and x is preserved — the closest point is straight out');
  const stay = putIntoPlaySpot(v(4, 0, -44), 1 as Dir,
    makeRules({ walkOutOfDefendingEndzone: false }));
  near(stay.z, -44, 1e-12, 'and 12.A.1 — putting it into play on the spot — is still selectable');
  // The two endzone rules must not both fire, whichever end the disc is at.
  const far = putIntoPlaySpot(v(-9, 0, 47), -1 as Dir, r);
  near(far.z, 32, 1e-12, 'the defending-endzone walk works at the other end too');
  const mid = putIntoPlaySpot(v(0, 0, 10), 1 as Dir, r);
  near(mid.z, 10, 1e-12, 'and neither rule touches a disc between the goal lines');
  const clamped = putIntoPlaySpot(v(30, 0, 0), 1 as Dir, r);
  near(clamped.x, 18.5, 1e-12, 'out-of-bounds spot is brought to the perimeter line');
}

/* ==================================================================== 2 */

group('2. Stall arithmetic and marker legality');
{
  const r = makeRules();
  eq(stallCountFor(0, r), 0, 'no elapsed time = no count');
  eq(stallCountFor(0.999, r), 0, '0.999 s -> 0');
  eq(stallCountFor(1.0, r), 1, '1.000 s -> 1');
  eq(stallCountFor(9.999999, r), 9, '9.999999 s -> 9 (1e-9 s tolerance, no earlier)');
  eq(stallCountFor(10, r), 10, '10.000 s -> 10');
  eq(stallCountFor(99, r), 10, 'count is clamped at stallMax');
  eq(resumeStallCount(4, r), 5, 'stall resumes at reached + 1');
  eq(resumeStallCount(9, r), 9, 'resume is capped at 9');
  eq(resumeStallCount(10, r), 9, 'resume from 10 is still capped at 9');

  // Exact float behaviour of 1200 accumulations of 1/120.
  let acc = 0;
  for (let i = 0; i < 1200; i++) acc += DT;
  ok(Math.abs(acc - 10) < 1e-9, '1200 steps of 1/120 s sum to 10 s', `err ${(acc - 10).toExponential(2)}`);
  eq(stallCountFor(acc, r), 10, '  and that sum reads as stall 10');

  const thrower = v(0, 0, 0);
  eq(markerStatus(v(1.5, 0, 0), thrower, r), 'legal', 'marker 1.5 m away is legal');
  eq(markerStatus(v(3.5, 0, 0), thrower, r), 'out-of-range', 'marker 3.5 m away is out of range');
  eq(markerStatus(v(0.1, 0, 0), thrower, r), 'disc-space', 'marker 0.1 m away violates disc space');
  eq(markerStatus(null, thrower, r), 'none', 'no marker at all');
  ok(isTravel(v(0, 0, 0), v(0, 0, 0.5), r), '0.5 m pivot slip is a travel');
  ok(!isTravel(v(0, 0, 0), v(0, 0, 0.2), r), '0.2 m pivot slip is not');
}

/* ==================================================================== 3 */

group('3. Cap and game-over arithmetic');
{
  const r = makeRules();
  eq(effectiveTarget([5, 3], r, 'none'), 15, 'no cap -> target 15');
  eq(effectiveTarget([11, 9], r, 'soft'), 12, 'soft cap -> leader + 1');
  eq(effectiveTarget([11, 9], r, 'hard'), 12, 'hard cap -> leader + 1');
  ok(!isGameOver([14, 13], 15, r, 'none'), '14-13 is not over');
  ok(isGameOver([15, 13], 15, r, 'none'), '15-13 is over');
  const r2 = makeRules({ winBy: 2, pointCap: 17 });
  ok(!isGameOver([15, 14], 15, r2, 'none'), 'win-by-two: 15-14 keeps playing');
  ok(isGameOver([17, 16], 15, r2, 'none'), 'win-by-two: point cap 17 ends it');
}

/* ==================================================================== 4 */

group('4. Stall-out produces a turnover (driven at 1/120 s)');
{
  const events: { e: string; p: any }[] = [];
  const gs = new GameState({
    emit: (e, p) => events.push({ e, p }),
    teams: [{ name: 'RED' }, { name: 'BLU' }],
    startingPullTeam: 1, startingDirTeam0: 1,
  });
  gs.startGame();
  eq(gs.phase, 'PRE_PULL' as Phase, 'starts in PRE_PULL');
  gs.pull(7, v(0, 1, 32));
  eq(gs.phase, 'PULL_IN_FLIGHT' as Phase, 'pull -> PULL_IN_FLIGHT');
  eq(events.filter((x) => x.e === 'pull').length, 1, "emitted 'pull'");
  gs.catchDisc(0, v(2, 1, -27));
  eq(gs.phase, 'LIVE_POSSESSION' as Phase, 'catching the pull -> LIVE_POSSESSION');
  eq(gs.possession, 0, 'RED have it');
  eq(gs.thrower, 0, 'player 0 is the thrower');

  const before = events.length;
  advance(gs, 9.99, false);
  eq(gs.stallCount, 9, 'after 9.99 s the count is 9');
  eq(gs.phase, 'LIVE_POSSESSION' as Phase, 'still live at stall 9');
  advance(gs, 0.02, false);
  ok(gs.phase !== 'LIVE_POSSESSION', 'crossing 10.00 s ends the possession', `phase ${gs.phase}`);

  const ticks = events.slice(before).filter((x) => x.e === 'stall:tick');
  eq(ticks.length, 10, "10 'stall:tick' events");
  eq(ticks.map((t) => t.p.count).join(','), '1,2,3,4,5,6,7,8,9,10', '  counts are 1..10 in order');

  const to = events.slice(before).filter((x) => x.e === 'turnover');
  eq(to.length, 1, "one 'turnover' event");
  eq(to[0].p.reason, 'stall-out', '  reason is stall-out');
  eq(to[0].p.from, 0, '  lost by RED');
  eq(to[0].p.to, 1, '  gained by BLU');
  eq(gs.phase, 'TURNOVER_DEAD' as Phase, 'phase is TURNOVER_DEAD');
  eq(gs.possession, 1, 'BLU now have the disc');
  eq(gs.playerStats(0)!.stallOuts, 1, 'thrower charged with a stall-out');
  eq(gs.teamStats(0).turnoversCommitted, 1, 'RED committed one turnover');
  eq(gs.teamStats(1).turnoversForced, 1, 'BLU forced one turnover');
  eq(computePlusMinus(gs.playerStats(0)!), -1, 'stalled thrower is -1');
  near(gs.teamStats(0).timeOfPossession, 10.01, 0.03, 'RED time of possession ~10 s');

  // The dead disc needs a pick-up and a check before it is live again.
  gs.pickUp(7);
  eq(gs.phase, 'CHECK' as Phase, 'pick-up after a turnover requires a check');
  advance(gs, 2, false);
  eq(gs.stallCount, 0, 'the count does not run during a check');
  gs.check();
  eq(gs.phase, 'LIVE_POSSESSION' as Phase, 'check -> LIVE_POSSESSION');
  eq(gs.stallCount, 0, 'fresh possession starts at stall 0');
}

/* ==================================================================== 5 */

group('5. Marker range gates the stall count');
{
  const gs = new GameState({ startingPullTeam: 1, startingDirTeam0: 1 });
  gs.startGame();
  gs.pull(7, v(0, 1, 32));
  gs.catchDisc(0, v(0, 1, -27));
  gs.observe({ markerId: 7, markerPos: v(0, 0, -25.5), throwerPos: v(0, 0, -27) });
  ok(gs.markerLegal(), 'marker 1.5 m away is legal');
  advance(gs, 3.01, false);
  eq(gs.stallCount, 3, 'count runs to 3');

  gs.observe({ markerId: 7, markerPos: v(0, 0, -20), throwerPos: v(0, 0, -27) });
  ok(!gs.markerLegal(), 'marker backs off to 7 m -> illegal');
  advance(gs, 4, false);
  eq(gs.stallCount, 3, 'count is frozen while the marker is out of range');

  gs.observe({ markerId: 7, markerPos: v(0, 0, -25.5), throwerPos: v(0, 0, -27) });
  advance(gs, 1.01, false);
  eq(gs.stallCount, 4, 'count resumes when the marker returns');

  gs.observe({ markerId: null });
  advance(gs, 3, false);
  eq(gs.stallCount, 4, 'no marker at all -> no count');
}

/* ==================================================================== 6 */

group('6. A complete point: pull, passes, goal, swap');
{
  const events: { e: string; p: any }[] = [];
  const lines: string[] = [];
  const gs = new GameState({
    emit: (e, p) => events.push({ e, p }),
    teams: [{ name: 'RED' }, { name: 'BLU' }],
    startingPullTeam: 1, startingDirTeam0: 1,
    onLog: (l) => lines.push(`  [${l.t.toFixed(2).padStart(6)}s ${l.phase.padEnd(15)}] ${l.text}`),
  });
  gs.startGame();
  const dir0 = gs.attackDir[0];
  eq(dir0, 1 as Dir, 'RED attack +Z on the opening point');
  eq(gs.pullingTeam, 1, 'BLU pull to open');

  gs.pull(7, v(0, 1.5, 32), v(0, 4, -30));
  gs.catchDisc(0, v(3, 1.2, -28));      // pull caught 4 m off their own goal line
  advance(gs, 1.5, false);
  gs.release({ playerId: 0, pos: v(3, 1.2, -28), vel: v(0, 0, 18), throwType: 'backhand' });
  gs.catchDisc(1, v(-6, 1.4, -8));      // +20 m
  advance(gs, 2.0, false);
  gs.release({ playerId: 1, pos: v(-6, 1.4, -8), throwType: 'flick' });
  gs.catchDisc(2, v(8, 1.1, 6));        // +14 m
  advance(gs, 1.0, false);
  gs.release({ playerId: 2, pos: v(8, 1.1, 6), throwType: 'hammer' });
  gs.catchDisc(3, v(-2, 1.6, 38));      // goal, +32 m

  eq(gs.phase, 'POINT_SCORED' as Phase, 'catch in the attacking endzone -> POINT_SCORED');
  eq(gs.score[0], 1, 'RED lead 1-0');
  const sc = events.filter((x) => x.e === 'score');
  eq(sc.length, 1, "one 'score' event");
  eq(sc[0].p.team, 0, '  scored by team 0');
  eq(sc[0].p.playerId, 3, '  scored by player 3');
  eq(sc[0].p.assistId, 2, '  assisted by player 2');
  eq(gs.playerStats(3)!.goals, 1, 'player 3 credited a goal');
  eq(gs.playerStats(2)!.assists, 1, 'player 2 credited an assist');
  eq(gs.playerStats(1)!.hockeyAssists, 1, 'player 1 credited a hockey assist');
  eq(gs.teamStats(0).holds, 1, 'the receiving team scoring is a hold');
  eq(gs.teamStats(0).breaks, 0, '  and not a break');

  near(gs.playerStats(0)!.yardsThrown, 20, 1e-9, 'player 0 threw 20 m downfield');
  near(gs.playerStats(1)!.yardsReceived, 20, 1e-9, 'player 1 received 20 m');
  near(gs.playerStats(2)!.yardsThrown, 32, 1e-9, 'the goal throw was 32 m downfield');
  near(gs.teamStats(0).yardsThrown, 66, 1e-9, 'RED threw 20 + 14 + 32 = 66 m');
  near(gs.teamStats(0).yardsThrown, gs.teamStats(0).yardsReceived, 1e-9, 'thrown yards == received yards');
  eq(gs.teamStats(0).completions, 3, 'three completions');
  eq(gs.teamStats(0).attempts, 3, 'three attempts');
  eq(gs.teamStats(0).turnoversCommitted, 0, 'no turnovers on the point');

  const evNames = events.map((x) => x.e);
  for (const want of ['pull', 'disc:released', 'disc:caught', 'score', 'state:changed', 'stall:tick']) {
    ok(evNames.includes(want), `emitted '${want}'`);
  }

  // Post-score: directions swap and the scoring team pulls.
  advanceThrough(gs, DEFAULT_RULES.postScoreDelay + 0.05);
  eq(gs.phase, 'PRE_PULL' as Phase, `POINT_SCORED auto-advances after ${DEFAULT_RULES.postScoreDelay}s`);
  eq(gs.pullingTeam, 0, 'the scoring team now pulls');
  eq(gs.receivingTeam, 1, 'the team scored on receives');
  eq(gs.attackDir[0], -1 as Dir, 'RED now attack -Z');
  eq(gs.attackDir[1], 1 as Dir, 'BLU now attack +Z');
  eq(gs.point, 2, 'point counter advanced');
  near(gs.pivot.z, -32, 1e-9, 'the receiving team lines up on their own goal line (z=-32)');

  if (!QUIET) {
    console.log('\n  play-by-play, point 1:');
    for (const l of lines) console.log(l);
  }
}

/* ==================================================================== 7 */

group('7. Every turnover kind');
{
  function freshLive(): GameState {
    const gs = new GameState({ startingPullTeam: 1, startingDirTeam0: 1 });
    gs.startGame();
    gs.pull(7, v(0, 1, 32));
    gs.catchDisc(0, v(0, 1, -27));
    return gs;
  }

  // drop
  {
    const gs = freshLive();
    gs.release({ playerId: 0 });
    gs.drop(1, v(0, 0, -10));
    eq(gs.possession, 1, 'drop hands the disc to the defence');
    eq(gs.playerStats(1)!.drops, 1, '  receiver charged with a drop');
    eq(gs.playerStats(0)!.throwsDropped, 1, '  thrower charged with a dropped throw, not a throwaway');
    eq(gs.playerStats(0)!.throwaways, 0, '  and no throwaway');
    eq(gs.playerStats(0)!.attempts, 1, '  attempt still counted');
    eq(gs.phase, 'TURNOVER_DEAD' as Phase, '  disc is dead');
  }
  // ground throwaway
  {
    const gs = freshLive();
    gs.release({ playerId: 0 });
    gs.ground(v(2, 0, 4));
    eq(gs.playerStats(0)!.throwaways, 1, 'grounded throw is a throwaway');
    eq(gs.possession, 1, '  possession flips');
    near(gs.pivot.z, 4, 1e-9, '  put into play where it landed');
  }
  // out of bounds
  {
    const gs = freshLive();
    const evs: any[] = [];
    (gs as any).emitFn = (e: string, p: any) => { if (e === 'turnover') evs.push(p); };
    gs.release({ playerId: 0 });
    gs.outOfBoundsSegment(v(10, 1, 0), v(26, 0.2, 6));
    eq(evs[0]?.reason, 'out-of-bounds', 'segment crossing the sideline is an OB turnover');
    near(gs.pivot.x, 18.5, 1e-9, '  disc comes in at the point where it crossed');
    near(gs.pivot.z, 3.1875, 1e-9, '  z of the crossing point');
    eq(gs.phase, 'TURNOVER_DEAD' as Phase, '  check-in happens at that point');
  }
  // block
  {
    const gs = freshLive();
    gs.release({ playerId: 0 });
    gs.block(9, v(0, 0.4, -4));
    eq(gs.playerStats(9)!.blocks, 1, 'defender credited with a block');
    eq(gs.playerStats(0)!.throwaways, 1, '  thrower charged with a throwaway');
    eq(gs.playerStats(0)!.blockedThrows, 1, '  and the throw is marked as blocked');
    eq(gs.possession, 1, '  defence gains possession');
    eq(computePlusMinus(gs.playerStats(9)!), 1, '  blocker is +1');
  }
  // interception
  {
    const gs = freshLive();
    gs.release({ playerId: 0 });
    gs.catchDisc(9, v(0, 1, -4));
    eq(gs.playerStats(9)!.blocks, 1, 'interception counts as a block');
    eq(gs.possession, 1, '  intercepting team has it');
    eq(gs.thrower, 9, '  the interceptor is the thrower');
    eq(gs.phase, 'LIVE_POSSESSION' as Phase, '  play stays live after an interception');
  }
  // interception in the endzone the intercepting team attacks -> walk to the goal line
  {
    const gs = freshLive();
    gs.release({ playerId: 0 });
    gs.catchDisc(9, v(3, 1, -44)); // BLU attack -Z
    near(gs.pivot.z, -32, 1e-9, 'possession gained in your attacking endzone is carried to the goal line');
    near(gs.pivot.x, 3, 1e-9, '  along x');
  }
  // caught out of bounds by your own team
  {
    const gs = freshLive();
    gs.release({ playerId: 0, pos: v(0, 1, -27) });
    gs.catchDisc(1, v(20, 1, -10));
    eq(gs.possession, 1, 'a team-mate catching it out of bounds is a turnover');
    eq(gs.playerStats(0)!.throwaways, 1, '  charged to the thrower');
    near(gs.pivot.x, 18.5, 1e-9, '  disc comes in at the sideline');
  }
  // stall-out already covered in section 4
}

/* ==================================================================== 8 */

group('8. Timeouts');
{
  const gs = new GameState({ startingPullTeam: 1, startingDirTeam0: 1 });
  gs.startGame();
  gs.pull(7, v(0, 1, 32));
  gs.catchDisc(0, v(0, 1, -27));
  advance(gs, 6.01, false);
  eq(gs.stallCount, 6, 'stall is at 6');

  eq(gs.callTimeout(1).ok, false, 'the defence may not call a timeout during a point');
  eq(gs.teamStats(1).timeoutsRemaining, DEFAULT_RULES.timeoutsPerHalf, '  and keeps its timeouts');

  eq(gs.callTimeout(0, 0).ok, true, 'the offence may call a timeout');
  eq(gs.phase, 'TIMEOUT' as Phase, '  -> TIMEOUT');
  eq(gs.teamStats(0).timeoutsRemaining, 1, '  one timeout left');
  advance(gs, 3, false);
  eq(gs.stallCount, 6, '  the count does not run during a timeout');
  advanceThrough(gs, DEFAULT_RULES.timeoutDuration + 0.05);
  eq(gs.phase, 'CHECK' as Phase, `  auto-restart after ${DEFAULT_RULES.timeoutDuration}s -> CHECK`);
  gs.check();
  eq(gs.stallCount, 7, '  stall resumes at reached + 1 = 7');

  gs.callTimeout(0);
  gs.endTimeout(); gs.check();
  eq(gs.teamStats(0).timeoutsRemaining, 0, 'both timeouts spent');
  eq(gs.callTimeout(0).ok, false, 'a third timeout is refused');
  eq(gs.teamStats(0).timeoutsUsed, 2, 'timeouts used = 2');
}

/* ==================================================================== 9 */

group('9. Self-officiated calls');
{
  // Contested foul on a throw -> back to the thrower.
  {
    const gs = new GameState({ startingPullTeam: 1, startingDirTeam0: 1 });
    gs.startGame();
    gs.pull(7, v(0, 1, 32));
    gs.catchDisc(0, v(0, 1, -27));
    advance(gs, 4.01, false);
    eq(gs.stallCount, 4, 'stall at 4 before the throw');
    gs.release({ playerId: 0 });
    eq(gs.playerStats(0)!.attempts, 1, 'attempt recorded on release');
    gs.makeCall('foul', 0, 7, v(0, 1, -27));
    eq(gs.phase, 'CHECK' as Phase, 'a call stops play');
    gs.resolveCall(true);
    gs.check();
    eq(gs.possession, 0, 'contested -> the offence keeps it');
    eq(gs.thrower, 0, 'contested -> disc back to the thrower');
    eq(gs.stallCount, 5, 'contested -> count resumes at reached + 1');
    eq(gs.playerStats(0)!.attempts, 0, 'the nullified throw is not counted as an attempt');
    eq(gs.phase, 'LIVE_POSSESSION' as Phase, 'play restarts live');
  }
  // Uncontested marking foul -> the count restarts at 0.
  {
    const gs = new GameState({ startingPullTeam: 1, startingDirTeam0: 1 });
    gs.startGame();
    gs.pull(7, v(0, 1, 32));
    gs.catchDisc(0, v(0, 1, -27));
    advance(gs, 7.01, false);
    gs.makeCall('foul', 0, 7);
    gs.resolveCall(false);
    gs.check();
    eq(gs.stallCount, 0, 'uncontested marking foul resets the count to 0');
    eq(gs.playerStats(7)!.foulsCommitted, 1, 'foul charged to the marker');
  }
  // Uncontested travel -> pivot restored, count backs up one.
  {
    const gs = new GameState({ startingPullTeam: 1, startingDirTeam0: 1 });
    gs.startGame();
    gs.pull(7, v(0, 1, 32));
    gs.catchDisc(0, v(0, 1, -27));
    advance(gs, 5.01, false);
    gs.makeCall('travel', 7, 0);
    gs.resolveCall(false);
    gs.check();
    eq(gs.stallCount, 4, 'uncontested travel backs the count up one');
    eq(gs.playerStats(0)!.travels, 1, 'travel charged to the thrower');
    eq(gs.possession, 0, 'the offence keeps the disc');
  }
  // Uncontested pick -> restart where it stopped.
  {
    const gs = new GameState({ startingPullTeam: 1, startingDirTeam0: 1 });
    gs.startGame();
    gs.pull(7, v(0, 1, 32));
    gs.catchDisc(0, v(0, 1, -27));
    advance(gs, 2.01, false);
    gs.makeCall('pick', 1, 8);
    gs.resolveCall(false);
    gs.check();
    eq(gs.stallCount, 3, 'pick restarts the count at reached + 1');
    eq(gs.possession, 0, 'possession is unchanged by a pick');
  }
  // Travel detected from observed foot position.
  {
    const gs = new GameState({ startingPullTeam: 1, startingDirTeam0: 1 });
    gs.startGame();
    gs.pull(7, v(0, 1, 32));
    gs.catchDisc(0, v(0, 1, -27));
    gs.step(DT, { pivotFoot: v(0, 0, -26.1) });
    eq(gs.playerStats(0)!.travels, 1, 'a 0.9 m pivot slip is flagged as a travel');
    gs.step(DT, { pivotFoot: v(0, 0, -26.1) });
    eq(gs.playerStats(0)!.travels, 1, '  and flagged only once');
  }
}

/* =================================================================== 10 */

group('10. Halftime');
{
  const gs = new GameState({
    rules: { halftimeAt: 2, gameTo: 4, postScoreDelay: 0.5, halftimeDuration: 5 },
    startingPullTeam: 1, startingDirTeam0: 1,
  });
  gs.startGame();
  const dirAtStart = gs.attackDir[0];
  // The receiving team holds every point: 1-0, 1-1, 2-1 -> halftime at 2.
  let pts = 0;
  while (gs.phase === 'PRE_PULL' && pts++ < 10) {
    const recv = gs.receivingTeam;
    const dir = gs.attackDir[recv];
    const p = gs.lines[recv][0];
    gs.pull(gs.lines[gs.pullingTeam][0], v(0, 1, -dir * 32));
    gs.catchDisc(p, v(0, 1, -dir * 27));
    gs.release({ playerId: p, pos: v(0, 1, -dir * 27) });
    gs.catchDisc(gs.lines[recv][1], v(0, 1, dir * 40));
    advanceThrough(gs, 0.6);
  }
  eq(gs.score[0] + gs.score[1], 3, 'three points played (1-0, 1-1, 2-1)');
  eq(Math.max(gs.score[0], gs.score[1]), 2, 'a team has reached the halftime score');
  eq(gs.phase, 'HALFTIME' as Phase, 'reaching the halftime score -> HALFTIME');
  eq(gs.half, 1, 'still labelled the first half until play resumes');
  advanceThrough(gs, 5.1);
  eq(gs.phase, 'PRE_PULL' as Phase, 'halftime auto-expires');
  eq(gs.half, 2, 'now the second half');
  eq(gs.pullingTeam, 1, 'the team that pulled to open the game pulls to open the second half');
  eq(gs.teamStats(0).timeoutsRemaining, DEFAULT_RULES.timeoutsPerHalf, 'timeouts reset at halftime');
  eq(gs.attackDir[0], dirAtStart, 'ends swap at halftime (net: back to the opening direction)');
}

/* =============================================================== 10.5 */

group('10b. Caps end the game early');
{
  /** The receiving team holds every point: scores alternate 1-0, 1-1, 2-1, ... */
  function hold(gs: GameState): void {
    const recv = gs.receivingTeam;
    const dir = gs.attackDir[recv];
    const p = gs.lines[recv][0];
    gs.pull(gs.lines[gs.pullingTeam][0], v(0, 1, -dir * 32));
    gs.catchDisc(p, v(0, 1, -dir * 27));
    gs.release({ playerId: p, pos: v(0, 1, -dir * 27) });
    gs.catchDisc(gs.lines[recv][1], v(0, 1, dir * 40));
    advanceThrough(gs, 0.1);
  }

  const gs = new GameState({
    rules: { gameTo: 15, halftimeAt: 99, postScoreDelay: 0.05 },
    startingPullTeam: 1, startingDirTeam0: 1,
  });
  gs.startGame();
  for (let i = 0; i < 5; i++) hold(gs);
  eq(`${gs.score[0]}-${gs.score[1]}`, '3-2', 'five holds give 3-2');
  eq(gs.target, 15, 'target is still 15');

  gs.applyHardCap();
  eq(gs.target, 4, 'hard cap sets the target to leader + 1');
  hold(gs);
  eq(`${gs.score[0]}-${gs.score[1]}`, '3-3', 'a tie at the cap is not a win');
  eq(gs.phase, 'PRE_PULL' as Phase, '  so one more point is played');
  hold(gs);
  eq(`${gs.score[0]}-${gs.score[1]}`, '4-3', 'the next goal breaks the tie');
  eq(gs.phase, 'GAME_OVER' as Phase, '  and the hard cap ends the game');

  const gs2 = new GameState({
    rules: { gameTo: 15, halftimeAt: 99, postScoreDelay: 0.05 },
    startingPullTeam: 1, startingDirTeam0: 1,
  });
  gs2.startGame();
  for (let i = 0; i < 5; i++) hold(gs2);
  gs2.applySoftCap();
  eq(gs2.target, 4, 'soft cap sets the target to leader + 1');
  hold(gs2); // 3-3
  eq(gs2.phase, 'PRE_PULL' as Phase, 'soft cap: 3-3 keeps playing');
  hold(gs2); // 4-3
  eq(gs2.phase, 'GAME_OVER' as Phase, 'soft cap: reaching the new target ends it');
  eq(gs2.score[0], 4, '  final 4-3');
}

/* =============================================================== 10.6 */

group('10c. emitPhysicsEvents can be disabled for the disc system to own');
{
  const seen: string[] = [];
  const gs = new GameState({
    emit: (e) => seen.push(e),
    rules: { emitPhysicsEvents: false },
    startingPullTeam: 1, startingDirTeam0: 1,
  });
  gs.startGame();
  gs.pull(7, v(0, 1, 32));
  gs.catchDisc(0, v(0, 1, -27));
  gs.release({ playerId: 0 });
  gs.ground(v(0, 0, -10));
  ok(!seen.includes('disc:released'), "no 'disc:released' when the flag is off");
  ok(!seen.includes('disc:caught'), "no 'disc:caught' when the flag is off");
  ok(!seen.includes('disc:grounded'), "no 'disc:grounded' when the flag is off");
  ok(seen.includes('turnover'), "rules events still fire ('turnover')");
  ok(seen.includes('pull'), "rules events still fire ('pull')");
  ok(seen.includes('state:changed'), "rules events still fire ('state:changed')");
}

/* =================================================================== 11 */

/**
 * One scripted game driver, shared by the full-game test and the determinism
 * replay so the two can never drift apart. Every decision comes from the seeded
 * xorshift; the GameState makes every rules decision.
 */
interface Hooks {
  onScore?(gs: GameState, scorePayload: any, scoreBefore: number, dirBefore: Dir): void;
  onHalftime?(gs: GameState): void;
}
function scriptGame(seed: number, sink?: (e: string, p: any) => void, hooks: Hooks = {}): GameState {
  const rng = new R(seed);
  const gs = new GameState({
    emit: sink,
    teams: [{ name: 'RED' }, { name: 'BLU' }],
    startingPullTeam: 1, startingDirTeam0: 1,
    maxLog: 100000,
  });
  gs.startGame();

  let plannedReceiver = -1;
  let plannedAt: Vec3 = v(0, 0, 0);
  let plannedOutcome = 'complete';
  let scoreBefore = 0;
  let dirBefore: Dir = gs.attackDir[0];
  let guard = 0;

  while (gs.phase !== 'GAME_OVER' && guard++ < 40000) {
    switch (gs.phase) {
      case 'PRE_PULL': {
        scoreBefore = gs.score[0] + gs.score[1];
        dirBefore = gs.attackDir[0];
        gs.pull(gs.lines[gs.pullingTeam][rng.int(0, 6)], v(rng.range(-6, 6), 1.5, gs.discPos.z));
        break;
      }
      case 'PULL_IN_FLIGHT': {
        const recv = gs.receivingTeam;
        const dir = gs.attackDir[recv];
        const roll = rng.next();
        if (roll < 0.10) gs.pullOutOfBounds(v(19.5, 0, -dir * 30), rng.next() < 0.6 ? 'brick' : 'sideline');
        else if (roll < 0.24) gs.pullLanded(v(rng.range(-14, 14), 0, -dir * rng.range(20, 30)));
        else if (roll < 0.28) gs.pullDropped(gs.lines[recv][rng.int(0, 6)], v(rng.range(-14, 14), 0, -dir * 26));
        else gs.catchDisc(gs.lines[recv][rng.int(0, 6)], v(rng.range(-14, 14), 1.2, -dir * rng.range(22, 31)));
        break;
      }
      case 'TURNOVER_DEAD': {
        if (gs.awaitingPullChoice()) { gs.choosePullSpot('brick'); break; }
        gs.pickUp(gs.lines[gs.possession!][rng.int(0, 6)]);
        break;
      }
      case 'CHECK': {
        advance(gs, rng.range(0.5, 2), false);
        gs.check();
        break;
      }
      case 'LIVE_POSSESSION': {
        const team = gs.possession!;
        const dir = gs.attackDir[team];
        // 3% of possessions: the handler holds it and gets stalled out.
        if (rng.next() < 0.03) { advance(gs, 11, true); break; }
        // 4% of possessions: a timeout, if any are left.
        if (rng.next() < 0.04 && gs.teamStats(team).timeoutsRemaining > 0) { gs.callTimeout(team); break; }
        advance(gs, rng.range(0.4, 3.0), true);
        if (gs.phase !== 'LIVE_POSSESSION') break;
        const from = gs.pivot;
        let z = from.z + dir * rng.range(-4, 18);
        if (dir * z > 48) z = dir * 48;
        if (dir * z < -48) z = dir * -48;
        const x = Math.max(-17, Math.min(17, from.x + rng.range(-14, 14)));
        plannedAt = v(x, 1.3, z);
        const mates = gs.lines[team].filter((p) => p !== gs.thrower);
        plannedReceiver = mates[rng.int(0, mates.length - 1)];
        const roll = rng.next();
        plannedOutcome = roll < 0.045 ? 'drop' : roll < 0.085 ? 'ground' : roll < 0.115 ? 'oob'
          : roll < 0.145 ? 'block' : roll < 0.16 ? 'pick6' : roll < 0.175 ? 'foul' : 'complete';
        gs.release({ playerId: gs.thrower!, pos: from, throwType: 'scripted' });
        break;
      }
      case 'DISC_IN_FLIGHT': {
        const def = gs.lines[gs.possession === 0 ? 1 : 0];
        switch (plannedOutcome) {
          case 'complete': gs.catchDisc(plannedReceiver, plannedAt); break;
          case 'drop': gs.drop(plannedReceiver, plannedAt); break;
          case 'ground': gs.ground(v(plannedAt.x, 0, plannedAt.z)); break;
          case 'oob': gs.outOfBounds(v(plannedAt.x < 0 ? -18.5 : 18.5, 0, plannedAt.z)); break;
          case 'block': gs.block(def[rng.int(0, 6)], v(plannedAt.x, 0.5, plannedAt.z)); break;
          case 'pick6': gs.catchDisc(def[rng.int(0, 6)], plannedAt); break;
          case 'foul': {
            gs.makeCall('foul', plannedReceiver, def[rng.int(0, 6)], plannedAt);
            gs.resolveCall(rng.next() < 0.5);
            break;
          }
        }
        break;
      }
      case 'POINT_SCORED': {
        const payload = gs.getLastScore();
        advanceThrough(gs, DEFAULT_RULES.postScoreDelay + 0.02);
        hooks.onScore?.(gs, payload, scoreBefore, dirBefore);
        break;
      }
      case 'HALFTIME': {
        hooks.onHalftime?.(gs);
        gs.resumeFromHalftime();
        break;
      }
      case 'TIMEOUT': {
        advanceThrough(gs, DEFAULT_RULES.timeoutDuration + 0.02);
        break;
      }
      default: guard = 1e9; break;
    }
  }
  ok(guard < 40000, 'the scripted game terminated without stalling the scheduler', `${guard} iterations`);
  return gs;
}

group('11. Full scripted game to 15');
const gs11 = (() => {
  const events: { e: string; p: any }[] = [];
  const perPoint: string[] = [];
  let n = 0;
  const gs = scriptGame(0xC0FFEE, (e, p) => events.push({ e, p }), {
    onScore(g, sc, scoreBefore, dirBefore) {
      n++;
      perPoint.push(
        `  pt ${String(n).padStart(2)}  RED ${String(g.score[0]).padStart(2)}-${String(g.score[1]).padEnd(2)} BLU`
        + `   goal ${g.name(sc.playerId).padEnd(6)} from ${(sc.assistId !== null ? g.name(sc.assistId) : '-').padEnd(6)}`
        + `   t=${g.clock.toFixed(1).padStart(6)}s  ${g.half === 1 ? 'H1' : 'H2'}`,
      );
      ok(g.score[0] + g.score[1] === scoreBefore + 1, `point ${n}: exactly one goal scored`);
      if (g.phase === 'PRE_PULL') {
        ok(g.pullingTeam === sc.team, `point ${n}: the scoring team pulls next`);
        ok(g.attackDir[0] === -dirBefore, `point ${n}: both teams swapped direction of attack`);
      }
    },
    onHalftime(g) {
      ok(Math.max(g.score[0], g.score[1]) === DEFAULT_RULES.halftimeAt,
        `halftime taken at ${DEFAULT_RULES.halftimeAt}`, `score ${g.score[0]}-${g.score[1]}`);
    },
  });

  eq(gs.phase, 'GAME_OVER' as Phase, 'phase is GAME_OVER');
  const winner = gs.score[0] > gs.score[1] ? 0 : 1;
  eq(gs.score[winner], 15, 'the winner reached 15');
  ok(gs.score[1 - winner] < 15, 'the loser did not', `final ${gs.score[0]}-${gs.score[1]}`);
  eq(events.filter((e) => e.e === 'game:over').length, 1, "one 'game:over' event");
  eq(events.filter((e) => e.e === 'half').length, 1, "one 'half' event");
  eq(gs.half, 2, 'finished in the second half');
  ok(gs.teamStats(0).stallOuts + gs.teamStats(1).stallOuts > 0, 'the script produced at least one stall-out',
    `${gs.teamStats(0).stallOuts + gs.teamStats(1).stallOuts} stall-outs`);
  ok(gs.teamStats(0).timeoutsUsed + gs.teamStats(1).timeoutsUsed > 0, 'the script used at least one timeout',
    `${gs.teamStats(0).timeoutsUsed + gs.teamStats(1).timeoutsUsed} timeouts`);

  if (!QUIET) {
    console.log('\n  point-by-point:');
    for (const l of perPoint) console.log(l);
  }
  (globalThis as any).__events = events;
  return gs;
})();

/* =================================================================== 12 */

group('12. Statistical consistency over the full game');
{
  const gs = gs11;
  const events = (globalThis as any).__events as { e: string; p: any }[];
  const all = gs.allPlayers();
  const sum = (f: (p: PlayerStats) => number) => all.reduce((a, p) => a + f(p), 0);
  const sumT = (t: TeamId, f: (p: PlayerStats) => number) =>
    all.filter((p) => p.team === t).reduce((a, p) => a + f(p), 0);

  const totalGoals = gs.score[0] + gs.score[1];
  eq(sum((p) => p.goals), totalGoals, 'sum of player goals equals the final score');
  eq(sumT(0, (p) => p.goals), gs.score[0], '  team 0 player goals equal team 0 score');
  eq(sumT(1, (p) => p.goals), gs.score[1], '  team 1 player goals equal team 1 score');
  eq(sum((p) => p.assists), totalGoals, 'every goal has exactly one assist');
  eq(events.filter((e) => e.e === 'score').length, totalGoals, "'score' events equal total goals");

  for (const t of [0, 1] as TeamId[]) {
    const ts = gs.teamStats(t);
    eq(ts.score, gs.score[t], `team ${t}: TeamStats.score matches the scoreboard`);
    eq(ts.goals, sumT(t, (p) => p.goals), `team ${t}: goals roll up`);
    eq(ts.assists, sumT(t, (p) => p.assists), `team ${t}: assists roll up`);
    eq(ts.blocks, sumT(t, (p) => p.blocks), `team ${t}: blocks roll up`);
    eq(ts.attempts, sumT(t, (p) => p.attempts), `team ${t}: attempts roll up`);
    eq(ts.completions, sumT(t, (p) => p.completions), `team ${t}: completions roll up`);
    eq(ts.throwaways, sumT(t, (p) => p.throwaways), `team ${t}: throwaways roll up`);
    eq(ts.drops, sumT(t, (p) => p.drops), `team ${t}: drops roll up`);
    eq(ts.stallOuts, sumT(t, (p) => p.stallOuts), `team ${t}: stall-outs roll up`);
    eq(ts.attempts, ts.completions + ts.throwaways + sumT(t, (p) => p.throwsDropped),
      `team ${t}: attempts = completions + throwaways + dropped throws`);
    near(ts.yardsThrown, sumT(t, (p) => p.yardsThrown), 1e-9, `team ${t}: thrown yards roll up`);
    near(ts.yardsThrown, ts.yardsReceived, 1e-9, `team ${t}: thrown yards equal received yards`);
    ok(ts.timeOfPossession > 0 && ts.timeOfPossession < gs.clock,
      `team ${t}: time of possession is inside the game clock`,
      `${ts.timeOfPossession.toFixed(1)}s of ${gs.clock.toFixed(1)}s`);
    eq(ts.pointsPlayed, totalGoals, `team ${t}: points played equals total goals`);
  }
  for (const p of all) {
    eq(p.attempts, p.completions + p.throwaways + p.throwsDropped,
      `${p.name}: attempts = completions + throwaways + dropped throws`);
    eq(p.plusMinus, computePlusMinus(p), `${p.name}: cached plus-minus matches the formula`);
  }
  eq(gs.teamStats(0).turnoversCommitted, gs.teamStats(1).turnoversForced, 'turnovers committed by 0 = forced by 1');
  eq(gs.teamStats(1).turnoversCommitted, gs.teamStats(0).turnoversForced, 'turnovers committed by 1 = forced by 0');
  eq(events.filter((e) => e.e === 'turnover').length,
    gs.teamStats(0).turnoversCommitted + gs.teamStats(1).turnoversCommitted,
    "'turnover' events equal total turnovers committed");
  eq(gs.teamStats(0).holds + gs.teamStats(0).breaks + gs.teamStats(1).holds + gs.teamStats(1).breaks,
    totalGoals, 'holds + breaks equal total goals');
  eq(gs.teamStats(0).pulls + gs.teamStats(1).pulls, totalGoals, 'exactly one pull per point played');
  near(sum((p) => p.yardsThrown), sum((p) => p.yardsReceived), 1e-9, 'league-wide thrown yards equal received yards');
  ok(sum((p) => p.timeOfPossession) <= gs.clock + 1e-6, 'player possession time fits inside the game clock',
    `${sum((p) => p.timeOfPossession).toFixed(1)}s of ${gs.clock.toFixed(1)}s`);
  ok(gs.teamStats(0).timeOfPossession + gs.teamStats(1).timeOfPossession <= gs.clock + 1e-6,
    'team possession time fits inside the game clock',
    `${(gs.teamStats(0).timeOfPossession + gs.teamStats(1).timeOfPossession).toFixed(1)}s of ${gs.clock.toFixed(1)}s`);

  if (!QUIET) console.log('\n' + gs.boxScore().split('\n').map((l) => '  ' + l).join('\n'));
}

/* =================================================================== 13 */

group('13. Determinism');
{
  const digest = (g: GameState) => JSON.stringify({
    s: g.score, c: +g.clock.toFixed(9),
    box: g.allPlayers().map((p) => [
      p.goals, p.assists, p.blocks, p.attempts, p.completions, p.throwaways, p.drops,
      p.stallOuts, +p.yardsThrown.toFixed(9), +p.timeOfPossession.toFixed(9),
    ]),
  });
  /** FNV-1a, so the assertion output stays readable. */
  const h = (s: string): string => {
    let x = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
    return x.toString(16).padStart(8, '0');
  };
  const a = h(digest(scriptGame(0xC0FFEE)));
  const b = h(digest(scriptGame(0xC0FFEE)));
  eq(a, b, 'two identical scripted runs produce byte-identical stats');
  eq(a, h(digest(gs11)), 'and match the instrumented run (emitting events changes nothing)');
  ok(h(digest(scriptGame(0xBADCAFE))) !== a, 'a different seed produces a different game');
}
group('14. A pull can be touched by the pulling team — and that is a violation');
{
  /**
   * The pulling team may not touch its own pull before the receiving team does
   * (WFDF 12.5); if they do, the receivers get the disc at that spot.
   *
   * `GameState` always implemented this correctly, but for a long time it was
   * unreachable: `Game.tryCatch` skipped every non-receiving player during
   * PULL_IN_FLIGHT, so no member of the pulling team could touch a pull under
   * any circumstances. That mattered most when pulls were short — they averaged
   * 42.9 m, landing near midfield with the cover arriving right on top of them,
   * and the cover still could not lay a finger on it.
   *
   * These assertions pin the rule so the exclusion cannot quietly come back.
   */
  const gs = new GameState({ startingPullTeam: 1, startingDirTeam0: 1 });
  gs.startGame();
  eq(gs.pullingTeam, 1, 'BLU pull');
  eq(gs.receivingTeam, 0, 'RED receive');

  // BLU (the pulling team) is players 7..13; RED is 0..6.
  gs.pull(7, v(0, 1.5, 32), v(0, 4, -30));
  eq(gs.phase, 'PULL_IN_FLIGHT' as Phase, 'the pull is live');

  const r = gs.catchDisc(8, v(2, 1.4, 4));   // a BLU player gets a hand to it
  ok(r.ok, 'a member of the pulling team CAN touch the pull');
  eq(gs.possession, 0, 'and the disc goes to the receiving team, not to them');
  ok(gs.phase !== 'PULL_IN_FLIGHT', 'the pull is over');
  ok(gs.thrower === null, 'nobody is holding it yet — it is a dead disc to collect');
}

group('15. The double team — USAU 16.G, and the exception that makes it a rule');
{
  /**
   * "a defensive player within ten feet of any pivot of the thrower without
   *  also being within ten feet of, and guarding, another offensive player"
   *
   * Two halves, and the second is the one worth testing: a body near the disc
   * is only a double team if it is not there for somebody else. A defender
   * whose own matchup has cut through is legitimately close, which is why the
   * rule is written as an exception rather than as a radius.
   */
  const r = makeRules();
  const pivot = v(0, 0, 0);
  const D = (id: number, x: number, z: number) => ({ id, pos: v(x, 0, z) });

  // The marker himself is never the offender — he is entitled to be there.
  eq(doubleTeamOffender(pivot, 1, [D(1, 2, 0)], [D(9, 0, 0)], 9, r), null,
    'the marker alone is not a double team');

  // A second defender inside ten feet with nobody else to guard.
  eq(doubleTeamOffender(pivot, 1, [D(1, 2, 0), D(2, 0, 2.5)], [D(9, 0, 0)], 9, r), 2,
    'a second defender inside ten feet of the pivot is a double team');

  // ... unless he is also within ten feet of another offensive player.
  eq(doubleTeamOffender(pivot, 1, [D(1, 2, 0), D(2, 0, 2.5)],
    [D(9, 0, 0), D(8, 0, 4.0)], 9, r), null,
    'but not when he is also inside ten feet of another offensive player');

  // The thrower does not count as the "other offensive player" — otherwise the
  // exception would swallow the rule, since every double teamer is near him.
  eq(doubleTeamOffender(pivot, 1, [D(1, 2, 0), D(2, 0, 2.5)], [D(9, 0, 0)], 9, r), 2,
    'and the thrower himself cannot be the man that excuses it');

  // Ten feet is 3.048 m; just outside is legal.
  near(r.doubleTeamRange, 3.048, 1e-9, 'the radius is ten feet in metres');
  eq(doubleTeamOffender(pivot, 1, [D(1, 2, 0), D(2, 0, 3.2)], [D(9, 0, 0)], 9, r), null,
    'a defender just outside ten feet is not double teaming');
}

/* -------------------------------------------------------------- summary */

console.log(`\n\x1b[1m${'='.repeat(64)}\x1b[0m`);
if (fail === 0) {
  console.log(`\x1b[32m\x1b[1mPASS\x1b[0m  ${pass} assertions, 0 failures`);
} else {
  console.log(`\x1b[31m\x1b[1mFAIL\x1b[0m  ${pass} passed, ${fail} failed`);
  for (const f of failures) console.log(`  \x1b[31m·\x1b[0m ${f}`);
}
console.log(`\x1b[1m${'='.repeat(64)}\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
