import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx.ts';
import { Explorer } from './Explorer.ts';
import { ShotMachine, SHOT_SIDE, type ShotKind } from './Cuts.ts';
import { TELE, TeleRig } from './Tele.ts';
import { isLivePhase, type CamPhase, type CamPlayer, type PathPoint, type WorldView } from './View.ts';

/**
 * THE BROADCAST DIRECTOR.
 *
 * One camera is on air at a time. During live play it is always the tele rig
 * (`Tele.ts`) — an elevated sideline long lens on a dolly, leading the play and
 * never chasing the disc. Between points, and only in the phases the rules
 * machine actually goes dead in, the cut library (`Cuts.ts`) may take the pull
 * aerial, a low endzone angle or the celebration. There are no cuts while the
 * disc is live.
 *
 * Two things this file is careful about, both of which have bitten before:
 *
 *  1. IT YIELDS TO THE SCREENSHOT RIG. `capture/Shots.ts` hard-pins the camera
 *     and emits `shot:applied`; when that fires — or whenever `ctx.capture` is
 *     set — this stops writing to the camera entirely, for good. A captured
 *     frame is never a blend of a pinned shot and a live controller.
 *
 *  2. IT OWNS THE CAMERA-RELATIVE INPUT FRAME. `input/Input.ts` re-reads the
 *     live camera every step to build the movement basis, so a cut would
 *     otherwise rotate the player's controls out from under their thumb.
 *     `latchYaw()` freezes the yaw the input system sees at its pre-cut value
 *     until the stick comes back under 0.2, and the input system consults it.
 */

export interface DirectorTelemetry {
  shot: ShotKind;
  side: 'sideline' | 'endzone';
  shotAge: number;
  cuts: number;
  cutThisFrame: boolean;
  lastShotLength: number;
  forcedCuts: number;
  phase: CamPhase | 'none';
  live: boolean;
  panRate: number;
  tiltRate: number;
  zoomRate: number;
  dollySpeed: number;
  leadFrac: number;
  huck: number;
  redZone: number;
  frozen: boolean;
  pullFrac: number;
  latched: boolean;
}

export class CameraDirector implements System {
  readonly name = 'camera';
  readonly order = 10;

  readonly tele = new TeleRig();
  readonly cuts = new ShotMachine();
  private explorer = new Explorer();

  private ctx!: Ctx;
  private pinned = false;
  private hint: HTMLElement | null = null;
  private hintTimer = 0;

  /* ---- world view, rebuilt per frame without allocating ---- */
  private players: CamPlayer[] = [];
  private view: WorldView | null = null;
  private lastPhase: CamPhase | 'none' = 'none';

  /* ---- input yaw latch ---- */
  private latchedYaw: number | null = null;

  readonly telemetry: DirectorTelemetry = {
    shot: 'tele', side: 'sideline', shotAge: 0, cuts: 0, cutThisFrame: false,
    lastShotLength: 0, forcedCuts: 0, phase: 'none', live: false,
    panRate: 0, tiltRate: 0, zoomRate: 0, dollySpeed: 0, leadFrac: 1,
    huck: 0, redZone: 0, frozen: false, pullFrac: 0, latched: false,
  };

  init(ctx: Ctx): void {
    this.ctx = ctx;
    ctx.events.on('shot:applied', () => { this.pinned = true; });
    if (ctx.capture) { this.pinned = true; return; }

    this.explorer.attach(ctx);
    this.explorer.onFlash = (m) => this.flash(m);
    this.bindKeys();
    this.buildHint();
  }

  /* --------------------------------------------------------------- update */

  lateUpdate(dt: number, ctx: Ctx): void {
    if (this.pinned) return;
    if (this.explorer.isActive) {
      this.explorer.update(dt, ctx);
      this.tickHint(dt);
      return;
    }

    const w = this.readWorld(ctx);
    if (!w) { this.tickHint(dt); return; }

    const cam = ctx.camera;
    const aspect = cam.aspect > 0.1 ? cam.aspect : 16 / 9;
    const preCutYaw = cameraYawOf(cam);

    // The tele runs every frame whether or not it is on air, so that a cut back
    // to it lands on a shot that is already tracking rather than one that slews
    // into position over the next third of a second.
    this.tele.update(dt, w, aspect);
    const cut = this.cuts.update(dt, w, aspect);
    if (cut && this.cuts.shot === 'tele') this.tele.snap(w, aspect);

    if (this.cuts.shot === 'tele') this.tele.apply(cam);
    else this.cuts.apply(cam);

    if (cut) this.onCut(preCutYaw);

    this.publish(w);
    this.tickHint(dt);
  }

  /* ----------------------------------------------------------- world view */

