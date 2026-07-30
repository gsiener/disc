import * as THREE from 'three';
import { Rng } from '../../core/Ctx.ts';
import { buildRig, randomBodyParams, referenceBodyParams } from '../PlayerRig.ts';
import type { PlayerRig } from '../PlayerRig.ts';
import { Locomotion } from '../../sim/Locomotion.ts';
import type { LocoPlayer, DesiredMove } from '../../sim/move/Types.ts';
import { Animator } from '../Animator.ts';
import type { AnimHandle } from '../Animator.ts';
import { debugAnkleWorld } from './Feet.ts';
import { B } from './Kine.ts';

/**
 * DEV HARNESS for the animation layer — not in the system list, never imported
 * by the game.
 *
 * A still frame cannot tell you whether a gait reads or whether a planted foot
 * slides; both are properties of the sequence. So this stands up a scene driven
 * by the REAL `Locomotion` (same class the game runs, `attach`ed headlessly),
 * runs it at a fixed 1/120 s, and exposes a step/render pair the capture driver
 * can pump one frame at a time.
 *
 * It also measures the one number that matters. While `foot.contact` is true the
 * animator promises the ankle's world position is a constant; `slideMM` is the
 * largest frame-to-frame movement of any loaded ankle, in millimetres, taken off
 * the committed bone matrices rather than off the intent. Anything above a
 * couple of millimetres is a skate and shows up in motion instantly.
 *
 *   /src/entities/anim/preview.ts?view=run
 *   views: run | roster | cut | throw | layout | idle
 */

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'run';
const detail = Number(params.get('detail') ?? 1);
const W = Number(params.get('w') ?? 1280);
const H = Number(params.get('h') ?? 800);
const grey = params.get('grey') === '1';

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.style.margin = '0';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x6b7d93);
const camera = new THREE.PerspectiveCamera(38, W / H, 0.05, 400);

/* ------------------------------------------------------------------ light */
const key = new THREE.DirectionalLight(0xffeeda, 3.0);
key.position.set(-7, 9, 6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
const SB = 12;
key.shadow.camera.left = -SB; key.shadow.camera.right = SB;
key.shadow.camera.top = SB; key.shadow.camera.bottom = -SB;
key.shadow.camera.near = 0.5; key.shadow.camera.far = 40;
key.shadow.bias = -0.0005;
key.shadow.normalBias = 0.028;
scene.add(key);
scene.add(new THREE.HemisphereLight(0x9dbbe0, 0x4a4438, 1.0));

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x46703a, roughness: 0.96 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// A metre grid on the turf. Without a static reference in the frame a sliding
// foot and a correctly planted one look identical.
{
  const g = new THREE.BufferGeometry();
  const pts: number[] = [];
  for (let i = -40; i <= 40; i++) {
    pts.push(i, 0.004, -40, i, 0.004, 40);
    pts.push(-40, 0.004, i, 40, 0.004, i);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x3a5c30 })));
}

/* -------------------------------------------------------------- the roster */

const rand = new Rng(0x51ce7a);
const loco = new Locomotion();
loco.autoResolve = false;
loco.attach({});

const anim = new Animator({ detail });
const rigs: PlayerRig[] = [];
const bodies: LocoPlayer[] = [];
const handles: AnimHandle[] = [];
let buildMs = 0;
let triTotal = 0;

const KIT = [0x1d4e94, 0xf2f2ee];
const TRIM = [0xd8dde6, 0xb3372e];

function addAthlete(i: number, x: number, z: number, facing: number, team: 0 | 1): AnimHandle {
  const t0 = performance.now();
  const p = i === 0 && view !== 'roster' ? referenceBodyParams() : randomBodyParams(rand.fork(i * 7919 + 13));
  const rig = buildRig(p, { charDetail: detail });
  buildMs += performance.now() - t0;
  triTotal += rig.triangles;

  if (grey) {
    const m = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.62 });
    for (let k = 0; k < rig.materials.length; k++) rig.materials[k] = m;
  } else {
    // Placeholder kit so left and right read apart in motion. The real material
    // system owns the look; this only has to be legible.
    (rig.materials[rig.groups.jersey] as THREE.MeshStandardMaterial).color.setHex(KIT[team]);
    (rig.materials[rig.groups.shorts] as THREE.MeshStandardMaterial).color.setHex(TRIM[team]);
  }
  for (const l of rig.lods) l.mesh.material = rig.materials;

  const body = loco.create({
    id: i, team, pos: new THREE.Vector3(x, 0, z), facing,
    attr: { height: p.height, speed: 62 + (i % 7) * 5, accel: 60 + (i % 5) * 8 },
  });
  scene.add(rig.root);
  rigs.push(rig);
  bodies.push(body);
  const h = anim.add(rig, body, { id: i });
  handles.push(h);
  return h;
}

