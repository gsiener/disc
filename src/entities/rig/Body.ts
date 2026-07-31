import * as THREE from 'three';
import { PART, GROUP } from './Types.ts';
import type { BoneName } from './Types.ts';
import { SIDES, SIDE_SUFFIX, bi } from './Skeleton.ts';
import type { Anthro } from './Skeleton.ts';
import {
  RigMesh, V, ellipse, lobe, sk1, sk2, skN, skMix, smooth, lerp, clamp01,
} from './Build.ts';
import type { Ring, Skin, Vec3, Lobe, Profile } from './Build.ts';

/**
 * Torso, neck, arms and legs — the skinned body surface.
 *
 * Everything here is a loft, and the interesting content is (a) the radial
 * profiles, which is where deltoid, pec, lat, scapula, quad and calf volume
 * comes from, and (b) the weight ramps at the four joints that actually bend.
 *
 * JOINT WEIGHTS. The blend band across a joint is *asymmetric by angle*. On the
 * elbow the anterior side (the crease) hands over inside 22 mm so the fold is
 * sharp; the posterior side (the olecranon) hands over across 75 mm so the
 * point of the elbow rides the bend instead of shearing through it. The knee is
 * the same idea mirrored — narrow behind, wide across the patella. This is the
 * only thing standing between a 130-degree arm and a pinched paper bag, and it
 * is why the twist bones exist at all.
 */

export interface DetailSpec {
  /** 0 = hero, 1 = mid, 2 = far. */
  level: 0 | 1 | 2;
  torsoSegs: number;
  limbSegs: number;
  torsoRings: readonly number[];
  armRings: readonly number[];
  legRings: readonly number[];
  headU: number;
  headV: number;
  fingers: boolean;
  face: boolean;
  ears: boolean;
  eyes: boolean;
  hairCards: boolean;
  clothFold: boolean;
}

const scaleInt = (n: number, d: number, min: number) => Math.max(min, Math.round(n * d));

export function detailFor(level: 0 | 1 | 2, charDetail: number): DetailSpec {
  const d = clamp01(charDetail / 1.35) * 0.55 + 0.72; // 0.72 .. 1.27
  if (level === 0) {
    return {
      level, torsoSegs: scaleInt(24, d, 14), limbSegs: scaleInt(16, d, 10),
      // Extra loops at u > 0.86 — the trapezius ramp out to the acromion is the
      // steepest part of the whole torso and three rings across it facets.
      torsoRings: [-0.21, -0.12, -0.04, 0.05, 0.14, 0.24, 0.34, 0.44, 0.54, 0.64, 0.73, 0.81, 0.865, 0.905, 0.938, 0.965, 0.985, 1.0, 1.006, 1.013, 1.021],
      // Six loops across the deltoid cap (q < 0). Three was a chamfer.
      armRings: [-0.335, -0.305, -0.265, -0.215, -0.155, -0.088, -0.015, 0.10, 0.24, 0.40, 0.56, 0.72, 0.855, 0.945, 1.0, 1.055, 1.14, 1.27, 1.42, 1.58, 1.74, 1.88, 1.985],
      legRings: [-0.16, -0.04, 0.08, 0.22, 0.36, 0.50, 0.64, 0.78, 0.90, 0.955, 1.0, 1.045, 1.11, 1.22, 1.36, 1.52, 1.70, 1.86, 1.97],
      headU: scaleInt(44, d, 30), headV: scaleInt(40, d, 26),
      fingers: true, face: true, ears: true, eyes: true, hairCards: true, clothFold: true,
    };
  }
  if (level === 1) {
    return {
      level, torsoSegs: scaleInt(14, d, 10), limbSegs: scaleInt(10, d, 7),
      torsoRings: [-0.21, -0.06, 0.09, 0.25, 0.41, 0.57, 0.72, 0.85, 0.925, 0.97, 1.0, 1.012, 1.021],
      armRings: [-0.335, -0.28, -0.19, -0.09, 0.02, 0.25, 0.55, 0.82, 1.0, 1.16, 1.38, 1.60, 1.82, 1.985],
      legRings: [-0.16, 0.06, 0.30, 0.55, 0.80, 1.0, 1.18, 1.42, 1.66, 1.88, 1.97],
      headU: scaleInt(18, d, 12), headV: scaleInt(15, d, 10),
      fingers: false, face: true, ears: false, eyes: true, hairCards: false, clothFold: true,
    };
  }
  return {
    level, torsoSegs: scaleInt(9, d, 7), limbSegs: scaleInt(6, d, 5),
    torsoRings: [-0.21, 0.02, 0.28, 0.56, 0.82, 0.95, 1.0, 1.021],
    armRings: [-0.335, -0.22, -0.06, 0.20, 0.65, 1.0, 1.40, 1.78, 1.985],
    legRings: [-0.16, 0.25, 0.65, 1.0, 1.35, 1.70, 1.97],
    headU: scaleInt(9, d, 7), headV: scaleInt(7, d, 6),
    fingers: false, face: false, ears: false, eyes: false, hairCards: false, clothFold: false,
  };
}

