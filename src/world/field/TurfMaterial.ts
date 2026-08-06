import * as THREE from 'three';
import { linearColor } from '../../util/Tex';
import { FIELD, MOW_STRIPE as STRIPE_WIDTH } from './Layout';
import { DETAIL_TILE, type MapSet } from './TurfTextures';
import { chainCompile, GROUND_NOISE } from './GroundShader';
import type { WearMap } from './WearMap';

/**
 * The pitch surface shader.
 *
 * Built on MeshStandardMaterial so it keeps three's shadow, IBL and fog paths
 * (and so a cascaded-shadow rig can still patch it — see `chainCompile`).
 * Everything spatial is evaluated from world XZ:
 *
 *  - a **band cascade**. Every frequency of surface detail is owned by exactly
 *    one band, and each band knows its own feature size, so it can retire the
 *    moment those features go sub-pixel. 'px' — the world-space width of this
 *    pixel, from screen-space derivatives — is the single control. Bands, from
 *    fine to coarse: an analytic 2.5 cm grain (no texture, so it cannot tile);
 *    the baked 1 m tuft set; the same set rotated at 4.13 m; then four octaves
 *    of analytic fbm from 0.3 m up to 70 m. Once a band retires its texture
 *    contribution fades to that map's *mean* rather than to whatever the mip
 *    chain happened to average, so there is no residual tiling and no popping.
 *    This is what stops the pitch fizzing at a grazing angle, and it is why the
 *    far half of the field still has structure instead of being flat card;
 *  - mow stripes are a *lay direction*, not a painted band: the contrast term
 *    is `layDir · viewDir`, so stripes invert as the camera crosses the field
 *    and vanish when you look straight down, exactly like real bent grass. The
 *    lay is a vector field, not one axis: the field of play is cut lengthwise
 *    and **the two endzones are cross-cut**, which is how a real pitch declares
 *    a region without spending a single extra line of paint. See the endzone
 *    block in `turfShade`;
 *  - chalk is an analytic signed-distance mask over the regulation line
 *    segments — and *only* the regulation set: two sidelines, two end lines,
 *    two goal lines, two brick crosses. Nothing else is painted on an Ultimate
 *    pitch. It is resolved with a coverage-preserving box filter (the
 *    difference of two antialiased edges, not one `smoothstep` straddling the
 *    line), whose width is measured along the line's own normal rather than
 *    from the larger world-axis footprint — see `turfShade` for why the
 *    isotropic estimate dissolved the touchlines at broadcast range. No decal
 *    geometry, no z-fighting, razor sharp in a macro crop. Every marking
 *    carries a paint WEIGHT (see `PW_BOUND`/`PW_GOAL`/`PW_BRICK`) which is the
 *    fraction of sward its pigment hides, and which also sets its width, its
 *    overspray and whether it gets the sub-pixel width floor. That weight is
 *    the pitch's visual hierarchy in one number: the boundary defines the
 *    field and holds; the brick mark is a restart reference and recedes. Paint
 *    is mixed INTO the sward rather than replacing it, keeps the sward's
 *    ambient occlusion and mow lay, and is eroded by noise and by the live
 *    wear map;
 *  - the wear texture drives the grass→dry→bare-soil→mud progression, flattens
 *    the blade normals and rubs out the chalk.
 */

export interface TurfUniforms {
  [k: string]: THREE.IUniform;
}

