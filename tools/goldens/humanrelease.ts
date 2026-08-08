import * as THREE from 'three';

import { humanReleaseParams } from '../../src/sim/Game.ts';
import { FIXED_DT, simulate, throwDisc } from '../../src/sim/DiscPhysics.ts';
import { THROW_TYPES, throwSpeed, type ThrowType } from '../../src/sim/aero/Throws.ts';

/* ---------------------------------------------------------- human throw feel */

/**
 * `humanReleaseParams` — the charge control, over its whole domain including the rails.
 *
 * Two fixtures in one, because the mapping has two kinds of contract.
 *
 * `cases` is the arithmetic: type x power x quality x tilt, swept over a grid that puts
 * every clamp on both of its rails. `power` clamps to [0,1] and the grid runs from -1 to
 * 1.75; the spin term clamps to [0.1,1] and `quality` runs from -1 to 1.5, which is past
 * both ends of it. Nothing in the mapping is transcendental, so the Swift side asserts
 * these bit-for-bit — every output is a sum of products of exactly-representable-ish
 * doubles and any difference is a logic bug, not libm.
 *
 * `feel` is the part a table of numbers cannot check on its own: what the release
 * actually DOES when you fly it. Each sweep is the release flown to the ground on the
 * real aero, so the Swift port is compared against the reference's trajectory rather
 * than against a re-reading of the arithmetic.
 *
 * The `unsigned` sweeps are the REGRESSION, kept deliberately. They apply one unsigned
 * hyzer — the value fitted for the backhand, `-HUCK_HYZER * p^2` — to every throw instead
 * of taking it along `spinSign`. The backhand is unchanged by that (its `spinSign` is -1,
 * so the two mappings agree) and the forehand falls apart: its drift runs out to 20.5 m,
 * flips sign mid-charge, and puts a dip in the distance curve. That is the exact failure
 * the signed term exists to prevent, and a fixture that only carried the fixed mapping
 * could not tell you the fix was still working.
 */
export function humanReleaseGoldens() {
  /**
   * The grid. Each axis includes 0, 1, a negative and an above-range value, so both rails
   * of both clamps are hit from outside rather than merely approached.
   */
  const powers = [-1, -0.25, 0, 0.125, 0.25, 0.5, 0.75, 1, 1.75];
  const qualities = [-1, -0.5, 0, 0.35, 0.5, 1, 1.5];
  const tilts = [-1.4, -1, 0, 1, 1.4];

  const cases: unknown[] = [];
  for (const type of THROW_TYPES) {
    for (const power of powers) {
      for (const quality of qualities) {
        for (const tilt of tilts) {
          const r = humanReleaseParams(type, power, quality, tilt);
          cases.push({
            type, power, quality, tilt,
            speed: r.speed, angle: r.angle, spin: r.spin, bank: r.bank, nose: r.nose,
          });
        }
      }
    }
  }

  /* ------------------------------------------------------------------- feel */

  /** Where a human release leaves the hand, metres. Matches `Game.humanThrow`. */
  const RELEASE_Y = 1.55;

  interface Release { speed: number; angle: number; spin: number; bank: number; nose: number }

  /** Fly a release to the ground and report where it finished. */
  function fly(type: ThrowType, r: Release): { carry: number; drift: number; hang: number } {
    const s = throwDisc(
      type,
      new THREE.Vector3(0, RELEASE_Y, 0),
      new THREE.Vector3(0, 0, 1),
      1, r.angle, r.spin,
      { hand: 'R', bank: r.bank, nose: r.nose, speed: r.speed },
    );
    let t = 0;
    while (s.pos.y > 0.05 && t < 20) { simulate(s, FIXED_DT); t += FIXED_DT; }
    return { carry: s.pos.z, drift: s.pos.x, hang: t };
  }

  /**
   * The one-unsigned-bank regression, spelled out rather than parameterised, so the two
   * mappings can be read side by side. Identical to `humanReleaseParams` except that the
   * hyzer term ignores `spinSign`.
   */
  const clampNum = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
  const MIN_THROW_SPEED = humanReleaseParams('backhand', 0, 1, 0).speed;
  const HUCK_HYZER = humanReleaseParams('forehand', 1, 1, 0).bank;

  function unsignedRelease(type: ThrowType, power: number, quality: number, tilt: number): Release {
    const p = clampNum(power, 0, 1);
    const top = throwSpeed(type, 1);
    return {
      speed: MIN_THROW_SPEED + Math.max(0, top - MIN_THROW_SPEED) * p,
      angle: 0.02 + 0.10 * p,
      spin: clampNum(0.35 + 0.55 * quality, 0.1, 1),
      bank: tilt * 0.85 - HUCK_HYZER * p * p,
      nose: (1 - quality) * 0.08,
    };
  }

  // Accumulated the way the reference sweeps it, so the charge levels are the exact
  // doubles the reference used rather than a re-derived decimal grid.
  const charges: number[] = [];
  for (let p = 0; p <= 1.0001; p += 0.1) charges.push(p);

  const sweeps: unknown[] = [];
  for (const type of THROW_TYPES) {
    for (const mapping of ['signed', 'unsigned'] as const) {
      const carry: number[] = [], drift: number[] = [], hang: number[] = [];
      for (const p of charges) {
        const r = mapping === 'signed'
          ? humanReleaseParams(type, p, 1, 0)
          : unsignedRelease(type, p, 1, 0);
        const f = fly(type, r);
        carry.push(f.carry); drift.push(f.drift); hang.push(f.hang);
      }
      sweeps.push({ type, mapping, carry, drift, hang });
    }
  }

  // Tilt is the curve control and quality is the cost of a bad release; both are read at
  // one charge level, because what they have to prove is a direction, not a curve shape.
  const tiltProbe = [-1, -0.5, 0, 0.5, 1].map((tilt) => {
    const f = fly('backhand', humanReleaseParams('backhand', 0.8, 1, tilt));
    return { tilt, carry: f.carry, drift: f.drift };
  });
  const qualityProbe = [0, 0.25, 0.5, 0.75, 1].map((quality) => {
    const f = fly('backhand', humanReleaseParams('backhand', 0.8, quality, 0));
    return { quality, carry: f.carry, drift: f.drift };
  });

  return {
    note:
      'Generated by tools/gen-goldens.ts from humanReleaseParams in src/sim/Game.ts. '
      + 'Cases are pure arithmetic and are asserted bit-for-bit; feel sweeps are flown '
      + 'on the real aero and carry the integration tolerance the consuming test states.',
    minThrowSpeed: MIN_THROW_SPEED,
    huckHyzer: HUCK_HYZER,
    powers, qualities, tilts,
    cases,
    feel: { releaseY: RELEASE_Y, charges, sweeps, tiltProbe, qualityProbe },
  };
}
