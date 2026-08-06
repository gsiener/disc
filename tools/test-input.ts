/**
 * Numeric tests for the input layer. `node tools/test-input.ts`
 *
 * There is no DOM under node, so every device is injected through
 * ManualSources and every curve is a pure function. Everything here asserts on
 * real numbers; the ASCII plots exist so the *feel* of the curves can be
 * sanity-checked by eye without launching the game.
 */

import {
  applyStick, applyTrigger, responseCurve, vec2, mag2,
  DEFAULT_STICK, DEFAULT_AIM_STICK, DEFAULT_TRIGGER,
} from '../src/input/Curves.ts';
import { InputBuffer } from '../src/input/Buffer.ts';
import {
  DEFAULT_TIMING, THROW_DIFFICULTY, applyDifficulty, chargePower, releaseQuality,
  finalQuality, steadiness, tiltFactor, resolveThrowType, tiltFromAim, isPerfect,
  ThrowController, type ChargeInput,
} from '../src/input/Throw.ts';
import { ActionMap, defaultConfig } from '../src/input/ActionMap.ts';
import { ManualSources } from '../src/input/Sources.ts';
import { PadManager, readPadButton, resolvePadLayout } from '../src/input/Pad.ts';
import { HumanController } from '../src/input/Human.ts';
import { makeIntent } from '../src/input/Intent.ts';
import { pickSwitchTarget, switchScore, type DefenderCandidate, type SwitchSituation } from '../src/input/Switch.ts';
import { InputSystem } from '../src/input/Input.ts';

/* ----------------------------------------------------------- test harness */

let passed = 0;
let failed = 0;
const failures: string[] = [];
let group = '';

function section(name: string): void {
  group = name;
  console.log(`\n\x1b[1m── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}\x1b[0m`);
}

function ok(cond: boolean, label: string, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; failures.push(`${group} :: ${label} ${detail}`); console.log(`  \x1b[31mFAIL\x1b[0m ${label}  ${detail}`); }
}

function near(actual: number, expect: number, tol: number, label: string): void {
  const d = Math.abs(actual - expect);
  ok(d <= tol, label, `got ${fmt(actual)} expected ${fmt(expect)} +-${tol}`);
}

function eq<T>(actual: T, expect: T, label: string): void {
  const cut = (v: T) => { const t = String(v); return t.length > 48 ? t.slice(0, 45) + '...' : t; };
  ok(actual === expect, label, actual === expect ? '' : `got ${cut(actual)} expected ${cut(expect)}`);
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return (Math.abs(n) >= 1000 || (Math.abs(n) < 1e-4 && n !== 0)) ? n.toExponential(3) : n.toFixed(4);
}

/* --------------------------------------------------------------- plotting */

function plot(
  title: string,
  series: { label: string; ch: string; f: (x: number) => number }[],
  x0: number, x1: number,
  y0 = 0, y1 = 1,
  w = 66, h = 15,
): void {
  const grid: string[][] = [];
  for (let r = 0; r < h; r++) grid.push(new Array(w).fill(' '));
  for (const s of series) {
    for (let c = 0; c < w; c++) {
      const x = x0 + ((x1 - x0) * c) / (w - 1);
      const y = s.f(x);
      if (!Number.isFinite(y)) continue;
      const t = (y - y0) / (y1 - y0);
      const r = Math.round((1 - Math.min(1, Math.max(0, t))) * (h - 1));
      grid[r][c] = s.ch;
    }
  }
  const legend = series.map((s) => `${s.ch}=${s.label}`).join('  ');
  console.log(`\n  ${title}   [${legend}]`);
  for (let r = 0; r < h; r++) {
    const yv = y1 - ((y1 - y0) * r) / (h - 1);
    console.log(`  ${yv.toFixed(2).padStart(5)} |${grid[r].join('')}|`);
  }
  console.log(`        +${'-'.repeat(w)}+`);
  console.log(`        ${x0.toFixed(2).padEnd(Math.floor(w / 2))}${((x0 + x1) / 2).toFixed(2).padEnd(Math.ceil(w / 2) - 5)}${x1.toFixed(2)}`);
}

/* ================================================================ 1. curves */

section('dead zone + response curve');

{
  const out = vec2();

  // Inside the radial dead zone -> silence.
  applyStick(0.10, 0.10, DEFAULT_STICK, out);
  near(mag2(out), 0, 1e-12, 'inside dead zone (r=0.141 < 0.18) reads zero');

  // The diagonal case a square dead zone gets wrong: each axis is below the
  // 0.18 threshold, the vector is not.
  applyStick(0.16, 0.16, DEFAULT_STICK, out);
  const diagMag = mag2(out);
  ok(diagMag > 0, 'radial not square: |0.16,0.16| = 0.2263 survives', `mag=${fmt(diagMag)}`);
  ok(Math.abs(0.16) < DEFAULT_STICK.inner, 'both axes individually below the dead zone', `0.16 < ${DEFAULT_STICK.inner}`);

  // Direction is preserved exactly at every angle.
  let worstAngle = 0;
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    for (const r of [0.25, 0.5, 0.75, 1.0]) {
      applyStick(Math.cos(a) * r, Math.sin(a) * r, DEFAULT_STICK, out);
      if (mag2(out) < 1e-9) continue;
      const oa = Math.atan2(out.y, out.x);
      let d = Math.abs(oa - a);
      if (d > Math.PI) d = Math.abs(d - Math.PI * 2);
      worstAngle = Math.max(worstAngle, d);
    }
  }
  ok(worstAngle < 1e-12, 'direction preserved at all 64 angles x 4 radii', `worst err ${fmt(worstAngle)} rad`);

  // Continuity: just outside the dead zone the output is ~0, not a jump to 0.18.
  applyStick(DEFAULT_STICK.inner + 1e-4, 0, DEFAULT_STICK, out);
  ok(mag2(out) < 1e-3, 'no snap at the dead zone edge', `mag=${fmt(mag2(out))}`);

  // Saturation before the physical stop.
  applyStick(DEFAULT_STICK.outer, 0, DEFAULT_STICK, out);
  near(mag2(out), 1, 1e-12, 'saturates to 1.0 at the outer dead zone (0.95)');
  applyStick(1, 1, DEFAULT_STICK, out);
  near(mag2(out), 1, 1e-12, 'diagonal at full deflection clamps to 1.0');

  // Monotonic.
  let mono = true;
  let prev = -1;
  for (let i = 0; i <= 400; i++) {
    applyStick(i / 400, 0, DEFAULT_STICK, out);
    const m = mag2(out);
    if (m < prev - 1e-12) mono = false;
    prev = m;
  }
  ok(mono, 'magnitude is monotonically non-decreasing over 401 samples');

  // The curve is genuinely non-linear.
  const half = responseCurve(0.5, DEFAULT_STICK.expo, DEFAULT_STICK.power);
  near(half, 0.38 * 0.5 + 0.62 * Math.pow(0.5, 2.6), 1e-12, 'responseCurve(0.5) matches the closed form');
  ok(Math.abs(half - 0.5) > 0.15, 'response is not linear at t=0.5', `f(0.5)=${fmt(half)} vs linear 0.5`);
  near(responseCurve(0, 0.62, 2.6), 0, 1e-12, 'responseCurve(0) = 0');
  near(responseCurve(1, 0.62, 2.6), 1, 1e-12, 'responseCurve(1) = 1');

  // Triggers.
  near(applyTrigger(0.05, DEFAULT_TRIGGER), 0, 1e-12, 'trigger dead zone kills 0.05');
  ok(applyTrigger(0.5, DEFAULT_TRIGGER) > 0.3 && applyTrigger(0.5, DEFAULT_TRIGGER) < 0.5,
    'half-pulled trigger sits below linear (analogue sprint has headroom)',
    `got ${fmt(applyTrigger(0.5, DEFAULT_TRIGGER))}`);
  near(applyTrigger(1, DEFAULT_TRIGGER), 1, 1e-12, 'full trigger = 1.0');
  near(applyTrigger(-0.6, DEFAULT_TRIGGER), -applyTrigger(0.6, DEFAULT_TRIGGER), 1e-12, 'trigger is sign-symmetric');

  const s = vec2();
  plot('stick response: raw magnitude -> output magnitude', [
    { label: 'move', ch: '*', f: (x) => { applyStick(x, 0, DEFAULT_STICK, s); return mag2(s); } },
    { label: 'aim', ch: '+', f: (x) => { applyStick(x, 0, DEFAULT_AIM_STICK, s); return mag2(s); } },
    { label: 'trigger', ch: '.', f: (x) => applyTrigger(x, DEFAULT_TRIGGER) },
    { label: 'linear', ch: '_', f: (x) => x },
  ], 0, 1);
}

