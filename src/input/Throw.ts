/**
 * Throwing — the signature mechanic.
 *
 * Press and hold to charge. The meter fills to full over `fullTime`; the
 * *accuracy* window is centred on the moment the meter tops out, so a max-power
 * huck demands a precise release while a touch pass is safe but never perfect.
 * Hold past the window and the throw winds up, telegraphs and wobbles.
 *
 *   quality
 *   1.0                      /\
 *   0.9   _________________ /  \_______
 *        /                              \
 *   0.34 |                                \____ 0.28
 *        0   minTime      fullTime  +grace   maxHold
 *        rushed            perfect          overcharged
 *
 * The aim stick does double duty: where it points is where the throw goes, and
 * how far it is deflected from the yaw you were facing when the charge started
 * sets the disc angle — throwing across your body produces an inside-out or
 * outside-in curve exactly as it does in real life. Two curve modifiers let you
 * break the disc off deliberately without re-pointing.
 *
 * Everything here is pure or deterministic; no DOM, no randomness.
 */

import {
  angleDelta, clamp, clamp01, lerp, smoothstep,
} from './Curves.ts';
import type { ChargeIntent, ReleaseIntent, ThrowType } from './Intent.ts';

export interface ThrowTiming {
  /** Hold time at which power reaches 1 and the perfect window is centred. */
  fullTime: number;
  /** Below this, the throw is rushed and quality is scaled down hard. */
  minTime: number;
  /** Half-width of the perfect release window, seconds. */
  perfectWindow: number;
  /** Seconds past fullTime before the wind-up starts costing quality. */
  overGrace: number;
  /** Hold time at which the charge fires itself. */
  maxHold: number;
  /** Quality at hold = 0. */
  rushFloor: number;
  /** Quality on the safe plateau between minTime and fullTime + overGrace. */
  plateau: number;
  /** Quality at maxHold. */
  overFloor: number;
  /** Exponent on hold -> power. <1 front-loads, so a flick still has legs. */
  powerCurve: number;
  /** Power at hold = 0. */
  minPower: number;
}

export const DEFAULT_TIMING: ThrowTiming = {
  fullTime: 0.85,
  minTime: 0.14,
  perfectWindow: 0.09,
  overGrace: 0.30,
  maxHold: 2.00,
  rushFloor: 0.34,
  plateau: 0.90,
  overFloor: 0.28,
  powerCurve: 0.85,
  minPower: 0.06,
};

/** How much harder each throw is to release cleanly. Backhand is the baseline. */
export const THROW_DIFFICULTY: Record<ThrowType, number> = {
  backhand: 1.00,
  forehand: 1.08,
  hammer: 1.35,
  scoober: 1.45,
  blade: 1.60,
};

/** Aim deflection past this (with the hammer modifier) reads as a blade. */
export const BLADE_TILT = 0.7;

/** Aim rate at which steadiness bottoms out, rad/s. */
export const WHIP_RATE = 11;
/** Fraction of quality a fully whipped release costs. */
export const WHIP_PENALTY = 0.35;
/** Fraction of quality a fully tilted (max IO/OI) release costs. */
export const TILT_PENALTY = 0.14;

/**
 * Scale a timing profile by a difficulty multiplier: harder throws get a
 * narrower perfect window, need a longer wind-up before they stop being rushed,
 * lose their grace period faster and sit on a lower plateau.
 */
export function applyDifficulty(t: ThrowTiming, d: number): ThrowTiming {
  const k = Math.max(0.25, d);
  return {
    ...t,
    minTime: t.minTime * k,
    perfectWindow: t.perfectWindow / k,
    overGrace: t.overGrace / k,
    plateau: clamp01(t.plateau - 0.12 * (k - 1)),
    rushFloor: clamp01(t.rushFloor - 0.06 * (k - 1)),
  };
}

/** Hold time -> power. Monotonically non-decreasing, saturates at 1. */
export function chargePower(hold: number, t: ThrowTiming): number {
  const x = clamp01(hold / Math.max(1e-6, t.fullTime));
  return clamp01(t.minPower + (1 - t.minPower) * Math.pow(x, t.powerCurve));
}

/**
 * Hold time -> release quality, before steadiness and tilt penalties.
 * Rises out of the rushed region, sits on a plateau, spikes to 1.0 in the
 * perfect window centred on fullTime, then decays through the overcharge.
 */
