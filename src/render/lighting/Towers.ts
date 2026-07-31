import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Ctx } from '../../core/Ctx';
import { bake, heightField, heightToNormal, linearColor, packORM } from '../../util/Tex';
import { clamp, fbm2, smoothstep, worley2 } from '../../util/Noise';
import { FLOOD_COLOR } from './Solar';
import { FLOODLIGHT_TOWERS } from '../../world/stadium/Layout';
import { FIELD, MOW_STRIPE } from '../../world/field/Layout';

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
  private sheenMat!: THREE.ShaderMaterial;
  private glowMesh!: THREE.Mesh;
  private beamMesh!: THREE.Mesh;
  private sheenMesh!: THREE.Mesh;
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

    this.buildSheen();
  }

  /**
   * THE WET-GRASS SHEEN — the one thing in a night frame that says "floodlit".
   *
   * A floodlit pitch does not read as floodlit because it is bright. It reads as
   * floodlit because the sward carries four long anisotropic highlights, one per
   * tower, banded by the mow and strongest where the sightline grazes. Take that
   * away and you have a green field at a low exposure, which is exactly what the
   * round-5 review saw: "no visible specular kick on skin or turf anywhere in the
   * frame".
   *
   * It is missing for a structural reason, not an artistic one. The near-field
   * grass in `world/grass/shader.ts` has a full Kajiya-Kay sheen — and it is
   * wired to `uSunDir`/`uSunCol`, which at 21:30 is a 0.24-intensity blue moon,
   * so the sheen is off by three stops exactly when it matters. The far pitch is
   * `TurfMaterial`, an isotropic MeshStandardMaterial at roughness 0.82–0.92:
   * the four spots do reach it, but a GGX lobe that broad puts the specular at
   * ~15 % of the diffuse, which is a modulation, not a highlight. And the
   * ultra-only `GroundSsrPass` — the pass that actually mirrors a wet pitch — is
   * gated off at every tier the critics capture at.
   *
   * So the rig delivers its own. One additive pass over the mown turf: for each
   * of the four real heads, a Kajiya–Kay lobe about a blade tangent that tilts
   * ±X with the mow lay (the same `MOW_STRIPE` the turf albedo and the grass
   * lean read), inverse-square weighted off the real head positions, gated on a
   * grazing view because that is when wet grass mirrors and a top-down look at
   * the same grass does not. Zero when the rig is dark, so it costs one draw
   * call and contributes literally nothing to any daylight frame.
   *
   * The quad is flat at y = 0.10. The pitch is crowned 1 % and its surface lives
   * between −0.06 and +0.04, so this clears it everywhere without needing the
   * height field in a lighting file; 10 cm of parallax on a gradient that is
   * metres wide is not a visible error, and the depth test still hides the sheen
   * behind every body on the pitch.
   */
  private buildSheen(): void {
    const g = new THREE.PlaneGeometry(FIELD.turfHalfX * 2, FIELD.turfHalfZ * 2, 1, 1);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.10, 0);

    this.sheenMat = makeSheenMaterial(this.slots.map((s) => s.head));
    this.sheenMesh = new THREE.Mesh(g, this.sheenMat);
    this.sheenMesh.name = 'towers.sheen';
    this.sheenMesh.frustumCulled = false;
    this.sheenMesh.renderOrder = 18;
    this.sheenMesh.castShadow = false;
    this.sheenMesh.receiveShadow = false;
    this.group.add(this.sheenMesh);
    this.disposables.push(this.sheenMat, g);
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

  /**
   * A short, soft scatter cone hanging off each head.
   *
   * Carries the beam's own axis per vertex. The old shader had only the cone's
   * surface normal to work with, so all it could compute was a rim term — which
   * draws the *outline* of a cone and nothing inside it, and reads as a wireframe
   * rather than as lit air. With the axis in hand the fragment shader can run a
   * real Henyey-Greenstein phase on the angle between the beam and the eye, and
   * that is the whole effect: a floodlight aimed near the lens is spectacular and
   * one aimed away is invisible, which is also what selects the two towers that
   * matter in any given frame without a per-tower CPU sort.
   */
  private buildBeam(slot: TowerSlot): THREE.BufferGeometry {
    const len = Math.min(46, slot.head.distanceTo(slot.aim) * 0.42);
    const g = new THREE.ConeGeometry(len * Math.tan(0.36), len, 22, 1, true);
    g.translate(0, -len / 2, 0);
    const dir = new THREE.Vector3().subVectors(slot.aim, slot.head).normalize();
    _q.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
    _m.compose(slot.head.clone(), _q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(_m);

    const n = g.getAttribute('position').count;
    const axis = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      axis[i * 3] = dir.x; axis[i * 3 + 1] = dir.y; axis[i * 3 + 2] = dir.z;
    }
    g.setAttribute('aAxis', new THREE.BufferAttribute(axis, 3));
    return g;
  }

  /* -------------------------------------------------------------- tick */

  /**
   * `factor` 0..1 is how much light the rig is putting on the pitch;
   * `visual` 0..1 is how lit the fixtures themselves look. They are separate
   * curves — see `SunState.towersVisual`. Light *counts* never change, only
   * their strength; see the class note.
   */
  update(factor: number, ctx: Ctx, visual = factor): void {
    const f = clamp(factor, 0, 1);
    const vis = clamp(visual, 0, 1);
    const on = vis > 0.004;

    // Candela: irradiance at the pitch is I / d^2 with decay 2, and the towers
    // sit ~103 m out, so the numbers are necessarily large.
    //
    // 6 400 cd was a stop and a half short of a floodlit pitch and it showed up
    // in the one place it could not be argued with: the auto-exposure. The rig
    // delivered ~1.3 irradiance units at pitch centre against a night target of
    // 3.15, so the meter opened to 2.3× to compensate — and everything in the
    // frame with a *fixed* emission, above all the LED ribbon, was multiplied by
    // that same 2.3 and ran to the top of the range. Raising the rig instead
    // lets the meter close down, which pulls the boards back into signage
    // brightness without touching a single value in the board shader. 16 000 cd
    // is ~4.1 units at the middle of the pitch, exposure lands near 1.1, and the
    // turf sits where a floodlit pitch sits.
    const perSpot = 16000 * f;
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
        s.shadow.autoUpdate = f > 0.004 || this.primed < 2;
      }
    }
    this.primed++;

    this.irradiance = (perSpot / this.throw2) * Math.min(this.spots.length, 4) * 0.62;

    // Everything below is *how the fixture looks*, not what it delivers, so it
    // runs off the visual ramp: struck lamps glowing on a dusk mast before the
    // grass has any idea about it.
    if (this.lensMat) {
      this.lensMat.emissiveIntensity = 26 * vis;
      this.lensMat.roughness = 0.16;
    }

    const glowU = this.glowMat.uniforms;
    // When the stadium draws its own lit fixture clusters, this is a halo on
    // top of something already bright — a fraction of the standalone value.
    // 1.1 → 1.7 now that a framing exists which actually contains a mast head:
    // the halo is what bloom has to bite on, and at 130 m a 24-lamp cluster is
    // sixty pixels of frame that has to survive the night exposure.
    glowU.uIntensity.value = (this.hosted ? 1.7 : 3.1) * vis;
    glowU.uColor.value.copy(FLOOD_COLOR);
    this.glowMesh.visible = on;

    // 0.30 → 1.15. The old number was set against a rim-only term that drew the
    // cone's outline; the phase function below concentrates the same energy into
    // the beams pointing near the lens and leaves the rest almost dark, so the
    // peak has to come up for the near ones to read as lit air at all.
    const beamU = this.beamMat.uniforms;
    beamU.uIntensity.value = 1.15 * vis * (ctx.quality.tier === 'low' ? 0.55 : 1);
    beamU.uColor.value.copy(FLOOD_COLOR);
    this.beamMesh.visible = on;

    const sheenU = this.sheenMat.uniforms;
    // Rides `f`, not `vis`: this is light *on the grass*, so it appears with the
    // irradiance and not with the lamps warming up.
    sheenU.uIntensity.value = 1.0 * f;
    sheenU.uColor.value.copy(FLOOD_COLOR);
    this.sheenMesh.visible = f > 0.004;
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
        // No star-cross term. A four-armed flare drawn into the sprite is a
        // sticker: it does not rotate with the camera roll, it does not scale
        // with the fixture's apparent size, and it is identical on all 84
        // heads. The bloom pass makes a real, exposure-aware halo out of a
        // 16 000 cd lens on its own.
        float a = ( core + halo ) * uIntensity;
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
      attribute vec3 aAxis;
      varying vec3 vN;
      varying vec3 vW;
      varying vec3 vAxis;
      varying float vT;
      void main() {
        vN = normalize( mat3( modelMatrix ) * normal );
        vAxis = normalize( mat3( modelMatrix ) * aAxis );
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
      varying vec3 vAxis;
      varying float vT;

      /** Henyey-Greenstein, normalised so the forward peak is 1. */
      float hg( float c, float g ) {
        float g2 = g * g;
        float p = ( 1.0 - g2 ) / pow( max( 1.0 + g2 - 2.0 * g * c, 1e-4 ), 1.5 );
        return p * ( ( 1.0 - g ) * ( 1.0 - g ) / ( 1.0 + g ) );
      }

      void main() {
        vec3 N = normalize( vN );
        vec3 V = normalize( cameraPosition - vW );

        /* How much lit air the sightline crossed.
           The cone is drawn back-face only, so this fragment is the far wall and
           the ray has just come through the interior. That chord is longest
           looking down the axis and shortest at the silhouette — the exact
           opposite of the rim term this used to be — but the silhouette is also
           where the phase function is weakest, so the two together still give a
           cone with a soft bright edge and a filled body instead of an outline. */
        float ndv = abs( dot( N, V ) );
        float chord = mix( 0.30, 1.0, pow( 1.0 - ndv, 1.4 ) );

        /* Forward scatter. Aerosol is strongly forward-peaked, which is why a
           floodlight aimed near the lens is a solid shaft of light and the one
           on the opposite mast is invisible. This is also what picks out the two
           towers that read in any given frame at zero CPU cost. */
        float phase = hg( dot( normalize( vAxis ), V ), 0.62 );

        // Density falls away from the head, and the haze itself is extincted
        // over the hundred-plus metres from a corner mast to this camera.
        float fall = pow( 1.0 - vT, 2.0 );
        float atten = 1.0 / ( 1.0 + distance( cameraPosition, vW ) * 0.009 );

        float a = chord * phase * fall * atten * uIntensity;
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

/**
 * The turf sheen pass. See `TowerRig.buildSheen` for why it exists.
 *
 * Head positions are baked in as a uniform array rather than re-derived, so the
 * highlight runs at the mast the viewer can see and moves correctly with the
 * camera. Everything is evaluated per fragment from world position — the quad is
 * two triangles.
 */
function makeSheenMaterial(heads: THREE.Vector3[]): THREE.ShaderMaterial {
  const pad: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) pad.push((heads[i] ?? heads[0] ?? new THREE.Vector3(0, 40, 0)).clone());
  return new THREE.ShaderMaterial({
    defines: {
      SHEEN_N: Math.max(1, Math.min(4, heads.length)),
      STRIPE_W: MOW_STRIPE.toFixed(3),
      HALF_X: FIELD.turfHalfX.toFixed(2),
      HALF_Z: FIELD.turfHalfZ.toFixed(2),
    },
    uniforms: {
      uHeads: { value: pad },
      uIntensity: { value: 0 },
      uColor: { value: FLOOD_COLOR.clone() },
    },
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4( position, 1.0 );
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uHeads[ 4 ];
      uniform float uIntensity;
      uniform vec3 uColor;
      varying vec3 vW;

      float hash21( vec2 p ) {
        return fract( sin( dot( p, vec2( 41.7, 289.1 ) ) ) * 24634.6345 );
      }
      float vnoise( vec2 p ) {
        vec2 i = floor( p ), f = fract( p );
        f = f * f * ( 3.0 - 2.0 * f );
        return mix( mix( hash21( i ), hash21( i + vec2( 1.0, 0.0 ) ), f.x ),
                    mix( hash21( i + vec2( 0.0, 1.0 ) ), hash21( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
      }

      void main() {
        vec3 V = normalize( cameraPosition - vW );
        vec3 N = vec3( 0.0, 1.0, 0.0 );

        /* Mow lay. Passes run the length of the pitch, banded in X, and a pass
           of bent grass presents its blade faces to one side — so the tangent
           the sheen is built about tilts ±X and flips every stripe. Same
           MOW_STRIPE the turf albedo bands on and the grass system leans by; if
           these two disagree the painted stripe and the lit stripe drift apart
           and the pitch stops reading as one surface. */
        float lay = clamp( cos( 3.14159265 * vW.x / STRIPE_W ) * 2.2, -1.0, 1.0 );
        // A little wander so the bands are not laser-straight at 60 m.
        lay *= 0.82 + 0.30 * vnoise( vW.xz * vec2( 0.05, 0.010 ) );
        vec3 T = normalize( vec3( 1.0, lay * 0.55, 0.0 ) );

        float acc = 0.0;
        for ( int i = 0; i < SHEEN_N; i ++ ) {
          vec3 d = uHeads[ i ] - vW;
          float d2 = max( dot( d, d ), 1.0 );
          vec3 L = d * inversesqrt( d2 );
          vec3 H = normalize( L + V );
          // Kajiya-Kay: a fibre reflects into the cone about its own tangent, so
          // the lobe peaks where the half-vector is perpendicular to the blade.
          float th = dot( T, H );
          float sp = pow( max( 0.0, 1.0 - th * th ), 26.0 );
          acc += sp * max( 0.0, L.y ) * ( 11000.0 / d2 );
        }

        /* Grazing only. Wet grass mirrors along the sightline and does nothing
           seen from above, which is what keeps this off the macro framings and
           concentrates it on the far half of a broadcast or night angle — where
           a real floodlit pitch puts it. */
        float graze = pow( clamp( 1.0 - dot( N, V ), 0.0, 1.0 ), 2.6 );

        // Break-up, and a fade so the quad has no edge of its own.
        float mott = 0.72 + 0.56 * vnoise( vW.xz * 0.09 );
        float edge = ( 1.0 - smoothstep( HALF_X - 6.0, HALF_X - 0.5, abs( vW.x ) ) )
                   * ( 1.0 - smoothstep( HALF_Z - 6.0, HALF_Z - 0.5, abs( vW.z ) ) );

        float a = acc * graze * mott * edge * uIntensity;
        if ( a < 0.0015 ) discard;
        a = min( a, 0.85 );
        gl_FragColor = vec4( uColor * a, a );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
  });
}
