/**
 * tools/test-move.ts — acceptance tests for personal-space separation
 * (src/sim/move/Separation.ts) and for the locomotion numbers it must not cost.
 *
 *   node tools/test-move.ts
 *   node tools/test-move.ts --seconds 400      longer match sample
 *
 * Written because the blind critic's most damaging note was that "bodies
 * interpenetrate everywhere; defenders and cutters fuse into one silhouette".
 * The hard-contact solver was doing its job — nothing was actually overlapping
 * — but it is a floor at 0.64 m centre to centre, and bodies were PILING UP ON
 * IT: over 300 s of match play, 54 % of frames had some pair sitting on the
 * contact radius. With a shoulder half-width of ~0.28 m that is 8 cm of
 * daylight, which is not two athletes, it is one blob.
 *
 * So the assertions here are about *distributions over a whole match*, not
 * about a single contact. A model that never interpenetrates and still reads
 * as a blob passes the old tests and fails these.
 *
 * Sections:
 *   1  the separation model in isolation — settles, never oscillates
 *   2  it does not fight the commanded direction
 *   3  it does not touch airborne or committed bodies
 *   4  the locomotion numbers are unchanged (the regression guard)
 *   5  a whole match: minimum inter-body distance and blob statistics
 *   6  vertical placement — no body's feet go under the turf
 *   7  determinism and cost
 */

import * as THREE from 'three';
import { EventBus, QUALITY_PRESETS, Rng, type Ctx } from '../src/core/Ctx.ts';
import { Locomotion } from '../src/sim/Locomotion.ts';
import { GameSystem } from '../src/sim/Game.ts';
import { PRONE_Y } from '../src/sim/move/Contest.ts';
import { PERSONAL_RADIUS, SEP_RATE } from '../src/sim/move/Separation.ts';
import type { DesiredMove, LocoPlayer } from '../src/sim/move/Types.ts';

const DT = 1 / 120;

const argv = process.argv.slice(2);
const flag = (n: string, d: number): number => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : Number(argv[i + 1]);
};
const SECONDS = flag('seconds', 300);

/* ------------------------------------------------------------ tiny harness */

let passed = 0;
let failed = 0;
const failures: string[] = [];

function fmt(v: number): string {
  return Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)) : String(v);
}
function ok(name: string, cond: boolean, detail: string): void {
  if (cond) { passed++; console.log(`  PASS  ${name.padEnd(52)} ${detail}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name.padEnd(52)} ${detail}`); }
}
function between(name: string, v: number, lo: number, hi: number, unit = ''): void {
  ok(name, v >= lo && v <= hi, `${fmt(v)}${unit} (want ${fmt(lo)}..${fmt(hi)}${unit})`);
}
function section(t: string): void { console.log(`\n${t}\n${'-'.repeat(t.length)}`); }
function note(s: string): void { console.log(`   ${s}`); }

/* -------------------------------------------------------------- fake host */

function makeLoco(): Locomotion {
  const loco = new Locomotion();
  loco.attach({ events: { emit: () => {} }, rand: new Rng(0xC0FFEE), sys: {} });
  return loco;
}

const AVERAGE = {
  speed: 68, accel: 66, agility: 66, strength: 62,
  vertical: 60, endurance: 65, balance: 65, height: 1.80, mass: 82,
};
const ELITE = {
  speed: 92, accel: 90, agility: 88, strength: 72,
  vertical: 84, endurance: 82, balance: 80, height: 1.86, mass: 84,
};

const dir = (x: number, z: number) => new THREE.Vector3(x, 0, z);
const spd = (p: LocoPlayer) => Math.hypot(p.vel.x, p.vel.z);
const gap = (a: LocoPlayer, b: LocoPlayer) => Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z);

function drive(loco: Locomotion, ps: LocoPlayer[], ds: DesiredMove[], seconds: number,
  onStep?: (t: number) => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < ps.length; k++) loco.step(ps[k], ds[k], DT);
    loco.resolveCollisions(DT);
    onStep?.((i + 1) * DT);
  }
}

/* ====================================================================== 1 */

