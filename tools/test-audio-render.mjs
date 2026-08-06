#!/usr/bin/env node
/**
 * tools/test-audio-render.mjs — does the mix actually follow the match?
 *
 *   node tools/test-audio-render.mjs            run everything
 *   node tools/test-audio-render.mjs --verbose  also print the dB envelopes
 *
 * `tools/test-audio.ts` proves the graph is legal and that the right automation
 * was written to the right AudioParams. It runs against a fake context, so what
 * it can assert is one step short of sound: it evaluates the recorded curves
 * back into an envelope using the spec's own semantics and compares windows of
 * that. Everything it says is true of the *instructions* the code issued.
 *
 * This file closes the last step. It drives the identical scripted point through
 * a real Chrome `OfflineAudioContext` — the same convolver, the same biquads,
 * the same automation engine that ships to a player — renders it to PCM, and
 * asserts on the samples. If a bed gets disconnected, if a filter eats the roar,
 * if the limiter squashes the block down to the level of a catch, the fake test
 * still passes and this one does not.
 *
 * ---------------------------------------------------------------- how it runs
 *
 * The page is loaded with `?capture=1`, which is the one configuration where
 * nothing else is moving: `Engine.start()` is never called, so no rAF loop is
 * mutating the disc or the players behind the script, and `AudioSystem.init`
 * returns before it arms its gesture listeners — but *after* it has wired the
 * event bus. So the subscriptions under test are the real ones, and the world
 * they read is entirely ours to pose.
 *
 * Two traps, both learned by measuring the wrong thing first:
 *
 *  1. THE STARTUP RAMP IS NOT THE MATCH. A freshly built graph opens its master
 *     at -80 dB and ramps in over tau = 1.4 s while every bed glides up from
 *     silence. Render from t = 0 and the first four seconds are monotonic no
 *     matter what happens in the game, which makes "louder after the goal than
 *     at the start" a tautology. So the master is snapped to its final value and
 *     six virtual seconds are driven before the measured window opens.
 *
 *  2. THE FIELD STEM CONFOUNDS THE CROWD. The disc's own flight noise is loudest
 *     exactly when the crowd is swelling, so "the crowd builds during the throw"
 *     measured off the master is partly the disc. Every crowd claim below is
 *     therefore taken from a second render of the same script with the field and
 *     ambience stems muted, and the full mix is used only for what it is the
 *     authority on: headroom, and whether the shape survives the limiter.
 *
 *  3. REAPING IS FATAL OFFLINE. `AudioGraph.reap()` disconnects a finished
 *     voice's nodes the moment `end <= now`, which is correct in real time
 *     because the audio thread has already rendered them, and catastrophic
 *     against a virtual clock: nothing is rendered until `startRendering()`, so
 *     every transient in the game is deleted before it makes a sample. Measured,
 *     that is the difference between a footstep at -113 dBFS and one at -41.
 *     `reap` is therefore replaced for the render with a version that evicts
 *     from the pool without disconnecting — `claim()` still behaves, the voices
 *     still stop on their own schedule, and they exist when the buffer is drawn.
 */

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/* --------------------------------------------------------------- assertions */

const failures = [];
let count = 0;
const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

function ok(cond, label, detail = '') {
  count++;
  if (cond) console.log(`  ${C.g}✓${C.x} ${label}${detail ? `  ${C.d}${detail}${C.x}` : ''}`);
  else {
    failures.push(label);
    console.log(`  ${C.r}✗ ${label}${C.x}${detail ? `  ${detail}` : ''}`);
  }
}
function section(name) { console.log(`\n${C.b}── ${name}${C.x}`); }
const db = (v) => (20 * Math.log10(Math.max(1e-9, v))).toFixed(1);

/* ------------------------------------------------------------------ harness */

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
  try { const r = await fetch(ORIGIN, { signal: AbortSignal.timeout(1200) }); return r.ok; }
  catch { return false; }
}

let child = null;
if (!(await serverUp())) {
  child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  for (let i = 0; i < 60; i++) { await sleep(500); if (await serverUp()) break; }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--no-sandbox', '--disable-gpu-sandbox', '--hide-scrollbars', '--window-size=1280,720',
  ],
  defaultViewport: { width: 1280, height: 720 },
  protocolTimeout: 420_000,
});

const page = await browser.newPage();

// A render is ~90 s of wall clock. Any peer agent saving any file under src/ in
// that window makes vite full-reload the page, which destroys the execution
// context mid-evaluate and kills the run with a navigation error that says
// nothing about audio. The HMR client is the only thing that listens for that,
// and the page does not need it — so it never arrives.
await page.setRequestInterception(true);
page.on('request', (r) => {
  if (r.url().includes('/@vite/client')) r.abort().catch(() => {});
  else r.continue().catch(() => {});
});

const problems = [];
// The blocked HMR client above surfaces as a console error; it is this file's
// own doing and reporting it as a page problem is noise.
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_FAILED|@vite\/client/.test(m.text())) problems.push(m.text());
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

