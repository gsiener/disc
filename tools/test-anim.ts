/**
 * tools/test-anim.ts — acceptance tests for the athletes' MOTION.
 *
 *   node tools/test-anim.ts
 *   node tools/test-anim.ts --detail 0.35        # the 'low' quality tier
 *
 * Everything here is measured off the COMMITTED BONE MATRICES of real rigs
 * driven by the real `Locomotion`, one fixed 1/120 s step at a time — not off
 * the animator's intent. That distinction is the whole point: `Feet.ts` promises
 * a planted sole is stationary in the world, and the only way to falsify that
 * claim is to read the sole's world position out of `foot_L.matrixWorld` on two
 * consecutive frames and subtract.
 *
 * A screenshot cannot see any of this. Foot slip, cadence, the walk-run
 * crossover, whether a body leans into a cut or out of it, and whether fourteen
 * athletes are fourteen copies of one animation are all properties of a
 * SEQUENCE, and a sequence is exactly what the capture rigs cannot photograph.
 * So they live here, as numbers, and they cannot silently regress.
 *
 * Sections
 *   1  foot contact — slip per stance, in millimetres, across the speed ladder
 *   2  stride length and cadence scale with speed
 *   3  the gait changes MODE: walk (double support) -> run (flight phase)
 *   4  plant and turn — a hard cut leans INTO the turn
 *   5  posture — forward lean tracks acceleration, upright at cruise
 *   6  arms counter-swing the legs instead of riding them
 *   7  defensive gaits are not reversed running
 *   8  pose diversity — two athletes at one speed are not one athlete twice
 *   9  determinism and cost
 *  10  joint limits — a leg is never a stick, an arm is never a plank
 *  11  arm drive — the hand's arc, and the swept volume it costs
 *  12  the layout is flat and extended, not a body falling over
 */

import * as THREE from 'three';
import { Rng } from '../src/core/Ctx.ts';
import { buildRig, randomBodyParams } from '../src/entities/PlayerRig.ts';
import type { PlayerRig } from '../src/entities/PlayerRig.ts';
import { Locomotion } from '../src/sim/Locomotion.ts';
import type { DesiredMove, LocoPlayer } from '../src/sim/move/Types.ts';
import { Animator } from '../src/entities/Animator.ts';
import type { AnimHandle } from '../src/entities/Animator.ts';
import { stepRate } from '../src/sim/move/Gait.ts';
import { footStance } from '../src/entities/anim/Feet.ts';
import { B, NB } from '../src/entities/anim/Kine.ts';

const DT = 1 / 120;

const argv = process.argv.slice(2);
const flag = (n: string, d: number): number => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : Number(argv[i + 1]);
};
/** Rig detail. The whole suite must pass at the 'low' tier as well as 'ultra'. */
const DETAIL = flag('detail', 1);

/* ------------------------------------------------------------ tiny harness */

let passed = 0;
let failed = 0;
const failures: string[] = [];

const fmt = (v: number): string =>
  (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)) : String(v));

function ok(name: string, cond: boolean, detail: string): void {
  if (cond) { passed++; console.log(`  PASS  ${name.padEnd(54)} ${detail}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name.padEnd(54)} ${detail}`); }
}
function between(name: string, v: number, lo: number, hi: number, unit = ''): void {
  ok(name, v >= lo && v <= hi, `${fmt(v)}${unit} (want ${fmt(lo)}..${fmt(hi)}${unit})`);
}
function section(t: string): void { console.log(`\n${t}\n${'-'.repeat(t.length)}`); }
function note(s: string): void { console.log(`   ${s}`); }

/* ------------------------------------------------------------------- rig */

/**
 * A roster of real rigs on the real locomotion model. `buildRig` allocates
 * geometry but never touches a GL context, so the whole animation stack runs
 * headless — which is why this file can exist at all.
 */
class Stage {
  readonly loco = new Locomotion();
  readonly anim = new Animator({ detail: DETAIL });
  readonly rigs: PlayerRig[] = [];
  readonly bodies: LocoPlayer[] = [];
  readonly handles: AnimHandle[] = [];
  private rand: Rng;
  t = 0;

  constructor(seed = 0x51ce7a) {
    this.rand = new Rng(seed);
    this.loco.autoResolve = false;
    this.loco.attach({} as never);
  }

  add(id: number, x = 0, z = 0, facing = 0): AnimHandle {
    const p = randomBodyParams(this.rand.fork(id * 7919 + 13));
    // One LOD and a low charDetail: this suite reads bone matrices, and the
    // skin has no vote. It keeps a fourteen-body run inside a few seconds.
    const rig = buildRig(p, { charDetail: Math.min(DETAIL, 0.4), levels: 1 });
    const body = this.loco.create({
      id, team: (id % 2) as 0 | 1, pos: new THREE.Vector3(x, 0, z), facing,
      attr: { height: p.height, speed: 78, accel: 74, agility: 74 },
    });
    this.rigs.push(rig);
    this.bodies.push(body);
    const h = this.anim.add(rig, body, { id });
    this.handles.push(h);
    return h;
  }

  /** One fixed step: sim, then pose, then commit the world matrices. */
  step(desired: (p: LocoPlayer, i: number, t: number) => DesiredMove): void {
    for (let i = 0; i < this.bodies.length; i++) {
      this.loco.step(this.bodies[i], desired(this.bodies[i], i, this.t), DT);
    }
    this.t += DT;
    this.anim.update(DT, null);
    for (const r of this.rigs) r.root.updateMatrixWorld(true);
  }

  run(n: number, desired: (p: LocoPlayer, i: number, t: number) => DesiredMove,
    each?: () => void): void {
    for (let i = 0; i < n; i++) { this.step(desired); each?.(); }
  }
}

const FWD = new THREE.Vector3(0, 0, 1);
const straight = (speed: number) => (): DesiredMove => ({ dir: FWD, speed });
const spd = (p: LocoPlayer): number => Math.hypot(p.vel.x, p.vel.z);

/* --------------------------------------------------------------- probes */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _d = new THREE.Vector3();

/**
 * THE SLIP PROBE — the one number this whole module is judged on.
 *
 * The ankle is NOT what has to hold still; the SOLE is. A correct stance rolls
 * the foot about a contact point, which translates the ankle by design, so
 * measuring the ankle scores a good foot as a sliding one. Both sole points are
 * therefore tracked in the foot bone's own frame — local +Y runs toward the
 * ball, local +Z is up — and at every instant of stance at least one of them is
 * the pivot and must be stationary. The min of the two is the honest number.
 *
 * Reported per STANCE (millimetres of slip accumulated between touchdown and
 * lift-off) as well as per frame, because a foot that creeps 0.5 mm a frame for
 * sixty frames is a foot that slides 3 cm and the per-frame number hides it.
 */
