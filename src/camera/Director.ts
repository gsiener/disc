import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';

/** STUB — to be replaced wholesale. */
export class CameraDirector implements System {
  readonly name = 'camera';
  readonly order = 10;
  init(ctx: Ctx): void {}
}
