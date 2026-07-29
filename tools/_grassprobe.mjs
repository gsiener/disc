import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const Q = argv[0] ?? 'ultra';
const SHOT = argv[1] ?? 'turf';

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = await freePort();
const ORIGIN = `http://localhost:${PORT}`;
const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'ignore', 'ignore'] });
for (let i = 0; i < 90; i++) {
  await sleep(500);
  try { const r = await fetch(ORIGIN, { signal: AbortSignal.timeout(1500) }); if (r.ok) break; } catch {}
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--no-sandbox', '--disable-gpu-sandbox', '--mute-audio', '--force-device-scale-factor=1',
    '--window-size=1920,1080'],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  protocolTimeout: 900_000,
});
const page = await browser.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
await page.goto(`${ORIGIN}/?capture=1&q=${Q}&settle=0`, { waitUntil: 'domcontentloaded', timeout: 300_000 });
await page.waitForFunction('window.__READY__ === true', { timeout: 600_000 });

const out = await page.evaluate(async (shot) => {
  const rig = window.__RIG__, eng = window.__ENGINE__, ctx = eng.ctx;
  await rig.shot(shot, 10);
  const grass = ctx.scene.getObjectByName('grass');
  const gl = ctx.renderer.getContext();
  const sync = () => { gl.finish(); const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
  const stat = (N) => {
    eng.step(1 / 60); sync();
    const t0 = performance.now();
    for (let i = 0; i < N; i++) { eng.step(1 / 60); sync(); }
    const ms = (performance.now() - t0) / N;
    const inf = ctx.renderer.info;
    return { ms: +ms.toFixed(2), calls: inf.render.calls, tris: inf.render.triangles };
  };
  const setV = (v) => { if (grass) grass.visible = v; };
  setV(true); const w1 = stat(8);
  setV(false); const n1 = stat(8);
  setV(true); const w2 = stat(8);
  setV(false); const n2 = stat(8);
  setV(true);
  const withG = w1.ms <= w2.ms ? w1 : w2;
  const noG = n1.ms <= n2.ms ? n1 : n2;
  const rings = grass ? grass.children.map((m) => ({
    name: m.name, inst: m.geometry.instanceCount,
    verts: m.geometry.getAttribute('position').count,
    idx: m.geometry.index.count,
  })) : [];
  return { withG, noG, rings, tier: ctx.quality.tier, blades: ctx.quality.grassBlades, dist: ctx.quality.grassDistance, dpr: ctx.dpr };
}, SHOT);

console.log(JSON.stringify({ ...out, problems: [...new Set(problems)].slice(0, 12) }, null, 2));
await browser.close();
child.kill('SIGTERM');
process.exit(0);