function testSettle(): void {
  section('1. Personal space settles, and never oscillates');

  const target = 2 * PERSONAL_RADIUS;

  // (a) Two idle bodies dumped on top of each other.
  {
    const loco = makeLoco();
    const a = loco.create({ id: 1, attr: AVERAGE, pos: new THREE.Vector3(-0.15, 0, 0) });
    const b = loco.create({ id: 2, attr: AVERAGE, pos: new THREE.Vector3(0.15, 0, 0) });
    const d: number[] = [];
    drive(loco, [a, b], [{}, {}], 6, () => d.push(gap(a, b)));

    // Monotone approach: the gap must never shrink between steps. A single
    // reversal is the signature of two bodies shoving each other in alternate
    // frames, which reads worse on screen than the overlap it is fixing.
    let reversals = 0, worstBack = 0;
    for (let i = 1; i < d.length; i++) {
      const dd = d[i] - d[i - 1];
      if (dd < -1e-9) { reversals++; worstBack = Math.max(worstBack, -dd); }
    }
    const settle = d[d.length - 1];
    const tailDrift = Math.abs(d[d.length - 1] - d[d.length - 121]);
    note(`overlapped 0.30 m apart -> settled at ${fmt(settle)} m over 6 s ` +
      `(personal sum ${fmt(target)} m), last-second drift ${(tailDrift * 1000).toFixed(3)} mm`);
    between('two idle bodies settle at personal distance', settle, target - 0.05, target + 0.01, ' m');
    ok('the approach never reverses', reversals === 0,
      `${reversals} reversals, worst ${(worstBack * 1e6).toFixed(2)} um`);
    ok('settled: no residual drift', tailDrift < 2e-3, `${(tailDrift * 1000).toFixed(3)} mm/s`);
    ok('separation writes no velocity', spd(a) < 1e-9 && spd(b) < 1e-9,
      `${fmt(spd(a))} / ${fmt(spd(b))} m/s`);
  }

  // (b) A seven-body pile. Every pair must clear, and nothing may gain energy.
  {
    const loco = makeLoco();
    const pack: LocoPlayer[] = [];
    const rng = new Rng(7);
    for (let i = 0; i < 7; i++) {
      pack.push(loco.create({
        id: i, attr: AVERAGE,
        pos: new THREE.Vector3(rng.range(-0.4, 0.4), 0, rng.range(-0.4, 0.4)),
      }));
    }
    let maxV = 0;
    const closest: number[] = [];
    drive(loco, pack, pack.map(() => ({})), 8, () => {
      for (const q of pack) maxV = Math.max(maxV, spd(q));
      let w = Infinity;
      for (let i = 0; i < pack.length; i++) {
        for (let j = i + 1; j < pack.length; j++) w = Math.min(w, gap(pack[i], pack[j]));
      }
      closest.push(w);
    });
    const worst = closest[closest.length - 1];
    let reversals = 0;
    for (let i = 400; i < closest.length; i++) if (closest[i] < closest[i - 1] - 1e-6) reversals++;
    note(`7-body pile: closest pair ends ${fmt(worst)} m apart, peak |v| ${fmt(maxV)} m/s`);
    ok('a pile spreads to personal distance', worst > target - 0.10, `${fmt(worst)} m`);
    ok('the pile adds no energy', maxV < 1e-9, `peak ${fmt(maxV)} m/s`);
    ok('the pile does not churn once spread', reversals === 0, `${reversals} reversals`);
  }
}

/* ====================================================================== 2 */

