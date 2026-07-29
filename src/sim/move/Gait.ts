import type { LocoPlayer, MoveMode } from './Types.ts';
import { clamp } from './Attributes.ts';

/**
 * Foot-plant bookkeeping. The gait is a phase oscillator whose frequency is a
 * function of ground speed; every time the phase wraps, the opposite foot
 * plants and we record exactly where. That plant point is what the animation
 * system pins the foot to and what the field system scuffs.
 */

/** Steps per second (not strides — a stride is two steps). */
export function stepRate(speed: number): number {
  return clamp(1.55 + 0.35 * speed, 1.55, 4.9);
}

/** Fraction of the step during which the planted foot bears load. */
export function dutyFactor(speed: number): number {
  return clamp(0.64 - 0.045 * speed, 0.22, 0.65);
}

/** Half the lateral distance between the feet (m). */
export function stanceHalfWidth(speed: number, mode: MoveMode): number {
  if (mode === 'shuffle') return 0.24;
  if (mode === 'backpedal') return 0.14;
  return clamp(0.155 - 0.008 * speed, 0.085, 0.16);
}

/** Speed below which the player is considered planted-and-still. */
export const GAIT_MIN_SPEED = 0.35;

export interface PlantResult {
  planted: boolean;
  foot: 'L' | 'R';
  x: number;
  y: number;
  z: number;
  speed: number;
}

const OUT: PlantResult = { planted: false, foot: 'L', x: 0, y: 0, z: 0, speed: 0 };

/**
 * Advance the gait phase and, if a foot came down this step, fill and return
 * the plant. `groundY` is queried at the plant point so feet sit on terrain.
 */
export function advanceGait(
  p: LocoPlayer,
  speed: number,
  velX: number,
  velZ: number,
  mode: MoveMode,
  dt: number,
  groundY: (x: number, z: number) => number,
): PlantResult {
  OUT.planted = false;
  const f = p.foot;

  if (speed < GAIT_MIN_SPEED) {
    // Standing: the last plant stays where it is, both feet are loaded.
    f.contact = true;
    f.phase = 0;
    f.stride = 0;
    return OUT;
  }

  const rate = stepRate(speed);
  f.stride = speed / rate;
  f.phase += rate * dt;

  let planted = false;
  if (f.phase >= 1) {
    f.phase -= Math.floor(f.phase);
    planted = true;
  }
  f.contact = f.phase < dutyFactor(speed);

  if (!planted) return OUT;

  const next: 'L' | 'R' = f.planted === 'L' ? 'R' : 'L';
  const inv = 1 / Math.max(1e-6, speed);
  const dx = velX * inv;
  const dz = velZ * inv;

  // Right-hand vector for the current facing (yaw 0 = +Z, +yaw toward +X).
  const fx = Math.sin(p.facing);
  const fz = Math.cos(p.facing);
  const rx = -fz;
  const rz = fx;

  const half = stanceHalfWidth(speed, mode) * (next === 'R' ? 1 : -1);
  const ahead = f.stride * 0.30;

  const px = p.pos.x + dx * ahead + rx * half;
  const pz = p.pos.z + dz * ahead + rz * half;

  f.planted = next;
  f.hard = false;
  f.t = p.t;
  f.speed = speed;
  f.contact = true;
  f.pos.set(px, groundY(px, pz), pz);

  OUT.planted = true;
  OUT.foot = next;
  OUT.x = px;
  OUT.y = f.pos.y;
  OUT.z = pz;
  OUT.speed = speed;
  return OUT;
}

/**
 * Force a plant for a hard cut. The outside foot goes down — turning left you
 * plant the right foot — and the whole direction change pivots about it.
 * `turnSign` is +1 for a turn toward the player's right, -1 toward the left.
 */
export function plantForCut(
  p: LocoPlayer,
  speed: number,
  velX: number,
  velZ: number,
  turnSign: number,
  groundY: (x: number, z: number) => number,
): PlantResult {
  const f = p.foot;
  const foot: 'L' | 'R' = turnSign >= 0 ? 'L' : 'R'; // outside foot
  const inv = 1 / Math.max(1e-6, speed);
  const dx = velX * inv;
  const dz = velZ * inv;
  // Perpendicular to travel, on the OUTSIDE of the turn: turning right (+1)
  // the outside is the player's left, which is -right = (dz, -dx).
  const ox = dz * turnSign;
  const oz = -dx * turnSign;

  const ahead = clamp(0.16 + 0.045 * speed, 0.16, 0.62);
  const px = p.pos.x + dx * ahead + ox * 0.26;
  const pz = p.pos.z + dz * ahead + oz * 0.26;

  f.planted = foot;
  f.hard = true;
  f.t = p.t;
  f.speed = speed;
  f.contact = true;
  f.phase = 0;
  f.pos.set(px, groundY(px, pz), pz);

  OUT.planted = true;
  OUT.foot = foot;
  OUT.x = px;
  OUT.y = f.pos.y;
  OUT.z = pz;
  OUT.speed = speed;
  return OUT;
}
