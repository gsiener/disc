/**
 * AI.ts — 7v7 team intelligence for ultimate frisbee.
 *
 * One `TeamAI` per team. Each fixed step it is handed the whole world and
 * returns a `PlayerIntent` for each of its seven players. It decides *what a
 * player wants to do*; it never integrates motion and never touches the scene.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT WITH src/sim/Locomotion.ts
 * ---------------------------------------------------------------------------
 * Each fixed 1/120 s step the game system does:
 *
 *     const intents = [...updateTeam(a, world, dt), ...updateTeam(b, world, dt)];
 *     locomotion.apply(intents, world, dt);
 *
 * Locomotion MUST:
 *   - steer each player toward `(targetX, targetZ)` at up to `desiredSpeed`,
 *     never exceeding `maxSpeed`, `maxAccel`, `maxDecel` or `turnRate`;
 *   - decelerate inside `arriveRadius` so the player settles instead of
 *     orbiting the target;
 *   - apply soft separation inside `personalSpace` (AI already spaces the
 *     formation; this is only anti-interpenetration);
 *   - write back `player.pos` and `player.vel` (AI reads both next step);
 *   - use `mode` to pick locomotion style / animation. `plant`, `pivot`,
 *     `throw`, `catch`, `jump`, `layout` and `mark` are *poses*: honour
 *     `desiredSpeed` (often 0) and do not path away from the target.
 *   - treat `action` as a one-shot event for that step and hand it to the disc
 *     / game system. AI re-emits `throw` only once per time the disc is held.
 *
 * Two guarantees depend on locomotion honouring the caps:
 *   - nobody leaves the field. AI already caps `desiredSpeed`/`maxSpeed` to
 *     sqrt(2 * maxDecel * room) over the room left to the perimeter in both the
 *     target and velocity directions, so honouring `maxDecel` is sufficient.
 *   - the marker never enters disc space. AI caps closing speed to
 *     sqrt(2 * maxDecel * distanceToTarget) for `mark`/`shuffle` and for the
 *     in-flight disc chase; `arriveRadius` is widened to match.
 *
 * `debug` is telemetry only (role, cut state, lane, and the committed cut's
 * target point) — ignore it, or draw it when `ctx.debug` is set.
 *
 * Locomotion MAY expose these on `ctx.sys.locomotion`; AI uses them if present
 * and falls back to its own kinematic estimate if not:
 *
 *     timeToReach(player, x, z): number   // seconds, includes turn cost
 *     isAirborne(player): boolean
 *
 * The disc system MAY expose:
 *
 *     ctx.sys.disc.predictPath(state, horizonSeconds, stepSeconds)
 *         -> Array<{ t, x, y, z }>          // t is seconds FROM NOW
 *
 * AI uses it for lane blockage and in-flight reads. The first call is
 * validated against that shape and a peer that does not match (or throws) is
 * disabled permanently; the AI then falls back to its own glide integrator.
 * Same for `locomotion.timeToReach`. Nothing here is required to be present.
 *
 * ---------------------------------------------------------------------------
 * Determinism: no `Math.random`. All randomness comes from the `RandomSource`
 * handed to `createTeamAI` (pass `ctx.rand.fork(seed)`).
 */

import {
  FIELD, PLAY, type Vec2, type Vec3, type Sign, type AttackDir, type Handedness,
  type Force, type FormationName, type CutKind, type LaneKey, type Station,
  type ZoneRole, type CutRoute, type RandomSource,
  clamp, lerp, smoothstep, dist2, sigmoid, clampToField, yardsToGoal,
  inAttackEndzone, openSideSign, breakSideSign, releaseSideType,
  formationStations, chooseFormation, buildCut,
  markPoint, zoneStations, shouldPlayZone,
} from './Playbook.ts';

export type { Vec2, Vec3, AttackDir, Force, FormationName, LaneKey } from './Playbook.ts';

/* =========================================================== player model */

export type ThrowType = 'backhand' | 'forehand' | 'hammer' | 'scoober' | 'push';

export const THROW_TYPES: readonly ThrowType[] =
  ['backhand', 'forehand', 'hammer', 'scoober', 'push'];

/** Every rating is 0..100 and every one of them changes behaviour. */
export interface Attributes {
  /** Top-end sprint speed. */
  speed: number;
  /** How fast top-end is reached; also how hard a plant can be. */
  acceleration: number;
  /** Change of direction — turn rate, cut sharpness, layout extension. */
  agility: number;
  jumping: number;
  catching: number;
  /** Per-throw release accuracy. */
  throwAccuracy: Record<ThrowType, number>;
  /** Maximum range. */
  throwPower: number;
  /** Reads the field, values options correctly, does not force it. */
  decision: number;
  /** Resistance to fatigue. */
  stamina: number;
  /** Positioning, reading the disc in flight, poach timing. */
  defAwareness: number;
}

export type Archetype = 'handler' | 'cutter' | 'deep' | 'utility';

export interface AIPlayer {
  id: number;
  team: 0 | 1;
  /** Written by locomotion, read by AI. */
  pos: Vec3;
  vel: Vec3;
  attr: Attributes;
  handed: Handedness;
  archetype: Archetype;
  /** 0..1 fatigue pool. Owned by AI (see `tickStamina`). */
  energy: number;
  /** Assigned by AI at the start of each possession. */
  role: 'handler' | 'cutter';
  /** Optional, set by locomotion. */
  airborne?: boolean;
}

/* ============================================================ world model */

export type DiscPhase = 'held' | 'flight' | 'ground' | 'pull';
export type GamePhase = 'setup' | 'pull' | 'live' | 'dead';

export interface DiscState {
  pos: Vec3;
  vel: Vec3;
  state: DiscPhase;
  /** Player currently holding it, else null. */
  carrier: number | null;
  thrownBy: number | null;
  intendedReceiver: number | null;
  /** 0..10, maintained by the game system from the marker's `stall` action. */
  stall: number;
  spin: number;
  throwType: ThrowType | null;
}

export interface AIWorld {
  time: number;
  players: AIPlayer[];
  disc: DiscState;
  /** Which team is on offence right now. */
  possession: 0 | 1;
  phase: GamePhase;
  /** Wind velocity in m/s, field-space. */
  wind: Vec2;
  score: [number, number];
  scoreCap: number;
  rand: RandomSource;
  /** `ctx.sys`. Read defensively — every peer is optional. */
  sys?: Record<string, unknown>;
}

/* ================================================================ intents */

export type MoveMode =
  | 'idle' | 'jog' | 'sprint' | 'backpedal' | 'shuffle'
  | 'plant' | 'pivot' | 'throw' | 'catch' | 'jump' | 'layout' | 'mark';

export type PlayerAction =
  | {
    kind: 'throw'; throwType: ThrowType;
    /** Where the disc is aimed, INCLUDING the thrower's error. */
    aimX: number; aimY: number; aimZ: number;
    /** Release speed (m/s) and the flight time the thrower intends. */
    speed: number; flightTime: number; spin: number;
    receiverId: number;
    /** The thrower's own estimate of completion, 0..1. Telemetry / commentary. */
    expected: number;
  }
  | { kind: 'catch'; difficulty: number }
  | { kind: 'bid'; x: number; z: number; extend: number }
  | { kind: 'jump'; height: number }
  | { kind: 'stall'; count: number }
  | { kind: 'pickup' }
  | { kind: 'fake'; throwType: ThrowType };

export interface PlayerIntent {
  id: number;
  team: 0 | 1;
  targetX: number;
  targetZ: number;
  /** Unit-ish (x,z) the torso should face. */
  faceX: number;
  faceZ: number;
  mode: MoveMode;
  /** 0..1 fraction of `maxSpeed` wanted right now. */
  effort: number;
  /** m/s — `maxSpeed * effort`, precomputed for locomotion. */
  desiredSpeed: number;
  maxSpeed: number;
  maxAccel: number;
  maxDecel: number;
  /** rad/s */
  turnRate: number;
  arriveRadius: number;
  personalSpace: number;
  action: PlayerAction | null;
  /** Telemetry only; locomotion should ignore it. */
  debug: {
    role: string; state: string; lane: LaneKey | null;
    /** The point the committed cut is attacking, if any. */
    cutX: number; cutZ: number;
  };
}

/* ============================================================ system peers */

export interface FlightSample { t: number; x: number; y: number; z: number }

export interface LocomotionPeer {
  timeToReach?(p: AIPlayer, x: number, z: number): number;
  isAirborne?(p: AIPlayer): boolean;
}

export interface DiscPeer {
  predictPath?(state: DiscState, horizon: number, step: number): FlightSample[];
}

function locoPeer(sys: Record<string, unknown> | undefined): LocomotionPeer | null {
  const s = sys?.['locomotion'] as LocomotionPeer | undefined;
  return s && typeof s.timeToReach === 'function' ? s : null;
}

/**
 * The disc peer is *probed*, not trusted. A sibling module may expose a
 * `predictPath` with a different signature entirely; calling it blind would
 * feed it nonsense and get NaN back. So the first call is validated against the
 * shape documented above, and a peer that fails is disabled for good — the AI
 * then uses its own glide integrator, which is accurate to well under a metre
 * over a typical flight.
 */
const DISC_PEER_OK = new WeakMap<object, boolean>();

function validFlightSamples(v: unknown): v is FlightSample[] {
  if (!Array.isArray(v) || v.length < 2) return false;
  const a = v[0] as Partial<FlightSample> | undefined;
  return !!a && Number.isFinite(a.t) && Number.isFinite(a.x)
    && Number.isFinite(a.y) && Number.isFinite(a.z);
}

function discPeer(sys: Record<string, unknown> | undefined): DiscPeer | null {
  const s = sys?.['disc'] as DiscPeer | undefined;
  if (!s || typeof s.predictPath !== 'function') return null;
  const known = DISC_PEER_OK.get(s as object);
  if (known === false) return null;
  return s;
}

/* ==================================================== derived athleticism */

export const baseMaxSpeed = (a: Attributes): number => 5.7 + 3.3 * (a.speed / 100);

export function effectiveMaxSpeed(p: AIPlayer): number {
  return baseMaxSpeed(p.attr) * (0.80 + 0.20 * p.energy);
}
export function effectiveAccel(p: AIPlayer): number {
  return (4.2 + 4.8 * (p.attr.acceleration / 100)) * (0.82 + 0.18 * p.energy);
}
export function effectiveDecel(p: AIPlayer): number {
  return (6.0 + 6.5 * (p.attr.agility / 100)) * (0.85 + 0.15 * p.energy);
}
export function turnRateOf(p: AIPlayer): number {
  return 4.2 + 5.4 * (p.attr.agility / 100);
}
/** Highest point a standing/jumping catch can be made. */
export function reachHeight(p: AIPlayer): number {
  return 2.02 + 0.88 * (p.attr.jumping / 100);
}
/** Extra metres a full-extension layout buys. */
export function layoutExtend(p: AIPlayer): number {
  return 0.85 + 0.95 * (p.attr.agility / 100) + 0.35 * (p.attr.jumping / 100);
}
export function effectiveDecision(p: AIPlayer): number {
  return p.attr.decision * (0.80 + 0.20 * p.energy);
}

/**
 * Rough probability a possession starting `yards` from the goal line ends in a
 * score. This is the currency the thrower's decision model trades in: every
 * option — a 40 m score-throw, a 5 m dump — is priced as a change in it, and a
 * turnover is charged exactly what it costs, the disc.
 */
