import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * The spectator body, built once per LOD and drawn instanced.
 *
 * Vertices are stored *relative to their own joint pivot* and tagged with a
 * part id, so the vertex shader can run a tiny skeleton (hips → torso → head,
 * shoulder → upper arm → elbow → forearm, hip → thigh → knee → shin) straight
 * from an instance seed. Nothing is skinned, nothing is animated on the CPU.
 *
 * Nothing here is a billboard. Every LOD is a solid body oriented to its *seat*
 * yaw, so a spectator on the far side of the bowl is correctly seen from behind
 * — the thing camera-facing impostors get wrong in a stadium. The LODs differ
 * only in tessellation and in which small parts survive; limb radii, pivots and
 * proportions are identical, so the switch is a change of smoothness, never a
 * change of silhouette.
 *
 * Pose conventions (person space, +Z is the direction they face, origin at the
 * hips of a *seated* spectator; their row floor is ~0.44 m below the origin):
 *
 *   PIVOT_TORSO (0, 0.14, 0)           in hips space
 *   PIVOT_HEAD  (0, 0.555, 0.012)      in torso space
 *   PIVOT_SHLDR (±0.172, 0.400, 0)     in torso space
 *   PIVOT_ELBOW (0, -0.27, 0)          in upper-arm space
 *   HAND        (0, -0.25, 0)          in forearm space
 *   PIVOT_HIP   (±0.105, 0.055, 0.045) in hips space
 *   PIVOT_KNEE  (0, 0, 0.44)           in thigh space (thighs run +Z when sat)
 *
 * Proportions are checked against a 1.75 m adult: hip joint to acromion 0.485,
 * acromion to chin 0.105 (this is the number that matters — a head dropped into
 * the shoulders is the single loudest "toy" tell and it is what the first pass
 * got wrong), chin to crown 0.220, head 0.156 wide, shoulders 0.384 wide,
 * shoulder to wrist 0.520, hip to sole 0.845.
 *
 * `aT` is the along-part parameter that places every clothing cut:
 *
 *   torso   0 at the waist → 1 at the neckline; 2 = neck skin
 *   arm     0 at the shoulder → 0.5 at the elbow → 1 at the wrist; 2 = hand
 *   leg     0 at the hip → 1 at the knee → ~1.9 at the ankle; 3 = shoe
 *
 * so one per-instance `hem` scalar picks shorts / long shorts / trousers and
 * one `sleeve` scalar picks vest / tee / long sleeve, with the cut always
 * landing on a real geometry ring so it stays crisp.
 *
 * These constants are duplicated in Shader.ts; keep the two in step.
 */

export const PART = {
  PELVIS: 0,
  TORSO: 1,
  HEAD: 2,
  HAIR: 3,
  ARM: 4,
  THIGH: 5,
  SHIN: 6,
  PROP: 7,
  SCREEN: 8,
  BRIM: 9,
  /** Hair that falls past the skull — only drawn for the long-hair style. */
  MANE: 10,
  /** Forearm + hand, hung off the elbow so the arm can actually bend. */
  FOREARM: 11,
} as const;

const TAU = Math.PI * 2;

type TFn = (x: number, y: number, z: number) => number;

function tag(g: THREE.BufferGeometry, part: number, side: number, tf: TFn | number): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const ap = new Float32Array(n); ap.fill(part);
  const as = new Float32Array(n); as.fill(side);
  const at = new Float32Array(n);
  if (typeof tf === 'number') at.fill(tf);
  else for (let i = 0; i < n; i++) at[i] = tf(pos.getX(i), pos.getY(i), pos.getZ(i));
  g.setAttribute('aPart', new THREE.BufferAttribute(ap, 1));
  g.setAttribute('aSide', new THREE.BufferAttribute(as, 1));
  g.setAttribute('aT', new THREE.BufferAttribute(at, 1));
  if (!g.index) {
    const idx = new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return g;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Surface of revolution from a (radius, height) profile, flattened in Z. A
 * lathe rather than a cylinder is the whole difference between "person" and
 * "plank": a 4- or 8-sided straight tube seen head-on is a flat plate, whereas
 * a profile that swells at the chest and rounds over at the shoulders gives the
 * silhouette a curve at every angle.
 */
function lathe(profile: readonly [number, number][], seg: number, zScale: number): THREE.BufferGeometry {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(1e-4, r), y));
  const g = new THREE.LatheGeometry(pts, seg);
  if (zScale !== 1) g.scale(1, 1, zScale);
  return g;
}

