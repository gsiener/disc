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
/**
 * 1 on a regulation marking, 0 more than half a metre off one.
 *
 * Mirrors `TurfMaterial.chalkNearest` — two sidelines, two end lines, two goal
 * lines, two brick crosses, and nothing else, folded into the +X/+Z quadrant.
 * It exists so the chalk-cut channel can only exist where there is chalk: a
 * scuff in the middle of the pitch has no paint to take off, and spending the
 * channel there is what turned the centre of the field into a scribble.
 */
function lineProximity(x: number, z: number): number {
  const qx = Math.abs(x), qz = Math.abs(z);
  const W = FIELD.halfWidth, L = FIELD.halfLength, G = FIELD.goalLine, B = FIELD.brick;
  const over = (v: number, hi: number) => Math.max(0, v - hi);
  let d = Math.hypot(qx - W, over(qz, L));                 // sideline
  d = Math.min(d, Math.hypot(over(qx, W), qz - L));        // end line
  d = Math.min(d, Math.hypot(over(qx, W), qz - G));        // goal line
  d = Math.min(d, Math.hypot(qx, over(Math.abs(qz - B), 0.5)));  // brick, long arm
  d = Math.min(d, Math.hypot(over(qx, 0.5), qz - B));      // brick, cross arm
  const t = Math.max(0, Math.min(1, (d - 0.12) / (0.55 - 0.12)));
  return 1 - t * t * (3 - 2 * t);
}

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

        /* Central running lane. Real traffic wear is a *broad, shallow*
           thinning of the sward, not a dark core: this used to be a 8.5 m
           Gaussian at 0.40, which puts a hard-shouldered dark spine straight
           down the middle of every broadcast frame. Wider (11 m), shallower
           (0.26) and folded together with the two lanes either side of it that
           cutters actually run, so the middle third of the pitch is *tired*
           rather than bald. */
        const lane = 0.68 * Math.exp(-(x * x) / (2 * 11.0 * 11.0))
                   + 0.32 * Math.exp(-((Math.abs(x) - 9.0) ** 2) / (2 * 5.0 * 5.0));
        let wear = 0.26 * lane * inField;

        // goal lines: pull line-ups, stall counts, endzone scrums
        for (const gz of [FIELD.goalLine, -FIELD.goalLine]) {
          const d = z - gz;
          wear += 0.30 * Math.exp(-(d * d) / (2 * 2.4 * 2.4)) * inX;
        }
        // endlines take the pull line-up
        for (const gz of [FIELD.halfLength, -FIELD.halfLength]) {
          const d = z - gz;
          wear += 0.18 * Math.exp(-(d * d) / (2 * 1.7 * 1.7)) * inX;
        }
        // brick marks — every turnover restarts here
        for (const bz of [FIELD.brick, -FIELD.brick]) {
          const wob = 1 + 0.35 * fbm2(x * 0.8, (z - bz) * 0.8, { octaves: 2, seed: jitterSeed + 3 });
          const d2 = x * x + (z - bz) * (z - bz);
          wear += 0.34 * Math.exp(-d2 / (2 * 1.9 * 1.9)) * wob;
        }
        // sideline standing strip
        const sd = Math.abs(Math.abs(x) - (FIELD.halfWidth + 1.6));
        wear += 0.26 * Math.exp(-(sd * sd) / (2 * 1.4 * 1.4)) * inZ;

        // organic blotching so nothing reads as a gradient
        const blot = fbm2(x * 0.09, z * 0.09, { octaves: 4, seed: jitterSeed });
        wear *= 0.70 + 0.50 * (blot * 0.5 + 0.5);
        wear += 0.07 * Math.max(0, fbm2(x * 0.035 + 20, z * 0.035 - 11, { octaves: 3, seed: jitterSeed + 7 }));

        // divot clusters where the ground got torn
        const dv = fbm2(x * 0.55, z * 0.55, { octaves: 2, seed: jitterSeed + 31 });
        wear += 0.12 * smoothstep(0.42, 0.75, dv) * smoothstep(0.05, 0.35, wear);

        // mud sits where wear is heavy and drainage is worst (off the crown)
        const offCrown = smoothstep(6, 20, Math.abs(x));
        let mud = smoothstep(0.52, 0.92, wear) * (0.35 + 0.65 * offCrown);
        mud *= 0.45 + 0.75 * Math.max(0, fbm2(x * 0.16 + 5, z * 0.16 + 9, { octaves: 3, seed: jitterSeed + 53 }));

        /* Chalk scuffing, and *only* where there is chalk to scuff.
           This channel used to be `wear * 1.15` everywhere, which sprayed a
           high-frequency scribble across the whole pitch — including the
           middle, where there is no paint at all, so every one of those texels
           was doing nothing but adding bandwidth to a 1 MB texture. Worse, it
           saturated on the goal lines, where the seeded scrimmage band drives
           wear hardest, so the two most legible-critical lines on the pitch
           were the two the shader rubbed out. It is now gated to a 30 cm
           collar around the regulation set and capped well short of 1. */
        const near = lineProximity(x, z);
        const cut = near * clamp(0.55 * wear, 0, 0.7)
          * (0.5 + 0.6 * (fbm2(x * 0.7, z * 0.7, { octaves: 3, seed: jitterSeed + 77 }) * 0.5 + 0.5));

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

    // Scuffing paint requires paint. Away from the regulation set the cut
    // channel is dead weight, and near it a single stamp used to saturate the
    // channel outright (the old +f*340 reached 255 at f≈0.75).
    const cutGain = 130 * lineProximity(x, z);

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
        if (cutGain > 0) d[i + 1] = Math.min(178, d[i + 1] + f * cutGain);
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
