import * as THREE from 'three';
import { stepRate, dutyFactor, stanceHalfWidth, GAIT_MIN_SPEED } from '../../sim/move/Gait.ts';
import { B, clamp, clamp01, lerp, smooth, frameQuat, solveLimb, Frame, Kine, Pose } from './Kine.ts';
import type { LocoLike, FieldLike } from './Types.ts';

/**
 * ============================================================================
 *  FEET — plant tracking, foot IK, foot roll
 * ============================================================================
 *
 * Foot sliding is the loudest single difference between a sports game and a
 * prototype, so this file makes exactly one promise: **while a foot is in
 * contact, its world position is a constant.** Not smoothed, not nearly — the
 * same three numbers the simulation published, every frame, until it lifts.
 *
 * WHAT THE SIM GIVES US, AND WHAT IT DOES NOT.
 * `sim/move/Gait.ts` is a phase oscillator. Every time `foot.phase` wraps, the
 * OPPOSITE foot plants and the sim records that one plant — which foot, where,
 * when. It tracks a single foot, because that is all the physics needs. It is
 * not enough to pose two legs, so this module keeps the missing half: the foot
 * that planted a step ago is still pinned where it actually was, until it has
 * finished its swing.
 *
 * PER-FOOT PHASE, DERIVED NOT INTEGRATED. `foot.phase` counts one STEP; a
 * foot's own cycle is two steps. The sim's tracked foot planted exactly when
 * the phase last wrapped, so its own cycle position is `phase / 2` — and the
 * other foot, having planted one step earlier, is at `phase / 2 + 0.5`. No
 * second oscillator, nothing to integrate, nothing to drift.
 *
 * WHERE THE SWING FOOT IS GOING. It lands where `advanceGait` will put it:
 * body position at the landing instant, plus 0.30 of a step along travel, plus
 * half a stance width to the side. Re-evaluated every frame against a linear
 * extrapolation of the body, the prediction error is O(a·τ²) and τ — the time
 * left in the swing — goes to zero at touchdown. The prediction therefore
 * *converges* onto the plant the sim is about to make, so there is no snap to
 * absorb. The horizontal path is a smootherstep, whose derivative vanishes at
 * both ends: the foot leaves at zero world speed and arrives at zero world
 * speed, which is the definition of not sliding.
 *
 * FOOT ROLL. The ankle is the IK target and the sole is a two-point contact —
 * a heel behind, a ball in front. Pitch the foot, take whichever point is
 * lower, and the ankle height follows: heel-strike lifts it slightly, toe-off
 * lifts it a lot, and the sole can never sink through the ground. The ankle is
 * then shifted along the foot's forward axis by exactly the amount that holds
 * the current pivot — heel early in stance, ball late — stationary in the
 * world. Without that shift a push-off drags the toe 6 cm backwards through
 * the turf, which is a slide by another name.
 */

/* ------------------------------------------------------------------ tune */

/** Toe-out at rest, radians. Nobody's feet point straight ahead. */
const TOE_OUT = 0.105;
const SWING_LIFT_BASE = 0.055;
const SWING_LIFT_RATE = 0.052;
const SWING_LIFT_MAX = 0.46;
/** Plantarflexion at toe-off, radians, before the speed scale. */
const TOE_OFF = 0.62;
const TOE_EXT_MAX = 0.80;
/** How far a standing foot may drift from its ideal stance before it re-steps. */
const IDLE_STEP_TRIGGER = 0.17;
const IDLE_STEP_TIME = 0.26;

/* ----------------------------------------------------------------- state */

export interface FootTrack {
  /** +1 left (rig +X), -1 right. */
  side: 1 | -1;
  /** World position of the last touchdown — the pin. */
  plant: THREE.Vector3;
  hard: boolean;
  /** World ankle-projection this frame. Equals `plant` exactly while planted. */
  pos: THREE.Vector3;
  /** Predicted world touchdown of the current swing. */
  land: THREE.Vector3;
  /** 0..1 own stride phase, 0 = touchdown. */
  u: number;
  /** 0..1 progress through the stance phase; 1 once the foot has lifted. */
  uStance: number;
  contact: boolean;
  /** + = toes up. */
  pitch: number;
  /** Absolute world yaw of the foot. */
  worldYaw: number;
  /** Roll about the foot's long axis — eversion on a brace. */
  roll: number;
  /** MTP (toe) extension, radians. */
  toe: number;
  /** Idle micro-step timer; < 0 when not stepping. */
  stepT: number;
  stepFrom: THREE.Vector3;
}

