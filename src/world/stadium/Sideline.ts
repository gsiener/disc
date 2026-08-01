import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Ctx } from '../../core/Ctx';
import { parts, strut, mat, UNIT_BOX, type Part, type RGB, type V3 } from './Geo';
import type { StadiumMaterials } from './Materials';
import { FIELD, BOWL, ROOF, roofYAt } from './Layout';
import { measureBody, buildSkeleton } from '../../entities/rig/Skeleton';
import { RigMesh, frameQuat } from '../../entities/rig/Build';
import {
  detailFor, buildTorso, buildNeck, buildArms, buildLegs, buildAnkles,
} from '../../entities/rig/Body';
import { buildHead } from '../../entities/rig/Head';
import { buildHands } from '../../entities/rig/Hands';
import { buildJersey, buildShorts, buildSocks, buildShoes } from '../../entities/rig/Cloth';
import { randomBodyParams } from '../../entities/rig/Params';
import { GROUP } from '../../entities/rig/Types';
import type { BodyParams, BoneName, Measure, NamedBones } from '../../entities/rig/Types';

/**
 * Sideline dressing. An empty touchline is the single fastest way to make a
 * stadium read as unfinished, so the run-off carries the whole match-day kit:
 * team tents, the roster standing the line, folding chairs, coolers and water
 * jugs, kit bags, cone stacks, an observers' table on halfway, medical carts,
 * a hung camera gantry with operators, hand-held camera crews, a boom op, a
 * sideline reporter and a row of endline photographers.
 *
 * ## Three rules this file exists to keep
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
 * 3. **No box people.** Every human on the touchline is the real athlete rig
 *    at its far LOD tier, baked to static geometry. See "THE TOUCHLINE CROWD"
 *    below — this is the rule the first two versions of this file broke, and it
 *    is the one the broadcast framing actually judges.
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
  /** How many rig-baked bodies stand on the touchline. */
  people: number;
  /** Their total triangle count — the number to weigh a change against. */
  peopleTriangles: number;
  /** Wall time spent building the body pool and baking it, milliseconds. */
  peopleMs: number;
}

