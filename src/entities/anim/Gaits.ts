import * as THREE from 'three';
import { slerpFlat, multiplyQuaternionsFlat } from './flat.ts';
import { B, clamp, clamp01, lerp, smooth, ease, damp, spring, TAU, Kine, Pose } from './Kine.ts';
import type { LocoLike } from './Types.ts';

/**
 * ============================================================================
 *  GAITS — the body over the feet
 * ============================================================================
 *
 * The feet are pinned by `Feet.ts`; everything above the ankles happens here.
 * There are no clips. Every number below is a continuous function of the
 * simulation's state, which is the one thing generated animation can do that a
 * clip library cannot: a run at 5.8 m/s is not a run clip at 0.83 playback
 * rate, it is a shorter stride, a smaller lean, a lower cadence, a narrower arm
 * swing and less torso counter-rotation, all moving independently.
 *
 * THE FOUR DRIVERS
 *   lean       from real acceleration. tan(lean) = a/g is not a stylistic
 *              choice — a body that accelerates without leaning is a body
 *              whose ground reaction does not pass through its centre of mass,
 *              and the eye reads that instantly as "floating".
 *   bob        vertical oscillation at STEP rate (twice per stride), lowest at
 *              mid-stance where the leg is loaded, highest at mid-flight.
 *   pelvis     yaw + frontal drop at STRIDE rate. The swing-side hip rotates
 *              forward and drops; that is the whole of the "hips lead" read.
 *   counter    the chest yaws AGAINST the pelvis, lagging it by ~6% of a
 *              stride, and the arms swing against the legs. Without the phase
 *              lag the torso reads as one rigid piece pivoting at the waist.
 *
 * Arm swing is not authored on a curve. It is read back out of the leg IK:
 * `armSwing_R = k · thighFlexion_L`. The arms are therefore always exactly
 * anti-phase with the legs, they grow and shrink with the actual stride the
 * physics produced, and a stumble or a cut that breaks the leg rhythm breaks
 * the arm rhythm with it, for free.
 */

/* ------------------------------------------------------------------ tune */

const G = 9.81;
/** Reference top speed when the sim does not publish one. */
const TOP_REF = 8.5;

/* ----------------------------------------------------------------- state */

export interface BodyState {
  lean: number; leanV: number;
  side: number; sideV: number;
  crouch: number;
  /** Smoothed pelvis vertical offset, metres. */
  hipY: number;
  /** Smoothed absolute rise (airborne / prone), metres. */
  rise: number;
  /** 0..1 weight of the airborne / prone pose. */
  freeW: number;
  /** 0..1 weight of the prone (belly-down) pose. */
  proneW: number;
  /** Deterministic per-player phase offsets. */
  idlePhase: number;
  breathPhase: number;
  swayBias: number;
  /** Signed stumble direction, ±1. */
  stumbleDir: number;
  prevVX: number; prevVZ: number;
  /** Filtered world acceleration, m/s². */
  accX: number; accZ: number;
  /** Thigh flexion measured off the solved legs, radians. */
  flexL: number; flexR: number;
  /** Stride phase, left-foot referenced, 0..1. */
  strideU: number;
  speed: number;
  sp: number;
}

