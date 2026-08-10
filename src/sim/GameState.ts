/**
 * ULTIMATE — the game state machine.
 *
 * A deterministic, event-driven rules engine for 7v7 outdoor Ultimate. It owns
 * the phase machine, possession, the stall count, scoring, halftime/caps,
 * timeouts, self-officiated calls, and a full box score.
 *
 * It is deliberately decoupled from the renderer and the physics:
 *   - physics/AI call the *report* methods (`pull`, `release`, `catchDisc`,
 *     `drop`, `ground`, `outOfBounds`, `block`, ...) when something happens;
 *   - `step(dt, obs?)` is driven at a fixed 1/120 s and runs the clocks;
 *   - everything it decides comes back out as events.
 *
 * No Math.random, no wall clock, no THREE. Construct it with a plain emitter:
 *
 *   const gs = new GameState({ emit: (e, p) => log.push([e, p]) });
 *   gs.startGame();
 *   gs.pull(7, { x: 0, y: 1, z: 32 });
 *
 * or from the engine:
 *
 *   const gs = new GameState({ emit: ctx.events });
 *
 * Events emitted
 *   disc:released  { pos, vel, spin, throwType, playerId, team }
 *   disc:caught    { playerId, pos, team, outcome }
 *   disc:grounded  { pos, reason }
 *   score          { team, playerId, assistId, score, scoreline }
 *   pull           { team, playerId, from }
 *   stall:tick     { count, playerId, team, max }
 *   turnover       { reason, from, to, playerId, pos, spot }
 *   state:changed  { from, to, clock, possession, score }
 *   call           { type, callerId, againstId, at }
 *   call:resolved  { type, contested, outcome }
 *   timeout        { team, playerId, remaining }
 *   half           { half, score }
 *   game:over      { score, winner }
 */

import {
  DEFAULT_RULES, FIELD, boundaryCrossing, brickMark, clampToField, copy, distXZ,
  effectiveTarget, flipDir, goalLineZ, isGameOver, isGoal, isInBounds, isTravel,
  doubleTeamOffender, makeRules, markerStatus, otherTeam, putIntoPlaySpot, resumeStallCount,
  stallCountFor, stallElapsedFor, v3,
  type CapState, type Dir, type MarkerStatus, type PlayerId, type RuleSet,
  type TeamId, type Vec3,
} from './Rules.ts';

export {
  FIELD, DEFAULT_RULES, brickMark, isGoal, isInBounds,
  type Dir, type PlayerId, type RuleSet, type TeamId, type Vec3,
} from './Rules.ts';

/* ------------------------------------------------------------------- types */

/**
 * How long a double team must stand before the thrower is deemed to have
 * called it (USAU 16.G is a call, not an automatic stoppage).
 */
const DOUBLE_TEAM_CALL = 0.6;

export type Phase =
  | 'PRE_PULL'
  | 'PULL_IN_FLIGHT'
  | 'LIVE_POSSESSION'
  | 'DISC_IN_FLIGHT'
  | 'TURNOVER_DEAD'
  | 'CHECK'
  | 'POINT_SCORED'
  | 'TIMEOUT'
  | 'HALFTIME'
  | 'GAME_OVER';

export type TurnoverReason =
  | 'drop'
  | 'throwaway'
  | 'out-of-bounds'
  | 'caught-out-of-bounds'
  | 'block'
  | 'interception'
  | 'stall-out'
  | 'pull-drop'
  | 'travel-violation'
  | 'double-touch';

/** Why the disc is currently dead and waiting to be put back into play. */
export type DeadReason =
  | 'turnover'
  | 'pull-landed'
  | 'pull-out-of-bounds'
  | 'pull-dropped';

export type CallType = 'foul' | 'travel' | 'pick' | 'strip' | 'violation';

export interface EmitterLike { emit(evt: string, payload?: any): void }
export type EmitFn = (evt: string, payload?: any) => void;

export interface PlayerSetup { id: PlayerId; name?: string; number?: number }
export interface TeamSetup { name?: string; players?: PlayerSetup[] }

export interface GameStateOptions {
  /** EventBus (ctx.events), any object with emit(), or a bare function. */
  emit?: EmitterLike | EmitFn;
  rules?: Partial<RuleSet>;
  teams?: [TeamSetup, TeamSetup];
  /** Which team pulls to open the game. Default 1. */
  startingPullTeam?: TeamId;
  /** Attacking direction of team 0 for the opening point. Default +1. */
  startingDirTeam0?: Dir;
  /** Called for every play-by-play line. */
  onLog?: (line: PlayLogEntry) => void;
  /** Ring-buffer size for getLog(). Default 4096. */
  maxLog?: number;
}

export interface PlayLogEntry {
  /** Sim seconds since startGame(). */
  t: number;
  phase: Phase;
  point: number;
  text: string;
}

export interface FrameObservation {
  discPos?: Vec3;
  /** Live position of the player holding the disc. */
  throwerPos?: Vec3;
  /** Live position of the thrower's pivot foot (travel detection). */
  pivotFoot?: Vec3;
  /** null = nobody is marking, so the count may not run. */
  markerId?: PlayerId | null;
  markerPos?: Vec3 | null;
  /** Every defender and every offensive player, for the double-team test. */
  defenders?: readonly { id: PlayerId; pos: Vec3 }[];
  offence?: readonly { id: PlayerId; pos: Vec3 }[];
}

export interface ActionResult { ok: boolean; note?: string }

/* ------------------------------------------------------------------- stats */

/**
 * Distances are METRES (the field is metric). Multiply by YARDS_PER_METRE from
 * Rules.ts for a US-style display. `yards*` are the downfield component toward
 * the throwing team's attacking endzone and may be negative; `*Distance` is the
 * unsigned planar length of the throw.
 */
export interface PlayerStats {
  id: PlayerId;
  team: TeamId;
  name: string;

  goals: number;
  assists: number;
  hockeyAssists: number;
  blocks: number;

  /** Passes thrown. attempts === completions + throwaways + throwsDropped. */
  attempts: number;
  completions: number;
  throwaways: number;
  /** Subset of throwaways that a defender got a hand on. */
  blockedThrows: number;
  /** Passes I threw that my receiver dropped (charged to them, not me). */
  throwsDropped: number;

  /** Passes caught from a team-mate (goals included). */
  catches: number;
  /** Every time this player gained possession, including pickups and Ds. */
  touches: number;
  drops: number;
  stallOuts: number;

  pulls: number;
  pullsOutOfBounds: number;

  yardsThrown: number;
  yardsReceived: number;
  throwDistance: number;
  receiveDistance: number;

  /** Seconds holding the disc as the thrower. */
  timeOfPossession: number;
  pointsPlayed: number;

  /** (goals + assists + blocks) - (throwaways + drops + stallOuts). */
  plusMinus: number;

  foulsCommitted: number;
  travels: number;
  picks: number;
}

export interface TeamStats {
  team: TeamId;
  name: string;

  score: number;
  goals: number;
  assists: number;
  blocks: number;

  attempts: number;
  completions: number;
  throwaways: number;
  drops: number;
  stallOuts: number;

  turnoversCommitted: number;
  turnoversForced: number;

  yardsThrown: number;
  yardsReceived: number;

  /** Seconds this team had the disc (including its throws in flight). */
  timeOfPossession: number;
  possessions: number;

  pulls: number;
  holds: number;
  breaks: number;
  pointsPlayed: number;

  timeoutsRemaining: number;
  timeoutsUsed: number;
}

export interface PendingCall {
  type: CallType;
  callerId: PlayerId;
  callerTeam: TeamId;
  againstId: PlayerId;
  againstTeam: TeamId;
  at: Vec3;
  /** Phase the game was in when the call was made. */
  phaseAtCall: Phase;
  stallAtCall: number;
}

/* --------------------------------------------------------------- utilities */

