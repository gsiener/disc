import * as THREE from 'three';
import { BONE_INDEX } from '../rig/Types.ts';
import type { BoneName } from '../rig/Types.ts';
import {
  B, clamp, clamp01, lerp, smooth, ease, frameQuat, solveLimb, Frame, Kine, Pose,
} from './Kine.ts';
import type { CatchKind, ChargeLike, HandPose, LocoLike, ReleaseLike, ThrowKind, Vec3Like } from './Types.ts';

/**
 * ============================================================================
 *  UPPER BODY — throws, catches, carries, marks, hands
 * ============================================================================
 *
 * THROWS. A disc throw is a kinetic chain and it fails to read if the links
 * fire together: hips, then chest, then upper arm, then forearm, then a wrist
 * snap. Each channel below evaluates the same normalised whip time through its
 * own window (`LEAD`), which is the entire trick — the pelvis is done rotating
 * before the wrist has started, and the wrist covers 60° in 45 ms at the end.
 * The snap is what sells a disc throw; a throw animated as one smooth arm
 * sweep reads as a bowling motion.
 *
 * THE PIVOT FOOT. Ultimate's one universal rule is that the thrower keeps a
 * pivot. `Feet.ts` is told to lock that foot for the duration of the charge,
 * so the athlete turns about it and the free foot steps around — which is what
 * a pivot looks like, and it costs one integer.
 *
 * WINDUP TIMING comes from `PlayerIntent.charge` (src/input/Input.ts): `hold`
 * against `targetHold` is the windup's own 0..1, so a snap throw barely loads
 * and a full-power huck coils to the end of its range and waits there. That
 * also means the animation and the throw's power come from the same number and
 * cannot disagree.
 *
 * CATCHES are arm IK onto the disc's real position, not a canned reach. The
 * grip offset is what differs between a pancake (two palms closing on the flat
 * faces), a rim grab (one hand, thumb under), a sky (both hands above the
 * head) and a scoop (both palms up, below the knees).
 */

/* ------------------------------------------------------------------ tune */

/** How long the whip from windup to release takes, seconds. */
const WHIP = 0.075;
/** Follow-through decay after the release, seconds. */
const FOLLOW = 0.42;
/** Blend-in of the throw layer over the base gait. */
const THROW_FADE_IN = 0.10;
const THROW_FADE_OUT = 0.26;

/** Per-channel windows inside the whip. Hips first, wrist last. */
const LEAD = {
  pelvis: [0.00, 0.55],
  chest: [0.10, 0.62],
  shoulder: [0.24, 0.66],
  elbow: [0.40, 0.80],
  wrist: [0.66, 1.00],
} as const;

const winFrac = (a: number, w: readonly [number, number]): number =>
  smooth(clamp01((a - w[0]) / (w[1] - w[0])));

/* ------------------------------------------------------------- throw keys */

/**
 * One throw shape. Angles are in the throwing arm's own frame with `s` folded
 * in by the caller, so a left-handed athlete is the same table mirrored.
 *
 *   pelvis/chest  yaw relative to facing (+ = coiled AWAY from the target)
 *   sx/sy/sz      upper-arm bend / twist / abduction.
 *                 SIGN, because it is easy to get backwards and it looks like a
 *                 chicken wing when you do: `poseThrow` writes z as `sz * s`,
 *                 while `poseArms` writes adduction as `-(adduct) * s`. So on
 *                 BOTH sides, **negative sz adducts (arm in to the ribs) and
 *                 positive sz abducts (arm out and up)**. Bind is a 46-degree
 *                 A-pose, so sz = 0 is already a fair way off the body.
 *   elbow         forearm flexion
 *   twist         forearm pronation (the fore-arm twist bone takes 0.65 of it)
 *   wx/wy/wz      wrist
 */
interface ThrowKey {
  pelvis: number; chest: number;
  sx: number; sy: number; sz: number;
  elbow: number; twist: number;
  wx: number; wy: number; wz: number;
  /** Off-arm counterbalance: abduction and elbow. */
  offZ: number; offE: number;
  /** Extra crouch, metres, and forward weight shift. */
  drop: number; shift: number;
}

const K = (
  pelvis: number, chest: number, sx: number, sy: number, sz: number,
  elbow: number, twist: number, wx: number, wy: number, wz: number,
  offZ: number, offE: number, drop: number, shift: number,
): ThrowKey => ({ pelvis, chest, sx, sy, sz, elbow, twist, wx, wy, wz, offZ, offE, drop, shift });

