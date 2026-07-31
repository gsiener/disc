/**
 * What the HUD is allowed to know.
 *
 * The overlay never imports a game system. `HudSystem` reads whatever is on
 * `ctx.sys` — degrading to "no game yet" when the sim is absent — and fills the
 * two structs below once per frame. Every widget consumes only these, which is
 * why a widget can be written, read and reviewed without knowing anything about
 * `GameState`, and why the whole HUD keeps rendering when a peer is stubbed.
 */

export type Side = 0 | 1;

/** Everything the bug needs about one club, resolved once at init. */
export interface TeamBrand {
  /** Three-letter code as printed on the kit. */
  code: string;
  /** Full club name, for the lower third and the summary header. */
  name: string;
  /** Kit primary, as a CSS colour lifted to stay legible on dark glass. */
  colour: string;
  /** Raw kit primary — used where the colour sits behind large type. */
  raw: string;
  /** Ink that survives on top of `raw`. */
  ink: string;
  /** Kit accent, for the possession glow. */
  accent: string;
}

/** One athlete, refreshed in place. Never held across frames by a widget. */
export interface HudPlayer {
  id: number;
  team: Side;
  /** Squad number as printed on the jersey (from the kit bake, not the sim). */
  number: number;
  /** Surname as printed on the back. */
  name: string;
  /** HANDLER / CUTTER / DEEP / UTILITY — the sim's own archetype. */
  position: string;
  /** World position of the hips. */
  x: number; y: number; z: number;
  /** Feet, i.e. the ground under the player. */
  groundY: number;
  /** 0..1. */
  stamina: number;
}

/** The per-frame snapshot. Mutated in place; widgets read, never write. */
export interface HudFrame {
  /** Sim seconds. Every animation in the HUD is a function of this. */
  t: number;
  /** Frame delta, already time-scaled. */
  dt: number;
  /** Viewport in CSS pixels. */
  w: number;
  h: number;
  /** False until a game system with a rules machine turns up. */
  live: boolean;

  score: [number, number];
  point: number;
  half: 1 | 2;
  /** Score a team must reach right now (moves under a cap). */
  target: number;
  cap: 'none' | 'soft' | 'hard';
  /** Elapsed match seconds. 0 while a screenshot tableau is latched. */
  clock: number;
  phase: string;
  possession: Side | null;

  stall: number;
  stallMax: number;
  /** Marker is not legal, so the count is frozen. */
  stallFrozen: boolean;
  timeouts: [number, number];

  /** Player the local human is driving, or -1. */
  controlledId: number;
  /** Player holding the disc, or -1. */
  throwerId: number;
  /** Receiver the thrower has selected, or -1. */
  receiverId: number;
  /** Defender on the mark, or -1. */
  markerId: number;
  discMode: 'held' | 'flight' | 'ground';

  /** Throw charge, mirrored off `ctx.sys.input.charge`. */
  charging: boolean;
  chargePower: number;
  chargeQuality: number;
  chargeHold: number;
  chargeType: string;
  /** Hold time the perfect window is centred on, and its half-width. */
  perfectHold: number;
  perfectHalf: number;
  maxHold: number;
}

export function emptyFrame(): HudFrame {
  return {
    t: 0, dt: 0, w: 1920, h: 1080, live: false,
    score: [0, 0], point: 1, half: 1, target: 15, cap: 'none', clock: 0,
    phase: 'PRE_PULL', possession: null,
    stall: 0, stallMax: 10, stallFrozen: false, timeouts: [2, 2],
    controlledId: -1, throwerId: -1, receiverId: -1, markerId: -1, discMode: 'ground',
    charging: false, chargePower: 0, chargeQuality: 0, chargeHold: 0, chargeType: 'backhand',
    perfectHold: 0.85, perfectHalf: 0.09, maxHold: 2,
  };
}

/**
 * The single seam between the HUD and the rest of the engine.
 *
 * `HudSystem` is the only file allowed to know that `ctx.sys.game`,
 * `ctx.sys.players` and `ctx.sys.disc` exist; it implements this and hands it to
 * the widgets. Everything behind it is optional at runtime, so a missing peer
 * costs a `null`, never a crash.
 */
export interface HudSource {
  /** Live athlete record, refreshed in place. Do not retain across frames. */
  player(id: number): HudPlayer | null;
  /** Disc world position, or null when there is no disc system. */
  disc(): { x: number; y: number; z: number } | null;
  /**
   * Predicted remaining flight, resampled at a few Hz and cached — null unless
   * the disc is actually in the air. Comes from the real integrator, so the
   * drawn arc is the path the disc will fly, not a parabola.
   */
  flight(): readonly { x: number; y: number; z: number }[] | null;
}

/** Widgets are constructed once, told when state changes, ticked every frame. */
export interface HudWidget {
  /** Per-frame. Transform/opacity only. */
  update(f: HudFrame): void;
  /** Viewport changed. Safe to do layout work here. */
  resize?(w: number, h: number): void;
  /** A capture rig staged a new scenario — drop mid-flight animation state. */
  restage?(f: HudFrame): void;
  dispose?(): void;
}
