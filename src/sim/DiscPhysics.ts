/**
 * DiscPhysics — 6-DOF flight dynamics for a 175 g Ultimate disc.
 *
 * The whole point of this module is that nothing about a flight path is
 * scripted.  We integrate a rigid body with a real inertia tensor under real
 * aerodynamic forces and moments, and the shapes fall out:
 *
 *  - A disc is a gyroscope.  Torque does not tilt it, it PRECESSES it 90
 *    degrees out of phase.  Euler's equations give that for free, so we never
 *    write "precession" anywhere in the code; we just refuse to cheat by
 *    integrating the orientation properly.
 *  - The pitching moment CM = CM0 + CMa*alpha changes sign around alpha ~ 7.6
 *    degrees.  A fast disc flies at low alpha (nose-down moment -> precesses
 *    into a turn one way); a slow disc has to mush at high alpha to hold
 *    itself up (nose-up moment -> precesses the other way).  That is the
 *    "turn then fade" every player knows, and it sharpens as the spin decays
 *    because precession rate goes as 1/spin.
 *  - Flip the spin sign and you get a forehand, which curves the other way.
 *    Flip the disc over and you get a hammer, whose lift now points at the
 *    ground.
 *
 * Frames and sign conventions are documented in ./aero/Coeffs.ts. Short
 * version: body +Z is the disc normal, orientation is a body->world
 * quaternion, angular velocity is stored in the BODY frame.
 *
 * Determinism: pure arithmetic, no Math.random, no time source. Driven at a
 * fixed 1/120 s step by the engine; simulate() sub-steps internally if handed
 * anything larger so behaviour never depends on frame rate.
 */

import * as THREE from 'three';
import {
  AERO, DISC, dragCoeff, liftCoeff, pitchCoeff,
  type AeroCoeffs, type DiscBody,
} from './aero/Coeffs.ts';
import {
  THROW_SPECS, throwSpeed, throwSpinRate,
  type ThrowType,
} from './aero/Throws.ts';

export { AERO, DISC, liftCoeff, dragCoeff, pitchCoeff, stallBlend } from './aero/Coeffs.ts';
export type { AeroCoeffs, DiscBody } from './aero/Coeffs.ts';
export {
  THROW_SPECS, THROW_TYPES, throwSpeed, powerForSpeed, throwSpinRate,
} from './aero/Throws.ts';
export type { ThrowType, ThrowSpec } from './aero/Throws.ts';

/** Fixed simulation step the engine drives us at. */
export const FIXED_DT = 1 / 120;

/* ---------------------------------------------------------------- the state */

export interface DiscState {
  /** World position of the disc centre of mass, metres. */
  pos: THREE.Vector3;
  /** World velocity, m/s. */
  vel: THREE.Vector3;
  /** Body -> world rotation. Body +Z is the disc normal. */
  orient: THREE.Quaternion;
  /** Angular velocity in the BODY frame, rad/s. omega.z is the spin. */
  omega: THREE.Vector3;

  /** Height of the ground plane under the disc, metres. */
  groundY: number;
  /** True from the first frame the disc touches the ground. */
  touchedGround: boolean;
  /** True once it has stopped sliding. */
  atRest: boolean;
  /** Seconds since release. */
  t: number;

  /* --- derived, refreshed by simulate(); read-only for consumers --- */
  /** Signed spin rate about the disc normal, rad/s. Negative = clockwise seen from above. */
  spin: number;
  /** Angle of attack, rad. */
  alpha: number;
  /** Speed relative to the air, m/s. */
  airspeed: number;

  /** Purely informational. */
  throwType: ThrowType | 'raw';
  /** +1 right handed, -1 left handed. */
  handed: 1 | -1;
}

const ZERO_WIND = new THREE.Vector3(0, 0, 0);

export function createDiscState(): DiscState {
  return {
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    orient: new THREE.Quaternion(),
    omega: new THREE.Vector3(),
    groundY: 0,
    touchedGround: false,
    atRest: false,
    t: 0,
    spin: 0,
    alpha: 0,
    airspeed: 0,
    throwType: 'raw',
    handed: 1,
  };
}

