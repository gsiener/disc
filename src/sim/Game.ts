import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx.ts';
import { Rng } from '../core/Ctx.ts';

import {
  catchProbability, createTeamAI, effectiveMaxSpeed, makePlayer, restBetweenPoints,
  throwFlightTime, updateTeam,
  type AIPlayer, type AIWorld, type Archetype, type DiscState as AIDiscState,
  type GamePhase, type PlayerAction, type PlayerIntent as AIIntent, type TeamAI,
  type ThrowType as AIThrowType,
} from './AI.ts';
import { laneOf, markPoint, PLAY, type CutRoute, type LaneKey, type Sign } from './Playbook.ts';
import { Locomotion, type DesiredMove, type LocoPlayer } from './Locomotion.ts';
import { createGameState, GameState, type Phase } from './GameState.ts';
import {
  FIELD, brickMark, clampToField, isInBounds, type Dir, type TeamId, type Vec3,
} from './Rules.ts';
import { DiscRuntime, type ThrowRequest } from '../entities/Disc.ts';
import {
  powerForSpeed, throwSpeed, THROW_SPECS, type ThrowType as PhysThrowType,
} from './DiscPhysics.ts';
import { SHOTS, type Shot } from '../capture/Shots.ts';
import type { PlayerIntent as HumanIntent } from '../input/Intent.ts';
import type { IntentGates } from '../input/Human.ts';
import {
  pickSwitchTarget, switchScore,
  type DefenderCandidate, type SwitchSituation,
} from '../input/Switch.ts';

/**
 * GameSystem — the match.
 *
 * Everything else in `src/sim` is a component that was built and unit-tested in
 * isolation: a rules machine that does not know about bodies, a locomotion model
 * that does not know about rules, a team AI that emits wishes, a disc that obeys
 * aerodynamics. This file is the only place they meet, and the order they meet
 * in is the whole design:
 *
 *     1  read intents      one struct, whether a human or the AI produced it
 *     2  step locomotion   every body integrates against the same friction model
 *     3  resolve contacts  once, over the whole roster
 *     4  dispatch actions  throws, bids, pickups — the one-shot half of an intent
 *     5  step the disc     6-DOF flight, then catch / block / ground / OOB
 *     6  step the rules    stall, possession, scoring, the pull swap
 *     7  orchestrate       pull, pick-up, check — the glue a referee would do
 *
 * Human and AI players share steps 1-4 exactly. `Locomotion.intentToDesired`
 * turns an AI intent into a `DesiredMove`; `humanDesired()` turns the input
 * system's intent into the same struct. Nothing downstream can tell them apart,
 * which is the only way a controlled player ever feels like the same game as the
 * thirteen around him.
 *
 * The system also implements `InputHost` (see src/input/Input.ts) — gates,
 * facing, defender candidates, the switch situation. Until that exists the input
 * system runs on permissive defaults and the controls mean nothing.
 *
 * Peers are read off `ctx.sys` and every one is optional:
 *   field.heightAt  ground truth for feet and for the disc's contact shadow
 *   input           the local human's intent
 *   disc            the visual disc; it adopts our runtime rather than owning one
 *   players         character rendering; it reads our roster, we never touch it
 */

/* ------------------------------------------------------------------ tuning */

/** Sim seconds the receiving line waits before the pull goes up. */
const PRE_PULL_WAIT = 2.0;

/**
 * Pull release, fitted against the aero rather than guessed. See `doPull`.
 * `PULL_NOSE` is an offset, not an absolute: the backhand spec sits at -0.02
 * and the fit wants a flat nose, so this cancels it.
 */
const PULL_SPEED = 32;
const PULL_BANK = -0.50;
const PULL_NOSE = 0.02;
const PULL_SPIN = 0.85;
/** Metres of cross-field fade the aim has to undo, and the carry it fades over. */
const PULL_DRIFT = 8.4;
const PULL_CARRY = 66;
/** Where a pull is aimed: the middle of the field, just inside the far endzone. */
const PULL_TARGET_Z = FIELD.GOAL_LINE + 4;

/**
 * Human throw feel. See `humanThrow` for the measurements behind both.
 * `MIN_THROW_SPEED` is the release speed at zero charge — below every throw
 * spec's own floor on purpose, because that floor is a 20 m throw and a dump is
 * not. `HUCK_HYZER` is the power-squared bank that stops the disc turning over
 * and inverting its own curve at full charge.
 */
const MIN_THROW_SPEED = 9;
const HUCK_HYZER = 0.20;

/** Release parameters for a human throw. See `humanReleaseParams`. */
export interface HumanRelease {
  speed: number; angle: number; spin: number; bank: number; nose: number;
}

/**
 * Charge, tilt and release quality -> disc release parameters.
 *
 * Exported and pure so the FEEL is testable. This mapping is the whole of what
 * a throw feels like in the hand, and it used to live inside a private method
 * where the only way to check it was to play the game and squint. The
 * properties that matter — a tap is short, full charge is long, more charge is
 * always more distance, and the curve never inverts on you — are asserted in
 * `tools/test-disc.ts` by flying the actual aero with these numbers.
 */
export function humanReleaseParams(
  type: PhysThrowType, power: number, quality: number, tilt: number,
): HumanRelease {
  const p = clampNum(power, 0, 1);
  const spec = THROW_SPECS[type];
  const top = throwSpeed(type, 1);
  /**
   * Hyzer has to oppose the throw's OWN turnover, and the turnover follows the
   * spin. A backhand and a forehand spin opposite ways, so a single signed bank
   * cannot serve both: applied uniformly it straightened the backhand and made
   * the forehand worse — 20.5 m of drift, a sign flip, and a dip in the
   * distance curve. `spinSign` is the axis that decides which way a fast disc
   * rolls, so it is the axis the correction is taken along. (Handedness needs
   * no special case: `throwDisc` mirrors spin and bank together, so a left
   * hand flips both and the correction still opposes the turn.)
   */
  return {
    speed: MIN_THROW_SPEED + Math.max(0, top - MIN_THROW_SPEED) * p,
    angle: 0.02 + 0.10 * p,
    spin: clampNum(0.35 + 0.55 * quality, 0.1, 1),
    bank: tilt * 0.85 + HUCK_HYZER * p * p * spec.spinSign,
    nose: (1 - quality) * 0.08,
  };
}
/** Sim seconds a check takes before the disc is live again. */
const CHECK_WAIT = 0.65;
/** How close a player must be to a dead disc to pick it up (m). */
const PICKUP_RADIUS = 1.6;
/**
 * A dead disc on the line is unreachable by design: AI.ts caps every player's
 * speed by the room left to the perimeter (so nobody is ever steered over a
 * sideline), which parks the collector a metre short of a disc sitting on the
 * chalk. After this long standing over it, he bends down and takes it.
 */
const PICKUP_DWELL = 1.4;
const PICKUP_DWELL_RADIUS = 3.6;
/** Horizontal reach for a standing catch (m). */
const CATCH_REACH = 0.82;
/** Horizontal reach with the body fully extended (m). */
const LAYOUT_REACH = 1.55;
/** No catches for this long after release, so nobody grabs their own throw. */
const RELEASE_DEADTIME = 0.10;
/** Players are pushed back inside this box every step. */
const PLAY_BOUND_X = FIELD.SIDELINE + 2.5;
const PLAY_BOUND_Z = FIELD.END_LINE + 2.5;

/* ------------------------------------------------ tuning: targeting/control
 *
 * Every number below is quoted from docs/gameplay-design.md §2–§3 and is
 * asserted against in tools/test-game.ts. They are targets, not preferences.
 */

/** Half-angle of the directional-select cone (rad). Brief: 35 degrees. */
const SELECT_CONE = (35 * Math.PI) / 180;
/** Selection score weights. Brief: 60% angular fit / 25% lane / 15% distance. */
const SELECT_W_ANGLE = 0.60;
const SELECT_W_LANE = 0.25;
const SELECT_W_DIST = 0.15;
/** Below this the lane is too short to be a pass at all (m). */
const SELECT_MIN_RANGE = 1.5;
/** A commanded route ghost lives this long for the HUD (s). */
const CUT_GHOST_TIME = 1.5;

/** Aim assist only engages inside this much raw error (rad). Brief: 12 degrees. */
const ASSIST_WINDOW = (12 * Math.PI) / 180;
/** And may never rotate the release by more than this (rad). Brief: 5 degrees. */
const ASSIST_MAX = (5 * Math.PI) / 180;

/** Stall count at which the reset handler is auto-selected. Brief: 7. */
const DUMP_STALL = 7;

/** Control moves to the intended receiver this long after the release (s). */
const HANDOFF_DELAY = 0.10;
/** Control is frozen for this long after possession flips (s). Brief: 0.6. */
const TURNOVER_GRACE = 0.60;
/** Move-stick magnitude that counts as "the human touched it" during grace. */
const GRACE_TOUCH = 0.15;
/** Two switch presses inside this window read as a double tap (s). Brief: 0.3. */
const DOUBLE_TAP = 0.30;

/**
 * A dead disc nobody is walking to stops the match dead (see `idleCollector`).
 * The body is released to its own AI after this long standing still (s), and
 * only while the move stick is under `IDLE_MOVE`.
 */
const COLLECT_PATIENCE = 1.0;
const IDLE_MOVE = 0.05;

/**
 * How far the thrower's body centre may sit from his established pivot, metres.
 *
 * A pivot foot is fixed; the free foot may step anywhere it reaches, and the
 * hips travel with it. 0.75 m is a long step's worth of hip displacement — it
 * buys a handler the reach to pivot out to a break-side throw, which is real
 * technique, without letting him walk. `travelTolerance` in Rules.ts (0.35 m)
 * governs the FOOT and is the detection threshold; this governs the BODY and is
 * the constraint. They are different quantities and should not be unified.
 */
const PIVOT_R = 0.75;

/**
 * The held-mark assist, in the units the stick is resolved into.
 *
 * `MARK_MIN` is the disc-space rule plus room for momentum. A marker inside one
 * metre of the thrower is a foul, and an assist that steers you into one is
 * worse than no assist — but the target being legal is not enough on its own,
 * because a body arrives at its target carrying speed. At `discSpace + 0.15`
 * the assist spent 9.0% of held frames inside the radius against the AI
 * marker's own 4.6%; the extra 30 cm is what absorbs the overshoot. `MARK_SWING` is how far around the thrower a
 * full deflection carries you per second — about 100 degrees, which is a real
 * marker's lateral shuffle rather than a teleport to the other side.
 */
const MARK_MIN = PLAY.discSpace + 0.45;
const MARK_CLOSE = 0.5;
const MARK_SWING = 0.95;
const MARK_REACH = 0.4;

const ARCHETYPES: readonly Archetype[] = [
  'handler', 'handler', 'handler', 'cutter', 'cutter', 'deep', 'utility',
];

const TEAM_NAMES: [string, string] = ['HOME', 'AWAY'];

/** AI throw vocabulary maps 1:1 onto the physics one. */
const THROW_MAP: Record<AIThrowType, PhysThrowType> = {
  backhand: 'backhand', forehand: 'forehand', hammer: 'hammer',
  scoober: 'scoober', push: 'push',
};

const HUMAN_THROW_MAP: Record<string, PhysThrowType> = {
  backhand: 'backhand', forehand: 'forehand', hammer: 'hammer',
  scoober: 'scoober', blade: 'blade',
};

/**
 * The optional hook the character system may expose on `ctx.sys.players`:
 * fill `pos` with the world position of the throwing hand and `normal` with the
 * direction the disc's face should point, and return true. Absent, we place the
 * disc off the body's hip instead.
 */
export type HandAnchorFn = (playerId: number, pos: THREE.Vector3, normal: THREE.Vector3) => boolean;

/* ------------------------------------------------------------------ roster */

/** What the kit bake knows about one team's slots. See `buildRoster`. */
interface SquadIdentity {
  numbers: number[];
  surnames: string[];
  given: string[];
}

export interface RosterEntry {
  id: number;
  team: TeamId;
  number: number;
  name: string;
  archetype: Archetype;
  /** The AI's view of this player: ratings, energy, role. */
  ai: AIPlayer;
  /** The physical body: position, velocity, gait, stamina. */
  loco: LocoPlayer;
}

/* ------------------------------------------------------------------ system */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _from = new THREE.Vector3();
const _norm = new THREE.Vector3();

export class GameSystem implements System {
  readonly name = 'game';
  /**
   * Before players (6) and the disc (7) so both can adopt our state during
   * their own init, and after input (2) so the human's intent is this step's.
   */
  readonly order = 5;

  /** The rules machine. Public: the HUD and the audio system read it. */
  gs!: GameState;
  /** The movement model. Published on ctx.sys.locomotion for the AI to probe. */
  readonly loco = new Locomotion();
  /** The disc. `src/entities/Disc.ts` adopts this rather than owning one. */
  readonly discRuntime = new DiscRuntime();

  readonly roster: RosterEntry[] = [];
  private byId = new Map<number, RosterEntry>();
  private ai!: [TeamAI, TeamAI];
  private aiDir: [Dir, Dir] = [1, -1];

  /** Which player the local human drives. */
  controlledPlayerId = 0;
  /** The human's team. */
  humanTeam: TeamId = 0;

