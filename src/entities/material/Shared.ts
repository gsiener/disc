import * as THREE from 'three';
import type { Ctx, QualityTier } from '../../core/Ctx.ts';

/**
 * Uniforms that are the same for every athlete on the pitch, held as ONE object
 * per name and spliced into every compiled shader. three reads `uniform.value`
 * off the material at draw time, so sharing the object means the sun moves for
 * ninety-eight materials with three writes per frame instead of two hundred.
 */
export type MatDetail = 0 | 1 | 2;

export function detailForTier(tier: QualityTier): MatDetail {
  return tier === 'low' ? 0 : tier === 'medium' ? 1 : 2;
}

export class SharedUniforms {
  readonly uniforms: Record<string, { value: any }>;
  private sunWorld = new THREE.Vector3(0.35, 0.8, 0.42).normalize();
  private sunColor = new THREE.Color(1, 0.94, 0.86);
  private sunPower = 1;

  constructor() {
    this.uniforms = {
      uTime: { value: 0 },
      /** Sun direction in VIEW space, pointing toward the sun. */
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      /** Scales every shadow-independent scattering term. */
      uSunGlow: { value: 1 },
    };
  }

  /** From the `sun:changed` event, or set directly by a harness. */
  setSun(dir: THREE.Vector3, color?: THREE.Color, intensity = 1): void {
    // The event publishes the direction light TRAVELS. Everything downstream
    // wants the direction TOWARD the source, which is the convention three's own
    // `directLight.direction` uses, so normalise the sign once, here.
    this.sunWorld.copy(dir).normalize();
    if (this.sunWorld.y < 0) this.sunWorld.negate();
    if (color) this.sunColor.copy(color);
    this.sunPower = intensity;
  }

  update(camera: THREE.Camera, time: number): void {
    const u = this.uniforms;
    u.uTime.value = time;
    (u.uSunView.value as THREE.Vector3)
      .copy(this.sunWorld).transformDirection(camera.matrixWorldInverse);
    (u.uSunColor.value as THREE.Color).copy(this.sunColor);
    // A low sun is what makes translucency read; a high one washes it out, and
    // at night there is no sun to scatter at all.
    const elev = Math.max(0, this.sunWorld.y);
    u.uSunGlow.value = this.sunPower * (0.35 + 0.85 * (1 - elev) * (elev > 0.02 ? 1 : 0.12));
  }

  bind(ctx: Ctx): () => void {
    const off = ctx.events.on('sun:changed', (p: any) => {
      if (!p?.dir) return;
      this.setSun(
        p.dir instanceof THREE.Vector3 ? p.dir : new THREE.Vector3().fromArray(p.dir),
        p.color instanceof THREE.Color ? p.color : undefined,
        typeof p.intensity === 'number' ? Math.min(4, p.intensity) : 1,
      );
    });
    return off;
  }
}
