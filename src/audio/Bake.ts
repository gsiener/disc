/**
 * ULTIMATE — deterministic PCM baking.
 *
 * Everything the audio layer plays back is generated here, from `ctx.rand`, at
 * boot. Same zero-asset rule as the rest of the project: no files, no fetches,
 * no base64. What a sample player would call "the sound library" is four
 * procedurally baked buffers plus a handful of oscillators.
 *
 * `src/util/Noise.ts` is the project's noise authority, but it is a 2-D/3-D
 * texture-space library — `valueNoise2`, `worley2`, `fbm2`. There is no 1-D
 * sample-stream equivalent and no audio DSP anywhere in the tree, so the biquad
 * and the shaping below live here. They take an `Rng`, never `Math.random`, so
 * two runs of the same seed bake byte-identical buffers.
 *
 * Why bake loops at all rather than synthesise per-voice: a stadium crowd is
 * thousands of uncorrelated sources. Reproducing that with live nodes costs
 * thousands of nodes; reproducing it as a few seconds of pre-shaped texture that
 * we then *filter and envelope* in real time costs four. The realtime layer is
 * where the game state lives; the bake is where the density lives.
 */

import type { Rng } from '../core/Ctx.ts';

/* ------------------------------------------------------------------ biquad */

type BiquadKind = 'lowpass' | 'highpass' | 'bandpass' | 'peaking';

/**
 * RBJ cookbook biquad, transposed direct form II. Used only during baking —
 * realtime filtering is done by the graph's own BiquadFilterNodes.
 */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  constructor(kind: BiquadKind, freq: number, q: number, sampleRate: number, gainDb = 0) {
    const f = Math.min(Math.max(freq, 10), sampleRate * 0.45);
    const w0 = (2 * Math.PI * f) / sampleRate;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const alpha = sw / (2 * Math.max(0.05, q));
    let b0 = 1; let b1 = 0; let b2 = 0; let a0 = 1; let a1 = 0; let a2 = 0;

    switch (kind) {
      case 'lowpass':
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'bandpass':
        b0 = alpha; b1 = 0; b2 = -alpha;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'peaking': {
        const A = Math.pow(10, gainDb / 40);
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
        break;
      }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  /** In-place over a whole channel. */
  run(data: Float32Array): Float32Array {
    for (let i = 0; i < data.length; i++) data[i] = this.process(data[i]);
    return data;
  }
}

/* ------------------------------------------------------------------ noise */

/** Uniform white, [-1, 1). Cheapest source; flat spectrum is what we want. */
export function whiteNoise(rng: Rng, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rng.next() * 2 - 1;
  return out;
}

/**
 * Paul Kellet's economical pink filter (-3 dB/octave). Wind, distant traffic and
 * room tone all sit closer to pink than to white; white reads as tape hiss.
 */
export function pinkNoise(rng: Rng, n: number): Float32Array {
  const out = new Float32Array(n);
  let b0 = 0; let b1 = 0; let b2 = 0; let b3 = 0; let b4 = 0; let b5 = 0; let b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

/* --------------------------------------------------------------- shaping */

/** Peak-normalise in place to `peak`. No-op on silence. */
export function normalise(data: Float32Array, peak = 0.98): Float32Array {
  let m = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > m) m = a; }
  if (m < 1e-9 || !Number.isFinite(m)) return data;
  const k = peak / m;
  for (let i = 0; i < data.length; i++) data[i] *= k;
  return data;
}

/**
 * Folds a tail of length `fade` back over the head so the buffer loops without
 * a click. `src` must be `n + fade` samples long; the result is `n`.
 *
 * Equal-power (sin/cos) rather than linear, because two uncorrelated noise
 * streams crossfaded linearly lose 3 dB in the middle of the fade — which is
 * audible on a continuous bed as a periodic dip at exactly the loop period, the
 * single most recognisable "this is a loop" artefact there is.
 */
export function loopFold(src: Float32Array, n: number, fade: number): Float32Array {
  const out = new Float32Array(n);
  out.set(src.subarray(0, n));
  const f = Math.min(fade, n);
  for (let i = 0; i < f; i++) {
    const x = (i / f) * Math.PI * 0.5;
    out[i] = src[n + i] * Math.cos(x) + src[i] * Math.sin(x);
  }
  return out;
}

/** Raised-cosine window on [0,1]; 0 at the ends, 1 in the middle. */
function hann(x: number): number {
  if (x <= 0 || x >= 1) return 0;
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * x);
}

/* -------------------------------------------------------------- the bakes */

export interface BakeHost {
  sampleRate: number;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
}