/* ================================================================ 2. buffer */

section('input buffer');

{
  const STEP = 1 / 120;
  const b = new InputBuffer({ window: 0.12 });

  b.press('throw', 1.0);
  ok(b.peek('throw', 1.0), 'a press is live immediately');
  ok(b.consume('throw', 1.05), 'consumed 0.05 s later');
  ok(!b.consume('throw', 1.05), 'a consumed press cannot fire twice');

  b.press('bid', 2.0);
  ok(b.peek('bid', 2.0 + 0.1199), 'live at 0.1199 s (inside the 0.12 s window)');
  ok(!b.peek('bid', 2.0 + 0.1201), 'expired at 0.1201 s');

  // The behaviour that actually matters: pressed a few steps before the state
  // that allows it, still fires.
  const c = new InputBuffer({ window: 0.12 });
  c.press('layout', 0);
  let firedAtStep = -1;
  for (let i = 0; i <= 20; i++) {
    const t = i * STEP;
    const gateOpen = i === 14;                 // game says "now you may layout"
    if (gateOpen && c.consume('layout', t)) firedAtStep = i;
  }
  eq(firedAtStep, 14, 'press at step 0 still fires when the gate opens at step 14 (0.1167 s)');

  const d = new InputBuffer({ window: 0.12 });
  d.press('layout', 0);
  let fired2 = false;
  for (let i = 0; i <= 20; i++) if (i === 16 && d.consume('layout', i * STEP)) fired2 = true;
  ok(!fired2, 'the same press does NOT fire at step 16 (0.1333 s) — window is honoured');

  // Per-action overrides.
  const e = new InputBuffer({ window: 0.12 });
  e.setWindow('layout', 0.2);
  e.press('layout', 0);
  e.press('throw', 0);
  ok(e.peek('layout', 0.19), 'override extends layout to 0.2 s');
  ok(!e.peek('throw', 0.19), 'throw still uses the 0.12 s default');

  // Ring capacity.
  const f = new InputBuffer({ window: 10, capacity: 8 });
  for (let i = 0; i < 12; i++) f.press(`a${i}`, i * 0.01);
  ok(!f.peek('a0', 0.12), 'oldest press evicted once the ring wraps (capacity 8, 12 presses)');
  ok(f.peek('a11', 0.12), 'newest press survives');
  eq(f.live(0.12), 8, 'exactly capacity presses are live');

  // Age.
  const g = new InputBuffer({ window: 0.5 });
  g.press('bid', 3.0);
  near(g.age('bid', 3.07), 0.07, 1e-12, 'age reports how late the consumer was');
  eq(g.age('nope', 3.07), -1, 'age of an unpressed action is -1');

  // Newest wins.
  const h = new InputBuffer({ window: 0.5 });
  h.press('throw', 1.0);
  h.press('throw', 1.2);
  near(h.age('throw', 1.25), 0.05, 1e-12, 'the most recent press is the live one');
  h.consume('throw', 1.25);
  ok(!h.peek('throw', 1.25), 'consuming clears the older duplicate too');
}

/* ========================================================= 3. throw timing */

section('throw charge / release timing');