/* ------------------------------------------------------------- curve util */

export type Key = readonly [number, number];

/** Smoothstep-interpolated keyframe curve. Reads like an artist's slider. */
export function curve(keys: readonly Key[]): (x: number) => number {
  return (x: number) => {
    if (x <= keys[0][0]) return keys[0][1];
    const last = keys[keys.length - 1];
    if (x >= last[0]) return last[1];
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i], b = keys[i + 1];
      if (x <= b[0]) return lerp(a[1], b[1], smooth(a[0], b[0], x));
    }
    return last[1];
  };
}

/* ------------------------------------------------------------------ torso */

/** u = 0 at the hip joint line, 1 at the neck base; negative runs into the seat. */
export function torsoCentre(a: Anthro, u: number): Vec3 {
  const y = a.hipY + u * a.torsoSpan;
  // The trunk's volumetric centre leans very slightly forward of the pelvis and
  // the lumbar hollow pulls the waist back — a straight vertical axis reads as
  // a barrel on legs.
  //
  // Above the clavicles it comes BACK. The cross-section there is the root of
  // the neck, which sits over the spine, not 3.6 cm in front of it. Carrying
  // the chest's forward lean to the top ring left the torso's last loop —
  // and the jersey's — projecting 4 cm ahead of the neck loft, which renders as
  // a horizontal ledge running shoulder to shoulder above the chest.
  const z = a.H * (0.004 + 0.020 * smooth(0.15, 0.75, u)
    - 0.014 * lobe(u * 0.5 + 0.25, 0.40, 0.16)
    - 0.030 * smooth(0.84, 1.0, u));
  return V(0, y, z);
}

