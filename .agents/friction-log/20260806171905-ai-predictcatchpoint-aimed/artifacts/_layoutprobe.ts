/**
 * Layout probe — how often does anybody actually lay out, and did they have to?
 *
 * A layout is a full-extension dive. In real ultimate it is a last resort: you
 * bid because you CANNOT get there on your feet. The interesting number is
 * therefore not "layouts per minute" on its own but the split between
 *
 *   NEEDED    the shortfall at the moment of the disc's arrival exceeds what a
 *             standing player can reach (Game.ts CATCH_REACH = 0.82 m), so the
 *             only way to touch it is extended;
 *   FREE      the shortfall is inside that standing reach — he could have run
 *             it down and caught/blocked it upright, and dived anyway.
 *
 * Everything here is derived from the loco state machine (a body enters
 * `layout` exactly once per bid) and from an independent re-derivation of the
 * AI's own `gap`, taken from the frame BEFORE the dive so the dive itself has
 * not yet perturbed pos/vel/stamina.
 *
 *   node tools/_layoutprobe.ts [seconds] [seeds]
 */
import * as THREE from 'three';
import { EventBus, QUALITY_PRESETS, Rng, type Ctx } from '../src/core/Ctx.ts';
import { GameSystem } from '../src/sim/Game.ts';
import { effectiveMaxSpeed, layoutExtend } from '../src/sim/AI.ts';

const DT = 1 / 120;
/** Quoted from Game.ts: horizontal reach for a standing catch / a full layout. */
const CATCH_REACH = 0.82;
const LAYOUT_REACH = 1.55;
/** Kept in step with AI.ts's `CATCH_FLOOR` / `CATCH_CEILING` / `CATCH_DEAD`. */
const CATCH_FLOOR = 0.85;
const CATCH_CEILING = 1.45;
const CATCH_DEAD = 0.25;

const SECONDS = Number(process.argv[2] ?? 600);
const SEEDS = Number(process.argv[3] ?? 3);
const NO_PEER = process.argv.includes('--nopeer');

interface Bid {
  side: 'offence' | 'defence';
  /** the AI's coarse currency: (timeToReach - arrival) * topSpeed */
  gap: number;
  /** metres he will actually be from the disc when it arrives */
  short: number;
  /** how far a full extension reaches for THIS body */
  dive: number;
  landY: number;
  /** metres from the landing point to the attacking goal line */
  toGoal: number;
  /** did the diver actually touch the disc? set later */
  paid: boolean;
  id: number;
  at: number;
}

interface Run {
  seed: number;
  seconds: number;
  bids: Bid[];
  throws: number;
  completions: number;
  turnovers: number;
  goals: number;
  possessions: number;
  why: Map<string, number>;
  /** shortfall of the intended receiver at the moment the disc became catchable */
  arrive: number[];
}

