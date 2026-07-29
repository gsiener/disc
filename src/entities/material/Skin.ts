import * as THREE from 'three';
import {
  hook, at, FRAG_PARS, VERT_PARS, VERT_MAIN, PART_DEFS, NOISE, HEAD_DIR, PI_DEFS,
} from './Glsl.ts';
import type { DetailTextures } from './Detail.ts';
import type { SkinTones, HairColour } from './Tone.ts';
import type { SharedUniforms, MatDetail } from './Shared.ts';

/**
 * ============================================================================
 *  SKIN
 * ============================================================================
 *
 * Four things separate skin from painted plastic, in order of how fast the eye
 * catches them:
 *
 *   1. Light comes back out somewhere other than where it went in. That is the
 *      whole game. It shows up as a soft, red-tinted terminator (the wrap) and
 *      as thin parts glowing when the sun is behind them (the transmission).
 *   2. Roughness varies spatially. A forehead is oilier than a cheek and a nose
 *      tip is oilier than either. One roughness value across a face is the
 *      single loudest "this is a 3D model" cue there is.
 *   3. The specular highlight is broken. Skin's micro-relief is a network of
 *      furrows enclosing smooth plateaux, so a highlight lands as a cluster of
 *      islands, never as one clean blob.
 *   4. There is hair on it. Eyebrows, lashes and — on most of a men's roster —
 *      visible stubble along the jaw. A hairless face reads as a mannequin no
 *      matter how good the sculpt is.
 *
 * All four are here. Placement is done in the head's own sculpt coordinates,
 * reconstructed from `uv` (see `headDir`), so a brow sits on the brow ridge the
 * geometry actually has rather than on a guess, for every face in the roster.
 */

export interface SkinInputs {
  tones: SkinTones;
  hair: HairColour;
  detail: DetailTextures;
  shared: SharedUniforms;
  quality: MatDetail;
  /** Palpebral geometry from the rig's own `headFrame`, for lashes and lids. */
  eye: { n: number; apW: number; apU: number; apD: number };
  /** Athlete height, metres — detail scales with the body, not with the world. */
  height: number;
  seed: number;
  /** Beard density, 0 clean-shaven. */
  stubble: number;
  /** Freckle threshold: 1 = none, 0.55 = heavy. */
  freckle: number;
  bodyHair: number;
}

export interface SkinMaterial {
  material: THREE.MeshPhysicalMaterial;
  setSweat(v: number): void;
}

