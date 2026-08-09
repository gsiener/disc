/**
 * Goldens for the AI throw solver — `Game.ts:aiThrow`.
 *
 * **This is the first differential fixture the integration layer has ever had,
 * and it exists because the layer was invented rather than ported.** For most of
 * this project `Engine.swift` carried a header saying `src/sim/Game.ts` was "not
 * a port target … integration glue rather than simulation", and on the strength
 * of that nobody read it. The throw solver inside it is not glue: it turns the
 * point the AI asked for into a disc, and the Swift side had a lerp in its place.
 *
 * Mutation testing then found the replacement could be broken in four different
 * ways without failing any of 2.2 million assertions, because every one of those
 * assertions was a component golden that the wiring never touches. Property
 * checks were added, and they help, but the honest answer for a function that is
 * a transcription of a reference function is a differential fixture. This is it.
 *
 * `aiThrow` is private to `GameSystem`, so it is transcribed here rather than
 * imported. That is a real risk — a transcription can drift from its original —
 * and it is mitigated the only way it can be: the transcription is kept beside
 * the reference in this repo, and the numbers below come from the reference's own
 * `DiscRuntime.probeThrow` and `powerForSpeed`, which are imported, not copied.
 *
 * The sweep covers every throw type the AI uses, headings all round the clock
 * (a disc banks, so lateral error changes sign with the heading, and a forehand
 * and a backhand curve opposite ways), and ranges as a fraction of the AI's own
 * `maxThrowRange`. The long fractions are deliberately included even though the
 * reference cannot make those throws: `maxThrowRange` and the flight model
 * disagree above about a third of the former, so the AI asks for hucks that land
 * badly short. That shortfall is reference behaviour — measured identically in
 * both languages — and pinning it here means a future change to either model is
 * a visible diff rather than a silent one.
 */

import * as THREE from 'three';
import { DiscRuntime, type ThrowRequest } from '../../src/entities/Disc.ts';
import { powerForSpeed } from '../../src/sim/aero/Throws.ts';
import { maxThrowRange, throwFlightTime, type AIPlayer } from '../../src/sim/AI.ts';

const clampNum = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const FIXED_DT = 1 / 120;

/** A fixed arm, so the fixture does not move when the roster generator does. */
const arm = {
  id: 0, team: 0, energy: 1,
  attr: {
    throwPower: 70, speed: 70, acceleration: 70, agility: 70, catching: 70,
    jumping: 70, defAwareness: 70, decision: 70, stamina: 70, height: 180,
  },
} as unknown as AIPlayer;

const TYPES = ['backhand', 'forehand', 'hammer', 'scoober', 'push'] as const;
const FRACTIONS = [0.15, 0.3, 0.35, 0.5, 0.7, 0.9];
const HEADINGS = 8;

/**
 * A transcription of `Game.ts:aiThrow`, lines 1508-1550. Every constant here is
 * the reference's: the [-0.34, 0.62] elevation bracket, seven halvings, the 1.02
 * on power, the 0.12 floor, the 0.25 m lateral gate and the two outer passes.
 */
function solve(
  rt: DiscRuntime, from: THREE.Vector3, aim: THREE.Vector3, type: string, speed: number,
): ThrowRequest | null {
  const tx = aim.x - from.x, tz = aim.z - from.z;
  const want = Math.hypot(tx, tz);
  if (want < 0.4) return null;

  const spin = clampNum(0.45 + 0.55 * (arm.attr.throwPower / 100), 0, 1);
  const power = clampNum(powerForSpeed(type as never, speed) * 1.02, 0.12, 1);
  const catchY = Math.max(0.35, aim.y);

  let heading = Math.atan2(tx, tz);
  let angle = 0.02;
  const dir = new THREE.Vector3();
  const req = {
    type, from, aim: dir, power, angle, spin, hand: 'R', bank: 0,
  } as unknown as ThrowRequest;

  for (let pass = 0; pass < 2; pass++) {
    let lo = -0.34, hi = 0.62;
    let best = angle, bestErr = Infinity, lat = 0;
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) * 0.5;
      req.angle = mid;
      dir.set(Math.sin(heading), 0, Math.cos(heading));
      const r = rt.probeThrow(req, catchY, 6);
      const err = r.dist - want;
      if (Math.abs(err) < Math.abs(bestErr)) { bestErr = err; best = mid; lat = r.lat; }
      if (err < 0) lo = mid; else hi = mid;
    }
    angle = best;
    req.angle = best;
    if (Math.abs(lat) > 0.25 && want > 1) heading -= Math.atan2(lat, want);
    if (pass === 1 || Math.abs(lat) <= 0.25) break;
  }
  dir.set(Math.sin(heading), 0, Math.cos(heading));
  req.angle = angle;
  return req;
}

