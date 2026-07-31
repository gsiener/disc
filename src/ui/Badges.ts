/**
 * Replay and slow-motion badges.
 *
 * Top-right, stacked, because that corner is the one place a broadcast graphic
 * can sit without covering play in any of the ten framings. Both are driven by
 * real signals: the slow-mo badge follows `ctx.timeScale` — whoever owns it, the
 * director or a replay system — and the replay badge follows `replay:start` /
 * `replay:end` on the bus, with a public setter so a peer that does not use the
 * bus can drive it directly.
 *
 * The recording dot breathes on a 1.6 s sim-time sine. That is the only looping
 * animation in the whole package, and it is here because a static red dot reads
 * as a decal while a breathing one reads as a state.
 */

import { Motion, easeOut, el, setShown, setStyle, setText } from './Dom.ts';
import type { HudFrame, HudWidget } from './Model.ts';

interface Badge {
  root: HTMLElement;
  label: HTMLElement;
  dot: HTMLElement | null;
  vis: Motion;
  on: boolean;
}

export class Badges implements HudWidget {
  readonly root: HTMLElement;

  private replay: Badge;
  private slow: Badge;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ug-badges', parent);
    this.replay = this.make('', true);
    this.slow = this.make('slow', false);
    this.setReplay(false);
    this.setSlowMo(1);
  }

  private make(extra: string, withDot: boolean): Badge {
    const root = el('div', `ug-badge ${extra}`.trim(), this.root);
    const dot = withDot ? el('i', 'dot', root) : null;
    const label = el('span', 't', root);
    setShown(root, false);
    return { root, label, dot, vis: new Motion(0, 13), on: false };
  }

  /* --------------------------------------------------------------- control */

  setReplay(on: boolean, label = 'Replay'): void {
    this.replay.on = on;
    if (on) setText(this.replay.label, label);
  }

  /** `scale` is `ctx.timeScale`; anything under 0.92 shows the badge. */
  setSlowMo(scale: number): void {
    const on = scale > 0.001 && scale < 0.92;
    this.slow.on = on;
    if (on) setText(this.slow.label, `${scale.toFixed(2).replace(/0$/, '')}× Slow-mo`);
  }

  restage(): void {
    this.replay.vis.set(this.replay.on ? 1 : 0);
    this.slow.vis.set(this.slow.on ? 1 : 0);
  }

  /* ---------------------------------------------------------------- update */

  update(f: HudFrame): void {
    this.tick(this.replay, f);
    this.tick(this.slow, f);
    if (this.replay.on && this.replay.dot) {
      // 1.6 s breath. Opacity only — a scaling dot would drag the label with it.
      const b = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(f.t * (Math.PI * 2) / 1.6));
      setStyle(this.replay.dot, 'opacity', b.toFixed(3));
    }
  }

  private tick(b: Badge, f: HudFrame): void {
    b.vis.target = b.on ? 1 : 0;
    const v = b.vis.step(f.dt);
    if (v < 0.004 && !b.on) { setShown(b.root, false); return; }
    setShown(b.root, true);
    const e = easeOut(v);
    setStyle(b.root, 'opacity', e.toFixed(3));
    setStyle(b.root, 'transform', `translate3d(${((1 - e) * 1.4).toFixed(3)}em,0,0) scale(${(0.9 + 0.1 * e).toFixed(4)})`);
  }
}
