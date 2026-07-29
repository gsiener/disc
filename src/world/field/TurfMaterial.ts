import * as THREE from 'three';
import { linearColor } from '../../util/Tex';
import { FIELD } from './Layout';
import { DETAIL_TILE, type MapSet } from './TurfTextures';
import type { WearMap } from './WearMap';

/**
 * The pitch surface shader.
 *
 * Built on MeshStandardMaterial so it keeps three's shadow, IBL and fog paths
 * (and so a cascaded-shadow rig can still patch it — see `chainCompile`).
 * Everything spatial is evaluated from world XZ:
 *
 *  - the baked detail set is sampled at two very different scales and blended
 *    by a low-frequency mask, so the 1.5 m repeat is invisible at any distance;
 *  - mow stripes are a *lay direction*, not a painted band: the contrast term
 *    is `layDir · viewDir`, so stripes invert as the camera crosses the field
 *    and vanish when you look straight down, exactly like real bent grass;
 *  - chalk is an analytic signed-distance mask over the regulation line
 *    segments, antialiased with fwidth. No decal geometry, no z-fighting, and
 *    it stays razor sharp in a macro crop. It is eroded by noise and by the
 *    live wear map, and it perturbs the normal so the paint sits *on* the grass;
 *  - the wear texture drives the grass→dry→bare-soil→mud progression, flattens
 *    the blade normals and rubs out the chalk.
 */

export interface TurfUniforms {
  [k: string]: THREE.IUniform;
}

/**
 * Installs an onBeforeCompile that survives a later assignment (three's CSM
 * addon overwrites `material.onBeforeCompile` wholesale when it sets a material
 * up for cascaded shadows). Ours always runs first, theirs runs after.
 */
