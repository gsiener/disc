import * as THREE from 'three';
import {
  hook, at, prelude, vertexPatch, FRAG_PARS, PART_DEFS, NOISE, PI_DEFS,
} from './Glsl.ts';
import type { DetailTextures } from './Detail.ts';
import type { Colourway } from './Tone.ts';
import { lin } from './Tone.ts';
import type { KitAtlas } from './Kit.ts';
import type { SharedUniforms, MatDetail } from './Shared.ts';

/**
 * ============================================================================
 *  JERSEY AND SHORTS
 * ============================================================================
 *
 * A jersey is not a coloured surface. Under a close crop it is:
 *
 *   a knit          interlocking loops, staggered row to row, with a directional
 *                   sheen that runs along the wale — which is why the same shirt
 *                   looks lighter down the front than across it.
 *   a mesh          real perforations where a real garment vents: the flanks
 *                   under the arm and the upper back. These are holes, not a
 *                   texture of holes; you see skin through them.
 *   flat-lock seams a twin-needle stitch, raised, at every panel boundary, hem,
 *                   cuff and collar.
 *   applied graphics a number that stands 0.4 mm proud of the fabric, is
 *                   glossier than it, and carries a stitched outline.
 *
 * The colourway is evaluated analytically from the garment's own uv rather than
 * baked, so the stripe edges stay razor sharp at any distance and cost nothing in
 * memory: two teams of seven share exactly one 512² SDF atlas between them.
 *
 * UV CONTRACT (from rig/Cloth.ts)
 *   jersey body   u wraps the torso — 0.25 chest centre, 0.75 spine, 0.0/0.5 the
 *                 flanks. v runs 0 at the hem to 1 at the collar. vSide == 0.
 *   jersey sleeve v runs 0 at the shoulder to ~0.9 at the cuff. vSide == ±1.
 *   shorts yoke   v 0 (waistband) to 0.35 (crotch). vSide == 0.
 *   shorts leg    v 0.35 (hip) to 1 (hem). vSide == ±1.
 */

export interface ClothInputs {
  colourway: Colourway;
  atlas: KitAtlas;
  /** The team's shared name strip — one row per squad member. */
  nameStrip: THREE.DataTexture;
  /** This player's row inside that strip, as (v origin, v span). */
  nameRow?: THREE.Vector2;
  detail: DetailTextures;
  shared: SharedUniforms;
  quality: MatDetail;
  number: number;
  height: number;
  seed: number;
}

