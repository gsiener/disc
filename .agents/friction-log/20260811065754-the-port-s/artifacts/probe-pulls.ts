/**
 * Probe: characterise every PULL in the reference over the matchdiff pool.
 *
 * For each pull we record how it ended — untouched on the ground, caught by the
 * receiving team, muffed by the receiving team (`pull-drop`), touched by the
 * pulling team (WFDF 12.5), or out of bounds — plus the catch difficulty and the
 * roll for the two outcomes that go through `tryCatch`.
 */
import * as THREE from 'three';

import { EventBus, QUALITY_PRESETS, Rng, type Ctx } from '../src/core/Ctx.ts';
import { GameSystem } from '../src/sim/Game.ts';

const SEEDS = [11, 23, 37, 2, 5, 7, 13, 19, 29, 41, 53];
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

const tally = {
  pulls: 0, caught: 0, dropped: 0, landed: 0, oob: 0, touchedByPuller: 0,
};
const dropRows: string[] = [];
const catchRows: string[] = [];

for (const seed of SEEDS) {
  const ctx = makeCtx(seed);
  const game = new GameSystem();
  ctx.sys['game'] = game;
  game.init(ctx);
  const gs = game.gs as unknown as Record<string, (...a: unknown[]) => unknown>;

  const wrap = (name: string, hit: (args: unknown[]) => void) => {
    const orig = gs[name].bind(gs);
    gs[name] = (...args: unknown[]) => { hit(args); return orig(...args); };
  };

  wrap('pullDropped', (a) => {
    tally.dropped++;
    const at = a[1] as { x: number; y: number; z: number };
    dropRows.push(`${seed} drop y=${at.y.toFixed(2)} z=${at.z.toFixed(1)}`);
  });
  wrap('pullCaught', (a) => {
    const id = a[0] as number;
    const roster = (game as unknown as { roster: { id: number; team: number }[] }).roster;
    const p = roster.find((e) => e.id === id);
    const recv = (game.gs as unknown as { receivingTeam: number }).receivingTeam;
    if (p && p.team !== recv) tally.touchedByPuller++;
    else tally.caught++;
    const at = a[1] as { x: number; y: number; z: number };
    catchRows.push(`${seed} catch y=${at.y.toFixed(2)} z=${at.z.toFixed(1)}`);
  });
  wrap('pullLanded', () => { tally.landed++; });
  wrap('pullOutOfBounds', () => { tally.oob++; });

  for (let i = 0; i < Math.round(SECONDS / DT); i++) {
    if (game.gs.phase === 'GAME_OVER') break;
    ctx.time += DT;
    game.update(DT, ctx);
  }
  console.error(`seed ${seed} done, points=${game.gs.point}`);
}

tally.pulls = tally.caught + tally.dropped + tally.landed + tally.oob + tally.touchedByPuller;
console.log(JSON.stringify({ tally, dropRows, catchSample: catchRows.slice(0, 40) }, null, 2));
