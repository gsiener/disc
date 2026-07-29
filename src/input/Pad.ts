/**
 * Gamepad layer: logical button names, standard-mapping detection with a
 * best-effort fallback for pads that do not claim it, hot-plug tracking and
 * "which pad is the player actually holding right now" arbitration.
 */

import { clamp01 } from './Curves.ts';
import type { RawPad } from './Sources.ts';

export const PAD_BUTTONS = [
  'a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'back', 'start',
  'ls', 'rs', 'dup', 'ddown', 'dleft', 'dright', 'home',
] as const;
export type PadButton = (typeof PAD_BUTTONS)[number];

export const PAD_AXES = ['lx', 'ly', 'rx', 'ry'] as const;
export type PadAxis = (typeof PAD_AXES)[number];

/** W3C standard gamepad button order. */
const STANDARD_BUTTON_INDEX: Record<PadButton, number> = {
  a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9,
  ls: 10, rs: 11, dup: 12, ddown: 13, dleft: 14, dright: 15, home: 16,
};

const STANDARD_AXIS_INDEX: Record<PadAxis, number> = { lx: 0, ly: 1, rx: 2, ry: 3 };

export interface PadLayout {
  /** Did we believe the pad, or are we guessing? */
  standard: boolean;
  button: Record<PadButton, number>;
  axis: Record<PadAxis, number>;
  /** Triggers reported as axes (older Linux/DirectInput drivers) instead of buttons. */
  triggerAxis: { lt: number; rt: number } | null;
  /** D-pad reported as a hat axis rather than buttons. */
  dpadAxis: number | null;
}

const STANDARD_LAYOUT: PadLayout = {
  standard: true,
  button: STANDARD_BUTTON_INDEX,
  axis: STANDARD_AXIS_INDEX,
  triggerAxis: null,
  dpadAxis: null,
};

/**
 * Work out how to read a pad. A pad that claims `mapping === 'standard'` is
 * taken at its word. Otherwise we assume the near-universal XInput ordering and
 * patch up the two things that actually differ in the wild: triggers on axes,
 * and a d-pad hat.
 */
export function resolvePadLayout(pad: RawPad): PadLayout {
  if (pad.mapping === 'standard' && pad.buttons.length >= 16 && pad.axes.length >= 4) {
    return STANDARD_LAYOUT;
  }
  const triggerAxis = pad.buttons.length < 8 && pad.axes.length >= 6
    ? { lt: 4, rt: 5 }
    : null;
  const dpadAxis = pad.buttons.length < 16 && pad.axes.length >= 9 ? 9 : null;
  return {
    standard: false,
    button: STANDARD_BUTTON_INDEX,
    axis: STANDARD_AXIS_INDEX,
    triggerAxis,
    dpadAxis,
  };
}

/** Analogue value 0..1 of a logical button. */
export function readPadButton(pad: RawPad, layout: PadLayout, name: PadButton): number {
  if (layout.triggerAxis && (name === 'lt' || name === 'rt')) {
    const ax = pad.axes[layout.triggerAxis[name]];
    // Rest position is -1 on these drivers.
    return ax === undefined ? 0 : clamp01((ax + 1) * 0.5);
  }
  if (layout.dpadAxis !== null && (name === 'dup' || name === 'ddown' || name === 'dleft' || name === 'dright')) {
    const hat = pad.axes[layout.dpadAxis];
    if (hat === undefined || hat > 1.001) return 0;     // >1 means centred
    // Hat encodes 8 compass directions across -1..1, clockwise from up.
    const idx = Math.round((hat + 1) * 3.5) % 8;
    if (name === 'dup') return idx === 7 || idx === 0 || idx === 1 ? 1 : 0;
    if (name === 'dright') return idx >= 1 && idx <= 3 ? 1 : 0;
    if (name === 'ddown') return idx >= 3 && idx <= 5 ? 1 : 0;
    return idx >= 5 && idx <= 7 ? 1 : 0;
  }
  const i = layout.button[name];
  const v = pad.buttons[i];
  if (v !== undefined) return clamp01(v);
  const p = pad.pressed[i];
  return p ? 1 : 0;
}

export function readPadAxis(pad: RawPad, layout: PadLayout, name: PadAxis): number {
  const v = pad.axes[layout.axis[name]];
  return v === undefined ? 0 : v;
}

/* ------------------------------------------------------------------ manager */

export interface PadInfo {
  index: number;
  id: string;
  standard: boolean;
  layout: PadLayout;
  pad: RawPad;
  /** Sim time of the last input above the activity threshold. */
  lastActivity: number;
  /** Sim time the pad first appeared. */
  connectedAt: number;
}

