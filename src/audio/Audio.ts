import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';

/** STUB — to be replaced wholesale. */
export class AudioSystem implements System {
  readonly name = 'audio';
  readonly order = 12;
  init(ctx: Ctx): void {}
}
