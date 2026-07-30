import * as THREE from 'three';
import { Rng, QUALITY_PRESETS, EventBus } from '../../core/Ctx.ts';
import type { Ctx, QualityTier } from '../../core/Ctx.ts';
import { buildRig, randomBodyParams, referenceBodyParams } from '../PlayerRig.ts';
import type { PlayerRig } from '../PlayerRig.ts';
import { PlayerMaterialLibrary } from '../PlayerMaterial.ts';
import { envFromFn } from '../../util/Tex.ts';

/**
 * DEV HARNESS for the character materials — not in the system list, never
 * imported by the game.
 *
 * The materials cannot be judged through the capture rig until PlayersSystem
 * puts a rig on the pitch, and that is a peer's file. So this stands up its own
 * renderer, its own golden-hour key and its own procedural environment, and
 * answers the only question that matters per frame: does the athlete survive a
 * close crop.
 *
 *   /src/entities/material/preview.ts?view=closeup
 *
 * views: closeup | face | eyes | kit | roster | night | gear
 */

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'closeup';
const W = Number(params.get('w') ?? 1280);
const H = Number(params.get('h') ?? 800);
const tier = (params.get('q') ?? 'high') as QualityTier;
const night = view === 'night';

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = night ? 1.25 : 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.style.margin = '0';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, W / H, 0.03, 400);

/* --------------------------------------------------------------- lighting */

// Golden hour: a low warm key, a cool sky fill, bounce off the turf. The whole
// point of the material set is what it does under a raking warm light, so the
// harness must not be lit like a product shot or it proves nothing.
const sunDir = night
  ? new THREE.Vector3(-0.42, 0.78, 0.46).normalize()
  : new THREE.Vector3(-0.62, 0.28, 0.72).normalize();
const sunCol = night ? new THREE.Color(0.86, 0.90, 1.0) : new THREE.Color(1.0, 0.74, 0.46);

const key = new THREE.DirectionalLight(sunCol.getHex(), night ? 3.4 : 4.6);
key.position.copy(sunDir).multiplyScalar(12);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
const SB = view === 'roster' || view === 'kit' ? 5.0 : 1.4;
key.shadow.camera.left = -SB; key.shadow.camera.right = SB;
key.shadow.camera.top = SB; key.shadow.camera.bottom = -SB;
key.shadow.camera.near = 1; key.shadow.camera.far = 30;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.022;
scene.add(key);

if (night) {
  // Three more towers, so the four-shadow signature is present here too.
  for (const p of [[8, 11, -7], [-9, 11, -6], [7, 11, 8]] as const) {
    const l = new THREE.DirectionalLight(0xcfe0ff, 1.05);
    l.position.set(p[0], p[1], p[2]);
    scene.add(l);
  }
} else {
  const fill = new THREE.DirectionalLight(0x9dbde8, 0.55);
  fill.position.set(3.6, 3.0, -2.2);
  scene.add(fill);
}
scene.add(new THREE.HemisphereLight(night ? 0x1a2334 : 0x9ec2ea, 0x3e4a2c, night ? 0.30 : 0.85));

