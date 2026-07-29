import * as THREE from 'three';

/**
 * ============================================================================
 *  BIOPHYSICAL COLOUR — skin, hair and iris
 * ============================================================================
 *
 * Skin colour is not a slider between two browns. It is the output of a
 * two-layer absorbing/scattering medium, and the *hue* of a face is decided by
 * which chromophore dominates:
 *
 *   melanin       absorbs monotonically harder toward the blue end, so it darkens
 *                 and simultaneously pushes the residual toward orange-brown.
 *   haemoglobin   has a double absorption peak in the green, so blood shows up as
 *                 red *without* changing the overall level much. This is why an
 *                 ear against a low sun reads pink at every skin tone.
 *   carotene      sits in the stratum corneum and absorbs blue, which is the
 *                 yellow undertone that separates olive skin from ruddy skin.
 *
 * Modelling those three lets the roster span a real gamut — pale pink through
 * yellow-olive to deep brown — with the light and the deep end differing in hue
 * and saturation, not just in value. A lerp cannot do that: it moves in a
 * straight line through colour space and every face on the way is the same
 * face at a different exposure.
 *
 * Absorption coefficients: Jacques' skin optics summary (baseline dermis,
 * eumelanin, pheomelanin power laws) and the Prahl haemoglobin extinction
 * tables, evaluated at 610 / 545 / 465 nm — the representative wavelengths for
 * linear sRGB primaries. Reduced scattering and the internal-reflection
 * parameter are tuned so the resulting reflectances land where a colour chart
 * puts real skin; the *shape* of the family is the physics, the level is art.
 */

const LAMBDA = [610, 545, 465] as const;
/** cm^-1 */
const muaBaseline = (l: number) => 7.84e8 * Math.pow(l, -3.255);
const muaEumelanin = (l: number) => 6.6e11 * Math.pow(l, -3.33);
const muaPheomelanin = (l: number) => 2.9e14 * Math.pow(l, -4.75);
/** Carotene absorbs blue and leaves red alone — the yellow undertone. */
const CAROTENE = [0.06, 0.42, 1.0] as const;
/** Molar extinction, cm^-1 / (mol/L), at the three sample wavelengths. */
const EPS_HBO2 = [3200, 53236, 78000] as const;
const EPS_HB = [16156, 53412, 96000] as const;
/** 150 g/L of haemoglobin at 64 500 g/mol. */
const C_HB = 150 / 64500;
/** Reduced scattering of skin, cm^-1. */
const musp = (l: number) => 68 * Math.pow(l / 500, -1.25);
/** Internal reflection parameter for the diffusion boundary, n ≈ 1.4. */
const A_INT = 2.6;

const muaBlood = (i: number, oxy: number) =>
  2.303 * (oxy * EPS_HBO2[i] + (1 - oxy) * EPS_HB[i]) * C_HB;

/** Diffuse reflectance of a semi-infinite scattering slab (diffusion approx). */
function diffuseReflectance(mua: number, ms: number): number {
  const ap = ms / (ms + mua);
  const s = Math.sqrt(3 * (1 - ap));
  return (ap / 2) * (1 + Math.exp((-4 / 3) * A_INT * s)) * Math.exp(-s);
}

export interface SkinBio {
  /** Melanosome volume fraction in the epidermis. 0.008 (very pale) – 0.43. */
  melanin: number;
  /** Pheomelanin fraction of total melanin. High = red/gold, low = neutral. */
  pheomelanin: number;
  /** Blood volume fraction in the dermis. 0.006 – 0.09. */
  blood: number;
  /** Carotene loading of the stratum corneum. */
  carotene: number;
  /** Haemoglobin oxygenation. Arterial 0.95, venous 0.45. */
  oxygenation: number;
  /** Epidermal thickness, cm. Thin on the eyelid, thick on the palm. */
  epidermis: number;
}

export interface SkinTones {
  /** Linear diffuse albedo. */
  albedo: THREE.Color;
  /** Sun-exposed variant — the same skin with more melanin. Drives tan lines. */
  tanned: THREE.Color;
  /** Perfused variant — ears, nose, cheeks, knuckles, knees. */
  flush: THREE.Color;
  /** Lip vermilion: no stratum corneum, four times the blood. */
  lip: THREE.Color;
  /** What light that went through the skin and came back out looks like. */
  subsurface: THREE.Color;
}

