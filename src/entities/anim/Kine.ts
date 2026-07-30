import * as THREE from 'three';
import { slerpFlat, multiplyQuaternionsFlat } from './flat.ts';
import { BONE_NAMES, BONE_INDEX } from '../rig/Types.ts';
import type { BoneName, Measure, NamedBones } from '../rig/Types.ts';

/**
 * ============================================================================
 *  KINEMATIC CORE — pose buffers, forward kinematics, two-bone IK
 * ============================================================================
 *
 * THE ONE IDEA HERE. A pose is stored as a **delta from bind**, never as an
 * absolute local rotation. `pose[i] = identity` is the A-pose; `bone.quaternion
 * = bindLocal[i] * pose[i]`. Two consequences, both load-bearing:
 *
 *   1. Blending is safe. Slerping two deltas toward identity degrades to the
 *      bind pose, so a layer at weight 0 is exactly "not playing" — you cannot
 *      accidentally average two absolute orientations into a broken limb.
 *   2. The rig's documented convention actually holds. PlayerRig says
 *      "rotation.x is the primary bend, rotation.y is twist" — that is only
 *      true about the bone's OWN axes, and writing `bone.rotation.x` discards
 *      the bind orientation with it. On `thigh_R`, whose bind local rotation is
 *      most of a half-turn (the bone points down while its parent points up),
 *      writing `rotation.x = 42°` swings the leg UP and forward. Post-
 *      multiplying a delta is what the convention means.
 *
 * EULER ORDER is 'XZY' everywhere: X (primary bend) and Z (abduction) are the
 * swing, applied outermost; Y (twist) is innermost so it spins about the bone's
 * own axis and never changes where the bone points. That is a swing-twist
 * decomposition written as an Euler order, and it is why a 90° forearm
 * pronation on a backhand does not also drag the hand sideways.
 *
 * SPACE. All FK here is **rig space** — the space of `rig.root`, i.e. origin at
 * the athlete's feet, +Z along `facing`. World ↔ rig is a yaw and a translate,
 * done by `Frame`. Solving IK in rig space means the whole chain from pelvis to
 * toe is available without a single `updateMatrixWorld`.
 */

/* --------------------------------------------------------------- scratch */

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _eul = new THREE.Euler(0, 0, 0, 'XZY');

export const NB = BONE_NAMES.length;
export const B = BONE_INDEX;

/* ----------------------------------------------------------------- maths */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (t: number): number => { const c = clamp01(t); return c * c * (3 - 2 * c); };
/** Sine-in-out over 0..1 — softer than smoothstep at the ends. */
export const ease = (t: number): number => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));
export const TAU = Math.PI * 2;

/** Frame-rate independent exponential approach. `rate` is 1/e per second. */
export function damp(cur: number, target: number, rate: number, dt: number): number {
  return target + (cur - target) * Math.exp(-rate * dt);
}

/** Shortest signed angular difference, radians. */
export function angDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

export function dampAngle(cur: number, target: number, rate: number, dt: number): number {
  return target + angDelta(cur, target) * Math.exp(-rate * dt);
}

/**
 * Critically-damped second-order follower. Used where an exponential reads as
 * mush — head turns and the torso's lean both need a little overshoot-free
 * momentum, which a first-order filter cannot express.
 */
export function spring(
  cur: number, vel: number, target: number, omega: number, dt: number,
): [number, number] {
  // Semi-implicit, unconditionally stable at any dt.
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const det = 1 / (f + hhoo);
  const nx = (f * cur + dt * vel + hhoo * target) * det;
  const nv = (vel + hoo * (target - cur)) * det;
  return [nx, nv];
}

/**
 * Orthonormal frame from a bone direction and a front reference. Mirrors
 * `rig/Build.ts frameQuat` exactly — local +Y is `dir`, local +Z is `fwd`
 * orthogonalised against it — but writes into `out` instead of allocating,
 * because this runs 6+ times per player per frame.
 */