class Slip {
  private prevHeel: THREE.Vector3[] = [];
  private prevBall: THREE.Vector3[] = [];
  private live: boolean[] = [];
  private acc: number[] = [];
  maxFrame = 0;
  private sum = 0;
  private n = 0;
  midMax = 0;
  private midSum = 0;
  private midN = 0;
  readonly stances: number[] = [];

  constructor(count: number) {
    for (let i = 0; i < count * 2; i++) {
      this.prevHeel.push(new THREE.Vector3());
      this.prevBall.push(new THREE.Vector3());
      this.live.push(false);
      this.acc.push(0);
    }
  }

  probe(handles: readonly AnimHandle[]): void {
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i];
      for (let k = 0; k < 2; k++) {
        const slot = i * 2 + k;
        const t = k === 0 ? h.feet.L : h.feet.R;
        if (!t.contact || h.feet.free) { this.close(slot); continue; }
        const bone = t.side === 1 ? h.rig.bones.foot_L : h.rig.bones.foot_R;
        const H = h.kine.height;
        const ay = h.kine.ankleY;
        _a.set(0, -0.030 * H, -ay).applyMatrix4(bone.matrixWorld);     // heel
        _b.set(0, 0.075 * H, -ay).applyMatrix4(bone.matrixWorld);      // ball
        if (this.live[slot]) {
          const d = Math.min(
            _a.distanceTo(this.prevHeel[slot]), _b.distanceTo(this.prevBall[slot]),
          ) * 1000;
          // A fresh plant legitimately re-pins the foot somewhere else. Under
          // 25 mm in one 1/120 s frame is stance, not a new plant.
          if (d < 25) {
            this.maxFrame = Math.max(this.maxFrame, d);
            this.sum += d; this.n++;
            this.acc[slot] += d;
            // Mid-stance: past the touchdown transient, before toe-off. The
            // window where the foot is flat and loaded and the number should be
            // as near a hard zero as an IK solve gets.
            if (t.uStance > 0.20 && t.uStance < 0.85) {
              this.midMax = Math.max(this.midMax, d);
              this.midSum += d; this.midN++;
            }
          } else this.close(slot);
        }
        this.prevHeel[slot].copy(_a);
        this.prevBall[slot].copy(_b);
        this.live[slot] = true;
      }
    }
  }

  private close(slot: number): void {
    if (this.acc[slot] > 0) this.stances.push(this.acc[slot]);
    this.acc[slot] = 0;
    this.live[slot] = false;
  }

  get meanFrame(): number { return this.sum / Math.max(1, this.n); }
  get midMean(): number { return this.midSum / Math.max(1, this.midN); }
  get medianStance(): number {
    if (!this.stances.length) return 0;
    const s = [...this.stances].sort((x, y) => x - y);
    return s[s.length >> 1];
  }
  get worstStance(): number {
    if (!this.stances.length) return 0;
    const s = [...this.stances].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  }
}

/** Rig-space direction a bone points (local +Y runs down every bone). */
function boneDir(h: AnimHandle, bone: number): THREE.Vector3 {
  h.kine.worldQuat(bone, _q);
  return _d.set(0, 1, 0).applyQuaternion(_q).clone();
}

/**
 * How the chest is tilted, in the athlete's own frame. `right` is positive when
 * the trunk's up-axis has gone over toward the athlete's RIGHT (rig +X is their
 * left, so the sign is negated); `fwd` is positive leaning forward.
 */
function chestTilt(h: AnimHandle): { right: number; fwd: number } {
  const up = boneDir(h, B.chest);
  return { right: -up.x, fwd: up.z };
}

/** Lateral acceleration in the athlete's own frame; + is to their right. */
function latAccel(h: AnimHandle): number {
  const f = h.loco.facing;
  return h.body.accX * -Math.cos(f) + h.body.accZ * Math.sin(f);
}

/* ====================================================================== 1 */

const LADDER = [0.8, 1.6, 2.6, 4.0, 5.5, 7.0];

interface LadderRow {
  v: number; ground: number; double: number; flight: number;
  stride: number; cadence: number; slip: Slip; lift: number; hipRange: number;
}

function ladder(): LadderRow[] {
  const rows: LadderRow[] = [];
  for (const target of LADDER) {
    const st = new Stage();
    const h = st.add(0);
    const p = st.bodies[0];
    st.run(480, straight(target));                 // settle into the gait

    const slip = new Slip(1);
    let ground = 0, both = 0, none = 0, frames = 0, sumV = 0, lift = 0;
    let hipLo = 9, hipHi = -9;
    const strides: number[] = [];
    let lastPlant: THREE.Vector3 | null = null;
    let wasDown = h.feet.L.contact;

    st.run(720, straight(target), () => {
      slip.probe(st.handles);
      frames++;
      sumV += spd(p);
      const cL = h.feet.L.contact, cR = h.feet.R.contact;
      if (cL || cR) ground++;
      if (cL && cR) both++;
      if (!cL && !cR) none++;
      if (!cL) lift = Math.max(lift, h.feet.L.pos.y - p.groundY);
      hipLo = Math.min(hipLo, h.pose.hip.y);
      hipHi = Math.max(hipHi, h.pose.hip.y);
      // A stride is measured plant to plant on ONE foot — two steps.
      if (cL && !wasDown) {
        if (lastPlant) strides.push(h.feet.L.plant.distanceTo(lastPlant));
        lastPlant = h.feet.L.plant.clone();
      }
      wasDown = cL;
    });

    const v = sumV / frames;
    rows.push({
      v,
      ground: ground / frames, double: both / frames, flight: none / frames,
      stride: strides.reduce((a, b) => a + b, 0) / Math.max(1, strides.length),
      cadence: stepRate(v), slip, lift, hipRange: hipHi - hipLo,
    });
  }
  return rows;
}

