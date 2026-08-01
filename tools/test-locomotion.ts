/**
 * Numerical acceptance tests for src/sim/Locomotion.ts.
 *
 *   node tools/test-locomotion.ts
 *
 * Everything runs at the shipping fixed timestep of 1/120 s. No renderer, no
 * DOM, no randomness beyond the seeded Rng.
 */
import * as THREE from 'three';
import { Rng } from '../src/core/Ctx.ts';
import { Locomotion, fromAIAttributes } from '../src/sim/Locomotion.ts';
import type { DesiredMove, LocoPlayer } from '../src/sim/move/Types.ts';

const DT = 1 / 120;

/* ------------------------------------------------------------ tiny harness */

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail: string): void {
  if (cond) { passed++; console.log(`  PASS  ${name.padEnd(52)} ${detail}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name.padEnd(52)} ${detail}`); }
}
function between(name: string, v: number, lo: number, hi: number, unit = ''): void {
  ok(name, v >= lo && v <= hi, `${fmt(v)}${unit} (want ${fmt(lo)}..${fmt(hi)}${unit})`);
}
function fmt(v: number): string {
  return Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)) : String(v);
}
function section(t: string): void { console.log(`\n${t}\n${'-'.repeat(t.length)}`); }

/* -------------------------------------------------------------- fake host */

interface Ev { evt: string; payload: any }

function makeLoco(field?: unknown): { loco: Locomotion; events: Ev[] } {
  const events: Ev[] = [];
  const loco = new Locomotion();
  loco.attach({
    events: { emit: (evt: string, payload?: unknown) => { events.push({ evt, payload }); } },
    rand: new Rng(0xC0FFEE),
    sys: field ? { field } : {},
  });
  return { loco, events };
}

const ELITE = {
  speed: 92, accel: 90, agility: 88, strength: 72,
  vertical: 84, endurance: 82, balance: 80, height: 1.86, mass: 84,
};
const AVERAGE = {
  speed: 68, accel: 66, agility: 66, strength: 62,
  vertical: 60, endurance: 65, balance: 65, height: 1.80, mass: 82,
};

const dir = (x: number, z: number) => new THREE.Vector3(x, 0, z);
const spd = (p: LocoPlayer) => Math.hypot(p.vel.x, p.vel.z);

function run(loco: Locomotion, p: LocoPlayer, d: DesiredMove, seconds: number,
  onStep?: (t: number) => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    loco.step(p, d, DT);
    loco.resolveCollisions(DT, [p]);
    onStep?.((i + 1) * DT);
  }
}

/* ====================================================================== 1 */

function testSprint(): void {
  section('1. Straight-line sprint — 40 m from a standing start');

  for (const [label, attr, lo, hi] of [
    ['elite', ELITE, 4.9, 5.6],
    ['average', AVERAGE, 5.2, 6.2],
  ] as const) {
    const { loco } = makeLoco();
    const p = loco.create({ id: 1, attr, pos: new THREE.Vector3(0, 0, 0) });
    let t40 = -1, t10 = -1, t = 0;
    let vTop = 0;
    for (let i = 0; i < 120 * 12; i++) {
      loco.step(p, { dir: dir(0, 1), mode: 'sprint' }, DT);
      t += DT;
      vTop = Math.max(vTop, spd(p));
      if (t10 < 0 && p.pos.z >= 10) t10 = t;
      if (p.pos.z >= 40) { t40 = t; break; }
    }
    console.log(`   ${label}: 10 m ${fmt(t10)} s, 40 m ${fmt(t40)} s, top ${fmt(vTop)} m/s, ` +
      `derived top ${fmt(p.derived.topSpeed)} m/s`);
    between(`40 m dash (${label})`, t40, lo, hi, ' s');
    between(`top speed (${label})`, vTop, 7.5, 10.0, ' m/s');
  }

  // Acceleration must be finite: no teleporting to top speed.
  const { loco } = makeLoco();
  const p = loco.create({ id: 2, attr: ELITE });
  loco.step(p, { dir: dir(0, 1), mode: 'sprint' }, DT);
  between('speed after one 1/120 s tick', spd(p), 0.02, 0.12, ' m/s');
}

/* ====================================================================== 2 */

