#!/usr/bin/env node
/** Why is the field stem silent? Count what actually reaches BodyLayer. */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = await new Promise((res, rej) => {
  const s = createServer(); s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const ORIGIN = `http://localhost:${port}`;
const up = async () => { try { return (await fetch(ORIGIN, { signal: AbortSignal.timeout(1200) })).ok; } catch { return false; } };
let child = null;
if (!(await up())) {
  child = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 60; i++) { await sleep(500); if (await up()) break; }
}
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--headless=new', '--use-angle=metal', '--enable-gpu', '--no-sandbox', '--disable-gpu-sandbox'],
  defaultViewport: { width: 1280, height: 720 }, protocolTimeout: 300_000,
});
const page = await browser.newPage();
await page.setRequestInterception(true);
page.on('request', (r) => { if (r.url().includes('/@vite/client')) r.abort().catch(() => {}); else r.continue().catch(() => {}); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${ORIGIN}/?capture=1&q=high&settle=8`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction('window.__READY__ === true', { timeout: 240_000 });

const out = await page.evaluate(async () => {
  const ctx = window.__ENGINE__.ctx;
  const sys = ctx.sys.audio;
  const SR = 48000;
  sys.graph = null; sys.crowd = null; sys.ambience = null; sys.flight = null; sys.body = null; sys.drama = null;
  sys.running = false; sys.available = false;
  const oac = new OfflineAudioContext(2, SR * 6, SR);
  sys.opts = { createContext: () => oac, volume: 0.85 };
  if (!sys.start()) return { error: 'refused' };
  let vt = 0;
  Object.defineProperty(sys.graph, 'now', { get: () => vt, configurable: true });
  sys.graph.setMaster(0.85, 0.001);
  sys.graph.crowd.gain.setValueAtTime(0, 0);
  sys.graph.amb.gain.setValueAtTime(0, 0);

  ctx.camera.position.set(0, 11, 46);
  ctx.camera.lookAt(0, 1.2, 0);
  ctx.camera.updateMatrixWorld(true);

  // HYPOTHESIS: Graph.reap() disconnects a finished voice's nodes synchronously.
  // In real time that is safe — `end <= currentTime` means the audio thread has
  // already rendered it. Against a VIRTUAL clock in an OfflineAudioContext
  // nothing is rendered until startRendering(), so reaping deletes every
  // transient from the graph before it ever makes a sample.
  if (!window.__NOREAP__) {
    const g = sys.graph;
    g.reap = function (now) {
      for (let i = this.voices.length - 1; i >= 0; i--) {
        if (this.voices[i].end <= now) this.voices.splice(i, 1);
      }
    };
  }

  const body = sys.body;
  const stats = { called: 0, culled: 0, unclaimed: 0, made: 0, dists: [], cull: sys.graph.budget.cull, listener: null };
  const realFootstep = body.footstep.bind(body);
  const realAudible = body.audible.bind(body);
  const realClaim = sys.graph.claim.bind(sys.graph);
  body.footstep = function (x, y, z, s, h, f) {
    stats.called++;
    stats.listener = [body.lx, body.ly, body.lz];
    const d = Math.hypot(x - body.lx, y - body.ly, z - body.lz);
    if (stats.dists.length < 6) stats.dists.push(+d.toFixed(1));
    if (!realAudible(x, y, z)) { stats.culled++; return; }
    const before = sys.graph.voiceCount;
    realFootstep(x, y, z, s, h, f);
    if (sys.graph.voiceCount > before) stats.made++; else stats.unclaimed++;
  };

  const dt = 1 / 60;
  for (let i = 0; i < 120; i++) { vt = i * dt; sys.lateUpdate(dt, ctx); }
  const emit = (e, p) => { for (const fn of ctx.events.map.get(e) ?? []) { try { fn(p); } catch (err) { console.error(e, err.message); } } };

  // One footstep per half second, marching away from the listener, so the
  // distance law can be read straight off the peaks.
  const RANGES = [2, 5, 10, 20, 35, 57];
  const times = [];
  for (let i = 0; i < 240; i++) {
    vt = 2 + i * dt;
    const k = Math.round(i / 30);
    if (i % 30 === 0 && k < RANGES.length) {
      times.push([RANGES[k], vt]);
      emit('player:footstep', {
        id: 0, pos: { x: 0, y: 0.02, z: 46 - RANGES[k] },
        foot: 'R', speed: 6.5, hard: true,
      });
    }
    sys.lateUpdate(dt, ctx);
  }
  const buf = await oac.startRendering();
  const L = buf.getChannelData(0); const R = buf.getChannelData(1);
  const peakIn = (t0, t1) => {
    let p = 0;
    for (let i = Math.round(t0 * SR); i < Math.min(L.length, Math.round(t1 * SR)); i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (a > p) p = a;
    }
    return p;
  };
  const byRange = times.map(([d, t]) => [d, +(20 * Math.log10(Math.max(1e-12, peakIn(t, t + 0.35)))).toFixed(1)]);
  let peak = 0; let s = 0;
  const i0 = Math.round(2 * SR);
  for (let i = i0; i < L.length; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (a > peak) peak = a;
    s += (L[i] * L[i] + R[i] * R[i]) * 0.5;
  }
  const hrtf = sys.graph.budget.hrtf;
  return { ...stats, hrtf, byRange, peak, rms: Math.sqrt(s / (L.length - i0)), voices: sys.graph.voiceCount };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
if (child) child.kill('SIGTERM');
