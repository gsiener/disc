import * as THREE from 'three';
import type { LocoPlayer } from './Types.ts';
import { G, clamp, clamp01 } from './Attributes.ts';

/**
 * Aerial contests. Two bodies going up for the same disc is resolved as a
 * reach comparison plus a positioning (box-out) term — not a coin flip. The
 * player who timed their jump so that their apex coincides with the disc, who
 * got there first, and who has the inside shoulder, wins.
 */

/** COM height of a body lying on the turf, above the surface. */
export const PRONE_Y = 0.22;

export interface ContestScore {
  /** Fingertip height at the contest instant (world Y). */
  reach: number;
  /** Horizontal distance from the disc at the contest instant (m). */
  gap: number;
  /** Reach after the horizontal-gap penalty (m). */
  effective: number;
  /** Positional advantage, in metres-of-reach equivalent. */
  boxOut: number;
  score: number;
}

export interface ContestResult {
  winner: 'a' | 'b' | 'none';
  a: ContestScore;
  b: ContestScore;
  /** |scoreA - scoreB| in metres. */
  margin: number;
  /** Bodies within contact distance at the contest instant. */
  contact: boolean;
  /** Who initiated the contact, if any. */
  foulOn: 'a' | 'b' | null;
  /** 0..1 likelihood the contact is called. */
  foulChance: number;
}

/** Predicted COM position `t` seconds from now. */
export function predictPos(p: LocoPlayer, t: number, out: THREE.Vector3): THREE.Vector3 {
  out.x = p.pos.x + p.vel.x * t;
  out.z = p.pos.z + p.vel.z * t;
  if (p.air.airborne) {
    const floor = p.groundY + (p.state === 'layout' ? PRONE_Y : p.hipHeight);
    out.y = Math.max(floor, p.pos.y + p.vel.y * t - 0.5 * G * t * t);
  } else {
    out.y = p.pos.y;
  }
  return out;
}

/** Fingertip height `t` seconds from now (world Y). */
export function reachAt(p: LocoPlayer, t: number): number {
  let y = p.pos.y;
  if (p.air.airborne) {
    const floor = p.groundY + (p.state === 'layout' ? PRONE_Y : p.hipHeight);
    y = Math.max(floor, p.pos.y + p.vel.y * t - 0.5 * G * t * t);
  }
  const rise = y - (p.groundY + p.hipHeight);
  return Math.max(p.groundY + 0.6, p.groundY + p.attr.height * 1.30 + rise);
}

/** How far to the side a player can still get a hand on the disc. */
function catchRadius(p: LocoPlayer): number {
  return 0.55 * p.attr.height;
}

const PA = new THREE.Vector3();
const PB = new THREE.Vector3();

/**
 * @param tContest seconds from now that the disc arrives
 * @param jitter   deterministic tie-breaker in [-1,1]; pass 0 for a pure model
 */
export function contestAir(
  a: LocoPlayer,
  b: LocoPlayer,
  discPos: THREE.Vector3,
  tContest: number,
  jitter = 0,
): ContestResult {
  predictPos(a, tContest, PA);
  predictPos(b, tContest, PB);

  const gapA = Math.hypot(discPos.x - PA.x, discPos.z - PA.z);
  const gapB = Math.hypot(discPos.x - PB.x, discPos.z - PB.z);

  const reachA = reachAt(a, tContest);
  const reachB = reachAt(b, tContest);

  const effA = reachA - 1.15 * Math.max(0, gapA - catchRadius(a));
  const effB = reachB - 1.15 * Math.max(0, gapB - catchRadius(b));

  // Inside position: nearer the disc horizontally is worth real reach.
  const inside = clamp((gapB - gapA) * 0.35, -0.30, 0.30);

  // Sealing: standing between the opponent and the disc.
  const bx = PB.x - PA.x, bz = PB.z - PA.z;
  const dxA = discPos.x - PA.x, dzA = discPos.z - PA.z;
  const bodyDist = Math.hypot(bx, bz);
  let sealA = 0;
  if (bodyDist > 1e-4) {
    const dl = Math.hypot(dxA, dzA);
    if (dl > 1e-4) {
      // >0 when the opponent is on the far side of A from the disc.
      const dot = (bx * -dxA + bz * -dzA) / (bodyDist * dl);
      sealA = clamp(dot, -1, 1) * 0.14;
    }
  }

  // Strength only matters when bodies are actually jostling.
  const jostle = bodyDist < 0.95 ? 1 - bodyDist / 0.95 : 0;
  const strTerm = ((a.attr.strength - b.attr.strength) / 100) * 0.22 * jostle;

  const boxA = inside + sealA + strTerm + jitter * 0.02;
  const boxB = -inside - sealA - strTerm - jitter * 0.02;

  const scoreA = effA + boxA;
  const scoreB = effB + boxB;
  const margin = Math.abs(scoreA - scoreB);

  const contact = bodyDist < 0.85;
  let foulOn: 'a' | 'b' | null = null;
  let foulChance = 0;
  if (contact && bodyDist > 1e-4) {
    const nx = bx / bodyDist, nz = bz / bodyDist;
    const closeA = a.vel.x * nx + a.vel.z * nz;      // A moving into B
    const closeB = -(b.vel.x * nx + b.vel.z * nz);   // B moving into A
    const impact = Math.max(closeA, closeB);
    if (impact > 0.6) {
      foulOn = closeA >= closeB ? 'a' : 'b';
      foulChance = clamp01((impact - 0.6) / 4.0);
    }
  }

  return {
    winner: margin < 0.03 ? 'none' : scoreA > scoreB ? 'a' : 'b',
    a: { reach: reachA, gap: gapA, effective: effA, boxOut: boxA, score: scoreA },
    b: { reach: reachB, gap: gapB, effective: effB, boxOut: boxB, score: scoreB },
    margin,
    contact,
    foulOn,
    foulChance,
  };
}