/** Zero an existing state in place. */
export function resetDiscState(s: DiscState): DiscState {
  s.pos.set(0, 0, 0);
  s.vel.set(0, 0, 0);
  s.orient.set(0, 0, 0, 1);
  s.omega.set(0, 0, 0);
  s.groundY = 0;
  s.touchedGround = false;
  s.atRest = false;
  s.t = 0;
  s.spin = 0;
  s.alpha = 0;
  s.airspeed = 0;
  s.throwType = 'raw';
  s.handed = 1;
  return s;
}

export function cloneDiscState(s: DiscState, out?: DiscState): DiscState {
  const d = out ?? createDiscState();
  d.pos.copy(s.pos);
  d.vel.copy(s.vel);
  d.orient.copy(s.orient);
  d.omega.copy(s.omega);
  d.groundY = s.groundY;
  d.touchedGround = s.touchedGround;
  d.atRest = s.atRest;
  d.t = s.t;
  d.spin = s.spin;
  d.alpha = s.alpha;
  d.airspeed = s.airspeed;
  d.throwType = s.throwType;
  d.handed = s.handed;
  return d;
}

/* -------------------------------------------------------------- scratch pad */
/* Every vector below is module scope so the hot path allocates nothing. */

const _q = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _n = new THREE.Vector3();
const _bx = new THREE.Vector3();
const _vrel = new THREE.Vector3();
const _u = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _xa = new THREE.Vector3();
const _ya = new THREE.Vector3();
const _ld = new THREE.Vector3();
const _wW = new THREE.Vector3();
const _mB = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _mat = new THREE.Matrix4();

/* State packed as a flat 13-vector for the integrator:
 * 0..2 pos, 3..5 vel, 6..9 quat(x,y,z,w), 10..12 omega(body). */
const N = 13;
const _y = new Float64Array(N);
const _yt = new Float64Array(N);
const _k1 = new Float64Array(N);
const _k2 = new Float64Array(N);
const _k3 = new Float64Array(N);
const _k4 = new Float64Array(N);

function packState(s: DiscState, y: Float64Array): void {
  y[0] = s.pos.x; y[1] = s.pos.y; y[2] = s.pos.z;
  y[3] = s.vel.x; y[4] = s.vel.y; y[5] = s.vel.z;
  y[6] = s.orient.x; y[7] = s.orient.y; y[8] = s.orient.z; y[9] = s.orient.w;
  y[10] = s.omega.x; y[11] = s.omega.y; y[12] = s.omega.z;
}

function unpackState(y: Float64Array, s: DiscState): void {
  s.pos.set(y[0], y[1], y[2]);
  s.vel.set(y[3], y[4], y[5]);
  s.orient.set(y[6], y[7], y[8], y[9]);
  s.omega.set(y[10], y[11], y[12]);
}

function normQuat(y: Float64Array): void {
  const m = Math.hypot(y[6], y[7], y[8], y[9]);
  if (m > 1e-12) {
    const k = 1 / m;
    y[6] *= k; y[7] *= k; y[8] *= k; y[9] *= k;
  } else {
    y[6] = 0; y[7] = 0; y[8] = 0; y[9] = 1;
  }
}

/* ---------------------------------------------------------- the derivative */

/** Instantaneous aerodynamic breakdown, for tests, the HUD and debug draws. */
export interface AeroProbe {
  alpha: number;
  airspeed: number;
  CL: number;
  CD: number;
  CM: number;
  CR: number;
  /** Newtons. */
  lift: number;
  drag: number;
  /** Newton-metres, signed about the aero pitch axis. */
  pitchMoment: number;
  rollMoment: number;
  /** rad/s, signed about the disc normal. */
  spin: number;
  /** World-space disc normal. */
  normal: THREE.Vector3;
  /** Precession rate of the disc normal implied by the current moments, rad/s. */
  precession: number;
}

