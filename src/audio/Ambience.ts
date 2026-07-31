/**
 * ULTIMATE — air, tannoy, horn.
 *
 * The layer nobody notices and everybody would notice the absence of. Three
 * pieces:
 *
 *  WIND. Two bands off one pink source. The low band is the bulk air movement —
 *  broad, dull, and the thing that actually tracks the simulated wind vector's
 *  magnitude. The high band is edge tone: the whistle air makes past the net,
 *  the rails and the camera itself. Edge tone scales with the *square* of speed
 *  and appears much later than the low band, which is why a real gust announces
 *  itself as a rising hiss rather than as a level change. Gusts come from a
 *  deterministic wander on top of the sim's steady vector, not from the vector
 *  itself, because `src/sim/Game.ts` sets that once and never moves it.
 *
 *  PA. Formant speech, band-limited to a horn-loaded 400–2500 Hz box, drenched
 *  in the stadium IR and sat well down in the mix. It fires on scores and
 *  otherwise on a long, deterministic timer. It must never be intelligible: an
 *  intelligible announcer is a line of dialogue and gets old in ninety seconds,
 *  whereas an unintelligible one is architecture.
 *
 *  HORN. A goal horn is a detuned unison of squared-off tones with a slow
 *  attack, a hard body and a bloom of reverb; the detuning is what makes it
 *  sound like a big electro-pneumatic device rather than a synth patch.
 */

import type { Rng } from '../core/Ctx.ts';
import type { AudioGraph } from './Graph.ts';
import { CALLS, utter, type Syllable } from './Speech.ts';
import { clamp, glideTo, setAt, swell } from './Env.ts';

export class AmbienceLayer {
  private lowGain: GainNode;
  private lowLp: BiquadFilterNode;
  private edgeGain: GainNode;
  private edgeBp: BiquadFilterNode;
  private src: AudioBufferSourceNode;

  /** Metres/second, smoothed, including the synthetic gust. */
  private speed = 0;
  private gustPhase = 0;
  private gustPhase2 = 0;
  private paTimer = 26;

  private readonly g: AudioGraph;
  private readonly rng: Rng;

  // NB: no TypeScript parameter properties anywhere in this subsystem.
  // `node tools/test-audio.ts` runs these modules through Node's strip-only
  // type removal, which rejects them outright.
  constructor(g: AudioGraph, rng: Rng) {
    this.g = g;
    this.rng = rng;
    this.src = g.loop(g.beds.pink, 1, rng.range(0, g.beds.pink.duration));

    this.lowLp = g.filter('lowpass', 320, 0.6);
    this.lowGain = g.gain(0.0001);
    this.src.connect(this.lowLp);
    this.lowLp.connect(this.lowGain);
    this.lowGain.connect(g.amb);

    this.edgeBp = g.filter('bandpass', 1100, 1.1);
    this.edgeGain = g.gain(0.0001);
    this.src.connect(this.edgeBp);
    this.edgeBp.connect(this.edgeGain);
    this.edgeGain.connect(g.amb);

    this.gustPhase = rng.range(0, Math.PI * 2);
    this.gustPhase2 = rng.range(0, Math.PI * 2);
  }

  /**
   * `wx`,`wz` is the simulated wind vector in m/s. The gust is layered here so
   * the sim keeps a single steady vector for the flight model while the ear
   * still hears weather.
   */
  update(dt: number, wx: number, wz: number): void {
    const d = clamp(dt, 0, 0.25);
    this.gustPhase += d * 0.21;
    this.gustPhase2 += d * 0.073;

    const steady = Math.hypot(clamp(wx, -30, 30), clamp(wz, -30, 30));
    // Two incommensurate sines: never repeats inside a shot, costs two cosines.
    const gust = 0.55 + 0.45 * Math.sin(this.gustPhase) * Math.sin(this.gustPhase2 * 2.7);
    const target = steady * (0.55 + 0.9 * gust) + 0.35;
    this.speed += (target - this.speed) * (1 - Math.exp(-d / 0.9));

    const s = clamp(this.speed, 0, 22);
    const k = s / 12;
    const t = this.g.now;

    glideTo(this.lowGain.gain, 0.020 + 0.115 * Math.min(1.3, k), t, 0.5);
    glideTo(this.lowLp.frequency, 210 + 620 * Math.min(1.4, k), t, 0.7);
    // Edge tone is quadratic and only shows up once there is real air moving.
    const edge = Math.max(0, k - 0.28);
    glideTo(this.edgeGain.gain, 0.055 * edge * edge, t, 0.4);
    glideTo(this.edgeBp.frequency, 820 + 1500 * Math.min(1.5, k), t, 0.6);

    this.paTimer -= d;
    if (this.paTimer <= 0) {
      this.paTimer = this.rng.range(38, 82);
      this.announce(this.rng.int(4, 8));
    }
  }