function testFeet(rows: LadderRow[]): void {
  section('1. Foot contact — a planted sole does not move');
  note('slip is the min of the heel and ball world displacement, off the committed');
  note('bone matrices, min(heel, ball) since one of them is always the pivot.');
  for (const r of rows) {
    note(`v=${r.v.toFixed(2)} m/s   per-frame max ${r.slip.maxFrame.toFixed(2)} mm  `
      + `mid-stance mean ${r.slip.midMean.toFixed(3)} mm  `
      + `per-stance median ${r.slip.medianStance.toFixed(1)} mm  p95 ${r.slip.worstStance.toFixed(1)} mm`);
  }
  const worstMid = Math.max(...rows.map((r) => r.slip.midMean));
  const worstMidPeak = Math.max(...rows.map((r) => r.slip.midMax));
  const worstStance = Math.max(...rows.map((r) => r.slip.worstStance));
  const worstFrame = Math.max(...rows.map((r) => r.slip.maxFrame));

  // Mid-stance is the flat, loaded window. Nothing may creep there.
  ok('mid-stance slip stays under 1 mm per frame', worstMid < 1.0,
    `${worstMid.toFixed(3)} mm/frame`);
  ok('no mid-stance frame slips more than 3 mm', worstMidPeak < 3.0,
    `${worstMidPeak.toFixed(2)} mm`);
  // Whole stance, touchdown transient and toe-off included. 20 mm over a whole
  // plant is 1.1 % of a body height; at the 40-90 px the game is played at it is
  // under a pixel. Note the walk rows accumulate over twice as many frames as
  // the sprint rows, because a walking foot is down for 0.67 of its cycle.
  ok('total slip per stance stays under 22 mm at every speed', worstStance < 22,
    `${worstStance.toFixed(1)} mm (p95 over all stances)`);
  // Nothing may jump. A single 12 mm frame is a snap, and a snap is what a
  // stale plant or a leg that cannot reach its target produces.
  ok('no single frame slips more than 4 mm', worstFrame < 4,
    `${worstFrame.toFixed(2)} mm`);
}

/* ====================================================================== 2 */

function testStride(rows: LadderRow[]): void {
  section('2. Stride length and cadence scale with speed');
  for (const r of rows) {
    note(`v=${r.v.toFixed(2)}  stride ${r.stride.toFixed(2)} m  cadence ${r.cadence.toFixed(2)} steps/s  `
      + `v/(stride*cadence/2) = ${(r.v / (r.stride * r.cadence / 2)).toFixed(3)}  `
      + `swing lift ${(r.lift * 100).toFixed(1)} cm`);
  }
  // The identity that has to hold for a foot not to skate: one stride is two
  // steps, so speed = stride * cadence / 2. Measured off the actual plant
  // points, not off the formula that produced them.
  for (const r of rows) {
    const implied = r.stride * r.cadence / 2;
    ok(`stride x cadence reproduces ${r.v.toFixed(1)} m/s`,
      Math.abs(implied - r.v) / r.v < 0.06,
      `${implied.toFixed(2)} vs ${r.v.toFixed(2)} m/s`);
  }
  for (let i = 1; i < rows.length; i++) {
    ok(`stride grows from ${rows[i - 1].v.toFixed(1)} to ${rows[i].v.toFixed(1)} m/s`,
      rows[i].stride > rows[i - 1].stride + 0.05,
      `${rows[i - 1].stride.toFixed(2)} -> ${rows[i].stride.toFixed(2)} m`);
    ok(`cadence grows from ${rows[i - 1].v.toFixed(1)} to ${rows[i].v.toFixed(1)} m/s`,
      rows[i].cadence > rows[i - 1].cadence + 0.05,
      `${rows[i - 1].cadence.toFixed(2)} -> ${rows[i].cadence.toFixed(2)} steps/s`);
  }
  // Ground clearance: a stroll skims, a sprint recovers the heel high. A walk
  // that lifts 10 cm is a parade march and it reads as one.
  between('swing foot barely clears the turf at a walk', rows[0].lift, 0.015, 0.055, ' m');
  ok('swing foot is recovered high at a sprint', rows[rows.length - 1].lift > 0.22,
    `${rows[rows.length - 1].lift.toFixed(3)} m`);
}

/* ====================================================================== 3 */

function testModes(rows: LadderRow[]): void {
  section('3. The gait changes MODE across the speed range');
  note('duty factor is per foot, per cycle: > 0.5 means the feet overlap (a walk),');
  note('< 0.5 means neither foot is down for part of the cycle (a run).');
  for (const r of rows) {
    note(`v=${r.v.toFixed(2)}  duty ${footStance(r.v).toFixed(3)}  `
      + `ground ${(100 * r.ground).toFixed(0)}%  double support ${(100 * r.double).toFixed(0)}%  `
      + `flight ${(100 * r.flight).toFixed(0)}%  hip travel ${(r.hipRange * 100).toFixed(1)} cm`);
  }
  const walk = rows[0], jog = rows[2], run = rows[rows.length - 1];

  ok('a walk has NO flight phase', walk.flight < 0.02,
    `${(100 * walk.flight).toFixed(1)}% of frames with both feet up`);
  between('a walk has real double support', walk.double, 0.15, 0.45, ' of the cycle');
  ok('a sprint has a real flight phase', run.flight > 0.30,
    `${(100 * run.flight).toFixed(0)}%`);
  ok('a sprint has no double support', run.double < 0.01,
    `${(100 * run.double).toFixed(1)}%`);
  ok('the crossover happens between the walk and the sprint',
    jog.double < walk.double && jog.flight < run.flight,
    `double ${(100 * walk.double).toFixed(0)} -> ${(100 * jog.double).toFixed(0)} -> `
    + `${(100 * run.double).toFixed(0)} %, flight ${(100 * walk.flight).toFixed(0)} -> `
    + `${(100 * jog.flight).toFixed(0)} -> ${(100 * run.flight).toFixed(0)} %`);
  // Monotone, so there is no speed band where the gait doubles back on itself
  // and reads as a shuffle.
  let monotone = true;
  for (let i = 1; i < rows.length; i++) if (rows[i].ground > rows[i - 1].ground + 1e-6) monotone = false;
  ok('ground contact falls monotonically with speed', monotone,
    rows.map((r) => `${(100 * r.ground).toFixed(0)}`).join(' > ') + ' %');
  // The walk-run crossover as a speed. Humans change over near 2.1 m/s.
  let cross = 0;
  for (let v = 0.2; v < 8; v += 0.01) if (footStance(v) >= 0.5) cross = v;
  between('walk-run crossover speed', cross, 1.6, 2.8, ' m/s');
}

/* ====================================================================== 4 */

/**
 * A 90-degree cut at speed. The simulation models the plant — it commits a foot,
 * keeps 66.7 % of the entry speed and spends real lateral acceleration doing it.
 * The question here is only whether the BODY says so.
 */
