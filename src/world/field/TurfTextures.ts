import * as THREE from 'three';
import { bake, heightToNormal } from '../../util/Tex';
import { hash2, tileableFbm2, clamp, smoothstep, mix } from '../../util/Noise';

/**
 * Procedural turf and apron texture sets. Everything is baked seamless: the
 * tuft pattern is built from waves whose wavenumbers are integers in tile space,
 * so it wraps exactly while still reading as rotated, clumped grass rather than
 * a stripe pattern. The shader then samples the same set at two very different
 * world scales and blends them with a low-frequency mask, which is what kills
 * the repeat at distance.
 *
 * ## Why the wavenumbers are small
 *
 * The original table used |k,l| ≈ 250 on a 1.5 m tile so that one band was a
 * 6 mm *blade*. At a 512² bake that is 2.05 texels per band — right on Nyquist.
 * The blade profile `sin(pi·band)^p` is not a pure tone: its second harmonic
 * sits at 500 cycles/tile, which on a 512 grid folds straight back down to
 * |512 − 500| = 12 cycles/tile ≈ 12 cm. That folded harmonic is a low-frequency
 * beat, it survives mipping, it beats against the second lay direction, and it
 * is *exactly* the basket-weave "woven fabric" the pitch was showing at every
 * distance. No amount of anisotropy or mip filtering removes it because it is
 * in the source pixels.
 *
 * So the bake is now band-limited by construction: `BAND` is fixed at 44 bands
 * per tile, which is ≥ 11 texels per band at the smallest tier (512) and leaves
 * headroom for four harmonics below Nyquist. One band on a 1 m tile is 23 mm —
 * a *tuft*, not a blade. Blade-scale detail is not the texture's job any more:
 * the 3D grass covers the near field, and TurfMaterial synthesises a fine
 * analytic grain (which cannot tile and which retires cleanly with distance)
 * for the pixels in between.
 */

/** World size of one repeat of the detail set, in metres. */
export const DETAIL_TILE = 1.0;

/** Tuft bands per tile. Fixed so the look does not change with texture tier. */
const BAND = 44;

