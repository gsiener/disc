import * as THREE from 'three';
import { canvasTexture } from '../../util/Tex';
import type { Ctx } from '../../core/Ctx';
import { Mesher, parts, strut, mat, UNIT_BOX, type Part, type RGB } from './Geo';
import type { StadiumMaterials } from './Materials';
import { FIELD, BOWL, ROOF, roofYAt } from './Layout';

/**
 * Sideline dressing. An empty touchline is the single fastest way to make a
 * stadium read as unfinished, so the run-off carries the whole broadcast kit:
 * team benches under canopies, coolers and water jugs, kit bags, cone stacks,
 * medical carts, a hung camera gantry with operators, hand-held camera crews,
 * a boom op, a sideline reporter and a row of endline photographers.
 *
 * Everything lands in three buffers — hard props (steel/plastic), soft goods
 * (fabric) and people — plus one instanced mesh per small repeated prop.
 */

// Centre of the run-off strip between the touchline and the perimeter wall.
// Derived so the benches and their canopies stay clear of both.
const APRON_X = (FIELD.halfW + BOWL.hx) * 0.5;
const CREW_X = -APRON_X;

export interface SidelineBuild {
  group: THREE.Group;
}

export function buildSideline(ctx: Ctx, M: StadiumMaterials): SidelineBuild {
  const g = new THREE.Group();
  g.name = 'sideline';
  const rnd = ctx.rand.fork(0xb0a7);

  const hard: Part[] = [];
  const soft: Part[] = [];
  const people: Part[] = [];
  const plastic: Part[] = [];

  const BOX = UNIT_BOX;
  const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
  const CYL6 = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
  const SPH = new THREE.SphereGeometry(0.5, 10, 7);
  const CONE = new THREE.ConeGeometry(0.5, 1, 8);

  /* --------------------------------------------------------- team benches */
  const benchZ = [-19, 19];
  const teamCol: RGB[] = [[0.10, 0.24, 0.40], [0.55, 0.14, 0.10]];
  for (let t = 0; t < 2; t++) {
    const z0 = benchZ[t];
    const col = teamCol[t];

    // Canopy: four legs, a frame, a fabric roof with a valance.
    const cw = 5.4, cd = 3.4, ch = 2.55;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      hard.push({ ...strut([APRON_X + sx * cd / 2, 0, z0 + sz * cw / 2], [APRON_X + sx * cd / 2, ch, z0 + sz * cw / 2], 0.075, BOX), color: [0.8, 0.82, 0.85] });
    }
    for (const sx of [-1, 1]) {
      hard.push({ ...strut([APRON_X + sx * cd / 2, ch, z0 - cw / 2], [APRON_X + sx * cd / 2, ch, z0 + cw / 2], 0.07, BOX), color: [0.8, 0.82, 0.85] });
    }
    soft.push({ geo: BOX, m: mat(APRON_X, ch + 0.36, z0, 0, 0, 0, cd + 0.5, 0.09, cw + 0.5), color: col });
    for (const sx of [-1, 1]) {
      soft.push({ geo: BOX, m: mat(APRON_X + sx * (cd + 0.5) / 2, ch + 0.2, z0, 0, 0, 0, 0.06, 0.42, cw + 0.5), color: col });
      soft.push({ ...pyramidSide(APRON_X, ch, z0, cd + 0.5, cw + 0.5, 0.42, sx, 0), color: [col[0] * 1.15, col[1] * 1.15, col[2] * 1.15] });
    }
    for (const sz of [-1, 1]) {
      soft.push({ geo: BOX, m: mat(APRON_X, ch + 0.2, z0 + sz * (cw + 0.5) / 2, 0, 0, 0, cd + 0.5, 0.42, 0.06), color: col });
    }

    // Bench: slatted seat + back, on a steel frame.
    for (let b = 0; b < 2; b++) {
      const bz = z0 + (b - 0.5) * 2.6;
      hard.push({ geo: BOX, m: mat(APRON_X + 0.55, 0.46, bz, 0, 0, 0, 0.52, 0.07, 2.3), color: [0.62, 0.45, 0.28] });
      hard.push({ geo: BOX, m: mat(APRON_X + 0.82, 0.76, bz, -0.18, 0, 0, 0.06, 0.44, 2.3), color: [0.62, 0.45, 0.28] });
      for (const sz of [-1, 1]) {
        hard.push({ ...strut([APRON_X + 0.4, 0, bz + sz * 1.0], [APRON_X + 0.4, 0.46, bz + sz * 1.0], 0.06, BOX), color: [0.35, 0.36, 0.38] });
        hard.push({ ...strut([APRON_X + 0.75, 0, bz + sz * 1.0], [APRON_X + 0.75, 0.46, bz + sz * 1.0], 0.06, BOX), color: [0.35, 0.36, 0.38] });
      }
    }

    // Trestle table with drinks + a stack of discs.
    hard.push({ geo: BOX, m: mat(APRON_X - 0.9, 0.74, z0 + 2.2, 0, 0, 0, 0.7, 0.05, 1.6), color: [0.85, 0.86, 0.88] });
    for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
      hard.push({ ...strut([APRON_X - 0.9 + sx * 0.28, 0, z0 + 2.2 + sz * 0.68], [APRON_X - 0.9 + sx * 0.28, 0.74, z0 + 2.2 + sz * 0.68], 0.04, BOX), color: [0.55, 0.56, 0.58] });
    }
    for (let d = 0; d < 6; d++) {
      plastic.push({ geo: CYL, m: mat(APRON_X - 0.95, 0.79 + d * 0.035, z0 + 1.75, 0, 0, 0, 0.27, 0.03, 0.27), color: d % 2 ? [0.92, 0.92, 0.94] : [0.95, 0.72, 0.16] });
    }

    // Coolers, jugs, kit bags, cone stack.
    for (let i = 0; i < 3; i++) {
      const z = z0 - 2.6 + i * 0.75;
      plastic.push({ geo: BOX, m: mat(APRON_X - 0.5, 0.28, z, 0, rnd.range(-0.3, 0.3), 0, 0.75, 0.55, 0.5), color: [0.88, 0.55, 0.14] });
      plastic.push({ geo: BOX, m: mat(APRON_X - 0.5, 0.57, z, 0, 0, 0, 0.78, 0.05, 0.53), color: [0.9, 0.9, 0.92] });
    }
    for (let i = 0; i < 4; i++) {
      plastic.push({ geo: CYL, m: mat(APRON_X - 1.5, 0.36, z0 - 3.6 + i * 0.55, 0, 0, 0, 0.44, 0.72, 0.44), color: [0.92, 0.55, 0.12] });
      plastic.push({ geo: CYL, m: mat(APRON_X - 1.5, 0.75, z0 - 3.6 + i * 0.55, 0, 0, 0, 0.36, 0.08, 0.36), color: [0.9, 0.92, 0.94] });
    }
    for (let i = 0; i < 5; i++) {
      soft.push({
        geo: BOX,
        m: mat(APRON_X + 1.2, 0.22, z0 + 3.4 + i * 0.42, 0, rnd.range(-0.4, 0.4), 0, 0.42, 0.42, 1.05),
        color: [0.12 + rnd.next() * 0.2, 0.14 + rnd.next() * 0.2, 0.18 + rnd.next() * 0.2],
      });
    }
    for (let i = 0; i < 9; i++) {
      plastic.push({ geo: CONE, m: mat(APRON_X - 2.2, 0.06 + i * 0.055, z0 - 4.8, 0, 0, 0, 0.5, 0.34, 0.5), color: [1.0, 0.42, 0.06] });
    }

    // Bench occupants + a coach standing.
    for (let i = 0; i < 6; i++) {
      const bz = z0 + (i < 3 ? -1.3 : 1.3) + ((i % 3) - 1) * 0.68;
      pushPerson(people, { BOX, CYL6, SPH }, APRON_X + 0.62, 0.46, bz, -Math.PI / 2, 'sit',
        col, [0.16, 0.17, 0.2], rnd);
    }
    pushPerson(people, { BOX, CYL6, SPH }, APRON_X - 1.9, 0, z0 + 0.6, -Math.PI / 2 + 0.3, 'stand',
      [0.10, 0.11, 0.13], [0.2, 0.21, 0.24], rnd);
  }

  /* ------------------------------------------------------- medical carts */
  for (const z of [-36, 36]) {
    cart(hard, plastic, people, { BOX, CYL, CYL6, SPH }, APRON_X, z, rnd);
  }

  /* ------------------------------------------------- broadcast positions */
  // Hung camera gantries under the roof on the −X side, flanking the main
  // game camera position rather than sitting on top of it.
  gantry(hard, people, { BOX, CYL6, SPH }, -1, 36, rnd);
  gantry(hard, people, { BOX, CYL6, SPH }, -1, -36, rnd);

  // Low hand-held camera positions along the −X touchline, clear of the
  // narrow sideline shot's frustum.
  for (const z of [-32, -12, 26, 40]) {
    const yaw = Math.PI / 2 + rnd.range(-0.2, 0.2);
    pushPerson(people, { BOX, CYL6, SPH }, CREW_X - 0.2, 0, z, yaw, 'stand',
      [0.09, 0.1, 0.12], [0.14, 0.15, 0.17], rnd);
    // shoulder camera + a stubby lens
    hard.push({ geo: BOX, m: mat(CREW_X + 0.42, 1.48, z, 0, yaw, 0, 0.42, 0.3, 0.28), color: [0.1, 0.1, 0.11] });
    hard.push({ geo: CYL, m: mat(CREW_X + 0.78, 1.48, z, 0, 0, Math.PI / 2, 0.22, 0.42, 0.22), color: [0.08, 0.08, 0.09] });
    // tripod
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      hard.push({ ...strut([CREW_X + 0.42, 1.3, z], [CREW_X + 0.42 + Math.cos(a) * 0.42, 0, z + Math.sin(a) * 0.42], 0.045, BOX), color: [0.28, 0.29, 0.31] });
    }
  }

  // Boom operator and a sideline reporter with a hand-held camera.
  {
    const z = -26;
    pushPerson(people, { BOX, CYL6, SPH }, CREW_X - 0.6, 0, z, Math.PI / 2, 'stand', [0.5, 0.52, 0.15], [0.16, 0.17, 0.2], rnd);
    hard.push({ ...strut([CREW_X - 0.4, 1.55, z], [CREW_X + 2.6, 3.1, z + 0.5], 0.05, BOX), color: [0.2, 0.21, 0.23] });
    soft.push({ geo: CYL, m: mat(CREW_X + 2.7, 3.15, z + 0.52, 0, 0, Math.PI / 2 - 0.45, 0.3, 0.85, 0.3), color: [0.3, 0.31, 0.33] });
  }
  {
    const z = 33;
    pushPerson(people, { BOX, CYL6, SPH }, CREW_X - 0.9, 0, z, Math.PI / 2 + 0.5, 'stand', [0.72, 0.14, 0.16], [0.14, 0.15, 0.18], rnd);
    hard.push({ geo: CYL, m: mat(CREW_X - 0.55, 1.5, z + 0.2, 0.6, 0, 0, 0.09, 0.28, 0.09), color: [0.1, 0.1, 0.11] });
  }

  /* -------------------------------------------- endline photographer pit */
  for (let i = 0; i < 7; i++) {
    const x = -9 + i * 3.0 + rnd.range(-0.5, 0.5);
    const z = -FIELD.halfL - 2.6 + rnd.range(-0.3, 0.3);
    const yaw = Math.atan2(-x, 4) + Math.PI;
    pushPerson(people, { BOX, CYL6, SPH }, x, 0, z, yaw, 'kneel',
      [0.1 + rnd.next() * 0.15, 0.11 + rnd.next() * 0.12, 0.13 + rnd.next() * 0.15], [0.13, 0.14, 0.16], rnd);
    hard.push({ geo: CYL, m: mat(x + Math.sin(yaw) * 0.55, 1.06, z + Math.cos(yaw) * 0.55, Math.PI / 2 + 0.1, yaw, 0, 0.24, 0.8, 0.24), color: [0.07, 0.07, 0.08] });
    hard.push({ geo: CYL, m: mat(x + Math.sin(yaw) * 0.95, 1.06, z + Math.cos(yaw) * 0.95, Math.PI / 2 + 0.1, yaw, 0, 0.3, 0.16, 0.3), color: [0.16, 0.16, 0.18] });
  }

  /* ------------------------------------------------- substitution boxes */
  const decal = new THREE.Mesh(
    new THREE.PlaneGeometry(4.4, 26),
    subBoxMaterial(),
  );
  decal.rotation.x = -Math.PI / 2;
  decal.position.set(FIELD.halfW + 2.2, 0.014, 0);
  decal.renderOrder = 1;
  g.add(decal);

  /* ------------------------------------------------------------- assemble */
  const hardMesh = new THREE.Mesh(parts(hard, 'sideline-hard'), M.paint);
  hardMesh.castShadow = true; hardMesh.receiveShadow = true;
  const plasticMesh = new THREE.Mesh(parts(plastic, 'sideline-plastic'), M.plastic);
  plasticMesh.castShadow = true; plasticMesh.receiveShadow = true;
  const softMesh = new THREE.Mesh(parts(soft, 'sideline-soft'), M.fabric);
  softMesh.castShadow = true; softMesh.receiveShadow = true;
  const peopleMesh = new THREE.Mesh(parts(people, 'sideline-people'), M.fabric);
  peopleMesh.castShadow = true; peopleMesh.receiveShadow = true;
  g.add(hardMesh, plasticMesh, softMesh, peopleMesh);

  CYL.dispose(); CYL6.dispose(); SPH.dispose(); CONE.dispose();
  return { group: g };
}