export interface FeetState {
  L: FootTrack;
  R: FootTrack;
  /** Last `foot.t` consumed, so a new plant is an edge and not a poll. */
  seenPlantT: number;
  wasMoving: boolean;
  wasFree: boolean;
  seeded: boolean;
  /** Filtered ground normal, world. */
  normal: THREE.Vector3;
  /** True while the legs are free — airborne or prone. The caller poses them. */
  free: boolean;
}

function track(side: 1 | -1): FootTrack {
  return {
    side,
    plant: new THREE.Vector3(), hard: false,
    pos: new THREE.Vector3(), land: new THREE.Vector3(),
    u: 0, uStance: 0, contact: true, pitch: 0, worldYaw: 0, roll: 0, toe: 0,
    stepT: -1, stepFrom: new THREE.Vector3(),
  };
}

export function makeFeet(): FeetState {
  return {
    L: track(1), R: track(-1),
    seenPlantT: Number.NEGATIVE_INFINITY,
    wasMoving: false, wasFree: false, seeded: false,
    normal: new THREE.Vector3(0, 1, 0),
    free: false,
  };
}

/* --------------------------------------------------------------- scratch */

const _p = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _yawInv = new THREE.Quaternion();
const _n = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

const smootherstep = (t: number): number => {
  const c = clamp01(t);
  return c * c * c * (c * (6 * c - 15) + 10);
};

function groundAt(field: FieldLike | null, x: number, z: number, fallback: number): number {
  return field?.heightAt ? field.heightAt(x, z) : fallback;
}

/* ---------------------------------------------------------------- update */

/**
 * Advance the plant history and compute both feet's world ankle pins and
 * orientations. Pure bookkeeping — no bones are touched here.
 */
