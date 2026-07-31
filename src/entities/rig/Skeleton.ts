import * as THREE from 'three';
import { BONE_NAMES, BONE_INDEX, FINGERS } from './Types.ts';
import type { BodyParams, BoneName, NamedBones, Measure } from './Types.ts';
import { V, frameQuat, lerp } from './Build.ts';
import type { Vec3 } from './Build.ts';

/**
 * Anthropometry → 60-bone skeleton.
 *
 * ============================================================================
 *  THE TABLE. Every landmark below is a fraction of standing height H, taken
 *  from adult tables (ISO 7250 / NASA-STD-3000 / Drillis-Contini), not tuned by
 *  eye. If a number here changes, it changes because the table says so.
 * ============================================================================
 *
 *   vertex (crown)          1.000 H      menton (chin)          0.870 H
 *   head height             0.130 H      → 7.7 heads tall, which is where a
 *                                          lean endurance athlete actually sits
 *   eye line                0.935 H      = chin + 0.50 head heights
 *   cervicale (C7)          0.822 H      acromion               0.818 H
 *   glenohumeral centre     0.803 H      hip joint              0.530 H
 *   knee joint              0.282 H      sphyrion (ankle)       0.0395 H
 *   biacromial breadth      0.2214 H     bideltoid breadth      0.2640 H
 *   head breadth            0.0850 H     head length            0.1075 H
 *   neck breadth            0.0636 H
 *   upper arm 0.186 H  forearm 0.146 H  hand 0.108 H   (forearm < upper arm)
 *   thigh     0.248 H  shin    0.2425 H                (shin  < thigh)
 *
 * The two ratios a critic actually reads at a glance:
 *   • half the shoulder span is 1.55 head-breadths (0.132 H vs 0.085 H)
 *   • the head is 7.7 of its own heights below the crown
 * Both are asserted numerically by the proportion probe rather than eyeballed.
 *
 * The parameter vector perturbs ratios, never the total height, so
 * `params.height` is always the number the frame measures.
 *
 * BIND POSE is a 46-degree A-pose with a 9-degree elbow pre-bend and a 4-degree
 * knee pre-bend. Neither joint is straight at bind: a perfectly extended limb
 * gives the solver a singular direction and gives the skin no cue about which
 * way the joint is allowed to fold, and both show up immediately as a knee that
 * hyper-extends backwards on the first stride.
 */

export const SIDES = [1, -1] as const;
/** 0 → left (+x), 1 → right (−x). */
export const SIDE_SUFFIX = ['_L', '_R'] as const;

export interface Anthro {
  p: BodyParams;
  H: number;
  ankleY: number; kneeY: number; hipY: number;
  waistY: number; chestY: number; neckBaseY: number;
  shoulderY: number; acromionY: number;
  /** Half the biacromial breadth — the bony point of the shoulder. The deltoid
   *  dome and the trapezius both aim at THIS, not at the joint centre, which is
   *  ~2.7 cm inboard and below it. Conflating the two is what leaves a notch
   *  between the trapezius and the deltoid for a sleeve to bridge with a plate. */
  acromionHalf: number;
  chinY: number; crownY: number; headPivotY: number; eyeY: number;
  torsoSpan: number;
  /** pelvis, spine01, spine02, spine03, chest, neckBase, headPivot */
  spine: Vec3[];
  /** Per side (0 = L). */
  clav: Vec3[]; shoulder: Vec3[]; elbow: Vec3[]; wrist: Vec3[]; handEnd: Vec3[];
  hip: Vec3[]; knee: Vec3[]; ankle: Vec3[]; ball: Vec3[]; toeTip: Vec3[];
  armDir: Vec3[]; foreDir: Vec3[]; handDir: Vec3[];
  legDir: Vec3[]; shinDir: Vec3[];
  /** Palm-facing (volar) unit vector per side — the fingers' local +Z. */
  volar: Vec3[];
  len: {
    upperArm: number; foreArm: number; hand: number;
    thigh: number; shin: number; foot: number; toe: number; neck: number;
  };
  /** Cross-section half-sizes, metres. a = lateral, b = anteroposterior. */
  g: {
    neckA: number; neckB: number;
    chestA: number; chestB: number;
    waistA: number; waistB: number;
    hipA: number; hipB: number;
    deltoid: number;
    bicep: number; elbowR: number; foreMax: number; wristA: number; wristB: number;
    thighA: number; thighB: number; kneeR: number; calfA: number; calfB: number;
    ankleA: number; ankleB: number;
    handW: number; handT: number;
    headR: number; headH: number;
  };
}