/** Total reflectance and single-pass transmitted colour for one parameter set. */
function reflectance(b: SkinBio): { r: number[]; sss: number[] } {
  const r: number[] = [];
  const sss: number[] = [];
  for (let i = 0; i < 3; i++) {
    const l = LAMBDA[i];
    const ms = musp(l);
    const mel = (1 - b.pheomelanin) * muaEumelanin(l) + b.pheomelanin * muaPheomelanin(l);
    const muaE = b.melanin * mel + (1 - b.melanin) * muaBaseline(l) + b.carotene * 260 * CAROTENE[i];
    // Down through the epidermis and back up again — the 2.4 is the diffuse
    // path-length stretch over the straight-line thickness.
    const t2 = Math.exp(-muaE * b.epidermis * 2.4);
    const muaD = b.blood * muaBlood(i, b.oxygenation) + (1 - b.blood) * muaBaseline(l);
    const rD = diffuseReflectance(muaD, ms);
    // The epidermis scatters as well as absorbs, so part of the light never
    // reaches the dermis at all. Without this term the deep end of the roster
    // collapses to near-black, which is a modelling error, not a skin tone.
    const rE = diffuseReflectance(muaE, ms * 1.35);
    r.push(rE * (1 - t2) + t2 * rD);
    sss.push(Math.sqrt(t2) * rD);
  }
  return { r, sss };
}

const col = (v: number[]) => new THREE.Color(v[0], v[1], v[2]);

export function skinTones(bio: SkinBio): SkinTones {
  const base = reflectance(bio);
  const tan = reflectance({ ...bio, melanin: Math.min(0.46, bio.melanin * 1.32 + 0.030) });
  const flush = reflectance({ ...bio, blood: Math.min(0.16, bio.blood * 2.4), oxygenation: 0.62 });
  const lip = reflectance({
    ...bio, blood: Math.min(0.22, bio.blood * 4.0), oxygenation: 0.55,
    epidermis: bio.epidermis * 0.42, melanin: bio.melanin * 0.72,
  });
  const sss = base.sss;
  // Normalise the subsurface tint to unit luminance: it is a *hue*, applied on
  // top of the albedo, not a second albedo. Left un-normalised it doubles the
  // brightness of every backlit edge.
  const lum = 0.2126 * sss[0] + 0.7152 * sss[1] + 0.0722 * sss[2];
  const k = lum > 1e-5 ? 1 / lum : 1;
  return {
    albedo: col(base.r),
    tanned: col(tan.r),
    flush: col(flush.r),
    lip: col(lip.r),
    subsurface: col(sss.map((v) => v * k)),
  };
}

interface RandLike { next(): number; range(lo: number, hi: number): number; gauss(): number; }

/**
 * A roster's worth of skin. Melanin is drawn from a broad, deliberately
 * multi-modal distribution rather than a Gaussian: a normal distribution over
 * melanin gives fourteen people who are all the same medium brown, which is
 * exactly the failure mode a two-colour lerp has.
 */
export function randomSkin(rand: RandLike): SkinBio {
  // Seven anchors across the Fitzpatrick range, each with its own spread.
  const anchors = [0.011, 0.021, 0.041, 0.078, 0.155, 0.275, 0.395];
  const i = Math.min(anchors.length - 1, Math.floor(rand.next() * anchors.length));
  const m = Math.max(0.008, anchors[i] * (0.80 + rand.next() * 0.42));
  // Pheomelanin runs high only at the pale end (the red-haired, freckled end of
  // the range) and is essentially absent at the deep end.
  const pale = Math.max(0, 1 - m / 0.09);
  return {
    melanin: m,
    pheomelanin: 0.04 + pale * (0.10 + rand.next() * 0.52),
    blood: 0.016 + rand.next() * 0.016,
    carotene: 0.010 + rand.next() * 0.014 + (m > 0.05 && m < 0.16 ? 0.008 : 0),
    oxygenation: 0.72 + rand.next() * 0.10,
    epidermis: 0.0068 + rand.next() * 0.0016,
  };
}

/* -------------------------------------------------------------------- hair */

export interface HairColour {
  /** Linear albedo at the root. */
  root: THREE.Color;
  /** Linear albedo at the tip — always lighter and warmer; sun bleaches ends. */
  tip: THREE.Color;
  /** Colour of the secondary (transmitted) specular lobe. */
  sheen: THREE.Color;
  /** 0 = uniform, 1 = strong strand-to-strand value scatter. */
  scatter: number;
  /** Fraction of strands that are grey. */
  grey: number;
}

/**
 * Hair is the same two pigments in a different ratio and at a much higher
 * concentration than skin, so the same absorption laws apply — just over a
 * single 60 µm fibre rather than a layered slab. Black hair is eumelanin at
 * ~4 %, blond is eumelanin at ~0.06 %, red is pheomelanin-dominant.
 */