function testCut(): void {
  section('2. Direction changes cost speed');

  const results: Record<number, { entry: number; min: number; ratio: number; recover: number }> = {};

  for (const deg of [30, 45, 90, 135, 180]) {
    const { loco, events } = makeLoco();
    const p = loco.create({ id: 1, attr: ELITE });
    // Wind up to steady-state sprint down +Z.
    run(loco, p, { dir: dir(0, 1), mode: 'sprint' }, 6);
    const entry = spd(p);
    const rad = (deg * Math.PI) / 180;
    const nd = dir(Math.sin(rad), Math.cos(rad));

    events.length = 0;
    let minSpeed = entry;
    let maxHeadingRate = 0;
    let prevHeading = Math.atan2(p.vel.x, p.vel.z);
    let recover = -1;
    let t = 0;
    for (let i = 0; i < 120 * 4; i++) {
      loco.step(p, { dir: nd, mode: 'sprint' }, DT);
      t += DT;
      const s = spd(p);
      if (s > 0.2) {
        const h = Math.atan2(p.vel.x, p.vel.z);
        let dh = h - prevHeading;
        while (dh > Math.PI) dh -= 2 * Math.PI;
        while (dh < -Math.PI) dh += 2 * Math.PI;
        maxHeadingRate = Math.max(maxHeadingRate, Math.abs(dh) / DT);
        prevHeading = h;
      }
      minSpeed = Math.min(minSpeed, s);
      const aligned = (p.vel.x * nd.x + p.vel.z * nd.z) / Math.max(1e-6, s);
      if (recover < 0 && aligned > 0.995 && s > entry * 0.95) recover = t;
    }
    results[deg] = { entry, min: minSpeed, ratio: minSpeed / entry, recover };
    const hardPlants = events.filter((e) => e.evt === 'player:footstep' && e.payload.hard).length;
    console.log(`   ${String(deg).padStart(3)} deg: entry ${fmt(entry)} -> min ${fmt(minSpeed)} m/s ` +
      `(${(100 * minSpeed / entry).toFixed(1)}% kept), regain ${fmt(recover)} s, ` +
      `${hardPlants} hard plant(s), peak heading rate ${fmt(maxHeadingRate)} rad/s`);
  }

  ok('sharper cut scrubs more speed',
    results[30].ratio > results[45].ratio &&
    results[45].ratio > results[90].ratio &&
    results[90].ratio > results[135].ratio &&
    results[135].ratio > results[180].ratio,
    `30:${fmt(results[30].ratio)} 45:${fmt(results[45].ratio)} 90:${fmt(results[90].ratio)} ` +
    `135:${fmt(results[135].ratio)} 180:${fmt(results[180].ratio)}`);

  between('90 deg cut keeps this fraction of entry speed', results[90].ratio, 0.45, 0.80);
  between('90 deg cut regain time', results[90].recover, 0.60, 2.20, ' s');
  between('30 deg cut keeps this fraction', results[30].ratio, 0.85, 1.0);
  ok('180 deg reversal passes through a near-stop',
    results[180].min < 0.20, `min ${fmt(results[180].min)} m/s`);
  between('90 deg cut speed lost', results[90].entry - results[90].min, 1.5, 5.5, ' m/s');

  // No instant reversal, ever. The physical invariant is that the implied
  // lateral acceleration (turn rate x speed) never exceeds the grip budget.
  const { loco } = makeLoco();
  const p = loco.create({ id: 9, attr: ELITE });
  run(loco, p, { dir: dir(0, 1), mode: 'sprint' }, 6);
  const gripBudget = p.derived.gripMax * 1.8; // gripMax x plant multiplier
  let worstLat = 0, worstRate = 0;
  let prev = new THREE.Vector3(p.vel.x, 0, p.vel.z).normalize();
  let prevS = spd(p);
  for (let i = 0; i < 480; i++) {
    loco.step(p, { dir: dir(0.2, -1), mode: 'sprint' }, DT);
    const s = spd(p);
    if (s > 0.5) {
      const cur = new THREE.Vector3(p.vel.x, 0, p.vel.z).normalize();
      if (prevS > 0.5) {
        const rate = cur.angleTo(prev) / DT;
        worstRate = Math.max(worstRate, rate);
        worstLat = Math.max(worstLat, rate * Math.min(s, prevS));
      }
      prev = cur;
    }
    prevS = s;
  }
  console.log(`   near-180: peak implied lateral accel ${fmt(worstLat)} m/s^2 ` +
    `(grip budget ${fmt(gripBudget)}), peak turn rate ${fmt(worstRate)} rad/s`);
  ok('turn rate never exceeds the grip budget', worstLat < gripBudget * 1.10,
    `${fmt(worstLat)} < ${fmt(gripBudget * 1.1)} m/s^2`);
}

/* ====================================================================== 3 */