function emptyPlayer(id: PlayerId, team: TeamId, name: string): PlayerStats {
  return {
    id, team, name,
    goals: 0, assists: 0, hockeyAssists: 0, blocks: 0,
    attempts: 0, completions: 0, throwaways: 0, blockedThrows: 0, throwsDropped: 0,
    catches: 0, touches: 0, drops: 0, stallOuts: 0,
    pulls: 0, pullsOutOfBounds: 0,
    yardsThrown: 0, yardsReceived: 0, throwDistance: 0, receiveDistance: 0,
    timeOfPossession: 0, pointsPlayed: 0, plusMinus: 0,
    foulsCommitted: 0, travels: 0, picks: 0,
  };
}

function emptyTeam(team: TeamId, name: string, timeouts: number): TeamStats {
  return {
    team, name,
    score: 0, goals: 0, assists: 0, blocks: 0,
    attempts: 0, completions: 0, throwaways: 0, drops: 0, stallOuts: 0,
    turnoversCommitted: 0, turnoversForced: 0,
    yardsThrown: 0, yardsReceived: 0,
    timeOfPossession: 0, possessions: 0,
    pulls: 0, holds: 0, breaks: 0, pointsPlayed: 0,
    timeoutsRemaining: timeouts, timeoutsUsed: 0,
  };
}

/** (goals + assists + blocks) - (throwaways + drops + stall-outs). */
export function computePlusMinus(s: PlayerStats): number {
  return (s.goals + s.assists + s.blocks) - (s.throwaways + s.drops + s.stallOuts);
}

/* =========================================================================
 *  GameState
 * ========================================================================= */

export class GameState {
  readonly rules: RuleSet;

  /* ---- phase / clocks ---- */
  phase: Phase = 'PRE_PULL';
  /** Sim seconds since startGame(). */
  clock = 0;
  /** Seconds in the current phase. */
  phaseTimer = 0;
  /** Points completed + 1 (1-based). */
  point = 1;
  half: 1 | 2 = 1;
  cap: CapState = 'none';
  /** Score a team must reach right now (moves under a cap). */
  target: number;

  /* ---- score / sides ---- */
  score: [number, number] = [0, 0];
  attackDir: [Dir, Dir];
  pullingTeam: TeamId;
  receivingTeam: TeamId;
  readonly openingPullTeam: TeamId;

  /* ---- possession ---- */
  possession: TeamId | null = null;
  thrower: PlayerId | null = null;
  /** Established pivot (where the next throw is measured from). */
  pivot: Vec3 = v3();
  discPos: Vec3 = v3();

  /* ---- stall ---- */
  stallCount = 0;
  stallElapsed = 0;
  stallRunning = false;
  marker: PlayerId | null = null;
  markerState: MarkerStatus = 'legal';
  /** Seconds the current double team has stood; see the note in `step`. */
  private doubleTeamHeld = 0;
  private doubleTeamCalled = false;
  /** The dt of the step `observe` is running inside; 0 when called standalone. */
  private observeDt = 0;

  /* ---- dead disc / restarts ---- */
  deadReason: DeadReason | null = null;
  /** Set while a pull is out of bounds and the receiver has not chosen yet. */
  pullOobCrossing: Vec3 | null = null;
  /** Stall count to restore when play restarts from a CHECK. */
  pendingStallResume = 0;
  /** Phase to return to when a TIMEOUT/CHECK ends. */
  resumeAfterStoppage: Phase = 'LIVE_POSSESSION';
  pendingCall: PendingCall | null = null;
  /** Team that called the timeout currently in progress. */
  timeoutTeam: TeamId | null = null;

  /* ---- rosters ---- */
  readonly players = new Map<PlayerId, PlayerStats>();
  readonly teams: [TeamStats, TeamStats];
  lines: [PlayerId[], PlayerId[]];

  /* ---- per-throw bookkeeping ---- */
  private throwOrigin: Vec3 = v3();
  private throwerOfPass: PlayerId | null = null;
  /** Chain of players who have touched the disc this possession. */
  private chain: PlayerId[] = [];
  /** Payload of the most recent goal — for the HUD, replays and test harnesses. */
  lastScore: { team: TeamId; playerId: PlayerId; assistId: PlayerId | null; score: [number, number]; point: number } | null = null;
  private lastScoringTeam: TeamId | null = null;
  private pointReceivingTeam: TeamId = 0;
  /**
   * The team that received the pull this point, so a goal for them is a hold and
   * a goal against them is a break. Read-only to the outside: it is set by
   * `beginPoint` and by nobody else, and a caller that could write it could
   * rewrite the hold/break column.
   */
  get pointReceiver(): TeamId { return this.pointReceivingTeam; }
  private travelFlagged = false;
  private hardCapPointIsLast = false;

  /* ---- io ---- */
  private emitFn: EmitFn;
  private onLog?: (line: PlayLogEntry) => void;
  private logBuf: PlayLogEntry[] = [];
  private maxLog: number;

  constructor(opts: GameStateOptions = {}) {
    this.rules = makeRules(opts.rules);
    this.maxLog = opts.maxLog ?? 4096;
    this.onLog = opts.onLog;

    const e = opts.emit;
    if (!e) this.emitFn = () => {};
    else if (typeof e === 'function') this.emitFn = e;
    else this.emitFn = (evt, payload) => e.emit(evt, payload);

    const setup: [TeamSetup, TeamSetup] = opts.teams ?? [{}, {}];
    const names: [string, string] = [setup[0].name ?? 'HOME', setup[1].name ?? 'AWAY'];
    this.teams = [
      emptyTeam(0, names[0], this.rules.timeoutsPerHalf),
      emptyTeam(1, names[1], this.rules.timeoutsPerHalf),
    ];

    this.lines = [[], []];
    for (let t = 0 as TeamId; t <= 1; t = (t + 1) as TeamId) {
      const roster = setup[t].players ?? defaultRoster(t);
      for (const p of roster) {
        this.players.set(p.id, emptyPlayer(p.id, t, p.name ?? `${names[t]} ${p.number ?? p.id}`));
        this.lines[t].push(p.id);
      }
      this.lines[t] = this.lines[t].slice(0, 7);
    }

    const d0: Dir = opts.startingDirTeam0 ?? 1;
    this.attackDir = [d0, flipDir(d0)];
    this.openingPullTeam = opts.startingPullTeam ?? 1;
    this.pullingTeam = this.openingPullTeam;
    this.receivingTeam = otherTeam(this.pullingTeam);
    this.pointReceivingTeam = this.receivingTeam;
    this.target = this.rules.gameTo;
  }

  /* ------------------------------------------------------------- lifecycle */

  /** Reset clocks and open the first point. Safe to call once. */
  startGame(): void {
    this.clock = 0;
    this.point = 1;
    this.half = 1;
    this.beginPoint();
    this.log(`Game on. ${this.teams[this.pullingTeam].name} pulls to ${this.teams[this.receivingTeam].name}. `
      + `${this.teams[0].name} attacks ${this.attackDir[0] > 0 ? '+Z' : '-Z'}.`);
  }

  /** Declare the seven on the field for a team (affects pointsPlayed only). */
  setLine(team: TeamId, ids: PlayerId[]): void {
    this.lines[team] = ids.filter((id) => this.players.get(id)?.team === team).slice(0, 7);
  }

  /* ------------------------------------------------------------------ step */

