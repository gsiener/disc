import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';

/** STUB — to be replaced wholesale. */
export class LightingSystem implements System {
  readonly name = 'lighting';
  readonly order = 1;
  init(ctx: Ctx): void {
    const sun = new THREE.DirectionalLight(0xfff2e0, 3.2);
    sun.position.set(-40, 60, 30); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera as THREE.OrthographicCamera;
    c.left = -70; c.right = 70; c.top = 70; c.bottom = -70; c.far = 220;
    ctx.scene.add(sun, new THREE.HemisphereLight(0xbdd7ff, 0x4a5a3a, 1.1));}
}