const _probe: AeroProbe = {
  alpha: 0, airspeed: 0, CL: 0, CD: 0, CM: 0, CR: 0,
  lift: 0, drag: 0, pitchMoment: 0, rollMoment: 0, spin: 0,
  normal: new THREE.Vector3(), precession: 0,
};

/**
 * Fill `out` with d/dt of the packed state `y`.
 *
 * `probe` is optional and, when supplied, receives the aerodynamic breakdown
 * of this evaluation. Nothing else in here allocates.
 */
function deriv(
  y: Float64Array, wind: THREE.Vector3, out: Float64Array,
  c: AeroCoeffs, b: DiscBody, probe: AeroProbe | null,
): void {
  _q.set(y[6], y[7], y[8], y[9]);

  // Disc normal and an arbitrary in-plane axis, both in world space.
  _n.set(0, 0, 1).applyQuaternion(_q);
  _bx.set(1, 0, 0).applyQuaternion(_q);

  _vrel.set(y[3] - wind.x, y[4] - wind.y, y[5] - wind.z);
  const V = _vrel.length();

  // Gravity is the only force we always have.
  let fx = 0, fy = -b.mass * c.g, fz = 0;
  let tx = 0, ty = 0, tz = 0;

  let alpha = 0, CL = 0, CD = 0, CM = 0, CR = 0, lift = 0, drag = 0;
  let pitchM = 0, rollM = 0;

  // Angular velocity in world space (needed for the rate-damping terms).
  _wW.set(y[10], y[11], y[12]).applyQuaternion(_q);
  const spin = _wW.dot(_n);

  if (V > 1e-5) {
    _u.copy(_vrel).multiplyScalar(1 / V);

    const vn = _vrel.dot(_n);
    _vp.copy(_vrel).addScaledVector(_n, -vn);
    const vpm = _vp.length();

    // Angle of attack: angle between the relative wind and the disc plane.
    alpha = Math.atan2(-vn, vpm);

    // Aero frame. If the disc is flying exactly face-on the in-plane flight
    // direction is undefined; any in-plane axis works because lift is zero.
    if (vpm > 1e-6) _xa.copy(_vp).multiplyScalar(1 / vpm);
    else _xa.copy(_bx);
    _ya.crossVectors(_xa, _n);   // unit: xa and n are orthonormal

    const qdyn = 0.5 * c.rho * V * V * b.area;

    CL = liftCoeff(alpha, c);
    CD = dragCoeff(alpha, c);

    // Lift acts perpendicular to the relative wind, in the plane spanned by
    // the wind and the disc normal, towards the normal side.
    _ld.copy(_n).addScaledVector(_u, -_n.dot(_u));
    const ldm = _ld.length();
    lift = qdyn * CL;
    if (ldm > 1e-6) {
      const k = lift / ldm;
      fx += _ld.x * k; fy += _ld.y * k; fz += _ld.z * k;
    } else {
      lift = 0;   // face-on: no lift direction exists
    }

    drag = qdyn * CD;
    fx -= _u.x * drag; fy -= _u.y * drag; fz -= _u.z * drag;

    // Non-dimensional rates.
    const nd = b.diameter / (2 * V);
    const rhat = spin * nd;
    const phat = _wW.dot(_xa) * nd;
    const qhat = _wW.dot(_ya) * nd;

    CM = pitchCoeff(alpha, c) + c.CMq * qhat;
    CR = c.CRr * rhat + c.CRp * phat;
    const CN = c.CNr * rhat;

    const qd = qdyn * b.diameter;
    pitchM = qd * CM;
    rollM = qd * CR;
    const spinM = qd * CN;

    tx = _xa.x * rollM + _ya.x * pitchM + _n.x * spinM;
    ty = _xa.y * rollM + _ya.y * pitchM + _n.y * spinM;
    tz = _xa.z * rollM + _ya.z * pitchM + _n.z * spinM;
  }

  // Linear acceleration.
  const im = 1 / b.mass;
  out[0] = y[3]; out[1] = y[4]; out[2] = y[5];
  out[3] = fx * im; out[4] = fy * im; out[5] = fz * im;

  // Quaternion kinematics: qdot = 0.5 * q (x) (omega_body, 0)
  const qx = y[6], qy = y[7], qz = y[8], qw = y[9];
  const wx = y[10], wy = y[11], wz = y[12];
  out[6] = 0.5 * (qw * wx + qy * wz - qz * wy);
  out[7] = 0.5 * (qw * wy + qz * wx - qx * wz);
  out[8] = 0.5 * (qw * wz + qx * wy - qy * wx);
  out[9] = 0.5 * (-qx * wx - qy * wy - qz * wz);

  // Euler's equations in the body frame. This term is the gyroscope: it is
  // what turns a pitching moment into a roll 90 degrees later.
  _qc.copy(_q).conjugate();
  _mB.set(tx, ty, tz).applyQuaternion(_qc);
  const Ix = b.Ixx, Iz = b.Izz;
  out[10] = (_mB.x - (Iz - Ix) * wy * wz) / Ix;
  out[11] = (_mB.y - (Ix - Iz) * wz * wx) / Ix;
  out[12] = _mB.z / Iz;

  if (probe) {
    probe.alpha = alpha;
    probe.airspeed = V;
    probe.CL = CL; probe.CD = CD; probe.CM = CM; probe.CR = CR;
    probe.lift = lift; probe.drag = drag;
    probe.pitchMoment = pitchM; probe.rollMoment = rollM;
    probe.spin = spin;
    probe.normal.copy(_n);
    // |dn/dt| = |M_perp| / |Izz * spin|  -- the precession rate of the axis.
    const mperp = Math.hypot(pitchM, rollM);
    probe.precession = Math.abs(spin) > 1e-4 ? mperp / Math.abs(Iz * spin) : 0;
  }
}