const CLAMP = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function measureBody(p: BodyParams): Anthro {
  const H = p.height;
  const legF = p.legRatio;
  const armF = p.armRatio;
  const mus = CLAMP(p.muscle, 0, 1);
  const fat = CLAMP(p.fat, 0, 1);
  const fr = CLAMP(p.frame, 0, 1);
  // Girth scalar: muscle adds contractile volume, fat adds an even shell.
  const gm = 0.885 + 0.215 * mus + 0.13 * fat;

  const ankleY = 0.0395 * H;
  const hipY = 0.530 * H * legF;
  // Knee joint at 0.282 H. The old 0.487 split put it at 0.278 H and made the
  // shin 5 % longer than the thigh; the table has the thigh slightly the longer
  // of the two and a figure reads wrong the moment that inverts.
  const kneeY = ankleY + (hipY - ankleY) * 0.494;
  const neckBaseY = 0.822 * H;
  // Glenohumeral centre, NOT the acromion: the joint the humerus rotates about
  // sits ~1.5 % H below and ~7 % inboard of the bony shoulder point.
  const shoulderY = 0.803 * H;
  const acromionY = 0.818 * H;
  const headH = 0.130 * H * p.headSize;
  const crownY = H;
  const chinY = crownY - headH;
  // Atlanto-occipital joint — level with the ear canal, which is 0.36 of the
  // way up the head from the chin. At 0.30 the head pivoted through its own
  // jaw and a nod slid the chin sideways.
  const headPivotY = chinY + headH * 0.36;
  // Eye line at half the head's height. The sculpt in Head.ts puts the globes
  // at ny = 0, i.e. exactly the head centre, so anything but 0.50 here hands
  // the camera director and the gaze solver a landmark the mesh does not have.
  const eyeY = chinY + headH * 0.505;
  const torsoSpan = neckBaseY - hipY;
  const waistY = hipY + torsoSpan * 0.30;
  const chestY = hipY + torsoSpan * 0.72;

  // Vertebral column sits behind the body's mid-line and carries a gentle S.
  const spine: Vec3[] = [
    V(0, hipY, -0.012 * H),
    V(0, hipY + torsoSpan * 0.20, -0.004 * H),
    V(0, hipY + torsoSpan * 0.42, -0.014 * H),
    V(0, hipY + torsoSpan * 0.64, -0.026 * H),
    V(0, hipY + torsoSpan * 0.84, -0.030 * H),
    V(0, neckBaseY, -0.024 * H),
    V(0, headPivotY, -0.006 * H),
  ];

  // Biacromial breadth 0.2214 H (0.399 m at 1.80). The previous 0.108 H
  // half-width gave 0.2117 H — narrow shoulders on a wide head, which is the
  // single loudest juvenile cue a figure can send.
  const acromionHalf = 0.1125 * H * p.shoulder * (1 - 0.075 * fr) * (0.99 + 0.03 * mus);
  const shoulderHalf = acromionHalf * 0.925;
  const hipHalf = 0.0485 * H * p.hip * (1 + 0.075 * fr);

  const upperArm = 0.186 * H * armF;
  const foreArm = 0.146 * H * armF;
  const handLen = 0.108 * H * armF;

  const a1 = 0.803;                 // 46 deg from vertical
  const a2 = a1 * 0.955;
  const clav: Vec3[] = [], shoulder: Vec3[] = [], elbow: Vec3[] = [], wrist: Vec3[] = [],
    handEnd: Vec3[] = [], armDir: Vec3[] = [], foreDir: Vec3[] = [], handDir: Vec3[] = [],
    volar: Vec3[] = [];
  for (const s of SIDES) {
    clav.push(V(s * 0.020 * H, acromionY - 0.026 * H, 0.028 * H));
    const sh = V(s * shoulderHalf, shoulderY, 0.005 * H);
    shoulder.push(sh);
    const d1 = V(s * Math.sin(a1), -Math.cos(a1), 0.048).normalize();
    const el = sh.clone().addScaledVector(d1, upperArm);
    const d2 = V(s * Math.sin(a2), -Math.cos(a2), 0.185).normalize();
    const wr = el.clone().addScaledVector(d2, foreArm);
    const d3 = V(s * Math.sin(a2) * 0.90, -Math.cos(a2), 0.230).normalize();
    armDir.push(d1); foreDir.push(d2); handDir.push(d3);
    elbow.push(el); wrist.push(wr);
    handEnd.push(wr.clone().addScaledVector(d3, handLen));
    // Palm faces the body's midline in an A-pose, tipped slightly rearward.
    volar.push(V(-s * 0.94, 0, -0.34).normalize());
  }

  const hip: Vec3[] = [], knee: Vec3[] = [], ankle: Vec3[] = [], ball: Vec3[] = [],
    toeTip: Vec3[] = [], legDir: Vec3[] = [], shinDir: Vec3[] = [];
  for (const s of SIDES) {
    // Femurs converge: knee separation is ~0.63 of the hip-joint separation and
    // the malleoli ~0.57. At 0.82/0.76 the legs ran almost parallel, which puts
    // an adult in a toddler's stance and forces the shorts' leg tubes apart.
    const hp = V(s * hipHalf, hipY, 0.004 * H);
    const kn = V(s * hipHalf * 0.72, kneeY, 0.013 * H);
    const an = V(s * hipHalf * 0.64, ankleY, -0.020 * H);
    hip.push(hp); knee.push(kn); ankle.push(an);
    ball.push(V(s * hipHalf * 0.66, 0.021 * H, 0.055 * H));
    toeTip.push(V(s * hipHalf * 0.61, 0.013 * H, 0.105 * H));
    legDir.push(kn.clone().sub(hp).normalize());
    shinDir.push(an.clone().sub(kn).normalize());
  }

  // Half-sizes, metres. `A` is the medio-lateral axis, `B` the anteroposterior
  // one — the distinction matters: a wrist is 55 mm across and 35 mm deep, and
  // a circular wrist is one of the loudest "generated" tells on a throwing arm.
  const g = {
    neckA: 0.0318 * H * p.neck * (1 - 0.10 * fr),
    neckB: 0.0342 * H * p.neck * (1 - 0.08 * fr),
    chestA: 0.0870 * H * p.chest * (0.97 + 0.06 * mus),
    chestB: 0.0605 * H * p.chest * (0.96 + 0.10 * fat + 0.05 * fr),
    waistA: 0.0685 * H * p.waist * (0.95 + 0.16 * fat),
    waistB: 0.0505 * H * p.waist * (0.93 + 0.24 * fat),
    hipA: 0.0900 * H * p.hip * (1 + 0.06 * fr),
    hipB: 0.0620 * H * p.hip * (0.97 + 0.10 * fat),
    // Deltoid radius is DERIVED, not chosen: bideltoid 0.2640 H minus the
    // glenohumeral half-width leaves exactly this much soft tissue outboard of
    // the joint. At 0.0333 H the shoulder measured 0.30 H across — a linebacker
    // in a lean endurance sport, and a ball the sleeve had to be inflated to
    // clear.
    deltoid: CLAMP(0.1320 * H * p.shoulder - shoulderHalf, 0.021 * H, 0.036 * H)
      * (0.90 + 0.16 * mus + 0.06 * fat),
    bicep: 0.0274 * H * gm * (1 - 0.06 * fr),
    elbowR: 0.0225 * H * (0.94 + 0.12 * mus),
    foreMax: 0.0247 * H * gm * (1 - 0.05 * fr),
    wristA: 0.0152 * H * (0.95 + 0.10 * mus) * (1 - 0.07 * fr),
    wristB: 0.0110 * H * (0.95 + 0.10 * mus) * (1 - 0.07 * fr),
    thighA: 0.0490 * H * gm * (1 + 0.05 * fr),
    thighB: 0.0515 * H * gm,
    kneeR: 0.0328 * H * (0.95 + 0.10 * mus),
    calfA: 0.0300 * H * gm,
    calfB: 0.0325 * H * gm,
    ankleA: 0.0195 * H * (0.95 + 0.08 * mus),
    ankleB: 0.0180 * H * (0.95 + 0.08 * mus),
    handW: 0.0242 * H * armF,
    handT: 0.0078 * H * armF * (0.95 + 0.12 * mus),
    // Head BREADTH 0.0850 H (0.153 m at 1.80) and, through the same radius,
    // length 0.1075 H — a cephalic index of 0.79, which is an adult skull. At
    // 0.0475 H the head measured 0.0909 H across: 8 % over the table, and 8 %
    // on a head is the whole difference between an athlete and an action figure.
    headR: 0.0445 * H * p.headSize,
    headH,
  };

  return {
    p, H, ankleY, kneeY, hipY, waistY, chestY, neckBaseY, shoulderY, acromionY, acromionHalf,
    chinY, crownY, headPivotY, eyeY, torsoSpan, spine,
    clav, shoulder, elbow, wrist, handEnd, hip, knee, ankle, ball, toeTip,
    armDir, foreDir, handDir, legDir, shinDir, volar,
    len: {
      upperArm, foreArm, hand: handLen,
      thigh: hipY - kneeY, shin: kneeY - ankleY,
      foot: 0.075 * H, toe: 0.050 * H, neck: headPivotY - neckBaseY,
    },
    g,
  };
}