  /** Wind speed the mix is currently hearing — the disc layer ducks against it. */
  get windSpeed(): number { return this.speed; }

  /**
   * A burst of tannoy. `n` syllables of drifting vowels; the content is
   * deliberately meaningless.
   */
  announce(n: number, level = 0.055): void {
    const g = this.g;
    const rng = this.rng;
    const vowels = ['a', 'e', 'i', 'o', 'u'] as const;
    const sy: Syllable[] = [];
    for (let i = 0; i < Math.max(1, Math.min(12, n)); i++) {
      sy.push({
        vowel: rng.pick(vowels),
        dur: rng.range(0.10, 0.21),
        pitch: rng.range(0.86, 1.18),
        onset: rng.next() < 0.45 ? rng.range(0.2, 0.7) : 0,
        level: rng.range(0.7, 1),
      });
    }
    utter(g, g.now + 0.02, {
      f0: rng.range(104, 128),
      syllables: sy,
      level,
      dest: g.amb,
      // A horn-loaded PA cabinet is a bandpass with a very tight box.
      band: [400, 2500],
      verb: 0.85,
      strain: 0.25,
    }, rng);
  }

  /**
   * Goal horn. Two blasts, three detuned partials, plenty of tail.
   * Node count is ~9 for a shade under three seconds; worth it once a point.
   */
  horn(): void {
    const g = this.g;
    if (!g.claim(6)) return;
    const ac = g.ac;
    const t0 = g.now + 0.05;

    const vca = g.gain(0.0001);
    const body = g.filter('lowpass', 2600, 0.9);
    const bite = g.filter('peaking', 780, 1.1, 7);
    vca.connect(bite); bite.connect(body); body.connect(g.amb);
    const send = g.gain(0.6);
    body.connect(send); send.connect(g.verbIn);

    const srcs: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [vca, body, bite, send];

    // A pneumatic horn is a fundamental plus a fifth plus an octave, all
    // slightly out with each other — the beating is the character.
    const partials: [number, number][] = [[1, 0.55], [1.5, 0.30], [2.005, 0.18], [2.98, 0.09]];
    for (const [mul, amp] of partials) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      setAt(o.frequency, 138 * mul * (1 + this.rng.range(-0.004, 0.004)), t0);
      const og = g.gain(amp);
      o.connect(og); og.connect(vca);
      o.start(t0);
      srcs.push(o);
      nodes.push(og);
    }

    // Blast one, gap, blast two — the second longer than the first.
    let end = swell(vca.gain, t0, 0.42, 0.05, 0.42, 0.22);
    const t2 = end + 0.10;
    end = swell(vca.gain, t2, 0.46, 0.05, 0.72, 0.55);
    for (const s of srcs) s.stop(end + 0.05);

    g.add({ end: end + 0.12, prio: 6, srcs, nodes, vca });
  }

  /** A short crowd-facing call from the announcer, used on a score. */
  announceGoal(): void {
    this.announce(this.rng.int(5, 9), 0.075);
  }

  /** Exposed so the player layer can reuse the vocabulary. */
  static readonly CALLS = CALLS;

  dispose(): void {
    try { this.src.stop(); this.src.disconnect(); } catch { /* ignore */ }
    this.lowGain.disconnect(); this.lowLp.disconnect();
    this.edgeGain.disconnect(); this.edgeBp.disconnect();
  }
}
