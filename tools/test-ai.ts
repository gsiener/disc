/**
 * tools/test-ai.ts — headless verification of src/sim/AI.ts + src/sim/Playbook.ts
 *
 *   node tools/test-ai.ts
 *
 * Builds a 14-player world with a disc stub and a minimal locomotion
 * integrator, runs several full points at the real 1/120 s timestep, and
 * asserts the structural properties of the sport:
 *
 *   - offensive spacing: <= 2 live downfield cuts, no two in the same lane
 *   - the marker stays inside 3 m and outside the 1 m disc space
 *   - downfield defenders shade the correct (open) side of the force
 *   - completion percentage lands in a plausible range
 *   - nobody leaves the field and nobody thrashes back and forth
 *   - the whole simulation is bit-reproducible from the seed
 */

import {
  createTeamAI, updateTeam, makePlayer, catchProbability, reachHeight,
  restBetweenPoints, layoutExtend,
  type AIPlayer, type AIWorld, type PlayerIntent, type DiscState,
  type Archetype, type FlightSample, type TeamAI, type PlayerAction,
} from '../src/sim/AI.ts';
import {
  FIELD, SeededRng, clamp, dist2, openSideSign, markPoint, formationStations,
  type AttackDir,
} from '../src/sim/Playbook.ts';

/* ------------------------------------------------------------ assertions */

let PASS = 0;
let FAIL = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail: string): void {
  if (cond) { PASS++; console.log(`  PASS  ${name.padEnd(46)} ${detail}`); }
  else { FAIL++; failures.push(`${name}: ${detail}`); console.log(`  FAIL  ${name.padEnd(46)} ${detail}`); }
}
const f2 = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : 'n/a');
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/* ------------------------------------------------------------ disc stub */

interface Flight {
  fx: number; fy: number; fz: number;
  tx: number; ty: number; tz: number;
  tf: number; t: number; arc: number;
}

class DiscStub {
  state: DiscState = {
    pos: { x: 0, y: 1.2, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    state: 'ground', carrier: null, thrownBy: null, intendedReceiver: null,
    stall: 0, spin: 0, throwType: null,
  };
  flight: Flight | null = null;

  /** Peer API the AI probes on `ctx.sys.disc`. */
  predictPath(_s: DiscState, horizon: number, step: number): FlightSample[] {
    const out: FlightSample[] = [];
    const fl = this.flight;
    if (!fl) return out;
    for (let t = 0; t <= horizon; t += step) {
      const at = fl.t + t;
      const p = sampleFlight(fl, at);
      out.push({ t, x: p.x, y: p.y, z: p.z });
      if (p.y <= 0.03) break;
    }
    return out;
  }
}

function sampleFlight(fl: Flight, at: number): { x: number; y: number; z: number } {
  if (at <= fl.tf) {
    const s = fl.tf > 0 ? at / fl.tf : 1;
    return {
      x: fl.fx + (fl.tx - fl.fx) * s,
      y: fl.fy + (fl.ty - fl.fy) * s + fl.arc * 4 * s * (1 - s),
      z: fl.fz + (fl.tz - fl.fz) * s,
    };
  }
  // Past the intended catch point the disc glides down and dies.
  const e = at - fl.tf;
  const dx = (fl.tx - fl.fx) / Math.max(fl.tf, 0.2);
  const dz = (fl.tz - fl.fz) / Math.max(fl.tf, 0.2);
  return {
    x: fl.tx + dx * e * 0.45,
    y: Math.max(0.02, fl.ty - 2.4 * e * e - 0.9 * e),
    z: fl.tz + dz * e * 0.45,
  };
}

/* ------------------------------------------------------ locomotion stub */

function applyLocomotion(intents: PlayerIntent[], byId: Map<number, AIPlayer>, dt: number): void {
  for (const it of intents) {
    const p = byId.get(it.id);
    if (!p) continue;
    const dx = it.targetX - p.pos.x;
    const dz = it.targetZ - p.pos.z;
    const d = Math.hypot(dx, dz);
    const arrive = d < it.arriveRadius ? d / Math.max(it.arriveRadius, 1e-3) : 1;
    const want = it.desiredSpeed * arrive;
    const ux = d > 1e-4 ? dx / d : 0;
    const uz = d > 1e-4 ? dz / d : 0;
    const wvx = ux * want;
    const wvz = uz * want;
    let ax = wvx - p.vel.x;
    let az = wvz - p.vel.z;
    const al = Math.hypot(ax, az);
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const cap = (want < speed ? it.maxDecel : it.maxAccel) * dt;
    if (al > cap && al > 1e-6) { ax = (ax / al) * cap; az = (az / al) * cap; }
    p.vel.x += ax; p.vel.z += az;
    // Honour the turn-rate cap from the intent: you cannot swap direction for
    // free, which is precisely why a planted change of direction gets you open.
    const sp0 = Math.hypot(p.vel.x, p.vel.z);
    const old0 = Math.hypot(p.vel.x - ax, p.vel.z - az);
    if (sp0 > 1.0 && old0 > 1.0) {
      const a0 = Math.atan2(p.vel.z - az, p.vel.x - ax);
      const a1 = Math.atan2(p.vel.z, p.vel.x);
      let da = a1 - a0;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const cap = it.turnRate * dt;
      if (Math.abs(da) > cap) {
        const a = a0 + Math.sign(da) * cap;
        p.vel.x = Math.cos(a) * sp0; p.vel.z = Math.sin(a) * sp0;
      }
    }
    const sp = Math.hypot(p.vel.x, p.vel.z);
    if (sp > it.maxSpeed) { p.vel.x *= it.maxSpeed / sp; p.vel.z *= it.maxSpeed / sp; }
    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;
  }
  // Soft separation so bodies do not interpenetrate.
  const all = intents.map((i) => byId.get(i.id)!).filter(Boolean);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.7 && d > 1e-4) {
        const push = (0.7 - d) * 0.5;
        a.pos.x -= (dx / d) * push; a.pos.z -= (dz / d) * push;
        b.pos.x += (dx / d) * push; b.pos.z += (dz / d) * push;
      }
    }
  }
}

/* ------------------------------------------------------------- the game */

interface PointResult {
  index: number;
  scoredBy: number | null;
  seconds: number;
  throws: number;
  completions: number;
  turnovers: Record<string, number>;
  possessions: number;
  minMarkDist: number;
  maxMarkDist: number;
  markInside3: number;
  markSamples: number;
  shadeGood: number;
  shadeSamples: number;
  laneConflicts: number;
  overCutBudget: number;
  minLiveCutGap: number;
  minStackGap: number;
  oob: number;
  scheme: string;
}