function testCut(): void {
  section('4. Plant and turn — the body leans INTO the cut');
  const st = new Stage(0xC07);
  const h = st.add(0);
  const p = st.bodies[0];
  st.run(420, () => ({ dir: FWD, effort: 1 }));
  const entry = spd(p);

  const turn = new THREE.Vector3(-1, 0, 0);      // -X is the athlete's right at facing 0
  let peakLat = 0, tiltAtPeak = 0, worstOutward = 0, minSpeed = entry;
  let hardPlant = false, hardFrames = 0;
  st.run(200, () => ({ dir: turn, effort: 1 }), () => {
    const lat = latAccel(h);
    const tilt = chestTilt(h).right;
    if (lat > peakLat) { peakLat = lat; tiltAtPeak = tilt; }
    // Leaning the WRONG way while a real lateral force is being applied is the
    // failure mode: it reads as a body being flung out of its own turn.
    if (lat > 4) worstOutward = Math.min(worstOutward, tilt);
    minSpeed = Math.min(minSpeed, spd(p));
    if (h.feet.L.hard || h.feet.R.hard) { hardPlant = true; hardFrames++; }
  });

  note(`entry ${entry.toFixed(2)} m/s -> ${minSpeed.toFixed(2)} m/s through the cut `
    + `(${(100 * minSpeed / entry).toFixed(0)} % retained)`);
  note(`peak lateral acceleration ${peakLat.toFixed(2)} m/s², chest tilt there `
    + `${(Math.asin(Math.max(-1, Math.min(1, tiltAtPeak))) * 180 / Math.PI).toFixed(1)}° `
    + `(physics wants ${(Math.atan2(peakLat, 9.81) * 180 / Math.PI).toFixed(1)}°)`);

  ok('the simulation commits a hard plant', hardPlant, `${hardFrames} frames flagged hard`);
  ok('the chest leans INTO the turn at peak lateral load', tiltAtPeak > 0.15,
    `${tiltAtPeak.toFixed(3)} (positive = toward the turn centre)`);
  ok('the chest never leans OUT of a loaded turn', worstOutward > -0.05,
    `worst ${worstOutward.toFixed(3)}`);
  // A lean is only honest if it scales with the force producing it.
  const wanted = Math.atan2(peakLat, 9.81);
  const got = Math.asin(Math.max(-1, Math.min(1, tiltAtPeak)));
  between('lean is a plausible fraction of the ideal', got / wanted, 0.35, 1.15, ' x');

  // The plant foot must be the one that holds still while the body rotates
  // about it — that is what a plant IS.
  ok('the planted foot keeps its heading through the plant',
    Math.abs(h.feet.L.plantYaw - h.feet.L.worldYaw) < 1e-6
    || Math.abs(h.feet.R.plantYaw - h.feet.R.worldYaw) < 1e-6,
    'plantYaw is held for the whole of stance');
}

/* ====================================================================== 5 */

function testPosture(): void {
  section('5. Posture — lean under acceleration, upright at cruise');
  const st = new Stage(0xB0D);
  const h = st.add(0);
  const p = st.bodies[0];

  let accelLean = -9;
  st.run(90, () => ({ dir: FWD, effort: 1 }), () => {
    accelLean = Math.max(accelLean, chestTilt(h).fwd);
  });
  st.run(600, () => ({ dir: FWD, effort: 1 }));
  let cruiseLean = 0, n = 0;
  st.run(240, () => ({ dir: FWD, effort: 1 }), () => { cruiseLean += chestTilt(h).fwd; n++; });
  cruiseLean /= n;
  const cruiseV = spd(p);

  let brakeLean = 9;
  st.run(150, () => ({ dir: FWD, speed: 0 }), () => {
    brakeLean = Math.min(brakeLean, chestTilt(h).fwd);
  });

  note(`launch lean ${(Math.asin(accelLean) * 180 / Math.PI).toFixed(1)}°, `
    + `cruise (${cruiseV.toFixed(1)} m/s) ${(Math.asin(cruiseLean) * 180 / Math.PI).toFixed(1)}°, `
    + `braking ${(Math.asin(brakeLean) * 180 / Math.PI).toFixed(1)}°`);
  ok('the body leans forward hard out of a standing start', accelLean > 0.35,
    `${accelLean.toFixed(3)}`);
  ok('the body is much more upright at cruise than under acceleration',
    cruiseLean < accelLean * 0.6, `${cruiseLean.toFixed(3)} vs ${accelLean.toFixed(3)}`);
  ok('the body sits back under braking', brakeLean < cruiseLean - 0.10,
    `${brakeLean.toFixed(3)} vs ${cruiseLean.toFixed(3)}`);
}

/* ====================================================================== 6 */

function testArms(): void {
  section('6. Arms counter-swing the legs');
  note('common mode is the part of the two arms\' motion that is SHARED — both');
  note('arms forward at once. It is what reads as "carrying a tray".');
  const swings: number[] = [];
  for (const target of [1.2, 3.0, 5.0, 7.0]) {
    const st = new Stage(0xA12);
    const h = st.add(0);
    st.run(480, straight(target));
    const L: number[] = [], R: number[] = [];
    st.run(300, straight(target), () => {
      L.push(boneDir(h, B.upperArm_L).z);
      R.push(boneDir(h, B.upperArm_R).z);
    });
    const n = L.length;
    const mL = L.reduce((a, b) => a + b, 0) / n;
    const mR = R.reduce((a, b) => a + b, 0) / n;
    let common = 0, diff = 0, cov = 0, vL = 0, vR = 0;
    for (let i = 0; i < n; i++) {
      const dl = L[i] - mL, dr = R[i] - mR;
      common += ((dl + dr) / 2) ** 2;
      diff += ((dl - dr) / 2) ** 2;
      cov += dl * dr; vL += dl * dl; vR += dr * dr;
    }
    const cRms = Math.sqrt(common / n), dRms = Math.sqrt(diff / n);
    const corr = cov / Math.sqrt(vL * vR);
    note(`v=${target.toFixed(1)}  swing (differential) ${dRms.toFixed(3)} rms  `
      + `common ${cRms.toFixed(3)} rms  correlation ${corr.toFixed(3)}  `
      + `carriage ${((mL + mR) / 2).toFixed(3)}`);
    ok(`arms are anti-phase at ${target.toFixed(1)} m/s`, corr < -0.9, `corr ${corr.toFixed(3)}`);
    ok(`common-mode swing under 8 % of the real swing at ${target.toFixed(1)} m/s`,
      cRms < 0.08 * dRms, `${(100 * cRms / dRms).toFixed(1)} %`);
    ok(`arms are carried forward of the shoulders at ${target.toFixed(1)} m/s`,
      (mL + mR) / 2 > 0.04, `${((mL + mR) / 2).toFixed(3)}`);
    swings.push(dRms);
  }
  // Amplitude is not authored — it is read straight back off the leg IK — so
  // this is really a check that the legs' own swing scales, seen through the
  // arms. A gait whose arms do not open up with pace reads as a shuffle.
  let grows = true;
  for (let i = 1; i < swings.length; i++) if (swings[i] < swings[i - 1] * 1.15) grows = false;
  ok('arm swing opens up with every step of the speed ladder', grows,
    swings.map((s) => s.toFixed(3)).join(' -> ') + ' rms');
  ok('a sprint swings at least twice as far as a walk',
    swings[swings.length - 1] > 2 * swings[0],
    `${swings[0].toFixed(3)} -> ${swings[swings.length - 1].toFixed(3)} rms`);
}

