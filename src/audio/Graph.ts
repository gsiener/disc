/**
 * ULTIMATE — the mix graph.
 *
 * One class owns every persistent node in the game: the master chain, the three
 * stems, the reverb loop and the transient-voice pool. Everything else in
 * `src/audio/` is a *layer* that is handed this object and asked to make noise
 * into one of its buses. Nothing else calls `createGain` directly.
 *
 * Why a fixed stem topology rather than "every voice to destination":
 *
 *  - A stadium mix has three things fighting for the same 6 dB: a wall of crowd,
 *    a handful of very close field sounds, and a wide bed of air. Bussing them
 *    means the crowd can duck the field, the reverb send can be per-stem (the
 *    pitch is drier than the stands, which are inside the bowl), and the whole
 *    thing hits one limiter instead of clipping the output stage.
 *  - `field` is the only spatialised stem. Crowd and ambience are stereo beds
 *    with no listener-relative position — a crowd panned as a point source
 *    collapses the moment the camera turns, which is the single most common
 *    mistake in game audio.
 *
 * The graph is built exactly once, on a real user gesture, by `AudioSystem`.
 * Nothing here reaches for a global; the `AudioContext` arrives by injection so
 * `tools/test-audio.ts` can drive the whole thing against a fake.
 */

import type { Rng } from '../core/Ctx.ts';
import {
  bakeApplause, bakeImpulse, bakeMurmur, bakePink, bakeWhite,
} from './Bake.ts';
import { AUDIO_EPS, clamp, glideTo, num, setAt } from './Env.ts';

export type AudioTier = 'low' | 'medium' | 'high' | 'ultra';

export interface TierBudget {
  /** Hard ceiling on simultaneous transient voices. */
  voices: number;
  /** Independent crowd sections, each with its own wander and pan. */
  sections: number;
  /** HRTF costs roughly 10x equalpower per panner; only worth it up top. */
  hrtf: boolean;
  /** Convolution reverb. A 1.5 s stereo IR is not free on a weak machine. */
  reverb: boolean;
  /** Loop length of the crowd/applause beds, seconds. Longer = less obvious. */
  bedSeconds: number;
  /** Reverb RT60. An open bowl, not a cathedral. */
  rt60: number;
  /** One-shots further than this from the listener are never scheduled. */
  cull: number;
}

export const TIERS: Record<AudioTier, TierBudget> = {
  low:    { voices: 10, sections: 1, hrtf: false, reverb: false, bedSeconds: 4.0, rt60: 1.05, cull: 34 },
  medium: { voices: 18, sections: 2, hrtf: false, reverb: true,  bedSeconds: 6.0, rt60: 1.30, cull: 46 },
  high:   { voices: 28, sections: 3, hrtf: true,  reverb: true,  bedSeconds: 8.0, rt60: 1.50, cull: 64 },
  ultra:  { voices: 36, sections: 4, hrtf: true,  reverb: true,  bedSeconds: 10.0, rt60: 1.60, cull: 84 },
};

export interface Beds {
  /** Mono white loop — the source for every noise-based transient. */
  white: AudioBuffer;
  /** Stereo pink loop — wind and room tone. */
  pink: AudioBuffer;
  /** Stereo crowd murmur with a real syllable rate. */
  murmur: AudioBuffer;
  /** Stereo constant-density applause, gated in realtime. */
  applause: AudioBuffer;
  /** Stereo stadium impulse response, or null below the reverb threshold. */
  impulse: AudioBuffer | null;
}

/** A scheduled transient. The pool owns its lifetime. */
export interface Voice {
  /** Context time after which every node may be disconnected. */
  end: number;
  /** Higher survives when the pool is full. */
  prio: number;
  srcs: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  /** The voice's output stage — faded before an early steal. */
  vca: GainNode | null;
}

export interface PannerOpts {
  ref?: number;
  rolloff?: number;
  max?: number;
  /** 0..1 send into the stadium reverb. */
  verb?: number;
}

