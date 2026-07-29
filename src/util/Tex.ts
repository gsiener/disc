import * as THREE from 'three';

/**
 * Procedural texture baking. The whole game ships zero binary assets — every
 * albedo, normal, roughness and mask map is generated here at load time. That
 * keeps the build self-contained and lets materials be parameterised (team
 * colours, wear level, wetness) instead of authored per variant.
 *
 * `bake` runs a per-texel callback into an RGBA byte buffer. `heightToNormal`
 * derives a tangent-space normal map by Sobel-filtering a height channel, which
 * is how nearly every surface here gets its relief.
 */

export type TexelFn = (
  x: number, y: number, u: number, v: number,
  out: Uint8ClampedArray, i: number,
) => void;

export interface BakeOpts {
  size: number;
  height?: number;
  colorSpace?: THREE.ColorSpace;
  wrap?: THREE.Wrapping;
  anisotropy?: number;
  /** Generate mips. Off for data maps that must stay crisp. */
  mips?: boolean;
  name?: string;
}

export function bake(fn: TexelFn, opts: BakeOpts): THREE.DataTexture {
  const w = opts.size;
  const h = opts.height ?? opts.size;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      fn(x, y, u, v, data, (y * w + x) * 4);
    }
  }
  const tex = new THREE.DataTexture(new Uint8Array(data.buffer), w, h, THREE.RGBAFormat);
  tex.colorSpace = opts.colorSpace ?? THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = opts.wrap ?? THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = (opts.mips ?? true) ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = opts.mips ?? true;
  tex.anisotropy = opts.anisotropy ?? 8;
  tex.needsUpdate = true;
  if (opts.name) tex.name = opts.name;
  return tex;
}

/** Float height field → tangent-space normal map. `strength` in texel units. */
export function heightToNormal(
  height: Float32Array, w: number, h: number, strength = 2.0,
  opts: Partial<BakeOpts> = {},
): THREE.DataTexture {
  const data = new Uint8ClampedArray(w * h * 4);
  const at = (x: number, y: number) => height[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Sobel
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * w + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(new Uint8Array(data.buffer), w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = opts.wrap ?? THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = opts.anisotropy ?? 8;
  tex.needsUpdate = true;
  if (opts.name) tex.name = opts.name;
  return tex;
}

/** Convenience: allocate a height field and fill it from a callback. */
export function heightField(
  size: number, fn: (u: number, v: number, x: number, y: number) => number,
): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out[y * size + x] = fn((x + 0.5) / size, (y + 0.5) / size, x, y);
    }
  }
  return out;
}

/* --------------------------------------------------------------- canvas 2D */

/**
 * For anything typographic or vector-ish — jersey numbers, sponsor marks, field
 * logos, jumbotron content — a 2D canvas is far more direct than per-texel code.
 */
export function canvasTexture(
  w: number, h: number,
  draw: (c: CanvasRenderingContext2D, w: number, h: number) => void,
  opts: Partial<BakeOpts> = {},
): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d')!;
  draw(c, w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = opts.colorSpace ?? THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = opts.wrap ?? THREE.ClampToEdgeWrapping;
  tex.anisotropy = opts.anisotropy ?? 16;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  if (opts.name) tex.name = opts.name;
  return tex;
}

/* ------------------------------------------------------------------ utils */

/** sRGB hex → linear-space THREE.Color, correct for physical light maths. */
export function linearColor(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}

/** Packs three grayscale channels into one RGB texture (ORM-style). */
export function packORM(
  ao: Float32Array, rough: Float32Array, metal: Float32Array,
  size: number, opts: Partial<BakeOpts> = {},
): THREE.DataTexture {
  return bake((x, y, _u, _v, out, i) => {
    const j = y * size + x;
    out[i] = ao[j] * 255;
    out[i + 1] = rough[j] * 255;
    out[i + 2] = metal[j] * 255;
    out[i + 3] = 255;
  }, { size, colorSpace: THREE.NoColorSpace, ...opts });
}

/**
 * Equirectangular environment map baked from a callback over the sphere, then
 * converted to a PMREM for correct roughness-aware IBL. Used when we want image
 * based lighting without shipping an HDR file.
 */
export function envFromFn(
  renderer: THREE.WebGLRenderer,
  size: number,
  fn: (dirX: number, dirY: number, dirZ: number, out: [number, number, number]) => void,
): THREE.Texture {
  const w = size * 2, h = size;
  const data = new Float32Array(w * h * 4);
  const rgb: [number, number, number] = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    const theta = (y + 0.5) / h * Math.PI;
    const sy = Math.cos(theta), st = Math.sin(theta);
    for (let x = 0; x < w; x++) {
      const phi = ((x + 0.5) / w) * Math.PI * 2 - Math.PI;
      fn(st * Math.sin(phi), sy, st * Math.cos(phi), rgb);
      const i = (y * w + x) * 4;
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromEquirectangular(tex);
  tex.dispose();
  pmrem.dispose();
  return rt.texture;
}
