import * as THREE from 'three';
import { Rng } from '../../core/Ctx.ts';
import { buildRig, randomBodyParams, referenceBodyParams, measureBody } from '../PlayerRig.ts';
import { headFrame, faceSurface } from './Head.ts';
import type { PlayerRig } from '../PlayerRig.ts';

/**
 * DEV HARNESS — not part of the game's system list and never imported by it.
 *
 * The rig cannot be judged through the capture rig until PlayersSystem consumes
 * it, and the rig is what PlayersSystem is waiting on. So this module stands up
 * its own renderer, its own three-point light and a neutral grey shading mode,
 * and is driven straight off the vite dev server by tools/.scratch/rigshot.mjs.
 * It exists to answer one question per frame: does the silhouette read as a
 * person, and does the joint survive being bent.
 *
 *   /src/entities/rig/preview.ts?view=closeup&grey=1
 *
 * views: closeup | full | roster | flex | hands | lod
 */

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'full';
// Shadow-camera extent has to follow the view or self-shadow acne shreds the
// face and gets mistaken for a normals bug. It did, once.
const grey = params.get('grey') === '1';
const detail = Number(params.get('detail') ?? 1);
const W = Number(params.get('w') ?? 1280);
const H = Number(params.get('h') ?? 800);

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
scene.background = new THREE.Color(0x59657a);

const camera = new THREE.PerspectiveCamera(38, W / H, 0.05, 200);

/* ------------------------------------------------------------------ light */
const portrait = view === 'face' || view === 'closeup' || view === 'hands';
const key = new THREE.DirectionalLight(0xfff0dc, portrait ? 2.6 : 3.1);
// A portrait needs a three-quarter key, not a rake: a hard side light hides the
// half of the face you are trying to judge and makes a good sculpt look blank.
if (portrait) key.position.set(-2.2, 3.4, 4.6); else key.position.set(-3.4, 5.0, 3.2);
key.castShadow = params.get('noshadow') !== '1';
key.shadow.mapSize.set(4096, 4096);
const SB = view === 'roster' || view === 'lod' ? 4.5 : 1.6;
key.shadow.camera.left = -SB; key.shadow.camera.right = SB;
key.shadow.camera.top = SB; key.shadow.camera.bottom = -SB;
key.shadow.camera.near = 0.5; key.shadow.camera.far = 20;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.028;
scene.add(key);
const rim = new THREE.DirectionalLight(0xa8c6ff, portrait ? 1.9 : 1.15);
rim.position.set(3.4, 2.4, portrait ? 1.2 : -3.6);
scene.add(rim);
scene.add(new THREE.HemisphereLight(0x9dbbe0, 0x4a4438, portrait ? 1.25 : 0.85));

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ color: 0x3f5138, roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

/* ------------------------------------------------------------------- rigs */
const wire = params.get('wire') === '1';
// ?hide=4,5 discards fragments by aPart id — the only way to work out which of
// two interpenetrating surfaces is the one misbehaving.
const hidden = (params.get('hide') ?? '').split('-').filter(Boolean).map(Number);

function patch(m: THREE.Material): THREE.Material {
  (m as THREE.MeshStandardMaterial).wireframe = wire;
  if (!hidden.length) return m;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute float aPart;\nvarying float vDbgPart;\n' + sh.vertexShader
      .replace('void main() {', 'void main() {\n  vDbgPart = aPart;');
    const test = hidden.map((p) => `abs(vDbgPart - ${p.toFixed(1)}) < 0.5`).join(' || ');
    sh.fragmentShader = 'varying float vDbgPart;\n' + sh.fragmentShader
      .replace('void main() {', `void main() {\n  if (${test}) discard;`);
  };
  m.needsUpdate = true;
  return m;
}

const greyMat = patch(new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.62, metalness: 0 }));

function makeGrey(r: PlayerRig): void {
  for (let i = 0; i < r.materials.length; i++) r.materials[i] = greyMat;
  for (const l of r.lods) l.mesh.material = r.materials;
}

