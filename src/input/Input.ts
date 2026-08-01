/**
 * InputSystem — devices in, intents out.
 *
 * Runs early (order 2) so the intent it produces is consumed by locomotion,
 * throwing and the AI *this* step rather than next one; a step of input latency
 * is 8 ms you can feel. It never dispatches gameplay itself. It writes a
 * `PlayerIntent` and publishes it; everything else reads that struct, which is
 * the same struct the AI fills in for the other thirteen players.
 *
 * Peers are discovered through `ctx.sys` and every hook is optional, so this
 * system runs correctly on its own with the rest of the game still stubbed.
 */

import type { Ctx, System } from '../core/Ctx';

import { ActionMap, type ButtonAction, type InputConfig } from './ActionMap.ts';
import { HumanController, defaultGates, type IntentGates } from './Human.ts';
import { PadManager, type PadEvent } from './Pad.ts';
import { DomSources, NullSources, type InputSources } from './Sources.ts';
import { pickSwitchTarget, type DefenderCandidate, type SwitchSituation } from './Switch.ts';
import { cloneIntent, makeIntent, type PlayerIntent } from './Intent.ts';

/** Everything the InputSystem will use from a peer if the peer offers it. */
export interface InputHost {
  /** Which player the local human is driving. */
  controlledPlayerId?: number;
  /** Yaw (atan2(x, z)) the player is currently facing. */
  playerFacing?(playerId: number): number;
  /** What the player is allowed to do this step. */
  intentGates?(playerId: number): Partial<IntentGates>;
  /** Candidates for the switch-player policy. */
  defenderCandidates?(): readonly DefenderCandidate[];
  switchSituation?(): SwitchSituation;
  /** Which receiver is highlighted, echoed back into throw releases. */
  selectedReceiverId?(playerId: number): number;
  /** Accept a switch decision. */
  setControlledPlayer?(playerId: number): void;
}

export type DeviceKind = 'pad' | 'kbm';

const STORAGE_KEY = 'ultimate.input.v1';

export class InputSystem implements System {
  readonly name = 'input';
  /** Before Players/Disc/Game so intents are fresh within the same fixed step. */
  readonly order = 2;

  readonly map = new ActionMap();
  readonly pads = new PadManager();
  readonly human: HumanController;

  /** Intents by player id — humans here, AI systems publish their own. */
  readonly intents = new Map<number, PlayerIntent>();

  /** Last device that produced input; drives on-screen button prompts. */
  device: DeviceKind = 'kbm';

  private sources: InputSources = new NullSources();
  private ownsSources = false;
  private time = 0;
  private padEvents: PadEvent[] = [];
  private enabled = true;
  private idleIntent = makeIntent(-1, 'none');
  private fallbackGates = defaultGates();

  constructor() {
    this.human = new HumanController(this.map, { playerId: 0, slot: 0 });
    this.intents.set(0, this.human.intent);
    this.human.attach(this.sources, this.pads);
  }

  init(ctx: Ctx): void {
    this.loadConfig();
    if (!ctx.capture && typeof window !== 'undefined') {
      this.sources = new DomSources();
      this.ownsSources = true;
    }
    this.human.attach(this.sources, this.pads);
    this.enabled = !ctx.capture;
  }

  /** Swap the device layer — tests, replays, or an AI driving the human slot. */
  setSources(sources: InputSources): void {
    if (this.ownsSources) { this.sources.dispose?.(); this.ownsSources = false; }
    this.sources = sources;
    this.human.attach(sources, this.pads);
  }

  /** Mute input without tearing anything down (menus, cutscenes, replay). */
  setEnabled(on: boolean): void { this.enabled = on; }

