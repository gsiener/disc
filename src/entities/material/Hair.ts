import * as THREE from 'three';
import {
  hook, at, prelude, vertexPatch, FRAG_PARS, PART_DEFS, NOISE, PI_DEFS, FIBRE_SPEC,
} from './Glsl.ts';
import type { DetailTextures } from './Detail.ts';
import type { HairColour } from './Tone.ts';
import type { SharedUniforms, MatDetail } from './Shared.ts';
import type { HairStyle } from '../rig/Types.ts';

/**
 * ============================================================================
 *  HAIR
 * ============================================================================
 *
 * Hair is not a surface, it is a bundle of dielectric cylinders, and the one
 * thing that gives it away instantly is the highlight. A surface BRDF puts a
 * round specular blob wherever the normal happens to face the halfway vector.
 * A fibre puts a BAND perpendicular to the strand direction, and it puts down
 * two of them:
 *
 *   R    the primary lobe. Light reflected straight off the cuticle, so it is
 *        the colour of the LIGHT, tight, and shifted toward the root because the
 *        cuticle scales tilt about 3° that way.
 *   TRT  the secondary lobe. Light that went into the fibre, bounced off the far
 *        wall and came back out, so it is the colour of the PIGMENT, broad, and
 *        shifted the other way, toward the tip.
 *
 * Between them sits the reason a black-haired athlete under a low sun still has
 * a warm brown sheen instead of a grey one. One lobe reads as wet plastic; this
 * is Marschner's result reduced to the two terms that actually pay.
 *
 * The shell geometry (rig/Head.ts `buildHair`) is a cap plus optional cards.
 * Its silhouette is a smooth outline, which no head of hair has, so the edge is
 * eroded by the strand field at grazing angles — the shell keeps the volume and
 * the alpha test gives it a broken, hairy boundary.
 *
 * UV CONTRACT
 *   cap    u azimuth (0 = front). uv.y = 1 at the crown, 0 at the hairline.
 *   cards  u wraps the section, uv.y 0 at the root, 1 at the tip.
 *   Strands therefore run along ±v in both cases, which is tbn[1].
 */

export interface HairInputs {
  colour: HairColour;
  detail: DetailTextures;
  shared: SharedUniforms;
  quality: MatDetail;
  style: HairStyle;
  /** Hair volume multiplier from BodyParams — coarse styles get fatter strands. */
  bulk: number;
  seed: number;
}

export interface HairMaterial {
  material: THREE.MeshPhysicalMaterial;
  setWet(v: number): void;
}

/** Strand count around the head and along it, per style. */
const STRANDS: Record<string, [number, number]> = {
  buzz: [320, 2.4], short: [260, 3.0], crop: [220, 3.4], ponytail: [190, 4.2],
  bun: [190, 3.8], long: [165, 4.8], locs: [64, 3.6],
};

