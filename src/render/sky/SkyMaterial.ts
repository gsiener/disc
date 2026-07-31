import * as THREE from 'three';
import { BETA_RN, COMPRESS, GLOW_DOME, GLOW_DOME_FALLOFF } from './Atmosphere';

/**
 * The sky dome shader: the scattering model from Atmosphere.ts, a raymarched
 * cumulus layer, a night hemisphere with a magnitude-distributed star field and
 * a shaded moon.
 *
 * `atmosphere()` here is a line-for-line mirror of `SkyState.radiance()`. That
 * is deliberate and it is load-bearing: the same numbers feed the PMREM env map
 * and the aerial-perspective fog on the CPU side, and any drift between the two
 * shows up as a seam where the far stands meet the sky.
 *
 * The cloud march is the expensive part, so it is compiled per quality tier
 * through `defines` rather than branched at runtime, and it early-outs on
 * transmittance. Cloud density comes from the baked volumes in CloudNoise.ts —
 * one texture fetch per band instead of dozens of hashes per sample.
 */

export interface SkyMaterialOpts {
  cloudSteps: number;
  cloudLightSteps: number;
  clouds: boolean;
}

const VERT = /* glsl */`
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_Position.z = gl_Position.w;
}
`;

const FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;

varying vec3 vWorldPos;

uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uBetaR;
uniform vec3 uBetaM;
uniform vec3 uSunT;
uniform vec3 uMsT;
uniform vec3 uMsTH;
uniform vec3 uHaze;
uniform vec3 uSunDisc;
uniform float uMs;
uniform float uSunE;
uniform float uMieG;
uniform float uExposure;
/*
 * Exposure basis for the night hemisphere. atmosphere() carries uExposure,
 * which the CPU side keeps inversely proportional to the camera's own exposure
 * so a time of day reads as that time of day whatever the meter is doing. The
 * night branch — twilight base, stars, moon — was the one part of the sky that
 * did not, so it tracked the meter one-for-one: raising the floodlights (which
 * closes the aperture) silently halved the night sky and took the stars with
 * it. Same basis, same behaviour.
 */
uniform float uNightGain;
uniform float uNight;
uniform float uSunElev;
uniform float uTime;
uniform vec3 uGround;
uniform vec3 uHorizon;

uniform vec3 uSunRadiance;
uniform vec3 uAmbTop;
uniform vec3 uAmbBot;
uniform float uCoverage;
uniform float uCloudDensity;
uniform float uCloudBottom;
uniform float uCloudTop;
uniform vec2 uWind;
uniform sampler3D uShape;
uniform sampler3D uDetail;
uniform sampler2D uWeather;

const float PI = 3.141592653589793;
const float THREE_OVER_16PI = 0.05968310365946075;
const float ONE_OVER_4PI = 0.07957747154594767;
const float RAYLEIGH_ZENITH = 8.4e3;
const float MIE_ZENITH = 1.25e3;
const vec3 LUM = vec3( 0.2126, 0.7152, 0.0722 );
const vec3 BETA_RN = vec3( BETA_RN_X, BETA_RN_Y, 1.0 );

float hgPhase( float c, float g ) {
  float g2 = g * g;
  return ONE_OVER_4PI * ( ( 1.0 - g2 ) / pow( max( 1.0 - 2.0 * g * c + g2, 1e-4 ), 1.5 ) );
}

float opticalInverse( float dy ) {
  float zen = acos( max( 0.0, dy ) );
  return 1.0 / ( cos( zen ) + 0.15 * pow( 93.885 - zen * 180.0 / PI, -1.253 ) );
}

/* ------------------------------------------------------------- atmosphere */

