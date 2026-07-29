/**
 * Grass GLSL, injected into MeshStandardMaterial via onBeforeCompile so the
 * blades keep the engine's shadows, fog, IBL and AgX tone mapping for free while
 * the vertex stage does all of the placement, bending and wind.
 *
 * There is no shared GLSL noise module in the tree, so the hash below is local
 * to this file. Everything smooth (gusts, tufting) comes from the baked noise
 * texture in maps.ts, which is generated with the sanctioned CPU noise utils —
 * a texture fetch is cheaper than procedural noise at eight million vertices.
 */

export const GRASS_COMMON = /* glsl */`
varying vec3  vGrassCol;
varying vec3  vGrassWPos;
varying vec3  vGrassWN;
varying vec3  vGrassWT;
// x: t along blade   y: roughness   z: root AO   w: sheen mask
varying vec4  vGrassAux;
`;

export const GRASS_VERT_DECL = /* glsl */`
attribute vec2 aCell;

uniform vec2      uCellOrigin;
uniform float     uCellSize;
uniform vec4      uRing;        // fadeInStart, fadeInEnd, fadeOutStart, fadeOutEnd
uniform float     uWidthScale;

uniform float     uTime;
uniform vec2      uWindDir;
uniform float     uWindStrength;
uniform vec2      uWindPhase;

uniform vec2      uTurfOrigin;
uniform vec2      uTurfSize;
uniform sampler2D uTurfMap;
uniform sampler2D uNoiseMap;
uniform sampler2D uBendMap;
uniform vec3      uBendRegion;  // cx, cz, halfSize

uniform float     uPxScale;
uniform float     uStripeW;
uniform float     uGroundY;
uniform vec2      uBlade;       // height, width
uniform float     uLean;
uniform float     uCurl;

uniform vec3      uColLush;
uniform vec3      uColDry;
uniform vec3      uColSoil;
uniform vec3      uColPaint;
uniform float     uStripeTint;

vec3 gHash3(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yzz) * q.zyx);
}

vec2 gRot(vec2 v, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

// Painted markings, analytic so they land exactly on regulation geometry:
// sidelines x = +-18.5, goal lines z = +-32, end lines z = +-50, brick marks.
float gPaint(vec2 p) {
  const float hw = 0.055;
  float ax = abs(p.x), az = abs(p.y);
  float sl = (1.0 - smoothstep(hw, hw + 0.035, abs(ax - 18.5))) * step(az, 50.12);
  float el = (1.0 - smoothstep(hw, hw + 0.035, min(abs(az - 50.0), abs(az - 32.0)))) * step(ax, 18.62);
  float bz = abs(az - 14.0);
  float bm = max(
    (1.0 - smoothstep(hw, hw + 0.035, ax)) * step(bz, 0.42),
    (1.0 - smoothstep(hw, hw + 0.035, bz)) * step(ax, 0.42));
  return clamp(max(max(sl, el), bm), 0.0, 1.0);
}

vec3 gPos;
vec3 gNrm;
`;

/**
 * Placement + bend + wind. Runs where <beginnormal_vertex> used to be, so the
 * result is available to the normal chunks and to <begin_vertex> below.
 */
