import * as THREE from 'three';
import { PART, GROUP } from './Types.ts';
import type { FaceParams } from './Types.ts';
import { SIDES, bi } from './Skeleton.ts';
import type { Anthro } from './Skeleton.ts';
import {
  RigMesh, V, sk1, sk2, skMix, smooth, lerp, clamp01,
} from './Build.ts';
import type { Ring, Skin, Vec3 } from './Build.ts';
import type { DetailSpec } from './Body.ts';

/**
 * The head. This is the single highest-leverage mesh in the project because the
 * `closeup` shot is framed on a receiver, and a featureless ovoid there is worth
 * more negative points than every other asset combined.
 *
 * It is one radially displaced ellipsoid. Every feature — supraorbital ridge,
 * orbital cavity, palpebral aperture and both lid margins, zygomatic arch,
 * submalar hollow, nasal root / dorsum / lobule / alae / nostril sill,
 * philtrum, cupid's bow, both vermilions, oral commissure, mentolabial sulcus,
 * masseter, gonial angle, occiput — is an additive term evaluated on the unit
 * direction, so the whole face is a pure function of direction, eleven face
 * parameters and eight seed-derived jitters.
 *
 * Displacements are quoted in units of `headR` (half the head's breadth) rather
 * than in metres, which is what keeps a 1.62 m and a 2.03 m athlete looking
 * like two people rather than one person and one scale model.
 *
 * The underside is *not* spherical: below the mandibular border the surface is
 * pulled into the neck column, which is the submandibular funnel. A head that
 * closes into a ball under the jaw reads as a lollipop from every camera below
 * eye level, and a sideline camera is always below eye level.
 */

/** Head-to-neck funnel radius, as a multiple of the neck loft's own radius. */
export const FUNNEL_R = 1.26;

const g1 = (v: number, c: number, w: number) => {
  const d = (v - c) / w;
  return Math.exp(-d * d);
};

/**
 * The mandibular border, as a function of the surface direction: the chin in
 * front, the gonion at the sides, and higher still at the nape. A level cut is
 * what makes a procedural head read as a lollipop, and the old constant put the
 * side of the jaw 60 mm inside the mandible, which is why the roster had no
 * jawline at all.
 */
function jawLine(nz: number): number {
  // `nz` is scaled hard on both sides on purpose. Near the lower pole of the
  // ellipsoid — which IS the point of the chin — nz only reaches ~0.24, so a
  // linear term put the funnel 70 % of the way in at the chin itself and pulled
  // the mental protuberance 27 mm down into the neck. That is precisely what
  // "the roster has no chin and no jawline" looked like.
  return -0.72 - 0.40 * clamp01(nz * 2.4) + 0.40 * clamp01(-nz * 1.6);
}

/* ------------------------------------------------------------- variation */

