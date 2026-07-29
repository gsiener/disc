import * as THREE from 'three';
import type { QualitySettings } from '../core/Ctx.ts';
import {
  BONE_NAMES, BONE_INDEX, GROUP, GROUP_NAMES, PART, FINGERS, HAIR_STYLES,
} from './rig/Types.ts';
import type {
  BodyParams, BoneName, FaceParams, GroupName, HairStyle, Measure, NamedBones,
  PlayerRig, RigLod, RigQuality,
} from './rig/Types.ts';
import { measureBody, buildSkeleton } from './rig/Skeleton.ts';
import { RigMesh } from './rig/Build.ts';
import { detailFor, buildTorso, buildNeck, buildArms, buildLegs, buildAnkles } from './rig/Body.ts';
import { buildHead } from './rig/Head.ts';
import { buildHands } from './rig/Hands.ts';
import { buildJersey, buildShorts, buildSocks, buildShoes } from './rig/Cloth.ts';
import { randomBodyParams, referenceBodyParams, randomFace } from './rig/Params.ts';

/**
 * ============================================================================
 *  THE PROCEDURAL ATHLETE — public contract
 * ============================================================================
 *
 *   import { buildRig, randomBodyParams } from './entities/PlayerRig.ts';
 *
 *   const params = randomBodyParams(ctx.rand.fork(playerId));
 *   const rig    = buildRig(params, ctx.quality);
 *   rig.root.position.set(x, 0, z);         // ground position — origin is the FEET
 *   rig.root.rotation.y = facing;
 *   ctx.scene.add(rig.root);
 *   rig.lod.update(ctx.camera);             // once per frame, by the owner
 *
 * WHAT YOU GET BACK  (see rig/Types.ts `PlayerRig`)
 *   root         THREE.Group — add this, move this. Contains the bone hierarchy
 *                and a THREE.LOD holding every level.
 *   skinnedMesh  the LOD0 SkinnedMesh. lods[i].mesh for the others.
 *   skeleton     THREE.Skeleton, shared by every LOD.
 *   bones        typed record: `rig.bones.foreArmTwist_R` — no string lookups.
 *   groups       submesh name → material-array index.
 *   materials    the shared material array. Assign in place:
 *                  rig.materials[rig.groups.jersey] = myJerseyMaterial;
 *                Every LOD points at the same array, so one write covers all.
 *   measure      bind-pose limb lengths + per-bone world bind position/axis,
 *                which is everything an IK solver needs without re-deriving it.
 *
 * SPACE AND POSE CONVENTIONS
 *   • Metres. Origin at the feet, on y = 0. +Y up, +Z forward (facing).
 *     +X is the athlete's LEFT, so `_L` bones sit at positive x (glTF order).
 *   • Every bone's local +Y runs down the bone toward its child, local +Z is
 *     the anatomical front. Therefore, on every limb bone:
 *         rotation.x = the primary bend      rotation.y = twist/roll
 *     Hand and finger bones use the PALM as local +Z, so a curl is +rotation.x
 *     on all fifteen digit joints. Foot and toe use world-up as their +Z, so
 *     dorsiflexion and toe-off are also +rotation.x.
 *   • Bind pose is a 46° A-pose with a 9° elbow and 4° knee pre-bend. Nothing
 *     is straight at bind; a straight joint has no preferred fold direction and
 *     hyper-extends on the first stride.
 *
 * TWIST BONES — the reason this rig has 60 bones and not 48
 *   `upperArmTwist`, `foreArmTwist` and `thighTwist` are LEAF siblings, never
 *   links in the chain. Drive them with a fraction of the roll their parent did
 *   not take:
 *       bones.upperArmTwist_R.rotation.y = humeralRoll * 0.5;
 *       bones.foreArmTwist_R.rotation.y  = handRoll    * 0.65;
 *       bones.thighTwist_R.rotation.y    = femoralRoll * 0.5;
 *   Skin weights near the wrist are bound to `foreArmTwist`, so 90° of
 *   pronation on a backhand is distributed over 12 cm of forearm instead of
 *   folding into one ring at the wrist. Skipping this is the paper-bag crease.
 *
 * VERTEX ATTRIBUTES beyond the standard set (for the material author)
 *   aPart   float   part id — PART.HEAD, PART.FOREARM, PART.JERSEY, …
 *   aSide   float   −1 right limb, 0 centre, +1 left limb
 *   aCrease float   0..1 baked cavity: orbit, nasolabial fold, lip line,
 *                   armpit, elbow pit, popliteal fossa, groin, hem undersides.
 *                   Multiply into AO — it is the substitute for a baked AO map.
 *   aLen    float   0..1 along the part, 0 at the proximal end.
 *   uv              u wraps the cross-section, v runs along the part.
 *                   EYES ONLY: uv.y = 1 is the corneal apex, iris ≈ uv.y > 0.86,
 *                   pupil ≈ uv.y > 0.955.
 *
 * SUBMESH GROUPS, in material-array order
 *   0 skin   1 jersey   2 shorts   3 socks   4 shoes   5 hair   6 eyes
 *
 * COST (measured, M1 Max, headless Chrome / ANGLE Metal).
 *   charDetail 1.00 — 3 LODs, 17.1k / 4.4k / 1.6k tris.  ~30 ms per athlete,
 *                     167 ms for a full 14-player roster.
 *   charDetail 0.50 — 2 LODs, 14.1k / 1.4k tris.         123 ms for 14.
 * Geometry is unique per player — the parameter vector changes every vertex —
 * but the skeleton layout, the bone indices and the group order never change,
 * so materials, clips and the pose code are shared across the whole roster.
 */

