import * as THREE from 'three';
import type { Ctx } from '../core/Ctx.ts';
import type { LocoPlayer } from '../sim/move/Types.ts';
import type { PlayerRig } from './rig/Types.ts';
import { BONE_NAMES, BONE_INDEX } from './rig/Types.ts';
import type { BoneName } from './rig/Types.ts';

import { B, Frame, Kine, Pose, clamp, clamp01, damp } from './anim/Kine.ts';
import {
  makeBody, updateDrivers, poseSpine, poseArms, poseFreeArms, poseFreeLegs,
  measureLegs, hipsFromPelvis, hash01,
} from './anim/Gaits.ts';
import type { BodyState } from './anim/Gaits.ts';
import { makeFeet, updateFeet, solveLegs, hipDrop } from './anim/Feet.ts';
import type { FeetState } from './anim/Feet.ts';
import {
  makeThrow, makeCatch, stepThrow, fireRelease, poseThrow, startCatch, stepCatch,
  classifyCatch, poseCatch, poseCarry, poseMark, poseRunHands, poseHand, discInHand,
} from './anim/Upper.ts';
import type { ThrowState, CatchState } from './anim/Upper.ts';
import {
  makeSecondary, poseGaze, poseBreath, poseFatigue, updateSignals,
} from './anim/Secondary.ts';
import type { SecondaryState } from './anim/Secondary.ts';
import type {
  AnimAddOptions, AnimSignals, AnimatorOptions, CatchKind, ChargeLike, FieldLike,
  GazeTarget, LocoLike, ReleaseLike, ThrowKind, Vec3Like,
} from './anim/Types.ts';

/**
 * ============================================================================
 *  ANIMATOR — the layer stack
 * ============================================================================
 *
 *   const anim = new Animator({ detail: ctx.quality.charDetail });
 *   const h = anim.add(rig, locoPlayer, { id: locoPlayer.id });
 *   // …each frame, from lateUpdate():
 *   h.gaze = discPos; h.carrying = hasDisc;
 *   anim.update(dt, ctx);
 *
 * WHAT THIS FILE IS AND IS NOT. It owns no motion of its own. Every angle comes
 * out of `anim/Gaits.ts` (body over the feet), `anim/Feet.ts` (the pins),
 * `anim/Upper.ts` (throws, catches, hands) and `anim/Secondary.ts` (gaze,
 * breath). What lives here is the *order* those run in, which is the part that
 * decides whether the result is a pose or a pile of fighting solvers.
 *
 * THE ORDER, AND WHY IT IS THAT ORDER
 *
 *   1  drivers + feet bookkeeping   pure scalars; no bones touched
 *   2  spine from the gait          writes pelvis→head and `pose.hip`
 *   3  throw CORE blended in        the coil is a pelvis and spine rotation, and
 *                                   it has to land BEFORE the legs are solved or
 *                                   the hips move out from under planted feet
 *   4  hip-drop pre-pass            a two-bone mini-FK finds the hips, asks the
 *                                   feet how far out of reach they are, and
 *                                   lowers `pose.hip` by that much — so the body
 *                                   settles in one shot instead of the legs
 *                                   snapping straight and then folding
 *   5  FK                           rig-space transforms for all 60 bones
 *   6  leg IK                       ankles pinned to the sim's plant points
 *   7  measure the legs             thigh flexion read back OFF the solve
 *   8  arms                         swing = k · opposite thigh flexion, so the
 *                                   arms are anti-phase by construction and a
 *                                   stumble breaks both rhythms together
 *   9  throw ARMS / carry / mark    upper-body layer over a running lower body
 *  10  gaze, breath, fatigue        additive; they ride whatever is underneath
 *  11  FK again                     everything above the shoulders moved
 *  12  catch IK                     hands onto the disc's REAL position, solved
 *                                   from the shoulders the running torso
 *                                   actually produced
 *  13  signals + commit             one write per bone quaternion
 *
 * Steps 3 and 9 are the same throw pose evaluated once and blended twice
 * through two different bone masks. That is the layering: the coil reaches the
 * legs through the hips, the arm swing does not reach the legs at all.
 *
 * COST. Two 60-bone FK passes, two two-bone leg solves and up to two two-bone
 * arm solves per athlete. No allocation after `add()` — every vector, quaternion
 * and scratch pose in this file and its dependencies is module-scoped and
 * reused, because 14 athletes at 120 Hz is 1,680 pose passes a second and a
 * single `new THREE.Vector3()` in that path is 100 kB/s of garbage.
 */