  /**
   * Read the match off `ctx.sys.game`. Every field is probed defensively: this
   * system has to boot with the game system absent (a renderer-only page, a
   * unit test) and simply do nothing rather than throw in `lateUpdate`.
   */
  private readWorld(ctx: Ctx): WorldView | null {
    const game = ctx.sys['game'] as unknown as GamePeer | undefined;
    const gs = game?.gs;
    const rt = game?.discRuntime;
    if (!gs || !rt || !Array.isArray(game?.roster)) return null;

    const phase = gs.phase as CamPhase;
    const changed = phase !== this.lastPhase;
    this.lastPhase = phase;

    const offence: 0 | 1 = (gs.possession ?? gs.receivingTeam ?? 0) as 0 | 1;
    const attackDir = (gs.attackDir?.[offence] ?? 1) as 1 | -1;
    const pullDir = (gs.attackDir?.[gs.pullingTeam ?? 0] ?? 1) as 1 | -1;

    if (this.players.length !== game.roster.length) {
      this.players = game.roster.map((r) => ({ id: r.id, team: r.team, x: 0, y: 0, z: 0 }));
    }
    for (let i = 0; i < game.roster.length; i++) {
      const r = game.roster[i];
      const p = this.players[i];
      p.id = r.id; p.team = r.team;
      p.x = r.loco.pos.x; p.y = r.loco.pos.y; p.z = r.loco.pos.z;
    }

    const s = rt.state.pos;
    const dead = phase === 'TURNOVER_DEAD' || phase === 'PRE_PULL';
    const disc = dead || !Number.isFinite(s.x)
      ? { x: gs.discPos.x, y: 0.12, z: gs.discPos.z }
      : { x: s.x, y: s.y, z: s.z };

    const v = this.view ?? (this.view = {
      phase, phaseTimer: 0, phaseChanged: false, offence, attackDir, pullDir,
      disc, discFlight: false, throwerId: -1, markerId: -1, receiverId: -1,
      scorerId: -1, players: this.players,
      predict: () => this.predict(rt),
    });
    v.phase = phase;
    v.phaseTimer = gs.phaseTimer ?? 0;
    v.phaseChanged = changed;
    v.offence = offence;
    v.attackDir = attackDir;
    v.pullDir = pullDir;
    v.disc = disc;
    v.discFlight = rt.mode === 'flight';
    v.throwerId = gs.thrower ?? -1;
    v.markerId = safeCall(() => game.markerId?.() ?? -1, -1);
    v.receiverId = safeCall(() => game.selectedReceiverId?.(gs.thrower ?? -1) ?? -1, -1);
    v.scorerId = gs.lastScore?.playerId ?? -1;
    v.players = this.players;
    v.predict = () => this.predict(rt);
    return v;
  }

  /**
   * The remaining flight. `DiscRuntime.predictPath` integrates the SAME model
   * the disc actually flies, at the same fixed step, so the point the camera is
   * looking at is the point the disc arrives at — which is the only reason a
   * lead this long is possible at all.
   */
  private predict(rt: DiscPeer): readonly PathPoint[] {
    try { return rt.predictPath(rt.state, 6, 1 / 30) ?? []; } catch { return []; }
  }

  /* -------------------------------------------------------------- the cut */

  private onCut(preCutYaw: number): void {
    // Camera-relative movement must not rotate under the player's thumb.
    this.latchedYaw = preCutYaw;
  }

  /**
   * Called by `input/Input.ts` every step. Returns the yaw the movement basis
   * should use: the pre-cut value while the stick is still deflected, the live
   * camera the moment it comes back under 0.2 (or immediately, if it already is).
   */
  latchYaw(rawYaw: number, moveMag: number): number {
    if (this.latchedYaw === null) return rawYaw;
    if (!(moveMag >= 0.2)) { this.latchedYaw = null; return rawYaw; }
    return this.latchedYaw;
  }

  /** True while a post-cut latch is holding the input frame. */
  get yawLatched(): boolean { return this.latchedYaw !== null; }

  /* ------------------------------------------------------------ telemetry */

  private publish(w: WorldView): void {
    const t = this.telemetry;
    const c = this.cuts.telemetry;
    const r = this.tele.telemetry;
    const onTele = this.cuts.shot === 'tele';
    t.shot = c.shot;
    t.side = SHOT_SIDE[c.shot];
    t.shotAge = c.age;
    t.cuts = c.cuts;
    t.cutThisFrame = c.cutThisFrame;
    t.lastShotLength = c.lastShotLength;
    t.forcedCuts = c.forced;
    t.pullFrac = c.pullFrac;
    t.phase = w.phase;
    t.live = isLivePhase(w.phase);
    t.panRate = onTele ? r.panRate : 0;
    t.tiltRate = onTele ? r.tiltRate : 0;
    t.zoomRate = onTele ? r.zoomRate : 0;
    t.dollySpeed = onTele ? r.dollySpeed : 0;
    t.leadFrac = r.leadFrac;
    t.huck = r.huck;
    t.redZone = r.redZone;
    t.frozen = r.frozen;
    t.latched = this.latchedYaw !== null;
  }

