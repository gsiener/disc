import * as THREE from 'three';

/**
 * The public vocabulary of the player rig: bone names, part ids, submesh group
 * names and the body parameter vector. Two other agents build materials and
 * animation against this file, so treat every name here as load-bearing API.
 *
 * SPACE. Bind pose is authored in metres with the athlete standing on y = 0,
 * facing +Z. +Y is up. **+X is the athlete's LEFT** (glTF convention), so bones
 * suffixed `_L` sit at positive x. The rig root is at the feet, not the hips,
 * so `root.position` can be driven straight from Locomotion's ground position.
 */

/* ------------------------------------------------------------------ bones */

/**
 * 60 bones, hierarchy order. `skinIndex` values index this array.
 *
 *   root
 *    └ pelvis
 *       ├ spine01 → spine02 → spine03 → chest
 *       │    ├ neck → head
 *       │    └ clavicle_{L,R} → upperArm → { upperArmTwist(leaf), foreArm }
 *       │           foreArm → { foreArmTwist(leaf), hand }
 *       │           hand → thumb/index/middle/ring/pinky 01→02→03
 *       └ thigh_{L,R} → { thighTwist(leaf), shin } ; shin → foot → toe
 *
 * TWIST BONES are leaf siblings, never in the chain. That is the whole point:
 * `foreArmTwist_R` carries a fraction of the wrist's roll while `hand_R` carries
 * all of it, so a backhand throw distributes 90 degrees of pronation over 12 cm
 * of forearm instead of folding it into one ring at the wrist. Drive them as:
 *
 *   upperArmTwist.rotation.y = humeralRoll * 0.5
 *   foreArmTwist.rotation.y  = handRoll    * 0.65
 *   thighTwist.rotation.y    = femoralRoll * 0.5
 *
 * where the roll is the local-Y component the parent bone was NOT given.
 * Local +Y always runs down the bone toward its child, so twist is rotation.y
 * and the primary bend is rotation.x on every limb.
 */
export const BONE_NAMES = [
  'root', 'pelvis', 'spine01', 'spine02', 'spine03', 'chest', 'neck', 'head',
  // left arm
  'clavicle_L', 'upperArm_L', 'upperArmTwist_L', 'foreArm_L', 'foreArmTwist_L', 'hand_L',
  'thumb01_L', 'thumb02_L', 'thumb03_L',
  'index01_L', 'index02_L', 'index03_L',
  'middle01_L', 'middle02_L', 'middle03_L',
  'ring01_L', 'ring02_L', 'ring03_L',
  'pinky01_L', 'pinky02_L', 'pinky03_L',
  // right arm
  'clavicle_R', 'upperArm_R', 'upperArmTwist_R', 'foreArm_R', 'foreArmTwist_R', 'hand_R',
  'thumb01_R', 'thumb02_R', 'thumb03_R',
  'index01_R', 'index02_R', 'index03_R',
  'middle01_R', 'middle02_R', 'middle03_R',
  'ring01_R', 'ring02_R', 'ring03_R',
  'pinky01_R', 'pinky02_R', 'pinky03_R',
  // legs
  'thigh_L', 'thighTwist_L', 'shin_L', 'foot_L', 'toe_L',
  'thigh_R', 'thighTwist_R', 'shin_R', 'foot_R', 'toe_R',
] as const;

export type BoneName = (typeof BONE_NAMES)[number];

/** Typed accessor so animation never does a string lookup in a hot loop. */
export type NamedBones = { readonly [K in BoneName]: THREE.Bone };

/** Name → index into `skeleton.bones`. Constant for every rig ever built. */
export const BONE_INDEX = (() => {
  const m = {} as Record<BoneName, number>;
  BONE_NAMES.forEach((n, i) => { m[n] = i; });
  return m as { readonly [K in BoneName]: number };
})();

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;
export type FingerName = (typeof FINGERS)[number];

/* ----------------------------------------------------------------- groups */

/**
 * Submesh groups, in material-array order. `mesh.material` is an array of seven
 * materials indexed by these values, and `groups` on the build result maps the
 * name to its index so a material system can write
 * `mats[rig.groups.jersey] = jerseyMaterial` without hardcoding 1.
 */
export const GROUP_NAMES = ['skin', 'jersey', 'shorts', 'socks', 'shoes', 'hair', 'eyes'] as const;
export type GroupName = (typeof GROUP_NAMES)[number];
export const GROUP = (() => {
  const m = {} as Record<GroupName, number>;
  GROUP_NAMES.forEach((n, i) => { m[n] = i; });
  return m as { readonly [K in GroupName]: number };
})();

/* ------------------------------------------------------------------ parts */

/** Written to the `aPart` vertex attribute. Lets one shader treat a forearm
 *  differently from a face without needing seven materials. */
export const PART = {
  TORSO: 0,
  NECK: 1,
  HEAD: 2,
  EAR: 3,
  EYE: 4,
  LID: 5,
  HAIR: 6,
  UPPER_ARM: 7,
  FOREARM: 8,
  HAND: 9,
  FINGER: 10,
  THIGH: 11,
  SHIN: 12,
  FOOT: 13,
  JERSEY: 14,
  SHORTS: 15,
  SOCK: 16,
  SHOE: 17,
} as const;