export function torsoProfile(a: Anthro, u: number): Profile {
  const g = a.g;
  const p = a.p;
  const mus = p.muscle, fat = p.fat, fr = p.frame;
  const wa = curve([
    [-0.21, g.hipA * 0.86], [-0.08, g.hipA * 1.00], [0.03, g.hipA * 0.985],
    [0.30, g.waistA], [0.50, lerp(g.waistA, g.chestA, 0.42)],
    [0.70, g.chestA * 0.99], [0.80, g.chestA], [0.90, g.chestA * 0.955],
    // Past u = 1 the loft is no longer the trunk: it is the shoulder ridge
    // curving over from the acromion onto the neck. It has to close to inside
    // the neck loft's own radius, because whatever the torso leaves open at the
    // top is a hole you can see straight down into from any camera above chest
    // height — which is every camera in this game.
    [0.965, g.chestA * 0.72], [1.0, g.neckA * 0.98], [1.03, g.neckA * 0.90],
  ])(u);
  const wb = curve([
    [-0.21, g.hipB * 0.90], [-0.08, g.hipB * 1.02], [0.03, g.hipB * 0.98],
    [0.30, g.waistB], [0.50, lerp(g.waistB, g.chestB, 0.50)],
    [0.70, g.chestB * 0.99], [0.80, g.chestB], [0.90, g.chestB * 0.93],
    [0.965, g.chestB * 0.76], [1.0, g.neckB * 1.02], [1.03, g.neckB * 0.92],
  ])(u);

  const lobes: Lobe[] = [];
  // Glutes — a rearward mass below the hip line, plus the sacral dimple gap.
  const glute = smooth(0.10, -0.16, u);
  if (glute > 0.01) lobes.push({ at: 0.75, w: 0.20, amp: 0.16 * glute * (0.7 + 0.5 * mus) });
  // Pectorals: two lobes either side of the sternum, strongest at u ≈ 0.76.
  const pec = smooth(0.56, 0.74, u) * smooth(0.95, 0.82, u);
  if (pec > 0.01) {
    const amp = pec * (0.055 + 0.075 * mus + 0.10 * fr);
    lobes.push({ at: 0.190, w: 0.062, amp });
    lobes.push({ at: 0.310, w: 0.062, amp });
    lobes.push({ at: 0.250, w: 0.026, amp: -amp * 0.62 });
  }
  // Linea alba + rectus blocking on a lean midsection.
  const abs = smooth(0.20, 0.34, u) * smooth(0.66, 0.52, u) * (1 - fat) * (0.4 + 0.6 * mus);
  if (abs > 0.01) {
    lobes.push({ at: 0.250, w: 0.030, amp: -0.055 * abs });
    lobes.push({ at: 0.195, w: 0.045, amp: 0.030 * abs });
    lobes.push({ at: 0.305, w: 0.045, amp: 0.030 * abs });
  }
  // Soft belly for the higher-fat end of the roster.
  if (fat > 0.05) {
    const belly = smooth(0.02, 0.22, u) * smooth(0.62, 0.40, u) * fat;
    if (belly > 0.01) lobes.push({ at: 0.25, w: 0.16, amp: 0.13 * belly });
  }
  // Latissimus flare — pushes the lower-outer ribcage back and out.
  const lat = smooth(0.42, 0.62, u) * smooth(0.94, 0.78, u) * (0.35 + 0.65 * mus);
  if (lat > 0.01) {
    lobes.push({ at: 0.545, w: 0.075, amp: 0.075 * lat });
    lobes.push({ at: 0.955, w: 0.075, amp: 0.075 * lat });
  }
  // Scapulae and the spinal furrow between them.
  const scap = smooth(0.62, 0.80, u) * smooth(1.0, 0.88, u);
  if (scap > 0.01) {
    lobes.push({ at: 0.680, w: 0.055, amp: 0.055 * scap * (0.5 + 0.5 * mus) });
    lobes.push({ at: 0.820, w: 0.055, amp: 0.055 * scap * (0.5 + 0.5 * mus) });
  }
  const furrow = smooth(0.20, 0.45, u) * smooth(1.0, 0.90, u);
  if (furrow > 0.01) lobes.push({ at: 0.750, w: 0.030, amp: -0.050 * furrow });
  // Trapezius. The top rings must ramp laterally all the way OUT TO THE
  // ACROMION, not to the glenohumeral centre and not to 55 % of it: whatever
  // gap is left between the trapezius and the deltoid has to be bridged by the
  // jersey, and the jersey bridges it with a flat plate. That plate is the
  // shoulder facet. Targeting 0.97 of the acromion closes the gap in geometry
  // so no garment has to.
  // …and then release, over 2 cm of height, so the ridge rolls over the top of
  // the shoulder and closes onto the neck instead of ending in an open rim.
  const trap = smooth(0.84, 0.99, u) * smooth(1.022, 0.999, u);
  if (trap > 0.01) {
    const amp = trap * (a.acromionHalf * 0.97 / Math.max(1e-4, wa) - 1);
    lobes.push({ at: 0.0, w: 0.150, amp });
    lobes.push({ at: 0.5, w: 0.150, amp });
  }
  return ellipse(wa, wb, lobes, u > 0.1 && u < 0.6 ? 2.25 : 2.05);
}

const CHAIN: readonly BoneName[] = ['pelvis', 'spine01', 'spine02', 'spine03', 'chest'];
const CHAIN_U = [0, 0.20, 0.42, 0.64, 0.84, 1.0];

export function torsoSkin(a: Anthro, u: number, t: number): Skin {
  let base: Skin;
  if (u <= 0) base = sk1(bi('pelvis'));
  else if (u >= 1) base = sk2(bi('chest'), 0.84, bi('neck'), 0.16);
  else {
    let k = 0;
    while (k < CHAIN.length - 1 && u > CHAIN_U[k + 1]) k++;
    const f = smooth(CHAIN_U[k], CHAIN_U[k + 1], u);
    base = sk2(bi(CHAIN[k]), 1 - f, bi(CHAIN[Math.min(k + 1, CHAIN.length - 1)]), f);
  }
  // Shoulder corners follow the clavicle so a shrug or an arm swing carries the
  // trapezius with it instead of tearing a hole at the neckline.
  const top = smooth(0.80, 1.0, u);
  if (top > 0.001) {
    const lat = Math.cos(t * Math.PI * 2);
    const w = top * Math.pow(Math.abs(lat), 1.6) * 0.62;
    if (w > 0.005) {
      const cl = lat > 0 ? bi('clavicle_L') : bi('clavicle_R');
      return skMix(base, sk1(cl), w);
    }
  }
  // The hip ring has to follow the femurs a little or the shorts crease dies.
  if (u < 0.06) {
    const lat = Math.cos(t * Math.PI * 2);
    const w = smooth(0.06, -0.20, u) * clamp01(Math.abs(lat)) * 0.42;
    if (w > 0.005) {
      const th = lat > 0 ? bi('thigh_L') : bi('thigh_R');
      return skMix(base, sk1(th), w);
    }
  }
  return base;
}

