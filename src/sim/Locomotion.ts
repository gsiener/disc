import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx.ts';
import { Rng } from '../core/Ctx.ts';
import {
  type Attributes, type DesiredMove, type LocoPlayer, type LocoStateName,
  type MoveMode, type Vec2Like, DEFAULT_ATTRS, UNAVAILABLE_STATES, COMMITTED_STATES,
} from './move/Types.ts';
import {
  G, clamp, clamp01, derive, propulsiveAt, takeoffVy, leapHeight, staminaRate,
  COST_CUT, COST_JUMP, COST_LAYOUT,
} from './move/Attributes.ts';
import { GroundProbe, gradeAlong, slopeMultiplier, type Surface } from './move/Ground.ts';
import { advanceGait, plantForCut, GAIT_MIN_SPEED } from './move/Gait.ts';
import { PRONE_Y, contestAir, reachAt, predictPos, type ContestResult } from './move/Contest.ts';
import {
  accumulateSeparation, DiscProbe, PERSONAL_RADIUS, type DiscFocus,
} from './move/Separation.ts';

/**
 * ============================================================================
 * LOCOMOTION — the player movement model
 * ============================================================================
 *
 * Designed for a FIXED 1/120 s timestep. Everything is deterministic: no
 * Math.random, no wall-clock reads, no allocation-dependent behaviour.
 *
 * ---------------------------------------------------------------- how to use
 *
 *   const loco = new Locomotion();
 *   loco.init(ctx);                                  // or loco.attach({events, rand, sys})
 *   const p = loco.create({ id: 3, team: 0, attr, pos: new THREE.Vector3(0,0,-12) });
 *
 *   // once per fixed step, per player, driven by the AI system:
 *   loco.step(p, { dir: toTarget, mode: 'sprint' }, dt);
 *   // ...then once per fixed step, after every player has stepped:
 *   loco.resolveCollisions(dt);
 *
 * `Locomotion` also implements `System` (name 'locomotion', order 7). If it is
 * registered on the engine its `update()` calls `resolveCollisions()` for you;
 * set `autoResolve = false` if you would rather drive that yourself.
 *
 * ------------------------------------------------------------ the input side
 *
 * `DesiredMove` is the AI system's request, not a command:
 *   dir     world-XZ direction to travel (need not be normalised)
 *   speed   absolute target m/s, or omit and use `effort` (0..1 of the cap)
 *   mode    'sprint' | 'run' | 'jog' | 'backpedal' | 'shuffle' | 'auto'
 *   face    where to look; defaults to the travel direction
 *   jump / layout / brake
 *
 * The model may refuse or delay any of it. A layout cannot be cancelled once
 * accepted, a jump has a gather phase, a hard cut has a plant that must play
 * out, and no request can reverse a velocity instantly — a direction change is
 * always paid for with braking impulse and re-acceleration, which is why a
 * 90-degree cut leaves ~30% of your speed on the grass.
 *
 * ----------------------------------------------------------- the output side
 *
 * `step()` mutates and returns the same `LocoPlayer`. Consumers read:
 *   pos, vel, facing            world transform (Y is COM/hip height)
 *   state, stateT, prone        animation state machine input
 *   foot.{planted,pos,t,contact,phase,stride,hard}
 *                               planted-foot world position + timing, for foot
 *                               IK and for the field system to scuff turf at
 *   air.{airborne,tTakeoff,tApex,apexY,tLand,vy0}
 *   stamina, derived            HUD, and AI's own decision making
 *   Locomotion.isAvailable(p)   false while laid out / down / getting up
 *
 * Events emitted on ctx.events:
 *   'player:footstep' {id, pos, foot, speed, hard}   every plant
 *   'player:land'     {id, pos, impact, layout}      ground contact from air
 *   'player:contact'  {a, b, impact, foulOn, called} player-player collision
 *
 * ------------------------------------------------------------- ground truth
 *
 * Surface height/normal come from `ctx.sys.field.heightAt/normalAt` when that
 * system exists and exposes them; otherwise a flat plane at y=0. The field
 * system is authored concurrently, so this is duck-typed every step.
 */

/* ------------------------------------------------------------------ tuning */

/** Angle between current velocity and requested direction that forces a plant. */
const CUT_ANGLE = 45 * Math.PI / 180;
/** Below this speed you can just pivot; no plant needed. */
const CUT_MIN_SPEED = 2.2;
/** Grip multiplier while the cut foot is planted. */
const PLANT_GRIP = 1.8;
/** Brake multiplier while the cut foot is planted. */
const PLANT_BRAKE = 1.35;
/** Extra speed lost to the plant impact itself, at a full 180. */
const CUT_LOSS_BASE = 0.28;
/** Minimum gap between the end of one cut and the start of the next. */
const CUT_REFRACTORY = 0.22;

const JUMP_GATHER = 0.12;
const LAYOUT_GATHER = 0.06;
/** Horizontal speed retained through a vertical takeoff. */
const JUMP_HORIZ_KEEP = 0.88;
/** Air steering authority (m/s^2) — small, you are a projectile. */
const AIR_CONTROL = 0.7;

/** Kinetic friction of a sliding body on grass, as a deceleration (m/s^2). */
const SLIDE_DECEL = 15.7;
/** Horizontal speed retained on a two-foot landing. */
const LAND_HORIZ_KEEP = 0.62;

const COLLIDE_BETA = 0.80;
const COLLIDE_SLOP = 0.002;
const COLLIDE_RESTITUTION = 0.03;
const COLLIDE_FRICTION = 0.45;
/** Vertical separation beyond which two players simply miss each other. */
const COLLIDE_Y_SPAN = 1.0;

const DEFAULT_RADIUS = 0.32;

/* --------------------------------------------------------------- scratch */

const SURF: Surface = { y: 0, n: new THREE.Vector3(0, 1, 0) };
const V3A = new THREE.Vector3();

export interface LocoHost {
  events?: { emit(evt: string, payload?: unknown): void };
  rand?: Rng;
  sys?: Record<string, unknown>;
}

export interface CreateOpts {
  id: number;
  team?: 0 | 1;
  attr?: Partial<Attributes>;
  pos?: THREE.Vector3;
  facing?: number;
  stamina?: number;
  /** Hard-contact radius (m). */
  radius?: number;
  /** Soft personal-space radius (m); clamped to at least `radius`. */
  personal?: number;
}