export function makeHairMaterial(i: HairInputs): HairMaterial {
  const [su, sv] = STRANDS[i.style] ?? STRANDS.short;

  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.36,
    metalness: 0,
    normalMap: i.detail.strand,
    // The shell is a single-sided cap over a skull; seen from underneath (a
    // sideline camera is always below eye level) the inside has to shade.
    side: THREE.DoubleSide,
    alphaTest: 0.42,
    // Sheen carries the diffuse-ish multiple-scatter halo that light hair has and
    // dark hair does not; the amount is set from the pigment below.
    sheen: 1.0,
    sheenRoughness: 0.55,
    specularIntensity: 0.0,   // the fibre lobes replace the GGX specular entirely
  });
  m.name = 'player.hair';
  m.sheenColor.copy(i.colour.sheen).multiplyScalar(0.55);

  const u = {
    uStrand: { value: i.detail.strand },
    uGrunge: { value: i.detail.grunge },
    uRoot: { value: i.colour.root },
    uTip: { value: i.colour.tip },
    uSheen: { value: i.colour.sheen },
    uHairCtl: { value: new THREE.Vector4(i.colour.scatter, i.colour.grey, (i.seed % 733) / 733, i.bulk) },
    uStrandRep: { value: new THREE.Vector2(su, sv) },
    uWet: { value: 0 },
  };

  hook(m, (sh) => {
    Object.assign(sh.uniforms, u, i.shared.uniforms);
    sh.vertexShader = vertexPatch(sh.vertexShader);

    sh.fragmentShader = prelude(sh.fragmentShader,
      PI_DEFS + FRAG_PARS + PART_DEFS + NOISE + FIBRE_SPEC + /* glsl */`
      uniform sampler2D uStrand;
      uniform vec3 uRoot, uTip, uSheen;
      uniform vec4 uHairCtl;   // scatter, greyFraction, seed, bulk
      uniform vec2 uStrandRep;
      uniform float uWet;
      uniform vec3 uSunView, uSunColor;
      uniform float uSunGlow, uTime;

      // Written per fragment, read by the fibre lighting model.
      vec3 gTan = vec3(0.0, 1.0, 0.0);
      vec3 gSheen = vec3(1.0);
      float gShift = 0.0;
      float gGloss = 1.0;
    `);

    sh.fragmentShader = at(sh.fragmentShader, 'map_fragment', {
      before: /* glsl */`
        vec2 huv = vSurfUv;
        vec2 suv = huv * uStrandRep;
        vec4 st = texture2D(uStrand, suv);
        vec4 st2 = texture2D(uStrand, suv * vec2(3.7, 1.3) + 0.21);
        // Clumps: hair does not lie as a field of independent fibres, it lies in
        // locks a centimetre across. Without this band the cap is a smooth dome
        // with a fine grain painted on it — a moulded helmet, which is what the
        // first pass rendered.
        vec4 sc = texture2D(uStrand, suv * vec2(0.16, 0.55) + 0.61);
        // Per-COLUMN strand length, sampled at a fixed v so it cannot vary down
        // the strand. This is what turns the cap's boundary into a comb.
        // The map alone gives about 26 independent columns across a head, and
        // 26 columns through a binary alpha test is a row of rectangular
        // blocks, not a fringe. A per-column hash at four times the rate turns
        // the same band into hair.
        float sCol = huv.x * uStrandRep.x;
        float sLen = texture2D(uStrand, vec2(sCol * 0.45, 0.5)).a * 0.5
          + 0.5 * mhash12(vec2(floor(sCol * 1.9), 3.0));

        // vLen is the one coordinate that means the same thing on both pieces
        // of geometry: 1 at the crown of the cap and 1 at the end of a card, 0
        // at the hairline and 0 at a card's root. Both ends that read as 1 are
        // the ends the sun has been bleaching all season, and both ends that
        // read as 0 sit against the scalp. uv.y does not survive that swap.
        float tip = clamp(vLen, 0.0, 1.0);

        // Per-strand value scatter: neighbouring hairs differ by a real amount,
        // and that variance is most of what makes a mass of hair read as hair.
        float strandVal = mix(1.0 - uHairCtl.x, 1.0 + uHairCtl.x, st.r);
        // Greys are individual strands gone unpigmented, never a wash of grey.
        float grey = step(1.0 - uHairCtl.y, st.r * 0.6 + st2.r * 0.4);
      `,
      after: /* glsl */`
        vec3 hair = mix(uRoot, uTip, clamp(tip * 1.20 - 0.18, 0.0, 1.0));
        hair *= strandVal * mix(0.74, 1.26, sc.r);
        hair = mix(hair, vec3(0.42, 0.41, 0.40), grey * 0.9);
        // The scalp side of a shell is always darker: no light reaches it.
        hair *= mix(0.46, 1.0, smoothstep(0.0, 0.30, tip));
        hair *= 1.0 - 0.35 * vCrease;
        // Wet hair clumps and darkens harder than any other material on a body.
        hair *= mix(1.0, 0.42, uWet);

        diffuseColor.rgb *= hair;

        // Erode the shell's silhouette into strands. Only at grazing angles, and
        // only against the strand field, so the interior stays solid and the
        // outline gains the ragged edge a modelled cap can never have. The
        // hairline row goes with it, which is what stops the cap ending in the
        // moulded lip that gave the first pass its swim-cap look.
        float ndv = abs(dot(normalize(vNormal), normalize(vViewPosition)));
        float graze = 1.0 - smoothstep(0.12, 0.46, ndv);
        float fibre = st.a * 0.55 + sc.a * 0.45;
        // Each column of the cap ends where ITS strand ends, between 4 % and
        // 20 % up the shell. Fading the whole boundary band out together — the
        // first attempt — just moves the ruled line up the forehead; giving
        // every strand its own end point is what makes it a fringe.
        // Keep this band SHORT. At 0.04–0.195 it ate a fifth of the cap, which
        // on a 1.16 rad shell moves the visible hairline 25 mm up the forehead —
        // and a 25 mm brow extension is the difference between an athlete and a
        // cartoon. rig/Head.ts overshoots the shell by exactly this much.
        // Widened from 0.012–0.070 to 0.008–0.115. The narrow band gave every
        // column almost the same end point, so the fringe was a ruled line with
        // a serration filed into it — a bowl cut. A real hairline varies by a
        // centimetre across a forehead and that is what stops it reading as a
        // moulded edge; the band is still short enough that the visible
        // hairline does not climb the forehead (see rig/Head.ts hairline()).
        float tipEnd = 0.008 + 0.107 * sLen;
        float fringe = 1.0 - smoothstep(tipEnd - 0.008, tipEnd + 0.008, vLen);
        // Retire the whole erosion once one strand covers less than a pixel.
        // An alpha test against a sub-pixel mask does not read as fine hair at
        // forty metres, it reads as sparkle, and broadcast and night are both
        // shot from forty metres.
        float strandPx = max(fwidth(suv.x), fwidth(suv.y));
        float erode = 1.0 - smoothstep(0.30, 0.85, strandPx);
        float cut = max(graze * (1.0 - fibre) * 0.90, fringe) * erode;
        diffuseColor.a *= 1.0 - clamp(cut, 0.0, 1.0);

        gSheen = uSheen * mix(1.0, 1.5, uHairCtl.x);
        gShift = (st.g - 0.5) * 0.30;
        gGloss = mix(0.40, 1.0, st.b * 0.6 + sc.b * 0.4) * mix(1.0, 1.7, uWet);
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'roughnessmap_fragment', {
      after: /* glsl */`
        roughnessFactor = clamp(0.42 - 0.14 * st.b + 0.10 * grey - 0.22 * uWet, 0.06, 0.92);
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'normal_fragment_maps', {
      replace: /* glsl */`
        {
          // tbn[1] runs along +v, which is the strand. Perturb ACROSS it only:
          // a hair's normal varies around its own cylinder, never along it.
          vec2 hn = vec2((st.r - 0.5) * 1.20 + (st2.r - 0.5) * 0.40
                         + (sc.r - 0.5) * 1.70, (st.b - 0.5) * 0.18 + (sc.g - 0.5) * 0.30);
          normal = normalize(tbn * vec3(hn, 1.0));
          gTan = normalize(tbn[1]);
        }
      `,
    });

    /* ---------------------------------------------- fibre lighting model */
    sh.fragmentShader = at(sh.fragmentShader, 'lights_physical_pars_fragment', {
      after: /* glsl */`
        void RE_Direct_Hair(const in IncidentLight directLight, const in vec3 geometryPosition,
            const in vec3 geometryNormal, const in vec3 geometryViewDir,
            const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material,
            inout ReflectedLight reflectedLight) {
          float dotNL = dot(geometryNormal, directLight.direction);
          // Hair scatters hard, so its diffuse term wraps most of the way round.
          // An un-wrapped Lambert leaves the back of a head as a black hole.
          float wrapped = clamp((dotNL + 0.42) / 1.42, 0.0, 1.0);
          reflectedLight.directDiffuse += directLight.color * wrapped
            * BRDF_Lambert(material.diffuseContribution);

          vec3 T = gTan;
          // R: off the cuticle, shifted toward the root, the colour of the light.
          vec3 T1 = shiftTangent(T, geometryNormal, -0.055 + gShift);
          float r1 = fibreLobe(T1, geometryViewDir, directLight.direction, 110.0);
          // TRT: through the fibre and back, shifted toward the tip, and tinted
          // by the pigment it travelled through.
          vec3 T2 = shiftTangent(T, geometryNormal, 0.105 + gShift);
          float r2 = fibreLobe(T2, geometryViewDir, directLight.direction, 14.0);
          float vis = clamp(dotNL * 1.4 + 0.25, 0.0, 1.0);
          reflectedLight.directSpecular += directLight.color * vis * gGloss
            * (vec3(0.070) * r1 + gSheen * 0.155 * r2);

          #ifdef USE_SHEEN
            sheenSpecularDirect += saturate(dotNL) * directLight.color
              * BRDF_Sheen(directLight.direction, geometryViewDir, geometryNormal,
                           material.sheenColor, material.sheenRoughness);
          #endif
        }
        #undef RE_Direct
        #define RE_Direct RE_Direct_Hair
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'lights_fragment_end', {
      after: /* glsl */`
        {
          // Backlit hair is translucent at the edges — the classic golden-hour
          // halo, and the one shot in the list that is *about* a face is lit by
          // exactly that. It ignores the shadow map on purpose: a head of hair
          // shadows itself, and the map would cancel the very term it needs.
          vec3 Lv = normalize(uSunView);
          float bk = pow(clamp(dot(geometryViewDir, -Lv), 0.0, 1.0), 3.2);
          float edge = 1.0 - abs(dot(geometryNormal, geometryViewDir));
          reflectedLight.indirectDiffuse += uSunColor * uSunGlow * bk * (0.25 + 0.75 * edge)
            * gSheen * 0.18 * (1.0 - uWet * 0.6);
          reflectedLight.indirectDiffuse *= 1.0 - 0.45 * vCrease;
        }
      `,
    });
  });

  m.customProgramCacheKey = () => `ult.hair.${i.quality}`;
  m.needsUpdate = true;

  return { material: m, setWet(v: number) { u.uWet.value = v; } };
}