export function buildTorso(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const rings: Ring[] = d.torsoRings.map((u) => {
    const prof = torsoProfile(a, u);
    return {
      o: torsoCentre(a, u),
      ax: V(1, 0, 0), az: V(0, 0, 1),
      r: prof,
      skin: torsoSkin(a, u, 0),
      skinAt: (t: number) => torsoSkin(a, u, t),
      v: clamp01((u + 0.21) / 1.21),
      crease: (t: number) => {
        // Armpit hollow, the crease under the pec, and the sacral dimples.
        const pit = smooth(0.80, 0.94, u) * smooth(1.02, 0.95, u)
          * Math.max(lobe(t, 0.05, 0.075), lobe(t, 0.45, 0.075));
        const underPec = smooth(0.50, 0.62, u) * smooth(0.72, 0.62, u)
          * (lobe(t, 0.19, 0.055) + lobe(t, 0.31, 0.055)) * 0.55;
        const sacral = smooth(0.10, -0.02, u) * lobe(t, 0.75, 0.09) * 0.7;
        const groin = smooth(-0.02, -0.18, u) * lobe(t, 0.25, 0.10) * 0.85;
        return clamp01(pit + underPec + sacral + groin);
      },
    };
  });
  m.group(GROUP.skin).loft(rings, d.torsoSegs, {
    part: PART.TORSO, side: 0, capStart: true, capEnd: false,
  });
}

/* ------------------------------------------------------------------- neck */

/**
 * THE NECK COLUMN.
 *
 * A neck is not a cylinder with a head balanced on it — that reads as a doll
 * from any distance, and it is the second half of "the head is too large".
 * What makes it read as a neck is one landmark: the sternocleidomastoid, a
 * paired cord that leaves the mastoid (behind and below the ear, well lateral)
 * and runs forward and down to the clavicular notch on the midline. So the two
 * lobes MIGRATE in azimuth as they descend — ±47° of the front at the jaw,
 * ±19° at the notch — instead of sitting at a fixed ±30° like two pipes.
 *
 * The notch itself is a negative lobe between the two clavicular heads, and it
 * is the landmark the jersey's collar is now cut to expose.
 */
export function buildNeck(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const g = a.g;
  const fr = a.p.frame;
  const base = V(0, a.neckBaseY - a.H * 0.034, -a.H * 0.010);
  // The neck stops *inside* the head's funnel, never level with it — see
  // FUNNEL_R in Head.ts. Two coincident tubes is the failure mode here.
  const top = V(0, a.chinY + a.g.headH * 0.22, -a.H * 0.005);
  const segs = Math.max(10, Math.round(d.torsoSegs * 0.70));
  const N = d.level === 0 ? 9 : d.level === 1 ? 5 : 3;
  const bell = (x: number, c: number, w: number) => {
    const z = (x - c) / w;
    return Math.exp(-z * z);
  };
  const rings: Ring[] = [];
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    const o = V(lerp(base.x, top.x, u), lerp(base.y, top.y, u), lerp(base.z, top.z, u));
    const w = curve([[0, 1.62], [0.20, 1.16], [0.50, 1.0], [0.85, 0.985], [1.0, 1.02]])(u);
    const scm = smooth(0.02, 0.30, u) * smooth(1.04, 0.62, u);
    // Azimuth of each cord, in t units either side of the front midline (0.25).
    const sp = lerp(0.052, 0.131, smooth(0.04, 0.86, u));
    const lobes: Lobe[] = [
      { at: 0.25 - sp, w: 0.050, amp: 0.135 * scm },
      { at: 0.25 + sp, w: 0.050, amp: 0.135 * scm },
      // Suprasternal notch, between the two clavicular heads.
      { at: 0.25, w: 0.036, amp: -0.10 * smooth(0.30, 0.02, u) },
      // Thyroid prominence — small, and smaller still on the wider-hipped end
      // of a mixed roster.
      { at: 0.25, w: 0.052, amp: 0.052 * (1 - 0.65 * fr) * bell(u, 0.54, 0.15) },
      // Trapezius ridge running up the back of the neck.
      { at: 0.75, w: 0.115, amp: 0.020 + 0.075 * (1 - u) },
    ];
    rings.push({
      o, ax: V(1, 0, 0), az: V(0, 0, 1),
      r: ellipse(g.neckA * w, g.neckB * w, lobes),
      skin: sk2(bi('chest'), Math.max(0, 1 - u * 2.6), bi('neck'), Math.min(1, u * 2.6)),
      skinAt: (_t: number) => {
        const toHead = smooth(0.68, 1.0, u);
        const lower = sk2(bi('chest'), Math.max(0, 1 - u * 2.6), bi('neck'), Math.min(1, u * 2.6));
        return toHead > 0 ? skMix(lower, sk1(bi('head')), toHead * 0.85) : lower;
      },
      v: u,
      crease: (t: number) => clamp01(
        smooth(0.30, 0.0, u) * (0.30 + 0.40 * lobe(t, 0.75, 0.14))
        // Shadow either side of each cord, and in the notch.
        + 0.45 * scm * (lobe(t, 0.25, 0.030) + lobe(t, 0.25 - sp * 2.1, 0.045)
          + lobe(t, 0.25 + sp * 2.1, 0.045)),
      ),
    });
  }
  m.group(GROUP.skin).loft(rings, segs, { part: PART.NECK, side: 0 });
}

