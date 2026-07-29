import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';

/** STUB — to be replaced wholesale. */
export class GrassSystem implements System {
  readonly name = 'grass';
  readonly order = 3;
  init(ctx: Ctx): void {}
}
