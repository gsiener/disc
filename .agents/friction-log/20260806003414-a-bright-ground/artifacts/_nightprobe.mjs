import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const Q = process.env.Q ?? 'ultra';
const SHOT = process.env.SHOT ?? 'night';

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
    '--force-device-scale-factor=1', '--window-size=1280,720'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${ORIGIN}/?capture=1&q=${Q}&settle=0`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
await page.waitForFunction('window.__READY__ === true', { timeout: 300_000 });

const out = await page.evaluate(async (shot) => {
  const rig = window.__RIG__;
  const eng = window.__ENGINE__;
  await rig.shot(shot, 3);
  const ctx = eng.ctx;
  const L = ctx.sys.lighting;
  const lights = [];
  ctx.scene.traverse((o) => {
    if (o.isLight) lights.push({
      type: o.type, name: o.name, i: +(o.intensity ?? 0).toFixed(1),
      col: o.color ? '#' + o.color.getHexString() : null,
      cast: !!o.castShadow,
      si: o.shadow ? +(o.shadow.intensity ?? 1).toFixed(3) : null,
      map: o.shadow?.mapSize?.x ?? 0,
      rad: o.shadow ? +(o.shadow.radius ?? 0).toFixed(2) : null,
      pen: o.penumbra !== undefined ? o.penumbra : null,
      ang: o.angle !== undefined ? +o.angle.toFixed(3) : null,
      dec: o.decay !== undefined ? o.decay : null,
      pos: o.position ? o.position.toArray().map(v => +v.toFixed(1)) : null,
    });
  });
  const fog = ctx.scene.fog ? { c: '#' + ctx.scene.fog.color.getHexString(), d: ctx.scene.fog.density } : null;
  const bg = ctx.scene.background;
  return {
    report: L.lightReport(),
    exposure: +ctx.renderer.toneMappingExposure.toFixed(3),
    toneMapping: ctx.renderer.toneMapping,
    lights, fog,
    envIntensity: ctx.scene.environmentIntensity,
    hasEnv: !!ctx.scene.environment,
    bgType: bg ? (bg.isColor ? '#' + bg.getHexString() : bg.constructor.name) : null,
    quality: { tier: ctx.quality.tier, cascades: ctx.quality.shadowCascades, sms: ctx.quality.shadowMapSize },
    sysNames: Object.keys(ctx.sys),
    sheen: (() => {
      const m = ctx.scene.getObjectByName('towers.sheen');
      if (!m) return null;
      const u = m.material.uniforms ?? {};
      const o = { visible: m.visible, ro: m.renderOrder, blend: m.material.blending, depth: m.material.depthTest };
      for (const k of Object.keys(u)) { const v = u[k].value; o[k] = (typeof v === 'number') ? +v.toFixed(4) : (v && v.isColor ? '#'+v.getHexString() : (Array.isArray(v) ? v.length : String(v && v.constructor && v.constructor.name))); }
      return o;
    })(),
    mats: (() => {
      const seen = new Map();
      ctx.scene.traverse((o) => {
        const mm = o.material; if (!mm) return;
        for (const m of (Array.isArray(mm) ? mm : [mm])) {
          if (!m.isMeshStandardMaterial && !m.isMeshPhysicalMaterial) continue;
          const n = m.name || o.name || m.type;
          if (seen.has(n)) continue;
          seen.set(n, { r: m.roughness, mt: m.metalness, env: m.envMapIntensity, sheen: m.sheen ?? null, spec: m.specularIntensity ?? null, rmap: !!m.roughnessMap, csm: !!m.userData.__csmFn || !!m.userData.__csmSelfChained });
        }
      });
      return Object.fromEntries([...seen].slice(0, 60));
    })(),
  };
}, SHOT);

console.log(JSON.stringify(out, null, 1));
await browser.close();
child.kill('SIGTERM');
process.exit(0);
