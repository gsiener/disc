import type { Attributes, Derived, MoveMode } from './Types.ts';

/**
 * Ratings -> physical capability curves. Every magic number here is a tuning
 * knob and every one of them is in SI units, so it can be argued with.
 *
 * Reference athlete (all ratings 100): 9.6 m/s top speed, 9.6 m/s^2 burst,
 * 13.4 m/s^2 braking, 12.5 m/s^2 lateral grip, 0.85 m standing vertical.
 */

export const G = 9.81;

/** Below this stamina, capability starts to fade. */
export const STAM_FADE = 60;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const n01 = (v: number): number => clamp(v, 0, 100) / 100;

/** Fraction of top speed each gait is capped at. */
export function modeCapFraction(mode: Exclude<MoveMode, 'auto'>, agility: number): number {
  const agi = n01(agility);
  switch (mode) {
    case 'sprint': return 1;
    case 'run': return 0.78;
    case 'jog': return 0.42;
    // Backpedalling and shuffling are deliberately slow: this is the whole
    // reason a receiver can beat a defender deep.
    case 'backpedal': return 0.50 + 0.06 * agi;
    case 'shuffle': return 0.43 + 0.06 * agi;
  }
}

/**
 * @param a       ratings
 * @param stamina 0..100
 * @param speed   current ground speed (m/s), used for the turn-rate curve
 * @param mode    resolved gait
 * @param slopeMul multiplier from terrain grade (1 on the flat)
 */
export function derive(
  a: Attributes,
  stamina: number,
  speed: number,
  mode: Exclude<MoveMode, 'auto'>,
  slopeMul = 1,
): Derived {
  const spd = n01(a.speed);
  const acc = n01(a.accel);
  const agi = n01(a.agility);
  const ver = n01(a.vertical);

  const fatigue = clamp01((STAM_FADE - stamina) / STAM_FADE);

  // Gaits are not equally powerful. You cannot drive off the ground backwards
  // or sideways the way you can running forwards.
  const accelMul = mode === 'backpedal' ? 0.62 : mode === 'shuffle' ? 0.72 : 1;
  const gripMul = mode === 'backpedal' ? 0.80 : mode === 'shuffle' ? 1.15 : 1;

  const topSpeed = (6.6 + 3.0 * spd) * (1 - 0.22 * fatigue) * slopeMul;
  const accelMax = (5.0 + 4.6 * acc) * (1 - 0.34 * fatigue) * slopeMul * accelMul;
  const brakeMax = accelMax * (1.25 + 0.35 * agi);
  const gripMax = (7.5 + 5.0 * agi) * (1 - 0.20 * fatigue) * gripMul;

  // Yaw authority collapses with speed — you cannot pirouette at 9 m/s.
  const sFrac = clamp01(speed / Math.max(1e-3, topSpeed));
  const turnRate = (9.5 + 4.0 * agi) * (1 - 0.72 * sFrac);

  const jumpHeight = (0.30 + 0.55 * ver) * (1 - 0.18 * fatigue);
  const standingReach = a.height * 1.30;
  const plantDur = 0.20 - 0.07 * agi;

  const capFrac = mode === 'sprint' ? 1 : modeCapFraction(mode, a.agility);

  return {
    topSpeed,
    modeCap: topSpeed * capFrac,
    accelMax,
    brakeMax,
    gripMax,
    turnRate,
    jumpHeight,
    standingReach,
    plantDur,
    fatigue,
    slopeMul,
  };
}

/**
 * Propulsive acceleration available at a given speed. Falls off toward the top
 * end so the speed curve is an exponential-ish approach rather than a ramp.
 */
export function propulsiveAt(d: Derived, speed: number, cap: number): number {
  const f = clamp01(speed / Math.max(0.5, cap));
  return d.accelMax * Math.max(0, 1 - Math.pow(f, 1.7));
}

/* -------------------------------------------------------------- vertical */

/** Effective leap height including the run-up bonus. */
export function leapHeight(d: Derived, approachSpeed: number): number {
  const f = clamp01(approachSpeed / Math.max(1e-3, d.topSpeed));
  return d.jumpHeight * (1 + 0.38 * f);
}

export function takeoffVy(d: Derived, approachSpeed: number): number {
  return Math.sqrt(2 * G * leapHeight(d, approachSpeed));
}

/* -------------------------------------------------------------- stamina */

/** Stamina points per second, signed: negative drains. */
export function staminaRate(a: Attributes, speed: number, topSpeedFresh: number): number {
  const end = n01(a.endurance);
  const f = clamp01(speed / Math.max(1e-3, topSpeedFresh));
  const IDLE_F = 0.42; // at or below a jog you are recovering
  if (f > IDLE_F) {
    const drain = 2.6 + 2.4 * (1 - end);
    return -drain * Math.pow(f, 2.4);
  }
  const rec = 2.0 + 2.0 * end;
  return rec * (1 - (f / IDLE_F) * 0.55);
}

/** One-shot stamina costs. */
export const COST_JUMP = 2.5;
export const COST_LAYOUT = 9.0;
export const COST_CUT = 1.2;
