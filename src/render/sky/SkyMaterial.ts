import * as THREE from 'three';

/**
 * The sky dome shader: Preetham single-scattering, a raymarched cumulus layer,
 * a night hemisphere with a magnitude-distributed star field and a shaded moon.
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
uniform float uSunE;
uniform float uMieG;
uniform float uExposure;
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

float hgPhase( float c, float g ) {
  float g2 = g * g;
  return ONE_OVER_4PI * ( ( 1.0 - g2 ) / pow( max( 1.0 - 2.0 * g * c + g2, 1e-4 ), 1.5 ) );
}

float opticalInverse( float dy ) {
  float zen = acos( max( 0.0, dy ) );
  return 1.0 / ( cos( zen ) + 0.15 * pow( 93.885 - zen * 180.0 / PI, -1.253 ) );
}

/* ------------------------------------------------------------- atmosphere */

vec3 atmosphere( vec3 rd, out vec3 Fex ) {
  float inv = opticalInverse( rd.y );
  Fex = exp( - ( uBetaR * RAYLEIGH_ZENITH * inv + uBetaM * MIE_ZENITH * inv ) );

  float cosT = dot( rd, uSunDir );
  float rP = THREE_OVER_16PI * ( 1.0 + pow( cosT * 0.5 + 0.5, 2.0 ) );
  float mP = hgPhase( cosT, uMieG );

  vec3 num = uBetaR * rP + uBetaM * mP;
  vec3 den = uBetaR + uBetaM;
  vec3 base = uSunE * ( num / den );

  vec3 lin = pow( max( base * ( 1.0 - Fex ), vec3( 0.0 ) ), vec3( 1.5 ) );
  vec3 alt = pow( max( base * Fex, vec3( 0.0 ) ), vec3( 0.5 ) );
  float sunsetMix = clamp( pow( 1.0 - uSunDir.y, 5.0 ), 0.0, 1.0 );
  lin *= mix( vec3( 1.0 ), alt, sunsetMix );

  return ( lin + 0.06 * Fex ) * uExposure;
}

/* ------------------------------------------------------------------ night */

float hash21( vec2 p ) {
  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
}

vec3 nightBase( vec3 rd ) {
  float h = clamp( rd.y, 0.0, 1.0 );
  vec3 c = mix( vec3( 0.0135, 0.0190, 0.0330 ), vec3( 0.0042, 0.0068, 0.0155 ), pow( h, 0.55 ) );
  vec2 sa = normalize( uSunDir.xz + 1e-5 );
  vec2 ra = normalize( rd.xz + 1e-5 );
  float tw = pow( max( dot( sa, ra ), 0.0 ), 3.0 ) * exp( - h * 7.0 )
    * smoothstep( -16.0, -3.0, uSunElev );
  c += vec3( 0.10, 0.045, 0.020 ) * tw;
  c += vec3( 0.028, 0.017, 0.008 ) * exp( - h * 13.0 ) * 0.9;   // city glow
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
  col += vec3( 0.0075, 0.0082, 0.0125 ) * band * band;

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
  return col * 0.045;
}

