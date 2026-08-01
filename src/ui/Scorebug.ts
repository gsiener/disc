/**
 * The scorebug.
 *
 * Laid out the way a current broadcast package lays one out, and for the same
 * reasons:
 *
 *  - **One bar, sectioned by hairlines**, not a grid of boxes. The eye scans it
 *    left to right once and stops.
 *  - **Team colour as a 3 px chip, never a fill.** The art-direction brief caps
 *    everything but the kits and the disc under 50 % saturation; a bug with two
 *    saturated cells would out-shout the athletes it is describing.
 *  - **Possession is a disc glyph, not a highlight.** It is the sport's own
 *    object, it reads at thumbnail size, and it costs one element.
 *  - **Tabular lining numerals throughout**, so 9 → 10 does not shove the
 *    timeout pips sideways and the stall count does not shuffle its neighbours.
 *  - **The stall count is an arc gauge.** It is the one number a viewer reads in
 *    peripheral vision while watching the disc, so it gets shape as well as
 *    value: the ring fills, shifts amber at 7, and goes hot at 9 with a pulse on
 *    every tick.
 *
 *    Seven is not a round number, it is the *dump count* — the point at which
 *    the reset stops being an option and becomes the plan, and the same count
 *    at which the gameplay layer starts bracketing the reset handler. The two
 *    marks fire together on purpose: the bug shifts in the corner of your eye
 *    and the answer appears on the field in the same frame. Amber for "bail
 *    now", red for "you are out of time".
 *
 * Motion is driven from sim time (see `Dom.ts`), never CSS transitions, so a
 * captured frame is identical run to run.
 */

import {
  Clip, Motion, PathBuilder, clamp01, easeBackOut, easeOut, el, pulseCurve,
  setAttr, setFlag, setShown, setStyle, setText, svgEl, clockText,
} from './Dom.ts';
import type { HudFrame, HudWidget, Side, TeamBrand } from './Model.ts';

/** Stall arc geometry, in the gauge's own 40×40 user space. */
const GA = { cx: 20, cy: 20, r: 15.0, w: 3.7 };
const CIRC = 2 * Math.PI * GA.r;

/** Amber. Kept identical to `Hud.ts`'s DUMP_STALL — see the header. */
const DUMP_STALL = 7;
/** Red. The last two counts of a ten count. */
const HOT_STALL = 9;

interface TeamCells {
  root: HTMLElement;
  chip: HTMLElement;
  poss: HTMLElement;
  code: HTMLElement;
  col: HTMLElement;
  top: HTMLElement;
  bottom: HTMLElement;
  pips: HTMLElement[];
  /** Displayed score; the odometer lags the model by one roll. */
  shown: number;
  roll: Clip;
  possFade: Motion;
}

export class Scorebug implements HudWidget {
  readonly root: HTMLElement;

  private teams: [TeamCells, TeamCells];
  private cellPoint: HTMLElement;
  private cellTarget: HTMLElement;
  private cellClock: HTMLElement;
  private clockWrap: HTMLElement;
  private stallCell: HTMLElement;
  private stallWrap: HTMLElement;
  private stallArc: SVGPathElement;
  private stallTrack: SVGPathElement;
  private stallNum: HTMLElement;

  private intro = new Clip();
  private stallPulse = new Clip();
  private stallArcM = new Motion(0, 11);
  private lastStall = -1;
  /** Set once `stall:tick` has been heard, after which polling stops pulsing. */
  private ticked = false;
  private path = new PathBuilder();

