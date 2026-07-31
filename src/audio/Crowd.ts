/**
 * ULTIMATE — the crowd.
 *
 * Three layers, because an ear resolves a stadium in three parts:
 *
 *  1. THE BED. `sections` independent murmur loops, each detuned, each panned to
 *     its own arc of the bowl, each with a slow LFO on its gain. The wander is
 *     the point: a single loop at a fixed level is instantly identifiable as a
 *     loop, whereas three loops breathing against each other at 0.04–0.1 Hz
 *     never repeat within a shot's length. The bed's lowpass opens with
 *     excitement — a crowd getting louder also gets *brighter*, because people
 *     stop murmuring and start shouting, and only modelling level makes the
 *     whole thing sound like a fader move.
 *  2. THE ROAR. The same murmur played fast through a resonance, gated by the
 *     excitement envelope. Fast playback pulls the syllable rate up into the
 *     region where it stops reading as speech and starts reading as a vowel
 *     wall — which is exactly what 8,000 people going "aaah" is.
 *  3. THE APPLAUSE. Constant-density clap texture, gated the same way.
 *
 * Excitement itself is a plain numeric model updated every frame, never a
 * scheduled one-shot. Events *add* to a target that decays; the audible level
 * chases that target with an attack. Two catches half a second apart therefore
 * stack into one bigger swell, and a score decays over five seconds because its
 * decay constant is long — not because a five-second envelope was scheduled.
 * That difference is the whole reason a real broadcast crowd sounds alive.
 */

import type { Rng } from '../core/Ctx.ts';
import type { AudioGraph } from './Graph.ts';
import { clamp, glideTo, num, setAt } from './Env.ts';

/** Baseline murmur per rules phase. */
const PHASE_BED: Record<string, number> = {
  PRE_PULL: 0.30,
  PULL_IN_FLIGHT: 0.44,
  LIVE_POSSESSION: 0.34,
  DISC_IN_FLIGHT: 0.48,
  TURNOVER_DEAD: 0.38,
  CHECK: 0.29,
  POINT_SCORED: 0.66,
  TIMEOUT: 0.40,
  HALFTIME: 0.46,
  GAME_OVER: 0.72,
};

interface Section {
  src: AudioBufferSourceNode;
  lp: BiquadFilterNode;
  gain: GainNode;
  lfo: OscillatorNode;
  lfoAmt: GainNode;
  bias: number;
}

export interface Reaction {
  /** How much excitement to add. 1.0 is a goal. */
  amount: number;
  /** Decay constant of that addition, seconds. */
  tau: number;
  /** 1 = cheer (bright), 0 = groan (dark). */
  valence: number;
}

export const REACTIONS = {
  catch: { amount: 0.20, tau: 1.1, valence: 0.85 },
  bigCatch: { amount: 0.44, tau: 1.9, valence: 0.92 },
  layout: { amount: 0.62, tau: 2.6, valence: 0.95 },
  block: { amount: 0.58, tau: 2.4, valence: 0.90 },
  interception: { amount: 0.66, tau: 2.8, valence: 0.90 },
  drop: { amount: 0.34, tau: 2.0, valence: 0.12 },
  turnover: { amount: 0.30, tau: 1.8, valence: 0.20 },
  huck: { amount: 0.30, tau: 1.4, valence: 0.70 },
  stall: { amount: 0.16, tau: 0.9, valence: 0.55 },
  goal: { amount: 1.20, tau: 4.6, valence: 1.0 },
} as const satisfies Record<string, Reaction>;

export type ReactionName = keyof typeof REACTIONS;

export class CrowdLayer {
  /** 0..1 phase baseline, slewed. */
  private bed = 0.3;
  private bedTarget = 0.3;
  /** Decaying excitement target. */
  private surge = 0;
  private surgeTau = 2;
  /** What the mix actually plays — chases `surge` with an attack. */
  private roar = 0;
  /** 0 groan .. 1 cheer. */
  private val = 0.8;
  private prox = 1;

  private sections: Section[] = [];
  private applause: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private roarNodes: { src: AudioBufferSourceNode; bp: BiquadFilterNode; gain: GainNode } | null = null;

  private readonly g: AudioGraph;

