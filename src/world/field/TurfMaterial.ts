import * as THREE from 'three';
import { linearColor } from '../../util/Tex';
import { FIELD, MOW_STRIPE as STRIPE_WIDTH } from './Layout';
import { DETAIL_TILE, type MapSet } from './TurfTextures';
import type { WearMap } from './WearMap';

/**
 * The pitch surface shader.
 *
 * Built on MeshStandardMaterial so it keeps three's shadow, IBL and fog paths
 * (and so a cascaded-shadow rig can still patch it — see `chainCompile`).
 * Everything spatial is evaluated from world XZ:
 *
 *  - a **band cascade**. Every frequency of surface detail is owned by exactly
 *    one band, and each band knows its own feature size, so it can retire the
 *    moment those features go sub-pixel. `px` — the world-space width of this
 *    pixel, from screen-space derivatives — is the single control. Bands, from
 *    fine to coarse: an analytic 2.5 cm grain (no texture, so it cannot tile);
 *    the baked 1 m tuft set; the same set rotated at 4.13 m; then four octaves
 *    of analytic fbm from 0.3 m up to 70 m. Once a band retires its texture
 *    contribution fades to that map's *mean* rather than to whatever the mip
 *    chain happened to average, so there is no residual tiling and no popping.
 *    This is what stops the pitch fizzing at a grazing angle, and it is why the
 *    far half of the field still has structure instead of being flat card;
 *  - mow stripes are a *lay direction*, not a painted band: the contrast term
 *    is `layDir · viewDir`, so stripes invert as the camera crosses the field
 *    and vanish when you look straight down, exactly like real bent grass;
 *  - chalk is an analytic signed-distance mask over the regulation line
 *    segments, resolved with a coverage-preserving box filter (the difference
 *    of two antialiased edges, not one `smoothstep` straddling the line). A
 *    single smoothstep whose width grows with `px` makes a distant line
 *    *fatter and just as bright*; a box filter makes it stay one pixel wide and
 *    get dimmer, which is what a real 12 cm line does at 60 m. No decal
 *    geometry, no z-fighting, razor sharp in a macro crop. It is eroded by
 *    noise and by the live wear map, and it perturbs the normal so the paint
 *    sits *on* the grass;
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
uniform vec3  uDetailMean;
uniform vec3  uDataMean;
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

  // World-space size of this pixel, from screen-space derivatives. This is the
  // one number the whole cascade runs on: a band is only allowed to contribute
  // while its own features are still bigger than 'px'.
  float px = max(length(vec2(dFdx(P.x), dFdy(P.x))), length(vec2(dFdx(P.y), dFdy(P.y))));

  // Authority of the two texture-borne bands. 'detail' covers the 1 m tuft set
  // (23 mm features), 'fine' the analytic sub-tuft grain. Both are generous at
  // the near end and fully retired well before their features reach 2 px.
  // 'px' is the *larger* of the two axis footprints, i.e. the along-view one at
  // a grazing angle, which is where a pitch aliases. Both bands retire while
  // their features are still ~4 px across rather than pushing to Nyquist and
  // relying on anisotropic filtering that only has 4 taps at the low tier.
  float detail = 1.0 - smoothstep(0.0040, 0.0220, px);
  float fine   = 1.0 - smoothstep(0.0014, 0.0070, px);

  /* ---- wear ---- */
  vec2 wuv = clamp((P - uWearMin) * uWearInv, 0.0, 1.0);
  vec4 wv = texture2D(uWear, wuv);
  float wear = wv.r;
  float chalkCut = wv.g;
  float mudA = wv.b;

  /* ---- analytic macro cascade --------------------------------------------
     Baked maps mip away to a flat average past a few metres, which is exactly
     when a pitch starts to look like painted card. These octaves are evaluated
     per pixel from world position, so each one holds until its own features go
     sub-pixel and then bows out cleanly. Together they cover 0.3 m tufts up to
     70 m drainage patches — no scale is ever featureless, and nothing tiles.
     The two coarsest carry most of the amplitude precisely because they are the
     only ones still alive at broadcast range. */
  float mott = 0.0;
  if (px < 0.090) mott += 0.26 * fFbm(P * 3.10, 2) * (1.0 - smoothstep(0.022, 0.090, px));
  if (px < 0.320) mott += 0.32 * fFbm(P * 1.05 + 3.0, 2) * (1.0 - smoothstep(0.075, 0.320, px));
  if (px < 1.300) mott += 0.40 * fFbm(P * 0.300 + 9.0, 3) * (1.0 - smoothstep(0.320, 1.300, px));
  mott += 0.66 * fFbm(P * 0.0620 + 21.0, 3);
  mott += 0.46 * fFbm(P * 0.0145 + 47.0, 2);
  mott *= 0.62;

  /* ---- two-scale baked detail --------------------------------------------
     The blend weight is itself driven by the macro field, so the same tile
     position gets a different mix everywhere on the pitch — that, rather than
     the second scale on its own, is what breaks the 1 m repeat. Past 'detail'
     both layers cross-fade to the map's linear mean instead of to whatever the
     mip chain converges on, which removes the last low-frequency ghost of the
     tile from the far half of the field. */
  const mat2 R2 = mat2(0.682, 0.731, -0.731, 0.682);
  const mat2 R2i = mat2(0.682, -0.731, 0.731, 0.682);
  vec2 uv1 = P / uTile;
  // Second layer at *nearly* the same scale, rotated 47° and offset. A big
  // magnification (this used to be 4.13x) is the obvious way to de-tile, but it
  // also blows the tuft bands up to 95 mm, and 95 mm directional bands over a
  // whole pitch read as corduroy. Same feature size, different phase and angle,
  // irrational scale ratio: the composite never repeats and never grows a
  // structure coarser than a tuft.
  vec2 uv2 = (R2 * P) / (uTile * 1.37) + vec2(3.71, 1.93);
  /* A near-hard *selection*, not a blend. Cross-fading two rotated copies of a
     directional texture superimposes two lay directions on the same pixel, and
     two lay directions on the same pixel is a crosshatch — the exact "woven
     fabric" tell we are trying to get rid of. Choosing one layer per region
     keeps the de-tiling (different parts of the pitch sample different parts of
     the tile) while never showing two grains at once. The transition band is
     narrow and driven by the macro field, so the seams land where the clump
     direction would plausibly change anyway. */
  float k = smoothstep(-0.06, 0.06, mott * 3.0);

  vec3 a1 = texture2D(uDetailA, uv1).rgb;
  vec3 a2 = texture2D(uDetailA, uv2).rgb;
  vec3 col = mix(mix(a1, a2, k), uDetailMean, 1.0 - detail);

  vec3 d1 = texture2D(uDetailD, uv1).rgb;
  vec3 d2 = texture2D(uDetailD, uv2).rgb;
  vec3 dd = mix(mix(d1, d2, k), uDataMean, 1.0 - detail);

  vec2 n1 = texture2D(uDetailN, uv1).xy * 2.0 - 1.0;
  vec2 n2 = R2i * (texture2D(uDetailN, uv2).xy * 2.0 - 1.0);
  vec2 nrm = mix(n1, n2 * 0.65, k) * detail;

  /* ---- sub-tuft grain ----------------------------------------------------
     Analytic, so it has no repeat at all, and two decorrelated bands so the
     coarse one can outlive the fine one instead of both cutting at once. This
     replaces a 'fNoise(P * 240.0)' term that had 4 mm features and no fade —
     four times past Nyquist for any pixel bigger than 2 mm, i.e. everywhere. */
  if (fine > 0.01) {
    // Rotated off the world axes: value noise is built on an axis-aligned
    // lattice and shows it as rectangular blotching if you sample it square.
    vec2 Pg = R2 * P;
    float ga = fNoise(Pg * 40.0) - 0.5;
    float gb = (fNoise(Pg * 97.0 + 17.0) - 0.5)
             * (1.0 - smoothstep(0.0010, 0.0042, px));
    float gc = fNoise(Pg * 40.0 + 71.0) - 0.5;
    col *= 1.0 + fine * (0.17 * ga + 0.13 * gb);
    nrm += vec2(ga + 0.6 * gb, gc) * fine * 0.55;
  }

  /* ---- health / wear colour ramp -----------------------------------------
     A well-kept pitch is *green*. The old bias put a mid-field wear of 0.3 far
     enough down the ramp that almost the whole surface landed on the dry tint,
     which is how a stadium pitch ends up reading as straw. */
  float health = clamp(0.82 + 0.44 * mott - 0.95 * wear, 0.0, 1.0);
  col *= mix(uTintDry, uTintLush, smoothstep(0.06, 0.68, health));
  col *= 0.90 + 0.30 * (mott * 0.5 + 0.5);

  float dirt = smoothstep(0.42, 0.92, wear + 0.10 * mott);
  vec3 soil = uColDirt * (0.70 + 0.60 * (fFbm(P * 5.5, 3) * 0.5 + 0.5));
  // clods of turned soil where the sward has gone entirely
  soil *= 0.82 + 0.40 * smoothstep(0.50, 0.60, fNoise(P * 22.0));
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
  // Passes run the length of the pitch (banded in X), which is the arrangement
  // a sideline camera sees best — and every shot in the rig is a sideline
  // camera, so 'Vw.x' is large in all of them and the stripes actually read.
  float wobble = 0.14 * fFbm(P * vec2(0.0038, 0.011) + 41.0, 2);
  float sCoord = P.x / uStripeWidth + wobble;
  float lay = clamp(cos(3.14159265 * sCoord) * 2.2, -1.0, 1.0);
  lay *= 0.80 + 0.32 * fFbm(P * vec2(0.05, 0.006) + 71.0, 2);
  float lookX = -Vw.x;
  float sunX = -uSunDir.x;
  float aniso = clamp(lay * (0.95 * lookX + 0.30 * sunX), -1.0, 1.0);
  float stripeFade = 1.0 - smoothstep(uStripeWidth * 0.30, uStripeWidth * 1.10, px);
  aniso *= uStripeStrength * stripeFade * (1.0 - 0.70 * wear);
  col *= 1.0 + aniso * 0.50;
  nrm *= 1.0 + 0.26 * aniso;

  /* ---- surface response ---- */
  float rough = mix(0.72, 0.96, dd.g);
  // The lay that brightens a stripe also turns its blades' waxy faces toward
  // you, so the stripe is glossier as well as lighter.
  rough -= 0.22 * aniso;
  // Lost normal variance has to come back as roughness or the far pitch turns
  // into a mirror-flat sheet that sparkles under the floodlights.
  rough += 0.10 * (1.0 - detail);
  rough = mix(rough, 0.95, dirt);
  rough = mix(rough, 0.33, mud);
  gAO = mix(dd.r, 0.85, dirt) * (0.86 + 0.16 * (mott * 0.5 + 0.5)) * (1.0 + 0.10 * aniso);

  /* ---- chalk -------------------------------------------------------------
     Coverage-preserving: the difference of two antialiased edges is the exact
     box-filtered coverage of the band [-HW, HW] under a footprint of 'px', so
     a line that goes sub-pixel gets *dimmer* and stays one pixel wide instead
     of ballooning into a fat grey smear. */
  float aa = max(px, 0.0012);
  const float HW = ${FIELD.lineHalfWidth.toFixed(3)};
  vec3 cn = chalkNearest(P);
  float cov = clamp((HW - cn.x) / aa + 0.5, 0.0, 1.0)
            - clamp((-HW - cn.x) / aa + 0.5, 0.0, 1.0);
  float grain = fFbm(P * 2.6 + 7.0, 3);
  cov *= mix(0.66, 1.0, smoothstep(-0.42, 0.42, grain));
  cov *= 1.0 - 0.55 * chalkCut;
  // Overspray either side of the line — the soft edge is scattered powder on
  // the blades, not a filtering artefact, so it is authored at a fixed world
  // width and antialiased the same way.
  float dw = max(px, 0.010);
  float dust = (clamp((HW + 0.075 - cn.x) / dw + 0.5, 0.0, 1.0)
              - clamp((-HW - 0.075 - cn.x) / dw + 0.5, 0.0, 1.0))
             * 0.32 * smoothstep(-0.2, 0.5, grain);
  float chalk = clamp(cov + dust * (1.0 - cov), 0.0, 1.0);

  vec3 gn = ghostNearest(P);
  float gcov = clamp((0.055 - gn.x) / aa + 0.5, 0.0, 1.0)
             - clamp((-0.055 - gn.x) / aa + 0.5, 0.0, 1.0);
  gcov *= 0.42 * smoothstep(-0.15, 0.65, fFbm(P * 1.7 + 31.0, 3)) * (1.0 - 0.8 * chalkCut);

  vec3 chalkCol = uColChalk * (0.90 + 0.20 * fNoise(P * 95.0) * fine);
  col = mix(col, chalkCol * vec3(0.93, 0.92, 0.86), gcov * (1.0 - chalk));
  col = mix(col, chalkCol, chalk * 0.95);
  rough = mix(rough, 0.96, chalk);
  gAO = mix(gAO, 1.0, chalk * 0.7);

  // paint sits proud of the sward: tilt the normal along the bead edges
  float bead = exp(-pow((cn.x - HW) / 0.030, 2.0)) * chalk * detail;
  nrm = nrm * (1.0 - 0.72 * chalk) + cn.yz * bead * 1.5;

  /* ---- assemble ----------------------------------------------------------
     The mow lay is also a real tilt of the effective surface — a pass of bent
     grass presents its backs to one side — and unlike the baked relief it is a
     metre-scale feature, so it never mips away. Applying it to the normal is
     what keeps the stripes alive at broadcast range and is why they respond to
     the sun moving as well as to the camera moving. */
  vec2 pert = nrm * uNormalScale * (1.0 - 0.5 * dirt) * (1.0 - 0.6 * mud);
  pert.x += lay * 0.30 * stripeFade * (1.0 - 0.70 * wear) * (1.0 - chalk);
  gNrmW = normalize(vFNormal + vec3(pert.x, 0.0, pert.y));
  gRough = clamp(rough, 0.06, 1.0);

  // Forward scatter through the blades when the sun is behind them. Strongest
  // at a grazing view, because that is when the sightline passes through the
  // most leaf: the pitch lights up towards the far touchline at golden hour.
  float back = clamp(dot(Vw, -uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  float graze = 1.0 - abs(Vw.y);
  gEmis = uSunTint * col * pow(back, 3.0) * (0.28 + 0.72 * graze)
        * mix(uDataMean.b, dd.b, detail) * 0.85 * (1.0 - dirt) * (1.0 - chalk);

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
    uTintLush: { value: new THREE.Vector3(0.78, 1.08, 0.72) },
    uTintDry: { value: new THREE.Vector3(1.26, 1.02, 0.58) },
    uColDirt: { value: linearColor(0x6a5237) },
    uColMud: { value: linearColor(0x3f3123) },
    uColChalk: { value: linearColor(0xf2f3ee) },
    uDetailMean: { value: maps.meanAlbedo.clone() },
    uDataMean: { value: maps.meanData.clone() },
    uTile: { value: DETAIL_TILE },
    uNormalScale: { value: 0.62 },
    uStripeWidth: { value: STRIPE_WIDTH },
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
