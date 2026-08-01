/**
 * What the broadcast director is allowed to know about the match.
 *
 * The camera never imports the simulation. It reads one flat struct per frame,
 * built by `Director.readWorld()` off `ctx.sys.game` and degrading to `null`
 * when there is no game system at all. Everything downstream — the tele rig, the
 * cut library, the framing assertions in `tools/test-camera.ts` — consumes only
 * this, which is what lets the headless test drive scripted phases and disc
 * states through the exact code the browser runs.
 */

import * as THREE from 'three';

export type CamPhase =
  | 'PRE_PULL' | 'PULL_IN_FLIGHT' | 'LIVE_POSSESSION' | 'DISC_IN_FLIGHT'
  | 'TURNOVER_DEAD' | 'CHECK' | 'POINT_SCORED' | 'TIMEOUT' | 'HALFTIME' | 'GAME_OVER';

/**
 * The three phases in which the disc is live. THE HARD RULE OF THIS MODULE:
 * no cut may happen inside one of these (the pull-aerial handoff is the single
 * scripted exception, and it is legal because the pull is uncontested by rule).
 */
export function isLivePhase(p: CamPhase): boolean {
  return p === 'LIVE_POSSESSION' || p === 'DISC_IN_FLIGHT' || p === 'PULL_IN_FLIGHT';
}

export interface CamPlayer {
  id: number;
  team: 0 | 1;
  x: number;
  y: number;
  z: number;
}

export interface PathPoint { t: number; x: number; y: number; z: number }

export interface WorldView {
  phase: CamPhase;
  /** Seconds in the current phase. */
  phaseTimer: number;
  /** True on the frame the phase changed. */
  phaseChanged: boolean;

  /** Team in possession, or the receiving team before the pull is taken. */
  offence: 0 | 1;
  /** Attacking direction of `offence`. */
  attackDir: 1 | -1;
  /** Attacking direction of the pulling team — the way the pull travels. */
  pullDir: 1 | -1;

  disc: { x: number; y: number; z: number };
  /** True while the disc is airborne (physics owns it). */
  discFlight: boolean;

  throwerId: number;
  markerId: number;
  /** Receiver the thrower has selected, or -1. */
  receiverId: number;
  /** Who scored the most recent goal, or -1. */
  scorerId: number;

  players: readonly CamPlayer[];

  /**
   * Remaining flight, integrated by the real disc physics, `t` seconds from
   * now. Called at 10 Hz by the tele rig and never during a dead phase.
   */
  predict(): readonly PathPoint[];
}

/* -------------------------------------------------------------------- math */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wrap to (-pi, pi]. */
export function wrapPi(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}

/** Move `cur` toward `to` by at most `step`. */
export function approach(cur: number, to: number, step: number): number {
  const d = to - cur;
  if (d > step) return cur + step;
  if (d < -step) return cur - step;
  return to;
}

/** Move an angle toward another by at most `step`, over the short arc. */
export function approachAngle(cur: number, to: number, step: number): number {
  const d = wrapPi(to - cur);
  if (d > step) return cur + step;
  if (d < -step) return cur - step;
  return cur + d;
}

/**
 * One axis of a critically damped spring, in the implicit form — unconditionally
 * stable at any dt, which matters because `lateUpdate` runs on the wall-clock
 * frame delta rather than the fixed sim step.
 */
export interface Spring1 { x: number; v: number }

export function spring1(s: Spring1, target: number, omega: number, dt: number): number {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const det = 1 / (f + hhoo);
  const x = (f * s.x + dt * s.v + hhoo * target) * det;
  const v = (s.v + hoo * (target - s.x)) * det;
  s.x = x; s.v = v;
  return x;
}

/** Three independent critically damped springs — the aim point. */
export class SpringVec3 {
  readonly value = new THREE.Vector3();
  private readonly sx: Spring1 = { x: 0, v: 0 };
  private readonly sy: Spring1 = { x: 0, v: 0 };
  private readonly sz: Spring1 = { x: 0, v: 0 };

  set(x: number, y: number, z: number): void {
    this.sx.x = x; this.sy.x = y; this.sz.x = z;
    this.sx.v = 0; this.sy.v = 0; this.sz.v = 0;
    this.value.set(x, y, z);
  }