const rand = new Rng(0x51ce7a);
const rigs: PlayerRig[] = [];
let buildMs = 0;
let triTotal = 0;

function add(p: Parameters<typeof buildRig>[0], x: number, z: number, yaw: number): PlayerRig {
  const t0 = performance.now();
  const r = buildRig(p, { charDetail: detail });
  buildMs += performance.now() - t0;
  triTotal += r.triangles;
  if (grey) makeGrey(r); else for (const mm of r.materials) patch(mm);
  r.root.position.set(x, 0, z);
  r.root.rotation.y = yaw;
  scene.add(r.root);
  rigs.push(r);
  return r;
}

/* --------------------------------------------------------------- posing */

/** Bend an arm to `deg` at the elbow with a matching shoulder raise + twist. */
function poseArm(r: PlayerRig, side: 'L' | 'R', deg: number, twistDeg: number): void {
  const b = r.bones;
  const ua = side === 'L' ? b.upperArm_L : b.upperArm_R;
  const ut = side === 'L' ? b.upperArmTwist_L : b.upperArmTwist_R;
  const fa = side === 'L' ? b.foreArm_L : b.foreArm_R;
  const ft = side === 'L' ? b.foreArmTwist_L : b.foreArmTwist_R;
  const hd = side === 'L' ? b.hand_L : b.hand_R;
  const s = side === 'L' ? 1 : -1;
  ua.rotation.set(THREE.MathUtils.degToRad(-58), THREE.MathUtils.degToRad(-18 * s), THREE.MathUtils.degToRad(26 * s));
  ut.rotation.y = THREE.MathUtils.degToRad(-22 * s);
  fa.rotation.x = THREE.MathUtils.degToRad(deg);
  ft.rotation.y = THREE.MathUtils.degToRad(twistDeg * 0.65);
  hd.rotation.set(THREE.MathUtils.degToRad(-12), THREE.MathUtils.degToRad(twistDeg), 0);
}

function poseFingers(r: PlayerRig, side: 'L' | 'R', curlDeg: number): void {
  const suf = side === 'L' ? '_L' : '_R';
  for (const fam of ['index', 'middle', 'ring', 'pinky'] as const) {
    for (let j = 1; j <= 3; j++) {
      const bone = (r.bones as any)[`${fam}0${j}${suf}`] as THREE.Bone;
      bone.rotation.x = THREE.MathUtils.degToRad(curlDeg * [1, 0.95, 0.8][j - 1]);
    }
  }
  const s = side === 'L' ? 1 : -1;
  (r.bones as any)[`thumb01${suf}`].rotation.set(
    THREE.MathUtils.degToRad(curlDeg * 0.35), 0, THREE.MathUtils.degToRad(-14 * s));
  (r.bones as any)[`thumb02${suf}`].rotation.x = THREE.MathUtils.degToRad(curlDeg * 0.55);
  (r.bones as any)[`thumb03${suf}`].rotation.x = THREE.MathUtils.degToRad(curlDeg * 0.5);
}

function poseStride(r: PlayerRig): void {
  const b = r.bones;
  b.thigh_R.rotation.x = THREE.MathUtils.degToRad(42);
  b.shin_R.rotation.x = THREE.MathUtils.degToRad(-78);
  b.foot_R.rotation.x = THREE.MathUtils.degToRad(16);
  b.thigh_L.rotation.x = THREE.MathUtils.degToRad(-26);
  b.shin_L.rotation.x = THREE.MathUtils.degToRad(-16);
  b.foot_L.rotation.x = THREE.MathUtils.degToRad(-22);
  b.thighTwist_R.rotation.y = THREE.MathUtils.degToRad(9);
  b.spine02.rotation.y = THREE.MathUtils.degToRad(-7);
  b.chest.rotation.y = THREE.MathUtils.degToRad(-9);
  b.neck.rotation.y = THREE.MathUtils.degToRad(8);
}

/* ----------------------------------------------------------------- scenes */

