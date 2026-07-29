/**
 * The action map: what a human presses -> what the game calls it.
 *
 * Every binding is rebindable and the whole thing round-trips through JSON, so
 * a controls screen is a thin view over this object and a saved config is one
 * string in localStorage. Deserialisation is defensive: unknown actions and
 * junk values are dropped and the defaults fill the gaps, so an old or hand-
 * edited config can never leave the game unplayable.
 */

import {
  DEFAULT_AIM_STICK, DEFAULT_STICK, DEFAULT_TRIGGER, clamp, type StickConfig,
} from './Curves.ts';
import { DEFAULT_TIMING, type ThrowTiming } from './Throw.ts';
import { PAD_AXES, PAD_BUTTONS, type PadAxis, type PadButton } from './Pad.ts';

export const BUTTON_ACTIONS = [
  'throw',          // press and hold to charge
  'throwModA',      // forehand modifier
  'throwModB',      // hammer modifier (+ModA = scoober, + tilt = blade)
  'curveLeft',      // deliberate outside-in / inside-out nudge
  'curveRight',
  'cancel',         // cancel a charge; long enough and it sells as a pump fake
  'pivot',
  'receiverNext',
  'receiverPrev',
  'callCut',        // force an active cut without holding a direction
  'bid',
  'layout',
  'switchDefender',
  'mark',           // hold: active mark
  'forceFlip',      // toggle which sideline you are forcing
] as const;
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];

export const AXIS_ACTIONS = ['moveX', 'moveY', 'aimX', 'aimY', 'sprint', 'brake'] as const;
export type AxisAction = (typeof AXIS_ACTIONS)[number];

export interface ButtonBinding {
  /** KeyboardEvent.code values. */
  keys: string[];
  /** Mouse button numbers. */
  mouse: number[];
  /** Logical pad buttons. */
  pad: PadButton[];
}

export interface AxisBinding {
  /** Keys driving -1 and +1 (digital, ramped into analogue downstream). */
  neg: string[];
  pos: string[];
  /** Pad stick axis, or null. */
  padAxis: PadAxis | null;
  /** Pad button read as a 0..1 axis (triggers). */
  padButton: PadButton | null;
  /** Relative mouse axis feeding a virtual stick. */
  mouse: 'x' | 'y' | null;
  invert: boolean;
  scale: number;
}

export interface InputConfig {
  version: number;
  buttons: Record<ButtonAction, ButtonBinding>;
  axes: Record<AxisAction, AxisBinding>;
  /** Movement stick shaping. */
  stick: StickConfig;
  /** Aim stick shaping. */
  aimStick: StickConfig;
  /** Trigger shaping (sprint, brake). */
  trigger: StickConfig;
  timing: ThrowTiming;
  /** Default input buffer window, seconds. */
  bufferTime: number;
  /** Per-action buffer overrides, seconds. */
  bufferOverrides: Partial<Record<ButtonAction, number>>;
  /** Seconds for a keyboard direction to ramp 0 -> 1 (analogue emulation). */
  keyboardRamp: number;
  /** Seconds for a released keyboard direction to fall 1 -> 0. */
  keyboardRelease: number;
  /** Mouse counts -> virtual aim stick units. */
  mouseSensitivity: number;
  /** Virtual aim stick decay per second when the mouse is still. */
  mouseRecenter: number;
  invertAimY: boolean;
  /** Seconds a direction must be held before it calls an active cut. */
  cutHoldTime: number;
  /** Aim deflection (radians) that maps to full disc tilt. */
  tiltSpan: number;
  /** Tilt contributed by a fully held curve modifier. */
  curveModTilt: number;
  /** Seconds of charge after which a cancel reads as a pump fake. */
  fakeTime: number;
  /** Stick magnitude that commits a directional receiver select. */
  selectThreshold: number;
  /** Keyboard direct-select: index in this list = receiver slot. */
  receiverSlotKeys: string[];
}

