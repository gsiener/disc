import * as THREE from 'three';
import type { Ctx } from '../../core/Ctx';
import { parts, strut, UNIT_BOX, mat, type Part, type RGB } from './Geo';
import type { StadiumMaterials } from './Materials';
import { FLOODLIGHT_TOWERS } from './Layout';

/**
 * Floodlight masts — the visible hardware only. LightingSystem owns the actual
 * lights and reads `FLOODLIGHT_TOWERS` from Layout.ts so the beams start where
 * the modelled fixture cluster is.
 *
 * One tower is authored in a local frame with +X pointing at the field centre,
 * so all four are the same InstancedMesh with a yaw per instance: the mast
 * lattice + ladders + rest platforms in steel, and the lamp lenses in a second
 * unlit instanced mesh whose brightness is driven by time of day.
 */

export interface TowersBuild {
  group: THREE.Group;
  setNight(k: number): void;
}

export function buildTowers(ctx: Ctx, M: StadiumMaterials): TowersBuild {
  const g = new THREE.Group();
  g.name = 'floodlights';

  const H = FLOODLIGHT_TOWERS[0].head[1];
  const headX = 4.1;
  const struct = buildMast(H, headX, ctx.quality.tier !== 'low');
  const lens = buildLenses(H, headX);

  const lensMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(2.2, 2.05, 1.75), toneMapped: true, name: 'flood-lens',
  });

  const masts = new THREE.InstancedMesh(struct, M.steel, FLOODLIGHT_TOWERS.length);
  const lamps = new THREE.InstancedMesh(lens, lensMat, FLOODLIGHT_TOWERS.length);
  masts.name = 'flood-masts';
  lamps.name = 'flood-lamps';

  const m4 = new THREE.Matrix4();
  for (let i = 0; i < FLOODLIGHT_TOWERS.length; i++) {
    const t = FLOODLIGHT_TOWERS[i];
    // Local +X must end up pointing at the field centre.
    const yaw = Math.atan2(t.base[1], -t.base[0]);
    m4.copy(mat(t.base[0], 0, t.base[1], 0, yaw, 0));
    masts.setMatrixAt(i, m4);
    lamps.setMatrixAt(i, m4);
  }
  masts.instanceMatrix.needsUpdate = true;
  lamps.instanceMatrix.needsUpdate = true;
  masts.castShadow = ctx.quality.tier !== 'low';
  masts.receiveShadow = true;
  masts.frustumCulled = false;
  lamps.frustumCulled = false;
  g.add(masts, lamps);

  return {
    group: g,
    setNight(k: number) {
      const v = 0.55 + k * 4.2;
      lensMat.color.setRGB(v, v * 0.95, v * 0.84);
    },
  };
}

/* --------------------------------------------------------------- geometry */

