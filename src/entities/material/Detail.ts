import * as THREE from 'three';
import { bake, heightField } from '../../util/Tex.ts';
import { hash2, perlin2, fbm2, ridged2, tileableFbm2, smoothstep, clamp, mix } from '../../util/Noise.ts';
import { texBytes } from './Glsl.ts';
import type { QualityTier } from '../../core/Ctx.ts';

/**
 * ============================================================================
 *  SHARED MICRO-DETAIL
 * ============================================================================
 *
 * Five tiling maps, baked ONCE for the whole roster. Nothing in here is
 * player-specific: a pore is a pore, a knit loop is a knit loop, and fourteen
 * athletes carrying fourteen copies of the same 4 MB pore map would be four
 * megabytes of content and fifty-six of memory.
 *
 * Everything a *player* differs by — tone, team, number, wear, sweat — is a
 * uniform or a 512×64 name strip. The per-athlete texture cost of this system is
 * therefore about 170 kB, and the fixed cost is paid once. See
 * `DetailTextures.bytes` and `PlayerMaterialLibrary.textureBytes`.
 *
 * All five tile seamlessly: they are sampled at 30–800 repeats across a garment
 * and a visible wrap seam at that frequency would read as a printed grid.
 * Tiling is achieved by wrapping the integer lattice, never by mirroring.
 */

/* ------------------------------------------------- tileable noise helpers */

/** Value noise on a lattice that wraps at `p`, built on the shared hash. */
function tileValue(x: number, y: number, p: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const w = (n: number) => ((n % p) + p) % p;
  const a = hash2(w(xi), w(yi), seed), b = hash2(w(xi + 1), w(yi), seed);
  const c = hash2(w(xi), w(yi + 1), seed), d = hash2(w(xi + 1), w(yi + 1), seed);
  return mix(mix(a, b, u), mix(c, d, u), v);
}

function tileFbm(x: number, y: number, p: number, oct: number, seed: number): number {
  let s = 0, amp = 0.5, n = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    s += amp * tileValue(x * f, y * f, p * f, seed + i * 71);
    n += amp; f *= 2; amp *= 0.5;
  }
  return s / n;
}

/** Cellular noise wrapped on a `p`-cell torus. Returns f1 and the cell hash. */
function tileWorley(x: number, y: number, p: number, seed: number): [number, number] {
  const xi = Math.floor(x), yi = Math.floor(y);
  const w = (n: number) => ((n % p) + p) % p;
  let f1 = 1e9, id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const wx = w(cx), wy = w(cy);
      const px = cx + hash2(wx, wy, seed);
      const py = cy + hash2(wx, wy, seed + 7919);
      const ex = px - x, ey = py - y;
      const d = ex * ex + ey * ey;
      if (d < f1) { f1 = d; id = hash2(wx, wy, seed + 131); }
    }
  }
  return [Math.sqrt(f1), id];
}

/* ---------------------------------------------------------------- baking */

/** Sobel a height field into RGB, leaving A free for a data channel. */
function normalWithAlpha(
  h: Float32Array, size: number, strength: number,
  alpha: (x: number, y: number, u: number, v: number) => number,
  name: string, anis: number,
): THREE.DataTexture {
  const at = (x: number, y: number) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  return bake((x, y, u, v, out, i) => {
    const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
    const l = at(x - 1, y), r = at(x + 1, y);
    const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
    const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
    const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
    let nx = -dx * strength, ny = -dy * strength;
    const inv = 1 / Math.hypot(nx, ny, 1);
    nx *= inv; ny *= inv;
    out[i] = (nx * 0.5 + 0.5) * 255;
    out[i + 1] = (ny * 0.5 + 0.5) * 255;
    out[i + 2] = inv * 255;
    out[i + 3] = clamp(alpha(x, y, u, v), 0, 1) * 255;
  }, { size, colorSpace: THREE.NoColorSpace, anisotropy: anis, name });
}

const SIZES: Record<QualityTier, { pore: number; aux: number; weave: number; grunge: number; strand: number }> = {
  low: { pore: 256, aux: 128, weave: 256, grunge: 128, strand: 128 },
  medium: { pore: 512, aux: 256, weave: 256, grunge: 256, strand: 128 },
  high: { pore: 1024, aux: 512, weave: 512, grunge: 512, strand: 256 },
  ultra: { pore: 1024, aux: 512, weave: 512, grunge: 512, strand: 256 },
};

export class DetailTextures {
  /** RGB tangent normal of skin micro-relief · A micro-roughness. */
  readonly pore: THREE.DataTexture;
  /** R mottle · G freckle field · B subdermal vein · A hair-follicle field. */
  readonly aux: THREE.DataTexture;
  /** RGB knit normal · A thread self-occlusion. */
  readonly weave: THREE.DataTexture;
  /** R scuff · G dirt · B grain · A fibre streak. */
  readonly grunge: THREE.DataTexture;
  /** R strand albedo · G tangent shift · B fine fibre · A edge dissolve. */
  readonly strand: THREE.DataTexture;
  readonly bytes: number;
  readonly ms: number;

