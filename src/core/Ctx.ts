import * as THREE from 'three';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { Rng } from '../sim/Rng.ts';

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
  // Ultra is measured, not aspirational: ~30 ms/frame at 1920×1080 on an M1 Max
  // in the capture rig. Two numbers were dropped from the original sketch —
  // grassBlades 1.4 M → 1.0 M (the ground-level turf camera puts a metre of
  // blades between the lens and the pitch, and that is pure overdraw), and
  // maxDpr 2 → 1.5, because 2× on a retina panel quadruples every full-screen
  // pass and takes the same frame past 150 ms. Both still sit clearly above high.
  ultra: {
    tier: 'ultra', shadowMapSize: 4096, shadowCascades: 4, grassBlades: 1_000_000, grassDistance: 110,
    crowdCount: 14_000, ssao: true, bloom: true, motionBlur: true, dof: true, ssr: true, taa: true,
    charDetail: 1.35, maxDpr: 1.5, anisotropy: 16,
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

/**
 * xorshift128 — small, fast, deterministic across runs and machines.
 *
 * The class lives in `src/sim/Rng.ts` and is re-exported here, so the twenty-odd
 * client systems that `import { Rng } from '../core/Ctx.ts'` keep working. It was
 * declared here as well until #42: two character-identical copies of the stream
 * every golden in the repository pins, plus a third in `Playbook.ts` whose comment
 * said it existed to avoid importing *this* file. A one-constant drift between them
 * would have invalidated every fixture at once and read as a physics bug.
 *
 * The direction is deliberate. ADR-0008 makes the Three.js client a consumer of the
 * reference model and never its owner, so the client imports the reference's
 * generator — not the other way round, which is what `src/sim/Rng.ts` importing
 * nothing at all is there to guarantee.
 */
export { Rng } from '../sim/Rng.ts';