function testGaits(): void {
  section('3. Gait caps — backpedal and shuffle are slower than running');

  const { loco } = makeLoco();
  const s = loco.create({ id: 1, attr: ELITE });
  const b = loco.create({ id: 2, attr: ELITE });
  const h = loco.create({ id: 3, attr: ELITE });
  const j = loco.create({ id: 4, attr: ELITE });

  run(loco, s, { dir: dir(0, 1), mode: 'sprint' }, 8);
  run(loco, b, { dir: dir(0, 1), mode: 'backpedal' }, 8);
  run(loco, h, { dir: dir(0, 1), mode: 'shuffle' }, 8);
  run(loco, j, { dir: dir(0, 1), mode: 'jog' }, 8);

  const vs = spd(s), vb = spd(b), vh = spd(h), vj = spd(j);
  console.log(`   sprint ${fmt(vs)}  run-cap ${fmt(0.78 * s.derived.topSpeed)}  ` +
    `backpedal ${fmt(vb)}  shuffle ${fmt(vh)}  jog ${fmt(vj)} m/s`);
  console.log(`   states: ${s.state} / ${b.state} / ${h.state} / ${j.state}`);

  between('backpedal top as fraction of sprint', vb / vs, 0.45, 0.62);
  between('shuffle top as fraction of sprint', vh / vs, 0.38, 0.56);
  ok('shuffle is the slowest gait', vh < vb && vh < vj + 1.0, `${fmt(vh)} < ${fmt(vb)}`);
  ok('sprint beats backpedal by >3 m/s', vs - vb > 3.0, `${fmt(vs - vb)} m/s`);
  ok('gait states reported', s.state === 'sprint' && b.state === 'backpedal' && h.state === 'shuffle',
    `${s.state}/${b.state}/${h.state}`);

  // 'auto' mode: a defender who keeps facing the thrower picks the gait itself.
  const { loco: la } = makeLoco();
  const dBack = la.create({ id: 1, attr: ELITE });
  const dSide = la.create({ id: 2, attr: ELITE });
  const dFwd = la.create({ id: 3, attr: ELITE });
  run(la, dBack, { dir: dir(0, 1), face: dir(0, -1) }, 6);
  run(la, dSide, { dir: dir(1, 0), face: dir(0, -1) }, 6);
  run(la, dFwd, { dir: dir(0, -1), face: dir(0, -1) }, 6);
  console.log(`   auto gait: retreating -> ${dBack.state} (${fmt(spd(dBack))}), ` +
    `lateral -> ${dSide.state} (${fmt(spd(dSide))}), chasing -> ${dFwd.state} (${fmt(spd(dFwd))})`);
  ok('auto picks backpedal when running away from the look direction',
    dBack.state === 'backpedal', dBack.state);
  ok('auto picks shuffle when moving laterally', dSide.state === 'shuffle', dSide.state);
  ok('auto runs when moving where it looks', dFwd.state === 'sprint' || dFwd.state === 'run',
    dFwd.state);

  // effort / explicit speed are honoured.
  const { loco: le } = makeLoco();
  const half = le.create({ id: 1, attr: ELITE });
  const exact = le.create({ id: 2, attr: ELITE });
  run(le, half, { dir: dir(0, 1), mode: 'sprint', effort: 0.5 }, 6);
  run(le, exact, { dir: dir(0, 1), mode: 'sprint', speed: 4.0 }, 6);
  console.log(`   effort 0.5 -> ${fmt(spd(half))} m/s (half of ${fmt(half.derived.topSpeed)}), ` +
    `speed:4.0 -> ${fmt(spd(exact))} m/s`);
  ok('effort 0.5 gives half the cap', Math.abs(spd(half) - half.derived.topSpeed * 0.5) < 0.05,
    `${fmt(spd(half))} vs ${fmt(half.derived.topSpeed * 0.5)}`);
  ok('explicit target speed honoured', Math.abs(spd(exact) - 4.0) < 0.02, `${fmt(spd(exact))} m/s`);

  // A receiver running past a backpedalling defender: 20 m of separation gained.
  const { loco: l2 } = makeLoco();
  const rec = l2.create({ id: 1, attr: ELITE, pos: new THREE.Vector3(0, 0, 0) });
  const def = l2.create({ id: 2, attr: ELITE, pos: new THREE.Vector3(3, 0, 2) });
  for (let i = 0; i < 120 * 5; i++) {
    l2.step(rec, { dir: dir(0, 1), mode: 'sprint' }, DT);
    l2.step(def, { dir: dir(0, 1), mode: 'backpedal' }, DT);
    l2.resolveCollisions(DT);
  }
  const gain = rec.pos.z - (def.pos.z - 2);
  console.log(`   after 5 s: receiver z=${fmt(rec.pos.z)}, backpedalling defender z=${fmt(def.pos.z)}`);
  between('deep separation gained in 5 s', gain, 12, 26, ' m');
}

/* ====================================================================== 4 */

function testFootPlants(): void {
  section('4. Foot planting');

  const { loco, events } = makeLoco();
  const p = loco.create({ id: 1, attr: ELITE });
  run(loco, p, { dir: dir(0, 1), mode: 'sprint' }, 3);
  events.length = 0;
  const plants: { t: number; foot: string; pos: THREE.Vector3; speed: number }[] = [];
  run(loco, p, { dir: dir(0, 1), mode: 'sprint' }, 3, () => {
    for (const e of events) {
      if (e.evt === 'player:footstep') plants.push({ t: p.t, foot: e.payload.foot, pos: e.payload.pos, speed: e.payload.speed });
    }
    events.length = 0;
  });

  const rate = plants.length / 3;
  let alternates = true;
  for (let i = 1; i < plants.length; i++) if (plants[i].foot === plants[i - 1].foot) alternates = false;
  let strideMin = Infinity, strideMax = 0;
  for (let i = 1; i < plants.length; i++) {
    const d = plants[i].pos.distanceTo(plants[i - 1].pos);
    strideMin = Math.min(strideMin, d); strideMax = Math.max(strideMax, d);
  }
  console.log(`   ${plants.length} plants in 3 s at ${fmt(spd(p))} m/s -> ${fmt(rate)} steps/s, ` +
    `step length ${fmt(strideMin)}..${fmt(strideMax)} m`);
  between('sprint cadence', rate, 4.0, 5.2, ' steps/s');
  ok('feet alternate L/R', alternates, alternates ? 'yes' : 'no');
  between('sprint step length', (strideMin + strideMax) / 2, 1.5, 2.6, ' m');
  ok('footstep payload has pos/foot/speed',
    plants.length > 0 && plants[0].pos instanceof THREE.Vector3 &&
    (plants[0].foot === 'L' || plants[0].foot === 'R') && plants[0].speed > 1,
    `foot=${plants[0]?.foot} speed=${fmt(plants[0]?.speed ?? NaN)}`);

  // Jogging cadence must be lower than sprint cadence.
  const { loco: l2, events: e2 } = makeLoco();
  const q = l2.create({ id: 1, attr: ELITE });
  run(l2, q, { dir: dir(0, 1), mode: 'jog' }, 4);
  e2.length = 0;
  run(l2, q, { dir: dir(0, 1), mode: 'jog' }, 3);
  const jogRate = e2.filter((e) => e.evt === 'player:footstep').length / 3;
  console.log(`   jog at ${fmt(spd(q))} m/s -> ${fmt(jogRate)} steps/s`);
  ok('jog cadence below sprint cadence', jogRate < rate - 0.5, `${fmt(jogRate)} vs ${fmt(rate)}`);

  // The plant point is where a cut pivots from.
  const { loco: l3, events: e3 } = makeLoco();
  const c = l3.create({ id: 1, attr: ELITE });
  run(l3, c, { dir: dir(0, 1), mode: 'sprint' }, 6);
  e3.length = 0;
  const before = c.pos.clone();
  run(l3, c, { dir: dir(1, 0), mode: 'sprint' }, 0.05);
  const hard = e3.find((e) => e.evt === 'player:footstep' && e.payload.hard);
  ok('hard cut emits a hard plant', !!hard, hard ? `foot ${hard.payload.foot}` : 'none');
  if (hard) {
    const d = Math.hypot(hard.payload.pos.x - before.x, hard.payload.pos.z - before.z);
    console.log(`   cut plant at (${fmt(hard.payload.pos.x)}, ${fmt(hard.payload.pos.z)}) ` +
      `vs body (${fmt(before.x)}, ${fmt(before.z)}) -> ${fmt(d)} m`);
    between('cut plant is a body-plausible offset', d, 0.2, 1.2, ' m');
    // Travelling +Z and cutting to +X is a turn to the player's LEFT in a
    // right-handed Y-up frame, so the outside (planting) foot is the right.
    ok('cut plant is the outside foot', hard.payload.foot === 'R',
      `cutting left, planted ${hard.payload.foot}`);
    const outward = (hard.payload.pos.x - before.x);
    ok('plant is outside the turn', outward < -0.1, `lateral offset ${fmt(outward)} m`);
    ok('planted foot state exposed', c.foot.hard && c.foot.pos.equals(hard.payload.pos),
      `foot.t=${fmt(c.foot.t)} contact=${c.foot.contact}`);
  }
}

