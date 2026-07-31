import * as THREE from 'three';
import {
  hook, at, prelude, vertexPatch, FRAG_PARS, PART_DEFS, NOISE, PI_DEFS,
} from './Glsl.ts';
import type { IrisColour } from './Tone.ts';
import type { SharedUniforms, MatDetail } from './Shared.ts';

/**
 * ============================================================================
 *  EYES
 * ============================================================================
 *
 * The eye is the only part of an athlete a viewer looks at involuntarily, and
 * it is the part that fails hardest when it is approximated. Four things have
 * to be true or the character is dead-eyed:
 *
 *   1. The iris is BEHIND something. The cornea stands 0.5 mm proud of a globe
 *      of radius 12 mm, with 3 mm of aqueous humour (n = 1.336) between it and
 *      the iris plane. So the iris parallaxes against the limbus as the head
 *      turns, and it does so refracted, not straight. A flat iris painted on
 *      the surface reads as a printed sticker at any angle off axis.
 *   2. The iris has radial structure. Trabecular fibres running out from the
 *      collarette, crypts punched between them, a dark limbal ring at the edge.
 *   3. There is a wet layer on top of all of it. One tight, bright, achromatic
 *      catchlight, which is a clearcoat on a sphere and nothing else.
 *   4. The sclera is not white and not evenly lit. It is a warm grey with a
 *      vascular network that thickens toward both canthi, and the upper lid
 *      casts a real shadow across its top third. Skip the lid shadow and you
 *      get the ping-pong-ball stare that kills otherwise good character work.
 *
 * FRAME. The eyeball's own axes cannot be recovered from uv — the parameter is
 * singular exactly where the iris is. They are carried down from the vertex
 * stage instead: the optical axis is +Z in bind space (see rig/Head.ts
 * `buildEyes`), so pushing (0,0,1) and (0,1,0) through the skin matrix and the
 * normal matrix hands the fragment stage an exact view-space eye frame, at two
 * varyings and no per-fragment reconstruction.
 *
 * UV CONTRACT (rig/Head.ts): uv.y = 1 at the corneal apex, iris ≈ uv.y > 0.86,
 * pupil ≈ uv.y > 0.955. Only used here as a fallback bound; everything real is
 * computed from the frame.
 */

export interface EyeInputs {
  iris: IrisColour;
  shared: SharedUniforms;
  quality: MatDetail;
  /** Iris radius as a fraction of the globe radius. Human range 0.40 – 0.47. */
  irisR: number;
  /** Pupil radius, same units. 0.13 bright sun – 0.24 dusk. */
  pupilR: number;
  seed: number;
}

export interface EyeMaterial {
  material: THREE.MeshPhysicalMaterial;
  /** 0 bright sun, 1 floodlit night — drives pupil dilation. */
  setDilation(v: number): void;
}

