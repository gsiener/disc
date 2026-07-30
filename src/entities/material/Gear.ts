import * as THREE from 'three';
import {
  hook, at, prelude, vertexPatch, FRAG_PARS, PART_DEFS, NOISE, PI_DEFS,
} from './Glsl.ts';
import type { DetailTextures } from './Detail.ts';
import type { Colourway } from './Tone.ts';
import { lin } from './Tone.ts';
import type { SharedUniforms, MatDetail } from './Shared.ts';

/**
 * ============================================================================
 *  SOCKS AND CLEATS
 * ============================================================================
 *
 * The two garments nobody budgets for and everybody notices, because they are
 * the only part of the athlete that touches the world. A clean white sock and a
 * clean black shoe read as a mannequin's feet no matter what the rest of the
 * kit is doing; the ninety minutes of grass they have been standing in is the
 * entire cue.
 *
 * SOCK. A weft rib knit, which is a much coarser structure than the jersey's
 * interlock: 1×1 ribs run vertically up the leg at roughly 4 mm pitch, they are
 * what makes a sock stretch around a calf, and they catch light in vertical
 * bands you can count from ten metres. The turnover cuff is a second, denser
 * rib. Below the ankle everything is stained: chlorophyll green at the toe box
 * where the foot ploughs, brown at the heel.
 *
 * SHOE. Three materials in one shell and the split is the whole job — a
 * synthetic upper (soft, scuffed, matte), a moulded outsole plate (hard, glossy,
 * pebble-grained) and the studs. They are separated on BIND-SPACE HEIGHT rather
 * than on uv, because the studs are their own little lofts with their own uv and
 * any uv-based split leaves a quarter of every stud wearing the upper's shader.
 *
 * UV CONTRACT (from rig/Cloth.ts)
 *   sock   u wraps the leg — 0.25 shin, 0.75 calf. v 0.34 at the cuff to 0.99
 *          at the ankle. Fold rings above the cuff run v 0.34 → 0.395.
 *   shoe   u wraps the last — 0.25 instep, 0.75 outsole. v 0 heel to 1 toe.
 */

export interface GearInputs {
  colourway: Colourway;
  detail: DetailTextures;
  shared: SharedUniforms;
  quality: MatDetail;
  height: number;
  seed: number;
  /** 0 fresh out of the bag, 1 late in the second half. Drives stain and scuff. */
  wear: number;
}

export interface GearMaterial {
  socks: THREE.MeshPhysicalMaterial;
  shoes: THREE.MeshPhysicalMaterial;
  setSweat(v: number): void;
  setWear(v: number): void;
  dispose(): void;
}

/* ------------------------------------------------------------------- GLSL */

const GEAR_PARS = /* glsl */`
  uniform sampler2D uWeave;
  uniform sampler2D uGrunge;
  uniform vec3 uBase, uBand, uAccent;
  uniform vec4 uCtl;        // wear, sweat, seed, bodyScale
  uniform vec2 uRep;
  uniform vec3 uSunView, uSunColor;
  uniform float uSunGlow, uTime;

  /** Circular distance between two wrap coordinates, in turns. */
  float wrapD(float a, float b) { float d = fract(a - b + 0.5) - 0.5; return abs(d); }

  /** Grass: chlorophyll is a narrow green, and it stains yellow-green, not lawn
   *  green. Mud over the top of it is what makes the toe of a cleat read used. */
  vec3 stainOn(vec3 c, float grass, float mud) {
    c = mix(c, mix(c, vec3(0.118, 0.145, 0.032), 0.80), clamp(grass, 0.0, 1.0));
    return mix(c, mix(c, vec3(0.105, 0.078, 0.048), 0.86), clamp(mud, 0.0, 1.0));
  }
`;

/* --------------------------------------------------------------- builder */

