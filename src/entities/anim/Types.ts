import type * as THREE from 'three';
import type { BoneName } from '../rig/Types.ts';

/**
 * The animation system's vocabulary.
 *
 * Nothing here imports the simulation. `LocoLike` is a STRUCTURAL mirror of
 * `sim/Locomotion.ts`'s `LocoPlayer` — the animator never needs the class, only
 * the numbers it publishes, which keeps the two modules independently
 * authorable and lets a preview harness or a test drive the animator with a
 * plain object. `Animator.ts` carries a compile-time assertion that a real
 * `LocoPlayer` still satisfies this shape, so a divergence is a type error and
 * not a silent visual regression.
 */

/* ------------------------------------------------------------ sim mirror */

export type LocoStateLike =
  | 'idle' | 'jog' | 'run' | 'sprint' | 'backpedal' | 'shuffle' | 'cut'
  | 'jump' | 'layout' | 'landing' | 'recovery' | 'fall' | 'stumble';

export interface FootLike {
  /** Which foot most recently planted. */
  planted: 'L' | 'R';
  /** World position of that plant. THE pin target for foot IK. */
  pos: { x: number; y: number; z: number };
  /** Sim time of the plant — the edge we detect a new step on. */
  t: number;
  /** True while that foot still bears load. */
  contact: boolean;
  /** 0..1 through the current STEP (a stride is two steps). */
  phase: number;
  /** Step length used for the current step, metres. */
  stride: number;
  /** True when the plant is the pivot of a hard cut. */
  hard: boolean;
  speed: number;
}

export interface AirLike {
  airborne: boolean;
  tTakeoff: number;
  tApex: number;
  apexY: number;
  takeoffY: number;
  tLand: number;
  vy0: number;
}

export interface LocoLike {
  id: number;
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  /** Yaw, 0 = +Z, increasing toward +X. */
  facing: number;
  state: LocoStateLike;
  stateT: number;
  stateDur: number;
  prone: boolean;
  stamina: number;
  foot: FootLike;
  air: AirLike;
  groundY: number;
  groundN: { x: number; y: number; z: number };
  hipHeight: number;
  /** Direction a cut is pivoting toward, valid while state === 'cut'. */
  cutDir: { x: number; y: number; z: number };
  cutEntrySpeed: number;
  cutAngle: number;
  /** Monotonic per-player sim clock, seconds. */
  t: number;
  derived?: { topSpeed: number };
  attr?: { height: number };
}

/* -------------------------------------------------------------- actions */

export type ThrowKind = 'backhand' | 'forehand' | 'hammer' | 'scoober' | 'blade';
export type CatchKind = 'pancake' | 'rim' | 'sky' | 'scoop' | 'trail';

/** Finger presets. The hand is the thing people look at on a disc game. */
export type HandPose =
  /** Loose, slightly curled — the default while running. */
  | 'run'
  /** Fully relaxed, near-flat. */
  | 'relax'
  /** Splayed open, ready to receive. */
  | 'open'
  /** Fingers under the rim, thumb on top — carrying or about to throw. */
  | 'grip'
  /** Flat and stiff — marking, blocking a lane. */
  | 'mark'
  /** Braced, heel of the hand leading — layout impact and get-ups. */
  | 'brace';

/**
 * A `PlayerIntent.charge` (src/input/Input.ts), duck-typed. Every field is
 * optional so a caller can push a partial and the windup still runs.
 */
export interface ChargeLike {
  active: boolean;
  /** Seconds the throw button has been held — drives windup progress. */
  hold: number;
  power: number;
  type: ThrowKind;
  /** -1 full left-edge-down … +1 full right-edge-down. Tilts the wrist. */
  tilt: number;
  aimYaw: number;
  /** Hold time the perfect window is centred on — the windup's target. */
  targetHold: number;
  maxHold: number;
}

export interface ReleaseLike {
  fired: boolean;
  type: ThrowKind;
  power: number;
  quality: number;
  tilt: number;
  aimYaw: number;
}

/* -------------------------------------------------------------- options */

export interface AnimatorOptions {
  /**
   * Write `rig.root.position` / `rig.root.rotation.y` from the sim. On by
   * default: foot IK is a world-space solve and it needs an authoritative root.
   * Turn it off only if the caller writes exactly the same transform.
   */
  driveRoot?: boolean;
  /**
   * 0..1 global detail dial, normally `ctx.quality.charDetail`. Below 0.6 the
   * finger poses collapse to a single curl value and secondary motion halves.
   */
  detail?: number;
  /**
   * Which side the throwing hand is on, in RIG terms (+X is the athlete's
   * left): **-1 = right-handed, +1 = left-handed**. Default -1. Per-handle
   * override on `add()`; omitted there, roughly one athlete in nine is dealt a
   * left hand from a hash of their id, deterministically.
   */
  handed?: 1 | -1;
}

export interface AnimAddOptions {
  /** Player id — also the deterministic salt for idle phase and breathing. */
  id?: number;
  /** -1 = right-handed, +1 = left-handed. See `AnimatorOptions.handed`. */
  handed?: 1 | -1;
  /** Extra deterministic salt. */
  seed?: number;
}

/* --------------------------------------------------------------- output */

/**
 * Per-frame signals the animator publishes for other systems to consume.
 * Cloth and hair have no bones in this rig, so the animator cannot move them —
 * instead it exports the accelerations that WOULD drive them, in the athlete's
 * local frame, for a vertex shader to integrate. Zero cost when unread.
 */
export interface AnimSignals {
  /** Local-space acceleration of the chest, m/s². Jersey inertia driver. */
  chestAccX: number;
  chestAccY: number;
  chestAccZ: number;
  /** Local-space acceleration of the head. Hair inertia driver. */
  headAccX: number;
  headAccY: number;
  headAccZ: number;
  /** 0..1 breathing depth — rises as stamina falls. */
  breath: number;
  /** 0..1 through the current stride, left-foot referenced. */
  stridePhase: number;
  /** Ground speed used for the pose this frame, m/s. */
  speed: number;
}

/** Bone groups used as blend masks. Indices, not names — no hot-loop lookups. */
export type BoneMask = Readonly<Int32Array>;

export type BoneNameList = readonly BoneName[];

/** A world-space point the head/eyes should track. */
export interface GazeTarget {
  x: number;
  y: number;
  z: number;
}

export type Vec3Like = { x: number; y: number; z: number };

/** Duck-typed field system: `ctx.sys.field`. */
export interface FieldLike {
  heightAt?(x: number, z: number): number;
  normalAt?(x: number, z: number, out?: THREE.Vector3): THREE.Vector3;
}