  constructor(tier: QualityTier, anisotropy: number) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const S = SIZES[tier];
    const anis = Math.max(4, Math.min(16, anisotropy));

    /* ------------------------------------------------------------- pore */
    // Skin is not a field of round craters. Its surface is a network of
    // criss-crossing furrows (the "micro-relief lines") enclosing irregular
    // plateaux, with follicles and pores punched into the plateaux. Model the
    // network first and the pores second, or you get orange peel.
    {
      const N = S.pore;
      const P = 16; // lattice period in cells
      const h = heightField(N, (u, v) => {
        // Two decorrelated furrow directions, warped so the network is irregular.
        const wx = tileFbm(u * P, v * P, P, 3, 11) - 0.5;
        const wy = tileFbm(u * P + 3.7, v * P + 1.9, P, 3, 23) - 0.5;
        const a = u * P * 3.1 + wx * 2.2;
        const b = v * P * 3.1 + wy * 2.2;
        const f1 = Math.abs(Math.sin((a + b) * Math.PI));
        const f2 = Math.abs(Math.sin((a - b * 0.82) * Math.PI));
        const furrow = -0.55 * Math.pow(1 - Math.min(f1, f2), 3.0);
        // Pores: cellular, but only a fraction of cells actually carry one.
        const [d, id] = tileWorley(u * P * 5.0, v * P * 5.0, P * 5, 41);
        const pore = id > 0.52 ? -0.85 * smoothstep(0.30, 0.0, d) * (0.4 + 0.6 * id) : 0;
        // Fine 30 µm roughness so the specular never goes perfectly flat.
        const fine = (tileFbm(u * P * 11, v * P * 11, P * 11, 2, 67) - 0.5) * 0.20;
        return furrow + pore + fine;
      });
      this.pore = normalWithAlpha(h, N, 3.4, (_x, _y, u, v) => {
        // Micro-roughness rides the same network: the plateaux are smooth and
        // reflective, the furrow floors are matte. This is what makes a real
        // specular highlight break into islands instead of sitting as one blob.
        const P2 = 16;
        const n = tileFbm(u * P2 * 2.3, v * P2 * 2.3, P2 * 2, 3, 91);
        return 0.35 + 0.65 * n;
      }, 'player.pore', anis);
    }

    /* -------------------------------------------------------------- aux */
    {
      const N = S.aux;
      const P = 8;
      this.aux = bake((_x, _y, u, v, out, i) => {
        // Mottle: the low-frequency unevenness every real complexion has.
        const mot = tileFbm(u * P, v * P, P, 4, 5);
        // Freckle field: dense cellular, thresholded per-player in the shader.
        const [fd, fid] = tileWorley(u * P * 7, v * P * 7, P * 7, 13);
        const freck = smoothstep(0.34, 0.06, fd) * fid;
        // Subdermal venous network — ridged, sparse, blue-shifted downstream.
        const vein = Math.pow(clamp(ridged2(u * 5.5, v * 5.5, { octaves: 3, seed: 27 }), 0, 1), 5.0);
        // Follicle field for stubble and body hair.
        const [hd, hid] = tileWorley(u * P * 26, v * P * 26, P * 26, 71);
        const foll = smoothstep(0.42, 0.10, hd) * (0.35 + 0.65 * hid);
        out[i] = mot * 255;
        out[i + 1] = freck * 255;
        out[i + 2] = vein * 255;
        out[i + 3] = foll * 255;
      }, { size: N, colorSpace: THREE.NoColorSpace, anisotropy: anis, name: 'player.aux' });
    }