// `capture=1` is the quiescent configuration: no rAF loop, no gesture arming,
// but the audio system's event subscriptions are already in place.
await page.goto(`${ORIGIN}/?capture=1&q=high&settle=8`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction('window.__READY__ === true', { timeout: 240_000 });

/* ------------------------------------------------------------- the in-page rig
 *
 * Installed once; each render is a call into it. Kept as a single string so the
 * script, the clock virtualisation and the PCM analysis all live together and a
 * change to the timeline cannot drift between passes. */

await page.evaluate(() => {
  const ctx = window.__ENGINE__.ctx;

  /**
   * Emit on the real bus, but insulate each subscriber from its neighbours.
   * The audio system subscribes at order 12, so it is late in the handler set:
   * one peer throwing on a synthetic payload would otherwise swallow the event
   * before audio ever saw it, and the whole run would measure silence for a
   * reason that has nothing to do with audio. Peer failures are collected and
   * reported rather than hidden.
   */
  const peerErrors = [];
  const emit = (evt, payload) => {
    const set = ctx.events.map?.get(evt);
    if (!set) { ctx.events.emit(evt, payload); return; }
    for (const fn of set) {
      try { fn(payload); } catch (e) { peerErrors.push(`${evt}: ${e && e.message}`); }
    }
  };

  /* ------------------------------------------------------------ measurement */

  /**
   * Per-window RMS, plus a two-band split and a zero-crossing rate.
   *
   * Level alone cannot tell a groan from a cheer — they are the same murmur PCM
   * at 0.70x and 1.52x and they can sit at the same meter reading. Brightness
   * can, and it is the thing the ear is actually using. `bright` is the ratio of
   * energy above ~1.2 kHz to energy below ~300 Hz, both from cascaded one-poles,
   * and `zcr` is the cheap corroborating statistic.
   */
  function analyse(buf, win) {
    const SR = buf.sampleRate;
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const n = L.length;
    const aLo = 1 - Math.exp(-2 * Math.PI * 300 / SR);
    const aHi = 1 - Math.exp(-2 * Math.PI * 1200 / SR);
    let l1 = 0, l2 = 0, h1 = 0, h2 = 0, prev = 0;
    const step = Math.round(win * SR);
    const rms = []; const lo = []; const hi = []; const zc = []; const pk = [];
    let s = 0, sl = 0, sh = 0, z = 0, p = 0, k = 0;
    let nonFinite = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const x = (L[i] + R[i]) * 0.5;
      if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) nonFinite++;
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (a > peak) peak = a;
      if (a > p) p = a;
      l1 += (x - l1) * aLo; l2 += (l1 - l2) * aLo;
      h1 += (x - h1) * aHi; h2 += (h1 - h2) * aHi;
      const hx = x - h2;
      s += x * x; sl += l2 * l2; sh += hx * hx;
      if ((x >= 0) !== (prev >= 0)) z++;
      prev = x;
      if (++k === step) {
        rms.push(Math.sqrt(s / k)); lo.push(Math.sqrt(sl / k)); hi.push(Math.sqrt(sh / k));
        zc.push(z / k * SR * 0.5); pk.push(p);
        s = 0; sl = 0; sh = 0; z = 0; p = 0; k = 0;
      }
    }
    return { rms, lo, hi, zcr: zc, pk, peak, nonFinite, win, seconds: n / SR };
  }

  /* ------------------------------------------------------------------ script
   *
   * One point, 20 s, identical in shape to `scriptedPoint()` in
   * tools/test-audio.ts so a disagreement between the two harnesses is a real
   * disagreement and not two different matches.
   *
   *   0.00  live possession, disc held
   *   0.25→2.25  the stall count climbs 1→9
   *   3.00  a 26 m/s huck                  4.50  taken on the run
   *   6.00  a throwaway                    7.60  it lands, nobody near it
   *   9.00  a swing                        9.90  blocked
   *  13.50  a layout bid                  13.90  the landing
   *  16.00  the goal
   */
  const T = {
    stall0: 0.25, stallStep: 0.25, stallN: 9,
    huck: 3.0, huckLand: 4.5,
    away: 6.0, awayLand: 7.6,
    swing: 9.0, bid: 9.70, block: 9.9, bidLand: 10.05,
    layout: 13.5, layoutLand: 13.9,
    goal: 16.0,
    dur: 20,
  };

  window.__T__ = T;

  window.__renderPoint__ = async (opts) => {
    const sys = ctx.sys.audio;
    const SR = 48000;
    const SETTLE = 6;
    const DUR = T.dur;
    const dt = 1 / 60;
    peerErrors.length = 0;

    // Tear down whatever graph exists WITHOUT dispose(): dispose also drops the
    // event subscriptions, and those are wired in init() and never rebuilt.
    sys.graph = null; sys.crowd = null; sys.ambience = null;
    sys.flight = null; sys.body = null; sys.drama = null;
    sys.running = false; sys.available = false;

    const oac = new OfflineAudioContext(2, Math.ceil(SR * (SETTLE + DUR + 0.5)), SR);
    sys.opts = { createContext: () => oac, volume: 0.85 };
    if (!sys.start()) return { error: 'offline start() refused' };

    let vt = 0;
    Object.defineProperty(sys.graph, 'now', { get: () => vt, configurable: true });
    // Trap 3: evict finished voices from the pool without tearing them out of
    // the graph, so `claim()` still budgets correctly and the render still has
    // something to draw. See the header.
    sys.graph.reap = function (now) {
      for (let i = this.voices.length - 1; i >= 0; i--) {
        if (this.voices[i].end <= now) this.voices.splice(i, 1);
      }
    };
    // Trap 1: no 1.4 s fade-in inside the measured window.
    sys.graph.setMaster(0.85, 0.001);
    // Trap 2: mute the stems this pass is not the authority on.
    for (const [stem, v] of Object.entries(opts.stems ?? {})) {
      sys.graph[stem].gain.cancelScheduledValues(0);
      sys.graph[stem].gain.setValueAtTime(v, 0);
    }

    // A broadcast sideline position, so crowd proximity is 1 and the disc has
    // something to fly past.
    ctx.camera.position.set(0, 11, 46);
    ctx.camera.lookAt(0, 1.2, 0);
    ctx.camera.updateMatrixWorld(true);

    const disc = ctx.sys.disc?.rt ?? ctx.sys.game?.discRuntime;
    const players = ctx.sys.locomotion?.players ?? [];
    const gs = ctx.sys.game?.gs;

    // Park the roster off the map so the anticipation model's closing distance
    // is a quantity the script owns, then nominate a receiver and a defender.
    for (const p of players) { p.pos = { x: 300, y: 0.95, z: 300 }; p.state = 'run'; }
    const rx = players[1] ?? { id: 1, pos: { x: 0, y: 0, z: 0 }, state: 'run' };
    const df = players[2] ?? { id: 2, pos: { x: 0, y: 0, z: 0 }, state: 'run' };
    rx.pos = { x: 5, y: 0.95, z: -20 };

    const setDisc = (x, y, z, vx, vy, vz, flight) => {
      if (!disc) return;
      disc.state.pos = { x, y, z };
      disc.state.vel = { x: vx, y: vy, z: vz };
      disc.state.groundY = 0;
      disc.state.atRest = !flight;
      disc.state.airspeed = flight ? Math.hypot(vx, vy, vz) : 0;
      disc.state.spin = flight ? -46 : 0;
      disc.mode = flight ? 'flight' : 'held';
    };

    setDisc(0, 1.3, 10, 0, 0, 0, false);
    if (gs) { gs.phase = 'LIVE_POSSESSION'; gs.stallCount = 0; }
    emit('state:changed', { to: 'LIVE_POSSESSION', from: 'CHECK' });

    /* settle — beds up to resting level before anything is compared */
    const settleFrames = Math.round(SETTLE / dt);
    for (let i = 0; i < settleFrames; i++) { vt = i * dt; sys.lateUpdate(dt, ctx); }
    const T0 = SETTLE;

    let leg = null;
    const marks = [];
    const probe = [];
    const N = Math.round(DUR / dt);
    for (let i = 0; i < N; i++) {
      const t = i * dt;
      vt = T0 + t;
      const at = (s) => Math.abs(t - s) < dt * 0.5;

      for (let c = 1; c <= T.stallN; c++) {
        if (at(T.stall0 + (c - 1) * T.stallStep)) {
          if (gs) gs.stallCount = c;
          emit('stall:tick', { count: c, max: 10, playerId: 3, team: 0, markerId: 2 });
        }
      }

      if (at(T.huck)) {
        if (gs) gs.stallCount = 0;
        emit('disc:released', {
          pos: { x: 0, y: 1.3, z: 10 }, vel: { x: 3.3, y: 1.2, z: -20 },
          spin: 52, throwType: 'backhand', playerId: 3, team: 0, stall: 9,
        });
        if (gs) gs.phase = 'DISC_IN_FLIGHT';
        emit('state:changed', { to: 'DISC_IN_FLIGHT', from: 'LIVE_POSSESSION' });
        leg = { x0: 0, y0: 1.3, z0: 10, x1: 5, y1: 1.8, z1: -20, t0: T.huck, secs: 1.5 };
        marks.push(['huck', t]);
      }
      if (at(T.huckLand)) {
        leg = null;
        setDisc(5, 1.8, -20, 0, 0, 0, false);
        emit('disc:caught', { playerId: rx.id, pos: { x: 5, y: 1.8, z: -20 }, team: 0, outcome: 'completion' });
        if (gs) gs.phase = 'LIVE_POSSESSION';
        emit('state:changed', { to: 'LIVE_POSSESSION', from: 'DISC_IN_FLIGHT' });
        marks.push(['catch', t]);
      }

      if (at(T.away)) {
        emit('disc:released', {
          pos: { x: 5, y: 1.5, z: -20 }, vel: { x: -10, y: 1.0, z: 12 },
          spin: 40, throwType: 'forehand', playerId: rx.id, team: 0, stall: 2,
        });
        if (gs) gs.phase = 'DISC_IN_FLIGHT';
        emit('state:changed', { to: 'DISC_IN_FLIGHT', from: 'LIVE_POSSESSION' });
        leg = { x0: 5, y0: 1.5, z0: -20, x1: -18, y1: 0.05, z1: 8, t0: T.away, secs: 1.6 };
        marks.push(['throwaway', t]);
      }
      if (at(T.awayLand)) {
        leg = null;
        setDisc(-18, 0.05, 8, 0, 0, 0, false);
        emit('disc:grounded', { pos: { x: -18, y: 0.05, z: 8 }, reason: 'throwaway' });
        emit('turnover', { reason: 'throwaway', from: 0, to: 1, playerId: rx.id, pos: { x: -18, y: 0.05, z: 8 } });
        if (gs) gs.phase = 'TURNOVER_DEAD';
        emit('state:changed', { to: 'TURNOVER_DEAD', from: 'DISC_IN_FLIGHT' });
        marks.push(['ground', t]);
      }

      if (at(T.swing)) {
        if (gs) gs.phase = 'LIVE_POSSESSION';
        emit('state:changed', { to: 'LIVE_POSSESSION', from: 'TURNOVER_DEAD' });
        emit('disc:released', {
          pos: { x: -18, y: 1.4, z: 8 }, vel: { x: 9, y: 0.6, z: 8 },
          spin: 38, throwType: 'backhand', playerId: 9, team: 1, stall: 1,
        });
        if (gs) gs.phase = 'DISC_IN_FLIGHT';
        emit('state:changed', { to: 'DISC_IN_FLIGHT', from: 'LIVE_POSSESSION' });
        leg = { x0: -18, y0: 1.4, z0: 8, x1: -10, y1: 1.2, z1: 15, t0: T.swing, secs: 0.9 };
        df.pos = { x: -10, y: 0.95, z: 15 };
        marks.push(['swing', t]);
      }
      // A bid that pays off: the body leaves the ground, the block happens
      // inside the bid window, and the landing is the full stop.
      if (at(T.bid)) { df.state = 'layout'; marks.push(['bid', t]); }
      if (at(T.block)) {
        leg = null;
        setDisc(-10, 0.05, 15, 0, 0, 0, false);
        emit('disc:grounded', { pos: { x: -10, y: 0.05, z: 15 }, reason: 'block' });
        emit('turnover', { reason: 'block', from: 1, to: 0, playerId: df.id, pos: { x: -10, y: 0.05, z: 15 } });
        if (gs) gs.phase = 'TURNOVER_DEAD';
        emit('state:changed', { to: 'TURNOVER_DEAD', from: 'DISC_IN_FLIGHT' });
        marks.push(['BLOCK', t]);
      }
      if (at(T.bidLand)) {
        df.state = 'landing';
        emit('player:land', { id: df.id, pos: { x: -10, y: 0.1, z: 15 }, impact: 8.6, layout: true });
      }
      if (at(T.bidLand + 0.7)) df.state = 'run';

      // And one that does not: a full-length dive at a disc that was never
      // there. Same body, same landing, no outcome.
      if (at(T.layout)) { df.state = 'layout'; marks.push(['empty bid', t]); }
      if (at(T.layoutLand)) {
        df.state = 'landing';
        emit('player:land', { id: df.id, pos: { x: -10, y: 0.1, z: 15 }, impact: 8.2, layout: true });
      }
      if (at(T.layoutLand + 0.7)) df.state = 'run';

      if (at(T.goal)) {
        emit('score', { team: 0, playerId: 4, assistId: 3, score: [1, 0], point: 1 });
        if (gs) gs.phase = 'POINT_SCORED';
        emit('state:changed', { to: 'POINT_SCORED', from: 'DISC_IN_FLIGHT' });
        marks.push(['GOAL', t]);
      }

      // Feet. A point is not played in silence by fourteen people, and the
      // field/crowd balance is only a real question with the field occupied.
      if (i % 11 === 0) {
        const n = (i / 11) | 0;
        emit('player:footstep', {
          id: n % 7,
          pos: { x: -14 + (n % 9) * 3.5, y: 0.02, z: -12 + ((n * 7) % 21) },
          foot: n % 2 ? 'L' : 'R', speed: 6.5, hard: n % 3 === 0,
        });
      }

      if (leg) {
        const k = Math.min(1, (t - leg.t0) / leg.secs);
        setDisc(
          leg.x0 + (leg.x1 - leg.x0) * k,
          leg.y0 + (leg.y1 - leg.y0) * k,
          leg.z0 + (leg.z1 - leg.z0) * k,
          (leg.x1 - leg.x0) / leg.secs, (leg.y1 - leg.y0) / leg.secs, (leg.z1 - leg.z0) / leg.secs,
          true,
        );
      }

      ctx.frame++;
      ctx.time += dt;
      sys.lateUpdate(dt, ctx);

      // A cheap witness that the model itself moved, so a flat render can be
      // told apart from a flat model.
      if (i % 6 === 0) {
        const d = sys.drama ? sys.drama.debug() : null;
        const c = sys.crowd ? sys.crowd.debug() : null;
        probe.push([+t.toFixed(3), c ? +c.roar.toFixed(4) : 0, c ? +c.val.toFixed(3) : 0,
          d ? +d.antic.toFixed(4) : 0, d ? +d.hush.toFixed(4) : 0, d ? +d.chat.toFixed(3) : 0]);
      }
    }

    const buf = await oac.startRendering();
    const a = analyse(buf, 0.05);
    // Drop the settle region — the measured window starts at the point's t = 0.
    const skip = Math.round(T0 / a.win);
    for (const k of ['rms', 'lo', 'hi', 'zcr', 'pk']) a[k] = a[k].slice(skip);
    a.marks = marks;
    a.probe = probe;
    a.peerErrors = [...new Set(peerErrors)];
    return a;
  };

  /**
   * A separate, much shorter render: one disc crossing the camera at 24 m/s.
   * The claim under test is not a level, it is a pitch — the flight band and the
   * rotational flutter shift up on the approach and down on the departure — and
   * the only honest way to see that in PCM is a spectral statistic, so the
   * zero-crossing rate of the field stem is measured on each side of the pass.
   */
  window.__renderFlypast__ = async () => {
    const sys = ctx.sys.audio;
    const SR = 48000;
    const SETTLE = 1.5;
    const DUR = 4.0;
    const dt = 1 / 120;

    sys.graph = null; sys.crowd = null; sys.ambience = null;
    sys.flight = null; sys.body = null; sys.drama = null;
    sys.running = false; sys.available = false;
    const oac = new OfflineAudioContext(2, Math.ceil(SR * (SETTLE + DUR + 0.2)), SR);
    sys.opts = { createContext: () => oac, volume: 0.85 };
    if (!sys.start()) return { error: 'offline start() refused' };
    let vt = 0;
    Object.defineProperty(sys.graph, 'now', { get: () => vt, configurable: true });
    // Trap 3: evict finished voices from the pool without tearing them out of
    // the graph, so `claim()` still budgets correctly and the render still has
    // something to draw. See the header.
    sys.graph.reap = function (now) {
      for (let i = this.voices.length - 1; i >= 0; i--) {
        if (this.voices[i].end <= now) this.voices.splice(i, 1);
      }
    };
    sys.graph.setMaster(0.85, 0.001);
    // Field stem only: the disc is the entire subject.
    for (const stem of ['crowd', 'amb']) {
      sys.graph[stem].gain.cancelScheduledValues(0);
      sys.graph[stem].gain.setValueAtTime(0, 0);
    }

    ctx.camera.position.set(0, 2.0, 0);
    ctx.camera.lookAt(0, 2.0, -10);
    ctx.camera.updateMatrixWorld(true);

    const disc = ctx.sys.disc?.rt ?? ctx.sys.game?.discRuntime;
    for (const p of (ctx.sys.locomotion?.players ?? [])) { p.pos = { x: 300, y: 0.95, z: 300 }; p.state = 'run'; }
    if (ctx.sys.game?.gs) ctx.sys.game.gs.phase = 'DISC_IN_FLIGHT';

    for (let i = 0; i < Math.round(SETTLE / dt); i++) { vt = i * dt; sys.lateUpdate(dt, ctx); }

    // Straight past the camera at x = +6 m, from z = -48 to z = +48 at 24 m/s.
    const V = 24;
    const N = Math.round(DUR / dt);
    for (let i = 0; i < N; i++) {
      const t = i * dt;
      vt = SETTLE + t;
      const z = -48 + V * t;
      disc.state.pos = { x: 6, y: 2.0, z };
      disc.state.vel = { x: 0, y: 0, z: V };
      disc.state.groundY = 0;
      disc.state.atRest = false;
      disc.state.airspeed = V;
      disc.state.spin = -52;
      disc.mode = 'flight';
      ctx.time += dt;
      sys.lateUpdate(dt, ctx);
    }

    const buf = await oac.startRendering();
    const SRb = buf.sampleRate;
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    // The camera sits at z = 0; the disc reaches it at t = 2.0 s of the drive.
    const band = (t0, t1) => {
      const i0 = Math.round((SETTLE + t0) * SRb);
      const i1 = Math.round((SETTLE + t1) * SRb);
      let z = 0; let prev = 0; let s = 0;
      for (let i = i0; i < i1; i++) {
        const x = (L[i] + R[i]) * 0.5;
        s += x * x;
        if ((x >= 0) !== (prev >= 0)) z++;
        prev = x;
      }
      const n = Math.max(1, i1 - i0);
      return { zcr: z / n * SRb * 0.5, rms: Math.sqrt(s / n) };
    };
    let peak = 0;
    for (let i = 0; i < L.length; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (a > peak) peak = a;
    }
    return {
      closing: band(0.9, 1.6),      // 26 m out and coming
      receding: band(2.4, 3.1),     // 26 m out and going
      atPass: band(1.9, 2.1),
      quiet: band(0.05, 0.25),
      peak,
    };
  };
});