export interface MapSet {
  albedo: THREE.DataTexture;
  normal: THREE.DataTexture;
  /** R = cavity AO, G = roughness, B = blade translucency. */
  data: THREE.DataTexture;
  /** Linear-space mean of `albedo` — what the set fades to once it is sub-pixel. */
  meanAlbedo: THREE.Vector3;
  /** Mean of `data`, same purpose. */
  meanData: THREE.Vector3;
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

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

/* --------------------------------------------------------------- the turf */

/**
 * Tuft lay directions. `k,l` are the tuft-frequency wavenumbers (integers, so
 * the pattern tiles); `sk,sl` are a near-perpendicular pair that cuts each lay
 * band into discrete tufts along its length. All three have |k,l| ≈ 44, so no
 * direction has visibly wider bands than another.
 *
 * The angles (20° / 78° / 138°) are deliberate. Anything close to 0° or 90° in
 * tile space lands parallel to a world axis, which reads as a printed grid;
 * anything at 45° reads as a single dominant diagonal corduroy. Three angles
 * evenly spread and none of them axis- or diagonal-aligned is what makes the
 * eye read "grass" instead of "weave".
 */
const LAY = [
  { k: 41, l: 15, sk: -4, sl: 12, seed: 11 },   //  20°, tufts cut every 1/13 tile
  { k: 9, l: 43, sk: -13, sl: 3, seed: 29 },    //  78°
  { k: -33, l: 29, sk: -9, sl: -10, seed: 47 }, // 138°
];

export function bakeTurf(size: number, anisotropy: number): MapSet {
  const fLay = lowResField(3, 3, 101);      // which way the tufts lie
  const fLay2 = lowResField(5, 3, 211);     // second lay blend
  const fClump = lowResField(13, 4, 307);   // tussock height
  const fHue = lowResField(4, 3, 419);      // colour drift between clumps
  const fThatch = lowResField(9, 3, 523);   // dead thatch showing through
  // Phase warp for the lay bands — see the comment at the sample site.
  const fWarpA = lowResField(8, 3, 811);
  const fWarpB = lowResField(19, 2, 907);

  const height = new Float32Array(size * size);
  const shade = new Float32Array(size * size);
  const dens = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;

      /* Lay selection, and it has to be nearly a *decision*.
         Two directions present at similar weight in the same texel sum into a
         right-angled lattice, and a right-angled lattice at tuft scale is
         precisely the "woven fabric" read we are trying to kill — it survives
         mipping, it survives distance, and no amount of contrast reduction
         disguises it because the eye locks onto the corners, not the tone.
         Raising the weights to a power does *not* help a genuine 50/50 tie, so
         what matters is the width of the smoothstep: at ±0.16 roughly a third
         of the tile was an overlap zone. At ±0.05 it is under a tenth, and the
         power then cleans up the near-ties inside even that. */
      const layA = sampleLR(fLay, u, v);
      const layB = sampleLR(fLay2, u, v);
      let w0 = smoothstep(-0.05, 0.05, layA);
      let w1 = 1 - w0;
      let w2 = 0.9 * smoothstep(0.30, 0.40, layB);
      w0 = w0 ** 6; w1 = w1 ** 6; w2 = w2 ** 6;
      const inv = 1 / (w0 + w1 + w2 + 1e-5);
      const ws = [w0 * inv, w1 * inv, w2 * inv];

      /* Phase warp.
         `k·u + l·v` alone puts every band at a perfectly even spacing, and at
         the grazing angle a ground-level camera looks along, evenly spaced
         bands compress into what reads unmistakably as sand ripples — a clean
         periodic wave, which no patch of grass has ever been. Displacing the
         band coordinate by ~0.85 of a band from two smooth tileable fields
         makes the spacing wander: tufts crowd together in places and open up in
         others, which is what turf actually does. The warp fields are tileable
         at integer periods, so the wrap is still exact. */
      const warp = sampleLR(fWarpA, u, v) * 0.55 + sampleLR(fWarpB, u, v) * 0.30;

      let h = 0, sh = 0, wsum = 1e-5;
      for (let li = 0; li < 3; li++) {
        const m = ws[li];
        if (m < 0.02) continue;
        const L = LAY[li];
        const s = L.k * u + L.l * v + warp;
        const id = Math.floor(s);
        const band = s - id;
        /* The cross-cut needs its own warp, and it did not have one.
           Warping only the band coordinate fixes the spacing along one axis and
           leaves the cuts that end each tuft on a perfectly even 1/13-tile
           pitch, so the pattern still resolves into a regular 23 x 77 mm
           lattice of pale dashes — hessian sacking, which is exactly the
           "woven fabric" read this bake is supposed to have eliminated. The
           comment forty lines up claims both axes were handled; only one was.
           A second, decorrelated warp (different fields, opposite signs, so it
           is not just a rotated copy of the first) makes the cuts wander by
           most of a segment and the lattice stops being findable. */
        const segWarp = sampleLR(fWarpB, u, v) * 0.85 - sampleLR(fWarpA, u, v) * 0.42;
        const segF = L.sk * u + L.sl * v + segWarp;
        const seg = Math.floor(segF);
        /* Taper each tuft to nothing at both ends of its segment.
           `seg` used to be a hash key only, so a tuft's brightness changed
           *discontinuously* at the segment boundary — a hard edge running
           exactly perpendicular to the lay band. Bands in one direction plus
           hard edges at right angles to them is a labyrinth, and a labyrinth is
           the single most legible "this is a texture" tell a pitch can have.
           A spindle profile ends every dash softly and the right angles vanish. */
        const segT = segF - seg;
        const taper = Math.pow(Math.sin(Math.PI * segT), 0.55);
        const r1 = hash2(id, seg, L.seed);
        const r2 = hash2(id, seg, L.seed + 7919);
        // sin(pi*band) is a clean tuft cross-section. The exponent varies the
        // width but is capped well below the old 3.3 — every extra unit of
        // exponent pushes more energy into harmonics that must stay under
        // Nyquist (BAND * 4 = 176 << size/2).
        const prof = Math.pow(Math.sin(Math.PI * band), 0.9 + r1 * 1.5);
        // Amplitude varies hard band to band, so some tufts all but disappear
        // and the pattern never resolves into a single continuous grating.
        const bh = prof * taper * (0.30 + 1.30 * r2 * r2);
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

  /* -------- albedo: tuft-to-tuft colour, tussock drift, dead thatch ------ */
  const deep = [24, 46, 26], lush = [64, 106, 48], thatch = [88, 78, 44], soil = [58, 47, 33];
  const meanA = [0, 0, 0];
  const albedo = bake((x, y, u, v, out, i) => {
    const j = y * size + x;
    const h = height[j];
    const hue = sampleLR(fHue, u, v);
    // Compressed on purpose. At 23 mm a full deep→lush swing across every band
    // is corduroy, not turf: real mown grass has a *subtle* directional grain
    // and gets its contrast from clump-scale colour drift instead.
    const t = clamp(0.34 + shade[j] * 0.62 + 0.20 * hue, 0, 1);
    let r = mix(deep[0], lush[0], t);
    let g = mix(deep[1], lush[1], t);
    let b = mix(deep[2], lush[2], t);

    // thatch and bare soil in the gaps between tufts
    const gap = 1 - smoothstep(0.04, 0.34, h);
    const th = clamp(0.30 + 0.85 * (sampleLR(fThatch, u, v) * 0.5 + 0.5), 0, 1);
    r = mix(r, thatch[0], gap * th * 0.42);
    g = mix(g, thatch[1], gap * th * 0.42);
    b = mix(b, thatch[2], gap * th * 0.42);
    const bare = (1 - smoothstep(0.0, 0.10, h)) * smoothstep(0.55, 0.95, th);
    r = mix(r, soil[0], bare * 0.7);
    g = mix(g, soil[1], bare * 0.7);
    b = mix(b, soil[2], bare * 0.7);

    // Per-texel grain. Deliberately mild: white noise at texel frequency has no
    // mip below level 0, so anything strong here becomes crawling fizz the
    // moment a pixel covers more than one texel.
    const grain = 0.955 + 0.09 * hash2(x, y, 3);
    r *= grain; g *= grain; b *= grain;
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
    meanA[0] += srgbToLinear(clamp(r, 0, 255) / 255);
    meanA[1] += srgbToLinear(clamp(g, 0, 255) / 255);
    meanA[2] += srgbToLinear(clamp(b, 0, 255) / 255);
  }, { size, colorSpace: THREE.SRGBColorSpace, anisotropy, name: 'turf.albedo' });

  /* -------- data: cavity AO, roughness, translucency --------------------- */
  const meanD = [0, 0, 0];
  const data = bake((x, y, _u, _v, out, i) => {
    const j = y * size + x;
    const h = height[j];
    const ao = 0.32 + 0.68 * smoothstep(0.0, 0.55, h);
    // tuft faces are waxy, the litter underneath is not
    const rough = 0.94 - 0.24 * smoothstep(0.15, 0.85, h);
    const trans = clamp(h * 0.9 + 0.25 * dens[j], 0, 1);
    out[i] = ao * 255; out[i + 1] = rough * 255; out[i + 2] = trans * 255; out[i + 3] = 255;
    meanD[0] += ao; meanD[1] += rough; meanD[2] += trans;
  }, { size, colorSpace: THREE.NoColorSpace, anisotropy, name: 'turf.data' });

  // The Sobel gradient of the height field scales as BAND/size, so the normal
  // strength has to scale as size/BAND to keep the relief tier-independent.
  // 0.34 is about 20° of tilt at a band edge — enough for the grain to catch a
  // low sun, well short of the ribbed-plastic look that a full-strength normal
  // map gives a surface whose real geometry is a flat plane.
  const normal = heightToNormal(height, size, size, 0.34 * (size / 512), { anisotropy });
  normal.name = 'turf.normal';

  const n = size * size;
  return {
    albedo, normal, data,
    meanAlbedo: new THREE.Vector3(meanA[0] / n, meanA[1] / n, meanA[2] / n),
    meanData: new THREE.Vector3(meanD[0] / n, meanD[1] / n, meanD[2] / n),
  };
}

/* -------------------------------------------------------------- the apron */

/** Rubber-crumb / cinder apron: coarse granules, a little grit, matte. */
export function bakeApron(size: number, anisotropy: number): MapSet {
  const fPatch = lowResField(4, 3, 613);
  const fWear = lowResField(6, 3, 719);

  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Stacked hash cells at three granule sizes. The finest is capped at 96
      // cells so it stays ≥ 5 texels across at the smallest bake — the old
      // per-texel white-noise term underneath produced a normal map with no
      // representable mip and made the whole apron ring sparkle.
      let h = 0;
      for (let o = 0; o < 3; o++) {
        const s = 24 << o;
        const cx = Math.floor((x / size) * s), cy = Math.floor((y / size) * s);
        h += (0.55 / (o + 1)) * hash2(cx, cy, 91 + o * 17);
      }
      height[y * size + x] = h * 0.6;
    }
  }