export function makeGearMaterials(i: GearInputs): GearMaterial {
  const cw = i.colourway;
  const hs = Math.max(1.2, i.height) / 1.8;

  const ctl = { value: new THREE.Vector4(i.wear, 0, (i.seed % 997) / 997, hs) };

  /* --------------------------------------------------------------- socks */
  const socks = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.86,
    metalness: 0,
    normalMap: i.detail.weave,
    // Knitwear is the sheeniest thing an athlete wears — a sock catches a low
    // sun along every rib. Without sheen it is a painted tube.
    sheen: 0.62,
    sheenRoughness: 0.66,
    specularIntensity: 0.30,
    side: THREE.FrontSide,
  });
  socks.name = 'player.socks';
  socks.sheenColor.copy(lin(cw.sock)).lerp(new THREE.Color(1, 1, 1), 0.35);

  // Calf circumference ≈ 0.36 m at H = 1.8; one weave tile is 14 loops ≈ 19.5 mm,
  // but a rib knit is coarser than the jersey's interlock, so the sock takes
  // roughly half the tile count around and a longer stretch along.
  const sockUni = {
    uWeave: { value: i.detail.weave },
    uGrunge: { value: i.detail.grunge },
    uBase: { value: lin(cw.sock) },
    uBand: { value: lin(cw.sockBand) },
    uAccent: { value: lin(cw.accent) },
    uCtl: ctl,
    uRep: { value: new THREE.Vector2(0.36 * hs / 0.0165, 0.34 * hs / 0.0165) },
  };

  hook(socks, (sh) => {
    Object.assign(sh.uniforms, sockUni, i.shared.uniforms);
    sh.vertexShader = vertexPatch(sh.vertexShader);
    sh.fragmentShader = prelude(sh.fragmentShader,
      PI_DEFS + FRAG_PARS + PART_DEFS + NOISE + GEAR_PARS);

    sh.fragmentShader = at(sh.fragmentShader, 'map_fragment', {
      before: /* glsl */`
        vec2 uvF = vSurfUv;
        float uu = uvF.x, vv = uvF.y;
        vec2 wuv = uvF * uRep;
        vec4 weave = texture2D(uWeave, wuv);
        vec4 gr = texture2D(uGrunge, uvF * vec2(5.0, 3.0));

        /* ---- rib knit ------------------------------------------------- */
        // 1x1 rib: a wale standing proud, a wale sunk, ~4 mm apart around the
        // leg. Everything about a sock's read comes off this one frequency.
        float ribN = 34.0;
        float ribPhase = uu * ribN;
        float rib = 0.5 - 0.5 * cos(ribPhase * PI2);
        // The cuff is a heavier rib, half the count and twice the depth.
        float cuff = 1.0 - smoothstep(0.400, 0.455, vv);
        float cuffRib = 0.5 - 0.5 * cos(uu * (ribN * 0.5) * PI2);
        rib = mix(rib, cuffRib, cuff);
        // Anti-alias the rib away before it turns into moire on a wide shot.
        float ribW = fwidth(ribPhase);
        float ribFade = 1.0 - smoothstep(0.22, 0.55, ribW);
        rib = mix(0.5, rib, ribFade);

        /* ---- colourway -------------------------------------------------- */
        vec3 base = uBase;
        // Two hoops just under the turnover — the standard club sock.
        float hoopA = smoothstep(0.455, 0.470, vv) * (1.0 - smoothstep(0.512, 0.527, vv));
        float hoopB = smoothstep(0.540, 0.555, vv) * (1.0 - smoothstep(0.575, 0.590, vv));
        base = mix(base, uBand, clamp(hoopA + hoopB * 0.75, 0.0, 1.0));
        base = mix(base, uBand * 0.85 + uAccent * 0.15, cuff * 0.55);
        // Heel and toe are a reinforced, denser yarn — always a shade off.
        float heelToe = smoothstep(0.86, 0.93, vv);
        base = mix(base, base * 0.88, heelToe * 0.6);

        /* ---- soil ------------------------------------------------------- */
        float w = uCtl.x;
        float grass = clamp((smoothstep(0.80, 1.00, vv) * 0.9 + gr.g * 0.5 - 0.25) * w * 1.7, 0.0, 1.0);
        float mud = clamp((smoothstep(0.88, 1.00, vv) * gr.y * 1.4 - 0.15) * w * 1.5, 0.0, 1.0);
        // A splash line up the shin: turf thrown by the other foot.
        float splash = clamp(gr.x * smoothstep(0.72, 0.98, vv) * w * 1.2 - 0.30, 0.0, 1.0);

        /* ---- sweat ------------------------------------------------------- */
        float sweatZone = cuff * 0.8 + smoothstep(0.78, 0.95, vv) * 0.7;
        float wet = clamp(sweatZone * uCtl.y * 1.4 - 0.20, 0.0, 1.0);
      `,
      after: /* glsl */`
        vec3 knit = base;
        // Yarn shading: the standing wale catches light, the sunk one sits in
        // its own shadow. This is the entire difference between knit and tube.
        knit *= 0.855 + 0.235 * rib;
        knit *= 0.93 + 0.14 * weave.a;
        knit *= 1.0 - 0.28 * vCrease;
        knit = stainOn(knit, grass + splash * 0.6, mud);
        knit *= mix(1.0, 0.62, wet);
        diffuseColor.rgb *= knit;
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'roughnessmap_fragment', {
      after: /* glsl */`
        float rg = 0.90 - 0.10 * rib - 0.10 * weave.a;
        rg += 0.04 * cuff;
        rg = mix(rg, 0.34, wet * 0.85);
        rg = mix(rg, 0.80, clamp(mud, 0.0, 1.0) * 0.7);
        roughnessFactor = clamp(rg, 0.22, 0.99);
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'normal_fragment_maps', {
      replace: /* glsl */`
        {
          vec2 kn = (weave.xy - 0.5) * 2.0 * 0.55;
          // The rib is a real corrugation, so its slope — the derivative of the
          // cosine — goes into the normal. Painting the bands into albedo alone
          // is exactly what makes procedural knitwear look printed.
          kn.x += sin(ribPhase * PI2) * 0.62 * ribFade * mix(1.0, 1.35, cuff);
          kn *= mix(1.0, 0.45, wet);
          normal = normalize(tbn * vec3(kn, 1.0));
        }
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'lights_fragment_end', {
      after: /* glsl */`
        {
          // A sock is thin and it is lit from behind on every stride.
          vec3 Lv = normalize(uSunView);
          float bk = pow(clamp(dot(geometryViewDir, -normalize(-Lv + geometryNormal * 0.45)), 0.0, 1.0), 2.6);
          reflectedLight.indirectDiffuse += uSunColor * uSunGlow * bk * 0.20 * diffuseColor.rgb;
          reflectedLight.indirectDiffuse *= 1.0 - 0.55 * vCrease;
        }
      `,
    });
  });
  socks.customProgramCacheKey = () => `ult.socks.${i.quality}`;
  socks.needsUpdate = true;

  /* --------------------------------------------------------------- shoes */
  const shoes = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.42,
    metalness: 0,
    normalMap: i.detail.grunge,
    // A moulded TPU outsole is a clearcoated plastic and reads wrong without it;
    // the upper takes the coat down to nothing in lights_physical_fragment.
    clearcoat: 0.45,
    clearcoatRoughness: 0.25,
    side: THREE.FrontSide,
  });
  shoes.name = 'player.shoes';

  const shoeUni = {
    uWeave: { value: i.detail.weave },
    uGrunge: { value: i.detail.grunge },
    uBase: { value: lin(cw.shoe) },
    uBand: { value: lin(cw.shoeAccent) },
    uAccent: { value: lin(cw.accent) },
    uCtl: ctl,
    uRep: { value: new THREE.Vector2(9.0, 5.0) },
  };

  hook(shoes, (sh) => {
    Object.assign(sh.uniforms, shoeUni, i.shared.uniforms);
    sh.vertexShader = vertexPatch(sh.vertexShader);
    sh.fragmentShader = prelude(sh.fragmentShader,
      PI_DEFS + FRAG_PARS + PART_DEFS + NOISE + GEAR_PARS);

    sh.fragmentShader = at(sh.fragmentShader, 'map_fragment', {
      before: /* glsl */`
        vec2 uvF = vSurfUv;
        float uu = uvF.x, vv = uvF.y;
        float hs = uCtl.w;
        vec4 gr = texture2D(uGrunge, uvF * uRep);
        vec4 gr2 = texture2D(uGrunge, uvF * uRep * 4.3 + 0.37);

        /* ---- the three materials --------------------------------------- */
        // Bind-space height, not uv. The last's own sole plate tops out at
        // 0.010 H/1.8 and its toe cap starts at 0.025, so one threshold splits
        // upper from outsole along the whole shoe AND catches the studs, which
        // are separate lofts hanging below the plate with uv of their own.
        float sole = 1.0 - smoothstep(0.0135 * hs, 0.0235 * hs, vBind.y);
        float stud = 1.0 - smoothstep(0.0016 * hs, 0.0034 * hs, vBind.y);
        float upper = 1.0 - sole;

        /* ---- upper ------------------------------------------------------ */
        vec3 base = uBase;
        // Heel counter: a darker, stiffer panel wrapping the back third.
        float counter = 1.0 - smoothstep(0.16, 0.30, vv);
        base = mix(base, base * 0.78, counter * 0.7);
        // Lateral flash — the one graphic every boot has, swept from the
        // midfoot up toward the laces.
        float top = 1.0 - smoothstep(0.13, 0.26, wrapD(uu, 0.25));
        float flankL = 1.0 - smoothstep(0.055, 0.13, wrapD(uu, 0.02));
        float flankR = 1.0 - smoothstep(0.055, 0.13, wrapD(uu, 0.48));
        float flank = max(flankL, flankR);
        float sweep = exp(-pow((vv - 0.42) / 0.055, 2.0)) + exp(-pow((vv - 0.55) / 0.030, 2.0)) * 0.6;
        base = mix(base, uBand, clamp(flank * sweep, 0.0, 1.0) * 0.85 * upper);
        // A midsole stripe along the whole length, which is what actually reads
        // as a cleat from ten metres — the flash never does.
        float midsole = (1.0 - smoothstep(0.030, 0.075, wrapD(uu, 0.75))) * (1.0 - sole);
        base = mix(base, uBand * 0.75 + uBase * 0.25, midsole * 0.55);

        /* ---- lace panel -------------------------------------------------- */
        float lz = top * smoothstep(0.16, 0.26, vv) * (1.0 - smoothstep(0.60, 0.72, vv));
        float du = (uu - 0.25);
        // Two eyelet rows, and cords crossing between them.
        float eyeRow = 1.0 - smoothstep(0.020, 0.034, abs(abs(du) - 0.052));
        float eyeT = fract(vv * 12.0);
        float eyelet = eyeRow * lz * (1.0 - smoothstep(0.16, 0.30, abs(eyeT - 0.5)));
        float cordA = 1.0 - smoothstep(0.010, 0.020, abs(du * 3.6 + fract(vv * 6.0) - 0.5) * 0.5);
        float cordB = 1.0 - smoothstep(0.010, 0.020, abs(-du * 3.6 + fract(vv * 6.0 + 0.5) - 0.5) * 0.5);
        float lace = lz * clamp(cordA + cordB, 0.0, 1.0) * (1.0 - smoothstep(0.075, 0.10, abs(du)));
        // The tongue sits under the cords, in a softer, darker material.
        float tongue = lz * (1.0 - smoothstep(0.030, 0.055, abs(du)));
        base = mix(base, base * 0.66, tongue * 0.8);
        base = mix(base, base * 0.30, eyelet * 0.9);
        base = mix(base, mix(uBase, vec3(1.0), 0.55), lace * 0.85);

        /* ---- outsole ----------------------------------------------------- */
        vec3 plate = mix(uBase * 0.30, uBand * 0.55, 0.30);
        // Moulded ribs radiating across the plate, plus the stud bosses.
        float mould = 0.5 + 0.5 * sin(vv * 46.0 + sin(uu * PI2) * 1.7);
        plate *= 0.86 + 0.24 * mould;
        plate = mix(plate, uBand * 0.55, stud * 0.75);
        base = mix(base, plate, sole);

        /* ---- soil and scuff ---------------------------------------------- */
        float w = uCtl.x;
        // Toe box and the medial side take the abuse; the heel stays cleaner.
        float scuffZone = smoothstep(0.55, 1.00, vv) * 0.9 + counter * 0.25;
        float scuff = clamp((gr.x * 1.5 - 0.35) * scuffZone * w, 0.0, 1.0) * upper;
        float grass = clamp((smoothstep(0.50, 1.00, vv) * 0.85 + gr2.g * 0.6 - 0.42) * w * 2.0, 0.0, 1.0);
        float mud = clamp((sole * 0.8 + smoothstep(0.72, 1.0, vv) * 0.5) * gr.y * w * 1.9 - 0.10, 0.0, 1.0);
      `,
      after: /* glsl */`
        vec3 shoe = base;
        // Synthetic uppers are a thermo-bonded film over a mesh: a fine grain
        // that never goes flat, plus the creases across the flex point.
        shoe *= 0.90 + 0.18 * gr.z;
        float flex = exp(-pow((vv - 0.63) / 0.06, 2.0)) * upper
          * (0.4 + 0.6 * (0.5 + 0.5 * sin(uu * 26.0 + vv * 40.0)));
        shoe *= 1.0 - 0.16 * flex;
        shoe = mix(shoe, shoe * 1.14 + vec3(0.015), scuff * 0.55);
        shoe = stainOn(shoe, grass, mud);
        shoe *= 1.0 - 0.30 * vCrease;
        diffuseColor.rgb *= shoe;
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'roughnessmap_fragment', {
      after: /* glsl */`
        // The single most useful line in this material: three surfaces, three
        // roughnesses. A cleat rendered at one roughness is a plastic toy.
        float rg = mix(0.38, 0.62, sole);
        rg = mix(rg, 0.30, stud * 0.6);
        rg += 0.16 * scuff + 0.10 * lace + 0.05 * tongue;
        rg = mix(rg, 0.88, clamp(mud, 0.0, 1.0) * 0.8);
        rg -= 0.06 * gr.z;
        roughnessFactor = clamp(rg, 0.14, 0.96);
      `,
    });

    // `material` does not exist until lights_physical_fragment builds it, so the
    // coat has to be re-pitched here rather than alongside the roughness.
    sh.fragmentShader = at(sh.fragmentShader, 'lights_physical_fragment', {
      after: /* glsl */`
        #ifdef USE_CLEARCOAT
          // Only the moulded plate is lacquered. A clearcoated textile upper is
          // the single most common "everything looks wet" mistake in a kit.
          material.clearcoat = clamp(0.15 + 0.85 * sole - 0.5 * mud, 0.0, 1.0);
          material.clearcoatRoughness = clamp(mix(0.55, 0.09, sole) + 0.45 * mud, 0.02, 0.95);
        #endif
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'normal_fragment_maps', {
      replace: /* glsl */`
        {
          vec2 gn = (gr.xy - 0.5) * 2.0 * 0.35 * (0.5 + 0.8 * upper);
          ${i.quality > 0 ? 'gn += (gr2.xy - 0.5) * 2.0 * 0.22;' : ''}
          // Stitched overlays on the upper and the mould line on the plate.
          gn.y += flex * 1.1;
          gn.y += sole * cos(vv * 46.0 + sin(uu * PI2) * 1.7) * 0.55;
          gn.x += lace * 0.9 - eyelet * 1.2;
          normal = normalize(tbn * vec3(gn, 1.0));
        }
      `,
    });

    sh.fragmentShader = at(sh.fragmentShader, 'lights_fragment_end', {
      after: '\n reflectedLight.indirectDiffuse *= 1.0 - 0.5 * vCrease;\n',
    });
  });
  shoes.customProgramCacheKey = () => `ult.shoes.${i.quality}`;
  shoes.needsUpdate = true;

  return {
    socks,
    shoes,
    setSweat(v: number) { (ctl.value as THREE.Vector4).y = v; },
    setWear(v: number) { (ctl.value as THREE.Vector4).x = v; },
    dispose() { socks.dispose(); shoes.dispose(); },
  };
}