  constructor(g: AudioGraph, rng: Rng) {
    this.g = g;
    const ac = g.ac;
    const t = g.now;
    const n = Math.max(1, g.budget.sections);

    // The stands wrap the pitch, so the sections are spread across the full
    // stereo field rather than clustered; with one section it sits dead centre.
    for (let i = 0; i < n; i++) {
      const pan = n === 1 ? 0 : (i / (n - 1)) * 1.6 - 0.8;
      const rate = 0.93 + (i / Math.max(1, n)) * 0.13 + rng.range(-0.02, 0.02);
      const src = g.loop(g.beds.murmur, rate, rng.range(0, g.beds.murmur.duration));
      const lp = g.filter('lowpass', 1200, 0.7);
      const gain = g.gain(0.0001);
      src.connect(lp);
      lp.connect(gain);
      const sp = g.stereo(pan);
      if (sp) { gain.connect(sp); sp.connect(g.crowd); } else { gain.connect(g.crowd); }

      // Slow gain wander. Connecting an oscillator to an AudioParam *adds* to
      // whatever the param is being driven to, so the breathing rides on top of
      // the excitement model rather than fighting it.
      const lfo = ac.createOscillator();
      lfo.type = 'sine';
      setAt(lfo.frequency, rng.range(0.031, 0.105), t);
      const lfoAmt = g.gain(0.04 + rng.range(0, 0.03));
      lfo.connect(lfoAmt);
      lfoAmt.connect(gain.gain);
      lfo.start(t + i * 0.37);

      this.sections.push({ src, lp, gain, lfo, lfoAmt, bias: 0.85 + rng.range(0, 0.3) });
    }

    // Roar: the murmur at 1.5x is a vowel wall, not a conversation.
    {
      const src = g.loop(g.beds.murmur, 1.52, rng.range(0, g.beds.murmur.duration));
      const bp = g.filter('peaking', 760, 0.9, 8);
      const hp = g.filter('highpass', 180, 0.6);
      const gain = g.gain(0.0001);
      src.connect(hp); hp.connect(bp); bp.connect(gain); gain.connect(g.crowd);
      this.roarNodes = { src, bp, gain };
    }

    {
      const src = g.loop(g.beds.applause, 1 + rng.range(-0.03, 0.03), rng.range(0, g.beds.applause.duration));
      const gain = g.gain(0.0001);
      src.connect(gain); gain.connect(g.crowd);
      this.applause = { src, gain };
    }

    // The stands are inside the bowl; they get a healthy, permanent send.
    const send = g.gain(0.30);
    g.crowd.connect(send);
    send.connect(g.verbIn);
  }

  /** Rules phase drives the resting level. Unknown names leave it alone. */
  setPhase(phase: string): void {
    const v = PHASE_BED[phase];
    if (typeof v === 'number') this.bedTarget = v;
  }

  /** 0..1 — how close the camera is to the bowl. Set by the system. */
  setProximity(k: number): void { this.prox = clamp(k, 0, 1); }

  react(name: ReactionName, scale = 1): void {
    const r = REACTIONS[name];
    if (!r) return;
    this.addSurge(r.amount * clamp(scale, 0, 3), r.tau, r.valence);
  }

  /**
   * Additive excitement. The new decay constant is blended by weight, so a
   * quick catch on top of a decaying goal roar does not shorten the goal.
   */
  addSurge(amount: number, tau: number, valence: number): void {
    const a = clamp(amount, 0, 2);
    if (a <= 0) return;
    const before = this.surge;
    this.surge = Math.min(1.6, before + a);
    const w = before + a;
    this.surgeTau = w > 1e-6 ? (this.surgeTau * before + Math.max(0.2, tau) * a) / w : tau;
    this.val = w > 1e-6 ? (this.val * before + clamp(valence, 0, 1) * a) / w : valence;
  }

  /** Current audible excitement, 0..1.6. Read by the PA and the horn. */
  get level(): number { return this.roar; }

  update(dt: number): void {
    const d = clamp(dt, 0, 0.25);

    this.bed += (this.bedTarget - this.bed) * (1 - Math.exp(-d / 1.6));
    this.surge *= Math.exp(-d / Math.max(0.2, this.surgeTau));
    if (this.surge < 1e-4) this.surge = 0;
    // Asymmetric slew: a crowd erupts far faster than it settles.
    const tau = this.surge > this.roar ? 0.20 : 0.75;
    this.roar += (this.surge - this.roar) * (1 - Math.exp(-d / tau));
    // Valence relaxes back to neutral-positive between events.
    this.val += (0.8 - this.val) * (1 - Math.exp(-d / 6));

    const t = this.g.now;
    const heat = clamp(this.bed * 0.45 + this.roar * 0.7, 0, 1.4);
    const p = this.prox;

    for (const s of this.sections) {
      glideTo(s.gain.gain, (0.055 + 0.115 * this.bed + 0.075 * this.roar) * s.bias * p, t, 0.25);
      glideTo(s.lp.frequency, 780 + 3100 * heat, t, 0.4);
    }
    if (this.roarNodes) {
      const lvl = Math.max(0, this.roar - 0.06);
      glideTo(this.roarNodes.gain.gain, 0.40 * Math.pow(lvl, 1.15) * p, t, 0.18);
      // Bright when they are cheering, dark and chesty when they are groaning.
      glideTo(this.roarNodes.bp.frequency, 430 + 780 * this.val, t, 0.5);
    }
    if (this.applause) {
      // Applause only really starts once the roar is up, and it is a cheer-only
      // behaviour — nobody claps a drop.
      const lvl = Math.max(0, this.roar - 0.12) * this.val;
      glideTo(this.applause.gain.gain, (0.012 + 0.42 * Math.pow(lvl, 1.3)) * p, t, 0.22);
    }
  }

  /** Diagnostics for the structural test. */
  debug(): { bed: number; surge: number; roar: number; val: number } {
    return { bed: num(this.bed), surge: num(this.surge), roar: num(this.roar), val: num(this.val) };
  }

  dispose(): void {
    const stop = (s: AudioScheduledSourceNode): void => { try { s.stop(); s.disconnect(); } catch { /* ignore */ } };
    for (const s of this.sections) { stop(s.src); stop(s.lfo); s.gain.disconnect(); s.lp.disconnect(); s.lfoAmt.disconnect(); }
    if (this.roarNodes) { stop(this.roarNodes.src); this.roarNodes.gain.disconnect(); }
    if (this.applause) { stop(this.applause.src); this.applause.gain.disconnect(); }
    this.sections.length = 0;
  }
}