/** @param opa out: per-channel view-ray opacity, reused by the cloud fade. */
vec3 atmosphere( vec3 rd, out vec3 opa ) {
  float inv = opticalInverse( rd.y );
  opa = 1.0 - exp( - ( uBetaR * RAYLEIGH_ZENITH + uBetaM * MIE_ZENITH ) * inv );

  float cosT = dot( rd, uSunDir );
  float rP = THREE_OVER_16PI * ( 1.0 + pow( cosT * 0.5 + 0.5, 2.0 ) );
  float mP = hgPhase( cosT, uMieG );

  // Single scattering, reddened by the spectral transmittance to the sun.
  vec3 single = uSunT * ( uBetaR * rP + uBetaM * mP ) / ( uBetaR + uBetaM );
  // Multiple scattering: Rayleigh-coloured, walking a fraction of the sun path,
  // whitening toward the horizon where the bounce count is high.
  float w = pow( opa.g, 1.5 );
  vec3 multi = uMs * mix( uMsT, uMsTH, w ) * mix( BETA_RN, uHaze, w );

  vec3 L = max( uSunE * ( single + multi ) * opa, vec3( 0.0 ) );
  // Compress luminance, keep chroma — a per-channel pow would desaturate the
  // sunset it is meant to preserve.
  float y = max( dot( L, LUM ), 1e-6 );
  return L * ( pow( y, COMPRESS_P ) / y * uExposure );
}

/* ------------------------------------------------------------------ night */

float hash21( vec2 p ) {
  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
}

vec3 nightBase( vec3 rd ) {
  float h = clamp( rd.y, 0.0, 1.0 );
  vec3 c = mix( vec3( 0.0092, 0.0132, 0.0248 ), vec3( 0.0034, 0.0053, 0.0122 ), pow( h, 0.55 ) );
  vec2 sa = normalize( uSunDir.xz + 1e-5 );
  vec2 ra = normalize( rd.xz + 1e-5 );
  float tw = pow( max( dot( sa, ra ), 0.0 ), 2.2 ) * exp( - h * 5.5 )
    * smoothstep( -15.0, -1.0, uSunElev );
  c += vec3( 0.62, 0.24, 0.10 ) * tw;
  c += vec3( 0.0125, 0.0072, 0.0032 ) * exp( - h * 22.0 ) * 0.85;   // city glow
  // The venue's own glow dome. exp(-h*22) above is a 2.5-degree skyline band and
  // from inside the bowl the skyline is behind the stand, so it never reached a
  // frame; this is the part of the rig's output that goes up and scatters back.
  // Constants shared with Atmosphere.GLOW_DOME — see the note there.
  c += vec3( GLOW_DOME_R, GLOW_DOME_G, GLOW_DOME_B ) * exp( - h * GLOW_DOME_K );
  return c;
}

/**
 * Stars on a cube-face grid so density stays even. Brightness follows a steep
 * power law (few bright, many faint) which is what a real magnitude
 * distribution looks like, and colour varies on a B-V-ish blue/orange ramp.
 */