/* ---------------------------------------------------- AI interop (duck-typed)
 * The AI system publishes a `PlayerIntent`. We deliberately do NOT import it —
 * these structural mirrors keep the two modules independently authorable. Any
 * object with these fields works; every field is optional.
 */

export interface IntentLike {
  id: number;
  targetX?: number;
  targetZ?: number;
  faceX?: number;
  faceZ?: number;
  /** AI gait vocabulary, a superset of ours (poses included). */
  mode?: string;
  effort?: number;
  desiredSpeed?: number;
  maxSpeed?: number;
  arriveRadius?: number;
  action?: { kind: string; x?: number; z?: number } | null;
}

export interface WorldPlayerLike {
  id: number;
  pos?: { x: number; y: number; z: number };
  vel?: { x: number; y: number; z: number };
  airborne?: boolean;
}

export interface WorldLike { players?: WorldPlayerLike[] }

export interface AthleteLike {
  id?: number;
  pos?: { x: number; z: number };
  vel?: { x: number; z: number };
  attr?: Record<string, unknown>;
}

/** AI `mode` values that are poses rather than gaits — honour speed, do not path. */
const POSE_MODES = new Set(['plant', 'pivot', 'throw', 'catch', 'mark', 'idle']);

/**
 * Translate the AI system's rating vocabulary (speed/acceleration/agility/
 * jumping/stamina) into ours. Anything missing falls back to DEFAULT_ATTRS.
 */
export function fromAIAttributes(a: Record<string, unknown>, height = 1.83, mass = 82): Attributes {
  const num = (k: string, d: number): number =>
    typeof a?.[k] === 'number' ? (a[k] as number) : d;
  const agility = num('agility', DEFAULT_ATTRS.agility);
  return {
    speed: num('speed', DEFAULT_ATTRS.speed),
    accel: num('accel', num('acceleration', DEFAULT_ATTRS.accel)),
    agility,
    strength: num('strength', DEFAULT_ATTRS.strength),
    vertical: num('vertical', num('jumping', DEFAULT_ATTRS.vertical)),
    endurance: num('endurance', num('stamina', DEFAULT_ATTRS.endurance)),
    balance: num('balance', agility),
    height: num('height', height),
    mass: num('mass', mass),
  };
}

/** Capability estimate for a foreign player object. */
function deriveLoose(p: AthleteLike) {
  return derive(fromAIAttributes(p.attr ?? {}), 100, 0, 'sprint');
}

export class Locomotion implements System {
  readonly name = 'locomotion';
  readonly order = 7;

  /** When registered as a System, update() resolves collisions. */
  autoResolve = true;

  /** Run the soft personal-space pass before hard contact. See Separation.ts. */
  separate = true;

  /** Pairs the last separation pass engaged, and the metres it moved. Debug. */
  sepPairs = 0;
  sepWork = 0;

  readonly players: LocoPlayer[] = [];

  private host: LocoHost | null = null;
  private probe = new GroundProbe();
  private rng = new Rng(0x10c0_5eed);
  private byId = new Map<number, LocoPlayer>();
  private lastCutEnd = new Map<number, number>();
  private sepX = new Float64Array(16);
  private sepZ = new Float64Array(16);
  private sepR = new Float64Array(16);
  private discProbe = new DiscProbe();
  private discFocus: DiscFocus = { x: 0, z: 0, live: false };

  /* ------------------------------------------------------------ lifecycle */

  init(ctx: Ctx): void {
    this.attach(ctx as unknown as LocoHost);
  }

  /** Headless-friendly bind. `ctx` satisfies LocoHost structurally. */
  attach(host: LocoHost): void {
    this.host = host;
    if (host.rand) this.rng = host.rand.fork(0x10c0);
    this.probe.bind(host.sys as Record<string, unknown> | undefined);
  }

  update(dt: number, _ctx: Ctx): void {
    if (this.autoResolve) this.resolveCollisions(dt);
  }

  /* --------------------------------------------------------------- roster */

  create(opts: CreateOpts): LocoPlayer {
    const attr: Attributes = { ...DEFAULT_ATTRS, ...(opts.attr ?? {}) };
    const pos = opts.pos ? opts.pos.clone() : new THREE.Vector3();
    const hipHeight = 0.53 * attr.height;
    pos.y = this.probe.heightAt(pos.x, pos.z) + hipHeight;

    const p: LocoPlayer = {
      id: opts.id,
      team: opts.team ?? 0,
      attr,
      pos,
      vel: new THREE.Vector3(),
      facing: opts.facing ?? 0,
      state: 'idle',
      stateT: 0,
      stateDur: 0,
      prone: false,
      anchored: false,
      stamina: opts.stamina ?? 100,
      foot: {
        planted: 'R',
        pos: new THREE.Vector3(pos.x, pos.y - hipHeight, pos.z),
        t: 0,
        contact: true,
        phase: 0,
        stride: 0,
        hard: false,
        speed: 0,
      },
      air: {
        airborne: false, tTakeoff: 0, tApex: 0, apexY: 0,
        takeoffY: 0, tLand: 0, vy0: 0,
      },
      groundY: pos.y - hipHeight,
      groundN: new THREE.Vector3(0, 1, 0),
      radius: opts.radius ?? DEFAULT_RADIUS,
      personal: Math.max(opts.radius ?? DEFAULT_RADIUS, opts.personal ?? PERSONAL_RADIUS),
      hipHeight,
      cmd: { x: 0, z: 0 },
      cutDir: new THREE.Vector3(),
      cutEntrySpeed: 0,
      cutAngle: 0,
      lastStepT: 0,
      t: 0,
      derived: derive(attr, opts.stamina ?? 100, 0, 'run'),
    };
    // Deterministic gait offset so a whole team does not march in lockstep.
    p.foot.phase = this.rng.fork(opts.id * 977 + 11).next() * 0.999;
    this.players.push(p);
    this.byId.set(p.id, p);
    return p;
  }

  get(id: number): LocoPlayer | undefined { return this.byId.get(id); }

  remove(id: number): void {
    const p = this.byId.get(id);
    if (!p) return;
    this.byId.delete(id);
    const i = this.players.indexOf(p);
    if (i >= 0) this.players.splice(i, 1);
  }

  /* ------------------------------------------------------------- queries */