export function updateFeet(
  st: FeetState, loco: LocoLike, dt: number, field: FieldLike | null,
): void {
  const f = loco.foot;
  const speed = Math.hypot(loco.vel.x, loco.vel.z);
  const moving = speed >= GAIT_MIN_SPEED;

  if (!st.seeded) { seedStance(st, loco, field); st.seeded = true; }

  // --- consume the sim's plant edge -----------------------------------------
  if (f.t !== st.seenPlantT) {
    st.seenPlantT = f.t;
    if (moving || st.wasMoving) {
      const t = f.planted === 'L' ? st.L : st.R;
      t.plant.set(f.pos.x, f.pos.y, f.pos.z);
      t.hard = f.hard;
      t.stepT = -1;
    }
  }
  // Starting to move: the sim's stale plant point is wherever this player last
  // ran, possibly metres away. Adopt the feet where they are actually standing.
  if (moving && !st.wasMoving) {
    const t = f.planted === 'L' ? st.L : st.R;
    t.plant.copy(t.pos);
    t.hard = false;
  }
  st.wasMoving = moving;

  st.free = loco.air.airborne || loco.prone
    || loco.state === 'recovery' || loco.state === 'fall';
  // Coming back off the deck: the recorded plants are wherever this player fell
  // over, which may be metres behind. Put the feet under the body again.
  if (st.wasFree && !st.free) seedStance(st, loco, field);
  st.wasFree = st.free;

  // Filtered ground normal — a step onto a ridge should not snap the ankle.
  if (field?.normalAt) field.normalAt(loco.pos.x, loco.pos.z, _n);
  else _n.set(loco.groundN.x, loco.groundN.y, loco.groundN.z);
  st.normal.lerp(_n, 1 - Math.exp(-14 * dt)).normalize();

  if (st.free) {
    st.L.contact = false; st.R.contact = false;
    st.L.uStance = 1; st.R.uStance = 1;
    return;
  }
  if (!moving) { idleFeet(st, loco, dt, field); return; }

  const rate = stepRate(speed);
  const duty = dutyFactor(speed);
  const ds = Math.max(1e-3, duty * 0.5);
  const stride = speed / rate;
  const mode = loco.state === 'shuffle' ? 'shuffle' : loco.state === 'backpedal' ? 'backpedal' : 'run';
  const half = stanceHalfWidth(speed, mode);
  const sp = clamp01(speed / 8.5);

  const inv = 1 / Math.max(1e-6, speed);
  const tx = loco.vel.x * inv, tz = loco.vel.z * inv;         // travel, world
  const fx = Math.sin(loco.facing), fz = Math.cos(loco.facing);
  const rx = -fz, rz = fx;                                     // athlete's right
  const lift = Math.min(SWING_LIFT_MAX, SWING_LIFT_BASE + SWING_LIFT_RATE * speed);

  for (let i = 0; i < 2; i++) {
    const t = i === 0 ? st.L : st.R;
    t.stepT = -1;
    const isSimFoot = (f.planted === 'L') === (t.side === 1);
    // Own cycle position, derived from the sim's step phase — see the header.
    const u = isSimFoot ? f.phase * 0.5 : f.phase * 0.5 + 0.5;
    t.u = u;
    t.contact = isSimFoot && f.contact;
    t.uStance = clamp01(u / ds);

    if (t.contact) {
      t.pos.copy(t.plant);
      stancePitch(t, t.uStance, sp, dt);
    } else {
      const s = clamp01((u - ds) / (1 - ds));
      // Where advanceGait will put it, evaluated at the landing instant.
      const tau = (1 - u) * 2 / rate;
      const sgn = t.side === 1 ? -1 : 1;          // the R foot goes to the right
      const px = loco.pos.x + loco.vel.x * tau + tx * stride * 0.30 + rx * half * sgn;
      const pz = loco.pos.z + loco.vel.z * tau + tz * stride * 0.30 + rz * half * sgn;
      t.land.set(px, groundAt(field, px, pz, loco.groundY), pz);

      const h = smootherstep(s);
      t.pos.lerpVectors(t.plant, t.land, h);
      // The heel kicks back out of toe-off before the knee drives through.
      const back = -0.09 * sp * Math.sin(Math.PI * s) * (1 - s) * stride;
      t.pos.x += tx * back;
      t.pos.z += tz * back;
      t.pos.y += lift * Math.pow(Math.sin(Math.PI * Math.pow(s, 0.72)), 1.25);
      swingPitch(t, s, sp);
    }

    // Toe-out, plus more on the braced outside foot of a hard cut.
    const cut = t.hard && loco.state === 'cut';
    t.worldYaw = loco.facing + (TOE_OUT + (cut ? 0.22 : 0)) * t.side;
    t.roll = cut ? -0.16 * t.side : 0;
    t.toe = clamp(-t.pitch, 0, TOE_EXT_MAX);
  }
}

/** Foot pitch across stance: strike → flat → push-off. */
function stancePitch(t: FootTrack, k: number, sp: number, dt: number): void {
  // Forefoot strike at sprint, heel strike at jog. The crossover is real, and
  // it is one of the few gait details a viewer can actually name.
  const strike = 0.24 - 0.40 * sp;
  let pitch: number;
  if (k < 0.28) pitch = lerp(strike, 0, smooth(k / 0.28));
  else if (k < 0.55) pitch = 0;
  else pitch = lerp(0, -TOE_OFF * (0.55 + 0.55 * sp), smooth((k - 0.55) / 0.45));
  t.pitch = pitch + (t.pitch - pitch) * Math.exp(-40 * dt);
}

/** Foot pitch across swing: finish push-off, dorsiflex to clear, then set. */
function swingPitch(t: FootTrack, s: number, sp: number): void {
  const off = -TOE_OFF * (0.55 + 0.55 * sp);
  const strike = 0.24 - 0.40 * sp;
  if (s < 0.22) t.pitch = lerp(off, 0.10, smooth(s / 0.22));
  else if (s < 0.62) t.pitch = lerp(0.10, 0.26, smooth((s - 0.22) / 0.40));
  else t.pitch = lerp(0.26, strike, smooth((s - 0.62) / 0.38));
}

