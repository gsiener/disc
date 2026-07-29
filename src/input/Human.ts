/**
 * Human -> intent.
 *
 * Turns raw devices into exactly the same `PlayerIntent` the AI produces. Pad
 * first: if a pad is present and being driven it wins; otherwise keyboard and
 * mouse feed emulated analogue channels (ramped magnitude, a virtual aim stick
 * on the mouse) so the fallback is genuinely playable rather than a debug hack.
 *
 * Gates let the game say "not right now" without the player losing the input:
 * a press that a gate rejects stays in the buffer and fires the moment the gate
 * opens, which is what makes the controls feel like they are ahead of you
 * rather than behind you.
 */

import {
  applyStick, applyTrigger, clamp, clamp01, clampUnit, mag2, moveTowards,
  angleDelta, vec2,
} from './Curves.ts';
import { InputBuffer } from './Buffer.ts';
import { ActionMap, AXIS_ACTIONS, BUTTON_ACTIONS, type AxisAction, type ButtonAction } from './ActionMap.ts';
import { PadManager, readPadAxis, readPadButton, type PadInfo } from './Pad.ts';
import type { InputSources, KeySnapshot } from './Sources.ts';
import { ThrowController, type ChargeInput } from './Throw.ts';
import { makeIntent, resetIntent, type IntentSource, type PlayerIntent } from './Intent.ts';

/** What the game currently permits. Everything defaults to allowed. */
export interface IntentGates {
  canThrow: boolean;
  canBid: boolean;
  canLayout: boolean;
  canSwitch: boolean;
  canCycleReceiver: boolean;
  /** True when this player is holding the disc — enables the charge path. */
  hasDisc: boolean;
  /** True when this player's team is on defence — enables mark/force/switch. */
  onDefence: boolean;
}

export function defaultGates(): IntentGates {
  return {
    canThrow: true, canBid: true, canLayout: true, canSwitch: true,
    canCycleReceiver: true, hasDisc: true, onDefence: false,
  };
}

const NB = BUTTON_ACTIONS.length;
const BUTTON_INDEX: Record<ButtonAction, number> = (() => {
  const m = {} as Record<ButtonAction, number>;
  for (let i = 0; i < NB; i++) m[BUTTON_ACTIONS[i]] = i;
  return m;
})();

export interface HumanOptions {
  playerId: number;
  /** Local player slot; decides which pad drives this controller. */
  slot: number;
}

export class HumanController implements IntentSource {
  readonly kind = 'human' as const;
  readonly intent: PlayerIntent;
  readonly buffer: InputBuffer;
  readonly throwCtl: ThrowController;
  readonly gates: IntentGates = defaultGates();

  map: ActionMap;
  slot: number;

  /** Yaw the camera looks along; movement and aim are expressed relative to it. */
  cameraYaw = 0;
  /** The controlled player's actual facing, fed back by the game each step. */
  facingYaw = 0;
  /** Receiver the game says is currently selected (echoed into releases). */
  selectedReceiverId = -1;

  private value = new Float32Array(NB);
  private downNow = new Uint8Array(NB);
  private downPrev = new Uint8Array(NB);

  private kbMove = vec2();
  private kbMoveMag = 0;
  private kbSprint = 0;
  private kbBrake = 0;
  private mouseAim = vec2();
  private padVec = vec2();
  private aimVec = vec2();
  private moveVec = vec2();

  private prevAimYaw = 0;
  private hasPrevAim = false;
  private aimRate = 0;

  private selectDir = vec2();
  private selectHold = 0;
  private selectActive = false;

  private force: -1 | 1 = 1;
  private stepIndex = 0;
  private prevSlot = -1;

  constructor(map: ActionMap, opts: Partial<HumanOptions> = {}) {
    this.map = map;
    this.slot = opts.slot ?? 0;
    this.intent = makeIntent(opts.playerId ?? 0, 'human');
    const c = map.config;
    this.buffer = new InputBuffer({ window: c.bufferTime });
    for (const a of BUTTON_ACTIONS) {
      const w = c.bufferOverrides[a];
      if (w !== undefined) this.buffer.setWindow(a, w);
    }
    this.throwCtl = new ThrowController({
      timing: c.timing, tiltSpan: c.tiltSpan, curveModTilt: c.curveModTilt, fakeTime: c.fakeTime,
    });
  }

  /** Re-read tunables after a config change (controls screen, loaded profile). */
  refreshFromConfig(): void {
    const c = this.map.config;
    this.buffer.window = c.bufferTime;
    this.buffer.overrides.clear();
    for (const a of BUTTON_ACTIONS) {
      const w = c.bufferOverrides[a];
      if (w !== undefined) this.buffer.setWindow(a, w);
    }
    this.throwCtl.opts = {
      timing: c.timing, tiltSpan: c.tiltSpan, curveModTilt: c.curveModTilt, fakeTime: c.fakeTime,
    };
  }