/** windup → release → follow-through, per throw type. */
const THROWS: Record<ThrowKind, [ThrowKey, ThrowKey, ThrowKey]> = {
  // Backhand: coil until the off-shoulder points at the target, arm wrapped
  // across the chest, then unwind everything and finish across the body.
  backhand: [
    // The coil is ACROSS the chest — elbow tucked at the ribs, forearm
    // horizontal, disc at the far hip. sz was +1.02 here, 58 degrees of
    // abduction on top of the A-pose, which lifted the whole arm out sideways
    // and made a backhand windup look like a hammer.
    // `sy` is HUMERAL ROTATION and it decides which way the flexed elbow points
    // the forearm, which is the whole shape of the windup. Local +Y runs down
    // the bone, so on a hanging arm a positive written twist (`sy * s`) rotates
    // the elbow's flexion plane OUTWARD — and a 100-degree elbow then swings the
    // forearm up and away from the body, putting the disc beside the ear. That
    // is a hammer. A backhand wraps the other way: internal rotation, forearm
    // across the front of the chest, disc past the off hip. Measured off the
    // committed bones, the sign was inverted here — forearm direction was
    // (0.78 right, 0.61 up) at full coil where it wants to be roughly level and
    // pointing across the midline.
    K(0.42, 0.72, 0.10, 0.72, -0.72, 1.62, -0.85, 0.30, -0.75, 0.10, -0.62, 0.95, 0.055, -0.03),
    K(-0.18, -0.30, 0.62, 0.30, 0.34, 0.42, 0.55, -0.16, 0.70, -0.05, -0.20, 0.55, 0.020, 0.075),
    K(-0.34, -0.62, 0.95, 0.55, 0.10, 0.85, 0.80, -0.05, 0.95, 0.00, -0.10, 0.35, 0.010, 0.090),
  ],
  // Forehand: the shoulder barely moves. Elbow pinned at the ribs, forearm
  // cocked back and supinated, and the throw is forearm plus wrist.
  forehand: [
    K(-0.26, -0.34, 0.05, 0.85, -0.62, 1.62, 0.95, 0.42, 0.95, -0.22, -0.35, 0.70, 0.070, -0.02),
    K(0.14, 0.24, 0.34, 0.35, -0.42, 0.72, 0.20, -0.14, -0.35, 0.10, -0.15, 0.45, 0.030, 0.060),
    K(0.24, 0.42, 0.52, 0.10, -0.30, 1.05, -0.20, -0.02, -0.62, 0.16, -0.05, 0.30, 0.014, 0.070),
  ],
  // Hammer: overhead. Arm cocked behind the head, disc inverted, then a
  // forward chop that finishes low across the body.
  hammer: [
    K(-0.20, -0.42, 2.11, 0.55, 1.02, 1.95, 1.30, 0.55, 0.40, 0.00, -0.45, 0.60, 0.020, -0.06),
    K(0.10, 0.20, 1.55, 0.20, -0.25, 0.55, 0.85, -0.35, 0.10, 0.00, -0.20, 0.40, 0.010, 0.070),
    K(0.20, 0.36, 0.70, -0.05, -0.15, 0.95, 0.40, -0.55, -0.10, 0.00, -0.10, 0.28, 0.006, 0.080),
  ],
  // Scoober: inverted, released above the shoulder on the backhand side, so
  // the arm crosses the body high and the chest opens late.
  scoober: [
    K(0.34, 0.58, 2.47, -0.95, 0.34, 1.95, -1.15, 0.45, -0.55, 0.15, -0.55, 0.85, 0.045, -0.02),
    K(-0.10, -0.18, 1.62, -0.20, 0.35, 0.85, -0.30, -0.20, 0.30, 0.05, -0.20, 0.50, 0.018, 0.060),
    K(-0.22, -0.38, 1.90, 0.15, 0.10, 1.15, 0.05, -0.10, 0.55, 0.00, -0.10, 0.32, 0.008, 0.070),
  ],
  // Blade: a forehand thrown with the disc near-vertical, arm high and wide.
  blade: [
    K(-0.30, -0.40, 1.37, 1.05, 0.86, 1.45, 1.25, 0.50, 1.20, -0.30, -0.40, 0.65, 0.050, -0.02),
    K(0.16, 0.28, 1.25, 0.45, -0.72, 0.62, 0.45, -0.10, -0.10, 0.20, -0.15, 0.42, 0.022, 0.055),
    K(0.28, 0.46, 1.05, 0.10, -0.55, 1.00, 0.00, 0.00, -0.55, 0.24, -0.05, 0.28, 0.010, 0.065),
  ],
};

/* ----------------------------------------------------------------- state */