function testIntentPreserved(): void {
  section('2. Separation does not fight the commanded direction');

  // (a) A marker sent to a spot 2.15 m off a stationary thrower must arrive.
  //     This is the AI's actual mark stand-off (Playbook PLAY.markDistance).
  {
    const loco = makeLoco();
    const thrower = loco.create({ id: 1, attr: AVERAGE, pos: new THREE.Vector3(0, 0, 0) });
    const marker = loco.create({ id: 2, attr: AVERAGE, pos: new THREE.Vector3(0, 0, 7) });
    const spot = { x: 0, z: 2.15 };
    let n = Math.round(6 / DT);
    for (let i = 0; i < n; i++) {
      const dx = spot.x - marker.pos.x, dz = spot.z - marker.pos.z;
      const d = Math.hypot(dx, dz);
      loco.step(marker, d > 1e-4
        ? { dir: dir(dx / d, dz / d), speed: Math.min(6, d * 3), mode: 'run' }
        : {}, DT);
      loco.step(thrower, {}, DT);
      loco.resolveCollisions(DT);
    }
    const err = Math.hypot(marker.pos.x - spot.x, marker.pos.z - spot.z);
    const stand = gap(thrower, marker);
    const drift = Math.hypot(thrower.pos.x, thrower.pos.z);
    note(`marker settled ${fmt(err)} m from the mark spot, ` +
      `${fmt(stand)} m off the thrower; thrower drifted ${(drift * 1000).toFixed(1)} mm`);
    ok('the marker still reaches the mark', err < 0.15, `${fmt(err)} m`);
    ok('the thrower is not shoved off the pivot', drift < 0.02, `${(drift * 1000).toFixed(1)} mm`);
    void n;
  }

  // (b) A cutter sprints a straight lane through a static body. Separation is
  //     allowed to move the cutter across the lane to get round; it is never
  //     allowed to cost downfield speed. What braking there is must come from
  //     the hard-contact tier — an actual collision, which should cost speed
  //     and should raise a foul — and separation must strictly reduce it.
  {
    const pass = (offset: number, separate: boolean) => {
      const loco = makeLoco();
      loco.separate = separate;
      const cutter = loco.create({ id: 1, attr: ELITE, pos: new THREE.Vector3(0, 0, -20) });
      const post = loco.create({ id: 2, attr: AVERAGE, pos: new THREE.Vector3(offset, 0, 0) });
      let minZSpeed = Infinity, closest = Infinity;
      const n = Math.round(7 / DT);
      for (let i = 0; i < n; i++) {
        loco.step(cutter, { dir: dir(0, 1), mode: 'sprint' }, DT);
        loco.step(post, {}, DT);
        loco.resolveCollisions(DT);
        closest = Math.min(closest, gap(cutter, post));
        if (cutter.pos.z > -6 && cutter.pos.z < 6) minZSpeed = Math.min(minZSpeed, cutter.vel.z);
      }
      return { minZSpeed, closest, endZ: cutter.pos.z, offX: Math.abs(cutter.pos.x) };
    };

    // Clear of each other: separation widens the miss and costs nothing.
    const wideOn = pass(0.80, true), wideOff = pass(0.80, false);
    note(`0.80 m miss: closest ${fmt(wideOff.closest)} -> ${fmt(wideOn.closest)} m, ` +
      `downfield speed ${fmt(wideOff.minZSpeed)} -> ${fmt(wideOn.minZSpeed)} m/s`);
    ok('a clean pass is not braked at all', wideOn.minZSpeed > 8.5, `${fmt(wideOn.minZSpeed)} m/s`);
    ok('and the miss is widened', wideOn.closest > wideOff.closest + 0.05,
      `${fmt(wideOff.closest)} -> ${fmt(wideOn.closest)} m`);

    // Dead-on: without separation the cutter is stopped in its tracks. With it
    // the two bodies step round each other and the cutter runs their lane.
    const headOn = pass(0.0, true), headOff = pass(0.0, false);
    note(`dead-on: downfield speed ${fmt(headOff.minZSpeed)} -> ${fmt(headOn.minZSpeed)} m/s, ` +
      `ended z=${fmt(headOff.endZ)} -> ${fmt(headOn.endZ)}, cutter ${fmt(headOn.offX)} m off the line`);
    ok('separation rescues a dead-on convergence', headOn.minZSpeed > headOff.minZSpeed + 1.0,
      `${fmt(headOff.minZSpeed)} -> ${fmt(headOn.minZSpeed)} m/s`);
    ok('the cutter still runs the lane', headOn.endZ > 20, `z=${fmt(headOn.endZ)}`);
    ok('and gets round rather than through', headOn.offX > 0.05, `${fmt(headOn.offX)} m off the line`);

    // Glancing: separation must never make any of it worse.
    const glanceOn = pass(0.35, true), glanceOff = pass(0.35, false);
    note(`0.35 m glance: downfield speed ${fmt(glanceOff.minZSpeed)} -> ${fmt(glanceOn.minZSpeed)} m/s, ` +
      `ended z=${fmt(glanceOff.endZ)} -> ${fmt(glanceOn.endZ)}`);
    ok('separation never costs downfield speed',
      glanceOn.minZSpeed >= glanceOff.minZSpeed - 1e-9 && wideOn.minZSpeed >= wideOff.minZSpeed - 1e-9,
      `glance ${fmt(glanceOn.minZSpeed)} >= ${fmt(glanceOff.minZSpeed)}`);
  }

  // (c) Two bodies on an exact head-on collision course must pick a side and
  //     hold it — the degenerate case where there is no lateral component of
  //     the normal to preserve.
  {
    const loco = makeLoco();
    const a = loco.create({ id: 1, attr: AVERAGE, pos: new THREE.Vector3(0, 0, -12) });
    const b = loco.create({ id: 2, attr: AVERAGE, pos: new THREE.Vector3(0, 0, 12) });
    const sides: number[] = [];
    drive(loco, [a, b], [{ dir: dir(0, 1), mode: 'run' }, { dir: dir(0, -1), mode: 'run' }], 8,
      () => { if (Math.abs(a.pos.z - b.pos.z) < 4) sides.push(Math.sign(a.pos.x - b.pos.x) || 0); });
    let flips = 0;
    for (let i = 1; i < sides.length; i++) if (sides[i] !== 0 && sides[i - 1] !== 0 && sides[i] !== sides[i - 1]) flips++;
    const closest = Math.min(...sides.map(() => 0)) || 0;
    void closest;
    note(`head-on pass: ${sides.length} close frames, ${flips} side changes, ` +
      `lateral offset at closest ${fmt(Math.abs(a.pos.x - b.pos.x))} m`);
    ok('a head-on pair picks a side', sides.length > 0 && sides.some((s) => s !== 0), `${sides.length} frames`);
    ok('and does not swap sides mid-pass', flips <= 1, `${flips} flips`);
  }
}