vec3 stars( vec3 rd ) {
  vec3 a = abs( rd );
  float m = max( a.x, max( a.y, a.z ) );
  vec2 uv; float face;
  if ( m == a.x )      { uv = rd.zy / a.x; face = rd.x > 0.0 ? 0.0 : 1.0; }
  else if ( m == a.y ) { uv = rd.xz / a.y; face = rd.y > 0.0 ? 2.0 : 3.0; }
  else                 { uv = rd.xy / a.z; face = rd.z > 0.0 ? 4.0 : 5.0; }

  // Faint galactic band: raises density and adds dust luminance.
  vec3 mwAxis = normalize( vec3( 0.42, 0.34, -0.84 ) );
  float band = exp( - pow( dot( rd, mwAxis ) * 2.3, 2.0 ) );

  vec3 col = vec3( 0.0 );
  col += vec3( 0.0060, 0.0068, 0.0110 ) * band * band;

  for ( int L = 0; L < 2; L ++ ) {
    float dens = L == 0 ? 130.0 : 62.0;
    vec2 g = uv * dens + vec2( face * 21.7 + float( L ) * 53.3 );
    vec2 cell = floor( g );
    vec2 f = g - cell;
    float h1 = hash21( cell + 0.31 );
    float h2 = hash21( cell + 7.13 );
    float h3 = hash21( cell + 19.7 );
    float h4 = hash21( cell + 3.77 );
    float present = step( h4, mix( 0.26, 0.62, band ) + ( L == 1 ? 0.12 : 0.0 ) );
    vec2 sp = vec2( h1, h2 ) * 0.5 + 0.25;
    float mag = pow( h3, 6.5 );
    float r = ( 0.055 + 0.075 * mag ) * ( L == 1 ? 1.35 : 1.0 );
    float d = length( f - sp );
    float core = exp( - ( d * d ) / ( r * r ) );
    float bright = ( 0.09 + 3.4 * mag ) * present * core;
    // Diffraction cross on the handful of really bright ones.
    if ( mag > 0.42 ) {
      vec2 e = abs( f - sp );
      float sx = exp( - e.x * e.x / ( r * r * 0.08 ) ) * exp( - e.y * 9.0 );
      float sy = exp( - e.y * e.y / ( r * r * 0.08 ) ) * exp( - e.x * 9.0 );
      bright += ( sx + sy ) * mag * 0.5 * present;
    }
    vec3 tint = mix( vec3( 0.68, 0.79, 1.0 ), vec3( 1.0, 0.80, 0.60 ), h1 * h1 );
    tint = mix( vec3( 1.0 ), tint, 0.75 );
    col += tint * bright;
  }
  // Stars extinct into the horizon haze exactly like everything else does.
  return col * 0.055 * smoothstep( -0.02, 0.16, rd.y );
}

vec3 moon( vec3 rd ) {
  float ang = dot( rd, uMoonDir );
  const float R = 0.0082;                       // slightly larger than life; reads better
  vec3 col = vec3( 0.0 );

  // Atmospheric halo around the disc.
  float halo = pow( max( ang, 0.0 ), 2600.0 ) * 0.42 + pow( max( ang, 0.0 ), 70.0 ) * 0.010;
  col += vec3( 0.60, 0.69, 0.94 ) * halo;

  vec3 mx = normalize( cross( uMoonDir, vec3( 0.0, 1.0, 0.02 ) ) );
  vec3 my = cross( mx, uMoonDir );
  vec2 q = vec2( dot( rd, mx ), dot( rd, my ) ) / R;
  float r2 = dot( q, q );
  if ( r2 < 1.25 ) {
    float disc = 1.0 - smoothstep( 0.982, 1.0, r2 );
    vec3 n = normalize( mx * q.x + my * q.y - uMoonDir * sqrt( max( 1.0 - min( r2, 1.0 ), 0.0 ) ) );
    // The moon is lit by the sun even when the sun is below our horizon, so the
    // terminator has to come from the real solar direction, not from a fake one.
    float lam = max( dot( n, uSunDir ), 0.0 );
    lam = pow( lam, 0.45 );                     // regolith is retro-reflective, not lambert
    float mare = texture( uDetail, n * 1.7 + 4.0 ).r;
    float fine = texture( uDetail, n * 6.3 + 1.0 ).g;
    float alb = mix( 0.52, 1.0, mare * 0.75 + fine * 0.25 );
    col += vec3( 1.0, 0.972, 0.925 ) * alb * lam * disc * 3.2;
  }
  return col * smoothstep( -0.03, 0.10, rd.y );
}

/* ----------------------------------------------------------------- clouds */

#ifdef USE_CLOUDS

const float PLANET_R = 900000.0;

float remap01( float v, float a, float b ) {
  return clamp( ( v - a ) / max( b - a, 1e-4 ), 0.0, 1.0 );
}

/** Distance to the far intersection with a shell of radius R, camera inside. */
float shellDist( vec3 ro, vec3 rd, float R ) {
  float b = dot( ro, rd );
  float c = dot( ro, ro ) - R * R;
  float d = b * b - c;
  if ( d < 0.0 ) return -1.0;
  float sq = sqrt( d );
  return - b + sq;
}

