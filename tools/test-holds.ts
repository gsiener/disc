/**
 * tools/test-holds.ts — issue #10: is the offence's hold rate the sport's own.
 *
 *   node --experimental-strip-types tools/test-holds.ts
 *
 * `holds` and `breaks` (`GameState.scoreGoal`, `Game.ts:928`) are the sport's own
 * split: a point is a hold if the team that received that point's pull is the one
 * who scores it, a break otherwise. Real ultimate holds 65-75% of points, and this
 * issue's own history is why no such check existed until now: three prior
 * measurements at growing sample sizes — 64% (one match), 46.9% (5 seeds), 60%
 * (15 seeds) — none of them agreed, and two agents in a row declined to tune a
 * probability constant toward a number that moved 17 points between two sample
 * sizes rather than settle the measurement question first.
 *
 * This is that larger, principled sample. 45 fifteen-minute 7v7 matches pool to
 * several hundred points — at a true rate near 60%, the standard error on a pool
 * this size is under 2.5 points, which is more than enough separation to tell
 * "below band" from "in band" rather than from noise. It costs real wall-clock
 * time (~10 minutes on the machine this was written on) and is deliberately not
 * wired into `npm test`: like `tools/test-game.ts`'s single-match band checks,
 * this is a gameplay-authenticity diagnostic, run on demand, not a behaviour gate
 * (the Swift differential in `SimChecks` is that gate; this has no Swift side to
 * agree with, because it is checking the reference against the SPORT, not
 * against the port).
 */

import * as THREE from 'three';

import { EventBus, QUALITY_PRESETS, Rng, type Ctx } from '../src/core/Ctx.ts';
import { GameSystem } from '../src/sim/Game.ts';
import type { TeamId } from '../src/sim/Rules.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string, detail = ''): void {
  if (cond) { pass++; return; }
  fail++;
  failures.push(label + (detail ? `  (${detail})` : ''));
}

/**
 * Forty-five seeds, none shared with `matchdiff.ts`'s eleven — that pool exists
 * to compare TS against Swift and is fixed for that reason; this one exists to
 * compare the reference against real ultimate's own numbers and wants its own,
 * larger draw.
 */
const SEEDS = [
  11, 23, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107,
  109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193,
  197, 199, 211, 223, 227, 229, 233, 239, 241, 251,
];
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

let holds = 0, breaks = 0, attempts = 0, completions = 0, points = 0;
const perSeed: { seed: number; holds: number; breaks: number }[] = [];

const wallStart = Date.now();
for (const seed of SEEDS) {
  const ctx = makeCtx(seed);
  const game = new GameSystem();
  ctx.sys['game'] = game;
  game.init(ctx);
  for (let i = 0; i < Math.round(SECONDS / DT); i++) {
    if (game.gs.phase === 'GAME_OVER') break;
    ctx.time += DT;
    game.update(DT, ctx);
  }
  let seedHolds = 0, seedBreaks = 0;
  for (let t = 0 as TeamId; t <= 1; t = (t + 1) as TeamId) {
    const ts = game.gs.teamStats(t);
    seedHolds += ts.holds;
    seedBreaks += ts.breaks;
    attempts += ts.attempts;
    completions += ts.completions;
  }
  holds += seedHolds;
  breaks += seedBreaks;
  points += game.gs.point;
  perSeed.push({ seed, holds: seedHolds, breaks: seedBreaks });
}
const wallMs = Date.now() - wallStart;

const total = holds + breaks;
const rate = total > 0 ? holds / total : 0;
const compRate = attempts > 0 ? completions / attempts : 0;

ok(total >= 200, 'enough points pooled across the sweep to say something about the rate',
  `${total} points over ${SEEDS.length} seeds`);
ok(compRate >= 0.85 && compRate <= 0.92, 'and completion stayed in its own band while pooling',
  `${(compRate * 100).toFixed(1)}%`);

const perSeedRates = perSeed
  .filter((s) => s.holds + s.breaks > 0)
  .map((s) => s.holds / (s.holds + s.breaks));
const spread = perSeedRates.length
  ? `${(Math.min(...perSeedRates) * 100).toFixed(0)}-${(Math.max(...perSeedRates) * 100).toFixed(0)}%`
  : 'n/a';

ok(rate >= 0.65 && rate <= 0.75,
  'holds land in real ultimate\'s 65-75% band (issue #10)',
  `${(rate * 100).toFixed(1)}% (${holds}/${total}) over ${SEEDS.length} seeds, per-seed spread ${spread}`);

console.log(`\n${SEEDS.length} matches, ${wallMs}ms: holds ${holds}/${total} = `
  + `${(rate * 100).toFixed(1)}%, completion ${(compRate * 100).toFixed(1)}%, `
  + `per-seed spread ${spread}`);

console.log(`\n${'='.repeat(64)}`);
if (fail === 0) {
  console.log(`PASS  ${pass} assertions, 0 failures`);
} else {
  console.log(`FAIL  ${pass} passed, ${fail} failed`);
  for (const f of failures) console.log(`  · ${f}`);
}
console.log('='.repeat(64));
process.exit(fail === 0 ? 0 : 1);