/* ====================================================================== 3 */

function testCommittedBodies(): void {
  section('3. Airborne and committed bodies are never perturbed');

  // A body mid-layout is a projectile. Its arc is read by the catch solver and
  // by the animation; a separation nudge would desync both.
  const loco = makeLoco();
  const flyer = loco.create({ id: 1, attr: ELITE, pos: new THREE.Vector3(0, 0, 0) });
  const post = loco.create({ id: 2, attr: AVERAGE, pos: new THREE.Vector3(0, 0, 2.2) });

  // Wind up, then bid.
  drive(loco, [flyer, post], [{ dir: dir(0, 1), mode: 'sprint' }, {}], 1.4);
  let airX: number[] = [], airZ: number[] = [], airVX: number[] = [], airVZ: number[] = [];
  const n = Math.round(2.5 / DT);
  for (let i = 0; i < n; i++) {
    loco.step(flyer, { dir: dir(0, 1), mode: 'sprint', layout: i === 0 }, DT);
    loco.step(post, {}, DT);
    loco.resolveCollisions(DT);
    if (flyer.air.airborne) { airX.push(flyer.pos.x); airZ.push(flyer.pos.z); airVX.push(flyer.vel.x); airVZ.push(flyer.vel.z); }
  }
  // While airborne, horizontal velocity is constant (no drag in the model) and
  // position must be exactly the integral of it. Any separation nudge shows up
  // as a step that does not match.
  let worst = 0;
  for (let i = 1; i < airX.length; i++) {
    worst = Math.max(worst,
      Math.abs((airX[i] - airX[i - 1]) - airVX[i - 1] * DT),
      Math.abs((airZ[i] - airZ[i - 1]) - airVZ[i - 1] * DT));
  }
  note(`layout: ${airX.length} airborne frames past a body 2.2 m away, ` +
    `worst deviation from the ballistic integral ${(worst * 1e6).toFixed(3)} um`);
  ok('a layout arc is untouched by separation', airX.length > 30 && worst < 1e-9,
    `${airX.length} frames, ${(worst * 1e6).toFixed(3)} um`);

  // And the body that got laid out over is the one that steps aside.
  note(`post ended ${fmt(Math.hypot(post.pos.x, post.pos.z - 2.2))} m off its start, ` +
    `state ${flyer.state}, prone ${flyer.prone}`);
  ok('the upright body is the one that yields', Math.hypot(post.pos.x, post.pos.z - 2.2) > 0.05,
    `${fmt(Math.hypot(post.pos.x, post.pos.z - 2.2))} m`);
}

