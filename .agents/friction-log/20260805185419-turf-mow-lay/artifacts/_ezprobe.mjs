#!/usr/bin/env node
/**
 * ENDZONE-LEGIBILITY PROBE.
 *
 * The question is not "does the pitch look nice", it is "can a viewer tell the
 * endzone from the field of play, at the tele's real working range, in sun and
 * in shadow". That is a measurement, so this measures it:
 *
 *   - pins a camera at a stated distance and lens,
 *   - renders,
 *   - reads the framebuffer back through a 2D canvas,
 *   - projects a dense world-space grid of turf points into that frame and
 *     samples them, rejecting anything that is not turf (paint, kit, skin) by
 *     colour,
 *   - reports, per region: sample count, median display luminance, and the
 *     p10/p90 spread, which IS the mow-stripe modulation.
 *
 * Then it does the whole thing again with every DirectionalLight in the scene
 * set to zero intensity. That is "in shadow" in the only sense that matters to
 * a shader: the turf lit by sky and bounce alone, with no direct sun term.
 *
 *   node tools/_ezprobe.mjs --q high --w 1280 --h 720 --out shots/ezprobe
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const PORT = Number(process.env.PORT ?? await freePort());
const ORIGIN = `http://localhost:${PORT}`;
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1]; argv.splice(i, 2); return v;
};
const W = Number(flag('w', 1280));
const H = Number(flag('h', 720));
const OUT = flag('out', 'shots/ezprobe');
const QUALITY = flag('q', 'high');

/* Framings. Every one states the range to the goal line and the lens, because
   the acceptance criterion is stated in those terms. */
const FRAMINGS = [
  {
    name: 'tele-52m-24deg',
    note: 'tele broadcast, goal line z=-32 at ~52 m, 24 deg lens',
    pos: [-45, 13, -8], target: [0, 1.4, -30], fov: 24, hour: 16.5,
    focus: 52, aperture: 2.8, ez: [-48, -34.5], fop: [-29.5, -16],
  },
  {
    name: 'tele-42m-30deg',
    note: 'wider tele, goal line z=+32 at ~42 m, 30 deg lens',
    pos: [-36, 12, 6], target: [0, 1.4, 30], fov: 30, hour: 17.8,
    focus: 42, aperture: 2.8, ez: [34.5, 48], fop: [16, 29.5],
  },
  {
    name: 'broadcast',
    note: 'the shipped broadcast framing and its own f/0.9 DOF, unmodified',
    pos: [-34, 15.5, 30], target: [0, 1.6, 4], fov: 34, hour: 16.5,
    focus: 46, aperture: 0.9, ez: [-48, -34.5], fop: [-29.5, -16],
  },
  {
    name: 'redzone-low',
    note: 'low red-zone angle from behind the end line, 30 deg lens',
    pos: [10, 3.4, -62], target: [-1, 1.4, -26], fov: 30, hour: 18.9,
    focus: 30, aperture: 2.8, ez: [-48, -34.5], fop: [-29.5, -16],
  },
  {
    name: 'ez-lit',
    note: 'sideline tele onto the LIT +Z endzone, goal line at ~40 m, 30 deg lens',
    pos: [-40, 14, 20], target: [0, 1.0, 40], fov: 30, hour: 17.2,
    focus: 46, aperture: 3.5, ez: [34.5, 48], fop: [16, 29.5],
  },
  {
    name: 'plan-noon',
    note: 'whole pitch, high sun, nothing in stand shadow',
    pos: [-72, 62, -78], target: [0, 0, 0], fov: 45, hour: 13.5,
    focus: 0, aperture: 0, ez: [34.5, 48], fop: [16, 29.5],
  },
  {
    name: 'plan-oblique',
    note: 'whole pitch from high and oblique — is the pattern even there',
    pos: [-72, 62, -78], target: [0, 0, 0], fov: 45, hour: 17.2,
    focus: 0, aperture: 0, ez: [-48, -34.5], fop: [-29.5, -16],
  },
  {
    name: 'aerial-pull',
    note: 'high aerial for the pull — worst case, both lays near-vertical',
    pos: [-30, 46, -6], target: [0, 0, -20], fov: 34, hour: 17.2,
    focus: 55, aperture: 4.0, ez: [-48, -34.5], fop: [-29.5, -16],
  },
];