/* ---------------------------------------------------------------- integrate */

function rk4(y: Float64Array, dt: number, wind: THREE.Vector3, c: AeroCoeffs, b: DiscBody): void {
  deriv(y, wind, _k1, c, b, null);

  for (let i = 0; i < N; i++) _yt[i] = y[i] + 0.5 * dt * _k1[i];
  normQuat(_yt);
  deriv(_yt, wind, _k2, c, b, null);

  for (let i = 0; i < N; i++) _yt[i] = y[i] + 0.5 * dt * _k2[i];
  normQuat(_yt);
  deriv(_yt, wind, _k3, c, b, null);

  for (let i = 0; i < N; i++) _yt[i] = y[i] + dt * _k3[i];
  normQuat(_yt);
  deriv(_yt, wind, _k4, c, b, null);

  const s = dt / 6;
  for (let i = 0; i < N; i++) {
    y[i] += s * (_k1[i] + 2 * _k2[i] + 2 * _k3[i] + _k4[i]);
  }
  normQuat(y);
}

/** Horizontal slide friction once the disc is down, 1/s. */
const GROUND_DRAG = 3.2;
/** Spin bleed once the disc is down, 1/s. */
const GROUND_SPIN_DRAG = 2.6;
/** Below this horizontal speed a grounded disc is considered at rest, m/s. */
const REST_SPEED = 0.25;
/** How fast a grounded disc levels out, 1/s. */
const GROUND_LEVEL_RATE = 14;

const _flatQ = new THREE.Quaternion();
const _identQ = new THREE.Quaternion();
const _upAxis = new THREE.Vector3(0, 1, 0);

