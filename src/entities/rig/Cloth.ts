import * as THREE from 'three';
import { PART, GROUP } from './Types.ts';
import type { BoneName } from './Types.ts';
import { SIDES, SIDE_SUFFIX, bi } from './Skeleton.ts';
import type { Anthro } from './Skeleton.ts';
import {
  RigMesh, V, ellipse, lobe, sk1, sk2, skN, skMix, smooth, lerp, clamp01,
} from './Build.ts';
import type { Ring, Skin, Vec3, Lobe, Profile } from './Build.ts';
import { torsoCentre, torsoProfile, torsoSkin, curve, armSurface, CAP_Q } from './Body.ts';
import type { DetailSpec } from './Body.ts';

/**
 * Clothing. Every garment is a genuine shell offset from the body surface with
 * its own hem, cuff and collar folds — never a texture painted on skin. The
 * folds are three extra rings each and they are the difference between "wearing
 * a jersey" and "painted blue from the waist up": a hem you can see the
 * underside of is the cue the eye actually checks.
 *
 * Garments inherit the body's skin weights exactly, so cloth and the limb inside
 * it deform together and nothing pokes through on a layout.
 */

/**
 * Where two garment pieces overlap they MUST share a binding, not merely sit
 * near each other. The jersey body and its sleeve meet inside the deltoid; the
 * shorts yoke and its leg tube meet inside the hip. If the two sides of that
 * overlap are weighted differently, a raised arm or a lifted knee shears them
 * apart and opens a hole straight through the athlete — which is exactly what
 * the first pass did on every layout pose.
 */
function shoulderSkin(si: number, lat: number): Skin {
  const suf = SIDE_SUFFIX[si];
  return skN([
    [bi(`clavicle${suf}` as BoneName), 0.42],
    [bi(`upperArm${suf}` as BoneName), 0.38],
    [bi('chest'), 0.20],
  ]);
}

function hipSkin(si: number): Skin {
  const suf = SIDE_SUFFIX[si];
  return skN([[bi('pelvis'), 0.46], [bi(`thigh${suf}` as BoneName), 0.54]]);
}

/**
 * The top of a shorts leg tube runs up INSIDE the waistband, and the waistband
 * is bound to the pelvis. If that overlap is 54 % femur — as `hipSkin` is — then
 * 66 degrees of hip flexion swings the tube out from under the yoke and tears
 * the two apart at the front of the hip. The overlap has to be pelvis-dominant
 * and hand over to the femur only once it is clear of the waistband.
 */
function waistSkin(si: number): Skin {
  const suf = SIDE_SUFFIX[si];
  return skN([[bi('pelvis'), 0.80], [bi(`thigh${suf}` as BoneName), 0.20]]);
}

/* ----------------------------------------------------------------- jersey */