  /**
   * Advance the simulation. Designed for a fixed dt of 1/120 s; any dt works.
   * `obs` is optional live positional data — supply it and the stall count will
   * respect marker range and disc space, and travels will be flagged.
   */
  step(dt: number, obs?: FrameObservation): void {
    if (dt <= 0) return;
    // `observe` is also a public entry point on its own, so the step it belongs
    // to is handed over rather than assumed.
    this.observeDt = dt;
    if (obs) this.observe(obs);
    if (this.phase === 'GAME_OVER') return;

    this.clock += dt;
    this.phaseTimer += dt;
    this.tickCaps();

    switch (this.phase) {
      case 'LIVE_POSSESSION': {
        if (this.possession !== null) this.teams[this.possession].timeOfPossession += dt;
        if (this.thrower !== null) this.p(this.thrower).timeOfPossession += dt;
        this.tickStall(dt);
        break;
      }
      case 'DISC_IN_FLIGHT': {
        if (this.possession !== null) this.teams[this.possession].timeOfPossession += dt;
        break;
      }
      case 'POINT_SCORED': {
        if (this.phaseTimer >= this.rules.postScoreDelay) this.advanceAfterScore();
        break;
      }
      case 'TIMEOUT': {
        if (this.phaseTimer >= this.rules.timeoutDuration) this.endTimeout();
        break;
      }
      case 'HALFTIME': {
        if (this.phaseTimer >= this.rules.halftimeDuration) this.resumeFromHalftime();
        break;
      }
      default: break;
    }
  }

  /** Feed live positions without advancing the clock. */
  observe(obs: FrameObservation): void {
    if (obs.discPos) this.discPos = copy(obs.discPos);

    if (obs.markerId !== undefined) this.marker = obs.markerId;
    const ref = obs.throwerPos ?? this.pivot;
    if (obs.markerId === null) {
      this.markerState = 'none';
    } else if (obs.markerPos !== undefined) {
      this.markerState = markerStatus(obs.markerPos, ref, this.rules);
      if (this.markerState === 'disc-space') {
        this.emit('violation', { type: 'disc-space', markerId: this.marker, dist: obs.markerPos ? distXZ(obs.markerPos, ref) : 0 });
      }
      /**
       * USAU 16.G. A double team is a MARKING VIOLATION, so it is handled the
       * way disc space is handled two lines up: the count does not run while it
       * stands. It is checked only when the mark is otherwise legal, because a
       * marker who is already out of range or inside disc space has stopped the
       * count for a reason that is nearer the disc and easier to read.
       */
      if (this.markerState === 'legal' && obs.defenders && obs.offence) {
        const off = doubleTeamOffender(
          this.pivot, this.marker, obs.defenders, obs.offence, this.thrower, this.rules);
        /**
         * IT HAS TO PERSIST BEFORE IT COUNTS, because in the rules it is a call
         * the THROWER makes — he has to see it and say it — and a body that
         * clips the bubble for a tenth of a second is not something anyone
         * calls.
         *
         * Enforcing it frame-by-frame instead was tried and measured: it fired
         * on 3-6% of held frames and stopped the count often enough that a
         * count never reached ten, one sweep seed finished a seven-minute match
         * 0-0, and every downstream shape metric moved. Most of those frames
         * were transients — a marker swap mid-pivot, or the rules layer naming
         * the nearest defender as the marker while the AI still had the
         * matchup-derived one, so the two disagreed about which body was
         * entitled to be there and each flagged the other.
         *
         * The hold time is what a call costs. Sustained double teams still stop
         * the count; brushes past the bubble no longer do.
         */
        if (off !== null) {
          this.doubleTeamHeld += this.observeDt;
          if (this.doubleTeamHeld >= DOUBLE_TEAM_CALL) {
            this.markerState = 'double-team';
            if (!this.doubleTeamCalled) {
              this.doubleTeamCalled = true;
              this.emit('violation', { type: 'double-team', markerId: this.marker, playerId: off });
            }
          }
        } else { this.doubleTeamHeld = 0; this.doubleTeamCalled = false; }
      } else { this.doubleTeamHeld = 0; this.doubleTeamCalled = false; }
    }

    if (obs.pivotFoot && this.phase === 'LIVE_POSSESSION' && this.thrower !== null) {
      const travelling = isTravel(this.pivot, obs.pivotFoot, this.rules);
      if (travelling && !this.travelFlagged) {
        this.travelFlagged = true;
        this.p(this.thrower).travels++;
        this.emit('violation', { type: 'travel', playerId: this.thrower, pivot: copy(this.pivot), foot: copy(obs.pivotFoot) });
        this.log(`${this.name(this.thrower)} travels (pivot slipped ${distXZ(this.pivot, obs.pivotFoot).toFixed(2)} m).`);
      } else if (!travelling) {
        this.travelFlagged = false;
      }
    }
  }

  private tickStall(dt: number): void {
    if (!this.stallRunning) return;
    if (this.markerState !== 'legal') return; // no legal mark => the count does not run

    this.stallElapsed += dt;
    const want = stallCountFor(this.stallElapsed, this.rules);
    while (this.stallCount < want) {
      this.stallCount++;
      this.emit('stall:tick', {
        count: this.stallCount,
        max: this.rules.stallMax,
        playerId: this.thrower,
        team: this.possession,
        markerId: this.marker,
      });
      if (this.stallCount >= this.rules.stallMax) {
        this.stallOut();
        return;
      }
    }
  }

  /* ------------------------------------------------------------------ pull */

  /** The pulling team releases the pull. Legal only from PRE_PULL. */
  pull(pullerId: PlayerId, from: Vec3, vel?: Vec3): ActionResult {
    if (this.phase !== 'PRE_PULL') return this.reject(`pull() in ${this.phase}`);
    const p = this.players.get(pullerId);
    if (!p) return this.reject(`pull() by unknown player ${pullerId}`);
    if (p.team !== this.pullingTeam) return this.reject(`pull() by ${this.name(pullerId)} who is not on the pulling team`);

    p.pulls++;
    this.teams[this.pullingTeam].pulls++;
    this.discPos = copy(from);
    this.setPhase('PULL_IN_FLIGHT');
    this.emit('pull', { team: this.pullingTeam, playerId: pullerId, from: copy(from), vel: vel ? copy(vel) : undefined });
    if (this.rules.emitPhysicsEvents) {
      this.emit('disc:released', {
        pos: copy(from), vel: vel ? copy(vel) : v3(), spin: 0, throwType: 'pull',
        playerId: pullerId, team: this.pullingTeam,
      });
    }
    this.log(`${this.name(pullerId)} pulls from z=${from.z.toFixed(1)}.`);
    return { ok: true };
  }

  /** Receiving team catches the pull cleanly — play is live immediately. */
  pullCaught(playerId: PlayerId, at: Vec3): ActionResult {
    if (this.phase !== 'PULL_IN_FLIGHT') return this.reject(`pullCaught() in ${this.phase}`);
    const p = this.players.get(playerId);
    if (!p) return this.reject(`pullCaught() unknown player ${playerId}`);
    if (this.rules.emitPhysicsEvents) this.emit('disc:caught', { playerId, pos: copy(at), team: p.team, outcome: 'pull' });
    if (p.team === this.pullingTeam) {
      // The pulling team may not catch its own pull; treat as a dead disc for the receivers.
      this.log(`${this.name(playerId)} touched their own pull — disc to ${this.teams[this.receivingTeam].name}.`);
      this.deadDisc(this.receivingTeam, at, 'pull-landed');
      return { ok: true };
    }
    this.gainPossession(p.team, playerId, at, { live: true, walk: false });
    this.log(`${this.name(playerId)} catches the pull at z=${at.z.toFixed(1)}.`);
    return { ok: true };
  }

  /** Receiving team touched the pull and failed to catch it — turnover (WFDF 12.5). */
  pullDropped(playerId: PlayerId, at: Vec3): ActionResult {
    if (this.phase !== 'PULL_IN_FLIGHT') return this.reject(`pullDropped() in ${this.phase}`);
    const p = this.players.get(playerId);
    if (!p) return this.reject(`pullDropped() unknown player ${playerId}`);
    p.drops++;
    p.plusMinus = computePlusMinus(p);
    this.teams[p.team].drops++;
    if (this.rules.emitPhysicsEvents) this.emit('disc:grounded', { pos: copy(at), reason: 'pull-drop' });
    this.registerTurnover('pull-drop', p.team, otherTeam(p.team), playerId, at);
    this.deadDisc(otherTeam(p.team), at, 'pull-dropped');
    this.log(`${this.name(playerId)} drops the pull! Turnover.`);
    return { ok: true };
  }