export function buildSideline(ctx: Ctx, M: StadiumMaterials): SidelineBuild {
  const g = new THREE.Group();
  g.name = 'sideline';
  const rnd = ctx.rand.fork(0xb0a7);

  const hard: Part[] = [];
  const soft: Part[] = [];
  const plastic: Part[] = [];
  const ground: Part[] = [];

  const BOX = UNIT_BOX;
  const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
  const CONE = new THREE.ConeGeometry(0.5, 1, 8);
  // Prop shapes that are not boxes. A cooler is a tapered tub with a lid lip and
  // two moulded handles; a kit bag is a barrel with rounded ends; a water jug is
  // a truncated cone with a bail. At 55 m these are ten pixels each — but ten
  // pixels of *round* against a run of ten-pixel squares is what stops the
  // cluster reading as packing crates.
  const JUG = new THREE.CylinderGeometry(0.40, 0.50, 1, 12, 1);
  const TUB = new THREE.CylinderGeometry(0.5, 0.44, 1, 4, 1);
  const DUFFEL = new THREE.CapsuleGeometry(0.5, 0.9, 3, 10);
  const BAIL = new THREE.TorusGeometry(0.5, 0.075, 4, 10, Math.PI);
  // Every one-off geometry made below joins this list; `parts()` clones its
  // inputs, so the originals are ours to free.
  const scratch: THREE.BufferGeometry[] = [CYL, CONE, JUG, TUB, DUFFEL, BAIL];

  const crowd = new Crowd(ctx, rnd.fork(0x9c17));

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
  /** A sagging fabric patch. Registered for disposal. */
  const cloth = (
    a: V3, b: V3, c: V3, d: V3, nu: number, nv: number,
    f: ((u: number, v: number) => number) | undefined, color: RGB,
  ) => {
    const geo = sheet(a, b, c, d, nu, nv, f);
    scratch.push(geo);
    soft.push({ geo, color });
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
  const kits: Kit[] = [
    { jersey: [0.036, 0.101, 0.320], shorts: [0.020, 0.055, 0.170], socks: [0.055, 0.075, 0.13], shoes: [0.020, 0.021, 0.024] },
    { jersey: [0.780, 0.780, 0.755], shorts: [0.310, 0.032, 0.026], socks: [0.62, 0.62, 0.60], shoes: [0.028, 0.026, 0.024] },
  ];
  const coachKit: Kit = { jersey: [0.030, 0.034, 0.042], shorts: [0.055, 0.058, 0.068], socks: [0.10, 0.10, 0.11], shoes: [0.018, 0.018, 0.020] };
  const crewKit: Kit = { jersey: [0.022, 0.025, 0.030], shorts: [0.032, 0.034, 0.040], socks: [0.05, 0.05, 0.055], shoes: [0.015, 0.015, 0.017] };
  const hivizKit: Kit = { jersey: [0.52, 0.56, 0.10], shorts: [0.030, 0.032, 0.038], socks: [0.10, 0.10, 0.10], shoes: [0.018, 0.018, 0.020] };

  for (let t = 0; t < 2; t++) {
    const z0 = benchZ[t];
    const col = teamCol[t];
    const side = z0 < 0 ? -1 : 1;
    const kit = kits[t];

    matting(APRON_X + 0.1, z0, 4.6, 7.4, 3.6);

    // Canopy: four legs, a frame, a peaked fabric roof with a scalloped
    // valance. Each leg gets a ballast bag and a guy line to the deck — a
    // pop-up that is *not* weighted is the single loudest "this prop was
    // dropped on a plane" tell there is.
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
    canopy(cloth, APRON_X, ch, z0, cd + 0.5, cw + 0.5, col);

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

    // Trestle table with drinks + a stack of discs, under a draped cloth.
    hard.push({ geo: BOX, m: mat(APRON_X - 0.9, 0.74, z0 + 2.2, 0, 0, 0, 0.7, 0.05, 1.6), color: [0.85, 0.86, 0.88] });
    for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
      hard.push({ ...strut([APRON_X - 0.9 + sx * 0.28, 0, z0 + 2.2 + sz * 0.68], [APRON_X - 0.9 + sx * 0.28, 0.74, z0 + 2.2 + sz * 0.68], 0.04, BOX), color: [0.55, 0.56, 0.58] });
    }
    cloth(
      [APRON_X - 1.28, 0.72, z0 + 1.36], [APRON_X - 0.52, 0.72, z0 + 1.36],
      [APRON_X - 0.52, 0.30, z0 + 1.32], [APRON_X - 1.28, 0.30, z0 + 1.32],
      5, 2, (u, v) => -0.02 * v * (1 - Math.cos(u * Math.PI * 4)), col,
    );
    for (let d = 0; d < 6; d++) {
      plastic.push({ geo: CYL, m: mat(APRON_X - 0.95, 0.79 + d * 0.035, z0 + 1.75, 0, 0, 0, 0.27, 0.03, 0.27), color: d % 2 ? [0.92, 0.92, 0.94] : [0.95, 0.72, 0.16] });
    }

    // Coolers, jugs, kit bags, cone stack.
    for (let i = 0; i < 3; i++) {
      const z = z0 - 2.6 + i * 0.75;
      cooler(hard, plastic, { TUB, CYL }, APRON_X - 0.5, z, rnd.range(-0.3, 0.3), [0.88, 0.55, 0.14]);
    }
    for (let i = 0; i < 4; i++) {
      waterJug(plastic, hard, { JUG, CYL, BAIL },
        APRON_X - 1.5 + rnd.range(-0.16, 0.16), z0 - 3.6 + i * 0.58, rnd.range(-0.9, 0.9), i + t);
    }
    for (let i = 0; i < 5; i++) {
      // Spaced past their own diameter and jittered off the line: five bags at
      // 0.42 m centres weld into one sausage from any distance.
      kitBag(soft, hard, { DUFFEL, BOX }, APRON_X + 1.2 + rnd.range(-0.32, 0.32), z0 + 3.3 + i * 0.66, rnd.range(-0.6, 0.6), 0.50,
        [0.10 + rnd.next() * 0.16, 0.11 + rnd.next() * 0.15, 0.14 + rnd.next() * 0.18]);
    }
    for (let i = 0; i < 9; i++) {
      plastic.push({ geo: CONE, m: mat(APRON_X - 2.2, 0.06 + i * 0.055, z0 - 4.8, 0, 0, 0, 0.5, 0.34, 0.5), color: [1.0, 0.42, 0.06] });
    }

    // Bench occupants + a coach standing. Six people on one bench sit six
    // different ways: forward on the elbows, back with the arms spread, one
    // leg crossed, hunched over a bottle. A row of identical seated figures is
    // exactly as readable as a row of boxes.
    for (let i = 0; i < 6; i++) {
      const bz = z0 + (i < 3 ? -1.3 : 1.3) + ((i % 3) - 1) * 0.68;
      crowd.add(APRON_X + 0.62, 0, bz, -Math.PI / 2 + rnd.range(-0.22, 0.22), 'sit', kit, { seat: 0.46 });
    }
    crowd.add(APRON_X - 1.9, 0, z0 + 0.6, -Math.PI / 2 + 0.3, 'coach', coachKit);

    /* -- folding chairs, strung out along the line in front of the tent -- */
    for (let i = 0; i < 5; i++) {
      const cz = z0 - 3.2 + i * 1.6 + rnd.range(-0.18, 0.18);
      const cx = APRON_X - 1.05 + rnd.range(-0.12, 0.12);
      const yaw = -Math.PI / 2 + rnd.range(-0.25, 0.25);
      foldChair(hard, cloth, BOX, cx, cz, yaw, i % 2 ? col : [col[0] * 0.7, col[1] * 0.7, col[2] * 0.7]);
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
      const pose: PoseName = i % 5 === 3 ? 'crouch' : 'stand';
      crowd.add(px, 0, pz, yaw, pose, kit);
      if (i % 4 === 1) {
        // a spare disc held low, and a bag at the feet
        plastic.push({ geo: CYL, m: mat(px - 0.34, 0.95, pz, 0.9, yaw, 0, 0.27, 0.03, 0.27), color: [0.90, 0.90, 0.88] });
      }
      if (i % 3 === 0) {
        kitBag(soft, hard, { DUFFEL, BOX }, px + 0.75, pz + 0.25, rnd.range(-0.5, 0.5), 0.40,
          [0.10 + rnd.next() * 0.14, 0.11 + rnd.next() * 0.13, 0.13 + rnd.next() * 0.14]);
      }
    }
    // Water jugs and a bin at the head of the line, on their own scuff mat.
    matting(lineX + 0.6, z0 + side * 8.6, 2.0, 2.0, 4.2);
    for (let i = 0; i < 3; i++) {
      waterJug(plastic, hard, { JUG, CYL, BAIL },
        lineX + 0.3 + (i % 2) * 0.5, z0 + side * 8.6 + (i - 1) * 0.52, 0.4 * i, i + t + 1);
    }
    plastic.push({ geo: JUG, m: mat(lineX + 1.2, 0.42, z0 + side * 9.4, 0, 0, 0, 0.62, 0.84, 0.62), color: [0.14, 0.20, 0.15] });
  }

  /* ------------------------------------------------------- medical carts */
  for (const z of [-36, 36]) {
    matting(APRON_X, z, 3.2, 4.4, 3.4);
    cart(hard, plastic, crowd, { BOX, CYL, DUFFEL }, APRON_X, z, rnd);
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
    cloth(
      [ox - 0.47, 0.73, -1.3], [ox + 0.47, 0.73, -1.3],
      [ox + 0.47, 0.73, 1.3], [ox - 0.47, 0.73, 1.3],
      3, 5, () => 0, [0.20, 0.22, 0.26],
    );
    cloth(
      [ox - 0.47, 0.73, -1.3], [ox - 0.47, 0.73, 1.3],
      [ox - 0.47, 0.28, 1.3], [ox - 0.47, 0.28, -1.3],
      5, 2, (u, v) => -0.025 * v * (1 - Math.cos(u * Math.PI * 5)), [0.20, 0.22, 0.26],
    );
    for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
      hard.push({ ...strut([ox + sx * 0.32, 0, sz * 1.05], [ox + sx * 0.32, 0.75, sz * 1.05], 0.045, BOX), color: [0.52, 0.53, 0.55] });
    }
    // clipboard, a laptop lid and a stack of spirit sheets
    hard.push({ geo: BOX, m: mat(ox - 0.1, 0.80, -0.5, 0, 0.3, 0, 0.34, 0.02, 0.46), color: [0.86, 0.85, 0.80] });
    hard.push({ geo: BOX, m: mat(ox + 0.05, 0.90, 0.4, -0.5, 0, 0, 0.42, 0.28, 0.03), color: [0.24, 0.25, 0.27] });
    // shade umbrella — a stretched octagonal canopy, not a pinwheel of slabs
    hard.push({ ...strut([ox + 0.3, 0, 1.5], [ox + 0.3, 2.25, 1.5], 0.05, BOX), color: [0.62, 0.63, 0.65] });
    umbrella(cloth, hard, BOX, ox + 0.3, 2.25, 1.5, 1.28, [0.30, 0.31, 0.29]);
    for (const sz of [-0.85, 0.85]) {
      foldChair(hard, cloth, BOX, ox - 0.95, sz, -Math.PI / 2, [0.22, 0.23, 0.25]);
      crowd.add(ox - 0.95, 0, sz, -Math.PI / 2 + (sz > 0 ? -0.24 : 0.2), 'deskSit', hivizKit, { seat: 0.44 });
    }
    cable(ox + 1.2, 1.6, BOWL.hx - 0.35, 6.0, 0.09, 2.4);
  }

  /* ------------------------------------------------- broadcast positions */
  // Hung camera gantries under the roof on the −X side, flanking the main
  // game camera position rather than sitting on top of it.
  gantry(hard, crowd, BOX, -1, 36, crewKit);
  gantry(hard, crowd, BOX, -1, -36, crewKit);

  // Low hand-held camera positions along the −X touchline, clear of the
  // narrow sideline shot's frustum.
  for (const z of [-32, -12, 26, 40]) {
    const yaw = Math.PI / 2 + rnd.range(-0.2, 0.2);
    matting(CREW_X + 0.2, z, 2.4, 2.4, 3.2);
    crowd.add(CREW_X - 0.2, 0, z, yaw, 'shoulderCam', crewKit);
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
    crowd.add(CREW_X - 0.6, 0, z, Math.PI / 2, 'boom', hivizKit);
    hard.push({ ...strut([CREW_X - 0.4, 1.55, z], [CREW_X + 2.6, 3.1, z + 0.5], 0.05, BOX), color: [0.2, 0.21, 0.23] });
    soft.push({ geo: CYL, m: mat(CREW_X + 2.7, 3.15, z + 0.52, 0, 0, Math.PI / 2 - 0.45, 0.3, 0.85, 0.3), color: [0.3, 0.31, 0.33] });
  }
  {
    const z = 33;
    crowd.add(CREW_X - 0.9, 0, z, Math.PI / 2 + 0.5, 'mic',
      { jersey: [0.72, 0.14, 0.16], shorts: [0.045, 0.048, 0.056], socks: [0.10, 0.10, 0.11], shoes: [0.018, 0.018, 0.02] });
    hard.push({ geo: CYL, m: mat(CREW_X - 0.55, 1.5, z + 0.2, 0.6, 0, 0, 0.09, 0.28, 0.09), color: [0.1, 0.1, 0.11] });
  }

  /* -------------------------------------------- endline photographer pit */
  for (let i = 0; i < 7; i++) {
    const x = -9 + i * 3.0 + rnd.range(-0.5, 0.5);
    const z = -FIELD.halfL - 2.6 + rnd.range(-0.3, 0.3);
    const yaw = Math.atan2(-x, 4) + Math.PI;
    crowd.add(x, 0, z, yaw, 'kneel', crewKit);
    hard.push({ geo: CYL, m: mat(x + Math.sin(yaw) * 0.55, 1.06, z + Math.cos(yaw) * 0.55, Math.PI / 2 + 0.1, yaw, 0, 0.24, 0.8, 0.24), color: [0.07, 0.07, 0.08] });
    hard.push({ geo: CYL, m: mat(x + Math.sin(yaw) * 0.95, 1.06, z + Math.cos(yaw) * 0.95, Math.PI / 2 + 0.1, yaw, 0, 0.3, 0.16, 0.3), color: [0.16, 0.16, 0.18] });
    kitBag(soft, hard, { DUFFEL, BOX }, x - 0.8, z - 0.7, rnd.range(-0.5, 0.5), 0.45, [0.11, 0.12, 0.13]);
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
  const peopleMesh = new THREE.Mesh(crowd.finish(), M.fabric);
  peopleMesh.name = 'sideline-people';
  peopleMesh.castShadow = true; peopleMesh.receiveShadow = true;
  // Matting and cable runs are ground-hugging, so they only ever receive.
  const groundMesh = new THREE.Mesh(parts(ground, 'sideline-ground'), M.rubber);
  groundMesh.castShadow = false; groundMesh.receiveShadow = true;
  g.add(hardMesh, plasticMesh, softMesh, peopleMesh, groundMesh);

  for (const s of scratch) s.dispose();
  crowd.dispose();
  return {
    group: g,
    people: crowd.count,
    peopleTriangles: crowd.triangles,
    peopleMs: crowd.ms,
  };
}

