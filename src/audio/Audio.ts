/**
 * ULTIMATE — the audio system.
 *
 * Owns nothing that makes sound. It owns the *decision* to make sound: when the
 * graph may legally exist, what the world currently looks like, and which layer
 * hears about which event. `Graph`/`Crowd`/`Ambience`/`Flight`/`Body` do the
 * synthesis; this file is the seam between them and `Ctx`.
 *
 * Three constraints shape it, in descending order of severity.
 *
 * 1. IT MAY NOT THROW. A screenshot rig drives every shot in `src/capture/`
 *    through this engine, and an exception raised from an event handler unwinds
 *    the emitter's whole loop — one bad number in an audio param would silently
 *    break the disc, the crowd and the camera on the same frame, and the failure
 *    would surface as a wrong *image*. So: every context call sits behind a
 *    guard, every parameter write goes through `Env.ts`'s clamping helpers, and
 *    a handler that fails four times disables the subsystem for the session
 *    rather than failing a fifth.
 *
 * 2. AUTOPLAY POLICY. No `AudioContext` may be constructed before a real user
 *    gesture. The capture rig never touches the page, so in `ctx.capture` the
 *    gesture listeners are never even attached: the system is a no-op object
 *    with a `name` and an `order`, which is exactly what a screenshot needs.
 *
 * 3. INJECTION. The context arrives through `AudioOpts.createContext`, so
 *    `tools/test-audio.ts` can build the entire graph against a fake and assert
 *    on the topology and the automation curves without a browser.
 *
 * Everything the layers need about the world is *pulled* once per rendered
 * frame off `ctx.sys` — never imported, never pushed. A missing peer degrades to
 * silence in that layer and nothing else.
 */

import type { Ctx, Rng, System } from '../core/Ctx.ts';
import { AudioGraph, placeListener, type AudioTier } from './Graph.ts';
import { CrowdLayer } from './Crowd.ts';
import { AmbienceLayer } from './Ambience.ts';
import { FlightLayer } from './Flight.ts';
import { BodyLayer, type BodyState } from './Body.ts';
import { DramaDirector, type CatchKind, type DramaFrame } from './Drama.ts';
import { clamp, num } from './Env.ts';

export interface AudioOpts {
  /** Build the context. Defaults to `window.AudioContext`. */
  createContext?: () => AudioContext;
  /** Skip the gesture requirement. Only the structural test sets this. */
  autostart?: boolean;
  /** Master level, 0..1. */
  volume?: number;
}

/* --------------------------------------------------------------- peer shapes
 * Structural mirrors of the bits of peer systems this file reads. Declared
 * rather than imported so a missing or renamed peer is a runtime `undefined`,
 * never a compile error or a module cycle. */

interface DiscLike {
  mode?: string;
  holderId?: number;
  wind?: { x: number; y: number; z: number };
  state?: {
    pos?: { x: number; y: number; z: number };
    vel?: { x: number; y: number; z: number };
    airspeed?: number;
    spin?: number;
    atRest?: boolean;
    groundY?: number;
  };
}

interface GameLike {
  gs?: { phase?: string; stallCount?: number; possession?: number | null };
  discRuntime?: DiscLike;
}

interface LocoLike { players?: readonly BodyState[] }

type Vec3ish = { x: number; y: number; z: number } | undefined;

const GESTURES = ['pointerdown', 'keydown', 'touchstart', 'mousedown'] as const;

/**
 * `resume()` and `suspend()` return promises that REJECT — the autoplay policy
 * refusing a resume, an OfflineAudioContext refusing one outright, a context
 * closed between the call and the microtask. An unattached rejection is an
 * uncaught error in the page console on every one of those, so nothing in this
 * file ever calls them bare.
 */
function quiet(p: unknown): void {
  if (p && typeof (p as Promise<void>).catch === 'function') {
    (p as Promise<void>).catch(() => { /* the state we wanted is the state we got */ });
  }
}

export class AudioSystem implements System {
  readonly name = 'audio';
  /** After gameplay (game 5, players 6, disc 7) and after the camera (10). */
  readonly order = 12;