/**
 * Chest profile, sampled at three densities. Radii are half-widths in metres,
 * y is torso space. The profile *widens* from the waist to the shoulders — a
 * barrel that is widest in the middle reads as a sack at any distance, and the
 * V from waist to deltoid is most of what says "person" in a silhouette. The
 * waist radius deliberately matches the top of the pelvis so the two lathes
 * blend instead of stacking into a tyre.
 */
const TORSO_HI: readonly [number, number][] = [
  [0.001, -0.078], [0.126, -0.072], [0.140, -0.020], [0.148, 0.055],
  [0.161, 0.145], [0.175, 0.238], [0.186, 0.322], [0.192, 0.388],
  [0.176, 0.438], [0.128, 0.474], [0.066, 0.494], [0.001, 0.502],
];
const TORSO_MD: readonly [number, number][] = [
  [0.001, -0.076], [0.136, -0.062], [0.150, 0.070], [0.180, 0.250],
  [0.191, 0.386], [0.132, 0.470], [0.001, 0.500],
];
const TORSO_LO: readonly [number, number][] = [
  [0.001, -0.072], [0.144, -0.040], [0.189, 0.300], [0.124, 0.464], [0.001, 0.498],
];

const PELVIS_HI: readonly [number, number][] = [
  [0.001, -0.062], [0.098, -0.056], [0.126, -0.012], [0.138, 0.045],
  [0.134, 0.098], [0.100, 0.128], [0.001, 0.138],
];
const PELVIS_LO: readonly [number, number][] = [
  [0.001, -0.060], [0.116, -0.045], [0.137, 0.045], [0.102, 0.126], [0.001, 0.136],
];

/**
 * Measured triangle counts (see `tools/_crowdprobe.mjs`):
 *
 * @param lod 0 = near  (must read as a person at 3 m — 1 670 tri)
 *            1 = mid   (must read as a person at 25 m — 610 tri)
 *            2 = far   (silhouette only — 196 tri)
 */
