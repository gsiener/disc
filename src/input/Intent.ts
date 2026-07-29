/**
 * The intent struct.
 *
 * This is the single contract between "something that wants to control a
 * player" and "the systems that move a player". A human on a pad, a human on
 * keyboard+mouse, the AI, and a replay all produce one of these per fixed step,
 * and locomotion / throwing / defence read nothing else. That means a
 * human-controlled player and an AI player literally run the same code path,
 * which is the only way the two ever end up feeling like the same game.
 *
 * Intents are *reused* — one object per player, reset each step — so a 120 Hz
 * sim allocates nothing. Never hold a reference across steps; copy what you need.
 */

export const THROW_TYPES = ['backhand', 'forehand', 'hammer', 'scoober', 'blade'] as const;
export type ThrowType = (typeof THROW_TYPES)[number];

export type IntentSourceKind = 'human' | 'ai' | 'replay' | 'none';

export interface MoveIntent {
  /** World-space XZ direction, magnitude 0..1. Already camera-relative. */
  x: number;
  z: number;
  /** Magnitude of (x,z); cached so consumers do not re-sqrt. */
  mag: number;
  /** Analogue sprint, 0..1. Above ~0.6 is a full sprint; below is a drive. */
  sprint: number;
  /** Analogue hard-brake / plant, 0..1. Drives cuts and pivots. */
  brake: number;
}

export interface AimIntent {
  /** Unit world XZ direction the player is pointing at. Zero when inactive. */
  x: number;
  z: number;
  mag: number;
  /** atan2(x, z) of the aim direction — the yaw the thrower wants. */
  yaw: number;
  /** True when the aim device (right stick / mouse) is actually being driven. */
  active: boolean;
  /** Angular speed of the aim, rad/s. Used to punish whipped releases. */
  rate: number;
}

export interface ChargeIntent {
  active: boolean;
  /** Seconds the throw button has been held. */
  hold: number;
  /** 0..1 power the throw would leave with if released now. */
  power: number;
  /** 0..1 release quality if released now — this is the HUD meter's colour. */
  quality: number;
  type: ThrowType;
  /** Disc angle. -1 = full left-edge-down, +1 = full right-edge-down, 0 = flat. */
  tilt: number;
  /** Aim yaw latched/steered for this throw. */
  aimYaw: number;
  /** Yaw the player was facing when the charge started. */
  baseYaw: number;
  perfect: boolean;
  rushed: boolean;
  overcharged: boolean;
  /** Hold time at which the perfect window is centred — HUD draws the band here. */
  targetHold: number;
  /** Half-width of the perfect window in seconds. */
  targetHalfWidth: number;
  /** Hold time at which the charge auto-releases. */
  maxHold: number;
  /** Difficulty multiplier of the current throw type (1 = backhand). */
  difficulty: number;
}

export interface ReleaseIntent {
  /** Only true on the single step the disc leaves the hand. */
  fired: boolean;
  type: ThrowType;
  power: number;
  quality: number;
  tilt: number;
  aimYaw: number;
  hold: number;
  perfect: boolean;
  rushed: boolean;
  overcharged: boolean;
  /** How still the aim was at release, 0..1. */
  steadiness: number;
  /** True when the charge hit maxHold and released itself. */
  auto: boolean;
  /** Receiver the thrower had selected, or -1. */
  targetId: number;
}

export interface ReceiverIntent {
  /** -1 previous, +1 next, 0 none. Edge-triggered. */
  cycle: -1 | 0 | 1;
  /** Unit XZ of a directional receiver select; zero when none. */
  selectX: number;
  selectZ: number;
  /** True on the step the directional select is first committed. */
  selectFresh: boolean;
  /** Direct-select slot 0..6, or -1. */
  slot: number;
  /** True while a direction has been held long enough to call an active cut. */
  callCut: boolean;
  /** Seconds the current direction has been held. */
  holdTime: number;
}