{
  const T = DEFAULT_TIMING;

  near(chargePower(0, T), T.minPower, 1e-12, 'power at hold 0 is the floor (0.06)');
  near(chargePower(T.fullTime, T), 1, 1e-12, 'power reaches 1.0 at fullTime (0.85 s)');
  near(chargePower(2.0, T), 1, 1e-12, 'power stays 1.0 through the overcharge');
  let mono = true, prev = -1;
  for (let i = 0; i <= 400; i++) { const p = chargePower((i / 400) * 2, T); if (p < prev - 1e-12) mono = false; prev = p; }
  ok(mono, 'power is monotonically non-decreasing');
  ok(chargePower(0.4, T) > 0.4 * (1 / 0.85), 'power is front-loaded — a flick still has legs',
    `p(0.4)=${fmt(chargePower(0.4, T))}`);

  near(releaseQuality(0, T), T.rushFloor, 1e-9, 'quality at hold 0 is the rush floor (0.34)');
  near(releaseQuality(T.minTime, T), T.plateau, 1e-9, 'quality reaches the plateau at minTime (0.14 s)');
  near(releaseQuality(T.fullTime, T), 1, 1e-9, 'perfect release at fullTime scores 1.0');
  near(releaseQuality(T.fullTime + T.overGrace, T), T.plateau, 1e-9, 'still on the plateau at fullTime+grace (1.15 s)');
  near(releaseQuality(T.maxHold, T), T.overFloor, 1e-9, 'quality bottoms out at maxHold (0.28)');

  ok(releaseQuality(0.05, T) < releaseQuality(0.40, T), 'a rushed throw is worse than a measured one',
    `${fmt(releaseQuality(0.05, T))} < ${fmt(releaseQuality(0.4, T))}`);
  ok(releaseQuality(1.60, T) < releaseQuality(1.15, T), 'an over-charged throw decays',
    `${fmt(releaseQuality(1.6, T))} < ${fmt(releaseQuality(1.15, T))}`);
  ok(releaseQuality(T.fullTime, T) > releaseQuality(0.4, T), 'the perfect window beats the safe plateau',
    `${fmt(releaseQuality(T.fullTime, T))} > ${fmt(releaseQuality(0.4, T))}`);

  let riseOk = true, fallOk = true;
  prev = -1;
  for (let i = 0; i <= 200; i++) { const q = releaseQuality((i / 200) * T.fullTime, T); if (q < prev - 1e-9) riseOk = false; prev = q; }
  ok(riseOk, 'quality is non-decreasing from 0 to fullTime');
  prev = 2;
  for (let i = 0; i <= 200; i++) { const q = releaseQuality(T.fullTime + (i / 200) * (T.maxHold - T.fullTime), T); if (q > prev + 1e-9) fallOk = false; prev = q; }
  ok(fallOk, 'quality is non-increasing from fullTime to maxHold');

  ok(isPerfect(T.fullTime, T), 'fullTime is inside the perfect window');
  ok(!isPerfect(T.fullTime + T.perfectWindow, T), 'the window edge is not "perfect"');

  // Difficulty: a blade must be released far more precisely than a backhand.
  const bh = applyDifficulty(T, THROW_DIFFICULTY.backhand);
  const bl = applyDifficulty(T, THROW_DIFFICULTY.blade);
  near(bl.perfectWindow, T.perfectWindow / 1.6, 1e-12, 'blade perfect window is 1/1.6 as wide');
  const off = 0.06;
  ok(releaseQuality(T.fullTime + off, bl) < releaseQuality(T.fullTime + off, bh),
    'released 60 ms late, a blade scores worse than a backhand',
    `blade ${fmt(releaseQuality(T.fullTime + off, bl))} < backhand ${fmt(releaseQuality(T.fullTime + off, bh))}`);
  ok(bl.plateau < bh.plateau, 'blade plateau is lower', `${fmt(bl.plateau)} < ${fmt(bh.plateau)}`);

  // Aim penalties.
  near(steadiness(0), 1, 1e-12, 'a still aim costs nothing');
  near(steadiness(11), 0.65, 1e-12, 'a fully whipped aim costs 35%');
  near(steadiness(22), 0.65, 1e-12, 'the whip penalty is clamped');
  near(tiltFactor(0), 1, 1e-12, 'a flat disc costs nothing');
  near(tiltFactor(1), 0.86, 1e-12, 'a fully tilted disc costs 14%');
  near(tiltFactor(-1), 0.86, 1e-12, 'tilt penalty is symmetric');
  near(finalQuality(T.fullTime, T, 0, 0), 1, 1e-9, 'perfect + still + flat = 1.0');
  near(finalQuality(T.fullTime, T, 11, 1), 0.65 * 0.86, 1e-9, 'perfect but whipped and fully tilted = 0.559');

  // Type resolution.
  eq(resolveThrowType(false, false, 0), 'backhand', 'no modifier = backhand');
  eq(resolveThrowType(true, false, 0), 'forehand', 'modA = forehand');
  eq(resolveThrowType(false, true, 0), 'hammer', 'modB = hammer');
  eq(resolveThrowType(true, true, 0), 'scoober', 'modA+modB = scoober');
  eq(resolveThrowType(false, true, 0.8), 'blade', 'modB with the disc on edge = blade');
  eq(resolveThrowType(false, true, -0.8), 'blade', 'blade works either way round');

  // Disc angle from aim deflection.
  const span = Math.PI / 3;
  near(tiltFromAim(0, 0, span), 0, 1e-12, 'aiming where you face is a flat disc');
  near(tiltFromAim(Math.PI / 6, 0, span), 0.5, 1e-12, '30 deg right of facing = +0.5 tilt (inside-out)');
  near(tiltFromAim(-Math.PI / 6, 0, span), -0.5, 1e-12, '30 deg left of facing = -0.5 tilt (outside-in)');
  near(tiltFromAim(Math.PI / 2, 0, span), 1, 1e-12, 'deflection past the span clamps to full tilt');
  near(tiltFromAim(-3.0, 3.0, span), (Math.PI * 2 - 6.0) / span, 1e-12, 'tilt uses the wrapped angle, not the raw difference');

  plot('throw meter vs hold time (s)', [
    { label: 'power', ch: '*', f: (x) => chargePower(x, T) },
    { label: 'quality', ch: '#', f: (x) => releaseQuality(x, T) },
    { label: 'blade-q', ch: '+', f: (x) => releaseQuality(x, bl) },
  ], 0, T.maxHold);
  console.log('        rushed < 0.14 s | plateau | perfect at 0.85 +-0.09 | overcharged > 1.15 s');
}

/* ================================== 4. charge controller at a 1/120 s step */

section('ThrowController driven at 120 Hz');

