import * as THREE from 'three';

/**
 * Shared vocabulary for the locomotion model. Nothing in here imports the
 * engine — these are plain data types so the model can be unit-tested headless.
 */

/* ------------------------------------------------------------------ states */

export type LocoStateName =
  /* grounded, under control */
  | 'idle'
  | 'jog'
  | 'run'
  | 'sprint'
  | 'backpedal'
  | 'shuffle'
  | 'cut'
  /* airborne */
  | 'jump'
  | 'layout'
  /* not under control */
  | 'landing'
  | 'recovery'
  | 'fall'
  | 'stumble';

/** States in which the player cannot be given new movement orders. */
export const COMMITTED_STATES: ReadonlySet<LocoStateName> = new Set<LocoStateName>([
  'jump', 'layout', 'landing', 'recovery', 'fall',
]);

/** States in which the player is effectively out of the play. */
export const UNAVAILABLE_STATES: ReadonlySet<LocoStateName> = new Set<LocoStateName>([
  'layout', 'landing', 'recovery', 'fall',
]);

export type MoveMode = 'auto' | 'sprint' | 'run' | 'jog' | 'backpedal' | 'shuffle';

/* -------------------------------------------------------------- attributes */

/**
 * Raw player ratings, 0..100 (Madden-style). `height` is metres and `mass` is
 * kilograms — those two are physical, not ratings.
 */
export interface Attributes {
  /** Top-end straight-line speed. */
  speed: number;
  /** Burst / how fast top speed is reached, and how hard they can brake. */
  accel: number;
  /** Lateral grip, cut sharpness, plant duration, turn rate. */
  agility: number;
  /** Wins contact, resists being moved, boxes out. */
  strength: number;
  /** Vertical leap. */
  vertical: number;
  /** Stamina pool drain/recovery rate. */
  endurance: number;
  /** Resists stumbling and falling on contact; shortens get-ups. */
  balance: number;
  /** Metres. */
  height: number;
  /** Kilograms. */
  mass: number;
}

export const DEFAULT_ATTRS: Attributes = {
  speed: 70, accel: 70, agility: 70, strength: 60,
  vertical: 65, endurance: 70, balance: 70,
  height: 1.83, mass: 82,
};

/** Everything the physics step actually reads, after ratings + fatigue + slope. */
export interface Derived {
  /** Flat-out sprint cap (m/s), fatigue applied. */
  topSpeed: number;
  /** Cap for the currently selected movement mode (m/s). */
  modeCap: number;
  /** Peak propulsive acceleration at v=0 (m/s^2). */
  accelMax: number;
  /** Peak braking acceleration (m/s^2). */
  brakeMax: number;
  /** Peak lateral (turning) acceleration (m/s^2). */
  gripMax: number;
  /** Max yaw rate (rad/s) at the current speed. */
  turnRate: number;
  /** Standing vertical leap (m). */
  jumpHeight: number;
  /** Fingertip height when standing flat-footed (m). */
  standingReach: number;
  /** Duration of a hard-cut foot plant (s). */
  plantDur: number;
  /** 0 = fresh, 1 = cooked. */
  fatigue: number;
  /** Multiplier already folded into topSpeed, exposed for HUD/debug. */
  slopeMul: number;
}

/* ------------------------------------------------------------- player state */

export interface FootState {
  /** Which foot most recently planted. */
  planted: 'L' | 'R';
  /** World position of that plant — animation IK target, turf scuff origin. */
  pos: THREE.Vector3;
  /** Sim time at which it planted. */
  t: number;
  /** True while that foot is still bearing load (stance phase). */
  contact: boolean;
  /** 0..1 through the current stride. */
  phase: number;
  /** Stride length used for the current step (m). */
  stride: number;
  /** True when this plant is the pivot of a hard cut. */
  hard: boolean;
  /** Speed at the moment of the plant (m/s) — audio uses this for weight. */
  speed: number;
}

export interface AirState {
  /** True while the centre of mass is off the ground. */
  airborne: boolean;
  /** Sim time of takeoff. */
  tTakeoff: number;
  /** Sim time the ballistic arc peaks. */
  tApex: number;
  /** Predicted peak COM height (world Y). */
  apexY: number;
  /** COM height at takeoff (world Y). */
  takeoffY: number;
  /** Predicted sim time of ground contact. */
  tLand: number;
  /** Vertical velocity at takeoff (m/s). */
  vy0: number;
}

export interface LocoPlayer {
  id: number;
  team: 0 | 1;
  attr: Attributes;

  /** World position of the centre of mass. Y is hip height above the surface. */
  pos: THREE.Vector3;
  /** World velocity. XZ is ground plane, Y only meaningful when airborne. */
  vel: THREE.Vector3;
  /** Yaw in radians, 0 = +Z, increasing toward +X. */
  facing: number;

  state: LocoStateName;
  /** Seconds spent in the current state. */
  stateT: number;
  /** Seconds remaining before the state can end (committed states). */
  stateDur: number;
  /** True while the body is on the ground rather than upright. */
  prone: boolean;

  /** 0..100. */
  stamina: number;

  foot: FootState;
  air: AirState;

  /** Surface height under the player's feet this step. */
  groundY: number;
  /** Surface normal under the player's feet this step. */
  groundN: THREE.Vector3;

  /** Collision radius (m). */
  radius: number;
  /** Hip height when standing (m). */
  hipHeight: number;

  /** Direction the cut is pivoting toward, valid while state==='cut'. */
  cutDir: THREE.Vector3;
  /** Entry speed of the current/last cut (m/s). */
  cutEntrySpeed: number;
  /** Turn angle of the current/last cut (radians). */
  cutAngle: number;

  /** Sim time this player last emitted a footstep — debounce for audio. */
  lastStepT: number;
  /** Monotonic per-player sim clock (seconds). */
  t: number;

  /** Scratch: last frame's derived capabilities, for debug/HUD. */
  derived: Derived;
}

/* ---------------------------------------------------------------- commands */

export interface Vec2Like { x: number; z: number }

/**
 * The AI system's per-frame movement request. Every field is optional; an empty
 * object means "stand still, keep facing".
 */
export interface DesiredMove {
  /** Desired travel direction in world XZ. Need not be normalised. */
  dir?: THREE.Vector3 | Vec2Like | null;
  /** Absolute target ground speed (m/s). Clamped to the mode cap. */
  speed?: number;
  /** Fraction of the mode cap, used when `speed` is omitted. Default 1. */
  effort?: number;
  /** Extra hard ceiling on ground speed (m/s) for this step. */
  maxSpeed?: number;
  /** Gait selection. 'auto' derives it from `dir` vs `face`. Default 'auto'. */
  mode?: MoveMode;
  /** Where the player wants to look. Defaults to the travel direction. */
  face?: THREE.Vector3 | Vec2Like | null;
  /** Request a vertical leap. Ignored unless grounded and controllable. */
  jump?: boolean;
  /** Request a layout. Committed the moment it is accepted. */
  layout?: boolean;
  /** Hard stop — overrides `speed` to 0 and uses full braking. */
  brake?: boolean;
}