  const base = [96, 51, 40], dark = [40, 24, 20], grit = [122, 114, 104];
  const meanA = [0, 0, 0];
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
    r *= f; g *= f; b *= f;
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
    meanA[0] += srgbToLinear(clamp(r, 0, 255) / 255);
    meanA[1] += srgbToLinear(clamp(g, 0, 255) / 255);
    meanA[2] += srgbToLinear(clamp(b, 0, 255) / 255);
  }, { size, colorSpace: THREE.SRGBColorSpace, anisotropy, name: 'apron.albedo' });

  const meanD = [0, 0, 0];
  const data = bake((x, y, u, v, out, i) => {
    const h = height[y * size + x];
    const wear = clamp(sampleLR(fWear, u, v) * 0.6 + 0.5, 0, 1);
    const ao = 0.42 + 0.58 * smoothstep(0.05, 0.6, h);
    const rough = 0.98 - 0.20 * wear;
    out[i] = ao * 255;
    out[i + 1] = rough * 255;
    out[i + 2] = 0;
    out[i + 3] = 255;
    meanD[0] += ao; meanD[1] += rough;
  }, { size, colorSpace: THREE.NoColorSpace, anisotropy, name: 'apron.data' });

  const normal = heightToNormal(height, size, size, 1.6, { anisotropy });
  normal.name = 'apron.normal';
  const n = size * size;
  return {
    albedo, normal, data,
    meanAlbedo: new THREE.Vector3(meanA[0] / n, meanA[1] / n, meanA[2] / n),
    meanData: new THREE.Vector3(meanD[0] / n, meanD[1] / n, 0),
  };
}

/** Repeat-scaled clone; DataTexture.clone() shares the pixel buffer. */
export function tiled(tex: THREE.Texture, repeat: number): THREE.Texture {
  const t = tex.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.needsUpdate = true;
  return t;
}