export function buildJersey(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const H = a.H;
  const seg = d.torsoSegs;
  // The hem must sit clearly OUTSIDE the shorts' waistband (0.0165) or the two
  // shells z-fight into a sawtooth right across the athlete's waist. Ultimate
  // jerseys are worn untucked, so flaring the hem is also the correct look.
  // Down at the hem the jersey has to clear the shorts' waistband AND the flare
  // the shorts now carry over the tops of the thighs, or the shorts tear through
  // the shirt in exactly the band a broadcast camera frames.
  const off = curve([
    [-0.10, 0.0360], [0.05, 0.0310], [0.30, 0.0216], [0.55, 0.0128],
    [0.76, 0.0092], [0.90, 0.0088], [1.0, 0.0105],
  ]);
  const hemU = -0.075;
  // The last three rings climb the trapezius with it. Stopping at 0.968 and
  // jumping straight to the collar drew a 12 cm horizontal annulus across each
  // shoulder — the same plate the sleeve used to make, now made by the body.
  const us = d.level === 0
    ? [hemU, -0.03, 0.06, 0.16, 0.27, 0.38, 0.49, 0.60, 0.70, 0.79, 0.858, 0.905, 0.948, 0.978, 1.0, 1.011, 1.021]
    : d.level === 1
      ? [hemU, 0.02, 0.20, 0.40, 0.60, 0.78, 0.90, 0.96, 1.0, 1.021]
      : [hemU, 0.12, 0.42, 0.72, 0.95, 1.021];

  const shellRing = (u: number, extra = 0): Ring => {
    const base = torsoProfile(a, u);
    const k = (off(u) + extra) * (H / 1.8);
    // Cloth does not follow anatomy exactly — it bridges the pec valley and the
    // spinal furrow. Blending the profile toward its own local mean is a cheap,
    // convincing drape.
    const smoothed: Profile = (t) => {
      const [x0, y0] = base(t);
      const [xa, ya] = base(t + 0.035);
      const [xb, yb] = base(t - 0.035);
      let mx = (x0 * 0.5 + xa * 0.25 + xb * 0.25);
      const my = (y0 * 0.5 + ya * 0.25 + yb * 0.25);
      // Shoulder yoke. The torso's trapezius ramp now reaches the acromion on
      // its own (see Body.ts `torsoProfile`), so this is a few millimetres of
      // drape over the shoulder seam — NOT the 42 % inflation it used to be.
      // That inflation put the jersey's shoulder edge 4 cm outboard and 3 cm
      // above the deltoid, which is a plate with a crease along it: the
      // shoulder facet, in one line of code.
      const yoke = smooth(0.62, 1.0, u);
      if (yoke > 0) mx *= 1 + yoke * 0.045 * Math.pow(Math.abs(Math.cos(t * Math.PI * 2)), 0.8);
      const len = Math.hypot(mx, my) || 1e-6;
      return [mx + (mx / len) * k, my + (my / len) * k];
    };
    return {
      o: torsoCentre(a, u), ax: V(1, 0, 0), az: V(0, 0, 1),
      r: smoothed,
      skin: torsoSkin(a, u, 0),
      skinAt: (t: number) => {
        const base = torsoSkin(a, u, t);
        const lat = Math.cos(t * Math.PI * 2);
        const w = smooth(0.82, 1.0, u) * Math.pow(Math.abs(lat), 2.0) * 0.8;
        return w > 0.01 ? skMix(base, shoulderSkin(lat > 0 ? 0 : 1, lat), w) : base;
      },
      v: clamp01((u - hemU) / (1.05 - hemU)),
      crease: (t: number) => 0.30 * smooth(0.06, -0.075, u)
        + 0.25 * lobe(t, 0.25, 0.10) * smooth(0.55, 0.30, u),
    };
  };

  const rings: Ring[] = [];
  // Hem fold: a ring turned back under itself so the jersey has a visible inside
  // edge instead of a knife-thin boundary.
  if (d.clothFold) {
    rings.push({ ...shellRing(hemU + 0.035, -0.0055), v: 0 });
    rings.push({ ...shellRing(hemU + 0.010, -0.0015), v: 0.01 });
  }
  for (const u of us) rings.push(shellRing(u));

  // Collar. A crew neck's band sits AT the base of the neck — its top edge is
  // level with the cervicale, around 0.826 H. The previous ring topped out at
  // 0.834 H, which is 3 cm higher, and 3 cm is the entire visible neck: the
  // collar met the underside of the jaw and the head appeared to sit straight
  // on the shoulders. That is most of what "the neck is too short" was.
  const nkY = a.neckBaseY;
  const collar = (rr: number, y: number, v: number, cr: number): Ring => ({
    o: V(0, y, -0.004 * H), ax: V(1, 0, 0), az: V(0, 0, 1),
    r: ellipse(a.g.neckA * rr, a.g.neckB * rr),
    skin: sk2(bi('chest'), 0.7, bi('neck'), 0.3),
    v, crease: cr,
  });
  // Three rings, not two, and 2.5 cm of rise between the last body ring and the
  // collar's top edge. Without that rise the trapezius shelf is dead level and
  // the collar reads as a plate edge laid across the chest.
  rings.push(collar(1.32, nkY + 0.0082 * H, 0.972, 0.15));
  rings.push(collar(1.17, nkY + 0.0108 * H, 0.996, 0.15));
  if (d.clothFold) {
    rings.push(collar(1.115, nkY + 0.0086 * H, 1.0, 0.55));
    rings.push(collar(1.17, nkY + 0.0040 * H, 1.0, 0.75));
  }

  m.group(GROUP.jersey).loft(rings, seg, { part: PART.JERSEY, side: 0 });

  /* ------------------------------------------------------------ sleeves */
  /**
   * THE SLEEVE IS A PARALLEL OFFSET OF THE ARM — nothing more.
   *
   * `armSurface()` hands back the exact ring frame the skin loft used, grown by
   * a cloth thickness. Because the two surfaces differ only by that constant,
   * the sleeve's silhouette is the deltoid's silhouette, and the shoulder can
   * no longer crease away from the arm inside it. The old sleeve authored its
   * own radius curve at 1.34 × the deltoid and its own tilted cap, and the
   * mismatch between the two is what the critic saw as a faceted ridge.
   *
   * It also runs the SAME six loops across the cap that the arm does, so there
   * is no place for the two to disagree about where the shoulder is.
   */
  const sleeveEnd = d.level === 0 ? 0.52 : 0.50;
  const CLOTH = 0.0072 * (H / 1.8);
  const ring = armSurface(a);
  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];
    const suf = SIDE_SUFFIX[si];
    const UA = bi(`upperArm${suf}` as BoneName);
    const UT = bi(`upperArmTwist${suf}` as BoneName);
    const qs = d.level === 0
      ? [-0.335, -0.305, -0.265, -0.215, -0.155, -0.088, -0.015, 0.10, 0.24, 0.38, sleeveEnd]
      : d.level === 1
        ? [-0.335, -0.28, -0.19, -0.09, 0.02, 0.22, sleeveEnd]
        : [-0.335, -0.22, -0.06, 0.16, sleeveEnd];
    const sr: Ring[] = [];
    const push = (q: number, extra: number): Ring => {
      // Cloth hangs a little away from the arm below the deltoid and is pulled
      // tight over it, which is also what stops the sleeve reading as paint.
      const drape = extra + CLOTH * (0.85 + 0.85 * smooth(0.05, 0.50, q));
      const R = ring(si, q, drape);
      // Cloth bridges muscle detail rather than following it into the valleys.
      const soft = R.lobes.map((L) => ({ ...L, amp: L.amp * 0.45 }));
      const w = smooth(0.02, 0.50, q);
      return {
        o: R.o, ax: R.ax, az: R.az,
        r: ellipse(R.ra, R.rb, soft),
        // Identical binding to the jersey's shoulder corner at the overlap,
        // then a clean ramp down the humerus.
        skin: skMix(shoulderSkin(si, s), sk2(UA, 0.35, UT, 0.65), w),
        v: clamp01((q + CAP_Q) / (sleeveEnd + CAP_Q)),
        crease: 0.12 + 0.28 * smooth(0.28, 0.52, q),
      };
    };
    for (const q of qs) sr.push(push(q, 0));
    if (d.clothFold) {
      // Hem turned back under itself so the sleeve has a readable inside edge.
      sr.push(push(sleeveEnd - 0.010, -0.0030));
      sr.push(push(sleeveEnd - 0.050, -0.0052));
    }
    m.group(GROUP.jersey).loft(sr, Math.max(10, d.limbSegs), {
      part: PART.JERSEY, side: s, capStart: true,
    });
  }
}