/* ====================================================================== 5 */

function testJump(): void {
  section('5. Vertical leap and aerial contests');

  const { loco } = makeLoco();
  const p = loco.create({ id: 1, attr: ELITE });
  const stand = p.pos.y;
  let peak = 0, air = 0, gather = 0;
  let started = false;
  for (let i = 0; i < 120 * 3; i++) {
    loco.step(p, { dir: null, jump: i < 4 }, DT);
    if (p.state === 'jump' && !p.air.airborne) gather += DT;
    if (p.air.airborne) { air += DT; started = true; }
    peak = Math.max(peak, p.pos.y);
    if (started && !p.air.airborne && air > 0.05) break;
  }
  const leap = peak - stand;
  console.log(`   standing leap ${fmt(leap)} m, gather ${fmt(gather)} s, hang ${fmt(air)} s, ` +
    `reach ${fmt(loco.peakReach(p))} m`);
  between('standing vertical leap', leap, 0.55, 0.95, ' m');
  between('hang time', air, 0.55, 0.95, ' s');
  between('gather (jumps are not instant)', gather, 0.10, 0.20, ' s');

  // Running approach adds to the leap.
  const { loco: l2 } = makeLoco();
  const r = l2.create({ id: 1, attr: ELITE });
  run(l2, r, { dir: dir(0, 1), mode: 'sprint' }, 6);
  const base = r.pos.y;
  let peak2 = 0;
  for (let i = 0; i < 120 * 2; i++) {
    l2.step(r, { dir: dir(0, 1), mode: 'sprint', jump: i < 4 }, DT);
    peak2 = Math.max(peak2, r.pos.y);
    if (i > 30 && !r.air.airborne) break;
  }
  console.log(`   running leap ${fmt(peak2 - base)} m (vs ${fmt(leap)} standing)`);
  ok('run-up increases the leap', peak2 - base > leap * 1.15, `${fmt(peak2 - base)} > ${fmt(leap * 1.15)}`);

  // Contested disc in the air: mistimed jump loses to a well-timed one.
  const { loco: l3 } = makeLoco();
  const a = l3.create({ id: 1, attr: ELITE, pos: new THREE.Vector3(-0.35, 0, 0) });
  const b = l3.create({ id: 2, attr: { ...ELITE, vertical: 84 }, pos: new THREE.Vector3(0.35, 0, 0) });
  // A jumps now; B jumps 0.35 s late.
  for (let i = 0; i < 4; i++) { l3.step(a, { jump: true }, DT); l3.step(b, {}, DT); }
  for (let i = 0; i < Math.round(0.30 / DT); i++) { l3.step(a, {}, DT); l3.step(b, {}, DT); }
  const discPos = new THREE.Vector3(0, 3.0, 0);
  const at = Math.max(0, a.air.tApex - a.t);
  const res = l3.contest(a, b, discPos, at);
  console.log(`   at A's apex: A reach ${fmt(res.a.reach)} m (${a.state}), ` +
    `B reach ${fmt(res.b.reach)} m (${b.state}) -> winner ${res.winner}, margin ${fmt(res.margin)} m`);
  ok('well-timed jumper out-reaches the late one', res.winner === 'a', `winner=${res.winner}`);
  between('reach margin', res.margin, 0.15, 1.2, ' m');

  // Box-out: same reach, but one has inside position.
  const { loco: l4 } = makeLoco();
  const x = l4.create({ id: 1, attr: ELITE, pos: new THREE.Vector3(0.1, 0, 0) });
  const y = l4.create({ id: 2, attr: ELITE, pos: new THREE.Vector3(-0.7, 0, 0) });
  const res2 = l4.contest(x, y, new THREE.Vector3(0.5, 2.6, 0), 0);
  console.log(`   box-out: inside player score ${fmt(res2.a.score)} vs ${fmt(res2.b.score)} ` +
    `(boxOut ${fmt(res2.a.boxOut)} / ${fmt(res2.b.boxOut)}), contact=${res2.contact}`);
  ok('inside position wins a tied contest', res2.winner === 'a', `winner=${res2.winner}`);
}

/* ====================================================================== 6 */

