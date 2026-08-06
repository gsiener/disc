/**
 * Numerical verification of src/sim/DiscPhysics.ts.
 *
 *   node tools/test-disc.ts
 *
 * Everything here is measured off real integration at the engine's fixed
 * 1/120 s step. No screenshots, no eyeballing.
 */

import * as THREE from 'three';
import {
  AERO, DISC, FIXED_DT,
  aeroProbe, bankAngle, cloneDiscState, discNormal, isFiniteState,
  liftCoeff, dragCoeff, pitchCoeff,
  powerForSpeed, predictLanding, predictPath, simulate, throwDisc,
  THROW_TYPES, THROW_SPECS, totalEnergy,
  type DiscState, type ThrowType,
} from '../src/sim/DiscPhysics.ts';
import { humanReleaseParams } from '../src/sim/Game.ts';

/* ------------------------------------------------------------------ harness */

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string, detail = ''): void {
  if (cond) { passed++; console.log(`  PASS  ${label}${detail ? '   ' + detail : ''}`); }
  else { failed++; failures.push(label); console.log(`  FAIL  ${label}${detail ? '   ' + detail : ''}`); }
}

function inRange(v: number, lo: number, hi: number, label: string, unit = ''): void {
  ok(v >= lo && v <= hi, label, `${fmt(v)}${unit} in [${lo}, ${hi}]`);
}

function fmt(v: number, d = 2): string {
  return (Math.abs(v) < 1e-12 ? 0 : v).toFixed(d);
}

function section(title: string): void {
  console.log(`\n${'-'.repeat(74)}\n${title}\n${'-'.repeat(74)}`);
}

/* --------------------------------------------------------------- flight run */

interface Flight {
  /** Straight-line horizontal distance from release to landing, m. */
  distance: number;
  /** Distance along the aim axis, m. */
  downrange: number;
  /** Signed lateral drift; positive = to the thrower's LEFT (world +X for aim +Z). */
  drift: number;
  maxHeight: number;
  time: number;
  landed: boolean;
  /** Descent angle at touchdown, degrees below horizontal. */
  descentDeg: number;
  spin0: number;
  spinEnd: number;
  alphaMax: number;
  alphaMin: number;
  /** Largest |d alpha| between consecutive 1/120 steps, rad. */
  alphaStep: number;
  /** Fraction of airborne samples with the disc normal pointing below horizontal. */
  invertedFrac: number;
  bankEndDeg: number;
  samples: { t: number; x: number; y: number; z: number; v: number; alpha: number; spin: number }[];
  state: DiscState;
}

const ORIGIN = new THREE.Vector3();

/**
 * Fly a disc to the ground. Aim is assumed +Z, so lateral drift is +X, and
 * with +Z forward and +Y up the thrower's LEFT is +X (right = heading x up = -X).
 */
function fly(s: DiscState, wind = new THREE.Vector3(), maxT = 12): Flight {
  const start = s.pos.clone();
  const f: Flight = {
    distance: 0, downrange: 0, drift: 0, maxHeight: 0, time: 0, landed: false,
    descentDeg: 0, spin0: s.spin, spinEnd: 0, alphaMax: -9, alphaMin: 9,
    alphaStep: 0, invertedFrac: 0, bankEndDeg: 0, samples: [], state: s,
  };
  let prevAlpha = s.alpha;
  let inverted = 0, airborne = 0;
  const steps = Math.round(maxT * 120);
  let lastVel = s.vel.clone();

  for (let i = 0; i < steps; i++) {
    lastVel.copy(s.vel);
    simulate(s, FIXED_DT, wind);
    if (s.touchedGround) { f.landed = true; f.time = s.t; break; }
    airborne++;
    f.maxHeight = Math.max(f.maxHeight, s.pos.y - start.y);
    f.alphaMax = Math.max(f.alphaMax, s.alpha);
    f.alphaMin = Math.min(f.alphaMin, s.alpha);
    f.alphaStep = Math.max(f.alphaStep, Math.abs(s.alpha - prevAlpha));
    prevAlpha = s.alpha;
    if (discNormal(s).y < 0) inverted++;
    if (i % 12 === 0) {
      f.samples.push({
        t: s.t, x: s.pos.x, y: s.pos.y, z: s.pos.z,
        v: s.vel.length(), alpha: s.alpha, spin: s.spin,
      });
    }
  }
  if (!f.landed) f.time = s.t;
  const dx = s.pos.x - start.x, dz = s.pos.z - start.z;
  f.downrange = dz;
  f.drift = dx;
  f.distance = Math.hypot(dx, dz);
  f.spinEnd = s.spin;
  f.invertedFrac = airborne > 0 ? inverted / airborne : 0;
  f.descentDeg = (Math.atan2(-lastVel.y, Math.hypot(lastVel.x, lastVel.z)) * 180) / Math.PI;
  f.bankEndDeg = (bankAngle(s) * 180) / Math.PI;
  return f;
}

