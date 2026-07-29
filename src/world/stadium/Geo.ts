import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Small mesh-authoring helpers for the stadium.
 *
 * Everything the stadium draws is welded into a handful of big buffers or into
 * InstancedMeshes — a stadium is the one part of the scene where a naive
 * object-per-thing approach would blow the draw-call budget instantly. `Mesher`
 * is the low-level quad/box accumulator used for the bowl ribbons; `parts()`
 * merges transformed primitives into a single geometry for prop assemblies.
 *
 * Every geometry produced here carries `position/normal/uv/color`. The colour
 * attribute is used for baked vertex AO and per-part tinting so a whole prop
 * kit can share one material.
 */

export type V3 = [number, number, number];
export type RGB = [number, number, number];

const WHITE: RGB = [1, 1, 1];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

export class Mesher {
  private p: number[] = [];
  private nrm: number[] = [];
  private uvs: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  private count = 0;

  vert(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
    r = 1, g = 1, b = 1,
  ): number {
    this.p.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uvs.push(u, v);
    this.col.push(r, g, b);
    return this.count++;
  }

  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }
  face(a: number, b: number, c: number, d: number): void { this.idx.push(a, b, c, a, c, d); }

  /** CCW quad with a flat normal derived from the winding. `ao` tints per corner. */
  quad(a: V3, b: V3, c: V3, d: V3, uv: number[], ao: number[] = [1, 1, 1, 1], tint: RGB = WHITE): void {
    _a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    _b.set(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    _n.crossVectors(_a, _b);
    if (_n.lengthSq() < 1e-12) return;
    _n.normalize();
    const nx = _n.x, ny = _n.y, nz = _n.z;
    const i0 = this.vert(a[0], a[1], a[2], nx, ny, nz, uv[0], uv[1], tint[0] * ao[0], tint[1] * ao[0], tint[2] * ao[0]);
    this.vert(b[0], b[1], b[2], nx, ny, nz, uv[2], uv[3], tint[0] * ao[1], tint[1] * ao[1], tint[2] * ao[1]);
    this.vert(c[0], c[1], c[2], nx, ny, nz, uv[4], uv[5], tint[0] * ao[2], tint[1] * ao[2], tint[2] * ao[2]);
    this.vert(d[0], d[1], d[2], nx, ny, nz, uv[6], uv[7], tint[0] * ao[3], tint[1] * ao[3], tint[2] * ao[3]);
    this.face(i0, i0 + 1, i0 + 2, i0 + 3);
  }

  /** Axis-aligned box. `uvScale` maps world metres to texture repeats. */
  box(
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
    uvScale = 1, tint: RGB = WHITE, ao = 1,
  ): void {
    const x0 = cx - sx / 2, x1 = cx + sx / 2;
    const y0 = cy - sy / 2, y1 = cy + sy / 2;
    const z0 = cz - sz / 2, z1 = cz + sz / 2;
    const s = uvScale;
    const A = [ao, ao, ao, ao];
    // +X / -X
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [0, 0, sz * s, 0, sz * s, sy * s, 0, sy * s], A, tint);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [0, 0, sz * s, 0, sz * s, sy * s, 0, sy * s], A, tint);
    // +Y / -Y
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 0, sx * s, 0, sx * s, sz * s, 0, sz * s], A, tint);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, 0, sx * s, 0, sx * s, sz * s, 0, sz * s], [ao * 0.6, ao * 0.6, ao * 0.6, ao * 0.6], tint);
    // +Z / -Z
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, sx * s, 0, sx * s, sy * s, 0, sy * s], A, tint);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, sx * s, 0, sx * s, sy * s, 0, sy * s], A, tint);
  }

  get vertexCount(): number { return this.count; }

  build(name?: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    if (name) g.name = name;
    return g;
  }
}

/* ------------------------------------------------------------------- parts */

export interface Part {
  geo: THREE.BufferGeometry;
  m?: THREE.Matrix4;
  color?: RGB | number;
  /** Multiplies the geometry's UVs — lets one primitive tile a shared texture. */
  uvScale?: number;
}

const _col = new THREE.Color();

function ensureColor(g: THREE.BufferGeometry, c: RGB | number | undefined): void {
  const n = g.attributes.position.count;
  let r = 1, gg = 1, b = 1;
  if (typeof c === 'number') { _col.setHex(c, THREE.SRGBColorSpace); r = _col.r; gg = _col.g; b = _col.b; }
  else if (c) { r = c[0]; gg = c[1]; b = c[2]; }
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = r; arr[i * 3 + 1] = gg; arr[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

/** Bakes a list of transformed primitives down to one geometry. */
export function parts(list: Part[], name?: string): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  for (const p of list) {
    const g = p.geo.clone();
    if (p.m) g.applyMatrix4(p.m);
    if (!g.attributes.uv) {
      const n = g.attributes.position.count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    if (p.uvScale && p.uvScale !== 1) {
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * p.uvScale, uv.getY(i) * p.uvScale);
    }
    ensureColor(g, p.color);
    // mergeGeometries requires every input to agree on indexed-ness; the
    // polyhedra (Icosahedron…) ship non-indexed, so give them a trivial index
    // rather than expanding every box to non-indexed.
    if (!g.index) {
      const n = g.attributes.position.count;
      const arr = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) arr[i] = i;
      g.setIndex(new THREE.BufferAttribute(arr, 1));
    }
    geos.push(g);
  }
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) throw new Error('stadium: geometry merge failed');
  merged.computeBoundingSphere();
  if (name) merged.name = name;
  return merged;
}

/* --------------------------------------------------------------- transforms */

export function mat(
  x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = 1, sz = 1,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')),
    new THREE.Vector3(sx, sy, sz),
  );
}

/** A box strut running from a→b with a square cross-section of `w`. */
export function strut(a: V3, b: V3, w: number, geo: THREE.BufferGeometry): Part {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len),
  );
  m.compose(
    new THREE.Vector3(a[0] + dx / 2, a[1] + dy / 2, a[2] + dz / 2),
    q, new THREE.Vector3(w, len, w),
  );
  return { geo, m };
}

/** Unit box centred on the origin — the workhorse primitive for struts. */
export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
