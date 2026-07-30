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
  /**
   * Chalk half-width. WFDF marks lines "not more than 120 mm" wide, and a
   * venue that expects a camera paints to the top of that allowance and then
   * some — a 12 cm line seen from the broadcast position at z = -50 covers
   * about two thirds of a pixel across, which is why Round 2 read the markings
   * as "essentially missing at the wide angles". 15 cm is still regulation, is
   * what a lining machine with a double pass actually lays down, and buys the
   * far end line a full pixel of coverage. See `turfShade` for the other half
   * of that fix — the filter width and the erosion term.
   */
  lineHalfWidth: 0.075,

  /** Mown turf extends well past the pitch so it never ends in a hard edge. */
  turfHalfX: 33,
  turfHalfZ: 63,
  /** Rubber-crumb apron ring outside the turf. */
  apronHalfX: 46,
  apronHalfZ: 78,
} as const;

/**
 * Vertical datums, in metres.
 *
 * ## Why these numbers are not free
 *
 * The venue lays a hardstand plane across the whole site at y = -0.09 (see
 * `stadium/Exterior.ts`). A pitch modelled *below* that plane does not read as
 * a sunken pitch — it is simply not drawn, and the plane's intersection with
 * the crowned turf mesh becomes a hard faceted isoline across the field.
 *
 * That is precisely what was happening. The crown was authored as a 1 % fall
 * from a centre line pinned at y = 0, which puts the touchlines 16 cm and the
 * run-off 18 cm *under* grade: every pixel of the pitch beyond |x| = 14 m —
 * both sidelines, the ends of both goal lines and both end lines, the mown
 * edge, the apron, the corner cones — was hidden, and the jagged green/grey
 * boundary in the broadcast frame was the h = -0.09 contour, not a real edge.
 *
 * A built pitch is a raised dome that drains to a perimeter sitting *on* grade,
 * so the fix is a datum fix, not a cosmetic one: nothing on the playing surface
 * may go below `floorY`, and the run-off meets the turf at `apronY`.
 */
export const GRADE = {
  /** Site hardstand. Anything at or below this is invisible inside the venue. */
  siteY: -0.09,
  /** Lowest point the playing surface is allowed to reach. */
  floorY: -0.058,
  /** Run-off apron deck — the height the mown edge ramps down onto. */
  apronY: -0.052,
  /** Rough outfield. Deliberately under `siteY`: past the apron the venue's own
   *  hardstand owns the ground, and lifting this ring over it would carpet the
   *  car parks in grass in the establishing shot. */
  outfieldY: -0.16,
  /** Width of the ramp from the crowned pitch down onto the apron deck. */
  rimWidth: 2.4,
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
   * Crown + undulation, ramped onto the apron deck at the turf border.
   *
   * The profile is a *shouldered* crown: a quadratic fall from the centre line
   * (the same 1 % that a groundsman cuts, and the same curve the grass system
   * mirrors in `grass/shader.ts`) which then flattens into a shoulder so the
   * touchlines and the run-off come back up onto grade. The quartic term is
   * what does that — it is negligible in the middle third of the pitch, where
   * every close shot lives and where the sward has to agree with the surface it
   * grows out of, and it lifts the outer thirds by 11 cm so the pitch is not
   * buried under the site hardstand. See `GRADE` above for why that matters.
   *
   * The settlement waves are half their old amplitude for the same reason: they
   * used to be able to dig a further 7 cm, which was enough on its own to punch
   * the deepest hollows back under grade.
   */
  private static analytic(x: number, z: number, seed: number): number {
    const tx = clamp(x / 20, -1, 1);
    const t2 = tx * tx;
    let h = -0.185 * t2 + 0.150 * t2 * t2;
    const tz = clamp(Math.abs(z) / 66, 0, 1);
    h *= 1 - 0.40 * tz * tz;

    let u = 0.019 * fbm2(x * 0.021 + 3.1, z * 0.021 - 1.7, { octaves: 3, seed: 917 + seed });
    u += 0.011 * fbm2(x * 0.086, z * 0.086, { octaves: 2, seed: 2231 + seed });
    u += 0.005 * fbm2(x * 0.33, z * 0.33, { octaves: 2, seed: 55 + seed });

    // Crown and waves both fade out before the border…
    const ex = 1 - smoothstep(FIELD.turfHalfX - 9, FIELD.turfHalfX - GRADE.rimWidth, Math.abs(x));
    const ez = 1 - smoothstep(FIELD.turfHalfZ - 9, FIELD.turfHalfZ - GRADE.rimWidth, Math.abs(z));
    // …and the last couple of metres ramp down onto the apron deck, so the turf
    // and the run-off share a height at the seam instead of meeting at a step.
    const rx = smoothstep(FIELD.turfHalfX - GRADE.rimWidth, FIELD.turfHalfX, Math.abs(x));
    const rz = smoothstep(FIELD.turfHalfZ - GRADE.rimWidth, FIELD.turfHalfZ, Math.abs(z));
    const rim = Math.max(rx, rz);

    return Math.max((h + u) * ex * ez + GRADE.apronY * rim, GRADE.floorY);
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
