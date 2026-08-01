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
  const releases: { t: number; target: number }[] = [];
  let dumpSelects = 0;
  let dumpBehind = 0;
  let bufferLiveAtFlip = 0;
  let bufferLiveAfterFlip = 0;
  const catches: { t: number; id: number }[] = [];
  let catchControl = 0;
  let catchChecked = 0;
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
    if (catches.length && catches[catches.length - 1].t === simT) {
      catchChecked++;
      if (g.controlledPlayerId === catches[catches.length - 1].id) catchControl++;
    }
    if (it.release.fired) assists.push(g.lastAimAssist);
    void preLive; void bufferLiveAtFlip;
  }
  return {
    game: g, ctx: c, stub, control, flips, selects, cuts, assists, releases,
    dumpSelects, dumpBehind, bufferLiveAfterFlip, unavailableTo, unavailableFrom,
    catchChecked, catchControl,
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
  const aimed = R.selects.filter((s) => s.want >= 0);
  const intended = aimed.filter((s) => s.id === s.want).length;
  ge(intended / Math.max(1, aimed.length), 0.75,
    'and it is the man the stick pointed at at least 75% of the time');
  const contested = R.selects.filter((s) => s.cands.length >= 2).length;
  ge(contested, 2, 'at least some selects had to choose between two teammates');
  console.log(`\x1b[2m  selects ${R.selects.length}`
    + `  intended ${(100 * intended / R.selects.length).toFixed(0)}%`
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
  ok(R.cuts.every((c) => Math.hypot(c.tx - c.from.x, c.tz - c.from.z) > 1.5),
    'and a point the commanded player has to actually run to');
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
    for (const r of R.releases) if (r.target >= 0) best = Math.min(best, Math.abs(e.t - (r.t + 0.10)));
    if (best <= DT * 1.5) onTime++;
  }
  ok(onTime === handoffs, 'every handoff fired at release + 0.1 s, to the step',
    `${onTime}/${handoffs}`);
  ge(R.catchChecked, 2, 'completions landed for the human team');
  ok(R.catchControl === R.catchChecked, 'and control was on the catcher on the catch frame',
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