export interface ThrowState {
  active: boolean;
  kind: ThrowKind;
  /** Throwing side: +1 = the athlete's left hand, -1 = right. */
  hand: 1 | -1;
  /** Pivot foot, locked for the duration. Opposite the throwing hand. */
  pivot: 1 | -1;
  /** 0..1 coil depth. */
  wind: number;
  /** Seconds since the release fired; < 0 while still charging. */
  relT: number;
  /** Layer weight, 0..1. */
  w: number;
  power: number;
  tilt: number;
  /** Aim yaw relative to the athlete's facing. */
  aimRel: number;
  /** True while retracting from a pump fake. */
  faking: boolean;
}

export interface CatchState {
  active: boolean;
  kind: CatchKind;
  /** Seconds since the reach began. */
  t: number;
  w: number;
  /** Set once the disc is in the hands; drives the draw-in and the grip. */
  caught: boolean;
  caughtT: number;
  /** Which hand leads a one-handed grab. */
  hand: 1 | -1;
}

export function makeThrow(handed: 1 | -1): ThrowState {
  return {
    active: false, kind: 'backhand', hand: handed, pivot: (-handed) as 1 | -1,
    wind: 0, relT: -1, w: 0, power: 0, tilt: 0, aimRel: 0, faking: false,
  };
}

export function makeCatch(handed: 1 | -1): CatchState {
  return { active: false, kind: 'pancake', t: 0, w: 0, caught: false, caughtT: 0, hand: handed };
}

/* --------------------------------------------------------------- scratch */

const _t = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _fw = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
// `reachArm` runs twice for a two-handed catch and must not scribble on the two
// vectors its caller is holding. These are its own; the aliasing that used to be
// here silently fed the second hand a target of "wherever the first hand ended
// up", which is a hard bug to see and an easy one to avoid.
const _disc = new THREE.Vector3();
const _appr = new THREE.Vector3();
const _hand = new THREE.Vector3();
const _grip = new THREE.Vector3();
const _palm = new THREE.Vector3();
/** Hand-local +X in rig space — across the knuckles, i.e. the thumb axis. */
const _thumb = new THREE.Vector3();

/* ---------------------------------------------------------------- throws */

/** Advance the throw layer's timers. */
export function stepThrow(ts: ThrowState, charge: ChargeLike | null, dt: number): void {
  if (charge && charge.active && ts.relT < 0) {
    ts.active = true;
    ts.faking = false;
    ts.kind = charge.type;
    ts.power = charge.power;
    ts.tilt = charge.tilt;
    const target = Math.max(0.08, charge.targetHold || 0.45);
    ts.wind = clamp01(charge.hold / target);
    ts.pivot = (-ts.hand) as 1 | -1;
  }
  if (!ts.active) { ts.w = Math.max(0, ts.w - dt / THROW_FADE_OUT); return; }

  if (ts.relT >= 0) {
    ts.relT += dt;
    if (ts.relT > FOLLOW + THROW_FADE_OUT) { ts.active = false; ts.relT = -1; }
  } else if (ts.faking) {
    ts.wind = Math.max(0, ts.wind - dt * 4.5);
    if (ts.wind <= 0) { ts.active = false; ts.faking = false; }
  }

  const fade = ts.relT >= 0 && ts.relT > FOLLOW
    ? 1 - clamp01((ts.relT - FOLLOW) / THROW_FADE_OUT)
    : 1;
  const wTarget = fade * (ts.faking ? ts.wind : 1);
  ts.w = ts.w < wTarget
    ? Math.min(wTarget, ts.w + dt / THROW_FADE_IN)
    : Math.max(wTarget, ts.w - dt / THROW_FADE_OUT);
}

export function fireRelease(ts: ThrowState, rel: ReleaseLike | null): void {
  if (!ts.active) { ts.active = true; ts.wind = 0.8; }
  ts.relT = 0;
  ts.faking = false;
  if (rel) { ts.kind = rel.type; ts.power = rel.power; ts.tilt = rel.tilt; }
}

/**
 * Write the throw pose into `dst` (a scratch pose) and return the layer weight.
 * The caller masks it over the base gait, so the legs keep running underneath.
 */
