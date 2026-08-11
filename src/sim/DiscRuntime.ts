import * as THREE from 'three';
import {
  DISC, FIXED_DT, createDiscState, isFiniteState, simulate, throwDisc,
  type DiscState, type ThrowOptions, type ThrowType,
} from './DiscPhysics.ts';

/** The non-rendering disc state used by the reference match and golden tools. */
export type DiscMode = 'held' | 'flight' | 'ground';
export interface TrailSample { x: number; y: number; z: number; t: number; speed: number }
export interface ThrowRequest {
  type: ThrowType;
  from: THREE.Vector3;
  /** Aim direction; its horizontal component determines the heading. */
  aim: THREE.Vector3;
  power: number;
  angle: number;
  spin: number;
  hand?: 'R' | 'L';
  bank?: number;
  nose?: number;
  /** Absolute release speed in m/s, overriding power. */
  speed?: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();
const tmpQ1 = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();

/**
 * A renderer-free disc runtime. It owns flight, prediction and visual-neutral
 * history; a Three.js `DiscSystem` may observe it but never drives match logic.
 */
export class DiscRuntime {
  readonly state: DiscState = createDiscState();
  mode: DiscMode = 'ground';
  holderId = -1;
  lastThrowTeam: 0 | 1 = 0;
  sinceRelease = 1e3;
  wear = 0;
  readonly trail: TrailSample[] = [];
  trailCapacity = 72;
  trailSeconds = 0.80;
  groundAt: (x: number, z: number) => number = () => 0;
  wind = new THREE.Vector3();
  pendingScuff: { rr: number; ang: number; top: boolean; strength: number } | null = null;
  private clock = 0;
  private probe = createDiscState();

  step(dt: number): void {
    this.clock += dt;
    this.sinceRelease += dt;
    if (this.mode !== 'flight') { this.decayTrail(); return; }
    this.state.groundY = this.groundAt(this.state.pos.x, this.state.pos.z);
    simulate(this.state, dt, this.wind);
    if (!isFiniteState(this.state)) {
      this.state.vel.set(0, 0, 0);
      this.state.omega.set(0, 0, 0);
      this.state.pos.set(0, this.state.groundY + DISC.halfHeight, 0);
      this.state.atRest = true;
      this.state.touchedGround = true;
    }
    this.pushTrail();
  }

  release(req: ThrowRequest): THREE.Vector3 {
    const opts: ThrowOptions = {
      hand: req.hand ?? 'R', bank: req.bank, nose: req.nose, speed: req.speed,
      groundY: this.groundAt(req.from.x, req.from.z), out: this.state,
    };
    throwDisc(req.type, req.from, req.aim, req.power, req.angle, req.spin, opts);
    this.mode = 'flight';
    this.holderId = -1;
    this.sinceRelease = 0;
    this.trail.length = 0;
    this.pushTrail();
    return tmpV.copy(this.state.vel);
  }

  hold(playerId: number, pos: THREE.Vector3, normal: THREE.Vector3, spinPhase = 0): void {
    this.mode = 'held';
    this.holderId = playerId;
    this.state.pos.copy(pos);
    this.state.vel.set(0, 0, 0);
    this.state.omega.set(0, 0, 0);
    this.state.atRest = false;
    this.state.touchedGround = false;
    this.state.spin = 0;
    this.state.groundY = this.groundAt(pos.x, pos.z);
    orientToNormal(this.state, normal, spinPhase);
    this.trail.length = 0;
  }

  settle(pos: THREE.Vector3): void {
    this.mode = 'ground';
    this.holderId = -1;
    this.state.pos.set(pos.x, this.groundAt(pos.x, pos.z) + DISC.halfHeight, pos.z);
    this.state.vel.set(0, 0, 0);
    this.state.omega.set(0, 0, 0);
    this.state.spin = 0;
    this.state.atRest = true;
    this.state.touchedGround = true;
    orientToNormal(this.state, UP, 0);
  }

  markScuff(strength: number): void {
    const top = discNormalWorld(this.state, tmpV).y >= 0;
    const inv = tmpQ1.copy(this.state.orient).conjugate();
    const down = tmpV2.set(0, -1, 0).applyQuaternion(inv);
    const rr = Math.max(0, Math.min(1, Math.hypot(down.x, down.y) * 1.05));
    this.pendingScuff = { rr, ang: Math.atan2(down.y, down.x), top: !top, strength };
    this.wear = Math.max(0, Math.min(1, this.wear + strength * 0.055));
  }

  get trailAge(): number {
    const s = this.trail[this.trail.length - 1];
    return s ? this.clock - s.t : 1e3;
  }

