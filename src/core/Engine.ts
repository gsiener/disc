import * as THREE from 'three';
import { Ctx, System, QUALITY_PRESETS, QualityTier, EventBus, Rng } from './Ctx';

/**
 * Owns the WebGL context, the frame loop, and the system registry.
 *
 * Frame order:
 *   1. update()     — simulation, in `order` ascending
 *   2. lateUpdate() — camera, IK, anything reading final sim state
 *   3. render       — composer if present, else direct
 *
 * Simulation runs on a fixed 1/120 s accumulator so physics is frame-rate
 * independent and byte-identical between a 60 Hz display and the capture rig.
 */
export class Engine {
  readonly ctx: Ctx;
  private systems: System[] = [];
  private accumulator = 0;
  private readonly fixedStep = 1 / 120;
  private lastTime = 0;
  private running = false;
  private rafId = 0;
  private perfSamples: number[] = [];

  constructor(container: HTMLElement, opts: { tier?: QualityTier; capture?: boolean; debug?: boolean; seed?: number } = {}) {
    const capture = opts.capture ?? false;

    const renderer = new THREE.WebGLRenderer({
      antialias: false,          // SMAA/TAA handle AA in post at higher quality
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: capture,
      failIfMajorPerformanceCaveat: false,
    });

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.AgXToneMapping;   // filmic, modern; matches AAA grade
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap; // r185 deprecated PCFSoft; CSM does its own filtering
    renderer.shadowMap.autoUpdate = true;
    renderer.info.autoReset = false;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.15, 900);
    camera.position.set(0, 12, 42);

    const tier = opts.tier ?? 'ultra';
    const quality = { ...QUALITY_PRESETS[tier] };

    this.ctx = {
      renderer, scene, camera, composer: null,
      time: 0, dt: 0, rawDt: 0, timeScale: 1, frame: 0,
      width: 1, height: 1, dpr: 1,
      quality,
      events: new EventBus(),
      rand: new Rng(opts.seed ?? 20260729),
      sys: Object.create(null),
      debug: opts.debug ?? false,
      capture,
    };

    this.resize();
    window.addEventListener('resize', this.resize, { passive: true });
  }

  add(system: System): this {
    this.systems.push(system);
    this.ctx.sys[system.name] = system;
    return this;
  }

  get<T extends System = System>(name: string): T {
    const s = this.ctx.sys[name] as T | undefined;
    if (!s) throw new Error(`Engine: system "${name}" not registered`);
    return s;
  }

  /** Initializes every system in `order`, reporting progress 0..1. */
  async init(onProgress?: (t: number, label: string) => void): Promise<void> {
    this.systems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (let i = 0; i < this.systems.length; i++) {
      const s = this.systems[i];
      onProgress?.(i / this.systems.length, s.name);
      await s.init(this.ctx);
      // Yield so the boot UI can paint between heavy procedural bakes.
      await new Promise((r) => requestAnimationFrame(r));
    }
    onProgress?.(1, 'ready');
    this.resize();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const tick = (now: number) => {
      this.rafId = requestAnimationFrame(tick);
      this.step((now - this.lastTime) / 1000);
      this.lastTime = now;
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Advances exactly `dtSeconds`. Used by the loop and by the capture rig. */
  step(dtSeconds: number): void {
    const ctx = this.ctx;
    const raw = Math.min(Math.max(dtSeconds, 0), 0.1); // clamp tab-away spikes
    ctx.rawDt = raw;
    const scaled = raw * ctx.timeScale;
    ctx.dt = scaled;
    ctx.time += scaled;
    ctx.frame++;

    this.accumulator += scaled;
    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < 8) {
      for (const s of this.systems) s.update?.(this.fixedStep, ctx);
      this.accumulator -= this.fixedStep;
      steps++;
    }
    if (steps === 8) this.accumulator = 0; // give up on a huge backlog

    for (const s of this.systems) s.lateUpdate?.(scaled, ctx);

    this.render();

    if (!ctx.capture) this.adaptQuality(raw);
  }

  render(): void {
    const { renderer, scene, camera, composer } = this.ctx;
    renderer.info.reset();
    if (composer) composer.render(this.ctx.dt);
    else renderer.render(scene, camera);
  }

  /** Nudges DPR to hold ~60fps. Disabled in capture for determinism. */
  private adaptQuality(raw: number): void {
    this.perfSamples.push(raw);
    if (this.perfSamples.length < 90) return;
    const sorted = this.perfSamples.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.perfSamples.length = 0;
    const q = this.ctx.quality;
    if (median > 1 / 50 && this.ctx.dpr > 1) {
      this.setDpr(Math.max(1, this.ctx.dpr - 0.25));
    } else if (median < 1 / 75 && this.ctx.dpr < q.maxDpr) {
      this.setDpr(Math.min(q.maxDpr, this.ctx.dpr + 0.25));
    }
  }

  private setDpr(dpr: number): void {
    if (Math.abs(dpr - this.ctx.dpr) < 1e-3) return;
    this.ctx.dpr = dpr;
    this.ctx.renderer.setPixelRatio(dpr);
    this.resize();
  }

  resize = (): void => {
    const ctx = this.ctx;
    const w = window.innerWidth || 1920;
    const h = window.innerHeight || 1080;
    ctx.width = w; ctx.height = h;
    if (ctx.dpr === 1 && !ctx.capture) {
      ctx.dpr = Math.min(window.devicePixelRatio || 1, ctx.quality.maxDpr);
    } else if (ctx.capture) {
      ctx.dpr = Math.min(window.devicePixelRatio || 1, ctx.quality.maxDpr);
    }
    ctx.renderer.setPixelRatio(ctx.dpr);
    ctx.renderer.setSize(w, h, false);
    ctx.camera.aspect = w / h;
    ctx.camera.updateProjectionMatrix();
    ctx.composer?.setSize(w, h);
    for (const s of this.systems) s.resize?.(w, h, ctx);
  };

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.resize);
    for (const s of this.systems) s.dispose?.();
    this.ctx.renderer.dispose();
  }
}