/* ------------------------------------------------- sim contract, asserted */

/**
 * The animator never imports the simulation, only mirrors its shape (see
 * `anim/Types.ts`). This is the tripwire: if `LocoPlayer` ever stops satisfying
 * `LocoLike`, that is a type error here rather than a silent visual regression
 * three rounds later.
 */
type _AssertLoco = LocoPlayer extends LocoLike ? true : never;
const _ASSERT_LOCO: _AssertLoco = true;
void _ASSERT_LOCO;

/* ----------------------------------------------------------------- masks */

function maskOf(names: readonly BoneName[]): Int32Array {
  const m = new Int32Array(names.length);
  for (let i = 0; i < names.length; i++) m[i] = BONE_INDEX[names[i]];
  return m;
}

const ARM_BONES = (s: '_L' | '_R'): BoneName[] => {
  const out: BoneName[] = [
    `clavicle${s}`, `upperArm${s}`, `upperArmTwist${s}`,
    `foreArm${s}`, `foreArmTwist${s}`, `hand${s}`,
  ] as BoneName[];
  for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
    for (let j = 1; j <= 3; j++) out.push(`${f}0${j}${s}` as BoneName);
  }
  return out;
};

/** Pelvis + lumbar/thoracic spine. The coil. */
const CORE_MASK = maskOf(['pelvis', 'spine01', 'spine02', 'spine03', 'chest']);
/** Both shoulder girdles, arms, hands and every digit. The swing. */
const ARMS_MASK = maskOf([...ARM_BONES('_L'), ...ARM_BONES('_R')]);

/* --------------------------------------------------------------- scratch */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _hipL = new THREE.Vector3();
const _hipR = new THREE.Vector3();
const _gaze: GazeTarget = { x: 0, y: 0, z: 0 };
/** The throw layer, evaluated once per athlete and blended through two masks. */
const _layer = new Pose();

const NO_VEL: Vec3Like = { x: 0, y: 0, z: 0 };

/* ---------------------------------------------------------------- handle */

/**
 * One athlete's animation state. The owner writes the four intent fields
 * (`gaze`, `gazeWeight`, `carrying`, `marking`) whenever they change and calls
 * nothing else; everything with a verb below is optional colour.
 */
export class AnimHandle {
  /** Player id — the deterministic salt for phase, handedness and breathing. */
  readonly id: number;
  readonly rig: PlayerRig;
  /** The simulated body. Swappable, so a pooled rig can change owners. */
  loco: LocoLike;

  /** Throwing side in rig terms: -1 right-handed, +1 left-handed. */
  readonly handed: 1 | -1;

  /* ---- intent, written by the owner ---- */

  /** World point the head tracks. Null falls back to the animator default. */
  gaze: GazeTarget | null = null;
  /** 0..1 how hard the athlete is bothering to look. */
  gazeWeight = 1;
  /** True while the disc is in this athlete's hand. */
  carrying = false;
  /** Force side while marking: ±1 sets which lane is taken away, 0 = not marking. */
  marking: 0 | 1 | -1 = 0;
  /** Per-athlete detail override; defaults to the animator's. */
  detail: number;

  /* ---- machinery ---- */

  readonly kine: Kine;
  readonly pose = new Pose();
  readonly frame = new Frame();
  readonly body: BodyState;
  readonly feet: FeetState;
  readonly throwing: ThrowState;
  readonly catching: CatchState;
  readonly secondary: SecondaryState;
  readonly signals: AnimSignals = {
    chestAccX: 0, chestAccY: 0, chestAccZ: 0,
    headAccX: 0, headAccY: 0, headAccZ: 0,
    breath: 0, stridePhase: 0, speed: 0,
  };

