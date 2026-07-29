import * as THREE from 'three';
import type { Rng } from '../../core/Ctx';
import { fbm2, clamp, smoothstep } from '../../util/Noise';
import { FIELD } from './Layout';

/**
 * CPU-side wear accumulator, uploaded to the turf shader as a data texture.
 *
 *   R — wear      0 = pristine sward, 1 = bare soil
 *   G — chalk cut how much line paint has been scuffed off
 *   B — mud       damp, churned soil (endzone lines, brick marks)
 *   A — spare
 *
 * It is seeded at init with the wear a real pitch carries after a season (the
 * middle lane, the goal-line scrimmage bands, the brick marks, the standing
 * strip behind each sideline) and then accumulates live from footsteps and
 * layouts, so the pitch visibly degrades where play actually happened.
 */
export class WearMap {
  readonly w: number;
  readonly h: number;
  readonly minX: number; readonly minZ: number;
  readonly spanX: number; readonly spanZ: number;
  readonly data: Uint8Array;
  readonly tex: THREE.DataTexture;

  private dirty = false;
  private lastUpload = -999;

  constructor(w: number, h: number) {
    this.w = w; this.h = h;
    this.minX = -FIELD.turfHalfX - 1;
    this.minZ = -FIELD.turfHalfZ - 1;
    this.spanX = 2 * (FIELD.turfHalfX + 1);
    this.spanZ = 2 * (FIELD.turfHalfZ + 1);
    this.data = new Uint8Array(w * h * 4);

    this.tex = new THREE.DataTexture(this.data, w, h, THREE.RGBAFormat);
    this.tex.name = 'field.wear';
    this.tex.colorSpace = THREE.NoColorSpace;
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = true;
    this.tex.needsUpdate = true;
  }

  private get stepX(): number { return this.spanX / this.w; }
  private get stepZ(): number { return this.spanZ / this.h; }

  /* ------------------------------------------------------------- seeding */

  /** Bakes a season of play into the map before the first frame. */
  seed(rand: Rng): void {
    const r = rand.fork(0x51ee);
    const jitterSeed = r.int(0, 9999);
    const { w, h, data } = this;
    for (let py = 0; py < h; py++) {
      const z = this.minZ + (py + 0.5) * this.stepZ;
      for (let px = 0; px < w; px++) {
        const x = this.minX + (px + 0.5) * this.stepX;

        const inX = 1 - smoothstep(FIELD.halfWidth - 1.5, FIELD.halfWidth + 3.5, Math.abs(x));
        const inZ = 1 - smoothstep(FIELD.halfLength - 3, FIELD.halfLength + 4, Math.abs(z));
        const inField = inX * inZ;

        // central running lane — most traffic is up the guts of the field
        const lane = Math.exp(-(x * x) / (2 * 8.5 * 8.5));
        let wear = 0.40 * lane * inField;

        // goal lines: pull line-ups, stall counts, endzone scrums
        for (const gz of [FIELD.goalLine, -FIELD.goalLine]) {
          const d = z - gz;
          wear += 0.40 * Math.exp(-(d * d) / (2 * 1.9 * 1.9)) * inX;
        }
        // endlines take the pull line-up
        for (const gz of [FIELD.halfLength, -FIELD.halfLength]) {
          const d = z - gz;
          wear += 0.22 * Math.exp(-(d * d) / (2 * 1.3 * 1.3)) * inX;
        }
        // brick marks — every turnover restarts here
        for (const bz of [FIELD.brick, -FIELD.brick]) {
          const wob = 1 + 0.45 * fbm2(x * 0.8, (z - bz) * 0.8, { octaves: 2, seed: jitterSeed + 3 });
          const d2 = x * x + (z - bz) * (z - bz);
          wear += 0.50 * Math.exp(-d2 / (2 * 1.45 * 1.45)) * wob;
        }
        // sideline standing strip
        const sd = Math.abs(Math.abs(x) - (FIELD.halfWidth + 1.6));
        wear += 0.30 * Math.exp(-(sd * sd) / (2 * 1.1 * 1.1)) * inZ;

        // organic blotching so nothing reads as a gradient
        const blot = fbm2(x * 0.09, z * 0.09, { octaves: 4, seed: jitterSeed });
        wear *= 0.62 + 0.62 * (blot * 0.5 + 0.5);
        wear += 0.10 * Math.max(0, fbm2(x * 0.035 + 20, z * 0.035 - 11, { octaves: 3, seed: jitterSeed + 7 }));

        // divot clusters where the ground got torn
        const dv = fbm2(x * 0.55, z * 0.55, { octaves: 2, seed: jitterSeed + 31 });
        wear += 0.16 * smoothstep(0.42, 0.75, dv) * smoothstep(0.05, 0.35, wear);

        // mud sits where wear is heavy and drainage is worst (off the crown)
        const offCrown = smoothstep(6, 20, Math.abs(x));
        let mud = smoothstep(0.42, 0.85, wear) * (0.35 + 0.65 * offCrown);
        mud *= 0.45 + 0.75 * Math.max(0, fbm2(x * 0.16 + 5, z * 0.16 + 9, { octaves: 3, seed: jitterSeed + 53 }));

        // chalk gets ground away exactly where feet cross it
        const cut = clamp(wear * 1.15, 0, 1) * (0.45 + 0.7 * (fbm2(x * 0.7, z * 0.7, { octaves: 3, seed: jitterSeed + 77 }) * 0.5 + 0.5));

        const i = (py * w + px) * 4;
        data[i] = clamp(wear, 0, 1) * 255;
        data[i + 1] = clamp(cut, 0, 1) * 255;
        data[i + 2] = clamp(mud, 0, 1) * 255;
        data[i + 3] = 255;
      }
    }
    this.tex.needsUpdate = true;
  }

