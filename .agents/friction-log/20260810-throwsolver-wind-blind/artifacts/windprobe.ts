/**
 * Guardrail telemetry for issue #20: timeouts and zone reachability.
 *
 * Runs the reference engine headless and reports every number the task's
 * before/after table asks for, plus the two new ones.
 *
 *   node --experimental-strip-types tools/_windprobe.ts [seeds...]
 */
import * as THREE from 'three';

import { EventBus, QUALITY_PRESETS, Rng, type Ctx } from '../src/core/Ctx.ts';
import { GameSystem } from '../src/sim/Game.ts';

const SEEDS = process.argv.slice(2).length
  ? process.argv.slice(2).map(Number)
  : [11, 23, 37, 2, 5, 7, 13, 19, 29, 41, 53];
const SECONDS = 900;
const DT = 1 / 120;

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
  } as unknown as Ctx;
}

interface Agg {
  matches: number; points: number; holds: number; breaks: number;
  attempts: number; completions: number; drops: number; throwaways: number;
  stallOuts: number; blocks: number; goals: number;
  calls: number; timeouts: number;
  hucks: number; longest: number;
  zonePoints: number; schemePoints: number;
  windSpeeds: number[];
}
const A: Agg = {
  matches: 0, points: 0, holds: 0, breaks: 0,
  attempts: 0, completions: 0, drops: 0, throwaways: 0,
  stallOuts: 0, blocks: 0, goals: 0,
  calls: 0, timeouts: 0, hucks: 0, longest: 0,
  zonePoints: 0, schemePoints: 0, windSpeeds: [],
};

// Per-seed rows so a pooled number can be checked against its spread.
const rows: string[] = [];
const stallReach: Record<number, number> = {};

interface Bucket {
  name: string; points: number; attempts: number; completions: number;
  drops: number; throwaways: number; blocks: number;
  turnovers: number; toOwnThird: number; toMiddle: number; toAttackThird: number;
}
const mkBucket = (name: string): Bucket => ({
  name, points: 0, attempts: 0, completions: 0, drops: 0, throwaways: 0,
  blocks: 0, turnovers: 0, toOwnThird: 0, toMiddle: 0, toAttackThird: 0,
});
const ZONE = mkBucket('zone');
const PERSON = mkBucket('person');

for (const seed of SEEDS) {
  const ctx = makeCtx(seed);
  const game = new GameSystem();
  ctx.sys['game'] = game;
  game.init(ctx);

  const g = game as unknown as {
    wind: THREE.Vector3;
    ai: Array<{ currentScheme: 'person' | 'zone' }>;
    gs: { point: number; phase: string; teamStats(t: 0 | 1): Record<string, number> };
    callTally: Record<string, number>;
  };

  // WIND=<m/s> pins the day, so completion can be swept against wind speed
  // without reshuffling anything else. The vector is shared by reference with the
  // disc runtime and re-read by the AI every tick, so mutating it in place is
  // enough. Bearing comes from the drawn day so a pinned sweep still varies.
  if (process.env['WIND']) {
    const want = Number(process.env['WIND']);
    const have = Math.hypot(g.wind.x, g.wind.z) || 1;
    g.wind.set((g.wind.x / have) * want, 0, (g.wind.z / have) * want);
  }

  let released: { x: number; z: number } | null = null;
  let hucks = 0, longest = 0, timeouts = 0;
  ctx.events.on('disc:released', (p: { pos: { x: number; z: number } }) => {
    // A pull is a throw but not a huck; it is released from a dead phase.
    released = g.gs.phase === 'LIVE_POSSESSION' || g.gs.phase === 'DISC_IN_FLIGHT'
      ? { x: p.pos.x, z: p.pos.z } : null;
  });
  const land = (p: { pos: { x: number; z: number } }, caught: boolean) => {
    if (!released) return;
    const d = Math.hypot(p.pos.x - released.x, p.pos.z - released.z);
    if (d >= 30) hucks++;
    if (caught && d > longest) longest = d;
    released = null;
  };
  ctx.events.on('disc:caught', (p: { pos: { x: number; z: number } }) => land(p, true));
  ctx.events.on('disc:grounded', (p: { pos: { x: number; z: number } }) => land(p, false));
  ctx.events.on('timeout', () => { timeouts++; });
  // How high the count actually gets, so a stall trigger can be aimed.
  let peak = 0;
  ctx.events.on('stall:tick', (p: { count: number }) => {
    if (p.count > peak) peak = p.count;
    if (p.count >= 1 && p.count <= 10) stallReach[p.count] = (stallReach[p.count] ?? 0) + 1;
  });

  // Sample the scheme once per point, at the moment the point goes live, and
  // bucket the point's own numbers under it.
  let lastPoint = -1;
  let zonePoints = 0, schemePoints = 0;
  let bucket: Bucket | null = null;
  let mark = { attempts: 0, completions: 0, drops: 0, throwaways: 0, blocks: 0 };
  const snap = () => {
    const t0 = g.gs.teamStats(0), t1 = g.gs.teamStats(1);
    const s = (k: string) => (t0[k] as number) + (t1[k] as number);
    return {
      attempts: s('attempts'), completions: s('completions'), drops: s('drops'),
      throwaways: s('throwaways'), blocks: s('blocks'),
    };
  };
  const closePoint = () => {
    if (!bucket) return;
    const now = snap();
    bucket.points++;
    bucket.attempts += now.attempts - mark.attempts;
    bucket.completions += now.completions - mark.completions;
    bucket.drops += now.drops - mark.drops;
    bucket.throwaways += now.throwaways - mark.throwaways;
    bucket.blocks += now.blocks - mark.blocks;
  };
  ctx.events.on('turnover', (p: { from: number; pos: { z: number } }) => {
    if (!bucket) return;
    const dir = g.gs.attackDir[p.from as 0 | 1];
    const adv = dir * p.pos.z;         // -32 own goal line .. +32 theirs
    bucket.turnovers++;
    if (adv < -10.6) bucket.toOwnThird++;
    else if (adv > 10.6) bucket.toAttackThird++;
    else bucket.toMiddle++;
  });

  for (let i = 0; i < Math.round(SECONDS / DT); i++) {
    if (g.gs.phase === 'GAME_OVER') break;
    ctx.time += DT;
    game.update(DT, ctx);
    if (g.gs.phase === 'LIVE_POSSESSION' && g.gs.point !== lastPoint) {
      closePoint();
      lastPoint = g.gs.point;
      schemePoints++;
      const zone = g.ai.some((a) => a.currentScheme === 'zone');
      if (zone) zonePoints++;
      bucket = zone ? ZONE : PERSON;
      mark = snap();
    }
  }
  closePoint();

  const t0 = g.gs.teamStats(0), t1 = g.gs.teamStats(1);
  const add = (k: string) => (t0[k] as number) + (t1[k] as number);
  A.matches++;
  A.points += g.gs.point;
  A.holds += add('holds'); A.breaks += add('breaks');
  A.attempts += add('attempts'); A.completions += add('completions');
  A.drops += add('drops'); A.throwaways += add('throwaways');
  A.stallOuts += add('stallOuts'); A.blocks += add('blocks'); A.goals += add('goals');
  A.calls += (g.callTally['foul'] ?? 0) + (g.callTally['pick'] ?? 0)
    + (g.callTally['strip'] ?? 0) + (g.callTally['travel'] ?? 0);
  A.timeouts += timeouts;
  A.hucks += hucks;
  if (longest > A.longest) A.longest = longest;
  A.zonePoints += zonePoints; A.schemePoints += schemePoints;
  const wind = Math.hypot(g.wind.x, g.wind.z);
  A.windSpeeds.push(wind);

  rows.push(
    `seed ${String(seed).padStart(3)}  wind ${wind.toFixed(2)}  pts ${String(g.gs.point).padStart(3)}`
    + `  holds ${add('holds')}/${add('holds') + add('breaks')}`
    + `  comp ${((add('completions') / Math.max(1, add('attempts'))) * 100).toFixed(1)}%`
    + `  drops ${add('drops')}  TO ${timeouts}  zone ${zonePoints}/${schemePoints}`
    + `  hucks ${hucks}  long ${longest.toFixed(1)}`);
  console.log(rows[rows.length - 1]);
}