  /** Live charge, if the owner is pushing one. Cleared on release. */
  charge: ChargeLike | null = null;
  /** Where the catch solver is reaching, world space. */
  reachPos: Vec3Like | null = null;
  reachVel: Vec3Like | null = null;
  /** Smoothed 0..1 weight of the carry layer. */
  carryW = 0;
  markW = 0;
  alive = true;

  constructor(rig: PlayerRig, loco: LocoLike, id: number, handed: 1 | -1, detail: number) {
    this.rig = rig;
    this.loco = loco;
    this.id = id;
    this.handed = handed;
    this.detail = detail;
    this.kine = new Kine(rig.bones, rig.measure);
    this.body = makeBody(id);
    this.feet = makeFeet();
    this.throwing = makeThrow(handed);
    this.catching = makeCatch(handed);
    this.secondary = makeSecondary();
  }

  /* ---- optional verbs ---- */

  /** Begin or continue a windup. Call every frame the button is held. */
  setCharge(c: ChargeLike | null): void { this.charge = c; }

  /** The disc left the hand. Fires the whip and the follow-through. */
  release(rel?: ReleaseLike | null): void {
    fireRelease(this.throwing, rel ?? null);
    this.charge = null;
    this.carrying = false;
  }

  /** Abort a windup — a pump fake retracts rather than snapping to idle. */
  fake(): void {
    this.charge = null;
    if (this.throwing.active && this.throwing.relT < 0) this.throwing.faking = true;
  }

  /**
   * Reach for a disc. `kind` omitted is classified from where the disc actually
   * is relative to this athlete's own chest and head — a 1.94 m player skies a
   * disc that a 1.66 m player has to jump for, and the pose should say so.
   */
  reachFor(pos: Vec3Like, vel?: Vec3Like | null, kind?: CatchKind): void {
    this.reachPos = pos;
    this.reachVel = vel ?? null;
    const k = kind ?? classifyCatch(
      pos.y,
      this.loco.groundY + this.rig.measure.shoulderY - 0.14,
      this.loco.groundY + this.rig.measure.eyeY,
    );
    if (!this.catching.active || this.catching.kind !== k) {
      // Lead with the hand nearest the disc on a one-hander.
      this.frame.toLocal(pos.x, pos.y, pos.z, _v);
      startCatch(this.catching, k, _v.x >= 0 ? 1 : -1);
    }
  }

  /** The disc is in the hands. Draws it to the sternum and closes the grip. */
  caught(): void {
    if (this.catching.active) { this.catching.caught = true; this.catching.caughtT = 0; }
    this.carrying = true;
    this.reachVel = null;
  }

  /** Stop reaching — the disc went somewhere else. */
  releaseReach(): void {
    this.reachPos = null;
    this.reachVel = null;
    this.catching.active = false;
  }
}

/* -------------------------------------------------------------- animator */

export class Animator {
  readonly handles: AnimHandle[] = [];
  private byId = new Map<number, AnimHandle>();

  /** Ground query. Set from `ctx.sys.field`, or assign directly. */
  field: FieldLike | null = null;
  /** Fallback gaze target for every athlete — normally the disc. */
  gaze: GazeTarget | null = null;
  driveRoot: boolean;
  detail: number;
  handed: 1 | -1;

  /** Rolling cost, milliseconds for the whole roster's pose pass. */
  ms = 0;
  msAvg = 0;
  /** Peak seen since the last `resetStats()`. */
  msPeak = 0;
  /** FK passes, leg solves and arm solves in the last update. */
  readonly counters = { fk: 0, legIk: 0, armIk: 0, players: 0 };

  constructor(opts: AnimatorOptions = {}) {
    this.driveRoot = opts.driveRoot ?? true;
    this.detail = opts.detail ?? 1;
    this.handed = opts.handed ?? -1;
  }

  /* --------------------------------------------------------------- roster */

