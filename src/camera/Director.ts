import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';
import { SHOTS, type ShotName } from '../capture/Shots';

/**
 * Viewer camera for the live build.
 *
 * The gameplay broadcast director is not written yet (there is no game loop to
 * direct). What this provides instead is an explorer: orbit and free-fly
 * controls plus hotkeys onto the named framings in `capture/Shots.ts`, so the
 * same shots the critics review can be walked around in a browser.
 *
 * It deliberately yields to the screenshot rig. `applyShot` hard-pins the camera
 * and emits `shot:applied`; when that fires — or whenever `ctx.capture` is set —
 * this stops writing to the camera entirely, so a captured frame is never a
 * blend of a pinned shot and a live controller.
 */

const SHOT_ORDER: ShotName[] = [
  'broadcast', 'sideline', 'closeup', 'layout', 'disc',
  'stadium', 'turf', 'crowd', 'endzone', 'night',
];

const TMP = new THREE.Vector3();
const FWD = new THREE.Vector3();
const RIGHT = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class CameraDirector implements System {
  readonly name = 'camera';
  readonly order = 10;

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
  private pinned = false;
  private idle = 0;
  private autoOrbit = true;
  private hint: HTMLElement | null = null;
  private hintTimer = 0;

  init(ctx: Ctx): void {
    this.ctx = ctx;
    ctx.events.on('shot:applied', () => { this.pinned = true; });
    if (ctx.capture) { this.pinned = true; return; }

    this.goToShot('broadcast');
    this.bind();
    this.buildHint();
  }

  /* ------------------------------------------------------------- controls */

  private bind(): void {
    const el = this.ctx.renderer.domElement;
    el.style.touchAction = 'none';
    el.style.cursor = 'grab';

    el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.autoOrbit = false;
      this.lastX = e.clientX; this.lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
    });
    el.addEventListener('pointerup', (e) => {
      this.dragging = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      el.style.cursor = 'grab';
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX; this.lastY = e.clientY;
      this.yaw -= dx * 0.0045;
      this.pitch = clamp(this.pitch + dy * 0.0035, -1.35, 1.45);
      this.idle = 0;
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.autoOrbit = false;
      // Multiplicative, so zoom feels the same at 2 m as at 200 m.
      this.dist = clamp(this.dist * Math.exp(e.deltaY * 0.0012), 1.2, 320);
      this.idle = 0;
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      const idx = e.key === '0' ? 10 : Number(e.key);
      const named = Number.isFinite(idx) ? SHOT_ORDER[idx - 1] : undefined;
      if (named) {
        this.goToShot(named);
        this.flash(`${idx === 10 ? 0 : idx} · ${named}`);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'f') {
        this.freeFly = !this.freeFly;
        this.flash(this.freeFly ? 'free-fly · WASD QE · shift = fast' : 'orbit');
        return;
      }
      if (k === 'r') {
        this.autoOrbit = !this.autoOrbit;
        this.flash(this.autoOrbit ? 'auto-orbit on' : 'auto-orbit off');
        return;
      }
      if (k === 'h') { this.toggleHint(); return; }
      this.keys.add(k);
      if ('wasdqe'.includes(k)) this.autoOrbit = false;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Frames a named shot without pinning — the viewer can then move freely. */
  private goToShot(name: ShotName): void {
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

  /* --------------------------------------------------------------- update */

  lateUpdate(dt: number, ctx: Ctx): void {
    if (this.pinned) return;
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
      this.tickHint(dt);
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

    this.tickHint(dt);
  }

  /* ----------------------------------------------------------------- hint */

  private buildHint(): void {
    const ui = document.getElementById('ui');
    if (!ui) return;
    const el = document.createElement('div');
    el.style.cssText = [
      'position:absolute', 'left:16px', 'bottom:16px', 'padding:11px 15px',
      'background:rgba(6,10,16,.72)', '-webkit-backdrop-filter:blur(8px)',
      'backdrop-filter:blur(8px)', 'border:1px solid rgba(150,190,255,.16)',
      'border-radius:9px', 'color:#c9dcf5', 'letter-spacing:.03em',
      'font:500 11px/1.75 ui-monospace,SFMono-Regular,Menlo,monospace',
      'pointer-events:none', 'transition:opacity .4s ease', 'max-width:300px',
    ].join(';');
    el.innerHTML = `
      <div style="color:#7fb2ff;letter-spacing:.18em;font-size:9.5px;margin-bottom:7px">
        ULTIMATE · RENDERER PREVIEW</div>
      <div data-flash>drag to orbit · wheel to zoom</div>
      <div><b>1</b>–<b>0</b> jump between framings</div>
      <div><b>F</b> free-fly · <b>R</b> auto-orbit · <b>H</b> hide</div>
      <div style="opacity:.55;margin-top:7px">no gameplay yet — players are placeholder capsules</div>`;
    ui.appendChild(el);
    this.hint = el;
  }

  private toggleHint(): void {
    if (!this.hint) return;
    this.hint.style.opacity = this.hint.style.opacity === '0' ? '1' : '0';
    this.hintTimer = 0;
  }

  private flash(msg: string): void {
    if (!this.hint) return;
    const line = this.hint.querySelector('[data-flash]') as HTMLElement | null;
    if (line) line.textContent = msg;
    this.hint.style.opacity = '1';
    this.hintTimer = 3.5;
  }

  private tickHint(dt: number): void {
    if (this.hintTimer <= 0) return;
    this.hintTimer -= dt;
    if (this.hintTimer <= 0) {
      const line = this.hint?.querySelector('[data-flash]') as HTMLElement | null;
      if (line) line.textContent = 'drag to orbit · wheel to zoom';
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
