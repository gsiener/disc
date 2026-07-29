import * as THREE from 'three';
import { PART, GROUP } from './Types.ts';
import type { FaceParams } from './Types.ts';
import { SIDES, bi } from './Skeleton.ts';
import type { Anthro } from './Skeleton.ts';
import {
  RigMesh, V, ellipse, sk1, sk2, skMix, smooth, lerp, clamp01,
} from './Build.ts';
import type { Ring, Skin, Vec3 } from './Build.ts';
import type { DetailSpec } from './Body.ts';

/**
 * The head. This is the single highest-leverage mesh in the project because the
 * `closeup` shot is framed chest-up, and a featureless ovoid there is worth more
 * negative points than every other asset combined.
 *
 * It is one radially displaced ellipsoid. Every feature — supraorbital ridge,
 * orbital cavity, zygomatic, nasal wedge, philtrum, lips, mentolabial sulcus,
 * gonial angle, occiput — is an additive term evaluated on the unit direction,
 * so the whole face is a pure function of direction and eleven face parameters.
 * Displacements are quoted in units of `headR` (half the head's breadth) rather
 * than in metres, which is what keeps a 1.62 m and a 2.03 m athlete looking
 * like two people rather than one person and one scale model.
 *
 * The underside is *not* spherical: below ny ≈ −0.5 the surface is pulled into
 * the neck column, which is the submandibular funnel. A head that closes into a
 * ball under the jaw reads as a lollipop from every camera below eye level, and
 * a sideline camera is always below eye level.
 */

/** Head-to-neck funnel radius, as a multiple of the neck loft's own radius. */
export const FUNNEL_R = 1.26;

const g1 = (v: number, c: number, w: number) => {
  const d = (v - c) / w;
  return Math.exp(-d * d);
};

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
}

/**
 * The head's normalised coordinate is `ny`, where **0 is the eye line, −1 the
 * chin and +1 the crown** — the canonical artist's head-height ruler. Every
 * feature below is quoted on it, which is why the numbers can be checked against
 * a proportion chart instead of eyeballed:
 *
 *   chin −1.00   lower lip −0.70   mouth −0.63   upper lip −0.57
 *   nose base −0.42   nose tip −0.34   eyes 0   brow +0.13
 *   hairline +0.44   crown +1.00
 */
export function headFrame(a: Anthro): HeadFrame {
  const R = a.g.headR;
  const hh = a.g.headH;
  const ry = hh * 0.50;
  const centre = V(0, a.chinY + hh * 0.50, -0.006 * a.H);
  const rx = R * 0.955;
  const rz = R * 1.10 * (0.96 + 0.10 * a.p.face.skull);
  const er = R * 0.145;
  const eyeN = clamp01(R * (0.345 + 0.070 * a.p.face.eyeW) / rx);
  const hf: HeadFrame = {
    centre, rx, ry, rz, R, eyeN,
    apW: (er * 1.06) / rx,
    apU: (er * (0.38 + 0.46 * a.p.face.eyeOpen)) / ry,
    apD: (er * (0.28 + 0.30 * a.p.face.eyeOpen)) / ry,
    eye: { pos: [V(0, 0, 0), V(0, 0, 0)], r: er },
  };

  // Globe placement is solved against the finished surface, not guessed. Sample
  // the sculpted face straight down the aperture's axis, then sink the globe
  // 0.59 radii behind that point along the surface normal: the cornea then
  // breaks the skin over a chord of 1.6 radii ≈ 20 mm, which is a human eye.
  // Guessing this analytically buried the eyeball on the first three attempts.
  const dir = V(eyeN, 0, Math.sqrt(Math.max(0, 1 - eyeN * eyeN)));
  const p = V();
  faceSurface(a, hf, a.p.face, dir, p);
  // Sink it straight back in Z, NOT along the surface normal. Along the normal
  // the globe also travels medially, into a part of the face that stands
  // further forward, and it disappears inside the skull — which is exactly what
  // happened, twice.
  hf.eye.pos[0].set(p.x, p.y, p.z - 0.55 * er);
  hf.eye.pos[1].set(-p.x, p.y, p.z - 0.55 * er);
  return hf;
}

