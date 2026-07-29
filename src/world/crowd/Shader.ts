import * as THREE from 'three';

/**
 * All crowd shading lives here. One lighting model is shared by the spectators,
 * the seats and the cloth props so the whole bowl greys out into the distance
 * as a single mass rather than as thousands of individually-lit dolls.
 *
 * The lighting uniforms are created once and handed to every material *by
 * reference*, so a single `sun:changed` update relights everything.
 */

export interface LightUniforms {
  [k: string]: THREE.IUniform;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunCol: THREE.IUniform<THREE.Color>;
  uSkyCol: THREE.IUniform<THREE.Color>;
  uGndCol: THREE.IUniform<THREE.Color>;
  uAmb: THREE.IUniform<THREE.Color>;
  uTowers: THREE.IUniform<THREE.Vector4[]>;
  uTowerCol: THREE.IUniform<THREE.Color[]>;
  uHaze: THREE.IUniform<THREE.Color>;
  uHazeRange: THREE.IUniform<THREE.Vector2>;
  uNight: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uUpperShade: THREE.IUniform<THREE.Vector2>;
}

export function makeLightUniforms(): LightUniforms {
  return {
    uSunDir: { value: new THREE.Vector3(-0.52, 0.78, 0.35).normalize() },
    uSunCol: { value: new THREE.Color(1.0, 0.94, 0.85).multiplyScalar(3.2) },
    uSkyCol: { value: new THREE.Color(0.42, 0.58, 0.9).multiplyScalar(1.1) },
    uGndCol: { value: new THREE.Color(0.14, 0.16, 0.1).multiplyScalar(1.1) },
    uAmb: { value: new THREE.Color(0, 0, 0) },
    uTowers: {
      value: [new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0),
        new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0)],
    },
    uTowerCol: {
      value: [new THREE.Color(1, 1, 1), new THREE.Color(1, 1, 1),
        new THREE.Color(1, 1, 1), new THREE.Color(1, 1, 1)],
    },
    uHaze: { value: new THREE.Color(0.62, 0.74, 0.92) },
    uHazeRange: { value: new THREE.Vector2(28, 260) },
    uNight: { value: 0 },
    uTime: { value: 0 },
    uUpperShade: { value: new THREE.Vector2(9.5, 0.22) },
  };
}

/* ------------------------------------------------------------------ chunks */

const LIGHT_PARS = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform vec3 uGndCol;
uniform vec3 uAmb;
uniform vec4 uTowers[4];
uniform vec3 uTowerCol[4];
uniform vec3 uHaze;
uniform vec2 uHazeRange;
uniform float uNight;

const float RPI = 0.3183098862;

vec3 irradiance(vec3 N, vec3 wp, float sunVis) {
  vec3 irr = uSunCol * max(dot(N, uSunDir), 0.0) * sunVis;
  irr += mix(uGndCol, uSkyCol, 0.5 + 0.5 * N.y) + uAmb;
  for (int i = 0; i < 4; i++) {
    vec4 t = uTowers[i];
    if (t.w <= 0.0) continue;
    vec3 L = t.xyz - wp;
    float d2 = max(dot(L, L), 9.0);
    irr += uTowerCol[i] * (t.w / d2) * max(dot(N, L * inversesqrt(d2)), 0.0);
  }
  return irr;
}

// Aerial perspective: contrast and saturation bleed out with range so the far
// stands read as texture, not as thousands of tiny lit figures.
vec3 aerial(vec3 col, float dist) {
  float f = smoothstep(uHazeRange.x, uHazeRange.y, dist);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(l), f * 0.5);
  return mix(col, uHaze, f * 0.74);
}
`;

/* ------------------------------------------------------------- spectators */

export const CROWD_VERT = /* glsl */`
attribute float aPart;
attribute float aSide;
attribute float aT;

attribute vec3 iPos;
attribute float iYaw;
attribute vec4 iRand;
attribute vec2 iSize;
attribute vec3 iShirt;
attribute vec3 iSkin;
attribute vec3 iHair;
attribute vec4 iFlags;      // x enthusiasm, y stand threshold, z prop, w hat
attribute float iRowT;      // 0 front row, 1 back row