/* ------------------------------------------------------------------ scenes */

interface Scene {
  desired(p: LocoPlayer, i: number, t: number): DesiredMove;
  frame(t: number): void;
}

const V = new THREE.Vector3();
let scenario: Scene;

if (view === 'roster') {
  for (let i = 0; i < 14; i++) {
    const col = i % 7, row = (i / 7) | 0;
    addAthlete(i, (col - 3) * 2.6, row * 5 - 2.5, row === 0 ? 0 : Math.PI, row as 0 | 1);
  }
  camera.position.set(0.5, 4.6, 15.5);
  camera.lookAt(0, 1.0, 0);
  camera.fov = 44;
  scenario = {
    desired: (p, i, t) => {
      // Every athlete on a different speed so one frame shows the whole gait
      // ladder — idle, jog, run, sprint — side by side.
      const spd = [0, 0.9, 2.2, 3.4, 4.6, 5.8, 7.2][i % 7];
      const dir = i < 7 ? 1 : -1;
      V.set(Math.sin(t * 0.25 + i) * 0.12, 0, dir);
      return { dir: V, speed: spd, mode: 'auto' };
    },
    frame: () => {},
  };
} else if (view === 'cut') {
  addAthlete(0, 0, 0, 0, 0);
  addAthlete(1, 1.4, -1.6, 0, 1);
  camera.position.set(6.2, 1.9, 5.4);
  camera.lookAt(0, 1.0, 0.4);
  camera.fov = 44;
  scenario = {
    desired: (p, i, t) => {
      // A near-reversal every 1.3 s. A 90-degree turn is inside the sim's turn
      // rate and it just steers through it — nothing enters the `cut` state and
      // nothing plants. It takes a genuine change of direction to make the sim
      // commit to a foot, which is the whole thing being tested.
      const leg = Math.floor(t / 1.3) % 2;
      const dx = leg === 0 ? 1 : -1;
      V.set(dx, 0, 0.30).normalize();
      if (i === 1) { V.set(-dx * 0.9, 0, 0.5).normalize(); return { dir: V, effort: 0.85 }; }
      return { dir: V, effort: 1 };
    },
    frame: () => {},
  };
} else if (view === 'throw') {
  const thrower = addAthlete(0, 0, 0, 0.35, 0);
  addAthlete(1, 0.05, 1.35, Math.PI + 0.35, 1);     // the mark
  handles[1].marking = 1;
  camera.position.set(2.9, 1.62, 2.5);
  camera.lookAt(0.1, 1.05, 0.2);
  camera.fov = 40;
  thrower.carrying = true;
  // 2.2-second cycle: 1.1 s of windup, a release, a follow-through, reset. The
  // athlete turns 100 degrees across the cycle so the pivot foot has something
  // to prove.
  const charge = {
    active: false, hold: 0, power: 1, type: 'backhand' as const,
    tilt: 0.1, aimYaw: 0, targetHold: 0.75, maxHold: 1.4,
  };
  scenario = {
    desired: (p, i, t) => {
      if (i === 1) { V.set(0, 0, -1); return { dir: V, speed: 0, face: V, mode: 'shuffle' }; }
      const u = (t % 2.2) / 2.2;
      V.set(Math.sin(-0.9 + u * 1.8), 0, Math.cos(-0.9 + u * 1.8));
      return { speed: 0, face: V };
    },
    frame: (t) => {
      const u = t % 2.2;
      if (u < 1.1) {
        charge.active = true; charge.hold = u;
        thrower.setCharge(charge);
        thrower.carrying = true;
      } else if (u < 1.12) {
        charge.active = false;
        thrower.release({ fired: true, type: 'backhand', power: 1, quality: 1, tilt: 0.1, aimYaw: 0 });
      } else {
        thrower.setCharge(null);
      }
    },
  };
} else if (view === 'throws') {
  // All five throw shapes at the same whip time, side by side. The only honest
  // way to check a hand-authored key table is to see the whole table at once.
  const KINDS = ['backhand', 'forehand', 'hammer', 'scoober', 'blade'] as const;
  const throwers: AnimHandle[] = [];
  for (let i = 0; i < 5; i++) {
    const h = addAthlete(i, (i - 2) * 1.6, 0, 0.30, (i % 2) as 0 | 1);
    h.carrying = true;
    h.gazeWeight = 0;
    throwers.push(h);
  }
  camera.position.set(0.0, 1.60, 6.4);
  camera.lookAt(0, 1.05, 0);
  camera.fov = 52;
  const charges = KINDS.map((type) => ({
    active: false, hold: 0, power: 1, type,
    tilt: 0, aimYaw: 0, targetHold: 0.7, maxHold: 1.4,
  }));
  scenario = {
    desired: () => { V.set(0.3, 0, 0.95).normalize(); return { speed: 0, face: V }; },
    frame: (t) => {
      // 1.9 s: coil to full, release, follow through, reset.
      const u = t % 1.9;
      for (let i = 0; i < 5; i++) {
        if (u < 0.95) {
          charges[i].active = true; charges[i].hold = u;
          throwers[i].setCharge(charges[i]);
          throwers[i].carrying = true;
        } else if (u < 0.97) {
          charges[i].active = false;
          throwers[i].release({ fired: true, type: KINDS[i], power: 1, quality: 1, tilt: 0, aimYaw: 0 });
        } else {
          throwers[i].setCharge(null);
        }
      }
    },
  };
} else if (view === 'layout') {
  const diver = addAthlete(0, 0, -2.5, 0, 0);
  camera.position.set(6.0, 1.15, 4.2);
  camera.lookAt(0, 0.75, 1.2);
  camera.fov = 36;
  const disc = { x: 1.15, y: 0.55, z: 3.6 };
  const discVel = { x: -0.4, y: -1.2, z: -4.5 };
  const marker = new THREE.Mesh(
    new THREE.CylinderGeometry(0.135, 0.135, 0.021, 24),
    new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.35 }),
  );
  scene.add(marker);
  scenario = {
    desired: (p, i, t) => {
      const u = t % 3.0;
      V.set(0.28, 0, 1).normalize();
      if (u > 1.05 && u < 1.10 && !p.air.airborne && p.state !== 'layout') {
        return { dir: V, effort: 1, layout: true };
      }
      return { dir: V, effort: u < 1.05 ? 1 : 0.2 };
    },
    frame: (t) => {
      const u = t % 3.0;
      // The disc sits where the diver is going, at fingertip height.
      disc.x = 1.15; disc.y = 0.62; disc.z = 3.2;
      marker.position.set(disc.x, disc.y, disc.z);
      marker.rotation.z = 0.35;
      marker.rotation.y = t * 24;
      if (u > 0.9) diver.reachFor(disc, discVel);
      else diver.releaseReach();
      diver.gaze = disc;
    },
  };
} else if (view === 'idle') {
  for (let i = 0; i < 4; i++) addAthlete(i, (i - 1.5) * 1.5, 0, Math.PI, (i % 2) as 0 | 1);
  camera.position.set(0.6, 1.75, 5.4);
  camera.lookAt(0, 1.0, 0);
  camera.fov = 40;
  for (const h of handles) h.loco.stamina = 34;
  scenario = {
    desired: (p, i, t) => {
      V.set(Math.sin(t * 0.4 + i * 1.7), 0, Math.cos(t * 0.4 + i * 1.7));
      return { speed: 0, face: V };
    },
    frame: () => {},
  };
} else {
  // run — one athlete accelerating from a standstill to a full sprint and back,
  // filmed from the side. The gait ladder in a single clip.
  addAthlete(0, 0, -14, 0, 0);
  camera.position.set(9.5, 1.55, 0);
  camera.lookAt(0, 0.95, 0);
  camera.fov = 40;
  scenario = {
    desired: (p, i, t) => {
      V.set(0, 0, 1);
      const spd = t < 0.6 ? 0 : t < 3.4 ? 8.6 : 1.6;
      return { dir: V, speed: spd };
    },
    frame: () => {},
  };
}

