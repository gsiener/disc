import * as THREE from 'three';
import { hash2 } from '../../util/Noise';
import type { Ctx } from '../../core/Ctx';
import { Mesher, parts, strut, UNIT_BOX, type Part, type RGB, type V3 } from './Geo';
import type { StadiumMaterials } from './Materials';
import { BASE_PERIMETER, ROOF, roofBackOff, roofYAt, COLUMN_OFF, ptAt, ringTable, type RingPt } from './Layout';

/**
 * Cantilever roof: a continuous ring canopy carried on radial steel trusses,
 * propped at the back by lattice columns. The leading edge is a deep fascia
 * (the ribbon board hangs off it) and the underside is deliberately open so the
 * truss work reads from any low angle inside the bowl.
 *
 * The canopy is what puts the signature hard shadow line across the stands when
 * the sun is low, so the deck casts shadows at every tier above `low`.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS SO MUCH SMALL METALWORK UP HERE
 * ---------------------------------------------------------------------------
 * A stadium roof is about a hectare of surface and, from the establishing
 * camera, roughly a quarter of the frame. One material at one value over that
 * area reads as a grey slab no matter how good the shader is, so the canopy
 * gets what a real one has and for the same reasons:
 *
 *   • **Standing seams** every 2.5 m — the sheet comes in bays and the seams
 *     are what give the roof its scale. Without them the eye has no way to
 *     judge how big the building is.
 *   • **A gutter and a fascia return** at the leading edge, so the canopy has
 *     a readable thickness and a shadow line under it instead of ending in a
 *     zero-width cut.
 *   • **Purlins** on the underside at close centres, because from inside the
 *     bowl you look straight up at them and a bare soffit is the giveaway.
 *   • **A maintenance catwalk** with a handrail near the back, which is the
 *     single detail that most reliably says "built" rather than "modelled".
 *   • **Bay-to-bay tint variation** in the vertex colour: no two sheets on a
 *     weathered roof are the same value, and the variation survives mipping
 *     when a texture will not.
 */

const _p: RingPt = { x: 0, z: 0, nx: 0, nz: 0, t: 0, seg: 0 };
const _q: RingPt = { x: 0, z: 0, nx: 0, nz: 0, t: 0, seg: 0 };

