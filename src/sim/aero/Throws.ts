/**
 * Release conditions for the throws in the game.
 *
 * Nothing here scripts a flight path.  Each entry only sets the six things a
 * human actually controls at release: how fast, how much spin, which way the
 * disc is spinning, how far the disc is banked about the flight axis, how the
 * nose sits relative to the velocity, and the launch elevation.  Every curve
 * you see in flight comes out of DiscPhysics.
 *
 * spinSign is relative to the BODY normal (body +Z, out of the top plate):
 *   -1  backhand-family grip   (right-handed backhand spins clockwise seen
 *                               from above, i.e. angular velocity along -n)
 *   +1  forehand-family grip
 * `invert` rolls the disc 180 degrees about the flight axis at release, which
 * flips the normal to point downwards - that is what makes a hammer a hammer.
 *
 * All signed quantities (spinSign, bank) are mirrored for a left-handed
 * thrower by DiscPhysics.throwDisc.
 */

export type ThrowType =
  | 'backhand'
  | 'forehand'
  | 'hammer'
  | 'scoober'
  | 'push'
  | 'blade';

export interface ThrowSpec {
  /** Release speed range in m/s, lerped by `power` in [0,1]. */
  speed: readonly [number, number];
  /** Spin rate range in rad/s, lerped by `spin` in [0,1]. */
  spin: readonly [number, number];
  /** Sign of the spin about the body normal. */
  spinSign: 1 | -1;
  /** Bank about the flight axis at release, rad. Positive banks to the thrower's right. */
  bank: number;
  /**
   * Nose angle, rad. Positive is nose up.
   *
   * `planeRef` says what it is measured against:
   *   'velocity'  the angle between the disc plane and the velocity vector -
   *               this is the "nose angle" players talk about on flat throws
   *   'world'     the angle between the disc plane and the ground - the wrist
   *               sets the plane and the arm sets the direction, which is what
   *               actually happens on an overhead
   */
  nose: number;
  planeRef: 'velocity' | 'world';
  /** Launch elevation above horizontal, rad. The caller's `angle` adds to this. */
  elevation: number;
  /** Release the disc upside down. */
  invert: boolean;
  /** Human-readable note for the HUD / debug overlay. */
  about: string;
}

export const THROW_SPECS: Record<ThrowType, ThrowSpec> = {
  backhand: {
    speed: [12, 27],
    spin: [38, 62],
    spinSign: -1,
    bank: 0,
    nose: -0.02,
    planeRef: 'velocity',
    elevation: 0.10,
    invert: false,
    about: 'Flat power throw. Turns over slightly while fast, fades back to the left as it slows.',
  },
  forehand: {
    speed: [11, 25],
    spin: [34, 56],
    spinSign: 1,
    bank: -0.04,
    nose: 0.0,
    planeRef: 'velocity',
    elevation: 0.10,
    invert: false,
    about: 'Mirror of the backhand: opposite spin, so it turns and fades the other way.',
  },
  hammer: {
    speed: [16, 27],
    spin: [30, 50],
    spinSign: 1,
    bank: 0,
    nose: 0.12,
    planeRef: 'world',
    elevation: 0.68,
    invert: true,
    about: 'Overhead, upside down. Inverted lift pulls it over the top and it drops hard and left.',
  },
  scoober: {
    speed: [10, 18],
    spin: [26, 44],
    spinSign: -1,
    bank: 0.70,
    nose: 0.08,
    planeRef: 'world',
    elevation: 0.34,
    invert: true,
    about: 'Upside-down backhand grip. Short, breaks the opposite way to a hammer.',
  },
  push: {
    speed: [7, 14],
    spin: [20, 34],
    spinSign: 1,
    bank: 0,
    nose: 0.02,
    planeRef: 'velocity',
    elevation: 0.10,
    invert: false,
    about: 'Chest-height dump. Low speed, low spin, dies quickly.',
  },
  blade: {
    speed: [15, 26],
    spin: [34, 54],
    spinSign: 1,
    bank: 1.30,
    nose: 0.02,
    planeRef: 'velocity',
    elevation: 0.55,
    invert: false,
    about: 'Thrown on edge. Almost no vertical lift, so it knifes sideways and falls out of the sky.',
  },
};

export const THROW_TYPES: readonly ThrowType[] = [
  'backhand', 'forehand', 'hammer', 'scoober', 'push', 'blade',
];

/** Release speed in m/s for a normalised power in [0,1]. */
export function throwSpeed(type: ThrowType, power: number): number {
  const s = THROW_SPECS[type].speed;
  const p = power < 0 ? 0 : power > 1 ? 1 : power;
  return s[0] + (s[1] - s[0]) * p;
}

/** Normalised power in [0,1] that produces `speed` m/s. Inverse of throwSpeed. */
export function powerForSpeed(type: ThrowType, speed: number): number {
  const s = THROW_SPECS[type].speed;
  const p = (speed - s[0]) / (s[1] - s[0]);
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** Unsigned spin rate in rad/s for a normalised spin in [0,1]. */
export function throwSpinRate(type: ThrowType, spin: number): number {
  const s = THROW_SPECS[type].spin;
  const p = spin < 0 ? 0 : spin > 1 ? 1 : spin;
  return s[0] + (s[1] - s[0]) * p;
}
