import * as THREE from 'three';
import { canvasTexture, linearColor } from '../../util/Tex';
import { fbm2, ridged2, clamp, smoothstep } from '../../util/Noise';
import type { Ctx } from '../../core/Ctx';
import { parts, mat, type Part, type RGB } from './Geo';
import type { StadiumMaterials } from './Materials';
import { BOWL, FACADE_OFF, roofBackOff, ptAt, type RingPt } from './Layout';

/**
 * Context beyond the bowl so the horizon is never empty: an apron of hardstand
 * and car parks, a treed ring, a low-rise city edge and a band of hills that
 * fades into aerial perspective. Everything is instanced or merged, and the
 * whole thing is four draw calls.
 *
 * Everything close in is laid out on the *bowl's own plan* offset outward
 * (`ptAt`), not on a circle. A circular apron round a 107 × 170 m building
 * either cuts through the ends or leaves a huge empty crescent at the sides,
 * and either one instantly rescales the venue in the establishing shot.
 */

/** Outer face of the stadium facade — everything outside is laid out from here. */
const PAD = FACADE_OFF;

const _e: RingPt = { x: 0, z: 0, nx: 0, nz: 0, t: 0, seg: 0 };

export function buildExterior(ctx: Ctx, M: StadiumMaterials): THREE.Group {
  const g = new THREE.Group();
  g.name = 'exterior';
  const rnd = ctx.rand.fork(0xe7e2);
  const tier = ctx.quality.tier;
  const scale = tier === 'low' ? 0.35 : tier === 'medium' ? 0.6 : 1;

  /* ------------------------------------------------------------- ground */
  const groundR = 870;   // just inside the camera's 900 m far plane
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(groundR, 72),
    new THREE.MeshStandardMaterial({
      map: bakeGroundPlan(groundR), roughness: 0.97, metalness: 0, name: 'exterior-ground',
    }),
  );

  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.09;
  ground.receiveShadow = true;
  g.add(ground);

  /* ------------------------------------------------------------- hills */
  g.add(buildHills(rnd));

  /* --------------------------------------------------------- buildings */
  const protos = [
    new THREE.BoxGeometry(26, 1, 26),
    new THREE.BoxGeometry(18, 1, 34),
    new THREE.BoxGeometry(34, 1, 20),
  ];
  const winTex = bakeFacade();
  const buildingMat = new THREE.MeshStandardMaterial({
    map: winTex, emissiveMap: winTex, emissive: new THREE.Color(0, 0, 0),
    roughness: 0.55, metalness: 0.25, vertexColors: true, name: 'buildings',
  });
  const perProto = Math.max(3, Math.round(9 * scale));
  const buildings: THREE.InstancedMesh[] = [];
  for (let p = 0; p < protos.length; p++) {
    const im = new THREE.InstancedMesh(protos[p], buildingMat, perProto);
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    for (let i = 0; i < perProto; i++) {
      const a = (p / protos.length + i / perProto) * Math.PI * 2 + rnd.range(-0.16, 0.16);
      const r = 300 + rnd.next() * 320;
      const h = 24 + rnd.next() * rnd.next() * 90;
      m4.copy(mat(Math.cos(a) * r, h / 2, Math.sin(a) * r, 0, rnd.range(0, Math.PI), 0, 1, h, 1));
      im.setMatrixAt(i, m4);
      const k = 0.42 + rnd.next() * 0.32;
      col.setRGB(k * (0.9 + rnd.next() * 0.2), k, k * (1.05 + rnd.next() * 0.12));
      im.setColorAt(i, col);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = false;
    im.receiveShadow = false;
    im.name = `buildings-${p}`;
    buildings.push(im);
    g.add(im);
  }

  /* ------------------------------------------------------------- trees */
  const treeGeo = buildTree();
  const treeCount = Math.round(320 * scale);
  const trees = new THREE.InstancedMesh(treeGeo, M.foliage, treeCount);
  trees.name = 'trees';
  {
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    for (let i = 0; i < treeCount; i++) {
      const off = PAD + 96 + rnd.next() * rnd.next() * 300;
      ptAt(rnd.next(), off, _e);
      const s = 0.75 + rnd.next() * 0.75;
      m4.copy(mat(_e.x, 0, _e.z, 0, rnd.range(0, 6.28), 0, s, s * (0.85 + rnd.next() * 0.4), s));
      trees.setMatrixAt(i, m4);
      const k = 0.55 + rnd.next() * 0.5;
      col.setRGB(k * 0.72, k, k * 0.6);
      trees.setColorAt(i, col);
    }
    trees.instanceMatrix.needsUpdate = true;
    if (trees.instanceColor) trees.instanceColor.needsUpdate = true;
  }
  trees.castShadow = false;
  trees.receiveShadow = false;
  g.add(trees);

  /* -------------------------------------------------- car-park lighting */
  const poleGeo = buildLightPole();
  const poleCount = Math.round(46 * scale);
  const poles = new THREE.InstancedMesh(poleGeo, M.steelDark, poleCount);
  poles.name = 'park-poles';
  {
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < poleCount; i++) {
      const off = PAD + 26 + (i % 3) * 22;
      ptAt((i + 0.35) / poleCount, off, _e);
      m4.copy(mat(_e.x, 0, _e.z, 0, Math.atan2(_e.nx, _e.nz) + Math.PI, 0));
      poles.setMatrixAt(i, m4);
    }
    poles.instanceMatrix.needsUpdate = true;
  }
  poles.castShadow = false;
  g.add(poles);

  /* -------------------------------------------------------------- cars */
  const carGeo = buildCar();
  const carCount = Math.round(360 * scale);
  const cars = new THREE.InstancedMesh(carGeo, M.glass, carCount);
  cars.name = 'cars';
  {
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    const palette = [0xd8dade, 0x1b1d21, 0x8b9096, 0x2c4a6e, 0x7a2320, 0xb0b6bc, 0x394048];
    // Three continuous double-loaded bays following the facade line.
    const lanes = 3;
    const perLane = Math.max(1, Math.ceil(carCount / lanes));
    for (let i = 0; i < carCount; i++) {
      const lane = i % lanes;
      const slot = Math.floor(i / lanes);
      const off = PAD + 18 + lane * 12 + (slot % 2) * 5.2;
      ptAt((slot + 0.5) / perLane, off, _e);
      const yaw = Math.atan2(_e.nx, _e.nz) + (slot % 2 ? Math.PI : 0);
      m4.copy(mat(_e.x, 0, _e.z, 0, yaw, 0));
      cars.setMatrixAt(i, m4);
      col.setHex(palette[(i * 7) % palette.length], THREE.SRGBColorSpace);
      cars.setColorAt(i, col);
    }
    cars.instanceMatrix.needsUpdate = true;
    if (cars.instanceColor) cars.instanceColor.needsUpdate = true;
  }
  cars.castShadow = false;
  g.add(cars);

  (g as THREE.Group & { userData: { buildingMat: THREE.MeshStandardMaterial } }).userData.buildingMat = buildingMat;
  return g;
}