// Procedural environment. Sheen, clearcoat and the eye's tear film all need
// something to reflect; with no env map the catchlight is the only specular in
// the frame and skin goes chalky.
const env = envFromFn(renderer, 64, (x, y, z, out) => {
  const up = Math.max(0, y);
  const sd = Math.max(0, x * sunDir.x + y * sunDir.y + z * sunDir.z);
  const glow = Math.pow(sd, 22) * (night ? 3 : 26);
  if (y > 0) {
    const zen = night ? [0.020, 0.030, 0.062] : [0.16, 0.30, 0.62];
    const hor = night ? [0.045, 0.055, 0.085] : [0.95, 0.62, 0.34];
    for (let i = 0; i < 3; i++) out[i] = hor[i] + (zen[i] - hor[i]) * Math.pow(up, 0.55);
  } else {
    // Turf bounce — warm, green, and the reason a jaw underside is not black.
    const g = night ? [0.012, 0.016, 0.012] : [0.085, 0.115, 0.055];
    for (let i = 0; i < 3; i++) out[i] = g[i] * (1 + 0.6 * (1 + y));
  }
  out[0] += glow * (night ? 0.6 : 1.0);
  out[1] += glow * (night ? 0.65 : 0.72);
  out[2] += glow * (night ? 0.8 : 0.42);
});
scene.environment = env;
scene.background = env;
scene.backgroundBlurriness = 0.55;
scene.environmentIntensity = night ? 0.35 : 1.0;

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(120, 120),
  new THREE.MeshStandardMaterial({ color: night ? 0x22301c : 0x3d6030, roughness: 0.94 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

/* --------------------------------------------------------------- fake ctx */

const events = new EventBus();
const rand = new Rng(0x51ce7a);
const quality = { ...QUALITY_PRESETS[tier] };
const ctx = {
  renderer, scene, camera, composer: null,
  time: 12.5, dt: 1 / 60, rawDt: 1 / 60, timeScale: 1, frame: 0,
  width: W, height: H, dpr: 1,
  quality, events, rand, sys: {}, debug: false, capture: true,
} as unknown as Ctx;

const kits = new PlayerMaterialLibrary(ctx, { teams: ['home', 'away'], squad: 7 });
events.emit('sun:changed', {
  dir: sunDir.clone(), color: sunCol.clone(), intensity: night ? 0.15 : 1.6,
  hour: night ? 21.5 : 17.4,
});

/* ------------------------------------------------------------------- rigs */

const rigs: PlayerRig[] = [];
let buildMs = 0;
let tris = 0;

function add(p: ReturnType<typeof referenceBodyParams>, team: number, slot: number,
  x: number, z: number, yaw: number): PlayerRig {
  const t0 = performance.now();
  const r = buildRig(p, quality);
  kits.dress(r, { team, slot });
  buildMs += performance.now() - t0;
  tris += r.triangles;
  r.root.position.set(x, 0, z);
  r.root.rotation.y = yaw;
  scene.add(r.root);
  rigs.push(r);
  return r;
}

function relax(r: PlayerRig): void {
  // The bind pose is already a 46° A-pose; the only thing it needs to stop
  // looking like a mannequin is bent elbows and a little counter-rotation.
  const b = r.bones;
  b.foreArm_R.rotation.x = 0.72;
  b.foreArm_L.rotation.x = 0.55;
  b.foreArmTwist_R.rotation.y = -0.34;
  b.spine02.rotation.y = -0.05;
  b.chest.rotation.y = -0.07;
  b.hand_R.rotation.x = -0.12;
}

if (view === 'closeup' || view === 'face' || view === 'eyes') {
  const p = referenceBodyParams();
  p.hair = (params.get('hair') as any) ?? 'crop';
  const r = add(p, Number(params.get('team') ?? 0), Number(params.get('slot') ?? 3), 0, 0, 0.55);
  relax(r);
  r.bones.neck.rotation.y = 0.09;
  r.bones.head.rotation.set(-0.03, 0.12, 0.02);
  const eyeY = r.measure.eyeY;
  if (view === 'closeup') {
    // Chest-up: 0.95 m out at 38°, which frames roughly 0.65 m of subject.
    camera.position.set(0.52, eyeY - 0.03, 0.78);
    camera.lookAt(0, eyeY - 0.15, 0);
    camera.fov = 38;
  } else if (view === 'face') {
    camera.position.set(0.30, eyeY + 0.015, 0.46);
    camera.lookAt(0, eyeY - 0.005, 0);
    camera.fov = 30;
  } else {
    camera.position.set(0.14, eyeY + 0.012, 0.22);
    camera.lookAt(0.012, eyeY + 0.002, 0);
    camera.fov = 26;
  }
} else if (view === 'kit') {
  // Two athletes, one per team, front and back, judging colourway and numbers.
  const a = add(referenceBodyParams(), 0, 2, -0.55, 0, Math.PI * 0.98);
  const b = add(randomBodyParams(rand.fork(31)), 1, 5, 0.55, 0, 0.02);
  relax(a); relax(b);
  camera.position.set(0.05, 1.30, 3.05);
  camera.lookAt(0, 1.02, 0);
  camera.fov = 40;
} else if (view === 'gear') {
  const r = add(referenceBodyParams(), 1, 4, 0, 0, Math.PI * 0.72);
  r.bones.thigh_R.rotation.x = 0.62;
  r.bones.shin_R.rotation.x = -1.16;
  r.bones.foot_R.rotation.x = 0.30;
  camera.position.set(0.42, 0.34, 0.72);
  camera.lookAt(0.02, 0.16, 0);
  camera.fov = 34;
} else {
  // roster / night — fourteen dressed athletes, two teams.
  for (let i = 0; i < 14; i++) {
    const p = randomBodyParams(rand.fork(i * 7919 + 13));
    const team = i < 7 ? 0 : 1;
    const col = i % 7;
    const r = add(p, team, col, (col - 3) * 0.95, team * 1.7, Math.PI + (i % 3 - 1) * 0.22);
    relax(r);
  }
  camera.position.set(0.6, 2.05, 6.2);
  camera.lookAt(0, 0.98, 0.8);
  camera.fov = 38;
}

camera.updateProjectionMatrix();
camera.updateMatrixWorld(true);
for (const r of rigs) {
  r.root.updateMatrixWorld(true);
  r.lod.update(camera);
  r.lod.autoUpdate = false;
}
kits.update(ctx);
renderer.render(scene, camera);
// Two frames: the first compiles, the second is the one that is measured.
renderer.info.reset();
kits.update(ctx);
renderer.render(scene, camera);

(window as any).__PREVIEW__ = {
  view,
  tier,
  textureBytes: kits.textureBytes,
  textureMB: +(kits.textureBytes / 1048576).toFixed(2),
  report: kits.report(),
  ms: +buildMs.toFixed(1),
  tris,
  calls: renderer.info.render.calls,
  drawn: renderer.info.render.triangles,
  programs: renderer.info.programs?.length ?? 0,
};
(window as any).__PREVIEW_READY__ = true;