/* ------------------------------------------------------------------- arms */

/** Point on the arm chain. q ∈ [0,1] spans the humerus, [1,2] the forearm. */
function armPoint(a: Anthro, si: number, q: number): Vec3 {
  if (q <= 1) return a.shoulder[si].clone().addScaledVector(a.armDir[si], a.len.upperArm * q);
  return a.elbow[si].clone().addScaledVector(a.foreDir[si], a.len.foreArm * (q - 1));
}

function armDirAt(a: Anthro, si: number, q: number): Vec3 {
  if (q < 0.94) return a.armDir[si];
  if (q > 1.06) return a.foreDir[si];
  return a.armDir[si].clone().lerp(a.foreDir[si], smooth(0.94, 1.06, q)).normalize();
}

/** Signed arc distance along the chain, metres, measured from the shoulder. */
function armDist(a: Anthro, q: number): number {
  return q <= 1 ? q * a.len.upperArm : a.len.upperArm + (q - 1) * a.len.foreArm;
}

function armSkin(a: Anthro, si: number, q: number, t: number): Skin {
  const suf = SIDE_SUFFIX[si];
  const UA = bi(`upperArm${suf}` as BoneName);
  const UT = bi(`upperArmTwist${suf}` as BoneName);
  const FA = bi(`foreArm${suf}` as BoneName);
  const FT = bi(`foreArmTwist${suf}` as BoneName);
  const HA = bi(`hand${suf}` as BoneName);
  const CL = bi(`clavicle${suf}` as BoneName);

  // Deltoid cap — partly on the clavicle and the chest so a shoulder roll does
  // not shear the arm off the torso.
  if (q < 0.10) {
    const w = smooth(0.10, -0.34, q);
    return skN([[UA, 1 - w * 0.55], [CL, w * 0.36], [bi('chest'), w * 0.19]]);
  }
  const d = armDist(a, q);
  const elbowD = a.len.upperArm;
  const wristD = a.len.upperArm + a.len.foreArm;
  const H = a.H / 1.8;

  // Elbow: anterior (crease) hands over fast, posterior (olecranon) slow.
  const ant = 0.5 + 0.5 * Math.cos((t - 0.25) * Math.PI * 2);
  const hw = lerp(0.075, 0.022, ant) * H;
  const eb = smooth(elbowD - hw, elbowD + hw, d);

  let upper: Skin;
  if (q <= 0.20) upper = sk1(UA);
  else upper = sk2(UA, 1 - smooth(0.20, 0.72, q), UT, smooth(0.20, 0.72, q));

  let lower: Skin;
  const r = clamp01((d - elbowD) / Math.max(1e-4, a.len.foreArm));
  const tw = smooth(0.18, 0.86, r);
  lower = sk2(FA, 1 - tw, FT, tw);
  const toHand = smooth(0.90, 1.0, r) * 0.55;
  if (toHand > 0.004) lower = skMix(lower, sk1(HA), toHand);
  if (d > wristD - 1e-4) lower = sk2(FT, 0.45, HA, 0.55);

  return skMix(upper, lower, eb);
}

/** Chain parameter spanned by the deltoid cap above the glenohumeral centre. */
export const CAP_Q = 0.34;
/** Radians of quarter-arc the cap sweeps. Just short of 90° so the last ring
 *  still has area and the fan cap that closes it is a few millimetres across. */
const CAP_ARC = 1.46;

export interface ArmRing {
  o: Vec3; ax: Vec3; az: Vec3; dir: Vec3;
  /** Lateral and anteroposterior half-sizes. */
  ra: number; rb: number;
  lobes: Lobe[];
}