/** Resolve ground contact: no meaningful bounce, a short skid, then rest. */
function resolveGround(s: DiscState, dt: number): void {
  const floor = s.groundY + DISC.halfHeight;
  if (s.pos.y > floor) return;

  s.touchedGround = true;
  s.pos.y = floor;
  if (s.vel.y < 0) s.vel.y = 0;

  const k = Math.exp(-GROUND_DRAG * dt);
  s.vel.x *= k;
  s.vel.z *= k;

  const ks = Math.exp(-GROUND_SPIN_DRAG * dt);
  s.omega.multiplyScalar(ks);

  // Settle flat over ~0.1 s, keeping whichever face is currently down.
  _n.set(0, 0, 1).applyQuaternion(s.orient);
  _flatQ.setFromUnitVectors(_n, _n.y >= 0 ? _upAxis : _tmp.set(0, -1, 0));
  _flatQ.slerp(_identQ, Math.exp(-GROUND_LEVEL_RATE * dt));
  s.orient.premultiply(_flatQ).normalize();

  if (Math.hypot(s.vel.x, s.vel.z) < REST_SPEED) {
    s.vel.set(0, 0, 0);
    s.omega.set(0, 0, 0);
    s.atRest = true;
  }
}

function refreshDerived(s: DiscState, wind: THREE.Vector3): void {
  _q.copy(s.orient);
  _n.set(0, 0, 1).applyQuaternion(_q);
  _wW.copy(s.omega).applyQuaternion(_q);
  s.spin = _wW.dot(_n);

  _vrel.copy(s.vel).sub(wind);
  const V = _vrel.length();
  s.airspeed = V;
  if (V > 1e-5) {
    const vn = _vrel.dot(_n);
    _vp.copy(_vrel).addScaledVector(_n, -vn);
    s.alpha = Math.atan2(-vn, _vp.length());
  } else {
    s.alpha = 0;
  }
}

/**
 * Advance one simulation step.
 *
 * Designed for dt = 1/120. Larger dt is sub-stepped at 1/120 internally so the
 * result never depends on frame rate; smaller dt is taken as-is.
 */
export function simulate(state: DiscState, dt: number, wind: THREE.Vector3 = ZERO_WIND): void {
  if (!(dt > 0)) return;
  if (state.atRest) { state.t += dt; return; }

  const c = AERO, b = DISC;
  let remaining = dt;
  let guard = 0;
  while (remaining > 1e-9 && guard++ < 4096) {
    const h = remaining > FIXED_DT ? FIXED_DT : remaining;
    remaining -= h;

    packState(state, _y);
    rk4(_y, h, wind, c, b);
    unpackState(_y, state);
    state.t += h;

    resolveGround(state, h);
    if (state.atRest) break;
  }

  refreshDerived(state, wind);
}

/* ------------------------------------------------------------------- throws */

export interface ThrowOptions {
  /** 'R' (default) or 'L'. Mirrors spin sign and bank. */
  hand?: 'R' | 'L';
  /** Extra bank about the flight axis, rad. Positive banks to the thrower's right.
   *  This is how you make an inside-out or outside-in throw. */
  bank?: number;
  /** Extra nose angle relative to the velocity, rad. Positive is nose up. */
  nose?: number;
  /** Ground height under the throw. */
  groundY?: number;
  /**
   * Absolute release speed in m/s, overriding the `power` lerp across the
   * throw's own speed range.
   *
   * This exists for the pull and should stay that way. A pull is the one throw
   * in the sport taken with a run-up and a full body rotation instead of from
   * a standing pivot with a mark in your face, and it is genuinely faster than
   * anything in the throw table: the backhand spec tops out at 27 m/s, and a
   * pull that actually reaches the far endzone needs about 32. Widening the
   * backhand's range instead would hand that speed to every throw in a
   * possession, which is not the same claim.
   */
  speed?: number;
  /** Reuse an existing state object instead of allocating. */
  out?: DiscState;
}

const _heading = new THREE.Vector3();
const _vdir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _upPerp = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _bodyX = new THREE.Vector3();
const _bodyY = new THREE.Vector3();
const _rotQ = new THREE.Quaternion();

/**
 * Build the release state for a throw.
 *
 * @param type   which throw
 * @param from   release position (world)
 * @param aim    aim direction; only the horizontal part is used for heading
 * @param power  0..1 across the throw's speed range
 * @param angle  extra launch elevation in radians, added to the throw's own
 * @param spin   0..1 across the throw's spin range
 */