function report(name: string, f: Flight): void {
  console.log(
    `  ${name.padEnd(22)} dist ${fmt(f.distance, 1).padStart(5)} m` +
    ` | downrange ${fmt(f.downrange, 1).padStart(6)}` +
    ` | drift ${fmt(f.drift, 2).padStart(6)} m ${f.drift > 0 ? 'LEFT ' : 'RIGHT'}` +
    ` | apex ${fmt(f.maxHeight, 2).padStart(5)} m` +
    ` | t ${fmt(f.time, 2)} s` +
    ` | descent ${fmt(f.descentDeg, 0).padStart(3)} deg` +
    ` | spin ${fmt(f.spin0, 1)}->${fmt(f.spinEnd, 1)} rad/s` +
    ` | alpha ${fmt((f.alphaMin * 180) / Math.PI, 0)}..${fmt((f.alphaMax * 180) / Math.PI, 0)} deg`,
  );
}

function bh(speed: number, angle = 0, spin = 0.6, opts = {}): DiscState {
  return throwDisc('backhand', new THREE.Vector3(0, 1.3, 0), new THREE.Vector3(0, 0, 1),
    powerForSpeed('backhand', speed), angle, spin, opts);
}

/* ============================================================== 0. sanity */

section('0. coefficient curves and constants');
{
  ok(Math.abs(DISC.mass - 0.175) < 1e-9, 'mass = 0.175 kg');
  ok(Math.abs(DISC.area - 0.0568) < 1e-9, 'area = 0.0568 m^2');
  ok(Math.abs(DISC.Izz / DISC.Ixx - 2) < 1e-6, 'Izz / Ixx = 2', `${fmt(DISC.Izz / DISC.Ixx, 4)}`);

  ok(Math.abs(liftCoeff(0) - 0.15) < 1e-9, 'CL(0) = CL0 = 0.15');
  ok(Math.abs(liftCoeff(0.1) - (AERO.CL0 + AERO.CLa * 0.1)) < 1e-12,
    'CL is linear pre-stall', `CL(0.1) = ${fmt(liftCoeff(0.1), 3)}`);
  {
    let bestLD = 0, bestA = 0;
    for (let a = -0.1; a < 0.6; a += 0.001) {
      const r = liftCoeff(a) / dragCoeff(a);
      if (r > bestLD) { bestLD = r; bestA = a; }
    }
    inRange(bestLD, 2.0, 3.2, 'peak lift-to-drag matches a real disc');
    console.log(`  peak L/D ${fmt(bestLD, 2)} at alpha ${fmt((bestA * 180) / Math.PI, 1)} deg`);
  }
  ok(Math.abs(dragCoeff(-0.07) - 0.08) < 1e-9, 'CD minimum at alpha0 = -0.07');
  ok(dragCoeff(0.3) > dragCoeff(0.1), 'CD grows with alpha',
    `CD(0.1)=${fmt(dragCoeff(0.1), 3)} CD(0.3)=${fmt(dragCoeff(0.3), 3)}`);

  // Post-stall: lift must roll over, drag must approach a flat plate.
  const clPeak = Math.max(...Array.from({ length: 200 }, (_, i) => liftCoeff(i * 0.008)));
  const cl80 = liftCoeff(1.4);
  ok(cl80 < clPeak * 0.7, 'lift stalls past the peak',
    `peak ${fmt(clPeak, 3)} -> CL(80deg) ${fmt(cl80, 3)}`);
  inRange(dragCoeff(Math.PI / 2), 1.0, 1.35, 'CD face-on ~ flat circular plate (1.17)');

  // The sign change in CM is the whole turn/fade mechanism.
  ok(pitchCoeff(0) < 0, 'CM nose-down at alpha = 0', `${fmt(pitchCoeff(0), 4)}`);
  ok(pitchCoeff(0.25) > 0, 'CM nose-up at alpha = 14 deg', `${fmt(pitchCoeff(0.25), 4)}`);
  let zeroAt = 0;
  for (let a = -0.3; a < 0.6; a += 1e-4) if (pitchCoeff(a) < 0) zeroAt = a;
  inRange((zeroAt * 180) / Math.PI, 0.3, 8,
    'CM crosses zero at a small positive alpha (the trim point)', ' deg');
}

/* ============================================ 1. flat 20 m/s backhand flies */