const K = (...keys: string[]): string[] => keys;

function btn(keys: string[], pad: PadButton[], mouse: number[] = []): ButtonBinding {
  return { keys, mouse, pad };
}

function axis(o: Partial<AxisBinding>): AxisBinding {
  return {
    neg: o.neg ?? [], pos: o.pos ?? [],
    padAxis: o.padAxis ?? null, padButton: o.padButton ?? null,
    mouse: o.mouse ?? null, invert: o.invert ?? false, scale: o.scale ?? 1,
  };
}

export function defaultConfig(): InputConfig {
  return {
    version: 1,
    buttons: {
      // Triggers carry the analogue verbs (sprint, brake); the throw charge is a
      // hold, which a face button does fine. A few pad buttons are shared
      // between offence and defence — you cannot be marking and holding the
      // disc at the same time, so the game reads whichever half applies.
      throw:           btn(K(), ['a'], [0]),
      throwModA:       btn(K('KeyQ'), ['lb']),
      throwModB:       btn(K('KeyE'), ['rb']),
      curveLeft:       btn(K('KeyZ'), ['dleft']),
      curveRight:      btn(K('KeyC'), ['dright']),
      cancel:          btn(K('Escape'), ['b'], [2]),
      pivot:           btn(K('KeyF'), ['rs']),
      receiverNext:    btn(K('Tab'), ['ddown']),
      receiverPrev:    btn(K('KeyR'), ['dup']),
      callCut:         btn(K('Space'), ['y']),
      bid:             btn(K('KeyV'), ['x']),
      layout:          btn(K('KeyB'), ['b']),
      switchDefender:  btn(K('Space'), ['a']),
      mark:            btn(K('KeyX'), ['lb']),
      forceFlip:       btn(K('KeyT'), ['back']),
    },
    axes: {
      moveX:  axis({ neg: K('KeyA', 'ArrowLeft'), pos: K('KeyD', 'ArrowRight'), padAxis: 'lx' }),
      moveY:  axis({ neg: K('KeyS', 'ArrowDown'), pos: K('KeyW', 'ArrowUp'), padAxis: 'ly', invert: true }),
      aimX:   axis({ padAxis: 'rx', mouse: 'x' }),
      aimY:   axis({ padAxis: 'ry', mouse: 'y', invert: true }),
      sprint: axis({ pos: K('ShiftLeft'), padButton: 'rt' }),
      brake:  axis({ pos: K('ControlLeft'), padButton: 'lt' }),
    },
    stick: { ...DEFAULT_STICK },
    aimStick: { ...DEFAULT_AIM_STICK },
    trigger: { ...DEFAULT_TRIGGER },
    timing: { ...DEFAULT_TIMING },
    bufferTime: 0.12,
    bufferOverrides: { layout: 0.2, bid: 0.18, throw: 0.14 },
    keyboardRamp: 0.11,
    keyboardRelease: 0.07,
    mouseSensitivity: 0.006,
    mouseRecenter: 3.2,
    invertAimY: false,
    cutHoldTime: 0.18,
    tiltSpan: Math.PI / 3,
    curveModTilt: 0.55,
    fakeTime: 0.25,
    selectThreshold: 0.55,
    receiverSlotKeys: K('Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7'),
  };
}

/* ------------------------------------------------------------- validation */

const PAD_BUTTON_SET: ReadonlySet<string> = new Set(PAD_BUTTONS);
const PAD_AXIS_SET: ReadonlySet<string> = new Set(PAD_AXES);

function num(v: unknown, def: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : def;
}
function bool(v: unknown, def: boolean): boolean { return typeof v === 'boolean' ? v : def; }

function strings(v: unknown, valid?: ReadonlySet<string>): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== 'string' || s.length === 0 || s.length > 40) continue;
    if (valid && !valid.has(s)) continue;
    if (out.indexOf(s) < 0) out.push(s);
  }
  return out;
}

