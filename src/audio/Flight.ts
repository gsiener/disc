/**
 * ULTIMATE — the disc.
 *
 * A 175 g disc makes four sounds and they are all worth modelling separately.
 *
 *  FLIGHT is one persistent voice, never re-created per throw: a noise band
 *  whose centre frequency and level track `DiscState.airspeed`, amplitude-
 *  modulated at the rotation rate. That modulation is the whole trick. Broadband
 *  noise scaled by speed is a jet; the same noise pulsed twice per revolution is
 *  unmistakably a spinning disc, because the rim alternately presents its
 *  leading and trailing edge to the air. The AM rate therefore comes off
 *  `state.spin`, in rad/s, converted to Hz and doubled — around 14 Hz for an
 *  ordinary backhand, which is exactly where it flutters rather than buzzes.
 *
 *  CATCH is a pancake: palm thud, plastic click, brief ring. Three components
 *  with three different decays, because a single filtered click reads as a
 *  woodblock.
 *
 *  RIM GRAZE is the sound of a catch that did not close — fingertips skidding
 *  across the rim. A bright band sweeping *down* as the contact loses speed.
 *
 *  GROUND is dull and short: turf absorbs almost everything above 1 kHz, so the
 *  landing is a low slap plus a resonant "bock" from the shell, and nothing else.
 *
 * DOPPLER is applied by hand. `PannerNode` dropped `dopplerFactor` years ago and
 * nothing replaced it, so a disc crossing the camera at 25 m/s is otherwise a
 * static hiss that merely gets louder — the one cue that says *this thing is
 * moving past me* is missing. The shift is computed from the radial component of
 * the disc's velocity about the listener and applied to the band centres and to
 * the flutter rate, which is where an ear reads it; the noise source itself is
 * left alone, because pitching broadband noise does nothing audible. The factor
 * is exaggerated over the physical one for the same reason every broadcast mix
 * exaggerates it: at 343 m/s a real 25 m/s pass is a 7% shift and reads as
 * nothing on a laptop speaker.
 */

import type { Rng } from '../core/Ctx.ts';
import type { AudioGraph } from './Graph.ts';
import { clamp, glideTo, percussive, setAt, sweep } from './Env.ts';
import { placePanner } from './Graph.ts';

export interface DiscObservation {
  x: number; y: number; z: number;
  /** World velocity, m/s. Optional: absent means no doppler, not a crash. */
  vx?: number; vy?: number; vz?: number;
  /** m/s relative to the air. */
  airspeed: number;
  /** rad/s about the disc normal, signed. */
  spin: number;
  inFlight: boolean;
}

/**
 * Speed of sound, m/s, and the cheat factor applied to the radial velocity
 * before the shift is computed. 2.6 puts a 22 m/s flypast at about a fifth of
 * an octave, which is where it starts to read as movement rather than as drift.
 */
const C_AIR = 343;
const DOPPLER_EXAGGERATION = 2.6;

/**
 * Per-throw character for the release snap. `tilt` moves the whole band, `q`
 * decides how much of it is a click rather than a chuff, `decay` is the length
 * of the contact and `level` is how much of the body goes into it.
 */
const RELEASE: Record<string, { tilt: number; q: number; decay: number; level: number }> = {
  forehand: { tilt: 1.32, q: 2.3, decay: 0.048, level: 1.06 },
  backhand: { tilt: 1.00, q: 1.5, decay: 0.075, level: 1.00 },
  push:     { tilt: 1.14, q: 1.9, decay: 0.055, level: 0.82 },
  hammer:   { tilt: 0.74, q: 0.9, decay: 0.135, level: 0.90 },
  scoober:  { tilt: 0.80, q: 1.0, decay: 0.120, level: 0.86 },
  blade:    { tilt: 1.22, q: 2.0, decay: 0.060, level: 0.95 },
  pull:     { tilt: 0.94, q: 1.7, decay: 0.095, level: 1.30 },
  throw:    { tilt: 1.00, q: 1.5, decay: 0.075, level: 1.00 },
  raw:      { tilt: 1.00, q: 1.5, decay: 0.075, level: 1.00 },
};