/* ------------------------------------------------------------------- passes */

console.log(`${C.b}================================================================${C.x}`);
console.log(`${C.b}tools/test-audio-render.mjs — real WebAudio, real PCM${C.x}`);
console.log(`${C.b}================================================================${C.x}`);

const crowdOnly = await page.evaluate(() => window.__renderPoint__({ stems: { field: 0, amb: 0 } }));
if (crowdOnly.error) { console.log(`FATAL: ${crowdOnly.error}`); process.exit(1); }
const full = await page.evaluate(() => window.__renderPoint__({}));
if (full.error) { console.log(`FATAL: ${full.error}`); process.exit(1); }
const fieldOnly = await page.evaluate(() => window.__renderPoint__({ stems: { crowd: 0, amb: 0 } }));
const ambOnly = await page.evaluate(() => window.__renderPoint__({ stems: { crowd: 0, field: 0 } }));
const fly = await page.evaluate(() => window.__renderFlypast__());
const T = await page.evaluate(() => window.__T__);

const mean = (a, w, t0, t1) => {
  const i0 = Math.max(0, Math.round(t0 / w)); const i1 = Math.min(a.length, Math.round(t1 / w));
  let s = 0; for (let i = i0; i < i1; i++) s += a[i];
  return i1 > i0 ? s / (i1 - i0) : 0;
};
const top = (a, w, t0, t1) => {
  const i0 = Math.max(0, Math.round(t0 / w)); const i1 = Math.min(a.length, Math.round(t1 / w));
  let m = 0; for (let i = i0; i < i1; i++) if (a[i] > m) m = a[i];
  return m;
};

