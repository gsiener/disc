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
 *
 * ## Why the foreground is treated differently from the background
 *
 * `1/z` runs away in front of the focal plane and does not run away behind it:
 * a lens focused at 2 m has a bounded circle of confusion at infinity and an
 * unbounded one at 20 cm. Left alone that is exactly what happened to the
 * ground-level turf shot — the metre of grass between the lens and the pitch,
 * i.e. the entire subject of the shot, went to maximum blur while a strip of
 * turf 50 cm deep stayed sharp. So the near lobe gets its own, smaller scale and
 * its own, smaller ceiling. This is not physical and it is not pretending to be;
 * every shipped title does it, because foreground mush destroys a frame in a way
 * background melt never does.
 */
export class DofPass extends QuadPass {
  /** Metres. */
  focus = 12;
  /** Blur strength scalar taken from the shot list (not an f-number). */
  aperture = 1.0;
  /** Pixels of CoC per unit of `aperture · fovFactor · diopter`. */
  scale = 0.0011;
  /** Hard cap on the background blur radius, as a fraction of frame height. */
  maxRadius = 0.0085;
  /** Foreground CoC, as a fraction of the background's scale and ceiling. */
  nearFraction = 0.45;

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
        uNear: { value: 0.45 },
      },
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform vec2  uTexel;
        uniform float uFocus;
        uniform float uCoCScale;
        uniform float uMaxCoC;
        uniform float uNear;
        varying vec2 vUv;

        float cocOf(float z) {
          float c = uCoCScale * (1.0 / uFocus - 1.0 / max(z, 0.05));
          // Negative = in front of the focal plane. See the class note.
          if (c < 0.0) return max(c * uNear, -uMaxCoC * uNear);
          return min(c, uMaxCoC);
        }

        void main() {
          vec3  centre = texture2D(tDiffuse, vUv).rgb;
          float zc = max(texture2D(tDepth, vUv).x, 0.05);
          float cc = cocOf(zc);
          float r  = abs(cc);

          // Below a pixel of blur the gather is a no-op and costs 32 taps.
          if (r < 0.85) { gl_FragColor = vec4(centre, 1.0); return; }

          // Interleaved gradient noise rather than a hash: it is low-discrepancy
          // over any small neighbourhood, so a sparse gather over high-frequency
          // content (a stand full of one-pixel crowd) breaks up into a fine
          // ordered dither instead of white speckle.
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          float ang = ign * 6.28318530718;
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
    this.u.uNear.value = this.nearFraction;

    // If the largest plausible CoC in the scene is under a pixel, skip the pass:
    // the gather would early-out per fragment anyway and still cost a
    // full-screen resolve. Worst case over the depth range is z -> infinity.
    return s / this.focus > 0.8;
  }

  override setSize(width: number, height: number): void {
    this.h = height;
    (this.u.uTexel.value as THREE.Vector2).set(1 / width, 1 / height);
  }
}