export function possessionValue(yards: number): number {
  return 0.40 + 0.42 * (1 - clamp(yards, 0, 64) / 64);
}

/** Max range in metres for a throw type, including the wind along the throw. */
export function maxThrowRange(p: AIPlayer, type: ThrowType, windAlong: number): number {
  const typeFactor: Record<ThrowType, number> = {
    backhand: 1.0, forehand: 0.93, hammer: 0.58, scoober: 0.42, push: 0.30,
  };
  const base = (21 + 36 * (p.attr.throwPower / 100)) * typeFactor[type];
  return base * (1 + 0.045 * clamp(windAlong, -8, 8)) * (0.86 + 0.14 * p.energy);
}

/** Seconds of flight the thrower will put on a throw of length `d`. */
export function throwFlightTime(p: AIPlayer, type: ThrowType, d: number): number {
  const zip = 10.5 + 7.5 * (p.attr.throwPower / 100) * (type === 'hammer' ? 0.8 : 1);
  return 0.28 + d / zip;
}

/**
 * Probability a player completes the catch. `difficulty` 0 = a chest-high disc
 * standing still; 1.5 = a full-extension contested grab.
 */
export function catchProbability(p: AIPlayer, difficulty: number): number {
  const base = 0.952 + 0.045 * (p.attr.catching / 100);
  const fatigue = 0.96 + 0.04 * p.energy;
  const skill = 0.55 + 0.45 * (1 - p.attr.catching / 100);
  return clamp(base * fatigue - 0.38 * skill * clamp(difficulty, 0, 1.8), 0.18, 0.995);
}

/** Fatigue integration. Call once per fixed step per player you own. */
export function tickStamina(p: AIPlayer, dt: number): void {
  const vmax = Math.max(1e-3, effectiveMaxSpeed(p));
  const load = clamp(Math.hypot(p.vel.x, p.vel.z) / vmax, 0, 1.2);
  const endurance = 0.35 + 0.65 * (p.attr.stamina / 100);
  if (load > 0.42) {
    p.energy -= dt * (0.017 * load * load) / endurance;
  } else {
    p.energy += dt * 0.034 * endurance * (1 - load);
  }
  p.energy = clamp(p.energy, 0.12, 1);
}

/**
 * Distance from (px,pz) to the playing-surface perimeter along (dx,dz).
 * Locomotion uses the resulting speed cap to guarantee nobody is steered over
 * a line: a player is never asked to run faster than he can stop in.
 */
export function boundaryRoom(px: number, pz: number, dx: number, dz: number): number {
  const l = Math.hypot(dx, dz);
  if (l < 1e-5) return 1e3;
  const ux = dx / l, uz = dz / l;
  const bx = FIELD.halfWidth - 0.55;
  const bz = FIELD.halfLength - 0.55;
  let t = 1e3;
  if (ux > 1e-6) t = Math.min(t, (bx - px) / ux);
  else if (ux < -1e-6) t = Math.min(t, (-bx - px) / ux);
  if (uz > 1e-6) t = Math.min(t, (bz - pz) / uz);
  else if (uz < -1e-6) t = Math.min(t, (-bz - pz) / uz);
  return Math.max(0, t);
}

/* ================================================== attribute generation */

const ARCH_BIAS: Record<Archetype, Partial<Record<keyof Attributes, number>>> = {
  handler: { speed: -6, acceleration: 2, agility: 8, throwPower: 10, decision: 12, catching: 6, jumping: -6 },
  cutter: { speed: 6, acceleration: 6, agility: 4, catching: 4, throwPower: -6, decision: -2 },
  deep: { speed: 12, acceleration: 4, jumping: 12, catching: 2, throwPower: -10, decision: -6, agility: -2 },
  utility: { speed: 2, agility: 2, defAwareness: 6, stamina: 6 },
};

/** Deterministic rating profile. `overall` ~ 55..90 shifts the whole sheet. */
export function makeAttributes(
  rng: RandomSource, archetype: Archetype, overall = 72,
): Attributes {
  const bias = ARCH_BIAS[archetype];
  const roll = (k: keyof Attributes, spread = 9): number =>
    clamp(overall + (bias[k] ?? 0) + rng.gauss() * spread, 28, 99);

  const throwBase = roll('throwPower', 8);
  const handBonus = archetype === 'handler' ? 8 : archetype === 'deep' ? -10 : 0;
  const acc = (t: ThrowType, penalty: number): number =>
    clamp(overall + handBonus - penalty + rng.gauss() * 8, 25, 99);

  return {
    speed: roll('speed'),
    acceleration: roll('acceleration'),
    agility: roll('agility'),
    jumping: roll('jumping'),
    catching: roll('catching', 7),
    throwPower: throwBase,
    throwAccuracy: {
      backhand: acc('backhand', 0),
      forehand: acc('forehand', 6),
      hammer: acc('hammer', 20),
      scoober: acc('scoober', 26),
      push: acc('push', 2),
    },
    decision: roll('decision', 10),
    stamina: roll('stamina', 9),
    defAwareness: roll('defAwareness', 10),
  };
}

export function makePlayer(
  id: number, team: 0 | 1, archetype: Archetype, rng: RandomSource, overall = 72,
): AIPlayer {
  return {
    id, team,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    attr: makeAttributes(rng, archetype, overall),
    handed: rng.next() < 0.86 ? 'right' : 'left',
    archetype,
    energy: 1,
    role: archetype === 'handler' ? 'handler' : 'cutter',
  };
}

/* ============================================================ team config */

export interface TeamConfig {
  /** Base offensive look. */
  formation: FormationName;
  /** Base defensive call. */
  force: Force;
  /** -0.4..0.4 — how much this team likes zone regardless of conditions. */
  zoneBias: number;
  /** 0.6 (conservative) .. 1.6 (gunner) — scales willingness to take risk. */
  aggression: number;
  /** Deterministic seed salt. */
  seed: number;
}

export const DEFAULT_TEAM_CONFIG: TeamConfig = {
  formation: 'vertical', force: 'forehand', zoneBias: -0.15, aggression: 1.0, seed: 1,
};

/* ============================================================ internal mem */

type CutState = 'stack' | 'setup' | 'plant' | 'break' | 'clear';

interface Mem {
  id: number;
  /* offence */
  cut: CutRoute | null;
  cutState: CutState;
  cutT: number;
  cutCooldown: number;
  /* defence */
  poach: number;
  poachHold: number;
  switchCd: number;
  /** Lagged perception of the matchup — this is what defensive reaction is. */
  seenX: number;
  seenZ: number;
  seenOf: number;
  flightCommit: number;     // flight epoch this player has committed to
  bidCommit: boolean;
  /* shared */
  faceX: number;
  faceZ: number;
}

interface ThrowOption {
  receiverId: number;
  type: ThrowType;
  aim: Vec3;
  dist: number;
  flightTime: number;
  separation: number;
  blockage: number;
  breakPenalty: number;
  powerRatio: number;
  completion: number;
  value: number;
  ev: number;
  isGoal: boolean;
  isReset: boolean;
}

/* ================================================================ TeamAI */

export class TeamAI {
  readonly team: 0 | 1;
  readonly dir: AttackDir;
  readonly cfg: TeamConfig;
  private rng: RandomSource;

  /* possession bookkeeping */
  private lastPossession: number = -1;
  private lastPhase: GamePhase | '' = '';
  private lastCarrier: number | null = null;
  private markedCarrier: number | null = null;
  private lastDiscState: DiscPhase | '' = '';
  private flightEpoch = 0;
  private possessionEpoch = 0;

  /* offence */
  private formation: FormationName = 'vertical';
  private anchor: Vec2 = { x: 0, z: 0 };
  private stackOrder: number[] = [];
  private handlerRing: number[] = [];
  private handlerStation = new Map<number, number>();
  private liveLanes = new Map<LaneKey, number>();
  private lastCutStart = -99;
  private decisionTimer = 0;
  private choice: ThrowOption | null = null;
  private windup = 0;
  private threwThisPossession = false;
  private throwCooldown = 0;
  private noGoodLook = false;
  /** Smoothed read of which side the mark is giving up. */
  private openRead = 0;

  /* defence */
  private scheme: 'person' | 'zone' = 'person';
  force: Force;
  private matchup = new Map<number, number>();   // defenderId -> offenceId
  private zoneRole = new Map<number, ZoneRole>();
  private stallClock = 0;
  private markerId = -1;
  private deepHelpId = -1;

  /* scratch, refreshed per update */
  private mates: AIPlayer[] = [];
  private foes: AIPlayer[] = [];
  private mem = new Map<number, Mem>();
  private byId = new Map<number, AIPlayer>();

  constructor(team: 0 | 1, dir: AttackDir, rng: RandomSource, cfg?: Partial<TeamConfig>) {
    this.team = team;
    this.dir = dir;
    this.cfg = { ...DEFAULT_TEAM_CONFIG, ...cfg };
    this.rng = rng.fork(this.cfg.seed * 7919 + team * 104729 + 17);
    this.formation = this.cfg.formation;
    this.force = this.cfg.force;
    this.openRead = openSideSign(this.force, dir);
  }

  /** Current stall count the marker has reached (0 when not marking). */
  get stall(): number { return this.stallClock; }
  get currentScheme(): 'person' | 'zone' { return this.scheme; }
  get currentFormation(): FormationName { return this.formation; }
  /** X sign of the open side, as this team currently understands it. */
  get openSign(): Sign { return this.openRead >= 0 ? 1 : -1; }
  /** Telemetry: id of the player currently marking the disc, or -1. */
  get marker(): number { return this.markerId; }
  /** Telemetry: who a defender is assigned to. null in zone / unassigned. */
  matchupOf(defenderId: number): number | null {
    return this.matchup.get(defenderId) ?? null;
  }
  /** Telemetry: this defender's zone responsibility, or null in person. */
  zoneRoleOf(defenderId: number): ZoneRole | null {
    return this.zoneRole.get(defenderId) ?? null;
  }

  /* ------------------------------------------------------------- update */

  update(world: AIWorld, dt: number): PlayerIntent[] {
    this.refresh(world);

    for (const p of this.mates) tickStamina(p, dt);

    // Flight epoch: bump whenever the disc leaves a hand.
    if (world.disc.state === 'flight' && this.lastDiscState !== 'flight') this.flightEpoch++;
    this.lastDiscState = world.disc.state;

    // A throw is emitted exactly once per time the disc is in a hand.
    if (world.disc.state !== 'held') {
      this.threwThisPossession = false;
      this.choice = null;
      this.windup = 0;
    }
    // The stall clock belongs to the disc, not the marker: it resets whenever
    // a different player picks it up.
    if (world.disc.carrier !== this.markedCarrier) {
      this.markedCarrier = world.disc.carrier;
      this.stallClock = 0;
    }

    const possessionChanged = world.possession !== this.lastPossession;
    const phaseChanged = world.phase !== this.lastPhase;
    if (possessionChanged || phaseChanged) {
      this.onPossessionChange(world);
      this.lastPossession = world.possession;
      this.lastPhase = world.phase;
    }

    for (const m of this.mem.values()) {
      m.cutCooldown = Math.max(0, m.cutCooldown - dt);
      m.switchCd = Math.max(0, m.switchCd - dt);
    }

    if (world.phase === 'setup' || world.phase === 'pull' || world.phase === 'dead') {
      return this.lineUp(world, dt);
    }
    return world.possession === this.team
      ? this.offence(world, dt)
      : this.defence(world, dt);
  }