const W = crowdOnly.win;
const cr = crowdOnly.rms;

if (VERBOSE) {
  const line = (label, arr, w) => {
    let s = `  ${label}`;
    for (let t = 0; t < T.dur; t += 0.5) {
      if ((t * 2) % 8 === 0) s += `\n  ${t.toFixed(0).padStart(2)}s |`;
      s += ` ${db(mean(arr, w, t, t + 0.5)).padStart(6)}`;
    }
    return s;
  };
  console.log(`\n  marks: ${crowdOnly.marks.map(([n, t]) => `${n}@${t.toFixed(2)}`).join('  ')}`);
  console.log(line('crowd stem, dBFS, 0.5 s means:', cr, W));
  console.log(line('full mix, dBFS, 0.5 s means:', full.rms, W));
}

/* ---------------------------------------------------------- 0. the balance
 *
 * A stem that is 25 dB under the crowd is not quiet, it is absent, and no amount
 * of correctness inside it will ever be heard. This is measured first because
 * everything below is a comparison *within* a stem and none of it would notice.
 */

section('the stems are in a broadcast balance');
{
  const bal = (a, t0, t1) => mean(a.rms, a.win, t0, t1);
  const rows = [
    ['crowd', crowdOnly], ['field', fieldOnly], ['amb  ', ambOnly], ['FULL ', full],
  ];
  console.log(`  ${C.d}stem      possession    flight    at the goal      peak${C.x}`);
  for (const [n, a] of rows) {
    console.log(`  ${C.d}${n}    ${db(bal(a, 0.05, 2.9)).padStart(7)}   ${db(bal(a, T.huck, T.huckLand)).padStart(7)}`
      + `   ${db(bal(a, T.goal, T.goal + 2)).padStart(9)}   ${db(a.peak).padStart(7)} dBFS${C.x}`);
  }

  // The right comparison for a stem of sparse transients is NOT its RMS: a
  // footstep is 40 ms in every 200, so any window RMS sits 13 dB under the
  // transient by arithmetic alone and the number says nothing about whether it
  // can be heard. What matters is each transient's PEAK against the level of the
  // bed it has to cut through, so that is what is measured.
  const cPoss = bal(crowdOnly, 0.05, 2.9);
  const fw = fieldOnly.win;
  // Nothing but feet is happening during the stall — the disc is in a hand.
  const step = top(fieldOnly.pk, fw, 0.1, 2.8);
  ok(step > cPoss * 0.13, 'a cleat plant 50 m out is audible against the crowd bed',
    `footstep ${db(step)} vs bed ${db(cPoss)} dBFS  (${(20 * Math.log10(step / cPoss)).toFixed(1)} dB)`);
  ok(step < cPoss * 2.2, 'and it is texture, not an event',
    `${(20 * Math.log10(step / cPoss)).toFixed(1)} dB over the bed`);

  const snap = top(fieldOnly.pk, fw, T.huck, T.huck + 0.09);
  const thud = top(fieldOnly.pk, fw, T.awayLand, T.awayLand + 0.15);
  ok(snap > cPoss * 0.5, 'the release snap cuts the bed',
    `${db(snap)} vs ${db(cPoss)} dBFS  (${(20 * Math.log10(snap / cPoss)).toFixed(1)} dB)`);
  ok(thud > cPoss * 0.7, 'so does the disc hitting the turf',
    `${db(thud)} vs ${db(cPoss)} dBFS  (${(20 * Math.log10(thud / cPoss)).toFixed(1)} dB)`);

  const aGoal = bal(ambOnly, T.goal, T.goal + 2);
  const cGoal = bal(crowdOnly, T.goal, T.goal + 2);
  ok(aGoal > cGoal * 0.2, 'the goal horn is audible over the goal roar',
    `horn ${db(aGoal)} vs roar ${db(cGoal)} dBFS  (${(20 * Math.log10(aGoal / cGoal)).toFixed(1)} dB)`);

  // The mix has to be the sum of its parts. Measured where the other stems
  // actually live: at the goal, where the horn is, and on the peak, which is
  // where the transients are. A window RMS during possession cannot show this
  // and never could — it is a continuous bed plus 40 ms of cleat.
  const fGoal = bal(full, T.goal, T.goal + 2);
  ok(fGoal > cGoal * 1.15, 'the full mix at the goal is more than the crowd stem alone',
    `${db(cGoal)} -> ${db(fGoal)} dBFS  (+${(20 * Math.log10(fGoal / cGoal)).toFixed(2)} dB)`);
  ok(full.peak > crowdOnly.peak * 1.05, 'and the field transients push the mix peak up',
    `${db(crowdOnly.peak)} -> ${db(full.peak)} dBFS`);
}