  add(rig: PlayerRig, loco: LocoLike, opts: AnimAddOptions = {}): AnimHandle {
    const id = opts.id ?? loco.id ?? this.handles.length;
    // One athlete in nine throws left-handed. Deterministic, and it shows up in
    // the pivot foot as well as the arm, which is the part people notice.
    // The odd-looking salt is load-bearing: hash01 is a multiply-xorshift, so
    // hash01(0) is exactly 0 and player 0 would be dealt a left hand every
    // single time. Offsetting the seed away from the fixed point costs nothing
    // and keeps the roster honest.
    const handed = opts.handed
      ?? (hash01(id * 9176 + 2411 + (opts.seed ?? 0)) < 0.11
        ? (-this.handed as 1 | -1)
        : this.handed);
    const h = new AnimHandle(rig, loco, id, handed, this.detail);
    this.handles.push(h);
    this.byId.set(id, h);
    return h;
  }

  get(id: number): AnimHandle | undefined { return this.byId.get(id); }

  remove(h: AnimHandle | number): void {
    const handle = typeof h === 'number' ? this.byId.get(h) : h;
    if (!handle) return;
    handle.alive = false;
    this.byId.delete(handle.id);
    const i = this.handles.indexOf(handle);
    if (i >= 0) this.handles.splice(i, 1);
  }

  clear(): void {
    this.handles.length = 0;
    this.byId.clear();
  }

  /* --------------------------------------------------------------- update */

  /**
   * Pose every athlete. Call once per RENDERED frame from `lateUpdate` — the
   * pose is a display concern, and running it on the 120 Hz fixed step doubles
   * the cost for nothing a 60 Hz display can see. Everything integrated in here
   * is exponential or dt-scaled, so either rate is correct.
   */
  update(dt: number, ctx?: Ctx | null): void {
    if (ctx && !this.field) {
      const f = ctx.sys?.['field'] as unknown as FieldLike | undefined;
      if (f && (f.heightAt || f.normalAt)) this.field = f;
    }
    const camera = ctx?.camera ?? null;
    const t0 = now();
    this.counters.fk = 0; this.counters.legIk = 0; this.counters.armIk = 0;
    this.counters.players = this.handles.length;

    const step = clamp(dt, 0, 0.1);
    for (let i = 0; i < this.handles.length; i++) this.poseOne(this.handles[i], step, camera);

    this.ms = now() - t0;
    this.msAvg = this.msAvg === 0 ? this.ms : this.msAvg + (this.ms - this.msAvg) * 0.05;
    if (this.ms > this.msPeak) this.msPeak = this.ms;
  }

  resetStats(): void { this.msPeak = 0; this.msAvg = 0; }

  /* ---------------------------------------------------------- one athlete */

