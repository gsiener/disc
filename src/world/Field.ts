import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';

/** STUB — to be replaced wholesale. */
export class FieldSystem implements System {
  readonly name = 'field';
  readonly order = 2;
  init(ctx: Ctx): void {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(220, 140),
      new THREE.MeshStandardMaterial({ color: 0x3c7a34, roughness: 0.95 }));
    g.rotation.x = -Math.PI / 2; g.receiveShadow = true; ctx.scene.add(g);}
}
