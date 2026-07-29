import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';

/** STUB — to be replaced wholesale. */
export class SkySystem implements System {
  readonly name = 'sky';
  readonly order = 0;
  init(ctx: Ctx): void {
    ctx.scene.background = new THREE.Color(0x8fb7e8);
    ctx.scene.fog = new THREE.Fog(0x9fc0e8, 60, 420);}
}
