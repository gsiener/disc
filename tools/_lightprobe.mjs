import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const Q = process.argv[2] ?? 'high';
const SHOT = process.argv[3] ?? 'broadcast';

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = await freePort();
const ORIGIN = `http://localhost:${PORT}`;
const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { const r = await fetch(ORIGIN, { signal: AbortSignal.timeout(1000) }); if (r.ok) break; } catch {}
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--no-sandbox', '--disable-gpu-sandbox', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=1', '--window-size=1920,1080'],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${ORIGIN}/?capture=1&q=${Q}&settle=0`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
await page.waitForFunction('window.__READY__ === true', { timeout: 300_000 });

const out = await page.evaluate(async (shot) => {
  const rig = window.__RIG__;
  const eng = window.__ENGINE__;
  const info = eng.ctx.renderer.info;
  await rig.shot(shot, 2);
  const rows = [];
  let prevPrograms = info.programs.length;
  for (let i = 0; i < 8; i++) {
    const t0 = performance.now();
    rig.advance(1, 1 / 60);
    const cpu = performance.now() - t0;
    rows.push({
      i, cpu: +cpu.toFixed(1),
      calls: info.render.calls, tris: info.render.triangles,
      programs: info.programs.length, newPrograms: info.programs.length - prevPrograms,
    });
    prevPrograms = info.programs.length;
  }
  const gl = eng.ctx.renderer.getContext();
  const t0 = performance.now();
  for (let i = 0; i < 4; i++) rig.advance(1, 1 / 60);
  const px = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const gpuWall = (performance.now() - t0) / 4;

  const lights = [];
  eng.ctx.scene.traverse((o) => {
    if (o.isLight) lights.push({
      type: o.type, name: o.name, i: +(o.intensity ?? 0).toFixed(2),
      cast: !!o.castShadow,
      map: o.shadow?.mapSize ? o.shadow.mapSize.x : 0,
      auto: o.shadow ? o.shadow.autoUpdate : null,
      si: o.shadow ? +(o.shadow.intensity ?? 1).toFixed(2) : null,
    });
  });
  let castCount = 0, castTris = 0;
  eng.ctx.scene.traverse((o) => {
    if (o.isMesh && o.castShadow) {
      castCount++;
      const g = o.geometry;
      const n = (g.index ? g.index.count : g.attributes.position.count) / 3;
      castTris += n * (o.isInstancedMesh ? o.count : 1);
    }
  });
  const L = eng.ctx.sys.lighting; const hasL = !!(L && L.sun && L.towers);
  return {
    rows, gpuWall: +gpuWall.toFixed(1), lights, castCount, castTris: Math.round(castTris),
    exposure: +eng.ctx.renderer.toneMappingExposure.toFixed(3),
    sun: hasL ? { i: +L.sun.intensity.toFixed(2), elev: +(L.sun.elevation * 57.3).toFixed(1), night: +L.sun.night.toFixed(2), towers: +L.sun.towers.toFixed(2), dir: L.sun.dir.toArray().map((v) => +v.toFixed(2)) } : null,
    towerIrr: hasL ? +L.towers.irradiance.toFixed(3) : null,
    envIntensity: eng.ctx.scene.environmentIntensity,
    hasEnv: !!eng.ctx.scene.environment,
  };
}, SHOT);

console.log(JSON.stringify(out, null, 1));
await browser.close();
child.kill('SIGTERM');
process.exit(0);