/* ------------------------------------------------------------------ idle */

function seedStance(st: FeetState, loco: LocoLike, field: FieldLike | null): void {
  const fx = Math.sin(loco.facing), fz = Math.cos(loco.facing);
  const rx = -fz, rz = fx;
  for (let i = 0; i < 2; i++) {
    const t = i === 0 ? st.L : st.R;
    const sgn = t.side === 1 ? -1 : 1;
    const x = loco.pos.x + rx * 0.115 * sgn;
    const z = loco.pos.z + rz * 0.115 * sgn;
    t.plant.set(x, groundAt(field, x, z, loco.groundY), z);
    t.pos.copy(t.plant);
    t.contact = true;
    t.worldYaw = loco.facing + TOE_OUT * t.side;
  }
}

/**
 * Standing still. The feet do NOT track the body — they stay where they were
 * put and only re-step when the body has crept far enough that holding them
 * would tear the legs apart. That is what makes an idle read as weight on the
 * ground instead of a mannequin skating on an invisible turntable.
 */
function idleFeet(st: FeetState, loco: LocoLike, dt: number, field: FieldLike | null): void {
  const fx = Math.sin(loco.facing), fz = Math.cos(loco.facing);
  const rx = -fz, rz = fx;
  const wide = loco.state === 'shuffle' ? 0.20 : 0.115;
  for (let i = 0; i < 2; i++) {
    const t = i === 0 ? st.L : st.R;
    const sgn = t.side === 1 ? -1 : 1;
    // A staggered stance: the trail foot sits a few centimetres back.
    const wx = loco.pos.x + rx * wide * sgn - fx * 0.022 * sgn;
    const wz = loco.pos.z + rz * wide * sgn - fz * 0.022 * sgn;
    const gy = groundAt(field, wx, wz, loco.groundY);

    if (t.stepT >= 0) {
      t.stepT += dt;
      const s = clamp01(t.stepT / IDLE_STEP_TIME);
      const h = smootherstep(s);
      t.pos.set(
        lerp(t.stepFrom.x, wx, h),
        lerp(t.stepFrom.y, gy, h) + 0.055 * Math.sin(Math.PI * s),
        lerp(t.stepFrom.z, wz, h),
      );
      t.pitch = 0.20 * Math.sin(Math.PI * s);
      t.contact = false;
      t.uStance = 1;
      if (s >= 1) {
        t.stepT = -1;
        t.plant.set(wx, gy, wz);
        t.pos.copy(t.plant);
        t.contact = true;
        t.uStance = 0.4;
      }
    } else if (Math.hypot(t.plant.x - wx, t.plant.z - wz) > IDLE_STEP_TRIGGER) {
      t.stepT = 0;
      t.stepFrom.copy(t.pos);
    } else {
      t.pos.copy(t.plant);
      t.contact = true;
      t.uStance = 0.4;
      t.pitch += (0 - t.pitch) * (1 - Math.exp(-16 * dt));
    }
    t.u = 0;
    t.hard = false;
    t.worldYaw = loco.facing + TOE_OUT * t.side;
    t.roll = 0;
    t.toe = 0;
  }
}

/* --------------------------------------------------------------- solving */

/**
 * How far the hips must drop for both ankles to be reachable, metres. Run
 * BEFORE the full FK so the whole body settles together instead of the legs
 * stretching straight and then snapping.
 */
export function hipDrop(
  st: FeetState, kine: Kine, frame: Frame, hipL: THREE.Vector3, hipR: THREE.Vector3,
): number {
  if (st.free) return 0;
  const reach = (kine.thigh + kine.shin) * 0.995;
  let worst = 0;
  for (let i = 0; i < 2; i++) {
    const t = i === 0 ? st.L : st.R;
    const hip = i === 0 ? hipL : hipR;
    ankleWorld(t, kine, st.normal, _p);
    frame.toLocal(_p.x, _p.y, _p.z, _tgt);
    const need = _tgt.distanceTo(hip);
    if (need > reach) worst = Math.max(worst, need - reach);
  }
  return Math.min(worst, 0.16);
}

