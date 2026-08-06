import * as THREE from 'three';
import { PART, GROUP } from './Types.ts';
import type { FaceParams } from './Types.ts';
import { SIDES, bi, EYE_BONE } from './Skeleton.ts';
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

/**
 * Head-to-neck funnel radius, as a multiple of the neck loft's own radius.
 *
 * 1.26 was too generous by a long way. `buildNeck` tops out at `neckA * 1.02`,
 * so a 1.26 funnel puts the underside of the head 14 mm OUTSIDE the neck it is
 * supposed to be landing on — the head stops being a head somewhere around the
 * gonion and becomes a column wider than the jaw above it. That is the whole of
 * "the roster has no jawline": there was a mandible sculpted in `faceSurface`
 * and then this threw a wider cylinder over the bottom of it.
 *
 * 1.10 keeps 8 % of clearance, which is ample — the failure the old number was
 * defending against was the two surfaces matching EXACTLY, where they z-fought
 * and shattered the jaw into shards. Eight per cent is not exactly.
 */
export const FUNNEL_R = 1.10;

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
  //
  // The lateral value came down from −0.72 to −0.80 for the other half of the
  // same complaint: the gonion sits at about ny −0.78, so a border at −0.72 was
  // starting the funnel ABOVE the jaw angle and eating the one landmark that
  // makes a jaw read as a jaw from ten metres.
  return -0.80 - 0.34 * clamp01(nz * 2.4) + 0.42 * clamp01(-nz * 1.6);
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
  // Globe radius. An adult eyeball is 24 mm across almost regardless of stature,
  // but everything on this head is quoted in `R` so it has to be expressed that
  // way; 0.152 R lands at 23.9 mm on the reference athlete. At 0.145 it was
  // 22.8 mm, which then forced a 10.4 mm iris — a millimetre and a half under
  // life size, and the eye read small in its own socket.
  const er = R * 0.152;
  const eyeN = clamp01(R * (0.345 + 0.070 * a.p.face.eyeW) / rx);
  const hf: HeadFrame = {
    centre, rx, ry, rz, R, eyeN, vr,
    // A palpebral fissure is 30 mm wide and 10 mm tall on an adult; the first
    // pass had it 26 × 14, which is a cartoon eye, and it was the loudest single
    // reason the roster read as dolls.
    //
    // THE UPPER LID MUST CROSS THE IRIS. This is the one number on the head that
    // decides whether a face reads as focused or as terrified, and it is pure
    // arithmetic — nothing downstream can undo it, because a lid that does not
    // reach the iris leaves sclera above the iris and sclera above the iris is
    // the hardwired human startle display.
    //
    // The old mapping was `er * (0.34 + 0.34 * eyeOpen)`, which put the aperture
    // top 5.3–7.8 mm above the pupil axis across the roster's eyeOpen range
    // [0.30, 0.92]. The iris top sits at er·irisR ≈ 5.7–6.3 mm (`irisR` is
    // 0.478–0.528 in PlayerMaterial.ts, compared in Eyes.ts against the globe's
    // PROJECTED radius). So the most relaxed athlete the parameter space could
    // produce had the lid tangent to the iris and every other athlete showed
    // white over it: measured over the fourteen-player roster the sculpted
    // fissure top cleared the iris top by 0.05–3.8 mm, on all fourteen.
    //
    // The art direction's prescription was 0.26 + 0.10·eyeOpen, which puts the
    // sculpted margin 1.5–2.2 mm inside the iris. On the ANALYTIC surface that is
    // exactly right and it measures exactly that. It is not what ships.
    //
    // WHAT SHIPS IS SAMPLED, AND THE SAMPLER QUANTISES THIS NUMBER. `buildHead`
    // evaluates this surface on a lat-long grid, and the delivered lid margin is
    // not where the sculpt puts it — it is where the straight chord between two
    // adjacent ROWS crosses the eyeball. At the old row budget the pitch at the
    // eye line was 3.6 mm at `ultra` and 4.9 mm at `low`, so a 10 mm fissure was
    // two rows tall and the delivered aperture top could only take two or three
    // values. Sweeping this constant from 0.06 to 0.26 moved it in 4–5 mm jumps
    // with the sign of the error flipping between neighbouring steps: every
    // value in the sweep left sclera above the iris on some athlete at some
    // shipped tier. The table is in `buildHead`, where the fix lives — the row
    // budget, not this constant. Do not re-tune this number against a single
    // tier; measure all four with `tools/_lidgeo.mjs --tess`.
    //
    // With the hero head at 94 rows (2.7 mm at the eye line, aperture 3.5–4 rows
    // tall) the whole 0.10–0.20 band delivers positive coverage on all fourteen
    // athletes at all four tiers, and 0.18 is the value inside it that also
    // keeps the most hooded athlete's fissure open: 1.04–3.50 mm of iris covered
    // above, 9.0–11.9 mm of fissure, against the brief's 1.5–2.5 and a 21–24 mm
    // width. It errs a shade heavy at the relaxed end, which is the right side
    // to err on — a heavy lid reads as calm, and the failure this whole round
    // exists to kill is the other one.
    //
    // The lower lid goes to the lower limbus and stays there — a relaxed eye
    // shows no sclera under the iris either — with a slop allowance one notch
    // smaller, because sclera below the iris does not trip the startle response
    // the way sclera above it does. The pupil correctly sits above the
    // aperture's vertical midpoint.
    apW: (er * 1.22) / rx,
    apU: (er * (0.18 + 0.10 * a.p.face.eyeOpen)) / ry,
    apD: (er * (0.40 + 0.05 * a.p.face.eyeOpen)) / ry,
    eye: { pos: [V(0, 0, 0), V(0, 0, 0)], r: er },
  };

  // Globe placement is solved against the finished surface, not guessed.
  //
  // THE REFERENCE PLANE IS THE LID MARGIN, NOT THE FLOOR OF THE SOCKET. This is
  // the whole bug the first pass had. `faceSurface` sampled down the aperture's
  // own axis returns the deepest point of the sculpted recess — the aperture cut
  // and the orbital cavity together take ~20 mm out of the face there — and
  // sinking the globe a further 0.46 r *behind that* put the cornea about 10 mm
  // inside the skull. Every athlete on the roster rendered with two dark pits
  // and a crescent of sclera, which is what "the eyes read as holes" was.
  //
  // On an open eye the corneal apex sits essentially level with the lid margins.
  // So sample the LOWER MARGIN, one aperture-radius below the axis and outside
  // the cut, and hang the globe off that. It re-solves itself for every face in
  // the roster instead of depending on a constant fitted to one of them.
  const nzC = Math.sqrt(Math.max(0, 1 - eyeN * eyeN));
  const dir = V(eyeN, 0, nzC);
  const p = V();
  faceSurface(a, hf, a.p.face, dir, p);

  // `p` is the floor of a 16 mm recess, so it is the one place on the face that
  // must NOT be used as a reference. Subtract the orbit's own displacement back
  // off it and the un-recessed cheek/brow plane falls out exactly.
  const zPlane = p.z - orbitDz(hf, hf.vr, eyeN, 0, nzC);
  // The lower lid margin, one aperture radius below the axis. On an open eye the
  // corneal apex sits essentially level with the margins — a hair behind, never
  // in front, or the globe bulges out of its own lids.
  //
  // This survives the aperture re-map above for a reason worth stating: the
  // sample is quoted as a MULTIPLE of `apD`, so `orbitDz`'s aperture coordinate
  // `qq` at this point is identically 1.15 whatever `apD` is, and the aperture
  // cut, the lid-margin roll, the tear trough and the canthus terms are all
  // functions of `qq` alone here. Only the orbital-cavity Gaussian — which is
  // quoted in absolute ny, being anchored to the brow and not to the lid — sees
  // the move, and it shifts the apex forward by 0.26 mm on the reference
  // athlete. Re-measured after the change: the skin still stands 2.7 mm proud of
  // the globe at the lower margin and 6.5 mm at the upper, i.e. both lids still
  // occlude, and the cornea does not burst through either of them.
  const my = -1.15 * hf.apD;
  const nzM = Math.sqrt(Math.max(0.01, 1 - eyeN * eyeN - my * my));
  const apexZ = zPlane + orbitDz(hf, hf.vr, eyeN, my, nzM) - 0.02 * er;
  // Move it straight in Z, NOT along the surface normal. Along the normal the
  // globe also travels medially, into a part of the face that stands further
  // forward, and it disappears inside the skull — which happened twice.
  hf.eye.pos[0].set(p.x, p.y, apexZ - er);
  hf.eye.pos[1].set(-p.x, p.y, apexZ - er);
  return hf;
}