export function poseThrow(ts: ThrowState, dst: Pose, base: Pose, detail: number): number {
  if (ts.w <= 0.001) return 0;
  dst.copyFrom(base);

  const keys = THROWS[ts.kind];
  const s = ts.hand;
  // Whip time: 0 at full coil, 1 at release, then decaying through follow.
  let a: number;
  let f: number;                                  // follow-through blend
  if (ts.relT < 0) {
    a = 0; f = 0;
  } else if (ts.relT < WHIP) {
    a = ts.relT / WHIP; f = 0;
  } else {
    a = 1; f = smooth(clamp01((ts.relT - WHIP) / (FOLLOW * 0.55)));
  }

  // Coil scales with how long the charge was held; a snap throw barely loads.
  const coil = lerp(0.45, 1, ts.wind) * (0.75 + 0.25 * ts.power);
  const k0 = keys[0], k1 = keys[1], k2 = keys[2];

  const mix = (ch: keyof ThrowKey, w: readonly [number, number]): number => {
    const p = winFrac(a, w);
    const rel = lerp(k0[ch] * (ch === 'pelvis' || ch === 'chest' ? coil : 1), k1[ch], p);
    return lerp(rel, k2[ch], f * p);
  };

  const pelvis = mix('pelvis', LEAD.pelvis) * s;
  const chest = mix('chest', LEAD.chest) * s;
  const sx = mix('sx', LEAD.shoulder);
  const sy = mix('sy', LEAD.shoulder) * s;
  const sz = mix('sz', LEAD.shoulder) * s;
  const elbow = mix('elbow', LEAD.elbow);
  const twist = mix('twist', LEAD.wrist) * s;
  const wx = mix('wx', LEAD.wrist);
  const wy = mix('wy', LEAD.wrist) * s;
  const wz = mix('wz', LEAD.wrist) * s;
  const drop = mix('drop', LEAD.pelvis);
  const shift = mix('shift', LEAD.chest);

  // Aim is a whole-body offset: the thrower turns onto the line before the
  // chain starts, so the release is square to where the disc is going.
  const aim = clamp(ts.aimRel, -0.9, 0.9);

  dst.hip.y -= drop;
  dst.hip.z += shift;
  dst.addEuler(B.pelvis, 0, pelvis + aim * 0.35, 0);
  dst.addEuler(B.spine01, 0.04 * shift * 10, chest * 0.18 + aim * 0.16, 0);
  dst.addEuler(B.spine02, 0, chest * 0.26 + aim * 0.18, 0);
  dst.addEuler(B.spine03, 0, chest * 0.28 + aim * 0.16, 0);
  dst.addEuler(B.chest, 0, chest * 0.28 + aim * 0.14, 0);

  const ua = s === 1 ? B.upperArm_L : B.upperArm_R;
  const fa = s === 1 ? B.foreArm_L : B.foreArm_R;
  const hd = s === 1 ? B.hand_L : B.hand_R;
  const faT = s === 1 ? B.foreArmTwist_L : B.foreArmTwist_R;
  const uaT = s === 1 ? B.upperArmTwist_L : B.upperArmTwist_R;
  const cl = s === 1 ? B.clavicle_L : B.clavicle_R;

  dst.setEuler(ua, sx, sy, sz);
  dst.setBend(fa, elbow);
  dst.setTwist(uaT, sy * 0.5);
  dst.setTwist(faT, twist * 0.65);
  // The disc's angle of release. `tilt` is the player's requested edge angle;
  // it lands on the wrist, which is exactly where a real thrower puts it.
  dst.setEuler(hd, wx, wy + twist * 0.35, wz + ts.tilt * 0.55 * s);
  dst.setEuler(cl, -0.06 - 0.10 * winFrac(a, LEAD.shoulder), -0.10 * s, 0.12 * s);

  // Off arm: counterbalances, then folds in as the throw finishes.
  const oz = mix('offZ', LEAD.chest) * -s;
  const oe = mix('offE', LEAD.chest);
  const oua = s === 1 ? B.upperArm_R : B.upperArm_L;
  const ofa = s === 1 ? B.foreArm_R : B.foreArm_L;
  // The off arm counterbalances, which means it goes BACK as the chest opens,
  // not forward with it. Driving it forward through the follow-through put both
  // arms out in front of the athlete at release — the pose reads as a zombie,
  // and it is the opposite of the counter-rotation the throw is built on.
  dst.setEuler(oua, 0.18 - 0.92 * f, 0, oz);
  dst.setBend(ofa, oe);
  // The off-side girdle too. Not for the look — this layer is blended through a
  // whole-arm mask, so a bone left at identity here actively erases whatever the
  // running arms had put there.
  const ocl = s === 1 ? B.clavicle_R : B.clavicle_L;
  dst.setEuler(ocl, -0.04 + 0.05 * f, 0.06 * s, -0.06 * s);

  // Hands: the throwing hand grips until release, then opens through follow.
  const grip = ts.relT < 0 ? 1 : 1 - smooth(clamp01(ts.relT / 0.14));
  poseHand(dst, s, grip > 0.5 ? 'grip' : 'open', detail, 1);
  poseHand(dst, (-s) as 1 | -1, 'relax', detail, 1);

  return ts.w;
}