export const GRASS_VERT_BODY = /* glsl */`
  vec2  cellId = uCellOrigin + aCell;
  vec3  h1 = gHash3(cellId);
  vec3  h2 = gHash3(cellId + 71.317);

  vec2  wxz = cellId * uCellSize + (h1.xy - 0.5) * uCellSize * 0.96;

  /* ---------------------------------------------------------------- LOD */
  float dist = length(wxz - cameraPosition.xz);
  float dith = (h1.z - 0.5) * 1.7;
  float fin  = uRing.y > uRing.x
    ? smoothstep(uRing.x, uRing.y, dist + dith * (uRing.y - uRing.x)) : 1.0;
  float fout = 1.0 - smoothstep(uRing.z, uRing.w, dist + dith * (uRing.w - uRing.z));
  float lod  = fin * fout;

  /* ------------------------------------------------------ turf lookup */
  vec2  tuv  = (wxz - uTurfOrigin) / uTurfSize;
  vec4  turf = texture2D(uTurfMap, tuv);          // lush, soil, wear, cover
  vec4  nse  = texture2D(uNoiseMap, wxz * 0.235); // tufting band
  float tuft = nse.b;

  float cover = turf.a * mix(0.55, 1.25, tuft);
  float grow  = smoothstep(0.12, 0.62, cover - h2.z * 0.34);
  lod *= grow;

  /* ------------------------------------------------- size + mow stripe */
  float stripe = floor(wxz.y / uStripeW);
  float sSign  = mod(stripe, 2.0) < 0.5 ? 1.0 : -1.0;

  float bh = uBlade.x * mix(0.62, 1.34, h2.x) * mix(0.72, 1.16, tuft)
           * mix(1.0, 0.40, turf.z) * lod;

  float bw = uBlade.y * uWidthScale * mix(0.78, 1.3, h2.y);
  // Never let a blade fall under ~1.3 px wide or it turns into crawling noise.
  bw = max(bw, min(dist * uPxScale * 1.3, uBlade.y * uWidthScale * 3.2));

  /* --------------------------------------------------------- direction */
  float yaw = (h2.z - 0.5) * 1.45 + (nse.b - 0.5) * 1.1;
  vec2  leanDir = gRot(vec2(0.0, sSign), yaw);

  /* -------------------------------------------------------------- wind */
  vec2  g1 = texture2D(uNoiseMap, (wxz - uWindPhase) * 0.055).rg;
  vec2  g2 = texture2D(uNoiseMap, (wxz - uWindPhase * 2.15) * 0.19).ga;
  float gust  = (g1.r - 0.5) * 2.0;
  float ripple = (g2.x - 0.5) * 2.0;
  float amp = uWindStrength * (0.42 + 0.85 * max(gust, -0.35) + 0.28 * ripple);
  float flut = sin(uTime * (7.4 + 4.0 * h1.x) + h1.y * 6.2831 + wxz.x * 2.7)
             * (0.055 + 0.13 * uWindStrength) * (0.4 + 0.6 * g2.y);

  vec2 bendV = leanDir * (uLean * mix(0.7, 1.25, h2.x))
             + uWindDir * (amp + flut);

  /* ------------------------------------------------------- interaction */
  vec2 buv = (wxz - uBendRegion.xy) / (2.0 * uBendRegion.z) + 0.5;
  vec2 push = texture2D(uBendMap, clamp(buv, 0.0, 1.0)).rg * 2.0 - 1.0;
  push *= step(0.0, buv.x) * step(buv.x, 1.0) * step(0.0, buv.y) * step(buv.y, 1.0);
  bendV += push * 2.1;

  float theta = length(bendV);
  vec2  bdir  = theta > 1e-4 ? bendV / theta : vec2(0.0, 1.0);
  theta = min(theta * mix(0.8, 1.15, h1.z), 1.62);

  /* ------------------------------------------------ circular-arc blade */
  float t    = position.y;
  float side = position.x;
  float taper = 1.0 - 0.78 * pow(t, 1.55);

  float k  = max(theta, 1e-3);
  float ct = cos(k * t), st = sin(k * t);
  float ax = bh * (1.0 - ct) / k;
  float ay = bh * st / k;

  vec3 tang = vec3(bdir.x * st, ct, bdir.y * st);
  vec3 wide = vec3(bdir.y, 0.0, -bdir.x);
  vec3 face = cross(wide, tang);

  float wHalf = side * bw * taper;
  float curlA = uCurl * side * 2.0 * (0.45 + 0.55 * taper);
  vec3 bladeP = vec3(bdir.x * ax, ay, bdir.y * ax)
              + wide * wHalf
              + face * (uCurl * bw * (side * side * 4.0 - 1.0) * 0.22 * taper);

  gPos = vec3(wxz.x, uGroundY, wxz.y) + bladeP;
  gNrm = normalize(face * cos(curlA) + wide * sin(curlA));

  /* ------------------------------------------------------------- shade */
  float paint = gPaint(wxz);
  vec3 col = mix(uColDry, uColLush, turf.x * mix(0.55, 1.25, tuft));
  col = mix(col, uColSoil, turf.y * 0.55);
  col *= mix(0.9, 1.16, h2.y);
  col *= 1.0 + sSign * uStripeTint;
  col = mix(col * 0.52, col * 1.1, smoothstep(0.0, 0.55, t));
  col = mix(col, uColPaint, paint * smoothstep(0.12, 0.62, t) * 0.88);

  vGrassCol   = col;
  vGrassWPos  = gPos;
  vGrassWN    = gNrm;
  vGrassWT    = tang;
  vGrassAux.x = t;
  vGrassAux.y = clamp(mix(0.30, 0.62, t) + turf.z * 0.22 + paint * 0.3, 0.05, 1.0);
  vGrassAux.z = mix(0.22, 1.0, smoothstep(0.0, 0.42, t)) * mix(1.0, 0.72, tuft);
  vGrassAux.w = mix(0.25, 1.0, t) * (1.0 - paint * 0.7);
`;

