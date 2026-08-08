import * as THREE from 'three';

import { SeededRng } from '../../src/sim/Playbook.ts';
import {
  FIXED_DT,
  createDiscState,
  simulate,
  throwDisc,
} from '../../src/sim/DiscPhysics.ts';
import { THROW_SPECS, THROW_TYPES, throwSpeed, throwSpinRate } from '../../src/sim/aero/Throws.ts';
import {
  AERO,
  DISC,
  dragCoeff,
  liftCoeff,
  pitchCoeff,
  reverseBlend,
  stallBlend,
  zeroLiftAlpha,
} from '../../src/sim/aero/Coeffs.ts';

/* ------------------------------------------------------------------ flight */

/**
 * Whole integrated trajectories, which is a different kind of fixture from
 * everything above it.
 *
 * The curves and the vector algebra are pure functions and can be asserted
 * bit-for-bit. A trajectory cannot: it runs the aero coefficients through RK4
 * hundreds of times, and those call `sin`, `cos`, `atan2`, `exp` and `tanh`,
 * none of which any libm specifies to the last ulp. So the consuming test uses
 * a tolerance that WIDENS WITH HORIZON — tight over the first second, looser by
 * the tenth — which is the honest shape of the guarantee. Anything flatter is
 * either too loose early or fails late for reasons that are not bugs.
 *
 * Each scenario is dumped as full state per sample so a divergence can be
 * attributed: if position drifts but the quaternion is clean, it is the force
 * model; if the quaternion goes first, it is the gyroscopic term.
 */
export function flightGoldens() {
  // Orientation is built the way `throwDisc` builds it, from a nose angle and a
  // bank angle relative to the flight direction — NOT from a raw axis-angle.
  // A disc's normal is body +Z, so an identity quaternion points the normal along
  // world +Z, which is horizontal: the disc flies knife-edge like a rolling wheel
  // and lands absurdly short. That is a very easy fixture to write by accident and
  // a very hard one to spot in a column of numbers.
  const scenarios: {
    name: string;
    note: string;
    pos: number[]; vel: number[];
    nose: number; bank: number; invert: boolean;
    spin: number;
    seconds: number;
  }[] = [
    {
      name: 'flat-backhand',
      note: 'Level 20 m/s release, slight nose up. The calibration case in the Coeffs header: should carry about 37 m.',
      pos: [0, 1.6, 0], vel: [20, 0, 0], nose: 0.05, bank: 0, invert: false,
      spin: -52, seconds: 6,
    },
    {
      name: 'nose-up-float',
      note: 'Nose up 12 degrees at lower speed: climbs, bleeds speed, then fades. Exercises the stall blend.',
      pos: [0, 1.6, 0], vel: [16, 0, 0], nose: 0.209, bank: 0, invert: false,
      spin: -48, seconds: 7,
    },
    {
      name: 'anhyzer-bank',
      note: 'Banked 25 degrees about the flight axis — the lift vector leans and the flight should curve.',
      pos: [0, 1.6, 0], vel: [22, 0, 0], nose: 0.05, bank: 0.436, invert: false,
      spin: -55, seconds: 6,
    },
    {
      name: 'upside-down-hammer',
      note: 'Inverted, thrown up at an angle. The reversed-flow penalty should drop it off the back end.',
      pos: [0, 2.0, 0], vel: [14, 4, 0], nose: 0, bank: 0, invert: true,
      spin: 46, seconds: 5,
    },
    {
      name: 'ground-settle',
      note: 'Low and slow so it lands early — exercises skid, level-out and coming to rest.',
      pos: [0, 0.4, 0], vel: [7, -1, 0], nose: 0, bank: 0, invert: false,
      spin: -30, seconds: 4,
    },
  ];

  const cases = scenarios.map((sc) => {
    const s = createDiscState();
    s.pos.set(sc.pos[0], sc.pos[1], sc.pos[2]);
    s.vel.set(sc.vel[0], sc.vel[1], sc.vel[2]);
    s.omega.set(0, 0, sc.spin);

    const up = new THREE.Vector3(0, 1, 0);
    const vdir = new THREE.Vector3(sc.vel[0], sc.vel[1], sc.vel[2]).normalize();
    const right = new THREE.Vector3().crossVectors(vdir, up).normalize();
    const upPerp = new THREE.Vector3().crossVectors(right, vdir).normalize();

    const normal = upPerp.clone()
      .multiplyScalar(Math.cos(sc.nose))
      .addScaledVector(vdir, -Math.sin(sc.nose));
    if (sc.invert) normal.negate();
    normal.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(vdir, sc.bank)).normalize();

    const bodyX = vdir.clone().addScaledVector(normal, -vdir.dot(normal)).normalize();
    const bodyY = new THREE.Vector3().crossVectors(normal, bodyX).normalize();
    s.orient.setFromRotationMatrix(new THREE.Matrix4().makeBasis(bodyX, bodyY, normal)).normalize();

    // Snapshot the RELEASE orientation now. Reading `s.orient` in the returned object
    // literal below would capture it after the integration loop has already mutated it,
    // which silently records the disc's final attitude as its initial one.
    const releaseOrient = [s.orient.x, s.orient.y, s.orient.z, s.orient.w];

    // Sample at 20 Hz while stepping at the engine's fixed 1/120.
    const samples: unknown[] = [];
    const emit = () => samples.push({
      t: s.t,
      pos: [s.pos.x, s.pos.y, s.pos.z],
      vel: [s.vel.x, s.vel.y, s.vel.z],
      orient: [s.orient.x, s.orient.y, s.orient.z, s.orient.w],
      omega: [s.omega.x, s.omega.y, s.omega.z],
      alpha: s.alpha,
      airspeed: s.airspeed,
      spin: s.spin,
      atRest: s.atRest,
      touchedGround: s.touchedGround,
    });

    emit();
    const steps = Math.round(sc.seconds * 120);
    for (let i = 0; i < steps; i++) {
      simulate(s, FIXED_DT);
      if ((i + 1) % 6 === 0) emit();   // 20 Hz
    }

    return {
      name: sc.name, note: sc.note,
      init: { pos: sc.pos, vel: sc.vel, nose: sc.nose, bank: sc.bank, invert: sc.invert, spin: sc.spin,
              orient: releaseOrient },
      seconds: sc.seconds,
      samples,
    };
  });

  return {
    note:
      'Generated by tools/gen-goldens.ts from src/sim/DiscPhysics.ts, stepping at 1/120 ' +
      'and sampling at 20 Hz. These are INTEGRATED trajectories: they cannot be ' +
      'bit-exact across libm implementations, and the consuming test widens its ' +
      'tolerance with horizon rather than asserting a flat epsilon.',
    fixedDt: FIXED_DT,
    cases,
  };
}
