import * as THREE from 'three';
import { clamp } from './Attributes.ts';

/**
 * Surface queries against whatever the field system exposes. The field system
 * is authored concurrently, so we never assume it exists nor that it has any
 * particular method — we duck-type `heightAt` / `normalAt` every call and fall
 * back to a flat plane at y=0 with an up normal.
 */

export interface FieldLike {
  heightAt?(x: number, z: number): number;
  normalAt?(x: number, z: number, out?: THREE.Vector3): THREE.Vector3;
}

export interface Surface {
  y: number;
  n: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);

export class GroundProbe {
  /** Set true the first time a real field is found; useful for debug. */
  hasField = false;

  private field: FieldLike | null = null;

  /** Re-resolve the field system off the registry. Cheap; call per frame. */
  bind(sys: Record<string, unknown> | undefined | null): void {
    const f = sys ? (sys['field'] as FieldLike | undefined) : undefined;
    this.field = f && typeof f.heightAt === 'function' ? f : null;
    this.hasField = this.field !== null;
  }

  heightAt(x: number, z: number): number {
    const f = this.field;
    if (!f || typeof f.heightAt !== 'function') return 0;
    const y = f.heightAt(x, z);
    return Number.isFinite(y) ? y : 0;
  }

  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const f = this.field;
    if (!f || typeof f.normalAt !== 'function') return out.copy(UP);
    const nv = f.normalAt(x, z, out);
    if (!nv || !Number.isFinite(nv.x) || !Number.isFinite(nv.y) || nv.y <= 1e-4) {
      return out.copy(UP);
    }
    if (nv !== out) out.copy(nv);
    return out.normalize();
  }

  sample(x: number, z: number, out: Surface): Surface {
    out.y = this.heightAt(x, z);
    this.normalAt(x, z, out.n);
    return out;
  }
}

/**
 * Grade in the direction of travel: +1 is straight up a 45-degree wall.
 * Returns 0 on flat ground or when the direction is degenerate.
 */
export function gradeAlong(n: THREE.Vector3, dx: number, dz: number): number {
  const len = Math.hypot(dx, dz);
  if (len < 1e-6 || n.y <= 1e-4) return 0;
  // Height gradient of the surface is (-nx/ny, -nz/ny); travelling uphill along
  // d means a positive dot with that gradient.
  const gx = -n.x / n.y;
  const gz = -n.z / n.y;
  return (gx * dx + gz * dz) / len;
}

/** Speed/accel multiplier from terrain grade. Fields are near flat, so gentle. */
export function slopeMultiplier(grade: number): number {
  return clamp(1 - 1.6 * grade, 0.6, 1.15);
}