/* ------------------------------------------------------- 1. the render is real */

section('the render is a signal, not a constant');
{
  let lo = Infinity; let hi = 0;
  for (const v of cr) { if (v < lo) lo = v; if (v > hi) hi = v; }
  ok(crowdOnly.nonFinite === 0, 'no non-finite samples in the crowd render', `${crowdOnly.nonFinite}`);
  ok(full.nonFinite === 0, 'no non-finite samples in the full mix', `${full.nonFinite}`);
  ok(lo > 1e-5 && hi > lo * 3, 'the crowd stem is a live envelope',
    `${db(lo)} .. ${db(hi)} dBFS  (${(20 * Math.log10(hi / Math.max(1e-9, lo))).toFixed(1)} dB range)`);
  ok(full.peak > 0.02 && full.peak < 1.0, 'the full mix has signal and does not clip',
    `peak ${db(full.peak)} dBFS`);
  ok((crowdOnly.peerErrors ?? []).length === 0, 'no peer system threw on the scripted events',
    (crowdOnly.peerErrors ?? []).slice(0, 3).join(' | '));
  // The model must have moved too — a frozen director rendering a live bed would
  // otherwise pass everything below on bed wander alone.
  const roar = crowdOnly.probe.map((p) => p[1]);
  const hush = crowdOnly.probe.map((p) => p[4]);
  ok(Math.max(...roar) > 0.3, 'the excitement model actually ran', `max roar ${Math.max(...roar).toFixed(3)}`);
  // A ceiling the match can never reach is not a ceiling. The stall ramp used to
  // top out at 1.0 only on the count that turns the disc over, so the quietest
  // the stands ever actually got was 0.66 of the way to the hush that was built.
  ok(Math.max(...hush) > 0.9, 'the hush reaches full depth on a stall the match can actually reach',
    `max hush ${Math.max(...hush).toFixed(3)}`);
}