/** xorshift-flavoured integer hash. Deterministic, no `Math.random` anywhere. */
function h01(seed: number, salt: number): number {
  let x = (Math.imul(seed | 0, 0x9e3779b1) + Math.imul(salt | 0, 0x85ebca6b)) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
const bi1 = (seed: number, salt: number) => h01(seed, salt) * 2 - 1;

/**
 * Shape jitter that `FaceParams` does not carry. `FaceParams` is a shared API
 * owned by the rig, so rather than widen it these are derived from the athlete's
 * own `seed` — which means fourteen players get fourteen noses without a single
 * extra field crossing a module boundary.
 */
export interface FaceVar {
  /** −1 snub / concave dorsum … +1 aquiline, with a dorsal hump. */
  hook: number;
  /** Canthal tilt — outer corner above (+) or below (−) the inner. */
  tilt: number;
  /** Mental cleft depth, 0 on most of a roster. */
  cleft: number;
  /** Whole-face lateral asymmetry. Two per cent is the difference between a
   *  person and a mirror-symmetric CG head, and the eye finds it instantly. */
  asym: number;
  /** Philtrum length multiplier, 0.85 – 1.18. */
  philtrum: number;
  /** Mouth width multiplier, 0.86 – 1.16. */
  mouth: number;
  /** Nose vertical shift, ny units. */
  noseY: number;
  /** Lower-third length multiplier — a long face vs a short one. */
  lower: number;
  /** Eyelid hooding, 0 open … 1 heavily hooded epicanthic fold. */
  hood: number;
}

export function faceVar(seed: number): FaceVar {
  const s = (seed | 0) || 1;
  return {
    hook: bi1(s, 11) * 0.9,
    tilt: bi1(s, 23) * 0.055,
    cleft: Math.max(0, h01(s, 37) - 0.68) * 3.1,
    asym: bi1(s, 53) * 0.022,
    philtrum: 0.85 + h01(s, 71) * 0.33,
    mouth: 0.86 + h01(s, 89) * 0.30,
    noseY: bi1(s, 103) * 0.026,
    lower: 0.94 + h01(s, 131) * 0.13,
    hood: h01(s, 149),
  };
}

export interface HeadFrame {
  centre: Vec3;
  rx: number; ry: number; rz: number;
  /** Unit of measure for every face feature. */
  R: number;
  /** |nx| of the eye centre, in unit-direction space. */
  eyeN: number;
  /** Palpebral aperture half-sizes, also in unit-direction space. */
  apW: number; apU: number; apD: number;
  eye: { pos: Vec3[]; r: number };
  /** Seed-derived shape jitter — see `faceVar`. */
  vr: FaceVar;
}

/**
 * The head's normalised coordinate is `ny`, where **0 is the eye line, −1 the
 * chin and +1 the crown** — the canonical artist's head-height ruler. Every
 * feature below is quoted on it, which is why the numbers can be checked against
 * a proportion chart instead of eyeballed:
 *
 *   menton −1.00   pogonion −0.90   mentolabial −0.805   lower lip −0.716
 *   stomion −0.655   upper lip −0.598   philtrum −0.532   subnasale −0.465
 *   alae −0.445   nose tip −0.395   eyes 0   nasion +0.048   brow +0.135
 *   hairline +0.44   crown +1.00
 *
 * The lower ladder is anthropometric, not eyeballed: with the pupils at ny 0
 * and the menton at −1 on a 234 mm head, the three facial thirds (trichion →
 * glabella → subnasale → menton) come out at 62 mm each, which puts the
 * subnasale 55 mm and the stomion 76 mm below the pupils.
 *
 * These constants are duplicated in `entities/material/Skin.ts` (brows, lashes,
 * vermilion, stubble zone) and in `creaseFn` below. Move one, move all three.
 */
export function headFrame(a: Anthro): HeadFrame {
  const R = a.g.headR;
  const hh = a.g.headH;
  const vr = faceVar(a.p.seed);
  const ry = hh * 0.50;
  const centre = V(0, a.chinY + hh * 0.50, -0.006 * a.H);
  const rx = R * 0.955;
  const rz = R * 1.10 * (0.96 + 0.10 * a.p.face.skull);
  const er = R * 0.145;
  const eyeN = clamp01(R * (0.345 + 0.070 * a.p.face.eyeW) / rx);
  const hf: HeadFrame = {
    centre, rx, ry, rz, R, eyeN, vr,
    // A palpebral fissure is 30 mm wide and 10 mm tall on an adult; the first
    // pass had it 26 × 14, which is a cartoon eye, and it was the loudest single
    // reason the roster read as dolls.
    apW: (er * 1.22) / rx,
    apU: (er * (0.34 + 0.34 * a.p.face.eyeOpen)) / ry,
    apD: (er * (0.26 + 0.22 * a.p.face.eyeOpen)) / ry,
    eye: { pos: [V(0, 0, 0), V(0, 0, 0)], r: er },
  };

  // Globe placement is solved against the finished surface, not guessed. Sample
  // the sculpted face straight down the aperture's axis, then sink the globe
  // behind that point: the cornea then breaks the skin over a chord of roughly
  // 1.6 radii ≈ 20 mm, which is a human eye. Guessing this analytically buried
  // the eyeball on the first three attempts.
  const dir = V(eyeN, 0, Math.sqrt(Math.max(0, 1 - eyeN * eyeN)));
  const p = V();
  faceSurface(a, hf, a.p.face, dir, p);
  // Sink it straight back in Z, NOT along the surface normal. Along the normal
  // the globe also travels medially, into a part of the face that stands
  // further forward, and it disappears inside the skull — which is exactly what
  // happened, twice.
  hf.eye.pos[0].set(p.x, p.y, p.z - 0.46 * er);
  hf.eye.pos[1].set(-p.x, p.y, p.z - 0.46 * er);
  return hf;
}

/** Radius/displacement field. `out` receives the world-space surface point. */
export function faceSurface(a: Anthro, hf: HeadFrame, F: FaceParams, dir: Vec3, out: Vec3): void {
  const nx = dir.x, ny = dir.y, nz = dir.z;
  const ax = Math.abs(nx);
  const front = clamp01(nz);
  const R = hf.R;
  const W = hf.vr;
  // Everything on the front of the face is gated by one of these two so a
  // feature cannot wrap round onto the temple or the back of the skull.
  const f1 = clamp01(nz * 1.5 - 0.25);
  const f2 = clamp01(nz * 1.7 - 0.42);
  // Handedness — a real face is not its own mirror. Two per cent is enough.
  const asy = 1 + W.asym * Math.sign(nx || 1);

  /* --- base ellipsoid, reshaped by region ------------------------------- */
  let rx = hf.rx, ry = hf.ry, rz = hf.rz;
  // Mandible taper. The old 0.50 floor closed the jaw to 106 mm across, which
  // is a wedge; a human mandible keeps two thirds of the cranial breadth right
  // down to the gonion and only closes below it. Squaring `low` holds the
  // mid-face wide and moves the whole taper into the last quarter.
  const low = smooth(-0.12, -0.98, ny);
  rx *= lerp(1, 0.615 + 0.215 * F.jaw, low * low);
  rz *= lerp(1, 0.87, low * 0.70);
  // Lower-third length: a long face and a short face are the same skull with a
  // different mandible, so stretch below the eye line rather than everywhere.
  ry *= ny < 0 ? lerp(1, W.lower, clamp01(-ny)) : 1;
  // Cranial vault: the back of the skull runs longer than the front.
  rz *= 1 + 0.11 * (F.skull - 0.5) * clamp01(-nz);
  // Temporal flattening — the sides above the ears are planes, not arcs.
  rx *= 1 - 0.095 * g1(ny, 0.42, 0.34) * ax * ax * ax;
  // The forehead leans back a little above the brow.
  rz *= 1 - 0.10 * g1(ny, 0.68, 0.30) * front;
  // The cranium is wider than the face across its widest point (parietals).
  rx *= 1 + 0.045 * g1(ny, 0.30, 0.35);
  rx *= asy;

  out.set(nx * rx, ny * ry, nz * rz);

  /* --- radial features -------------------------------------------------- */
  let d = 0;
  // Supraorbital ridge, strongest over the medial half of each brow, and its
  // lateral continuation onto the temporal crest.
  d += R * (0.058 + 0.130 * F.brow) * g1(ny, 0.135, 0.105) * front * g1(ax, 0.24, 0.28);
  d += R * (0.020 + 0.050 * F.brow) * g1(ny, 0.155, 0.115) * g1(ax, 0.62, 0.20) * clamp01(nz + 0.15);
  // Glabella dip between the brows, and the nasion notch below it — the two
  // together are what stop the brow and the nose reading as one prow.
  d -= R * 0.026 * g1(ny, 0.155, 0.070) * g1(nx, 0, 0.060) * front;
  d -= R * (0.034 + 0.020 * clamp01(-W.hook)) * g1(ny, 0.048, 0.062) * g1(nx, 0, 0.082) * f1;
  // Zygomatic body, its arch running back toward the ear, and the submalar
  // hollow under it. The hollow is what gives an endurance athlete a face.
  d += R * (0.062 + 0.105 * F.cheek) * g1(ny, -0.165, 0.140) * g1(ax, 0.585, 0.215) * clamp01(nz + 0.28);
  d += R * (0.022 + 0.040 * F.cheek) * g1(ny, -0.040, 0.130) * g1(ax, 0.855, 0.165) * clamp01(nz + 0.55);
  d -= R * (0.058 + 0.048 * (1 - F.cheek)) * g1(ny, -0.480, 0.135) * g1(ax, 0.520, 0.190) * f1;
  // Masseter belly and the gonial angle — where a jaw stops being a chin and
  // starts being a jaw.
  d += R * (0.020 + 0.048 * F.jaw) * g1(ny, -0.510, 0.150) * g1(ax, 0.600, 0.185) * clamp01(nz + 0.10);
  d += R * (0.032 + 0.090 * F.jaw) * g1(ny, -0.620, 0.165) * g1(ax, 0.680, 0.210) * clamp01(nz + 0.50);
  // Mental protuberance, its two tubercles, and the mentolabial sulcus above.
  d += R * (0.078 + 0.120 * F.chin) * g1(ny, -0.900, 0.150) * g1(nx, 0, 0.290) * clamp01(nz - 0.05);
  d += R * (0.020 + 0.030 * F.chin) * g1(ny, -0.915, 0.105)
    * (g1(nx, 0.115, 0.070) + g1(nx, -0.115, 0.070)) * f1;
  d -= R * 0.070 * g1(ny, -0.805, 0.055) * g1(nx, 0, 0.270) * f1;
  // Mental cleft. A minority trait, and it reads from ten metres.
  d -= R * 0.045 * W.cleft * g1(ny, -0.920, 0.080) * g1(nx, 0, 0.045) * f2;
  // Occiput and the nuchal shelf under it.
  d += R * 0.060 * g1(ny, 0.150, 0.360) * clamp01(-nz - 0.28);
  d -= R * 0.050 * g1(ny, -0.450, 0.190) * clamp01(-nz - 0.30);

  /* --- nose ------------------------------------------------------------- */
  // The old nose was one Gaussian wedge spanning ny +0.19 → −0.52 — 83 mm of
  // unbroken ridge from above the brow to the upper lip, with no tip, no wings
  // and no sill. It read as a ship's prow and it was the single worst feature
  // on the roster. This is the same nose an anatomy book draws: a root, a
  // dorsum, a lobule that overhangs it, two wings creased off the cheek, and a
  // sill that steps back to the philtrum.
  // Vertical thirds, from the anthropometry rather than from taste: with the
  // pupils at ny 0 and the menton at −1, the subnasale lands 55 mm below the
  // pupils (ny −0.465) and the stomion 76 mm (ny −0.655). The first pass had
  // both about 9 mm high, which shortened the lower third and is most of why
  // the roster read as juvenile.
  const nY = W.noseY;
  const NT = -0.395 + nY;             // pronasale (tip)
  const NB = -0.465 + nY;             // subnasale (base)
  const alaX = 0.124 + 0.062 * F.noseW;
  {
    // Dorsum: narrow at the root, widening slightly to the tip.
    // ^0.62 rather than linear: the dorsum has to be a quarter of its full
    // projection already at the eye line or the nose has no BRIDGE, and a nose
    // with no bridge is a lump stuck on the middle of a flat plane.
    const ridge = Math.pow(smooth(0.075 + nY, NT + 0.03, ny), 0.62)
      * smooth(NB - 0.055, NT - 0.010, ny);
    const wD = lerp(0.060, 0.092 + 0.028 * F.noseW, smooth(0.055 + nY, NT, ny));
    const proj = R * (0.130 + 0.115 * F.nose);
    out.z += proj * ridge * g1(nx, 0, wD) * f1;
    // Dorsal hump / scoop. One number, and it is most of what separates a
    // Roman nose from a snub one.
    out.z += R * 0.032 * W.hook * g1(ny, (NT + 0.085), 0.060) * g1(nx, 0, wD * 1.1) * f1;
    // Supratip break, then the lobule proper: a ball wider than the dorsum,
    // standing further forward than anything else on the face.
    out.z -= R * 0.020 * g1(ny, NT + 0.068, 0.030) * g1(nx, 0, wD * 0.9) * f1;
    const lob = g1(ny, NT, 0.048) * g1(nx, 0, 0.082 + 0.024 * F.noseW);
    out.z += R * (0.044 + 0.040 * F.nose) * lob * f1;
    out.y -= R * 0.060 * lob * f1 * (0.5 + 0.5 * clamp01(W.hook));
    // Alae. Radial, not axial: a nostril wing wraps the cheek.
    const ala = g1(ny, NT - 0.050, 0.050) * g1(ax, alaX, 0.052) * clamp01(nz * 1.6 - 0.20);
    d += R * (0.058 + 0.052 * F.noseW) * ala;
    // Alar crease — the groove that separates the wing from the cheek, and the
    // thing that makes a nose stop being part of the face. Wide enough that it
    // reads as a fold; at 1.5 mm it cut the nose into a pinched snout.
    d -= R * 0.042 * g1(ny, NT - 0.030, 0.058) * g1(ax, alaX + 0.062, 0.032) * clamp01(nz - 0.10);
    // Nostril sill: two pits under the lobule, and the columella between them.
    out.z -= R * 0.100 * g1(ny, NB + 0.018, 0.030)
      * g1(ax, 0.056 + 0.022 * F.noseW, 0.028) * clamp01(nz - 0.20);
    out.z += R * 0.032 * g1(ny, NB + 0.014, 0.040) * g1(nx, 0, 0.028) * clamp01(nz - 0.16);
    // Subnasale: the face steps back sharply under the nose.
    out.z -= R * 0.050 * g1(ny, NB - 0.044, 0.036) * g1(nx, 0, 0.150) * clamp01(nz - 0.25);
  }

  /* --- mouth ------------------------------------------------------------ */
  {
    // A mouth is 48–54 mm wide on an adult, which at rx = 82 mm is a half-width
    // of 0.30 in nx. The first pass used 0.19 — a 31 mm mouth — and the result
    // was a pucker that the eye read as a second nose.
    const mw = (0.278 + 0.050 * F.lips) * W.mouth;
    // 1 across the body of the lip, 0 by the commissure.
    const mFall = smooth(mw * 1.10, mw * 0.55, ax);
    // Muzzle: the whole maxillary/mandibular block around the mouth stands a
    // little proud of the cheeks. Without it the lips are stuck on a flat plane.
    d += R * 0.030 * g1(ny, -0.660, 0.160) * g1(ax, 0.0, 0.330) * f1;
    // Philtrum: a groove between two columns, running from the columella down
    // to the cupid's bow.
    const phil = g1(ny, -0.532 * W.philtrum, 0.048 * W.philtrum);
    d -= R * 0.032 * phil * g1(nx, 0, 0.028) * f2;
    d += R * 0.020 * phil * (g1(nx, 0.050, 0.024) + g1(nx, -0.050, 0.024)) * f2;
    // Upper vermilion, with a cupid's bow: two peaks either side of a midline
    // dip. The dip is 8 mm across and it is worth more than the lip itself.
    const bow = 1 - 0.45 * g1(nx, 0, 0.028);
    d += R * (0.040 + 0.062 * F.lips) * g1(ny, -0.598, 0.030) * mFall * bow * f2;
    // Lower vermilion — always the fuller of the two, and it rolls under.
    d += R * (0.048 + 0.070 * F.lips) * g1(ny, -0.716, 0.036) * mFall * f2;
    // The lip line itself. Narrow and deep: this is a 1 mm crease and the eye
    // reads the SHADOW, so a soft 6 mm Gaussian here buys nothing at all.
    d -= R * 0.105 * g1(ny, -0.655, 0.014) * smooth(mw * 1.22, mw * 0.60, ax) * f2;
    // …and the two commissure pits it ends in.
    d -= R * 0.038 * g1(ny, -0.658, 0.038) * g1(ax, mw * 0.98, 0.032) * f2;
    // Nasolabial fold: from the alar crease down past the commissure. Narrow,
    // because a fold is a fold.
    const nl = smooth(NB + 0.02, -0.70, ny);
    d -= R * (0.046 + 0.030 * (1 - F.cheek)) * g1(ny, -0.585, 0.105)
      * g1(ax, alaX + 0.105 + 0.085 * nl, 0.038) * f1;
  }

  /* --- the mandibular border -------------------------------------------- */
  // A jaw reads as a jaw because there is an EDGE between the cheek and the
  // shadow under it. One narrow negative band along the mandible does more for
  // a face at ten metres than the whole cheekbone above it.
  {
    const jb = jawLine(nz) + 0.13;
    d -= R * (0.022 + 0.026 * F.jaw) * g1(ny, jb, 0.055) * clamp01(nz + 0.10)
      * smooth(0.10, 0.34, ax);
  }

  if (d !== 0) {
    const len = Math.hypot(out.x, out.y, out.z) || 1;
    out.multiplyScalar(1 + d / len);
  }

  /* --- orbit, palpebral aperture and both lid margins -------------------- */
  // These are applied as PURE DEPTH, after the radial pass, and that distinction
  // is load-bearing. A radial socket also drags the surface inward in x, so the
  // un-recessed skin just outboard of it stays further forward and forms an
  // overhang that swallows the eyeball whole. It did, for four iterations.
  // Sculpting the lids into the face also beats building them as their own
  // shell: at 12 mm of globe radius there is no gap to put a separate lid in.
  if (nz > 0.10) {
    // Canthal tilt: the whole aperture rotates about the eye centre, so the
    // outer corner rides above (or below) the inner one.
    const ddx = ax - hf.eyeN;
    const nyT = ny - ddx * W.tilt / Math.max(1e-4, hf.apW) * hf.apU * 1.4;
    const q = (ddx * ddx) / (hf.apW * hf.apW)
      + (nyT * nyT) / (nyT > 0 ? hf.apU * hf.apU : hf.apD * hf.apD);
    const qq = Math.sqrt(q);
    const fz = clamp01(nz * 1.7 - 0.10);
    let dz = 0;
    // Orbital cavity: a broad recess the brow overhangs. Centred ON the eye it
    // buried the upper lid and every athlete squinted; the cavity's deepest
    // point is above the globe, not on it.
    dz -= R * 0.108 * g1(nyT, 0.060, 0.185) * g1(ax, 0.400, 0.280) * fz;
    // Tear trough / infraorbital groove under the lower lid.
    dz -= R * 0.034 * g1(nyT, -hf.apD * 2.6, hf.apD * 1.5) * g1(ax, hf.eyeN * 0.78, 0.150) * fz;
    if (qq < 3.2) {
      // The aperture: cut the skin back behind the corneal plane so the globe is
      // exposed over a real chord. A soft ramp here is what gave the first pass
      // a 12 mm slit in a 24 mm eye.
      dz -= R * 0.155 * smooth(1.14, 0.80, qq) * fz;
      // Lid margins — a rolled edge just outboard of the aperture, thicker
      // above, and both of them proud of the skin around them.
      const mUp = nyT > 0 ? 1.0 : 0.62;
      const mk = (qq - 1.15) / 0.17;
      dz += R * 0.052 * mUp * Math.exp(-mk * mk) * fz;
      // Supratarsal crease. A hooded lid buries it; an open one shows 8 mm of
      // tarsal platform under it.
      const ck = (qq - (1.62 + 0.34 * W.hood)) / (0.24 + 0.14 * W.hood);
      dz -= R * (0.046 - 0.022 * W.hood) * Math.exp(-ck * ck) * clamp01(nyT * 6.0) * fz;
      // Epicanthic / medial canthus — the inner corner sits deeper than the
      // outer one on every face.
      const kk = (qq - 1.0) / 0.55;
      dz -= R * 0.030 * Math.exp(-kk * kk) * smooth(hf.eyeN * 0.55, hf.eyeN * 0.05, ax) * fz;
    }
    out.z += dz;
  }

  /* --- below the jawline the head funnels into the neck ----------------- */
  // The jawline is not a level ring: it sits at the chin in front, rises to the
  // gonion at the sides and higher still at the nape. A level cut is what makes
  // a procedural head read as a lollipop from any camera below eye level, and a
  // sideline camera is always below eye level.
  const jawNy = jawLine(nz);
  const under = smooth(jawNy + 0.08, jawNy - 0.32, ny);
  if (under > 0) {
    // FUNNEL_R must stay comfortably clear of the neck loft's own radius. When
    // the two matched exactly the surfaces z-fought and shattered the entire jaw
    // into polygon shards — which reads as a normals bug and is not one.
    const nr = a.g.neckA * FUNNEL_R;
    const nzr = a.g.neckB * FUNNEL_R;
    const h = Math.hypot(out.x, out.z) || 1e-5;
    const tx = (out.x / h) * nr;
    const tz = (out.z / h) * nzr - a.H * 0.005;
    // The submental plane slopes back and DOWN toward the hyoid; the target is
    // therefore much shallower in front than at the nape. A single constant put
    // every funnelled direction at the same height, which flattened the whole
    // under-jaw into one horizontal disc.
    const ty = a.chinY - hf.centre.y - a.g.headH * (0.17 - 0.13 * clamp01(nz * 1.8));
    out.set(lerp(out.x, tx, under), lerp(out.y, ty, under), lerp(out.z, tz, under));
  }

  out.add(hf.centre);
}

function headSkin(a: Anthro, p: Vec3): Skin {
  const t = smooth(a.chinY + a.H * 0.010, a.chinY - a.H * 0.045, p.y);
  return t > 0 ? skMix(sk1(bi('head')), sk2(bi('neck'), 0.75, bi('head'), 0.25), t) : sk1(bi('head'));
}

export function buildHead(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const hf = headFrame(a);
  const F = a.p.face;
  const W = hf.vr;
  // The hero head carries a nostril sill, a lip line and a lid margin, and none
  // of those survive a 50 × 45 grid. Half again on both axes costs ~4.6 k
  // triangles on the LOD that is only ever drawn inside eight metres, and it is
  // the difference between a mouth and a smudge.
  const hu = d.level === 0 ? Math.round(d.headU * 1.55) : d.headU;
  const hv = d.level === 0 ? Math.round(d.headV * 1.40) : d.headV;
  m.group(GROUP.skin).sphereish(
    hu, hv,
    (dir, _u, _v, out) => {
      if (d.face) faceSurface(a, hf, F, dir, out);
      else {
        const low = smooth(-0.12, -0.98, dir.y);
        out.set(dir.x * hf.rx * lerp(1, 0.66, low * low), dir.y * hf.ry,
          dir.z * hf.rz * lerp(1, 0.88, low * 0.70));
        const jawNy = jawLine(dir.z);
        const under = smooth(jawNy + 0.08, jawNy - 0.32, dir.y);
        if (under > 0) {
          const h = Math.hypot(out.x, out.z) || 1e-5;
          out.set(lerp(out.x, (out.x / h) * a.g.neckA * FUNNEL_R, under),
            lerp(out.y, a.chinY - hf.centre.y - a.g.headH * 0.16, under),
            lerp(out.z, (out.z / h) * a.g.neckB * FUNNEL_R - a.H * 0.005, under));
        }
        out.add(hf.centre);
      }
    },
    (p) => headSkin(a, p),
    {
      part: PART.HEAD, side: 0,
      // Clustering toward the front and toward the equator: a uniform lat-long
      // grid spends most of its rows on the back of the skull and cannot resolve
      // a 26 mm palpebral aperture or a 3 mm lip line.
      warpU: 0.62, warpV: 0.30,
      creaseFn: (_p, u, v) => {
        // Orbit, alar crease, nasolabial fold, lip line, mentolabial sulcus and
        // the jawline, so a skin shader has cavity information without a baked
        // AO map. Every landmark here is the same number `faceSurface` used.
        const phi = v * Math.PI;
        const th = u * Math.PI * 2;
        const ny = Math.cos(phi);
        const nz = Math.sin(phi) * Math.cos(th);
        const nx = Math.sin(phi) * Math.sin(th);
        const ax = Math.abs(nx);
        const fr = clamp01(nz);
        const alaX = 0.124 + 0.062 * F.noseW;
        const NT = -0.395 + W.noseY;
        const jawNy = jawLine(nz);
        return clamp01(
          0.90 * g1(ny, 0.030, 0.11) * g1(ax, 0.40, 0.18) * fr
          + 0.70 * g1(ny, -0.655, 0.024) * g1(nx, 0, 0.28) * fr
          + 0.55 * g1(ny, -0.585, 0.085) * g1(ax, alaX + 0.125, 0.052) * fr
          + 0.48 * g1(ny, NT - 0.030, 0.050) * g1(ax, alaX + 0.062, 0.034) * fr
          + 0.55 * g1(ny, NT - 0.070, 0.030) * g1(ax, 0.056, 0.030) * clamp01(nz - 0.20)
          + 0.34 * g1(ny, -0.805, 0.054) * g1(nx, 0, 0.26) * fr
          + 0.30 * g1(ny, -0.480, 0.14) * g1(ax, 0.52, 0.19) * fr
          + 0.34 * g1(ny, -0.532, 0.030) * g1(nx, 0, 0.030) * fr
          + 0.90 * smooth(jawNy + 0.10, jawNy - 0.30, ny)
          + 0.40 * g1(ny, jawNy + 0.11, 0.070) * clamp01(nz + 0.45),
        );
      },
    },
  );

  if (d.ears) buildEars(m, a, hf);
  if (d.eyes) buildEyes(m, a, hf, d);
  buildHair(m, a, hf, d);
}

/* ------------------------------------------------------------------- ears */

/**
 * An ear is a rolled rim (the helix) enclosing a bowl (the concha), with a
 * Y-shaped ridge (the antihelix) inside it, a flap over the canal (the tragus)
 * and a soft lobe hanging off the bottom. The first pass was five concentric
 * scaled copies of one oval, which renders as a flat blob stuck to the skull —
 * and an ear that reads as a blob is one of the fastest "this is a game asset"
 * cues there is, because the eye knows exactly what an ear looks like.
 *
 * Built as a loft of seven rings whose radial profile changes shape along the
 * stack, so the outline goes from an attached oval at the skull to a rolled rim
 * at the helix and back to a small bowl at the concha floor.
 */
function buildEars(m: RigMesh, a: Anthro, hf: HeadFrame): void {
  const F = a.p.face;
  const R = hf.R;
  const h = R * (0.315 + 0.085 * F.ears);
  const w = R * (0.150 + 0.052 * F.ears);
  const out = R * (0.080 + 0.085 * F.ears);
  // Ear centre sits at ny ≈ −0.19: the top of the helix lines up with the brow
  // and the lobe with the base of the nose, which is the check every portrait
  // painter runs and the one thing that stops an ear looking stuck on.
  const cy = hf.centre.y - hf.ry * 0.19;
  const cz = hf.centre.z - hf.rz * 0.19;

  /**
   * Outline at parameter `t` (0 = top of the helix, 0.5 = the lobe) for stack
   * level `k`. `rr` is the ear's own silhouette; `bowl` hollows the middle of
   * the inner rings so the concha is a cavity rather than a smaller ear.
   */
  const PUSH = [0.00, 0.55, 1.00, 1.05, 0.86, 0.46, 0.16];
  const SCALE = [0.86, 1.00, 0.97, 0.80, 0.60, 0.42, 0.22];
  const DEPTH = [0.00, 0.10, 0.02, -0.16, -0.34, -0.46, -0.44];

  for (const s of SIDES) {
    const cx = s * hf.rx * 0.965;
    const rings: Ring[] = [];
    for (let k = 0; k < PUSH.length; k++) {
      const sc = SCALE[k];
      rings.push({
        o: V(cx + s * out * PUSH[k], cy + h * 0.085 * PUSH[k], cz - w * 0.30 * PUSH[k]),
        ax: V(0, 1, 0), az: V(0, 0, 1),
        r: (t: number) => {
          const th = t * Math.PI * 2;
          const c = Math.cos(th), sn = Math.sin(th);
          // Silhouette: helix broad and square at the top, a slight notch behind
          // the tragus, and a rounded lobe that hangs below the canal.
          let rr = 1 + 0.185 * c - 0.105 * Math.cos(2 * th) + 0.045 * Math.cos(3 * th + 0.9);
          // Intertragic notch — a real ear has a nick at the bottom front.
          rr -= 0.16 * Math.exp(-Math.pow((t - 0.62) / 0.055, 2));
          // Lobe: fatter and pushed forward on the outer rings only.
          rr += (0.10 + 0.10 * F.ears) * Math.exp(-Math.pow((t - 0.50) / 0.10, 2)) * (k < 3 ? 1 : 0.3);
          return [c * h * rr * sc, sn * w * rr * sc];
        },
        skin: sk1(bi('head')),
        v: k / (PUSH.length - 1),
        // The concha floor and the rim's underside are the two places an ear is
        // genuinely dark; hand the shader the cavity rather than an AO bake.
        crease: k >= 3 ? 0.55 + 0.12 * k : 0.12,
      });
    }
    // Sink the inner rings toward the skull: PUSH lifts the rim off the head and
    // DEPTH pulls the bowl back into it, which is the whole shape of an ear.
    for (let k = 0; k < rings.length; k++) {
      rings[k].o.x += s * out * DEPTH[k] * 1.9;
    }
    m.group(GROUP.skin).loft(rings, 16, {
      part: PART.EAR, side: s, capStart: false, capEnd: true, flip: s > 0,
    });

    // Antihelix: a short Y-ridge across the bowl. Two lofted tubes is cheaper
    // and more legible than trying to sculpt it into the concha rings.
    const ah: Ring[] = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      const yy = cy + h * (0.34 - 0.62 * t);
      const zz = cz + w * (-0.30 + 0.26 * t);
      const rr = R * (0.030 - 0.012 * t);
      ah.push({
        o: V(cx + s * out * (0.52 + 0.10 * t), yy, zz),
        ax: V(0, 1, 0), az: V(0, 0, 1),
        r: (tt: number) => {
          const th = tt * Math.PI * 2;
          return [Math.cos(th) * rr * 1.9, Math.sin(th) * rr];
        },
        skin: sk1(bi('head')), v: t, crease: 0.25,
      });
    }
    m.group(GROUP.skin).loft(ah, 8, {
      part: PART.EAR, side: s, capStart: true, capEnd: true, flip: s > 0,
    });
  }
}

