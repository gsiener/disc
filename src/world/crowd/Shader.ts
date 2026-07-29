import * as THREE from 'three';

/**
 * All crowd shading lives here. One lighting model is shared by the spectators,
 * the seats and the cloth props so the whole bowl greys out into the distance
 * as a single mass rather than as thousands of individually-lit dolls.
 *
 * The lighting uniforms are created once and handed to every material *by
 * reference*, so a single `sun:changed` update relights everything. All three
 * spectator LODs share one uniform block and one fragment shader, which is what
 * guarantees the colour and lighting are identical either side of a LOD switch.
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
  // Wrapped diffuse on the key. Skin and cloth both scatter, and a hard N·L
  // terminator on a 0.2 m limb is the classic "plastic doll" tell.
  float ndl = dot(N, uSunDir);
  vec3 irr = uSunCol * max((ndl + 0.22) / 1.22, 0.0) * sunVis;
  irr += mix(uGndCol, uSkyCol, 0.5 + 0.5 * N.y) + uAmb;
  // Ground bounce, and *only* on genuinely downward-facing surfaces. A spectator
  // sits over a pale concrete deck with 6 000 m² of sunlit pitch in front of
  // them, so it has to come off the key, not off uSkyCol — a stadium's fill is
  // typically an order of magnitude under its key, and a share of the sky term
  // left every downward face 25x darker than a lit one. A stand camera looks
  // *up* at the near rows, so that is a black band across the middle of every
  // face in the frame. Folding it into the hemisphere mix instead (so it also
  // lands at N.y = 0) washes the whole crowd flat, which is why this is a
  // separate max(-N.y, 0) lobe rather than a lift of the lower hemisphere.
  irr += uSunCol * (0.30 * clamp(uSunDir.y + 0.15, 0.0, 1.0) * sunVis
                    * max(-N.y, 0.0));
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
// stands read as texture, not as thousands of tiny lit figures. The curve is
// deliberately gentle in the first third — the stand across the pitch is only
// 60–90 m away and it should still be recognisably wearing team colours.
vec3 aerial(vec3 col, float dist) {
  float f = smoothstep(uHazeRange.x, uHazeRange.y, dist);
  f *= f * (3.0 - 2.0 * f);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(l), f * 0.34);
  return mix(col, uHaze, f * 0.62);
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
attribute vec4 iBody;       // x shoulder width, y girth, z posture id, w hair style

uniform float uTime;
uniform float uEnergy;
uniform float uNight;
uniform float uNearEnd;
uniform float uMidEnd;
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
  // ---- per-instance frustum reject ---------------------------------------
  // Every mesh here has frustumCulled off (one instance buffer spans the whole
  // bowl, so an object-level test can never help), and the LOD gate below only
  // culls by *range* — so a camera sitting in the stands still paid the full
  // skeleton for the 85 % of the bowl behind it. This is the same test done per
  // instance, from the seat position alone, before any of that work.
  //
  // A spectator occupies roughly -0.6 .. +1.5 m of their seat vertically (feet
  // to raised hands) and +/-0.9 m laterally. A world offset d maps to exactly
  // d * P[i][i] in clip x/y at every depth, so the padding is depth-independent.
  vec4 icp = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
  float px = 0.9 * projectionMatrix[0][0];
  float py = projectionMatrix[1][1];
  if (icp.w < 0.15
      || abs(icp.x) - px > icp.w
      || icp.y - 0.6 * py >  icp.w
      || icp.y + 1.5 * py < -icp.w) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float part = aPart;
  float prop = iFlags.z;
  float hat  = iFlags.w;
  float hairStyle = iBody.w;   // 0 short, 1 long, 2 shaved

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

  // ---- resting posture ---------------------------------------------------
  // Four sitting postures. Everyone upright with hands on their lap is the
  // other half of the clone problem; a stand has people folded forward with
  // their elbows on their knees, arms crossed, and slumped back.
  float post = iBody.z;
  float pUp   = step(post, 0.5);
  float pFwd  = step(0.5, post) * step(post, 1.5);
  float pFold = step(1.5, post) * step(post, 2.5);
  float pSlo  = step(2.5, post);
  float sitting = 1.0 - stand;

  float basePitch = (pFwd * 0.42 - pSlo * 0.15) * sitting;
  float baseArmA  = pUp * -0.04 + pFwd * 0.30 + pFold * -0.34 + pSlo * -0.02;
  // The +0.12 is a standing splay: an arm hanging dead vertical from a 0.172 m
  // shoulder sits inside the ribcage, and the fused arm/torso silhouette that
  // produces is what makes a spectator read as a moulded lump.
  float baseArmO  = 0.12 + pUp * 0.07 + pFwd * 0.11 + pFold * -0.13 + pSlo * 0.06;
  float baseElbow = pUp *  1.50 + pFwd * 1.02 + pFold *  2.10 + pSlo *  1.24;

  float sway  = sin(uTime * freq * 6.2831853 + ph);
  float sway2 = sin(uTime * freq * 4.1 + ph * 1.7 + 1.3);
  float lean  = sway * (0.028 + 0.055 * exc) + 0.045 + iRand.z * 0.07 + basePitch;
  float roll  = sway2 * (0.022 + 0.05 * exc);
  mat3 Rtorso = rotZ(roll) * rotX(lean);

  float headYaw   = (iRand.w - 0.5) * 0.85 + 0.10 * sin(uTime * 0.29 + ph);
  float headPitch = -0.10 + 0.08 * sin(uTime * 0.23 + ph * 2.1)
                  - 0.34 * cheer - basePitch * 0.72;
  mat3 Rhead = rotY(headYaw) * rotX(headPitch);

  // ---- arms --------------------------------------------------------------
  float style = step(0.52, iRand.w);                       // 1 = arms up, 0 = clap
  float clapOsc = sin(uTime * (9.0 + 4.0 * iRand.y) + ph);
  float upA    = -2.30 + 0.13 * sin(uTime * 5.0 + ph);
  float upO    =  0.20 + 0.10 * iRand.y;
  float upE    =  0.28 + 0.20 * iRand.x;
  float clapA  = -0.98 - 0.18 * clapOsc;
  float clapO  = -0.06 - 0.10 * clapOsc;
  float clapE  =  1.82 + 0.26 * clapOsc;
  float armA   = mix(baseArmA, mix(clapA, upA, style), cheer);
  float armO   = mix(baseArmO, mix(clapO, upO, style), cheer);
  float elbowA = mix(baseElbow, mix(clapE, upE, style), cheer);
  // Phone-holders keep a forearm up whether or not anything is happening.
  float phone = step(1.5, prop) * (1.0 - cheer);
  armA   -= 0.52 * phone;
  elbowA += 0.55 * phone;
  mat3 Rarm  = rotX(armA) * rotZ(aSide * armO);
  mat3 Rfore = rotX(elbowA);

  // ---- legs --------------------------------------------------------------
  float splay  = (0.05 + 0.34 * iRand.x) * sitting;
  float thighA = stand * 1.44 + pSlo * 0.26 * sitting;
  mat3 Rthigh = rotY(aSide * splay) * rotX(thighA);
  mat3 Rshin  = rotX(-thighA * 0.96 - pSlo * 0.30 * sitting);

  float bounce = max(0.0, sin(uTime * 6.4 + ph * 3.1)) * 0.055 * stand
               * clamp(exc * 1.6 - 0.7, 0.0, 1.0);
  float bob = sin(uTime * freq * 3.6 + ph * 1.3) * (0.004 + 0.012 * exc);
  vec3 hips = vec3(0.0, stand * 0.44 + bounce + bob, 0.0);

  // ---- skeleton ----------------------------------------------------------
  const vec3 T0 = vec3(0.0, 0.14, 0.0);
  const vec3 H0 = vec3(0.0, 0.555, 0.012);
  const vec3 E0 = vec3(0.0, -0.27, 0.0);
  const vec3 K0 = vec3(0.0, 0.0, 0.44);
  float bw = iBody.x;
  float bg = iBody.y;
  vec3 S0 = vec3(aSide * 0.172 * bw, 0.400, 0.0);
  vec3 P0 = vec3(aSide * 0.105 * bw, 0.055, 0.045);

  vec3 p = position;
  vec3 nrm = normal;
  vec3 lp;
  vec3 ln;
  float collapse = 0.0;

  if (part < 0.5) {                       // pelvis
    p.x *= bw; p.z *= bg;
    lp = hips + p; ln = normalize(nrm * vec3(1.0 / bw, 1.0, 1.0 / bg));
  } else if (part < 1.5) {                // torso (incl. deltoids and neck)
    p.x *= bw; p.z *= bg;
    nrm = normalize(nrm * vec3(1.0 / bw, 1.0, 1.0 / bg));
    lp = hips + T0 + Rtorso * p; ln = Rtorso * nrm;
  } else if (part < 3.5 || (part > 8.5 && part < 10.5)) {  // head, hair, brim, mane
    mat3 R = Rtorso * Rhead;
    lp = hips + T0 + Rtorso * H0 + R * p; ln = R * nrm;
    if (part > 8.5 && part < 9.5 && hat < 0.5) collapse = 1.0;               // brim
    if (part > 9.5 && (hat > 0.5 || abs(hairStyle - 1.0) > 0.5)) collapse = 1.0;  // mane
    if (part > 2.5 && part < 3.5 && hat < 0.5 && hairStyle > 1.5) collapse = 1.0; // shaved
  } else if (part < 4.5) {                // upper arm
    mat3 R = Rtorso * Rarm;
    lp = hips + T0 + Rtorso * S0 + R * p; ln = R * nrm;
  } else if (part > 10.5) {               // forearm + hand, hung off the elbow
    mat3 Ra = Rtorso * Rarm;
    mat3 R = Ra * Rfore;
    lp = hips + T0 + Rtorso * S0 + Ra * E0 + R * p; ln = R * nrm;
  } else if (part < 5.5) {                // thigh
    lp = hips + P0 + Rthigh * p; ln = Rthigh * nrm;
  } else if (part < 6.5) {                // shin
    mat3 R = Rthigh * Rshin;
    lp = hips + P0 + Rthigh * K0 + R * p; ln = R * nrm;
  } else {                                // held prop / phone, right hand
    mat3 R = Rtorso * Rarm * Rfore;
    lp = hips + T0 + Rtorso * S0 + Rtorso * Rarm * E0 + R * (vec3(0.0, -0.25, 0.0) + p);
    ln = R * nrm;
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
  // Each spectator picks its own switch distance inside a 26 % band, so the
  // handover is a stochastic cross-fade spread over several metres of depth
  // rather than a ring. The bands never overlap and never leave a gap: the
  // jitter only ever pulls a threshold *down*, and the coarser LOD's buffer
  // always contains everything the finer one holds.
  float dist = distance(cameraPosition, iPos);
  float j = 0.74 + 0.26 * iRand.z;
  float nearThr = uNearEnd * j;
  float midThr  = uMidEnd * j;
  #if defined(LOD_NEAR)
    if (dist > nearThr) collapse = 1.0;
  #elif defined(LOD_MID)
    if (dist <= nearThr || dist > midThr) collapse = 1.0;
  #else
    if (dist <= midThr) collapse = 1.0;
  #endif
  if (collapse > 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  // ---- colour ------------------------------------------------------------
  // Legwear: denim, khaki, black and grey, never as bright as a shirt.
  vec3 shorts = mix(vec3(0.030, 0.036, 0.052), vec3(0.155, 0.140, 0.115), iRand.y)
              * (0.62 + 0.70 * iRand.w);
  // 0.25 vest · 0.5 short sleeve · 1.0 long sleeve. The hand is tagged aT = 2
  // so nothing here can ever paint over it.
  float sleeve = iRand.z < 0.16 ? 0.25 : (iRand.z < 0.80 ? 0.5 : 1.0);
  // Legs run aT 0 (hip) → 1 (knee) → 1.9 (ankle): shorts, long shorts, or
  // full-length trousers, so the stand is not a sea of bare shins.
  float hem = iRand.w < 0.40 ? 0.52 : (iRand.w < 0.62 ? 0.98 : 1.92);
  vec3 shirt = iShirt;
  // A slice of the crowd in banded kit — flat colour tiles to the eye instantly.
  vAlt = vec4(mix(shirt, iRand.x > 0.5 ? vec3(0.86, 0.87, 0.88) : vec3(0.04, 0.045, 0.06),
                  0.78), 0.0);
  if (iRand.y > 0.62 && aT < 1.5) vAlt.w = iRand.x > 0.5 ? 3.0 : 5.0;

  // A collar, one shade off the body of the shirt — the neckline is the piece
  // of clothing detail closest to the face, so it is the one that pays.
  vec3 collar = shirt * 0.84;
  vec3 albedo;
  if (part < 0.5) albedo = shorts;
  else if (part < 1.5) albedo = aT > 1.5 ? iSkin : (aT > 0.90 ? collar : shirt);
  else if (part < 2.5) albedo = iSkin;
  // 3 = skull cap / cap crown, 10 = mane. 11 is the FOREARM and must fall
  // through to the sleeve test below, so the upper bound here is load-bearing.
  else if (part < 3.5 || (part > 9.5 && part < 10.5)) albedo = iHair;
  else if (part < 4.5) albedo = aT <= sleeve + 0.01 ? shirt : iSkin;
  else if (part > 10.5) albedo = aT <= sleeve + 0.01 ? shirt : iSkin;
  else if (part < 5.5) albedo = aT <= hem + 0.01 ? shorts : iSkin;
  else if (part < 6.5) albedo = aT > 2.5 ? vec3(0.045, 0.045, 0.055)
                              : (aT <= hem + 0.01 ? shorts : iSkin);
  else if (part < 7.5) albedo = mix(iShirt, vec3(1.0), 0.35);
  else if (part < 8.5) albedo = vec3(0.72, 0.82, 1.0);
  else albedo = iHair;                      // cap brim

  // Ambient occlusion: a packed crowd is dark everywhere except the tops of
  // heads and shoulders, and the back rows sit under the roof line. The lap and
  // the well between neighbours never see sky at all.
  float ao = mix(0.26, 1.0, smoothstep(-0.46, 0.80, localY));
  ao *= 0.90 + 0.16 * iRand.x;
  // Neighbour occlusion. Everyone in a row has a body 0.5 m to each side, so
  // the flanks never see sky — and a body-space X normal is exactly "how much
  // of this surface faces my neighbour". Free, and it is what gives the near
  // rows the dark seams between shoulders that a flat lit blob cannot fake.
  float flank = abs(ln.x);
  ao *= 1.0 - 0.26 * flank * flank;
  // Downward faces (the arm pits, the lap, the shelf of the brim) see the deck
  // rather than the sky — but they do catch its bounce, so this is a
  // lift-and-tilt, not a black-out. The head is exempt: nothing sits under a
  // chin, and darkening the jaw here on top of the drawn features turned the
  // face into mush at close range.
  float headish = step(1.5, part) * step(part, 3.5);
  ao *= mix(0.74 + 0.26 * smoothstep(-0.9, 0.3, ln.y), 1.0, headish);

  // Direct sun: the stand itself blocks the sun from behind, and the roof
  // cantilever shades the upper rows — most of a stadium is in its own shade.
  vec2 outward = -vec2(sy, cy);
  float back = dot(normalize(uSunDir.xz + vec2(1e-5)), outward);
  float open = smoothstep(0.30, -0.15, back);
  float deepAmt = mix(0.18, 0.66, smoothstep(0.22, 0.72, uSunDir.y));
  float deep = 1.0 - deepAmt * smoothstep(uUpperShade.x, uUpperShade.x + 0.45, iRowT);
  // A stand in its own shade is not black: the pitch in front of it is a
  // 6 000 m² reflector pointed straight at the lower rows.
  vSun = mix(0.18, 1.0, open) * deep;

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
  float dist = distance(cameraPosition, vW);

  float isHead = step(1.5, part) * step(part, 2.5);
  // Skull cap (3) and mane (10) only — 11 is the forearm and takes cloth/skin.
  float isHair = step(2.5, part) * step(part, 3.5)
               + step(9.5, part) * step(part, 10.5);

  // Weave / pore / strand break-up, faded out with range. Left at full strength
  // it aliases into per-pixel confetti the moment a spectator is a few pixels
  // tall, which is exactly what a TAA history amplifies.
  float dFade = 1.0 - smoothstep(9.0, 30.0, dist);
  vec3 dt = texture2D(uDetail, vUv * vec2(2.4, 3.0) + vX.w).rgb;
  float dv = mix(mix(dt.r, dt.g, isHead), dt.b, min(isHair, 1.0));
  dv = mix(0.5, dv, dFade);
  vec3 base = vCol;
  if (part > 0.5 && part < 1.5 && vAlt.w > 0.5) {
    base = mix(base, vAlt.rgb, step(0.5, fract(vUv.y * vAlt.w)));
  }
  vec3 albedo = base * (0.80 + 0.42 * dv);

  // Eyes and brow, placed in the head sphere's uv — enough of a face to read
  // as a person from the front row, invisible past ten metres.
  // A face, in the head sphere's uv. Sphere uv is NOT isotropic: u wraps the
  // full ~0.60 m circumference while v spans the ~0.35 m pole-to-pole arc, so
  // one uv unit is 1.7x longer in u than in v. Measuring the eye with the ratio
  // the wrong way round smears each eye into a 30 x 10 mm streak and the pair
  // merges into a censor bar across the face — which is exactly what the first
  // pass drew. Everything below is quoted in millimetres and converted once.
  if (isHead > 0.5) {
    // Metres of surface arc per uv unit. u wraps the 0.60 m circumference, v
    // spans the 0.35 m pole-to-pole arc, so every feature below can be written
    // in real millimetres and comes out the shape it is supposed to be.
    // Feature heights are derived, not guessed: the hair cap cuts the skull at
    // theta = 1.46 rad, so the visible face runs v = 0 (chin, bottom pole) to
    // v = 1 - 1.46/PI = 0.535 (hairline), and eyes sit ~48 % of the way down
    // that span. Putting them at v = 0.56 — where the first pass had them —
    // lands them *on* the hairline, which is why the face read as a band.
    const vec2 ARC = vec2(0.48, 0.34);
    vec2 d1 = (vUv - vec2(0.250 - 0.062, 0.400)) * ARC * vec2(1.0, 2.6);
    vec2 d2 = (vUv - vec2(0.250 + 0.062, 0.400)) * ARC * vec2(1.0, 2.6);
    float e = min(length(d1), length(d2));            // eyes 60 mm apart
    // Weights are deliberately low. These are 200 px tall at the front of the
    // 'crowd' shot and a strongly drawn eye at that size reads as a painted
    // mask, not a face — the job here is to break the blank oval, not to
    // caricature it.
    albedo *= 1.0 - 0.34 * smoothstep(0.010, 0.003, e) * dFade;   // 20 x 8 mm
    // Brow ridge shadow — a band above the eyes, fading off at the temples.
    float brow = abs((vUv.y - 0.442) * ARC.y)
               + max(abs((vUv.x - 0.25) * ARC.x) - 0.042, 0.0);
    albedo *= 1.0 - 0.11 * smoothstep(0.010, 0.003, brow) * dFade;
    // Mouth: a soft line, never a hole.
    float mo = length((vUv - vec2(0.25, 0.272)) * ARC * vec2(1.0, 3.2));
    albedo *= 1.0 - 0.12 * smoothstep(0.013, 0.004, mo) * dFade;
  }

  vec3 irr = irradiance(N, vW, vSun);
  vec3 col = albedo * RPI * irr * vX.y;

  // Skin scatters: a face or a bare forearm goes red through the terminator
  // before it goes dark. One extra lobe, and it is the difference between skin
  // and painted plastic on the two parts of a spectator that are actually skin.
  float ndl = dot(N, uSunDir);
  col += albedo * vec3(0.55, 0.17, 0.09) * uSunCol * RPI * vSun * vX.y
       * isHead * smoothstep(0.34, -0.30, ndl) * max(ndl + 0.42, 0.0);

  vec3 V = normalize(cameraPosition - vW);
  vec3 H = normalize(V + uSunDir);
  float sh = pow(max(dot(N, H), 0.0), mix(20.0, 58.0, isHead));
  col += uSunCol * sh * mix(0.020, 0.040, isHead) * max(ndl, 0.0) * vSun;

  // Sky-lit rim. On a body this small it is the cheapest volume cue there is —
  // it puts a bright edge on the shoulder and skull that a flat slab cannot fake.
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  col += uSkyCol * rim * 0.16 * vX.y;

  col += vec3(0.68, 0.80, 1.05) * vX.z * 2.6;

  col = aerial(col, dist);
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