function runOne(seed: number): Run {
  const ctx: Ctx = {
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

  const game = new GameSystem();
  ctx.sys['game'] = game;
  // The shipped app registers a `disc` system whose predictPath the AI reads;
  // without it the AI falls back to its own glide integrator. Probe the same
  // configuration the player sees unless asked otherwise.
  if (!NO_PEER) {
    ctx.sys['disc'] = {
      predictPath: (s: unknown, h: number, st: number) =>
        game.discRuntime.predictPath(s as never, h, st),
    };
  }
  game.init(ctx);

  const run: Run = {
    seed, seconds: SECONDS, bids: [],
    throws: 0, completions: 0, turnovers: 0, goals: 0, possessions: 0,
    why: new Map(), arrive: [],
  };
  ctx.events.on('disc:grounded', (p: any) => {
    const k = String(p?.reason ?? '?');
    run.why.set(k, (run.why.get(k) ?? 0) + 1);
  });
  ctx.events.on('disc:released', () => { run.throws++; });
  ctx.events.on('disc:caught', (p: any) => {
    if (p?.outcome === 'completion' || p?.outcome === 'goal') run.completions++;
    if (p?.outcome === 'goal') run.goals++;
    if (p?.outcome === 'interception' || p?.outcome === 'pull') run.possessions++;
  });
  ctx.events.on('turnover', () => { run.turnovers++; run.possessions++; });
  // A bid "pays" if that same body touches the disc inside the next 1.2 s.
  const touched = (id: number): void => {
    for (let i = run.bids.length - 1; i >= 0; i--) {
      const b = run.bids[i];
      if (ctx.time - b.at > 1.2) break;
      if (b.id === id) { b.paid = true; return; }
    }
  };
  ctx.events.on('disc:caught', (p: any) => { if (typeof p?.playerId === 'number') touched(p.playerId); });
  ctx.events.on('disc:grounded', (p: any) => { if (typeof p?.playerId === 'number') touched(p.playerId); });

  const wasLayout = new Map<number, boolean>();
  // Closest any offensive body gets to the disc while it is catchable-height.
  // This is the number that says whether the offence NEEDS a dive to complete.
  let approach = 1e9;
  let inFlightLast = false;
  // Per-player geometry as of the frame just gone — what the AI itself saw.
  const gapNow = new Map<number, Omit<Bid, 'side' | 'paid' | 'id' | 'at'>>();

  for (let i = 0; i < Math.round(SECONDS / DT); i++) {
    /* ---- pre-step: what does the world look like to the AI this frame? ---- */
    gapNow.clear();
    const d = game.discRuntime.state;
    const inFlight = game.discRuntime.mode === 'flight';
    if (inFlight) {
      const land = predictCatchPoint(game, d);
      for (const e of game.roster) {
        const t = game.loco.timeToReach(
          { id: e.id, pos: e.loco.pos, vel: e.loco.vel } as never, land.x, land.z);
        const gap = (t - land.t) * effectiveMaxSpeed(e.ai);
        // The honest measure: how far from the disc he still is at the last
        // instant a standing catch is legal.
        const tL = game.loco.timeToReach(
          { id: e.id, pos: e.loco.pos, vel: e.loco.vel } as never, land.lastX, land.lastZ);
        const dL = Math.hypot(land.lastX - e.loco.pos.x, land.lastZ - e.loco.pos.z);
        const short = dL * Math.max(0, Math.min(1, 1 - land.lastT / Math.max(tL, 1e-3)));
        const dir = game.gs.attackDir[e.team];
        gapNow.set(e.id, {
          gap, short, dive: CATCH_REACH + layoutExtend(e.ai),
          landY: land.y, toGoal: Math.max(0, 32 - dir * land.z),
        });
      }
    }

    ctx.time += DT; ctx.dt = DT; ctx.frame++;
    game.update(DT, ctx);

    /* ---- how close did the offence get, disc still in the air? ------------ */
    const flying = game.discRuntime.mode === 'flight';
    if (flying) {
      const off = game.gs.phase === 'PULL_IN_FLIGHT'
        ? game.gs.receivingTeam : game.gs.possession;
      const s = game.discRuntime.state;
      if (s.pos.y > 0.25 && s.pos.y < 2.1) {
        for (const e of game.roster) {
          if (e.team !== off) continue;
          approach = Math.min(approach, Math.hypot(s.pos.x - e.loco.pos.x, s.pos.z - e.loco.pos.z));
        }
      }
    } else if (inFlightLast) {
      if (approach < 1e8) run.arrive.push(approach);
      approach = 1e9;
    }
    inFlightLast = flying;

    /* ---- post-step: who just left the ground? ----------------------------- */
    const offence = game.gs.phase === 'PULL_IN_FLIGHT'
      ? game.gs.receivingTeam : game.gs.possession;
    for (const e of game.roster) {
      const now = e.loco.state === 'layout';
      const before = wasLayout.get(e.id) ?? false;
      wasLayout.set(e.id, now);
      if (!now || before) continue;
      const g = gapNow.get(e.id);
      if (!g) continue;               // a dive with no disc in flight is not a bid
      run.bids.push({
        side: e.team === offence ? 'offence' : 'defence',
        ...g, paid: false, id: e.id, at: ctx.time,
      });
    }
  }
  return run;
}

interface Land { x: number; y: number; z: number; t: number; lastX: number; lastZ: number; lastT: number }

/** The AI's `predictCatchPoint`, re-derived so the probe never asks it. */
function predictCatchPoint(
  game: GameSystem, s: { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } },
): Land {
  const path = NO_PEER ? [] : game.discRuntime.predictPath(s as never, 6, 1 / 30);
  let met: { x: number; y: number; z: number; t: number } | null = null;
  let dead = path[path.length - 1];
  for (let i = 1; i < path.length; i++) {
    const p = path[i];
    if (!met && ((p.y <= CATCH_CEILING && path[i - 1].y > CATCH_CEILING) || p.y <= CATCH_FLOOR)) met = p;
    if (p.y <= CATCH_DEAD) { dead = path[i - 1]; break; }
  }
  const m = met ?? dead;
  if (m && dead) {
    return { x: m.x, y: m.y, z: m.z, t: m.t, lastX: dead.x, lastZ: dead.z, lastT: Math.max(dead.t, m.t) };
  }
  let x = s.pos.x, y = s.pos.y, z = s.pos.z;
  let vx = s.vel.x, vy = s.vel.y, vz = s.vel.z;
  const h = 1 / 60;
  let fm: { x: number; y: number; z: number; t: number } | null = null;
  for (let t = 0; t < 6; t += h) {
    vy -= 3.1 * h;
    const drag = 1 - 0.11 * h;
    vx *= drag; vz *= drag;
    x += vx * h; y += vy * h; z += vz * h;
    if (!fm && y <= CATCH_CEILING && vy < 0) fm = { x, y: Math.max(y, CATCH_FLOOR), z, t: t + h };
    if (y <= CATCH_DEAD) {
      const q = fm ?? { x, y: Math.max(y, CATCH_FLOOR), z, t: t + h };
      return { ...q, lastX: x, lastZ: z, lastT: Math.max(t + h, q.t) };
    }
  }
  const q = fm ?? { x, y: Math.max(y, CATCH_FLOOR), z, t: 6 };
  return { ...q, lastX: x, lastZ: z, lastT: Math.max(6, q.t) };
}