const pct = (a: number, b: number) => ((a / Math.max(1, b)) * 100).toFixed(1) + '%';
console.log('---');
console.log(`matches            ${A.matches}`);
console.log(`points             ${A.points}  (${(A.points / A.matches).toFixed(1)}/match)`);
console.log(`holds              ${pct(A.holds, A.holds + A.breaks)}  (${A.holds}/${A.holds + A.breaks})`);
console.log(`completion         ${pct(A.completions, A.attempts)}  (${A.completions}/${A.attempts})`);
console.log(`drops              ${pct(A.drops, A.attempts)}  (${A.drops})`);
console.log(`throwaways         ${pct(A.throwaways, A.attempts)}`);
console.log(`stall-outs         ${A.stallOuts}`);
console.log(`calls per match    ${(A.calls / A.matches).toFixed(2)}`);
console.log(`timeouts per game  ${(A.timeouts / A.matches).toFixed(2)}`);
console.log(`zone points/game   ${(A.zonePoints / A.matches).toFixed(2)}  (${A.zonePoints}/${A.schemePoints} points)`);
console.log(`hucks >=30 m       ${(A.hucks / A.matches).toFixed(2)}/match  (${A.hucks})`);
console.log(`longest completion ${A.longest.toFixed(1)} m`);
for (const b of [PERSON, ZONE]) {
  if (!b.points) { console.log(`${b.name.padEnd(6)} points     none`); continue; }
  console.log(`${b.name.padEnd(6)} points     ${b.points}`
    + `  comp ${pct(b.completions, b.attempts)}`
    + `  throws/pt ${(b.attempts / b.points).toFixed(1)}`
    + `  drops ${pct(b.drops, b.attempts)}`
    + `  throwaways ${pct(b.throwaways, b.attempts)}`
    + `  blocks ${pct(b.blocks, b.attempts)}`
    + `  TO own/mid/att ${b.toOwnThird}/${b.toMiddle}/${b.toAttackThird}`);
}
console.log(`stall reach     ${[1,2,3,4,5,6,7,8,9,10].map((c) => `${c}:${stallReach[c] ?? 0}`).join(' ')}`);
console.log(`wind mean/max      ${(A.windSpeeds.reduce((a, b) => a + b, 0) / A.windSpeeds.length).toFixed(2)} / ${Math.max(...A.windSpeeds).toFixed(2)} m/s`);
