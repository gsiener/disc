import * as THREE from 'three';
import { QuadPass, texel } from './Common';

/**
 * Thin-lens depth of field.
 *
 * Circle of confusion follows the real lens relation
 *   CoC ∝ (focal²/N) · |z − focus| / (z · focus)
 * which, factored, is just `|1/focus − 1/z|` scaled by aperture and by the
 * square of the focal length. The focal length is recovered from the camera's
 * vertical FOV, so a telephoto sideline shot naturally gets a shallower depth of
 * field than a wide establishing shot at the same aperture — which is exactly
 * the behaviour the shot list assumes.
 *
 * The gather is a 2.4°-golden-angle Vogel disc, per-pixel rotated. A sample is
 * only allowed to contribute if its own CoC actually reaches the centre pixel,
 * or if it lies at/behind the centre inside the centre's CoC. That single test
 * is what stops sharp backgrounds bleeding onto blurred foregrounds and gives
 * near-field blur that spills *over* the focal plane the way a real lens does.
 */
export class DofPass extends QuadPass {
  /** Metres. */
  focus = 12;
  /** Blur strength scalar taken from the shot list (not an f-number). */
  aperture = 1.0;
  /** Pixels of CoC per unit of `aperture · fovFactor · diopter`. */
  scale = 0.0017;
  /** Hard cap on the blur radius, as a fraction of frame height. */
  maxRadius = 0.013;

  private h = 1080;

  constructor(width: number, height: number, taps: number) {
    super({
      name: 'DofPass',
      defines: { TAPS: taps },
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uTexel: { value: texel(width, height) },
        uFocus: { value: 12 },
        uCoCScale: { value: 0 },
        uMaxCoC: { value: 14 },
      },
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform vec2  uTexel;
        uniform float uFocus;
        uniform float uCoCScale;
        uniform float uMaxCoC;
        varying vec2 vUv;

        float cocOf(float z) {
          return clamp(uCoCScale * (1.0 / uFocus - 1.0 / max(z, 0.05)), -uMaxCoC, uMaxCoC);
        }

        void main() {
          vec3  centre = texture2D(tDiffuse, vUv).rgb;
          float zc = max(texture2D(tDepth, vUv).x, 0.05);
          float cc = cocOf(zc);
          float r  = abs(cc);

          // Below a pixel of blur the gather is a no-op and costs 32 taps.
          if (r < 0.85) { gl_FragColor = vec4(centre, 1.0); return; }

          float ang = hash13(vec3(gl_FragCoord.xy, 7.0)) * 6.28318530718;
          float ca = cos(ang), sa = sin(ang);

          vec3  sum = centre;
          float wsum = 1.0;

          for (int i = 0; i < TAPS; i++) {
            float fi = float(i) + 0.5;
            float rr = sqrt(fi / float(TAPS));
            float th = fi * 2.39996322973;
            vec2  d  = vec2(cos(th), sin(th));
            d = vec2(d.x * ca - d.y * sa, d.x * sa + d.y * ca);

            float dist = rr * r;
            vec2  uv   = vUv + d * dist * uTexel;
            vec3  s    = texture2D(tDiffuse, uv).rgb;
            float sz   = max(texture2D(tDepth, uv).x, 0.05);
            float sc   = abs(cocOf(sz));

            // Reach: this sample's own blur radius, or the centre's radius if the
            // sample is not in front of the centre (background gather).
            float behind = step(zc - 0.15, sz);
            float reach  = max(sc, behind * r);
            float w      = clamp(reach - dist + 1.0, 0.0, 1.0);

            sum  += s * w;
            wsum += w;
          }

          gl_FragColor = vec4(sum / wsum, 1.0);
        }`,
    });
    this.h = height;
  }

  setDepth(tex: THREE.Texture): void { this.u.tDepth.value = tex; }

  /** Recomputes the CoC scale from the live camera. Returns true if DOF is worth running. */
  update(camera: THREE.PerspectiveCamera): boolean {
    if (!(this.focus > 0) || this.aperture <= 0) return false;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    // (1/tan)² is proportional to focal length squared — the physical CoC term.
    const fovFactor = 1 / (tanHalf * tanHalf);
    const s = this.h * this.scale * this.aperture * fovFactor;
    this.u.uFocus.value = this.focus;
    this.u.uCoCScale.value = s;
    this.u.uMaxCoC.value = this.h * this.maxRadius;

    // If the tightest plausible CoC in the scene is sub-pixel, skip the pass.
    // Worst case over the depth range is at z -> infinity: s/focus.
    return s / this.focus > 0.35;
  }

  override setSize(width: number, height: number): void {
    this.h = height;
    (this.u.uTexel.value as THREE.Vector2).set(1 / width, 1 / height);
  }
}