/* --------------------------------------------------------------- catches */

export function startCatch(cs: CatchState, kind: CatchKind, hand?: 1 | -1): void {
  cs.active = true;
  cs.kind = kind;
  cs.t = 0;
  cs.caught = false;
  cs.caughtT = 0;
  if (hand) cs.hand = hand;
}

export function stepCatch(cs: CatchState, dt: number): void {
  if (!cs.active) { cs.w = Math.max(0, cs.w - dt / 0.22); return; }
  cs.t += dt;
  if (cs.caught) {
    cs.caughtT += dt;
    if (cs.caughtT > 0.55) cs.active = false;
  } else if (cs.t > 1.6) {
    cs.active = false;                            // the disc never arrived
  }
  cs.w = Math.min(1, cs.w + dt / 0.11);
}

/** Pick the catch shape from where the disc actually is. */
export function classifyCatch(discY: number, chestY: number, headY: number): CatchKind {
  if (discY > headY + 0.10) return 'sky';
  if (discY < chestY - 0.55) return 'scoop';
  if (discY > chestY + 0.28) return 'rim';
  return 'pancake';
}

/**
 * Reach for the disc. Runs AFTER the base arms are posed and after the full
 * FK, and solves in place — so the shoulders it works from are the ones the
 * running torso actually produced.
 */
export function poseCatch(
  cs: CatchState, kine: Kine, pose: Pose, frame: Frame,
  disc: Vec3Like, discVel: Vec3Like | null, detail: number,
): void {
  if (cs.w <= 0.001) return;
  const w = cs.w * (cs.caught ? 1 - 0.45 * smooth(clamp01(cs.caughtT / 0.4)) : 1);

  // Approach direction: the disc arrives along its velocity, so the palms face
  // back down that line. Falling back to "toward the athlete" is fine for a
  // hovering disc, which is the only case that produces no velocity.
  _appr.set(-(discVel?.x ?? 0), -(discVel?.y ?? 0), -(discVel?.z ?? 0));
  if (_appr.lengthSq() < 1e-4) _appr.set(0, 0, -1);
  _appr.normalize();

  frame.toLocal(disc.x, disc.y, disc.z, _disc);
  // As the catch completes, draw the disc in toward the sternum.
  if (cs.caught) {
    const k = smooth(clamp01(cs.caughtT / 0.42));
    const chest = B.chest * 3;
    _tmp2.set(kine.wp[chest], kine.wp[chest + 1] + 0.06, kine.wp[chest + 2] + 0.22);
    _disc.lerp(_tmp2, k * 0.8);
  }

  const two = cs.kind === 'pancake' || cs.kind === 'sky' || cs.kind === 'scoop';
  for (let si = 0; si < 2; si++) {
    const s: 1 | -1 = si === 0 ? 1 : -1;
    if (!two && s !== cs.hand) continue;
    reachArm(kine, pose, frame, s, cs.kind, _disc, _appr, w);
    poseHand(pose, s, cs.caught ? 'grip' : 'open', detail, w);
  }
}

/**
 * Rig-space position of the disc as it sits in the hand. Local +Y runs down the
 * fingers and local +Z is the palm, so the disc centre is a palm's width along
 * the fingers and a rim's thickness off the palm.
 */
export function discInHand(
  kine: Kine, s: 1 | -1, outPos: THREE.Vector3, outNormal: THREE.Vector3,
): void {
  const hd = s === 1 ? B.hand_L : B.hand_R;
  kine.worldQuat(hd, _wq);
  _up.set(0, 1, 0).applyQuaternion(_wq);            // down the fingers
  _palm.set(0, 0, 1).applyQuaternion(_wq);          // out of the palm
  _thumb.set(1, 0, 0).applyQuaternion(_wq);         // across the knuckles
  const o = hd * 3;
  /**
   * THE FACE NORMAL IS THE THUMB AXIS, NOT THE PALM.
   *
   * A grip on a disc puts the fingers curled UNDER the rim and the thumb flat on
   * the flight plate — so the plate contains the finger direction (the rim runs
   * away from the wrist along +Y, which is why the centre is offset along it)
   * and its normal is the thumb. Reporting the palm instead put the plate at
   * ninety degrees to where it physically is: from any camera off to the side —
   * which is every camera in `Shots.ts` — a carried disc presented a 3 mm edge
   * and vanished. `broadcast` and `sideline` are both *about* a handler on the
   * disc and neither of them had a visible disc in it.
   *
   * Sign: rig +X is the athlete's LEFT, and `s` is +1 for a left-hander, so
   * `n.x * s > 0` is the face turned out to the throwing side. That is the way
   * a handler holds it while he reads the field, and it is the orientation that
   * shows a full plate to a sideline lens.
   */
  if (_thumb.x * s < 0) _thumb.multiplyScalar(-1);
  outPos.set(kine.wp[o], kine.wp[o + 1], kine.wp[o + 2])
    .addScaledVector(_up, 0.085)
    .addScaledVector(_palm, 0.020)
    .addScaledVector(_thumb, 0.014);
  outNormal.copy(_thumb);
}