/** Small deterministic hash — per-player variety without touching an Rng. */
export function hash01(n: number): number {
  let x = (n | 0) * 0x9e3779b1;
  x = (x ^ (x >>> 15)) * 0x85ebca6b;
  x = (x ^ (x >>> 13)) * 0xc2b2ae35;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export function makeBody(seed: number): BodyState {
  return {
    lean: 0, leanV: 0, side: 0, sideV: 0, crouch: 0, hipY: 0, rise: 0,
    freeW: 0, proneW: 0,
    idlePhase: hash01(seed * 3 + 1) * TAU,
    breathPhase: hash01(seed * 7 + 5) * TAU,
    swayBias: (hash01(seed * 11 + 3) - 0.5) * 0.3,
    stumbleDir: hash01(seed * 13 + 9) < 0.5 ? -1 : 1,
    prevVX: 0, prevVZ: 0, accX: 0, accZ: 0,
    flexL: 0, flexR: 0, strideU: 0, speed: 0, sp: 0,
  };
}

/* --------------------------------------------------------------- scratch */

const _q = new THREE.Quaternion();

/* ----------------------------------------------------------- the drivers */

/** Update the continuous scalars. Call once, before anything is posed. */
export function updateDrivers(bs: BodyState, loco: LocoLike, dt: number): void {
  const speed = Math.hypot(loco.vel.x, loco.vel.z);
  bs.speed = speed;
  const top = Math.max(4, loco.derived?.topSpeed ?? TOP_REF);
  bs.sp = clamp01(speed / top);

  // --- acceleration, filtered ------------------------------------------------
  if (dt > 1e-5 && !loco.air.airborne) {
    const ax = (loco.vel.x - bs.prevVX) / dt;
    const az = (loco.vel.z - bs.prevVZ) / dt;
    const k = 1 - Math.exp(-11 * dt);
    bs.accX += (clamp(ax, -30, 30) - bs.accX) * k;
    bs.accZ += (clamp(az, -30, 30) - bs.accZ) * k;
  }
  bs.prevVX = loco.vel.x; bs.prevVZ = loco.vel.z;

  // --- lean: forward from drive/brake, lateral from turning ------------------
  // Decompose acceleration into the athlete's own frame. Sprinting hard forward
  // and braking hard backward are the same equation with opposite signs.
  const fx = Math.sin(loco.facing), fz = Math.cos(loco.facing);
  const along = bs.accX * fx + bs.accZ * fz;
  const lat = bs.accX * -fz + bs.accZ * fx;      // + = to the athlete's right

  let leanT = Math.atan2(along, G) + 0.085 * bs.sp;
  let sideT = -Math.atan2(lat, G);               // lean INTO the turn
  leanT += stateLeanBias(loco, bs);
  leanT = clamp(leanT, -0.26, 0.62);
  sideT = clamp(sideT, -0.42, 0.42);

  [bs.lean, bs.leanV] = spring(bs.lean, bs.leanV, leanT, 13, dt);
  [bs.side, bs.sideV] = spring(bs.side, bs.sideV, sideT, 12, dt);

  // --- crouch ----------------------------------------------------------------
  bs.crouch = damp(bs.crouch, stateCrouch(loco, bs), 14, dt);

  // --- stride phase, left-foot referenced ------------------------------------
  const f = loco.foot;
  bs.strideU = f.planted === 'L' ? f.phase * 0.5 : f.phase * 0.5 + 0.5;

  // --- free-body weight ------------------------------------------------------
  const free = loco.air.airborne || loco.prone || loco.state === 'recovery' || loco.state === 'fall';
  bs.freeW = damp(bs.freeW, free ? 1 : 0, 26, dt);
  const prone = loco.prone || loco.state === 'fall'
    || (loco.state === 'layout' && loco.air.airborne)
    || (loco.state === 'recovery');
  bs.proneW = damp(bs.proneW, prone ? 1 : 0, 11, dt);
  bs.rise = loco.pos.y - loco.groundY - loco.hipHeight;
}

/** Per-state contribution to the forward lean, radians. */
function stateLeanBias(loco: LocoLike, bs: BodyState): number {
  switch (loco.state) {
    case 'backpedal': return 0.20;               // chest over the toes
    case 'shuffle': return 0.13;
    case 'cut': return 0.10 + 0.16 * clamp01(loco.cutEntrySpeed / 8);
    case 'stumble': return 0.30;
    default: return 0;
  }
}

/** Per-state hip lowering, metres. */
function stateCrouch(loco: LocoLike, bs: BodyState): number {
  const H = 1;
  switch (loco.state) {
    case 'backpedal': return 0.055 * H;
    case 'shuffle': return 0.095 * H;
    case 'cut': return (0.045 + 0.075 * clamp01(loco.cutAngle / Math.PI)) * clamp01(loco.cutEntrySpeed / 7);
    case 'jump':
      return loco.air.airborne ? 0 : 0.20 * ease(clamp01(loco.stateT / Math.max(1e-3, loco.stateDur)));
    case 'layout':
      return loco.air.airborne ? 0 : 0.16 * ease(clamp01(loco.stateT / Math.max(1e-3, loco.stateDur)));
    case 'landing': {
      if (loco.prone) return 0;
      const k = clamp01(loco.stateT / Math.max(1e-3, loco.stateDur));
      return 0.16 * (1 - k) * (1 - k) * clamp01(0.4 + 0.6 * bs.sp);
    }
    default: return 0;
  }
}

/* ------------------------------------------------------------ the spine */

/**
 * Pelvis and spine. Writes `pose.hip` and the seven bones from pelvis to head,
 * so the caller can run FK and know where the shoulders and hips are.
 */
export function poseSpine(bs: BodyState, pose: Pose, loco: LocoLike): void {
  const sp = bs.sp;
  const u = bs.strideU;
  const moving = bs.speed >= 0.35;

  /* ---- vertical ---------------------------------------------------------- */
  // Bob runs at STEP rate — two dips per stride, lowest just after each
  // touchdown where the leg is loaded and the knee is at its most flexed.
  const bobAmp = moving ? 0.011 + 0.031 * sp : 0;
  const bob = -bobAmp * Math.cos(TAU * (loco.foot.phase - 0.22));
  let hipY = bob - bs.crouch;

  // Idle: a slow weight shift between the feet, not a metronome.
  let sway = 0;
  let pelvisRoll = 0;
  let pelvisYaw = 0;
  if (moving) {
    const swayAmp = 0.013 + 0.014 * (1 - sp);
    sway = swayAmp * Math.cos(TAU * u);
    pelvisYaw = (0.045 + 0.145 * sp) * Math.sin(TAU * u);
    // Frontal-plane pelvic drop: the swing-side hip falls a couple of degrees.
    pelvisRoll = (0.026 + 0.042 * sp) * Math.sin(TAU * u);
  } else {
    const t = loco.t * 0.52 + bs.idlePhase;
    sway = 0.030 * Math.sin(t) + 0.008 * Math.sin(t * 2.3 + 1.1);
    pelvisRoll = 0.055 * Math.sin(t);
    pelvisYaw = 0.030 * Math.sin(t * 0.71 + 0.4);
    hipY -= 0.012 + 0.006 * Math.cos(t * 1.7);
  }
  sway += bs.swayBias * 0.01;

  /* ---- free body: the sim owns the height and most of the attitude -------- */
  if (bs.freeW > 0.001) hipY = lerp(hipY, bs.rise, bs.freeW);
  bs.hipY = hipY;

  const fwdShift = bs.lean * 0.055 + (moving ? 0.012 * sp : 0);
  pose.hip.set(sway, hipY, fwdShift);

  /* ---- pelvis attitude ---------------------------------------------------- */
  // The pelvis carries a third of the lean as anterior tilt; the rest is spine.
  const pelvisPitch = bs.lean * 0.30 + bs.side * 0;
  const proneP = bs.proneW * proneAngle(loco);
  pose.setEuler(B.pelvis, pelvisPitch + proneP, pelvisYaw, pelvisRoll + bs.side * 0.30);

  /* ---- spine chain -------------------------------------------------------- */
  // Counter-rotation lags the pelvis by ~6% of a stride and overshoots it.
  const counter = moving
    ? -(0.060 + 0.165 * sp) * Math.sin(TAU * (u - 0.065))
    : -pelvisYaw * 0.5;
  const spineLean = bs.lean * 0.70;
  const spineSide = bs.side * 0.70;
  // Distribution down the chain: the thoracic spine is stiffer than the lumbar,
  // so most of the flexion happens low and most of the rotation happens high.
  const flexShare = [0.34, 0.28, 0.22, 0.16];
  const rotShare = [0.12, 0.22, 0.30, 0.36];
  const bones = [B.spine01, B.spine02, B.spine03, B.chest];
  for (let i = 0; i < 4; i++) {
    pose.setEuler(
      bones[i],
      spineLean * flexShare[i] + (bs.proneW * proneSpine(loco) * flexShare[i]),
      counter * rotShare[i],
      spineSide * flexShare[i],
    );
  }

  /* ---- neck + head baseline ---------------------------------------------- */
  // Keep the head level against the torso's lean; Secondary adds the look-at.
  const headUp = -(bs.lean * 0.55 + bs.proneW * proneSpine(loco) * 0.45);
  pose.setEuler(B.neck, headUp * 0.45, -counter * 0.35, -bs.side * 0.28);
  pose.setEuler(B.head, headUp * 0.55, -counter * 0.20, -bs.side * 0.22);

  /* ---- stumble ------------------------------------------------------------ */
  if (loco.state === 'stumble') {
    const k = clamp01(loco.stateT / Math.max(1e-3, loco.stateDur));
    const w = Math.sin(Math.PI * k) * 0.9;
    pose.addEuler(B.spine02, 0.16 * w, 0.22 * w * bs.stumbleDir, 0.24 * w * bs.stumbleDir);
    pose.addEuler(B.chest, 0.10 * w, 0.12 * w * bs.stumbleDir, 0.10 * w * bs.stumbleDir);
  }

}

/** How far the pelvis is pitched forward when the body is on its belly. */
function proneAngle(loco: LocoLike): number {
  if (loco.state === 'recovery') {
    const k = clamp01(loco.stateT / Math.max(1e-3, loco.stateDur));
    return lerp(1.30, 0.0, smooth(clamp01((k - 0.15) / 0.85)));
  }
  if (loco.state === 'layout' && loco.air.airborne) {
    const span = Math.max(0.08, loco.air.tLand - loco.air.tTakeoff);
    const k = clamp01((loco.t - loco.air.tTakeoff) / span);
    return 1.42 * ease(clamp01(k / 0.42));
  }
  return 1.34;
}

/** Extra thoracic extension (chest up) while prone — chin off the turf. */
function proneSpine(loco: LocoLike): number {
  if (loco.state === 'recovery') {
    const k = clamp01(loco.stateT / Math.max(1e-3, loco.stateDur));
    return lerp(-0.42, 0, smooth(k));
  }
  return -0.34;
}

/* ------------------------------------------------------------------ hips */

/**
 * Rig-space hip positions from the pelvis alone — a two-bone mini-FK that runs
 * before the full pass, so the hip-drop correction can be folded into
 * `pose.hip` and the whole body settles in one shot instead of the legs
 * stretching straight and then snapping.
 */
export function hipsFromPelvis(kine: Kine, pose: Pose, outL: THREE.Vector3, outR: THREE.Vector3): void {
  const o = B.pelvis;
  multiplyQuaternionsFlat(_tmp4, 0, kine.bindQ, o * 4, pose.q, o * 4);
  _q.set(_tmp4[0], _tmp4[1], _tmp4[2], _tmp4[3]);
  const px = kine.bindP[o * 3] + pose.hip.x;
  const py = kine.bindP[o * 3 + 1] + pose.hip.y;
  const pz = kine.bindP[o * 3 + 2] + pose.hip.z;
  const lo = B.thigh_L * 3, ro = B.thigh_R * 3;
  outL.set(kine.bindP[lo], kine.bindP[lo + 1], kine.bindP[lo + 2]).applyQuaternion(_q);
  outR.set(kine.bindP[ro], kine.bindP[ro + 1], kine.bindP[ro + 2]).applyQuaternion(_q);
  outL.x += px; outL.y += py; outL.z += pz;
  outR.x += px; outR.y += py; outR.z += pz;
}
const _tmp4 = new Float32Array(4);

/* ------------------------------------------------------------------ legs */

/**
 * Free-flight legs. Used whenever the feet are not pinned: a vertical leap, a
 * layout, a slide, a get-up. All FK, all driven by the sim's own arc timing —
 * `air.tTakeoff`, `air.tApex`, `air.tLand` — so a longer hang time stretches
 * the pose rather than replaying it faster.
 */
export function poseFreeLegs(bs: BodyState, pose: Pose, loco: LocoLike): void {
  const layout = loco.state === 'layout' || loco.prone
    || loco.state === 'fall' || loco.state === 'recovery';

  if (layout) {
    // Trailing, slightly scissored — one leg a touch higher than the other so
    // the silhouette is not a symmetric plank.
    const k = loco.state === 'recovery'
      ? clamp01(loco.stateT / Math.max(1e-3, loco.stateDur)) : 0;
    const tuck = smooth(clamp01((k - 0.25) / 0.55));
    for (let si = 0; si < 2; si++) {
      const s: 1 | -1 = si === 0 ? 1 : -1;
      const th = s === 1 ? B.thigh_L : B.thigh_R;
      const sh = s === 1 ? B.shin_L : B.shin_R;
      const ft = s === 1 ? B.foot_L : B.foot_R;
      const lead = s === 1 ? 1 : -1;
      // Get-up: the lead leg folds under the hips and takes the weight.
      pose.setEuler(th, lerp(-0.22 + 0.10 * lead, lead > 0 ? 1.15 : -0.10, tuck), 0.06 * s, 0.10 * s);
      pose.setBend(sh, lerp(-0.34 - 0.16 * lead, lead > 0 ? -1.55 : -0.55, tuck));
      pose.setBend(ft, lerp(-0.45, -0.05, tuck));
    }
    return;
  }

  // A vertical leap: gather → extend at takeoff → tuck through the apex →
  // reach for the ground on the way down.
  const span = Math.max(0.10, loco.air.tLand - loco.air.tTakeoff);
  const k = clamp01((loco.t - loco.air.tTakeoff) / span);
  const rise = clamp01((loco.air.tApex - loco.t) / Math.max(0.05, loco.air.tApex - loco.air.tTakeoff));
  const tuck = Math.sin(Math.PI * clamp01(k * 1.15)) * (0.55 + 0.35 * bs.sp);
  const drop = smooth(clamp01((k - 0.62) / 0.38));
  for (let si = 0; si < 2; si++) {
    const s: 1 | -1 = si === 0 ? 1 : -1;
    const th = s === 1 ? B.thigh_L : B.thigh_R;
    const sh = s === 1 ? B.shin_L : B.shin_R;
    const ft = s === 1 ? B.foot_L : B.foot_R;
    const split = s === 1 ? 1 : -0.55;          // one knee leads the leap
    pose.setEuler(th, 0.32 * tuck * split + 0.16 * drop, 0.04 * s, 0.07 * s);
    pose.setBend(sh, -(0.30 + 0.75 * tuck) * Math.abs(split) - 0.18 * drop);
    pose.setBend(ft, lerp(-0.42 * (1 - rise), 0.24, drop));
  }
}

/**
 * Measure what the leg IK actually produced. Read back rather than assumed:
 * the arms and the torso are driven off this, so a cut, a stumble or a
 * hip-drop correction propagates into the upper body without a special case.
 */
export function measureLegs(bs: BodyState, kine: Kine): void {
  bs.flexL = thighFlex(kine, B.thigh_L, B.shin_L);
  bs.flexR = thighFlex(kine, B.thigh_R, B.shin_R);
}

function thighFlex(kine: Kine, hipB: number, kneeB: number): number {
  const h = hipB * 3, k = kneeB * 3;
  const dy = kine.wp[k + 1] - kine.wp[h + 1];
  const dz = kine.wp[k + 2] - kine.wp[h + 2];
  return Math.atan2(dz, -dy);
}

/* ------------------------------------------------------------------ arms */

export interface ArmTune {
  /** Extra elbow flexion, radians. Rises with speed and with a tight gait. */
  elbow: number;
  /** Adduction — how close to the ribs the upper arms are held. */
  adduct: number;
  /** Multiplier on the swing amplitude read off the legs. */
  swing: number;
  /** Static shoulder raise (defensive arms-out, marking). */
  raise: number;
}

const RUN_TUNE: ArmTune = { elbow: 0, adduct: 0, swing: 1, raise: 0 };

/**
 * Arm swing, counter-phase to the legs by construction. `side` is +1 for the
 * left arm; a positive `x` delta swings any arm forward (the rig binds every
 * limb with local +Z anatomically forward, so the sign is the same on both).
 */
export function poseArms(bs: BodyState, pose: Pose, loco: LocoLike): void {
  const sp = bs.sp;
  const t = armTuneFor(loco, bs);
  const k = (0.40 + 0.34 * sp) * t.swing;
  // Elbow carriage is a function of GROUND SPEED, not of speed-as-a-fraction-
  // of-top-speed, and it saturates: a jogger and a sprinter both run with the
  // elbow near a right angle, and what actually grows with pace is the swing
  // amplitude, which is read off the legs below. Scaling it linearly with `sp`
  // left everyone below a sprint running with near-straight arms.
  const carriage = smooth(clamp01(bs.speed / 3.2));
  const elbowBase = 0.26 + 1.06 * carriage + t.elbow;
  const adductBase = 0.34 + 0.16 * sp + t.adduct;

  for (let si = 0; si < 2; si++) {
    const s: 1 | -1 = si === 0 ? 1 : -1;
    const ua = s === 1 ? B.upperArm_L : B.upperArm_R;
    const fa = s === 1 ? B.foreArm_L : B.foreArm_R;
    const hd = s === 1 ? B.hand_L : B.hand_R;
    const uaT = s === 1 ? B.upperArmTwist_L : B.upperArmTwist_R;
    const faT = s === 1 ? B.foreArmTwist_L : B.foreArmTwist_R;
    const cl = s === 1 ? B.clavicle_L : B.clavicle_R;

    // Anti-phase: the LEFT arm answers the RIGHT thigh.
    const opp = s === 1 ? bs.flexR : bs.flexL;
    const swing = k * opp;
    // The elbow closes on the forward swing and opens on the back swing —
    // a constant elbow angle is the tell that the arms are on a sine curve.
    const elbow = clamp(elbowBase + 0.55 * Math.max(0, swing) - 0.28 * Math.max(0, -swing), 0.12, 2.3);
    const adduct = adductBase - 0.10 * Math.max(0, swing);

    pose.setEuler(ua, swing + t.raise, -0.10 * s * sp, -(adduct) * s);
    pose.setBend(fa, elbow);
    // Humeral and forearm roll: the palms turn in on the forward swing.
    pose.setTwist(uaT, -0.22 * s * sp * 0.5);
    pose.setTwist(faT, (0.30 + 0.35 * sp) * s * 0.65);
    pose.setEuler(hd, -0.10 - 0.14 * Math.max(0, swing), 0.30 * s, 0.06 * s);
    // The shoulder girdle rides the counter-rotation, and shrugs a little at
    // speed — a runner's traps are not relaxed.
    pose.setEuler(cl, -0.02 - 0.05 * sp, -0.06 * s * sp, 0.05 * sp * s);
  }

  if (loco.state === 'stumble') {
    const p = clamp01(loco.stateT / Math.max(1e-3, loco.stateDur));
    const w = Math.sin(Math.PI * p);
    const hi = bs.stumbleDir > 0 ? B.upperArm_L : B.upperArm_R;
    const lo = bs.stumbleDir > 0 ? B.upperArm_R : B.upperArm_L;
    pose.addEuler(hi, 1.35 * w, 0, -0.55 * w);
    pose.addEuler(lo, -0.45 * w, 0, 0.35 * w);
  }
}

function armTuneFor(loco: LocoLike, bs: BodyState): ArmTune {
  switch (loco.state) {
    case 'backpedal':
      // Short, tight, low — a defender's arms never cross the midline.
      return { elbow: 0.55, adduct: 0.10, swing: 0.55, raise: 0.10 };
    case 'shuffle':
      // Wide and low, hands ready.
      return { elbow: 0.75, adduct: -0.55, swing: 0.22, raise: 0.16 };
    case 'cut': {
      // The inside arm sweeps across the body; the outside arm counterbalances.
      const w = clamp01(loco.cutAngle / Math.PI) * clamp01(loco.cutEntrySpeed / 6);
      return { elbow: 0.30 * w, adduct: -0.18 * w, swing: 1.25, raise: 0.24 * w };
    }
    case 'jump':
    case 'layout':
      return { elbow: -0.15, adduct: -0.05, swing: 0.6, raise: 0 };
    case 'landing':
      return { elbow: 0.20, adduct: -0.30, swing: 0.4, raise: 0.20 };
    default:
      // Standing: the carriage term is already near zero at this speed, so the
      // arms hang. Adding elbow here on top of it is what produced the
      // permanently-flexed mannequin idle.
      if (bs.speed < 0.35) return { elbow: 0, adduct: 0.05, swing: 0, raise: 0 };
      return RUN_TUNE;
  }
}

/**
 * Airborne and prone arms. A layout is the shot the whole game is sold on, so
 * this is the one pose with hand-placed numbers rather than a formula: both
 * arms driven forward along the body's long axis, elbows almost locked, and
 * the trailing arm a few degrees lower so the silhouette has a read.
 */
export function poseFreeArms(bs: BodyState, pose: Pose, loco: LocoLike, reachSide: 1 | -1 | 0): void {
  const recovering = loco.state === 'recovery';
  const k = recovering ? clamp01(loco.stateT / Math.max(1e-3, loco.stateDur)) : 0;
  const push = smooth(clamp01((k - 0.05) / 0.45));

  for (let si = 0; si < 2; si++) {
    const s: 1 | -1 = si === 0 ? 1 : -1;
    const ua = s === 1 ? B.upperArm_L : B.upperArm_R;
    const fa = s === 1 ? B.foreArm_L : B.foreArm_R;
    const hd = s === 1 ? B.hand_L : B.hand_R;
    const faT = s === 1 ? B.foreArmTwist_L : B.foreArmTwist_R;
    const lead = reachSide === 0 || reachSide === s;

    if (recovering) {
      // Hands under the shoulders, press up, then swing through to stand.
      pose.setEuler(ua, lerp(1.75, 0.15, push), 0, -(0.55 - 0.25 * push) * s);
      pose.setBend(fa, lerp(1.45, 0.35, push));
      pose.setEuler(hd, lerp(0.85, -0.10, push), 0.25 * s, 0);
      pose.setTwist(faT, 0.55 * s);
      continue;
    }

    const extend = lead ? 1 : 0.82;
    pose.setEuler(ua, 2.36 * extend, -0.08 * s, -(0.30 + (lead ? 0 : 0.14)) * s);
    pose.setBend(fa, lead ? 0.14 : 0.34);
    pose.setEuler(hd, -0.22, 0.18 * s, 0);
    pose.setTwist(faT, 0.42 * s);
  }
  void bs;
}
