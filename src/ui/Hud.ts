/**
 * HUD — the broadcast graphics package.
 *
 * A DOM/CSS overlay stacked on the canvas inside `#ui`. Five pieces:
 *
 *   `Scorebug`      the bar: codes, colour chips, possession, score, timeouts,
 *                   point, cap target and the stall gauge
 *   `LowerThird`    the player card that fires on a goal or a D
 *   `GameplayLayer` world-anchored gizmos (stamina ring, carrier disc, receiver
 *                   bracket, predicted flight arc) plus the throw meter
 *   `SummaryPanel`  the end-of-point box score
 *   `Badges`        replay and slow-motion state
 *
 * Three decisions are worth defending.
 *
 * **DOM, not in-scene geometry.** A HUD drawn as quads in the 3D scene inherits
 * the tone map, the bloom, the grade and the DOF — every one of which is tuned
 * to make grass and skin look right and all of which are wrong for type. It also
 * rasterises at the render resolution, which the engine drops adaptively. In the
 * DOM the package is vector, sits above the composite untouched by post, and is
 * crisp at any DPR because the browser rasterises it at device resolution.
 *
 * **Animated from `ctx.time`, never from CSS transitions.** The capture rig
 * advances the engine by exact fixed steps and then grabs a frame; a CSS
 * transition runs off the wall clock and would land somewhere different on every
 * run. Every motion here is a pure function of sim time, so `broadcast.png` is
 * byte-identical run to run — which is the only thing that makes an image diff
 * mean "the code changed".
 *
 * **Transform and opacity only in the per-frame path.** Writes go through the
 * caching helpers in `Dom.ts`, so an unchanged value costs a string compare and
 * no style invalidation at all. Measured cost of the whole package is under the
 * frame-time noise floor (see the numbers in the task report).
 *
 * Everything the HUD displays is read live off peers on `ctx.sys` and every one
 * of them is optional: with no game system it renders an empty bug and nothing
 * else, with no players system the cards fall back to the sim's own names.
 */

import * as THREE from 'three';

import type { Ctx, System } from '../core/Ctx.ts';
import { colourwayById } from '../entities/material/Tone.ts';
import { clockText, hexOf, luma, readable, setStyle } from './Dom.ts';
import { Badges } from './Badges.ts';
import { GameplayLayer } from './Gameplay.ts';
import { LowerThird, type CardRequest } from './LowerThird.ts';
import { SummaryPanel, type SummaryData, type SummaryRow } from './Summary.ts';
import { Scorebug } from './Scorebug.ts';
import { mountStyle } from './Theme.ts';
import { emptyFrame, type HudFrame, type HudPlayer, type HudSource, type HudWidget, type Side, type TeamBrand } from './Model.ts';

/* ------------------------------------------------------- peer shapes (all
 * structural and all optional — the HUD never imports a system) ------------ */

interface LocoLike {
  pos: { x: number; y: number; z: number };
  groundY: number;
  stamina: number;
  hipHeight: number;
}

interface RosterLike {
  id: number;
  team: 0 | 1;
  number: number;
  name: string;
  archetype: string;
  loco: LocoLike;
}

interface TeamStatsLike {
  score: number; completions: number; attempts: number; blocks: number;
  turnoversCommitted: number; yardsThrown: number; timeOfPossession: number;
  holds: number; breaks: number; timeoutsRemaining: number;
}

interface PlayerStatsLike {
  goals: number; assists: number; blocks: number;
  completions: number; attempts: number; drops: number; throwaways: number;
  yardsThrown: number; yardsReceived: number;
}

interface GameStateLike {
  phase: string; clock: number; point: number; half: 1 | 2; target: number; cap: string;
  score: [number, number]; possession: 0 | 1 | null; thrower: number | null; stallCount: number;
  rules: { stallMax: number };
  teams: [TeamStatsLike, TeamStatsLike];
  markerLegal?(): boolean;
  playerStats?(id: number): PlayerStatsLike | undefined;
  lastScore?: { team: 0 | 1; playerId: number; assistId: number | null } | null;
}

interface GameLike {
  gs?: GameStateLike;
  roster?: ReadonlyArray<RosterLike>;
  controlledPlayerId?: number;
  discRuntime?: { mode: 'held' | 'flight' | 'ground'; holderId: number; state: { pos: THREE.Vector3 } };
  selectedReceiverId?(id: number): number;
  markerId?(): number;
}

interface PlayersLike {
  get?(id: number): { number: number; name: string } | undefined;
}

interface DiscLike {
  predictPath?(state: unknown, horizon?: number, step?: number): { x: number; y: number; z: number }[];
}