/* ------------------------------------------------------------------ props */

function pyramidSide(
  cx: number, y: number, cz: number, dx: number, dz: number, drop: number, sx: number, _sz: number,
): Part {
  // A slim wedge under the canopy edge so the roof does not read as a slab.
  return {
    geo: UNIT_BOX,
    m: mat(cx + sx * dx * 0.36, y + drop * 0.9, cz, 0, 0, sx * 0.28, dx * 0.4, 0.06, dz),
  };
}

function cart(
  hard: Part[], plastic: Part[], people: Part[],
  P: { BOX: THREE.BufferGeometry; CYL: THREE.BufferGeometry; CYL6: THREE.BufferGeometry; SPH: THREE.BufferGeometry },
  x: number, z: number, rnd: { next(): number; range(a: number, b: number): number },
): void {
  const yaw = -Math.PI / 2;
  hard.push({ geo: P.BOX, m: mat(x, 0.55, z, 0, yaw, 0, 1.35, 0.16, 2.9), color: [0.72, 0.74, 0.77] });
  hard.push({ geo: P.BOX, m: mat(x - 0.1, 0.95, z - 0.9, 0, yaw, 0, 1.2, 0.7, 0.1), color: [0.3, 0.31, 0.33] });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    hard.push({ geo: P.CYL, m: mat(x + sx * 0.6, 0.28, z + sz * 1.1, 0, 0, Math.PI / 2, 0.56, 0.24, 0.56), color: [0.09, 0.09, 0.1] });
  }
  hard.push({ geo: P.BOX, m: mat(x, 1.45, z, 0, yaw, 0, 1.3, 0.06, 2.6), color: [0.85, 0.87, 0.9] });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    hard.push({ ...strut([x + sx * 0.55, 0.62, z + sz * 1.1], [x + sx * 0.55, 1.45, z + sz * 1.1], 0.05, P.BOX), color: [0.8, 0.82, 0.85] });
  }
  plastic.push({ geo: P.BOX, m: mat(x + 0.1, 0.85, z + 1.0, 0, 0, 0, 0.7, 0.45, 0.55), color: [0.85, 0.12, 0.12] });
  plastic.push({ geo: P.BOX, m: mat(x + 0.1, 1.09, z + 1.0, 0, 0, 0, 0.72, 0.05, 0.57), color: [0.95, 0.95, 0.96] });
  pushPerson(people, P, x - 1.3, 0, z + 0.4, yaw + 0.4, 'stand', [0.85, 0.86, 0.88], [0.16, 0.17, 0.2], rnd);
}