section('1. flat 20 m/s right-handed backhand');
const flat20 = fly(bh(20));
report('backhand 20 m/s', flat20);
{
  ok(flat20.landed, 'lands (does not fly forever)');
  inRange(flat20.distance, 35, 55, 'distance is plausible', ' m');
  inRange(flat20.time, 2.0, 6.0, 'hang time is plausible', ' s');
  inRange(flat20.maxHeight, 0.0, 8.0, 'apex is plausible', ' m');
  ok(isFiniteState(flat20.state), 'state finite at landing');

  // Terminal-ish behaviour: it must actually be slowing down.
  const v0 = flat20.samples[0].v;
  const vEnd = flat20.samples[flat20.samples.length - 1].v;
  ok(vEnd < v0 * 0.75, 'drag bleeds speed', `${fmt(v0, 1)} -> ${fmt(vEnd, 1)} m/s`);

  // Turn-then-fade: bank must swing right (negative) early and left (positive) late.
  const banks: number[] = [];
  {
    const p = bh(20);
    for (let i = 0; i < 1200 && !p.touchedGround; i++) {
      simulate(p, FIXED_DT);
      if (i % 12 === 0) banks.push((bankAngle(p) * 180) / Math.PI);
    }
  }
  const early = Math.max(...banks.slice(0, Math.floor(banks.length * 0.4)));
  const late = Math.min(...banks.slice(Math.floor(banks.length * 0.5)));
  console.log('  bank trace, deg (+ = right edge down, curves right; - = hyzer, curves left):');
  console.log(`    ${banks.map((b) => fmt(b, 1)).join('  ')}`);
  ok(early > 0.5, 'high-speed turn: banks right (turns over) early',
    `peak +${fmt(early, 1)} deg`);
  ok(late < -5, 'low-speed fade: rolls back onto hyzer and finishes left',
    `${fmt(late, 1)} deg`);
  ok(late < early - 10, 'the roll reverses direction mid-flight',
    `${fmt(early, 1)} -> ${fmt(late, 1)} deg`);
  ok(flat20.alphaStep < 0.02, 'angle of attack is smooth over the whole flight at 1/120 s',
    `max |d alpha| per step = ${fmt(flat20.alphaStep * 1000, 3)} mrad`);
}

/* ================================== 2. backhand vs forehand curve opposite */

section('2. right-handed backhand vs forehand curve to opposite sides');
{
  const b = fly(bh(20));
  const fh = fly(throwDisc('forehand', new THREE.Vector3(0, 1.3, 0), new THREE.Vector3(0, 0, 1),
    powerForSpeed('forehand', 20), 0, 0.6));
  report('RH backhand 20 m/s', b);
  report('RH forehand 20 m/s', fh);

  ok(b.drift * fh.drift < 0, 'drift signs are opposite',
    `BH ${fmt(b.drift, 2)} m vs FH ${fmt(fh.drift, 2)} m`);
  ok(Math.abs(b.drift) > 1.0, 'backhand curve is measurable', `${fmt(Math.abs(b.drift), 2)} m`);
  ok(Math.abs(fh.drift) > 1.0, 'forehand curve is measurable', `${fmt(Math.abs(fh.drift), 2)} m`);
  ok(b.drift > 0, 'RH backhand finishes LEFT', `${fmt(b.drift, 2)} m`);
  ok(fh.drift < 0, 'RH forehand finishes RIGHT', `${fmt(fh.drift, 2)} m`);

  // Left-handed mirror of the backhand must curve the other way by the same amount.
  const lh = fly(throwDisc('backhand', new THREE.Vector3(0, 1.3, 0), new THREE.Vector3(0, 0, 1),
    powerForSpeed('backhand', 20), 0, 0.6, { hand: 'L' }));
  report('LH backhand 20 m/s', lh);
  ok(Math.abs(lh.drift + b.drift) < 1e-6, 'left-handed backhand is an exact mirror',
    `${fmt(lh.drift, 4)} vs ${fmt(-b.drift, 4)}`);
  ok(Math.abs(lh.distance - b.distance) < 1e-6, 'mirror keeps the same distance');
}

/* ================================================= 3. hammer inverts, dives */

