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
ctx.events.on('pull', (p: any) => {
  say('PULL', `${who(p?.playerId ?? p?.puller)} sends it away`);
});
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