export function hairColour(eu: number, pheo: number, greyFrac = 0): HairColour {
  const px = (thick: number) => {
    const out: number[] = [];
    for (let i = 0; i < 3; i++) {
      const l = LAMBDA[i];
      const mua = eu * muaEumelanin(l) * 0.10 + pheo * muaPheomelanin(l) * 0.10;
      const ms = 40 * Math.pow(l / 500, -0.9);
      // Reflectance of the fibre bundle: same diffusion solution, thin slab.
      const t = Math.exp(-mua * thick);
      out.push(diffuseReflectance(mua, ms) * (0.35 + 0.65 * t));
    }
    return out;
  };
  const root = px(0.010);
  const tip = px(0.0072);
  const lum = 0.2126 * tip[0] + 0.7152 * tip[1] + 0.0722 * tip[2];
  const k = lum > 1e-5 ? 0.55 / Math.max(0.06, lum) : 1;
  return {
    root: col(root),
    tip: col(tip.map((v, i) => v * (1 + 0.30 * (i === 0 ? 1 : i === 1 ? 0.6 : 0.2)))),
    sheen: col(tip.map((v) => Math.min(1, v * k * 0.9 + 0.05))),
    scatter: 0.22 + 0.30 * Math.min(1, 1 / (1 + eu * 60)),
    grey: greyFrac,
  };
}

/** Hair pigment correlated with skin melanin, the way real populations are. */
export function randomHair(rand: RandLike, skin: SkinBio): HairColour {
  const dark = Math.min(1, skin.melanin / 0.14);
  const r = rand.next();
  // A red-head or a blond needs a pale skin to be plausible; a deep skin tone
  // gets black hair essentially always.
  const eu = dark > 0.7
    ? 0.030 + rand.next() * 0.020
    : r < 0.10 ? 0.0006 + rand.next() * 0.0012          // blond
      : r < 0.20 ? 0.0022 + rand.next() * 0.0030        // light brown
        : r < 0.28 ? 0.0016 + rand.next() * 0.0018      // auburn base
          : 0.006 + rand.next() * 0.026 * (0.4 + dark); // brown → black
  const pheo = r < 0.28 && dark < 0.6 ? 0.020 + rand.next() * 0.045 : 0.004 + rand.next() * 0.010;
  return hairColour(eu, pheo, rand.next() < 0.12 ? rand.next() * 0.35 : 0);
}

/* -------------------------------------------------------------------- iris */

export interface IrisColour {
  /** Linear colour of the anterior stroma. */
  stroma: THREE.Color;
  /** Colour of the dense posterior pigment epithelium — always dark brown. */
  posterior: THREE.Color;
  /** 0 = blue (structural), 1 = brown (pigmented). */
  pigment: number;
  /** Radial fibre contrast. */
  fibre: number;
}

/**
 * Blue eyes contain no blue pigment. The stroma is a turbid, essentially
 * colourless layer over a dark epithelium, and it is *Rayleigh scattering* in
 * that stroma that returns the blue — the same reason the sky is blue over a
 * dark ocean. So iris colour is one parameter (stromal melanin) interpolating
 * between a scattering term and an absorption term, not a colour picker.
 */
export function irisColour(stromalMelanin: number): IrisColour {
  const scat: number[] = [];
  for (let i = 0; i < 3; i++) {
    const l = LAMBDA[i];
    // Rayleigh: sigma ~ lambda^-4, normalised at 545 nm.
    const rayleigh = Math.pow(545 / l, 4.0) * 0.115;
    const mel = stromalMelanin * muaEumelanin(l) * 0.055;
    const t = Math.exp(-mel);
    scat.push(rayleigh * t * t + 0.055 * t);
  }
  const pigment = Math.min(1, stromalMelanin / 0.55);
  const brown = [0.115, 0.046, 0.014].map((v) => v * (0.55 + 0.9 * pigment));
  const mixed = scat.map((v, i) => v * (1 - pigment * 0.92) + brown[i] * pigment);
  return {
    stroma: col(mixed),
    posterior: new THREE.Color(0.055, 0.024, 0.010),
    pigment,
    fibre: 0.85 - 0.42 * pigment,
  };
}

export function randomIris(rand: RandLike, skin: SkinBio): IrisColour {
  const dark = Math.min(1, skin.melanin / 0.12);
  // Light irises are essentially only found with light skin.
  const m = dark > 0.6
    ? 0.42 + rand.next() * 0.30
    : rand.next() < 0.42 ? 0.02 + rand.next() * 0.14 : 0.20 + rand.next() * 0.42;
  return irisColour(m);
}