  /** Null until a user gesture (or `autostart`) builds it. */
  graph: AudioGraph | null = null;
  crowd: CrowdLayer | null = null;
  ambience: AmbienceLayer | null = null;
  flight: FlightLayer | null = null;
  body: BodyLayer | null = null;
  /** Turns match state into crowd behaviour. Null until the graph exists. */
  drama: DramaDirector | null = null;

  /** False in capture, when no context can be made, or after a hard failure. */
  available = false;
  /** True once the graph exists and is running. */
  running = false;

  private ctx: Ctx | null = null;
  private rng: Rng | null = null;
  private opts: AudioOpts;
  private armed = false;
  private failures = 0;
  private warned = false;
  private muted = false;
  private lastPhase = '';
  private lastDiscMode = '';
  private discHeld = false;
  /** Mirror of the rules machine's stall count, for the hush model. */
  private stall = 0;
  private stallMax = 10;
  /** Reused every frame — the director's input must not allocate. */
  private frame: DramaFrame = {
    phase: '', stall: 0, stallMax: 10, inFlight: false,
    x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 0, groundY: 0, players: undefined,
  };
  /** Event-bus unsubscribers and the visibility hook — torn down on dispose. */
  private offs: Array<() => void> = [];
  /** Gesture listeners only — torn down the instant one of them fires. */
  private gestureOffs: Array<() => void> = [];

  constructor(opts: AudioOpts = {}) { this.opts = opts; }

  /* ------------------------------------------------------------- lifecycle */

  init(ctx: Ctx): void {
    this.ctx = ctx;
    this.rng = ctx.rand.fork(0xa0d10);
    this.wireEvents(ctx);

    // The capture rig never interacts with the page. Attaching listeners there
    // is not merely useless, it is the one way this file could ever affect a
    // screenshot — so it does not happen.
    if (ctx.capture) return;

    if (this.opts.autostart) { this.start(); return; }
    if (typeof window === 'undefined') return;
    this.arm();
  }

  /** Attach one-shot gesture listeners. Idempotent. */
  private arm(): void {
    if (this.armed || typeof window === 'undefined') return;
    this.armed = true;
    // If the first gesture fails to produce a context — a policy that wanted a
    // different interaction type, a tab that was still loading — re-arm and let
    // the next one try. Never re-arm when there is no AudioContext class at all.
    const fire = (): void => {
      this.disarm();
      if (!this.start() && this.failures < 4 && (this.opts.createContext || defaultContextFactory())) {
        this.arm();
      }
    };
    for (const evt of GESTURES) {
      window.addEventListener(evt, fire, { passive: true });
      this.gestureOffs.push(() => window.removeEventListener(evt, fire));
    }
    if (typeof document !== 'undefined') {
      const vis = (): void => {
        const ac = this.graph?.ac;
        if (!ac) return;
        try {
          quiet(document.hidden ? ac.suspend?.() : ac.resume?.());
        } catch { /* a suspended-then-closed context must not matter */ }
      };
      document.addEventListener('visibilitychange', vis);
      this.offs.push(() => document.removeEventListener('visibilitychange', vis));
    }
  }

  private disarm(): void {
    // Only the gesture listeners; the event bus and the visibility hook outlive
    // them and are torn down by dispose().
    for (const off of this.gestureOffs) { try { off(); } catch { /* ignore */ } }
    this.gestureOffs.length = 0;
    this.armed = false;
  }