vec3 moon( vec3 rd ) {
  float ang = dot( rd, uMoonDir );
  const float R = 0.0088;                       // slightly larger than life; reads better
  vec3 col = vec3( 0.0 );

  // Atmospheric halo around the disc.
  float halo = pow( max( ang, 0.0 ), 2200.0 ) * 0.55 + pow( max( ang, 0.0 ), 90.0 ) * 0.012;
  col += vec3( 0.62, 0.70, 0.92 ) * halo;

  vec3 mx = normalize( cross( uMoonDir, vec3( 0.0, 1.0, 0.02 ) ) );
  vec3 my = cross( mx, uMoonDir );
  vec2 q = vec2( dot( rd, mx ), dot( rd, my ) ) / R;
  float r2 = dot( q, q );
  if ( r2 < 1.25 ) {
    float disc = 1.0 - smoothstep( 0.985, 1.0, r2 );
    vec3 n = normalize( mx * q.x + my * q.y - uMoonDir * sqrt( max( 1.0 - min( r2, 1.0 ), 0.0 ) ) );
    float lam = max( dot( n, uSunDir ), 0.0 );
    lam = pow( lam, 0.45 );                     // regolith is retro-reflective, not lambert
    float mare = texture( uDetail, n * 1.7 + 4.0 ).r;
    float fine = texture( uDetail, n * 6.3 + 1.0 ).g;
    float alb = mix( 0.55, 1.0, mare * 0.75 + fine * 0.25 );
    col += vec3( 1.0, 0.975, 0.93 ) * alb * lam * disc * 2.6;
  }
  return col;
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

float cloudDensity( vec3 p, float lod ) {
  float h = ( p.y - uCloudBottom ) / ( uCloudTop - uCloudBottom );
  if ( h < 0.0 || h > 1.0 ) return 0.0;

  vec3 wind = vec3( uWind.x, 0.0, uWind.y ) * uTime;
  vec3 wth = texture( uWeather, ( p.xz + wind.xz * 0.25 ) * 4.4e-5 ).rgb;
  // Weather red is centred on 0.5; spread it hard so the sky has genuine banks
  // and genuine holes rather than an even wash.
  float cov = clamp( ( wth.r - 0.5 ) * 1.55 + uCoverage * 1.28, 0.0, 1.0 );
  if ( cov <= 0.02 ) return 0.0;

  // Vertical shear: tops lag the bases, which is most of why real cumulus lean.
  vec3 sp = p + wind + vec3( uWind.x, 0.0, uWind.y ) * h * 260.0;
  vec3 uvw = sp * ( 1.0 / 13000.0 );

  vec3 warp = texture( uDetail, uvw * 3.1 ).rgb - 0.5;
  uvw += warp * 0.26;

  vec4 s = texture( uShape, uvw );
  float band = dot( s.gba, vec3( 0.625, 0.25, 0.125 ) );
  float base = remap01( s.r, band * 0.85 - 0.85, 1.0 );
  base *= heightGradient( h, wth.g );
  base = remap01( base, 1.0 - cov, 1.0 );
  if ( base <= 0.0 ) return 0.0;

  if ( lod < 0.5 ) {
    vec3 d = texture( uDetail, uvw * 8.5 - wind * 4.0e-5 ).rgb;
    float df = dot( d, vec3( 0.625, 0.25, 0.125 ) );
    df = mix( df, 1.0 - df, clamp( h * 4.0, 0.0, 1.0 ) );
    base = remap01( base, df * 0.34, 1.0 );
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
    tau += cloudDensity( q, 1.0 ) * st;
    st *= 1.75;
  }
  return tau;
}

vec4 marchClouds( vec3 ro, vec3 rd, vec3 L, vec3 skyCol, float dither ) {
  if ( rd.y < 0.012 ) return vec4( 0.0 );

  vec3 sp = ro + vec3( 0.0, PLANET_R, 0.0 );
  float t0 = shellDist( sp, rd, PLANET_R + uCloudBottom );
  float t1 = shellDist( sp, rd, PLANET_R + uCloudTop );
  if ( t1 <= 0.0 ) return vec4( 0.0 );
  t0 = max( t0, 0.0 );
  float span = min( t1 - t0, 46000.0 );
  if ( span <= 0.0 ) return vec4( 0.0 );

  float dt = span / float( CLOUD_STEPS );
  float t = t0 + dt * dither;

  float cosT = dot( rd, L );
  const float SIGMA = 0.055;
  const float SIGMA_L = 0.062;

  vec3 scatter = vec3( 0.0 );
  float tr = 1.0;
  float meanT = 0.0;
  float wsum = 0.0;
  int empty = 0;

  for ( int i = 0; i < CLOUD_STEPS; i ++ ) {
    if ( tr < 0.015 ) break;
    vec3 p = ro + rd * t;
    // Cheap probe first: skip the erosion fetch in empty space, and stride out
    // once we are confidently outside any cloud.
    float d = cloudDensity( p, empty > 1 ? 1.0 : 0.0 );
    if ( d <= 0.0005 ) {
      empty ++;
      t += dt * ( empty > 2 ? 1.85 : 1.0 );
      continue;
    }
    empty = 0;

    float h = clamp( ( p.y - uCloudBottom ) / ( uCloudTop - uCloudBottom ), 0.0, 1.0 );
    float tau = lightMarch( p, L );

    // Three-octave multiple-scattering approximation: successive octaves lose
    // energy, absorb less and flatten their phase, which is what gives thick
    // clouds bright, soft interiors instead of a hard dark core.
    vec3 sun = vec3( 0.0 );
    float a = 1.0, b = 1.0, c = 1.0;
    for ( int o = 0; o < 3; o ++ ) {
      float ph = mix( hgPhase( cosT, 0.80 * c ), hgPhase( cosT, -0.32 * c ), 0.28 );
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
    if ( t > t0 + span ) break;
  }

  float alpha = 1.0 - tr;
  if ( alpha <= 0.001 ) return vec4( 0.0 );
  scatter /= max( alpha, 1e-3 );

  // Aerial perspective on the cloud layer itself: far banks wash into the sky.
  float md = wsum > 0.0 ? meanT / wsum : t0;
  float fade = exp( - md * 2.1e-5 );
  scatter = mix( skyCol, scatter, clamp( fade + 0.12, 0.0, 1.0 ) );
  alpha *= mix( 0.55, 1.0, fade ) * smoothstep( 0.012, 0.07, rd.y );
  return vec4( scatter * alpha, alpha );
}
#endif

/* ------------------------------------------------------------------- main */

void main() {
  vec3 rd = normalize( vWorldPos - cameraPosition );

  vec3 Fex;
  vec3 sky = atmosphere( rd, Fex );

  if ( uNight > 0.001 ) {
    sky = mix( sky, nightBase( rd ), uNight );
    sky += ( stars( rd ) + moon( rd ) ) * uNight;
  }

  // Solar disc with limb darkening. Kept very bright so bloom has something to
  // find, but soft-edged so it does not alias into a polygon.
  float sunCos = dot( rd, uSunDir );
  float sunAng = acos( clamp( sunCos, -1.0, 1.0 ) );
  const float SUN_R = 0.0075;
  float disc = 1.0 - smoothstep( SUN_R * 0.90, SUN_R * 1.06, sunAng );
  float limb = sqrt( max( 0.0, 1.0 - pow( min( sunAng / SUN_R, 1.0 ), 2.0 ) ) );
  disc *= mix( 0.55, 1.0, pow( limb, 0.42 ) );
  sky += Fex * uSunE * uExposure * 260.0 * disc * ( 1.0 - uNight );
  sky += Fex * uSunE * uExposure * 0.55 * pow( max( sunCos, 0.0 ), 340.0 ) * ( 1.0 - uNight );

  // Ground half: the world's own geometry covers this in-frame, but the dome
  // has to agree with it at the horizon or distant objects sit on a seam.
  float below = smoothstep( 0.004, -0.014, rd.y );
  sky = mix( sky, mix( uHorizon * 0.85, uGround, 0.72 ), below );

#ifdef USE_CLOUDS
  float dither = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
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
    if ( SKY_DEBUG == 4 ) gl_FragColor = vec4( vec3( cloudDensity( p4, 0.0 ) ), 1.0 );
    if ( SKY_DEBUG == 5 ) gl_FragColor = vec4( wth4, 1.0 );
    if ( SKY_DEBUG == 6 ) gl_FragColor = vec4( s4.rgb, 1.0 );
    if ( SKY_DEBUG == 7 ) gl_FragColor = vec4( vec3( ta / 30000.0 ), 1.0 );
    if ( rd.y < 0.012 ) gl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 );
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

export function createSkyMaterial(opts: SkyMaterialOpts): THREE.ShaderMaterial {
  const defines: Record<string, string | number> = {
    CLOUD_STEPS: opts.cloudSteps,
    CLOUD_LIGHT_STEPS: Math.min(6, opts.cloudLightSteps),
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
      uSunE: { value: 1000 },
      uMieG: { value: 0.8 },
      uExposure: { value: 0.03 },
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
    depthTest: false,
    fog: false,
    toneMapped: true,
  });
}
