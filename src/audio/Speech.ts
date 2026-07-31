/**
 * ULTIMATE — formant speech, for the two places a game needs a voice.
 *
 * A player yelling "up!" and a tannoy two hundred metres away are the same
 * instrument at different settings: a glottal buzz through two or three
 * resonances, gated by a syllable envelope, with a noise burst at the front for
 * the consonant. Nobody is meant to make out words — what carries at a distance
 * is the *pitch contour and the formant motion*, which is why a filtered noise
 * blip reads as a bird and this reads as a person.
 *
 * Two formants, not five. F1 and F2 alone place a vowel unambiguously; F3 and
 * up only carry speaker identity, and at the level these sit in the mix nobody
 * would hear them. That halves the node count per utterance, which matters when
 * fourteen players can all call at once.
 */

import type { Rng } from '../core/Ctx.ts';
import type { AudioGraph } from './Graph.ts';
import { clamp, percussive, setAt, sweep } from './Env.ts';

/** [F1, F2] in Hz. The five cardinal vowels are enough for a shout. */
export const VOWELS = {
  a: [730, 1090],
  e: [530, 1840],
  i: [270, 2290],
  o: [570, 840],
  u: [325, 700],
} as const;

export type Vowel = keyof typeof VOWELS;

export interface Syllable {
  vowel: Vowel;
  /** Seconds. */
  dur: number;
  /** Multiplies the utterance's base pitch. */
  pitch: number;
  /** 0 = voiced onset, 1 = a hard fricative/plosive burst in front. */
  onset: number;
  level: number;
}

export interface UtteranceOpts {
  /** Base f0 in Hz. Male shout ~150, female ~230, tannoy ~120. */
  f0: number;
  syllables: Syllable[];
  /** Peak linear gain of the whole utterance. */
  level: number;
  /** Destination. Everything is summed into this node. */
  dest: AudioNode;
  /** Extra send into the stadium reverb, 0..1. */
  verb?: number;
  /** Band-limit the whole thing — a tannoy is a 400–2800 Hz box. */
  band?: [number, number];
  /** Rough duty-cycle roughness; a shout is a strained, buzzy source. */
  strain?: number;
}

/** Prebuilt calls. Nothing is spelled — these are pitch-and-vowel gestures. */
export const CALLS: Record<string, Syllable[]> = {
  // "up!" — closed vowel, hard stop, rising then cut.
  up: [{ vowel: 'u', dur: 0.16, pitch: 1.14, onset: 0.15, level: 1 }],
  // "here!" — the classic, long and falling.
  here: [{ vowel: 'i', dur: 0.10, pitch: 1.22, onset: 0.55, level: 0.9 },
         { vowel: 'e', dur: 0.22, pitch: 0.96, onset: 0, level: 1 }],
  // "hey!" — bright, two-part diphthong.
  hey: [{ vowel: 'e', dur: 0.13, pitch: 1.10, onset: 0.5, level: 1 },
        { vowel: 'i', dur: 0.14, pitch: 1.30, onset: 0, level: 0.8 }],
  // "I'm open" — three beats, falling.
  open: [{ vowel: 'a', dur: 0.11, pitch: 1.05, onset: 0.1, level: 0.85 },
         { vowel: 'o', dur: 0.13, pitch: 1.15, onset: 0.35, level: 1 },
         { vowel: 'e', dur: 0.15, pitch: 0.92, onset: 0, level: 0.75 }],
  // "go!" — one hard bark.
  go: [{ vowel: 'o', dur: 0.19, pitch: 1.20, onset: 0.3, level: 1 }],
  // a defender's "mark!"
  mark: [{ vowel: 'a', dur: 0.21, pitch: 1.02, onset: 0.25, level: 1 }],
};

/** Every call in the vocabulary. `Body.ts` picks per-role subsets of these. */
export const CALL_NAMES = Object.keys(CALLS);

/**
 * Schedule one utterance. Returns the context time at which it is silent, or 0
 * if the pool refused it.
 *
 * Node count: 1 osc + 2 bandpass + 2 formant gains + 1 VCA (+ 1 noise source and
 * 1 highpass when any syllable has an onset) — seven to nine, all transient.
 */