/* ------------------------------------------------------------------- eyes */

/**
 * Eyeball UV, for whoever writes the eye material: the sphere is built with its
 * pole facing forward, so **uv.y = 1 is the corneal apex**. Iris ≈ uv.y > 0.86,
 * pupil ≈ uv.y > 0.955, sclera below that. uv.x is the roll around the axis and
 * carries no meaning.
 */
function buildEyes(m: RigMesh, a: Anthro, hf: HeadFrame, d: DetailSpec): void {
  const er = hf.eye.r;
  const su = d.level === 0 ? 20 : 9;
  const sv = d.level === 0 ? 14 : 6;
  for (let si = 0; si < 2; si++) {
    const c = hf.eye.pos[si];
    m.group(GROUP.eyes).sphereish(su, sv, (dir, _u, v, out) => {
      // Pole → +Z, so uv.y = 1 is the corneal apex. A slightly proud cornea
      // over the front 25% gives the highlight something to slide across.
      const bulge = 1 + 0.055 * smooth(0.34, 0.0, v);
      out.set(dir.x * er * bulge, dir.z * er * bulge, dir.y * er * bulge).add(c);
      // The (x,y,z) → (x,z,y) axis swap that points the pole forward is a
      // REFLECTION, so the winding has to be flipped with it or every eyeball
      // renders inside-out and is culled away.
    }, () => sk1(bi('head')), { part: PART.EYE, side: SIDES[si], flip: true });
  }
}