/* --------------------------------------------------------------- 2. the catch */

section('the catch is the peak, not the aftermath');
{
  const before = mean(cr, W, T.huckLand - 2, T.huckLand);
  const after = mean(cr, W, T.huckLand, T.huckLand + 0.5);
  ok(after > before, 'RMS in the 0.5 s after the catch exceeds the 2 s before it',
    `${db(before)} -> ${db(after)} dBFS  (+${(20 * Math.log10(after / before)).toFixed(1)} dB)`);

  const atRelease = mean(cr, W, T.huck, T.huck + 0.2);
  const midFlight = mean(cr, W, T.huckLand - 0.4, T.huckLand);
  ok(midFlight > atRelease * 1.15, 'the crowd swells while the disc is still in the air',
    `${db(atRelease)} -> ${db(midFlight)} dBFS`);

  // The peak has to land ON the catch, not a beat behind it.
  const pk = top(cr, W, T.huckLand - 0.3, T.huckLand + 1.4);
  let tPk = 0;
  for (let i = 0; i < cr.length; i++) {
    const t = i * W;
    if (t >= T.huckLand - 0.3 && t <= T.huckLand + 1.4 && cr[i] === pk) tPk = t;
  }
  ok(tPk >= T.huckLand - 0.05 && tPk < T.huckLand + 0.75,
    'and the peak of that reaction lands on the catch, not a beat behind it',
    `peak at +${(tPk - T.huckLand).toFixed(2)}s`);
}