float heightGradient( float h, float type ) {
  vec4 st = vec4( 0.0, 0.06, 0.20, 0.34 );
  vec4 cu = vec4( 0.0, 0.14, 0.54, 0.88 );
  vec4 g = mix( st, cu, clamp( type * 1.7, 0.0, 1.0 ) );
  return smoothstep( g.x, g.y, h ) * smoothstep( g.w, g.z, h );
}

/**
 * @param ero  weight on the high-frequency erosion band, 0..1. This is a hand
 *             rolled mip level, and it has to exist: the erosion was sampled at
 *             8.5 tiles, which over a 13 km tile and a 64³ volume is a 24-metre
 *             feature — under a tenth of the march's own step. Undersampling a
 *             24 m field with an 80 m step and then jittering the start by a
 *             full step does not produce cloud detail, it produces a rolling
 *             dot screen, and that screen was drawn over every cloud in every
 *             frame. The band is now three metres coarser than the step it is
 *             sampled with, and it fades out entirely as the step grows toward
 *             the horizon.
 */
float cloudDensity( vec3 p, float ero ) {
  float h = ( p.y - uCloudBottom ) / ( uCloudTop - uCloudBottom );
  if ( h < 0.0 || h > 1.0 ) return 0.0;

  vec3 wind = vec3( uWind.x, 0.0, uWind.y ) * uTime;
  vec3 wth = texture( uWeather, ( p.xz + wind.xz * 0.25 ) * 4.4e-5 ).rgb;
  // Weather red is centred on 0.5 with roughly ±0.25 of swing; spread it hard so
  // the sky has genuine banks and genuine holes.
  //
  // The gain here matters more than it looks. Cumulus at these scales are
  // optically thick — 0.055/m over a kilometre is an optical depth of thirty —
  // so a cell either blocks the sky completely or is not there. Coverage is
  // therefore the *only* control over how much blue survives, and at the
  // previous bias the field never dropped below threshold anywhere: the result
  // was a seamless overcast deck that read as a flat grey sky with no clouds in
  // it at all, which is exactly what the frames were showing.
  float cov = clamp( ( wth.r - 0.5 ) * 2.6 + uCoverage, 0.0, 1.0 );
  if ( cov <= 0.03 ) return 0.0;

  // Vertical shear: tops lag the bases, which is most of why real cumulus lean.
  vec3 sp = p + wind + vec3( uWind.x, 0.0, uWind.y ) * h * 260.0;
  vec3 uvw = sp * ( 1.0 / 13000.0 );

  // Two-stage domain warp. One octave of warp gives wobbly noise; feeding the
  // warp through a second, coarser field is what turns it into structure that
  // does not read as a scrolling texture. Amplitudes are in tile units and one
  // tile is 13 km, so 0.18 is already a two-kilometre displacement — push it
  // much further and cumulus smear into streaks.
  vec3 w1 = texture( uDetail, uvw * 0.83 + 0.17 ).rgb - 0.5;
  vec3 w2 = texture( uDetail, uvw * 3.1 + w1 * 0.35 ).rgb - 0.5;
  uvw += w1 * 0.18 + w2 * 0.13;

  vec4 s = texture( uShape, uvw );
  float band = dot( s.gba, vec3( 0.625, 0.25, 0.125 ) );
  float base = remap01( s.r, band * 0.85 - 0.85, 1.0 );
  base *= heightGradient( h, wth.g );
  base = remap01( base, 1.0 - cov * 0.94, 1.0 );
  if ( base <= 0.0 ) return 0.0;

  if ( ero > 0.01 ) {
    vec3 d = texture( uDetail, uvw * 1.8 - wind * 4.0e-5 ).rgb;
    float df = dot( d, vec3( 0.625, 0.25, 0.125 ) );
    df = mix( df, 1.0 - df, clamp( h * 4.0, 0.0, 1.0 ) );
    base = remap01( base, df * 0.34 * ero, 1.0 );
  }
  return base * uCloudDensity * mix( 0.75, 1.15, wth.b );
}

