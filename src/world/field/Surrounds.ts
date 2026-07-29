import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Rng } from '../../core/Ctx';
import { linearColor } from '../../util/Tex';
import { FIELD, CORNER_CONES, type Terrain } from './Layout';
import { DETAIL_TILE, tiled, type MapSet } from './TurfTextures';

/**
 * Everything past the mown pitch: the rubber-crumb apron ring, its concrete
 * edging, the rough outfield that carries to the horizon, the eight corner
 * cones, and the sideline team area. The pitch must never end in a hard edge
 * against nothing — each ring hands off to the next with a small step down.
 */

const APRON_Y = -0.075;
const OUTER_Y = -0.16;

function roundedRect(hx: number, hz: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-hx + r, -hz);
  s.lineTo(hx - r, -hz);
  s.quadraticCurveTo(hx, -hz, hx, -hz + r);
  s.lineTo(hx, hz - r);
  s.quadraticCurveTo(hx, hz, hx - r, hz);
  s.lineTo(-hx + r, hz);
  s.quadraticCurveTo(-hx, hz, -hx, hz - r);
  s.lineTo(-hx, -hz + r);
  s.quadraticCurveTo(-hx, -hz, -hx + r, -hz);
  return s;
}

function rectPath(hx: number, hz: number): THREE.Path {
  const p = new THREE.Path();
  p.moveTo(-hx, -hz); p.lineTo(-hx, hz); p.lineTo(hx, hz); p.lineTo(hx, -hz); p.closePath();
  return p;
}

/**
 * A subdivided XZ grid over ±`half` with the inner rectangle punched out, so
 * the outfield never intersects the crowned pitch. UVs are emitted in metres
 * (matching ShapeGeometry) so a texture repeat of 1/tile maps tiles directly.
 */