  static isAvailable(p: LocoPlayer): boolean { return !UNAVAILABLE_STATES.has(p.state); }
  static isCommitted(p: LocoPlayer): boolean { return COMMITTED_STATES.has(p.state); }
  isAvailable(p: LocoPlayer): boolean { return !UNAVAILABLE_STATES.has(p.state); }

  /** Fingertip height `t` seconds from now. */
  reachAt(p: LocoPlayer, t = 0): number { return reachAt(p, t); }

  /** Predicted COM position `t` seconds from now. */
  predictPos(p: LocoPlayer, t: number, out = new THREE.Vector3()): THREE.Vector3 {
    return predictPos(p, t, out);
  }

  /** Peak height this player could reach if they left the ground right now. */
  peakReach(p: LocoPlayer): number {
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const d = derive(p.attr, p.stamina, speed, 'sprint');
    return p.groundY + p.attr.height * 1.30 + leapHeight(d, speed);
  }

  /** Resolve two players going up for the same disc. */
  contest(a: LocoPlayer, b: LocoPlayer, discPos: THREE.Vector3, tContest: number): ContestResult {
    const jitter = this.rng.next() * 2 - 1;
    return contestAir(a, b, discPos, tContest, jitter);
  }

  /* ----------------------------------------------------- AI peer contract */

  /** `ctx.sys.locomotion.isAirborne` — used by the AI to skip un-steerable bodies. */
  isAirborne(p: { id?: number; air?: { airborne: boolean } }): boolean {
    if (p && p.air) return p.air.airborne;
    const mine = p && p.id !== undefined ? this.byId.get(p.id) : undefined;
    return mine ? mine.air.airborne : false;
  }

  /**
   * `ctx.sys.locomotion.timeToReach` — seconds for this player to get to (x,z),
   * including the speed they will scrub turning toward it. Accepts either one
   * of our own `LocoPlayer`s or any `{id, pos, vel}` the AI hands us.
   */
  timeToReach(p: AthleteLike, x: number, z: number): number {
    const asOurs = p as unknown as Partial<LocoPlayer>;
    const mine: LocoPlayer | undefined = asOurs.attr && asOurs.derived
      ? (asOurs as LocoPlayer)
      : (p.id !== undefined ? this.byId.get(p.id) : undefined);

    const px = p.pos?.x ?? mine?.pos.x ?? 0;
    const pz = p.pos?.z ?? mine?.pos.z ?? 0;
    const vx = p.vel?.x ?? mine?.vel.x ?? 0;
    const vz = p.vel?.z ?? mine?.vel.z ?? 0;

    const d = Math.hypot(x - px, z - pz);
    if (d < 1e-3) return 0;

    const cap = mine
      ? derive(mine.attr, mine.stamina, 0, 'sprint')
      : deriveLoose(p);
    const top = Math.max(0.5, cap.topSpeed);
    const A = Math.max(0.5, cap.accelMax);

    // Entry speed after turning: the geometric scrub of a cut, plus the plant.
    const s = Math.hypot(vx, vz);
    let v0 = 0;
    let extra = 0;
    if (s > 1e-4) {
      const cosang = ((x - px) * vx + (z - pz) * vz) / (d * s);
      const ang = Math.acos(clamp(cosang, -1, 1));
      v0 = s * Math.max(0, Math.cos(ang / 2)) * Math.max(0, Math.cos(ang / 2));
      if (ang > CUT_ANGLE) extra = cap.plantDur;
    }

    // Invert x(t) = top*t - (top/A)(top - v0)(1 - e^(-tA/top)) by Newton.
    const tau = top / A;
    const k = tau * (top - v0);
    let t = d / top + (top - v0) / (2 * A);
    for (let i = 0; i < 8; i++) {
      const e = Math.exp(-t / tau);
      const f = top * t - k * (1 - e) - d;
      const df = top - (k / tau) * e;
      if (Math.abs(df) < 1e-9) break;
      const nt = t - f / df;
      if (!Number.isFinite(nt)) break;
      t = Math.max(0, nt);
    }
    return t + extra;
  }

  /**
   * Consume one `PlayerIntent` from the AI system (duck-typed — we never import
   * AI.ts). Positional target, arrive damping, gait and one-shot actions are
   * translated into a `DesiredMove` and stepped.
   *
   * `maxSpeed` from the intent is honoured as a hard ceiling; `maxAccel`,
   * `maxDecel` and `turnRate` are advisory — this model derives those from the
   * same ratings and from the ground-force budget, which is the point of it.
   */
  stepIntent(p: LocoPlayer, intent: IntentLike, dt: number): LocoPlayer {
    return this.step(p, this.intentToDesired(p, intent), dt);
  }

  intentToDesired(p: LocoPlayer, intent: IntentLike): DesiredMove {
    const dx = (intent.targetX ?? p.pos.x) - p.pos.x;
    const dz = (intent.targetZ ?? p.pos.z) - p.pos.z;
    const d = Math.hypot(dx, dz);

    const pose = POSE_MODES.has(intent.mode ?? '');
    const gait: MoveMode =
      intent.mode === 'sprint' ? 'sprint'
        : intent.mode === 'jog' ? 'jog'
          : intent.mode === 'backpedal' ? 'backpedal'
            : intent.mode === 'shuffle' ? 'shuffle'
              : 'run';

    let speed = intent.desiredSpeed ?? intent.maxSpeed ?? undefined;
    if (intent.mode === 'idle') speed = 0;
    // Arrive: taper inside the arrival radius so nobody orbits their target.
    const ar = intent.arriveRadius ?? 0.6;
    if (speed !== undefined && ar > 1e-3 && d < ar) speed *= clamp01(d / ar);
    if (d < 0.04) speed = 0;

    const action = intent.action;
    const out: DesiredMove = {
      dir: d > 1e-4 ? { x: dx / d, z: dz / d } : null,
      speed,
      mode: pose ? 'run' : gait,
      face: (intent.faceX !== undefined && intent.faceZ !== undefined)
        ? { x: intent.faceX, z: intent.faceZ } : null,
      maxSpeed: intent.maxSpeed,
    };
    if (intent.mode === 'jump' || action?.kind === 'jump') out.jump = true;
    if (intent.mode === 'layout' || action?.kind === 'bid') {
      out.layout = true;
      if (action?.kind === 'bid' && action.x !== undefined && action.z !== undefined) {
        const bx = action.x - p.pos.x, bz = action.z - p.pos.z;
        const bl = Math.hypot(bx, bz);
        if (bl > 1e-4) out.dir = { x: bx / bl, z: bz / bl };
      }
    }
    return out;
  }