  setGates(g: Partial<IntentGates>): void { Object.assign(this.gates, g); }

  /**
   * Sources are supplied per step so the same controller can be replayed.
   * The *owner* is responsible for calling `sources.endStep()` once per step,
   * after every controller reading from them has stepped.
   */
  sources: InputSources | null = null;
  pads: PadManager | null = null;

  attach(sources: InputSources, pads: PadManager): void {
    this.sources = sources;
    this.pads = pads;
  }

  step(dt: number, now: number): PlayerIntent {
    const intent = resetIntent(this.intent);
    intent.step = this.stepIndex++;
    intent.t = now;

    const src = this.sources;
    const kb: KeySnapshot | null = src ? src.keyboard() : null;
    const pad: PadInfo | null = this.pads ? this.pads.forSlot(this.slot) : null;
    const c = this.map.config;
    const muted = kb ? !kb.focused : false;

    /* ---- buttons ------------------------------------------------------- */
    for (let i = 0; i < NB; i++) {
      this.downPrev[i] = this.downNow[i];
      const a = BUTTON_ACTIONS[i];
      const v = muted ? 0 : this.readButton(a, kb, pad);
      this.value[i] = v;
      this.downNow[i] = v > 0.5 ? 1 : 0;
      if (this.downNow[i] && !this.downPrev[i]) this.buffer.press(a, now);
    }

    /* ---- movement ------------------------------------------------------ */
    const stickX = pad ? this.readPadAxisFor('moveX', pad) : 0;
    const stickY = pad ? this.readPadAxisFor('moveY', pad) : 0;
    applyStick(stickX, stickY, c.stick, this.padVec);

    const kx = muted ? 0 : this.keyAxis('moveX', kb);
    const ky = muted ? 0 : this.keyAxis('moveY', kb);
    const kMag = Math.sqrt(kx * kx + ky * ky);
    if (kMag > 1e-6) { this.kbMove.x = kx / kMag; this.kbMove.y = ky / kMag; }
    this.kbMoveMag = rampTowards(this.kbMoveMag, kMag > 1e-6 ? 1 : 0, dt, c.keyboardRamp, c.keyboardRelease);

    const padMag = mag2(this.padVec);
    if (padMag >= this.kbMoveMag) {
      this.moveVec.x = this.padVec.x; this.moveVec.y = this.padVec.y;
    } else {
      this.moveVec.x = this.kbMove.x * this.kbMoveMag;
      this.moveVec.y = this.kbMove.y * this.kbMoveMag;
    }
    const cy = Math.cos(this.cameraYaw);
    const sy = Math.sin(this.cameraYaw);
    const mv = intent.move;
    mv.x = this.moveVec.x * cy + this.moveVec.y * sy;
    mv.z = -this.moveVec.x * sy + this.moveVec.y * cy;
    mv.mag = Math.min(1, Math.sqrt(mv.x * mv.x + mv.z * mv.z));

    /* ---- sprint / brake ------------------------------------------------ */
    const padSprint = pad ? applyTrigger(this.readPadButtonFor('sprint', pad), c.trigger) : 0;
    const padBrake = pad ? applyTrigger(this.readPadButtonFor('brake', pad), c.trigger) : 0;
    this.kbSprint = rampTowards(this.kbSprint, muted ? 0 : this.keyPositive('sprint', kb), dt, c.keyboardRamp, c.keyboardRelease);
    this.kbBrake = rampTowards(this.kbBrake, muted ? 0 : this.keyPositive('brake', kb), dt, c.keyboardRamp, c.keyboardRelease);
    mv.sprint = clamp01(Math.max(padSprint, this.kbSprint));
    mv.brake = clamp01(Math.max(padBrake, this.kbBrake));

    /* ---- aim ----------------------------------------------------------- */
    const ax = pad ? this.readPadAxisFor('aimX', pad) : 0;
    const ay = pad ? this.readPadAxisFor('aimY', pad) : 0;
    applyStick(ax, ay, c.aimStick, this.aimVec);
    const padAimMag = mag2(this.aimVec);

    if (kb && !muted) {
      const invert = c.invertAimY ? -1 : 1;
      const mdx = kb.mouseDx * c.mouseSensitivity;
      const mdy = kb.mouseDy * c.mouseSensitivity * invert;
      if (mdx !== 0 || mdy !== 0) {
        this.mouseAim.x += mdx;
        this.mouseAim.y -= mdy;             // screen-down is field-backwards
        clampUnit(this.mouseAim);
      } else if (c.mouseRecenter > 0) {
        const m = mag2(this.mouseAim);
        const nm = Math.max(0, m - c.mouseRecenter * dt);
        if (m > 1e-6) { this.mouseAim.x *= nm / m; this.mouseAim.y *= nm / m; }
      }
    }
    const mouseMag = mag2(this.mouseAim);
    if (mouseMag > padAimMag) { this.aimVec.x = this.mouseAim.x; this.aimVec.y = this.mouseAim.y; }

    const aimMag = mag2(this.aimVec);
    const aim = intent.aim;
    if (aimMag > 1e-4) {
      const wx = this.aimVec.x * cy + this.aimVec.y * sy;
      const wz = -this.aimVec.x * sy + this.aimVec.y * cy;
      const inv = 1 / Math.max(1e-6, Math.sqrt(wx * wx + wz * wz));
      aim.x = wx * inv; aim.z = wz * inv;
      aim.mag = Math.min(1, aimMag);
      aim.yaw = Math.atan2(aim.x, aim.z);
      aim.active = true;
      const inst = this.hasPrevAim ? Math.abs(angleDelta(this.prevAimYaw, aim.yaw)) / Math.max(1e-6, dt) : 0;
      this.aimRate += (inst - this.aimRate) * 0.35;
      this.prevAimYaw = aim.yaw;
      this.hasPrevAim = true;
    } else {
      aim.x = 0; aim.z = 0; aim.mag = 0; aim.active = false;
      aim.yaw = this.hasPrevAim ? this.prevAimYaw : this.facingYaw;
      this.aimRate += (0 - this.aimRate) * 0.35;
      this.hasPrevAim = false;
    }
    aim.rate = this.aimRate;

    /* ---- throw --------------------------------------------------------- */
    const canCharge = this.gates.canThrow && this.gates.hasDisc;
    let chargePressed = false;
    if (canCharge && !this.throwCtl.active && this.buffer.peek('throw', now)) {
      this.buffer.consume('throw', now);
      chargePressed = true;
    }
    const ci: ChargeInput = this.chargeInput;
    ci.chargeDown = this.isDown('throw');
    ci.chargePressed = chargePressed;
    ci.chargeReleased = this.released('throw');
    ci.cancelPressed = this.pressed('cancel');
    ci.modA = this.isDown('throwModA');
    ci.modB = this.isDown('throwModB');
    ci.curveLeft = this.analog('curveLeft');
    ci.curveRight = this.analog('curveRight');
    ci.aimActive = aim.active;
    ci.aimYaw = aim.yaw;
    ci.aimRate = aim.rate;
    ci.facingYaw = this.facingYaw;
    ci.targetId = this.selectedReceiverId;

    this.throwCtl.step(dt, ci, intent.charge, intent.release);
    if (this.throwCtl.cancelled) {
      intent.cancel = true;
      intent.fake = this.throwCtl.fake;
      this.buffer.clear('throw');
    }
    if (!canCharge && this.throwCtl.active) {
      // The game revoked the disc mid-charge (stripped, turnover): drop it.
      this.throwCtl.reset();
      intent.charge.active = false;
    }

    /* ---- receiver ------------------------------------------------------ */
    const rc = intent.receiver;
    if (this.gates.canCycleReceiver) {
      let cycle = 0;
      if (this.buffer.consume('receiverNext', now)) cycle += 1;
      if (this.buffer.consume('receiverPrev', now)) cycle -= 1;
      rc.cycle = cycle > 0 ? 1 : cycle < 0 ? -1 : 0;
    }

    const selecting = aim.active && aim.mag >= c.selectThreshold;
    if (selecting) {
      const changed = !this.selectActive
        || (this.selectDir.x * aim.x + this.selectDir.y * aim.z) < 0.5;   // >60 deg swing
      if (changed) {
        this.selectDir.x = aim.x; this.selectDir.y = aim.z;
        this.selectHold = 0;
        rc.selectFresh = true;
      } else {
        this.selectHold += dt;
      }
      this.selectActive = true;
      rc.selectX = this.selectDir.x;
      rc.selectZ = this.selectDir.y;
      rc.holdTime = this.selectHold;
      rc.callCut = this.selectHold >= c.cutHoldTime;
    } else {
      this.selectActive = false;
      this.selectHold = 0;
      rc.holdTime = 0;
      rc.callCut = false;
    }
    // Keyboard direct-select: the "receiver icons" affordance, on the number row.
    if (kb && !muted && this.gates.canCycleReceiver) {
      let slot = -1;
      const keys = c.receiverSlotKeys;
      for (let i = 0; i < keys.length; i++) if (kb.keys.has(keys[i])) { slot = i; break; }
      if (slot >= 0 && slot !== this.prevSlot) rc.slot = slot;
      this.prevSlot = slot;
    }

    if (this.isDown('callCut') && !this.gates.onDefence) {
      rc.callCut = true;
      if (rc.selectX === 0 && rc.selectZ === 0) { rc.selectX = mv.x; rc.selectZ = mv.z; }
    }

    /* ---- defence ------------------------------------------------------- */
    const df = intent.defence;
    df.bidHeld = this.isDown('bid');
    if (this.gates.canBid && this.buffer.consume('bid', now)) df.bid = true;
    if (this.gates.canLayout && this.buffer.consume('layout', now)) {
      df.layout = true;
      let lx = mv.x, lz = mv.z;
      if (mv.mag < 0.15 && aim.active) { lx = aim.x; lz = aim.z; }
      const lm = Math.sqrt(lx * lx + lz * lz);
      if (lm > 1e-6) { df.layoutX = lx / lm; df.layoutZ = lz / lm; }
      else { df.layoutX = Math.sin(this.facingYaw); df.layoutZ = Math.cos(this.facingYaw); }
    }
    if (this.gates.canSwitch && this.buffer.consume('switchDefender', now)) df.switchRequested = true;
    df.markHeld = this.gates.onDefence && this.isDown('mark');
    if (this.pressed('forceFlip')) { this.force = this.force === 1 ? -1 : 1; df.forceFlipped = true; }
    df.force = this.force;

    intent.pivot = this.pressed('pivot');
    return intent;
  }