/* ----------------------------------------------------------------- shorts */

/**
 * THE CROTCH.
 *
 * What was there: the yoke's rings were nipped 52 % inward at the front and the
 * back as they approached u = −0.175, and the resulting peanut was closed with a
 * FAN CAP — a flat, downward-facing disc with two concave notches in it, sitting
 * in the middle of the athlete's shorts. That is the hard geometric V the critic
 * read as a mesh seam failure, and it is exactly what it looks like: a mesh seam
 * failure. Under it, two leg tubes crossed the midline by 2 cm and intersected
 * as raw cylinders, and their medial-flattening lobe was on the WRONG SIDE — it
 * flattened the outside of each leg (`at: si === 0 ? 0.5 : 0`, and for a leg
 * ring `ax` points to −X, so t = 0.5 is lateral, not medial).
 *
 * What is there now:
 *   • The yoke has no pinch and no cap. It stops just below the hip line and its
 *     open bottom is covered from underneath, which is what a waistband does.
 *   • Each leg tube runs up INSIDE the yoke and is inflated front-to-back at the
 *     top so it covers the yoke's rim rather than leaving a slot at it.
 *   • Below the crotch each tube's medial face is softly clamped to a plane a
 *     centimetre off the midline. Two planes facing each other meet tangentially;
 *     two cylinders meet in a V. That is the whole difference between an inseam
 *     and a notch.
 *   • A gusset — a small vertical wedge — closes the slot between those two
 *     planes from inside the yoke down to the crotch point at 0.485 H, and is
 *     capped below, where nothing can see it.
 * The hem stays a full ellipse around each thigh at every ring, so it falls as a
 * cylinder instead of pinching to a point.
 */
