import * as THREE from 'three';

/**
 * Aerial perspective — exponential *height* fog whose colour is sampled from
 * the sky in the view direction, so the far side of the stadium desaturates
 * into the actual horizon rather than into a flat grey.
 *
 * Three's stock fog is a single colour, which is precisely the "prototype"
 * look the brief bans. Rather than fork every material, we replace the four
 * `fog_*` shader chunks once at boot. Two details make that safe and cheap:
 *
 *  1. The four chunks are always included together, so the varying we add is
 *     always declared where it is used — no material can half-adopt this.
 *  2. `UniformsUtils.cloneUniforms` copies anything that is not a Three object
 *     or an Array *by reference*. Backing our uniforms with `Float32Array`
 *     therefore gives every material in the scene a pointer to the same
 *     storage, so one write here relights all of them with no traversal.
 *
 * The fog is applied in the fog chunk, which runs after tone mapping — so we
 * push our linear radiance through the shader's own `toneMapping()` and
 * `linearToOutputTexel()` before mixing. That makes distant geometry converge
 * on exactly the pixel the sky dome would have drawn.
 */

/** Shared, mutated in place; see the note above about clone-by-reference. */
export const AERIAL = {
  uAerialSky: new Float32Array([0.05, 0.09, 0.18]),
  uAerialHoriz: new Float32Array([0.2, 0.24, 0.3]),
  uAerialSun: new Float32Array([0, 0, 0]),
  uAerialSunDir: new Float32Array([0, 1, 0]),
  /** density · 1/m, height falloff · 1/m, sun-glow exponent, max opacity */
  uAerialParams: new Float32Array([0.0016, 0.012, 7.0, 0.92]),
  /** fog base height (m), unused, unused, unused */
  uAerialParams2: new Float32Array([-6, 0, 0, 0]),
};

const PARS_VERTEX = /* glsl */`
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
#endif
`;

const VERTEX = /* glsl */`
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorldPos = cameraPosition + mvPosition.xyz * mat3( viewMatrix );
#endif
`;

const PARS_FRAGMENT = /* glsl */`
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	uniform vec3 uAerialSky;
	uniform vec3 uAerialHoriz;
	uniform vec3 uAerialSun;
	uniform vec3 uAerialSunDir;
	uniform vec4 uAerialParams;
	uniform vec4 uAerialParams2;
#endif
`;

const FRAGMENT = /* glsl */`
#ifdef USE_FOG
	vec3 aerialRay = vFogWorldPos - cameraPosition;
	float aerialDist = max( length( aerialRay ), 1e-3 );
	aerialRay /= aerialDist;

	float aerialH = smoothstep( -0.10, 0.45, aerialRay.y );
	vec3 aerialCol = mix( uAerialHoriz, uAerialSky, aerialH * aerialH );
	aerialCol += uAerialSun * pow( max( dot( aerialRay, uAerialSunDir ), 0.0 ), uAerialParams.z );

	float aerialK = uAerialParams.y;
	float aerialY0 = max( cameraPosition.y - uAerialParams2.x, 0.0 );
	float aerialY1 = max( vFogWorldPos.y - uAerialParams2.x, 0.0 );
	float aerialDy = aerialY1 - aerialY0;
	float aerialOpt;
	if ( abs( aerialDy ) > 0.05 ) {
		aerialOpt = uAerialParams.x * aerialDist
			* ( exp( - aerialK * aerialY0 ) - exp( - aerialK * aerialY1 ) ) / ( aerialK * aerialDy );
	} else {
		aerialOpt = uAerialParams.x * aerialDist * exp( - aerialK * aerialY0 );
	}
	float fogFactor = ( 1.0 - exp( - max( aerialOpt, 0.0 ) ) ) * uAerialParams.w;

	#if defined( TONE_MAPPING )
		aerialCol = toneMapping( aerialCol );
	#endif
	aerialCol = linearToOutputTexel( vec4( aerialCol, 1.0 ) ).rgb;
	gl_FragColor.rgb = mix( gl_FragColor.rgb, aerialCol, fogFactor );
#endif
`;

let installed = false;

/**
 * Swaps the fog chunks and seeds the shared uniforms into every stock shader.
 * Must run before any material is compiled — SkySystem has `order = 0`.
 */
export function installAerialPerspective(): void {
  if (installed) return;
  installed = true;

  const chunk = THREE.ShaderChunk as unknown as Record<string, string>;
  chunk.fog_pars_vertex = PARS_VERTEX;
  chunk.fog_vertex = VERTEX;
  chunk.fog_pars_fragment = PARS_FRAGMENT;
  chunk.fog_fragment = FRAGMENT;

  const entries = Object.entries(AERIAL);
  const lib = (THREE.UniformsLib as unknown as Record<string, Record<string, unknown>>).fog;
  for (const [k, v] of entries) lib[k] = { value: v };

  // ShaderLib was merged (and thus deep-copied) at module load, so patching
  // UniformsLib alone is not enough for the built-in materials.
  const shaderLib = THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, unknown> }>;
  for (const name of Object.keys(shaderLib)) {
    const u = shaderLib[name]?.uniforms;
    if (!u || !('fogColor' in u)) continue;
    for (const [k, v] of entries) u[k] = { value: v };
  }
}

const _c = new THREE.Color();

function writeColor(dst: Float32Array, c: THREE.Color, scale = 1): void {
  dst[0] = c.r * scale; dst[1] = c.g * scale; dst[2] = c.b * scale;
}

export interface AerialUpdate {
  sky: THREE.Color;
  horizon: THREE.Color;
  sunGlow: THREE.Color;
  sunDir: THREE.Vector3;
  density: number;
  heightFalloff: number;
  sunGlowExponent: number;
  maxOpacity: number;
}

export function updateAerial(u: AerialUpdate): void {
  writeColor(AERIAL.uAerialSky, u.sky);
  writeColor(AERIAL.uAerialHoriz, u.horizon);
  writeColor(AERIAL.uAerialSun, u.sunGlow);
  AERIAL.uAerialSunDir[0] = u.sunDir.x;
  AERIAL.uAerialSunDir[1] = u.sunDir.y;
  AERIAL.uAerialSunDir[2] = u.sunDir.z;
  AERIAL.uAerialParams[0] = u.density;
  AERIAL.uAerialParams[1] = u.heightFalloff;
  AERIAL.uAerialParams[2] = u.sunGlowExponent;
  AERIAL.uAerialParams[3] = u.maxOpacity;
  void _c;
}