  constructor(parent: HTMLElement, brands: [TeamBrand, TeamBrand]) {
    this.root = el('div', 'ug-panel ug-bug', parent);

    const a = this.buildTeam(0, brands[0]);
    el('div', 'ug-hair', this.root);
    const b = this.buildTeam(1, brands[1]);
    this.teams = [a, b];

    el('div', 'ug-hair', this.root);
    const pc = el('div', 'cell', this.root);
    el('span', 'ug-lbl', pc).textContent = 'Point';
    this.cellPoint = el('span', 'v', pc);

    this.clockWrap = el('div', 'ug-hair', this.root);
    const cc = el('div', 'cell', this.root);
    el('span', 'ug-lbl', cc).textContent = 'Time';
    this.cellClock = el('span', 'v', cc);
    this.clockGroup = cc;

    el('div', 'ug-hair', this.root);
    const tc = el('div', 'cell', this.root);
    this.targetLabel = el('span', 'ug-lbl', tc);
    this.targetLabel.textContent = 'Game to';
    this.cellTarget = el('span', 'v', tc);

    el('div', 'ug-hair', this.root);
    this.stallCell = el('div', 'stall', this.root);
    this.stallWrap = el('div', 'gwrap', this.stallCell);
    const g = svgEl('svg', 'gauge', this.stallWrap);
    g.setAttribute('viewBox', '0 0 40 40');
    this.stallTrack = svgEl('path', undefined, g);
    this.stallArc = svgEl('path', undefined, g);
    const ring = this.arcPath(1);
    setAttr(this.stallTrack, 'd', ring);
    setAttr(this.stallTrack, 'fill', 'none');
    setAttr(this.stallTrack, 'stroke', 'rgba(180,206,242,.16)');
    setAttr(this.stallTrack, 'stroke-width', String(GA.w));
    setAttr(this.stallTrack, 'stroke-linecap', 'round');
    setAttr(this.stallArc, 'd', ring);
    setAttr(this.stallArc, 'fill', 'none');
    setAttr(this.stallArc, 'stroke-width', String(GA.w));
    setAttr(this.stallArc, 'stroke-linecap', 'round');
    setAttr(this.stallArc, 'stroke-dasharray', `0 ${CIRC.toFixed(2)}`);
    this.stallNum = el('div', 'gn', this.stallWrap);
  }

  private clockGroup!: HTMLElement;
  private targetLabel!: HTMLElement;

  /* ------------------------------------------------------------------ build */

  private buildTeam(side: Side, brand: TeamBrand): TeamCells {
    const root = el('div', 'tm', this.root);
    root.style.setProperty('--c', brand.colour);
    const chip = el('i', 'chip', root);

    const idc = el('div', 'idc', root);
    const idr = el('div', 'idr', idc);
    const poss = el('i', 'poss', idr);
    const code = el('span', 'code', idr);
    code.textContent = brand.code;
    const tos = el('div', 'tos', idc);
    const pips = [el('i', undefined, tos), el('i', undefined, tos)];

    const num = el('span', 'num', root);
    const col = el('span', 'col', num);
    const top = el('b', undefined, col);
    const bottom = el('b', undefined, col);
    top.textContent = '0';
    bottom.textContent = '0';
    void side;
    return {
      root, chip, poss, code, col, top, bottom, pips,
      shown: 0, roll: new Clip(), possFade: new Motion(0, 12),
    };
  }

  /** Arc from 12 o'clock, clockwise, covering `frac` of the circle. */
  private arcPath(frac: number): string {
    const p = this.path.reset();
    const n = 48;
    const span = clamp01(frac) * Math.PI * 2;
    for (let i = 0; i <= n; i++) {
      const a = -Math.PI / 2 + (span * i) / n;
      const x = GA.cx + Math.cos(a) * GA.r;
      const y = GA.cy + Math.sin(a) * GA.r;
      if (i === 0) p.move(x, y); else p.line(x, y);
    }
    return p.build();
  }

  /* -------------------------------------------------------------- stall tick */

  /**
   * An authoritative increment from the rules machine. Once this has been heard
   * the frame poll in `update()` stops firing pulses of its own, so a game system
   * that raises the event and one that only exposes `stallCount` both animate —
   * neither double-pulses.
   */
  tick(count: number, now: number): void {
    this.ticked = true;
    if (count > this.lastStall) this.stallPulse.fire(now, 0.52);
    this.lastStall = count;
  }

  /* ----------------------------------------------------------------- staging */

  restage(f: HudFrame): void {
    this.intro.fire(f.t, 0.92);
    for (let i = 0; i < 2; i++) {
      const t = this.teams[i];
      t.shown = f.score[i];
      t.top.textContent = String(t.shown);
      t.bottom.textContent = String(t.shown);
      t.roll.stop();
      setStyle(t.col, 'transform', 'translateY(0)');
      t.possFade.set(f.possession === i ? 1 : 0);
    }
    this.lastStall = f.stall;
    this.stallPulse.stop();
    this.stallArcM.set(f.stallMax > 0 ? f.stall / f.stallMax : 0);
  }

  /* ------------------------------------------------------------------ update */

