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
    // The venue dresses its own touchline (benches, canopies, coolers, kit
    // bags, camera crews) on the same 5 m run-off strip. Two sets of team
    // benches two metres apart reads worse than none, so ours is a fallback
    // for when the field is standing on its own.
    this.root.add(buildSurrounds({
      turf: this.turfMaps, apron: this.apronMaps,
      terrain: this.terrain, rand: ctx.rand, anisotropy: aniso,
      dressSideline: !ctx.sys.stadium,
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

  /**
   * Traffic from the plays that "just happened".
   *
   * ## Why these are not the marks they used to be
   *
   * Round 2 read the pitch as carrying "salmon-pink streaks … scratches rather
   * than turf wear", and this method drew them. Five layout skids of 0.55
   * strength through a 42 × 20 cm ellipse, plus 130 randomly-oriented 30 × 15 cm
   * stamps, produce exactly that: short, narrow, high-contrast marks pointing
   * in every direction at once. Real wear on a grass pitch is *anisotropic and
   * low-frequency* — it follows the lanes people run, it is broad, and it is a
   * thinning rather than a scar.
   *
   * So: every mark is now at least twice as wide, well under half as strong,
   * and oriented along a plausible line of play rather than uniformly on the
   * circle. Cutters run up and down the field, so the trails are drawn as
   * *runs* — a swept stroke with a heading biased to ±Z — and layout skids only
   * happen where receivers actually lay out, which is at the front of an
   * endzone, not scattered around the centre circle of a sport that has no
   * centre circle.
   */
  private seedPlayMarks(ctx: Ctx): void {
    const r = ctx.rand.fork(0x1a7017);

    /** One swept run: a chain of overlapping soft stamps along a heading. */
    const run = (
      x0: number, z0: number, ang: number, len: number, strength: number,
      major: number, minor: number, mud = 0,
    ) => {
      const dx = Math.sin(ang), dz = Math.cos(ang);
      const steps = Math.max(4, Math.round(len / (minor * 0.9)));
      for (let s = 0; s < steps; s++) {
        const t = s / (steps - 1);
        // taper both ends so a trail has no chisel tip
        const w = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) ** 0.4;
        this.wear.stamp(x0 + dx * len * t, z0 + dz * len * t, dx, dz,
          strength * w, major, minor, mud * w);
      }
    };

    // Cutting lanes: long, soft, up-and-down the field, crowded toward the
    // middle third where the disc actually moves.
    for (let i = 0; i < 46; i++) {
      const x = r.gauss() * 8.0;
      const z = r.gauss() * 20.0;
      // ±18° off the field's long axis, either direction
      const ang = (r.next() < 0.5 ? 0 : Math.PI) + r.gauss() * 0.32;
      run(x, z, ang, r.range(4.0, 11.0), r.range(0.055, 0.12), 0.95, 0.62);
    }
    // A few lateral swing lanes — handlers reset across the pitch.
    for (let i = 0; i < 10; i++) {
      const x = r.range(-12, 12), z = r.gauss() * 24;
      const ang = Math.PI / 2 + r.gauss() * 0.28 + (r.next() < 0.5 ? 0 : Math.PI);
      run(x, z, ang, r.range(3.0, 7.0), r.range(0.045, 0.09), 0.85, 0.55);
    }
    // Layout skids: at the front of each endzone, where receivers extend, and
    // along the line of play rather than across it.
    for (const gz of [FIELD.goalLine, -FIELD.goalLine]) {
      for (let i = 0; i < 4; i++) {
        const x = r.gauss() * 7;
        const z = gz - Math.sign(gz) * r.range(0.5, 5.0);
        const ang = (gz > 0 ? 0 : Math.PI) + r.gauss() * 0.30;
        run(x, z, ang, r.range(1.8, 3.4), r.range(0.14, 0.22), 0.72, 0.40, 0.22);
      }
    }
    // Pivot wear on the goal lines: broad and shallow, and it no longer eats
    // the paint (see WearMap.stamp — the cut channel is gated to the collar).
    for (const gz of [FIELD.goalLine, -FIELD.goalLine]) {
      for (let i = 0; i < 26; i++) {
        const x = r.range(-FIELD.halfWidth, FIELD.halfWidth);
        const z = gz + r.gauss() * 1.5;
        this.wear.stamp(x, z, r.range(-1, 1), r.range(-1, 1), r.range(0.07, 0.16), 0.72, 0.46, 0.25);
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