interface ChargeLike {
  active: boolean; power: number; quality: number; hold: number; type: string;
  targetHold: number; targetHalfWidth: number; maxHold: number;
}

interface InputLike { charge?: ChargeLike }

/* --------------------------------------------------------------- constants */

/** Mirrors `input/Throw.ts` DEFAULT_TIMING, used only until a charge reports its
 *  own window. Duplicated rather than imported so the HUD keeps zero build-time
 *  coupling to a peer system. */
const FALLBACK_PERFECT_HOLD = 0.85;
const FALLBACK_PERFECT_HALF = 0.09;
const FALLBACK_MAX_HOLD = 2.0;

/** Predicted flight is re-integrated at this rate, not every frame. */
const PREDICT_HZ = 12;

const POSITION_LABEL: Record<string, string> = {
  handler: 'Handler', cutter: 'Cutter', deep: 'Deep', utility: 'Utility',
};

/* ------------------------------------------------------------------ system */

export class HudSystem implements System, HudSource {
  readonly name = 'hud';
  /** After the camera (10) so world-anchored gizmos project the final view. */
  readonly order = 11;

  private ctx!: Ctx;
  private root: HTMLElement | null = null;
  private widgets: HudWidget[] = [];

  private bug!: Scorebug;
  private card!: LowerThird;
  private play!: GameplayLayer;
  private summary!: SummaryPanel;
  private badges!: Badges;

  private brands: [TeamBrand, TeamBrand] = [defaultBrand(0), defaultBrand(1)];
  private frame: HudFrame = emptyFrame();

  private game: GameLike | undefined;
  private playersSys: PlayersLike | undefined;
  private discSys: DiscLike | undefined;
  private input: InputLike | undefined;

  /** One reusable record per athlete — `player()` never allocates. */
  private records = new Map<number, HudPlayer>();
  private rosterById = new Map<number, RosterLike>();

  private flightCache: { x: number; y: number; z: number }[] | null = null;
  private flightAt = -1e3;

  private pendingCard: { at: number; req: CardRequest } | null = null;
  private pendingSummary: { at: number; data: SummaryData; hold: number } | null = null;
  private restageAt = -1;
  private offs: Array<() => void> = [];

  /* -------------------------------------------------------------- lifecycle */

  init(ctx: Ctx): void {
    this.ctx = ctx;
    if (typeof document === 'undefined') return;

    this.game = ctx.sys['game'] as unknown as GameLike | undefined;
    this.playersSys = ctx.sys['players'] as unknown as PlayersLike | undefined;
    this.discSys = ctx.sys['disc'] as unknown as DiscLike | undefined;
    this.input = ctx.sys['input'] as unknown as InputLike | undefined;

    this.resolveBrands();
    this.indexRoster();

    mountStyle();
    const host = document.getElementById('ui') ?? document.body;
    const root = document.createElement('div');
    root.id = 'ug';
    host.appendChild(root);
    this.root = root;

    this.bug = new Scorebug(root, this.brands);
    this.play = new GameplayLayer(root, ctx, this, this.brands);
    this.card = new LowerThird(root);
    this.summary = new SummaryPanel(root, this.brands);
    this.badges = new Badges(root);
    this.widgets = [this.bug, this.play, this.card, this.summary, this.badges];

    this.bind(ctx);
    this.resize(ctx.width, ctx.height, ctx);
    this.readFrame(0);
    this.restage();
  }

  /** Kit colourways are the same two the character system dresses in. */
  private resolveBrands(): void {
    const ids: ['home', 'away'] = ['home', 'away'];
    for (let t = 0 as Side; t <= 1; t = (t + 1) as Side) {
      const cw = colourwayById(ids[t]);
      this.brands[t] = {
        code: cw.code,
        name: cw.name,
        colour: readable(cw.primary),
        raw: hexOf(cw.primary),
        ink: luma(cw.primary) > 0.55 ? '#14181f' : '#ffffff',
        accent: hexOf(cw.accent),
      };
    }
  }

  private indexRoster(): void {
    const roster = this.game?.roster;
    if (!roster) return;
    for (const e of roster) {
      this.rosterById.set(e.id, e);
      const kit = this.playersSys?.get?.(e.id);
      this.records.set(e.id, {
        id: e.id,
        team: e.team,
        number: kit?.number ?? e.number,
        name: kit?.name ?? e.name,
        position: POSITION_LABEL[e.archetype] ?? 'Player',
        x: 0, y: 0, z: 0, groundY: 0, stamina: 1,
      });
    }
  }

