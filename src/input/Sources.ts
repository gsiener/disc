/**
 * Raw device sources, behind an interface so the controller can be driven by
 * the DOM in the browser and by a scripted harness under node. Nothing above
 * this file ever touches `window`, `document` or `navigator`.
 */

/** One gamepad, already snapshotted for this step. */
export interface RawPad {
  index: number;
  id: string;
  /** '' or 'standard' — the Gamepad API's own mapping claim. */
  mapping: string;
  connected: boolean;
  axes: readonly number[];
  /** Analogue button values, 0..1 (triggers are meaningful here). */
  buttons: readonly number[];
  pressed: readonly boolean[];
  timestamp: number;
}

export interface KeySnapshot {
  /** KeyboardEvent.code values currently down (including one-step latches). */
  keys: ReadonlySet<string>;
  mouseButtons: ReadonlySet<number>;
  mouseDx: number;
  mouseDy: number;
  wheel: number;
  pointerLocked: boolean;
  /** True if the window believes it has focus; input is muted when it does not. */
  focused: boolean;
}

export interface InputSources {
  pads(): readonly RawPad[];
  keyboard(): KeySnapshot;
  /** Called once per fixed step after sampling: clears deltas and press latches. */
  endStep(): void;
  dispose?(): void;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();
const EMPTY_BTNS: ReadonlySet<number> = new Set();

const EMPTY_SNAPSHOT: KeySnapshot = {
  keys: EMPTY_KEYS, mouseButtons: EMPTY_BTNS,
  mouseDx: 0, mouseDy: 0, wheel: 0, pointerLocked: false, focused: true,
};

/** Sources that never produce anything. Used in capture mode and under node. */
export class NullSources implements InputSources {
  private readonly none: readonly RawPad[] = [];
  pads(): readonly RawPad[] { return this.none; }
  keyboard(): KeySnapshot { return EMPTY_SNAPSHOT; }
  endStep(): void { /* nothing to clear */ }
}

/* ------------------------------------------------------------------ manual */

/**
 * Scriptable sources. This is what the tests, the replay system and any
 * "AI drives a human slot" experiment use. Set state, step, assert.
 */
export class ManualSources implements InputSources {
  private padMap = new Map<number, RawPad>();
  private padList: RawPad[] = [];
  private padsDirty = true;

  private down = new Set<string>();
  private latched = new Set<string>();
  private merged = new Set<string>();
  private mouse = new Set<number>();
  private mouseLatched = new Set<number>();
  private mouseMerged = new Set<number>();
  private dx = 0;
  private dy = 0;
  private wheelAcc = 0;
  focused = true;
  pointerLocked = false;

  private snapshot: KeySnapshot = {
    keys: this.merged, mouseButtons: this.mouseMerged,
    mouseDx: 0, mouseDy: 0, wheel: 0, pointerLocked: false, focused: true,
  };

  /* keyboard */
  setKey(code: string, isDown: boolean): void {
    if (isDown) { this.down.add(code); this.latched.add(code); }
    else this.down.delete(code);
  }
  /** A press and release inside one step — still visible for exactly one step. */
  tapKey(code: string): void { this.latched.add(code); this.down.delete(code); }
  releaseAll(): void { this.down.clear(); this.latched.clear(); this.mouse.clear(); this.mouseLatched.clear(); }

  /* mouse */
  setMouse(button: number, isDown: boolean): void {
    if (isDown) { this.mouse.add(button); this.mouseLatched.add(button); }
    else this.mouse.delete(button);
  }
  moveMouse(dx: number, dy: number): void { this.dx += dx; this.dy += dy; }
  scroll(d: number): void { this.wheelAcc += d; }

  /* pads */
  addPad(index: number, opts: Partial<RawPad> = {}): RawPad {
    const axes = opts.axes ? opts.axes.slice() : [0, 0, 0, 0];
    const nButtons = opts.buttons ? opts.buttons.length : 17;
    const pad: RawPad = {
      index,
      id: opts.id ?? `Manual Pad ${index}`,
      mapping: opts.mapping ?? 'standard',
      connected: opts.connected ?? true,
      axes,
      buttons: opts.buttons ? opts.buttons.slice() : new Array(nButtons).fill(0),
      pressed: opts.pressed ? opts.pressed.slice() : new Array(nButtons).fill(false),
      timestamp: opts.timestamp ?? 0,
    };
    this.padMap.set(index, pad);
    this.padsDirty = true;
    return pad;
  }
  removePad(index: number): void { this.padMap.delete(index); this.padsDirty = true; }

