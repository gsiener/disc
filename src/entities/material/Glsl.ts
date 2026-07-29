import * as THREE from 'three';

/**
 * Shader plumbing shared by every player material.
 *
 * All seven player materials are stock three materials patched through
 * `onBeforeCompile`, for one reason: `LightingSystem` walks the scene every
 * frame and chains CSM's own hook onto whatever it finds. A `ShaderMaterial`
 * would take the un-cascaded directional path and the athletes would be the only
 * objects in the frame lit by a different sun than the pitch they stand on.
 *
 * The GLSL below therefore never varies per player — every difference across the
 * roster (skin tone, team colours, sweat, number) is a uniform. That keeps the
 * program count at one per material kind instead of one per athlete, which is
 * what `customProgramCacheKey` on each material asserts.
 */

export type CompileHook = (shader: any, renderer: THREE.WebGLRenderer) => void;

/** Chainable `onBeforeCompile`. Preserves anything already installed. */
export function hook(mat: THREE.Material, fn: CompileHook): void {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (this: THREE.Material, shader: any, renderer: any) {
    if (prev) prev.call(this, shader, renderer);
    fn(shader, renderer);
  } as typeof mat.onBeforeCompile;
}

/** Insert GLSL around a chunk include. `replace` swaps the include out entirely. */
export function at(
  src: string, chunk: string,
  o: { before?: string; after?: string; replace?: string },
): string {
  const inc = `#include <${chunk}>`;
  if (src.indexOf(inc) === -1) return src;
  const body = o.replace !== undefined ? o.replace : inc;
  return src.replace(inc, `${o.before ?? ''}\n${body}\n${o.after ?? ''}`);
}

/** Insert at the very top of `void main() {`. */
export function inMain(src: string, code: string): string {
  return src.replace('void main() {', `void main() {\n${code}`);
}

/* ------------------------------------------------------------- attributes */

/**
 * The rig's extra vertex attributes, forwarded to the fragment stage.
 *
 * `vBind` is the BIND-pose position, not the skinned one. Everything painted on
 * an athlete — a tan line, a sweat patch, dirt up a sock — has to stay stuck to
 * the body while the body moves, so every placement decision downstream is made
 * in bind space and none of it swims when the skeleton animates.
 *
 * `vPart` is exactly constant across a triangle: every loft in the rig writes a
 * single part id to all of its rings, so no primitive ever straddles two parts
 * and the interpolated value needs no `flat` qualifier.
 */
export const VERT_PARS = /* glsl */`
attribute float aPart;
attribute float aSide;
attribute float aCrease;
attribute float aLen;
varying float vPart;
varying float vSide;
varying float vCrease;
varying float vLen;
varying vec2 vSurfUv;
varying vec3 vBind;
varying vec3 vBindN;
`;

export const VERT_MAIN = /* glsl */`
  vPart = aPart;
  vSide = aSide;
  vCrease = aCrease;
  vLen = aLen;
  vSurfUv = uv;
  vBind = position;
  vBindN = normal;
`;

export const FRAG_PARS = /* glsl */`
varying float vPart;
varying float vSide;
varying float vCrease;
varying float vLen;
varying vec2 vSurfUv;
varying vec3 vBind;
varying vec3 vBindN;
`;

/** Part ids, mirrored from rig/Types.ts. Kept as defines so branches fold out. */
export const PART_DEFS = /* glsl */`
#define P_TORSO 0.0
#define P_NECK 1.0
#define P_HEAD 2.0
#define P_EAR 3.0
#define P_EYE 4.0
#define P_LID 5.0
#define P_HAIR 6.0
#define P_UPPERARM 7.0
#define P_FOREARM 8.0
#define P_HAND 9.0
#define P_FINGER 10.0
#define P_THIGH 11.0
#define P_SHIN 12.0
#define P_FOOT 13.0
#define P_JERSEY 14.0
#define P_SHORTS 15.0
#define P_SOCK 16.0
#define P_SHOE 17.0
float isPart(float id) { return step(abs(vPart - id), 0.5); }
`;

