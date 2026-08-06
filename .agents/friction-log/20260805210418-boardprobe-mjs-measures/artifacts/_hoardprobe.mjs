#!/usr/bin/env node
/**
 * Printed-hoarding repeat probe.
 *
 * `_boardprobe.mjs` measures the eight LED sponsors. It is blind to the club /
 * competition boards that the re-flow puts in the holes, and that is where the
 * repeat went when the LED repeat was fixed: one design tiled along a run lays
 * the same two printed faces down every 10.8 m.
 *
 * This walks `club-boards`, works out which of the eight printed faces each
 * quad is showing (u is the hoarding atlas' own parameter, 8 faces over [0,1)),
 * projects the quads to screen at the live tele framing, and reports per frame:
 *   • how many distinct board faces are visible
 *   • which faces appear more than once, and how far apart in pixels
 * plus the ring-wide worst case: the closest two showings of any one face get,
 * in metres along the ring.
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
const OUT = flag('out', 'shots/_hoard.json');
const FRAMES = Number(flag('frames', 4));
const SECS = Number(flag('secs', 5.5));

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
    '--window-size=1280,720', '--disable-features=CalculateNativeWinOcclusion'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  protocolTimeout: 240_000,
});
const page = await browser.newPage();
const problems = [];
page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning') problems.push(`[${t}] ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await page.goto(`${ORIGIN}/?capture=1&q=${QUALITY}&settle=0`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction('window.__READY__ === true', { timeout: 180_000 });
await page.evaluate(() => {
  const ctx = window.__ENGINE__?.ctx;
  ctx.sys['camera'].unpin();
  ctx.sys['game'].posed = false;
});

/** The eight printed faces, in atlas order: design d occupies faces 2d, 2d+1. */
const FACES = [
  'RIVERSIDE CURRENT', 'RVR / RIVER ROAD',
  'CHAMPIONSHIP SERIES', 'MATCH 4',
  'SPIRIT OF THE GAME', 'CALL YOUR OWN',
  'RIVERSIDE PARK', 'SUPPORTERS CLUB',
];

/* ------------------------------------------------- ring-wide face spacing */
const ring = await page.evaluate(() => {
  let club = null;
  window.__ENGINE__.ctx.scene.traverse((o) => { if (o.name === 'club-boards') club = o; });
  if (!club) return null;
  const g = club.geometry, pos = g.attributes.position, uv = g.attributes.uv;
  const mod1 = (x) => x - Math.floor(x);
  // Only the front faces: the top return quads share u but sit at v ≈ 1.
  const runsOut = [];
  for (let k = 0; k < pos.count / 4; k++) {
    const b = k * 4;
    if (uv.getY(b) > 0.5) continue;                 // a return, not a face
    const face = Math.floor(mod1((uv.getX(b) + uv.getX(b + 1)) * 0.5) * 8) % 8;
    const x = (pos.getX(b) + pos.getX(b + 1)) * 0.5;
    const z = (pos.getZ(b) + pos.getZ(b + 1)) * 0.5;
    const last = runsOut[runsOut.length - 1];
    if (last && last.face === face) { last.x1 = x; last.z1 = z; continue; }
    runsOut.push({ face, x0: x, z0: z, x1: x, z1: z });
  }
  return runsOut;
});

let worst = null;
if (ring) {
  const mid = ring.map((r) => ({ face: r.face, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 }));
  for (let i = 0; i < mid.length; i++) {
    for (let j = i + 1; j < mid.length; j++) {
      if (mid[i].face !== mid[j].face) continue;
      const d = Math.hypot(mid[i].x - mid[j].x, mid[i].z - mid[j].z);
      if (!worst || d < worst.d) worst = { d, face: mid[i].face };
    }
  }
}