export function buildRoof(ctx: Ctx, M: StadiumMaterials, rows: number, ringN: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'roof';

  const fOff = ROOF.frontOff;
  const bOff = roofBackOff(rows);
  const fY = ROOF.frontY, bY = ROOF.backY;
  const th = ROOF.thickness;
  const US = 0.16;

  const tTab = ringTable(ringN, bOff * 0.8);
  const N = tTab.length - 1;
  const ring: RingPt[] = [];
  for (let i = 0; i <= N; i++) {
    const p: RingPt = { x: 0, z: 0, nx: 0, nz: 0, t: 0, seg: 0 };
    ptAt(tTab[i] % 1, 0, p);
    p.t = tTab[i];
    ring.push(p);
  }
  const P: [number, number] = [0, 0], Q: [number, number] = [0, 0];
  const Rr: [number, number] = [0, 0], S: [number, number] = [0, 0];
  const at = (i: number, off: number, out: [number, number]) => {
    const p = ring[i];
    out[0] = p.x + p.nx * off; out[1] = p.z + p.nz * off;
  };
  const uAt = (i: number) => ring[i].t * BASE_PERIMETER * US;

  /* ------------------------------------------------------------ canopy */
  const deck = new Mesher();
  const span = bOff - fOff;
  const UNDER: RGB = [0.62, 0.63, 0.66];
  // Sheets arrive in bays roughly 12 m wide. Quantising the tint by bay (and
  // not per ring sample) is what makes the variation read as roofing rather
  // than as noise.
  const bayOf = (i: number) => Math.floor((i / N) * BASE_PERIMETER / 11.5);
  const tintOf = (i: number): RGB => {
    const b = bayOf(i);
    const k = 0.90 + hash2(b, 3, 4211) * 0.20;
    const w = 0.985 + hash2(b, 7, 911) * 0.03;
    return [k * w, k, k * (1.995 - w)];
  };
  const GUTTER: RGB = [0.52, 0.53, 0.55];
  for (let i = 0; i < N; i++) {
    const u0 = uAt(i), u1 = uAt(i + 1);
    at(i, fOff, P); at(i + 1, fOff, Q); at(i + 1, bOff, Rr); at(i, bOff, S);
    const tint = tintOf(i);
    // top skin
    deck.quad([P[0], fY + th, P[1]], [Q[0], fY + th, Q[1]], [Rr[0], bY + th, Rr[1]], [S[0], bY + th, S[1]],
      [u0, 0, u1, 0, u1, span * US, u0, span * US], [1, 1, 0.96, 0.96], tint);
    // underside
    deck.quad([S[0], bY, S[1]], [Rr[0], bY, Rr[1]], [Q[0], fY, Q[1]], [P[0], fY, P[1]],
      [u0, span * US, u1, span * US, u1, 0, u0, 0], [0.62, 0.62, 0.42, 0.42], UNDER);
    // trailing edge
    deck.quad([S[0], bY, S[1]], [Rr[0], bY, Rr[1]], [Rr[0], bY + th, Rr[1]], [S[0], bY + th, S[1]],
      [u0, 0, u1, 0, u1, 0.2, u0, 0.2], [0.8, 0.8, 1, 1], tint);
    // leading-edge fascia (structure; the LED ribbon is applied over it)
    deck.quad([Q[0], fY - ROOF.fasciaH, Q[1]], [P[0], fY - ROOF.fasciaH, P[1]],
      [P[0], fY + th, P[1]], [Q[0], fY + th, Q[1]],
      [u1, 0, u0, 0, u0, 0.4, u1, 0.4], [0.72, 0.72, 1, 1]);
    // Fascia soffit return: the canopy ends in a horizontal lip, not a knife
    // edge, and the lip is what casts the dark line under the leading edge.
    at(i, fOff - 0.42, Rr); at(i + 1, fOff - 0.42, S);
    deck.quad([P[0], fY - ROOF.fasciaH, P[1]], [Q[0], fY - ROOF.fasciaH, Q[1]],
      [S[0], fY - ROOF.fasciaH, S[1]], [Rr[0], fY - ROOF.fasciaH, Rr[1]],
      [u0, 0, u1, 0, u1, 0.42, u0, 0.42], [0.34, 0.34, 0.26, 0.26], UNDER);
    deck.quad([Rr[0], fY - ROOF.fasciaH, Rr[1]], [S[0], fY - ROOF.fasciaH, S[1]],
      [S[0], fY - ROOF.fasciaH + 0.22, S[1]], [Rr[0], fY - ROOF.fasciaH + 0.22, Rr[1]],
      [u0, 0, u1, 0, u1, 0.22, u0, 0.22], [0.5, 0.5, 0.66, 0.66], UNDER);
    // Eaves gutter sitting on top of the leading edge, open channel upward.
    at(i, fOff + 0.30, Rr); at(i + 1, fOff + 0.30, S);
    const gy = fY + th;
    deck.quad([P[0], gy, P[1]], [Q[0], gy, Q[1]], [Q[0], gy + 0.34, Q[1]], [P[0], gy + 0.34, P[1]],
      [u0, 0, u1, 0, u1, 0.34, u0, 0.34], [0.92, 0.92, 1.02, 1.02], GUTTER);
    deck.quad([Q[0], gy + 0.34, Q[1]], [P[0], gy + 0.34, P[1]], [Rr[0], gy + 0.30, Rr[1]], [S[0], gy + 0.30, S[1]],
      [u1, 0, u0, 0, u0, 0.30, u1, 0.30], [0.42, 0.42, 0.36, 0.36], GUTTER);
    deck.quad([Rr[0], gy + 0.30, Rr[1]], [S[0], gy + 0.30, S[1]], [S[0], gy, S[1]], [Rr[0], gy, Rr[1]],
      [u0, 0, u1, 0, u1, 0.30, u0, 0.30], [0.46, 0.46, 0.9, 0.9], GUTTER);
  }
  const deckMesh = new THREE.Mesh(deck.build('roof-deck'), M.roofDeck);
  // The canopy shadow raking across the stands at low sun is the signature
  // stadium cue, so this one casts at every tier — it is a single mesh.
  deckMesh.castShadow = true;
  deckMesh.receiveShadow = true;
  g.add(deckMesh);

  /* ------------------------------------------------------------ trusses */
  const trussGeo = buildTruss(fOff, bOff, fY, bY);
  const count = ROOF.trusses;
  const trusses = new THREE.InstancedMesh(trussGeo, M.steel, count);
  trusses.name = 'roof-trusses';
  const m4 = new THREE.Matrix4();
  const nrm = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), tan = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    ptAt(i / count, 0, _p);
    nrm.set(_p.nx, 0, _p.nz);
    tan.set(-_p.nz, 0, _p.nx);
    m4.makeBasis(nrm, up, tan);
    m4.setPosition(_p.x, 0, _p.z);
    trusses.setMatrixAt(i, m4);
  }
  trusses.instanceMatrix.needsUpdate = true;
  trusses.castShadow = ctx.quality.tier !== 'low';
  trusses.receiveShadow = true;
  trusses.frustumCulled = false;
  g.add(trusses);

  /* ------------------------------------------------------------ columns */
  // An outer colonnade: the props stand clear of the parapet, on the ground,
  // so the building reads as roof-on-structure from any low angle rather than
  // as a lid balanced on the seating deck.
  const colCount = Math.round(count / 2);
  const colGeo = buildColumn(roofYAt(COLUMN_OFF) - 0.34);
  const cols = new THREE.InstancedMesh(colGeo, M.steelDark, colCount);
  cols.name = 'roof-columns';
  for (let i = 0; i < colCount; i++) {
    ptAt((i + 0.5) / colCount, 0, _p);
    nrm.set(_p.nx, 0, _p.nz);
    tan.set(-_p.nz, 0, _p.nx);
    m4.makeBasis(nrm, up, tan);
    m4.setPosition(_p.x + _p.nx * COLUMN_OFF, 0, _p.z + _p.nz * COLUMN_OFF);
    cols.setMatrixAt(i, m4);
  }
  cols.instanceMatrix.needsUpdate = true;
  cols.castShadow = ctx.quality.tier !== 'low';
  cols.receiveShadow = true;
  cols.frustumCulled = false;
  g.add(cols);

  /* ------------------------- purlins and circumferential bottom chords */
  // Three deep bottom chords carry the truss work; eight shallow purlins sit
  // tight under the deck. The purlins are what a spectator actually looks at
  // when they tip their head back, so they run at real 2 m centres.
  const chordN = Math.max(56, Math.round(N / 3));
  const chordParts: Part[] = [];
  const chordOffs = [fOff + 1.2, fOff + span * 0.36, fOff + span * 0.68];
  for (const off of chordOffs) {
    const f = (off - fOff) / span;
    const y = fY + (bY - fY) * f - (1.7 + 1.2 * f);
    ringRun(chordParts, chordN, off, () => y, 0.24, undefined);
  }
  const purlinN = Math.max(64, Math.round(N / 2.4));
  for (let k = 0; k <= 9; k++) {
    const f = 0.04 + (k / 9) * 0.93;
    const off = fOff + span * f;
    const y = fY + (bY - fY) * f - 0.30;
    ringRun(chordParts, purlinN, off, () => y, 0.13, [0.80, 0.82, 0.85]);
  }
  const chords = new THREE.Mesh(parts(chordParts, 'roof-chords'), M.steel);
  chords.name = 'roof-purlins';
  chords.castShadow = false;
  chords.receiveShadow = true;
  g.add(chords);

  /* ---------------------------------------- standing seams on the skin */
  // Radial seams at ~2.5 m centres — sheet-metal spacing, not truss spacing.
  // This is the single change that gives the canopy its scale from 250 m out.
  const seamParts: Part[] = [];
  const seamCount = Math.round(BASE_PERIMETER / 2.6);
  const seamSteps = 6;
  for (let s = 0; s < seamCount; s++) {
    const t = s / seamCount;
    ptAt(t, 0, _p);
    // Every fourth seam is a raised ridge cap; the rest are ordinary welts.
    const big = s % 4 === 0;
    const w = big ? 0.15 : 0.085;
    const rise = big ? 0.16 : 0.095;
    const k = 1.02 + hash2(s, 5, 77) * 0.10;
    for (let j = 0; j < seamSteps; j++) {
      const f0 = j / seamSteps, f1 = (j + 1) / seamSteps;
      const o0 = fOff + span * f0, o1 = fOff + span * f1;
      const a0: V3 = [_p.x + _p.nx * o0, fY + (bY - fY) * f0 + th + rise * 0.5, _p.z + _p.nz * o0];
      const a1: V3 = [_p.x + _p.nx * o1, fY + (bY - fY) * f1 + th + rise * 0.5, _p.z + _p.nz * o1];
      seamParts.push({ ...strut(a0, a1, w, UNIT_BOX), color: [k, k, k * 1.01] as RGB });
    }
  }
  // Two circumferential ridge lines where the sheets lap.
  const ridgeN = Math.max(96, Math.round(N / 2));
  for (const f of [0.34, 0.71]) {
    const off = fOff + span * f;
    const y = fY + (bY - fY) * f + th + 0.075;
    ringRun(seamParts, ridgeN, off, () => y, 0.13, [1.04, 1.04, 1.06]);
  }
  const seams = new THREE.Mesh(parts(seamParts, 'roof-seams'), M.roofDeck);
  seams.name = 'roof-seams';
  seams.castShadow = false;
  seams.receiveShadow = true;
  g.add(seams);

  /* ------------------------------------------------ maintenance catwalk */
  // Grating walkway and handrail two thirds of the way back, plus a stub
  // downpipe off each column line. Nothing here is load bearing; it is here
  // because a roof without access gear does not read as a roof.
  const walkOff = fOff + span * 0.80;
  const walkY = fY + (bY - fY) * 0.80 + th + 0.30;
  const walkN = Math.max(72, Math.round(N / 3));
  const walkParts: Part[] = [];
  ringRun(walkParts, walkN, walkOff - 0.45, () => walkY, 0.10, [0.55, 0.57, 0.60]);
  ringRun(walkParts, walkN, walkOff + 0.45, () => walkY, 0.10, [0.55, 0.57, 0.60]);
  ringRun(walkParts, walkN, walkOff - 0.42, () => walkY + 1.05, 0.06, [0.62, 0.64, 0.67]);
  ringRun(walkParts, walkN, walkOff - 0.42, () => walkY + 0.55, 0.05, [0.62, 0.64, 0.67]);
  const postN = Math.round(BASE_PERIMETER / 3.2);
  for (let i = 0; i < postN; i++) {
    ptAt(i / postN, 0, _p);
    const x = _p.x + _p.nx * (walkOff - 0.42), z = _p.z + _p.nz * (walkOff - 0.42);
    walkParts.push({ ...strut([x, walkY, z], [x, walkY + 1.05, z], 0.05, UNIT_BOX), color: [0.62, 0.64, 0.67] as RGB });
  }
  // Downpipes: one per column, hugging the trailing edge down to the deck.
  const pipeN = Math.round(count / 2);
  for (let i = 0; i < pipeN; i++) {
    ptAt((i + 0.5) / pipeN, 0, _p);
    const x = _p.x + _p.nx * (bOff + 0.22), z = _p.z + _p.nz * (bOff + 0.22);
    walkParts.push({ ...strut([x, bY - 5.5, z], [x, bY + th, z], 0.16, UNIT_BOX), color: [0.58, 0.60, 0.62] as RGB });
  }
  const walk = new THREE.Mesh(parts(walkParts, 'roof-catwalk'), M.steelDark);
  walk.name = 'roof-catwalk';
  walk.castShadow = ctx.quality.tier === 'ultra';
  walk.receiveShadow = true;
  g.add(walk);

  return g;
}