  update(f: HudFrame): void {
    /* entrance ---------------------------------------------------------- */
    const ip = this.intro.peek(f.t);
    if (ip < 1) {
      const e = easeBackOut(ip, 1.15);
      setStyle(this.root, 'transform', `translate3d(${((e - 1) * 2.4).toFixed(3)}em,${((1 - e) * -0.9).toFixed(3)}em,0)`);
      setStyle(this.root, 'opacity', easeOut(ip * 1.9).toFixed(3));
    } else {
      setStyle(this.root, 'transform', 'translate3d(0,0,0)');
      setStyle(this.root, 'opacity', '1');
    }

    /* teams -------------------------------------------------------------- */
    for (let i = 0 as Side; i <= 1; i = (i + 1) as Side) {
      const t = this.teams[i];
      const want = f.score[i];
      if (want !== t.shown && !t.roll.running) {
        // Old value on top, new below: the digit counts *up* into place.
        t.top.textContent = String(t.shown);
        t.bottom.textContent = String(want);
        t.roll.fire(f.t, 0.62);
      }
      if (t.roll.running) {
        const p = t.roll.progress(f.t);
        const e = easeBackOut(p, 0.9);
        setStyle(t.col, 'transform', `translate3d(0,${(-e * 50).toFixed(2)}%,0)`);
        if (p >= 1) {
          t.shown = want;
          t.top.textContent = String(want);
          t.bottom.textContent = String(want);
          setStyle(t.col, 'transform', 'translate3d(0,0,0)');
        }
      } else if (want !== t.shown) {
        t.shown = want;
        t.top.textContent = String(want);
        t.bottom.textContent = String(want);
      }

      const on = f.possession === i;
      setFlag(t.root, 'on', on);
      t.possFade.target = on ? 1 : 0;
      const pv = t.possFade.step(f.dt);
      setStyle(t.poss, 'opacity', pv.toFixed(3));
      setStyle(t.poss, 'transform', `scale(${(0.55 + 0.45 * pv).toFixed(3)})`);

      const left = f.timeouts[i];
      for (let k = 0; k < t.pips.length; k++) setFlag(t.pips[k], 'spent', k >= left);
    }

    /* meta --------------------------------------------------------------- */
    setText(this.cellPoint, String(f.point));

    // Ultimate has no running game clock, so the cell only exists once the match
    // has actually been running — a latched screenshot tableau would otherwise
    // publish a permanent 0:00, which reads as a broken widget.
    const showClock = f.clock >= 1;
    setShown(this.clockGroup, showClock);
    setShown(this.clockWrap, showClock);
    if (showClock) setText(this.cellClock, clockText(f.clock));

    if (f.cap === 'none') {
      setText(this.targetLabel, 'Game to');
      setText(this.cellTarget, String(f.target));
    } else {
      setText(this.targetLabel, f.cap === 'soft' ? 'Soft cap' : 'Hard cap');
      setText(this.cellTarget, String(f.target));
    }

    /* stall -------------------------------------------------------------- */
    // Value is polled; the beat is not. `tick()` owns the pulse as soon as a real
    // `stall:tick` has arrived — this branch is the fallback for a game system
    // that publishes the count but not the event.
    if (f.stall !== this.lastStall) {
      if (!this.ticked && f.stall > this.lastStall) this.stallPulse.fire(f.t, 0.52);
      this.lastStall = f.stall;
    }
    const frac = f.stallMax > 0 ? clamp01(f.stall / f.stallMax) : 0;
    this.stallArcM.target = frac;
    const a = this.stallArcM.step(f.dt);
    setAttr(this.stallArc, 'stroke-dasharray', `${(a * CIRC).toFixed(2)} ${(CIRC * 2).toFixed(2)}`);

    const hot = f.stall >= HOT_STALL;
    const warn = f.stall >= DUMP_STALL;
    setFlag(this.stallCell, 'hot', hot);
    setFlag(this.stallCell, 'warn', warn && !hot);
    // Three discrete states, not a ramp. Interpolating blue→amber in RGB passes
    // straight through grey, which is exactly the wrong colour for a count that
    // has to be read without looking at it.
    const stroke = hot ? '#ff5f45' : warn ? '#f4c657' : '#8fc0ff';
    setAttr(this.stallArc, 'stroke', stroke);
    setAttr(this.stallArc, 'style', `filter:drop-shadow(0 0 ${hot ? 3.2 : 1.6}px ${stroke})`);
    setText(this.stallNum, String(f.stall));
    setStyle(this.stallNum, 'opacity', f.stallFrozen ? '0.45' : '1');

    const pp = this.stallPulse.peek(f.t);
    if (pp < 1) {
      const k = pulseCurve(pp) * (hot ? 0.19 : 0.12);
      setStyle(this.stallWrap, 'transform', `scale(${(1 + k).toFixed(4)})`);
      this.stallPulse.progress(f.t);
    } else {
      setStyle(this.stallWrap, 'transform', 'scale(1)');
    }
  }
}