/** Grip offsets, rig space, relative to the disc centre. */
function gripOffset(kind: CatchKind, s: 1 | -1, out: THREE.Vector3): void {
  switch (kind) {
    // Palms on the flat faces, one above one below, wrists back off the rim.
    case 'pancake': out.set(0.015 * s, s === 1 ? 0.075 : -0.075, -0.055); break;
    // Both hands above the head, thumbs in, wrists outboard of the rim.
    case 'sky': out.set(0.115 * s, -0.055, -0.045); break;
    // Palms up under the disc, hands wide.
    case 'scoop': out.set(0.105 * s, -0.085, -0.030); break;
    // One hand: the wrist sits a hand's length back along the rim.
    case 'trail': out.set(0.13 * s, -0.02, -0.10); break;
    default: out.set(0.125 * s, 0.010, -0.075); break;
  }
}

function reachArm(
  kine: Kine, pose: Pose, frame: Frame, s: 1 | -1, kind: CatchKind,
  discLocal: THREE.Vector3, approach: THREE.Vector3, w: number,
): void {
  const cl = s === 1 ? B.clavicle_L : B.clavicle_R;
  const ua = s === 1 ? B.upperArm_L : B.upperArm_R;
  const fa = s === 1 ? B.foreArm_L : B.foreArm_R;
  const hd = s === 1 ? B.hand_L : B.hand_R;
  const faT = s === 1 ? B.foreArmTwist_L : B.foreArmTwist_R;

  // The shoulder girdle reaches too — a catch at full extension is not just an
  // arm, it is a protracted scapula and a rotated chest.
  pose.addEuler(cl, -0.10 * w, -0.16 * s * w, 0.10 * s * w);
  kine.refresh(pose, cl);
  kine.refreshPos(ua);

  gripOffset(kind, s, _grip);
  _t.copy(discLocal).add(_grip);
  // Blend from wherever the arm already is toward the reach, so a catch that
  // starts mid-stride does not teleport the hand.
  if (w < 1) {
    kine.worldPos(hd, _hand);
    _t.lerp(_hand, 1 - w);
  }

  // Elbow below and outside the line to the disc; a high sky pulls it inward.
  const high = kind === 'sky';
  _pole.set(
    (high ? 0.35 : 0.85) * s,
    high ? -0.55 : -1,
    high ? 0.35 : 0.55,
  ).normalize();
  solveLimb(kine, pose, ua, fa, hd, _t, _pole, kine.upperArm, kine.foreArm);

  // Hand orientation: local +Y down the fingers, local +Z is the PALM. Point
  // the fingers past the disc and turn the palm onto the incoming line.
  frame.dirToLocal(approach.x, approach.z, _up);
  _up.y = approach.y;
  _up.normalize();
  kine.worldPos(hd, _hand);
  _fw.subVectors(discLocal, _hand);
  if (_fw.lengthSq() < 1e-6) _fw.set(0, 0, 1);
  let palmX = 0, palmY = 0, palmZ = 0;
  switch (kind) {
    case 'pancake': palmY = s === 1 ? -1 : 1; break;      // top palm down
    case 'scoop': palmY = 1; break;                       // palms up
    case 'sky': palmX = -0.35 * s; palmY = -0.15; palmZ = 0; break;
    default: palmX = -0.30 * s; palmY = 0.15; break;
  }
  _palm.set(palmX, palmY, palmZ);
  if (_palm.lengthSq() < 1e-6) _palm.copy(_up);
  else _palm.addScaledVector(_up, 0.55).normalize();
  frameQuat(_fw, _palm, _wq);
  kine.setWorldQuat(pose, hd, _wq);
  pose.setTwist(faT, 0.45 * s);
}

/* -------------------------------------------------------- carry and mark */

/**
 * Holding the disc while running or standing. The disc rides low on the
 * throwing side with the fingers under the rim — not clamped to the chest,
 * which is what a placeholder does.
 */
