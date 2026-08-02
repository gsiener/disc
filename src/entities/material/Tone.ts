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
  return {
    albedo: col(base.r),
    tanned: col(tan.r),
    flush: col(flush.r),
    lip: col(lip.r),
    subsurface: col(subsurfaceTint(base.sss)),
  };
}

/**
 * The single most damaging number in this file, so it gets its own function.
 *
 * `sss` as it comes out of `reflectance` is a RATIO of transmitted to incident
 * light, and in a melanised dermis that ratio is wildly red-dominant: at the deep
 * end of the roster it is (0.32, 0.10, 0.02), i.e. sixteen to one red over blue.
 * Normalising it to unit luminance — which the first pass did, and stopped —
 * hands the shader a colour of (2.24, 0.72, 0.17).
 *
 * That colour is then multiplied onto light that has ALREADY been multiplied by
 * the diffuse albedo, and the diffuse albedo of skin is itself the multiple-
 * scattering result. Applying the ratio twice is what turned every shadow side,
 * every terminator and every backlit rim on the roster into dark saturated
 * red-brown — the "maroon arms and legs" the art direction explicitly forbids
 * (skin is H 20–35°, S 20–35%). The physics was right; the composition was
 * double-counted.
 *
 * So: keep the HUE, which is real and is why a terminator on skin goes orange,
 * and bound the CHROMA, because this quantity is a rotation applied on top of an
 * albedo and not a second albedo. Unit luminance first (so it never changes
 * exposure), then compress toward white until the largest channel sits at `CAP`.
 * Every tone on the roster therefore lands at the same tint STRENGTH and differs
 * only in direction, which is also what makes the fourteen faces relight
 * consistently instead of the dark ones glowing hardest.
 */
const SSS_CAP = 1.34;