/* =========================================================================
 *  THE TOUCHLINE CROWD
 * =========================================================================
 *
 * Every human on the sideline is `entities/rig` geometry — the same procedural
 * athlete the fourteen on the pitch are built from, at the same far LOD tier
 * (`detailFor(2, …)`) that the broadcast framing already shows for far-side
 * players. There is no second, cheaper human in this codebase and there must
 * not be one: the previous version of this file made its thirty-odd bench
 * occupants, coaches, observers and camera operators out of BOX/CYL/SPH, and
 * at 55–75 m from a 34° lens they read as painted standees across the top
 * third of the primary frame.
 *
 * WHY THE RIG IS BAKED RATHER THAN INSTANTIATED. `buildRig()` is the public
 * entry point, but it always builds LOD 0 — a 17 k-triangle hero mesh with a
 * face, eyes, fingers and hair cards — even when the caller only wants the far
 * tier. Measured on an M1 Max: twelve bodies through `buildRig(levels: 3)` cost
 * 281 ms and produce three meshes each; the same twelve far-tier meshes built
 * directly cost 17.4 ms and are byte-identical to `lods[2]`. So we call the
 * same eleven part builders `buildRig` calls, at `detailFor(2, charDetail)`,
 * and skip the two levels nobody standing on a touchline will ever be close
 * enough to need.
 *
 * Baking then removes the rest of the runtime cost. These bodies never move,
 * so there is no reason to pay for a SkinnedMesh, a skeleton texture and a
 * draw call each. The pose is written into the bones once, the vertices are
 * transformed on the CPU, the submesh groups collapse into vertex colours
 * (skin / jersey / shorts / socks / shoes / hair), and the whole touchline
 * merges into the single `sideline-people` buffer the box figures used to
 * occupy — same one draw call, same one material.
 *
 * COST, measured at `--q high` (charDetail 1.0): 1 888 triangles per body.
 * Against a scene that draws 18.7 M triangles a frame, fifty-odd of them are
 * 0.5 % — which is why "the rig is too expensive for background bodies" was
 * never true and had to be checked rather than assumed.
 *
 * POSE. `Poser.aim()` sets a bone's *world* direction, so a pose is written as
 * "the thigh points forward and a little down", not as a chain of local Euler
 * angles that have to be composed in the author's head. Bind convention (see
 * `rig/Types.ts`): local +Y runs down the bone toward its child, local +Z is
 * the anatomical front, +X is the athlete's LEFT, so `_L` limbs live at
 * positive x. Ground contact is solved per body from the posed skeleton rather
 * than assumed, because a 1.62 m and a 2.03 m body do not put their ankles in
 * the same place.
 */

type PoseName =
  | 'stand' | 'crouch' | 'sit' | 'deskSit' | 'kneel'
  | 'coach' | 'operator' | 'shoulderCam' | 'boom' | 'mic';

interface Kit { jersey: RGB; shorts: RGB; socks: RGB; shoes: RGB; }
interface Look extends Kit { skin: RGB; hair: RGB; }
interface PoseOpts { seat?: number; }

interface Rand {
  next(): number;
  range(lo: number, hi: number): number;
  int(lo: number, hi: number): number;
  gauss(): number;
  pick<T>(a: readonly T[]): T;
  fork(salt: number): Rand;
}

interface PoolBody {
  geo: THREE.BufferGeometry;
  bones: NamedBones;
  boneList: THREE.Bone[];
  rootBone: THREE.Bone;
  skeleton: THREE.Skeleton;
  measure: Measure;
  bind: THREE.Quaternion[];
  /** vertex index → GROUP id, so a submesh becomes a vertex colour. */
  groupOf: Uint8Array;
  triangles: number;
}

/* ------------------------------------------------------------------ colour */