export function utter(g: AudioGraph, t0: number, o: UtteranceOpts, rng: Rng): number {
  const sy = o.syllables;
  if (!sy || sy.length === 0) return 0;
  if (!g.claim(2)) return 0;

  const ac = g.ac;
  const strain = clamp(o.strain ?? 0.5, 0, 1);

  // `sum` is the utterance's mouth: the voiced chain arrives through `vca`, the
  // consonant bursts arrive with their own envelopes, and both then share one
  // band-limiting stage and one send.
  const sum = g.gain(1);
  const vca = g.gain(0.0001);
  vca.connect(sum);
  const nodes: AudioNode[] = [vca, sum];
  const srcs: AudioScheduledSourceNode[] = [];

  // Band-limiting stage. Also stops the sawtooth's raw top end from sounding
  // like a synth lead instead of a throat.
  let tail: AudioNode = sum;
  if (o.band) {
    const hp = g.filter('highpass', o.band[0], 0.7);
    const lp = g.filter('lowpass', o.band[1], 0.7);
    sum.connect(hp); hp.connect(lp);
    nodes.push(hp, lp);
    tail = lp;
  }
  tail.connect(o.dest);
  if (o.verb && o.verb > 0) {
    const s = g.gain(o.verb);
    tail.connect(s); s.connect(g.verbIn);
    nodes.push(s);
  }

  // Glottal source: a sawtooth is a crude but honest approximation of the
  // pulse train a larynx makes, and its 1/n harmonic roll-off is what lets the
  // formant filters actually have something to resonate on.
  const osc = ac.createOscillator();
  osc.type = 'sawtooth';
  srcs.push(osc);

  const f1 = g.filter('bandpass', VOWELS[sy[0].vowel][0], 4 + 4 * strain);
  const f2 = g.filter('bandpass', VOWELS[sy[0].vowel][1], 6 + 4 * strain);
  const g1 = g.gain(1.0);
  const g2 = g.gain(0.45);
  osc.connect(f1); f1.connect(g1); g1.connect(vca);
  osc.connect(f2); f2.connect(g2); g2.connect(vca);
  nodes.push(f1, f2, g1, g2);

  let t = t0;
  const base = clamp(o.f0, 60, 500);
  setAt(osc.frequency, base * sy[0].pitch, t);

  for (let i = 0; i < sy.length; i++) {
    const s = sy[i];
    const dur = clamp(s.dur, 0.03, 1.2);
    const [a, b] = VOWELS[s.vowel];
    const nextP = base * clamp(s.pitch, 0.4, 2.4);

    // Formants glide rather than jump — an instant formant change is a click and
    // reads as two different voices rather than one mouth moving.
    sweep(f1.frequency, i === 0 ? a : VOWELS[sy[i - 1].vowel][0], a, t, Math.min(0.05, dur * 0.4));
    sweep(f2.frequency, i === 0 ? b : VOWELS[sy[i - 1].vowel][1], b, t, Math.min(0.06, dur * 0.45));
    sweep(osc.frequency, i === 0 ? nextP : base * sy[i - 1].pitch, nextP, t, dur * 0.35);
    // A shout falls at the end of every syllable. Without this it is a robot.
    sweep(osc.frequency, nextP, nextP * (0.90 - 0.06 * strain), t + dur * 0.45, dur * 0.5);

    const lvl = clamp(o.level * s.level, 0.0001, 4);
    if (i === 0) {
      vca.gain.cancelScheduledValues(t);
      vca.gain.setValueAtTime(0.0001, t);
    }
    // Attack, hold, release — kept strictly ordered in time. Scheduling a hold
    // that lands before the attack it follows is legal but reorders the whole
    // automation timeline, and the syllable then plays backwards.
    const atk = Math.min(0.035, dur * 0.3);
    const hold = Math.max(atk + 0.002, dur * 0.62);
    vca.gain.exponentialRampToValueAtTime(lvl, t + atk);
    vca.gain.setValueAtTime(lvl, t + hold);
    vca.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(hold + 0.004, dur));

    // Consonant: a short bright noise burst in front of the vowel.
    if (s.onset > 0.02 && g.claim(1)) {
      const ns = ac.createBufferSource();
      ns.buffer = g.beds.white;
      const off = rng.range(0, Math.max(0.01, g.beds.white.duration - 0.2));
      const bp = g.filter('bandpass', 1600 + 2600 * s.onset, 1.2);
      const ng = g.gain(0.0001);
      ns.connect(bp); bp.connect(ng); ng.connect(sum);
      const burst = 0.012 + 0.030 * s.onset;
      const endN = percussive(ng.gain, Math.max(0, t - burst), lvl * 0.5 * s.onset, 0.004, burst);
      ns.start(Math.max(0, t - burst), off);
      ns.stop(endN + 0.02);
      srcs.push(ns);
      nodes.push(bp, ng);
    }

    t += dur;
  }

  vca.gain.linearRampToValueAtTime(0, t + 0.02);
  osc.start(t0);
  osc.stop(t + 0.05);

  const end = t + 0.08;
  g.add({ end, prio: 2, srcs, nodes, vca });
  return end;
}
