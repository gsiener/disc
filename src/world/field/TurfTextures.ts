import * as THREE from 'three';
import { bake, heightToNormal } from '../../util/Tex';
import { hash2, tileableFbm2, clamp, smoothstep, mix } from '../../util/Noise';

/**
 * Procedural turf and apron texture sets. Everything is baked seamless: the
 * blade pattern is built from waves whose wavenumbers are integers in tile
 * space, so it wraps exactly while still reading as rotated, clumped grass
 * rather than a stripe pattern. The shader then samples the same set at two
 * very different world scales and blends them with a low-frequency mask, which
 * is what kills the repeat at distance.
 */

/** World size of one repeat of the detail set, in metres. */
export const DETAIL_TILE = 1.5;

export interface MapSet {
  albedo: THREE.DataTexture;
  normal: THREE.DataTexture;
  /** R = cavity AO, G = roughness, B = blade translucency. */
  data: THREE.DataTexture;
}

/* --------------------------------------------------- low-frequency fields */

const LR = 96;

function lowResField(period: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(LR * LR);
  for (let y = 0; y < LR; y++) {
    for (let x = 0; x < LR; x++) {
      out[y * LR + x] = tileableFbm2((x + 0.5) / LR, (y + 0.5) / LR, period, { octaves, seed });
    }
  }
  return out;
}

function sampleLR(f: Float32Array, u: number, v: number): number {
  const x = u * LR - 0.5, y = v * LR - 0.5;
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const j0 = ((xi % LR) + LR) % LR, j1 = (j0 + 1) % LR;
  const i0 = ((yi % LR) + LR) % LR, i1 = (i0 + 1) % LR;
  const a = f[i0 * LR + j0], b = f[i0 * LR + j1];
  const c = f[i1 * LR + j0], d = f[i1 * LR + j1];
  const t = a + (b - a) * fx;
  return t + ((c + (d - c) * fx) - t) * fy;
}

/* --------------------------------------------------------------- the turf */

/**
 * Blade lay directions. `k,l` are the blade-frequency wavenumbers (integers, so
 * the pattern tiles); `sk,sl` are a near-perpendicular pair used to cut each
 * stripe into individual blade segments. |k,l| ≈ 250 puts blades at ~6 mm on a
 * 1.5 m tile, which is life size.
 */
const LAY = [
  { k: 247, l: 37, sk: -6, sl: 37, seed: 11 },
  { k: 41, l: 244, sk: -37, sl: 6, seed: 29 },
  { k: 180, l: -170, sk: 26, sl: 27, seed: 47 },
];

export function bakeTurf(size: number, anisotropy: number): MapSet {
  const fLay = lowResField(3, 3, 101);      // which way the blades lie
  const fLay2 = lowResField(5, 3, 211);     // second lay blend
  const fClump = lowResField(7, 4, 307);    // tussock height
  const fHue = lowResField(4, 3, 419);      // colour drift between clumps
  const fThatch = lowResField(9, 3, 523);   // dead thatch showing through

  const height = new Float32Array(size * size);
  const shade = new Float32Array(size * size);
  const dens = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;

      // Sharpen the lay selection hard. Two blade directions at similar weight
      // sum into a diamond lattice, which is exactly the artefact that gives a
      // procedural lawn away as fabric — each patch must commit to one lay.
      const layA = sampleLR(fLay, u, v);
      const layB = sampleLR(fLay2, u, v);
      let w0 = smoothstep(-0.16, 0.16, layA);
      let w1 = 1 - w0;
      let w2 = 0.9 * smoothstep(0.18, 0.52, layB);
      w0 = w0 * w0 * w0; w1 = w1 * w1 * w1; w2 = w2 * w2 * w2;
      const inv = 1 / (w0 + w1 + w2 + 1e-5);
      const ws = [w0 * inv, w1 * inv, w2 * inv];

      let h = 0, sh = 0, wsum = 1e-5;
      for (let li = 0; li < 3; li++) {
        const m = ws[li];
        if (m < 0.02) continue;
        const L = LAY[li];
        const s = L.k * u + L.l * v;
        const id = Math.floor(s);
        const band = s - id;
        const seg = Math.floor(L.sk * u + L.sl * v);
        const r1 = hash2(id, seg, L.seed);
        const r2 = hash2(id, seg, L.seed + 7919);
        // sin(pi*band) is a clean blade cross-section; the exponent varies the width
        const prof = Math.pow(Math.sin(Math.PI * band), 0.9 + r1 * 2.4);
        const bh = prof * (0.48 + 0.80 * r2);
        h += m * bh;
        sh += m * bh * (0.55 + 0.95 * r1);
        wsum += m;
      }
      h /= wsum; sh /= wsum;

      const clump = sampleLR(fClump, u, v) * 0.5 + 0.5;
      h *= 0.58 + 0.85 * clump;
      const j = y * size + x;
      height[j] = h;
      shade[j] = sh;
      dens[j] = clump;
    }
  }

  /* -------- albedo: blade-to-blade colour, tussock drift, dead thatch ---- */
  const deep = [30, 51, 25], lush = [80, 112, 50], thatch = [84, 74, 42], soil = [58, 47, 33];
  const albedo = bake((x, y, u, v, out, i) => {
    const j = y * size + x;
    const h = height[j];
    const hue = sampleLR(fHue, u, v);
    const t = clamp(shade[j] * 1.25 + 0.16 * hue + 0.06, 0, 1);
    let r = mix(deep[0], lush[0], t);
    let g = mix(deep[1], lush[1], t);
    let b = mix(deep[2], lush[2], t);

    // thatch and bare soil in the gaps between blades
    const gap = 1 - smoothstep(0.04, 0.34, h);
    const th = clamp(0.30 + 0.85 * (sampleLR(fThatch, u, v) * 0.5 + 0.5), 0, 1);
    r = mix(r, thatch[0], gap * th * 0.62);
    g = mix(g, thatch[1], gap * th * 0.62);
    b = mix(b, thatch[2], gap * th * 0.62);
    const bare = (1 - smoothstep(0.0, 0.10, h)) * smoothstep(0.55, 0.95, th);
    r = mix(r, soil[0], bare * 0.7);
    g = mix(g, soil[1], bare * 0.7);
    b = mix(b, soil[2], bare * 0.7);

    // per-texel grain so a macro crop never looks like flat vector art
    const grain = 0.90 + 0.20 * hash2(x, y, 3);
    out[i] = r * grain; out[i + 1] = g * grain; out[i + 2] = b * grain; out[i + 3] = 255;
  }, { size, colorSpace: THREE.SRGBColorSpace, anisotropy, name: 'turf.albedo' });

  /* -------- data: cavity AO, roughness, translucency --------------------- */
  const data = bake((x, y, _u, _v, out, i) => {
    const j = y * size + x;
    const h = height[j];
    const ao = 0.30 + 0.70 * smoothstep(0.0, 0.55, h);
    // blade faces are waxy, the litter underneath is not
    const rough = 0.94 - 0.24 * smoothstep(0.15, 0.85, h);
    const trans = clamp(h * 0.9 + 0.25 * dens[j], 0, 1);
    out[i] = ao * 255; out[i + 1] = rough * 255; out[i + 2] = trans * 255; out[i + 3] = 255;
  }, { size, colorSpace: THREE.NoColorSpace, anisotropy, name: 'turf.data' });

  const normal = heightToNormal(height, size, size, 0.55, { anisotropy });
  normal.name = 'turf.normal';

  return { albedo, normal, data };
}