/**
 * The orbit, the palpebral aperture and both lid margins, as PURE DEPTH.
 *
 * That it is pure depth is load-bearing. A radial socket also drags the surface
 * inward in x, so the un-recessed skin just outboard of it stays further forward
 * and forms an overhang that swallows the eyeball whole. It did, for four
 * iterations. Sculpting the lids into the face also beats building them as their
 * own shell: at 11 mm of globe radius there is no gap to put a separate lid in.
 *
 * It lives in its own function so `headFrame` can evaluate the SAME numbers when
 * it places the globe. Placing an eyeball against a re-derived guess at how deep
 * this recess is has now failed twice in two different directions — once buried
 * a centimetre inside the skull, once burst out through the lower lid — and both
 * times the fix was a constant fitted against one face out of fourteen. Reading
 * the displacement back out of the sculpt itself cannot drift.
 */
function orbitDz(hf: HeadFrame, W: FaceVar, nx: number, ny: number, nz: number): number {
  if (nz <= 0.10) return 0;
  const R = hf.R;
  const ax = Math.abs(nx);
  // Canthal tilt: the whole aperture rotates about the eye centre, so the outer
  // corner rides above (or below) the inner one.
  const ddx = ax - hf.eyeN;
  const nyT = ny - ddx * W.tilt / Math.max(1e-4, hf.apW) * hf.apU * 1.4;
  const q = (ddx * ddx) / (hf.apW * hf.apW)
    + (nyT * nyT) / (nyT > 0 ? hf.apU * hf.apU : hf.apD * hf.apD);
  const qq = Math.sqrt(q);
  const fz = clamp01(nz * 1.7 - 0.10);
  let dz = 0;

  /**
   * `qq` MEASURES THE APERTURE. `gg` MEASURES THE GLOBE. THEY ARE NOT THE SAME
   * RULER AND EVERY TERM HERE HAS TO SAY WHICH ONE IT MEANS.
   *
   * This is the whole cost of halving the aperture, and it is worth writing down
   * because it cost this round two full measurement passes to find. `qq` is
   * distance in units of the palpebral half-axes, so a feature quoted at `qq
   * 1.62` sat 10.5 mm above the pupil axis under the OLD `apU` of 6.5 mm and
   * sits 5.7 mm above it under the new 3.5 mm. Three features moved that way
   * without anyone asking them to — the orbital cavity's mask, the supratarsal
   * crease, and the lid-margin roll's width — and all three landed on the
   * eyeball, which is 11.6 mm of radius and did not move at all.
   *
   * Measured on athlete 13 of the fourteen before this change: at 9 mm above the
   * pupil axis, 3 mm out, the cavity ran at full 4.8 mm depth and put the skin
   * **0.34 mm behind the globe**. That is a hole in the upper eyelid, and on the
   * shipped tessellation it opened into a crescent of bare sclera 4 mm tall
   * spanning the outer half of the lid — 8.5 % of the aperture, all of it above
   * the iris, i.e. precisely the startle display the aperture re-map exists to
   * abolish. It was invisible in the arithmetic because the arithmetic was all
   * in `qq`.
   *
   * So: anything whose subject is the EYEBALL — the lid shell that has to cover
   * it, the crease that has to clear it — is quoted in `gg`, the distance from
   * the eye's own centre in globe radii. `gg 1` is the limb of the globe by
   * construction, and it stays there whatever `eyeOpen` does. Anything whose
   * subject is the FISSURE — the aperture cut, the margin's peak, the canthus —
   * stays in `qq`, which is what those things actually track.
   */
  const gg = Math.hypot(ddx * hf.rx, nyT * hf.ry) / hf.eye.r;
  /**
   * THE UPPER LID IS A SHELL LYING ON THE GLOBE, AND THE ORBIT IS BEHIND IT.
   *
   * There is no eyelid in this sculpt — only a lid MARGIN — so the socket has to
   * be stopped from showing through where the tarsal plate belongs. The mask is
   * one everywhere over the globe, dies at `nyT = 0` so the globe-placement solve
   * (which samples the axis and the lower margin) cannot see it at all, and
   * releases at the globe's own silhouette, where by definition there is no
   * longer anything behind it to expose.
   *
   * The release used to be `smooth(2.50, 1.80, qq)`. In globe terms that is only
   * 0.76 of the way up the eyeball on the reference athlete and 0.72 on the
   * worst of the roster, so it uncovered the top quarter of the globe and let the
   * cavity straight through. Quoted against the globe it cannot do that again on
   * any athlete, at any `eyeOpen`, because it is the same statement as the thing
   * it is protecting.
   */
  const lidShell = clamp01(nyT / (hf.apU * 0.60)) * smooth(1.00, 0.88, gg);
  // Orbital cavity: a broad recess the brow overhangs. Centred ON the eye it
  // buried the upper lid and every athlete squinted; the cavity's deepest point
  // is above the globe, not on it — so it is centred on the SUB-BROW hollow.
  // Depth came down from 0.108 R: 8.5 mm of recess at the eye line puts both lid
  // margins that far behind the cheek, and a globe whose apex is level with the
  // cheek then stands 3 mm proud of its own lower lid. Which is what a bulging,
  // lidless, staring eye is.
  dz -= R * 0.070 * g1(nyT, 0.115, 0.185) * g1(ax, 0.400, 0.280) * fz * (1 - 0.90 * lidShell);
  // Tear trough / infraorbital groove under the lower lid. This one STAYS in
  // aperture units: `apD * 2.6` is 14 mm, which is below the globe's 11.6 mm
  // limb rather than on it, so it is the one aperture-quoted feature the re-map
  // moved in a safe direction. Measured contribution at the lower margin is
  // 0.6 mm and the skin there is 0.7–2.5 mm proud of the globe with it applied.
  dz -= R * 0.030 * g1(nyT, -hf.apD * 2.6, hf.apD * 1.5) * g1(ax, hf.eyeN * 0.78, 0.150) * fz;
  /**
   * Supratarsal crease, and the tarsal platform under it — both anchored to the
   * globe.
   *
   * On a live face the crease is where the levator aponeurosis inserts, 7–9 mm
   * above the lash line, which puts it within a millimetre of the top of the
   * globe: `gg` ≈ 1. Quoted at `qq 1.62` it tracked the fissure instead, so
   * halving the aperture walked it down from 10.5 mm to 5.7 mm above the pupil
   * axis — onto the superior limbus, 2.5–3.7 mm deep, directly cancelling the
   * lid-margin roll that is the only thing holding the lid in front of the eye.
   * On the two worst athletes it cut through: measured 0.03 mm and −0.31 mm of
   * clearance at the crease, i.e. tangent and through.
   *
   * It also has to sit outside the `qq < 3.2` block now, because at the new
   * anchor `qq` there runs to about 3.9 and the guard would simply delete it.
   */
  const cg = (gg - (1.02 + 0.26 * W.hood)) / (0.13 + 0.08 * W.hood);
  dz -= R * (0.046 - 0.022 * W.hood) * Math.exp(-cg * cg) * clamp01(nyT * 6.0) * fz
    * (1 - 0.90 * lidShell);
  if (qq < 3.2) {
    /**
     * The aperture: cut the skin back behind the corneal plane so the globe is
     * exposed over a real chord. A soft ramp here is what gave the first pass a
     * 12 mm slit in a 24 mm eye.
     *
     * DEPTH IS 0.090 R, DOWN FROM 0.155. The old 12 mm was chosen to guarantee
     * exposure and it guaranteed rather more than that: there is no 12 mm void
     * behind a human eyelid, the conjunctival fornix is a couple of millimetres
     * behind the globe, and the extra ten were pure margin. They were not free.
     * The mesh carries this on a 4 mm row pitch, so between the row that lands
     * inside the cut and the row that lands on the lid the surface is a straight
     * chord — and the deeper the cut, the further that chord has to climb and the
     * further past the true edge it crosses the globe. Measured over the roster,
     * on the shipped tessellation:
     *
     *     cut     upper lid over iris     iris+pupil / aperture
     *     0.155     0.78 – 1.17 mm             39.4 – 41.9 %
     *     0.110     0.87 – 1.44 mm             41.7 – 44.8 %
     *     0.090     0.95 – 1.53 mm             43.2 – 46.8 %
     *     0.070     1.04 – 1.72 mm             45.1 – 49.3 %
     *
     * Monotone, and it is the single largest lever on the section-4 iris
     * fraction that does not involve touching `irisR` or the row budget. It runs
     * out below 0.090 for a reason that is not sampling: near the canthi the
     * globe is nearly tangent to the view, so a shallow cut stops exposing it at
     * all and the fissure narrows — 20.7 mm delivered at 0.070 against 23.8 mm
     * at 0.090, on a 28 mm design. 0.090 is where the two curves cross.
     */
    dz -= R * 0.090 * smooth(1.14, 0.80, qq) * fz;
    /**
     * Lid margins — a rolled edge just outboard of the aperture, thicker above,
     * and both of them proud of the skin around them.
     *
     * THE OUTBOARD SIDE IS A PLATE, NOT A BEAD, AND THE REASON IS SAMPLING.
     * `buildHead` evaluates this surface on an 87 × 71 lat-long grid; at the eye
     * line — the densest latitude on the head, because `warpV` clusters there —
     * that is a 4.0 mm row pitch at `ultra` and 6.3 mm at `low`. At the old
     * width the roll was a Gaussian of 0.68 mm sigma: five times finer than the
     * grid that has to carry it, so no vertex ever landed on it and the mesh
     * interpolated a straight chord from a row deep inside the aperture cut to a
     * row up on the brow. Measured on the shipped tessellation, that chord put
     * the delivered aperture top 1.3 mm higher and the bottom 2.9 mm lower than
     * the sculpt asks for — 3.5 mm of extra fissure, which is the entire lid
     * coverage this round is fighting for, handed back by the sampler.
     *
     * Widening it is not a cheat for the mesh's benefit either: the tarsal plate
     * IS 8–10 mm of firm tissue standing proud of the globe, and a 0.7 mm bead
     * was the wrong model of an eyelid before it was too small to render. The
     * peak stays exactly at `qq 1.15` — the globe-placement solve samples that
     * point, so moving it would move the cornea — and the inboard flank keeps
     * its 0.17, which is what holds the aperture edge crisp.
     *
     * The outboard sigma is quoted in globe radii so it is the same 2 mm of real
     * tissue above and below, rather than 2 mm above and 3 mm below, which is
     * what quoting it in `qq` would give (`apU` and `apD` differ by 1.6x).
     */
    const perGlobe = hf.eye.r / (nyT > 0 ? hf.apU * hf.ry : hf.apD * hf.ry);
    const mUp = nyT > 0 ? 1.0 : 0.62;
    const mk = (qq - 1.15) / (qq > 1.15 ? Math.max(0.17, 0.175 * perGlobe) : 0.17);
    dz += R * 0.052 * mUp * Math.exp(-mk * mk) * fz;
    // Epicanthic / medial canthus — the inner corner sits deeper than the outer
    // one on every face. Stays in `qq`: its subject is the corner of the fissure.
    const kk = (qq - 1.0) / 0.55;
    dz -= R * 0.030 * Math.exp(-kk * kk) * smooth(hf.eyeN * 0.55, hf.eyeN * 0.05, ax) * fz;
  }
  return dz;
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
  // Halved, from 0.058 + 0.048·(1 − cheek). At the old depth this was 6.3 mm of
  // sculpted hollow under the cheekbone, and the paint layer then carries the
  // same concavity twice more (a cavity lobe and a flush lobe painting the same
  // patch red-brown). Three punishments of one hollow is the whole of the
  // "gaunt / injured" read; the bone is not the problem and the proportion
  // ladder above is anthropometric, so the subtraction happens here rather than
  // in the skull.
  d -= R * (0.030 + 0.024 * (1 - F.cheek)) * g1(ny, -0.480, 0.135) * g1(ax, 0.520, 0.190) * f1;
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
    // Projection came down from 0.130 + 0.115. That was measured as if it were
    // the alar-base-to-tip distance, but it is added on top of an ellipsoid that
    // is ALREADY curving forward through the mid-face, so the two compounded:
    // the reference athlete — whose `nose` parameter is 0.50, dead centre —
    // rendered a dorsum that dominated every crop and hung over the upper lip.
    const proj = R * (0.108 + 0.098 * F.nose);
    out.z += proj * ridge * g1(nx, 0, wD) * f1;
    // Dorsal hump / scoop. One number, and it is most of what separates a
    // Roman nose from a snub one.
    out.z += R * 0.022 * W.hook * g1(ny, (NT + 0.085), 0.060) * g1(nx, 0, wD * 1.1) * f1;
    // Supratip break, then the lobule proper: a ball wider than the dorsum,
    // standing further forward than anything else on the face.
    out.z -= R * 0.020 * g1(ny, NT + 0.068, 0.030) * g1(nx, 0, wD * 0.9) * f1;
    const lob = g1(ny, NT, 0.048) * g1(nx, 0, 0.082 + 0.024 * F.noseW);
    out.z += R * (0.044 + 0.040 * F.nose) * lob * f1;
    // Ptosis of the tip. 0.060 R is 4.7 mm of droop applied on top of a lobule
    // that already projects 15 mm, and the pair read as a beak hanging over the
    // mouth — the nose finished level with the upper lip instead of 20 mm above
    // it. A nasal tip does drop, but by a couple of millimetres, and only on the
    // aquiline end of the range.
    out.y -= R * 0.026 * lob * f1 * (0.35 + 0.65 * clamp01(W.hook));
    // Alae. Radial, not axial: a nostril wing wraps the cheek. Kept NARROW in
    // ny — at a 0.050 half-width the wing spanned 11 mm vertically and spread
    // out onto the cheek as a soft pad rather than sitting as a wing with a
    // crease behind it.
    const ala = g1(ny, NT - 0.048, 0.034) * g1(ax, alaX, 0.044) * clamp01(nz * 1.6 - 0.20);
    d += R * (0.048 + 0.044 * F.noseW) * ala;
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
  out.z += orbitDz(hf, W, nx, ny, nz);

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
  //
  // THE ROW BUDGET IS THE LID CONTROL, NOT `apU`. This is the finding of the
  // round and it took a parameter sweep to see, because it is invisible in the
  // sculpt: `faceSurface` puts the lid margin wherever `apU` says, but what
  // SHIPS is that surface sampled on `hv` rows, and the delivered margin is
  // where a straight chord between two of those rows crosses the globe. At
  // `1.40` the row pitch at the eye line is 3.6 mm at `ultra` and 4.9 mm at
  // `low`, against a 10 mm fissure — the palpebral aperture is **two rows tall**
  // — so the delivered aperture top is quantised to the row grid and moves in
  // 4–5 mm steps while `apU` moves in tenths. Measured over the fourteen-player
  // roster at the four shipped `charDetail` tiers, sweeping the `apU` constant
  // from 0.06 to 0.26 in steps of 0.01 (`tools/_lidgeo.mjs`, `APU_C=`), worst
  // upper-lid coverage over iris:
  //
  //     apU const   0.06   0.10   0.14   0.18   0.22   0.26
  //     hv × 1.40  -0.63  +0.02  -0.32  -0.43  -0.46  -0.30   mm
  //     hv × 1.85  +2.13  +1.16  +1.32  +1.04  +0.35  -0.32   mm
  //
  // The 1.40 row is not a curve, it is noise: every value in it leaves sclera
  // above the iris on some athlete at some tier, including the two that happen
  // to read zero at the sample points, and the sign flips between neighbouring
  // steps. That is aliasing, and no choice of `apU` fixes it — which is exactly
  // how six rounds of "correct" lid arithmetic shipped as a startled stare.
  //
  // 1.85 puts 94 rows on the hero head, a 2.7 mm pitch at the eye line, and the
  // aperture becomes 3.5–4 rows tall. Coverage is then positive on all fourteen
  // athletes at all four tiers with 1.0 mm to spare at the worst, and the whole
  // 0.10–0.20 band of `apU` passes rather than none of it. It costs about 4 k
  // triangles on a LOD drawn inside eight metres, against 15.8 M in the frame.
  // The mouth gets the same dividend for free: its row pitch goes 4.9 → 3.7 mm.
  //
  // AND LOD 1 NEEDS THE SAME MEDICINE, BECAUSE LOD 1 IS WHERE THE GAME IS.
  // `LOD_DISTANCE` in `PlayerRig.ts` is `[0, 7.5, 24]`, so LOD 0 is the portrait
  // and the pause menu and LOD 1 is *every gameplay camera*: the 12 m
  // celebration, the whole tele broadcast, all fourteen athletes for ~100 % of
  // play. It carries `face: true` and `eyes: true`, and at its stock 23 × 19 the
  // row pitch at the eye line is ~12 mm against a 10 mm fissure — the aperture
  // is UNDER ONE ROW. Measured on the delivered mesh over the fourteen-player
  // roster (`tools/_lidgeo.mjs --tess` with the LOD-1 grid), at `low`:
  //
  //                        aperture height   upper lid over iris   sclera above iris
  //     23 × 19 (stock)     18.6 – 20.5 mm    −5.01 … −3.60 mm      13.6 – 18.1 %
  //     40 × 72 (this)       9.4 – 11.2 mm    −0.60 … +3.25 mm       0.0 –  3.0 %
  //
  // Read the middle column: at the shipped LOD 1 the upper lid margin lands four
  // to five millimetres ABOVE the iris on every athlete on the roster, which is
  // the startle display this entire round exists to abolish, delivered at every
  // distance anyone actually plays at. The closeup was fixed; the game was not.
  //
  // BOTH AXES MOVE, and that was not obvious. Rows alone stall at ~5 % sclera
  // above the iris no matter how many you add (V × 1.40 / 1.50 / 1.60 all sit at
  // 5.2 – 5.8 % at `charDetail 1`) because the residue is at the CANTHI, where
  // the globe is nearly tangent to the view and the quantiser is the column grid
  // — 21 columns to carry a 22 mm fissure. Taking U from 21 to 35 drops the same
  // number to zero with the rows unchanged. Whichever axis is coarser is the one
  // that owns the error.
  //
  // The cost is the honest objection and it is small: the LOD-1 head goes 874 →
  // 5 760 triangles, so fourteen athletes cost ~68 k against 15.8 M in the frame
  // (0.4 %), on a mesh that starts at 7.5 m where the head is still ~110 px. The
  // grid is deliberately NOT LOD 0's — 40 × 72 against 87 × 94 — because it only
  // has to resolve the fissure, not the nostril sill.
  //
  // AND THE ROW COUNT MUST BE EVEN. This is the last five per cent of the round
  // and it is the difference between "measured clean at the four tiers I tried"
  // and a guarantee.
  //
  // `sphereish` lays rows at `mapV(iy / sv)` and `mapV` — `t + wv·sin(2πt)/2π`
  // — is symmetric about `t = 0.5`. The eye line is `ny = 0`, i.e. `phi = π/2`,
  // i.e. exactly `v = 0.5`. So an EVEN `sv` puts a vertex row precisely on the
  // pupil axis and steps outward from it symmetrically; an ODD one straddles it,
  // with the nearest rows half a pitch either side. At LOD 0 the pitch is 2.7 mm
  // and the half-step does not matter. At LOD 1 the pitch is 4–5 mm, the whole
  // upper-lid coverage budget is 1.5–2.5 mm, and the half-step is the budget.
  //
  // Swept over a 28-athlete roster at the LOD-1 grid, `hu` 40, worst upper-lid
  // coverage over the iris and worst sclera-above-iris, by row count:
  //
  //     hv    55     56     57     58     59     60     61     62     63
  //     mm  -0.37  +1.65  -0.43  +1.82  -0.26  +1.99  -0.17  +2.17  +0.00
  //      %   0.51   0.00   0.43   0.00   0.42   0.00   0.24   0.00   0.00
  //     hv    65     66     67     68     70     71     72     80
  //     mm  +0.09  +2.43  +0.26  +2.47  +2.60  +0.61  +2.68  +1.73
  //      %   0.00   0.00   0.00   0.00   0.00   0.00   0.00   0.00
  //
  // Every odd row count either fails outright or passes with a tenth of the
  // coverage; every even one lands in the brief's 1.5–2.5 mm band. It is a
  // perfect two-cycle, not a trend, which is exactly what a phase artefact looks
  // like — and it is why sweeping `apU` against a fixed grid produced a table of
  // noise. Round it to even and the aliasing is not tuned around, it is gone.
  //
  // Unrounded, the multipliers give LOD-1 rows of 53 / 57 / 65 / 72 at the four
  // `charDetail` tiers — two of the four odd, and `charDetail 0.75` (the shipped
  // `medium` tier) measured 3.0 % of its aperture as sclera above the iris,
  // which is the startle display this round exists to abolish, shipping at the
  // LOD that carries every gameplay camera. Evened, they are 54 / 58 / 66 / 72
  // and all four read 0.000 %.
  //
  // LOD 2 is left alone: it carries `face: false, eyes: false`, so it has no
  // aperture and no globe to leave sclera above.
  const even = (n: number) => n + (n & 1);
  const hu = d.level === 0 ? Math.round(d.headU * 1.55)
    : d.level === 1 ? Math.round(d.headU * 1.75) : d.headU;
  const hv = d.level === 0 ? even(Math.round(d.headV * 1.85))
    : d.level === 1 ? even(Math.round(d.headV * 3.80)) : d.headV;
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
  // DEPTH[0] IS THE ATTACHMENT, AND IT HAS TO BE BURIED IN THE SKULL.
  //
  // The loft is built `capStart: false`, so ring 0 is an open boundary — a hole
  // straight into the ear's interior, whose far side is backfacing and therefore
  // culled. At 0.00 that hole sat on the plane x = 0.965·rx, and the skull is
  // nowhere near that wide below the ear: measured against the finished surface,
  // ring 0 stood OUTSIDE the head over 47–70 % of its circumference on every one
  // of the fourteen athletes, by up to 6.2 mm under the lobe. That is the
  // background visible through the head silhouette behind the ear, and it is
  // most of the "detached flap" read — an ear you can see daylight around is not
  // attached to anything.
  //
  // −0.55 sinks the ring 10.3 mm medially, which clears the skull by 2.1 mm on
  // the worst athlete of the roster and 5.3 mm on the hero. A ring strictly
  // inside a closed opaque surface cannot be seen through from ANY yaw, which is
  // why this is a burial and not a fitted offset. It also costs nothing in
  // silhouette: the ear's outline is rings 1–3 and they have not moved. What it
  // buys besides the hole is a 10–15 mm root ramp from the skull out to the
  // helix and the lobe, which is what an auricle actually attaches with.
  const DEPTH = [-0.55, 0.10, 0.02, -0.16, -0.34, -0.46, -0.44];

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
 *
 * EACH GLOBE IS SKINNED TO ITS OWN JOINT, not to the head. Bound to the head
 * the optical axis is welded to head-forward — the two eyes are permanently
 * parallel, permanently aimed wherever the skull is aimed, and the only framing
 * that can see an iris is one the head happens to be pointed at. The joints are
 * at `EYE_BONE`, they sit exactly on these globe centres (see
 * `Skeleton.ts buildSkeleton`), and `Animator.poseEyes` converges them.
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
    }, () => sk1(EYE_BONE[si]), { part: PART.EYE, side: SIDES[si], flip: true });
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