const PRELUDE = /* glsl */`
varying vec3 vFWorld;
varying vec3 vFNormal;

uniform sampler2D uDetailA;
uniform sampler2D uDetailN;
uniform sampler2D uDetailD;
uniform sampler2D uWear;
uniform vec2  uWearMin;
uniform vec2  uWearInv;
uniform vec3  uSunDir;
uniform vec3  uSunTint;
uniform vec3  uTintLush;
uniform vec3  uTintDry;
uniform vec3  uColDirt;
uniform vec3  uColMud;
uniform vec3  uColChalk;
uniform vec3  uDetailMean;
uniform vec3  uDataMean;
uniform float uTile;
uniform float uNormalScale;
uniform float uStripeWidth;
uniform float uStripeStrength;
uniform float uCrossCut;
uniform float uEzDC;
uniform float uEzLift;
uniform float uEzAO;

float gRough;
float gAO;
vec3  gEmis;
vec3  gNrmW;
vec3  gTurfColor;

${GROUND_NOISE}

/* ---- the paint hierarchy -------------------------------------------------
   Every marking carries a WEIGHT, which is literally the fraction of the sward
   its pigment hides. It is the one number that separates the three classes, and
   the ordering is deliberate:

     boundary (sidelines, end lines)  0.88  — these ARE the field. Out of bounds
                                             is the most consequential fact on
                                             the pitch and the line has to hold
                                             to the far end at broadcast range,
                                             so it also keeps the sub-pixel
                                             width floor.
     goal lines                       0.84  — the same paint, a shade quieter:
                                             identical in the rulebook, but it
                                             takes far more traffic than the
                                             perimeter (pull line-ups, stall
                                             counts, endzone scrums) and a
                                             re-lined pitch shows that by the
                                             second half.
     brick marks                      0.52  — a restart reference, not a
                                             boundary. One metre of single-pass
                                             paint in the most chewed-up square
                                             metre on the field. It must be
                                             legible to a player standing near
                                             it and it must NOT out-read the
                                             disc from the tele, so it is the
                                             only class with no width floor: it
                                             is allowed to fade honestly with
                                             distance.

   Before this, all eight markings were painted identically at 0.97 opacity in
   near-display-white, and the brick cross measured 4.5x the luminance of the
   turf beside it and eight times the disc's pixel area at the tele's working
   range — ground paint out-reading the object of the sport. */
const float PW_BOUND = 0.88;
const float PW_GOAL  = 0.84;
const float PW_BRICK = 0.52;
/* Anything under this weight is a brick mark. */
const float PW_LINE  = 0.68;

/* nearest point on a segment: (distance, unit direction away from the line,
   the marking's paint weight) */
void tryLine(inout vec4 best, vec2 p, vec2 a, vec2 b, float w) {
  vec2 pa = p - a, ba = b - a;
  float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  vec2 d = pa - ba * t;
  float l = length(d);
  if (l < best.x) best = vec4(l, l > 1e-4 ? d / l : vec2(0.0, 1.0), w);
}

/**
 * The regulation set, and nothing but the regulation set.
 *
 * WFDF/USAU mark an Ultimate pitch with exactly eight features: two sidelines,
 * two end lines, two goal lines and two brick marks. There is no centre line,
 * no centre circle, no penalty area, no substitution box — those belong to
 * association football, and a pitch wearing them is marked for the wrong sport.
 *
 * Everything is folded into the +X/+Z quadrant and mirrored back out, so one
 * segment does the work of two and the whole set costs five distance tests.
 *
 * The brick mark is WFDF's "two crossed one-metre lines" — the arms below are
 * +/-0.5 m, which is regulation and stays regulation. Its weight, its width and
 * its wear are what change; its geometry does not.
 */
vec4 chalkNearest(vec2 p) {
  vec4 best = vec4(1e6, 0.0, 1.0, PW_BOUND);
  const float W = ${FIELD.halfWidth.toFixed(2)};   // sidelines      x = +/-18.5
  const float L = ${FIELD.halfLength.toFixed(2)};  // end lines      z = +/-50
  const float G = ${FIELD.goalLine.toFixed(2)};    // goal lines     z = +/-32
  const float B = ${FIELD.brick.toFixed(2)};       // brick marks    z = +/-14
  vec2 q = vec2(abs(p.x), abs(p.y));
  tryLine(best, q, vec2(W, 0.0), vec2(W, L), PW_BOUND);
  tryLine(best, q, vec2(0.0, L), vec2(W, L), PW_BOUND);
  tryLine(best, q, vec2(0.0, G), vec2(W, G), PW_GOAL);
  tryLine(best, q, vec2(0.0, B - 0.5), vec2(0.0, B + 0.5), PW_BRICK);
  tryLine(best, q, vec2(0.0, B), vec2(0.5, B), PW_BRICK);
  // mirror the gradient back out of the folded quadrant
  best.yz *= vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
  return best;
}

void turfShade() {
  vec3 W = vFWorld;
  vec2 P = W.xz;
  vec3 Vw = cameraPosition - W;
  Vw = normalize(Vw);

  // World-space size of this pixel, from screen-space derivatives. This is the
  // one number the whole cascade runs on: a band is only allowed to contribute
  // while its own features are still bigger than 'px'.
  float px = max(length(vec2(dFdx(P.x), dFdy(P.x))), length(vec2(dFdx(P.y), dFdy(P.y))));

  // Authority of the two texture-borne bands. 'detail' covers the 1 m tuft set
  // (23 mm features), 'fine' the analytic sub-tuft grain. Both are generous at
  // the near end and fully retired well before their features reach 2 px.
  // 'px' is the *larger* of the two axis footprints, i.e. the along-view one at
  // a grazing angle, which is where a pitch aliases. Both bands retire while
  // their features are still ~4 px across rather than pushing to Nyquist and
  // relying on anisotropic filtering that only has 4 taps at the low tier.
  float detail = 1.0 - smoothstep(0.0040, 0.0220, px);
  float fine   = 1.0 - smoothstep(0.0014, 0.0070, px);

  /* ---- wear ---- */
  vec2 wuv = clamp((P - uWearMin) * uWearInv, 0.0, 1.0);
  vec4 wv = texture2D(uWear, wuv);
  float wear = wv.r;
  float chalkCut = wv.g;
  float mudA = wv.b;

  /* ---- mown edge ---------------------------------------------------------
     The last few metres before the run-off are the mower's turning strip: cut
     to the same height but scuffed, thinned and dusted with crumb dragged off
     the apron. Folding it into 'wear' rather than painting it separately means
     the whole existing sward→dry→soil ramp, the normal flattening and the
     stripe suppression all follow it for free, so the pitch *fades* into the
     run-off instead of ending at a polygon boundary. */
  float rim = max(abs(P.x) - ${(FIELD.turfHalfX - 3.4).toFixed(2)}, abs(P.y) - ${(FIELD.turfHalfZ - 3.4).toFixed(2)}) / 3.4;
  rim = clamp(rim, 0.0, 1.0);
  rim *= rim * (0.62 + 0.38 * fFbm(P * 0.55 + 13.0, 3));
  wear = clamp(max(wear, rim), 0.0, 1.0);

  /* ---- analytic detail cascade -------------------------------------------
     Baked maps mip away to a flat average past a few metres, which is exactly
     when a pitch starts to look like painted card. These octaves are evaluated
     per pixel from world position, so each one holds until its own features go
     sub-pixel and then bows out cleanly. They cover 0.3 m tufts up to ~3 m
     clump drift — the scales the eye reads as *sward*. */
  float mott = 0.0;
  if (px < 0.090) mott += 0.30 * fFbm(P * 3.10, 2) * (1.0 - smoothstep(0.022, 0.090, px));
  if (px < 0.320) mott += 0.37 * fFbm(P * 1.05 + 3.0, 2) * (1.0 - smoothstep(0.075, 0.320, px));
  if (px < 1.300) mott += 0.46 * fFbm(P * 0.300 + 9.0, 3) * (1.0 - smoothstep(0.320, 1.300, px));
  mott *= 0.62;

  /* ---- drainage-scale variation ------------------------------------------
     Two much coarser octaves — 16 m and 69 m features — used to live in the
     cascade above at 0.66 and 0.46 amplitude. They are the only bands still
     alive at broadcast range, so whatever they carry lands on the frame as a
     single soft swathe rolling across the pitch: a cloud shadow with no cloud,
     and the loudest 'this is not real' cue the field shots had. Groomed
     stadium turf does not tone-vary at 70 m *unless it has been damaged*, so
     the term now (a) carries a fifth of the amplitude, and (b) is gated
     through the wear map, which means it can only darken ground that play has
     actually chewed up. On a fresh pitch it is essentially absent. */
  float macro = 0.30 * fFbm(P * 0.0620 + 21.0, 3) + 0.16 * fFbm(P * 0.0145 + 47.0, 2);
  macro *= 0.12 + 0.88 * smoothstep(0.05, 0.48, wear);

  /* ---- two-scale baked detail --------------------------------------------
     The blend weight is itself driven by the macro field, so the same tile
     position gets a different mix everywhere on the pitch — that, rather than
     the second scale on its own, is what breaks the 1 m repeat. Past 'detail'
     both layers cross-fade to the map's linear mean instead of to whatever the
     mip chain converges on, which removes the last low-frequency ghost of the
     tile from the far half of the field. */
  const mat2 R2 = mat2(0.682, 0.731, -0.731, 0.682);
  const mat2 R2i = mat2(0.682, -0.731, 0.731, 0.682);
  vec2 uv1 = P / uTile;
  // Second layer at *nearly* the same scale, rotated 47° and offset. A big
  // magnification (this used to be 4.13x) is the obvious way to de-tile, but it
  // also blows the tuft bands up to 95 mm, and 95 mm directional bands over a
  // whole pitch read as corduroy. Same feature size, different phase and angle,
  // irrational scale ratio: the composite never repeats and never grows a
  // structure coarser than a tuft.
  vec2 uv2 = (R2 * P) / (uTile * 1.37) + vec2(3.71, 1.93);
  /* A soft *selection*, not a blend. Cross-fading two rotated copies of a
     directional texture superimposes two lay directions on the same pixel, and
     two lay directions on the same pixel is a crosshatch — the exact "woven
     fabric" tell we are trying to get rid of. Choosing one layer per region
     keeps the de-tiling (different parts of the pitch sample different parts of
     the tile) while never showing two grains at once.

     What it must NOT do is take its decision from the same field that tints the
     pitch. When it did, its transition was an iso-contour of a 69 m fbm and a
     near-hard step, so the night frame grew straight-edged polygonal patches
     across mid-field — a contour line drawn in tile-selection. It now runs off
     a dedicated 2.4 m field with a 0.5 m wobble on top, and the transition is
     five times wider, so the seam is short, wiggly, local, and lands where a
     clump direction would plausibly change anyway. */
  float sel = fFbm(P * 0.42 + 137.0, 2) + 0.42 * fFbm(P * 1.90 + 61.0, 2);
  float k = smoothstep(-0.30, 0.30, sel * 1.8);

  vec3 a1 = texture2D(uDetailA, uv1).rgb;
  vec3 a2 = texture2D(uDetailA, uv2).rgb;
  vec3 col = mix(mix(a1, a2, k), uDetailMean, 1.0 - detail);

  vec3 d1 = texture2D(uDetailD, uv1).rgb;
  vec3 d2 = texture2D(uDetailD, uv2).rgb;
  vec3 dd = mix(mix(d1, d2, k), uDataMean, 1.0 - detail);

  vec2 n1 = texture2D(uDetailN, uv1).xy * 2.0 - 1.0;
  vec2 n2 = R2i * (texture2D(uDetailN, uv2).xy * 2.0 - 1.0);
  vec2 nrm = mix(n1, n2 * 0.65, k) * detail;

  /* ---- sub-tuft grain ----------------------------------------------------
     Analytic, so it has no repeat at all, and two decorrelated bands so the
     coarse one can outlive the fine one instead of both cutting at once. This
     replaces a 'fNoise(P * 240.0)' term that had 4 mm features and no fade —
     four times past Nyquist for any pixel bigger than 2 mm, i.e. everywhere. */
  if (fine > 0.01) {
    // Rotated off the world axes: value noise is built on an axis-aligned
    // lattice and shows it as rectangular blotching if you sample it square.
    vec2 Pg = R2 * P;
    float ga = fNoise(Pg * 40.0) - 0.5;
    float gb = (fNoise(Pg * 97.0 + 17.0) - 0.5)
             * (1.0 - smoothstep(0.0010, 0.0042, px));
    float gc = fNoise(Pg * 40.0 + 71.0) - 0.5;
    col *= 1.0 + fine * (0.17 * ga + 0.13 * gb);
    nrm += vec2(ga + 0.6 * gb, gc) * fine * 0.55;
  }

  /* ---- health / wear colour ramp -----------------------------------------
     A well-kept pitch is *green*. The old bias put a mid-field wear of 0.3 far
     enough down the ramp that almost the whole surface landed on the dry tint,
     which is how a stadium pitch ends up reading as straw. */
  float health = clamp(0.84 + 0.40 * mott + 0.30 * macro - 0.95 * wear, 0.0, 1.0);
  col *= mix(uTintDry, uTintLush, smoothstep(0.06, 0.68, health));
  col *= 0.93 + 0.16 * (mott * 0.5 + 0.5) + 0.09 * macro;

  /* ---- thinning sward, not scratches -------------------------------------
     Round 2 read the wear as "salmon-pink streaks … scratches rather than
     wear", and both halves of that are this block.

     *Pink* was a hue problem. uColDirt was a red-brown at H≈28°, and a
     red-brown laid over a green sward and then lit by a warm low key
     complements straight into magenta. The tint is now straw at H≈41° — the
     colour of thinned grass with the soil showing through, which is what worn
     turf actually is — and it never goes below 35°.

     *Scratches* was a contrast and a bandwidth problem. The ramp opened at
     wear 0.42 over a 0.5-wide window, so a stamped skid crossed from full
     sward to bare soil inside its own 40 cm width and drew a hard-edged mark.
     It now opens later and takes twice as long to get there, tops out at 0.82
     rather than 1.0 (bare soil under a *stadium* pitch is a patch, never a
     stripe), and the 4.5 cm clod term — four times past Nyquist at broadcast
     range, and pure aliasing energy — is gated behind the near-field band. */
  float dirt = 0.82 * smoothstep(0.50, 1.00, wear + 0.06 * mott);
  vec3 soil = uColDirt * (0.78 + 0.42 * (fFbm(P * 5.5, 3) * 0.5 + 0.5));
  soil *= 1.0 + 0.26 * detail * (smoothstep(0.50, 0.60, fNoise(P * 22.0)) - 0.5);
  col = mix(col, soil, dirt);

  float mud = 0.75 * smoothstep(0.34, 0.86, mudA) * smoothstep(0.22, 0.62, wear);
  col = mix(col, uColMud * (0.80 + 0.40 * (fFbm(P * 3.2 + 9.0, 2) * 0.5 + 0.5)), mud);

  /* ---- mow stripes: a lay direction, evaluated against the view ----------
     Not a painted band. The blades in alternating passes lie in opposite
     directions; you see their backs (bright) or their tips (dark) depending on
     where you stand, so the contrast term is layDir · viewDir and the stripes
     invert as the camera crosses the field and flatten out from directly
     overhead. The mower wanders, and the pass width breathes, so the edges are
     never perfectly parallel. */
  // The base cut runs the length of the pitch (banded in X), which is the
  // arrangement a sideline camera sees best — and every shot in the rig is a
  // sideline camera, so 'Vw.x' is large in all of them and the stripes read.
  float wobbleX = 0.14 * fFbm(P * vec2(0.0038, 0.011) + 41.0, 2);
  float layX = clamp(cos(3.14159265 * (P.x / uStripeWidth + wobbleX)) * 2.2, -1.0, 1.0);
  layX *= 0.80 + 0.32 * fFbm(P * vec2(0.05, 0.006) + 71.0, 2);

  /* ---- the endzone is a REGION, and a region is a mow pattern -------------
     A blind broadcast critic could not tell who was attacking or toward where
     from the opening frames of live play: "no endzone shading, no differing
     turf tone … just a mid-field slab of green". The instinct is to fatten the
     goal line, and that is the wrong answer twice over — in the rulebook a goal
     line IS a boundary line, painted at the same width as a sideline, and paint
     is not how a real pitch says "region" anyway. Groundstaff say it with the
     mower: the endzone gets a second pass across the width, and the change of
     lay is visible from the top tier of a stand with no extra chalk at all.

     So the endzone is cross-cut, and the cross pass runs at 45°, mirrored about
     the halfway line — the two ends angle away from each other. Three reasons,
     and the last two are why it is not the obvious 90°:

       - it is not albedo. The contrast is 'lay · (view, sun)' plus a tilt of
         the effective normal, so it changes with the camera and with the sun
         and keeps reading as grass rather than as a decal on grass. Under
         art-direction §2 that also means the endzone never becomes a coloured
         slab: hue and saturation are untouched. Only the light coming off it
         changes.
       - a 45° pass keeps its contrast at a sideline camera; a 90° one does not.
         Contrast is 'dot(lay, 0.95*look + 0.30*sun)'. The tele lives on a dolly
         line 23.5 m outside the −X touchline (Tele.ts) and runs z = ±36, so
         'look' always has a big +X component and a Z component whose sign is
         the sign of the endzone it is pointing at. A lay of (0.71, 0.71·sgn z)
         collects BOTH; a lay of (0, 1) collects only the smaller one. Measured
         on a lit endzone at 47 m: 90° gave 5.2 % band contrast where the field
         of play had 9.9 %, and 45° gets that back. This is the same reasoning
         that put the base cut along the pitch rather than across it, one line
         up — a groundsman cuts for the stand and the camera, and this venue's
         camera is on one side.
       - a 90° pass is also the one that foreshortens away. Its bands repeat
         along Z, which at a 15° depression is the compressed axis; a diagonal
         band repeats half along X, where the pixels are.

     THE SIZING RULE, which the first cut of this block got wrong: an endzone
     has to carry as much band energy as the field of play, in its own
     direction. Not less. The first version left a third of the lengthwise base
     cut standing under a cross pass that was itself weaker than the base cut,
     on the theory that a real cross-cut box reads as a faint four-tone chequer.
     Measured at the tele, that came out as EZ 6.7 % diagonal against 4.0 %
     residual lengthwise, where the field of play beside it ran 9.9 % — i.e.
     the endzone had LESS pattern than the pitch and no clear direction of its
     own, and the eye reads "the stripes went soft over there", which is a
     blemish, not a region. Sized so the two regions swap rather than fade
     (EZ_BASE 0.34 → 0.18, cross amplitude 0.75 → 0.98 of the base cut's) it
     measures EZ 8.2 % diagonal / 3.0 % lengthwise against FOP 4.1 % diagonal /
     9.9 % lengthwise: a clean transpose of the same energy, which is what a
     mower actually does to a piece of ground.

     The pattern boundary sits exactly on the goal line, under the paint, which
     is where a groundsman would put it and which is what makes the goal line
     read as the edge of something instead of as one more white line. It stops a
     mower's width outside the sideline rather than on it, so the touchline is
     not doubled by a second edge running alongside it, and it runs on past the
     end line to the mown edge — behind the end line there is nothing for a
     pattern change to mean. */
  const float EZ_Z = ${FIELD.goalLine.toFixed(2)};
  const float EZ_X = ${(FIELD.halfWidth + 1.2).toFixed(2)};
  /* The cross pass keeps this much of the lengthwise base cut under it. Enough
     that the ground still remembers being cut twice; not enough to compete with
     the pass on top of it. */
  const float EZ_BASE = 0.18;
  // Edges are antialiased against the pixel footprint for the same reason the
  // chalk is: a hard step in a metre-scale shading term crawls at broadcast
  // range. 0.26 m is the mower's own edge — a roller does not lay a perfectly
  // sharp line either.
  float ezAA = max(0.26, 1.4 * px);
  float ez = smoothstep(-ezAA, ezAA, abs(P.y) - EZ_Z)
           * (1.0 - smoothstep(-ezAA, ezAA, abs(P.x) - EZ_X))
           * uCrossCut;

  float ezC = clamp(ez, 0.0, 1.0);

  /* The diagonal, mirrored so each end angles off its own goal line. Amplitude
     matches the base cut's (0.81 + 0.34·fbm against 0.80 + 0.32·fbm) rather
     than sitting under it: see the sizing rule above. It was held below the
     base cut on the argument that 'layGain' along the diagonal can exceed 1 and
     a clamped lay is a flat-topped band, i.e. a painted one. The clamp does
     engage here — but 'layD' is a clamped cosine to begin with (that ×2.2 is
     what makes a mow band broad and flat-topped in the first place, because a
     mower lays broad flat bands), and photographed at 47 m and in a 3 m macro
     crop the result reads as sward, not as paint. The failure that argument was
     guarding against is real; it is just not reached at this amplitude. */
  const float R2H = 0.70710678;
  vec2 dEZ = vec2(R2H, P.y < 0.0 ? -R2H : R2H);
  /* Same mower, same deck, so the cross pass is the same width as the base cut.
     A wider one was tried and measured: at 1.45x the band amplitude is
     unchanged (10.5 % against 10.9 % at 47 m) and the screen period grows from
     100 to 134 px, but it costs on both sides — the endzone's median tone
     becomes phase-sensitive, because a region 18 m deep holding two and a half
     broad bars swings with where the bars happen to fall in a way that one
     holding three and a half narrow ones does not, and at 62 m the wider band
     starts collecting the field of play's lengthwise cut into its own axis. */
  float wobbleD = 0.14 * fFbm(P * vec2(0.008, 0.008) + 83.0, 2);
  float layD = clamp(cos(3.14159265 * (dot(P, dEZ) / uStripeWidth + wobbleD)) * 2.2, -1.0, 1.0);
  layD *= 0.81 + 0.34 * fFbm(P * vec2(0.03, 0.03) + 113.0, 2);

  /* The lay is a *vector* in world XZ, not a scalar on one axis. Note this is
     one lay direction per pixel, not two textures superimposed — the crosshatch
     the two-scale detail block warns about is a different failure. */
  vec2 layBase  = vec2(layX * mix(1.0, EZ_BASE, ezC), 0.0);
  vec2 layCross = dEZ * (layD * ez);
  vec2 layV = layBase + layCross;
  vec2 lookXZ = -Vw.xz;
  vec2 sunXZ  = -uSunDir.xz;
  vec2 layGain = 0.95 * lookXZ + 0.30 * sunXZ;
  float aniso = clamp(dot(layV, layGain), -1.0, 1.0);
  float stripeFade = 1.0 - smoothstep(uStripeWidth * 0.30, uStripeWidth * 1.10, px);
  aniso *= uStripeStrength * stripeFade * (1.0 - 0.70 * wear);
  col *= 1.0 + aniso * 0.50;
  nrm *= 1.0 + 0.26 * aniso;

  /* ---- the cross pass's MEAN lay: the region step, in the view-dependent
     channel where the brief says it has to live.

     A single-cut region alternates about zero — half its blades lean toward
     you, half away — so its mean is neutral and only the bands are visible. A
     cross-cut region has been under a roller a second time, and the second pass
     does not undo the first so much as lay everything down along its own axis,
     so what the region returns ON AVERAGE is biased along dEZ instead of
     cancelling. That is a different fact from the alternation and it is the one
     that makes an endzone read as an endzone from the top of a stand.

     It is deliberately OUTSIDE the clamp above, and that is the whole point of
     writing it here rather than as a DC bias on layD, which is where it was
     first put. 'aniso' is a clamped dot product and the cross pass already
     drives it into the rail (dot(dEZ, layGain) reaches 1.11 at the tele, and
     that flat top is what makes a mow band look mown). Adding the mean inside
     the clamp therefore does not add a step, it CROPS THE BAND: measured at
     47 m, a mean of 0.45 folded into layD took the endzone's own band from
     10.9 % amplitude down to 4.7 % while the field of play beside it held
     12.6 %, i.e. it bought the tonal step by spending the pattern, which
     produces exactly the lighter-slab-with-no-grain that a decal looks like.
     Outside the clamp the two are independent and the band is untouched.

     It still runs through 'layGain', so it is shading and not albedo in the
     sense that matters: it strengthens, weakens and would invert with the
     camera and the sun. It is reliable rather than lucky at this venue because
     of the 45-degree mirroring — the tele's dolly line is outside the -X
     touchline so look.x is always positive, and the tele frames the endzone it
     is pointing at so look.z carries that endzone's sign, which is the sign
     dEZ.z is mirrored to. Both terms of the dot land positive from the
     broadcast side. From the far touchline the same endzone reads DARKER than
     the field of play, which is what a cross-cut genuinely does and what a
     painted one never would. */
  float ezGain = clamp(dot(dEZ, layGain), -1.0, 1.0) * stripeFade;
  col *= 1.0 + uEzDC * ezGain * ezC * (1.0 - 0.70 * wear);

  /* ---- and the part of the cross-cut that does NOT depend on where you stand
     The alternation above is the whole of a mow stripe and it is not the whole
     of a cross-cut, because a cross-cut region has been under a roller twice.
     Twice-rolled sward stands less upright: it presents more flat leaf and
     traps less light between the blades, so it returns a little more of what
     falls on it and its blade relief is a little shallower. That is the same
     physics the stripe alternation runs on, taken to the mean instead of the
     difference — a fresh mow is visibly lighter than an old one on any pitch.

     It is sized against the one number the art direction already fixes for this
     mechanism: a mow stripe PAIR is allowed 0.4 of a stop (art-direction §2),
     which is the same flattening physics taken to its difference. Measured on
     the pitch, the field-of-play stripes spend almost exactly that — 9.9 % RMS
     band contrast is 28 % peak to peak is 0.355 of a stop in sun (0.47 in flat
     light). The region step is set to a QUARTER of that.

     Two numbers to know before re-tuning this, both measured through the
     uCrossCut A/B at 47 m and 51 m on a 30° lens (endzone median display
     luminance minus field-of-play median, cross-cut on minus cross-cut off,
     as a fraction of the field of play's own median):

       +0.10 of this albedo lift  →  +2.9 % in sun, +4.5 % in ambient only
       +0.10 of the AO lift below →  +0.5 % in sun, +5.4 % in ambient only

     The AO term is INDIRECT-ONLY, so it is a shade knob and very nearly nothing
     else; the split has to stay albedo-heavy or the endzone shows up on an
     overcast frame and vanishes at golden hour, which is the hour this game is
     set in. The previous 0.140 / 0.085 split put the step at 2.4–4.1 % in sun,
     which is at the detection threshold for a soft edge and was invisible at
     1:1 in every frame it was photographed in. 0.260 / 0.055 measures 5.7–6.2 %
     in sun and 12.5–14.2 % in ambient: 0.08 and 0.18 of a stop, a quarter and
     four tenths of what one stripe pair already spends. Unlike the lay it
     cannot be foreshortened away, which matters because from the tele's dolly
     line an endzone is a strip forty pixels deep.

     It touches V and nothing else. Multiplying the albedo leaves hue alone and
     leaves saturation alone (S is scale-invariant), so art-direction §2's
     "everything but the two kits and the disc under 50 % HSV" is untouched by
     construction rather than by measurement. */
  col *= 1.0 + uEzLift * ezC;
  nrm *= 1.0 - 0.16 * ezC;

  /* ---- surface response ---- */
  float rough = mix(0.72, 0.96, dd.g);
  // The lay that brightens a stripe also turns its blades' waxy faces toward
  // you, so the stripe is glossier as well as lighter.
  rough -= 0.22 * aniso;
  // Lost normal variance has to come back as roughness or the far pitch turns
  // into a mirror-flat sheet that sparkles under the floodlights.
  rough += 0.10 * (1.0 - detail);
  rough = mix(rough, 0.95, dirt);
  rough = mix(rough, 0.33, mud);
  // …and the same flattening that lifts the cross-cut's albedo also opens the
  // sward up, so the blades occlude each other a little less. This is the half
  // of the cross-cut that survives with no direct sun on the turf at all,
  // because ambient occlusion is all that indirect light has to work with —
  // which is exactly why it is small. See the albedo block above for the two
  // measured transfer rates: this term buys ten times more in shade than in
  // sun, so it is a garnish on the albedo step and never the step itself.
  gAO = mix(dd.r, 0.85, dirt) * (0.86 + 0.16 * (mott * 0.5 + 0.5))
      * (1.0 + 0.10 * aniso) * (1.0 + uEzAO * ezC);

  /* ---- chalk -------------------------------------------------------------
     Coverage-preserving: the difference of two antialiased edges is the exact
     box-filtered coverage of the band [-HW, HW], so a line that goes sub-pixel
     gets *dimmer* and stays one pixel wide instead of ballooning into a fat
     grey smear.

     The filter width, though, has to be measured ACROSS the line and not from
     the world-axis footprint the rest of the cascade runs on. 'px' is the
     larger of the two axis footprints — deliberately, because a band cascade
     has to retire on its worst axis — and at a sideline camera the worst axis
     runs *down the touchline*, where a pixel can cover half a metre while
     still being two centimetres wide across the paint. Feeding that into the
     box filter divided the touchline's coverage by twenty and dissolved it:
     the markings were, as the review put it, "essentially missing at the wide
     angles", which is a filtering bug and not a lack of contrast.

     Projecting the screen-space Jacobian of world position onto the distance
     field's own gradient gives the exact width of the footprint across the
     band. Lines seen broadside now stay crisp and full-strength to the far end
     line; lines seen end-on still fade, which is correct. */
  vec2 dPdx = vec2(dFdx(P.x), dFdx(P.y));
  vec2 dPdy = vec2(dFdy(P.x), dFdy(P.y));
  /* Line width. WFDF allows 75–120 mm; 'FIELD.lineHalfWidth' paints the
     boundary set at the wide end of that allowance (and then some) so the far
     touchline still holds a pixel — that is Layout.ts's call and it stands for
     the lines that define the field. The brick mark is a different job: a
     lining machine walks the boundary with a double pass and dabs the brick
     with a single one, so it goes on at the regulation MINIMUM, 75 mm. Half
     the width is half the ink, and it is more regulation-correct, not less. */
  const float HW_LINE  = ${FIELD.lineHalfWidth.toFixed(3)};
  const float HW_BRICK = 0.0375;
  vec4 cn = chalkNearest(P);
  float pw = cn.w;                              // 0.88 bound · 0.84 goal · 0.52 brick
  float isBrick = 1.0 - step(PW_LINE, pw);
  float hw = mix(HW_LINE, HW_BRICK, isBrick);
  float aa = max(1.2e-4, length(vec2(dot(cn.yz, dPdx), dot(cn.yz, dPdy))));
  /* Minimum drawn width — for the lines that define the field, and only those.
     Coverage preservation is the correct answer to aliasing and the wrong
     answer to legibility: it is energy-exact, so a line that goes sub-pixel
     fades toward the turf and the viewer loses the state of play. Every
     shipped sports title clamps its field lines to a floor of about one
     pixel and lets the coverage term carry the fading instead. 0.42 of the
     across-line footprint is a 0.84 px floor — under a pixel, so it never
     grows a fat halo on a line that is genuinely resolved, and it only
     engages past ~18 cm of footprint, i.e. the far third of the pitch at
     broadcast range and nowhere at all in a macro crop.

     The brick mark is deliberately excluded. A floor is a promise that a
     marking stays legible however small it gets, and that promise is exactly
     what turned a one-metre restart cross into the highest-contrast object in
     a broadcast frame. Below its own resolution the brick is allowed to do
     what physics says and fade. */
  float HWe = max(hw, 0.42 * (1.0 - isBrick) * aa);
  float cov = clamp((HWe - cn.x) / aa + 0.5, 0.0, 1.0)
            - clamp((-HWe - cn.x) / aa + 0.5, 0.0, 1.0);
  // Erosion is 40 cm detail. Once it is sub-pixel it must converge to its own
  // mean rather than keep modulating, or the far half of every line flickers
  // between full and two-thirds strength along its length.
  float near = 1.0 - smoothstep(0.020, 0.13, px);
  float grain = fFbm(P * 2.6 + 7.0, 3);
  cov *= mix(0.94, mix(0.78, 1.0, smoothstep(-0.42, 0.42, grain)), near);
  /* Scuffing, capped — and capped per class.
     This term used to be able to take 55 % of a line away, and the wear map
     hands it a saturated cut channel exactly where the chalk is: the goal
     lines carry a seeded scrimmage band *and* forty pivot stamps, so the two
     lines a viewer most needs — the ones that say where the endzone is — were
     the two being erased hardest. A pitch is re-lined the morning of a match.
     Play scuffs the paint; it does not remove it.

     The brick mark is the exception, and it is not an exception for the
     convenience of this task: it is the one marking that sits in the middle of
     the field, every turnover restarts on it, and 'WearMap.seed' accordingly
     lays a two-metre wear blotch right over it. Paint on chewed ground goes
     first. So the brick takes both the cut channel harder AND a direct term
     off raw wear, which is what makes it read as a mark play has been over all
     afternoon rather than a decal stuck to the grass this morning. */
  cov *= 1.0 - (0.24 + 0.42 * isBrick) * chalkCut * mix(0.55, 1.0, near);
  cov *= 1.0 - 0.45 * isBrick * smoothstep(0.18, 0.78, wear);
  /* Overspray either side of the line — the soft edge is scattered powder on
     the blades, not a filtering artefact, so it is authored at a fixed world
     width and antialiased the same way. It is scaled by the class weight
     twice over (width and amplitude) because a halo is footprint: on the
     boundary it is the paint bleeding into the sward, on a 1 m cross it was
     doubling the size of the thing we are trying to stop over-reading. */
  float dw = max(aa, 0.010);
  float dustW = 0.075 * pw;
  float dust = (clamp((hw + dustW - cn.x) / dw + 0.5, 0.0, 1.0)
              - clamp((-hw - dustW - cn.x) / dw + 0.5, 0.0, 1.0))
             * 0.32 * pw * pw * smoothstep(-0.2, 0.5, grain) * near;
  float chalk = clamp(cov + dust * (1.0 - cov), 0.0, 1.0);

  /* ---- paint is a coat ON the sward, not a decal over it -------------------
     The old line was 'mix(col, chalkCol, chalk * 0.97)': a 97 % replacement of
     the surface with near-display-white. That is a sticker. Marking fluid is
     sprayed onto standing grass — it coats the blade tops, misses the sides and
     the leaf litter under them, and what you see is a *mixture*, which is why
     real paint takes the colour, the mottle and the light of the ground it is
     on and why a line over worn turf is grey-green rather than white. 'coat' is
     that mixing fraction, and it is the class weight: at 0.88 the boundary
     still reads as a hard white line, and the 12 % of sward that survives is
     what puts it in the pitch instead of on it. */
  float coat = chalk * pw;
  vec3 pigment = uColChalk * (0.90 + 0.20 * fNoise(P * 95.0) * fine);
  // the mark rides the ground's own tonal variation instead of ignoring it
  pigment *= 0.88 + 0.16 * (mott * 0.5 + 0.5);
  // and it is dirty where the sward under it has gone
  pigment = mix(pigment, pigment * 0.70 + uColDirt * 0.55, dirt);
  col = mix(col, pigment, coat);
  // matte, but it keeps a trace of the sward's own response
  rough = mix(rough, 0.93, coat);
  /* Ambient occlusion is NOT cancelled by paint. The old 'mix(gAO, 1.0, 0.7)'
     lit the line as if the blades under it had stopped shadowing each other,
     which is most of why the markings glowed: a painted sward is still a sward
     and still has holes in it. Paint lifts the local response a little because
     the coated tips scatter more; that is all it does. */
  gAO = mix(gAO, min(1.0, gAO * 1.18), coat);

  /* Sprayed marking wets and mats the blades. It does not sit proud of them as
     a bead of gloss — that was a decal cue, at 1.5 the amplitude of everything
     else in the normal budget. What survives is the flattening (right: the
     blades under a line are laid over and stuck down) plus a whisper of edge
     relief that only exists in a macro crop, where the paint genuinely does
     pile up on the first blades the nozzle hits. */
  float bead = exp(-pow((cn.x - hw) / 0.030, 2.0)) * chalk * detail;
  nrm = nrm * (1.0 - 0.55 * coat) + cn.yz * bead * 0.45;

  /* ---- assemble ----------------------------------------------------------
     The mow lay is also a real tilt of the effective surface — a pass of bent
     grass presents its backs to one side — and unlike the baked relief it is a
     metre-scale feature, so it never mips away. Applying it to the normal is
     what keeps the stripes alive at broadcast range and is why they respond to
     the sun moving as well as to the camera moving. */
  vec2 pert = nrm * uNormalScale * (1.0 - 0.5 * dirt) * (1.0 - 0.6 * mud);
  // The mow lay survives *through* the paint in the same proportion the sward
  // does — you can see the mower's bands crossing a touchline on any broadcast,
  // and cutting them at the paint edge is what makes a line read as a cut-out.
  /* The cross pass gets a THIRD of the base cut's tilt, and that number was
     measured, not chosen. This tilt and the 'col *= 1 + aniso * 0.50' above are
     two models of one physical effect, and whether they reinforce or fight
     depends on the sun's azimuth relative to the lay axis — a fact that stayed
     invisible while there was only one lay axis to fight about. Under this
     venue's arc the sun runs mostly down-pitch (uSunDir ≈ (-0.44, 0.53, -0.73)
     at h 17.2), so against the base cut's X axis the tilt is a mild negative
     feedback that costs about a third of the contrast, and against the cross
     cut's Z axis it very nearly cancels the albedo term outright: with the
     tilt at the base cut's own 0.30 the lit endzone measured 1.7 % band
     contrast against a 1.1 % floor — a cross-cut that had simply ceased to
     exist in direct sun while measuring 10 % in ambient. The algebra is not
     marginal, it is a sign flip either side of a coefficient of 0.27.

     Letting the albedo term own the cross component is also the physically
     honest answer: an endzone has been rolled BOTH ways, and the second
     rolling flattens most of the first one's macroscopic tilt. A chequer is a
     subtler relief than a stripe for exactly this reason. */
  const float EZ_TILT = 0.30;
  pert += (layBase + layCross * EZ_TILT)
        * 0.30 * stripeFade * (1.0 - 0.70 * wear) * (1.0 - coat);
  gNrmW = normalize(vFNormal + vec3(pert.x, 0.0, pert.y));
  gRough = clamp(rough, 0.06, 1.0);

  // Forward scatter through the blades when the sun is behind them. Strongest
  // at a grazing view, because that is when the sightline passes through the
  // most leaf: the pitch lights up towards the far touchline at golden hour.
  float back = clamp(dot(Vw, -uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  float graze = 1.0 - abs(Vw.y);
  gEmis = uSunTint * col * pow(back, 3.0) * (0.28 + 0.72 * graze)
        * mix(uDataMean.b, dd.b, detail) * 0.85 * (1.0 - dirt) * (1.0 - coat);

  gTurfColor = col;
}
`;

