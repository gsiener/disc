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
  // The value governor in the fragment shader keys off this number, and a
  // governor you cannot read is a governor you cannot calibrate: the first
  // attempt was tuned against an ESTIMATED pigment luminance for the closeup
  // hero and moved the cap the wrong way, because the estimate was 0.27 and the
  // athlete is 0.13. Parked on userData so the capture probes can print it
  // beside the measured cap mean. Costs nothing and ships harmlessly.
  const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const pigL = Math.max(lum(i.colour.root), 0.004);

  /**
   * VALUE GOVERNOR — the cap's rendered luminance against the forehead under it.
   *
   * Section 4.7 asks for 0.8-1.3x the same-side forehead. That is a 1.6x window,
   * and `Tone.ts` hands this material a roster spanning 0.018 to 0.230 in root
   * luminance — 12x. Nothing in the shader closes that on its own, and measured
   * it does not: the blond closeup hero rendered 1.26x his shadow-side forehead
   * while the brown-haired seed-7 athlete rendered 0.73x, i.e. one athlete over
   * the ceiling and the other under the floor on the same frame.
   *
   * Fitted, not guessed, on those two measurements — cap mean tracks pigment as
   * roughly a 0.49 power, so the correcting gain is a 0.31 power the other way.
   * Applied as a single scale on the material's outgoing radiance rather than on
   * the albedo, because the albedo is not where a hair cap's value lives:
   * ablated on this build, `material.color` black moves a blond cap only from
   * 0.371 to 0.312 (16 %) and killing the sheen BRDF moves it 1 %. The rest is
   * the two fibre lobes and the backlit rim. Scaling the albedo by 1.43 moved
   * the acceptance ratio by 3 %; scaling the radiance moves it by 43 %, and
   * leaves every lobe's shape, shift, exponent and weight exactly as frozen.
   *
   * RE-FIT. 0.3565 p^-0.3104 was fitted before the backlit rim became an edge
   * term and before the face-on transmission below existed, and both moved the
   * response it was fitted to. Re-measured end to end on the same two athletes,
   * hair mean over SAME-SIDE forehead (shadow / lit), which is the unit section
   * 4.7 is stated in:
   *
   *     seed 0  pigL 0.0483  gain 0.913   1.047 / 0.888
   *     seed 7  pigL 0.0185  gain 1.231   0.937 / 0.805   <- lit side on the floor
   *
   * The exponent, not the coefficient, was wrong: a dark pigment loses more of
   * the window than a 0.31 power returns, because what a dark cap is missing is
   * the DIFFUSE path and that is the path pigment scales linearly. Two points,
   * solved for the gain that puts both athletes at 0.95-1.0 on both sides, give
   * 0.2367 p^-0.4454. The ceiling goes 1.45 -> 1.55 because the old one bound at
   * pigL 0.026 and a third of the roster is darker than that, which quietly made
   * the governor a constant for every black-haired athlete on the pitch.
   */
  const valueGain = Math.min(1.55, Math.max(0.55, 0.2367 * Math.pow(pigL, -0.4454)));
  m.userData.hairPigL = pigL;
  m.userData.hairSheenL = lum(i.colour.sheen);
  m.userData.hairValueGain = valueGain;

  const u = {
    uStrand: { value: i.detail.strand },
    uGrunge: { value: i.detail.grunge },
    uRoot: { value: i.colour.root },
    uTip: { value: i.colour.tip },
    uSheen: { value: i.colour.sheen },
    uHairCtl: { value: new THREE.Vector4(i.colour.scatter, i.colour.grey, (i.seed % 733) / 733, i.bulk) },
    uStrandRep: { value: new THREE.Vector2(su, sv) },
    uWet: { value: 0 },
    uValue: { value: valueGain },
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
      uniform float uValue;
      uniform vec3 uSunView, uSunColor;
      uniform float uSunGlow, uTime;

      // Written per fragment, read by the fibre lighting model.
      vec3 gTan = vec3(0.0, 1.0, 0.0);
      vec3 gSheen = vec3(1.0);
      float gShift = 0.0;
      float gGloss = 1.0;
      // How much of the surrounding hair mass is in the way. 1 = an outermost
      // fibre with the whole sky on it, 0 = buried. Written with the albedo and
      // read by every lighting term below, because occlusion is not a property
      // of the diffuse lobe.
      float gOcc = 1.0;
      // Occlusion for the one path that crosses the mass TWICE — the backlit
      // halo. See the block that writes it.
      float gHalo = 1.0;
      // Hue of this fragment's pigment at unit luminance. Read by the face-on
      // transmission term so that the energy which brings a 0.048-albedo cap up
      // to the brief's 0.8x-forehead window arrives HAIR-COLOURED instead of
      // sheen-coloured. See the block that writes it.
      vec3 gTrans = vec3(1.0);
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
        // ------------------------------------------------------- TOOTH FIELD
        // Where THIS column of hair ends, and therefore the whole shape of the
        // fringe. Piecewise constant in u and constant down v, because that is
        // what a comb is: a tooth has ONE length over its whole width.
        //
        // MEASURED, WITH THE SHELL RENDERED TWICE (alphaTest 0.42 vs 0). The
        // field this replaces was floor(huv.x * uStrandRep.x * 1.9), i.e. 494
        // cells round the azimuth. One unit of huv.x is ~1005 px at the front
        // of the head on the portrait framing, so those cells were 2.0 px wide
        // and the map term stacked on top of them ran at 117 repeats through a
        // mip chain that returns its mean. That is not a comb, it is a DITHER:
        // it removed 821 px spread along the boundary as salt-and-pepper, and
        // because a stray survivor anchors the column, 83 % of fringe columns
        // measured ZERO erosion depth on the delivered seed and 56 % on seed 7.
        // Six px of alpha noise on a boundary reads as fray, not as hair, and
        // the ruled line the brief complains about was still there underneath.
        //
        // 156 teeth round the full azimuth is ~6.4 px at the front of the head
        // at this framing and ~4 px by the temples, which is a lock. The rate
        // is fixed per AZIMUTH and not per uStrandRep, so a buzz (320 strands)
        // and a long (165) get the same size of tooth — the previous coupling
        // made the fringe twice as fine on a shaved head as on a curtain, which
        // is backwards and, worse, made the erosion depth style-dependent.
        float toothU = huv.x * 156.0;
        // A TOOTH IS A SCREEN-SPACE OBJECT, so the comb mips. huv.x is azimuth
        // and azimuth compresses to nothing at the silhouette: measured, the
        // teeth ran 6.4 px at the front of the head and under a pixel by the
        // outer 18 columns of the cap on each side, which retired the erosion
        // there and left 14 % of fringe columns cut ZERO. Merging teeth in
        // powers of two as they go sub-pixel keeps one tooth at 3-6 px of
        // screen at EVERY framing, so the same comb survives from the portrait
        // to the endzone head instead of being gated off exactly where the
        // brief asks for a hairline. Nested by construction, so a merged tooth
        // is the union of the two it replaces and the pattern does not swim.
        float toothPx = fwidth(toothU);
        float lod = clamp(exp2(floor(log2(max(toothPx * 3.2, 1.0)))), 1.0, 64.0);
        float tH = mhash12(vec2(floor(toothU / lod), 3.0 + floor(uHairCtl.z * 61.0)));
        // Teeth do not end independently: hair falls in locks and a lock ends
        // together. Sampled on the unit CIRCLE so the field is periodic in the
        // azimuth by construction — a tiled 1-D noise seams at u = 0, which on
        // this cap is the front midline, i.e. the one place a seam becomes a
        // parting down the middle of the forehead.
        float haz = huv.x * 6.2831853;
        float clumpH = vnoise3(vec3(cos(haz), sin(haz), 0.0) * 3.3 + uHairCtl.z * 17.0);
        // THE COMB HAS TO COMB. Counted off the delivered frame, per column,
        // across the whole 220 px hairline: erosion depth ran 4-9 px and passed
        // the 4-10 px window on 90 % of columns, and adjacent columns differed
        // by a mean of 0.57 px with only 3.2 % of neighbours differing by 3 px
        // or more. That is not a fringe, it is the ruled line the brief
        // complains about, moved 7 px up the forehead — and the acceptance
        // number that was meant to catch it (a per-column DEPTH window) cannot,
        // because a constant offset sits in the middle of the window.
        //
        // The amplitude was the whole of it. sLen weighted the per-tooth hash
        // 0.58 against a smooth clump field at 0.42, and the depth range it
        // drove was 0.030 of vLen = 4.8 px; a uniform hash differs between
        // neighbours by a third of its range, so tooth-to-tooth serration was
        // 0.58 * 4.8 / 3 = 0.93 px against a 6.4 px tooth. Weighting the hash
        // 0.80 over a range that fills the window end to end takes the same
        // statistic to ~1.6 px, which at a 6.4 px tooth is a visible sawtooth.
        // The clump stays in at 0.20 — locks do hang together — but it can no
        // longer set the depth on its own, which is what made the cut smooth.
        float sLen = clamp(tH * 0.80 + clumpH * 0.20, 0.0, 1.0);

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

        // How many strand-map repeats one pixel spans. Everything sampled on
        // suv is under a pixel wide on the hero crop (0.3 repeats/px against a
        // 256-texel map is 78 texels per pixel), so it is the mip chain, not the
        // pattern, that decides what those samples return.
        float strandPx = max(fwidth(suv.x), fwidth(suv.y));

        // ------------------------------------------------------------ LOCK FIELD
        // Every band above this line varies at 2-3 px on the hero crop. Measured
        // on shots/hair: the clump sample sc sits at suv * 0.16, which is 35
        // repeats of a 9-cell field, i.e. 317 cells round the azimuth and 2.3 px
        // apiece — a tenth of the size its own comment claims. A field at the
        // pixel grid does two bad things at once: it averages to a flat tone, so
        // the cap has no macro value, and because the map is TILED an integer
        // number of times over a surface of revolution it is exactly periodic in
        // u, which is the vertical corduroy the review read at 3-4 px pitch.
        //
        // What an eye reads on a head of hair is the LOCK: a 15-25 mm rope that
        // shadows its neighbours. That is 15-30 px at the portrait framing and
        // it is the only band the macro-value test can see.
        //
        // Sampled on the BIND NORMAL rather than on uv. uv.x wraps at the front
        // midline and any tiled 2-D field seams there; a 3-D field on the unit
        // normal is seamless by construction, is not periodic, and therefore
        // cannot beat against the shell's lat-long columns. Squashed in y
        // because a lock is several times longer than it is wide.
        vec3 lockP = vec3(vBindN.x, vBindN.y * 0.58, vBindN.z);
        float lockPh = uHairCtl.z * 37.0;
        float lockV = clamp(vnoise3(lockP * 4.4 + lockPh) * 0.63
                          + vnoise3(lockP * 9.6 + lockPh * 0.61 + 19.0) * 0.37, 0.0, 1.0);
      `,
      after: /* glsl */`
        // ON A CAP, vLen IS NOT ROOT-TO-TIP. It is hairline-to-crown, and the
        // strand at the crown has its root under it exactly like the strand at
        // the temple does — what varies along it is how much sun the lock has
        // had, not which end of the fibre you are looking at. Ramping to the
        // FULL bleached tip colour at the crown therefore painted every athlete
        // a two-tone dome with a cream skullcap on top, which is most of what
        // read as "a mask over a lighter skull": the skull was the hair. A card
        // (ponytail, curtain) does run root-to-tip and gives up a little of its
        // bleach here, which is the cheaper of the two errors by a long way.
        vec3 base = mix(uRoot, uTip, clamp(tip * 0.70 - 0.06, 0.0, 1.0));
        base *= strandVal;
        base = mix(base, vec3(0.42, 0.41, 0.40), grey * 0.9);

        // ------------------------------------------------------ VALUE GOVERNOR
        // The acceptance number is a RATIO to the forehead the cap sits on, and
        // Tone.ts spans 0.03 linear (black) to 0.40 (blond) — a 13x pigment
        // range against a 1.6x acceptance window. Measured on the two test
        // seeds with the shipped lighting: the blond hero lands at 1.03x his
        // forehead (inside 0.8-1.3) and the brown-haired seed-7 athlete at
        // 0.738x (outside, and it reads as a dark helmet rather than as hair).
        //
        // The correction is uValue, computed on the CPU from the pigment and
        // applied to the whole of this material's outgoing radiance at the
        // bottom of the shader — see the makeHairMaterial comment for the fit.
        // It is NOT applied here, on the albedo, and that is the whole point:
        // ablated on this build, forcing material.color to black moves a blond
        // cap from 0.371 to 0.312, so the diffuse path carries 16 % of what the
        // lens gets and the sheen BRDF another 1 %. A 43 % change to base
        // measured a 3 % change in the acceptance ratio — a value edit landing
        // on a path nobody can see, which is the same failure as the halo's
        // 0.25 floor one round earlier. Measure the path before tuning it.

        // Where THIS column's hair actually stops. The fringe below cuts every
        // column at its own height, so the root shadow has to be anchored to
        // that cut and not to the shell's edge, or the boundary band lands
        // 10 px inside the hair on one column and 10 px outside it on the next.
        // One unit of vLen measures 160 px on the portrait framing (measured:
        // the shell's front boundary against the same shell with alphaTest 0,
        // 1600x900, head 321 px wide). The brief's 4-10 px window is therefore
        // vLen 0.025-0.0625, and it wants a FLOOR as hard as it wants a
        // ceiling: the point of a fringe is that EVERY column ends somewhere.
        // 0.026 + 0.036 is 4.2-9.9 px, which fills the window end to end. The
        // previous 0.030 stopped at 9.0 and, with 42 % of sLen coming off a
        // smooth field, spent most of its range on a slow drift rather than on
        // the tooth-to-tooth step that makes a comb read as a comb.
        float tipEnd = 0.026 + 0.036 * sLen;
        float above = max(vLen - tipEnd, 0.0);

        // ------------------------------------------------------- MASS OCCLUSION
        // Tone.ts solves the reflectance of a SEMI-INFINITE bundle of fibres —
        // (1-sqrt(1-a))/(1+sqrt(1-a)) plus a 1.6 % cuticle Fresnel — and for a
        // blond that is 0.46 linear in R. A shell BRDF then collects the whole
        // of that solution and none of the geometry that goes with it: real hair
        // packs at a third of solid, every fibre is inside the shadow of the
        // lock next to it, and the mass is 15 mm deep over an absorbing scalp,
        // not infinite. Measured on shots/hair/closeup: the cap rendered at
        // 1.92x the forehead on the shadow side and 1.24x on the lit side, and
        // it did it UNIFORMLY, which is the whole of the wig read.
        //
        // Occlusion, not a darker pigment, is the correction. It is also the one
        // term that fixes the value and the macro variation with the same
        // number: the lock field is 15-30 px, so the cap stops being a flat tone
        // and starts having ropes in it.
        float lockAo = mix(0.40, 1.06, smoothstep(0.04, 0.96, lockV));
        // ...and the last centimetre before the hairline is the underside of the
        // fringe, which is the one part of the cap with hair over it and skin
        // under it. This band is tuned against TWO numbers that pull opposite
        // ways: it has to stay inside 1.25x of the forehead under it (section
        // 4.6, which the old cap failed at 1.37x in the bright direction) while
        // still being a step a 25 px head can show (the endzone hairline, which
        // wants 15 %). 0.80-1.0 puts the boundary in that 15-25 % window from
        // the DARK side, which is the side a real hairline is on.
        // The sign of this term is the opposite of the one it replaced. The old
        // code darkened the last 42 px of the cap on the grounds that "the scalp
        // side of a shell is always darker", which is true of a card's ROOT and
        // false of a cap's hairline: the outermost centimetre of a fringe is the
        // least buried hair on the head, lit from the front, the top and the
        // side at once, and it is where the fine hairs that catch the sky live.
        // Darkening it is what put the hair/skin boundary at 0.49x the forehead
        // under it — a 2.2x step, further outside section 4.6's 1.25x than the
        // 1.37x the bright cap started at, just in the other direction.
        // 1.30 -> 1.14. This band is now the SECOND thing lifting the hairline,
        // not the first: the face-on transmission in lights_fragment_end carries
        // the front of the boundary, and this multiplier's remaining job is the
        // shadow-side temple, where it does not have one. gHalo is gOcc SQUARED,
        // so a 1.30 here is a 1.69 on the backlit rim, and the rim is 81 % of the
        // linear radiance in that band — measured, the near-side temple boundary
        // sat at 1.25x its forehead, on the ceiling of section 4.6, entirely
        // because of that squaring. 1.14 takes the rim boost to 1.30 and the
        // temple to ~1.13 while costing the front, which is fill-carried, about
        // four per cent.
        float depthAo = mix(1.14, 1.0, smoothstep(0.0, 0.14, above));
        gOcc = clamp(lockAo * depthAo, 0.0, 1.5);

        // ------------------------------------------------ HALO TRANSMISSION
        // gOcc is how buried a fibre is on the way OUT, toward the lens. The
        // backlit halo is light that also had to get IN, through the same mass,
        // from the far side of the head — so it crosses the fibre bundle twice
        // and its attenuation is gOcc's, squared. Every other term here crosses
        // once and uses gOcc directly.
        //
        // That is not a tuning knob dressed up. It is the term that decides
        // whether this material can sit on a face at all, and it was measured
        // rather than reasoned. Ablating each path in turn on the shipped
        // closeup (hair mask only; albedo via material.color = black, sheen via
        // sheen = 0, halo via uSunGlow = 0) gives, in rendered luminance:
        //
        //     term      shadow half   lit half   lit/shadow
        //     albedo      0.0313       0.0535      1.71
        //     sheen       0.0047       0.0037      0.80
        //     halo        0.1435       0.0426      0.30   <-- inverted
        //     fibre lobes 0.1147       0.2935      2.56
        //     cap total   0.2942       0.3933      1.337
        //     forehead    0.2445       0.4504      1.842
        //
        // The halo is 49 % of the shadow half of the cap and 11 % of the lit
        // half, because edge is a silhouette term and on a three-quarter
        // portrait the visible silhouette is the SHADOW side. It is the only
        // path that runs backwards against the light, and with it removed the
        // cap measures 2.33 lit-over-shadow against the face's 1.84 — i.e. the
        // rest of this material already tracks the face, and this one term was
        // dragging the response down to 1.34.
        //
        // A cap flatter than the face under it makes the hairline change SIGN
        // across the head: 19 % of shadow-side forehead columns had the hair
        // brighter than the skin by more than 1.25x while 58 % of lit-side
        // columns had it darker by more than 1.25x. Section 4.6 failed in both
        // directions on the same boundary, which is why the previous round's
        // uValue — a single global scale — could pass the pooled mean and miss
        // both tails.
        //
        // The lobe is untouched: bk, the 3.2 exponent, edge*edge, the 0.30 gain
        // and the sheen tint are all exactly as frozen. What changes is how
        // much mass the transmitted light is made to cross, and squaring an
        // occlusion the light crosses twice is the physical statement, not a
        // fudge. It also hands the shadow side the lock-scale variation it had
        // none of, because gOcc carries the lock field and the flat halo it
        // replaces carried nothing.
        gHalo = clamp(gOcc * gOcc * 0.60, 0.02, 1.25);
        // Only the multiple-scatter term is occluded. The cuticle reflection is
        // a first-surface bounce off the outermost fibre and survives whatever
        // is behind it — which is exactly what stops black hair (0.03 linear)
        // from collapsing into a hole when the same occlusion runs over it.
        // The pigment's HUE, at unit luminance, for the face-on transmission
        // term in lights_fragment_end. Normalised rather than used raw because
        // that term's LEVEL has to be set by the value governor — the roster
        // spans 12x in pigment against a 1.6x acceptance window — while its
        // COLOUR is the one thing that should still come off the athlete.
        // Pulled 25 % back toward white so a near-black pigment (0.018 root,
        // seed 7) does not normalise to a neon orange.
        float baseL = max(dot(base, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
        gTrans = mix(vec3(1.0), base / baseL, 0.75);

        vec3 hair = vec3(0.016) + max(base - 0.016, 0.0) * gOcc;
        hair *= 1.0 - 0.35 * vCrease;
        // Wet hair clumps and darkens harder than any other material on a body.
        hair *= mix(1.0, 0.42, uWet);

        diffuseColor.rgb *= hair;

        // Erode the shell's silhouette into strands, so the outline gains the
        // ragged edge a modelled cap can never have. The hairline row goes with
        // it, which is what stops the cap ending in the moulded lip that gave
        // the first pass its swim-cap look.
        //
        // THE WINDOW USED TO CLOSE AT ndv 0.46 — i.e. 63° off the silhouette —
        // which sounds generous and is not. On the one framing that is ABOUT a
        // head, the crown is very nearly face-on: ndv runs 0.85–1.0 over most of
        // the cap, graze is zero there, and the only erosion left anywhere in
        // the shader is the fringe band at the hairline. That is a solid dome
        // with a razor cut in it, which is a description of a swim cap. 0.30 →
        // 0.85 keeps break-up alive well into the interior and still retires it
        // where the shell faces the lens dead on.
        float ndv = abs(dot(normalize(vNormal), normalize(vViewPosition)));
        float graze = 1.0 - smoothstep(0.30, 0.85, ndv);
        float fibre = st.a * 0.55 + sc.a * 0.45;
        // THE GAIN HAS TO CLEAR THE ALPHA TEST OR NONE OF THIS EXISTS.
        // alphaTest is 0.42, so a fragment only disappears once cut passes
        // 0.58. The strand map's dissolve channel is a near-Gaussian centred on
        // 0.5, so at the old gain of 0.90 the very best a fully grazing fragment
        // could do was 0.90 * (1 - 0.36) = 0.576 — and 0.576 is under 0.58. The
        // erosion was mathematically incapable of removing a single pixel, at
        // any angle, on any athlete. It only ever dimmed an alpha nobody read.
        // Each column of the cap ends where ITS strand ends, between 4 % and
        // 20 % up the shell. Fading the whole boundary band out together — the
        // first attempt — just moves the ruled line up the forehead; giving
        // every strand its own end point is what makes it a fringe.
        // Keep this band SHORT. At 0.04–0.195 it ate a fifth of the cap, which
        // on a 1.16 rad shell moves the visible hairline 25 mm up the forehead —
        // and a 25 mm brow extension is the difference between an athlete and a
        // cartoon. rig/Head.ts overshoots the shell by exactly this much.
        //
        // THE BAND IS MEASURED RATHER THAN ARGUED, and tipEnd above carries
        // the current numbers. The soft edge stays at ±0.006 — one pixel, which
        // the alpha test binarises anyway; any wider and neighbouring teeth
        // blend into the ruled line this exists to destroy.
        float fringe = 1.0 - smoothstep(tipEnd - 0.006, tipEnd + 0.006, vLen);
        // Retire the whole erosion once one strand covers less than a pixel.
        // An alpha test against a sub-pixel mask does not read as fine hair at
        // forty metres, it reads as sparkle, and broadcast and night are both
        // shot from forty metres.
        float erode = 1.0 - smoothstep(0.30, 0.85, strandPx);
        // The fringe carries NO distance gate of its own. It used to inherit
        // the interior's erode gate, keyed to the strand map's rate (165-320,
        // per style) and therefore retired the comb at a different distance for
        // every haircut on the roster — and retired it entirely at the two
        // silhouette edges of every cap, where azimuth compresses. The tooth
        // mip above solves the same problem better: the comb cannot alias
        // because a tooth is never smaller than about three pixels, and by the
        // time a head is twenty pixels the whole erosion band is sub-pixel and
        // costs nothing whether it fires or not.
        // THE INTERIOR PARTING-HOLE EROSION IS GONE, AND IT WAS DEAD CODE.
        // It sampled the strand map's dissolve channel on huv at 3.2 u repeats
        // of a 26-cell field and opened the lower quantile
        // (smoothstep(0.41, 0.31, lock) * 0.76) wherever it landed, view angle
        // ignored, on the argument that "a head of hair has holes in the middle
        // of it". Ablated: deleting it changed the eroded set by TWELVE pixels
        // out of 1673, and moved the failing-scalp count from 443 to 440.
        //
        // The reason is the one this file has now paid for three times. Both
        // taps are mip'd — 0.16-0.26 repeats per pixel at the portrait framing,
        // i.e. dozens of texels per pixel — and the dissolve channel is a
        // near-Gaussian centred on 0.5, so the mip chain returns 0.5 almost
        // everywhere and smoothstep(0.41, 0.31, 0.5) is identically zero. It was
        // the erosion-gain arithmetic all over again: a term that reads as
        // structure in the source and cannot fire in the frame.
        //
        // It is not restored, because it could not pay for itself even if it
        // did fire. Section 4.7's macro-value clause is counted over the HAIR
        // MASK, so a pixel the alpha test removes is not in the sample: an alpha
        // hole contributes exactly zero to the lock-scale contrast it was meant
        // to supply, and it costs rows (_haircheck.py drops any row less than
        // 90 % hair). Interior structure has to arrive as VALUE, which is what
        // gOcc's lock field and the gHalo-modulated transmission below do.
        //
        // BOUNDARY GUARD. Inside the hairline band the per-column fringe is the
        // only term allowed to cut; above 25 px the grazing break-up comes back.
        //
        // Left at 0.10-0.18. Extending it to 0.26-0.48 was tried and reverted:
        // it moved the eroded set by three pixels and no acceptance number at
        // all, because THE MANGY PATCH IS NOT AN EROSION DEFECT. Painting
        // shell-minus-hair red over hair green (tools/_hairmeas.mjs plus twenty
        // lines of PIL) settles it in one look: the eroded set is a clean 4-10
        // px comb the whole way along the hairline with no second region
        // anywhere, and the speckle that reads as mange in the shipped frame is
        // the SKIN material's brow-and-temple noise showing through beside it,
        // not hair. The 62 px "connected eroded region" _hairscalp.py reports is
        // simply the run of ordinary comb whose exposed skin happens to be lit.
        // Look at the masks before hardening an erosion gate.
        float guard = 1.0 - smoothstep(0.10, 0.18, vLen);
        float interior = graze * (1.0 - fibre) * 1.25 * (1.0 - guard);
        float cut = max(interior * erode, fringe);
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
          //
          // sc used to carry the largest weight here (1.70) at 2.3 px pitch,
          // on a field that is exactly periodic in u — a normal map ribbed at
          // the pixel grid, which is the corduroy. Its weight is now a third of
          // that and the mass of the perturbation moved onto the lock field,
          // which is 15-30 px and aperiodic. Strand-scale terms are faded out
          // once one repeat is under a pixel: below that the mip chain is
          // returning the mean anyway and all the map contributes is a beat
          // against the shell's lat-long columns.
          float fine = 1.0 - smoothstep(0.22, 0.75, strandPx);
          vec2 hn = vec2(((st.r - 0.5) * 1.20 + (st2.r - 0.5) * 0.40
                          + (sc.r - 0.5) * 0.55) * fine + (lockV - 0.5) * 1.30,
                         ((st.b - 0.5) * 0.18 + (sc.g - 0.5) * 0.30) * fine);
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
          //
          // 0.42 was too generous and it was generous in exactly the wrong
          // place: it lifts the terminator and the shadow side hardest, which is
          // the side that measured 1.92x its forehead against 1.24x on the lit
          // side. 0.28 still keeps the back of the head off zero (0.22 of full
          // at dotNL = 0) and takes 30 % off the shadow side against 3 % off the
          // lit side, which is the differential the two ratios need.
          float wrapped = clamp((dotNL + 0.28) / 1.28, 0.0, 1.0);
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
          // The lobes themselves are frozen — shape, shift, exponent and weight
          // are all as they were. What is new is that they are OCCLUDED: a fibre
          // down in a parting does not get to put a full highlight on the
          // camera. Specular occlusion is softer than diffuse because the
          // outermost fibre of a lock still shines whatever is behind it, hence
          // the mix rather than gOcc straight.
          float specOcc = clamp(mix(0.62, 1.0, gOcc), 0.55, 1.20);
          reflectedLight.directSpecular += directLight.color * vis * gGloss * specOcc
            * (vec3(0.070) * r1 + gSheen * 0.155 * r2);

          #ifdef USE_SHEEN
            // Sheen is the mass's own multiple-scatter halo, so it is the term
            // that has the LEAST business ignoring the mass in the way. Left
            // un-occluded it re-flattened the cap the albedo had just given
            // structure to.
            sheenSpecularDirect += saturate(dotNL) * directLight.color * clamp(mix(0.45, 1.0, gOcc), 0.3, 1.35)
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
          // ...AND IT IS AN EDGE TERM, WHICH THE 0.25 FLOOR STOPPED IT BEING.
          // Both vectors in bk are view-space constants at a fixed sun, so bk is
          // ONE NUMBER over the entire cap; multiplied by a floor of 0.25 it was
          // a flat add on every hair fragment on the head. Measured, that add
          // was the cap: rendering the closeup with the hair's material.color
          // forced to black — which removes the direct diffuse and the whole IBL
          // path — moved the cap mean from 0.432 to 0.410. Ninety-five per cent
          // of a blond cap's value was this one line and none of it was pigment,
          // which is why six rounds of albedo and fibre work never moved the
          // number and why the wig was uniformly 1.5x the face under it.
          //
          // The lobe, the exponent and the colour are untouched. What changed is
          // that light reaching the lens THROUGH the mass now has to have gone
          // through the mass: 15 mm of fibre backed by an opaque skull at the
          // crown, a few strands at the silhouette. edge*edge with no floor is
          // that, and at edge = 1 the gain is up, so the golden-hour rim the
          // shot is lit for is if anything stronger than it was.
          // gHalo replaces the old clamp(mix(0.50, 1.0, gOcc), 0.35, 1.30). That
          // factor occluded the transmitted path LESS than the reflected ones,
          // which is backwards — see the block that writes gHalo for the four
          // per-side ablation numbers that say so.
          reflectedLight.indirectDiffuse += uSunColor * uSunGlow * bk * edge * edge
            * gSheen * 0.30 * gHalo * (1.0 - uWet * 0.6);

          // ------------------------------------------- FACE-ON TRANSMISSION
          // The halo above is an EDGE term, and on the one framing in the shot
          // list that is ABOUT a head the front of the cap is not an edge. It is
          // therefore identically unlit, and measured it shows:
          //
          //   x-band across the hairline   hair   forehead  ratio  halo share
          //   left temple  (silhouette)    0.310   0.255     1.22    59 %
          //   FRONT, 103 of 202 columns    0.113   0.224     0.51    16 %
          //   right of centre              0.394   0.402     0.98    04 %
          //   lit temple                   0.557   0.723     0.77    07 %
          //
          // and, walking UP from the hairline in 6 px steps, the front column
          // reads 0.180 0.112 0.110 0.112 0.117 0.118 0.122 0.128 0.141 0.170 —
          // a fifty-pixel dark mass, not a boundary artefact. Section 4.6 allows
          // 0.80x either way; the front of this cap is at 0.51x, and it is half
          // the hairline. That single band is why 61-66 % of boundary columns
          // failed 4.6 on seed 0 and 77-94 % on seed 7.
          //
          // Every path that could light it is gated off by this tableau: the sun
          // is behind and above (bk = 0.49 over the whole head), so dotNL is
          // negative and the wrapped diffuse clamps to zero, vis floors the
          // two fibre lobes at 0.25 of nothing, and edge is ~0.15 face-on so
          // the halo is 0.02 of itself.
          //
          // The missing path is the one the halo is the grazing limit OF: light
          // that enters the top of the mass and diffuses DOWN through 15 mm of
          // fibre leaves toward the lens wherever the surface faces the lens.
          // It is why a backlit head of hair is a glowing mass and not a
          // silhouette with a bright wire round it. No lobe changes: the R and
          // TRT terms, their shifts, exponents and weights are untouched, bk
          // and the 3.2 exponent are the halo's own, and the occlusion is
          // gHalo, the same double-crossing attenuation, so the lock field rides
          // on it and the front of the cap gains the 10-15 px structure it had
          // none of.
          //
          // ndv*ndv, not (1 - edge*edge): the complement has to be SHARP. At the
          // temple ndv is ~0.15, so ndv*ndv is 0.02 against the halo's 0.72 and
          // the term cannot push the one boundary band that is already at the
          // bright end of 4.6 (1.22x) over the 1.25x ceiling. 1 - edge*edge
          // leaves 0.28 there and does.
          float ndvT = 1.0 - edge;
          reflectedLight.indirectDiffuse += uSunColor * uSunGlow * bk * ndvT * ndvT
            * gTrans * 0.011 * gHalo * (1.0 - uWet * 0.6);
          reflectedLight.indirectDiffuse *= 1.0 - 0.45 * vCrease;

          // THE VALUE GOVERNOR, APPLIED ONCE, TO EVERYTHING. Section 4.7 is a
          // ratio between the cap and the forehead under it and the pigment
          // range is eight times the acceptance window, so a per-athlete scale
          // is the only thing that closes it. Here rather than on the albedo
          // because the albedo is 16 % of a cap's value and the fibre lobes and
          // backlit rim are the rest; here rather than inside the lobes because
          // the lobes are frozen. A colourist's move, not a scattering one: no
          // lobe changes shape, shift, exponent or relative weight, and the two
          // athletes measured land at 0.99 and 0.93 of their foreheads instead
          // of 1.26 and 0.73.
          reflectedLight.directDiffuse *= uValue;
          reflectedLight.indirectDiffuse *= uValue;
          reflectedLight.directSpecular *= uValue;
          reflectedLight.indirectSpecular *= uValue;
        }
      `,
    });
  });

  m.customProgramCacheKey = () => `ult.hair.${i.quality}`;
  m.needsUpdate = true;

  return { material: m, setWet(v: number) { u.uWet.value = v; } };
}