  /**
   * Step every intent, resolve contacts once, then mirror the result back onto
   * the AI's own player records if they were supplied.
   */
  apply(intents: IntentLike[], world: WorldLike | number | null, dt?: number): void {
    const step = typeof world === 'number' ? world : (dt ?? 1 / 120);
    for (const it of intents) {
      const p = this.byId.get(it.id);
      if (p) this.stepIntent(p, it, step);
    }
    this.resolveCollisions(step);
    const wp = typeof world === 'object' && world ? world.players : undefined;
    if (wp) this.syncTo(wp);
  }

  /** Copy pos/vel/airborne onto plain `{id,pos,vel}` records the AI owns. */
  syncTo(out: WorldPlayerLike[]): void {
    for (const w of out) {
      const p = this.byId.get(w.id);
      if (!p) continue;
      if (w.pos) { w.pos.x = p.pos.x; w.pos.y = p.pos.y; w.pos.z = p.pos.z; }
      if (w.vel) { w.vel.x = p.vel.x; w.vel.y = p.vel.y; w.vel.z = p.vel.z; }
      w.airborne = p.air.airborne;
    }
  }

  /* ------------------------------------------------------------ main step */

  /**
   * Advance one player by one fixed timestep.
   * Call once per player per sim tick, then `resolveCollisions(dt)` once.
   */
  step(p: LocoPlayer, desired: DesiredMove, dt: number): LocoPlayer {
    if (!(dt > 0)) return p;
    if (dt > 1 / 30) dt = 1 / 30;

    this.probe.bind(this.host?.sys as Record<string, unknown> | undefined);

    p.t += dt;
    p.stateT += dt;

    // Record the commanded line for the separation pass. `solveGround` refines
    // this once it has resolved cuts and braking; this is the fallback for the
    // airborne and committed paths, which never reach the solver.
    if (desired.dir && !desired.brake) {
      const d = desired.dir as Vec2Like;
      const l = Math.hypot(d.x, d.z);
      p.cmd.x = l > 1e-5 ? d.x / l : 0;
      p.cmd.z = l > 1e-5 ? d.z / l : 0;
    } else {
      p.cmd.x = 0; p.cmd.z = 0;
    }

    this.probe.sample(p.pos.x, p.pos.z, SURF);
    p.groundY = SURF.y;
    p.groundN.copy(SURF.n);

    if (p.air.airborne) this.stepAir(p, desired, dt);
    else this.stepGround(p, desired, dt);

    this.stepStamina(p, dt);
    return p;
  }

  /* ------------------------------------------------------------ airborne */

  private stepAir(p: LocoPlayer, desired: DesiredMove, dt: number): void {
    // Layouts are committed — no steering at all. Jumps get a token amount.
    if (p.state === 'jump' && desired.dir) {
      const dx = (desired.dir as Vec2Like).x;
      const dz = (desired.dir as Vec2Like).z;
      const l = Math.hypot(dx, dz);
      if (l > 1e-4) {
        p.vel.x += (dx / l) * AIR_CONTROL * dt;
        p.vel.z += (dz / l) * AIR_CONTROL * dt;
      }
    }

    p.vel.y -= G * dt;
    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;
    p.pos.y += p.vel.y * dt;

    this.probe.sample(p.pos.x, p.pos.z, SURF);
    p.groundY = SURF.y;
    p.groundN.copy(SURF.n);

    const layout = p.state === 'layout';
    const landY = p.groundY + (layout ? PRONE_Y : p.hipHeight);
    if (p.pos.y <= landY && p.vel.y <= 0) {
      const impact = -p.vel.y;
      p.pos.y = landY;
      p.vel.y = 0;
      p.air.airborne = false;
      p.prone = layout;

      if (layout) {
        // Belly-in, then slide. `landing` runs until the slide stops.
        this.enter(p, 'landing', 0);
      } else {
        p.vel.x *= LAND_HORIZ_KEEP;
        p.vel.z *= LAND_HORIZ_KEEP;
        const bal = clamp01(p.attr.balance / 100);
        this.enter(p, 'landing', clamp(0.10 + 0.028 * impact * (1.4 - 0.6 * bal), 0.10, 0.42));
      }
      this.emit('player:land', {
        id: p.id, pos: p.pos.clone(), impact, layout,
      });
    }
  }

  /* -------------------------------------------------------------- grounded */

  private stepGround(p: LocoPlayer, desired: DesiredMove, dt: number): void {
    const control = this.groundPhase(p, desired, dt);
    if (control > 0) this.solveGround(p, desired, dt, control);
    // Re-sample after moving so the body sits on the surface it ended on, not
    // the one it pushed off from.
    this.probe.sample(p.pos.x, p.pos.z, SURF);
    p.groundY = SURF.y;
    p.groundN.copy(SURF.n);
    // A takeoff can happen inside groundPhase; once airborne the COM is
    // ballistic and must NOT be snapped back onto the surface — doing so drops
    // a layout's centre of mass to prone height before the arc even starts.
    if (!p.air.airborne) this.conformY(p);
  }

  /**
   * Runs the committed / uncontrolled state machine. Returns how much steering
   * authority the player has this step (0 = none, 1 = full).
   */
  private groundPhase(p: LocoPlayer, desired: DesiredMove, dt: number): number {
    switch (p.state) {
      case 'jump':
      case 'layout': {
        // Gather: still on the ground, loading the legs.
        const decay = Math.exp(-2.2 * dt);
        p.vel.x *= decay;
        p.vel.z *= decay;
        this.advanceGaitFor(p, desired, dt);
        if (p.stateT >= p.stateDur) this.takeoff(p);
        return 0;
      }

      case 'landing': {
        if (p.prone) {
          this.slide(p, dt);
          const s = Math.hypot(p.vel.x, p.vel.z);
          if (s < 0.30 && p.stateT > 0.12) this.enter(p, 'recovery', this.getUpTime(p));
          return 0;
        }
        if (p.stateT >= p.stateDur) { this.enter(p, 'idle', 0); return 1; }
        return 0.25;
      }

      case 'fall': {
        this.slide(p, dt);
        const s = Math.hypot(p.vel.x, p.vel.z);
        if (p.stateT >= p.stateDur && s < 0.30) this.enter(p, 'recovery', this.getUpTime(p));
        return 0;
      }

      case 'recovery': {
        const decay = Math.exp(-12 * dt);
        p.vel.x *= decay;
        p.vel.z *= decay;
        if (p.stateT >= p.stateDur) {
          p.prone = false;
          this.enter(p, 'idle', 0);
          return 1;
        }
        return 0;
      }

      case 'stumble': {
        if (p.stateT >= p.stateDur) { this.enter(p, 'idle', 0); return 1; }
        return 0.40;
      }

      case 'cut': {
        if (p.stateT >= p.stateDur) this.endCut(p);
        return 1;
      }

      default:
        return 1;
    }
  }