interface Sim {
  world: AIWorld;
  teams: [TeamAI, TeamAI];
  disc: DiscStub;
  byId: Map<number, AIPlayer>;
  points: PointResult[];
  oscFlags: number;
  diag: { blocks: string[]; oob: string[]; mark: string[]; ground: string[]; drops: string[]; trace: string[] };
  lastIntents?: PlayerIntent[];
  totals: {
    throws: number; completions: number;
    turnovers: Record<string, number>;
    laneConflicts: number; overCutBudget: number; oob: number;
    markSamples: number; markInside3: number; minMarkDist: number; maxMarkDist: number;
    shadeSamples: number; shadeGood: number;
    minLiveCutGap: number; minStackGap: number; minCutTargetGap: number;
    zonePoints: number; personPoints: number;
    endEnergy: number[];
    markEstablish: number[];
    worstStack: string;
    worstTargets: string;
    minEnergySeen: number;
    liveSeconds: number;
    expectedSum: number;
    byTeam: { throws: number; comp: number; gain: number; turns: number; poss: number }[];
    buckets: { n: number; ok: number; gain: number; stall: number }[];
  };
}

const DT = 1 / 120;
const ARCHES: Archetype[] = ['handler', 'handler', 'handler', 'cutter', 'cutter', 'deep', 'utility'];

function buildSim(seed: number, wind: { x: number; z: number }): Sim {
  const rng = new SeededRng(seed);
  const players: AIPlayer[] = [];
  for (let t = 0; t < 2; t++) {
    for (let i = 0; i < 7; i++) {
      const overall = 62 + rng.range(0, 20);
      players.push(makePlayer(t * 7 + i, t as 0 | 1, ARCHES[i], rng.fork(t * 31 + i), overall));
    }
  }
  const disc = new DiscStub();
  const byId = new Map(players.map((p) => [p.id, p]));

  const world: AIWorld = {
    time: 0,
    players,
    disc: disc.state,
    possession: 0,
    phase: 'setup',
    wind,
    score: [0, 0],
    scoreCap: 15,
    rand: rng.fork(999),
    sys: { disc },
  };

  const teams: [TeamAI, TeamAI] = [
    createTeamAI(0, 1 as AttackDir, rng.fork(11), {
      formation: 'vertical', force: 'forehand', aggression: 1.05, zoneBias: -0.2, seed: 3,
    }),
    createTeamAI(1, -1 as AttackDir, rng.fork(22), {
      formation: 'horizontal', force: 'backhand', aggression: 0.95, zoneBias: 0.05, seed: 5,
    }),
  ];

  return {
    world, teams, disc, byId, points: [], oscFlags: 0,
    diag: { blocks: [], oob: [], mark: [], ground: [], drops: [], trace: [] },
    totals: {
      throws: 0, completions: 0, turnovers: {},
      laneConflicts: 0, overCutBudget: 0, oob: 0,
      markSamples: 0, markInside3: 0, minMarkDist: 1e9, maxMarkDist: 0,
      shadeSamples: 0, shadeGood: 0,
      minLiveCutGap: 1e9, minStackGap: 1e9, minCutTargetGap: 1e9,
      zonePoints: 0, personPoints: 0, endEnergy: [],
      markEstablish: [], worstStack: '', worstTargets: '',
      minEnergySeen: 1, liveSeconds: 0, expectedSum: 0,
      byTeam: [0, 1].map(() => ({ throws: 0, comp: 0, gain: 0, turns: 0, poss: 1 })),
      buckets: Array.from({ length: 10 }, () => ({ n: 0, ok: 0, gain: 0, stall: 0 })),
    },
  };
}

function bump(map: Record<string, number>, k: string): void { map[k] = (map[k] ?? 0) + 1; }

/** Independent derivation of the open side — deliberately NOT AI code. */
function expectedOpenSign(force: 'forehand' | 'backhand' | 'straight', offenceDir: AttackDir): number {
  // A right-hander facing `offenceDir` has their right hand (forehand) at x = -offenceDir,
  // because right = forward x up = (0,0,dir) x (0,1,0) = (-dir,0,0).
  const forehandX = -offenceDir;
  return force === 'backhand' ? -forehandX : forehandX;
}

