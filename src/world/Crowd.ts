import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';
import { bake, linearColor } from '../util/Tex';
import { fbm2, valueNoise2, worley2, clamp, smoothstep } from '../util/Noise';
import {
  BOWL, resolveBowl, fitBowl, occupancy, peerSeats, ownSeats, SIT_HEIGHT,
  type BowlSpec, type SeatSet,
} from './crowd/Bowl';
import { buildBody, buildChair, buildCloth } from './crowd/Body';
import { buildDeck, deckMaterial } from './crowd/Deck';
import {
  makeLightUniforms, CROWD_VERT, CROWD_FRAG, SEAT_VERT, SEAT_FRAG,
  CLOTH_VERT, CLOTH_FRAG, type LightUniforms,
} from './crowd/Shader';

/**
 * The crowd: up to 18k individually-dressed spectators in the stadium bowl,
 * drawn in two instanced draw calls and animated entirely from an instance seed
 * in the vertex shader — idle sway, clapping, arms up, standing, and waves of
 * celebration that propagate outward from wherever something just happened.
 *
 * Structure
 *   • Seats come from the shared bowl layout (crowd/Bowl.ts).
 *   • Every spectator is one instance in an interleaved 24-float record.
 *   • Two LODs share that record: a near mesh (articulated, ~430 tri) gathered
 *     per camera move from spatial blocks, and a far mesh (~90 tri silhouette)
 *     holding the whole crowd. Each instance picks its own switch distance
 *     inside a band, so the LOD boundary never reads as a ring.
 *   • Colour and contrast bleed into the haze with range, so the far stands
 *     read as texture rather than as thousands of tiny lit dolls.
 */

const STRIDE = 24;
const OFF_POS = 0, OFF_YAW = 3, OFF_RAND = 4, OFF_SIZE = 8;
const OFF_SHIRT = 10, OFF_SKIN = 13, OFF_HAIR = 16, OFF_FLAGS = 19, OFF_ROWT = 23;

const MAX_NEAR_DIST = 30;
/** Seconds of simulation the capture rig settles for; staged waves aim at it. */
const CAPTURE_SETTLE = 2.5;
const WAVE_SPEED = 13.5;

interface Block { start: number; count: number; cx: number; cy: number; cz: number; r: number }

/* ---------------------------------------------------------------- palettes */

const SKIN = [0xf4d6bd, 0xecc19c, 0xd9a771, 0xc68a55, 0xa96f43, 0x8a5733, 0x6b4225, 0x4d2f1b]
  .map(linearColor);
const SKIN_W = [0.13, 0.16, 0.15, 0.14, 0.12, 0.12, 0.10, 0.08];

const HAIR = [0x14100e, 0x241a13, 0x3c2a1c, 0x5b3f26, 0x8a6a3c, 0xc0a068, 0x8e8b86, 0xd6d2ca, 0x7b3320]
  .map(linearColor);
const HAIR_W = [0.24, 0.18, 0.14, 0.12, 0.08, 0.07, 0.07, 0.05, 0.05];

/** Neutral shirts — the mixer that stops the stands reading as two flags. */
const NEUTRAL = [
  0xdcdcda, 0x2c2f35, 0x50596b, 0x8d8776, 0x66795a, 0x7d3f3c, 0x2f4a5c,
  0xb0651f, 0xa5aab2, 0x3b3f6a, 0x6d4b7a, 0xe4d6a8, 0x1d1f24, 0x9d2f3f,
].map(linearColor);

/** Fallback team palettes, used until a peer publishes real ones. */
const TEAM_A_DEF = [0xe0521c, 0xe0521c, 0xf0a04b, 0x191c22, 0xf3ece2];
const TEAM_B_DEF = [0x1e63c8, 0x1e63c8, 0x84b6f0, 0xeef1f5, 0x15233f];

function pickW(rand: () => number, arr: THREE.Color[], w: number[]): THREE.Color {
  let r = rand();
  for (let i = 0; i < arr.length; i++) { r -= w[i]; if (r <= 0) return arr[i]; }
  return arr[arr.length - 1];
}

const _v = new THREE.Vector3();
const _c = new THREE.Color();

/* --------------------------------------------------------------------- sys */

export class CrowdSystem implements System {
  readonly name = 'crowd';
  readonly order = 5;

  private group = new THREE.Group();
  private uni!: LightUniforms & Record<string, THREE.IUniform>;
  private nearMesh!: THREE.Mesh;
  private nearGeo!: THREE.InstancedBufferGeometry;

