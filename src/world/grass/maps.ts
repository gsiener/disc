import * as THREE from 'three';
import { bake } from '../../util/Tex';
import { warpedFbm2, fbm2, ridged2, worley2, tileableFbm2, clamp, smoothstep } from '../../util/Noise';

/**
 * Baked lookup maps for the grass. Two textures, both read from the *vertex*
 * shader so per-blade variation costs two fetches and zero CPU work per frame.
 *
 *  - turf map   : low-frequency, world-mapped over the whole lawn. Carries the
 *                 same lushness / wear / soil signal the ground albedo should
 *                 use, so blades and field agree on where the pitch is worn.
 *  - noise map  : small, seamless, sampled at several world scales for the wind
 *                 gust field, the flutter and the tuft clumping.
 */

export interface TurfMapOpts {
  size: number;
  /** Half-extents of the lawn in metres (X, Z). */
  rx: number;
  rz: number;
  seed: number;
}

/** R lushness · G soil/thatch · B wear · A coverage. NoColorSpace — it is data. */
export function bakeTurfMap(o: TurfMapOpts): THREE.DataTexture {
  const { rx, rz, seed } = o;
  return bake((_x, _y, u, v, out, i) => {
    const wx = (u * 2 - 1) * rx;
    const wz = (v * 2 - 1) * rz;

    // Broad health patches — irrigation coverage, shade from the stands.
    let lush = warpedFbm2(wx * 0.026, wz * 0.026, 0.9, { octaves: 4, seed }) * 0.5 + 0.5;
    lush = lush * 0.78 + 0.22 * (fbm2(wx * 0.14, wz * 0.14, { octaves: 3, seed: seed + 11 }) * 0.5 + 0.5);
    // Slight crown: the middle of a well-kept pitch is the healthiest.
    lush += 0.10 * smoothstep(48, 8, Math.hypot(wx * 1.7, wz));
    lush = clamp(lush, 0, 1);

    // Traffic wear. Central corridor + brick marks + goal lines take a beating.
    const lane = Math.exp(-((wx / 11) ** 2)) * (0.35 + 0.65 * (fbm2(wx * 0.08, wz * 0.05, { octaves: 3, seed: seed + 21 }) * 0.5 + 0.5));
    const brick = Math.exp(-(((wx) / 1.9) ** 2 + ((Math.abs(wz) - 14) / 1.9) ** 2));
    const goal = Math.exp(-(((Math.abs(wz) - 32) / 1.4) ** 2)) * (Math.abs(wx) < 19 ? 1 : 0);
    const end = Math.exp(-(((Math.abs(wz) - 50) / 2.2) ** 2)) * (Math.abs(wx) < 19 ? 1 : 0);
    const scuff = Math.max(0, ridged2(wx * 0.55, wz * 0.55, { octaves: 3, seed: seed + 31 }) - 0.62) * 2.4;
    let wear = clamp(0.34 * lane + 0.62 * brick + 0.30 * goal + 0.22 * end + 0.55 * scuff, 0, 1);
    // Off-pitch surround is scruffier but not bald.
    const offPitch = smoothstep(18.5, 26, Math.abs(wx)) + smoothstep(50, 58, Math.abs(wz));
    wear = clamp(wear + 0.18 * Math.min(1, offPitch), 0, 1);

    // Thatch / soil showing through — correlates with wear but has its own grain.
    const cell = worley2(wx * 0.42, wz * 0.42, seed + 7);
    const soil = clamp(wear * 0.85 + 0.25 * (1 - clamp(cell.f2 - cell.f1, 0, 1)) - 0.08, 0, 1);

    // Coverage: 1 over the lawn, feathered at the very edge so the grass does
    // not terminate in a straight line, thinned where the turf is worn out.
    const edge = Math.min(
      smoothstep(0, 7, rx - Math.abs(wx)),
      smoothstep(0, 7, rz - Math.abs(wz)),
    );
    const cover = clamp(edge * (1 - 0.72 * Math.max(0, wear - 0.42) / 0.58), 0, 1);

    out[i] = lush * 255;
    out[i + 1] = soil * 255;
    out[i + 2] = wear * 255;
    out[i + 3] = cover * 255;
  }, {
    size: o.size,
    colorSpace: THREE.NoColorSpace,
    wrap: THREE.ClampToEdgeWrapping,
    mips: true,
    anisotropy: 1,
    name: 'grass.turf',
  });
}

/**
 * Seamless multi-band noise. Each channel is a different octave band so one
 * texture can serve the slow gust field, the fast flutter and the tufting
 * without the bands beating against each other.
 */
export function bakeNoiseMap(size: number, seed: number): THREE.DataTexture {
  return bake((_x, _y, u, v, out, i) => {
    const a = tileableFbm2(u, v, 3, { octaves: 3, seed });
    const b = tileableFbm2(u, v, 6, { octaves: 3, seed: seed + 101 });
    const c = tileableFbm2(u, v, 11, { octaves: 2, seed: seed + 211 });
    const d = tileableFbm2(u, v, 19, { octaves: 2, seed: seed + 307 });
    out[i] = (a * 0.5 + 0.5) * 255;
    out[i + 1] = (b * 0.5 + 0.5) * 255;
    out[i + 2] = (c * 0.5 + 0.5) * 255;
    out[i + 3] = (d * 0.5 + 0.5) * 255;
  }, {
    size,
    colorSpace: THREE.NoColorSpace,
    wrap: THREE.RepeatWrapping,
    mips: false,
    anisotropy: 1,
    name: 'grass.noise',
  });
}