/** Local frame: +X toward the field centre, +Y up, +Z across. */
function buildMast(H: number, headX: number, detail: boolean): THREE.BufferGeometry {
  const list: Part[] = [];
  const LEG: RGB = [1, 1, 1];
  const LACE: RGB = [0.78, 0.8, 0.83];
  const DECK: RGB = [0.55, 0.57, 0.6];

  const half = (y: number) => 3.1 - 2.0 * (y / H);      // taper
  const corner = (i: number, y: number): [number, number, number] => {
    const s = half(y);
    const cx = i === 0 || i === 3 ? -s : s;
    const cz = i < 2 ? -s : s;
    return [cx, y, cz];
  };

  const lifts = 16;
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < lifts; i++) {
      const y0 = (i / lifts) * H, y1 = ((i + 1) / lifts) * H;
      list.push({ ...strut(corner(c, y0), corner(c, y1), 0.30, UNIT_BOX), color: LEG });
    }
  }
  for (let i = 0; i <= lifts; i++) {
    const y = (i / lifts) * H;
    for (let c = 0; c < 4; c++) {
      const a = corner(c, y), b = corner((c + 1) % 4, y);
      list.push({ ...strut(a, b, 0.15, UNIT_BOX), color: LACE });
      if (i < lifts && (detail || i % 2 === 0)) {
        const y2 = ((i + 1) / lifts) * H;
        list.push({ ...strut(a, corner((c + 1) % 4, y2), 0.11, UNIT_BOX), color: LACE });
      }
    }
  }

  // Ladder up the rear face + rest platforms.
  const lx = () => -half(0) * 0.55;
  for (const dz of [-0.28, 0.28]) {
    list.push({ ...strut([lx(), 1.0, dz], [lx() * 0.4, H - 3, dz], 0.075, UNIT_BOX), color: LACE });
  }
  const rungs = detail ? 60 : 26;
  for (let i = 0; i < rungs; i++) {
    const t = i / rungs;
    const y = 1.2 + t * (H - 5);
    const x = lx() * (1 - t * 0.6);
    list.push({ ...strut([x, y, -0.3], [x, y, 0.3], 0.055, UNIT_BOX), color: LACE });
  }
  for (const y of [12, 24, 34]) {
    const s = half(y);
    list.push({ geo: new THREE.BoxGeometry(s * 2.3, 0.16, 1.5), m: mat(-s * 0.4, y, 0), color: DECK });
    for (const dz of [-0.75, 0.75]) {
      list.push({ ...strut([-s * 1.5, y, dz], [s * 0.7, y, dz], 0.06, UNIT_BOX), color: LACE });
      list.push({ ...strut([-s * 1.5, y + 1.0, dz], [s * 0.7, y + 1.0, dz], 0.06, UNIT_BOX), color: LACE });
      for (let k = 0; k <= 3; k++) {
        const x = -s * 1.5 + (k / 3) * (s * 2.2);
        list.push({ ...strut([x, y, dz], [x, y + 1.0, dz], 0.055, UNIT_BOX), color: LACE });
      }
    }
  }

  // Head frame + service catwalk under the lamp bank.
  const hw = 6.2, hh = 3.4;
  const hy = H;
  for (const dy of [-hh, hh]) {
    list.push({ ...strut([headX - 1.2, hy + dy, -hw], [headX - 1.2, hy + dy, hw], 0.26, UNIT_BOX), color: LEG });
    list.push({ ...strut([headX + 0.6, hy + dy, -hw], [headX + 0.6, hy + dy, hw], 0.2, UNIT_BOX), color: LEG });
  }
  for (let i = 0; i <= 6; i++) {
    const z = -hw + (i / 6) * hw * 2;
    list.push({ ...strut([headX - 1.2, hy - hh, z], [headX - 1.2, hy + hh, z], 0.18, UNIT_BOX), color: LEG });
    list.push({ ...strut([headX - 1.2, hy - hh, z], [headX + 0.6, hy - hh + 0.3, z], 0.14, UNIT_BOX), color: LACE });
    list.push({ ...strut([headX - 1.2, hy + hh, z], [headX + 0.6, hy + hh - 0.3, z], 0.14, UNIT_BOX), color: LACE });
    // back stays to the mast
    list.push({ ...strut([headX - 1.2, hy + (i % 2 ? hh : -hh), z], [0, hy - 1.5, z * 0.28], 0.12, UNIT_BOX), color: LACE });
  }
  // catwalk
  list.push({ geo: new THREE.BoxGeometry(2.0, 0.14, hw * 2), m: mat(headX - 2.4, hy - hh - 0.6, 0), color: DECK });
  for (const dz of [-hw, hw]) {
    list.push({ ...strut([headX - 3.3, hy - hh - 0.6, dz], [headX - 1.5, hy - hh - 0.6, dz], 0.06, UNIT_BOX), color: LACE });
  }
  list.push({ ...strut([headX - 3.3, hy - hh + 0.45, -hw], [headX - 3.3, hy - hh + 0.45, hw], 0.06, UNIT_BOX), color: LACE });

  // Lamp housings ride on the steel mesh; the bright lenses are a second mesh.
  const body = new THREE.CylinderGeometry(0.33, 0.40, 0.52, 10, 1, false);
  forEachFixture(H, headX, (x, y, z, yaw) => {
    list.push({ geo: body, m: mat(x - 0.28, y, z, Math.PI - TILT, Math.PI / 2 + yaw, 0), color: [0.46, 0.48, 0.52] });
  });

  const geo = parts(list, 'flood-mast');
  body.dispose();
  return geo;
}

const TILT = 0.47;   // ≈27° down, matching the mast height vs pitch distance

function forEachFixture(
  H: number, headX: number,
  cb: (x: number, y: number, z: number, yaw: number) => void,
): void {
  const rows = 4, cols = 6;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cb(headX + 0.95, H + (r - (rows - 1) / 2) * 1.55, (c - (cols - 1) / 2) * 2.05,
        (c - (cols - 1) / 2) * 0.055);
    }
  }
}

/** The bright lens discs, aimed down at the pitch. */
function buildLenses(H: number, headX: number): THREE.BufferGeometry {
  const list: Part[] = [];
  const disc = new THREE.CircleGeometry(0.31, 12);
  forEachFixture(H, headX, (x, y, z, yaw) => {
    list.push({ geo: disc, m: mat(x, y, z, TILT, Math.PI / 2 + yaw, 0), color: [1, 1, 1] });
  });
  const geo = parts(list, 'flood-lenses');
  disc.dispose();
  return geo;
}