  /* --------------------------------------------------------- bookkeeping */

  private refresh(world: AIWorld): void {
    this.sysRef = world.sys;
    this.mates.length = 0;
    this.foes.length = 0;
    this.byId.clear();
    for (const p of world.players) {
      this.byId.set(p.id, p);
      if (p.team === this.team) this.mates.push(p); else this.foes.push(p);
    }
    for (const p of this.mates) {
      if (!this.mem.has(p.id)) {
        this.mem.set(p.id, {
          id: p.id, cut: null, cutState: 'stack', cutT: 0, cutCooldown: 0,
          poach: 0, poachHold: 0, switchCd: 0, flightCommit: -1, bidCommit: false,
          seenX: p.pos.x, seenZ: p.pos.z, seenOf: -1,
          faceX: 0, faceZ: this.dir,
        });
      }
    }
  }

  private m(id: number): Mem {
    let v = this.mem.get(id);
    if (!v) {
      v = {
        id, cut: null, cutState: 'stack', cutT: 0, cutCooldown: 0,
        poach: 0, poachHold: 0, switchCd: 0, flightCommit: -1, bidCommit: false,
        seenX: 0, seenZ: 0, seenOf: -1,
        faceX: 0, faceZ: this.dir,
      };
      this.mem.set(id, v);
    }
    return v;
  }

  /** Re-form after a turnover, a score or the start of a point. */
  private onPossessionChange(world: AIWorld): void {
    this.possessionEpoch++;
    this.liveLanes.clear();
    this.choice = null;
    this.windup = 0;
    this.threwThisPossession = false;
    this.stallClock = 0;
    this.lastCarrier = null;
    this.lastCutStart = -99;
    for (const m of this.mem.values()) {
      m.cut = null; m.cutState = 'stack'; m.cutT = 0; m.cutCooldown = 0;
      m.poach = 0; m.poachHold = 0; m.bidCommit = false; m.flightCommit = -1;
    }
    this.anchor.x = world.disc.pos.x;
    this.anchor.z = world.disc.pos.z;

    // Roles: the three best decision-makers with hands become handlers.
    const ranked = this.mates.slice().sort((a, b) => {
      const s = (p: AIPlayer) =>
        p.attr.decision * 1.0 + p.attr.throwAccuracy.backhand * 0.5 +
        p.attr.throwAccuracy.forehand * 0.5 + p.attr.throwPower * 0.25 +
        (p.archetype === 'handler' ? 60 : 0) - p.id * 1e-4;
      return s(b) - s(a);
    });
    this.handlerRing = ranked.slice(0, 3).map((p) => p.id);
    const cutters = ranked.slice(3);
    for (const p of ranked) p.role = this.handlerRing.includes(p.id) ? 'handler' : 'cutter';

    // Stack order: front of the stack is whoever is closest to the disc.
    const d = world.disc.pos;
    this.stackOrder = cutters
      .slice()
      .sort((a, b) =>
        (dist2(a.pos.x, a.pos.z, d.x, d.z) - dist2(b.pos.x, b.pos.z, d.x, d.z)) || (a.id - b.id))
      .map((p) => p.id);

    this.handlerStation.clear();
    this.assignHandlerStations(world);

    if (world.possession !== this.team) {
      this.pickScheme(world);
      this.assignMatchups(world);
    }
  }

  /* =========================================================== line up */

