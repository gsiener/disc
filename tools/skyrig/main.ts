// Isolated harness for the sky system: Engine + SkySystem + material probes.
// Lets the sky be iterated on independently of systems that are mid-flight.
import * as THREE from 'three';
import { Engine } from '../../src/core/Engine';
import type { Ctx, System, QualityTier } from '../../src/core/Ctx';
import { SkySystem } from '../../src/render/Sky';
import { applyShot, SHOTS, type ShotName } from '../../src/capture/Shots';

class ProbeSystem implements System {
  readonly name = 'probe';
  readonly order = 5;
  private sun = new THREE.DirectionalLight(0xffffff, 3);
  init(ctx: Ctx): void {
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(3000, 3000, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x2b4218, roughness: 0.92, metalness: 0 }),
    );
    g.rotation.x = -Math.PI / 2;
    g.receiveShadow = true;
    ctx.scene.add(g);

    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(1.1, 48, 32),
        new THREE.MeshStandardMaterial({
          color: i === 5 ? 0xd8d8dc : 0xb9b4ac,
          roughness: i === 5 ? 0.22 : 0.06 + i * 0.19,
          metalness: i >= 4 ? 1 : 0,
        }),
      );
      m.position.set(-9 + i * 3.6, 1.2, 4);
      m.castShadow = true;
      ctx.scene.add(m);
    }
    // Distant "stands" to judge aerial perspective. Kept well outside every
    // shot camera so they never sit in front of the lens.
    for (let i = 0; i < 7; i++) {
      const d = 130 + i * 90;
      const w = new THREE.Mesh(
        new THREE.BoxGeometry(120, 14 + i * 4, 8),
        new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.8 }),
      );
      w.position.set(-40 + i * 22, 7 + i * 2, -d);
      ctx.scene.add(w);
    }
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera as THREE.OrthographicCamera;
    c.left = -30; c.right = 30; c.top = 30; c.bottom = -30; c.far = 400;
    ctx.scene.add(this.sun, this.sun.target);
    ctx.events.on('sun:changed', (p: { dir: THREE.Vector3; color: THREE.Color; intensity: number }) => {
      this.sun.position.copy(p.dir).multiplyScalar(140);
      this.sun.color.copy(p.color);
      this.sun.intensity = p.intensity;
    });
  }
}

const params = new URLSearchParams(location.search);
const tier = (params.get('q') as QualityTier) ?? 'ultra';
const engine = new Engine(document.getElementById('app')!, {
  tier, capture: params.get('capture') === '1', debug: false, seed: 20260729,
});
engine.add(new SkySystem());
engine.add(new ProbeSystem());
await engine.init();

const rig = {
  engine, ctx: engine.ctx,
  shots: Object.keys(SHOTS) as ShotName[],
  advance(frames: number, dt = 1 / 60) { for (let i = 0; i < frames; i++) engine.step(dt); },
  async shot(name: ShotName, settle = 90) { applyShot(name, engine.ctx); this.advance(settle); },
  /** Free camera + explicit hour, for looking at parts of the sky no shot frames. */
  look(hour: number, pos: number[], target: number[], fov = 50, settle = 60) {
    engine.ctx.events.emit('shot:apply', { name: 'dbg', shot: { hour } });
    const cam = engine.ctx.camera;
    cam.position.set(pos[0], pos[1], pos[2]);
    cam.lookAt(target[0], target[1], target[2]);
    cam.fov = fov; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    this.advance(settle);
  },
  info(hour: number) {
    const sky = engine.ctx.sys.sky as unknown as { state: any };
    engine.ctx.events.emit('shot:apply', { name: 'dbg', shot: { hour } });
    const s = sky.state;
    const f3 = (v: number) => +v.toFixed(3);
    return {
      hour, el: +s.sun.elevation.toFixed(2), night: +s.night.toFixed(3),
      sunDir: [s.sun.dir.x, s.sun.dir.y, s.sun.dir.z].map(f3),
      moonDir: [s.moonDir.x, s.moonDir.y, s.moonDir.z].map(f3),
      intensity: +s.sunIntensity.toFixed(2),
      sunColor: [s.sunColor.r, s.sunColor.g, s.sunColor.b].map(f3),
      sunRad: [s.sunRadiance.r, s.sunRadiance.g, s.sunRadiance.b].map(f3),
      zenith: [s.zenith.r, s.zenith.g, s.zenith.b].map(f3),
      horizon: [s.horizon.r, s.horizon.g, s.horizon.b].map(f3),
      sunGlow: [s.sunGlow.r, s.sunGlow.g, s.sunGlow.b].map(f3),
      ground: [s.ground.r, s.ground.g, s.ground.b].map(f3),
      tuning: s.tuning,
    };
  },
  render: () => engine.render(),
};
(window as any).__RIG__ = rig;
(window as any).__ENGINE__ = engine;
(window as any).__SHOTS__ = SHOTS;
applyShot('broadcast', engine.ctx);
rig.advance(30);
(window as any).__READY__ = true;