anim.gaze = null;
for (const r of rigs) { r.lod.update(camera); }
camera.updateProjectionMatrix();
camera.updateMatrixWorld(true);

/* ------------------------------------------------------------- slide probe */

/** Two slots per athlete — L then R. A contact switch must not be a comparison. */
const prevHeel: THREE.Vector3[] = handles.flatMap(() => [new THREE.Vector3(), new THREE.Vector3()]);
const prevBall: THREE.Vector3[] = handles.flatMap(() => [new THREE.Vector3(), new THREE.Vector3()]);
const prevAnkle: THREE.Vector3[] = handles.flatMap(() => [new THREE.Vector3(), new THREE.Vector3()]);
const prevValid: boolean[] = handles.flatMap(() => [false, false]);
const _w = new THREE.Vector3();
const _w2 = new THREE.Vector3();
const _w3 = new THREE.Vector3();
let slideMM = 0;
let slideSamples = 0;
let slideSum = 0;
let ankleMM = 0;
/** Stance-phase and pitch at the worst sample — so a peak can be located. */
let worstAt = { uStance: 0, pitch: 0, phase: 0, side: 0 };
let midMM = 0, midSum = 0, midSamples = 0;

/**
 * The ankle is NOT the thing that must hold still — the sole is. A correct
 * stance rolls the foot about a contact point, which translates the ankle by
 * design (that is the whole of `ankleWorld`'s pivot shift). Measuring the ankle
 * therefore scores a good foot as a sliding one.
 *
 * So measure the two sole points instead. In the foot bone's own frame local +Y
 * runs toward the ball and local +Z is up, so heel and ball are a Y offset and
 * one ankle-height down in Z. At every instant of stance at least one of them is
 * the pivot and must be stationary in the world; the min of the two is the
 * honest skate number.
 */