/** A camera pod hung off the roof trusses. */
function gantry(
  hard: Part[], people: Part[],
  P: { BOX: THREE.BufferGeometry; CYL6: THREE.BufferGeometry; SPH: THREE.BufferGeometry },
  side: number, z: number,
  rnd: { next(): number; range(a: number, b: number): number },
): void {
  // Hung off the canopy just behind its leading edge, so the pod is always
  // under the roof and always the same height above the seats.
  const off = ROOF.frontOff + 2.4;
  const roofY = roofYAt(off);
  const x = side * (BOWL.hx + off);
  const deckY = roofY - 3.6;
  const w = 8.0, d = 4.4;
  hard.push({ geo: P.BOX, m: mat(x, deckY, z, 0, 0, 0, d, 0.16, w), color: [0.42, 0.44, 0.47] });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = x + sx * d / 2, pz = z + sz * w / 2;
    hard.push({ ...strut([px, deckY, pz], [px, roofY - 0.3, pz], 0.09, P.BOX), color: [0.6, 0.62, 0.65] });
    hard.push({ ...strut([px, deckY + 1.05, pz], [px, deckY, pz], 0.05, P.BOX), color: [0.72, 0.74, 0.77] });
  }
  for (const sz of [-1, 1]) {
    hard.push({ ...strut([x - d / 2, deckY + 1.05, z + sz * w / 2], [x + d / 2, deckY + 1.05, z + sz * w / 2], 0.05, P.BOX), color: [0.72, 0.74, 0.77] });
  }
  hard.push({ ...strut([x + side * d / 2, deckY + 1.05, z - w / 2], [x + side * d / 2, deckY + 1.05, z + w / 2], 0.05, P.BOX), color: [0.72, 0.74, 0.77] });
  // Two operators behind big lensed cameras on pedestals.
  for (const sz of [-2.7, 2.7]) {
    const cx = x - side * 1.3, cz = z + sz;
    hard.push({ geo: P.BOX, m: mat(cx, deckY + 1.35, cz, 0, 0, 0, 0.55, 0.36, 0.42), color: [0.1, 0.1, 0.11] });
    hard.push({ geo: P.BOX, m: mat(cx + side * 0.62, deckY + 1.35, cz, 0, 0, 0, 0.7, 0.26, 0.26), color: [0.08, 0.08, 0.09] });
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      hard.push({ ...strut([cx, deckY + 1.17, cz], [cx + Math.cos(a) * 0.4, deckY + 0.16, cz + Math.sin(a) * 0.4], 0.05, P.BOX), color: [0.3, 0.31, 0.33] });
    }
    pushPerson(people, P, cx - side * 0.75, deckY + 0.1, cz, side > 0 ? Math.PI / 2 : -Math.PI / 2, 'stand',
      [0.1, 0.11, 0.13], [0.15, 0.16, 0.18], rnd);
  }
}

