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

/**
 * MEASUREMENT HATCH. Flip to 1 and re-capture to paint the three regions flat —
 * then run `python3 tools/_eyecheck.py <shaded.png> <mask.png>`, which uses that
 * frame as a pixel-aligned stencil over the shaded one and prints every number
 * in section 4 of docs/face-direction.md. Erode the stencil by a pixel before
 * you believe a hot-pixel count: the hatch blooms about that far past the
 * geometry and the ring it adds is lid-margin skin, the brightest skin on the
 * face.
 * pupil red, iris green, sclera blue — so the aperture can be counted in pixels
 * off the delivered frame instead of estimated by eye. The whole reason six
 * rounds of face work landed invisible on this project is that nobody measured
 * what fraction of the frame their change actually covered; this is four lines
 * and it turns "the iris looks small" into "the iris is 19 % of the aperture".
 * MUST ship as 0.
 */
const DEBUG_MASK: number = 0;

export function makeEyeMaterial(i: EyeInputs): EyeMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.30,
    metalness: 0,
    // The tear film. Gated to the cornea in the shader below (material.clearcoat
    // *= cornea) — on a whole globe it is the quarter-ball specular smear the
    // face brief opens by measuring, and three's clearcoat bypasses every
    // occlusion written against reflectedLight, so it has to be stopped here.
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
        //
        // PUPILLARY-ZONE GAIN, and it is a level control, not a detail control.
        // The brief's licence for it is explicit: at 10-16 px nobody sees crypts,
        // they see the ring's MEAN, and that mean has to land 0.45-0.65x the
        // cheek so the eye reads as three values instead of two. Measured on the
        // delivered closeup the iris came back 0.52x on the shadow-side eye and
        // 0.38x on the lit-side one, i.e. the lit eye was fusing with its own
        // pupil into one dark bead. 1.32 -> 1.62 on the inner zone and a wider
        // lift across the whole disc is the cheapest thing that moves it.
        float coll = smoothstep(0.30, 0.44, r);
        vec3 c = mix(uStroma * 1.62 + vec3(0.026, 0.018, 0.010),
                     uStroma * 1.18, coll);
        // Fibre contrast is a function of pigment: a blue iris is almost all
        // structure, a deep brown one is almost all absorber.
        c *= mix(1.0, mix(0.58, 1.42, fib), uIrisCtl.z);
        c = mix(c, c * 0.40 + uPosterior * 0.45, crypt * 0.85);
        // Pigment ruff — the posterior epithelium curling forward at the margin.
        c = mix(c, uPosterior * 1.7, (1.0 - smoothstep(0.0, 0.16, r)) * 0.50);
        // Limbal ring. Narrow, deep, and worth more than any other single detail
        // on the whole eye — but "narrow" is the load-bearing word and it was
        // not narrow. Starting at 0.80 of the radius it ate the outer 36 % of
        // the disc's AREA at up to 0.82, which at a 15 px iris is a 1.5 px black
        // annulus dragging the ring's mean down by a fifth and fusing the iris
        // edge into the lash line. Moved out to 0.88 and softened: same read at
        // this framing, a third of the area, and the iris keeps its midtone.
        c *= 1.0 - 0.62 * smoothstep(0.88, 1.0, r);
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

        // THE CORNEA, as a mask, because the clearcoat is only allowed to touch
        // this. A cornea is 11.7 mm across on a 24 mm globe and it STOPS at the
        // limbus; outside it the globe is conjunctiva over sclera — wet, but a
        // wet membrane, not a lens. Wetting the whole ball with a mirror-smooth
        // coat is what the brief measured as "the wet dot has become a wet bar".
        // It ends AT the limbus and feathers INWARD, not outward. A first pass
        // let it run to 1.20 irisR "so the coat feathers out on the limbal ring",
        // and that annulus is sclera: it handed a 3 x 10 px strip of conjuctiva
        // full corneal specular and drew a bright vertical bar down the nasal
        // edge of the iris that carried all sixteen of the eye's over-1.3x
        // pixels on its own. The tear film outside the limbus is a film on a
        // membrane; the lens stops where the iris does.
        float cornea = 1.0 - smoothstep(irisR * 0.86, irisR * 1.00, sr);
      `,
      after: /* glsl */`
        /* ---- sclera ----------------------------------------------------- */
        // Never white. A warm, slightly yellow grey, darker toward both canthi
        // where the conjunctiva thickens and the lids shade it.
        //
        // THIS CONSTANT HAS BEEN THE WRONG KNOB THREE TIMES. The comment stack
        // this replaces recorded it being walked down 0.50 -> 0.395 -> 0.315,
        // each time because "the two scleras were the brightest pixels in the
        // frame", and each time the frame got no better. It was never the
        // albedo. Ablating one term at a time against the delivered closeup
        // (shots/eyes-abl-dir, -sss, -diff, all measured with tools/_eyecheck.py)
        // splits the delivered sclera at 1.53x cheek mean into:
        //
        //     additive "sss" glow   +0.60x    <- one line, below, unoccluded
        //     indirect diffuse      +0.48x
        //     direct diffuse        +0.42x    <- unoccluded by the socket
        //     all specular + coat   +0.04x    <- the thing everyone blamed
        //
        // Three fifths of it was a flat emissive proportional to uSunGlow and to
        // nothing else: not shadowed, not occluded, not even attenuated by which
        // side of the face it was on, which is why it hurt the SHADOW-side eye
        // worst of the two. Every round that answered it by cutting the albedo
        // was trading a real material property against a bug, and the eye went
        // muddy and stayed bright.
        //
        // With the glow gone and the socket occluding direct light as well as
        // ambient, this can go back to something a sclera actually measures.
        // Bulbar conjunctiva over sclera is white-ish tissue; 0.52 is inside the
        // published range and it is now the ONLY term setting the level, which
        // is what makes it tunable at all.
        vec3 sclera = vec3(0.960, 0.893, 0.822);
        float toCanthus = smoothstep(0.24, 0.80, abs(lp.x));
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
        // THE LIMBAL CONTACT SHADOW, and it is the term that was making one
        // crescent carry the whole 1.3x overshoot. Everything above darkens the
        // sclera as sr GROWS, so the albedo maximum sat in the annulus
        // immediately outside the limbus — which is also where the lambertian
        // maximum sits, because that is the part of the globe pointing most
        // nearly at the key. Two maxima on the same forty pixels is what the
        // brief measured as a bar. Anatomically the rim outside the limbus is
        // the LAST place a sclera is bright: the cornea stands 0.5 mm proud of
        // the globe there and the tear meniscus banks up against its edge, so
        // that ring is in the cornea's own contact shadow. Darkening it costs
        // nothing anywhere else because it is gone by sr = 1.55 irisR.
        sclera *= 1.0 - 0.40 * (1.0 - smoothstep(irisR * 1.00, irisR * 1.75, sr));

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
        //
        // RE-LEVELLED FOR THE NEW APERTURE. These ramps were fitted against the
        // old lidless mapping, where apU was er*(0.34 + 0.34*eyeOpen) and the
        // visible globe ran to lp.y = +0.67. rig/Head.ts now ships
        // er*(0.18 + 0.10*eyeOpen), so the highest sclera a viewer can see sits
        // at lp.y ≈ +0.28 and the ramp's top half — everything from 0.28 to
        // 0.40 — was being spent on geometry behind the lid. Measured against
        // the delivered frame the old ramp only reached 0.86 of its own range
        // inside the aperture; the shadow the upper lid casts was being applied
        // at seven eighths strength to the one band that needed all of it.
        // Re-mapped onto what is actually on screen: -0.30 to +0.28 up,
        // -0.04 to -0.36 down.
        float lidUp = smoothstep(-0.30, 0.28, lp.y);
        float lidLo = smoothstep(-0.04, 0.36, -lp.y);
        float lidTint = clamp(1.0 - 0.28 * lidUp - 0.18 * lidLo, 0.40, 1.0);
        float lidAo = clamp(1.0 - 0.58 * lidUp - 0.44 * lidLo, 0.20, 1.0);

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

    // The globe is a sphere everywhere except over the iris, where the corneal
    // cap is a tighter one. That difference is the whole optics of a catchlight.
    sh.fragmentShader = at(sh.fragmentShader, 'normal_fragment_maps', {
      replace: /* glsl */`
        {
          // THE CORNEA IS A TIGHTER SPHERE THAN THE GLOBE IT SITS ON: 7.8 mm of
          // radius against 12, so its normal turns about 1.5x faster than the
          // eyeball's does. That ratio is the whole reason a real eye shows a
          // catchlight from almost anywhere — the corneal cap sweeps its mirror
          // direction across a wide cone, so SOME point on it is always aimed at
          // the key. At 0.16 this was a token camber on a plain sphere, and with
          // the gaze off-axis the mirror point simply missed the cornea and both
          // eyes rendered with no catchlight at all: nothing on either globe came
          // within a third of clipping. 0.54 is the real curvature ratio, and it
          // is confined to the corneal disc, because outside the limbus the
          // sclera really is the globe's own radius.
          float camber = smoothstep(irisR * 1.10, irisR * 0.30, sr);
          normal = normalize(normal + (Rr * surf.x + Uu * surf.y) * camber * 0.54);
        }
      `,
    });

    /**
     * THE CLEARCOAT IS THE WHOLE BUG, AND IT WAS NEVER BEING OCCLUDED.
     *
     * three's clearcoat does not accumulate into `reflectedLight`. It has its
     * own pair of file-scope globals, clearcoatSpecularDirect and
     * clearcoatSpecularIndirect, which meshphysical.glsl adds to outgoingLight
     * at the very end, gated only by material.clearcoat. So
     * every one of the socket occlusions below — all of them written against
     * reflectedLight.*, all of them correct — was multiplying terms that were
     * not the bright ones. A mirror-smooth coat over the entire globe kept
     * reflecting a full sky hemisphere at full strength through all of it. That
     * is the quarter-globe specular smear, and no amount of albedo work could
     * ever have reached it.
     *
     * Two changes, and they are the only two that move a section-4 number:
     * gate the coat to the cornea (material.clearcoat *= cornea), and cut its
     * ENV term hard while leaving its SUN term alone. The sun term is the
     * catchlight and it is supposed to clip; the env term is a lens mirroring
     * the sky and it has no business being on an eye at all at this size.
     */
    sh.fragmentShader = at(sh.fragmentShader, 'lights_physical_fragment', {
      after: /* glsl */`
        #ifdef USE_CLEARCOAT
          material.clearcoat *= cornea;
          // Assigned, not scaled, because three adds geometryRoughness into
          // clearcoatRoughness and on a globe eight pixels across that term is
          // an order of magnitude larger than the tear film's own roughness —
          // it is what spread the highlight into a bar. The catchlight has to
          // be 1-2 px at 1.74 px/mm, so the lobe has to stay near-specular
          // whatever the screen-space curvature says.
          material.clearcoatRoughness = 0.052;
        #endif
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'lights_fragment_end', {
      after: /* glsl */`
        {
          // THE SUN IS THE THING A BROW BLOCKS, AND IT WAS THE ONE TERM NOTHING
          // HERE OCCLUDED. Every line in this block used to act on ambient and
          // specular only; reflectedLight.directDiffuse reached the globe at
          // full strength. A sphere under an unoccluded key has a lit side, and
          // on the delivered frame that lit side measured 1.92x cheek mean at
          // peak against a 0.42x mean over the same sclera — a 4.5:1 range on a
          // material the brief caps at 1.3:1. That ratio IS the ping-pong ball,
          // and no albedo can fix a ratio.
          //
          // A globe sits at the bottom of a bony orbit under a brow ridge, with
          // a high key. What lands on exposed sclera is very nearly all bounce.
          // The cornea is the exception — it stands 0.5 mm proud of the lid
          // margins, which is exactly why the catchlight lives there and why it
          // is the only part of the eye allowed to be bright.
          //
          // CANTHAL OCCLUSION, and it is the term that finally kills the bar.
          // Both corners of the aperture are pockets: the medial one is closed
          // off by the caruncle, the plica and the bridge of the nose, the
          // lateral one by the orbital rim. Neither sees the key. Without it the
          // globe just shows its lit side like any other sphere, and on the
          // delivered frame that lit side was the four nasal-most pixels of each
          // aperture at 1.54x cheek mean — one bright vertical bar per eye,
          // 3 px wide and 10 px tall, carrying every remaining over-1.3x pixel
          // between them. toCanthus is already computed for the albedo; the
          // occlusion is the same geometry and it was only ever half applied.
          // Irradiance probe, taken BEFORE any of the occlusions below, because
          // the tear meniscus stands at the lid margin and is the least occluded
          // thing on the eye. Dividing the lambertian term by its own albedo
          // leaves E·N·L/PI at this fragment with the shadow map already in it,
          // which is what lets the catchlight further down inherit the shadow,
          // the sun's colour and the sky, without being an emissive.
          vec3 lit = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse * 0.9;
          vec3 wet = min(lit / max(diffuseColor.rgb, vec3(0.02)), vec3(6.0));

          float canthalAo = 1.0 - 0.86 * toCanthus;
          //
          // APERTURE DEPTH, and this is the term that sets the sclera's dynamic
          // range. A palpebral fissure is a SLIT over a ball: the further a point
          // sits around the globe from the corneal apex, the more lid rim stands
          // between it and the sky, and by the silhouette it sees almost nothing.
          // It matters because its shape is the only one that matches the
          // lambertian gradient it has to cancel — the sun's bright side of the
          // globe always lands at high sr, because low sr is the bit aimed at the
          // camera. Everything else here occludes by lid height or by canthus and
          // leaves a rim; measured, the last over-1.3x pixels on the eye sat at
          // sr 0.70-0.85 in two clusters, one nasal and one on the lower margin.
          float aperAo = 1.0 - 0.80 * smoothstep(0.50, 0.98, sr);
          float keyAo = lidAo * canthalAo * aperAo * mix(0.34, 0.80, cornea);

          reflectedLight.directDiffuse *= keyAo;
          // A globe in a socket sees maybe half the sky, and the specular has
          // to be occluded with the diffuse or the tear film keeps mirroring a
          // full hemisphere. Skipping this is why two white bars stayed the
          // brightest thing on a shadowed face at broadcast range.
          reflectedLight.indirectDiffuse *= lidAo * (1.0 - 0.34 * toCanthus)
            * (0.26 + 0.74 * aperAo);
          // RE-CHROMATISE THE AMBIENT. Everything that reaches the inside of a
          // socket has bounced off lid skin, brow and caruncle a millimetre away
          // first, so it arrives warm. A globe with a clear line of sight to the
          // whole environment instead picks up the environment, and this
          // environment is a green pitch under a blue sky: with the old additive
          // glow removed the sclera measured RGB (52, 63, 61) off the delivered
          // frame — green-dominant, colder than the cheek beside it — because
          // that glow was tinted (1.0, 0.86, 0.78) and had been doing the white
          // balance by accident for six rounds.
          //
          // Written as a chromatic rotation at CONSTANT LUMINANCE, so it cannot
          // move a single section-4 number and cannot be used to smuggle a level
          // change past the checker; it exists purely for the thing the numbers
          // are blind to.
          {
            const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
            // Lid-bounce chromaticity, normalised to unit luminance.
            const vec3 SOCKET = vec3(1.20, 0.98, 0.83) / 1.01594;
            vec3 id = reflectedLight.indirectDiffuse;
            reflectedLight.indirectDiffuse = mix(id, dot(id, LW) * SOCKET, 0.80);
          }
          // The tear film on exposed sclera is real but it is not a mirror.
          // Off the cornea this contributes ~0 and the roughness ramp carries
          // the wetness on its own.
          reflectedLight.indirectSpecular *= (0.05 + 0.14 * cornea) * lidAo;
          // The catchlight is the point of the whole material and it lives on
          // the cornea, which is the LEAST occluded part of the globe — it is
          // the bit that stands proud of the lids. Occluding it with the sclera
          // is what turns a wet eye into a matte bead.
          reflectedLight.directSpecular *= mix(0.04, 0.18, cornea);

          /* ---- ONE CATCHLIGHT, AND IT IS PLACED --------------------------- */
          // Everything above is subtraction, and subtraction alone gives a dead
          // eye. The brief asks for exactly one wet dot per eye: <= 3 px at this
          // framing, allowed to clip, upper quadrant of the iris.
          //
          // It cannot be left to the clearcoat to find. A globe plus a corneal
          // cap has ONE mirror point for a given key, and with the gaze off-axis
          // — which it is on this tableau, and which the brief books as an
          // Animator job, not a material one — that point misses the cornea
          // entirely: measured on the delivered frame, nothing on either globe
          // came within a third of clipping.
          //
          // What a real eye has that this model does not is the superior tear
          // MENISCUS: a wedge of tears held by surface tension in the angle
          // between the upper lid margin and the globe. It is a cylindrical lens
          // a third of a millimetre across whose normal sweeps the entire
          // vertical range, so it catches a top key from very nearly any camera
          // angle, and it is why the catchlight in every portrait ever taken
          // sits in the upper quadrant rather than wherever the geometry says.
          // Modelling that wedge as geometry at 3 px is not on; placing the dot
          // it produces is.
          //
          // It is expressed as a GAIN ON THE IRRADIANCE THAT ACTUALLY ARRIVED,
          // not as an emissive, which is the whole lesson of the term this file
          // just deleted: dividing the lambertian out by its own albedo leaves
          // E·N·L/PI at this fragment, shadow map included, so the dot dies when
          // the athlete runs into shade and takes the sun's colour when he does
          // not. It also costs nothing when the key is behind the head.
          vec2 q = surf / max(irisR, 1e-4);
          vec2 clPos = vec2(clamp(dot(uSunView, Rr) * 0.80, -0.42, 0.42),
                            0.30 + 0.22 * clamp(dot(uSunView, Uu), 0.0, 1.0));
          // The key's position only STEERS the dot; it never gates it away. A
          // hard front-facing gate is what made the first version of this term
          // invisible on both eyes: on this tableau the head is turned far
          // enough that dot(uSunView, A) is negative, so a plain
          // smoothstep(-0.05, 0.30, ...) evaluated to zero and the whole term
          // did nothing — exactly the class of bug this round exists to stop
          // shipping. A backlit eye still mirrors the sky in front of it, and
          // the wet term above already carries the ambient, so the floor is 0.55.
          float front = smoothstep(-0.60, 0.05, dot(uSunView, A));
          // 0.095 iris radii of core with a 0.03 shoulder. The iris is 15 px
          // across at the closeup framing, so an iris radius is 7.5 px and this
          // is a 1.4 px disc — a real 0.5-1 mm catchlight is 1-2 px here. The
          // gain is set so the core clips and the shoulder does not, because
          // every pixel of shoulder over 1.3x cheek spends the aperture's
          // twelve-pixel budget on halo instead of on a highlight: at 0.115 and
          // a gain of 3.2 the dot was 2 px and its halo was another 3.
          float catch1 = smoothstep(0.095, 0.030, length(q - clPos))
            * cornea * mix(0.55, 1.0, front);
          // Sun AND sky. A meniscus in open shade still mirrors the brightest
          // thing in front of it, which is why an eye on the shadow side of a
          // face keeps its catchlight and only loses its warmth — and one of the
          // two eyes in this tableau is on the shadow side, so a sun-only term
          // would give that athlete one live eye and one dead one.
          reflectedLight.directSpecular += wet * catch1 * 3.8;

          #ifdef USE_CLEARCOAT
            // The env half of the tear film. A cornea at the bottom of a socket
            // sees a letterbox of sky between two lids, not a hemisphere, and
            // what it does see is 20 m of stadium roof and crowd, not the sun.
            clearcoatSpecularIndirect *= 0.06 * lidAo;
            // The sun half IS the catchlight. Left at strength, occluded only
            // as much as the lids actually occlude it.
            clearcoatSpecularDirect *= 0.55 + 0.45 * lidAo;
          #endif
        }
      `,
    });

    if (DEBUG_MASK) {
      sh.fragmentShader = at(sh.fragmentShader, 'dithering_fragment', {
        after: /* glsl */`
          float mIr = limbus;
          float mPu = pupil * limbus;
          gl_FragColor = vec4(
            mPu > 0.5 ? 0.8 : 0.0,
            (mIr > 0.5 && mPu <= 0.5) ? 0.8 : 0.0,
            mIr <= 0.5 ? 0.8 : 0.0, 1.0);
        `,
      });
    }
  });

  m.customProgramCacheKey = () => `ult.eyes.${i.quality}`;
  m.needsUpdate = true;

  return { material: m, setDilation(v: number) { u.uDilate.value = v; } };
}