function chainCompile(
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

const PRELUDE = /* glsl */`
varying vec3 vFWorld;
varying vec3 vFNormal;

uniform sampler2D uDetailA;
uniform sampler2D uDetailN;
uniform sampler2D uDetailD;
uniform sampler2D uWear;
uniform vec2  uWearMin;
uniform vec2  uWearInv;
uniform vec3  uSunDir;
uniform vec3  uSunTint;
uniform vec3  uTintLush;
uniform vec3  uTintDry;
uniform vec3  uColDirt;
uniform vec3  uColMud;
uniform vec3  uColChalk;
uniform float uTile;
uniform float uNormalScale;
uniform float uStripeWidth;
uniform float uStripeStrength;

float gRough;
float gAO;
vec3  gEmis;
vec3  gNrmW;
vec3  gTurfColor;

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

/* nearest point on a segment: (distance, unit direction away from the line) */
void tryLine(inout vec3 best, vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  vec2 d = pa - ba * t;
  float l = length(d);
  if (l < best.x) best = vec3(l, l > 1e-4 ? d / l : vec2(0.0, 1.0));
}

/* the regulation set: two sidelines, two endlines, two goal lines, two bricks */
vec3 chalkNearest(vec2 p) {
  vec3 best = vec3(1e6, 0.0, 1.0);
  const float W = ${FIELD.halfWidth.toFixed(2)};
  const float L = ${FIELD.halfLength.toFixed(2)};
  const float G = ${FIELD.goalLine.toFixed(2)};
  const float B = ${FIELD.brick.toFixed(2)};
  vec2 q = vec2(abs(p.x), abs(p.y));
  tryLine(best, q, vec2(W, 0.0), vec2(W, L));
  tryLine(best, q, vec2(0.0, L), vec2(W, L));
  tryLine(best, q, vec2(0.0, G), vec2(W, G));
  tryLine(best, q, vec2(0.0, B - 0.5), vec2(0.0, B + 0.5));
  tryLine(best, q, vec2(0.0, B), vec2(0.5, B));
  // mirror the gradient back out of the folded quadrant
  best.yz *= vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
  return best;
}

/* remnants of the football pitch this field is painted over */
vec3 ghostNearest(vec2 p) {
  vec3 best = vec3(1e6, 0.0, 1.0);
  tryLine(best, p, vec2(-24.0, 0.0), vec2(24.0, 0.0));
  float r = length(p);
  float d = abs(r - 9.15);
  if (d < best.x) best = vec3(d, (r > 1e-3 ? p / r : vec2(1.0, 0.0)) * sign(r - 9.15));
  return best;
}

void turfShade() {
  vec3 W = vFWorld;
  vec2 P = W.xz;
  vec3 Vw = cameraPosition - W;
  Vw = normalize(Vw);

  // world-space size of this pixel — drives every detail LOD analytically,
  // which is what keeps the grazing turf-macro angle from fizzing
  float px = max(length(vec2(dFdx(P.x), dFdy(P.x))), length(vec2(dFdx(P.y), dFdy(P.y))));
  float near = 1.0 - smoothstep(0.0025, 0.020, px);

  /* ---- wear ---- */
  vec2 wuv = clamp((P - uWearMin) * uWearInv, 0.0, 1.0);
  vec4 wv = texture2D(uWear, wuv);
  float wear = wv.r;
  float chalkCut = wv.g;
  float mudA = wv.b;

  /* ---- analytic detail cascade -------------------------------------------
     Baked maps mip away to a flat average past a few metres, which is exactly
     when a pitch starts to look like painted card. These octaves are evaluated
     per pixel from world position, so each one holds until its own features go
     sub-pixel and then bows out cleanly. Together they cover 0.3 m tufts up to
     40 m drainage patches — no scale is ever featureless, and nothing tiles. */
  float mott = 0.0;
  if (px < 0.10) mott += 0.30 * fFbm(P * 3.10, 2) * (1.0 - smoothstep(0.025, 0.10, px));
  if (px < 0.40) mott += 0.36 * fFbm(P * 0.78 + 3.0, 3) * (1.0 - smoothstep(0.10, 0.40, px));
  if (px < 2.20) mott += 0.44 * fFbm(P * 0.175 + 9.0, 3) * (1.0 - smoothstep(0.55, 2.20, px));
  mott += 0.52 * fFbm(P * 0.043 + 21.0, 3);
  mott += 0.34 * fFbm(P * 0.0115 + 47.0, 2);
  mott *= 0.52;

  /* ---- two-scale baked detail ---- */
  const mat2 R2 = mat2(0.682, 0.731, -0.731, 0.682);
  const mat2 R2i = mat2(0.682, -0.731, 0.731, 0.682);
  vec2 uv1 = P / uTile;
  vec2 uv2 = (R2 * P) / (uTile * 4.13);
  float k = 0.22 + 0.16 * (mott * 0.5 + 0.5);

  vec3 a1 = texture2D(uDetailA, uv1).rgb;
  vec3 a2 = texture2D(uDetailA, uv2).rgb;
  vec3 col = mix(a1, a2, k);

  vec3 d1 = texture2D(uDetailD, uv1).rgb;
  vec3 d2 = texture2D(uDetailD, uv2).rgb;
  vec3 dd = mix(d1, d2, k);

  vec2 n1 = texture2D(uDetailN, uv1).xy * 2.0 - 1.0;
  vec2 n2 = R2i * (texture2D(uDetailN, uv2).xy * 2.0 - 1.0);
  vec2 nrm = mix(n1, n2 * 0.65, k);
  // an extra octave that only exists when a pixel is smaller than a blade
  if (near > 0.01) {
    vec2 n3 = texture2D(uDetailN, P / (uTile * 0.42)).xy * 2.0 - 1.0;
    nrm += n3 * near * 0.60;
    col *= 1.0 + 0.16 * near * (fNoise(P * 240.0) - 0.5);
  }

  /* ---- health / wear colour ramp ---- */
  float health = clamp(0.60 + 0.46 * mott - 1.15 * wear, 0.0, 1.0);
  col *= mix(uTintDry, uTintLush, smoothstep(0.10, 0.82, health));
  col *= 1.0 + 0.19 * mott;

  float dirt = smoothstep(0.34, 0.86, wear + 0.10 * mott);
  vec3 soil = uColDirt * (0.70 + 0.60 * (fFbm(P * 5.5, 3) * 0.5 + 0.5));
  // clods of turned soil where the sward has gone entirely
  soil *= 0.82 + 0.40 * step(0.55, fNoise(P * 22.0));
  col = mix(col, soil, dirt);

  float mud = smoothstep(0.20, 0.78, mudA) * smoothstep(0.10, 0.50, wear);
  col = mix(col, uColMud * (0.76 + 0.48 * (fFbm(P * 3.2 + 9.0, 2) * 0.5 + 0.5)), mud);

  /* ---- mow stripes: a lay direction, evaluated against the view ----------
     Not a painted band. The blades in alternating passes lie in opposite
     directions; you see their backs (bright) or their tips (dark) depending on
     where you stand, so the contrast term is layDir · viewDir and the stripes
     invert as the camera crosses the field and flatten out from directly
     overhead. The mower wanders, and the pass width breathes, so the edges are
     never perfectly parallel. */
  float wobble = 0.30 * fFbm(P * vec2(0.011, 0.0038) + 41.0, 2);
  float sCoord = P.y / uStripeWidth + wobble;
  float lay = clamp(cos(3.14159265 * sCoord) * 2.4, -1.0, 1.0);
  lay *= 0.80 + 0.32 * fFbm(P * vec2(0.006, 0.05) + 71.0, 2);
  float lookZ = -Vw.z;
  float sunZ = -uSunDir.z;
  float aniso = lay * (0.78 * lookZ + 0.34 * sunZ + 0.10);
  float stripeFade = 1.0 - smoothstep(uStripeWidth * 0.18, uStripeWidth * 0.75, px);
  aniso *= uStripeStrength * stripeFade * (1.0 - 0.80 * wear);
  col *= 1.0 + aniso * 0.19;
  nrm *= 1.0 + 0.22 * aniso;

  /* ---- surface response ---- */
  float rough = mix(0.72, 0.96, dd.g);
  rough -= 0.09 * aniso;
  rough = mix(rough, 0.95, dirt);
  rough = mix(rough, 0.33, mud);
  gAO = mix(dd.r, 0.85, dirt) * (0.86 + 0.16 * (mott * 0.5 + 0.5));

  /* ---- chalk ---- */
  float aa = max(px * 0.85, 0.0016);
  const float HW = ${FIELD.lineHalfWidth.toFixed(3)};
  vec3 cn = chalkNearest(P);
  float cov = 1.0 - smoothstep(HW - aa, HW + aa, cn.x);
  float grain = fFbm(P * 2.6 + 7.0, 3);
  cov *= mix(0.58, 1.0, smoothstep(-0.42, 0.42, grain));
  cov *= 1.0 - 0.72 * chalkCut;
  // overspray either side of the line
  float dust = (1.0 - smoothstep(HW, HW + 0.085, cn.x)) * 0.30 * smoothstep(-0.2, 0.5, grain);
  float chalk = clamp(cov + dust * (1.0 - cov), 0.0, 1.0);

  vec3 gn = ghostNearest(P);
  float gcov = 1.0 - smoothstep(0.055 - aa, 0.055 + aa, gn.x);
  gcov *= 0.42 * smoothstep(-0.15, 0.65, fFbm(P * 1.7 + 31.0, 3)) * (1.0 - 0.8 * chalkCut);

  vec3 chalkCol = uColChalk * (0.86 + 0.26 * fNoise(P * 95.0));
  col = mix(col, chalkCol * vec3(0.93, 0.92, 0.86), gcov * (1.0 - chalk));
  col = mix(col, chalkCol, chalk * 0.95);
  rough = mix(rough, 0.96, chalk);
  gAO = mix(gAO, 1.0, chalk * 0.7);

  // paint sits proud of the sward: tilt the normal along the bead edges
  float bead = exp(-pow((cn.x - HW) / 0.030, 2.0)) * chalk;
  nrm = nrm * (1.0 - 0.72 * chalk) + cn.yz * bead * 1.5;

  /* ---- assemble ---- */
  vec2 pert = nrm * uNormalScale * (0.55 + 0.70 * near) * (1.0 - 0.5 * dirt) * (1.0 - 0.6 * mud);
  gNrmW = normalize(vFNormal + vec3(pert.x, 0.0, pert.y));
  gRough = clamp(rough, 0.06, 1.0);

  // forward scatter through the blades when the sun is behind them
  float back = clamp(dot(Vw, -uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  gEmis = uSunTint * col * pow(back, 3.5) * dd.b * 0.42 * (1.0 - dirt) * (1.0 - chalk);

  gTurfColor = col;
}
`;

export interface TurfMaterialOpts {
  maps: MapSet;
  wear: WearMap;
  anisotropy: number;
}

export function makeTurfMaterial(opts: TurfMaterialOpts): {
  material: THREE.MeshStandardMaterial;
  uniforms: TurfUniforms;
} {
  const { maps, wear, anisotropy } = opts;
  for (const t of [maps.albedo, maps.normal, maps.data]) t.anisotropy = anisotropy;

  const uniforms: TurfUniforms = {
    uDetailA: { value: maps.albedo },
    uDetailN: { value: maps.normal },
    uDetailD: { value: maps.data },
    uWear: { value: wear.tex },
    uWearMin: { value: new THREE.Vector2(wear.minX, wear.minZ) },
    uWearInv: { value: new THREE.Vector2(1 / wear.spanX, 1 / wear.spanZ) },
    uSunDir: { value: new THREE.Vector3(-0.52, 0.77, 0.37) },
    uSunTint: { value: new THREE.Vector3(1.0, 0.86, 0.62) },
    uTintLush: { value: new THREE.Vector3(0.86, 1.02, 0.88) },
    uTintDry: { value: new THREE.Vector3(1.30, 1.04, 0.62) },
    uColDirt: { value: linearColor(0x6a5237) },
    uColMud: { value: linearColor(0x3f3123) },
    uColChalk: { value: linearColor(0xf2f3ee) },
    uTile: { value: DETAIL_TILE },
    uNormalScale: { value: 1.15 },
    uStripeWidth: { value: 5.2 },
    uStripeStrength: { value: 1.0 },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    dithering: true,
  });
  material.name = 'turf';

  chainCompile(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = 'varying vec3 vFWorld;\nvarying vec3 vFNormal;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vFWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
      vFNormal = normalize( mat3( modelMatrix ) * objectNormal );`,
    );

    shader.fragmentShader = PRELUDE + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      'turfShade();\n\tdiffuseColor.rgb = gTurfColor;',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      'float roughnessFactor = gRough;',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      'normal = normalize( ( viewMatrix * vec4( gNrmW, 0.0 ) ).xyz );',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += gEmis;',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <aomap_fragment>',
      `float ambientOcclusion = gAO;
      reflectedLight.indirectDiffuse *= ambientOcclusion;
      #if defined( USE_ENVMAP ) && defined( STANDARD )
        float dotNVao = saturate( dot( geometryNormal, geometryViewDir ) );
        reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNVao, ambientOcclusion, material.roughness );
      #endif`,
    );
  });
  material.customProgramCacheKey = () => 'ultimate-turf-v1';

  return { material, uniforms };
}