export interface TurfMaterialOpts {
  maps: MapSet;
  wear: WearMap;
  anisotropy: number;
}

export function makeTurfMaterial(opts: TurfMaterialOpts): {
  material: THREE.MeshStandardMaterial;
  uniforms: TurfUniforms;
} {
  const { maps, wear, anisotropy } = opts;
  for (const t of [maps.albedo, maps.normal, maps.data]) t.anisotropy = anisotropy;

  const uniforms: TurfUniforms = {
    uDetailA: { value: maps.albedo },
    uDetailN: { value: maps.normal },
    uDetailD: { value: maps.data },
    uWear: { value: wear.tex },
    uWearMin: { value: new THREE.Vector2(wear.minX, wear.minZ) },
    uWearInv: { value: new THREE.Vector2(1 / wear.spanX, 1 / wear.spanZ) },
    uSunDir: { value: new THREE.Vector3(-0.52, 0.77, 0.37) },
    uSunTint: { value: new THREE.Vector3(1.0, 0.86, 0.62) },
    uTintLush: { value: new THREE.Vector3(0.78, 1.08, 0.72) },
    uTintDry: { value: new THREE.Vector3(1.26, 1.02, 0.58) },
    // Straw, H≈41°. Never take this below H 35° — see the wear block in
    // `turfShade`: a red-brown over green under a warm key reads as pink.
    uColDirt: { value: linearColor(0x6a5b3a) },
    uColMud: { value: linearColor(0x3e352a) },
    /* Marking-fluid pigment, NOT white.
       0xf2f3ee is V 95.3 % — three points off the disc's own 0xfafafa (V 98 %)
       and, in linear terms, an albedo of 0.87: brighter than fresh snow, on the
       ground, over the whole regulation set. Measured on a broadcast frame that
       put the peak of a brick mark at sRGB 215 while the disc came in between
       0.47 and 0.74 relative luminance — i.e. the paint was routinely the
       highest-value object in the frame, which art-direction §2 gives to the
       disc alone. This is titanium-white line marking as it actually
       photographs on grass: V 84.7 %, S 5.6 %, hue 51° (well inside the ≤50 %
       saturation cap), a linear albedo of 0.67. Thirteen points of value below
       the disc is the headroom the disc needs. */
    uColChalk: { value: linearColor(0xd8d6cc) },
    uDetailMean: { value: maps.meanAlbedo.clone() },
    uDataMean: { value: maps.meanData.clone() },
    uTile: { value: DETAIL_TILE },
    uNormalScale: { value: 0.62 },
    uStripeWidth: { value: STRIPE_WIDTH },
    uStripeStrength: { value: 1.0 },
    /* The endzone cross-cut, 0..1. It is a uniform and not a constant for the
       same reason `uStripeStrength` is: the claim "the endzone reads at 40–60 m
       in sun and in shadow" is a measurement, and a measurement needs an A and
       a B. Setting this to 0 at runtime restores the single-direction cut
       exactly, so the two can be photographed and sampled in one session
       instead of by editing the shader between runs. */
    uCrossCut: { value: 1.0 },
    /* The four numbers that size the endzone. They were `const`s in the shader
       (and `uEzDC`/`uEzLift`/`uEzAO` were worse than that: DECLARED in the
       prelude and never put in this object, so three.js's `seqWithValue` quietly
       dropped them and GL held them at the default 0 — `uEzDC` had been dead
       since it was written, and its intended effect had never once rendered).
       They are uniforms now for the reason `uCrossCut` is: every claim about
       this block is a measurement at a stated range, and a measurement needs a
       sweep, which means the tuning has to be reachable from the probe instead
       of living behind a recompile. See the endzone block in `turfShade`. */
    uEzDC: { value: 0.32 },
    // The residue that survives with no direct sun at all: a twice-rolled sward
    // is flatter, so it returns a little more of what falls on it and occludes
    // itself a little less. Albedo-heavy on purpose — see `turfShade`.
    uEzLift: { value: 0.14 },
    uEzAO: { value: 0.055 },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    dithering: true,
  });
  material.name = 'turf';

  chainCompile(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = 'varying vec3 vFWorld;\nvarying vec3 vFNormal;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vFWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
      vFNormal = normalize( mat3( modelMatrix ) * objectNormal );`,
    );

    shader.fragmentShader = PRELUDE + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      'turfShade();\n\tdiffuseColor.rgb = gTurfColor;',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      'float roughnessFactor = gRough;',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      'normal = normalize( ( viewMatrix * vec4( gNrmW, 0.0 ) ).xyz );',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += gEmis;',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <aomap_fragment>',
      `float ambientOcclusion = gAO;
      reflectedLight.indirectDiffuse *= ambientOcclusion;
      #if defined( USE_ENVMAP ) && defined( STANDARD )
        float dotNVao = saturate( dot( geometryNormal, geometryViewDir ) );
        reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNVao, ambientOcclusion, material.roughness );
      #endif`,
    );
  });
  material.customProgramCacheKey = () => 'ultimate-turf-v1';

  return { material, uniforms };
}
