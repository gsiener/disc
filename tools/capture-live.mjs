#!/usr/bin/env node
/**
 * LIVE PLAY capture — photographs the tele camera doing its job.
 *
 *   node tools/capture-live.mjs                    # 8 frames, 2.5 s apart
 *   node tools/capture-live.mjs --n 12 --gap 1.5
 *   node tools/capture-live.mjs --q high --out shots/live
 *   node tools/capture-live.mjs --ai-only 0         # opt out, see below
 *
 * The controlled body is AI-driven by default (`--ai-only`, on unless you pass
 * `--ai-only 0`) — this rig never publishes input for him, so left to his own
 * devices during LIVE_POSSESSION he is a statue holding the disc for the whole
 * stall count while everyone else plays around him (issue #52). `Game.ts`
 * already hands an idle controlled player back to his own AI; this flag makes
 * that a guarantee from frame zero rather than a side effect of the default
 * warm-up outlasting the idle timeout.
 *
 * Every other rig in this repo stages a *pinned* shot: `Shots.ts` hard-pins the
 * camera to a fixed pos/target and the director stands down. That is the right
 * way to photograph a material or a piece of geometry, and it is exactly the
 * wrong way to photograph a camera — a pinned frame cannot show framing,
 * because the framing is the thing being overridden.
 *
 * So this rig does the opposite: it calls `director.unpin()`, lets the match
 * play, and takes a frame every `--gap` seconds of simulated time. Whatever is
 * in these PNGs is what a player would actually see.
 *
 * Deterministic like the others: the sim is advanced in exact fixed steps, so
 * the same seed yields the same frames and a pixel change means a code change.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

const PORT = Number(process.env.PORT ?? await freePort());
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
const OUT = flag('out', 'shots/live');
const QUALITY = flag('q', 'high');
const N = Number(flag('n', 8));
const GAP = Number(flag('gap', 2.5));
const WARM = Number(flag('warm', 3));
/**
 * On by default, because this rig never publishes any input for the
 * controlled player — see .agents/friction-log/20260805213329-capture-live-mjs/
 * (issue #52) — and there is no live human anywhere in a headless capture for
 * him to represent. `Game.liveHumanIntent` already reads an unfed controlled
 * player as idle and hands him to his own AI (`humanIdle > 0.4`, Game.ts)
 * well before the first frame is ever captured given the default 3 s warm-up,
 * so under default flags `--ai-only` does not change the frames this rig
 * produces — it turns that outcome from a side effect of timing into a
 * guarantee, by forcing `humanIdle` high before ANY frame is taken. That
 * matters for `--warm 0` or a `--gap` under 0.4 s, where the built-in idle
 * timeout would otherwise have a real, if narrow, window to catch the
 * controlled body mid-handoff. Pass `--ai-only 0` to opt back out.
 */
const AI_ONLY = flag('ai-only', '1') !== '0';

/**
 * A third of a second, before three minutes of Chrome.
 *
 * A syntax error in ANY file under `src/` — very often a peer agent's, mid-save,
 * in a file this rig does not import — stops vite completing the module graph,
 * so `window.__READY__` never flips and the wait below dies at 180 s with a
 * `TimeoutError` pointing at this file rather than at the broken one. Logged
 * three times (`20260805193950`, `20260805220550`, `20260805221042`). The gate
 * asks the same question with vite's own parser and names the file and line.
 */
const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gate.mjs');
const gate = spawnSync(process.execPath, [GATE, '--quiet'], { stdio: 'inherit' });
if (gate.status !== 0) {
  console.error('\ncapture aborted before launching Chrome. This is the 0.3 s version of');
  console.error('the 180 s TimeoutError you would otherwise have paid for the same fault.');
  process.exit(gate.status ?? 1);
}

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

await ensureServer();
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--headless=new', '--use-angle=metal', '--enable-gpu',
    '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-zero-copy',
    '--disable-gpu-sandbox', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=1', `--window-size=${W},${H}`,
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
  console.warn('!! Software rasteriser — frames will not reflect real GPU output.');
}

/**
 * Two things hold a capture-mode page still, and both have to be released.
 *
 * The camera is pinned: `main.ts` applies a named shot at boot and the director
 * stands down for it. And the MATCH is posed — `applyShot` sets `game.posed`,
 * and `Game.update` only counts `poseHold` down when `ctx.capture` is false, so
 * in the rig a tableau is held forever by design. That is right for
 * photographing a material and fatal for photographing a camera: leave it set
 * and this tool silently produces N identical frames of a frozen pose, which
 * is precisely the failure it exists to catch.
 */