/* ----------------------------------------------------- per-frame duplicates */
const frames = [];
for (let f = 0; f < FRAMES; f++) {
  await page.evaluate((s) => window.__RIG__.advance(Math.round(s * 120), 1 / 120),
    f === 0 ? SECS : 2.5);
  frames.push(await page.evaluate(() => {
    const ctx = window.__ENGINE__.ctx;
    window.__RIG__.render();
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    const xf = (e, x, y, z) => ({
      x: e[0] * x + e[4] * y + e[8] * z + e[12],
      y: e[1] * x + e[5] * y + e[9] * z + e[13],
      z: e[2] * x + e[6] * y + e[10] * z + e[14],
      w: e[3] * x + e[7] * y + e[11] * z + e[15],
    });
    const V = cam.matrixWorldInverse.elements, P = cam.projectionMatrix.elements;
    let club = null;
    ctx.scene.traverse((o) => { if (o.name === 'club-boards') club = o; });
    if (!club) return null;
    const g = club.geometry, pos = g.attributes.position, uv = g.attributes.uv;
    const mod1 = (x) => x - Math.floor(x);
    const cells = [];
    for (let k = 0; k < pos.count / 4; k++) {
      const b = k * 4;
      if (uv.getY(b) > 0.5) continue;
      const ends = [];
      for (const i of [b, b + 1]) {
        const e = xf(V, pos.getX(i), pos.getY(i), pos.getZ(i));
        if (e.z > -0.1) { ends.length = 0; break; }
        const c = xf(P, e.x, e.y, e.z);
        ends.push({ x: (c.x / c.w * 0.5 + 0.5) * 1280, y: (1 - (c.y / c.w * 0.5 + 0.5)) * 720 });
      }
      if (ends.length !== 2) continue;
      const x0 = Math.min(ends[0].x, ends[1].x), x1 = Math.max(ends[0].x, ends[1].x);
      if (x1 < 0 || x0 > 1280 || ends[0].y < -40 || ends[0].y > 760) continue;
      const face = Math.floor(mod1((uv.getX(b) + uv.getX(b + 1)) * 0.5) * 8) % 8;
      cells.push({ x0, x1, face });
    }
    cells.sort((a, b2) => a.x0 - b2.x0);
    const slots = [];
    for (const c of cells) {
      const last = slots[slots.length - 1];
      if (last && last.face === c.face && c.x0 - last.x1 < 4) { last.x1 = Math.max(last.x1, c.x1); continue; }
      slots.push({ face: c.face, x0: c.x0, x1: c.x1 });
    }
    return {
      cam: cam.position.toArray().map((x) => +x.toFixed(1)),
      slots: slots.filter((s) => s.x1 - s.x0 >= 6).map((s) => ({ f: s.face, x: [Math.round(s.x0), Math.round(s.x1)] })),
    };
  }));
}

const report = frames.map((fr, i) => {
  if (!fr) return { frame: i, error: 'no club-boards' };
  const count = new Map();
  for (const s of fr.slots) {
    if (!count.has(s.f)) count.set(s.f, []);
    count.get(s.f).push(s.x);
  }
  const dupes = [...count.entries()].filter(([, xs]) => xs.length > 1)
    .map(([f, xs]) => `${FACES[f]}×${xs.length} @ ${xs.map((x) => x[0]).join(',')}`);
  return {
    frame: i, cam: fr.cam, slots: fr.slots.length, distinct: count.size, dupes,
    order: fr.slots.map((s) => `${FACES[s.f]}@${s.x[0]}-${s.x[1]}`),
  };
});

for (const r of report) {
  if (r.error) { console.log(`frame ${r.frame}: ${r.error}`); continue; }
  console.log(`frame ${r.frame} cam ${JSON.stringify(r.cam)}`);
  console.log(`  visible board faces ${r.slots}  distinct ${r.distinct}  `
    + `dupes: ${r.dupes.length ? r.dupes.join(' | ') : 'none'}`);
  console.log(`  ${r.order.join('  ')}`);
}
if (worst) {
  console.log(`\nring-wide closest repeat of one face: ${worst.d.toFixed(1)} m  (${FACES[worst.face]})`);
} else if (ring) {
  console.log('\nring-wide: no face appears twice anywhere on the ring');
}
if (problems.length) console.log('problems:', [...new Set(problems)].slice(0, 8));
writeFileSync(OUT, JSON.stringify({ quality: QUALITY, worst, report, problems }, null, 2));
console.log(`-> ${OUT}`);

await browser.close();
if (child) child.kill('SIGTERM');
process.exit(0);