  update(dt: number, ctx: Ctx): void {
    this.time += dt;
    const now = this.time;

    this.pads.update(this.sources.pads(), now);
    this.padEvents.length = 0;
    if (this.pads.drainEvents(this.padEvents) > 0) {
      for (const e of this.padEvents) ctx.events.emit('input:pad', e);
    }

    if (!this.enabled) {
      this.sources.endStep();
      return;
    }

    const host = ctx.sys['game'] as unknown as InputHost | undefined;
    const playerId = host?.controlledPlayerId ?? this.human.intent.playerId;
    this.human.intent.playerId = playerId;
    if (!this.intents.has(playerId)) this.intents.set(playerId, this.human.intent);

    // Gates and facing come from the game when it exists; sane defaults if not.
    const gates = host?.intentGates?.(playerId);
    this.human.setGates(gates ?? this.fallbackGates);
    this.human.facingYaw = host?.playerFacing?.(playerId) ?? this.human.facingYaw;
    this.human.selectedReceiverId = host?.selectedReceiverId?.(playerId) ?? this.human.selectedReceiverId;
    this.human.cameraYaw = latchedCameraYaw(ctx, this.human.intent.move.mag);

    const intent = this.human.step(dt, now);

    // Device arbitration for on-screen prompts.
    const active = this.pads.active;
    const padLive = active !== null && active.lastActivity >= now - 1e-6;
    if (padLive && this.device !== 'pad') {
      this.device = 'pad';
      ctx.events.emit('input:device', { device: 'pad' });
    } else if (!padLive && this.device !== 'kbm' && this.pads.count === 0) {
      this.device = 'kbm';
      ctx.events.emit('input:device', { device: 'kbm' });
    }

    /* ---- discrete signals ---------------------------------------------- */
    if (intent.release.fired) {
      ctx.events.emit('input:throw', { playerId, release: intent.release });
    }
    if (intent.cancel) {
      ctx.events.emit('input:cancel', { playerId, fake: intent.fake });
    }
    if (intent.receiver.cycle !== 0 || intent.receiver.selectFresh) {
      ctx.events.emit('input:receiver', {
        playerId,
        cycle: intent.receiver.cycle,
        x: intent.receiver.selectX,
        z: intent.receiver.selectZ,
        callCut: intent.receiver.callCut,
      });
    }
    if (intent.defence.forceFlipped) {
      ctx.events.emit('input:force', { playerId, force: intent.defence.force });
    }
    if (intent.defence.switchRequested) {
      const target = this.resolveSwitch(host, playerId, intent);
      intent.defence.switchTarget = target;
      if (target >= 0) host?.setControlledPlayer?.(target);
      ctx.events.emit('input:switch', { playerId, toId: target });
    }

    // One endStep per fixed step, after every consumer has read the devices.
    this.sources.endStep();
  }

  /* ------------------------------------------------------------- queries */

  /** The local human's intent for this step. */
  get intent(): PlayerIntent { return this.human.intent; }

  /** Charge state for the HUD meter. */
  get charge(): PlayerIntent['charge'] { return this.human.intent.charge; }

  intentFor(playerId: number): PlayerIntent {
    return this.intents.get(playerId) ?? this.idleIntent;
  }

  /** Register an externally-owned intent (an AI system publishing its player). */
  publishIntent(playerId: number, intent: PlayerIntent): void {
    this.intents.set(playerId, intent);
  }

  unpublishIntent(playerId: number): void { this.intents.delete(playerId); }

  /** Snapshot for a replay buffer. Allocates — not for per-step use. */
  snapshot(playerId: number): PlayerIntent { return cloneIntent(this.intentFor(playerId)); }

  /* --------------------------------------------------------------- config */

  /** Apply a whole config (a controls screen's "apply"). */
  applyConfig(cfg: Partial<InputConfig> | Record<string, unknown>): void {
    this.map.config = ActionMap.merge(cfg);
    this.human.refreshFromConfig();
  }

  rebind(
    action: ButtonAction,
    patch: Parameters<ActionMap['rebind']>[1],
    mode?: Parameters<ActionMap['rebind']>[2],
  ): void {
    this.map.rebind(action, patch, mode);
    this.human.refreshFromConfig();
  }

