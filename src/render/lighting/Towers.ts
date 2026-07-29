import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Ctx } from '../../core/Ctx';
import { bake, heightField, heightToNormal, linearColor, packORM } from '../../util/Tex';
import { clamp, fbm2, smoothstep, worley2 } from '../../util/Noise';
import { FLOOD_COLOR } from './Solar';
import { FLOODLIGHT_TOWERS } from '../../world/stadium/Layout';

/**
 * The night rig: four corner floodlight towers.
 *
 * What sells a floodlit pitch is not brightness, it is *multiplicity* — every
 * player throws four overlapping shadows of different lengths and densities, and
 * every wet-looking surface carries four separate specular highlights. So the
 * towers are real SpotLights, all four shadow-casting at every quality tier,
 * aimed cross-field so their pools overlap on the centre of play.
 *
 * Everything is welded into world space and merged, so the whole rig — masts,
 * 84 fixtures, lenses, glows and beams — is five draw calls regardless of tier.
 *
 * Light counts never change after construction. Intensity, shadow intensity and
 * shadow auto-update are what get animated, because changing the number of
 * lights in the scene forces every material in the game to recompile.
 */

const HEAD_Y = 33.5;
const TOWER_X = 54;
const TOWER_Z = 47;

/** Where each tower aims — deliberately cross-field so the pools overlap. */
const AIM_BIAS_X = 11;
const AIM_BIAS_Z = 15;

const FIXTURE_COLS = 7;
const FIXTURE_ROWS = 3;

export interface TowerTier {
  spots: number;
  shadowCasters: number;
  spotShadowSize: number;
}

/**
 * Four towers is not a detail setting — it is the *look*. A floodlit pitch reads
 * as floodlit because every object throws several shadows of different lengths
 * in different directions; two lights give two shadows and the eye reads it as a
 * strange afternoon.
 *
 * The tier table used to say that and then break it, letting 1–3 of the 4 spots
 * cast below ultra — which is the one degradation that costs the shot the thing
 * it exists to show. So **all four cast at every tier**, and the budget comes
 * out of resolution instead: 4 × 768² is 2.4 M depth texels against 3 × 2048²'s
 * 12.6 M, so this is *cheaper* than what it replaces at every tier as well as
 * being the picture the brief promises. Resolution is the right thing to spend,
 * because the penumbra below is derived from the fixture rack's angular size and
 * is 9 cm wide at the receiver — softer than any of these maps can resolve
 * anyway. At night the sun's cascades stop updating (nothing casts a moon shadow
 * anyone can see), which is what pays for the fourth pass.
 */
export function tierFor(ctx: Ctx): TowerTier {
  const s = ctx.quality.shadowMapSize;
  switch (ctx.quality.tier) {
    case 'low': return { spots: 4, shadowCasters: 4, spotShadowSize: Math.min(s, 512) };
    case 'medium': return { spots: 4, shadowCasters: 4, spotShadowSize: Math.min(s, 768) };
    case 'high': return { spots: 4, shadowCasters: 4, spotShadowSize: Math.min(s, 1024) };
    default: return { spots: 4, shadowCasters: 4, spotShadowSize: Math.min(s, 1536) };
  }
}

/**
 * Half-angle of the spot cone, radians. `stadium/Layout.ts` says 0.34 covers the
 * pitch from these heads; wider does not add light where the play is, it only
 * sprays the near sideline where the inverse square makes the LED boards twenty
 * times brighter than the turf they sit behind.
 */
const CONE = 0.34;
/**
 * Fraction of the cone the depth pass covers. This was 0.55, which put a 21 m
 * shadow disc around each aim point on a 39 m light pool — so a player standing
 * anywhere but the middle of one tower's aim was lit by a light whose shadow
 * frustum did not contain him, and three returns "lit" outside the frustum.
 * Half the pitch was therefore unshadowed by construction. 0.80 puts the four
 * discs at ~30 m and their union covers the field including the endzones.
 */
