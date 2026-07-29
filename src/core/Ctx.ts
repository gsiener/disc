import * as THREE from 'three';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';

/**
 * Shared engine context. Every subsystem receives this and may read anything on
 * it, but must only WRITE to fields it owns (see `owner` comments). Subsystems
 * publish themselves into `sys` so peers can find them by name without importing
 * each other — this keeps modules independently authorable and swappable.
 */
export interface Ctx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** The camera actually used for the final render. Owned by CameraDirector. */
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer | null;

  /** Seconds since engine start, scaled by timeScale. */
  time: number;
  /** Last frame delta, clamped, scaled by timeScale. */
  dt: number;
  /** Unscaled wall-clock delta. */
  rawDt: number;
  /** Global slow-motion / pause multiplier. Owned by Director + Replay. */
  timeScale: number;
  frame: number;

  width: number;
  height: number;
  dpr: number;

  quality: QualitySettings;
  events: EventBus;
  /** Deterministic RNG — never use Math.random in gameplay or visuals. */
  rand: Rng;

  sys: Record<string, System>;
  /** Set by ?debug=1. Systems may draw gizmos when true. */
  debug: boolean;
  /** Capture mode: deterministic, no adaptive quality, no vsync-dependent logic. */
  capture: boolean;
}

export interface System {
  readonly name: string;
  /** Build meshes/materials. May be async (procedural texture bake, etc). */
  init(ctx: Ctx): Promise<void> | void;
  /** Gameplay + simulation step. */
  update?(dt: number, ctx: Ctx): void;
  /** Runs after all update()s — camera, IK pinning, anything that must observe
   *  the final simulated state of the frame. */
  lateUpdate?(dt: number, ctx: Ctx): void;
  resize?(w: number, h: number, ctx: Ctx): void;
  dispose?(): void;
  /** Lower runs first. Default 0. */
  order?: number;
}

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  tier: QualityTier;
  shadowMapSize: number;
  shadowCascades: number;
  /** Grass blade instance budget. */
  grassBlades: number;
  grassDistance: number;
  crowdCount: number;
  /** Post-process toggles. */
  ssao: boolean;
  bloom: boolean;
  motionBlur: boolean;
  dof: boolean;
  ssr: boolean;
  taa: boolean;
  /** Character skinning subdivision / mesh density multiplier. */
  charDetail: number;
  maxDpr: number;
  anisotropy: number;
}

export const QUALITY_PRESETS: Record<QualityTier, QualitySettings> = {
  low: {
    tier: 'low', shadowMapSize: 1024, shadowCascades: 2, grassBlades: 60_000, grassDistance: 26,
    crowdCount: 900, ssao: false, bloom: true, motionBlur: false, dof: false, ssr: false, taa: false,
    charDetail: 0.5, maxDpr: 1, anisotropy: 4,
  },
  medium: {
    tier: 'medium', shadowMapSize: 2048, shadowCascades: 3, grassBlades: 220_000, grassDistance: 45,
    crowdCount: 3_000, ssao: true, bloom: true, motionBlur: false, dof: false, ssr: false, taa: false,
    charDetail: 0.75, maxDpr: 1.25, anisotropy: 8,
  },
  high: {
    tier: 'high', shadowMapSize: 2048, shadowCascades: 4, grassBlades: 600_000, grassDistance: 70,
    crowdCount: 8_000, ssao: true, bloom: true, motionBlur: true, dof: true, ssr: false, taa: true,
    charDetail: 1, maxDpr: 1.5, anisotropy: 16,
  },
  ultra: {
    tier: 'ultra', shadowMapSize: 4096, shadowCascades: 4, grassBlades: 1_400_000, grassDistance: 110,
    crowdCount: 18_000, ssao: true, bloom: true, motionBlur: true, dof: true, ssr: true, taa: true,
    charDetail: 1.35, maxDpr: 2, anisotropy: 16,
  },
};

/* ------------------------------------------------------------------ events */

type Handler = (payload: any) => void;

export class EventBus {
  private map = new Map<string, Set<Handler>>();
  on(evt: string, fn: Handler): () => void {
    let s = this.map.get(evt);
    if (!s) this.map.set(evt, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }
  emit(evt: string, payload?: any): void {
    const s = this.map.get(evt);
    if (!s) return;
    for (const fn of s) fn(payload);
  }
}

/* --------------------------------------------------------------------- rng */

/** xorshift128 — small, fast, deterministic across runs and machines. */
export class Rng {
  private a: number; private b: number; private c: number; private d: number;
  constructor(seed = 0x9e3779b9) {
    this.a = seed >>> 0; this.b = (seed ^ 0x85ebca6b) >>> 0;
    this.c = (seed ^ 0xc2b2ae35) >>> 0; this.d = (seed ^ 0x27d4eb2f) >>> 0;
    for (let i = 0; i < 16; i++) this.next();
  }
  next(): number {
    let t = this.d;
    const s = this.a;
    this.d = this.c; this.c = this.b; this.b = s;
    t ^= t << 11; t ^= t >>> 8;
    this.a = (t ^ s ^ (s >>> 19)) >>> 0;
    return this.a / 4294967296;
  }
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  int(lo: number, hi: number): number { return Math.floor(this.range(lo, hi + 1)); }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  /** Box-Muller, mean 0 sigma 1. */
  gauss(): number {
    const u = Math.max(1e-7, this.next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  fork(salt: number): Rng { return new Rng((this.a ^ (salt * 0x9e3779b9)) >>> 0); }
}