export function poseCarry(
  pose: Pose, s: 1 | -1, w: number, detail: number, sp: number, out = 0,
): void {
  if (w <= 0.001) return;
  const ua = s === 1 ? B.upperArm_L : B.upperArm_R;
  const fa = s === 1 ? B.foreArm_L : B.foreArm_R;
  const hd = s === 1 ? B.hand_L : B.hand_R;
  const faT = s === 1 ? B.foreArmTwist_L : B.foreArmTwist_R;
  /**
   * A RUNNING carry and a STANDING carry are different holds and `out` is which
   * one this is. Running, the disc is tucked in at the hip where it does not
   * cost you an arm; standing over a pivot with a mark in your face, it is held
   * out at arm's length on the throwing side, away from the defender's hands.
   * The old pose only had the tuck, so a handler on the disc — the subject of
   * two of the ten named framings — stood with the disc glued to his waist.
   *
   * z is signed: `poseArms` writes adduction as `-(adduct) * s`, so on both
   * sides a NEGATIVE `z * s` product adducts and a positive one abducts.
   */
  /**
   * The extended hold has to be MEASURABLY different from the tuck or the two
   * blend into one indeterminate arm. At out = 1 the elbow opens from 73 to 33
   * degrees and the shoulder both flexes and abducts, which puts the disc a
   * clear 30-35 cm outside the silhouette of the torso — the difference between
   * a disc a sideline camera can see and a disc pressed against a sternum, which
   * is what `sideline` and `broadcast` were both showing.
   */
  const abduct = lerp(-0.42, 0.50, out) - 0.30 * sp;
  blendEuler(pose, ua, 0.30 + 0.10 * sp + 0.24 * out, -0.20 * s, abduct * s, w);
  blendBend(pose, fa, lerp(1.28, 0.62, out) - 0.12 * sp, w);
  // Wrist cocked so the plate stands up rather than lying flat in the palm.
  blendEuler(pose, hd, -0.18 - 0.18 * out, (0.55 + 0.30 * out) * s, 0.15 * s, w);
  pose.setTwist(faT, lerp(0, 0.72 * s, w));
  poseHand(pose, s, 'grip', detail, w);
  // The off hand comes across as a screen on a standing hold — a handler does
  // not leave it hanging while somebody is reaching for the disc.
  if (out > 0.02) {
    const oua = s === 1 ? B.upperArm_R : B.upperArm_L;
    const ofa = s === 1 ? B.foreArm_R : B.foreArm_L;
    blendEuler(pose, oua, 0.46 * out, 0, -0.34 * out * -s, w * out);
    blendBend(pose, ofa, 1.05 * out, w * out);
  }
}

/**
 * Active mark: hands out in the throwing lanes, hips low, feet wide.
 *
 * `t` is a clock in seconds. A mark is never still — the whole job is to move
 * your hands where the disc wants to go — so the arms drift on two slow sines
 * and the drift is the difference between a defender and a scarecrow.
 */
export function poseMark(pose: Pose, force: -1 | 1, w: number, detail: number, t = 0): void {
  if (w <= 0.001) return;
  // The arm on the force side goes low to take away the break; the other goes
  // high. That asymmetry is the whole visual language of a mark.
  const drift = Math.sin(t * 2.15);
  const drift2 = Math.sin(t * 1.37 + 1.1);
  for (let si = 0; si < 2; si++) {
    const s: 1 | -1 = si === 0 ? 1 : -1;
    const low = (s === 1) === (force < 0);
    const ua = s === 1 ? B.upperArm_L : B.upperArm_R;
    const fa = s === 1 ? B.foreArm_L : B.foreArm_R;
    const hd = s === 1 ? B.hand_L : B.hand_R;
    // ABDUCTION, and the sign matters. `poseArms` writes adduction as
    // `-(adduct) * s`, so a mark — which is arms OUT, filling the lanes — is
    // `+ * s`. Written with the leading minus this put both arms across the
    // chest, which is a shrug, not a mark.
    //
    // Bind is a 46-degree A-pose, so the z delta is measured from there: 1.42
    // puts the high hand a good way above the shoulder, 0.62 takes the low one
    // out to near horizontal at waist height rather than leaving it dangling at
    // the seam of the shorts, which is where 0.15 left it. Both arms also carry
    // real forward flexion now — a mark stands IN the lanes, in front of its own
    // shoulder line; arms in the coronal plane block nothing and read as a
    // shrug from any angle but dead side-on.
    const z = (low ? 0.62 : 1.58) + 0.13 * (low ? drift2 : drift);
    const x = (low ? 0.34 : 0.28) + 0.10 * (low ? drift : drift2);
    blendEuler(pose, ua, x, 0, z * s, w);
    // The high elbow stays fairly open. Folding it (0.72 rad) brought the hand
    // back down to shoulder height and threw away the whole point of raising
    // the arm — the high hand has to sit ABOVE the head to take the lane.
    blendBend(pose, fa, low ? 0.30 : 0.44, w);
    blendEuler(pose, hd, low ? 0.22 : -0.10, 0.06 * s, 0, w);
    poseHand(pose, s, 'mark', detail, w);
  }
}