const SHADOW_FOCUS = 0.80;
/**
 * Width of the fixture rack, metres — the physical size of the light source.
 * Penumbra at a receiver is sourceWidth × (occluder→receiver) / (source→occluder),
 * so a 10 m rack at a 110 m throw gives a 9 cm soft edge under a standing player.
 * That is the number the PCF radius is solved from below, rather than a constant
 * that means a different blur at every map size.
 */
const RACK_W = 10.0;
/** Typical occluder height above its own contact shadow, metres. */
const CONTACT_H = 1.0;

/* ------------------------------------------------------------- textures */

/** Galvanised steel: mottled zinc, weld spatter, weather streaks, fine pitting. */
function steelMaps(size: number, aniso: number) {
  const h = heightField(size, (u, v) => {
    const s = 6;
    let n = fbm2(u * s * 4, v * s * 4, { octaves: 4, seed: 11 }) * 0.5 + 0.5;
    const pit = worley2(u * size * 0.09, v * size * 0.09, 3).f1;
    n -= smoothstep(0.42, 0.0, pit) * 0.55;
    // vertical weather runs
    n += (fbm2(u * 26, v * 2.2, { octaves: 3, seed: 5 }) * 0.5 + 0.5) * 0.22;
    return n;
  });

  const base = linearColor(0x8e97a0);
  const rust = linearColor(0x6b4a34);
  const map = bake((x, y, u, v, out, i) => {
    const n = h[y * size + x];
    const streak = fbm2(u * 22, v * 1.8, { octaves: 3, seed: 5 }) * 0.5 + 0.5;
    const grime = smoothstep(0.55, 0.95, streak) * 0.5;
    const shade = 0.62 + 0.5 * n;
    const r = (base.r * shade) * (1 - grime) + rust.r * grime;
    const g = (base.g * shade) * (1 - grime) + rust.g * grime;
    const b = (base.b * shade) * (1 - grime) + rust.b * grime;
    // stored as sRGB
    out[i] = Math.pow(clamp(r, 0, 1), 1 / 2.2) * 255;
    out[i + 1] = Math.pow(clamp(g, 0, 1), 1 / 2.2) * 255;
    out[i + 2] = Math.pow(clamp(b, 0, 1), 1 / 2.2) * 255;
    out[i + 3] = 255;
  }, { size, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'tower.steel.albedo' });

  const ao = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const n = h[i];
    ao[i] = clamp(0.55 + 0.45 * n, 0, 1);
    rough[i] = clamp(0.38 + 0.42 * (1 - n) + 0.1 * Math.sin(i * 0.37), 0.2, 0.95);
    metal[i] = clamp(0.92 - 0.35 * smoothstep(0.2, 0.0, n), 0, 1);
  }
  const orm = packORM(ao, rough, metal, size, { anisotropy: aniso, name: 'tower.steel.orm' });
  const normalMap = heightToNormal(h, size, size, 1.6, { anisotropy: aniso, name: 'tower.steel.n' });
  return { map, orm, normalMap };
}