  private rng!: Rng;
  private seed = 0;
  private wind = new THREE.Vector3();
  private world!: AIWorld;
  private aiDisc: AIDiscState = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    state: 'ground', carrier: null, thrownBy: null, intendedReceiver: null,
    stall: 0, spin: 0, throwType: null,
  };

  /* per-step scratch */
  private intents: AIIntent[] = [];
  private actionOf = new Map<number, PlayerAction | null>();
  private desired: DesiredMove = { dir: null };

  /* flight bookkeeping */
  private lastInBounds = new THREE.Vector3();
  private hadInBounds = false;
  private flightSettled = false;
  private intendedReceiver = -1;
  private thrownBy = -1;

  /* orchestration */
  private lastPhase: Phase = 'PRE_PULL';
  private pullerId = -1;
  private selectedReceiver = -1;
  private humanStep = -1;
  private humanIdle = 99;

  /* ------------------------------------------------------ targeting/control
   *
   * The seam §6 of the design brief describes: `Human.ts` produces a
   * directional select and a callCut, `Input.ts` emits `input:receiver`, and
   * until now nothing consumed either. Everything below is that consumer.
   */

  /** Monotonic simulation seconds. Drives the handoff and double-tap clocks. */
  private simT = 0;
  /** Where the current selection came from — HUD draws a dump bracket amber. */
  private selectSource: SelectSource = 'none';
  /** Lane the selected receiver occupies, via `Playbook.laneOf`. */
  private selectedLane: LaneKey | null = null;
  /** Last directional select, scored. Telemetry for the HUD and the tests. */
  private candidates: SelectCandidate[] = [];
  /** Route the human last commanded, and how long ago — the §4 route ghost. */
  private cutRoute: CutRoute | null = null;
  private cutRouteFor = -1;
  private cutRouteAge = 0;
  /** callCut is edge-triggered: one command per hold, not one per step. */
  private cutHeld = false;
  private cutCommandFor = -1;
  /** Signed rotation the last release's aim assist applied (rad). */
  private lastAssist = 0;
  /**
   * Signed error between the last release's RAW aim and the ideal lead (rad),
   * or 0 when no receiver was selected. This is the quantity the 12-degree
   * window is measured against — not the angle to the receiver's feet, which is
   * a different number entirely once he is running — so it is published rather
   * than left implicit, and tools/test-game.ts asserts the window against it.
   */
  private lastLeadErr = 0;

  /** Pending control transfer to the intended receiver: id and the due time. */
  private handoffTo = -1;
  private handoffAt = 0;
  /**
   * Sim time the post-turnover control freeze ends, or -1 when there is none.
   * An absolute deadline rather than a countdown, so the window is exactly
   * 0.6 s and not 0.6 s minus the step it opened on.
   */
  private graceUntil = -1;
  /** True once the human moved or pressed switch inside the grace window. */
  private graceTouched = false;
  /** Possession as of the end of the previous step; flips are detected here. */
  private lastPossession: TeamId | null = null;
  /** Sim time of the last switch press, for the double-tap escape hatch. */
  private lastSwitchT = -99;
  /** Diagnostics: how many times control has moved, and why it last moved. */
  private controlChanges = 0;
  private controlReason = 'init';
  /** The event bus, cached in init so control changes can announce themselves. */
  private bus: Ctx['events'] | null = null;

  /* tableau */
  private posed = false;
  private poseName = '';
  private poseHold = 0;

  private field: { heightAt?(x: number, z: number): number } | undefined;

  /* --------------------------------------------------------------- lifecycle */

  init(ctx: Ctx): void {
    this.seed = ctx.rand.fork(0x6a3e1c).int(0, 0x7fffffff);
    this.rng = new Rng(this.seed);
    this.bus = ctx.events;
    // The live registry, not a snapshot: peers that register after us (the
    // character system is one slot behind) appear on it as they are built.
    this.sysRef = ctx.sys as unknown as Record<string, unknown>;

    this.field = ctx.sys['field'] as { heightAt?(x: number, z: number): number } | undefined;
    const ground = (x: number, z: number): number =>
      (typeof this.field?.heightAt === 'function' ? this.field.heightAt(x, z) : 0);

    this.loco.autoResolve = false;
    this.loco.attach(ctx as unknown as { events?: Ctx['events']; rand?: Rng; sys?: Record<string, unknown> });
    if (!ctx.sys['locomotion']) ctx.sys['locomotion'] = this.loco;

    this.discRuntime.groundAt = ground;
    this.discRuntime.wind = this.wind;

    // A light, steady breeze — enough that hucks bend and zone becomes a real
    // call, not enough that the flight model becomes unreadable.
    const w = ctx.rand.fork(0x117d);
    this.wind.set(w.range(-1.5, 1.5), 0, w.range(-1.1, 1.1));

    this.buildRoster(ctx);

    this.gs = createGameState(ctx, {
      teams: [
        { name: TEAM_NAMES[0], players: this.roster.filter((r) => r.team === 0).map((r) => ({ id: r.id, name: r.name, number: r.number })) },
        { name: TEAM_NAMES[1], players: this.roster.filter((r) => r.team === 1).map((r) => ({ id: r.id, name: r.name, number: r.number })) },
      ],
      startingPullTeam: 1,
      startingDirTeam0: 1,
      rules: {
        // Broadcast pacing: the rules machine's real defaults leave the frame
        // dead for five minutes at halftime, which is not a game you can watch.
        postScoreDelay: 3.5,
        halftimeDuration: 10,
        timeoutDuration: 12,
      },
    });
    this.gs.startGame();
    this.lastPhase = this.gs.phase;
    this.lastPossession = this.gs.possession;

    this.rebuildAI();
    this.buildWorld();
    this.lineUpForPull();

    ctx.events.on('shot:apply', (p: { name?: string; shot?: Shot }) => {
      this.applyTableau(p?.shot?.tableau ?? 'flow', p?.name ?? '', ctx, p?.shot);
    });

    // The visual disc adopts our runtime if it inits after us; if it got there
    // first (someone reordered the list) hand it over now.
    const disc = ctx.sys['disc'] as unknown as { attachRuntime?(rt: DiscRuntime): void } | undefined;
    disc?.attachRuntime?.(this.discRuntime);
  }

  private buildRoster(ctx: Ctx): void {
    const rng = ctx.rand.fork(0x0a11ce);
    const overall: [number, number] = [76, 74];

    for (let t = 0 as TeamId; t <= 1; t = (t + 1) as TeamId) {
      for (let i = 0; i < 7; i++) {
        const id = t * 7 + i;
        const arch = ARCHETYPES[i];
        const ai = makePlayer(id, t, arch, rng, overall[t]);
        // Locomotion wants physical numbers the rating sheet does not carry.
        const height = 1.72 + (arch === 'deep' ? 0.13 : arch === 'handler' ? 0.02 : 0.07)
          + rng.gauss() * 0.045;
        const mass = 62 + 24 * (ai.attr.jumping / 100) + rng.gauss() * 5 + (height - 1.75) * 40;
        const loco = this.loco.create({
          id, team: t,
          attr: {
            speed: ai.attr.speed,
            accel: ai.attr.acceleration,
            agility: ai.attr.agility,
            strength: clampNum(52 + 0.45 * (mass - 78) + rng.gauss() * 8, 30, 96),
            vertical: ai.attr.jumping,
            endurance: ai.attr.stamina,
            balance: clampNum(0.6 * ai.attr.agility + 0.4 * ai.attr.defAwareness, 30, 96),
            height, mass,
          },
          pos: new THREE.Vector3(0, 0, 0),
        });
        // Placeholder identity — `resolveIdentity` replaces it from the kit
        // bake on the first frame, once PlayersSystem has baked the name strip.
        const entry: RosterEntry = {
          id, team: t, number: i + 1,
          name: `${TEAM_NAMES[t]} ${i + 1}`,
          archetype: arch, ai, loco,
        };
        this.roster.push(entry);
        this.byId.set(id, entry);
      }
    }
    this.controlledPlayerId = 0;
  }

  /**
   * Take the squad's real names off the kit bake, once.
   *
   * This cannot happen in `buildRoster`, and the reason is ordering: this system
   * is `order = 5` and `PlayersSystem` is `order = 6`, so the roster is built a
   * whole system before the kits that carry the names exist. Re-ordering them to
   * suit a cosmetic read would move the sim relative to the animator and the
   * material library, which is a real risk for a naming change.
   *
   * So identity is adopted on the first frame instead. The kit bake owns it
   * because the name strip is a TEXTURE — its rows are fixed when it is baked
   * and slot `i` samples row `i` — and reading the same row is the only way the
   * broadcast lower-third can agree with the back of the shirt. Headless suites
   * have no renderer at all and simply keep the numbered fallback.
   */
  private identityResolved = false;
  private resolveIdentity(ctx: Ctx): void {
    if (this.identityResolved) return;
    const kits = (ctx.sys['players'] as
      { kits?: { squadOf?(t: number): SquadIdentity | null } } | undefined)?.kits;
    if (!kits?.squadOf) { this.identityResolved = true; return; }
    for (let t = 0; t <= 1; t++) {
      const squad = kits.squadOf(t);
      if (!squad) continue;
      for (const r of this.roster) {
        if (r.team !== t) continue;
        const i = r.id - t * 7;
        const given = squad.given?.[i];
        const surname = squad.surnames?.[i];
        if (given && surname) r.name = `${given} ${surname}`;
        if (typeof squad.numbers?.[i] === 'number') r.number = squad.numbers[i];
      }
    }
    this.identityResolved = true;
  }

  /**
   * `TeamAI` binds its attacking direction at construction, and the direction
   * flips after every point — so the pair is rebuilt whenever it moves. The rng
   * is forked from a fixed seed plus the point number, which keeps the whole
   * match reproducible.
   */
  private rebuildAI(): void {
    const d0 = this.gs.attackDir[0];
    const d1 = this.gs.attackDir[1];
    this.aiDir = [d0, d1];
    const r = new Rng((this.seed ^ (this.gs.point * 0x9e3779b9)) >>> 0);
    // Both sides defend person, on purpose. Ultimate is only legible to someone
    // who knows it if the shapes on the field are the shapes they know: a
    // stack, a force, a matchup. A zone renders as fourteen bodies with no
    // relationship to each other, which is exactly what "players scattered with
    // no visible structure" looks like — so the zone bias is pushed well
    // negative rather than left at the AI's default.
    //
    // THE TWO SIDES DEFEND DIFFERENTLY. Team 0 forces backhand — a fixed side
    // for the whole point. Team 1 forces MIDDLE, which is positional: the mark
    // stands between the thrower and the near sideline, so the open side swaps
    // as the disc crosses the field and the offence is pushed back to the
    // centre. Two defensive calls that look different on screen, for the same
    // reason two offensive shapes would.
    //
    // It is also the single biggest tempo lever measured on this game. Across
    // the six sweep seeds it roughly DOUBLES scoring — 6/5/8/5/1/9 against
    // 3/1/2/1/6/3 — with throws up from 53-77 to 66-87, because a force that
    // moves stops the offence settling into one lane and grinding the stall.
    //
    // It costs the broadcast camera, and that is logged rather than hidden:
    // `lead room on the attacking side` falls 97.157% -> 95.592% because the
    // rig assumes the open side is stable for a possession and a positional
    // force inverts it mid-point. Gameplay that progresses beats framing that
    // is 1.5 points tidier; the camera work is real and is written down.
    //
    // THE TWO SIDES ALSO RUN DIFFERENT OFFENCES. Team 0 runs a vertical stack,
    // team 1 a horizontal — the two base looks of the sport, and they read
    // nothing alike on camera. Until now `horizontal` was dead code:
    // `chooseFormation` can only return `endzone`, `side`, `vertical` or the
    // team's own `prefer`, so with both preferring vertical it had never once
    // appeared on screen (measured over 1308 s: vertical 79.9%, endzone 14.1%,
    // side 6.0%, horizontal 0%).
    //
    // The A/B, run against the six-seed sweep in `tools/test-game.ts` — the
    // harness that actually reads this config, unlike `tools/test-ai.ts` which
    // builds its own teams — says ho is NOT the regression an earlier round of
    // this work claimed:
    //
    //   scoring over six seeds   vert 34  |  ho 34     dead heat
    //   camera                   70/3     |  69/2      better on ho
    //   `lead room`              95.592 X |  passes    better on ho
    //   directional select       84.0%    |  87.8%     BETTER on ho, n=156
    //
    // THE SELECT ROW USED TO READ THE OTHER WAY and it was wrong: ho was
    // recorded as costing 8 points of stick agreement, and the floor in
    // `tools/test-game.ts` was lowered to 0.62 to accept a cost taken from ONE
    // seed's 18 samples. The full per-seed spread and the openness figures live
    // with the floor they justify — see the SELECT_AGREEMENT_FLOOR note there.
    //
    // Worth keeping here is only why it could never have been causal: the
    // human's team is vertical either way and the select only ever scores the
    // thrower's own teammates, so team 1's OFFENSIVE shape is not an input to
    // it. That was written down as the open question at the time, and it was
    // the right question.
    this.ai = [
      createTeamAI(0, d0, r, { formation: 'vertical', force: 'forehand', aggression: 1.05, zoneBias: -0.55, seed: 11 }),
      createTeamAI(1, d1, r, { formation: 'horizontal', force: 'middle', aggression: 0.95, zoneBias: -0.45, seed: 29 }),
    ];
  }

  /* ------------------------------------------------------------------ step */

  update(dt: number, ctx: Ctx): void {
    this.resolveIdentity(ctx);
    if (this.posed) {
      if (!ctx.capture) {
        this.poseHold -= dt;
        if (this.poseHold <= 0) this.posed = false;
      }
      if (this.posed) return;
    }

    this.simT += dt;
    this.readHuman(ctx, dt);
    this.syncAIFromBodies();
    this.buildWorld();

    /* 0 — targeting --------------------------------------------------------
     * Before the AI runs, so a cut commanded this step is executed this step
     * rather than eight milliseconds late.
     */
    this.stepTargeting(dt, ctx);

    /* 1 — intents ---------------------------------------------------------- */
    this.intents.length = 0;
    this.actionOf.clear();
    const a = updateTeam(this.ai[0], this.world, dt);
    const b = updateTeam(this.ai[1], this.world, dt);
    for (const it of a) this.intents.push(it);
    for (const it of b) this.intents.push(it);

    /* 2 — locomotion (one path for humans and AI) --------------------------- */
    const human = this.liveHumanIntent(ctx);
    // Anchor the thrower before anyone steps: the soft separation tier runs
    // after locomotion and would otherwise let a crowding marker walk him off
    // his own pivot, which is a foul in the rules and free yardage in the sim.
    const anchorId = this.gs.phase === 'LIVE_POSSESSION' ? this.gs.thrower : null;
    for (const e of this.roster) e.loco.anchored = e.id === anchorId;
    for (const it of this.intents) {
      const e = this.byId.get(it.id);
      if (!e) continue;
      if (human && it.id === this.controlledPlayerId) {
        this.actionOf.set(it.id, this.humanAction(human, e));
        // A body the human is not moving still has to collect a dead disc —
        // see `idleCollector`. Everything else about him stays human-driven.
        const d = this.idleCollector(human, e)
          ? this.loco.intentToDesired(e.loco, it)
          : this.humanDesired(human, e);
        this.loco.step(e.loco, d, dt);
      } else {
        this.actionOf.set(it.id, it.action);
        this.loco.step(e.loco, this.loco.intentToDesired(e.loco, it), dt);
      }
    }

    /* 3 — contacts --------------------------------------------------------- */
    this.loco.resolveCollisions(dt);
    this.keepOnField();

    /* 4 — one-shot actions -------------------------------------------------- */
    this.dispatchActions();
    this.stepWindup(dt, ctx);

    /* 5 — the disc ---------------------------------------------------------- */
    this.stepDisc(dt);

    /* 6 — the rules --------------------------------------------------------- */
    this.stepRules(dt);

    /* 7 — the referee ------------------------------------------------------- */
    this.orchestrate(dt);
    // Possession is watched on the SAME fixed step it flips — the gates the
    // input system reads are derived from `gs`, so they invert here too, and
    // the buffer flush has to happen before a stale press can be re-read.
    this.watchPossession(ctx);
    this.autoSelectControlled(ctx);

    if (this.gs.phase !== this.lastPhase) {
      this.onPhaseChange(this.lastPhase, this.gs.phase);
      this.lastPhase = this.gs.phase;
    }
  }

  /* ---------------------------------------------------------------- world */

  private syncAIFromBodies(): void {
    for (const e of this.roster) {
      e.ai.pos.x = e.loco.pos.x; e.ai.pos.y = e.loco.pos.y; e.ai.pos.z = e.loco.pos.z;
      e.ai.vel.x = e.loco.vel.x; e.ai.vel.y = e.loco.vel.y; e.ai.vel.z = e.loco.vel.z;
      e.ai.airborne = e.loco.air.airborne;
    }
  }

  private buildWorld(): void {
    const gs = this.gs;
    const d = this.discRuntime.state;
    const ad = this.aiDisc;
    ad.pos.x = d.pos.x; ad.pos.y = d.pos.y; ad.pos.z = d.pos.z;
    ad.vel.x = d.vel.x; ad.vel.y = d.vel.y; ad.vel.z = d.vel.z;
    ad.spin = d.spin;
    ad.stall = gs.stallCount;
    ad.carrier = this.discRuntime.mode === 'held' ? this.discRuntime.holderId : null;
    ad.thrownBy = this.thrownBy >= 0 ? this.thrownBy : null;
    ad.intendedReceiver = this.intendedReceiver >= 0 ? this.intendedReceiver : null;
    ad.state = discPhaseFor(gs.phase, this.discRuntime.mode);
    ad.throwType = (d.throwType === 'raw' || d.throwType === 'blade')
      ? null : (d.throwType as AIThrowType);

    const possession: TeamId = gs.possession ?? gs.receivingTeam;
    if (!this.world) {
      this.world = {
        time: 0, players: this.roster.map((r) => r.ai), disc: ad,
        possession, phase: 'setup', wind: { x: this.wind.x, z: this.wind.z },
        score: [0, 0], scoreCap: gs.target, rand: this.rng, sys: undefined,
      };
    }
    const w = this.world;
    w.time = gs.clock;
    w.possession = possession;
    w.phase = gamePhaseFor(gs.phase);
    w.score[0] = gs.score[0]; w.score[1] = gs.score[1];
    w.scoreCap = gs.target;
    w.wind.x = this.wind.x; w.wind.z = this.wind.z;
  }

  /** Called once the peers exist; the AI probes them defensively. */
  private bindPeers(ctx: Ctx): void {
    if (!this.sysRef) this.sysRef = ctx.sys as unknown as Record<string, unknown>;
    if (this.world && !this.world.sys) this.world.sys = this.sysRef;
  }

  /* ------------------------------------------------------------ human path */

  private readHuman(ctx: Ctx, dt: number): void {
    this.bindPeers(ctx);
    const input = ctx.sys['input'] as unknown as { intent?: HumanIntent } | undefined;
    const hi = input?.intent;
    if (!hi) { this.humanIdle = 99; return; }
    if (hi.step !== this.humanStep) { this.humanStep = hi.step; this.humanIdle = 0; }
    else this.humanIdle += dt;

    /**
     * THE FORCE IS THE HUMAN'S CALL WHENEVER THEY ARE ON DEFENCE.
     *
     * Not only while they hold the mark: a force is called for the point, and
     * it has to survive the disc changing hands, a switch, and the player
     * picking a different body to drive. It is handed back to the configured
     * force the moment they are on offence, so their own team's `force` setting
     * still governs when nobody is calling anything.
     *
     * Everything downstream follows for free. The defence re-points because
     * `personDefence` reads it; the OFFENCE re-points because `readForce`
     * watches which side of the thrower the mark is standing on and re-orients
     * the stack, the reset and the break side off that — the same path it would
     * take if an AI marker had moved. There is no second wire to keep in sync.
     */
    const onDefence = this.gs.possession !== null && this.gs.possession !== this.humanTeam;
    this.ai[this.humanTeam].setCalledForce(onDefence ? hi.defence.force : null);
  }

  /**
   * The human intent, or null when the input system is not actually producing
   * one (capture mode, an unfocused tab). In that case the AI drives all
   * fourteen, which is what makes a screenshot of "the game" show a real play.
   */
  private liveHumanIntent(ctx: Ctx): HumanIntent | null {
    if (this.humanIdle > 0.4) return null;
    const input = ctx.sys['input'] as unknown as { intent?: HumanIntent } | undefined;
    const hi = input?.intent;
    if (!hi || hi.playerId !== this.controlledPlayerId) return null;
    return hi;
  }

  /**
   * WHICH DEFENDER AM I? The two jobs on defence are not the same job, and a
   * control scheme that pretends they are gives you one set of verbs for both.
   *
   *   'mark'    — you are on the disc. There is a thrower, and you are the man
   *               the defence has matched to him. Your job is the force and the
   *               stall, and you are the only player on the field who can be
   *               beaten by a pivot.
   *   'matchup' — you are guarding a cutter somewhere else. Your job is a
   *               cushion and a shade, and you are beaten by a change of pace.
   *
   * Returned as the context the controls switch on, and published for the HUD
   * so the player can see which set of verbs they currently hold.
   */
  /**
   * The open side the human's defence is playing, once the force — configured
   * or called with `forceFlip` — has been resolved against the disc. Null when
   * they are not on defence. The HUD draws the call from this, and it is the
   * reference the mark assist shades around.
   */
  defenceOpenSide(): Sign | null {
    if (this.gs.possession === null || this.gs.possession === this.humanTeam) return null;
    return this.ai[this.humanTeam].openSideOnD;
  }

  defenceContext(id: number = this.controlledPlayerId): 'mark' | 'matchup' | null {
    const e = this.byId.get(id);
    if (!e || e.team !== this.humanTeam) return null;
    if (this.gs.possession === null || this.gs.possession === e.team) return null;
    const ai = this.ai[e.team];
    if (this.gs.phase === 'LIVE_POSSESSION' && ai.marker === id) return 'mark';
    return 'matchup';
  }

  /**
   * The defensive positioning assist, held rather than toggled.
   *
   * Both branches return a POINT to steer at instead of consuming the stick as
   * a raw direction, which is what makes the two contexts feel different from
   * one control: on the disc the stick moves you around a man, off it the stick
   * moves you relative to a man. Let go and you get the raw stick back — the
   * assist never takes the body away from the player, it only changes what the
   * stick means while it is held.
   */
  private defenceAssist(hi: HumanIntent, e: RosterEntry): { x: number; z: number } | null {
    if (!hi.defence.markHeld) return null;
    const ctx = this.defenceContext(e.id);
    const m = hi.move;
    const px = e.loco.pos.x, pz = e.loco.pos.z;

    if (ctx === 'mark') {
      const th = this.gs.thrower;
      const t = th !== null ? this.byId.get(th) : undefined;
      if (!t) return null;
      /**
       * You ORBIT him. The stick is resolved against the stand-off circle, not
       * against the world: tangential input slides you around the thrower,
       * radial input closes or opens the gap. That is both how a marker
       * actually moves and the only way to hold a force with a stick — steered
       * in a straight line at where you want to be, you walk through the
       * thrower, the disc-space rule shoves you back out along the radius you
       * came in on, and you never change sides at all. The AI marker already
       * travels the circle for exactly this reason.
       */
      /**
       * The BASE BEARING IS THE FORCE, not wherever you happen to be standing.
       *
       * Holding the mark has to mean holding the force — otherwise calling one
       * re-points the other six defenders and leaves the body you are actually
       * driving facing the old way, which is the one place the call is supposed
       * to be most visible. So the assist anchors to the mark point the force
       * implies and the stick shades around it, up to `MARK_SWING`. Let go and
       * you are exactly on the force; lean on it and you cheat toward the
       * around or the inside, and give up the other one to do it.
       */
      const odir = this.gs.attackDir[t.team];
      const open = this.ai[e.team].openSideOnD ?? (1 as Sign);
      const mp = markPoint({ x: t.loco.pos.x, z: t.loco.pos.z }, odir, -open as Sign);
      const base = Math.atan2(mp.z - t.loco.pos.z, mp.x - t.loco.pos.x);
      const ux = Math.cos(base), uz = Math.sin(base);
      // Tangent, 90 degrees counter-clockwise of the outward radius.
      const tx = -uz, tz = ux;
      const radial = m.x * ux + m.z * uz;
      const tangent = m.x * tx + m.z * tz;
      /**
       * The stand-off is ABSOLUTE, not relative to where you already are.
       *
       * Expressed as `r - radial * close` it is a ratchet: every frame subtracts
       * from the CURRENT radius, so any sustained inward stick walks the target
       * down until it pins against the floor and stays there. Measured, that
       * put a held mark inside the disc-space radius on 9.9% of frames against
       * the AI marker's 4.6%, and widening the floor did nothing because the
       * ratchet just pinned to the wider floor.
       *
       * A marker does not choose his distance freely anyway — the stall radius
       * and disc space leave about a metre of play in it. He chooses the ANGLE.
       * So the stick shades a fixed stand-off rather than integrating into one.
       */
      // A marker cheating around stands a touch further off — he is reaching,
      // not crowding — which is both what a real one does and what keeps a hard
      // lean from being a foul the assist walked the player into.
      const want = clampNum(
        PLAY.markDistance + Math.abs(tangent) * MARK_REACH - radial * MARK_CLOSE,
        MARK_MIN, PLAY.markMax - 0.15);
      const a = base + tangent * MARK_SWING;
      return { x: t.loco.pos.x + Math.cos(a) * want, z: t.loco.pos.z + Math.sin(a) * want };
    }

    if (ctx === 'matchup') {
      const foe = this.ai[e.team].matchupOf(e.id);
      const o = foe !== null ? this.byId.get(foe) : undefined;
      if (!o) return null;
      /**
       * You SHADE him, along the line to the disc. Pushing toward the disc
       * presses up and takes the under away at the cost of the deep; pushing
       * away gives a cushion and protects the deep at the cost of the under.
       * That single axis is the whole of off-disc positioning in this sport,
       * and it is the trade a defender is actually making every second.
       */
      const dx = this.discRuntime.state.pos.x - o.loco.pos.x;
      const dz = this.discRuntime.state.pos.z - o.loco.pos.z;
      const dl = Math.hypot(dx, dz) || 1e-6;
      const gx = dx / dl, gz = dz / dl;
      const press = clampNum(m.x * gx + m.z * gz, -1, 1);
      // Lateral stick still shades which side of him you stand on.
      const lx = m.x - press * gx, lz = m.z - press * gz;
      const t = (press + 1) * 0.5;
      const gap = PLAY.deepCushion + (-PLAY.underGap - PLAY.deepCushion) * t;
      return {
        x: o.loco.pos.x - gx * gap + lx * PLAY.shadeOpen,
        z: o.loco.pos.z - gz * gap + lz * PLAY.shadeOpen,
      };
    }
    return null;
  }

  /** Human intent -> the same `DesiredMove` the AI's intents become. */
  private humanDesired(hi: HumanIntent, e: RosterEntry): DesiredMove {
    const d = this.desired;
    const m = hi.move;
    const mag = Math.min(1, m.mag);
    d.dir = mag > 1e-3 ? { x: m.x / Math.max(mag, 1e-6), z: m.z / Math.max(mag, 1e-6) } : null;
    d.speed = undefined;
    d.effort = mag * (0.55 + 0.45 * m.sprint);
    d.maxSpeed = undefined;
    d.mode = m.sprint > 0.55 ? 'sprint' : mag > 0.65 ? 'run' : 'jog';
    /**
     * The held mark replaces the stick's meaning, not the player's control:
     * steer at the point the assist chose, at an effort set by how far away it
     * is, so holding the button parks you in position instead of vibrating
     * across it. Facing stays on the man you are guarding — a defender watches
     * the disc, not his own feet.
     */
    const assist = this.defenceAssist(hi, e);
    if (assist) {
      const ax = assist.x - e.loco.pos.x, az = assist.z - e.loco.pos.z;
      const al = Math.hypot(ax, az);
      d.dir = al > 1e-3 ? { x: ax / al, z: az / al } : null;
      d.effort = clampNum(al * 0.9, 0, 1) * (0.62 + 0.38 * m.sprint);
      d.mode = al > 3.5 ? 'sprint' : 'shuffle';
      d.brake = al < 0.28;
    }
    d.brake = m.brake > 0.5;
    d.jump = hi.defence.bid && !hi.defence.layout;
    d.layout = hi.defence.layout;
    if (d.layout && (hi.defence.layoutX !== 0 || hi.defence.layoutZ !== 0)) {
      d.dir = { x: hi.defence.layoutX, z: hi.defence.layoutZ };
    }
    // Facing: the aim stick wins while it is live, otherwise look where you run.
    d.face = hi.aim.active ? { x: hi.aim.x, z: hi.aim.z }
      : hi.charge.active ? { x: Math.sin(hi.charge.aimYaw), z: Math.cos(hi.charge.aimYaw) }
        : null;
    /**
     * A THROWER IS ANCHORED TO HIS PIVOT. He may turn, and he may step, and he
     * may not travel.
     *
     * The previous rule here only capped effort at 0.22 under a comment
     * claiming "a thrower with an established pivot does not travel" — which
     * made him slow, not anchored. A slow player crossing a hundred-metre pitch
     * is still crossing it, and walking the disc upfield is the one thing
     * Ultimate does not allow at all. It is the rule that makes the sport what
     * it is: possession cannot advance except through the air.
     *
     * So the outward radial component of the stick is removed once the body
     * centre reaches PIVOT_R of the established pivot. Tangential motion is
     * untouched, which is what lets a handler circle his mark and open a break
     * side, and inward motion is untouched so he can always recover. The result
     * is a disc of radius PIVOT_R he can move freely inside and cannot leave —
     * which is what a pivot foot actually is.
     *
     * SINCE THE PIVOT MOVED INTO THE BODY, this is stick shaping and nothing
     * more. `Locomotion.stepPivot` now holds the same radius against the man's
     * own legs — for the AI's throwers as well as the human's — and the limit
     * cycle described below was hard contact splitting its positional
     * correction by inverse mass, which `invMass` has since fixed. What is left
     * here matters in one window only: during the momentum allowance after a
     * catch, when locomotion has not established a foot yet and the stick can
     * still ask for more ground than the rules will pay for.
     */
    if (this.gs.thrower === e.id && this.gs.phase === 'LIVE_POSSESSION') {
      d.effort = Math.min(d.effort ?? 1, 0.34);
      d.mode = 'jog';
      const px = e.loco.pos.x - this.gs.pivot.x;
      const pz = e.loco.pos.z - this.gs.pivot.z;
      const r = Math.hypot(px, pz);
      if (r > PIVOT_R) {
        /**
         * Outside the pivot disc he RETURNS, he does not merely stop leaving.
         *
         * Stripping the outward component alone is not enough, and the first
         * version of this did exactly that and measured 5.47 m of drift. A
         * receiver catches at sprint, coasts out on momentum the steering
         * cannot cancel, and then orbits at whatever radius he happened to
         * stop at — legal-looking every frame, and the disc has still moved
         * five metres up the pitch. Ultimate's actual rule is that a thrower
         * carried past his pivot by momentum must come BACK to it, which is
         * both the correct model and the only self-correcting one.
         *
         * Inward pull ramps with the excess so a small overshoot still leaves
         * the handler his tangential freedom to work the mark, while a real
         * excursion is dragged home.
         */
        const nx = px / r, nz = pz / r;
        const pull = Math.min(1, (r - PIVOT_R) / PIVOT_R);
        let dx = -nx * pull;
        let dz = -nz * pull;
        if (d.dir) {
          const outward = d.dir.x * nx + d.dir.z * nz;
          const tx = d.dir.x - Math.max(0, outward) * nx;
          const tz = d.dir.z - Math.max(0, outward) * nz;
          dx += tx * (1 - pull);
          dz += tz * (1 - pull);
        }
        const l = Math.hypot(dx, dz);
        if (l < 1e-4) { d.dir = null; d.effort = 0; } else {
          d.dir = { x: dx / l, z: dz / l };
          d.effort = Math.max(d.effort ?? 0, 0.30 * pull);
        }
      }
    }
    return d;
  }

  /**
   * The one case where the controlled body moves without being told to.
   *
   * `AI.ts` sends exactly ONE player after a dead disc — the nearest — and the
   * other six re-form. The human path throws away that player's AI intent, so
   * if the nearest happens to be the body the human is driving and the human is
   * not pushing the stick, nobody ever reaches the disc: `orchestrate`'s
   * pick-up backstop needs someone inside 3.6 m and there is no one. Measured
   * with an idle human over five seeds and 400 s each, this deadlocks the match
   * outright — seed 7 sat in `TURNOVER_DEAD` for 152 s and was still sitting
   * there when the run ended.
   *
   * So after a full second of a dead disc with the stick at rest, the collector
   * is handed back to his own AI, which walks him over and picks it up. It is
   * the same judgement `orchestrate` already makes one line lower — a match
   * that cannot restart is worse than a body that took a step you did not ask
   * for — and it costs the player nothing, because ANY stick input (mag > 0.05)
   * takes the body straight back. Nothing else about him is ever overridden:
   * `humanAction` still runs, so a bid is still a bid.
   */
  private idleCollector(hi: HumanIntent, e: RosterEntry): boolean {
    const gs = this.gs;
    if (gs.phase !== 'TURNOVER_DEAD') return false;
    if (gs.possession === null || e.team !== gs.possession) return false;
    if (hi.move.mag > IDLE_MOVE) return false;
    if (gs.phaseTimer < COLLECT_PATIENCE) return false;
    if (!this.loco.isAvailable(e.loco)) return false;
    // Only the man the AI would have sent, and only while nobody else is
    // already standing over it.
    const dx = gs.discPos.x, dz = gs.discPos.z;
    const mine = Math.hypot(e.loco.pos.x - dx, e.loco.pos.z - dz);
    if (mine <= PICKUP_RADIUS) return false;
    for (const o of this.roster) {
      if (o.team !== e.team || o.id === e.id) continue;
      if (!this.loco.isAvailable(o.loco)) continue;
      if (Math.hypot(o.loco.pos.x - dx, o.loco.pos.z - dz) < mine) return false;
    }
    return true;
  }

  /** Human intent -> the same one-shot `PlayerAction` the AI emits. */
  private humanAction(hi: HumanIntent, e: RosterEntry): PlayerAction | null {
    if (hi.release.fired && this.gs.thrower === e.id && this.gs.phase === 'LIVE_POSSESSION') {
      const type = HUMAN_THROW_MAP[hi.release.type] ?? 'backhand';
      const q = hi.release.quality;
      // Aim assist first, jitter second, and in that order on purpose: the
      // assist is a correction to what the player POINTED at, and the spread is
      // the hand shaking on what he actually threw. Reversing them would let a
      // sloppy release be quietly cleaned up by the assist.
      const yaw = this.assistedYaw(e, hi.release.aimYaw, q, hi.release.power);
      // Release quality is spread, exactly as it is for the AI: a rushed or
      // overcharged throw wanders, a perfect one goes where it was pointed.
      const spread = (1 - q) * 0.16 + (1 - hi.release.steadiness) * 0.05;
      const jitter = this.rng.gauss() * spread;
      const dir = yaw + jitter;
      this.humanThrow(e, type, dir, hi.release.power, hi.release.tilt, q);
      return null;
    }
    if (hi.defence.bid) return { kind: 'bid', x: this.discRuntime.state.pos.x, z: this.discRuntime.state.pos.z, extend: 1.2 };
    return null;
  }

  private cycleReceiver(delta: number): void {
    const team = this.gs.possession ?? this.humanTeam;
    const mates = this.roster.filter((r) => r.team === team && r.id !== this.gs.thrower);
    if (!mates.length) return;
    let i = mates.findIndex((r) => r.id === this.selectedReceiver);
    i = (i + (delta > 0 ? 1 : -1) + mates.length * 2) % mates.length;
    this.selectedReceiver = mates[i].id;
  }

  /* ============================================== receiver targeting (§2) */

  /**
   * One step of the targeting layer.
   *
   * Runs before the AI so a commanded cut is a cut this step. Everything it
   * reads is either the human's intent for this step or the rules machine's
   * state; nothing here can change a body's position, only which body the game
   * is pointing at.
   */
  private stepTargeting(dt: number, ctx: Ctx): void {
    if (this.cutRoute) {
      this.cutRouteAge += dt;
      if (this.cutRouteAge > CUT_GHOST_TIME) { this.cutRoute = null; this.cutRouteFor = -1; }
    }

    const gs = this.gs;
    const thrower = gs.thrower !== null ? this.byId.get(gs.thrower) : undefined;
    const live = gs.phase === 'LIVE_POSSESSION' && !!thrower
      && gs.possession !== null && thrower.team === gs.possession;
    if (!live || !thrower) { this.cutHeld = false; return; }

    const hi = this.liveHumanIntent(ctx);
    const driving = !!hi && this.controlledPlayerId === thrower.id;

    if (hi && driving) {
      const rc = hi.receiver;
      if (rc.cycle !== 0) { this.cycleReceiver(rc.cycle); this.selectSource = 'human'; }
      if (rc.slot >= 0) this.selectSlot(rc.slot, thrower);
      // The flick: RS past `selectThreshold` commits a direction, and the game
      // resolves it to a body. Free aim stays authoritative — this only decides
      // who the bracket, the assist and the callCut are talking about.
      if (rc.selectFresh) {
        const id = this.resolveConeSelect(rc.selectX, rc.selectZ, thrower);
        if (id >= 0) {
          this.selectedReceiver = id;
          this.selectSource = 'human';
          this.announceSelection(ctx, 'cone');
        }
      }
      // Hold it and the selected receiver runs the cut the stick indicates.
      const wantCut = rc.callCut && (rc.selectX !== 0 || rc.selectZ !== 0);
      if (wantCut && (!this.cutHeld || this.cutCommandFor !== this.selectedReceiver)) {
        this.commandCut(ctx, rc.selectX, rc.selectZ);
      }
      this.cutHeld = wantCut;
    } else {
      this.cutHeld = false;
    }

    // A selection that has stopped making sense is dropped rather than aimed at.
    if (this.selectedReceiver >= 0) {
      const r = this.byId.get(this.selectedReceiver);
      if (!r || r.team !== thrower.team || r.id === thrower.id || !this.loco.isAvailable(r.loco)) {
        this.selectedReceiver = -1;
        this.selectSource = 'none';
        this.selectedLane = null;
      }
    }

    // The dump default: at stall 7 the panic button is already aimed.
    if (this.selectedReceiver < 0 && gs.stallCount >= DUMP_STALL) {
      const id = this.resetHandler(thrower);
      if (id >= 0) {
        this.selectedReceiver = id;
        this.selectSource = 'dump';
        this.selectedLane = this.laneOfPlayer(id, thrower.team);
        this.announceSelection(ctx, 'dump');
      }
    }
  }

  /**
   * Resolve a stick direction to the teammate it means.
   *
   * A 35-degree half-angle cone out of the thrower, scored 60% angular fit /
   * 25% lane openness / 15% distance sanity — the brief's numbers exactly. The
   * cone is generous because the stick is a coarse instrument; the lane term is
   * what stops it from handing you the man standing behind a defender, and the
   * distance term is what stops a 2 m dish and a 55 m prayer from outscoring
   * the 20 m cut you were obviously looking at.
   *
   * Returns the receiver id, or -1 if the cone is empty.
   */
  private resolveConeSelect(dx: number, dz: number, thrower: RosterEntry): number {
    this.candidates.length = 0;
    const l = Math.hypot(dx, dz);
    if (!(l > 1e-3)) return -1;
    const ux = dx / l, uz = dz / l;
    const ox = thrower.loco.pos.x, oz = thrower.loco.pos.z;

    let best = -1;
    let bestScore = -1;
    for (const r of this.roster) {
      if (r.team !== thrower.team || r.id === thrower.id) continue;
      if (!this.loco.isAvailable(r.loco)) continue;
      const vx = r.loco.pos.x - ox, vz = r.loco.pos.z - oz;
      const d = Math.hypot(vx, vz);
      if (d < SELECT_MIN_RANGE) continue;
      const cos = clampNum((vx * ux + vz * uz) / d, -1, 1);
      const angle = Math.acos(cos);
      if (angle > SELECT_CONE) continue;

      const angular = 1 - angle / SELECT_CONE;
      const openness = 1 - this.laneBlockage(ox, oz, r);
      // Sane range for a thrown disc: everything from a 6 m dish out to a 30 m
      // strike is worth full marks, tapering to nothing at the 46 m the arm
      // cannot reach anyway.
      const sanity = smooth01(d, 2.0, 6.0) * (1 - smooth01(d, 30, 46));
      const score = SELECT_W_ANGLE * angular + SELECT_W_LANE * openness + SELECT_W_DIST * sanity;
      this.candidates.push({ id: r.id, angle, angular, openness, distance: d, sanity, score });
      if (score > bestScore) { bestScore = score; best = r.id; }
    }
    if (best >= 0) this.selectedLane = this.laneOfPlayer(best, thrower.team);
    return best;
  }

  /**
   * How blocked the straight lane from the disc to a receiver is, 0..1.
   *
   * Deliberately the same model `TeamAI.laneBlockage` runs — a defender counts
   * for how much of the corridor he can put a hand into by the time the disc
   * gets there, scaled by his awareness — expressed against a ground corridor
   * rather than a sampled flight, and built out of `AI.ts`'s own exported
   * primitives (`effectiveMaxSpeed`, `throwFlightTime`) so the two cannot drift
   * apart in their tuning. It lives here rather than in `AI.ts` because the
   * AI's copy is private to `TeamAI` and this file owns only the one command
   * entry point over there.
   *
   * The first 0.6 m and the last 22% are skipped for the same reason the AI
   * skips them: the release window belongs to the mark and the tail belongs to
   * the receiver's own defender, which is separation, not blockage.
   */
  private laneBlockage(ox: number, oz: number, r: RosterEntry): number {
    const tx = r.loco.pos.x, tz = r.loco.pos.z;
    const len = Math.hypot(tx - ox, tz - oz);
    if (len < 1e-3) return 0;
    const ux = (tx - ox) / len, uz = (tz - oz) / len;
    const tf = throwFlightTime(r.ai, 'backhand', len);
    let worst = 0;
    for (const f of this.roster) {
      if (f.team === r.team) continue;
      if (!this.loco.isAvailable(f.loco)) continue;
      const rx = f.loco.pos.x - ox, rz = f.loco.pos.z - oz;
      const along = rx * ux + rz * uz;
      if (along < 0.6 || along > len * 0.78) continue;
      const perp = Math.abs(rx * uz - rz * ux);
      const t = (along / len) * tf;
      const reachable = 0.60 + effectiveMaxSpeed(f.ai) * Math.max(0, t - 0.14) * 0.72;
      const awareness = 0.55 + 0.45 * (f.ai.attr.defAwareness / 100);
      const w = clampNum((reachable - perp) / 1.4, 0, 1) * awareness;
      if (w > worst) worst = w;
    }
    return clampNum(worst, 0, 0.97);
  }

  /** Keyboard 1-7 direct select, mapped through the possession team's roster. */
  private selectSlot(slot: number, thrower: RosterEntry): void {
    const mates = this.roster.filter((r) => r.team === thrower.team && r.id !== thrower.id);
    const r = mates[clampNum(slot, 0, mates.length - 1) | 0];
    if (!r || !this.loco.isAvailable(r.loco)) return;
    this.selectedReceiver = r.id;
    this.selectSource = 'human';
    this.selectedLane = this.laneOfPlayer(r.id, thrower.team);
  }

  /** `Playbook.laneOf` against the live disc — the HUD's name for the throw. */
  private laneOfPlayer(id: number, team: TeamId): LaneKey | null {
    const r = this.byId.get(id);
    if (!r) return null;
    const s = this.discRuntime.state.pos;
    return laneOf(r.loco.pos.x, r.loco.pos.z, { x: s.x, z: s.z },
      this.gs.attackDir[team], this.ai[team].openSign as Sign);
  }

  /**
   * The reset handler: the nearest available handler BEHIND the disc.
   *
   * "Behind" is what makes it a reset rather than a second cutter in the lane,
   * and it is the whole reason this selection is safe to make automatically.
   * Non-handlers are eligible but carry a 25 m penalty, so one is only ever
   * chosen when there is genuinely no handler back there.
   */
  private resetHandler(thrower: RosterEntry): number {
    const dir = this.gs.attackDir[thrower.team];
    const s = this.discRuntime.state.pos;
    let best = -1;
    let bestScore = Infinity;
    for (const r of this.roster) {
      if (r.team !== thrower.team || r.id === thrower.id) continue;
      if (!this.loco.isAvailable(r.loco)) continue;
      if (dir * (r.loco.pos.z - s.z) > 1.0) continue;
      const d = Math.hypot(r.loco.pos.x - s.x, r.loco.pos.z - s.z);
      const isHandler = r.ai.role === 'handler' || r.archetype === 'handler';
      const score = d + (isHandler ? 0 : 25);
      if (score < bestScore) { bestScore = score; best = r.id; }
    }
    return best;
  }

  /**
   * Send the selected receiver on the cut the stick indicates.
   *
   * The whole of the command is `TeamAI.commandCut` — the one documented entry
   * point this file adds to `AI.ts`. Everything after it is presentation: the
   * route is kept for 1.5 s so `Gameplay.ts` can draw the order that was given
   * next to the execution of it.
   */
  private commandCut(ctx: Ctx, dx: number, dz: number): void {
    const gs = this.gs;
    const id = this.selectedReceiver;
    this.cutCommandFor = id;
    if (id < 0 || gs.possession === null) return;
    const r = this.byId.get(id);
    if (!r || r.team !== gs.possession) return;
    const s = this.discRuntime.state.pos;
    const cut = this.ai[gs.possession].commandCut(id, dx, dz, { x: s.x, z: s.z });
    if (!cut) return;
    this.cutRoute = cut;
    this.cutRouteFor = id;
    this.cutRouteAge = 0;
    ctx.events.emit('input:cut', {
      playerId: id, kind: cut.kind, lane: cut.lane,
      setupX: cut.setup.x, setupZ: cut.setup.z,
      targetX: cut.target.x, targetZ: cut.target.z,
      ttl: CUT_GHOST_TIME,
    });
  }

  private announceSelection(ctx: Ctx, how: 'cone' | 'dump'): void {
    const r = this.byId.get(this.selectedReceiver);
    if (!r) return;
    ctx.events.emit('receiver:selected', {
      playerId: r.id, how, lane: this.selectedLane,
      x: r.loco.pos.x, z: r.loco.pos.z,
    });
  }

  /**
   * Quality-scaled aim assist (§2).
   *
   * If a receiver is selected and the raw aim is already within 12 degrees of
   * the ideal lead, rotate toward the lead by up to 5 degrees, scaled by
   * release quality — a perfect-window release gets all 5, a rushed one gets
   * almost none. Timing skill buys accuracy; it does not buy aim. Outside the
   * 12-degree window nothing happens at all, because at that point the player
   * is throwing somewhere else on purpose and the disc must go there.
   *
   * The lead is solved against the receiver's own velocity in two passes, which
   * is the same converging lead `AI.ts` uses and is accurate to well inside the
   * 5 degrees this is allowed to move.
   */
  private assistedYaw(e: RosterEntry, yaw: number, quality: number, power: number): number {
    this.lastAssist = 0;
    this.lastLeadErr = 0;
    const id = this.selectedReceiver;
    if (id < 0) return yaw;
    const r = this.byId.get(id);
    if (!r || r.team !== e.team || r.id === e.id) return yaw;

    this.releaseOrigin(e, _from);
    const speed = clampNum(9 + 19 * power, 8, 27);
    let lx = r.loco.pos.x, lz = r.loco.pos.z;
    for (let i = 0; i < 2; i++) {
      const d = Math.hypot(lx - _from.x, lz - _from.z);
      const t = clampNum(d / (speed * 0.82), 0, 3.5);
      lx = r.loco.pos.x + r.loco.vel.x * t;
      lz = r.loco.pos.z + r.loco.vel.z * t;
    }
    const ideal = Math.atan2(lx - _from.x, lz - _from.z);
    const err = wrapPi(ideal - yaw);
    this.lastLeadErr = err;
    if (Math.abs(err) > ASSIST_WINDOW) return yaw;
    const rot = clampNum(err, -ASSIST_MAX, ASSIST_MAX) * clampNum(quality, 0, 1);
    this.lastAssist = rot;
    return yaw + rot;
  }

  /* --------------------------------------------------------------- actions */

  private dispatchActions(): void {
    for (const [id, action] of this.actionOf) {
      if (!action) continue;
      const e = this.byId.get(id);
      if (!e) continue;
      switch (action.kind) {
        case 'throw': {
          if (this.gs.phase !== 'LIVE_POSSESSION' || this.gs.thrower !== id) break;
          this.beginThrow(e, action);
          break;
        }
        case 'pickup': {
          if (this.gs.phase !== 'TURNOVER_DEAD') break;
          this.tryPickup(e);
          break;
        }
        default: break;
      }
    }
  }

  /* ---------------------------------------------------------------- throws */

  /**
   * THE WINDUP.
   *
   * The AI decides to throw and, until now, the disc left the hand on the same
   * frame — so the animator's whole throw layer (`anim/Upper.ts`: coil, reach
   * back, whip, follow-through) only ever played AFTER the disc had gone. On
   * screen a pass was a disc teleporting out of a standing body, and the one
   * unmistakable gesture in the sport never appeared in live play at all.
   *
   * So a throw is now latched for `WINDUP` seconds. The disc stays in the hand
   * — `carryDisc()` keeps pinning it to the grip every frame — while the
   * animator plays the coil, and only then does the solver run. The aim is
   * re-read each frame while the AI still wants the same throw, so the receiver
   * moving during the windup does not cost the pass.
   *
   * Cancelled the instant the situation stops being a live throw: a block, a
   * turnover, a stall-out or the thrower changing all drop the latch, which is
   * the fake-and-hold case as well as the safety case.
   */
  private beginThrow(e: RosterEntry, act: Extract<PlayerAction, { kind: 'throw' }>): void {
    const p = this.pending;
    // Refresh the aim on every frame the AI still wants this throw, keeping the
    // coil that is already running. The struct is COPIED, never aliased: the AI
    // reuses its action objects between frames and the lead correction below
    // writes to the aim.
    if (p && p.id === e.id) { copyThrow(act, p); p.since = 0; return; }
    if (p) return;                                     // somebody else is already winding
    const n: PendingThrow = {
      id: e.id, t: 0, since: 0,
      throwType: act.throwType, aimX: 0, aimY: 0, aimZ: 0, speed: 0, receiverId: -1,
    };
    copyThrow(act, n);
    this.pending = n;
  }

  /**
   * Seconds of coil before an AI release. Measured against the match, not
   * chosen — 1800 s of headless simulation per value, same seed:
   *
   *   windup   points   throws   completions   turnovers
   *   0 (was)      18      251       183 (73%)        72
   *   0.10         14      266       198 (74%)        72
   *   0.16         12      247       173 (70%)        82
   *   0.22         10      192       145 (76%)        52   <- and one assertion
   *
   * The cost is not the delay itself (0.22 s x 192 throws is 42 s out of 1800);
   * it is that `AI.ts` solves its aim as a lead for a release on THIS frame, so
   * every millisecond of coil is aim error, and a throwaway at the front of your
   * own offence costs the length of the field. `stepWindup` carries the aim
   * forward at the receiver's velocity, which pays for most of it, and 0.10 s is
   * where throughput and completion rate are both back at or above the
   * no-windup baseline. Twelve fixed steps is still a coil the eye reads, and
   * the follow-through — which is most of what a throw looks like — runs on
   * after the release regardless of how long the windup was.
   */
  private static readonly WINDUP = 0.10;

  private pending: PendingThrow | null = null;

  /**
   * Advance a latched windup, publish the charge the animator poses off, and
   * fire when the coil is complete. Runs after the actions are dispatched so a
   * throw decided this frame gets its first slice of windup on this frame.
   */
  private stepWindup(dt: number, ctx: Ctx): void {
    const p = this.pending;
    if (!p) return;
    const e = this.byId.get(p.id);
    if (!e || this.gs.phase !== 'LIVE_POSSESSION' || this.gs.thrower !== p.id) {
      this.cancelWindup(ctx);
      return;
    }
    /**
     * NOT cancelled when the AI stops asking.
     *
     * The obvious safety valve — "if the AI has withdrawn the throw, retract it
     * as a pump fake" — was measured and is wrong, because `AI.ts` emits a throw
     * as a ONE-SHOT decision on a single frame and never re-asserts it. Gating
     * on a re-assertion cancelled 159 throws out of 160 over half an hour of
     * match and the whole game became stall-outs. The staleness is instead paid
     * for by keeping the coil short and by tracking the receiver through it.
     */
    p.since += dt;
    p.t += dt;
    const full = GameSystem.WINDUP;
    // Track the receiver through the coil. The AI's aim point is a lead solved
    // for a release THIS frame; carrying it forward at the receiver's current
    // velocity keeps it a lead for the release that actually happens.
    const rcv = p.receiverId >= 0 ? this.byId.get(p.receiverId) : undefined;
    if (rcv) { p.aimX += rcv.loco.vel.x * dt; p.aimZ += rcv.loco.vel.z * dt; }
    if (p.t < full) {
      // `Animator.bindEvents` turns this into `AnimHandle.setCharge`, which is
      // the same struct the human input system pushes — one windup path for
      // both, so a controlled thrower and an AI thrower coil identically.
      ctx.events.emit('disc:charge', {
        playerId: p.id, active: true, hold: p.t, power: clampNum(p.speed / 22, 0.15, 1),
        type: p.throwType, tilt: 0,
        aimYaw: Math.atan2(p.aimX - e.loco.pos.x, p.aimZ - e.loco.pos.z),
        targetHold: full, maxHold: full * 1.6,
      });
      return;
    }
    this.pending = null;
    this.aiThrow(e, p);
  }

  private cancelWindup(ctx: Ctx, fake = false): void {
    if (!this.pending) return;
    const id = this.pending.id;
    this.pending = null;
    ctx.events.emit('disc:charge', { playerId: id, active: false, fake, hold: 0, power: 0 });
  }

  /**
   * Solve the release for an AI throw.
   *
   * The AI hands us a point it wants the disc to arrive at. A disc is not a
   * projectile — lift, drag and precession move the landing point tens of
   * metres — so the launch elevation is bisected against the real integrator
   * and the heading is then corrected for the curve the disc actually flew.
   * Two outer passes is enough to land inside a receiver's catch radius, and it
   * costs a couple of milliseconds on the frame a throw is released.
   */
  private aiThrow(e: RosterEntry, act: ThrowIntent): void {
    const type = THROW_MAP[act.throwType] ?? 'backhand';
    const hand: 'R' | 'L' = e.ai.handed === 'left' ? 'L' : 'R';
    this.releaseOrigin(e, _from);
    const tx = act.aimX - _from.x, tz = act.aimZ - _from.z;
    const want = Math.hypot(tx, tz);
    if (want < 0.4) return;

    const spin = clampNum(0.45 + 0.55 * (e.ai.attr.throwPower / 100), 0, 1);
    const power = clampNum(powerForSpeed(type, act.speed) * 1.02, 0.12, 1);
    const catchY = Math.max(0.35, act.aimY);

    let heading = Math.atan2(tx, tz);
    let angle = 0.02;
    const req: ThrowRequest = {
      type, from: _from, aim: _aim, power, angle, spin, hand, bank: 0,
    };

    for (let pass = 0; pass < 2; pass++) {
      // Bisect the elevation for range.
      let lo = -0.34, hi = 0.62;
      let best = angle, bestErr = Infinity, lat = 0;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) * 0.5;
        req.angle = mid;
        _aim.set(Math.sin(heading), 0, Math.cos(heading));
        const r = this.discRuntime.probeThrow(req, catchY, 6);
        const err = r.dist - want;
        if (Math.abs(err) < Math.abs(bestErr)) { bestErr = err; best = mid; lat = r.lat; }
        if (err < 0) lo = mid; else hi = mid;
      }
      angle = best;
      req.angle = best;
      // Correct the heading for the curve the disc actually flew.
      if (Math.abs(lat) > 0.25 && want > 1) heading -= Math.atan2(lat, want);
      if (pass === 1 || Math.abs(lat) <= 0.25) break;
    }

    _aim.set(Math.sin(heading), 0, Math.cos(heading));
    req.angle = angle;
    const vel = this.discRuntime.release(req);
    this.commitRelease(e, type, act.receiverId, vel);
  }

  private humanThrow(
    e: RosterEntry, type: PhysThrowType, yaw: number, power: number,
    tilt: number, quality: number,
  ): void {
    this.releaseOrigin(e, _from);
    _aim.set(Math.sin(yaw), 0, Math.cos(yaw));
    const hand: 'R' | 'L' = e.ai.handed === 'left' ? 'L' : 'R';
    /**
     * Power buys distance; the stick's tilt buys curve; quality buys a clean
     * nose. An overcharged release comes out nose-up and dies.
     *
     * TWO THINGS HERE ARE NOT THE OBVIOUS THING, and both were measured.
     *
     * THE PLAYER MUST BE ABLE TO THROW SHORT. Mapping the charge across the
     * throw's own `power` range cannot do it: the backhand spec floors at
     * 12 m/s, and a 12 m/s backhand carries about 20 m no matter what the
     * trigger says. Measured on the old mapping, a release at ZERO charge still
     * flew 23.6 m — there was no dump, no reset, no five-metre swing, only
     * bombs. So the charge drives an absolute release speed from
     * `MIN_THROW_SPEED` up to the throw's own maximum, which puts a tap at
     * about 10 m and full charge at about 47 m.
     *
     * A HUCK NEEDS HYZER OR THE CURVE INVERTS UNDER THE PLAYER. The disc turns
     * over at speed, so with a flat release the drift on a backhand ran
     * +3.1, +4.6, +4.3, +0.1, -3.3, -8.4, -16.7 m as the charge went up: aim at
     * a receiver, pull the trigger harder, and the disc finishes seventeen
     * metres the OTHER side of him. That is not difficulty, it is a control
     * that lies. Real throwers put hyzer on a huck for exactly this reason, and
     * a power-squared term does the same job here — it collapses the drift
     * range from +/-19.7 m to 6.4 m and leaves it same-signed all the way up,
     * so the curve is something you can lead. It costs about 6 m of maximum
     * distance, which is the right trade for a throw that goes where it is
     * pointed.
     */
    const r = humanReleaseParams(type, power, quality, tilt);
    const vel = this.discRuntime.release({
      type, from: _from, aim: _aim, hand, power: 1,
      speed: r.speed, angle: r.angle, spin: r.spin, bank: r.bank, nose: r.nose,
    });
    this.commitRelease(e, type, this.selectedReceiver, vel);
  }

  private commitRelease(e: RosterEntry, type: PhysThrowType, receiverId: number, vel: THREE.Vector3): void {
    const s = this.discRuntime.state;
    this.thrownBy = e.id;
    this.intendedReceiver = receiverId;
    /**
     * Control follows the disc, 0.1 s behind it (§3).
     *
     * The tenth of a second is the follow-through: yanking the avatar on the
     * release frame steals the one gesture the thrower makes. After it, the
     * human is the receiver — which hands them the catch, the layout bid and
     * the first pivot, and those three are where the game lives. With no
     * receiver selected the handoff is skipped and control moves at the catch
     * instead, in `onCaught`.
     */
    this.handoffTo = (e.team === this.humanTeam && receiverId >= 0 && this.byId.has(receiverId))
      ? receiverId : -1;
    this.handoffAt = this.simT + HANDOFF_DELAY;
    this.hadInBounds = isInBounds({ x: s.pos.x, y: 0, z: s.pos.z });
    this.lastInBounds.copy(s.pos);
    this.flightSettled = false;
    this.discRuntime.lastThrowTeam = e.team;
    this.gs.release({
      playerId: e.id,
      pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
      vel: { x: vel.x, y: vel.y, z: vel.z },
      spin: s.spin,
      throwType: type,
    });
  }

  /* ------------------------------------------------------------------ disc */

  /**
   * The rules machine owns *who has the disc*; the physics owns *where it is*
   * while it is live. Reconciling the two here — rather than at each of the
   * dozen call sites that can change possession — is what stops a disc caught
   * out of bounds from staying glued to the hand that caught it while the rules
   * quietly wait for the other team to pick it up off the line.
   */
  private syncDiscOwnership(): void {
    const gs = this.gs;
    const rt = this.discRuntime;
    switch (gs.phase) {
      case 'LIVE_POSSESSION':
      case 'CHECK': {
        if (gs.thrower !== null && this.byId.has(gs.thrower)
          && (rt.mode !== 'held' || rt.holderId !== gs.thrower)) {
          rt.mode = 'held';
          rt.holderId = gs.thrower;
        }
        break;
      }
      case 'TURNOVER_DEAD':
      case 'PRE_PULL': {
        _v.set(gs.discPos.x, 0, gs.discPos.z);
        if (rt.mode !== 'ground' || _v.distanceToSquared(rt.state.pos) > 0.04) rt.settle(_v);
        break;
      }
      default: break;
    }
  }

  private stepDisc(dt: number): void {
    const rt = this.discRuntime;
    const phase = this.gs.phase;

    this.syncDiscOwnership();
    if (rt.mode === 'held') { this.carryDisc(); return; }
    if (rt.mode === 'ground') return;

    rt.step(dt);
    const s = rt.state;
    if (isInBounds({ x: s.pos.x, y: 0, z: s.pos.z })) {
      this.lastInBounds.copy(s.pos);
      this.hadInBounds = true;
    }

    const inFlightPhase = phase === 'DISC_IN_FLIGHT' || phase === 'PULL_IN_FLIGHT';
    if (!inFlightPhase) return;

    if (rt.sinceRelease > RELEASE_DEADTIME && this.tryCatch(phase)) return;

    if (s.touchedGround && !this.flightSettled) {
      this.flightSettled = true;
      const at: Vec3 = { x: s.pos.x, y: 0, z: s.pos.z };
      rt.markScuff(clampNum(Math.hypot(s.vel.x, s.vel.z) / 14 + 0.35, 0.3, 1));
      if (isInBounds(at)) {
        if (phase === 'PULL_IN_FLIGHT') this.gs.pullLanded(at);
        else this.gs.ground(at);
      } else if (this.hadInBounds) {
        this.gs.outOfBoundsSegment(
          { x: this.lastInBounds.x, y: 0, z: this.lastInBounds.z }, at);
      } else {
        this.gs.outOfBounds(clampToField(at));
      }
      rt.mode = 'ground';
    }
  }

  /**
   * Pin a held disc into the thrower's hand.
   *
   * If the character system is present and offers a hand anchor we use its rig
   * — that is the only way the disc sits in a *hand* rather than near a hip. It
   * is probed once and disabled for good if it throws or returns nonsense, so a
   * peer under construction can never break the match.
   */
  private carryDisc(): void {
    const e = this.byId.get(this.discRuntime.holderId);
    if (!e) return;
    if (this.handAnchor !== false && this.carryFromRig(e)) return;
    const lp = e.loco;
    const right = e.ai.handed === 'left' ? -1 : 1;
    const f = lp.facing;
    const fx = Math.sin(f), fz = Math.cos(f);
    const rx = fz * right, rz = -fx * right;

    // Cocked back on the throwing side, plate roughly vertical — the way a
    // handler actually stands with it while reading the field.
    const wind = this.gs.stallCount > 0 ? Math.sin(this.gs.clock * 2.4) * 0.10 : 0;
    _v.set(
      lp.pos.x + rx * (0.30 + wind) - fx * 0.06,
      lp.groundY + lp.hipHeight * 1.10,
      lp.pos.z + rz * (0.30 + wind) - fz * 0.06,
    );
    // Face of the disc points out to the throwing side and slightly up.
    _norm.set(rx * 0.86, 0.42, rz * 0.86).normalize();
    // Roll about the face normal is a property of the grip, not of the clock —
    // driving it from `gs.clock` made a held disc twirl in a motionless hand.
    this.discRuntime.hold(e.id, _v, _norm, 0.35 + e.id * 0.41);
  }

  /** null = not probed yet, false = the peer does not offer one (or misbehaved). */
  private handAnchor: HandAnchorFn | false | null = null;
  private sysRef: Record<string, unknown> | undefined;

  /**
   * Resolve `ctx.sys.players.discAnchor` lazily.
   *
   * The character system registers itself one slot AFTER us, and a tableau can
   * be applied on the very first frame — so "the peer is not there yet" must not
   * be cached as "the peer does not exist". Only a peer that is present and
   * misbehaves is latched off for good.
   */
  private resolveHandAnchor(): HandAnchorFn | null {
    if (this.handAnchor === false) return null;
    if (this.handAnchor) return this.handAnchor;
    const peer = this.sysRef?.['players'] as Record<string, unknown> | undefined;
    if (!peer) return null;                       // not built yet — retry next call
    const fn = peer['discAnchor'] ?? peer['handAnchor'];
    if (typeof fn !== 'function') { this.handAnchor = false; return null; }
    this.handAnchor = (fn as HandAnchorFn).bind(peer) as HandAnchorFn;
    return this.handAnchor;
  }

  /** Probe the rig for the grip point. Fills `_v` / `_norm`; false = no rig. */
  private gripOf(id: number): boolean {
    const fn = this.resolveHandAnchor();
    if (!fn) return false;
    try {
      if (!fn(id, _v, _norm)) return false;
    } catch { this.handAnchor = false; return false; }
    if (!Number.isFinite(_v.x) || !Number.isFinite(_v.y) || !Number.isFinite(_v.z)
      || !(_norm.lengthSq() > 1e-6)) { this.handAnchor = false; return false; }
    return true;
  }

  private carryFromRig(e: RosterEntry): boolean {
    if (!this.gripOf(e.id)) return false;
    this.discRuntime.hold(e.id, _v, _norm.normalize(), this.gs.clock * 0.6);
    return true;
  }

  /**
   * Where the disc actually leaves the body.
   *
   * The rig knows: `ctx.sys.players.discAnchor` reports the world point the disc
   * occupies in the grip, so a release solved from there starts the flight at the
   * hand rather than at the pelvis. Without a character system — headless tests,
   * a stubbed peer — it falls back to a point off the throwing hip, which is
   * where the disc is drawn in that case anyway.
   *
   * A grip that has ended up inside the turf (a rig mid-layout, a bad frame) is
   * rejected: a disc released below the grass lands on the frame it is thrown.
   */
  private releaseOrigin(e: RosterEntry, out: THREE.Vector3): THREE.Vector3 {
    const lp = e.loco;
    if (this.gripOf(e.id) && _v.y > lp.groundY + 0.45) return out.copy(_v);
    const right = e.ai.handed === 'left' ? -1 : 1;
    const f = lp.facing;
    const fx = Math.sin(f), fz = Math.cos(f);
    return out.set(
      lp.pos.x + fz * right * 0.34 + fx * 0.16,
      lp.groundY + lp.hipHeight * 1.10,
      lp.pos.z - fx * right * 0.34 + fz * 0.16,
    );
  }

  /**
   * Catch resolution. Anyone whose fingertips are on the disc gets a roll; the
   * offence's roll is a catch, the defence's is a D. A failed offensive attempt
   * on a routine disc is charged as a drop — a failed attempt on something at
   * full stretch is just a disc that keeps flying.
   */
  private tryCatch(phase: Phase): boolean {
    const s = this.discRuntime.state;
    const offense: TeamId | null = phase === 'PULL_IN_FLIGHT' ? this.gs.receivingTeam : this.gs.possession;
    let best: RosterEntry | null = null;
    let bestGap = Infinity;
    let bestHigh = 0;

    for (const e of this.roster) {
      const lp = e.loco;
      if (lp.state === 'fall' || lp.state === 'recovery') continue;
      const laidOut = lp.state === 'layout' || (lp.prone && lp.air.airborne);
      const reachXZ = laidOut ? LAYOUT_REACH : CATCH_REACH;
      const gap = Math.hypot(s.pos.x - lp.pos.x, s.pos.z - lp.pos.z);
      if (gap > reachXZ) continue;
      const top = this.loco.reachAt(lp, 0) + 0.16;
      const bot = lp.groundY + (laidOut ? 0.02 : 0.20);
      if (s.pos.y > top || s.pos.y < bot) continue;
      // Defenders only play the disc when they have actually attacked it.
      if (e.team !== offense) {
        const act = this.actionOf.get(e.id);
        const attacking = act?.kind === 'bid' || act?.kind === 'jump' || act?.kind === 'catch';
        if (!attacking && gap > 0.55) continue;
      }
      const high = clampNum((s.pos.y - (lp.groundY + lp.hipHeight + 0.35)) / 0.9, 0, 1);
      const score = gap + high * 0.4 + (e.team === offense ? 0 : 0.25);
      if (score < bestGap) { bestGap = score; best = e; bestHigh = high; }
    }
    if (!best) return false;

    const at: Vec3 = { x: s.pos.x, y: s.pos.y, z: s.pos.z };
    const lp = best.loco;
    const laidOut = lp.state === 'layout' || (lp.prone && lp.air.airborne);
    const speed = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
    const contest = this.contestCount(s.pos.x, s.pos.z, best.team) * 0.30;
    const difficulty = clampNum(
      0.12 + bestHigh * 0.55 + (laidOut ? 0.55 : 0) + contest
      + clampNum((speed - 17) / 22, 0, 0.45),
      0, 1.7,
    );
    let p = catchProbability(best.ai, difficulty);
    if (best.team !== offense) p *= 0.62;              // a D is harder than a catch
    const roll = this.rng.next();

    if (best.team !== offense) {
      /**
       * A PULL CANNOT BE STOLEN, BUT IT CAN BE TOUCHED.
       *
       * The pulling team used to be skipped by this scan outright, so a pull
       * was the one disc in the game nobody could contest: it sailed sixty
       * metres through a defence that was not allowed to exist. Now they can
       * play it — and the moment they do, the disc goes to the receivers.
       *
       * That is the actual rule, not a compromise. A member of the pulling
       * team who touches the pull before the receiving team has touched it has
       * committed a violation (WFDF 12.5), and the receivers get the disc at
       * that spot. So a defender bidding on a pull is a real, legible event
       * with a real cost, which is what it is on a field.
       *
       * Both kinds of touch route the same way. `gs.block()` rejects outside
       * DISC_IN_FLIGHT, so a deflection during a pull would have been silently
       * dropped on the floor — and there is no distinction worth drawing here
       * anyway, because the rule does not care whether you caught it or got a
       * fingertip to it. Any touch is the same violation.
       *
       * Stealing a MUFFED pull is a different matter and already works: once
       * the receiving team puts a hand on it and puts it down, `pullDropped`
       * turns it over and the pulling team may collect it.
       */
      if (phase === 'PULL_IN_FLIGHT') {
        if (roll < p) { this.gs.catchDisc(best.id, at); this.afterTurnoverInAir(); return true; }
        return false;
      }
      if (roll < p * 0.55) { this.gs.catchDisc(best.id, at); this.onCaught(best); return true; }
      if (roll < p) { this.gs.block(best.id, at); this.afterTurnoverInAir(); return true; }
      return false;
    }
    if (roll < p) { this.gs.catchDisc(best.id, at); this.onCaught(best); return true; }
    if (difficulty < 0.85) {
      // Routine, and he put it down.
      if (phase === 'PULL_IN_FLIGHT') this.gs.pullDropped(best.id, at);
      else this.gs.drop(best.id, at);
      this.afterTurnoverInAir();
      return true;
    }
    return false;
  }

  private contestCount(x: number, z: number, team: TeamId): number {
    let n = 0;
    for (const e of this.roster) {
      if (e.team === team) continue;
      if (Math.hypot(e.loco.pos.x - x, e.loco.pos.z - z) < 1.9) n++;
    }
    return Math.min(2, n);
  }

  /**
   * `catchDisc()` does not always mean a completion — a catch beyond the line is
   * a turnover, and an interception can land out of bounds. Read the phase the
   * rules landed in rather than assuming the disc is now in this player's hand.
   */
  private onCaught(e: RosterEntry): void {
    this.thrownBy = -1;
    this.intendedReceiver = -1;
    this.flightSettled = true;
    // Control to the catcher (§3) — but only on a catch that did NOT flip
    // possession. A D or an interception is a turnover, and a turnover owns
    // the next 0.6 s of control by the grace rule, not this line.
    if (e.team === this.humanTeam && this.lastPossession === e.team && this.handoffTo < 0) {
      this.takeControl(e.id, 'catch');
    }
    this.handoffTo = -1;
    if (this.gs.phase === 'TURNOVER_DEAD') { this.afterTurnoverInAir(); return; }
    this.discRuntime.mode = 'held';
    this.discRuntime.holderId = e.id;
    if (this.gs.phase !== 'POINT_SCORED') this.carryDisc();
  }

  private afterTurnoverInAir(): void {
    this.thrownBy = -1;
    this.intendedReceiver = -1;
    this.flightSettled = true;
    this.discRuntime.markScuff(0.5);
    _v.set(this.gs.discPos.x, 0, this.gs.discPos.z);
    this.discRuntime.settle(_v);
  }

  /* ----------------------------------------------------------------- rules */

  private stepRules(dt: number): void {
    const gs = this.gs;
    const thrower = gs.thrower !== null ? this.byId.get(gs.thrower) : undefined;
    const s = this.discRuntime.state;

    let markerId: number | null = null;
    let markerPos: Vec3 | null = null;
    if (thrower) {
      let bd = gs.rules.markerRange + 0.6;
      for (const e of this.roster) {
        if (e.team === thrower.team) continue;
        const d = Math.hypot(e.loco.pos.x - thrower.loco.pos.x, e.loco.pos.z - thrower.loco.pos.z);
        if (d < bd) { bd = d; markerId = e.id; markerPos = { x: e.loco.pos.x, y: 0, z: e.loco.pos.z }; }
      }
    }

    // The physics owns the disc while it is live; the RULES own it while it is
    // dead — `deadDisc()` has already walked it to a legal spot on the line, and
    // reporting the position it physically came to rest at would put it back out
    // of bounds where nobody can legally reach it.
    const liveDisc = gs.phase !== 'TURNOVER_DEAD' && gs.phase !== 'PRE_PULL';

    /**
     * THE PIVOT FOOT, AND THE ONE THING THE RULES LAYER MAY BE TOLD ABOUT IT.
     *
     * `Locomotion` establishes the foot — see `stepPivot` there — and reports it
     * only once it is established. During the momentum allowance after a catch
     * there is no pivot yet and this is `null`, which is exactly right: a
     * receiver still stopping has no foot that could have moved. Reporting his
     * running feet instead (which this used to do) made every catch on the move
     * read as a travel the instant he was 0.35 m past where he caught it.
     *
     * The other half of the same rule is that the pivot is established WHERE HE
     * STOPS, not where he caught it — that is why a receiver keeps the yards his
     * momentum earned him. So the machine's pivot is moved once, at the moment
     * locomotion locks the foot, and every travel after that is measured from
     * there.
     */
    const pivotFoot = thrower && gs.phase === 'LIVE_POSSESSION'
      ? this.loco.pivotOf(thrower.id) : null;
    if (!pivotFoot) {
      this.pivotOwner = -1;
    } else if (this.pivotOwner !== thrower!.id) {
      this.pivotOwner = thrower!.id;
      gs.setPivot({ x: pivotFoot.x, y: 0, z: pivotFoot.z });
    }

    gs.step(dt, {
      discPos: liveDisc ? { x: s.pos.x, y: s.pos.y, z: s.pos.z } : undefined,
      throwerPos: thrower ? { x: thrower.loco.pos.x, y: 0, z: thrower.loco.pos.z } : undefined,
      pivotFoot: pivotFoot ? { x: pivotFoot.x, y: 0, z: pivotFoot.z } : undefined,
      markerId,
      markerPos,
      defenders: thrower ? this.bodiesOf(1 - thrower.team as TeamId) : undefined,
      offence: thrower ? this.bodiesOf(thrower.team) : undefined,
    });

    if (thrower && pivotFoot && markerId !== null
      && gs.phase === 'LIVE_POSSESSION' && gs.thrower === thrower.id) {
      this.callTravel(thrower, pivotFoot, markerId);
    }
  }

  /** Set once the machine has been told where this thrower's pivot is. */
  private pivotOwner = -1;

  /**
   * A travel, called and resolved.
   *
   * `GameState.observe` has already flagged it and written the play-by-play
   * line; a flag is not a call. In a self-officiated sport somebody has to say
   * it, and the only bodies close enough to see the foot are the mark — so a
   * travel nobody is marking is a travel nobody calls, which is both the rule
   * and the reason this is gated on `markerId`.
   *
   * The remedy is WFDF 18.2.4: the thrower returns to his pivot and the count
   * backs up one. `resolveCall` owns both halves of that; all this does is put
   * the body back on the spot the machine kept for it and re-establish the foot
   * there, without which the same call fires again on the very next step.
   *
   * Called only while the phase is still LIVE_POSSESSION and the thrower is
   * still the same man `stepRules` observed. `gs.step` can flip both inside the
   * tick — a stall-out, a release, a team-mate catching — and `gs.pivot` moves
   * with them, which turns last frame's foot into a metre of imaginary travel.
   */
  private callTravel(thrower: RosterEntry, foot: { x: number; z: number }, markerId: number): void {
    const gs = this.gs;
    if (Math.hypot(foot.x - gs.pivot.x, foot.z - gs.pivot.z) <= gs.rules.travelTolerance) return;
    if (!gs.makeCall('travel', markerId, thrower.id, { x: foot.x, y: 0, z: foot.z }).ok) return;
    gs.resolveCall(false);
    thrower.loco.pos.x = gs.pivot.x;
    thrower.loco.pos.z = gs.pivot.z;
    thrower.loco.vel.set(0, 0, 0);
    this.loco.rePivot(thrower.id, gs.pivot.x, gs.pivot.z);
  }

  /**
   * Every available body on a team, as the rules layer wants them. Rebuilt into
   * two scratch arrays rather than allocated, because `stepRules` runs on every
   * one of the 120 steps a second.
   */
  private bodyScratch: [{ id: number; pos: Vec3 }[], { id: number; pos: Vec3 }[]] = [[], []];
  private bodiesOf(team: TeamId): readonly { id: number; pos: Vec3 }[] {
    const out = this.bodyScratch[team];
    out.length = 0;
    for (const e of this.roster) {
      if (e.team !== team) continue;
      if (!this.loco.isAvailable(e.loco)) continue;
      out.push({ id: e.id, pos: { x: e.loco.pos.x, y: 0, z: e.loco.pos.z } });
    }
    return out;
  }

  /* ----------------------------------------------------------- orchestration */

  private orchestrate(dt: number): void {
    const gs = this.gs;
    switch (gs.phase) {
      case 'PRE_PULL': {
        if (gs.phaseTimer >= PRE_PULL_WAIT) this.doPull();
        break;
      }
      case 'TURNOVER_DEAD': {
        if (gs.awaitingPullChoice()) {
          // Brick unless the sideline spot is genuinely further downfield.
          const dir = gs.attackDir[gs.receivingTeam];
          const brick = brickMark(dir);
          const side = gs.pullOobCrossing;
          const useSide = !!side && side.z * dir > brick.z * dir + 2;
          gs.choosePullSpot(useSide ? 'sideline' : 'brick');
          break;
        }
        // Backstop for the pick-up: the AI emits its own `pickup` action, but a
        // dead disc that nobody collects stalls the whole match, so anyone in
        // range takes it regardless of what the AI asked for this step.
        if (gs.possession !== null) {
          const reach = gs.phaseTimer > PICKUP_DWELL ? PICKUP_DWELL_RADIUS : PICKUP_RADIUS;
          let best: RosterEntry | undefined;
          let bd = reach;
          for (const e of this.roster) {
            if (e.team !== gs.possession) continue;
            if (!this.loco.isAvailable(e.loco)) continue;
            const d = Math.hypot(e.loco.pos.x - gs.discPos.x, e.loco.pos.z - gs.discPos.z);
            if (d < bd) { bd = d; best = e; }
          }
          if (best) this.tryPickup(best, reach);
        }
        break;
      }
      case 'CHECK': {
        if (gs.phaseTimer >= CHECK_WAIT) gs.check();
        break;
      }
      case 'GAME_OVER': {
        // Roll straight into the next game so a long capture never stalls out.
        this.poseHold += dt;
        if (this.poseHold > 6) this.resetMatch();
        break;
      }
      default: break;
    }
  }

  private onPhaseChange(from: Phase, to: Phase): void {
    if (to === 'PRE_PULL') {
      if (this.aiDir[0] !== this.gs.attackDir[0]) this.rebuildAI();
      restBetweenPoints(this.roster.map((r) => r.ai), 40);
      for (const e of this.roster) e.loco.stamina = Math.min(100, e.loco.stamina + 32);
      this.lineUpForPull();
      this.pullerId = -1;
      this.poseHold = 0;
    }
    if (to === 'TURNOVER_DEAD' || to === 'POINT_SCORED') {
      this.thrownBy = -1;
      this.intendedReceiver = -1;
    }
    if (to === 'LIVE_POSSESSION' && this.gs.thrower !== null) {
      this.discRuntime.mode = 'held';
      this.discRuntime.holderId = this.gs.thrower;
      this.selectedReceiver = -1;
      this.selectSource = 'none';
      this.selectedLane = null;
      this.cutHeld = false;
      this.cutCommandFor = -1;
    }
    if (to === 'POINT_SCORED') this.poseHold = 0;
    void from;
  }

  /** Everyone onto their own goal line, ready for the pull. */
  private lineUpForPull(): void {
    const gs = this.gs;
    this.pending = null;
    for (const e of this.roster) {
      const dir = gs.attackDir[e.team];
      const z = -dir * FIELD.GOAL_LINE + dir * 0.5;
      const i = e.id % 7;
      const x = -FIELD.SIDELINE + 3.5 + (i / 6) * (2 * FIELD.SIDELINE - 7);
      this.placeBody(e, x, z, Math.atan2(0, dir) + (dir > 0 ? 0 : Math.PI));
      e.loco.facing = dir > 0 ? 0 : Math.PI;
    }
    _v.set(0, 0, -gs.attackDir[gs.pullingTeam] * FIELD.GOAL_LINE);
    this.discRuntime.settle(_v);
    this.discRuntime.mode = 'ground';
    this.thrownBy = -1;
    this.intendedReceiver = -1;
    this.handoffTo = -1;
    this.graceUntil = -1;
    this.graceTouched = false;
    this.selectedReceiver = -1;
    this.selectSource = 'none';
    this.selectedLane = null;
    this.cutRoute = null;
    this.cutRouteFor = -1;
    this.cutHeld = false;
    this.cutCommandFor = -1;
    this.lastPossession = gs.possession;
  }

  /**
   * The pull.
   *
   * A PULL IS NOT A BACKHAND, and treating it as one is why every pull in this
   * game used to die at midfield — measured mean carry 42.9 m, max 46.2 m,
   * against a far goal line 64 m away.
   *
   * The backhand table tops out at 27 m/s, and 27 m/s is not enough: swept
   * against the real aero, a maximum-power backhand carries 54.7 m at its best
   * launch angle and nothing you do with `power` reaches the endzone. That is
   * correct, because a pull is the one throw in the sport taken with a run-up
   * and a full body rotation rather than from a standing pivot with a mark in
   * your face. So it gets a release speed of its own rather than a wider
   * backhand range, which would hand the same speed to every throw in a
   * possession.
   *
   * Two things the sweep found that are worth keeping written down:
   *
   *   - Throwing harder made it WORSE before it made it better. At 29 m/s the
   *     carry FELL to 50.1 m and the sideways drift blew out to 33 m, because
   *     the disc turns over at speed and dives. Brute force is not the lever.
   *   - HYZER is the lever. Half a radian of it holds the line against that
   *     turnover, which is exactly how real pullers throw a big one.
   *
   * Fitted: 32 m/s, launch 0.10 rad, bank -0.50, flat nose, spin 0.85 carries
   * 66 m in 5.7 s peaking 7.7 m up — into the far endzone, with enough hang for
   * the cover to run under it.
   */
  private doPull(): void {
    const gs = this.gs;
    const team = gs.pullingTeam;
    const line = this.roster.filter((r) => r.team === team);
    // The best arm on the line pulls.
    let puller = line[0];
    for (const e of line) if (e.ai.attr.throwPower > puller.ai.attr.throwPower) puller = e;
    this.pullerId = puller.id;

    const dir = gs.attackDir[team];
    this.releaseOrigin(puller, _from);

    /**
     * AIM AT A SPOT, NOT DOWN THE FIELD. The puller lines up wherever the line
     * puts him — measured, that is about 15 m off centre, hard against a
     * sideline — so a heading of "straight downfield plus a correction" starts
     * from the wrong place and finishes out of bounds. Aiming at the middle of
     * the far endzone is self-correcting for wherever he happens to stand.
     *
     * Then offset that spot by the fade. A hyzer pull drifts `PULL_DRIFT`
     * metres sideways over its flight — along the thrower's right in this
     * coordinate convention, mirrored by hand — so aiming that far the other
     * way lands it on the spot rather than beside it. This is what a player
     * does: pick a target, account for the curve.
     */
    const handSign = puller.ai.handed === 'left' ? -1 : 1;
    let hx = -_from.x;
    let hz = dir * PULL_TARGET_Z - _from.z;
    const len = Math.hypot(hx, hz) || 1;
    hx /= len; hz /= len;
    const fx = -hz * handSign, fz = hx * handSign;      // unit fade direction
    _aim.set(hx * PULL_CARRY - fx * PULL_DRIFT, 0, hz * PULL_CARRY - fz * PULL_DRIFT);

    /**
     * Arm and a seeded nudge, so fourteen pulls are not one pull — but kept
     * tight on purpose. The carry is very sensitive above the fitted speed:
     * measured, 32.6 m/s hangs 4.6 s and 34.6 m/s hangs 3.2 s, because past the
     * fit the disc turns over and dives. `doPull` above has the numbers. The
     * puller is always the strongest arm on the line, so `arm` is centred to
     * land on PULL_SPEED for a top arm rather than to exceed it.
     */
    const arm = 0.94 + 0.06 * (puller.ai.attr.throwPower / 100);
    const jitter = 0.985 + 0.03 * this.rng.next();
    const vel = this.discRuntime.release({
      type: 'backhand', from: _from, aim: _aim,
      power: 1, angle: 0, spin: PULL_SPIN,
      speed: PULL_SPEED * arm * jitter,
      bank: PULL_BANK,
      nose: PULL_NOSE,
      hand: puller.ai.handed === 'left' ? 'L' : 'R',
    });
    this.hadInBounds = true;
    this.lastInBounds.copy(_from);
    this.flightSettled = false;
    this.thrownBy = puller.id;
    this.intendedReceiver = -1;
    this.discRuntime.lastThrowTeam = team;
    gs.pull(puller.id, { x: _from.x, y: _from.y, z: _from.z }, { x: vel.x, y: vel.y, z: vel.z });
  }

  private tryPickup(e: RosterEntry, radius = PICKUP_RADIUS): void {
    const gs = this.gs;
    if (gs.possession !== null && e.team !== gs.possession) return;
    const d = Math.hypot(e.loco.pos.x - gs.discPos.x, e.loco.pos.z - gs.discPos.z);
    if (d > radius) return;
    const r = gs.pickUp(e.id, { x: gs.discPos.x, y: 0, z: gs.discPos.z });
    if (!r.ok) return;
    this.discRuntime.mode = 'held';
    this.discRuntime.holderId = e.id;
    this.carryDisc();
  }

  /** Roll into a fresh game so a long capture or a left-running demo never ends. */
  private resetMatch(): void {
    this.gs.score[0] = 0; this.gs.score[1] = 0;
    this.gs.teams[0].score = 0; this.gs.teams[1].score = 0;
    this.gs.phase = 'PRE_PULL';
    this.gs.point = 1;
    this.gs.half = 1;
    this.gs.cap = 'none';
    this.lineUpForPull();
    this.poseHold = 0;
  }

  /* ------------------------------------------------------------- constraints */

  /** Nobody leaves the park. Locomotion caps speed; this is the hard backstop. */
  private keepOnField(): void {
    for (const e of this.roster) {
      const p = e.loco.pos;
      if (p.x > PLAY_BOUND_X) { p.x = PLAY_BOUND_X; if (e.loco.vel.x > 0) e.loco.vel.x = 0; }
      else if (p.x < -PLAY_BOUND_X) { p.x = -PLAY_BOUND_X; if (e.loco.vel.x < 0) e.loco.vel.x = 0; }
      if (p.z > PLAY_BOUND_Z) { p.z = PLAY_BOUND_Z; if (e.loco.vel.z > 0) e.loco.vel.z = 0; }
      else if (p.z < -PLAY_BOUND_Z) { p.z = -PLAY_BOUND_Z; if (e.loco.vel.z < 0) e.loco.vel.z = 0; }
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
        p.set(0, e.loco.groundY + e.loco.hipHeight, 0);
        e.loco.vel.set(0, 0, 0);
      }
    }
  }

  /* --------------------------------------------------------- player control */

  /**
   * Who the human is driving (§3).
   *
   * On offence you are the disc: control snaps to the thrower while it is in a
   * hand, follows the intended receiver 0.1 s after the release, and lands on
   * the catcher at the catch. On defence control does not move on its own at
   * all while somebody is playing — a switch is a decision, and taking it away
   * from the player is how a defence stops being readable — with two
   * exceptions: the grace-window policy switch after a turnover, and the
   * nearest-to-threat fallback when there is no human input at all (the
   * screenshot rig and the attract-mode demo, `humanIdle > 1.5`).
   *
   * Two invariants, both asserted in tools/test-game.ts:
   *   - control is never handed to a body `Locomotion.isAvailable` rejects;
   *   - control never moves on its own while the CURRENT body is unavailable —
   *     you committed to that layout and you get to watch it land.
   */
  private autoSelectControlled(ctx: Ctx): void {
    const gs = this.gs;

    // (a) The 0.6 s turnover grace. Control is frozen; the situation inverts
    //     around the body you already had.
    if (this.simT < this.graceUntil) {
      const hi = this.liveHumanIntent(ctx);
      if (hi && (hi.move.mag > GRACE_TOUCH || hi.defence.switchRequested)) this.graceTouched = true;
      return;
    }
    if (this.graceUntil >= 0) {
      this.graceUntil = -1;
      this.endGrace();
      return;
    }

    // (b) Mid-layout, prone, getting up: you keep the body.
    const me = this.byId.get(this.controlledPlayerId);
    if (me && !this.loco.isAvailable(me.loco)) return;

    // (c) Release + 0.1 s -> the intended receiver.
    if (this.handoffTo >= 0) {
      if (this.simT < this.handoffAt) return;
      const to = this.handoffTo;
      this.handoffTo = -1;
      if (this.takeControl(to, 'handoff')) return;
    }

    const mine = gs.possession === this.humanTeam;
    if (mine && gs.phase === 'LIVE_POSSESSION' && gs.thrower !== null
      && this.byId.get(gs.thrower)?.team === this.humanTeam) {
      this.takeControl(gs.thrower, 'thrower');
      return;
    }
    if (!mine && this.humanIdle > 1.5) {
      const t = this.threatPoint();
      let best = -1, bestScore = Infinity;
      for (const e of this.roster) {
        if (e.team !== this.humanTeam) continue;
        if (!this.loco.isAvailable(e.loco)) continue;
        const s = Math.hypot(e.loco.pos.x - t.x, e.loco.pos.z - t.z);
        if (s < bestScore) { bestScore = s; best = e.id; }
      }
      if (best >= 0) this.takeControl(best, 'idle-nearest');
    }
  }

  /**
   * Possession changed hands on this fixed step (§3, the mid-flight turnover).
   *
   * Three things happen here and they happen together, because the failure mode
   * is a press made under the old gates resolving under the new ones — a
   * buffered `throw` coming back 100 ms later as a `switchDefender`:
   *
   *   1. the input buffer is flushed;
   *   2. the indicator is told immediately, so the ring pulses and flips to its
   *      defensive treatment while the disc is still rolling;
   *   3. the control freeze opens, and control does NOT move for 0.6 s.
   *
   * The policy switch fires at the far end of that window, not here — see
   * `endGrace`.
   */
  private watchPossession(ctx: Ctx): void {
    const gs = this.gs;
    const poss = gs.possession;
    if (poss === this.lastPossession) return;
    const prev = this.lastPossession;
    this.lastPossession = poss;
    if (prev === null || poss === null) return;
    // A score, halftime and the pull are possession changes the rules machine
    // makes with the disc already dead. Nothing to grace.
    switch (gs.phase) {
      case 'POINT_SCORED': case 'PRE_PULL': case 'HALFTIME':
      case 'TIMEOUT': case 'GAME_OVER': return;
      default: break;
    }

    this.flushInputBuffer(ctx);
    this.selectedReceiver = -1;
    this.selectSource = 'none';
    this.selectedLane = null;
    this.handoffTo = -1;
    this.cutHeld = false;
    this.cutCommandFor = -1;
    this.graceUntil = this.simT + TURNOVER_GRACE;
    this.graceTouched = false;
    ctx.events.emit('control:flip', {
      playerId: this.controlledPlayerId,
      team: poss,
      toDefence: poss !== this.humanTeam,
      grace: TURNOVER_GRACE,
    });
  }

  /**
   * The grace window closed. Unless the human touched the sticks inside it —
   * human intent always wins — the switch policy now fires against the dead
   * disc, or against the predicted landing if it is still moving.
   */
  private endGrace(): void {
    if (this.graceTouched) return;
    if (this.gs.possession === this.humanTeam) return;   // we won it; the offence rules take over
    const id = this.policySwitchTarget();
    if (id >= 0) this.takeControl(id, 'turnover-policy');
  }

  /**
   * `pickSwitchTarget` (shipped as-is, per §3) against the current threat, with
   * one addition the brief asks for: if the body you already have is the best
   * candidate, nothing moves.
   */
  private policySwitchTarget(): number {
    const cands = this.defenderCandidates();
    if (cands.length === 0) return -1;
    const sit = this.switchSituation();
    const target = pickSwitchTarget(cands, sit, this.controlledPlayerId);
    if (target < 0) return -1;
    const me = cands.find((c) => c.id === this.controlledPlayerId);
    const to = cands.find((c) => c.id === target);
    if (me && to && me.eligible !== false && switchScore(me, sit) <= switchScore(to, sit)) return -1;
    return target;
  }

  /**
   * The double-tap escape hatch (§3): cycle outward through the defenders by
   * distance to the threat, for when the policy disagrees with the player.
   */
  private cycleSwitchOutward(): boolean {
    const t = this.threatPoint();
    const list = this.roster
      .filter((e) => e.team === this.humanTeam && e.team !== this.gs.possession
        && this.loco.isAvailable(e.loco))
      .map((e) => ({ id: e.id, d: Math.hypot(e.loco.pos.x - t.x, e.loco.pos.z - t.z) }))
      .sort((a, b) => (a.d - b.d) || (a.id - b.id));
    if (list.length < 2) return false;
    const i = list.findIndex((c) => c.id === this.controlledPlayerId);
    return this.takeControl(list[(i + 1) % list.length].id, 'double-tap');
  }

  /**
   * The one place `controlledPlayerId` is written. Two refusals, both from §3:
   *
   *   - never a body that cannot act (mid-layout, prone, recovering);
   *   - and never automatically OFF a body that cannot act either. You
   *     committed to that bid; the 2.04 s of recovery is the price and you get
   *     to watch it. Only an explicit human switch (`why === 'manual'`) may
   *     leave a body early, because human intent always wins.
   */
  private takeControl(id: number, why: string): boolean {
    if (id === this.controlledPlayerId) return true;
    const e = this.byId.get(id);
    if (!e || !this.loco.isAvailable(e.loco)) return false;
    const cur = this.byId.get(this.controlledPlayerId);
    if (why !== 'manual' && cur && !this.loco.isAvailable(cur.loco)) return false;
    const from = this.controlledPlayerId;
    this.controlledPlayerId = id;
    this.controlChanges++;
    this.controlReason = why;
    this.bus?.emit('control:changed', { playerId: id, from, reason: why, team: e.team });
    return true;
  }

  /**
   * Drop every buffered press. Duck-typed through `ctx.sys.input` so this file
   * keeps working with the input system absent (headless tests, capture).
   */
  private flushInputBuffer(ctx: Ctx): void {
    const input = ctx.sys['input'] as unknown as
      { human?: { buffer?: { clear(action?: string): void } } } | undefined;
    try { input?.human?.buffer?.clear(); } catch { /* peer under construction */ }
  }

  private threatPoint(): { x: number; z: number } {
    const rt = this.discRuntime;
    if (rt.mode === 'flight') {
      const path = rt.predictPath(rt.state, 3, 1 / 20);
      const last = path[path.length - 1];
      return { x: last.x, z: last.z };
    }
    return { x: rt.state.pos.x, z: rt.state.pos.z };
  }

  /* ================================================== InputHost (src/input) */

  playerFacing(playerId: number): number {
    return this.byId.get(playerId)?.loco.facing ?? 0;
  }

  intentGates(playerId: number): Partial<IntentGates> {
    const gs = this.gs;
    const e = this.byId.get(playerId);
    const hasDisc = gs.thrower === playerId && gs.phase === 'LIVE_POSSESSION';
    const onDefence = !!e && gs.possession !== null && e.team !== gs.possession;
    const live = gs.phase === 'LIVE_POSSESSION' || gs.phase === 'DISC_IN_FLIGHT'
      || gs.phase === 'PULL_IN_FLIGHT' || gs.phase === 'TURNOVER_DEAD';
    return {
      hasDisc,
      canThrow: hasDisc,
      canBid: live && !hasDisc,
      canLayout: live && !hasDisc,
      canSwitch: onDefence,
      canCycleReceiver: hasDisc,
      onDefence,
    };
  }

  defenderCandidates(): readonly DefenderCandidate[] {
    const gs = this.gs;
    const out: DefenderCandidate[] = [];
    const marker = this.markerId();
    for (const e of this.roster) {
      if (e.team !== this.humanTeam) continue;
      if (gs.possession !== null && e.team === gs.possession) continue;
      const mate = this.ai[e.team].matchupOf(e.id);
      const m = mate !== null ? this.byId.get(mate) : undefined;
      out.push({
        id: e.id,
        x: e.loco.pos.x, z: e.loco.pos.z,
        vx: e.loco.vel.x, vz: e.loco.vel.z,
        assignedX: m?.loco.pos.x, assignedZ: m?.loco.pos.z,
        isMarker: e.id === marker,
        controlled: e.id === this.controlledPlayerId,
        stamina: e.loco.stamina / 100,
        eligible: this.loco.isAvailable(e.loco),
      });
    }
    return out;
  }

  switchSituation(): SwitchSituation {
    const rt = this.discRuntime;
    const t = this.threatPoint();
    const me = this.byId.get(this.controlledPlayerId);
    return {
      discX: rt.state.pos.x, discZ: rt.state.pos.z,
      threatX: t.x, threatZ: t.z,
      discInAir: rt.mode === 'flight',
      fromX: me?.loco.pos.x, fromZ: me?.loco.pos.z,
    };
  }

  selectedReceiverId(_playerId: number): number { return this.selectedReceiver; }

  /**
   * A switch the player asked for. `Input.ts` has already run `pickSwitchTarget`
   * and handed us its answer; we take it, except on a double tap inside 0.3 s,
   * which means "not that one" and cycles outward instead.
   *
   * A manual switch is human intent, so it beats the turnover grace window —
   * but it still cannot land on a body that is unavailable.
   */
  setControlledPlayer(playerId: number): void {
    const dbl = this.simT - this.lastSwitchT <= DOUBLE_TAP;
    this.lastSwitchT = this.simT;
    this.graceTouched = true;
    if (dbl && this.gs.possession !== null && this.gs.possession !== this.humanTeam
      && this.cycleSwitchOutward()) return;
    this.takeControl(playerId, 'manual');
  }

  /* ------------------------------------------- targeting/control telemetry */

  /** Id of the currently selected receiver, or -1. */
  get selectedTarget(): number { return this.selectedReceiver; }
  /** How that selection was made — the HUD draws a dump bracket differently. */
  get selectionSource(): SelectSource { return this.selectSource; }
  /** Lane the selected receiver occupies, per `Playbook.laneOf`. */
  get selectedTargetLane(): LaneKey | null { return this.selectedLane; }
  /** The last directional select's scored candidates, best-first order not guaranteed. */
  get selectCandidates(): readonly SelectCandidate[] { return this.candidates; }
  /**
   * The route the human last commanded, in the shape `src/ui/Hud.ts` declares
   * for its cut-route ghost (§4): who was told to run, which `CutKind` it
   * resolved to, and the two points the route is drawn through. Null once the
   * ghost's 1.5 s has expired, so the HUD can fall back to rebuilding it.
   *
   * A METHOD, not a field, because that peer calls it as `commandedCut?.()`.
   */
  commandedCut(): { playerId: number; kind: string; setup: { x: number; z: number }; target: { x: number; z: number } } | null {
    const c = this.cutRoute;
    if (!c || this.cutRouteFor < 0) return null;
    return {
      playerId: this.cutRouteFor, kind: c.kind,
      setup: { x: c.setup.x, z: c.setup.z },
      target: { x: c.target.x, z: c.target.z },
    };
  }
  /** The raw route, for anything that wants the lane and the timings too. */
  get commandedRoute(): CutRoute | null { return this.cutRoute; }
  get commandedRouteAge(): number { return this.cutRouteAge; }
  /** Signed rotation the last release's aim assist applied, radians. */
  get lastAimAssist(): number { return this.lastAssist; }
  /**
   * Signed angle from the last release's raw aim to the ideal lead, radians.
   * The assist engages only while |this| <= 12 degrees; publishing it is what
   * lets the window be asserted instead of assumed.
   */
  get lastLeadError(): number { return this.lastLeadErr; }
  /** Seconds left of the post-turnover control freeze; 0 when not in one. */
  get controlGrace(): number { return Math.max(0, this.graceUntil - this.simT); }
  /** Diagnostics: how many times control has moved, and why it last moved. */
  get controlChangeCount(): number { return this.controlChanges; }
  get controlChangeReason(): string { return this.controlReason; }
  /** Monotonic simulation seconds — the clock the handoff and taps run on. */
  get simTime(): number { return this.simT; }

  /* ------------------------------------------------------------- telemetry */

  /** Bodies, for the character system. Never mutate these from outside. */
  get players(): readonly LocoPlayer[] { return this.loco.players; }
  entry(id: number): RosterEntry | undefined { return this.byId.get(id); }
  /** Id of the player currently marking the thrower, or -1. */
  markerId(): number {
    const gs = this.gs;
    if (gs.thrower === null || gs.possession === null) return -1;
    return this.ai[gs.possession === 0 ? 1 : 0].marker;
  }

  /* ================================================================ tableau */

  /**
   * Pose the match for a named screenshot.
   *
   * The capture rig applies a shot and then advances 150 fixed steps before it
   * grabs the frame, so a tableau that is merely *set* would be gone by the time
   * the shutter opens. Posing therefore latches: simulation stops, the
   * arrangement holds, and the frame is byte-identical every run. In live play
   * (a camera hotkey) it releases after a couple of seconds so the game does
   * not simply freeze under the player.
   */
  private applyTableau(tableau: string, shot: string, ctx: Ctx, cam?: Shot): void {
    this.posed = true;
    this.pending = null;
    this.poseName = tableau;
    this.poseHold = 2.5;
    const r = new Rng((this.seed ^ hashName(tableau + shot)) >>> 0);
    this.frame = makeFrame(resolveShot(cam, shot, tableau));

    // A plausible mid-game scoreline so the HUD is not sitting on 0-0.
    this.gs.score[0] = 9; this.gs.score[1] = 8;
    this.gs.teams[0].score = 9; this.gs.teams[1].score = 8;
    this.gs.point = 18;
    this.gs.stallCount = 4;
    this.gs.phase = 'LIVE_POSSESSION';
    this.gs.possession = 0;
    this.setAttack(-1);

    switch (tableau) {
      case 'mark': this.tableauMark(r); break;
      case 'portrait': this.tableauPortrait(r); break;
      case 'layout': this.tableauLayout(r); break;
      case 'huck': this.tableauHuck(r); break;
      case 'score': this.tableauScore(r); break;
      default: this.tableauFlow(r); break;
    }
    void ctx;
  }

  /** Which way team 0 attacks in a posed frame. Team 1 always mirrors. */
  private setAttack(dir: Dir): void {
    this.gs.attackDir = [dir, -dir as Dir];
    this.aiDir = [dir, -dir as Dir];
  }

  /** The camera the current tableau is being composed for. */
  private frame: Frame = makeFrame(SHOTS.broadcast as Shot);

  /**
   * Solve the world XZ whose image sits `xPct` across the frame, `depth` metres
   * down the view axis, for a body whose centre of mass is at height `y`.
   *
   * Composition is a screen-space property. Writing a tableau as a list of
   * world coordinates and hoping is how the broadcast frame ended up with its
   * subject at 6% of frame height, forty metres away, behind two anonymous
   * bodies that happened to be nearer the lens. Every position below is stated
   * as "this far into the shot, this far across it" and solved against the
   * camera `Shots.ts` actually pins, so the arrangement survives a change of
   * framing instead of silently rotting.
   */
  private at(depth: number, xPct: number, y = 0.95): { x: number; z: number } {
    const f = this.frame;
    const right = (xPct * 2 - 1) * depth * f.tanH;
    const k = depth - f.d.y * (y - f.c.y);
    // [ d.x  d.z ] [A]   [k]        A = x - c.x
    // [ r.x  r.z ] [B] = [right]    B = z - c.z
    const det = f.d.x * f.r.z - f.d.z * f.r.x;
    const A = (k * f.r.z - f.d.z * right) / det;
    const B = (f.d.x * right - k * f.r.x) / det;
    return {
      x: clampNum(f.c.x + A, -FIELD.SIDELINE + 0.3, FIELD.SIDELINE - 0.3),
      z: clampNum(f.c.z + B, -FIELD.END_LINE + 0.3, FIELD.END_LINE - 0.3),
    };
  }

  /**
   * An offence/defence pair by explicit world offset. `pair()` positions the
   * defender by a cushion measured downfield, which is the right model for a
   * live cut and the wrong one for a body standing in a stack; this one puts
   * him exactly where he is asked to be and points him at his man.
   */
  private duo(
    slot: number, o: { x: number; z: number }, oFace: number, oOpt: PlaceOpts,
    dOff: { x: number; z: number }, dOpt: PlaceOpts = {}, dFace?: number,
  ): void {
    const off = this.of(0, slot);
    const def = this.of(1, slot);
    const dx = o.x + dOff.x, dz = o.z + dOff.z;
    this.placeBody(off, o.x, o.z, oFace, oOpt);
    this.placeBody(def, dx, dz, dFace ?? Math.atan2(o.x - dx, o.z - dz), dOpt);
  }

  /** Place a body and stop it dead. `state` picks the animation pose. */
  private placeBody(
    e: RosterEntry, x: number, z: number, facing: number, o: PlaceOpts = {},
  ): void {
    const lp = e.loco;
    lp.pos.x = x; lp.pos.z = z;
    lp.groundY = typeof this.field?.heightAt === 'function' ? this.field.heightAt(x, z) : 0;
    lp.prone = o.prone ?? false;
    lp.air.airborne = o.airborne ?? false;
    lp.pos.y = o.y !== undefined ? lp.groundY + o.y : lp.groundY + (lp.prone ? 0.22 : lp.hipHeight);
    const sp = o.speed ?? 0;
    const dx = o.dirX ?? Math.sin(facing), dz = o.dirZ ?? Math.cos(facing);
    const dl = Math.hypot(dx, dz) || 1;
    lp.vel.set((dx / dl) * sp, o.airborne ? 0.4 : 0, (dz / dl) * sp);
    lp.facing = facing;
    lp.state = o.state ?? (sp > 6 ? 'sprint' : sp > 3 ? 'run' : sp > 0.5 ? 'jog' : 'idle');
    lp.stateT = 0.12;
    lp.stateDur = 0.45;
    lp.foot.pos.set(x, lp.groundY, z);
    lp.foot.contact = !lp.air.airborne;

    /**
     * Flight-arc bookkeeping. The animator does not blend a canned "layout"
     * clip — it reads `air.tTakeoff / tApex / tLand` against `loco.t` and builds
     * the pose from where in the arc the body is. Leaving those at zero means
     * `loco.t - air.tTakeoff === 0`, the pose sits at the START of the gather,
     * and a receiver posed mid-layout renders standing upright. That is exactly
     * what the `layout` shot was showing. Put the takeoff a quarter second in
     * the past and the landing a third of a second in the future, so a frozen
     * tableau is sampled at full extension.
     */
    if (lp.air.airborne || lp.prone) {
      const t = lp.t;
      const laid = lp.prone || lp.state === 'layout';
      lp.air.tTakeoff = t - (laid ? 0.26 : 0.18);
      lp.air.tApex = t - (laid ? 0.10 : 0.02);
      lp.air.tLand = t + (laid ? 0.34 : 0.26);
      lp.air.takeoffY = lp.groundY + lp.hipHeight;
      lp.air.apexY = Math.max(lp.pos.y, lp.groundY + (laid ? 0.62 : lp.hipHeight + 0.35));
      lp.air.vy0 = laid ? 1.5 : 3.2;
    } else {
      lp.air.tTakeoff = lp.air.tApex = lp.air.tLand = lp.t - 4;
    }
  }

  private of(team: TeamId, slot: number): RosterEntry { return this.roster[team * 7 + slot]; }

  /**
   * Which hand this athlete throws with, as the ANIMATOR decided it: `+1` left,
   * `-1` right. One athlete in nine is dealt a left hand from a hash of their
   * id inside `Animator.add()`, and the rig's throwing arm — and therefore the
   * side the disc hangs off — follows that, not anything the simulation knows.
   * Read off the peer, defaulting to right-handed when there is no character
   * system (headless tests, a stubbed peer).
   */
  private handedOf(id: number): 1 | -1 {
    const peer = this.sysRef?.['players'] as
      { get?(i: number): { handle?: { handed?: number } } | undefined } | undefined;
    let h: number | undefined;
    try { h = peer?.get?.(id)?.handle?.handed; } catch { h = undefined; }
    return h === 1 ? 1 : -1;
  }

  /**
   * Yaw for a body that must be seen holding the disc.
   *
   * A thrower is normally pointed at whatever he is looking at, and roughly half
   * the time that puts his throwing shoulder on the far side of his own torso
   * from the lens — so the disc, the one object in the frame the art direction
   * says must always read, is eclipsed by the body carrying it. Both candidate
   * yaws (the look direction swung either way) are legal, plausible open stances
   * for a handler; this picks whichever one carries the throwing side toward the
   * camera. `at` is where the body stands, `look` the direction it wants to face.
   */
  private discToCamera(id: number, at: { x: number; z: number }, look: number, swing = 0.62): number {
    const s = this.handedOf(id);                       // +1 left-handed
    const cl = Math.hypot(this.frame.c.x - at.x, this.frame.c.z - at.z) || 1;
    const cx = (this.frame.c.x - at.x) / cl, cz = (this.frame.c.z - at.z) / cl;
    let best = look, bestScore = -Infinity;
    /**
     * Two competing wants, and only scoring both stops one from destroying the
     * other. Maximising "throwing side toward the lens" alone is satisfied just
     * as well by turning a body's BACK to the camera as its front — which is
     * exactly what it did on the first pass: the `sideline` handler and the
     * `endzone` scorer both ended up shot from behind with a jersey number where
     * a face should be. Weighting the chest toward the lens at three-quarters of
     * the disc term picks the three-quarter-open stance that shows both, and the
     * small penalty on |swing| keeps the body pointed at what it is looking at
     * when neither term cares.
     */
    for (let i = 0; i <= 12; i++) {
      const d = -swing + (i / 12) * 2 * swing;
      const y = look + d;
      // The rig's local +X is the athlete's LEFT; in world that is (cos y, -sin y).
      const side = (Math.cos(y) * cx - Math.sin(y) * cz) * s;
      const fwd = Math.sin(y) * cx + Math.cos(y) * cz;
      const score = side + 0.75 * fwd - 0.30 * Math.abs(d);
      if (score > bestScore) { bestScore = score; best = y; }
    }
    return best;
  }

  /**
   * A world XZ offset expressed in the CAMERA's axes: `right` metres across the
   * frame, `depth` metres further from the lens. Two bodies separated by a world
   * offset can still land on the same pixels — which is what put four athletes
   * in a single silhouette on the right of the `sideline` frame. Separated on
   * the screen-right axis they cannot.
   */
  private screenOff(right: number, depth: number): { x: number; z: number } {
    const f = this.frame;
    const dl = Math.hypot(f.d.x, f.d.z) || 1;
    return {
      x: f.r.x * right + (f.d.x / dl) * depth,
      z: f.r.z * right + (f.d.z / dl) * depth,
    };
  }

  /**
   * A pair: an offensive player and the defender on him, positioned by a
   * cushion and a shade so the matchup reads at a glance.
   */
  private pair(
    slot: number, ox: number, oz: number, oFace: number, speed: number,
    cushion: number, shade: number, dSpeed = speed * 0.94,
  ): void {
    const o = this.of(0, slot);
    const d = this.of(1, slot);
    this.placeBody(o, ox, oz, oFace, { speed, state: speed > 5.5 ? 'sprint' : speed > 2 ? 'run' : 'idle' });
    const dx = ox + shade;
    const dz = oz - cushion;
    this.placeBody(d, dx, dz, Math.atan2(ox - dx, oz - dz), {
      speed: dSpeed, dirX: Math.sin(oFace), dirZ: Math.cos(oFace),
      state: dSpeed > 5.5 ? 'sprint' : dSpeed > 2 ? 'run' : 'backpedal',
    });
  }

  /**
   * Broadcast flow — a vertical stack, live under cut, dump reset behind.
   *
   * Read the frame right to left: the thrower and his mark sit on the focal
   * plane in the right third, the cutter he is looking at breaks into the
   * centre, and the stack recedes away up-left with the deep threat pulling the
   * last defender off the top. That ordering is not decoration — it is the only
   * arrangement in which someone who knows Ultimate can name the formation, the
   * force and the cut from a still, which is the whole job of this tableau.
   */
  private tableauFlow(r: Rng): void {
    // Team 0 attacks -Z: from this camera that puts downfield up and to the
    // left, so the play recedes instead of walking into the lens.
    this.setAttack(-1);

    const T = this.at(45.0, 0.62);
    const thrower = this.of(0, 0);

    // The stack: front of it 12 m in front of the disc, then straight downfield
    // on 4.7 m spacing with the slow drift a real stack always has.
    const s0 = this.at(44.5, 0.345);
    const stack = (i: number): { x: number; z: number } =>
      ({ x: s0.x + i * 0.34, z: s0.z - i * 4.70 });

    // The live cut: out of the front of the stack, breaking back to the open
    // (forehand, -X) side of the disc. He is caught mid-stride with his
    // defender two and a half metres beaten.
    const C = this.at(44.0, 0.415);
    const catchAt = { x: T.x - 5.4, z: T.z - 5.0 };
    const cd = norm2(catchAt.x - C.x, catchAt.z - C.z);
    const cFace = Math.atan2(cd.x, cd.z);

    // Handler and his mark. Force forehand, so the mark stands on the +X
    // (backhand) shoulder, a shade over a metre off — a legal, real mark.
    // Open to the cut, swung so the throwing side — and the disc — is the side
    // the lens can see. At 45 m the disc is ten pixels across; behind the torso
    // it is none.
    this.placeBody(thrower, T.x, T.z,
      this.discToCamera(thrower.id, T, Math.atan2(catchAt.x - T.x, catchAt.z - T.z), 0.55),
      { state: 'idle' });
    // Downfield-and-a-shade-across: at 46 m the only offset that separates two
    // silhouettes at all is the one aligned with the camera's own screen axis,
    // and for this angle that is straight down the field.
    this.placeBody(this.of(1, 0), T.x + 0.30, T.z - 1.15, Math.atan2(-0.30, 1.15),
      { state: 'shuffle', speed: 0.55 });

    /**
     * The dump reset — and it goes BEHIND the disc, which is both the rule of
     * the sport and the fix for this framing.
     *
     * A reset handler stands upfield of the thrower, on the break side, so the
     * thrower always has a backwards option; parking him at 46.4 m put him a
     * metre and a half DOWNFIELD of the disc, which is a second cutter in the
     * lane, not a dump. Behind the disc from this camera means *nearer the
     * lens*, and that has a second payoff: the elevated sideline angle spends
     * its bottom four hundred pixels on bare turf between 23 and 45 m, and this
     * is the one body a vertical stack legitimately puts there. He fills the
     * near field, he is the largest athlete in the frame, and he gives the
     * composition a foreground.
     */
    const R = this.at(37.5, 0.815);
    this.duo(1, R, Math.atan2(T.x - R.x, T.z - R.z), { state: 'idle', speed: 0.9 },
      this.screenOff(-1.1, -1.5), { state: 'shuffle', speed: 1.0 });

    // The live cutter.
    this.duo(2, C, cFace,
      { speed: 7.4, dirX: cd.x, dirZ: cd.z, state: 'sprint' },
      { x: -cd.x * 2.5, z: -cd.z * 2.5 },
      { speed: 6.8, dirX: cd.x, dirZ: cd.z, state: 'sprint' }, cFace);

    // Three standing in the stack, each defender shading the open side.
    this.duo(3, stack(0), 0.30, { state: 'idle', speed: 0.6 }, { x: -1.65, z: 0.45 }, { state: 'shuffle', speed: 0.5 });
    this.duo(4, stack(1), 0.26, { state: 'idle', speed: 0.5 }, { x: -1.70, z: 0.40 }, { state: 'shuffle', speed: 0.4 });
    this.duo(6, stack(2), 0.24, { state: 'idle', speed: 0.7 }, { x: -1.62, z: 0.52 }, { state: 'shuffle', speed: 0.6 });

    // Deep threat off the back of the stack, defender a stride behind.
    const D = { x: stack(2).x + 3.1, z: stack(2).z - 6.4 };
    this.duo(5, D, Math.atan2(0.16, -1),
      { speed: 8.2, dirX: 0.16, dirZ: -1, state: 'sprint' },
      { x: -0.5, z: 2.2 },
      { speed: 8.0, dirX: 0.16, dirZ: -1, state: 'sprint' }, Math.atan2(0.16, -1));

    this.gs.thrower = thrower.id;
    this.gs.pivot = { x: thrower.loco.pos.x, y: 0, z: thrower.loco.pos.z };
    this.discRuntime.mode = 'held';
    this.discRuntime.holderId = thrower.id;
    this.carryDisc();
    this.discRuntime.wear = 0.45;
    void r;
  }

  /**
   * Sideline telephoto: the handler's pivot against the mark, two bodies on the
   * focal plane with the rest of both teams compressed behind them.
   *
   * The one thing this framing cannot survive is a body in front of the
   * subject: at 27 m focus and a 20-degree lens anything nearer than about
   * 20 m is both larger than the handler and completely out of focus. Nothing
   * is placed inside that distance.
   */
  private tableauMark(r: Rng): void {
    this.setAttack(-1);
    const thrower = this.of(0, 0);
    const T = this.at(27.0, 0.44);

    /**
     * The mark stands IN FRONT of the thrower — between him and the field he is
     * throwing into — not off to one side, and at a disc-space: the rules say
     * no closer than one disc diameter, and every real mark plays as tight to
     * that as it can. 1.05 m, offset a third of a metre to the screen side so
     * the two bodies do not become one silhouette at this focal length.
     */
    const nudge = this.screenOff(-0.36, 0);
    const md = norm2(nudge.x, -1 + nudge.z);          // downfield is -Z here
    const M = { x: T.x + md.x * 1.05, z: T.z + md.z * 1.05 };

    // Face the mark, swung to whichever side brings the throwing shoulder — and
    // therefore the disc — around to the lens.
    const look = Math.atan2(M.x - T.x, M.z - T.z);
    this.placeBody(thrower, T.x, T.z, this.discToCamera(thrower.id, T, look, 0.72), { state: 'idle' });
    this.placeBody(this.of(1, 0), M.x, M.z, Math.atan2(T.x - M.x, T.z - M.z),
      { state: 'shuffle', speed: 0.6 });

    /**
     * Everything else sits behind the plane of the mark: a reset behind the
     * disc, a cut coming back, the stack, and a deep pair. Every defender is
     * offset along the CAMERA's right axis rather than by a world vector, which
     * is what stops four bodies at the same depth from stacking into a single
     * blob — the previous arrangement put six of them inside two silhouettes on
     * the right of the frame.
     */
    const back: [number, number, number, number, number][] = [
      // slot, depth, x%, offence speed, defender screen-right offset (m)
      [1, 30.5, 0.70, 0.9, -2.0],   // the reset, behind and break side
      [2, 33.0, 0.26, 6.6, +2.2],   // a cut coming back to the disc
      [3, 36.5, 0.63, 0.8, -2.1],   // stack
      [4, 40.0, 0.18, 1.0, +2.0],   // stack
      [5, 44.0, 0.79, 7.4, -2.4],   // deep threat
      [6, 48.0, 0.42, 1.2, +1.9],   // last body in the stack
    ];
    for (const [slot, depth, xp, sp, side] of back) {
      const o = this.at(depth, xp);
      const dir = sp > 4 ? norm2(T.x - o.x, T.z - o.z) : { x: 0, z: -1 };
      this.duo(slot, o, Math.atan2(dir.x, dir.z),
        { speed: sp, dirX: dir.x, dirZ: dir.z, state: sp > 5.5 ? 'sprint' : sp > 2 ? 'run' : 'idle' },
        this.screenOff(side, sp > 4 ? 1.7 : -0.7),
        { speed: sp * 0.92, dirX: dir.x, dirZ: dir.z, state: sp > 5.5 ? 'sprint' : sp > 2 ? 'run' : 'shuffle' });
    }

    this.gs.thrower = thrower.id;
    this.gs.stallCount = 6;
    this.discRuntime.mode = 'held';
    this.discRuntime.holderId = thrower.id;
    this.carryDisc();
    this.discRuntime.wear = 0.55;
    void r;
  }

  /** Character hero shot: a receiver standing exactly on the shot's focal plane. */
  private tableauPortrait(r: Rng): void {
    const hero = this.of(0, 4);
    // On the view axis at the focus distance, so the head lands on the camera's
    // target point and the face is the sharpest thing in the frame. Standing at
    // the origin — where this used to put him — is 0.6 m behind focus, which on
    // a 42-degree lens at f/3.4 is the difference between pores and mush.
    const f = this.frame;
    const dist = f.focus > 0 ? f.focus : 3.1;
    const eye = 1.62;
    const H = this.at(dist, 0.5, eye);
    const toCam = Math.atan2(f.c.x - H.x, f.c.z - H.z);
    /**
     * Three-quarter to the lens, and turned so the throwing side is the side we
     * see — because he is holding the disc. An "athlete at rest" in this sport
     * is a player standing on the disc, and the art direction is explicit that
     * the kits and the disc are the only three saturated things in any frame:
     * a character hero shot with none of the three in it beyond the jersey is
     * leaving the cheapest read on the table. It also exercises the whole carry
     * chain — stance, pivot, grip, plate orientation — at a crop where every
     * one of those is visible.
     */
    this.placeBody(hero, H.x, H.z, this.discToCamera(hero.id, H, toCam, 0.46), { state: 'idle' });
    hero.loco.foot.contact = true;

    // Bodies far behind for the bokeh field, none close enough to crowd him.
    const others = this.roster.filter((e) => e !== hero);
    for (let i = 0; i < others.length; i++) {
      const a = -1.2 + (i / others.length) * 2.6;
      const d = 14 + r.range(0, 22);
      this.placeBody(others[i], Math.sin(a) * d, -Math.cos(a) * d - 6, a + Math.PI,
        { speed: r.range(2, 7) });
    }
    this.gs.thrower = hero.id;
    this.gs.stallCount = 2;
    this.discRuntime.mode = 'held';
    this.discRuntime.holderId = hero.id;
    this.carryDisc();
    this.discRuntime.wear = 0.5;
  }

  /**
   * Peak action: a receiver fully extended, disc at the fingertips, defender
   * trailing. The disc is staged by throwing a real pass and translating the
   * recorded flight so it terminates exactly at the fingertips — the trail in
   * frame is the path DiscPhysics actually produced.
   */
  private tableauLayout(r: Rng): void {
    this.setAttack(1);
    const rec = this.of(0, 4);
    const def = this.of(1, 4);

    // The receiver flies square across the lens — along the camera's own screen
    // -X axis — so the extension is seen broadside instead of down its length.
    const f = this.frame;
    const across = norm2(-f.r.x, -f.r.z);
    const R = this.at(11.7, 0.535, 0.62);

    this.placeBody(rec, R.x, R.z, Math.atan2(across.x, across.z), {
      speed: 7.4, dirX: across.x, dirZ: across.z, state: 'layout', prone: true, airborne: true, y: 0.62,
    });
    rec.loco.vel.y = 0.55;

    // Trailing defender, two metres back down the same line and still inside
    // the frame: at this focal length "behind him" and "off the right edge" are
    // the same direction, so the gap is what decides whether he is in shot.
    this.placeBody(def, R.x - across.x * 2.05, R.z - across.z * 2.05,
      Math.atan2(across.x, across.z), { speed: 7.9, dirX: across.x, dirZ: across.z, state: 'sprint' });

    // The thrower who put it there, deep in the background but readable.
    const TH = this.at(38.0, 0.478);
    this.placeBody(this.of(0, 0), TH.x, TH.z, Math.atan2(R.x - TH.x, R.z - TH.z), { state: 'idle' });
    const MK = this.at(38.8, 0.512);
    this.placeBody(this.of(1, 0), MK.x, MK.z, Math.atan2(TH.x - MK.x, TH.z - MK.z), { state: 'shuffle' });

    // Three pairs stacked through the mid-ground so the bokeh has content.
    const back: [number, number, number, number][] = [
      [1, 20.0, 0.76, 5.4],
      [2, 26.0, 0.31, 6.1],
      [3, 33.0, 0.58, 3.2],
      [5, 24.0, 0.83, 7.0],
      [6, 30.0, 0.14, 4.2],
    ];
    for (const [slot, depth, xp, sp] of back) {
      const o = this.at(depth, xp);
      const dir = norm2(R.x - o.x, R.z - o.z);
      this.duo(slot, o, Math.atan2(dir.x, dir.z),
        { speed: sp, dirX: dir.x, dirZ: dir.z, state: sp > 5.5 ? 'sprint' : 'run' },
        { x: -dir.x * 1.9 + 1.2, z: -dir.z * 1.9 + 0.4 },
        { speed: sp * 0.9, dirX: dir.x, dirZ: dir.z, state: sp > 5.5 ? 'sprint' : 'run' });
    }

    // The disc, on the fingertips of the extended arm — 0.82 m ahead of the
    // body along the line of flight, a hand's height above the chest. The
    // animator's reach IK takes the hands to wherever this lands, so getting
    // the disc right is what makes the extension look like a catch attempt
    // rather than a man falling over near a frisbee.
    this.stageFlight(
      new THREE.Vector3(R.x + across.x * 0.82, rec.loco.pos.y + 0.10, R.z + across.z * 0.82),
      // Banked hard: this camera sits two degrees above the disc, so a disc
      // flying flat presents a 13 mm edge and renders as a white splinter at the
      // fingertips. A disc fading away outside-in is banked, it is the shape a
      // receiver has to lay out for in the first place, and it shows a plate.
      'forehand', 0.60, 0.04, 0.9, Math.atan2(across.x, across.z), 0.50, 0.86);
    this.discRuntime.wear = 0.6;
    void r;
  }

  /** Macro on a spinning disc mid-huck, with the real curved path behind it. */
  private tableauHuck(r: Rng): void {
    this.setAttack(-1);
    // Camera at (3.2, 2.4, 3.4) on (0, 2.2, 0), so the view axis is (-0.68, -0.72)
    // in XZ. Heading 2.33 rad is exactly perpendicular to it: the disc crosses
    // the frame instead of receding down the lens axis, which is the difference
    // between a trail that reads as flight and one that is a bar over the lens.
    // The bank leans the plate toward the camera — a real outside-in huck — so
    // the hot stamp is visible rather than presenting a bare edge.
    this.stageFlight(new THREE.Vector3(0, 2.2, 0), 'backhand', 0.94, 0.16, 1.0, 2.33, 0.55, 0.75);

    // Seven pairs laddered back from 9 m to 30 m and kept inside the frame —
    // the previous ring of bodies sat outside the 26-degree cone entirely, so
    // the "warm field bokeh" this shot is supposed to sit against was bare
    // grass. Nothing is nearer than 9 m: at f/4.5 on a 4.4 m focus a closer
    // body is a shapeless smear over the subject.
    const ladder: [number, number, number, number][] = [
      [0, 9.0, 0.85, 6.4],
      [1, 9.8, 0.15, 6.9],
      [2, 14.0, 0.76, 7.6],
      [3, 19.0, 0.28, 7.1],
      [4, 22.0, 0.63, 5.8],
      [5, 26.0, 0.40, 8.0],
      [6, 30.0, 0.55, 4.6],
    ];
    for (const [slot, depth, xp, sp] of ladder) {
      const o = this.at(depth, xp);
      const a = 2.33 + r.range(-0.5, 0.5);
      const dir = { x: Math.sin(a), z: Math.cos(a) };
      this.duo(slot, o, a,
        { speed: sp, dirX: dir.x, dirZ: dir.z, state: 'sprint' },
        { x: -dir.x * 2.1 + 0.9, z: -dir.z * 2.1 - 0.6 },
        { speed: sp * 0.95, dirX: dir.x, dirZ: dir.z, state: 'sprint' }, a);
    }
    this.gs.thrower = null;
    this.discRuntime.wear = 0.35;
  }

  /**
   * Endzone score. This lens sees a wedge: the camera stands 4 m inside the
   * back of the endzone looking at the end line, so everything in bounds AND in
   * frame lies between two and six metres away. The old arrangement put the
   * whole celebration *behind* the camera and framed two bodies out of fifteen.
   * Three athletes, big, is what this shot can actually hold.
   */
  private tableauScore(r: Rng): void {
    const scorer = this.of(1, 4);
    this.gs.possession = 1;
    this.setAttack(1);

    const S = this.at(4.2, 0.60);
    // Turned to the crowd behind the lens, and swung so the disc he has just
    // caught is on the side the camera can see rather than behind his back.
    this.placeBody(scorer, S.x, S.z,
      this.discToCamera(scorer.id, S, Math.atan2(this.frame.c.x - S.x, this.frame.c.z - S.z), 0.40),
      { state: 'idle' });

    // Two teammates arriving from the open side of the frame.
    const M1 = this.at(6.0, 0.17);
    this.placeBody(this.of(1, 0), M1.x, M1.z, Math.atan2(S.x - M1.x, S.z - M1.z),
      { speed: 5.6 + r.range(0, 1.2), state: 'sprint' });
    const M2 = this.at(5.0, 0.335);
    this.placeBody(this.of(1, 1), M2.x, M2.z, Math.atan2(S.x - M2.x, S.z - M2.z),
      { speed: 5.0 + r.range(0, 1.2), state: 'sprint' });

    // The beaten defender, hands on hips, between them.
    const D = this.at(5.4, 0.455);
    this.placeBody(this.of(0, 4), D.x, D.z, Math.atan2(S.x - D.x, S.z - D.z), { state: 'idle' });

    // Everybody else is genuinely elsewhere — upfield, behind the lens. They
    // are not hidden, they are where the rest of a team is a second after a
    // goal, and the frustum simply does not reach them.
    const rest = [
      [this.of(1, 2), -9.0, -43.0], [this.of(1, 3), 6.5, -42.0],
      [this.of(1, 5), -13.5, -38.5], [this.of(1, 6), 11.5, -37.0],
      [this.of(0, 0), -4.5, -41.5], [this.of(0, 1), 2.0, -40.0],
      [this.of(0, 2), -11.0, -39.0], [this.of(0, 3), 9.0, -38.0],
      [this.of(0, 5), -6.0, -35.0], [this.of(0, 6), 13.5, -34.0],
    ] as const;
    for (const [e, x, z] of rest) {
      this.placeBody(e as RosterEntry, x, z, 2.9 + r.range(-0.5, 0.5),
        { speed: r.range(0.8, 2.4), state: 'jog' });
    }

    /**
     * The disc, just caught, still in the hand.
     *
     * This used to hang it off a hard-coded hip offset — 24 cm across and 1.55
     * hip-heights up — which in the rendered frame was a frisbee hovering in
     * mid-air beside the scorer, attached to nothing. Route it through the same
     * path every other tableau uses: mark him as the thrower and let
     * `carryDisc()` probe the rig's grip anchor, so the disc sits in the hand
     * the animator actually posed and stays there while the capture rig advances
     * its hundred and fifty settle frames.
     */
    this.gs.thrower = scorer.id;
    this.discRuntime.mode = 'held';
    this.discRuntime.holderId = scorer.id;
    this.carryDisc();
    this.discRuntime.wear = 0.7;
    this.gs.score[0] = 9; this.gs.score[1] = 9;
    this.gs.teams[0].score = 9; this.gs.teams[1].score = 9;
  }

  /**
   * Stage a mid-flight disc that arrives exactly at `target`.
   *
   * Throws a real pass, integrates it for `back` seconds, then translates the
   * whole recorded path so the state sits on the target. Translation is exact
   * under uniform gravity and uniform wind, so what ends up in frame — the
   * bank, the spin, the curve of the trail — is genuine flight data, not a
   * hand-drawn arc.
   */
  private stageFlight(
    target: THREE.Vector3, type: PhysThrowType, power: number, angle: number,
    spin: number, headingRad: number, back: number, bank = 0,
  ): void {
    const rt = this.discRuntime;
    _from.set(0, 1.55, 0);
    _aim.set(Math.sin(headingRad), 0, Math.cos(headingRad));
    rt.release({ type, from: _from, aim: _aim, power, angle, spin, hand: 'R', bank });
    const steps = Math.max(1, Math.round(back * 120));
    for (let i = 0; i < steps; i++) rt.step(1 / 120);

    // Own scratch, deliberately: callers hand us a point they computed
    // themselves, and if that point happens to be one of this module's shared
    // vectors the offset below overwrites the target while it is still being
    // read. A staged disc then lands on the delta instead of the fingertips.
    const dx = target.x - rt.state.pos.x;
    const dy = target.y - rt.state.pos.y;
    const dz = target.z - rt.state.pos.z;
    rt.state.pos.set(target.x, target.y, target.z);
    for (const s of rt.trail) { s.x += dx; s.y += dy; s.z += dz; }
    rt.mode = 'flight';
    rt.state.touchedGround = false;
    rt.state.atRest = false;
    rt.sinceRelease = back;
    this.gs.phase = 'DISC_IN_FLIGHT';
    this.gs.thrower = null;
  }

  /** Which tableau is currently latched, or '' when the match is live. */
  get tableau(): string { return this.posed ? this.poseName : ''; }

  /**
   * Unlatch a tableau and play on.
   *
   * A shot latches the arrangement so the shutter always opens on the same
   * frame — which also means that in capture mode the match never runs. This is
   * the door back out: the screenshot rig, a debug key, or anything that wants
   * to watch the simulation rather than a still calls it and the game resumes
   * from the posed configuration.
   */
  resumeLive(): void {
    if (!this.posed) return;
    this.posed = false;
    this.poseName = '';
    this.poseHold = 0;
    this.pending = null;
    // Some tableaux park the disc mid-flight with no thrower, which is not a
    // state the rules machine can step out of. Anything not cleanly resumable
    // restarts the point from a pull — the fastest way back to real play.
    const gs = this.gs;
    const holder = gs.thrower !== null ? this.byId.get(gs.thrower) : undefined;
    const resumable = (gs.phase === 'LIVE_POSSESSION' || gs.phase === 'CHECK') && !!holder;
    this.thrownBy = -1;
    this.intendedReceiver = -1;
    this.flightSettled = true;
    this.handoffTo = -1;
    this.graceUntil = -1;
    this.graceTouched = false;
    this.cutRoute = null;
    this.cutRouteFor = -1;
    this.lastPossession = gs.possession;
    if (resumable) {
      this.discRuntime.mode = 'held';
      this.discRuntime.holderId = holder!.id;
      this.carryDisc();
      return;
    }
    gs.phase = 'PRE_PULL';
    gs.stallCount = 0;
    gs.thrower = null;
    this.lineUpForPull();
    this.lastPhase = 'PRE_PULL';
  }
}