export function makeSkinMaterial(i: SkinInputs): SkinMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0.0,
    // Skin has a low-index oil film over it: specular is weak but never absent.
    // Killing it is what makes a matte character look like unfired clay.
    specularIntensity: 0.62,
    normalMap: i.detail.pore,
    normalScale: new THREE.Vector2(1, 1),
    // A trace of sheen stands in for the vellus hair every real body carries;
    // it is what stops a shoulder going glassy at a grazing angle.
    sheen: 0.22,
    sheenRoughness: 0.85,
  });
  m.name = 'player.skin';
  m.sheenColor.setRGB(i.tones.subsurface.r, i.tones.subsurface.g, i.tones.subsurface.b);

  const u = {
    uPore: { value: i.detail.pore },
    uAux: { value: i.detail.aux },
    uTone: { value: i.tones.albedo },
    uToneTan: { value: i.tones.tanned },
    uToneFlush: { value: i.tones.flush },
    uToneLip: { value: i.tones.lip },
    uSss: { value: i.tones.subsurface },
    uHairCol: { value: i.hair.root },
    uEyeGeo: { value: new THREE.Vector4(i.eye.n, i.eye.apW, i.eye.apU, i.eye.apD) },
    uSkinCtl: { value: new THREE.Vector4(i.stubble, i.freckle, i.bodyHair, i.seed) },
    uSweat: { value: 0 },
    uBodyScale: { value: 1.8 / Math.max(1.2, i.height) },
  };

  hook(m, (sh) => {
    Object.assign(sh.uniforms, u, i.shared.uniforms);

    sh.vertexShader = VERT_PARS + sh.vertexShader.replace('void main() {', `void main() {\n${VERT_MAIN}`);

    sh.fragmentShader = PI_DEFS + FRAG_PARS + PART_DEFS + NOISE + HEAD_DIR + /* glsl */`
      uniform sampler2D uPore;
      uniform sampler2D uAux;
      uniform vec3 uTone, uToneTan, uToneFlush, uToneLip, uSss, uHairCol;
      uniform vec4 uEyeGeo;     // eyeN, apW, apU, apD
      uniform vec4 uSkinCtl;    // stubble, freckleThreshold, bodyHair, seed
      uniform float uSweat, uBodyScale;
      uniform vec3 uSunView, uSunColor;
      uniform float uTime;

      // Set once per fragment, read by the lighting model below. GLSL has no
      // other way to get per-fragment data into RE_Direct.
      vec3 gSss = vec3(1.0);
      vec3 gWrap = vec3(0.0);
      float gThin = 0.0;
      float gTrans = 0.0;

      /**
       * Triplanar sample of the shared pore map in BIND space. The rig's uvs run
       * around and along each loft, so their density changes by a factor of four
       * between a neck and a thigh; bind-space projection gives every square
       * centimetre of the athlete the same pore count, which is the only way a
       * closeup and a wide can share one detail map.
       */
      vec2 poreTri(vec3 p, vec3 n, float s, out float micro) {
        vec3 w = abs(n); w *= w; w *= w; w /= (w.x + w.y + w.z + 1e-5);
        vec4 a = texture2D(uPore, p.zy * s);
        vec4 b = texture2D(uPore, p.xz * s);
        vec4 c = texture2D(uPore, p.xy * s);
        micro = a.a * w.x + b.a * w.y + c.a * w.z;
        return ((a.xy - 0.5) * w.x + (b.xy - 0.5) * w.y + (c.xy - 0.5) * w.z) * 2.0;
      }
      vec4 auxTri(vec3 p, vec3 n, float s) {
        vec3 w = abs(n); w *= w; w *= w; w /= (w.x + w.y + w.z + 1e-5);
        return texture2D(uAux, p.zy * s) * w.x + texture2D(uAux, p.xz * s) * w.y
             + texture2D(uAux, p.xy * s) * w.z;
      }
    ` + sh.fragmentShader;

    /* ------------------------------------------------ per-fragment masks */
    sh.fragmentShader = at(sh.fragmentShader, 'map_fragment', {
      before: /* glsl */`
        // Bind space, not world and not view: the projection axes have to be
        // welded to the athlete or the pore field swims across the skin the
        // moment either the camera or the skeleton moves.
        vec3 bp = vBind * uBodyScale;
        vec3 bn = normalize(vBindN);

        float pHead = isPart(P_HEAD);
        float pEar = isPart(P_EAR);
        float pArm = isPart(P_UPPERARM);
        float pLeg = isPart(P_THIGH);
        float pHand = isPart(P_HAND) + isPart(P_FINGER);
        float pNeck = isPart(P_NECK);
        float pTorso = isPart(P_TORSO);

        vec3 hd = headDir(vSurfUv);
        float hy = hd.y, hx = hd.x, hz = hd.z;
        float axf = abs(hx);
        float fr = clamp(hz, 0.0, 1.0);
        float jawNy = -0.66 - 0.46 * clamp(hz, 0.0, 1.0) + 0.36 * clamp(-hz, 0.0, 1.0);

        float micro = 0.5;
        vec2 poreN = poreTri(bp, bn, 190.0, micro);
        vec4 aux = auxTri(bp, bn, 9.0);

        /* ---- sun exposure: the tan line is where the kit stops -------- */
        float expo = clamp(
            pHead + pEar + pHand
          + pNeck * 0.88
          + pArm * smoothstep(0.28, 0.40, vLen)
          + pLeg * smoothstep(0.28, 0.37, vLen) * (1.0 - smoothstep(0.68, 0.74, vLen))
          + pTorso * 0.08, 0.0, 1.0);
        // The boundary itself is never a ruled line — it follows the hem, and the
        // hem moves. A little noise across it is the whole tell.
        expo = clamp(expo + (aux.r - 0.5) * 0.35, 0.0, 1.0);

        /* ---- perfusion: where blood sits close to the surface --------- */
        float flush = clamp(
            pEar * 0.80
          + pHand * 0.26
          + pHead * fr * (0.60 * g1(hy, -0.34, 0.12) * g1(axf, 0.0, 0.17)
                        + 0.42 * g1(hy, -0.26, 0.19) * g1(axf, 0.54, 0.22)
                        + 0.26 * g1(hy, -0.90, 0.15) * g1(axf, 0.0, 0.28))
          + pLeg * 0.30 * g1(vLen, 0.545, 0.045)
          + pArm * 0.26 * g1(vLen, 0.569, 0.045), 0.0, 1.0);

        /* ---- vermilion ------------------------------------------------ */
        float lipX = g1(hx, 0.0, 0.235);
        float lips = clamp(pHead * lipX * clamp(hz * 1.4 - 0.30, 0.0, 1.0)
          * (g1(hy, -0.572, 0.050) + g1(hy, -0.700, 0.058)), 0.0, 1.0);
        lips *= 1.0 - 0.75 * g1(hy, -0.634, 0.016);   // the lip line itself is skin

        /* ---- brows, lashes, lid margin -------------------------------- */
        float browY = 0.150 + 0.058 * g1(axf, 0.26, 0.13) - 0.11 * smoothstep(0.34, 0.50, axf);
        float brow = pHead * fr
          * smoothstep(0.50, 0.42, axf) * smoothstep(0.045, 0.085, axf)
          * exp(-pow((hy - browY) / 0.058, 2.0));
        // Break the band into hairs. Without this it is an eyeshadow smear.
        float browHair = smoothstep(0.30, 0.62, aux.a * (0.75 + 0.55 * vnoise(vSurfUv * vec2(620.0, 210.0))));
        brow *= mix(0.35, 1.15, browHair);

        float ddx = axf - uEyeGeo.x;
        float apV = hy > 0.0 ? uEyeGeo.z : uEyeGeo.w;
        float qq = sqrt(max(0.0, ddx * ddx / (uEyeGeo.y * uEyeGeo.y) + hy * hy / (apV * apV)));
        float rim = pHead * step(0.18, hz) * exp(-pow((qq - 1.0) / 0.11, 2.0));
        float lash = rim * (hy > 0.0 ? 1.0 : 0.42)
          * smoothstep(0.25, 0.65, vnoise(vec2(atan(hy, ddx) * 30.0, 1.0)) * 0.5 + aux.a * 0.9);

        /* ---- stubble --------------------------------------------------- */
        float beardZone = pHead * fr
          * smoothstep(-0.30, -0.44, hy)
          * (1.0 - smoothstep(jawNy + 0.20, jawNy - 0.06, hy))
          * (1.0 - 0.85 * lips)
          * (1.0 - 0.7 * g1(hy, -0.48, 0.05) * g1(hx, 0.0, 0.055));
        // Moustache and chin patch are denser than the cheek.
        beardZone *= 0.72 + 0.5 * g1(hy, -0.50, 0.09) * g1(axf, 0.0, 0.20)
                          + 0.4 * g1(hy, -0.86, 0.13) * g1(axf, 0.0, 0.24);
        float foll = aux.a * (0.6 + 0.8 * vnoise(vSurfUv * vec2(900.0, 320.0)));
        float beard = beardZone * smoothstep(1.02 - uSkinCtl.x, 1.02 - uSkinCtl.x + 0.30, foll);
        beard *= step(0.02, uSkinCtl.x);

        /* ---- body hair on the forearm and shin ------------------------ */
        float hairZone = (pArm * smoothstep(0.55, 0.70, vLen) + pLeg * smoothstep(0.30, 0.45, vLen)
          * (1.0 - smoothstep(0.66, 0.74, vLen)));
        float bhair = hairZone * uSkinCtl.z
          * smoothstep(0.55, 0.95, aux.a * (0.55 + 0.9 * vnoise(vSurfUv * vec2(420.0, 900.0))));

        /* ---- sweat ------------------------------------------------------ */
        float sweatZone = clamp(
            pHead * fr * (0.95 * g1(hy, 0.52, 0.26) + 0.55 * g1(hy, -0.47, 0.07) * g1(axf, 0.0, 0.22)
                        + 0.40 * g1(hy, -0.20, 0.22) * g1(axf, 0.62, 0.22))
          + pNeck * 0.75 + pTorso * 0.85
          + pArm * smoothstep(0.34, 0.52, vLen) * 0.6, 0.0, 1.0);
        float sweat = sweatZone * uSweat;
        // Beads: a cellular field thresholded so the wet area is patchy, not a
        // uniform gloss. It is the breakup, not the shine, that reads as sweat.
        vec2 bead = mworley(bp * 320.0).xy;
        float wetIslands = smoothstep(0.55, 0.16, bead.x) * step(0.30, bead.y);
        float wet = sweat * mix(0.35, 1.0, wetIslands);
      `,
      after: /* glsl */`
        vec3 skin = mix(uTone, uToneTan, expo);
        skin = mix(skin, uToneFlush, flush * 0.85);
        // Complexion mottle — every real face has it and no rendered one does.
        skin *= 1.0 + (aux.r - 0.5) * 0.16 + (vnoise(vSurfUv * 24.0) - 0.5) * 0.06;
        // Subdermal venous cast on the thin-skinned surfaces.
        float veinZone = pArm * smoothstep(0.60, 0.85, vLen) + pHand * 0.8 + pNeck * 0.4;
        skin = mix(skin, skin * vec3(0.84, 0.93, 1.05), aux.b * veinZone * 0.45);
        // Freckles. Threshold is per-player: most of the roster has none.
        float fk = smoothstep(uSkinCtl.y, uSkinCtl.y + 0.09, aux.g)
          * (pHead * fr * (0.5 + 0.5 * g1(hy, -0.22, 0.34)) + pArm * 0.7 + pTorso * 0.4);
        skin = mix(skin, skin * vec3(0.62, 0.46, 0.38), fk * 0.75);
        skin = mix(skin, uToneLip, lips * 0.92);
        // Hair, last, because it sits on top of all of it.
        vec3 hairAlbedo = uHairCol * 0.85;
        skin = mix(skin, hairAlbedo, clamp(brow * 1.15 + lash * 1.25, 0.0, 1.0));
        skin = mix(skin, mix(skin, hairAlbedo, 0.62), beard);
        skin = mix(skin, mix(skin, hairAlbedo, 0.45), bhair);
        // Baked cavity. The rig writes it at every fold the sculpt has.
        skin *= 1.0 - 0.30 * vCrease;
        // Wet skin is darker: the water film removes the air/keratin interface.
        skin *= 1.0 - 0.16 * wet;

        diffuseColor.rgb *= skin;

        gSss = uSss;
        // Red wraps furthest because it is the least absorbed in the dermis; this
        // ratio is the whole reason a terminator on skin goes orange.
        gWrap = vec3(0.42, 0.20, 0.11) * mix(1.0, 0.55, expo * 0.5);
        gThin = clamp(0.10 + pEar * 0.95 + isPart(P_FINGER) * 0.60 + pNeck * 0.18
          + pHead * fr * (0.70 * g1(hy, -0.36, 0.10) * g1(axf, 0.0, 0.22)
                        + 0.30 * g1(hy, -0.90, 0.14) * g1(axf, 0.0, 0.26)), 0.0, 1.0);
        gTrans = 1.0;
      `,
    });

    /* ------------------------------------------------------- roughness */
    sh.fragmentShader = at(sh.fragmentShader, 'roughnessmap_fragment', {
      after: /* glsl */`
        float rgh = 0.545;
        rgh += pHead * fr * (-0.150 * g1(hy, 0.54, 0.28)
                             -0.170 * g1(hy, -0.34, 0.12) * g1(axf, 0.0, 0.17)
                             +0.075 * g1(hy, -0.26, 0.20) * g1(axf, 0.56, 0.24)
                             -0.060 * g1(hy, -0.06, 0.14) * g1(axf, 0.42, 0.20));
        rgh -= lips * 0.20;
        rgh += beard * 0.16 + bhair * 0.10 + brow * 0.10;
        rgh += pTorso * 0.03 + pLeg * 0.02;
        // Micro-relief: plateaux polish, furrow floors stay matte.
        rgh *= mix(0.84, 1.16, micro);
        rgh += (aux.r - 0.5) * 0.05;
        // Sweat collapses roughness in patches. Patches, not a wash.
        rgh = mix(rgh, 0.085 + 0.10 * micro, wet * 0.85);
        roughnessFactor = clamp(rgh, 0.06, 0.95);
      `,
    });

    /* ----------------------------------------------------------- normal */
    sh.fragmentShader = at(sh.fragmentShader, 'normal_fragment_maps', {
      replace: /* glsl */`
        {
          float m2;
          vec2 fine = poreN;
          ${i.quality > 0 ? `
          vec2 coarse = poreTri(bp, bn, 46.0, m2);
          fine += coarse * 0.55;` : ''}
          // Hair sits proud of the skin; brows and stubble have to disturb the
          // surface or they read as a decal printed on a smooth face.
          float hairBump = brow * 0.9 + beard * 0.7 + bhair * 0.5 + lash * 0.8;
          fine += (mhash22(vSurfUv * vec2(700.0, 260.0)) - 0.5) * hairBump * 1.6;
          // Beads stand up off the surface where the film has broken.
          fine += (mhash22(bp.xy * 300.0) - 0.5) * wet * wetIslands * 1.1;
          vec3 mapN = vec3(fine * 1.15, 1.0);
          normal = normalize(tbn * mapN);
        }
      `,
    });

    /* ------------------------------------ subsurface lighting model ---- */
    sh.fragmentShader = at(sh.fragmentShader, 'lights_physical_pars_fragment', {
      after: /* glsl */`
        void RE_Direct_Skin(const in IncidentLight directLight, const in vec3 geometryPosition,
            const in vec3 geometryNormal, const in vec3 geometryViewDir,
            const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material,
            inout ReflectedLight reflectedLight) {
          float dotNL = dot(geometryNormal, directLight.direction);
          // Normalised per-channel wrapped diffuse. The wrap width is the mean
          // free path of the channel in dermis, so red bleeds a quarter of a
          // radian past the terminator and blue barely bleeds at all.
          vec3 w = gWrap;
          vec3 diff = clamp((vec3(dotNL) + w) / ((1.0 + w) * (1.0 + w)), 0.0, 1.0);
          float hard = saturate(dotNL);
          vec3 tint = mix(vec3(1.0), gSss, clamp((diff - vec3(hard)) * 4.0, 0.0, 1.0));
          reflectedLight.directDiffuse += directLight.color * diff * tint
            * BRDF_Lambert(material.diffuseContribution);
          #ifdef USE_SHEEN
            sheenSpecularDirect += hard * directLight.color
              * BRDF_Sheen(directLight.direction, geometryViewDir, geometryNormal,
                           material.sheenColor, material.sheenRoughness);
          #endif
          reflectedLight.directSpecular += hard * directLight.color
            * BRDF_GGX_Multiscatter(directLight.direction, geometryViewDir, geometryNormal, material);
        }
        #undef RE_Direct
        #define RE_Direct RE_Direct_Skin
      `,
    });

    /* -------------------------------------- transmission and crease AO */
    sh.fragmentShader = at(sh.fragmentShader, 'lights_fragment_end', {
      after: /* glsl */`
        {
          // Forward scattering through thin tissue, driven by the sun uniform
          // rather than by the light loop — deliberately. An ear lit from behind
          // is in its own shadow, so the shadow map zeroes the very light that is
          // supposed to be coming through it. This term ignores the map, which is
          // the physically correct thing to do for a 3 mm slab.
          vec3 Lv = normalize(uSunView);
          vec3 LT = normalize(-Lv + geometryNormal * 0.24);
          float bk = pow(clamp(dot(geometryViewDir, -LT), 0.0, 1.0), 4.5);
          float shaded = clamp(0.55 - 0.75 * dot(geometryNormal, Lv), 0.0, 1.0);
          reflectedLight.indirectDiffuse += uSunColor * uSunGlow * bk * gThin * shaded
            * mix(diffuseColor.rgb, gSss * 0.9, 0.65) * 1.35;
          // The rig's baked cavity term stands in for an AO map.
          reflectedLight.indirectDiffuse *= 1.0 - 0.55 * vCrease;
        }
      `,
    });
  });

  m.customProgramCacheKey = () => `ult.skin.${i.quality}`;
  m.needsUpdate = true;

  return {
    material: m,
    setSweat(v: number) { u.uSweat.value = v; },
  };
}
