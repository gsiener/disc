import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * The spectator body, built once per LOD and drawn instanced.
 *
 * Vertices are stored *relative to their own joint pivot* and tagged with a
 * part id, so the vertex shader can run a tiny skeleton (hips → torso → head,
 * shoulder → arm, hip → thigh → shin) straight from an instance seed. Nothing
 * is skinned, nothing is animated on the CPU.
 *
 * Pose conventions (person space, +Z is the direction they face, origin at the
 * hips of a *seated* spectator; their row floor is 0.40 m below the origin):
 *
 *   PIVOT_TORSO (0, 0.14, 0)           in hips space
 *   PIVOT_HEAD  (0, 0.46, 0.012)       in torso space
 *   PIVOT_SHLDR (±0.163, 0.395, 0)     in torso space
 *   PIVOT_HIP   (±0.105, 0.055, 0.045) in hips space
 *   PIVOT_KNEE  (0, 0, 0.44)           in thigh space (thighs run +Z when sat)
 *   HAND        (0, -0.30, 0.245)      in arm space
 *
 * `aT` is the along-part parameter used to place sleeve and short hems and the
 * neckline: 0 at the joint, 1 at the tip, 2 = "always skin/shoe". Sleeve and
 * hem cuts are quantised to real geometry rings so they stay crisp.
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
 * @param lod 0 = near (must read as a person at 4 m), 1 = far (silhouette).
 */
export function buildBody(lod: 0 | 1): THREE.BufferGeometry {
  const near = lod === 0;
  const rad = near ? 8 : 4;
  const parts: THREE.BufferGeometry[] = [];

  /* hips ------------------------------------------------------------------ */
  parts.push(tag(
    new THREE.CylinderGeometry(0.155, 0.148, 0.17, rad, 1)
      .scale(1, 1, 0.86).translate(0, 0.045, 0.01),
    PART.PELVIS, 0, 0));

  /* torso ----------------------------------------------------------------- */
  parts.push(tag(
    new THREE.CylinderGeometry(0.183, 0.152, 0.44, rad, near ? 3 : 1)
      .scale(1, 1, 0.66).translate(0, 0.22, 0),
    PART.TORSO, 0, (_x, y) => clamp01(y / 0.44)));
  if (near) {
    parts.push(tag(
      new THREE.CylinderGeometry(0.058, 0.064, 0.10, 6, 1).translate(0, 0.45, 0.005),
      PART.TORSO, 0, 2));
  }

  /* head ------------------------------------------------------------------ */
  parts.push(tag(
    new THREE.SphereGeometry(0.104, near ? 10 : 5, near ? 8 : 4)
      .scale(0.94, 1.13, 1.02).translate(0, 0.10, 0),
    PART.HEAD, 0, 0));

  /* hair / cap ------------------------------------------------------------ */
  parts.push(tag(
    new THREE.SphereGeometry(0.111, near ? 10 : 5, near ? 6 : 3, 0, TAU, 0, 1.34)
      .scale(0.96, 1.13, 1.04).translate(0, 0.10, -0.004),
    PART.HAIR, 0, 0));
  if (near) {
    // Cap brim — collapsed in the shader for bare-headed spectators.
    parts.push(tag(
      new THREE.CylinderGeometry(0.15, 0.15, 0.014, 8, 1, false, -1.05, 2.1)
        .scale(1, 1, 1.06).translate(0, 0.168, 0.012),
      PART.BRIM, 0, 0));
  }

  /* arms — built once, mirrored per side by aSide in the shader ----------- */
  for (const side of [-1, 1]) {
    parts.push(tag(
      new THREE.CylinderGeometry(0.052, 0.045, 0.27, near ? 6 : 3, near ? 2 : 1)
        .translate(0, -0.135, 0),
      PART.ARM, side, (_x, y) => clamp01(-y / 0.27) * 0.5));
    const fore = new THREE.CylinderGeometry(0.044, 0.038, 0.25, near ? 6 : 3, 1);
    fore.rotateX(1.735);
    fore.translate(0, -0.281, 0.12);
    parts.push(tag(fore, PART.ARM, side, (_x, _y, z) => 0.5 + 0.5 * clamp01(z / 0.24)));
    if (near) {
      parts.push(tag(
        new THREE.SphereGeometry(0.05, 5, 4).scale(1, 0.9, 1.15).translate(0, -0.30, 0.245),
        PART.ARM, side, 1.0));
    }
  }

  /* legs ------------------------------------------------------------------ */
  for (const side of [-1, 1]) {
    const thigh = new THREE.CylinderGeometry(0.082, 0.072, 0.44, near ? 6 : 3, near ? 2 : 1);
    thigh.rotateX(Math.PI / 2);
    thigh.translate(0, 0, 0.22);
    parts.push(tag(thigh, PART.THIGH, side, (_x, _y, z) => clamp01(z / 0.44)));
    if (near) {
      parts.push(tag(
        new THREE.CylinderGeometry(0.062, 0.052, 0.46, 5, 1).translate(0, -0.23, 0),
        PART.SHIN, side, 1.0));
      parts.push(tag(
        new THREE.BoxGeometry(0.098, 0.058, 0.21).translate(0, -0.455, 0.055),
        PART.SHIN, side, 2.0));
    }
  }

  /* held props ------------------------------------------------------------ */
  if (near) {
    parts.push(tag(
      new THREE.BoxGeometry(0.052, 0.46, 0.02).translate(0, 0.21, 0.015),
      PART.PROP, 1, 0));
  }
  // Phone screen, in both LODs — distant rows twinkling at night is the point.
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