export function frameQuat(dir: THREE.Vector3, fwd: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _fa.copy(dir).normalize();
  _fb.copy(fwd).addScaledVector(_fa, -fwd.dot(_fa));
  if (_fb.lengthSq() < 1e-9) {
    _fb.set(0, 0, 1).addScaledVector(_fa, -_fa.z);
    if (_fb.lengthSq() < 1e-9) _fb.set(1, 0, 0).addScaledVector(_fa, -_fa.x);
  }
  _fb.normalize();
  _fc.crossVectors(_fa, _fb);
  return out.setFromRotationMatrix(_m.makeBasis(_fc, _fa, _fb));
}
const _m = new THREE.Matrix4();
const _fa = new THREE.Vector3();
const _fb = new THREE.Vector3();
const _fc = new THREE.Vector3();

/* ------------------------------------------------------------------ pose */

/**
 * 60 delta quaternions plus a pelvis offset. One instance per player is enough;
 * layers write into shared scratch poses and blend down into this one.
 */
export class Pose {
  readonly q = new Float32Array(NB * 4);
  /** Pelvis translation offset from bind, rig space. Bob, sway, prone drop. */
  readonly hip = new THREE.Vector3();

  constructor() { this.identity(); }

  identity(): this {
    const q = this.q;
    for (let i = 0; i < NB; i++) { const o = i * 4; q[o] = 0; q[o + 1] = 0; q[o + 2] = 0; q[o + 3] = 1; }
    this.hip.set(0, 0, 0);
    return this;
  }

  /** Bend / abduct / twist about the bone's own axes, radians. */
  setEuler(i: number, x: number, y: number, z: number): void {
    _eul.set(x, y, z, 'XZY');
    _qa.setFromEuler(_eul);
    const o = i * 4;
    this.q[o] = _qa.x; this.q[o + 1] = _qa.y; this.q[o + 2] = _qa.z; this.q[o + 3] = _qa.w;
  }

  /** Primary bend only — the common case, and it skips the Euler build. */
  setBend(i: number, x: number): void {
    const h = x * 0.5;
    const o = i * 4;
    this.q[o] = Math.sin(h); this.q[o + 1] = 0; this.q[o + 2] = 0; this.q[o + 3] = Math.cos(h);
  }

  /** Twist about the bone axis only. */
  setTwist(i: number, y: number): void {
    const h = y * 0.5;
    const o = i * 4;
    this.q[o] = 0; this.q[o + 1] = Math.sin(h); this.q[o + 2] = 0; this.q[o + 3] = Math.cos(h);
  }

  setQuat(i: number, q: THREE.Quaternion): void {
    const o = i * 4;
    this.q[o] = q.x; this.q[o + 1] = q.y; this.q[o + 2] = q.z; this.q[o + 3] = q.w;
  }

  getQuat(i: number, out: THREE.Quaternion): THREE.Quaternion {
    const o = i * 4;
    return out.set(this.q[o], this.q[o + 1], this.q[o + 2], this.q[o + 3]);
  }

  copyFrom(src: Pose): void {
    this.q.set(src.q);
    this.hip.copy(src.hip);
  }

  /** Blend a whole pose in. `w` 0 keeps this, 1 takes `src`. */
  blend(src: Pose, w: number): void {
    if (w <= 0) return;
    if (w >= 1) { this.copyFrom(src); return; }
    for (let i = 0; i < NB; i++) {
      slerpFlat(this.q, i * 4, this.q, i * 4, src.q, i * 4, w);
    }
    this.hip.lerp(src.hip, w);
  }

  /** Blend only the bones named by `mask`. This is the layering primitive. */
  blendMask(src: Pose, mask: ArrayLike<number>, w: number): void {
    if (w <= 0) return;
    const n = mask.length;
    if (w >= 1) {
      for (let k = 0; k < n; k++) {
        const o = mask[k] * 4;
        this.q[o] = src.q[o]; this.q[o + 1] = src.q[o + 1];
        this.q[o + 2] = src.q[o + 2]; this.q[o + 3] = src.q[o + 3];
      }
      return;
    }
    for (let k = 0; k < n; k++) {
      const o = mask[k] * 4;
      slerpFlat(this.q, o, this.q, o, src.q, o, w);
    }
  }

