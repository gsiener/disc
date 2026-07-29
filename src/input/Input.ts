import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';

/** STUB — to be replaced wholesale. */
export class InputSystem implements System {
  readonly name = 'input';
  readonly order = 9;
  init(ctx: Ctx): void {}
}
