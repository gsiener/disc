import * as THREE from 'three';
import {
  hook, at, prelude, vertexPatch, FRAG_PARS, PART_DEFS, NOISE, HEAD_DIR, PI_DEFS,
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
  /**
   * Landmarks lifted straight off the sculpt in `rig/Head.ts`, so a brow lands
   * on the brow ridge that head actually has and a lip lands on its vermilion.
   * `mouthW` is the half-width in nx, `noseTip` and `ala` are ny.
   */
  face: { mouthW: number; noseTip: number; ala: number; brow: number; hood: number };
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
    uFaceGeo: {
      value: new THREE.Vector4(i.face.mouthW, i.face.noseTip, i.face.brow, i.face.hood),
    },
    uSkinCtl: { value: new THREE.Vector4(i.stubble, i.freckle, i.bodyHair, i.seed) },
    uSweat: { value: 0 },
    uBodyScale: { value: 1.8 / Math.max(1.2, i.height) },
  };

  hook(m, (sh) => {
    Object.assign(sh.uniforms, u, i.shared.uniforms);

    sh.vertexShader = vertexPatch(sh.vertexShader);

    sh.fragmentShader = prelude(sh.fragmentShader, PI_DEFS + FRAG_PARS + PART_DEFS + NOISE + HEAD_DIR + /* glsl */`
      uniform sampler2D uPore;
      uniform sampler2D uAux;
      uniform vec3 uTone, uToneTan, uToneFlush, uToneLip, uSss, uHairCol;
      uniform vec4 uEyeGeo;     // eyeN, apW, apU, apD
      uniform vec4 uFaceGeo;    // mouthHalfWidth, noseTipNy, browAmount, hooding
      uniform vec4 uSkinCtl;    // stubble, freckleThreshold, bodyHair, seed
      uniform float uSweat, uBodyScale;
      uniform vec3 uSunView, uSunColor;
      uniform float uSunGlow, uTime;

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
    `);

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
        // Same mandibular border rig/Head.ts sculpts — see jawLine() there.
        float jawNy = -0.72 - 0.40 * clamp(hz * 2.4, 0.0, 1.0) + 0.40 * clamp(-hz * 1.6, 0.0, 1.0);

        // 30 repeats per metre of athlete puts one micro-relief cell at 0.7 mm,
        // which is what skin measures. The first pass sampled at 118 — a 0.18 mm
        // cell — which is below a pixel at ANY framing in the shot list, so the
        // detail could only ever alias; that, and not the bake, is where the
        // "woven" look on faces came from.
        float micro = 0.5;
        vec2 poreN = poreTri(bp, bn, 30.0, micro);
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
          + pHead * fr * (0.60 * g1(hy, uFaceGeo.y, 0.11) * g1(axf, 0.0, 0.16)
                        + 0.42 * g1(hy, -0.30, 0.19) * g1(axf, 0.54, 0.22)
                        + 0.26 * g1(hy, -0.90, 0.15) * g1(axf, 0.0, 0.28))
          + pLeg * 0.30 * g1(vLen, 0.545, 0.045)
          + pArm * 0.26 * g1(vLen, 0.569, 0.045), 0.0, 1.0);

        /* ---- vermilion ------------------------------------------------ */
        // Same half-width, same two vermilion centres and the same 1 mm lip
        // line rig/Head.ts sculpts. If these drift apart the lip colour lands
        // on the chin, which is exactly what a "painted on" mouth looks like.
        float mw = uFaceGeo.x;
        float lipX = smoothstep(mw * 1.06, mw * 0.62, axf);
        float lips = clamp(pHead * lipX * clamp(hz * 1.6 - 0.38, 0.0, 1.0)
          * (g1(hy, -0.598, 0.033) + g1(hy, -0.716, 0.040)), 0.0, 1.0);
        // The vermilion BORDER is a pale ridge one millimetre wide, and it is
        // the single feature that makes a mouth read as a mouth rather than as
        // a smear of darker skin.
        float lipBorder = pHead * lipX * fr
          * (g1(hy, -0.563, 0.008) + g1(hy, -0.752, 0.009));
        lips *= 1.0 - 0.80 * g1(hy, -0.655, 0.013);   // the lip line itself is skin

        /* ---- brows, lashes, lid margin -------------------------------- */
        // A brow has a head, a peak and a tail: the medial end sits lower and
        // heavier, the arch crests just outboard of the pupil, the tail drops
        // and thins past the orbital rim. A level band of constant thickness is
        // a stuck-on eyebrow, and the eye names it instantly.
        float bt = clamp((axf - 0.13) / 0.46, 0.0, 1.0);
        float browY = 0.086 + 0.090 * sin(bt * PI) - 0.052 * bt * bt;
        float browTh = 0.048 * (1.0 - 0.38 * bt) * (0.80 + 0.45 * uFaceGeo.z);
        float browMask = pHead * fr
          * smoothstep(0.66, 0.56, axf) * smoothstep(0.095, 0.155, axf)
          * exp(-pow((hy - browY) / browTh, 2.0));
        // Individual hairs, combed outward along the arch rather than sampled
        // from an isotropic follicle field — the isotropic version rendered as
        // dirt thrown at the forehead, which is a fair description of it.
        vec2 bco = vec2(axf * 30.0 + hy * 5.0, (hy - browY) * 260.0);
        float browN = vnoise(bco) * 0.62 + vnoise(bco * 2.7 + 11.0) * 0.38;
        float brow = browMask * mix(0.70, 1.18, smoothstep(0.28, 0.74, browN));

        float ddx = axf - uEyeGeo.x;
        float apV = hy > 0.0 ? uEyeGeo.z : uEyeGeo.w;
        float qq = sqrt(max(0.0, ddx * ddx / (uEyeGeo.y * uEyeGeo.y) + hy * hy / (apV * apV)));
        // Lid margin: a continuous dark line hugging the aperture, heavier
        // above. Broken lashes only read past about 1.5 m; the LINE reads at
        // any distance and it is what stops an eye looking pasted on.
        // NOT named 'margin': three's CSM_FADE block declares a float of that
        // name in the same scope, and the collision only shows up in the game
        // (the preview has no cascades) as a silent shader compile failure.
        float lidLine = pHead * step(0.14, hz) * exp(-pow((qq - 1.02) / 0.10, 2.0));
        float lashDir = vnoise(vec2(atan(hy, ddx) * 44.0, qq * 9.0));
        float lash = lidLine * (hy > 0.0 ? 1.0 : 0.46)
          * mix(0.55, 1.25, smoothstep(0.22, 0.72, lashDir));
        // Upper lashes stand out past the margin, and they splay.
        lash += pHead * step(0.14, hz) * clamp(hy, 0.0, 1.0) * 3.0
          * exp(-pow((qq - 1.18) / 0.10, 2.0)) * smoothstep(0.52, 0.86, lashDir) * 0.55;

        /* ---- facial cavity ---------------------------------------------- */
        // aCrease carries the sculpted folds, but the shadows that actually
        // give a face its VALUE STRUCTURE are broad smooth regions — the orbit,
        // the submalar hollow, the shelf under the nose, the trough under the
        // lower lip, the temple, and above all the submandibular shadow that
        // separates a jaw from a neck. Without them a face at golden hour is a
        // uniform pink field with features drawn on it, which is what every
        // frame in this project rendered up to now: the sculpt was there and
        // the image could not see it.
        float cavity = pHead * clamp(
            0.85 * g1(hy, 0.020, 0.125) * g1(axf, 0.400, 0.210) * fr
          + 0.40 * g1(hy, -0.490, 0.150) * g1(axf, 0.560, 0.200) * fr
          + 0.34 * g1(hy, -0.760, 0.060) * g1(axf, 0.000, 0.250) * fr
          + 0.45 * g1(hy, uFaceGeo.y - 0.085, 0.048) * g1(axf, 0.0, 0.190) * fr
          + 0.30 * g1(hy, 0.440, 0.220) * smoothstep(0.56, 0.86, axf)
          + 0.95 * smoothstep(jawNy + 0.13, jawNy - 0.24, hy), 0.0, 1.0);
        // The top of the neck lives in the jaw's shadow whatever the sun does.
        cavity += pNeck * smoothstep(0.42, 1.0, vLen) * 0.62;
        // …and so does the hollow above the clavicles.
        cavity += pTorso * smoothstep(0.94, 1.0, vLen) * 0.35;
        cavity = clamp(cavity, 0.0, 1.0);

        /* ---- fine wrinkles --------------------------------------------- */
        // Crow's feet fan from the lateral canthus, forehead furrows run across
        // the frontalis, and a short pair of glabellar lines sits between the
        // brows. Every one of these is a THIRD OF A MILLIMETRE deep and two to
        // three millimetres apart — 0.02 of a head unit. Sized like a fold
        // instead of a line they render as claw marks, which is what the first
        // pass did; the amplitudes below are deliberately near the noise floor
        // and only ever read inside about two metres.
        float crowZone = pHead * fr * g1(axf, 0.635, 0.075) * g1(hy, -0.010, 0.085);
        float crowPh = hy * 250.0 + (axf - 0.60) * 95.0;
        float foreZone = pHead * fr * g1(hy, 0.300, 0.115) * smoothstep(0.50, 0.20, axf);
        float forePh = hy * 74.0 + vnoise(vSurfUv * vec2(9.0, 4.0)) * 3.0;
        float glabZone = pHead * fr * g1(hy, 0.175, 0.060) * g1(axf, 0.075, 0.045);
        float glabPh = axf * 300.0;
        float wrinkleN_x = crowZone * cos(crowPh) * 0.55 + glabZone * cos(glabPh) * 0.45;
        float wrinkleN_y = foreZone * cos(forePh) * 0.40 + crowZone * cos(crowPh) * 0.22;
        float wrinkle = clamp(crowZone * (0.5 + 0.5 * sin(crowPh)) * 0.55
          + foreZone * (0.5 + 0.5 * sin(forePh)) * 0.28
          + glabZone * (0.5 + 0.5 * sin(glabPh)) * 0.35, 0.0, 1.0);

        /* ---- stubble --------------------------------------------------- */
        float beardZone = pHead * fr
          * smoothstep(-0.30, -0.44, hy)
          * (1.0 - smoothstep(jawNy + 0.20, jawNy - 0.06, hy))
          * (1.0 - 0.85 * lips)
          * (1.0 - 0.7 * g1(hy, -0.532, 0.05) * g1(hx, 0.0, 0.055));
        // Moustache and chin patch are denser than the cheek.
        beardZone *= 0.72 + 0.5 * g1(hy, -0.552, 0.09) * g1(axf, 0.0, 0.20)
                          + 0.4 * g1(hy, -0.88, 0.13) * g1(axf, 0.0, 0.24);
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
            pHead * fr * (0.95 * g1(hy, 0.52, 0.26) + 0.55 * g1(hy, -0.532, 0.07) * g1(axf, 0.0, 0.22)
                        + 0.40 * g1(hy, -0.20, 0.22) * g1(axf, 0.62, 0.22))
          + pNeck * 0.75 + pTorso * 0.85
          + pArm * smoothstep(0.34, 0.52, vLen) * 0.6, 0.0, 1.0);
        float sweat = sweatZone * uSweat;
        // Beads: a cellular field thresholded so the wet area is patchy, not a
        // uniform gloss. It is the breakup, not the shine, that reads as sweat.
        // Projected, not volumetric: a 2D cellular field is one ninth of the
        // taps and the beads only ever have to be right on the surface. The z
        // shear decorrelates front from back so a chest and a spine do not
        // sweat in the same pattern.
        vec2 bead = mworley(bp.xy * 320.0 + bp.z * 61.0);
        float wetIslands = smoothstep(0.55, 0.16, bead.x) * step(0.30, bead.y);
        float wet = sweat * mix(0.35, 1.0, wetIslands);
      `,
      after: /* glsl */`
        vec3 skin = mix(uTone, uToneTan, expo * 0.85);
        // Perfusion at 0.85 put a sunburn on both cheeks of every athlete. Blood
        // shifts hue; it does not repaint the face.
        skin = mix(skin, uToneFlush, flush * 0.45);
        // Complexion mottle — every real face has it and no rendered one does.
        skin *= 1.0 + (aux.r - 0.5) * 0.16 + (vnoise(vSurfUv * 24.0) - 0.5) * 0.06;
        // Subdermal venous cast on the thin-skinned surfaces.
        float veinZone = pArm * smoothstep(0.60, 0.85, vLen) + pHand * 0.8 + pNeck * 0.4;
        skin = mix(skin, skin * vec3(0.84, 0.93, 1.05), aux.b * veinZone * 0.45);
        // Freckles. Threshold is per-player: most of the roster has none.
        float fk = smoothstep(uSkinCtl.y, uSkinCtl.y + 0.09, aux.g)
          * (pHead * fr * (0.5 + 0.5 * g1(hy, -0.22, 0.34)) + pArm * 0.7 + pTorso * 0.4);
        // Freckles at 0.75 of a hard brown read as grit thrown at the forehead.
        // They are a pigment concentration, not a different material.
        skin = mix(skin, skin * vec3(0.74, 0.60, 0.52), fk * 0.42);
        skin = mix(skin, uToneLip, lips * 0.92);
        // The white roll of the vermilion border, and the fine vertical creases
        // across the lip itself.
        skin *= 1.0 + 0.16 * lipBorder;
        skin *= 1.0 - 0.14 * lips * (0.5 + 0.5 * sin(hx * 640.0 + aux.r * 6.0));
        // Wrinkles darken as well as displace: the crease floor sees less sky.
        skin *= 1.0 - 0.045 * wrinkle;
        // Hair, last, because it sits on top of all of it.
        vec3 hairAlbedo = uHairCol * 0.85;
        skin = mix(skin, hairAlbedo * 0.82, clamp(brow * 1.25 + lash * 1.45, 0.0, 1.0));
        skin = mix(skin, mix(skin, hairAlbedo, 0.62), beard);
        skin = mix(skin, mix(skin, hairAlbedo, 0.45), bhair);
        // Baked cavity. The rig writes it at every fold the sculpt has.
        skin *= 1.0 - 0.38 * vCrease;
        skin *= 1.0 - 0.15 * cavity;
        // Wet skin is darker: the water film removes the air/keratin interface.
        skin *= 1.0 - 0.16 * wet;

        // TEMP-DEBUG-BANDS
        if (pHead > 0.5) {
          if (abs(hy - 0.0) < 0.012) skin = vec3(1.0, 0.0, 0.0);
          else if (abs(hy + 0.465) < 0.012) skin = vec3(0.0, 1.0, 0.0);
          else if (abs(hy + 0.655) < 0.012) skin = vec3(0.0, 0.3, 1.0);
          else if (abs(hy + 0.900) < 0.012) skin = vec3(1.0, 1.0, 0.0);
          else if (abs(hy - 0.440) < 0.012) skin = vec3(1.0, 0.0, 1.0);
        }
        diffuseColor.rgb *= skin;

        gSss = uSss;
        // Red wraps furthest because it is the least absorbed in the dermis; this
        // ratio is the whole reason a terminator on skin goes orange.
        gWrap = vec3(0.42, 0.20, 0.11) * mix(1.0, 0.55, expo * 0.5);
        gThin = clamp(0.08 + pEar * 0.62 + isPart(P_FINGER) * 0.42 + pNeck * 0.14
          + pHead * fr * (0.70 * g1(hy, -0.44, 0.10) * g1(axf, 0.0, 0.24)
                        + 0.30 * g1(hy, -0.90, 0.14) * g1(axf, 0.0, 0.26)), 0.0, 1.0);
        gTrans = 1.0;
      `,
    });

    /* ------------------------------------------------------- roughness */
    sh.fragmentShader = at(sh.fragmentShader, 'roughnessmap_fragment', {
      after: /* glsl */`
        // A forehead is oilier than a cheek and a nose tip is oilier than
        // either; the malar flat and the upper lip are the two matte islands.
        // One roughness across a face is the loudest "3D model" cue there is.
        float rgh = 0.545;
        rgh += pHead * fr * (-0.165 * g1(hy, 0.44, 0.26)
                             -0.195 * g1(hy, uFaceGeo.y, 0.10) * g1(axf, 0.0, 0.15)
                             -0.080 * g1(hy, -0.532, 0.06) * g1(axf, 0.0, 0.13)
                             +0.085 * g1(hy, -0.26, 0.20) * g1(axf, 0.56, 0.24)
                             -0.070 * g1(hy, -0.06, 0.14) * g1(axf, 0.42, 0.20)
                             +0.060 * g1(hy, -0.90, 0.14) * g1(axf, 0.0, 0.24));
        rgh -= lips * 0.24 + lipBorder * 0.05;
        rgh += wrinkle * 0.08;
        rgh += beard * 0.16 + bhair * 0.10 + brow * 0.12 + lash * 0.10;
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
          // A finer octave, but retired as soon as one cell falls under a
          // pixel — past that point it contributes noise, never structure.
          vec2 sub = poreTri(bp, bn, 76.0, m2);
          float px = max(fwidth(bp.x), fwidth(bp.y)) * 76.0;
          fine += sub * 0.55 * (1.0 - smoothstep(0.25, 0.75, px));` : ''}
          // Hair sits proud of the skin; brows and stubble have to disturb the
          // surface or they read as a decal printed on a smooth face.
          float hairBump = brow * 0.9 + beard * 0.7 + bhair * 0.5 + lash * 0.8;
          fine += (mhash22(vSurfUv * vec2(700.0, 260.0)) - 0.5) * hairBump * 1.6;
          // Wrinkles are a gradient, not a hash: a crease has a direction and
          // the light has to run across it, not sparkle in it.
          fine += vec2(wrinkleN_x, wrinkleN_y) * 0.16;
          // Beads stand up off the surface where the film has broken.
          fine += (mhash22(bp.xy * 300.0) - 0.5) * wet * wetIslands * 1.1;
          vec3 mapN = vec3(fine * 1.22, 1.0);
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
            * mix(diffuseColor.rgb, gSss * 0.9, 0.65) * 0.80;
          // Skin's diffuse albedo is dominated by MULTIPLE scattering, and
          // multiple scattering is red: sky light that goes in blue comes back
          // out warm. Without this the shadow side of every face at golden hour
          // is a neutral blue-grey mask — which is exactly what the closeup
          // rendered, and it is the single loudest failure at that crop, well
          // ahead of anything in the sculpt. gSss is normalised to unit
          // luminance in Tone.ts, so this rotates hue and costs no brightness.
          reflectedLight.indirectDiffuse *= mix(vec3(1.0), gSss, 0.50);
          // Sky occlusion. It is the indirect term this has to cut: the key is
          // already directional, so darkening the direct light as well would
          // just flatten the terminator it is meant to be shaping.
          reflectedLight.indirectDiffuse *= 1.0 - 0.62 * cavity;
          reflectedLight.indirectSpecular *= 1.0 - 0.55 * cavity;
          // The rig's baked cavity term stands in for an AO map.
          reflectedLight.indirectDiffuse *= 1.0 - 0.66 * vCrease;
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
