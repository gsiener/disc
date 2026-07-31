/**
 * ULTIMATE — bodies.
 *
 * Everything a player makes: cleats, cuts, landings, layouts, breath and voice.
 * This is the layer that decides whether the pitch is occupied by athletes or by
 * animated meshes, and almost all of it is driven off events `src/sim/` already
 * emits — `player:footstep` carries foot, speed and a hardness flag, which is
 * three quarters of a footfall model handed over for free.
 *
 * A CLEAT ON GRASS is two events 10 ms apart, not one. The studs pierce first —
 * a bright, extremely short tick — and the sole then loads the turf, which is a
 * dull low thump with no attack to speak of. Synthesising only the bright half
 * gives you a hi-hat; only the dull half gives you a cardboard box. The ratio
 * between them is what `hard` moves: a hard plant is nearly all stud, a jog is
 * nearly all sole.
 *
 * A CUT is not a footstep. It is a scrape — the stud is being dragged sideways
 * through the sward for 100–200 ms while it decelerates, so it is a band sweeping
 * *down* under a slow envelope, and it is the single most recognisable sound in
 * field sport. Locomotion does not emit a cut event, so the layer watches the
 * `state` field on `ctx.sys.locomotion.players` and fires on the transition.
 *
 * BREATH is the intimacy control. It only exists for the nearest player, only
 * below 60% stamina, and it is the reason a close camera feels like a body.
 */

import type { Rng } from '../core/Ctx.ts';
import type { AudioGraph } from './Graph.ts';
import { CALLS, utter } from './Speech.ts';
import { clamp, percussive, setAt, sweep } from './Env.ts';

/** What a cutter shouts, and what the player covering them shouts back. */
const OFFENCE_CALLS = ['up', 'here', 'hey', 'open', 'go'];
const DEFENCE_CALLS = ['mark', 'go', 'hey'];

/** The subset of `LocoPlayer` this layer reads. Structural: no import needed. */
export interface BodyState {
  id: number;
  team: 0 | 1;
  pos: { x: number; y: number; z: number };
  state: string;
  stamina: number;
  cutEntrySpeed: number;
  attr: { height: number };
}

interface PerPlayer {
  lastState: string;
  /** Seconds until this player may shout again. */
  callCooldown: number;
  /** Base f0 for this player's voice, Hz. Fixed at first sight. */
  pitch: number;
}

export class BodyLayer {
  private lx = 0;
  private ly = 1.7;
  private lz = 0;
  private per = new Map<number, PerPlayer>();
  private globalCallCooldown = 2;
  private breathId = -1;
  private breathTimer = 0;

  private readonly g: AudioGraph;
  private readonly rng: Rng;

  constructor(g: AudioGraph, rng: Rng) {
    this.g = g;
    this.rng = rng;
  }

  setListener(x: number, y: number, z: number): void { this.lx = x; this.ly = y; this.lz = z; }

  private dist2(x: number, y: number, z: number): number {
    const dx = x - this.lx; const dy = y - this.ly; const dz = z - this.lz;
    return dx * dx + dy * dy + dz * dz;
  }

  /** True when a point is close enough to be worth a voice at this tier. */
  private audible(x: number, y: number, z: number): boolean {
    const c = this.g.budget.cull;
    return this.dist2(x, y, z) < c * c;
  }

  private point(x: number, y: number, z: number, verb: number, ref = 2.6): PannerNode {
    const p = this.g.panner(x, y, z, { ref, rolloff: 1.3 });
    this.g.toField(p, verb);
    return p;
  }

  private noise(): AudioBufferSourceNode {
    const s = this.g.ac.createBufferSource();
    s.buffer = this.g.beds.white;
    return s;
  }

  private noiseOffset(): number {
    return this.rng.range(0, Math.max(0.01, this.g.beds.white.duration - 0.5));
  }

  /* ------------------------------------------------------------- footsteps */