/* ----------------------------------------------------------------- people */

type Pose = 'stand' | 'sit' | 'kneel';

/**
 * Crew figures. Deliberately simple — they live 20–60 m from every camera —
 * but they get real proportions, a slight stance offset and varied kit colours
 * so a line of them never looks like a row of clones.
 */
function pushPerson(
  out: Part[],
  P: { BOX: THREE.BufferGeometry; CYL6: THREE.BufferGeometry; SPH: THREE.BufferGeometry },
  x: number, y: number, z: number, yaw: number, pose: Pose,
  shirt: RGB, trouser: RGB,
  rnd: { next(): number; range(a: number, b: number): number },
): void {
  const s = 0.94 + rnd.next() * 0.13;
  const skinTone = 0.42 + rnd.next() * 0.42;
  const skin: RGB = [skinTone * 1.0, skinTone * 0.74, skinTone * 0.60];
  const lean = rnd.range(-0.12, 0.12);
  const put = (geo: THREE.BufferGeometry, lx: number, ly: number, lz: number,
    sx: number, sy: number, sz: number, color: RGB, rx = 0) => {
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    out.push({
      geo,
      m: mat(x + lx * c + lz * sn, y + ly * s, z - lx * sn + lz * c, rx, yaw, 0, sx, sy * s, sz),
      color,
    });
  };

  if (pose === 'stand') {
    put(P.CYL6, 0, 1.10, 0, 0.46, 0.66, 0.30, shirt);
    put(P.SPH, 0, 1.53, 0, 0.24, 0.30, 0.24, skin);
    put(P.CYL6, 0, 1.42, 0, 0.19, 0.14, 0.19, skin);
    put(P.BOX, -0.15, 0.42, 0, 0.16, 0.85, 0.19, trouser);
    put(P.BOX, 0.15, 0.42, 0, 0.16, 0.85, 0.19, trouser);
    put(P.BOX, -0.28, 1.08, 0.02, 0.13, 0.62, 0.15, shirt, lean);
    put(P.BOX, 0.28, 1.08, 0.02, 0.13, 0.62, 0.15, shirt, -lean);
    put(P.BOX, -0.15, 0.03, 0.05, 0.17, 0.09, 0.28, [0.08, 0.08, 0.09]);
    put(P.BOX, 0.15, 0.03, 0.05, 0.17, 0.09, 0.28, [0.08, 0.08, 0.09]);
  } else if (pose === 'sit') {
    put(P.CYL6, 0, 0.76, -0.02, 0.44, 0.60, 0.30, shirt);
    put(P.SPH, 0, 1.12, -0.02, 0.23, 0.29, 0.23, skin);
    put(P.CYL6, 0, 1.02, -0.02, 0.18, 0.13, 0.18, skin);
    put(P.BOX, -0.14, 0.44, 0.22, 0.16, 0.16, 0.52, trouser);
    put(P.BOX, 0.14, 0.44, 0.22, 0.16, 0.16, 0.52, trouser);
    put(P.BOX, -0.14, 0.2, 0.46, 0.15, 0.42, 0.16, trouser);
    put(P.BOX, 0.14, 0.2, 0.46, 0.15, 0.42, 0.16, trouser);
    put(P.BOX, -0.26, 0.74, 0.12, 0.12, 0.5, 0.14, shirt, 0.5);
    put(P.BOX, 0.26, 0.74, 0.12, 0.12, 0.5, 0.14, shirt, 0.5);
  } else {
    put(P.CYL6, 0, 0.82, 0, 0.44, 0.56, 0.30, shirt);
    put(P.SPH, 0, 1.18, 0.04, 0.23, 0.29, 0.23, skin);
    put(P.BOX, -0.16, 0.26, 0.1, 0.17, 0.5, 0.2, trouser);
    put(P.BOX, 0.16, 0.42, 0.24, 0.17, 0.2, 0.5, trouser);
    put(P.BOX, 0.16, 0.2, 0.46, 0.16, 0.4, 0.17, trouser);
    put(P.BOX, -0.26, 0.86, 0.24, 0.12, 0.44, 0.14, shirt, 1.0);
    put(P.BOX, 0.26, 0.86, 0.24, 0.12, 0.44, 0.14, shirt, 1.0);
  }
}