/** Lets the stadium switch the city over to lit windows after dark. */
export function setExteriorNight(g: THREE.Group, k: number): void {
  const m = (g.userData as { buildingMat?: THREE.MeshStandardMaterial }).buildingMat;
  if (m) m.emissive.setRGB(k * 0.95, k * 0.85, k * 0.62);
}

/* ---------------------------------------------------------------- pieces */

function buildTree(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.16, 0.28, 3.0, 5);
  const blob = new THREE.IcosahedronGeometry(1, 0);
  const list: Part[] = [
    { geo: trunk, m: mat(0, 1.5, 0), color: [0.34, 0.26, 0.2] as RGB },
    { geo: blob, m: mat(0, 4.4, 0, 0.3, 0.6, 0, 2.5, 2.9, 2.5), color: [1, 1, 1] as RGB },
    { geo: blob, m: mat(0.9, 3.4, -0.5, 0.9, 1.7, 0.3, 1.7, 1.5, 1.7), color: [0.82, 0.86, 0.8] as RGB },
    { geo: blob, m: mat(-0.8, 5.6, 0.4, 0.2, 2.4, 0.6, 1.4, 1.3, 1.4), color: [1.12, 1.1, 1.05] as RGB },
  ];
  const geo = parts(list, 'tree');
  trunk.dispose(); blob.dispose();
  return geo;
}

