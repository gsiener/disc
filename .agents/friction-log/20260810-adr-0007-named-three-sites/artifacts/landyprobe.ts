/**
 * Distribution of `land.y` at the two in-flight decision sites.
 *
 * Copy to `tools/_landyprobe.ts` (gitignored by pattern) and run:
 *
 *   node --experimental-strip-types tools/_landyprobe.ts
 *
 * It needs two temporary probe lines in `src/sim/AI.ts`, immediately above each of the
 * two `mode = 'jump'` guards — `defenceInFlight` (~:3228) and `offenceInFlight` (~:2717):
 *
 *   (globalThis as any).__PROBE?.('def', land.y, gap, m.bidCommit && p.id === onPlay);
 *   (globalThis as any).__PROBE?.('off', land.y, gap, isTarget);
 *
 * Revert them with `git checkout -- src/sim/AI.ts` when you are done.
 */
import * as THREE from 'three';
import { EventBus, QUALITY_PRESETS, Rng, type Ctx } from '../src/core/Ctx.ts';
import { GameSystem } from '../src/sim/Game.ts';

const SEEDS = [11, 23, 37];
const SECONDS = 900;
const DT = 1 / 120;

type Row = { n: number; max: number; over110: number; over145: number; over185: number; over190: number };
const acc: Record<string, Row> = {
  def: { n: 0, max: -1e9, over110: 0, over145: 0, over185: 0, over190: 0 },
  off: { n: 0, max: -1e9, over110: 0, over145: 0, over185: 0, over190: 0 },
  'def-gate': { n: 0, max: -1e9, over110: 0, over145: 0, over185: 0, over190: 0 },
  'off-gate': { n: 0, max: -1e9, over110: 0, over145: 0, over185: 0, over190: 0 },
};

function bump(k: string, y: number): void {
  const r = acc[k]!;
  r.n += 1;
  if (y > r.max) r.max = y;
  if (y > 1.1) r.over110 += 1;
  if (y > 1.45) r.over145 += 1;
  if (y > 1.85) r.over185 += 1;
  if (y > 1.9) r.over190 += 1;
}

// gate = the branch actually eligible (defence: bidCommit&&onPlay; offence: isTarget)
(globalThis as any).__PROBE = (who: string, y: number, _gap: number, gate: boolean) => {
  bump(who, y);
  if (gate) bump(`${who}-gate`, y);
};

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
  console.log(`seed ${seed} done`);
}

for (const [k, r] of Object.entries(acc)) {
  console.log(
    `${k.padEnd(9)} n=${r.n} max=${r.max.toFixed(4)} >1.10=${r.over110} >1.45=${r.over145} >1.85=${r.over185} >1.90=${r.over190}`,
  );
}
