import * as THREE from 'three';
import { canvasTexture } from '../../util/Tex';
import { fbm2, ridged2, hash2, clamp, smoothstep } from '../../util/Noise';
import type { Ctx } from '../../core/Ctx';
import { parts, mat, type Part, type RGB, type V3 } from './Geo';
import { chainCompile, TREE_UV, type StadiumMaterials } from './Materials';
import { AERIAL } from '../../render/sky/Aerial';
import { BOWL, FACADE_OFF, roofBackOff, ptAt, perimeterAt, type RingPt } from './Layout';

/**
 * The site the venue stands in.
 *
 * Everything outside the facade line: hardstand, kerbed car parks with painted
 * bays and parked traffic, verge planting, a ring road, a treed park belt, a
 * city edge on the far side of the road, and a ridge line that the aerial
 * perspective takes care of rather than a baked-in haze constant.
 *
 * Three rules govern the whole module.
 *
 *  1. **The plan, not a circle.** Everything close in is laid out on the bowl's
 *     own rounded-rectangle plan offset outward (`ptAt`). A circular apron
 *     round a 107 × 170 m building either cuts through the ends or leaves a
 *     huge empty crescent at the sides, and either one instantly rescales the
 *     venue in the establishing shot.
 *
 *  2. **No two neighbours identical.** The single most damaging thing an
 *     establishing shot can contain is a repeated silhouette. Cars come in five
 *     body types with a real-world colour distribution; trees come in five
 *     species with per-instance scale, yaw and hue; buildings are each built
 *     once with their own massing, so nothing is a stamped copy of its
 *     neighbour.
 *
 *  3. **Detail where the pixels are.** At the establishing camera a car is
 *     ~37 px long and a bay line is ~2 px wide, so bay lines and kerbs are
 *     *geometry* (which stays crisp) while asphalt patching, staining and
 *     drainage are *texture* (which does not need to be). The ground carries
 *     two plan textures — a 210 m near field at ~0.2 m/texel and an 870 m far
 *     field — blended in the shader so there is no seam.
 */

/** Outer face of the stadium facade — everything outside is laid out from here. */
const PAD = FACADE_OFF;

/** Half-extent of the high-resolution near ground plan, metres. */
const NEAR_R = 210;

const _e: RingPt = { x: 0, z: 0, nx: 0, nz: 0, t: 0, seg: 0 };
const _e2: RingPt = { x: 0, z: 0, nx: 0, nz: 0, t: 0, seg: 0 };

/* ==========================================================================
 *  Geometry accumulator
 * ======================================================================== */

type Surf = readonly [number, number, number];

const PAINT: Surf = [1, 0.56, 0.04];

/**
 * Position / normal / uv / colour / `aSurf` accumulator.
 *
 * `Geo.ts`'s `Mesher` covers the bowl's needs, but the exterior wants two
 * things it does not have: explicit UVs into an atlas (the tree kit is one
 * texture with four quadrants) and a per-vertex surface descriptor so a car's
 * paint, glass, rubber and chrome can share one instanced draw call.
 * `aSurf` is (paintMask, roughness, metalness); see `Materials.carPaint`.
 */
class Acc {
  private p: number[] = [];
  private n: number[] = [];
  private t: number[] = [];
  private c: number[] = [];
  private s: number[] = [];
  private idx: number[] = [];
  private k = 0;

  vert(
    x: number, y: number, z: number, nx: number, ny: number, nz: number,
    u: number, v: number, col: RGB, srf: Surf,
  ): number {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.t.push(u, v);
    this.c.push(col[0], col[1], col[2]);
    this.s.push(srf[0], srf[1], srf[2]);
    return this.k++;
  }

  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }

  /** CCW quad with a flat normal from the winding. `uv` is 8 numbers. */
  quad(a: V3, b: V3, c: V3, d: V3, uv: number[], col: RGB, srf: Surf = PAINT, ao: number[] = ONE4): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    const q: V3[] = [a, b, c, d];
    const i0 = this.k;
    for (let i = 0; i < 4; i++) {
      const w = ao[i];
      this.vert(q[i][0], q[i][1], q[i][2], nx, ny, nz, uv[i * 2], uv[i * 2 + 1],
        [col[0] * w, col[1] * w, col[2] * w], srf);
    }
    this.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  }

  /** Axis-aligned box with world-metre UVs. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number,
    col: RGB, srf: Surf = PAINT, uvS = 1, ao = 1): void {
    const x0 = cx - sx / 2, x1 = cx + sx / 2;
    const y0 = cy - sy / 2, y1 = cy + sy / 2;
    const z0 = cz - sz / 2, z1 = cz + sz / 2;
    const s = uvS;
    const A = [ao, ao, ao, ao];
    const D = [ao * 0.55, ao * 0.55, ao * 0.55, ao * 0.55];
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [0, 0, sz * s, 0, sz * s, sy * s, 0, sy * s], col, srf, A);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [0, 0, sz * s, 0, sz * s, sy * s, 0, sy * s], col, srf, A);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 0, sx * s, 0, sx * s, sz * s, 0, sz * s], col, srf, A);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, 0, sx * s, 0, sx * s, sz * s, 0, sz * s], col, srf, D);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, sx * s, 0, sx * s, sy * s, 0, sy * s], col, srf, A);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, sx * s, 0, sx * s, sy * s, 0, sy * s], col, srf, A);
  }

  /** Tapered N-gon tube from a→b. Used for trunks, branches and masts. */
  tube(a: V3, b: V3, r0: number, r1: number, seg: number, col: RGB, uvRect: readonly number[], srf: Surf = PAINT, vRepeat = 1): void {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz) || 1e-5;
    const ax = dx / len, ay = dy / len, az = dz / len;
    // Any vector not parallel to the axis gives a stable frame.
    let px = 0, py = 1, pz = 0;
    if (Math.abs(ay) > 0.94) { px = 1; py = 0; pz = 0; }
    let ex = py * az - pz * ay, ey = pz * ax - px * az, ez = px * ay - py * ax;
    const el = Math.hypot(ex, ey, ez) || 1; ex /= el; ey /= el; ez /= el;
    const fx = ay * ez - az * ey, fy = az * ex - ax * ez, fz = ax * ey - ay * ex;
    const [u0, v0, u1, v1] = uvRect;
    const base = this.k;
    for (let ring = 0; ring < 2; ring++) {
      const r = ring === 0 ? r0 : r1;
      const o = ring === 0 ? a : b;
      for (let i = 0; i <= seg; i++) {
        const th = (i / seg) * Math.PI * 2;
        const cs = Math.cos(th), sn = Math.sin(th);
        const nx = ex * cs + fx * sn, ny = ey * cs + fy * sn, nz = ez * cs + fz * sn;
        this.vert(o[0] + nx * r, o[1] + ny * r, o[2] + nz * r, nx, ny, nz,
          u0 + (u1 - u0) * (i / seg), v0 + (v1 - v0) * ((ring * vRepeat) % 1), col, srf);
      }
    }
    const stride = seg + 1;
    for (let i = 0; i < seg; i++) {
      const a0 = base + i, a1 = a0 + 1, b0 = base + stride + i, b1 = b0 + 1;
      this.idx.push(a0, b0, b1, a0, b1, a1);
    }
  }

  /** Flat disc facing `dir`, used for wheel hubs and tube caps. */
  disc(cx: number, cy: number, cz: number, r: number, dir: V3, seg: number, col: RGB, uvRect: readonly number[], srf: Surf): void {
    const [ax, ay, az] = dir;
    let px = 0, py = 1, pz = 0;
    if (Math.abs(ay) > 0.94) { px = 1; py = 0; pz = 0; }
    let ex = py * az - pz * ay, ey = pz * ax - px * az, ez = px * ay - py * ax;
    const el = Math.hypot(ex, ey, ez) || 1; ex /= el; ey /= el; ez /= el;
    const fx = ay * ez - az * ey, fy = az * ex - ax * ez, fz = ax * ey - ay * ex;
    const uc = (uvRect[0] + uvRect[2]) * 0.5, vc = (uvRect[1] + uvRect[3]) * 0.5;
    const ur = (uvRect[2] - uvRect[0]) * 0.5, vr = (uvRect[3] - uvRect[1]) * 0.5;
    const c = this.vert(cx, cy, cz, ax, ay, az, uc, vc, col, srf);
    const base = this.k;
    for (let i = 0; i <= seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      const cs = Math.cos(th), sn = Math.sin(th);
      this.vert(cx + (ex * cs + fx * sn) * r, cy + (ey * cs + fy * sn) * r, cz + (ez * cs + fz * sn) * r,
        ax, ay, az, uc + ur * cs, vc + vr * sn, col, srf);
    }
    for (let i = 0; i < seg; i++) this.idx.push(c, base + i, base + i + 1);
  }

  get triCount(): number { return this.idx.length / 3; }
  get empty(): boolean { return this.k === 0; }

  /**
   * Re-winds every triangle so its normal faces away from `cx,cy,cz`, then
   * averages the normals. Lofted shells are far easier to author when the
   * winding does not have to be reasoned about point by point.
   */
  orientOutward(cx: number, cy: number, cz: number): void {
    const p = this.p, id = this.idx;
    for (let i = 0; i < id.length; i += 3) {
      const a = id[i] * 3, b = id[i + 1] * 3, c = id[i + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const gx = (p[a] + p[b] + p[c]) / 3 - cx;
      const gy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3 - cy;
      const gz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3 - cz;
      if (nx * gx + ny * gy + nz * gz < 0) { const t = id[i + 1]; id[i + 1] = id[i + 2]; id[i + 2] = t; }
    }
  }

  build(name: string, smooth = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.s, 3));
    g.setIndex(this.idx);
    if (smooth) g.computeVertexNormals();
    g.computeBoundingSphere();
    g.name = name;
    return g;
  }
}

const ONE4 = [1, 1, 1, 1];

/* ==========================================================================
 *  Build
 * ======================================================================== */

interface ExteriorUserData {
  cityNight: THREE.IUniform<number>;
  lampMat: THREE.MeshStandardMaterial;
}