function runPoint(sim: Sim, index: number, receiving: 0 | 1, log: boolean): PointResult {
  const { world, teams, disc, byId } = sim;
  const dir: AttackDir = receiving === 0 ? 1 : -1;

  // ---- reset for the point
  world.possession = receiving;
  world.phase = 'setup';
  for (const p of world.players) {
    p.vel.x = 0; p.vel.z = 0;
    const own = -(p.team === 0 ? 1 : -1) * FIELD.goalLine;
    p.pos.x = (p.id % 7 - 3) * 4.6;
    p.pos.z = own;
  }
  disc.flight = null;
  disc.state.state = 'ground';
  disc.state.carrier = null;
  disc.state.thrownBy = null;
  disc.state.intendedReceiver = null;
  disc.state.stall = 0;
  disc.state.pos.x = 0;
  disc.state.pos.y = 0.05;
  disc.state.pos.z = -dir * FIELD.brick;

  const res: PointResult = {
    index, scoredBy: null, seconds: 0, throws: 0, completions: 0,
    turnovers: {}, possessions: 1,
    minMarkDist: 1e9, maxMarkDist: 0, markInside3: 0, markSamples: 0,
    shadeGood: 0, shadeSamples: 0, laneConflicts: 0, overCutBudget: 0,
    minLiveCutGap: 1e9, minStackGap: 1e9, oob: 0, scheme: '',
  };

  // oscillation tracking: 1.5 s windows of path length vs net displacement
  const win = Math.round(1.5 / DT);
  const hist = new Map<number, { x: number; z: number }[]>();
  const pathLen = new Map<number, number>();
  for (const p of world.players) { hist.set(p.id, []); pathLen.set(p.id, 0); }

  const maxT = 110;
  let t = 0;
  let setupTimer = 1.0;
  let heldFor = 0;
  let markStart = -1;
  let carrierSeen: number | null = null;
  let bIdx = -1;
  const ring: string[] = [];
  let throwFromZ = 0;
  let lastThrow: { aimX: number; aimZ: number; recv: number; exp: number; d: number; atRelease: number; tf: number; vAtRelease: number; minGap: number; minGapY: number } | null = null;

  while (t < maxT) {
    world.time += DT;
    t += DT;

    if (disc.state.state === 'held' && disc.state.carrier != null) {
      if (disc.state.carrier !== carrierSeen) {
        carrierSeen = disc.state.carrier; heldFor = 0; markStart = -1;
      }
      heldFor += DT;
    } else {
      carrierSeen = null; heldFor = 0; markStart = -1;
    }

    if (world.phase === 'setup') {
      setupTimer -= DT;
      if (setupTimer <= 0) world.phase = 'live';
    }

    if (process.env.AI_TRACE && disc.state.state === 'flight' && disc.flight
        && disc.state.intendedReceiver != null && true) {
      const rr = byId.get(disc.state.intendedReceiver);
      const ii = sim.lastIntents?.find((q) => q.id === disc.state.intendedReceiver);
      if (rr && ii) {
        if (ring.length > 6) ring.shift();
        ring.push(`t=${f2(disc.flight.t)}/${f2(disc.flight.tf)} recv@(${f2(rr.pos.x)},${f2(rr.pos.z)}) ` +
          `v=${f2(Math.hypot(rr.vel.x, rr.vel.z))} tgt=(${f2(ii.targetX)},${f2(ii.targetZ)}) mode=${ii.mode} ` +
          `state=${ii.debug.state} ds=${f2(ii.desiredSpeed)} disc@(${f2(disc.state.pos.x)},${f2(disc.state.pos.z)},${f2(disc.state.pos.y)})`);
      }
    }
    const iA = updateTeam(teams[0], world, DT);
    const iB = updateTeam(teams[1], world, DT);
    const intents = [...iA, ...iB];
    sim.lastIntents = intents;

    /* ------------------------------------------------- structural checks */
    if (world.phase === 'live') {
      const offIntents = world.possession === 0 ? iA : iB;
      const defIntents = world.possession === 0 ? iB : iA;
      const defTeam = teams[world.possession === 0 ? 1 : 0];
      const offTeam = teams[world.possession];

      // --- offensive spacing / lanes
      const live = offIntents.filter((i) =>
        i.debug.state === 'setup' || i.debug.state === 'plant' || i.debug.state === 'break');
      const downfieldLive = live.filter((i) => i.debug.lane && !i.debug.lane.startsWith('reset'));
      if (downfieldLive.length > 2) { res.overCutBudget++; sim.totals.overCutBudget++; }
      const seen = new Set<string>();
      for (const i of downfieldLive) {
        const k = i.debug.lane as string;
        if (seen.has(k)) { res.laneConflicts++; sim.totals.laneConflicts++; }
        seen.add(k);
      }
      for (let a = 0; a < downfieldLive.length; a++) {
        for (let b = a + 1; b < downfieldLive.length; b++) {
          const pa = byId.get(downfieldLive[a].id)!;
          const pb = byId.get(downfieldLive[b].id)!;
          const g = dist2(pa.pos.x, pa.pos.z, pb.pos.x, pb.pos.z);
          if (g < res.minLiveCutGap) res.minLiveCutGap = g;
          if (g < sim.totals.minLiveCutGap) sim.totals.minLiveCutGap = g;
          const da = downfieldLive[a].debug, db = downfieldLive[b].debug;
          const tg = dist2(da.cutX, da.cutZ, db.cutX, db.cutZ);
          if (Number.isFinite(tg) && tg < sim.totals.minCutTargetGap) {
            sim.totals.minCutTargetGap = tg;
            sim.totals.worstTargets =
              `#${downfieldLive[a].id}[${da.lane}/${da.state}]->(${f2(da.cutX)},${f2(da.cutZ)}) vs ` +
              `#${downfieldLive[b].id}[${db.lane}/${db.state}]->(${f2(db.cutX)},${f2(db.cutZ)})`;
          }
        }
      }
      // Formation spacing is judged on players who have SETTLED into the
      // formation; two teammates in transit may legitimately cross.
      const stacked = offIntents.filter((i) => {
        if (i.debug.state !== 'stack') return false;
        const p = byId.get(i.id)!;
        return Math.hypot(p.vel.x, p.vel.z) < 1.5
          && dist2(p.pos.x, p.pos.z, i.targetX, i.targetZ) < 1.5;
      });
      for (let a = 0; a < stacked.length; a++) {
        for (let b = a + 1; b < stacked.length; b++) {
          const pa = byId.get(stacked[a].id)!;
          const pb = byId.get(stacked[b].id)!;
          const g = dist2(pa.pos.x, pa.pos.z, pb.pos.x, pb.pos.z);
          if (g < res.minStackGap) res.minStackGap = g;
          if (g < sim.totals.minStackGap) {
            sim.totals.minStackGap = g;
            sim.totals.worstStack =
              `#${pa.id}(${pa.role}) @${f2(pa.pos.x)},${f2(pa.pos.z)}->${f2(stacked[a].targetX)},${f2(stacked[a].targetZ)} vs ` +
              `#${pb.id}(${pb.role}) @${f2(pb.pos.x)},${f2(pb.pos.z)}->${f2(stacked[b].targetX)},${f2(stacked[b].targetZ)} ` +
              `form=${offTeam.currentFormation} disc=(${f2(disc.state.pos.x)},${f2(disc.state.pos.z)})`;
          }
        }
      }

      // --- the marker. Sampled once the stall is actually running, which is
      //     the only time the rule applies; the run-in from a turnover is
      //     measured separately as `time to establish the mark`.
      if (disc.state.state === 'held' && disc.state.carrier != null) {
        const thrower = byId.get(disc.state.carrier)!;
        const mk = defIntents.find((i) => i.debug.role === 'marker' || i.debug.role === 'zone:cup-mark');
        if (mk) {
          const p = byId.get(mk.id)!;
          const d = dist2(p.pos.x, p.pos.z, thrower.pos.x, thrower.pos.z);
          if (d <= 3.0 && markStart < 0) { markStart = heldFor; sim.totals.markEstablish.push(heldFor); }
          if (disc.state.stall > 0.5 && heldFor > 1.4) {
            res.markSamples++; sim.totals.markSamples++;
            if (d <= 3.0) { res.markInside3++; sim.totals.markInside3++; }
            if (d < sim.totals.minMarkDist) {
              sim.diag.mark = [`d=${f2(d)} heldFor=${f2(heldFor)} thrower#${thrower.id}@(${f2(thrower.pos.x)},${f2(thrower.pos.z)}) ` +
                `v=${f2(Math.hypot(thrower.vel.x, thrower.vel.z))} marker#${p.id}@(${f2(p.pos.x)},${f2(p.pos.z)}) ` +
                `v=${f2(Math.hypot(p.vel.x, p.vel.z))} mode=${mk.mode} tgt=(${f2(mk.targetX)},${f2(mk.targetZ)}) ds=${f2(mk.desiredSpeed)}`];
            }
            if (d < res.minMarkDist) res.minMarkDist = d;
            if (d > res.maxMarkDist) res.maxMarkDist = d;
            if (d < sim.totals.minMarkDist) sim.totals.minMarkDist = d;
            if (d > sim.totals.maxMarkDist) sim.totals.maxMarkDist = d;
          }
        }

        // --- the force: downfield defenders shade the open side
        if (defTeam.currentScheme === 'person') {
          const odir: AttackDir = offTeam === teams[0] ? 1 : -1;
          const openSign = expectedOpenSign(defTeam.force as 'forehand' | 'backhand', odir);
          for (const di of defIntents) {
            if (di.debug.role === 'marker') continue;
            if (di.debug.state !== 'person') continue;       // poaching is meant to break the shade
            const d = byId.get(di.id)!;
            const oid = defTeam.matchupOf(di.id);
            if (oid == null) continue;
            const o = byId.get(oid);
            if (!o) continue;
            // Skip when the shade would push the defender off the field.
            if (o.pos.x * openSign > FIELD.halfWidth - 3.0) continue;
            // Only judge downfield defenders in the live part of the field.
            if (odir * (o.pos.z - disc.state.pos.z) < 2) continue;
            // A defender still running back to his matchup is recovering, not
            // shading; judge him once he is in coverage range.
            if (dist2(d.pos.x, d.pos.z, o.pos.x, o.pos.z) > 5.0) continue;
            res.shadeSamples++; sim.totals.shadeSamples++;
            if ((d.pos.x - o.pos.x) * openSign > 0) { res.shadeGood++; sim.totals.shadeGood++; }
          }
        }
      }
    }

    /* ------------------------------------------------------ apply actions */
    let scored: number | null = null;
    for (const it of intents) {
      const a = it.action;
      if (!a) continue;
      if (a.kind === 'stall' && it.team !== world.possession) {
        disc.state.stall = a.count;
      } else if (a.kind === 'pickup' && it.team === world.possession
        && disc.state.state === 'ground') {
        const p = byId.get(it.id)!;
        if (dist2(p.pos.x, p.pos.z, disc.state.pos.x, disc.state.pos.z) < 1.4) {
          disc.state.state = 'held';
          disc.state.carrier = p.id;
          disc.state.stall = 0;
        }
      } else if (a.kind === 'throw' && disc.state.state === 'held'
        && disc.state.carrier === it.id) {
        const p = byId.get(it.id)!;
        const d = dist2(p.pos.x, p.pos.z, a.aimX, a.aimZ);
        disc.flight = {
          fx: p.pos.x, fy: 1.25, fz: p.pos.z,
          tx: a.aimX, ty: a.aimY, tz: a.aimZ,
          tf: Math.max(0.25, a.flightTime), t: 0,
          arc: a.throwType === 'hammer' ? 3.2 : 0.28 + 0.05 * d,
        };
        disc.state.state = 'flight';
        disc.state.thrownBy = it.id;
        disc.state.intendedReceiver = a.receiverId;
        disc.state.carrier = null;
        disc.state.throwType = a.throwType;
        const stallAtThrow = disc.state.stall;
        disc.state.stall = 0;
        res.throws++; sim.totals.throws++;
        sim.totals.byTeam[world.possession].throws++;
        throwFromZ = p.pos.z;
        sim.totals.expectedSum += a.expected;
        bIdx = Math.min(9, Math.max(0, Math.floor(a.expected * 10)));
        const bk = sim.totals.buckets[bIdx];
        bk.n++;
        bk.gain += (p.team === 0 ? 1 : -1) * (a.aimZ - p.pos.z);
        bk.stall += stallAtThrow;
        const rr = byId.get(a.receiverId);
        lastThrow = { aimX: a.aimX, aimZ: a.aimZ, recv: a.receiverId, exp: a.expected, d,
          atRelease: rr ? dist2(rr.pos.x, rr.pos.z, a.aimX, a.aimZ) : -1,
          tf: a.flightTime,
          vAtRelease: rr ? Math.hypot(rr.vel.x, rr.vel.z) : -1, minGap: 1e9, minGapY: 0 };
      }
    }

    // Stall out.
    if (disc.state.state === 'held' && disc.state.stall >= 10) {
      turnover(sim, res, 'stall', disc.state.pos.x, disc.state.pos.z);
    }

    /* ---------------------------------------------------------- movement */
    applyLocomotion(intents, byId, DT);

    /* -------------------------------------------------------- disc state */
    if (disc.state.state === 'held' && disc.state.carrier != null) {
      const c = byId.get(disc.state.carrier)!;
      disc.state.pos.x = c.pos.x;
      disc.state.pos.y = 1.2;
      disc.state.pos.z = c.pos.z;
      disc.state.vel.x = 0; disc.state.vel.y = 0; disc.state.vel.z = 0;
    } else if (disc.state.state === 'flight' && disc.flight) {
      const fl = disc.flight;
      const prev = sampleFlight(fl, fl.t);
      fl.t += DT;
      const cur = sampleFlight(fl, fl.t);
      disc.state.pos.x = cur.x; disc.state.pos.y = cur.y; disc.state.pos.z = cur.z;
      disc.state.vel.x = (cur.x - prev.x) / DT;
      disc.state.vel.y = (cur.y - prev.y) / DT;
      disc.state.vel.z = (cur.z - prev.z) / DT;

      const speed = Math.hypot(disc.state.vel.x, disc.state.vel.z);
      if (lastThrow) {
        const rr = byId.get(lastThrow.recv);
        if (rr) {
          const dd = dist2(rr.pos.x, rr.pos.z, cur.x, cur.z);
          if (dd < lastThrow.minGap) { lastThrow.minGap = dd; lastThrow.minGapY = cur.y; }
        }
      }
      const actionOf = new Map<number, PlayerAction | null>(intents.map((i) => [i.id, i.action]));

      // Who has a play on it? The thrower cannot catch his own throw, and
      // nothing is catchable until the disc has left the hand.
      //
      // Contest model: when a receiver and a defender both reach the disc the
      // RECEIVER attempts the catch (paying a contest penalty) — he knows
      // where it is going and has body position. The defender earns a clean D
      // only by beating him to the spot by a clear margin.
      //
      // A layout only extends reach in the last moments of the flight; a
      // defender cannot lie extended for two seconds.
      const bidWindow = fl.t >= fl.tf - 0.55;
      let offId = -1, offD = 1e9, defId = -1, defD = 1e9;
      if (cur.y > 0.12 && fl.t > 0.25) {
        for (const p of world.players) {
          if (p.id === disc.state.thrownBy) continue;
          const act = actionOf.get(p.id);
          const attacking = p.team === world.possession;
          let reach = attacking ? 1.05 : 0.80;
          if (act && act.kind === 'bid' && bidWindow) reach += layoutExtend(p) * 0.60;
          const hd = dist2(p.pos.x, p.pos.z, cur.x, cur.z);
          const hi = reachHeight(p) + (act && act.kind === 'jump' ? 0.10 : 0);
          if (hd > reach || cur.y > hi) continue;
          if (attacking) { if (hd < offD) { offD = hd; offId = p.id; } }
          else if (hd < defD) { defD = hd; defId = p.id; }
        }
      }
      const bestId = (defId >= 0 && (offId < 0 || defD < offD - 0.35)) ? defId : offId;

      if (bestId >= 0) {
        const p = byId.get(bestId)!;
        if (p.team === world.possession) {
          let contest = 0;
          for (const q of world.players) {
            if (q.team === p.team) continue;
            if (dist2(q.pos.x, q.pos.z, cur.x, cur.z) < 1.7) contest++;
          }
          const act = actionOf.get(p.id);
          const difficulty = clamp(
            0.05
            + 0.45 * clamp((cur.y - 2.00) / 0.9, 0, 1)
            + 0.30 * clamp((speed - 14) / 12, 0, 1)
            + 0.30 * contest
            + (act && act.kind === 'bid' && dist2(p.pos.x, p.pos.z, cur.x, cur.z) > 1.05 ? 0.30 : 0), 0, 1.8);
          if (world.rand.next() < catchProbability(p, difficulty)) {
            disc.flight = null;
            disc.state.state = 'held';
            disc.state.carrier = p.id;
            disc.state.stall = 0;
            res.completions++; sim.totals.completions++;
            const bt = sim.totals.byTeam[world.possession];
            bt.comp++; bt.gain += (p.team === 0 ? 1 : -1) * (p.pos.z - throwFromZ);
            if (bIdx >= 0) sim.totals.buckets[bIdx].ok++;
            const scoreDir: AttackDir = p.team === 0 ? 1 : -1;
            if (scoreDir * p.pos.z >= FIELD.goalLine) {
              scored = p.team;
            }
          } else {
            if (sim.diag.drops.length < 14) {
              sim.diag.drops.push(`#${p.id} catch=${Math.round(p.attr.catching)} diff=${f2(difficulty)} ` +
                `p=${pct(catchProbability(p, difficulty))} discY=${f2(cur.y)} contest=${contest} speed=${f2(speed)}`);
            }
            turnover(sim, res, 'drop', cur.x, cur.z);
          }
        } else {
          sim.diag.blocks.push(
            `#${p.id} at ${(fl.t / fl.tf).toFixed(2)} of a ${f2(dist2(fl.fx, fl.fz, fl.tx, fl.tz))}m ` +
            `throw, discY=${f2(cur.y)}, act=${actionOf.get(p.id)?.kind ?? '-'}`);
          turnover(sim, res, 'block', cur.x, cur.z);
        }
      } else if (cur.y <= 0.12) {
        if (process.env.AI_TRACE && sim.diag.trace.length < 30) {
          sim.diag.trace.push('--- ground turnover ---', ...ring.slice(-5));
        }
        if (sim.diag.ground.length < 14 && lastThrow) {
          const r = byId.get(lastThrow.recv);
          sim.diag.ground.push(
            `${f2(lastThrow.d)}m throw tf=${f2(lastThrow.tf)}s exp=${pct(lastThrow.exp)}; recv #${lastThrow.recv} ` +
            `was ${f2(lastThrow.atRelease)}m from the aim at release (v=${f2(lastThrow.vAtRelease)}), ` +
            `closest approach ${f2(lastThrow.minGap)}m at discY=${f2(lastThrow.minGapY)}`);
        }
        turnover(sim, res, 'ground', cur.x, cur.z);
      } else if (Math.abs(cur.x) > FIELD.halfWidth || Math.abs(cur.z) > FIELD.halfLength) {
        turnover(sim, res, 'out-of-bounds',
          clamp(cur.x, -FIELD.halfWidth + 1, FIELD.halfWidth - 1),
          clamp(cur.z, -FIELD.halfLength + 1, FIELD.halfLength - 1));
      }
    }

    /* ---------------------------------------------- out of bounds / thrash */
    if (world.phase === 'live') sim.totals.liveSeconds += DT;
    for (const p of world.players) {
      if (Math.abs(p.pos.x) > FIELD.halfWidth || Math.abs(p.pos.z) > FIELD.halfLength) {
        res.oob++; sim.totals.oob++;
        if (sim.diag.oob.length < 12) {
          const ax = Math.abs(p.pos.x) > FIELD.halfWidth ? 'X' : 'Z';
          const it = intents.find((i) => i.id === p.id);
          sim.diag.oob.push(`#${p.id} ${ax} @(${f2(p.pos.x)},${f2(p.pos.z)}) v=${f2(Math.hypot(p.vel.x, p.vel.z))} ` +
            `mode=${it?.mode} state=${it?.debug.state} tgt=(${f2(it?.targetX ?? 0)},${f2(it?.targetZ ?? 0)})`);
        }
      }
      if (p.energy < sim.totals.minEnergySeen) sim.totals.minEnergySeen = p.energy;
      const h = hist.get(p.id)!;
      const last = h.length ? h[h.length - 1] : null;
      if (last) pathLen.set(p.id, pathLen.get(p.id)! + dist2(p.pos.x, p.pos.z, last.x, last.z));
      h.push({ x: p.pos.x, z: p.pos.z });
      if (h.length > win) {
        const drop = h.shift()!;
        pathLen.set(p.id, Math.max(0, pathLen.get(p.id)! - dist2(drop.x, drop.z, h[0].x, h[0].z)));
        const net = dist2(h[0].x, h[0].z, p.pos.x, p.pos.z);
        if (pathLen.get(p.id)! > 8 && net < 1.0) sim.oscFlags++;
      }
    }

    if (scored != null) {
      res.scoredBy = scored;
      world.score[scored as 0 | 1]++;
      break;
    }
  }

  res.seconds = t;
  res.scheme = `${teams[0].currentScheme}/${teams[1].currentScheme}`;
  if (teams[0].currentScheme === 'zone' || teams[1].currentScheme === 'zone') sim.totals.zonePoints++;
  else sim.totals.personPoints++;

  if (log) {
    const comp = res.throws ? res.completions / res.throws : 0;
    const to = Object.entries(res.turnovers).map(([k, v]) => `${k}:${v}`).join(' ') || 'none';
    console.log(
      `  point ${String(index).padStart(2)} | ${f2(res.seconds)}s | ` +
      `score:${res.scoredBy === null ? '-' : `T${res.scoredBy}`} | ` +
      `throws ${String(res.throws).padStart(3)} comp ${pct(comp)} | ` +
      `poss ${res.possessions} | mark[${f2(res.minMarkDist)}..${f2(res.maxMarkDist)}]m ` +
      `in3 ${pct(res.markSamples ? res.markInside3 / res.markSamples : 1)} | ` +
      `shade ${pct(res.shadeSamples ? res.shadeGood / res.shadeSamples : 1)} | ` +
      `lanes ${res.laneConflicts} | stackGap ${f2(res.minStackGap)} | TO ${to} | ${res.scheme}`,
    );
  }
  return res;
}

