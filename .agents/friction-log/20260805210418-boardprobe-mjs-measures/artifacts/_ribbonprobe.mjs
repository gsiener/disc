#!/usr/bin/env node
/**
 * Roof-ribbon repeat probe.
 *
 * `_boardprobe.mjs` measures the pitch-side LED ring at the live tele framing.
 * The ribbon is a different board with the same disease and it is never in the
 * tele frame — it lives in the establishing shots, which are pinned, so it
 * needs its own rig: apply a named shot, then count how many sponsor cells of
 * the ribbon are on screen and which of them repeat.
 *
 *   node tools/_ribbonprobe.mjs --shots night,stadium
 *
 * Reports per shot the visible cell sequence, the duplicates, and the longest
 * stretch of brands that are consecutive in the eight-panel loop — that last
 * one is the number that matters, because an ordered run of six is what makes
 * a viewer read "tiled texture" rather than "a lot of adverts".
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); if (i === -1) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const QUALITY = flag('q', 'high');
const OUT = flag('out', 'shots/_ribbon.json');
const SHOTS = flag('shots', 'night,stadium').split(',');
const W = 1280, H = 720;

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.PORT ?? await freePort());
const ORIGIN = `http://localhost:${PORT}`;
async function serverUp() {
  try { const r = await fetch(ORIGIN, { signal: AbortSignal.timeout(1200) }); return r.ok; } catch { return false; }
}
let child = null;
if (!await serverUp()) {
  child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  for (let i = 0; i < 60; i++) { await sleep(500); if (await serverUp()) break; }
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox', '--no-sandbox', '--mute-audio', '--force-device-scale-factor=1',
    `--window-size=${W},${H}`, '--disable-features=CalculateNativeWinOcclusion'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  protocolTimeout: 240_000,
});
const page = await browser.newPage();
const problems = [];
page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning') problems.push(`[${t}] ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await page.goto(`${ORIGIN}/?capture=1&q=${QUALITY}&settle=0`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction('window.__READY__ === true', { timeout: 180_000 });

const NAMES = ['AEROGRIP', 'NIMBUS', 'HELIODYNE', 'PORTSIDE', 'VANTA', 'KESTREL', 'OBSIDIAN', 'FLATLINE'];

const report = [];
for (const shot of SHOTS) {
  await page.evaluate(async (n) => { await window.__RIG__.shot(n, 60); window.__RIG__.render(); }, shot);
  const f = await page.evaluate((VW, VH) => {
    const ctx = window.__ENGINE__.ctx;
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    const xf = (e, x, y, z) => ({
      x: e[0] * x + e[4] * y + e[8] * z + e[12],
      y: e[1] * x + e[5] * y + e[9] * z + e[13],
      z: e[2] * x + e[6] * y + e[10] * z + e[14],
      w: e[3] * x + e[7] * y + e[11] * z + e[15],
    });
    const V = cam.matrixWorldInverse.elements, P = cam.projectionMatrix.elements;
    let rib = null;
    ctx.scene.traverse((o) => {
      if (o.isMesh && !o.isInstancedMesh
        && (o.name === 'led-ribbon' || o.geometry?.name === 'led-ribbon')) rib = o;
    });
    if (!rib) return null;
    const g = rib.geometry, pos = g.attributes.position, uv = g.attributes.uv;
    const mod1 = (x) => x - Math.floor(x);
    const cells = [];
    for (let k = 0; k < pos.count / 4; k++) {
      const b = k * 4;
      const ends = [];
      for (const i of [b, b + 1]) {
        const e = xf(V, pos.getX(i), pos.getY(i), pos.getZ(i));
        if (e.z > -0.1) { ends.length = 0; break; }
        const c = xf(P, e.x, e.y, e.z);
        ends.push({ x: (c.x / c.w * 0.5 + 0.5) * VW, y: (1 - (c.y / c.w * 0.5 + 0.5)) * VH });
      }
      if (ends.length !== 2) continue;
      const x0 = Math.min(ends[0].x, ends[1].x), x1 = Math.max(ends[0].x, ends[1].x);
      if (x1 < 0 || x0 > VW || ends[0].y < -60 || ends[0].y > VH + 60) continue;
      const u0 = uv.getX(b), u1 = uv.getX(b + 1);
      const S = 6;
      for (let s = 0; s < S; s++) {
        const ua = u0 + (u1 - u0) * (s / S), ub = u0 + (u1 - u0) * ((s + 1) / S);
        cells.push({
          x0: x0 + (x1 - x0) * (s / S), x1: x0 + (x1 - x0) * ((s + 1) / S),
          brand: Math.floor(mod1((ua + ub) * 0.5) * 8) % 8,
        });
      }
    }
    cells.sort((a, b2) => a.x0 - b2.x0);
    const slots = [];
    for (const c of cells) {
      const last = slots[slots.length - 1];
      if (last && last.brand === c.brand && c.x0 - last.x1 < 5) { last.x1 = Math.max(last.x1, c.x1); continue; }
      slots.push({ brand: c.brand, x0: c.x0, x1: c.x1 });
    }
    return { slots: slots.filter((s) => s.x1 - s.x0 >= 8 && s.x1 > 0 && s.x0 < VW) };
  }, W, H);

  if (!f) { report.push({ shot, error: 'no led-ribbon' }); continue; }
  const seq = f.slots.map((s) => s.brand);
  const count = new Map();
  for (const b of seq) count.set(b, (count.get(b) ?? 0) + 1);
  let best = seq.length ? 1 : 0, cur = 1;
  for (let i = 1; i < seq.length; i++) {
    if ((seq[i - 1] + 1) % 8 === seq[i]) { cur++; if (cur > best) best = cur; } else cur = 1;
  }
  report.push({
    shot, slots: seq.length, distinct: count.size, longestRun: best,
    dupes: [...count.entries()].filter(([, c]) => c > 1).map(([b, c]) => `${NAMES[b]}×${c}`),
    order: f.slots.map((s) => `${NAMES[s.brand]}@${Math.round(s.x0)}`),
  });
}

for (const r of report) {
  if (r.error) { console.log(`${r.shot}: ${r.error}`); continue; }
  console.log(`${r.shot}: ${r.slots} cells, ${r.distinct} distinct, `
    + `longest in-loop run ${r.longestRun}, dupes ${r.dupes.join(' ') || 'none'}`);
  console.log(`  ${r.order.join(' ')}`);
}
if (problems.length) console.log('problems:', [...new Set(problems)].slice(0, 8));
writeFileSync(OUT, JSON.stringify({ quality: QUALITY, report, problems }, null, 2));
console.log(`-> ${OUT}`);

await browser.close();
if (child) child.kill('SIGTERM');
process.exit(0);