/** Plain white noise loop — the workhorse behind footsteps, whooshes, impacts. */
export function bakeWhite(host: BakeHost, rng: Rng, seconds: number): AudioBuffer {
  const sr = host.sampleRate;
  const n = Math.max(2, Math.round(seconds * sr));
  const fade = Math.round(0.05 * sr);
  const buf = host.createBuffer(1, n, sr);
  // Normalise *after* the fold: the equal-power crossfade sums two uncorrelated
  // streams and can reach 1.41, and a source buffer that leaves headroom to the
  // caller is the only kind worth having.
  buf.getChannelData(0).set(normalise(loopFold(whiteNoise(rng, n + fade), n, fade), 0.98));
  return buf;
}

/** Stereo pink loop with decorrelated channels — wind, room tone. */
export function bakePink(host: BakeHost, rng: Rng, seconds: number): AudioBuffer {
  const sr = host.sampleRate;
  const n = Math.max(2, Math.round(seconds * sr));
  const fade = Math.round(0.12 * sr);
  const buf = host.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const raw = pinkNoise(rng.fork(0x91d + c * 7), n + fade);
    buf.getChannelData(c).set(normalise(loopFold(raw, n, fade), 0.9));
  }
  return buf;
}

/**
 * The crowd murmur bed.
 *
 * A stand full of people talking is not noise — it is a few hundred voiced
 * bursts a second, each with a syllabic envelope, summed. Filtered white alone
 * reads as air conditioning; it is the 3–6 Hz syllable rate that makes an ear
 * hear "people". So: broadband source through a voice-shaped filter stack,
 * multiplied by a control-rate envelope that is the sum of `voices` independent
 * syllable trains.
 */
export function bakeMurmur(host: BakeHost, rng: Rng, seconds: number, voices = 48): AudioBuffer {
  const sr = host.sampleRate;
  const n = Math.max(2, Math.round(seconds * sr));
  const fade = Math.round(0.35 * sr);
  const total = n + fade;
  const buf = host.createBuffer(2, n, sr);

  const CR = 240;                                   // envelope control rate, Hz
  const envN = Math.ceil((total / sr) * CR) + 2;

  for (let c = 0; c < 2; c++) {
    const r = rng.fork(0x4d17 + c * 131);

    // Syllable envelope: `voices` overlapping trains, each a different rate.
    const env = new Float32Array(envN);
    for (let v = 0; v < voices; v++) {
      const period = r.range(0.16, 0.38);           // 2.6–6.3 syllables/s
      const duty = r.range(0.42, 0.78);
      const level = r.range(0.35, 1.0);
      let t = r.range(0, period);
      while (t < total / sr) {
        const w = period * duty;
        const i0 = Math.floor(t * CR);
        const i1 = Math.min(envN, Math.ceil((t + w) * CR));
        for (let i = i0; i < i1; i++) env[i] += level * hann((i / CR - t) / w);
        t += period * r.range(0.75, 1.45);
      }
    }
    let em = 0;
    for (let i = 0; i < envN; i++) if (env[i] > em) em = env[i];
    const ek = em > 1e-6 ? 1 / em : 1;
    for (let i = 0; i < envN; i++) env[i] = 0.34 + 0.66 * (env[i] * ek);

    // Source: white through a vocal-ish stack. 480 Hz body, 1.5 kHz presence,
    // hard roll-off above 3 kHz — a crowd 40 m away has no top end left.
    const raw = whiteNoise(r, total);
    new Biquad('peaking', 480, 0.85, sr, 7).run(raw);
    new Biquad('peaking', 1500, 1.1, sr, 3).run(raw);
    new Biquad('highpass', 110, 0.7, sr).run(raw);
    new Biquad('lowpass', 3200, 0.6, sr).run(raw);

    for (let i = 0; i < total; i++) {
      const e = (i * CR) / sr;
      const i0 = Math.floor(e);
      const fr = e - i0;
      const a = env[i0] * (1 - fr) + env[Math.min(envN - 1, i0 + 1)] * fr;
      raw[i] *= a;
    }
    buf.getChannelData(c).set(normalise(loopFold(raw, n, fade), 0.85));
  }
  return buf;
}

/**
 * Applause texture — a Poisson-ish rain of hand claps.
 *
 * Held at a *constant* density; the realtime layer gates it with an envelope,
 * so the same buffer serves a polite ripple and a full-house roar. Each clap is
 * a 3–7 ms noise burst through a bright resonance, which is what a pair of
 * cupped hands actually is.
 */
