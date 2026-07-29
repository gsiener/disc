import * as THREE from 'three';
import { bake, heightField, heightToNormal } from '../../util/Tex';
import { fbm2, worley2, clamp } from '../../util/Noise';
import { type BowlSpec, rowPath, pathAt, type PathPt } from './Bowl';

/**
 * FALLBACK seating deck. Built only when the Stadium system does not advertise
 * a bowl of its own — a crowd with nothing under it reads as a floating wall of
 * heads, and empty seats only read as *empty seats* if there is a seat there.
 * Stadium owning the bowl is the normal case; this is the degrade path.
 */

/** Sweeps the stepped seating profile along the bowl's rounded-rect rail. */
export function buildDeck(s: BowlSpec, rows: number): THREE.BufferGeometry {
  // Profile in (outward offset, height) relative to the row-0 rail.
  const prof: [number, number][] = [];
  const wall = s.frontY + 0.92;
  prof.push([-0.62, 0]);
  prof.push([-0.62, wall]);
  prof.push([-0.10, wall]);
  prof.push([-0.10, s.frontY]);
  for (let k = 0; k < rows; k++) {
    const y = s.frontY + k * s.rowRise;
    prof.push([k * s.rowDepth, y]);
    prof.push([(k + 1) * s.rowDepth - 0.001, y]);
    prof.push([(k + 1) * s.rowDepth - 0.001, y + s.rowRise]);
  }
  const backOut = rows * s.rowDepth;
  const backY = s.frontY + rows * s.rowRise;
  prof.push([backOut, backY]);
  prof.push([backOut + 1.6, backY]);
  prof.push([backOut + 1.6, 0]);

  const p0 = rowPath(s, 0);
  const samples = Math.max(96, Math.round(p0.len / 1.9));
  const P = prof.length;
  const pos = new Float32Array(samples * P * 3);
  const uv = new Float32Array(samples * P * 2);
  const pt: PathPt = { x: 0, z: 0, nx: 0, nz: 0, corner: 0 };

  for (let i = 0; i < samples; i++) {
    const arc = (i / samples) * p0.len;
    pathAt(p0, arc, pt);
    for (let j = 0; j < P; j++) {
      const [o, y] = prof[j];
      const k = (i * P + j) * 3;
      pos[k] = pt.x + pt.nx * o;
      pos[k + 1] = y;
      pos[k + 2] = pt.z + pt.nz * o;
      const t = (i * P + j) * 2;
      uv[t] = arc * 0.35;
      uv[t + 1] = (o + y) * 0.5;
    }
  }

  const idx: number[] = [];
  for (let i = 0; i < samples; i++) {
    const i2 = (i + 1) % samples;
    for (let j = 0; j < P - 1; j++) {
      const a = i * P + j, b = i * P + j + 1, c = i2 * P + j + 1, d = i2 * P + j;
      idx.push(a, b, c, a, c, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx.length > 65535 ? new THREE.BufferAttribute(new Uint32Array(idx), 1)
    : new THREE.BufferAttribute(new Uint16Array(idx), 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Poured concrete: mottled albedo, aggregate relief, damp-patch roughness. */
export function deckMaterial(anisotropy: number): THREE.MeshStandardMaterial {
  const S = 256;
  const h = heightField(S, (u, v) => {
    const w = worley2(u * 26, v * 26, 17).f1;
    return fbm2(u * 9, v * 9, { octaves: 4, seed: 5 }) * 0.35 + w * 0.6
      + fbm2(u * 48, v * 48, { octaves: 2, seed: 9 }) * 0.12;
  });
  const normal = heightToNormal(h, S, S, 1.35, { anisotropy });
  const albedo = bake((x, y, u, v, out, i) => {
    const n = fbm2(u * 7, v * 7, { octaves: 4, seed: 3 }) * 0.5 + 0.5;
    const grit = fbm2(u * 90, v * 90, { octaves: 2, seed: 11 }) * 0.5 + 0.5;
    const stain = clamp(fbm2(u * 3.1, v * 3.1, { octaves: 3, seed: 23 }) * 0.9 + 0.45, 0, 1);
    const g = (0.30 + 0.16 * n + 0.07 * grit) * (0.74 + 0.34 * stain);
    out[i] = g * 250; out[i + 1] = g * 248; out[i + 2] = g * 240; out[i + 3] = 255;
  }, { size: S, colorSpace: THREE.SRGBColorSpace, anisotropy });
  const rough = bake((x, y, u, v, out, i) => {
    const r = 0.80 + 0.16 * (fbm2(u * 5.3, v * 5.3, { octaves: 3, seed: 41 }) * 0.5 + 0.5);
    out[i] = 255; out[i + 1] = r * 255; out[i + 2] = 0; out[i + 3] = 255;
  }, { size: S, anisotropy });

  albedo.repeat.set(1, 1);
  const m = new THREE.MeshStandardMaterial({
    map: albedo, normalMap: normal, roughnessMap: rough, roughness: 1, metalness: 0,
    normalScale: new THREE.Vector2(0.85, 0.85),
  });
  m.name = 'crowd-deck';
  return m;
}
