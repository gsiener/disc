import * as THREE from 'three';
import { QuadPass } from './Common';

/**
 * The look.
 *
 * This is the only place in the chain where tone mapping happens. Order inside
 * the shader is deliberate and matches how a film pipeline actually works:
 *
 *   scene-referred HDR
 *     → exposure
 *     → contrast in log₂ space about 18 % grey  (HDR-safe; a plain pow() on
 *       linear radiance crushes highlights into the shoulder before the tone
 *       curve ever sees them)
 *     → ASC-CDL slope / offset / power  (gain / lift / gamma)
 *     → hue-selective shaping: turf greens get pushed toward a believable
 *       yellow-green and gain a little chroma; skin hues get a saturation
 *       ceiling so they never go traffic-cone orange
 *     → global saturation
 *     → split tone: teal shadows, warm highlights, weighted by log luminance
 *     → tone curve (AgX by default — it is what the renderer asks for)
 *   display-referred linear 0..1
 *     → a small saturation restore (AgX desaturates by design) and a gentle
 *       smoothstep for broadcast punch
 *
 * Doing the grade *before* the tone curve is the whole point: grading a
 * tone-mapped image can only redistribute what the curve already destroyed.
 */

export const CURVE_AGX = 0;
export const CURVE_ACES = 1;
export const CURVE_NEUTRAL = 2;
export const CURVE_LINEAR = 3;

/** Maps a THREE tone-mapping constant onto our in-shader curve id. */
export function curveFromThree(tm: THREE.ToneMapping): number {
  switch (tm) {
    case THREE.ACESFilmicToneMapping: return CURVE_ACES;
    case THREE.NeutralToneMapping: return CURVE_NEUTRAL;
    case THREE.LinearToneMapping: return CURVE_LINEAR;
    case THREE.AgXToneMapping: return CURVE_AGX;
    default: return CURVE_AGX;
  }
}

