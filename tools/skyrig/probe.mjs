import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = '/Users/grahamsiener/src/claudeahan';
const PORT = await new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', () => {}); child.stderr.on('data', d => process.stderr.write(`[vite] ${d}`));
for (let i = 0; i < 60; i++) { await sleep(400); try { const r = await fetch(`http://localhost:${PORT}`, { signal: AbortSignal.timeout(1000) }); if (r.ok) break; } catch {} }
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--headless=new', '--use-angle=metal', '--enable-gpu', '--no-sandbox', '--disable-gpu-sandbox'], defaultViewport: { width: 800, height: 450 } });
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:${PORT}/tools/skyrig/index.html?capture=1&q=high`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.__READY__ === true', { timeout: 180000 });
const out = await page.evaluate(() => [16.0, 16.5, 17.5, 18.9, 19.4, 20.5, 21.5].map(h => window.__RIG__.info(h)));
console.log(JSON.stringify(out, null, 1));
const cams = await page.evaluate(() => {
  const R = {};
  for (const n of ['broadcast', 'stadium', 'endzone', 'night']) {
    const sh = window.__SHOTS__[n];
    const p = sh.pos, t = sh.target;
    const f = [t[0] - p[0], t[1] - p[1], t[2] - p[2]];
    const L = Math.hypot(f[0], f[1], f[2]); const fw = f.map(v => v / L);
    const info = window.__RIG__.info(sh.hour);
    const sd = info.sunDir;
    const dot = fw[0] * sd[0] + fw[1] * sd[1] + fw[2] * sd[2];
    R[n] = {
      hour: sh.hour, fov: sh.fov, pitch: +(Math.asin(fw[1]) * 57.2958).toFixed(1),
      sunEl: info.el, sunOffAxis: +(Math.acos(Math.max(-1, Math.min(1, dot))) * 57.2958).toFixed(1),
      halfV: +(sh.fov / 2).toFixed(1), halfH: +(Math.atan(Math.tan(sh.fov / 2 * Math.PI / 180) * 16 / 9) * 57.2958).toFixed(1),
    };
  }
  return R;
});
console.log(JSON.stringify(cams, null, 1));
await browser.close(); child.kill('SIGTERM'); process.exit(0);