  setAxis(index: number, axis: number, value: number): void {
    const p = this.padMap.get(index);
    if (!p) return;
    (p.axes as number[])[axis] = value;
    p.timestamp += 1;
  }
  setButton(index: number, button: number, value: number): void {
    const p = this.padMap.get(index);
    if (!p) return;
    (p.buttons as number[])[button] = value;
    (p.pressed as boolean[])[button] = value > 0.5;
    p.timestamp += 1;
  }

  pads(): readonly RawPad[] {
    if (this.padsDirty) {
      this.padList = [...this.padMap.values()].sort((a, b) => a.index - b.index);
      this.padsDirty = false;
    }
    return this.padList;
  }

  keyboard(): KeySnapshot {
    this.merged.clear();
    for (const k of this.down) this.merged.add(k);
    for (const k of this.latched) this.merged.add(k);
    this.mouseMerged.clear();
    for (const b of this.mouse) this.mouseMerged.add(b);
    for (const b of this.mouseLatched) this.mouseMerged.add(b);
    const s = this.snapshot as { mouseDx: number; mouseDy: number; wheel: number; pointerLocked: boolean; focused: boolean };
    s.mouseDx = this.dx; s.mouseDy = this.dy; s.wheel = this.wheelAcc;
    s.pointerLocked = this.pointerLocked; s.focused = this.focused;
    return this.snapshot;
  }

  endStep(): void {
    this.latched.clear();
    this.mouseLatched.clear();
    this.dx = 0; this.dy = 0; this.wheelAcc = 0;
  }
}

/* --------------------------------------------------------------------- dom */

export interface DomSourcesOptions {
  /** Element that receives key/mouse events. Defaults to `window`. */
  target?: EventTarget | null;
  /** Element to request pointer lock on. */
  lockTarget?: { requestPointerLock?: () => void } | null;
  /** Override for tests. Defaults to `navigator`. */
  nav?: { getGamepads?: () => (Gamepad | null)[] } | null;
  /** Swallow browser defaults for bound keys (space scrolling, etc). */
  preventDefault?: boolean;
}

/**
 * Real browser sources. Constructing this when there is no DOM is safe: it
 * simply never reports anything, so the same code path runs under node.
 */
export class DomSources implements InputSources {
  private down = new Set<string>();
  private latched = new Set<string>();
  private merged = new Set<string>();
  private mouseDown = new Set<number>();
  private mouseLatched = new Set<number>();
  private mouseMerged = new Set<number>();
  private dx = 0;
  private dy = 0;
  private wheelAcc = 0;
  private focused = true;
  private attached = false;
  private target: EventTarget | null = null;
  private nav: { getGamepads?: () => (Gamepad | null)[] } | null = null;
  private preventDefault: boolean;
  private padScratch: RawPad[] = [];
  private padOut: RawPad[] = [];

  private snapshot: KeySnapshot = {
    keys: this.merged, mouseButtons: this.mouseMerged,
    mouseDx: 0, mouseDy: 0, wheel: 0, pointerLocked: false, focused: true,
  };

  constructor(opts: DomSourcesOptions = {}) {
    this.preventDefault = opts.preventDefault ?? true;
    const hasWindow = typeof window !== 'undefined';
    this.target = opts.target ?? (hasWindow ? window : null);
    this.nav = opts.nav ?? (typeof navigator !== 'undefined' ? (navigator as unknown as { getGamepads?: () => (Gamepad | null)[] }) : null);
    if (this.target && typeof (this.target as { addEventListener?: unknown }).addEventListener === 'function') {
      this.attach();
    }
  }

  private onKeyDown = (e: Event): void => {
    const k = e as KeyboardEvent;
    if (k.repeat) return;
    this.down.add(k.code);
    this.latched.add(k.code);
    if (this.preventDefault && SWALLOW.has(k.code)) k.preventDefault?.();
  };
  private onKeyUp = (e: Event): void => { this.down.delete((e as KeyboardEvent).code); };
  private onMouseDown = (e: Event): void => {
    const m = e as MouseEvent;
    this.mouseDown.add(m.button);
    this.mouseLatched.add(m.button);
  };
  private onMouseUp = (e: Event): void => { this.mouseDown.delete((e as MouseEvent).button); };
  private onMouseMove = (e: Event): void => {
    const m = e as MouseEvent;
    this.dx += m.movementX ?? 0;
    this.dy += m.movementY ?? 0;
  };
  private onWheel = (e: Event): void => { this.wheelAcc += (e as WheelEvent).deltaY ?? 0; };
  private onBlur = (): void => {
    this.focused = false;
    this.down.clear(); this.mouseDown.clear();
  };
  private onFocus = (): void => { this.focused = true; };
  private onContext = (e: Event): void => { if (this.preventDefault) e.preventDefault?.(); };