/* --------------------------------------------------------------- assembly */

interface Spec {
  name: BoneName;
  parent: BoneName | null;
  pos: Vec3;
  /** Direction of local +Y (toward the child). */
  dir: Vec3;
  /** Reference for local +Z. */
  fwd: Vec3;
}

const UP = V(0, 1, 0);
const FWD = V(0, 0, 1);

/**
 * Finger layout. `FINGER_SPREAD` is measured from the palm's centre line toward
 * the THUMB side (positive = thumb side); it is multiplied by −side so the same
 * table builds a left and a right hand. `PHALANX` splits a digit's length into
 * proximal / middle / distal.
 */
export const FINGER_SPREAD = [0, 0.30, 0.10, -0.10, -0.30];
export const FINGER_LEN = [0.62, 1.00, 1.08, 0.99, 0.76];
export const PHALANX = [0.45, 0.31, 0.24];

export interface SkeletonResult {
  skeleton: THREE.Skeleton;
  bones: NamedBones;
  rootBone: THREE.Bone;
  measure: Measure;
}

export function buildSkeleton(a: Anthro): SkeletonResult {
  const specs = new Map<BoneName, Spec>();
  const add = (name: BoneName, parent: BoneName | null, pos: Vec3, dir: Vec3, fwd: Vec3) => {
    specs.set(name, { name, parent, pos, dir: dir.clone().normalize(), fwd });
  };

  const S = a.spine;
  add('root', null, V(0, 0, 0), UP, FWD);
  add('pelvis', 'root', S[0], S[1].clone().sub(S[0]), FWD);
  add('spine01', 'pelvis', S[1], S[2].clone().sub(S[1]), FWD);
  add('spine02', 'spine01', S[2], S[3].clone().sub(S[2]), FWD);
  add('spine03', 'spine02', S[3], S[4].clone().sub(S[3]), FWD);
  add('chest', 'spine03', S[4], S[5].clone().sub(S[4]), FWD);
  add('neck', 'chest', S[5], S[6].clone().sub(S[5]), FWD);
  add('head', 'neck', S[6], V(0, 1, 0.06), FWD);

  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];
    const suf = SIDE_SUFFIX[si];
    const n = <T extends string>(b: T) => `${b}${suf}` as BoneName;
    const sh = a.shoulder[si], el = a.elbow[si], wr = a.wrist[si];
    add(n('clavicle'), 'chest', a.clav[si], sh.clone().sub(a.clav[si]), FWD);
    add(n('upperArm'), n('clavicle'), sh, a.armDir[si], FWD);
    add(n('upperArmTwist'), n('upperArm'), sh.clone().addScaledVector(a.armDir[si], a.len.upperArm * 0.55), a.armDir[si], FWD);
    add(n('foreArm'), n('upperArm'), el, a.foreDir[si], FWD);
    add(n('foreArmTwist'), n('foreArm'), el.clone().addScaledVector(a.foreDir[si], a.len.foreArm * 0.60), a.foreDir[si], FWD);
    // Hand and fingers use the PALM as local +Z, so flexion is +rotation.x on
    // every joint of every digit. Without that convention a claw catch is a
    // sign-hunting exercise for whoever writes the pose.
    const vol = a.volar[si];
    add(n('hand'), n('foreArm'), wr, a.handDir[si], vol);

    // Palm frame.
    const yh = a.handDir[si].clone();
    const zh = vol.clone().addScaledVector(yh, -vol.dot(yh)).normalize();
    const xh = new THREE.Vector3().crossVectors(yh, zh);
    const palmLen = a.len.hand * 0.46;
    for (let f = 0; f < 5; f++) {
      const fam = FINGERS[f];
      const spread = -s * FINGER_SPREAD[f] * a.g.handW * 1.55;
      const digitLen = a.len.hand * 0.54 * FINGER_LEN[f];
      let base: Vec3;
      let dir: Vec3;
      if (f === 0) {
        // Thumb leaves the palm early, off the radial edge, rotated out of plane.
        base = wr.clone()
          .addScaledVector(yh, palmLen * 0.30)
          .addScaledVector(xh, -s * a.g.handW * 0.86)
          .addScaledVector(zh, a.g.handT * 0.55);
        dir = yh.clone().multiplyScalar(0.68)
          .addScaledVector(xh, -s * 0.58)
          .addScaledVector(zh, 0.44).normalize();
      } else {
        base = wr.clone()
          .addScaledVector(yh, palmLen)
          .addScaledVector(xh, spread)
          .addScaledVector(zh, -a.g.handT * 0.12);
        dir = yh.clone().addScaledVector(xh, spread * 0.55 / Math.max(1e-4, digitLen)).normalize();
      }
      let cur = base;
      for (let j = 0; j < 3; j++) {
        const bn = `${fam}0${j + 1}${suf}` as BoneName;
        const parent = j === 0 ? n('hand') : (`${fam}0${j}${suf}` as BoneName);
        add(bn, parent, cur, dir, zh);
        cur = cur.clone().addScaledVector(dir, digitLen * PHALANX[j]);
      }
    }

    // Legs. Foot bones take world-up as their +Z reference, so ankle
    // dorsiflexion and toe-off are both +rotation.x.
    add(n('thigh'), 'pelvis', a.hip[si], a.legDir[si], FWD);
    add(n('thighTwist'), n('thigh'), a.hip[si].clone().addScaledVector(a.legDir[si], a.len.thigh * 0.55), a.legDir[si], FWD);
    add(n('shin'), n('thigh'), a.knee[si], a.shinDir[si], FWD);
    add(n('foot'), n('shin'), a.ankle[si], a.ball[si].clone().sub(a.ankle[si]), UP);
    add(n('toe'), n('foot'), a.ball[si], a.toeTip[si].clone().sub(a.ball[si]), UP);
  }

  // World transforms → local transforms.
  const worldQ = new Map<BoneName, THREE.Quaternion>();
  const worldP = new Map<BoneName, Vec3>();
  const bones: THREE.Bone[] = [];
  const byName = {} as Record<BoneName, THREE.Bone>;

  for (const name of BONE_NAMES) {
    const sp = specs.get(name);
    if (!sp) throw new Error(`PlayerRig: no spec for bone "${name}"`);
    const q = frameQuat(sp.dir, sp.fwd);
    worldQ.set(name, q);
    worldP.set(name, sp.pos);
    const b = new THREE.Bone();
    b.name = name;
    byName[name] = b;
    bones.push(b);
  }
  for (const name of BONE_NAMES) {
    const sp = specs.get(name)!;
    const b = byName[name];
    if (!sp.parent) {
      b.position.copy(sp.pos);
      b.quaternion.copy(worldQ.get(name)!);
      continue;
    }
    const pq = worldQ.get(sp.parent)!;
    const inv = pq.clone().invert();
    b.position.copy(sp.pos).sub(worldP.get(sp.parent)!).applyQuaternion(inv);
    b.quaternion.copy(inv).multiply(worldQ.get(name)!);
    byName[sp.parent].add(b);
  }

  const rootBone = byName.root;
  rootBone.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  const bind = {} as Record<BoneName, Vec3>;
  const axis = {} as Record<BoneName, Vec3>;
  for (const name of BONE_NAMES) {
    bind[name] = worldP.get(name)!.clone();
    axis[name] = V(0, 1, 0).applyQuaternion(worldQ.get(name)!);
  }

  const measure: Measure = {
    height: a.H, hipY: a.hipY, kneeY: a.kneeY, ankleY: a.ankleY,
    shoulderY: a.shoulderY, eyeY: a.eyeY,
    thigh: a.len.thigh, shin: a.len.shin, foot: a.len.foot,
    upperArm: a.len.upperArm, foreArm: a.len.foreArm, hand: a.len.hand,
    shoulderHalfWidth: Math.abs(a.shoulder[0].x),
    hipHalfWidth: Math.abs(a.hip[0].x),
    bind, axis,
  };

  return { skeleton, bones: byName as NamedBones, rootBone, measure };
}

/** Convenience for the mesh builders — index of a bone by name. */
export const bi = (n: BoneName): number => BONE_INDEX[n];

/** Interpolated point on the spine, u in [0,1] from pelvis to neck base. */
export function spineAt(a: Anthro, u: number): Vec3 {
  const seg = a.spine.slice(0, 6);
  const t = CLAMP(u, 0, 1) * (seg.length - 1);
  const i = Math.min(seg.length - 2, Math.floor(t));
  const f = t - i;
  return V(
    lerp(seg[i].x, seg[i + 1].x, f),
    lerp(seg[i].y, seg[i + 1].y, f),
    lerp(seg[i].z, seg[i + 1].z, f),
  );
}
