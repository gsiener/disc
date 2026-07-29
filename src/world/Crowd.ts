import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';

/** STUB — to be replaced wholesale. */
export class CrowdSystem implements System {
  readonly name = 'crowd';
  readonly order = 5;
  init(ctx: Ctx): void {}
}