export function throwDisc(
  type: ThrowType,
  from: THREE.Vector3,
  aim: THREE.Vector3,
  power: number,
  angle: number,
  spin: number,
  opts: ThrowOptions = {},
): DiscState {
  const spec = THROW_SPECS[type];
  const hand: 1 | -1 = opts.hand === 'L' ? -1 : 1;

  const s = opts.out ? resetDiscState(opts.out) : createDiscState();
  s.throwType = type;
  s.handed = hand;
  s.groundY = opts.groundY ?? 0;
  s.touchedGround = false;
  s.atRest = false;
  s.t = 0;

  // Heading: horizontal projection of the aim.
  _heading.set(aim.x, 0, aim.z);
  if (_heading.lengthSq() < 1e-10) _heading.set(0, 0, 1);
  _heading.normalize();

  const elev = spec.elevation + angle;
  _vdir.copy(_heading).multiplyScalar(Math.cos(elev));
  _vdir.y += Math.sin(elev);
  _vdir.normalize();

  // Release frame. `right` is the thrower's right when looking down the aim.
  _right.crossVectors(_heading, _upAxis).normalize();   // heading x up
  _upPerp.crossVectors(_right, _vdir).normalize();      // completes the frame

  const nose = spec.nose + (opts.nose ?? 0);
  // Bank is measured in the disc's own frame, so that positive always means
  // "the lift vector leans to the thrower's right" and therefore always curves
  // right - upside down or not. Turning the disc over would otherwise silently
  // reverse what the control means.
  const bank = (spec.bank + (opts.bank ?? 0)) * hand * (spec.invert ? -1 : 1);

  // Nose up tips the normal backwards. On a flat throw that is measured off the
  // velocity; on an overhead the wrist sets the plane against the ground.
  if (spec.planeRef === 'world') {
    _normal.copy(_upAxis).multiplyScalar(Math.cos(nose)).addScaledVector(_heading, -Math.sin(nose));
  } else {
    _normal.copy(_upPerp).multiplyScalar(Math.cos(nose)).addScaledVector(_vdir, -Math.sin(nose));
  }
  // Turning the disc over is literally that: the same plane, other face up.
  if (spec.invert) _normal.negate();
  // Bank rotates the normal about the flight axis; positive leans it right.
  _rotQ.setFromAxisAngle(_vdir, bank);
  _normal.applyQuaternion(_rotQ).normalize();

  // Body frame: +X along the in-plane flight direction, +Z the normal.
  _bodyX.copy(_vdir).addScaledVector(_normal, -_vdir.dot(_normal));
  if (_bodyX.lengthSq() < 1e-10) _bodyX.copy(_right);
  _bodyX.normalize();
  _bodyY.crossVectors(_normal, _bodyX).normalize();
  _mat.makeBasis(_bodyX, _bodyY, _normal);
  s.orient.setFromRotationMatrix(_mat).normalize();

  s.pos.copy(from);
  s.vel.copy(_vdir).multiplyScalar(opts.speed ?? throwSpeed(type, power));
  s.omega.set(0, 0, spec.spinSign * hand * throwSpinRate(type, spin));

  refreshDerived(s, ZERO_WIND);
  return s;
}

/* ------------------------------------------------------------- predictions */

const _predState = createDiscState();

/**
 * Sample the future flight path. Does not mutate `state`.
 *
 * Integrates at the same fixed 1/120 step the engine uses, so the prediction
 * and the real flight agree exactly for identical wind.
 *
 * @param sampleHz how many points per second to emit (default 20)
 * @param stepDt   integration step. Leave at 1/120 for a prediction that
 *                 matches the real flight exactly; a coarser step (1/40) is
 *                 several times cheaper and still within a few cm, which is
 *                 plenty when the AI is scoring a dozen candidate throws.
 */