export function releaseQuality(hold: number, t: ThrowTiming): number {
  const overStart = t.fullTime + t.overGrace;
  let base: number;
  if (hold < t.minTime) {
    base = lerp(t.rushFloor, t.plateau, smoothstep(hold / Math.max(1e-6, t.minTime)));
  } else if (hold <= overStart) {
    base = t.plateau;
  } else {
    const span = Math.max(1e-6, t.maxHold - overStart);
    base = lerp(t.plateau, t.overFloor, smoothstep((hold - overStart) / span));
  }
  const d = Math.abs(hold - t.fullTime);
  const bump = 1 - smoothstep(d / Math.max(1e-6, t.perfectWindow));
  return clamp01(base + (1 - base) * bump);
}

/** True in the tight centre of the perfect window (what the HUD flashes on). */
export function isPerfect(hold: number, t: ThrowTiming): boolean {
  return Math.abs(hold - t.fullTime) <= t.perfectWindow * 0.35;
}

export function isRushed(hold: number, t: ThrowTiming): boolean { return hold < t.minTime; }
export function isOvercharged(hold: number, t: ThrowTiming): boolean {
  return hold > t.fullTime + t.overGrace;
}

/** 1 when the aim is still, falling to (1 - WHIP_PENALTY) when it is whipped. */
export function steadiness(aimRate: number): number {
  return 1 - WHIP_PENALTY * clamp01(Math.abs(aimRate) / WHIP_RATE);
}

/** Extreme disc angle costs a little accuracy — a flat disc is the easy throw. */
export function tiltFactor(tilt: number): number {
  const t = clamp(tilt, -1, 1);
  return 1 - TILT_PENALTY * t * t;
}

/** Full release quality including the aim penalties. */
export function finalQuality(hold: number, t: ThrowTiming, aimRate: number, tilt: number): number {
  return clamp01(releaseQuality(hold, t) * steadiness(aimRate) * tiltFactor(tilt));
}

/**
 * Modifier combination -> throw type. A blade is a hammer released with the
 * disc already on its edge, so it falls out of the tilt axis rather than
 * needing a button of its own.
 */
export function resolveThrowType(modA: boolean, modB: boolean, tilt: number): ThrowType {
  if (modA && modB) return 'scoober';
  if (modB) return Math.abs(tilt) > BLADE_TILT ? 'blade' : 'hammer';
  if (modA) return 'forehand';
  return 'backhand';
}

/**
 * Aim deflection from the yaw you started the charge on -> disc angle.
 * +1 = right edge down (curves right), -1 = left edge down (curves left).
 */
export function tiltFromAim(aimYaw: number, baseYaw: number, tiltSpan: number): number {
  return clamp(angleDelta(baseYaw, aimYaw) / Math.max(1e-4, tiltSpan), -1, 1);
}

/* --------------------------------------------------------------- controller */

export interface ChargeInput {
  /** Throw button held this step. */
  chargeDown: boolean;
  /** Rising edge — may come straight from the input buffer. */
  chargePressed: boolean;
  /** Falling edge. */
  chargeReleased: boolean;
  /** Cancel button edge. */
  cancelPressed: boolean;
  /** Forehand modifier. */
  modA: boolean;
  /** Hammer modifier. */
  modB: boolean;
  /** Analogue inside-out / outside-in nudges, 0..1 each. */
  curveLeft: number;
  curveRight: number;
  /** Aim device is live this step. */
  aimActive: boolean;
  /** World yaw the aim device points at. */
  aimYaw: number;
  /** Angular speed of the aim, rad/s. */
  aimRate: number;
  /** Player's facing yaw — latched as the tilt reference on charge start. */
  facingYaw: number;
  /** Currently selected receiver, or -1. */
  targetId: number;
}

export interface ChargeOptions {
  timing: ThrowTiming;
  /** Aim deflection, in radians, that maps to full tilt. */
  tiltSpan: number;
  /** Tilt added by a fully-held curve modifier. */
  curveModTilt: number;
  /** Seconds of charge after which a cancel sells as a pump fake. */
  fakeTime: number;
}

export const DEFAULT_CHARGE_OPTIONS: ChargeOptions = {
  timing: DEFAULT_TIMING,
  tiltSpan: Math.PI / 3,   // 60 degrees of deflection = full IO/OI
  curveModTilt: 0.55,
  fakeTime: 0.25,
};

/**
 * The charge state machine. Deterministic, fixed-step, no allocation after
 * construction. Drive it once per 1/120 s step and read `charge` / `release`.
 */
export class ThrowController {
  opts: ChargeOptions;

  active = false;
  hold = 0;
  baseYaw = 0;
  aimYaw = 0;
  tilt = 0;
  type: ThrowType = 'backhand';
  /** Number of times the throw type changed mid-charge — a wrist fake. */
  typeChanges = 0;
  /** Set for exactly one step when a charge was cancelled. */
  cancelled = false;
  /** True alongside `cancelled` when the charge was long enough to sell as a pump fake. */
  fake = false;