  /** The pull lands in bounds untouched and comes to rest. */
  pullLanded(at: Vec3): ActionResult {
    if (this.phase !== 'PULL_IN_FLIGHT') return this.reject(`pullLanded() in ${this.phase}`);
    if (this.rules.emitPhysicsEvents) this.emit('disc:grounded', { pos: copy(at), reason: 'pull' });
    this.deadDisc(this.receivingTeam, at, 'pull-landed');
    this.log(`Pull lands at z=${at.z.toFixed(1)}; ${this.teams[this.receivingTeam].name} to pick it up.`);
    return { ok: true };
  }

  /**
   * The pull first contacts the ground out of bounds. The receiving team may
   * take it at the brick mark or at the point on the perimeter where it
   * crossed (WFDF 12.4). Pass the choice, or call choosePullSpot() later.
   */
  pullOutOfBounds(crossing: Vec3, choice?: 'brick' | 'sideline'): ActionResult {
    if (this.phase !== 'PULL_IN_FLIGHT') return this.reject(`pullOutOfBounds() in ${this.phase}`);
    if (this.rules.emitPhysicsEvents) this.emit('disc:grounded', { pos: copy(crossing), reason: 'pull-oob' });
    this.pullOobCrossing = clampToField(crossing);
    this.setPhase('TURNOVER_DEAD');
    this.deadReason = 'pull-out-of-bounds';
    this.possession = null;
    this.log(`Pull sails out of bounds — ${this.teams[this.receivingTeam].name} choose brick or sideline.`);
    if (choice) this.choosePullSpot(choice);
    return { ok: true };
  }

  /** True while an out-of-bounds pull is waiting on brick-or-sideline. */
  awaitingPullChoice(): boolean { return this.pullOobCrossing !== null; }

  /** Resolve an out-of-bounds pull. Defaults to the brick mark. */
  choosePullSpot(choice: 'brick' | 'sideline' = 'brick'): ActionResult {
    if (this.pullOobCrossing === null) return this.reject('choosePullSpot() with no OB pull pending');
    const dir = this.attackDir[this.receivingTeam];
    const spot = choice === 'brick' ? brickMark(dir) : (this.pullOobCrossing ?? brickMark(dir));
    this.pullOobCrossing = null;
    this.deadDisc(this.receivingTeam, spot, 'pull-out-of-bounds');
    this.log(`${this.teams[this.receivingTeam].name} take it at the ${choice} (x=${spot.x.toFixed(1)}, z=${spot.z.toFixed(1)}).`);
    return { ok: true };
  }

  /* -------------------------------------------------------------- live play */

  /** Pick a dead disc up and establish a pivot. Goes to CHECK when required. */
  pickUp(playerId: PlayerId, at?: Vec3): ActionResult {
    if (this.phase !== 'TURNOVER_DEAD') return this.reject(`pickUp() in ${this.phase}`);
    const p = this.players.get(playerId);
    if (!p) return this.reject(`pickUp() unknown player ${playerId}`);
    if (this.possession !== null && p.team !== this.possession) {
      return this.reject(`pickUp() by ${this.name(playerId)} — disc belongs to ${this.teams[this.possession].name}`);
    }
    const team = p.team;
    if (this.awaitingPullChoice()) return this.reject('pickUp() before the OB pull spot has been chosen');
    const spot = at ?? this.discPos;
    // A turnover restarts with a check; a pull is live as soon as it is picked up.
    const needsCheck = this.deadReason === 'turnover';
    this.gainPossession(team, playerId, spot, { live: !needsCheck, walk: true });
    if (needsCheck) {
      this.pendingStallResume = 0;
      this.setPhase('CHECK');
      this.resumeAfterStoppage = 'LIVE_POSSESSION';
      this.log(`${this.name(playerId)} picks up at (x=${this.pivot.x.toFixed(1)}, z=${this.pivot.z.toFixed(1)}) — check.`);
    } else {
      this.log(`${this.name(playerId)} picks up at (x=${this.pivot.x.toFixed(1)}, z=${this.pivot.z.toFixed(1)}) — live.`);
    }
    return { ok: true };
  }

  /** Defence taps the disc in; play restarts. */
  check(): ActionResult {
    if (this.phase !== 'CHECK') return this.reject(`check() in ${this.phase}`);
    this.stallCount = this.pendingStallResume;
    this.stallElapsed = stallElapsedFor(this.stallCount, this.rules);
    this.stallRunning = true;
    this.pendingCall = null;
    this.deadReason = null;
    this.setPhase('LIVE_POSSESSION');
    this.log(`Disc is in. Stall resumes at ${this.stallCount}.`);
    return { ok: true };
  }

  /** Move the established pivot (e.g. after a walk-up or an uncontested travel). */
  setPivot(at: Vec3): void {
    this.pivot = clampToField(at);
    this.travelFlagged = false;
  }

  /** A throw leaves the hand. */
  release(opts: {
    playerId?: PlayerId; pos?: Vec3; vel?: Vec3; spin?: number; throwType?: string;
  } = {}): ActionResult {
    if (this.phase !== 'LIVE_POSSESSION') return this.reject(`release() in ${this.phase}`);
    const id = opts.playerId ?? this.thrower;
    if (id === null || id === undefined) return this.reject('release() with no thrower');
    const p = this.players.get(id);
    if (!p) return this.reject(`release() unknown player ${id}`);

    this.throwerOfPass = id;
    this.throwOrigin = copy(opts.pos ?? this.pivot);
    p.attempts++;
    this.teams[p.team].attempts++;
    this.stallRunning = false;
    this.travelFlagged = false;
    this.setPhase('DISC_IN_FLIGHT');
    if (this.rules.emitPhysicsEvents) {
      this.emit('disc:released', {
        pos: copy(this.throwOrigin), vel: opts.vel ? copy(opts.vel) : v3(),
        spin: opts.spin ?? 0, throwType: opts.throwType ?? 'throw',
        playerId: id, team: p.team, stall: this.stallCount,
      });
    }
    return { ok: true };
  }

  /**
   * A player catches the disc. Routes to completion / goal / interception /
   * caught-out-of-bounds, and to pullCaught() during a pull.
   */
  catchDisc(playerId: PlayerId, at: Vec3): ActionResult {
    if (this.phase === 'PULL_IN_FLIGHT') return this.pullCaught(playerId, at);
    if (this.phase !== 'DISC_IN_FLIGHT') return this.reject(`catchDisc() in ${this.phase}`);
    const p = this.players.get(playerId);
    if (!p) return this.reject(`catchDisc() unknown player ${playerId}`);

    const thrower = this.throwerOfPass;
    const offense = this.possession;

    if (p.team !== offense) {
      // Interception — a catch block.
      if (this.rules.emitPhysicsEvents) this.emit('disc:caught', { playerId, pos: copy(at), team: p.team, outcome: 'interception' });
      p.blocks++;
      this.teams[p.team].blocks++;
      if (thrower !== null) {
        const tp = this.p(thrower);
        tp.throwaways++; tp.blockedThrows++;
        tp.plusMinus = computePlusMinus(tp);
        this.teams[tp.team].throwaways++;
      }
      p.plusMinus = computePlusMinus(p);
      this.registerTurnover('interception', offense ?? otherTeam(p.team), p.team, playerId, at);
      if (!isInBounds(at)) {
        // Intercepted out of bounds: dead, back to the throwing team's opponents at the line.
        const spot = clampToField(at);
        this.deadDisc(p.team, spot, 'turnover');
      } else {
        this.gainPossession(p.team, playerId, at, { live: true, walk: true });
      }
      this.log(`${this.name(playerId)} intercepts! ${this.teams[p.team].name} possession.`);
      return { ok: true };
    }

    // Own team.
    if (!isInBounds(at)) return this.caughtOutOfBounds(playerId, at);

    const dir = this.attackDir[p.team];
    const goal = isGoal(at, dir);
    if (this.rules.emitPhysicsEvents) {
      this.emit('disc:caught', { playerId, pos: copy(at), team: p.team, outcome: goal ? 'goal' : 'completion' });
    }
    this.creditCompletion(thrower, playerId, at);

    if (goal) { this.scoreGoal(playerId, thrower, at); return { ok: true }; }

    this.gainPossession(p.team, playerId, at, { live: true, walk: false, keepChain: true });
    this.log(`${thrower !== null ? this.name(thrower) : '?'} → ${this.name(playerId)} `
      + `(${this.downfield(this.throwOrigin, at, dir).toFixed(1)} m) at z=${at.z.toFixed(1)}.`);
    return { ok: true };
  }

