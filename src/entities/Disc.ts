import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';

/** STUB — to be replaced wholesale. */
export class DiscSystem implements System {
  readonly name = 'disc';
  readonly order = 7;
  init(ctx: Ctx): void {
    const d = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.125, 0.026, 32),
      new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.35 }));
    d.position.set(0, 1.7, 2); d.castShadow = true; ctx.scene.add(d);}
}
