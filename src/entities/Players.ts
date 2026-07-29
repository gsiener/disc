import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';

/** STUB — to be replaced wholesale. */
export class PlayersSystem implements System {
  readonly name = 'players';
  readonly order = 6;
  init(ctx: Ctx): void {
    const m = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.6 });
    for (let i = 0; i < 14; i++) {
      const p = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 1.1, 6, 12), m);
      p.position.set(ctx.rand.range(-30, 30), 0.92, ctx.rand.range(-40, 40));
      p.castShadow = true; ctx.scene.add(p);
    }}
}