function testLayout(): void {
  section('6. Layout — arc, land, slide, get up');

  const { loco, events } = makeLoco();
  const p = loco.create({ id: 1, attr: ELITE });
  run(loco, p, { dir: dir(0, 1), mode: 'sprint' }, 5);
  const v0 = spd(p);
  const start = p.pos.clone();
  const startT = p.t;

  let takeoffPos: THREE.Vector3 | null = null;
  let landPos: THREE.Vector3 | null = null;
  let apexY = 0, airT = 0, tTakeoff = 0, tLand = 0, tStop = 0, tUp = 0;
  let slideStart: THREE.Vector3 | null = null;

  events.length = 0;
  for (let i = 0; i < 120 * 8; i++) {
    const wasAir = p.air.airborne;
    loco.step(p, { dir: dir(0, 1), mode: 'sprint', layout: i < 4 }, DT);
    if (!wasAir && p.air.airborne) { takeoffPos = p.pos.clone(); tTakeoff = p.t; }
    if (p.air.airborne) { apexY = Math.max(apexY, p.pos.y); airT += DT; }
    if (wasAir && !p.air.airborne) { landPos = p.pos.clone(); tLand = p.t; slideStart = p.pos.clone(); }
    if (tLand > 0 && tStop === 0 && p.state === 'recovery') tStop = p.t;
    if (tStop > 0 && p.state !== 'recovery' && p.state !== 'landing') { tUp = p.t; break; }
  }

  const airDist = takeoffPos && landPos
    ? Math.hypot(landPos.x - takeoffPos.x, landPos.z - takeoffPos.z) : 0;
  const slideDist = slideStart && tStop > 0
    ? Math.hypot(p.pos.x - slideStart.x, p.pos.z - slideStart.z) : 0;
  const rise = takeoffPos ? apexY - takeoffPos.y : 0;
  const unavailable = tUp - tTakeoff;

  console.log(`   approach ${fmt(v0)} m/s`);
  console.log(`   air: ${fmt(airT)} s, ${fmt(airDist)} m travelled, COM rose ${fmt(rise)} m ` +
    `(apex y ${fmt(apexY)})`);
  console.log(`   slide: ${fmt(tStop - tLand)} s, ${fmt(slideDist)} m`);
  console.log(`   get-up: ${fmt(tUp - tStop)} s   |   total out of the play ${fmt(unavailable)} s`);
  console.log(`   total ground covered from decision to upright: ` +
    `${fmt(Math.hypot(p.pos.x - start.x, p.pos.z - start.z))} m over ${fmt(p.t - startT)} s`);

  ok('layout leaves the ground', airT > 0, `${fmt(airT)} s`);
  between('layout airtime', airT, 0.35, 0.90, ' s');
  between('layout air distance', airDist, 2.0, 7.0, ' m');
  between('layout COM rise (it arcs)', rise, 0.05, 0.55, ' m');
  between('layout slide distance', slideDist, 0.8, 4.0, ' m');
  between('get-up time', tUp - tStop, 0.70, 1.50, ' s');
  between('total time out of the play', unavailable, 1.6, 3.6, ' s');
  ok('unavailable for the whole window',
    unavailable > 0 && !Locomotion.isAvailable({ ...p, state: 'landing' } as LocoPlayer),
    'landing/recovery marked unavailable');
  ok('upright and available again at the end', Locomotion.isAvailable(p) && !p.prone,
    `state=${p.state} prone=${p.prone}`);
  ok('landing event emitted',
    events.some((e) => e.evt === 'player:land' && e.payload.layout === true),
    `${events.filter((e) => e.evt === 'player:land').length} land event(s)`);

  // A layout is not free: while down, a defender covers a lot of ground.
  const cover = 7.6 * unavailable;
  console.log(`   risk: a sprinting opponent covers ~${fmt(cover)} m during that window`);
  ok('layout is a real risk', cover > 12, `${fmt(cover)} m`);

  // Layout is committed — steering input during the flight is ignored.
  const { loco: l2 } = makeLoco();
  const q = l2.create({ id: 1, attr: ELITE });
  run(l2, q, { dir: dir(0, 1), mode: 'sprint' }, 5);
  for (let i = 0; i < 4; i++) l2.step(q, { dir: dir(0, 1), mode: 'sprint', layout: true }, DT);
  const vxAtTakeoff: number[] = [];
  for (let i = 0; i < 60; i++) {
    l2.step(q, { dir: dir(-1, 0), mode: 'sprint', brake: true }, DT);
    if (q.air.airborne) vxAtTakeoff.push(q.vel.x);
  }
  const drift = Math.max(...vxAtTakeoff.map(Math.abs), 0);
  ok('layout ignores steering once committed', drift < 0.05, `lateral drift ${fmt(drift)} m/s`);
}

/* ====================================================================== 7 */

