import * as THREE from 'three';
import { bake } from '../../util/Tex.ts';
import { valueNoise2, clamp, smoothstep } from '../../util/Noise.ts';
import { texBytes } from './Glsl.ts';
import type { MatDetail } from './Shared.ts';

/**
 * ============================================================================
 *  FACE MAP — the face's regional albedo, as a raster in the head's own uv
 * ============================================================================
 *
 * WHY THIS EXISTS. Until this file, every piece of REGIONAL colour on a face —
 * the cavity lobes, the brow, the lash line, the vermilion, the perfusion —
 * was evaluated analytically, in 3D, per pixel, inside `Skin.ts`. That failed
 * in two measured ways, and both are sampling failures rather than shading
 * ones:
 *
 *   1. NO FILTERING. An analytic Gaussian has no mip chain. At the `endzone`
 *      framing a head is 25-50 px, so a 2 mm lash line is a third of a pixel
 *      and the shader POINT-SAMPLES it: whatever the lobe happens to evaluate
 *      to at that pixel centre is what you get. That is why the orbital region
 *      reads bright at distance no matter how dark it is made up close — the
 *      dark parts fall between samples. A raster with mips returns the AREA
 *      MEAN, which is the only thing that can hold a value relationship across
 *      a 10x change in head size.
 *
 *   2. EVERY SOFT EDGE HAD TO BE HAND-BUILT. Thirty analytic lobes summed and
 *      clamped means thirty chances to leave a `smoothstep` whose shoulder
 *      lands on a surface contour and draws a ring round the head. C1
 *      continuity was an engineering exercise per lobe; in a raster that is
 *      blurred once it is a property of the buffer.
 *
 * WHY UV WORKS HERE. The head is one radially displaced ellipsoid built by
 * `RigMesh.sphereish`, so `uv` IS the sphere parameterisation and `headDir(uv)`
 * reconstructs the sculptor's own unit direction exactly (see `Glsl.ts`). There
 * is no seam, no chart and no packing to solve: the map is a rectangle in
 * (azimuth, polar angle) and it is *the same* coordinate the analytic lobes
 * were already written in. Nothing had to be re-authored to move.
 *
 * WHAT IS STORED, and what is deliberately NOT.
 *
 *      R   cavity          the concave AO structure of the front of the face
 *      G   orbital frame   brow + lid margin + lash, as one connected mass
 *      B   lip, SIGNED     > 0.5 vermilion, < 0.5 the pale vermilion border
 *      A   perfusion       nose, malar, chin
 *
 * The broad, monotone terms that were never the problem stay analytic in
 * `Skin.ts`: the submandibular shadow, the temple, the ear gutter, the scalp,
 * the beard zone, the sweat zone and the roughness field. They are single
 * smoothsteps over half a head, they are C1 by construction, and rasterising
 * them would cost bytes to buy nothing. This file is the fine, clustered,
 * front-of-face structure and nothing else.
 *
 * EXTENT. Half of the front hemisphere: azimuth 0-90 degrees off the nose, and
 * `uv.y` in [0, 0.66] which is everything from the mid-forehead to under the
 * chin. Every field here is symmetric about the facial midline — they always
 * were, they are all written on `|nx|` — so storing one side and folding the
 * lookup halves the bytes for nothing. Asymmetry on this roster is carried by
 * the SCULPT (`faceVar.asym`), where it belongs; the old per-brow noise
 * asymmetry was an aliasing artefact, not a face.
 *
 * MEMORY, and why it is per-player. Landmark spread across the roster is not
 * small: mouth half-width runs 0.239-0.380 in nx (a 45 mm mouth against a
 * 60 mm one), the palpebral aperture varies by a fifth of its height, and the
 * eye centre moves 2.7 mm. A shared map would need a per-player warp of the
 * lookup to put a lip on a lip, which is more shader maths than the thirty
 * lobes it replaced. So the map is baked per athlete, and the size is chosen
 * against the only framing in the shot list that shows a face large:
 *
 *      closeup delivers 1.74 px/mm, so at 192 x 288 one texel is 0.64 mm,
 *      i.e. 1.1 screen pixels. The map is at Nyquist for the frame it is
 *      judged in, and 5-8x finer than the mesh that carries it (the head is
 *      tessellated at 3.6 mm at the eye line and 4.9 mm at the lip line).
 *
 * Going finer buys sub-pixel detail, which the face-direction brief spends a
 * whole section forbidding. So the cost is 295 kB per athlete at `high` and
 * `ultra`, 4.1 MB for a fourteen-athlete roster, against ~11 MB of shared
 * detail maps. `PlayerMaterialLibrary.report()` states the measured total —
 * do not estimate it from this comment.
 */