export interface DefenceIntent {
  /** Edge: attempt a bid / block on the disc. */
  bid: boolean;
  bidHeld: boolean;
  /** Edge: full layout. */
  layout: boolean;
  /** Direction of the layout, unit XZ (falls back to move, then aim). */
  layoutX: number;
  layoutZ: number;
  /** Edge: the player asked to switch. */
  switchRequested: boolean;
  /** Player id chosen by the switch policy, or -1 if the game should decide. */
  switchTarget: number;
  /** Held: apply an active mark (count the stall, deny the around). */
  markHeld: boolean;
  /** Latched force side. -1 = force to -X sideline, +1 = force to +X. */
  force: -1 | 1;
  /** Edge: the force was flipped this step. */
  forceFlipped: boolean;
}

export interface PlayerIntent {
  playerId: number;
  /** Fixed-step index this intent was produced on. */
  step: number;
  /** Simulation time in seconds. */
  t: number;
  source: IntentSourceKind;

  move: MoveIntent;
  aim: AimIntent;
  charge: ChargeIntent;
  release: ReleaseIntent;
  receiver: ReceiverIntent;
  defence: DefenceIntent;

  /** Edge: pivot / plant foot (offence) — also the pump-fake follow-through. */
  pivot: boolean;
  /** Edge: a charge was cancelled this step. */
  cancel: boolean;
  /** True when the cancel read as a pump fake (long enough to sell it). */
  fake: boolean;
}

/** Anything that can drive a player. Humans and AI both implement this. */
export interface IntentSource {
  readonly kind: IntentSourceKind;
  /** Advance one fixed step and return the (reused) intent for this step. */
  step(dt: number, now: number): PlayerIntent;
  readonly intent: PlayerIntent;
}

export function makeIntent(playerId = -1, source: IntentSourceKind = 'none'): PlayerIntent {
  return {
    playerId, step: 0, t: 0, source,
    move: { x: 0, z: 0, mag: 0, sprint: 0, brake: 0 },
    aim: { x: 0, z: 0, mag: 0, yaw: 0, active: false, rate: 0 },
    charge: {
      active: false, hold: 0, power: 0, quality: 0, type: 'backhand', tilt: 0,
      aimYaw: 0, baseYaw: 0, perfect: false, rushed: false, overcharged: false,
      targetHold: 0, targetHalfWidth: 0, maxHold: 0, difficulty: 1,
    },
    release: {
      fired: false, type: 'backhand', power: 0, quality: 0, tilt: 0, aimYaw: 0,
      hold: 0, perfect: false, rushed: false, overcharged: false, steadiness: 1,
      auto: false, targetId: -1,
    },
    receiver: { cycle: 0, selectX: 0, selectZ: 0, selectFresh: false, slot: -1, callCut: false, holdTime: 0 },
    defence: {
      bid: false, bidHeld: false, layout: false, layoutX: 0, layoutZ: 0,
      switchRequested: false, switchTarget: -1, markHeld: false, force: 1, forceFlipped: false,
    },
    pivot: false, cancel: false, fake: false,
  };
}

/**
 * Clears the per-step (edge) fields but preserves latched state — the force
 * side, and anything the owner re-derives anyway. Call at the top of a step.
 */
export function resetIntent(i: PlayerIntent): PlayerIntent {
  const m = i.move; m.x = 0; m.z = 0; m.mag = 0; m.sprint = 0; m.brake = 0;
  const a = i.aim; a.x = 0; a.z = 0; a.mag = 0; a.active = false; a.rate = 0;
  const r = i.release; r.fired = false; r.auto = false; r.targetId = -1;
  const rc = i.receiver; rc.cycle = 0; rc.selectX = 0; rc.selectZ = 0; rc.selectFresh = false; rc.slot = -1;
  const d = i.defence;
  d.bid = false; d.layout = false; d.switchRequested = false; d.switchTarget = -1; d.forceFlipped = false;
  i.pivot = false; i.cancel = false; i.fake = false;
  return i;
}

/** Deep copy for replay buffers and tests. Allocates — do not call per step. */
export function cloneIntent(i: PlayerIntent): PlayerIntent {
  return {
    ...i,
    move: { ...i.move }, aim: { ...i.aim }, charge: { ...i.charge },
    release: { ...i.release }, receiver: { ...i.receiver }, defence: { ...i.defence },
  };
}
