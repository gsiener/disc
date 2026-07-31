/**
 * Lower third — the player card that fires on a goal or a D.
 *
 * The broadcast grammar this copies is deliberate and worth stating, because it
 * is the difference between a card and a tooltip:
 *
 *   t+0.00  the colour rail and the number plate wipe up from the baseline
 *   t+0.10  the body slides out from *behind* the plate, so the plate reads as
 *           the thing that pushed it into frame rather than as a decoration
 *   t+0.55  settled; held for the beat
 *   t+5.6   the whole card drops and fades in one move — broadcast cards never
 *           reverse their entrance, they leave faster than they arrived
 *
 * Everything on the card is real: the number and surname come from the kit bake
 * (`ctx.sys.players`), the position from the sim's archetype, and the three
 * stats from `GameState.playerStats()`. Nothing here invents a person.
 */

import {
  Clip, clamp01, easeBackOut, easeOut, el, setFlag, setShown, setStyle, setText,
} from './Dom.ts';
import type { HudFrame, HudPlayer, HudWidget, TeamBrand } from './Model.ts';

export interface CardStat { key: string; value: string }

export interface CardRequest {
  player: HudPlayer;
  /** Headline: GOAL, BLOCK, CALLAHAN… */
  tag: string;
  /** `true` renders the tag in the defensive colour. */
  defensive?: boolean;
  /** Second line under the name, e.g. "HANDLER · RIVERSIDE CURRENT". */
  sub: string;
  stats: CardStat[];
}

const IN_DUR = 0.62;
const HOLD_DUR = 5.0;
const OUT_DUR = 0.38;

export class LowerThird implements HudWidget {
  readonly root: HTMLElement;

  private rail: HTMLElement;
  private plate: HTMLElement;
  private plateNum: HTMLElement;
  private body: HTMLElement;
  private nameEl: HTMLElement;
  private subEl: HTMLElement;
  private tagEl: HTMLElement;
  private statsEl: HTMLElement;
  private statNodes: { wrap: HTMLElement; v: HTMLElement; k: HTMLElement }[] = [];

  private clip = new Clip();
  private live = false;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ug-panel ug-l3', parent);
    this.rail = el('i', 'rail', this.root);
    this.plate = el('div', 'plate', this.root);
    this.plateNum = el('span', undefined, this.plate);
    this.body = el('div', 'body', this.root);

    const who = el('div', 'who', this.body);
    this.nameEl = el('div', 'nm', who);
    this.subEl = el('div', 'sub', who);
    this.tagEl = el('div', 'tag', this.body);
    this.statsEl = el('div', 'stats', this.body);
    for (let i = 0; i < 3; i++) {
      const wrap = el('div', 'st', this.statsEl);
      const v = el('span', 'v', wrap);
      const k = el('span', 'k', wrap);
      this.statNodes.push({ wrap, v, k });
    }
    setShown(this.root, false);
  }

  /* ------------------------------------------------------------------ show */

  show(req: CardRequest, brands: [TeamBrand, TeamBrand], f: HudFrame): void {
    const brand = brands[req.player.team];
    this.root.style.setProperty('--c', brand.colour);
    this.root.style.setProperty('--cRaw', brand.raw);
    this.root.style.setProperty('--cInk', brand.ink);

    setText(this.plateNum, String(req.player.number));
    setText(this.nameEl, req.player.name.toUpperCase());
    setText(this.subEl, req.sub);
    setText(this.tagEl, req.tag);
    setFlag(this.tagEl, 'd', !!req.defensive);

    for (let i = 0; i < this.statNodes.length; i++) {
      const n = this.statNodes[i];
      const s = req.stats[i];
      setShown(n.wrap, !!s);
      if (s) { setText(n.v, s.value); setText(n.k, s.key); }
    }

    setShown(this.root, true);
    this.live = true;
    this.clip.fire(f.t, IN_DUR + HOLD_DUR + OUT_DUR);
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
    const total = IN_DUR + HOLD_DUR + OUT_DUR;
    const t = (f.t - this.clip.start) * 1;
    if (this.clip.start < 0 || t >= total) { this.hide(); return; }

    // Entrance: the shell rises and the body is pushed out from behind the plate.
    const pIn = clamp01(t / IN_DUR);
    const pOut = clamp01((t - IN_DUR - HOLD_DUR) / OUT_DUR);

    const rise = easeBackOut(pIn, 1.05);
    const fall = pOut * pOut;
    const y = (1 - rise) * 1.35 + fall * 1.1;
    const alpha = easeOut(pIn * 2.1) * (1 - fall);
    setStyle(this.root, 'transform', `translate3d(0,${y.toFixed(3)}em,0) scale(${(0.985 + 0.015 * rise).toFixed(4)})`);
    setStyle(this.root, 'opacity', alpha.toFixed(3));

    const pBody = clamp01((t - 0.10) / (IN_DUR - 0.02));
    const slide = (1 - easeBackOut(pBody, 0.55)) * -100;
    setStyle(this.body, 'transform', `translate3d(${slide.toFixed(2)}%,0,0)`);

    void this.rail;
  }
}