function probeSlide(): void {
  for (let i = 0; i < handles.length; i++) {
    const h = handles[i];
    for (let k = 0; k < 2; k++) {
      const slot = i * 2 + k;
      const t = k === 0 ? h.feet.L : h.feet.R;
      if (!t.contact || h.feet.free) { prevValid[slot] = false; continue; }
      const bone = t.side === 1 ? h.rig.bones.foot_L : h.rig.bones.foot_R;
      const H = h.kine.height;
      const ay = h.kine.ankleY;
      _w.set(0, -0.030 * H, -ay).applyMatrix4(bone.matrixWorld);      // heel
      _w2.set(0, 0.075 * H, -ay).applyMatrix4(bone.matrixWorld);      // ball
      _w3.setFromMatrixPosition(bone.matrixWorld);                     // ankle
      if (prevValid[slot]) {
        const dh = _w.distanceTo(prevHeel[slot]) * 1000;
        const db = _w2.distanceTo(prevBall[slot]) * 1000;
        const da = _w3.distanceTo(prevAnkle[slot]) * 1000;
        const d = Math.min(dh, db);
        // A fresh plant legitimately re-pins the foot somewhere else; under
        // 25 mm in one 1/120 s frame is stance, not a new plant.
        if (d < 25) {
          if (d > slideMM) {
            slideMM = d;
            worstAt = { uStance: +t.uStance.toFixed(3), pitch: +t.pitch.toFixed(3), phase: +t.u.toFixed(3), side: t.side };
          }
          slideSum += d; slideSamples++;
          // Mid-stance only: past the touchdown transient, before toe-off. This
          // is the window where the foot is flat and loaded and the number
          // should be a hard zero.
          if (t.uStance > 0.25 && t.uStance < 0.85) {
            midSum += d; midSamples++;
            if (d > midMM) midMM = d;
          }
        }
        if (da < 25) ankleMM = Math.max(ankleMM, da);
      }
      prevHeel[slot].copy(_w);
      prevBall[slot].copy(_w2);
      prevAnkle[slot].copy(_w3);
      prevValid[slot] = true;
    }
  }
}

/* ------------------------------------------------------------------ driver */

const FIXED = 1 / 120;
let simT = 0;
let animMs = 0;
let animMsPeak = 0;
let animFrames = 0;

function step(n = 1): void {
  for (let k = 0; k < n; k++) {
    scenario.frame(simT);
    for (let i = 0; i < bodies.length; i++) {
      loco.step(bodies[i], scenario.desired(bodies[i], i, simT), FIXED);
    }
    simT += FIXED;
    anim.update(FIXED, null);
    animMs += anim.ms;
    animMsPeak = Math.max(animMsPeak, anim.ms);
    animFrames++;
    // The animator only touches bone locals; the committed world matrices the
    // slide probe reads are produced here.
    for (const r of rigs) r.root.updateMatrixWorld(true);
    probeSlide();
  }
}