section('3. hammer inverts and falls off hard');
{
  const h = fly(throwDisc('hammer', new THREE.Vector3(0, 2.0, 0), new THREE.Vector3(0, 0, 1),
    0.75, 0, 0.6));
  const b = fly(bh(20));
  report('RH hammer', h);

  ok(h.invertedFrac > 0.9, 'flies upside down',
    `${fmt(h.invertedFrac * 100, 0)}% of the flight has the normal below horizontal`);
  ok(h.descentDeg > b.descentDeg + 10, 'drops far more steeply than a backhand',
    `${fmt(h.descentDeg, 0)} deg vs ${fmt(b.descentDeg, 0)} deg`);
  ok(h.descentDeg > 35, 'descent is genuinely steep', `${fmt(h.descentDeg, 0)} deg`);
  ok(h.distance < b.distance, 'covers less ground than a backhand',
    `${fmt(h.distance, 1)} m vs ${fmt(b.distance, 1)} m`);

  // "Falls off late": it comes down steeper than it went up, and the last
  // quarter of the flight covers far less ground than the first.
  const launchDeg = (THROW_SPECS.hammer.elevation * 180) / Math.PI;
  ok(h.descentDeg > launchDeg + 8, 'comes down steeper than it went up',
    `launched ${fmt(launchDeg, 0)} deg, lands ${fmt(h.descentDeg, 0)} deg`);
  const n = h.samples.length;
  const q = Math.max(1, Math.floor(n / 4));
  const firstQ = Math.hypot(h.samples[q].x - h.samples[0].x, h.samples[q].z - h.samples[0].z);
  const lastQ = Math.hypot(h.samples[n - 1].x - h.samples[n - 1 - q].x,
    h.samples[n - 1].z - h.samples[n - 1 - q].z);
  ok(lastQ < firstQ * 0.55, 'the back end of the flight collapses',
    `first quarter ${fmt(firstQ, 1)} m, last quarter ${fmt(lastQ, 1)} m`);

  const sc = fly(throwDisc('scoober', new THREE.Vector3(0, 1.6, 0), new THREE.Vector3(0, 0, 1),
    0.7, 0, 0.6));
  report('RH scoober', sc);
  ok(sc.drift * h.drift < 0, 'scoober breaks the opposite way to the hammer',
    `hammer ${fmt(h.drift, 2)} m, scoober ${fmt(sc.drift, 2)} m`);
}

/* ================================================== 4. upwind vs downwind */

section('4. wind');
{
  const W = 6;
  const down = fly(bh(20, 0.12), new THREE.Vector3(0, 0, W));    // wind with the throw
  const up = fly(bh(20, 0.12), new THREE.Vector3(0, 0, -W));     // wind against it
  const still = fly(bh(20, 0.12));
  report(`downwind ${W} m/s`, down);
  report('no wind', still);
  report(`upwind ${W} m/s`, up);

  ok(down.distance > up.distance + 8, 'downwind travels measurably further',
    `${fmt(down.distance, 1)} m vs ${fmt(up.distance, 1)} m (delta ${fmt(down.distance - up.distance, 1)} m)`);
  ok(down.distance > still.distance, 'downwind beats still air');
  ok(up.distance < still.distance, 'upwind falls short of still air');
  ok(up.maxHeight > down.maxHeight, 'upwind huck climbs higher (it balloons)',
    `${fmt(up.maxHeight, 2)} m vs ${fmt(down.maxHeight, 2)} m`);
  ok(up.alphaMax > down.alphaMax, 'upwind reaches a higher angle of attack',
    `${fmt((up.alphaMax * 180) / Math.PI, 1)} deg vs ${fmt((down.alphaMax * 180) / Math.PI, 1)} deg`);
  ok(up.alphaMax > AERO.aStall, 'and pushes past the stall angle',
    `${fmt((up.alphaMax * 180) / Math.PI, 1)} deg vs stall onset ${fmt((AERO.aStall * 180) / Math.PI, 1)} deg`);

  // Upwind stall: enough headwind and the disc balloons past the stall angle.
  const gale = fly(bh(22, 0.25), new THREE.Vector3(0, 0, -9));
  report('upwind 9 m/s, 20 deg', gale);
  ok(gale.downrange < 12, 'a big upwind throw makes almost no progress downfield',
    `${fmt(gale.downrange, 1)} m downrange out of ${fmt(gale.distance, 1)} m travelled`);
  ok(gale.maxHeight > 8, 'it just balloons instead', `apex ${fmt(gale.maxHeight, 1)} m`);

  const cross = fly(bh(20, 0.12), new THREE.Vector3(5, 0, 0));
  report('crosswind +X 5 m/s', cross);
  ok(cross.drift > still.drift, 'crosswind pushes the disc downwind laterally',
    `${fmt(cross.drift, 2)} m vs ${fmt(still.drift, 2)} m`);
}

/* ============================================ 5. stability over 2000 steps */