/** Floodlight lens: hex reflector cells behind a ringed prismatic cover. */
function lensMaps(size: number, aniso: number) {
  const h = heightField(size, (u, v) => {
    const dx = u - 0.5, dy = v - 0.5;
    const r = Math.hypot(dx, dy) * 2;
    const rings = Math.sin(r * 46) * 0.5 + 0.5;
    const cell = worley2(u * 9, v * 9, 21);
    const hex = smoothstep(0.02, 0.18, cell.f2 - cell.f1);
    return rings * 0.35 + hex * 0.65;
  });

  const map = bake((x, y, u, v, out, i) => {
    const dx = u - 0.5, dy = v - 0.5;
    const r = Math.hypot(dx, dy) * 2;
    const n = h[y * size + x];
    const glass = clamp(0.16 + 0.5 * n, 0, 1) * (1 - smoothstep(0.86, 1.0, r));
    const rim = smoothstep(0.86, 0.94, r) * (1 - smoothstep(0.98, 1.02, r));
    const c = clamp(glass + rim * 0.28, 0, 1);
    out[i] = Math.pow(c, 1 / 2.2) * 255;
    out[i + 1] = Math.pow(c * 1.01, 1 / 2.2) * 255;
    out[i + 2] = Math.pow(c * 1.06, 1 / 2.2) * 255;
    out[i + 3] = 255;
  }, { size, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'tower.lens.albedo' });

  // Emission is hottest at the centre of the reflector and cut off at the rim.
  const emissive = bake((x, y, u, v, out, i) => {
    const dx = u - 0.5, dy = v - 0.5;
    const r = Math.hypot(dx, dy) * 2;
    const n = h[y * size + x];
    const core = Math.exp(-r * r * 2.4);
    const cellHot = 0.45 + 0.55 * n;
    const e = clamp((0.32 + 0.68 * core) * cellHot * (1 - smoothstep(0.82, 0.99, r)), 0, 1);
    const c = Math.pow(e, 1 / 2.2) * 255;
    out[i] = c; out[i + 1] = c * 0.99; out[i + 2] = c; out[i + 3] = 255;
  }, { size, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'tower.lens.emissive' });

  const normalMap = heightToNormal(h, size, size, 1.1, { anisotropy: aniso, name: 'tower.lens.n' });
  return { map, emissive, normalMap };
}

/* ------------------------------------------------------------ geometry */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _altUp = new THREE.Vector3(0, 0, 1);
const YAXIS = new THREE.Vector3(0, 1, 0);

