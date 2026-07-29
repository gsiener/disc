#!/usr/bin/env node
/**
 * Blind A/B compositor.
 *
 *   node tools/compare.mjs shots/r1/broadcast.png shots/r2/broadcast.png --out cmp/bc
 *
 * Writes `<out>.png` — the two frames side by side, labelled only A and B in a
 * randomised order — and `<out>.key.json`, which records which side is which.
 * A critic is shown the PNG and never the key, so its preference is genuinely
 * blind; the key is read afterwards to score the round.
 *
 * Rendering is done by the Chrome we already drive for screenshots, so this
 * pulls in no image library.
 *
 * `--grid` instead tiles many images into a labelled contact sheet, which is how
 * a reviewer looks at a whole round at once.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, basename } from 'node:path';

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const has = (n) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
};

const OUT = flag('out', 'cmp/out');
const GRID = has('grid');
const SEED = Number(flag('seed', 1));
const WIDTH = Number(flag('w', 2400));
const inputs = argv.filter((a) => !a.startsWith('--'));

if (inputs.length < 2) {
  console.error('usage: compare.mjs <a.png> <b.png> [--out cmp/name] [--seed N]');
  console.error('       compare.mjs --grid <a.png> <b.png> ... [--out cmp/sheet]');
  process.exit(2);
}
for (const f of inputs) {
  if (!existsSync(f)) { console.error(`missing: ${f}`); process.exit(2); }
}

const dataUri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

/** Deterministic coin flip so a given seed always yields the same A/B ordering. */
function flip(seed) {
  let h = (seed * 374761393) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296) < 0.5;
}

if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });

let html, key;

if (GRID) {
  const cols = Math.ceil(Math.sqrt(inputs.length));
  html = `<style>
    body{margin:0;background:#0b0d10;font:600 20px/1.2 ui-sans-serif,system-ui;color:#dfe8f5}
    .g{display:grid;grid-template-columns:repeat(${cols},1fr);gap:10px;padding:10px}
    figure{margin:0;position:relative}
    img{width:100%;display:block;border-radius:4px}
    figcaption{position:absolute;left:10px;top:10px;background:#000a;padding:4px 10px;
      border-radius:3px;letter-spacing:.1em;text-transform:uppercase;font-size:16px}
  </style><div class="g">${inputs.map((p) => `
    <figure><img src="${dataUri(p)}"><figcaption>${basename(p, '.png')}</figcaption></figure>`).join('')}</div>`;
  key = { mode: 'grid', inputs };
} else {
  const [x, y] = inputs;
  const swap = flip(SEED);
  const left = swap ? y : x;
  const right = swap ? x : y;
  html = `<style>
    body{margin:0;background:#0b0d10;font:700 28px/1 ui-sans-serif,system-ui;color:#dfe8f5}
    .r{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px}
    figure{margin:0;position:relative}
    img{width:100%;display:block;border-radius:4px}
    figcaption{position:absolute;left:16px;top:16px;background:#000c;padding:8px 18px;
      border-radius:4px;letter-spacing:.22em}
  </style><div class="r">
    <figure><img src="${dataUri(left)}"><figcaption>A</figcaption></figure>
    <figure><img src="${dataUri(right)}"><figcaption>B</figcaption></figure>
  </div>`;
  key = { mode: 'ab', A: left, B: right, seed: SEED };
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1'],
  defaultViewport: { width: WIDTH, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => Promise.all(
  Array.from(document.images).map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })),
));
const box = await page.evaluate(() => {
  const d = document.querySelector('.r, .g');
  const r = d.getBoundingClientRect();
  return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
});
await page.setViewport({ width: WIDTH, height: box.h, deviceScaleFactor: 1 });
await page.screenshot({ path: `${OUT}.png`, type: 'png' });
await browser.close();

writeFileSync(`${OUT}.key.json`, JSON.stringify(key, null, 2));
console.log(`${OUT}.png`);
console.log(`${OUT}.key.json  (do not show this to the critic)`);
