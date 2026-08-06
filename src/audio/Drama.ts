/**
 * ULTIMATE — the broadcast director.
 *
 * `Crowd.ts` knows how to make eight thousand people sound like eight thousand
 * people. It does not know anything about Ultimate. This file is the part that
 * watches the match and decides what those people are doing, and it exists as a
 * separate object for one reason: a crowd that only reacts to events is a crowd
 * that is always late.
 *
 * The four things a real crowd does that an event handler cannot:
 *
 *  1. IT SWELLS BEFORE THE CATCH. From the moment a huck leaves the hand the
 *     noise climbs, and it peaks *on* the catch — not a beat after it, which is
 *     what you get when the only input is a `disc:caught` event. So a throw arms
 *     an anticipation model that tracks the disc closing on the nearest body,
 *     and the catch reaction is then scaled by whatever that model had reached.
 *     A tap pass to the dump arms almost nothing; a 45 m huck to a streaking
 *     cutter arms all of it.
 *
 *  2. IT GROANS EARLY. A crowd knows a throwaway is a throwaway while the disc
 *     is still four metres up, because the nearest defender is eight metres away
 *     and the disc is going down. `disc:grounded` fires half a second later,
 *     which is exactly half a second too late to sound like a stadium. So the
 *     descent is watched, and when the outcome becomes arithmetically obvious
 *     the groan starts and the anticipation collapses.
 *
 *  3. IT GOES QUIET. Not "less excited" — quiet. A stall count past six is the
 *     tensest thing in the sport and the stands stop talking to watch it, which
 *     means the model has to be able to push the mix *below* its resting level
 *     and then let go all at once when the throw finally goes.
 *
 *  4. IT GASPS. A layout is not a cheer; it is a sharp intake while nobody yet
 *     knows whether the bid came off. It fires on the *takeoff* — the frame the
 *     locomotion state becomes `layout` — not on the landing.
 *
 * Everything here is a plain number updated once per rendered frame. Nothing
 * allocates, nothing schedules, and every input is optional: a missing peer
 * degrades to a crowd that only reacts, which is what this file replaced.
 */

import type { CrowdLayer } from './Crowd.ts';
import { clamp, num } from './Env.ts';

/** The subset of a locomotion player this director reads. Structural. */
export interface DramaBody {
  id: number;
  team: number;
  pos: { x: number; y: number; z: number };
  state: string;
}

/** One frame of match state, assembled by `Audio.ts` and thrown away. */
export interface DramaFrame {
  phase: string;
  /** 0..10. Only meaningful in LIVE_POSSESSION. */
  stall: number;
  stallMax: number;
  inFlight: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Ground height under the disc, metres. */
  groundY: number;
  players: readonly DramaBody[] | undefined;
}

/** Between-points wash per phase. 1 is a full house talking to itself. */
const PHASE_CHATTER: Record<string, number> = {
  PRE_PULL: 0.90,
  PULL_IN_FLIGHT: 0.42,
  LIVE_POSSESSION: 0.16,
  DISC_IN_FLIGHT: 0.12,
  TURNOVER_DEAD: 0.72,
  CHECK: 0.55,
  POINT_SCORED: 1.00,
  TIMEOUT: 1.00,
  HALFTIME: 1.00,
  GAME_OVER: 0.85,
};

/** How a catch is being taken. Decides which reaction and how big. */
export type CatchKind = 'plain' | 'big' | 'pull' | 'interception' | 'goal';

/**
 * How long after a takeoff an outcome still counts as belonging to that bid.
 * A layout is airborne for about half a second; anything the disc does inside
 * three quarters of one is the thing the body left the ground for.
 */
const BID_WINDOW = 0.75;

export class DramaDirector {
  /* continuous outputs */
  private antic = 0;
  private hush = 0;
  private chat = 0.2;

  /* flight tracking */
  private armed = false;
  /** How much this particular throw is worth getting excited about, 0..1.15. */
  private hype = 0;
  private flightT = 0;
  private deadT = 0;
  private preGroaned = false;
  /** Metres from the disc to the nearest body. Diagnostics. */
  private near = 99;

  /** Players currently airborne on a bid, so a gasp fires once per layout. */
  private laidOut = new Set<number>();
  /** Seconds since the last takeoff. Large means no bid is in the air. */
  private sinceBid = 99;
  /** Did the bid in the air actually produce something? */
  private bidPaid = false;

  private readonly crowd: CrowdLayer;

  constructor(crowd: CrowdLayer) {
    this.crowd = crowd;
  }

  /* ---------------------------------------------------------------- events */