/** uv.y extent of the patch. 0.66 puts its top edge at ny +0.48, above the brow. */
export const FACE_V_TOP = 0.66;

/** Landmarks the bake is keyed to. Read off the rig's own `headFrame`. */
export interface FaceLandmarks {
  /** |nx| of the eye centre. */
  eyeN: number;
  /** Palpebral aperture half-sizes, unit-direction space. */
  apW: number; apU: number; apD: number;
  /** Mouth half-width in nx. */
  mouthW: number;
  /** Nose tip, ny. */
  noseTip: number;
  /** Brow prominence, 0-1. */
  brow: number;
}

export interface FaceMapTexture {
  texture: THREE.DataTexture;
  bytes: number;
  width: number;
  height: number;
}

/**
 * Texel budget per tier. The aspect is fixed by the patch: a quarter of the
 * head's circumference is about 123 mm across and the forehead-to-chin arc is
 * about 190 mm, so 2:3 keeps texels square on the face.
 */
const SIZES: Record<MatDetail, [number, number]> = {
  0: [96, 144],    // 1.28 mm/texel
  1: [128, 192],   // 0.96 mm/texel
  2: [192, 288],   // 0.64 mm/texel — one texel is 1.1 px at the closeup framing
};

export function faceMapSize(q: MatDetail): [number, number] {
  return SIZES[q] ?? SIZES[2];
}

/* --------------------------------------------------------------- kernels */

/**
 * exp(-t^2) from a table. The field below evaluates about twenty of these per
 * texel across 55 k texels per athlete, and `Math.exp` there is most of the
 * bake. Four decimal places is far more than a buffer that is about to be
 * blurred and quantised to eight bits can carry.
 */
const GT = 1024;
const GAUSS = (() => {
  const t = new Float32Array(GT + 1);
  for (let i = 0; i <= GT; i++) {
    const x = (i / GT) * 4;
    t[i] = Math.exp(-x * x);
  }
  return t;
})();

/** exp(-((v - c)/w)^2), zero past four sigma. */
function g1(v: number, c: number, w: number): number {
  const d = Math.abs((v - c) / w);
  if (d >= 4) return 0;
  const f = d * (GT / 4);
  const i = f | 0;
  return GAUSS[i] + (GAUSS[i + 1] - GAUSS[i]) * (f - i);
}

/* ------------------------------------------------------------ the field */

/**
 * Evaluate the four channels into `dst`, planar, `W*H` floats each.
 *
 * Pure: no THREE, no DOM, no randomness beyond the seeded hash in
 * `util/Noise.ts`. That is deliberate — it means the continuity of the map can
 * be asserted offline, on the buffer, instead of only being visible in a
 * screenshot.
 */