  /* ------------------------------------------------------------- helpers */

  private chargeInput: ChargeInput = {
    chargeDown: false, chargePressed: false, chargeReleased: false, cancelPressed: false,
    modA: false, modB: false, curveLeft: 0, curveRight: 0,
    aimActive: false, aimYaw: 0, aimRate: 0, facingYaw: 0, targetId: -1,
  };

  analog(a: ButtonAction): number { return this.value[BUTTON_INDEX[a]]; }
  isDown(a: ButtonAction): boolean { return this.downNow[BUTTON_INDEX[a]] === 1; }
  pressed(a: ButtonAction): boolean {
    const i = BUTTON_INDEX[a];
    return this.downNow[i] === 1 && this.downPrev[i] === 0;
  }
  released(a: ButtonAction): boolean {
    const i = BUTTON_INDEX[a];
    return this.downNow[i] === 0 && this.downPrev[i] === 1;
  }

  private readButton(a: ButtonAction, kb: KeySnapshot | null, pad: PadInfo | null): number {
    const b = this.map.config.buttons[a];
    let v = 0;
    if (kb) {
      for (let i = 0; i < b.keys.length; i++) if (kb.keys.has(b.keys[i])) { v = 1; break; }
      if (v < 1) for (let i = 0; i < b.mouse.length; i++) if (kb.mouseButtons.has(b.mouse[i])) { v = 1; break; }
    }
    if (pad && v < 1) {
      for (let i = 0; i < b.pad.length; i++) {
        const pv = readPadButton(pad.pad, pad.layout, b.pad[i]);
        if (pv > v) v = pv;
      }
    }
    return v;
  }

