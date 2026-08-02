import * as THREE from 'three';
import { PART, GROUP, FINGERS } from './Types.ts';
import type { BoneName, Measure } from './Types.ts';
import { SIDES, SIDE_SUFFIX, bi, PHALANX } from './Skeleton.ts';
import type { Anthro } from './Skeleton.ts';
import { RigMesh, V, ellipse, lobe, sk1, sk2, smooth, lerp, clamp01 } from './Build.ts';
import type { Ring, Vec3, Lobe } from './Build.ts';
import type { DetailSpec } from './Body.ts';

/**
 * Hands. A disc is *gripped* — thumb on the flight plate, four fingers curled
 * under the rim — and a claw catch is two hands clamping that rim from opposite
 * sides. Mitten hands make both of those read as a mime, so at the hero LOD
 * every one of the fifteen digit bones per hand carries real geometry.
 *
 * The palm is a loft; each phalanx is a three-ring loft that starts a little
 * proximal of its joint so the segments overlap and a 90-degree curl does not
 * open a gap at the knuckle.
 *
 * At LOD1/2 the fingers collapse into the palm loft as a tapered mitt. The
 * silhouette is preserved (same length, same width, same splay envelope) so the
 * LOD switch is a change of smoothness rather than a change of shape.
 */

/**
 * Digit radius as a fraction of the hand's half breadth. With the knuckles now
 * 2.1 cm apart (see `FINGER_SPAN` in Skeleton.ts) a 0.255 index — 2.2 cm thick —
 * still swallowed its neighbours. An adult index finger is 1.9 cm across at the
 * proximal phalanx, which on an 8.7 cm hand is 0.222.
 */
const FING_R = [0.285, 0.222, 0.230, 0.212, 0.185];