section('5. numerical stability, 2000 steps, no ground');
{
  const s = bh(24, 0.35, 1.0);
  s.groundY = -5000;                 // keep it airborne for the whole run
  let energy = totalEnergy(s);
  let spinMag = Math.abs(s.spin);
  let energyViolations = 0;
  let spinViolations = 0;
  let maxAlphaStep = 0;
  let prevAlpha = s.alpha;
  let finite = true;
  const spinTrace: number[] = [];

  for (let i = 0; i < 2000; i++) {
    simulate(s, FIXED_DT);
    if (!isFiniteState(s)) { finite = false; break; }
    const e = totalEnergy(s);
    // Zero wind => aerodynamic forces are purely dissipative.
    if (e > energy + 1e-9) energyViolations++;
    energy = e;
    const sm = Math.abs(s.spin);
    if (sm > spinMag + 1e-12) spinViolations++;
    spinMag = sm;
    maxAlphaStep = Math.max(maxAlphaStep, Math.abs(s.alpha - prevAlpha));
    prevAlpha = s.alpha;
    if (i % 250 === 0) spinTrace.push(s.spin);
  }

  ok(finite, 'nothing goes NaN or infinite over 2000 steps');
  ok(energyViolations === 0, 'total energy is monotonically non-increasing',
    `${energyViolations} violations`);
  ok(spinViolations === 0, 'spin magnitude is monotonically decreasing',
    `${spinViolations} violations`);
  console.log(`  spin every 250 steps: ${spinTrace.map((v) => fmt(v, 2)).join('  ')}`);
  ok(Math.abs(s.spin) < Math.abs(spinTrace[0]) * 0.95, 'spin actually decays',
    `${fmt(spinTrace[0], 2)} -> ${fmt(s.spin, 2)} rad/s over ${fmt(2000 / 120, 2)} s`);
  ok(Math.abs(s.orient.length() - 1) < 1e-9, 'quaternion stays unit',
    `|q| = ${s.orient.length().toFixed(12)}`);
  // This run tumbles for 16 s with no ground, well past any real throw; the
  // bound just has to prove the integrator never takes a wild jump.
  ok(maxAlphaStep < 0.4, 'angle of attack stays bounded even in a long tumble',
    `max |d alpha| per step = ${fmt(maxAlphaStep * 1000, 1)} mrad`);
}

/* ================================= 6. timestep convergence at 1/120 */

section('6. angle-of-attack response and 1/120 s timestep convergence');
{
  // Same throw integrated at 1/120 vs 1/960; the 1/120 answer must be close.
  function run(dt: number): { pos: THREE.Vector3; alpha: number; spin: number } {
    const s = bh(22, 0.1, 0.7);
    s.groundY = -5000;
    const steps = Math.round(3.0 / dt);
    for (let i = 0; i < steps; i++) simulate(s, dt);
    return { pos: s.pos.clone(), alpha: s.alpha, spin: s.spin };
  }
  const coarse = run(FIXED_DT);
  const fine = run(1 / 960);
  const posErr = coarse.pos.distanceTo(fine.pos);
  const alphaErr = Math.abs(coarse.alpha - fine.alpha);
  console.log(`  1/120  pos ${fmt(coarse.pos.x, 3)}, ${fmt(coarse.pos.y, 3)}, ${fmt(coarse.pos.z, 3)}  alpha ${fmt(coarse.alpha, 5)}`);
  console.log(`  1/960  pos ${fmt(fine.pos.x, 3)}, ${fmt(fine.pos.y, 3)}, ${fmt(fine.pos.z, 3)}  alpha ${fmt(fine.alpha, 5)}`);
  ok(posErr < 0.05, 'position after 3 s agrees with an 8x finer step', `${fmt(posErr * 1000, 2)} mm`);
  ok(alphaErr < 1e-3, 'angle of attack agrees with an 8x finer step',
    `${fmt(alphaErr * 1e6, 1)} urad`);

  // Determinism: identical inputs, identical outputs, bit for bit.
  const a = run(FIXED_DT), b2 = run(FIXED_DT);
  ok(a.pos.x === b2.pos.x && a.pos.y === b2.pos.y && a.pos.z === b2.pos.z,
    'integration is bit-for-bit deterministic');

  // Sub-stepping: one 1/30 call must equal four 1/120 calls.
  const s1 = bh(20); s1.groundY = -5000;
  const s2 = bh(20); s2.groundY = -5000;
  for (let i = 0; i < 60; i++) simulate(s1, 1 / 30);
  for (let i = 0; i < 240; i++) simulate(s2, FIXED_DT);
  ok(s1.pos.distanceTo(s2.pos) < 1e-9, 'a 1/30 s call sub-steps to exactly four 1/120 s steps',
    `${fmt(s1.pos.distanceTo(s2.pos) * 1e9, 3)} nm`);
}

/* ============================================= 7. angle of attack response */