{
  const STEP = 1 / 120;
  const baseInput = (): ChargeInput => ({
    chargeDown: false, chargePressed: false, chargeReleased: false, cancelPressed: false,
    modA: false, modB: false, curveLeft: 0, curveRight: 0,
    aimActive: false, aimYaw: 0, aimRate: 0, facingYaw: 0, targetId: 7,
  });

  function run(holdSteps: number, mutate?: (i: ChargeInput, step: number) => void) {
    const ctl = new ThrowController();
    const intent = makeIntent(0, 'human');
    const inp = baseInput();
    let cancelledAt = -1;
    let fake = false;
    for (let s = 0; s <= holdSteps + 1; s++) {
      inp.chargePressed = s === 0;
      inp.chargeDown = s <= holdSteps;
      inp.chargeReleased = s === holdSteps + 1;
      inp.cancelPressed = false;
      mutate?.(inp, s);
      const fired = ctl.step(STEP, inp, intent.charge, intent.release);
      if (ctl.cancelled) { cancelledAt = s; fake = ctl.fake; }
      if (fired) return { intent, releasedAtStep: s, cancelledAt, fake, ctl };
    }
    return { intent, releasedAtStep: -1, cancelledAt, fake, ctl };
  }

  // Perfect release: fullTime is 0.85 s = 102 steps.
  const perfect = run(101);
  ok(perfect.releasedAtStep === 102, 'released on the step after the button came up', `step ${perfect.releasedAtStep}`);
  near(perfect.intent.release.hold, 0.85, 1e-9, 'hold at release is 0.85 s');
  near(perfect.intent.release.power, 1, 1e-9, 'perfect release is full power');
  near(perfect.intent.release.quality, 1, 1e-9, 'perfect release is quality 1.0');
  ok(perfect.intent.release.perfect, 'flagged perfect');
  eq(perfect.intent.release.targetId, 7, 'selected receiver id rides along on the release');

  // Rushed tap: press and release inside two steps.
  const tap = run(0);
  near(tap.intent.release.hold, 1 / 120, 1e-9, 'a tap holds for one step (0.0083 s)');
  ok(tap.intent.release.rushed, 'a tap is flagged rushed');
  ok(tap.intent.release.quality < 0.45, 'a tap throws badly', `q=${fmt(tap.intent.release.quality)}`);
  ok(tap.intent.release.power < 0.2, 'a tap is a soft dump', `p=${fmt(tap.intent.release.power)}`);

  // Safe touch pass: 0.4 s.
  const touch = run(47);
  near(touch.intent.release.hold, 0.4, 1e-9, 'touch pass holds 0.4 s');
  near(touch.intent.release.quality, DEFAULT_TIMING.plateau, 1e-6, 'touch pass sits on the plateau (0.90)');
  ok(touch.intent.release.power > 0.5 && touch.intent.release.power < 0.75,
    'touch pass is mid power', `p=${fmt(touch.intent.release.power)}`);

  // Over-charged huck.
  const late = run(191);   // 1.6 s
  near(late.intent.release.hold, 1.6, 1e-9, 'over-charged hold is 1.6 s');
  ok(late.intent.release.overcharged, 'flagged overcharged');
  ok(late.intent.release.quality < 0.7, 'over-charging costs real accuracy', `q=${fmt(late.intent.release.quality)}`);
  near(late.intent.release.power, 1, 1e-9, 'but the power is still maxed — power/accuracy are separate axes');

  // Auto release at maxHold.
  const auto = run(400);
  ok(auto.intent.release.auto, 'the charge fires itself at maxHold');
  ok(auto.intent.release.hold >= 2.0 && auto.intent.release.hold < 2.0 + 2 / 120,
    'auto release lands on maxHold (2.0 s) within one step',
    `hold=${fmt(auto.intent.release.hold)}`);

  // Cancel: pump fake vs a twitch.
  const pump = run(200, (i, s) => { if (s === 40) i.cancelPressed = true; });   // 0.333 s
  eq(pump.cancelledAt, 40, 'cancel registers on the step it was pressed');
  ok(pump.fake, 'a 0.34 s charge cancelled reads as a pump fake');
  eq(pump.releasedAtStep, -1, 'nothing left the hand');

  const twitch = run(200, (i, s) => { if (s === 8) i.cancelPressed = true; });  // 0.075 s
  eq(twitch.cancelledAt, 8, 'early cancel registers');
  ok(!twitch.fake, 'a 0.075 s charge is too short to sell as a fake');

  // Disc angle set by the stick while charging.
  const io = run(101, (i) => { i.aimActive = true; i.aimYaw = Math.PI / 6; i.facingYaw = 0; });
  near(io.intent.release.tilt, 0.5, 1e-9, 'aiming 30 deg across the body gives +0.5 disc tilt');
  near(io.intent.release.quality, 1 * tiltFactor(0.5), 1e-6, 'the tilt costs 3.5% of a perfect release');

  const curved = run(101, (i) => { i.curveLeft = 1; });
  near(curved.intent.release.tilt, -0.55, 1e-9, 'the curve modifier alone bends the disc -0.55');

  // Whipped release.
  const whip = run(101, (i) => { i.aimActive = true; i.aimYaw = 0; i.aimRate = 11; });
  near(whip.intent.release.steadiness, 0.65, 1e-9, 'a whipped stick reports steadiness 0.65');
  near(whip.intent.release.quality, 0.65, 1e-6, 'and drags a perfect release down to 0.65');

  // Throw type from modifiers, mid-charge.
  const scoob = run(101, (i) => { i.modA = true; i.modB = true; });
  eq(scoob.intent.release.type, 'scoober', 'scoober held through the charge');
  near(scoob.intent.release.quality, 1, 1e-9, 'a dead-centre release is perfect whatever the throw is');

  const scoobLate = run(107, (i) => { i.modA = true; i.modB = true; });   // 0.90 s
  const bhLate = run(107);
  near(scoobLate.intent.release.hold, 0.9, 1e-9, 'both released 50 ms past the sweet spot');
  ok(scoobLate.intent.release.quality < bhLate.intent.release.quality - 0.05,
    'the scoober punishes a 50 ms miss far harder than a backhand',
    `scoober ${fmt(scoobLate.intent.release.quality)} vs backhand ${fmt(bhLate.intent.release.quality)}`);

  const scoobSafe = run(47, (i) => { i.modA = true; i.modB = true; });
  const bhSafe = run(47);
  ok(scoobSafe.intent.release.quality < bhSafe.intent.release.quality,
    'and its safe plateau sits lower too',
    `scoober ${fmt(scoobSafe.intent.release.quality)} vs backhand ${fmt(bhSafe.intent.release.quality)}`);
}

/* ============================================================ 5. action map */

section('action map + rebinding + serialisation');

{
  const m = new ActionMap();
  eq(m.binding('throw').mouse[0], 0, 'throw defaults to left mouse');
  eq(m.binding('throw').pad[0], 'a', 'throw defaults to pad A');
  eq(m.axisBinding('sprint').padButton, 'rt', 'sprint defaults to the right trigger (analogue)');
  eq(m.axisBinding('moveY').invert, true, 'pad Y axis is inverted so up is forward');

  m.rebind('throw', { keys: ['KeyF'], mouse: [0], pad: ['a'] });
  ok(m.conflicts('KeyF').indexOf('throw') >= 0, 'rebinding throw to KeyF takes effect');
  eq(m.binding('throw').keys.length, 1, 'replace mode discards the old keys');

  m.rebind('throw', { keys: ['KeyG'] }, 'add');
  eq(m.binding('throw').keys.join(','), 'KeyF,KeyG', 'add mode appends');
  m.rebind('throw', { keys: ['KeyG'] }, 'add');
  eq(m.binding('throw').keys.join(','), 'KeyF,KeyG', 'add mode de-duplicates');

  const both = new ActionMap();
  eq(both.conflicts('Space').sort().join(','), 'callCut,switchDefender',
    'Space is deliberately shared between the offence and defence verbs');
  both.unbindEverywhere('Space');
  eq(both.conflicts('Space').length, 0, 'unbindEverywhere clears a token from every action');

  // Round trip.
  const a = new ActionMap();
  a.rebind('bid', { keys: ['KeyN'], mouse: [3], pad: ['y'] });
  a.config.stick.inner = 0.22;
  a.config.timing.fullTime = 0.7;
  const s1 = a.serialize();
  const b = ActionMap.deserialize(s1);
  const s2 = b.serialize();
  eq(s2, s1, 'serialize -> deserialize -> serialize is byte-identical');
  eq(b.binding('bid').keys[0], 'KeyN', 'custom key survives the round trip');
  near(b.config.stick.inner, 0.22, 1e-12, 'custom dead zone survives the round trip');
  near(b.config.timing.fullTime, 0.7, 1e-12, 'custom charge time survives the round trip');
  eq(ActionMap.deserialize(s1).serialize(), s1, 'deserialisation is idempotent');

  // Hostile input.
  const junk = ActionMap.deserialize('not json at all');
  eq(junk.serialize(), new ActionMap().serialize(), 'garbage JSON falls back to defaults');
  const partial = ActionMap.deserialize(JSON.stringify({
    buttons: { bid: { keys: ['KeyN'] }, notAnAction: { keys: ['KeyJ'] } },
    stick: { inner: 99, outer: -4 },
    timing: { fullTime: 1e9 },
    bufferTime: 'wat',
  }));
  eq(partial.binding('bid').keys[0], 'KeyN', 'known action from a partial config is applied');
  eq(partial.binding('bid').pad[0], 'x', 'unspecified fields keep their defaults');
  ok(partial.conflicts('KeyJ').length === 0, 'unknown actions are dropped (KeyJ from notAnAction never binds)');
  ok(partial.config.stick.inner <= 0.6, 'out-of-range dead zone is clamped', `inner=${fmt(partial.config.stick.inner)}`);
  ok(partial.config.stick.outer > partial.config.stick.inner, 'outer is forced above inner');
  ok(partial.config.timing.fullTime <= 4, 'absurd charge time is clamped', `fullTime=${fmt(partial.config.timing.fullTime)}`);
  near(partial.config.bufferTime, defaultConfig().bufferTime, 1e-12, 'a non-numeric buffer time falls back');

  const badPad = ActionMap.deserialize(JSON.stringify({ buttons: { bid: { pad: ['nope', 'y'] } } }));
  eq(badPad.binding('bid').pad.join(','), 'y', 'unknown pad button names are filtered out');

  m.reset();
  eq(m.serialize(), new ActionMap().serialize(), 'reset restores the defaults');
}