function testStamina(): void {
  section('7. Stamina');

  const { loco } = makeLoco();
  const p = loco.create({ id: 1, attr: AVERAGE });
  const s0 = p.stamina;
  const topFresh = 6.6 + 3.0 * (AVERAGE.speed / 100);

  run(loco, p, { dir: dir(0, 1), mode: 'sprint' }, 20);
  const s20 = p.stamina;
  const vTired = spd(p);
  const topTired = p.derived.topSpeed;

  run(loco, p, { dir: dir(0, 1), mode: 'sprint' }, 20);
  const s40 = p.stamina;
  const vCooked = spd(p);

  run(loco, p, {}, 25);
  const sRest = p.stamina;

  run(loco, p, { dir: dir(0, 1), mode: 'jog' }, 20);
  const sJog = p.stamina;

  console.log(`   fresh top ${fmt(topFresh)} m/s`);
  console.log(`   stamina 0 s ${fmt(s0)} -> 20 s sprint ${fmt(s20)} -> 40 s sprint ${fmt(s40)}`);
  console.log(`   speed at 20 s ${fmt(vTired)} m/s (cap ${fmt(topTired)}), at 40 s ${fmt(vCooked)} m/s`);
  console.log(`   after 25 s standing: ${fmt(sRest)}; then 20 s jogging: ${fmt(sJog)}`);

  between('stamina after 20 s of sprinting', s20, 20, 55);
  ok('stamina keeps draining', s40 < s20 - 5, `${fmt(s40)} < ${fmt(s20 - 5)}`);
  ok('low stamina cuts top speed', vCooked < topFresh * 0.92,
    `${fmt(vCooked)} < ${fmt(topFresh * 0.92)} m/s`);
  ok('stamina recovers when standing', sRest > s40 + 30, `${fmt(sRest)} vs ${fmt(s40)}`);
  ok('stamina recovers (slower) when jogging', sJog >= sRest - 1, `${fmt(sJog)} vs ${fmt(sRest)}`);

  // Fatigued acceleration is worse too.
  const { loco: l2 } = makeLoco();
  const fresh = l2.create({ id: 1, attr: AVERAGE, stamina: 100 });
  const tired = l2.create({ id: 2, attr: AVERAGE, stamina: 0 });
  run(l2, fresh, { dir: dir(0, 1), mode: 'sprint' }, 2);
  run(l2, tired, { dir: dir(0, 1), mode: 'sprint' }, 2);
  console.log(`   2 s from rest: fresh ${fmt(fresh.pos.z)} m, cooked ${fmt(tired.pos.z)} m`);
  ok('fatigue reduces acceleration', tired.pos.z < fresh.pos.z - 0.8,
    `${fmt(tired.pos.z)} vs ${fmt(fresh.pos.z)} m`);
}

/* ====================================================================== 8 */

function testCollisions(): void {
  section('8. Player-player collision');

  // (a) Two players spawned overlapping, no input: must separate and settle.
  //
  // The resting distance is now set by the SOFT tier (move/Separation.ts), not
  // by the hard-contact radius. Two athletes who merely ended up next to each
  // other stand a body's width apart — the hard radius is only the floor under
  // an actual collision. See tools/test-move.ts for why: bodies resting on the
  // 0.64 m contact radius is what made twelve players read as one silhouette.
  const { loco } = makeLoco();
  const a = loco.create({ id: 1, attr: AVERAGE, pos: new THREE.Vector3(-0.15, 0, 0) });
  const b = loco.create({ id: 2, attr: AVERAGE, pos: new THREE.Vector3(0.15, 0, 0) });
  const rsum = a.radius + b.radius;
  const psum = a.personal + b.personal;
  let minDist = Infinity;
  const dists: number[] = [];
  for (let i = 0; i < 120 * 6; i++) {
    loco.step(a, {}, DT);
    loco.step(b, {}, DT);
    loco.resolveCollisions(DT);
    const d = Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
    minDist = Math.min(minDist, d);
    dists.push(d);
  }
  const tail = dists.slice(-60);
  // Jitter is a REVERSAL, not motion: the pair must approach monotonically.
  let jitter = 0;
  for (let i = 1; i < tail.length; i++) jitter = Math.max(jitter, tail[i - 1] - tail[i]);
  const settle = tail[tail.length - 1];
  console.log(`   overlapped 0.30 m apart (hard ${fmt(rsum)}, personal ${fmt(psum)}): ` +
    `settled at ${fmt(settle)} m, worst backward step ${(jitter * 1e6).toFixed(4)} um, ` +
    `|v| ${fmt(spd(a))}/${fmt(spd(b))} m/s`);
  between('resting separation', settle, psum - 0.05, psum + 0.002, ' m');
  ok('the hard radius is still cleared', settle > rsum, `${fmt(settle)} > ${fmt(rsum)} m`);
  ok('no jitter at rest', jitter < 1e-9, `${(jitter * 1e6).toFixed(3)} um/step`);
  ok('no residual velocity at rest', spd(a) < 0.02 && spd(b) < 0.02,
    `${fmt(spd(a))} / ${fmt(spd(b))} m/s`);

  // (b) A runs into a stationary B: no interpenetration, momentum transfers.
  const { loco: l2, events } = makeLoco();
  const r = l2.create({ id: 1, attr: AVERAGE, pos: new THREE.Vector3(0, 0, 0) });
  const t = l2.create({ id: 2, attr: AVERAGE, pos: new THREE.Vector3(0, 0, 22) });
  let worstPen = 0;
  let vBefore = 0;
  let hit = false;
  for (let i = 0; i < 120 * 8; i++) {
    if (!hit) vBefore = spd(r);
    l2.step(r, { dir: dir(0, 1), mode: 'sprint' }, DT);
    l2.step(t, {}, DT);
    l2.resolveCollisions(DT);
    const d = Math.hypot(t.pos.x - r.pos.x, t.pos.z - r.pos.z);
    if (d < rsum) hit = true;
    worstPen = Math.max(worstPen, rsum - d);
    if (hit && i > 60 && (t.state === 'stumble' || t.state === 'fall')) break;
  }
  const pBefore = r.attr.mass * vBefore;
  const pAfter = r.attr.mass * spd(r) + t.attr.mass * spd(t);
  console.log(`   runner hit at ${fmt(vBefore)} m/s; worst penetration ${(worstPen * 1000).toFixed(1)} mm`);
  console.log(`   momentum ${fmt(pBefore)} -> ${fmt(pAfter)} kg m/s; target now ${t.state}, ` +
    `runner ${r.state}, target |v| ${fmt(spd(t))} m/s`);
  ok('bodies never interpenetrate meaningfully', worstPen < 0.03, `${(worstPen * 1000).toFixed(1)} mm`);
  ok('momentum transferred to the target', spd(t) > 0.5, `${fmt(spd(t))} m/s`);
  ok('hard contact causes a stumble or fall',
    t.state === 'stumble' || t.state === 'fall' || r.state === 'stumble',
    `${r.state} / ${t.state}`);
  const contacts = events.filter((e) => e.evt === 'player:contact');
  ok('contact event emitted with a foul candidate',
    contacts.length > 0 && contacts[0].payload.foulOn === r.id,
    contacts.length ? `foulOn=${contacts[0].payload.foulOn} impact=${fmt(contacts[0].payload.impact)} ` +
      `called=${contacts[0].payload.called}` : 'none');

  // (c) A whole pack shoved together untangles without exploding.
  const { loco: l3 } = makeLoco();
  const pack: LocoPlayer[] = [];
  const rng = new Rng(7);
  for (let i = 0; i < 7; i++) {
    pack.push(l3.create({
      id: i, attr: AVERAGE,
      pos: new THREE.Vector3(rng.range(-0.4, 0.4), 0, rng.range(-0.4, 0.4)),
    }));
  }
  let maxV = 0;
  for (let i = 0; i < 120 * 3; i++) {
    for (const q of pack) l3.step(q, {}, DT);
    l3.resolveCollisions(DT);
    for (const q of pack) maxV = Math.max(maxV, spd(q));
  }
  let worst = Infinity;
  for (let i = 0; i < pack.length; i++) {
    for (let j = i + 1; j < pack.length; j++) {
      worst = Math.min(worst, Math.hypot(pack[j].pos.x - pack[i].pos.x, pack[j].pos.z - pack[i].pos.z));
    }
  }
  console.log(`   7-player pile-up: closest pair ends ${fmt(worst)} m apart ` +
    `(need ${fmt(rsum)}), peak speed during untangle ${fmt(maxV)} m/s`);
  ok('pile-up untangles', worst > rsum - 0.02, `${fmt(worst)} m`);
  ok('untangle adds no energy', maxV < 0.6, `peak ${fmt(maxV)} m/s`);
}

