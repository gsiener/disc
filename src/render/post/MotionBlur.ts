import * as THREE from 'three';
import { QuadPass, texel } from './Common';

/**
 * Camera-velocity reprojection blur.
 *
 * Each pixel's world position is rebuilt from linear depth, projected with the
 * previous frame's view-projection, and the resulting screen-space delta is the
 * blur vector. Static geometry under a moving camera therefore streaks
 * correctly, and — crucially — the streak length is *derived*, so a locked-off
 * camera produces exactly zero blur rather than a global smear. The pass
 * disables itself entirely when the camera has not moved, which is why the
 * screenshot rig pays nothing for it.
 *
 * Per-object velocity would need a velocity G-buffer written by every material
 * in the game, i.e. edits to files this system does not own. Camera
 * reprojection is the honest subset.
 */
export class MotionBlurPass extends QuadPass {
  /** Shutter: fraction of the frame interval the shutter is open. */
  shutter = 0.55;
  /** Hard cap in pixels — the difference between "in motion" and "smeared". */
  maxRadius = 22;

  private readonly prevViewProj = new THREE.Matrix4();
  private readonly curViewProj = new THREE.Matrix4();
  private primed = false;

  constructor(width: number, height: number, taps: number) {
    super({
      name: 'MotionBlurPass',
      defines: { MB_TAPS: taps },
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uTexel: { value: texel(width, height) },
        uTanHalf: { value: new THREE.Vector2(1, 1) },
        uCamWorld: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uStrength: { value: 0.55 },
        uMaxRadius: { value: 22 },
      },
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform vec2  uTexel;
        uniform vec2  uTanHalf;
        uniform mat4  uCamWorld;
        uniform mat4  uPrevViewProj;
        uniform float uStrength;
        uniform float uMaxRadius;
        varying vec2 vUv;

        void main() {
          vec4 here = texture2D(tDiffuse, vUv);
          float z = texture2D(tDepth, vUv).x;

          vec3 vp = viewFromDepth(vUv, z, uTanHalf);
          vec4 wp = uCamWorld * vec4(vp, 1.0);
          vec4 pc = uPrevViewProj * wp;
          if (pc.w <= 1e-4) { gl_FragColor = here; return; }

          vec2 prevUv = (pc.xy / pc.w) * 0.5 + 0.5;
          vec2 vel = (vUv - prevUv) * uStrength;
          vec2 velPx = vel / uTexel;
          float len = length(velPx);
          if (len < 0.75) { gl_FragColor = here; return; }

          vel *= min(len, uMaxRadius) / len;

          float jit = hash13(vec3(gl_FragCoord.xy, 3.0)) - 0.5;
          vec3 sum = vec3(0.0);
          for (int i = 0; i < MB_TAPS; i++) {
            float t = (float(i) + 0.5 + jit) / float(MB_TAPS) - 0.5;
            vec2 uv = clamp(vUv + vel * t, vec2(0.0), vec2(1.0));
            sum += texture2D(tDiffuse, uv).rgb;
          }
          gl_FragColor = vec4(sum / float(MB_TAPS), here.a);
        }`,
    });
  }

  setDepth(tex: THREE.Texture): void { this.u.tDepth.value = tex; }

  /**
   * Feeds the current camera and rolls the history. Returns true when there is
   * enough camera motion for the pass to be worth running this frame.
   */
  update(camera: THREE.PerspectiveCamera, aspect: number): boolean {
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    (this.u.uTanHalf.value as THREE.Vector2).set(tanHalf * aspect, tanHalf);
    (this.u.uCamWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
    this.u.uStrength.value = this.shutter;
    this.u.uMaxRadius.value = this.maxRadius;

    this.curViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    if (!this.primed) {
      this.prevViewProj.copy(this.curViewProj);
      this.primed = true;
    }
    (this.u.uPrevViewProj.value as THREE.Matrix4).copy(this.prevViewProj);

    // Cheap "did anything move" probe: max abs element delta of the VP matrix.
    let delta = 0;
    const a = this.curViewProj.elements, b = this.prevViewProj.elements;
    for (let i = 0; i < 16; i++) delta = Math.max(delta, Math.abs(a[i] - b[i]));

    this.prevViewProj.copy(this.curViewProj);
    return delta > 1e-5;
  }

  /** Drops the history so a hard camera cut does not produce a giant smear. */
  reset(): void { this.primed = false; }

  override setSize(width: number, height: number): void {
    (this.u.uTexel.value as THREE.Vector2).set(1 / width, 1 / height);
  }
}