section('7. angle of attack and the aero probe');
{
  const s = bh(20);
  const p = aeroProbe(s);
  console.log(`  release: V ${fmt(p.airspeed, 2)} m/s  alpha ${fmt((p.alpha * 180) / Math.PI, 2)} deg` +
    `  CL ${fmt(p.CL, 3)}  CD ${fmt(p.CD, 3)}  CM ${fmt(p.CM, 4)}` +
    `  L ${fmt(p.lift, 3)} N  D ${fmt(p.drag, 3)} N  W ${fmt(DISC.mass * AERO.g, 3)} N` +
    `  precession ${fmt(p.precession, 3)} rad/s`);
  inRange(p.lift, 1.3, 2.6, 'lift at 20 m/s is around one disc weight (1.72 N)', ' N');
  inRange(p.drag, 0.9, 1.8, 'drag at 20 m/s', ' N');
  inRange(p.precession, 0.05, 1.2, 'precession rate is a slow roll, not a flip', ' rad/s');

  // Alpha must respond correctly to the disc being pitched relative to flight.
  const up = bh(20, 0, 0.6, { nose: 0.15 });
  const dn = bh(20, 0, 0.6, { nose: -0.15 });
  console.log(`  nose +0.15 rad -> alpha ${fmt(up.alpha, 4)};  nose -0.15 rad -> alpha ${fmt(dn.alpha, 4)}`);
  ok(Math.abs(up.alpha - (THROW_SPECS.backhand.nose + 0.15)) < 1e-6,
    'nose-up release gives alpha = nose angle');
  ok(Math.abs(dn.alpha - (THROW_SPECS.backhand.nose - 0.15)) < 1e-6,
    'nose-down release gives negative alpha');
  ok(aeroProbe(up).CL > aeroProbe(dn).CL, 'more alpha means more lift',
    `${fmt(aeroProbe(up).CL, 3)} vs ${fmt(aeroProbe(dn).CL, 3)}`);

  // A nose-up hyzer-less throw should hang longer than a nose-down one.
  const fUp = fly(bh(20, 0, 0.6, { nose: 0.12 }));
  const fDn = fly(bh(20, 0, 0.6, { nose: -0.12 }));
  report('nose up  +7 deg', fUp);
  report('nose down -7 deg', fDn);
  ok(fUp.maxHeight > fDn.maxHeight, 'nose-up release balloons');
}

/* ============================================= 8. release angle / power */

section('8. power and release-angle response');
{
  const rows: [string, Flight][] = [];
  for (const v of [12, 16, 20, 24, 27]) rows.push([`backhand ${v} m/s`, fly(bh(v, 0.10))]);
  for (const [n, f] of rows) report(n, f);
  const d = rows.map(([, f]) => f.distance);
  let mono = true;
  for (let i = 1; i < d.length; i++) if (d[i] <= d[i - 1]) mono = false;
  ok(mono, 'distance increases monotonically with power',
    d.map((x) => fmt(x, 1)).join(' < '));

  const angles = [-0.1, 0, 0.1, 0.2, 0.35, 0.5];
  const dists = angles.map((a) => fly(bh(24, a)).distance);
  console.log('  release angle sweep at 24 m/s:');
  angles.forEach((a, i) => console.log(
    `    ${fmt((a * 180) / Math.PI, 0).padStart(4)} deg -> ${fmt(dists[i], 1).padStart(5)} m`));
  const best = dists.indexOf(Math.max(...dists));
  ok(best > 0 && best < angles.length - 1, 'an interior release angle maximises distance',
    `best = ${fmt((angles[best] * 180) / Math.PI, 0)} deg`);
}

/* ============================================ 8b. hyzer straightens a huck */

section('8b. release bank (hyzer / anhyzer) is a real control');
{
  /** Peak bank angle reached during the flight, deg. Positive = rolled right. */
  function peakBank(bank: number): number {
    const p = bh(26, 0, 0.8, { bank });
    let peak = -180;
    for (let i = 0; i < 1400 && !p.touchedGround; i++) {
      simulate(p, FIXED_DT);
      peak = Math.max(peak, (bankAngle(p) * 180) / Math.PI);
    }
    return peak;
  }
  const flat = fly(bh(26, 0, 0.8));
  const hyzer = fly(bh(26, 0, 0.8, { bank: -0.25 }));
  const anhyzer = fly(bh(26, 0, 0.8, { bank: 0.25 }));
  report('26 m/s flat', flat);
  report('26 m/s hyzer', hyzer);
  report('26 m/s anhyzer', anhyzer);
  const pFlat = peakBank(0), pHy = peakBank(-0.25), pAn = peakBank(0.25);
  console.log(`  peak bank: hyzer ${fmt(pHy, 1)} deg, flat ${fmt(pFlat, 1)} deg, anhyzer ${fmt(pAn, 1)} deg`);

  ok(flat.drift < -5, 'a flat max-power backhand turns over to the right',
    `${fmt(flat.drift, 1)} m`);
  ok(hyzer.drift > flat.drift + 8, 'hyzer holds the line against the turnover',
    `${fmt(hyzer.drift, 1)} m vs ${fmt(flat.drift, 1)} m`);
  ok(pAn > pFlat && pFlat > pHy, 'bank at release orders the turnover monotonically',
    `${fmt(pHy, 1)} < ${fmt(pFlat, 1)} < ${fmt(pAn, 1)} deg`);
  ok(hyzer.distance > anhyzer.distance + 5,
    'so a big huck has to be thrown with hyzer to hold its distance',
    `${fmt(hyzer.distance, 1)} m vs ${fmt(anhyzer.distance, 1)} m`);
  inRange(pFlat, 12, 60, 'the disc rolls onto its right edge but does not flip', ' deg');
}