const vec3 CONE[ 6 ] = vec3[ 6 ](
  vec3(  0.38, 0.24, -0.31 ), vec3( -0.42, 0.11,  0.29 ),
  vec3(  0.14, -0.36, 0.44 ), vec3( -0.27, 0.45,  0.10 ),
  vec3(  0.46, 0.05,  0.35 ), vec3( -0.11, -0.28, -0.47 )
);

float lightMarch( vec3 p, vec3 L ) {
  float tau = 0.0;
  float st = 110.0;
  vec3 q = p;
  for ( int i = 0; i < CLOUD_LIGHT_STEPS; i ++ ) {
    q += L * st + CONE[ i ] * st * 0.45;
    tau += cloudDensity( q, 0.0 ) * st;
    st *= 1.75;
  }
  return tau;
}

vec4 marchClouds( vec3 ro, vec3 rd, vec3 L, vec3 skyCol, float dither ) {
  // Clouds have to reach the geometric horizon: in a stadium bowl the only sky
  // most cameras see is the band just above the stands, and cutting the march
  // off at 0.7° of elevation deletes the cloud layer from every wide shot.
  if ( rd.y < -0.004 ) return vec4( 0.0 );

  vec3 sp = ro + vec3( 0.0, PLANET_R, 0.0 );
  float t0 = shellDist( sp, rd, PLANET_R + uCloudBottom );
  float t1 = shellDist( sp, rd, PLANET_R + uCloudTop );
  if ( t1 <= 0.0 ) return vec4( 0.0 );
  t0 = max( t0, 0.0 );
  // 34 km, not 62. Past about thirty kilometres the aerial fade below has taken
  // three quarters of the cloud's contrast anyway, and the only thing the extra
  // span bought was a step size of nearly two kilometres along the horizon —
  // which is where the march's dither turns into visible halftone. Halving the
  // span halves the step at exactly the elevations a stadium camera looks at.
  float span = min( t1 - t0, 34000.0 );
  if ( span <= 0.0 ) return vec4( 0.0 );

  // Geometric step ladder, not a uniform one.
  //
  // The span runs from four kilometres looking up to thirty-four along the
  // horizon, and a uniform step across that is the source of the venetian-blind
  // banding lying over every low deck in the round-2 frames. Near the horizon
  // t0 moves about 850 m per degree of elevation while the step is ~300 m, so
  // the sample lattice slides two and a half whole steps every twenty pixels
  // and beats against the density field; the march's dither is a screen-space
  // pattern with its own period and it beats right back.
  //
  // Growing the step spends the samples where transmittance is still high —
  // which is the only stretch of the ray that can contribute much — and lets
  // the tail coarsen out where the aerial fade has taken the contrast anyway.
  // Sum of a geometric series: dt0 · (gᴺ − 1)/(g − 1) = span.
  const float GROW = 1.055;
  float gN = pow( GROW, float( CLOUD_STEPS ) );
  float dt = span * ( GROW - 1.0 ) / ( gN - 1.0 );
  float t = t0 + dt * dither;

  float cosT = dot( rd, L );
  const float SIGMA = 0.055;
  const float SIGMA_L = 0.062;

  vec3 scatter = vec3( 0.0 );
  float tr = 1.0;
  float meanT = 0.0;
  float wsum = 0.0;

  for ( int i = 0; i < CLOUD_STEPS; i ++ ) {
    if ( tr < 0.015 ) break;
    vec3 p = ro + rd * t;
    // Erosion weight from the *local* step, and off past 12 km. It used to be a
    // binary flag that also flipped after two empty samples, which made the
    // density field a function of the ray's own history: two neighbouring
    // pixels, jittered half a step apart, could disagree about whether erosion
    // applied at the same point in space, and that drew a regular dot screen
    // over every cloud edge in the frame. It saved nothing either —
    // cloudDensity returns before the erosion fetch whenever the base shape is
    // empty, which is exactly the case the heuristic was trying to catch.
    float ero = t > 12000.0 ? 0.0 : clamp( 300.0 / dt, 0.0, 1.0 );
    float d = cloudDensity( p, ero );
    if ( d <= 0.0005 ) {
      t += dt;
      dt *= GROW;
      continue;
    }

    float h = clamp( ( p.y - uCloudBottom ) / ( uCloudTop - uCloudBottom ), 0.0, 1.0 );
    float tau = lightMarch( p, L );

    // Three-octave multiple-scattering approximation: successive octaves lose
    // energy, absorb less and flatten their phase, which is what gives thick
    // clouds bright, soft interiors instead of a hard dark core. The forward
    // lobe of the first octave is the silver lining.
    vec3 sun = vec3( 0.0 );
    float a = 1.0, b = 1.0, c = 1.0;
    for ( int o = 0; o < 3; o ++ ) {
      float ph = mix( hgPhase( cosT, 0.82 * c ), hgPhase( cosT, -0.34 * c ), 0.28 );
      sun += vec3( a * exp( - tau * SIGMA_L * b ) * ( ph + 0.055 ) );
      a *= 0.52; b *= 0.42; c *= 0.68;
    }
    float powder = 1.0 - exp( - d * 9.0 );
    sun *= mix( 1.0, powder, 0.62 );

    vec3 amb = mix( uAmbBot, uAmbTop, h * h * 0.85 + 0.15 );
    vec3 lum = uSunRadiance * sun + amb;

    float ext = d * SIGMA;
    float stepTr = exp( - ext * dt );
    scatter += tr * lum * ( 1.0 - stepTr );
    meanT += t * tr; wsum += tr;
    tr *= stepTr;
    t += dt;
    dt *= GROW;
    if ( t > t0 + span ) break;
  }

  float alpha = 1.0 - tr;
  if ( alpha <= 0.001 ) return vec4( 0.0 );
  scatter /= max( alpha, 1e-3 );

  // Aerial perspective on the cloud layer itself: far banks wash into the sky.
  // The near-horizon deck is 30–50 km out, so this is also what stops a 2 km
  // march step showing up as banding — by then it is nearly all sky.
  //
  // The low-angle ramp is doing real work, not just hiding artefacts. The band
  // of sky a stadium camera can actually see is the first few degrees above the
  // stands, and that is precisely where the cloud layer is furthest away and
  // most washed out. Letting a grey 30 km deck sit at full opacity across it
  // desaturates the one strip of sky in the frame — a dusk that should be amber
  // comes out neutral. Fade it out and the horizon keeps its own colour.
  //
  // The numbers below were, however, deleting the cloud layer from every frame
  // this game actually ships. A stadium camera sees sky between about 0.2° and
  // 3° above the stands; a 1 500 m cloud base seen at 2° is 43 km away, so the
  // old 7e-5 fall-off left 0.7 % of the cloud's own contrast and the old
  // smoothstep( -0.002, 0.055 ) alpha ramp then halved what survived. The sky
  // in stadium, broadcast, endzone and crowd was therefore a bare
  // scattering gradient with no weather in it at all — which is exactly the
  // "flat card" the frames were showing.
  //
  // 3.6e-5 is ~28 km of e-folding — contrast transmission, which is much
  // shorter than meteorological visibility — and the 0.15 floor is the
  // honest observation that a cumulus deck on the horizon is washed out but
  // never actually gone. The alpha ramp now finishes by 1°, because that is
  // where the stands stop and the sky starts.
  float md = wsum > 0.0 ? meanT / wsum : t0;
  float fade = exp( - md * 3.6e-5 );
  scatter = mix( skyCol, scatter, clamp( fade * 0.85 + 0.15, 0.0, 1.0 ) );
  alpha *= mix( 0.55, 1.0, fade ) * smoothstep( -0.004, 0.018, rd.y );
  return vec4( scatter * alpha, alpha );
}
#endif