  /**
   * One footfall. `speed` in m/s, `hard` from the locomotion model's own plant
   * detection.
   */
  footstep(x: number, y: number, z: number, speed: number, hard: boolean, foot: 'L' | 'R'): void {
    if (!this.audible(x, y, z)) return;
    const g = this.g;
    if (!g.claim(1)) return;
    const t = g.now + 0.004;
    const v = clamp(speed, 0, 12) / 8;
    const h = hard ? 1 : 0.35;
    // A left and a right foot are never the same; a metronome of identical taps
    // is worse than no footsteps at all.
    const jitter = foot === 'L' ? 0.94 : 1.06;

    const p = this.point(x, Math.max(0.02, y), z, 0.10, 3.0);
    const mix = g.gain(1);
    mix.connect(p);

    // Sole load — dull, no attack.
    const n1 = this.noise();
    const lp = g.filter('lowpass', (210 + 130 * v) * jitter, 0.9);
    const g1 = g.gain(0.0001);
    n1.connect(lp); lp.connect(g1); g1.connect(mix);
    const e1 = percussive(g1.gain, t, (0.16 + 0.30 * v) * (1.15 - 0.35 * h), 0.006, 0.045 + 0.02 * v);
    n1.start(t, this.noiseOffset());
    n1.stop(e1 + 0.02);

    // Studs — bright, immediate, and the part that carries at distance.
    const n2 = this.noise();
    const bp = g.filter('bandpass', (1500 + 2100 * h + 500 * v) * jitter, 1.6 + 1.4 * h);
    const g2 = g.gain(0.0001);
    n2.connect(bp); bp.connect(g2); g2.connect(mix);
    sweep(bp.frequency, (2400 + 2600 * h) * jitter, (900 + 700 * h) * jitter, t, 0.03);
    const e2 = percussive(g2.gain, t, (0.06 + 0.30 * v) * h, 0.0012, 0.016 + 0.020 * h);
    n2.start(t, this.noiseOffset());
    n2.stop(e2 + 0.02);

    g.add({
      end: Math.max(e1, e2) + 0.02, prio: 1,
      srcs: [n1, n2], nodes: [lp, g1, bp, g2, mix, p], vca: mix,
    });
  }

  /** Studs dragged sideways through turf on a hard change of direction. */
  scuff(x: number, y: number, z: number, speed: number): void {
    if (!this.audible(x, y, z)) return;
    const g = this.g;
    if (!g.claim(2)) return;
    const t = g.now + 0.004;
    const v = clamp(speed, 1, 12) / 8;
    const dur = 0.10 + 0.10 * v;

    const p = this.point(x, Math.max(0.02, y), z, 0.14, 2.8);
    const mix = g.gain(1);
    mix.connect(p);

    const n = this.noise();
    const bp = g.filter('bandpass', 2400, 1.1);
    const vg = g.gain(0.0001);
    n.connect(bp); bp.connect(vg); vg.connect(mix);
    sweep(bp.frequency, 2200 + 1600 * v, 620, t, dur);
    // Slow attack: a scrape starts as the foot loads, it does not begin at peak.
    const end = percussive(vg.gain, t, 0.13 + 0.26 * v, 0.018, dur);
    n.start(t, this.noiseOffset());
    n.stop(end + 0.02);

    // The turf itself tearing — low, brief, under the scrape.
    const n2 = this.noise();
    const lp = g.filter('lowpass', 380, 0.8);
    const g2 = g.gain(0.0001);
    n2.connect(lp); lp.connect(g2); g2.connect(mix);
    const e2 = percussive(g2.gain, t, 0.10 + 0.18 * v, 0.01, dur * 0.7);
    n2.start(t, this.noiseOffset());
    n2.stop(e2 + 0.02);

    g.add({
      end: Math.max(end, e2) + 0.02, prio: 2,
      srcs: [n, n2], nodes: [bp, vg, lp, g2, mix, p], vca: mix,
    });
  }

  /* --------------------------------------------------------------- impacts */

