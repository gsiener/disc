/**
 * DEV HARNESS for the broadcast package — not in the system list, never imported
 * by the game.
 *
 *   /src/ui/preview.html            the live composition
 *   /src/ui/preview.html?mode=sheet a contact sheet of scorebug states
 *
 * The HUD is the one system that can be judged without a GPU: it is DOM, CSS and
 * SVG, it reads a plain struct, and every animation is a pure function of a
 * number it is handed. So it does not need the engine to be reviewable — which
 * matters, because the engine is a peer's file and the capture rig goes down
 * whenever any one of a dozen systems is mid-edit.
 *
 * What this cannot show is the world-anchored gizmos in a real perspective, and
 * the panels composited over an actual frame. Those still need `tools/capture`.
 * What it *can* show, and what the capture rig cannot, is every state at once —
 * a stall on 9 and a stall on 0 in the same screenshot — plus DPR 2, which the
 * capture rig pins to 1.
 */

import * as THREE from 'three';

import { EventBus, QUALITY_PRESETS, Rng, type Ctx } from '../core/Ctx.ts';
import { Badges } from './Badges.ts';
import { GameplayLayer } from './Gameplay.ts';
import { LowerThird } from './LowerThird.ts';
import { Scorebug } from './Scorebug.ts';
import { SummaryPanel } from './Summary.ts';
import { mountStyle } from './Theme.ts';
import { emptyFrame, type HudFrame, type HudPlayer, type HudSource, type TeamBrand } from './Model.ts';

/* ------------------------------------------------------------------ brands */

const BRANDS: [TeamBrand, TeamBrand] = [
  { code: 'RVR', name: 'Riverside Current', colour: 'rgb(63,122,201)', raw: '#1d4e94', ink: '#ffffff', accent: '#e8b23c' },
  { code: 'CUT', name: 'Cutbank Union', colour: 'rgb(242,242,238)', raw: '#f2f2ee', ink: '#14181f', accent: '#b3372e' },
];

/* -------------------------------------------------------------------- ctx */

function fakeCtx(w: number, h: number): Ctx {
  const camera = new THREE.PerspectiveCamera(34, w / h, 0.1, 500);
  camera.position.set(-34, 15.5, 30);
  camera.lookAt(0, 1.6, 4);
  camera.updateMatrixWorld(true);
  return {
    renderer: null as unknown as THREE.WebGLRenderer,
    scene: new THREE.Scene(),
    camera,
    composer: null,
    time: 0, dt: 1 / 60, rawDt: 1 / 60, timeScale: 1, frame: 0,
    width: w, height: h, dpr: window.devicePixelRatio,
    quality: QUALITY_PRESETS.high,
    events: new EventBus(),
    rand: new Rng(1),
    sys: {},
    debug: false,
    capture: true,
  };
}

/** A single athlete standing near the middle of the pitch, so the ring projects. */
function fakeSource(): HudSource {
  const rec: HudPlayer = {
    id: 3, team: 0, number: 7, name: 'Okafor', position: 'Handler',
    x: 2, y: 0, z: 2, groundY: 0, stamina: 0.62,
  };
  return {
    player: (id) => (id === rec.id ? rec : null),
    disc: () => ({ x: 2, y: 1.2, z: 2 }),
    flight: () => null,
  };
}

/* ------------------------------------------------------------------ frames */

function baseFrame(w: number, h: number): HudFrame {
  const f = emptyFrame();
  f.w = w; f.h = h; f.live = true;
  // Widgets advance their springs off `f.dt`; leaving it at 0 freezes every
  // Motion at its initial value and nothing that eases ever arrives.
  f.dt = 1 / 60;
  f.score = [9, 8];
  f.point = 18;
  f.target = 15;
  f.possession = 0;
  f.timeouts = [2, 1];
  f.stall = 4;
  f.stallMax = 10;
  f.controlledId = 3;
  f.throwerId = 3;
  f.discMode = 'held';
  return f;
}

