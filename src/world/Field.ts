import * as THREE from 'three';
import type { Ctx, System, QualityTier } from '../core/Ctx';
import { FIELD, Terrain } from './field/Layout';
import { WearMap } from './field/WearMap';
import { bakeTurf, bakeApron, DETAIL_TILE, type MapSet } from './field/TurfTextures';
import { makeTurfMaterial, type TurfUniforms } from './field/TurfMaterial';
import { buildSurrounds } from './field/Surrounds';

/**
 * ============================================================================
 *  FieldSystem — the pitch surface.
 * ============================================================================
 *
 * Registered as `ctx.sys.field`. Public API for other systems (grass, players,
 * disc, VFX). All coordinates are world metres, origin at field centre, long
 * axis along Z, +Y up.
 *
 *   heightAt(x, z): number
 *     Ground height for foot planting / prop placement. Cheap (two grid
 *     lookups) — safe to call per blade of grass or per frame per character.
 *
 *   normalAt(x, z, out?): THREE.Vector3
 *     Unit surface normal for foot and prop alignment. Pass `out` to avoid an
 *     allocation.
 *
 *   addScuff(x, z, dir, strength): void
 *     Accumulate wear at a point. `dir` is the direction of travel — a heading
 *     in radians (0 = +X), or anything with `.x`/`.z`, or null for a round
 *     stamp. `strength` ~0.15 for a jog step, ~1 for a full layout skid. Writes
 *     into the wear map the turf material samples, so the pitch degrades
 *     exactly where play happened. Fired automatically from `player:footstep`
 *     and `disc:grounded`.
 *
 *   wearAt(x, z): number         0 = pristine sward, 1 = bare soil
 *   isInBounds(x, z): boolean    inside the 100 × 37 playing field
 *   inEndzone(x, z): -1 | 0 | 1  which endzone a point is in
 *   bounds                       the FIELD constant block
 *
 * Events consumed: `player:footstep`, `disc:grounded`, `sun:changed`.
 * Events emitted: `field:ready` with `{ field }` once the surface exists.
 */
export class FieldSystem implements System {
  readonly name = 'field';
  readonly order = 2;

  readonly bounds = FIELD;

  private terrain!: Terrain;
  private wear!: WearMap;
  private turfMaps!: MapSet;
  private apronMaps!: MapSet;
  private turfMesh!: THREE.Mesh;
  private uniforms!: TurfUniforms;
  private root!: THREE.Group;
  private disposables: { dispose(): void }[] = [];
  private _n = new THREE.Vector3();

  /* ------------------------------------------------------------------ init */

  init(ctx: Ctx): void {
    const tier = ctx.quality.tier;
    const aniso = ctx.quality.anisotropy;

    this.root = new THREE.Group();
    this.root.name = 'field';
    ctx.scene.add(this.root);

    this.terrain = new Terrain(0);

    const wearRes = WEAR_RES[tier];
    this.wear = new WearMap(wearRes[0], wearRes[1]);
    this.wear.seed(ctx.rand);
    this.seedPlayMarks(ctx);

    this.turfMaps = bakeTurf(TEX_SIZE[tier], aniso);
    this.apronMaps = bakeApron(Math.min(512, TEX_SIZE[tier]), aniso);

    /* ---- the pitch itself ---- */
    const [sx, sz] = MESH_SEGS[tier];
    const geo = new THREE.PlaneGeometry(FIELD.turfHalfX * 2, FIELD.turfHalfZ * 2, sx, sz);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.terrain.heightAt(pos.getX(i), pos.getZ(i)));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const { material, uniforms } = makeTurfMaterial({
      maps: this.turfMaps, wear: this.wear, anisotropy: aniso,
    });
    this.uniforms = uniforms;
    // How much relief the normal map may carry is bounded by how well it can be
    // filtered: `low` gets 4 anisotropic taps against a 512² set, so the same
    // tilt that reads as grain at `high` reads as shimmer here. (This used to
    // push the scale *up* to 0.9 at low, which is the wrong direction — the
    // grazing turf camera is exactly where the fewest taps are available.)
    if (tier === 'low' || tier === 'medium') uniforms.uNormalScale.value *= 0.8;

    this.turfMesh = new THREE.Mesh(geo, material);
    this.turfMesh.name = 'field.turf';
    this.turfMesh.receiveShadow = true;
    this.turfMesh.castShadow = false;
    this.turfMesh.matrixAutoUpdate = false;
    this.turfMesh.updateMatrix();
    this.root.add(this.turfMesh);

    /* ---- runoff, apron, cones, sideline furniture ---- */
    this.root.add(buildSurrounds({
      turf: this.turfMaps, apron: this.apronMaps,
      terrain: this.terrain, rand: ctx.rand, anisotropy: aniso,
    }));

    this.disposables.push(geo, material, this.wear,
      this.turfMaps.albedo, this.turfMaps.normal, this.turfMaps.data,
      this.apronMaps.albedo, this.apronMaps.normal, this.apronMaps.data);

    /* ---- wiring ---- */
    ctx.events.on('player:footstep', (p: any) => {
      if (!p) return;
      const pos = p.pos ?? p.position;
      if (!pos) return;
      const x = pos.x ?? pos[0] ?? 0;
      const z = pos.z ?? pos[2] ?? 0;
      const speed = p.speed ?? 3;
      const dir = p.dir ?? p.heading ?? p.vel ?? p.velocity ?? null;
      this.addScuff(x, z, dir, Math.min(0.5, 0.035 + speed * 0.022));
    });