/* ====================================================================== 7 */

function gaitSample(mode: 'run' | 'backpedal' | 'shuffle', speed: number): {
  thighRange: number; thighBack: number; footGap: number; ground: number; lift: number;
  heelDown: number; state: string; chestFwd: number;
} {
  const st = new Stage(0xDEF);
  const h = st.add(0);
  const face = new THREE.Vector3(0, 0, 1);
  const back = new THREE.Vector3(0, 0, -1);
  const side = new THREE.Vector3(1, 0, 0);
  const want = (): DesiredMove => {
    if (mode === 'run') return { dir: FWD, speed };
    if (mode === 'backpedal') return { dir: back, speed, face, mode: 'backpedal' };
    return { dir: side, speed, face, mode: 'shuffle' };
  };
  st.run(420, want);
  let lo = 9, hi = -9, gap = 0, ground = 0, n = 0, lift = 0, heel = 0, fwd = 0;
  st.run(300, want, () => {
    const z = boneDir(h, B.thigh_L).z;
    lo = Math.min(lo, z); hi = Math.max(hi, z);
    gap = Math.max(gap, Math.hypot(
      h.feet.L.pos.x - h.feet.R.pos.x, h.feet.L.pos.z - h.feet.R.pos.z));
    if (h.feet.L.contact || h.feet.R.contact) ground++;
    if (!h.feet.L.contact) lift = Math.max(lift, h.feet.L.pos.y - st.bodies[0].groundY);
    // Toes-up while loaded means the heel is carrying the athlete.
    if (h.feet.L.contact && h.feet.L.pitch > 0.02) heel++;
    fwd += chestTilt(h).fwd;
    n++;
  });
  return {
    thighRange: hi - lo, thighBack: lo, footGap: gap, ground: ground / n, lift,
    heelDown: heel / n, state: st.bodies[0].state, chestFwd: fwd / n,
  };
}

function testDefensiveGaits(): void {
  section('7. Defensive gaits are not reversed running');
  note('a backpedal uses the same cadence and stride the simulation gives a forward');
  note('run — that part is not the animator\'s to change. What separates them is');
  note('ground contact, foot strike, recovery height and posture.');
  const run = gaitSample('run', 3.0);
  const bp = gaitSample('backpedal', 3.0);
  const sh = gaitSample('shuffle', 3.0);
  for (const [name, g] of [['run', run], ['backpedal', bp], ['shuffle', sh]] as const) {
    note(`${name.padEnd(10)} state ${g.state.padEnd(10)} thigh swing ${g.thighRange.toFixed(2)} rad  `
      + `base ${g.footGap.toFixed(2)} m  ground ${(100 * g.ground).toFixed(0)}%  `
      + `lift ${(g.lift * 100).toFixed(1)} cm  heel-loaded ${(100 * g.heelDown).toFixed(0)}%  `
      + `chest ${(Math.asin(g.chestFwd) * 180 / Math.PI).toFixed(1)}°`);
  }
  ok('all three states are actually reached',
    run.state === 'jog' && bp.state === 'backpedal' && sh.state === 'shuffle',
    `${run.state} / ${bp.state} / ${sh.state}`);
  // A shuffle is a lateral slide: short choppy legs and a wide base.
  ok('a shuffle keeps a wider base than a run', sh.footGap > run.footGap * 1.1,
    `${sh.footGap.toFixed(2)} vs ${run.footGap.toFixed(2)} m`);
  ok('a shuffle takes much shorter steps than a run',
    sh.thighRange < run.thighRange * 0.6,
    `${sh.thighRange.toFixed(2)} vs ${run.thighRange.toFixed(2)} rad of thigh swing`);
  // A defender lives on the balls of their feet and stays connected to the turf.
  ok('a runner puts a heel down and a backpedaller does not',
    run.heelDown > 0.10 && bp.heelDown < 0.01,
    `run ${(100 * run.heelDown).toFixed(0)} % vs backpedal ${(100 * bp.heelDown).toFixed(0)} %`);
  ok('a shuffle never puts a heel down', sh.heelDown < 0.01,
    `${(100 * sh.heelDown).toFixed(0)} %`);
  ok('a backpedal keeps more of itself on the ground than a run',
    bp.ground > run.ground + 0.03,
    `${(100 * bp.ground).toFixed(0)} vs ${(100 * run.ground).toFixed(0)} %`);
  ok('defensive footwork skims instead of recovering high',
    bp.lift < run.lift * 0.75 && sh.lift < run.lift * 0.6,
    `run ${(100 * run.lift).toFixed(1)} cm, backpedal ${(100 * bp.lift).toFixed(1)} cm, `
    + `shuffle ${(100 * sh.lift).toFixed(1)} cm`);
  ok('a defender carries the chest further over the toes than a runner',
    bp.chestFwd > run.chestFwd + 0.05 && sh.chestFwd > run.chestFwd + 0.03,
    `run ${run.chestFwd.toFixed(3)}, backpedal ${bp.chestFwd.toFixed(3)}, `
    + `shuffle ${sh.chestFwd.toFixed(3)}`);
}

/* ====================================================================== 8 */

/**
 * Sum of per-bone quaternion angles between two poses, radians.
 *
 * `Pose.q` is a Float32Array, and `acos` near 1 amplifies its quantisation: two
 * bit-identical computations score ~0.02 rad summed over 60 bones rather than 0.
 * That is the noise floor and every threshold below is set above it.
 */