export function buildBody(lod: 0 | 1 | 2): THREE.BufferGeometry {
  const near = lod === 0;
  const mid = lod === 1;
  const fine = near || mid;
  const rad = near ? 10 : mid ? 6 : 4;
  const limb = near ? 7 : mid ? 4 : 3;
  const parts: THREE.BufferGeometry[] = [];

  /* hips ------------------------------------------------------------------ */
  parts.push(tag(
    lathe(near ? PELVIS_HI : PELVIS_LO, Math.max(5, rad - 2), 0.80).translate(0, 0.045, 0.012),
    PART.PELVIS, 0, 0));

  /* torso ----------------------------------------------------------------- */
  // z is squashed to 0.62 so the cross-section is a 1.6:1 ellipse. A round
  // torso is the other half of the sack problem: it has no front, so it has no
  // form shading and the rim light runs all the way round it.
  parts.push(tag(
    lathe(near ? TORSO_HI : mid ? TORSO_MD : TORSO_LO, rad, 0.62),
    PART.TORSO, 0, (_x, y) => clamp01(y / 0.502)));

  // Deltoids, standing proud of the chest so the shoulder is a shelf and the
  // arm has something to hang off. Without these the arm is a rod floating
  // beside a tube and the eye reads the gap instantly, at any distance.
  for (const side of [-1, 1]) {
    parts.push(tag(
      new THREE.SphereGeometry(0.066, near ? 7 : 5, near ? 5 : 3)
        .scale(1, 0.94, 0.80).translate(side * 0.152, 0.394, 0.0),
      PART.TORSO, 0, 0.5));
  }

  // Neck — 0.10 m of it standing clear of the collar, tagged skin.
  parts.push(tag(
    new THREE.CylinderGeometry(0.048, 0.060, 0.135, near ? 7 : 5, 1)
      .translate(0, 0.500, 0.004),
    PART.TORSO, 0, 2));

  /* head ------------------------------------------------------------------ */
  // uv is load-bearing: the fragment shader places eyes and brow in sphere uv,
  // and u = 0.25 is the face. Do not reseat phiStart.
  parts.push(tag(
    new THREE.SphereGeometry(0.104, near ? 14 : mid ? 8 : 5, near ? 11 : mid ? 6 : 4)
      .scale(0.75, 1.06, 0.92).translate(0, 0.10, 0),
    PART.HEAD, 0, 0));
  if (fine) {
    // A nose is four hundred bytes of geometry and it is the single cheapest
    // thing that stops a head reading as an egg.
    const nose = new THREE.ConeGeometry(0.016, 0.040, near ? 6 : 4, 1);
    nose.rotateX(Math.PI * 0.5);
    // Nose sits at eye level, not above it: the eyes are placed at head-space
    // y = 0.066 by the fragment shader's v = 0.40, and a nose above that reads
    // as a lump on the forehead.
    parts.push(tag(nose.translate(0, 0.056, 0.086), PART.HEAD, 0, 0));
    for (const side of [-1, 1]) {
      parts.push(tag(
        new THREE.SphereGeometry(0.020, 5, 4).scale(0.5, 1.25, 0.9)
          .translate(side * 0.076, 0.068, -0.004),
        PART.HEAD, 0, 0));
    }
    // Chin/jaw wedge — narrows the lower head so it is not a perfect ovoid.
    // It must not hang far below the skull: a deep wedge turns into a flat
    // downward-facing plate, and a stand camera looks *up* at the near rows, so
    // that plate is the first thing it sees. It reads as a black hole.
    parts.push(tag(
      new THREE.SphereGeometry(0.058, near ? 8 : 6, near ? 6 : 4)
        .scale(0.80, 0.80, 1.04).translate(0, 0.032, 0.014),
      PART.HEAD, 0, 0));
  }

  /* hair / cap ------------------------------------------------------------ */
  // Clearance over the skull is a two-sided constraint. Too little (8 mm with a
  // coarser sphere than the head's) and the head's facets poke through, so it
  // renders as a mottled bald dome; too much (20 mm) and the cap overhangs like
  // a mushroom with a hard horizontal brim. ~9 mm, at a tessellation that
  // matches the head's, sits between the two. The backward shift is what turns
  // the rim from a level ring into a hairline: high across the forehead,
  // dropping to the nape behind.
  parts.push(tag(
    new THREE.SphereGeometry(0.104, near ? 14 : mid ? 8 : 6, near ? 8 : mid ? 5 : 3, 0, TAU, 0, 1.46)
      .scale(0.84, 1.14, 1.06).translate(0, 0.100, -0.018),
    PART.HAIR, 0, 0));
  if (fine) {
    // Hair that falls to the collar — collapsed in the shader unless the
    // instance drew the long style. Half the crowd having the same skull cap
    // is most of why a stands crowd reads as clones.
    parts.push(tag(
      new THREE.CylinderGeometry(0.100, 0.118, 0.25, near ? 9 : 7, 1, true,
        Math.PI * 0.52, Math.PI * 0.96).scale(1, 1, 1.06).translate(0, 0.020, -0.012),
      PART.MANE, 0, 0));
    // Cap brim — collapsed in the shader for bare-headed spectators. Stretched
    // in z so it projects off the forehead instead of ringing the skull.
    parts.push(tag(
      new THREE.CylinderGeometry(0.118, 0.118, 0.013, near ? 9 : 7, 1, false, -1.02, 2.04)
        .scale(1, 1, 1.42).translate(0, 0.164, 0.020),
      PART.BRIM, 0, 0));
  }

  /* arms — built once, mirrored per side by aSide in the shader ----------- */
  for (const side of [-1, 1]) {
    parts.push(tag(
      new THREE.CylinderGeometry(0.054, 0.044, 0.27, limb, near ? 2 : 1, true)
        .translate(0, -0.135, 0),
      PART.ARM, side, (_x, y) => clamp01(-y / 0.27) * 0.5));
    if (fine) {
      parts.push(tag(
        new THREE.SphereGeometry(0.046, near ? 7 : 5, near ? 5 : 4).translate(0, -0.268, 0),
        PART.ARM, side, 0.5));
    }
    // Forearm lives in ELBOW space and runs -Y, so the shader owns the bend.
    parts.push(tag(
      new THREE.CylinderGeometry(0.044, 0.036, 0.25, limb, 1, fine)
        .translate(0, -0.125, 0),
      PART.FOREARM, side, (_x, y) => 0.5 + 0.5 * clamp01(-y / 0.25)));
    if (fine) {
      // aT 2 = always skin. A long sleeve must never swallow the hand, which
      // is what a wrist-height gradient value would do.
      parts.push(tag(
        new THREE.SphereGeometry(0.048, near ? 6 : 5, near ? 5 : 4)
          .scale(0.80, 1.0, 1.25).translate(0, -0.264, 0.012),
        PART.FOREARM, side, 2.0));
    }
  }

  /* legs ------------------------------------------------------------------ */
  for (const side of [-1, 1]) {
    const thigh = new THREE.CylinderGeometry(0.088, 0.074, 0.44, limb, near ? 2 : 1, true);
    thigh.rotateX(Math.PI / 2);
    thigh.translate(0, 0, 0.22);
    parts.push(tag(thigh, PART.THIGH, side, (_x, _y, z) => clamp01(z / 0.44)));
    if (fine) {
      parts.push(tag(
        new THREE.SphereGeometry(0.076, near ? 7 : 5, near ? 5 : 4)
          .scale(1, 1, 0.9).translate(0, 0, 0.435),
        PART.THIGH, side, 1.0));
    }
    // Shin carries a 1 → 1.9 gradient so a trouser leg can end anywhere down
    // it. Without this every spectator is bare-legged below the knee, and a
    // stand full of bare shins reads as a beach, not a crowd.
    parts.push(tag(
      new THREE.CylinderGeometry(0.066, 0.050, 0.46, limb, near ? 2 : 1, fine)
        .translate(0, -0.23, 0),
      PART.SHIN, side, (_x, y) => 1.0 + 0.9 * clamp01(-y / 0.46)));
    if (fine) {
      // Shoe: a wedge, not a brick — the toe drops and the heel squares off.
      const shoe = new THREE.BoxGeometry(0.098, 0.056, 0.20, 1, 1, 2);
      const sp = shoe.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < sp.count; i++) {
        const z = sp.getZ(i);
        if (z > 0.05) sp.setY(i, sp.getY(i) * 0.62 - 0.008);
        if (z > 0.05) sp.setX(i, sp.getX(i) * 0.82);
      }
      shoe.computeVertexNormals();
      parts.push(tag(shoe.translate(0, -0.452, 0.052), PART.SHIN, side, 3.0));
    }
  }

  /* held props ------------------------------------------------------------ */
  if (near) {
    parts.push(tag(
      new THREE.BoxGeometry(0.052, 0.46, 0.02).translate(0, 0.21, 0.015),
      PART.PROP, 1, 0));
  }
  // Phone screen, in every LOD — distant rows twinkling at night is the point.
  const scr = new THREE.PlaneGeometry(0.058, 0.108).translate(0, 0.07, 0.028);
  const scrB = new THREE.PlaneGeometry(0.058, 0.108).rotateY(Math.PI).translate(0, 0.07, 0.026);
  parts.push(tag(scr, PART.SCREEN, 1, 0), tag(scrB, PART.SCREEN, 1, 0));

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('Crowd: body merge failed');
  merged.computeBoundingSphere();
  return merged;
}

