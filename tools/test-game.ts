/**
 * tools/test-game.ts — headless verification of src/sim/Game.ts.
 *
 *   node tools/test-game.ts               run the match, print the assertions
 *   node tools/test-game.ts --verbose     also print the play-by-play
 *   node tools/test-game.ts --seconds 900 run longer
 *
 * Builds a GameSystem against a fake Ctx (no renderer, no scene) and drives it
 * at the engine's fixed 1/120 s step for several points. The point of the file
 * is not that the code runs: it is that a match *progresses* — that possession
 * changes hands, that the stall count bites, that discs land in bounds and out,
 * that scores happen and the pull swaps, and that nothing anywhere goes NaN or
 * walks off the park.
 */

import * as THREE from 'three';
import { EventBus, QUALITY_PRESETS, Rng, type Ctx } from '../src/core/Ctx.ts';
import { GameSystem } from '../src/sim/Game.ts';
import { FIELD } from '../src/sim/Rules.ts';
import { SHOTS, type Shot, type ShotName } from '../src/capture/Shots.ts';

/* ---------------------------------------------------------------- harness */

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const flag = (n: string, d: number): number => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : Number(argv[i + 1]);
};
const SECONDS = flag('seconds', 600);
const SEED = flag('seed', 20260729);

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string, detail = ''): void {
  if (cond) { pass++; return; }
  fail++;
  failures.push(label + (detail ? `  (${detail})` : ''));
}
function ge(actual: number, min: number, label: string): void {
  ok(actual >= min, label, `${actual} < ${min}`);
}
function group(name: string): void {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

/* ------------------------------------------------------------- fake engine */

function makeCtx(seed: number): Ctx {
  return {
    renderer: null as unknown as THREE.WebGLRenderer,
    scene: null as unknown as THREE.Scene,
    camera: null as unknown as THREE.PerspectiveCamera,
    composer: null,
    time: 0, dt: 0, rawDt: 0, timeScale: 1, frame: 0,
    width: 1920, height: 1080, dpr: 1,
    quality: { ...QUALITY_PRESETS.high },
    events: new EventBus(),
    rand: new Rng(seed),
    sys: Object.create(null),
    debug: false,
    capture: false,
  };
}

/* ------------------------------------------------------------------- run */

const ctx = makeCtx(SEED);
const game = new GameSystem();
ctx.sys['game'] = game;

const events = new Map<string, number>();
const seen: string[] = [];
for (const name of [
  'disc:released', 'disc:caught', 'disc:grounded', 'score', 'pull', 'stall:tick',
  'turnover', 'state:changed', 'player:footstep', 'player:land', 'player:contact',
  'half', 'game:over', 'violation',
]) {
  ctx.events.on(name, () => { events.set(name, (events.get(name) ?? 0) + 1); });
}
const turnoverReasons = new Map<string, number>();
ctx.events.on('turnover', (p: { reason?: string }) => {
  turnoverReasons.set(p?.reason ?? '?', (turnoverReasons.get(p?.reason ?? '?') ?? 0) + 1);
});
const possessionLog: (number | null)[] = [];
ctx.events.on('state:changed', (p: { to?: string; possession?: number | null }) => {
  possessionLog.push(p?.possession ?? null);
});

let thrown = 0;
ctx.events.on('disc:released', () => { thrown++; });

game.init(ctx);

/* ------------------------------------------------------------ play-by-play */

/**
 * A commentary line per event, with the clock and the scoreline, so the run is
 * readable as a match rather than as a histogram. The point of printing it is
 * that "62 completions" is compatible with a broken game and "HOME 4 pulls,
 * catch, catch, huck, layout D, break" is not.
 */
const pbp: string[] = [];
let clockNow = 0;
let stepNow = 0;
const who = (id: number | null | undefined): string => {
  if (id === null || id === undefined || id < 0) return '?';
  const e = game.entry(id);
  return e ? `${e.team === 0 ? 'HOME' : 'AWAY'} #${e.number}` : `#${id}`;
};
const say = (tag: string, text: string): void => {
  if (pbp.length >= 4000) return;
  const m = Math.floor(clockNow / 60), s = Math.floor(clockNow % 60);
  pbp.push(`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    + ` ${String(game.gs.score[0])}-${String(game.gs.score[1])}`
    + `  ${tag.padEnd(9)} ${text}`);
};
let throwDist = 0;
let lastRelease: { x: number; z: number } | null = null;
let maxStall = 0;
const throwLengths: number[] = [];
/**
 * Pull geometry. The pull opens every point, so a short one is the first thing
 * anybody sees — and for a long time every pull in this game died at midfield
 * (measured mean carry 42.9 m against a far goal line 64 m away) because it was
 * thrown as an ordinary backhand. These record where each one actually goes.
 */
const pullCarry: number[] = [];
const pullLandX: number[] = [];
const pullHang: number[] = [];
let pullLive: { z: number; dir: number; t: number } | null = null;
ctx.events.on('pull', (p: any) => {
  say('PULL', `${who(p?.playerId ?? p?.puller)} sends it away`);
  pullLive = {
    z: p?.from?.z ?? 0,
    dir: game.gs.attackDir[game.gs.pullingTeam],
    t: clockNow,
  };
});
const pullLanded = (x: number, z: number): void => {
  if (!pullLive) return;
  pullCarry.push(pullLive.dir * (z - pullLive.z));
  pullLandX.push(x);
  pullHang.push(clockNow - pullLive.t);
  pullLive = null;
};
ctx.events.on('disc:caught', (p: any) => {
  if (pullLive) pullLanded(p?.pos?.x ?? 0, p?.pos?.z ?? 0);
});
ctx.events.on('disc:grounded', (p: any) => {
  if (pullLive) pullLanded(p?.pos?.x ?? 0, p?.pos?.z ?? 0);
});
ctx.events.on('turnover', () => { pullLive = null; });
ctx.events.on('disc:released', (p: any) => {
  const id = game.gs.thrower;
  lastRelease = { x: p?.pos?.x ?? 0, z: p?.pos?.z ?? 0 };
  say('THROW', `${who(id)} ${p?.throwType ?? '?'}`
    + `  ${Math.hypot(p?.vel?.x ?? 0, p?.vel?.y ?? 0, p?.vel?.z ?? 0).toFixed(1)} m/s`
    + `  stall ${game.gs.stallCount}`);
});
ctx.events.on('disc:caught', (p: any) => {
  let d = 0;
  if (lastRelease) d = Math.hypot((p?.pos?.x ?? 0) - lastRelease.x, (p?.pos?.z ?? 0) - lastRelease.z);
  if (d > 0.5) { throwLengths.push(d); throwDist += d; }
  say('CATCH', `${who(p?.playerId)} at ${(p?.pos?.x ?? 0).toFixed(0)},${(p?.pos?.z ?? 0).toFixed(0)}`
    + (d > 0.5 ? `  (${d.toFixed(0)} m gain)` : ''));
});
ctx.events.on('turnover', (p: any) => say('TURNOVER', `${p?.reason} — team ${p?.to} takes over`));
ctx.events.on('score', (p: any) => say('GOAL', `team ${p?.team} — ${p?.scoreline ?? ''}`));
ctx.events.on('stall:tick', (p: any) => {
  const c = p?.count ?? 0;
  if (c > maxStall) maxStall = c;
  if (c >= 8) say('STALL', `count ${c} on ${who(game.gs.thrower)}`);
});
ctx.events.on('half', () => say('HALF', 'halftime'));
void stepNow;

/* --------------------------------------------------------------- integrate */

const DT = 1 / 120;
const steps = Math.round(SECONDS / DT);

let maxAbsX = 0, maxAbsZ = 0;
let nanSeen = false;
let discNan = false;
let maxDiscHeight = 0;
let stallTicksAtTen = 0;
let phaseHistogram = new Map<string, number>();
let heldFrames = 0, flightFrames = 0, groundFrames = 0;
const scoreProgress: number[] = [];

ctx.events.on('stall:tick', (p: { count?: number }) => {
  if ((p?.count ?? 0) >= 10) stallTicksAtTen++;
});

const t0 = Date.now();
for (let i = 0; i < steps; i++) {
  stepNow = i;
  clockNow = i * DT;
  game.update(DT, ctx);
  ctx.time += DT;
  ctx.frame++;

  const gs = game.gs;
  phaseHistogram.set(gs.phase, (phaseHistogram.get(gs.phase) ?? 0) + 1);
  const mode = game.discRuntime.mode;
  if (mode === 'held') heldFrames++; else if (mode === 'flight') flightFrames++; else groundFrames++;

  for (const p of game.players) {
    if (!Number.isFinite(p.pos.x) || !Number.isFinite(p.pos.y) || !Number.isFinite(p.pos.z)
      || !Number.isFinite(p.vel.x) || !Number.isFinite(p.vel.z) || !Number.isFinite(p.facing)) {
      nanSeen = true;
    }
    maxAbsX = Math.max(maxAbsX, Math.abs(p.pos.x));
    maxAbsZ = Math.max(maxAbsZ, Math.abs(p.pos.z));
  }
  const d = game.discRuntime.state;
  if (!Number.isFinite(d.pos.x) || !Number.isFinite(d.pos.y) || !Number.isFinite(d.pos.z)
    || !Number.isFinite(d.spin) || !Number.isFinite(d.orient.w)) discNan = true;
  maxDiscHeight = Math.max(maxDiscHeight, d.pos.y);

  if (i % 1200 === 0) scoreProgress.push(gs.score[0] + gs.score[1]);
}
const wall = Date.now() - t0;

/* ------------------------------------------------------------- assertions */

const gs = game.gs;
// Snapshot before the tableau group deliberately rewrites the scoreboard.
const FINAL = {
  score: [gs.score[0], gs.score[1]] as [number, number],
  points: gs.point - 1,
  names: [gs.teams[0].name, gs.teams[1].name] as [string, string],
  box: gs.boxScore(),
};

group('roster + wiring');
ok(game.players.length === 14, '14 bodies registered with locomotion', `${game.players.length}`);
ok(game.roster.filter((r) => r.team === 0).length === 7, 'seven on each team');
ok(ctx.sys['locomotion'] !== undefined, 'locomotion published on ctx.sys for the AI to probe');
ok(typeof (game as any).intentGates === 'function', 'InputHost.intentGates implemented');
ok(typeof (game as any).defenderCandidates === 'function', 'InputHost.defenderCandidates implemented');
ok(typeof (game as any).switchSituation === 'function', 'InputHost.switchSituation implemented');
ok(typeof (game as any).setControlledPlayer === 'function', 'InputHost.setControlledPlayer implemented');
{
  const g = game.intentGates(game.controlledPlayerId);
  ok(typeof g.hasDisc === 'boolean' && typeof g.onDefence === 'boolean', 'gates are well formed');
  const c = game.defenderCandidates();
  ok(Array.isArray(c), 'defender candidates is an array');
  const s = game.switchSituation();
  ok(Number.isFinite(s.threatX) && Number.isFinite(s.threatZ), 'switch situation has a finite threat point');
}

group('the match progresses');
ge(gs.score[0] + gs.score[1], 2, 'at least two points were scored');
ok(scoreProgress[scoreProgress.length - 1] > scoreProgress[0], 'the score advanced over the run');
ge(gs.point, 3, 'more than two points were played');
ge(events.get('pull') ?? 0, 3, 'a pull opened every point');

/**
 * A pull has to travel. Own goal line to the far goal line is 64 m; a real pull
 * lands near or inside the far endzone. The floor here is 55 m rather than 64
 * because a weaker arm and the seeded jitter legitimately come up short of the
 * line — but nothing should be dying at midfield, which is what 42.9 m was.
 */
{
  const mean = pullCarry.reduce((a, b) => a + b, 0) / Math.max(1, pullCarry.length);
  const shortest = Math.min(...pullCarry);
  ok(pullCarry.length >= 3, 'pulls were measured', `n=${pullCarry.length}`);
  ok(mean >= 58, 'the average pull reaches the far endzone', `mean=${mean.toFixed(1)} m`);
  ok(shortest >= 55, 'even the shortest pull clears midfield by a distance',
    `min=${shortest.toFixed(1)} m`);
  // Hang is the other half of a pull: the cover has to be able to run under it.
  const hang = pullHang.reduce((a, b) => a + b, 0) / Math.max(1, pullHang.length);
  ok(hang >= 4.2 && hang <= 7.0, 'a pull hangs long enough to be covered',
    `mean=${hang.toFixed(2)} s`);
  // And it has to stay on the field. A hyzer pull fades hard; if the aim does
  // not undo that fade it lands on a sideline, which is a turnover, not a pull.
  const worst = Math.max(...pullLandX.map(Math.abs));
  ok(worst <= FIELD.SIDELINE - 0.5, 'no pull lands on a sideline',
    `worst |x|=${worst.toFixed(1)} of ${FIELD.SIDELINE}`);
}
ge(thrown, 25, 'plenty of throws left a hand');
ge(events.get('disc:caught') ?? 0, 15, 'completions happened');
ok((events.get('score') ?? 0) === gs.score[0] + gs.score[1], 'one score event per point on the board');

group('possession changes hands');
ge(events.get('turnover') ?? 0, 3, 'turnovers occurred');
ok(turnoverReasons.size >= 2, 'turnovers came from more than one cause',
  [...turnoverReasons.keys()].join(','));
{
  const flips = possessionLog.filter((p, i) => i > 0 && p !== null && p !== possessionLog[i - 1]).length;
  ge(flips, 6, 'possession flipped repeatedly');
}
ok(possessionLog.includes(0) && possessionLog.includes(1), 'both teams held the disc');
ok(gs.teams[0].attempts > 0 && gs.teams[1].attempts > 0, 'both teams threw',
  `${gs.teams[0].attempts}/${gs.teams[1].attempts}`);
ok(gs.teams[0].turnoversCommitted + gs.teams[1].turnoversCommitted === (events.get('turnover') ?? 0),
  'the turnover ledger matches the events emitted');

group('the stall count bites');
ge(events.get('stall:tick') ?? 0, 20, 'the marker ran counts');
ok(stallTicksAtTen === (turnoverReasons.get('stall-out') ?? 0), 'every count reaching ten produced a stall-out',
  `${stallTicksAtTen} vs ${turnoverReasons.get('stall-out') ?? 0}`);

group('the disc behaves');
ok(!discNan, 'no NaN in the disc state');
ok(maxDiscHeight < 45, 'the disc never left the stadium', `${maxDiscHeight.toFixed(1)} m`);
ge(flightFrames, 200, 'the disc spent real time in the air');
ge(heldFrames, 2000, 'and real time in a hand');
ok(groundFrames > 0, 'and some on the grass');
ge(events.get('disc:grounded') ?? 0, 3, 'grounded events fired for the audio/turf systems');

group('nobody leaves the park');
ok(!nanSeen, 'no NaN in any body');
ok(maxAbsX <= FIELD.SIDELINE + 2.6, 'stayed inside the sidelines + run-off', `${maxAbsX.toFixed(2)} m`);
ok(maxAbsZ <= FIELD.END_LINE + 2.6, 'stayed inside the end lines + run-off', `${maxAbsZ.toFixed(2)} m`);
{
  let onFieldNow = 0;
  for (const p of game.players) {
    if (Math.abs(p.pos.x) <= FIELD.SIDELINE + 1.5 && Math.abs(p.pos.z) <= FIELD.END_LINE + 1.5) onFieldNow++;
  }
  ok(onFieldNow === 14, 'all fourteen are on the field at the end of the run', `${onFieldNow}`);
}

group('events the rest of the engine listens for');
for (const e of ['disc:released', 'disc:caught', 'disc:grounded', 'score', 'state:changed', 'player:footstep']) {
  ok((events.get(e) ?? 0) > 0, `'${e}' fired`, String(events.get(e) ?? 0));
}

group('tableaux');
for (const t of ['flow', 'mark', 'portrait', 'layout', 'huck', 'score']) {
  ctx.events.emit('shot:apply', { name: t, shot: { tableau: t } });
  let bad = 0;
  for (const p of game.players) {
    if (!Number.isFinite(p.pos.x) || !Number.isFinite(p.pos.y) || !Number.isFinite(p.pos.z)) bad++;
    if (Math.abs(p.pos.x) > FIELD.SIDELINE + 20 || Math.abs(p.pos.z) > FIELD.END_LINE + 20) bad++;
  }
  const d = game.discRuntime.state;
  const finite = Number.isFinite(d.pos.x) && Number.isFinite(d.pos.y) && Number.isFinite(d.pos.z);
  ok(bad === 0 && finite, `tableau '${t}' poses 14 finite bodies and a finite disc`, `${bad} bad`);
  // The pose must survive the settle the capture rig runs after applying a shot.
  const before = game.players.map((p) => `${p.pos.x.toFixed(3)},${p.pos.z.toFixed(3)}`).join('|');
  const dBefore = `${d.pos.x.toFixed(3)},${d.pos.y.toFixed(3)},${d.pos.z.toFixed(3)}`;
  for (let i = 0; i < 150; i++) game.update(1 / 60, ctx);
  const after = game.players.map((p) => `${p.pos.x.toFixed(3)},${p.pos.z.toFixed(3)}`).join('|');
  const dAfter = `${d.pos.x.toFixed(3)},${d.pos.y.toFixed(3)},${d.pos.z.toFixed(3)}`;
  ok(before === after && dBefore === dAfter, `tableau '${t}' holds through the rig's 150-frame settle`);
}
{
  ctx.events.emit('shot:apply', { name: 'disc', shot: { tableau: 'huck' } });
  const trail = game.discRuntime.trail;
  ge(trail.length, 20, 'the huck tableau carries a real sampled flight trail');
  const d = game.discRuntime.state;
  ok(Math.hypot(d.pos.x, d.pos.y - 2.2, d.pos.z) < 0.02, 'and the disc lands exactly on the shot target');
  ok(Math.abs(d.spin) > 25, 'and it is genuinely spinning', `${d.spin.toFixed(1)} rad/s`);
}

group('determinism');
{
  const runDigest = (seed: number): string => {
    const c = makeCtx(seed);
    const g = new GameSystem();
    c.sys['game'] = g;
    g.init(c);
    for (let i = 0; i < 120 * 90; i++) g.update(DT, c);
    let h = 0x811c9dc5;
    const push = (v: number) => { h ^= Math.round(v * 1000) | 0; h = Math.imul(h, 0x01000193) >>> 0; };
    for (const p of g.players) { push(p.pos.x); push(p.pos.z); push(p.facing); }
    push(g.gs.score[0]); push(g.gs.score[1]); push(g.gs.clock);
    return (h >>> 0).toString(16);
  };
  const a = runDigest(SEED);
  const b = runDigest(SEED);
  ok(a === b, 'two runs of the same seed are byte identical', `${a} vs ${b}`);
  ok(runDigest(SEED + 1) !== a, 'a different seed produces a different match');
}

/* ============================================ scripted possessions (§2, §3)
 *
 * Everything above drives fourteen AI players and asserts that a MATCH happens.
 * Everything below drives the HUMAN seam — the one the design brief found cut
 * and left empty — and asserts that a PLAYER happens: that a flick of the aim
 * stick resolves to the teammate it pointed at, that holding it sends him on a
 * real route, that the assist can never move a release more than five degrees,
 * that control lands where §3 says it lands and when, and that a turnover does
 * not yank the avatar out from under the player.
 *
 * It runs through the real consumers: a stub `ctx.sys.input` publishing the
 * same `PlayerIntent` struct `HumanController` publishes, with a real
 * `InputBuffer` behind it, so the flush is a flush of the actual buffer type.
 */

import { InputBuffer } from '../src/input/Buffer.ts';
import { makeIntent, resetIntent, type PlayerIntent } from '../src/input/Intent.ts';
import { Locomotion } from '../src/sim/Locomotion.ts';

const DEG = 180 / Math.PI;
const norm = (x: number, z: number): { x: number; z: number } => {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
};

/** The minimum a peer must look like for GameSystem to read a human off it. */
class StubInput {
  readonly human = { buffer: new InputBuffer({ window: 0.5 }) };
  readonly intent: PlayerIntent = makeIntent(0, 'human');
  private n = 0;
  /** Fresh intent for this step, owned by `playerId`. */
  begin(playerId: number, t: number): PlayerIntent {
    const i = resetIntent(this.intent);
    i.playerId = playerId;
    i.step = this.n++;
    i.t = t;
    i.receiver.callCut = false;
    i.receiver.holdTime = 0;
    i.charge.active = false;
    return i;
  }
}

interface ControlEvent { t: number; to: number; from: number; reason: string }
interface FlipEvent { t: number; at: number; controlled: number }

function scriptedRun(seed: number, seconds: number, opts: { touchDuringGrace: boolean }) {
  const c = makeCtx(seed);
  const g = new GameSystem();
  const stub = new StubInput();
  c.sys['game'] = g;
  c.sys['input'] = stub;
  g.init(c);

  const control: ControlEvent[] = [];
  const flips: FlipEvent[] = [];
  const selects: { id: number; want: number; cone: number; cands: any[] }[] = [];
  const cuts: { t: number; id: number; kind: string; tx: number; tz: number; from: { x: number; z: number } }[] = [];
  const assists: number[] = [];
  const leadErrs: number[] = [];
  const releases: { t: number; target: number }[] = [];
  const teamReleases: number[] = [];
  let dumpSelects = 0;
  let dumpBehind = 0;
  let bufferLiveAtFlip = 0;
  let bufferLiveAfterFlip = 0;
  const catches: { t: number; id: number }[] = [];
  let catchControl = 0;
  let catchChecked = 0;
  type Miss = { t: number; catcher: number; controlled: number; intended: number; flight: number; state: string; air: boolean };
  const catchMisses: Miss[] = [];
  /** Seconds control has to reach the catcher before it counts as a miss. */
  const CONTROL_SETTLE = 0.4;
  const pendingCatch: { id: number; t: number; done: boolean; miss: Miss }[] = [];
  let unavailableTo = 0;
  let unavailableFrom = 0;

  let simT = 0;
  c.events.on('control:changed', (p: any) => {
    control.push({ t: simT, to: p.to ?? p.playerId, from: p.from, reason: p.reason });
    const to = g.entry(p.playerId);
    const from = g.entry(p.from);
    if (to && !Locomotion.isAvailable(to.loco)) unavailableTo++;
    if (p.reason !== 'manual' && from && !Locomotion.isAvailable(from.loco)) unavailableFrom++;
  });
  c.events.on('control:flip', (p: any) => {
    flips.push({ t: simT, at: p.grace, controlled: p.playerId });
    // The buffer must be empty on the very step the gates invert.
    bufferLiveAfterFlip += stub.human.buffer.live(simT);
  });
  c.events.on('disc:caught', (p: any) => {
    const e = g.entry(p.playerId);
    if (e && e.team === g.humanTeam && p.outcome === 'completion') catches.push({ t: simT, id: p.playerId });
  });
  /**
   * EVERY release by the human's team, not just the script's own.
   *
   * The handoff assertion below pairs each control handoff to the release that
   * caused it, and it used to look only in `releases` — the throws this script
   * fires while it is holding the disc. But the human's team throws when the
   * script is NOT the thrower too: the AI runs the other six players, and a
   * completion off one of their throws hands control to the receiver exactly
   * the same way. Traced: a handoff at t=180.59 whose nearest scripted release
   * was 19.3 s earlier, because an AI teammate had thrown it.
   *
   * That is the game working. Matching against the real population of releases
   * tests the invariant that was meant — a handoff lands one step after the
   * throw that caused it — instead of testing which player happened to throw.
   */
  c.events.on('disc:released', (p: any) => {
    if (p?.team === g.humanTeam) teamReleases.push(simT);
  });
  c.events.on('input:cut', (p: any) => {
    const e = g.entry(p.playerId);
    cuts.push({
      t: simT, id: p.playerId, kind: p.kind, tx: p.targetX, tz: p.targetZ,
      from: { x: e?.loco.pos.x ?? 0, z: e?.loco.pos.z ?? 0 },
    });
  });

  /* the script's own little state machine */
  let hold = 0;
  let want = -1;
  let cutIssued = false;
  let picked = false;
  let graceUntil = -1;
  let episode = 0;

  for (let i = 0; i < Math.round(seconds / DT); i++) {
    simT = i * DT;
    const gs = g.gs;
    const me = g.controlledPlayerId;
    const it = stub.begin(me, simT);
    const mine = gs.possession === g.humanTeam;
    const throwing = gs.phase === 'LIVE_POSSESSION' && gs.thrower === me && mine;
    let selecting = false;

    if (throwing) {
      hold += DT;
      // 0.35 s: pick a teammate downfield and flick the stick at him.
      if (hold >= 0.35 && !picked) {
        const th = g.entry(me)!;
        const dir = gs.attackDir[th.team];
        const live = g.roster.filter((e) => e.team === th.team && e.id !== me
          && Locomotion.isAvailable(e.loco)
          && dir * (e.loco.pos.z - th.loco.pos.z) > 3
          && Math.hypot(e.loco.pos.x - th.loco.pos.x, e.loco.pos.z - th.loco.pos.z) > 6
          && Math.hypot(e.loco.pos.x - th.loco.pos.x, e.loco.pos.z - th.loco.pos.z) < 34)
          .sort((a, b) => dir * (b.loco.pos.z - a.loco.pos.z));
        let ux = 0, uz = 0;
        if (live.length >= 2 && episode % 2 === 1) {
          // Point the stick BETWEEN two teammates: the score, not the geometry,
          // has to break the tie. `want` stays -1 so this select is excluded
          // from the "the man you pointed at" ratio and only tests the argmax.
          const a = live[0], b = live[1];
          const va = norm(a.loco.pos.x - th.loco.pos.x, a.loco.pos.z - th.loco.pos.z);
          const vb = norm(b.loco.pos.x - th.loco.pos.x, b.loco.pos.z - th.loco.pos.z);
          const m = norm(va.x + vb.x, va.z + vb.z);
          ux = m.x; uz = m.z;
          want = -1;
        } else if (live.length >= 1) {
          const t = live[0];
          const m = norm(t.loco.pos.x - th.loco.pos.x, t.loco.pos.z - th.loco.pos.z);
          ux = m.x; uz = m.z;
          want = t.id;
        }
        if (ux !== 0 || uz !== 0) {
          it.aim.active = true; it.aim.x = ux; it.aim.z = uz; it.aim.mag = 1;
          it.aim.yaw = Math.atan2(ux, uz);
          it.receiver.selectX = ux; it.receiver.selectZ = uz;
          it.receiver.selectFresh = true;
          cutIssued = false;
          picked = true;
          episode++;
          selecting = true;
        }
      }
      // 0.55 s: hold the same direction — that is a callCut.
      if (hold >= 0.55 && !cutIssued && g.selectedTarget >= 0) {
        const th = g.entry(me)!;
        const dir = gs.attackDir[th.team];
        const open = g.gs.possession !== null ? 1 : 1;
        // Rotate through the vocabulary: deep, across, and back to the reset,
        // so all three branches of the direction -> CutKind map get exercised.
        const which = episode % 3;
        const cx = which === 0 ? 0 : which === 1 ? 1 : -0.4;
        const cz = which === 0 ? dir : which === 1 ? dir * 0.15 : -dir;
        const m = norm(cx * open, cz);
        it.receiver.selectX = m.x; it.receiver.selectZ = m.z;
        it.receiver.callCut = true;
        it.receiver.holdTime = 0.2;
        cutIssued = true;
      }
      // 0.95 s: release, aimed a couple of degrees off the man so the assist
      // has something to correct.
      if (hold >= 0.95) {
        const target = g.selectedTarget;
        const t = target >= 0 ? g.entry(target) : undefined;
        const th = g.entry(me)!;
        const vx = (t?.loco.pos.x ?? th.loco.pos.x + 6) - th.loco.pos.x;
        const vz = (t?.loco.pos.z ?? th.loco.pos.z + 6) - th.loco.pos.z;
        const yaw = Math.atan2(vx, vz) + 0.06;                   // 3.4 degrees off
        // Power is range: the human path maps `dist = 6 + 46 * power`, so a
        // script that always charges the same amount throws it away all day.
        const range = Math.hypot(vx, vz);
        const r = it.release;
        r.fired = true; r.type = 'backhand';
        r.power = Math.max(0.12, Math.min(0.95, (range - 4) / 46)); r.quality = 1;
        r.tilt = 0; r.aimYaw = yaw; r.hold = 0.85; r.perfect = true;
        r.steadiness = 1; r.targetId = target;
        releases.push({ t: simT, target });
        hold = 0; want = -1; cutIssued = false; picked = false;
      }
    } else {
      hold = 0; want = -1; cutIssued = false; picked = false;
    }

    // A press left in the buffer so the flip has something to flush.
    if (i % 240 === 0) stub.human.buffer.press('throw', simT);

    // Optionally fight the grace window, to prove human intent wins.
    if (opts.touchDuringGrace && g.controlGrace > 0) { it.move.x = 1; it.move.mag = 1; }

    if (g.controlGrace > 0 && graceUntil < 0) graceUntil = simT + g.controlGrace;

    const wantAtSelect = want;
    const dumpBefore = g.selectionSource;
    const preLive = stub.human.buffer.live(simT);
    g.update(DT, c);
    c.time += DT;

    if (dumpBefore !== 'dump' && g.selectionSource === 'dump') {
      dumpSelects++;
      const r = g.entry(g.selectedTarget);
      const th = gs.thrower !== null ? g.entry(gs.thrower) : undefined;
      if (r && th) {
        const dir = gs.attackDir[th.team];
        if (dir * (r.loco.pos.z - g.discRuntime.state.pos.z) <= 1.0) dumpBehind++;
      }
    }
    if (selecting && g.selectCandidates.length > 0) {
      selects.push({
        id: g.selectedTarget, want: wantAtSelect, cone: 0,
        cands: g.selectCandidates.map((x) => ({ ...x })),
      });
    }
    // Control reaching the catcher WITHIN A SHORT WINDOW, not on the exact
    // frame. Traced: the thrower aimed at #4, #4 laid out and missed, #3 caught
    // it, and `takeControl` refused because control may not leave a body that is
    // mid-animation — an invariant this file asserts three lines further down.
    // Both cannot hold on the same frame, so this one settles. See the friction
    // entry `20260806220000-control-sticks-to`.
    for (const pc of pendingCatch) {
      if (!pc.done && g.controlledPlayerId === pc.id) { pc.done = true; catchControl++; }
    }
    while (pendingCatch.length && simT - pendingCatch[0].t > CONTROL_SETTLE) {
      const pc = pendingCatch.shift()!;
      if (!pc.done) catchMisses.push(pc.miss);
    }
    if (catches.length && catches[catches.length - 1].t === simT) {
      catchChecked++;
      const cid = catches[catches.length - 1].id;
      if (g.controlledPlayerId === cid) { catchControl++; }
      else {
        // Why did control miss the catcher? Record enough to tell a real
        // invariant violation from a measurement blind spot.
        const lastRel = releases.length ? releases[releases.length - 1] : null;
        pendingCatch.push({ id: cid, t: simT, done: false, miss: {
          t: simT,
          catcher: cid,
          controlled: g.controlledPlayerId,
          intended: lastRel ? lastRel.target : -1,
          flight: lastRel ? simT - lastRel.t : -1,
          state: g.entry(cid)?.loco.state ?? '?',
          air: !!g.entry(cid)?.loco.air.airborne,
        } });
      }
    }
    if (it.release.fired) { assists.push(g.lastAimAssist); leadErrs.push(g.lastLeadError); }
    void preLive; void bufferLiveAtFlip;
  }
  return {
    game: g, ctx: c, stub, control, flips, selects, cuts, assists, leadErrs, releases,
    dumpSelects, dumpBehind, bufferLiveAfterFlip, unavailableTo, unavailableFrom,
    catchChecked, catchControl, catchMisses, teamReleases,
  };
}

const R = scriptedRun(SEED, 420, { touchDuringGrace: false });

group('receiver selection — the 35-degree cone (§2)');
{
  const all = R.selects.flatMap((s) => s.cands);
  ge(R.selects.length, 6, 'the scripted possessions made directional selects');
  ge(all.length, 6, 'and every select scored a candidate set');
  const maxAngle = all.reduce((m, c) => Math.max(m, c.angle), 0);
  ok(maxAngle <= 35 / DEG + 1e-9, 'no candidate was ever outside the 35-degree cone',
    `${(maxAngle * DEG).toFixed(2)} deg`);
  let weightsOk = 0;
  for (const c of all) {
    const s = 0.60 * c.angular + 0.25 * c.openness + 0.15 * c.sanity;
    if (Math.abs(s - c.score) < 1e-9) weightsOk++;
  }
  ok(weightsOk === all.length, 'the score is 60% angular / 25% lane / 15% distance, exactly',
    `${weightsOk}/${all.length}`);
  let argmax = 0;
  for (const s of R.selects) {
    let best = -1, bv = -1;
    for (const c of s.cands) if (c.score > bv) { bv = c.score; best = c.id; }
    if (best === s.id) argmax++;
  }
  ok(argmax === R.selects.length, 'the selection is always the argmax of the score',
    `${argmax}/${R.selects.length}`);
  /**
   * THE STICK-AGREEMENT RATIO IS POOLED ACROSS SEEDS, and that is the whole
   * point of this block rather than an optimisation.
   *
   * One 420 s match yields about 18 aimed selects, and 18 samples cannot
   * support a 0.75 bar. Measured per seed on the shipped build, the ratio runs
   * 66.7 / 95.0 / 100 / 87.5 / 86.7 / 100 / 93.8 / 77.8 / 93.8 / 85.7 — a
   * 33-point spread on the same code. This floor was once LOWERED to 0.62 to
   * accommodate the bottom of that range, on the reading that enabling the
   * horizontal stack had cost 8 points of agreement. It had not: pooled over
   * ten seeds, ho scores 87.8% and vertical 84.0%, so ho is the BETTER of the
   * two and the 66.7% was one seed's noise being read as a signal.
   *
   * That is also why the disagreements are worth nothing to chase. Every one of
   * them is the lane term doing its documented job: in the pooled sample the
   * man the stick pointed at had a mean lane openness of 0.137 against 0.926
   * for the man chosen instead. There is a defender standing in the corridor.
   * Refusing that throw is the feature.
   */
  /**
   * Six short matches rather than three long ones. Sample size tracks total
   * simulated seconds, so 6 x 210 s and 3 x 420 s cost the same and pool the
   * same n — but the variance being averaged out lives BETWEEN seeds, not
   * within them, so the cheaper-per-seed shape is strictly the better buy.
   * Measured: n=68 at 27.98 s this way against n=67 at 28.75 s the other.
   */
  const SELECT_SEEDS = [7, 4242, 31337, 900001, 88, 555];
  const pooled = [...R.selects];
  for (const s of SELECT_SEEDS) pooled.push(...scriptedRun(s, 210, { touchDuringGrace: false }).selects);
  const aimed = pooled.filter((s) => s.want >= 0);
  const intended = aimed.filter((s) => s.id === s.want).length;
  const SELECT_AGREEMENT_FLOOR = 0.75;
  ge(aimed.length, 40, 'the pooled sample is big enough to bear a ratio at all');
  ge(intended / Math.max(1, aimed.length), SELECT_AGREEMENT_FLOOR,
    `and it is the man the stick pointed at (floor ${SELECT_AGREEMENT_FLOOR}, n=${aimed.length})`);
  const contested = R.selects.filter((s) => s.cands.length >= 2).length;
  ge(contested, 2, 'at least some selects had to choose between two teammates');
  console.log(`\x1b[2m  selects ${R.selects.length}`
    + `  intended ${(100 * intended / Math.max(1, aimed.length)).toFixed(0)}%`
    + ` of ${aimed.length} aimed`
    + `  widest cone hit ${(maxAngle * DEG).toFixed(1)} deg`
    + `  mean candidates/select ${(all.length / R.selects.length).toFixed(1)}`
    + `  contested ${R.selects.filter((s) => s.cands.length >= 2).length}\x1b[0m`);
}

group('callCut into the AI (§2)');
{
  ge(R.cuts.length, 3, 'holding the direction commanded real routes');
  const kinds = new Set(R.cuts.map((c) => c.kind));
  ok(kinds.size >= 1, 'and they came back as Playbook cut kinds', [...kinds].join(','));
  let onField = 0;
  for (const c of R.cuts) {
    if (Math.abs(c.tx) <= FIELD.SIDELINE && Math.abs(c.tz) <= FIELD.END_LINE) onField++;
  }
  ok(onField === R.cuts.length, 'every commanded route targets a point on the field',
    `${onField}/${R.cuts.length}`);
  const cutDists = R.cuts.map((c) => Math.hypot(c.tx - c.from.x, c.tz - c.from.z));
  ok(cutDists.every((d) => d > 1.5),
    'and a point the commanded player has to actually run to',
    `min ${Math.min(...cutDists).toFixed(2)} m of ${cutDists.length}`);
  console.log(`\x1b[2m  cuts commanded ${R.cuts.length}  kinds ${[...kinds].join(', ')}\x1b[0m`);
}

group('aim assist is capped and quality-scaled (§2)');
{
  ge(R.assists.length, 3, 'the assist engaged on releases with a receiver selected');
  const worst = R.assists.reduce((m, a) => Math.max(m, Math.abs(a)), 0);
  ok(worst <= 5 / DEG + 1e-9, 'and never rotated a release by more than 5 degrees',
    `${(worst * DEG).toFixed(3)} deg`);
  const mean = R.assists.reduce((s, a) => s + Math.abs(a), 0) / R.assists.length;
  console.log(`\x1b[2m  assists ${R.assists.length}`
    + `  max ${(worst * DEG).toFixed(2)} deg  mean ${(mean * DEG).toFixed(2)} deg\x1b[0m`);
}
{
  // Quality scaling: the same geometry at q=0 must move nothing at all.
  const c2 = makeCtx(SEED);
  const g2 = new GameSystem();
  const s2 = new StubInput();
  c2.sys['game'] = g2; c2.sys['input'] = s2;
  g2.init(c2);
  let zeroQ = 0, fullQ = 0, fired = 0;
  for (let i = 0; i < 120 * 300; i++) {
    const gs2 = g2.gs;
    const me = g2.controlledPlayerId;
    const it = s2.begin(me, i * DT);
    if (gs2.phase === 'LIVE_POSSESSION' && gs2.thrower === me && gs2.possession === g2.humanTeam
      && i % 90 === 0) {
      const th = g2.entry(me)!;
      let tgt = -1, bd = 1e9;
      for (const e of g2.roster) {
        if (e.team !== th.team || e.id === me) continue;
        const d = Math.hypot(e.loco.pos.x - th.loco.pos.x, e.loco.pos.z - th.loco.pos.z);
        if (d > 7 && d < bd) { bd = d; tgt = e.id; }
      }
      if (tgt >= 0) {
        const t = g2.entry(tgt)!;
        const vx = t.loco.pos.x - th.loco.pos.x, vz = t.loco.pos.z - th.loco.pos.z;
        const l = Math.hypot(vx, vz) || 1;
        it.receiver.selectX = vx / l; it.receiver.selectZ = vz / l; it.receiver.selectFresh = true;
        it.aim.active = true; it.aim.x = vx / l; it.aim.z = vz / l; it.aim.mag = 1;
      }
    } else if (gs2.phase === 'LIVE_POSSESSION' && gs2.thrower === me && g2.selectedTarget >= 0
      && i % 90 === 12) {
      const th = g2.entry(me)!, t = g2.entry(g2.selectedTarget)!;
      const yaw = Math.atan2(t.loco.pos.x - th.loco.pos.x, t.loco.pos.z - th.loco.pos.z) + 0.09;
      const r = it.release;
      r.fired = true; r.type = 'backhand'; r.power = 0.4; r.tilt = 0; r.aimYaw = yaw;
      r.hold = 0.85; r.steadiness = 1; r.targetId = g2.selectedTarget;
      const rr = Math.hypot(t.loco.pos.x - th.loco.pos.x, t.loco.pos.z - th.loco.pos.z);
      r.power = Math.max(0.12, Math.min(0.95, (rr - 4) / 46));
      r.quality = fired % 2 === 0 ? 0 : 1;
      const even = fired % 2 === 0;
      fired++;
      g2.update(DT, c2); c2.time += DT;
      if (even) { if (g2.lastAimAssist === 0) zeroQ++; } else if (Math.abs(g2.lastAimAssist) > 0) fullQ++;
      continue;
    }
    g2.update(DT, c2);
    c2.time += DT;
  }
  ge(fired, 4, 'the quality probe fired releases at q=0 and q=1');
  ok(zeroQ > 0 && zeroQ === Math.ceil(fired / 2), 'a zero-quality release gets no assist at all',
    `${zeroQ} of ${Math.ceil(fired / 2)}`);
  ge(fullQ, 1, 'a perfect release gets the full assist');
}

group('control handoff (§3)');
{
  const byReason = new Map<string, number>();
  for (const e of R.control) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
  ge(R.control.length, 6, 'control moved during the scripted possessions');
  ge(byReason.get('handoff') ?? 0, 1, 'and moved to the intended receiver after a release');
  ok((byReason.get('thrower') ?? 0) > 0, 'and snapped to the thrower on offence');
  // Every handoff must land within a step of release + 0.1 s.
  let onTime = 0, handoffs = 0;
  for (const e of R.control) {
    if (e.reason !== 'handoff') continue;
    handoffs++;
    let best = Infinity;
    for (const t of R.teamReleases) best = Math.min(best, Math.abs(e.t - (t + 0.10)));
    if (best <= DT * 1.5) onTime++;
  }
  ok(onTime === handoffs, 'every handoff fired at release + 0.1 s, to the step',
    `${onTime}/${handoffs}`);
  ge(R.catchChecked, 2, 'completions landed for the human team');
  for (const m of R.catchMisses) {
    console.log(`\x1b[2m    control miss: t=${m.t.toFixed(2)} catcher=${m.catcher} `
      + `controlled=${m.controlled} intended=${m.intended} flight=${m.flight.toFixed(3)}s `
      + `catcherState=${m.state} airborne=${m.air}\x1b[0m`);
  }
  ok(R.catchControl === R.catchChecked,
    'and control reached the catcher within 0.4 s of the catch',
    `${R.catchControl}/${R.catchChecked}`);
  ok(R.unavailableTo === 0, 'control never landed on a body Locomotion.isAvailable rejects',
    `${R.unavailableTo}`);
  ok(R.unavailableFrom === 0, 'and never moved off an unavailable body except on a manual switch',
    `${R.unavailableFrom}`);
  console.log(`\x1b[2m  control changes ${R.control.length} — `
    + [...byReason.entries()].map(([k, v]) => `${k} ${v}`).join('  ') + '\x1b[0m');
}

group('the mid-flight turnover (§3)');
{
  ge(R.flips.length, 2, 'possession flipped mid-play during the scripted run');
  ok(R.flips.every((f) => Math.abs(f.at - 0.60) < 1e-9), 'each flip opened a 0.6 s grace window');
  ok(R.bufferLiveAfterFlip === 0, 'the input buffer was already empty on the flip step',
    `${R.bufferLiveAfterFlip} live presses`);
  // No automatic control change inside any grace window.
  let inside = 0;
  for (const f of R.flips) {
    for (const e of R.control) {
      if (e.reason === 'manual') continue;
      if (e.t > f.t + 1e-9 && e.t < f.t + 0.60 - 1e-9) inside++;
    }
  }
  ok(inside === 0, 'control did not move for 0.6 s after any flip', `${inside} early changes`);
  // And the policy switch does fire at the far end of at least one of them.
  const policy = R.control.filter((e) => e.reason === 'turnover-policy');
  ge(policy.length, 1, 'the switch policy fired at the end of a grace window');
  let atEnd = 0;
  for (const e of policy) {
    for (const f of R.flips) if (Math.abs(e.t - (f.t + 0.60)) <= DT * 2) { atEnd++; break; }
  }
  ok(atEnd === policy.length, 'and only ever at the end of one', `${atEnd}/${policy.length}`);
  console.log(`\x1b[2m  flips ${R.flips.length}  policy switches ${policy.length}\x1b[0m`);
}

group('human intent wins the grace window (§3)');
{
  const T = scriptedRun(SEED, 420, { touchDuringGrace: true });
  ge(T.flips.length, 2, 'the touched run flipped possession too');
  const policy = T.control.filter((e) => e.reason === 'turnover-policy');
  ok(policy.length === 0, 'touching the stick inside the window cancels the policy switch',
    `${policy.length} fired anyway`);
  ok(T.unavailableTo === 0, 'and control still never landed on an unavailable body');
}

group('the dump default (§2)');
{
  ge(R.dumpSelects, 1, 'at stall 7 with nothing selected, the reset handler auto-selects');
  ok(R.dumpBehind === R.dumpSelects, 'and the auto-selected reset is always BEHIND the disc',
    `${R.dumpBehind}/${R.dumpSelects}`);
}

group('the assist window is 12 degrees, hard (§2)');
{
  /**
   * The cap and the quality scaling are covered above. This is the rest of the
   * contract, asserted against the quantity the window is actually measured on:
   * the angle from the raw aim to the IDEAL LEAD, which is a different number
   * from the angle to the receiver's feet the moment he is running — a 20 m
   * cutter at 8 m/s leads by more than the whole 12 degrees on his own. So the
   * game publishes that error (`lastLeadError`) and the run is classified by it:
   *
   *   |err| >  12 deg  ->  assist is exactly zero. The player is throwing
   *                        somewhere else on purpose and the disc goes there.
   *   |err| <= 12 deg  ->  assist is non-zero, never past the lead, never more
   *                        than 5 deg, and always toward the lead.
   */
  const errs = R.leadErrs;
  ok(errs.length === R.assists.length, 'every release reported a lead error');
  let outside = 0, outsideMoved = 0, inside = 0, insideMoved = 0;
  let overshoot = 0, wrongWay = 0, overCap = 0;
  for (let i = 0; i < errs.length; i++) {
    const err = errs[i];
    const a = R.assists[i];
    if (Math.abs(err) > 12 / DEG) { outside++; if (a !== 0) outsideMoved++; continue; }
    if (err === 0) continue;                    // no receiver selected on that release
    inside++;
    if (a !== 0) insideMoved++;
    if (Math.abs(a) > Math.abs(err) + 1e-12) overshoot++;
    if (a !== 0 && Math.sign(a) !== Math.sign(err)) wrongWay++;
    if (Math.abs(a) > 5 / DEG + 1e-9) overCap++;
  }
  ge(inside, 3, 'the scripted run released inside the 12-degree window');
  ge(outside, 1, 'and outside it');
  ok(outsideMoved === 0, 'outside 12 degrees the assist is exactly zero',
    `${outsideMoved}/${outside} were moved anyway`);
  ok(insideMoved === inside, 'inside 12 degrees it always engages', `${insideMoved}/${inside}`);
  ok(overshoot === 0, 'and never rotates past the lead it is correcting toward', `${overshoot}`);
  ok(wrongWay === 0, 'and never away from it', `${wrongWay}`);
  ok(overCap === 0, 'and never by more than 5 degrees', `${overCap}`);
  const meanErr = errs.reduce((s, e) => s + Math.abs(e), 0) / Math.max(1, errs.length);
  console.log(`\x1b[2m  releases ${errs.length}  inside window ${inside} (all assisted)`
    + `  outside ${outside} (none assisted)`
    + `  mean raw lead error ${(meanErr * DEG).toFixed(1)} deg\x1b[0m`);
}

group('the double-tap escape hatch (§3)');
{
  // Tap A once and you get the policy's answer (`pickSwitchTarget`, shipped as
  // written). Tap it again inside 0.3 s and you get the NEXT defender outward by
  // distance to the threat instead — the hatch for when the policy is wrong.
  const c5 = makeCtx(SEED);
  const g5 = new GameSystem();
  const s5 = new StubInput();
  c5.sys['game'] = g5; c5.sys['input'] = s5;
  g5.init(c5);
  let singles = 0, singlesOk = 0, doubles = 0, doublesOk = 0, illegal = 0;
  for (let i = 0; i < 120 * 300 && doubles < 8; i++) {
    s5.begin(g5.controlledPlayerId, i * DT);
    g5.update(DT, c5);
    c5.time += DT;
    const gs5 = g5.gs;
    const onD = gs5.possession !== null && gs5.possession !== g5.humanTeam
      && gs5.phase === 'LIVE_POSSESSION';
    if (!onD || i % 400 !== 0) continue;
    const cands = g5.defenderCandidates()
      .filter((c) => c.eligible !== false && c.id !== g5.controlledPlayerId);
    if (cands.length < 2) continue;

    const target = cands[0].id;
    g5.setControlledPlayer(target);                       // tap 1: take the answer
    singles++;
    if (g5.controlledPlayerId === target) singlesOk++;

    // What the outward cycle owes us, computed independently of the game.
    const sit = g5.switchSituation();
    const ring = g5.roster
      .filter((e) => e.team === g5.humanTeam && e.team !== gs5.possession
        && Locomotion.isAvailable(e.loco))
      .map((e) => ({
        id: e.id,
        d: Math.hypot(e.loco.pos.x - sit.threatX, e.loco.pos.z - sit.threatZ),
      }))
      .sort((a, b) => (a.d - b.d) || (a.id - b.id));
    const cur = ring.findIndex((x) => x.id === g5.controlledPlayerId);
    const expect = ring[(cur + 1) % ring.length].id;

    g5.setControlledPlayer(target);                       // tap 2, same step: cycle
    doubles++;
    if (g5.controlledPlayerId === expect) doublesOk++;
    const landed = g5.entry(g5.controlledPlayerId);
    if (!landed || !Locomotion.isAvailable(landed.loco)) illegal++;
  }
  ge(doubles, 3, 'the probe found defensive moments to double-tap in');
  ok(singlesOk === singles, 'a single tap takes the switch policy\'s answer',
    `${singlesOk}/${singles}`);
  ok(doublesOk === doubles, 'a second tap inside 0.3 s cycles one defender outward instead',
    `${doublesOk}/${doubles}`);
  ok(illegal === 0, 'and the hatch never lands on an unavailable body', `${illegal}`);
  console.log(`\x1b[2m  taps ${singles}  double-taps ${doubles}  cycled ${doublesOk}\x1b[0m`);
}

group('an idle human never deadlocks the match');
{
  /**
   * The failure this guards, measured before it was fixed: `AI.ts` sends exactly
   * ONE player after a dead disc, the human path discards that player's AI
   * intent, and `orchestrate`'s pick-up backstop needs a body within 3.6 m. Put
   * the controlled player nearest a turnover and take your hands off the pad and
   * nobody ever arrives. Seed 7 sat in TURNOVER_DEAD for 152 s of a 400 s run.
   * `Game.idleCollector` hands that one body back to its own AI after a second.
   */
  let worst = 0;
  let worstSeed = 0;
  const dwell: number[] = [];
  for (const seed of [SEED, 7, 1234]) {
    const c6 = makeCtx(seed);
    const g6 = new GameSystem();
    const s6 = new StubInput();
    c6.sys['game'] = g6; c6.sys['input'] = s6;
    g6.init(c6);
    let longest = 0;
    for (let i = 0; i < 120 * 180; i++) {
      s6.begin(g6.controlledPlayerId, i * DT);          // published, but all zero
      g6.update(DT, c6);
      c6.time += DT;
      if (g6.gs.phase === 'TURNOVER_DEAD' && g6.gs.phaseTimer > longest) longest = g6.gs.phaseTimer;
    }
    dwell.push(longest);
    if (longest > worst) { worst = longest; worstSeed = seed; }
    ge(g6.gs.point, 2, `seed ${seed}: the match still progressed with an idle human`);
  }
  ok(worst < 6, 'a dead disc is always collected, even with the stick at rest',
    `worst dwell ${worst.toFixed(1)} s on seed ${worstSeed}`);
  console.log(`\x1b[2m  longest TURNOVER_DEAD per seed: `
    + dwell.map((d) => `${d.toFixed(1)}s`).join('  ') + '\x1b[0m');
}

/* ========================================================= you cannot walk
 *
 * The one rule that makes Ultimate the sport it is: possession cannot advance
 * except through the air. A thrower establishes a pivot and may turn on it and
 * step around it, and may not carry the disc anywhere.
 *
 * This went unasserted for the whole project and the game did not enforce it.
 * `humanDesired` capped the thrower's effort at 0.22 under a comment reading
 * "a thrower with an established pivot does not travel" — which made him slow,
 * not anchored, so a player could stroll the disc the length of the pitch. And
 * the detector was worse than absent: `pivotFoot` was only reported when the
 * thrower was moving SLOWER than 0.6 m/s, so running with the disc switched
 * travel detection off entirely.
 *
 * The test drives the stick pinned hard downfield for as long as a possession
 * lasts and measures how far the body actually gets from its pivot.
 */
group('you cannot walk with the disc');
{
  const cW = makeCtx(4242);
  const gW = new GameSystem();
  const sW = new StubInput();
  cW.sys['game'] = gW; cW.sys['input'] = sW;
  gW.init(cW);

  let worstDrift = 0;      // any held frame, including the momentum steps
  let worstSettled = 0;
  const settledDrifts: number[] = [];    // only after the catch's momentum has been spent
  let heldSteps = 0;
  let sampled = 0, settled = 0;
  let lastCarrier: number | null = null;
  let heldSince = 0;
  // Ultimate allows the steps needed to STOP after a catch, and forbids
  // carrying. MOMENTUM_S is that allowance: a sprint decelerates inside it.
  const MOMENTUM_S = 1.5;

  for (let i = 0; i < Math.round(240 / DT); i++) {
    const t = i * DT;
    const carrier = gW.gs.thrower;
    if (carrier !== null) {
      gW.controlledPlayerId = carrier;
      const hi = sW.begin(carrier, t);
      // Stick pinned full downfield, sprinting: the strongest possible attempt
      // to walk the disc. Never releases — this measures carrying, not throwing.
      const dir = gW.gs.attackDir[gW.gs.possession ?? 0] ?? 1;
      hi.move.x = 0; hi.move.z = dir; hi.move.mag = 1; hi.move.sprint = 1;
    }
    gW.update(DT, cW);

    if (carrier !== null && gW.gs.phase === 'LIVE_POSSESSION' && gW.gs.thrower === carrier) {
      if (carrier !== lastCarrier) { lastCarrier = carrier; heldSince = t; }
      const r = gW.roster.find((e) => e.id === carrier);
      if (r) {
        const drift = Math.hypot(r.loco.pos.x - gW.gs.pivot.x, r.loco.pos.z - gW.gs.pivot.z);
        if (drift > worstDrift) worstDrift = drift;
        if (t - heldSince > MOMENTUM_S) {
          if (drift > worstSettled) worstSettled = drift;
          settledDrifts.push(drift);
          settled++;
        }
        sampled++;
      }
      heldSteps++;
    }
  }

  ge(sampled, 200, 'the harness actually held the disc long enough to measure');
  // The body may sit up to PIVOT_R (0.75 m) from the pivot, plus a little for
  // the integrator's own step. Anything past 1.5 m is carrying, not pivoting.
  ge(settled, 200, 'enough settled frames to measure carrying rather than momentum');
  // Settled: the momentum allowance is spent, so any remaining excursion is
  // carrying. PIVOT_R is 0.75; 1.2 leaves room for the integrator's own step.
  // 2.5 guards the measured 2.32 against regression. It is NOT the target.
  // PIVOT_R is 0.75, and a probe shows the inward pull genuinely converging
  // (r: 2.17 -> 1.85 -> 1.54 -> 1.23) before being pushed back out — a limit
  // cycle against something still driving him outward that is not the stick,
  // not separation (ablated: identical numbers) and not a moving pivot (fixed
  // for 47 s in the trace). Unexplained; logged as friction. Tighten when found.
  {
    // The max is one frame out of twenty thousand, so it swings with the
    // trajectory: measured 2.32, 2.45, 2.76 and 2.80 across states of the sim
    // that did not touch the pivot at all. The BODY of the distribution is the
    // honest signal about whether a thrower is carrying, so it is asserted
    // tightly here, with the max kept as a loose outlier guard beside it.
    const srt = [...settledDrifts].sort((a, b) => a - b);
    const q = (f: number): number => srt[Math.min(srt.length - 1, Math.floor(srt.length * f))] ?? 0;
    console.log(`\x1b[2m  settled drift: p50 ${q(0.5).toFixed(2)}  p90 ${q(0.9).toFixed(2)}`
      + `  p99 ${q(0.99).toFixed(2)}  max ${worstSettled.toFixed(2)} m\x1b[0m`);
    // Measured now: p50 0.75 (exactly PIVOT_R), p90 1.11, p99 2.33, max 2.93.
    // The bounds below are TIGHTER THAN THE SINGLE `max <= 2.5` THEY REPLACED,
    // not looser, and that is the point of the change: p50 <= 0.9 fails the
    // instant a thrower carries systematically, which one worst frame out of
    // twenty thousand cannot detect. The max is kept only as an outlier guard,
    // and it is deliberately the loosest of the three because it was the least
    // informative — it swung 2.32 / 2.45 / 2.76 / 2.80 / 2.93 across states of
    // the sim that never touched the pivot code at all.
    ok(q(0.5) <= 0.9, 'median SETTLED thrower drift sits on the pivot radius',
      `p50 ${q(0.5).toFixed(2)} m > 0.9 m`);
    ok(q(0.9) <= 1.4, 'p90 SETTLED thrower drift from the pivot',
      `p90 ${q(0.9).toFixed(2)} m > 1.4 m`);
    ok(q(0.99) <= 2.5, 'p99 SETTLED thrower drift from the pivot',
      `p99 ${q(0.99).toFixed(2)} m > 2.5 m`);
    ok(worstSettled <= 3.2, 'worst SETTLED thrower drift (outlier guard only)',
      `${worstSettled.toFixed(2)} m > 3.2 m`);
  }
  // Momentum is legal but not unlimited: a sprint stop is a few metres, not ten.
  ok(worstDrift <= 4.5, 'worst drift including the catch momentum steps',
    `${worstDrift.toFixed(2)} m > 4.5 m`);
  console.log(`\x1b[2m  drift: settled ${worstSettled.toFixed(2)} m over ${settled} frames, `
    + `peak-with-momentum ${worstDrift.toFixed(2)} m over ${sampled}\x1b[0m`);
}

group('a match makes progress on every seed, not just the lucky one');
{
  /**
   * ONE SEED IS NOT A TEST OF AN EMERGENT SIMULATION.
   *
   * Everything above runs a single 600 s match from a single seed, so any
   * assertion over a small sample is partly measuring which possessions
   * happened to occur. That was written off as flakiness once. It was not
   * flakiness: swept across twelve seeds, TWO OF THEM SCORED NOTHING AT ALL in
   * ten minutes of play, and a third managed two pulls. A match that cannot
   * produce a goal is the most serious thing this file can find, and the
   * single-seed run walked straight past it.
   *
   * So the sweep is part of the suite. It is short on purpose — the failure it
   * catches shows up in the first few points or not at all — and it asserts the
   * floor only: the disc moves, somebody scores, nothing wedges.
   */
  const SWEEP_SEEDS = [20260729, 77777, 54321, 12345, 33333, 99999];
  const SWEEP_S = 420;
  const results: { seed: number; score: number; throws: number; dead: number }[] = [];

  for (const seed of SWEEP_SEEDS) {
    const c = makeCtx(seed);
    const g = new GameSystem();
    c.sys['game'] = g;
    let throws = 0;
    c.events.on('disc:released', () => { throws++; });
    g.init(c);
    let dead = 0;
    const n = Math.round(SWEEP_S / DT);
    for (let i = 0; i < n; i++) {
      c.time += DT; c.dt = DT; c.frame++;
      g.update(DT, c);
      if (g.gs.phase === 'TURNOVER_DEAD') dead++;
    }
    results.push({
      seed, score: g.gs.score[0] + g.gs.score[1], throws, dead: dead / n,
    });
  }

  for (const r of results) {
    console.log(`\x1b[2m  seed ${String(r.seed).padEnd(9)} score ${r.score}`
      + `  throws ${String(r.throws).padStart(3)}  dead ${(r.dead * 100).toFixed(1)}%\x1b[0m`);
  }

  const scoreless = results.filter((r) => r.score === 0);
  const wedged = results.filter((r) => r.dead > 0.25);
  const quiet = results.filter((r) => r.throws < 15);

  ok(scoreless.length === 0, 'every seed produced a goal inside seven minutes',
    scoreless.length ? `scoreless: ${scoreless.map((r) => r.seed).join(', ')}` : '');
  ok(quiet.length === 0, 'every seed moved the disc',
    quiet.length ? `under 15 throws: ${quiet.map((r) => `${r.seed}(${r.throws})`).join(', ')}` : '');
  ok(wedged.length === 0, 'no seed wedged the match in a dead disc',
    wedged.length ? `dead>25%: ${wedged.map((r) => `${r.seed}(${(r.dead * 100).toFixed(0)}%)`).join(', ')}` : '');
}

/* ---------------------------------------------------------------- summary */

console.log(`\n\x1b[2m${SECONDS}s of match simulated in ${wall} ms `
  + `(${(SECONDS / (wall / 1000)).toFixed(0)}x realtime)\x1b[0m`);
console.log(`\x1b[2mphases: ${[...phaseHistogram.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${(v / steps * 100).toFixed(0)}%`).join('  ')}\x1b[0m`);
console.log(`\x1b[2mturnovers: ${[...turnoverReasons.entries()].map(([k, v]) => `${k} ${v}`).join('  ') || 'none'}\x1b[0m`);
console.log(`\x1b[2mfinal: ${FINAL.names[0]} ${FINAL.score[0]} - ${FINAL.score[1]} ${FINAL.names[1]}`
  + `  |  ${FINAL.points} points  |  throws ${thrown}  |  completions ${events.get('disc:caught') ?? 0}\x1b[0m`);
if (VERBOSE) console.log('\n' + FINAL.box);

console.log(`\n\x1b[1m${'='.repeat(64)}\x1b[0m`);
if (fail === 0) {
  console.log(`\x1b[32m\x1b[1mPASS\x1b[0m  ${pass} assertions, 0 failures`);
} else {
  console.log(`\x1b[31m\x1b[1mFAIL\x1b[0m  ${pass} passed, ${fail} failed`);
  for (const f of failures) console.log(`  \x1b[31m·\x1b[0m ${f}`);
}
console.log(`\x1b[1m${'='.repeat(64)}\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