/** A cylindrical member spanning two world points. */
function strut(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): THREE.BufferGeometry {
  _a.set(ax, ay, az); _b.set(bx, by, bz);
  const len = _a.distanceTo(_b);
  const g = new THREE.CylinderGeometry(r, r, len, 6, 1, false);
  _b.sub(_a).normalize();
  _q.setFromUnitVectors(YAXIS, _b);
  _m.compose(_a.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(_m);
  return g;
}

function orient(target: THREE.Matrix4, from: THREE.Vector3, to: THREE.Vector3, axis: THREE.Vector3): void {
  _b.copy(to).sub(from).normalize();
  const up = Math.abs(_b.dot(_up)) > 0.98 ? _altUp : _up;
  _q.setFromUnitVectors(axis, _b);
  // keep roll stable by re-deriving from a lookAt basis
  _m.lookAt(from, to, up);
  target.identity().extractRotation(_m);
  // lookAt gives -Z forward; rotate the requested axis onto -Z first
  const fix = new THREE.Quaternion().setFromUnitVectors(axis, new THREE.Vector3(0, 0, -1));
  target.multiply(new THREE.Matrix4().makeRotationFromQuaternion(fix));
  target.setPosition(from);
}

export interface TowerSlot {
  head: THREE.Vector3;
  aim: THREE.Vector3;
  index: number;
}

/**
 * The stadium publishes where its masts actually are.
 *
 * `world/stadium/Layout.ts` exports `FLOODLIGHT_TOWERS` with the note *"put your
 * light source here"* — and it matters, because this rig was doing neither. It
 * stood its own lattice masts at (±54, 33.5, ±47), which is **inside** the roof
 * ring and roughly six metres below the canopy's trailing edge, so every beam
 * had to pass through the roof to reach the pitch. The result at ultra, where
 * the spots cast shadows, was a set of enormous hard-edged dark polygons lying
 * across the middle of the field: the roof trusses, correctly shadowed, from a
 * light source that no stadium would ever site there. It also drew a second set
 * of masts a critic could see next to the real ones.
 *
 * So the geometry comes from the stadium when the stadium has any, and the rig
 * falls back to its own corner masts only in a build without one.
 */
function canonicalSlots(): TowerSlot[] | null {
  const src = FLOODLIGHT_TOWERS as ReadonlyArray<{
    head: readonly number[]; aim: readonly number[];
  }> | undefined;
  if (!Array.isArray(src) || src.length < 1) return null;
  const out: TowerSlot[] = [];
  for (let i = 0; i < src.length && i < 4; i++) {
    const t = src[i];
    if (!t?.head || !t?.aim || t.head.length < 3 || t.aim.length < 3) return null;
    if (!isFinite(t.head[0] + t.head[1] + t.head[2])) return null;
    out.push({
      index: i,
      head: new THREE.Vector3(t.head[0], t.head[1], t.head[2]),
      aim: new THREE.Vector3(t.aim[0], t.aim[1], t.aim[2]),
    });
  }
  return out.length ? out : null;
}

/* --------------------------------------------------------------- class */

export class TowerRig {
  readonly group = new THREE.Group();
  readonly spots: THREE.SpotLight[] = [];
  readonly slots: TowerSlot[] = [];

  private lensMat!: THREE.MeshStandardMaterial;
  private glowMat!: THREE.ShaderMaterial;
  private beamMat!: THREE.ShaderMaterial;
  private glowMesh!: THREE.Mesh;
  private beamMesh!: THREE.Mesh;
  private tier!: TowerTier;
  private disposables: Array<{ dispose(): void }> = [];
  private primed = 0;
  /** True when the stadium owns the mast hardware and we only place lights. */
  private hosted = false;
  /** Mean squared distance from a head to its aim point, for the irradiance estimate. */
  private throw2 = 95 * 95;

  /** Irradiance the rig currently puts on the pitch, for exposure + ambient. */
  irradiance = 0;

  build(ctx: Ctx): void {
    this.tier = tierFor(ctx);
    this.group.name = 'lighting.towers';
    ctx.scene.add(this.group);

    const canon = canonicalSlots();
    if (canon) {
      this.hosted = true;
      for (const s of canon) this.slots.push(s);
    } else {
      const corners: Array<[number, number]> = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
      for (let i = 0; i < corners.length; i++) {
        const [sx, sz] = corners[i];
        this.slots.push({
          index: i,
          head: new THREE.Vector3(sx * TOWER_X, HEAD_Y, sz * TOWER_Z),
          aim: new THREE.Vector3(-sx * AIM_BIAS_X, 0.0, -sz * AIM_BIAS_Z),
        });
      }
    }

    let sum2 = 0;
    for (const s of this.slots) sum2 += s.head.distanceToSquared(s.aim);
    this.throw2 = Math.max(400, sum2 / this.slots.length);

    if (this.hosted) { this.buildLights(ctx); this.buildAtmospherics(); return; }

    const texSize = ctx.quality.tier === 'low' ? 256 : 512;
    const aniso = ctx.quality.anisotropy;
    const steel = steelMaps(texSize, aniso);
    const lens = lensMaps(texSize, aniso);
    this.disposables.push(steel.map, steel.orm, steel.normalMap, lens.map, lens.emissive, lens.normalMap);

    const steelMat = new THREE.MeshStandardMaterial({
      map: steel.map,
      normalMap: steel.normalMap,
      roughnessMap: steel.orm,
      metalnessMap: steel.orm,
      roughness: 1,
      metalness: 1,
      normalScale: new THREE.Vector2(0.8, 0.8),
      name: 'tower.steel',
    });
    this.lensMat = new THREE.MeshStandardMaterial({
      map: lens.map,
      normalMap: lens.normalMap,
      emissiveMap: lens.emissive,
      emissive: FLOOD_COLOR.clone(),
      emissiveIntensity: 0,
      roughness: 0.16,
      metalness: 0.05,
      name: 'tower.lens',
    });
    this.disposables.push(steelMat, this.lensMat);

    /* ------------------------------------------------------ structure */

    const struts: THREE.BufferGeometry[] = [];
    const housings: THREE.BufferGeometry[] = [];
    const lenses: THREE.BufferGeometry[] = [];
    const glowPts: Array<{ p: THREE.Vector3; s: number }> = [];
    const beams: THREE.BufferGeometry[] = [];

    for (const slot of this.slots) {
      this.buildMast(slot, struts);
      this.buildHead(ctx, slot, struts, housings, lenses, glowPts);
      beams.push(this.buildBeam(slot));
    }

    const structure = new THREE.Mesh(mergeGeometries(struts, false), steelMat);
    structure.castShadow = false;      // towers are outside every cascade of interest
    structure.receiveShadow = false;
    structure.name = 'towers.structure';
    for (const g of struts) g.dispose();

    const housing = new THREE.Mesh(mergeGeometries(housings, false), steelMat);
    housing.name = 'towers.housings';
    for (const g of housings) g.dispose();

    const lensMesh = new THREE.Mesh(mergeGeometries(lenses, false), this.lensMat);
    lensMesh.name = 'towers.lenses';
    for (const g of lenses) g.dispose();

    this.group.add(structure, housing, lensMesh);
    this.disposables.push(structure.geometry, housing.geometry, lensMesh.geometry);

    this.buildAtmospherics(glowPts);
    this.buildLights(ctx);
  }

  /* ------------------------------------------------------- sub-builders */

  /** Lens halos and the soft scatter cone hanging off each head. */
  private buildAtmospherics(glowPts?: Array<{ p: THREE.Vector3; s: number }>): void {
    const pts = glowPts ?? this.slots.map((s) => ({ p: s.head.clone(), s: 5.5 }));

    this.glowMat = makeGlowMaterial();
    this.glowMesh = new THREE.Mesh(buildGlowQuads(pts), this.glowMat);
    this.glowMesh.name = 'towers.glow';
    this.glowMesh.frustumCulled = false;
    this.glowMesh.renderOrder = 20;
    this.group.add(this.glowMesh);
    this.disposables.push(this.glowMat, this.glowMesh.geometry);

    const beams = this.slots.map((s) => this.buildBeam(s));
    this.beamMat = makeBeamMaterial();
    this.beamMesh = new THREE.Mesh(mergeGeometries(beams, false), this.beamMat);
    this.beamMesh.name = 'towers.beams';
    this.beamMesh.renderOrder = 19;
    this.group.add(this.beamMesh);
    for (const g of beams) g.dispose();
    this.disposables.push(this.beamMat, this.beamMesh.geometry);
  }

  private buildLights(_ctx: Ctx): void {
    const size = this.tier.spotShadowSize;
    for (let i = 0; i < this.tier.spots && i < this.slots.length; i++) {
      const slot = this.slots[i];
      const thr = Math.max(20, slot.head.distanceTo(slot.aim));
      const spot = new THREE.SpotLight(FLOOD_COLOR.getHex(), 0, 0, CONE, 0.62, 2);
      spot.color.copy(FLOOD_COLOR);
      spot.position.copy(slot.head);
      spot.target.position.copy(slot.aim);
      spot.name = `tower.spot.${i}`;
      spot.castShadow = i < this.tier.shadowCasters;
      if (spot.castShadow) {
        spot.shadow.mapSize.set(size, size);
        spot.shadow.camera.near = Math.max(8, thr * 0.30);
        spot.shadow.camera.far = thr * 1.9;
        spot.shadow.focus = SHADOW_FOCUS;
        spot.shadow.bias = -0.00022;
        spot.shadow.normalBias = 0.045;
        // PCF taps are offset in *texels*, so a constant radius is a different
        // blur at every map size and at every throw. Solve it instead: the
        // penumbra a 10 m rack casts under a standing player at this throw is
        // ~9 cm, and one shadow texel here covers 2·tan(CONE·focus)·thr/size
        // metres. The floor keeps a single tap from stair-stepping; the ceiling
        // keeps the kernel inside what a 5×5 PCF can afford.
        const texel = (2 * Math.tan(CONE * SHADOW_FOCUS) * thr) / size;
        const penumbra = (RACK_W * CONTACT_H) / thr;
        spot.shadow.radius = clamp(penumbra / texel, 0.9, 3.6);
        spot.shadow.intensity = 0;
      }
      this.group.add(spot, spot.target);
      this.spots.push(spot);
    }
  }

  private buildMast(slot: TowerSlot, out: THREE.BufferGeometry[]): void {
    const { x, z } = slot.head;
    // Face the lattice at the field so the bracing reads in silhouette.
    const yaw = Math.atan2(slot.aim.x - x, slot.aim.z - z);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const local = (lx: number, lz: number, ly: number): [number, number, number] =>
      [x + lx * cy + lz * sy, ly, z - lx * sy + lz * cy];

    const STAGES = 8;
    const TOP = HEAD_Y - 5.2;
    const baseHW = 3.1, topHW = 1.15;
    const hwAt = (t: number) => baseHW + (topHW - baseHW) * Math.pow(t, 0.75);
    const cs: Array<[number, number]> = [[1, 1], [-1, 1], [-1, -1], [1, -1]];

    for (let s = 0; s < STAGES; s++) {
      const t0 = s / STAGES, t1 = (s + 1) / STAGES;
      const y0 = t0 * TOP, y1 = t1 * TOP;
      const h0 = hwAt(t0), h1 = hwAt(t1);
      for (let c = 0; c < 4; c++) {
        const [ax, az] = cs[c];
        const p0 = local(ax * h0, az * h0, y0);
        const p1 = local(ax * h1, az * h1, y1);
        out.push(strut(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], 0.155 - 0.05 * t0));

        // ring at the top of the stage
        const [bx, bz] = cs[(c + 1) % 4];
        const r0 = local(ax * h1, az * h1, y1);
        const r1 = local(bx * h1, bz * h1, y1);
        out.push(strut(r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], 0.075));

        // face diagonal, alternating direction stage to stage
        const flip = (s + c) % 2 === 0;
        const d0 = flip ? local(ax * h0, az * h0, y0) : local(bx * h0, bz * h0, y0);
        const d1 = flip ? local(bx * h1, bz * h1, y1) : local(ax * h1, az * h1, y1);
        out.push(strut(d0[0], d0[1], d0[2], d1[0], d1[1], d1[2], 0.062));
      }
    }

    // Base spread feet.
    for (const [ax, az] of cs) {
      const p = local(ax * baseHW, az * baseHW, 0.1);
      const f = local(ax * (baseHW + 1.5), az * (baseHW + 1.5), 0);
      out.push(strut(p[0], p[1], p[2], f[0], f[1], f[2], 0.13));
    }
  }

  private buildHead(
    ctx: Ctx, slot: TowerSlot,
    struts: THREE.BufferGeometry[], housings: THREE.BufferGeometry[],
    lenses: THREE.BufferGeometry[], glow: Array<{ p: THREE.Vector3; s: number }>,
  ): void {
    const { x, z } = slot.head;
    const yaw = Math.atan2(slot.aim.x - x, slot.aim.z - z);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const wp = (lx: number, ly: number, lz: number, out = new THREE.Vector3()) =>
      out.set(x + lx * cy + lz * sy, ly, z - lx * sy + lz * cy);

    const rackW = 5.0;
    const yBase = HEAD_Y - 5.2;
    const yTop = HEAD_Y + 1.4;

    // Rack frame: two uprights, four cross beams, back stays into the mast.
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    for (const sgn of [-1, 1]) {
      wp(sgn * rackW, yBase, 1.0, p); wp(sgn * rackW, yTop, 1.6, q);
      struts.push(strut(p.x, p.y, p.z, q.x, q.y, q.z, 0.13));
      wp(sgn * rackW, yBase, 1.0, p); wp(sgn * 1.0, yBase - 1.6, -0.4, q);
      struts.push(strut(p.x, p.y, p.z, q.x, q.y, q.z, 0.1));
      wp(sgn * rackW, yTop, 1.6, p); wp(sgn * 0.9, yTop - 2.6, -0.9, q);
      struts.push(strut(p.x, p.y, p.z, q.x, q.y, q.z, 0.09));
    }
    for (let r = 0; r <= FIXTURE_ROWS; r++) {
      const t = r / FIXTURE_ROWS;
      const y = yBase + (yTop - yBase) * t;
      const zz = 1.0 + 0.6 * t;
      wp(-rackW, y, zz, p); wp(rackW, y, zz, q);
      struts.push(strut(p.x, p.y, p.z, q.x, q.y, q.z, 0.09));
    }
    // maintenance platform edge
    wp(-rackW - 0.4, yBase - 0.5, -0.6, p); wp(rackW + 0.4, yBase - 0.5, -0.6, q);
    struts.push(strut(p.x, p.y, p.z, q.x, q.y, q.z, 0.07));

    /* fixtures */
    const rng = ctx.rand.fork(9100 + slot.index);
    const aim = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();

    for (let r = 0; r < FIXTURE_ROWS; r++) {
      const ty = (r + 0.5) / FIXTURE_ROWS;
      const y = yBase + (yTop - yBase) * ty + 0.25;
      for (let c = 0; c < FIXTURE_COLS; c++) {
        const tx = c / Math.max(1, FIXTURE_COLS - 1);
        const lx = (tx - 0.5) * 2 * (rackW - 0.55);
        wp(lx, y, 1.35 + 0.55 * ty, pos);

        // Each row rakes to a different depth of the pitch; small deterministic
        // jitter stops the array from reading as a decal.
        aim.set(
          slot.aim.x + (rng.next() - 0.5) * 26 - lx * 1.2,
          0.4,
          slot.aim.z + (r - 1) * 21 + (rng.next() - 0.5) * 18,
        );
        orient(m, pos, aim, YAXIS);

        const body = new THREE.CylinderGeometry(0.30, 0.36, 0.46, 12, 1, false);
        body.applyMatrix4(m);
        housings.push(body);

        const shroud = new THREE.CylinderGeometry(0.44, 0.33, 0.16, 12, 1, true);
        shroud.translate(0, 0.30, 0);
        shroud.applyMatrix4(m);
        housings.push(shroud);

        const yoke = new THREE.CylinderGeometry(0.05, 0.05, 0.62, 6, 1, false);
        yoke.rotateZ(Math.PI / 2);
        yoke.translate(0, -0.16, 0);
        yoke.applyMatrix4(m);
        housings.push(yoke);

        const disc = new THREE.CircleGeometry(0.335, 18);
        disc.rotateX(-Math.PI / 2);
        disc.translate(0, 0.325, 0);
        disc.applyMatrix4(m);
        lenses.push(disc);

        const gp = new THREE.Vector3(0, 0.35, 0).applyMatrix4(m);
        glow.push({ p: gp, s: 1.15 + rng.next() * 0.2 });
      }
    }
  }

  /** A short, soft scatter cone hanging off each head. */
  private buildBeam(slot: TowerSlot): THREE.BufferGeometry {
    const len = Math.min(46, slot.head.distanceTo(slot.aim) * 0.42);
    const g = new THREE.ConeGeometry(len * Math.tan(0.36), len, 22, 1, true);
    g.translate(0, -len / 2, 0);
    const dir = new THREE.Vector3().subVectors(slot.aim, slot.head).normalize();
    _q.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
    _m.compose(slot.head.clone(), _q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(_m);
    return g;
  }

  /* -------------------------------------------------------------- tick */

  /**
   * `factor` 0..1 is how "on" the rig is. Light *counts* never change, only
   * their strength — see the class note.
   */
  update(factor: number, ctx: Ctx): void {
    const f = clamp(factor, 0, 1);
    const on = f > 0.004;

    // Candela: irradiance at the pitch is I / d^2 with decay 2, and the towers
    // sit ~95 m out, so the numbers are necessarily large.
    const perSpot = 6400 * f;
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i];
      s.intensity = perSpot;
      s.visible = true;                        // constant light count, always
      if (s.castShadow) {
        // Full density. Capping this at 0.86 was pre-emptively lifting every
        // shadow by 14 % *before* the indirect budget had even been subtracted,
        // on the assumption that the fill would otherwise look crushed. The fill
        // is now solved rather than guessed (see Ambient.ts), so the shadow gets
        // to be a shadow and softness comes from the derived penumbra above.
        s.shadow.intensity = f;
        // Freeze the depth pass while the rig is dark; prime it for the first
        // couple of frames so the sampler always has a valid map bound.
        s.shadow.autoUpdate = on || this.primed < 2;
      }
    }
    this.primed++;

    this.irradiance = (perSpot / this.throw2) * Math.min(this.spots.length, 4) * 0.62;

    if (this.lensMat) {
      this.lensMat.emissiveIntensity = 26 * f;
      this.lensMat.roughness = 0.16;
    }

    const glowU = this.glowMat.uniforms;
    // When the stadium draws its own lit fixture clusters, this is a halo on
    // top of something already bright — a fraction of the standalone value.
    glowU.uIntensity.value = (this.hosted ? 1.1 : 3.1) * f;
    glowU.uColor.value.copy(FLOOD_COLOR);
    this.glowMesh.visible = on;

    const beamU = this.beamMat.uniforms;
    beamU.uIntensity.value = 0.30 * f * (ctx.quality.tier === 'low' ? 0.6 : 1);
    beamU.uColor.value.copy(FLOOD_COLOR);
    this.beamMesh.visible = on;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}