/** Seat shell for the fallback deck — pan and back, 4 triangles, double sided. */
export function buildChair(): THREE.BufferGeometry {
  const pan = new THREE.PlaneGeometry(0.44, 0.40).rotateX(-Math.PI / 2).translate(0, -0.055, 0.06);
  const back = new THREE.PlaneGeometry(0.44, 0.36).rotateX(-0.14).translate(0, 0.11, -0.16);
  const g = mergeGeometries([pan, back], false);
  pan.dispose(); back.dispose();
  if (!g) throw new Error('Crowd: chair merge failed');
  return g;
}

/** Banner / flag cloth: a subdivided quad plus an optional staff. */
export function buildCloth(): THREE.BufferGeometry {
  const cloth = new THREE.PlaneGeometry(1, 1, 8, 5);
  const n = cloth.attributes.position.count;
  const c = new Float32Array(n); c.fill(1);
  cloth.setAttribute('aCloth', new THREE.BufferAttribute(c, 1));

  const staff = new THREE.BoxGeometry(0.03, 1, 0.03).translate(0, -0.5, 0);
  const m = staff.attributes.position.count;
  const c2 = new Float32Array(m);
  staff.setAttribute('aCloth', new THREE.BufferAttribute(c2, 1));

  const g = mergeGeometries([cloth, staff], false);
  cloth.dispose(); staff.dispose();
  if (!g) throw new Error('Crowd: cloth merge failed');
  return g;
}
