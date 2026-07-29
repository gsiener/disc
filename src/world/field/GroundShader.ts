import * as THREE from 'three';
import { FIELD, GRADE } from './Layout';

/**
 * Shared ground-shading plumbing.
 *
 * The pitch shader (TurfMaterial) learned early that a baked tile is only a
 * *near-field* asset: past a few metres its mip chain converges on the map's
 * linear mean and the surface becomes untextured card. Its answer is a band
 * cascade — analytic, world-space octaves that each retire the moment their own
 * features go sub-pixel, so no distance is ever featureless and nothing tiles.
 *
 * Everything in that answer is equally true of the run-off apron and the rough
 * outfield, which between them are the largest surfaces in a broadcast frame.
 * They used to be plain `MeshStandardMaterial` with one tiled set, so they died
 * at ~15 m while the pitch two metres away kept full structure. This module is
 * the cascade extracted so all three surfaces run the same code.
 */

/**
 * Installs an onBeforeCompile that survives a later assignment (three's CSM
 * addon overwrites `material.onBeforeCompile` wholesale when it sets a material
 * up for cascaded shadows). Ours always runs first, theirs runs after.
 */
export function chainCompile(
  mat: THREE.Material,
  mine: (shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => void,
): void {
  let other: ((s: THREE.WebGLProgramParametersWithUniforms, r: THREE.WebGLRenderer) => void) | null = null;
  Object.defineProperty(mat, 'onBeforeCompile', {
    configurable: true,
    enumerable: true,
    get() {
      return (s: THREE.WebGLProgramParametersWithUniforms, r: THREE.WebGLRenderer) => {
        mine(s, r);
        other?.(s, r);
      };
    },
    set(fn) { other = typeof fn === 'function' ? fn : null; },
  });
}

/** Value noise + fbm, rotated per octave so the lattice never shows. */
export const GROUND_NOISE = /* glsl */`
float fHash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.71);
  return fract(p.x * p.y * 43758.5453);
}
float fNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = fHash(i), b = fHash(i + vec2(1.0, 0.0));
  float c = fHash(i + vec2(0.0, 1.0)), d = fHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fFbm(vec2 p, int oct) {
  float s = 0.0, a = 0.55, n = 0.0;
  mat2 R = mat2(0.86, 0.51, -0.51, 0.86);
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    s += a * fNoise(p); n += a;
    p = R * p * 2.07; a *= 0.5;
  }
  return (s / n) * 2.0 - 1.0;
}

/* World-space width of this pixel, from screen derivatives. The single control
   the whole cascade runs on: a band only contributes while its own features are
   still larger than this. */
float gPixel(vec2 P) {
  return max(length(vec2(dFdx(P.x), dFdy(P.x))), length(vec2(dFdx(P.y), dFdy(P.y))));
}

/* Chebyshev distance from the mown rectangle, in metres. Negative inside. */
float gOutsideTurf(vec2 P) {
  return max(abs(P.x) - ${FIELD.turfHalfX.toFixed(2)}, abs(P.y) - ${FIELD.turfHalfZ.toFixed(2)});
}
`;

export interface GroundDetailOpts {
  /** Apron gets tyre tracks, damp staining and grass encroachment at the mown edge. */
  kind: 'apron' | 'outfield';
  /** Linear-space colour of the mown sward — what encroaching grass fades to. */
  turfTint: THREE.Color;
}

/**
 * Chains a world-space detail cascade onto a plain MeshStandardMaterial.
 *
 * The baked tile keeps doing the near-field work; these octaves take over as it
 * mips away, so the surface still has structure at 40 m instead of collapsing
 * to a flat colour field. On the apron it also draws the things that make a
 * run-off legible as a used surface rather than a plane: two wheel ruts from
 * the roller, damp staining where water sheets off the pitch, packed traffic
 * along the touchline, and — the reason the pitch no longer ends in an edge —
 * an irregular fringe of grass creeping over the mown boundary.
 */
export function attachGroundDetail(mat: THREE.MeshStandardMaterial, o: GroundDetailOpts): void {
  const t = o.turfTint;
  const isApron = o.kind === 'apron';

  chainCompile(mat, (shader) => {
    shader.vertexShader = 'varying vec3 vGWorld;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vGWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
    );

    shader.fragmentShader = `varying vec3 vGWorld;\n${GROUND_NOISE}\n` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      {
        vec2 P = vGWorld.xz;
        float px = gPixel(P);

        /* ---- analytic band cascade -------------------------------------
           Fine → coarse, each band retiring as its features approach the
           pixel. The two coarsest are unconditional: they are the only thing
           still alive at the 40-90 m these rings sit at in a broadcast frame,
           and they are what stops the largest surface in the image reading as
           an untextured gradient. */
        float m = 0.0;
        if (px < 0.30) m += 0.50 * fFbm(P * 1.90 + 5.0, 2) * (1.0 - smoothstep(0.07, 0.30, px));
        if (px < 1.20) m += 0.66 * fFbm(P * 0.46 + 19.0, 3) * (1.0 - smoothstep(0.30, 1.20, px));
        m += 0.80 * fFbm(P * 0.115 + 41.0, 3);
        m += 0.52 * fFbm(P * 0.032 + 83.0, 2);
        m *= 0.44;
        diffuseColor.rgb *= 0.82 + 0.36 * (m * 0.5 + 0.5);

        float d = gOutsideTurf(P);
        ${isApron ? APRON_BODY : OUTFIELD_BODY}

        /* ---- mown edge --------------------------------------------------
           An irregular fringe of sward creeping out of the pitch. Without it
           the mown rectangle terminates on a dead-straight polygon boundary,
           which is the single clearest 'this is a mesh' tell a ground plane
           can carry. Authored at a fixed world scale and faded out once the
           fringe itself is sub-pixel, so it never fizzes. */
        float fr = 1.0 - smoothstep(-0.25, 1.55, d);
        fr *= smoothstep(0.16, 0.62, fr + 0.60 * fFbm(P * 1.30 + 3.0, 3) + 0.22 * fFbm(P * 5.1, 2));
        fr *= 1.0 - smoothstep(0.12, 0.55, px);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${t.r.toFixed(4)}, ${t.g.toFixed(4)}, ${t.b.toFixed(4)}), clamp(fr, 0.0, 1.0) * 0.88);
      }`,
    );
  });
  mat.customProgramCacheKey = () => `ultimate-ground-${o.kind}-v1`;
}

/* Wheel ruts, damp staining and traffic packing on the crumb. */
const APRON_BODY = /* glsl */`
        /* two roller ruts running the ring, wandering by a metre or so */
        float wob = 1.10 * fFbm(P * 0.055 + 11.0, 2);
        float r1 = exp(-pow((d - 3.20 + wob) / 0.30, 2.0));
        float r2 = exp(-pow((d - 5.05 + wob) / 0.30, 2.0));
        float ruts = clamp(r1 + r2, 0.0, 1.0) * (1.0 - smoothstep(0.14, 0.55, px));
        diffuseColor.rgb *= 1.0 - 0.26 * ruts;

        /* the pitch sheds water outward, so the crumb nearest the turf stays
           damp and dark, in blotches rather than as a band */
        float damp = (1.0 - smoothstep(0.2, 3.4, d)) * smoothstep(-0.30, 0.45, fFbm(P * 0.30 + 27.0, 3));
        diffuseColor.rgb *= 1.0 - 0.22 * damp;

        /* and it is walked flat along the touchline, which polishes it lighter */
        float packed = (1.0 - smoothstep(1.0, 7.0, d)) * (0.55 + 0.45 * fFbm(P * 0.14 + 53.0, 2));
        diffuseColor.rgb *= 1.0 + 0.10 * packed;
`;

/* Unmown rough: coarse cross-cut banding at a much longer pitch than the field. */
const OUTFIELD_BODY = /* glsl */`
        float band = cos(P.y * ${(6.2831853 / 13.0).toFixed(6)} + 0.55 * fFbm(P * 0.030 + 7.0, 2));
        diffuseColor.rgb *= 1.0 + 0.055 * band * (1.0 - smoothstep(2.0, 7.0, px));
        /* it thins and dries as it runs away from the maintained ring */
        float dry = smoothstep(${(FIELD.apronHalfZ + 12).toFixed(1)}, ${(FIELD.apronHalfZ + 90).toFixed(1)}, max(abs(P.x) * ${(FIELD.apronHalfZ / FIELD.apronHalfX).toFixed(4)}, abs(P.y)));
        diffuseColor.rgb *= 1.0 - 0.16 * dry;
`;

/** Where the run-off surfaces sit, re-exported for convenience. */
export const APRON_Y = GRADE.apronY;
