import * as THREE from 'three';
import { bake } from '../../util/Tex.ts';
import { hash2, clamp, smoothstep } from '../../util/Noise.ts';
import { texBytes } from './Glsl.ts';
import type { Colourway } from './Tone.ts';

/**
 * ============================================================================
 *  KIT TYPOGRAPHY — numbers, names and the team mark
 * ============================================================================
 *
 * Jersey numbers are stored as SIGNED DISTANCE FIELDS, not as pictures of
 * numbers. That matters here more than usual: the `closeup` shot puts a chest
 * number about 200 px tall in frame while the `broadcast` shot puts the same
 * number at four pixels, and a coverage bitmap can only be right at one of
 * those. A distance field thresholded against `fwidth` is crisp at both, and it
 * hands the shader three things for free that a bitmap cannot:
 *
 *   the fill            d > 0
 *   the twill outline   a band around d = 0, which is the stitched border a real
 *                       twill number carries and the reason it reads as applied
 *                       rather than printed
 *   the bevel           the gradient of d, which is the raised edge of a
 *                       heat-pressed vinyl transfer
 *
 * One atlas is baked per COLOURWAY and shared by every player on that team;
 * only the 512×64 name strip is per-player. Fourteen athletes therefore cost
 * two atlases and fourteen strips, not fourteen of everything.
 */

/**
 * Reference atlas geometry. Every tier scales all three together, because the
 * shader's SDF_RATE is CELL / (2 * SPREAD) and it is a compile-time constant —
 * scale the cell without the spread and every glyph edge changes width.
 */
const ATLAS = 512;
const CELL_DIV = 4;   // 4 x 4 grid
const SPREAD_REF = 14; // SDF range in texels at ATLAS = 512

const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

/* ------------------------------------------------------------------- sdf */

/** Exact squared Euclidean distance transform, one axis (Felzenszwalb 2004). */
function edt1d(f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, n: number): void {
  let k = 0;
  v[0] = 0; z[0] = -1e20; z[1] = 1e20;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = 1e20;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

function edt2d(mask: Float64Array, w: number, h: number): Float64Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n);
  const v = new Int32Array(n), z = new Float64Array(n + 1);
  const out = Float64Array.from(mask);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x];
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x];
  }
  return out;
}

/**
 * Coverage → signed distance in [0,1], 0.5 on the glyph boundary. Sub-texel
 * accuracy comes from the antialiased coverage itself: a boundary texel at 0.7
 * coverage is pushed 0.2 texels outward, so the field stays smooth under
 * magnification instead of stepping at texel edges.
 */
function coverageToSdf(cov: Float64Array, w: number, h: number, spread: number): Float64Array {
  const inside = new Float64Array(w * h);
  const outside = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    inside[i] = cov[i] > 0.5 ? 0 : 1e20;
    outside[i] = cov[i] > 0.5 ? 1e20 : 0;
  }
  const di = edt2d(inside, w, h);
  const dout = edt2d(outside, w, h);
  const sdf = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const sub = cov[i] - 0.5;
    const d = Math.sqrt(dout[i]) - Math.sqrt(di[i]) + sub;
    sdf[i] = clamp(0.5 + d / (2 * spread), 0, 1);
  }
  return sdf;
}

/** Draw into a canvas and read back coverage with row 0 at the BOTTOM. */
function coverage(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): Float64Array {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true })!;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#fff';
  draw(c);
  const px = c.getImageData(0, 0, w, h).data;
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w;
    for (let x = 0; x < w; x++) out[y * w + x] = px[(src + x) * 4 + 3] / 255;
  }
  return out;
}

/* ----------------------------------------------------------------- marks */