/* -------------------------------------------------------------- sub boxes */

function subBoxMaterial(): THREE.MeshStandardMaterial {
  const tex = canvasTexture(256, 1024, (c, W, H) => {
    c.clearRect(0, 0, W, H);
    c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.lineWidth = 9;
    c.strokeRect(18, 60, W - 36, H - 120);
    c.setLineDash([26, 22]);
    c.beginPath(); c.moveTo(18, H / 2); c.lineTo(W - 18, H / 2); c.stroke();
    c.setLineDash([]);
    c.save();
    c.translate(W / 2, H * 0.26);
    c.rotate(-Math.PI / 2);
    c.fillStyle = 'rgba(255,255,255,0.8)';
    c.font = '700 46px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.textAlign = 'center';
    c.fillText('SUBSTITUTION', 0, 16);
    c.restore();
    c.save();
    c.translate(W / 2, H * 0.76);
    c.rotate(-Math.PI / 2);
    c.fillStyle = 'rgba(255,255,255,0.8)';
    c.font = '700 46px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.textAlign = 'center';
    c.fillText('SUBSTITUTION', 0, 16);
    c.restore();
  }, { name: 'sub-box' });
  return new THREE.MeshStandardMaterial({
    map: tex, transparent: true, opacity: 0.85, roughness: 1, metalness: 0,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    name: 'sub-box',
  });
}
