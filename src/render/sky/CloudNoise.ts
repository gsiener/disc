import * as THREE from 'three';
import { hash3, clamp, mix, tileableFbm2 } from '../../util/Noise';
import { bake } from '../../util/Tex';

/**
 * Volume noise for the cloud raymarcher.
 *
 * The march takes ~200 density samples per pixel, so density *cannot* be built
 * from per-sample hash noise — that is 30+ hashes per octave and it melts the
 * GPU. Instead we pay once at load time to bake tiling 3D fields into two small
 * volumes, and the shader then costs one hardware-filtered fetch per octave
 * band:
 *
 *   shape  (RGBA)  R = perlin-worley base, GBA = worley at 3 rising frequencies
 *   detail (RGB)   three decorrelated worley bands used for erosion + warping
 *
 * The lattices are filled from `Noise.hash3`, and the weather map from
 * `Noise.tileableFbm2` through `Tex.bake`, so all randomness stays in the
 * shared deterministic helpers.
 */

/* ------------------------------------------------------------ 3D primitives */

/** Tiling value-noise lattice of n³ samples. */
function lattice(n: number, seed: number): Float32Array {
  const a = new Float32Array(n * n * n);
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) a[(z * n + y) * n + x] = hash3(x, y, z, seed);
    }
  }
  return a;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Trilinear value noise over a wrapped lattice; x,y,z in lattice units. */
function value3(x: number, y: number, z: number, n: number, lat: Float32Array): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = smooth(x - xi), fy = smooth(y - yi), fz = smooth(z - zi);
  const x0 = ((xi % n) + n) % n, x1 = (x0 + 1) % n;
  const y0 = ((yi % n) + n) % n, y1 = (y0 + 1) % n;
  const z0 = ((zi % n) + n) % n, z1 = (z0 + 1) % n;
  const at = (px: number, py: number, pz: number) => lat[(pz * n + py) * n + px];
  const c00 = mix(at(x0, y0, z0), at(x1, y0, z0), fx);
  const c10 = mix(at(x0, y1, z0), at(x1, y1, z0), fx);
  const c01 = mix(at(x0, y0, z1), at(x1, y0, z1), fx);
  const c11 = mix(at(x0, y1, z1), at(x1, y1, z1), fx);
  return mix(mix(c00, c10, fy), mix(c01, c11, fy), fz);
}

/** Feature points for a tiling worley grid: n³ cells, one jittered point each. */
function features(n: number, seed: number): Float32Array {
  const p = new Float32Array(n * n * n * 3);
  let i = 0;
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        p[i++] = x + hash3(x, y, z, seed);
        p[i++] = y + hash3(x, y, z, seed + 7919);
        p[i++] = z + hash3(x, y, z, seed + 104729);
      }
    }
  }
  return p;
}

/** Inverted worley (1 - f1), so high values are cloud interiors. */
function worley3(x: number, y: number, z: number, n: number, pts: Float32Array): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best = 1e9;
  for (let dz = -1; dz <= 1; dz++) {
    const cz = zi + dz, wz = ((cz % n) + n) % n;
    for (let dy = -1; dy <= 1; dy++) {
      const cy = yi + dy, wy = ((cy % n) + n) % n;
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, wx = ((cx % n) + n) % n;
        const i = ((wz * n + wy) * n + wx) * 3;
        const px = pts[i] + (cx - wx), py = pts[i + 1] + (cy - wy), pz = pts[i + 2] + (cz - wz);
        const ex = px - x, ey = py - y, ez = pz - z;
        const d = ex * ex + ey * ey + ez * ez;
        if (d < best) best = d;
      }
    }
  }
  return clamp(1 - Math.sqrt(best), 0, 1);
}

function remap(v: number, a: number, b: number, c: number, d: number): number {
  return c + ((v - a) / (b - a)) * (d - c);
}

/* ------------------------------------------------------------------ volumes */

