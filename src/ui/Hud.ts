import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';

/** STUB — to be replaced wholesale. */
export class HudSystem implements System {
  readonly name = 'hud';
  readonly order = 11;
  init(ctx: Ctx): void {}
}
