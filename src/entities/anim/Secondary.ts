import * as THREE from 'three';
import { B, clamp, clamp01, lerp, spring, TAU, Frame, Kine, Pose } from './Kine.ts';
import type { AnimSignals, GazeTarget, LocoLike } from './Types.ts';
import type { BodyState } from './Gaits.ts';

/**
 * ============================================================================
 *  SECONDARY MOTION — gaze, breathing, and the signals cloth needs
 * ============================================================================
 *
 * GAZE. The head does not turn as one piece. Split the required rotation over
 * head, neck and chest with anatomical limits (head ±43°, neck ±29°, chest
 * takes whatever is left), give each link its own spring stiffness, and the
 * *eye lead* appears for free: the head has already arrived while the chest is
 * still coming round, which is what a person tracking a disc actually looks
 * like. Past ~135° off the shoulder the athlete gives up and stops turning,
 * because a head that swivels 180° is a horror film, not a sports game.
 *
 * BREATHING is a real channel, not decoration. Rate and depth both climb as
 * `stamina` falls, which means a defender in the eighth point of a long game
 * is visibly labouring in a still frame — one of the cheapest ways a sports
 * title communicates fatigue.
 *
 * CLOTH AND HAIR. This rig has no cloth bones and no hair bones — the jersey
 * and the hair are skinned shells. The animator therefore cannot move them,
 * and pretending otherwise would be worse than not trying. What it CAN do is
 * publish the accelerations that would drive them, in the athlete's local
 * frame, for a vertex shader to integrate: `signals.chestAcc*` and
 * `signals.headAcc*`. Nothing reads them yet; they cost two vector
 * subtractions and they are the hook the material author needs.
 */

/* ----------------------------------------------------------------- state */

export interface SecondaryState {
  /** Current head/neck/chest gaze contributions, radians. */
  hY: number; hYv: number; hP: number; hPv: number;
  nY: number; nYv: number; nP: number; nPv: number;
  cY: number; cYv: number;
  /** 0..1 how much the athlete is bothering to look. */
  attend: number;
  breathT: number;
  /** World positions and velocities of chest and head, for the cloth signal. */
  cPrev: THREE.Vector3; cVel: THREE.Vector3;
  hPrev: THREE.Vector3; hVel: THREE.Vector3;
  primed: boolean;
}

export function makeSecondary(): SecondaryState {
  return {
    hY: 0, hYv: 0, hP: 0, hPv: 0, nY: 0, nYv: 0, nP: 0, nPv: 0, cY: 0, cYv: 0,
    attend: 0, breathT: 0,
    cPrev: new THREE.Vector3(), cVel: new THREE.Vector3(),
    hPrev: new THREE.Vector3(), hVel: new THREE.Vector3(),
    primed: false,
  };
}

/* ------------------------------------------------------------------ tune */

const HEAD_YAW_MAX = 0.75;
const NECK_YAW_MAX = 0.50;
const CHEST_YAW_MAX = 0.42;
const HEAD_PITCH_MAX = 0.55;
const NECK_PITCH_MAX = 0.34;
/** Beyond this total yaw the athlete stops trying to look. */
const GIVE_UP = 2.35;

const _d = new THREE.Vector3();
const _g = new THREE.Vector3();
const _w = new THREE.Vector3();

/* ------------------------------------------------------------------ gaze */

/**
 * Track a world point with the head. Call after the spine is posed and the FK
 * has run, so the chest orientation it works against is the real one.
 */
export function poseGaze(
  ss: SecondaryState, kine: Kine, pose: Pose, frame: Frame,
  target: GazeTarget | null, want: number, dt: number,
): void {
  let yaw = 0, pitch = 0, attend = 0;
  if (target && want > 0.001) {
    frame.toLocal(target.x, target.y, target.z, _g);
    const h = B.head * 3;
    _d.set(_g.x - kine.wp[h], _g.y - kine.wp[h + 1] - 0.09, _g.z - kine.wp[h + 2]);
    const flat = Math.hypot(_d.x, _d.z);
    if (flat > 1e-4 || Math.abs(_d.y) > 1e-4) {
      yaw = Math.atan2(_d.x, _d.z);
      pitch = Math.atan2(_d.y, Math.max(1e-4, flat));
      attend = Math.abs(yaw) > GIVE_UP ? 0 : want;
    }
  }
  ss.attend = lerp(ss.attend, attend, 1 - Math.exp(-9 * dt));
  const a = ss.attend;

  // Distribute: the head takes what it can, the neck takes the overflow, the
  // chest takes what is left. Each link is a spring with its own stiffness,
  // and the stiffness gradient IS the eye lead.
  const tY = yaw * a, tP = clamp(pitch, -0.85, 0.75) * a;
  const hY = clamp(tY, -HEAD_YAW_MAX, HEAD_YAW_MAX);
  const nY = clamp(tY - hY, -NECK_YAW_MAX, NECK_YAW_MAX);
  const cY = clamp(tY - hY - nY, -CHEST_YAW_MAX, CHEST_YAW_MAX);
  const hP = clamp(tP, -HEAD_PITCH_MAX, HEAD_PITCH_MAX);
  const nP = clamp(tP - hP, -NECK_PITCH_MAX, NECK_PITCH_MAX);

  [ss.hY, ss.hYv] = spring(ss.hY, ss.hYv, hY, 24, dt);
  [ss.nY, ss.nYv] = spring(ss.nY, ss.nYv, nY, 15, dt);
  [ss.cY, ss.cYv] = spring(ss.cY, ss.cYv, cY, 8, dt);
  [ss.hP, ss.hPv] = spring(ss.hP, ss.hPv, hP, 22, dt);
  [ss.nP, ss.nPv] = spring(ss.nP, ss.nPv, nP, 14, dt);

  // Local +Y is up the spine, so yaw is the twist channel; +X tips forward, so
  // looking up is negative.
  pose.addEuler(B.head, -ss.hP, ss.hY, 0);
  pose.addEuler(B.neck, -ss.nP, ss.nY, 0);
  if (Math.abs(ss.cY) > 1e-4) {
    pose.addEuler(B.chest, 0, ss.cY * 0.55, 0);
    pose.addEuler(B.spine03, 0, ss.cY * 0.45, 0);
  }
}