export function bakeApplause(host: BakeHost, rng: Rng, seconds: number, rate = 260): AudioBuffer {
  const sr = host.sampleRate;
  const n = Math.max(2, Math.round(seconds * sr));
  const fade = Math.round(0.10 * sr);
  const total = n + fade;
  const buf = host.createBuffer(2, n, sr);

  for (let c = 0; c < 2; c++) {
    const r = rng.fork(0x0c1a + c * 977);
    const out = new Float32Array(total);
    const noise = whiteNoise(r, 2048);
    let t = 0;
    while (t < total / sr) {
      const i0 = Math.floor(t * sr);
      const decay = r.range(0.0022, 0.0075);
      const amp = r.range(0.25, 1.0);
      const len = Math.min(total - i0, Math.ceil(decay * 6 * sr));
      const off = r.int(0, 1024);
      for (let i = 0; i < len; i++) {
        out[i0 + i] += noise[(off + i) & 2047] * amp * Math.exp(-i / (decay * sr));
      }
      // Exponential inter-arrival keeps it from sounding metronomic.
      t += -Math.log(Math.max(1e-6, r.next())) / rate;
    }
    new Biquad('highpass', 700, 0.7, sr).run(out);
    new Biquad('peaking', 2400, 1.0, sr, 5).run(out);
    new Biquad('lowpass', 7000, 0.7, sr).run(out);
    buf.getChannelData(c).set(normalise(loopFold(out, n, fade), 0.8));
  }
  return buf;
}

export interface ImpulseOpts {
  /** RT60 in seconds. An open bowl is short and slappy, not a cathedral. */
  rt60: number;
  /** Direct-to-first-reflection gap, seconds. Sets apparent size. */
  predelay: number;
  /** Discrete early reflections before the tail takes over. */
  taps: number;
}

/**
 * Stadium impulse response, generated rather than recorded.
 *
 * Three ingredients, in the order an ear resolves them:
 *  1. a predelay gap — how far the first wall is;
 *  2. discrete early reflections at path lengths taken from the actual bowl
 *     (side stands ~24 m, roof ~27 m, far stand ~60 m, end stands ~90 m), each
 *     with a small inter-aural offset so the room has width;
 *  3. a diffuse tail: noise under an exponential decay whose *brightness* also
 *     decays, because air and seated bodies absorb treble far faster than bass.
 *     Skipping that second decay is what makes synthetic reverb sound like a
 *     spring: bright, flat and metallic all the way down.
 */
export function bakeImpulse(host: BakeHost, rng: Rng, o: ImpulseOpts): AudioBuffer {
  const sr = host.sampleRate;
  const seconds = Math.max(0.15, o.rt60 * 1.08);
  const n = Math.max(4, Math.round(seconds * sr));
  const buf = host.createBuffer(2, n, sr);
  const decayK = 6.907 / Math.max(0.05, o.rt60);        // ln(1000)

  // Path lengths in metres for the bowl described in src/world/Stadium.ts.
  const PATHS = [24, 27, 33, 48, 60, 74, 90, 118];

  for (let c = 0; c < 2; c++) {
    const r = rng.fork(0x1e3b + c * 613);
    const data = buf.getChannelData(c);

    // Diffuse tail with a time-varying one-pole lowpass.
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const cutoff = 380 + 9000 * Math.exp(-t / Math.max(0.08, o.rt60 * 0.45));
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
      lp += a * ((r.next() * 2 - 1) - lp);
      // The first 30 ms of a real tail builds rather than starts at full level.
      const build = Math.min(1, t / 0.03);
      data[i] = lp * Math.exp(-decayK * t) * build * 0.55;
    }

    // Early reflections on top, alternating polarity (a reflection off a hard
    // surface at grazing incidence flips; alternating them decorrelates the
    // comb structure and stops the IR ringing on one note).
    const taps = Math.max(2, o.taps);
    for (let k = 0; k < taps; k++) {
      const path = PATHS[k % PATHS.length] * (1 + 0.06 * r.gauss());
      const t = o.predelay + path / 343 + (c === 0 ? 0 : r.range(0.0002, 0.0011));
      const i0 = Math.round(t * sr);
      if (i0 >= n - 4) continue;
      const amp = (k % 2 === 0 ? 1 : -1) * (5.5 / path) * Math.exp(-decayK * t) * r.range(0.6, 1.0);
      // Smear each tap over ~1 ms so it is a reflection off a stand full of
      // people, not a click off a mirror.
      const w = Math.max(2, Math.round(0.0011 * sr));
      for (let i = 0; i < w && i0 + i < n; i++) data[i0 + i] += amp * hann(i / w);
    }
    normalise(data, 0.92);
  }
  return buf;
}
