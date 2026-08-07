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
  inAttackEndzone, openSideSign, breakSideSign, openSideFor, breakSideFor, releaseSideType,
  formationStations, chooseFormation, buildCut, handlerCount, stackColumnX,
  hasColumn,
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
    /**
     * The kind of cut being run, if any, and the runner's depth in the column
     * when it was offered. Which cut belongs to which position IS the vertical
     * stack, so this is the only handle a test has on whether the shape on the
     * field is the shape the sport plays — everything else about a cut looks
     * identical from outside whether it came from the front or the back.
     */
    cutKind: CutKind | null;
    cutDepth: number;
  };
}

/* ============================================================ system peers */

export interface FlightSample { t: number; x: number; y: number; z: number }

/**
 * The two points on a flight anybody in-flight cares about: where to run to,
 * and where the disc stops being playable on your feet. See `predictCatchPoint`.
 */
interface CatchPoint {
  x: number; y: number; z: number; t: number;
  lastX: number; lastZ: number; lastT: number;
}

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

/**
 * Shortest route a COMMANDED cut may resolve to, metres. Below this the cutter
 * arrives on the frame he departs and the player who asked for a cut sees
 * nothing move. Sized just over the 1.5 m the game suite asserts.
 */
const MIN_CUT_RUN = 1.8;

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

/* ---------------------------------------------------------------- layouts
 *
 * A layout is a full-extension dive, and in ultimate it is a LAST RESORT: you
 * leave your feet because you cannot get there on them. It reads as dramatic
 * precisely because it is rare, so the decision has to be priced like one.
 *
 * The constants below are the whole model. Every one of them is a fact about
 * the world — a reach the rules engine pays out on, a height it will not, the
 * airtime of the dive itself — rather than a taste knob, and the two that are
 * not (`BID_HESITATION`, the stakes relief) are the noise floor of an estimate
 * and are quoted with the measurement that set them.
 *
 * Over 50 sim-minutes against `src/sim/Game.ts` this took the rate from 5.80
 * layouts a minute to 1.66, and defensive dives from 1.30 a minute to 0.06,
 * with the completion rate unmoved at 58%.
 */

/**
 * Horizontal reach for a standing catch and for a full extension, in metres.
 * Both are quoted from `CATCH_REACH` / `LAYOUT_REACH` in Game.ts, which are the
 * radii the rules engine actually awards a catch or a block inside — and note
 * that the engine's extension is a FLAT 1.55 m, so `layoutExtend` below is the
 * AI's own athleticism model and buys nothing the rules will honour.
 *
 * A dive therefore converts exactly 0.73 m of reach. Anything inside 0.82 m a
 * player runs down on his feet; anything past 1.55 m he does not reach lying
 * down either, and pays two seconds on the turf for finding out.
 *
 * This is the gate that was missing. The old thresholds were 0.2 m (defence)
 * and 0.7 m (offence), both INSIDE standing reach, so "not already at my feet"
 * qualified as a layout: 1.47 layouts per completion, 29% of them for discs the
 * player could have caught standing up and 7% for discs he could not have
 * reached extended either.
 */
const STANDING_REACH = 0.82;
const EXTENDED_REACH = 1.55;

/**
 * The height band a rendezvous with the disc is allowed to be picked in, in
 * metres. Game.ts takes a standing catch between `groundY + 0.20` and the
 * player's reach; `CATCH_FLOOR` sits above the bottom of that with a stride of
 * margin, and `CATCH_CEILING` is chest height on a descending disc. See
 * `predictCatchPoint` for what happens when the floor is set below the band the
 * rules engine will actually pay out on.
 */
const CATCH_FLOOR = 0.85;
const CATCH_CEILING = 1.45;

/**
 * Below this the disc is gone: Game.ts refuses a standing catch under
 * `groundY + 0.20`, and this leaves a frame of margin on top of that. The point
 * where the flight crosses it is the player's LAST CHANCE on his feet, and that
 * — not the rendezvous — is the deadline a layout has to beat. Measured: with
 * the rendezvous as the deadline, three quarters of the surviving bids were for
 * discs the player went on to catch standing anyway a tenth of a second later.
 */
const CATCH_DEAD = 0.25;

/**
 * How much further than his standing reach a player has to be short before he
 * believes it, in metres — the noise floor of `arrivalShortfall` below.
 *
 * It is small because that estimate is a distance measured from a distance.
 * The number this replaced was tuned against `gap`, which is a distance
 * inferred from a time and runs hot by a factor of several; sizing a 0.73 m
 * decision against it is what produced 1.5 layouts per completion.
 *
 * Swept at 0.20 / 0.35 / 0.40 over 5 seeds x 600 s: 0.35 gave the fewest bids
 * for the most completions. Raising it further only trades catches for nothing,
 * because the bids it removes are the ones inside the reach band that work.
 */
const BID_HESITATION = 0.35;

/**
 * Seconds of dive. Locomotion's layout takeoff is ~1.2 m/s of lift carrying the
 * body from hip height to prone, which is a little under half a second in the
 * air. Bidding earlier than this is not a bid, it is a belly-flop with a good
 * view of the catch: measured, defensive bids fired on the first frame the gap
 * turned positive and touched the disc 4.7% of the time. Tightening 0.65 -> 0.45
 * cut the rate a fifth and raised the share of bids that touch the disc from
 * 50% to 61%, which is the same statement twice.
 */
const BID_LEAD = 0.45;

/**
 * How far from the disc a player will actually BE when it arrives, in metres.
 *
 * The in-flight code's `gap` — `(timeToReach - arrival) * topSpeed` — is a
 * coarse "am I in the neighbourhood of this disc" test and it runs hot by a
 * factor of several: `timeToReach` charges a plant and an acceleration from
 * rest in SECONDS, and pricing those seconds at 8-9 m/s says a man standing
 * half a metre off the disc is three metres short of it. That is tolerable for
 * gating a chase. It is useless for a decision whose whole content is a 0.73 m
 * band of reach, which is why every threshold built on it drifted below
 * standing reach until "not already at my feet" meant "dive".
 *
 * So measure the distance instead of inferring it from a time. He covers `d` in
 * `t` seconds; in the `arrival` seconds he actually has, he covers that
 * fraction of it. The linear split flatters a player starting from rest — he
 * covers less than half the ground in the first half of the run — so this reads
 * slightly SHORT of the true shortfall, which is the direction a last resort
 * should err in.
 */
function arrivalShortfall(d: number, t: number, arrival: number): number {
  return d * clamp(1 - arrival / Math.max(t, 1e-3), 0, 1);
}

/**
 * How much is riding on this disc, 0..1. A disc dropping in or near the endzone
 * is a goal whichever way it goes; one at midfield is a possession. Same idea
 * as `possessionValue`, one step later in the play — and it is symmetric, so
 * the defender covering that endzone reads exactly the same stakes the receiver
 * does.
 */
export function discStakes(z: number, attackDir: AttackDir): number {
  return clamp(1 - yardsToGoal(z, attackDir) / 25, 0, 1);
}

/**
 * Should this player leave his feet? `short` is `arrivalShortfall` measured
 * against the LAST CHANCE — how far from the disc he will still be standing at
 * the moment it drops out of the standing catch band for good. Three things
 * have to be true at once:
 *
 *   1. he cannot reach it on his feet (`short` past standing reach, plus the
 *      hesitation margin, which the stakes buy most of the way down);
 *   2. the dive actually reaches it — a bid at four metres is not brave, it is
 *      a player removing himself from the point for two seconds;
 *   3. that last chance falls inside the time the dive is airborne.
 *
 * `deadline` is seconds until the disc is unplayable; `stakes` is `discStakes`.
 * Agility does not appear: the rules engine's extension is flat, so a quicker
 * player earns his layouts by getting into the band, not by widening it.
 */
export function shouldBid(
  p: AIPlayer, short: number, deadline: number, stakes: number,
): boolean {
  if (!(deadline <= BID_LEAD)) return false;
  const need = STANDING_REACH + BID_HESITATION * (1 - 0.60 * clamp(stakes, 0, 1));
  return short > need && short < EXTENDED_REACH;
}

