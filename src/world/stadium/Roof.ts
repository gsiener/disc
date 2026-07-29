import * as THREE from 'three';
import type { Ctx } from '../../core/Ctx';
import { Mesher, parts, strut, UNIT_BOX, type Part, type RGB } from './Geo';
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
 */

const _p: RingPt = { x: 0, z: 0, nx: 0, nz: 0, t: 0, seg: 0 };

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
  for (let i = 0; i < N; i++) {
    const u0 = uAt(i), u1 = uAt(i + 1);
    at(i, fOff, P); at(i + 1, fOff, Q); at(i + 1, bOff, Rr); at(i, bOff, S);
    // top skin
    deck.quad([P[0], fY + th, P[1]], [Q[0], fY + th, Q[1]], [Rr[0], bY + th, Rr[1]], [S[0], bY + th, S[1]],
      [u0, 0, u1, 0, u1, span * US, u0, span * US], [1, 1, 0.96, 0.96]);
    // underside
    deck.quad([S[0], bY, S[1]], [Rr[0], bY, Rr[1]], [Q[0], fY, Q[1]], [P[0], fY, P[1]],
      [u0, span * US, u1, span * US, u1, 0, u0, 0], [0.62, 0.62, 0.42, 0.42], UNDER);
    // leading-edge fascia (structure; the LED ribbon is applied over it)
    deck.quad([Q[0], fY - ROOF.fasciaH, Q[1]], [P[0], fY - ROOF.fasciaH, P[1]],
      [P[0], fY + th, P[1]], [Q[0], fY + th, Q[1]],
      [u1, 0, u0, 0, u0, 0.4, u1, 0.4], [0.72, 0.72, 1, 1]);
    // trailing edge
    deck.quad([S[0], bY, S[1]], [Rr[0], bY, Rr[1]], [Rr[0], bY + th, Rr[1]], [S[0], bY + th, S[1]],
      [u0, 0, u1, 0, u1, 0.2, u0, 0.2], [0.8, 0.8, 1, 1]);
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

  /* -------------------------------------------- circumferential chords */
  const chordN = Math.max(48, Math.round(N / 3));
  const chordParts: Part[] = [];
  const chordOffs = [fOff + 1.2, fOff + span * 0.36, fOff + span * 0.68];
  for (const off of chordOffs) {
    const f = (off - fOff) / span;
    const y = fY + (bY - fY) * f - (1.7 + 1.2 * f);
    let prev: [number, number, number] | null = null;
    for (let i = 0; i <= chordN; i++) {
      ptAt((i / chordN) % 1, 0, _p);
      const p: [number, number, number] = [_p.x + _p.nx * off, y, _p.z + _p.nz * off];
      if (prev) chordParts.push(strut(prev, p, 0.24, UNIT_BOX));
      prev = p;
    }
  }
  const chords = new THREE.Mesh(parts(chordParts, 'roof-chords'), M.steel);
  chords.castShadow = false;
  chords.receiveShadow = true;
  g.add(chords);

  /* -------------------------------------- concentric ridges on the skin */
  // Crossing the radial standing seams: together they give the canopy a
  // readable panel grid instead of one continuous sheet.
  const ridgeN = Math.max(80, Math.round(N / 2));
  const ridgeParts: Part[] = [];
  for (const f of [0.30, 0.62, 0.88]) {
    const off = fOff + span * f;
    const y = fY + (bY - fY) * f + th + 0.09;
    let prev: [number, number, number] | null = null;
    for (let i = 0; i <= ridgeN; i++) {
      ptAt((i / ridgeN) % 1, 0, _p);
      const p: [number, number, number] = [_p.x + _p.nx * off, y, _p.z + _p.nz * off];
      if (prev) ridgeParts.push({ ...strut(prev, p, 0.20, UNIT_BOX), color: [1.06, 1.06, 1.08] as RGB });
      prev = p;
    }
  }
  const ridges = new THREE.Mesh(parts(ridgeParts, 'roof-ridges'), M.roofDeck);
  ridges.castShadow = false;
  ridges.receiveShadow = true;
  g.add(ridges);

  return g;
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
  // Standing seam on top of the deck, one per truss. Without these the canopy
  // is a hectare of unbroken plate and the whole building loses its scale from
  // the establishing camera.
  const seamY = (f: number) => fY + (bY - fY) * f + 0.86;
  for (let p = 0; p < panels; p++) {
    const f0 = p / panels, f1 = (p + 1) / panels;
    list.push({
      ...strut([fOff + span * f0, seamY(f0), 0], [fOff + span * f1, seamY(f1), 0], 0.24, UNIT_BOX),
      color: [1.1, 1.1, 1.12] as RGB,
    });
  }
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