  private bind(ctx: Ctx): void {
    const on = (evt: string, fn: (p: any) => void) => this.offs.push(ctx.events.on(evt, fn));

    on('shot:apply', (p) => {
      // The rig re-stages the world; drop every in-flight animation so the
      // captured frame is a function of the shot alone.
      this.restageAt = this.ctx.time;
      this.pendingCard = null;
      this.pendingSummary = null;
      const tableau = p?.shot?.tableau as string | undefined;
      if (tableau === 'score') this.queueTableauGoal();
    });

    on('score', (p) => this.onScore(p));
    on('turnover', (p) => this.onTurnover(p));
    on('state:changed', (p) => this.onStateChanged(p));
    on('replay:start', (p) => this.badges?.setReplay(true, p?.label ?? 'Replay'));
    on('replay:end', () => this.badges?.setReplay(false));
  }

  resize(w: number, h: number, _ctx: Ctx): void {
    if (!this.root) return;
    // One root size drives every dimension in the package (everything downstream
    // is in `em`), so the bug holds its proportions from 1280 to 2560 without a
    // single media query and stays vector-crisp at any DPR.
    const size = Math.max(13, Math.min(22, w / 108));
    setStyle(this.root, 'font-size', `${size.toFixed(2)}px`);
    for (const wd of this.widgets) wd.resize?.(w, h);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    for (const wd of this.widgets) wd.dispose?.();
    this.root?.remove();
    this.root = null;
  }

  /* ------------------------------------------------------------------ frame */

  lateUpdate(dt: number, ctx: Ctx): void {
    if (!this.root) return;
    this.readFrame(dt);

    if (this.restageAt >= 0) {
      this.restageAt = -1;
      this.restage();
    }

    const f = this.frame;
    if (this.pendingCard && f.t >= this.pendingCard.at) {
      this.card.show(this.pendingCard.req, this.brands, f);
      this.pendingCard = null;
    }
    if (this.pendingSummary && f.t >= this.pendingSummary.at) {
      this.summary.show(this.pendingSummary.data, f, this.pendingSummary.hold);
      this.pendingSummary = null;
    }

    this.badges.setSlowMo(ctx.timeScale);
    for (const w of this.widgets) w.update(f);
  }

  private restage(): void {
    for (const w of this.widgets) w.restage?.(this.frame);
  }

  private readFrame(dt: number): void {
    const ctx = this.ctx;
    const f = this.frame;
    f.t = ctx.time;
    f.dt = dt;
    f.w = ctx.width;
    f.h = ctx.height;

    const g = this.game;
    const gs = g?.gs;
    f.live = !!gs;

    if (gs) {
      f.score[0] = gs.score[0];
      f.score[1] = gs.score[1];
      f.point = gs.point;
      f.half = gs.half;
      f.target = gs.target;
      f.cap = (gs.cap === 'soft' || gs.cap === 'hard') ? gs.cap : 'none';
      f.clock = gs.clock;
      f.phase = gs.phase;
      f.possession = gs.possession;
      f.stall = gs.stallCount;
      f.stallMax = gs.rules?.stallMax ?? 10;
      f.stallFrozen = gs.markerLegal ? !gs.markerLegal() : false;
      f.timeouts[0] = gs.teams?.[0]?.timeoutsRemaining ?? 0;
      f.timeouts[1] = gs.teams?.[1]?.timeoutsRemaining ?? 0;
      f.throwerId = gs.thrower ?? -1;
    }

    f.controlledId = g?.controlledPlayerId ?? -1;
    f.receiverId = g?.selectedReceiverId?.(f.controlledId) ?? -1;
    f.markerId = g?.markerId?.() ?? -1;
    const rt = g?.discRuntime;
    f.discMode = rt?.mode ?? 'ground';
    // Who is physically holding it beats who the rules machine last recorded as
    // the thrower. A screenshot tableau restages the bodies and the disc without
    // clearing `gs.thrower`, and believing the stale value would arm the throw
    // meter for an athlete standing forty metres from the disc.
    if (rt && rt.mode === 'held' && rt.holderId >= 0) f.throwerId = rt.holderId;
    else if (rt && rt.mode !== 'held') f.throwerId = f.discMode === 'flight' ? -1 : f.throwerId;

    const c = this.input?.charge;
    f.charging = !!c?.active;
    f.chargePower = c?.power ?? 0;
    f.chargeQuality = c?.quality ?? 0;
    f.chargeHold = c?.hold ?? 0;
    f.chargeType = c?.type ?? 'backhand';
    f.perfectHold = c && c.maxHold > 0 ? c.targetHold : FALLBACK_PERFECT_HOLD;
    f.perfectHalf = c && c.maxHold > 0 ? c.targetHalfWidth : FALLBACK_PERFECT_HALF;
    f.maxHold = c && c.maxHold > 0 ? c.maxHold : FALLBACK_MAX_HOLD;
  }

