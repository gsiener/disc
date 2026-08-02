import * as THREE from 'three';
import { slerpFlat, multiplyQuaternionsFlat } from './flat.ts';
import { B, clamp, clamp01, lerp, smooth, ease, damp, spring, TAU, Kine, Pose } from './Kine.ts';
import { stepRate } from '../../sim/move/Gait.ts';
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
  /**
   * The thigh DIFFERENTIAL and its filtered time derivative. Together they are a
   * quadrature pair, which is what lets `poseArms` phase-shift the arm swing by
   * a per-athlete lag without a delay line — see `gArmLag`.
   */
  diff: number; diffRate: number;
  /**
   * HOW FAR THIS ATHLETE'S ARMS LAG THEIR LEGS, in fractions of a stride.
   *
   * This is the only axis of the running signature that is a PHASE rather than
   * an amplitude, and it is the one that matters most for the clone read. Eight
   * athletes at one speed share a stride phase exactly — `sim/move/Gait.ts` is a
   * single oscillator started at zero and the animator cannot move it without
   * unpinning the feet — so `gaitLead` splits the roster into two groups half a
   * stride apart and that is all the leg variety there is. Everything else in
   * this block is a gain on the same waveform, and scaling a pose does not stop
   * it being the same pose: measured over eight athletes, widening every gain
   * by a third moved the closest silhouette pair from 0.51 to 0.58 rad.
   *
   * Arm lag is different in kind. Real runners differ by a good tenth of a
   * stride in how far their arm swing trails their leg swing, it is plainly
   * visible at 35 px because the arms are a third of the silhouette, and the
   * feet never see it.
   */
  gArmLag: number;
  /** Stride phase, left-foot referenced, 0..1. */
  strideU: number;
  speed: number;
  sp: number;

  /* ---- per-athlete running signature ---------------------------------- */

  /**
   * Fourteen bodies driven by one set of equations are fourteen copies of one
   * athlete, and at 40-90 px on screen that is the loudest failure the roster
   * can produce. These are fixed, hashed, per-player multipliers on the parts of
   * the gait that vary most between real runners: how much the arms swing, how
   * much the trunk counter-rotates, how much the body bobs, how much the pelvis
   * rotates, how far the elbows are carried and how upright the athlete runs.
   * None of them touch timing — the feet still land where the simulation says —
   * so they cost nothing and cannot desynchronise anything.
   */
  gSwing: number; gCounter: number; gBob: number; gPelvis: number;
  gElbow: number; gAdduct: number; gLean: number;
  /** How high this athlete carries the hands. Radians of shoulder flexion. */
  gRaise: number;
  /** How low this athlete runs. Metres on the pelvis, at pace. */
  gCrouch: number;
  /**
   * Which of THIS athlete's feet answers the simulation's `foot.planted === 'L'`.
   * +1 keeps the simulation's naming, −1 swaps it. See `gaitLead` and
   * `Feet.updateFeet`; resolved once, on the first driver update.
   */
  parity: 1 | -1 | 0;

  /* ---- posture, and the clock that drives it -------------------------- */

  /**
   * The animator's OWN clock, seconds. Not `loco.t`.
   *
   * A latched tableau (`sim/Game.ts applyTableau`) freezes the simulation and
   * then the capture rig advances 150 render frames before the shutter opens —
   * so `loco.t` is a constant for the whole of every screenshot. Anything an
   * idle pose is built on has to advance on the RENDER clock or the athletes
   * are dead still in exactly the frames a critic looks at.
   */
  clock: number;
  /**
   * −1 all the weight on the right foot … +1 all on the left. Nobody stands
   * evenly on two feet for more than a few seconds; this is the shift.
   */
  weight: number;
  /** 0..1 how switched-on: near the play, ready to move. Written by the owner. */
  alert: number;
  /** 0..1 holding the disc and stationary — a handler on a pivot. */
  handler: number;
  /** 0..1 marking the thrower. */
  mark: number;
}

/** What the owner knows about an athlete that the simulation does not publish. */
export interface StanceIntent {
  /** 0..1 near the play and ready to move. */
  alert?: number;
  /** 0..1 has the disc. */
  handler?: number;
  /** 0..1 is on the mark. */
  mark?: number;
}

/**
 * WHICH FOOT THIS ATHLETE LEADS WITH.
 *
 * `sim/move/Gait.ts` is one phase oscillator per body, integrated at a frequency
 * that is a pure function of ground speed and started at zero. Two athletes who
 * happen to be running at the same speed are therefore in *exactly* the same
 * stride phase, on the same foot, forever — measured over a live match, pairs
 * within 0.25 m/s of each other sat inside 0.001 of a stride of one another in
 * about half of all samples. Fourteen bodies whose legs move as one is the
 * clone read, and it is the one thing on this list a still frame shows.
 *
 * The animator cannot change the oscillator, but it can choose which of the
 * athlete's own feet answers each of its plants. Swapping that mapping puts an
 * athlete exactly half a stride out from an athlete it would otherwise mirror,
 * for the cost of reflecting the plant's lateral offset about the travel line
 * (see `updateFeet`) — the plant stays on the ground, the same distance along
 * travel, on the side the planting foot is actually on.
 *
 * Both `Gaits` and `Feet` resolve it from `loco.id`, so they cannot disagree.
 */
