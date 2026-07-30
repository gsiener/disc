import * as THREE from 'three';
import { stepRate, dutyFactor, stanceHalfWidth, GAIT_MIN_SPEED } from '../../sim/move/Gait.ts';
import { B, angDelta, clamp, clamp01, lerp, smooth, frameQuat, solveLimb, Frame, Kine, Pose } from './Kine.ts';
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
  /**
   * The yaw this foot was planted at. HELD for the whole of stance.
   *
   * Pinning the position and then letting the yaw track `loco.facing` is a
   * half-measure that reads exactly like a slide: the ankle stays put while the
   * heel and toe sweep arcs around it, and on a hard change of direction — the
   * moment the pin matters most — the planted foot spins under the athlete like
   * a turntable. A real foot picks a heading at touchdown and keeps it until it
   * leaves the ground; the body turns on top of it.
   */
  plantYaw: number;
  /** Roll about the foot's long axis — eversion on a brace. */
  roll: number;
  /** MTP (toe) extension, radians. */
  toe: number;
  /** Metres the leg came up short of the ankle target last solve. Diagnostic:
   *  anything non-zero while planted means the pin is being missed. */
  overrun: number;
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
  /**
   * Ultimate's one universal rule: a thrower keeps a pivot. Set to +1 to lock
   * the athlete's LEFT foot, -1 the right, 0 to release. While locked that foot
   * neither moves nor turns — the body rotates about it and the free foot steps
   * around, which is exactly what a pivot looks like from the sideline.
   */
  pivot: 1 | -1 | 0;
  /** Latched: the pivot is engaged and `pivotYaw` is meaningful. */
  pivotOn: boolean;
  /** World yaw the pivot foot was frozen at when it engaged. */
  pivotYaw: number;
}