export function buildExterior(ctx: Ctx, M: StadiumMaterials): THREE.Group {
  const g = new THREE.Group();
  g.name = 'exterior';
  const rnd = ctx.rand.fork(0xe7e2);
  const tier = ctx.quality.tier;
  const scale = tier === 'low' ? 0.35 : tier === 'medium' ? 0.6 : 1;
  const shadows = tier !== 'low';

  /* ------------------------------------------------------------- ground */
  // The site plan is authored once and then consumed by everything: the two
  // ground textures, the kerbs, the bay markings, the lighting columns, the
  // planting and the parked traffic all read the same lot table, so a change
  // to the layout moves all of them together.
  const lots = planLots(scale);
  const groundR = 870;   // just inside the camera's 900 m far plane
  const nearSize = tier === 'low' ? 1024 : tier === 'medium' ? 1536 : 2048;
  const nearTex = bakeNearPlan(nearSize, lots);
  const groundMat = new THREE.MeshStandardMaterial({
    map: bakeGroundPlan(groundR, lots), roughness: 0.97, metalness: 0, name: 'exterior-ground',
  });
  // Two plan textures, blended in the shader. The far one covers 1740 m at
  // 1.7 m/texel, which cannot hold a painted bay; the near one covers 420 m at
  // ~0.2 m/texel, which can. Blending removes the seam a second mesh would
  // leave, and the world-space macro field stops the near plan mipping to its
  // own mean at grazing angles.
  chainCompile(groundMat, (sh) => {
    sh.uniforms.uNear = { value: nearTex };
    sh.uniforms.uMacro = { value: M.macroField };
    sh.vertexShader = 'varying vec3 vGWorld;\n' + sh.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\n\tvGWorld = cameraPosition + mvPosition.xyz * mat3( viewMatrix );',
    );
    sh.fragmentShader = /* glsl */`
varying vec3 vGWorld;
uniform sampler2D uNear;
uniform sampler2D uMacro;
${sh.fragmentShader}`.replace('#include <map_fragment>', /* glsl */`
	#include <map_fragment>
	vec2 nUv = vGWorld.xz * ( 0.5 / ${NEAR_R.toFixed(1)} ) + 0.5;
	float nk = 1.0 - smoothstep( 0.80, 0.98, max( abs( nUv.x - 0.5 ), abs( nUv.y - 0.5 ) ) * 2.0 );
	vec4 nearC = texture2D( uNear, nUv );
	diffuseColor.rgb = mix( diffuseColor.rgb, nearC.rgb, nk );
	vec3 gm = texture2D( uMacro, vGWorld.xz * 0.0068 ).rgb;
	vec3 gm2 = texture2D( uMacro, vGWorld.xz * 0.058 + 0.21 ).rgb;
	diffuseColor.rgb *= 0.84 + 0.26 * gm.r + 0.10 * gm2.b;
`);
  });

  const ground = new THREE.Mesh(new THREE.CircleGeometry(groundR, 96), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.09;
  ground.receiveShadow = true;
  ground.name = 'exterior-ground';
  g.add(ground);

  /* ------------------------------------------------------------- hills */
  const hills = buildHills();
  g.add(hills);

  /* ---------------------------------------------------------- hardstand */
  // Kerbs, verge islands and painted bays. All three are geometry: at the
  // establishing camera a 0.28 m bay line is about two pixels, which a plan
  // texture cannot hold but a quad can.
  const kerbAcc = new Acc();
  const paintAcc = new Acc();
  buildKerbs(kerbAcc, lots);
  buildBayLines(paintAcc, lots, rnd.fork(0x71a));

  const kerbs = new THREE.Mesh(kerbAcc.build('site-kerbs'), M.concrete);
  // A 150 mm kerb casts nothing the establishing camera can resolve, and it is
  // 5 k triangles per cascade to find that out.
  kerbs.castShadow = false;
  kerbs.receiveShadow = true;
  kerbs.name = 'site-kerbs';
  g.add(kerbs);

  const paint = new THREE.Mesh(paintAcc.build('bay-lines'), M.roadPaint);
  paint.receiveShadow = false;
  paint.castShadow = false;
  paint.name = 'bay-lines';
  g.add(paint);

  /* --------------------------------------------------------------- city */
  g.add(buildCity(rnd.fork(0x0c17), M, scale));

  /* ------------------------------------------------------------- trees */
  const treeGroup = new THREE.Group();
  treeGroup.name = 'trees';
  const species = [buildOak(), buildColumnar(), buildPine(), buildYoung(), buildScrub()];
  const treeTotal = Math.round(330 * scale);
  const placements = placeTrees(rnd.fork(0x77ee), lots, treeTotal);
  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();
  for (let s = 0; s < species.length; s++) {
    const mine = placements.filter((p) => p.species === s);
    if (!mine.length) { species[s].dispose(); continue; }
    const im = new THREE.InstancedMesh(species[s], M.foliage, mine.length);
    im.name = `trees-${s}`;
    for (let i = 0; i < mine.length; i++) {
      const p = mine[i];
      m4.copy(mat(p.x, p.y, p.z, 0, p.yaw, 0, p.sx, p.sy, p.sx));
      im.setMatrixAt(i, m4);
      col.setRGB(p.tint[0], p.tint[1], p.tint[2]);
      im.setColorAt(i, col);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = shadows;
    im.receiveShadow = true;
    treeGroup.add(im);
  }
  // One mesh drives the shared wind clock for every species.
  const first = treeGroup.children[0] as THREE.Mesh | undefined;
  if (first) first.onBeforeRender = () => { M.windTime.value = ctx.time; };
  g.add(treeGroup);

  /* -------------------------------------------------- car-park lighting */
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0x30343a, emissive: new THREE.Color(0, 0, 0), roughness: 0.35, metalness: 0.1,
    vertexColors: true, name: 'park-lamp',
  });
  const poleGeo = buildLightPole();
  const lampGeo = buildLampHeads();
  const polePts = placePoles(lots, scale);
  const poles = new THREE.InstancedMesh(poleGeo, M.steelDark, polePts.length);
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, polePts.length);
  poles.name = 'park-poles';
  lamps.name = 'park-lamps';
  for (let i = 0; i < polePts.length; i++) {
    m4.copy(mat(polePts[i][0], 0, polePts[i][1], 0, polePts[i][2], 0));
    poles.setMatrixAt(i, m4);
    lamps.setMatrixAt(i, m4);
  }
  poles.instanceMatrix.needsUpdate = true;
  lamps.instanceMatrix.needsUpdate = true;
  poles.castShadow = shadows;
  poles.receiveShadow = true;
  lamps.castShadow = false;
  g.add(poles);
  g.add(lamps);

  /* -------------------------------------------------------------- cars */
  const carGeos = CAR_TYPES.map((t) => buildCar(t));
  const fleet = fillBays(rnd.fork(0x0ca5), lots, Math.round(380 * scale));
  for (let t = 0; t < carGeos.length; t++) {
    const mine = fleet.filter((c) => c.type === t);
    if (!mine.length) { carGeos[t].dispose(); continue; }
    const im = new THREE.InstancedMesh(carGeos[t], M.carPaint, mine.length);
    im.name = `cars-${CAR_TYPES[t].name}`;
    const tint = new Float32Array(mine.length * 3);
    for (let i = 0; i < mine.length; i++) {
      const c = mine[i];
      m4.copy(mat(c.x, 0, c.z, 0, c.yaw, 0));
      im.setMatrixAt(i, m4);
      tint[i * 3] = c.rgb[0]; tint[i * 3 + 1] = c.rgb[1]; tint[i * 3 + 2] = c.rgb[2];
    }
    im.instanceMatrix.needsUpdate = true;
    im.geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
    im.castShadow = shadows;
    im.receiveShadow = true;
    g.add(im);
  }

  const ud = g.userData as ExteriorUserData;
  ud.cityNight = M.cityNight;
  ud.lampMat = lampMat;
  return g;
}

/** Lets the stadium switch the city and the car-park lamps over after dark. */
export function setExteriorNight(g: THREE.Group, k: number): void {
  const ud = g.userData as Partial<ExteriorUserData>;
  if (ud.cityNight) ud.cityNight.value = k;
  if (ud.lampMat) ud.lampMat.emissive.setRGB(k * 1.35, k * 1.18, k * 0.86);
}

/* ==========================================================================
 *  Site plan — lots, kerbs, bays
 * ======================================================================== */

interface Lot {
  /** Base parameter range around the plan. */
  t0: number; t1: number;
  /** Outward offset of the kerb this lot backs on to. */
  base: number;
  /** Bay pitch along the row, metres. */
  pitch: number;
  /** Bay depth, metres. */
  depth: number;
  /** Aisle width between the two bay rows. */
  aisle: number;
  /** Rough fill level 0..1 — lots by the turnstiles are full, the far ones are not. */
  fill: number;
}

/**
 * A real site does not ring the building with an unbroken band of cars: it has
 * discrete lots separated by verges, service roads and coach bays. Each lot is
 * a t-range on the plan and a module of two bay rows either side of an aisle.
 */
function planLots(scale: number): Lot[] {
  const mods = scale < 0.5 ? 2 : 3;
  const out: Lot[] = [];
  // Three modules deep, laid over four blocks of the perimeter with gaps.
  const blocks: Array<[number, number, number]> = [
    [0.515, 0.795, 0.94],   // the long -X side: the main lot, nearly full
    [0.360, 0.448, 0.78],   // +Z end
    [0.020, 0.290, 0.70],   // the long +X side
    [0.870, 0.945, 0.52],   // a corner overflow lot
  ];
  for (const [t0, t1, fill] of blocks) {
    for (let m = 0; m < mods; m++) {
      out.push({
        t0, t1,
        base: PAD + 13 + m * 17.2,
        pitch: 2.62, depth: 5.0, aisle: 6.2,
        fill: clamp(fill - m * 0.14, 0.12, 1),
      });
    }
  }
  return out;
}

/** Number of whole bays that fit in a lot row. */
function bayCount(l: Lot): number {
  return Math.max(2, Math.floor(((l.t1 - l.t0) * perimeterAt(l.base)) / l.pitch));
}

const KERB_TOP: RGB = [0.82, 0.81, 0.78];
const KERB_FACE: RGB = [0.66, 0.65, 0.62];
const VERGE: RGB = [0.30, 0.40, 0.22];
const CONCRETE: Surf = [0, 0.94, 0];

