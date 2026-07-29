import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';

/** STUB — to be replaced wholesale. */
export class GameSystem implements System {
  readonly name = 'game';
  readonly order = 8;
  init(ctx: Ctx): void {}
}