  private master!: Float32Array;
  private nearData!: Float32Array;
  private nearBuf!: THREE.InstancedInterleavedBuffer;
  private blocks: Block[] = [];
  private order2: number[] = [];
  private dists!: Float32Array;

  private count = 0;
  private nearCap = 0;
  private lastCam = new THREE.Vector3(1e9, 0, 0);
  private lastRefresh = -999;
  private nearDirty = true;

  private energy = 0.14;
  private energyTarget = 0.14;
  private waves: THREE.Vector4[] = [];
  private waveSlot = 0;
  private night = 0;
  private nightFromHour = 0;

  // Scene lighting mirrored from the Lighting system (see syncLights).
  private sunBase = new THREE.Color(1.0, 0.94, 0.85).multiplyScalar(3.2);
  private skyBase = new THREE.Color(0.42, 0.58, 0.9).multiplyScalar(1.1);
  private gndBase = new THREE.Color(0.14, 0.16, 0.1).multiplyScalar(1.1);

  private spec: BowlSpec = { ...BOWL };
  private rowsUsed = BOWL.rows;
  private disposables: { dispose(): void }[] = [];

  /** Published for peers: the scene node holding every crowd mesh. */
  get root(): THREE.Group { return this.group; }
  /** Published for peers: the seat grid the crowd actually used. */
  bowl: BowlSpec = { ...BOWL };
  stats = { spectators: 0, seats: 0, nearCap: 0, meshes: 0 };

  init(ctx: Ctx): void {
    const res = resolveBowl(ctx);
    this.spec = res.spec;
    this.bowl = res.spec;

    const budget = Math.max(120, ctx.quality.crowdCount);
    const fit = fitBowl(this.spec, budget, 0.78);
    this.rowsUsed = fit.rows;

    // Seats: the stadium's own slots when it has them, ours when it does not.
    const seatSet = peerSeats(ctx) ?? ownSeats(this.spec, fit);
    const peerDeck = res.peerHasDeck || seatSet.fromPeer;

    this.uni = { ...makeLightUniforms() } as LightUniforms & Record<string, THREE.IUniform>;
    this.uni.uEnergy = { value: this.energy };
    this.uni.uNearEnd = { value: MAX_NEAR_DIST };
    this.uni.uWaveInvSpeed = { value: 1 / WAVE_SPEED };
    this.waves = [new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0),
      new THREE.Vector4(0, 0, 0, 0)];
    this.uni.uWaves = { value: this.waves };
    this.uni.uDetail = { value: this.bakeDetail(ctx) };
    // x = row fraction where the roof cantilever starts to bite, y unused here.
    this.uni.uUpperShade.value.set(0.40, 0);

    const teams = this.teamPalettes(ctx);
    const empties = this.generate(ctx, seatSet, budget, teams, !peerDeck);

    this.buildMeshes(ctx);
    if (!peerDeck) this.buildFallbackDeck(ctx, empties);
    this.buildProps(ctx, teams, seatSet, empties.emptyIdx);

    ctx.scene.add(this.group);
    this.syncLights(ctx);
    this.hookEvents(ctx);