export class FlightLayer {
  private src: AudioBufferSourceNode;
  private bp: BiquadFilterNode;
  private hp: BiquadFilterNode;
  private vca: GainNode;
  private panner: PannerNode;
  private am: OscillatorNode;
  private amDepth: GainNode;

  /** Last observed speed — the impact sounds are scaled by it. */
  private speed = 0;
  private pos: [number, number, number] = [0, 1, 0];
  /** Listener position, for the radial-velocity term. */
  private lx = 0; private ly = 1.7; private lz = 0;
  /** Last frequency multiplier applied. 1 = no relative motion. */
  private dop = 1;

  private readonly g: AudioGraph;
  private readonly rng: Rng;

  constructor(g: AudioGraph, rng: Rng) {
    this.g = g;
    this.rng = rng;
    const t = g.now;
    this.src = g.loop(g.beds.white, 1, rng.range(0, g.beds.white.duration));
    this.hp = g.filter('highpass', 320, 0.7);
    this.bp = g.filter('bandpass', 900, 1.6);
    this.vca = g.gain(0.0001);
    // Touchline law (see Graph.TOUCHLINE): the disc is the hero object of the
    // sport and it must be audible from the tele camera, which a physical
    // distance model puts 27 dB under the crowd.
    this.panner = g.panner(0, 1.2, 0);

    this.src.connect(this.hp);
    this.hp.connect(this.bp);
    this.bp.connect(this.vca);
    this.vca.connect(this.panner);
    g.toField(this.panner, 0.12);

    // Rotational AM. Rides on the VCA's own gain so it scales with level.
    this.am = g.ac.createOscillator();
    this.am.type = 'sine';
    setAt(this.am.frequency, 12, t);
    this.amDepth = g.gain(0);
    this.am.connect(this.amDepth);
    this.amDepth.connect(this.vca.gain);
    this.am.start(t);
  }

  /** Where the camera is. Only used for the doppler term. */
  setListener(x: number, y: number, z: number): void {
    this.lx = x; this.ly = y; this.lz = z;
  }

  /**
   * Frequency multiplier from the disc's motion relative to the listener.
   * Positive radial velocity is receding, which lowers the pitch.
   */
  private doppler(o: DiscObservation): number {
    const vx = o.vx; const vy = o.vy; const vz = o.vz;
    if (vx === undefined || vy === undefined || vz === undefined) return 1;
    const dx = o.x - this.lx; const dy = o.y - this.ly; const dz = o.z - this.lz;
    const d = Math.hypot(dx, dy, dz);
    // Inside a couple of metres the radial direction spins through 180° in a
    // single frame and the shift becomes a scream. Fade it out instead.
    if (!Number.isFinite(d) || d < 2) return 1;
    const vr = (vx * dx + vy * dy + vz * dz) / d;
    const k = DOPPLER_EXAGGERATION * clamp(vr, -40, 40);
    return clamp(C_AIR / (C_AIR + k), 0.72, 1.38);
  }

  /** Called every rendered frame with the current disc state. */
  update(_dt: number, o: DiscObservation): void {
    const t = this.g.now;
    const v = clamp(o.airspeed, 0, 45);
    this.speed = v;
    this.pos = [o.x, o.y, o.z];

    placePanner(this.panner, o.x, o.y, o.z, t, 0.02);

    if (!o.inFlight || v < 0.6) {
      glideTo(this.vca.gain, 0.0001, t, 0.06);
      glideTo(this.amDepth.gain, 0, t, 0.08);
      this.dop = 1;
      return;
    }

    const dop = this.doppler(o);
    this.dop = dop;

    // Level goes as roughly v^2 (aeroacoustic noise is a power law well above
    // linear), normalised so a 22 m/s huck sits at unity.
    const k = v / 22;
    glideTo(this.vca.gain, clamp(0.30 * k * k, 0.0001, 0.9), t, 0.05);
    glideTo(this.bp.frequency, clamp((420 + 118 * v) * dop, 200, 6000), t, 0.06);
    glideTo(this.hp.frequency, clamp((220 + 26 * v) * dop, 120, 2200), t, 0.08);
    glideTo(this.bp.Q, clamp(2.6 - 0.045 * v, 0.9, 3.0), t, 0.1);

    // Two rim passes per revolution — the flutter carries the shift far more
    // legibly than the band does, because it is a rate rather than a timbre.
    const hz = clamp((Math.abs(o.spin) / (Math.PI * 2)) * 2 * dop, 3, 90);
    glideTo(this.am.frequency, hz, t, 0.07);
    // The flutter is deep at low speed and washes out into hiss at high speed.
    glideTo(this.amDepth.gain, clamp(0.30 * k * k * (1 - 0.45 * Math.min(1, k)), 0, 0.5), t, 0.1);
  }