// Art direction §2: skin H 20–35°, S 20–35%, L* 25–75 across the roster. This
// is `#b08268` in linear, scaled — one base hue, a wide value spread, and a
// small warm/cool jitter so the line is not one family.
const SKIN_BASE: RGB = [0.430, 0.223, 0.141];
const HAIR: RGB[] = [
  [0.010, 0.009, 0.008], [0.010, 0.009, 0.008], [0.026, 0.017, 0.011],
  [0.045, 0.028, 0.016], [0.075, 0.046, 0.023], [0.140, 0.092, 0.038],
  [0.180, 0.135, 0.062], [0.115, 0.112, 0.106],
];

function personLook(r: Rand, kit: Kit): Look {
  const t = r.next();
  const v = 0.30 + 1.12 * Math.pow(1 - t, 1.35);
  const warm = 0.94 + r.next() * 0.12;
  return {
    ...kit,
    skin: [SKIN_BASE[0] * v * warm, SKIN_BASE[1] * v, SKIN_BASE[2] * v * (2 - warm)],
    hair: r.pick(HAIR),
  };
}

/* ------------------------------------------------------------------- poser */

const _qp = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const UPV = new THREE.Vector3(0, 1, 0);

class Poser {
  constructor(private body: PoolBody) {}

  reset(): void {
    const b = this.body.boneList, q = this.body.bind;
    for (let i = 0; i < b.length; i++) b[i].quaternion.copy(q[i]);
  }

  /** Point a bone's local +Y along (dx,dy,dz) in rig space, +Z toward `f…`. */
  aim(name: BoneName, dx: number, dy: number, dz: number, fx = 0, fy = 0, fz = 1): void {
    const bone = this.body.bones[name];
    const p = bone.parent;
    if (!p) return;
    p.getWorldQuaternion(_qp);
    bone.quaternion.copy(_qp.invert()).multiply(frameQuat(_dir.set(dx, dy, dz), _fwd.set(fx, fy, fz)));
  }

  /** Rig-space Y of a bone's origin, with the chain above it brought up to date. */
  y(name: BoneName): number {
    const bone = this.body.bones[name];
    bone.updateWorldMatrix(true, false);
    return bone.matrixWorld.elements[13];
  }

  /** Shoulder→elbow and elbow→wrist directions. `s` is +1 left, −1 right. */
  arm(s: 1 | -1, u: readonly number[], f: readonly number[]): void {
    const L = s > 0 ? '_L' : '_R';
    this.aim(`upperArm${L}` as BoneName, s * u[0], u[1], u[2]);
    this.aim(`foreArm${L}` as BoneName, s * f[0], f[1], f[2]);
  }

  /** Hip→knee, knee→ankle and (optionally) ankle→ball directions. */
  leg(s: 1 | -1, t: readonly number[], sh: readonly number[], ft?: readonly number[]): void {
    const L = s > 0 ? '_L' : '_R';
    this.aim(`thigh${L}` as BoneName, s * t[0], t[1], t[2]);
    this.aim(`shin${L}` as BoneName, s * sh[0], sh[1], sh[2]);
    if (ft) this.aim(`foot${L}` as BoneName, s * ft[0], ft[1], ft[2], 0, 1, 0);
  }

  /**
   * Forward pitch and axial twist through the spine. Each bone is aimed at an
   * absolute direction, so `pitch` is the total lean at the chest rather than a
   * per-vertebra increment — no accidental foetal curl.
   */
  spine(pitch: number, twist: number): void {
    if (Math.abs(pitch) < 0.02 && Math.abs(twist) < 0.02) return;
    const seg: [BoneName, number][] = [
      ['spine01', 0.30], ['spine02', 0.58], ['spine03', 0.82], ['chest', 1.0], ['neck', 0.9],
    ];
    for (const [n, k] of seg) {
      const a = pitch * k, w = twist * k;
      this.aim(n, 0, Math.cos(a), Math.sin(a), Math.sin(w), 0, Math.cos(w));
    }
  }

  /** Skull yaw and pitch. Positive yaw turns toward the athlete's left. */
  head(yaw: number, pitch: number): void {
    this.aim('head', 0, Math.cos(pitch), Math.sin(pitch), Math.sin(yaw), 0, Math.cos(yaw));
  }
}

/* -------------------------------------------------------------- the poses */

/** Ground the body on whichever contact is lowest, so nothing sinks. */
function groundOn(P: Poser, pts: readonly (readonly [BoneName, number])[]): number {
  let off = -Infinity;
  for (const [n, clearance] of pts) off = Math.max(off, clearance - P.y(n));
  return off;
}

const FEET = (m: Measure): readonly (readonly [BoneName, number])[] =>
  [['foot_L', m.ankleY], ['foot_R', m.ankleY]];

/** The five ways a person waiting on a touchline holds their arms. */
function idleArms(P: Poser, r: Rand): void {
  const v = r.int(0, 4);
  const lean = r.range(-0.05, 0.05);
  if (v === 0) {                       // hanging, relaxed
    P.arm(1, [0.14 + lean, -0.97, 0.06], [0.17, -0.94, 0.28]);
    P.arm(-1, [0.13 - lean, -0.97, 0.08], [0.15, -0.95, 0.24]);
  } else if (v === 1) {                // arms folded
    P.arm(1, [0.24, -0.92, 0.14], [-0.90, -0.16, 0.40]);
    P.arm(-1, [0.22, -0.93, 0.10], [-0.88, -0.24, 0.42]);
  } else if (v === 2) {                // hands on hips
    P.arm(1, [0.34, -0.90, -0.10], [-0.74, -0.48, 0.46]);
    P.arm(-1, [0.32, -0.91, -0.08], [-0.76, -0.46, 0.44]);
  } else if (v === 3) {                // clasped in front
    P.arm(1, [0.13, -0.96, 0.16], [-0.46, -0.58, 0.68]);
    P.arm(-1, [0.13, -0.96, 0.16], [-0.44, -0.60, 0.66]);
  } else {                             // one hand up, shading the eyes
    P.arm(1, [0.26, -0.52, 0.56], [-0.28, 0.74, 0.42]);
    P.arm(-1, [0.14, -0.97, 0.08], [0.16, -0.94, 0.26]);
  }
}

/** Feet apart, turned out a little, one knee softer than the other. */
function idleStance(P: Poser, r: Rand): void {
  const spread = r.range(0.02, 0.10);
  const turn = r.range(0.10, 0.34);
  P.leg(1, [spread, -0.995, r.range(-0.03, 0.05)], [spread * 0.4, -0.998, 0.03],
    [Math.sin(turn), 0.03, Math.cos(turn)]);
  P.leg(-1, [spread * 0.8, -0.996, r.range(-0.05, 0.03)], [spread * 0.3, -0.998, 0.02],
    [Math.sin(turn * 0.7), 0.03, Math.cos(turn * 0.7)]);
}

/**
 * Sit the body so the hip joint lands on `seat` and the feet still reach the
 * ground — the shin angle is solved from this body's own segment lengths, so a
 * 2.03 m bench occupant does not push its heels through the turf.
 */