function palmFrame(a: Anthro, si: number): { y: Vec3; z: Vec3; x: Vec3 } {
  const y = a.handDir[si].clone();
  const z = a.volar[si].clone().addScaledVector(y, -a.volar[si].dot(y)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return { y, z, x };
}

export function buildHands(m: RigMesh, a: Anthro, meas: Measure, d: DetailSpec): void {
  const g = a.g;
  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];
    const suf = SIDE_SUFFIX[si];
    const HB = bi(`hand${suf}` as BoneName);
    const FT = bi(`foreArmTwist${suf}` as BoneName);
    const { y: yh, z: zh, x: xh } = palmFrame(a, si);
    const wrist = a.wrist[si];
    const palmLen = a.len.hand * 0.46;
    const segs = d.level === 0 ? 12 : d.level === 1 ? 8 : 6;

    // Palm — flat, with a thenar mass on the thumb side and a hypothenar pad on
    // the other. A round-sectioned hand is a glove full of air.
    const rings: Ring[] = [];
    // The palm starts a third of a palm-length BEHIND the wrist, inside the
    // forearm. The arm loft stops 1.5 % short of the wrist and neither surface
    // is capped there, so butting them left an open 4 mm band all the way round
    // every wrist — a black ring in any crop that includes a hand.
    const qs = d.fingers ? [-0.20, -0.06, 0.10, 0.32, 0.58, 0.80, 1.0, 1.10]
      : [-0.20, -0.04, 0.20, 0.50, 0.80, 1.06, 1.42, 1.76, 1.96, 2.05];
    for (const q of qs) {
      const along = q * palmLen;
      const o = wrist.clone().addScaledVector(yh, along);
      // Past the knuckle line the mitt closes; before it, the palm widens. The
      // proximal loops are a cuff over the end of the forearm, so they have to
      // be wider than the forearm is there, not narrower.
      /**
       * THE MITT MUST NOT TAPER TO A POINT.
       *
       * `LOD_DISTANCE` is [0, 7.5, 24] and the tele broadcast camera sits about
       * 48 m from the play, so level 2 — `fingers: false` — is the hand every
       * gameplay frame actually renders. This closing curve took the width to
       * 0.38 of the knuckle breadth and the thickness to 0.45 of it, which is a
       * cone, and a cone on the end of a forearm reads exactly as the note a
       * critic wrote against the live frames: "forearms taper to nubs".
       *
       * Four fingers held together are about two thirds of the knuckle breadth
       * at the fingertips and barely thin at all through the middle phalanges,
       * so the closure is much later and much gentler. The exponent comes down
       * with it: 1.5 front-loads the taper into the first third of the mitt,
       * where a real hand is at its widest.
       */
      const wid = q <= 1.10
        ? lerp(g.wristA * 1.14, g.handW, smooth(-0.10, 0.55, q)) * (1 - 0.10 * smooth(0.9, 1.1, q))
        : g.handW * (1 - 0.34 * smooth(1.10, 2.05, q) ** 2.2);
      const thick = q <= 1.10
        ? lerp(g.wristB * 1.22, g.handT * 1.30, smooth(-0.10, 0.5, q)) * (1 - 0.18 * smooth(0.7, 1.1, q))
        : g.handT * 1.10 * (1 - 0.38 * smooth(1.10, 2.05, q) ** 2.0);
      const lobes: Lobe[] = [];
      const thenar = smooth(0.05, 0.35, q) * smooth(1.15, 0.80, q);
      if (thenar > 0.01) {
        // Volar side is t = 0.25 (az = zh = palm normal).
        lobes.push({ at: s > 0 ? 0.36 : 0.14, w: 0.10, amp: 0.30 * thenar });
        lobes.push({ at: s > 0 ? 0.16 : 0.34, w: 0.09, amp: 0.18 * thenar });
      }
      if (q > 0.85 && q < 1.25 && d.fingers) {
        // Metacarpal heads read as four soft knuckles across the dorsum.
        const k = smooth(0.85, 1.02, q) * smooth(1.25, 1.05, q);
        for (const kn of [-0.30, -0.10, 0.10, 0.30]) {
          lobes.push({ at: 0.75 + (-s * kn) * 0.16, w: 0.05, amp: 0.14 * k });
        }
      }
      rings.push({
        o, ax: xh, az: zh,
        r: ellipse(wid, thick, lobes),
        skin: q < 0.34
          ? sk2(FT, smooth(0.34, -0.16, q) * 0.88, HB, 1 - smooth(0.34, -0.16, q) * 0.88)
          : sk1(HB),
        v: clamp01((q + 0.20) / 2.25),
        crease: (t: number) => 0.22 * lobe(t, 0.25, 0.22) * smooth(0.2, 0.9, q),
      });
    }
    m.group(GROUP.skin).loft(rings, segs, {
      part: PART.HAND, side: s, capStart: false, capEnd: true,
    });

    if (!d.fingers) continue;

    /* ---------------------------------------------------------- digits */
    for (let f = 0; f < 5; f++) {
      const fam = FINGERS[f];
      const baseR = g.handW * FING_R[f];
      for (let j = 0; j < 3; j++) {
        const bn = `${fam}0${j + 1}${suf}` as BoneName;
        const nextName = j < 2 ? (`${fam}0${j + 2}${suf}` as BoneName) : null;
        const p0 = meas.bind[bn];
        const axis = meas.axis[bn];
        const segLen = nextName
          ? meas.bind[nextName].distanceTo(p0)
          : meas.bind[`${fam}03${suf}` as BoneName].distanceTo(meas.bind[`${fam}02${suf}` as BoneName])
          * (PHALANX[2] / PHALANX[1]);
        const az = zh.clone().addScaledVector(axis, -zh.dot(axis)).normalize();
        const ax = new THREE.Vector3().crossVectors(axis, az);
        const idx = bi(bn);
        const parentIdx = j === 0 ? HB : bi(`${fam}0${j}${suf}` as BoneName);
        const taper = [1.0, 0.88, 0.78][j];
        const endTaper = [0.90, 0.86, 0.62][j];
        const fr: Ring[] = [];
        // Start slightly BEHIND the joint so the segments interpenetrate; a
        // curled finger with butt-jointed capsules shows daylight at every
        // knuckle and nothing looks faker.
        const US = j === 0 ? [-0.16, 0.06, 0.42, 0.80, 1.0] : [-0.26, 0.04, 0.45, 0.82, 1.0];
        for (const u of US) {
          const r = baseR * lerp(taper, endTaper, clamp01(u))
            * (1 + 0.16 * lobe(clamp01(u), 0.0, 0.22) - 0.10 * lobe(clamp01(u), 0.55, 0.30));
          const isTip = j === 2 && u > 0.95;
          fr.push({
            o: p0.clone().addScaledVector(axis, segLen * u),
            ax, az,
            r: ellipse(r * (isTip ? 0.70 : 1.0), r * (isTip ? 0.60 : 0.86) * 1.02, [
              { at: 0.25, w: 0.18, amp: 0.12 * smooth(-0.1, 0.4, u) },
            ]),
            skin: u < 0
              ? sk2(parentIdx, -u * 2.4, idx, 1 + u * 2.4)
              : sk1(idx),
            v: (j + clamp01(u)) / 3,
            crease: (t: number) => 0.45 * lobe(t, 0.25, 0.15) * lobe(clamp01(u), 0.0, 0.30),
          });
        }
        m.group(GROUP.skin).loft(fr, d.level === 0 ? 8 : 6, {
          part: PART.FINGER, side: s, capEnd: j === 2,
        });
      }
    }
  }
}