/**
 * THE ARM SURFACE, in one place, so the jersey sleeve can be a true parallel
 * offset of it rather than an independently-authored tube that has to be
 * inflated until it clears.
 *
 * That inflation was the shoulder facet. The old sleeve's proximal rings were
 * 1.34 × the deltoid radius, which put 4 cm of air between cloth and arm and
 * left a flat quadrilateral plate sitting above the deltoid with a hard crease
 * along its outer edge — visible in every `closeup` frame. `grow` is now the
 * only difference between the two surfaces, so the silhouette they share is the
 * arm's, offset by the thickness of a jersey.
 *
 * The cap above the joint (q < 0) is a quarter-arc, not a linear ramp: radius
 * falls as cos(θ) and the centre climbs as sin(θ) toward the acromion, so the
 * profile through the shoulder is a circle. The old cap moved its centre
 * linearly in k and swung its ring plane through a near-degenerate orientation
 * halfway up, which is a chamfer with three steps in it.
 */
export function armSurface(a: Anthro): (si: number, q: number, grow?: number) => ArmRing {
  const g = a.g;
  const D = g.deltoid, B = g.bicep, E = g.elbowR, F = g.foreMax;
  const rad = curve([
    [0.0, D * 1.00], [0.16, D * 0.93],
    [0.34, B * 1.12], [0.55, B * 1.03], [0.76, B * 0.88], [0.90, E * 1.12],
    [1.0, E * 1.02], [1.07, E * 1.06], [1.20, F * 0.98], [1.34, F * 1.00],
    [1.52, F * 0.82], [1.70, F * 0.62], [1.85, g.wristA * 1.12], [1.985, g.wristA],
  ]);
  const depth = curve([
    [-0.34, 1.00], [0.0, 1.02], [0.34, 1.10], [0.76, 1.06], [1.0, 1.00],
    [1.30, 1.02], [1.70, 0.90], [1.985, g.wristB / Math.max(1e-4, g.wristA)],
  ]);
  return (si: number, q: number, grow = 0): ArmRing => {
    const s = SIDES[si];
    let dir = armDirAt(a, si, q);
    let o = armPoint(a, si, q);
    let ra: number;
    if (q < 0) {
      const k = clamp01(-q / CAP_Q);
      const th = k * CAP_ARC;
      ra = (D + grow) * Math.pow(Math.max(0, Math.cos(th)), 0.72);
      // A HEMISPHERE ON THE HUMERUS. The ring plane never rotates — radius
      // falls as cos(θ), the centre advances as sin(θ) along the bone. That is
      // the only cap construction with no orientation to crease around; the
      // previous one lerped its ring plane toward horizontal and passed through
      // vertical halfway up, which is a fold wearing a dome's parameters.
      const rise = Math.sin(th);
      const capH = (D + grow) * 0.94;
      o = a.shoulder[si].clone().addScaledVector(dir, -capH * rise);
      // Sheared toward the acromion so the crown of the dome sits over the bony
      // point of the shoulder instead of up the humerus toward the neck. A
      // shear is smooth in k, so it costs nothing in continuity.
      o.add(V(
        s * (a.acromionHalf - Math.abs(a.shoulder[si].x)) * rise * 0.85,
        (a.acromionY - a.shoulderY) * rise * 0.30,
        -0.004 * a.H * rise,
      ));
    } else {
      ra = rad(q) + grow;
    }
    const az = V(0, 0, 1).addScaledVector(dir, -dir.z).normalize();
    const ax = new THREE.Vector3().crossVectors(dir, az);

    const lobes: Lobe[] = [];
    const bic = smooth(0.16, 0.40, q) * smooth(0.86, 0.60, q) * (0.35 + 0.65 * a.p.muscle);
    if (bic > 0.01) {
      lobes.push({ at: 0.25, w: 0.13, amp: 0.11 * bic });
      lobes.push({ at: 0.75, w: 0.17, amp: 0.09 * bic });
    }
    // Lateral head of the deltoid. Small: the mass is already in `g.deltoid`,
    // and a fat lobe on top of it is what took the shoulder to 0.30 H across.
    const delt = smooth(-0.34, -0.06, q) * smooth(0.34, 0.06, q);
    if (delt > 0.01) lobes.push({ at: si === 0 ? 0.5 : 0.0, w: 0.22, amp: 0.055 * delt });
    const ole = smooth(0.90, 1.02, q) * smooth(1.16, 1.02, q);
    if (ole > 0.01) lobes.push({ at: 0.75, w: 0.11, amp: 0.16 * ole });
    const flex = smooth(1.04, 1.24, q) * smooth(1.62, 1.32, q) * (0.4 + 0.6 * a.p.muscle);
    if (flex > 0.01) {
      lobes.push({ at: 0.25, w: 0.15, amp: 0.10 * flex });
      lobes.push({ at: si === 0 ? 0.0 : 0.5, w: 0.16, amp: 0.07 * flex });
    }
    return { o, ax, az, dir, ra, rb: ra * depth(q), lobes };
  };
}

