/**
 * End-of-point stat summary.
 *
 * Every number on it is read straight off `GameState`'s box score — completions
 * and attempts, blocks, turnovers committed, throwing yards, time of possession,
 * holds and breaks. Nothing is estimated and nothing is stored here; the panel
 * is a view.
 *
 * Layout is a comparison table, which is the only layout that works for two
 * teams: label on the left, the two values right-aligned in fixed-width columns
 * so the eye can run down the pair and see who is winning each line without
 * reading a single digit. The leader on each row gets full-strength ink, the
 * other gets the muted tone — a comparison you can read in a half-second glance
 * without a chart, a bar or a colour.
 */

import { Clip, clamp01, easeBackOut, easeOut, el, setFlag, setShown, setStyle, setText } from './Dom.ts';
import type { HudFrame, HudWidget, TeamBrand } from './Model.ts';

export interface SummaryRow {
  key: string;
  a: string;
  b: string;
  /** 0 = home leads, 1 = away leads, -1 = level / not a contest. */
  winner: -1 | 0 | 1;
}

export interface SummaryData {
  title: string;
  point: string;
  score: [number, number];
  rows: SummaryRow[];
  footBadge: string;
  footText: string;
}

const IN_DUR = 0.62;
const OUT_DUR = 0.34;

export class SummaryPanel implements HudWidget {
  readonly root: HTMLElement;

  private titleEl: HTMLElement;
  private pointEl: HTMLElement;
  private codeA: HTMLElement;
  private codeB: HTMLElement;
  private rowNodes: { root: HTMLElement; k: HTMLElement; a: HTMLElement; b: HTMLElement }[] = [];
  private footBadge: HTMLElement;
  private footText: HTMLElement;
  private foot: HTMLElement;

  private clip = new Clip();
  private live = false;
  private hold = 8;

  constructor(parent: HTMLElement, brands: [TeamBrand, TeamBrand]) {
    this.root = el('div', 'ug-panel ug-sum', parent);

    const hd = el('div', 'hd', this.root);
    this.titleEl = el('span', 't', hd);
    this.pointEl = el('span', 'p', hd);

    const tr = el('div', 'teamrow', this.root);
    el('span', 'k', tr).textContent = 'Team';
    this.codeA = el('span', 'a', tr);
    this.codeB = el('span', 'b', tr);
    this.codeA.style.color = brands[0].colour;
    this.codeB.style.color = brands[1].colour;
    this.codeA.textContent = brands[0].code;
    this.codeB.textContent = brands[1].code;

    for (let i = 0; i < 7; i++) {
      const root = el('div', 'line', this.root);
      const k = el('span', 'k', root);
      const a = el('span', 'a', root);
      const b = el('span', 'b', root);
      this.rowNodes.push({ root, k, a, b });
      setShown(root, false);
    }

    this.foot = el('div', 'ft', this.root);
    this.footBadge = el('span', 'badge', this.foot);
    this.footText = el('span', 'txt', this.foot);
    setShown(this.root, false);
  }

  /* ------------------------------------------------------------------ show */

  show(data: SummaryData, f: HudFrame, holdSeconds = 8): void {
    setText(this.titleEl, data.title);
    setText(this.pointEl, data.point);

    for (let i = 0; i < this.rowNodes.length; i++) {
      const n = this.rowNodes[i];
      const r = data.rows[i];
      setShown(n.root, !!r);
      if (!r) continue;
      setText(n.k, r.key);
      setText(n.a, r.a);
      setText(n.b, r.b);
      setFlag(n.a, 'win', r.winner === 0);
      setFlag(n.a, 'lose', r.winner === 1);
      setFlag(n.b, 'win', r.winner === 1);
      setFlag(n.b, 'lose', r.winner === 0);
    }

    const hasFoot = data.footText.length > 0;
    setShown(this.foot, hasFoot);
    if (hasFoot) { setText(this.footBadge, data.footBadge); setText(this.footText, data.footText); }

    this.hold = holdSeconds;
    setShown(this.root, true);
    this.live = true;
    this.clip.fire(f.t, IN_DUR + holdSeconds + OUT_DUR);
  }

  hide(): void {
    this.live = false;
    this.clip.stop();
    setShown(this.root, false);
  }

  restage(): void { this.hide(); }

  /* ---------------------------------------------------------------- update */

  update(f: HudFrame): void {
    if (!this.live) return;
    const total = IN_DUR + this.hold + OUT_DUR;
    const t = f.t - this.clip.start;
    if (this.clip.start < 0 || t >= total) { this.hide(); return; }

    const pIn = clamp01(t / IN_DUR);
    const pOut = clamp01((t - IN_DUR - this.hold) / OUT_DUR);
    const inE = easeBackOut(pIn, 0.9);
    const outE = pOut * pOut;
    const x = (1 - inE) * 3.2 + outE * 2.2;
    setStyle(this.root, 'transform', `translate3d(${x.toFixed(3)}em,-50%,0)`);
    setStyle(this.root, 'opacity', (easeOut(pIn * 2.2) * (1 - outE)).toFixed(3));
  }
}