/* ====================================================================== 4 */

/**
 * The regression guard. These four numbers are the shipped feel of the model
 * and they are asserted in tools/test-locomotion.ts as well; if separation
 * moved any of them, that is a real regression, not an acceptable cost.
 */
function testLocomotionUnchanged(): void {
  section('4. Separation costs the locomotion numbers nothing');

  const runOne = <T>(fn: (loco: Locomotion) => T): [T, T] => {
    const withSep = makeLoco();
    const a = fn(withSep);
    const without = makeLoco();
    without.separate = false;
    const b = fn(without);
    return [a, b];
  };

  // (a) 40 m dash, elite, ~5.03 s.
  {
    const [on, off] = runOne((loco) => {
      const p = loco.create({ id: 1, attr: ELITE });
      let t = 0;
      for (let i = 0; i < 120 * 12; i++) {
        loco.step(p, { dir: dir(0, 1), mode: 'sprint' }, DT);
        loco.resolveCollisions(DT);
        t += DT;
        if (p.pos.z >= 40) break;
      }
      return t;
    });
    note(`40 m dash: ${fmt(on)} s with separation, ${fmt(off)} s without`);
    between('40 m dash still ~5.03 s', on, 4.90, 5.20, ' s');
    ok('separation does not change the 40 m dash', Math.abs(on - off) < 1e-9,
      `${(Math.abs(on - off) * 1e6).toFixed(3)} us`);
  }

  // (b) A 90 degree cut keeps ~66.7 % of entry speed.
  {
    const [on, off] = runOne((loco) => {
      const p = loco.create({ id: 1, attr: ELITE });
      for (let i = 0; i < 120 * 6; i++) {
        loco.step(p, { dir: dir(0, 1), mode: 'sprint' }, DT);
        loco.resolveCollisions(DT);
      }
      const entry = spd(p);
      let min = entry;
      for (let i = 0; i < 120 * 1.2; i++) {
        loco.step(p, { dir: dir(1, 0), mode: 'sprint' }, DT);
        loco.resolveCollisions(DT);
        min = Math.min(min, spd(p));
      }
      return min / entry;
    });
    note(`90 deg cut retains ${(on * 100).toFixed(1)} % with separation, ` +
      `${(off * 100).toFixed(1)} % without`);
    between('90 deg cut still keeps ~66.7 %', on, 0.62, 0.71);
    ok('separation does not change the cut', Math.abs(on - off) < 1e-12,
      `${(Math.abs(on - off) * 1e9).toFixed(3)} ppb`);
  }

  // (c) Backpedal tops out at 0.553x sprint.
  {
    const [on, off] = runOne((loco) => {
      const p = loco.create({ id: 1, attr: ELITE });
      let back = 0, fwd = 0;
      for (let i = 0; i < 120 * 8; i++) {
        loco.step(p, { dir: dir(0, 1), mode: 'backpedal', face: { x: 0, z: -1 } }, DT);
        loco.resolveCollisions(DT);
        back = Math.max(back, spd(p));
      }
      const q = loco.create({ id: 2, attr: ELITE });
      for (let i = 0; i < 120 * 8; i++) {
        loco.step(q, { dir: dir(0, 1), mode: 'sprint' }, DT);
        loco.resolveCollisions(DT, [q]);
        fwd = Math.max(fwd, spd(q));
      }
      return back / fwd;
    });
    note(`backpedal ratio ${fmt(on)} with separation, ${fmt(off)} without`);
    between('backpedal still 0.553x sprint', on, 0.53, 0.58);
    ok('separation does not change the backpedal', Math.abs(on - off) < 1e-12,
      `${(Math.abs(on - off) * 1e9).toFixed(3)} ppb`);
  }

  // (d) A layout is out of the play for ~2.04 s.
  {
    const [on, off] = runOne((loco) => {
      const p = loco.create({ id: 1, attr: ELITE });
      for (let i = 0; i < 120 * 3; i++) {
        loco.step(p, { dir: dir(0, 1), mode: 'sprint' }, DT);
        loco.resolveCollisions(DT);
      }
      let t = 0;
      let out = 0;
      for (let i = 0; i < 120 * 8; i++) {
        loco.step(p, { dir: dir(0, 1), mode: 'sprint', layout: i === 0 }, DT);
        loco.resolveCollisions(DT);
        t += DT;
        if (!Locomotion.isAvailable(p)) out = t;
      }
      return out;
    });
    note(`layout out of play ${fmt(on)} s with separation, ${fmt(off)} s without`);
    between('layout still ~2.04 s out of play', on, 1.90, 2.20, ' s');
    ok('separation does not change the layout', Math.abs(on - off) < 1e-9,
      `${(Math.abs(on - off) * 1e6).toFixed(3)} us`);
  }
}