/* ------------------------------------------------------------------ report */

const runs: Run[] = [];
for (let k = 0; k < SEEDS; k++) runs.push(runOne(20260729 + k * 1013));

const all = runs.flatMap((r) => r.bids);
const mins = runs.reduce((a, r) => a + r.seconds, 0) / 60;
const throws = runs.reduce((a, r) => a + r.throws, 0);
const comps = runs.reduce((a, r) => a + r.completions, 0);
const poss = runs.reduce((a, r) => a + r.possessions, 0);
const goals = runs.reduce((a, r) => a + r.goals, 0);

const f2 = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : 'n/a');
const line = (tag: string, b: Bid[]): void => {
  const free = b.filter((x) => x.short <= CATCH_REACH).length;
  const hard = b.filter((x) => x.short > x.dive).length;
  const s = b.map((x) => x.short).sort((p, q) => p - q);
  console.log(
    `  ${tag.padEnd(9)} n=${String(b.length).padStart(5)}`
    + `  /min=${f2(b.length / mins).padStart(6)}`
    + `  /poss=${f2(b.length / Math.max(1, poss)).padStart(5)}`
    + `  /completion=${f2(b.length / Math.max(1, comps)).padStart(5)}`
    + `  reachable-standing=${((100 * free) / Math.max(1, b.length)).toFixed(1).padStart(5)}%`
    + `  beyond-own-extension=${((100 * hard) / Math.max(1, b.length)).toFixed(1).padStart(5)}%`
    + `  short p50=${f2(s[s.length >> 1] ?? NaN)} p90=${f2(s[Math.floor(s.length * 0.9)] ?? NaN)}`
    + `  paid=${((100 * b.filter((x) => x.paid).length) / Math.max(1, b.length)).toFixed(1)}%`
    + `  landY p50=${f2(b.map((x) => x.landY).sort((p, q) => p - q)[b.length >> 1] ?? NaN)}`
    + ` <0.2m=${((100 * b.filter((x) => x.landY < 0.2).length) / Math.max(1, b.length)).toFixed(0)}%`,
  );
};

console.log(`\n${SEEDS} seeds x ${SECONDS}s = ${f2(mins)} sim-minutes`
  + `   throws=${throws} completions=${comps} possessions=${poss} goals=${goals}`
  + `   ${NO_PEER ? '(AI glide fallback)' : '(disc peer)'}`);
console.log(`\nlayouts  (standing reach ${CATCH_REACH} m, extended ${LAYOUT_REACH} m)`);
line('all', all);
line('defence', all.filter((b) => b.side === 'defence'));
line('offence', all.filter((b) => b.side === 'offence'));

const hist = new Map<string, number>();
for (const b of all) {
  const k = b.short < 0 ? '<0' : b.short >= 3 ? '3+' : `${Math.floor(b.short * 2) / 2}`;
  hist.set(k, (hist.get(k) ?? 0) + 1);
}
const keys = [...hist.keys()].sort((a, b) =>
  (a === '<0' ? -1 : a === '3+' ? 9 : Number(a)) - (b === '<0' ? -1 : b === '3+' ? 9 : Number(b)));
console.log('\nshortfall at the bid (m from the disc when it arrives), 0.5 m bins:');
for (const k of keys) console.log(`  ${k.padStart(4)}  ${'#'.repeat(Math.min(70, hist.get(k)!))} ${hist.get(k)}`);

const red = all.filter((b) => b.toGoal <= 20).length;
const why = new Map<string, number>();
for (const r of runs) for (const [k, v] of r.why) why.set(k, (why.get(k) ?? 0) + v);
const arrive = runs.flatMap((r) => r.arrive).sort((a, b) => a - b);
const q = (f: number): string => f2(arrive[Math.min(arrive.length - 1, Math.floor(arrive.length * f))] ?? NaN);
console.log(`\nclosest offensive body to the disc per flight (m): n=${arrive.length}`
  + ` p10=${q(0.1)} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)}`
  + `   inside standing reach: ${((100 * arrive.filter((a) => a <= CATCH_REACH).length) / Math.max(1, arrive.length)).toFixed(1)}%`
  + `   inside full extension: ${((100 * arrive.filter((a) => a <= LAYOUT_REACH).length) / Math.max(1, arrive.length)).toFixed(1)}%`);
console.log('\ndisc:grounded reasons:', JSON.stringify(Object.fromEntries(
  [...why.entries()].sort((a, b) => b[1] - a[1]))));
console.log(`\nstakes: ${((100 * red) / Math.max(1, all.length)).toFixed(1)}% of bids are within 20 m of the goal line`);
console.log('per seed:', runs.map((r) => `${r.seed}:${r.bids.length}`).join(' '));
console.log('\nreference: an elite game is ~30 points and 250+ throws with a'
  + ' HANDFUL of layouts —\norder 0.02 layouts per completion, not 0.5.');