  private poseOne(h: AnimHandle, dt: number, camera: THREE.Camera | null): void {
    const loco = h.loco;
    const kine = h.kine;
    const pose = h.pose;
    const bs = h.body;

    /* 0 — where the athlete is. The rig root sits at the FEET, on the ground;
     *     airborne rise lives in `pose.hip` so the ground frame never lies. */
    h.frame.set(loco.pos.x, loco.groundY, loco.pos.z, loco.facing);

    /* 1 — continuous drivers, then plant bookkeeping. */
    updateDrivers(bs, loco, dt);
    // The pivot is a rule of the sport, and it is only visible if the foot
    // actually stops turning. Hold it from the first frame of the windup until
    // the follow-through is most of the way through.
    const throwing = h.throwing;
    h.feet.pivot = (throwing.active && throwing.relT < 0.26) ? throwing.pivot : 0;
    updateFeet(h.feet, loco, dt, this.field);

    /* 2 — the body over the feet. */
    pose.identity();
    poseSpine(bs, pose, loco);

    /* 3 — the throw's coil, before the legs are solved. */
    stepThrow(throwing, h.charge, dt);
    const wThrow = poseThrow(throwing, _layer, pose, h.detail);
    if (wThrow > 0.001) {
      pose.blendMask(_layer, CORE_MASK, wThrow);
      pose.hip.lerp(_layer.hip, wThrow);
    }

    /* 4 — hip drop. Ask the feet how far out of reach they are and lower the
     *     pelvis by exactly that, once, before anything is solved. */
    if (!h.feet.free) {
      hipsFromPelvis(kine, pose, _hipL, _hipR);
      const drop = hipDrop(h.feet, kine, h.frame, _hipL, _hipR);
      if (drop > 1e-4) pose.hip.y -= drop;
    }

    /* 5 — FK. */
    kine.fk(pose);
    this.counters.fk++;

    /* 6 — legs. */
    if (h.feet.free) {
      poseFreeLegs(bs, pose, loco);
    } else {
      const kneeOut = loco.state === 'shuffle' ? 0.26 : loco.state === 'backpedal' ? 0.14 : 0.08;
      solveLegs(h.feet, kine, pose, h.frame, bs.lean, kneeOut, bs.speed);
      this.counters.legIk += 2;
    }

    /* 7 — read the solve back out. */
    measureLegs(bs, kine);

    /* 8 — arms, anti-phase to whatever the legs just did. */
    if (h.feet.free) {
      poseFreeArms(bs, pose, loco, this.reachSide(h));
      poseHand(pose, 1, 'brace', h.detail);
      poseHand(pose, -1, 'brace', h.detail);
    } else {
      poseArms(bs, pose, loco);
      poseRunHands(pose, loco, h.detail);
    }

    /* 9 — the upper-body layer: throw arms, or a carry, or a mark. */
    if (wThrow > 0.001) {
      pose.blendMask(_layer, ARMS_MASK, wThrow);
    }
    const wantCarry = h.carrying && !h.catching.active && wThrow < 0.5 ? 1 : 0;
    h.carryW = damp(h.carryW, wantCarry, 9, dt);
    if (h.carryW > 0.004) {
      poseCarry(pose, h.handed, h.carryW * (1 - wThrow), h.detail, bs.sp);
    }
    const wantMark = h.marking !== 0 && !h.feet.free ? 1 : 0;
    h.markW = damp(h.markW, wantMark, 8, dt);
    if (h.markW > 0.004 && h.marking !== 0) {
      poseMark(pose, h.marking, h.markW, h.detail);
    }

    /* 10 — secondary. Additive, so it rides whatever is underneath. */
    const target = h.gaze ?? this.gaze ?? this.travelGaze(loco);
    poseGaze(h.secondary, kine, pose, h.frame, target, h.gazeWeight, dt);
    const breathScale = h.detail < 0.6 ? 0.5 : 1;
    h.signals.breath = poseBreath(h.secondary, pose, loco, bs, dt, breathScale);
    poseFatigue(pose, loco, bs);

    /* 11 — FK again: the spine, neck, head and both arms all moved. */
    kine.fk(pose);
    this.counters.fk++;

    /* 12 — the hands meet the disc where the disc actually is. */
    stepCatch(h.catching, dt);
    if (h.catching.w > 0.001 && h.reachPos) {
      poseCatch(h.catching, kine, pose, h.frame, h.reachPos, h.reachVel ?? NO_VEL, h.detail);
      this.counters.armIk += (h.catching.kind === 'rim' || h.catching.kind === 'trail') ? 1 : 2;
    }

    /* 13 — publish, commit, place. */
    updateSignals(h.secondary, kine, h.frame, h.signals, dt);
    h.signals.stridePhase = bs.strideU;
    h.signals.speed = bs.speed;

    kine.commit(pose);

    if (this.driveRoot) {
      h.rig.root.position.set(loco.pos.x, loco.groundY, loco.pos.z);
      h.rig.root.rotation.y = loco.facing;
    }
    if (camera) {
      h.rig.root.updateMatrixWorld(true);
      h.rig.lod.update(camera);
    }
  }

  /* --------------------------------------------------------------- extras */