  /** A receiver gets two hands on it and puts it down. Turnover. */
  drop(playerId: PlayerId, at: Vec3): ActionResult {
    if (this.phase === 'PULL_IN_FLIGHT') return this.pullDropped(playerId, at);
    if (this.phase !== 'DISC_IN_FLIGHT') return this.reject(`drop() in ${this.phase}`);
    const p = this.players.get(playerId);
    if (!p) return this.reject(`drop() unknown player ${playerId}`);

    p.drops++;
    p.plusMinus = computePlusMinus(p);
    this.teams[p.team].drops++;
    if (this.throwerOfPass !== null) this.p(this.throwerOfPass).throwsDropped++;
    if (this.rules.emitPhysicsEvents) this.emit('disc:grounded', { pos: copy(at), reason: 'drop' });

    const to = otherTeam(p.team);
    this.registerTurnover('drop', p.team, to, playerId, at);
    this.deadDisc(to, at, 'turnover');
    this.log(`${this.name(playerId)} drops it. Turnover to ${this.teams[to].name}.`);
    return { ok: true };
  }

  /** The throw hits the ground untouched — a throwaway. */
  ground(at: Vec3): ActionResult {
    return this.throwaway(at, isInBounds(at) ? 'throwaway' : 'out-of-bounds');
  }

  private throwaway(at: Vec3, reason: TurnoverReason): ActionResult {
    if (this.phase !== 'DISC_IN_FLIGHT') return this.reject(`ground() in ${this.phase}`);
    const thrower = this.throwerOfPass;
    const from = this.possession;
    if (from === null) return this.reject('ground() with no possession');

    if (thrower !== null) {
      const tp = this.p(thrower);
      tp.throwaways++;
      tp.plusMinus = computePlusMinus(tp);
      this.teams[tp.team].throwaways++;
    }
    if (this.rules.emitPhysicsEvents) this.emit('disc:grounded', { pos: copy(at), reason });

    const to = otherTeam(from);
    const oob = reason === 'out-of-bounds';
    this.registerTurnover(reason, from, to, thrower ?? -1, at);
    this.deadDisc(to, clampToField(at), 'turnover');
    this.log(`Throwaway by ${thrower !== null ? this.name(thrower) : '?'}${oob ? ' (out of bounds)' : ''}. `
      + `${this.teams[to].name} at (x=${this.discPos.x.toFixed(1)}, z=${this.discPos.z.toFixed(1)}).`);
    return { ok: true };
  }

  /**
   * The disc leaves the field. `crossing` is where it crossed the line; if you
   * only have the last in-bounds point and the first out point, use
   * `outOfBoundsSegment()` instead.
   */
  outOfBounds(crossing: Vec3): ActionResult {
    if (this.phase === 'PULL_IN_FLIGHT') return this.pullOutOfBounds(crossing);
    return this.throwaway(clampToField(crossing), 'out-of-bounds');
  }

  /** Convenience: derive the crossing point from the last in/first out samples. */
  outOfBoundsSegment(lastIn: Vec3, firstOut: Vec3): ActionResult {
    const c = boundaryCrossing(lastIn, firstOut);
    return this.outOfBounds(c ? c.point : clampToField(firstOut));
  }

  /** A team-mate catches it but lands out of bounds. Turnover at the line. */
  caughtOutOfBounds(playerId: PlayerId, at: Vec3): ActionResult {
    if (this.phase !== 'DISC_IN_FLIGHT') return this.reject(`caughtOutOfBounds() in ${this.phase}`);
    const p = this.players.get(playerId);
    if (!p) return this.reject(`caughtOutOfBounds() unknown player ${playerId}`);
    const thrower = this.throwerOfPass;
    if (thrower !== null) {
      const tp = this.p(thrower);
      tp.throwaways++;
      tp.plusMinus = computePlusMinus(tp);
      this.teams[tp.team].throwaways++;
    }
    if (this.rules.emitPhysicsEvents) this.emit('disc:grounded', { pos: copy(at), reason: 'caught-oob' });
    const to = otherTeam(p.team);
    const spot = boundaryCrossing(this.throwOrigin, at)?.point ?? clampToField(at);
    this.registerTurnover('caught-out-of-bounds', p.team, to, playerId, at);
    this.deadDisc(to, spot, 'turnover');
    this.log(`${this.name(playerId)} catches it out of bounds. Turnover to ${this.teams[to].name}.`);
    return { ok: true };
  }

  /** A defender knocks the disc down (not a catch). Turnover where it lands. */
  block(defenderId: PlayerId, at: Vec3): ActionResult {
    if (this.phase !== 'DISC_IN_FLIGHT') return this.reject(`block() in ${this.phase}`);
    const d = this.players.get(defenderId);
    if (!d) return this.reject(`block() unknown player ${defenderId}`);
    const from = this.possession;
    if (from === null || d.team === from) return this.reject('block() by the offense');

    d.blocks++;
    this.teams[d.team].blocks++;
    d.plusMinus = computePlusMinus(d);
    const thrower = this.throwerOfPass;
    if (thrower !== null) {
      const tp = this.p(thrower);
      tp.throwaways++; tp.blockedThrows++;
      tp.plusMinus = computePlusMinus(tp);
      this.teams[tp.team].throwaways++;
    }
    if (this.rules.emitPhysicsEvents) this.emit('disc:grounded', { pos: copy(at), reason: 'block' });
    this.registerTurnover('block', from, d.team, defenderId, at);
    this.deadDisc(d.team, clampToField(at), 'turnover');
    this.log(`D! ${this.name(defenderId)} blocks it. ${this.teams[d.team].name} possession.`);
    return { ok: true };
  }

  /* -------------------------------------------------------------- stall-out */

  private stallOut(): void {
    const thrower = this.thrower;
    const from = this.possession;
    if (from === null) return;
    if (thrower !== null) {
      const tp = this.p(thrower);
      tp.stallOuts++;
      tp.plusMinus = computePlusMinus(tp);
      this.teams[tp.team].stallOuts++;
    }
    const to = otherTeam(from);
    const spot = copy(this.pivot);
    this.registerTurnover('stall-out', from, to, thrower ?? -1, spot);
    if (this.rules.emitPhysicsEvents) this.emit('disc:grounded', { pos: copy(spot), reason: 'stall-out' });
    this.stallRunning = false;
    this.deadDisc(to, spot, 'turnover');
    this.log(`STALL TEN — ${thrower !== null ? this.name(thrower) : '?'} is stalled out. Turnover.`);
  }

  /* ---------------------------------------------------------------- scoring */