    /* ------------------------------------------------------------ weave */
    // A performance jersey is a weft-knit interlock: rows of interlocking loops,
    // not a plain over-under weave. The loop is what gives athletic fabric its
    // characteristic soft directional sheen, and it is the single most-magnified
    // surface in the closeup after skin.
    {
      const N = S.weave;
      const COURSE = 14; // loops across the tile, wale direction (u)
      const WALE = 11; // rows of loops down the tile (v)
      const h = heightField(N, (u, v) => {
        const cu = u * COURSE, cv = v * WALE;
        // Every other row is offset half a loop, which is the knit stagger.
        const row = Math.floor(cv);
        const off = (row & 1) ? 0.5 : 0.0;
        const lu = cu + off;
        const fu = lu - Math.floor(lu);
        const fv = cv - row;
        // The loop: two legs rising to a crown, seen as a pair of arcs.
        const leg = Math.abs(fu - 0.5) * 2.0;
        const arch = Math.sin(Math.PI * clamp(fv, 0, 1));
        const loop = Math.pow(1.0 - leg, 1.4) * arch;
        // The head of the loop passes over the row above — a second, offset arc.
        const head = Math.pow(clamp(1.0 - Math.abs(fv - 0.08) * 3.2, 0, 1), 1.5)
          * Math.pow(clamp(1.0 - leg * 0.75, 0, 1), 2.0);
        // Yarn twist: fine helical striation along the leg.
        const twist = 0.10 * Math.sin((fv * 9.0 + fu * 3.0) * Math.PI * 2.0);
        const fuzz = (tileFbm(u * 40, v * 40, 40, 2, 3) - 0.5) * 0.16;
        return loop * 0.75 + head * 0.55 + twist * loop + fuzz;
      });
      this.weave = normalWithAlpha(h, N, 2.1, (x, y, u, v) => {
        const cu = u * COURSE, cv = v * WALE;
        const row = Math.floor(cv);
        const off = (row & 1) ? 0.5 : 0.0;
        const fu = (cu + off) - Math.floor(cu + off);
        const fv = cv - row;
        const leg = Math.abs(fu - 0.5) * 2.0;
        // Occlusion lives between the loops, where the yarn crosses under.
        const gap = Math.pow(leg, 2.2) * (1.0 - Math.pow(Math.sin(Math.PI * clamp(fv, 0, 1)), 0.6));
        return 1.0 - 0.62 * clamp(gap, 0, 1) - 0.10 * hash2(x, y, 9);
      }, 'player.weave', anis);
    }

    /* ----------------------------------------------------------- grunge */
    {
      const N = S.grunge;
      const P = 8;
      this.grunge = bake((x, y, u, v, out, i) => {
        // Scuff: directional abrasion, the way a synthetic upper actually wears.
        const [sd] = tileWorley(u * P * 3.0, v * P * 9.0, P * 9, 5);
        const scuff = Math.pow(clamp(1 - sd * 1.6, 0, 1), 2.0);
        // Dirt: soft, blotchy, clings to low ground.
        const dirt = clamp(tileFbm(u * P * 1.6, v * P * 1.6, P * 2, 4, 33) * 1.4 - 0.18, 0, 1);
        // Grain: injection-moulded / leather micro-pebble.
        const [gd, gid] = tileWorley(u * P * 20, v * P * 20, P * 20, 55);
        const grain = clamp(0.35 + 0.65 * (gd * 1.6) * (0.6 + 0.4 * gid), 0, 1);
        // Fibre streak: long anisotropic strands, used by hair and by knit socks.
        const fib = clamp(0.5 + 0.5 * perlin2(u * 120 + hash2(x, 0, 1), v * 5.0, 77), 0, 1);
        out[i] = scuff * 255;
        out[i + 1] = dirt * 255;
        out[i + 2] = grain * 255;
        out[i + 3] = fib * 255;
      }, { size: N, colorSpace: THREE.NoColorSpace, anisotropy: anis, name: 'player.grunge' });
    }

    /* ----------------------------------------------------------- strand */
    // Hair is shaded as a fibre bundle, so what the shader needs is per-strand
    // *variation*, not a picture of hair: how much darker this strand is than its
    // neighbour, and how far its highlight is shifted along its length.
    {
      const N = S.strand;
      this.strand = bake((x, y, u, v, out, i) => {
        // Strands run along v, so the interesting frequency is entirely in u.
        const clump = tileValue(u * 9.0, v * 1.4, 9, 3);
        const fine = tileValue(u * 64.0, v * 3.0, 64, 17);
        const finer = tileValue(u * 190.0, v * 6.0, 190, 29);
        const albedo = clamp(0.30 * clump + 0.44 * fine + 0.26 * finer, 0, 1);
        // Tangent shift per strand: this is what makes the highlight a broken
        // band travelling along the hair rather than a painted stripe.
        const shift = clamp(0.5 + 0.7 * (fine - 0.5) + 0.35 * (clump - 0.5), 0, 1);
        const flyaway = clamp(tileValue(u * 300.0, v * 2.0, 300, 41), 0, 1);
        // Edge dissolve: erodes the shell boundary into strands instead of a rim.
        const edge = clamp(0.5 + 0.9 * (tileFbm(u * 26, v * 6, 26, 3, 51) - 0.5)
          + 0.35 * (fine - 0.5), 0, 1);
        out[i] = albedo * 255;
        out[i + 1] = shift * 255;
        out[i + 2] = flyaway * 255;
        out[i + 3] = edge * 255;
      }, { size: N, colorSpace: THREE.NoColorSpace, anisotropy: anis, name: 'player.strand' });
    }

    this.bytes = texBytes(this.pore) + texBytes(this.aux) + texBytes(this.weave)
      + texBytes(this.grunge) + texBytes(this.strand);
    this.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    // Reference the imports the bakes above do not use directly, so the module's
    // dependency on the shared noise library stays explicit rather than partial.
    void fbm2; void tileableFbm2;
  }

  dispose(): void {
    this.pore.dispose(); this.aux.dispose(); this.weave.dispose();
    this.grunge.dispose(); this.strand.dispose();
  }
}