  /**
   * World position and face normal of the disc as this athlete is holding it.
   * `ctx.sys.game` looks for exactly this shape on `ctx.sys.players` under the
   * name `discAnchor`, so a PlayersSystem forwards it in one line:
   *
   *   discAnchor = (id, pos, n) => this.anim.discAnchor(id, pos, n);
   *
   * Returns false when the id is unknown, which is the signal the game uses to
   * fall back to hanging the disc off the hip.
   */
  discAnchor(id: number, pos: THREE.Vector3, normal: THREE.Vector3): boolean {
    const h = this.byId.get(id);
    if (!h) return false;
    discInHand(h.kine, h.handed, _v, _v2);
    h.frame.toWorld(_v.x, _v.y, _v.z, pos);
    h.frame.dirToWorld(_v2.x, _v2.y, _v2.z, normal);
    return true;
  }

  /** World position of a hand bone. `side` +1 is the athlete's left. */
  handWorld(id: number, side: 1 | -1, out: THREE.Vector3): boolean {
    const h = this.byId.get(id);
    if (!h) return false;
    const b = (side === 1 ? B.hand_L : B.hand_R) * 3;
    h.frame.toWorld(h.kine.wp[b], h.kine.wp[b + 1], h.kine.wp[b + 2], out);
    return true;
  }

  /**
   * Wire the standard event bus so a PlayersSystem gets throws, catches and
   * turnovers for free. Every handler is a no-op for ids we do not own.
   */
  bindEvents(events: { on(evt: string, fn: (p: any) => void): () => void }): () => void {
    const offs = [
      events.on('disc:released', (p: { playerId?: number; throwType?: string; power?: number }) => {
        const h = p?.playerId != null ? this.byId.get(p.playerId) : this.thrower();
        h?.release(p?.throwType
          ? { fired: true, type: asThrowKind(p.throwType), power: p.power ?? 1, quality: 1, tilt: 0, aimYaw: 0 }
          : null);
      }),
      events.on('disc:caught', (p: { playerId?: number }) => {
        if (p?.playerId != null) this.byId.get(p.playerId)?.caught();
      }),
      events.on('disc:grounded', () => {
        for (const h of this.handles) { h.releaseReach(); h.carrying = false; }
      }),
    ];
    return () => { for (const off of offs) off(); };
  }

  private thrower(): AnimHandle | undefined {
    for (const h of this.handles) if (h.carrying || h.throwing.active) return h;
    return undefined;
  }

  /** Which arm leads a layout: the one nearer the thing being reached for. */
  private reachSide(h: AnimHandle): 1 | -1 | 0 {
    const p = h.reachPos ?? h.gaze ?? this.gaze;
    if (!p) return 0;
    h.frame.toLocal(p.x, p.y, p.z, _v);
    return Math.abs(_v.x) < 0.18 ? 0 : (_v.x > 0 ? 1 : -1);
  }

  /** No disc to watch: look where you are going, a few metres ahead. */
  private travelGaze(loco: LocoLike): GazeTarget {
    const d = 6 + 1.6 * Math.hypot(loco.vel.x, loco.vel.z);
    _gaze.x = loco.pos.x + Math.sin(loco.facing) * d;
    _gaze.y = loco.groundY + 1.5;
    _gaze.z = loco.pos.z + Math.cos(loco.facing) * d;
    return _gaze;
  }
}

/* ----------------------------------------------------------------- utils */

const THROW_KINDS: Record<string, ThrowKind> = {
  backhand: 'backhand', forehand: 'forehand', flick: 'forehand',
  hammer: 'hammer', scoober: 'scoober', blade: 'blade',
  // The physics vocabulary has a `push` pass the animation vocabulary does not;
  // it is thrown off the forehand side, so that is the shape it borrows.
  push: 'forehand',
};

export function asThrowKind(s: string): ThrowKind {
  return THROW_KINDS[s] ?? 'backhand';
}

const now = (): number =>
  (typeof performance !== 'undefined' ? performance.now() : Date.now());

export { BONE_NAMES, BONE_INDEX, clamp01 };
export type {
  AnimSignals, AnimatorOptions, AnimAddOptions, CatchKind, ChargeLike, FieldLike,
  GazeTarget, LocoLike, ReleaseLike, ThrowKind,
};