export function buildShorts(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const H = a.H;
  const S = H / 1.8;
  const waistU = 0.30;
  // The yoke stops just under the hip joint line. Everything below that is legs
  // and gusset — there is no fabric on the midline below the crotch, and trying
  // to model some is what produced the notch.
  const yokeBottomU = -0.055;
  const seg = d.torsoSegs;
  const us = d.level === 0
    ? [waistU, 0.235, 0.17, 0.105, 0.045, -0.005, yokeBottomU]
    : d.level === 1 ? [waistU, 0.18, 0.06, -0.01, yokeBottomU] : [waistU, 0.10, yokeBottomU];

  const yoke = (u: number, extra = 0): Ring => {
    const base = torsoProfile(a, u);
    const k = (0.0165 + extra) * S;
    // Shorts hang away from the pelvis and over the tops of the thighs, so the
    // lower rings flare laterally. Without it the leg tubes are wider than the
    // yoke they emerge from and the transition steps outward.
    const flare = 1 + 0.030 * smooth(0.08, yokeBottomU, u);
    return {
      o: torsoCentre(a, u),
      ax: V(1, 0, 0), az: V(0, 0, 1),
      r: (t: number) => {
        const [x0, y0] = base(t);
        const len = Math.hypot(x0, y0) || 1e-6;
        const lat = Math.abs(Math.cos(t * Math.PI * 2));
        const f = 1 + (flare - 1) * lat;
        return [(x0 + (x0 / len) * k) * f, (y0 + (y0 / len) * k)];
      },
      skin: torsoSkin(a, u, 0),
      skinAt: (t: number) => {
        const b = torsoSkin(a, u, t);
        const lat = Math.cos(t * Math.PI * 2);
        const w = smooth(0.12, yokeBottomU - 0.10, u) * Math.pow(Math.abs(lat), 1.1);
        return w > 0.01 ? skMix(b, hipSkin(lat > 0 ? 0 : 1), w) : b;
      },
      v: clamp01((waistU - u) / (waistU - yokeBottomU)) * 0.35,
      crease: 0.15 + 0.30 * smooth(0.05, yokeBottomU, u),
    };
  };

  const g = a.g;
  const hem = d.level === 0 ? 0.46 : 0.44;
  // Crotch height, 0.485 H off the table — where the medial clamp is fully in.
  const crotchY = 0.485 * H;

  const rings: Ring[] = [];
  if (d.clothFold) {
    rings.push({ ...yoke(waistU - 0.055, -0.006), v: 0 });
    rings.push({ ...yoke(waistU - 0.018, -0.002), v: 0.01 });
  }
  for (const u of us) rings.push(yoke(u));

  // THE GUSSET, as a continuation of the yoke rather than a separate piece.
  // The yoke's bottom rings keep their SHAPE and shrink toward the crotch
  // point, so the waistband closes into a rounded bowl. Everything outboard of
  // ±1.5 cm is buried inside a leg tube; only the midline strip is ever seen,
  // and that strip is the inseam. It is scaled from the yoke's own profile so
  // the transition is continuous, and it is weighted to the pelvis with a
  // little of each femur, so a 42° stride cannot swing a leg tube off it and
  // open the hole the fan cap used to hide badly.
  const bottom = yoke(yokeBottomU);
  const bowlN = d.level === 0 ? 5 : d.level === 1 ? 4 : 3;
  const bowlSkin = skN([[bi('pelvis'), 0.52], [bi('thigh_L'), 0.24], [bi('thigh_R'), 0.24]]);
  for (let i = 1; i <= bowlN; i++) {
    const t = i / bowlN;
    const ea = Math.pow(t, 0.85);
    const y = lerp(bottom.o.y, crotchY - 0.005 * H, Math.pow(t, 1.2));
    const sa = lerp(1, 0.11, ea);
    const sb = lerp(1, 0.26, ea);
    rings.push({
      o: V(0, y, bottom.o.z + 0.006 * H * t),
      ax: V(1, 0, 0), az: V(0, 0, 1),
      r: (tt: number) => {
        const [x0, y0] = bottom.r(tt);
        return [x0 * sa, y0 * sb];
      },
      skin: bowlSkin,
      v: 0.35,
      crease: 0.45 + 0.45 * t,
    });
  }
  m.group(GROUP.shorts).loft(rings, seg, { part: PART.SHORTS, side: 0, capEnd: true });

  /* --------------------------------------------------------- leg tubes */
  const thighDrop = a.len.thigh * Math.abs(a.legDir[0].y);
  const crotchQ = clamp01((a.hipY - crotchY) / Math.max(1e-4, thighDrop));
  // Half the slot the two clamped medial faces leave between them.
  const GAP = 0.0095 * S;
  const SOFT = 0.020 * S;
  /** One-sided soft clamp — C1 at the join, asymptotic at the limit, so the
   *  flattened medial face blends into the round part with no crease. */
  const softLo = (x: number, lim: number): number => {
    const dd = x - (lim - SOFT);
    return dd <= 0 ? x : lim - SOFT * Math.exp(-dd / SOFT);
  };

  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];
    const suf = SIDE_SUFFIX[si];
    const TH = bi(`thigh${suf}` as BoneName);
    const TT = bi(`thighTwist${suf}` as BoneName);
    const qs = d.level === 0
      ? [-0.16, -0.10, -0.04, 0.03, 0.10, 0.18, 0.27, 0.37, hem]
      : d.level === 1 ? [-0.16, -0.05, 0.08, 0.24, 0.38, hem] : [-0.16, 0.06, 0.26, hem];
    const rad = curve([
      [-0.22, g.thighA * 1.10], [-0.10, g.thighA * 1.06], [0.10, g.thighA * 1.00],
      [0.30, g.thighA * 0.93], [0.50, g.thighA * 0.86],
    ]);
    const leg = (q: number, extra: number, flare: number): Ring => {
      const dir = a.legDir[si];
      const az = V(0, 0, 1).addScaledVector(dir, -dir.z).normalize();
      const ax = new THREE.Vector3().crossVectors(dir, az);
      const o = a.hip[si].clone().addScaledVector(dir, a.len.thigh * q);
      // Cloth clearance grows down the leg: shorts sit close over the hip (where
      // they have to stay inside the waistband) and hang loose at the hem.
      const slack = lerp(0.0100, 0.0175, smooth(-0.02, 0.24, q));
      const rr = rad(q) + (slack + extra + flare) * S;
      // Front-to-back the tube is inflated where it runs up inside the yoke:
      // there it is not a tube around a thigh, it is the front and back panel of
      // the shorts, and it has to reach past the yoke's rim or leave a slot.
      const deep = (g.thighB / g.thighA) * (1 + 0.24 * smooth(0.30, -0.10, q));
      const w = smooth(0.05, 0.45, q);
      // Medial clamp ramps in through the crotch, then RELEASES toward the hem:
      // the legs are furthest apart there and the brief is explicit that the hem
      // must fall as a cylinder around each thigh, not pinch to a point.
      const clamped = smooth(crotchQ - 0.24, crotchQ + 0.06, q)
        * lerp(1, 0.34, smooth(0.26, hem, q));
      const lim = s > 0 ? o.x - GAP : o.x + GAP;
      const base = ellipse(rr, rr * deep);
      return {
        o, ax, az,
        r: clamped < 0.01 ? base : (t: number) => {
          const [x0, y0] = base(t);
          // ax points at −X on both sides, so world x ≈ o.x − x0.
          const cl = s > 0 ? softLo(x0, lim) : -softLo(-x0, -lim);
          return [lerp(x0, cl, clamped), y0];
        },
        skin: skMix(
          skMix(waistSkin(si), hipSkin(si), smooth(-0.14, 0.04, q)),
          sk2(TH, 1 - w * 0.72, TT, w * 0.72), smooth(0.02, 0.24, q),
        ),
        v: 0.35 + 0.65 * clamp01((q + 0.16) / (hem + 0.16)),
        crease: (t: number) => clamp01(
          0.24 * smooth(0.1, -0.1, q) + 0.18 * smooth(0.2, 0.45, q)
          // Inseam shadow down the medial face.
          + 0.45 * clamped * lobe(t, si === 0 ? 0.0 : 0.5, 0.10),
        ),
      };
    };
    const lr: Ring[] = [];
    for (const q of qs) lr.push(leg(q, 0, 0.010 * smooth(0.15, hem, q)));
    if (d.clothFold) {
      lr.push(leg(hem - 0.012, -0.0035, 0.010));
      lr.push(leg(hem - 0.055, -0.0065, 0.006));
    }
    m.group(GROUP.shorts).loft(lr, Math.max(10, d.limbSegs), { part: PART.SHORTS, side: s });
  }

}