/**
 * Shell lift over the skull, in units of `headR`.
 *
 * These came down by about 40 %. At 0.155 a `crop` put 12 mm of shell on the
 * skull before the crown-volume multiplier, and that multiplier peaks near 1.9,
 * so the silhouette gained 23 mm on top of a 234 mm head — a tenth of a head
 * height of hair, which reads as a swim cap AND is a large part of why the
 * roster's heads look oversized. A crop is 15–20 mm of hair lying flat, and it
 * only stands proud at the crown.
 */
const HAIR_THICK: Record<string, number> = {
  buzz: 0.022, short: 0.052, crop: 0.092, ponytail: 0.066, bun: 0.072, long: 0.086, locs: 0.098,
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
    let vol = 1 + 0.22 * clamp01(ny) - 0.20 * Math.abs(nx);
    // Three harmonics of lift. Without them the cap is a moulded swim cap, which
    // is exactly what the first pass looked like — a mass of hair has a lumpy
    // outline even when it is short. The phases are per-athlete so two players
    // with the same cut do not part their hair identically.
    //
    // They have to DIE AT THE POLE. `sphereish` collapses every azimuth onto one
    // vertex at the crown, so an azimuthal harmonic evaluated there is
    // multi-valued: the pole vertex takes whatever u = 0 gave it while the ring
    // below takes the full range, and the mesh pulls into a spike or a dimple.
    // Every athlete had a visible pucker in the middle of the crown, which is
    // the first thing an overhead broadcast angle sees.
    const ph = h01(seed, 307) * 6.283;
    const polar = Math.min(1, phi / 0.42);
    vol *= 1 + polar * (0.20 * Math.cos(thz * 3 + 0.7 + ph) * (0.4 + 0.6 * v)
      + 0.12 * Math.cos(thz * 5 - 1.4 + ph * 0.7)
      + 0.09 * Math.cos(v * 7.3 + thz * 2 + ph));
    // …and a much finer, per-athlete radial jitter on top of them.
    //
    // Three harmonics at 3, 5 and 2 lobes describe a HEAD SHAPE, not a haircut:
    // the shell keeps a smooth, twice-differentiable outline, and a lat-long
    // grid over a smooth surface of revolution renders its own columns as a set
    // of evenly spaced vertical ribs — which is the corduroy the last review
    // read on every crown in the roster. These sit at 11–29 lobes, which is
    // about a lock apiece and close to the rate the strand map in
    // material/Hair.ts runs at, so the ribbing is broken at the scale the
    // shading is already varying at rather than at the scale of the skull.
    // Amplitudes are quoted against the SHELL THICKNESS, which is 8 mm on a
    // crop — so a 5 % jitter is 0.4 mm and cannot be seen at any framing. These
    // sum to ±0.34, i.e. ±2.7 mm of lump on a 234 mm head: about four pixels on
    // the hero crop, which is the smallest thing that reads as a lock.
    let jit = 0;
    for (let k = 0; k < 3; k++) {
      const f = 11 + k * 9;
      jit += Math.cos(thz * f + h01(seed, 411 + k * 17) * 6.283) * (0.16 - k * 0.045);
    }
    // Locks lie tighter at the crown and fan out toward the ends, so the jitter
    // grows down the shell — and it has to die at the pole for the same reason
    // the harmonics above do (one vertex, many azimuths).
    vol *= 1 + polar * jit * (0.35 + 0.65 * v);
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