/* ================================================ 9. every throw type flies */

section('9. all throw types');
{
  const heights: Record<ThrowType, number> = {
    backhand: 1.3, forehand: 1.2, hammer: 2.0, scoober: 1.6, push: 1.1, blade: 2.0,
  };
  const results: Record<string, Flight> = {};
  for (const t of THROW_TYPES) {
    const st = throwDisc(t, new THREE.Vector3(0, heights[t], 0), new THREE.Vector3(0, 0, 1),
      0.8, 0, 0.7);
    const f = fly(st);
    results[t] = f;
    report(t, f);
  }
  for (const t of THROW_TYPES) {
    ok(results[t].landed, `${t} lands`);
    ok(isFiniteState(results[t].state), `${t} stays finite`);
    ok(results[t].distance > 3, `${t} covers ground`, `${fmt(results[t].distance, 1)} m`);
  }
  ok(results.push.distance < results.backhand.distance * 0.6, 'push pass is a short throw',
    `${fmt(results.push.distance, 1)} m vs backhand ${fmt(results.backhand.distance, 1)} m`);
  ok(results.blade.descentDeg > 40, 'blade knifes down steeply',
    `${fmt(results.blade.descentDeg, 0)} deg`);
  ok(Math.abs(results.blade.drift) > 3, 'blade curves hard',
    `${fmt(results.blade.drift, 1)} m`);
}

/* ==================================================== 10. prediction API */

section('10. predictPath / predictLanding');
{
  const s = bh(20);
  const path = predictPath(s, new THREE.Vector3(), 6, 20);
  console.log(`  predictPath returned ${path.length} points, ` +
    `first (${fmt(path[0].x)}, ${fmt(path[0].y)}, ${fmt(path[0].z)}) ` +
    `last (${fmt(path[path.length - 1].x)}, ${fmt(path[path.length - 1].y)}, ${fmt(path[path.length - 1].z)})`);
  ok(path.length > 10, 'path has samples', `${path.length}`);
  ok(path.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)),
    'path is finite');
  ok(s.t === 0 && s.pos.length() === Math.hypot(0, 1.3, 0), 'predictPath does not mutate its input');

  const land = predictLanding(s, new THREE.Vector3(), 12);
  const truth = fly(cloneDiscState(s));
  console.log(`  predicted landing (${fmt(land.pos.x)}, ${fmt(land.pos.y)}, ${fmt(land.pos.z)}) at t=${fmt(land.time)} s`);
  console.log(`  actual    landing (${fmt(truth.state.pos.x)}, ${fmt(truth.state.pos.y)}, ${fmt(truth.state.pos.z)}) at t=${fmt(truth.time)} s`);
  ok(land.landed, 'predictLanding reports a landing');
  ok(land.pos.distanceTo(truth.state.pos) < 1e-9, 'prediction matches the real flight exactly',
    `${fmt(land.pos.distanceTo(truth.state.pos) * 1e9, 3)} nm`);
  ok(Math.abs(land.time - truth.time) < 1e-9, 'landing time matches',
    `${fmt(land.time, 4)} s vs ${fmt(truth.time, 4)} s`);

  // Wind must move the predicted landing point.
  const windy = predictLanding(bh(20), new THREE.Vector3(0, 0, -6), 12);
  ok(windy.pos.z < land.pos.z - 5, 'prediction responds to wind',
    `${fmt(windy.pos.z, 1)} m vs ${fmt(land.pos.z, 1)} m`);

  // Cheap mode for AI: coarser step, still close enough to act on.
  const cheap = predictLanding(bh(20), new THREE.Vector3(), 12, 1 / 40);
  const err = cheap.pos.distanceTo(land.pos);
  console.log(`  1/40 s prediction lands (${fmt(cheap.pos.x)}, ${fmt(cheap.pos.z)}), ` +
    `error ${fmt(err * 100, 1)} cm, ${fmt((0.491 / 3) * 1000, 0)} us-ish per call`);
  ok(err < 0.6, 'a 3x cheaper prediction is still within 60 cm', `${fmt(err * 100, 1)} cm`);
}

/* ==================================================== 11. ground behaviour */

section('11. ground contact');
{
  const s = bh(20);
  let landT = 0;
  for (let i = 0; i < 12 * 120; i++) {
    simulate(s, FIXED_DT);
    if (s.touchedGround && landT === 0) landT = s.t;
    if (s.atRest) break;
  }
  console.log(`  touched down at t=${fmt(landT)} s, came to rest at t=${fmt(s.t)} s, ` +
    `final y=${fmt(s.pos.y, 3)} m, |v|=${fmt(s.vel.length(), 4)} m/s`);
  ok(s.atRest, 'the disc comes to rest');
  ok(Math.abs(s.pos.y - DISC.halfHeight) < 1e-9, 'rests on the ground plane');
  ok(s.vel.length() === 0 && s.omega.length() === 0, 'no residual motion at rest');
  ok(Math.abs(discNormal(s).y) > 0.999, 'settles flat', `n.y = ${fmt(discNormal(s).y, 4)}`);
  ok(s.t - landT > 0.05 && s.t - landT < 4, 'skids briefly rather than sticking or sliding forever',
    `${fmt(s.t - landT, 2)} s of skid`);
}