  /**
   * A throw left a hand. `speed` m/s, `stall` the count it went at.
   *
   * The stall break is the whole reason the count is passed in: a disc released
   * at stall 8 is a release of tension, and the crowd noise that follows is not
   * a reaction to the throw's quality — it is the sound of everyone breathing
   * out. It is scaled by how far the count had climbed and it fires *whatever*
   * the throw turns out to be.
   */
  release(speed: number, stall: number, isPull: boolean): void {
    const s = clamp(speed, 0, 45);
    this.armed = true;
    this.flightT = 0;
    this.deadT = 0;
    this.preGroaned = false;
    this.near = 99;
    // A 10 m/s dump is worth nothing; a 28 m/s huck is worth everything.
    this.hype = isPull ? 0.52 : clamp(0.10 + (s - 9) / 22, 0.08, 1.15);

    const c = clamp(stall, 0, 12);
    if (c >= 6) this.crowd.addSurge(0.16 + 0.11 * (c - 5), 1.5, 0.82);
    // The hush ends the instant the disc goes, not on a slew.
    this.hush = 0;

    if (s > 19) this.crowd.react('huck', clamp((s - 19) / 10, 0.3, 1.2));
  }

  /**
   * Somebody caught it. Returns nothing; the caller still owns the disc sounds.
   * The reaction is scaled by the anticipation the flight had built, which is
   * what puts the peak of the noise on the catch instead of behind it.
   */
  caught(kind: CatchKind, airborne: boolean): void {
    const a = this.antic;
    this.disarm();
    if (this.sinceBid < BID_WINDOW) this.bidPaid = true;
    if (kind === 'goal') return;                    // `score` owns that roar
    // A build that came to nothing still has to pay out, so the payoff is
    // superlinear in `a` rather than a flat bonus.
    const boost = 1 + 1.25 * a;
    if (kind === 'interception') this.crowd.react('interception', boost);
    else if (kind === 'pull') this.crowd.react('catch', 0.6 + 0.5 * a);
    else this.crowd.react(airborne ? 'bigCatch' : 'catch', boost);
  }

  /** The disc reached the turf. The groan may already have started. */
  grounded(): void { this.disarm(); }

  /**
   * A defender knocked it down. The caller still owns the reaction; what the
   * director takes from it is that any bid currently in the air has been paid,
   * so the landing that follows is a full stop and not a second event.
   */
  blocked(): void {
    this.disarm();
    if (this.sinceBid < BID_WINDOW) this.bidPaid = true;
  }

  /**
   * A body that laid out has arrived.
   *
   * The crowd noise for a bid is almost entirely *front*-loaded: the gasp goes
   * on the takeoff and the payoff goes on the block or the catch, both of which
   * have already fired by the time anyone hits the ground. What the landing adds
   * depends entirely on whether the bid came off, and getting that wrong is what
   * made a bid at nothing as loud as a block:
   *
   *  - it worked — the stands are already up, and the landing is the exclamation
   *    mark on a reaction that is still ringing;
   *  - it did not — a full-length dive that comes up empty gets an "ohhh", which
   *    is warm and mid-valence and is emphatically not a cheer.
   */
  layoutLanded(): void {
    if (this.bidPaid) this.crowd.react('layout', 0.45);
    else this.crowd.addSurge(0.22, 1.6, 0.44);
    this.bidPaid = false;
    this.sinceBid = 99;
  }

  /**
   * A turnover was registered. Returns the scale the caller should use, so a
   * groan that has already begun deepens as the disc lands rather than firing
   * a second time at full size.
   */
  turnoverScale(): number { return this.preGroaned ? 0.55 : 1; }

  /** A point was scored. Kills any residual build. */
  scored(): void {
    this.disarm();
    this.hush = 0;
  }

  setPhase(phase: string): void {
    // Anything that is not live play cannot have a throw in the air.
    if (phase !== 'DISC_IN_FLIGHT' && phase !== 'PULL_IN_FLIGHT') this.disarm();
  }

  private disarm(): void {
    this.armed = false;
    this.hype = 0;
    this.flightT = 0;
    this.deadT = 0;
  }

  /* ------------------------------------------------------------- per frame */