function poseDistance(a: AnimHandle, b: AnimHandle): number {
  let sum = 0;
  for (let i = 0; i < NB; i++) {
    const o = i * 4;
    let dot = a.pose.q[o] * b.pose.q[o] + a.pose.q[o + 1] * b.pose.q[o + 1]
      + a.pose.q[o + 2] * b.pose.q[o + 2] + a.pose.q[o + 3] * b.pose.q[o + 3];
    dot = Math.min(1, Math.abs(dot));
    sum += 2 * Math.acos(dot);
  }
  return sum;
}

function testDiversity(): void {
  section('8. Pose diversity — eight athletes at one speed');
  note('the simulation\'s gait oscillator is a pure function of ground speed started');
  note('at zero, so athletes at equal speed share a stride phase exactly. Half the');
  note('roster answers each plant with the other foot (Gaits.gaitLead), which puts');
  note('them half a stride out; the rest of the spread is per-athlete gain.');
  const st = new Stage(0x5EED);
  const N = 8;
  for (let i = 0; i < N; i++) st.add(i, i * 4, 0);
  st.run(600, straight(5.0));

  const phase = st.handles.map((h) => h.body.strideU);
  note(`stride phases: ${phase.map((p) => p.toFixed(3)).join(' ')}`);

  // Two clusters, half a stride apart. Measure the spread as the widest
  // circular gap between any pair.
  let widest = 0;
  let closestPose = Infinity;
  let closestPair = '';
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      let d = Math.abs(phase[i] - phase[j]);
      d = Math.min(d, 1 - d);
      widest = Math.max(widest, d);
      const pd = poseDistance(st.handles[i], st.handles[j]);
      if (pd < closestPose) { closestPose = pd; closestPair = `${i}/${j}`; }
    }
  }
  // How many athletes are within a twentieth of a stride of the most crowded
  // phase. All of them is the clone failure.
  let crowd = 0;
  for (let i = 0; i < N; i++) {
    let c = 0;
    for (let j = 0; j < N; j++) {
      let d = Math.abs(phase[i] - phase[j]);
      d = Math.min(d, 1 - d);
      if (d < 0.05) c++;
    }
    crowd = Math.max(crowd, c);
  }
  note(`widest pairwise phase separation ${widest.toFixed(3)} strides; `
    + `largest in-phase group ${crowd}/${N}; closest pose pair ${closestPair} at `
    + `${closestPose.toFixed(2)} rad summed over ${NB} bones`);

  ok('the roster is not all on the same foot', widest > 0.30,
    `${widest.toFixed(3)} strides apart at the extremes`);
  ok('no more than half the roster shares a stride phase', crowd <= Math.ceil(N / 2),
    `${crowd} of ${N} within 0.05 of a stride`);
  ok('no two athletes hold the same pose', closestPose > 0.60,
    `closest pair ${closestPair}: ${closestPose.toFixed(2)} rad`);

  /**
   * AND THE ASSERTION ABOVE IS TOO WEAK ON ITS OWN, which is worth saying out
   * loud because it passed while a critic was calling two athletes in the same
   * frame identical.
   *
   * 0.60 rad summed over 60 bones is 0.6 degrees per bone, and most of those 60
   * bones are fingers — which a viewer cannot see at 35 px and which the throw
   * and catch layers move a long way for reasons that have nothing to do with
   * whether two runners look alike. A roster can clear it comfortably while
   * every silhouette on screen is the same silhouette.
   *
   * The honest metric is the twelve bones that decide an outline at the tele's
   * range: two thighs, two shins, two upper arms, two forearms, pelvis, chest,
   * mid-spine, head. Measured on the committed poses, eight athletes at 5 m/s
   * had a closest pair of 0.514 rad over those twelve — 2.5 degrees a bone,
   * which is the clone read exactly. `gsig` decorrelating its axes and the
   * per-athlete arm lag take it to 0.88 (4.2 degrees a bone).
   *
   * The ceiling on this number is not in this file: `sim/move/Gait.ts` is one
   * oscillator per body started at zero, so athletes at equal speed share a
   * stride phase to within a thousandth, and `gaitLead` splitting the roster in
   * two is the only leg-phase variety the animator can produce without
   * unpinning the feet. Everything above that is amplitude and arm phase.
   */
  const SIL: readonly number[] = [
    B.thigh_L, B.shin_L, B.thigh_R, B.shin_R,
    B.upperArm_L, B.foreArm_L, B.upperArm_R, B.foreArm_R,
    B.pelvis, B.chest, B.spine02, B.head,
  ];
  let closestSil = Infinity, silPair = '';
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      let sum = 0;
      for (const bone of SIL) {
        const o = bone * 4;
        const a = st.handles[i].pose.q, b = st.handles[j].pose.q;
        let dot = a[o] * b[o] + a[o + 1] * b[o + 1] + a[o + 2] * b[o + 2] + a[o + 3] * b[o + 3];
        dot = Math.min(1, Math.abs(dot));
        sum += 2 * Math.acos(dot);
      }
      if (sum < closestSil) { closestSil = sum; silPair = `${i}/${j}`; }
    }
  }
  note(`closest SILHOUETTE pair ${silPair}: ${closestSil.toFixed(3)} rad over `
    + `${SIL.length} bones (${(closestSil / SIL.length * 180 / Math.PI).toFixed(2)} deg per bone)`);
  ok('no two athletes share a silhouette', closestSil > 0.75,
    `${silPair} at ${closestSil.toFixed(3)} rad over ${SIL.length} outline bones`);

  // And the signature must be a per-athlete constant, not noise: rebuilding the
  // same roster has to reproduce it exactly.
  const st2 = new Stage(0x5EED);
  for (let i = 0; i < N; i++) st2.add(i, i * 4, 0);
  st2.run(600, straight(5.0));
  let drift = 0;
  for (let i = 0; i < N; i++) {
    drift = Math.max(drift, poseDistance(st.handles[i], st2.handles[i]));
  }
  ok('the signature is deterministic', drift < 0.05,
    `worst rebuild drift ${drift.toFixed(4)} rad (float32 noise floor ~0.02)`);
}

/* ====================================================================== 9 */