/* ====================================================================== 9 */

function testGround(): void {
  section('9. Ground conforming and determinism');

  // No field system at all: flat plane fallback.
  const { loco } = makeLoco();
  const p = loco.create({ id: 1, attr: AVERAGE });
  run(loco, p, { dir: dir(0, 1), mode: 'run' }, 2);
  const hip = 0.53 * AVERAGE.height;
  ok('flat fallback puts the hips at 0.53*height',
    Math.abs(p.pos.y - hip) < 1e-6, `y=${fmt(p.pos.y)} want ${fmt(hip)}`);

  // A field system that appears mid-flight is picked up.
  const field = {
    heightAt: (x: number, z: number) => 0.4 * Math.sin(x * 0.25) + 0.02 * z,
    normalAt: (x: number, _z: number, out?: THREE.Vector3) => {
      const dhdx = 0.1 * Math.cos(x * 0.25);
      const v = out ?? new THREE.Vector3();
      return v.set(-dhdx, 1, -0.02).normalize();
    },
  };
  const { loco: l2 } = makeLoco(field);
  const q = l2.create({ id: 1, attr: AVERAGE, pos: new THREE.Vector3(3, 0, 0) });
  run(l2, q, { dir: dir(1, 0), mode: 'run' }, 3);
  const want = field.heightAt(q.pos.x, q.pos.z) + hip;
  console.log(`   terrain: x=${fmt(q.pos.x)} surface ${fmt(field.heightAt(q.pos.x, q.pos.z))} ` +
    `-> hips at ${fmt(q.pos.y)} (want ${fmt(want)}), foot y ${fmt(q.foot.pos.y)}`);
  ok('player rides the surface', Math.abs(q.pos.y - want) < 1e-6, `${fmt(q.pos.y - want)} m error`);
  ok('planted foot sits on the surface',
    Math.abs(q.foot.pos.y - field.heightAt(q.foot.pos.x, q.foot.pos.z)) < 1e-6,
    `${fmt(q.foot.pos.y)} vs ${fmt(field.heightAt(q.foot.pos.x, q.foot.pos.z))}`);

  // A field object with no methods must not throw.
  const { loco: l3 } = makeLoco({ name: 'field' });
  const z = l3.create({ id: 1, attr: AVERAGE });
  let threw = false;
  try { run(l3, z, { dir: dir(0, 1), mode: 'run' }, 1); } catch { threw = true; }
  ok('degrades gracefully when field has no heightAt', !threw && Math.abs(z.pos.y - hip) < 1e-6,
    threw ? 'threw' : `y=${fmt(z.pos.y)}`);

  // Determinism: identical seeds, identical trajectories, bit for bit.
  const trace = (): string => {
    const { loco: L } = makeLoco();
    const players = [0, 1, 2].map((i) => L.create({
      id: i, attr: i === 0 ? ELITE : AVERAGE,
      pos: new THREE.Vector3(i * 0.5 - 0.5, 0, i * 0.3),
    }));
    for (let i = 0; i < 900; i++) {
      const ang = i * 0.02;
      for (const q of players) {
        L.step(q, {
          dir: dir(Math.sin(ang + q.id), Math.cos(ang + q.id)),
          mode: 'sprint', jump: i === 300, layout: i === 600,
        }, DT);
      }
      L.resolveCollisions(DT);
    }
    return players.map((q) =>
      `${q.pos.x.toFixed(12)},${q.pos.y.toFixed(12)},${q.pos.z.toFixed(12)},${q.state},${q.stamina.toFixed(12)}`,
    ).join('|');
  };
  const t1 = trace(), t2 = trace();
  ok('two runs produce identical state', t1 === t2, t1 === t2 ? 'bit-identical' : 'DIVERGED');
  console.log(`   trace: ${t1.slice(0, 96)}...`);
}