  /** Post-multiply an additive delta onto one bone — breathing, flinches. */
  addEuler(i: number, x: number, y: number, z: number, w = 1): void {
    if (w === 0) return;
    _eul.set(x * w, y * w, z * w, 'XZY');
    _qa.setFromEuler(_eul);
    this.getQuat(i, _qb).multiply(_qa);
    this.setQuat(i, _qb);
  }
}

/* ------------------------------------------------------------------ kine */

const bonesOf = (b: NamedBones, n: BoneName): THREE.Bone => b[n];

/**
 * Per-rig immutable data plus the FK scratch that the solvers read. One per
 * athlete; built once at `attach`, never reallocated.
 */
export class Kine {
  readonly parent = new Int32Array(NB);
  readonly bindQ = new Float32Array(NB * 4);
  readonly bindP = new Float32Array(NB * 3);
  readonly invBindQ = new Float32Array(NB * 4);
  /** Rig-space transform of every bone, refreshed by `fk()`. */
  readonly wq = new Float32Array(NB * 4);
  readonly wp = new Float32Array(NB * 3);

  readonly bones: THREE.Bone[] = [];
  readonly measure: Measure;

  /** Bind limb lengths, metres. */
  thigh = 0; shin = 0; upperArm = 0; foreArm = 0;
  /** Ankle joint height above the sole at bind. */
  ankleY = 0;
  /** Ball and toe-tip offsets from the ankle, in the FOOT's rest frame. */
  footBallZ = 0; footBallY = 0; footToeZ = 0; footToeY = 0; footHeelZ = 0;
  height = 1.83;

  constructor(named: NamedBones, measure: Measure) {
    this.measure = measure;
    const index = new Map<THREE.Bone, number>();
    for (let i = 0; i < NB; i++) {
      const b = bonesOf(named, BONE_NAMES[i]);
      this.bones.push(b);
      index.set(b, i);
    }
    for (let i = 0; i < NB; i++) {
      const b = this.bones[i];
      const p = b.parent as THREE.Bone | null;
      this.parent[i] = p && index.has(p) ? index.get(p)! : -1;
      const o4 = i * 4, o3 = i * 3;
      this.bindQ[o4] = b.quaternion.x; this.bindQ[o4 + 1] = b.quaternion.y;
      this.bindQ[o4 + 2] = b.quaternion.z; this.bindQ[o4 + 3] = b.quaternion.w;
      this.invBindQ[o4] = -b.quaternion.x; this.invBindQ[o4 + 1] = -b.quaternion.y;
      this.invBindQ[o4 + 2] = -b.quaternion.z; this.invBindQ[o4 + 3] = b.quaternion.w;
      this.bindP[o3] = b.position.x; this.bindP[o3 + 1] = b.position.y; this.bindP[o3 + 2] = b.position.z;
      // Bones must never carry the Euler mirror: we only ever write quaternions,
      // and keeping `rotation` in sync is an asin plus two atan2 per bone per
      // frame — 840 of them across a 14-player roster, for nobody.
      (b.quaternion as unknown as { _onChange(cb: () => void): void })._onChange(NOOP);
    }

    this.thigh = measure.thigh;
    this.shin = measure.shin;
    this.upperArm = measure.upperArm;
    this.foreArm = measure.foreArm;
    this.ankleY = measure.ankleY;
    this.height = measure.height;

    // Foot geometry, read off the bind skeleton rather than re-derived: the
    // ankle→ball vector IS the foot bone, and the toe bone's length is the
    // forefoot. Both are needed to roll the foot about a contact point.
    const ank = measure.bind.foot_L, ball = measure.bind.toe_L;
    this.footBallZ = Math.abs(ball.z - ank.z);
    this.footBallY = ball.y - ank.y;
    this.footToeZ = this.footBallZ + measure.height * 0.050;
    this.footToeY = this.footBallY - measure.height * 0.008;
    this.footHeelZ = measure.height * 0.030;
  }

  /* ---------------------------------------------------------------- FK */