  private scoreGoal(scorerId: PlayerId, assistId: PlayerId | null, at: Vec3): void {
    const p = this.p(scorerId);
    const team = p.team;
    p.goals++;
    this.teams[team].goals++;
    p.plusMinus = computePlusMinus(p);

    if (assistId !== null && assistId !== scorerId) {
      const a = this.p(assistId);
      a.assists++;
      this.teams[team].assists++;
      a.plusMinus = computePlusMinus(a);
    }
    // Hockey assist: the thrower two passes back.
    const n = this.chain.length;
    if (n >= 2) {
      const hockey = this.chain[n - 2];
      if (hockey !== assistId && hockey !== scorerId) this.p(hockey).hockeyAssists++;
    }

    this.score[team]++;
    this.teams[team].score = this.score[team];
    if (team === this.pointReceivingTeam) this.teams[team].holds++;
    else this.teams[team].breaks++;

    this.lastScoringTeam = team;
    this.possession = team;
    this.thrower = null;
    this.stallRunning = false;
    this.discPos = copy(at);
    // `target` is fixed at construction and only moves when a cap is applied.

    this.lastScore = { team, playerId: scorerId, assistId, score: [this.score[0], this.score[1]], point: this.point };
    this.emit('score', {
      team, playerId: scorerId, assistId,
      score: [this.score[0], this.score[1]],
      scoreline: `${this.teams[0].name} ${this.score[0]} - ${this.score[1]} ${this.teams[1].name}`,
      point: this.point,
    });
    this.setPhase('POINT_SCORED');
    this.log(`GOAL — ${this.name(scorerId)}${assistId !== null ? ` from ${this.name(assistId)}` : ''}. `
      + `${this.teams[0].name} ${this.score[0]} - ${this.score[1]} ${this.teams[1].name}.`);
  }

  /**
   * Leave POINT_SCORED: swap direction of attack, hand the pull to the scoring
   * team, then go to PRE_PULL / HALFTIME / GAME_OVER. Called automatically
   * `rules.postScoreDelay` seconds after the goal.
   */
  advanceAfterScore(): void {
    if (this.phase !== 'POINT_SCORED') return;
    const scorer = this.lastScoringTeam;
    if (scorer === null) return;

    // Teams swap the direction they attack; the scoring team pulls.
    this.attackDir = [flipDir(this.attackDir[0]), flipDir(this.attackDir[1])];
    this.pullingTeam = scorer;
    this.receivingTeam = otherTeam(scorer);
    this.point++;

    if (isGameOver(this.score, this.target, this.rules, this.cap) || (this.hardCapPointIsLast && this.score[0] !== this.score[1])) {
      const winner: TeamId = this.score[0] > this.score[1] ? 0 : 1;
      this.setPhase('GAME_OVER');
      this.emit('game:over', { score: [this.score[0], this.score[1]], winner, teamName: this.teams[winner].name });
      this.log(`GAME OVER — ${this.teams[winner].name} win ${Math.max(...this.score)}-${Math.min(...this.score)}.`);
      return;
    }

    if (this.half === 1 && Math.max(this.score[0], this.score[1]) >= this.rules.halftimeAt) {
      this.setPhase('HALFTIME');
      this.possession = null;
      this.thrower = null;
      this.emit('half', { half: 1, score: [this.score[0], this.score[1]] });
      this.log(`HALFTIME — ${this.teams[0].name} ${this.score[0]} - ${this.score[1]} ${this.teams[1].name}.`);
      return;
    }

    this.beginPoint();
  }

  /** Second half: ends swap again and the opening roles reverse (WFDF 10.3). */
  resumeFromHalftime(): void {
    if (this.phase !== 'HALFTIME') return;
    this.half = 2;
    for (const t of [0, 1] as TeamId[]) this.teams[t].timeoutsRemaining = this.rules.timeoutsPerHalf;
    if (this.rules.swapEndsAtHalftime) {
      this.attackDir = [flipDir(this.attackDir[0]), flipDir(this.attackDir[1])];
    }
    this.pullingTeam = this.openingPullTeam;
    this.receivingTeam = otherTeam(this.pullingTeam);
    this.beginPoint();
    this.log(`Second half. ${this.teams[this.pullingTeam].name} pulls.`);
  }

  private beginPoint(): void {
    this.possession = null;
    this.thrower = null;
    this.marker = null;
    this.markerState = 'legal';
    this.stallCount = 0;
    this.stallElapsed = 0;
    this.stallRunning = false;
    this.deadReason = null;
    this.pullOobCrossing = null;
    this.pendingCall = null;
    this.chain = [];
    this.throwerOfPass = null;
    this.pointReceivingTeam = this.receivingTeam;
    for (const t of [0, 1] as TeamId[]) {
      this.teams[t].pointsPlayed++;
      for (const id of this.lines[t]) this.p(id).pointsPlayed++;
    }
    // Teams line up on their own goal lines.
    this.pivot = { x: 0, y: 0, z: goalLineZ(flipDir(this.attackDir[this.receivingTeam])) };
    this.discPos = { x: 0, y: 0, z: goalLineZ(flipDir(this.attackDir[this.pullingTeam])) };
    this.setPhase('PRE_PULL');
  }

  /* --------------------------------------------------------------- timeouts */

  /** Returns ok:false when the team has none left or may not call one now. */
  callTimeout(team: TeamId, playerId?: PlayerId): ActionResult {
    const ts = this.teams[team];
    if (ts.timeoutsRemaining <= 0) return this.reject(`${ts.name} have no timeouts left`);
    const live = this.phase === 'LIVE_POSSESSION' || this.phase === 'DISC_IN_FLIGHT';
    if (this.phase === 'DISC_IN_FLIGHT') return this.reject('timeout while the disc is in the air');
    if (live && this.possession !== team && !this.rules.defenseMayCallTimeout) {
      return this.reject('only the team in possession may call a timeout during a point');
    }
    if (this.phase === 'TIMEOUT' || this.phase === 'HALFTIME' || this.phase === 'GAME_OVER') {
      return this.reject(`timeout in ${this.phase}`);
    }

    ts.timeoutsRemaining--;
    ts.timeoutsUsed++;
    this.timeoutTeam = team;
    this.resumeAfterStoppage = this.phase === 'LIVE_POSSESSION' ? 'LIVE_POSSESSION' : this.phase;
    this.pendingStallResume = this.phase === 'LIVE_POSSESSION'
      ? resumeStallCount(this.stallCount, this.rules)
      : 0;
    this.stallRunning = false;
    this.setPhase('TIMEOUT');
    this.emit('timeout', { team, playerId: playerId ?? null, remaining: ts.timeoutsRemaining });
    this.log(`Timeout ${ts.name} (${ts.timeoutsRemaining} left).`);
    return { ok: true };
  }

  /** End the timeout early; otherwise step() ends it after timeoutDuration. */
  endTimeout(): void {
    if (this.phase !== 'TIMEOUT') return;
    this.timeoutTeam = null;
    if (this.resumeAfterStoppage === 'LIVE_POSSESSION' && this.possession !== null) {
      this.setPhase('CHECK');
      this.log(`Back on. Stall will resume at ${this.pendingStallResume}.`);
    } else {
      this.setPhase(this.resumeAfterStoppage);
      this.log('Back on.');
    }
  }

  /* ------------------------------------------------------- calls and fouls */

  /**
   * Self-officiated call. Play stops; resolve it with resolveCall(). Fouls,
   * travels and picks are all routed through here.
   */
  makeCall(type: CallType, callerId: PlayerId, againstId: PlayerId, at?: Vec3): ActionResult {
    if (this.phase === 'GAME_OVER' || this.phase === 'HALFTIME' || this.phase === 'TIMEOUT') {
      return this.reject(`makeCall() in ${this.phase}`);
    }
    const caller = this.players.get(callerId);
    const against = this.players.get(againstId);
    if (!caller || !against) return this.reject('makeCall() with an unknown player');

    this.pendingCall = {
      type, callerId, callerTeam: caller.team, againstId, againstTeam: against.team,
      at: copy(at ?? this.discPos), phaseAtCall: this.phase, stallAtCall: this.stallCount,
    };
    this.stallRunning = false;
    this.resumeAfterStoppage = 'LIVE_POSSESSION';
    this.setPhase('CHECK');
    this.emit('call', { type, callerId, againstId, at: copy(this.pendingCall.at), phaseAtCall: this.pendingCall.phaseAtCall });
    this.log(`${this.name(callerId)} calls ${type} on ${this.name(againstId)}.`);
    return { ok: true };
  }