/* ====================================================================== 5 */

/** See the comment at its use site in `playMatch`. */
const TEST_FIELD = {
  heightAt(x: number, z: number): number {
    const tx = Math.max(-1, Math.min(1, x / 20));
    const t2 = tx * tx;
    let h = -0.185 * t2 + 0.150 * t2 * t2;
    const tz = Math.min(1, Math.abs(z) / 66);
    h *= 1 - 0.40 * tz * tz;
    h += 0.019 * Math.sin(x * 0.131 + 1.7) * Math.cos(z * 0.097 - 0.4);
    h += 0.008 * Math.sin(x * 0.51 - 2.2) * Math.cos(z * 0.44 + 1.1);
    return h;
  },
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const d = 0.45;
    const hx = TEST_FIELD.heightAt(x + d, z) - TEST_FIELD.heightAt(x - d, z);
    const hz = TEST_FIELD.heightAt(x, z + d) - TEST_FIELD.heightAt(x, z - d);
    return out.set(-hx / (2 * d), 1, -hz / (2 * d)).normalize();
  },
};

interface MatchStats {
  minPair: number;
  frames: number;
  onFloor: number;
  under080: number;
  meanNN: number;
  dwellTotal: number;
  dwellP90: number;
  dwellMax: number;
  longEpisodes: number;
  minClearance: number;
  maxCheat: number;
  wallMs: number;
}

function playMatch(seed: number, seconds: number, separate: boolean): MatchStats {
  const ctx: Ctx = {
    renderer: null as unknown as THREE.WebGLRenderer,
    scene: null as unknown as THREE.Scene,
    camera: null as unknown as THREE.PerspectiveCamera,
    composer: null,
    time: 0, dt: 0, rawDt: 0, timeScale: 1, frame: 0,
    width: 1280, height: 720, dpr: 1,
    quality: { ...QUALITY_PRESETS.high },
    events: new EventBus(),
    rand: new Rng(seed),
    sys: Object.create(null),
    debug: false,
    capture: false,
  };
  // A crowned, undulating surface so the vertical assertions have teeth. Same
  // shape and magnitude as the shipped pitch (src/world/field/Layout.ts): a
  // quadratic 18.5 cm fall from the centre line out to x = +-20, plus a few
  // centimetres of settlement ripple. Reproduced here rather than imported
  // because Layout.ts pulls in the noise library through an extensionless
  // specifier that node's type stripper will not resolve.
  //
  // It matters because a body slid sideways by separation lands on a DIFFERENT
  // surface height than the one it was standing on, and `Players.ts` parks the
  // rig root on `loco.groundY` — so if separation moves a body without
  // re-reading the height under it, the athlete renders into the turf.
  ctx.sys['field'] = TEST_FIELD as unknown as Ctx['sys'][string];
  const game = new GameSystem();
  ctx.sys['game'] = game;
  game.init(ctx);
  game.loco.separate = separate;

  const steps = Math.round(seconds / DT);
  let minPair = Infinity, frames = 0, onFloor = 0, under080 = 0;
  let sumNN = 0, nnN = 0;
  let minClearance = Infinity, maxCheat = 0;
  const dwellStart = new Map<number, number>();
  const dwells: number[] = [];

  const t0 = Date.now();
  for (let i = 0; i < steps; i++) {
    game.update(DT, ctx);
    ctx.time += DT;
    ctx.frame++;
    if (i % 12 !== 0) continue;
    frames++;
    const ps = game.players;
    const n = ps.length;
    let fmin = Infinity;
    const nn = new Float64Array(n).fill(Infinity);
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const d = Math.hypot(ps[a].pos.x - ps[b].pos.x, ps[a].pos.z - ps[b].pos.z);
        if (d < fmin) fmin = d;
        if (d < nn[a]) nn[a] = d;
        if (d < nn[b]) nn[b] = d;
        const key = a * 100 + b;
        if (d < 0.80) {
          if (!dwellStart.has(key)) dwellStart.set(key, i * DT);
        } else if (dwellStart.has(key)) {
          dwells.push(i * DT - dwellStart.get(key)!);
          dwellStart.delete(key);
        }
      }
      // Vertical: the COM must clear the surface by at least the prone height.
      const clear = ps[a].pos.y - ps[a].groundY;
      if (clear < minClearance) minClearance = clear;
      // ...and `groundY` must be the surface actually under this body, since
      // the renderer parks the rig root on it.
      const fieldSys = ctx.sys['field'] as { heightAt?(x: number, z: number): number } | undefined;
      if (fieldSys && typeof fieldSys.heightAt === 'function') {
        const cheat = Math.abs(ps[a].groundY - fieldSys.heightAt(ps[a].pos.x, ps[a].pos.z));
        if (cheat > maxCheat) maxCheat = cheat;
      }
      if (Number.isFinite(nn[a])) { sumNN += nn[a]; nnN++; }
    }
    if (fmin < minPair) minPair = fmin;
    if (fmin < 0.64) onFloor++;
    if (fmin < 0.80) under080++;
  }
  const wallMs = Date.now() - t0;
  const srt = dwells.sort((a, b) => a - b);
  const q = (f: number) => (srt.length ? srt[Math.min(srt.length - 1, Math.floor(f * srt.length))] : 0);
  return {
    minPair, frames, onFloor, under080,
    meanNN: sumNN / Math.max(1, nnN),
    dwellTotal: dwells.reduce((a, b) => a + b, 0),
    dwellP90: q(0.90),
    dwellMax: srt.length ? srt[srt.length - 1] : 0,
    longEpisodes: dwells.filter((d) => d > 1.5).length,
    minClearance, maxCheat, wallMs,
  };
}