/* ------------------------------------------------------------------ helpers */

/**
 * Position a panner. The `positionX` AudioParams are the modern form and the
 * only ones that can be automated; `setPosition` is deprecated but is still all
 * that some engines expose, so both paths exist and neither is assumed.
 */
export function placePanner(
  p: PannerNode, x: number, y: number, z: number, t: number, tau = 0,
): void {
  const px = (p as unknown as { positionX?: AudioParam }).positionX;
  if (px) {
    const py = (p as unknown as { positionY: AudioParam }).positionY;
    const pz = (p as unknown as { positionZ: AudioParam }).positionZ;
    if (tau > 0) { glideTo(px, x, t, tau); glideTo(py, y, t, tau); glideTo(pz, z, t, tau); }
    else { setAt(px, x, t); setAt(py, y, t); setAt(pz, z, t); }
    return;
  }
  const legacy = p as unknown as { setPosition?(x: number, y: number, z: number): void };
  legacy.setPosition?.(num(x), num(y), num(z));
}

/** Move the listener. Same modern/legacy split as `placePanner`. */
export function placeListener(
  l: AudioListener,
  px: number, py: number, pz: number,
  fx: number, fy: number, fz: number,
  ux: number, uy: number, uz: number,
  t: number,
): void {
  const ap = l as unknown as Record<string, AudioParam | undefined>;
  if (ap.positionX) {
    const set = (k: string, v: number): void => { const p = ap[k]; if (p) glideTo(p, v, t, 0.02); };
    set('positionX', px); set('positionY', py); set('positionZ', pz);
    set('forwardX', fx); set('forwardY', fy); set('forwardZ', fz);
    set('upX', ux); set('upY', uy); set('upZ', uz);
    return;
  }
  const legacy = l as unknown as {
    setPosition?(x: number, y: number, z: number): void;
    setOrientation?(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
  };
  legacy.setPosition?.(num(px), num(py), num(pz));
  legacy.setOrientation?.(num(fx), num(fy), num(fz), num(ux), num(uy), num(uz));
}

/* -------------------------------------------------------------------- graph */

export class AudioGraph {
  readonly budget: TierBudget;
  readonly beds: Beds;

  /** Everything ends here. */
  readonly limiter: DynamicsCompressorNode;
  readonly master: GainNode;

  /** Stems. */
  readonly crowd: GainNode;
  readonly field: GainNode;
  readonly amb: GainNode;

  /** Reverb loop. `verbIn` is the shared send; layers tap it per-voice. */
  readonly verbIn: GainNode;
  readonly verbOut: GainNode;
  readonly convolver: ConvolverNode | null = null;

  private voices: Voice[] = [];
  private killed = false;

  readonly ac: AudioContext;

  constructor(ac: AudioContext, tier: AudioTier, rng: Rng) {
    this.ac = ac;
    const b = TIERS[tier] ?? TIERS.medium;
    this.budget = b;

    const t0 = ac.currentTime;

    // Master chain. The limiter is a safety net, not a mix tool: a 12 dB ratio
    // above -8 dB catches a horn and a score roar landing on the same frame
    // without audibly pumping on ordinary play.
    this.limiter = ac.createDynamicsCompressor();
    setAt(this.limiter.threshold, -8, t0);
    setAt(this.limiter.knee, 6, t0);
    setAt(this.limiter.ratio, 12, t0);
    setAt(this.limiter.attack, 0.004, t0);
    setAt(this.limiter.release, 0.18, t0);
    this.limiter.connect(ac.destination);

    this.master = ac.createGain();
    setAt(this.master.gain, 0.0001, t0);
    this.master.connect(this.limiter);

    this.crowd = ac.createGain();
    this.field = ac.createGain();
    this.amb = ac.createGain();
    setAt(this.crowd.gain, 0.9, t0);
    setAt(this.field.gain, 1.0, t0);
    setAt(this.amb.gain, 0.8, t0);
    this.crowd.connect(this.master);
    this.field.connect(this.master);
    this.amb.connect(this.master);

    // Beds. Baked here, from a forked Rng, so two runs of the same seed produce
    // byte-identical PCM — the same determinism contract the renderer honours.
    const host = {
      sampleRate: ac.sampleRate,
      createBuffer: (c: number, n: number, sr: number) => ac.createBuffer(c, n, sr),
    };
    const wantVerb = b.reverb && typeof ac.createConvolver === 'function';
    this.beds = {
      white: bakeWhite(host, rng.fork(0x5e01), 2.0),
      pink: bakePink(host, rng.fork(0x5e02), 4.0),
      murmur: bakeMurmur(host, rng.fork(0x5e03), b.bedSeconds, tier === 'low' ? 28 : 56),
      applause: bakeApplause(host, rng.fork(0x5e04), b.bedSeconds * 0.75, tier === 'low' ? 150 : 300),
      impulse: wantVerb
        ? bakeImpulse(host, rng.fork(0x5e05), { rt60: b.rt60, predelay: 0.021, taps: 14 })
        : null,
    };

    this.verbIn = ac.createGain();
    this.verbOut = ac.createGain();
    setAt(this.verbIn.gain, 1, t0);
    setAt(this.verbOut.gain, 0.55, t0);
    this.verbOut.connect(this.master);

    if (this.beds.impulse) {
      const conv = ac.createConvolver();
      conv.normalize = true;
      conv.buffer = this.beds.impulse;
      // A little top off the send: the tail of a real bowl has no 8 kHz in it,
      // and convolving cymbal-bright transients into a 1.5 s tail is the fastest
      // way to make a reverb sound like a cheap plugin.
      const tilt = ac.createBiquadFilter();
      tilt.type = 'lowpass';
      setAt(tilt.frequency, 4200, t0);
      setAt(tilt.Q, 0.6, t0);
      this.verbIn.connect(tilt);
      tilt.connect(conv);
      conv.connect(this.verbOut);
      this.convolver = conv;
    } else {
      // No convolver: the send still exists so layers need no branch, it just
      // lands on a heavily damped copy rather than a tail.
      const damp = ac.createBiquadFilter();
      damp.type = 'lowpass';
      setAt(damp.frequency, 1400, t0);
      this.verbIn.connect(damp);
      damp.connect(this.verbOut);
      setAt(this.verbOut.gain, 0.12, t0);
    }
  }

  get now(): number { return num(this.ac.currentTime, 0); }

  /** Ramp the master in (or out) — used for the gesture fade-up and for mute. */
  setMaster(v: number, tau = 0.25): void {
    glideTo(this.master.gain, clamp(v, 0, 2), this.now, tau);
  }

  /* ---------------------------------------------------------------- sources */

  /** A looping bed source. Callers own the returned node's lifetime. */
  loop(buf: AudioBuffer, rate = 1, offset = 0): AudioBufferSourceNode {
    const s = this.ac.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    setAt(s.playbackRate, clamp(rate, 0.05, 16), this.now);
    const dur = num(buf.duration, 1);
    s.start(this.now, clamp(offset, 0, Math.max(0, dur - 0.01)));
    return s;
  }

  gain(v = 1): GainNode {
    const g = this.ac.createGain();
    setAt(g.gain, v, this.now);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.707, gainDb = 0): BiquadFilterNode {
    const f = this.ac.createBiquadFilter();
    f.type = type;
    const t = this.now;
    setAt(f.frequency, clamp(freq, 10, 20000), t);
    setAt(f.Q, clamp(q, 0.05, 40), t);
    if (gainDb !== 0) setAt(f.gain, clamp(gainDb, -40, 40), t);
    return f;
  }

  /** Stereo width control. Returns null where the node type is unavailable. */
  stereo(pan: number): StereoPannerNode | null {
    if (typeof this.ac.createStereoPanner !== 'function') return null;
    const p = this.ac.createStereoPanner();
    setAt(p.pan, clamp(pan, -1, 1), this.now);
    return p;
  }

  /** A world-space point source feeding the field stem plus a reverb send. */
  panner(x: number, y: number, z: number, o: PannerOpts = {}): PannerNode {
    const p = this.ac.createPanner();
    p.panningModel = this.budget.hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = o.ref ?? 3.5;
    p.rolloffFactor = o.rolloff ?? 1.15;
    p.maxDistance = o.max ?? 260;
    placePanner(p, x, y, z, this.now);
    return p;
  }

  /**
   * Route a voice's tail into the field stem and (optionally) the reverb.
   * The send is post-panner so a far-away footstep sends less than a near one,
   * which is backwards for a real room and exactly right for a game: it keeps
   * distant events from washing the mix.
   */
  toField(tail: AudioNode, verb = 0.18): void {
    tail.connect(this.field);
    if (verb > 0) {
      const s = this.gain(clamp(verb, 0, 1));
      tail.connect(s);
      s.connect(this.verbIn);
    }
  }

  /* ------------------------------------------------------------------ pool */

  get voiceCount(): number { return this.voices.length; }

  /**
   * Register a transient. Returns false when the pool is saturated by voices of
   * equal or higher priority, in which case the caller must not schedule — that
   * is the contract that keeps a 14-player sprint from spawning 200 nodes.
   */
  claim(prio: number): boolean {
    if (this.killed) return false;
    if (this.voices.length < this.budget.voices) return true;
    // Steal the cheapest thing that is already dying.
    let worst = -1;
    let worstScore = Infinity;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      const score = v.prio * 1000 + v.end;
      if (score < worstScore) { worstScore = score; worst = i; }
    }
    if (worst < 0 || this.voices[worst].prio > prio) return false;
    this.release(this.voices[worst], true);
    this.voices.splice(worst, 1);
    return true;
  }

  add(v: Voice): void {
    if (this.killed) { this.release(v, true); return; }
    this.voices.push(v);
  }

  /** Disconnect everything whose scheduled tail has passed. */
  reap(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      if (this.voices[i].end <= now) {
        this.release(this.voices[i], false);
        this.voices.splice(i, 1);
      }
    }
  }

  private release(v: Voice, early: boolean): void {
    const t = this.now;
    const drop = (): void => {
      for (const s of v.srcs) { try { s.disconnect(); } catch { /* ignore */ } }
      for (const n of v.nodes) { try { n.disconnect(); } catch { /* ignore */ } }
    };
    try {
      if (!early) {
        // The tail has already elapsed; nothing to fade.
        for (const s of v.srcs) { try { s.stop(t); } catch { /* already stopped */ } }
        drop();
        return;
      }
      // A stolen voice is still sounding. Never hard-stop it — a source cut at a
      // non-zero sample is a click, and a click is louder than the voice that
      // replaced it. Fade, stop just after, and only disconnect once the source
      // reports it has ended; disconnecting now would cut the fade dead.
      if (v.vca) {
        v.vca.gain.cancelScheduledValues(t);
        v.vca.gain.setValueAtTime(Math.max(AUDIO_EPS, num(v.vca.gain.value, AUDIO_EPS)), t);
        v.vca.gain.linearRampToValueAtTime(0, t + 0.012);
      }
      let pending = 0;
      for (const s of v.srcs) {
        try {
          s.stop(t + 0.014);
          pending++;
          s.onended = (): void => { if (--pending <= 0) drop(); };
        } catch { /* already stopped */ }
      }
      if (pending === 0) drop();
    } catch { /* a dead context must never take a frame down */ }
  }

  dispose(): void {
    this.killed = true;
    for (const v of this.voices) this.release(v, false);
    this.voices.length = 0;
    try { this.master.disconnect(); this.limiter.disconnect(); } catch { /* ignore */ }
  }
}