    this.stats.spectators = this.count;
    this.stats.seats = seatSet.n;
    this.stats.nearCap = this.nearCap;
    this.stats.meshes = this.group.children.length;
  }

  /* ------------------------------------------------------------ generation */

  /** Team colours from a peer if one publishes them, else our own. */
  private teamPalettes(ctx: Ctx): { a: THREE.Color[]; b: THREE.Color[] } {
    const grab = (v: any): THREE.Color[] | null => {
      if (v == null) return null;
      const arr: any[] = Array.isArray(v) ? v : [v.primary ?? v.main, v.secondary ?? v.accent];
      const out: THREE.Color[] = [];
      for (const c of arr) {
        if (c == null) continue;
        if (typeof c === 'number') out.push(linearColor(c));
        else if (c.isColor) out.push((c as THREE.Color).clone());
        else if (typeof c === 'string') out.push(new THREE.Color(c));
      }
      return out.length ? out : null;
    };
    let a: THREE.Color[] | null = null;
    let b: THREE.Color[] | null = null;
    try {
      const p: any = ctx.sys['players'] ?? ctx.sys['game'] ?? null;
      const t: any = p?.teamColors ?? p?.teams ?? p?.colors ?? null;
      if (t) { a = grab(t[0] ?? t.home ?? t.a); b = grab(t[1] ?? t.away ?? t.b); }
    } catch { /* peers may be absent or shaped differently — never fatal */ }
    const blend = (def: number[], got: THREE.Color[] | null): THREE.Color[] => {
      const d = def.map(linearColor);
      if (!got) return d;
      return [got[0], got[0], got[1] ?? d[2], got[2] ?? d[3], d[4]];
    };
    return { a: blend(TEAM_A_DEF, a), b: blend(TEAM_B_DEF, b) };
  }

  private generate(
    ctx: Ctx, seats: SeatSet, budget: number,
    teams: { a: THREE.Color[]; b: THREE.Color[] }, wantChairs: boolean,
  ): { pos: number[]; yaw: number[]; col: number[]; emptyIdx: number[] } {
    const N = seats.n;

    // Order seats by section then row so a run of consecutive instances is a
    // compact spatial block — that is what makes the near-LOD gather cheap.
    const SECT = 34;
    const idx = Array.from({ length: N }, (_, i) => i);
    const key = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const sec = Math.min(SECT - 1, (seats.t[i] * SECT) | 0);
      key[i] = sec * 4096 + Math.round(seats.rowT[i] * 1000);
    }
    idx.sort((a, b) => key[a] - key[b]);

    // Pass 1 — how full can the bowl be before the budget bites? Normalising
    // here keeps every tier looking like the *same* stadium, just thinner.
    let sum = 0;
    for (let i = 0; i < N; i++) {
      sum += occupancy(seats.rowT[i], seats.t[i], seats.corner[i], 1, seats.x[i]);
    }
    const base = clamp(budget / Math.max(1, sum), 0.12, 1);

    const rng = ctx.rand.fork(0x5eed);
    const rand = () => rng.next();
    const master = new Float32Array(budget * STRIDE);
    const chairPos: number[] = [], chairYaw: number[] = [], chairCol: number[] = [];
    const emptyIdx: number[] = [];
    const seatA = linearColor(0x2c4a70), seatB = linearColor(0x24405e), seatC = linearColor(0x8a3a2a);

    let n = 0;
    let blockStart = 0;
    let bMinX = 1e9, bMaxX = -1e9, bMinY = 1e9, bMaxY = -1e9, bMinZ = 1e9, bMaxZ = -1e9;
    let lastKey = -1;

    const closeBlock = () => {
      if (n <= blockStart) return;
      this.blocks.push({
        start: blockStart, count: n - blockStart,
        cx: (bMinX + bMaxX) * 0.5, cy: (bMinY + bMaxY) * 0.5, cz: (bMinZ + bMaxZ) * 0.5,
        r: 0.5 * Math.hypot(bMaxX - bMinX, bMaxY - bMinY, bMaxZ - bMinZ) + 0.7,
      });
      blockStart = n;
      bMinX = bMinY = bMinZ = 1e9; bMaxX = bMaxY = bMaxZ = -1e9;
    };

    for (let ii = 0; ii < N; ii++) {
      const i = idx[ii];
      const x = seats.x[i], y = seats.y[i] + SIT_HEIGHT, z = seats.z[i];
      const yaw = seats.yaw[i], rowT = seats.rowT[i], t = seats.t[i];
      const sec = Math.min(SECT - 1, (t * SECT) | 0);
      const bandKey = sec * 32 + ((rowT * 10) | 0);
      if (bandKey !== lastKey) { closeBlock(); lastKey = bandKey; }

      if (wantChairs) {
        const cs = (sec * 7 + ((rowT * 5) | 0)) % 11;
        const sc = cs < 6 ? seatA : cs < 9 ? seatB : seatC;
        chairPos.push(x, seats.y[i] + 0.42, z); chairYaw.push(yaw);
        chairCol.push(sc.r, sc.g, sc.b);
      }

      if (n >= budget) continue;
      if (rand() > occupancy(rowT, t, seats.corner[i], base, x)) {
        if (rowT > 0.12 && emptyIdx.length < 4000) emptyIdx.push(i);
        continue;
      }

      const o = n * STRIDE;
      master[o + OFF_POS] = x;
      master[o + OFF_POS + 1] = y;
      master[o + OFF_POS + 2] = z;
      master[o + OFF_ROWT] = rowT;
      master[o + OFF_YAW] = yaw + (rand() - 0.5) * 0.5;
      master[o + OFF_RAND] = rand();
      master[o + OFF_RAND + 1] = rand();
      master[o + OFF_RAND + 2] = rand();
      master[o + OFF_RAND + 3] = rand();

      const kid = rand() < 0.085;
      master[o + OFF_SIZE] = kid ? 0.74 + rand() * 0.1
        : clamp(1 + rng.gauss() * 0.055, 0.86, 1.16);
      master[o + OFF_SIZE + 1] = clamp(1 + rng.gauss() * 0.09, 0.82, 1.3) * (kid ? 0.9 : 1);

      // Allegiance drifts across the bowl: home sideline one way, mixed ends.
      const bias = clamp(0.5 + 0.40 * Math.tanh(-x / 20)
        + 0.30 * fbm2(t * 11, rowT * 9, { octaves: 2, seed: 77 }), 0.05, 0.95);
      let shirt: THREE.Color;
      if (rand() < 0.60) {
        const pal = rand() < bias ? teams.a : teams.b;
        shirt = pal[(rand() * pal.length) | 0];
      } else {
        shirt = NEUTRAL[(rand() * NEUTRAL.length) | 0];
      }
      const tint = 0.86 + rand() * 0.28;
      master[o + OFF_SHIRT] = shirt.r * tint;
      master[o + OFF_SHIRT + 1] = shirt.g * tint;
      master[o + OFF_SHIRT + 2] = shirt.b * tint;

      const sk = pickW(rand, SKIN, SKIN_W);
      const st = 0.92 + rand() * 0.16;
      master[o + OFF_SKIN] = sk.r * st;
      master[o + OFF_SKIN + 1] = sk.g * st;
      master[o + OFF_SKIN + 2] = sk.b * st;

      const hat = rand() < 0.34 ? 1 : 0;
      const hairC = hat
        ? (rand() < 0.62 ? (rand() < bias ? teams.a[0] : teams.b[0])
          : NEUTRAL[(rand() * NEUTRAL.length) | 0])
        : pickW(rand, HAIR, HAIR_W);
      const ht = 0.85 + rand() * 0.3;
      master[o + OFF_HAIR] = hairC.r * ht;
      master[o + OFF_HAIR + 1] = hairC.g * ht;
      master[o + OFF_HAIR + 2] = hairC.b * ht;

      master[o + OFF_FLAGS] = Math.pow(rand(), 0.75);
      master[o + OFF_FLAGS + 1] = rand() < 0.022 ? -1.2
        : 0.10 + Math.pow(rand(), 1.25) * 0.86;
      const pr = rand();
      master[o + OFF_FLAGS + 2] = pr < 0.055 ? 1 : pr < 0.10 ? 2 : 0;
      master[o + OFF_FLAGS + 3] = hat;

      if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x;
      if (y < bMinY) bMinY = y; if (y > bMaxY) bMaxY = y;
      if (z < bMinZ) bMinZ = z; if (z > bMaxZ) bMaxZ = z;
      n++;
    }
    closeBlock();

    this.count = n;
    this.master = master.subarray(0, n * STRIDE);
    this.order2 = this.blocks.map((_, i) => i);
    this.dists = new Float32Array(this.blocks.length);
    return { pos: chairPos, yaw: chairYaw, col: chairCol, emptyIdx };
  }

  /* ---------------------------------------------------------------- meshes */

  private bakeDetail(ctx: Ctx): THREE.DataTexture {
    // R cloth weave · G skin mottle · B hair strands — one fetch, three uses.
    const tex = bake((x, y, u, v, out, i) => {
      const weave = 0.5
        + 0.20 * Math.sin(x * 1.55) * Math.sin(y * 1.55)
        + 0.22 * (valueNoise2(u * 34, v * 34, 3) - 0.5)
        + 0.14 * fbm2(u * 7, v * 7, { octaves: 3, seed: 12 });
      const pore = worley2(u * 40, v * 40, 21).f1;
      const skin = 0.5 + 0.30 * fbm2(u * 12, v * 12, { octaves: 4, seed: 31 })
        + 0.22 * (pore - 0.5);
      const strand = 0.5 + 0.40 * (valueNoise2(u * 60, v * 5, 7) - 0.5)
        + 0.24 * fbm2(u * 20, v * 4, { octaves: 2, seed: 51 });
      out[i] = clamp(weave, 0, 1) * 255;
      out[i + 1] = clamp(skin, 0, 1) * 255;
      out[i + 2] = clamp(strand, 0, 1) * 255;
      out[i + 3] = 255;
    }, { size: 128, anisotropy: ctx.quality.anisotropy, name: 'crowd-detail' });
    this.disposables.push(tex);
    return tex;
  }

  private instancedFrom(
    base: THREE.BufferGeometry, buf: THREE.InstancedInterleavedBuffer, count: number,
  ): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(base.getIndex());
    for (const name of Object.keys(base.attributes)) g.setAttribute(name, base.attributes[name]);
    g.setAttribute('iPos', new THREE.InterleavedBufferAttribute(buf, 3, OFF_POS));
    g.setAttribute('iYaw', new THREE.InterleavedBufferAttribute(buf, 1, OFF_YAW));
    g.setAttribute('iRand', new THREE.InterleavedBufferAttribute(buf, 4, OFF_RAND));
    g.setAttribute('iSize', new THREE.InterleavedBufferAttribute(buf, 2, OFF_SIZE));
    g.setAttribute('iShirt', new THREE.InterleavedBufferAttribute(buf, 3, OFF_SHIRT));
    g.setAttribute('iSkin', new THREE.InterleavedBufferAttribute(buf, 3, OFF_SKIN));
    g.setAttribute('iHair', new THREE.InterleavedBufferAttribute(buf, 3, OFF_HAIR));
    g.setAttribute('iFlags', new THREE.InterleavedBufferAttribute(buf, 4, OFF_FLAGS));
    g.setAttribute('iRowT', new THREE.InterleavedBufferAttribute(buf, 1, OFF_ROWT));
    g.instanceCount = count;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 8, 0), 280);
    this.disposables.push(g);
    return g;
  }

  private buildMeshes(ctx: Ctx): void {
    const tier = ctx.quality.tier;
    this.nearCap = Math.min(this.count,
      tier === 'ultra' ? 4200 : tier === 'high' ? 3000 : tier === 'medium' ? 1500 : 600);

    const uniforms = this.uni as unknown as Record<string, THREE.IUniform>;
    const matFar = new THREE.ShaderMaterial({
      uniforms, vertexShader: CROWD_VERT, fragmentShader: CROWD_FRAG, side: THREE.FrontSide,
    });
    matFar.name = 'crowd-far';
    const matNear = new THREE.ShaderMaterial({
      uniforms, vertexShader: CROWD_VERT, fragmentShader: CROWD_FRAG, side: THREE.FrontSide,
      defines: { LOD_NEAR: '' },
    });
    matNear.name = 'crowd-near';
    this.disposables.push(matFar, matNear);

    const farBuf = new THREE.InstancedInterleavedBuffer(this.master, STRIDE);
    const farMesh = new THREE.Mesh(this.instancedFrom(buildBody(1), farBuf, this.count), matFar);
    farMesh.frustumCulled = false;
    farMesh.name = 'crowd-far';

    this.nearData = new Float32Array(this.nearCap * STRIDE);
    this.nearBuf = new THREE.InstancedInterleavedBuffer(this.nearData, STRIDE);
    this.nearBuf.setUsage(THREE.DynamicDrawUsage);
    this.nearGeo = this.instancedFrom(buildBody(0), this.nearBuf, 0);
    this.nearMesh = new THREE.Mesh(this.nearGeo, matNear);
    this.nearMesh.frustumCulled = false;
    this.nearMesh.name = 'crowd-near';

    this.group.add(farMesh, this.nearMesh);
  }

  private buildFallbackDeck(
    ctx: Ctx, seats: { pos: number[]; yaw: number[]; col: number[] },
  ): void {
    const deckGeo = buildDeck(this.spec, this.rowsUsed);
    const deckMat = deckMaterial(ctx.quality.anisotropy);
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.receiveShadow = true;
    deck.name = 'crowd-deck';
    this.group.add(deck);
    this.disposables.push(deckGeo, deckMat);

    const chair = buildChair();
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(chair.getIndex());
    for (const k of Object.keys(chair.attributes)) geo.setAttribute(k, chair.attributes[k]);
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(seats.pos), 3));
    geo.setAttribute('iYaw', new THREE.InstancedBufferAttribute(new Float32Array(seats.yaw), 1));
    geo.setAttribute('iCol', new THREE.InstancedBufferAttribute(new Float32Array(seats.col), 3));
    geo.instanceCount = seats.yaw.length;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 8, 0), 280);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uni as unknown as Record<string, THREE.IUniform>,
      vertexShader: SEAT_VERT, fragmentShader: SEAT_FRAG, side: THREE.DoubleSide,
    });
    mat.name = 'crowd-seats';
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.name = 'crowd-seats';
    this.group.add(mesh);
    this.disposables.push(chair, geo, mat);
  }

  /* ----------------------------------------------------------------- props */

  private buildProps(
    ctx: Ctx, teams: { a: THREE.Color[]; b: THREE.Color[] },
    seats: SeatSet, emptyIdx: number[],
  ): void {
    const rng = ctx.rand.fork(0xba17e);
    const pos: number[] = [], yaw: number[] = [], size: number[] = [];
    const colA: number[] = [], colB: number[] = [], style: number[] = [];

    const push = (
      x: number, y: number, z: number, ya: number, w: number, h: number,
      fl: number, a: THREE.Color, b: THREE.Color, st: number,
    ) => {
      pos.push(x, y, z); yaw.push(ya); size.push(w, h, rng.next(), fl);
      colA.push(a.r, a.g, a.b); colB.push(b.r, b.g, b.b); style.push(st);
    };

    // Banners tied across the seat backs of empty rows — which is exactly what
    // supporters do with the gaps, and it dresses the holes in the crowd.
    const nBan = ctx.quality.tier === 'low' ? 8 : 26;
    for (let i = 0; i < nBan && emptyIdx.length > 0; i++) {
      const e = emptyIdx[rng.int(0, emptyIdx.length - 1)];
      const ya = seats.yaw[e];
      const pal = rng.next() < 0.5 ? teams.a : teams.b;
      // hangs over the seats in front, so nudge it toward the pitch
      push(seats.x[e] + Math.sin(ya) * 0.42, seats.y[e] + 0.60, seats.z[e] + Math.cos(ya) * 0.42,
        ya, rng.range(1.8, 4.4), rng.range(0.7, 1.0), 0.045,
        pal[0], pal[rng.int(2, 4)], rng.int(0, 3));
    }

    // Hand flags up in the stands — small, high, a couple of big ones.
    const nFlag = ctx.quality.tier === 'low' ? 8 : 36;
    for (let i = 0; i < nFlag && this.count > 0; i++) {
      const idx = rng.int(0, this.count - 1) * STRIDE;
      const big = rng.next() < 0.3;
      const w = big ? rng.range(1.3, 2.0) : rng.range(0.45, 0.78);
      const pal = rng.next() < 0.5 ? teams.a : teams.b;
      push(this.master[idx + OFF_POS] + rng.range(-0.2, 0.2),
        this.master[idx + OFF_POS + 1] + (big ? 2.15 : 1.55),
        this.master[idx + OFF_POS + 2],
        this.master[idx + OFF_YAW] + rng.range(-0.35, 0.35),
        w, w * rng.range(0.55, 0.72), 0.14,
        pal[0], pal[rng.int(2, 4)], 10 + rng.int(0, 3));
    }

    const n = yaw.length;
    if (!n) return;
    const cloth = buildCloth();
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(cloth.getIndex());
    for (const k of Object.keys(cloth.attributes)) geo.setAttribute(k, cloth.attributes[k]);
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('iYaw', new THREE.InstancedBufferAttribute(new Float32Array(yaw), 1));
    geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(new Float32Array(size), 4));
    geo.setAttribute('iColA', new THREE.InstancedBufferAttribute(new Float32Array(colA), 3));
    geo.setAttribute('iColB', new THREE.InstancedBufferAttribute(new Float32Array(colB), 3));
    geo.setAttribute('iStyle', new THREE.InstancedBufferAttribute(new Float32Array(style), 1));
    geo.instanceCount = n;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 8, 0), 280);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uni as unknown as Record<string, THREE.IUniform>,
      vertexShader: CLOTH_VERT, fragmentShader: CLOTH_FRAG, side: THREE.DoubleSide,
    });
    mat.name = 'crowd-cloth';
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.name = 'crowd-cloth';
    this.group.add(mesh);
    this.disposables.push(cloth, geo, mat);
  }

  /* ---------------------------------------------------------------- events */

  private hookEvents(ctx: Ctx): void {
    ctx.events.on('sun:changed', (p: any) => {
      if (p && typeof p.hour === 'number') this.nightFromHour = nightAt(p.hour);
      this.syncLights(ctx);
    });
    ctx.events.on('env:ready', () => this.syncLights(ctx));

    ctx.events.on('score', (p: any) => {
      const team = typeof p?.team === 'number' ? p.team : 0;
      const z = (team === 0 ? -1 : 1) * (this.spec.innerHalfZ - 6);
      this.fire(ctx, 0, z, 1.0, 0.92);
    });
    ctx.events.on('disc:caught', (p: any) => {
      const v: any = p?.pos;
      const x = v?.x ?? v?.[0] ?? 0;
      const z = v?.z ?? v?.[2] ?? 0;
      const deep = Math.abs(z) > 30;
      this.fire(ctx, x, z, deep ? 0.75 : 0.42, deep ? 0.55 : 0.28);
    });
    ctx.events.on('disc:grounded', () => { this.energyTarget = Math.max(this.energyTarget, 0.32); });

    ctx.events.on('shot:apply', (p: any) => this.stageShot(ctx, p?.name, p?.shot));
    ctx.events.on('shot:applied', () => { this.nearDirty = true; });
  }

  /** Starts a celebration wave centred on a point, and lifts the room. */
  private fire(ctx: Ctx, x: number, z: number, strength: number, energy: number): void {
    const w = this.waves[this.waveSlot % this.waves.length];
    this.waveSlot++;
    w.set(x, z, ctx.time, strength);
    this.energyTarget = Math.max(this.energyTarget, energy);
    this.energy = Math.max(this.energy, energy * 0.75);
  }

  /**
   * Screenshot staging. The rig fires `shot:apply` and then settles ~2.5 s of
   * simulation, so a wave started here is scheduled *backwards* to be caught
   * mid-propagation in the frame that actually gets grabbed.
   */
  private stageShot(ctx: Ctx, name: string | undefined, shot: any): void {
    if (typeof shot?.hour === 'number') this.nightFromHour = nightAt(shot.hour);
    const lead = ctx.capture ? CAPTURE_SETTLE : 0;
    const at = (elapsed: number) => ctx.time + lead - elapsed;
    for (const w of this.waves) w.set(0, 0, 0, 0);
    this.waveSlot = 0;

    switch (name) {
      case 'endzone':
        this.energy = this.energyTarget = 0.60;
        this.waves[0].set(0, -(this.spec.innerHalfZ - 8), at(1.30), 1.0);
        break;
      case 'crowd':
        this.energy = this.energyTarget = 0.40;
        this.waves[0].set(-this.spec.innerHalfX, 20, at(2.30), 0.9);
        break;
      case 'night':
        this.energy = this.energyTarget = 0.34;
        this.waves[0].set(-22, -28, at(1.9), 0.65);
        break;
      case 'stadium':
        this.energy = this.energyTarget = 0.30;
        this.waves[0].set(0, 46, at(2.2), 0.85);
        break;
      default:
        this.energy = this.energyTarget = 0.20;
        break;
    }
    this.nearDirty = true;
    this.syncLights(ctx);
  }

  /* ---------------------------------------------------------------- lights */

  /**
   * The crowd runs a custom shader, so it is not lit by the scene's light list.
   * Instead it mirrors whatever the Lighting system put in the scene — key
   * direction and colour, hemisphere fill, ambient — and re-derives everything
   * from those bases each call so repeated syncs never compound.
   *
   * Peer spot lights contribute colour only: their intensities are aimed at the
   * pitch, and applying them to the stands would blow the crowd out.
   */
  private syncLights(ctx: Ctx): void {
    let sun: any = null;
    let hemi: any = null;
    const amb = new THREE.Color(0, 0, 0);
    const towerCol: THREE.Color[] = [];
    const towerPos: THREE.Vector3[] = [];

    const walk = (o: THREE.Object3D, depth: number) => {
      const l = o as any;
      if (l.isDirectionalLight) {
        if (!sun || l.intensity > sun.intensity) sun = l;
      } else if (l.isHemisphereLight) {
        if (!hemi || l.intensity > hemi.intensity) hemi = l;
      } else if (l.isAmbientLight) {
        amb.add(_c.copy(l.color).multiplyScalar(l.intensity));
      } else if ((l.isSpotLight || l.isPointLight) && towerPos.length < 4) {
        o.getWorldPosition(_v);
        if (_v.y > 9) { towerPos.push(_v.clone()); towerCol.push(l.color.clone()); }
      }
      if (depth < 3) for (const c of o.children) walk(c, depth + 1);
    };
    for (const c of ctx.scene.children) walk(c, 0);

    if (sun) {
      _v.copy(sun.position);
      if (sun.target) _v.sub(sun.target.position);
      if (_v.lengthSq() > 1e-6) this.uni.uSunDir.value.copy(_v).normalize();
      this.sunBase.copy(sun.color).multiplyScalar(sun.intensity);
    }
    if (hemi) {
      this.skyBase.copy(hemi.color).multiplyScalar(hemi.intensity);
      this.gndBase.copy(hemi.groundColor).multiplyScalar(hemi.intensity);
    }

    const key = Math.max(this.sunBase.r, this.sunBase.g, this.sunBase.b)
      * Math.max(0, this.uni.uSunDir.value.y);
    this.night = clamp(Math.max(this.nightFromHour, 1 - smoothstep(0.05, 0.5, key)), 0, 1);
    const day = 1 - this.night;

    this.uni.uNight.value = this.night;
    this.uni.uSunCol.value.copy(this.sunBase).multiplyScalar(day);
    this.uni.uSkyCol.value.copy(this.skyBase).multiplyScalar(0.16 + 0.84 * day);
    this.uni.uGndCol.value.copy(this.gndBase).multiplyScalar(0.10 + 0.90 * day);
    this.uni.uAmb.value.copy(amb).multiplyScalar(0.3 + 0.7 * day);

    // Four light towers outside the corners of the bowl, only at night.
    const s = this.spec;
    const tx = s.innerHalfX + this.rowsUsed * s.rowDepth + 8;
    const tz = s.innerHalfZ + this.rowsUsed * s.rowDepth + 8;
    const inten = 2600 * this.night;
    for (let i = 0; i < 4; i++) {
      const t = this.uni.uTowers.value[i];
      const c = this.uni.uTowerCol.value[i];
      if (this.night <= 0.01) { t.set(0, 0, 0, 0); continue; }
      if (towerPos[i]) {
        t.set(towerPos[i].x, towerPos[i].y, towerPos[i].z, inten);
        c.copy(towerCol[i]).lerp(_c.setRGB(1, 0.97, 0.92), 0.5);
      } else {
        t.set(i < 2 ? tx : -tx, 36, i % 2 === 0 ? tz : -tz, inten);
        c.setRGB(1, 0.97, 0.9);
      }
    }

    // Aerial perspective tracks whatever the sky system is doing.
    const fog: any = ctx.scene.fog;
    const bg: any = ctx.scene.background;
    if (fog?.isFog) {
      this.uni.uHaze.value.copy(fog.color);
      this.uni.uHazeRange.value.set(Math.max(16, fog.near * 0.45), Math.max(60, fog.far * 0.6));
    } else if (fog?.isFogExp2) {
      this.uni.uHaze.value.copy(fog.color);
      this.uni.uHazeRange.value.set(12, clamp(2.2 / Math.max(1e-4, fog.density), 60, 400));
    } else if (bg?.isColor) {
      this.uni.uHaze.value.copy(bg);
      this.uni.uHazeRange.value.set(26, 240);
    }
    this.uni.uHaze.value.multiplyScalar(0.35 + 0.65 * day);
  }

  /* ---------------------------------------------------------------- update */

  update(dt: number): void {
    this.energyTarget += (0.14 - this.energyTarget) * Math.min(1, dt * 0.22);
    this.energy += (this.energyTarget - this.energy) * Math.min(1, dt * 0.6);
  }

  lateUpdate(_dt: number, ctx: Ctx): void {
    this.uni.uTime.value = ctx.time;
    this.uni.uEnergy.value = this.energy;
    for (const w of this.waves) if (w.w > 0 && ctx.time - w.z > 16) w.set(0, 0, 0, 0);
    this.refreshNear(ctx);
  }

  /**
   * Gathers the nearest spectator blocks into the near-LOD instance buffer.
   * Blocks are ~30 contiguous seats, so the gather is a handful of memcpys. The
   * cut distance is published as `uNearEnd`; both LODs derive their per-instance
   * switch from it, so the far mesh picks up exactly what the near mesh drops.
   */
  private refreshNear(ctx: Ctx): void {
    const cam = ctx.camera.position;
    if (!this.nearDirty
      && cam.distanceToSquared(this.lastCam) < 1.5
      && ctx.frame - this.lastRefresh < 30) return;
    this.nearDirty = false;
    this.lastCam.copy(cam);
    this.lastRefresh = ctx.frame;
    if (!this.blocks.length || this.nearCap === 0) return;

    const B = this.blocks;
    const d = this.dists;
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      const dx = b.cx - cam.x, dy = b.cy - cam.y, dz = b.cz - cam.z;
      d[i] = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - b.r);
    }
    this.order2.sort((a, b) => d[a] - d[b]);

    let w = 0;
    let cut = MAX_NEAR_DIST;
    for (let i = 0; i < this.order2.length; i++) {
      const bi = this.order2[i];
      const b = B[bi];
      if (d[bi] >= MAX_NEAR_DIST) break;
      if (w + b.count > this.nearCap) { cut = d[bi]; break; }
      this.nearData.set(
        this.master.subarray(b.start * STRIDE, (b.start + b.count) * STRIDE), w * STRIDE);
      w += b.count;
    }
    this.nearGeo.instanceCount = w;
    this.nearBuf.needsUpdate = true;
    this.uni.uNearEnd.value = cut;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }
}

/** 1 in the dark, 0 in daylight, smooth through dawn and dusk. */
function nightAt(hour: number): number {
  return clamp(Math.max(smoothstep(19.1, 20.5, hour), smoothstep(7.0, 5.4, hour)), 0, 1);
}