function testCost(): void {
  section('9. Determinism and cost');
  const st = new Stage(0xC057);
  for (let i = 0; i < 14; i++) st.add(i, (i % 7) * 3 - 9, (i / 7 | 0) * 6 - 3, i < 7 ? 0 : Math.PI);
  st.run(240, (p, i) => ({ dir: FWD, speed: 1 + (i % 7) }));
  st.anim.resetStats();
  const t0 = performance.now();
  st.run(600, (p, i) => ({ dir: FWD, speed: 1 + (i % 7) }));
  const wall = performance.now() - t0;
  note(`14 athletes, 600 frames: ${st.anim.msAvg.toFixed(3)} ms per pose pass `
    + `(${(1000 * st.anim.msAvg / 14).toFixed(1)} us per athlete), peak `
    + `${st.anim.msPeak.toFixed(3)} ms; ${wall.toFixed(0)} ms wall including the sim`);
  ok('a full roster poses in under 2 ms', st.anim.msAvg < 2.0,
    `${st.anim.msAvg.toFixed(3)} ms`);
  ok('no pose pass spikes past 8 ms', st.anim.msPeak < 8.0,
    `${st.anim.msPeak.toFixed(3)} ms`);

  // Nothing in the animator may allocate per frame, so a long run must not move
  // the heap much. A loose bound — the sim allocates too — but a per-frame
  // `new THREE.Vector3()` in the pose path is 100 kB/s and would blow it.
  const before = process.memoryUsage().heapUsed;
  st.run(600, (p, i) => ({ dir: FWD, speed: 1 + (i % 7) }));
  const grew = (process.memoryUsage().heapUsed - before) / 1e6;
  note(`heap moved ${grew.toFixed(1)} MB over 600 frames x 14 athletes`);
  ok('the pose path does not allocate per frame', grew < 24, `${grew.toFixed(1)} MB`);
}

/* ===================================================================== 10 */

/** Angle between two bones, degrees. 0 = the joint is locked dead straight. */
function jointAngle(h: AnimHandle, a: number, b: number): number {
  const u = boneDir(h, a), v = boneDir(h, b);
  return Math.acos(Math.max(-1, Math.min(1, u.dot(v)))) * 180 / Math.PI;
}

/**
 * How far the thigh trails BEHIND the pelvis's vertical, degrees. Positive is
 * the knee behind the hip; 90 would be a thigh horizontal behind the body.
 */
function hipExtension(h: AnimHandle, thigh: number): number {
  const t = boneDir(h, thigh);
  return Math.atan2(-t.z, -t.y) * 180 / Math.PI;
}

function testJointLimits(): void {
  section('10. Joint limits — a leg is never a stick');
  note('twoBone clamps an unreachable target to l1 + l2, which is a knee at literal');
  note('full extension, and it does it silently. Measured before the swing-reach');
  note('clamp landed, the knee sat inside 5 deg of straight for 21 % of a 1.6 m/s');
  note('stride and 33-36 % from 4 m/s up, with a floor of 1.5 deg, and the trailing');
  note('thigh reached 58 deg behind vertical. Both are the "legs lock straight and');
  note('over-extend to near-horizontal" note, and both are measurable.');
  let worstLock = 0, worstKnee = 999, worstExt = 0, worstElbow = 999;
  for (const v of [1.6, 2.6, 4.0, 5.5, 7.0]) {
    const st = new Stage(0xA12);
    const h = st.add(0);
    st.run(480, straight(v));
    let kneeMin = 999, ext = -999, locked = 0, n = 0, elbowMin = 999;
    st.run(300, straight(v), () => {
      for (const [th, sh] of [[B.thigh_L, B.shin_L], [B.thigh_R, B.shin_R]] as const) {
        const k = jointAngle(h, th, sh);
        kneeMin = Math.min(kneeMin, k);
        if (k < 5) locked++;
        n++;
        ext = Math.max(ext, hipExtension(h, th));
      }
      elbowMin = Math.min(elbowMin,
        jointAngle(h, B.upperArm_L, B.foreArm_L), jointAngle(h, B.upperArm_R, B.foreArm_R));
    });
    note(`v=${v.toFixed(1)}  knee floor ${kneeMin.toFixed(1)} deg  locked(<5 deg) `
      + `${(100 * locked / n).toFixed(1)} %  thigh extension ${ext.toFixed(1)} deg  `
      + `elbow floor ${elbowMin.toFixed(1)} deg`);
    worstLock = Math.max(worstLock, locked / n);
    worstKnee = Math.min(worstKnee, kneeMin);
    worstExt = Math.max(worstExt, ext);
    worstElbow = Math.min(worstElbow, elbowMin);
  }
  // A human knee is never at full extension under load, and never at all during
  // the recovery half of a stride. Zero frames, not "few".
  ok('the knee is never locked straight at any running speed', worstLock === 0,
    `${(100 * worstLock).toFixed(2)} % of frames inside 5 deg of straight`);
  ok('the knee keeps at least 12 deg of flexion everywhere', worstKnee > 12,
    `floor ${worstKnee.toFixed(1)} deg`);
  // A sprinter's thigh reaches ~25 deg of hip extension at toe-off and the
  // recovery folds it immediately. Past 45 the silhouette is the splits.
  ok('the trailing thigh never over-extends toward horizontal', worstExt < 45,
    `worst ${worstExt.toFixed(1)} deg behind vertical`);
  // The elbow may open a long way at the back of the drive — that is the point
  // of section 11 — but a straight arm on a running body is a plank.
  ok('the elbow never straightens out on a running body', worstElbow > 15,
    `floor ${worstElbow.toFixed(1)} deg`);
}

/* ===================================================================== 11 */