/** Radius/displacement field. `out` receives the world-space surface point. */
export function faceSurface(a: Anthro, hf: HeadFrame, F: FaceParams, dir: Vec3, out: Vec3): void {
  const nx = dir.x, ny = dir.y, nz = dir.z;
  const ax = Math.abs(nx);
  const front = clamp01(nz);
  const R = hf.R;

  /* --- base ellipsoid, reshaped by region ------------------------------- */
  let rx = hf.rx, ry = hf.ry, rz = hf.rz;
  // Mandible taper: the face narrows from the cheekbones to the chin.
  const low = smooth(-0.10, -0.92, ny);
  rx *= lerp(1, 0.50 + 0.24 * F.jaw, low);
  rz *= lerp(1, 0.84, low * 0.70);
  // Cranial vault: the back of the skull runs longer than the front.
  rz *= 1 + 0.11 * (F.skull - 0.5) * clamp01(-nz);
  // Temporal flattening — the sides above the ears are planes, not arcs.
  rx *= 1 - 0.085 * g1(ny, 0.42, 0.34) * ax * ax * ax;
  // The forehead leans back a little above the brow.
  rz *= 1 - 0.10 * g1(ny, 0.68, 0.30) * front;
  // The cranium is wider than the face across its widest point (parietals).
  rx *= 1 + 0.045 * g1(ny, 0.30, 0.35);

  out.set(nx * rx, ny * ry, nz * rz);

  /* --- radial features -------------------------------------------------- */
  let d = 0;
  // Supraorbital ridge, strongest over the medial half of each brow.
  d += R * (0.050 + 0.115 * F.brow) * g1(ny, 0.130, 0.115) * front * g1(ax, 0.26, 0.30);
  // Glabella dip between the brows.
  d -= R * 0.024 * g1(ny, 0.150, 0.070) * g1(nx, 0, 0.060) * front;
  // Zygomatic arch and the hollow under it.
  d += R * (0.055 + 0.100 * F.cheek) * g1(ny, -0.200, 0.150) * g1(ax, 0.580, 0.240) * clamp01(nz + 0.30);
  d -= R * 0.080 * (1 - 0.45 * F.cheek) * g1(ny, -0.480, 0.150) * g1(ax, 0.500, 0.200) * front;
  // Gonial angle — where a jaw stops being a chin and starts being a jaw.
  d += R * (0.025 + 0.075 * F.jaw) * g1(ny, -0.580, 0.180) * g1(ax, 0.700, 0.240) * clamp01(nz + 0.55);
  // Mental protuberance and the sulcus above it.
  d += R * (0.075 + 0.120 * F.chin) * g1(ny, -0.880, 0.170) * g1(nx, 0, 0.300) * clamp01(nz - 0.05);
  d -= R * 0.068 * g1(ny, -0.750, 0.065) * g1(nx, 0, 0.280) * clamp01(nz - 0.15);
  // Occiput.
  d += R * 0.060 * g1(ny, 0.150, 0.360) * clamp01(-nz - 0.28);
  // Nuchal shelf under the occiput.
  d -= R * 0.050 * g1(ny, -0.450, 0.190) * clamp01(-nz - 0.30);
  // Alae of the nose.
  const alae = g1(ny, -0.410, 0.080) * g1(ax, 0.140 + 0.048 * F.noseW, 0.065) * clamp01(nz * 1.5 - 0.2);
  d += R * (0.060 + 0.050 * F.noseW) * alae;
  d -= R * 0.034 * g1(ny, -0.460, 0.050) * g1(ax, 0.195 + 0.05 * F.noseW, 0.058) * clamp01(nz - 0.2);
  // Lips: two ridges with a crease between and a philtrum above.
  const lipX = g1(nx, 0, 0.230 + 0.055 * F.lips);
  d += R * (0.068 + 0.080 * F.lips) * g1(ny, -0.570, 0.048) * lipX * clamp01(nz * 1.4 - 0.30);
  d += R * (0.075 + 0.088 * F.lips) * g1(ny, -0.700, 0.056) * lipX * clamp01(nz * 1.4 - 0.30);
  d -= R * 0.090 * g1(ny, -0.632, 0.022) * g1(nx, 0, 0.270) * clamp01(nz * 1.4 - 0.30);
  d -= R * 0.030 * g1(ny, -0.490, 0.045) * g1(nx, 0, 0.050) * clamp01(nz - 0.35);
  // Nasolabial folds.
  d -= R * 0.050 * g1(ny, -0.530, 0.095) * g1(ax, 0.265, 0.075) * clamp01(nz - 0.30);

  if (d !== 0) {
    const len = Math.hypot(out.x, out.y, out.z) || 1;
    out.multiplyScalar(1 + d / len);
  }

  /* --- orbit, palpebral aperture and the two lid folds ------------------- */
  // These are applied as PURE DEPTH, after the radial pass, and that distinction
  // is load-bearing. A radial socket also drags the surface inward in x, so the
  // un-recessed skin just outboard of it stays further forward and forms an
  // overhang that swallows the eyeball whole. It did, for four iterations.
  // Sculpting the lids into the face also beats building them as their own
  // shell: at 12 mm of globe radius there is no gap to put a separate lid in.
  if (nz > 0.12) {
    const ddx = ax - hf.eyeN;
    const q = (ddx * ddx) / (hf.apW * hf.apW)
      + (ny * ny) / (ny > 0 ? hf.apU * hf.apU : hf.apD * hf.apD);
    const front = clamp01(nz * 1.7 - 0.10);
    let dz = 0;
    dz -= R * 0.115 * g1(ny, 0.005, 0.165) * g1(ax, 0.400, 0.275) * front;
    if (q < 9) {
      dz -= R * 0.075 * smooth(1.70, 0.40, q) * front;
      const k = (q - 1.85) / 0.75;
      dz += R * (ny > 0 ? 0.060 : 0.032) * Math.exp(-k * k) * front;
    }
    out.z += dz;
  }

  /* --- the nose is a wedge, not a bump ---------------------------------- */
  const proj = smooth(0.190, -0.180, ny) * smooth(-0.520, -0.400, ny);
  if (proj > 0.001 && nz > -0.1) {
    const w = lerp(0.080, 0.170 * (0.72 + 0.55 * F.noseW), smooth(0.10, -0.34, ny));
    const lat = g1(nx, 0, w);
    const amt = R * (0.105 + 0.115 * F.nose) * proj * lat * clamp01(nz * 2.2);
    out.z += amt;
    out.y -= amt * 0.22 * smooth(-0.20, -0.44, ny);
  }

  /* --- below the jawline the head funnels into the neck ----------------- */
  // The jawline is not a level ring: it sits at the chin in front, rises to the
  // gonion at the sides and higher still at the nape. A level cut is what makes
  // a procedural head read as a lollipop from any camera below eye level, and a
  // sideline camera is always below eye level.
  const jawNy = -0.66 - 0.46 * clamp01(nz) + 0.36 * clamp01(-nz);
  const under = smooth(jawNy + 0.10, jawNy - 0.34, ny);
  if (under > 0) {
    // FUNNEL_R must stay comfortably clear of the neck loft's own radius. When
    // the two matched exactly the surfaces z-fought and shattered the entire jaw
    // into polygon shards — which reads as a normals bug and is not one.
    const nr = a.g.neckA * FUNNEL_R;
    const nzr = a.g.neckB * FUNNEL_R;
    const h = Math.hypot(out.x, out.z) || 1e-5;
    const tx = (out.x / h) * nr;
    const tz = (out.z / h) * nzr - a.H * 0.005;
    const ty = a.chinY - hf.centre.y - a.g.headH * 0.16;
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
  m.group(GROUP.skin).sphereish(
    d.headU, d.headV,
    (dir, _u, _v, out) => {
      if (d.face) faceSurface(a, hf, F, dir, out);
      else {
        const low = smooth(-0.10, -0.92, dir.y);
        out.set(dir.x * hf.rx * lerp(1, 0.60, low), dir.y * hf.ry, dir.z * hf.rz * lerp(1, 0.86, low));
        const jawNy = -0.66 - 0.46 * clamp01(dir.z) + 0.36 * clamp01(-dir.z);
        const under = smooth(jawNy + 0.10, jawNy - 0.34, dir.y);
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
      warpU: 0.55, warpV: 0.34,
      creaseFn: (_p, u, v) => {
        // Orbit, nasolabial fold and the lip line, so a skin shader has cavity
        // information without a baked AO map.
        const phi = v * Math.PI;
        const th = u * Math.PI * 2;
        const ny = Math.cos(phi);
        const nz = Math.sin(phi) * Math.cos(th);
        const nx = Math.sin(phi) * Math.sin(th);
        const ax = Math.abs(nx);
        const fr = clamp01(nz);
        const jawNy = -0.66 - 0.46 * clamp01(nz) + 0.36 * clamp01(-nz);
        return clamp01(
          0.85 * g1(ny, 0.005, 0.11) * g1(ax, 0.40, 0.18) * fr
          + 0.55 * g1(ny, -0.632, 0.028) * g1(nx, 0, 0.26) * fr
          + 0.45 * g1(ny, -0.530, 0.080) * g1(ax, 0.265, 0.075) * fr
          + 0.30 * g1(ny, -0.750, 0.065) * g1(nx, 0, 0.26) * fr
          + 0.20 * g1(ny, -0.480, 0.15) * g1(ax, 0.50, 0.20) * fr
          + 0.55 * smooth(jawNy + 0.05, jawNy - 0.35, ny),
        );
      },
    },
  );

  if (d.ears) buildEars(m, a, hf);
  if (d.eyes) buildEyes(m, a, hf, d);
  buildHair(m, a, hf, d);
}

/* ------------------------------------------------------------------- ears */

function buildEars(m: RigMesh, a: Anthro, hf: HeadFrame): void {
  const F = a.p.face;
  const R = hf.R;
  const h = R * (0.30 + 0.09 * F.ears);
  const w = R * (0.155 + 0.050 * F.ears);
  const out = R * (0.085 + 0.075 * F.ears);
  // Ear centre sits at ny ≈ −0.10: the top of the helix lines up with the brow
  // and the lobe with the base of the nose, which is the check every portrait
  // painter runs and the one thing that stops an ear looking stuck on.
  const cy = hf.centre.y - hf.ry * 0.10;
  const cz = hf.centre.z - hf.rz * 0.20;
  // Five rings: base, helix rising, helix crest, rolled rim, recessed concha.
  const PUSH = [0.0, 0.60, 1.0, 0.78, 0.18];
  const SCALE = [0.78, 1.0, 0.90, 0.58, 0.26];
  for (const s of SIDES) {
    const cx = s * hf.rx * 0.98;
    const rings: Ring[] = [];
    for (let k = 0; k < PUSH.length; k++) {
      rings.push({
        o: V(cx + s * out * PUSH[k], cy + h * 0.10 * PUSH[k], cz - w * 0.35 * PUSH[k]),
        ax: V(0, 1, 0), az: V(0, 0, 1),
        r: (t: number) => {
          const th = t * Math.PI * 2;
          // Outline: taller than wide, lobe rounded, helix squared at the top.
          const rr = 1 + 0.15 * Math.cos(th) - 0.11 * Math.cos(2 * th);
          return [Math.cos(th) * h * rr * SCALE[k], Math.sin(th) * w * rr * SCALE[k]];
        },
        skin: sk1(bi('head')),
        v: k / (PUSH.length - 1),
        crease: k >= 3 ? 0.75 : 0.15,
      });
    }
    m.group(GROUP.skin).loft(rings, 12, {
      part: PART.EAR, side: s, capStart: false, capEnd: true, flip: s > 0,
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
  const su = d.level === 0 ? 16 : 9;
  const sv = d.level === 0 ? 11 : 6;
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
function hairline(u: number, style: string, F: FaceParams): number {
  // u is the sphereish azimuth: sin(th) → x, cos(th) → z, so u = 0 faces +Z.
  const th = u * Math.PI * 2;
  const front = Math.cos(th);
  // Polar angle from the crown. Forehead 1.10 rad (ny ≈ +0.45, the standard
  // hairline), temples 1.36 (just above the ear), nape 1.85. A level ring around
  // the skull is the classic swim-cap tell.
  let phi = 1.36 - 0.26 * clamp01(front) + 0.49 * clamp01(-front);
  // A slight widow's peak — the hairline dips lower on the midline.
  phi += 0.065 * Math.pow(clamp01(front), 6);
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
  const th0 = (HAIR_THICK[style] ?? 0.09) * hf.R * bulk;
  const su = Math.max(8, Math.round(d.headU * 0.8));
  const sv = Math.max(4, Math.round(d.headV * 0.45));

  m.group(GROUP.hair).sphereish(su, sv, (_dir, u, v, out) => {
    const phiMax = hairline(u, style, F);
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
    // outline even when it is short.
    const thz2 = u * Math.PI * 2;
    vol *= 1 + 0.22 * Math.cos(thz2 * 3 + 0.7) * (0.4 + 0.6 * v)
      + 0.13 * Math.cos(thz2 * 5 - 1.4)
      + 0.10 * Math.cos(v * 7.3 + thz2 * 2);
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
        r: ellipse(rr, rr * 0.82), skin: sk1(bi('head')), v: u, crease: 0.2 + 0.3 * u,
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
