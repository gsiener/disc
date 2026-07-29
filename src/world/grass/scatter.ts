/**
 * LOD ring planning and the jittered-grid scatter.
 *
 * Blades live on a grid of cells whose *world* integer index is reconstructed in
 * the shader (`uCellOrigin + aCell`), so every per-blade property — jitter, yaw,
 * height, hue, phase — is hashed from a world coordinate and stays pinned to the
 * ground while the camera-centred tile slides underneath it. The only thing the
 * CPU uploads is the cell index: 4 bytes per blade.
 *
 * Rings overlap. Inside an overlap band both rings' blades are present and each
 * one shrinks to zero height across a per-blade randomised threshold, so the
 * handover reads as a gradual thinning rather than a ring of short grass.
 */

export interface RingSpec {
  /** Radii of the annulus this ring populates (metres, from the camera). */
  inner: number;
  outer: number;
  /** Cross-fade band widths at each end. */
  fadeIn: number;
  fadeOut: number;
  cell: number;
  count: number;
  segments: number;
  /** Blade width multiplier — keeps coverage constant as density drops. */
  widthScale: number;
}

const SHARE = [0.30, 0.34, 0.36];
const SEGMENTS = [4, 3, 1];

export function planRings(budget: number, distance: number): RingSpec[] {
  const d = Math.max(12, distance);
  const r0 = Math.min(Math.max(d * 0.22, 3.2), 8.5);
  const r1 = Math.min(Math.max(d * 0.55, 9), 27);
  const bounds: Array<[number, number]> = [[0, r0], [r0, r1], [r1, d]];

  const specs: RingSpec[] = [];
  let cell0 = 0.02;
  for (let i = 0; i < 3; i++) {
    const [ra, rb] = bounds[i];
    const band = (rb - ra) * 0.16;
    const inner = i === 0 ? 0 : ra - band * 0.9;
    const outer = rb;
    const area = Math.PI * (outer * outer - inner * inner);
    const count = Math.max(256, Math.round(budget * SHARE[i]));
    const cell = Math.sqrt(area / count);
    if (i === 0) cell0 = cell;
    specs.push({
      inner,
      outer,
      fadeIn: i === 0 ? 0 : band,
      fadeOut: i === 2 ? Math.max(4, (outer - inner) * 0.22) : band,
      cell,
      count,
      segments: SEGMENTS[i],
      widthScale: Math.pow(cell / cell0, 0.82),
    });
  }
  return specs;
}

/** Integer cell offsets covering the ring's annulus, as int16 pairs. */
export function buildCells(spec: RingSpec): Int16Array {
  const c = spec.cell;
  const n = Math.ceil(spec.outer / c) + 1;
  const inner2 = spec.inner * spec.inner;
  const outer2 = spec.outer * spec.outer;
  const cap = Math.min(spec.count * 1.25 + 4096, (2 * n + 1) * (2 * n + 1));
  const out = new Int16Array(Math.ceil(cap) * 2);
  let w = 0;
  const lim = out.length - 2;
  outer:
  for (let j = -n; j <= n; j++) {
    const z = j * c;
    const z2 = z * z;
    for (let i = -n; i <= n; i++) {
      const x = i * c;
      const d2 = x * x + z2;
      if (d2 < inner2 || d2 >= outer2) continue;
      if (w > lim) break outer;
      out[w++] = i;
      out[w++] = j;
    }
  }
  return out.subarray(0, w);
}