  /** Rebuild rig-space transforms for every bone from `pose`. */
  fk(pose: Pose): void {
    const { parent, bindQ, bindP, wq, wp } = this;
    const pq = pose.q;
    for (let i = 0; i < NB; i++) {
      const o4 = i * 4, o3 = i * 3;
      // local = bind * delta
      multiplyQuaternionsFlat(_lq, 0, bindQ, o4, pq, o4);
      let lx = bindP[o3], ly = bindP[o3 + 1], lz = bindP[o3 + 2];
      if (i === B.pelvis) { lx += pose.hip.x; ly += pose.hip.y; lz += pose.hip.z; }
      const par = parent[i];
      if (par < 0) {
        wq[o4] = _lq[0]; wq[o4 + 1] = _lq[1]; wq[o4 + 2] = _lq[2]; wq[o4 + 3] = _lq[3];
        wp[o3] = lx; wp[o3 + 1] = ly; wp[o3 + 2] = lz;
        continue;
      }
      const p4 = par * 4, p3 = par * 3;
      multiplyQuaternionsFlat(wq, o4, wq, p4, _lq, 0);
      // rotate (lx,ly,lz) by parent world quat
      const qx = wq[p4], qy = wq[p4 + 1], qz = wq[p4 + 2], qw = wq[p4 + 3];
      const ix = qw * lx + qy * lz - qz * ly;
      const iy = qw * ly + qz * lx - qx * lz;
      const iz = qw * lz + qx * ly - qy * lx;
      const iw = -qx * lx - qy * ly - qz * lz;
      wp[o3] = wp[p3] + ix * qw + iw * -qx + iy * -qz - iz * -qy;
      wp[o3 + 1] = wp[p3 + 1] + iy * qw + iw * -qy + iz * -qx - ix * -qz;
      wp[o3 + 2] = wp[p3 + 2] + iz * qw + iw * -qz + ix * -qy - iy * -qx;
    }
  }

  /** FK for the spine chain only — enough to place the shoulders and hips. */
  fkUpTo(pose: Pose, last: number): void {
    const { parent, bindQ, bindP, wq, wp } = this;
    const pq = pose.q;
    for (let i = 0; i <= last; i++) {
      const o4 = i * 4, o3 = i * 3;
      multiplyQuaternionsFlat(_lq, 0, bindQ, o4, pq, o4);
      let lx = bindP[o3], ly = bindP[o3 + 1], lz = bindP[o3 + 2];
      if (i === B.pelvis) { lx += pose.hip.x; ly += pose.hip.y; lz += pose.hip.z; }
      const par = parent[i];
      if (par < 0) {
        wq[o4] = _lq[0]; wq[o4 + 1] = _lq[1]; wq[o4 + 2] = _lq[2]; wq[o4 + 3] = _lq[3];
        wp[o3] = lx; wp[o3 + 1] = ly; wp[o3 + 2] = lz;
        continue;
      }
      const p4 = par * 4, p3 = par * 3;
      multiplyQuaternionsFlat(wq, o4, wq, p4, _lq, 0);
      _va.set(lx, ly, lz).applyQuaternion(_qa.set(wq[p4], wq[p4 + 1], wq[p4 + 2], wq[p4 + 3]));
      wp[o3] = wp[p3] + _va.x; wp[o3 + 1] = wp[p3 + 1] + _va.y; wp[o3 + 2] = wp[p3 + 2] + _va.z;
    }
  }

  worldPos(i: number, out: THREE.Vector3): THREE.Vector3 {
    const o = i * 3;
    return out.set(this.wp[o], this.wp[o + 1], this.wp[o + 2]);
  }

  worldQuat(i: number, out: THREE.Quaternion): THREE.Quaternion {
    const o = i * 4;
    return out.set(this.wq[o], this.wq[o + 1], this.wq[o + 2], this.wq[o + 3]);
  }