/** Lays a run of struts round the plan at outward offset `off`. */
function ringRun(
  out: Part[], n: number, off: number, yAt: (f: number) => number, w: number, color?: RGB,
): void {
  let prev: V3 | null = null;
  for (let i = 0; i <= n; i++) {
    ptAt((i / n) % 1, 0, _q);
    const p: V3 = [_q.x + _q.nx * off, yAt(i / n), _q.z + _q.nz * off];
    if (prev) out.push(color ? { ...strut(prev, p, w, UNIT_BOX), color } : strut(prev, p, w, UNIT_BOX));
    prev = p;
  }
}

/* -------------------------------------------------------------- truss kit */

/**
 * One radial truss in local coordinates: +X outward from the wall line,
 * +Y world up, +Z across the truss. Two top chords, one bottom chord, a
 * warren web and cross-bracing — visible from underneath, which is the point.
 */
function buildTruss(fOff: number, bOff: number, fY: number, bY: number): THREE.BufferGeometry {
  const list: Part[] = [];
  const span = bOff - fOff;
  const panels = 9;
  const topY = (f: number) => fY + (bY - fY) * f - 0.16;
  const botY = (f: number) => fY + (bY - fY) * f - (1.75 + 1.35 * f);
  const zw = 0.62;
  const chordW = 0.30, webW = 0.17;
  const STEEL: RGB = [1, 1, 1];
  const DARK: RGB = [0.72, 0.74, 0.78];

  for (let s = -1; s <= 1; s += 2) {
    for (let p = 0; p < panels; p++) {
      const f0 = p / panels, f1 = (p + 1) / panels;
      list.push({
        ...strut([fOff + span * f0, topY(f0), s * zw], [fOff + span * f1, topY(f1), s * zw], chordW, UNIT_BOX),
        color: STEEL,
      });
    }
  }
  for (let p = 0; p < panels; p++) {
    const f0 = p / panels, f1 = (p + 1) / panels;
    list.push({
      ...strut([fOff + span * f0, botY(f0), 0], [fOff + span * f1, botY(f1), 0], chordW * 1.1, UNIT_BOX),
      color: STEEL,
    });
  }
  // No seam is modelled here any more: the sheet-metal seams now run at their
  // own 2.6 m spacing on the deck mesh, and a second set at truss spacing only
  // fought them for the eye.
  for (let p = 0; p <= panels; p++) {
    const f = p / panels;
    const x = fOff + span * f;
    // vertical post + two diagonals down to the bottom chord
    list.push({ ...strut([x, topY(f), -zw], [x, topY(f), zw], webW, UNIT_BOX), color: DARK });
    if (p < panels) {
      const f1 = (p + 1) / panels, x1 = fOff + span * f1;
      for (const s of [-1, 1]) {
        list.push({ ...strut([x, topY(f), s * zw], [x1, botY(f1), 0], webW, UNIT_BOX), color: DARK });
        list.push({ ...strut([x1, topY(f1), s * zw], [x, botY(f), 0], webW, UNIT_BOX), color: DARK });
      }
    }
  }
  return parts(list, 'roof-truss');
}