function seatLegs(P: Poser, m: Measure, seat: number, splay: number, r: Rand): number {
  const off = seat + 0.055 - m.hipY;
  const tilt = r.range(0.10, 0.22);
  for (const s of [1, -1] as const) {
    P.aim(`thigh${s > 0 ? '_L' : '_R'}` as BoneName,
      s * splay, -Math.sin(tilt), Math.cos(tilt));
  }
  const ankleTarget = m.ankleY - off;
  for (const s of [1, -1] as const) {
    const knee = P.y(`shin${s > 0 ? '_L' : '_R'}` as BoneName);
    const c = Math.max(0.25, Math.min(1, (knee - ankleTarget) / Math.max(1e-3, m.shin)));
    const f = Math.sqrt(Math.max(0, 1 - c * c));
    P.leg(s, [s > 0 ? splay : splay, -Math.sin(tilt), Math.cos(tilt)],
      [splay * 0.5, -c, f], [0, 0.03, 1]);
  }
  return off;
}

function applyPose(P: Poser, m: Measure, pose: PoseName, r: Rand, o: PoseOpts): number {
  switch (pose) {
    case 'stand': {
      P.spine(r.range(-0.04, 0.07), r.range(-0.12, 0.12));
      idleStance(P, r);
      idleArms(P, r);
      P.head(r.range(-0.5, 0.5), r.range(-0.06, 0.12));
      return groundOn(P, FEET(m));
    }
    case 'crouch': {
      // Down on the haunches watching the point — heels up, elbows on knees.
      P.spine(0.30 + r.range(-0.06, 0.06), r.range(-0.15, 0.15));
      for (const s of [1, -1] as const) {
        P.leg(s, [0.14, -0.46, 0.88], [0.03, -0.93, -0.36], [0, 0.30, 0.95]);
      }
      P.arm(1, [0.24, -0.72, 0.66], [-0.10, -0.62, 0.78]);
      P.arm(-1, [0.22, -0.74, 0.64], [-0.08, -0.64, 0.76]);
      P.head(r.range(-0.35, 0.35), r.range(0.02, 0.14));
      // Heels are up in a squat, so the ball of the foot is the contact and the
      // ankle sits lower than it does standing.
      return groundOn(P, [['foot_L', m.ankleY * 0.72], ['foot_R', m.ankleY * 0.72]]);
    }
    case 'sit': {
      const seat = o.seat ?? 0.46;
      const off = seatLegs(P, m, seat, r.range(0.04, 0.22), r);
      const v = r.int(0, 3);
      if (v === 0) {                    // forward on the elbows
        P.spine(0.42, r.range(-0.12, 0.12));
        P.arm(1, [0.22, -0.86, 0.46], [0.06, -0.42, 0.91]);
        P.arm(-1, [0.20, -0.87, 0.45], [0.04, -0.44, 0.90]);
        P.head(r.range(-0.3, 0.3), 0.16);
      } else if (v === 1) {             // back, arms along the bench rail
        P.spine(-0.10, r.range(-0.2, 0.2));
        P.arm(1, [0.62, -0.36, -0.70], [0.52, 0.10, -0.85]);
        P.arm(-1, [0.60, -0.40, -0.69], [0.50, 0.06, -0.86]);
        P.head(r.range(-0.5, 0.5), -0.06);
      } else if (v === 2) {             // hunched over a bottle
        P.spine(0.30, r.range(-0.25, 0.25));
        P.arm(1, [0.16, -0.94, 0.30], [-0.42, -0.34, 0.84]);
        P.arm(-1, [0.15, -0.95, 0.28], [-0.40, -0.36, 0.83]);
        P.head(r.range(-0.2, 0.2), 0.26);
      } else {                          // upright, hands on the knees
        P.spine(0.10, r.range(-0.2, 0.2));
        P.arm(1, [0.18, -0.95, 0.24], [0.10, -0.72, 0.68]);
        P.arm(-1, [0.17, -0.95, 0.26], [0.08, -0.74, 0.66]);
        P.head(r.range(-0.6, 0.6), 0.04);
      }
      return off;
    }
    case 'deskSit': {
      const off = seatLegs(P, m, o.seat ?? 0.44, r.range(0.06, 0.16), r);
      P.spine(0.24, r.range(-0.10, 0.10));
      // Forearms flat on the trestle, head down over the spirit sheet.
      P.arm(1, [0.20, -0.90, 0.38], [0.02, -0.20, 0.98]);
      P.arm(-1, [0.19, -0.91, 0.37], [0.01, -0.22, 0.97]);
      P.head(r.range(-0.25, 0.25), 0.30);
      return off;
    }
    case 'kneel': {
      // Photographer: right knee down, left foot planted, camera to the eye.
      P.spine(0.16, r.range(-0.08, 0.08));
      P.leg(-1, [0.06, -0.60, -0.80], [0.02, -0.12, -0.99]);
      P.leg(1, [0.12, -0.56, 0.82], [0.02, -0.97, -0.24], [0, 0.05, 1]);
      P.arm(1, [0.22, -0.60, 0.77], [0.06, 0.24, 0.97]);
      P.arm(-1, [0.26, -0.62, 0.74], [0.10, 0.20, 0.97]);
      P.head(0, 0.10);
      return groundOn(P, [['shin_R', 0.085], ['foot_L', m.ankleY]]);
    }
    case 'coach': {
      // Standing on the line, calling a line change: one arm out, one on a hip.
      P.spine(0.05, r.range(0.10, 0.28));
      idleStance(P, r);
      P.arm(-1, [0.52, -0.30, 0.80], [0.36, 0.22, 0.91]);
      P.arm(1, [0.34, -0.90, -0.06], [-0.72, -0.50, 0.48]);
      P.head(r.range(-0.25, 0.15), 0.02);
      return groundOn(P, FEET(m));
    }
    case 'operator': {
      // Bent to a pedestal eyepiece: hips back, chest down, hands on the pan bars.
      P.spine(0.30, r.range(-0.06, 0.06));
      P.leg(1, [0.14, -0.97, 0.16], [0.05, -0.98, -0.15], [0, 0.06, 1]);
      P.leg(-1, [0.13, -0.97, -0.14], [0.04, -0.98, 0.12], [0, 0.06, 1]);
      P.arm(1, [0.26, -0.66, 0.71], [0.10, -0.16, 0.98]);
      P.arm(-1, [0.24, -0.68, 0.69], [0.08, -0.18, 0.98]);
      P.head(0, 0.22);
      return groundOn(P, FEET(m));
    }
    case 'shoulderCam': {
      // Weight forward, camera on the right shoulder, left hand under the lens.
      P.spine(0.14, -0.14);
      P.leg(1, [0.16, -0.96, -0.22], [0.06, -0.99, 0.10], [0.28, 0.05, 0.96]);
      P.leg(-1, [0.12, -0.97, 0.20], [0.04, -0.99, -0.08], [0.10, 0.05, 0.99]);
      P.arm(-1, [0.10, -0.42, 0.90], [-0.34, 0.62, 0.70]);
      P.arm(1, [0.34, -0.60, 0.72], [-0.24, 0.10, 0.96]);
      P.head(-0.10, 0.10);
      return groundOn(P, FEET(m));
    }
    case 'boom': {
      // Both arms overhead on the pole, head tipped back to watch the mic.
      P.spine(-0.06, 0.10);
      idleStance(P, r);
      P.arm(1, [0.30, 0.72, 0.62], [0.22, 0.86, 0.46]);
      P.arm(-1, [0.34, 0.40, 0.85], [0.26, 0.74, 0.62]);
      P.head(0.12, -0.12);
      return groundOn(P, FEET(m));
    }
    case 'mic': {
      // Reporter: mic hand up at the chin, other hand holding an earpiece.
      P.spine(0.04, -0.10);
      idleStance(P, r);
      P.arm(-1, [0.22, -0.56, 0.80], [-0.34, 0.72, 0.60]);
      P.arm(1, [0.28, -0.40, 0.60], [-0.52, 0.78, 0.34]);
      P.head(0.10, -0.02);
      return groundOn(P, FEET(m));
    }
  }
}

