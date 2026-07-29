import * as THREE from 'three';
import { PART, GROUP } from './Types.ts';
import type { BoneName } from './Types.ts';
import { SIDES, SIDE_SUFFIX, bi } from './Skeleton.ts';
import type { Anthro } from './Skeleton.ts';
import {
  RigMesh, V, ellipse, lobe, sk1, sk2, skN, skMix, smooth, lerp, clamp01,
} from './Build.ts';
import type { Ring, Skin, Vec3, Lobe, Profile } from './Build.ts';
import { torsoCentre, torsoProfile, torsoSkin, curve } from './Body.ts';
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

/* ----------------------------------------------------------------- jersey */

export function buildJersey(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const H = a.H;
  const seg = d.torsoSegs;
  // The hem must sit clearly OUTSIDE the shorts' waistband (0.0165) or the two
  // shells z-fight into a sawtooth right across the athlete's waist. Ultimate
  // jerseys are worn untucked, so flaring the hem is also the correct look.
  const off = curve([
    [-0.10, 0.0215], [0.05, 0.0205], [0.30, 0.0192], [0.55, 0.0128],
    [0.76, 0.0092], [0.90, 0.0088], [1.0, 0.0105],
  ]);
  const hemU = -0.075;
  const us = d.level === 0
    ? [hemU, -0.03, 0.06, 0.16, 0.27, 0.38, 0.49, 0.60, 0.70, 0.79, 0.865, 0.925, 0.968]
    : d.level === 1
      ? [hemU, 0.02, 0.20, 0.40, 0.60, 0.78, 0.90, 0.968]
      : [hemU, 0.12, 0.42, 0.72, 0.90, 0.968];

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
      // Shoulder yoke. The torso's own top ring is 12 cm half-width and the
      // deltoid centre is at 19 cm, so an un-widened jersey simply does not
      // reach the sleeve and every player wears a hole over each shoulder blade.
      const yoke = smooth(0.60, 1.0, u);
      if (yoke > 0) mx *= 1 + yoke * 0.42 * Math.pow(Math.abs(Math.cos(t * Math.PI * 2)), 0.8);
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

  // Collar: leaves the torso profile and closes onto the neck, then ribs back
  // down inside itself.
  const nkY = a.neckBaseY;
  const collar = (rr: number, y: number, v: number, cr: number): Ring => ({
    o: V(0, y, -0.004 * H), ax: V(1, 0, 0), az: V(0, 0, 1),
    r: ellipse(a.g.neckA * rr, a.g.neckB * rr),
    skin: sk2(bi('chest'), 0.7, bi('neck'), 0.3),
    v, crease: cr,
  });
  rings.push(collar(1.42, nkY + 0.006 * H, 0.97, 0.15));
  rings.push(collar(1.20, nkY + 0.021 * H, 0.99, 0.15));
  if (d.clothFold) {
    rings.push(collar(1.15, nkY + 0.016 * H, 1.0, 0.55));
    rings.push(collar(1.24, nkY + 0.004 * H, 1.0, 0.75));
  }

  m.group(GROUP.jersey).loft(rings, seg, { part: PART.JERSEY, side: 0 });

  /* ------------------------------------------------------------ sleeves */
  const sleeveEnd = d.level === 0 ? 0.52 : 0.50;
  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];
    const suf = SIDE_SUFFIX[si];
    const UA = bi(`upperArm${suf}` as BoneName);
    const UT = bi(`upperArmTwist${suf}` as BoneName);
    const qs = d.level === 0 ? [-0.30, -0.16, -0.03, 0.12, 0.28, sleeveEnd] : [-0.30, -0.08, 0.14, sleeveEnd];
    const sr: Ring[] = [];
    const D = a.g.deltoid, B = a.g.bicep;
    // The proximal rings are deliberately oversized: the sleeve's inner edge has
    // to reach *past* the jersey's shoulder edge, not merely meet it, or the two
    // shells miss each other by a few millimetres and the athlete wears a slot.
    const rad = curve([
      [-0.30, D * 1.34], [-0.16, D * 1.26], [-0.02, D * 1.12], [0.16, D * 1.02],
      [0.34, B * 1.20], [0.55, B * 1.24],
    ]);
    const push = (q: number, extra: number): Ring => {
      let dir = a.armDir[si].clone();
      let o = a.shoulder[si].clone().addScaledVector(dir, a.len.upperArm * q);
      if (q < 0) {
        // Lower and flatter than the deltoid cap underneath it: a sleeve whose
        // top ring sits above the jersey's shoulder line reads as a floating
        // epaulette, which is what the first pass produced.
        const k = Math.min(1, -q / 0.30);
        o = a.shoulder[si].clone().add(V(-s * 0.004 * H * k, 0.014 * H * k, -0.002 * H * k));
        dir = dir.lerp(V(0, 1, 0), k * 0.60).normalize();
      }
      const az = V(0, 0, 1).addScaledVector(dir, -dir.z).normalize();
      const ax = new THREE.Vector3().crossVectors(dir, az);
      const rr = rad(q) + (0.0105 + extra) * (H / 1.8);
      const w = smooth(0.02, 0.55, q);
      return {
        o, ax, az,
        r: ellipse(rr, rr * 1.03),
        // Identical binding to the jersey's shoulder corner at the overlap,
        // then a clean ramp down the humerus.
        skin: skMix(shoulderSkin(si, s), sk2(UA, 0.35, UT, 0.65), w),
        v: clamp01((q + 0.2) / 0.8),
        crease: 0.15 + 0.25 * smooth(0.30, 0.55, q),
      };
    };
    for (const q of qs) sr.push(push(q, 0));
    if (d.clothFold) {
      sr.push(push(sleeveEnd - 0.012, -0.0035));
      sr.push(push(sleeveEnd - 0.055, -0.0055));
    }
    m.group(GROUP.jersey).loft(sr, Math.max(8, d.limbSegs), { part: PART.JERSEY, side: s });
  }
}