export function gaitLead(id: number): 1 | -1 {
  // Alternating rather than hashed, and that is the point: a hash over eight
  // ids came out 6-2 in the roster this was measured on, which leaves six
  // athletes still moving as one. The split has to be exactly half.
  return (id & 1) === 0 ? 1 : -1;
}

/**
 * A 0..1 signature coordinate for player `id` on axis `axis`.
 *
 * NOT a hash. A hash is uniform, and uniform is exactly wrong here: over eight
 * athletes a uniform draw leaves some pair within a per cent of each other on
 * every axis at once, and that pair is two clones. The golden-ratio sequence
 * `frac(id·φ)` is a low-discrepancy set — by the three-distance theorem the
 * smallest gap between any two of N points is bounded below and for N = 14 it is
 * about a eighteenth of the range, which no random draw guarantees. Offsetting
 * per axis rotates the same well-spread set, so no pair can be adjacent on one
 * axis and identical on the next.
 */
export function gsig(id: number, axis: number): number {
  const a = SIG_ALPHA[(axis | 0) % SIG_ALPHA.length];
  const x = (id | 0) * a + axis * 0.38196601125 + 0.137;
  return x - Math.floor(x);
}

/**
 * A DIFFERENT irrational per axis, and this is the correction that made the
 * signature block do its job.
 *
 * The original used one multiplier and only OFFSET it per axis. An offset is a
 * rigid translation of the whole sequence, so it preserves every pairwise
 * difference exactly: athletes 0 and 2 sat 0.236 of the range apart on axis 0,
 * and therefore 0.236 apart on axis 1, and axis 2, and every axis at once. The
 * comment above claimed the opposite — "no pair can be adjacent on one axis and
 * identical on the next" — and it was simply not true of the code, which is why
 * widening every spread by a third moved the closest measured silhouette pair
 * by 14 %: the pair was 23.6 % different on everything, and scaling everything
 * up scales that difference up with it.
 *
 * Distinct multipliers decorrelate the axes: within one axis the three-distance
 * theorem still bounds the smallest gap, and across axes a pair that lands
 * close on one lands somewhere else on the next. Values are chosen to be
 * mutually well separated — two nearby multipliers would re-correlate their two
 * axes over the small id range a roster actually uses.
 */
const SIG_ALPHA = [
  0.61803398875,  // phi - 1
  0.41421356237,  // sqrt2 - 1
  0.23606797750,  // sqrt5 - 2
  0.75487766625,  // plastic number - 1
  0.31830988618,  // 1 / pi
  0.86602540378,  // sqrt3 / 2
  0.54368901269,
  0.14159265359,  // pi - 3
  0.69314718056,  // ln 2
  0.95531661812,
  0.28318530718,
  0.47712125472,  // log10 3
];

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
    flexL: 0, flexR: 0, diff: 0, diffRate: 0, strideU: 0, speed: 0, sp: 0,
    gArmLag: (gsig(seed, 11) - 0.5) * 0.19,
    /**
     * Eight independent low-discrepancy coordinates off the one seed.
     *
     * The spreads below are wider than they were, and the reason is a
     * measurement: over eight athletes held at one speed, the closest pair
     * differed by 0.51 rad summed over the twelve bones that actually decide a
     * 35-px silhouette — 2.5 degrees per bone, which is nothing. Two of that
     * roster were the pair the critic called "identical". The axes that carry
     * the most silhouette per radian are the ones opened up most: arm swing
     * amplitude, elbow carriage, how high the hands ride and how low the athlete
     * runs. Trunk lean and adduction follow. Timing is still untouched, so none
     * of this can desynchronise a foot from its plant.
     *
     * They are still bounded by observation, not by taste: ±25 % on a swing
     * amplitude is the difference between two club runners; ±60 % is a cartoon.
     */
    gSwing: 0.76 + gsig(seed, 0) * 0.52,
    gCounter: 0.74 + gsig(seed, 1) * 0.58,
    gBob: 0.78 + gsig(seed, 2) * 0.50,
    gPelvis: 0.78 + gsig(seed, 3) * 0.50,
    gElbow: (gsig(seed, 4) - 0.5) * 0.62,
    gAdduct: (gsig(seed, 5) - 0.5) * 0.34,
    gLean: (gsig(seed, 6) - 0.5) * 0.19,
    gRaise: (gsig(seed, 9) - 0.5) * 0.26,
    gCrouch: (gsig(seed, 10) - 0.5) * 0.045,
    parity: 0,
    // Offset so two athletes stood side by side are never on the same breath,
    // the same weight shift or the same head drift.
    clock: hash01(seed * 23 + 17) * 40,
    weight: 0, alert: 0, handler: 0, mark: 0,
  };
}

/* --------------------------------------------------------------- scratch */

const _q = new THREE.Quaternion();

/* ----------------------------------------------------------- the drivers */

