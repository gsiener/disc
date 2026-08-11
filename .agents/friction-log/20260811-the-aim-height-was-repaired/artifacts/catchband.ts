/**
 * Issue #4 headline probe — aimed distance vs caught distance, and the height
 * band each consumer actually works in.
 *
 * Needs two temporary probe lines (BAND-PROBE):
 *
 *   src/sim/Game.ts   aiThrow(), after `const catchY = ...`:
 *     (globalThis as any).__BAND?.('aim', want, catchY, _from.y);
 *   src/sim/AI.ts     predictCatchPoint(), on each return path, with the y:
 *     (globalThis as any).__BAND?.('rv', <y>, 0, 0);
 *
 * Run: node --experimental-strip-types tools/_catchband.ts
 */
import * as THREE from 'three';
import { EventBus, QUALITY_PRESETS, Rng, type Ctx } from '../src/core/Ctx.ts';
import { GameSystem } from '../src/sim/Game.ts';

const SEEDS = [11, 23, 37, 2, 5, 7, 13, 19, 29, 41, 53];
const SECONDS = 900;
const DT = 1 / 120;

const aimed: number[] = [];
const caught: number[] = [];
const rvY: number[] = [];
const askedPlane: number[] = [];
const fromY: number[] = [];

let lastWant: number | null = null;
let releasePos: { x: number; z: number } | null = null;
let pendingWant: number | null = null;

(globalThis as any).__BAND = (k: string, a: number, b: number, c: number): void => {
  if (k === 'aim') { lastWant = a; askedPlane.push(b); fromY.push(c); }
  else if (k === 'rv') { rvY.push(a); }
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

const sorted = (a: number[]): number[] => [...a].sort((p, q) => p - q);
const median = (a: number[]): number => (a.length ? sorted(a)[a.length >> 1]! : NaN);
const pct = (a: number[], q: number): number =>
  a.length ? sorted(a)[Math.min(a.length - 1, Math.floor(a.length * q))]! : NaN;

let attempts = 0, completions = 0, throwaways = 0, grounded = 0;

for (const seed of SEEDS) {
  const ctx = makeCtx(seed);
  const game = new GameSystem();
  ctx.sys['game'] = game;
  ctx.events.on('turnover', (p: any) => {
    if (p?.reason === 'throwaway') throwaways += 1;
    if (p?.reason === 'out-of-bounds') grounded += 1;
  });
  ctx.events.on('disc:released', (p: any) => {
    releasePos = { x: p.pos.x, z: p.pos.z };
    pendingWant = lastWant;
    lastWant = null;
  });
  ctx.events.on('disc:caught', (p: any) => {
    if (releasePos && pendingWant != null) {
      caught.push(Math.hypot(p.pos.x - releasePos.x, p.pos.z - releasePos.z));
      aimed.push(pendingWant);
    }
    releasePos = null; pendingWant = null;
  });
  game.init(ctx);
  for (let i = 0; i < Math.round(SECONDS / DT); i++) {
    if (game.gs.phase === 'GAME_OVER') break;
    ctx.time += DT;
    game.update(DT, ctx);
  }
  for (let t = 0; t <= 1; t++) {
    const ts = (game.gs as any).teamStats(t);
    attempts += ts.attempts; completions += ts.completions;
  }
  console.error(`  seed ${seed} done — ${caught.length} completions so far`);
}

const dif = aimed.map((a, i) => a - caught[i]!);
console.log(`attempts/completions     ${attempts}/${completions} = ${(100 * completions / attempts).toFixed(1)}%  throwaways=${throwaways} oob=${grounded}`);
console.log(`completions              ${caught.length}`);
console.log(`aimed  median            ${median(aimed).toFixed(2)} m`);
console.log(`caught median            ${median(caught).toFixed(2)} m`);
console.log(`median(aimed-caught)     ${median(dif).toFixed(2)} m   p10=${pct(dif, 0.1).toFixed(2)} p90=${pct(dif, 0.9).toFixed(2)}`);
console.log(`short by >2 m            ${dif.filter((d) => d > 2).length} of ${dif.length}`);
console.log(
  `rendezvous y  n=${rvY.length} min=${rvY.length ? sorted(rvY)[0]!.toFixed(3) : '-'}`
  + ` p01=${pct(rvY, 0.01).toFixed(3)} median=${median(rvY).toFixed(3)}`
  + ` <0.20=${rvY.filter((y) => y < 0.2).length} <0.85=${rvY.filter((y) => y < 0.85).length}`,
);
console.log(
  `asked plane   n=${askedPlane.length} median=${median(askedPlane).toFixed(3)}`
  + `  release y median=${median(fromY).toFixed(3)}`
  + `  asked-above-release=${askedPlane.filter((v, i) => v > fromV(fromY, i)).length}`,
);
function fromV(a: number[], i: number): number { return a[i] ?? 0; }