export interface ClothMaterial {
  jersey: THREE.MeshPhysicalMaterial;
  shorts: THREE.MeshPhysicalMaterial;
  setSweat(v: number): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ GLSL */

const FABRIC_PARS = /* glsl */`
  uniform sampler2D uWeave;
  uniform sampler2D uKit;
  uniform sampler2D uName;
  uniform vec3 uPrimary, uSecondary, uAccent, uNumFill, uNumLine;
  uniform vec4 uPattern;    // pattern id, hoopCount, panelWidth, seed
  uniform vec4 uDigit;      // digit0 cell origin, digit1 cell origin
  uniform vec4 uNumCfg;     // digitCount, frontScale, backScale, nameOn
  uniform vec2 uNameRow;    // v origin, v span of this player's row in the team strip
  uniform vec2 uMarkCell;
  uniform vec2 uWeaveRep;
  uniform vec2 uHole;       // pitch, radius
  uniform float uSweat;
  uniform vec3 uSunView, uSunColor;
  uniform float uSunGlow, uTime;

  // The atlas stores distance normalised over ±14 texels of a 128-texel cell, so
  // one unit of the field is 0.21875 cell-widths. Knowing that constant lets the
  // threshold be derived from the *box* coordinate rather than from the sampled
  // value — which matters, because the box coordinate is continuous across the
  // join between two digits and the sampled value is not. Taking fwidth of the
  // latter draws a hairline down the middle of every two-digit number.
  #define SDF_RATE 4.5714
  float sdfCoverage(float d, float w, float bias) {
    return smoothstep(0.5 + bias - w, 0.5 + bias + w, d);
  }
  float kitSdf(vec2 org, vec2 luv) {
    return texture2D(uKit, org + clamp(luv, 0.006, 0.994) * 0.25).r;
  }

  /**
   * One cord of a flat-lock seam, as a Gaussian ridge at c of half-width w,
   * gated by g. Accumulates BOTH coverage and signed slope: the slope is the
   * derivative of the ridge and it is what puts a real bump into the normal —
   * coverage alone paints a line, which is what a printed-on seam looks like.
   *
   * A macro rather than a function because the two variants write to different
   * accumulators and GLSL ES 1.00 has no output parameters worth the noise. The
   * braces make each invocation a statement, so call sites take no semicolon.
   */
  #define SEAM_U(x, c, w, g) { float _t = ((x) - (c)) / (w); float _e = exp(-_t * _t) * (g); seam += _e; slopeU += _t * _e * 1.6; }
  #define SEAM_V(x, c, w, g) { float _t = ((x) - (c)) / (w); float _e = exp(-_t * _t) * (g); seam += _e; slopeV += _t * _e * 1.6; }
`;

const NUMBER_BLOCK = /* glsl */`
  /**
   * Lay a one- or two-digit number into the rectangle [c - h, c + h].
   * Returns fill, outline and the uv-space gradient of the field — the gradient
   * is the normal of the pressed edge, and it is most of why a transfer reads as
   * applied to the shirt rather than printed into it.
   *
   * Branch-free by construction: every texture read happens for every fragment
   * in the garment. Sampling inside a conditional is undefined behaviour once
   * implicit derivatives are involved, and on a tiled GPU it shows up as a
   * torn edge.
   */
  vec4 kitNumber(vec2 uv, vec2 c, vec2 h, float bevel) {
    vec2 q = (uv - c) / h;
    float inside = step(abs(q.x), 1.0) * step(abs(q.y), 1.0);
    // The torso's u runs from the athlete's left, across the chest, to their
    // right, and that is screen-right to screen-left from BOTH sides of the
    // shirt. Sampling the atlas straight off it prints every number and every
    // name in mirror writing — which is exactly what it did.
    q.x = -q.x;
    q = clamp(q, -1.0, 1.0);
    float two = step(1.5, uNumCfg.x);
    float side = step(0.0, q.x);
    // One digit spans the whole box; two split it down the middle.
    vec2 luv = vec2(mix(q.x * 0.5 + 0.5, q.x + 1.0 - side, two), q.y * 0.5 + 0.5);
    vec2 cell = mix(uDigit.xy, mix(uDigit.xy, uDigit.zw, side), two);
    float d = kitSdf(cell, luv);
    float w = max(max(fwidth(q.x) * mix(0.5, 1.0, two), 0.5 * fwidth(q.y)) * SDF_RATE, 0.0018);
    float fill = sdfCoverage(d, w, 0.0);
    float line = sdfCoverage(d, w, -0.155) - fill;
    float e = 0.010;
    float gx = (kitSdf(cell, luv + vec2(e, 0.0)) - d) * bevel;
    float gy = (kitSdf(cell, luv + vec2(0.0, e)) - d) * bevel;
    return vec4(fill, line, gx, gy) * inside;
  }
`;

/* --------------------------------------------------------------- builder */

function digitCells(a: KitAtlas, n: number): { count: number; c0: THREE.Vector2; c1: THREE.Vector2 } {
  const v = Math.max(0, Math.min(99, Math.round(n)));
  if (v < 10) return { count: 1, c0: a.digitCell[v], c1: a.digitCell[v] };
  return { count: 2, c0: a.digitCell[Math.floor(v / 10)], c1: a.digitCell[v % 10] };
}

export function makeClothMaterials(i: ClothInputs): ClothMaterial {
  const cw = i.colourway;
  const d = digitCells(i.atlas, i.number);
  const H = Math.max(1.2, i.height);

  const shared = {
    uWeave: { value: i.detail.weave },
    uKit: { value: i.atlas.texture },
    uName: { value: i.nameStrip },
    uPrimary: { value: lin(cw.primary) },
    uSecondary: { value: lin(cw.secondary) },
    uAccent: { value: lin(cw.accent) },
    uNumFill: { value: lin(cw.numberFill) },
    uNumLine: { value: lin(cw.numberOutline) },
    uPattern: { value: new THREE.Vector4(cw.pattern, 7, 0.055, i.seed % 1000 / 1000) },
    uDigit: { value: new THREE.Vector4(d.c0.x, d.c0.y, d.c1.x, d.c1.y) },
    uNumCfg: { value: new THREE.Vector4(d.count, 1, 1, i.nameRow ? 1 : 0) },
    uNameRow: { value: i.nameRow ? i.nameRow.clone() : new THREE.Vector2(0, 1) },
    uMarkCell: { value: i.atlas.markCell.clone() },
    uSweat: { value: 0 },
  };

  /* -------------------------------------------------------------- jersey */
  const jersey = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0,
    normalMap: i.detail.weave,
    // The knit's wales run up the garment, so the specular anisotropy has to run
    // along the bitangent. Rotating it is the difference between a fabric that
    // catches light down its length and one that reads as painted rubber.
    // Knit is anisotropic but only just. At 0.55 the stretched highlight read
    // as brushed steel across the chest, which is the loudest "this is plastic"
    // cue the garment had.
    anisotropy: 0.16,
    anisotropyRotation: Math.PI / 2,
    // Cloth is a poor specular reflector. Leaving three's default of 1.0 gives
    // a jersey the Fresnel of a lacquered surface.
    specularIntensity: 0.42,
    // Sheen at 0.55 with a near-white sheen colour turned every grazing angle
    // on the shoulder into a pale wash and made the shirt read as glass. A
    // performance knit has sheen; it does not have a satin.
    sheen: 0.28,
    sheenRoughness: 0.78,
    alphaTest: 0.5,
    side: THREE.FrontSide,
  });
  jersey.name = 'player.jersey';
  jersey.sheenColor.copy(lin(cw.primary)).lerp(new THREE.Color(1, 1, 1), 0.22);

  // Physical tile size: the garment's uv spans its own circumference, so the
  // repeat count has to be derived from the athlete, not fixed.
  const torsoCirc = 0.95 * (H / 1.8);
  const torsoLen = 0.62 * (H / 1.8);
  const TILE = 0.0195; // metres across one weave tile (14 loops)
  const jerseyUni = {
    ...shared,
    uWeaveRep: { value: new THREE.Vector2(torsoCirc / TILE, torsoLen / TILE) },
    uHole: { value: new THREE.Vector2(torsoCirc / 0.0042, 0.30) },
  };

  hook(jersey, (sh) => {
    Object.assign(sh.uniforms, jerseyUni, i.shared.uniforms);
    sh.vertexShader = vertexPatch(sh.vertexShader);
    sh.fragmentShader = prelude(sh.fragmentShader,
      PI_DEFS + FRAG_PARS + PART_DEFS + NOISE + FABRIC_PARS + NUMBER_BLOCK);

    sh.fragmentShader = at(sh.fragmentShader, 'map_fragment', {
      before: /* glsl */`
        float sleeve = step(0.5, abs(vSide));
        vec2 uvF = vSurfUv;
        // Sleeves are a separate loft with their own aspect; give them their own
        // weave scale or the knit changes size at the shoulder seam.
        vec2 rep = mix(uWeaveRep, uWeaveRep * vec2(0.42, 0.55), sleeve);
        vec2 wuv = uvF * rep;
        vec4 weave = texture2D(uWeave, wuv);

        /* ---------------- colourway ------------------------------------ */
        float pat = uPattern.x;
        vec3 base = uPrimary;
        float trim = 0.0;      // accent piping coverage
        float panel = 0.0;     // secondary panel coverage
        float uu = uvF.x, vv = uvF.y;
        // Distance to the two flank lines, in u.
        float flank = min(min(abs(uu), abs(uu - 1.0)), abs(uu - 0.5));

        if (pat < 0.5) {
          panel = 0.0;
        } else if (pat < 1.5) {
          // Side panel: a secondary band down each flank with accent piping.
          panel = 1.0 - smoothstep(uPattern.z, uPattern.z + 0.012, flank);
          trim = exp(-pow((flank - uPattern.z - 0.014) / 0.007, 2.0));
        } else if (pat < 2.5) {
          // Chest band.
          float b = smoothstep(0.50, 0.515, vv) * (1.0 - smoothstep(0.655, 0.67, vv));
          panel = b;
          trim = exp(-pow((vv - 0.495) / 0.012, 2.0)) + exp(-pow((vv - 0.672) / 0.012, 2.0));
        } else if (pat < 3.5) {
          // Shoulder yoke.
          panel = smoothstep(0.775, 0.795, vv);
          trim = exp(-pow((vv - 0.771) / 0.011, 2.0));
        } else {
          // Hoops.
          float k = fract(vv * uPattern.y);
          panel = smoothstep(0.47, 0.50, k) * (1.0 - smoothstep(0.97, 1.0, k));
          trim = 0.0;
        }
        // A sleeve always takes the yoke colour of the body it grows out of, or
        // the shoulder seam reads as a costume change.
        // A yoke crosses onto the sleeve CAP and stops. Taking the whole sleeve
        // makes the arms read as separate garments pulled on over the shirt.
        panel = mix(panel, max(panel, (1.0 - smoothstep(0.18, 0.34, vv)) * step(2.5, pat)), sleeve);
        base = mix(base, uSecondary, clamp(panel, 0.0, 1.0));
        // Collar rib and cuff band.
        float collar = smoothstep(0.945, 0.962, vv) * (1.0 - sleeve);
        // A cuff band is ~18 mm of a 16 cm sleeve. Taking a quarter of the
        // sleeve, as the first pass did, is not a cuff, it is an armband.
        float cuff = smoothstep(0.815, 0.845, vv) * sleeve;
        base = mix(base, uSecondary, collar * 0.92);
        base = mix(base, uAccent, cuff * 0.80);
        base = mix(base, uAccent, clamp(trim, 0.0, 1.0) * 0.75);
        // Hem stripe.
        float hemBand = (1.0 - smoothstep(0.030, 0.048, vv)) * (1.0 - sleeve);
        base = mix(base, uAccent, hemBand * 0.55);

        /* ---------------- vent mesh ------------------------------------ */
        // Real jerseys vent where the athlete actually sheds heat: the flanks
        // under the arm and the upper back between the scapulae.
        float ventFlank = (1.0 - smoothstep(0.030, 0.058, flank))
          * smoothstep(0.20, 0.28, vv) * (1.0 - smoothstep(0.74, 0.82, vv));
        float ventBack = (1.0 - smoothstep(0.075, 0.105, abs(uu - 0.75)))
          * smoothstep(0.72, 0.78, vv) * (1.0 - smoothstep(0.90, 0.945, vv));
        float vent = clamp(max(ventFlank, ventBack), 0.0, 1.0) * (1.0 - sleeve);

        vec2 hg = uvF * vec2(uHole.x, uHole.x * (rep.y / max(rep.x, 1e-3)));
        hg.x += mod(floor(hg.y), 2.0) * 0.5;
        vec2 hf = fract(hg) - 0.5;
        float hd = length(hf) * 2.0;
        float hw = max(fwidth(hd), 0.02);
        float holeC = smoothstep(uHole.y + hw, uHole.y - hw, hd) * vent;
        // Below a pixel a hole cannot be cut, only darkened — punching it anyway
        // is what turns a mesh panel into crawling static at twenty metres.
        float resolvable = 1.0 - smoothstep(0.35, 0.9, hw / max(uHole.y, 1e-3));
        float cut = holeC * resolvable;
        float shade = holeC * (1.0 - resolvable);

        /* ---------------- flat-lock stitching -------------------------- */
        // A flat-lock is a twin-needle seam: two parallel cords about 4 mm apart
        // with a dashed thread crossing between them. Each cord contributes both
        // a coverage term and a signed slope, and the slope is what puts a real
        // ridge into the normal instead of a painted line.
        float seam = 0.0, slopeU = 0.0, slopeV = 0.0;
        float body0 = 1.0 - sleeve;
        SEAM_U(flank, 0.0075, 0.0028, 1.0)
        SEAM_U(flank, 0.0125, 0.0028, 1.0)
        SEAM_V(vv, 0.0255, 0.0034, body0)
        SEAM_V(vv, 0.0305, 0.0034, body0)
        SEAM_V(vv, 0.9380, 0.0034, body0)
        SEAM_V(vv, 0.6935, 0.0032, sleeve)
        SEAM_V(vv, 0.7005, 0.0032, sleeve)
        SEAM_V(vv, 0.0550, 0.0050, sleeve)
        seam = clamp(seam + clamp(trim, 0.0, 1.0) * 0.30, 0.0, 1.0);
        // The cross-thread. Dashed along the seam, and retired to a constant when
        // the dash pitch falls below a pixel so it cannot crawl.
        float dashC = uvF.x * rep.x * 0.9 + uvF.y * rep.y * 0.35;
        float dashW = max(fwidth(dashC), 0.001);
        float dash = mix(smoothstep(0.5 - dashW, 0.5 + dashW, fract(dashC)), 0.5,
                         smoothstep(0.25, 0.6, dashW));
        float stitch = seam * mix(0.45, 1.0, dash);
        float stitchRelief = slopeV * 0.9;

        /* ---------------- applied graphics ----------------------------- */
        float body = 1.0 - sleeve;
        // Front number on the chest; back number larger, between the blades.
        vec4 fnum = kitNumber(uvF, vec2(0.25, 0.620), vec2(0.050, 0.092), 34.0);
        vec4 bnum = kitNumber(uvF, vec2(0.75, 0.560), vec2(0.079, 0.142), 34.0);
        vec4 num = (fnum + bnum) * body;
        // Club mark on the wearer's right chest.
        vec2 mq = (uvF - vec2(0.187, 0.760)) / vec2(0.034, 0.052);
        float mIn = step(abs(mq.x), 1.0) * step(abs(mq.y), 1.0) * body;
        mq.x = -mq.x;
        float md = texture2D(uKit, uMarkCell + clamp(clamp(mq, -1.0, 1.0) * 0.5 + 0.5, 0.01, 0.99) * 0.25).r;
        float mark = sdfCoverage(md, max(fwidth(mq.x) * 0.5 * SDF_RATE, 0.002), 0.0) * mIn;
        // Name across the shoulders, arched the way a real strip is heat-set.
        vec2 nq = (uvF - vec2(0.75, 0.800)) / vec2(0.100, 0.024);
        nq.y -= 0.50 * (1.0 - clamp(nq.x * nq.x, 0.0, 1.0));
        float nIn = step(abs(nq.x), 1.0) * step(abs(nq.y), 1.0) * body * step(0.5, uNumCfg.w);
        nq.x = -nq.x;
        // One strip per TEAM, one row per player: the lookup is the player's own
        // row window, and the 0.004 inset keeps the bilinear tap off its border.
        vec2 nuv = clamp(clamp(nq, -1.0, 1.0) * 0.5 + 0.5, 0.004, 0.996);
        nuv.y = uNameRow.x + nuv.y * uNameRow.y;
        float nd = texture2D(uName, nuv).r;
        float nw = max(max(fwidth(nq.x) * 0.5, fwidth(nq.y) * 0.5) * 6.4, 0.002);
        float nameC = sdfCoverage(nd, nw, 0.0) * nIn;
        float nameL = (sdfCoverage(nd, nw, -0.16) * nIn - nameC);
        float gfx = clamp(num.x + mark + nameC, 0.0, 1.0);
        float gfxLine = clamp(num.y + nameL, 0.0, 1.0);

        /* ---------------- sweat ---------------------------------------- */
        // Sweat maps to where a shirt actually soaks: sternum, spine, armpits.
        float sweatZone = clamp(
            exp(-pow((uu - 0.25) / 0.10, 2.0)) * smoothstep(0.22, 0.42, vv) * (1.0 - smoothstep(0.72, 0.90, vv)) * 0.95
          + exp(-pow((uu - 0.75) / 0.12, 2.0)) * smoothstep(0.18, 0.40, vv) * (1.0 - smoothstep(0.80, 0.96, vv))
          + (1.0 - smoothstep(0.04, 0.10, flank)) * smoothstep(0.66, 0.80, vv) * 0.9
          + sleeve * smoothstep(0.0, 0.25, vv) * 0.7, 0.0, 1.0);
        // The wet patch has a ragged tide line, never a soft airbrush.
        float tide = mfbm(uvF * vec2(9.0, 7.0) + uPattern.w * 31.0, 3);
        float wet = clamp((sweatZone * (0.65 + 0.8 * uSweat) - (1.05 - uSweat * 1.35) - (tide - 0.5) * 0.45) * 3.2, 0.0, 1.0);
        wet *= step(0.02, uSweat);
      `,
      after: /* glsl */`
        vec3 cloth = base;
        // Yarn-to-yarn dye variation. Uniform colour is the plastic tell.
        cloth *= 0.94 + 0.12 * weave.a + (mhash12(floor(wuv * vec2(1.0, 14.0))) - 0.5) * 0.05;
        cloth *= 1.0 - 0.22 * vCrease;
        // Wet fabric darkens hard — the water fills the air gaps in the knit.
        cloth *= mix(1.0, 0.52, wet);
        // Stitching is a different yarn: denser, slightly off-shade.
        cloth = mix(cloth, cloth * 0.86 + uSecondary * 0.10, stitch * 0.7);
        // Unresolvable mesh holes darken instead of cutting.
        cloth *= 1.0 - 0.55 * shade;
        // Graphics sit on top of everything, including the sweat.
        cloth = mix(cloth, uNumLine, gfxLine);
        cloth = mix(cloth, uNumFill, gfx);

        diffuseColor.rgb *= cloth;
        diffuseColor.a *= 1.0 - cut;
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'roughnessmap_fragment', {
      after: /* glsl */`
        float rg = 0.74 - 0.16 * weave.a;
        rg += 0.06 * (1.0 - smoothstep(0.0, 0.6, vv)) * (1.0 - sleeve);   // hem is fuzzier
        rg = mix(rg, 0.30, gfx);        // heat-pressed vinyl is glossy
        rg = mix(rg, 0.62, gfxLine);    // its stitched outline is not
        rg -= stitch * 0.10;
        rg = mix(rg, 0.24, wet * 0.9);
        roughnessFactor = clamp(rg, 0.10, 0.98);
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'normal_fragment_maps', {
      replace: /* glsl */`
        {
          vec2 kn = (weave.xy - 0.5) * 2.0 * 0.9;
          ${i.quality > 0 ? `
          // Panel drape. Deliberately NOT a second tap of the knit map at a
          // tenth of its rate: that prints a 13 mm waffle across the whole
          // shirt and reads as quilting, which is precisely what the first
          // pass did. A two-octave fbm gradient is a fold.
          vec2 dsc = uvF * vec2(6.0, 4.5) + uPattern.w * 17.0;
          float d0 = mfbm(dsc, 2);
          kn += vec2(d0 - mfbm(dsc + vec2(0.012, 0.0), 2),
                     d0 - mfbm(dsc + vec2(0.0, 0.012), 2)) * 5.5;` : ''}
          // Flat-lock seams stand proud, and the number is a pressed transfer
          // with a bevelled edge — that bevel is most of why it reads as applied.
          kn.y += stitchRelief * 0.75;
          kn -= num.zw;
          kn *= mix(1.0, 0.35, wet);
          normal = normalize(tbn * vec3(kn, 1.0));
        }
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'lights_fragment_end', {
      after: /* glsl */`
        {
          // Thin fabric over a lit shoulder glows at the edge. One term, and it
          // is the difference between cloth and sheet metal on a rim light.
          vec3 Lv = normalize(uSunView);
          float bk = pow(clamp(dot(geometryViewDir, -normalize(-Lv + geometryNormal * 0.4)), 0.0, 1.0), 3.0);
          reflectedLight.indirectDiffuse += uSunColor * uSunGlow * bk * 0.10
            * diffuseColor.rgb * (1.0 - gfx);
          reflectedLight.indirectDiffuse *= 1.0 - 0.55 * vCrease - 0.25 * shade;
        }
      `,
    });
  });
  jersey.customProgramCacheKey = () => `ult.jersey.${i.quality}`;
  jersey.needsUpdate = true;

  /* -------------------------------------------------------------- shorts */
  const shorts = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.76,
    metalness: 0,
    normalMap: i.detail.weave,
    anisotropy: 0.14,
    anisotropyRotation: Math.PI / 2,
    specularIntensity: 0.38,
    sheen: 0.24,
    sheenRoughness: 0.80,
  });
  shorts.name = 'player.shorts';
  shorts.sheenColor.copy(lin(cw.shorts)).lerp(new THREE.Color(1, 1, 1), 0.18);

  const hipCirc = 1.02 * (H / 1.8);
  const shortsUni = {
    ...shared,
    uShortsBase: { value: lin(cw.shorts) },
    uShortsTrim: { value: lin(cw.shortsTrim) },
    uWeaveRep: { value: new THREE.Vector2(hipCirc / TILE, (0.42 * H / 1.8) / TILE) },
    uHole: { value: new THREE.Vector2(1, 1) },
  };

  hook(shorts, (sh) => {
    Object.assign(sh.uniforms, shortsUni, i.shared.uniforms);
    sh.vertexShader = vertexPatch(sh.vertexShader);
    sh.fragmentShader = prelude(sh.fragmentShader,
      PI_DEFS + FRAG_PARS + PART_DEFS + NOISE + FABRIC_PARS + /* glsl */`
      uniform vec3 uShortsBase, uShortsTrim;
    `);

    sh.fragmentShader = at(sh.fragmentShader, 'map_fragment', {
      before: /* glsl */`
        float leg = step(0.5, abs(vSide));
        vec2 uvF = vSurfUv;
        vec2 rep = uWeaveRep;
        vec2 wuv = uvF * rep;
        vec4 weave = texture2D(uWeave, wuv);
        float uu = uvF.x, vv = uvF.y;
        float flank = min(min(abs(uu), abs(uu - 1.0)), abs(uu - 0.5));

        vec3 base = uShortsBase;
        // Waistband: a wider, denser elastic weave, always a shade darker.
        float band = 1.0 - smoothstep(0.030, 0.052, vv);
        base = mix(base, uShortsBase * 0.72 + uShortsTrim * 0.10, band);
        // Side stripe down the outer seam of each leg, stopping at the hem.
        float stripe = (1.0 - smoothstep(0.006, 0.013, flank)) * step(0.10, vv);
        base = mix(base, uShortsTrim, stripe * 0.95);
        // Hem band.
        float hem = smoothstep(0.945, 0.965, vv) * leg;
        base = mix(base, uShortsTrim, hem * 0.45);

        float seam = 0.0;
        seam += exp(-pow((flank - 0.010) / 0.0040, 2.0));
        seam += exp(-pow((vv - 0.056) / 0.0050, 2.0));
        seam += exp(-pow((vv - 0.930) / 0.0045, 2.0)) * leg;
        seam = clamp(seam, 0.0, 1.0);
        float stitch = seam * mix(0.5, 1.0, step(0.5, fract(uvF.x * rep.x * 0.9 + uvF.y * 4.0)));
        // Elastic ribbing across the waistband, which is a coarser knit again.
        float rib = band * (0.5 + 0.5 * sin(uvF.x * rep.x * 2.6));

        float sweatZone = clamp(smoothstep(0.28, 0.05, vv) * 0.9
          + (1.0 - smoothstep(0.04, 0.12, flank)) * 0.4, 0.0, 1.0);
        float tide = mfbm(uvF * vec2(8.0, 6.0), 3);
        float wet = clamp((sweatZone * (0.6 + 0.8 * uSweat) - (1.05 - uSweat * 1.25) - (tide - 0.5) * 0.4) * 3.0, 0.0, 1.0);
        wet *= step(0.02, uSweat);
      `,
      after: /* glsl */`
        vec3 cloth = base;
        cloth *= 0.94 + 0.12 * weave.a;
        cloth *= 1.0 - 0.24 * vCrease;
        cloth *= mix(1.0, 0.58, wet);
        cloth = mix(cloth, cloth * 0.85, stitch * 0.7);
        cloth *= 1.0 - 0.10 * rib;
        diffuseColor.rgb *= cloth;
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'roughnessmap_fragment', {
      after: /* glsl */`
        float rg = 0.78 - 0.14 * weave.a + 0.05 * band;
        rg -= stitch * 0.10;
        rg = mix(rg, 0.28, wet * 0.9);
        roughnessFactor = clamp(rg, 0.12, 0.98);
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'normal_fragment_maps', {
      replace: /* glsl */`
        {
          vec2 kn = (weave.xy - 0.5) * 2.0 * 0.85;
          ${i.quality > 0 ? `kn += (texture2D(uWeave, wuv * 0.13).xy - 0.5) * 2.0 * 0.40;` : ''}
          kn.y += stitch * 0.5 * sign(sin(vv * 700.0));
          kn.x += rib * 0.35 * cos(uvF.x * rep.x * 2.6);
          kn *= mix(1.0, 0.4, wet);
          normal = normalize(tbn * vec3(kn, 1.0));
        }
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'lights_fragment_end', {
      after: '\n reflectedLight.indirectDiffuse *= 1.0 - 0.5 * vCrease;\n',
    });
  });
  shorts.customProgramCacheKey = () => `ult.shorts.${i.quality}`;
  shorts.needsUpdate = true;

  return {
    jersey,
    shorts,
    setSweat(v: number) {
      shared.uSweat.value = v;
      jerseyUni.uSweat.value = v;
      shortsUni.uSweat.value = v;
    },
    dispose() { jersey.dispose(); shorts.dispose(); },
  };
}
