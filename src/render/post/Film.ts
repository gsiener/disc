import * as THREE from 'three';
import { QuadPass } from './Common';

/**
 * Lens and sensor artefacts, applied to the display-referred image.
 *
 * Three effects, all deliberately near the threshold of perception — the
 * failure mode for every one of them is "obvious", and obvious reads as a
 * filter rather than as a camera:
 *
 *  - Transverse chromatic aberration that is *exactly zero* in the middle of
 *    the frame and reaches about a pixel in the corners. Real lenses only
 *    fringe off-axis; uniform CA is the giveaway of a shader that just offset
 *    the red and blue channels.
 *  - A cosine-ish vignette, aspect corrected so it is round rather than oval.
 *  - Fine, animated, luminance-weighted grain. The weight is a bell centred on
 *    the midtones: film grain does not live in the specular highlights and it
 *    does not live in crushed blacks, and putting it there is what makes a
 *    frame look noisy instead of photographic.
 */
export class FilmPass extends QuadPass {
  constructor(width: number, height: number) {
    super({
      name: 'FilmPass',
      uniforms: {
        tDiffuse: { value: null },
        uResolution: { value: new THREE.Vector2(width, height) },
        uAspect: { value: width / Math.max(1, height) },
        // Pixels of fringing at the very corner. Under a pixel on purpose: the
        // stands are a field of one-pixel crowd detail, and any wider than this
        // the fringe stops reading as a lens and starts reading as rainbow
        // speckle over every seat in the bowl.
        uCa: { value: 0.55 },
        /**
         * Ceiling on how far CA is allowed to move a single channel, in
         * display-referred units.
         *
         * This is the fix for the magenta/cyan speckle that was eating the
         * top-left corner of `broadcast`. The upper bowl there is a field of
         * seat backs whose lit edges are exactly one pixel tall against near
         * black; shifting red one way and blue the other across an edge with a
         * 0.6 contrast step does not produce a fringe, it produces a saturated
         * red line above a saturated blue line, repeated a thousand times.
         *
         * The reason that is *wrong* and not merely ugly is optical: transverse
         * chromatic aberration is a magnification difference between channels,
         * and it lives in a lens whose MTF at one cycle per pixel is already
         * near zero. An edge sharp enough to fringe that hard cannot survive
         * the same lens that is doing the fringing. So the two taps are
         * band-limited along the offset (which is what the blur would have
         * done) and the residual per-channel excursion is clamped, which leaves
         * smooth off-axis gradients — a floodlight halo, a shoulder against the
         * sky, the roof line — fringing exactly as before, and stops the effect
         * dead on aliased geometry.
         */
        uCaClamp: { value: 0.028 },
        uVignette: { value: 0.28 },
        uGrain: { value: 0.024 },
        uGrainScale: { value: 1.0 },
        uTime: { value: 0 },
      },
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform vec2  uResolution;
        uniform float uAspect;
        uniform float uCa;
        uniform float uCaClamp;
        uniform float uVignette;
        uniform float uGrain;
        uniform float uGrainScale;
        uniform float uTime;
        varying vec2 vUv;

        void main() {
          vec2 d = vUv - 0.5;
          // normalised radius: 0 centre, 1 at the corners
          vec2 q = vec2(d.x * uAspect, d.y);
          float rad = length(q) / length(vec2(uAspect, 1.0) * 0.5);

          // --- transverse chromatic aberration, off-axis only.
          // The offset is expressed in *pixels* so it stays a fixed optical
          // width regardless of aspect ratio or buffer resolution.
          float amt = uCa * smoothstep(0.35, 1.0, rad);
          vec2 off = (d / max(length(d), 1e-5)) * amt / uResolution;
          vec4 mid = texture2D(tDiffuse, vUv);
          // Two taps per fringing channel, at 0.55 and 1.0 of the offset. That
          // is a 1-tap-wide box along the shift direction — the band limit a
          // lens with this much lateral colour would impose anyway — and it is
          // what stops a one-pixel edge from producing a full-contrast line.
          float rA = texture2D(tDiffuse, vUv + off).r;
          float rB = texture2D(tDiffuse, vUv + off * 0.55).r;
          float bA = texture2D(tDiffuse, vUv - off).b;
          float bB = texture2D(tDiffuse, vUv - off * 0.55).b;
          vec3 col = mid.rgb;
          // …and the excursion is clamped, so aliased geometry cannot fringe.
          col.r += clamp((rA + rB) * 0.5 - mid.r, -uCaClamp, uCaClamp);
          col.b += clamp((bA + bB) * 0.5 - mid.b, -uCaClamp, uCaClamp);

          // --- vignette
          float vig = 1.0 - uVignette * smoothstep(0.35, 1.12, rad);
          col *= vig;

          // --- animated, luminance-weighted grain
          vec2 gp = floor(gl_FragCoord.xy / uGrainScale);
          float g = hash13(vec3(gp, floor(uTime * 24.0)));
          float y = luma(col);
          float bell = 4.0 * y * (1.0 - y);          // peaks at mid grey, 0 at both ends
          bell *= bell;                              // tighten it into the midtones
          col += (g - 0.5) * uGrain * bell;

          gl_FragColor = vec4(clamp(col, 0.0, 1.0), mid.a);
        }`,
    });
  }

  setTime(t: number): void { this.u.uTime.value = t; }

  override setSize(width: number, height: number): void {
    (this.u.uResolution.value as THREE.Vector2).set(width, height);
    this.u.uAspect.value = width / Math.max(1, height);
    // Keep grain a constant *physical* size on screen rather than a constant
    // texel size, so a retina buffer does not turn it into invisible dust.
    this.u.uGrainScale.value = Math.max(1, Math.round(height / 1080));
  }
}