/* =================================================== 6. gamepad plumbing */

section('gamepad: layouts, hot-plug, arbitration');

{
  const src = new ManualSources();
  const pads = new PadManager();
  let t = 0;
  const tick = () => { t += 1 / 120; pads.update(src.pads(), t); };

  tick();
  eq(pads.count, 0, 'no pads to begin with');
  eq(pads.active, null, 'no active pad');

  src.addPad(0, { id: 'Xbox Wireless Controller', mapping: 'standard' });
  tick();
  eq(pads.count, 1, 'pad 0 hot-plugged');
  eq(pads.events.length + 0, 1, 'a connect event was queued');
  const evts: any[] = [];
  pads.drainEvents(evts);
  eq(evts[0].connected, true, 'the event says connected');
  eq(evts[0].standard, true, 'standard mapping detected');
  eq(pads.active?.index, 0, 'the only pad becomes active');

  src.addPad(1, { id: 'Second Pad', mapping: 'standard' });
  tick();
  eq(pads.count, 2, 'a second pad joined');
  eq(pads.active?.index, 0, 'the idle newcomer does not steal control');

  src.setAxis(1, 0, 0.9);          // player 2 shoves their stick
  tick();
  eq(pads.active?.index, 1, 'the pad that is actually being driven becomes active');
  src.setAxis(1, 0, 0);
  src.setButton(0, 0, 1);
  tick();
  eq(pads.active?.index, 0, 'pressing A on pad 0 takes it back');

  pads.assign(0, 1);
  eq(pads.forSlot(0)?.index, 1, 'a pinned slot ignores arbitration');
  pads.assign(0, null);
  eq(pads.forSlot(0)?.index, 0, 'unpinning restores automatic arbitration');

  src.removePad(0);
  tick();
  eq(pads.count, 1, 'unplugging removes the pad');
  const evts2: any[] = [];
  pads.drainEvents(evts2);
  eq(evts2[evts2.length - 1].connected, false, 'a disconnect event was queued');
  eq(pads.active?.index, 1, 'control falls through to the surviving pad');

  // Non-standard pad with triggers on axes 4/5 and a d-pad hat on axis 9.
  const weird = { index: 3, id: 'Generic USB Gamepad', mapping: '', connected: true,
    axes: [0, 0, 0, 0, -1, 1, 0, 0, 0, -1], buttons: new Array(6).fill(0), pressed: new Array(6).fill(false), timestamp: 0 };
  const layout = resolvePadLayout(weird);
  eq(layout.standard, false, 'a pad that does not claim standard mapping is flagged');
  eq(layout.triggerAxis?.rt, 5, 'triggers are recovered from axes 4/5');
  near(readPadButton(weird, layout, 'lt'), 0, 1e-12, 'axis trigger at rest (-1) reads 0');
  near(readPadButton(weird, layout, 'rt'), 1, 1e-12, 'axis trigger fully pulled (+1) reads 1');
  eq(readPadButton(weird, layout, 'dup'), 1, 'the hat axis decodes to d-pad up');
  eq(readPadButton(weird, layout, 'ddown'), 0, 'and not to d-pad down');
}

/* ================================================ 7. human controller e2e */

section('human controller (keyboard + pad) -> intent');