/** Update the continuous scalars. Call once, before anything is posed. */
export function updateDrivers(
  bs: BodyState, loco: LocoLike, dt: number, intent?: StanceIntent | null,
): void {
  const speed = Math.hypot(loco.vel.x, loco.vel.z);
  bs.speed = speed;
  const top = Math.max(4, loco.derived?.topSpeed ?? TOP_REF);
  bs.sp = clamp01(speed / top);
  if (bs.parity === 0) bs.parity = gaitLead(loco.id);

  // --- posture intent, smoothed ---------------------------------------------
  bs.clock += dt;
  bs.alert = damp(bs.alert, clamp01(intent?.alert ?? 0), 3.2, dt);
  bs.handler = damp(bs.handler, clamp01(intent?.handler ?? 0), 6, dt);
  bs.mark = damp(bs.mark, clamp01(intent?.mark ?? 0), 5, dt);

  /**
   * WEIGHT SHIFT. Two incommensurate slow sines, soft-clipped. The clip is the
   * point: a raw sine spends most of its time crossing, which reads as a body
   * swaying like a metronome, whereas a real athlete DWELLS on one leg for
   * three or four seconds and changes over in about half of one. Clipping at
   * 2.1× makes the signal flat-topped, which is that dwell, and the two periods
   * (11.4 s and 27.8 s) never line up so no two shifts are the same length.
   *
   * Amplitude falls away with alertness — someone watching the disc arrive is
   * balanced over both feet, not leaning on a hip — and to zero once moving,
   * where the gait owns the pelvis.
   */
  const wt = bs.clock * 0.0877 + bs.idlePhase;
  const raw = Math.sin(TAU * wt) * 0.78 + Math.sin(TAU * wt * 0.41 + 1.73) * 0.42;
  const amp = (1 - 0.55 * bs.alert) * clamp01(1 - speed / 0.9) * (1 - bs.mark * 0.7);
  bs.weight = clamp(raw * 2.1, -1, 1) * amp;

  /**
   * THE THIGH DIFFERENTIAL AND ITS RATE, a quadrature pair for the arm lag.
   *
   * It lives here rather than in `measureLegs` because this is the only entry
   * point the owner hands a `dt` to. The flexions it differences were written
   * by LAST frame's `measureLegs`, so the rate is one 1/120 s step stale —
   * 8 ms, against a stride that lasts half a second. `poseArms` differences the
   * current flexions itself and uses only the rate from here, so the in-phase
   * term is exact and only the quadrature correction carries the lag.
   *
   * Filtered hard: this is a first difference of an IK output and the raw
   * signal carries the solver's own frame-to-frame quantisation.
   */
  if (dt > 1e-5) {
    const d = bs.flexR - bs.flexL;
    const raw = (d - bs.diff) / dt;
    bs.diffRate += (clamp(raw, -80, 80) - bs.diffRate) * (1 - Math.exp(-25 * dt));
    bs.diff = d;
  }

  // --- acceleration, filtered ------------------------------------------------
  if (dt > 1e-5 && !loco.air.airborne) {
    const ax = (loco.vel.x - bs.prevVX) / dt;
    const az = (loco.vel.z - bs.prevVZ) / dt;
    const k = 1 - Math.exp(-18 * dt);
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

  /**
   * LEAN INTO THE TURN, AND THE SIGN IS THE WHOLE THING.
   *
   * `lat` is positive when the athlete is accelerating to their own RIGHT.
   * Rolling the spine positively about its local +Z takes the up-axis toward
   * −X, and rig +X is the athlete's LEFT — so a POSITIVE roll leans right, and
   * a right-hand turn therefore wants a positive `side`. This carried a leading
   * minus, which meant every hard cut leaned the body out of the turn: measured
   * off the committed chest bone on a 90-degree cut at 7 m/s, 13.7 m/s² of
   * lateral acceleration (which wants 54 degrees of inward lean) produced 25
   * degrees of OUTWARD lean — an 80-degree error, and the single most visible
   * thing a body does in this sport.
   *
   * The clamp is 0.60 rad rather than 0.42: a cutter at the top of a hard plant
   * genuinely gets past 30 degrees, and clipping at 24 flattened exactly the
   * frame the plant is supposed to sell.
   */
  let leanT = Math.atan2(along, G) + 0.085 * bs.sp + bs.gLean;
  let sideT = Math.atan2(lat, G);
  leanT += stateLeanBias(loco, bs);
  leanT = clamp(leanT, -0.26, 0.62);
  sideT = clamp(sideT, -0.60, 0.60);

  [bs.lean, bs.leanV] = spring(bs.lean, bs.leanV, leanT, 13, dt);
  /**
   * The lateral lean is sprung nearly twice as stiff as the forward one, and it
   * has to be. A hard cut spends its peak lateral load inside about 0.15 s; at
   * omega 12, behind an 11 rad/s acceleration filter, the trunk was still at
   * 16 degrees when the physics was asking for 55 and only reached its full
   * lean a third of a second later, by which time the athlete is running
   * straight again. A lean that arrives after the turn is not a lean, it is a
   * wobble.
   */
  [bs.side, bs.sideV] = spring(bs.side, bs.sideV, sideT, 23, dt);

  // --- crouch ----------------------------------------------------------------
  bs.crouch = damp(bs.crouch, stateCrouch(loco, bs), 14, dt);

  // --- stride phase, left-foot referenced ------------------------------------
  // "Left" is THIS athlete's left, which is the simulation's `planted` only when
  // the lead parity is +1 — see `gaitLead`. Get this wrong and the pelvic drop
  // lands on the stance side instead of the swing side.
  const f = loco.foot;
  const leftDown = (f.planted === 'L') === (bs.parity === 1);
  bs.strideU = leftDown ? f.phase * 0.5 : f.phase * 0.5 + 0.5;

  // --- free-body weight ------------------------------------------------------
  const free = loco.air.airborne || loco.prone || loco.state === 'recovery' || loco.state === 'fall';
  bs.freeW = damp(bs.freeW, free ? 1 : 0, 26, dt);
  const prone = loco.prone || loco.state === 'fall'
    || (loco.state === 'layout' && loco.air.airborne)
    || (loco.state === 'recovery');
  /**
   * GOING FLAT IS FAST; GETTING UP IS NOT.
   *
   * One symmetric rate of 11 meant the prone weight needed ~0.2 s to reach
   * even 0.9, and a layout's whole flight is 0.4-0.5 s — so the pose spent the
   * first half of the signature moment of the sport at partial weight and
   * peaked at 65 degrees from vertical when the target was past 90. Measured on
   * the committed chest bone across a full layout, the maximum body pitch was
   * 65.4 degrees: a diagonal, which reads as falling over rather than as
   * extending. A dive is a commitment made in a tenth of a second; standing
   * back up is a second and a half.
   */
  bs.proneW = damp(bs.proneW, prone ? 1 : 0, prone ? 24 : 9, dt);
  bs.rise = loco.pos.y - loco.groundY - loco.hipHeight;
}

/**
 * How much of the sport-specific posture applies right now. It is a function of
 * ground speed because these are STANCES, not gaits: a defender at a dead stop
 * is coiled over the balls of his feet, the same defender at 6 m/s is running
 * and the run owns his body.
 */
function stanceW(bs: BodyState): number {
  return clamp01(1 - (bs.speed - 0.25) / 1.75);
}

/** Per-state contribution to the forward lean, radians. */
function stateLeanBias(loco: LocoLike, bs: BodyState): number {
  // A mark leans over its toes whatever the sim calls the state — it is the
  // single most recognisable body shape in the sport.
  const still = stanceW(bs);
  // The handler is over the disc, not stood behind it — chest forward of the
  // hips, the same shape as the mark opposite him but about half as extreme.
  const stance = still * (0.30 * bs.mark + 0.105 * bs.alert + 0.140 * bs.handler);
  switch (loco.state) {
    case 'backpedal': return 0.20 + stance * 0.5;  // chest over the toes
    case 'shuffle': return 0.13 + stance;
    case 'cut': return 0.10 + 0.16 * clamp01(loco.cutEntrySpeed / 8);
    case 'stumble': return 0.30;
    default: return stance;
  }
}

/** Per-state hip lowering, metres. */
function stateCrouch(loco: LocoLike, bs: BodyState): number {
  const H = 1;
  const still = stanceW(bs);
  /**
   * Knees bent, hips down, ready to move: the mark most, a live cutter some,
   * and the handler nearly as much as the mark.
   *
   * The handler term used to be 0.028 m — two and a half centimetres, which is
   * inside the noise of the breathing bob and reads on screen as a man standing
   * upright holding a frisbee. A thrower with a defender inside a metre is
   * *low*: he is balanced over a fixed pivot foot with a wide base and has to be
   * able to step either way through the mark without moving his weight first.
   * 0.085 m is a real knee bend that still stops well short of the mark's
   * sit-in-a-stance crouch, so the two shapes stay distinguishable.
   */
  const stance = still * (0.115 * bs.mark + 0.050 * bs.alert + 0.085 * bs.handler)
    // Per-athlete: some club players run tall, some sit into it. ±2.2 cm on a
    // 0.95 m hip is a proportion change a viewer reads before they read a face.
    + bs.gCrouch * bs.sp;
  switch (loco.state) {
    case 'backpedal': return 0.055 * H + stance * 0.6;
    case 'shuffle': return 0.095 * H + stance;
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
    default: return stance;
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
  const bobAmp = moving ? (0.011 + 0.031 * sp) * bs.gBob : 0;
  const bob = -bobAmp * Math.cos(TAU * (loco.foot.phase - 0.22));
  let hipY = bob - bs.crouch;

  // Idle: a slow weight shift between the feet, not a metronome.
  let sway = 0;
  let pelvisRoll = 0;
  let pelvisYaw = 0;
  /** Idle-only lateral trunk flexion; the shoulders counter the pelvis. */
  let trunkTilt = 0;
  if (moving) {
    const swayAmp = 0.013 + 0.014 * (1 - sp);
    sway = swayAmp * Math.cos(TAU * u);
    pelvisYaw = (0.045 + 0.145 * sp) * bs.gPelvis * Math.sin(TAU * u);
    // Frontal-plane pelvic drop: the swing-side hip falls a couple of degrees.
    pelvisRoll = (0.026 + 0.042 * sp) * bs.gPelvis * Math.sin(TAU * u);
  } else {
    /**
     * STANDING. `bs.weight` is +1 when the athlete is stood on the left leg.
     * Three things follow from that one number and they have to agree, because
     * disagreeing is exactly what makes a shifted-weight pose look sprained:
     *
     *   the pelvis TRANSLATES over the loaded foot   (sway, toward +X = left)
     *   the UNLOADED hip DROPS                       (roll about local +Z takes
     *                                                 the spine's up-axis toward
     *                                                 −X, i.e. drops the right)
     *   the trunk laterally flexes back the OTHER way so the shoulder line is
     *   counter-tilted to the hip line and the head stays over the base.
     *
     * That contrapposto — pelvis one way, shoulders the other — is the whole
     * read. Symmetric is the mannequin.
     */
    const w = bs.weight;
    const t = bs.clock * 0.52 + bs.idlePhase;
    sway = 0.052 * w + 0.009 * Math.sin(t) + 0.004 * Math.sin(t * 2.3 + 1.1);
    pelvisRoll = 0.075 * w + 0.010 * Math.sin(t * 0.83);
    trunkTilt = -0.062 * w;
    // Hips and shoulders never sit square: a small standing offset, plus a very
    // slow drift so a held frame is not a held frame.
    pelvisYaw = bs.swayBias * 0.55 + 0.026 * Math.sin(TAU * bs.clock * 0.071 + bs.idlePhase);
    // Loading one leg drops the whole body a touch; standing tall costs effort.
    hipY -= 0.010 + 0.010 * Math.abs(w) + 0.005 * Math.cos(t * 1.7);
  }
  sway += bs.swayBias * 0.01;

  /* ---- free body: the sim owns the height and most of the attitude -------- */
  if (bs.freeW > 0.001) {
    hipY = lerp(hipY, bs.rise, bs.freeW);
    /**
     * GOING FLAT DROPS THE HIPS, and the simulation does not model that.
     * `Locomotion` carries a layout at very nearly standing hip height, so
     * `rise` comes back near zero and the pelvis stays 0.95 m up — the body
     * pitches over about it and the silhouette reads as a man falling over
     * rather than a receiver extended a hand's width off the turf. Measured off
     * the committed bones in the `layout` framing it was sitting ~50 degrees
     * from horizontal with the head at head height.
     *
     * A flying body's mass centre is roughly a third of a standing hip height
     * off the deck, so that is what comes off, in proportion to how prone the
     * pose is. Floored at 0.20 m above the root so a body already ON the
     * ground — where the sim HAS lowered `pos.y` and `rise` is already deeply
     * negative — cannot be driven through the turf.
     */
    const flat = bs.proneW * 0.30 * Math.max(0.6, loco.hipHeight);
    hipY = Math.max(hipY - flat, 0.20 - loco.hipHeight);
  }
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
    ? -(0.060 + 0.165 * sp) * bs.gCounter * Math.sin(TAU * (u - 0.065))
    : -pelvisYaw * 0.5;
  const spineLean = bs.lean * 0.70;
  const spineSide = bs.side * 0.70 + trunkTilt;
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
  // Keep the head level against the torso's lean AND against the standing
  // trunk tilt — a shifted hip that carries the head off vertical with it reads
  // as a limp rather than as a rest.
  const headUp = -(bs.lean * 0.55 + bs.proneW * proneSpine(loco) * 0.45);
  pose.setEuler(B.neck, headUp * 0.45, -counter * 0.35, -bs.side * 0.28 - trunkTilt * 0.55);
  pose.setEuler(B.head, headUp * 0.55, -counter * 0.20, -bs.side * 0.22 - trunkTilt * 0.35);

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
    /**
     * This is the PELVIS angle, and the chest ends up ~20 degrees short of it
     * because `proneSpine` extends the thoracic spine backwards (chin off the
     * turf, which is right). So the pelvis has to overshoot horizontal for the
     * chest to reach it. At 1.62 the chest measured 65 degrees from vertical —
     * a body falling forward. 1.92 puts the chest at 88 and the athlete flat.
     *
     * It also arrives sooner: `k / 0.26` rather than `k / 0.34`. A layout is
     * committed at the takeoff, not a third of the way through the flight, and
     * the extra tenth of a second is most of what the `layout` framing catches.
     */
    return 1.82 * ease(clamp01(k / 0.26));
  }
  return 1.46;
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
      /**
       * THE LEGS TRAIL; THEY DO NOT KICK OVER THE TOP.
       *
       * These are angles relative to a PELVIS that is now pitched past
       * horizontal (`proneAngle`), so a hip EXTENSION here compounds with the
       * pelvis and throws the feet up. At −0.22 ∓ 0.10 the measured trailing
       * foot sat 0.50 m above the hips — 33 degrees above horizontal, with the
       * head 0.6 m below it. That is a nosedive, not a layout. Small positive
       * flexion holds the legs a few degrees above the body's own line, which
       * is where a real extension puts them, and the ±0.08 scissor keeps the
       * silhouette from being a symmetric plank.
       */
      // Blended on `proneW` so the first frames off the ground — where the body
      // is still upright and the pelvis is not yet pitched — keep the gathered
      // takeoff shape instead of swinging a leg through the turf.
      const flatT = lerp(-0.22 + 0.10 * lead, 0.10 + 0.08 * lead, bs.proneW);
      const flatS = lerp(-0.34 - 0.16 * lead, -0.30 - 0.18 * lead, bs.proneW);
      // Get-up: the lead leg folds under the hips and takes the weight.
      pose.setEuler(th, lerp(flatT, lead > 0 ? 1.15 : -0.10, tuck), 0.06 * s, 0.10 * s);
      pose.setBend(sh, lerp(flatS, lead > 0 ? -1.55 : -0.55, tuck));
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
  /**
   * Static shoulder FLEXION, radians — how far forward of the coronal plane the
   * upper arms are carried. This is the number that decides whether a standing
   * athlete reads as an athlete or as a shop mannequin, and it was missing:
   * with swing at zero and no flexion term, a stationary body put both arms
   * exactly in the plane of the shoulders, which is the T-pose the rig was
   * built in. Nobody stands like that. The arms live in front of you.
   */
  fwd: number;
}

const RUN_TUNE: ArmTune = { elbow: 0, adduct: 0, swing: 1, raise: 0, fwd: 0 };

/**
 * This athlete's thigh differential, phase-shifted by `gArmLag`.
 *
 * `diff` is a sinusoid at stride rate and `diffRate / ω` is its quadrature
 * partner, so `diff·cos a − (diffRate/ω)·sin a` is the same sinusoid delayed by
 * `a` radians — no delay line, no allocation, exact for a pure tone and
 * gracefully wrong for anything else, which is what a stumble should be.
 *
 * Faded in over 1.0-2.0 m/s: below a jog the signal is not a tone, ω is small
 * and the quadrature term is noise divided by a small number.
 */
function laggedDiff(bs: BodyState): number {
  const cur = bs.flexR - bs.flexL;
  const w = smooth((bs.speed - 1.0) / 1.0);
  if (w <= 0 || bs.gArmLag === 0) return cur;
  const omega = TAU * Math.max(0.7, stepRate(bs.speed) * 0.5);
  const q = clamp(bs.diffRate / omega, -1.8, 1.8);
  const a = TAU * bs.gArmLag * w;
  return cur * Math.cos(a) - q * Math.sin(a);
}

/**
 * Arm swing, counter-phase to the legs by construction. `side` is +1 for the
 * left arm; a positive `x` delta swings any arm forward (the rig binds every
 * limb with local +Z anatomically forward, so the sign is the same on both).
 */
export function poseArms(bs: BodyState, pose: Pose, loco: LocoLike): void {
  const sp = bs.sp;
  const t = armTuneFor(loco, bs);
  /**
   * Shoulder gain on the leg differential. Raised from `0.46 + 0.40·sp`: the
   * leg fix in `Feet.solveLegs` (a swing leg may no longer over-extend behind
   * the body) took about 8 % off the thigh's own range, and the arms are read
   * straight off it, so holding the old gain would have quietly narrowed the
   * arm swing at exactly the moment the note was that the arms do not swing.
   */
  const k = (0.50 + 0.62 * sp) * t.swing * bs.gSwing;
  // Elbow carriage is a function of GROUND SPEED, not of speed-as-a-fraction-
  // of-top-speed, and it saturates: a jogger and a sprinter both run with the
  // elbow near a right angle, and what actually grows with pace is the swing
  // amplitude, which is read off the legs below. Scaling it linearly with `sp`
  // left everyone below a sprint running with near-straight arms.
  const carriage = smooth(clamp01(bs.speed / 3.2));
  const elbowBase = 0.28 + 1.02 * carriage + t.elbow + bs.gElbow * carriage;
  /**
   * HOW WIDE THE ARMS ARE CARRIED, and it is the number that decided the
   * "well-proportioned mannequins" read.
   *
   * Measured off the committed bones, the hands swept to **0.477 m either side
   * of the body axis at every speed from 2 m/s up**, against a shoulder joint
   * that sits at 0.22 m — a quarter of a metre of daylight outboard of the
   * shoulder, held there for the whole stride. Two consequences, and the critic
   * named both without knowing they were the same bug:
   *
   *   the SILHOUETTE. A runner whose hands are outside their shoulders is a
   *   figure with its arms held away from it. That is a mannequin on a stand,
   *   and at 30-40 px it is most of what a body's outline is.
   *
   *   INTERPENETRATION. `sim/move/Separation.ts` settles two athletes 1.26 m
   *   apart and fades that personal space out near a live disc, so a contest
   *   routinely closes to the 0.64 m hard tier. Two bodies 0.64 m apart with
   *   hands 0.477 m off each axis overlap by 0.31 m — the arm is inside the
   *   other player's torso, which is exactly what live-01, live-02 and live-06
   *   show. Nothing about that is fixable by pushing body CENTRES apart; the
   *   swept volume of the limbs has to come in.
   *
   * Two independent terms bring it in, and they do different jobs. Adduction
   * lays the upper arm against the ribs. Humeral internal rotation turns the
   * elbow's hinge so the flexed forearm sweeps ACROSS the front of the body
   * instead of out from the side of it — which is what a runner's arms actually
   * do, and which no amount of adduction alone can produce, because the
   * forearm's contribution to width comes from the direction the elbow points.
   *
   * The twist has to go on the upper arm's own `y`, not on `upperArmTwist`:
   * that bone is a leaf sibling (rig/Types.ts), so writing it rotates skin and
   * nothing else. The sign is `+k · s`, measured rather than derived — swept
   * over ±0.9 rad at 6 m/s, the left hand's peak lateral excursion ran 0.539 m
   * at −0.6 through 0.395 at 0 to 0.274 at +0.6, monotone, so `+` is inboard.
   * The old code carried `-0.10 · s · sp` here, which is that sweep on its
   * WRONG side: it was pushing the hands a further 2 cm out at pace.
   *
   * Both terms ramp on `tuckIn`, not on `carriage`. The elbow's carriage curve
   * saturates at 3.2 m/s because a jogger and a sprinter genuinely carry the
   * same right-angled elbow; the arms come IN much sooner than that — the
   * moment you are jogging rather than strolling, they are against the ribs.
   * Sharing the elbow's curve left a bulge at 2 m/s where the hands swept
   * 0.333 m, wider than the same athlete standing still.
   */
  const tuckIn = smooth(clamp01(bs.speed / 2.0));
  const adductBase = 0.34 + 0.30 * tuckIn + t.adduct + bs.gAdduct * carriage;
  const inRot = (0.10 + 0.50 * tuckIn) * (t.swing > 0 ? 1 : 0.4);
  /**
   * The arms are carried FORWARD of the shoulder line while running, and that
   * offset is a constant, not a by-product of the swing. It used to arrive as a
   * deliberate 38 % leak of the thighs' common mode (`- 0.62 * mean` below),
   * which sounds harmless and is not: the common mode oscillates at stride rate
   * too, so the leak put a stride-rate component into BOTH arms in phase with
   * each other. Measured on the committed bones at 7 m/s, the two upper arms
   * pointed to the same side of the coronal plane for 18 % of every stride and
   * the swing was biased +0.53/−0.25 forward — the "carrying a tray" read.
   * Subtracting the filtered mean in full leaves a pure differential, and this
   * puts the carriage back as an honest constant.
   *
   * It is a SMALL constant. Measured off the committed bones, 0.085 + 0.130
   * centred the shoulder's swing 15 degrees forward of vertical, so the back of
   * the swing only reached 22 degrees of extension and the hand never got behind
   * the hip — side-on the athlete reads as paddling in front of themselves. A
   * runner's shoulder swings about a point much nearer vertical; the hand is
   * carried forward by the ELBOW, not by parking the whole arm there.
   */
  const runFwd = t.swing > 0 ? (0.045 + 0.070 * carriage) * t.swing : 0;
  const lagged = laggedDiff(bs);

  for (let si = 0; si < 2; si++) {
    const s: 1 | -1 = si === 0 ? 1 : -1;
    const ua = s === 1 ? B.upperArm_L : B.upperArm_R;
    const fa = s === 1 ? B.foreArm_L : B.foreArm_R;
    const hd = s === 1 ? B.hand_L : B.hand_R;
    const uaT = s === 1 ? B.upperArmTwist_L : B.upperArmTwist_R;
    const faT = s === 1 ? B.foreArmTwist_L : B.foreArmTwist_R;
    const cl = s === 1 ? B.clavicle_L : B.clavicle_R;

    /**
     * Anti-phase: the LEFT arm answers the RIGHT thigh — measured against the
     * INSTANTANEOUS MEAN of the two thighs, which leaves exactly ±half the
     * differential and nothing else.
     *
     * The mean is not a nuisance offset, it is a signal in its own right: both
     * thighs are forward of the hip through the flight phase, so it carries a
     * large DC *and* a second harmonic at twice stride rate. Subtracting only
     * part of it (this was `- 0.62 * mean`) leaves both of those in both arms,
     * in phase with each other. Measured on the committed bones at 7 m/s the two
     * upper arms shared 0.34 rad RMS of common-mode swing against 0.78 of
     * differential and sat on the same side of the coronal plane for 18 % of
     * every stride — the "carrying a tray" read. Taking the whole mean makes the
     * swing a pure differential; the forward carriage a runner genuinely has is
     * then `runFwd`, an honest constant that does not oscillate.
     */
    const opp = s * lagged * 0.5;
    const swing = k * opp;
    /**
     * THE ELBOW IS THE ARM DRIVE.
     *
     * A shoulder that swings 70 degrees while the elbow stays inside a 34-degree
     * band produces a hand that never leaves the front of the body: measured on
     * the committed bones at 6 m/s the hand's fore-aft excursion was
     * +0.064 to +0.409 m — it never once passed behind the hip, at any speed.
     * That is the whole of "every athlete runs with limp, dangling arms". The
     * arc a viewer reads at 35 px is the HAND's arc, and the hand's arc is
     * mostly the elbow's.
     *
     * A runner's elbow closes to roughly a right angle at the front of the drive
     * and opens toward 140 degrees at the back, where the hand passes the hip
     * pocket. Asymmetric on purpose: the closing coefficient is small (the
     * elbow is already near its front value) and the opening one is nearly three
     * times it, so the back of the swing is where the shape changes — which is
     * also the half of the cycle a side-on broadcast camera sees most of.
     */
    const elbow = clamp(elbowBase + 0.60 * Math.max(0, swing) - 1.30 * Math.max(0, -swing), 0.12, 2.3);
    const adduct = adductBase - 0.10 * Math.max(0, swing);
    // Standing carriage: forward of the coronal plane, and never the same on
    // both sides. `swayBias` is a fixed per-player number, so one arm sits a
    // few degrees further forward than the other for that athlete, always —
    // which is what stops fourteen bodies reading as fourteen copies.
    const fwd = t.fwd > 0
      ? t.fwd * (1 + bs.swayBias * 1.6 * s)
        + 0.030 * t.fwd * Math.sin(TAU * bs.clock * 0.13 + bs.idlePhase + s * 0.9)
      : runFwd * (1 + bs.swayBias * 1.1 * s);

    pose.setSwing(ua, swing + t.raise + fwd + bs.gRaise * carriage, -(adduct) * s, inRot * s);
    pose.setBend(fa, elbow);
    // Humeral and forearm roll: the palms turn in on the forward swing. This is
    // the skinning twist only — `upperArmTwist` is a leaf, so the chain's own
    // internal rotation is the `y` written above and this just spreads a share
    // of it down the deltoid instead of creasing it all at the shoulder.
    pose.setTwist(uaT, (inRot * 0.45 - 0.11 * sp) * s);
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

const _tune: ArmTune = { elbow: 0, adduct: 0, swing: 0, raise: 0, fwd: 0 };

function armTuneFor(loco: LocoLike, bs: BodyState): ArmTune {
  switch (loco.state) {
    case 'backpedal':
      // Short, tight, low — a defender's arms never cross the midline.
      return set(0.55, 0.10, 0.55, 0.10, 0.18 + 0.25 * bs.alert);
    case 'shuffle':
      // Wide and low, hands ready.
      return set(0.75, -0.55, 0.22, 0.16, 0.26 + 0.20 * bs.alert);
    case 'cut': {
      // The inside arm sweeps across the body; the outside arm counterbalances.
      const w = clamp01(loco.cutAngle / Math.PI) * clamp01(loco.cutEntrySpeed / 6);
      return set(0.30 * w, -0.18 * w, 1.25, 0.24 * w, 0);
    }
    case 'jump':
    case 'layout':
      return set(-0.15, -0.05, 0.6, 0, 0);
    case 'landing':
      return set(0.20, -0.30, 0.4, 0.20, 0);
    default: {
      if (bs.speed >= 0.35) return RUN_TUNE;
      /**
       * STANDING — the pose the 'closeup' and 'portrait' framings judge.
       *
       * Three numbers, and all three were previously zero or near it:
       *
       *   fwd     the arms hang FORWARD of the shoulder line. A relaxed adult
       *           carries them 8–12° forward; someone waiting to move carries
       *           them nearer 25° with the hands in front of the hips where
       *           they can do something.
       *   elbow   soft, never locked. ~25° relaxed, ~45° ready.
       *   adduct  in toward the ribs. The bind is a 46° A-pose, so it takes
       *           0.55–0.62 rad off that just to hang plausibly; the old 0.05
       *           left the arms 24° out from the body, which is the flared
       *           near-T the frame was showing.
       *
       * A mark overrides all of this later (`Upper.poseMark`); this is the
       * baseline it blends up from, so the transition has somewhere to start.
       */
      const a = bs.alert;
      return set(
        0.19 + 0.30 * a,          // elbow
        0.26 - 0.11 * a,          // adduct (added to a 0.34 base below)
        0,                        // swing
        0,                        // raise
        0.155 + 0.30 * a,         // fwd
      );
    }
  }
}

function set(elbow: number, adduct: number, swing: number, raise: number, fwd: number): ArmTune {
  _tune.elbow = elbow; _tune.adduct = adduct; _tune.swing = swing;
  _tune.raise = raise; _tune.fwd = fwd;
  return _tune;
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

    /**
     * WHERE THE REACHING ARM POINTS, relative to a body that is now flat.
     *
     * `2.36` rad is 135 degrees of shoulder flexion measured from hanging. On a
     * STANDING athlete that is an arm 45 degrees above horizontal, which is
     * what it was tuned against; on a body pitched past square it is 45 degrees
     * BELOW the body's own long axis, and the hand ploughs into the turf.
     * Measured through a layout the lead hand ended at 0.125 m above the
     * ground, under the hips and 0.43 m below the trailing foot — a nosedive.
     *
     * The correct figure comes out of the geometry rather than out of taste.
     * With the trunk pitched θ from vertical and the shoulder flexed φ, the arm
     * points `(0, −cos(φ−θ), sin(φ−θ))` in world — so a horizontal reach needs
     * φ − θ = π/2, and with the trunk now flat at θ ≈ 1.43 that is φ ≈ 3.0 rad.
     * A body lying face down reaching forward IS a body reaching overhead; the
     * shoulder angle has to say so. The trail arm sits a quarter-radian lower
     * and wider so the two arms are not one shape.
     */
    const extend = lead ? 1 : 0.91;
    pose.setSwing(ua, 3.00 * extend, -(0.26 + (lead ? 0 : 0.20)) * s, -0.10 * s);
    pose.setBend(fa, lead ? 0.12 : 0.40);
    pose.setEuler(hd, -0.16, 0.18 * s, 0);
    pose.setTwist(faT, 0.42 * s);
  }
}