export interface PadEvent { index: number; id: string; standard: boolean; connected: boolean }

export interface PadManagerOptions {
  /** Stick magnitude that counts as "the player is using this pad". */
  axisActivity: number;
  /** Button value that counts as activity. */
  buttonActivity: number;
}

export const DEFAULT_PAD_MANAGER: PadManagerOptions = { axisActivity: 0.35, buttonActivity: 0.5 };

/**
 * Tracks connected pads across hot-plug and decides which one is driving each
 * local player slot. Slot 0 defaults to "whichever pad most recently produced
 * real input", which is what you want when a controller wakes up mid-game or a
 * second pad joins.
 */
export class PadManager {
  opts: PadManagerOptions;
  /** Drained by the owner each step. */
  readonly events: PadEvent[] = [];

  private infos = new Map<number, PadInfo>();
  private order: PadInfo[] = [];
  private slots: (number | null)[] = [];
  private activeIndex = -1;
  private seen = new Set<number>();

  constructor(opts: Partial<PadManagerOptions> = {}) {
    this.opts = { ...DEFAULT_PAD_MANAGER, ...opts };
  }

  /** Feed the raw snapshot for this step. */
  update(pads: readonly RawPad[], now: number): void {
    this.seen.clear();
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p.connected) continue;
      this.seen.add(p.index);
      let info = this.infos.get(p.index);
      if (!info) {
        const layout = resolvePadLayout(p);
        info = {
          index: p.index, id: p.id, standard: layout.standard, layout, pad: p,
          lastActivity: -1, connectedAt: now,
        };
        this.infos.set(p.index, info);
        this.events.push({ index: p.index, id: p.id, standard: layout.standard, connected: true });
      } else {
        info.pad = p;
        if (info.id !== p.id) {           // slot reused by a different device
          info.id = p.id;
          info.layout = resolvePadLayout(p);
          info.standard = info.layout.standard;
        }
      }
      if (this.hasActivity(info)) info.lastActivity = now;
    }

    for (const [index, info] of this.infos) {
      if (this.seen.has(index)) continue;
      this.infos.delete(index);
      this.events.push({ index, id: info.id, standard: info.standard, connected: false });
      for (let s = 0; s < this.slots.length; s++) if (this.slots[s] === index) this.slots[s] = null;
      if (this.activeIndex === index) this.activeIndex = -1;
    }

    this.order.length = 0;
    for (const info of this.infos.values()) this.order.push(info);
    this.order.sort((a, b) => a.index - b.index);

    // Active pad = most recent real input, falling back to the lowest index.
    let best: PadInfo | null = null;
    for (const info of this.order) {
      if (info.lastActivity < 0) continue;
      if (!best || info.lastActivity > best.lastActivity) best = info;
    }
    if (!best && this.order.length) best = this.order[0];
    this.activeIndex = best ? best.index : -1;
  }

  get count(): number { return this.infos.size; }
  list(): readonly PadInfo[] { return this.order; }
  get(index: number): PadInfo | null { return this.infos.get(index) ?? null; }

  /** The pad currently driving, or null if nothing is plugged in. */
  get active(): PadInfo | null {
    return this.activeIndex >= 0 ? (this.infos.get(this.activeIndex) ?? null) : null;
  }

  /** Pin a pad to a local player slot; null re-enables automatic arbitration. */
  assign(slot: number, padIndex: number | null): void {
    while (this.slots.length <= slot) this.slots.push(null);
    this.slots[slot] = padIndex;
  }

  /** The pad driving a local player slot. Slot 0 falls back to the active pad. */
  forSlot(slot: number): PadInfo | null {
    const pinned = this.slots[slot];
    if (pinned !== null && pinned !== undefined) return this.infos.get(pinned) ?? null;
    if (slot === 0) return this.active;
    const list = this.order;
    return list[slot] ?? null;
  }

  drainEvents(into: PadEvent[]): number {
    const n = this.events.length;
    for (let i = 0; i < n; i++) into.push(this.events[i]);
    this.events.length = 0;
    return n;
  }

  private hasActivity(info: PadInfo): boolean {
    const p = info.pad;
    const a = this.opts.axisActivity;
    for (let i = 0; i < p.axes.length && i < 4; i++) if (Math.abs(p.axes[i]) > a) return true;
    const b = this.opts.buttonActivity;
    for (let i = 0; i < p.buttons.length; i++) if (p.buttons[i] > b) return true;
    return false;
  }
}
