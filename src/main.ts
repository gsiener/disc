import { Engine } from './core/Engine';
import type { QualityTier } from './core/Ctx';
import { buildSystems } from './systems';
import { applyShot, SHOTS, type ShotName } from './capture/Shots';

const params = new URLSearchParams(location.search);
const tier = (params.get('q') as QualityTier) ?? 'ultra';
const capture = params.get('capture') === '1';
const debug = params.get('debug') === '1';
const seed = Number(params.get('seed') ?? 20260729);

const container = document.getElementById('app')!;
const engine = new Engine(container, { tier, capture, debug, seed });

const bootEl = document.getElementById('boot')!;
const barEl = document.getElementById('boot-bar') as HTMLElement;
const labelEl = document.getElementById('boot-label') as HTMLElement;

for (const s of buildSystems()) engine.add(s);

await engine.init((t, label) => {
  barEl.style.width = `${Math.round(t * 100)}%`;
  labelEl.textContent = label.replace(/([a-z])([A-Z])/g, '$1 $2');
});

if (capture) bootEl.remove();
else {
  bootEl.classList.add('hide');
  setTimeout(() => bootEl.remove(), 700);
}

// ---------------------------------------------------------------- capture rig
// The screenshot tool drives the sim through these hooks so every frame it
// grabs is byte-deterministic: no wall-clock, no rAF timing, no adaptive DPR.
const rig = {
  engine,
  ctx: engine.ctx,
  shots: Object.keys(SHOTS) as ShotName[],
  /** Advance the simulation by `frames` steps of exactly `dt` seconds. */
  advance(frames: number, dt = 1 / 60) {
    for (let i = 0; i < frames; i++) engine.step(dt);
  },
  /** Position the world + camera for a named shot, then settle it. */
  async shot(name: ShotName, settleFrames = 90) {
    applyShot(name, engine.ctx);
    this.advance(settleFrames);
  },
  render: () => engine.render(),
};

(window as any).__RIG__ = rig;
(window as any).__ENGINE__ = engine;

if (capture) {
  // Manual drive only — the tool calls advance()/render() itself.
  applyShot((params.get('shot') as ShotName) ?? 'broadcast', engine.ctx);
  rig.advance(Number(params.get('settle') ?? 120));
} else {
  engine.start();
}

(window as any).__READY__ = true;