/* -------------------------------------------------------------- shaders */

function buildGlowQuads(pts: Array<{ p: THREE.Vector3; s: number }>): THREE.BufferGeometry {
  const n = pts.length;
  const pos = new Float32Array(n * 4 * 3);
  const uv = new Float32Array(n * 4 * 2);
  const scale = new Float32Array(n * 4);
  const idx = new Uint32Array(n * 6);
  const CORN = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (let i = 0; i < n; i++) {
    const { p, s } = pts[i];
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      pos[v * 3] = p.x; pos[v * 3 + 1] = p.y; pos[v * 3 + 2] = p.z;
      uv[v * 2] = CORN[c][0]; uv[v * 2 + 1] = CORN[c][1];
      scale[v] = s;
    }
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function makeGlowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uIntensity: { value: 0 },
      uColor: { value: FLOOD_COLOR.clone() },
    },
    vertexShader: /* glsl */`
      attribute float aScale;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        mv.xy += ( uv - 0.5 ) * 2.0 * aScale;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uIntensity;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length( p );
        float core = exp( -r * r * 11.0 );
        float halo = exp( -r * 3.1 ) * 0.30;
        float star = pow( max( 0.0, 1.0 - abs( p.x ) * 6.0 ), 3.0 ) * exp( -abs( p.y ) * 4.0 )
                   + pow( max( 0.0, 1.0 - abs( p.y ) * 6.0 ), 3.0 ) * exp( -abs( p.x ) * 4.0 );
        float a = ( core + halo + star * 0.22 ) * uIntensity;
        if ( a < 0.0015 ) discard;
        gl_FragColor = vec4( uColor * a, a );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
}

function makeBeamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uIntensity: { value: 0 },
      uColor: { value: FLOOD_COLOR.clone() },
    },
    vertexShader: /* glsl */`
      varying vec3 vN;
      varying vec3 vW;
      varying float vT;
      void main() {
        vN = normalize( mat3( modelMatrix ) * normal );
        vec4 w = modelMatrix * vec4( position, 1.0 );
        vW = w.xyz;
        vT = 1.0 - uv.y;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uIntensity;
      uniform vec3 uColor;
      varying vec3 vN;
      varying vec3 vW;
      varying float vT;
      void main() {
        vec3 N = normalize( vN );
        vec3 V = normalize( cameraPosition - vW );
        float rim = 1.0 - abs( dot( N, V ) );
        float a = pow( rim, 1.8 ) * pow( 1.0 - vT, 2.4 ) * uIntensity;
        a *= smoothstep( 0.0, 0.16, vT );
        if ( a < 0.0008 ) discard;
        gl_FragColor = vec4( uColor * a, a );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
  });
}