function numbers(v: unknown, lo: number, hi: number): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isFinite(n)) continue;
    const i = Math.round(clamp(n, lo, hi));
    if (out.indexOf(i) < 0) out.push(i);
  }
  return out;
}

function mergeStick(src: unknown, def: StickConfig): StickConfig {
  const o = (src ?? {}) as Record<string, unknown>;
  const inner = num(o.inner, def.inner, 0, 0.6);
  const outer = num(o.outer, def.outer, inner + 0.05, 1);
  return { inner, outer, expo: num(o.expo, def.expo, 0, 1), power: num(o.power, def.power, 1, 6) };
}

function mergeTiming(src: unknown, def: ThrowTiming): ThrowTiming {
  const o = (src ?? {}) as Record<string, unknown>;
  const fullTime = num(o.fullTime, def.fullTime, 0.15, 4);
  return {
    fullTime,
    minTime: num(o.minTime, def.minTime, 0.01, fullTime),
    perfectWindow: num(o.perfectWindow, def.perfectWindow, 0.01, 1),
    overGrace: num(o.overGrace, def.overGrace, 0, 2),
    maxHold: num(o.maxHold, def.maxHold, fullTime + 0.05, 8),
    rushFloor: num(o.rushFloor, def.rushFloor, 0, 1),
    plateau: num(o.plateau, def.plateau, 0, 1),
    overFloor: num(o.overFloor, def.overFloor, 0, 1),
    powerCurve: num(o.powerCurve, def.powerCurve, 0.25, 4),
    minPower: num(o.minPower, def.minPower, 0, 0.9),
  };
}

/* ------------------------------------------------------------------ class */

export type BindMode = 'replace' | 'add';

export class ActionMap {
  config: InputConfig;

  constructor(cfg?: Partial<InputConfig>) {
    this.config = defaultConfig();
    if (cfg) this.config = ActionMap.merge(cfg);
  }