  /* ------------------------------------------------------------- HudSource */

  player(id: number): HudPlayer | null {
    const rec = this.records.get(id);
    const src = this.rosterById.get(id);
    if (!rec || !src) return null;
    const lp = src.loco;
    rec.x = lp.pos.x;
    rec.y = lp.pos.y;
    rec.z = lp.pos.z;
    rec.groundY = lp.groundY;
    rec.stamina = Math.max(0, Math.min(1, lp.stamina / 100));
    return rec;
  }

  disc(): { x: number; y: number; z: number } | null {
    const p = this.game?.discRuntime?.state?.pos;
    return p ? p : null;
  }

  flight(): readonly { x: number; y: number; z: number }[] | null {
    const rt = this.game?.discRuntime;
    if (!rt || rt.mode !== 'flight' || !this.discSys?.predictPath) return null;
    const t = this.ctx.time;
    if (this.flightCache && t - this.flightAt < 1 / PREDICT_HZ) return this.flightCache;
    this.flightAt = t;
    // 2.4 s at 24 Hz — enough of the arc to lead a receiver, cheap enough to
    // re-integrate a dozen times a second rather than every frame.
    this.flightCache = this.discSys.predictPath(rt.state, 2.4, 1 / 24);
    return this.flightCache;
  }

  /* ------------------------------------------------------ public HUD control */

  /** Drive the replay badge from a replay system that does not use the bus. */
  setReplay(on: boolean, label?: string): void { this.badges?.setReplay(on, label); }

  /** Force the end-of-point panel up (a menu, a debug key, a test harness). */
  showSummary(hold = 8): void {
    if (!this.root) return;
    this.summary.show(this.buildSummary('End of point'), this.frame, hold);
  }

  /** Push an arbitrary player card. Used by the goal/D paths and by tests. */
  showCard(req: CardRequest): void {
    if (!this.root) return;
    this.card.show(req, this.brands, this.frame);
  }

  /* ----------------------------------------------------------------- events */

  private onScore(p: { team?: Side; playerId?: number; assistId?: number | null }): void {
    const id = p?.playerId;
    if (id === undefined || id < 0) return;
    const req = this.goalCard(id, p.assistId ?? null);
    if (!req) return;
    this.pendingCard = { at: this.frame.t + 0.35, req };
    this.pendingSummary = { at: this.frame.t + 6.4, data: this.buildSummary('End of point'), hold: 7 };
  }

  private onTurnover(p: { reason?: string; playerId?: number }): void {
    const reason = p?.reason;
    if (reason !== 'block' && reason !== 'interception') return;
    const id = p?.playerId;
    if (id === undefined || id < 0) return;
    const who = this.player(id);
    if (!who) return;
    const st = this.game?.gs?.playerStats?.(id);
    this.pendingCard = {
      at: this.frame.t + 0.2,
      req: {
        player: who,
        tag: reason === 'interception' ? 'Interception' : 'Block',
        defensive: true,
        sub: `${who.position} · ${this.brands[who.team].name}`,
        stats: [
          { key: 'D', value: String(st?.blocks ?? 0) },
          { key: 'G', value: String(st?.goals ?? 0) },
          { key: 'A', value: String(st?.assists ?? 0) },
        ],
      },
    };
  }

  private onStateChanged(p: { to?: string }): void {
    const to = p?.to;
    if (to === 'HALFTIME') {
      this.pendingSummary = { at: this.frame.t + 0.4, data: this.buildSummary('Halftime'), hold: 12 };
      this.pendingCard = null;
    } else if (to === 'GAME_OVER') {
      this.pendingSummary = { at: this.frame.t + 0.6, data: this.buildSummary('Final'), hold: 999 };
    }
  }

  /**
   * A latched screenshot tableau sets the scoreline directly rather than
   * scoring a goal, so there is no `score` event to hang the card on. The
   * `score` tableau *is* a goal, though — the catch is on the fingertips and the
   * bench is emptying — so the endzone framing gets the card the live game
   * would have produced, built from the same data.
   */
  private queueTableauGoal(): void {
    const rt = this.game?.discRuntime;
    const id = rt?.holderId ?? -1;
    if (id < 0) return;
    // In live play `score` fires after GameState has already credited the goal,
    // so the card shows it. The tableau never reports the catch to GameState, so
    // the same card has to add the goal it is depicting or the two paths would
    // disagree about the same play.
    const req = this.goalCard(id, null, 1);
    if (req) this.pendingCard = { at: this.ctx.time + 0.25, req };
  }