function subsurfaceTint(sss: readonly number[]): number[] {
  const lum = 0.2126 * sss[0] + 0.7152 * sss[1] + 0.0722 * sss[2];
  const k = lum > 1e-5 ? 1 / lum : 1;
  const n = sss.map((v) => v * k);
  const peak = Math.max(n[0], n[1], n[2]);
  // s = 1 leaves it untouched, s = 0 is white. Solved so max(mix(1, n, s)) = CAP.
  const s = peak > SSS_CAP ? (SSS_CAP - 1) / (peak - 1) : 1;
  return n.map((v) => 1 + (v - 1) * s);
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
  // Measured out of the model (see the anchor sweep in the header): these ranges
  // put the roster's albedo hue between 12° and 23° and its saturation between
  // 27 % and 48 %, which is the band real skin occupies on a colour chart. The
  // first pass ran pheomelanin twice as high and landed the pale end at 9°,
  // i.e. salmon — the same complementary-pink failure the pitch had.
  return {
    melanin: m,
    pheomelanin: 0.035 + pale * (0.05 + rand.next() * 0.26),
    blood: 0.013 + rand.next() * 0.014,
    carotene: 0.030 + rand.next() * 0.020 + (m > 0.03 && m < 0.20 ? 0.014 : 0),
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
 * Hair is the same two pigments, but a fibre is not a slab and the diffusion
 * solution used for skin does not transfer to it: run at a 60 µm thickness it
 * returns ~0.48 reflectance for black hair, which is the colour of a swim cap
 * and is exactly what the first pass rendered.
 *
 * What actually happens is that light entering a hair MASS bounces between
 * fibres many times, so the path length is millimetres of fibre, not microns,
 * and the survival probability per bounce is what sets the colour. That is a
 * classic similarity problem: for a semi-infinite medium of single-scatter
 * albedo `a` the diffuse reflectance is (1 − √(1−a)) / (1 + √(1−a)). Add the
 * ~1.6 % achromatic Fresnel term off the cuticle — the reason black hair is
 * never actually black — and the family lands where a colour chart puts real
 * hair: black at 0.03 linear, mid brown at 0.18, blond at 0.40.
 *
 * Absorption cross-sections are the standard hair pair (Marschner / d'Eon):
 * eumelanin (0.419, 0.697, 1.370) and pheomelanin (0.187, 0.400, 1.050) per mm,
 * with concentrations of order 0.1 (platinum) to 8 (black).
 */
const A_EU = [0.419, 0.697, 1.370] as const;
const A_PH = [0.187, 0.400, 1.050] as const;
const CUTICLE = 0.016;

export function hairColour(eu: number, pheo: number, greyFrac = 0): HairColour {
  const px = (mm: number) => {
    const out: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = Math.exp(-(eu * A_EU[i] + pheo * A_PH[i]) * mm);
      const s = Math.sqrt(Math.max(0, 1 - a));
      out.push(CUTICLE + (1 - CUTICLE) * (1 - s) / (1 + s));
    }
    return out;
  };
  // A full bounce path through the mass, a shorter one for sun-bleached ends,
  // and a single traverse for the transmitted lobe — which is why the TRT
  // highlight is always warmer and lighter than the hair it sits on.
  const root = px(1.0);
  const tip = px(0.78);
  const sheen = px(0.30);
  return {
    root: col(root),
    tip: col(tip),
    sheen: col(sheen),
    // Light hair is translucent, so neighbouring strands differ far more than
    // in dark hair, where every strand is equally black.
    scatter: 0.14 + 0.34 * Math.exp(-eu * 0.55),
    grey: greyFrac,
  };
}

/** Hair pigment correlated with skin melanin, the way real populations are. */
export function randomHair(rand: RandLike, skin: SkinBio): HairColour {
  const dark = Math.min(1, skin.melanin / 0.14);
  const r = rand.next();
  let eu: number;
  let pheo: number;
  if (dark > 0.7) {
    eu = 4.5 + rand.next() * 3.5; pheo = 0.15 + rand.next() * 0.35;      // black
  } else if (r < 0.09) {
    eu = 0.14 + rand.next() * 0.18; pheo = 0.45 + rand.next() * 0.55;    // blond
  } else if (r < 0.16) {
    eu = 0.14 + rand.next() * 0.22; pheo = 4.5 + rand.next() * 2.5;      // ginger
  } else if (r < 0.30) {
    eu = 0.55 + rand.next() * 0.60; pheo = 0.5 + rand.next() * 0.6;      // light brown
  } else if (r < 0.62) {
    eu = 1.1 + rand.next() * 1.3; pheo = 0.4 + rand.next() * 0.5;        // brown
  } else {
    eu = 2.4 + rand.next() * 3.4 * (0.55 + dark); pheo = 0.2 + rand.next() * 0.4;
  }
  return hairColour(eu, pheo, rand.next() < 0.10 ? rand.next() * 0.30 : 0);
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
 *
 * ============================================================================
 *  THE LEGIBILITY CONTRACT — why the two lead kits are the values they are
 * ============================================================================
 *
 * At the tele framing an athlete is 30–50 px tall. Nothing on a body at that
 * size survives except its AVERAGE VALUE: the jersey, shorts, socks, shoes and
 * bare arms resolve into one vertical smear, and the viewer reads teams off
 * that smear while looking somewhere else on the pitch. So the pair has to be
 * designed as two BLOCK VALUES that straddle the turf, not as two hues.
 *
 * The kit this replaced was designed as two hues and measured accordingly. Its
 * jersey albedos were a full 7.3:1 apart on paper — and the rendered blocks came
 * out at 1.27:1, because:
 *
 *   the render is compressive       turf albedo 0.158 lands at 0.144 rendered;
 *                                   white albedo 0.886 lands at ~0.38. The top
 *                                   of the range loses more than half its
 *                                   distance from the turf on the way to screen.
 *   the away kit fought itself      a white shirt (relLum 0.886) over near-black
 *                                   shorts (0.021) averages to mid grey — which
 *                                   is the turf's own value. A kit whose halves
 *                                   straddle the background reads as background.
 *   white is not a colour outdoors  #f2f2ee under a warm key with green bounce
 *                                   off the turf renders MINT. The critic named
 *                                   it as such. A near-neutral kit takes the
 *                                   colour of whatever it is standing on, which
 *                                   is the one thing it must not resemble.
 *
 * So: one team is committed DARK and one committed LIGHT, every garment on the
 * body pulling the same way, and both far enough off the green axis that the
 * turf's own bounce cannot drag either of them home.
 *
 *   home  deep royal navy      block lands ~2× BELOW turf luma
 *   away  marigold gold        block lands ~1.5× ABOVE turf luma
 *
 * DEUTERANOPIA (~6 % of men) is not an afterthought here, it is the reason the
 * axis is blue↔gold rather than, say, red↔green or the blue↔mint we had.
 * Deuteranopia collapses the red-green opponent channel and leaves the
 * blue-yellow one and luminance intact, so a navy/gold pair loses *nothing*: it
 * simulates to indigo #2d2d7e against chartreuse #c5c518, ΔE 137, while the turf
 * simulates to a dull khaki #6e6e3a that sits between them in value and below
 * both in chroma. Every separation this pair relies on is one a deuteranope can
 * see. Measured, not assumed — see the probe numbers in the round-5 notes.
 *
 * The accents are deliberately the OTHER team's exclusion zone: the navy kit
 * carries sky-blue piping (never gold), the gold kit carries bitumen-dark trim
 * (never blue). No pixel on one team's body can be mistaken for the other's.
 */
export const COLOURWAYS: readonly Colourway[] = [
  // The two the art direction names, first, because they are the two kits the
  // frame is allowed to saturate. Everything else on the pitch — turf, crowd,
  // boards, concrete — sits under 50 % saturation so these read.
  {
    // Deep royal navy, top to toe. Yoke and shorts go DARKER than the shirt, not
    // lighter: every garment has to pull the block down or the block averages
    // back into the turf. The one light element is 2 mm of sky piping, which is
    // sub-pixel at broadcast range and only exists for the closeup.
    id: 'home', name: 'Riverside Current', code: 'RVR',
    primary: 0x10265e, secondary: 0x07112b, accent: 0x3d7ad2,
    numberFill: 0xeef4fc, numberOutline: 0x07112b, pattern: 3,
    shorts: 0x0b1739, shortsTrim: 0x3d7ad2, sock: 0x10265e, sockBand: 0x3d7ad2,
    shoe: 0x0d1117, shoeAccent: 0x3d7ad2, mark: 2,
  },
  {
    // Marigold, top to toe. The shorts are a half-stop deeper than the shirt —
    // enough to read as a designed kit at 3 m, not enough to break the block at
    // 40 m. Numbers are ink-on-gold, which is both the highest-contrast pairing
    // available on this shirt and what a real gold kit actually does.
    id: 'away', name: 'Cutbank Union', code: 'CUT',
    primary: 0xf0b83c, secondary: 0xc9821a, accent: 0x2b2116,
    numberFill: 0x241a0e, numberOutline: 0xfdf4e0, pattern: 1,
    shorts: 0xf6efdd, shortsTrim: 0xc9821a, sock: 0xf6efdd, sockBand: 0xf0b83c,
    shoe: 0xf4efe2, shoeAccent: 0xc9821a, mark: 0,
  },

  /* ------------------------------------------------------------------------
   * TOUCHLINE COLOURWAYS
   *
   * Ultimate is played off a LINE, not a bench: the whole squad stands the
   * touchline and the seven on come out of it. `world/stadium/Sideline.ts`
   * models that correctly — and then dresses those twelve standing bodies in
   * the *match* kit, so a broadcast frame contains two rows of team-coloured
   * athletes who are not in play, immediately behind seven who are. A critic
   * reading the frame cold called it "the action played out on top of a bench
   * crowd wearing identical kit", and they are right: the confusion is not that
   * the sideline exists, it is that nothing distinguishes an on-pitch body from
   * a waiting one.
   *
   * The real-world fix is the one every squad sport uses — the players not on
   * wear a training top over the kit — and it is also the legibility fix,
   * because it drops the touchline out of the saturation budget entirely. These
   * two colourways are that top: unmistakably each team's colour, but at under
   * half the chroma and pulled toward the turf's own value band so they sit
   * BEHIND the match kits in the frame's hierarchy rather than beside them.
   *
   * The geometry is not mine to edit. `Sideline.ts` carries its own hardcoded
   * linear-RGB `kits[]` array (around line 148) and does not import this module;
   * its owner should swap those entries for these, which in linear RGB are:
   *
   *   home-bench  jersey (0.0467, 0.0685, 0.1248)  shorts (0.0232, 0.0319, 0.0561)
   *               socks  (0.0369, 0.0513, 0.1022)  shoes  (0.0075, 0.0091, 0.0123)
   *   away-bench  jersey (0.2122, 0.1500, 0.0685)  shorts (0.0704, 0.0513, 0.0296)
   *               socks  (0.1651, 0.1170, 0.0497)  shoes  (0.0103, 0.0091, 0.0075)
   *
   * Until that lands the sideline still wears match kit and the confusion is
   * still there; the colourways below are the drop-in, not the cure.
   * ------------------------------------------------------------------------ */
  {
    // Riverside training top: the navy taken to 38 % saturation and mid value.
    // Reads "that team" and not "that team, playing".
    id: 'home-bench', name: 'Riverside Current — training', code: 'RVR',
    primary: 0x3d4a63, secondary: 0x2a3243, accent: 0x7d8aa0,
    numberFill: 0xc9d1de, numberOutline: 0x2a3243, pattern: 0,
    shorts: 0x2a3243, shortsTrim: 0x7d8aa0, sock: 0x36405a, sockBand: 0x2a3243,
    shoe: 0x15181d, shoeAccent: 0x7d8aa0, mark: 2,
  },
  {
    // Cutbank training top: the marigold taken to 42 % saturation and mid value,
    // which lands it as an ochre-taupe — team-legible, and no longer competing
    // with the gold kit for the eye.
    id: 'away-bench', name: 'Cutbank Union — training', code: 'CUT',
    primary: 0x7f6c4a, secondary: 0x59492f, accent: 0xb8a882,
    numberFill: 0xe0d5bd, numberOutline: 0x3a3122, pattern: 0,
    shorts: 0x4b4030, shortsTrim: 0xb8a882, sock: 0x71603f, sockBand: 0x3a3122,
    shoe: 0x1a1815, shoeAccent: 0xb8a882, mark: 0,
  },

  /* ------------------------------------------------------------------------
   * ALTERNATES. Not used by default. PAIRING RULE: any two of these put on the
   * pitch together must straddle the turf in value the way home/away do — one
   * block clearly below it, one clearly above — and must not share the
   * blue-yellow axis position. `sun` and `away` are the same gold and must never
   * meet; `storm` and `home` are the same navy and must never meet.
   * ------------------------------------------------------------------------ */
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