function buildLightPole(): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(0.09, 0.14, 9, 6);
  const arm = new THREE.BoxGeometry(1.5, 0.12, 0.16);
  const head = new THREE.BoxGeometry(0.7, 0.16, 0.34);
  const list: Part[] = [
    { geo: shaft, m: mat(0, 4.5, 0), color: [0.7, 0.72, 0.75] as RGB },
    { geo: arm, m: mat(0.7, 8.9, 0), color: [0.7, 0.72, 0.75] as RGB },
    { geo: head, m: mat(1.35, 8.78, 0), color: [0.85, 0.87, 0.9] as RGB },
  ];
  const geo = parts(list, 'park-pole');
  shaft.dispose(); arm.dispose(); head.dispose();
  return geo;
}

function buildCar(): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const list: Part[] = [
    { geo: box, m: mat(0, 0.55, 0, 0, 0, 0, 1.82, 0.62, 4.3), color: [1, 1, 1] as RGB },
    { geo: box, m: mat(0, 1.05, -0.15, 0, 0, 0, 1.62, 0.52, 2.1), color: [0.4, 0.44, 0.5] as RGB },
  ];
  const geo = parts(list, 'car');
  box.dispose();
  return geo;
}

/** A ring of low-poly terrain, colour-graded toward the haze with distance. */
function buildHills(rnd: { next(): number }): THREE.Mesh {
  const rings = 9, segs = 96;
  const r0 = 420, r1 = 855;
  const pos: number[] = [], col: number[] = [], idx: number[] = [], nor: number[] = [], uv: number[] = [];
  for (let j = 0; j < rings; j++) {
    const t = j / (rings - 1);
    const r = r0 + (r1 - r0) * t;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const cx = Math.cos(a), cz = Math.sin(a);
      const ridge = ridged2(cx * 3.1 + 11, cz * 3.1, { octaves: 4, seed: 12 });
      const roll = fbm2(cx * 1.4, cz * 1.4, { octaves: 3, seed: 40 }) * 0.5 + 0.5;
      const profile = Math.min(1, t * 2.4);   // rises away from the venue
      const h = (ridge * 150 + roll * 70) * profile * (0.55 + 0.6 * t);
      pos.push(cx * r, h - 4, cz * r);
      nor.push(0, 1, 0);
      uv.push(i / segs, t);
      // fade toward atmospheric haze with distance
      const haze = clamp((r - r0) / (r1 - r0), 0, 1) * 0.75;
      const green = 0.24 + roll * 0.16 + (h / 200) * 0.08;
      col.push(
        (0.18 + green * 0.35) * (1 - haze) + 0.52 * haze,
        (0.26 + green * 0.5) * (1 - haze) + 0.60 * haze,
        (0.20 + green * 0.32) * (1 - haze) + 0.74 * haze,
      );
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
  void rnd;
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, metalness: 0, flatShading: true, name: 'hills',
  }));
  m.castShadow = false;
  m.receiveShadow = false;
  return m;
}

/* -------------------------------------------------------------- textures */

/**
 * Plan-view ground: hardstand apron, car-park bays, ring road, then open
 * country. Every band is an outward offset of the *stadium's* rounded-rect
 * plan, so the apron hugs the building instead of hoop-la-ing round it.
 *
 * NB the world's +Z maps to canvas +Y here, and the stadium is long in Z, so
 * the rects are (halfX → canvas X, halfZ → canvas Y).
 */