export type {
  BodyParams, BoneName, FaceParams, GroupName, HairStyle, Measure, NamedBones,
  PlayerRig, RigLod, RigQuality,
};
export {
  BONE_NAMES, BONE_INDEX, GROUP, GROUP_NAMES, PART, FINGERS, HAIR_STYLES,
  randomBodyParams, referenceBodyParams, randomFace, measureBody,
};

const LOD_DISTANCE = [0, 7.5, 24];

function resolveQuality(q: QualitySettings | RigQuality | number | undefined): RigQuality {
  if (typeof q === 'number') return { charDetail: q };
  if (!q) return { charDetail: 1 };
  return { charDetail: (q as RigQuality).charDetail ?? 1, levels: (q as RigQuality).levels };
}

/**
 * Build one athlete. Deterministic: same params in, byte-identical geometry out.
 */
export function buildRig(
  params: BodyParams,
  quality?: QualitySettings | RigQuality | number,
): PlayerRig {
  const q = resolveQuality(quality);
  const detailScale = q.charDetail;
  const levels = Math.max(1, Math.min(3, q.levels ?? (detailScale < 0.6 ? 2 : 3)));

  const anthro = measureBody(params);
  const { skeleton, bones, rootBone, measure } = buildSkeleton(anthro);

  const materials: THREE.Material[] = GROUP_NAMES.map((name) => {
    const m = new THREE.MeshStandardMaterial({
      color: DEFAULT_TINT[name], roughness: DEFAULT_ROUGH[name], metalness: 0,
      side: name === 'hair' ? THREE.DoubleSide : THREE.FrontSide,
    });
    m.name = `playerRig.${name}`;
    return m;
  });

  const lod = new THREE.LOD();
  lod.name = 'player.lod';
  const lods: RigLod[] = [];
  let tris = 0;

  // LOD levels start at index 0 (hero) and are skipped from the coarse end so a
  // low-tier build still gets the near mesh it needs for a closeup.
  const wanted = levels === 3 ? [0, 1, 2] : levels === 2 ? [0, 2] : [0];
  for (let li = 0; li < wanted.length; li++) {
    const level = wanted[li] as 0 | 1 | 2;
    const d = detailFor(level, detailScale);
    const m = new RigMesh();

    buildTorso(m, anthro, d);
    buildNeck(m, anthro, d);
    buildArms(m, anthro, d);
    buildLegs(m, anthro, d);
    buildAnkles(m, anthro, d);
    buildHead(m, anthro, d);
    buildHands(m, anthro, measure, d);
    buildJersey(m, anthro, d);
    buildShorts(m, anthro, d);
    buildSocks(m, anthro, d);
    buildShoes(m, anthro, d);

    const geo = m.build(`player.lod${level}`);
    const mesh = new THREE.SkinnedMesh(geo, materials);
    mesh.name = `player.lod${level}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    // Every level shares one skeleton, so the pose is written once per frame.
    mesh.bind(skeleton, new THREE.Matrix4());
    const t = m.triangles();
    tris += t;
    // THREE.LOD does not set visibility until its first update(), so without
    // this every level draws at once and every surface z-fights itself.
    mesh.visible = li === 0;
    lod.addLevel(mesh, li === 0 ? 0 : LOD_DISTANCE[level]);
    lods.push({ mesh, distance: li === 0 ? 0 : LOD_DISTANCE[level], triangles: t });
  }

  const root = new THREE.Group();
  root.name = 'player';
  root.add(rootBone);
  root.add(lod);

  return {
    root, lod, lods, skeleton, bones, measure, params, materials,
    skinnedMesh: lods[0].mesh,
    groups: GROUP,
    triangles: tris,
    dispose() {
      for (const l of lods) l.mesh.geometry.dispose();
      for (const mat of materials) mat.dispose();
      skeleton.dispose();
    },
  };
}

/**
 * Neutral placeholder look so the rig is legible before the material system
 * lands. These are replaced wholesale — `rig.materials[i] = ...`.
 */
const DEFAULT_TINT: Record<GroupName, number> = {
  skin: 0xb08268, jersey: 0x2f4f7a, shorts: 0x2b3442, socks: 0xd8dbe0,
  shoes: 0x222428, hair: 0x2a2119, eyes: 0xf2f0ec,
};
const DEFAULT_ROUGH: Record<GroupName, number> = {
  skin: 0.55, jersey: 0.78, shorts: 0.74, socks: 0.88, shoes: 0.52, hair: 0.62, eyes: 0.18,
};

/**
 * Build a whole roster. Kept here rather than in the caller so the timing
 * report and the per-player rng fork stay in one place.
 */
export function buildRoster(
  count: number,
  rand: { next(): number; range(lo: number, hi: number): number; gauss(): number; pick<T>(a: readonly T[]): T; fork(salt: number): any },
  quality?: QualitySettings | RigQuality | number,
): { rigs: PlayerRig[]; ms: number; triangles: number } {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const rigs: PlayerRig[] = [];
  let triangles = 0;
  for (let i = 0; i < count; i++) {
    const r = rand.fork(i * 7919 + 13);
    const p = randomBodyParams(r);
    const rig = buildRig(p, quality);
    triangles += rig.triangles;
    rigs.push(rig);
  }
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return { rigs, ms, triangles };
}