/* ---------------------------------------------------------------- 3. the hush */

section('tension is the absence of noise');
{
  const possession = mean(cr, W, 0.05, T.huck - 0.05);
  const stalled = mean(cr, W, 1.85, T.huck - 0.05);      // stall 7, 8, 9
  const early = mean(cr, W, 0.05, 1.0);                  // stall 0-3
  ok(stalled < possession, 'RMS during a stall of 7 or more is below the possession mean',
    `${db(stalled)} < ${db(possession)} dBFS`);
  ok(stalled < early * 0.8, 'a stall past 7 is quieter than the start of the same possession',
    `${(20 * Math.log10(stalled / early)).toFixed(1)} dB`);
  const broke = mean(cr, W, T.huck, T.huck + 0.6);
  ok(broke > stalled * 1.4, 'and the hush breaks when the throw finally goes',
    `${db(stalled)} -> ${db(broke)} dBFS`);
}

/* -------------------------------------------------------------- 4. the ranking */

section('the order of merit');
{
  const pBlock = top(cr, W, T.block, T.block + 3);
  const pCatch = top(cr, W, T.huckLand, T.huckLand + 1.4);
  const pDrop = top(cr, W, T.awayLand, T.awayLand + 1.4);
  const pLayout = top(cr, W, T.layout, T.layout + 2.4);
  const pGoal = top(cr, W, T.goal, T.goal + 3.9);
  ok(pBlock > pCatch && pBlock > pDrop && pBlock > pLayout,
    'a block is the loudest single reaction inside the point',
    `block ${db(pBlock)}  catch ${db(pCatch)}  drop ${db(pDrop)}  layout ${db(pLayout)} dBFS`);
  ok(pGoal > pBlock, 'the goal still tops the block', `${db(pGoal)} vs ${db(pBlock)} dBFS`);
  // Two identical dives, 3.6 s apart. The first takes the disc off somebody and
  // the second hits the turf with nothing in its hands, and the only difference
  // the mix has to work with is whether an outcome landed inside the bid window.
  // A tie here is the crowd telling you a dive that came up empty was the play
  // of the point.
  const pPaid = top(cr, W, T.bid, T.bid + 2.6);
  ok(pPaid > pLayout * 1.5, 'a bid that came off is clear of a bid that came up empty',
    `paid ${db(pPaid)} vs empty ${db(pLayout)} dBFS  (${(20 * Math.log10(pPaid / pLayout)).toFixed(1)} dB)`);

  // The same ranking has to survive the limiter, which is where a mix that is
  // correct in the model turns into a mix where everything is the same size.
  const fBlock = top(full.rms, W, T.block, T.block + 3);
  const fCatch = top(full.rms, W, T.huckLand, T.huckLand + 1.4);
  ok(fBlock > fCatch, 'and it survives the limiter in the full mix',
    `${db(fBlock)} vs ${db(fCatch)} dBFS`);
}