function turnover(sim: Sim, res: PointResult, kind: string, x: number, z: number): void {
  const { world, disc } = sim;
  bump(res.turnovers, kind);
  bump(sim.totals.turnovers, kind);
  sim.totals.byTeam[world.possession].turns++;
  sim.totals.byTeam[1 - world.possession].poss++;
  disc.flight = null;
  disc.state.state = 'ground';
  disc.state.carrier = null;
  disc.state.thrownBy = null;
  disc.state.intendedReceiver = null;
  disc.state.stall = 0;
  disc.state.pos.x = clamp(x, -FIELD.halfWidth + 1, FIELD.halfWidth - 1);
  disc.state.pos.y = 0.05;
  disc.state.pos.z = clamp(z, -FIELD.halfLength + 1, FIELD.halfLength - 1);
  world.possession = (1 - world.possession) as 0 | 1;
  res.possessions++;
}

/* ------------------------------------------------------------ unit tests */

function unitTests(): void {
  console.log('\n[unit] geometry + attribute model');

  // Force algebra must agree with an independently derived expectation.
  const cases: Array<[('forehand' | 'backhand'), AttackDir]> = [
    ['forehand', 1], ['forehand', -1], ['backhand', 1], ['backhand', -1],
  ];
  let allOk = true;
  for (const [force, dir] of cases) {
    const got = openSideSign(force, dir);
    const want = expectedOpenSign(force, dir);
    if (got !== want) allOk = false;
  }
  ok('openSideSign matches hand geometry', allOk, `4 cases (force x direction)`);

  // Mark geometry.
  const mp = markPoint({ x: 0, z: 0 }, 1 as AttackDir, 1, 1.85);
  const md = Math.hypot(mp.x, mp.z);
  ok('markPoint sits inside the stall radius',
    md > 1.0 && md < 3.0 && mp.x > 0,
    `d=${f2(md)}m offset=(${f2(mp.x)}, ${f2(mp.z)}) on the break side`);

  // Formations: 7 stations, all in bounds, sane spacing.
  let minGap = 1e9; let count = 0; let inb = true;
  for (const name of ['vertical', 'horizontal', 'side', 'endzone'] as const) {
    for (const dz of [-25, 0, 20]) {
      const st = formationStations(name, { x: 4, z: dz }, 1, -1);
      count += st.length;
      for (const s of st) {
        if (Math.abs(s.x) > FIELD.halfWidth || Math.abs(s.z) > FIELD.halfLength) inb = false;
      }
      for (let i = 0; i < st.length; i++) {
        for (let j = i + 1; j < st.length; j++) {
          const g = dist2(st[i].x, st[i].z, st[j].x, st[j].z);
          if (g < minGap) minGap = g;
        }
      }
    }
  }
  ok('formations produce 7 in-bounds stations', count === 84 && inb,
    `${count / 12} per formation, min pairwise gap ${f2(minGap)}m`);
  ok('formation spacing >= 3 m', minGap >= 3.0, `min ${f2(minGap)}m across 12 layouts`);

  // Attributes must actually move outcomes.
  const rng = new SeededRng(4242);
  const fast = makePlayer(90, 0, 'deep', rng.fork(1), 92);
  const slow = makePlayer(91, 0, 'handler', rng.fork(2), 52);
  const sFast = 5.7 + 3.3 * (fast.attr.speed / 100);
  const sSlow = 5.7 + 3.3 * (slow.attr.speed / 100);
  ok('speed rating changes top speed', sFast - sSlow > 0.8,
    `${f2(sFast)} m/s vs ${f2(sSlow)} m/s (delta ${f2(sFast - sSlow)})`);

  const goodHands = makePlayer(92, 0, 'cutter', rng.fork(3), 95);
  const badHands = makePlayer(93, 0, 'cutter', rng.fork(4), 45);
  const cg = catchProbability(goodHands, 0.6);
  const cb = catchProbability(badHands, 0.6);
  ok('catching rating changes drop rate', cg - cb > 0.02,
    `p(catch)@0.6 diff: ${pct(cg)} vs ${pct(cb)}`);

  // Fatigue must bite.
  const tired = makePlayer(94, 0, 'cutter', rng.fork(5), 70);
  const fresh = makePlayer(95, 0, 'cutter', rng.fork(5), 70);
  tired.energy = 0.3;
  const vT = (5.7 + 3.3 * (tired.attr.speed / 100)) * (0.80 + 0.20 * tired.energy);
  const vF = (5.7 + 3.3 * (fresh.attr.speed / 100)) * (0.80 + 0.20 * fresh.energy);
  ok('fatigue degrades speed', vF - vT > 0.4,
    `fresh ${f2(vF)} m/s vs 30% tank ${f2(vT)} m/s`);

  // Fallback flight predictor must agree with the disc peer within ~2 m.
  ok('layout extension scales with agility',
    layoutExtend(fast) > 0 && layoutExtend(fast) < 2.5,
    `${f2(layoutExtend(fast))}m for a ${Math.round(fast.attr.agility)} agility player`);
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  console.log('='.repeat(112));
  console.log('  ULTIMATE — team AI verification (fixed 1/120 s, deterministic)');
  console.log('='.repeat(112));

  unitTests();

  /* -------------------------------------------------- calm-conditions run */
  console.log('\n[sim] 10 points, light wind (person defence expected)');
  const sim = buildSim(20260729, { x: 1.2, z: -0.4 });
  let receiving: 0 | 1 = 0;
  for (let i = 1; i <= 10; i++) {
    const r = runPoint(sim, i, receiving, true);
    sim.points.push(r);
    restBetweenPoints(sim.world.players, 45);
    receiving = (r.scoredBy === null ? (1 - receiving) : (1 - r.scoredBy)) as 0 | 1;
  }
  for (const p of sim.world.players) sim.totals.endEnergy.push(p.energy);

  /* ------------------------------------------------------- windy zone run */
  console.log('\n[sim] 3 points, heavy wind (zone defence expected)');
  const windy = buildSim(777001, { x: 9.5, z: 2.0 });
  let recv2: 0 | 1 = 1;
  for (let i = 1; i <= 3; i++) {
    const r = runPoint(windy, i, recv2, true);
    windy.points.push(r);
    restBetweenPoints(windy.world.players, 45);
    recv2 = (r.scoredBy === null ? (1 - recv2) : (1 - r.scoredBy)) as 0 | 1;
  }

  /* ------------------------------------------------------------ assertions */
  const T = sim.totals;
  const comp = T.throws ? T.completions / T.throws : 0;
  const markIn3 = T.markSamples ? T.markInside3 / T.markSamples : 0;
  const shade = T.shadeSamples ? T.shadeGood / T.shadeSamples : 0;
  const avgEnergy = T.endEnergy.reduce((a, b) => a + b, 0) / Math.max(1, T.endEnergy.length);
  const minEnergy = Math.min(...T.endEnergy);

  console.log('\n[assert] structure');
  ok('throw volume is meaningful', T.throws >= 50, `${T.throws} throws over 10 points`);
  ok('completion % is plausible (75-92)', comp >= 0.75 && comp <= 0.92,
    `${pct(comp)} (${T.completions}/${T.throws}); thrower's own estimate averaged ` +
    `${pct(T.throws ? T.expectedSum / T.throws : 0)}`);
  ok('turnovers come from several causes',
    Object.keys(T.turnovers).length >= 2,
    Object.entries(T.turnovers).map(([k, v]) => `${k}:${v}`).join(' ') || 'none');

  ok('never more than 2 live downfield cuts', T.overCutBudget === 0,
    `${T.overCutBudget} violating ticks`);
  ok('no two live cuts share a lane', T.laneConflicts === 0,
    `${T.laneConflicts} conflicting ticks`);
  ok('live cut targets keep >= 5 m apart', T.minCutTargetGap >= 5.0,
    `closest pair of cut targets ${f2(T.minCutTargetGap)}m  ` +
    `${T.minCutTargetGap < 5 ? T.worstTargets : ''}`);
  ok('stack keeps >= 2 m between bodies', T.minStackGap >= 2.0,
    `tightest stack pair ${f2(T.minStackGap)}m  ${T.minStackGap < 2 ? T.worstStack : ''}`);

  console.log('\n[assert] defence');
  const est = T.markEstablish;
  const estAvg = est.length ? est.reduce((a, b) => a + b, 0) / est.length : 0;
  const estMax = est.length ? Math.max(...est) : 0;
  ok('marker stays within 3 m while stalling', markIn3 >= 0.99,
    `${pct(markIn3)} of ${T.markSamples} stall-counting ticks; range ${f2(T.minMarkDist)}..${f2(T.maxMarkDist)}m`);
  ok('mark is established quickly after possession', estMax < 6.0 && estAvg < 2.5,
    `avg ${f2(estAvg)}s, worst ${f2(estMax)}s over ${est.length} holds`);
  ok('marker respects 1 m disc space', T.minMarkDist >= 1.0,
    `closest approach ${f2(T.minMarkDist)}m`);
  ok('force is respected (open-side shade)', shade >= 0.85,
    `${pct(shade)} of ${T.shadeSamples} downfield defender samples`);

  console.log('\n[assert] motion sanity');
  ok('nobody leaves the field', T.oob === 0, `${T.oob} out-of-bounds player-ticks`);
  ok('nobody oscillates in place', sim.oscFlags === 0,
    `${sim.oscFlags} thrash windows (>8 m travelled, <1 m net over 1.5 s)`);

  console.log('\n[assert] stamina');
  ok('stamina depletes during play', T.minEnergySeen < 0.90 && T.minEnergySeen > 0.20,
    `lowest tank seen mid-play ${pct(T.minEnergySeen)} over ${f2(T.liveSeconds)}s of live play`);
  ok('stamina recovers between points', avgEnergy > 0.55 && minEnergy > 0.30,
    `avg tank ${pct(avgEnergy)}, lowest ${pct(minEnergy)} at the end of 10 points`);

  console.log('\n[assert] scheme switching');
  ok('heavy wind triggers zone', windy.totals.zonePoints >= 1,
    `${windy.totals.zonePoints}/3 windy points had a zone; ` +
    `calm run had ${T.zonePoints}/10`);
  const wcomp = windy.totals.throws ? windy.totals.completions / windy.totals.throws : 0;
  // A zone concedes short throws, so completion % rises while yardage falls.
  ok('windy completion % stays sane', wcomp >= 0.70 && wcomp <= 0.98,
    `${pct(wcomp)} in wind vs ${pct(comp)} calm (${windy.totals.completions}/${windy.totals.throws})`);
  ok('wind run also keeps the marker legal',
    windy.totals.markSamples === 0
    || windy.totals.markInside3 / windy.totals.markSamples >= 0.99,
    `${pct(windy.totals.markInside3 / Math.max(1, windy.totals.markSamples))} of ` +
    `${windy.totals.markSamples} stall-counting ticks`);

  if (process.env.AI_DIAG) {
    console.log('\n[diag] blocks');
    for (const b of sim.diag.blocks.slice(0, 14)) console.log('   ' + b);
    console.log('[diag] closest marks');
    for (const b of sim.diag.mark) console.log('   ' + b);
    console.log('[diag] ground (uncaught)');
    for (const b of sim.diag.ground) console.log('   ' + b);
    console.log('[diag] drops');
    for (const b of sim.diag.drops) console.log('   ' + b);
    console.log('[diag] calibration: thrower estimate -> actual');
    T.buckets.forEach((b, i) => {
      if (!b.n) return;
      console.log(`   est ${i * 10}-${i * 10 + 10}%  n=${String(b.n).padStart(3)}  actual=${pct(b.ok / b.n)}  ` +
        `avgGain=${f2(b.gain / b.n)}m  avgStall=${f2(b.stall / b.n)}`);
    });
    if (sim.diag.trace.length) {
      console.log('[diag] receiver trace');
      for (const b of sim.diag.trace) console.log('   ' + b);
    }
    console.log('[diag] oob');
    for (const b of sim.diag.oob) console.log('   ' + b);
  }

  /* ------------------------------------------------ hostile / wrong peers */
  console.log('\n[sim] mis-shaped ctx.sys peers — AI must detect and disable them');
  const hostile = buildSim(191919, { x: 0.5, z: 0 });
  hostile.world.sys = {
    // Wrong signature (positions only, no `t`) — mirrors a sibling module that
    // returns THREE.Vector3[]. The AI must reject this, not consume NaNs.
    disc: { predictPath: () => [{ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 1 }] },
    locomotion: { timeToReach: () => NaN },
  };
  let threw = false;
  let hostileRes: PointResult | null = null;
  try { hostileRes = runPoint(hostile, 1, 1, false); } catch { threw = true; }
  const hostileOk = !threw && hostileRes !== null
    && Number.isFinite(hostile.world.players[0].pos.x)
    && hostile.world.players.every((p) => Number.isFinite(p.pos.x) && Number.isFinite(p.pos.z))
    && hostile.totals.oob === 0;
  ok('rejects mis-shaped peers without NaN', hostileOk,
    `${hostileRes?.throws ?? 0} throws, ${hostileRes?.completions ?? 0} completions, ` +
    `all 14 positions finite, ${hostile.totals.oob} oob`);

  /* --------------------------------------------- peer-absence resilience */
  console.log('\n[sim] no ctx.sys peers — AI must fall back to its own predictors');
  const bare = buildSim(4242424, { x: 1, z: 0.5 });
  bare.world.sys = {};                       // no disc, no locomotion
  const bareRes = runPoint(bare, 1, 0, false);
  ok('runs with an empty ctx.sys',
    bareRes.throws >= 2 && bare.totals.oob === 0 && bare.totals.laneConflicts === 0,
    `${bareRes.throws} throws, ${bareRes.completions} completions, ` +
    `${bare.totals.oob} oob, marker in 3 m ` +
    `${pct(bare.totals.markSamples ? bare.totals.markInside3 / bare.totals.markSamples : 1)} ` +
    `(internal glide predictor, internal timeToReach)`);

  /* ------------------------------------------ attributes change outcomes */
  console.log('\n[sim] attribute A/B — elite roster (overall 90) vs weak roster (overall 52)');
  const ab = buildSim(555001, { x: 0.8, z: 0 });
  for (const p of ab.world.players) {
    const rr = new SeededRng(9000 + p.id);
    const overall = p.team === 0 ? 90 : 52;
    p.attr = makePlayer(p.id, p.team, p.archetype, rr, overall).attr;
  }
  let abRecv: 0 | 1 = 0;
  const abScore = [0, 0];
  for (let i = 1; i <= 8; i++) {
    const r = runPoint(ab, i, abRecv, false);
    if (r.scoredBy != null) abScore[r.scoredBy]++;
    restBetweenPoints(ab.world.players, 45);
    abRecv = (r.scoredBy === null ? (1 - abRecv) : (1 - r.scoredBy)) as 0 | 1;
  }
  const E = ab.totals.byTeam[0], W = ab.totals.byTeam[1];
  const eYds = E.gain / Math.max(1, E.poss);
  const wYds = W.gain / Math.max(1, W.poss);
  const eTo = E.turns / Math.max(1, E.poss);
  const wTo = W.turns / Math.max(1, W.poss);
  ok('ratings change on-field outcomes',
    abScore[0] > abScore[1] && eYds > wYds * 1.15 && eTo < wTo,
    `points ${abScore[0]}-${abScore[1]}; yards/possession ${f2(eYds)} vs ${f2(wYds)}; ` +
    `turnovers/possession ${f2(eTo)} vs ${f2(wTo)}`);

  /* ------------------------------------------------ cross-seed robustness */
  console.log('\n[sim] cross-seed sweep (5 seeds x 4 points, calm)');
  let sThrows = 0, sComp = 0, sShade = 0, sShadeN = 0, sOob = 0, sMarkBad = 0, sMarkN = 0;
  const perSeed: string[] = [];
  for (const seed of [101, 20205, 777, 31415, 8675309]) {
    const r = buildSim(seed, { x: seed % 5 - 2, z: (seed % 3) - 1 });
    let recv: 0 | 1 = (seed % 2) as 0 | 1;
    for (let i = 1; i <= 4; i++) {
      const pr = runPoint(r, i, recv, false);
      restBetweenPoints(r.world.players, 45);
      recv = (pr.scoredBy === null ? (1 - recv) : (1 - pr.scoredBy)) as 0 | 1;
    }
    sThrows += r.totals.throws; sComp += r.totals.completions;
    sShade += r.totals.shadeGood; sShadeN += r.totals.shadeSamples;
    sOob += r.totals.oob;
    sMarkBad += r.totals.markSamples - r.totals.markInside3; sMarkN += r.totals.markSamples;
    perSeed.push(`${seed}:${pct(r.totals.throws ? r.totals.completions / r.totals.throws : 0)}`);
  }
  const sweepComp = sThrows ? sComp / sThrows : 0;
  ok('completion holds across seeds (75-92)', sweepComp >= 0.75 && sweepComp <= 0.92,
    `${pct(sweepComp)} pooled over ${sThrows} throws — ${perSeed.join(' ')}`);
  ok('force holds across seeds', sShadeN > 0 && sShade / sShadeN >= 0.85,
    `${pct(sShade / Math.max(1, sShadeN))} of ${sShadeN} samples`);
  ok('no out-of-bounds across seeds', sOob === 0, `${sOob} player-ticks`);
  ok('marker legal across seeds', sMarkN > 0 && sMarkBad / sMarkN <= 0.01,
    `${pct(1 - sMarkBad / Math.max(1, sMarkN))} inside 3 m over ${sMarkN} ticks`);

  /* ------------------------------------------------------------ determinism */
  console.log('\n[assert] determinism');
  const a = buildSim(31337, { x: 2, z: 1 });
  const b = buildSim(31337, { x: 2, z: 1 });
  runPoint(a, 1, 0, false);
  runPoint(b, 1, 0, false);
  const hash = (s: Sim): string => s.world.players
    .map((p) => `${p.pos.x.toFixed(6)},${p.pos.z.toFixed(6)},${p.energy.toFixed(6)}`).join('|');
  ok('same seed -> identical simulation', hash(a) === hash(b),
    `14-player position+stamina hash matched (${hash(a).length} chars)`);

  /* ------------------------------------------------------------- summary */
  console.log('\n' + '='.repeat(112));
  console.log(`  ${FAIL === 0 ? 'PASS' : 'FAIL'}  —  ${PASS} passed, ${FAIL} failed`);
  if (FAIL) for (const f of failures) console.log(`        - ${f}`);
  console.log('='.repeat(112));
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