/* -------------------------------------------------------------- the apron */

/** Rubber-crumb / cinder apron: coarse granules, a little grit, matte. */
export function bakeApron(size: number, anisotropy: number): MapSet {
  const fPatch = lowResField(4, 3, 613);
  const fWear = lowResField(6, 3, 719);

  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // stacked hash cells at three granule sizes
      let h = 0;
      for (let o = 0; o < 3; o++) {
        const s = 24 << o;
        const cx = Math.floor((x / size) * s), cy = Math.floor((y / size) * s);
        h += (0.55 / (o + 1)) * hash2(cx, cy, 91 + o * 17);
      }
      h += 0.18 * hash2(x, y, 5);
      height[y * size + x] = h * 0.6;
    }
  }

  const base = [96, 51, 40], dark = [40, 24, 20], grit = [122, 114, 104];
  const albedo = bake((x, y, u, v, out, i) => {
    const h = height[y * size + x];
    const patch = sampleLR(fPatch, u, v) * 0.5 + 0.5;
    const wear = clamp(sampleLR(fWear, u, v) * 0.6 + 0.5, 0, 1);
    const t = clamp(h * 1.6 + 0.22 * patch, 0, 1);
    let r = mix(dark[0], base[0], t), g = mix(dark[1], base[1], t), b = mix(dark[2], base[2], t);
    const speck = hash2(x, y, 811);
    if (speck > 0.978) { r = mix(r, grit[0], 0.8); g = mix(g, grit[1], 0.8); b = mix(b, grit[2], 0.8); }
    // sun-bleached blotching so the ring is not one flat band of colour
    const f = (0.62 + 0.52 * wear) * (0.80 + 0.34 * patch);
    out[i] = r * f; out[i + 1] = g * f; out[i + 2] = b * f; out[i + 3] = 255;
  }, { size, colorSpace: THREE.SRGBColorSpace, anisotropy, name: 'apron.albedo' });

  const data = bake((x, y, u, v, out, i) => {
    const h = height[y * size + x];
    const wear = clamp(sampleLR(fWear, u, v) * 0.6 + 0.5, 0, 1);
    out[i] = (0.42 + 0.58 * smoothstep(0.05, 0.6, h)) * 255;
    out[i + 1] = (0.98 - 0.20 * wear) * 255;
    out[i + 2] = 0;
    out[i + 3] = 255;
  }, { size, colorSpace: THREE.NoColorSpace, anisotropy, name: 'apron.data' });

  const normal = heightToNormal(height, size, size, 1.6, { anisotropy });
  normal.name = 'apron.normal';
  return { albedo, normal, data };
}

/** Repeat-scaled clone; DataTexture.clone() shares the pixel buffer. */
export function tiled(tex: THREE.Texture, repeat: number): THREE.Texture {
  const t = tex.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.needsUpdate = true;
  return t;
}