/* ------------------------------------------------------------------- main */

void main() {
  vec3 rd = normalize( vWorldPos - cameraPosition );

  vec3 opa;
  vec3 sky = atmosphere( rd, opa );

  if ( uNight > 0.001 ) {
    sky = mix( sky, nightBase( rd ) * uNightGain, uNight );
    sky += ( stars( rd ) + moon( rd ) ) * uNight * uNightGain;
  }

  // Solar disc. Real angular radius is 0.267°; this runs a shade over life size
  // so it survives 1080p, and carries a proper quadratic limb-darkening law
  // (u=0.60, v=0.18 at 550 nm) instead of a flat plate.
  float sunCos = dot( rd, uSunDir );
  float sunAng = acos( clamp( sunCos, -1.0, 1.0 ) );
  const float SUN_R = 0.0062;
  float rN = min( sunAng / SUN_R, 1.0 );
  float mu = sqrt( max( 0.0, 1.0 - rN * rN ) );
  float limb = 1.0 - 0.60 * ( 1.0 - mu ) - 0.18 * ( 1.0 - mu * mu );
  float disc = ( 1.0 - smoothstep( SUN_R * 0.94, SUN_R * 1.04, sunAng ) ) * max( limb, 0.0 );
  // The disc is extincted by the *view* ray as well, so it sinks into the haze
  // as it sets rather than staying a hot dot on a dark band.
  vec3 discT = 1.0 - opa * 0.92;
  sky += uSunDisc * disc * discT;
  // Aureole: a tight forward-scattering lobe plus a wide one. Both ride the same
  // transmittance, so the glow reddens with the disc.
  sky += uSunDisc * discT * (
      0.0060 * pow( max( sunCos, 0.0 ), 900.0 )
    + 0.0016 * pow( max( sunCos, 0.0 ), 90.0 ) );

  // Ground half.
  //
  // This is not "the world's own geometry covers it": in the establishing wide
  // the modelled terrain runs out about 5° below the eye while the geometric
  // horizon is at 0°, so the dome is what fills a 130-pixel band right across
  // the frame. The previous version snapped to a fixed ground colour over one
  // degree, which drew exactly that: a hard-edged flat olive card sitting on
  // top of a pale sky, and it read as murk rather than as distance.
  //
  // atmosphere() clamps its optical depth at rd.y = 0, so the scattering term
  // is already continuous across the horizon — the fix is simply to *keep* it
  // and let the ground albedo take over gradually with depression angle, which
  // is what recession into haze actually looks like. No seam is possible now
  // because the near side of the blend is the sky's own horizon value.
  float dip = clamp( - rd.y, 0.0, 1.0 );
  sky = mix( sky, uGround, 0.86 * smoothstep( 0.0, 0.16, dip ) );

#ifdef USE_CLOUDS
  // Interleaved-gradient noise, not a white-noise hash. The march is jittered by
  // a full step to trade banding for grain, and near the horizon a step is over
  // a kilometre — white noise turns every cloud silhouette into salt-and-pepper,
  // whereas IGN spreads the same error over a fine, even, filter-friendly weave.
  float dither = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  vec3 L = uNight > 0.5 ? uMoonDir : uSunDir;
  vec4 cl = marchClouds( cameraPosition, rd, L, sky, dither );
  sky = sky * ( 1.0 - cl.a ) + cl.rgb;
#endif

  gl_FragColor = vec4( max( sky, vec3( 0.0 ) ), 1.0 );

#ifdef SKY_DEBUG
#ifdef USE_CLOUDS
  if ( SKY_DEBUG >= 4 ) {
    vec3 ro4 = cameraPosition + vec3( 0.0, PLANET_R, 0.0 );
    float ta = shellDist( ro4, rd, PLANET_R + mix( uCloudBottom, uCloudTop, 0.42 ) );
    vec3 p4 = cameraPosition + rd * ta;
    vec3 wth4 = texture( uWeather, ( p4.xz ) * 4.4e-5 ).rgb;
    vec4 s4 = texture( uShape, p4 * ( 1.0 / 13000.0 ) );
    if ( SKY_DEBUG == 4 ) gl_FragColor = vec4( vec3( cloudDensity( p4, 1.0 ) ), 1.0 );
    if ( SKY_DEBUG == 5 ) gl_FragColor = vec4( wth4, 1.0 );
    if ( SKY_DEBUG == 6 ) gl_FragColor = vec4( s4.rgb, 1.0 );
    if ( SKY_DEBUG == 7 ) gl_FragColor = vec4( vec3( ta / 30000.0 ), 1.0 );
    if ( rd.y < -0.004 ) gl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 );
    return;
  }