function testArmDrive(): void {
  section('11. Arm drive — the hand\'s arc, and what it costs in width');
  note('a shoulder can swing 70 deg and still produce a hand that never leaves the');
  note('front of the body, because the elbow decides where the hand is. Measured');
  note('before this landed, the hand ran +0.064..+0.409 m fore-aft at 6 m/s — it');
  note('never once passed behind the hip at any speed — while sweeping 0.477 m');
  note('either side of the body axis, which is 0.26 m OUTBOARD of the shoulder.');
  note('sim/move/Separation.ts settles bodies 1.26 m apart and relaxes toward the');
  note('0.64 m hard tier near a live disc, so a 0.477 m half-span is an arm inside');
  note('the other player\'s torso. Both numbers are this file\'s to hold.');
  const rows: { v: number; back: number; front: number; lat: number; arc: number; rise: number }[] = [];
  for (const v of [2.0, 4.0, 6.0]) {
    const st = new Stage(0xA12);
    const h = st.add(0);
    st.run(480, straight(v));
    let back = 9, front = -9, lat = 0, lo = 9, hi = -9, arcLo = 9, arcHi = -9;
    st.run(300, straight(v), () => {
      for (const hd of [B.hand_L, B.hand_R]) {
        const o = hd * 3;
        const x = h.kine.wp[o], y = h.kine.wp[o + 1], z = h.kine.wp[o + 2];
        back = Math.min(back, z); front = Math.max(front, z);
        lat = Math.max(lat, Math.abs(x));
        lo = Math.min(lo, y); hi = Math.max(hi, y);
      }
      for (const ua of [B.upperArm_L, B.upperArm_R]) {
        const d = boneDir(h, ua);
        const a = Math.atan2(d.z, -d.y);
        arcLo = Math.min(arcLo, a); arcHi = Math.max(arcHi, a);
      }
    });
    const arc = (arcHi - arcLo) * 180 / Math.PI;
    rows.push({ v, back, front, lat, arc, rise: hi - lo });
    note(`v=${v.toFixed(1)}  hand fore-aft ${back.toFixed(3)}..${front.toFixed(3)} m  `
      + `half-span ${lat.toFixed(3)} m  shoulder arc ${arc.toFixed(1)} deg  `
      + `hand rise ${(hi - lo).toFixed(3)} m`);
  }
  const fast = rows[rows.length - 1];
  // The single most legible thing an arm does from a side-on broadcast lens.
  ok('the hand passes behind the hip at running pace', fast.back < -0.03,
    `${fast.back.toFixed(3)} m at ${fast.v.toFixed(1)} m/s`);
  ok('the hand travels at least 0.40 m fore-aft at running pace',
    fast.front - fast.back > 0.40, `${(fast.front - fast.back).toFixed(3)} m`);
  ok('the hand climbs at least 0.45 m over the drive', fast.rise > 0.45,
    `${fast.rise.toFixed(3)} m`);
  ok('the shoulder arc opens past 75 deg at a sprint', fast.arc > 75,
    `${fast.arc.toFixed(1)} deg`);
  // The swept volume has to stay inside a body's own personal space, or the
  // limbs of two athletes who are merely near each other intersect.
  const widest = Math.max(...rows.map((r) => r.lat));
  ok('the hands stay inside a 0.33 m half-span at every speed', widest < 0.33,
    `${widest.toFixed(3)} m (was 0.477 m; personal-space radius is 0.63 m)`);
  // And the drive has to be a function of pace, not a constant.
  ok('the arm arc grows monotonically with speed',
    rows.every((r, i) => i === 0 || r.arc > rows[i - 1].arc * 1.15),
    rows.map((r) => r.arc.toFixed(0)).join(' -> ') + ' deg');
}

/* ===================================================================== 12 */

function testLayout(): void {
  section('12. The layout is flat and extended');
  note('the layout is the signature moment of this sport and it is one of the ten');
  note('named framings. Measured before this landed: peak body pitch 65 deg from');
  note('vertical — a diagonal, which reads as falling over — with the reaching hand');
  note('at 0.125 m, UNDER the hips and 0.43 m below the trailing foot. A nosedive.');
  const st = new Stage(0x1A70);
  const h = st.add(0);
  st.run(240, straight(6.5));
  const p = st.bodies[0];
  let best: { pitch: number; hip: number; chest: number; head: number; hand: number; foot: number } | null = null;
  let sawAir = false;
  const y = (b: number): number => h.kine.wp[b * 3 + 1] + p.groundY;
  st.run(220, () => ({ dir: FWD, speed: 6.5, layout: true }), () => {
    if (p.state !== 'layout' || !p.air.airborne) return;
    sawAir = true;
    const pitch = Math.asin(Math.max(-1, Math.min(1, boneDir(h, B.chest).z))) * 180 / Math.PI;
    if (!best || pitch > best.pitch) {
      best = {
        pitch, hip: y(B.pelvis), chest: y(B.chest), head: y(B.head),
        hand: y(B.hand_L), foot: y(B.foot_R),
      };
    }
  });
  ok('the athlete actually leaves the ground on a layout', sawAir, 'airborne frames seen');
  if (!best) return;
  const b: { pitch: number; hip: number; chest: number; head: number; hand: number; foot: number } = best;
  note(`peak body pitch ${b.pitch.toFixed(1)} deg from vertical; hip ${b.hip.toFixed(2)} `
    + `chest ${b.chest.toFixed(2)} head ${b.head.toFixed(2)} hand ${b.hand.toFixed(2)} `
    + `foot ${b.foot.toFixed(2)} m`);
  ok('the body goes past 70 deg from vertical — flat, not diagonal', b.pitch > 70,
    `${b.pitch.toFixed(1)} deg`);
  // Level, within a body's thickness. A body whose head is far below its hips is
  // diving into the turf; one whose feet are far above them is somersaulting.
  ok('hips, chest and head are level within 0.15 m',
    Math.abs(b.head - b.hip) < 0.15 && Math.abs(b.chest - b.hip) < 0.15,
    `hip ${b.hip.toFixed(2)} chest ${b.chest.toFixed(2)} head ${b.head.toFixed(2)}`);
  ok('the trailing foot rides above the hips but not over the top',
    b.foot - b.hip > 0.02 && b.foot - b.hip < 0.35,
    `foot is ${(b.foot - b.hip).toFixed(2)} m above the hips`);
  // The reach is the whole shot. The hand leads, at or above shoulder line.
  ok('the reaching hand is the leading edge, not ploughing the turf',
    b.hand >= b.chest - 0.02, `hand ${b.hand.toFixed(2)} vs chest ${b.chest.toFixed(2)} m`);
  ok('the reaching hand is clear of the ground', b.hand > 0.30,
    `${b.hand.toFixed(2)} m`);
}

/* ------------------------------------------------------------------- run */

console.log(`\nanimation acceptance — fixed step ${(DT * 1000).toFixed(3)} ms, `
  + `rig detail ${DETAIL}, ${NB} bones`);

const rows = ladder();
testFeet(rows);
testStride(rows);
testModes(rows);
testCut();
testPosture();
testArms();
testDefensiveGaits();
testDiversity();
testJointLimits();
testArmDrive();
testLayout();
testCost();

console.log(`\n${'='.repeat(72)}`);
if (failed === 0) console.log(`PASS  ${passed} passed, 0 failed`);
else {
  console.log(`FAIL  ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log(`      - ${f}`);
}
console.log('='.repeat(72));
process.exit(failed === 0 ? 0 : 1);