/* ------------------------------------------------------------------- hair */

/** Polar extent of the hair cap at azimuth `u` (0 = front). */
function hairline(u: number, style: string, F: FaceParams, seed: number): number {
  // u is the sphereish azimuth: sin(th) → x, cos(th) → z, so u = 0 faces +Z.
  const th = u * Math.PI * 2;
  const front = Math.cos(th);
  // Polar angle from the crown. Forehead 1.10 rad (ny ≈ +0.45, the standard
  // hairline), temples 1.36 (just above the ear), nape 1.85. A level ring around
  // the skull is the classic swim-cap tell.
  // Hair.ts erodes the outermost ~6 % of the cap into a fringe, so the polar
  // extent here is the SHELL's, not the hairline's: it has to overshoot by that
  // much or the visible hairline climbs 25 mm up the forehead — which is what
  // gave the first pass its enormous brow.
  let phi = 1.38 - 0.26 * clamp01(front) + 0.49 * clamp01(-front);
  // A slight widow's peak — the hairline dips lower on the midline.
  phi += 0.065 * Math.pow(clamp01(front), 6);
  // Temporal recession, per athlete. A hairline that is the same arc on
  // fourteen heads is fourteen wigs.
  const rec = h01(seed, 211) * 0.10;
  phi -= rec * Math.exp(-Math.pow((Math.abs(th - Math.PI) - Math.PI + 0.62) / 0.34, 2));
  phi += (h01(seed, 227) - 0.5) * 0.06;
  if (style === 'buzz') phi += 0.12;
  if (style === 'locs') phi += 0.05;
  return Math.min(1.98, phi * (0.98 + 0.04 * F.skull));
}