if (view === 'closeup') {
  // The framing the round-2 review prescribed for the `closeup` shot: 1.05 m at
  // 38 deg, which is 0.72 m of vertical frame — chest-up, not a wide of a field.
  const p = referenceBodyParams();
  p.hair = params.get('hair') as any ?? 'crop';
  const r = add(p, 0, 0, 0.52);
  r.bones.neck.rotation.y = 0.10;
  r.bones.head.rotation.set(-0.04, 0.13, 0.02);
  camera.position.set(0.60, 1.70, 0.86);
  camera.lookAt(0, 1.645, 0);
  camera.fov = 38;
} else if (view === 'face') {
  const p = referenceBodyParams();
  p.hair = params.get('hair') as any ?? 'short';
  const r = add(p, 0, 0, Number(params.get('yaw') ?? 0.0));
  camera.position.set(Number(params.get('cx') ?? 0), 1.700, 0.55);
  camera.lookAt(0, 1.688, 0);
  camera.fov = 30;
} else if (view === 'full') {
  const p = referenceBodyParams();
  const r = add(p, 0, 0, Math.PI * 0.88);
  poseArm(r, 'R', 118, 62);
  poseFingers(r, 'R', 46);
  poseStride(r);
  camera.position.set(1.9, 1.30, 2.6);
  camera.lookAt(0, 0.95, 0);
  camera.fov = 40;
} else if (view === 'flex') {
  // Deformation torture test: elbow at 130°, knee at 120°, full pronation.
  const p = referenceBodyParams();
  const r = add(p, 0, 0, Math.PI * 0.5);
  poseArm(r, 'R', 130, 88);
  poseFingers(r, 'R', 72);
  poseArm(r, 'L', 130, -88);
  r.bones.thigh_L.rotation.x = THREE.MathUtils.degToRad(66);
  r.bones.shin_L.rotation.x = THREE.MathUtils.degToRad(-120);
  camera.position.set(2.05, 1.32, 0.55);
  camera.lookAt(0.02, 1.06, 0);
  camera.fov = 44;
} else if (view === 'hands') {
  const p = referenceBodyParams();
  const r = add(p, 0, 0, Math.PI);
  poseArm(r, 'R', 96, 74);
  poseFingers(r, 'R', 58);
  const w = r.measure.bind.hand_R;
  camera.position.set(w.x - 0.16, w.y + 0.10, w.z + 0.30);
  camera.lookAt(w.x - 0.02, w.y - 0.05, w.z + 0.02);
  camera.fov = 34;
} else if (view === 'lod') {
  const p = referenceBodyParams();
  for (let i = 0; i < 3; i++) {
    const r = buildRig(p, { charDetail: detail, levels: 3 });
    if (grey) makeGrey(r);
    r.root.position.set((i - 1) * 1.15, 0, 0);
    r.root.rotation.y = Math.PI * 0.9;
    // Force one level visible per copy.
    r.lod.levels.forEach((lv, k) => { lv.object.visible = k === i; });
    r.lod.autoUpdate = false;
    scene.add(r.root);
    rigs.push(r);
    triTotal += r.triangles;
  }
  camera.position.set(0.0, 1.35, 3.4);
  camera.lookAt(0, 1.0, 0);
  camera.fov = 42;
} else {
  // roster — fourteen generated athletes, staggered, judged on variety.
  const t0 = performance.now();
  for (let i = 0; i < 14; i++) {
    const p = randomBodyParams(rand.fork(i * 7919 + 13));
    const col = i % 7, row = (i / 7) | 0;
    add(p, (col - 3) * 0.92, row * 1.5, Math.PI + (i % 3 - 1) * 0.25);
  }
  buildMs = performance.now() - t0;
  camera.position.set(0.4, 2.35, 7.4);
  camera.lookAt(0, 0.95, 0.6);
  camera.fov = 40;
}

camera.updateProjectionMatrix();
camera.updateMatrixWorld(true);
for (const r of rigs) {
  r.root.updateMatrixWorld(true);
  // Pin the level explicitly — deterministic, and it is the step that, when
  // missed, draws all three LODs on top of each other and shatters every
  // surface into z-fighting shards. It looks exactly like a normals bug.
  if (view !== 'lod') { r.lod.update(camera); r.lod.autoUpdate = false; }
}
renderer.render(scene, camera);