  /**
   * Resolve the outstanding call.
   *  - contested        => disc back to the thrower, check, stall resumes at
   *                        reached+1 (capped). This is the brief's mandated rule.
   *  - uncontested foul on the marker  => stall count resets to 0.
   *  - uncontested foul on a receiver  => that receiver gains possession at the
   *                                       spot of the foul (if the pass fell).
   *  - uncontested travel              => thrower returns to the pivot, count
   *                                       backs up one; a completed pass stands.
   *  - uncontested pick                => play restarts where it stopped.
   *  - uncontested strip               => the stripped player regains possession.
   */
  resolveCall(contested: boolean, opts?: { receiverId?: PlayerId }): ActionResult {
    const c = this.pendingCall;
    if (!c) return this.reject('resolveCall() with no call pending');

    let outcome = 'back-to-thrower';
    if (contested) {
      this.restoreToThrower(c);
      this.pendingStallResume = resumeStallCount(c.stallAtCall, this.rules);
    } else {
      const offense = this.possession;
      const onOffense = c.againstTeam === offense;
      switch (c.type) {
        case 'travel': {
          this.p(c.againstId).travels++;
          if (c.phaseAtCall === 'LIVE_POSSESSION') {
            this.setPivot(this.pivot);
            this.pendingStallResume = Math.max(0, c.stallAtCall - 1);
            outcome = 'travel-pivot-reset';
          } else {
            // Called after the release: the result of the pass stands.
            this.pendingStallResume = 0;
            outcome = 'play-on';
          }
          break;
        }
        case 'pick': {
          this.p(c.callerId).picks++;
          this.restoreToThrower(c);
          this.pendingStallResume = resumeStallCount(c.stallAtCall, this.rules);
          outcome = 'pick-reset';
          break;
        }
        case 'foul': {
          this.p(c.againstId).foulsCommitted++;
          if (onOffense) {
            // Offensive foul on an incomplete pass: disc back to the thrower.
            this.restoreToThrower(c);
            this.pendingStallResume = resumeStallCount(c.stallAtCall, this.rules);
            outcome = 'offensive-foul';
          } else if (c.phaseAtCall === 'DISC_IN_FLIGHT' && (opts?.receiverId ?? c.callerId) !== null) {
            const rid = opts?.receiverId ?? c.callerId;
            const rp = this.players.get(rid);
            if (rp && rp.team === offense) {
              this.voidThrowAttempt(c);
              this.gainPossession(rp.team, rid, c.at, { live: false, walk: true, keepChain: true });
              outcome = 'receiving-foul';
            } else {
              this.restoreToThrower(c);
              outcome = 'defensive-foul';
            }
            this.pendingStallResume = 0;
          } else {
            // Marking foul: the count restarts from zero.
            this.restoreToThrower(c);
            this.pendingStallResume = 0;
            outcome = 'marking-foul';
          }
          break;
        }
        case 'strip': {
          this.p(c.againstId).foulsCommitted++;
          // A strip called on a disc that was still in the air nullifies the pass
          // the same way a receiving foul does. Without this the thrower is left
          // charged with an attempt that has no completion, no throwaway and no
          // drop against it, and the box score's own invariant
          // `attempts === completions + throwaways + throwsDropped` breaks.
          this.voidThrowAttempt(c);
          const rid = opts?.receiverId ?? c.callerId;
          const rp = this.players.get(rid);
          if (rp) {
            this.undoLastTurnoverTo(rp.team);
            this.gainPossession(rp.team, rid, c.at, { live: false, walk: true });
          }
          this.pendingStallResume = resumeStallCount(c.stallAtCall, this.rules);
          outcome = 'strip';
          break;
        }
        default: {
          this.restoreToThrower(c);
          this.pendingStallResume = resumeStallCount(c.stallAtCall, this.rules);
          outcome = 'violation';
          break;
        }
      }
    }

    this.emit('call:resolved', { type: c.type, contested, outcome, stallResume: this.pendingStallResume });
    this.log(`${c.type} ${contested ? 'contested' : 'accepted'} → ${outcome}; stall will resume at ${this.pendingStallResume}.`);
    this.pendingCall = null;
    this.setPhase('CHECK');
    return { ok: true };
  }

  /** Contested-call remedy: the disc goes back to the thrower at the pivot. */
  private restoreToThrower(c: PendingCall): void {
    const offense = this.possession;
    const id = this.throwerOfPass ?? this.thrower;
    if (offense === null || id === null) return;
    const p = this.players.get(id);
    if (!p || p.team !== offense) return;
    this.voidThrowAttempt(c);
    this.thrower = id;
    this.discPos = copy(this.pivot);
  }

  /**
   * Undo the stat effect of a pass that a call nullified. Keeps the invariant
   * attempts === completions + throwaways + throwsDropped intact.
   */
  private voidThrowAttempt(c: PendingCall): void {
    if (c.phaseAtCall !== 'DISC_IN_FLIGHT') return;
    const id = this.throwerOfPass;
    if (id === null) return;
    const p = this.players.get(id);
    if (!p) return;
    p.attempts = Math.max(0, p.attempts - 1);
    this.teams[p.team].attempts = Math.max(0, this.teams[p.team].attempts - 1);
    this.throwerOfPass = null;
  }

  /** Used by an uncontested strip: give the possession back. */
  private undoLastTurnoverTo(team: TeamId): void {
    if (this.possession !== null && this.possession !== team) {
      this.teams[this.possession].turnoversForced = Math.max(0, this.teams[this.possession].turnoversForced - 1);
      this.teams[team].turnoversCommitted = Math.max(0, this.teams[team].turnoversCommitted - 1);
    }
  }

  /* ------------------------------------------------------------------ caps */

  /**
   * THE MATCH CLOCK, driving the caps that were built and never called.
   *
   * Both `softCapAt` and `hardCapAt` default to 0, which means "no clock", so
   * this is a no-op in every game the sim has played to date and every golden is
   * untouched. Give either of them a time and the sport's own timed format
   * appears: at the soft cap the target becomes the leader + 1 and play carries
   * straight on, at the hard cap the point in progress is the last one.
   *
   * Each fires once, and the hard cap subsumes the soft one — arriving at a hard
   * cap that was never softened still applies the soft cap's target first, which
   * is what a horn that both teams missed would leave behind anyway.
   */
  private tickCaps(): void {
    const r = this.rules;
    if (this.phase === 'GAME_OVER' || this.phase === 'HALFTIME') return;
    if (r.softCapAt > 0 && this.cap === 'none' && this.clock >= r.softCapAt) this.applySoftCap();
    if (r.hardCapAt > 0 && this.cap !== 'hard' && this.clock >= r.hardCapAt) this.applyHardCap();
  }

  /** Time cap during a point: target becomes the leader's score + 1. */
  applySoftCap(): void {
    this.cap = 'soft';
    this.target = effectiveTarget(this.score, this.rules, this.cap);
    this.emit('cap', { kind: 'soft', target: this.target });
    this.log(`SOFT CAP — game to ${this.target}.`);
  }

  /** Hard cap: the point in progress is the last one. */
  applyHardCap(): void {
    this.cap = 'hard';
    this.hardCapPointIsLast = true;
    this.target = effectiveTarget(this.score, this.rules, this.cap);
    this.emit('cap', { kind: 'hard', target: this.target });
    this.log(`HARD CAP — this is the last point (game to ${this.target}).`);
  }

  /* ------------------------------------------------------- internal helpers */

  private creditCompletion(throwerId: PlayerId | null, receiverId: PlayerId, at: Vec3): void {
    const rp = this.p(receiverId);
    const dir = this.attackDir[rp.team];
    const down = this.downfield(this.throwOrigin, at, dir);
    const dist = distXZ(this.throwOrigin, at);

    rp.catches++;
    rp.yardsReceived += down;
    rp.receiveDistance += dist;
    this.teams[rp.team].yardsReceived += down;

    if (throwerId !== null) {
      const tp = this.p(throwerId);
      tp.completions++;
      tp.yardsThrown += down;
      tp.throwDistance += dist;
      tp.plusMinus = computePlusMinus(tp);
      this.teams[tp.team].completions++;
      this.teams[tp.team].yardsThrown += down;
    }
  }