/**
 * Write both legs. `lean` biases the knee pole forward so the knees track over
 * the toes rather than splaying; `kneeOut` opens them for a wide stance.
 */
export function solveLegs(
  st: FeetState, kine: Kine, pose: Pose, frame: Frame,
  lean: number, kneeOut: number, speed: number,
): void {
  if (st.free) return;
  const sp = clamp01(speed / 8.5);
  _yawInv.setFromAxisAngle(UP, -frame.yaw);

  for (let i = 0; i < 2; i++) {
    const t = i === 0 ? st.L : st.R;
    const rootB = t.side === 1 ? B.thigh_L : B.thigh_R;
    const midB = t.side === 1 ? B.shin_L : B.shin_R;
    const endB = t.side === 1 ? B.foot_L : B.foot_R;
    const toeB = t.side === 1 ? B.toe_L : B.toe_R;
    const twistB = t.side === 1 ? B.thighTwist_L : B.thighTwist_R;

    ankleWorld(t, kine, st.normal, _p);
    footQuat(t, st.normal, _quat);
    frame.toLocal(_p.x, _p.y, _p.z, _tgt);

    const swing = t.contact ? 0 : 1;
    _pole.set(
      kneeOut * t.side + (t.contact ? 0.05 : 0.13) * t.side,
      0.10 + 0.28 * swing,
      1 + lean * 1.4 + 0.35 * sp * swing,
    ).normalize();

    solveLimb(kine, pose, rootB, midB, endB, _tgt, _pole, kine.thigh, kine.shin);

    _quat.premultiply(_yawInv);
    kine.setWorldQuat(pose, endB, _quat);
    kine.refreshPos(toeB);
    pose.setBend(toeB, t.toe);

    // Femoral roll: the twist bone takes a share of the thigh's roll so the
    // quad and the IT band do not shear into one ring above the knee.
    pose.setTwist(twistB, -0.30 * t.side * (t.contact ? 0.4 : 1) * sp);
  }
}

/**
 * World ankle position for a track, including the roll that keeps the sole on
 * the ground and the current pivot stationary.
 */
function ankleWorld(t: FootTrack, kine: Kine, _normal: THREE.Vector3, out: THREE.Vector3): void {
  const H = kine.height;
  const ankleY = kine.ankleY;
  const heelZ = -0.030 * H;
  const ballZ = 0.075 * H;
  const th = t.pitch;
  const c = Math.cos(th), s = Math.sin(th);

  if (!t.contact) { out.set(t.pos.x, t.pos.y + ankleY, t.pos.z); return; }

  // Two-point sole: whichever of heel/ball ends up lower sets the height.
  const heelY = -ankleY * c + heelZ * s;
  const ballY = -ankleY * c + ballZ * s;
  const y = t.pos.y - Math.min(heelY, ballY);
  // The pivot migrates heel → ball across stance; hold it still in the world.
  const k = clamp01((t.uStance - 0.18) / 0.45);
  const pz = lerp(heelZ, ballZ, smooth(k));
  const shift = pz - (ankleY * s + pz * c);
  out.set(t.pos.x + Math.sin(t.worldYaw) * shift, y, t.pos.z + Math.cos(t.worldYaw) * shift);
}

/** World orientation of the foot bone: +Y along the foot, +Z its up. */
function footQuat(t: FootTrack, normal: THREE.Vector3, out: THREE.Quaternion): void {
  const fwdX = Math.sin(t.worldYaw), fwdZ = Math.cos(t.worldYaw);
  _up.copy(normal);
  if (t.roll !== 0) {
    _axis.set(fwdX, 0, fwdZ);
    _up.applyAxisAngle(_axis, t.roll).normalize();
  }
  _fwd.set(fwdX, 0, fwdZ);
  _fwd.addScaledVector(_up, -(_up.x * fwdX + _up.z * fwdZ)).normalize();
  // Pitch about the lateral axis: swing the forward axis toward up.
  _fwd.multiplyScalar(Math.cos(t.pitch)).addScaledVector(_up, Math.sin(t.pitch)).normalize();
  frameQuat(_fwd, _up, out);
}

/** Exposed for diagnostics — the preview measures real slide from the bones. */
export { ankleWorld as debugAnkleWorld };
