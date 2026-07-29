import * as THREE from 'three';

/**
 * One blade: a tapered triangle strip that ends in a point.
 *
 *   position.x  = -0.5 .. +0.5  side across the blade
 *   position.y  =  0 .. 1       parameter along the blade
 *
 * Everything else — world placement, height, width, taper, bend, wind — happens
 * in the vertex shader, so this geometry is uploaded once and never touched.
 * `segments` is the LOD knob: 4 up close, 1 (a single triangle) at the horizon.
 */
export function bladeGeometry(segments: number): THREE.BufferGeometry {
  const s = Math.max(1, segments | 0);
  const vertCount = 2 * s + 1;
  const pos = new Float32Array(vertCount * 3);
  const nrm = new Float32Array(vertCount * 3);

  for (let i = 0; i < s; i++) {
    const t = i / s;
    const o = i * 6;
    pos[o] = -0.5; pos[o + 1] = t; pos[o + 2] = 0;
    pos[o + 3] = 0.5; pos[o + 4] = t; pos[o + 5] = 0;
  }
  const tip = s * 6;
  pos[tip] = 0; pos[tip + 1] = 1; pos[tip + 2] = 0;
  for (let i = 0; i < vertCount; i++) nrm[i * 3 + 2] = 1;

  const idx: number[] = [];
  for (let i = 0; i < s - 1; i++) {
    const bl = i * 2, br = bl + 1, tl = bl + 2, tr = bl + 3;
    idx.push(bl, br, tr, bl, tr, tl);
  }
  idx.push((s - 1) * 2, (s - 1) * 2 + 1, s * 2);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}
