/**
 * tools/_frame.ts — what the camera actually sees, without a GPU.
 *
 * A tableau is a composition, and a composition is only judgeable in screen
 * space. This builds the exact camera `src/capture/Shots.ts` pins, applies each
 * tableau through a headless `GameSystem`, and projects every body — so a bad
 * arrangement (the subject buried at 12% frame height behind a foreground
 * distraction) is visible as a number long before a 20-second GPU capture.
 *
 *   node tools/_frame.ts                 every tableau shot
 *   node tools/_frame.ts broadcast mark  named shots only
 */
import * as THREE from 'three';
import { EventBus, QUALITY_PRESETS, Rng, type Ctx } from '../src/core/Ctx.ts';
import { GameSystem } from '../src/sim/Game.ts';
import { SHOTS, type ShotName } from '../src/capture/Shots.ts';

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const ctx: Ctx = {
  renderer: null as unknown as THREE.WebGLRenderer,
  scene: null as unknown as THREE.Scene,
  camera: new THREE.PerspectiveCamera(38, 16 / 9, 0.15, 900),
  composer: null,
  time: 0, dt: 0, rawDt: 0, timeScale: 1, frame: 0,
  width: 1920, height: 1080, dpr: 1,
  quality: { ...QUALITY_PRESETS.high },
  events: new EventBus(),
  rand: new Rng(20260729),
  sys: Object.create(null),
  debug: false, capture: true,
};
const game = new GameSystem();
ctx.sys['game'] = game;
game.init(ctx);

const cam = new THREE.PerspectiveCamera(38, 16 / 9, 0.15, 900);
const p = new THREE.Vector3();

const names = (argv.length ? argv : Object.keys(SHOTS)) as ShotName[];

for (const name of names) {
  const shot = SHOTS[name];
  if (!shot || !('tableau' in shot)) continue;
  ctx.events.emit('shot:apply', { name, shot });

  cam.position.fromArray(shot.pos as unknown as number[]);
  cam.lookAt(new THREE.Vector3().fromArray(shot.target as unknown as number[]));
  cam.fov = shot.fov;
  cam.aspect = 16 / 9;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);

  const rows: {
    tag: string; dist: number; sx: number; sy: number; h: number; onscreen: boolean;
  }[] = [];
  const push = (tag: string, x: number, y: number, z: number, worldH: number): void => {
    p.set(x, y, z);
    const dist = p.distanceTo(cam.position);
    p.project(cam);
    // Apparent height as a fraction of frame height.
    const h = worldH / (2 * dist * Math.tan((shot.fov * Math.PI) / 360));
    rows.push({
      tag, dist: +dist.toFixed(1),
      sx: +(((p.x + 1) / 2) * 100).toFixed(0),
      sy: +(((1 - p.y) / 2) * 100).toFixed(0),
      h: +(h * 100).toFixed(1),
      onscreen: p.z > 0 && p.z < 1 && Math.abs(p.x) < 1.15 && Math.abs(p.y) < 1.15,
    });
  };

  const gs = game.gs;
  const marker = game.markerId();
  for (const e of game.roster) {
    const lp = e.loco;
    const role = e.id === gs.thrower ? 'THROWER'
      : e.id === marker ? 'marker'
        : lp.state === 'layout' || lp.prone ? 'LAYOUT' : '';
    push(
      `${e.team === 0 ? 'H' : 'A'}${e.id % 7}${role ? ' ' + role : ''}`.padEnd(14),
      lp.pos.x, lp.groundY + lp.hipHeight * 1.05, lp.pos.z, lp.attr.height,
    );
  }
  const d = game.discRuntime.state.pos;
  push('DISC'.padEnd(14), d.x, d.y, d.z, 0.273);

  rows.sort((a, b) => a.dist - b.dist);
  console.log(`\n\x1b[1m${name}\x1b[0m  (${(shot as { tableau?: string }).tableau})  `
    + `fov ${shot.fov}  cam ${shot.pos.join(',')} -> ${shot.target.join(',')}`
    + ('focus' in shot ? `  focus ${(shot as { focus?: number }).focus}` : ''));
  console.log('  body            dist    x%    y%   frameH%  on');
  for (const r of rows) {
    const mark = r.onscreen ? '  *' : '   ';
    console.log(`  ${r.tag} ${String(r.dist).padStart(5)} ${String(r.sx).padStart(5)}`
      + ` ${String(r.sy).padStart(5)}  ${String(r.h).padStart(7)}${mark}`);
  }
  const on = rows.filter((r) => r.onscreen).length;
  console.log(`  -> ${on}/${rows.length} in frame`);
}
