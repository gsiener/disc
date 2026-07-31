/**
 * ULTIMATE — AudioParam automation helpers.
 *
 * Every parameter write in this subsystem goes through here. Two reasons, both
 * learned the hard way by anyone who has shipped WebAudio:
 *
 *  1. `exponentialRampToValueAtTime(0, t)` **throws**. So does any non-finite
 *     value, and so does a negative time. A gameplay value that momentarily
 *     goes NaN — a disc state mid-reset, a divide by a zero distance — would
 *     otherwise take the whole frame down from inside an audio callback path.
 *     Everything below clamps and guards, so a bad number produces a wrong
 *     sound rather than an exception.
 *  2. Envelopes want to read as intent (`percussive`, `swell`, `sweep`), not as
 *     four scheduling calls with the arithmetic inline at every call site.
 *
 * The floor `AUDIO_EPS` is -80 dB: inaudible, but strictly positive, which is
 * the only thing exponential ramps care about.
 */

/** Smallest value an exponential ramp may target. −80 dB. */
export const AUDIO_EPS = 1e-4;

/**
 * Finite-guards a number, substituting `fallback` for NaN/Infinity — and for
 * `undefined`/`null`, because every value reaching this subsystem is pulled off
 * an optional peer (`ctx.sys.game?.gs?.…`) or a loosely typed event payload, and
 * making each of ~40 call sites prove non-nullity is noise that hides the two
 * places where it actually matters.
 */
export function num(v: number | undefined | null, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function clamp(v: number | undefined | null, lo: number, hi: number): number {
  const x = num(v, lo);
  return x < lo ? lo : x > hi ? hi : x;
}

/** Positive, finite, and never below the exponential floor. */
export function pos(v: number | undefined | null, fallback = AUDIO_EPS): number {
  const x = num(v, fallback);
  return x < AUDIO_EPS ? AUDIO_EPS : x;
}

export function setAt(p: AudioParam, v: number, t: number): void {
  p.setValueAtTime(num(v), Math.max(0, num(t)));
}

export function linTo(p: AudioParam, v: number, t: number): void {
  p.linearRampToValueAtTime(num(v), Math.max(0, num(t)));
}

/** Exponential ramp with the zero-target trap removed. */
export function expTo(p: AudioParam, v: number, t: number): void {
  p.exponentialRampToValueAtTime(pos(v), Math.max(0, num(t)));
}

/** First-order approach — the cheap way to track a continuously moving target. */
export function glideTo(p: AudioParam, v: number, t: number, tau: number): void {
  p.setTargetAtTime(num(v), Math.max(0, num(t)), Math.max(0.001, num(tau, 0.05)));
}

export function cancel(p: AudioParam, t: number): void {
  p.cancelScheduledValues(Math.max(0, num(t)));
}

/**
 * Percussive envelope: silence → `peak` over `attack`, then an exponential fall
 * to silence over `decay`. Returns the time at which the voice may be stopped.
 *
 * The final `linearRampToValueAtTime(0)` after the exponential matters: an
 * exponential can only reach AUDIO_EPS, and stopping a source at -80 dB rather
 * than at true zero leaves a faint but perfectly audible click on every single
 * footstep in the game.
 */
export function percussive(
  p: AudioParam, t0: number, peak: number, attack: number, decay: number,
): number {
  const t = Math.max(0, num(t0));
  const a = Math.max(0.0005, num(attack, 0.002));
  const d = Math.max(0.005, num(decay, 0.1));
  const pk = clamp(peak, AUDIO_EPS, 8);
  p.cancelScheduledValues(t);
  p.setValueAtTime(AUDIO_EPS, t);
  p.exponentialRampToValueAtTime(pk, t + a);
  p.exponentialRampToValueAtTime(AUDIO_EPS, t + a + d);
  p.linearRampToValueAtTime(0, t + a + d + 0.004);
  return t + a + d + 0.004;
}

/**
 * Slow swell: rise over `attack`, hold at `peak` for `hold`, fall over `decay`.
 * A stadium roar is this shape — it is *not* a one-shot sample, which is why a
 * score cheer that fires and decays on a fixed curve always sounds canned.
 */
export function swell(
  p: AudioParam, t0: number, peak: number, attack: number, hold: number, decay: number,
): number {
  const t = Math.max(0, num(t0));
  const a = Math.max(0.01, num(attack, 0.3));
  const h = Math.max(0, num(hold, 0.3));
  const d = Math.max(0.05, num(decay, 2));
  const pk = clamp(peak, AUDIO_EPS, 8);
  p.cancelScheduledValues(t);
  p.setValueAtTime(AUDIO_EPS, t);
  p.linearRampToValueAtTime(pk, t + a);
  p.setValueAtTime(pk, t + a + h);
  p.exponentialRampToValueAtTime(AUDIO_EPS, t + a + h + d);
  p.linearRampToValueAtTime(0, t + a + h + d + 0.01);
  return t + a + h + d + 0.01;
}

/** Exponential glide between two frequencies — filter sweeps, sirens, scrapes. */
export function sweep(p: AudioParam, from: number, to: number, t0: number, dur: number): void {
  const t = Math.max(0, num(t0));
  p.cancelScheduledValues(t);
  p.setValueAtTime(pos(from, 200), t);
  p.exponentialRampToValueAtTime(pos(to, 200), t + Math.max(0.005, num(dur, 0.2)));
}

/** Fade a running voice out and report when it is safe to stop. */
export function fadeOut(p: AudioParam, t0: number, seconds = 0.06): number {
  const t = Math.max(0, num(t0));
  const d = Math.max(0.005, num(seconds, 0.06));
  p.cancelScheduledValues(t);
  // Hold whatever the param currently is, then take it down cleanly.
  p.setValueAtTime(Math.max(AUDIO_EPS, num(p.value, AUDIO_EPS)), t);
  p.exponentialRampToValueAtTime(AUDIO_EPS, t + d);
  p.linearRampToValueAtTime(0, t + d + 0.005);
  return t + d + 0.005;
}

/** Equal-power distance attenuation used for pre-cull level estimates. */
export function distanceGain(dist: number, ref = 6, rolloff = 1.1): number {
  const d = Math.max(ref, num(dist, ref));
  return ref / (ref + rolloff * (d - ref));
}
