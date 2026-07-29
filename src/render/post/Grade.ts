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
        uLift: { value: new THREE.Vector3(-0.0042, -0.0014, 0.0052) },
        uGain: { value: new THREE.Vector3(1.034, 1.000, 0.966) },
        uInvGamma: { value: new THREE.Vector3(1, 1, 1) },
        uSat: { value: 1.05 },
        uGreenPush: { value: 0.20 },
        uGreenSat: { value: 1.07 },
        uSkinGuard: { value: 0.58 },
        uSatCeil: { value: 0.72 },
        // Teal shadows, warm highlights — the split every sports broadcast
        // truck runs, kept to ~7 % so it reads as a look and not as a filter.
        uShadowTint: { value: new THREE.Vector3(0.938, 0.992, 1.072) },
        uHighTint: { value: new THREE.Vector3(1.058, 1.008, 0.938) },
        uPostSat: { value: 1.10 },
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
        uniform float uSat;
        uniform float uGreenPush;
        uniform float uGreenSat;
        uniform float uSkinGuard;
        uniform float uSatCeil;
        uniform vec3  uShadowTint;
        uniform vec3  uHighTint;
        uniform float uPostSat;
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

          // hue-selective shaping
          vec3 hsv = rgb2hsv(c);
          float h = hsv.x;
          // Hue is meaningless on near-grey pixels, so gate the selective work
          // on chroma. Without this gate, haze and overcast sky — which are
          // grey with an arbitrary hue — get dragged into the turf correction.
          float chromatic = smoothstep(0.10, 0.30, hsv.y);
          float green = smoothstep(0.155, 0.240, h) * (1.0 - smoothstep(0.400, 0.500, h)) * chromatic;
          float skin  = smoothstep(0.000, 0.020, h) * (1.0 - smoothstep(0.090, 0.135, h)) * chromatic;
          hsv.x = mix(hsv.x, 0.270, green * uGreenPush);
          hsv.y *= mix(1.0, uGreenSat, green);
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
          c = mix(c, c * c * (3.0 - 2.0 * c), uPunch);

          gl_FragColor = vec4(c, 1.0);
        }`,
    });
  }

  setExposure(v: number): void { this.u.uExposure.value = v; }
  setCurve(id: number): void { this.u.uCurve.value = id; }
}
