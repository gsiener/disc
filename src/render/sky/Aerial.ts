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
 *
 * **When PostFX owns the tone curve, neither of those does anything**: the
 * renderer is switched to `NoToneMapping` and the composer target is linear, so
 * the mix happens in linear radiance. That is the single most important fact
 * about tuning this file, and getting it wrong is what produced the white-haze
 * pass. The horizon sits around 0.8 scene-linear and a shaded stand around
 * 0.04, so a "25 % haze" — a number that sounds modest, and is modest in
 * display space — is a **six-fold** lift on that stand. The luminance mix must
 * therefore stay in single digits, and the separation has to be bought with
 * chroma, which is scale-free. See `IN_BOWL_GAIN`.
 */

/** Shared, mutated in place; see the note above about clone-by-reference. */
export const AERIAL = {
  uAerialSky: new Float32Array([0.05, 0.09, 0.18]),
  uAerialHoriz: new Float32Array([0.2, 0.24, 0.3]),
  /** What a *downward* ray scatters — the ground-bounce term, not the sky. */
  uAerialGround: new Float32Array([0.04, 0.05, 0.04]),
  uAerialSun: new Float32Array([0, 0, 0]),
  uAerialSunDir: new Float32Array([0, 1, 0]),
  /** density · 1/m, height falloff · 1/m, sun-glow exponent, max opacity */
  uAerialParams: new Float32Array([0.0003, 0.012, 7.0, 0.92]),
  /** fog base height (m), range-saturation length (m), depth-cue gain, chroma loss */
  uAerialParams2: new Float32Array([-6, 300, 3.5, 1.0]),
  /** shadow-toe lift, unused, unused, unused */
  uAerialParams3: new Float32Array([0.3, 0, 0, 0]),
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
	uniform vec3 uAerialGround;
	uniform vec3 uAerialSun;
	uniform vec3 uAerialSunDir;
	uniform vec4 uAerialParams;
	uniform vec4 uAerialParams2;
	uniform vec4 uAerialParams3;
#endif
`;

const FRAGMENT = /* glsl */`
#ifdef USE_FOG
	vec3 aerialRay = vFogWorldPos - cameraPosition;
	float aerialDist = max( length( aerialRay ), 1e-3 );
	aerialRay /= aerialDist;

	// A ray that points *down* — every ray that lands on the pitch — scatters the
	// ground bounce, not the sky. Using the horizon radiance for those (it is an
	// order of magnitude brighter than sunlit turf) is what turns a stadium into
	// a milk bath the moment the fog is thick enough to see.
	float aerialUp = smoothstep( 0.0, 0.45, aerialRay.y );
	float aerialDn = smoothstep( -0.32, 0.0, aerialRay.y );
	vec3 aerialCol = mix( uAerialGround, uAerialHoriz, aerialDn );
	aerialCol = mix( aerialCol, uAerialSky, aerialUp * aerialUp );
	aerialCol += uAerialSun * pow( max( dot( aerialRay, uAerialSunDir ), 0.0 ), uAerialParams.z ) * aerialDn;

	// Range saturation. A stadium is 150 m across and its horizon is 3 km away;
	// one exponential cannot serve both without either doing nothing inside the
	// bowl or erasing the hills. So the *path length* saturates: it is very
	// nearly linear over the first hundred metres — where the depth cue has to
	// be earned — and asymptotes at uAerialParams2.y beyond it, which is what a
	// shallow, bounded boundary layer actually integrates to.
	float aerialD0 = max( uAerialParams2.y, 1.0 );
	float aerialEff = aerialD0 * ( 1.0 - exp( - aerialDist / aerialD0 ) );

	float aerialK = uAerialParams.y;
	float aerialY0 = max( cameraPosition.y - uAerialParams2.x, 0.0 );
	float aerialY1 = max( vFogWorldPos.y - uAerialParams2.x, 0.0 );
	float aerialDy = aerialY1 - aerialY0;
	float aerialOpt;
	if ( abs( aerialDy ) > 0.05 ) {
		aerialOpt = uAerialParams.x * aerialEff
			* ( exp( - aerialK * aerialY0 ) - exp( - aerialK * aerialY1 ) ) / ( aerialK * aerialDy );
	} else {
		aerialOpt = uAerialParams.x * aerialEff * exp( - aerialK * aerialY0 );
	}
	aerialOpt = max( aerialOpt, 0.0 );
	float fogFactor = ( 1.0 - exp( - aerialOpt ) ) * uAerialParams.w;

	#if defined( TONE_MAPPING )
		aerialCol = toneMapping( aerialCol );
	#endif
	aerialCol = linearToOutputTexel( vec4( aerialCol, 1.0 ) ).rgb;

	// Chroma, micro-contrast and black point fall away with distance *faster*
	// than luminance does — that asymmetry is the depth cue. Buying separation
	// with more density instead is how an earlier pass turned every frame into
	// a white bath: at 120 m the far stand should go grey and flat, not bright.
	float aerialFar = 1.0 - exp( - aerialOpt * uAerialParams2.z );
	vec3 aerialSrc = gl_FragColor.rgb;
	float aerialLum = dot( aerialSrc, vec3( 0.2126, 0.7152, 0.0722 ) );
	float aerialHazeLum = dot( aerialCol, vec3( 0.2126, 0.7152, 0.0722 ) );
	// Desaturate toward the haze *hue* held at the pixel's own luminance, so the
	// far plane picks up the air's colour cast without picking up its exposure.
	vec3 aerialTint = mix( vec3( aerialLum ),
		aerialCol * ( aerialLum / max( aerialHazeLum, 1e-4 ) ), 0.5 );
	aerialSrc = mix( aerialSrc, aerialTint, clamp( aerialFar * uAerialParams2.w, 0.0, 0.92 ) );
	// Lift the toe only. Distant shadow has no true black; distant highlight is
	// untouched. That is the signature of looking through air, and it is exactly
	// the thing a flat frame is missing when near and far share a black point.
	aerialSrc += aerialCol * ( aerialFar * uAerialParams3.x )
		* ( 1.0 - smoothstep( 0.0, 0.34, aerialLum ) );

	gl_FragColor.rgb = mix( aerialSrc, aerialCol, fogFactor );
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

/**
 * Scene-scale correction on the caller's density.
 *
 * The caller hands us a *sky-dome* density already knocked down once for scene
 * scale, and measured against the frame it was returning nothing: 3.5 % at
 * 120 m, so the near touchline and the far side of the bowl shared a contrast,
 * a saturation and a black point.
 *
 * The correction is deliberately small, because in linear radiance the mix is
 * already violently non-linear in *appearance*: at 5 % a shaded stand at 0.04
 * lands on 0.078, which is most of a stop, while the sunlit pitch at 0.105 moves
 * a seventh of that. The uniform airlight term is doing the contrast compression
 * and the black lift on its own — that is what airlight physically is — so the
 * job here is only to make it reach a stop at bowl range and then stop growing,
 * which `RANGE_SAT` handles.
 *
 * Optical opacity at the broadcast hour with these numbers:
 *   20 m ≈ 0.9 %,  60 m ≈ 2.5 %,  120 m ≈ 4.3 %,  400 m ≈ 8.6 %,  3 km ≈ 7.7 %.
 */
const IN_BOWL_GAIN = 1.5;
/** Path length asymptote, metres. See the shader note on range saturation. */
const RANGE_SAT = 300;
/**
 * How much faster chroma fades than luminance. This is where the depth cue
 * actually comes from: desaturation is scale-free, so it can be pushed to 40 %
 * at 120 m without moving a single pixel's brightness, which is exactly the
 * budget the luminance term cannot afford to spend.
 */
const DEPTH_GAIN = 9.0;
/** Peak chroma loss, at full depth. */
const SAT_LOSS = 1.0;
/**
 * Extra shadow-only lift, as a fraction of the haze colour. Small: the airlight
 * mix above already lifts blacks far more than highlights in relative terms.
 * This only exists to finish separating the black point once chroma has gone.
 */
const TOE_LIFT = 0.03;

export interface AerialUpdate {
  sky: THREE.Color;
  horizon: THREE.Color;
  ground: THREE.Color;
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
  writeColor(AERIAL.uAerialGround, u.ground);
  // The glow toward a low sun is a genuine radiance spike — 60× the horizon at
  // 19:00 — and multiplying it by a fog factor still hands the frame a nuclear
  // wash on the sun side, so it is capped against the horizon. But the cap was
  // flat at 2.2×, which legislates away the one cue that makes a 1° sun read as
  // a 1° sun. It now opens up as the sun drops and closes again once the sun is
  // high enough that a warm horizon wash would be wrong anyway.
  const lift = 6.0 + (2.2 - 6.0) * smooth01(u.sunDir.y, 0.02, 0.28);
  _c.copy(u.sunGlow);
  _c.r = Math.min(_c.r, u.horizon.r * lift);
  _c.g = Math.min(_c.g, u.horizon.g * lift);
  _c.b = Math.min(_c.b, u.horizon.b * lift);
  writeColor(AERIAL.uAerialSun, _c);
  AERIAL.uAerialSunDir[0] = u.sunDir.x;
  AERIAL.uAerialSunDir[1] = u.sunDir.y;
  AERIAL.uAerialSunDir[2] = u.sunDir.z;
  AERIAL.uAerialParams[0] = u.density * IN_BOWL_GAIN;
  AERIAL.uAerialParams[1] = u.heightFalloff;
  AERIAL.uAerialParams[2] = u.sunGlowExponent;
  AERIAL.uAerialParams[3] = u.maxOpacity;
  AERIAL.uAerialParams2[1] = RANGE_SAT;
  AERIAL.uAerialParams2[2] = DEPTH_GAIN;
  AERIAL.uAerialParams2[3] = SAT_LOSS;
  AERIAL.uAerialParams3[0] = TOE_LIFT;
}

function smooth01(x: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Opacity, chroma loss and toe lift the current tuning delivers at a distance,
 * for a ray that stays near the camera's own height. This is the read-out the
 * tuning is aimed with — "raise the density until it looks right" is how the
 * last two passes over this file both overshot.
 */
export function aerialProbe(distance: number, cameraY = 15.5): {
  d: number; opacity: number; chromaLoss: number; toe: number;
} {
  const d0 = Math.max(AERIAL.uAerialParams2[1], 1);
  const eff = d0 * (1 - Math.exp(-distance / d0));
  const k = AERIAL.uAerialParams[1];
  const y0 = Math.max(cameraY - AERIAL.uAerialParams2[0], 0);
  const opt = Math.max(AERIAL.uAerialParams[0] * eff * Math.exp(-k * y0), 0);
  const far = 1 - Math.exp(-opt * AERIAL.uAerialParams2[2]);
  return {
    d: distance,
    opacity: (1 - Math.exp(-opt)) * AERIAL.uAerialParams[3],
    chromaLoss: Math.min(far * AERIAL.uAerialParams2[3], 0.92),
    toe: far * AERIAL.uAerialParams3[0],
  };
}