  /**
   * Write a rig-space orientation onto a bone as a bind-relative delta, given
   * that its parent's rig-space orientation in `wq` is already correct. This is
   * the bridge every IK solver crosses on the way out.
   */
  setWorldQuat(pose: Pose, i: number, world: THREE.Quaternion): void {
    const par = this.parent[i];
    if (par >= 0) {
      _qa.set(this.wq[par * 4], this.wq[par * 4 + 1], this.wq[par * 4 + 2], this.wq[par * 4 + 3]).invert();
      _qb.copy(_qa).multiply(world);
    } else {
      _qb.copy(world);
    }
    const o = i * 4;
    _qa.set(this.invBindQ[o], this.invBindQ[o + 1], this.invBindQ[o + 2], this.invBindQ[o + 3]);
    _qb.premultiply(_qa);
    pose.setQuat(i, _qb);
    // Keep the FK cache coherent so a child solved next step sees the truth.
    this.wq[o] = world.x; this.wq[o + 1] = world.y; this.wq[o + 2] = world.z; this.wq[o + 3] = world.w;
  }

  /**
   * Recompute one bone's cached rig-space transform after its delta changed.
   * Needed whenever an FK layer writes a bone that a later IK pass reads
   * through — a shoulder shrug moves the elbow, and the catch solver has to
   * see that.
   */
  refresh(pose: Pose, i: number): void {
    const o4 = i * 4;
    multiplyQuaternionsFlat(_lq, 0, this.bindQ, o4, pose.q, o4);
    const par = this.parent[i];
    if (par < 0) {
      this.wq[o4] = _lq[0]; this.wq[o4 + 1] = _lq[1];
      this.wq[o4 + 2] = _lq[2]; this.wq[o4 + 3] = _lq[3];
    } else {
      multiplyQuaternionsFlat(this.wq, o4, this.wq, par * 4, _lq, 0);
    }
    this.refreshPos(i);
  }

  /** Refresh one bone's cached rig-space position from its parent. */
  refreshPos(i: number): void {
    const par = this.parent[i];
    const o3 = i * 3;
    if (par < 0) { this.wp[o3] = this.bindP[o3]; this.wp[o3 + 1] = this.bindP[o3 + 1]; this.wp[o3 + 2] = this.bindP[o3 + 2]; return; }
    const p4 = par * 4, p3 = par * 3;
    _va.set(this.bindP[o3], this.bindP[o3 + 1], this.bindP[o3 + 2])
      .applyQuaternion(_qa.set(this.wq[p4], this.wq[p4 + 1], this.wq[p4 + 2], this.wq[p4 + 3]));
    this.wp[o3] = this.wp[p3] + _va.x;
    this.wp[o3 + 1] = this.wp[p3 + 1] + _va.y;
    this.wp[o3 + 2] = this.wp[p3 + 2] + _va.z;
  }

  /** Commit a pose to the actual THREE bones. The only place we touch them. */
  commit(pose: Pose): void {
    const { bones, bindQ, bindP } = this;
    const pq = pose.q;
    for (let i = 0; i < NB; i++) {
      const o = i * 4;
      multiplyQuaternionsFlat(_lq, 0, bindQ, o, pq, o);
      const q = bones[i].quaternion;
      q.set(_lq[0], _lq[1], _lq[2], _lq[3]);
    }
    const o3 = B.pelvis * 3;
    bones[B.pelvis].position.set(
      bindP[o3] + pose.hip.x, bindP[o3 + 1] + pose.hip.y, bindP[o3 + 2] + pose.hip.z,
    );
  }
}

const NOOP = (): void => {};
const _lq = new Float32Array(4);

/* -------------------------------------------------------------------- IK */

export interface TwoBoneResult {
  /** Rig-space position of the middle joint (knee / elbow). */
  mid: THREE.Vector3;
  /** How far the target overran the chain's reach, metres. 0 when reachable. */
  overrun: number;
}

const _mid = new THREE.Vector3();
const _res: TwoBoneResult = { mid: _mid, overrun: 0 };
const _ta = new THREE.Vector3();
const _tb = new THREE.Vector3();
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _sd = new THREE.Vector3();
const _sq = new THREE.Quaternion();

/**
 * Analytic two-bone solve. `pole` is a direction, not a point: the middle joint
 * is pushed toward it in the plane perpendicular to root→target. Returns the
 * middle joint position and the reach deficit, which the caller uses to drop
 * the hips rather than let the limb stretch.
 */