function testMatch(): void {
  section(`5. A whole match — inter-body distance over ${SECONDS} s of play`);

  const seeds = [20260729, 11, 777];
  const on: MatchStats[] = [];
  const off: MatchStats[] = [];
  for (const s of seeds) {
    off.push(playMatch(s, SECONDS, false));
    on.push(playMatch(s, SECONDS, true));
  }
  const mean = (xs: MatchStats[], k: keyof MatchStats) =>
    xs.reduce((a, b) => a + (b[k] as number), 0) / xs.length;
  const worst = (xs: MatchStats[], k: keyof MatchStats) =>
    Math.max(...xs.map((x) => x[k] as number));
  const least = (xs: MatchStats[], k: keyof MatchStats) =>
    Math.min(...xs.map((x) => x[k] as number));

  const floorOn = 100 * mean(on, 'onFloor') / mean(on, 'frames');
  const floorOff = 100 * mean(off, 'onFloor') / mean(off, 'frames');
  const closeOn = 100 * mean(on, 'under080') / mean(on, 'frames');
  const closeOff = 100 * mean(off, 'under080') / mean(off, 'frames');

  note(`seeds ${seeds.join(', ')}, ${SECONDS} s each, sampled at 10 Hz`);
  note(`frames with SOME pair on the 0.64 m contact floor:  ` +
    `${floorOff.toFixed(1)} % -> ${floorOn.toFixed(1)} %`);
  note(`frames with SOME pair inside 0.80 m:                ` +
    `${closeOff.toFixed(1)} % -> ${closeOn.toFixed(1)} %`);
  note(`mean nearest-neighbour distance:                    ` +
    `${mean(off, 'meanNN').toFixed(2)} m -> ${mean(on, 'meanNN').toFixed(2)} m`);
  note(`total time some pair spent inside 0.80 m:           ` +
    `${mean(off, 'dwellTotal').toFixed(0)} s -> ${mean(on, 'dwellTotal').toFixed(0)} s (per ${SECONDS} s)`);
  note(`p90 / max continuous dwell inside 0.80 m:           ` +
    `${mean(off, 'dwellP90').toFixed(1)} / ${worst(off, 'dwellMax').toFixed(1)} s -> ` +
    `${mean(on, 'dwellP90').toFixed(1)} / ${worst(on, 'dwellMax').toFixed(1)} s`);
  note(`episodes longer than 1.5 s:                         ` +
    `${mean(off, 'longEpisodes').toFixed(0)} -> ${mean(on, 'longEpisodes').toFixed(0)}`);

  // The headline. Bodies may still touch — athletes collide — but they must
  // not LIVE on the contact radius, which is what reads as a fused silhouette.
  ok('bodies rarely rest on the hard-contact floor', floorOn < 12,
    `${floorOn.toFixed(1)} % of frames (was ${floorOff.toFixed(1)} %)`);
  ok('and that is a big improvement on no separation', floorOn < floorOff * 0.4,
    `${floorOn.toFixed(1)} % vs ${floorOff.toFixed(1)} %`);
  ok('close encounters are transient, not a resting state',
    mean(on, 'dwellTotal') < 0.6 * mean(off, 'dwellTotal'),
    `${mean(on, 'dwellTotal').toFixed(0)} s vs ${mean(off, 'dwellTotal').toFixed(0)} s`);
  ok('no pair sits inside 0.80 m for more than 5 s', worst(on, 'dwellMax') < 5.0,
    `longest ${worst(on, 'dwellMax').toFixed(1)} s`);
  ok('the hard floor still holds — nothing interpenetrates',
    least(on, 'minPair') > 0.60, `min pair ${least(on, 'minPair').toFixed(3)} m`);
  ok('bodies are further apart on average', mean(on, 'meanNN') > mean(off, 'meanNN'),
    `${mean(on, 'meanNN').toFixed(2)} m vs ${mean(off, 'meanNN').toFixed(2)} m`);

  section('6. Vertical placement — nobody sinks into the pitch');
  note(`min COM clearance above the sampled surface: ${least(on, 'minClearance').toFixed(4)} m ` +
    `(prone height is ${PRONE_Y} m)`);
  note(`worst disagreement between a body's groundY and field.heightAt under it: ` +
    `${(worst(on, 'maxCheat') * 1000).toFixed(4)} mm`);
  ok('no body\'s centre of mass goes under the turf',
    least(on, 'minClearance') >= PRONE_Y - 1e-9,
    `${least(on, 'minClearance').toFixed(4)} m >= ${PRONE_Y} m`);
  // Driven through Locomotion alone the residual is exactly zero; what is left
  // here comes from the position edits Game.ts makes AFTER resolveCollisions
  // returns — the park clamp and the set-piece placements — which are not this
  // file's to re-seat. Four microns; the bar is a twentieth of a millimetre.
  ok('groundY matches the surface under the body',
    worst(on, 'maxCheat') < 5e-5, `${(worst(on, 'maxCheat') * 1e6).toFixed(3)} um`);

  section('7. Determinism and cost');
  const a = playMatch(4242, 60, true);
  const b = playMatch(4242, 60, true);
  ok('two identical runs agree bit for bit',
    a.minPair === b.minPair && a.dwellTotal === b.dwellTotal && a.meanNN === b.meanNN,
    `${a.minPair.toFixed(9)} / ${b.minPair.toFixed(9)}`);
  const withSep = mean(on, 'wallMs') / SECONDS;
  const noSep = mean(off, 'wallMs') / SECONDS;
  note(`sim cost ${noSep.toFixed(2)} -> ${withSep.toFixed(2)} ms per simulated second ` +
    `(14 bodies, 120 Hz, 91 pairs)`);
  ok('separation costs less than 25 % of the sim budget',
    withSep < noSep * 1.25 + 0.5, `${withSep.toFixed(2)} vs ${noSep.toFixed(2)} ms/s`);
}

/* ------------------------------------------------------------------- run */

console.log(`\npersonal radius ${PERSONAL_RADIUS} m (pair ${2 * PERSONAL_RADIUS} m), ` +
  `slide rate ${SEP_RATE} m/s, fixed step ${(DT * 1000).toFixed(3)} ms`);

testSettle();
testIntentPreserved();
testCommittedBodies();
testLocomotionUnchanged();
testMatch();

console.log(`\n${'='.repeat(72)}`);
if (failed === 0) console.log(`PASS  ${passed} passed, 0 failed`);
else {
  console.log(`FAIL  ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log(`      - ${f}`);
}
console.log('='.repeat(72));
process.exit(failed === 0 ? 0 : 1);
