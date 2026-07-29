import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';
import { linearColor } from '../util/Tex';
import { bakeTurfMap, bakeNoiseMap } from './grass/maps';
import { bladeGeometry } from './grass/blade';
import { planRings, buildCells, type RingSpec } from './grass/scatter';
import {
  GRASS_COMMON, GRASS_VERT_DECL, GRASS_VERT_BODY, GRASS_FRAG_DECL, GRASS_FRAG_LIGHT,
} from './grass/shader';

/**
 * GPU instanced grass.
 *
 * Three camera-centred LOD rings, each one plain `Mesh` over an
 * `InstancedBufferGeometry` (not `InstancedMesh` — we never want the 64-byte
 * per-instance matrix; the only instance attribute is a 4-byte cell index).
 * Placement, height, hue, lean, bend, wind and LOD fade all happen in the vertex
 * shader from a hash of the blade's *world* cell, so the tile can slide under
 * the camera without a single blade appearing to move, and the CPU touches
 * nothing per frame except a handful of uniforms.
 *
 * Lighting is MeshStandardMaterial's, plus three additions that are what
 * actually sell grass: wrapped diffuse, forward scattering through the blade
 * (backlit grass glows) and a Kajiya-Kay sheen along the blade so the mow
 * stripes stay anisotropic.
 */

interface Ring {
  spec: RingSpec;
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  uni: Record<string, THREE.IUniform>;
}

interface Pusher { x: number; z: number; r: number; s: number; }

const BEND_N = 128;
const BEND_HALF = 32;
const GROUND_Y = -0.012;

export class GrassSystem implements System {
  readonly name = 'grass';
  readonly order = 3;

  /** Live wind, readable by peers (turf spray, cloth, audio). */
  readonly wind = { dirX: 0.82, dirZ: 0.57, strength: 0.42 };

  private rings: Ring[] = [];
  private turfMap!: THREE.DataTexture;
  private noiseMap!: THREE.DataTexture;

  private bendTex!: THREE.DataTexture;
  private bendData!: Uint8Array;
  private bendCentre = new THREE.Vector2();
  private pushers: Pusher[] = [];
  private bendDirty = false;

  private phase = new THREE.Vector2();
  private sunDirLocked = false;
  private lastSunScan = -1;