export function predictPath(
  state: DiscState,
  wind: THREE.Vector3 = ZERO_WIND,
  seconds = 6,
  sampleHz = 20,
  out?: THREE.Vector3[],
  stepDt = FIXED_DT,
): THREE.Vector3[] {
  const path = out ?? [];
  path.length = 0;
  const p = cloneDiscState(state, _predState);
  path.push(p.pos.clone());

  const hz = 1 / stepDt;
  const stride = Math.max(1, Math.round(hz / Math.max(1, sampleHz)));
  const steps = Math.max(0, Math.round(seconds * hz));
  for (let i = 1; i <= steps; i++) {
    simulate(p, stepDt, wind);
    if (i % stride === 0) path.push(p.pos.clone());
    if (p.touchedGround) break;
  }
  const last = path[path.length - 1];
  if (last === undefined || !last.equals(p.pos)) path.push(p.pos.clone());
  return path;
}

export interface LandingPrediction {
  /** Where it first touches down. */
  pos: THREE.Vector3;
  /** Seconds from now. */
  time: number;
  /** Peak height above the release point's ground plane. */
  apex: number;
  /** True if it landed inside `maxSeconds`. */
  landed: boolean;
}

/** Where and when the disc comes down. The primary query for catching AI. */
export function predictLanding(
  state: DiscState,
  wind: THREE.Vector3 = ZERO_WIND,
  maxSeconds = 12,
  stepDt = FIXED_DT,
): LandingPrediction {
  const p = cloneDiscState(state, _predState);
  let apex = p.pos.y;
  const steps = Math.max(0, Math.round(maxSeconds / stepDt));
  for (let i = 0; i < steps; i++) {
    simulate(p, stepDt, wind);
    if (p.pos.y > apex) apex = p.pos.y;
    if (p.touchedGround) break;
  }
  return {
    pos: p.pos.clone(),
    time: p.t,
    apex,
    landed: p.touchedGround,
  };
}

/* ---------------------------------------------------------------- utilities */

/** World-space disc normal (body +Z). */
export function discNormal(s: DiscState, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(0, 0, 1).applyQuaternion(s.orient);
}

/**
 * Orientation for a mesh whose geometry axis is +Y (THREE.CylinderGeometry).
 * Rotates mesh +Y onto the body normal.
 */
const _meshFix = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
export function renderQuaternion(s: DiscState, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.copy(s.orient).multiply(_meshFix);
}

/** Bank angle of the disc about its flight axis, rad. Positive = right edge down. */
export function bankAngle(s: DiscState): number {
  discNormal(s, _n);
  _heading.set(s.vel.x, 0, s.vel.z);
  if (_heading.lengthSq() < 1e-10) return 0;
  _heading.normalize();
  _right.crossVectors(_heading, _upAxis);        // thrower's right
  return Math.atan2(_n.dot(_right), _n.y);
}

/** Total mechanical energy: translational + rotational + gravitational. Joules. */
export function totalEnergy(s: DiscState): number {
  const b = DISC;
  const wx = s.omega.x, wy = s.omega.y, wz = s.omega.z;
  return 0.5 * b.mass * s.vel.lengthSq()
    + b.mass * AERO.g * (s.pos.y - s.groundY)
    + 0.5 * b.Ixx * (wx * wx + wy * wy)
    + 0.5 * b.Izz * wz * wz;
}

/** Instantaneous aerodynamic breakdown. The returned object is reused. */
export function aeroProbe(s: DiscState, wind: THREE.Vector3 = ZERO_WIND): AeroProbe {
  packState(s, _y);
  deriv(_y, wind, _k1, AERO, DISC, _probe);
  return _probe;
}

/** True if any component of the state has gone non-finite. */
export function isFiniteState(s: DiscState): boolean {
  const v = [
    s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z,
    s.orient.x, s.orient.y, s.orient.z, s.orient.w,
    s.omega.x, s.omega.y, s.omega.z,
  ];
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return false;
  return true;
}