/* ------------------------------------------------------------------- crowd */

const _place = new THREE.Matrix4();
const _shift = new THREE.Matrix4();
const _skin = new THREE.Matrix4();
const _vp = new THREE.Vector3();
const _vn = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _pos3 = new THREE.Vector3();

class Crowd {
  private pool: PoolBody[] = [];
  private out: THREE.BufferGeometry[] = [];
  private rnd: Rand;
  count = 0;
  triangles = 0;
  ms = 0;

  constructor(ctx: Ctx, rnd: Rand) {
    this.rnd = rnd;
    const t0 = now();
    const charDetail = ctx.quality.charDetail;
    // Twelve bodies over ~fifty placements: with four pose families, five arm
    // variants, a free yaw and independent skin/hair/kit, no two neighbours
    // repeat. More pool entries buy nothing a viewer at 55 m can resolve.
    const n = Math.max(6, Math.round(6 + 6 * charDetail));
    for (let i = 0; i < n; i++) {
      this.pool.push(farBody(randomBodyParams(this.rnd.fork(i * 131 + 7) as any), charDetail));
    }
    this.ms += now() - t0;
  }

  add(x: number, y: number, z: number, yaw: number, pose: PoseName, kit: Kit, o: PoseOpts = {}): void {
    const t0 = now();
    const r = this.rnd.fork(this.count * 2657 + 19);
    const body = this.pool[r.int(0, this.pool.length - 1)];
    const P = new Poser(body);
    P.reset();
    const yOff = applyPose(P, body.measure, pose, r, o);
    body.rootBone.updateMatrixWorld(true);
    body.skeleton.update();

    // A shared pool entry twice in one knot is the only clone risk left, so a
    // few per-cent of stature breaks the silhouette without distorting it.
    const sc = 0.97 + r.next() * 0.06;
    _place.compose(
      _pos3.set(x, y, z),
      _quat.setFromEuler(_euler.set(0, yaw, 0)),
      _scale.set(sc, sc, sc),
    ).multiply(_shift.makeTranslation(0, yOff, 0));

    this.out.push(bakeBody(body, _place, personLook(r, kit)));
    this.triangles += body.triangles;
    this.count++;
    this.ms += now() - t0;
  }

  /** Merge the whole touchline into the one buffer the box figures had. */
  finish(): THREE.BufferGeometry {
    const t0 = now();
    const merged = mergeGeometries(this.out, false);
    for (const g of this.out) g.dispose();
    this.out.length = 0;
    if (!merged) throw new Error('sideline: people merge failed');
    merged.name = 'sideline-people';
    merged.computeBoundingSphere();
    this.ms += now() - t0;
    return merged;
  }

  dispose(): void {
    for (const b of this.pool) { b.geo.dispose(); b.skeleton.dispose(); }
    this.pool.length = 0;
  }
}