  private attach(): void {
    const t = this.target!;
    t.addEventListener('keydown', this.onKeyDown as EventListener);
    t.addEventListener('keyup', this.onKeyUp as EventListener);
    t.addEventListener('mousedown', this.onMouseDown as EventListener);
    t.addEventListener('mouseup', this.onMouseUp as EventListener);
    t.addEventListener('mousemove', this.onMouseMove as EventListener);
    t.addEventListener('wheel', this.onWheel as EventListener, { passive: true } as AddEventListenerOptions);
    t.addEventListener('blur', this.onBlur as EventListener);
    t.addEventListener('focus', this.onFocus as EventListener);
    t.addEventListener('contextmenu', this.onContext as EventListener);
    this.attached = true;
  }

  pads(): readonly RawPad[] {
    const get = this.nav?.getGamepads;
    if (!get) { this.padOut.length = 0; return this.padOut; }
    const list = get.call(this.nav) ?? [];
    this.padOut.length = 0;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      if (!g || !g.connected) continue;
      let slot = this.padScratch[i];
      if (!slot) {
        slot = { index: i, id: '', mapping: '', connected: false, axes: [], buttons: [], pressed: [], timestamp: 0 };
        this.padScratch[i] = slot;
      }
      const s = slot as {
        index: number; id: string; mapping: string; connected: boolean;
        axes: number[]; buttons: number[]; pressed: boolean[]; timestamp: number;
      };
      s.index = g.index;
      s.id = g.id;
      s.mapping = g.mapping;
      s.connected = true;
      s.timestamp = g.timestamp;
      s.axes.length = g.axes.length;
      for (let a = 0; a < g.axes.length; a++) s.axes[a] = g.axes[a];
      s.buttons.length = g.buttons.length;
      s.pressed.length = g.buttons.length;
      for (let b = 0; b < g.buttons.length; b++) {
        s.buttons[b] = g.buttons[b].value;
        s.pressed[b] = g.buttons[b].pressed;
      }
      this.padOut.push(slot);
    }
    return this.padOut;
  }

  keyboard(): KeySnapshot {
    this.merged.clear();
    for (const k of this.down) this.merged.add(k);
    for (const k of this.latched) this.merged.add(k);
    this.mouseMerged.clear();
    for (const b of this.mouseDown) this.mouseMerged.add(b);
    for (const b of this.mouseLatched) this.mouseMerged.add(b);
    const s = this.snapshot as { mouseDx: number; mouseDy: number; wheel: number; pointerLocked: boolean; focused: boolean };
    s.mouseDx = this.dx; s.mouseDy = this.dy; s.wheel = this.wheelAcc;
    s.pointerLocked = typeof document !== 'undefined' && document.pointerLockElement != null;
    s.focused = this.focused;
    return this.snapshot;
  }

  endStep(): void {
    this.latched.clear();
    this.mouseLatched.clear();
    this.dx = 0; this.dy = 0; this.wheelAcc = 0;
  }

  dispose(): void {
    if (!this.attached || !this.target) return;
    const t = this.target;
    t.removeEventListener('keydown', this.onKeyDown as EventListener);
    t.removeEventListener('keyup', this.onKeyUp as EventListener);
    t.removeEventListener('mousedown', this.onMouseDown as EventListener);
    t.removeEventListener('mouseup', this.onMouseUp as EventListener);
    t.removeEventListener('mousemove', this.onMouseMove as EventListener);
    t.removeEventListener('wheel', this.onWheel as EventListener);
    t.removeEventListener('blur', this.onBlur as EventListener);
    t.removeEventListener('focus', this.onFocus as EventListener);
    t.removeEventListener('contextmenu', this.onContext as EventListener);
    this.attached = false;
  }
}

/** Keys whose browser default would fight the game. */
const SWALLOW: ReadonlySet<string> = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab',
  'F1', 'Slash', 'Quote',
]);