// --- numeric probe: where is the globe relative to the sculpted socket?
const _a = measureBody(referenceBodyParams());
const _hf = headFrame(_a);
const _dir = new THREE.Vector3(_hf.eyeN, 0, Math.sqrt(1 - _hf.eyeN * _hf.eyeN));
const _p = new THREE.Vector3();
faceSurface(_a, _hf, _a.p.face, _dir, _p);
const _brow = new THREE.Vector3();
faceSurface(_a, _hf, _a.p.face, new THREE.Vector3(_hf.eyeN, 0.13, 0).normalize(), _brow);
// Bounding boxes per aPart, straight off the built geometry.
function partBox(r: PlayerRig, part: number) {
  const g = r.skinnedMesh.geometry;
  const pa = g.attributes.aPart as THREE.BufferAttribute;
  const po = g.attributes.position as THREE.BufferAttribute;
  const b = new THREE.Box3(); let n = 0;
  for (let i = 0; i < pa.count; i++) {
    if (Math.abs(pa.getX(i) - part) > 0.5) continue;
    b.expandByPoint(new THREE.Vector3(po.getX(i), po.getY(i), po.getZ(i))); n++;
  }
  return n ? { n, min: b.min.toArray().map((v) => +v.toFixed(4)), max: b.max.toArray().map((v) => +v.toFixed(4)) } : { n: 0 };
}
function nearEye(r: PlayerRig, part: number, ex: number, ey: number) {
  const g = r.skinnedMesh.geometry;
  const pa = g.attributes.aPart as THREE.BufferAttribute;
  const po = g.attributes.position as THREE.BufferAttribute;
  let best = -9, bx = 0, by = 0, n = 0;
  for (let i = 0; i < pa.count; i++) {
    if (Math.abs(pa.getX(i) - part) > 0.5) continue;
    if (Math.abs(po.getX(i) - ex) > 0.010 || Math.abs(po.getY(i) - ey) > 0.008) continue;
    n++;
    if (po.getZ(i) > best) { best = po.getZ(i); bx = po.getX(i); by = po.getY(i); }
  }
  return { n, z: +best.toFixed(4), x: +bx.toFixed(4), y: +by.toFixed(4) };
}
(window as any).__PREVIEW__ = {
  eyeVsHead: rigs[0] ? {
    eye: nearEye(rigs[0], 4, _hf.eye.pos[0].x, _hf.eye.pos[0].y),
    head: nearEye(rigs[0], 2, _hf.eye.pos[0].x, _hf.eye.pos[0].y),
  } : null,
  eyeBox: rigs[0] ? partBox(rigs[0], 4) : null,
  headBox: rigs[0] ? partBox(rigs[0], 2) : null,
  probe: {
    centre: _hf.centre.toArray().map((v) => +v.toFixed(4)),
    rx: +_hf.rx.toFixed(4), ry: +_hf.ry.toFixed(4), rz: +_hf.rz.toFixed(4),
    eyeN: +_hf.eyeN.toFixed(3), er: +_hf.eye.r.toFixed(4),
    apW: +_hf.apW.toFixed(3), apU: +_hf.apU.toFixed(3),
    socket: _p.toArray().map((v) => +v.toFixed(4)),
    brow: _brow.toArray().map((v) => +v.toFixed(4)),
    eyePos: _hf.eye.pos[0].toArray().map((v) => +v.toFixed(4)),
    apexZ: +(_hf.eye.pos[0].z + _hf.eye.r * 1.055).toFixed(4),
  },
  ms: +buildMs.toFixed(1),
  tris: triTotal,
  calls: renderer.info.render.calls,
  drawn: renderer.info.render.triangles,
  lods: rigs[0] ? rigs[0].lods.map((l) => l.triangles) : [],
  bones: rigs[0] ? rigs[0].skeleton.bones.length : 0,
};
(window as any).__PREVIEW_READY__ = true;
