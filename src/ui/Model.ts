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
  /**
   * False while the body cannot act — mid-layout, prone, or getting up. A
   * layout costs 2.04 s of that; the ring dims for exactly as long, because an
   * unresponsive avatar with no explanation reads as a broken control, not as a
   * price you paid.
   */
  available: boolean;
}

/**
 * A cut the human ordered, latched at the instant the order was given.
 *
 * Held as a flat struct on the frame and mutated in place — the gameplay layer
 * draws it as a dashed ghost so you see the *order* and can then judge the
 * execution against it. `playerId < 0` means no order has been given.
 */
export interface CutOrder {
  playerId: number;
  /** One of Playbook's seven `CutKind`s. */
  kind: string;
  /** True while the call button is still down. */
  held: boolean;
  /** Sim time of the last frame the order was held — the fade starts here. */
  at: number;
  /** Where the runner was when the order landed. */
  fromX: number; fromZ: number;
  /** The setup step (deliberately the wrong way) and the space attacked. */
  setupX: number; setupZ: number;
  targetX: number; targetZ: number;
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
  /**
   * True when that selection is the game's stall-7 dump default rather than a
   * human act.
   *
   * The two must not look alike. `Game.ts` auto-aims the panic button at the
   * reset handler the moment the count reaches seven, which means that from
   * stall 7 onward the receiver bracket is usually something nobody chose — and
   * a bracket that reads "I picked him" when the answer is "the count picked
   * him" is the HUD quietly taking credit for a decision the player never made.
   * Same bracket, broken stroke.
   */
  receiverAuto: boolean;
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

  /* ------------------------------------------------ off-ball legibility --
   * Everything below is resolved in `Hud.ts` and drawn by `GameplayLayer`.
   * The rule the whole layer obeys: annotate only what the geometry cannot
   * say. Bodies already show you the stack, the lanes and the resets; they do
   * not show you the force, where a disc will land, or an order that has been
   * given and not yet run. Those, and nothing else, earn pixels. */

  /** Attacking direction of the team in possession. +1 is toward +Z. */
  attackDir: 1 | -1;

  /** True when there is a mark to draw a force against. */
  forceKnown: boolean;
  /**
   * Bearing — `atan2(x, z)` — of the thrower's BREAK side: the shoulder the
   * mark is taking away. The arc is centred on this.
   */
  forceAngle: number;

  /** Where a live flight comes down. Inactive unless the disc is in the air. */
  landing: { active: boolean; x: number; y: number; z: number; t: number };

  /** The last cut the human ordered. */
  cut: CutOrder;

  /** Reset handler the stall count says to look at, or -1. */
  dumpId: number;
  /** Defender a held switch button would hand you, or -1. */
  switchPreviewId: number;
  /** Sim time possession last flipped, or -1 for never. Drives the ring pulse. */
  flipAt: number;
}

export function emptyFrame(): HudFrame {
  return {
    t: 0, dt: 0, w: 1920, h: 1080, live: false,
    score: [0, 0], point: 1, half: 1, target: 15, cap: 'none', clock: 0,
    phase: 'PRE_PULL', possession: null,
    stall: 0, stallMax: 10, stallFrozen: false, timeouts: [2, 2],
    controlledId: -1, throwerId: -1, receiverId: -1, receiverAuto: false,
    markerId: -1, discMode: 'ground',
    charging: false, chargePower: 0, chargeQuality: 0, chargeHold: 0, chargeType: 'backhand',
    perfectHold: 0.85, perfectHalf: 0.09, maxHold: 2,
    attackDir: 1,
    forceKnown: false, forceAngle: 0,
    landing: { active: false, x: 0, y: 0, z: 0, t: 0 },
    cut: {
      playerId: -1, kind: 'under', held: false, at: -1,
      fromX: 0, fromZ: 0, setupX: 0, setupZ: 0, targetX: 0, targetZ: 0,
    },
    dumpId: -1, switchPreviewId: -1, flipAt: -1,
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
   * drawn arc is the path the disc will fly, not a parabola. The horizon runs
   * to ground contact, so the last sample IS the landing point; `t` is seconds
   * from now.
   */
  flight(): readonly { x: number; y: number; z: number; t?: number }[] | null;
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
