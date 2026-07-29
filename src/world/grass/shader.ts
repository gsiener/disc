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

/**
 * How much of the mown rectangle (±33 × ±63) this point is inside. Outside it
 * the ground drops to the outfield datum and, in the 33..46 band, becomes
 * rubber crumb — which grass must not grow out of.
 */
float gTurfMask(vec2 q) {
  return (1.0 - smoothstep(31.0, 34.0, q.x)) * (1.0 - smoothstep(61.0, 64.0, q.y));
}

/**
 * Ground height, matching Terrain.analytic in field/Layout.ts: the pitch is
 * crowned ~1% and drains outward from the centre line. Blades were previously
 * pinned to a single constant Y, which floats them 16 cm above the turf by the
 * time you reach the sidelines. The fbm settlement waves are omitted — they are
 * ±7 cm over 50 m and cost more than they are worth at eight million vertices.
 */
float gGroundY(vec2 p, float turfMask) {
  vec2 q = abs(p);
  float tx = clamp(p.x / 20.0, -1.0, 1.0);
  float tz = clamp(q.y / 66.0, 0.0, 1.0);
  float edge = (1.0 - smoothstep(26.0, 33.0, q.x)) * (1.0 - smoothstep(56.0, 63.0, q.y));
  float crown = -0.185 * tx * tx * (1.0 - 0.40 * tz * tz) * edge;
  return mix(-0.16, crown, turfMask);
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

  /* ------------------------------------------------------------ tufting
     A jittered grid alone spreads blades evenly, and evenly-spread blades at
     any affordable budget read as isolated spikes on a painted floor. Real
     turf grows in tufts: pulling each blade a third of the way toward the
     centre of its 3×3 cell block concentrates nine blades into a clump, which
     multiplies *apparent* density without costing a single extra instance, and
     leaves genuine thatch gaps between clumps for the turf texture to show
     through. The clump centre is hashed from its own world cell, so it is as
     stable under a moving camera as the blades are. */
  vec2  base = cellId * uCellSize + (h1.xy - 0.5) * uCellSize * 0.96;
  vec2  clumpId = floor(cellId * 0.3333333);
  vec3  hc = gHash3(clumpId + 13.77);
  vec2  clumpC = (clumpId + 0.5 + (hc.xy - 0.5) * 0.72) * (uCellSize * 3.0);
  float pull = 0.24 + 0.22 * hc.z;
  vec2  wxz = mix(base, clumpC, pull);

  /* ---------------------------------------------------------------- LOD */
  float dist = length(wxz - cameraPosition.xz);
  float dith = (h1.z - 0.5) * 1.7;
  float fin  = uRing.y > uRing.x
    ? smoothstep(uRing.x, uRing.y, dist + dith * (uRing.y - uRing.x)) : 1.0;
  float fout = 1.0 - smoothstep(uRing.z, uRing.w, dist + dith * (uRing.w - uRing.z));
  float lod  = fin * fout;
  // How far along the "stop being an object, start being turf" ramp this blade
  // is. Past ~16 m a blade is one pixel wide and a few tall, so anything that
  // distinguishes it from the ground — its darker root, its extra height —
  // becomes a speck of litter on the pitch rather than a blade of grass.
  float farLod = smoothstep(3.0, 16.0, dist);

  /* ------------------------------------------------------ turf lookup */
  vec2  tuv  = (wxz - uTurfOrigin) / uTurfSize;
  vec4  turf = texture2D(uTurfMap, tuv);          // lush, soil, wear, cover
  vec4  nse  = texture2D(uNoiseMap, wxz * 0.235); // tufting band
  float tuft = nse.b;

  vec2  aw = abs(wxz);
  float turfMask = gTurfMask(aw);
  // The rubber-crumb apron runs from the mown edge out to 46 × 78; nothing
  // grows out of it. Past that the rough outfield picks up again.
  float rough = min(1.0, smoothstep(45.0, 51.0, aw.x) + smoothstep(77.0, 84.0, aw.y));
  float ground = max(turfMask, rough * 0.85);

  float cover = turf.a * mix(0.55, 1.25, tuft) * ground;
  float grow  = smoothstep(0.12, 0.62, cover - h2.z * 0.34);
  lod *= grow;

  /* ------------------------------------------------- size + mow stripe
     Passes run the length of the pitch, banded in X, at exactly the width the
     turf shader uses (field/Layout.ts MOW_STRIPE) and in phase with it: the
     shader's band is cos(pi*x/W) > 0, which is floor(x/W + 0.5) even here. The
     painted stripe and the physical lean have to agree or the anisotropy reads
     as two unrelated patterns laid over each other. */
  float stripe = floor(wxz.x / uStripeW + 0.5);
  float sSign  = mod(stripe, 2.0) < 0.5 ? 1.0 : -1.0;

  // Blades at the heart of a tuft grow taller than the stragglers around it.
  float clumpBoost = 1.0 - 0.30 * clamp(length(wxz - clumpC) / (uCellSize * 1.5), 0.0, 1.0);

  float bh = uBlade.x * mix(0.62, 1.34, h2.x) * mix(0.72, 1.16, tuft)
           * clumpBoost * mix(1.0, 1.55, rough) * mix(1.0, 0.60, farLod)
           * mix(1.0, 0.40, turf.z) * lod;

  float bw = uBlade.y * uWidthScale * mix(0.78, 1.3, h2.y);
  // Never let a blade fall under ~1.3 px wide or it turns into crawling noise.
  bw = max(bw, min(dist * uPxScale * 1.3, uBlade.y * uWidthScale * 3.2));

  /* --------------------------------------------------------- direction */
  float yaw = (h2.z - 0.5) * 1.45 + (nse.b - 0.5) * 1.1;
  vec2  leanDir = gRot(vec2(sSign, 0.0), yaw);

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

  gPos = vec3(wxz.x, gGroundY(wxz, turfMask) + uGroundY, wxz.y) + bladeP;
  gNrm = normalize(face * cos(curlA) + wide * sin(curlA));

  /* ------------------------------------------------------------- shade */
  float paint = gPaint(wxz);
  vec3 col = mix(uColDry, uColLush, turf.x * mix(0.55, 1.25, tuft));
  col = mix(col, uColSoil, turf.y * 0.55);
  col *= mix(0.86, 1.20, h2.y);
  // Blade-to-blade hue drift within a tuft — a clump of identically coloured
  // blades is the giveaway that this is instanced geometry.
  col *= vec3(1.0 + (h1.x - 0.5) * 0.16, 1.0 + (h1.y - 0.5) * 0.10, 1.0 - (h1.x - 0.5) * 0.20);
  col *= 1.0 + sSign * uStripeTint;
  /* Root shadowing is the strongest single cue that a blade is a solid object
     standing in a sward — and the fastest way to turn a distant blade into a
     dirt speck, because once it is six pixels tall the dark root is most of
     what you see. So it relaxes with distance: near blades are grounded, far
     blades converge on the turf they are supposed to be dissolving into. */
  col = mix(col * mix(0.44, 0.88, farLod), col * 1.14, smoothstep(0.0, 0.55, t));
  col = mix(col, mix(uColDry, uColLush, 0.62) * 1.12, farLod * 0.55);
  col = mix(col, uColPaint, paint * smoothstep(0.12, 0.62, t) * 0.88);

  vGrassCol   = col;
  vGrassWPos  = gPos;
  vGrassWN    = gNrm;
  vGrassWT    = tang;
  vGrassAux.x = t;
  vGrassAux.y = clamp(mix(0.28, 0.60, t) + turf.z * 0.22 + paint * 0.3, 0.05, 1.0);
  vGrassAux.z = mix(0.18, 1.0, smoothstep(0.0, 0.42, t)) * mix(1.0, 0.72, tuft);
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

    /* Forward scattering through the blade. This is the single term that does
       most of the work of making grass look like grass: a blade is a 0.2 mm
       waxy sheet, so with the sun behind it you are looking at transmitted
       light, not reflected, and it goes a much more saturated yellow-green
       than any lit face ever does. Two multipliers matter —

         - thinness, strongest at the tip (vGrassAux.x → 1), because that is
           where there is least leaf between the sun and the eye;
         - sun elevation, because a high sun puts the transmission lobe into
           the ground rather than into the camera. Low sun, big glow. */
    vec3 Ht = normalize(Lw + Nw * uSssDistort);
    float fwd = pow(clamp(dot(Vw, -Ht), 0.0, 1.0), uSssPower) * uSssScale;
    float thin = mix(0.24, 1.0, vGrassAux.x);
    float lowSun = mix(0.45, 1.0, 1.0 - clamp(Lw.y, 0.0, 1.0));
    reflectedLight.directDiffuse += uSunCol * uSssTint * (fwd * thin * lowSun) * diffuseColor.rgb;

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