/**
 * Rough probability a possession starting `yards` from the goal line ends in a
 * score. This is the currency the thrower's decision model trades in: every
 * option — a 40 m score-throw, a 5 m dump — is priced as a change in it, and a
 * turnover is charged exactly what it costs, the disc.
 */
export function possessionValue(yards: number): number {
  /**
   * Past 64 the disc is INSIDE YOUR OWN ENDZONE and it keeps getting worse: a
   * turnover there is a goal against, not a field-position swing.
   *
   * `yardsToGoal` reaches 82 at the back of your own endzone, so clamping at 64
   * priced eighteen metres deep in your own endzone identically to standing on
   * your own goal line. The model literally could not see the difference, which
   * is why a legal-looking reset could walk an offence backwards over its own
   * line one locally-rational pass at a time (traced: -30.2, -36.1, -42.1,
   * -46.4). The geometry fix in `Playbook.buildCut` stops the cut being offered;
   * this stops it being wanted.
   */
  const core = 0.40 + 0.42 * (1 - clamp(yards, 0, 64) / 64);
  return core - 0.42 * clamp((yards - 64) / 18, 0, 1);
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
  /** Depth in the column at the moment the live cut was offered; -1 if none. */
  cutDepth: number;
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
  private formWant: FormationName = 'vertical';
  private formHold = 0;
  private anchor: Vec2 = { x: 0, z: 0 };
  private stackOrder: number[] = [];
  private handlerRing: number[] = [];
  /** Everyone, best hands first. The handler/cutter split is a prefix of this. */
  private rankedIds: number[] = [];
  private handlerStation = new Map<number, number>();
  private liveLanes = new Map<LaneKey, number>();
  private lastCutStart = -99;
  private decisionTimer = 0;
  private choice: ThrowOption | null = null;
  private windup = 0;
  private threwThisPossession = false;
  private throwCooldown = 0;
  private noGoodLook = false;
  /** Seconds the current carrier has actually held the disc. */
  private holdTime = 0;
  private holdCarrier: number | null = null;
  /**
   * The count the OFFENCE plays to.
   *
   * Normally this is the marker's stall count. But the count is produced by the
   * defence, and a defence that cannot establish a mark does not produce one —
   * and an offence whose only source of urgency is a number the opposition
   * failed to increment will stand there holding the disc forever. A whole
   * four-hundred-second match once sat motionless on exactly that: a marker
   * pinned on the sideline a few centimetres outside the stall radius, a count
   * frozen at 0.49, and fourteen players in a textbook formation waiting for
   * something that was never going to happen.
   *
   * So the offence also watches its own clock. `holdTime` is real seconds with
   * the disc in the hand, offset by more than the mark ever takes to establish
   * so that it never overtakes a healthy count: with a mark set in half a
   * second the count always leads, and this term changes nothing at all. It
   * only becomes the larger of the two when the count has stopped, and then it
   * bounds how long the deadlock can last to about eleven seconds — which is
   * what the count would have done.
   */
  private stallRead = 0;
  /** Smoothed read of which side the mark is giving up, -1..1. */
  private openRead = 0;
  /**
   * The side the offence is actually PLAYING to. Separate from `openRead`
   * because the whole shape — stack column, handler stations, which side every
   * cut attacks — hangs off it, and a shape that mirrors itself whenever the
   * marker's hips wobble is not a shape. It snaps once when the mark is first
   * seen, then needs sustained contrary evidence to flip.
   */
  private openCommit: Sign = 1;
  /**
   * The side a POSITIONAL force (middle / sideline) has committed to. Held
   * through `FORCE_DEADBAND` so the call does not chatter as the disc crosses
   * the middle of the field — see `openSideFor`. Null until the first call.
   */
  private forceSide: Sign | null = null;
  private forceSeen = false;

  /* defence */
  private scheme: 'person' | 'zone' = 'person';
  force: Force;
  private matchup = new Map<number, number>();   // defenderId -> offenceId
  private zoneRole = new Map<number, ZoneRole>();
  private stallClock = 0;
  /** Which defender the running count belongs to. */
  private stallMarker = -1;
  private markerId = -1;
  private deepHelpId = -1;

  /**
   * The stall count belongs to a mark that is actually THERE.
   *
   * The count advances only while the marker is inside `markMax`, and it goes
   * back to zero when the mark is handed to a DIFFERENT defender — a body
   * sprinting in from six metres has not established anything, and counting on
   * through the handover is both wrong by rule and the only thing that ever put
   * a "marker" four metres from the disc while the count ran.
   *
   * What this deliberately does NOT do is add a margin to the threshold the
   * count starts at. An earlier version required the marker inside
   * `markMax - 0.35` to begin, which is nearer than the radius the disc-space
   * guard backs him out to — so a marker who had once been too close could
   * never start the count, the thrower was never put under pressure, no cutter
   * ever went, and the entire match sat motionless for four hundred seconds.
   * The start condition and the standing geometry are not allowed to disagree.
   */
  private tickStall(clock: number, markDist: number, dt: number): number {
    return markDist <= PLAY.markMax ? clock + dt : clock;
  }

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
    this.openCommit = this.openRead >= 0 ? 1 : -1;
  }

  /** Current stall count the marker has reached (0 when not marking). */
  get stall(): number { return this.stallClock; }
  get currentScheme(): 'person' | 'zone' { return this.scheme; }
  get currentFormation(): FormationName { return this.formation; }
  /** X sign of the open side, as this team currently understands it. */
  get openSign(): Sign { return this.openCommit; }
  /** X of the column this team's stack is built on. Telemetry for the HUD. */
  get stackAxisX(): number {
    return stackColumnX(this.formation, this.anchor, this.openCommit);
  }
  /** Telemetry: cutter ids currently HOLDING the stack, front to back. */
  stackHolding(): number[] {
    const out: number[] = [];
    for (const id of this.stackOrder) if (this.m(id).cutState === 'stack') out.push(id);
    return out;
  }
  /** Telemetry: the handler the offence would reset to, or -1. */
  get resetHandler(): number {
    for (const id of this.handlerRing) {
      if (this.handlerStation.get(id) === 0) return id;
    }
    return this.handlerRing.length ? this.handlerRing[0] : -1;
  }
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

  /* ====================================================== command channel */

  /**
   * THE callCut ENTRY POINT — the one way anything outside this file may steer
   * an offensive player, and deliberately the only one.
   *
   * A human holding a direction on the aim stick (`ReceiverIntent.callCut`,
   * produced by `src/input/Human.ts` after `cutHoldTime`) is giving an order,
   * not driving a body: "you, go there". The order has to become a real cut —
   * a setup step the wrong way, a plant, a hard break into space, a lane
   * claimed so nobody else runs into it — or the commanded receiver moves
   * differently from the other six and the offence stops reading as a shape.
   * So the command is expressed in exactly the vocabulary the AI already runs:
   * `buildCut()` constructs the route, `Mem.cut` / `cutState` drive it, and
   * `tickCutters` / `tickHandlerCuts` / `cutterIntent` execute and retire it
   * with no knowledge that a human asked for it.
   *
   * Contract:
   *   - `dirX`/`dirZ` are a WORLD XZ direction (need not be unit). It is
   *     resolved to one of the seven `CutKind`s by where it points relative to
   *     this team's attacking direction and current open side — downfield is a
   *     deep (a strike in the endzone set), backfield is a dump or a swing,
   *     across is an under or a break-under, and a handler pushing up the line
   *     gets the up-line.
   *   - The commanded cut OUTRANKS an AI cut already holding the same lane:
   *     that player is sent to clear. Lane exclusivity is the invariant that
   *     keeps two cutters out of one piece of field, and it survives here.
   *   - Idempotency is the CALLER's job. Every call rebuilds the route and
   *     restarts it at `setup`; call it on the edge of the hold, not every
   *     step, or the receiver will jog the setup step forever.
   *   - Safe to call before the first `update()`: it no-ops until the roster
   *     has been seen.
   *
   * Returns the route that was committed, or null if the command was refused
   * (unknown player, wrong team, degenerate direction).
   */
  commandCut(receiverId: number, dirX: number, dirZ: number, disc: Vec2): CutRoute | null {
    const p = this.byId.get(receiverId);
    if (!p || p.team !== this.team) return null;
    const l = Math.hypot(dirX, dirZ);
    if (!(l > 1e-3)) return null;

    const ux = dirX / l;
    const uz = dirZ / l;
    const dir = this.dir;
    const openSign = this.openSign;
    const downfield = dir * uz;                       // +1 = straight at the goal
    const side: Sign = (Math.sign(ux) || openSign) as Sign;
    const isHandler = this.handlerRing.includes(receiverId);

    let kind: CutKind;
    if (downfield > 0.55) {
      kind = this.formation === 'endzone' ? 'strike' : 'deep';
    } else if (downfield < -0.30) {
      kind = Math.abs(ux) > 0.72 ? 'swing' : 'dump';
    } else if (isHandler && Math.abs(ux) > 0.50) {
      kind = 'up-line';
    } else {
      kind = side === openSign ? 'under' : 'break-under';
    }

    const cut = buildCut(kind, { x: p.pos.x, z: p.pos.z }, disc, dir, openSign, side, this.rng.next());

    /**
     * A commanded cut has to be somewhere to RUN to.
     *
     * `buildCut` places the target from the receiver's own position and the
     * disc, and for some geometries — a handler already standing where his
     * up-line would take him, most often — it resolves within a stride of his
     * feet. That is not a route: the cutter arrives on the frame he departs,
     * the lane is claimed and released immediately, and the player who asked
     * for a cut sees nothing happen. Push a degenerate target out along the
     * commanded direction so the request always produces a real movement.
     */
    const rx = cut.target.x - p.pos.x;
    const rz = cut.target.z - p.pos.z;
    const rl = Math.hypot(rx, rz);
    if (rl < MIN_CUT_RUN) {
      const ex = rl > 1e-3 ? rx / rl : ux;
      const ez = rl > 1e-3 ? rz / rl : uz;
      cut.target.x = p.pos.x + ex * MIN_CUT_RUN;
      cut.target.z = p.pos.z + ez * MIN_CUT_RUN;
    }

    const m = this.m(receiverId);
    if (m.cut && this.liveLanes.get(m.cut.lane) === receiverId) this.liveLanes.delete(m.cut.lane);
    const holder = this.liveLanes.get(cut.lane);
    if (holder !== undefined && holder !== receiverId) {
      const hm = this.m(holder);
      hm.cut = null;
      hm.cutState = 'clear';
      hm.cutT = 0;
      this.liveLanes.delete(cut.lane);
    }
    this.beginCut(receiverId, cut, 'setup');
    m.cutCooldown = 0;
    this.liveLanes.set(cut.lane, receiverId);
    return cut;
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
          id: p.id, cut: null, cutState: 'stack', cutT: 0, cutCooldown: 0, cutDepth: -1,
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
        id, cut: null, cutState: 'stack', cutT: 0, cutCooldown: 0, cutDepth: -1,
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
    this.holdTime = 0;
    this.holdCarrier = null;
    this.stallRead = 0;
    this.lastCarrier = null;
    this.lastCutStart = -99;
    this.forceSeen = false;
    for (const m of this.mem.values()) {
      m.cut = null; m.cutState = 'stack'; m.cutT = 0; m.cutCooldown = 0;
      m.poach = 0; m.poachHold = 0; m.bidCommit = false; m.flightCommit = -1;
    }
    this.anchor.x = world.disc.pos.x;
    this.anchor.z = world.disc.pos.z;

    // Roles: the best decision-makers with hands become handlers.
    const ranked = this.mates.slice().sort((a, b) => {
      const s = (p: AIPlayer) =>
        p.attr.decision * 1.0 + p.attr.throwAccuracy.backhand * 0.5 +
        p.attr.throwAccuracy.forehand * 0.5 + p.attr.throwPower * 0.25 +
        (p.archetype === 'handler' ? 60 : 0) - p.id * 1e-4;
      return s(b) - s(a);
    });
    this.rankedIds = ranked.map((p) => p.id);
    this.applyRoleSplit(world, true);

    if (world.possession !== this.team) {
      this.pickScheme(world);
      this.assignMatchups(world);
    }
  }

  /**
   * Split the roster into handlers and stack to match the formation actually
   * being run. This used to be a hard three handlers whatever the look, which
   * left the vertical stack — a five-cutter set — with only four bodies. Two
   * of those are always cutting and one is always clearing, so the column that
   * the whole sport is read by was chronically down to a body or two, and the
   * spare handler wandered behind the disc with nothing to do.
   */
  private applyRoleSplit(world: AIWorld, rebuild: boolean): void {
    const ranked = this.rankedIds.filter((id) => this.byId.has(id));
    if (ranked.length === 0) return;
    const want = Math.min(handlerCount(this.formation), ranked.length);
    const ring = ranked.slice(0, want);
    const cutters = ranked.slice(want);
    const same = ring.length === this.handlerRing.length
      && ring.every((id, i) => this.handlerRing[i] === id);
    if (same && !rebuild) return;

    // Handlers and cutters run different cut state machines. A player crossing
    // between them mid-cut would leave a lane reserved forever.
    if (!rebuild) {
      for (const id of ranked) {
        if (this.handlerRing.includes(id) !== ring.includes(id)) this.abandonCut(id);
      }
    }

    this.handlerRing = ring;
    for (const id of ranked) {
      const p = this.byId.get(id);
      if (p) p.role = ring.includes(id) ? 'handler' : 'cutter';
    }

    if (rebuild) {
      // Front of the stack is whoever is closest to the disc.
      const d = world.disc.pos;
      this.stackOrder = cutters.slice().sort((a, b) => {
        const pa = this.byId.get(a)!, pb = this.byId.get(b)!;
        return (dist2(pa.pos.x, pa.pos.z, d.x, d.z) - dist2(pb.pos.x, pb.pos.z, d.x, d.z))
          || (a - b);
      });
    } else {
      // Keep the order the stack already has; a demoted handler joins the back.
      const next = this.stackOrder.filter((id) => cutters.includes(id));
      for (const id of cutters) if (!next.includes(id)) next.push(id);
      this.stackOrder = next;
    }

    this.handlerStation.clear();
    this.assignHandlerStations(world);
  }

  /** Drop a cut on the floor and release its lane. */
  private abandonCut(id: number): void {
    const m = this.m(id);
    if (m.cut) {
      const holder = this.liveLanes.get(m.cut.lane);
      if (holder === id) this.liveLanes.delete(m.cut.lane);
    }
    m.cut = null;
    m.cutState = 'stack';
    m.cutT = 0;
    m.cutCooldown = 0.4;
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
    this.refreshStackSlots(dt);

    // Disc on the ground: nearest player picks it up, the rest re-form.
    if (disc.state === 'ground') {
      let best: AIPlayer | null = null; let bd = 1e9;
      for (const p of this.mates) {
        const d = dist2(p.pos.x, p.pos.z, disc.pos.x, disc.pos.z);
        if (d < bd) { bd = d; best = p; }
      }
      /**
       * A turnover very often leaves the disc ON the line, and this is the one
       * target in the file that was not clamped inside it. It has to be.
       * `boundaryRoom` measures room along a ray, so a body standing on the
       * perimeter and pointed even slightly further out has ZERO room — and the
       * speed cap built on it is a cap on total speed, not on the outward
       * component. A collector who arrives level with a sideline disc is
       * therefore frozen in every direction, including the one he needs, and
       * the match never restarts: measured over twelve 400 s seeds, one wedged
       * for 103 s with the collector 6.35 m away and stationary.
       *
       * Send him to the nearest spot he can legally stand on instead. That is
       * inside `PICKUP_RADIUS` of anything resting on the chalk, so the pickup
       * still fires from there.
       */
      const cp = clampToField({ x: disc.pos.x, z: disc.pos.z }, 0.75);
      for (const p of this.mates) {
        if (p === best) {
          out.push(this.intent(p, cp.x, cp.z, 0, dir, 'sprint', 1.0,
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

    this.readForce(world, dt);
    const windSpeed = Math.hypot(world.wind.x, world.wind.z);
    // Formation calls are held for a beat before they are honoured. The
    // triggers are thresholds on the disc position, and a disc sitting on one
    // of them made the whole stack slide 20 m across the field and back at
    // whatever rate the thrower pivoted. A shape that teleports is not a shape.
    const want = chooseFormation(this.anchor, dir, this.cfg.formation, windSpeed, this.openSign);
    if (want === this.formation) {
      this.formWant = want;
      this.formHold = 0;
    } else {
      if (want !== this.formWant) { this.formWant = want; this.formHold = 0; }
      this.formHold += dt;
      if (this.formHold >= 0.6) {
        this.formation = want;
        this.formHold = 0;
        this.applyRoleSplit(world, false);
      }
    }

    if (disc.state === 'flight') return this.offenceInFlight(world, dt);

    const thrower = disc.carrier != null ? this.byId.get(disc.carrier) ?? null : null;
    if (thrower && thrower.id === this.holdCarrier) this.holdTime += dt;
    else { this.holdCarrier = thrower ? thrower.id : null; this.holdTime = 0; }
    this.stallRead = Math.max(disc.stall, this.holdTime - 2.5);
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
        // The thrower holds his ground — but he is the one body in the game
        // asked to stand still next to a defender pressing in, and a pivot on
        // the sideline can be nudged over the line by contact separation with
        // no intent that ever brings him back. So his "stand here" is the
        // nearest legal point, and he steps in if he is not on one.
        const foot = clampToField({ x: p.pos.x, z: p.pos.z }, FIELD.edgeMargin + 0.25);
        const outBy = Math.hypot(foot.x - p.pos.x, foot.z - p.pos.z);
        out.push(this.intent(p, foot.x, foot.z, fx, fz,
          throwAction ? 'throw' : this.choice ? 'throw' : 'pivot',
          outBy > 0.05 ? 0.22 : 0,
          throwAction, { role: 'thrower', state: this.choice ? 'windup' : 'pivot', lane: null }, dt));
        continue;
      }
      out.push(this.cutterIntent(p, world, dt));
    }
    return out;
  }

  /**
   * Infer the force from where the mark is actually standing.
   *
   * The first sight of the mark in a possession is taken at face value — a
   * team is told the force before the pull, and the offence should not spend
   * two seconds working it out. After that it takes sustained contrary
   * evidence to flip, because `openSign` is the axis the entire shape is
   * built on: the stack column, both handler stations and the side every cut
   * attacks. A shape that mirrors itself every time the marker shuffles is
   * not a shape, and it is the difference between "the offence is playing a
   * force" and "the offence is milling about".
   */
  private readForce(world: AIWorld, dt: number): void {
    const disc = world.disc;
    if (disc.carrier == null) return;
    const t = this.byId.get(disc.carrier);
    if (!t) return;
    let markX = 0; let bd = 3.6;
    for (const f of this.foes) {
      const d = dist2(f.pos.x, f.pos.z, t.pos.x, t.pos.z);
      if (d < bd) { bd = d; markX = f.pos.x - t.pos.x; }
    }
    // Too far off or square in front: the marker is not saying anything yet.
    if (!(bd < 3.6 && Math.abs(markX) > 0.45)) return;
    // The mark stands on the side it is taking away, so open is the other side.
    const observed = (-Math.sign(markX)) as Sign;

    if (!this.forceSeen) {
      this.forceSeen = true;
      this.openRead = observed;
      if (this.openCommit !== observed) {
        this.openCommit = observed;
        this.assignHandlerStations(world);
      }
      return;
    }
    const k = Math.min(1, dt / 0.45);
    this.openRead = clamp(this.openRead + (observed - this.openRead) * k, -1, 1);
    if (this.openRead * this.openCommit < 0 && Math.abs(this.openRead) > 0.55) {
      this.openCommit = (this.openRead >= 0 ? 1 : -1) as Sign;
      this.assignHandlerStations(world);
    }
  }

  /* ---------------------------------------------------------- stations */

  private assignHandlerStations(world: AIWorld): void {
    const stations = formationStations(this.formation, this.anchor, this.dir, this.openSign)
      .filter((s) => s.role === 'handler');
    const throwerId = world.disc.carrier;
    const ids = this.handlerRing.filter((id) => id !== throwerId && this.byId.has(id));
    this.handlerStation.clear();
    // Fill stations IN ORDER, nearest free handler to each. Station 0 is the
    // reset; with two handlers and one of them holding the disc there is only
    // ever one body to place, and it has to be the one the dump goes to.
    // Greedy-by-handler filled whichever station happened to be closer, which
    // is how a reset ends up standing in front of the disc.
    for (let s = 0; s < stations.length && ids.length; s++) {
      let bi = 0; let bd = 1e9;
      for (let i = 0; i < ids.length; i++) {
        const p = this.byId.get(ids[i])!;
        const d = dist2(p.pos.x, p.pos.z, stations[s].x, stations[s].z);
        if (d < bd) { bd = d; bi = i; }
      }
      this.handlerStation.set(ids[bi], s);
      ids.splice(bi, 1);
    }
  }

  /**
   * Which slot in the column each cutter holds — over the cutters actually
   * STANDING IN IT, not over the whole squad. Two things are being fixed here.
   *
   * Counting absent bodies leaves a 4.2 m hole wherever somebody is away
   * cutting, so a five-man stack with two cuts out reads as three people with
   * no relationship to each other. Real stacks collapse to fill.
   *
   * And the slots are handed out in PHYSICAL order down the column, not by
   * squad rank, so filling in never asks two settled players to swap through
   * each other. A player on his way back from a cut is sorted to the tail,
   * because the tail is where a clear goes.
   */
  private slotOf = new Map<number, number>();
  private slotScratch: number[] = [];
  private slotSig = -1;
  private slotPending = -1;
  private slotPendingT = 0;

  private refreshStackSlots(dt: number): void {
    const holders = this.slotScratch;
    holders.length = 0;
    let sig = 17;
    for (const id of this.stackOrder) {
      const st = this.m(id).cutState;
      if (st === 'stack' || st === 'clear') { holders.push(id); sig = sig * 31 + id; }
    }
    // Slots are piecewise constant: they are re-dealt when somebody joins or
    // leaves the column, not continuously. Re-sorting by depth every frame lets
    // two bodies of nearly equal depth trade places at 120 Hz, which converges
    // them onto each other instead of onto their slots. A stack re-forms on an
    // event; it does not renegotiate itself every step.
    if (sig === this.slotSig) { this.slotPending = sig; this.slotPendingT = 0; return; }
    if (sig !== this.slotPending) { this.slotPending = sig; this.slotPendingT = 0; }
    this.slotPendingT += dt;
    // And it re-forms once, not twice. A cut that starts and a cut that ends
    // 200 ms apart would otherwise shuffle every body 4.2 m up the column and
    // then 4.2 m back down it. A body with no slot at all is dealt in at once.
    let orphan = false;
    for (const id of holders) if (!this.slotOf.has(id)) { orphan = true; break; }
    if (!orphan && this.slotPendingT < 0.35) return;
    this.slotSig = sig;
    /**
     * Slots are dealt by depth, which is right for a column. A ROW WANTS TO BE
     * ORDERED ACROSS THE FIELD instead — in a horizontal set all four cutters
     * stand at the same z, so sorting by depth sorts them by noise and a body
     * can be handed the lane on the far side of the field.
     *
     * Ordering by `pos.x` for spread sets was tried and REVERTED: it costs a
     * `test-ai` horizontal-shape assertion (49/3 -> 48/4), and applied to the
     * endzone set as well it dropped the human's directional receiver select
     * from agreeing with the stick 75%+ of the time to 67-69% across seeds,
     * because two cutters end up near-equal on angle and the openness term
     * decides instead. Re-ordering who stands where is not worth "the game
     * selected someone other than the man I pointed at" one time in three.
     *
     * The collapse fix in the `clear` branch below is the half that mattered
     * and it does ship: it stops a 22 m-wide set being funnelled to x = 0.
     */
    const key = (q: number): number => {
      const p = this.byId.get(q);
      if (!p) return 1e9;
      const clearing = this.m(q).cutState === 'clear' ? 1e5 : 0;
      return clearing + this.dir * (p.pos.z - this.anchor.z);
    };
    holders.sort((a, b) => (key(a) - key(b)) || (a - b));
    this.slotOf.clear();
    for (let i = 0; i < holders.length; i++) this.slotOf.set(holders[i], i);
  }

  private stackSlot(id: number): number {
    const s = this.slotOf.get(id);
    return s ?? Math.max(0, this.slotOf.size);
  }

  /** How many cutters are holding the column right now. */
  private stackedCount(): number {
    let n = 0;
    for (const id of this.stackOrder) if (this.m(id).cutState === 'stack') n++;
    return n;
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
    const si = this.stackOrder.includes(p.id) ? this.stackSlot(p.id) : cutters.length - 1;
    const slot: Station | undefined = cutters[clamp(si, 0, cutters.length - 1)];
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
          // A clear is finished when the body is OUT OF THE LANE, not when it
          // has jogged all the way to the back of the stack. Waiting for the
          // latter kept every cutter in the "clearing" state for most of the
          // possession and emptied the column; the lane is vacated the moment
          // he is back on the line of the stack.
          const back = this.stationFor(p, world);
          const axis = this.stackAxisX;
          const lat = Math.abs(p.pos.x - axis);
          const d = dist2(p.pos.x, p.pos.z, back.x, back.z);
          if (lat < 3.2 || d < 2.4 || m.cutT >= 2.2) {
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
    // The stack has to survive the cut. At stall 8 the shape stops mattering
    // and getting rid of the disc starts to; before then, a cutter who would
    // leave fewer than `stackHold` bodies in the column stays where he is.
    const hold = this.stallRead >= 8 ? PLAY.stackHold - 2
      : this.stallRead >= 6 ? PLAY.stackHold - 1 : PLAY.stackHold;
    if (this.stackedCount() - 1 < hold) return;

    const openSign = this.openSign;
    const brk = -openSign as Sign;
    const stall = this.stallRead;
    let best: { id: number; cut: CutRoute; score: number; depth: number } | null = null;

    for (const id of this.stackOrder) {
      const p = this.byId.get(id);
      if (!p) continue;
      const m = this.m(id);
      if (m.cutState !== 'stack' || m.cutCooldown > 0) continue;

      const from: Vec2 = { x: p.pos.x, z: p.pos.z };
      const kinds: Array<{ kind: CutKind; side: Sign }> = [];
      /**
       * WHICH CUT YOU MAKE IS DECIDED BY WHERE YOU STAND, not by your place in
       * `stackOrder`, which `endCut` rotates on every clear — that says who cut
       * least recently, a fairness counter rather than a position on the field.
       * `stackSlot` is the geometric one: it is what `stationFor` uses to place
       * the body, so slot 0 is the man actually standing at the front.
       */
      const depth = this.stackSlot(id);
      const nCol = Math.max(1, this.slotOf.size);
      if (this.formation === 'endzone') {
        kinds.push({ kind: 'strike', side: openSign }, { kind: 'strike', side: brk });
      } else if (!hasColumn(this.formation)) {
        /**
         * A ROW HAS NO FRONT AND NO BACK. In a horizontal set all four cutters
         * stand at the same depth, so a depth rule sorts them by noise; the
         * shape exists to give each of them the same two options in their own
         * lane — four isolated one-on-ones across the width of the field. The
         * lane system is what stops them clogging, and it already does.
         */
        kinds.push({ kind: 'deep', side: openSign });
        kinds.push({ kind: 'under', side: openSign });
        kinds.push({ kind: 'break-under', side: brk });
      } else {
        /**
         * THE FRONT OF THE STACK GOES DEEP AND THE BACK COMES UNDER. This was
         * exactly backwards, and it is the rule the whole shape is built on.
         *
         * A vertical stack manufactures two spaces: the under, between the disc
         * and the front of the column, and the deep, behind the back of it. Who
         * attacks which is decided by where the defence has to stand. The man
         * at the FRONT is marked from in front — his defender is between him
         * and the disc, protecting the under — so his open cut is the one that
         * runs away, deep, past the whole column into the space nobody is in.
         * The man at the BACK is marked from behind, because his defender is
         * the last line and is protecting the deep space he is nearest — so his
         * open cut is the one coming back, and it is the longest gainer in the
         * sport that is not a huck.
         *
         * Inverted, every cut in the game was contested by construction: the
         * front cutter came under into his own defender's chest, and the back
         * cutter went deep into the only man on the field already standing
         * behind him.
         */
        if (depth <= 1) {
          kinds.push({ kind: 'deep', side: openSign });
          kinds.push({ kind: 'deep', side: brk });
        }
        if (depth >= nCol - 2) {
          kinds.push({ kind: 'under', side: openSign });
          kinds.push({ kind: 'break-under', side: brk });
        }
        if (kinds.length === 0) kinds.push({ kind: 'under', side: openSign });
      }

      for (const kc of kinds) {
        const j = this.rng.next();
        const cut = buildCut(kc.kind, from, disc, dir, openSign, kc.side, j);
        if (this.liveLanes.has(cut.lane)) continue;
        if (!this.laneClearOfLiveTargets(cut)) continue;
        const s = this.scoreCut(p, cut, world, depth, stall);
        if (!best || s > best.score) best = { id, cut, score: s, depth };
      }
    }

    if (best && best.score > 0.18) {
      // The depth recorded is provably the depth that was scored, rather than a
      // second reading of `stackSlot` that only happens to agree.
      this.beginCut(best.id, best.cut, 'setup', best.depth);
      this.liveLanes.set(best.cut.lane, best.id);
      this.lastCutStart = world.time;
    }
  }

  /**
   * Commit a player to a route. THE ONE PLACE `m.cut` IS ARMED.
   *
   * `cutDepth` is telemetry the shape assertions are built on, and it is a
   * property OF THE CUT — which position in the column offered it — so it has
   * to be written and cleared with the cut, not near it. It was set at one of
   * the three sites that arm a route, so a handler's dump and a human-commanded
   * cut both published whatever depth that player last happened to cut from as
   * a stack cutter: measured, 249 dumps reporting a mean stack depth of 1.00.
   *
   * Depth is meaningless for a cut that did not come out of the column, and -1
   * says so rather than lying with a stale number.
   */
  private beginCut(id: number, cut: CutRoute, state: CutState, depth = -1): void {
    const m = this.m(id);
    m.cut = cut;
    m.cutState = state;
    m.cutT = 0;
    m.cutDepth = depth;
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
    p: AIPlayer, cut: CutRoute, world: AIWorld, depth: number, stall: number,
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

    // Fatigue and stack discipline. The discipline term follows the same rule
    // the offer does — deep belongs to the front of the column, under to the
    // back — so a cutter out of position for the cut he is offering is priced
    // down rather than silently allowed. It was the mirror of this, and so it
    // actively rewarded the inversion it was supposed to police.
    s *= (0.72 + 0.28 * p.energy);
    /**
     * Deliberately `!== 'horizontal'` and NOT `hasColumn`, which would also
     * exclude the endzone set. The endzone set is a row too, so on the face of
     * it the predicate belongs here — but the endzone row only ever offers
     * `strike`, and dropping the term for it moves reset-behind-disc 90.0% ->
     * 89.8%, just under its bar. That is a behaviour change with a measured
     * cost, not a tidy-up, so it is not being made as one.
     */
    if (this.formation !== 'horizontal') {
      const nCol = Math.max(1, this.slotOf.size);
      s -= 0.03 * Math.abs(depth - (deep ? 0 : nCol - 1));
    }
    return s;
  }

  /** Handler resets: dump, swing and the up-line when the mark breaks down. */
  private tickHandlerCuts(world: AIWorld, dt: number, thrower: AIPlayer | null): void {
    if (!thrower || world.disc.state !== 'held') return;
    const stall = this.stallRead;
    const disc = { x: world.disc.pos.x, z: world.disc.pos.z };
    const openSign = this.openSign;

    // Is the mark beaten? Either too far off, or standing on the wrong side.
    let markDist = 99; let markSide = 0;
    for (const f of this.foes) {
      const d = dist2(f.pos.x, f.pos.z, thrower.pos.x, thrower.pos.z);
      if (d < markDist) { markDist = d; markSide = Math.sign(f.pos.x - thrower.pos.x); }
    }
    const markBeaten = markDist > 2.9 || (markSide !== 0 && markSide === openSign);

    // How many bodies are behind the disc at all. A vertical stack runs two
    // handlers, so when one has the disc the other IS the reset — and if he
    // goes up the line there is suddenly nothing behind the thrower at all.
    // Nobody vacates the reset unless somebody else is already there.
    let behindCount = 0;
    for (const q of this.mates) {
      if (q.id === thrower.id) continue;
      if (this.dir * (q.pos.z - world.disc.pos.z) < 1.0) behindCount++;
    }

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
          const done = d < 1.2 || m.cutT >= cut.maxTime;
          const beingThrownTo = this.choice?.receiverId === id;
          /**
           * THE UP-LINE ABORTS BACK TO THE RESET. This is the whole of F8 and
           * it is a behaviour, not a threshold.
           *
           * The up-line is what coaching material calls the handler's primary
           * move, and it was all but unreachable: it required two bodies behind
           * the disc, and a two-handler vertical stack has exactly one once the
           * other is holding it (measured mean 1.02). Loosening that count was
           * tried and reverted, correctly — it let the only reset leave and
           * never come back, and reset-behind-disc fell 90.0% -> 84.8%.
           *
           * The count was never the problem. A real handler goes up the line
           * knowing he is the reset, and the contract is that if the disc does
           * not come he turns and is BACK in reset space a second later. He does
           * not jog to a station and re-queue; he plants and breaks back. With
           * that, the sole reset can go — his absence is bounded by the cut, and
           * the cut only fires below stall 4 because the dump branch above takes
           * everything from 4 up. So the exposure ends before the count that
           * needs him.
           *
           * The abort re-enters at `plant`, not `setup`: he is at full speed
           * already and what happens next is a change of direction, which is
           * also what the animation layer wants to see.
           */
          if (done && !beingThrownTo && cut.kind === 'up-line') {
            const back = buildCut('dump', { x: p.pos.x, z: p.pos.z }, disc, this.dir,
              openSign, -openSign as Sign, this.rng.next());
            // He KEEPS the reset lane he already holds. The abort is one player
            // continuing to occupy the reset space he never really left, so
            // there is no lane to acquire and none to contend for — an earlier
            // version tried to move him to `reset-break` and simply never fired,
            // because the other handler's dump is almost always holding it.
            this.beginCut(id, { ...back, lane: cut.lane }, 'plant');
          } else if (done) { this.endHandlerCut(id); }
        } else if (m.cutState === 'clear') {
          // Once the count is high the reset does not get to rest between
          // attempts — he keeps working until the disc moves. A handler who
          // resets once and then stands still is never open at stall 8, which
          // is the only moment the throw actually has to be there.
          const urgent = stall >= 6;
          if (m.cutT >= (urgent ? 0.35 : 0.8)) {
            m.cutState = 'stack'; m.cutT = 0; m.cut = null;
            m.cutCooldown = urgent ? 0.15 : 0.6;
          }
        }
        continue;
      }

      if (m.cutCooldown > 0) continue;
      const behind = this.dir * (p.pos.z - world.disc.pos.z) < 1.0;
      const from: Vec2 = { x: p.pos.x, z: p.pos.z };
      let kind: CutKind | null = null;
      let side: Sign = openSign;

      // The reset starts working at 4, not at 5.5. A handler who only moves
      // once the count is nearly out is a handler who is never open when the
      // throw has to go — and the reset being live is most of what makes the
      // back of the offence readable while the count climbs.
      if (behind && (stall >= 4.0 || this.noGoodLook)) {
        kind = 'dump'; side = -openSign as Sign;
      /**
       * THE COUNT STAYS AT TWO, AND THIS IS THE SECOND TIME THAT HAS BEEN
       * MEASURED RATHER THAN ASSUMED.
       *
       * The up-line is the handler's primary move with the dump as the
       * fallback, and `behindCount >= 2` is close to unsatisfiable in a
       * two-handler vertical stack: with one handler on the disc there is
       * exactly ONE body behind it (measured mean 1.02). So it almost never
       * fires, which looks like a bug.
       *
       * Round one relaxed the count alone and was reverted: the only reset left
       * and nothing brought him back. Reset-behind-disc fell 90.0% -> 84.8%,
       * in-position-at-high-stall 92.8% -> 89.8%, completion 77.0% -> 74.4%.
       * The conclusion recorded then was that the up-line needs an ABORT — a
       * handler who turns back into the reset when the throw does not come —
       * and not a looser number.
       *
       * Round two built the abort (see the `break` branch above) and relaxed
       * the count to 1 on top of it. Measured over the 4-seed shape run,
       * 126k held frames: with the abort AND the relaxation, reset-behind-disc
       * 84.2% and high-stall 89.7% — both still failing. With the abort and the
       * count left at 2, both assertions PASS, and the number of up-lines
       * actually run is unchanged at 6. The relaxation buys no up-lines and
       * costs the reset.
       *
       * So the abort ships and the count does not move. The abort is not
       * wasted: it is what makes the up-line safe to run at all, and the
       * horizontal stack — which is on the field now — carries the third
       * handler that satisfies this count honestly.
       */
      } else if (markBeaten && stall >= 1.2 && stall < 7 && behind && behindCount >= 2) {
        kind = 'up-line'; side = openSign;
      } else if (stall >= 3.5 && stall < 6 && behind && behindCount >= 2
        && this.rng.next() < 0.02) {
        kind = 'swing'; side = openSign;
      }
      if (!kind) continue;

      const lane: LaneKey = kind === 'dump' ? 'reset-break' : 'reset-open';
      if (this.liveLanes.has(lane)) continue;
      const cut = buildCut(kind, from, disc, this.dir, openSign, side, this.rng.next());
      // Force the reset lane label so downfield cuts never collide with it.
      const forced: CutRoute = { ...cut, lane };
      this.beginCut(id, forced, 'setup');
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
        // Clear SIDEWAYS out of the lane first, then run the column back to
        // the tail of the stack. Cutting a corner straight to the back station
        // drags the body diagonally through the throwing lane it was supposed
        // to be vacating, which is the difference between a cut resolving and
        // a cutter loitering in the way of the next one.
        const st = this.stationFor(p, world);
        /**
         * A HANDLER CLEARS TO THE BACKFIELD, NEVER TO THE STACK COLUMN.
         *
         * The column rule below is a cutter's rule: get out of the throwing
         * lane by rejoining the line. Applied to a handler it does the opposite
         * of what the reset is for — `stackAxisX` is about x = 0 and the clear
         * steers at `p.pos.z + dir * 1.2`, so a reset finishing a dump on the
         * open side was sent INTO the middle of the field and FORWARD, past the
         * disc, on every dead reset. He is the one player on the team whose job
         * is defined by being behind it.
         */
        if (p.role === 'handler' || !hasColumn(this.formation)) {
          // A ROW CLEARS BACK ALONG ITS OWN LANE. There is no column to run to,
          // and `stackAxisX` is about x = 0 for every set that is not a side
          // stack — so steering everybody at it collapsed a 22 m-wide endzone
          // set into a knot in the middle of the field on every dead cut, in
          // the one situation the broadcast camera is closest to.
          tx = st.x; tz = st.z;
          effort = 0.85; mode = 'sprint';
          break;
        }
        const axis = this.stackAxisX;
        const lat = p.pos.x - axis;
        if (Math.abs(lat) > 3.2) {
          tx = axis;
          tz = p.pos.z + dir * 1.2;
          effort = 0.92; mode = 'sprint';
        } else {
          tx = st.x; tz = st.z;
          effort = dist2(p.pos.x, p.pos.z, st.x, st.z) > 5 ? 0.7 : 0.5;
          mode = 'jog';
        }
        break;
      }
      default: {
        const st = this.stationFor(p, world);
        tx = st.x; tz = st.z;
        const d = dist2(p.pos.x, p.pos.z, tx, tz);
        // A handler out of position is a possession with no reset in it. After
        // a 20 m gain the handlers are a long way behind the disc and jogging
        // back at 70% means the thrower spends the first four seconds of the
        // stall with nothing behind him. Handlers hustle.
        if (p.role === 'handler') {
          effort = d > 10 ? 1.0 : d > 5 ? 0.82 : d > 2 ? 0.45 : 0.16;
          mode = d > 8 ? 'sprint' : d > 2 ? 'jog' : 'idle';
        } else {
          effort = d > 6 ? 0.7 : d > 2 ? 0.42 : 0.16;
          mode = d > 2 ? 'jog' : 'idle';
        }
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
      cutKind: cut?.kind ?? null, cutDepth: cut ? m.cutDepth : -1,
    }, dt);
  }

  /* --------------------------------------------------- thrower decision */

  private decide(world: AIWorld, thrower: AIPlayer): void {
    const opts = this.evaluateOptions(world, thrower);
    this.noGoodLook = opts.length === 0;
    if (opts.length === 0) { this.choice = null; return; }

    const stall = this.stallRead;
    // Decision noise: a poor decision-maker misvalues options.
    const noise = (1 - effectiveDecision(thrower) / 100) * 0.055;
    let best: ThrowOption | null = null;
    for (const o of opts) {
      const ev = o.ev + this.rng.gauss() * noise;
      if (!best || ev > best.ev) { o.ev = ev; best = o; }
    }
    if (!best) { this.choice = null; return; }

    /**
     * The bar for pulling the trigger. High (selective) under a low stall,
     * collapsing as the count climbs; at 8.5 the best available goes up.
     *
     * This was raised to -0.040 on the argument that "it is not a confidence
     * problem, it is a patience one." That over-corrected into a different
     * failure. Measured over a match at -0.040: MEAN RELEASE AT STALL 7.56, and
     * the modal throw — 35 of 73 — gained 0.35 m. The offence was fourteen
     * people holding a shape for seven seconds, then dumping, then repeating.
     * Swept across six seeds, THREE OF THEM SCORED NOTHING IN FIVE MINUTES
     * despite thirty throws each: the disc moved, but only sideways.
     *
     * The arithmetic says why. A routine 10 m open-side under from midfield
     * scores ev = -0.123, against a bar of -0.042 at stall 0 — so the
     * break-even completion for a plain 10 m gain sat near 91.5%, roughly
     * elite-league average. A thrower who only takes better-than-average
     * throws waits, and the count runs to 8. The code's own reset trigger is
     * stall 4.0, so the offence was spending most of every possession past the
     * point its own playbook says to bail out.
     *
     * Lower and flatter: the 85%/10 m under now clears at stall 0, a 75%/8 m
     * under still waits to about stall 6.3, and a 55%/20 m huck still never
     * clears before 8.5. Completion percentage is expected to FALL a few points
     * — real offences complete about 90%, not 100% — while yards per throw
     * roughly doubles. That trade is the whole point.
     */
    const hold = stall >= 8.5
      ? -1e9
      : (-0.135 - 0.26 * Math.pow(clamp(stall, 0, 10) / 10, 2)) * this.cfg.aggression;
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

  /**
   * The closest this player can be to the disc at ANY moment it is still
   * catchable on his feet — the number that decides whether a layout was
   * necessary at all.
   *
   * A flight offers a whole window, not an instant: the disc drops into the
   * standing band at the rendezvous and stays in it until `CATCH_DEAD`, and a
   * receiver only has to be on it once. Judging him at one end of that window
   * is what left three quarters of the surviving bids diving for discs they
   * went on to catch upright a tenth of a second later. The window is short
   * enough that the best moment is always at one of its two ends, so two
   * `timeToReach` solves settle it — the earliest chance (nearest, least time)
   * and the last one (furthest, most time).
   */
  private bidShortfall(p: AIPlayer, land: CatchPoint): number {
    const early = arrivalShortfall(
      dist2(p.pos.x, p.pos.z, land.x, land.z), this.timeToReach(p, land.x, land.z), land.t);
    const late = arrivalShortfall(
      dist2(p.pos.x, p.pos.z, land.lastX, land.lastZ),
      this.timeToReach(p, land.lastX, land.lastZ), land.lastT);
    return Math.min(early, late);
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
    const stakes = discStakes(land.z, this.dir);

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
        } else if (isTarget && shouldBid(p, this.bidShortfall(p, land), land.lastT, stakes)) {
          // You lay out for a disc you cannot otherwise reach — not for one you
          // can simply run down. `shouldBid` is the whole test; see the block
          // above `STANDING_REACH` for why each of its three clauses is there.
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
          mode, pace, action, { role: p.role, state: 'attack-disc', lane: null },
          dt, true));
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
    const disc = world.disc;
    const thrower = disc.carrier != null ? this.byId.get(disc.carrier) ?? null : null;
    // A positional force is re-read from the disc every step and latched, so
    // "force middle" actually swaps sides when the disc crosses the field.
    const fx = thrower ? thrower.pos.x : disc.pos.x;
    const openSign = openSideFor(this.force, odir, fx, this.forceSide);
    const brk = breakSideFor(this.force, odir, fx, this.forceSide);
    this.forceSide = openSign;

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

    // ---- stall clock. It STARTS only once the mark is properly set and then
    // survives small drift, rather than starting the instant the marker grazes
    // the stall radius on his way in. Without the margin the count can be
    // running while the marker is still outside 3 m, which is both wrong by
    // rule and the only thing that ever put him there.
    if (thrower && this.markerId >= 0) {
      if (this.markerId !== this.stallMarker) { this.stallMarker = this.markerId; this.stallClock = 0; }
      const mk = this.byId.get(this.markerId)!;
      const d = dist2(mk.pos.x, mk.pos.z, thrower.pos.x, thrower.pos.z);
      this.stallClock = this.tickStall(this.stallClock, d, dt);
    } else {
      this.stallClock = 0;
      this.stallMarker = -1;
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
        /* A marker who is on the wrong side of the thrower has to get to the
         * break side, and the straight line to the mark point goes through the
         * thrower. Steered at it directly he runs into disc space, the
         * disc-space guard shoves him back out radially — which preserves the
         * side he is already on — and he can sit there for the whole stall
         * forcing the wrong way. That is how a force ends up being a label on
         * a config object rather than a thing on the field.
         *
         * So the mark travels AROUND the thrower on the stand-off circle,
         * which is both legal and what a marker actually does. */
        const bearNow = Math.atan2(p.pos.z - thrower.pos.z, p.pos.x - thrower.pos.x);
        const bearWant = Math.atan2(mp.z - thrower.pos.z, mp.x - thrower.pos.x);
        let dBear = bearWant - bearNow;
        while (dBear > Math.PI) dBear -= 2 * Math.PI;
        while (dBear < -Math.PI) dBear += 2 * Math.PI;
        const radNow = dist2(p.pos.x, p.pos.z, thrower.pos.x, thrower.pos.z);
        // Only sweep from marking range. From further out the straight line is
        // the fast way in and does not cross disc space anyway; orbiting in
        // from 5 m would just keep him outside the stall radius for longer.
        if (Math.abs(dBear) > 0.45 && radNow < 4.2) {
          // Sweeping must also CLOSE: a marker orbiting at 4 m is not marking,
          // because the stall clock only runs inside `markMax`. So the target
          // sits ON the stand-off circle and only the BEARING is stepped —
          // the marker spirals in rather than orbiting out.
          const step = clamp(dBear, -0.65, 0.65);
          const r = PLAY.markDistance;
          tx = thrower.pos.x + Math.cos(bearNow + step) * r;
          tz = thrower.pos.z + Math.sin(bearNow + step) * r;
        }
        // Respect disc space: back out rather than crowd the thrower. The
        // check anticipates a step of travel so momentum cannot carry the
        // marker inside the legal radius.
        const ahead = 0.28;
        const fx = p.pos.x + p.vel.x * ahead - thrower.vel.x * ahead;
        const fz = p.pos.z + p.vel.z * ahead - thrower.vel.z * ahead;
        const cur = dist2(fx, fz, thrower.pos.x, thrower.pos.z);
        if (cur < PLAY.discSpace + 1.10) {
          // Back out ALONG THE CIRCLE toward the break side, not straight
          // outward: a purely radial retreat preserves whichever side the
          // marker is already on, so a marker who arrives open-side is pinned
          // there for the whole stall.
          const bail = bearNow + clamp(dBear, -0.55, 0.55);
          tx = thrower.pos.x + Math.cos(bail) * (PLAY.discSpace + 1.75);
          tz = thrower.pos.z + Math.sin(bail) * (PLAY.discSpace + 1.75);
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
    const disc = world.disc;
    const thrower = disc.carrier != null ? this.byId.get(disc.carrier) ?? null : null;
    const openSign = openSideFor(
      this.force, odir, thrower ? thrower.pos.x : disc.pos.x, this.forceSide);
    this.forceSide = openSign;

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
      if (markerId !== this.stallMarker) { this.stallMarker = markerId; this.stallClock = 0; }
      const mk = this.byId.get(markerId);
      const dd = mk ? dist2(mk.pos.x, mk.pos.z, thrower.pos.x, thrower.pos.z) : 99;
      this.stallClock = this.tickStall(this.stallClock, dd, dt);
    } else {
      this.stallClock = 0;
      this.stallMarker = -1;
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
    // A disc dropping in the endzone they are defending is a goal, so it is
    // worth the ground; one at midfield is a possession, and is not.
    const stakes = discStakes(land.z, odir);

    // Whoever gets there first is the man on the play. A second defender diving
    // in behind him blocks nothing and takes himself out of the point for two
    // seconds — that is a trailing defender, and trailing defenders stay up.
    const tOf = new Map<number, number>();
    let onPlay = -1; let bestT = 1e9;
    for (const p of this.mates) {
      const t = this.timeToReach(p, land.x, land.z);
      tOf.set(p.id, t);
      if (t < bestT) { bestT = t; onPlay = p.id; }
    }

    for (const p of this.mates) {
      const m = this.m(p.id);
      if (m.flightCommit !== this.flightEpoch) {
        m.flightCommit = this.flightEpoch;
        // One read per flight: awareness decides whether he ever sees a bid on
        // this disc at all. Whether one is warranted is re-asked every step,
        // because the geometry that decides it is still moving.
        m.bidCommit = this.rng.next() < 0.45 + 0.55 * (p.attr.defAwareness / 100);
      }
      const t = tOf.get(p.id) ?? this.timeToReach(p, land.x, land.z);
      const gap = (t - land.t) * effectiveMaxSpeed(p);
      const canPlay = gap < layoutExtend(p) + 0.5;

      if (canPlay) {
        let mode: MoveMode = 'sprint';
        let action: PlayerAction | null = null;
        if (gap <= 0.1 && land.y > 1.85 && land.y < reachHeight(p) + 0.4) {
          mode = 'jump'; action = { kind: 'jump', height: land.y };
        } else if (m.bidCommit && p.id === onPlay && land.y < 1.85
          && shouldBid(p, this.bidShortfall(p, land), land.lastT, stakes)) {
          mode = 'layout';
          action = { kind: 'bid', x: land.x, z: land.z, extend: layoutExtend(p) };
        }
        const c = clampToField({ x: land.x, z: land.z }, 0.45);
        out.push(this.intent(p, c.x, c.z, land.x - p.pos.x, land.z - p.pos.z,
          mode, 1.0, action, { role: 'defender', state: 'read-disc', lane: null },
          dt, true));
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

  /**
   * Where and when the disc becomes catchable. Uses the disc peer if present.
   *
   * The floor matters more than it looks. Most throws in this game never rise
   * above `CATCH_CEILING` at all — the release is at ~1.35 m and a flat forehand
   * stays under it for its whole flight — so the descending-through-the-ceiling
   * branch never fires and the whole rendezvous falls through to the floor.
   * With the floor at 0.12 m that made the target THE POINT WHERE THE DISC HITS
   * THE TURF, which Game.ts will not award a standing catch at (`bot` there is
   * ground + 0.20 m). Measured: 80% of all layouts were bids for a disc whose
   * predicted catch point was below 0.2 m. The offence was not diving because
   * it was beaten; it was diving because it had been sent to meet the disc on
   * the floor, and only a body already prone can catch it there.
   *
   * `CATCH_FLOOR` is the lowest the rendezvous is allowed to be: shin height,
   * comfortably inside the standing band, with room left for the last stride.
   *
   * `last*` is a second, later point on the same flight — where the disc drops
   * out of the standing band entirely. Running to the rendezvous is what a
   * receiver DOES; beating the last chance to it is the only thing that makes
   * a layout necessary. See `shouldBid`.
   */
  private predictCatchPoint(world: AIWorld): CatchPoint {
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
        let met: FlightSample | null = null;
        let dead: FlightSample = path[path.length - 1] ?? path[0];
        for (let i = 1; i < path.length; i++) {
          const s = path[i];
          if (!met && ((s.y <= CATCH_CEILING && path[i - 1].y > CATCH_CEILING)
            || s.y <= CATCH_FLOOR)) met = s;
          if (s.y <= CATCH_DEAD) { dead = path[i - 1]; break; }
        }
        const m = met ?? dead;
        if (m) {
          return {
            x: m.x, y: m.y, z: m.z, t: m.t,
            lastX: dead.x, lastZ: dead.z, lastT: Math.max(dead.t, m.t),
          };
        }
      }
    }
    // Fallback glide integrator: gravity partly offset by lift, light drag.
    let x = world.disc.pos.x, y = world.disc.pos.y, z = world.disc.pos.z;
    let vx = world.disc.vel.x, vy = world.disc.vel.y, vz = world.disc.vel.z;
    const h = 1 / 60;
    let met: { x: number; y: number; z: number; t: number } | null = null;
    for (let t = 0; t < 6; t += h) {
      vy -= 3.1 * h;
      const drag = 1 - 0.11 * h;
      vx *= drag; vz *= drag;
      x += vx * h; y += vy * h; z += vz * h;
      if (!met && y <= CATCH_CEILING && vy < 0) {
        met = { x, y: Math.max(y, CATCH_FLOOR), z, t: t + h };
      }
      if (y <= CATCH_DEAD) {
        const m = met ?? { x, y: Math.max(y, CATCH_FLOOR), z, t: t + h };
        return { ...m, lastX: x, lastZ: z, lastT: Math.max(t + h, m.t) };
      }
    }
    const m = met ?? { x, y: Math.max(y, CATCH_FLOOR), z, t: 6 };
    return { ...m, lastX: x, lastZ: z, lastT: Math.max(6, m.t) };
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
    debug: {
      role: string; state: string; lane: LaneKey | null;
      cutX?: number; cutZ?: number; cutKind?: CutKind | null; cutDepth?: number;
    },
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
      arriveRadius: settle ? 1.5 : mode === 'sprint' ? 0.6 : mode === 'mark' ? 1.5 : 1.1,
      personalSpace: 0.72,
      action,
      debug: {
        role: debug.role, state: debug.state, lane: debug.lane,
        cutX: debug.cutX ?? NaN, cutZ: debug.cutZ ?? NaN,
        cutKind: debug.cutKind ?? null, cutDepth: debug.cutDepth ?? -1,
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