#endif
  if ( SKY_DEBUG == 1 ) gl_FragColor = vec4( rd * 0.5 + 0.5, 1.0 );
  if ( SKY_DEBUG == 2 ) gl_FragColor = vec4( vec3( max( dot( rd, uSunDir ), 0.0 ) ), 1.0 );
  if ( SKY_DEBUG == 3 ) gl_FragColor = vec4( abs( vWorldPos - cameraPosition ) / 40.0, 1.0 );
  return;
#endif

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** GLSL float literal with enough digits to match the CPU model bit-for-eye. */
const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

export function createSkyMaterial(opts: SkyMaterialOpts): THREE.ShaderMaterial {
  const defines: Record<string, string | number> = {
    CLOUD_STEPS: opts.cloudSteps,
    CLOUD_LIGHT_STEPS: Math.min(6, opts.cloudLightSteps),
    // Shared with Atmosphere.ts so the dome, the env map and the fog agree.
    BETA_RN_X: f(BETA_RN[0]),
    BETA_RN_Y: f(BETA_RN[1]),
    COMPRESS_P: f(COMPRESS),
    GLOW_DOME_R: f(GLOW_DOME[0]),
    GLOW_DOME_G: f(GLOW_DOME[1]),
    GLOW_DOME_B: f(GLOW_DOME[2]),
    GLOW_DOME_K: f(GLOW_DOME_FALLOFF),
  };
  if (opts.clouds) defines.USE_CLOUDS = '';
  const dbg = Number(new URLSearchParams(location.search).get('skyDebug') || 0);
  if (dbg) defines.SKY_DEBUG = dbg;

  return new THREE.ShaderMaterial({
    name: 'SkyDome',
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uBetaR: { value: new THREE.Vector3() },
      uBetaM: { value: new THREE.Vector3() },
      uSunT: { value: new THREE.Vector3(1, 1, 1) },
      uMsT: { value: new THREE.Vector3(1, 1, 1) },
      uMsTH: { value: new THREE.Vector3(1, 1, 1) },
      uHaze: { value: new THREE.Vector3(0.86, 0.94, 1.0) },
      uSunDisc: { value: new THREE.Vector3(1, 1, 1) },
      uMs: { value: 0.085 },
      uSunE: { value: 1000 },
      uMieG: { value: 0.8 },
      uExposure: { value: 0.05 },
      uNightGain: { value: 1 },
      uNight: { value: 0 },
      uSunElev: { value: 45 },
      uTime: { value: 0 },
      uGround: { value: new THREE.Color(0x1a2410) },
      uHorizon: { value: new THREE.Color(0x9fc0e8) },
      uSunRadiance: { value: new THREE.Color(1, 1, 1) },
      uAmbTop: { value: new THREE.Color(0.2, 0.28, 0.4) },
      uAmbBot: { value: new THREE.Color(0.05, 0.06, 0.08) },
      uCoverage: { value: 0.45 },
      uCloudDensity: { value: 1 },
      uCloudBottom: { value: 1500 },
      uCloudTop: { value: 4300 },
      uWind: { value: new THREE.Vector2(4.6, 3.1) },
      uShape: { value: null },
      uDetail: { value: null },
      uWeather: { value: null },
    },
    side: THREE.BackSide,
    depthWrite: false,
    // Test, do not write. Combined with renderOrder 1000 this turns the dome
    // into a deferred background fill: the cloud march runs only where the
    // depth buffer is still at the far plane.
    depthTest: true,
    fog: false,
    toneMapped: true,
  });
}