{
  const STEP = 1 / 120;

  function rig() {
    const map = new ActionMap();
    const src = new ManualSources();
    const pads = new PadManager();
    const h = new HumanController(map, { playerId: 4, slot: 0 });
    h.attach(src, pads);
    let t = 0;
    const step = (n = 1) => {
      let last = h.intent;
      for (let i = 0; i < n; i++) {
        t += STEP;
        pads.update(src.pads(), t);
        last = h.step(STEP, t);
        src.endStep();
      }
      return last;
    };
    return { map, src, pads, h, step, now: () => t };
  }

  // --- keyboard analogue emulation -------------------------------------
  {
    const r = rig();
    r.src.setKey('KeyW', true);
    let i = r.step(1);
    ok(i.move.mag > 0 && i.move.mag < 0.2, 'the first step of a keypress is a nudge, not a snap to full speed',
      `mag=${fmt(i.move.mag)}`);
    i = r.step(5);
    ok(i.move.mag > 0.3 && i.move.mag < 0.7, 'still ramping at 0.05 s', `mag=${fmt(i.move.mag)}`);
    i = r.step(9);
    near(i.move.mag, 1, 1e-9, 'keyboard reaches full analogue magnitude after the 0.11 s ramp');
    near(i.move.x, 0, 1e-12, 'W alone has no lateral component');
    near(i.move.z, 1, 1e-9, 'W maps to +Z at camera yaw 0');

    r.src.setKey('KeyD', true);
    i = r.step(20);
    near(Math.hypot(i.move.x, i.move.z), 1, 1e-9, 'W+D is normalised, not 1.414 — no diagonal speed bug');
    // At yaw 0 the lens looks down +Z, so screen-right is -X. This expectation
    // used to be +X, which is what shipped the mirrored strafe.
    near(i.move.x, -Math.SQRT1_2, 1e-9, 'diagonal splits evenly on X');
    near(i.move.z, Math.SQRT1_2, 1e-9, 'diagonal splits evenly on Z');

    r.src.setKey('KeyW', false);
    r.src.setKey('KeyD', false);
    i = r.step(10);
    near(i.move.mag, 0, 1e-9, 'release falls to zero inside the 0.07 s release ramp');
  }

  // --- camera-relative movement ----------------------------------------
  {
    const r = rig();
    r.h.cameraYaw = Math.PI / 2;
    r.src.setKey('KeyW', true);
    const i = r.step(20);
    near(i.move.x, 1, 1e-9, 'with the camera looking down +X, forward is +X');
    near(i.move.z, 0, 1e-9, 'and has no +Z component');
  }

  /**
   * --- the lateral axis is not mirrored ---------------------------------
   *
   * This is the assertion the file was missing, and its absence let the
   * controls ship inverted: the block above only ever pressed W, so a sign
   * error on the strafe term was invisible.
   *
   * Ground truth is three.js, not algebra. For a camera with yaw y the lens
   * looks along (sin y, cos y) and column 0 of its `matrixWorld` — screen
   * right — is (-cos y, sin y). These are right-handed axes, so a camera
   * looking down +Z has +X on its LEFT. Verified directly against
   * `THREE.PerspectiveCamera.lookAt` for the real tele rig geometry
   * (x = -42, y = 22, dollying along z); every configuration agreed.
   */
  {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 1.034, 2.108]) {
      const r = rig();
      r.h.cameraYaw = yaw;
      r.src.setKey('KeyD', true);
      const i = r.step(20);
      const rx = -Math.cos(yaw), rz = Math.sin(yaw);
      near(i.move.x, rx, 1e-6, `strafing right at yaw ${yaw.toFixed(3)} goes screen-right in x`);
      near(i.move.z, rz, 1e-6, `strafing right at yaw ${yaw.toFixed(3)} goes screen-right in z`);
    }
  }

  // Forward and strafe must stay perpendicular and correctly handed. With
  // f = (sin y, cos y) and r = (-cos y, sin y) the planar cross product
  // f.x*r.z - f.z*r.x is sin^2 + cos^2 = +1 for every yaw; it is -1 exactly
  // when the lateral axis is mirrored, which is the bug this guards.
  {
    const yaw = 0.7;
    const f = rig(); f.h.cameraYaw = yaw; f.src.setKey('KeyW', true);
    const fi = f.step(20);
    const s = rig(); s.h.cameraYaw = yaw; s.src.setKey('KeyD', true);
    const si = s.step(20);
    near(fi.move.x * si.move.x + fi.move.z * si.move.z, 0, 1e-6,
      'forward and strafe are perpendicular');
    near(fi.move.x * si.move.z - fi.move.z * si.move.x, 1, 1e-6,
      'strafe-right sits clockwise of forward, not anticlockwise');
  }

  // --- pad beats keyboard, analogue sprint ------------------------------
  {
    const r = rig();
    r.src.addPad(0, { mapping: 'standard' });
    r.src.setKey('KeyW', true);
    r.step(30);
    r.src.setAxis(0, 1, -1);                 // stick fully forward (Y is inverted)
    r.src.setButton(0, 7, 0.5);              // right trigger half pulled
    const i = r.step(2);
    near(i.move.z, 1, 1e-9, 'a fully deflected pad stick wins over the keyboard');
    ok(i.move.sprint > 0.3 && i.move.sprint < 0.5, 'half-pulled trigger gives partial sprint',
      `sprint=${fmt(i.move.sprint)}`);
    r.src.setButton(0, 7, 1);
    const j = r.step(1);
    near(j.move.sprint, 1, 1e-9, 'full trigger = full sprint');
    r.src.setButton(0, 6, 1);
    const k = r.step(1);
    near(k.move.brake, 1, 1e-9, 'left trigger drives the analogue brake');
  }

  // --- buffered throw through a closed gate -----------------------------
  {
    const r = rig();
    r.h.setGates({ canThrow: false, hasDisc: true });
    r.src.setMouse(0, true);
    let i = r.step(1);
    ok(!i.charge.active, 'the gate is shut, so no charge starts');
    i = r.step(10);                          // 0.092 s of buffered press
    ok(!i.charge.active, 'still nothing after 11 steps');
    r.h.setGates({ canThrow: true });
    i = r.step(1);
    ok(i.charge.active, 'the buffered press fires the moment the gate opens (0.1 s late)');
    ok(r.h.buffer.age('throw', r.now()) < 0, 'and the buffered press was consumed');

    // Too late: outside the 0.14 s throw window.
    const r2 = rig();
    r2.h.setGates({ canThrow: false });
    r2.src.setMouse(0, true);
    r2.step(1);
    r2.src.setMouse(0, false);
    r2.step(20);                             // 0.175 s
    r2.h.setGates({ canThrow: true });
    const j = r2.step(1);
    ok(!j.charge.active, 'a press older than the buffer window is correctly forgotten');
  }

  // --- full throw through the human path --------------------------------
  {
    const r = rig();
    r.src.setMouse(0, true);
    r.step(102);
    r.src.setMouse(0, false);
    const i = r.step(1);
    ok(i.release.fired, 'the throw left the hand');
    near(i.release.hold, 0.85, 1e-6, 'the human path reproduces the 0.85 s perfect hold');
    near(i.release.quality, 1, 1e-6, 'and grades it 1.0');
    eq(i.release.type, 'backhand', 'no modifier held = backhand');

    const r2 = rig();
    r2.src.setKey('KeyQ', true);             // forehand modifier
    r2.src.setMouse(0, true);
    r2.step(60);
    r2.src.setMouse(0, false);
    const j = r2.step(1);
    eq(j.release.type, 'forehand', 'holding Q throws a forehand');

    const r3 = rig();
    r3.src.setMouse(0, true);
    r3.step(40);
    r3.src.setKey('Escape', true);
    const k = r3.step(1);
    ok(k.cancel, 'Escape cancels the charge');
    ok(k.fake, 'a 0.34 s cancel sells as a pump fake');
    ok(!k.charge.active, 'the charge is gone');
    ok(!k.release.fired, 'and nothing was thrown');
  }

  // --- receiver select and the held-direction cut -----------------------
  {
    const r = rig();
    r.src.addPad(0, { mapping: 'standard' });
    r.src.setAxis(0, 2, 1);                  // right stick hard right
    let i = r.step(1);
    ok(i.receiver.selectFresh, 'pushing the aim stick commits a directional receiver select');
    near(i.receiver.selectX, -1, 1e-9, 'the select direction is screen-right, which is -X at camera yaw 0');
    ok(!i.receiver.callCut, 'one step of hold is not a cut call');
    i = r.step(20);                          // 0.175 s total
    ok(!i.receiver.callCut, 'still under the 0.18 s cut threshold', `held=${fmt(i.receiver.holdTime)}`);
    i = r.step(2);
    ok(i.receiver.callCut, 'holding the direction past 0.18 s calls an active cut',
      `held=${fmt(i.receiver.holdTime)}`);
    r.src.setAxis(0, 2, 0);
    r.src.setAxis(0, 3, -1);                 // swing to straight ahead
    i = r.step(1);
    ok(i.receiver.selectFresh, 'a >60 deg swing re-selects rather than continuing the hold');
    near(i.receiver.holdTime, 0, 1e-12, 'and restarts the cut timer');

    // Cycling.
    r.src.setButton(0, 13, 1);               // d-pad down = receiverNext
    i = r.step(1);
    eq(i.receiver.cycle, 1, 'd-pad down cycles to the next receiver');
    i = r.step(1);
    eq(i.receiver.cycle, 0, 'and does not repeat while held');

    // Keyboard direct-select on the number row.
    r.src.setKey('Digit3', true);
    i = r.step(1);
    eq(i.receiver.slot, 2, 'Digit3 direct-selects receiver slot 2');
    i = r.step(1);
    eq(i.receiver.slot, -1, 'direct-select is an edge, not a hold');
    r.src.setKey('Digit3', false);
    r.src.setKey('Digit1', true);
    i = r.step(1);
    eq(i.receiver.slot, 0, 'switching to Digit1 selects slot 0');
  }

  // --- defence verbs -----------------------------------------------------
  {
    const r = rig();
    r.h.setGates({ onDefence: true, hasDisc: false });
    eq(r.h.intent.defence.force, 1, 'force starts on the +X sideline');
    r.src.setKey('KeyT', true);
    let i = r.step(1);
    ok(i.defence.forceFlipped, 'T flips the force');
    eq(i.defence.force, -1, 'force is now -X');
    r.src.setKey('KeyT', false);
    i = r.step(1);
    eq(i.defence.force, -1, 'and it stays flipped (it is a latch, not a hold)');
    ok(!i.defence.forceFlipped, 'the flip edge is one step only');

    r.src.setKey('KeyX', true);
    i = r.step(1);
    ok(i.defence.markHeld, 'X applies the mark while held');

    r.src.setKey('KeyW', true);
    r.step(20);
    r.src.setKey('KeyB', true);
    i = r.step(1);
    ok(i.defence.layout, 'B lays out');
    near(i.defence.layoutZ, 1, 1e-6, 'the layout takes its direction from the movement stick');

    r.src.setKey('Space', true);
    i = r.step(1);
    ok(i.defence.switchRequested, 'Space asks to switch defender');
  }

  // --- window blur mutes everything -------------------------------------
  {
    const r = rig();
    r.src.setKey('KeyW', true);
    r.step(30);
    r.src.focused = false;
    const i = r.step(30);
    near(i.move.mag, 0, 1e-9, 'losing window focus stops the player rather than leaving W stuck down');
  }
}