export function twoBone(
  root: THREE.Vector3, target: THREE.Vector3, pole: THREE.Vector3,
  l1: number, l2: number,
): TwoBoneResult {
  _ta.subVectors(target, root);
  const raw = _ta.length();
  const min = Math.abs(l1 - l2) + 1e-4;
  const max = l1 + l2 - 1e-4;
  const d = clamp(raw, min, max);
  _res.overrun = Math.max(0, raw - max);
  if (raw < 1e-6) { _ta.set(0, -1, 0); } else { _ta.multiplyScalar(1 / raw); }

  // Angle at the root between the chain axis and the first bone.
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const a = Math.acos(cosA);

  _tb.copy(pole).addScaledVector(_ta, -pole.dot(_ta));
  if (_tb.lengthSq() < 1e-8) {
    _tb.set(0, 0, 1).addScaledVector(_ta, -_ta.z);
    if (_tb.lengthSq() < 1e-8) _tb.set(1, 0, 0).addScaledVector(_ta, -_ta.x);
  }
  _tb.normalize();

  _mid.copy(root)
    .addScaledVector(_ta, l1 * Math.cos(a))
    .addScaledVector(_tb, l1 * Math.sin(a));
  return _res;
}

/**
 * Solve a hip→knee→ankle (or shoulder→elbow→wrist) chain and write both bone
 * orientations. `front` is the anatomical-front reference the rig was bound
 * with, so the twist that comes out matches the bind frame rather than
 * whatever the plane happened to be.
 */
export function solveLimb(
  kine: Kine, pose: Pose,
  rootBone: number, midBone: number, endBone: number,
  target: THREE.Vector3, pole: THREE.Vector3,
  l1: number, l2: number,
): number {
  kine.worldPos(rootBone, _sc);
  const r = twoBone(_sc, target, pole, l1, l2);
  _sd.copy(r.mid);

  // Upper bone: +Y toward the mid joint, +Z toward the pole (the joint's front).
  _sa.subVectors(_sd, _sc);
  frameQuat(_sa, pole, _sq);
  kine.setWorldQuat(pose, rootBone, _sq);
  kine.refreshPos(midBone);

  // Lower bone: +Y toward the target, front reference carried from the upper
  // bone so the knee cannot flip its roll when the chain passes through
  // straight — the classic IK pop.
  kine.worldPos(midBone, _sc);
  _sa.subVectors(target, _sc);
  _sb.set(0, 0, 1).applyQuaternion(_sq);
  frameQuat(_sa, _sb, _sq);
  kine.setWorldQuat(pose, midBone, _sq);
  kine.refreshPos(endBone);
  return r.overrun;
}

/* ------------------------------------------------------------------ misc */

/** World ↔ rig-space conversion. Rig space is a yaw plus a translation. */
export class Frame {
  x = 0; y = 0; z = 0; yaw = 0;
  private s = 0; private c = 1;

  set(x: number, y: number, z: number, yaw: number): this {
    this.x = x; this.y = y; this.z = z; this.yaw = yaw;
    this.s = Math.sin(yaw); this.c = Math.cos(yaw);
    return this;
  }

  toLocal(wx: number, wy: number, wz: number, out: THREE.Vector3): THREE.Vector3 {
    const dx = wx - this.x, dz = wz - this.z;
    // Inverse of a +Y rotation by yaw.
    return out.set(dx * this.c - dz * this.s, wy - this.y, dx * this.s + dz * this.c);
  }

  toWorld(lx: number, ly: number, lz: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(
      this.x + lx * this.c + lz * this.s,
      this.y + ly,
      this.z - lx * this.s + lz * this.c,
    );
  }

  /** Rotate a direction into rig space (no translation). */
  dirToLocal(wx: number, wz: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(wx * this.c - wz * this.s, 0, wx * this.s + wz * this.c);
  }

  /** Rotate a rig-space direction out to world (no translation). */
  dirToWorld(lx: number, ly: number, lz: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(lx * this.c + lz * this.s, ly, -lx * this.s + lz * this.c);
  }
}

export { _qa as QA, _qb as QB, _va as VA, _vb as VB };