uniform float uTime;
uniform float uEnergy;
uniform float uNight;
uniform float uNearEnd;
uniform vec4 uWaves[3];     // xy origin, z start time, w strength
uniform float uWaveInvSpeed;
uniform vec2 uUpperShade;
uniform vec3 uSunDir;

varying vec3 vCol;
varying vec3 vN;
varying vec3 vW;
varying vec2 vUv;
varying vec4 vX;            // part, ao, emissive, detail offset
varying vec4 vAlt;          // jersey band colour + band count (0 = plain)
varying float vSun;         // direct-sun visibility (roof + stand occlusion)

mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.,0.,0., 0.,c,s, 0.,-s,c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c,s,0., -s,c,0., 0.,0.,1.); }
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }

void main() {
  float part = aPart;
  float prop = iFlags.z;
  float hat  = iFlags.w;

  // ---- per-instance behaviour -------------------------------------------
  float ph   = iRand.x * 6.2831853;
  float freq = 0.30 + iRand.y * 0.34;
  float enth = iFlags.x;

  float exc = uEnergy * (0.30 + 0.95 * enth);
  for (int i = 0; i < 3; i++) {
    vec4 w = uWaves[i];
    if (w.w <= 0.0) continue;
    float d = distance(iPos.xz, w.xy);
    // individual reaction delay — nobody in a real crowd moves on the same beat
    float t = uTime - w.z - d * uWaveInvSpeed - iRand.w * 0.45;
    float pulse = smoothstep(0.0, 0.32, t) * exp(-max(t - 0.70, 0.0) * 0.8);
    exc = max(exc, w.w * pulse * (0.35 + 0.9 * enth));
  }
  exc = clamp(exc, 0.0, 1.35);

  // Standing: threshold varies per person, so the stand-up ramps through the
  // crowd instead of flipping as one.
  float stand = smoothstep(iFlags.y, iFlags.y + 0.30, exc);
  // …plus a slow trickle of people on their feet at any moment.
  stand = max(stand, smoothstep(0.981, 0.996, sin(uTime * 0.043 + iRand.z * 43.7) * 0.5 + 0.5));
  // Arms only come up for the keen, and only once something is actually
  // happening — a stand where everyone is in the same Y pose reads as a toy.
  float cheer = clamp((exc - 0.20) * 1.5, 0.0, 1.0) * smoothstep(0.25, 0.75, enth);

  float sway  = sin(uTime * freq * 6.2831853 + ph);
  float sway2 = sin(uTime * freq * 4.1 + ph * 1.7 + 1.3);
  float lean  = sway * (0.028 + 0.055 * exc) + 0.055 + iRand.z * 0.10;
  float roll  = sway2 * (0.022 + 0.05 * exc);
  mat3 Rtorso = rotZ(roll) * rotX(lean);

  float headYaw   = (iRand.w - 0.5) * 0.85 + 0.10 * sin(uTime * 0.29 + ph);
  float headPitch = -0.10 + 0.08 * sin(uTime * 0.23 + ph * 2.1) - 0.34 * cheer;
  mat3 Rhead = rotY(headYaw) * rotX(headPitch);

  float style = step(0.52, iRand.w);                       // 1 = arms up, 0 = clap
  float clapOsc = sin(uTime * (9.0 + 4.0 * iRand.y) + ph);
  float armA = mix(-1.02 - 0.20 * clapOsc, -2.32 + 0.13 * sin(uTime * 5.0 + ph), style) * cheer;
  float armS = mix(-0.42, 0.30, style) * cheer;
  // Phone-holders keep a forearm up whether or not anything is happening.
  if (abs(prop - 2.0) < 0.5) armA -= 0.78 * (1.0 - cheer);
  mat3 Rarm = rotX(armA) * rotZ(-aSide * armS);

  float thighA = stand * 1.44;
  mat3 Rthigh = rotX(thighA);
  mat3 Rshin  = rotX(-thighA * 0.96);

  float bounce = max(0.0, sin(uTime * 6.4 + ph * 3.1)) * 0.055 * stand
               * clamp(exc * 1.6 - 0.7, 0.0, 1.0);
  float bob = sin(uTime * freq * 3.6 + ph * 1.3) * (0.004 + 0.012 * exc);
  vec3 hips = vec3(0.0, stand * 0.44 + bounce + bob, 0.0);

  // ---- skeleton ----------------------------------------------------------
  const vec3 T0 = vec3(0.0, 0.14, 0.0);
  const vec3 H0 = vec3(0.0, 0.46, 0.012);
  const vec3 K0 = vec3(0.0, 0.0, 0.44);
  const vec3 HAND = vec3(0.0, -0.30, 0.245);
  vec3 S0 = vec3(aSide * 0.163, 0.395, 0.0);
  vec3 P0 = vec3(aSide * 0.105, 0.055, 0.045);

  vec3 p = position;
  vec3 nrm = normal;
  vec3 lp;
  vec3 ln;
  float collapse = 0.0;

  if (part < 0.5) {                       // pelvis
    lp = hips + p; ln = nrm;
  } else if (part < 1.5) {                // torso
    lp = hips + T0 + Rtorso * p; ln = Rtorso * nrm;
  } else if (part < 3.5 || part > 8.5) {  // head, hair, cap brim
    mat3 R = Rtorso * Rhead;
    lp = hips + T0 + Rtorso * H0 + R * p; ln = R * nrm;
    if (part > 8.5 && hat < 0.5) collapse = 1.0;
  } else if (part < 4.5) {                // arm
    mat3 R = Rtorso * Rarm;
    lp = hips + T0 + Rtorso * S0 + R * p; ln = R * nrm;
  } else if (part < 5.5) {                // thigh
    lp = hips + P0 + Rthigh * p; ln = Rthigh * nrm;
  } else if (part < 6.5) {                // shin
    mat3 R = Rthigh * Rshin;
    lp = hips + P0 + Rthigh * K0 + R * p; ln = R * nrm;
  } else {                                // held prop / phone, right hand
    mat3 R = Rtorso * Rarm;
    lp = hips + T0 + Rtorso * S0 + R * (HAND + p); ln = R * nrm;
    float want = part < 7.5 ? 1.0 : 2.0;
    if (abs(prop - want) > 0.5) collapse = 1.0;
  }

  float localY = lp.y;
  lp *= iSize.x;
  lp.xz *= iSize.y;

  float cy = cos(iYaw), sy = sin(iYaw);
  vec3 wp = vec3(cy * lp.x + sy * lp.z, lp.y, -sy * lp.x + cy * lp.z) + iPos;
  vec3 wn = normalize(vec3(cy * ln.x + sy * ln.z, ln.y, -sy * ln.x + cy * ln.z));

  // ---- LOD gate ----------------------------------------------------------
  float dist = distance(cameraPosition, iPos);
  float thr = uNearEnd * (0.70 + 0.30 * iRand.z);
  #ifdef LOD_NEAR
    if (dist > thr) collapse = 1.0;
  #else
    if (dist <= thr) collapse = 1.0;
  #endif
  if (collapse > 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  // ---- colour ------------------------------------------------------------
  vec3 shorts = mix(vec3(0.055, 0.06, 0.075), vec3(0.30, 0.28, 0.25), iRand.y)
              * (0.75 + 0.55 * iRand.w);
  float sleeve = iRand.z < 0.16 ? 0.25 : (iRand.z < 0.80 ? 0.5 : 1.0);
  float hem = iRand.w < 0.72 ? 0.5 : 1.0;
  vec3 shirt = iShirt;
  // A slice of the crowd in banded kit — flat colour tiles to the eye instantly.
  vAlt = vec4(mix(shirt, iRand.x > 0.5 ? vec3(0.86, 0.87, 0.88) : vec3(0.04, 0.045, 0.06),
                  0.78), 0.0);
  if (iRand.y > 0.62 && aT < 1.5) vAlt.w = iRand.x > 0.5 ? 3.0 : 5.0;

  vec3 albedo;
  if (part < 0.5) albedo = shorts;
  else if (part < 1.5) albedo = aT > 1.5 ? iSkin : shirt;
  else if (part < 2.5) albedo = iSkin;
  else if (part < 3.5 || part > 8.5) albedo = iHair;
  else if (part < 4.5) albedo = aT <= sleeve + 0.01 ? shirt : iSkin;
  else if (part < 5.5) albedo = aT <= hem + 0.01 ? shorts : iSkin;
  else if (part < 6.5) albedo = aT > 1.5 ? vec3(0.05, 0.05, 0.06) : iSkin;
  else if (part < 7.5) albedo = mix(iShirt, vec3(1.0), 0.35);
  else albedo = vec3(0.72, 0.82, 1.0);

  // Ambient occlusion: a packed crowd is dark everywhere except the tops of
  // heads and shoulders, and the back rows sit under the roof line.
  float ao = mix(0.32, 1.0, smoothstep(-0.42, 0.76, localY));
  ao *= 0.90 + 0.16 * iRand.x;

  // Direct sun: the stand itself blocks the sun from behind, and the roof
  // cantilever shades the upper rows — most of a stadium is in its own shade.
  vec2 outward = -vec2(sy, cy);
  float back = dot(normalize(uSunDir.xz + vec2(1e-5)), outward);
  float open = smoothstep(0.30, -0.15, back);
  float deepAmt = mix(0.20, 0.80, smoothstep(0.22, 0.72, uSunDir.y));
  float deep = 1.0 - deepAmt * smoothstep(uUpperShade.x, uUpperShade.x + 0.45, iRowT);
  vSun = mix(0.10, 1.0, open) * deep;

  float emis = part > 7.5 && part < 8.5 ? (0.25 + 0.75 * uNight) : 0.0;

  vCol = albedo;
  vN = wn;
  vW = wp;
  vUv = uv;
  vX = vec4(part, ao, emis, iRand.x * 6.3);

  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const CROWD_FRAG = /* glsl */`
uniform sampler2D uDetail;
${LIGHT_PARS}

varying vec3 vCol;
varying vec3 vN;
varying vec3 vW;
varying vec2 vUv;
varying vec4 vX;
varying vec4 vAlt;
varying float vSun;

void main() {
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  float part = vX.x;

  float isHead = step(1.5, part) * step(part, 2.5);
  float isHair = step(2.5, part) * step(part, 3.5);

  vec3 dt = texture2D(uDetail, vUv * vec2(3.0, 4.0) + vX.w).rgb;
  float dv = mix(mix(dt.r, dt.g, isHead), dt.b, isHair);
  vec3 base = vCol;
  if (part > 0.5 && part < 1.5 && vAlt.w > 0.5) {
    base = mix(base, vAlt.rgb, step(0.5, fract(vUv.y * vAlt.w)));
  }
  vec3 albedo = base * (0.80 + 0.42 * dv);

  // Eyes and brow, placed in the head sphere's uv — enough of a face to read
  // as a person from the front row, invisible past ten metres.
  if (isHead > 0.5) {
    float e = min(length((vUv - vec2(0.216, 0.560)) * vec2(1.0, 1.7)),
                  length((vUv - vec2(0.284, 0.560)) * vec2(1.0, 1.7)));
    albedo *= 1.0 - 0.72 * smoothstep(0.026, 0.007, e);
    albedo *= 1.0 - 0.22 * smoothstep(0.055, 0.02,
                  length((vUv - vec2(0.25, 0.455)) * vec2(0.6, 1.0)));
  }

  vec3 irr = irradiance(N, vW, vSun);
  vec3 col = albedo * RPI * irr * vX.y;

  vec3 V = normalize(cameraPosition - vW);
  vec3 H = normalize(V + uSunDir);
  float sh = pow(max(dot(N, H), 0.0), mix(20.0, 58.0, isHead));
  col += uSunCol * sh * mix(0.020, 0.075, isHead) * max(dot(N, uSunDir), 0.0) * vSun;

  col += vec3(0.68, 0.80, 1.05) * vX.z * 2.6;

  col = aerial(col, distance(cameraPosition, vW));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ seats */

export const SEAT_VERT = /* glsl */`
attribute vec3 iPos;
attribute float iYaw;
attribute vec3 iCol;

varying vec3 vCol;
varying vec3 vN;
varying vec3 vW;

void main() {
  float cy = cos(iYaw), sy = sin(iYaw);
  vec3 p = position;
  vec3 wp = vec3(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z) + iPos;
  vec3 wn = normalize(vec3(cy * normal.x + sy * normal.z, normal.y,
                          -sy * normal.x + cy * normal.z));
  vCol = iCol;
  vN = wn;
  vW = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const SEAT_FRAG = /* glsl */`
${LIGHT_PARS}
varying vec3 vCol;
varying vec3 vN;
varying vec3 vW;

void main() {
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 col = vCol * RPI * irradiance(N, vW, 0.85) * 0.72;
  col = aerial(col, distance(cameraPosition, vW));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ cloth */

export const CLOTH_VERT = /* glsl */`
attribute float aCloth;
attribute vec3 iPos;
attribute float iYaw;
attribute vec4 iSize;      // width, height, phase, flutter
attribute vec3 iColA;
attribute vec3 iColB;
attribute float iStyle;    // 0..3 banner pattern, +10 = hand flag on a staff

uniform float uTime;
uniform float uEnergy;

varying vec3 vN;
varying vec3 vW;
varying vec2 vUv;
varying vec3 vA;
varying vec3 vB;
varying float vStyle;

void main() {
  vec2 g = uv;
  vec3 p = vec3((g.x - 0.5) * iSize.x, (g.y - 1.0) * iSize.y, 0.0);
  vec3 nrm = vec3(0.0, 0.0, 1.0);

  // Cloth ripple — amplitude grows away from the anchored edge.
  float t = uTime * (1.6 + iSize.z * 0.7) + iSize.z * 7.0;
  float amp = iSize.w * (0.35 + 0.65 * uEnergy);
  float fx = g.x;
  p.z += sin(fx * 5.5 + t * 2.2) * amp * fx * 0.5
       + sin(g.y * 3.0 - t * 1.7) * amp * fx * 0.35;
  p.y += sin(fx * 4.0 + t * 2.0) * amp * fx * 0.22;
  nrm = normalize(vec3(-cos(fx * 5.5 + t * 2.2) * amp * 2.2, 0.15, 1.0));

  if (aCloth < 0.5) {
    // Staff: only present on hand flags, otherwise collapsed.
    if (iStyle < 9.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    p = vec3(position.x - iSize.x * 0.5, position.y * iSize.y * 2.3 - iSize.y * 0.02,
             position.z);
    nrm = normalize(position * vec3(1.0, 0.0, 1.0) + vec3(0.0, 0.0, 0.001));
  }

  float cy = cos(iYaw), sy = sin(iYaw);
  vec3 wp = vec3(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z) + iPos;
  vec3 wn = normalize(vec3(cy * nrm.x + sy * nrm.z, nrm.y, -sy * nrm.x + cy * nrm.z));

  vN = wn; vW = wp; vUv = g; vA = iColA; vB = iColB;
  vStyle = aCloth < 0.5 ? -1.0 : mod(iStyle, 10.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const CLOTH_FRAG = /* glsl */`
${LIGHT_PARS}
uniform sampler2D uDetail;

varying vec3 vN;
varying vec3 vW;
varying vec2 vUv;
varying vec3 vA;
varying vec3 vB;
varying float vStyle;

void main() {
  vec2 uvw = vUv;
  vec3 col3 = vA;
  if (vStyle < 0.0) {
    col3 = vec3(0.16, 0.13, 0.10);            // staff
  } else if (vStyle < 0.5) {
    // horizontal bars
    col3 = mix(vA, vB, step(0.5, fract(uvw.y * 3.0)));
  } else if (vStyle < 1.5) {
    // vertical thirds
    col3 = mix(vA, vB, step(0.34, uvw.x) * step(uvw.x, 0.66));
  } else if (vStyle < 2.5) {
    // chevron
    float c = abs(uvw.x - 0.5) * 1.6 + uvw.y * 0.9;
    col3 = mix(vB, vA, step(0.55, fract(c * 2.0)));
  } else {
    // diagonal sash with a bar
    col3 = mix(vA, vB, step(0.5, fract((uvw.x + uvw.y) * 2.5)));
    col3 = mix(col3, vB, step(0.78, uvw.y));
  }
  vec3 dt = texture2D(uDetail, uvw * vec2(8.0, 6.0)).rgb;
  col3 *= 0.84 + 0.32 * dt.r;

  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 col = col3 * RPI * irradiance(N, vW, 0.8) * 0.95;
  col = aerial(col, distance(cameraPosition, vW));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