/* ------------------------------------------------------------------ socks */

export function buildSocks(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const g = a.g;
  const H = a.H;
  const rad = curve([
    [1.30, g.calfA * 1.01], [1.40, g.calfA * 0.99], [1.60, g.calfA * 0.72],
    [1.80, g.ankleA * 1.14], [1.99, g.ankleA * 0.98],
  ]);
  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];
    const suf = SIDE_SUFFIX[si];
    const SH = bi(`shin${suf}` as BoneName);
    const FO = bi(`foot${suf}` as BoneName);
    const top = 1.34;
    const qs = d.level === 0 ? [top, 1.44, 1.56, 1.68, 1.80, 1.90, 1.99]
      : d.level === 1 ? [top, 1.52, 1.74, 1.99] : [top, 1.65, 1.99];
    const ring = (q: number, extra: number): Ring => {
      const dir = a.shinDir[si];
      const az = V(0, 0, 1).addScaledVector(dir, -dir.z).normalize();
      const ax = new THREE.Vector3().crossVectors(dir, az);
      const rr = rad(q) + (0.0048 + extra) * (H / 1.8);
      const r2 = clamp01((q - 1) );
      return {
        o: a.knee[si].clone().addScaledVector(dir, a.len.shin * (q - 1)),
        ax, az,
        r: ellipse(rr, rr * (g.calfB / g.calfA), [
          { at: 0.75, w: 0.18, amp: 0.10 * smooth(1.60, 1.30, q) },
        ]),
        skin: sk2(SH, 1 - smooth(1.90, 2.0, q) * 0.65, FO, smooth(1.90, 2.0, q) * 0.65),
        v: r2,
        crease: 0.12 + 0.30 * smooth(1.42, 1.34, q),
      };
    };
    const rs: Ring[] = [];
    if (d.clothFold) {
      // Ribbed cuff — two turns, which is what makes a sock read as knitwear.
      rs.push(ring(top + 0.055, -0.0030));
      rs.push(ring(top + 0.022, 0.0018));
      rs.push(ring(top + 0.004, 0.0026));
    }
    for (const q of qs) rs.push(ring(q, smooth(1.40, 1.34, q) * 0.0022));
    m.group(GROUP.socks).loft(rs, Math.max(8, d.limbSegs - 2), { part: PART.SOCK, side: s });
  }
}