export function makeEyeMaterial(i: EyeInputs): EyeMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.30,
    metalness: 0,
    // The tear film. This IS the catchlight; there is no other way to get one
    // highlight that stays tight while the sclera underneath stays soft.
    clearcoat: 1.0,
    clearcoatRoughness: 0.018,
    ior: 1.376,
    specularIntensity: 0.5,
    side: THREE.FrontSide,
  });
  m.name = 'player.eyes';

  const u = {
    uStroma: { value: i.iris.stroma },
    uPosterior: { value: i.iris.posterior },
    uIrisCtl: { value: new THREE.Vector4(i.irisR, i.pupilR, i.iris.fibre, i.iris.pigment) },
    uEyeSeed: { value: (i.seed % 641) / 641 },
    uDilate: { value: 0 },
  };

  hook(m, (sh) => {
    Object.assign(sh.uniforms, u, i.shared.uniforms);

    /* ------------------------------------------------------------ vertex */
    sh.vertexShader = vertexPatch(sh.vertexShader);
    sh.vertexShader = prelude(sh.vertexShader, /* glsl */`
      varying vec3 vEyeAxis;
      varying vec3 vEyeUp;
    `);
    // Anchored to skinnormal_vertex because `skinMatrix` is declared there and
    // nowhere else; anywhere earlier and it does not exist yet.
    sh.vertexShader = at(sh.vertexShader, 'skinnormal_vertex', {
      after: /* glsl */`
        #ifdef USE_SKINNING
          mat3 eyeRot = mat3(skinMatrix[0].xyz, skinMatrix[1].xyz, skinMatrix[2].xyz);
        #else
          mat3 eyeRot = mat3(1.0);
        #endif
        vEyeAxis = normalize(normalMatrix * (eyeRot * vec3(0.0, 0.0, 1.0)));
        vEyeUp = normalize(normalMatrix * (eyeRot * vec3(0.0, 1.0, 0.0)));
      `,
    });

    /* ---------------------------------------------------------- fragment */
    sh.fragmentShader = prelude(sh.fragmentShader,
      PI_DEFS + FRAG_PARS + PART_DEFS + NOISE + /* glsl */`
      varying vec3 vEyeAxis;
      varying vec3 vEyeUp;
      uniform vec3 uStroma, uPosterior;
      uniform vec4 uIrisCtl;   // irisR, pupilR, fibreContrast, pigment
      uniform float uEyeSeed, uDilate;
      uniform vec3 uSunView, uSunColor;
      uniform float uSunGlow, uTime;

      /**
       * Iris pattern. n is the sample point in NORMALISED iris coordinates —
       * the unit disc — and r is its length.
       *
       * The fibres are sampled around a circle in the noise field rather than on
       * atan(): an angular coordinate has a branch cut at ±PI, and that cut lands
       * on the nasal side of the iris where it reads as one impossible fibre
       * running the wrong way. Walking a circle of radius K through a continuous
       * 2D field is seamless by construction and costs the same two taps, and
       * growing K with r is what tilts the fibres outward the way real trabeculae
       * splay from the collarette.
       */
      vec3 irisField(vec2 n, float r, float seed) {
        vec2 dp = n / max(r, 1e-4);
        float f1 = vnoise(dp * (26.0 + r * 5.0) + seed * 19.0);
        float f2 = vnoise(dp * (74.0 + r * 13.0) + seed * 7.0);
        float fib = mix(f1, f2, 0.40);
        // Crypts of Fuchs: irregular pits through the anterior border layer,
        // concentrated in the ciliary zone just outside the collarette.
        vec2 cell = mworley(n * 9.0 + seed * 11.0);
        float crypt = smoothstep(0.40, 0.04, cell.x) * step(0.48, cell.y)
          * smoothstep(0.32, 0.55, r) * (1.0 - smoothstep(0.80, 0.96, r));

        // The collarette, at about 0.40 of the radius. A real iris is two-toned
        // across it — the pupillary zone is nearly always the lighter of the two.
        float coll = smoothstep(0.30, 0.44, r);
        vec3 c = mix(uStroma * 1.32 + vec3(0.020, 0.014, 0.008), uStroma, coll);
        // Fibre contrast is a function of pigment: a blue iris is almost all
        // structure, a deep brown one is almost all absorber.
        c *= mix(1.0, mix(0.58, 1.42, fib), uIrisCtl.z);
        c = mix(c, c * 0.40 + uPosterior * 0.45, crypt * 0.85);
        // Pigment ruff — the posterior epithelium curling forward at the margin.
        c = mix(c, uPosterior * 1.7, (1.0 - smoothstep(0.0, 0.16, r)) * 0.50);
        // Limbal ring. Narrow, deep, and worth more than any other single detail
        // on the whole eye.
        c *= 1.0 - 0.82 * smoothstep(0.80, 1.0, r);
        return c;
      }
    `);

    sh.fragmentShader = at(sh.fragmentShader, 'map_fragment', {
      before: /* glsl */`
        vec3 A = normalize(vEyeAxis);
        vec3 Uo = vEyeUp - A * dot(vEyeUp, A);
        vec3 Uu = length(Uo) > 1e-4 ? normalize(Uo) : normalize(cross(A, vec3(1.0, 0.0, 0.0)));
        vec3 Rr = cross(Uu, A);

        // Surface point as a unit direction in the eye's own frame.
        vec3 gN = normalize(vNormal);
        vec3 lp = vec3(dot(gN, Rr), dot(gN, Uu), dot(gN, A));
        vec2 surf = lp.xy;
        float sr = length(surf);

        float irisR = uIrisCtl.x;
        float pupilR = mix(uIrisCtl.y, uIrisCtl.y * 1.85, uDilate);

        /* ---- refracted parallax --------------------------------------- */
        // Straight-line parallax is visibly wrong at the limbus: the aqueous
        // bends the ray back toward the axis, which is why a real iris appears
        // LARGER and less displaced than a naive offset predicts.
        vec3 Vv = normalize(vViewPosition);
        vec3 rd = refract(-Vv, gN, 0.7485);          // 1.0 / 1.336
        vec3 rl = vec3(dot(rd, Rr), dot(rd, Uu), dot(rd, A));
        float irisZ = 0.72;                           // iris plane, globe radii
        float tHit = (irisZ - lp.z) / min(rl.z, -0.04);
        vec2 ip = surf + rl.xy * clamp(tHit, 0.0, 1.4);
        vec2 iNorm = ip / irisR;
        float ir = length(iNorm);

        /* ---- masks ------------------------------------------------------ */
        float aa = max(fwidth(sr) * 1.4, 0.0025);
        float limbus = 1.0 - smoothstep(irisR - aa * 2.0, irisR + aa * 1.5, sr);
        float pupil = 1.0 - smoothstep(pupilR / irisR - 0.035, pupilR / irisR + 0.035, ir);
      `,
      after: /* glsl */`
        /* ---- sclera ----------------------------------------------------- */
        // Never white. A warm, slightly yellow grey, darker toward both canthi
        // where the conjunctiva thickens and the lids shade it.
        // Not white. An eye rendered at paper albedo is the single loudest
        // "this is a doll" cue there is; a real sclera in a socket measures
        // closer to half that even in open sun.
        // At the closeup framing the whole eye is about eight pixels across, and
        // two 0.5-albedo discs at that size read as googly eyes stuck on a dark
        // face. A sclera in a socket measures well under half display white even
        // in open sun; this is the value that survives BOTH crops.
        // Checked against a shadowed face in the delivered closeup shot, which is
        // the only test that counts: at 0.395 the two scleras were the brightest
        // pixels in the frame — brighter than the skin around them, brighter
        // than the jersey — which is the exact "two white bars on a shadowed
        // face" failure this file's own header warns about. A sclera is a bright
        // material sitting at the bottom of a socket, so what reaches the camera
        // is well under its albedo, and the socket is not modelled here.
        vec3 sclera = vec3(0.315, 0.293, 0.270);
        float toCanthus = smoothstep(0.30, 0.85, abs(lp.x));
        sclera *= 1.0 - 0.16 * toCanthus;
        // Vasculature: ridged, radial, thickening outward from the limbus.
        float vth = atan(surf.y, surf.x);
        float vn = vnoise(vec2(vth * 7.0 + uEyeSeed * 23.0, sr * 4.5));
        float vn2 = vnoise(vec2(vth * 19.0 + uEyeSeed * 11.0, sr * 9.0));
        float vessel = pow(clamp(1.0 - abs(vn - 0.5) * 5.6, 0.0, 1.0), 3.0) * 0.7
          + pow(clamp(1.0 - abs(vn2 - 0.5) * 7.5, 0.0, 1.0), 3.0) * 0.4;
        // The exposed sclera only ever reaches sr ≈ 0.75 of a globe radius, so
        // a ramp that did not finish until 2.2 × irisR put the entire vascular
        // network outside the visible aperture — the eye rendered as clean
        // white plastic, which is exactly the ping-pong-ball stare this file
        // opens by warning about.
        vessel *= smoothstep(irisR * 1.00, irisR * 1.62, sr) * (0.30 + 0.90 * toCanthus);
        // 0.62 of a hard red drew a diagram of a bloodshot eye. A vessel is a
        // 40 µm capillary under a translucent membrane: at any framing this
        // project ships it is a warm cast on the sclera, not a line you can
        // follow. Halved, and desaturated toward the sclera it sits on.
        sclera = mix(sclera, vec3(0.315, 0.150, 0.132), clamp(vessel, 0.0, 1.0) * 0.34);
        // Conjunctival shading at both corners: the sclera curves away into the
        // canthus and never catches the key there.
        sclera *= 1.0 - 0.26 * smoothstep(0.42, 0.92, sr);

        /* ---- lid occlusion ---------------------------------------------- */
        // The upper lid overhangs; the globe under it is in shadow even when the
        // face is not. Without this the eye is a bright disc stuck in a socket.
        //
        // But this is ONE occlusion, and it was being spent twice: once here as
        // a multiplier on the albedo and again below on indirectDiffuse. Squared,
        // it took the top of the sclera to 0.08 of its own value and the whole
        // eye read as an empty hole — which at the closeup framing, where a
        // globe is eight pixels across, is the entire eye. Split it: a little of
        // it is genuinely pigment (the conjunctiva IS duskier under the lid) and
        // the rest is light that never arrives.
        float lidUp = smoothstep(-0.16, 0.40, lp.y);
        float lidLo = smoothstep(-0.02, 0.36, -lp.y);
        float lidTint = clamp(1.0 - 0.42 * lidUp - 0.18 * lidLo, 0.34, 1.0);
        float lidAo = clamp(1.0 - 0.58 * lidUp - 0.26 * lidLo, 0.20, 1.0);

        /* ---- compose ---------------------------------------------------- */
        vec3 iris = irisField(iNorm, clamp(ir, 0.0, 1.05), uEyeSeed);
        vec3 eye = mix(sclera, iris, limbus);
        eye = mix(eye, vec3(0.012, 0.010, 0.010), pupil * limbus);
        eye *= lidTint;
        diffuseColor.rgb *= eye;
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'roughnessmap_fragment', {
      after: /* glsl */`
        // The cornea is optically smooth; the exposed sclera is a wet membrane
        // that is not. The tear meniscus in the corners is smoother again.
        roughnessFactor = clamp(mix(0.32, 0.06, limbus) - 0.14 * toCanthus, 0.03, 0.60);
      `,
    });

    // The globe is a sphere: its shading normal is its geometric normal, plus a
    // very slight corneal camber so the catchlight travels across the limbus
    // rather than sitting pinned to one spot.
    sh.fragmentShader = at(sh.fragmentShader, 'normal_fragment_maps', {
      replace: /* glsl */`
        {
          float camber = smoothstep(irisR * 1.25, irisR * 0.35, sr);
          normal = normalize(normal + (Rr * surf.x + Uu * surf.y) * camber * 0.16);
        }
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'lights_fragment_end', {
      after: /* glsl */`
        {
          // Light that crossed the sclera and came back out. It is what stops
          // the white of an eye going grey in the shade of the brow.
          float sss = (1.0 - limbus) * (0.45 + 0.55 * lidUp);
          reflectedLight.indirectDiffuse += uSunColor * uSunGlow * 0.055 * sss
            * vec3(1.0, 0.86, 0.78);
          // A globe in a socket sees maybe half the sky, and the specular has
          // to be occluded with the diffuse or the tear film keeps mirroring a
          // full hemisphere. Skipping this is why two white bars stayed the
          // brightest thing on a shadowed face at broadcast range.
          reflectedLight.indirectDiffuse *= lidAo;
          reflectedLight.indirectSpecular *= 0.28 + 0.72 * lidAo;
          // The catchlight is the point of the whole material and it lives on
          // the cornea, which is the LEAST occluded part of the globe — it is
          // the bit that stands proud of the lids. Occluding it with the sclera
          // is what turns a wet eye into a matte bead.
          reflectedLight.directSpecular *= mix(0.45 + 0.55 * lidAo, 1.0, limbus * 0.8);
        }
      `,
    });
  });

  m.customProgramCacheKey = () => `ult.eyes.${i.quality}`;
  m.needsUpdate = true;

  return { material: m, setDilation(v: number) { u.uDilate.value = v; } };
}