  predictPath(
    stateLike: { pos?: { x: number; y: number; z: number }; vel?: { x: number; y: number; z: number } },
    horizon = 6, step = 1 / 30,
  ): { t: number; x: number; y: number; z: number }[] {
    const p = this.probe;
    const live = this.mode === 'flight';
    p.pos.copy(this.state.pos); p.vel.copy(this.state.vel); p.orient.copy(this.state.orient);
    p.omega.copy(this.state.omega); p.groundY = this.state.groundY;
    p.touchedGround = false; p.atRest = false; p.t = 0;
    if (!live && stateLike?.pos && stateLike?.vel) {
      p.pos.set(stateLike.pos.x, stateLike.pos.y, stateLike.pos.z);
      p.vel.set(stateLike.vel.x, stateLike.vel.y, stateLike.vel.z);
    }
    const out = [{ t: 0, x: p.pos.x, y: p.pos.y, z: p.pos.z }];
    const dt = Math.max(FIXED_DT, Math.min(1 / 20, step));
    const n = Math.max(2, Math.min(240, Math.round(Math.max(0.1, horizon) / dt)));
    for (let i = 1; i <= n; i++) {
      p.groundY = this.groundAt(p.pos.x, p.pos.z);
      simulate(p, dt, this.wind);
      out.push({ t: i * dt, x: p.pos.x, y: p.pos.y, z: p.pos.z });
      if (p.touchedGround) break;
    }
    if (out.length < 2) out.push({ ...out[0], t: dt });
    return out;
  }

  probeThrow(req: ThrowRequest, catchY: number, maxT = 6): { dist: number; lat: number; t: number; x: number; z: number } {
    const opts: ThrowOptions = {
      hand: req.hand ?? 'R', bank: req.bank, nose: req.nose, speed: req.speed,
      groundY: this.groundAt(req.from.x, req.from.z), out: this.probe,
    };
    const p = throwDisc(req.type, req.from, req.aim, req.power, req.angle, req.spin, opts);
    const hl = Math.hypot(req.aim.x, req.aim.z) || 1;
    const ux = req.aim.x / hl, uz = req.aim.z / hl;
    let prevY = p.pos.y;
    for (let i = 0; i < Math.round(maxT / FIXED_DT); i++) {
      p.groundY = this.groundAt(p.pos.x, p.pos.z);
      simulate(p, FIXED_DT, this.wind);
      const dx = p.pos.x - req.from.x, dz = p.pos.z - req.from.z;
      if ((p.pos.y <= catchY && prevY > catchY) || p.touchedGround) {
        return { dist: dx * ux + dz * uz, lat: -dx * uz + dz * ux, t: p.t, x: p.pos.x, z: p.pos.z };
      }
      prevY = p.pos.y;
    }
    const dx = p.pos.x - req.from.x, dz = p.pos.z - req.from.z;
    return { dist: dx * ux + dz * uz, lat: -dx * uz + dz * ux, t: p.t, x: p.pos.x, z: p.pos.z };
  }

  setTrail(samples: readonly TrailSample[]): void {
    this.trail.length = 0;
    for (const s of samples) this.trail.push({ ...s, t: this.clock - (samples[samples.length - 1].t - s.t) });
  }
  get now(): number { return this.clock; }

  private pushTrail(): void {
    const s = this.state;
    this.trail.push({ x: s.pos.x, y: s.pos.y, z: s.pos.z, t: this.clock, speed: Math.hypot(s.vel.x, s.vel.y, s.vel.z) });
    this.decayTrail();
  }
  private decayTrail(): void {
    const cut = this.clock - this.trailSeconds;
    let drop = 0;
    while (drop < this.trail.length && this.trail[drop].t < cut) drop++;
    if (drop) this.trail.splice(0, drop);
    while (this.trail.length > this.trailCapacity) this.trail.shift();
  }
}

function discNormalWorld(s: DiscState, out: THREE.Vector3): THREE.Vector3 {
  return out.set(0, 0, 1).applyQuaternion(s.orient);
}
function orientToNormal(s: DiscState, normal: THREE.Vector3, phase: number): void {
  tmpV3.copy(normal).normalize();
  if (tmpV3.lengthSq() < 1e-6) tmpV3.set(0, 1, 0);
  tmpQ1.setFromUnitVectors(tmpV2.set(0, 0, 1), tmpV3);
  tmpQ2.setFromAxisAngle(tmpV2.set(0, 0, 1), phase);
  s.orient.copy(tmpQ1).multiply(tmpQ2).normalize();
}