  private readPadAxisFor(a: AxisAction, pad: PadInfo): number {
    const b = this.map.config.axes[a];
    if (!b.padAxis) return 0;
    const raw = readPadAxis(pad.pad, pad.layout, b.padAxis) * b.scale;
    return b.invert ? -raw : raw;
  }

  private readPadButtonFor(a: AxisAction, pad: PadInfo): number {
    const b = this.map.config.axes[a];
    if (!b.padButton) return 0;
    return readPadButton(pad.pad, pad.layout, b.padButton) * Math.abs(b.scale);
  }

  private keyAxis(a: AxisAction, kb: KeySnapshot | null): number {
    if (!kb) return 0;
    const b = this.map.config.axes[a];
    let v = 0;
    for (let i = 0; i < b.pos.length; i++) if (kb.keys.has(b.pos[i])) { v += 1; break; }
    for (let i = 0; i < b.neg.length; i++) if (kb.keys.has(b.neg[i])) { v -= 1; break; }
    return clamp(v, -1, 1);
  }

  private keyPositive(a: AxisAction, kb: KeySnapshot | null): number {
    if (!kb) return 0;
    const b = this.map.config.axes[a];
    for (let i = 0; i < b.pos.length; i++) if (kb.keys.has(b.pos[i])) return 1;
    return 0;
  }
}

/** Asymmetric rate-limited ramp: fast on the way up, faster on the way down. */
export function rampTowards(cur: number, target: number, dt: number, riseTime: number, fallTime: number): number {
  const t = clamp01(target);
  const time = t > cur ? riseTime : fallTime;
  return moveTowards(cur, t, dt / Math.max(1e-6, time));
}

/** Exported so tests and tools can enumerate the same order the controller uses. */
export { AXIS_ACTIONS, BUTTON_ACTIONS };
