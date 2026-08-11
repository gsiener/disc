/**
 * The solver flown against nobody — issue #4, assertion 3.
 *
 * For a realistic release height (a standing hand, ~1.05 m, not the 1.35 m the
 * throwsolver golden sweeps) solve a throw at each ask height and report:
 *   - closest approach to the aim point, the solver's own accuracy;
 *   - whether the flight ever rose above the ASKED plane, i.e. whether the ask
 *     was reachable at all;
 *   - the plane the solve actually used after `SOLVE_CATCH_DROP`'s clamp.
 *
 * Run: node --experimental-strip-types tools/_solveprobe.ts <askY> [<askY> ...]
 */
import * as THREE from 'three';
import { DiscRuntime, type ThrowRequest } from '../src/entities/Disc.ts';
import { powerForSpeed } from '../src/sim/aero/Throws.ts';
import { solveRelease, SOLVE_CATCH_DROP } from '../src/sim/aero/ThrowSolver.ts';
import { maxThrowRange, throwFlightTime, type AIPlayer } from '../src/sim/AI.ts';

const clampNum = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const DT = 1 / 120;

const arm = {
  id: 0, team: 0, energy: 1,
  attr: {
    throwPower: 70, speed: 70, acceleration: 70, agility: 70, catching: 70,
    jumping: 70, defAwareness: 70, decision: 70, stamina: 70, height: 180,
  },
} as unknown as AIPlayer;

const TYPES = ['backhand', 'forehand', 'hammer', 'scoober', 'push'] as const;
const FRACTIONS = [0.05, 0.1, 0.15, 0.3, 0.35, 0.5, 0.7, 0.9];
const HEADINGS = 8;
/** Release heights a real roster produces: hipHeight * 1.10 across 168-192 cm. */
const RELEASES = [0.98, 1.02, 1.05, 1.09, 1.13];

const asks = (process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n)));
if (!asks.length) asks.push(1.35, 0.8);

const sorted = (a: number[]): number[] => [...a].sort((p, q) => p - q);
const median = (a: number[]): number => (a.length ? sorted(a)[a.length >> 1]! : NaN);
const pct = (a: number[], q: number): number =>
  a.length ? sorted(a)[Math.min(a.length - 1, Math.floor(a.length * q))]! : NaN;

for (const askY of asks) {
  const closest: number[] = [];
  let n = 0, unreachableAsk = 0, neverRose = 0, groundedShort = 0;

  const probeRt = new DiscRuntime();
  const flyRt = new DiscRuntime();

  for (const fromY of RELEASES) {
    for (const type of TYPES) {
      const reach = maxThrowRange(arm, type as never, 0);
      for (const fraction of FRACTIONS) {
        const range = reach * fraction;
        for (let step = 0; step < HEADINGS; step++) {
          const h = (step * Math.PI) / 4;
          const snap = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v);
          const from = new THREE.Vector3(0, fromY, 0);
          const aim = new THREE.Vector3(
            snap(Math.sin(h)) * range, askY, snap(Math.cos(h)) * range);
          const speed = range / Math.max(0.2, throwFlightTime(arm, type as never, range));
          const tx = aim.x - from.x, tz = aim.z - from.z;
          const want = Math.hypot(tx, tz);
          if (want < 0.4) continue;

          const spin = clampNum(0.45 + 0.55 * (arm.attr.throwPower / 100), 0, 1);
          const power = clampNum(powerForSpeed(type as never, speed) * 1.02, 0.12, 1);
          const catchY0 = Math.max(0.35, aim.y);
          if (catchY0 > from.y - SOLVE_CATCH_DROP) unreachableAsk++;

          const req = {
            type, from, aim: new THREE.Vector3(), power, angle: 0.02, spin,
            hand: 'R', bank: 0,
          } as unknown as ThrowRequest;
          solveRelease(probeRt, req, Math.atan2(tx, tz), want, catchY0);

          const vel = flyRt.release(req);
          void vel;
          let best = Infinity;
          let peak = -Infinity;
          for (let i = 0; i < 120 * 8; i++) {
            flyRt.step(DT);
            if (flyRt.state.pos.y > peak) peak = flyRt.state.pos.y;
            const d = Math.hypot(flyRt.state.pos.x - aim.x, flyRt.state.pos.z - aim.z);
            if (d < best) best = d;
            if (flyRt.state.atRest) break;
          }
          n++;
          closest.push(best);
          if (peak < catchY0) neverRose++;
          if (best > 3) groundedShort++;
        }
      }
    }
  }

  console.log(
    `ask ${askY.toFixed(2)} m  n=${n}`
    + `  closest median=${median(closest).toFixed(3)} p90=${pct(closest, 0.9).toFixed(3)}`
    + ` mean=${(closest.reduce((a, b) => a + b, 0) / n).toFixed(3)}`
    + `  ask-above-reachable-plane=${unreachableAsk}`
    + `  flight-never-reached-ask=${neverRose}`
    + `  miss>3m=${groundedShort}`,
  );
}