  /* ------------------------------------------------------------ stamping */

  /**
   * Accumulate a scuff. `dirX/dirZ` need not be normalised; a zero direction
   * gives a round stamp. `major`/`minor` are the ellipse radii in metres.
   */
  stamp(
    x: number, z: number, dirX: number, dirZ: number, strength: number,
    major = 0.30, minor = 0.16, mud = 0,
  ): void {
    let cs = dirX, sn = dirZ;
    const len = Math.hypot(cs, sn);
    if (len > 1e-4) { cs /= len; sn /= len; } else { cs = 1; sn = 0; major = minor = (major + minor) * 0.5; }

    const sx = this.stepX, sz = this.stepZ;
    const rad = Math.max(major, minor);
    const x0 = Math.max(0, Math.floor((x - rad - this.minX) / sx));
    const x1 = Math.min(this.w - 1, Math.ceil((x + rad - this.minX) / sx));
    const z0 = Math.max(0, Math.floor((z - rad - this.minZ) / sz));
    const z1 = Math.min(this.h - 1, Math.ceil((z + rad - this.minZ) / sz));
    if (x1 < x0 || z1 < z0) return;

    const ia = 1 / (major * major), ib = 1 / (minor * minor);
    const d = this.data;
    for (let py = z0; py <= z1; py++) {
      const wz = this.minZ + (py + 0.5) * sz - z;
      for (let px = x0; px <= x1; px++) {
        const wx = this.minX + (px + 0.5) * sx - x;
        const a = wx * cs + wz * sn;
        const b = -wx * sn + wz * cs;
        const q = a * a * ia + b * b * ib;
        if (q >= 1) continue;
        const f = (1 - q) * (1 - q) * strength;
        const i = (py * this.w + px) * 4;
        d[i] = Math.min(255, d[i] + f * 255);
        d[i + 1] = Math.min(255, d[i + 1] + f * 340);
        if (mud > 0) d[i + 2] = Math.min(255, d[i + 2] + f * mud * 255);
      }
    }
    this.dirty = true;
  }

  /** Bilinear wear lookup, 0..1. Peers use it to pick footstep audio / VFX. */
  sample(x: number, z: number, channel = 0): number {
    const fx = clamp((x - this.minX) / this.stepX - 0.5, 0, this.w - 1.001);
    const fz = clamp((z - this.minZ) / this.stepZ - 0.5, 0, this.h - 1.001);
    const i = fx | 0, j = fz | 0;
    const a = fx - i, b = fz - j;
    const d = this.data, r0 = (j * this.w + i) * 4 + channel, r1 = r0 + this.w * 4;
    const t = d[r0] + (d[r0 + 4] - d[r0]) * a;
    const u = d[r1] + (d[r1 + 4] - d[r1]) * a;
    return (t + (u - t) * b) / 255;
  }

  /** Re-uploads at most every few frames — the map is 1 MB and changes slowly. */
  flush(frame: number): void {
    if (!this.dirty || frame - this.lastUpload < 4) return;
    this.tex.needsUpdate = true;
    this.lastUpload = frame;
    this.dirty = false;
  }

  dispose(): void { this.tex.dispose(); }
}
