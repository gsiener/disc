/**
 * Deterministic CPU noise used to bake procedural textures at load time.
 * Everything here is seeded and allocation-free in the inner loops — baking a
 * 2048² albedo+normal+roughness set runs a few million samples, so the hot paths
 * avoid objects entirely.
 *
 * GLSL counterparts live in `src/util/glsl.ts` and are kept numerically
 * compatible so a shader can continue a pattern a baked map started.
 */

/* ------------------------------------------------------------------- hash */

export function hash2(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function hash3(x: number, y: number, z: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1274126177) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/* ------------------------------------------------------------------ value */

export function valueNoise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/* ---------------------------------------------------------------- gradient */

const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

function grad2(ix: number, iy: number, x: number, y: number, seed: number): number {
  const g = GRAD2[(hash2(ix, iy, seed) * 8) | 0];
  return g[0] * x + g[1] * y;
}

/** Perlin gradient noise, range roughly [-1, 1]. */
export function perlin2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  return lerp(
    lerp(grad2(xi, yi, xf, yf, seed), grad2(xi + 1, yi, xf - 1, yf, seed), u),
    lerp(grad2(xi, yi + 1, xf, yf - 1, seed), grad2(xi + 1, yi + 1, xf - 1, yf - 1, seed), u),
    v,
  );
}

/* ------------------------------------------------------------------- fbm */

export interface FbmOpts {
  octaves?: number;
  lacunarity?: number;
  gain?: number;
  seed?: number;
}

/** Fractal Brownian motion over perlin2. Output normalised to about [-1, 1]. */
export function fbm2(x: number, y: number, o: FbmOpts = {}): number {
  const oct = o.octaves ?? 5, lac = o.lacunarity ?? 2.0, gain = o.gain ?? 0.5;
  const seed = o.seed ?? 0;
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * perlin2(x * freq, y * freq, seed + i * 131);
    norm += amp;
    amp *= gain; freq *= lac;
  }
  return sum / norm;
}

/** Ridged multifractal — good for fibrous, veined and worn surfaces. */
export function ridged2(x: number, y: number, o: FbmOpts = {}): number {
  const oct = o.octaves ?? 5, lac = o.lacunarity ?? 2.0, gain = o.gain ?? 0.5;
  const seed = o.seed ?? 0;
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(perlin2(x * freq, y * freq, seed + i * 131));
    sum += amp * n * n;
    norm += amp;
    amp *= gain; freq *= lac;
  }
  return sum / norm;
}

/* ---------------------------------------------------------------- worley */

/**
 * Worley/cellular noise. Returns squared distance to the nearest feature point,
 * which is what most surface patterns (cracks, cells, pores) want.
 * `f2 - f1` gives clean cell borders.
 */
export function worley2(x: number, y: number, seed = 0): { f1: number; f2: number } {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 1e9, f2 = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const px = cx + hash2(cx, cy, seed);
      const py = cy + hash2(cx, cy, seed + 7919);
      const ex = px - x, ey = py - y;
      const d = ex * ex + ey * ey;
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return { f1: Math.sqrt(f1), f2: Math.sqrt(f2) };
}

/* ---------------------------------------------------------------- domain */

/** Domain-warped fbm — the cheapest way to make noise stop looking like noise. */
export function warpedFbm2(x: number, y: number, strength = 0.6, o: FbmOpts = {}): number {
  const qx = fbm2(x, y, o);
  const qy = fbm2(x + 5.2, y + 1.3, o);
  return fbm2(x + strength * qx, y + strength * qy, o);
}

/** Tileable fbm via 4-way blend. Slower, but seamless — use for repeating maps. */
export function tileableFbm2(u: number, v: number, period: number, o: FbmOpts = {}): number {
  const x = u * period, y = v * period;
  const a = fbm2(x, y, o);
  const b = fbm2(x - period, y, o);
  const c = fbm2(x, y - period, o);
  const d = fbm2(x - period, y - period, o);
  const wx = u, wy = v;
  return lerp(lerp(a, b, wx), lerp(c, d, wx), wy);
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const mix = lerp;