  resetBindings(): void {
    this.map.reset();
    this.human.refreshFromConfig();
  }

  saveConfig(): boolean {
    try {
      if (typeof localStorage === 'undefined') return false;
      localStorage.setItem(STORAGE_KEY, this.map.serialize());
      return true;
    } catch { return false; }
  }

  loadConfig(): boolean {
    try {
      if (typeof localStorage === 'undefined') return false;
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      this.map.config = ActionMap.deserialize(raw).config;
      this.human.refreshFromConfig();
      return true;
    } catch { return false; }
  }

  dispose(): void {
    if (this.ownsSources) this.sources.dispose?.();
    this.intents.clear();
  }

  /* -------------------------------------------------------------- private */

  private resolveSwitch(host: InputHost | undefined, playerId: number, intent: PlayerIntent): number {
    const cands = host?.defenderCandidates?.();
    if (!cands || cands.length === 0) return -1;
    const base = host?.switchSituation?.();
    const sit: SwitchSituation = base ?? {
      discX: 0, discZ: 0, threatX: 0, threatZ: 0, discInAir: false,
    };
    const hx = intent.aim.active ? intent.aim.x : intent.move.x;
    const hz = intent.aim.active ? intent.aim.z : intent.move.z;
    const hintMag = Math.sqrt(hx * hx + hz * hz);
    const hinted: SwitchSituation = hintMag > 0.35
      ? { ...sit, hintX: hx / hintMag, hintZ: hz / hintMag }
      : sit;
    return pickSwitchTarget(cands, hinted, playerId);
  }
}

/**
 * Camera yaw for the movement basis, with the director's post-cut latch applied.
 *
 * Movement is camera-relative, and this is re-read every step — so a broadcast
 * cut would rotate the player's controls out from under their thumb mid-stride.
 * `camera/Director.ts` freezes the yaw at its pre-cut value until the move stick
 * drops below 0.2 and then adopts the new one. Absent a director (or before one
 * has cut anything) this is exactly the live camera yaw.
 */
function latchedCameraYaw(ctx: Ctx, moveMag: number): number {
  const raw = cameraYaw(ctx);
  const dir = ctx.sys['camera'] as unknown as
    { latchYaw?(raw: number, moveMag: number): number } | undefined;
  const y = dir?.latchYaw?.(raw, moveMag);
  return typeof y === 'number' && Number.isFinite(y) ? y : raw;
}

/** Yaw the camera looks along, derived without importing three. */
function cameraYaw(ctx: Ctx): number {
  const cam = ctx.camera as unknown as { matrixWorld?: { elements: ArrayLike<number> } } | undefined;
  const e = cam?.matrixWorld?.elements;
  if (!e) return 0;
  const fx = -e[8];
  const fz = -e[10];
  if (fx === 0 && fz === 0) return 0;
  return Math.atan2(fx, fz);
}

/* Re-exports so peers only ever need `import { ... } from '../input/Input'`. */
export { ActionMap } from './ActionMap.ts';
export { HumanController } from './Human.ts';
export { PadManager } from './Pad.ts';
export { DomSources, NullSources, ManualSources } from './Sources.ts';
export { InputBuffer } from './Buffer.ts';
export * from './Intent.ts';
export { pickSwitchTarget, switchScore, DEFAULT_SWITCH_WEIGHTS } from './Switch.ts';
export type { DefenderCandidate, SwitchSituation } from './Switch.ts';
export { defaultGates } from './Human.ts';
export type { IntentGates } from './Human.ts';
export { BUTTON_ACTIONS, AXIS_ACTIONS, defaultConfig } from './ActionMap.ts';
export type { InputConfig, ButtonAction, AxisAction, ButtonBinding, AxisBinding } from './ActionMap.ts';
export { DEFAULT_TIMING, chargePower, releaseQuality, finalQuality, resolveThrowType } from './Throw.ts';
export type { ThrowTiming } from './Throw.ts';
export type { InputSources, RawPad, KeySnapshot } from './Sources.ts';