/**
 * One sweep at a given wind.
 *
 * **The wind has to be part of the fixture.** `aiThrow` bisects against the same
 * `DiscRuntime` the match flies in, and that runtime carries the match's breeze —
 * so the solved elevation is a function of the wind, not just of the aim. A first
 * version of this fixture was generated in still air and compared against a Swift
 * engine that had just been given weather; it disagreed by up to 0.6 rad of launch
 * elevation, and both sides were right. The bisection's seventh halving is a
 * discrete branch, so a nudged probe selects a neighbouring angle rather than
 * drifting by an ulp.
 */
function sweep(wind: { x: number; z: number }): unknown {
  // Separate runtimes for probing and flying. This was first done on a hunch that a
  // flight ageing the runtime — `clock`, `sinceRelease`, the trail, `wear` — was moving
  // the next case's probe. It is not: the fixture is byte-identical either way. Kept
  // because it matches how the engine uses them, and recorded because a hunch that was
  // checked and found wrong is worth exactly as much as one that was right.
  const probeRt = new DiscRuntime();
  const flyRt = new DiscRuntime();
  probeRt.wind.set(wind.x, 0, wind.z);
  flyRt.wind.set(wind.x, 0, wind.z);
  const cases: unknown[] = [];

  for (const type of TYPES) {
    const reach = maxThrowRange(arm, type as never, 0);
    for (const fraction of FRACTIONS) {
      const range = reach * fraction;
      for (let step = 0; step < HEADINGS; step++) {
        const h = (step * Math.PI) / 4;
        const from = new THREE.Vector3(0, 1.35, 0);
        const aim = new THREE.Vector3(Math.sin(h) * range, 1.35, Math.cos(h) * range);
        const speed = range / Math.max(0.2, throwFlightTime(arm, type as never, range));
        const req = solve(probeRt, from, aim, type, speed);
        if (!req) continue;

        // Fly the solved release to rest. The closest approach is what the
        // solver is actually promising; the landing point is where it ends up.
        const vel = flyRt.release(req);
        const released = { x: vel.x, y: vel.y, z: vel.z };
        let closest = Infinity;
        let steps = 0;
        for (let i = 0; i < 120 * 8; i++) {
          flyRt.step(FIXED_DT);
          steps++;
          const d = Math.hypot(flyRt.state.pos.x - aim.x, flyRt.state.pos.z - aim.z);
          if (d < closest) closest = d;
          if (flyRt.state.atRest) break;
        }

        cases.push({
          type,
          reach,
          fraction,
          range,
          speed,
          from: { x: from.x, y: from.y, z: from.z },
          aim: { x: aim.x, y: aim.y, z: aim.z },
          solved: {
            power: req.power,
            angle: req.angle,
            spin: req.spin,
            aimX: req.aim.x,
            aimZ: req.aim.z,
          },
          released,
          flight: {
            closest,
            steps,
            restX: flyRt.state.pos.x,
            restZ: flyRt.state.pos.z,
          },
        });
      }
    }
  }

  return { wind, cases };
}

export function throwSolverGoldens(): unknown {
  return {
    note:
      'Game.ts:aiThrow solved against the reference DiscRuntime, then flown to rest. '
      + 'aiThrow is private to GameSystem so it is transcribed in '
      + 'tools/goldens/throwsolver.ts; probeThrow, release and powerForSpeed are '
      + 'imported from the reference. Two sweeps: still air, and a breeze of the size '
      + 'the match actually sets, because the solver bisects against the runtime that '
      + 'carries the wind. Fractions above ~0.35 of maxThrowRange land short on '
      + 'purpose: the AI range model and the flight model disagree there, in both '
      + 'languages.',
    sweeps: [sweep({ x: 0, z: 0 }), sweep({ x: 1.2, z: -0.8 })],
  };
}