/* ---------------------------------------------------------------- helpers */

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Smoothstep in [edge0, edge1]; 0 below, 1 above. */
function smooth01(x: number, edge0: number, edge1: number): number {
  const t = clampNum((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Shortest signed angle in (-PI, PI]. */
function wrapPi(a: number): number {
  let v = a % (Math.PI * 2);
  if (v > Math.PI) v -= Math.PI * 2;
  else if (v <= -Math.PI) v += Math.PI * 2;
  return v;
}

/** Where a receiver selection came from. */
export type SelectSource = 'none' | 'human' | 'dump';

/**
 * One teammate weighed against a directional select, with every term of the
 * score kept separately. Published so the HUD can explain a bracket and so the
 * tests can assert the weights are what the design brief says they are.
 */
export interface SelectCandidate {
  id: number;
  /** Angle off the stick direction, radians. Always <= SELECT_CONE. */
  angle: number;
  /** 1 dead on the stick, 0 at the edge of the cone. */
  angular: number;
  /** 1 a clean lane, 0 a defender standing in it. */
  openness: number;
  /** Metres from the thrower. */
  distance: number;
  /** 1 inside sane throwing range, tapering to 0 outside it. */
  sanity: number;
  /** 0.60 * angular + 0.25 * openness + 0.15 * sanity. */
  score: number;
}

function norm2(x: number, z: number): { x: number; z: number } {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}

/**
 * The subset of a `PlayerAction` of kind `'throw'` the release solver needs.
 * Stated separately so a latched windup can carry a COPY — the AI reuses its
 * action objects frame to frame, and the windup writes a lead correction into
 * the aim.
 */
interface ThrowIntent {
  throwType: AIThrowType;
  aimX: number;
  aimY: number;
  aimZ: number;
  speed: number;
  receiverId: number;
}

/** A throw the animator is still coiling for. */
interface PendingThrow extends ThrowIntent {
  id: number;
  /** Seconds of coil elapsed. */
  t: number;
  /** Seconds since the AI last re-asserted that it wants this throw. */
  since: number;
}

function copyThrow(src: Extract<PlayerAction, { kind: 'throw' }>, dst: ThrowIntent): void {
  dst.throwType = src.throwType;
  dst.aimX = src.aimX; dst.aimY = src.aimY; dst.aimZ = src.aimZ;
  dst.speed = src.speed;
  dst.receiverId = src.receiverId;
}

/** Options `placeBody` understands. Named so the tableaux read as English. */
interface PlaceOpts {
  speed?: number;
  dirX?: number;
  dirZ?: number;
  state?: LocoPlayer['state'];
  prone?: boolean;
  airborne?: boolean;
  /** Height of the body centre above the turf. */
  y?: number;
}

/**
 * The camera a tableau is being composed for, reduced to the four things a
 * composition actually needs: where it is, which way it looks, which way is
 * screen-right, and how wide the cone is.
 */
interface Frame {
  c: THREE.Vector3;
  d: THREE.Vector3;
  r: THREE.Vector3;
  /** tan of the half horizontal field of view at 16:9. */
  tanH: number;
  focus: number;
}

const CAPTURE_ASPECT = 16 / 9;

function makeFrame(shot: Shot): Frame {
  const c = new THREE.Vector3().fromArray(shot.pos as unknown as number[]);
  const t = new THREE.Vector3().fromArray(shot.target as unknown as number[]);
  const d = t.sub(c).normalize();
  const r = new THREE.Vector3(-d.z, 0, d.x).normalize();
  const tanV = Math.tan((shot.fov * Math.PI) / 360);
  return { c, d, r, tanH: tanV * CAPTURE_ASPECT, focus: shot.focus ?? 0 };
}

/**
 * Which camera to compose against.
 *
 * The rig hands the whole `Shot` over on `shot:apply`, but the headless tests
 * emit only `{tableau}` and a hotkey may emit nothing at all — so fall back to
 * the shot of that name, then to the first shot that declares this tableau,
 * then to the broadcast angle. A tableau always has a camera to solve against.
 */
function resolveShot(cam: Shot | undefined, name: string, tableau: string): Shot {
  if (cam && Array.isArray(cam.pos) && typeof cam.fov === 'number') return cam;
  const byName = (SHOTS as Record<string, Shot>)[name];
  if (byName) return byName;
  for (const s of Object.values(SHOTS as Record<string, Shot>)) {
    if (s.tableau === tableau) return s;
  }
  return SHOTS.broadcast as Shot;
}

function hashName(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** GameState phase -> the four-value phase the AI reasons about. */
function gamePhaseFor(p: Phase): GamePhase {
  switch (p) {
    case 'PRE_PULL': return 'setup';
    case 'PULL_IN_FLIGHT': return 'live';
    case 'LIVE_POSSESSION': return 'live';
    case 'DISC_IN_FLIGHT': return 'live';
    // A dead disc is still live football: somebody has to go and get it, which
    // is the AI's `ground` branch, not its line-up branch.
    case 'TURNOVER_DEAD': return 'live';
    case 'CHECK': return 'live';
    default: return 'setup';
  }
}

function discPhaseFor(p: Phase, mode: 'held' | 'flight' | 'ground'): AIDiscState['state'] {
  if (p === 'PULL_IN_FLIGHT') return 'flight';
  if (p === 'TURNOVER_DEAD') return 'ground';
  if (mode === 'held') return 'held';
  if (mode === 'flight') return 'flight';
  return 'ground';
}