const now = (): number =>
  (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * One far-tier athlete: the exact eleven builders `PlayerRig.buildRig` runs for
 * its LOD 2 level, without the two nearer levels no touchline body needs.
 */
function farBody(params: BodyParams, charDetail: number): PoolBody {
  const a = measureBody(params);
  const { skeleton, bones, rootBone, measure } = buildSkeleton(a);
  const d = detailFor(2, charDetail);
  const m = new RigMesh();
  buildTorso(m, a, d);
  buildNeck(m, a, d);
  buildArms(m, a, d);
  buildLegs(m, a, d);
  buildAnkles(m, a, d);
  buildHead(m, a, d);
  buildHands(m, a, measure, d);
  buildJersey(m, a, d);
  buildShorts(m, a, d);
  buildSocks(m, a, d);
  buildShoes(m, a, d);
  const geo = m.build('sideline.body');

  // Submesh groups become a per-vertex lookup, because the baked touchline is
  // one material and colour is the only channel left to separate a sock from a
  // shin. Groups do not share vertices, so a single pass is exact.
  const vcount = geo.attributes.position.count;
  const groupOf = new Uint8Array(vcount);
  const idx = geo.index!.array;
  for (const grp of geo.groups) {
    const end = grp.start + grp.count;
    const gi = grp.materialIndex ?? 0;
    for (let i = grp.start; i < end; i++) groupOf[idx[i]] = gi;
  }
  return {
    geo, bones, boneList: skeleton.bones, rootBone, skeleton, measure,
    bind: skeleton.bones.map((b) => b.quaternion.clone()),
    groupOf, triangles: m.triangles(),
  };
}

/**
 * Linear-blend skin the posed rig on the CPU and hand back a static buffer.
 * `bindMatrix` is identity for every rig mesh (`PlayerRig` binds with one), so
 * the skinning matrix is just the weighted sum of the skeleton's bone matrices.
 */
function bakeBody(body: PoolBody, place: THREE.Matrix4, look: Look): THREE.BufferGeometry {
  const src = body.geo;
  const pos = src.attributes.position as THREE.BufferAttribute;
  const nrm = src.attributes.normal as THREE.BufferAttribute;
  const si = src.attributes.skinIndex as THREE.BufferAttribute;
  const sw = src.attributes.skinWeight as THREE.BufferAttribute;
  const bm = body.skeleton.boneMatrices!;
  const n = pos.count;

  const P = new Float32Array(n * 3);
  const N = new Float32Array(n * 3);
  const C = new Float32Array(n * 3);
  const e = _skin.elements;
  const tint: RGB[] = [look.skin, look.jersey, look.shorts, look.socks, look.shoes, look.hair, look.skin];

  for (let v = 0; v < n; v++) {
    for (let j = 0; j < 16; j++) e[j] = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(v, k);
      if (w === 0) continue;
      const o = si.getComponent(v, k) * 16;
      for (let j = 0; j < 16; j++) e[j] += bm[o + j] * w;
    }
    _vp.fromBufferAttribute(pos, v).applyMatrix4(_skin);
    P[v * 3] = _vp.x; P[v * 3 + 1] = _vp.y; P[v * 3 + 2] = _vp.z;
    _vn.fromBufferAttribute(nrm, v).transformDirection(_skin);
    N[v * 3] = _vn.x; N[v * 3 + 1] = _vn.y; N[v * 3 + 2] = _vn.z;
    const c = tint[body.groupOf[v]] ?? look.skin;
    C[v * 3] = c[0]; C[v * 3 + 1] = c[1]; C[v * 3 + 2] = c[2];
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('uv', (src.attributes.uv as THREE.BufferAttribute).clone());
  g.setAttribute('color', new THREE.BufferAttribute(C, 3));
  g.setIndex(new THREE.BufferAttribute((src.index!.array as Uint16Array | Uint32Array).slice(), 1));
  g.applyMatrix4(place);
  return g;
}

/* ------------------------------------------------------------------- props */

type ClothFn = (
  a: V3, b: V3, c: V3, d: V3, nu: number, nv: number,
  f: ((u: number, v: number) => number) | undefined, color: RGB,
) => void;

/**
 * A bilinear fabric patch with an optional per-(u,v) vertical displacement.
 * Every soft good on the touchline that used to be a flat box — canopy panels,
 * valances, table skirts, chair seats, umbrella gores — is one of these, and
 * the displacement is what makes it read as cloth under tension rather than
 * as painted card.
 */
function sheet(
  a: V3, b: V3, c: V3, d: V3, nu: number, nv: number,
  f?: (u: number, v: number) => number,
): THREE.BufferGeometry {
  const P = new Float32Array((nu + 1) * (nv + 1) * 3);
  const UV = new Float32Array((nu + 1) * (nv + 1) * 2);
  const idx: number[] = [];
  let k = 0;
  for (let iv = 0; iv <= nv; iv++) {
    const v = iv / nv;
    for (let iu = 0; iu <= nu; iu++) {
      const u = iu / nu;
      for (let ax = 0; ax < 3; ax++) {
        const top = a[ax] + (b[ax] - a[ax]) * u;
        const bot = d[ax] + (c[ax] - d[ax]) * u;
        P[k * 3 + ax] = top + (bot - top) * v;
      }
      if (f) P[k * 3 + 1] += f(u, v);
      UV[k * 2] = u; UV[k * 2 + 1] = v;
      k++;
    }
  }
  const cols = nu + 1;
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) {
      const i0 = iv * cols + iu;
      idx.push(i0, i0 + cols, i0 + cols + 1, i0, i0 + cols + 1, i0 + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A pop-up canopy: four hipped panels rising to a short ridge, each sagging
 * between its poles, with a scalloped valance hung off every eave. The flat
 * slab this replaces was 5.9 × 3.9 m of unbroken plane pointed straight at the
 * broadcast camera — the largest single "prop" tell on the touchline.
 */
function canopy(cloth: ClothFn, cx: number, y: number, cz: number, dx: number, dz: number, col: RGB): void {
  const hx = dx / 2, hz = dz / 2, rise = 0.56, ridge = dz * 0.12;
  const bright: RGB = [col[0] * 1.22, col[1] * 1.22, col[2] * 1.22];
  const sag = (amp: number) => (u: number, v: number) => -amp * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
  // Long sides: eave → ridge.
  for (const s of [-1, 1]) {
    cloth(
      [cx + s * hx, y, cz - hz], [cx + s * hx, y, cz + hz],
      [cx, y + rise, cz + ridge], [cx, y + rise, cz - ridge],
      6, 3, sag(0.055), s < 0 ? col : bright,
    );
  }
  // Ends: eave → ridge end point.
  for (const s of [-1, 1]) {
    cloth(
      [cx - hx, y, cz + s * hz], [cx + hx, y, cz + s * hz],
      [cx, y + rise, cz + s * ridge], [cx, y + rise, cz + s * ridge],
      5, 2, sag(0.04), bright,
    );
  }
  // Valance, scalloped along the bottom edge.
  const drop = 0.36;
  const scallop = (n: number) => (u: number, v: number) => -0.055 * v * (1 - Math.cos(u * Math.PI * 2 * n));
  for (const s of [-1, 1]) {
    cloth(
      [cx + s * hx, y, cz - hz], [cx + s * hx, y, cz + hz],
      [cx + s * hx, y - drop, cz + hz], [cx + s * hx, y - drop, cz - hz],
      10, 2, scallop(5), col,
    );
    cloth(
      [cx - hx, y, cz + s * hz], [cx + hx, y, cz + s * hz],
      [cx + hx, y - drop, cz + s * hz], [cx - hx, y - drop, cz + s * hz],
      7, 2, scallop(3), col,
    );
  }
}

/** An octagonal shade umbrella: eight stretched gores over eight ribs. */
function umbrella(
  cloth: ClothFn, hard: Part[], BOX: THREE.BufferGeometry,
  x: number, y: number, z: number, r: number, col: RGB,
): void {
  const N = 8, drop = 0.34;
  const bright: RGB = [col[0] * 1.2, col[1] * 1.2, col[2] * 1.2];
  for (let k = 0; k < N; k++) {
    const a0 = (k / N) * Math.PI * 2, a1 = ((k + 1) / N) * Math.PI * 2;
    const p0: V3 = [x + Math.cos(a0) * r, y - drop, z + Math.sin(a0) * r];
    const p1: V3 = [x + Math.cos(a1) * r, y - drop, z + Math.sin(a1) * r];
    cloth([x, y, z], [x, y, z], p1, p0, 1, 3,
      (_u, v) => -0.10 * Math.sin(Math.PI * v), k % 2 ? col : bright);
    hard.push({ ...strut([x, y - 0.02, z], p0, 0.018, BOX), color: [0.42, 0.43, 0.44] });
  }
}

/** A folding chair: sagging seat and back on a splayed tube frame. */
function foldChair(
  hard: Part[], cloth: ClothFn, BOX: THREE.BufferGeometry,
  x: number, z: number, yaw: number, col: RGB,
): void {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const at = (lx: number, ly: number, lz: number): V3 =>
    [x + lx * c + lz * s, ly, z - lx * s + lz * c];
  cloth(at(-0.23, 0.45, 0.22), at(0.23, 0.45, 0.22), at(0.23, 0.44, -0.22), at(-0.23, 0.44, -0.22),
    3, 3, (u, v) => -0.045 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v), col);
  cloth(at(-0.23, 0.92, -0.26), at(0.23, 0.92, -0.26), at(0.23, 0.50, -0.20), at(-0.23, 0.50, -0.20),
    3, 3, (u, v) => 0.035 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v), col);
  for (const sx of [-0.21, 0.21]) {
    hard.push({ ...strut(at(sx, 0.44, 0.20), at(sx, 0, -0.16), 0.035, BOX), color: [0.42, 0.43, 0.45] });
    hard.push({ ...strut(at(sx, 0.44, -0.20), at(sx, 0, 0.16), 0.035, BOX), color: [0.42, 0.43, 0.45] });
    hard.push({ ...strut(at(sx, 0.44, -0.20), at(sx, 0.90, -0.24), 0.032, BOX), color: [0.42, 0.43, 0.45] });
  }
}

/** A wheeled cool box: tapered tub, lid lip, two moulded handles, a spigot. */
function cooler(
  hard: Part[], plastic: Part[],
  P: { TUB: THREE.BufferGeometry; CYL: THREE.BufferGeometry },
  x: number, z: number, yaw: number, col: RGB,
): void {
  const lid: RGB = [0.86, 0.87, 0.88];
  plastic.push({ geo: P.TUB, m: mat(x, 0.28, z, 0, yaw + Math.PI / 4, 0, 1.02, 0.50, 0.72), color: col });
  plastic.push({ geo: P.TUB, m: mat(x, 0.555, z, 0, yaw + Math.PI / 4, 0, 1.10, 0.09, 0.78), color: lid });
  for (const s of [-1, 1]) {
    const hx = x + Math.cos(yaw) * s * 0.37, hz = z - Math.sin(yaw) * s * 0.37;
    hard.push({ geo: P.CYL, m: mat(hx, 0.42, hz, Math.PI / 2, yaw, 0, 0.07, 0.26, 0.07), color: [0.16, 0.17, 0.18] });
  }
  hard.push({ geo: P.CYL, m: mat(x + Math.sin(yaw) * 0.30, 0.16, z + Math.cos(yaw) * 0.30, Math.PI / 2, yaw, 0, 0.07, 0.14, 0.07), color: [0.18, 0.19, 0.2] });
}

/**
 * A ten-gallon water jug: truncated cone, white lid, wire bail, spigot.
 *
 * `JUG` carries the radius in its own geometry (0.50 at the base), so the
 * matrix scale here is a *diameter* of 0.44 m — the first pass passed 0.88 and
 * put four one-metre hay bales on the touchline in the `sideline` frame.
 */
// Art direction §2 allows exactly three saturated things in the frame and none
// of them is a drinks cooler, so the jug run is mixed rather than a row of
// identical orange drums: one team-issue orange, then grey and utility blue.
const JUG_COL: RGB[] = [[0.62, 0.30, 0.06], [0.34, 0.35, 0.36], [0.09, 0.14, 0.26], [0.50, 0.24, 0.05]];

function waterJug(
  plastic: Part[], hard: Part[],
  P: { JUG: THREE.BufferGeometry; CYL: THREE.BufferGeometry; BAIL: THREE.BufferGeometry },
  x: number, z: number, yaw: number, i = 0,
): void {
  plastic.push({ geo: P.JUG, m: mat(x, 0.31, z, 0, yaw, 0, 0.44, 0.62, 0.44), color: JUG_COL[i % JUG_COL.length] });
  plastic.push({ geo: P.CYL, m: mat(x, 0.635, z, 0, 0, 0, 0.38, 0.06, 0.38), color: [0.90, 0.92, 0.94] });
  hard.push({ geo: P.BAIL, m: mat(x, 0.63, z, 0, yaw, 0, 0.42, 0.24, 0.42), color: [0.55, 0.56, 0.58] });
  hard.push({
    geo: P.CYL,
    m: mat(x + Math.sin(yaw) * 0.17, 0.13, z + Math.cos(yaw) * 0.17, Math.PI / 2, yaw, 0, 0.055, 0.13, 0.055),
    color: [0.20, 0.21, 0.22],
  });
}

/** A kit bag: a barrel with rounded ends, a strap and two stubby feet. */
function kitBag(
  soft: Part[], hard: Part[],
  P: { DUFFEL: THREE.BufferGeometry; BOX: THREE.BufferGeometry },
  x: number, z: number, yaw: number, len: number, col: RGB,
): void {
  const r = len * 0.42;
  soft.push({ geo: P.DUFFEL, m: mat(x, r, z, Math.PI / 2, yaw, 0, r * 2, len, r * 2), color: col });
  hard.push({
    geo: P.BOX,
    m: mat(x, r * 1.9, z, 0, yaw, 0, r * 1.5, 0.035, 0.10),
    color: [col[0] * 0.55, col[1] * 0.55, col[2] * 0.6],
  });
}

function cart(
  hard: Part[], plastic: Part[], crowd: Crowd,
  P: { BOX: THREE.BufferGeometry; CYL: THREE.BufferGeometry; DUFFEL: THREE.BufferGeometry },
  x: number, z: number, rnd: Rand,
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
  crowd.add(x - 1.3, 0, z + 0.4, yaw + 0.4, 'stand',
    { jersey: [0.80, 0.81, 0.83], shorts: [0.055, 0.058, 0.070], socks: [0.55, 0.55, 0.56], shoes: [0.020, 0.020, 0.022] });
  crowd.add(x - 1.9, 0, z - 1.1, yaw - 0.5, 'stand',
    { jersey: [0.80, 0.81, 0.83], shorts: [0.055, 0.058, 0.070], socks: [0.55, 0.55, 0.56], shoes: [0.020, 0.020, 0.022] });
  hard.push({ geo: P.DUFFEL, m: mat(x + 0.55, 0.20, z - 1.3, Math.PI / 2, rnd.range(-0.4, 0.4), 0, 0.40, 0.44, 0.40), color: [0.72, 0.12, 0.12] });
}

/** A camera pod hung off the roof trusses. */
function gantry(
  hard: Part[], crowd: Crowd, BOX: THREE.BufferGeometry,
  side: number, z: number, kit: Kit,
): void {
  // Hung off the canopy just behind its leading edge, so the pod is always
  // under the roof and always the same height above the seats.
  const off = ROOF.frontOff + 2.4;
  const roofY = roofYAt(off);
  const x = side * (BOWL.hx + off);
  const deckY = roofY - 3.6;
  const w = 8.0, d = 4.4;
  hard.push({ geo: BOX, m: mat(x, deckY, z, 0, 0, 0, d, 0.16, w), color: [0.42, 0.44, 0.47] });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = x + sx * d / 2, pz = z + sz * w / 2;
    hard.push({ ...strut([px, deckY, pz], [px, roofY - 0.3, pz], 0.09, BOX), color: [0.6, 0.62, 0.65] });
    hard.push({ ...strut([px, deckY + 1.05, pz], [px, deckY, pz], 0.05, BOX), color: [0.72, 0.74, 0.77] });
  }
  for (const sz of [-1, 1]) {
    hard.push({ ...strut([x - d / 2, deckY + 1.05, z + sz * w / 2], [x + d / 2, deckY + 1.05, z + sz * w / 2], 0.05, BOX), color: [0.72, 0.74, 0.77] });
  }
  hard.push({ ...strut([x + side * d / 2, deckY + 1.05, z - w / 2], [x + side * d / 2, deckY + 1.05, z + w / 2], 0.05, BOX), color: [0.72, 0.74, 0.77] });
  // Two operators behind big lensed cameras on pedestals.
  for (const sz of [-2.7, 2.7]) {
    const cx = x - side * 1.3, cz = z + sz;
    hard.push({ geo: BOX, m: mat(cx, deckY + 1.35, cz, 0, 0, 0, 0.55, 0.36, 0.42), color: [0.1, 0.1, 0.11] });
    hard.push({ geo: BOX, m: mat(cx + side * 0.62, deckY + 1.35, cz, 0, 0, 0, 0.7, 0.26, 0.26), color: [0.08, 0.08, 0.09] });
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      hard.push({ ...strut([cx, deckY + 1.17, cz], [cx + Math.cos(a) * 0.4, deckY + 0.16, cz + Math.sin(a) * 0.4], 0.05, BOX), color: [0.3, 0.31, 0.33] });
    }
    crowd.add(cx - side * 0.75, deckY + 0.1, cz, side > 0 ? Math.PI / 2 : -Math.PI / 2, 'operator', kit);
  }
}