  /* ------------------------------------------------------- movement solve */

  private solveGround(p: LocoPlayer, desired: DesiredMove, dt: number, control: number): void {
    const vx0 = p.vel.x, vz0 = p.vel.z;
    const speed0 = Math.hypot(vx0, vz0);
    const inCut = p.state === 'cut';

    // ---- requested direction ------------------------------------------------
    let dx = 0, dz = 0;
    if (inCut) {
      dx = p.cutDir.x; dz = p.cutDir.z;
    } else if (desired.dir) {
      const d = desired.dir as Vec2Like;
      const l = Math.hypot(d.x, d.z);
      if (l > 1e-5) { dx = d.x / l; dz = d.z / l; }
    }
    const hasDir = dx !== 0 || dz !== 0;

    // ---- gait selection -----------------------------------------------------
    const mode = this.resolveMode(p, desired, dx, dz);

    // ---- terrain ------------------------------------------------------------
    const grade = gradeAlong(p.groundN, hasDir ? dx : vx0, hasDir ? dz : vz0);
    const slopeMul = slopeMultiplier(grade);

    const der = derive(p.attr, p.stamina, speed0, mode, slopeMul);
    p.derived = der;

    let cap = control >= 1 ? der.modeCap : der.modeCap * control;
    if (desired.maxSpeed !== undefined) cap = Math.min(cap, Math.max(0, desired.maxSpeed));

    // ---- hard cut detection -------------------------------------------------
    if (!inCut && control >= 1 && hasDir && speed0 > CUT_MIN_SPEED) {
      const dot = (vx0 * dx + vz0 * dz) / speed0;
      const ang = Math.acos(clamp(dot, -1, 1));
      const since = p.t - (this.lastCutEnd.get(p.id) ?? -99);
      if (ang > CUT_ANGLE && since > CUT_REFRACTORY && !desired.brake) {
        this.startCut(p, dx, dz, ang, speed0, der.plantDur);
        // The plant happens this step; the solve below runs with plant grip.
        return this.solveGround(p, desired, dt, control);
      }
    }

    // ---- target velocity ----------------------------------------------------
    let tgt: number;
    if (desired.brake || !hasDir) tgt = 0;
    else if (desired.speed !== undefined) tgt = desired.speed;
    else tgt = cap * clamp01(desired.effort ?? 1);
    tgt = clamp(tgt, 0, cap);

    // The line this body is actually committed to travelling this step — the
    // cut direction while planting, the request otherwise, and nothing at all
    // if they were told to stop. Separation slides bodies ACROSS this rather
    // than against it, so making room never costs progress toward the spot.
    if (hasDir && tgt > 0.05) { p.cmd.x = dx; p.cmd.z = dz; } else { p.cmd.x = 0; p.cmd.z = 0; }

    const tvx = dx * tgt, tvz = dz * tgt;

    // ---- ground-force budget (a friction ellipse) ---------------------------
    // The axis is the current direction of travel: "along" is drive/brake,
    // "lat" is the sideways force that bends the path. The requested vector is
    // scaled UNIFORMLY onto the ellipse so its direction survives clamping —
    // scaling the two components independently would leave a residual sideways
    // force during a pure 180 and slowly spiral the player.
    let ux: number, uz: number;
    if (speed0 > 0.20) { ux = vx0 / speed0; uz = vz0 / speed0; }
    else if (hasDir) { ux = dx; uz = dz; }
    else if (speed0 > 1e-4) { ux = vx0 / speed0; uz = vz0 / speed0; }
    else { ux = 0; uz = 0; }

    const rx = (tvx - vx0) / dt;
    const rz = (tvz - vz0) / dt;

    let along = rx * ux + rz * uz;
    let latx = rx - along * ux;
    let latz = rz - along * uz;
    const lat0 = Math.hypot(latx, latz);

    const brakeLim = der.brakeMax * (inCut ? PLANT_BRAKE : 1);
    const latLim = Math.max(1e-6, der.gripMax * (inCut ? PLANT_GRIP : 1) * control);
    const axisLim = along >= 0 ? Math.max(der.accelMax * control, 0.1) : brakeLim;

    const mag = Math.hypot(along / axisLim, lat0 / latLim);
    if (mag > 1) {
      const s = 1 / mag;
      along *= s; latx *= s; latz *= s;
    }

    // Top-end falloff: at speed there is simply no more drive left in the legs.
    const propLim = propulsiveAt(der, speed0, der.topSpeed) * control;
    if (along > propLim) along = propLim;

    const ax = along * ux + latx;
    const az = along * uz + latz;

    p.vel.x = vx0 + ax * dt;
    p.vel.z = vz0 + az * dt;

    // Never gain speed above the cap; shed any excess gently.
    let ns = Math.hypot(p.vel.x, p.vel.z);
    const limit = Math.max(cap, speed0 - 3 * dt);
    if (ns > limit && ns > 1e-6) {
      const k = limit / ns;
      p.vel.x *= k; p.vel.z *= k;
      ns = limit;
    }
    if (ns < 0.02) { p.vel.x = 0; p.vel.z = 0; ns = 0; }

    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;

    // ---- facing -------------------------------------------------------------
    this.turnToward(p, desired, mode, dx, dz, ns, der.turnRate, dt);

    // ---- gait ---------------------------------------------------------------
    if (!inCut) this.advanceGaitFor(p, desired, dt, mode, ns);

    // ---- takeoff requests ---------------------------------------------------
    if (control >= 1 && !inCut) {
      if (desired.layout) { this.beginLayout(p, dx, dz, ns); return; }
      if (desired.jump) { this.beginJump(p); return; }
    }

    // ---- state classification ----------------------------------------------
    if (!inCut && !COMMITTED_STATES.has(p.state) && p.state !== 'stumble') {
      p.state = this.classify(p, mode, ns, der.topSpeed);
    }
  }

