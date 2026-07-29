import * as THREE from 'three';
import { bake, heightField, heightToNormal, linearColor, canvasTexture } from '../../util/Tex';
import { fbm2, worley2, ridged2, valueNoise2, hash2, clamp, smoothstep } from '../../util/Noise';
import type { Ctx } from '../../core/Ctx';
import { CLUB, BOWL, AISLE_COUNT } from './Layout';

/**
 * Installs an onBeforeCompile that survives a later assignment — three's CSM
 * addon overwrites `material.onBeforeCompile` wholesale. Ours runs first.
 */
export function chainCompile(
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

/** Peak sRGB level of foliage albedo. Leaves are much darker than they look. */
const LEAF_ALB = 0.40;

/**
 * Sub-rectangles of the tree atlas, as [u0, v0, u1, v1]. Anything drawn with
 * `StadiumMaterials.foliage` picks the quadrant that matches what it is.
 */
export const TREE_UV = {
  card: [0.008, 0.008, 0.492, 0.492],
  bark: [0.508, 0.008, 0.992, 0.492],
  mass: [0.008, 0.508, 0.492, 0.992],
  needle: [0.508, 0.508, 0.992, 0.992],
} as const;

/**
 * World-space position varying. Derived from `mvPosition` after
 * `project_vertex` so it is correct for instanced and skinned draws alike
 * without a matrix inverse — the same trick `render/sky/Aerial.ts` uses.
 */
const WORLD_VARY_PARS = 'varying vec3 vXWorld;\n';
const WORLD_VARY_VERT = /* glsl */`
#include <project_vertex>
	vXWorld = cameraPosition + mvPosition.xyz * mat3( viewMatrix );
`;

/**
 * Every stadium surface gets albedo variation, relief and spatially varying
 * roughness — a flat MeshStandardMaterial reads as a prototype from 40 m away
 * just as fast as it does from 2 m. Textures are tiled in *world* units (the
 * geometry writes metre-scaled UVs), so one 512² concrete set covers the whole
 * bowl without visible repeats at broadcast distance.
 */
export class StadiumMaterials {
  concrete!: THREE.MeshStandardMaterial;
  concreteDark!: THREE.MeshStandardMaterial;
  steel!: THREE.MeshStandardMaterial;
  steelDark!: THREE.MeshStandardMaterial;
  plastic!: THREE.MeshStandardMaterial;
  seat!: THREE.MeshStandardMaterial;
  paint!: THREE.MeshStandardMaterial;
  fabric!: THREE.MeshStandardMaterial;
  rubber!: THREE.MeshStandardMaterial;
  tarmac!: THREE.MeshStandardMaterial;
  roofDeck!: THREE.MeshStandardMaterial;
  glass!: THREE.MeshStandardMaterial;
  foliage!: THREE.MeshStandardMaterial;
  signage!: THREE.MeshStandardMaterial;
  seatMapTex!: THREE.CanvasTexture;

  /* ------------------------------------------------------- exterior kit */
  /** Car bodywork. Per-vertex `aSurf` picks paint / glass / tyre / chrome. */
  carPaint!: THREE.MeshStandardMaterial;
  /** City facades: floor banding, recessed reveals, per-cell window lighting. */
  facade!: THREE.MeshStandardMaterial;
  /** Painted road and bay markings — worn through the vertex colour. */
  roadPaint!: THREE.MeshStandardMaterial;
  /** Tri-channel world-space macro field. Shared by the roof and the apron. */
  macroField!: THREE.DataTexture;

  /** Wall clock for foliage sway. Written once a frame by the exterior. */
  readonly windTime: THREE.IUniform<number> = { value: 0 };
  /** 0 = day, 1 = night. Drives the city's window emission. */
  readonly cityNight: THREE.IUniform<number> = { value: 0 };

  private disposables: Array<{ dispose(): void }> = [];

  build(ctx: Ctx): void {
    const aniso = ctx.quality.anisotropy;
    const S = ctx.quality.tier === 'low' ? 256 : 512;

    /* ------------------------------------------------------------ concrete */
    const cH = heightField(S, (u, v) => {
      const big = fbm2(u * 6, v * 6, { octaves: 4, seed: 11 }) * 0.5;
      const pits = worley2(u * 34, v * 34, 3).f1;
      const agg = 1 - smoothstep(0.0, 0.24, pits);
      const grit = valueNoise2(u * 210, v * 210, 5) * 0.16;
      const form = smoothstep(0.48, 0.5, Math.abs(((v * 4) % 1) - 0.5)) * 0.1;
      return big * 0.5 + agg * 0.32 + grit - form;
    });
    const cN = heightToNormal(cH, S, S, 1.35, { anisotropy: aniso });
    const cA = bake((x, y, u, v, out, i) => {
      const h = cH[y * S + x];
      const stain = clamp(fbm2(u * 3.1 + 9, v * 3.1, { octaves: 5, seed: 31 }) * 0.5 + 0.5, 0, 1);
      const streak = clamp(ridged2(u * 2.0, v * 22.0, { octaves: 3, seed: 77 }), 0, 1);
      let l = 0.60 + h * 0.30 - stain * 0.16 - streak * 0.10;
      l = clamp(l, 0.12, 0.92);
      const warm = 1 + (stain - 0.5) * 0.06;
      out[i] = 255 * l * warm * 0.99;
      out[i + 1] = 255 * l * 0.985;
      out[i + 2] = 255 * l * 0.955 * (1 - streak * 0.05);
      out[i + 3] = 255;
    }, { size: S, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'concrete-a' });
    const cR = bake((x, y, u, v, out, i) => {
      const h = cH[y * S + x];
      const wet = clamp(fbm2(u * 4.4, v * 4.4, { octaves: 3, seed: 5 }) * 0.5 + 0.5, 0, 1);
      const r = clamp(0.93 - h * 0.14 - wet * 0.10, 0.42, 1);
      out[i] = 255; out[i + 1] = 255 * r; out[i + 2] = 0; out[i + 3] = 255;
    }, { size: S, anisotropy: aniso, name: 'concrete-r' });
    this.disposables.push(cA, cN, cR);

    this.concrete = new THREE.MeshStandardMaterial({
      color: linearColor(CLUB.concrete), map: cA, normalMap: cN, roughnessMap: cR,
      normalScale: new THREE.Vector2(0.85, 0.85), roughness: 1.0, metalness: 0.0,
      vertexColors: true, name: 'concrete',
    });
    this.concreteDark = this.concrete.clone();
    this.concreteDark.color = linearColor(0x6d6a63);
    this.concreteDark.side = THREE.DoubleSide;   // vom interiors are seen from both sides
    this.concreteDark.name = 'concrete-dark';

    /* --------------------------------------------------------------- steel */
    const sH = heightField(256, (u, v) => {
      const brush = valueNoise2(u * 340, v * 12, 21) * 0.4;
      const dent = fbm2(u * 12, v * 12, { octaves: 3, seed: 3 }) * 0.3;
      const bolt = 1 - smoothstep(0.0, 0.09, worley2(u * 9, v * 9, 41).f1);
      return brush + dent + bolt * 0.7;
    });
    const sN = heightToNormal(sH, 256, 256, 1.0, { anisotropy: aniso });
    const sA = bake((x, y, u, v, out, i) => {
      const h = sH[y * 256 + x];
      const grime = clamp(fbm2(u * 5, v * 5, { octaves: 4, seed: 61 }) * 0.5 + 0.5, 0, 1);
      const rust = Math.max(0, ridged2(u * 7, v * 7, { octaves: 4, seed: 91 }) - 0.62) * 2.4;
      const l = clamp(0.78 + h * 0.16 - grime * 0.20, 0.2, 1);
      out[i] = 255 * clamp(l + rust * 0.25, 0, 1);
      out[i + 1] = 255 * clamp(l - rust * 0.12, 0, 1);
      out[i + 2] = 255 * clamp(l - rust * 0.22, 0, 1);
      out[i + 3] = 255;
    }, { size: 256, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'steel-a' });
    const sR = bake((x, y, u, v, out, i) => {
      const grime = clamp(fbm2(u * 5, v * 5, { octaves: 4, seed: 61 }) * 0.5 + 0.5, 0, 1);
      out[i] = 255; out[i + 1] = 255 * clamp(0.38 + grime * 0.36, 0.2, 0.95);
      out[i + 2] = 255 * 0.85; out[i + 3] = 255;
    }, { size: 256, anisotropy: aniso, name: 'steel-r' });
    this.disposables.push(sA, sN, sR);

    this.steel = new THREE.MeshStandardMaterial({
      color: linearColor(CLUB.steel), map: sA, normalMap: sN, roughnessMap: sR, metalnessMap: sR,
      normalScale: new THREE.Vector2(0.7, 0.7), roughness: 0.55, metalness: 0.85,
      vertexColors: true, name: 'steel',
    });
    this.steelDark = this.steel.clone();
    this.steelDark.color = linearColor(0x4a4f55);
    this.steelDark.metalness = 0.8;
    this.steelDark.name = 'steel-dark';

    this.paint = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: sA, normalMap: sN, roughnessMap: sR,
      normalScale: new THREE.Vector2(0.35, 0.35), roughness: 0.45, metalness: 0.05,
      vertexColors: true, name: 'paint',
    });

    /* ------------------------------------------------------------- plastic */
    const pH = heightField(256, (u, v) => {
      const ribs = Math.abs(((v * 26) % 1) - 0.5);
      const rib = smoothstep(0.42, 0.5, ribs) * 0.55;
      const grain = valueNoise2(u * 190, v * 190, 13) * 0.14;
      const scuff = Math.max(0, fbm2(u * 20, v * 20, { octaves: 3, seed: 8 })) * 0.12;
      return rib + grain + scuff;
    });
    const pN = heightToNormal(pH, 256, 256, 1.15, { anisotropy: aniso });
    const pR = bake((x, y, u, v, out, i) => {
      const wear = clamp(fbm2(u * 9, v * 9, { octaves: 4, seed: 44 }) * 0.5 + 0.5, 0, 1);
      out[i] = 255; out[i + 1] = 255 * clamp(0.34 + wear * 0.42, 0.22, 0.92); out[i + 2] = 0; out[i + 3] = 255;
    }, { size: 256, anisotropy: aniso, name: 'plastic-r' });
    const pA = bake((x, y, u, v, out, i) => {
      const h = pH[y * 256 + x];
      const dirt = clamp(fbm2(u * 7 + 3, v * 7, { octaves: 4, seed: 19 }) * 0.5 + 0.5, 0, 1);
      const l = clamp(0.86 + h * 0.16 - dirt * 0.20, 0.35, 1);
      out[i] = 255 * l; out[i + 1] = 255 * l; out[i + 2] = 255 * l * 0.99; out[i + 3] = 255;
    }, { size: 256, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'plastic-a' });
    this.disposables.push(pN, pR, pA);

    this.plastic = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: pA, normalMap: pN, roughnessMap: pR,
      normalScale: new THREE.Vector2(0.55, 0.55), roughness: 0.6, metalness: 0.0,
      vertexColors: true, name: 'plastic',
    });
    // Seats are instanced: vertex colour carries the moulded-in AO, and the
    // per-instance colour carries the seat map (team colours + lettering).
    this.seat = this.plastic.clone();
    this.seat.name = 'seat';

    /* -------------------------------------------------------------- fabric */
    const fH = heightField(256, (u, v) => {
      const warp = Math.sin(u * Math.PI * 2 * 64) * 0.5 + 0.5;
      const weft = Math.sin(v * Math.PI * 2 * 64) * 0.5 + 0.5;
      return warp * 0.5 + weft * 0.5 + valueNoise2(u * 120, v * 120, 7) * 0.2;
    });
    const fN = heightToNormal(fH, 256, 256, 0.85, { anisotropy: aniso });
    this.disposables.push(fN);
    this.fabric = new THREE.MeshStandardMaterial({
      color: 0xffffff, normalMap: fN, normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.88, metalness: 0.0, vertexColors: true, side: THREE.DoubleSide, name: 'fabric',
    });

    /* -------------------------------------------------------------- rubber */
    this.rubber = new THREE.MeshStandardMaterial({
      color: 0x1a1a1c, map: pA, normalMap: pN, normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.94, metalness: 0.0, vertexColors: true, name: 'rubber',
    });

    /* -------------------------------------------------------------- tarmac */
    const tH = heightField(S, (u, v) => {
      const grain = worley2(u * 90, v * 90, 17).f1;
      return grain * 0.5 + valueNoise2(u * 240, v * 240, 23) * 0.3;
    });
    const tN = heightToNormal(tH, S, S, 1.5, { anisotropy: aniso });
    const tA = bake((x, y, u, v, out, i) => {
      const h = tH[y * S + x];
      const patch = clamp(fbm2(u * 3, v * 3, { octaves: 4, seed: 55 }) * 0.5 + 0.5, 0, 1);
      const l = clamp(0.20 + h * 0.14 + patch * 0.10, 0.06, 0.5);
      out[i] = 255 * l; out[i + 1] = 255 * l * 1.01; out[i + 2] = 255 * l * 1.05; out[i + 3] = 255;
    }, { size: S, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'tarmac-a' });
    this.disposables.push(tN, tA);
    this.tarmac = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: tA, normalMap: tN, roughness: 0.95, metalness: 0,
      vertexColors: true, name: 'tarmac',
    });

    /* ----------------------------------------------------------- roof deck */
    // Standing-seam aluminium. The tile is one 0.6 m pan: two upstand seams,
    // a shallow stiffening rib in the middle of the pan, and rolling-mill
    // grain along the fall line. Geometry supplies the *structural* seams at
    // 2.4 m; this supplies the sheet metal between them.
    const rH = heightField(256, (u, v) => {
      const seam = Math.abs(((u * 8) % 1) - 0.5);
      const rib = smoothstep(0.40, 0.49, seam) * 1.0;
      const stiff = smoothstep(0.16, 0.02, Math.abs(((u * 8) % 1) - 0.5)) * 0.22;
      const pan = Math.sin(u * Math.PI * 2 * 8) * 0.04;
      const oilcan = fbm2(u * 9, v * 3.5, { octaves: 3, seed: 27 }) * 0.09;
      return rib + stiff + pan + oilcan + valueNoise2(u * 150, v * 26, 3) * 0.05;
    });
    const rN = heightToNormal(rH, 256, 256, 2.1, { anisotropy: aniso });
    const rA = bake((x, y, u, v, out, i) => {
      const h = rH[y * 256 + x];
      // Rain runs down the fall line: long, thin, cool streaks.
      const streak = clamp(ridged2(u * 3, v * 34, { octaves: 3, seed: 71 }), 0, 1);
      const oxide = clamp(fbm2(u * 5.5, v * 2.2, { octaves: 4, seed: 133 }) * 0.5 + 0.5, 0, 1);
      const l = clamp(0.60 - streak * 0.13 + h * 0.10 + (oxide - 0.5) * 0.13, 0.16, 0.92);
      out[i] = 255 * l * (1 + (oxide - 0.5) * 0.05);
      out[i + 1] = 255 * l * 1.005;
      out[i + 2] = 255 * l * (1.03 + streak * 0.03);
      out[i + 3] = 255;
    }, { size: 256, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'roof-a' });
    const rR = bake((x, y, u, v, out, i) => {
      // Weathered sheet: the crown of each seam stays bright, the pans dull,
      // and the wash-down streaks are matte.
      const h = rH[y * 256 + x];
      const streak = clamp(ridged2(u * 3, v * 34, { octaves: 3, seed: 71 }), 0, 1);
      const chalk = clamp(fbm2(u * 7, v * 2.8, { octaves: 4, seed: 51 }) * 0.5 + 0.5, 0, 1);
      const r = clamp(0.34 + chalk * 0.32 + streak * 0.22 - h * 0.09, 0.20, 0.90);
      // Coated sheet, not bare metal: enough metalness to catch the sun off the
      // seam crowns, not so much that the pans lose their albedo and the roof
      // inverts into a bright lattice on a dark field.
      const m = clamp(0.72 - streak * 0.28 - chalk * 0.20, 0.18, 0.86);
      out[i] = 255; out[i + 1] = 255 * r; out[i + 2] = 255 * m; out[i + 3] = 255;
    }, { size: 256, anisotropy: aniso, name: 'roof-orm' });
    this.disposables.push(rN, rA, rR);
    this.roofDeck = new THREE.MeshStandardMaterial({
      color: linearColor(0xbfc3c6), map: rA, normalMap: rN, roughnessMap: rR, metalnessMap: rR,
      normalScale: new THREE.Vector2(1.0, 1.0),
      roughness: 1.0, metalness: 0.62, vertexColors: true, name: 'roof-deck',
    });
    // A hectare of one texture set mips to its mean by the time the
    // establishing camera sees it, so a world-space macro field carries the
    // last two octaves: bay-to-bay sheet colour, ponding round the gutter and
    // a broad grime gradient toward the back of the canopy.
    const macro = this.macroField = this.bakeMacro(aniso);
    this.disposables.push(macro);
    chainCompile(this.roofDeck, (sh) => {
      sh.uniforms.uMacro = { value: macro };
      sh.vertexShader = WORLD_VARY_PARS + sh.vertexShader.replace(
        '#include <project_vertex>', WORLD_VARY_VERT,
      );
      sh.fragmentShader = `${WORLD_VARY_PARS}uniform sampler2D uMacro;\n${sh.fragmentShader}`.replace(
        '#include <roughnessmap_fragment>', /* glsl */`
	vec3 mA = texture2D( uMacro, vXWorld.xz * 0.0135 ).rgb;
	vec3 mB = texture2D( uMacro, vXWorld.xz * 0.0022 + 0.37 ).rgb;
	float weather = mA.r * 0.55 + mB.g * 0.45;
	// Sheets are laid in bays: quantise part of the variation so panels read
	// as panels rather than as an airbrushed cloud.
	float bay = floor( mB.b * 7.0 ) / 7.0;
	diffuseColor.rgb *= 0.80 + 0.30 * weather + 0.14 * bay;
	#include <roughnessmap_fragment>
	roughnessFactor = clamp( roughnessFactor + ( weather - 0.5 ) * 0.34 + ( bay - 0.5 ) * 0.10, 0.10, 0.98 );
`,
      ).replace(
        '#include <metalnessmap_fragment>', /* glsl */`
	#include <metalnessmap_fragment>
	metalnessFactor = clamp( metalnessFactor - ( 1.0 - weather ) * 0.22, 0.16, 1.0 );
`,
      );
    });

    /* --------------------------------------------------------------- misc */
    this.glass = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.22, metalness: 0.55, vertexColors: true, name: 'exterior',
    });
    this.signage = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.55, metalness: 0.0, vertexColors: true,
      alphaTest: 0.42, side: THREE.DoubleSide, name: 'signage',
    });

    this.buildExteriorKit(ctx, aniso);
  }

  /* ------------------------------------------------------------------------
   *  Exterior kit — cars, foliage, city facades, road paint.
   * ---------------------------------------------------------------------- */

  private buildExteriorKit(ctx: Ctx, aniso: number): void {
    /* ------------------------------------------------------------- car paint */
    // Automotive lacquer: orange peel at grazing angles, a faint flake, and a
    // wash of road film along the lower body. Roughness and metalness come
    // per-vertex from `aSurf`, so one material covers paint, glass, tyre,
    // chrome and lamp lens in a single instanced draw.
    const kH = heightField(128, (u, v) => (
      fbm2(u * 26, v * 26, { octaves: 3, seed: 9 }) * 0.5
      + valueNoise2(u * 160, v * 160, 12) * 0.10
    ));
    const kN = heightToNormal(kH, 128, 128, 0.55, { anisotropy: aniso });
    const kA = bake((_x, _y, u, v, out, i) => {
      const film = clamp(fbm2(u * 6, v * 6, { octaves: 3, seed: 23 }) * 0.5 + 0.5, 0, 1);
      const l = 0.92 + (film - 0.5) * 0.13;
      out[i] = 255 * l; out[i + 1] = 255 * l; out[i + 2] = 255 * l; out[i + 3] = 255;
    }, { size: 128, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'car-a' });
    this.disposables.push(kN, kA);
    this.carPaint = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: kA, normalMap: kN, normalScale: new THREE.Vector2(0.4, 0.4),
      roughness: 0.52, metalness: 0.05, vertexColors: true, name: 'car-paint',
    });
    chainCompile(this.carPaint, (sh) => {
      sh.vertexShader = /* glsl */`
attribute vec3 aSurf;
attribute vec3 aTint;
varying vec3 vSurf;
${sh.vertexShader}`.replace('#include <color_vertex>', /* glsl */`
	#include <color_vertex>
	vSurf = aSurf;
	// aSurf.x is the paint mask: bodywork takes the car's colour, glass,
	// rubber, chrome and lamp lenses keep the colour baked into the vertex.
	vColor.rgb *= mix( vec3( 1.0 ), aTint, aSurf.x );
`);
      sh.fragmentShader = `varying vec3 vSurf;\n${sh.fragmentShader}`
        .replace('#include <roughnessmap_fragment>', /* glsl */`
	#include <roughnessmap_fragment>
	roughnessFactor = clamp( vSurf.y * ( 0.86 + 0.28 * roughnessFactor ), 0.028, 1.0 );
`)
        .replace('#include <metalnessmap_fragment>', /* glsl */`
	#include <metalnessmap_fragment>
	metalnessFactor = vSurf.z;
`);
    });

    /* --------------------------------------------------------------- foliage */
    // One atlas serves the whole tree: the left half is a leaf mass with an
    // alpha silhouette (used by the canopy cards), the right half is opaque
    // bark (used by trunks, branches and the canopy shells).
    const leaf = this.bakeLeafAtlas(aniso);
    this.disposables.push(leaf);
    this.foliage = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: leaf, roughness: 0.86, metalness: 0.0,
      vertexColors: true, alphaTest: 0.42, side: THREE.DoubleSide, name: 'foliage',
    });
    const wind = this.windTime;
    chainCompile(this.foliage, (sh) => {
      sh.uniforms.uWindT = wind;
      sh.vertexShader = /* glsl */`
uniform float uWindT;
${sh.vertexShader}`.replace('#include <begin_vertex>', /* glsl */`
	#include <begin_vertex>
	#ifdef USE_INSTANCING
		float wph = instanceMatrix[ 3 ].x * 0.21 + instanceMatrix[ 3 ].z * 0.17;
	#else
		float wph = 0.0;
	#endif
	// Sway grows with height above the root plate; the trunk stays put.
	float wsw = smoothstep( 0.8, 4.5, transformed.y ) * 0.075;
	transformed.x += ( sin( uWindT * 0.85 + wph ) + 0.42 * sin( uWindT * 2.31 + wph * 1.7 ) ) * wsw;
	transformed.z += ( cos( uWindT * 0.71 + wph * 1.3 ) + 0.38 * sin( uWindT * 1.93 + wph * 2.1 ) ) * wsw * 0.9;
`);
    });

    /* ---------------------------------------------------------------- facade */
    const fac = this.bakeFacadeSet(ctx, aniso);
    this.disposables.push(fac.albedo, fac.normal, fac.orm, fac.lit);
    this.facade = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: fac.albedo, normalMap: fac.normal,
      roughnessMap: fac.orm, metalnessMap: fac.orm,
      normalScale: new THREE.Vector2(1.0, 1.0),
      roughness: 1.0, metalness: 1.0, vertexColors: true,
      emissive: new THREE.Color(0, 0, 0), emissiveIntensity: 1,
      name: 'city-facade',
    });
    const night = this.cityNight;
    chainCompile(this.facade, (sh) => {
      sh.uniforms.uLit = { value: fac.lit };
      sh.uniforms.uCityNight = night;
      sh.fragmentShader = /* glsl */`
uniform sampler2D uLit;
uniform float uCityNight;
${sh.fragmentShader}`.replace('#include <emissivemap_fragment>', /* glsl */`
	#include <emissivemap_fragment>
	// UVs are in tiles of 4 window modules, so the integer lattice of
	// vMapUv * 4 is exactly one window. Each cell reads its own lamp out of a
	// 64² occupancy map: offices go dark in blocks, flats in ones and twos.
	vec2 wcell = floor( vMapUv * 4.0 ) * ( 1.0 / 64.0 );
	vec4 lamp = texture2D( uLit, wcell + vec2( 0.5 / 64.0 ) );
	// Past a couple of hundred metres the glass mask mips toward its own
	// coverage fraction, so this term becomes an average facade glow rather
	// than individual windows. Keep it low enough that the average never
	// out-values a sunlit wall, and ramp it so dusk is a hint, not a blaze.
	float wmask = diffuseColor.a;
	diffuseColor.a = 1.0;
	float nk = uCityNight * uCityNight * ( 3.0 - 2.0 * uCityNight );
	totalEmissiveRadiance += lamp.rgb * lamp.a * wmask * nk * 0.95;
`);
    });

    /* ------------------------------------------------------------ road paint */
    this.roadPaint = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: kA, roughness: 0.94, metalness: 0.0,
      vertexColors: true, name: 'road-paint',
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
  }

  /** Tri-channel world-space macro field, shared by the roof and the ground. */
  private bakeMacro(aniso: number): THREE.DataTexture {
    return bake((_x, _y, u, v, out, i) => {
      const a = clamp(fbm2(u * 5, v * 5, { octaves: 4, seed: 301 }) * 0.5 + 0.5, 0, 1);
      const b = clamp(fbm2(u * 2.2 + 13, v * 2.2, { octaves: 3, seed: 907 }) * 0.5 + 0.5, 0, 1);
      const c = clamp(worley2(u * 6, v * 6, 55).f1 * 1.6, 0, 1);
      out[i] = 255 * a; out[i + 1] = 255 * b; out[i + 2] = 255 * c; out[i + 3] = 255;
    }, { size: 256, anisotropy: aniso, name: 'macro-field' });
  }

  /**
   * One atlas for the whole tree kit, in quadrants:
   *
   *   TREE_UV.card   broadleaf clump with a ragged alpha silhouette
   *   TREE_UV.bark   fissured bark, opaque
   *   TREE_UV.mass   dense interior foliage, opaque — the canopy shells
   *   TREE_UV.needle conifer spray with alpha
   *
   * That is what lets a tree be trunk, branch, shell and card in a single
   * alpha-tested draw call per species.
   */
  private bakeLeafAtlas(aniso: number): THREE.DataTexture {
    const S = 512;
    return bake((_x, _y, u, v, out, i) => {
      let r = 0, g = 0, b = 0, a = 255;
      if (u < 0.5 && v < 0.5) {
        /* --- broadleaf clump card --------------------------------------- */
        const lu = u * 2, lv = v * 2;
        const dx = (lu - 0.5) * 2.05, dy = (lv - 0.5) * 2.15;
        const rad = Math.hypot(dx, dy);
        const erode = fbm2(lu * 7.5, lv * 7.5, { octaves: 4, seed: 205 });
        const gaps = worley2(lu * 4.5, lv * 4.5, 88).f1;
        let al = smoothstep(1.06, 0.58, rad + erode * 0.34);
        al *= smoothstep(0.05, 0.17, gaps) * 0.6 + 0.4;
        const clump = clamp(worley2(lu * 15, lv * 15, 12).f2 * 1.5, 0, 1);
        const shade = clamp(0.40 + clump * 0.54 + fbm2(lu * 26, lv * 26, { octaves: 3, seed: 6 }) * 0.24, 0, 1);
        // Foliage albedo is *dark*: about 4 % red, 9 % green, 2 % blue in
        // linear terms. Painting it at the brightness a canvas wants makes a
        // tree read as a plastic cabbage no matter how good its silhouette is.
        const l = LEAF_ALB * shade * (1 - smoothstep(0.95, 0.12, rad) * 0.30);
        r = 255 * l * 0.74; g = 255 * l; b = 255 * l * 0.52;
        a = 255 * clamp(al, 0, 1);
      } else if (u >= 0.5 && v < 0.5) {
        /* --- bark -------------------------------------------------------- */
        const bu = (u - 0.5) * 2, bv = v * 2;
        const fis = clamp(ridged2(bu * 5.5, bv * 30, { octaves: 4, seed: 77 }), 0, 1);
        const lich = Math.max(0, fbm2(bu * 9, bv * 9, { octaves: 3, seed: 401 })) * 0.6;
        const l = clamp(0.22 + fis * 0.26 - lich * 0.07, 0.06, 0.62);
        r = 255 * l * 1.04; g = 255 * l * (0.88 + lich * 0.24); b = 255 * l * (0.70 + lich * 0.22);
      } else if (u < 0.5 && v >= 0.5) {
        /* --- dense interior mass (opaque canopy shells) ------------------ */
        const mu = u * 2, mv = (v - 0.5) * 2;
        const clump = clamp(worley2(mu * 9, mv * 9, 31).f2 * 1.4, 0, 1);
        const fine = clamp(worley2(mu * 30, mv * 30, 5).f1 * 2.2, 0, 1);
        const shade = clamp(0.30 + clump * 0.46 + fine * 0.24
          + fbm2(mu * 16, mv * 16, { octaves: 4, seed: 61 }) * 0.20, 0.06, 1);
        const l = LEAF_ALB * shade;
        r = 255 * l * 0.72; g = 255 * l * 0.98; b = 255 * l * 0.50;
      } else {
        /* --- conifer spray ----------------------------------------------- */
        const nu = (u - 0.5) * 2, nv = (v - 0.5) * 2;
        // Needles fan off a central rachis; the card tapers to a point.
        const spine = Math.abs(nu - 0.5);
        const along = nv;
        const taper = smoothstep(1.0, 0.30, along);
        const fan = clamp(1 - spine / (0.06 + 0.42 * taper), 0, 1);
        const comb = 0.5 + 0.5 * Math.sin((nu * 96 + nv * 22) * Math.PI);
        let al = smoothstep(0.02, 0.30, fan) * (0.45 + 0.55 * comb);
        al *= smoothstep(0.0, 0.10, along) * smoothstep(1.02, 0.86, along);
        const l = LEAF_ALB * 0.86 * clamp(0.26 + fan * 0.30 + comb * 0.24, 0, 1);
        r = 255 * l * 0.62; g = 255 * l * 0.90; b = 255 * l * 0.60;
        a = 255 * clamp(al, 0, 1);
      }
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
    }, { size: S, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'tree-atlas' });
  }

  /**
   * City facade set. The tile is 4 window modules × 4 floors (9.6 × 14.4 m),
   * so a building's UVs are simply its world metres over those numbers and
   * every floor line lands on a real floor.
   */
  private bakeFacadeSet(ctx: Ctx, aniso: number): {
    albedo: THREE.DataTexture; normal: THREE.DataTexture;
    orm: THREE.DataTexture; lit: THREE.DataTexture;
  } {
    const S = ctx.quality.tier === 'low' ? 256 : 512;
    // Per-texel module coordinates: 4 modules across, 4 floors up.
    const modU = (u: number) => (u * 4) % 1;
    const modV = (v: number) => (v * 4) % 1;
    // Window opening inside the module, in module units.
    const WX0 = 0.13, WX1 = 0.87, WY0 = 0.20, WY1 = 0.80;
    const glassAt = (u: number, v: number) => {
      const mu = modU(u), mv = modV(v);
      const inx = smoothstep(WX0 - 0.012, WX0 + 0.012, mu) * (1 - smoothstep(WX1 - 0.012, WX1 + 0.012, mu));
      const iny = smoothstep(WY0 - 0.014, WY0 + 0.014, mv) * (1 - smoothstep(WY1 - 0.014, WY1 + 0.014, mv));
      // A central mullion splits every opening into two lights.
      const mull = 1 - smoothstep(0.030, 0.012, Math.abs(mu - 0.5));
      return inx * iny * mull;
    };

    const fH = heightField(S, (u, v) => {
      const g = glassAt(u, v);
      const mv = modV(v);
      // Floor slab edge proud of the glass line, with a shadow gap under it.
      const slab = (1 - smoothstep(0.02, 0.10, mv)) * 0.55 + (1 - smoothstep(0.02, 0.09, 1 - mv)) * 0.30;
      const grain = valueNoise2(u * 260, v * 260, 17) * 0.05;
      return (1 - g) * 0.55 + slab * 0.5 + grain;
    });
    const normal = heightToNormal(fH, S, S, 2.6, { anisotropy: aniso });

    const albedo = bake((_x, _y, u, v, out, i) => {
      const g = glassAt(u, v);
      const mv = modV(v);
      const grime = clamp(fbm2(u * 3.4, v * 3.4, { octaves: 4, seed: 63 }) * 0.5 + 0.5, 0, 1);
      const streak = clamp(ridged2(u * 4, v * 26, { octaves: 3, seed: 12 }), 0, 1);
      // Spandrel: precast panel, dirtier under each slab. A real concrete
      // panel is about 18 % linear reflectance; painting it at canvas-white
      // clips the whole skyline the moment a low sun hits it.
      const sp = clamp(0.40 - grime * 0.10 - streak * 0.07 - (1 - smoothstep(0.02, 0.16, mv)) * 0.09, 0.09, 0.54);
      // Glass: dark blue-grey, brighter where the sky rakes off it.
      const sky = clamp(0.14 + fbm2(u * 9, v * 9, { octaves: 3, seed: 88 }) * 0.11, 0, 1);
      out[i] = 255 * (sp * (1 - g) + sky * 0.70 * g);
      out[i + 1] = 255 * (sp * 0.995 * (1 - g) + sky * 0.84 * g);
      out[i + 2] = 255 * (sp * 0.965 * (1 - g) + sky * 1.05 * g);
      out[i + 3] = 255 * g;   // alpha carries the glass mask for the night pass
    }, { size: S, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'facade-a' });

    const orm = bake((_x, _y, u, v, out, i) => {
      const g = glassAt(u, v);
      const grime = clamp(fbm2(u * 3.4, v * 3.4, { octaves: 4, seed: 63 }) * 0.5 + 0.5, 0, 1);
      const r = (0.82 - grime * 0.14) * (1 - g) + (0.09 + grime * 0.07) * g;
      const m = 0.03 * (1 - g) + 0.62 * g;
      out[i] = 255; out[i + 1] = 255 * clamp(r, 0.05, 1); out[i + 2] = 255 * m; out[i + 3] = 255;
    }, { size: S, anisotropy: aniso, name: 'facade-orm' });

    // 64² window-occupancy map. Lighting clusters: an fbm field decides which
    // parts of a building are occupied at all, then a per-cell hash decides
    // whether that particular office is lit and how warm its lamp is.
    const lit = bake((x, y, _u, _v, out, i) => {
      const field = fbm2(x * 0.16, y * 0.11, { octaves: 3, seed: 511 }) * 0.5 + 0.5;
      const floorRun = fbm2(x * 0.03, y * 0.55, { octaves: 2, seed: 733 }) * 0.5 + 0.5;
      const h = hash2(x, y, 909);
      const p = clamp(field * 0.78 + floorRun * 0.34 - 0.42, 0, 1);
      const on = h < p ? 1 : 0;
      // Warm tungsten in the smaller tenancies, cool fluorescent in the towers.
      const warm = hash2(x, y, 1717);
      const cool = warm > 0.62;
      const level = on * (0.55 + hash2(x, y, 313) * 0.45);
      out[i] = 255 * (cool ? 0.72 : 1.0);
      out[i + 1] = 255 * (cool ? 0.84 : 0.80);
      out[i + 2] = 255 * (cool ? 1.0 : 0.52);
      out[i + 3] = 255 * level;
    }, { size: 64, colorSpace: THREE.SRGBColorSpace, mips: false, anisotropy: 1, name: 'facade-lit' });
    lit.magFilter = THREE.NearestFilter;
    lit.minFilter = THREE.NearestFilter;

    return { albedo, normal, orm, lit };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

/* ----------------------------------------------------------- seat colouring */

/**
 * The seat colour map. Horizontal axis is the bowl's base parameter t (0..1
 * around the plan), vertical axis is the row. Everything the bowl "spells out"
 * in contrasting seats is painted here and sampled per seat, which is exactly
 * how a real venue lays out its lettering.
 */
export function bakeSeatMap(): THREE.CanvasTexture {
  const W = 2048, H = 256;
  return canvasTexture(W, H, (c) => {
    const px = (t: number) => t * W;
    c.fillStyle = '#11314f';
    c.fillRect(0, 0, W, H);

    // Row-banding: lighter band across the upper third, darker kerb at row 0.
    const grad = c.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(9,26,44,1)');
    grad.addColorStop(0.42, 'rgba(17,49,79,1)');
    grad.addColorStop(0.62, 'rgba(29,92,134,1)');
    grad.addColorStop(0.68, 'rgba(17,49,79,1)');
    grad.addColorStop(1, 'rgba(21,63,97,1)');
    c.fillStyle = grad;
    c.fillRect(0, 0, W, H);

    // Section alternation — every other section a touch darker.
    c.globalAlpha = 0.16;
    for (let i = 0; i < AISLE_COUNT; i += 2) {
      c.fillStyle = '#000000';
      c.fillRect((i / AISLE_COUNT) * W, 0, W / AISLE_COUNT, H);
    }
    c.globalAlpha = 1;

    // Base parameter ranges — derived from the plan so lettering stays inside
    // its own straight when the bowl is re-proportioned.
    const R = BOWL.cornerR;
    const sxL = BOWL.hx - R, szL = BOWL.hz - R;
    const segLens = [2 * szL, R * Math.PI / 2, 2 * sxL, R * Math.PI / 2,
      2 * szL, R * Math.PI / 2, 2 * sxL, R * Math.PI / 2];
    const P = segLens.reduce((a, b) => a + b, 0);
    const t0: number[] = []; let acc = 0;
    for (const l of segLens) { t0.push(acc / P); acc += l; }
    const tEnd = (i: number) => t0[i] + segLens[i] / P;

    const drawText = (seg: number, text: string, yTop: number, yBot: number, fill: string, weight = 900) => {
      const a = px(t0[seg]) + 26, b = px(tEnd(seg)) - 26;
      const w = b - a, h = (yBot - yTop) * H;
      c.save();
      c.translate(a, yTop * H);
      c.fillStyle = fill;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = `${weight} 100px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      const m = c.measureText(text);
      const s = Math.min(w / (m.width + 1), h / 82);
      c.translate(w / 2, h / 2);
      c.scale(s, s);
      c.fillText(text, 0, 0);
      c.restore();
    };

    // Seat lettering. Rows run bottom (row 0) → top of the canvas is the back
    // of the bowl, so lettering sits in the mid-to-upper rows where it reads.
    drawText(0, 'U L T I M A T E', 0.30, 0.56, '#e9edf0');
    drawText(4, 'R I P T I D E', 0.30, 0.56, '#e9edf0');
    drawText(2, 'EST 2019', 0.34, 0.52, '#d9a441');
    drawText(6, 'RIPTIDE', 0.32, 0.54, '#d9a441');

    // Chevron flashes in the corners.
    for (const seg of [1, 3, 5, 7]) {
      const a = px(t0[seg]), b = px(tEnd(seg));
      c.save();
      c.beginPath();
      c.rect(a, 0.60 * H, b - a, 0.14 * H);
      c.clip();
      c.strokeStyle = '#d9a441';
      c.lineWidth = 7;
      for (let x = a - 40; x < b + 40; x += 34) {
        c.beginPath();
        c.moveTo(x, 0.60 * H);
        c.lineTo(x + 17, 0.74 * H);
        c.lineTo(x + 34, 0.60 * H);
        c.stroke();
      }
      c.restore();
    }

    // A pale top band (the "wrap") plus sprinkled gold seats for break-up.
    c.fillStyle = '#c9d3da';
    c.fillRect(0, 0.90 * H, W, 0.045 * H);
    c.fillStyle = 'rgba(217,164,65,0.85)';
    for (let i = 0; i < 900; i++) {
      const h = (i * 2654435761) >>> 0;
      const x = (h % W), y = ((h >>> 11) % H);
      if (y > 0.86 * H || y < 0.1 * H) continue;
      c.fillRect(x, y, 3, 3);
    }
  }, { name: 'seat-map', wrap: THREE.RepeatWrapping, anisotropy: 4 });
}

/** Reads a colour out of the seat map. `t` 0..1 around the bowl, `rt` 0..1 up. */
export class SeatMapSampler {
  private data: ImageData;
  private w: number;
  private h: number;
  constructor() {
    const W = 512, H = 128;
    const tex = bakeSeatMap();
    const src = tex.image as HTMLCanvasElement;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d')!;
    c.drawImage(src, 0, 0, W, H);
    this.data = c.getImageData(0, 0, W, H);
    this.w = W; this.h = H;
    tex.dispose();
  }
  sample(t: number, rt: number, out: THREE.Color): THREE.Color {
    const x = Math.min(this.w - 1, Math.max(0, Math.floor(t * this.w)));
    const y = Math.min(this.h - 1, Math.max(0, Math.floor((1 - rt) * this.h)));
    const i = (y * this.w + x) * 4;
    out.setRGB(
      this.data.data[i] / 255, this.data.data[i + 1] / 255, this.data.data[i + 2] / 255,
      THREE.SRGBColorSpace,
    );
    return out;
  }
}
