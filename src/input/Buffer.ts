/**
 * Input buffering.
 *
 * Every press is recorded with the time it happened. A system that could not
 * act on it yet — you pressed layout a frame before the disc came into range,
 * you pressed throw while still catching — asks for it again a few steps later
 * and still gets it. The absence of this is the single biggest reason amateur
 * games feel unresponsive: the input was correct, the game just was not
 * listening at that exact millisecond.
 *
 * Windows are in seconds and the clock is the fixed-step sim clock, so buffer
 * behaviour is identical at any frame rate and reproducible in tests.
 */

export interface BufferOptions {
  /** Default window, seconds. 0.12 s ~= 14 steps at 120 Hz, ~7 frames at 60 fps. */
  window: number;
  /** Ring capacity. Older presses are dropped when it wraps. */
  capacity: number;
}

export const DEFAULT_BUFFER: BufferOptions = { window: 0.12, capacity: 32 };

interface Slot { action: string; t: number; consumed: boolean }

export class InputBuffer {
  readonly capacity: number;
  window: number;
  /** Per-action window overrides, seconds. */
  readonly overrides = new Map<string, number>();

  private slots: Slot[];
  private head = 0;
  private count = 0;

  constructor(opts: Partial<BufferOptions> = {}) {
    const o = { ...DEFAULT_BUFFER, ...opts };
    this.window = o.window;
    this.capacity = Math.max(4, o.capacity | 0);
    this.slots = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.slots[i] = { action: '', t: 0, consumed: true };
  }

  /** Window that applies to `action`. */
  windowFor(action: string): number {
    const w = this.overrides.get(action);
    return w === undefined ? this.window : w;
  }

  setWindow(action: string, seconds: number): void { this.overrides.set(action, seconds); }

  /** Record a press. Newest wins; the ring drops the oldest when full. */
  press(action: string, t: number): void {
    const s = this.slots[this.head];
    s.action = action; s.t = t; s.consumed = false;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Is there a live (unconsumed, unexpired) press of `action`? Does not consume. */
  peek(action: string, now: number, window?: number): boolean {
    return this.findLatest(action, now, window ?? this.windowFor(action)) >= 0;
  }

  /**
   * Seconds since the most recent live press of `action`, or -1 if there is
   * none. Useful for "how late was I" scoring.
   */
  age(action: string, now: number, window?: number): number {
    const i = this.findLatest(action, now, window ?? this.windowFor(action));
    return i < 0 ? -1 : now - this.slots[i].t;
  }

  /**
   * Consume the most recent live press of `action`. Older unconsumed presses of
   * the same action are consumed too, so one hold-and-mash cannot fire twice.
   */
  consume(action: string, now: number, window?: number): boolean {
    const w = window ?? this.windowFor(action);
    const i = this.findLatest(action, now, w);
    if (i < 0) return false;
    for (let k = 0; k < this.capacity; k++) {
      const s = this.slots[k];
      if (s.action === action) s.consumed = true;
    }
    return true;
  }

  /** Drop everything, or just one action's presses. */
  clear(action?: string): void {
    for (let k = 0; k < this.capacity; k++) {
      const s = this.slots[k];
      if (action === undefined || s.action === action) { s.action = ''; s.t = 0; s.consumed = true; }
    }
    if (action === undefined) { this.count = 0; this.head = 0; }
  }

  /** Number of live presses right now — diagnostics only. */
  live(now: number): number {
    let n = 0;
    for (let k = 0; k < this.capacity; k++) {
      const s = this.slots[k];
      if (!s.consumed && s.action !== '' && now - s.t <= this.windowFor(s.action)) n++;
    }
    return n;
  }

  private findLatest(action: string, now: number, window: number): number {
    let best = -1;
    let bestT = -Infinity;
    for (let k = 0; k < this.capacity; k++) {
      const s = this.slots[k];
      if (s.consumed || s.action !== action) continue;
      const age = now - s.t;
      if (age < -1e-9 || age > window) continue;
      if (s.t > bestT) { bestT = s.t; best = k; }
    }
    return best;
  }
}
