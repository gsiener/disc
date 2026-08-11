/**
 * Direct probe of `src/sim/aero/ThrowSolver.ts` under wind, independent of the
 * match — issue #32, `.agents/friction-log/20260810-throwsolver-wind-blind/`.
 *
 * `tools/test-ai.ts`'s `windy completion %` assertion says completion falls
 * apart in wind; this asks the solver directly, for a fixed straight-ahead
 * heading and a battery of wind vectors and target distances, how far the
 * ACTUAL landing point (re-flown with the solved angle/bank/heading) misses
 * the point the thrower meant to hit. It is what found the 37 m residual on a
 * 32 m throw that motivated the heading secant, and what caught two failed
 * attempts at the fix before the current one (a closed-form lead angle with
 * the wrong sign in some regimes, and a joint per-pass bank+heading secant
 * that oscillated a pure-tailwind case out to 35.7 m).
 *
 *   node --experimental-strip-types tools/_wind_probe.ts
 */
import * as THREE from 'three';
import { DiscRuntime, type ThrowRequest } from '../src/sim/DiscRuntime.ts';
import { solveRelease, SOLVE_CATCH_DROP } from '../src/sim/aero/ThrowSolver.ts';
import { STANDING_CATCH_FLOOR } from '../src/sim/Rules.ts';
import { powerForSpeed } from '../src/sim/aero/Throws.ts';

const rt = new DiscRuntime();
rt.groundAt = () => 0;

const clampNum = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function tryThrow(
  wind: { x: number; z: number }, want: number, type: 'backhand' | 'forehand' = 'backhand',
) {
  rt.wind.set(wind.x, 0, wind.z);
  const from = new THREE.Vector3(0, 1.05, 0);
  // Match Game.aiThrow's own initial guess: power from a rough speed model, not a fixed 0.7.
  const guessSpeed = 14 + 0.35 * want; // crude stand-in for throwReleaseSpeed
  const req: ThrowRequest = {
    type, from, aim: new THREE.Vector3(0, 0, 1), power: clampNum(powerForSpeed(type, guessSpeed) * 1.02, 0.12, 1),
    angle: 0.02, spin: 0.6, hand: 'R', bank: 0,
  };
  const heading0 = 0; // aim straight downfield (+z)
  const catchY0 = 1.0;
  const catchY = clampNum(catchY0, STANDING_CATCH_FLOOR, from.y - SOLVE_CATCH_DROP);
  const sol = solveRelease(rt, req, heading0, want, catchY0, wind);
  // Now actually release and integrate the FULL flight with the solved params to see where it lands.
  req.angle = sol.angle;
  req.bank = sol.bank;
  req.aim.set(Math.sin(sol.heading), 0, Math.cos(sol.heading));
  const r = rt.probeThrow(req, catchY, 8);
  // Target was `want` metres along the ORIGINAL heading0 (straight ahead, +z).
  const targetX = Math.sin(heading0) * want;
  const targetZ = Math.cos(heading0) * want;
  const missX = r.x - targetX;
  const missZ = r.z - targetZ;
  const missDist = Math.hypot(missX, missZ);
  return { want, sol, landX: r.x, landZ: r.z, missX, missZ, missDist };
}

for (const want of [8, 15, 25, 32]) {
  console.log(`\n--- want=${want}m ---`);
  for (const wind of [
    { x: 0, z: 0 }, { x: 9.5, z: 0 }, { x: -9.5, z: 0 }, { x: 0, z: 2 }, { x: 0, z: -2 },
    { x: 9.5, z: 2.0 }, { x: -9.5, z: -2.0 }, { x: -9.5, z: 2.0 }, { x: 9.5, z: -2.0 },
  ]) {
    const r = tryThrow(wind, want);
    console.log(
      `wind=(${wind.x},${wind.z})  heading=${r.sol.heading.toFixed(3)} bank=${r.sol.bank.toFixed(3)} `
      + `angle=${r.sol.angle.toFixed(3)}  actualXZ=(${r.landX.toFixed(2)},${r.landZ.toFixed(2)})`
      + `  miss=(${r.missX.toFixed(2)},${r.missZ.toFixed(2)}) |miss|=${r.missDist.toFixed(2)}`,
    );
  }
}