function render(): void {
  for (const r of rigs) { r.lod.update(camera); }
  renderer.render(scene, camera);
}

function stats(): Record<string, unknown> {
  return {
    view,
    players: handles.length,
    buildMs: +buildMs.toFixed(1),
    tris: triTotal,
    drawn: renderer.info.render.triangles,
    calls: renderer.info.render.calls,
    simT: +simT.toFixed(3),
    animMsMean: +(animMs / Math.max(1, animFrames)).toFixed(3),
    animMsPeak: +animMsPeak.toFixed(3),
    perPlayerUs: +((animMs / Math.max(1, animFrames)) / Math.max(1, handles.length) * 1000).toFixed(1),
    fkPasses: anim.counters.fk,
    legIk: anim.counters.legIk,
    slideMaxMM: +slideMM.toFixed(3),
    slideMeanMM: +(slideSum / Math.max(1, slideSamples)).toFixed(3),
    ankleMaxMM: +ankleMM.toFixed(3),
    slideWorstAt: worstAt,
    slideMidMaxMM: +midMM.toFixed(3),
    slideMidMeanMM: +(midSum / Math.max(1, midSamples)).toFixed(4),
    dbg: handles.map((h, i) => ({
      st: bodies[i].state,
      air: bodies[i].air.airborne,
      prone: bodies[i].prone,
      proneW: +h.body.proneW.toFixed(3),
      freeW: +h.body.freeW.toFixed(3),
      rise: +h.body.rise.toFixed(3),
      hipY: +h.pose.hip.y.toFixed(3),
      pelvisX: +(2 * Math.asin(Math.max(-1, Math.min(1, h.pose.q[B.pelvis * 4])))).toFixed(3),
      kind: h.throwing.kind,
      hand: h.handed,
      // Where the throwing upper arm actually points, rig space. Local +Y runs
      // down the bone, so armDir.y = -1 is straight down at the side and +1 is
      // straight overhead. Reading this off the FK beats squinting at a render.
      armDir: (() => {
        const ua = h.handed === 1 ? B.upperArm_L : B.upperArm_R;
        const q = new THREE.Quaternion(
          h.kine.wq[ua * 4], h.kine.wq[ua * 4 + 1], h.kine.wq[ua * 4 + 2], h.kine.wq[ua * 4 + 3],
        );
        const d = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        return [+d.x.toFixed(2), +d.y.toFixed(2), +d.z.toFixed(2)];
      })(),
      ovr: [+h.feet.L.overrun.toFixed(4), +h.feet.R.overrun.toFixed(4)],
      plantL: [+h.feet.L.plant.x.toFixed(4), +h.feet.L.plant.z.toFixed(4)],
      catchW: +h.catching.w.toFixed(2),
      throwW: +h.throwing.w.toFixed(2),
      pivot: h.feet.pivotOn ? h.feet.pivot : 0,
    })),
    states: bodies.map((b) => b.state),
    speeds: bodies.map((b) => +Math.hypot(b.vel.x, b.vel.z).toFixed(2)),
    footY: handles.map((h) => {
      const o = B.foot_L * 3;
      return +h.kine.wp[o + 1].toFixed(4);
    }),
  };
}

function resetProbe(): void {
  slideMM = 0; slideSum = 0; slideSamples = 0; ankleMM = 0;
  midMM = 0; midSum = 0; midSamples = 0;
  animMs = 0; animMsPeak = 0; animFrames = 0;
  anim.resetStats();
}

/** Track a moving athlete so a long run does not leave the frame. */
function follow(i = 0, back = 5.0, up = 1.30, side = 0.6): void {
  const b = bodies[i];
  camera.position.set(b.pos.x + back, up, b.pos.z + side);
  camera.lookAt(b.pos.x, 0.95, b.pos.z);
  camera.updateMatrixWorld(true);
}

(window as any).__ANIM__ = {
  step, render, stats, resetProbe, follow, anim, handles, bodies, rigs, camera,
  debugAnkleWorld,
};
(window as any).__PREVIEW__ = stats();
(window as any).__PREVIEW_READY__ = true;
