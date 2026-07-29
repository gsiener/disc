#!/usr/bin/env node
/**
 * Deterministic screenshot rig.
 *
 *   node tools/capture.mjs                     # every shot, 1920x1080
 *   node tools/capture.mjs broadcast closeup   # named shots only
 *   node tools/capture.mjs --w 2560 --h 1440 --out shots/hi
 *
 * Drives the page through window.__RIG__ so the simulation advances by exact
 * fixed steps rather than wall-clock — the same shot name always yields the same
 * pixels, which is what lets a critic attribute an image change to a code change.
 *
 * Uses the system Chrome (puppeteer's bundled download is not required) with the
 * Metal ANGLE backend so headless still gets real GPU rasterisation.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT ?? 5173);
const ORIGIN = `http://localhost:${PORT}`;

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const W = Number(flag('w', 1920));
const H = Number(flag('h', 1080));
const OUT = flag('out', 'shots');
const QUALITY = flag('q', 'ultra');
const SETTLE = Number(flag('settle', 150));
const KEEP = argv.includes('--keep-server'); if (KEEP) argv.splice(argv.indexOf('--keep-server'), 1);
const requested = argv.filter((a) => !a.startsWith('--'));

/* ------------------------------------------------------------- dev server */

async function serverUp() {
  try {
    const r = await fetch(ORIGIN, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch { return false; }
}

let child = null;
async function ensureServer() {
  if (await serverUp()) return false;
  child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: false,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await serverUp()) return true;
  }
  throw new Error('vite did not come up on ' + ORIGIN);
}

/* ------------------------------------------------------------------- main */

const startedServer = await ensureServer();
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell' === process.env.HEADLESS_SHELL ? 'shell' : true,
  args: [
    '--headless=new',
    '--use-angle=metal',
    '--enable-gpu',
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--hide-scrollbars',
    '--mute-audio',
    '--force-device-scale-factor=1',
    `--window-size=${W},${H}`,
    '--disable-features=CalculateNativeWinOcclusion',
  ],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  protocolTimeout: 240_000,
});

const page = await browser.newPage();
const problems = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') problems.push(`[${t}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

const url = `${ORIGIN}/?capture=1&q=${QUALITY}&settle=0`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction('window.__READY__ === true', { timeout: 180_000 });

// Report what the GPU actually is — swiftshader means the shots are worthless.
const gpu = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(`GPU: ${gpu}`);
if (/swiftshader|llvmpipe|software/i.test(gpu)) {
  console.warn('!! Software rasteriser — screenshots will not reflect real GPU output.');
}

const shots = await page.evaluate(() => window.__RIG__.shots);
const list = requested.length ? requested : shots;
const unknown = list.filter((s) => !shots.includes(s));
if (unknown.length) {
  console.error(`Unknown shot(s): ${unknown.join(', ')}\nAvailable: ${shots.join(', ')}`);
  process.exit(2);
}

const results = [];
for (const name of list) {
  const t0 = Date.now();
  await page.evaluate(
    async (n, settle) => { await window.__RIG__.shot(n, settle); window.__RIG__.render(); },
    name, SETTLE,
  );
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file, type: 'png', captureBeyondViewport: false });
  const ms = Date.now() - t0;
  results.push({ name, file, ms });
  console.log(`  ${name.padEnd(11)} -> ${file}  (${ms}ms)`);
}

// Frame-time probe on the primary shot, so perf regressions surface with looks.
const perf = await page.evaluate(async () => {
  await window.__RIG__.shot('broadcast', 60);
  const N = 45, t0 = performance.now();
  for (let i = 0; i < N; i++) window.__RIG__.advance(1, 1 / 60);
  const ms = (performance.now() - t0) / N;
  const info = window.__ENGINE__.ctx.renderer.info;
  return { ms: +ms.toFixed(2), calls: info.render.calls, tris: info.render.triangles };
});
console.log(`\nframe ${perf.ms}ms  |  ${perf.calls} draw calls  |  ${perf.tris.toLocaleString()} tris`);

writeFileSync(`${OUT}/_meta.json`, JSON.stringify({ gpu, perf, results, problems, W, H, QUALITY }, null, 2));

if (problems.length) {
  console.log(`\n${problems.length} console problem(s):`);
  for (const p of [...new Set(problems)].slice(0, 25)) console.log('  ' + p);
}

await browser.close();
if (child && !KEEP) child.kill('SIGTERM');
process.exit(0);
