import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';

/** STUB — to be replaced wholesale. */
export class PostFXSystem implements System {
  readonly name = 'postfx';
  readonly order = 100;
  init(ctx: Ctx): void {}
}