/* ------------------------------------------------------------- breathing */

/**
 * Chest rise and shoulder lift. Additive, so it runs under a throw or a catch
 * without fighting them.
 */
export function poseBreath(
  ss: SecondaryState, pose: Pose, loco: LocoLike, bs: BodyState, dt: number, scale = 1,
): number {
  const fatigue = clamp01(1 - loco.stamina / 100);
  const work = clamp01(bs.sp * 0.85 + fatigue * 0.6);
  // 0.32 Hz at rest through to ~1.15 Hz when cooked and sprinting.
  const rate = 0.32 + 0.83 * work;
  ss.breathT += dt * rate;
  if (ss.breathT > 1) ss.breathT -= Math.floor(ss.breathT);

  const depth = (0.30 + 0.70 * work) * scale;
  // Asymmetric: the inhale is quicker than the exhale, more so when labouring.
  const p = ss.breathT;
  const inh = 0.42 - 0.10 * work;
  const c = p < inh
    ? Math.sin((p / inh) * Math.PI * 0.5)
    : Math.cos(((p - inh) / (1 - inh)) * Math.PI * 0.5);

  const amp = 0.030 * depth;
  pose.addEuler(B.spine03, -amp * c, 0, 0);
  pose.addEuler(B.chest, -amp * 1.3 * c, 0, 0);
  pose.addEuler(B.clavicle_L, -amp * 1.8 * c, 0, 0);
  pose.addEuler(B.clavicle_R, -amp * 1.8 * c, 0, 0);
  // A hard breath lifts the head a little too.
  pose.addEuler(B.neck, amp * 0.8 * c, 0, 0);
  return depth * c;
}

/**
 * Fatigue posture: shoulders forward, head down, hands drifting toward the
 * shorts. Sub-threshold at full stamina; unmistakable below 25.
 */
export function poseFatigue(pose: Pose, loco: LocoLike, bs: BodyState): number {
  const f = clamp01((45 - loco.stamina) / 45);
  if (f < 0.02) return 0;
  const idle = bs.speed < 0.6 ? 1 : 0.35;
  const k = f * idle;
  pose.addEuler(B.spine02, 0.10 * k, 0, 0);
  pose.addEuler(B.spine03, 0.09 * k, 0, 0);
  pose.addEuler(B.chest, 0.06 * k, 0, 0);
  pose.addEuler(B.neck, 0.11 * k, 0, 0);
  pose.addEuler(B.head, 0.07 * k, 0, 0);
  pose.addEuler(B.clavicle_L, 0.10 * k, 0.10 * k, 0);
  pose.addEuler(B.clavicle_R, 0.10 * k, -0.10 * k, 0);
  return k;
}

/* --------------------------------------------------- cloth / hair signal */

/**
 * Differentiate the chest and head world positions twice and express the
 * result in the athlete's local frame. That is everything a cloth or hair
 * shader needs to lag believably, and it is two subtractions per part.
 */
export function updateSignals(
  ss: SecondaryState, kine: Kine, frame: Frame, sig: AnimSignals, dt: number,
): void {
  if (dt <= 1e-6) return;
  const inv = 1 / dt;
  // chest
  const c = B.chest * 3;
  frame.toWorld(kine.wp[c], kine.wp[c + 1], kine.wp[c + 2], _w);
  if (!ss.primed) { ss.cPrev.copy(_w); }
  _d.subVectors(_w, ss.cPrev).multiplyScalar(inv);
  ss.cPrev.copy(_w);
  _g.subVectors(_d, ss.cVel).multiplyScalar(inv);
  ss.cVel.copy(_d);
  frame.dirToLocal(_g.x, _g.z, _d);
  sig.chestAccX = clamp(_d.x, -80, 80);
  sig.chestAccY = clamp(_g.y, -80, 80);
  sig.chestAccZ = clamp(_d.z, -80, 80);

  // head
  const h = B.head * 3;
  frame.toWorld(kine.wp[h], kine.wp[h + 1], kine.wp[h + 2], _w);
  if (!ss.primed) { ss.hPrev.copy(_w); ss.primed = true; }
  _d.subVectors(_w, ss.hPrev).multiplyScalar(inv);
  ss.hPrev.copy(_w);
  _g.subVectors(_d, ss.hVel).multiplyScalar(inv);
  ss.hVel.copy(_d);
  frame.dirToLocal(_g.x, _g.z, _d);
  sig.headAccX = clamp(_d.x, -80, 80);
  sig.headAccY = clamp(_g.y, -80, 80);
  sig.headAccZ = clamp(_d.z, -80, 80);
}

export { TAU as _TAU };