export function faceField(
  lm: FaceLandmarks, seed: number, W: number, H: number,
): [Float32Array, Float32Array, Float32Array, Float32Array] {
  const N = W * H;
  const cav = new Float32Array(N);
  const orb = new Float32Array(N);
  const lip = new Float32Array(N);
  const per = new Float32Array(N);

  const mw = lm.mouthW;
  const nt = lm.noseTip;
  const apW2 = lm.apW * lm.apW;
  const apU2 = lm.apU * lm.apU;
  const apD2 = lm.apD * lm.apD;
  // Brow hair, per athlete. The seed is the rig's own, so a face and its brows
  // come off the same die roll and a re-run reproduces both.
  const bseed = (seed * 2654435761) >>> 0;

  for (let y = 0; y < H; y++) {
    const uvY = ((y + 0.5) / H) * FACE_V_TOP;
    const phi = (1 - uvY) * Math.PI;
    const hy = Math.cos(phi);
    const sp = Math.sin(phi);
    // Fade the top edge of the patch to nothing over four rows so the clamp
    // outside it can never step. The bottom edge is the pole under the chin,
    // where every field here is already zero.
    const vFade = smoothstep(1, 1 - 5 / H, (y + 0.5) / H);
    for (let x = 0; x < W; x++) {
      const th = ((x + 0.5) / W) * (Math.PI * 0.5);
      const axf = sp * Math.sin(th);
      const hz = sp * Math.cos(th);
      const fr = hz < 0 ? 0 : hz > 1 ? 1 : hz;
      // Same monotone front gate the analytic version used, and for the same
      // reason: a smoothstep on hz completes at a fixed surface angle and
      // draws a contour ring there. hz^1.5 has no level set to find.
      const faceFront = fr * Math.sqrt(fr);
      const hFade = smoothstep(1, 1 - 5 / W, (x + 0.5) / W);
      const edge = vFade * hFade;
      const i = y * W + x;

      /* ---- R: cavity ------------------------------------------------- */
      // An occlusion term is information only while it is NARROW. Every lobe
      // is sized to the concavity it stands for; the convexities the light
      // should find are left at zero on purpose.
      const ddx = axf - lm.eyeN;
      const apV2 = hy > 0 ? apU2 : apD2;
      const qq = Math.sqrt((ddx * ddx) / apW2 + (hy * hy) / apV2);
      let c = 0;
      // Orbit, keyed to the palpebral ellipse the sculpt actually has, deepest
      // just above the globe where the supraorbital ridge overhangs it.
      c += 0.52 * g1(qq, 0.55, 0.45) * faceFront
        * (0.62 + 0.38 * smoothstep(-0.10, 0.16, hy));
      // Tear trough. Down from 0.30: with the malar perfusion lobe removed
      // from under it (see A below) it no longer has to fight anything, and
      // the trough + flush + crease stack was the "bleeding tear duct".
      c += 0.18 * g1(hy, -0.150, 0.055) * g1(axf, lm.eyeN * 0.80, 0.130) * fr;
      // Nasal side wall, alar crease, nostril sill.
      c += 0.34 * g1(axf, 0.115, 0.055) * g1(hy, nt + 0.055, 0.130) * fr;
      c += 0.42 * g1(hy, nt - 0.035, 0.045) * g1(axf, 0.190, 0.048) * fr;
      c += 0.52 * g1(hy, nt - 0.075, 0.032) * g1(axf, 0.0, 0.115) * fr;
      // Nasolabial fold.
      c += 0.40 * g1(hy, -0.590, 0.090) * g1(axf, 0.260, 0.045) * fr;
      // THE ORAL LINE. Colour is the only channel a mouth has at this framing
      // — the sculpt's own lip line is a 1.6 mm feature on a mesh with a
      // 4.9 mm row pitch, so the geometry provably cannot carry it. In a
      // raster at 0.64 mm it is two and a half texels wide and it survives,
      // so it is worth spending on: up from 0.34 and narrowed from 0.030,
      // and keyed to this athlete's mouth width rather than a fixed 0.230.
      c += 0.62 * g1(hy, -0.655, 0.022) * g1(axf, 0.0, mw * 0.95) * fr;
      // Mentolabial sulcus.
      c += 0.36 * g1(hy, -0.795, 0.038) * g1(axf, 0.0, 0.210) * fr;
      // The submalar hollow is GONE. It is sculpted in rig/Head.ts, it is
      // painted again by the hemisphere tint, and a third copy here is most
      // of why the roster reads gaunt.
      cav[i] = clamp(c, 0, 0.55) * edge;

      /* ---- G: the orbital frame -------------------------------------- */
      // Brow, lid margin and lashes as ONE connected dark mass. At endzone
      // range this is the whole eye: a 2-3 px bar at 0.6-0.8x face mean, in
      // place of the white dot the lidless sclera leaves behind.
      const bt = clamp((axf - 0.13) / 0.46, 0, 1);
      const browY = 0.086 + 0.090 * Math.sin(bt * Math.PI) - 0.052 * bt * bt;
      const browTh = 0.048 * (1 - 0.38 * bt) * (0.80 + 0.45 * lm.brow);
      const browMask = fr * smoothstep(0.66, 0.56, axf) * smoothstep(0.095, 0.155, axf)
        * g1(hy, browY, browTh);
      // 2.0 mm cells, up from the 1.3 mm the analytic version used. At 1.3 mm
      // a cell was two pixels at the closeup framing — the aliasing floor —
      // which is why one brow came back a clean arc and the other came back
      // speckle on the same face. A brow is about 35 hairs deep, not 900.
      const bn = valueNoise2(axf * 34 + hy * 5, (hy - browY) * 58, bseed);
      // Solid through the middle, broken only in the outer quarter. A brow
      // that breaks up over its whole length is not a brow, it is stubble on
      // a forehead.
      const brk = smoothstep(0.55, 0.92, bt);
      const core = g1(hy, browY, browTh * 0.62);
      const tex = 0.45 + 0.70 * smoothstep(0.26, 0.72, bn);
      let brow = browMask * (1 - brk * 0.85 * (1 - Math.min(1, tex)));
      brow = Math.max(brow, browMask * core * 1.05);
      // Lid margin and lashes: ONE profile whose centre, width and weight run
      // off ny, replacing a lid line, a lash line and a splay term that were
      // three Gaussians describing the same edge. Broken lashes only read
      // inside 1.5 m; the LINE reads at every distance in the shot list.
      const lidGate = clamp(hz * 3.0 - 0.42, 0, 1);
      const up = hy > 0;
      const lash = lidGate * (up ? 1.15 : 0.52)
        * g1(qq, up ? 1.10 : 1.02, up ? 0.17 : 0.11);
      orb[i] = clamp(brow * 1.25 + lash * 1.45, 0, 1) * edge;

      /* ---- B: the lip, signed ---------------------------------------- */
      // The colour of the lip has to reach as far as the sculpt of the lip:
      // the sculpt fades over 1.10 -> 0.55 of the half-width, so match it. A
      // vermilion two thirds the width of the mouth the geometry has is one
      // of the three or four cues that read a face as juvenile.
      const lipX = smoothstep(mw * 1.12, mw * 0.86, axf);
      // A VERMILION IS ONE SOLID MASS, NOT TWO RIBBONS.
      //
      // This was a pair of Gaussians on the two vermilions, and the pair never
      // got out of its own way: measured off the rendered closeup with the mask
      // written into the albedo (uDbg = 2 in Skin.ts), `lips` peaked at 0.72
      // and averaged 0.54 over the mouth the frame resolves — because between
      // the two centres the sum only reaches 0.49, so the middle of the mouth,
      // which is most of its area, was masked at about half strength. Every
      // round then read the vermilion at ~0.95x the philtrum, blamed the
      // rotation, and deepened it; the rotation was never the problem.
      //
      // A plateau with a soft shoulder instead. 0.052 in ny is ~6 mm either
      // side of the oral line, so the mass is solid across a 12 mm core and
      // fades out by 22 mm, which is an adult vermilion measured top to bottom.
      // `lips` now averages ~0.85 over the same box, so the SAME rotation would
      // have arrived 60 % stronger — which is why it comes down below.
      const lipMass = smoothstep(0.100, 0.052, Math.abs(hy + 0.657));
      let lips = clamp(lipX * clamp(hz * 1.6 - 0.38, 0, 1) * lipMass, 0, 1);
      // The lip LINE is carried by the R channel now (0.62 at 2.5 mm, the
      // strongest single term in the map), so the colour channel no longer has
      // to carve itself in half to make room for it: 0.80 -> 0.42 -> 0.30.
      lips *= 1 - 0.30 * g1(hy, -0.655, 0.016);
      // The pale vermilion border, at half its old weight and widened to
      // 1.4 mm so it resolves as a roll instead of aliasing as a drawn line.
      // At full strength it read as lip liner, which is the note it got. The
      // centres sit just OUTSIDE the mass's shoulders — inside them the signed
      // encoding below would subtract the roll straight back out of the
      // vermilion and re-open the valley this change just closed.
      const roll = 0.5 * lipX * fr * (g1(hy, -0.548, 0.012) + g1(hy, -0.767, 0.013));
      lip[i] = clamp(0.5 + 0.5 * (lips - roll), 0, 1) * edge + 0.5 * (1 - edge);

      /* ---- A: perfusion ---------------------------------------------- */
      // NO PERFUSION LOBE MAY SHARE A CENTRE WITH A CAVITY LOBE. Where they
      // coincide the same square centimetre goes darker AND redder AND is
      // creased, and three agreeing terms do not read as modelling, they read
      // as an injury. The malar lobe is halved and the submalar cavity that
      // used to sit under it is deleted; the nasal lobe is lifted clear of
      // the nostril sill.
      let f = 0.45 * g1(hy, nt + 0.030, 0.085) * g1(axf, 0.0, 0.140);
      f += 0.20 * g1(hy, -0.30, 0.19) * g1(axf, 0.54, 0.22);
      f += 0.26 * g1(hy, -0.90, 0.15) * g1(axf, 0.0, 0.28);
      per[i] = clamp(f * fr, 0, 1) * edge;
    }
  }
  return [cav, orb, lip, per];
}