async function serverUp() {
  try { const r = await fetch(ORIGIN, { signal: AbortSignal.timeout(1200) }); return r.ok; }
  catch { return false; }
}
let child = null;
async function ensureServer() {
  if (await serverUp()) return;
  child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  for (let i = 0; i < 60; i++) { await sleep(500); if (await serverUp()) return; }
  throw new Error('vite did not come up on ' + ORIGIN);
}
await ensureServer();
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--enable-zero-copy', '--disable-gpu-sandbox',
    '--no-sandbox', '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1',
    `--window-size=${W},${H}`, '--disable-features=CalculateNativeWinOcclusion',
  ],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
const problems = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') problems.push(`[${t}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

await page.goto(`${ORIGIN}/?capture=1&q=${QUALITY}&settle=0`,
  { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction('window.__READY__ === true', { timeout: 180_000 });

const gpu = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(`GPU: ${gpu}`);
if (/swiftshader|llvmpipe|software/i.test(gpu)) {
  console.warn('!! Software rasteriser — numbers are worthless.');
}

/* The sampler runs in the page: it needs the live camera matrices and the
   framebuffer in the same task as the render call. */
const SAMPLER = `(cfg) => {
  const ctx = window.__ENGINE__.ctx;
  const cam = ctx.camera;
  const field = ctx.sys['field'];
  const canvas = ctx.renderer.domElement;
  const w = canvas.width, h = canvas.height;

  const c2 = document.createElement('canvas');
  c2.width = w; c2.height = h;
  const g = c2.getContext('2d', { willReadFrequently: true });
  g.drawImage(canvas, 0, 0);
  const img = g.getImageData(0, 0, w, h).data;

  cam.updateMatrixWorld(true);
  const V = cam.matrixWorldInverse.elements, Pm = cam.projectionMatrix.elements;
  const mul = (m, x, y, z, ww) => [
    m[0]*x + m[4]*y + m[8]*z + m[12]*ww,
    m[1]*x + m[5]*y + m[9]*z + m[13]*ww,
    m[2]*x + m[6]*y + m[10]*z + m[14]*ww,
    m[3]*x + m[7]*y + m[11]*z + m[15]*ww,
  ];
  const project = (x, y, z) => {
    const v = mul(V, x, y, z, 1);
    const p = mul(Pm, v[0], v[1], v[2], v[3]);
    if (p[3] <= 0) return null;
    const ndcX = p[0] / p[3], ndcY = p[1] / p[3], ndcZ = p[2] / p[3];
    if (ndcZ < -1 || ndcZ > 1) return null;
    const sx = Math.round((ndcX * 0.5 + 0.5) * w);
    const sy = Math.round((1 - (ndcY * 0.5 + 0.5)) * h);
    if (sx < 1 || sy < 1 || sx >= w - 1 || sy >= h - 1) return null;
    return [sx, sy, -v[2]];
  };

  // Relative luminance in display space (what the eye gets), 0..1.
  const lum = (r, gg, b) => (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;

  /* Linear detrend, then RMS. A region 14 m deep seen from 50 m has a real
     brightness ramp across it from the light falloff and the crown; without
     removing it, that ramp would masquerade as band energy on the axis it runs
     along. What is left after a straight line is taken out is the pattern. */
  function detrendedRms(series) {
    const pts = series.map((v, i) => [i, v]).filter((p) => Number.isFinite(p[1]));
    const n = pts.length;
    if (n < 6) return NaN;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [i, v] of pts) { sx += i; sy += v; sxx += i * i; sxy += i * v; }
    const den = n * sxx - sx * sx;
    const m = den === 0 ? 0 : (n * sxy - sx * sy) / den;
    const c = (sy - m * sx) / n;
    let acc = 0;
    for (const [i, v] of pts) { const r = v - (m * i + c); acc += r * r; }
    return Math.sqrt(acc / n);
  }
  const meanOf = (a) => {
    const f = a.filter(Number.isFinite);
    return f.length ? f.reduce((p, q2) => p + q2, 0) / f.length : NaN;
  };

  function region(x0, x1, z0, z1, step) {
    const xs = [], zs = [];
    for (let x = x0; x <= x1 + 1e-6; x += step) xs.push(x);
    for (let z = z0; z <= z1 + 1e-6; z += step) zs.push(z);
    const grid = zs.map(() => new Array(xs.length).fill(NaN));
    const vals = [], dists = [];
    let tried = 0, offscreen = 0, rejected = 0;
    for (let j = 0; j < zs.length; j++) {
      for (let i = 0; i < xs.length; i++) {
        tried++;
        const x = xs[i], z = zs[j];
        const y = field ? field.heightAt(x, z) : 0;
        const p = project(x, y, z);
        if (!p) { offscreen++; continue; }
        const k = (p[1] * w + p[0]) * 4;
        const r = img[k], gg = img[k + 1], b = img[k + 2];
        // Turf only. Paint is neutral-to-warm, kits are blue/white/red, skin is
        // warm: all of them fail "green is the dominant channel by a margin".
        if (!(gg > r * 1.06 && gg > b * 1.12)) { rejected++; continue; }
        const L = lum(r, gg, b);
        grid[j][i] = L;
        vals.push(L);
        dists.push(p[2]);
      }
    }
    vals.sort((a, b2) => a - b2);
    const q = (t) => vals.length ? vals[Math.min(vals.length - 1, Math.floor(t * vals.length))] : NaN;
    dists.sort((a, b2) => a - b2);

    // Band energy per axis. rowMeans varies with z -> crosswise banding;
    // colMeans varies with x -> lengthwise (base cut) banding. bandD projects
    // onto the endzone cross pass's own 45 deg axis, mirrored the way the
    // shader mirrors it, which is the only axis a diagonal band shows up on.
    const rowMeans = grid.map(meanOf);
    const colMeans = xs.map((_, i) => meanOf(grid.map((row) => row[i])));
    const sgn = (z0 + z1) < 0 ? -1 : 1;
    const R2H = Math.SQRT1_2;
    const usAll = [];
    for (let j = 0; j < zs.length; j++) {
      for (let i = 0; i < xs.length; i++) {
        if (Number.isFinite(grid[j][i])) usAll.push([(xs[i] + sgn * zs[j]) * R2H, grid[j][i]]);
      }
    }
    let dBins = [];
    if (usAll.length) {
      const u0 = Math.min(...usAll.map((p) => p[0]));
      const u1 = Math.max(...usAll.map((p) => p[0]));
      const nb = Math.max(8, Math.round((u1 - u0) / step));
      const sum = new Array(nb).fill(0), cnt = new Array(nb).fill(0);
      for (const [u, L] of usAll) {
        const b = Math.min(nb - 1, Math.floor(((u - u0) / (u1 - u0)) * nb));
        sum[b] += L; cnt[b]++;
      }
      // Bins at the corners of the sampled rectangle hold very few points and
      // are pure noise; drop anything under a tenth of the mean occupancy.
      const meanCnt = cnt.reduce((a, b) => a + b, 0) / nb;
      dBins = sum.map((s, b) => (cnt[b] > meanCnt * 0.25 ? s / cnt[b] : NaN));
    }
    const med = q(0.50);
    const rmsZ = detrendedRms(rowMeans);
    const rmsX = detrendedRms(colMeans);
    const rmsD = detrendedRms(dBins);
    return {
      n: vals.length, tried, offscreen, rejected,
      p10: q(0.10), p50: med, p90: q(0.90),
      spread: q(0.90) - q(0.10),
      // as a percentage of the region's own median: Weber-ish contrast
      bandX: +(100 * rmsX / med).toFixed(2),
      bandZ: +(100 * rmsZ / med).toFixed(2),
      bandD: +(100 * rmsD / med).toFixed(2),
      distM: dists.length ? +dists[Math.floor(dists.length / 2)].toFixed(1) : null,
    };
  }

  return {
    ez: region(-14, 14, cfg.ez[0], cfg.ez[1], 0.35),
    fop: region(-14, 14, cfg.fop[0], cfg.fop[1], 0.35),
  };
}`;

const ONLY = flag('only', '');
const CUTS = flag('cuts', '1,0').split(',').map(Number);
const rows = [];
for (const f of FRAMINGS.filter((f2) => !ONLY || ONLY.split(',').includes(f2.name))) {
  for (const cut of CUTS) {
    for (const litMode of ['sun', 'shadow']) {
    const r = await page.evaluate(async (cfg, mode, samplerSrc, crossCut) => {
      const ctx = window.__ENGINE__.ctx;
      const fu = ctx.sys['field']?.uniforms;
      if (fu?.uCrossCut) fu.uCrossCut.value = crossCut;
      const shot = {
        about: cfg.note, pos: cfg.pos, target: cfg.target, fov: cfg.fov,
        hour: cfg.hour, tableau: 'flow', focus: cfg.focus, aperture: cfg.aperture,
      };
      ctx.events.emit('shot:apply', { name: 'broadcast', shot });
      ctx.camera.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
      ctx.camera.lookAt(cfg.target[0], cfg.target[1], cfg.target[2]);
      ctx.camera.fov = cfg.fov;
      ctx.camera.updateProjectionMatrix();
      ctx.camera.updateMatrixWorld(true);
      ctx.events.emit('shot:applied', { name: 'broadcast', shot });
      window.__RIG__.advance(90);

      // "In shadow" = kill every direct light, keep sky/ambient/IBL.
      const saved = [];
      if (mode === 'shadow') {
        ctx.scene.traverse((o) => {
          if (o.isDirectionalLight || o.isSpotLight) { saved.push([o, o.intensity]); o.intensity = 0; }
        });
      }
      // Re-pin: advancing may let a director move the camera.
      ctx.camera.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
      ctx.camera.lookAt(cfg.target[0], cfg.target[1], cfg.target[2]);
      ctx.camera.fov = cfg.fov;
      ctx.camera.updateProjectionMatrix();
      ctx.camera.updateMatrixWorld(true);
      window.__RIG__.render();

      // eslint-disable-next-line no-eval
      const sample = eval(samplerSrc);
      const out = sample(cfg);
      out.camPos = [ctx.camera.position.x, ctx.camera.position.y, ctx.camera.position.z]
        .map((v) => +v.toFixed(1));
      const sd = fu?.uSunDir?.value;
      out.sunDir = sd ? [sd.x, sd.y, sd.z].map((v) => +v.toFixed(3)) : null;
      for (const [o, v] of saved) o.intensity = v;
      return out;
    }, f, litMode, SAMPLER, cut);

    if (litMode === 'sun') {
      try {
        await page.screenshot({
          path: `${OUT}/${f.name}-cut${String(cut).replace('.', 'p')}.png`, type: 'png',
        });
      } catch (e) { console.warn(`  (screenshot failed: ${e.message})`); }
    }
    const d = r.ez.p50 - r.fop.p50;
    rows.push({
      framing: f.name, note: f.note, crossCut: cut, light: litMode,
      ...r, deltaP50: +d.toFixed(4),
    });
    const num = (v, dp = 4) => (Number.isFinite(v) ? v.toFixed(dp) : '  n/a');
    const fmt = (o) => `n=${String(o.n).padStart(4)} L=${num(o.p50)} `
      + `X=${String(o.bandX).padStart(5)}% Z=${String(o.bandZ).padStart(5)}% `
      + `D=${String(o.bandD).padStart(5)}% @${o.distM ?? '-'}m`;
    console.log(
      `${f.name.padEnd(15)} cut=${cut} ${litMode.padEnd(7)} EZ ${fmt(r.ez)} | FOP ${fmt(r.fop)} | `
      + `dL=${(d >= 0 ? '+' : '') + d.toFixed(4)}`,
    );
    }
  }
}

writeFileSync(`${OUT}/_ez.json`, JSON.stringify({ gpu, W, H, QUALITY, rows, problems }, null, 2));
if (problems.length) {
  console.log(`\n${problems.length} console problem(s):`);
  for (const p of [...new Set(problems)].slice(0, 15)) console.log('  ' + p);
}
await browser.close();
if (child) child.kill('SIGTERM');
process.exit(0);