  /**
   * A landing. `layout` turns it from a two-foot thump into a full-body impact
   * plus a slide, which is a completely different event and the loudest thing a
   * player does.
   */
  land(x: number, y: number, z: number, impact: number, layout: boolean): void {
    if (!this.audible(x, y, z)) return;
    const g = this.g;
    if (!g.claim(layout ? 5 : 2)) return;
    const ac = g.ac;
    const t = g.now + 0.004;
    const k = clamp(impact / 6, 0.15, 1.4);

    const p = this.point(x, Math.max(0.02, y), z, layout ? 0.22 : 0.12, 3.2);
    const mix = g.gain(1);
    mix.connect(p);
    const srcs: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [mix, p];
    let end = t;

    // Body mass into the ground. A layout is 80 kg arriving flat; the frequency
    // is low and the decay is long enough to feel like weight.
    const osc = ac.createOscillator();
    osc.type = 'sine';
    const f0 = layout ? 62 : 88;
    setAt(osc.frequency, f0 * 1.8, t);
    sweep(osc.frequency, f0 * 1.8, f0, t, layout ? 0.12 : 0.06);
    const og = g.gain(0.0001);
    osc.connect(og); og.connect(mix);
    const e0 = percussive(og.gain, t, (layout ? 0.55 : 0.26) * k, 0.003, layout ? 0.16 : 0.075);
    osc.start(t); osc.stop(e0 + 0.02);
    srcs.push(osc); nodes.push(og);
    end = Math.max(end, e0);

    // Turf compression — broad, dark, dead.
    const n1 = this.noise();
    const lp = g.filter('lowpass', layout ? 520 : 700, 0.8);
    const g1 = g.gain(0.0001);
    n1.connect(lp); lp.connect(g1); g1.connect(mix);
    const e1 = percussive(g1.gain, t, (layout ? 0.44 : 0.22) * k, 0.004, layout ? 0.13 : 0.06);
    n1.start(t, this.noiseOffset());
    n1.stop(e1 + 0.02);
    srcs.push(n1); nodes.push(lp, g1);
    end = Math.max(end, e1);

    if (layout) {
      // The slide. Half a second of grass hissing past a jersey, opening
      // slightly at the start as the body still has speed, then closing down.
      const n2 = this.noise();
      const bp = g.filter('bandpass', 1500, 0.8);
      const g2 = g.gain(0.0001);
      n2.connect(bp); bp.connect(g2); g2.connect(mix);
      const slide = 0.34 + 0.34 * k;
      sweep(bp.frequency, 1800, 340, t + 0.03, slide);
      g2.gain.cancelScheduledValues(t);
      g2.gain.setValueAtTime(0.0001, t);
      g2.gain.exponentialRampToValueAtTime(clamp(0.30 * k, 1e-4, 1), t + 0.06);
      g2.gain.exponentialRampToValueAtTime(1e-4, t + 0.06 + slide);
      g2.gain.linearRampToValueAtTime(0, t + 0.08 + slide);
      n2.start(t, this.noiseOffset());
      n2.stop(t + 0.10 + slide);
      srcs.push(n2); nodes.push(bp, g2);
      end = Math.max(end, t + 0.10 + slide);

      // Involuntary grunt on the way down.
      if (this.rng.next() < 0.7) {
        utter(g, t + 0.01, {
          f0: this.rng.range(112, 158),
          syllables: [{ vowel: 'a', dur: 0.16 + 0.1 * k, pitch: 1, onset: 0.25, level: 1 }],
          level: 0.30 * k,
          dest: mix,
          strain: 1,
        }, this.rng);
      }
    }

    g.add({ end: end + 0.03, prio: layout ? 5 : 2, srcs, nodes, vca: mix });
  }

  /** Two players colliding. Softer and duller than a landing — it is a jersey. */
  bump(x: number, y: number, z: number, impact: number): void {
    if (!this.audible(x, y, z)) return;
    const g = this.g;
    if (!g.claim(3)) return;
    const t = g.now + 0.004;
    const k = clamp(impact / 4, 0.1, 1.2);
    const p = this.point(x, y, z, 0.16, 3.0);
    const n = this.noise();
    const lp = g.filter('lowpass', 900, 0.7);
    const hp = g.filter('highpass', 120, 0.7);
    const vg = g.gain(0.0001);
    n.connect(hp); hp.connect(lp); lp.connect(vg); vg.connect(p);
    const end = percussive(vg.gain, t, 0.26 * k, 0.005, 0.09);
    n.start(t, this.noiseOffset());
    n.stop(end + 0.02);
    g.add({ end: end + 0.02, prio: 3, srcs: [n], nodes: [hp, lp, vg, p], vca: vg });
  }

  /* ----------------------------------------------------------- voice/breath */

  /** A shout for the disc. `name` indexes `Speech.CALLS`. */
  call(x: number, y: number, z: number, name: string, pitch: number, level = 1): void {
    if (!this.audible(x, y, z)) return;
    const g = this.g;
    const sy = CALLS[name] ?? CALLS.hey;
    const p = this.point(x, y + 0.55, z, 0.26, 3.6);
    const end = utter(g, g.now + 0.01, {
      f0: clamp(pitch, 80, 320),
      syllables: sy,
      level: 0.55 * clamp(level, 0, 2),
      dest: p,
      strain: 0.9,
    }, this.rng);
    if (end === 0) { try { p.disconnect(); } catch { /* ignore */ } }
  }