function volume(
  size: number, channels: number,
  fn: (u: number, v: number, w: number, out: Uint8ClampedArray, i: number) => void,
): THREE.Data3DTexture {
  const data = new Uint8ClampedArray(size * size * size * 4);
  for (let z = 0; z < size; z++) {
    const w = (z + 0.5) / size;
    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      for (let x = 0; x < size; x++) {
        fn((x + 0.5) / size, v, w, data, ((z * size + y) * size + x) * 4);
      }
    }
  }
  void channels;
  const tex = new THREE.Data3DTexture(new Uint8Array(data.buffer), size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export interface CloudTextures {
  shape: THREE.Data3DTexture;
  detail: THREE.Data3DTexture;
  weather: THREE.DataTexture;
  dispose(): void;
}

/**
 * @param res shape-volume resolution (48 on low tiers, 64 otherwise). Cost is
 *            O(res³ · 27) — 64³ is roughly 0.6 s of one-off CPU work.
 */
export function bakeCloudTextures(res = 64): CloudTextures {
  /* shape ---------------------------------------------------------------- */
  const latF = [4, 8, 16, 32].map((n, i) => ({ n, lat: lattice(n, 1301 + i * 97) }));
  const wLow = [3, 6, 12].map((n, i) => ({ n, pts: features(n, 4201 + i * 131) }));
  const wDet = [5, 10, 18].map((n, i) => ({ n, pts: features(n, 8101 + i * 173) }));

  const shape = volume(res, 4, (u, v, w, out, i) => {
    // Perlin-ish fbm base from the value lattices.
    let sum = 0, norm = 0, amp = 1;
    for (const { n, lat } of latF) {
      sum += amp * value3(u * n, v * n, w * n, n, lat);
      norm += amp; amp *= 0.5;
    }
    const perlin = sum / norm;

    // Worley fbm, low frequency: gives the billowy cauliflower structure.
    let ws = 0, wn = 0, wa = 1;
    for (const { n, pts } of wLow) {
      ws += wa * worley3(u * n, v * n, w * n, n, pts);
      wn += wa; wa *= 0.5;
    }
    const worleyLow = ws / wn;

    // Classic perlin-worley remap (Guerrilla / Nubis).
    const pw = clamp(remap(perlin, worleyLow - 1, 1, 0, 1), 0, 1);
    out[i] = pw * 255;
    for (let c = 0; c < 3; c++) {
      const { n, pts } = wDet[c];
      out[i + 1 + c] = worley3(u * n, v * n, w * n, n, pts) * 255;
    }
  });

  /* detail --------------------------------------------------------------- */
  const dres = Math.max(24, (res >> 1));
  const dPts = [4, 8, 14].map((n, i) => ({ n, pts: features(n, 22307 + i * 619) }));
  const detail = volume(dres, 3, (u, v, w, out, i) => {
    for (let c = 0; c < 3; c++) {
      const { n, pts } = dPts[c];
      out[i + c] = worley3(u * n, v * n, w * n, n, pts) * 255;
    }
    out[i + 3] = 255;
  });

  /* weather -------------------------------------------------------------- */
  // Coverage / cloud-type / density at "map" scale — one tile ≈ 22 km, which is
  // what stops the sky reading as one uniform field of noise.
  const weather = bake((_x, _y, u, v, out, i) => {
    const qx = tileableFbm2(u, v, 3, { octaves: 3, seed: 11 });
    const qy = tileableFbm2(u, v, 3, { octaves: 3, seed: 29 });
    const cov = tileableFbm2(u + 0.08 * qx, v + 0.08 * qy, 3, { octaves: 5, seed: 47 });
    const type = tileableFbm2(u, v, 2, { octaves: 3, seed: 71 });
    const wet = tileableFbm2(u + 0.05 * qy, v - 0.05 * qx, 4, { octaves: 4, seed: 97 });
    out[i] = clamp(cov * 0.5 + 0.5, 0, 1) * 255;
    out[i + 1] = clamp(type * 0.6 + 0.5, 0, 1) * 255;
    out[i + 2] = clamp(wet * 0.5 + 0.5, 0, 1) * 255;
    out[i + 3] = 255;
  }, { size: 256, colorSpace: THREE.NoColorSpace, wrap: THREE.RepeatWrapping, name: 'sky.weather' });

  return {
    shape, detail, weather,
    dispose() { shape.dispose(); detail.dispose(); weather.dispose(); },
  };
}

/**
 * CPU stand-in for the shader's cloud cover, used by the environment bake. The
 * env map is PMREM-blurred to oblivion so it only needs the *average* effect of
 * cloud on sky radiance, not the shapes.
 */
export function cloudCoverAt(dx: number, dy: number, dz: number, coverage: number, time: number): number {
  if (dy <= 0.02) return 0;
  const t = 1800 / dy;                       // hit the cloud plane
  const px = (dx * t + time * 6) / 22000;
  const pz = (dz * t + time * 2) / 22000;
  const q = tileableFbm2(px - Math.floor(px), pz - Math.floor(pz), 3, { octaves: 3, seed: 11 });
  const c = tileableFbm2(
    px - Math.floor(px) + 0.08 * q, pz - Math.floor(pz) + 0.08 * q, 3, { octaves: 5, seed: 47 },
  ) * 0.5 + 0.5;
  const m = clamp((c - (1 - coverage)) / 0.35, 0, 1);
  return m * m * (3 - 2 * m) * clamp((dy - 0.02) / 0.16, 0, 1);
}