  /** Merge a partial config over the defaults, validating everything. */
  static merge(src: Partial<InputConfig> | Record<string, unknown>): InputConfig {
    const def = defaultConfig();
    const o = (src ?? {}) as Record<string, unknown>;

    const buttons = {} as Record<ButtonAction, ButtonBinding>;
    const srcButtons = (o.buttons ?? {}) as Record<string, unknown>;
    for (const a of BUTTON_ACTIONS) {
      const d = def.buttons[a];
      const b = srcButtons[a] as Record<string, unknown> | undefined;
      buttons[a] = b
        ? {
            keys: 'keys' in b ? strings(b.keys) : d.keys,
            mouse: 'mouse' in b ? numbers(b.mouse, 0, 8) : d.mouse,
            pad: ('pad' in b ? strings(b.pad, PAD_BUTTON_SET) : d.pad) as PadButton[],
          }
        : d;
    }

    const axes = {} as Record<AxisAction, AxisBinding>;
    const srcAxes = (o.axes ?? {}) as Record<string, unknown>;
    for (const a of AXIS_ACTIONS) {
      const d = def.axes[a];
      const b = srcAxes[a] as Record<string, unknown> | undefined;
      if (!b) { axes[a] = d; continue; }
      const padAxis = typeof b.padAxis === 'string' && PAD_AXIS_SET.has(b.padAxis) ? (b.padAxis as PadAxis) : ('padAxis' in b ? null : d.padAxis);
      const padButton = typeof b.padButton === 'string' && PAD_BUTTON_SET.has(b.padButton) ? (b.padButton as PadButton) : ('padButton' in b ? null : d.padButton);
      const mouse = b.mouse === 'x' || b.mouse === 'y' ? b.mouse : ('mouse' in b ? null : d.mouse);
      axes[a] = {
        neg: 'neg' in b ? strings(b.neg) : d.neg,
        pos: 'pos' in b ? strings(b.pos) : d.pos,
        padAxis, padButton, mouse,
        invert: bool(b.invert, d.invert),
        scale: num(b.scale, d.scale, -8, 8),
      };
    }

    const overrides: Partial<Record<ButtonAction, number>> = {};
    const srcOv = (o.bufferOverrides ?? {}) as Record<string, unknown>;
    for (const a of BUTTON_ACTIONS) {
      const v = srcOv[a];
      if (typeof v === 'number' && Number.isFinite(v)) overrides[a] = clamp(v, 0, 1);
      else if (def.bufferOverrides[a] !== undefined && !(a in srcOv)) overrides[a] = def.bufferOverrides[a];
    }

    return {
      version: num(o.version, def.version, 0, 1e6),
      buttons, axes,
      stick: mergeStick(o.stick, def.stick),
      aimStick: mergeStick(o.aimStick, def.aimStick),
      trigger: mergeStick(o.trigger, def.trigger),
      timing: mergeTiming(o.timing, def.timing),
      bufferTime: num(o.bufferTime, def.bufferTime, 0, 1),
      bufferOverrides: overrides,
      keyboardRamp: num(o.keyboardRamp, def.keyboardRamp, 0.001, 1),
      keyboardRelease: num(o.keyboardRelease, def.keyboardRelease, 0.001, 1),
      mouseSensitivity: num(o.mouseSensitivity, def.mouseSensitivity, 0.0001, 0.2),
      mouseRecenter: num(o.mouseRecenter, def.mouseRecenter, 0, 40),
      invertAimY: bool(o.invertAimY, def.invertAimY),
      cutHoldTime: num(o.cutHoldTime, def.cutHoldTime, 0.02, 2),
      tiltSpan: num(o.tiltSpan, def.tiltSpan, 0.1, Math.PI),
      curveModTilt: num(o.curveModTilt, def.curveModTilt, 0, 1),
      fakeTime: num(o.fakeTime, def.fakeTime, 0.02, 2),
      selectThreshold: num(o.selectThreshold, def.selectThreshold, 0.1, 1),
      receiverSlotKeys: 'receiverSlotKeys' in o ? strings(o.receiverSlotKeys) : def.receiverSlotKeys,
    };
  }

  reset(): void { this.config = defaultConfig(); }

  binding(action: ButtonAction): ButtonBinding { return this.config.buttons[action]; }
  axisBinding(action: AxisAction): AxisBinding { return this.config.axes[action]; }

  /** Replace or extend a button binding. */
  rebind(action: ButtonAction, patch: Partial<ButtonBinding>, mode: BindMode = 'replace'): void {
    const cur = this.config.buttons[action];
    const next: ButtonBinding = mode === 'replace'
      ? { keys: patch.keys ? strings(patch.keys) : [], mouse: patch.mouse ? numbers(patch.mouse, 0, 8) : [], pad: (patch.pad ? strings(patch.pad, PAD_BUTTON_SET) : []) as PadButton[] }
      : {
          keys: dedupe(cur.keys, patch.keys ? strings(patch.keys) : []),
          mouse: dedupeNum(cur.mouse, patch.mouse ? numbers(patch.mouse, 0, 8) : []),
          pad: dedupe(cur.pad, (patch.pad ? strings(patch.pad, PAD_BUTTON_SET) : []) as PadButton[]) as PadButton[],
        };
    this.config.buttons[action] = next;
  }

  rebindAxis(action: AxisAction, patch: Partial<AxisBinding>): void {
    const cur = this.config.axes[action];
    this.config.axes[action] = {
      neg: patch.neg ? strings(patch.neg) : cur.neg,
      pos: patch.pos ? strings(patch.pos) : cur.pos,
      padAxis: patch.padAxis !== undefined ? patch.padAxis : cur.padAxis,
      padButton: patch.padButton !== undefined ? patch.padButton : cur.padButton,
      mouse: patch.mouse !== undefined ? patch.mouse : cur.mouse,
      invert: patch.invert !== undefined ? patch.invert : cur.invert,
      scale: patch.scale !== undefined ? num(patch.scale, cur.scale, -8, 8) : cur.scale,
    };
  }

