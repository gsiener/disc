import * as THREE from 'three';

/**
 * How much light is `scene.environment` *actually* delivering?
 *
 * This exists because the sky system owns the environment map and nothing in the
 * engine knows what scale its radiance is on. Without that number the rig cannot
 * balance indirect against the sun — and getting that balance wrong is not a
 * subtle error. Three separate ambient terms were being summed here (the IBL,
 * an SH probe and a hemisphere wrap), each independently describing the whole
 * sky, which put roughly 1.6× the sun's own horizontal irradiance into shadow.
 * A shadow that only removes 40 % of the light landing on a surface is a shadow
 * nobody can see, and the resulting frame reads as flat, milky and unlit no
 * matter what the grade does afterwards.
 *
 * So: measure. `textureCubeUV(env, N, 1.0)` is exactly the lookup three's own
 * `getIBLIrradiance` performs — the roughness-1 mip of a PMREM chain *is* the
 * cosine-convolved irradiance map — so sampling it here and multiplying by π
 * gives the same irradiance the shading code will see, in the same units, for
 * any environment map anyone hands us.
 *
 * Four texels, one draw, one readback, and only when the map changes.
 */

/** Must match `generateCubeUVSize` in three's WebGLProgram. */
function cubeUVDefines(imageHeight: number): Record<string, string> {
  const maxMip = Math.log2(imageHeight) - 2;
  return {
    ENVMAP_TYPE_CUBE_UV: '',
    CUBEUV_TEXEL_WIDTH: `${1.0 / (3 * Math.max(Math.pow(2, maxMip), 7 * 16))}`,
    CUBEUV_TEXEL_HEIGHT: `${1.0 / imageHeight}`,
    CUBEUV_MAX_MIP: `${maxMip}.0`,
  };
}

export interface EnvIrradiance {
  /** Irradiance on an up-facing surface — the turf, shoulders, the top of a disc. */
  up: THREE.Color;
  /** Irradiance from below. Whatever ground term the env author baked in. */
  down: THREE.Color;
  /** Mean irradiance on a vertical surface — faces, jerseys, mast steel. */
  side: THREE.Color;
  /** Rec.709 luminance of `up`. The number the budget is actually solved from. */
  upLuma: number;
}

const REC709 = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export class EnvMeter {
  private rt: THREE.WebGLRenderTarget | null = null;
  private mat: THREE.RawShaderMaterial | null = null;
  private quad: THREE.Mesh | null = null;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private buf = new Float32Array(6 * 4);
  private lastTex: THREE.Texture | null = null;
  private lastHeight = -1;
  private cached: EnvIrradiance | null = null;
  private failed = false;

  /**
   * Returns the irradiance `tex` delivers at `envMapIntensity = 1`, or null if
   * the environment is not a PMREM we can read (in which case the caller should
   * fall back to its analytic estimate rather than guess a scale).
   *
   * Cached on texture identity: the sky rebakes on the hour, not on the frame.
   */
  measure(renderer: THREE.WebGLRenderer, tex: THREE.Texture | null): EnvIrradiance | null {
    if (!tex || tex.mapping !== THREE.CubeUVReflectionMapping) return null;
    if (tex === this.lastTex && this.cached) return this.cached;
    if (this.failed) return null;

    const h = (tex.image as { height?: number } | undefined)?.height ?? 0;
    if (!(h > 0)) return null;

    try {
      this.ensure(h);
      const mat = this.mat!;
      mat.uniforms.uEnv.value = tex;

      const prevTarget = renderer.getRenderTarget();
      const prevXr = renderer.xr.enabled;
      renderer.xr.enabled = false;
      renderer.setRenderTarget(this.rt);
      renderer.render(this.scene, this.cam);
      renderer.readRenderTargetPixels(this.rt!, 0, 0, 6, 1, this.buf);
      renderer.setRenderTarget(prevTarget);
      renderer.xr.enabled = prevXr;

      const b = this.buf;
      const px = (i: number) => [b[i * 4], b[i * 4 + 1], b[i * 4 + 2]] as const;
      const [ur, ug, ub] = px(0);
      const [dr, dg, db] = px(1);
      // Four horizontals averaged — a vertical surface sees a quarter of the
      // sky wherever it happens to be facing, and faces are what this is for.
      let sr = 0, sg = 0, sb = 0;
      for (let i = 2; i < 6; i++) { const [r, g, bb] = px(i); sr += r; sg += g; sb += bb; }
      sr /= 4; sg /= 4; sb /= 4;

      const P = Math.PI;
      const out: EnvIrradiance = {
        up: new THREE.Color(ur * P, ug * P, ub * P),
        down: new THREE.Color(dr * P, dg * P, db * P),
        side: new THREE.Color(sr * P, sg * P, sb * P),
        upLuma: REC709(ur, ug, ub) * P,
      };
      if (!isFinite(out.upLuma)) { this.failed = true; return null; }

      this.lastTex = tex;
      this.cached = out;
      return out;
    } catch {
      // A driver without float readback is not a reason to render an unlit frame.
      this.failed = true;
      return null;
    }
  }

  private ensure(height: number): void {
    if (this.rt && this.lastHeight === height) return;
    this.disposeGpu();
    this.lastHeight = height;

    this.rt = new THREE.WebGLRenderTarget(6, 1, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.rt.texture.name = 'lighting.envMeter';

    // Raw shader: three would otherwise inject its own envmap defines and fight
    // us over the ones the cubeUV chunk needs.
    this.mat = new THREE.RawShaderMaterial({
      name: 'EnvMeter',
      glslVersion: THREE.GLSL3,
      defines: cubeUVDefines(height),
      uniforms: { uEnv: { value: null } },
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */`
        in vec3 position;
        in vec2 uv;
        out vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float;
        precision highp int;
        #define texture2D texture
        #define varying in
        #define gl_FragColor pc_fragColor
        layout(location = 0) out highp vec4 pc_fragColor;
        uniform sampler2D uEnv;
        in vec2 vUv;
        ${THREE.ShaderChunk.common}
        ${THREE.ShaderChunk.cube_uv_reflection_fragment}
        void main() {
          int i = int(floor(vUv.x * 6.0));
          vec3 n;
          if (i == 0)      n = vec3( 0.0,  1.0,  0.0);
          else if (i == 1) n = vec3( 0.0, -1.0,  0.0);
          else if (i == 2) n = vec3( 1.0,  0.0,  0.0);
          else if (i == 3) n = vec3(-1.0,  0.0,  0.0);
          else if (i == 4) n = vec3( 0.0,  0.0,  1.0);
          else             n = vec3( 0.0,  0.0, -1.0);
          gl_FragColor = vec4(textureCubeUV(uEnv, n, 1.0).rgb, 1.0);
        }`,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  private disposeGpu(): void {
    this.rt?.dispose();
    this.mat?.dispose();
    this.quad?.geometry.dispose();
    if (this.quad) this.scene.remove(this.quad);
    this.rt = null; this.mat = null; this.quad = null;
    this.lastTex = null; this.cached = null;
  }

  dispose(): void { this.disposeGpu(); }
}