/* ============================================================= 8. switching */

section('switch-player policy');

{
  // Disc is at (0,0) heading to a receiver breaking deep at (6, 22).
  // d1 is nearest the controlled player but jogging away.
  // d2 is further from the disc but already sprinting at the threat.
  // d3 is the marker, standing on the thrower.
  const sit: SwitchSituation = { discX: 0, discZ: 0, threatX: 6, threatZ: 22, discInAir: true };
  const cands: DefenderCandidate[] = [
    { id: 1, x: 2, z: 1, vx: -1, vz: -3, stamina: 1 },
    { id: 2, x: 4, z: 12, vx: 1.5, vz: 6, stamina: 1 },
    { id: 3, x: 0.5, z: 0.5, vx: 0, vz: 0, isMarker: true, stamina: 1 },
    { id: 4, x: -14, z: 20, vx: 0, vz: 0, stamina: 1 },
  ];
  const pick = pickSwitchTarget(cands, sit, 0);
  eq(pick, 2, 'picks the defender closing on the threat, not the one nearest the disc');
  ok(switchScore(cands[1], sit) < switchScore(cands[0], sit), 'closing speed beats proximity',
    `d2 ${fmt(switchScore(cands[1], sit))} < d1 ${fmt(switchScore(cands[0], sit))}`);

  const grounded: SwitchSituation = { ...sit, discInAir: false, threatX: 1, threatZ: 1 };
  const pick2 = pickSwitchTarget(cands, grounded, 0);
  ok(pick2 !== 3, 'the marker is not volunteered while the thrower still has the disc', `picked ${pick2}`);
  ok(switchScore(cands[2], grounded) > switchScore(cands[0], grounded),
    'and the marker carries an explicit penalty even standing on the threat');

  // Stick hint steers the choice between two otherwise similar defenders.
  const twin: DefenderCandidate[] = [
    { id: 10, x: -10, z: 10, vx: 0, vz: 0 },
    { id: 11, x: 10, z: 10, vx: 0, vz: 0 },
  ];
  const centre: SwitchSituation = { discX: 0, discZ: 0, threatX: 0, threatZ: 14, discInAir: true, fromX: 0, fromZ: 0 };
  eq(pickSwitchTarget(twin, centre, -1), 10, 'with no hint the tie breaks deterministically on id');
  eq(pickSwitchTarget(twin, { ...centre, hintX: 1, hintZ: 0 }, -1), 11, 'a right-stick hint selects the right-hand defender');
  eq(pickSwitchTarget(twin, { ...centre, hintX: -1, hintZ: 0 }, -1), 10, 'a left hint selects the left-hand defender');

  // Exclusions.
  eq(pickSwitchTarget([{ id: 5, x: 0, z: 0, vx: 0, vz: 0, controlled: true }], centre, -1), -1,
    'an already-controlled defender is never offered');
  eq(pickSwitchTarget([{ id: 6, x: 0, z: 0, vx: 0, vz: 0, eligible: false }], centre, -1), -1,
    'an ineligible defender is never offered');
  eq(pickSwitchTarget([], centre, -1), -1, 'an empty roster returns -1');
  eq(pickSwitchTarget([{ id: 9, x: 1, z: 1, vx: 0, vz: 0 }], centre, 9), -1,
    'you cannot switch to yourself');

  // Determinism: the same inputs must give the same answer every time.
  let stable = true;
  const first = pickSwitchTarget(cands, sit, 0);
  for (let i = 0; i < 100; i++) if (pickSwitchTarget(cands, sit, 0) !== first) stable = false;
  ok(stable, '100 repeated calls give an identical answer');
}

/* ============================================================ 9. allocation */

section('determinism + allocation');

{
  const STEP = 1 / 120;
  const map = new ActionMap();
  const src = new ManualSources();
  const pads = new PadManager();
  const h = new HumanController(map, { playerId: 0, slot: 0 });
  h.attach(src, pads);
  const first = h.intent;
  let t = 0;
  src.setKey('KeyW', true);
  src.setMouse(0, true);
  for (let i = 0; i < 500; i++) { t += STEP; pads.update(src.pads(), t); h.step(STEP, t); src.endStep(); }
  ok(h.intent === first, 'the intent object is reused across 500 steps (no per-step allocation)');

  // Two identical runs must produce identical numbers.
  function runOnce(): string {
    const m2 = new ActionMap();
    const s2 = new ManualSources();
    const p2 = new PadManager();
    const h2 = new HumanController(m2, { playerId: 0, slot: 0 });
    h2.attach(s2, p2);
    s2.addPad(0, { mapping: 'standard' });
    let tt = 0;
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      s2.setAxis(0, 0, Math.sin(i * 0.07) * 0.9);
      s2.setAxis(0, 1, Math.cos(i * 0.11) * 0.9);
      s2.setButton(0, 0, i > 30 && i < 140 ? 1 : 0);
      tt += STEP;
      p2.update(s2.pads(), tt);
      const it = h2.step(STEP, tt);
      s2.endStep();
      out.push(it.move.x, it.move.z, it.charge.power, it.charge.quality, it.release.fired ? 1 : 0);
    }
    return out.map((n) => n.toFixed(12)).join(',');
  }
  eq(runOnce(), runOnce(), 'two identical scripted runs produce bit-identical intent streams');

  const src2 = new ManualSources();
  const p3 = new PadManager();
  const m3 = new ActionMap();
  const h3 = new HumanController(m3, { playerId: 0, slot: 0 });
  h3.attach(src2, p3);
  const noAlloc = h3.step(STEP, STEP);
  ok(noAlloc.move.mag === 0 && !noAlloc.charge.active,
    'a controller with no devices attached produces a quiet, valid intent');
}