const released = await page.evaluate((aiOnly) => {
  const ctx = window.__ENGINE__?.ctx;
  const dir = ctx?.sys?.['camera'];
  const game = ctx?.sys?.['game'];
  if (!dir || typeof dir.unpin !== 'function' || !game) return null;
  dir.unpin();
  game.posed = false;
  // See .agents/friction-log/20260805213329-capture-live-mjs/ (issue #52):
  // this rig publishes no input, so the controlled body has nothing driving
  // it. `Game.ts` already hands an idle controlled player back to his own AI
  // (`humanIdle > 0.4`) — forcing the counter high here just makes that
  // guaranteed from frame zero instead of arriving ~0.4 simulated seconds in.
  if (aiOnly && typeof game.humanIdle === 'number') game.humanIdle = 999;
  return { pinned: dir.isPinned, posed: game.posed, humanIdle: game.humanIdle };
}, AI_ONLY);
if (!released || released.pinned || released.posed) {
  console.error('Could not release the page for live play:', released);
  await browser.close();
  if (child) child.kill('SIGTERM');
  process.exit(2);
}
console.log(AI_ONLY
  ? `--ai-only: the controlled body is AI-driven for this capture (humanIdle=${released.humanIdle}).`
  : '--ai-only 0: the controlled body follows the rig\'s (nonexistent) input, same as before #52.');

await page.evaluate((s) => window.__RIG__.advance(Math.round(s * 120), 1 / 120), WARM);

const rows = [];
for (let i = 0; i < N; i++) {
  const tel = await page.evaluate((s) => {
    window.__RIG__.advance(Math.round(s * 120), 1 / 120);
    window.__RIG__.render();
    const ctx = window.__ENGINE__.ctx;
    const dir = ctx.sys['camera'];
    const game = ctx.sys['game'];
    const cam = ctx.camera;
    // Positions, not just camera state: a rig that reports a plausible camera
    // over a world that is not moving looks exactly like a working rig, and
    // that is the failure this tool exists to make impossible to miss.
    const r0 = game?.roster?.[0]?.loco?.pos;
    return {
      shot: dir?.telemetry?.shot ?? '?',
      phase: game?.gs?.phase ?? '?',
      score: game?.gs?.score ? game.gs.score.join('-') : '?',
      simT: +(game?.simT ?? 0).toFixed(2),
      disc: game?.gs?.discPos
        ? [+game.gs.discPos.x.toFixed(2), +game.gs.discPos.z.toFixed(2)] : null,
      p0: r0 ? [+r0.x.toFixed(2), +r0.z.toFixed(2)] : null,
      fov: +cam.fov.toFixed(1),
      pos: [cam.position.x, cam.position.y, cam.position.z].map((v) => +v.toFixed(1)),
    };
  }, GAP);
  const file = `${OUT}/live-${String(i).padStart(2, '0')}.png`;
  await page.screenshot({ path: file, type: 'png', captureBeyondViewport: false });
  rows.push({ file, t: +(WARM + (i + 1) * GAP).toFixed(1), ...tel });
  console.log(`  t=${String(rows[i].t).padStart(5)}s  ${tel.shot.padEnd(12)} `
    + `${tel.phase.padEnd(16)} fov ${String(tel.fov).padStart(4)}  `
    + `camz ${String(tel.pos[2]).padStart(6)}  disc ${JSON.stringify(tel.disc)}  `
    + `p0 ${JSON.stringify(tel.p0)}  ${tel.score}`);
}

/**
 * A frame series where nothing moved is the one result this tool must never
 * report as success — it is indistinguishable from a working rig by eye, and
 * it is what the first version of this tool actually did.
 */
const moved = rows.some((r, i) => i > 0 && (
  r.simT !== rows[i - 1].simT
  && (JSON.stringify(r.disc) !== JSON.stringify(rows[i - 1].disc)
    || JSON.stringify(r.p0) !== JSON.stringify(rows[i - 1].p0))));
if (!moved) {
  console.error('\n!! FROZEN — the world did not advance between frames.');
  console.error('   These PNGs are not evidence of anything. Do not review them.');
}

writeFileSync(`${OUT}/_live.json`, JSON.stringify({ gpu, W, H, QUALITY, rows, problems }, null, 2));

if (problems.length) {
  console.log(`\n${problems.length} console problem(s):`);
  for (const p of [...new Set(problems)].slice(0, 20)) console.log('  ' + p);
}

await browser.close();
if (child) child.kill('SIGTERM');
process.exit(0);