/** Root font-size exactly as `HudSystem.resize` computes it. */
function rootSize(w: number): number { return Math.max(13, Math.min(22, w / 108)); }

/* -------------------------------------------------------------- live mode */

function live(host: HTMLElement, w: number, h: number): void {
  const root = document.createElement('div');
  root.id = 'ug';
  root.style.fontSize = `${rootSize(w).toFixed(2)}px`;
  host.appendChild(root);

  const ctx = fakeCtx(w, h);
  const src = fakeSource();
  const f = baseFrame(w, h);

  const bug = new Scorebug(root, BRANDS);
  const play = new GameplayLayer(root, ctx, src, BRANDS);
  const card = new LowerThird(root);
  const summary = new SummaryPanel(root, BRANDS);
  const badges = new Badges(root);
  play.resize(w, h);

  // Settle every entrance so the still shows the resting composition rather than
  // a frame of animation.
  for (const wd of [bug, play, card, summary, badges]) wd.restage?.(f);
  f.t = 6;
  for (let i = 0; i < 90; i++) { f.t += 1 / 60; for (const wd of [bug, play, card, summary, badges]) wd.update(f); }

  card.show({
    player: { id: 9, team: 1, number: 62, name: 'Brennan', position: 'Cutter', x: 0, y: 0, z: 0, groundY: 0, stamina: 1 },
    tag: 'Goal',
    sub: 'Cutter · from #14 OKAFOR',
    stats: [{ key: 'G', value: '1' }, { key: 'A', value: '0' }, { key: 'D', value: '0' }],
  }, BRANDS, f);

  // Advance past the card's entrance so it is shown settled, not mid-wipe.
  for (let i = 0; i < 60; i++) { f.t += 1 / 60; for (const wd of [bug, play, card, summary, badges]) wd.update(f); }
}

/* ------------------------------------------------------------- sheet mode */

interface SheetRow { label: string; stall: number; score: [number, number]; to: [number, number]; poss: 0 | 1 | null; frozen?: boolean }

const ROWS: SheetRow[] = [
  { label: 'stall 0 · both timeouts · home poss', stall: 0, score: [0, 0], to: [2, 2], poss: 0 },
  { label: 'stall 4 · away one timeout', stall: 4, score: [9, 8], to: [2, 1], poss: 0 },
  { label: 'stall 6 · warn · away poss', stall: 6, score: [9, 9], to: [1, 1], poss: 1 },
  { label: 'stall 8 · hot', stall: 8, score: [12, 11], to: [1, 0], poss: 0 },
  { label: 'stall 9 · hot · no timeouts · double digits', stall: 9, score: [14, 13], to: [0, 0], poss: 1 },
  { label: 'stall 5 · frozen (no legal mark)', stall: 5, score: [14, 14], to: [0, 0], poss: 0, frozen: true },
];

function sheet(host: HTMLElement, w: number): void {
  for (const r of ROWS) {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-row';
    const cap = document.createElement('div');
    cap.className = 'sheet-cap';
    cap.textContent = r.label;
    wrap.appendChild(cap);

    const root = document.createElement('div');
    root.id = 'ug';
    root.style.position = 'relative';
    root.style.height = '6.2em';
    root.style.fontSize = `${rootSize(w).toFixed(2)}px`;
    wrap.appendChild(root);
    host.appendChild(wrap);

    const f = baseFrame(w, 1080);
    f.stall = r.stall;
    f.score = r.score;
    f.timeouts = r.to;
    f.possession = r.poss;
    f.stallFrozen = !!r.frozen;

    const bug = new Scorebug(root, BRANDS);
    bug.restage(f);
    f.t = 6;
    for (let i = 0; i < 120; i++) { f.t += 1 / 60; bug.update(f); }
  }
}

/* ------------------------------------------------------------------- boot */

function boot(): void {
  mountStyle();
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') ?? 'live';
  const host = document.getElementById('stage');
  if (!host) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (mode === 'sheet') { host.classList.add('sheet'); sheet(host, 1920); } else { live(host, w, h); }
  document.body.dataset.ready = '1';
}

boot();