function ringGrid(half: number, innerX: number, innerZ: number, cells: number): THREE.BufferGeometry {
  const n = cells + 1;
  const step = (half * 2) / cells;
  const pos: number[] = [], uv: number[] = [], nor: number[] = [], idx: number[] = [];
  for (let j = 0; j < n; j++) {
    const z = -half + j * step;
    for (let i = 0; i < n; i++) {
      const x = -half + i * step;
      pos.push(x, 0, z); nor.push(0, 1, 0); uv.push(x, z);
    }
  }
  for (let j = 0; j < cells; j++) {
    const z0 = -half + j * step, z1 = z0 + step;
    for (let i = 0; i < cells; i++) {
      const x0 = -half + i * step, x1 = x0 + step;
      const inside = x0 >= -innerX && x1 <= innerX && z0 >= -innerZ && z1 <= innerZ;
      if (inside) continue;
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export interface SurroundsOpts {
  turf: MapSet;
  apron: MapSet;
  terrain: Terrain;
  rand: Rng;
  anisotropy: number;
}

export function buildSurrounds(o: SurroundsOpts): THREE.Group {
  const g = new THREE.Group();
  g.name = 'field.surrounds';
  const { turf, apron, rand } = o;

  /* ---------------------------------------------------------- apron ring */
  const apronShape = roundedRect(FIELD.apronHalfX, FIELD.apronHalfZ, 15);
  apronShape.holes.push(rectPath(FIELD.turfHalfX, FIELD.turfHalfZ));
  const apronGeo = new THREE.ShapeGeometry(apronShape, 16);
  apronGeo.rotateX(-Math.PI / 2);
  const apronMat = new THREE.MeshStandardMaterial({
    map: tiled(apron.albedo, 1 / 2.2),
    normalMap: tiled(apron.normal, 1 / 2.2),
    roughnessMap: tiled(apron.data, 1 / 2.2),
    aoMap: tiled(apron.data, 1 / 2.2),
    aoMapIntensity: 0.7,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 1, metalness: 0, dithering: true,
  });
  apronMat.name = 'apron';
  // ShapeGeometry emits UVs in shape units (metres) — repeat maps metres to tiles
  const apronMesh = new THREE.Mesh(apronGeo, apronMat);
  apronMesh.position.y = APRON_Y;
  apronMesh.receiveShadow = true;
  g.add(apronMesh);

  /* -------------------------------------------------------- kerb edging */
  const kerbShape = roundedRect(FIELD.turfHalfX + 0.28, FIELD.turfHalfZ + 0.28, 0.1);
  kerbShape.holes.push(rectPath(FIELD.turfHalfX, FIELD.turfHalfZ));
  const kerbGeo = new THREE.ExtrudeGeometry(kerbShape, { depth: 0.12, bevelEnabled: false, curveSegments: 2 });
  kerbGeo.rotateX(-Math.PI / 2);   // extrusion runs +Z in shape space, so this points it up
  const kerbMat = new THREE.MeshStandardMaterial({
    color: linearColor(0x9a978e),
    normalMap: tiled(apron.normal, 1.6),
    normalScale: new THREE.Vector2(0.35, 0.35),
    roughness: 0.92, metalness: 0,
  });
  kerbMat.name = 'kerb';
  const kerb = new THREE.Mesh(kerbGeo, kerbMat);
  kerb.position.y = APRON_Y - 0.005;
  kerb.receiveShadow = true; kerb.castShadow = true;
  g.add(kerb);

  /* ------------------------------------------------------ outfield grass */
  // A ring, not a plane: the pitch is crowned, so its sidelines sit *below*
  // the outfield datum and a full plane would poke straight through them.
  const outGeo = ringGrid(380, FIELD.turfHalfX, FIELD.turfHalfZ, 88);
  const op = outGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < op.count; i++) {
    const x = op.getX(i), z = op.getZ(i);
    const d = Math.max(Math.abs(x) / FIELD.apronHalfX, Math.abs(z) / FIELD.apronHalfZ);
    const out = Math.max(0, d - 1.08);
    op.setY(i, -Math.min(1.8, out * out * 0.30)
      + 0.62 * Math.sin(x * 0.021) * Math.cos(z * 0.017) * Math.min(1, out * 2));
  }
  op.needsUpdate = true;
  outGeo.computeVertexNormals();
  const outMat = new THREE.MeshStandardMaterial({
    map: tiled(turf.albedo, 1 / (DETAIL_TILE * 2.6)),
    normalMap: tiled(turf.normal, 1 / (DETAIL_TILE * 2.6)),
    roughnessMap: tiled(turf.data, 1 / (DETAIL_TILE * 2.6)),
    color: linearColor(0xd2c9a4),
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: 1, metalness: 0, dithering: true,
  });
  outMat.name = 'outfield';
  const outer = new THREE.Mesh(outGeo, outMat);
  outer.position.y = OUTER_Y;
  outer.receiveShadow = true;
  g.add(outer);

  /* ---------------------------------------------------------- cones (8) */
  const coneBody = new THREE.ConeGeometry(0.115, 0.30, 14, 1, false);
  coneBody.translate(0, 0.15, 0);
  const conePlate = new THREE.BoxGeometry(0.27, 0.018, 0.27);
  conePlate.translate(0, 0.009, 0);
  const coneGeo = mergeGeometries([coneBody, conePlate], false)!;
  const coneMat = new THREE.MeshStandardMaterial({
    color: linearColor(0xff6a12),
    normalMap: tiled(apron.normal, 5),
    normalScale: new THREE.Vector2(0.22, 0.22),
    roughness: 0.46, metalness: 0,
  });
  coneMat.name = 'cone';
  const cones = new THREE.InstancedMesh(coneGeo, coneMat, CORNER_CONES.length);
  cones.name = 'field.cones';
  cones.castShadow = true; cones.receiveShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();
  const cr = rand.fork(0xc0e5);
  CORNER_CONES.forEach(([x, z], i) => {
    p.set(x, o.terrain.heightAt(x, z) - 0.01, z);
    q.setFromEuler(new THREE.Euler(cr.range(-0.06, 0.06), cr.range(0, Math.PI * 2), cr.range(-0.06, 0.06)));
    cones.setMatrixAt(i, m.compose(p, q, sc));
  });
  cones.instanceMatrix.needsUpdate = true;
  g.add(cones);

  /* -------------------------------------------------- sideline team area */
  g.add(buildSideline(o));

  return g;
}

/** Benches, coolers and kit bags along the near sideline — foreground depth. */
function buildSideline(o: SurroundsOpts): THREE.Group {
  const g = new THREE.Group();
  g.name = 'field.sideline';
  const { rand, terrain, apron } = o;
  const r = rand.fork(0x51de);

  const furnMat = new THREE.MeshStandardMaterial({
    normalMap: tiled(apron.normal, 9),
    normalScale: new THREE.Vector2(0.25, 0.25),
    roughness: 0.62, metalness: 0, vertexColors: false,
  });
  furnMat.name = 'sideline.furniture';

  /* bench: slatted seat + back + two frames */
  const parts: THREE.BufferGeometry[] = [];
  for (let s = 0; s < 3; s++) {
    const slat = new THREE.BoxGeometry(2.2, 0.045, 0.115);
    slat.translate(0, 0.44, -0.14 + s * 0.135);
    parts.push(slat);
  }
  for (let s = 0; s < 2; s++) {
    const back = new THREE.BoxGeometry(2.2, 0.10, 0.04);
    back.translate(0, 0.72 + s * 0.14, -0.24);
    parts.push(back);
  }
  for (const sx of [-0.9, 0.9]) {
    const leg = new THREE.BoxGeometry(0.05, 0.44, 0.44);
    leg.translate(sx, 0.22, 0);
    parts.push(leg);
    const post = new THREE.BoxGeometry(0.05, 0.42, 0.05);
    post.translate(sx, 0.62, -0.24);
    parts.push(post);
  }
  const benchGeo = mergeGeometries(parts, false)!;

  const benchX = -(FIELD.halfWidth + 4.2);
  const benches = new THREE.InstancedMesh(benchGeo, furnMat, 8);
  benches.castShadow = true; benches.receiveShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < 8; i++) {
    const z = -18 + i * 5.1 + r.range(-0.4, 0.4);
    const x = benchX + r.range(-0.5, 0.5);
    p.set(x, terrain.heightAt(x, z), z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2 + r.range(-0.07, 0.07));
    benches.setMatrixAt(i, m.compose(p, q, one));
    benches.setColorAt(i, col.copy(linearColor(i % 2 ? 0x2f3944 : 0x39424c)).multiplyScalar(r.range(0.85, 1.12)));
  }
  benches.instanceMatrix.needsUpdate = true;
  if (benches.instanceColor) benches.instanceColor.needsUpdate = true;
  g.add(benches);

  /* water coolers */
  const barrel = new THREE.CylinderGeometry(0.21, 0.185, 0.46, 14, 1);
  barrel.translate(0, 0.23, 0);
  const lid = new THREE.CylinderGeometry(0.225, 0.225, 0.05, 14, 1);
  lid.translate(0, 0.475, 0);
  const spout = new THREE.BoxGeometry(0.06, 0.07, 0.05);
  spout.translate(0, 0.14, 0.2);
  const coolerGeo = mergeGeometries([barrel, lid, spout], false)!;
  const coolers = new THREE.InstancedMesh(coolerGeo, furnMat, 5);
  coolers.castShadow = true; coolers.receiveShadow = true;
  for (let i = 0; i < 5; i++) {
    const z = -14 + i * 9 + r.range(-1, 1);
    const x = benchX - 1.5 + r.range(-0.3, 0.3);
    p.set(x, terrain.heightAt(x, z), z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.range(0, 6.28));
    coolers.setMatrixAt(i, m.compose(p, q, one));
    coolers.setColorAt(i, col.copy(linearColor(i % 2 ? 0xd8552f : 0xdedad2)));
  }
  coolers.instanceMatrix.needsUpdate = true;
  if (coolers.instanceColor) coolers.instanceColor.needsUpdate = true;
  g.add(coolers);

  /* kit bags strewn behind the line */
  const bagGeo = new THREE.CapsuleGeometry(0.16, 0.42, 4, 10);
  bagGeo.rotateZ(Math.PI / 2);
  bagGeo.scale(1, 0.85, 1.05);
  bagGeo.translate(0, 0.15, 0);
  const bags = new THREE.InstancedMesh(bagGeo, furnMat, 18);
  bags.castShadow = true; bags.receiveShadow = true;
  const bagCols = [0x1d2a3a, 0x3a1f22, 0x22331f, 0x37302a, 0x14181d, 0x4a3a1c];
  for (let i = 0; i < 18; i++) {
    const z = r.range(-26, 26);
    const x = benchX + r.range(-1.9, 2.6);
    p.set(x, terrain.heightAt(x, z), z);
    q.setFromEuler(new THREE.Euler(0, r.range(0, 6.28), r.range(-0.12, 0.12)));
    bags.setMatrixAt(i, m.compose(p, q, one.set(1, 1, 1).multiplyScalar(r.range(0.8, 1.25))));
    bags.setColorAt(i, col.copy(linearColor(bagCols[r.int(0, bagCols.length - 1)])));
  }
  bags.instanceMatrix.needsUpdate = true;
  if (bags.instanceColor) bags.instanceColor.needsUpdate = true;
  g.add(bags);

  return g;
}