const HAIR_THICK: Record<string, number> = {
  buzz: 0.035, short: 0.085, crop: 0.155, ponytail: 0.105, bun: 0.115, long: 0.135, locs: 0.150,
};

function buildHair(m: RigMesh, a: Anthro, hf: HeadFrame, d: DetailSpec): void {
  const style = a.p.hair;
  const F = a.p.face;
  const bulk = a.p.hairBulk;
  const seed = a.p.seed;
  const th0 = (HAIR_THICK[style] ?? 0.09) * hf.R * bulk;
  const su = Math.max(8, Math.round(d.headU * 0.9));
  const sv = Math.max(4, Math.round(d.headV * 0.55));

  m.group(GROUP.hair).sphereish(su, sv, (_dir, u, v, out) => {
    const phiMax = hairline(u, style, F, seed);
    const phi = v * phiMax;
    const thz = u * Math.PI * 2;
    const nx = Math.sin(phi) * Math.sin(thz);
    const ny = Math.cos(phi);
    const nz = Math.sin(phi) * Math.cos(thz);
    // Sit on the skull, then lift by the hair's own thickness, tapering to zero
    // exactly at the hairline so the shell has an edge instead of a cliff.
    const dirv = V(nx, ny, nz);
    const p = new THREE.Vector3();
    faceSurface(a, hf, F, dirv, p);
    // Never taper to exactly zero at the hairline: a coincident shell z-fights
    // into a speckled sawtooth. A real haircut has a visible edge anyway.
    const t = th0 * (0.35 + 0.65 * smooth(1.0, 0.55, v)) * (0.30 + 0.70 * smooth(1.0, 0.86, v));
    // Crown volume: hair is thickest on top and at the back, not at the temples.
    let vol = 1 + 0.28 * clamp01(ny) - 0.22 * Math.abs(nx);
    // Three harmonics of lift. Without them the cap is a moulded swim cap, which
    // is exactly what the first pass looked like — a mass of hair has a lumpy
    // outline even when it is short. The phases are per-athlete so two players
    // with the same cut do not part their hair identically.
    const ph = h01(seed, 307) * 6.283;
    vol *= 1 + 0.22 * Math.cos(thz * 3 + 0.7 + ph) * (0.4 + 0.6 * v)
      + 0.13 * Math.cos(thz * 5 - 1.4 + ph * 0.7)
      + 0.10 * Math.cos(v * 7.3 + thz * 2 + ph);
    const n = p.clone().sub(hf.centre).normalize();
    out.copy(p).addScaledVector(n, t * vol);
  }, (p) => headSkin(a, p), { part: PART.HAIR, side: 0 });

  if (!d.hairCards) return;

  const R = hf.R;
  const back = V(0, hf.centre.y + R * 0.32, hf.centre.z - hf.rz * 0.86);

  if (style === 'ponytail') {
    const dir = V(0, -0.42, -1).normalize();
    const rings: Ring[] = [];
    const L = R * 2.6 * bulk;
    for (let i = 0; i <= 5; i++) {
      const u = i / 5;
      const rr = R * (0.30 * (1 - 0.55 * u) + 0.06) * bulk;
      rings.push({
        o: back.clone().addScaledVector(dir, L * u).add(V(0, -0.35 * L * u * u, 0)),
        ax: V(1, 0, 0), az: V(0, 0, 1),
        r: (t: number) => {
          const th = t * Math.PI * 2;
          return [Math.cos(th) * rr, Math.sin(th) * rr * 0.82];
        },
        skin: sk1(bi('head')), v: u, crease: 0.2 + 0.3 * u,
      });
    }
    m.group(GROUP.hair).loft(rings, 8, { part: PART.HAIR, side: 0, capEnd: true });
  } else if (style === 'bun') {
    const c = back.clone().add(V(0, R * 0.30, -R * 0.10));
    const rr = R * 0.46 * bulk;
    m.group(GROUP.hair).sphereish(10, 7, (dir, _u, _v, out) => {
      out.set(dir.x * rr, dir.y * rr * 0.86, dir.z * rr * 0.78).add(c);
    }, () => sk1(bi('head')), { part: PART.HAIR, side: 0 });
  } else if (style === 'long' || style === 'locs') {
    // A curtain that follows the skull and falls to the trapezius. Built as a
    // loft whose cross-section is an open arc, so it is a sheet with two edges
    // rather than a tube swallowing the neck.
    const drop = R * (style === 'locs' ? 2.5 : 2.9) * bulk;
    const rings: Ring[] = [];
    const N = 6;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const y = hf.centre.y + R * 0.28 - drop * u;
      const rr = R * lerp(1.02, 1.30, u * u);
      const zc = hf.centre.z - hf.rz * 0.16 - R * 0.22 * u;
      rings.push({
        o: V(0, y, zc),
        ax: V(1, 0, 0), az: V(0, 0, 1),
        r: (t: number) => {
          // Arc from t=0.30 to t=0.70 of the circle — the back of the head only.
          const th = (0.30 + t * 0.42) * Math.PI * 2;
          const wob = style === 'locs' ? 1 + 0.10 * Math.cos(th * 9) : 1;
          return [Math.sin(th) * rr * 1.02 * wob, Math.cos(th) * rr * 1.05 * wob];
        },
        skin: skMix(sk1(bi('head')), sk1(bi('neck')), u * 0.55),
        v: u, crease: 0.25 + 0.35 * u,
      });
    }
    m.group(GROUP.hair).loft(rings, 12, { part: PART.HAIR, side: 0, open: true });
  }
}