/* ----------------------------------------------------------------- hands */

const FAMS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;

/** [side][finger][joint] → bone index. Built once. */
const FING: number[][][] = [1, -1].map((s) =>
  FAMS.map((f) => [1, 2, 3].map((j) => BONE_INDEX[`${f}0${j}${s === 1 ? '_L' : '_R'}` as BoneName])),
);

/** Curl per joint, per pose, for index…pinky and then the thumb. */
const HAND_CURL: Record<HandPose, [number, number, number, number]> = {
  //            proximal  middle  distal  thumb
  run: [0.62, 0.72, 0.48, 0.34],
  relax: [0.34, 0.44, 0.30, 0.20],
  open: [0.10, 0.12, 0.08, 0.06],
  grip: [1.05, 1.02, 0.62, 0.72],
  mark: [0.06, 0.05, 0.04, 0.02],
  brace: [0.30, 0.22, 0.14, 0.30],
};

/** Per-finger scale so the hand is not four identical rods. */
const FING_SCALE = [1.0, 0.96, 1.0, 0.94];
/** Splay, radians, from index to pinky. */
const FING_SPLAY = [-0.05, 0.0, 0.055, 0.115];

export function poseHand(pose: Pose, s: 1 | -1, kind: HandPose, detail: number, w = 1): void {
  if (w <= 0.001) return;
  const c = HAND_CURL[kind];
  const set = FING[s === 1 ? 0 : 1];
  const spread = kind === 'open' || kind === 'mark' ? 1 : 0.35;
  for (let f = 1; f < 5; f++) {
    const sc = FING_SCALE[f - 1];
    const sp = FING_SPLAY[f - 1] * spread * -s;
    for (let j = 0; j < 3; j++) {
      const b = set[f][j];
      const curl = c[Math.min(j, 2)] * sc;
      if (j === 0 && detail > 0.6) blendEuler(pose, b, curl, 0, sp, w);
      else blendBend(pose, b, curl, w);
    }
  }
  // The thumb opposes rather than curls; on a grip it comes over the rim.
  const th = set[0];
  const opp = kind === 'grip' ? 0.55 : kind === 'open' ? 0.20 : 0.32;
  blendEuler(pose, th[0], c[3] * 0.55, 0, -opp * s, w);
  blendBend(pose, th[1], c[3] * 0.85, w);
  blendBend(pose, th[2], c[3] * 0.70, w);
}

/* --------------------------------------------------------------- helpers */

const _bq = new THREE.Quaternion();
const _bq2 = new THREE.Quaternion();
const _be = new THREE.Euler(0, 0, 0, 'XZY');

function blendEuler(pose: Pose, i: number, x: number, y: number, z: number, w: number): void {
  if (w >= 0.999) { pose.setEuler(i, x, y, z); return; }
  _be.set(x, y, z, 'XZY');
  _bq.setFromEuler(_be);
  pose.getQuat(i, _bq2).slerp(_bq, w);
  pose.setQuat(i, _bq2);
}

function blendBend(pose: Pose, i: number, x: number, w: number): void {
  if (w >= 0.999) { pose.setBend(i, x); return; }
  const h = x * 0.5;
  _bq.set(Math.sin(h), 0, 0, Math.cos(h));
  pose.getQuat(i, _bq2).slerp(_bq, w);
  pose.setQuat(i, _bq2);
}

export { blendEuler, blendBend };

/**
 * Hand shape while simply running — cheap, and it is what most frames show.
 * `alert` is 0..1: a stationary athlete watching the disc has open, live hands;
 * one standing about at the back of the stack has relaxed ones.
 */
export function poseRunHands(pose: Pose, loco: LocoLike, detail: number, alert = 0): void {
  const k: HandPose = loco.state === 'shuffle' || loco.state === 'backpedal' ? 'open'
    : loco.state === 'sprint' ? 'run'
      : alert > 0.55 ? 'open'
        : 'relax';
  poseHand(pose, 1, k, detail);
  poseHand(pose, -1, k, detail);
}

export { ease as _ease };