  private classify(_p: LocoPlayer, mode: MoveMode, speed: number, topSpeed: number): LocoStateName {
    if (mode === 'backpedal') return 'backpedal';
    if (mode === 'shuffle') return 'shuffle';
    const f = speed / Math.max(0.1, topSpeed);
    if (f < 0.06) return 'idle';
    if (f < 0.45) return 'jog';
    if (f < 0.80) return 'run';
    return 'sprint';
  }

  /**
   * 'auto' picks the gait from the angle between where the player is looking
   * and where they are going: backwards is a backpedal, sideways is a slide.
   */
  private resolveMode(p: LocoPlayer, desired: DesiredMove, dx: number, dz: number): Exclude<MoveMode, 'auto'> {
    const m = desired.mode ?? 'auto';
    if (m !== 'auto') return m;
    if (dx === 0 && dz === 0) return 'run';

    let fxv = Math.sin(p.facing), fzv = Math.cos(p.facing);
    if (desired.face) {
      const f = desired.face as Vec2Like;
      const l = Math.hypot(f.x, f.z);
      if (l > 1e-5) { fxv = f.x / l; fzv = f.z / l; }
    } else {
      return 'run';
    }
    const dot = clamp(fxv * dx + fzv * dz, -1, 1);
    if (dot < -0.55) return 'backpedal';   // >123 deg from facing
    if (dot < 0.42) return 'shuffle';      // >65 deg from facing
    return 'run';
  }

  private turnToward(
    p: LocoPlayer, desired: DesiredMove, mode: Exclude<MoveMode, 'auto'>,
    dx: number, dz: number, speed: number, turnRate: number, dt: number,
  ): void {
    let tx = 0, tz = 0;
    if (desired.face) {
      const f = desired.face as Vec2Like;
      const l = Math.hypot(f.x, f.z);
      if (l > 1e-5) { tx = f.x / l; tz = f.z / l; }
    } else if (mode === 'backpedal') {
      if (speed > 0.3) { const l = Math.hypot(p.vel.x, p.vel.z); tx = -p.vel.x / l; tz = -p.vel.z / l; }
      else if (dx || dz) { tx = -dx; tz = -dz; }
    } else if (mode === 'shuffle') {
      return; // hold the current look
    } else if (speed > 0.5) {
      const l = Math.hypot(p.vel.x, p.vel.z);
      tx = p.vel.x / l; tz = p.vel.z / l;
    } else if (dx || dz) {
      tx = dx; tz = dz;
    }
    if (tx === 0 && tz === 0) return;

    const want = Math.atan2(tx, tz);
    let d = want - p.facing;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const step = turnRate * dt;
    p.facing += clamp(d, -step, step);
    if (p.facing > Math.PI) p.facing -= Math.PI * 2;
    if (p.facing < -Math.PI) p.facing += Math.PI * 2;
  }

  /* ------------------------------------------------------------------ cuts */

  private startCut(p: LocoPlayer, dx: number, dz: number, ang: number, speed: number, plantDur: number): void {
    p.cutDir.set(dx, 0, dz);
    p.cutEntrySpeed = speed;
    p.cutAngle = ang;
    this.enter(p, 'cut', plantDur);
    p.stamina = Math.max(0, p.stamina - COST_CUT);

    // Outside foot goes down; the turn pivots about it.
    const rxv = -p.vel.z / speed, rzv = p.vel.x / speed;   // right of travel
    const side = dx * rxv + dz * rzv;
    const turnSign = side >= 0 ? 1 : -1;

    const plant = plantForCut(p, speed, p.vel.x, p.vel.z, turnSign,
      (x, z) => this.probe.heightAt(x, z));
    this.emitFootstep(p, plant.foot, plant.x, plant.y, plant.z, speed, true);
  }

  private endCut(p: LocoPlayer): void {
    // The plant itself costs energy on top of the geometric speed scrub.
    const agi = clamp01(p.attr.agility / 100);
    const loss = CUT_LOSS_BASE * (1 - 0.45 * agi) * (1 - Math.cos(p.cutAngle)) * 0.5;
    const k = Math.max(0, 1 - loss);
    p.vel.x *= k;
    p.vel.z *= k;
    this.lastCutEnd.set(p.id, p.t);
    this.enter(p, 'run', 0);
  }

  /* ------------------------------------------------------- jump / layout */

  private beginJump(p: LocoPlayer): void {
    this.enter(p, 'jump', JUMP_GATHER);
    p.stamina = Math.max(0, p.stamina - COST_JUMP);
  }

  private beginLayout(p: LocoPlayer, dx: number, dz: number, speed: number): void {
    if (dx === 0 && dz === 0) {
      if (speed > 0.2) { dx = p.vel.x / speed; dz = p.vel.z / speed; }
      else { dx = Math.sin(p.facing); dz = Math.cos(p.facing); }
    }
    p.cutDir.set(dx, 0, dz);
    this.enter(p, 'layout', LAYOUT_GATHER);
    p.stamina = Math.max(0, p.stamina - COST_LAYOUT);
  }

  private takeoff(p: LocoPlayer): void {
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const der = derive(p.attr, p.stamina, speed, 'sprint');

    if (p.state === 'layout') {
      const ver = clamp01(p.attr.vertical / 100);
      const acc = clamp01(p.attr.accel / 100);
      const push = 0.4 + 0.8 * acc;
      let dx = p.cutDir.x, dz = p.cutDir.z;
      const l = Math.hypot(dx, dz);
      if (l > 1e-5) { dx /= l; dz /= l; } else { dx = Math.sin(p.facing); dz = Math.cos(p.facing); }
      p.vel.x += dx * push;
      p.vel.z += dz * push;
      p.vel.y = 0.9 + 0.6 * ver;
      p.prone = true;
    } else {
      p.vel.x *= JUMP_HORIZ_KEEP;
      p.vel.z *= JUMP_HORIZ_KEEP;
      p.vel.y = takeoffVy(der, speed);
    }

    p.air.airborne = true;
    p.air.tTakeoff = p.t;
    p.air.vy0 = p.vel.y;
    p.air.takeoffY = p.pos.y;
    p.air.tApex = p.t + p.vel.y / G;
    p.air.apexY = p.pos.y + (p.vel.y * p.vel.y) / (2 * G);
    const landY = p.groundY + (p.state === 'layout' ? PRONE_Y : p.hipHeight);
    const disc = p.vel.y * p.vel.y + 2 * G * (p.pos.y - landY);
    p.air.tLand = p.t + (p.vel.y + Math.sqrt(Math.max(0, disc))) / G;
  }