  update(dt: number, f: DramaFrame): void {
    const d = clamp(dt, 0, 0.25);

    /* --- conversation between points ------------------------------------ */
    const chatTarget = PHASE_CHATTER[f.phase] ?? 0.18;
    this.chat += (chatTarget - this.chat) * (1 - Math.exp(-d / 1.3));

    /* --- the hush --------------------------------------------------------
     * Gated on LIVE_POSSESSION: the stall count is a live number that does not
     * always clear the instant a throw goes, and a crowd that stayed silent
     * into the next possession would read as a bug rather than as tension. */
    const max = Math.max(4, num(f.stallMax, 10));
    let h = 0;
    if (f.phase === 'LIVE_POSSESSION') {
      const c = clamp(f.stall, 0, max);
      // Full tension one count BEFORE the stall-out, not on it. The old ramp
      // only reached 1 at `max`, and `max` is the count at which the disc
      // changes hands — so the deepest hush in the model was a state the match
      // left the same instant it arrived, and the quietest the stands ever
      // actually got was 0.66. The tensest moment in Ultimate is the count
      // before the turnover, and this is the curve that says so.
      if (c >= max - 5) h = clamp((c - (max - 5)) / 4, 0, 1);
    }
    if (f.phase === 'CHECK') h = Math.max(h, 0.40);
    if (f.phase === 'PRE_PULL') h = Math.max(h, 0.12);
    // Falls silent slowly, comes back fast — the same asymmetry as the roar,
    // in the other direction. Slowly is about a second; the old 0.55 s tau was
    // measured never reaching its own target across a whole stall.
    this.hush += (h - this.hush) * (1 - Math.exp(-d / (h > this.hush ? 0.40 : 0.20)));

    /* --- anticipation ---------------------------------------------------- */
    if (this.armed && f.inFlight) {
      this.deadT = 0;
      this.flightT += d;
      const nd = this.nearestBody(f);
      this.near = nd;

      // Closing on a body is the shape of the swell; hang time is the floor
      // under it, so a floaty huck with nobody near it still builds.
      const close = clamp(1 - (nd - 1.4) / 17, 0, 1);
      const hang = clamp(this.flightT / 2.4, 0, 1);
      const build = clamp(0.22 + 0.62 * close * close + 0.34 * hang, 0, 1.25);
      const target = this.hype * build;
      this.antic += (target - this.antic) * (1 - Math.exp(-d / 0.18));

      // The moment the drop becomes obvious: going down, low, and nobody near.
      if (!this.preGroaned && this.flightT > 0.30 && f.vy < -1.5) {
        const fall = f.y - f.groundY;
        if (fall > 0 && fall / -f.vy < 0.42 && nd > 2.8) {
          this.crowd.react('preDrop');
          this.preGroaned = true;
          this.hype *= 0.12;               // the swell collapses, it does not fade
        }
      }
    } else {
      if (this.armed) {
        // One frame of `inFlight === false` is a race with the disc system, not
        // the end of a throw. A third of a second of it is the end of a throw.
        this.deadT += d;
        if (this.deadT > 0.35) this.disarm();
      }
      this.antic += (0 - this.antic) * (1 - Math.exp(-d / 0.42));
      if (this.antic < 1e-4) this.antic = 0;
    }

    /* --- bids ------------------------------------------------------------ */
    if (this.sinceBid < 90) this.sinceBid += d;
    this.watchBids(f.players);

    this.crowd.setDrama(this.antic, this.hush, this.chat);
  }

  /** Squared-distance scan, no allocation, 14 bodies. */
  private nearestBody(f: DramaFrame): number {
    const ps = f.players;
    if (!ps || ps.length === 0) return 99;
    let best = Infinity;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const q = p.pos;
      if (!q) continue;
      const dx = num(q.x) - f.x;
      // Hands go up: a disc 2 m over a player's hips is a catchable disc, so
      // the vertical term is discounted rather than counted straight.
      const dy = (num(q.y) - f.y) * 0.45;
      const dz = num(q.z) - f.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    return best === Infinity ? 99 : Math.sqrt(best);
  }

  /**
   * A gasp on the frame a body leaves the ground for a bid — not on the landing,
   * which is where `player:land` fires and which is a quarter of a second after
   * the stadium has already made the noise.
   */
  private watchBids(ps: readonly DramaBody[] | undefined): void {
    if (!ps || ps.length === 0) { if (this.laidOut.size) this.laidOut.clear(); return; }
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const out = p.state === 'layout';
      const was = this.laidOut.has(p.id);
      if (out && !was) {
        this.laidOut.add(p.id);
        this.sinceBid = 0;
        this.bidPaid = false;
        // Bigger gasp if it is a bid at a disc that was already exciting.
        this.crowd.gasp(0.65 + 0.55 * clamp(this.antic, 0, 1));
      } else if (!out && was && p.state !== 'landing' && p.state !== 'recovery') {
        this.laidOut.delete(p.id);
      }
    }
  }

  /** Diagnostics for `tools/test-audio.ts`. */
  debug(): {
    antic: number; hush: number; chat: number; hype: number; near: number;
    pre: boolean; bid: number; paid: boolean;
  } {
    return {
      antic: num(this.antic), hush: num(this.hush), chat: num(this.chat),
      hype: num(this.hype), near: num(this.near), pre: this.preGroaned,
      bid: num(this.sinceBid), paid: this.bidPaid,
    };
  }

  dispose(): void { this.laidOut.clear(); }
}
