import * as THREE from 'three';
import type { Ctx } from '../core/Ctx.ts';
import { SHOTS, type ShotName } from '../capture/Shots.ts';

/**
 * The renderer explorer — orbit, free-fly, and hotkeys onto the named framings
 * in `capture/Shots.ts`.
 *
 * This was the whole of `Director.ts` before there was a game to direct, and it
 * is still the most useful tool in the project for looking at the renderer: it
 * is how the same shots the visual critics review get walked around in a
 * browser. It now lives behind the backquote key while the broadcast director
 * owns the camera by default.
 */

const SHOT_ORDER: ShotName[] = [
  'broadcast', 'sideline', 'closeup', 'layout', 'disc',
  'stadium', 'turf', 'crowd', 'endzone', 'night',
];

const TMP = new THREE.Vector3();
const FWD = new THREE.Vector3();
const RIGHT = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Explorer {
  private ctx!: Ctx;
  private target = new THREE.Vector3(0, 1.6, 0);
  private yaw = 0;
  private pitch = 0.28;
  private dist = 46;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private keys = new Set<string>();
  private freeFly = false;
  private idle = 0;
  private autoOrbit = false;
  private active = false;

  /** Told by the director; used to keep the hint line honest. */
  onFlash: ((msg: string) => void) | null = null;

  attach(ctx: Ctx): void {
    this.ctx = ctx;
    this.bind();
  }

  /** Enabled/disabled by the director's debug hotkey. */
  setActive(on: boolean): void {
    this.active = on;
    if (!on) { this.keys.clear(); this.dragging = false; return; }
    // Adopt whatever the broadcast camera was doing, so the toggle is smooth.
    const cam = this.ctx.camera;
    cam.getWorldDirection(FWD);
    this.target.copy(cam.position).addScaledVector(FWD, this.dist);
    this.yaw = Math.atan2(-FWD.x, -FWD.z);
    this.pitch = Math.asin(clamp(-FWD.y, -1, 1));
    this.idle = 0;
  }

  get isActive(): boolean { return this.active; }

  private bind(): void {
    const el = this.ctx.renderer?.domElement;
    if (!el || typeof window === 'undefined') return;
    el.style.touchAction = 'none';

    el.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      this.dragging = true;
      this.autoOrbit = false;
      this.lastX = e.clientX; this.lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
    });
    el.addEventListener('pointerup', (e) => {
      this.dragging = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      el.style.cursor = this.active ? 'grab' : 'default';
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging || !this.active) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX; this.lastY = e.clientY;
      this.yaw -= dx * 0.0045;
      this.pitch = clamp(this.pitch + dy * 0.0035, -1.35, 1.45);
      this.idle = 0;
    });
    el.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.autoOrbit = false;
      // Multiplicative, so zoom feels the same at 2 m as at 200 m.
      this.dist = clamp(this.dist * Math.exp(e.deltaY * 0.0012), 1.2, 320);
      this.idle = 0;
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      const idx = e.key === '0' ? 10 : Number(e.key);
      const named = Number.isFinite(idx) ? SHOT_ORDER[idx - 1] : undefined;
      if (named) {
        this.goToShot(named);
        this.onFlash?.(`${idx === 10 ? 0 : idx} · ${named}`);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'f') {
        this.freeFly = !this.freeFly;
        this.onFlash?.(this.freeFly ? 'free-fly · WASD QE · shift = fast' : 'orbit');
        return;
      }
      if (k === 'r') {
        this.autoOrbit = !this.autoOrbit;
        this.onFlash?.(this.autoOrbit ? 'auto-orbit on' : 'auto-orbit off');
        return;
      }
      this.keys.add(k);
      if ('wasdqe'.includes(k)) this.autoOrbit = false;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Frames a named shot without pinning — the viewer can then move freely. */
  goToShot(name: ShotName): void {
    const s = SHOTS[name];
    TMP.fromArray(s.pos);
    this.target.fromArray(s.target);
    TMP.sub(this.target);
    this.dist = Math.max(TMP.length(), 1e-3);
    this.yaw = Math.atan2(TMP.x, TMP.z);
    this.pitch = Math.asin(clamp(TMP.y / this.dist, -1, 1));
    this.ctx.camera.fov = s.fov;
    this.ctx.camera.updateProjectionMatrix();
    // Let sky/lighting restage for this shot's hour, but do NOT emit
    // 'shot:applied' — that is the rig's pin signal.
    this.ctx.events.emit('shot:apply', { name, shot: s });
    this.autoOrbit = false;
    this.idle = 0;
  }

  update(dt: number, ctx: Ctx): void {
    const cam = ctx.camera;

    if (this.freeFly) {
      const speed = (this.keys.has('shift') ? 46 : 13) * dt;
      cam.getWorldDirection(FWD);
      RIGHT.crossVectors(FWD, UP).normalize();
      if (this.keys.has('w')) cam.position.addScaledVector(FWD, speed);
      if (this.keys.has('s')) cam.position.addScaledVector(FWD, -speed);
      if (this.keys.has('a')) cam.position.addScaledVector(RIGHT, -speed);
      if (this.keys.has('d')) cam.position.addScaledVector(RIGHT, speed);
      if (this.keys.has('e')) cam.position.y += speed;
      if (this.keys.has('q')) cam.position.y -= speed;
      if (cam.position.y < 0.25) cam.position.y = 0.25;
      // Keep the orbit target ahead, so toggling back is not disorienting.
      this.target.copy(cam.position).addScaledVector(FWD, this.dist);
      cam.lookAt(this.target);
      cam.updateMatrixWorld(true);
      return;
    }

    this.idle += dt;
    if (this.autoOrbit || this.idle > 25) this.yaw += dt * 0.035;

    const cp = Math.cos(this.pitch);
    TMP.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp)
      .multiplyScalar(this.dist);
    cam.position.copy(this.target).add(TMP);
    if (cam.position.y < 0.25) cam.position.y = 0.25;
    cam.lookAt(this.target);
    cam.updateMatrixWorld(true);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