  private downfield(from: Vec3, to: Vec3, dir: Dir): number {
    return (to.z - from.z) * dir;
  }

  /**
   * A team takes possession. `live` false leaves the phase alone (the caller
   * will set CHECK). `walk` applies the "carry it to the goal line" rule.
   */
  private gainPossession(
    team: TeamId, playerId: PlayerId, at: Vec3,
    o: { live: boolean; walk: boolean; keepChain?: boolean },
  ): void {
    const changed = this.possession !== team;
    if (changed || !o.keepChain) this.chain = [];
    this.possession = team;
    this.thrower = playerId;
    this.pivot = o.walk ? putIntoPlaySpot(at, this.attackDir[team], this.rules) : clampToField(at);
    this.discPos = copy(this.pivot);
    this.stallCount = 0;
    this.stallElapsed = 0;
    this.stallRunning = o.live;
    this.travelFlagged = false;
    this.throwerOfPass = null;
    this.deadReason = null;
    this.chain.push(playerId);
    this.p(playerId).touches++;
    if (changed) this.teams[team].possessions++;
    if (o.live) this.setPhase('LIVE_POSSESSION');
  }

  /** Disc is on the ground and belongs to `team`; they must pick it up. */
  private deadDisc(team: TeamId, at: Vec3, reason: DeadReason): void {
    this.possession = team;
    this.thrower = null;
    this.stallRunning = false;
    this.stallCount = 0;
    this.stallElapsed = 0;
    this.chain = [];
    this.throwerOfPass = null;
    this.discPos = putIntoPlaySpot(at, this.attackDir[team], this.rules);
    this.pivot = copy(this.discPos);
    this.deadReason = reason;
    this.setPhase('TURNOVER_DEAD');
  }

  private registerTurnover(reason: TurnoverReason, from: TeamId, to: TeamId, playerId: PlayerId, pos: Vec3): void {
    this.teams[from].turnoversCommitted++;
    this.teams[to].turnoversForced++;
    this.emit('turnover', {
      reason, from, to, playerId,
      pos: copy(pos),
      spot: putIntoPlaySpot(pos, this.attackDir[to], this.rules),
      point: this.point,
      score: [this.score[0], this.score[1]],
    });
  }

  private setPhase(next: Phase): void {
    const from = this.phase;
    if (from === next) { this.phaseTimer = 0; return; }
    this.phase = next;
    this.phaseTimer = 0;
    this.emit('state:changed', {
      from, to: next, clock: this.clock, point: this.point,
      possession: this.possession, score: [this.score[0], this.score[1]],
    });
  }

  private emit(evt: string, payload?: any): void { this.emitFn(evt, payload); }

  private reject(note: string): ActionResult {
    this.log(`[illegal] ${note}`);
    return { ok: false, note };
  }

  private p(id: PlayerId): PlayerStats {
    const s = this.players.get(id);
    if (s) return s;
    const made = emptyPlayer(id, 0, `#${id}`);
    this.players.set(id, made);
    return made;
  }

  /* --------------------------------------------------------------- queries */

  name(id: PlayerId): string { return this.players.get(id)?.name ?? `#${id}`; }

  /** The most recent goal, or null before the first one. */
  getLastScore(): GameState['lastScore'] { return this.lastScore; }

  playerStats(id: PlayerId): PlayerStats | undefined { return this.players.get(id); }
  teamStats(t: TeamId): TeamStats { return this.teams[t]; }
  allPlayers(): PlayerStats[] { return [...this.players.values()]; }

  /** Seconds remaining on the current stall count (to stallMax). */
  stallRemaining(): number {
    return Math.max(0, this.rules.stallMax * this.rules.stallInterval - this.stallElapsed);
  }

  /** True when the marker may legally be running the count. */
  markerLegal(): boolean { return this.markerState === 'legal'; }

  /** Brick mark for the team currently receiving. */
  currentBrick(): Vec3 { return brickMark(this.attackDir[this.receivingTeam]); }

  snapshot(): {
    phase: Phase; clock: number; point: number; half: 1 | 2;
    score: [number, number]; possession: TeamId | null; thrower: PlayerId | null;
    stall: number; attackDir: [Dir, Dir]; pullingTeam: TeamId; target: number; cap: CapState;
  } {
    return {
      phase: this.phase, clock: this.clock, point: this.point, half: this.half,
      score: [this.score[0], this.score[1]], possession: this.possession, thrower: this.thrower,
      stall: this.stallCount, attackDir: [this.attackDir[0], this.attackDir[1]],
      pullingTeam: this.pullingTeam, target: this.target, cap: this.cap,
    };
  }

  /* ------------------------------------------------------------------- log */

  private log(text: string): void {
    const entry: PlayLogEntry = { t: this.clock, phase: this.phase, point: this.point, text };
    this.logBuf.push(entry);
    if (this.logBuf.length > this.maxLog) this.logBuf.shift();
    this.onLog?.(entry);
  }

  getLog(): readonly PlayLogEntry[] { return this.logBuf; }
  clearLog(): void { this.logBuf.length = 0; }

  /** Human-readable box score, for the HUD or a test harness. */
  boxScore(): string {
    const rows: string[] = [];
    rows.push(`${this.teams[0].name} ${this.score[0]} - ${this.score[1]} ${this.teams[1].name}`
      + `   (${this.point - 1} points, ${this.clock.toFixed(1)}s, ${this.phase})`);
    for (const t of [0, 1] as TeamId[]) {
      const ts = this.teams[t];
      const pct = ts.attempts ? (100 * ts.completions / ts.attempts).toFixed(1) : '0.0';
      rows.push('');
      rows.push(`${ts.name}: ${ts.score} pts | ${ts.completions}/${ts.attempts} (${pct}%) | `
        + `blk ${ts.blocks} | TO ${ts.turnoversCommitted} | TOP ${ts.timeOfPossession.toFixed(1)}s | `
        + `holds ${ts.holds} breaks ${ts.breaks} | timeouts used ${ts.timeoutsUsed}`);
      rows.push('  ' + 'player'.padEnd(12) + 'G  A  D  Cmp/Att  TA  Dr  yThr   yRec   TOP    +/-');
      for (const p of this.allPlayers()) {
        if (p.team !== t) continue;
        rows.push('  ' + p.name.padEnd(12)
          + String(p.goals).padStart(2) + ' '
          + String(p.assists).padStart(2) + ' '
          + String(p.blocks).padStart(2) + '  '
          + `${p.completions}/${p.attempts}`.padStart(7) + ' '
          + String(p.throwaways).padStart(3) + ' '
          + String(p.drops).padStart(3) + ' '
          + p.yardsThrown.toFixed(1).padStart(6) + ' '
          + p.yardsReceived.toFixed(1).padStart(6) + ' '
          + p.timeOfPossession.toFixed(1).padStart(6) + ' '
          + String(computePlusMinus(p)).padStart(4));
      }
    }
    return rows.join('\n');
  }
}

/* --------------------------------------------------------------- factories */

function defaultRoster(team: TeamId): PlayerSetup[] {
  const base = team * 7;
  const out: PlayerSetup[] = [];
  for (let i = 0; i < 7; i++) out.push({ id: base + i, number: i + 1 });
  return out;
}

/**
 * Build a GameState wired to an engine Ctx. Kept here (rather than in a System)
 * so `src/sim/Game.ts` can own the System wrapper without duplicating setup.
 */
export function createGameState(
  ctx: { events: { emit(evt: string, payload?: any): void } },
  opts: Omit<GameStateOptions, 'emit'> = {},
): GameState {
  return new GameState({ ...opts, emit: ctx.events });
}