  /* --------------------------------------------------------------- ground */

  private slide(p: LocoPlayer, dt: number): void {
    const s = Math.hypot(p.vel.x, p.vel.z);
    if (s <= 1e-6) { p.vel.x = 0; p.vel.z = 0; return; }
    const ns = Math.max(0, s - SLIDE_DECEL * dt);
    const k = ns / s;
    p.vel.x *= k;
    p.vel.z *= k;
    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;
  }

  private getUpTime(p: LocoPlayer): number {
    const agi = clamp01(p.attr.agility / 100);
    const bal = clamp01(p.attr.balance / 100);
    return clamp(1.45 - 0.35 * agi - 0.30 * bal, 0.75, 1.45);
  }

  private conformY(p: LocoPlayer): void {
    if (p.state === 'recovery' && p.stateDur > 0) {
      const k = clamp01(p.stateT / p.stateDur);
      p.pos.y = p.groundY + PRONE_Y + (p.hipHeight - PRONE_Y) * (k * k * (3 - 2 * k));
      return;
    }
    p.pos.y = p.groundY + (p.prone ? PRONE_Y : p.hipHeight);
  }

  private advanceGaitFor(
    p: LocoPlayer, desired: DesiredMove, dt: number,
    mode?: Exclude<MoveMode, 'auto'>, speed?: number,
  ): void {
    if (p.prone) return;
    const s = speed ?? Math.hypot(p.vel.x, p.vel.z);
    const m = mode ?? (desired.mode === 'auto' || !desired.mode ? 'run' : desired.mode);
    const plant = advanceGait(p, s, p.vel.x, p.vel.z, m, dt,
      (x, z) => this.probe.heightAt(x, z));
    if (plant.planted && s >= GAIT_MIN_SPEED) {
      this.emitFootstep(p, plant.foot, plant.x, plant.y, plant.z, plant.speed, false);
    }
  }

  /* ------------------------------------------------------------- stamina */

  private stepStamina(p: LocoPlayer, dt: number): void {
    const speed = Math.hypot(p.vel.x, p.vel.z);
    // Fresh, flat-ground sprint top speed — the reference the drain curve uses.
    const fresh = 6.6 + 3.0 * clamp01(p.attr.speed / 100);
    const rate = p.prone || p.air.airborne
      ? staminaRate(p.attr, 0, fresh) * 0.4
      : staminaRate(p.attr, speed, fresh);
    p.stamina = clamp(p.stamina + rate * dt, 0, 100);
  }

  /* ---------------------------------------------------------- collisions */

  /**
   * Two passes, in this order:
   *
   *   1. PERSONAL SPACE (move/Separation.ts). Positional, lateral, no velocity
   *      written. Athletes make room for each other before they touch, so the
   *      resting separation of two bodies that merely converged is ~1.26 m
   *      rather than the 0.64 m hard-contact floor. This is what stops twelve
   *      off-ball bodies reading as one silhouette.
   *   2. HARD CONTACT (below). Impulses, momentum transfer, stumbles, fouls.
   *      Runs on the post-separation geometry so it only ever fires on real
   *      collisions — someone genuinely ran into someone else — rather than on
   *      the crowding that pass 1 has already resolved.
   *
   * Set `separate = false` to run the hard tier alone.
   *
   * Both passes move bodies in XZ, and both are followed by a re-seat: the
   * surface height under a body is sampled during `step()`, before either pass
   * has run, and `Players.ts` parks the rig root on `loco.groundY`. On a pitch
   * that falls 18.5 cm from the crown to the touchline, a body nudged sideways
   * and left on its old `groundY` renders fractionally into the turf. It is a
   * tenth of a millimetre in practice, but the contract "groundY is the
   * surface under this body" is worth having exactly rather than nearly.
   */
  resolveCollisions(dt: number, list: LocoPlayer[] = this.players): void {
    if (this.separate) this.applySeparation(list, dt);
    this.resolveContacts(dt, list);
    this.reseat(list);
  }

