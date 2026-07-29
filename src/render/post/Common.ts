import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Shared plumbing for the hand-written post passes.
 *
 * Everything here works in the composer's HDR half-float ping-pong. Nothing in
 * this file tone maps or gamma encodes — that happens exactly once, at the end
 * of the chain (see PostFX.ts).
 */

export const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * GLSL prelude shared by every pass: Rec.709 luma, a decent integer-ish hash
 * (Dave Hoskins' hash13 — no sin(), so it does not band on mobile drivers) and
 * view-space reconstruction from the linear depth buffer produced by
 * `DepthResolvePass`.
 */
export const GLSL_COMMON = /* glsl */`
const vec3 REC709 = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c) { return dot(c, REC709); }

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

// uTanHalf = vec2(tan(fovY/2) * aspect, tan(fovY/2))
vec3 viewFromDepth(vec2 uv, float linearZ, vec2 tanHalf) {
  return vec3((uv * 2.0 - 1.0) * tanHalf, -1.0) * linearZ;
}
`;

export interface QuadPassDef {
  name: string;
  uniforms: Record<string, THREE.IUniform>;
  fragmentShader: string;
  defines?: Record<string, string | number>;
}

/**
 * A ShaderPass that we own, so we can drive extra render targets and keep the
 * uniform surface typed. Deliberately does NOT clear the write buffer: the quad
 * covers every texel, and clearing would also wipe the depth attachment that
 * `DepthResolvePass` reads from earlier in the frame.
 */
export class QuadPass extends Pass {
  readonly material: THREE.ShaderMaterial;
  protected readonly quad: FullScreenQuad;

  constructor(def: QuadPassDef) {
    super();
    this.material = new THREE.ShaderMaterial({
      name: def.name,
      defines: { ...(def.defines ?? {}) },
      uniforms: def.uniforms,
      vertexShader: QUAD_VERT,
      fragmentShader: GLSL_COMMON + def.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.clear = false;
  }

  get u(): Record<string, THREE.IUniform> { return this.material.uniforms; }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const t = this.material.uniforms.tDiffuse;
    if (t) t.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}

/** Convenience for the many `vec2(1/w, 1/h)` uniforms. */
export function texel(w: number, h: number): THREE.Vector2 {
  return new THREE.Vector2(1 / Math.max(1, w), 1 / Math.max(1, h));
}
