/**
 * Switch-player policy.
 *
 * "Nearest defender" is the wrong answer and every player can feel it: it hands
 * you someone with their back to the play while the disc sails over the one
 * defender who could actually contest it. What you want is the defender with
 * the best claim on the *threat* — the receiving space the disc is heading for
 * — weighted by whether they are already moving that way, minus the marker
 * (pulling the mark off the thrower is almost never what you meant) and minus
 * anyone already under human control.
 *
 * Pure, deterministic, allocation-free. Ties break on player id.
 */

import { clamp01 } from './Curves.ts';

export interface DefenderCandidate {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Position of the offensive player they are assigned to, if any. */
  assignedX?: number;
  assignedZ?: number;
  /** True if this defender is currently marking the thrower. */
  isMarker?: boolean;
  /** True if a human already controls this defender. */
  controlled?: boolean;
  /** 0..1; a blown defender is a worse switch target. */
  stamina?: number;
  /** Set false to exclude entirely (injured, out of play). */
  eligible?: boolean;
}

export interface SwitchSituation {
  /** Where the disc is now (or the thrower). */
  discX: number;
  discZ: number;
  /** The dangerous space: the disc's predicted arrival point, or the primary cut. */
  threatX: number;
  threatZ: number;
  /** True once the disc is in the air — urgency goes up, the marker matters less. */
  discInAir: boolean;
  /** Optional stick hint from the player, unit XZ. Zero means no hint. */
  hintX?: number;
  hintZ?: number;
  /** Currently controlled defender, used as the origin for the hint. */
  fromX?: number;
  fromZ?: number;
}

export interface SwitchWeights {
  /** Metres of penalty per second of predicted time-to-threat. */
  eta: number;
  /** Metres of penalty per metre of raw distance to the threat. */
  distance: number;
  /** Flat penalty (metres) for stealing the marker off the thrower. */
  marker: number;
  /** Penalty scale for a candidate that does not lie along the stick hint. */
  hint: number;
  /** Bonus (metres) for full stamina. */
  stamina: number;
  /** Assumed closing speed floor so a stationary defender still has a finite eta. */
  baseSpeed: number;
}

export const DEFAULT_SWITCH_WEIGHTS: SwitchWeights = {
  eta: 9,
  distance: 1,
  marker: 14,
  hint: 11,
  stamina: 3,
  baseSpeed: 2.5,
};

/** Score a single candidate. Lower is better. Exported for tuning and tests. */
export function switchScore(
  c: DefenderCandidate,
  s: SwitchSituation,
  w: SwitchWeights = DEFAULT_SWITCH_WEIGHTS,
): number {
  const dx = s.threatX - c.x;
  const dz = s.threatZ - c.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  let closing = w.baseSpeed;
  if (dist > 1e-4) {
    const inv = 1 / dist;
    closing += Math.max(0, c.vx * dx * inv + c.vz * dz * inv);
  }
  const eta = dist / Math.max(0.5, closing);

  let score = eta * w.eta + dist * w.distance;

  // Never volunteer the mark unless the disc is already gone.
  if (c.isMarker && !s.discInAir) score += w.marker;
  else if (c.isMarker) score += w.marker * 0.35;

  // A defender already beaten deep by their assignment is a poor switch.
  if (c.assignedX !== undefined && c.assignedZ !== undefined) {
    const ax = c.assignedX - c.x;
    const az = c.assignedZ - c.z;
    const sep = Math.sqrt(ax * ax + az * az);
    score += clamp01(sep / 12) * 4;
  }

  // Stick hint: prefer defenders lying in the direction the player pushed.
  const hx = s.hintX ?? 0;
  const hz = s.hintZ ?? 0;
  const hm = Math.sqrt(hx * hx + hz * hz);
  if (hm > 1e-4) {
    const ox = c.x - (s.fromX ?? s.discX);
    const oz = c.z - (s.fromZ ?? s.discZ);
    const om = Math.sqrt(ox * ox + oz * oz);
    if (om > 1e-4) {
      const dot = (ox * hx + oz * hz) / (om * hm);
      score += (1 - dot) * 0.5 * w.hint;
    } else {
      score += 0.5 * w.hint;
    }
  }

  score -= clamp01(c.stamina ?? 1) * w.stamina;
  return score;
}

/**
 * Pick the defender to switch to, or -1 if there is no sensible candidate.
 * `excludeId` is the player currently controlled.
 */
export function pickSwitchTarget(
  candidates: readonly DefenderCandidate[],
  situation: SwitchSituation,
  excludeId = -1,
  weights: SwitchWeights = DEFAULT_SWITCH_WEIGHTS,
): number {
  let bestId = -1;
  let bestScore = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.id === excludeId) continue;
    if (c.eligible === false) continue;
    if (c.controlled) continue;
    const s = switchScore(c, situation, weights);
    if (s < bestScore - 1e-9 || (Math.abs(s - bestScore) <= 1e-9 && c.id < bestId)) {
      bestScore = s;
      bestId = c.id;
    }
  }
  return bestId;
}

/** Anything that can answer "who could I switch to right now". */
export interface SwitchProvider {
  defenderCandidates?(): readonly DefenderCandidate[];
  switchSituation?(): SwitchSituation;
}