export function buildArms(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const ring = armSurface(a);
  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];
    const rings: Ring[] = [];
    for (const q of d.armRings) {
      const R = ring(si, q);
      rings.push({
        o: R.o, ax: R.ax, az: R.az,
        r: ellipse(R.ra, R.rb, R.lobes),
        skin: armSkin(a, si, q, 0),
        skinAt: (t: number) => armSkin(a, si, q, t),
        v: clamp01((q + 0.34) / 2.325),
        crease: (t: number) => {
          const pit = smooth(0.18, -0.02, q) * lobe(t, si === 0 ? 0.10 : 0.40, 0.11) * 0.9;
          const elbowPit = smooth(0.86, 1.0, q) * smooth(1.16, 1.02, q) * lobe(t, 0.25, 0.10) * 0.8;
          return clamp01(pit + elbowPit);
        },
      });
    }
    m.group(GROUP.skin).loft(rings, d.limbSegs, {
      part: PART.UPPER_ARM, side: s, capStart: true, capEnd: false,
    });
  }
}

/* ------------------------------------------------------------------- legs */

/** q ∈ [0,1] spans the femur, [1,2] the tibia. */
function legPoint(a: Anthro, si: number, q: number): Vec3 {
  if (q <= 1) return a.hip[si].clone().addScaledVector(a.legDir[si], a.len.thigh * q);
  return a.knee[si].clone().addScaledVector(a.shinDir[si], a.len.shin * (q - 1));
}

function legDirAt(a: Anthro, si: number, q: number): Vec3 {
  if (q < 0.94) return a.legDir[si];
  if (q > 1.06) return a.shinDir[si];
  return a.legDir[si].clone().lerp(a.shinDir[si], smooth(0.94, 1.06, q)).normalize();
}

function legSkin(a: Anthro, si: number, q: number, t: number): Skin {
  const suf = SIDE_SUFFIX[si];
  const TH = bi(`thigh${suf}` as BoneName);
  const TT = bi(`thighTwist${suf}` as BoneName);
  const SH = bi(`shin${suf}` as BoneName);
  const FO = bi(`foot${suf}` as BoneName);
  const H = a.H / 1.8;

  if (q < 0.06) {
    const w = smooth(0.06, -0.16, q);
    return skN([[TH, 1 - w * 0.62], [bi('pelvis'), w * 0.62]]);
  }
  const d = q <= 1 ? q * a.len.thigh : a.len.thigh + (q - 1) * a.len.shin;
  const kneeD = a.len.thigh;
  // Popliteal crease (posterior) folds tight; the patella needs a wide band or
  // the kneecap shears straight through the skin on a hard drive step.
  const post = 0.5 + 0.5 * Math.cos((t - 0.75) * Math.PI * 2);
  const hw = lerp(0.070, 0.020, post) * H;
  const kb = smooth(kneeD - hw, kneeD + hw, d);

  const tw = smooth(0.22, 0.80, q);
  const upper = sk2(TH, 1 - tw, TT, tw);
  const r = clamp01((d - kneeD) / Math.max(1e-4, a.len.shin));
  let lower: Skin = sk1(SH);
  const toFoot = smooth(0.90, 1.0, r) * 0.7;
  if (toFoot > 0.004) lower = skMix(lower, sk1(FO), toFoot);
  return skMix(upper, lower, kb);
}