/* ------------------------------------------------------------------ shoes */

/**
 * Cleat last, metres at H = 1.80, measured forward from the ankle joint. A foot
 * is 0.153 H long with the ankle a quarter of the way back from the heel, so the
 * shoe runs −0.070 to +0.232 — nearly 30 cm. The first pass had it at 17 cm and
 * 10 cm wide, which is a paddle, and it read as one instantly.
 */
const SHOE_Z = [-0.0700, -0.0500, -0.0200, 0.0150, 0.0550, 0.1000, 0.1450, 0.1900, 0.2320];
const SHOE_W = [0.48, 0.78, 0.90, 0.97, 1.00, 0.99, 0.91, 0.72, 0.34];
const SHOE_TOP = [0.0530, 0.0760, 0.0900, 0.0820, 0.0700, 0.0590, 0.0480, 0.0360, 0.0250];
const SHOE_SOLE = [0.0100, 0.0058, 0.0036, 0.0028, 0.0026, 0.0028, 0.0034, 0.0044, 0.0068];

export function buildShoes(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const H = a.H;
  const g = a.g;
  const footW = g.ankleA * 1.36;
  const seg = d.level === 0 ? 14 : d.level === 1 ? 10 : 7;
  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];
    const suf = SIDE_SUFFIX[si];
    const FO = bi(`foot${suf}` as BoneName);
    const TO = bi(`toe${suf}` as BoneName);
    const cx = a.ankle[si].x;
    const cz = a.ankle[si].z;
    const ballZ = a.ball[si].z;
    const rings: Ring[] = [];
    const step = d.level === 2 ? 2 : 1;
    for (let i = 0; i < SHOE_Z.length; i += step) {
      const zz = cz + SHOE_Z[i] * (H / 1.8);
      const top = SHOE_TOP[i] * (H / 1.8);
      const sole = SHOE_SOLE[i] * (H / 1.8);
      const w = footW * SHOE_W[i];
      const hh = (top - sole) * 0.5;
      const yc = (top + sole) * 0.5;
      const toeF = smooth(ballZ - 0.01 * H, ballZ + 0.03 * H, zz);
      rings.push({
        o: V(cx + s * 0.002 * H, yc, zz),
        ax: V(1, 0, 0), az: V(0, 1, 0),
        r: ellipse(w, hh, [
          // Outsole flare + a lace-panel dip along the top of the instep.
          { at: 0.75, w: 0.16, amp: 0.16 },
          { at: 0.25, w: 0.10, amp: -0.10 * smooth(-0.03 * H, 0.02 * H, zz - cz) },
        ], 2.45),
        skin: sk2(FO, 1 - toeF, TO, toeF),
        v: i / (SHOE_Z.length - 1),
        crease: (t: number) => 0.15 + 0.45 * lobe(t, 0.75, 0.12),
      });
    }
    m.group(GROUP.shoes).loft(rings, seg, {
      part: PART.SHOE, side: s, capStart: true, capEnd: true, flip: true,
    });

    if (d.level !== 0) continue;
    // Studs. Eight cones under the plate: five around the forefoot, three at the
    // heel. They exist for one frame — the layout — and they are the difference
    // between a cleat and a slipper.
    const studs: [number, number][] = [
      [-0.62, -0.055], [0.62, -0.055], [-0.56, -0.020], [0.56, -0.020],
      [-0.70, 0.070], [0.70, 0.070], [-0.62, 0.135], [0.62, 0.135], [0.0, 0.175],
    ];
    for (const [sx, sz] of studs) {
      const zz = cz + sz * (H / 1.8);
      const iw = footW * (0.86 + 0.12 * Math.cos(sz * 20));
      const px = cx + sx * iw;
      const base = 0.0026 * (H / 1.8);
      const sr: Ring[] = [];
      for (let k = 0; k < 3; k++) {
        const u = k / 2;
        sr.push({
          o: V(px, base - u * 0.0075 * (H / 1.8), zz),
          ax: V(1, 0, 0), az: V(0, 0, 1),
          r: ellipse(0.0042 * (H / 1.8) * (1 - 0.45 * u), 0.0042 * (H / 1.8) * (1 - 0.45 * u)),
          skin: sk2(FO, sz < 0.02 ? 1 : 0.2, TO, sz < 0.02 ? 0 : 0.8),
          v: u, crease: 0.3,
        });
      }
      m.group(GROUP.shoes).loft(sr, 5, { part: PART.SHOE, side: s, capEnd: true, flip: true });
    }
  }
}