  private goalCard(scorerId: number, assistId: number | null, creditGoal = 0): CardRequest | null {
    const who = this.player(scorerId);
    if (!who) return null;
    const st = this.game?.gs?.playerStats?.(scorerId);
    const assist = assistId !== null ? this.player(assistId) : null;
    const sub = assist
      ? `${who.position} · from #${assist.number} ${assist.name.toUpperCase()}`
      : `${who.position} · ${this.brands[who.team].name}`;
    return {
      player: who,
      tag: 'Goal',
      sub,
      stats: [
        { key: 'G', value: String((st?.goals ?? 0) + creditGoal) },
        { key: 'A', value: String(st?.assists ?? 0) },
        { key: 'D', value: String(st?.blocks ?? 0) },
      ],
    };
  }

  /* ---------------------------------------------------------------- summary */

  private buildSummary(title: string): SummaryData {
    const gs = this.game?.gs;
    const rows: SummaryRow[] = [];
    const a = gs?.teams?.[0];
    const b = gs?.teams?.[1];

    const cmp = (x: number, y: number, higherWins = true): -1 | 0 | 1 => {
      if (x === y) return -1;
      const homeBetter = higherWins ? x > y : x < y;
      return homeBetter ? 0 : 1;
    };

    if (a && b) {
      rows.push({
        key: 'Completions',
        a: `${a.completions}/${a.attempts}`,
        b: `${b.completions}/${b.attempts}`,
        winner: cmp(rate(a.completions, a.attempts), rate(b.completions, b.attempts)),
      });
      rows.push({
        key: 'Completion %',
        a: pctText(a.completions, a.attempts),
        b: pctText(b.completions, b.attempts),
        winner: cmp(rate(a.completions, a.attempts), rate(b.completions, b.attempts)),
      });
      rows.push({ key: 'Blocks', a: String(a.blocks), b: String(b.blocks), winner: cmp(a.blocks, b.blocks) });
      rows.push({
        key: 'Turnovers', a: String(a.turnoversCommitted), b: String(b.turnoversCommitted),
        winner: cmp(a.turnoversCommitted, b.turnoversCommitted, false),
      });
      rows.push({
        key: 'Throw yards', a: a.yardsThrown.toFixed(0), b: b.yardsThrown.toFixed(0),
        winner: cmp(a.yardsThrown, b.yardsThrown),
      });
      rows.push({
        key: 'Possession', a: clockText(a.timeOfPossession), b: clockText(b.timeOfPossession),
        winner: cmp(a.timeOfPossession, b.timeOfPossession),
      });
      rows.push({
        key: 'Holds / breaks', a: `${a.holds} / ${a.breaks}`, b: `${b.holds} / ${b.breaks}`,
        winner: cmp(a.breaks, b.breaks),
      });
    }

    // Headline the point: scorer, and the assist when there was one.
    let footBadge = '';
    let footText = '';
    const last = gs?.lastScore ?? null;
    if (last) {
      const sc = this.player(last.playerId);
      const as = last.assistId !== null && last.assistId !== undefined ? this.player(last.assistId) : null;
      if (sc) {
        footBadge = this.brands[sc.team].code;
        footText = as
          ? `#${sc.number} ${sc.name.toUpperCase()} from #${as.number} ${as.name.toUpperCase()}`
          : `#${sc.number} ${sc.name.toUpperCase()}`;
      }
    }

    const score: [number, number] = gs ? [gs.score[0], gs.score[1]] : [0, 0];
    return {
      title,
      point: `${this.brands[0].code} ${score[0]} — ${score[1]} ${this.brands[1].code}`,
      score,
      rows,
      footBadge,
      footText,
    };
  }
}

/* ---------------------------------------------------------------- helpers */

function rate(n: number, d: number): number { return d > 0 ? n / d : 0; }

function pctText(n: number, d: number): string {
  return d > 0 ? `${((100 * n) / d).toFixed(0)}%` : '—';
}

function defaultBrand(side: Side): TeamBrand {
  return side === 0
    ? { code: 'HOM', name: 'Home', colour: '#3f7ac9', raw: '#1d4e94', ink: '#ffffff', accent: '#e8b23c' }
    : { code: 'AWY', name: 'Away', colour: '#f2f2ee', raw: '#f2f2ee', ink: '#14181f', accent: '#b3372e' };
}