export const GRASS_FRAG_DECL = /* glsl */`
uniform vec3  uSunDir;      // surface -> sun, world
uniform vec3  uSunCol;
uniform vec3  uSssTint;
uniform vec3  uSkyCol;
uniform float uSssPower;
uniform float uSssScale;
uniform float uSssDistort;
uniform float uWrap;
uniform float uSheen;
uniform float uSheenExp;
`;

/**
 * Wrapped diffuse + forward scattering + a Kajiya-Kay sheen along the blade,
 * added on top of the standard BRDF. The scattering term is what makes the far
 * half of the pitch light up when the sun is low behind it.
 */
export const GRASS_FRAG_LIGHT = /* glsl */`
  {
    vec3 Nw = normalize(vGrassWN) * (gl_FrontFacing ? 1.0 : -1.0);
    vec3 Vw = normalize(cameraPosition - vGrassWPos);
    vec3 Lw = uSunDir;
    float ndl = dot(Nw, Lw);

    // Wrapped diffuse — softens the terminator the way a thin waxy leaf does.
    float wrapped = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);
    float extra = max(0.0, wrapped - max(ndl, 0.0));
    reflectedLight.directDiffuse += uSunCol * extra * 0.55 * diffuseColor.rgb;

    // Forward scattering through the blade (thin at the tip, thick at the root).
    vec3 Ht = normalize(Lw + Nw * uSssDistort);
    float fwd = pow(clamp(dot(Vw, -Ht), 0.0, 1.0), uSssPower) * uSssScale;
    float thick = mix(0.28, 1.0, vGrassAux.x);
    reflectedLight.directDiffuse += uSunCol * uSssTint * (fwd * thick) * diffuseColor.rgb;

    // Anisotropic sheen along the blade — this is what keeps mow stripes reading.
    vec3 Tw = normalize(vGrassWT);
    float tl = dot(Tw, Lw), tv = dot(Tw, Vw);
    float sl = sqrt(max(0.0, 1.0 - tl * tl)), sv = sqrt(max(0.0, 1.0 - tv * tv));
    float sp = pow(max(0.0, tl * tv + sl * sv), uSheenExp);
    reflectedLight.directSpecular += uSunCol * (sp * uSheen * vGrassAux.w * max(0.0, wrapped));

    // Cheap sky bounce so the shaded side is not dead.
    reflectedLight.indirectDiffuse += uSkyCol * (0.5 + 0.5 * Nw.y) * diffuseColor.rgb;
  }
`;