/* ------------------------------------------------------------------ noise */

/**
 * Hash and noise. Numerically independent of `util/Noise.ts` (that one bakes on
 * the CPU) but used the same way: everything here is a pure function of position
 * so it is stable frame to frame and identical on every machine.
 */
export const NOISE = /* glsl */`
float mhash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float mhash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 mhash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float mhash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mhash12(i), mhash12(i + vec2(1, 0)), f.x),
             mix(mhash12(i + vec2(0, 1)), mhash12(i + vec2(1, 1)), f.x), f.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(mhash13(i), mhash13(i + vec3(1, 0, 0)), f.x),
                mix(mhash13(i + vec3(0, 1, 0)), mhash13(i + vec3(1, 1, 0)), f.x), f.y);
  float b = mix(mix(mhash13(i + vec3(0, 0, 1)), mhash13(i + vec3(1, 0, 1)), f.x),
                mix(mhash13(i + vec3(0, 1, 1)), mhash13(i + vec3(1, 1, 1)), f.x), f.y);
  return mix(a, b, f.z);
}
float mfbm(vec2 p, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    s += a * vnoise(p); n += a; p *= 2.03; a *= 0.5;
  }
  return s / max(n, 1e-4);
}
/** f1 of a cellular field, plus the cell id in .y. */
vec2 mworley(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = mhash22(i + g);
    float dd = length(g + o - f);
    if (dd < d) { d = dd; id = mhash12(i + g + 17.3); }
  }
  return vec2(d, id);
}
`;

/* ----------------------------------------------------- surface directions */

/**
 * The head is one radially displaced ellipsoid built by `RigMesh.sphereish`, and
 * its uv IS the parameterisation: `uv.x` is the azimuth in turns and `1 - uv.y`
 * is the polar angle in half-turns. So the exact unit direction the sculptor
 * used for every facial landmark can be reconstructed in the shader for free —
 * which is how eyebrows, stubble and lips end up on the same coordinates the
 * geometry was carved on rather than on a hand-fitted guess.
 *
 * Returns the direction in the artist's ruler space: y = 0 at the eye line,
 * −1 at the chin, +1 at the crown; z forward; x toward the athlete's left.
 */
export const HEAD_DIR = /* glsl */`
vec3 headDir(vec2 uv) {
  float phi = (1.0 - uv.y) * PI;
  float th = uv.x * PI2;
  float sp = sin(phi);
  return vec3(sp * sin(th), cos(phi), sp * cos(th));
}
float g1(float v, float c, float w) { float d = (v - c) / w; return exp(-d * d); }
`;

export const PI_DEFS = /* glsl */`
#ifndef PI2
#define PI2 6.283185307179586
#endif
`;

/* ---------------------------------------------------------------- shading */

/**
 * Kajiya–Kay with a Marschner-flavoured two-lobe split, used by both hair and
 * the jersey weave. The primary lobe is shifted toward the root and stays the
 * colour of the light; the secondary is shifted toward the tip and is tinted by
 * the fibre, because it has scattered through it. One lobe reads as wet plastic.
 */
export const FIBRE_SPEC = /* glsl */`
vec3 shiftTangent(vec3 T, vec3 N, float shift) { return normalize(T + shift * N); }
float fibreLobe(vec3 T, vec3 V, vec3 L, float expo) {
  vec3 H = normalize(L + V);
  float dotTH = dot(T, H);
  float sinTH = sqrt(max(0.0, 1.0 - dotTH * dotTH));
  return pow(sinTH, expo) * smoothstep(-1.0, 0.0, dotTH);
}
`;

/* ------------------------------------------------------------------ utils */

export function disposeAll(list: Iterable<{ dispose(): void }>): void {
  for (const t of list) t.dispose();
}

/** Byte cost of a texture including a full mip chain. For the memory report. */
export function texBytes(t: THREE.Texture | null | undefined): number {
  if (!t) return 0;
  const img: any = (t as any).image;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  if (!w || !h) return 0;
  const px = w * h * 4;
  return Math.round(t.generateMipmaps ? px * 4 / 3 : px);
}