/* ----------------------------------------------------------------- shorts */

export function buildShorts(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const H = a.H;
  const waistU = 0.30;
  const crotchU = -0.175;
  const seg = d.torsoSegs;
  const us = d.level === 0
    ? [waistU, 0.22, 0.13, 0.045, -0.035, -0.105, crotchU]
    : d.level === 1 ? [waistU, 0.16, 0.02, -0.09, crotchU] : [waistU, 0.05, crotchU];

  const yoke = (u: number, extra = 0): Ring => {
    const base = torsoProfile(a, u);
    const k = (0.0165 + extra) * (H / 1.8);
    // Toward the crotch the section pinches front and back into two lobes so
    // that the leg tubes have somewhere to emerge from.
    const pinch = smooth(-0.02, crotchU, u);
    return {
      o: torsoCentre(a, u).add(V(0, 0, -0.004 * H * pinch)),
      ax: V(1, 0, 0), az: V(0, 0, 1),
      r: (t: number) => {
        const [x0, y0] = base(t);
        const len = Math.hypot(x0, y0) || 1e-6;
        const nip = 1 - 0.52 * pinch * (lobe(t, 0.25, 0.085) + lobe(t, 0.75, 0.105));
        return [(x0 + (x0 / len) * k) * nip, (y0 + (y0 / len) * k) * nip];
      },
      skin: torsoSkin(a, u, 0),
      skinAt: (t: number) => {
        const base = torsoSkin(a, u, t);
        const lat = Math.cos(t * Math.PI * 2);
        const w = smooth(0.12, crotchU, u) * Math.pow(Math.abs(lat), 1.1);
        return w > 0.01 ? skMix(base, hipSkin(lat > 0 ? 0 : 1), w) : base;
      },
      v: clamp01((waistU - u) / (waistU - crotchU)) * 0.35,
      crease: 0.15 + 0.55 * pinch,
    };
  };

  const rings: Ring[] = [];
  if (d.clothFold) {
    rings.push({ ...yoke(waistU - 0.055, -0.006), v: 0 });
    rings.push({ ...yoke(waistU - 0.018, -0.002), v: 0.01 });
  }
  for (const u of us) rings.push(yoke(u));
  m.group(GROUP.shorts).loft(rings, seg, { part: PART.SHORTS, side: 0, capEnd: true });

  /* --------------------------------------------------------- leg tubes */
  const g = a.g;
  const hem = d.level === 0 ? 0.46 : 0.44;
  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];
    const suf = SIDE_SUFFIX[si];
    const TH = bi(`thigh${suf}` as BoneName);
    const TT = bi(`thighTwist${suf}` as BoneName);
    const qs = d.level === 0 ? [-0.22, -0.10, 0.02, 0.14, 0.26, 0.37, hem] : [-0.22, 0.04, 0.24, hem];
    const rad = curve([
      [-0.22, g.thighA * 1.10], [-0.10, g.thighA * 1.06], [0.10, g.thighA * 1.00],
      [0.30, g.thighA * 0.93], [0.50, g.thighA * 0.86],
    ]);
    const leg = (q: number, extra: number, flare: number): Ring => {
      const dir = a.legDir[si];
      const az = V(0, 0, 1).addScaledVector(dir, -dir.z).normalize();
      const ax = new THREE.Vector3().crossVectors(dir, az);
      const rr = rad(q) + (0.0175 + extra + flare) * (H / 1.8);
      const w = smooth(0.05, 0.45, q);
      return {
        o: a.hip[si].clone().addScaledVector(dir, a.len.thigh * q),
        ax, az,
        r: ellipse(rr, rr * (g.thighB / g.thighA), [
          // Flatten the inner face so the two legs of the shorts do not fight.
          { at: si === 0 ? 0.5 : 0.0, w: 0.16, amp: -0.10 * smooth(0.0, 0.35, q) },
        ]),
        skin: skMix(hipSkin(si), sk2(TH, 1 - w * 0.72, TT, w * 0.72), smooth(-0.12, 0.16, q)),
        v: 0.35 + 0.65 * clamp01((q + 0.22) / (hem + 0.22)),
        crease: 0.28 * smooth(0.1, -0.1, q) + 0.20 * smooth(0.2, 0.45, q),
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
