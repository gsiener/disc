import * as THREE from 'three';
import type { Ctx } from '../../core/Ctx';
import { parts, strut, mat, UNIT_BOX, type Part, type RGB } from './Geo';
import type { StadiumMaterials } from './Materials';
import { FIELD, BOWL, ROOF, roofYAt } from './Layout';

/**
 * Sideline dressing. An empty touchline is the single fastest way to make a
 * stadium read as unfinished, so the run-off carries the whole match-day kit:
 * team tents, the roster standing the line, folding chairs, coolers and water
 * jugs, kit bags, cone stacks, an observers' table on halfway, medical carts,
 * a hung camera gantry with operators, hand-held camera crews, a boom op, a
 * sideline reporter and a row of endline photographers.
 *
 * ## Two rules this file exists to keep
 *
 * 1. **Ultimate markings only.** A regulation pitch carries two sidelines, two
 *    end lines, two goal lines, two brick marks and eight corner cones — and
 *    nothing else. This module used to paint a "SUBSTITUTION" box on the
 *    run-off, which is association-football furniture: Ultimate has no
 *    substitution zone, no technical area and no such marking. It has been cut
 *    rather than restyled, and nothing here may paint on the ground again.
 *    (The regulation set itself is drawn analytically by `field/TurfMaterial`.)
 *
 * 2. **Nothing stands on a bare plane.** Props read as decals unless something
 *    grounds them, so every cluster sits on trodden matting, every canopy leg
 *    carries a ballast bag, and cable runs tie the camera positions back to the
 *    wall. That is what turns a row of boxes into a touchline.
 *
 * Everything lands in five buffers — hard props (steel/timber), plastic, soft
 * goods (fabric), ground rubber and people — each one draw call.
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
  const ground: Part[] = [];

  const BOX = UNIT_BOX;
  const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
  const CYL6 = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
  const SPH = new THREE.SphereGeometry(0.5, 10, 7);
  const CONE = new THREE.ConeGeometry(0.5, 1, 8);

  /**
   * Trodden matting under a prop cluster — the cheapest possible grounding.
   *
   * Two numbers here are not free. The *height*: the run-off at x ≈ 21 is the
   * mown turf's shoulder, which sits about 3 cm under datum, so a mat centred
   * on y = 0 stands five centimetres off the ground and reads as a floating
   * slab. It is sunk to meet the surface and left 2.5 cm proud. And the
   * *value*: `M.rubber` is already a 0.010-linear base, so a vertex tint under
   * 1 multiplies it into a hole in the pitch — the first pass of this put a
   * 26 m black rectangle along the end line. Tints here are >1 on purpose and
   * land the mats around 0.035 linear, i.e. dark grey rubber, not a void.
   */
  const matting = (x: number, z: number, sx: number, sz: number, v: number) => {
    ground.push({
      geo: BOX,
      m: mat(x, -0.016, z, 0, 0, 0, sx, 0.030, sz),
      color: [v, v * 0.99, v * 0.93],
      uvScale: 5,
    });
  };
  /** A flat cable run on the deck. Ties equipment back to the wall. */
  const cable = (x0: number, z0: number, x1: number, z1: number, w: number, v: number) => {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz) || 1e-3;
    ground.push({
      geo: BOX,
      m: mat((x0 + x1) / 2, -0.006, (z0 + z1) / 2, 0, Math.atan2(dx, dz), 0, w, 0.05, len),
      color: [v, v, v * 1.06],
      uvScale: 3,
    });
  };

  /* ------------------------------------------------------------ team tents */
  // Ultimate is a squad sport played off a *line*, not off a bench: the whole
  // roster stands the touchline and the seven on come out of it. So each team
  // gets a tent and a bench, and then twelve more bodies strung along the line
  // in kit — which is what actually reads as "a match is on" at broadcast range.
  const benchZ = [-19, 19];
  // Tent fabric. Team-flavoured but deliberately muted: the palette budget
  // spends its saturation on the two kits and the disc, and a 5 m canopy is
  // far too much area to spend it on.
  const teamCol: RGB[] = [[0.055, 0.130, 0.245], [0.250, 0.085, 0.062]];
  // Linear-space kit colours, matching the two on-pitch kits (home navy,
  // away white with red trim). These are the only saturated things allowed on
  // the touchline; everything else stays under half saturation.
  const kitShirt: RGB[] = [[0.036, 0.101, 0.320], [0.780, 0.780, 0.755]];
  const kitShort: RGB[] = [[0.020, 0.055, 0.170], [0.310, 0.032, 0.026]];
  for (let t = 0; t < 2; t++) {
    const z0 = benchZ[t];
    const col = teamCol[t];
    const side = z0 < 0 ? -1 : 1;

    matting(APRON_X + 0.1, z0, 4.6, 7.4, 3.6);

    // Canopy: four legs, a frame, a fabric roof with a valance. Each leg gets a
    // ballast bag and a guy line to the deck — a pop-up that is *not* weighted
    // is the single loudest "this prop was dropped on a plane" tell there is.
    const cw = 5.4, cd = 3.4, ch = 2.55;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const lx = APRON_X + sx * cd / 2, lz = z0 + sz * cw / 2;
      hard.push({ ...strut([lx, 0, lz], [lx, ch, lz], 0.075, BOX), color: [0.8, 0.82, 0.85] });
      soft.push({ geo: BOX, m: mat(lx, 0.09, lz, 0, rnd.range(-0.4, 0.4), 0, 0.42, 0.18, 0.30), color: [0.19, 0.18, 0.16] });
      hard.push({
        ...strut([lx, ch - 0.15, lz], [lx + sx * 0.85, 0.02, lz + sz * 0.85], 0.018, BOX),
        color: [0.30, 0.31, 0.30],
      });
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
        kitShirt[t], kitShort[t], rnd);
    }
    pushPerson(people, { BOX, CYL6, SPH }, APRON_X - 1.9, 0, z0 + 0.6, -Math.PI / 2 + 0.3, 'stand',
      [0.10, 0.11, 0.13], [0.2, 0.21, 0.24], rnd);

    /* -- folding chairs, strung out along the line in front of the tent -- */
    for (let i = 0; i < 5; i++) {
      const cz = z0 - 3.2 + i * 1.6 + rnd.range(-0.18, 0.18);
      const cx = APRON_X - 1.05 + rnd.range(-0.12, 0.12);
      const yaw = -Math.PI / 2 + rnd.range(-0.25, 0.25);
      foldChair(hard, soft, BOX, cx, cz, yaw, i % 2 ? col : [col[0] * 0.7, col[1] * 0.7, col[2] * 0.7]);
    }

    /* -- the roster, standing the line ----------------------------------
       Strung between the tent and the touchline in two loose knots with a gap
       where the coach is: an evenly spaced row of bodies reads as a fence. */
    const lineX = FIELD.halfW + 1.15;
    for (let i = 0; i < 11; i++) {
      const knot = i < 6 ? -1 : 1;
      const pz = z0 + knot * (3.0 + (i % 6) * 1.15) + rnd.range(-0.55, 0.55);
      // Depth scatter matters more than lateral: a roster at one x is a picket
      // fence from the broadcast position however well spaced along the line.
      const px = lineX + rnd.range(-0.4, 1.5);
      // Facing the pitch, i.e. -X, with a little scatter of attention.
      const yaw = -Math.PI / 2 + rnd.range(-0.45, 0.45);
      const shirt = kitShirt[t];
      const pose: Pose = i % 5 === 3 ? 'kneel' : 'stand';
      pushPerson(people, { BOX, CYL6, SPH }, px, 0, pz, yaw, pose, shirt, kitShort[t], rnd);
      if (i % 4 === 1) {
        // a spare disc held low, and a bag at the feet
        plastic.push({ geo: CYL, m: mat(px - 0.34, 0.95, pz, 0.9, yaw, 0, 0.27, 0.03, 0.27), color: [0.90, 0.90, 0.88] });
      }
      if (i % 3 === 0) {
        soft.push({
          geo: BOX,
          m: mat(px + 0.75, 0.16, pz + 0.25, 0, rnd.range(-0.5, 0.5), 0, 0.34, 0.30, 0.74),
          color: [0.10 + rnd.next() * 0.14, 0.11 + rnd.next() * 0.13, 0.13 + rnd.next() * 0.14],
        });
      }
    }
    // Water jugs and a bin at the head of the line, on their own scuff mat.
    matting(lineX + 0.6, z0 + side * 8.6, 2.0, 2.0, 4.2);
    for (let i = 0; i < 3; i++) {
      plastic.push({ geo: CYL, m: mat(lineX + 0.3 + (i % 2) * 0.5, 0.30, z0 + side * 8.6 + (i - 1) * 0.5, 0, 0, 0, 0.40, 0.60, 0.40), color: [0.72, 0.74, 0.76] });
    }
    plastic.push({ geo: CYL, m: mat(lineX + 1.2, 0.42, z0 + side * 9.4, 0, 0, 0, 0.62, 0.84, 0.62), color: [0.14, 0.20, 0.15] });
  }

  /* ------------------------------------------------------- medical carts */
  for (const z of [-36, 36]) {
    matting(APRON_X, z, 3.2, 4.4, 3.4);
    cart(hard, plastic, people, { BOX, CYL, CYL6, SPH }, APRON_X, z, rnd);
  }

  /* --------------------------------------------------- observers on halfway */
  // Ultimate is self-officiated; at this level a pair of observers work the
  // halfway mark off a trestle with the game clock and the spirit sheets, under
  // a small shade umbrella. It is the one piece of officiating furniture the
  // sport actually has, and it sits where a football technical area would not.
  {
    const ox = APRON_X - 0.4;
    matting(ox, 0, 3.4, 4.0, 3.9);
    hard.push({ geo: BOX, m: mat(ox, 0.75, 0, 0, 0, 0, 0.8, 0.05, 2.4), color: [0.80, 0.80, 0.80] });
    soft.push({ geo: BOX, m: mat(ox - 0.02, 0.71, 0, 0, 0, 0, 0.94, 0.06, 2.6), color: [0.20, 0.22, 0.26] });
    for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
      hard.push({ ...strut([ox + sx * 0.32, 0, sz * 1.05], [ox + sx * 0.32, 0.75, sz * 1.05], 0.045, BOX), color: [0.52, 0.53, 0.55] });
    }
    // clipboard, a laptop lid and a stack of spirit sheets
    hard.push({ geo: BOX, m: mat(ox - 0.1, 0.80, -0.5, 0, 0.3, 0, 0.34, 0.02, 0.46), color: [0.86, 0.85, 0.80] });
    hard.push({ geo: BOX, m: mat(ox + 0.05, 0.90, 0.4, -0.5, 0, 0, 0.42, 0.28, 0.03), color: [0.24, 0.25, 0.27] });
    // shade umbrella
    hard.push({ ...strut([ox + 0.3, 0, 1.5], [ox + 0.3, 2.25, 1.5], 0.05, BOX), color: [0.62, 0.63, 0.65] });
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      soft.push({
        ...strut([ox + 0.3, 2.25, 1.5], [ox + 0.3 + Math.cos(a) * 1.25, 1.92, 1.5 + Math.sin(a) * 1.25], 0.5, BOX),
        color: [0.30, 0.31, 0.29],
      });
    }
    for (const sz of [-0.85, 0.85]) {
      foldChair(hard, soft, BOX, ox - 0.95, sz, -Math.PI / 2, [0.22, 0.23, 0.25]);
      pushPerson(people, { BOX, CYL6, SPH }, ox - 0.95, 0.44, sz, -Math.PI / 2, 'sit',
        [0.46, 0.47, 0.16], [0.13, 0.14, 0.16], rnd);
    }
    cable(ox + 1.2, 1.6, BOWL.hx - 0.35, 6.0, 0.09, 2.4);
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
    matting(CREW_X + 0.2, z, 2.4, 2.4, 3.2);
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
    // Flight cases, a cable drum and the run back to the wall. This is the
    // difference between "a camera prop" and "a camera position".
    for (let k = 0; k < 2; k++) {
      hard.push({ geo: BOX, m: mat(CREW_X - 1.15, 0.21 + k * 0.44, z + 1.25, 0, rnd.range(-0.2, 0.2), 0, 0.86, 0.42, 0.62), color: [0.13, 0.14, 0.16] });
      hard.push({ geo: BOX, m: mat(CREW_X - 1.15, 0.42 + k * 0.44, z + 1.25, 0, 0, 0, 0.90, 0.03, 0.66), color: [0.42, 0.43, 0.45] });
    }
    hard.push({ geo: CYL, m: mat(CREW_X - 1.5, 0.36, z - 1.4, 0, 0, Math.PI / 2, 0.72, 0.30, 0.72), color: [0.24, 0.26, 0.24] });
    cable(CREW_X + 0.4, z, -BOWL.hx + 0.4, z - 1.4, 0.10, 2.4);
    cable(CREW_X - 1.5, z - 1.4, CREW_X - 1.5, z + 6.0, 0.07, 2.1);
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
    hard.push({ geo: BOX, m: mat(x - 0.8, 0.16, z - 0.7, 0, rnd.range(-0.5, 0.5), 0, 0.62, 0.32, 0.44), color: [0.11, 0.12, 0.13] });
  }

  // NOTE: no ground decals are drawn from this module, by design. See the file
  // header — an Ultimate pitch carries only the regulation eight features and
  // `field/TurfMaterial` owns every one of them.

  /* ------------------------------------------------------------- assemble */
  const hardMesh = new THREE.Mesh(parts(hard, 'sideline-hard'), M.paint);
  hardMesh.castShadow = true; hardMesh.receiveShadow = true;
  const plasticMesh = new THREE.Mesh(parts(plastic, 'sideline-plastic'), M.plastic);
  plasticMesh.castShadow = true; plasticMesh.receiveShadow = true;
  const softMesh = new THREE.Mesh(parts(soft, 'sideline-soft'), M.fabric);
  softMesh.castShadow = true; softMesh.receiveShadow = true;
  const peopleMesh = new THREE.Mesh(parts(people, 'sideline-people'), M.fabric);
  peopleMesh.castShadow = true; peopleMesh.receiveShadow = true;
  // Matting and cable runs are ground-hugging, so they only ever receive.
  const groundMesh = new THREE.Mesh(parts(ground, 'sideline-ground'), M.rubber);
  groundMesh.castShadow = false; groundMesh.receiveShadow = true;
  g.add(hardMesh, plasticMesh, softMesh, peopleMesh, groundMesh);

  CYL.dispose(); CYL6.dispose(); SPH.dispose(); CONE.dispose();
  return { group: g };
}

/** A folding chair: seat, back and a splayed tube frame. */
function foldChair(
  hard: Part[], soft: Part[], BOX: THREE.BufferGeometry,
  x: number, z: number, yaw: number, col: RGB,
): void {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const at = (lx: number, ly: number, lz: number): [number, number, number] =>
    [x + lx * c + lz * s, ly, z - lx * s + lz * c];
  soft.push({ geo: BOX, m: mat(...at(0, 0.44, 0), 0, yaw, 0, 0.46, 0.05, 0.44), color: col });
  soft.push({ geo: BOX, m: mat(...at(0, 0.70, -0.20), -0.14, yaw, 0, 0.46, 0.42, 0.05), color: col });
  for (const sx of [-0.21, 0.21]) {
    hard.push({ ...strut(at(sx, 0.44, 0.20), at(sx, 0, -0.16), 0.035, BOX), color: [0.42, 0.43, 0.45] });
    hard.push({ ...strut(at(sx, 0.44, -0.20), at(sx, 0, 0.16), 0.035, BOX), color: [0.42, 0.43, 0.45] });
    hard.push({ ...strut(at(sx, 0.44, -0.20), at(sx, 0.90, -0.24), 0.032, BOX), color: [0.42, 0.43, 0.45] });
  }
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