  /**
   * Build the graph. Safe to call more than once; safe to call when no
   * `AudioContext` exists anywhere (it simply reports false).
   */
  start(): boolean {
    if (this.running || !this.ctx || !this.rng) return this.running;
    try {
      const make = this.opts.createContext ?? defaultContextFactory();
      if (!make) return false;
      const ac = make();
      if (!ac) return false;

      const tier = (this.ctx.quality?.tier ?? 'medium') as AudioTier;
      const g = new AudioGraph(ac, tier, this.rng.fork(0x9a71));
      this.graph = g;
      this.crowd = new CrowdLayer(g, this.rng.fork(0x9a72));
      this.ambience = new AmbienceLayer(g, this.rng.fork(0x9a73));
      this.flight = new FlightLayer(g, this.rng.fork(0x9a74));
      this.body = new BodyLayer(g, this.rng.fork(0x9a75));
      this.drama = new DramaDirector(this.crowd);

      // Adopt whatever the match is already doing rather than starting cold.
      const phase = this.game()?.gs?.phase;
      if (typeof phase === 'string') {
        this.crowd.setPhase(phase);
        this.drama.setPhase(phase);
        this.lastPhase = phase;
      }

      try { quiet(ac.resume?.()); } catch { /* already running */ }
      g.setMaster(this.muted ? 0 : clamp(this.opts.volume ?? 0.85, 0, 1), 1.4);

      this.available = true;
      this.running = true;
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.graph?.setMaster(m ? 0 : clamp(this.opts.volume ?? 0.85, 0, 1), 0.2);
  }

  dispose(): void {
    this.disarm();
    for (const off of this.offs) { try { off(); } catch { /* ignore */ } }
    this.offs.length = 0;
    try {
      this.crowd?.dispose();
      this.ambience?.dispose();
      this.flight?.dispose();
      this.body?.dispose();
      this.drama?.dispose();
      this.graph?.dispose();
    } catch { /* ignore */ }
    this.crowd = null; this.ambience = null; this.flight = null; this.body = null;
    this.drama = null;
    this.graph = null;
    this.running = false;
    this.available = false;
  }

  /**
   * Four consecutive internal errors and the subsystem retires for the session.
   * One warning, never per-frame — a console spammed by audio is a console
   * nobody reads for the renderer.
   */
  private fail(err: unknown): void {
    this.failures++;
    if (!this.warned) {
      this.warned = true;
      console.warn('[audio] disabled after an internal error:', err);
    }
    if (this.failures >= 4) this.dispose();
  }

  /* ---------------------------------------------------------------- events */

  private game(): GameLike | undefined {
    return this.ctx?.sys?.['game'] as unknown as GameLike | undefined;
  }

  /** The disc runtime, from either owner. */
  private disc(): DiscLike | undefined {
    const d = this.ctx?.sys?.['disc'] as unknown as { rt?: DiscLike } | undefined;
    return d?.rt ?? this.game()?.discRuntime;
  }

  private loco(): LocoLike | undefined {
    return this.ctx?.sys?.['locomotion'] as unknown as LocoLike | undefined;
  }

  /** Wrap a handler so a bad payload can never escape into the emitter's loop. */
  private on(ctx: Ctx, evt: string, fn: (p: any) => void): void {
    const off = ctx.events.on(evt, (p: any) => {
      if (!this.graph) return;
      try { fn(p); } catch (err) { this.fail(err); }
    });
    this.offs.push(off);
  }

  private xyz(v: Vec3ish, fallback: [number, number, number] = [0, 1, 0]): [number, number, number] {
    if (!v) return fallback;
    return [num(v.x, fallback[0]), num(v.y, fallback[1]), num(v.z, fallback[2])];
  }

  private wireEvents(ctx: Ctx): void {
    /* ------------------------------------------------------------- the disc */

    this.on(ctx, 'disc:released', (p) => {
      const [x, y, z] = this.xyz(p?.pos);
      const v = p?.vel;
      const speed = v ? Math.hypot(num(v.x), num(v.y), num(v.z)) : 12;
      const kind = String(p?.throwType ?? 'backhand');
      this.flight?.release(x, y, z, clamp(speed / 26, 0, 1), kind);
      // The stands react to the *shape* of the throw before they know whether
      // it lands, and to the tension it just released. Both belong to the
      // director, which is also the only thing that knows a stall was running.
      const stall = num(p?.stall, num(this.game()?.gs?.stallCount, 0));
      this.stall = 0;
      this.drama?.release(speed, stall, kind === 'pull');
    });

    this.on(ctx, 'disc:caught', (p) => {
      const [x, y, z] = this.xyz(p?.pos);
      const out = String(p?.outcome ?? 'completion');
      const airborne = this.playerAirborne(num(p?.playerId, -1));
      // A bid catch is a crack rather than a pancake. The body impact that
      // follows is NOT synthesised here — locomotion emits its own
      // `player:land`, and doubling the two is the classic sports-game mush.
      this.flight?.catch(x, y + 1.1, z, airborne ? 0.85 : 0.45);

      const kind: CatchKind = out === 'goal' ? 'goal'
        : out === 'interception' ? 'interception'
          : out === 'pull' ? 'pull'
            : airborne ? 'big' : 'plain';
      this.drama?.caught(kind, airborne);
    });

    this.on(ctx, 'disc:grounded', (p) => {
      const [x, y, z] = this.xyz(p?.pos, [0, 0.05, 0]);
      const reason = String(p?.reason ?? '');
      // A drop or a block means hands were on it before the grass was.
      if (reason === 'block') this.flight?.graze(x, y + 1.2, z, 1);
      else if (reason === 'drop' || reason === 'pull-drop') this.flight?.graze(x, y + 1.1, z, 0.55);
      this.flight?.ground(x, Math.max(0.03, y), z);
      // A block is the only grounding a body earned, so it is the only one that
      // pays off a bid that is still in the air.
      if (reason === 'block') this.drama?.blocked();
      else this.drama?.grounded();
    });

    /* ------------------------------------------------------------- the game */

    this.on(ctx, 'score', () => {
      this.drama?.scored();
      this.crowd?.react('goal');
      this.ambience?.horn();
      this.ambience?.announceGoal();
    });

    this.on(ctx, 'turnover', (p) => {
      const r = String(p?.reason ?? '');
      // A groan that started while the disc was still in the air deepens as it
      // lands; it does not fire again at full size.
      const s = this.drama?.turnoverScale() ?? 1;
      if (r === 'block') this.crowd?.react('block');
      else if (r === 'interception') this.crowd?.react('interception');
      else if (r === 'drop') this.crowd?.react('drop', s);
      else this.crowd?.react('turnover', s);
    });

    // The stall count is read per frame off the rules machine, but the event is
    // the only source that survives a missing peer, so it is mirrored here.
    this.on(ctx, 'stall:tick', (p) => {
      this.stall = num(p?.count, 0);
      this.stallMax = Math.max(4, num(p?.max, 10));
    });

    this.on(ctx, 'state:changed', (p) => {
      const to = String(p?.to ?? '');
      if (to) {
        this.crowd?.setPhase(to);
        this.drama?.setPhase(to);
        this.lastPhase = to;
        if (to !== 'LIVE_POSSESSION') this.stall = 0;
      }
    });

    /* ---------------------------------------------------------------- bodies */

    this.on(ctx, 'player:footstep', (p) => {
      const [x, y, z] = this.xyz(p?.pos, [0, 0, 0]);
      this.body?.footstep(x, y, z, num(p?.speed, 3), !!p?.hard, p?.foot === 'L' ? 'L' : 'R');
    });

    this.on(ctx, 'player:land', (p) => {
      const [x, y, z] = this.xyz(p?.pos, [0, 0, 0]);
      const layout = !!p?.layout;
      this.body?.land(x, y, z, num(p?.impact, 3), layout);
      // How big the reaction is depends on whether the bid produced anything,
      // and only the director knows that — a bid at nothing used to fire the
      // same reaction as a bid that took the disc off somebody.
      if (layout) this.drama?.layoutLanded();
    });

    this.on(ctx, 'player:contact', (p) => {
      const impact = num(p?.impact, 0);
      if (impact < 1.2) return;
      const players = this.loco()?.players;
      const a = players?.find((q) => q.id === num(p?.a, -1));
      const pos = a?.pos;
      this.body?.bump(num(pos?.x, 0), num(pos?.y, 1), num(pos?.z, 0), impact);
    });
  }

  private playerAirborne(id: number): boolean {
    if (id < 0) return false;
    const p = this.loco()?.players?.find((q) => q.id === id);
    return !!p && (p.state === 'layout' || p.state === 'jump' || p.state === 'landing');
  }

  /* ------------------------------------------------------------- per frame */

  /**
   * Runs once per rendered frame, not per fixed sim step: audio parameters are
   * continuous and 120 automation writes a second per parameter is pure waste.
   */
  lateUpdate(dt: number, ctx: Ctx): void {
    const g = this.graph;
    if (!g || !this.running) return;
    try {
      const d = clamp(dt, 0, 0.25);
      const now = g.now;
      g.reap(now);

      /* listener — straight off the camera's world matrix, no allocation */
      const e = ctx.camera.matrixWorld.elements;
      const px = e[12]; const py = e[13]; const pz = e[14];
      placeListener(g.ac.listener, px, py, pz, -e[8], -e[9], -e[10], e[4], e[5], e[6], now);

      /* crowd */
      const crowd = this.crowd;
      if (crowd) {
        // Level falls away as the camera leaves the bowl — the establishing
        // wide sits 200 m out and should not have a front-row crowd on it.
        const dist = Math.hypot(px, pz) + Math.max(0, py - 12) * 0.6;
        crowd.setProximity(clamp(1.35 - dist / 165, 0.18, 1));
        crowd.update(d);
      }

      /* ambience */
      const disc = this.disc();
      const w = disc?.wind;
      this.ambience?.update(d, num(w?.x, 0), num(w?.z, 0));

      /* the disc */
      const st = disc?.state;
      const mode = String(disc?.mode ?? '');
      const dp = st?.pos;
      const dv = st?.vel;
      const inFlight = mode === 'flight' && !st?.atRest;
      if (this.flight && st) {
        this.flight.setListener(px, py, pz);
        this.flight.update(d, {
          x: num(dp?.x, 0), y: num(dp?.y, 1), z: num(dp?.z, 0),
          vx: num(dv?.x, 0), vy: num(dv?.y, 0), vz: num(dv?.z, 0),
          airspeed: num(st.airspeed, 0),
          spin: num(st.spin, 0),
          inFlight,
        });
        this.lastDiscMode = mode;
        this.discHeld = mode === 'held';
      }

      /* bodies */
      const players = this.loco()?.players;
      const body = this.body;
      if (body) {
        body.setListener(px, py, pz);
        if (players && players.length) {
          const carrier = num(disc?.holderId, -1);
          body.update(d, players, carrier, this.lastPhase === 'LIVE_POSSESSION');
        }
      }

      /* the director — last, because it reads everything above */
      const drama = this.drama;
      if (drama) {
        const gs = this.game()?.gs;
        const f = this.frame;
        f.phase = this.lastPhase;
        // The rules machine is authoritative when it is there; the mirrored
        // event value is the fallback when it is not.
        f.stall = num(gs?.stallCount, this.stall);
        f.stallMax = this.stallMax;
        f.inFlight = inFlight;
        f.x = num(dp?.x, 0); f.y = num(dp?.y, 1); f.z = num(dp?.z, 0);
        f.vx = num(dv?.x, 0); f.vy = num(dv?.y, 0); f.vz = num(dv?.z, 0);
        f.groundY = num(st?.groundY, 0);
        f.players = players;
        drama.update(d, f);
      }

      this.failures = 0;
    } catch (err) {
      this.fail(err);
    }
  }

  /** Diagnostics for `tools/test-audio.ts`. */
  debug(): Record<string, unknown> {
    return {
      available: this.available,
      running: this.running,
      voices: this.graph?.voiceCount ?? 0,
      phase: this.lastPhase,
      discMode: this.lastDiscMode,
      held: this.discHeld,
      stall: this.stall,
      crowd: this.crowd?.debug() ?? null,
      drama: this.drama?.debug() ?? null,
      doppler: this.flight?.lastDoppler ?? 1,
      wind: this.ambience?.windSpeed ?? 0,
    };
  }
}

/** `window.AudioContext`, with the legacy prefix, or null off-browser. */
function defaultContextFactory(): (() => AudioContext) | null {
  if (typeof window === 'undefined') return null;
  const W = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const C = W.AudioContext ?? W.webkitAudioContext;
  if (!C) return null;
  return () => new C({ latencyHint: 'interactive' });
}