export function buildLegs(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const g = a.g;
  const rad = curve([
    [-0.16, g.thighA * 1.06], [0.02, g.thighA * 1.03], [0.20, g.thighA * 0.97],
    [0.45, g.thighA * 0.88], [0.70, g.thighA * 0.76], [0.88, g.kneeR * 1.06],
    [1.0, g.kneeR], [1.10, g.kneeR * 1.02], [1.24, g.calfA * 1.02],
    [1.36, g.calfA], [1.58, g.calfA * 0.74], [1.80, g.ankleA * 1.16], [1.97, g.ankleA],
  ]);
  const depth = curve([
    [-0.16, g.thighB / g.thighA], [0.45, 1.06], [0.88, 1.00], [1.0, 0.98],
    [1.30, g.calfB / g.calfA], [1.62, 1.04], [1.97, g.ankleB / g.ankleA],
  ]);

  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];
    const rings: Ring[] = [];
    for (const q of d.legRings) {
      const dir = legDirAt(a, si, q);
      const az = V(0, 0, 1).addScaledVector(dir, -dir.z).normalize();
      const ax = new THREE.Vector3().crossVectors(dir, az);
      const o = legPoint(a, si, q);
      const rr = rad(q);
      const lobes: Lobe[] = [];
      // Rectus femoris + vastus lateralis, and the hamstring mass behind.
      const quad = smooth(0.06, 0.30, q) * smooth(0.94, 0.66, q) * (0.35 + 0.65 * a.p.muscle);
      if (quad > 0.01) {
        lobes.push({ at: 0.25, w: 0.15, amp: 0.075 * quad });
        lobes.push({ at: si === 0 ? 0.47 : 0.03, w: 0.13, amp: 0.085 * quad });
        lobes.push({ at: 0.75, w: 0.20, amp: 0.060 * quad });
      }
      // Patella and the two condyles.
      const pat = smooth(0.86, 0.99, q) * smooth(1.14, 1.01, q);
      if (pat > 0.01) {
        lobes.push({ at: 0.25, w: 0.11, amp: 0.11 * pat });
        lobes.push({ at: 0.75, w: 0.13, amp: -0.075 * pat });
      }
      // Gastrocnemius — its bulge is posterior and sits high and slightly medial.
      const calf = smooth(1.06, 1.26, q) * smooth(1.70, 1.40, q) * (0.4 + 0.6 * a.p.muscle);
      if (calf > 0.01) {
        lobes.push({ at: 0.75, w: 0.17, amp: 0.14 * calf });
        lobes.push({ at: si === 0 ? 0.86 : 0.64, w: 0.11, amp: 0.05 * calf });
      }
      // Tibial crest — the flat shin face that says "this is a leg, not a pipe".
      const tib = smooth(1.05, 1.20, q) * smooth(1.97, 1.70, q);
      if (tib > 0.01) lobes.push({ at: 0.25, w: 0.08, amp: -0.055 * tib });
      // Malleoli.
      const mal = smooth(1.78, 1.92, q);
      if (mal > 0.01) {
        lobes.push({ at: 0.0, w: 0.10, amp: 0.10 * mal });
        lobes.push({ at: 0.5, w: 0.10, amp: 0.10 * mal });
      }
      rings.push({
        o, ax, az,
        r: ellipse(rr, rr * depth(q), lobes),
        skin: legSkin(a, si, q, 0),
        skinAt: (t: number) => legSkin(a, si, q, t),
        v: clamp01((q + 0.16) / 2.13),
        crease: (t: number) => {
          const groin = smooth(0.16, -0.10, q) * lobe(t, si === 0 ? 0.92 : 0.08, 0.13) * 0.9;
          const pop = smooth(0.90, 1.0, q) * smooth(1.16, 1.02, q) * lobe(t, 0.75, 0.11) * 0.85;
          return clamp01(groin + pop);
        },
      });
    }
    m.group(GROUP.skin).loft(rings, d.limbSegs, {
      part: PART.THIGH, side: s, capStart: true, capEnd: true,
    });
  }
}

/**
 * A short bare-ankle stub between the sock cuff and the shoe collar. The rest
 * of the foot is inside the shoe and is never built — a hidden foot is the
 * cheapest triangle you will ever not spend.
 */
export function buildAnkles(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const g = a.g;
  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];
    const suf = SIDE_SUFFIX[si];
    const rings: Ring[] = [];
    const N = 3;
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      const q = lerp(1.80, 2.02, u);
      const o = legPoint(a, si, Math.min(q, 2));
      if (q > 2) o.addScaledVector(a.shinDir[si], (q - 2) * a.len.shin);
      const rr = lerp(g.ankleA * 1.14, g.ankleA * 0.92, u);
      rings.push({
        o, ax: new THREE.Vector3().crossVectors(a.shinDir[si], V(0, 0, 1)).normalize(),
        az: V(0, 0, 1),
        r: ellipse(rr, rr * (g.ankleB / g.ankleA)),
        skin: sk2(bi(`shin${suf}` as BoneName), 1 - u * 0.6, bi(`foot${suf}` as BoneName), u * 0.6),
        v: u, crease: 0.1,
      });
    }
    m.group(GROUP.skin).loft(rings, Math.max(6, d.limbSegs - 4), {
      part: PART.FOOT, side: s, capEnd: true,
    });
  }
}