/* ==================================================== 10. InputSystem wiring */

section('InputSystem (the System entry point)');

{
  const STEP = 1 / 120;

  function fakeCtx(yaw: number, capture = false) {
    const events: { evt: string; payload: any }[] = [];
    const e = new Array(16).fill(0);
    e[0] = 1; e[5] = 1; e[10] = 1; e[15] = 1;
    e[8] = -Math.sin(yaw); e[10] = -Math.cos(yaw);
    return {
      events,
      ctx: {
        capture,
        camera: { matrixWorld: { elements: e } },
        sys: {} as Record<string, unknown>,
        events: { emit(evt: string, payload: any) { events.push({ evt, payload }); }, on() { return () => {}; } },
      } as any,
    };
  }

  // --- throw event round trip -------------------------------------------
  {
    const { ctx, events } = fakeCtx(0);
    const sys = new InputSystem();
    sys.init(ctx);
    const src = new ManualSources();
    sys.setSources(src);

    src.setMouse(0, true);
    for (let i = 0; i < 102; i++) sys.update(STEP, ctx);
    src.setMouse(0, false);
    sys.update(STEP, ctx);

    const thrown = events.filter((e) => e.evt === 'input:throw');
    eq(thrown.length, 1, 'exactly one input:throw event fired');
    near(thrown[0].payload.release.quality, 1, 1e-6, 'the event carries a perfect release');
    near(thrown[0].payload.release.hold, 0.85, 1e-6, 'and the 0.85 s hold');
    eq(sys.intentFor(0), sys.intent, 'intentFor(controlled player) returns the live intent');
    eq(sys.intentFor(999).playerId, -1, 'an unknown player gets the quiet idle intent');
  }

  // --- camera-relative movement through the system ----------------------
  {
    const { ctx } = fakeCtx(Math.PI / 2);
    const sys = new InputSystem();
    sys.init(ctx);
    const src = new ManualSources();
    sys.setSources(src);
    src.setKey('KeyW', true);
    for (let i = 0; i < 30; i++) sys.update(STEP, ctx);
    near(sys.intent.move.x, 1, 1e-6, 'camera yaw is read off the camera matrix (looking down +X)');
    near(sys.intent.move.z, 0, 1e-6, 'and forward has no +Z component');
  }

  // --- pad hot-plug event ------------------------------------------------
  {
    const { ctx, events } = fakeCtx(0);
    const sys = new InputSystem();
    sys.init(ctx);
    const src = new ManualSources();
    sys.setSources(src);
    sys.update(STEP, ctx);
    src.addPad(0, { id: 'Test Pad', mapping: 'standard' });
    sys.update(STEP, ctx);
    const padEvents = events.filter((e) => e.evt === 'input:pad');
    eq(padEvents.length, 1, 'a hot-plugged pad emits input:pad');
    eq(padEvents[0].payload.connected, true, 'flagged connected');
    src.setButton(0, 0, 1);
    sys.update(STEP, ctx);
    eq(sys.device, 'pad', 'the device kind flips to pad on real pad input');
    eq(events.filter((e) => e.evt === 'input:device').length, 1, 'and announces it once');
  }

  // --- switch policy wired through a host --------------------------------
  {
    const { ctx, events } = fakeCtx(0);
    const sys = new InputSystem();
    sys.init(ctx);
    const src = new ManualSources();
    sys.setSources(src);

    let controlled = -1;
    ctx.sys.game = {
      controlledPlayerId: 0,
      intentGates: () => ({ onDefence: true, hasDisc: false, canThrow: false }),
      playerFacing: () => 0,
      defenderCandidates: () => ([
        { id: 1, x: 1, z: 1, vx: 0, vz: 0 },
        { id: 2, x: 3, z: 15, vx: 0, vz: 7 },
      ]),
      switchSituation: () => ({ discX: 0, discZ: 0, threatX: 4, threatZ: 20, discInAir: true }),
      setControlledPlayer: (id: number) => { controlled = id; },
    };

    src.setKey('Space', true);
    sys.update(STEP, ctx);
    const sw = events.filter((e) => e.evt === 'input:switch');
    eq(sw.length, 1, 'Space emits input:switch');
    eq(sw[0].payload.toId, 2, 'and the policy picked the defender closing on the threat');
    eq(controlled, 2, 'the host was told to take that player');

    // Same press with no host: degrade gracefully rather than throw.
    const bare = fakeCtx(0);
    const sys2 = new InputSystem();
    sys2.init(bare.ctx);
    const src2 = new ManualSources();
    sys2.setSources(src2);
    src2.setKey('Space', true);
    sys2.update(STEP, bare.ctx);
    eq(bare.events.filter((e) => e.evt === 'input:switch')[0].payload.toId, -1,
      'with no game peer the switch resolves to -1 instead of throwing');
  }

  // --- capture mode is inert ---------------------------------------------
  {
    const { ctx, events } = fakeCtx(0, true);
    const sys = new InputSystem();
    sys.init(ctx);
    const src = new ManualSources();
    sys.setSources(src);
    src.setKey('KeyW', true);
    src.setMouse(0, true);
    for (let i = 0; i < 200; i++) sys.update(STEP, ctx);
    near(sys.intent.move.mag, 0, 1e-12, 'capture mode produces no input (screenshots stay deterministic)');
    eq(events.filter((e) => e.evt === 'input:throw').length, 0, 'and no throws');
  }

  // --- config persistence round trip -------------------------------------
  {
    const { ctx } = fakeCtx(0);
    const sys = new InputSystem();
    sys.init(ctx);
    sys.rebind('bid', { keys: ['KeyM'], mouse: [], pad: ['x'] });
    const json = sys.map.serialize();
    const sys2 = new InputSystem();
    sys2.applyConfig(JSON.parse(json));
    eq(sys2.map.binding('bid').keys[0], 'KeyM', 'a rebind survives applyConfig from serialised JSON');
    eq(sys2.map.serialize(), json, 'and the whole config matches');
  }
}

/* ------------------------------------------------------------------ report */

console.log(`\n${'═'.repeat(72)}`);
if (failed === 0) {
  console.log(`\x1b[32m\x1b[1mPASS\x1b[0m  ${passed} assertions, 0 failures`);
} else {
  console.log(`\x1b[31m\x1b[1mFAIL\x1b[0m  ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log(`      - ${f}`);
}
console.log(`${'═'.repeat(72)}`);
process.exit(failed === 0 ? 0 : 1);