function bakeGroundPlan(radius: number): THREE.CanvasTexture {
  const S = 1024;
  return canvasTexture(S, S, (c, W, H) => {
    const px = (m: number) => (m / (radius * 2)) * W;
    const cx = W / 2, cy = H / 2;
    // Building half-extents at grade, and the outer edge of the canopy.
    const bx = BOWL.hx + PAD, bz = BOWL.hz + PAD, br = BOWL.cornerR + PAD;
    const roofOut = roofBackOff();

    const plan = (off: number) => {
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
    };

    c.fillStyle = '#3d5c33';
    c.fillRect(0, 0, W, H);

    // Mottled country
    for (let i = 0; i < 3600; i++) {
      const x = (i * 2654435761 % 100000) / 100000 * W;
      const y = ((i * 40503) % 100000) / 100000 * H;
      const u = x / W - 0.5, v = y / H - 0.5;
      const n = fbm2(u * 22, v * 22, { octaves: 3, seed: 4 });
      c.fillStyle = n > 0 ? 'rgba(90,120,70,0.22)' : 'rgba(48,72,44,0.28)';
      c.fillRect(x, y, 14, 14);
    }

    // Car parks, then the paved hardstand concourse on top of them.
    c.fillStyle = '#3a3a3c';
    plan(74); c.fill();
    c.fillStyle = '#5a5a58';
    plan(14); c.fill();

    // Parking bay lines, struck perpendicular to each bay's centre line.
    c.strokeStyle = 'rgba(235,235,220,0.42)';
    c.lineWidth = Math.max(1, px(0.28));
    for (let ring = 0; ring < 3; ring++) {
      const off = 18 + ring * 12;
      const n = 150 + ring * 26;
      for (let i = 0; i < n; i++) {
        ptAt(i / n, off, _e);
        const x0 = cx + px(_e.x), y0 = cy + px(_e.z);
        c.beginPath();
        c.moveTo(x0, y0);
        c.lineTo(x0 + px(_e.nx * 10.4), y0 + px(_e.nz * 10.4));
        c.stroke();
      }
    }

    // Ring road with a dashed centre line.
    c.strokeStyle = '#2f3032'; c.lineWidth = Math.max(3, px(9));
    plan(84); c.stroke();
    c.strokeStyle = 'rgba(230,225,180,0.5)'; c.lineWidth = Math.max(1, px(0.5));
    c.setLineDash([px(4), px(5)]);
    plan(84); c.stroke();
    c.setLineDash([]);

    // Approach roads striking off the ring road.
    c.strokeStyle = '#2f3032'; c.lineWidth = px(11);
    for (let i = 0; i < 4; i++) {
      ptAt(0.125 + i * 0.25, 84, _e);
      c.beginPath();
      c.moveTo(cx + px(_e.x), cy + px(_e.z));
      c.lineTo(cx + _e.nx * W, cy + _e.nz * W);
      c.stroke();
    }

    // Contact shadow where the building meets the ground, following the roof
    // edge in rather than a radial gradient that cannot know the plan.
    c.save();
    plan(roofOut - PAD + 10); c.clip();
    for (let k = 8; k >= 0; k--) {
      c.fillStyle = `rgba(0,0,0,${0.075 * (1 - k / 9)})`;
      plan(-2 + k * 2.4); c.fill();
    }
    c.restore();
  }, { name: 'ground-plan', wrap: THREE.ClampToEdgeWrapping, anisotropy: 16 });
}

/** Facade with window grid — doubles as the emissive map after dark. */
function bakeFacade(): THREE.CanvasTexture {
  const S = 512;
  return canvasTexture(S, S, (c, W, H) => {
    c.fillStyle = '#0e1116';
    c.fillRect(0, 0, W, H);
    const cols = 22, rows = 30;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
        const lit = (h % 100) / 100;
        const w = W / cols, hh = H / rows;
        c.fillStyle = lit > 0.55
          ? `rgba(${200 + (h % 40)},${180 + (h % 50)},${130 + (h % 70)},0.95)`
          : 'rgba(30,38,48,0.9)';
        c.fillRect(x * w + w * 0.16, y * hh + hh * 0.2, w * 0.68, hh * 0.5);
      }
    }
    c.fillStyle = 'rgba(255,255,255,0.05)';
    for (let y = 0; y < rows; y++) c.fillRect(0, (y / rows) * H, W, 2);
    void smoothstep; void linearColor;
  }, { name: 'facade', wrap: THREE.RepeatWrapping, anisotropy: 4 });
}