  private scaled: ThrowTiming;

  constructor(opts: Partial<ChargeOptions> = {}) {
    this.opts = { ...DEFAULT_CHARGE_OPTIONS, ...opts };
    this.scaled = this.opts.timing;
  }

  /** Abandon any charge without producing a cancel edge (state changes, etc). */
  reset(): void {
    this.active = false;
    this.hold = 0;
    this.tilt = 0;
    this.typeChanges = 0;
    this.type = 'backhand';
  }

  /** The timing profile currently in force (difficulty already applied). */
  get timing(): ThrowTiming { return this.scaled; }

  /**
   * Advance one step, writing into the caller's intent structs.
   * Returns true if a throw left the hand this step.
   */
  step(dt: number, inp: ChargeInput, charge: ChargeIntent, release: ReleaseIntent): boolean {
    const o = this.opts;
    this.cancelled = false;
    this.fake = false;

    // --- start ------------------------------------------------------------
    if (!this.active && inp.chargePressed) {
      this.active = true;
      this.hold = 0;
      this.typeChanges = 0;
      this.baseYaw = inp.facingYaw;
      this.aimYaw = inp.aimActive ? inp.aimYaw : inp.facingYaw;
      this.tilt = 0;
      this.type = resolveThrowType(inp.modA, inp.modB, 0);
    }

    if (!this.active) {
      charge.active = false;
      charge.hold = 0;
      charge.power = 0;
      charge.quality = 0;
      charge.perfect = false;
      charge.rushed = false;
      charge.overcharged = false;
      return false;
    }

    // --- integrate --------------------------------------------------------
    // The release edge is observed at the top of the step *after* the button
    // came up, so the hold must not absorb that step: charging for N steps
    // reports exactly N/120 s, not (N+1)/120 s.
    const wantsRelease = inp.chargeReleased || !inp.chargeDown;
    if (!wantsRelease) this.hold += dt;
    if (inp.aimActive) this.aimYaw = inp.aimYaw;

    const aimTilt = tiltFromAim(this.aimYaw, this.baseYaw, o.tiltSpan);
    const modTilt = (clamp01(inp.curveRight) - clamp01(inp.curveLeft)) * o.curveModTilt;
    this.tilt = clamp(aimTilt + modTilt, -1, 1);

    const nextType = resolveThrowType(inp.modA, inp.modB, this.tilt);
    if (nextType !== this.type) { this.type = nextType; this.typeChanges++; }

    const diff = THROW_DIFFICULTY[this.type];
    this.scaled = applyDifficulty(o.timing, diff);
    const T = this.scaled;

    const power = chargePower(this.hold, T);
    const q = finalQuality(this.hold, T, inp.aimRate, this.tilt);

    charge.active = true;
    charge.hold = this.hold;
    charge.power = power;
    charge.quality = q;
    charge.type = this.type;
    charge.tilt = this.tilt;
    charge.aimYaw = this.aimYaw;
    charge.baseYaw = this.baseYaw;
    charge.perfect = isPerfect(this.hold, T);
    charge.rushed = isRushed(this.hold, T);
    charge.overcharged = isOvercharged(this.hold, T);
    charge.targetHold = T.fullTime;
    charge.targetHalfWidth = T.perfectWindow;
    charge.maxHold = T.maxHold;
    charge.difficulty = diff;

    // --- cancel -----------------------------------------------------------
    if (inp.cancelPressed) {
      const fake = this.hold >= o.fakeTime;
      this.reset();
      this.cancelled = true;
      this.fake = fake;
      charge.active = false;
      charge.power = 0;
      charge.quality = 0;
      charge.hold = 0;
      return false;
    }

    // --- release ----------------------------------------------------------
    const auto = this.hold >= T.maxHold;
    if (wantsRelease || auto) {
      release.fired = true;
      release.type = this.type;
      release.power = power;
      release.quality = q;
      release.tilt = this.tilt;
      release.aimYaw = this.aimYaw;
      release.hold = this.hold;
      release.perfect = charge.perfect;
      release.rushed = charge.rushed;
      release.overcharged = charge.overcharged;
      release.steadiness = steadiness(inp.aimRate);
      release.auto = auto;
      release.targetId = inp.targetId;
      this.reset();
      charge.active = false;
      charge.power = 0;
      charge.quality = 0;
      charge.hold = 0;
      return true;
    }

    return false;
  }
}