  /** Remove a key/pad button/mouse button from every action it is bound to. */
  unbindEverywhere(token: string | number): void {
    for (const a of BUTTON_ACTIONS) {
      const b = this.config.buttons[a];
      if (typeof token === 'number') b.mouse = b.mouse.filter((m) => m !== token);
      else {
        b.keys = b.keys.filter((k) => k !== token);
        b.pad = b.pad.filter((p) => p !== token);
      }
    }
    if (typeof token === 'string') {
      for (const a of AXIS_ACTIONS) {
        const ax = this.config.axes[a];
        ax.neg = ax.neg.filter((k) => k !== token);
        ax.pos = ax.pos.filter((k) => k !== token);
      }
    }
  }

  /** Every action a token currently fires. Two actions may legitimately share one. */
  conflicts(token: string | number): ButtonAction[] {
    const out: ButtonAction[] = [];
    for (const a of BUTTON_ACTIONS) {
      const b = this.config.buttons[a];
      const hit = typeof token === 'number'
        ? b.mouse.indexOf(token) >= 0
        : b.keys.indexOf(token) >= 0 || b.pad.indexOf(token as PadButton) >= 0;
      if (hit) out.push(a);
    }
    return out;
  }

  /**
   * Canonical JSON. Key order is fixed by the action tables rather than by
   * insertion, so serialize(deserialize(s)) === s for any valid s.
   */
  serialize(pretty = false): string {
    const c = this.config;
    const buttons: Record<string, ButtonBinding> = {};
    for (const a of BUTTON_ACTIONS) {
      const b = c.buttons[a];
      buttons[a] = { keys: [...b.keys], mouse: [...b.mouse], pad: [...b.pad] };
    }
    const axes: Record<string, AxisBinding> = {};
    for (const a of AXIS_ACTIONS) {
      const b = c.axes[a];
      axes[a] = {
        neg: [...b.neg], pos: [...b.pos], padAxis: b.padAxis, padButton: b.padButton,
        mouse: b.mouse, invert: b.invert, scale: b.scale,
      };
    }
    const overrides: Record<string, number> = {};
    for (const a of BUTTON_ACTIONS) {
      const v = c.bufferOverrides[a];
      if (v !== undefined) overrides[a] = v;
    }
    const out = {
      version: c.version, buttons, axes,
      stick: c.stick, aimStick: c.aimStick, trigger: c.trigger, timing: c.timing,
      bufferTime: c.bufferTime, bufferOverrides: overrides,
      keyboardRamp: c.keyboardRamp, keyboardRelease: c.keyboardRelease,
      mouseSensitivity: c.mouseSensitivity, mouseRecenter: c.mouseRecenter,
      invertAimY: c.invertAimY, cutHoldTime: c.cutHoldTime, tiltSpan: c.tiltSpan,
      curveModTilt: c.curveModTilt, fakeTime: c.fakeTime, selectThreshold: c.selectThreshold,
      receiverSlotKeys: [...c.receiverSlotKeys],
    };
    return JSON.stringify(out, null, pretty ? 2 : 0);
  }

  static deserialize(json: string): ActionMap {
    let parsed: unknown = null;
    try { parsed = JSON.parse(json); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new ActionMap();
    const m = new ActionMap();
    m.config = ActionMap.merge(parsed as Record<string, unknown>);
    return m;
  }
}

function dedupe<T extends string>(a: readonly T[], b: readonly T[]): T[] {
  const out: T[] = [...a];
  for (const v of b) if (out.indexOf(v) < 0) out.push(v);
  return out;
}
function dedupeNum(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [...a];
  for (const v of b) if (out.indexOf(v) < 0) out.push(v);
  return out;
}