  // Shared uniform objects — one instance referenced by every ring's material,
  // so a single write updates all three.
  private readonly u = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(0.82, 0.57) },
    uWindStrength: { value: 0.42 },
    uWindPhase: { value: new THREE.Vector2() },
    uTurfOrigin: { value: new THREE.Vector2(-64, -80) },
    uTurfSize: { value: new THREE.Vector2(128, 160) },
    uTurfMap: { value: null as THREE.Texture | null },
    uNoiseMap: { value: null as THREE.Texture | null },
    uBendMap: { value: null as THREE.Texture | null },
    uBendRegion: { value: new THREE.Vector3(0, 0, BEND_HALF) },
    uPxScale: { value: 0.0006 },
    uStripeW: { value: 4.5 },
    uGroundY: { value: GROUND_Y },
    uBlade: { value: new THREE.Vector2(0.052, 0.0044) },
    uLean: { value: 0.46 },
    uCurl: { value: 0.55 },
    uColLush: { value: linearColor(0x2f7a26) },
    uColDry: { value: linearColor(0x7d8a33) },
    uColSoil: { value: linearColor(0x6a5638) },
    uColPaint: { value: linearColor(0xe6ead8) },
    uStripeTint: { value: 0.045 },
    uSunDir: { value: new THREE.Vector3(-0.51, 0.76, 0.38).normalize() },
    uSunCol: { value: new THREE.Color(1, 0.95, 0.88) },
    uSssTint: { value: new THREE.Color(0.55, 1.0, 0.28) },
    uSkyCol: { value: new THREE.Color(0.055, 0.075, 0.10) },
    uSssPower: { value: 4.2 },
    uSssScale: { value: 2.1 },
    uSssDistort: { value: 0.42 },
    uWrap: { value: 0.55 },
    uSheen: { value: 0.5 },
    uSheenExp: { value: 26.0 },
  };

  init(ctx: Ctx): void {
    const q = ctx.quality;
    const seed = Math.floor(ctx.rand.fork(0x6a55).next() * 1e6);

    const rx = 64, rz = 80;
    const mapSize = q.tier === 'low' ? 256 : q.tier === 'medium' ? 384 : 512;
    this.turfMap = bakeTurfMap({ size: mapSize, rx, rz, seed });
    this.noiseMap = bakeNoiseMap(256, seed + 1);
    this.turfMap.anisotropy = 1;

    this.u.uTurfOrigin.value.set(-rx, -rz);
    this.u.uTurfSize.value.set(rx * 2, rz * 2);
    this.u.uTurfMap.value = this.turfMap;
    this.u.uNoiseMap.value = this.noiseMap;

    /* ------------------------------------------------------------ bend map */
    this.bendData = new Uint8Array(BEND_N * BEND_N * 4).fill(128);
    this.bendTex = new THREE.DataTexture(this.bendData, BEND_N, BEND_N, THREE.RGBAFormat);
    this.bendTex.wrapS = this.bendTex.wrapT = THREE.ClampToEdgeWrapping;
    this.bendTex.minFilter = this.bendTex.magFilter = THREE.LinearFilter;
    this.bendTex.generateMipmaps = false;
    this.bendTex.needsUpdate = true;
    this.u.uBendMap.value = this.bendTex;

    /* --------------------------------------------------------------- rings */
    const specs = planRings(q.grassBlades, q.grassDistance);
    const group = new THREE.Group();
    group.name = 'grass';
    group.matrixAutoUpdate = false;

    for (const spec of specs) {
      const cells = buildCells(spec);
      const n = cells.length >> 1;
      if (n === 0) continue;

      const base = bladeGeometry(spec.segments);
      const geo = new THREE.InstancedBufferGeometry();
      geo.index = base.index;
      geo.setAttribute('position', base.getAttribute('position'));
      geo.setAttribute('normal', base.getAttribute('normal'));
      geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
      geo.instanceCount = n;
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), spec.outer + 2);

      const uni: Record<string, THREE.IUniform> = {
        ...this.u,
        uCellOrigin: { value: new THREE.Vector2() },
        uCellSize: { value: spec.cell },
        uRing: {
          value: new THREE.Vector4(
            spec.inner, spec.inner + spec.fadeIn,
            spec.outer - spec.fadeOut, spec.outer,
          ),
        },
        uWidthScale: { value: spec.widthScale },
      };

      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.5,
        metalness: 0.0,
        side: THREE.DoubleSide,
        dithering: true,
      });
      mat.name = `grass.ring${spec.segments}`;
      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uni);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${GRASS_COMMON}\n${GRASS_VERT_DECL}`)
          .replace('#include <beginnormal_vertex>', `${GRASS_VERT_BODY}\n  vec3 objectNormal = gNrm;`)
          .replace('#include <begin_vertex>', '  vec3 transformed = gPos;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${GRASS_COMMON}\n${GRASS_FRAG_DECL}`)
          .replace('#include <map_fragment>', '  diffuseColor.rgb *= vGrassCol * vGrassAux.z;')
          .replace('#include <roughnessmap_fragment>', '  float roughnessFactor = vGrassAux.y;')
          .replace('#include <opaque_fragment>', `${GRASS_FRAG_LIGHT}\n#include <opaque_fragment>`);
      };
      mat.customProgramCacheKey = () => 'grass-v1';

      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `grass.ring${specs.indexOf(spec)}`;
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.renderOrder = -1;
      group.add(mesh);

      this.rings.push({ spec, mesh, mat, uni });
    }

    ctx.scene.add(group);

    /* -------------------------------------------------------------- events */
    ctx.events.on('sun:changed', (p: any) => this.applySun(p));
    ctx.events.on('player:footstep', (p: any) => {
      const v = p?.pos;
      if (v) this.bendAt(v.x ?? v[0], v.z ?? v[2], 0.42, 1.0);
    });
    ctx.events.on('disc:grounded', (p: any) => {
      const v = p?.pos;
      if (v) this.bendAt(v.x ?? v[0], v.z ?? v[2], 0.5, 1.3);
    });
    ctx.events.on('shot:apply', (p: any) => {
      // Freeze the gust field per shot so a named shot is byte-reproducible.
      this.phase.set(0, 0);
      const h = p?.shot?.hour;
      if (typeof h === 'number') this.u.uWindStrength.value = 0.34 + 0.16 * Math.sin(h);
    });

    // Cheap coupling to a cascaded shadow setup if one exists.
    const csm = (ctx.sys['lighting'] as any)?.csm;
    if (csm?.setupMaterial) for (const r of this.rings) { try { csm.setupMaterial(r.mat); } catch { /* optional */ } }
  }

  /* ------------------------------------------------------------------- api */

  /**
   * Push grass aside at a world point. Call every frame for a sustained push;
   * a single call leaves a mark that relaxes over ~0.4 s.
   */
  bendAt(x: number, z: number, radius = 0.45, strength = 1): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (this.pushers.length >= 96) this.pushers.shift();
    this.pushers.push({ x, z, r: Math.max(0.08, radius), s: Math.max(0, strength) });
    this.bendDirty = true;
  }

  /* ---------------------------------------------------------------- update */

  lateUpdate(dt: number, ctx: Ctx): void {
    const u = this.u;
    u.uTime.value = ctx.time;

    // Slow directional drift so the gusts do not feel like a looping conveyor.
    const swing = Math.sin(ctx.time * 0.043) * 0.35 + Math.sin(ctx.time * 0.017) * 0.2;
    const ang = Math.atan2(this.wind.dirZ, this.wind.dirX) + swing;
    const wx = Math.cos(ang), wz = Math.sin(ang);
    u.uWindDir.value.set(wx, wz);
    u.uWindStrength.value = this.wind.strength * (0.82 + 0.32 * Math.sin(ctx.time * 0.29 + 1.2));

    this.phase.x += wx * dt * 3.4;
    this.phase.y += wz * dt * 3.4;
    u.uWindPhase.value.copy(this.phase);

    // Blade width floor is expressed in pixels, so it needs the projection.
    const px = 2 * Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov) * 0.5) / Math.max(1, ctx.height);
    u.uPxScale.value = px;

    const cam = ctx.camera.position;
    for (const r of this.rings) {
      const c = r.spec.cell;
      (r.uni.uCellOrigin.value as THREE.Vector2).set(Math.round(cam.x / c), Math.round(cam.z / c));
    }

    this.updateBend(dt, cam);
    if (!this.sunDirLocked && ctx.frame - this.lastSunScan > 12) this.scanSun(ctx);
  }

  private updateBend(dt: number, cam: THREE.Vector3): void {
    const texel = (BEND_HALF * 2) / BEND_N;
    this.bendCentre.set(Math.round(cam.x / texel) * texel, Math.round(cam.z / texel) * texel);
    this.u.uBendRegion.value.set(this.bendCentre.x, this.bendCentre.y, BEND_HALF);

    const k = Math.exp(-dt * 3.2);
    let alive = 0;
    for (const p of this.pushers) { p.s *= k; if (p.s > 0.02) this.pushers[alive++] = p; }
    this.pushers.length = alive;

    if (!alive) {
      if (this.bendDirty) { this.bendData.fill(128); this.bendTex.needsUpdate = true; this.bendDirty = false; }
      return;
    }
    this.bendDirty = true;
    this.bendData.fill(128);

    const inv = BEND_N / (BEND_HALF * 2);
    for (const p of this.pushers) {
      const lx = (p.x - this.bendCentre.x + BEND_HALF) * inv;
      const lz = (p.z - this.bendCentre.y + BEND_HALF) * inv;
      const rr = p.r * inv;
      const i0 = Math.max(0, Math.floor(lx - rr)), i1 = Math.min(BEND_N - 1, Math.ceil(lx + rr));
      const j0 = Math.max(0, Math.floor(lz - rr)), j1 = Math.min(BEND_N - 1, Math.ceil(lz + rr));
      for (let j = j0; j <= j1; j++) {
        const dz = j + 0.5 - lz;
        for (let i = i0; i <= i1; i++) {
          const dx = i + 0.5 - lx;
          const d = Math.hypot(dx, dz);
          if (d >= rr) continue;
          const w = p.s * (1 - d / rr) ** 1.4;
          const n = d > 1e-4 ? 1 / d : 0;
          const o = (j * BEND_N + i) * 4;
          const cx = (this.bendData[o] - 128) / 127 + dx * n * w;
          const cz = (this.bendData[o + 1] - 128) / 127 + dz * n * w;
          this.bendData[o] = Math.max(0, Math.min(255, 128 + cx * 127));
          this.bendData[o + 1] = Math.max(0, Math.min(255, 128 + cz * 127));
        }
      }
    }
    this.bendTex.needsUpdate = true;
  }

  /* ------------------------------------------------------------------- sun */

  private applySun(p: any): void {
    if (!p) return;
    const d = p.dir;
    const v = this.u.uSunDir.value as THREE.Vector3;
    if (d) {
      if (Array.isArray(d)) v.set(d[0], d[1], d[2]); else v.set(d.x, d.y, d.z);
      if (v.lengthSq() < 1e-8) return;
      v.normalize();
      if (v.y < 0) v.negate();          // accept either "to sun" or "light travel"
      this.sunDirLocked = true;
    }
    const c = this.u.uSunCol.value as THREE.Color;
    const inten = typeof p.intensity === 'number' ? p.intensity : 3.0;
    if (p.color !== undefined) c.set(p.color as any); else c.setRGB(1, 0.95, 0.88);
    c.multiplyScalar(inten / Math.PI);
    this.tintSss(c);
  }

  /** No sun events yet — take whatever directional light is in the scene. */
  private scanSun(ctx: Ctx): void {
    this.lastSunScan = ctx.frame;
    let best: THREE.DirectionalLight | null = null;
    for (const o of ctx.scene.children) {
      if ((o as THREE.DirectionalLight).isDirectionalLight) {
        const l = o as THREE.DirectionalLight;
        if (!best || l.intensity > best.intensity) best = l;
      }
    }
    if (!best) return;
    const v = this.u.uSunDir.value as THREE.Vector3;
    v.copy(best.position).sub(best.target.position);
    if (v.lengthSq() < 1e-8) return;
    v.normalize();
    if (v.y < 0) v.negate();
    const c = this.u.uSunCol.value as THREE.Color;
    c.copy(best.color).multiplyScalar(best.intensity / Math.PI);
    this.tintSss(c);
  }

  /** Scattered light leaves the blade green; keep the tint keyed to the sun. */
  private tintSss(sun: THREE.Color): void {
    const t = this.u.uSssTint.value as THREE.Color;
    const warm = Math.min(1, sun.r / Math.max(1e-4, sun.b));
    t.setRGB(0.34 + 0.28 * warm, 0.92, 0.20);
  }

  dispose(): void {
    for (const r of this.rings) { r.mesh.geometry.dispose(); r.mat.dispose(); }
    this.turfMap?.dispose();
    this.noiseMap?.dispose();
    this.bendTex?.dispose();
  }
}