/** Back prop: a four-leg lattice column with cross-bracing. */
function buildColumn(topY: number): THREE.BufferGeometry {
  const list: Part[] = [];
  const w = 0.62;
  const LEG: RGB = [1, 1, 1];
  const BRACE: RGB = [0.8, 0.82, 0.85];
  const corners: [number, number][] = [[-w, -w], [w, -w], [w, w], [-w, w]];
  for (const [cx, cz] of corners) {
    list.push({ ...strut([cx, 0.0, cz], [cx * 0.55, topY, cz * 0.55], 0.26, UNIT_BOX), color: LEG });
  }
  const lifts = 7;
  for (let i = 0; i <= lifts; i++) {
    const t = i / lifts, y = topY * t, k = 1 - 0.45 * t;
    for (let c = 0; c < 4; c++) {
      const a = corners[c], b = corners[(c + 1) % 4];
      list.push({ ...strut([a[0] * k, y, a[1] * k], [b[0] * k, y, b[1] * k], 0.13, UNIT_BOX), color: BRACE });
      if (i < lifts) {
        const t2 = (i + 1) / lifts, y2 = topY * t2, k2 = 1 - 0.45 * t2;
        list.push({ ...strut([a[0] * k, y, a[1] * k], [b[0] * k2, y2, b[1] * k2], 0.10, UNIT_BOX), color: BRACE });
      }
    }
  }
  // Cap plate under the truss.
  list.push({ geo: new THREE.BoxGeometry(1.9, 0.34, 1.9), m: new THREE.Matrix4().setPosition(0, topY + 0.17, 0), color: LEG });
  return parts(list, 'roof-column');
}