/* ------------------------------------------------------------- colourways */

export interface Colourway {
  id: string;
  name: string;
  /** Three-letter code shown on the kit. */
  code: string;
  primary: number;
  secondary: number;
  accent: number;
  /** Fill and outline of the number and name. */
  numberFill: number;
  numberOutline: number;
  /** 0 none · 1 side panel · 2 chest band · 3 shoulder yoke · 4 hoops. */
  pattern: 0 | 1 | 2 | 3 | 4;
  shorts: number;
  shortsTrim: number;
  sock: number;
  sockBand: number;
  shoe: number;
  shoeAccent: number;
  /** 0 outline mark · 1 solid disc · 2 chevron. */
  mark: 0 | 1 | 2;
}

/**
 * A design system, not a palette. Every kit is built from primary / secondary /
 * accent with one structural pattern, and the shorts, socks and cleats are
 * derived from the same three colours — which is what makes a team read as a
 * team from 40 m instead of as seven people in similar shirts.
 */
export const COLOURWAYS: readonly Colourway[] = [
  {
    id: 'storm', name: 'Seattle Storm', code: 'SEA',
    primary: 0x16305e, secondary: 0xeef2f7, accent: 0x37c0ef,
    numberFill: 0xf6f9fc, numberOutline: 0x37c0ef, pattern: 1,
    shorts: 0x101c33, shortsTrim: 0x37c0ef, sock: 0xf2f5f9, sockBand: 0x16305e,
    shoe: 0x12161d, shoeAccent: 0x37c0ef, mark: 2,
  },
  {
    id: 'ember', name: 'Austin Ember', code: 'ATX',
    primary: 0xb2321c, secondary: 0x22160f, accent: 0xf0a52c,
    numberFill: 0xfaf0dd, numberOutline: 0x22160f, pattern: 3,
    shorts: 0x22160f, shortsTrim: 0xf0a52c, sock: 0x22160f, sockBand: 0xf0a52c,
    shoe: 0xece7de, shoeAccent: 0xb2321c, mark: 0,
  },
  {
    id: 'pine', name: 'Portland Pine', code: 'PDX',
    primary: 0x1d4b32, secondary: 0xdfe4d6, accent: 0xc8d64a,
    numberFill: 0xf3f6e9, numberOutline: 0x0f2a1c, pattern: 4,
    shorts: 0xdfe4d6, shortsTrim: 0x1d4b32, sock: 0x1d4b32, sockBand: 0xc8d64a,
    shoe: 0x1a1d19, shoeAccent: 0xc8d64a, mark: 1,
  },
  {
    id: 'slate', name: 'Chicago Slate', code: 'CHI',
    primary: 0x3a3f47, secondary: 0xd9dde2, accent: 0xe04b6a,
    numberFill: 0xf4f6f8, numberOutline: 0x22262b, pattern: 2,
    shorts: 0x22262b, shortsTrim: 0xe04b6a, sock: 0xd9dde2, sockBand: 0xe04b6a,
    shoe: 0xf0f1f3, shoeAccent: 0x3a3f47, mark: 2,
  },
  {
    id: 'sun', name: 'Phoenix Sun', code: 'PHX',
    primary: 0xf2b03a, secondary: 0x2b1d4a, accent: 0xe8663c,
    numberFill: 0x2b1d4a, numberOutline: 0xfdf3dd, pattern: 1,
    shorts: 0x2b1d4a, shortsTrim: 0xf2b03a, sock: 0x2b1d4a, sockBand: 0xf2b03a,
    shoe: 0x2b1d4a, shoeAccent: 0xf2b03a, mark: 1,
  },
  {
    id: 'tide', name: 'Boston Tide', code: 'BOS',
    primary: 0x0f1b2e, secondary: 0xb8352f, accent: 0xe6ebf1,
    numberFill: 0xe6ebf1, numberOutline: 0xb8352f, pattern: 3,
    shorts: 0x0f1b2e, shortsTrim: 0xb8352f, sock: 0xe6ebf1, sockBand: 0x0f1b2e,
    shoe: 0x141821, shoeAccent: 0xb8352f, mark: 0,
  },
];

export function colourwayById(id: string): Colourway {
  return COLOURWAYS.find((c) => c.id === id) ?? COLOURWAYS[0];
}

/** sRGB hex → linear THREE.Color, which is the only correct way to feed a shader. */
export function lin(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}
