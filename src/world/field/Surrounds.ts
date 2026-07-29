import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Rng } from '../../core/Ctx';
import { linearColor } from '../../util/Tex';
import { FIELD, GRADE, CORNER_CONES, type Terrain } from './Layout';
import { DETAIL_TILE, tiled, type MapSet } from './TurfTextures';
import { attachGroundDetail } from './GroundShader';

/**
 * Everything past the mown pitch: the rubber-crumb apron ring, the rough
 * outfield that carries to the horizon, and the eight corner cones.
 *
 * Two things about this file are load-bearing and both are about *seams*.
 *
 * 1. Height. Every ring sits at a datum defined in `Layout.GRADE`, and those
 *    datums exist because the venue lays a hardstand plane across the whole
 *    site at y = -0.09. Anything below it is simply not drawn. The apron
 *    therefore sits above it and the apron's outer metres ramp back down
 *    *under* it, so the ring dissolves into the site rather than terminating
 *    in a lip. The turf, for its part, ramps down onto the apron deck (see
 *    `Terrain.analytic`), so pitch and run-off share a height at the seam —
 *    which is what removes the faceted silhouette the pitch used to end in.
 *
 * 2. Detail. Both rings used to be plain `MeshStandardMaterial` with one tiled
 *    map, so past ~15 m they mipped to their linear mean and became untextured
 *    card while the pitch two metres away kept full structure. They now run the
 *    same world-space band cascade the turf does — see `GroundShader.ts`.
 */

function ringFrame(
  innerX: number, innerZ: number, outerX: number, outerZ: number,
  rings: number, cell: number, power: number,
  yAt: (t: number, x: number, z: number) => number,
): THREE.BufferGeometry {
  // Perimeter sample count from the *inner* rectangle, so the seam against the
  // pitch is as finely divided as the pitch edge it meets.
  const nx = Math.max(2, Math.round((innerX * 2) / cell));
  const nz = Math.max(2, Math.round((innerZ * 2) / cell));
  const loop: [number, number][] = [];
  for (let i = 0; i < nx; i++) loop.push([-1 + (2 * i) / nx, -1]);
  for (let j = 0; j < nz; j++) loop.push([1, -1 + (2 * j) / nz]);
  for (let i = 0; i < nx; i++) loop.push([1 - (2 * i) / nx, 1]);
  for (let j = 0; j < nz; j++) loop.push([-1, 1 - (2 * j) / nz]);
  const N = loop.length;

  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let r = 0; r <= rings; r++) {
    // Rings crowd toward the pitch: that is where the eye is and where the
    // silhouette lives, and it is also what stops a coarse lattice scalloping
    // the boundary into visible facets.
    const t = Math.pow(r / rings, power);
    const hx = innerX + (outerX - innerX) * t;
    const hz = innerZ + (outerZ - innerZ) * t;
    for (let k = 0; k < N; k++) {
      const x = loop[k][0] * hx, z = loop[k][1] * hz;
      pos.push(x, yAt(t, x, z), z);
      uv.push(x, z);           // UVs in metres — a repeat of 1/tile maps tiles
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      const a = r * N + k, b = r * N + k2, c = (r + 1) * N + k, d = (r + 1) * N + k2;
      idx.push(a, b, c, b, d, c);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export interface SurroundsOpts {
  turf: MapSet;
  apron: MapSet;
  terrain: Terrain;
  rand: Rng;
  anisotropy: number;
  /** False when the venue already dresses the touchline; avoids duplicate kit. */
  dressSideline: boolean;
}

export function buildSurrounds(o: SurroundsOpts): THREE.Group {
  const g = new THREE.Group();
  g.name = 'field.surrounds';
  const { turf, apron, rand } = o;

  const turfTint = new THREE.Color(turf.meanAlbedo.x, turf.meanAlbedo.y, turf.meanAlbedo.z);

  /* ---------------------------------------------------------- apron ring */
  // Underlaps the mown edge by 40 cm so the two surfaces can never open a
  // rasterisation crack along the seam, and its outer fifth sinks below the
  // site hardstand so the ring has no outer edge either.
  const apronOuterY = GRADE.siteY - 0.06;
  const apronGeo = ringFrame(
    FIELD.turfHalfX - 0.4, FIELD.turfHalfZ - 0.4, FIELD.apronHalfX, FIELD.apronHalfZ,
    10, 1.6, 1.7,
    (t) => GRADE.apronY - 0.006 + (apronOuterY - GRADE.apronY) * smootherstep(0.55, 1.0, t),
  );
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
  attachGroundDetail(apronMat, { kind: 'apron', turfTint });
  const apronMesh = new THREE.Mesh(apronGeo, apronMat);
  apronMesh.name = 'field.apron';
  apronMesh.receiveShadow = true;
  g.add(apronMesh);

  /* ------------------------------------------------------ outfield grass */
  // A frame, not a plane: the pitch is crowned and the apron is stepped, so a
  // full plane would poke through both. It deliberately sits *below* the site
  // hardstand — past the apron the venue owns the ground, and lifting this over
  // it would carpet the car parks in grass in the establishing shot. It is here
  // so the field still has a surround when no venue is loaded.
  const outGeo = ringFrame(
    FIELD.apronHalfX - 0.5, FIELD.apronHalfZ - 0.5, 300, 300, 18, 4.0, 2.3,
    (t, x, z) => {
      const fall = t * t * 2.4;
      // Long, gentle ground swell, ramped in over 60 m of run so the near ring
      // stays flat and its silhouette cannot scallop.
      const swell = 0.62 * Math.sin(x * 0.021) * Math.cos(z * 0.017) * Math.min(1, t * 3.2);
      return GRADE.outfieldY - Math.min(1.8, fall) + swell * Math.min(1, t * 3.2);
    },
  );
  const outMat = new THREE.MeshStandardMaterial({
    map: tiled(turf.albedo, 1 / (DETAIL_TILE * 2.6)),
    normalMap: tiled(turf.normal, 1 / (DETAIL_TILE * 2.6)),
    roughnessMap: tiled(turf.data, 1 / (DETAIL_TILE * 2.6)),
    // Was 0xd2c9a4, which made unmown grass read as sand and — worse — left the
    // outfield brighter than the floodlit pitch at night, a straight value
    // inversion between the subject and its background.
    color: linearColor(0xa9b28c),
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: 1, metalness: 0, dithering: true,
  });
  outMat.name = 'outfield';
  attachGroundDetail(outMat, { kind: 'outfield', turfTint });
  const outer = new THREE.Mesh(outGeo, outMat);
  outer.name = 'field.outfield';
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
  if (o.dressSideline) g.add(buildSideline(o));

  return g;
}

const smootherstep = (e0: number, e1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/**
 * Benches, coolers and kit bags along the near sideline — foreground depth.
 *
 * Only built when nothing else is dressing the touchline. The venue's own
 * `stadium/Sideline.ts` puts benches, canopies, coolers, kit bags and camera
 * crews on the same 5 m run-off strip, and two sets of team benches two metres
 * apart is worse than none.
 */
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