  /* --------------------------------------------------------------- impacts */

  private point(x: number, y: number, z: number, verb: number): PannerNode {
    const p = this.g.panner(x, y, z);
    this.g.toField(p, verb);
    return p;
  }

  /**
   * A throw leaving the hand — the rim's snap off the fingers.
   *
   * `kind` is the `throwType` off `disc:released`, and it is not decoration. A
   * forehand is a wrist flick: the rim leaves two fingers over a couple of
   * centimetres, so the snap is short, high and hard. A backhand peels off a
   * whole hand across the width of the disc, which is longer, broader and much
   * less clicky. An overhead has almost no rim contact at all — what you hear is
   * the arm, so it reads as a whoosh rather than a snap. A pull is a backhand
   * with everything behind it and it is the loudest single contact in the sport.
   */
  release(x: number, y: number, z: number, power: number, kind = 'backhand'): void {
    const g = this.g;
    if (!g.claim(3)) return;
    const t = g.now + 0.005;
    const w = RELEASE[kind] ?? RELEASE.backhand;
    const pw = clamp(power, 0, 1);
    const p = this.point(x, y, z, 0.14);
    const bp = g.filter('bandpass', (1900 + 1400 * pw) * w.tilt, w.q);
    const vca = g.gain(0.0001);
    const s = g.ac.createBufferSource();
    s.buffer = g.beds.white;
    s.connect(bp); bp.connect(vca); vca.connect(p);
    sweep(bp.frequency, (3200 + 1800 * pw) * w.tilt, 900 * w.tilt, t, w.decay);
    const end = percussive(vca.gain, t, (0.30 + 0.35 * pw) * w.level, 0.003, w.decay);
    s.start(t, this.rng.range(0, Math.max(0.01, g.beds.white.duration - 0.3)));
    s.stop(end + 0.02);
    g.add({ end: end + 0.03, prio: 3, srcs: [s], nodes: [bp, vca, p], vca });
  }

  /**
   * A clean hand catch. `hard` raises the click and shortens everything —
   * a one-hand grab in traffic is a crack, a chest-high pancake is a thump.
   */
  catch(x: number, y: number, z: number, hard = 0.5): void {
    const g = this.g;
    if (!g.claim(4)) return;
    const ac = g.ac;
    const t = g.now + 0.005;
    const h = clamp(hard, 0, 1);
    const p = this.point(x, y, z, 0.16);
    const mix = g.gain(1);
    mix.connect(p);

    const nodes: AudioNode[] = [p, mix];
    const srcs: AudioScheduledSourceNode[] = [];

    // 1. Palm — a damped low sine. This is the mass of the hand, not the disc.
    const osc = ac.createOscillator();
    osc.type = 'sine';
    setAt(osc.frequency, 168 + 60 * h, t);
    sweep(osc.frequency, 168 + 60 * h, 96, t, 0.07);
    const og = g.gain(0.0001);
    osc.connect(og); og.connect(mix);
    const e1 = percussive(og.gain, t, 0.42 + 0.2 * h, 0.002, 0.055 + 0.03 * (1 - h));
    osc.start(t); osc.stop(e1 + 0.02);
    srcs.push(osc); nodes.push(og);

    // 2. Click + ring — the shell. Bandpass on the noise, resonant enough to
    //    hold a pitch for 60 ms, which is what "plastic" means to an ear.
    const ns = ac.createBufferSource();
    ns.buffer = g.beds.white;
    const bp = g.filter('bandpass', 1400 + 1500 * h, 2.4 + 2 * h);
    const ng = g.gain(0.0001);
    ns.connect(bp); bp.connect(ng); ng.connect(mix);
    sweep(bp.frequency, 2600 + 1800 * h, 1150, t, 0.05);
    const e2 = percussive(ng.gain, t, 0.30 + 0.30 * h, 0.0015, 0.045 + 0.05 * h);
    ns.start(t, this.rng.range(0, Math.max(0.01, g.beds.white.duration - 0.3)));
    ns.stop(e2 + 0.02);
    srcs.push(ns); nodes.push(bp, ng);

    g.add({ end: Math.max(e1, e2) + 0.04, prio: 4, srcs, nodes, vca: mix });
  }