export class GradePass extends QuadPass {
  constructor() {
    super({
      name: 'GradePass',
      uniforms: {
        tDiffuse: { value: null },
        uExposure: { value: 1 },
        // A real S-curve, not a nudge. 1.14 in log₂ about 18 % grey is roughly
        // a broadcast camera's own knee: it opens up the separation between
        // sunlit turf and turf in shadow, which is the whole reason the shadow
        // work upstream was worth doing, without touching the shoulder — the
        // contrast happens in log space, so highlights ride into AgX intact.
        uContrast: { value: 1.14 },
        /**
         * ASC-CDL offset — now zero, and it has to stay near zero here.
         *
         * An offset of ±0.005 is an ordinary grading number when it is applied
         * to a 0–1 video signal. This shader applies it to *scene-linear
         * radiance*, where a deep shadow is 0.01–0.02, so the same number is a
         * 30–40 % channel move down there and nothing at all in the highlights.
         * The measured consequence: at `night`, a stand pixel arrived at roughly
         * (0.015, 0.015, 0.015) scene-linear, left as (0.011, 0.014, 0.020)
         * after the offset, and the frame's whole seating bowl rendered at
         * S 91 % blue with a median luma of 0.010 — 90 % of its pixels above the
         * 50 % saturation ceiling the brief sets for everything that is not a
         * kit or the disc. `broadcast` showed the same signature more weakly
         * (far stands S 69 %, near stands S 54 %, against players at S 30 %):
         * the frame's saturation hierarchy was exactly inverted, and the eye
         * landed on the advertising and the seating deck rather than the play.
         *
         * Shadow *colour* is now carried entirely by `uShadowTint`, which is
         * multiplicative and therefore cannot drive a channel to zero, and the
         * shadow *floor* by `uFloat` below, which is additive but positive on
         * all three channels. Between them they do the job this offset was
         * reaching for without the hue inversion.
         */
        uLift: { value: new THREE.Vector3(0, 0, 0) },
        uGain: { value: new THREE.Vector3(1.034, 1.000, 0.966) },
        uInvGamma: { value: new THREE.Vector3(1, 1, 1) },
        /**
         * Veiling floor — the black point the bowl actually has.
         *
         * A stadium interior is a box full of scattering air and a hundred
         * bright surfaces; nothing inside it is ever at zero. Measured before
         * this existed, `broadcast` put its far stands (120 m) at a 5th-
         * percentile luma of 0.009 and its near stands (25 m) at 0.024 — the
         * far ones *darker* and more crushed than the near ones, which is the
         * opposite of what distance does. The scene's aerial-perspective term
         * is not reaching them (see the note in PostFX about the crowd), so the
         * grade at least has to stop the tone curve's toe from eating what is
         * there.
         *
         * Added after the CDL and before the hue work so the tone curve sees a
         * signal with a floor, exactly like a print with a base density. Tinted
         * with the scene's own haze colour rather than neutral grey, which is
         * what makes it read as air instead of as a lifted black.
         */
        uFloat: { value: 0.0042 },
        uFloatTint: { value: new THREE.Vector3(0.90, 1.00, 1.03) },
        uSat: { value: 1.05 },
        /**
         * Turf hue and chroma — the two numbers that decide whether the
         * athletes are the subject of the frame or the grass is.
         *
         * The art-direction rule is that exactly three things in the frame may
         * be saturated: the two kits and the disc. Everything else lives under
         * 50 % HSV. Measured against that, the pitch was the single worst
         * offender in every gameplay shot — 55–75 % of the image at S 0.48–0.56
         * (broadcast 0.53, layout 0.55, closeup 0.55, turf macro 0.56) while the
         * home kit sat at S 0.57–0.65. A three-point saturation margin between
         * the subject and two thirds of the frame is not a hierarchy, and
         * `uGreenSat` at 1.07 was actively *widening* the problem by adding
         * chroma to the largest surface in the shot.
         *
         * 0.84 takes the pitch to S 0.40–0.47 — under the ceiling, and far
         * enough below the kit that the eye has somewhere to land. It is done
         * here rather than in `TurfMaterial` deliberately: the frame's green
         * comes from the pitch shader, a million instanced grass blades, the
         * apron and the outfield, which are four different files owned by
         * different systems. A hue-selective trim in the grade is the one place
         * that keeps all four in agreement, and it cannot touch the blue kit
         * (H 214°), the red trim (H 5°) or skin (H 15–40°).
         *
         * `uGreenPush` moves the pitch hue toward the target `#4d7a38` band
         * (H 100–110°); measured turf was landing at H 84–94°, yellow of the
         * brief. The push is kept moderate on purpose — it is a lerp toward a
         * single hue, so a large value would flatten the lush/dry variation the
         * wear map exists to produce.
         */
        uGreenPush: { value: 0.30 },
        uGreenSat: { value: 0.84 },
        /**
         * Skin, now that there are faces in the frame.
         *
         * The brief pins the roster at H 20–35°, S 20–35 %. Measured on
         * `closeup` before this pass: forearm `#83664f` (H 26°, S 39 %) and
         * face `#573f36` (H 16°, S 38 %) — the arm just outside the saturation
         * ceiling, the face four degrees *below* the hue floor, i.e. pink
         * rather than tan. The guard at 0.58 was a ceiling nothing on a face
         * ever reached, so it was doing nothing; it now sits just above the
         * band so it catches a hot cheek without touching a normal one.
         *
         * `uSkinHue` is the new half: a pull toward 25.7°, which brings the
         * face's 16° up to about 21° and settles a 32° shoulder back to 30°,
         * so the roster converges on the band from both sides instead of only
         * being clipped from above. The window still opens at H 10°, which is
         * above the away kit's `#b3372e` trim at 5.4° — that stays full
         * saturation, as one of the three things in the frame allowed to be.
         */
        uSkinGuard: { value: 0.44 },
        uSkinHue: { value: 0.45 },
        uSatCeil: { value: 0.72 },
        // Teal shadows, warm highlights — the split every sports broadcast
        // truck runs, kept to ~7 % so it reads as a look and not as a filter.
        uShadowTint: { value: new THREE.Vector3(0.938, 0.992, 1.072) },
        // Warm-highlight half of the split, softened from (1.058, 1.008, 0.938).
        // It lands hardest on the brightest chromatic thing in a close shot,
        // which is now a lit cheekbone, and it was part of why the face metered
        // four degrees below the hue floor.
        uHighTint: { value: new THREE.Vector3(1.045, 1.006, 0.950) },
        uPostSat: { value: 1.10 },
        /**
         * Shadow chroma rolloff, display-referred.
         *
         * Stated in the units the measurements are in — *encoded* luma, i.e.
         * what a pixel picker reads off the PNG, which is why the shader
         * gamma-encodes the luma before testing it. This pass emits
         * display-referred **linear** (OutputPass does the sRGB encode), and
         * getting that wrong is a factor of three on the knee: the first
         * version of this used the sRGB numbers directly against linear luma
         * and desaturated the pitch from S 34 % to S 21 % along with the bowl.
         *
         * The knee is set from the histogram rather than by eye — mid-pitch
         * turf sits at 0.34–0.39, a lit kit at 0.21–0.54, and the crushed
         * seating bowl at 0.01–0.10, so 0.045→0.22 catches the bowl and
         * nothing else. Two of the three things the brief allows to be
         * saturated are lit by the key when they matter; the third is white.
         *
         * It is also true, which is why it is defensible at this strength: the
         * eye loses chroma discrimination in the dark, and veiling glare inside
         * a bright bowl washes the darkest surfaces toward the mean.
         */
        uShadowKnee: { value: new THREE.Vector2(0.045, 0.22) },
        uShadowDesat: { value: 0.62 },
        uPunch: { value: 0.13 },
        uCurve: { value: CURVE_AGX },
      },
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float uExposure;
        uniform float uContrast;
        uniform vec3  uLift;
        uniform vec3  uGain;
        uniform vec3  uInvGamma;
        uniform float uFloat;
        uniform vec3  uFloatTint;
        uniform float uSat;
        uniform float uGreenPush;
        uniform float uGreenSat;
        uniform float uSkinGuard;
        uniform float uSkinHue;
        uniform float uSatCeil;
        uniform vec3  uShadowTint;
        uniform vec3  uHighTint;
        uniform float uPostSat;
        uniform vec2  uShadowKnee;
        uniform float uShadowDesat;
        uniform float uPunch;
        uniform int   uCurve;
        varying vec2 vUv;

        vec3 sat3(vec3 v) { return clamp(v, 0.0, 1.0); }

        vec3 rgb2hsv(vec3 c) {
          vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
          vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
          vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
          float d = q.x - min(q.w, q.y);
          float e = 1.0e-10;
          return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
        }

        vec3 hsv2rgb(vec3 c) {
          vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
          vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
          return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
        }

        /* --- tone curves, lifted from three's tonemapping chunk so the look is
               identical to what the renderer would have produced on its own --- */

        const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
          vec3(1.6605, -0.1246, -0.0182),
          vec3(-0.5876, 1.1329, -0.1006),
          vec3(-0.0728, -0.0083, 1.1187));
        const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
          vec3(0.6274, 0.0691, 0.0164),
          vec3(0.3293, 0.9195, 0.0880),
          vec3(0.0433, 0.0113, 0.8956));

        vec3 agxContrast(vec3 x) {
          vec3 x2 = x * x;
          vec3 x4 = x2 * x2;
          return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
               - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
        }

        vec3 agx(vec3 color) {
          const mat3 inset = mat3(
            vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
            vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
            vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
          const mat3 outset = mat3(
            vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
            vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
            vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
          const float minEv = -12.47393;
          const float maxEv = 4.026069;

          color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
          color = inset * color;
          color = max(color, 1e-10);
          color = log2(color);
          color = (color - minEv) / (maxEv - minEv);
          color = clamp(color, 0.0, 1.0);
          color = agxContrast(color);
          color = outset * color;
          color = pow(max(vec3(0.0), color), vec3(2.2));
          color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
          return clamp(color, 0.0, 1.0);
        }

        vec3 acesFit(vec3 v) {
          vec3 a = v * (v + 0.0245786) - 0.000090537;
          vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
          return a / b;
        }

        vec3 aces(vec3 color) {
          const mat3 inMat = mat3(
            vec3(0.59719, 0.07600, 0.02840),
            vec3(0.35458, 0.90834, 0.13383),
            vec3(0.04823, 0.01566, 0.83777));
          const mat3 outMat = mat3(
            vec3(1.60475, -0.10208, -0.00327),
            vec3(-0.53108, 1.10813, -0.07276),
            vec3(-0.07367, -0.00605, 1.07602));
          color /= 0.6;
          color = inMat * color;
          color = acesFit(color);
          color = outMat * color;
          return sat3(color);
        }

        vec3 neutral(vec3 color) {
          const float startCompression = 0.8 - 0.04;
          const float desaturation = 0.15;
          float x = min(color.r, min(color.g, color.b));
          float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
          color -= offset;
          float peak = max(color.r, max(color.g, color.b));
          if (peak < startCompression) return sat3(color);
          float d = 1.0 - startCompression;
          float newPeak = 1.0 - d * d / (peak + d - startCompression);
          color *= newPeak / peak;
          float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
          return sat3(mix(color, vec3(newPeak), g));
        }

        vec3 toneMap(vec3 c) {
          if (uCurve == 1) return aces(c);
          if (uCurve == 2) return neutral(c);
          if (uCurve == 3) return sat3(c);
          return agx(c);
        }

        void main() {
          vec3 c = max(texture2D(tDiffuse, vUv).rgb, 0.0);

          c *= uExposure;

          // contrast about 18% grey, in log space so highlights survive
          vec3 lg = log2(max(c, 1e-6) / 0.18) * uContrast;
          c = exp2(lg) * 0.18;

          // slope / offset / power
          c = pow(max(c * uGain + uLift, vec3(0.0)), uInvGamma);

          // veiling floor — a bowl full of air has no true black in it
          c += uFloat * uFloatTint;

          // hue-selective shaping
          vec3 hsv = rgb2hsv(c);
          float h = hsv.x;
          // Hue is meaningless on near-grey pixels, so gate the selective work
          // on chroma. Without this gate, haze and overcast sky — which are
          // grey with an arbitrary hue — get dragged into the turf correction.
          float chromatic = smoothstep(0.10, 0.30, hsv.y);
          float green = smoothstep(0.155, 0.240, h) * (1.0 - smoothstep(0.400, 0.500, h)) * chromatic;
          // Skin window opens at h 0.028 (10°), not at 0. The away kit's trim is
          // #b3372e — H 5.4°, S 0.74 — which sat inside the old window and was
          // therefore having its saturation clamped to uSkinGuard (0.58) by a
          // guard that exists to stop *faces* going traffic-cone orange. The
          // brief says the red trim runs at full saturation; it is one of the
          // three things in the frame allowed to. Skin starts at H 15° and the
          // guard is a ceiling, so nothing on a face changes.
          float skin  = smoothstep(0.028, 0.046, h) * (1.0 - smoothstep(0.090, 0.135, h)) * chromatic;
          hsv.x = mix(hsv.x, 0.282, green * uGreenPush);
          hsv.y *= mix(1.0, uGreenSat, green);
          // Skin: pull the hue into the 20–35 deg band from either side, then
          // cap the chroma. 0.0715 is 25.7 deg, the middle of the band.
          hsv.x = mix(hsv.x, 0.0715, skin * uSkinHue);
          hsv.y = mix(hsv.y, min(hsv.y, uSkinGuard), skin);
          // Saturation shoulder. Without it a strongly lit turf albedo runs
          // straight into the gamut wall and reads as electric lime rather than
          // as grass; this rolls the top of the range off instead of clipping it.
          hsv.y = hsv.y <= uSatCeil
            ? hsv.y
            : uSatCeil + (1.0 - exp(-(hsv.y - uSatCeil) * 2.2)) * (1.0 - uSatCeil) * 0.62;
          c = hsv2rgb(hsv);

          // global saturation
          float y = luma(c);
          c = max(vec3(y) + (c - vec3(y)) * uSat, 0.0);

          // broadcast split tone
          float t = clamp(log2(max(y, 1e-6) / 0.18) * 0.22 + 0.5, 0.0, 1.0);
          t = t * t * (3.0 - 2.0 * t);
          c *= mix(uShadowTint, uHighTint, t);

          // the one and only tone map in this chain
          c = toneMap(c);

          // display-referred trim
          float y2 = luma(c);
          c = sat3(vec3(y2) + (c - vec3(y2)) * uPostSat);
          // …then take the chroma back out of the deep shadows, so the seating
          // bowl cannot out-saturate the two kits and the disc. Gated on the
          // gamma-encoded luma because that is the space the knee is quoted in
          // and the space the eye judges — this buffer is still linear.
          float shade = 1.0 - smoothstep(uShadowKnee.x, uShadowKnee.y,
                                         pow(max(y2, 0.0), 0.4545));
          c = mix(c, vec3(y2), shade * uShadowDesat);
          c = mix(c, c * c * (3.0 - 2.0 * c), uPunch);

          gl_FragColor = vec4(c, 1.0);
        }`,
    });
  }

  setExposure(v: number): void { this.u.uExposure.value = v; }
  setCurve(id: number): void { this.u.uCurve.value = id; }
}
