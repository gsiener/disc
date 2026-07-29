import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { QUAD_VERT, GLSL_COMMON } from './Common';

/**
 * Resolves the scene's hardware depth attachment into a stable, linear
 * view-space depth texture (metres along -Z) that later passes can sample.
 *
 * Why this exists instead of letting BokehPass / SSRPass render their own depth:
 * those passes re-render the whole scene with an override material, which (a)
 * costs a second full scene pass — ruinous with a million instanced grass blades
 * — and (b) silently loses every vertex-shader displacement (wind-animated
 * grass, skinned characters), so the depth they blur against does not match the
 * pixels they are blurring. Reading the real depth attachment is both cheaper
 * and correct.
 *
 * It has to run immediately after RenderPass (which writes into `readBuffer`
 * with `needsSwap = false`), because later ping-pong passes will eventually
 * clear that attachment. `needsSwap = false` keeps the beauty buffer untouched.
 */
export class DepthResolvePass extends Pass {
  readonly target: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor(width: number, height: number, near: number, far: number) {
    super();
    this.needsSwap = false;
    this.clear = false;

    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.name = 'postfx.linearDepth';

    this.material = new THREE.ShaderMaterial({
      name: 'DepthResolve',
      uniforms: {
        tDepth: { value: null },
        uNear: { value: near },
        uFar: { value: far },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: GLSL_COMMON + /* glsl */`
        uniform sampler2D tDepth;
        uniform float uNear;
        uniform float uFar;
        varying vec2 vUv;

        void main() {
          float d = texture2D(tDepth, vUv).x;
          // window depth [0,1] -> NDC [-1,1] -> positive view-space distance
          float ndc = d * 2.0 - 1.0;
          float z = (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
          gl_FragColor = vec4(z, 0.0, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  get texture(): THREE.Texture { return this.target.texture; }

  setCamera(near: number, far: number): void {
    this.material.uniforms.uNear.value = near;
    this.material.uniforms.uFar.value = far;
  }

  render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const depth = readBuffer.depthTexture;
    if (!depth) return;
    this.material.uniforms.tDepth.value = depth;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height);
  }

  override dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