  /**
   * One breath cycle. Two halves with different filters: an inhale is a rising
   * hiss through a narrow band (air through a constricted throat) and an exhale
   * is a broader, falling one through an open mouth.
   */
  breath(x: number, y: number, z: number, effort: number, pitch: number): void {
    const g = this.g;
    if (!g.claim(2)) return;
    const t = g.now + 0.004;
    const e = clamp(effort, 0, 1);
    const p = this.point(x, y + 0.55, z, 0.10, 2.0);
    const mix = g.gain(1);
    mix.connect(p);

    const inDur = 0.20 - 0.07 * e;
    const outDur = 0.24 - 0.08 * e;

    const n1 = this.noise();
    const b1 = g.filter('bandpass', 620 * (pitch / 150), 1.9);
    const g1 = g.gain(0.0001);
    n1.connect(b1); b1.connect(g1); g1.connect(mix);
    sweep(b1.frequency, 480, 900 + 400 * e, t, inDur);
    g1.gain.setValueAtTime(0.0001, t);
    g1.gain.exponentialRampToValueAtTime(clamp(0.05 + 0.13 * e, 1e-4, 0.5), t + inDur * 0.7);
    g1.gain.exponentialRampToValueAtTime(1e-4, t + inDur);
    n1.start(t, this.noiseOffset());
    n1.stop(t + inDur + 0.02);

    const t2 = t + inDur + 0.04;
    const n2 = this.noise();
    const b2 = g.filter('bandpass', 720, 1.1);
    const g2 = g.gain(0.0001);
    n2.connect(b2); b2.connect(g2); g2.connect(mix);
    sweep(b2.frequency, 900 + 300 * e, 380, t2, outDur);
    g2.gain.setValueAtTime(0.0001, t2);
    g2.gain.exponentialRampToValueAtTime(clamp(0.07 + 0.19 * e, 1e-4, 0.6), t2 + 0.03);
    g2.gain.exponentialRampToValueAtTime(1e-4, t2 + outDur);
    g2.gain.linearRampToValueAtTime(0, t2 + outDur + 0.01);
    n2.start(t2, this.noiseOffset());
    n2.stop(t2 + outDur + 0.03);

    g.add({
      end: t2 + outDur + 0.05, prio: 2,
      srcs: [n1, n2], nodes: [b1, g1, b2, g2, mix, p], vca: mix,
    });
  }

  /* ------------------------------------------------------------ per-frame */

  /**
   * Watches the locomotion roster for things that are states rather than
   * events: cuts, exhaustion, and the urge to shout for the disc.
   *
   * `discCarrier` is the id holding the disc (or -1); a cutter only calls when
   * somebody actually has it to give.
   */
  update(dt: number, players: readonly BodyState[], discCarrier: number, live: boolean): void {
    const d = clamp(dt, 0, 0.25);
    this.globalCallCooldown -= d;
    this.breathTimer -= d;

    let nearest = -1;
    let nearestD2 = Infinity;
    const carrier = players.find((q) => q.id === discCarrier);
    const attackingTeam = carrier ? carrier.team : -1;

    for (const p of players) {
      let s = this.per.get(p.id);
      if (!s) {
        // Taller players speak lower. It is a crude proxy and it works.
        const h = clamp(p.attr?.height ?? 1.83, 1.5, 2.2);
        s = {
          lastState: p.state,
          callCooldown: this.rng.range(0, 8),
          pitch: 205 - 62 * ((h - 1.6) / 0.5) + this.rng.range(-14, 14),
        };
        this.per.set(p.id, s);
      }
      s.callCooldown -= d;

      const x = p.pos.x; const y = p.pos.y; const z = p.pos.z;

      if (p.state !== s.lastState) {
        if (p.state === 'cut') this.scuff(x, y - 0.9, z, p.cutEntrySpeed || 6);
        s.lastState = p.state;
      }

      const dd = this.dist2(x, y, z);
      if (dd < nearestD2) { nearestD2 = dd; nearest = p.id; }

      // Calls: an open cutter, close enough to be heard, on a cooldown, with a
      // deterministic coin toss so the pitch is not a conversation.
      if (live && s.callCooldown <= 0 && this.globalCallCooldown <= 0
        && p.id !== discCarrier && discCarrier >= 0
        && (p.state === 'sprint' || p.state === 'cut')
        && dd < 42 * 42 && this.rng.next() < 0.22) {
        s.callCooldown = this.rng.range(6, 16);
        this.globalCallCooldown = this.rng.range(1.4, 3.6);
        // A cutter shouts for the disc; the defender on them shouts "mark".
        const vocab = p.team === attackingTeam ? OFFENCE_CALLS : DEFENCE_CALLS;
        this.call(x, y, z, this.rng.pick(vocab), s.pitch, 0.9);
      }
    }

    // Breath belongs to whoever the camera is standing next to.
    if (nearest >= 0 && nearestD2 < 11 * 11) {
      const p = players.find((q) => q.id === nearest);
      const st = p ? this.per.get(p.id) : undefined;
      if (p && st) {
        const fatigue = clamp(1 - p.stamina / 100, 0, 1);
        if (fatigue > 0.35) {
          if (this.breathId !== p.id) { this.breathId = p.id; this.breathTimer = 0.2; }
          if (this.breathTimer <= 0) {
            // 14 breaths/min at rest, 42 flat out.
            this.breathTimer = clamp(4.3 - 3.0 * fatigue, 1.1, 4.3) * this.rng.range(0.85, 1.15);
            this.breath(p.pos.x, p.pos.y, p.pos.z, fatigue, st.pitch);
          }
        }
      }
    }
  }

  dispose(): void { this.per.clear(); }
}