/* -------------------------------------------------------------- 5. the groan */

section('a groan is not a quiet cheer');
{
  // Brightness, not level: the drop and the catch can meter the same and must
  // not sound the same.
  const bright = (t0, t1) => mean(crowdOnly.hi, W, t0, t1) / Math.max(1e-9, mean(crowdOnly.lo, W, t0, t1));
  const bCatch = bright(T.huckLand, T.huckLand + 1.2);
  const bDrop = bright(T.awayLand, T.awayLand + 1.2);
  const bBlock = bright(T.block, T.block + 1.2);
  ok(bDrop < bCatch, 'the drop reaction is darker than the catch reaction',
    `drop ${bDrop.toFixed(3)} vs catch ${bCatch.toFixed(3)} (hi/lo energy)`);
  ok(bDrop < bBlock, 'and darker than the block reaction',
    `drop ${bDrop.toFixed(3)} vs block ${bBlock.toFixed(3)}`);

  const zCatch = mean(crowdOnly.zcr, W, T.huckLand, T.huckLand + 1.2);
  const zDrop = mean(crowdOnly.zcr, W, T.awayLand, T.awayLand + 1.2);
  ok(zDrop < zCatch, 'zero-crossing rate corroborates it', `${zDrop.toFixed(0)} Hz vs ${zCatch.toFixed(0)} Hz`);

  // And it must have begun before the disc landed.
  const preLand = mean(cr, W, T.awayLand - 0.6, T.awayLand);
  const midFlight = mean(cr, W, T.away + 0.1, T.away + 0.5);
  ok(preLand < midFlight, 'the swell has already collapsed before the disc lands',
    `${db(midFlight)} -> ${db(preLand)} dBFS`);
}

/* ------------------------------------------------------- 6. between the points */

section('between points is a wash, not silence');
{
  const possession = mean(cr, W, 0.05, T.huck - 0.05);
  const between = mean(cr, W, T.goal + 1.5, T.dur - 0.1);
  ok(between > possession * 0.9, 'the stands are not silent after the point',
    `${db(between)} vs possession ${db(possession)} dBFS`);
  const stalled = mean(cr, W, 1.85, T.huck - 0.05);
  ok(between > stalled * 1.5, 'and markedly louder than the tensest moment of it',
    `${db(between)} vs stall ${db(stalled)} dBFS`);
}

/* ------------------------------------------------------------------ 7. the disc */

section('the disc');
{
  const fw = fieldOnly.win;
  const fr = fieldOnly.pk;
  const near = (t) => top(fr, fw, t - 0.02, t + 0.25);
  const floor = mean(fieldOnly.rms, fw, T.goal + 2, T.dur - 0.1);
  ok(near(T.huck) > floor * 4, 'the release snaps', `${db(near(T.huck))} dBFS vs floor ${db(floor)}`);
  ok(near(T.huckLand) > floor * 4, 'the catch slaps', `${db(near(T.huckLand))} dBFS`);
  ok(near(T.awayLand) > floor * 4, 'the drop thuds on the turf', `${db(near(T.awayLand))} dBFS`);
  const flight = mean(fieldOnly.rms, fw, T.huck + 0.3, T.huckLand - 0.2);
  const still = mean(fieldOnly.rms, fw, T.huckLand + 0.4, T.away - 0.2);
  ok(flight > still * 2, 'the disc is audible in flight and silent in the hand',
    `${db(flight)} vs ${db(still)} dBFS`);

  if (fly.error) ok(false, 'the flypast rendered', fly.error);
  else {
    ok(fly.peak > 0.002, 'the flypast carries signal', `peak ${db(fly.peak)} dBFS`);
    ok(fly.atPass.rms > fly.quiet.rms, 'the disc is loudest as it passes the camera',
      `${db(fly.atPass.rms)} at the pass vs ${db(fly.quiet.rms)} at 48 m`);
    const cents = 1200 * Math.log2(fly.closing.zcr / Math.max(1, fly.receding.zcr));
    ok(fly.closing.zcr > fly.receding.zcr,
      'a disc closing on the camera is measurably brighter than the same disc receding',
      `${fly.closing.zcr.toFixed(0)} Hz -> ${fly.receding.zcr.toFixed(0)} Hz  (${cents.toFixed(0)} cents)`);
    ok(cents > 200, 'and the shift is big enough to read as movement', `${cents.toFixed(0)} cents`);
  }
}

/* ---------------------------------------------------------------------- done */

if (problems.length) {
  console.log(`\n${problems.length} console error(s):`);
  for (const p of [...new Set(problems)].slice(0, 12)) console.log('  ' + p);
}

console.log(`\n${C.b}================================================================${C.x}`);
if (failures.length === 0) console.log(`${C.g}${C.b}PASS${C.x}  ${count} assertions, 0 failures`);
else {
  console.log(`${C.r}${C.b}FAIL${C.x}  ${count} assertions, ${failures.length} failures`);
  for (const f of failures) console.log(`  ${C.r}•${C.x} ${f}`);
}
console.log(`${C.b}================================================================${C.x}`);

await browser.close();
if (child) child.kill('SIGTERM');
process.exit(failures.length ? 1 : 0);