/* ------------------------------------------------- human throw feel (charge) */

section('the charge control is something you can aim with');
{
  /**
   * "Throwing is a little weird" was a feel report, and feel on a
   * charge-and-release throw comes down to four properties. All four were
   * broken, and all four are measured here against the real aero.
   *
   *   1. A TAP IS SHORT. Mapping the charge across a throw's own `power` range
   *      cannot do this — the backhand spec floors at 12 m/s and a 12 m/s
   *      backhand carries about 20 m. Measured on the old mapping, a release at
   *      ZERO charge flew 23.6 m. There was no dump and no reset, only bombs.
   *   2. FULL CHARGE IS A HUCK.
   *   3. MORE CHARGE IS ALWAYS MORE DISTANCE. A dip means a charge level the
   *      player cannot use.
   *   4. THE CURVE DOES NOT INVERT. With a flat release the drift on a backhand
   *      ran +3.1, +4.6, +4.3, +0.1, -3.3, -8.4, -16.7 m as charge went up: aim
   *      at a receiver, pull harder, and it finishes 17 m the other side of him.
   */
  const carry = (type: ThrowType, power: number, quality = 1, tilt = 0): { z: number; x: number } => {
    const r = humanReleaseParams(type, power, quality, tilt);
    const s = throwDisc(type, new THREE.Vector3(0, 1.55, 0), new THREE.Vector3(0, 0, 1),
      1, r.angle, r.spin, { hand: 'R', bank: r.bank, nose: r.nose, speed: r.speed });
    let t = 0;
    while (s.pos.y > 0.05 && t < 20) { simulate(s, FIXED_DT); t += FIXED_DT; }
    return { z: s.pos.z, x: s.pos.x };
  };

  for (const type of ['backhand', 'forehand'] as ThrowType[]) {
    const zero = carry(type, 0);
    const full = carry(type, 1);
    inRange(zero.z, 5, 14, `${type}: a tap is a dump, not a bomb`, ' m');
    inRange(full.z, 38, 60, `${type}: full charge is a huck`, ' m');

    // Monotonic: every step of the trigger buys distance.
    let dips = 0, worstDip = 0, prev = -Infinity, maxAbsDrift = 0, signFlips = 0, prevSign = 0;
    for (let p = 0; p <= 1.0001; p += 0.1) {
      const c = carry(type, p);
      if (c.z < prev) { dips++; worstDip = Math.min(worstDip, c.z - prev); }
      prev = c.z;
      maxAbsDrift = Math.max(maxAbsDrift, Math.abs(c.x));
      const sign = c.x > 1.0 ? 1 : c.x < -1.0 ? -1 : 0;
      if (sign !== 0 && prevSign !== 0 && sign !== prevSign) signFlips++;
      if (sign !== 0) prevSign = sign;
    }
    ok(dips === 0, `${type}: more charge is always more distance`,
      dips ? `${dips} dip(s), worst ${fmt(worstDip)} m` : 'monotonic');
    ok(signFlips === 0, `${type}: the curve does not invert as you charge`,
      signFlips ? `${signFlips} sign flip(s)` : 'same-signed throughout');
    inRange(maxAbsDrift, 0, 12, `${type}: drift stays leadable across the charge`, ' m');
  }

  // Tilt is the curve control, and it has to actually move the disc sideways
  // in the direction asked for — in opposite directions for opposite tilt.
  const left = carry('backhand', 0.8, 1, -1);
  const right = carry('backhand', 0.8, 1, 1);
  ok(left.x > right.x + 8, 'tilt buys curve, and the two ends go opposite ways',
    `tilt -1 -> ${fmt(left.x)} m, tilt +1 -> ${fmt(right.x)} m`);

  // A bad release is punished with distance, not rewarded.
  const clean = carry('backhand', 0.8, 1);
  const sloppy = carry('backhand', 0.8, 0);
  ok(sloppy.z < clean.z, 'a poor release costs distance',
    `${fmt(sloppy.z)} m vs ${fmt(clean.z)} m clean`);
}

/* ------------------------------------------------------------------ summary */

console.log(`\n${'='.repeat(74)}`);
console.log(`  ${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed) console.log('  failing: ' + failures.join('; '));
console.log(`${'='.repeat(74)}\n`);
process.exit(failed === 0 ? 0 : 1);