  /**
   * Re-read the surface under every grounded body and put its centre of mass
   * back at the right height above it. Idempotent: for a body that nothing
   * moved this recomputes exactly what `stepGround` already stored. Airborne
   * bodies are skipped — their Y is ballistic and belongs to `stepAir`.
   */
  private reseat(list: LocoPlayer[]): void {
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.air.airborne) continue;
      this.probe.sample(p.pos.x, p.pos.z, SURF);
      p.groundY = SURF.y;
      p.groundN.copy(SURF.n);
      this.conformY(p);
    }
  }

  /**
   * Personal space. Jacobi-accumulated so the result does not depend on pair
   * order, then applied in one go.
   */
  private applySeparation(list: LocoPlayer[], dt: number): void {
    const n = list.length;
    if (n < 2) return;
    if (this.sepX.length < n) {
      this.sepX = new Float64Array(n * 2);
      this.sepZ = new Float64Array(n * 2);
      this.sepR = new Float64Array(n * 2);
    }
    const sx = this.sepX, sz = this.sepZ;
    sx.fill(0, 0, n);
    sz.fill(0, 0, n);

    this.discProbe.bind(this.host?.sys as Record<string, unknown> | undefined);
    this.discProbe.read(this.discFocus);

    this.sepWork = 0;
    this.sepPairs = accumulateSeparation(list, dt, sx, sz, this.discFocus, this.sepR);
    if (this.sepPairs === 0) return;

    for (let i = 0; i < n; i++) {
      if (sx[i] === 0 && sz[i] === 0) continue;
      this.sepWork += Math.hypot(sx[i], sz[i]);
      const p = list[i];
      p.pos.x += sx[i];
      p.pos.z += sz[i];
      // Carry the planted foot with the body. The foot IK pins the ankle to
      // this world point, so translating the hips without it stretches the leg
      // and the athlete skates. A separation step is footwork; it should move
      // the foot. (The footstep event has already been emitted at the original
      // plant, so the turf scuff and the audio are unaffected.)
      p.foot.pos.x += sx[i];
      p.foot.pos.z += sz[i];
    }
    // `reseat()` in resolveCollisions puts every moved body back on the
    // surface once both passes are done.
  }

  /**
   * Hard contact with momentum transfer. Position correction adds no energy
   * (so resting contacts do not jitter) and the normal impulse only fires on
   * approach. Hard contact stumbles the player who was less braced.
   */
  private resolveContacts(dt: number, list: LocoPlayer[]): void {
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        if (Math.abs(a.pos.y - b.pos.y) > COLLIDE_Y_SPAN) continue;

        let dx = b.pos.x - a.pos.x;
        let dz = b.pos.z - a.pos.z;
        let dist = Math.hypot(dx, dz);
        const rsum = a.radius + b.radius;
        if (dist >= rsum) continue;

        if (dist < 1e-4) {
          // Perfectly coincident — pick a deterministic axis.
          const ang = this.rng.next() * Math.PI * 2;
          dx = Math.cos(ang); dz = Math.sin(ang); dist = 1e-4;
        }
        const nx = dx / dist, nz = dz / dist;
        const pen = rsum - dist;

        const invA = this.invMass(a);
        const invB = this.invMass(b);
        const invSum = invA + invB;
        if (invSum <= 0) continue;

        // --- positional correction (no velocity change => no jitter)
        const corr = Math.max(0, pen - COLLIDE_SLOP) * COLLIDE_BETA;
        a.pos.x -= nx * corr * (invA / invSum);
        a.pos.z -= nz * corr * (invA / invSum);
        b.pos.x += nx * corr * (invB / invSum);
        b.pos.z += nz * corr * (invB / invSum);

        // --- normal impulse, only when closing
        const rvx = b.vel.x - a.vel.x;
        const rvz = b.vel.z - a.vel.z;
        const vn = rvx * nx + rvz * nz;
        if (vn >= 0) continue;

        const jn = (-(1 + COLLIDE_RESTITUTION) * vn) / invSum;
        a.vel.x -= nx * jn * invA;
        a.vel.z -= nz * jn * invA;
        b.vel.x += nx * jn * invB;
        b.vel.z += nz * jn * invB;

        // --- tangential friction (shoulders scrape past each other)
        const tx = -nz, tz = nx;
        const vt = rvx * tx + rvz * tz;
        const jt = clamp((-vt / invSum) * COLLIDE_FRICTION, -jn * 0.8, jn * 0.8);
        a.vel.x -= tx * jt * invA;
        a.vel.z -= tz * jt * invA;
        b.vel.x += tx * jt * invB;
        b.vel.z += tz * jt * invB;

        this.contactReaction(a, b, -vn, nx, nz, dt);
      }
    }
  }

  private invMass(p: LocoPlayer): number {
    /**
     * A THROWER ON HIS PIVOT IS IMMOVABLE, because the alternative is not
     * physics — it is a foul.
     *
     * `anchored` already makes the separation tier yield him no ground, but
     * hard contact split its positional correction by inverse mass, so the
     * marker standing on him pushed him off his pivot a few centimetres at a
     * time. That is the limit cycle the travel work could not explain: the
     * inward pull genuinely converged (traced at 2.17 -> 1.85 -> 1.54 -> 1.23 m)
     * and then contact shoved the body back out and it started over. Ablating
     * separation changed nothing because separation was never the tier doing
     * the shoving.
     *
     * Infinite mass here means the marker takes the whole correction, which is
     * both the correct resolution and the correct call: a defender who displaces
     * the thrower has fouled him.
     */
    if (p.anchored) return 0;
    // Bracing and being on the ground both make you harder to move.
    const str = clamp01(p.attr.strength / 100);
    const eff = p.attr.mass * (1 + 0.35 * str) * (p.prone ? 2.5 : 1);
    return 1 / Math.max(1, eff);
  }

  /** Stumbles, falls and the foul call. Ultimate is non-contact. */
  private contactReaction(a: LocoPlayer, b: LocoPlayer, impact: number, nx: number, nz: number, _dt: number): void {
    if (impact < 0.8) return;

    const closeA = a.vel.x * nx + a.vel.z * nz;
    const closeB = -(b.vel.x * nx + b.vel.z * nz);
    const foulOn = closeA >= closeB ? a.id : b.id;
    const chance = clamp01((impact - 1.6) / 5.0);
    const called = this.rng.next() < chance;

    this.emit('player:contact', {
      a: a.id, b: b.id, impact, foulOn, called,
    });

    this.maybeStumble(a, impact * (b.attr.mass / a.attr.mass));
    this.maybeStumble(b, impact * (a.attr.mass / b.attr.mass));
  }

  private maybeStumble(p: LocoPlayer, impact: number): void {
    if (COMMITTED_STATES.has(p.state)) return;
    const bal = clamp01(p.attr.balance / 100);
    const str = clamp01(p.attr.strength / 100);
    const resist = 2.0 + 2.5 * bal + 1.5 * str;
    if (impact <= resist) return;
    if (impact > resist * 1.9) {
      p.prone = true;
      this.enter(p, 'fall', clamp(0.25 + 0.05 * impact, 0.25, 0.6));
      return;
    }
    const dur = clamp(0.25 + 0.18 * (impact - resist), 0.25, 0.90);
    if (p.state === 'stumble' && p.stateDur >= dur) return;
    this.enter(p, 'stumble', dur);
  }

  /* ---------------------------------------------------------------- utils */

  private enter(p: LocoPlayer, state: LocoStateName, dur: number): void {
    p.state = state;
    p.stateT = 0;
    p.stateDur = dur;
  }

  private emitFootstep(
    p: LocoPlayer, foot: 'L' | 'R', x: number, y: number, z: number, speed: number, hard: boolean,
  ): void {
    p.lastStepT = p.t;
    this.emit('player:footstep', {
      id: p.id,
      pos: V3A.set(x, y, z).clone(),
      foot,
      speed,
      hard,
    });
  }

  private emit(evt: string, payload: unknown): void {
    this.host?.events?.emit(evt, payload);
  }
}

export { PRONE_Y };
export type {
  Attributes, DesiredMove, LocoPlayer, LocoStateName, MoveMode,
} from './move/Types.ts';
export type { ContestResult } from './move/Contest.ts';
export { DEFAULT_ATTRS, UNAVAILABLE_STATES, COMMITTED_STATES } from './move/Types.ts';
export { derive, leapHeight, takeoffVy, modeCapFraction } from './move/Attributes.ts';
export { PERSONAL_RADIUS, SEP_RATE, compliance } from './move/Separation.ts';