function track(side: 1 | -1): FootTrack {
  return {
    side,
    plant: new THREE.Vector3(), hard: false,
    pos: new THREE.Vector3(), land: new THREE.Vector3(),
    u: 0, uStance: 0, contact: true, pitch: 0, worldYaw: 0, plantYaw: 0, roll: 0, toe: 0, overrun: 0,
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
    pivot: 0, pivotOn: false, pivotYaw: 0,
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
      // The heading is latched HERE, at the touchdown, and held all of stance.
      t.plantYaw = loco.facing
        + (TOE_OUT + (f.hard && loco.state === 'cut' ? 0.22 : 0)) * t.side;
    }
  }
  // Starting to move: the sim's stale plant point is wherever this player last
  // ran, possibly metres away. Adopt the feet where they are actually standing.
  if (moving && !st.wasMoving) {
    const t = f.planted === 'L' ? st.L : st.R;
    t.plant.copy(t.pos);
    t.plantYaw = t.worldYaw;
    t.hard = false;
  }
  st.wasMoving = moving;

  st.free = loco.air.airborne || loco.prone
    || loco.state === 'recovery' || loco.state === 'fall';
  // Coming back off the deck: the recorded plants are wherever this player fell
  // over, which may be metres behind. Put the feet under the body again.
  if (st.wasFree && !st.free) seedStance(st, loco, field);
  st.wasFree = st.free;

  // --- pivot ----------------------------------------------------------------
  // Engaging latches the foot exactly where it already is, including its yaw.
  // Freezing the yaw is the whole point: the athlete turns 120 degrees to break
  // the mark and that one foot does not turn with them.
  if (st.pivot !== 0 && !moving && !st.free) {
    if (!st.pivotOn) {
      const t = st.pivot === 1 ? st.L : st.R;
      st.pivotOn = true;
      st.pivotYaw = t.worldYaw;
      t.plant.copy(t.pos);
      t.stepT = -1;
    }
  } else {
    st.pivotOn = false;
  }

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
    const yawTarget = loco.facing + (TOE_OUT + (cut ? 0.22 : 0)) * t.side;
    if (t.contact) {
      t.worldYaw = t.plantYaw;
    } else {
      // Swing: turn onto the new heading and ARRIVE on it, so the foot is
      // already square when it lands and nothing has to rotate under load.
      const sw = clamp01((u - ds) / (1 - ds));
      t.worldYaw = t.plantYaw + angDelta(yawTarget, t.plantYaw) * smootherstep(sw);
    }
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
  // Fast. The filter is here only to bridge the swing→stance handoff without a
  // step; anything slower leaves a degree or two of residual pitch settling
  // through mid-stance, and because the ankle is shifted to compensate for
  // pitch, a settling pitch is a creeping sole.
  t.pitch = pitch + (t.pitch - pitch) * Math.exp(-75 * dt);
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
    t.plantYaw = t.worldYaw;
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
  // The free foot of a pivoting thrower re-steps far sooner than a idling one:
  // it is being walked around the plant, not holding a stance.
  const trigger = st.pivotOn ? 0.085 : IDLE_STEP_TRIGGER;
  const idleYaw = loco.facing;
  for (let i = 0; i < 2; i++) {
    const t = i === 0 ? st.L : st.R;
    const sgn = t.side === 1 ? -1 : 1;

    if (st.pivotOn && t.side === st.pivot) {
      t.pos.copy(t.plant);
      t.contact = true;
      t.uStance = 0.4;
      t.pitch += (0 - t.pitch) * (1 - Math.exp(-16 * dt));
      t.u = 0;
      t.hard = false;
      t.worldYaw = st.pivotYaw;
      t.plantYaw = st.pivotYaw;
      t.roll = 0;
      t.toe = 0;
      continue;
    }

    // A staggered stance: the trail foot sits a few centimetres back. The free
    // foot of a pivoting thrower is the exception — it is stepped OUT and
    // forward, wide, which is what gives a throw its base and what a
    // shoulder-width idle stance conspicuously does not have.
    const w = st.pivotOn ? 0.31 : wide;
    const ahead = st.pivotOn ? 0.20 : -0.022;
    const wx = loco.pos.x + rx * w * sgn + fx * ahead * sgn;
    const wz = loco.pos.z + rz * w * sgn + fz * ahead * sgn;
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
      t.worldYaw = t.plantYaw + angDelta(idleYaw + TOE_OUT * t.side, t.plantYaw) * h;
      if (s >= 1) {
        t.stepT = -1;
        t.plant.set(wx, gy, wz);
        t.pos.copy(t.plant);
        t.contact = true;
        t.uStance = 0.4;
        t.plantYaw = idleYaw + TOE_OUT * t.side;
      }
    } else if (Math.hypot(t.plant.x - wx, t.plant.z - wz) > trigger) {
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
    // A standing foot keeps the heading it was put down on. Turning on the spot
    // walks the ideal stance around the body, which trips the re-step above —
    // so the feet shuffle round to face the new way instead of pivoting on the
    // spot like a mannequin on a turntable.
    if (t.stepT < 0) t.worldYaw = t.plantYaw;
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
    // Work in world space: distance is preserved by the rig transform, and it
    // lets the plant be clamped where it lives.
    frame.toWorld(hip.x, hip.y, hip.z, _hw);
    ankleWorld(t, kine, st.normal, _p);
    let need = _p.distanceTo(_hw);

    /**
     * PAST THE HIP DROP, THE PLANT ITSELF HAS TO GIVE.
     *
     * The sim holds `contact` for a fixed fraction of the step whatever the body
     * did in the meantime, so a hard change of direction can leave the recorded
     * plant further from the hip than the leg is long. `twoBone` then clamps the
     * target to the chain's reach and the ankle lands wherever that falls —
     * which tracks the hips, frame by frame, and reads as a skate. Measured on a
     * reversing jogger it was 13 cm of shortfall and 17 mm of drift per frame,
     * against 0.3 mm for the same code running straight.
     *
     * The failure has to be made explicit and bounded. Clamp against the HIP,
     * not the centre of mass — the hip is up to a shoulder's width to the side
     * and swings with the pelvis, and clamping against the COM (as this first
     * did) simply never fires. Height is kept and only horizontal distance is
     * surrendered, so the foot stays on the ground and skids by exactly the
     * amount the leg cannot cover, which is what a dragged foot does.
     */
    const slack = 0.16;
    if (t.contact && need > reach + slack) {
      const dx = t.plant.x - _hw.x;
      const dz = t.plant.z - _hw.z;
      const dy = t.plant.y - _hw.y;
      const flat = Math.hypot(dx, dz);
      const want = Math.sqrt(Math.max(0.0025, (reach + slack) * (reach + slack) - dy * dy));
      if (flat > want && flat > 1e-5) {
        const k = want / flat;
        t.plant.x = _hw.x + dx * k;
        t.plant.z = _hw.z + dz * k;
        t.pos.copy(t.plant);
        ankleWorld(t, kine, st.normal, _p);
        need = _p.distanceTo(_hw);
      }
    }

    if (need > reach) worst = Math.max(worst, need - reach);
  }
  return Math.min(worst, 0.16);
}
const _hw = new THREE.Vector3();

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

    t.overrun = solveLimb(kine, pose, rootB, midB, endB, _tgt, _pole, kine.thigh, kine.shin);

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

  /**
   * Two-point sole. Which point is DOWN is a fact about the pitch, not about
   * the clock: toes up puts the heel on the ground, toes down puts the ball on
   * it. Choosing the pivot off a stance-phase timer instead — as this did — is
   * right at a jogger's heel strike and wrong at a sprinter's forefoot strike,
   * where the timer says "heel" for the first third of stance while the ball is
   * the part actually touching. The height came from the geometry and the
   * forward shift came from the timer, the two disagreed, and the difference
   * came out as a few millimetres of skate per frame through early stance.
   *
   * Both now read the same discriminator. Blending it across |sin θ| < 0.09 is
   * free: at θ = 0 the foot is flat and neither the height (ankleY·c − pz·s,
   * with s = 0) nor the shift (pz·(1 − c), with c = 1) depends on the pivot.
   */
  const w = clamp01(0.5 + s * 5.5);
  const pz = lerp(ballZ, heelZ, w);
  const y = t.pos.y + ankleY * c - pz * s;
  const shift = pz * (1 - c) - ankleY * s;
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
