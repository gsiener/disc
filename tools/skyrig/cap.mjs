#!/usr/bin/env node
// Scratch capture rig pointed at the isolated sky harness (tools/skyrig).
//   node tools/skyrig/cap.mjs broadcast stadium endzone night
//   node tools/skyrig/cap.mjs --look 19.4,0,2,0,-40,8,-60,55
import puppeteer from 'puppeteer-core';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = '/Users/grahamsiener/src/claudeahan';
const PORT = await new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const ORIGIN = `http://localhost:${PORT}`;
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); if (i === -1) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const OUT = flag('out', 'shots/skydev');
const Q = flag('q', 'ultra');
const EXTRA = flag('extra', '');
const looks = [];
for (;;) { const l = flag('look', null); if (!l) break; looks.push(l.split(',').map(Number)); }
const W = Number(flag('w', 1600)), H = Number(flag('h', 900));
const list = argv.filter(a => !a.startsWith('--'));

const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', () => {}); child.stderr.on('data', d => process.stderr.write(`[vite] ${d}`));
for (let i = 0; i < 60; i++) { await sleep(400); try { const r = await fetch(ORIGIN, { signal: AbortSignal.timeout(1000) }); if (r.ok) break; } catch {} }

if (!existsSync(`${ROOT}/${OUT}`)) mkdirSync(`${ROOT}/${OUT}`, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--disable-gpu-sandbox', '--no-sandbox', '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1',
    `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 }, protocolTimeout: 240000,
});
const page = await browser.newPage();
const problems = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => problems.push(`[pageerror] ${e.message}`));
await page.goto(`${ORIGIN}/tools/skyrig/index.html?capture=1&q=${Q}${EXTRA}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.__READY__ === true', { timeout: 180000 });
console.log('GPU:', await page.evaluate(() => {
  const c = document.createElement('canvas'); const gl = c.getContext('webgl2');
  const d = gl?.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?';
}));
for (const name of list) {
  await page.evaluate(async (n) => { await window.__RIG__.shot(n, 150); window.__RIG__.render(); }, name);
  await page.screenshot({ path: `${ROOT}/${OUT}/${name}.png`, type: 'png' });
  console.log('  ->', `${OUT}/${name}.png`);
}
let li = 0;
for (const l of looks) {
  await page.evaluate((a) => {
    window.__RIG__.look(a[0], [a[1], a[2], a[3]], [a[4], a[5], a[6]], a[7] ?? 55, 150);
    window.__RIG__.render();
  }, l);
  const nm = `look${li++}_h${l[0]}`;
  await page.screenshot({ path: `${ROOT}/${OUT}/${nm}.png`, type: 'png' });
  console.log('  ->', `${OUT}/${nm}.png`);
}
// GPU-synchronised frame cost: read one pixel back each frame to force a flush.
const perf = await page.evaluate(async () => {
  const e = window.__ENGINE__;
  await window.__RIG__.shot('stadium', 30);
  const gl = e.ctx.renderer.getContext();
  const buf = new Uint8Array(4);
  const N = 40; const t0 = performance.now();
  for (let i = 0; i < N; i++) { e.step(1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf); }
  const ms = (performance.now() - t0) / N;
  const info = e.ctx.renderer.info;
  return { ms: +ms.toFixed(2), calls: info.render.calls, tris: info.render.triangles };
});
console.log(`frame ${perf.ms}ms (gpu-synced) | ${perf.calls} calls | ${perf.tris} tris`);
writeFileSync(`${ROOT}/${OUT}/_meta.json`, JSON.stringify({ perf, problems }, null, 2));
if (problems.length) { console.log('problems:'); for (const p of [...new Set(problems)].slice(0, 20)) console.log(' ', p); }
await browser.close(); child.kill('SIGTERM'); process.exit(0);
