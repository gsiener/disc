/** Why is the disc lying on the ground? Prints every dead spell over 3 s. */
import * as THREE from 'three';
import { EventBus, QUALITY_PRESETS, Rng, type Ctx } from '../src/core/Ctx.ts';
import { GameSystem } from '../src/sim/Game.ts';

const DT = 1 / 120;
const ctx: Ctx = {
  renderer: null as unknown as THREE.WebGLRenderer,
  scene: null as unknown as THREE.Scene,
  camera: null as unknown as THREE.PerspectiveCamera,
  composer: null,
  time: 0, dt: 0, rawDt: 0, timeScale: 1, frame: 0,
  width: 1920, height: 1080, dpr: 1,
  quality: { ...QUALITY_PRESETS.high },
  events: new EventBus(),
  rand: new Rng(20260729),
  sys: Object.create(null),
  debug: false, capture: false,
};
const game = new GameSystem();
ctx.sys['game'] = game;
game.init(ctx);

let phase = '';
let since = 0;
let reported = 0;
const f2 = (n: number): string => n.toFixed(2);

for (let i = 0; i < Math.round(600 / DT); i++) {
  ctx.time += DT; ctx.dt = DT; ctx.frame++;
  game.update(DT, ctx);
  const p = String(game.gs.phase);
  if (p !== phase) { phase = p; since = 0; reported = 0; }
  since += DT;
  if (since > 3 && reported < 6 && p !== 'LIVE_POSSESSION' && (reported === 0 || i % 1200 === 0)) {
    reported++;
    const d = game.discRuntime.state;
    let near = -1; let nd = 1e9;
    for (const e of game.roster) {
      const dd = Math.hypot(d.pos.x - e.loco.pos.x, d.pos.z - e.loco.pos.z);
      if (dd < nd) { nd = dd; near = e.id; }
    }
    const e = game.entry(near);
    console.log(
      `t=${f2(ctx.time)} phase=${p} for ${f2(since)}s  discMode=${game.discRuntime.mode}`
      + ` disc=(${f2(d.pos.x)},${f2(d.pos.y)},${f2(d.pos.z)})`
      + `  nearest #${near}(t${e?.team}) @(${f2(e?.loco.pos.x ?? 0)},${f2(e?.loco.pos.z ?? 0)}) ${f2(nd)}m state=${e?.loco.state}`
      + ` v=${f2(Math.hypot(e?.loco.vel.x ?? 0, e?.loco.vel.z ?? 0))}`
      + `  poss=${game.gs.possession} timer=${f2(game.gs.phaseTimer)}`);
  }
}
console.log('score', game.gs.score, 'phase', game.gs.phase);