    ctx.events.on('disc:grounded', (p: any) => {
      const pos = p?.pos ?? p?.position;
      if (!pos) return;
      this.addScuff(pos.x ?? 0, pos.z ?? 0, null, 0.10);
    });

    ctx.events.on('sun:changed', (p: any) => this.applySun(p));

    ctx.events.emit('field:ready', { field: this });
  }

  /** Skid marks and cleat scars from the plays that "just happened". */
  private seedPlayMarks(ctx: Ctx): void {
    const r = ctx.rand.fork(0x1a7017);
    // layout skids near the centre (where the layout/turf shots look)
    for (let i = 0; i < 5; i++) {
      const x = r.range(-6, 6), z = r.range(-8, 8);
      const a = r.range(0, Math.PI * 2);
      const dx = Math.cos(a), dz = Math.sin(a);
      const len = r.range(1.4, 3.0);
      const steps = 14;
      for (let s = 0; s < steps; s++) {
        const t = s / (steps - 1);
        this.wear.stamp(x + dx * len * t, z + dz * len * t, dx, dz,
          0.55 * (1 - t * 0.55), 0.42, 0.20, 0.5);
      }
    }
    // cleat trails criss-crossing the middle of the pitch
    for (let i = 0; i < 130; i++) {
      const x = r.gauss() * 9, z = r.gauss() * 22;
      const a = r.range(0, Math.PI * 2);
      this.wear.stamp(x, z, Math.cos(a), Math.sin(a), r.range(0.10, 0.30), 0.30, 0.15);
    }
    // pivot scars on the goal lines
    for (const gz of [FIELD.goalLine, -FIELD.goalLine]) {
      for (let i = 0; i < 40; i++) {
        const x = r.range(-FIELD.halfWidth, FIELD.halfWidth);
        const z = gz + r.gauss() * 1.1;
        this.wear.stamp(x, z, r.range(-1, 1), r.range(-1, 1), r.range(0.15, 0.45), 0.35, 0.18, 0.7);
      }
    }
    this.wear.tex.needsUpdate = true;
  }

  private applySun(p: any): void {
    if (!p) return;
    const d = p.dir;
    if (d && typeof d.x === 'number') {
      const v = this.uniforms.uSunDir.value as THREE.Vector3;
      v.set(d.x, d.y, d.z).normalize();
      if (v.y < 0) v.multiplyScalar(-1);   // we want "toward the sun"
    }
    const c = p.color;
    if (c && typeof c.r === 'number') {
      const t = this.uniforms.uSunTint.value as THREE.Vector3;
      const i = Math.min(2.5, p.intensity ?? 1);
      t.set(c.r, c.g, c.b).multiplyScalar(0.55 + 0.25 * i);
    }
  }

  /* ---------------------------------------------------------------- update */

  update(_dt: number, ctx: Ctx): void {
    this.wear.flush(ctx.frame);
  }

  /* ------------------------------------------------------------------- API */

  /** Ground height in metres at a world XZ. */
  heightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  /** Unit ground normal at a world XZ. Pass `out` to avoid allocating. */
  normalAt(x: number, z: number, out?: THREE.Vector3): THREE.Vector3 {
    return this.terrain.normalAt(x, z, out ?? this._n.clone());
  }

  /**
   * Accumulate wear. `dir` may be a heading in radians, a vector-ish
   * `{x, z}`/`{x, y, z}`, or null/undefined for an isotropic stamp.
   */
  addScuff(x: number, z: number, dir: number | { x: number; z?: number; y?: number } | null | undefined, strength: number): void {
    let dx = 0, dz = 0;
    if (typeof dir === 'number') { dx = Math.cos(dir); dz = Math.sin(dir); }
    else if (dir && typeof dir.x === 'number') { dx = dir.x; dz = dir.z ?? dir.y ?? 0; }
    const s = Math.max(0, Math.min(1.5, strength));
    const major = 0.24 + s * 0.42;
    this.wear.stamp(x, z, dx, dz, s * 0.55, major, 0.13 + s * 0.10, s * 0.35);
  }

  /** Current wear, 0 = pristine sward, 1 = bare soil. */
  wearAt(x: number, z: number): number { return this.wear.sample(x, z, 0); }

  /** Inside the 100 × 37 playing field (endzones included). */
  isInBounds(x: number, z: number): boolean {
    return Math.abs(x) <= FIELD.halfWidth && Math.abs(z) <= FIELD.halfLength;
  }

  /** -1 for the -Z endzone, +1 for the +Z endzone, 0 for the central zone. */
  inEndzone(x: number, z: number): -1 | 0 | 1 {
    if (!this.isInBounds(x, z)) return 0;
    if (z > FIELD.goalLine) return 1;
    if (z < -FIELD.goalLine) return -1;
    return 0;
  }

  /** The live wear texture, if a peer wants to sample it on the GPU. */
  get wearTexture(): THREE.Texture { return this.wear.tex; }
  /** Metres covered by one repeat of the baked turf detail set. */
  get detailTile(): number { return DETAIL_TILE; }
  /** The baked turf maps — grass blades can tint themselves to match. */
  get turfTextures(): MapSet { return this.turfMaps; }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

/* ----------------------------------------------------------------- budgets */

const TEX_SIZE: Record<QualityTier, number> = {
  low: 512, medium: 1024, high: 1024, ultra: 1024,
};
const MESH_SEGS: Record<QualityTier, [number, number]> = {
  low: [48, 88], medium: [88, 160], high: [132, 252], ultra: [176, 336],
};
const WEAR_RES: Record<QualityTier, [number, number]> = {
  low: [192, 352], medium: [288, 528], high: [384, 704], ultra: [384, 704],
};
