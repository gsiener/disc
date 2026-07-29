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
page.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text()); });
await page.goto(`http://localhost:${PORT}/tools/skyrig/index.html?capture=1&q=high&skyDebug=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.__READY__ === true', { timeout: 180000 });
const r = await page.evaluate(async () => {
  const e = window.__ENGINE__;
  const sky = e.ctx.sys.sky;
  const stats = (tex, n) => {
    const d = tex.image.data; const out = [];
    for (let c = 0; c < 4; c++) {
      let mn = 255, mx = 0, sum = 0, cnt = 0;
      for (let k = c; k < d.length; k += 4 * 7) { const v = d[k]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v; cnt++; }
      out.push(`${mn}/${(sum / cnt).toFixed(0)}/${mx}`);
    }
    return `${n} ${tex.image.width}^3 min/avg/max: ` + out.join('  ');
  };
  const w = sky.tex.weather;
  return {
    shape: stats(sky.tex.shape, 'shape'),
    detail: stats(sky.tex.detail, 'detail'),
    weather: stats(w, 'weather'),
    uni: `cov=${sky.mat.uniforms.uCoverage.value.toFixed(3)} dens=${sky.mat.uniforms.uCloudDensity.value.toFixed(2)} bot=${sky.mat.uniforms.uCloudBottom.value} top=${sky.mat.uniforms.uCloudTop.value} wind=${sky.mat.uniforms.uWind.value.toArray()}`,
    amb: `ambTop=${sky.mat.uniforms.uAmbTop.value.toArray().map(v=>+v.toFixed(3))} ambBot=${sky.mat.uniforms.uAmbBot.value.toArray().map(v=>+v.toFixed(3))} sunRad=${sky.mat.uniforms.uSunRadiance.value.toArray().map(v=>+v.toFixed(3))}`,
  };
});
console.log(JSON.stringify(r, null, 1));
await browser.close(); child.kill('SIGTERM'); process.exit(0);