  /** Fingertips skidding across the rim — a catch that did not close. */
  graze(x: number, y: number, z: number, strength = 0.6): void {
    const g = this.g;
    if (!g.claim(3)) return;
    const t = g.now + 0.005;
    const s = clamp(strength, 0, 1);
    const p = this.point(x, y, z, 0.2);
    const src = g.ac.createBufferSource();
    src.buffer = g.beds.white;
    const bp = g.filter('bandpass', 4200, 3.2);
    const vca = g.gain(0.0001);
    src.connect(bp); bp.connect(vca); vca.connect(p);
    // Down-sweep: the contact loses relative speed as it skids.
    sweep(bp.frequency, 4600 + 1500 * s, 1500, t, 0.10 + 0.05 * s);
    const end = percussive(vca.gain, t, 0.20 + 0.24 * s, 0.004, 0.11 + 0.06 * s);
    src.start(t, this.rng.range(0, Math.max(0.01, g.beds.white.duration - 0.4)));
    src.stop(end + 0.02);
    g.add({ end: end + 0.03, prio: 3, srcs: [src], nodes: [bp, vca, p], vca });
  }

  /** Flat slap of a disc hitting turf. Loudness from the last observed speed. */
  ground(x: number, y: number, z: number): void {
    const g = this.g;
    if (!g.claim(3)) return;
    const ac = g.ac;
    const t = g.now + 0.005;
    const k = clamp(this.speed / 16, 0.12, 1.2);
    const p = this.point(x, y, z, 0.1);
    const mix = g.gain(1);
    mix.connect(p);

    // Turf: broadband, immediately dead.
    const ns = ac.createBufferSource();
    ns.buffer = g.beds.white;
    const lp = g.filter('lowpass', 760, 0.8);
    const ng = g.gain(0.0001);
    ns.connect(lp); lp.connect(ng); ng.connect(mix);
    const e1 = percussive(ng.gain, t, 0.34 * k, 0.002, 0.07);
    ns.start(t, this.rng.range(0, Math.max(0.01, g.beds.white.duration - 0.3)));
    ns.stop(e1 + 0.02);

    // Shell: a short resonance, the "bock" of a hollow dome on grass.
    const osc = ac.createOscillator();
    osc.type = 'triangle';
    setAt(osc.frequency, 232, t);
    sweep(osc.frequency, 232, 150, t, 0.09);
    const og = g.gain(0.0001);
    osc.connect(og); og.connect(mix);
    const e2 = percussive(og.gain, t, 0.20 * k, 0.002, 0.10);
    osc.start(t); osc.stop(e2 + 0.02);

    g.add({
      end: Math.max(e1, e2) + 0.03, prio: 3,
      srcs: [ns, osc], nodes: [lp, ng, og, p, mix], vca: mix,
    });
  }

  /** Where the disc was last seen — used when an event carries no position. */
  get lastPos(): [number, number, number] { return this.pos; }
  get lastSpeed(): number { return this.speed; }
  /** Last doppler multiplier. 1 when the disc is still or has no velocity. */
  get lastDoppler(): number { return this.dop; }

  dispose(): void {
    try { this.src.stop(); this.am.stop(); } catch { /* ignore */ }
    for (const n of [this.src, this.hp, this.bp, this.vca, this.panner, this.am, this.amDepth]) {
      try { (n as AudioNode).disconnect(); } catch { /* ignore */ }
    }
  }
}