  /** Pre-pull: everyone on their own goal line, ready to go. */
  private lineUp(world: AIWorld, dt: number): PlayerIntent[] {
    const out: PlayerIntent[] = [];
    const goalZ = -this.dir * FIELD.goalLine;
    const n = this.mates.length || 1;
    const sorted = this.mates.slice().sort((a, b) => a.id - b.id);
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const t = n === 1 ? 0.5 : i / (n - 1);
      const x = lerp(-FIELD.halfWidth + 3.5, FIELD.halfWidth - 3.5, t);
      const face = world.possession === this.team ? this.dir : -this.dir;
      out.push(this.intent(p, x, goalZ + this.dir * 0.4, 0, face, 'jog', 0.42, null, {
        role: p.role, state: 'lineup', lane: null,
      }, dt));
    }
    return out;
  }

  /* ============================================================= OFFENCE */

  private offence(world: AIWorld, dt: number): PlayerIntent[] {
    const disc = world.disc;
    const dir = this.dir;
    const out: PlayerIntent[] = [];

    // Disc on the ground: nearest player picks it up, the rest re-form.
    if (disc.state === 'ground') {
      let best: AIPlayer | null = null; let bd = 1e9;
      for (const p of this.mates) {
        const d = dist2(p.pos.x, p.pos.z, disc.pos.x, disc.pos.z);
        if (d < bd) { bd = d; best = p; }
      }
      for (const p of this.mates) {
        if (p === best) {
          out.push(this.intent(p, disc.pos.x, disc.pos.z, 0, dir, 'sprint', 1.0,
            bd < 1.1 ? { kind: 'pickup' } : null, { role: p.role, state: 'pickup', lane: null }, dt));
        } else {
          const st = this.stationFor(p, world, disc.pos.x, disc.pos.z);
          out.push(this.intent(p, st.x, st.z, 0, dir, 'jog', 0.55, null,
            { role: p.role, state: 'reform', lane: null }, dt));
        }
      }
      return out;
    }

    // Smooth the formation anchor so the stack does not snap on every catch.
    const k = Math.min(1, dt * 4.0);
    this.anchor.x += (disc.pos.x - this.anchor.x) * k;
    this.anchor.z += (disc.pos.z - this.anchor.z) * k;

    this.readForce(world);
    const openSign = this.openSign;
    const windSpeed = Math.hypot(world.wind.x, world.wind.z);
    const form = chooseFormation(this.anchor, dir, this.cfg.formation, windSpeed);
    if (form !== this.formation) {
      this.formation = form;
      this.assignHandlerStations(world);
    }

    if (disc.state === 'flight') return this.offenceInFlight(world, dt);

    const thrower = disc.carrier != null ? this.byId.get(disc.carrier) ?? null : null;
    if (thrower && thrower.id !== this.lastCarrier) {
      this.lastCarrier = thrower.id;
      this.threwThisPossession = false;
      this.choice = null;
      this.windup = 0;
      this.assignHandlerStations(world);
    }

    this.tickCutters(world, dt, thrower);
    this.tickHandlerCuts(world, dt, thrower);

    // Thrower decision at 8 Hz, held between ticks so the choice does not flicker.
    let throwAction: PlayerAction | null = null;
    if (thrower) {
      this.decisionTimer -= dt;
      if (this.decisionTimer <= 0) {
        this.decisionTimer = 0.125;
        this.decide(world, thrower);
      }
      this.throwCooldown = Math.max(0, this.throwCooldown - dt);
      // A released throw that the game system never consumed must not deadlock
      // the thrower: the guard expires, it does not latch.
      if (this.threwThisPossession && this.throwCooldown === 0) {
        this.threwThisPossession = false;
      }
      if (this.choice) {
        this.windup += dt;
        const releaseAt = 0.20 + 0.12 * (1 - thrower.attr.throwPower / 100);
        if (this.windup >= releaseAt && !this.threwThisPossession) {
          throwAction = this.release(world, thrower, this.choice);
          this.threwThisPossession = true;
          this.throwCooldown = 0.5;
          this.choice = null;
        }
      } else {
        this.windup = 0;
      }
    }

    for (const p of this.mates) {
      if (thrower && p.id === thrower.id) {
        const aim = this.choice?.aim;
        const fx = aim ? aim.x - p.pos.x : 0;
        const fz = aim ? aim.z - p.pos.z : dir;
        out.push(this.intent(p, p.pos.x, p.pos.z, fx, fz,
          throwAction ? 'throw' : this.choice ? 'throw' : 'pivot', 0,
          throwAction, { role: 'thrower', state: this.choice ? 'windup' : 'pivot', lane: null }, dt));
        continue;
      }
      out.push(this.cutterIntent(p, world, dt));
    }
    return out;
  }

  /** Infer the force from where the mark is actually standing. */
  private readForce(world: AIWorld): void {
    const disc = world.disc;
    if (disc.carrier == null) return;
    const t = this.byId.get(disc.carrier);
    if (!t) return;
    let markX = 0; let bd = 3.6;
    for (const f of this.foes) {
      const d = dist2(f.pos.x, f.pos.z, t.pos.x, t.pos.z);
      if (d < bd) { bd = d; markX = f.pos.x - t.pos.x; }
    }
    if (bd < 3.6 && Math.abs(markX) > 0.25) {
      // The mark stands on the side it is taking away, so open is the other side.
      const observed = -Math.sign(markX);
      this.openRead = clamp(this.openRead * 0.94 + observed * 0.06, -1, 1);
      if (Math.abs(this.openRead) < 0.12) this.openRead = observed * 0.12;
    }
  }

  /* ---------------------------------------------------------- stations */

  private assignHandlerStations(world: AIWorld): void {
    const stations = formationStations(this.formation, this.anchor, this.dir, this.openSign)
      .filter((s) => s.role === 'handler');
    const throwerId = world.disc.carrier;
    const free = stations.slice();
    const ids = this.handlerRing.filter((id) => id !== throwerId && this.byId.has(id));
    this.handlerStation.clear();
    // Greedy nearest-station assignment; recomputed only on reform / thrower change.
    for (const id of ids) {
      const p = this.byId.get(id);
      if (!p || free.length === 0) continue;
      let bi = 0; let bd = 1e9;
      for (let i = 0; i < free.length; i++) {
        const d = dist2(p.pos.x, p.pos.z, free[i].x, free[i].z);
        if (d < bd) { bd = d; bi = i; }
      }
      this.handlerStation.set(id, stations.indexOf(free[bi]));
      free.splice(bi, 1);
    }
  }

  /** Where this player wants to stand when not cutting. */
  private stationFor(p: AIPlayer, world: AIWorld, ax = this.anchor.x, az = this.anchor.z): Vec2 {
    const stations = formationStations(this.formation, { x: ax, z: az }, this.dir, this.openSign);
    const handlers = stations.filter((s) => s.role === 'handler');
    const cutters = stations.filter((s) => s.role === 'cutter');
    if (p.role === 'handler') {
      const idx = this.handlerStation.get(p.id);
      if (idx != null && handlers[idx]) return handlers[idx];
      // Overflow handler (three handlers, two stations): a deep reset, wide on
      // the open side. Never the back of the stack — that is a cutter's spot.
      return clampToField({
        x: ax + this.openSign * 11,
        z: az - this.dir * 9.5,
      });
    }
    const si = this.stackOrder.indexOf(p.id);
    const slot: Station | undefined = cutters[clamp(si < 0 ? cutters.length - 1 : si, 0, cutters.length - 1)];
    return slot ?? { x: ax, z: az };
  }

  /* ------------------------------------------------------------- cutting */

  private liveCutCount(): number {
    let n = 0;
    for (const id of this.stackOrder) {
      const st = this.m(id).cutState;
      if (st === 'setup' || st === 'plant' || st === 'break') n++;
    }
    return n;
  }

  private tickCutters(world: AIWorld, dt: number, thrower: AIPlayer | null): void {
    const disc = { x: world.disc.pos.x, z: world.disc.pos.z };
    const dir = this.dir;

    for (const id of this.stackOrder) {
      const p = this.byId.get(id);
      if (!p) continue;
      const m = this.m(id);
      if (m.cutState === 'stack') continue;
      m.cutT += dt;
      const cut = m.cut;
      if (!cut) { m.cutState = 'stack'; continue; }

      switch (m.cutState) {
        case 'setup': {
          const d = dist2(p.pos.x, p.pos.z, cut.setup.x, cut.setup.z);
          if (m.cutT >= cut.setupTime || d < 0.8) { m.cutState = 'plant'; m.cutT = 0; }
          break;
        }
        case 'plant': {
          if (m.cutT >= PLAY.plantTime) { m.cutState = 'break'; m.cutT = 0; }
          break;
        }
        case 'break': {
          const d = dist2(p.pos.x, p.pos.z, cut.target.x, cut.target.z);
          const dead = !thrower || world.disc.state !== 'held';
          // Keep running while the thrower is winding up to you — bailing out
          // mid-windup is how a cutter turns a good look into a turnover.
          const beingThrownTo = this.choice?.receiverId === id && m.cutT < cut.maxTime + 0.9;
          if (!beingThrownTo && (d < 1.3 || m.cutT >= cut.maxTime || dead)) {
            this.endCut(id, 'clear');
          }
          break;
        }
        case 'clear': {
          const back = this.stationFor(p, world);
          const d = dist2(p.pos.x, p.pos.z, back.x, back.z);
          if (d < 2.2 || m.cutT >= 2.6) {
            m.cutState = 'stack'; m.cutT = 0; m.cut = null;
            m.cutCooldown = 0.55 + 1.0 * (1 - p.attr.stamina / 100) * (1.4 - p.energy);
          }
          break;
        }
      }
    }

    // ------------------------------------------------ initiate a new cut
    if (!thrower || world.disc.state !== 'held') return;
    if (this.liveCutCount() >= PLAY.maxLiveCuts) return;
    if (world.time - this.lastCutStart < PLAY.cutStagger) return;

    const openSign = this.openSign;
    const brk = -openSign as Sign;
    const stall = world.disc.stall;
    let best: { id: number; cut: CutRoute; score: number } | null = null;

    for (let si = 0; si < this.stackOrder.length; si++) {
      const id = this.stackOrder[si];
      const p = this.byId.get(id);
      if (!p) continue;
      const m = this.m(id);
      if (m.cutState !== 'stack' || m.cutCooldown > 0) continue;

      const from: Vec2 = { x: p.pos.x, z: p.pos.z };
      const kinds: Array<{ kind: CutKind; side: Sign }> = [];
      const nStack = this.stackOrder.length;
      const isEndzone = this.formation === 'endzone';
      if (isEndzone) {
        kinds.push({ kind: 'strike', side: openSign }, { kind: 'strike', side: brk });
      } else {
        if (si <= 1) kinds.push({ kind: 'under', side: openSign });
        if (si <= 2) kinds.push({ kind: 'break-under', side: brk });
        if (si >= nStack - 2) kinds.push({ kind: 'deep', side: openSign });
        if (si >= nStack - 2) kinds.push({ kind: 'deep', side: brk });
        if (kinds.length === 0) kinds.push({ kind: 'under', side: openSign });
      }

      for (const kc of kinds) {
        const j = this.rng.next();
        const cut = buildCut(kc.kind, from, disc, dir, openSign, kc.side, j);
        if (this.liveLanes.has(cut.lane)) continue;
        if (!this.laneClearOfLiveTargets(cut)) continue;
        const s = this.scoreCut(p, cut, world, si, stall);
        if (!best || s > best.score) best = { id, cut, score: s };
      }
    }

    if (best && best.score > 0.18) {
      const m = this.m(best.id);
      m.cut = best.cut;
      m.cutState = 'setup';
      m.cutT = 0;
      this.liveLanes.set(best.cut.lane, best.id);
      this.lastCutStart = world.time;
    }
  }

  private laneClearOfLiveTargets(cut: CutRoute): boolean {
    for (const [, id] of this.liveLanes) {
      const other = this.m(id).cut;
      if (!other) continue;
      if (dist2(cut.target.x, cut.target.z, other.target.x, other.target.z) < 6.0) return false;
    }
    return true;
  }

  private endCut(id: number, next: CutState): void {
    const m = this.m(id);
    if (m.cut) {
      const holder = this.liveLanes.get(m.cut.lane);
      if (holder === id) this.liveLanes.delete(m.cut.lane);
    }
    m.cutState = next;
    m.cutT = 0;
    if (next === 'clear') {
      // Rotate to the back of the stack — the real mechanic that keeps the
      // stack from collapsing after a cut.
      const i = this.stackOrder.indexOf(id);
      if (i >= 0) { this.stackOrder.splice(i, 1); this.stackOrder.push(id); }
    }
  }

  /** How good this cut looks, 0..~1.6. Attributes drive most of it. */
  private scoreCut(
    p: AIPlayer, cut: CutRoute, world: AIWorld, stackIndex: number, stall: number,
  ): number {
    const def = this.nearestFoe(p.pos.x, p.pos.z);
    let s = 0.30;

    // Athletic edge over the matched defender.
    if (def) {
      const edge = (p.attr.speed - def.attr.speed) * 0.004
        + (p.attr.acceleration - def.attr.acceleration) * 0.003
        + (p.attr.agility - def.attr.agility) * 0.002;
      s += clamp(edge, -0.30, 0.35);
      // Cutting away from where the defender is standing is worth a lot.
      const dx = cut.target.x - p.pos.x, dz = cut.target.z - p.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      const gx = def.pos.x - p.pos.x, gz = def.pos.z - p.pos.z;
      const gl = Math.hypot(gx, gz) || 1;
      const alignment = (dx / l) * (gx / gl) + (dz / l) * (gz / gl);
      s += -0.22 * alignment;
    }

    // Space: how empty is the target?
    let crowd = 0;
    for (const q of world.players) {
      if (q.id === p.id) continue;
      const d = dist2(q.pos.x, q.pos.z, cut.target.x, cut.target.z);
      if (d < 8) crowd += (8 - d) / 8;
    }
    s -= 0.12 * crowd;

    // Situational weighting.
    const deep = cut.kind === 'deep';
    if (deep) {
      s += 0.16 * this.cfg.aggression;
      s -= 0.30 * smoothstep(3, 8, stall);            // no hucks at stall 8
      s -= 0.35 * smoothstep(30, 12, yardsToGoal(world.disc.pos.z, this.dir));
      s += 0.12 * (p.attr.speed / 100) + 0.08 * (p.attr.jumping / 100);
    } else {
      s += 0.10 * smoothstep(2, 6, stall);
    }
    if (cut.kind === 'break-under') s -= 0.10;
    if (cut.kind === 'strike') s += 0.22;

    // Fatigue and stack discipline.
    s *= (0.72 + 0.28 * p.energy);
    s -= 0.03 * Math.abs(stackIndex - (deep ? this.stackOrder.length - 1 : 0));
    return s;
  }

  /** Handler resets: dump, swing and the up-line when the mark breaks down. */
  private tickHandlerCuts(world: AIWorld, dt: number, thrower: AIPlayer | null): void {
    if (!thrower || world.disc.state !== 'held') return;
    const stall = world.disc.stall;
    const disc = { x: world.disc.pos.x, z: world.disc.pos.z };
    const openSign = this.openSign;

    // Is the mark beaten? Either too far off, or standing on the wrong side.
    let markDist = 99; let markSide = 0;
    for (const f of this.foes) {
      const d = dist2(f.pos.x, f.pos.z, thrower.pos.x, thrower.pos.z);
      if (d < markDist) { markDist = d; markSide = Math.sign(f.pos.x - thrower.pos.x); }
    }
    const markBeaten = markDist > 2.9 || (markSide !== 0 && markSide === openSign);

    for (const id of this.handlerRing) {
      if (id === thrower.id) continue;
      const p = this.byId.get(id);
      if (!p) continue;
      const m = this.m(id);

      if (m.cutState !== 'stack') {
        m.cutT += dt;
        const cut = m.cut;
        if (!cut) { m.cutState = 'stack'; continue; }
        if (m.cutState === 'setup') {
          if (m.cutT >= cut.setupTime || dist2(p.pos.x, p.pos.z, cut.setup.x, cut.setup.z) < 0.7) {
            m.cutState = 'plant'; m.cutT = 0;
          }
        } else if (m.cutState === 'plant') {
          if (m.cutT >= PLAY.plantTime) { m.cutState = 'break'; m.cutT = 0; }
        } else if (m.cutState === 'break') {
          const d = dist2(p.pos.x, p.pos.z, cut.target.x, cut.target.z);
          if (d < 1.2 || m.cutT >= cut.maxTime) { this.endHandlerCut(id); }
        } else if (m.cutState === 'clear') {
          if (m.cutT >= 0.8) { m.cutState = 'stack'; m.cutT = 0; m.cut = null; m.cutCooldown = 0.6; }
        }
        continue;
      }

      if (m.cutCooldown > 0) continue;
      const behind = this.dir * (p.pos.z - world.disc.pos.z) < 1.0;
      const from: Vec2 = { x: p.pos.x, z: p.pos.z };
      let kind: CutKind | null = null;
      let side: Sign = openSign;

      if (behind && (stall >= 5.5 || this.noGoodLook)) {
        kind = 'dump'; side = -openSign as Sign;
      } else if (markBeaten && stall >= 1.2 && stall < 7 && behind) {
        kind = 'up-line'; side = openSign;
      } else if (stall >= 3.5 && stall < 6 && behind && this.rng.next() < 0.02) {
        kind = 'swing'; side = openSign;
      }
      if (!kind) continue;

      const lane: LaneKey = kind === 'dump' ? 'reset-break' : 'reset-open';
      if (this.liveLanes.has(lane)) continue;
      const cut = buildCut(kind, from, disc, this.dir, openSign, side, this.rng.next());
      // Force the reset lane label so downfield cuts never collide with it.
      const forced: CutRoute = { ...cut, lane };
      m.cut = forced;
      m.cutState = 'setup';
      m.cutT = 0;
      this.liveLanes.set(lane, id);
    }
  }

  private endHandlerCut(id: number): void {
    const m = this.m(id);
    if (m.cut) {
      const holder = this.liveLanes.get(m.cut.lane);
      if (holder === id) this.liveLanes.delete(m.cut.lane);
    }
    m.cutState = 'clear';
    m.cutT = 0;
  }

  /** Movement intent for any offensive player who is not the thrower. */
  private cutterIntent(p: AIPlayer, world: AIWorld, dt: number): PlayerIntent {
    const m = this.m(p.id);
    const dir = this.dir;
    const cut = m.cut;
    let tx: number, tz: number, effort: number, mode: MoveMode;
    let state = m.cutState as string;

    switch (m.cutState) {
      case 'setup':
        tx = cut!.setup.x; tz = cut!.setup.z; effort = 0.68; mode = 'jog';
        break;
      case 'plant':
        tx = p.pos.x; tz = p.pos.z; effort = 0.05; mode = 'plant';
        break;
      case 'break':
        tx = cut!.target.x; tz = cut!.target.z; effort = 1.0; mode = 'sprint';
        break;
      case 'clear': {
        const st = this.stationFor(p, world);
        tx = st.x; tz = st.z; effort = 0.52; mode = 'jog';
        break;
      }
      default: {
        const st = this.stationFor(p, world);
        tx = st.x; tz = st.z;
        const d = dist2(p.pos.x, p.pos.z, tx, tz);
        effort = d > 6 ? 0.7 : d > 2 ? 0.42 : 0.16;
        mode = d > 2 ? 'jog' : 'idle';
        state = 'stack';
        break;
      }
    }

    const c = this.avoidSidelines(tx, tz, p);
    const face = m.cutState === 'break' || m.cutState === 'setup'
      ? { x: c.x - p.pos.x, z: c.z - p.pos.z }
      : { x: world.disc.pos.x - p.pos.x, z: world.disc.pos.z - p.pos.z };
    return this.intent(p, c.x, c.z, face.x, face.z, mode, effort, null, {
      role: p.role, state, lane: cut?.lane ?? null,
      cutX: cut?.target.x ?? NaN, cutZ: cut?.target.z ?? NaN,
    }, dt);
  }

  /* --------------------------------------------------- thrower decision */

  private decide(world: AIWorld, thrower: AIPlayer): void {
    const opts = this.evaluateOptions(world, thrower);
    this.noGoodLook = opts.length === 0;
    if (opts.length === 0) { this.choice = null; return; }

    const stall = world.disc.stall;
    // Decision noise: a poor decision-maker misvalues options.
    const noise = (1 - effectiveDecision(thrower) / 100) * 0.055;
    let best: ThrowOption | null = null;
    for (const o of opts) {
      const ev = o.ev + this.rng.gauss() * noise;
      if (!best || ev > best.ev) { o.ev = ev; best = o; }
    }
    if (!best) { this.choice = null; return; }

    // The bar for pulling the trigger. High (selective) under a low stall,
    // collapsing as the count climbs; at 8.5 the best available goes up.
    const hold = stall >= 8.5
      ? -1e9
      : (-0.085 - 0.32 * Math.pow(clamp(stall, 0, 10) / 10, 2)) * this.cfg.aggression;
    this.noGoodLook = best.ev < hold - 0.03;
    this.choice = best.ev > hold ? best : null;
    if (this.choice && this.windup === 0) this.windup = 1e-6;
    if (!this.choice) this.windup = 0;
  }

  private evaluateOptions(world: AIWorld, thrower: AIPlayer): ThrowOption[] {
    const dir = this.dir;
    const disc = world.disc;
    const wind = world.wind;
    const openSign = this.openSign;
    const brk = -openSign as Sign;
    const opts: ThrowOption[] = [];

    // Value of simply keeping the disc where it is, and how much a turnover is
    // worth avoiding. Risk aversion rises when backed up and when protecting a
    // lead, and falls for an aggressive team or one that is chasing.
    const holdValue = possessionValue(yardsToGoal(disc.pos.z, dir));
    const behindBy = world.score[1 - this.team] - world.score[this.team];
    const risk = clamp(
      (1 / this.cfg.aggression)
      * (1 - 0.16 * clamp(behindBy / 4, 0, 1))
      * (0.85 + 0.30 * (effectiveDecision(thrower) / 100)),
      0.45, 1.8,
    );

    // The marker: taken out of the lane-blockage sampling and priced as a
    // break penalty instead, which is how a real thrower thinks about it.
    let marker: AIPlayer | null = null; let md = 3.6;
    for (const f of this.foes) {
      const d = dist2(f.pos.x, f.pos.z, thrower.pos.x, thrower.pos.z);
      if (d < md) { md = d; marker = f; }
    }

    for (const r of this.mates) {
      if (r.id === thrower.id) continue;
      const rm = this.m(r.id);

      // Two passes to converge lead point <-> flight time. A receiver is led
      // along his committed cut and NEVER past the end of it — throwing to
      // where a cutter would be if he kept running is how you throw it away.
      const live = rm.cutState === 'break' || rm.cutState === 'plant';
      const cutTo = live && rm.cut ? rm.cut.target : null;
      let tf = 1.0;
      let aim: Vec3 = { x: r.pos.x, y: 1.4, z: r.pos.z };
      let d = 0;
      for (let it = 0; it < 2; it++) {
        let lx: number, lz: number;
        if (cutTo) {
          const dx = cutTo.x - r.pos.x, dz = cutTo.z - r.pos.z;
          const dl = Math.hypot(dx, dz);
          const travel = Math.min(dl, Math.hypot(r.vel.x, r.vel.z) * tf * 0.85);
          lx = r.pos.x + (dl > 1e-3 ? dx / dl : 0) * travel;
          lz = r.pos.z + (dl > 1e-3 ? dz / dl : 0) * travel;
        } else {
          lx = r.pos.x + r.vel.x * tf * 0.5;
          lz = r.pos.z + r.vel.z * tf * 0.5;
        }
        const cl = clampToField({ x: lx, z: lz }, 1.4);
        aim = { x: cl.x, y: 1.4, z: cl.z };
        d = dist2(thrower.pos.x, thrower.pos.z, aim.x, aim.z);
        tf = throwFlightTime(thrower, 'backhand', d);
      }
      if (d < 2.0) continue;

      const relX = aim.x - thrower.pos.x;
      const releaseSign: Sign = (Math.sign(relX) || 1) as Sign;
      const isBreak = releaseSign === brk;
      const baseType = releaseSideType(thrower.handed, dir, releaseSign);

      const candidates: ThrowType[] = [baseType];
      const behind = dir * (aim.z - thrower.pos.z) < -1.5;
      if (behind) candidates.push('push');

      for (const type of candidates) {
        const along = (wind.x * relX + wind.z * (aim.z - thrower.pos.z)) / (d || 1);
        const cross = Math.abs((wind.x * (aim.z - thrower.pos.z) - wind.z * relX) / (d || 1));
        const range = maxThrowRange(thrower, type, along);
        const powerRatio = d / Math.max(6, range);
        if (powerRatio > 1.05) continue;

        const flightTime = throwFlightTime(thrower, type, d);
        const path = this.flightPath(thrower.pos, aim, flightTime, type);
        const blockage = this.laneBlockage(path, marker, r);
        const separation = this.separationAt(r, aim, flightTime);

        // Break penalty scales with how well the mark is actually positioned.
        let breakPenalty = 0;
        if (isBreak && marker) {
          const markGood = clamp(1 - (md - PLAY.markDistance) / 1.6, 0, 1);
          breakPenalty = 0.30 * markGood;
        }

        const acc = thrower.attr.throwAccuracy[type] * (0.85 + 0.15 * thrower.energy);
        const pThrow = clamp(
          (0.60 + 0.40 * (acc / 100))
          * (1 - 0.30 * powerRatio * powerRatio - breakPenalty * 0.55 - 0.030 * cross),
          0.05, 0.995,
        );
        const pSep = sigmoid(separation - 0.60, 1.30);
        const pLane = clamp(1 - blockage, 0.02, 1);
        const contest = clamp(1.1 - separation * 0.45, 0, 1.1);
        const pCatch = catchProbability(r, contest * 0.7 + powerRatio * 0.4);
        const completion = clamp(pThrow * pSep * pLane * pCatch, 0.01, 0.99);

        // ---- expected-possession-value model.
        // Everything is priced in "probability this possession ends in a goal",
        // so a 40 m score-throw and a 5 m dump are compared in the same units
        // and a turnover is charged what it actually costs: the disc.
        const gain = dir * (aim.z - disc.pos.z);
        const isGoal = inAttackEndzone(aim.z, dir);
        const isReset = gain < 0;
        const newYards = yardsToGoal(aim.z, dir);
        const gainValue = isGoal ? 1.0 : possessionValue(newYards);
        // A turnover here hands the opponent the disc facing the other way.
        const loss = possessionValue(64 - clamp(newYards, 0, 64)) * risk;
        const value = gainValue;
        const ev = completion * gainValue - (1 - completion) * loss - holdValue;
        opts.push({
          receiverId: r.id, type, aim, dist: d, flightTime, separation, blockage,
          breakPenalty, powerRatio, completion, value, ev, isGoal, isReset,
        });
      }
    }
    return opts;
  }

  /** Sampled flight path. Prefers the disc system's own predictor when present. */
  private flightPath(from: Vec3, to: Vec3, tf: number, type: ThrowType): FlightSample[] {
    const n = 10;
    const out: FlightSample[] = [];
    const arc = type === 'hammer' ? 3.2 : 0.28 + 0.05 * dist2(from.x, from.z, to.x, to.z);
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      out.push({
        t: s * tf,
        x: lerp(from.x, to.x, s),
        y: lerp(Math.max(from.y, 1.2), to.y, s) + arc * 4 * s * (1 - s),
        z: lerp(from.z, to.z, s),
      });
    }
    return out;
  }

  /**
   * Is a defender's body in the flight path? Samples the first 78% of the
   * flight (the tail is the receiver's defender, priced as separation) and asks
   * whether each defender can get a hand into that window.
   */
  private laneBlockage(path: FlightSample[], marker: AIPlayer | null, receiver: AIPlayer): number {
    let worst = 0;
    const cut = path[path.length - 1].t * 0.78;
    for (const f of this.foes) {
      const isMark = f === marker;
      const reach = reachHeight(f);
      const v = effectiveMaxSpeed(f);
      const awareness = 0.55 + 0.45 * (f.attr.defAwareness / 100);
      for (const s of path) {
        // The mark is planted, so he only counts in the release window and
        // only for what he can reach without running — but his body IS in the
        // lane, and pretending otherwise is how a reset gets blocked.
        if (isMark ? s.t > 0.42 : (s.t > cut || s.t < 0.05)) continue;
        if (s.y > reach || s.y < 0.15) continue;
        const hd = dist2(f.pos.x, f.pos.z, s.x, s.z);
        const reachable = isMark
          ? 0.80 + v * Math.max(0, s.t - 0.08) * 0.32
          : 0.60 + v * Math.max(0, s.t - 0.14) * 0.72;
        const w = clamp((reachable - hd) / 1.4, 0, 1) * awareness;
        if (w > worst) worst = w;
      }
    }
    // A receiver already at the catch point shields their own space a little.
    return clamp(worst * (1 - 0.12 * smoothstep(6, 2, dist2(
      receiver.pos.x, receiver.pos.z, path[path.length - 1].x, path[path.length - 1].z))), 0, 0.97);
  }

  /** Metres of separation the receiver will have when the disc arrives. */
  private separationAt(r: AIPlayer, aim: Vec3, tf: number): number {
    let bestDef: AIPlayer | null = null; let bd = 1e9;
    for (const f of this.foes) {
      const d = dist2(f.pos.x, f.pos.z, r.pos.x, r.pos.z);
      if (d < bd) { bd = d; bestDef = f; }
    }
    if (!bestDef) return 6;
    const tR = this.timeToReach(r, aim.x, aim.z);
    const reaction = 0.30 - 0.18 * (bestDef.attr.defAwareness / 100);
    const tD = this.timeToReach(bestDef, aim.x, aim.z) + reaction;
    // A receiver who cannot beat the disc to the spot is not open at all,
    // however far away his defender is.
    if (tR > tf + 0.30) return clamp(-2.5 - (tR - tf) * 4, -8, 0);
    const slack = clamp(tf - tR, -1.5, 3);
    // How far the defender is from the catch point at the moment of arrival.
    const lead = (tD - Math.max(tR, tf * 0.6)) * effectiveMaxSpeed(bestDef);
    return clamp(lead + 0.30 * slack, -6, 8);
  }

  private timeToReach(p: AIPlayer, x: number, z: number): number {
    const peer = locoPeer(this.sysRef);
    if (peer?.timeToReach) {
      try {
        const t = peer.timeToReach(p, x, z);
        if (Number.isFinite(t) && t >= 0 && t < 60) return t;
      } catch { /* peer misbehaved — fall through to the internal estimate */ }
    }
    const d = dist2(p.pos.x, p.pos.z, x, z);
    const vmax = effectiveMaxSpeed(p);
    const a = effectiveAccel(p);
    // Change of direction is the expensive part, and it costs twice: the time
    // spent turning AND the ground carried the wrong way while turning. A
    // thrower who ignores this throws behind cutters all day.
    const sp = Math.hypot(p.vel.x, p.vel.z);
    let turnTime = 0;
    let drift = 0;
    if (sp > 0.6 && d > 0.05) {
      const dot = clamp(
        (p.vel.x * (x - p.pos.x) + p.vel.z * (z - p.pos.z)) / (sp * d), -1, 1);
      turnTime = Math.acos(dot) / turnRateOf(p);
      drift = sp * turnTime * (1 - Math.max(0, dot)) * 0.6;
    }
    const dEff = d + drift;
    const tAcc = vmax / a;
    const dAcc = 0.5 * a * tAcc * tAcc;
    return turnTime + (dEff <= dAcc ? Math.sqrt(2 * dEff / a) : tAcc + (dEff - dAcc) / vmax);
  }

  private release(world: AIWorld, thrower: AIPlayer, o: ThrowOption): PlayerAction {
    // The choice can be up to a decision tick plus a windup old. Re-solve the
    // lead against where the receiver actually is now.
    const r = this.byId.get(o.receiverId);
    if (r) {
      const rm = this.m(r.id);
      const cutTo = (rm.cutState === 'break' || rm.cutState === 'plant') && rm.cut
        ? rm.cut.target : null;
      let tf = o.flightTime;
      for (let i = 0; i < 2; i++) {
        let lx: number, lz: number;
        if (cutTo) {
          const dx = cutTo.x - r.pos.x, dz = cutTo.z - r.pos.z;
          const dl = Math.hypot(dx, dz);
          const travel = Math.min(dl, Math.hypot(r.vel.x, r.vel.z) * tf * 0.85);
          lx = r.pos.x + (dl > 1e-3 ? dx / dl : 0) * travel;
          lz = r.pos.z + (dl > 1e-3 ? dz / dl : 0) * travel;
        } else {
          lx = r.pos.x + r.vel.x * tf * 0.5;
          lz = r.pos.z + r.vel.z * tf * 0.5;
        }
        const cl = clampToField({ x: lx, z: lz }, 1.4);
        o.aim = { x: cl.x, y: 1.4, z: cl.z };
        o.dist = dist2(thrower.pos.x, thrower.pos.z, o.aim.x, o.aim.z);
        tf = throwFlightTime(thrower, o.type, o.dist);
      }
      o.flightTime = tf;
    }
    const acc = thrower.attr.throwAccuracy[o.type] * (0.85 + 0.15 * thrower.energy);
    const cross = Math.hypot(world.wind.x, world.wind.z);
    const sigma = (0.26 + 1.45 * (1 - acc / 100)) * (0.55 + 0.030 * o.dist)
      + 0.85 * o.powerRatio * o.powerRatio
      + 0.55 * o.breakPenalty
      + 0.035 * cross * (o.dist / 20);
    const ex = this.rng.gauss() * sigma;
    const ez = this.rng.gauss() * sigma;
    const aimX = clamp(o.aim.x + ex, -FIELD.halfWidth - 1.5, FIELD.halfWidth + 1.5);
    const aimZ = clamp(o.aim.z + ez, -FIELD.halfLength - 1.5, FIELD.halfLength + 1.5);
    return {
      kind: 'throw', throwType: o.type,
      aimX, aimY: 1.35, aimZ,
      speed: o.dist / Math.max(0.2, o.flightTime),
      flightTime: o.flightTime,
      spin: 22 + 14 * (thrower.attr.throwPower / 100),
      receiverId: o.receiverId,
      expected: o.completion,
    };
  }

  /* -------------------------------------------------- offence in flight */

  private offenceInFlight(world: AIWorld, dt: number): PlayerIntent[] {
    const out: PlayerIntent[] = [];
    const land = this.predictCatchPoint(world);
    const target = world.disc.intendedReceiver;

    // Whoever is nearest the disc backs up the intended receiver.
    let backupId = -1; let bd = 1e9;
    for (const p of this.mates) {
      if (p.id === target) continue;
      const t = this.timeToReach(p, land.x, land.z);
      if (t < bd) { bd = t; backupId = p.id; }
    }

    for (const p of this.mates) {
      const m = this.m(p.id);
      if (m.flightCommit !== this.flightEpoch) {
        m.flightCommit = this.flightEpoch;
        m.bidCommit = false;
      }
      const isTarget = p.id === target;
      if (isTarget || p.id === backupId) {
        const t = this.timeToReach(p, land.x, land.z);
        const gap = (t - land.t) * effectiveMaxSpeed(p);
        // Time the arrival. Sprinting flat out to a spot the disc reaches a
        // second later just means running through it and having to come back —
        // unless a defender is contesting, in which case get there first.
        let contested = false;
        for (const f of this.foes) {
          if (dist2(f.pos.x, f.pos.z, land.x, land.z) < 4.5) { contested = true; break; }
        }
        const pace = contested ? 1
          : clamp(0.34 + 0.85 * (t / Math.max(0.08, land.t)), 0.34, 1);
        const extend = layoutExtend(p);
        let mode: MoveMode = 'sprint';
        let action: PlayerAction | null = null;
        if (gap <= 0.15 && land.y > 1.9 && land.y < reachHeight(p) + 0.5) {
          mode = 'jump';
          action = { kind: 'jump', height: land.y };
        } else if (isTarget && gap > 0.7 && gap < extend) {
          // You lay out for a low disc you cannot otherwise reach — not for a
          // chest-high one you can simply run down.
          mode = 'layout';
          action = { kind: 'bid', x: land.x, z: land.z, extend };
        } else if (gap <= 0.05) {
          mode = 'catch';
          const diff = clamp(0.20 + 0.5 * clamp((land.y - 1.7) / 1.0, 0, 1)
            + 0.35 * this.contestAt(land.x, land.z), 0, 1.6);
          action = { kind: 'catch', difficulty: diff };
        }
        const c = clampToField({ x: land.x, z: land.z }, 0.45);
        out.push(this.intent(p, c.x, c.z, land.x - p.pos.x, land.z - p.pos.z,
          mode, pace, action, { role: p.role, state: 'attack-disc', lane: null }, dt, true));
        continue;
      }
      // Everyone else clears out and re-forms around the likely new disc spot.
      if (m.cutState === 'setup' || m.cutState === 'plant' || m.cutState === 'break') {
        this.endCut(p.id, 'clear');
      }
      const st = this.stationFor(p, world, land.x, land.z);
      const c = this.avoidSidelines(st.x, st.z, p);
      out.push(this.intent(p, c.x, c.z, land.x - p.pos.x, land.z - p.pos.z,
        'jog', 0.55, null, { role: p.role, state: 'clear', lane: null }, dt));
    }
    return out;
  }

  private contestAt(x: number, z: number): number {
    let n = 0;
    for (const f of this.foes) if (dist2(f.pos.x, f.pos.z, x, z) < 1.8) n += 1;
    return clamp(n, 0, 2);
  }

  /* ============================================================= DEFENCE */

  private defence(world: AIWorld, dt: number): PlayerIntent[] {
    if (world.disc.state === 'flight') return this.defenceInFlight(world, dt);
    if (this.scheme === 'zone') return this.zoneDefence(world, dt);
    return this.personDefence(world, dt);
  }

  private pickScheme(world: AIWorld): void {
    const windSpeed = Math.hypot(world.wind.x, world.wind.z);
    const diff = world.score[this.team] - world.score[1 - this.team];
    const played = world.score[0] + world.score[1];
    this.scheme = shouldPlayZone(windSpeed, diff, played, this.cfg.zoneBias) ? 'zone' : 'person';
    // Under a strong crosswind, force to the upwind side — throws hang there.
    const odir = -this.dir as AttackDir;
    if (windSpeed > 5) {
      const upwindSign: Sign = world.wind.x >= 0 ? -1 : 1;
      this.force = openSideSign('forehand', odir) === upwindSign ? 'forehand' : 'backhand';
    } else {
      this.force = this.cfg.force;
    }
  }

  private assignMatchups(world: AIWorld): void {
    this.matchup.clear();
    this.zoneRole.clear();
    const offs = this.foes.slice();
    const defs = this.mates.slice();
    if (this.scheme === 'zone') {
      const disc = { x: world.disc.pos.x, z: world.disc.pos.z };
      const odir = -this.dir as AttackDir;
      const stations = zoneStations(disc, odir, openSideSign(this.force, odir), null);
      const free = stations.slice();
      // Best athlete deep, best defender in the cup.
      const order = defs.slice().sort((a, b) =>
        (b.attr.speed + b.attr.jumping) - (a.attr.speed + a.attr.jumping) || (a.id - b.id));
      const deepIdx = free.findIndex((s) => s.role === 'deep');
      if (deepIdx >= 0 && order.length) {
        this.zoneRole.set(order[0].id, 'deep');
        free.splice(deepIdx, 1);
        order.shift();
      }
      for (const d of order) {
        if (!free.length) break;
        let bi = 0; let bd = 1e9;
        for (let i = 0; i < free.length; i++) {
          const dd = dist2(d.pos.x, d.pos.z, free[i].x, free[i].z);
          if (dd < bd) { bd = dd; bi = i; }
        }
        this.zoneRole.set(d.id, free[bi].role);
        free.splice(bi, 1);
      }
      return;
    }
    // Person: greedy min-cost with an athletic-similarity term so the fast
    // defender ends up on the fast cutter.
    const pool = offs.slice();
    const dl = defs.slice().sort((a, b) => b.attr.defAwareness - a.attr.defAwareness || a.id - b.id);
    for (const d of dl) {
      if (!pool.length) break;
      let bi = 0; let bc = 1e9;
      for (let i = 0; i < pool.length; i++) {
        const o = pool[i];
        const cost = dist2(d.pos.x, d.pos.z, o.pos.x, o.pos.z)
          + Math.abs(d.attr.speed - o.attr.speed) * 0.12;
        if (cost < bc) { bc = cost; bi = i; }
      }
      this.matchup.set(d.id, pool[bi].id);
      pool.splice(bi, 1);
    }
  }

  private personDefence(world: AIWorld, dt: number): PlayerIntent[] {
    const out: PlayerIntent[] = [];
    const odir = -this.dir as AttackDir;
    const openSign = openSideSign(this.force, odir);
    const brk = breakSideSign(this.force, odir);
    const disc = world.disc;
    const thrower = disc.carrier != null ? this.byId.get(disc.carrier) ?? null : null;

    // ---- the mark: whoever is matched on the thrower, unless badly beaten.
    this.markerId = -1;
    if (thrower) {
      let matched = -1;
      for (const [d, o] of this.matchup) if (o === thrower.id) matched = d;
      let markerP = matched >= 0 ? this.byId.get(matched) ?? null : null;
      if (markerP) {
        const md = dist2(markerP.pos.x, markerP.pos.z, thrower.pos.x, thrower.pos.z);
        if (md > 6) {
          // Someone closer takes the mark; swap assignments so nobody is free.
          let cand: AIPlayer | null = null; let cd = md;
          for (const d of this.mates) {
            if (d.id === markerP.id) continue;
            const dd = dist2(d.pos.x, d.pos.z, thrower.pos.x, thrower.pos.z);
            if (dd < cd - 1.5) { cd = dd; cand = d; }
          }
          if (cand) {
            const candOld = this.matchup.get(cand.id);
            this.matchup.set(cand.id, thrower.id);
            if (candOld != null) this.matchup.set(markerP.id, candOld);
            markerP = cand;
          }
        }
      }
      this.markerId = markerP ? markerP.id : -1;
    }

    // ---- stall clock
    if (thrower && this.markerId >= 0) {
      const mk = this.byId.get(this.markerId)!;
      const d = dist2(mk.pos.x, mk.pos.z, thrower.pos.x, thrower.pos.z);
      if (d <= PLAY.markMax) this.stallClock += dt;
    } else {
      this.stallClock = 0;
    }
    if (!thrower) this.stallClock = 0;

    // ---- identify the deep threat and the deepest defender for the bracket.
    let deepThreat: AIPlayer | null = null; let dbest = -1e9;
    for (const o of this.foes) {
      const df = odir * (o.pos.z - disc.pos.z);
      if (df > dbest) { dbest = df; deepThreat = o; }
    }
    this.deepHelpId = -1;
    let deepestDef = -1e9;
    for (const d of this.mates) {
      if (d.id === this.markerId) continue;
      const df = odir * (d.pos.z - disc.pos.z);
      if (df > deepestDef) { deepestDef = df; this.deepHelpId = d.id; }
    }

    this.trySwitches(world, odir);

    for (const p of this.mates) {
      const mm = this.m(p.id);

      if (p.id === this.markerId && thrower) {
        const mp = markPoint(
          { x: thrower.pos.x, z: thrower.pos.z }, odir, brk, PLAY.markDistance);
        let tx = mp.x, tz = mp.z;
        // Respect disc space: back out rather than crowd the thrower. The
        // check anticipates a step of travel so momentum cannot carry the
        // marker inside the legal radius.
        const ahead = 0.28;
        const fx = p.pos.x + p.vel.x * ahead - thrower.vel.x * ahead;
        const fz = p.pos.z + p.vel.z * ahead - thrower.vel.z * ahead;
        const cur = dist2(fx, fz, thrower.pos.x, thrower.pos.z);
        if (cur < PLAY.discSpace + 1.10) {
          const now = dist2(p.pos.x, p.pos.z, thrower.pos.x, thrower.pos.z) || 1;
          const ux = (p.pos.x - thrower.pos.x) / now;
          const uz = (p.pos.z - thrower.pos.z) / now;
          tx = thrower.pos.x + ux * (PLAY.discSpace + 1.75);
          tz = thrower.pos.z + uz * (PLAY.discSpace + 1.75);
        }
        // Closing effort tapers so the mark settles at range instead of
        // barrelling through the thrower; backing out of disc space is done at
        // full effort and is not asked to settle.
        const backing = cur < PLAY.discSpace + 1.10;
        const gap = dist2(p.pos.x, p.pos.z, tx, tz);
        const c = this.avoidSidelines(tx, tz, p);
        out.push(this.intent(p, c.x, c.z,
          thrower.pos.x - p.pos.x, thrower.pos.z - p.pos.z,
          backing ? 'backpedal' : 'mark',
          backing ? 1 : clamp(gap * 0.55, 0.10, 1),
          { kind: 'stall', count: this.stallClock },
          { role: 'marker', state: 'mark', lane: null }, dt));
        continue;
      }

      const oid = this.matchup.get(p.id);
      const o = oid != null ? this.byId.get(oid) ?? null : null;
      if (!o) {
        const c = this.avoidSidelines(disc.pos.x, disc.pos.z + odir * 10, p);
        out.push(this.intent(p, c.x, c.z, 0, odir, 'jog', 0.5, null,
          { role: 'defender', state: 'lost', lane: null }, dt));
        continue;
      }

      // Defensive reaction. A defender does not track his matchup's position
      // instantaneously — he reacts to it, and a sharp change of direction is
      // exactly what buys a cutter a step. Awareness sets the lag.
      const tau = 0.36 - 0.22 * (p.attr.defAwareness / 100);
      if (mm.seenOf !== o.id) { mm.seenOf = o.id; mm.seenX = o.pos.x; mm.seenZ = o.pos.z; }
      // Lateral position (which side you are on) is a stance a defender holds
      // consciously; depth is what he reacts to. So x tracks roughly twice as
      // fast as z.
      const kz = Math.min(1, dt / Math.max(0.04, tau));
      const kx = Math.min(1, dt / Math.max(0.04, tau * 0.5));
      mm.seenX += (o.pos.x - mm.seenX) * kx;
      mm.seenZ += (o.pos.z - mm.seenZ) * kz;

      // Base person position: shade the open side, play under or over.
      const lead = 0.22;
      const px = mm.seenX + o.vel.x * lead;
      const pz = mm.seenZ + o.vel.z * lead;
      const downfield = odir * (o.pos.z - disc.pos.z);
      const goingDeep = odir * o.vel.z > 2.2;
      const isDeepThreat = downfield > 14 || goingDeep;
      const depth = isDeepThreat ? PLAY.deepCushion : -PLAY.underGap;
      const skill = 0.65 + 0.35 * (p.attr.defAwareness / 100);
      let tx = px + openSign * PLAY.shadeOpen * skill;
      let tz = pz + odir * depth;
      // The velocity lead must never flip the shade: a defender playing a
      // force is always on the open side of his matchup, whatever the cutter
      // is doing. This is the single most visible rule in the sport.
      const minShade = 1.05 + 0.75 * skill;
      if ((tx - o.pos.x) * openSign < minShade) tx = o.pos.x + openSign * minShade;

      // ---- poach / help / bracket
      const threat = this.threatOf(o, disc, odir);
      const wantPoach = threat < 0.30;
      mm.poachHold = wantPoach ? mm.poachHold + dt : 0;
      const engage = mm.poachHold > 0.35 && threat < 0.30;
      const disengage = threat > 0.45;
      mm.poach = clamp(mm.poach + (engage ? dt * 2.2 : disengage ? -dt * 4.0 : -dt * 0.6), 0, 1);

      if (mm.poach > 0.05) {
        const isBracket = p.id === this.deepHelpId && deepThreat !== null;
        const leash = isBracket ? 7.5 : 4.5;
        let hx: number, hz: number;
        if (isBracket && deepThreat) {
          hx = deepThreat.pos.x + openSign * 1.0;
          hz = deepThreat.pos.z + odir * 4.0;
        } else {
          // Help on the under: sit in the primary throwing lane.
          hx = disc.pos.x + openSign * 5.0;
          hz = disc.pos.z + odir * 7.0;
        }
        let nx = lerp(tx, hx, mm.poach);
        let nz = lerp(tz, hz, mm.poach);
        const ld = dist2(nx, nz, o.pos.x, o.pos.z);
        if (ld > leash) {
          const s = leash / ld;
          nx = o.pos.x + (nx - o.pos.x) * s;
          nz = o.pos.z + (nz - o.pos.z) * s;
        }
        tx = nx; tz = nz;
      }

      const gap = dist2(p.pos.x, p.pos.z, tx, tz);
      const effort = clamp(0.35 + gap * 0.45, 0.35, 1);
      const mode: MoveMode = gap > 2.5 ? 'sprint' : gap > 0.8 ? 'shuffle' : 'idle';
      const c = this.avoidSidelines(tx, tz, p);
      out.push(this.intent(p, c.x, c.z, o.pos.x - p.pos.x, o.pos.z - p.pos.z,
        mode, effort, null,
        { role: 'defender', state: mm.poach > 0.4 ? 'poach' : 'person', lane: null }, dt));
    }
    return out;
  }

  /** 0..1 — how dangerous this offensive player is right now. */
  private threatOf(o: AIPlayer, disc: DiscState, odir: AttackDir): number {
    const d = dist2(o.pos.x, o.pos.z, disc.pos.x, disc.pos.z);
    const sp = Math.hypot(o.vel.x, o.vel.z);
    const toward = d > 0.1
      ? ((disc.pos.x - o.pos.x) * o.vel.x + (disc.pos.z - o.pos.z) * o.vel.z) / (d * Math.max(sp, 1e-3))
      : 0;
    const downfield = odir * (o.pos.z - disc.pos.z);
    return clamp(
      0.42 * smoothstep(0.8, 5.0, sp)
      + 0.30 * smoothstep(42, 9, d)
      + 0.18 * clamp(toward, 0, 1)
      + 0.16 * smoothstep(30, 6, Math.abs(downfield)),
      0, 1,
    );
  }

  private trySwitches(world: AIWorld, odir: AttackDir): void {
    const ids = this.mates.map((p) => p.id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = this.byId.get(ids[i]); const b = this.byId.get(ids[j]);
        if (!a || !b) continue;
        if (a.id === this.markerId || b.id === this.markerId) continue;
        const ma = this.m(a.id); const mb = this.m(b.id);
        if (ma.switchCd > 0 || mb.switchCd > 0) continue;
        const oa = this.matchup.get(a.id); const ob = this.matchup.get(b.id);
        if (oa == null || ob == null) continue;
        const pa = this.byId.get(oa); const pb = this.byId.get(ob);
        if (!pa || !pb) continue;
        const cur = dist2(a.pos.x, a.pos.z, pa.pos.x, pa.pos.z)
          + dist2(b.pos.x, b.pos.z, pb.pos.x, pb.pos.z);
        const swapped = dist2(a.pos.x, a.pos.z, pb.pos.x, pb.pos.z)
          + dist2(b.pos.x, b.pos.z, pa.pos.x, pa.pos.z);
        if (swapped < cur - 3.0) {
          this.matchup.set(a.id, ob);
          this.matchup.set(b.id, oa);
          ma.switchCd = 2.5; mb.switchCd = 2.5;
        }
      }
    }
  }

  private zoneDefence(world: AIWorld, dt: number): PlayerIntent[] {
    const out: PlayerIntent[] = [];
    const odir = -this.dir as AttackDir;
    const openSign = openSideSign(this.force, odir);
    const disc = world.disc;
    const thrower = disc.carrier != null ? this.byId.get(disc.carrier) ?? null : null;

    let deepThreat: Vec2 | null = null; let dbest = -1e9;
    for (const o of this.foes) {
      const df = odir * (o.pos.z - disc.pos.z);
      if (df > dbest) { dbest = df; deepThreat = { x: o.pos.x, z: o.pos.z }; }
    }
    const stations = zoneStations(
      { x: disc.pos.x, z: disc.pos.z }, odir, openSign, deepThreat);
    const byRole = new Map<ZoneRole, { x: number; z: number }>();
    for (const s of stations) byRole.set(s.role, { x: s.x, z: s.z });

    // Cup mark applies the stall.
    let markerId = -1;
    for (const [id, role] of this.zoneRole) if (role === 'cup-mark') markerId = id;
    this.markerId = markerId;
    if (thrower && markerId >= 0) {
      const mk = this.byId.get(markerId);
      if (mk && dist2(mk.pos.x, mk.pos.z, thrower.pos.x, thrower.pos.z) <= PLAY.markMax) {
        this.stallClock += dt;
      }
    } else {
      this.stallClock = 0;
    }

    for (const p of this.mates) {
      const role = this.zoneRole.get(p.id) ?? 'short-deep';
      const st = byRole.get(role) ?? { x: disc.pos.x, z: disc.pos.z + odir * 12 };
      let tx = st.x, tz = st.z;

      let backing = false;
      if (role === 'cup-mark' && thrower) {
        const ahead = 0.28;
        const fx = p.pos.x + p.vel.x * ahead - thrower.vel.x * ahead;
        const fz = p.pos.z + p.vel.z * ahead - thrower.vel.z * ahead;
        const cur = dist2(fx, fz, thrower.pos.x, thrower.pos.z);
        if (cur < PLAY.discSpace + 0.75) {
          backing = true;
          const now = dist2(p.pos.x, p.pos.z, thrower.pos.x, thrower.pos.z) || 1;
          tx = thrower.pos.x + ((p.pos.x - thrower.pos.x) / now) * (PLAY.discSpace + 1.75);
          tz = thrower.pos.z + ((p.pos.z - thrower.pos.z) / now) * (PLAY.discSpace + 1.75);
        }
      }

      // Zone players still react to the nearest offensive body in their area.
      if (role !== 'cup-mark') {
        let near: AIPlayer | null = null; let nd = 7.5;
        for (const o of this.foes) {
          const d = dist2(o.pos.x, o.pos.z, st.x, st.z);
          if (d < nd) { nd = d; near = o; }
        }
        if (near) {
          const pull = 0.45 * (0.6 + 0.4 * (p.attr.defAwareness / 100));
          tx = lerp(tx, near.pos.x + openSign * 0.8, pull);
          tz = lerp(tz, near.pos.z - odir * 0.8, pull);
        }
      }

      const gap = dist2(p.pos.x, p.pos.z, tx, tz);
      const c = this.avoidSidelines(tx, tz, p);
      const action: PlayerAction | null = p.id === markerId && thrower
        ? { kind: 'stall', count: this.stallClock } : null;
      out.push(this.intent(p, c.x, c.z,
        disc.pos.x - p.pos.x, disc.pos.z - p.pos.z,
        backing ? 'backpedal' : p.id === markerId ? 'mark' : gap > 2.5 ? 'sprint' : 'shuffle',
        backing ? 1 : clamp(0.35 + gap * 0.4, 0.3, 1), action,
        { role: `zone:${role}`, state: 'zone', lane: null }, dt));
    }
    return out;
  }

  /* ------------------------------------------------- defence in flight */

  private defenceInFlight(world: AIWorld, dt: number): PlayerIntent[] {
    const out: PlayerIntent[] = [];
    const land = this.predictCatchPoint(world);
    const odir = -this.dir as AttackDir;
    const brk = breakSideSign(this.force, odir);
    for (const p of this.mates) {
      const m = this.m(p.id);
      if (m.flightCommit !== this.flightEpoch) {
        m.flightCommit = this.flightEpoch;
        // One committed read per flight; awareness decides whether they see it.
        const t = this.timeToReach(p, land.x, land.z);
        const gap = (t - land.t) * effectiveMaxSpeed(p);
        const sees = this.rng.next() < 0.45 + 0.55 * (p.attr.defAwareness / 100);
        m.bidCommit = sees && gap > 0.2 && gap < layoutExtend(p) && land.y < 1.85;
      }
      const t = this.timeToReach(p, land.x, land.z);
      const gap = (t - land.t) * effectiveMaxSpeed(p);
      const canPlay = gap < layoutExtend(p) + 0.5;

      if (canPlay) {
        let mode: MoveMode = 'sprint';
        let action: PlayerAction | null = null;
        if (gap <= 0.1 && land.y > 1.85 && land.y < reachHeight(p) + 0.4) {
          mode = 'jump'; action = { kind: 'jump', height: land.y };
        } else if (m.bidCommit && gap > 0) {
          mode = 'layout';
          action = { kind: 'bid', x: land.x, z: land.z, extend: layoutExtend(p) };
        }
        const c = clampToField({ x: land.x, z: land.z }, 0.45);
        out.push(this.intent(p, c.x, c.z, land.x - p.pos.x, land.z - p.pos.z,
          mode, 1.0, action, { role: 'defender', state: 'read-disc', lane: null }, dt, true));
        continue;
      }
      // No play on the disc. If it is landing near you, break down and set the
      // mark now rather than running through the catch — that is both the
      // correct read and how a defender avoids fouling into disc space.
      const toLand = dist2(p.pos.x, p.pos.z, land.x, land.z);
      if (toLand < 7) {
        const mp = markPoint({ x: land.x, z: land.z }, odir, brk, PLAY.markDistance + 0.30);
        const c = this.avoidSidelines(mp.x, mp.z, p);
        out.push(this.intent(p, c.x, c.z, land.x - p.pos.x, land.z - p.pos.z,
          'shuffle', 1, null, { role: 'defender', state: 'mark-up', lane: null }, dt, true));
        continue;
      }
      const oid = this.matchup.get(p.id);
      const o = oid != null ? this.byId.get(oid) : undefined;
      const tx = o ? o.pos.x : land.x;
      const tz = o ? o.pos.z : land.z;
      const c = this.avoidSidelines(tx, tz, p);
      out.push(this.intent(p, c.x, c.z, land.x - p.pos.x, land.z - p.pos.z,
        'sprint', 0.85, null, { role: 'defender', state: 'recover', lane: null }, dt));
    }
    return out;
  }

  /* ------------------------------------------------------------ helpers */

  private sysRef: Record<string, unknown> | undefined = undefined;

  /** Where and when the disc becomes catchable. Uses the disc peer if present. */
  private predictCatchPoint(world: AIWorld): { x: number; y: number; z: number; t: number } {
    this.sysRef = world.sys;
    const peer = discPeer(world.sys);
    if (peer?.predictPath) {
      let path: FlightSample[] | null = null;
      try {
        const raw = peer.predictPath(world.disc, 6, 1 / 30);
        if (validFlightSamples(raw)) path = raw;
        else DISC_PEER_OK.set(peer as object, false);
      } catch {
        DISC_PEER_OK.set(peer as object, false);
      }
      if (path) {
        DISC_PEER_OK.set(peer as object, true);
        for (let i = 1; i < path.length; i++) {
          const s = path[i];
          if (s.y <= 1.45 && path[i - 1].y > 1.45) return { x: s.x, y: s.y, z: s.z, t: s.t };
          if (s.y <= 0.12) return { x: s.x, y: s.y, z: s.z, t: s.t };
        }
        const last = path[path.length - 1];
        return { x: last.x, y: last.y, z: last.z, t: last.t };
      }
    }
    // Fallback glide integrator: gravity partly offset by lift, light drag.
    let x = world.disc.pos.x, y = world.disc.pos.y, z = world.disc.pos.z;
    let vx = world.disc.vel.x, vy = world.disc.vel.y, vz = world.disc.vel.z;
    const h = 1 / 60;
    for (let t = 0; t < 6; t += h) {
      vy -= 3.1 * h;
      const drag = 1 - 0.11 * h;
      vx *= drag; vz *= drag;
      x += vx * h; y += vy * h; z += vz * h;
      if (y <= 1.4 && vy < 0) return { x, y: Math.max(y, 0.05), z, t: t + h };
    }
    return { x, y: Math.max(y, 0.05), z, t: 6 };
  }

  /** Pull a target back inside the lines. Speed is capped separately. */
  private avoidSidelines(x: number, z: number, p: AIPlayer): Vec2 {
    return clampToField({ x, z }, FIELD.edgeMargin + 0.7);
  }

  private nearestFoe(x: number, z: number): AIPlayer | null {
    let best: AIPlayer | null = null; let bd = 1e9;
    for (const f of this.foes) {
      const d = dist2(f.pos.x, f.pos.z, x, z);
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }

  private intent(
    p: AIPlayer, tx: number, tz: number, fx: number, fz: number,
    mode: MoveMode, effort: number, action: PlayerAction | null,
    debug: { role: string; state: string; lane: LaneKey | null; cutX?: number; cutZ?: number },
    _dt: number, settle = false,
  ): PlayerIntent {
    const m = this.m(p.id);
    const fl = Math.hypot(fx, fz);
    if (fl > 1e-4) { m.faceX = fx / fl; m.faceZ = fz / fl; }
    const maxSpeed = effectiveMaxSpeed(p);
    const decel = effectiveDecel(p);
    const e = clamp(effort, 0, 1);
    // Speed is capped so the player can always brake before the perimeter:
    // v <= sqrt(2 a s). The cap is taken over the room left both in the
    // direction he is being sent AND the direction he is already travelling,
    // because momentum, not intent, is what carries a player over a line.
    const roomTo = boundaryRoom(p.pos.x, p.pos.z, tx - p.pos.x, tz - p.pos.z);
    const roomVel = boundaryRoom(p.pos.x, p.pos.z, p.vel.x, p.vel.z);
    const capTo = Math.sqrt(2 * decel * Math.max(0, roomTo));
    const capVel = Math.sqrt(2 * decel * Math.max(0, roomVel));
    // Modes that must settle (the mark, a defender sliding into position) also
    // brake to a stop at the target rather than blowing through it.
    let arriveCap = 1e3;
    if (settle || mode === 'mark' || mode === 'shuffle') {
      const dt2 = Math.hypot(tx - p.pos.x, tz - p.pos.z);
      arriveCap = Math.sqrt(2 * decel * Math.max(0, dt2)) * 0.92 + 0.25;
    }
    return {
      id: p.id, team: p.team,
      targetX: tx, targetZ: tz,
      faceX: m.faceX, faceZ: m.faceZ,
      mode, effort: e,
      desiredSpeed: Math.min(maxSpeed * e, capTo, capVel, arriveCap),
      maxSpeed: Math.min(maxSpeed, Math.max(capVel, 0.4)),
      maxAccel: effectiveAccel(p),
      maxDecel: decel,
      turnRate: turnRateOf(p),
      arriveRadius: settle ? 1.5 : mode === 'sprint' ? 0.6 : mode === 'mark' ? 1.9 : 1.1,
      personalSpace: 0.72,
      action,
      debug: {
        role: debug.role, state: debug.state, lane: debug.lane,
        cutX: debug.cutX ?? NaN, cutZ: debug.cutZ ?? NaN,
      },
    };
  }
}

/* ============================================================ public API */

export function createTeamAI(
  team: 0 | 1, dir: AttackDir, rng: RandomSource, cfg?: Partial<TeamConfig>,
): TeamAI {
  return new TeamAI(team, dir, rng, cfg);
}

/**
 * Produce this fixed step's intents for one team.
 * Call once per team per 1/120 s step, before locomotion.
 */
export function updateTeam(team: TeamAI, world: AIWorld, dt: number): PlayerIntent[] {
  return team.update(world, dt);
}

/** Rest between points: players get some of the tank back. */
export function restBetweenPoints(players: AIPlayer[], seconds = 45): void {
  for (const p of players) {
    const endurance = 0.4 + 0.6 * (p.attr.stamina / 100);
    p.energy = clamp(p.energy + seconds * 0.012 * endurance, 0.12, 1);
  }
}