/** The team mark, drawn into a unit box. Vector, so it stays sharp at any size. */
function drawMark(c: CanvasRenderingContext2D, S: number, kind: 0 | 1 | 2): void {
  const p = S * 0.5;
  c.save();
  c.translate(p, p);
  if (kind === 0) {
    // Ring-and-disc: an ultimate disc seen at a tilt, in outline.
    c.lineWidth = S * 0.075;
    c.strokeStyle = '#fff';
    c.beginPath(); c.ellipse(0, S * 0.045, S * 0.36, S * 0.155, 0, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.ellipse(0, -S * 0.045, S * 0.36, S * 0.155, 0, 0, Math.PI * 2); c.stroke();
    c.beginPath();
    c.moveTo(-S * 0.36, -S * 0.045); c.lineTo(-S * 0.36, S * 0.045);
    c.moveTo(S * 0.36, -S * 0.045); c.lineTo(S * 0.36, S * 0.045);
    c.stroke();
  } else if (kind === 1) {
    // Solid disc with a cut rim.
    c.beginPath(); c.arc(0, 0, S * 0.36, 0, Math.PI * 2); c.fill();
    c.globalCompositeOperation = 'destination-out';
    c.beginPath(); c.arc(0, 0, S * 0.235, 0, Math.PI * 2); c.fill();
    c.globalCompositeOperation = 'source-over';
    c.beginPath(); c.arc(0, 0, S * 0.145, 0, Math.PI * 2); c.fill();
  } else {
    // Chevron stack.
    for (let k = 0; k < 2; k++) {
      const o = k * S * 0.185 - S * 0.09;
      c.beginPath();
      c.moveTo(-S * 0.30, o - S * 0.10);
      c.lineTo(0, o + S * 0.085);
      c.lineTo(S * 0.30, o - S * 0.10);
      c.lineTo(S * 0.30, o + S * 0.005);
      c.lineTo(0, o + S * 0.19);
      c.lineTo(-S * 0.30, o + S * 0.005);
      c.closePath(); c.fill();
    }
  }
  c.restore();
}

/** Centre text in a box, condensing horizontally to fit — as a real kit does. */
function fitText(
  c: CanvasRenderingContext2D, text: string,
  cx: number, cy: number, maxW: number, size: number, weight = 900, tracking = 0,
): void {
  c.font = `${weight} ${size}px ${FONT}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  let w = c.measureText(text).width + tracking * (text.length - 1);
  const sx = Math.min(1, maxW / Math.max(1, w));
  c.save();
  c.translate(cx, cy);
  c.scale(sx, 1);
  if (tracking === 0) {
    c.fillText(text, 0, 0);
  } else {
    w = c.measureText(text).width + tracking * (text.length - 1);
    let x = -w / 2;
    c.textAlign = 'left';
    for (const ch of text) {
      c.fillText(ch, x, 0);
      x += c.measureText(ch).width + tracking;
    }
  }
  c.restore();
}

/* ----------------------------------------------------------------- atlas */

export interface KitAtlas {
  texture: THREE.DataTexture;
  /** Bottom-left uv of each 128 px cell, indexed by digit. */
  digitCell: THREE.Vector2[];
  markCell: THREE.Vector2;
  bytes: number;
}

/**
 * Cell layout, rows counted from the BOTTOM of the texture (DataTexture does not
 * flip):
 *   row 3   0 1 2 3
 *   row 2   4 5 6 7
 *   row 1   8 9 mark ·
 *   row 0   team code, drawn across all four cells
 */
export function bakeKitAtlas(cw: Colourway, size = ATLAS): KitAtlas {
  const A = Math.max(128, Math.round(size / 4) * 4);
  const CELL = A / CELL_DIV;
  const SPREAD = SPREAD_REF * (A / ATLAS);
  const cov = coverage(A, A, (c) => {
    for (let d = 0; d <= 9; d++) {
      const col = d % 4, row = Math.floor(d / 4);
      const x = col * CELL, y = row * CELL;
      // Athletic numerals are condensed and set on a tall body. 0.86 horizontal
      // is the classic block-number proportion.
      c.save();
      c.beginPath(); c.rect(x, y, CELL, CELL); c.clip();
      c.translate(x + CELL * 0.5, y + CELL * 0.52);
      c.scale(0.80, 1.0);
      c.font = `900 ${Math.round(CELL * 0.86)}px ${FONT}`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(String(d), 0, 0);
      c.restore();
    }
    c.save();
    c.translate(2 * CELL, 2 * CELL);
    drawMark(c, CELL, cw.mark);
    c.restore();
    // Bottom row: the three-letter club code, tracked out across 512 px.
    c.save();
    c.beginPath(); c.rect(0, 3 * CELL, A, CELL); c.clip();
    fitText(c, cw.code, A * 0.5, 3 * CELL + CELL * 0.52, A * 0.86,
      Math.round(CELL * 0.62), 900, CELL * 0.10);
    c.restore();
  });
  const sdf = coverageToSdf(cov, A, A, SPREAD);

  const texture = bake((x, y, u, v, out, i) => {
    out[i] = sdf[y * A + x] * 255;
    // Chenille twill: the fine looped pile a stitched-on number is made of.
    const loop = 0.5 + 0.5 * Math.sin((x * 0.9 + Math.sin(y * 0.55) * 2.0) * 1.7);
    out[i + 1] = (0.35 + 0.65 * loop) * 255;
    // Vinyl surface grain — a heat-pressed transfer is not optically flat.
    out[i + 2] = (0.5 + 0.5 * (hash2(x >> 1, y >> 1, 3) - 0.5) * 0.9) * 255;
    out[i + 3] = 255;
    void u; void v;
  }, {
    size: A, colorSpace: THREE.NoColorSpace, wrap: THREE.ClampToEdgeWrapping,
    anisotropy: 8, name: `kit.${cw.id}`,
  });

  // `coverage` reads the canvas back bottom-up, so canvas row r (counted from
  // the top) becomes texture row 3 − r (counted from v = 0). Handing the shader
  // the canvas row instead was worth two wrong glyphs on every shirt in the
  // game: a squad number in the eighties printed as "4", and the club mark as a
  // digit 6. The flip belongs here, once, next to the bake that causes it.
  const digitCell: THREE.Vector2[] = [];
  for (let d = 0; d <= 9; d++) {
    const col = d % 4, row = Math.floor(d / 4);
    digitCell.push(new THREE.Vector2(col / 4, (3 - row) / 4));
  }
  return { texture, digitCell, markCell: new THREE.Vector2(2 / 4, 1 / 4), bytes: texBytes(texture) };
}

/* ------------------------------------------------------------ name strip */

const NAME_W = 512;
/** Rows in a team strip. A 7-a-side squad plus one spare. */
export const NAME_ROWS = 8;

/**
 * v window of one squad member's row, as (origin, span). The 3-texel inset on
 * each side keeps a bilinear tap from ever reaching the neighbouring row.
 */
export function NAME_ROW_V(slot: number): THREE.Vector2 {
  const s = ((slot % NAME_ROWS) + NAME_ROWS) % NAME_ROWS;
  const inset = 0.008;
  return new THREE.Vector2(s / NAME_ROWS + inset, 1 / NAME_ROWS - inset * 2);
}

/**
 * One strip per TEAM, one surname per row.
 *
 * Each row's distance field is solved on its own 512 × 48 tile and only then
 * assembled, rather than running one transform across the whole strip. A single
 * global transform lets the field of the name above reach down into this row's
 * outline band — and the outline is exactly the part of an SDF that samples
 * furthest from its glyph — so it surfaces as a ghost of somebody else's
 * surname along the top of every jersey, which is a genuinely baffling thing to
 * find in a render.
 */
export function bakeNameStrip(names: readonly string[], width = NAME_W): THREE.DataTexture {
  const W = Math.max(128, Math.round(width / 8) * 8);
  const ROW = Math.max(16, Math.round(48 * (W / NAME_W) / 4) * 4);
  const H = ROW * NAME_ROWS;
  const sdf = new Float64Array(W * H);
  for (let r = 0; r < NAME_ROWS; r++) {
    const text = (names[r] ?? names[names.length - 1] ?? '').toUpperCase();
    const cov = coverage(W, ROW, (c) => {
      if (!text) return;
      fitText(c, text, W * 0.5, ROW * 0.54, W * 0.90,
        Math.round(ROW * 0.70), 800, ROW * 0.055);
    });
    const rowSdf = coverageToSdf(cov, W, ROW, 7 * (W / NAME_W));
    sdf.set(rowSdf, r * ROW * W);
  }
  return bake((x, y, u, v, out, i) => {
    out[i] = sdf[y * W + x] * 255;
    // Chenille twill loop, and the vinyl grain of a heat-pressed transfer.
    const loop = 0.5 + 0.5 * Math.sin((x * 1.1 + Math.sin(y * 0.7) * 2.0) * 1.9);
    out[i + 1] = (0.35 + 0.65 * loop) * 255;
    out[i + 2] = (0.5 + 0.5 * (hash2(x >> 1, y >> 1, 5) - 0.5) * 0.9) * 255;
    out[i + 3] = 255;
    void u; void v; void smoothstep;
  }, {
    size: W, height: H, colorSpace: THREE.NoColorSpace,
    wrap: THREE.ClampToEdgeWrapping, anisotropy: 8, name: 'kit.names',
  });
}

/* ------------------------------------------------------------------ names */

/** A roster of surnames so the backs of fourteen jerseys are fourteen names. */
export const SURNAMES = [
  'ABARA', 'BAKKEN', 'CASTRO', 'DELACRUZ', 'ELIASSON', 'FONTAINE', 'GRACZYK',
  'HALVORSEN', 'IKEDA', 'JENSEN', 'KOWALSKI', 'LINDQVIST', 'MBEKI', 'NAKAMURA',
  'OYELARAN', 'PRZYBYLSKI', 'QUINTERO', 'RASMUSSEN', 'SOARES', 'TREMBLAY',
  'UNDERHILL', 'VANDERBERG', 'WOJCIK', 'XUEREB', 'YAMASHITA', 'ZIELINSKI',
  'ADEYEMI', 'BRENNAN', 'CHAUDHARY', 'DIALLO', 'ESPOSITO', 'FERREIRA',
  'GUSTAFSSON', 'HERNANDEZ', 'ISHIKAWA', 'JOHANSSON', 'KOWALCZYK', 'LARSEN',
] as const;

/** Squad numbers, drawn without repeats inside a team. */
export function squadNumbers(count: number, rand: { int(a: number, b: number): number }): number[] {
  const used = new Set<number>();
  const out: number[] = [];
  while (out.length < count) {
    const n = rand.int(0, 99);
    if (used.has(n)) continue;
    used.add(n); out.push(n);
  }
  return out;
}
