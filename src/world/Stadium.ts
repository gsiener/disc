import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';

/** STUB — to be replaced wholesale. */
export class StadiumSystem implements System {
  readonly name = 'stadium';
  readonly order = 4;
  init(ctx: Ctx): void {}
}