/* ------------------------------------------------------------------ blur */

/**
 * Separable [1,2,1], `n` passes, replicating at the borders — except the
 * facial midline, which MIRRORS. The map stores one side of a symmetric field,
 * so replicating there would flatten the philtrum and the nose ridge into a
 * two-texel plateau; mirroring reproduces exactly what the other half would
 * have contributed.
 *
 * This is the whole reason the map exists. C1 continuity across every one of
 * these lobes stops being something that has to be engineered per lobe and
 * becomes a property of the buffer: after one pass no two adjacent texels can
 * differ by more than half the local gradient, whatever the lobes did.
 */
function blur(a: Float32Array, W: number, H: number, n: number): void {
  const t = new Float32Array(a.length);
  for (let p = 0; p < n; p++) {
    for (let y = 0; y < H; y++) {
      const r = y * W;
      for (let x = 0; x < W; x++) {
        // x = 0 is the facial midline: the neighbour off the left edge is the
        // mirror of the neighbour to the right.
        const l = a[r + (x === 0 ? 0 : x - 1)];
        const c = a[r + x];
        const s = a[r + (x === W - 1 ? W - 1 : x + 1)];
        t[r + x] = (l + 2 * c + s) * 0.25;
      }
    }
    for (let y = 0; y < H; y++) {
      const r = y * W;
      const up = (y === 0 ? 0 : y - 1) * W;
      const dn = (y === H - 1 ? H - 1 : y + 1) * W;
      for (let x = 0; x < W; x++) {
        a[r + x] = (t[up + x] + 2 * t[r + x] + t[dn + x]) * 0.25;
      }
    }
  }
}

/* ------------------------------------------------------------------ bake */

export function bakeFaceMap(
  lm: FaceLandmarks, seed: number, quality: MatDetail, anisotropy = 8,
): FaceMapTexture {
  const [W, H] = faceMapSize(quality);
  const [cav, orb, lip, per] = faceField(lm, seed, W, H);
  // The orbital frame carries the only noise in the map, so it gets the extra
  // pass; the rest are sums of Gaussians and are already smooth. One pass is
  // enough to guarantee no single-texel spike survives to the mip chain.
  blur(cav, W, H, 1);
  blur(orb, W, H, 2);
  blur(lip, W, H, 1);
  blur(per, W, H, 1);

  const texture = bake((x, y, _u, _v, out, i) => {
    const j = y * W + x;
    out[i] = cav[j] * (255 / 0.55);
    out[i + 1] = orb[j] * 255;
    out[i + 2] = lip[j] * 255;
    out[i + 3] = per[j] * 255;
  }, {
    size: W, height: H,
    colorSpace: THREE.NoColorSpace,
    wrap: THREE.ClampToEdgeWrapping,
    anisotropy: Math.max(4, Math.min(16, anisotropy)),
    name: 'player.face',
  });

  return { texture, bytes: texBytes(texture), width: W, height: H };
}
