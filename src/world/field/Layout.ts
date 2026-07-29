import * as THREE from 'three';
import { fbm2, clamp, smoothstep } from '../../util/Noise';

/**
 * Regulation Ultimate geometry and the ground height field.
 *
 * Playing field is 100 × 37 m: a 64 m central zone plus two 18 m endzones.
 * Origin is field centre, long axis along Z, +Y up. Everything here is in
 * metres and world space — the turf shader reads world XZ directly rather than
 * UVs, so markings stay crisp at any zoom and never depend on mesh topology.
 */
export const FIELD = {
  /** Half the 37 m playing width — sidelines live at x = ±18.5. */
  halfWidth: 18.5,
  /** Half the 100 m total length — endlines live at z = ±50. */
  halfLength: 50,
  /** Goal lines: 18 m in from each endline. */
  goalLine: 32,
  /** Brick marks: 18 m in from each goal line. */
  brick: 14,
  /** Chalk half-width; regulation lines are ~10-12 cm. */
  lineHalfWidth: 0.06,

  /** Mown turf extends well past the pitch so it never ends in a hard edge. */
  turfHalfX: 33,
  turfHalfZ: 63,
  /** Rubber-crumb apron ring outside the turf. */
  apronHalfX: 46,
  apronHalfZ: 78,
} as const;

/**
 * Width of one mower pass, in metres. The turf shader turns this into a lay
 * direction and the grass system leans its blades by it, so both *must* read
 * the same number or the painted stripe and the physical stripe drift apart
 * and the anisotropy stops reading as one surface.
 */
export const MOW_STRIPE = 5.2;

/** The eight corner-cone positions, in play order. */
export const CORNER_CONES: readonly [number, number][] = [
  [-FIELD.halfWidth, -FIELD.halfLength], [FIELD.halfWidth, -FIELD.halfLength],
  [-FIELD.halfWidth, -FIELD.goalLine], [FIELD.halfWidth, -FIELD.goalLine],
  [-FIELD.halfWidth, FIELD.goalLine], [FIELD.halfWidth, FIELD.goalLine],
  [-FIELD.halfWidth, FIELD.halfLength], [FIELD.halfWidth, FIELD.halfLength],
];

/* ---------------------------------------------------------------- terrain */

const STEP = 0.375;
const PAD = 1.5;
const MIN_X = -FIELD.turfHalfX - PAD;
const MIN_Z = -FIELD.turfHalfZ - PAD;
const NX = Math.round((2 * (FIELD.turfHalfX + PAD)) / STEP) + 1;
const NZ = Math.round((2 * (FIELD.turfHalfZ + PAD)) / STEP) + 1;

/**
 * Ground height field. A pitch is never flat: it is crowned about 1% toward the
 * centre line for drainage and carries slow settlement waves on top. The whole
 * thing is baked into a grid once so `heightAt` is a couple of lookups rather
 * than a stack of fbm calls — grass and character IK hammer this per frame.
 */
export class Terrain {
  private readonly grid = new Float32Array(NX * NZ);

  constructor(seed = 0) {
    for (let j = 0; j < NZ; j++) {
      const z = MIN_Z + j * STEP;
      for (let i = 0; i < NX; i++) {
        this.grid[j * NX + i] = Terrain.analytic(MIN_X + i * STEP, z, seed);
      }
    }
  }

  /**
   * Crown + undulation, tapered to exactly 0 at the turf border so the apron
   * meets it flush. The crown *falls away* from the centre line rather than
   * rising above it — the centre of the field is the gameplay datum at y = 0,
   * so the pitch drains outward from there rather than lifting everything.
   */
  private static analytic(x: number, z: number, seed: number): number {
    const tx = clamp(x / 20, -1, 1);
    let h = -0.185 * tx * tx;
    const tz = clamp(Math.abs(z) / 66, 0, 1);
    h *= 1 - 0.40 * tz * tz;

    let u = 0.042 * fbm2(x * 0.021 + 3.1, z * 0.021 - 1.7, { octaves: 3, seed: 917 + seed });
    u += 0.024 * fbm2(x * 0.086, z * 0.086, { octaves: 2, seed: 2231 + seed });
    u += 0.007 * fbm2(x * 0.33, z * 0.33, { octaves: 2, seed: 55 + seed });

    const ex = 1 - smoothstep(FIELD.turfHalfX - 7, FIELD.turfHalfX, Math.abs(x));
    const ez = 1 - smoothstep(FIELD.turfHalfZ - 7, FIELD.turfHalfZ, Math.abs(z));
    const edge = ex * ez;
    return (h + u) * edge;
  }

  /** Ground height in metres. Clamped outside the mown turf (the apron is flat). */
  heightAt(x: number, z: number): number {
    const fx = clamp((x - MIN_X) / STEP, 0, NX - 1.001);
    const fz = clamp((z - MIN_Z) / STEP, 0, NZ - 1.001);
    const i = fx | 0, j = fz | 0;
    let a = fx - i, b = fz - j;
    // smootherstep weights keep the interpolated normals C1-continuous
    a = a * a * (3 - 2 * a); b = b * b * (3 - 2 * b);
    const g = this.grid, r0 = j * NX + i, r1 = r0 + NX;
    const t = g[r0] + (g[r0 + 1] - g[r0]) * a;
    const u = g[r1] + (g[r1 + 1] - g[r1]) * a;
    return t + (u - t) * b;
  }

  /** Surface normal for foot alignment / prop planting. */
  normalAt(x: number, z: number, out?: THREE.Vector3): THREE.Vector3 {
    const d = 0.45;
    const hx = this.heightAt(x + d, z) - this.heightAt(x - d, z);
    const hz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    const v = out ?? new THREE.Vector3();
    return v.set(-hx / (2 * d), 1, -hz / (2 * d)).normalize();
  }
}