  /* ------------------------------------------------------------ debug hooks */

  /** Release the capture pin. Only for probes that want to watch the director. */
  unpin(): void { this.pinned = false; }
  pin(): void { this.pinned = true; }
  get isPinned(): boolean { return this.pinned; }
  get mode(): 'broadcast' | 'explorer' { return this.explorer.isActive ? 'explorer' : 'broadcast'; }

  setExplorer(on: boolean): void {
    this.explorer.setActive(on);
    this.flash(on ? 'explorer · drag/wheel · 1–0 shots · F fly' : 'tele broadcast');
  }

  /* ------------------------------------------------------------------- ui */

  private bindKeys(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote') { this.setExplorer(!this.explorer.isActive); return; }
      if (e.code === 'KeyH' && !this.explorer.isActive) this.toggleHint();
      else if (e.key.toLowerCase() === 'h' && this.explorer.isActive) this.toggleHint();
    });
  }

  private buildHint(): void {
    if (typeof document === 'undefined') return;
    const ui = document.getElementById('ui');
    if (!ui) return;
    const el = document.createElement('div');
    el.style.cssText = [
      'position:absolute', 'left:16px', 'bottom:16px', 'padding:11px 15px',
      'background:rgba(6,10,16,.72)', '-webkit-backdrop-filter:blur(8px)',
      'backdrop-filter:blur(8px)', 'border:1px solid rgba(150,190,255,.16)',
      'border-radius:9px', 'color:#c9dcf5', 'letter-spacing:.03em',
      'font:500 11px/1.75 ui-monospace,SFMono-Regular,Menlo,monospace',
      'pointer-events:none', 'transition:opacity .4s ease', 'max-width:300px',
    ].join(';');
    el.innerHTML = `
      <div style="color:#7fb2ff;letter-spacing:.18em;font-size:9.5px;margin-bottom:7px">
        ULTIMATE · TELE BROADCAST</div>
      <div data-flash>camera follows the play</div>
      <div><b>\`</b> renderer explorer · <b>H</b> hide</div>`;
    ui.appendChild(el);
    this.hint = el;
  }

  private toggleHint(): void {
    if (!this.hint) return;
    this.hint.style.opacity = this.hint.style.opacity === '0' ? '1' : '0';
    this.hintTimer = 0;
  }

  private flash(msg: string): void {
    if (!this.hint) return;
    const line = this.hint.querySelector('[data-flash]') as HTMLElement | null;
    if (line) line.textContent = msg;
    this.hint.style.opacity = '1';
    this.hintTimer = 3.5;
  }

  private tickHint(dt: number): void {
    if (this.hintTimer <= 0) return;
    this.hintTimer -= dt;
    if (this.hintTimer <= 0) {
      const line = this.hint?.querySelector('[data-flash]') as HTMLElement | null;
      if (line) {
        line.textContent = this.explorer.isActive
          ? 'drag to orbit · wheel to zoom' : 'camera follows the play';
      }
    }
  }
}

/* ---------------------------------------------------------------- peers */

interface DiscPeer {
  mode: string;
  state: { pos: { x: number; y: number; z: number } };
  predictPath(state: unknown, horizon?: number, step?: number): PathPoint[];
}

interface GamePeer {
  gs: {
    phase: string;
    phaseTimer: number;
    possession: 0 | 1 | null;
    receivingTeam: 0 | 1;
    pullingTeam: 0 | 1;
    attackDir: [number, number];
    thrower: number | null;
    discPos: { x: number; y: number; z: number };
    lastScore: { playerId: number } | null;
  };
  discRuntime: DiscPeer;
  roster: { id: number; team: 0 | 1; loco: { pos: { x: number; y: number; z: number } } }[];
  markerId?(): number;
  selectedReceiverId?(id: number): number;
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch { return fallback; }
}

/**
 * Yaw the camera is looking along — derived exactly the way `input/Input.ts`
 * derives it, off the world matrix, so the value handed to the latch is in the
 * same frame as the value the input system will compare it against.
 */
function cameraYawOf(cam: THREE.PerspectiveCamera): number {
  const e = cam.matrixWorld.elements;
  const fx = -e[8];
  const fz = -e[10];
  if (fx === 0 && fz === 0) return 0;
  return Math.atan2(fx, fz);
}

export { TELE };
