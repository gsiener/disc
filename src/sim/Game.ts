import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx.ts';
import { Rng } from '../core/Ctx.ts';

import {
  catchProbability, createTeamAI, makePlayer, restBetweenPoints, updateTeam,
  type AIPlayer, type AIWorld, type Archetype, type DiscState as AIDiscState,
  type GamePhase, type PlayerAction, type PlayerIntent as AIIntent, type TeamAI,
  type ThrowType as AIThrowType,
} from './AI.ts';
import { Locomotion, type DesiredMove, type LocoPlayer } from './Locomotion.ts';
import { createGameState, GameState, type Phase } from './GameState.ts';
import {
  FIELD, brickMark, clampToField, isInBounds, type Dir, type TeamId, type Vec3,
} from './Rules.ts';
import { DiscRuntime, type ThrowRequest } from '../entities/Disc.ts';
import { powerForSpeed, type ThrowType as PhysThrowType } from './DiscPhysics.ts';
import type { PlayerIntent as HumanIntent } from '../input/Intent.ts';
import type { IntentGates } from '../input/Human.ts';
import type { DefenderCandidate, SwitchSituation } from '../input/Switch.ts';

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

  /* tableau */
  private posed = false;
  private poseName = '';
  private poseHold = 0;

  private field: { heightAt?(x: number, z: number): number } | undefined;

  /* --------------------------------------------------------------- lifecycle */

  init(ctx: Ctx): void {
    this.seed = ctx.rand.fork(0x6a3e1c).int(0, 0x7fffffff);
    this.rng = new Rng(this.seed);

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

    this.rebuildAI();
    this.buildWorld();
    this.lineUpForPull();

    ctx.events.on('shot:apply', (p: { name?: string; shot?: { tableau?: string } }) => {
      this.applyTableau(p?.shot?.tableau ?? 'flow', p?.name ?? '', ctx);
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
    this.ai = [
      createTeamAI(0, d0, r, { formation: 'vertical', force: 'forehand', aggression: 1.05, seed: 11 }),
      createTeamAI(1, d1, r, { formation: 'horizontal', force: 'forehand', aggression: 0.95, zoneBias: 0.05, seed: 29 }),
    ];
  }

  /* ------------------------------------------------------------------ step */

  update(dt: number, ctx: Ctx): void {
    if (this.posed) {
      if (!ctx.capture) {
        this.poseHold -= dt;
        if (this.poseHold <= 0) this.posed = false;
      }
      if (this.posed) return;
    }

    this.readHuman(ctx, dt);
    this.syncAIFromBodies();
    this.buildWorld();

    /* 1 — intents ---------------------------------------------------------- */
    this.intents.length = 0;
    this.actionOf.clear();
    const a = updateTeam(this.ai[0], this.world, dt);
    const b = updateTeam(this.ai[1], this.world, dt);
    for (const it of a) this.intents.push(it);
    for (const it of b) this.intents.push(it);

    /* 2 — locomotion (one path for humans and AI) --------------------------- */
    const human = this.liveHumanIntent(ctx);
    for (const it of this.intents) {
      const e = this.byId.get(it.id);
      if (!e) continue;
      if (human && it.id === this.controlledPlayerId) {
        this.actionOf.set(it.id, this.humanAction(human, e));
        this.loco.step(e.loco, this.humanDesired(human, e), dt);
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

    /* 5 — the disc ---------------------------------------------------------- */
    this.stepDisc(dt);

    /* 6 — the rules --------------------------------------------------------- */
    this.stepRules(dt);

    /* 7 — the referee ------------------------------------------------------- */
    this.orchestrate(dt);
    this.autoSelectControlled();

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
    // A thrower with an established pivot does not travel.
    if (this.gs.thrower === e.id && this.gs.phase === 'LIVE_POSSESSION') {
      d.effort = Math.min(d.effort ?? 1, 0.22);
      d.mode = 'jog';
    }
    return d;
  }

  /** Human intent -> the same one-shot `PlayerAction` the AI emits. */
  private humanAction(hi: HumanIntent, e: RosterEntry): PlayerAction | null {
    if (hi.receiver.cycle !== 0) this.cycleReceiver(hi.receiver.cycle);
    if (hi.release.fired && this.gs.thrower === e.id && this.gs.phase === 'LIVE_POSSESSION') {
      const type = HUMAN_THROW_MAP[hi.release.type] ?? 'backhand';
      const yaw = hi.release.aimYaw;
      const q = hi.release.quality;
      // Release quality is spread, exactly as it is for the AI: a rushed or
      // overcharged throw wanders, a perfect one goes where it was pointed.
      const spread = (1 - q) * 0.16 + (1 - hi.release.steadiness) * 0.05;
      const jitter = this.rng.gauss() * spread;
      const dir = yaw + jitter;
      const dist = 6 + 46 * hi.release.power;
      this.humanThrow(e, type, dir, hi.release.power, hi.release.tilt, dist, q);
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

  /* --------------------------------------------------------------- actions */

  private dispatchActions(): void {
    for (const [id, action] of this.actionOf) {
      if (!action) continue;
      const e = this.byId.get(id);
      if (!e) continue;
      switch (action.kind) {
        case 'throw': {
          if (this.gs.phase !== 'LIVE_POSSESSION' || this.gs.thrower !== id) break;
          this.aiThrow(e, action);
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
   * Solve the release for an AI throw.
   *
   * The AI hands us a point it wants the disc to arrive at. A disc is not a
   * projectile — lift, drag and precession move the landing point tens of
   * metres — so the launch elevation is bisected against the real integrator
   * and the heading is then corrected for the curve the disc actually flew.
   * Two outer passes is enough to land inside a receiver's catch radius, and it
   * costs a couple of milliseconds on the frame a throw is released.
   */
  private aiThrow(e: RosterEntry, act: Extract<PlayerAction, { kind: 'throw' }>): void {
    const type = THROW_MAP[act.throwType] ?? 'backhand';
    const hand: 'R' | 'L' = e.ai.handed === 'left' ? 'L' : 'R';
    const lp = e.loco;
    _from.set(lp.pos.x, lp.groundY + lp.hipHeight * 0.98, lp.pos.z);
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
    tilt: number, _dist: number, quality: number,
  ): void {
    const lp = e.loco;
    _from.set(lp.pos.x, lp.groundY + lp.hipHeight * 0.98, lp.pos.z);
    _aim.set(Math.sin(yaw), 0, Math.cos(yaw));
    const hand: 'R' | 'L' = e.ai.handed === 'left' ? 'L' : 'R';
    // Power buys distance; the stick's tilt buys curve; quality buys a clean
    // nose. An overcharged release comes out nose-up and dies.
    const vel = this.discRuntime.release({
      type, from: _from, aim: _aim,
      power: clampNum(0.18 + 0.82 * power, 0.12, 1),
      angle: 0.02 + 0.16 * power,
      spin: clampNum(0.35 + 0.55 * quality, 0.1, 1),
      hand,
      bank: tilt * 0.85,
      nose: (1 - quality) * 0.08,
    });
    this.commitRelease(e, type, this.selectedReceiver, vel);
  }

  private commitRelease(e: RosterEntry, type: PhysThrowType, receiverId: number, vel: THREE.Vector3): void {
    const s = this.discRuntime.state;
    this.thrownBy = e.id;
    this.intendedReceiver = receiverId;
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
    this.discRuntime.hold(e.id, _v, _norm, this.gs.clock * 0.6);
  }

  /** null = not probed yet, false = the peer does not offer one (or misbehaved). */
  private handAnchor: HandAnchorFn | false | null = null;
  private sysRef: Record<string, unknown> | undefined;

  private carryFromRig(e: RosterEntry): boolean {
    if (this.handAnchor === null) {
      const peer = this.sysRef?.['players'] as Record<string, unknown> | undefined;
      const fn = peer?.['discAnchor'] ?? peer?.['handAnchor'];
      this.handAnchor = typeof fn === 'function'
        ? (fn as HandAnchorFn).bind(peer) as HandAnchorFn
        : false;
    }
    if (this.handAnchor === false) return false;
    try {
      if (!this.handAnchor(e.id, _v, _norm)) { this.handAnchor = false; return false; }
    } catch { this.handAnchor = false; return false; }
    if (!Number.isFinite(_v.x) || !Number.isFinite(_v.y) || !Number.isFinite(_v.z)
      || !(_norm.lengthSq() > 1e-6)) { this.handAnchor = false; return false; }
    this.discRuntime.hold(e.id, _v, _norm.normalize(), this.gs.clock * 0.6);
    return true;
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
      if (phase === 'PULL_IN_FLIGHT' && e.team !== offense) continue;
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

    gs.step(dt, {
      discPos: liveDisc ? { x: s.pos.x, y: s.pos.y, z: s.pos.z } : undefined,
      throwerPos: thrower ? { x: thrower.loco.pos.x, y: 0, z: thrower.loco.pos.z } : undefined,
      pivotFoot: thrower && Math.hypot(thrower.loco.vel.x, thrower.loco.vel.z) < 0.6
        ? { x: thrower.loco.foot.pos.x, y: 0, z: thrower.loco.foot.pos.z } : undefined,
      markerId,
      markerPos,
    });
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
    }
    if (to === 'POINT_SCORED') this.poseHold = 0;
    void from;
  }

  /** Everyone onto their own goal line, ready for the pull. */
  private lineUpForPull(): void {
    const gs = this.gs;
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
  }

  private doPull(): void {
    const gs = this.gs;
    const team = gs.pullingTeam;
    const line = this.roster.filter((r) => r.team === team);
    // The best arm on the line pulls.
    let puller = line[0];
    for (const e of line) if (e.ai.attr.throwPower > puller.ai.attr.throwPower) puller = e;
    this.pullerId = puller.id;

    const dir = gs.attackDir[team];
    const lp = puller.loco;
    _from.set(lp.pos.x, lp.groundY + lp.hipHeight * 1.05, lp.pos.z);
    // Aim across to the far side so the pull is a real cross-field bomb.
    const bias = lp.pos.x > 0 ? -1 : 1;
    _aim.set(bias * 0.22, 0, dir);
    const vel = this.discRuntime.release({
      type: 'backhand', from: _from, aim: _aim,
      power: 0.96, angle: 0.30, spin: 0.92,
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
   * On offence you drive whoever has the disc; on defence you drive whoever has
   * the best claim on the disc's destination. Both are what the player expects
   * to happen without asking.
   */
  private autoSelectControlled(): void {
    const gs = this.gs;
    const mine = gs.possession === this.humanTeam;
    if (mine && gs.thrower !== null && this.byId.get(gs.thrower)?.team === this.humanTeam) {
      this.controlledPlayerId = gs.thrower;
      return;
    }
    if (!mine && this.humanIdle > 1.5) {
      const t = this.threatPoint();
      let best = -1, bestScore = Infinity;
      for (const e of this.roster) {
        if (e.team !== this.humanTeam) continue;
        const s = Math.hypot(e.loco.pos.x - t.x, e.loco.pos.z - t.z);
        if (s < bestScore) { bestScore = s; best = e.id; }
      }
      if (best >= 0) this.controlledPlayerId = best;
    }
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

  setControlledPlayer(playerId: number): void {
    if (this.byId.has(playerId)) this.controlledPlayerId = playerId;
  }

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
  private applyTableau(tableau: string, shot: string, ctx: Ctx): void {
    this.posed = true;
    this.poseName = tableau;
    this.poseHold = 2.5;
    const r = new Rng((this.seed ^ hashName(tableau + shot)) >>> 0);

    // A plausible mid-game scoreline so the HUD is not sitting on 0-0.
    this.gs.score[0] = 9; this.gs.score[1] = 8;
    this.gs.teams[0].score = 9; this.gs.teams[1].score = 8;
    this.gs.point = 18;
    this.gs.stallCount = 4;
    this.gs.phase = 'LIVE_POSSESSION';
    this.gs.possession = 0;
    this.gs.attackDir = [1, -1];
    this.aiDir = [1, -1];

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

  /** Place a body and stop it dead. `state` picks the animation pose. */
  private placeBody(
    e: RosterEntry, x: number, z: number, facing: number,
    o: { speed?: number; dirX?: number; dirZ?: number; state?: LocoPlayer['state']; prone?: boolean; airborne?: boolean; y?: number } = {},
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
    lp.foot.pos.set(x, lp.groundY, z);
    lp.foot.contact = !lp.air.airborne;
  }

  private of(team: TeamId, slot: number): RosterEntry { return this.roster[team * 7 + slot]; }

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
   * Broadcast flow. Offence attacking +Z with the disc on the left hash, a
   * vertical stack ahead of it, an under cut live and a deep threat clearing.
   * The camera sits at (-34, 15.5, 30) looking at (0, 1.6, 4), so the whole
   * arrangement is built around z ~ 0..26.
   */
  private tableauFlow(r: Rng): void {
    const thrower = this.of(0, 0);
    this.placeBody(thrower, -6.4, 1.2, 1.15, { state: 'idle' });
    // The mark, straddling the forehand side, low and wide.
    this.placeBody(this.of(1, 0), -4.6, 2.4, Math.atan2(-1.8, -1.2), { state: 'shuffle', speed: 0.6 });

    // Reset handler behind the disc with his defender playing the up-line.
    this.pair(1, -11.4, -3.4, 0.9, 1.4, -1.6, 1.5);
    // The live under cut — the reason this frame is a play and not a formation.
    this.pair(2, -1.6, 8.6, Math.atan2(-4.6, -6.2), 7.4, -2.2, 1.4, 6.6);
    // Vertical stack.
    this.pair(3, 2.2, 14.6, 0.2, 1.6, 2.0, 1.6);
    this.pair(4, 2.9, 19.2, 0.15, 1.2, 2.2, 1.7);
    // Deep threat pulling the last defender out of the picture.
    this.pair(5, 6.4, 26.4, 0.1, 8.2, 3.1, 1.2, 8.0);
    // Weak-side cutter clearing.
    this.pair(6, -12.6, 11.8, 2.6, 4.4, -1.4, -1.6);

    this.gs.thrower = thrower.id;
    this.gs.pivot = { x: thrower.loco.pos.x, y: 0, z: thrower.loco.pos.z };
    this.discRuntime.mode = 'held';
    this.discRuntime.holderId = thrower.id;
    this.carryDisc();
    this.discRuntime.wear = 0.45;
    void r;
  }

  /** Sideline telephoto: a handler pivoting against a mark. */
  private tableauMark(r: Rng): void {
    const thrower = this.of(0, 0);
    // Camera is at x = -26 looking at (2, 1.5, 2): face the thrower across it.
    this.placeBody(thrower, 2.0, 2.0, -1.35, { state: 'idle' });
    this.placeBody(this.of(1, 0), 3.55, 3.35, Math.atan2(-1.55, -1.35), { state: 'shuffle', speed: 0.5 });

    this.pair(1, -4.0, -2.4, 1.1, 1.0, -1.5, 1.4);
    this.pair(2, 4.2, 13.5, Math.atan2(-2.0, -5.5), 7.0, -2.4, 1.5, 6.4);
    this.pair(3, 8.5, 21.0, 0.2, 2.0, 2.4, 1.5);
    this.pair(4, -8.0, 17.0, 0.4, 5.5, -2.0, -1.4);
    this.pair(5, 11.5, 30.0, 0.1, 7.6, 3.0, 1.1);
    this.pair(6, -13.0, 6.0, 2.4, 3.0, -1.2, -1.5);

    this.gs.thrower = thrower.id;
    this.gs.stallCount = 6;
    this.discRuntime.mode = 'held';
    this.discRuntime.holderId = thrower.id;
    this.carryDisc();
    this.discRuntime.wear = 0.55;
    void r;
  }

  /** Character hero shot: a receiver at the origin, three-quarter to camera. */
  private tableauPortrait(r: Rng): void {
    const hero = this.of(0, 4);
    // Camera at (2.1, 1.72, 3.0); face slightly off-axis for a 3/4 view.
    const toCam = Math.atan2(2.1, 3.0);
    this.placeBody(hero, 0, 0, toCam - 0.42, { state: 'idle' });
    hero.loco.foot.contact = true;

    // Bodies far behind for the bokeh field, none close enough to crowd him.
    const others = this.roster.filter((e) => e !== hero);
    for (let i = 0; i < others.length; i++) {
      const a = -1.2 + (i / others.length) * 2.6;
      const d = 14 + r.range(0, 22);
      this.placeBody(others[i], Math.sin(a) * d, -Math.cos(a) * d - 6, a + Math.PI,
        { speed: r.range(2, 7) });
    }
    this.discRuntime.mode = 'ground';
    _v.set(-9, 0, -18);
    this.discRuntime.settle(_v);
  }

  /**
   * Peak action: a receiver fully extended, disc at the fingertips, defender
   * trailing. The disc is staged by throwing a real pass and translating the
   * recorded flight so it terminates exactly at the fingertips — the trail in
   * frame is the path DiscPhysics actually produced.
   */
  private tableauLayout(r: Rng): void {
    const rec = this.of(0, 4);
    const def = this.of(1, 4);
    // Camera at (7.5, 1.1, 9) on (0, 0.85, 0); view axis (-0.64, -0.77) in XZ.
    // Everything moves perpendicular to it — receiver, defender and disc all
    // cross the frame rather than running down the lens.
    this.placeBody(rec, 1.55, -1.28, Math.atan2(-0.77, 0.64), {
      speed: 7.4, dirX: -0.77, dirZ: 0.64, state: 'layout', prone: true, airborne: true, y: 0.62,
    });
    rec.loco.vel.y = 0.55;
    rec.loco.air.tTakeoff = 0; rec.loco.air.tApex = 0.06; rec.loco.air.apexY = rec.loco.pos.y + 0.02;

    this.placeBody(def, 3.6, -2.85, Math.atan2(-0.77, 0.64), { speed: 7.9, dirX: -0.77, dirZ: 0.64, state: 'sprint' });

    // The thrower and the rest, spread out behind and away.
    this.placeBody(this.of(0, 0), -16.5, -12.0, Math.atan2(16.5, 12.0), { state: 'idle' });
    this.placeBody(this.of(1, 0), -15.2, -10.9, Math.atan2(-1.3, -1.1), { state: 'shuffle' });
    for (let i = 1; i <= 3; i++) {
      const t = i / 4;
      this.pair(i, -10 + t * 22, 9 + t * 16, 0.3, 3 + 3 * t, 2.0, 1.5);
    }
    this.pair(5, 12.5, 22.0, 0.2, 7.2, 2.8, 1.2);
    this.pair(6, -14.0, 4.0, 2.5, 3.4, -1.4, -1.5);

    this.stageFlight(new THREE.Vector3(0.10, 0.92, 0.05), 'forehand', 0.60, 0.04, 0.9, -0.88, 0.50, 0.30);
    this.discRuntime.wear = 0.6;
    void r;
  }

  /** Macro on a spinning disc mid-huck, with the real curved path behind it. */
  private tableauHuck(r: Rng): void {
    // Camera at (3.2, 2.4, 3.4) on (0, 2.2, 0), so the view axis is (-0.68, -0.72)
    // in XZ. Heading 2.33 rad is exactly perpendicular to it: the disc crosses
    // the frame instead of receding down the lens axis, which is the difference
    // between a trail that reads as flight and one that is a bar over the lens.
    // The bank leans the plate toward the camera — a real outside-in huck — so
    // the hot stamp is visible rather than presenting a bare edge.
    this.stageFlight(new THREE.Vector3(0, 2.2, 0), 'backhand', 0.94, 0.16, 1.0, 2.33, 0.55, 0.75);

    // Bodies well behind the focal plane so there is something to defocus.
    const pairs: [number, number][] = [[-17, -19], [-24, -12], [-11, -27], [-30, -25]];
    for (let i = 0; i < 4; i++) {
      const [x, z] = pairs[i];
      this.pair(i + 1, x, z, Math.atan2(-x, -z), 6.2 + r.range(0, 1.8), 2.2, 1.4);
    }
    this.placeBody(this.of(0, 0), 3.6, -6.4, Math.atan2(-3.6, 6.4), { state: 'idle' });
    this.placeBody(this.of(1, 0), 2.4, -5.2, Math.atan2(1.2, -1.2), { state: 'shuffle' });
    this.placeBody(this.of(0, 5), -34, -34, 0.7, { speed: 8 });
    this.placeBody(this.of(1, 5), -36, -36, 0.7, { speed: 8 });
    this.discRuntime.wear = 0.35;
  }

  /** Endzone score: the catch completed, teammates converging. */
  private tableauScore(r: Rng): void {
    // Camera at (4, 2.2, -46) looking at (-1, 1.7, -54). Put the scorer on that
    // sight line, four metres out, and still inside the end line.
    const scorer = this.of(1, 4);
    this.gs.possession = 1;
    this.gs.attackDir = [1, -1];
    this.placeBody(scorer, 1.75, -49.3, Math.atan2(4 - 1.75, -46 + 49.3), { state: 'idle' });

    const mates: [number, number][] = [[-2.6, -45.2], [4.9, -44.0], [-6.4, -41.0], [7.6, -39.5]];
    for (let i = 0; i < 4; i++) {
      const [x, z] = mates[i];
      const e = this.of(1, [0, 1, 2, 3][i]);
      this.placeBody(e, x, z, Math.atan2(1.75 - x, -49.3 - z), { speed: 5.4 + r.range(0, 1.6), state: 'sprint' });
    }
    this.placeBody(this.of(1, 5), -10.5, -36.0, 0.4, { speed: 6.2, state: 'sprint' });
    this.placeBody(this.of(1, 6), 12.0, -34.0, 0.6, { speed: 5.8, state: 'sprint' });

    // The beaten defence.
    this.placeBody(this.of(0, 4), -0.9, -46.6, Math.atan2(2.65, -2.7), { state: 'idle' });
    for (let i = 0; i < 6; i++) {
      const e = this.of(0, i);
      if (i === 4) continue;
      this.placeBody(e, -14 + i * 5.2, -37.5 + (i % 2) * 3.4, 2.9, { speed: 1.2, state: 'jog' });
    }
    this.placeBody(this.of(0, 6), 15.0, -33.0, 3.0, { speed: 1.0, state: 'jog' });

    // The disc, just caught, still on the fingertips.
    const lp = scorer.loco;
    _v.set(lp.pos.x + 0.24, lp.groundY + lp.hipHeight * 1.55, lp.pos.z + 0.30);
    _norm.set(0.35, 0.68, 0.64).normalize();
    this.discRuntime.hold(scorer.id, _v, _norm, 1.1);
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

    _v2.copy(target).sub(rt.state.pos);
    rt.state.pos.copy(target);
    for (const s of rt.trail) { s.x += _v2.x; s.y += _v2.y; s.z += _v2.z; }
    rt.mode = 'flight';
    rt.state.touchedGround = false;
    rt.state.atRest = false;
    rt.sinceRelease = back;
    this.gs.phase = 'DISC_IN_FLIGHT';
    this.gs.thrower = null;
  }

  /** Which tableau is currently latched, or '' when the match is live. */
  get tableau(): string { return this.posed ? this.poseName : ''; }
}

/* ---------------------------------------------------------------- helpers */

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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