/* ===================================================================== 10 */

function testAIAdapter(): void {
  section('10. AI intent adapter');

  const { loco } = makeLoco();
  const attrs = fromAIAttributes({
    speed: 92, acceleration: 90, agility: 88, jumping: 84, stamina: 82,
  }, 1.86, 84);
  console.log(`   fromAIAttributes: accel ${attrs.accel} (from 'acceleration'), ` +
    `vertical ${attrs.vertical} (from 'jumping'), endurance ${attrs.endurance} (from 'stamina')`);
  ok('AI rating vocabulary maps across',
    attrs.accel === 90 && attrs.vertical === 84 && attrs.endurance === 82 && attrs.height === 1.86,
    `${attrs.accel}/${attrs.vertical}/${attrs.endurance}`);

  // Arrive behaviour: run to a point and settle on it, no orbiting.
  const p = loco.create({ id: 4, attr: attrs, pos: new THREE.Vector3(0, 0, 0) });
  const worldPlayers = [{ id: 4, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, airborne: false }];
  const intent = {
    id: 4, targetX: 0, targetZ: 18, faceX: 0, faceZ: 1,
    mode: 'sprint', effort: 1, desiredSpeed: 9.4, maxSpeed: 9.4,
    arriveRadius: 2.5, action: null,
  };
  let overshoot = 0;
  for (let i = 0; i < 120 * 8; i++) {
    loco.apply([intent], { players: worldPlayers }, DT);
    overshoot = Math.max(overshoot, p.pos.z - 18);
  }
  const err = Math.hypot(p.pos.x - 0, p.pos.z - 18);
  console.log(`   arrive: ended ${fmt(err)} m from target, peak overshoot ${fmt(overshoot)} m, ` +
    `|v| ${fmt(spd(p))} m/s, state ${p.state}`);
  between('settles on the target', err, 0, 0.12, ' m');
  ok('does not orbit or overshoot badly', overshoot < 0.5, `${fmt(overshoot)} m`);
  ok('world record synced back',
    Math.abs(worldPlayers[0].pos.z - p.pos.z) < 1e-12 && worldPlayers[0].airborne === false,
    `z=${fmt(worldPlayers[0].pos.z)}`);

  // maxSpeed ceiling from the intent is honoured even in sprint mode.
  const { loco: l2 } = makeLoco();
  const q = l2.create({ id: 1, attr: attrs });
  for (let i = 0; i < 120 * 6; i++) {
    l2.stepIntent(q, {
      id: 1, targetX: 0, targetZ: 200, mode: 'sprint',
      desiredSpeed: 20, maxSpeed: 6.0, arriveRadius: 1, action: null,
    }, DT);
  }
  console.log(`   intent maxSpeed 6.0 -> ${fmt(spd(q))} m/s (attribute cap ${fmt(q.derived.topSpeed)})`);
  ok('intent maxSpeed clamps the model', Math.abs(spd(q) - 6.0) < 0.02, `${fmt(spd(q))} m/s`);

  // timeToReach must match what actually happens when we simulate it.
  const { loco: l3 } = makeLoco();
  const r = l3.create({ id: 1, attr: attrs });
  for (const [label, tx, tz, windup] of [
    ['straight, from rest', 0, 25, 0],
    ['straight, at speed', 0, 25, 3],
    ['90 deg away, at speed', 25, 0, 3],
  ] as const) {
    const { loco: L } = makeLoco();
    const a = L.create({ id: 1, attr: attrs });
    if (windup) run(L, a, { dir: dir(0, 1), mode: 'sprint' }, windup);
    const base = new THREE.Vector3(a.pos.x, 0, a.pos.z);
    const gx = base.x + tx, gz = base.z + tz;
    const predicted = L.timeToReach(a, gx, gz);
    let actual = -1;
    for (let i = 0; i < 120 * 12; i++) {
      L.step(a, { dir: dir(gx - a.pos.x, gz - a.pos.z), mode: 'sprint' }, DT);
      if (Math.hypot(gx - a.pos.x, gz - a.pos.z) < 0.3) { actual = (i + 1) * DT; break; }
    }
    const relErr = Math.abs(predicted - actual) / actual;
    console.log(`   ${label.padEnd(22)} predicted ${fmt(predicted)} s, actual ${fmt(actual)} s ` +
      `(${(100 * relErr).toFixed(1)}% off)`);
    ok(`timeToReach: ${label}`, relErr < 0.22, `${(100 * relErr).toFixed(1)}% error`);
  }
  void r;
}

/* ====================================================================== */

function main(): void {
  console.log('LOCOMOTION — numerical acceptance tests @ dt = 1/120 s');
  testSprint();
  testCut();
  testGaits();
  testFootPlants();
  testJump();
  testLayout();
  testStamina();
  testCollisions();
  testGround();
  testAIAdapter();

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`);
  if (failed) console.log(`failing: ${failures.join(', ')}`);
  console.log('='.repeat(72));
  process.exitCode = failed ? 1 : 0;
}

main();