  step(target: THREE.Vector3, omega: number, dt: number): THREE.Vector3 {
    this.value.set(
      spring1(this.sx, target.x, omega, dt),
      spring1(this.sy, target.y, omega, dt),
      spring1(this.sz, target.z, omega, dt),
    );
    return this.value;
  }
}

/**
 * Time-optimal approach along the dolly line: run at up to `vMax`, braking in
 * time to arrive without overshoot under an acceleration limit of `aMax`.
 * Returns the new velocity; the caller integrates.
 *
 * The admissible speed is solved in DISCRETE time, not continuous. The textbook
 * `sqrt(2·a·e)` brake is only non-overshooting for a continuous integrator; at a
 * 60 Hz step it lands a centimetre or two past the mark, and when the target is
 * the hard end of the dolly track (±36 m) that overshoot is clipped by the
 * position clamp — which turns a 1.6 m/s velocity into zero inside one frame,
 * an 96 m/s² step, five times the acceleration cap and clearly visible as a jerk
 * at the end of the rails. Requiring instead that the rig can still stop from
 * `v'` AFTER moving `v'·dt` this frame,
 *
 *     v'²/(2a) ≤ e − v'·dt   ⇒   v' ≤ −a·dt + sqrt((a·dt)² + 2·a·e)
 *
 * makes the approach exactly non-overshooting, so the clamp never fires and the
 * rig settles onto the end of the track under its own braking.
 */
export function dollyVelocity(
  pos: number, target: number, vel: number, vMax: number, aMax: number, dt: number,
): number {
  const err = target - pos;
  const ah = aMax * dt;
  const admissible = -ah + Math.sqrt(ah * ah + 2 * aMax * Math.abs(err));
  const want = clamp(Math.sign(err) * Math.min(admissible, vMax), -vMax, vMax);
  return approach(vel, want, ah);
}

/* ------------------------------------------------------------------ framing */

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _rel = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** A camera basis: forward, screen-right, screen-up. Rebuilt per query. */
export class Basis {
  readonly f = new THREE.Vector3(1, 0, 0);
  readonly r = new THREE.Vector3(0, 0, 1);
  readonly u = new THREE.Vector3(0, 1, 0);
  readonly eye = new THREE.Vector3();

  set(eye: THREE.Vector3, aim: THREE.Vector3): this {
    this.eye.copy(eye);
    _fwd.copy(aim).sub(eye);
    if (_fwd.lengthSq() < 1e-8) _fwd.set(1, 0, 0);
    _fwd.normalize();
    _right.crossVectors(_fwd, WORLD_UP);
    if (_right.lengthSq() < 1e-8) _right.set(0, 0, 1);
    _right.normalize();
    _up.crossVectors(_right, _fwd).normalize();
    this.f.copy(_fwd); this.r.copy(_right); this.u.copy(_up);
    return this;
  }

  /**
   * Where a world point falls in the frame, as tangents of the horizontal and
   * vertical angles off the view axis. NDC = tan / tan(halfFov), so these are
   * exactly the quantities a field-of-view solve inverts.
   */
  tangents(x: number, y: number, z: number, out: { h: number; v: number }): boolean {
    _rel.set(x - this.eye.x, y - this.eye.y, z - this.eye.z);
    const d = _rel.dot(this.f);
    if (d < 0.25) return false;              // behind the lens, or on it
    out.h = _rel.dot(this.r) / d;
    out.v = _rel.dot(this.u) / d;
    return true;
  }
}

/**
 * Vertical FOV (degrees) that puts a horizontal tangent at exactly `frac` of
 * half the frame width. `aspect` is width/height; three's `fov` is vertical.
 */
export function fovForWidth(tanH: number, frac: number, aspect: number): number {
  if (!(tanH > 0)) return 0;
  return 2 * Math.atan(tanH / Math.max(0.05, frac * aspect)) * 180 / Math.PI;
}

/** Vertical FOV (degrees) that puts a vertical tangent at `frac` of half height. */
export function fovForHeight(tanV: number, frac: number): number {
  if (!(tanV > 0)) return 0;
  return 2 * Math.atan(tanV / Math.max(0.05, frac)) * 180 / Math.PI;
}

const DEG = Math.PI / 180;
export { DEG };