/** Kerbed verge islands between the bay modules, and a grass strip on top. */
function buildKerbs(a: Acc, lots: Lot[]): void {
  const seen = new Set<string>();
  for (const l of lots) {
    const key = `${l.t0}:${l.base}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const off = l.base - 1.9;
    const n = Math.max(8, Math.round(((l.t1 - l.t0) * perimeterAt(off)) / 3.2));
    const W = 2.6, H = 0.15;
    for (let i = 0; i < n; i++) {
      const ta = l.t0 + (l.t1 - l.t0) * (i / n);
      const tb = l.t0 + (l.t1 - l.t0) * ((i + 1) / n);
      ptAt(ta, off, _e); ptAt(tb, off, _e2);
      const a0: V3 = [_e.x - _e.nx * W * 0.5, 0, _e.z - _e.nz * W * 0.5];
      const a1: V3 = [_e.x + _e.nx * W * 0.5, 0, _e.z + _e.nz * W * 0.5];
      const b0: V3 = [_e2.x - _e2.nx * W * 0.5, 0, _e2.z - _e2.nz * W * 0.5];
      const b1: V3 = [_e2.x + _e2.nx * W * 0.5, 0, _e2.z + _e2.nz * W * 0.5];
      const top = H;
      // Kerb faces, then a slightly sunken grass panel between them.
      a.quad([a0[0], 0, a0[2]], [b0[0], 0, b0[2]], [b0[0], top, b0[2]], [a0[0], top, a0[2]],
        [0, 0, 3.2, 0, 3.2, 0.15, 0, 0.15], KERB_FACE, CONCRETE);
      a.quad([a1[0], top, a1[2]], [b1[0], top, b1[2]], [b1[0], 0, b1[2]], [a1[0], 0, a1[2]],
        [0, 0, 3.2, 0, 3.2, 0.15, 0, 0.15], KERB_FACE, CONCRETE);
      a.quad([a0[0], top, a0[2]], [b0[0], top, b0[2]], [b1[0], top, b1[2]], [a1[0], top, a1[2]],
        [0, 0, 3.2, 0, 3.2, W, 0, W], KERB_TOP, CONCRETE);
      const gx0 = _e.x - _e.nx * (W * 0.5 - 0.28), gz0 = _e.z - _e.nz * (W * 0.5 - 0.28);
      const gx1 = _e.x + _e.nx * (W * 0.5 - 0.28), gz1 = _e.z + _e.nz * (W * 0.5 - 0.28);
      const hx0 = _e2.x - _e2.nx * (W * 0.5 - 0.28), hz0 = _e2.z - _e2.nz * (W * 0.5 - 0.28);
      const hx1 = _e2.x + _e2.nx * (W * 0.5 - 0.28), hz1 = _e2.z + _e2.nz * (W * 0.5 - 0.28);
      a.quad([gx0, top - 0.03, gz0], [hx0, top - 0.03, hz0], [hx1, top - 0.03, hz1], [gx1, top - 0.03, gz1],
        [0, 0, 3.2, 0, 3.2, W, 0, W], VERGE, CONCRETE);
    }
  }
}

/**
 * Painted bay markings. Each bay gets one stroke on its low-t edge, worn by a
 * per-bay factor: the aisle ends scrub away first, and a handful of bays are
 * repainted and therefore brighter than their neighbours.
 */
function buildBayLines(a: Acc, lots: Lot[], rnd: { next(): number }): void {
  const HALF = 0.075;
  for (const l of lots) {
    const n = bayCount(l);
    for (let row = 0; row < 2; row++) {
      const inner = row === 0 ? l.base : l.base + l.depth + l.aisle;
      const outer = inner + l.depth;
      for (let i = 0; i <= n; i++) {
        const t = l.t0 + (l.t1 - l.t0) * (i / n);
        ptAt(t, inner, _e);
        ptAt(t, outer, _e2);
        // Tangent along the row, used to give the stroke its width.
        const tx = -_e.nz, tz = _e.nx;
        const wear = 0.44 + 0.34 * rnd.next() * rnd.next() + (rnd.next() > 0.94 ? 0.26 : 0);
        const c: RGB = [wear * 0.97, wear * 0.98, wear];
        a.quad(
          [_e.x - tx * HALF, 0.012, _e.z - tz * HALF],
          [_e.x + tx * HALF, 0.012, _e.z + tz * HALF],
          [_e2.x + tx * HALF, 0.012, _e2.z + tz * HALF],
          [_e2.x - tx * HALF, 0.012, _e2.z - tz * HALF],
          [0, 0, 0.12, 0, 0.12, l.depth, 0, l.depth], c, CONCRETE,
        );
      }
    }
  }
}

/** Lighting columns down the aisle centre lines. */
function placePoles(lots: Lot[], scale: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const l of lots) {
    const off = l.base + l.depth + l.aisle * 0.5;
    const span = (l.t1 - l.t0) * perimeterAt(off);
    const n = Math.max(1, Math.round((span / 26) * scale));
    for (let i = 0; i < n; i++) {
      const t = l.t0 + (l.t1 - l.t0) * ((i + 0.5) / n);
      ptAt(t, off, _e);
      out.push([_e.x, _e.z, Math.atan2(_e.nx, _e.nz)]);
    }
  }
  return out;
}

/* ==========================================================================
 *  Cars
 * ======================================================================== */

interface CarSection {
  /** Along the car, metres. Negative is the tail. */
  z: number;
  /** Half width of the body at this station. */
  w: number;
  /** Bottom (arch line) and top of the section. */
  y0: number; y1: number;
  /** Tumblehome: how much the greenhouse pulls in from the shoulder. */
  tumble: number;
  /** Vertical band of this section that is glazed, in section-local 0..1. */
  gLo: number; gHi: number;
}

interface CarType {
  name: string;
  sections: CarSection[];
  /** Wheel radius, tyre width, half track, front and rear axle z. */
  wr: number; tw: number; track: number; axF: number; axR: number;
  /** Share of the fleet. */
  share: number;
  /** Roof rails / load bed / ladder rack — the type's identifying furniture. */
  extra?: 'rails' | 'bed' | 'rack';
}

/**
 * Body sections, rear to front. The loft between them is what produces a
 * bonnet, a raked windscreen, a roof, a backlight and a boot — a two-box
 * silhouette is the single thing a viewer reads as "placeholder" fastest,
 * and it costs about 280 triangles to fix.
 */
const CAR_TYPES: CarType[] = [
  {
    name: 'hatch', share: 0.26, wr: 0.31, tw: 0.20, track: 0.79, axF: 1.28, axR: -1.24,
    sections: [
      { z: -2.00, w: 0.70, y0: 0.36, y1: 0.86, tumble: 0.30, gLo: 9, gHi: 9 },
      { z: -1.88, w: 0.83, y0: 0.31, y1: 1.20, tumble: 0.26, gLo: 0.56, gHi: 0.94 },
      { z: -1.62, w: 0.86, y0: 0.30, y1: 1.38, tumble: 0.28, gLo: 0.54, gHi: 0.90 },
      { z: -1.22, w: 0.87, y0: 0.29, y1: 1.46, tumble: 0.32, gLo: 0.52, gHi: 0.88 },
      { z: -0.36, w: 0.88, y0: 0.28, y1: 1.47, tumble: 0.33, gLo: 0.52, gHi: 0.88 },
      { z: 0.34, w: 0.88, y0: 0.28, y1: 1.45, tumble: 0.32, gLo: 0.52, gHi: 0.88 },
      { z: 0.84, w: 0.87, y0: 0.28, y1: 1.20, tumble: 0.22, gLo: 0.50, gHi: 0.99 },
      { z: 1.18, w: 0.86, y0: 0.28, y1: 0.94, tumble: 0.15, gLo: 9, gHi: 9 },
      { z: 1.68, w: 0.84, y0: 0.30, y1: 0.90, tumble: 0.13, gLo: 9, gHi: 9 },
      { z: 1.94, w: 0.79, y0: 0.33, y1: 0.86, tumble: 0.19, gLo: 9, gHi: 9 },
      { z: 2.04, w: 0.68, y0: 0.38, y1: 0.80, tumble: 0.28, gLo: 9, gHi: 9 },
    ],
  },
  {
    name: 'saloon', share: 0.24, wr: 0.33, tw: 0.21, track: 0.82, axF: 1.42, axR: -1.42,
    sections: [
      { z: -2.36, w: 0.72, y0: 0.36, y1: 0.86, tumble: 0.30, gLo: 9, gHi: 9 },
      { z: -2.22, w: 0.85, y0: 0.30, y1: 0.98, tumble: 0.22, gLo: 9, gHi: 9 },
      { z: -1.78, w: 0.88, y0: 0.29, y1: 1.04, tumble: 0.18, gLo: 9, gHi: 9 },
      { z: -1.44, w: 0.89, y0: 0.28, y1: 1.30, tumble: 0.30, gLo: 0.60, gHi: 0.97 },
      { z: -1.04, w: 0.90, y0: 0.28, y1: 1.44, tumble: 0.34, gLo: 0.55, gHi: 0.88 },
      { z: -0.20, w: 0.90, y0: 0.27, y1: 1.45, tumble: 0.34, gLo: 0.55, gHi: 0.88 },
      { z: 0.52, w: 0.90, y0: 0.27, y1: 1.42, tumble: 0.33, gLo: 0.55, gHi: 0.88 },
      { z: 1.02, w: 0.89, y0: 0.27, y1: 1.16, tumble: 0.22, gLo: 0.50, gHi: 0.99 },
      { z: 1.40, w: 0.88, y0: 0.28, y1: 0.94, tumble: 0.14, gLo: 9, gHi: 9 },
      { z: 2.00, w: 0.86, y0: 0.29, y1: 0.90, tumble: 0.12, gLo: 9, gHi: 9 },
      { z: 2.32, w: 0.80, y0: 0.32, y1: 0.86, tumble: 0.18, gLo: 9, gHi: 9 },
      { z: 2.42, w: 0.69, y0: 0.38, y1: 0.80, tumble: 0.28, gLo: 9, gHi: 9 },
    ],
  },
  {
    name: 'suv', share: 0.23, wr: 0.38, tw: 0.25, track: 0.90, axF: 1.48, axR: -1.44, extra: 'rails',
    sections: [
      { z: -2.34, w: 0.78, y0: 0.44, y1: 1.02, tumble: 0.26, gLo: 9, gHi: 9 },
      { z: -2.20, w: 0.92, y0: 0.40, y1: 1.44, tumble: 0.22, gLo: 0.58, gHi: 0.94 },
      { z: -1.86, w: 0.95, y0: 0.38, y1: 1.62, tumble: 0.24, gLo: 0.54, gHi: 0.90 },
      { z: -1.32, w: 0.97, y0: 0.37, y1: 1.72, tumble: 0.28, gLo: 0.52, gHi: 0.88 },
      { z: -0.30, w: 0.98, y0: 0.36, y1: 1.74, tumble: 0.29, gLo: 0.52, gHi: 0.88 },
      { z: 0.52, w: 0.98, y0: 0.36, y1: 1.72, tumble: 0.28, gLo: 0.52, gHi: 0.88 },
      { z: 1.02, w: 0.97, y0: 0.36, y1: 1.44, tumble: 0.20, gLo: 0.50, gHi: 0.99 },
      { z: 1.40, w: 0.96, y0: 0.36, y1: 1.16, tumble: 0.14, gLo: 9, gHi: 9 },
      { z: 1.98, w: 0.94, y0: 0.38, y1: 1.12, tumble: 0.12, gLo: 9, gHi: 9 },
      { z: 2.28, w: 0.88, y0: 0.42, y1: 1.06, tumble: 0.18, gLo: 9, gHi: 9 },
      { z: 2.38, w: 0.76, y0: 0.48, y1: 0.98, tumble: 0.26, gLo: 9, gHi: 9 },
    ],
  },
  {
    name: 'van', share: 0.16, wr: 0.35, tw: 0.22, track: 0.90, axF: 1.66, axR: -1.60, extra: 'rack',
    sections: [
      { z: -2.72, w: 0.82, y0: 0.42, y1: 2.06, tumble: 0.10, gLo: 9, gHi: 9 },
      { z: -2.60, w: 0.96, y0: 0.36, y1: 2.14, tumble: 0.08, gLo: 0.74, gHi: 0.94 },
      { z: -1.60, w: 0.98, y0: 0.34, y1: 2.18, tumble: 0.08, gLo: 9, gHi: 9 },
      { z: -0.20, w: 0.98, y0: 0.34, y1: 2.20, tumble: 0.08, gLo: 9, gHi: 9 },
      { z: 0.80, w: 0.98, y0: 0.34, y1: 2.16, tumble: 0.10, gLo: 0.62, gHi: 0.90 },
      { z: 1.32, w: 0.97, y0: 0.34, y1: 1.98, tumble: 0.14, gLo: 0.58, gHi: 0.94 },
      { z: 1.72, w: 0.96, y0: 0.34, y1: 1.42, tumble: 0.16, gLo: 0.44, gHi: 0.99 },
      { z: 2.10, w: 0.94, y0: 0.36, y1: 1.18, tumble: 0.14, gLo: 9, gHi: 9 },
      { z: 2.44, w: 0.88, y0: 0.40, y1: 1.10, tumble: 0.18, gLo: 9, gHi: 9 },
      { z: 2.54, w: 0.76, y0: 0.46, y1: 1.02, tumble: 0.26, gLo: 9, gHi: 9 },
    ],
  },
  {
    name: 'pickup', share: 0.11, wr: 0.39, tw: 0.26, track: 0.92, axF: 1.66, axR: -1.60, extra: 'bed',
    sections: [
      { z: -2.68, w: 0.78, y0: 0.46, y1: 1.16, tumble: 0.24, gLo: 9, gHi: 9 },
      { z: -2.54, w: 0.98, y0: 0.42, y1: 1.24, tumble: 0.06, gLo: 9, gHi: 9 },
      { z: -0.62, w: 0.98, y0: 0.40, y1: 1.22, tumble: 0.06, gLo: 9, gHi: 9 },
      { z: -0.54, w: 0.96, y0: 0.40, y1: 1.76, tumble: 0.24, gLo: 0.60, gHi: 0.94 },
      { z: -0.10, w: 0.96, y0: 0.40, y1: 1.80, tumble: 0.28, gLo: 0.55, gHi: 0.88 },
      { z: 0.60, w: 0.96, y0: 0.39, y1: 1.78, tumble: 0.28, gLo: 0.55, gHi: 0.88 },
      { z: 1.06, w: 0.95, y0: 0.39, y1: 1.46, tumble: 0.20, gLo: 0.48, gHi: 0.99 },
      { z: 1.44, w: 0.94, y0: 0.39, y1: 1.20, tumble: 0.14, gLo: 9, gHi: 9 },
      { z: 2.06, w: 0.93, y0: 0.40, y1: 1.16, tumble: 0.12, gLo: 9, gHi: 9 },
      { z: 2.38, w: 0.86, y0: 0.44, y1: 1.10, tumble: 0.18, gLo: 9, gHi: 9 },
      { z: 2.48, w: 0.74, y0: 0.50, y1: 1.02, tumble: 0.26, gLo: 9, gHi: 9 },
    ],
  },
];

/**
 * Cross-section of the body shell, traced once anticlockwise: underbody, up
 * the near flank, over the roof, down the far flank and back. `v` is the
 * section-local height used both for the loft and for the glass band.
 */
const CAR_RING: Array<[number, number]> = [
  [-0.52, 0.00], [-0.94, 0.06], [-1.00, 0.22], [-1.00, 0.44],
  [-0.99, 0.62], [-0.96, 0.76], [-0.86, 0.90], [-0.54, 0.99],
  [0.54, 0.99], [0.86, 0.90], [0.96, 0.76], [0.99, 0.62],
  [1.00, 0.44], [1.00, 0.22], [0.94, 0.06], [0.52, 0.00],
];

const TYRE: RGB = [0.055, 0.055, 0.058];
const TYRE_S: Surf = [0, 0.92, 0.0];
const HUB: RGB = [0.62, 0.63, 0.66];
const HUB_S: Surf = [0, 0.24, 0.92];
const GLASS: RGB = [0.052, 0.060, 0.072];
const GLASS_S: Surf = [0, 0.045, 0.0];
const TRIM: RGB = [0.10, 0.10, 0.11];
const TRIM_S: Surf = [0, 0.55, 0.15];
const LAMP_F: RGB = [0.92, 0.93, 0.90];
const LAMP_R: RGB = [0.55, 0.055, 0.045];
const LAMP_S: Surf = [0, 0.09, 0.0];

function buildCar(t: CarType): THREE.BufferGeometry {
  const shell = new Acc();
  const S = t.sections, K = CAR_RING.length;
  const zMid = (S[0].z + S[S.length - 1].z) * 0.5;
  const rings: number[][] = [];
  for (const sec of S) {
    const row: number[] = [];
    const h = sec.y1 - sec.y0;
    for (let k = 0; k < K; k++) {
      const [ux, vy] = CAR_RING[k];
      const narrow = 1 - sec.tumble * smoothstep(0.52, 1.0, vy);
      const glazed = vy >= sec.gLo && vy <= sec.gHi;
      const col = glazed ? GLASS : ([1, 1, 1] as RGB);
      const srf = glazed ? GLASS_S : PAINT;
      row.push(shell.vert(
        ux * sec.w * narrow, sec.y0 + vy * h, sec.z,
        0, 0, 0, 0.5, 0.5, col, srf,
      ));
    }
    rings.push(row);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < K; k++) {
      const k2 = (k + 1) % K;
      shell.tri(rings[i][k], rings[i + 1][k], rings[i + 1][k2]);
      shell.tri(rings[i][k], rings[i + 1][k2], rings[i][k2]);
    }
  }
  // Cap the ends so the shell is closed from every angle.
  for (const [ri, sgn] of [[0, -1], [rings.length - 1, 1]] as Array<[number, number]>) {
    const sec = S[ri];
    const cy = sec.y0 + 0.5 * (sec.y1 - sec.y0);
    const c = shell.vert(0, cy, sec.z, 0, 0, sgn, 0.5, 0.5, [1, 1, 1], PAINT);
    for (let k = 0; k < K; k++) shell.tri(c, rings[ri][k], rings[ri][(k + 1) % K]);
  }
  shell.orientOutward(0, 0.6, zMid);

  const kit = new Acc();
  /* wheels ------------------------------------------------------------- */
  const inner = t.track - t.tw;
  for (const az of [t.axF, t.axR]) {
    for (const sx of [-1, 1]) {
      const xo = sx * inner, xi = sx * t.track;
      kit.tube([xo, t.wr, az], [xi, t.wr, az], t.wr, t.wr, 12, TYRE, TREE_UV.mass, TYRE_S);
      kit.disc(xi + sx * 0.004, t.wr, az, t.wr * 0.97, [sx, 0, 0], 12, TYRE, TREE_UV.mass, TYRE_S);
      kit.disc(xi + sx * 0.008, t.wr, az, t.wr * 0.58, [sx, 0, 0], 10, HUB, TREE_UV.mass, HUB_S);
      // Wheel-arch shadow: a dark ring set just inboard of the tyre.
      kit.disc(xo - sx * 0.02, t.wr, az, t.wr * 1.16, [-sx, 0, 0], 12, [0.03, 0.03, 0.035], TREE_UV.mass, TYRE_S);
    }
  }
  /* rocker, valances, lamps -------------------------------------------- */
  const sillY = S[Math.floor(S.length / 2)].y0;
  const rockZ0 = t.axR + t.wr * 1.25, rockZ1 = t.axF - t.wr * 1.25;
  kit.box(0, sillY * 0.62, (rockZ0 + rockZ1) / 2, t.track * 1.94, sillY * 0.82, rockZ1 - rockZ0, TRIM, TRIM_S, 1, 0.72);
  const zF = S[S.length - 1].z, zR = S[0].z;
  kit.box(0, sillY * 0.72, zF - 0.16, t.track * 1.66, sillY * 0.7, 0.34, TRIM, TRIM_S, 1, 0.7);
  kit.box(0, sillY * 0.72, zR + 0.16, t.track * 1.66, sillY * 0.7, 0.34, TRIM, TRIM_S, 1, 0.7);
  const lampY = S[S.length - 2].y0 + (S[S.length - 2].y1 - S[S.length - 2].y0) * 0.42;
  for (const sx of [-1, 1]) {
    kit.box(sx * t.track * 0.62, lampY, zF - 0.06, 0.42, 0.15, 0.10, LAMP_F, LAMP_S);
    kit.box(sx * t.track * 0.64, lampY + 0.06, zR + 0.05, 0.36, 0.22, 0.09, LAMP_R, LAMP_S);
    // Mirrors, which is most of what makes a silhouette read as a car in plan.
    const mz = t.axF - 0.36;
    kit.box(sx * (t.track + 0.10), lampY + 0.52, mz, 0.24, 0.12, 0.09, TRIM, TRIM_S);
  }
  /* type furniture ------------------------------------------------------ */
  if (t.extra === 'rails') {
    for (const sx of [-1, 1]) {
      kit.box(sx * t.track * 0.62, 1.79, -0.4, 0.07, 0.06, 2.3, TRIM, TRIM_S);
    }
  } else if (t.extra === 'rack') {
    for (let i = 0; i < 3; i++) {
      kit.box(0, 2.28, -1.9 + i * 1.3, t.track * 1.9, 0.06, 0.08, [0.55, 0.56, 0.58], [0, 0.42, 0.6]);
    }
  } else if (t.extra === 'bed') {
    // Load-bed floor and tailboard, so the pickup is not a saloon with a gap.
    kit.box(0, 0.86, -1.62, t.track * 1.86, 0.06, 1.9, TRIM, TRIM_S, 1, 0.6);
    kit.box(0, 1.06, -2.52, t.track * 1.9, 0.44, 0.09, [1, 1, 1], PAINT);
  }

  const geoShell = shell.build(`car-${t.name}-shell`, true);
  const geoKit = kit.build(`car-${t.name}-kit`);
  const merged = mergeAcc([geoShell, geoKit], `car-${t.name}`);
  geoShell.dispose(); geoKit.dispose();
  return merged;
}

/** Concatenates geometries that share exactly this module's attribute set. */
function mergeAcc(list: THREE.BufferGeometry[], name: string): THREE.BufferGeometry {
  const NAMES = ['position', 'normal', 'uv', 'color', 'aSurf'] as const;
  const sizes = [3, 3, 2, 3, 3];
  let vTotal = 0, iTotal = 0;
  for (const g of list) { vTotal += g.attributes.position.count; iTotal += g.index!.count; }
  const out = new THREE.BufferGeometry();
  for (let a = 0; a < NAMES.length; a++) {
    const arr = new Float32Array(vTotal * sizes[a]);
    let o = 0;
    for (const g of list) {
      const src = g.attributes[NAMES[a]].array as ArrayLike<number>;
      for (let i = 0; i < src.length; i++) arr[o + i] = src[i];
      o += src.length;
    }
    out.setAttribute(NAMES[a], new THREE.Float32BufferAttribute(arr, sizes[a]));
  }
  const idx = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
  let o = 0, base = 0;
  for (const g of list) {
    const src = g.index!.array as ArrayLike<number>;
    for (let i = 0; i < src.length; i++) idx[o + i] = src[i] + base;
    o += src.length; base += g.attributes.position.count;
  }
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  out.name = name;
  return out;
}

/* ----------------------------------------------------------- car colours */

/**
 * Real car parks are overwhelmingly achromatic. Every survey of the last
 * fifteen years puts white, black, grey and silver together at about 78 % of
 * the fleet, and getting that ratio wrong is the fastest way to make a car
 * park read as a toy box. Values are linear.
 */
const CAR_COLOURS: Array<{ w: number; c: [number, number, number] }> = [
  // Note the white: 0.62 linear, not 0.9. Car paint is never a perfect
  // reflector, it is always slightly dirty, and a car park full of 0.9 white
  // clips to a single blob the moment a low sun hits it.
  { w: 0.205, c: [0.500, 0.505, 0.512] }, // white
  { w: 0.060, c: [0.350, 0.346, 0.330] }, // pearl / off-white
  { w: 0.215, c: [0.018, 0.019, 0.022] }, // black
  { w: 0.170, c: [0.078, 0.084, 0.092] }, // graphite grey
  { w: 0.130, c: [0.185, 0.198, 0.214] }, // silver
  { w: 0.058, c: [0.024, 0.046, 0.108] }, // navy
  { w: 0.042, c: [0.190, 0.024, 0.024] }, // red
  { w: 0.034, c: [0.040, 0.082, 0.058] }, // dark green
  { w: 0.030, c: [0.086, 0.115, 0.180] }, // mid blue
  { w: 0.026, c: [0.235, 0.175, 0.108] }, // beige / bronze
  { w: 0.018, c: [0.400, 0.255, 0.024] }, // amber
  { w: 0.012, c: [0.320, 0.056, 0.016] }, // burnt orange
];

interface CarPlacement { x: number; z: number; yaw: number; type: number; rgb: [number, number, number] }

/**
 * Walks every bay in every lot and decides whether a car is in it. Occupancy
 * falls off with distance from the turnstiles, cars near the aisle mouths sit
 * a little crooked, and roughly a fifth of the bays stay empty — an entirely
 * full, perfectly aligned car park is as much of a tell as a two-box car.
 */
function fillBays(rnd: { next(): number }, lots: Lot[], budget: number): CarPlacement[] {
  const out: CarPlacement[] = [];
  const typeCdf: number[] = [];
  { let acc = 0; for (const t of CAR_TYPES) { acc += t.share; typeCdf.push(acc); } }
  const colCdf: number[] = [];
  { let acc = 0; for (const c of CAR_COLOURS) { acc += c.w; colCdf.push(acc); } }
  const pickType = () => { const r = rnd.next() * typeCdf[typeCdf.length - 1]; return typeCdf.findIndex((v) => r <= v); };
  const pickCol = () => { const r = rnd.next() * colCdf[colCdf.length - 1]; return CAR_COLOURS[Math.max(0, colCdf.findIndex((v) => r <= v))].c; };

  const bays: Array<{ x: number; z: number; yaw: number; p: number }> = [];
  for (const l of lots) {
    const n = bayCount(l);
    for (let row = 0; row < 2; row++) {
      // Row 0 noses in toward the kerb, row 1 noses out toward the next lot.
      const centre = row === 0 ? l.base + l.depth * 0.5 : l.base + l.depth * 1.5 + l.aisle;
      for (let i = 0; i < n; i++) {
        const t = l.t0 + (l.t1 - l.t0) * ((i + 0.5) / n);
        ptAt(t, centre, _e);
        const yaw = Math.atan2(_e.nx, _e.nz) + (row === 0 ? Math.PI : 0);
        // Cluster the gaps: a smooth field decides which stretches are busy.
        const cluster = fbm2(_e.x * 0.035, _e.z * 0.035, { octaves: 3, seed: 17 }) * 0.5 + 0.5;
        bays.push({ x: _e.x, z: _e.z, yaw, p: clamp(l.fill * (0.45 + cluster * 1.0), 0, 0.97) });
      }
    }
  }
  // Normalise the occupancy field to the budget rather than filling the first
  // lots and abandoning the last — the gaps have to be spread over the site.
  let expected = 0;
  for (const b of bays) expected += b.p;
  const norm = expected > 0 ? Math.min(1, budget / expected) : 1;
  for (const b of bays) {
    if (out.length >= budget) break;
    if (rnd.next() > b.p * norm) continue;
    const crooked = rnd.next() < 0.14 ? rnd.next() * 0.16 - 0.08 : rnd.next() * 0.045 - 0.0225;
    const lat = (rnd.next() - 0.5) * 0.34;
    const lon = (rnd.next() - 0.5) * 0.5;
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const col = pickCol();
    out.push({
      x: b.x + c * lat + s * lon,
      z: b.z - s * lat + c * lon,
      yaw: b.yaw + crooked,
      type: Math.max(0, pickType()),
      rgb: [col[0], col[1], col[2]],
    });
  }
  return out;
}

/* ==========================================================================
 *  Trees
 * ======================================================================== */

const BARK_DK: RGB = [0.62, 0.58, 0.54];
const BARK_LT: RGB = [0.92, 0.90, 0.86];
const LEAF: Surf = [0, 0.86, 0];

/** A ragged canopy shell: a low-band sphere pushed about by value noise. */
function canopyShell(a: Acc, cx: number, cy: number, cz: number, rx: number, ry: number, seed: number, tint: number): void {
  const LAT = 5, LON = 9;
  const rows: number[][] = [];
  const col: RGB = [tint * 0.92, tint, tint * 0.86];
  for (let j = 0; j <= LAT; j++) {
    const v = j / LAT;
    const th = v * Math.PI;
    const row: number[] = [];
    for (let i = 0; i <= LON; i++) {
      const ph = (i / LON) * Math.PI * 2;
      const sx = Math.sin(th) * Math.cos(ph), sy = Math.cos(th), sz = Math.sin(th) * Math.sin(ph);
      const n = fbm2(sx * 2.4 + seed, sz * 2.4 + sy * 1.7, { octaves: 3, seed }) * 0.5 + 0.5;
      const k = 0.55 + n * 0.86;
      const shade = 0.58 + 0.36 * (sy * 0.5 + 0.5) + n * 0.14;
      const [u0, v0, u1, v1] = TREE_UV.mass;
      row.push(a.vert(
        cx + sx * rx * k, cy + sy * ry * k, cz + sz * rx * k,
        sx, sy, sz,
        u0 + (u1 - u0) * (0.5 + sx * 0.42), v0 + (v1 - v0) * (0.5 + sz * 0.42),
        [col[0] * shade, col[1] * shade, col[2] * shade], LEAF,
      ));
    }
    rows.push(row);
  }
  for (let j = 0; j < LAT; j++) {
    for (let i = 0; i < LON; i++) {
      const a0 = rows[j][i], a1 = rows[j][i + 1], b0 = rows[j + 1][i], b1 = rows[j + 1][i + 1];
      a.tri(a0, b0, b1); a.tri(a0, b1, a1);
    }
  }
}

/** Three intersecting alpha cards through a point — the canopy's ragged edge. */
function leafCluster(a: Acc, cx: number, cy: number, cz: number, r: number, yaw: number, tilt: number, tint: number): void {
  const [u0, v0, u1, v1] = TREE_UV.card;
  const uv = [u0, v0, u1, v0, u1, v1, u0, v1];
  for (let k = 0; k < 3; k++) {
    const ang = yaw + (k / 3) * Math.PI;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const tl = tilt * (k === 1 ? -1 : k === 2 ? 0.5 : 1);
    const ux = ca * r, uz = sa * r;
    const vy = Math.cos(tl) * r, vx = -sa * Math.sin(tl) * r, vz = ca * Math.sin(tl) * r;
    const shade = tint * (0.82 + 0.24 * k / 2);
    const col: RGB = [shade * 0.94, shade, shade * 0.88];
    a.quad(
      [cx - ux - vx, cy - vy, cz - uz - vz],
      [cx + ux - vx, cy - vy, cz + uz - vz],
      [cx + ux + vx, cy + vy, cz + uz + vz],
      [cx - ux + vx, cy + vy, cz - uz + vz],
      uv, col, LEAF,
    );
  }
}

/** Spreading broadleaf: heavy taper, three primaries, a wide ragged crown. */
function buildOak(): THREE.BufferGeometry {
  const a = new Acc();
  a.tube([0, 0, 0], [0.06, 2.35, -0.04], 0.30, 0.20, 7, BARK_LT, TREE_UV.bark, LEAF);
  const tips: V3[] = [[1.55, 4.45, 0.55], [-1.35, 4.75, -0.85], [0.25, 5.55, 1.35], [-0.55, 4.15, 1.55]];
  for (const tp of tips) {
    a.tube([0.06, 2.30, -0.04], [tp[0] * 0.55, tp[1] * 0.72, tp[2] * 0.55], 0.16, 0.10, 5, BARK_DK, TREE_UV.bark, LEAF);
    a.tube([tp[0] * 0.55, tp[1] * 0.72, tp[2] * 0.55], tp, 0.09, 0.045, 5, BARK_DK, TREE_UV.bark, LEAF);
  }
  canopyShell(a, 0.0, 5.55, 0.0, 2.55, 1.85, 3, 1.0);
  canopyShell(a, 1.45, 4.75, 0.75, 1.55, 1.25, 11, 0.88);
  canopyShell(a, -1.35, 5.05, -0.95, 1.45, 1.20, 23, 1.08);
  canopyShell(a, 0.35, 6.55, 0.85, 1.35, 1.05, 37, 1.14);
  canopyShell(a, -0.75, 4.35, 1.45, 1.25, 0.95, 49, 0.92);
  for (let i = 0; i < 9; i++) {
    const ang = (i / 9) * Math.PI * 2 + 0.4;
    const rr = 2.15 + hash2(i, 3, 5) * 0.9;
    leafCluster(a, Math.cos(ang) * rr, 4.7 + hash2(i, 7, 9) * 2.1, Math.sin(ang) * rr,
      1.25 + hash2(i, 11, 2) * 0.55, ang, 0.5 + hash2(i, 13, 4) * 0.6, 0.95 + hash2(i, 5, 8) * 0.22);
  }
  return a.build('tree-oak');
}

/** Lombardy poplar: a tall, tight, near-vertical column. */
function buildColumnar(): THREE.BufferGeometry {
  const a = new Acc();
  a.tube([0, 0, 0], [0.05, 9.2, 0.05], 0.19, 0.06, 6, BARK_LT, TREE_UV.bark, LEAF);
  for (let i = 0; i < 6; i++) {
    const f = i / 5;
    const y = 2.0 + f * 6.6;
    const r = 1.25 * (1 - f * 0.55) * (0.8 + 0.4 * Math.sin(f * 5));
    canopyShell(a, Math.sin(i * 2.1) * 0.22, y, Math.cos(i * 1.7) * 0.22, r, r * 1.45, 61 + i * 7, 0.92 + f * 0.20);
  }
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    const f = i / 6;
    leafCluster(a, Math.cos(ang) * 0.85, 2.6 + f * 6.2, Math.sin(ang) * 0.85, 0.90, ang, 0.30, 0.95 + f * 0.15);
  }
  return a.build('tree-poplar');
}

/** Scots pine: bare lower trunk, needle tiers, a flat-topped crown. */
function buildPine(): THREE.BufferGeometry {
  const a = new Acc();
  a.tube([0, 0, 0], [0.04, 8.6, 0.02], 0.26, 0.07, 7, BARK_LT, TREE_UV.bark, LEAF, 1);
  const [u0, v0, u1, v1] = TREE_UV.needle;
  const uv = [u0, v0, u1, v0, u1, v1, u0, v1];
  for (let tier = 0; tier < 6; tier++) {
    const f = tier / 5;
    const y = 3.5 + f * 4.7;
    const r = 2.5 * (1 - f * 0.72) + 0.35;
    const n = 7 - tier;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + tier * 0.7;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const droop = -0.30 - f * 0.18;
      const ex = ca * r, ez = sa * r, ey = y + droop * r;
      const half = 0.42 + (1 - f) * 0.34;
      const shade = 0.80 + f * 0.34;
      const col: RGB = [shade * 0.86, shade, shade * 0.82];
      // A spray card from the trunk out to the branch tip.
      a.quad(
        [-sa * half * 0.4, y + 0.10, ca * half * 0.4],
        [sa * half * 0.4, y + 0.10, -ca * half * 0.4],
        [ex + sa * half, ey, ez - ca * half],
        [ex - sa * half, ey, ez + ca * half],
        uv, col, LEAF,
      );
    }
    if (tier > 1) canopyShell(a, 0, y + 0.25, 0, r * 0.52, 0.55, 71 + tier * 13, 0.72 + f * 0.2);
  }
  return a.build('tree-pine');
}

/** A recent planting: stake, thin stem, three small lobes, lighter foliage. */
function buildYoung(): THREE.BufferGeometry {
  const a = new Acc();
  a.tube([0, 0, 0], [0.03, 2.55, 0.02], 0.085, 0.05, 5, BARK_LT, TREE_UV.bark, LEAF);
  a.tube([0.24, 0, 0.05], [0.22, 1.9, 0.05], 0.035, 0.030, 4, [0.68, 0.60, 0.48], TREE_UV.bark, LEAF);
  canopyShell(a, 0.0, 3.35, 0.0, 1.10, 1.00, 91, 1.16);
  canopyShell(a, 0.62, 3.05, 0.35, 0.72, 0.62, 97, 1.04);
  canopyShell(a, -0.48, 3.15, -0.42, 0.65, 0.58, 103, 1.24);
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + 0.9;
    leafCluster(a, Math.cos(ang) * 0.95, 3.15 + hash2(i, 21, 3) * 0.7, Math.sin(ang) * 0.95,
      0.72, ang, 0.55, 1.10 + hash2(i, 23, 5) * 0.2);
  }
  return a.build('tree-young');
}

/** Multi-stem scrub: three splayed stems under one low, wide crown. */
function buildScrub(): THREE.BufferGeometry {
  const a = new Acc();
  for (let i = 0; i < 3; i++) {
    const ang = (i / 3) * Math.PI * 2 + 0.5;
    a.tube([0, 0, 0], [Math.cos(ang) * 0.62, 1.75, Math.sin(ang) * 0.62], 0.13, 0.07, 5, BARK_DK, TREE_UV.bark, LEAF);
  }
  canopyShell(a, 0, 2.55, 0, 1.95, 1.05, 131, 0.90);
  canopyShell(a, 1.05, 2.15, 0.55, 1.15, 0.80, 137, 0.80);
  canopyShell(a, -0.95, 2.30, -0.65, 1.10, 0.78, 149, 0.98);
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    leafCluster(a, Math.cos(ang) * 1.65, 2.25 + hash2(i, 31, 2) * 0.6, Math.sin(ang) * 1.65,
      0.98, ang, 0.75, 0.86 + hash2(i, 37, 6) * 0.24);
  }
  return a.build('tree-scrub');
}

interface TreePlace { x: number; y: number; z: number; yaw: number; sx: number; sy: number; species: number; tint: RGB }

/**
 * Planting scheme. Formal rows of poplars line the ring road and the lot
 * verges (which is what a real venue plants, because they screen the car park
 * without shading it), and an informal parkland mix fills the belt beyond.
 */
function placeTrees(rnd: { next(): number; range(a: number, b: number): number }, lots: Lot[], budget: number): TreePlace[] {
  const out: TreePlace[] = [];
  const push = (x: number, z: number, sp: number, s: number, hue: number) => {
    const k = 0.76 + hue * 0.34;
    out.push({
      x, y: 0, z, yaw: rnd.range(0, Math.PI * 2),
      sx: s * (0.90 + rnd.next() * 0.20), sy: s * (0.86 + rnd.next() * 0.34),
      species: sp,
      tint: [k * (0.86 + rnd.next() * 0.22), k * (0.96 + rnd.next() * 0.12), k * (0.72 + rnd.next() * 0.30)],
    });
  };

  // Verge islands: alternating poplar / young, evenly spaced but jittered.
  const seen = new Set<number>();
  for (const l of lots) {
    if (seen.has(l.base)) continue;
    seen.add(l.base);
    const off = l.base - 1.9;
    const span = (l.t1 - l.t0) * perimeterAt(off);
    const n = Math.max(2, Math.round(span / 15));
    for (let i = 0; i < n; i++) {
      const t = l.t0 + (l.t1 - l.t0) * ((i + 0.5) / n) + rnd.range(-0.002, 0.002);
      ptAt(t, off, _e);
      push(_e.x, _e.z, i % 3 === 2 ? 3 : 1, rnd.range(0.85, 1.15), rnd.next());
    }
  }
  // Avenue along the ring road.
  const ringOff = PAD + 92;
  const nRing = Math.round(perimeterAt(ringOff) / 17);
  for (let i = 0; i < nRing && out.length < budget; i++) {
    ptAt((i + 0.4) / nRing, ringOff + rnd.range(-1.4, 1.4), _e);
    push(_e.x, _e.z, 1, rnd.range(0.95, 1.30), rnd.next());
  }
  // Parkland belt beyond the road: a clumped, mixed-species scatter.
  const MIX = [0, 0, 0, 2, 2, 4, 3, 1];
  let guard = 0;
  while (out.length < budget && guard++ < budget * 12) {
    const t = rnd.next();
    const off = PAD + 108 + rnd.next() * rnd.next() * 330;
    ptAt(t, off, _e);
    // Clump: reject samples that fall in the low half of a coarse noise field.
    const clump = fbm2(_e.x * 0.014, _e.z * 0.014, { octaves: 3, seed: 88 }) * 0.5 + 0.5;
    if (rnd.next() > clump * 1.25) continue;
    const sp = MIX[Math.floor(rnd.next() * MIX.length)];
    push(_e.x, _e.z, sp, rnd.range(0.72, 1.55), rnd.next());
  }
  return out;
}

/* ==========================================================================
 *  City
 * ======================================================================== */

/** Facade tile: 4 window modules wide, 4 floors tall. */
const TILE_W = 9.6, TILE_H = 14.4;

/**
 * A skyline, not a row of extruded boxes. Each building is generated once with
 * its own footprint, its own stack of setbacks, its own parapet and its own
 * roof plant, and the whole city welds down to two draw calls — glazing and
 * trim. Height falls off from three district cores so the massing reads as a
 * city rather than as a scatter.
 */
function buildCity(rnd: { next(): number; range(a: number, b: number): number }, M: StadiumMaterials, scale: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'city';
  const walls = new Acc();
  const trim = new Acc();

  const districts: Array<{ x: number; z: number; core: number; r: number }> = [
    { x: -330, z: -110, core: 122, r: 140 },
    { x: 140, z: -395, core: 88, r: 125 },
    { x: 365, z: 190, core: 66, r: 145 },
  ];
  const perDistrict = Math.max(6, Math.round(17 * scale));

  for (let d = 0; d < districts.length; d++) {
    const D = districts[d];
    // A jittered block grid, so streets read between the buildings.
    const gridN = Math.ceil(Math.sqrt(perDistrict)) + 1;
    const pitch = (D.r * 2) / gridN;
    let placed = 0;
    for (let gz = 0; gz < gridN && placed < perDistrict; gz++) {
      for (let gx = 0; gx < gridN && placed < perDistrict; gx++) {
        const bx = D.x + (gx + 0.5 - gridN / 2) * pitch + rnd.range(-pitch * 0.14, pitch * 0.14);
        const bz = D.z + (gz + 0.5 - gridN / 2) * pitch + rnd.range(-pitch * 0.14, pitch * 0.14);
        const dist = Math.hypot(bx - D.x, bz - D.z) / D.r;
        if (dist > 1.02) continue;
        if (rnd.next() < 0.14) continue;      // a gap in the block: a car park or a park
        placed++;
        const fall = Math.pow(clamp(1 - dist, 0, 1), 1.35);
        const h = Math.max(11, D.core * (0.20 + fall * 0.95) * (0.55 + rnd.next() * 0.9));
        const foot = clamp(12 + h * 0.30 + rnd.range(-4, 8), 12, 46);
        buildTower(walls, trim, rnd, bx, bz, foot * rnd.range(0.72, 1.25), foot, h, d * 977 + placed * 37);
      }
    }
  }
  // A low-rise industrial fringe on the venue's side of the road.
  const sheds = Math.round(16 * scale);
  for (let i = 0; i < sheds; i++) {
    const t = rnd.next();
    ptAt(t, PAD + 150 + rnd.next() * 190, _e);
    buildShed(trim, rnd, _e.x, _e.z, rnd.range(0, Math.PI));
  }

  const wallMesh = new THREE.Mesh(walls.build('city-walls'), M.facade);
  wallMesh.name = 'city-walls';
  wallMesh.castShadow = false;
  wallMesh.receiveShadow = false;
  g.add(wallMesh);
  const trimMesh = new THREE.Mesh(trim.build('city-trim'), M.concrete);
  trimMesh.name = 'city-trim';
  trimMesh.castShadow = false;
  trimMesh.receiveShadow = false;
  g.add(trimMesh);
  return g;
}

/** One tower: podium, one or two setbacks, parapets and roof plant. */
function buildTower(
  walls: Acc, trim: Acc, rnd: { next(): number; range(a: number, b: number): number },
  cx: number, cz: number, wx: number, wz: number, h: number, id: number,
): void {
  const tint = 0.50 + hash2(id, 3, 7) * 0.44;
  const warm = 0.94 + hash2(id, 5, 11) * 0.14;
  const wallCol: RGB = [tint * warm, tint * 0.99, tint * (2 - warm) * 0.99];
  const trimCol: RGB = [tint * 0.84 * warm, tint * 0.84, tint * 0.84];
  // Per-building UV origin, in whole window modules, so no two facades show
  // the same lit-window pattern even though they share one texture.
  const uOff = Math.floor(hash2(id, 17, 3) * 47) * (2.4 / TILE_W);
  const vOff = Math.floor(hash2(id, 19, 5) * 31) * (3.6 / TILE_H);

  // Massing families: plain slab, single setback, wedding cake. Making every
  // tall building step twice turns a skyline into a ziggurat field.
  const form = rnd.next();
  const setbacks = h > 52 ? (form < 0.34 ? 0 : form < 0.76 ? 1 : 2) : (form < 0.22 ? 1 : 0);
  const podH = Math.min(h * 0.35, 4.2 + rnd.next() * 7);
  let y = 0, ax = wx, az = wz;

  // Podium — always plain, always a touch wider than the shaft above.
  trim.box(cx, podH * 0.5, cz, ax + 3.2, podH, az + 3.2, trimCol, CONCRETE, 1, 0.92);
  trim.box(cx, podH + 0.35, cz, ax + 4.0, 0.7, az + 4.0, trimCol, CONCRETE, 1, 1.04);
  y = podH + 0.7;

  const stages = setbacks + 1;
  for (let s = 0; s < stages; s++) {
    const top = s === stages - 1 ? h : y + (h - y) * (0.42 + rnd.next() * 0.22);
    const sh = top - y;
    if (sh < 3) break;
    // Four glazed faces with UVs in tiles, so the floor lines are real floors.
    face(walls, cx, cz, ax, az, y, top, wallCol, uOff, vOff);
    // Parapet: a proud band capping the stage.
    trim.box(cx, top + 0.55, cz, ax + 0.85, 1.1, az + 0.85, trimCol, CONCRETE, 1, 1.06);
    trim.box(cx, top + 0.05, cz, ax + 0.5, 0.4, az + 0.5, trimCol, CONCRETE, 1, 0.86);
    y = top + 1.1;
    ax *= 0.70 + rnd.next() * 0.14;
    az *= 0.70 + rnd.next() * 0.14;
  }

  /* roof plant ---------------------------------------------------------- */
  const rY = y;
  const plantCol: RGB = [tint * 0.86, tint * 0.86, tint * 0.88];
  trim.box(cx + rnd.range(-ax * 0.2, ax * 0.2), rY + 1.7, cz + rnd.range(-az * 0.2, az * 0.2),
    ax * 0.34, 3.4, az * 0.30, plantCol, CONCRETE, 1, 0.92);          // lift overrun
  const nPlant = 1 + Math.floor(rnd.next() * 3);
  for (let i = 0; i < nPlant; i++) {
    const px = cx + rnd.range(-ax * 0.36, ax * 0.36);
    const pz = cz + rnd.range(-az * 0.36, az * 0.36);
    const ph = 1.0 + rnd.next() * 1.8;
    trim.box(px, rY + ph * 0.5, pz, 2.0 + rnd.next() * 2.6, ph, 1.8 + rnd.next() * 2.2,
      [tint * 0.72, tint * 0.74, tint * 0.78], [0, 0.55, 0.35], 1, 0.88);
  }
  if (rnd.next() < 0.5) {
    // Water tank on legs.
    const tx = cx + rnd.range(-ax * 0.3, ax * 0.3), tz = cz + rnd.range(-az * 0.3, az * 0.3);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      trim.box(tx + sx * 1.1, rY + 0.9, tz + sz * 1.1, 0.22, 1.8, 0.22, plantCol, [0, 0.5, 0.6]);
    }
    trim.tube([tx, rY + 1.8, tz], [tx, rY + 4.4, tz], 1.5, 1.5, 10, plantCol, TREE_UV.mass, [0, 0.62, 0.25]);
    trim.disc(tx, rY + 4.4, tz, 1.5, [0, 1, 0], 10, plantCol, TREE_UV.mass, [0, 0.62, 0.25]);
  }
  const masts = h > 55 ? 2 + Math.floor(rnd.next() * 2) : (rnd.next() < 0.4 ? 1 : 0);
  for (let i = 0; i < masts; i++) {
    const mx = cx + rnd.range(-ax * 0.4, ax * 0.4), mz = cz + rnd.range(-az * 0.4, az * 0.4);
    const mh = 4 + rnd.next() * 9;
    trim.tube([mx, rY, mz], [mx, rY + mh, mz], 0.20, 0.07, 5, [0.42, 0.44, 0.46], TREE_UV.mass, [0, 0.5, 0.55]);
    if (rnd.next() < 0.5) trim.box(mx, rY + mh * 0.62, mz, 1.7, 0.10, 0.10, [0.42, 0.44, 0.46], [0, 0.5, 0.55]);
  }
}

/** Four glazed walls of a stage, UV'd in facade tiles. */
function face(a: Acc, cx: number, cz: number, wx: number, wz: number, y0: number, y1: number, col: RGB, uOff: number, vOff: number): void {
  const x0 = cx - wx / 2, x1 = cx + wx / 2, z0 = cz - wz / 2, z1 = cz + wz / 2;
  const v0 = vOff + y0 / TILE_H, v1 = vOff + y1 / TILE_H;
  const ux = wx / TILE_W, uz = wz / TILE_W;
  const shade = [1.0, 0.90, 0.96, 0.86];
  const faces: Array<[V3, V3, number]> = [
    [[x0, y0, z1], [x1, y0, z1], ux],
    [[x1, y0, z0], [x0, y0, z0], ux],
    [[x1, y0, z1], [x1, y0, z0], uz],
    [[x0, y0, z0], [x0, y0, z1], uz],
  ];
  for (let i = 0; i < 4; i++) {
    const [p, q, u] = faces[i];
    const s = shade[i];
    a.quad(
      [p[0], y0, p[2]], [q[0], y0, q[2]], [q[0], y1, q[2]], [p[0], y1, p[2]],
      [uOff, v0, uOff + u, v0, uOff + u, v1, uOff, v1],
      [col[0] * s, col[1] * s, col[2] * s], [0, 1, 1],
    );
  }
}

/** Low-rise industrial: a portal-frame shed with a shallow pitched roof. */
function buildShed(a: Acc, rnd: { next(): number; range(a: number, b: number): number }, cx: number, cz: number, yaw: number): void {
  const wx = 18 + rnd.next() * 30, wz = 26 + rnd.next() * 44, h = 6 + rnd.next() * 4;
  const k = 0.38 + rnd.next() * 0.30;
  const col: RGB = [k * 0.96, k * 0.99, k];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const P = (lx: number, ly: number, lz: number): V3 => [cx + lx * c - lz * s, ly, cz + lx * s + lz * c];
  const hx = wx / 2, hz = wz / 2;
  const ridge = h + 1.9;
  const uv = [0, 0, wx, 0, wx, h, 0, h];
  a.quad(P(-hx, 0, hz), P(hx, 0, hz), P(hx, h, hz), P(-hx, h, hz), uv, col, CONCRETE);
  a.quad(P(hx, 0, -hz), P(-hx, 0, -hz), P(-hx, h, -hz), P(hx, h, -hz), uv, col, CONCRETE);
  a.quad(P(hx, 0, hz), P(hx, 0, -hz), P(hx, h, -hz), P(hx, h, hz), [0, 0, wz, 0, wz, h, 0, h], col, CONCRETE);
  a.quad(P(-hx, 0, -hz), P(-hx, 0, hz), P(-hx, h, hz), P(-hx, h, -hz), [0, 0, wz, 0, wz, h, 0, h], col, CONCRETE);
  // Gables and the two roof planes.
  const roofCol: RGB = [k * 0.68, k * 0.70, k * 0.74];
  a.quad(P(-hx, h, hz), P(0, ridge, hz), P(0, ridge, -hz), P(-hx, h, -hz), [0, 0, hx, 0, hx, wz, 0, wz], roofCol, [0, 0.6, 0.4]);
  a.quad(P(0, ridge, hz), P(hx, h, hz), P(hx, h, -hz), P(0, ridge, -hz), [0, 0, hx, 0, hx, wz, 0, wz], roofCol, [0, 0.6, 0.4]);
  a.quad(P(-hx, h, hz), P(hx, h, hz), P(0, ridge, hz), P(0, ridge, hz), [0, 0, wx, 0, wx, 2, 0, 2], col, CONCRETE);
  a.quad(P(hx, h, -hz), P(-hx, h, -hz), P(0, ridge, -hz), P(0, ridge, -hz), [0, 0, wx, 0, wx, 2, 0, 2], col, CONCRETE);
}

/* ==========================================================================
 *  Car-park lighting columns
 * ======================================================================== */

function buildLightPole(): THREE.BufferGeometry {
  const base = new THREE.CylinderGeometry(0.34, 0.40, 0.55, 8);
  const shaft = new THREE.CylinderGeometry(0.085, 0.17, 10.4, 8);
  const arm = new THREE.BoxGeometry(0.10, 0.10, 1.55);
  const gusset = new THREE.BoxGeometry(0.08, 0.42, 0.42);
  const door = new THREE.BoxGeometry(0.24, 0.7, 0.06);
  const STEEL: RGB = [0.72, 0.74, 0.77];
  const list: Part[] = [
    { geo: base, m: mat(0, 0.27, 0), color: [0.6, 0.6, 0.6] as RGB },
    { geo: shaft, m: mat(0, 5.5, 0), color: STEEL },
    { geo: door, m: mat(0, 1.4, 0.19), color: [0.55, 0.56, 0.58] as RGB },
    { geo: arm, m: mat(0, 10.62, 0.82, -0.10, 0, 0), color: STEEL },
    { geo: arm, m: mat(0, 10.62, -0.82, 0.10, 0, 0), color: STEEL },
    { geo: gusset, m: mat(0, 10.42, 0.36), color: STEEL },
    { geo: gusset, m: mat(0, 10.42, -0.36), color: STEEL },
  ];
  const geo = parts(list, 'park-pole');
  base.dispose(); shaft.dispose(); arm.dispose(); gusset.dispose(); door.dispose();
  return geo;
}

/** The lamp housings, kept separate so they can glow after dark. */
function buildLampHeads(): THREE.BufferGeometry {
  const head = new THREE.BoxGeometry(0.46, 0.13, 0.72);
  const lens = new THREE.BoxGeometry(0.40, 0.05, 0.62);
  const list: Part[] = [
    { geo: head, m: mat(0, 10.58, 1.52, -0.10, 0, 0), color: [0.30, 0.32, 0.35] as RGB },
    { geo: lens, m: mat(0, 10.49, 1.53, -0.10, 0, 0), color: [1, 1, 1] as RGB },
    { geo: head, m: mat(0, 10.58, -1.52, 0.10, 0, 0), color: [0.30, 0.32, 0.35] as RGB },
    { geo: lens, m: mat(0, 10.49, -1.53, 0.10, 0, 0), color: [1, 1, 1] as RGB },
  ];
  const geo = parts(list, 'park-lamp');
  head.dispose(); lens.dispose();
  return geo;
}

/* ==========================================================================
 *  Hills
 * ======================================================================== */

/**
 * The ridge line. The previous version baked a fixed cool haze into the vertex
 * colours, which at a warm 19:24 matched neither the sky nor the land and left
 * a ruler-straight horizon. Now the terrain is coloured as terrain — pasture,
 * ploughed field, woodland — and the *scene's* aerial perspective does the
 * hazing, so the ridge stays legible and follows the time of day for free.
 */
function buildHills(): THREE.Mesh {
  const rings = 12, segs = 144;
  const r0 = 545, r1 = 845;
  const pos: number[] = [], col: number[] = [], idx: number[] = [], nor: number[] = [], uv: number[] = [];
  for (let j = 0; j < rings; j++) {
    const t = j / (rings - 1);
    const r = r0 + (r1 - r0) * t;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const cx = Math.cos(a), cz = Math.sin(a);
      const ridge = ridged2(cx * 3.1 + 11, cz * 3.1, { octaves: 4, seed: 12 });
      const roll = fbm2(cx * 1.4, cz * 1.4, { octaves: 3, seed: 40 }) * 0.5 + 0.5;
      const detail = fbm2(cx * 9 + t * 3, cz * 9, { octaves: 3, seed: 71 });
      const profile = Math.min(1, t * 1.9);
      // Capped around 130 m: the establishing camera's frame top is only
      // 2.5 deg above horizontal, so a taller ridge is simply cropped off.
      const h = (ridge * 82 + roll * 40) * profile * (0.45 + 0.70 * t) + detail * 8 * profile;
      pos.push(cx * r, h - 4, cz * r);
      nor.push(0, 1, 0);
      uv.push(i / segs, t);
      // Land cover: pasture in the folds, woodland on the shoulders, bare
      // grass on the tops. A little cool desaturation with height only.
      const wood = smoothstep(0.15, 0.55, ridge) * (0.5 + 0.5 * roll);
      const alt = clamp(h / 150, 0, 1);
      const r8 = 0.130 + roll * 0.075 - wood * 0.055 + alt * 0.055;
      const g8 = 0.185 + roll * 0.100 - wood * 0.030 + alt * 0.050;
      const b8 = 0.105 + roll * 0.055 - wood * 0.030 + alt * 0.085;
      col.push(r8, g8, b8);
    }
  }
  for (let j = 0; j < rings - 1; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.name = 'hills';
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, metalness: 0, flatShading: true, name: 'hills',
  }));
  m.castShadow = false;
  m.receiveShadow = false;
  m.name = 'hills';
  // Read the horizon colour the sky is currently publishing, and lean the far
  // ridge toward it. This is the same number `Aerial.ts` fogs with, so the
  // ridge fades into the *actual* horizon at every hour instead of a constant.
  const c0 = new THREE.Color();
  m.onBeforeRender = () => {
    const h = AERIAL.uAerialHoriz;
    c0.setRGB(0.80 + h[0] * 0.55, 0.82 + h[1] * 0.5, 0.84 + h[2] * 0.5);
    (m.material as THREE.MeshStandardMaterial).color.copy(c0);
  };
  return m;
}

/* ==========================================================================
 *  Ground plans
 * ======================================================================== */

/** Traces the stadium's plan outline offset outward by `off`, in canvas px. */
function planPath(c: CanvasRenderingContext2D, cx: number, cy: number, px: (m: number) => number, off: number): void {
  const bx = BOWL.hx + PAD, bz = BOWL.hz + PAD, br = BOWL.cornerR + PAD;
  const hx = px(bx + off), hz = px(bz + off), r = px(br + off);
  c.beginPath();
  c.moveTo(cx - hx + r, cy - hz);
  c.lineTo(cx + hx - r, cy - hz);
  c.arcTo(cx + hx, cy - hz, cx + hx, cy - hz + r, r);
  c.lineTo(cx + hx, cy + hz - r);
  c.arcTo(cx + hx, cy + hz, cx + hx - r, cy + hz, r);
  c.lineTo(cx - hx + r, cy + hz);
  c.arcTo(cx - hx, cy + hz, cx - hx, cy + hz - r, r);
  c.lineTo(cx - hx, cy - hz + r);
  c.arcTo(cx - hx, cy - hz, cx - hx + r, cy - hz, r);
  c.closePath();
}

/** Deterministic 0..1 from an index — the plan bakes must not touch Math.random. */
const h1 = (i: number, s: number) => hash2(i, s, 7717);

/**
 * The near ground plan: 420 m across at about 0.2 m per texel. This is where
 * the asphalt lives — patching, seams, joints, oil drip lanes, drainage
 * channels and gully covers, tyre polish down the aisles, and the ring road
 * with its own markings. Bay lines and kerbs are *geometry*, not paint here,
 * because two pixels of white line has to stay two pixels of white line.
 */
function bakeNearPlan(S: number, lots: Lot[]): THREE.CanvasTexture {
  return canvasTexture(S, S, (c, W, H) => {
    const px = (m: number) => (m / (NEAR_R * 2)) * W;
    const cx = W / 2, cy = H / 2;
    const plan = (off: number) => planPath(c, cx, cy, px, off);
    /** Closed region between two offsets over a t-range — one lot's asphalt. */
    const band = (t0: number, t1: number, oIn: number, oOut: number) => {
      const n = Math.max(8, Math.round((t1 - t0) * 260));
      c.beginPath();
      for (let i = 0; i <= n; i++) {
        ptAt(t0 + (t1 - t0) * (i / n), oOut, _e);
        const x = cx + px(_e.x), y = cy + px(_e.z);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      for (let i = n; i >= 0; i--) {
        ptAt(t0 + (t1 - t0) * (i / n), oIn, _e);
        c.lineTo(cx + px(_e.x), cy + px(_e.z));
      }
      c.closePath();
    };
    /** Open polyline along the plan over a t-range. */
    const arc = (t0: number, t1: number, off: number) => {
      const n = Math.max(8, Math.round((t1 - t0) * 260));
      c.beginPath();
      for (let i = 0; i <= n; i++) {
        ptAt(t0 + (t1 - t0) * (i / n), off, _e);
        const x = cx + px(_e.x), y = cy + px(_e.z);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
    };

    // Verge grass everywhere, then the site cut out of it.
    c.fillStyle = '#3a4d2e';
    c.fillRect(0, 0, W, H);
    // The far plan's hedged field parcels, repeated at the same world pitch so
    // the two textures agree across the blend and the join cannot be found.
    fieldParcels(c, px, W, H, 74);
    for (let i = 0; i < 5200; i++) {
      const x = h1(i, 3) * W, y = h1(i, 11) * H;
      const n = fbm2((x / W - 0.5) * 30, (y / H - 0.5) * 30, { octaves: 3, seed: 4 });
      c.fillStyle = n > 0 ? 'rgba(96,122,72,0.20)' : 'rgba(48,68,42,0.24)';
      c.fillRect(x, y, px(3.2), px(3.2));
    }
    // Mown parkland belt round the venue, inside the field pattern.
    c.save();
    plan(190); c.clip();
    c.fillStyle = 'rgba(60,78,44,0.80)';
    c.fillRect(0, 0, W, H);
    c.restore();

    /* car park -------------------------------------------------------------
     * One asphalt band per lot, not an unbroken ring. Markings, drainage and
     * wear are clipped to each band, which is what stops the site reading as
     * a set of concentric racetrack ovals.
     */
    for (const l of lots) {
      const oIn = l.base - 3.2;
      const oOut = l.base + l.depth * 2 + l.aisle + 3.2;
      c.fillStyle = '#4a4b51';
      band(l.t0, l.t1, oIn, oOut); c.fill();

      c.save();
      band(l.t0, l.t1, oIn, oOut); c.clip();

      // Patches: darker, freshly laid rectangles.
      const patches = Math.round((l.t1 - l.t0) * 90);
      for (let i = 0; i < patches; i++) {
        const id = i + Math.round(l.base * 13 + l.t0 * 977);
        ptAt(l.t0 + (l.t1 - l.t0) * h1(id, 21), oIn + h1(id, 23) * (oOut - oIn), _e);
        const w = px(4 + h1(id, 27) * 20), hgt = px(3 + h1(id, 29) * 14);
        c.save();
        c.translate(cx + px(_e.x), cy + px(_e.z));
        c.rotate(h1(id, 31) * Math.PI);
        c.fillStyle = h1(id, 37) > 0.5 ? 'rgba(22,22,26,0.50)' : 'rgba(78,76,76,0.34)';
        c.fillRect(-w / 2, -hgt / 2, w, hgt);
        c.restore();
      }
      // Surfacing joints along the lot.
      c.strokeStyle = 'rgba(18,18,22,0.34)';
      c.lineWidth = Math.max(1, px(0.18));
      for (let k = 0; k < 5; k++) { arc(l.t0, l.t1, oIn + (k + 0.5) * (oOut - oIn) / 5); c.stroke(); }
      // Aisle: tyre polish, then the drainage channel down its centre.
      const aisleOff = l.base + l.depth + l.aisle * 0.5;
      c.strokeStyle = 'rgba(152,150,146,0.10)';
      c.lineWidth = px(4.2);
      arc(l.t0, l.t1, aisleOff); c.stroke();
      c.strokeStyle = 'rgba(16,16,20,0.60)';
      c.lineWidth = Math.max(1, px(0.42));
      arc(l.t0, l.t1, aisleOff); c.stroke();
      // Oil drip lanes where every bonnet sits.
      c.strokeStyle = 'rgba(12,12,14,0.34)';
      c.lineWidth = px(0.9);
      c.setLineDash([px(1.1), px(1.6)]);
      arc(l.t0, l.t1, l.base + l.depth * 0.72); c.stroke();
      arc(l.t0, l.t1, l.base + l.depth + l.aisle + l.depth * 0.28); c.stroke();
      c.setLineDash([]);
      // Standing water against the kerb line.
      for (let i = 0; i < Math.round((l.t1 - l.t0) * 40); i++) {
        const id = i * 7 + Math.round(l.base * 31 + l.t0 * 613);
        ptAt(l.t0 + (l.t1 - l.t0) * h1(id, 41), oIn + h1(id, 43) * (oOut - oIn), _e);
        const rad = px(2.5 + h1(id, 47) * 7);
        const x = cx + px(_e.x), y = cy + px(_e.z);
        const grd = c.createRadialGradient(x, y, 0, x, y, rad);
        grd.addColorStop(0, 'rgba(16,17,20,0.40)');
        grd.addColorStop(1, 'rgba(16,17,20,0)');
        c.fillStyle = grd;
        c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.fill();
      }
      c.restore();

      // Gully covers down the aisle.
      c.fillStyle = 'rgba(26,26,30,0.85)';
      const gn = Math.max(2, Math.round((l.t1 - l.t0) * perimeterAt(aisleOff) / 18));
      for (let i = 0; i < gn; i++) {
        ptAt(l.t0 + (l.t1 - l.t0) * ((i + 0.5) / gn), aisleOff, _e);
        c.fillRect(cx + px(_e.x) - px(0.35), cy + px(_e.z) - px(0.35), px(0.7), px(0.7));
      }
    }

    // The paved concourse hardstand rings the building; that one *is* a loop.
    c.fillStyle = '#6b6a67';
    plan(11); c.fill();

    /* concourse hardstand ------------------------------------------------- */
    c.save();
    plan(11); c.clip();
    c.strokeStyle = 'rgba(120,118,112,0.55)';
    c.lineWidth = Math.max(1, px(0.16));
    for (let k = 0; k < 4; k++) { plan(1 + k * 2.6); c.stroke(); }
    c.fillStyle = 'rgba(70,70,68,0.35)';
    for (let i = 0; i < 260; i++) {
      const a = h1(i, 53) * Math.PI * 2;
      const rr = 40 + h1(i, 59) * 60;
      c.fillRect(cx + Math.cos(a) * px(rr), cy + Math.sin(a) * px(rr), px(1.4), px(1.4));
    }
    c.restore();

    /* ring road ----------------------------------------------------------- */
    c.strokeStyle = '#2b2c30'; c.lineWidth = px(11);
    plan(92); c.stroke();
    c.strokeStyle = 'rgba(228,224,186,0.60)'; c.lineWidth = Math.max(1, px(0.16));
    c.setLineDash([px(3.6), px(4.4)]);
    plan(92); c.stroke();
    c.setLineDash([]);
    c.strokeStyle = 'rgba(232,232,226,0.45)'; c.lineWidth = Math.max(1, px(0.14));
    plan(87.2); c.stroke();
    plan(96.8); c.stroke();

    // Approach roads striking off the ring road, four of them.
    c.strokeStyle = '#2b2c30'; c.lineWidth = px(12);
    for (let i = 0; i < 4; i++) {
      ptAt(0.125 + i * 0.25, 92, _e);
      c.beginPath();
      c.moveTo(cx + px(_e.x), cy + px(_e.z));
      c.lineTo(cx + _e.nx * W, cy + _e.nz * W);
      c.stroke();
    }
    c.strokeStyle = 'rgba(228,224,186,0.5)'; c.lineWidth = Math.max(1, px(0.16));
    c.setLineDash([px(3.6), px(4.4)]);
    for (let i = 0; i < 4; i++) {
      ptAt(0.125 + i * 0.25, 92, _e);
      c.beginPath();
      c.moveTo(cx + px(_e.x), cy + px(_e.z));
      c.lineTo(cx + _e.nx * W, cy + _e.nz * W);
      c.stroke();
    }
    c.setLineDash([]);

    // Contact darkening where the building meets the ground, following the
    // roof edge in rather than a radial gradient that cannot know the plan.
    const roofOut = roofBackOff();
    c.save();
    plan(roofOut - PAD + 12); c.clip();
    for (let k = 10; k >= 0; k--) {
      c.fillStyle = `rgba(0,0,0,${0.070 * (1 - k / 11)})`;
      plan(-2 + k * 2.6); c.fill();
    }
    c.restore();
  }, { name: 'near-plan', wrap: THREE.ClampToEdgeWrapping, anisotropy: 16 });
}

/**
 * The far plan: country, hedged field parcels, the road network and the city
 * blocks the towers stand on. Everything inside 210 m is overdrawn by the near
 * plan, so this only has to hold up from about a quarter of a kilometre out.
 */
function bakeGroundPlan(radius: number, lots: Lot[]): THREE.CanvasTexture {
  const S = 1024;
  return canvasTexture(S, S, (c, W, H) => {
    const px = (m: number) => (m / (radius * 2)) * W;
    const cx = W / 2, cy = H / 2;
    const plan = (off: number) => planPath(c, cx, cy, px, off);
    const band = (t0: number, t1: number, oIn: number, oOut: number) => {
      const n = Math.max(8, Math.round((t1 - t0) * 200));
      c.beginPath();
      for (let i = 0; i <= n; i++) {
        ptAt(t0 + (t1 - t0) * (i / n), oOut, _e);
        const x = cx + px(_e.x), y = cy + px(_e.z);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      for (let i = n; i >= 0; i--) {
        ptAt(t0 + (t1 - t0) * (i / n), oIn, _e);
        c.lineTo(cx + px(_e.x), cy + px(_e.z));
      }
      c.closePath();
    };

    c.fillStyle = '#354a2c';
    c.fillRect(0, 0, W, H);

    // Field parcels: a jittered grid of pasture / plough / stubble, hedged.
    fieldParcels(c, px, W, H, 74);

    // City blocks: darker paved ground under each district.
    const districts: Array<[number, number, number]> = [
      [-330, -110, 158], [140, -395, 142], [365, 190, 163],
    ];
    for (let d = 0; d < districts.length; d++) {
      const [dx, dz, dr] = districts[d];
      c.save();
      c.translate(cx + px(dx), cy + px(dz));
      c.fillStyle = '#43443f';
      c.beginPath(); c.arc(0, 0, px(dr), 0, Math.PI * 2); c.fill();
      // Street grid inside the district.
      c.strokeStyle = 'rgba(30,31,34,0.85)';
      c.lineWidth = Math.max(1, px(9));
      c.save();
      c.beginPath(); c.arc(0, 0, px(dr), 0, Math.PI * 2); c.clip();
      const st = px(2 * dr / 6);
      for (let i = -4; i <= 4; i++) {
        c.beginPath(); c.moveTo(i * st, -px(dr)); c.lineTo(i * st, px(dr)); c.stroke();
        c.beginPath(); c.moveTo(-px(dr), i * st); c.lineTo(px(dr), i * st); c.stroke();
      }
      c.restore();
      c.restore();
    }

    // Trunk roads: the ring road out to each district, plus the approaches.
    c.strokeStyle = '#2b2c30'; c.lineWidth = px(11);
    plan(92); c.stroke();
    for (let i = 0; i < 4; i++) {
      ptAt(0.125 + i * 0.25, 92, _e);
      c.beginPath();
      c.moveTo(cx + px(_e.x), cy + px(_e.z));
      c.lineTo(cx + _e.nx * W, cy + _e.nz * W);
      c.stroke();
    }
    c.lineWidth = px(9);
    for (const [dx, dz] of districts) {
      c.beginPath();
      c.moveTo(cx, cy);
      c.quadraticCurveTo(cx + px(dx) * 0.4, cy + px(dz) * 0.8, cx + px(dx), cy + px(dz));
      c.stroke();
    }

    // The site itself, so the 210 m blend has the same thing on both sides.
    c.fillStyle = '#4a4b51';
    for (const l of lots) {
      band(l.t0, l.t1, l.base - 3.2, l.base + l.depth * 2 + l.aisle + 3.2);
      c.fill();
    }
    c.fillStyle = '#6b6a67';
    plan(11); c.fill();
  }, { name: 'ground-plan', wrap: THREE.ClampToEdgeWrapping, anisotropy: 16 });
}

/**
 * A hedged field pattern at a fixed *world* pitch. Both ground plans call this
 * with the same pitch, which is what makes the 210 m blend between them
 * impossible to find: the countryside is the same countryside on either side.
 */
function fieldParcels(
  c: CanvasRenderingContext2D, px: (m: number) => number, W: number, H: number, pitchM: number,
): void {
  const cell = px(pitchM);
  const nx = Math.ceil(W / cell) + 2, ny = Math.ceil(H / cell) + 2;
  // Grid indices are anchored on the canvas centre (world origin) so the two
  // textures place the same parcel at the same world position.
  const i0 = -Math.ceil(nx / 2), j0 = -Math.ceil(ny / 2);
  for (let gy = j0; gy < j0 + ny + 1; gy++) {
    for (let gx = i0; gx < i0 + nx + 1; gx++) {
      const id = gx * 131 + gy * 977;
      const k = h1(id, 5);
      const jx = (h1(id, 9) - 0.5) * cell * 0.3, jy = (h1(id, 13) - 0.5) * cell * 0.3;
      const w = cell * (0.7 + h1(id, 17) * 0.55), hh = cell * (0.7 + h1(id, 19) * 0.55);
      c.save();
      c.translate(W / 2 + gx * cell + jx, H / 2 + gy * cell + jy);
      c.rotate((h1(id, 23) - 0.5) * 0.28);
      c.fillStyle = k > 0.72 ? '#55502f' : k > 0.5 ? '#3e5330' : k > 0.28 ? '#354628' : '#465730';
      c.fillRect(0, 0, w, hh);
      if (k > 0.72) {
        c.strokeStyle = 'rgba(58,48,34,0.35)';
        c.lineWidth = Math.max(1, px(2));
        for (let s = 0; s < 14; s++) {
          c.beginPath(); c.moveTo(0, (s / 14) * hh); c.lineTo(w, (s / 14) * hh); c.stroke();
        }
      }
      c.strokeStyle = 'rgba(28,44,24,0.8)';
      c.lineWidth = Math.max(1, px(3));
      c.strokeRect(0, 0, w, hh);
      c.restore();
    }
  }
}