/* ----------------------------------------------------------------- params */

export const HAIR_STYLES = ['buzz', 'short', 'crop', 'ponytail', 'bun', 'long', 'locs'] as const;
export type HairStyle = (typeof HAIR_STYLES)[number];

/**
 * The parameter vector. Every number is either a metre value (height) or a
 * multiplier around 1.0, so a caller can nudge one field without knowing the
 * anthropometry underneath. Ultimate players are lean endurance athletes: the
 * generator's `fat` stays low and `muscle` skews toward wiry, not toward the
 * linebacker end of a football roster.
 */
export interface BodyParams {
  /** Sole to crown, metres. 1.62 – 2.03. */
  height: number;
  /** Biacromial (shoulder) breadth multiplier. 0.88 – 1.12. */
  shoulder: number;
  /** Rib-cage depth + width multiplier. 0.9 – 1.12. */
  chest: number;
  /** Waist girth multiplier. 0.86 – 1.16. */
  waist: number;
  /** Pelvis breadth multiplier. 0.9 – 1.14. */
  hip: number;
  /** Limb girth / definition. 0 wiry → 1 heavily built. */
  muscle: number;
  /** Subcutaneous softening. 0 shredded → 1 club-fit. Ultimate skews 0.1–0.45. */
  fat: number;
  /** Leg length against a fixed total height. 0.95 – 1.06. */
  legRatio: number;
  /** Arm length against a fixed total height. 0.95 – 1.06. */
  armRatio: number;
  /** Neck girth. 0.86 – 1.16. */
  neck: number;
  /** Head scale. 0.94 – 1.06. */
  headSize: number;
  /** Skeletal frame: 0 broad-shouldered / narrow-hipped, 1 the reverse.
   *  Ultimate is a mixed-gender sport at the club level and the roster should
   *  read that way. Drives shoulder:hip ratio, chest section and limb taper. */
  frame: number;
  face: FaceParams;
  hair: HairStyle;
  /** Hair volume multiplier, 0.7 – 1.35. */
  hairBulk: number;
  /** Per-player salt; materials use it for skin tone, freckles, tattoos. */
  seed: number;
}

export interface FaceParams {
  /** Mandible width. 0 narrow → 1 square. */
  jaw: number;
  /** Chin projection. 0 receding → 1 strong. */
  chin: number;
  /** Supraorbital ridge. 0 smooth → 1 heavy. */
  brow: number;
  /** Nasal projection + length. 0 – 1. */
  nose: number;
  /** Nasal breadth. 0 – 1. */
  noseW: number;
  /** Zygomatic prominence. 0 – 1. */
  cheek: number;
  /** Interocular distance. 0 close → 1 wide. */
  eyeW: number;
  /** Palpebral opening — how hooded the lids sit. 0 – 1. */
  eyeOpen: number;
  /** Lip fullness. 0 – 1. */
  lips: number;
  /** Ear size + protrusion. 0 – 1. */
  ears: number;
  /** Cranial length front-to-back. 0 – 1. */
  skull: number;
}

/** Detail knobs derived from `ctx.quality.charDetail`. */
export interface RigQuality {
  /** Multiplier on every segment count. `ctx.quality.charDetail`. */
  charDetail: number;
  /** How many LOD levels to build. 3 normally, 1 for a hero/preview build. */
  levels?: number;
}

/* ---------------------------------------------------------------- results */

export interface RigLod {
  mesh: THREE.SkinnedMesh;
  /** Screen distance at which this level takes over, metres. */
  distance: number;
  triangles: number;
}

export interface PlayerRig {
  /** Add THIS to the scene. Contains the bone hierarchy and the LOD object. */
  root: THREE.Group;
  /** Highest-detail SkinnedMesh. Also lods[0].mesh. */
  skinnedMesh: THREE.SkinnedMesh;
  lod: THREE.LOD;
  lods: RigLod[];
  skeleton: THREE.Skeleton;
  bones: NamedBones;
  /** Group name → material-array index. */
  groups: { readonly [K in GroupName]: number };
  /** The material array shared by every LOD. Replace entries in place. */
  materials: THREE.Material[];
  params: BodyParams;
  /** Derived measurements — animation needs limb lengths for IK. */
  measure: Measure;
  triangles: number;
  dispose(): void;
}

/** Bind-pose measurements, metres. Everything IK needs without re-deriving it. */
export interface Measure {
  height: number;
  hipY: number;
  kneeY: number;
  ankleY: number;
  shoulderY: number;
  eyeY: number;
  thigh: number;
  shin: number;
  foot: number;
  upperArm: number;
  foreArm: number;
  hand: number;
  shoulderHalfWidth: number;
  hipHalfWidth: number;
  /** World-space bind position of every bone, keyed by name. */
  bind: { readonly [K in BoneName]: THREE.Vector3 };
  /** World-space bind direction of each bone's local +Y. */
  axis: { readonly [K in BoneName]: THREE.Vector3 };
}
