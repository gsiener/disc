/**
 * tools/test-ai.ts — headless verification of src/sim/AI.ts + src/sim/Playbook.ts
 *
 *   node tools/test-ai.ts
 *   AI_MAP=1 node tools/test-ai.ts      # top-down ASCII of the shape, live
 *   AI_DIAG=1 node tools/test-ai.ts     # turnover / calibration diagnostics
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
 *
 * ---------------------------------------------------------------------------
 * AND — the section that exists because the off-ball game has to READ as
 * ultimate, not merely be legal — `[assert] shape` measures the four things a
 * viewer actually reads off bodies who do not have the disc, in numbers:
 *
 *   STACK    is the offence a downfield COLUMN? Measured as the RMS
 *            perpendicular residual of the non-cutting cutters about their own
 *            best-fit line (total least squares), the alignment of that line
 *            with the attacking direction, and the front-to-back gaps along it.
 *            "Fourteen bodies with no relationship to each other" is a residual
 *            of 4 m; a stack is a residual under 2 m.
 *   LANES    is the cutting lane EMPTY? Measured as the fraction of held frames
 *            with a non-cutting offensive body parked inside the open-side
 *            under lane. A cutter who lingers there is what makes a field look
 *            like a crowd.
 *   CLEARING when a cut dies, how many seconds until that player is out of the
 *            way (back in the column, behind the disc, or beyond the deep lane)?
 *   DUMP     what fraction of held frames have a reset handler genuinely behind
 *            the disc, in range, and not covered? And at stall >= 7, when it is
 *            the only throw left?
 *   FORCE    is the mark POSITIONALLY on the break side, or is the force merely
 *            a label on a config object?
 *
 * Every one of these is derived independently of the AI's own bookkeeping —
 * from player positions and an independent derivation of the open side — so the
 * assertions cannot be satisfied by the AI simply agreeing with itself.
 */

import {
  createTeamAI, updateTeam, makePlayer, catchProbability, reachHeight,
  restBetweenPoints, layoutExtend, effectiveMaxSpeed, effectiveAccel, shouldBid,
  type AIPlayer, type AIWorld, type PlayerIntent, type DiscState,
  type Archetype, type FlightSample, type TeamAI, type PlayerAction,
  type TeamConfig,
} from '../src/sim/AI.ts';
import {
  FIELD, SeededRng, clamp, dist2, openSideSign, markPoint, formationStations,
  type AttackDir,
  openSideFor, breakSideFor, FORCE_DEADBAND, chooseFormation, stackColumnX, PLAY,
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

/* --------------------------------------------------------- layout audit
 *
 * A layout is a full-extension dive and in ultimate it is a LAST RESORT: you
 * leave your feet because you cannot get there on them, and it reads as
 * dramatic precisely because it is rare. The AI once bid on any disc that was
 * not already at a player's feet — the defensive gate was a 0.2 m deficit and
 * the offensive one 0.7 m, both INSIDE the 0.82 m a standing catch reaches —
 * and the result was more layouts than completions.
 *
 * Everything below re-derives, from the disc stub's own flight and the
 * player's own ratings, whether the bidder could have run it down upright. It
 * never asks the AI what it thought the gap was, so the assertions cannot be
 * satisfied by the AI agreeing with itself.
 */

/** Horizontal reach for a standing catch, and the height below which there is
 *  no standing catch at all. Both quoted from Game.ts (`CATCH_REACH`, `bot`). */
const STAND_REACH = 0.82;
const STAND_FLOOR = 0.20;

/**
 * Could this player have caught/blocked it ON HIS FEET?
 *
 * Walks the rest of the flight and asks, at every step where the disc is still
 * high enough for a standing catch, whether he can cover the ground to within
 * standing reach of it in the time available. The sprint model is deliberately
 * GENEROUS — a straight line from his current speed at his own acceleration and
 * top speed, no turn cost, no traffic — so a bid it condemns is one no amount of
 * running would have justified. `slack` is the metres to spare at the best such
 * moment: positive means he could have got there with room, negative means the
 * disc was genuinely out of reach and the dive was the only play.
 */
function standingSlack(p: AIPlayer, fl: Flight): number {
  const v = Math.hypot(p.vel.x, p.vel.z);
  const top = effectiveMaxSpeed(p);
  const acc = Math.max(0.1, effectiveAccel(p));
  const tTop = Math.max(0, (top - v) / acc);
  let best = -1e9;
  for (let T = 1 / 60; T <= 2.5; T += 1 / 60) {
    const s = sampleFlight(fl, fl.t + T);
    if (s.y < STAND_FLOOR) break;               // gone; no standing catch below this
    const need = Math.hypot(s.x - p.pos.x, s.z - p.pos.z) - STAND_REACH;
    const run = T <= tTop
      ? v * T + 0.5 * acc * T * T
      : v * tTop + 0.5 * acc * tTop * tTop + top * (T - tTop);
    best = Math.max(best, run - need);
  }
  return best;
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

/* =============================================== structural telemetry ==== */

/**
 * Everything in this block is computed from PLAYER POSITIONS and an
 * independent derivation of the open side. It never asks the AI what shape it
 * thinks it is in — that would only assert that the AI agrees with itself.
 */

interface DeadCut { id: number; t: number; x: number; z: number; poss: number }

interface StructAcc {
  /** previous frame's cut state per offensive player, for edge detection */
  prev: Map<number, string>;
  pending: DeadCut[];
  /* stack shape (a stack formation, disc held, shape settled) */
  frames: number;
  eligible: number;
  residSum: number; residMax: number; residWorst: string;
  axisSum: number;
  memberSum: number;
  gapN: number; gapSum: number; gapMin: number; gapTight: number;
  spanSum: number; leadSum: number;
  /* lane occupancy */
  laneFrames: number; laneOccSum: number; laneBusy: number;
  /* clearing */
  clearN: number; clearSum: number; clearMax: number; clearSlow: number; clearNever: number;
  /* dump — position and openness are measured separately, because a reset
   * that is standing in the right place with a defender on his hip is a
   * different failure from no reset existing at all. */
  dumpFrames: number; dumpPos: number; dumpOpen: number;
  dumpDistSum: number; dumpDistN: number; dumpSepSum: number; dumpSepN: number;
  dump7Frames: number; dump7Pos: number; dump7Open: number;
  /** why no reset was in position: nobody behind / too far / wrong side */
  dumpWhy: [number, number, number];
  /* force */
  markFrames: number; markBreak: number; markOffSum: number; markOffMin: number;
  /* does the offence agree with the defence about which side is open? */
  openFrames: number; openAgree: number;
  /* formation census, live held frames */
  formCount: Record<string, number>; formTotal: number;
  /** how many bodies were in the column: index = count, capped at 6 */
  memberHist: number[];
  /** where the rest of the offence was, averaged over the same frames */
  awayCut: number; awayShort: number; awayBehind: number;
  /** AI_MAP snapshots */
  maps: string[];
  mapCd: number;
}

function newStruct(): StructAcc {
  return {
    prev: new Map(), pending: [],
    frames: 0, eligible: 0, residSum: 0, residMax: 0, residWorst: '',
    axisSum: 0, memberSum: 0,
    gapN: 0, gapSum: 0, gapMin: 1e9, gapTight: 0, spanSum: 0, leadSum: 0,
    laneFrames: 0, laneOccSum: 0, laneBusy: 0,
    clearN: 0, clearSum: 0, clearMax: 0, clearSlow: 0, clearNever: 0,
    dumpFrames: 0, dumpPos: 0, dumpOpen: 0,
    dumpDistSum: 0, dumpDistN: 0, dumpSepSum: 0, dumpSepN: 0,
    dump7Frames: 0, dump7Pos: 0, dump7Open: 0, dumpWhy: [0, 0, 0],
    markFrames: 0, markBreak: 0, markOffSum: 0, markOffMin: 1e9,
    openFrames: 0, openAgree: 0,
    formCount: {}, formTotal: 0, memberHist: [0, 0, 0, 0, 0, 0, 0],
    awayCut: 0, awayShort: 0, awayBehind: 0,
    maps: [], mapCd: 0,
  };
}

/**
 * Total-least-squares line fit through a set of XZ points.
 * `resid` is the RMS PERPENDICULAR distance to the fitted line — the honest
 * measure of "do these bodies form a line", independent of the line's angle.
 */
function fitLine(pts: Array<{ x: number; z: number }>): {
  resid: number; ax: number; az: number; along: number[];
} {
  const n = pts.length;
  let mx = 0, mz = 0;
  for (const p of pts) { mx += p.x; mz += p.z; }
  mx /= n; mz /= n;
  let sxx = 0, sxz = 0, szz = 0;
  for (const p of pts) {
    const dx = p.x - mx, dz = p.z - mz;
    sxx += dx * dx; sxz += dx * dz; szz += dz * dz;
  }
  sxx /= n; sxz /= n; szz /= n;
  const tr = sxx + szz;
  const det = sxx * szz - sxz * sxz;
  const disc = Math.max(0, tr * tr / 4 - det);
  const l1 = tr / 2 + Math.sqrt(disc);          // major
  const l2 = Math.max(0, tr / 2 - Math.sqrt(disc));   // minor == mean sq residual
  let ax = sxz, az = l1 - sxx;
  if (Math.hypot(ax, az) < 1e-9) { ax = 1; az = 0; }
  const al = Math.hypot(ax, az);
  ax /= al; az /= al;
  const along = pts.map((p) => (p.x - mx) * ax + (p.z - mz) * az);
  return { resid: Math.sqrt(l2), ax, az, along };
}

/** The open-side under lane, the piece of field a cut is supposed to attack. */
function inOpenLane(
  px: number, pz: number, dx: number, dz: number, dir: number, openSign: number,
): boolean {
  const df = dir * (pz - dz);
  const lat = (px - dx) * openSign;
  return df > 2.5 && df < 18 && lat > 1.5 && lat < 12;
}

/**
 * Is this body out of the way? Either back in the central column, or behind
 * the disc, or deep enough to be past the under lane entirely. This is the
 * definition a clearing cutter has to satisfy.
 */
function outOfTheWay(
  px: number, pz: number, dx: number, dz: number, dir: number, openSign: number,
): boolean {
  const df = dir * (pz - dz);
  const lat = (px - dx) * openSign;
  return Math.abs(lat) <= 4.0 || df <= 1.0 || df >= 22;
}

function asciiMap(
  world: AIWorld, off: 0 | 1, dir: AttackDir, openSign: number, label: string,
): string {
  // 1 column ~ 1.6 m across, 1 row ~ 2.6 m downfield; +dir is drawn to the right.
  const W = 48, H = 25;
  const grid: string[][] = Array.from({ length: H }, () => Array(W).fill('.'));
  const put = (x: number, z: number, ch: string): void => {
    const col = Math.round((dir * z + 50) / 100 * (W - 1));
    const row = Math.round((-x * openSign + FIELD.halfWidth) / (2 * FIELD.halfWidth) * (H - 1));
    if (col >= 0 && col < W && row >= 0 && row < H) grid[row][col] = ch;
  };
  for (const p of world.players) put(p.pos.x, p.pos.z, p.team === off ? 'O' : 'x');
  put(world.disc.pos.x, world.disc.pos.z, '@');
  const rows = grid.map((r) => '   |' + r.join('') + '|');
  return [`   ${label}   (rows: break side at top, open side at bottom; `
    + 'columns: own end line -> attacking end line)', ...rows].join('\n');
}

function collectStructure(
  S: StructAcc, world: AIWorld, byId: Map<number, AIPlayer>,
  offTeam: TeamAI, defTeam: TeamAI,
  offIntents: PlayerIntent[], t: number, dt: number, heldFor: number, poss: number,
): void {
  const disc = world.disc;
  const dir = offTeam.dir as AttackDir;
  // The truth of the force comes from the DEFENCE's call, derived here from
  // hand geometry rather than read off the AI.
  const openSign = defTeam.currentScheme === 'zone'
    ? offTeam.openSign
    : expectedOpenSign(defTeam.force as 'forehand' | 'backhand', dir);
  const dx = disc.pos.x, dz = disc.pos.z;

  /* ---- cut deaths, tracked in every live frame (a cut can die in flight) */
  for (const it of offIntents) {
    const was = S.prev.get(it.id);
    const now = it.debug.state;
    if (was === 'break' && now !== 'break' && it.id !== disc.intendedReceiver) {
      const p = byId.get(it.id);
      if (p) S.pending.push({ id: it.id, t, x: p.pos.x, z: p.pos.z, poss });
    }
    S.prev.set(it.id, now);
  }
  for (let i = S.pending.length - 1; i >= 0; i--) {
    const d = S.pending[i];
    const p = byId.get(d.id);
    const age = t - d.t;
    if (!p || d.poss !== poss) { S.pending.splice(i, 1); continue; }
    if (outOfTheWay(p.pos.x, p.pos.z, dx, dz, dir, openSign)) {
      S.clearN++; S.clearSum += age;
      if (age > S.clearMax) S.clearMax = age;
      if (age > 2.0) S.clearSlow++;
      S.pending.splice(i, 1);
    } else if (age > 6.0) {
      S.clearN++; S.clearSum += 6.0; S.clearNever++; S.clearSlow++;
      S.clearMax = Math.max(S.clearMax, 6.0);
      S.pending.splice(i, 1);
    }
  }

  if (disc.state !== 'held' || disc.carrier == null) return;
  const thrower = byId.get(disc.carrier);
  if (!thrower) return;

  S.formCount[offTeam.currentFormation] = (S.formCount[offTeam.currentFormation] ?? 0) + 1;
  S.formTotal++;
  if (disc.stall >= 1.0) {
    S.openFrames++;
    if (offTeam.openSign === openSign) S.openAgree++;
  }

  /* ---- the mark: positional force, not a label */
  const mk = defTeam.marker >= 0 ? byId.get(defTeam.marker) : null;
  // Judged once the mark is SET — the stall clock only runs while the marker
  // is inside the stall radius, so a count of 1 means he has been there for a
  // second. Sampling the run-in would be measuring a sprint, not a force.
  if (mk && defTeam.currentScheme === 'person' && disc.stall >= 1.0) {
    const md = dist2(mk.pos.x, mk.pos.z, thrower.pos.x, thrower.pos.z);
    if (md <= 4.0) {
      const off = (mk.pos.x - thrower.pos.x) * -openSign;   // + = on the break side
      S.markFrames++;
      if (off >= 0.4) S.markBreak++;
      S.markOffSum += off;
      if (off < S.markOffMin) S.markOffMin = off;
    }
  }

  /* ---- the dump.
   * A reset is IN POSITION when he is genuinely behind the disc, in throwing
   * range, and not on the far side of the mark (a reset thrown through the
   * mark is the most punished decision in the sport). He is OPEN when he also
   * has daylight from his defender. */
  let bestD = -1; let bestSep = -1;
  let anyBehind = false; let anyRange = false;
  for (const r of world.players) {
    if (r.team !== poss || r.id === thrower.id) continue;
    const df = dir * (r.pos.z - dz);
    if (df > -1.0) continue;
    anyBehind = true;
    if (df < -16) continue;
    const d = dist2(r.pos.x, r.pos.z, dx, dz);
    if (d < 3.0 || d > 16) continue;
    anyRange = true;
    // Not behind the mark — with one exception that is the sport rather than a
    // loophole: when the disc is trapped near a sideline the reset that matters
    // is the swing back toward the middle, and depending on which way the force
    // is set that is the break side of the disc. A handler moving the disc away
    // from the line is resetting, not throwing into the mark.
    const lat = (r.pos.x - dx) * openSign;
    const toMiddle = Math.abs(r.pos.x) < Math.abs(dx) - 1.0;
    if (lat < -6 && !toMiddle) continue;
    let sep = 1e9;
    for (const f of world.players) {
      if (f.team === poss) continue;
      sep = Math.min(sep, dist2(f.pos.x, f.pos.z, r.pos.x, r.pos.z));
    }
    if (sep > bestSep) { bestSep = sep; bestD = d; }
  }
  const posOk = bestD >= 0;
  if (!posOk) S.dumpWhy[!anyBehind ? 0 : !anyRange ? 1 : 2]++;
  // "Open" is 1.5 m of daylight. The bar is set by the DEFENCE's own numbers,
  // not picked: person coverage shades `PLAY.shadeOpen` 1.75 m across and
  // `underGap` 0.9 m under, so a correctly covered handler standing still sits
  // at about 1.9 m. Anything above roughly that can only be produced by a
  // handler who is moving; 1.5 m means his defender is not on him.
  const openOk = posOk && bestSep >= 1.5;
  // The reset is judged once the possession has settled — nobody expects a
  // handler to be in position in the same frame a cutter catches it 20 m
  // downfield. The stall >= 7 case gets no such allowance.
  if (heldFor >= 1.0) {
    S.dumpFrames++;
    if (posOk) { S.dumpPos++; S.dumpDistSum += bestD; S.dumpDistN++; S.dumpSepSum += bestSep; S.dumpSepN++; }
    if (openOk) S.dumpOpen++;
  }
  if (disc.stall >= 7) {
    S.dump7Frames++;
    if (posOk) S.dump7Pos++;
    if (openOk) S.dump7Open++;
  }

  /* ---- lane occupancy: is the cutting lane actually empty? */
  S.laneFrames++;
  let occ = 0;
  for (const it of offIntents) {
    if (it.id === thrower.id) continue;
    const st = it.debug.state;
    if (st === 'setup' || st === 'plant' || st === 'break') continue;  // a live cut belongs there
    const p = byId.get(it.id);
    if (!p) continue;
    if (inOpenLane(p.pos.x, p.pos.z, dx, dz, dir, openSign)) occ++;
  }
  S.laneOccSum += occ;
  if (occ > 0) S.laneBusy++;

  /* ---- the stack, once the shape has had a moment to set.
   * `vertical` and `side` are both COLUMNS and both have to read as one;
   * `horizontal` and `endzone` are spread sets and are excluded. */
  const isStackSet = offTeam.currentFormation === 'vertical'
    || offTeam.currentFormation === 'side';
  if (!isStackSet || heldFor < 1.2) return;
  S.eligible++;
  // Membership is GEOMETRIC, not a state name: every offensive body that is
  // downfield of the disc and not away attacking a lane. That is exactly the
  // set a viewer sees as "the stack", and it means the shape cannot be made to
  // look good by relabelling internal states.
  const members: Array<{ x: number; z: number; id: number }> = [];
  for (const it of offIntents) {
    if (it.id === thrower.id) continue;
    const st = it.debug.state;
    if (st === 'setup' || st === 'plant' || st === 'break') { S.awayCut++; continue; }
    const p = byId.get(it.id);
    if (!p) continue;
    const df = dir * (p.pos.z - dz);
    if (df < 2.5) {                                           // handlers sit behind
      if (df < -1) S.awayBehind++; else S.awayShort++;
      continue;
    }
    members.push({ x: p.pos.x, z: p.pos.z, id: p.id });
  }
  S.memberSum += members.length;
  S.memberHist[Math.min(6, members.length)]++;
  if (members.length < 3) return;

  const fit = fitLine(members);
  S.frames++;
  S.residSum += fit.resid;
  if (fit.resid > S.residMax) {
    S.residMax = fit.resid;
    S.residWorst = members
      .map((m) => `#${m.id}(${f2(m.x)},${f2(m.z)})`).join(' ')
      + ` disc(${f2(dx)},${f2(dz)})`;
  }
  S.axisSum += Math.abs(fit.az);              // 1 = the column points downfield
  const sorted = fit.along.slice().sort((a, b) => a - b);
  S.spanSum += sorted[sorted.length - 1] - sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i] - sorted[i - 1];
    S.gapN++; S.gapSum += g;
    if (g < S.gapMin) S.gapMin = g;
    if (g < 3.0) S.gapTight++;
  }
  // How far in front of the disc the front of the stack sits.
  let front = 1e9;
  for (const m of members) front = Math.min(front, dir * (m.z - dz));
  S.leadSum += front;

  if (process.env.AI_MAP && S.maps.length < 6) {
    S.mapCd -= dt;
    if (S.mapCd <= 0 && disc.stall > 2) {
      S.mapCd = 9;
      S.maps.push(asciiMap(world, poss as 0 | 1, dir, openSign,
        `stall ${disc.stall.toFixed(1)}  resid ${f2(fit.resid)}m  ` +
        `gaps ${sorted.slice(1).map((v, i) => f2(v - sorted[i])).join('/')}m`));
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
  /**
   * Pin the stall count at zero — a defence that never establishes a mark and
   * therefore never produces a count. The offence must still play.
   */
  noStall?: boolean;
  world: AIWorld;
  teams: [TeamAI, TeamAI];
  disc: DiscStub;
  byId: Map<number, AIPlayer>;
  points: PointResult[];
  oscFlags: number;
  diag: { blocks: string[]; oob: string[]; mark: string[]; markOut: string[]; ground: string[]; drops: string[]; trace: string[] };
  lastIntents?: PlayerIntent[];
  /** Attached only by the shape run; costs nothing when absent. */
  struct?: StructAcc;
  totals: {
    throws: number; completions: number;
    turnovers: Record<string, number>;
    laneConflicts: number; overCutBudget: number; oob: number;
    markSamples: number; markInside3: number; minMarkDist: number; maxMarkDist: number;
    shadeSamples: number; shadeGood: number;
    minLiveCutGap: number; minStackGap: number; minCutTargetGap: number;
    maxHold: number; maxHoldWhere: string; deadPoints: number;
    zonePoints: number; personPoints: number;
    endEnergy: number[];
    markEstablish: number[];
    worstStack: string;
    worstTargets: string;
    minEnergySeen: number;
    liveSeconds: number;
    /** one entry per bid: metres of slack a standing play would have had */
    bidSlack: number[];
    bidsOff: number; bidsDef: number;
    worstBids: string[];
    expectedSum: number;
    byTeam: { throws: number; comp: number; gain: number; turns: number; poss: number }[];
    buckets: { n: number; ok: number; gain: number; stall: number }[];
    /**
     * Cuts started, by kind, with the depth in the column they were offered
     * from. WHICH POSITION RUNS WHICH CUT IS THE VERTICAL STACK — everything
     * else about a cut looks the same from outside — so this is the handle the
     * shape assertions need. `upLineAborts` counts up-lines that turned back
     * into a reset instead of dying, which is the contract that lets the sole
     * handler leave at all.
     */
    cutKinds: Map<string, { n: number; depthSum: number; depthN: number }>;
    upLines: number;
    upLineAborts: number;
  };
}

const DT = 1 / 120;
const ARCHES: Archetype[] = ['handler', 'handler', 'handler', 'cutter', 'cutter', 'deep', 'utility'];

function buildSim(
  seed: number, wind: { x: number; z: number },
  cfg?: [Partial<TeamConfig>, Partial<TeamConfig>],
): Sim {
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
    createTeamAI(0, 1 as AttackDir, rng.fork(11), cfg?.[0] ?? {
      formation: 'vertical', force: 'forehand', aggression: 1.05, zoneBias: -0.2, seed: 3,
    }),
    createTeamAI(1, -1 as AttackDir, rng.fork(22), cfg?.[1] ?? {
      formation: 'horizontal', force: 'backhand', aggression: 0.95, zoneBias: 0.05, seed: 5,
    }),
  ];

  return {
    world, teams, disc, byId, points: [], oscFlags: 0,
    diag: { blocks: [], oob: [], mark: [], markOut: [], ground: [], drops: [], trace: [] },
    totals: {
      throws: 0, completions: 0, turnovers: {},
      laneConflicts: 0, overCutBudget: 0, oob: 0,
      markSamples: 0, markInside3: 0, minMarkDist: 1e9, maxMarkDist: 0,
      shadeSamples: 0, shadeGood: 0,
      minLiveCutGap: 1e9, minStackGap: 1e9, minCutTargetGap: 1e9,
      maxHold: 0, maxHoldWhere: '', deadPoints: 0,
      zonePoints: 0, personPoints: 0, endEnergy: [],
      markEstablish: [], worstStack: '', worstTargets: '',
      minEnergySeen: 1, liveSeconds: 0, expectedSum: 0,
      bidSlack: [], bidsOff: 0, bidsDef: 0, worstBids: [],
      byTeam: [0, 1].map(() => ({ throws: 0, comp: 0, gain: 0, turns: 0, poss: 1 })),
      buckets: Array.from({ length: 10 }, () => ({ n: 0, ok: 0, gain: 0, stall: 0 })),
      cutKinds: new Map(), upLines: 0, upLineAborts: 0,
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
  /** bodies that have already declared a bid on the live flight */
  const bidSeen = new Set<number>();
  /** Last frame's cut state per player, for detecting cut starts and aborts. */
  const cutWas = new Map<number, { state: string; kind: string | null }>();
  let lastThrow: { aimX: number; aimZ: number; recv: number; exp: number; d: number; atRelease: number; tf: number; vAtRelease: number; minGap: number; minGapY: number } | null = null;

  while (t < maxT) {
    world.time += DT;
    t += DT;

    if (disc.state.state === 'held' && disc.state.carrier != null) {
      if (disc.state.carrier !== carrierSeen) {
        carrierSeen = disc.state.carrier; heldFor = 0; markStart = -1;
      }
      heldFor += DT;
      if (heldFor > sim.totals.maxHold) {
        sim.totals.maxHold = heldFor;
        const th = byId.get(disc.state.carrier)!;
        const mkr = teams[world.possession === 0 ? 1 : 0].marker;
        const mk = mkr >= 0 ? byId.get(mkr) : null;
        sim.totals.maxHoldWhere =
          `#${disc.state.carrier} held ${f2(heldFor)}s at (${f2(th.pos.x)},${f2(th.pos.z)}), ` +
          `stall ${f2(disc.state.stall)}, marker #${mkr} ` +
          `${mk ? `${f2(dist2(mk.pos.x, mk.pos.z, th.pos.x, th.pos.z))}m away` : 'none'}`;
      }
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

    /* ------------------------------------------------------- layout audit
     * One entry per body per flight, taken on the frame the bid is first
     * declared and against the disc state the AI itself was looking at.
     */
    if (disc.state.state === 'flight' && disc.flight) {
      for (const it of intents) {
        if (it.action?.kind !== 'bid' && it.mode !== 'layout') continue;
        if (bidSeen.has(it.id)) continue;
        bidSeen.add(it.id);
        const p = byId.get(it.id)!;
        const slack = standingSlack(p, disc.flight);
        sim.totals.bidSlack.push(slack);
        if (it.team === world.possession) sim.totals.bidsOff++;
        else sim.totals.bidsDef++;
        if (slack > 0 && sim.totals.worstBids.length < 8) {
          sim.totals.worstBids.push(
            `#${it.id}${it.team === world.possession ? 'O' : 'D'} bid with ${f2(slack)}m of `
            + `standing slack at ${(disc.flight.t / disc.flight.tf).toFixed(2)} of the flight`);
        }
      }
    }

    /* ------------------------------------------------- structural checks */
    if (world.phase === 'live') {
      const offIntents = world.possession === 0 ? iA : iB;
      const defIntents = world.possession === 0 ? iB : iA;
      const defTeam = teams[world.possession === 0 ? 1 : 0];
      const offTeam = teams[world.possession];

      if (sim.struct) {
        collectStructure(sim.struct, world, byId, offTeam, defTeam, offIntents,
          world.time, DT, heldFor, world.possession);
      }

      /**
       * Cut starts, by kind and by the depth they were offered from.
       *
       * A cut begins on the transition INTO `setup`, which is the only frame it
       * can be counted on without double-counting the whole run. The up-line
       * abort is the transition from an up-line straight into a reset lane
       * without passing through `stack` — see the `break` branch in
       * `tickHandlerCuts`.
       */
      for (const it of offIntents) {
        const d = it.debug as { state: string; cutKind?: string | null; cutDepth?: number };
        const prev = cutWas.get(it.id);
        const kind = d.cutKind ?? null;
        if (kind && d.state === 'setup' && prev?.state !== 'setup') {
          const e = sim.totals.cutKinds.get(kind) ?? { n: 0, depthSum: 0, depthN: 0 };
          e.n++;
          if ((d.cutDepth ?? -1) >= 0) { e.depthSum += d.cutDepth!; e.depthN++; }
          sim.totals.cutKinds.set(kind, e);
          if (kind === 'up-line') sim.totals.upLines++;
        }
        if (prev?.kind === 'up-line' && kind === 'dump' && prev.state !== 'stack') {
          sim.totals.upLineAborts++;
        }
        cutWas.set(it.id, { state: d.state, kind });
      }

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
      // "Settled" means ON his spot and stopped. At 1.5 m/s and 1.5 m out a
      // body is still walking into the shape — and since the column now
      // collapses to fill, two of them can legitimately pass each other on the
      // way to slots that are 4.2 m apart. The spacing being asserted is the
      // spacing of the formation, not of the traffic getting into it.
      const stacked = offIntents.filter((i) => {
        if (i.debug.state !== 'stack') return false;
        const p = byId.get(i.id)!;
        return Math.hypot(p.vel.x, p.vel.z) < 0.9
          && dist2(p.pos.x, p.pos.z, i.targetX, i.targetZ) < 1.1;
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
            if (d > 3.0 && sim.diag.markOut.length < 8) {
              sim.diag.markOut.push(`OUT d=${f2(d)} heldFor=${f2(heldFor)} stall=${f2(disc.state.stall)} ` +
                `thrower#${thrower.id}@(${f2(thrower.pos.x)},${f2(thrower.pos.z)}) ` +
                `v=${f2(Math.hypot(thrower.vel.x, thrower.vel.z))} marker#${p.id} ` +
                `v=${f2(Math.hypot(p.vel.x, p.vel.z))} mode=${mk.mode} ` +
                `tgt=(${f2(mk.targetX)},${f2(mk.targetZ)}) ds=${f2(mk.desiredSpeed)}`);
            }
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
        disc.state.stall = sim.noStall ? 0 : a.count;
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
        bidSeen.clear();
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
  if (res.throws === 0) sim.totals.deadPoints++;
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

  /* The bid gate, pinned directly. The sim assertions below bound how often a
   * layout happens; these say what a layout IS, so the rate cannot be met by a
   * gate that has simply been turned off — or drift back to the 0.2 m deficit
   * that produced more layouts than completions. `short` is metres from the
   * disc at the last moment a standing catch is still legal. */
  const bidder = makePlayer(96, 0, 'cutter', rng.fork(6), 75);
  const midfield = 0;                     // stakes: a possession, not a goal
  const bidCases: Array<[string, boolean, number, number, number]> = [
    // label                              expect  short  deadline  stakes
    ['0.5 m short — he runs it down',     false,  0.50,  0.30, midfield],
    ['0.8 m short — still inside reach',  false,  0.80,  0.30, midfield],
    ['1.3 m short — only a dive gets it', true,   1.30,  0.30, midfield],
    ['3.0 m short — a dive misses too',   false,  3.00,  0.30, midfield],
    ['1.3 m short but 1.5 s early',       false,  1.30,  1.50, midfield],
    ['1.05 m short at midfield',          false,  1.05,  0.30, midfield],
    ['1.05 m short with a goal on it',    true,   1.05,  0.30, 1],
  ];
  let gateOk = true;
  const wrong: string[] = [];
  for (const [label, want, short, deadline, stakes] of bidCases) {
    const got = shouldBid(bidder, short, deadline, stakes);
    if (got !== want) { gateOk = false; wrong.push(label); }
  }
  ok('a layout is only for a disc out of standing reach', gateOk,
    wrong.length ? `wrong: ${wrong.join("; ")}` : `${bidCases.length} cases`);
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
  console.log('\n[sim] 5 points, heavy wind (zone defence expected)');
  const windy = buildSim(777001, { x: 9.5, z: 2.0 });
  let recv2: 0 | 1 = 1;
  for (let i = 1; i <= 5; i++) {
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
  /**
   * ONE RUN CANNOT CARRY THE 75-92 BAND, and pretending it can is how a real
   * regression hides behind a threshold nobody trusts.
   *
   * This is a single 10-point match — call it 90 throws. At a true rate of 80%
   * the binomial standard deviation on 90 trials is 4.2 points, so a 75-92 band
   * is barely +/-1.5 sigma wide: an unchanged build lands outside it roughly one
   * run in eight. It duly did, on the shipped build and on the one before it,
   * at 74.2% and 69.3% — neither of which meant anything.
   *
   * So this one keeps a 3-sigma band, which is what a single sample can
   * actually support, and the real gate on completion is the 12-seed pooled
   * assertion further down (390 throws, standard error 2.0 points). Both are
   * reported, because the single-run figure is still worth READING even where
   * it is not worth failing on.
   */
  ok('completion % is plausible for one match (62-95)', comp >= 0.62 && comp <= 0.95,
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

  /* ------------------------------------- who runs which cut, and from where */
  {
    const K = T.cutKinds;
    const mean = (k: string): number => {
      const e = K.get(k);
      return e && e.depthN ? e.depthSum / e.depthN : NaN;
    };
    const n = (k: string): number => K.get(k)?.n ?? 0;
    const mix = [...K.entries()].sort((a, b) => b[1].n - a[1].n)
      .map(([k, e]) => `${k}:${e.n}${e.depthN ? `@${f2(e.depthSum / e.depthN)}` : ''}`).join(' ');

    ok('the offence runs a real cutting vocabulary', n('deep') > 0 && n('under') > 0,
      mix || 'no cuts at all');

    /**
     * THE FRONT OF THE STACK GOES DEEP AND THE BACK COMES UNDER.
     *
     * This is the rule the vertical stack is built on and it was inverted for
     * the whole life of the file — the front cutter came under into his own
     * defender's chest and the back cutter went deep into the only man on the
     * field already standing behind him. It cannot be seen from a cut's shape:
     * a deep cut looks like a deep cut wherever it started. Only the depth it
     * was offered from tells you whether the offence is playing the sport.
     */
    const deepD = mean('deep');
    const underD = mean('under');
    ok('deep cuts come from the front of the stack', deepD < 1.5,
      `mean depth ${f2(deepD)} over ${n('deep')} deep cuts`);
    ok('under cuts come from behind them', underD > deepD,
      `under ${f2(underD)} vs deep ${f2(deepD)}`);

    /**
     * And the under has to be RUNNABLE. The back of a five-deep column stands
     * `stackLead + 4 * stackSpacing` downfield and the under resolves in front
     * of the disc, so the cut is an 18-22 m sprint. Abandon it early enough and
     * the shape can never be thrown to at all, which is what a 2.2 s limit did.
     */
    const backRun = PLAY.stackLead + PLAY.stackSpacing * 4 - 9.5;
    ok('and the cut clock allows the run they have to make',
      PLAY.underCutTime >= backRun / 7.0,
      `${f2(PLAY.underCutTime)}s for a ${f2(backRun)}m sprint`);

    /**
     * THE UP-LINE ABORTS BACK TO THE RESET. That contract is the only reason
     * the sole handler behind the disc is allowed to leave — see the note on
     * the `break` branch in `tickHandlerCuts`, and the measured cost of
     * relaxing the count without it.
     */
    ok('the up-line is reachable at all', T.upLines > 0,
      `${T.upLines} up-line cuts started`);
    /**
     * The ratio here is deliberately NOT asserted. Most up-lines end because
     * the disc got thrown — the cut fires when the mark is beaten, which is
     * exactly the moment a thrower lets it go — and those are not aborts, they
     * are the cut working. Only an up-line that expires with the disc still in
     * the thrower's hand has anything to abort from, and that population is not
     * visible from the intent stream. What is worth pinning is that the
     * mechanism fires at all rather than being dead code, which is what it was
     * when the abort tried to claim a reset lane another handler already held.
     */
    ok('and the abort back to the reset is live code', T.upLineAborts > 0,
      `${T.upLineAborts} aborts of ${T.upLines} up-lines (most end because the disc went)`);
  }

  console.log('\n[assert] layouts');
  /**
   * A layout is a last resort. Two things have to hold and they are different
   * failures: the rate (how often anybody leaves his feet at all) and the
   * justification (whether the man who did could have run it down instead).
   *
   * All three FAILED before the bid gate went in. On this exact run the AI made
   * 98 bids against 57 completions — 1.72 per completion — every one of them
   * with over 0.35 m of standing slack and 72 of them with over 1.2 m, because
   * the gate asked only whether the disc was already at the player's feet
   * (0.2 m on defence, 0.7 m on offence) when a standing catch reaches 0.82 m.
   *
   * Zero bids is a pass and is the usual result here: the disc stub puts a real
   * arc on every throw, so the disc comes down through chest height and gets
   * met on the run. The rate this bounds is the one the full game produces —
   * measured against `src/sim/Game.ts` it is 1.8 layouts a minute, 0.46 per
   * completion, down from 5.8 and 1.47. `shouldBid` above is pinned separately
   * so this cannot be satisfied by a gate that has been switched off.
   */
  const bids = T.bidSlack.length;
  const free = T.bidSlack.filter((s) => s > 0.35).length;
  const perComp = T.completions ? bids / T.completions : 0;
  ok('layouts are rare (< 0.35 per completion)', perComp <= 0.35,
    `${bids} bids over ${T.completions} completions = ${f2(perComp)} `
    + `(${T.bidsOff} offensive, ${T.bidsDef} defensive)`);
  ok('nobody dives for a disc he could run down',
    bids === 0 || free / bids <= 0.20,
    `${pct(bids ? free / bids : 0)} of ${bids} bids had > 0.35 m of standing slack`
    + `${T.worstBids.length ? `; e.g. ${T.worstBids[0]}` : ''}`);
  ok('a bid that is made is a bid that was needed',
    bids === 0 || T.bidSlack.filter((s) => s > 1.2).length === 0,
    `${T.bidSlack.filter((s) => s > 1.2).length} bids had over 1.2 m of slack — `
    + `a dive nobody had to make`);

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

  console.log('\n[assert] liveness');
  // The one failure mode that no amount of shape measurement catches: a match
  // that stops. A ten-count is ten seconds, so no carrier can legally hold the
  // disc for twelve — and if one does, the stall clock has stopped advancing
  // and every body on the field will be standing still behind it. That is not
  // hypothetical; making the count start at a distance the marker's own
  // disc-space guard pushed him outside of froze a four-hundred-second match
  // solid, with a plausible-looking formation on the field the whole time.
  ok('no carrier holds the disc past the count',
    T.maxHold < 12 && T.deadPoints === 0,
    `longest single carry ${f2(T.maxHold)}s over ${f2(T.liveSeconds)}s of play; ` +
    `${T.deadPoints} points produced no throw at all — ${T.maxHoldWhere}`);

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
    `${windy.totals.zonePoints}/5 windy points had a zone; ` +
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

  /* ============================================================== SHAPE ==
   * Run the config the SHIPPED game runs (src/sim/Game.ts: both teams
   * vertical stack, both person, zone bias pushed well negative) and measure
   * whether the sport is legible off the bodies. This is the section that
   * stops a tuning pass on an unrelated constant from quietly turning the
   * offence back into a crowd.
   */
  // Pooled over several seeds on purpose. A single 8-point run is chaotic —
  // where on the field play happens swings the formation mix by 30 points, and
  // a threshold tuned against one trajectory is a threshold that fails the
  // next time somebody changes an unrelated constant.
  console.log('\n[sim] 4 seeds x 6 points, SHIPPING config (vertical stack, person force) — shape run');
  const S = newStruct();
  let shapeSecs = 0;
  for (const seed of [6060842, 4242, 90210, 1301]) {
    const shape = buildSim(seed, { x: 1.0, z: -0.3 }, [
      { formation: 'vertical', force: 'forehand', aggression: 1.05, zoneBias: -0.55, seed: 11 },
      { formation: 'vertical', force: 'backhand', aggression: 0.95, zoneBias: -0.45, seed: 29 },
    ]);
    shape.struct = S;
    let sRecv: 0 | 1 = (seed % 2) as 0 | 1;
    for (let i = 1; i <= 6; i++) {
      const r = runPoint(shape, i, sRecv, false);
      restBetweenPoints(shape.world.players, 45);
      sRecv = (r.scoredBy === null ? (1 - sRecv) : (1 - r.scoredBy)) as 0 | 1;
    }
    shapeSecs += shape.totals.liveSeconds;
    S.prev.clear();
    S.pending.length = 0;
  }
  const resid = S.frames ? S.residSum / S.frames : 99;
  const axis = S.frames ? S.axisSum / S.frames : 0;
  const gapAvg = S.gapN ? S.gapSum / S.gapN : 0;
  const tight = S.gapN ? S.gapTight / S.gapN : 1;
  const lead = S.frames ? S.leadSum / S.frames : 0;
  const span = S.frames ? S.spanSum / S.frames : 0;
  const members = S.eligible ? S.memberSum / S.eligible : 0;
  const formed = S.eligible ? S.frames / S.eligible : 0;
  const laneOcc = S.laneFrames ? S.laneOccSum / S.laneFrames : 0;
  const laneBusy = S.laneFrames ? S.laneBusy / S.laneFrames : 1;
  const clearAvg = S.clearN ? S.clearSum / S.clearN : 99;
  const clearSlow = S.clearN ? S.clearSlow / S.clearN : 1;
  const dumpPos = S.dumpFrames ? S.dumpPos / S.dumpFrames : 0;
  const dumpOpen = S.dumpFrames ? S.dumpOpen / S.dumpFrames : 0;
  const dump7Pos = S.dump7Frames ? S.dump7Pos / S.dump7Frames : 0;
  const dump7Open = S.dump7Frames ? S.dump7Open / S.dump7Frames : 0;
  const dumpSep = S.dumpSepN ? S.dumpSepSum / S.dumpSepN : 0;
  const markBreak = S.markFrames ? S.markBreak / S.markFrames : 0;
  const markOff = S.markFrames ? S.markOffSum / S.markFrames : 0;
  const openAgree = S.openFrames ? S.openAgree / S.openFrames : 0;
  const forms = Object.entries(S.formCount)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${pct(v / Math.max(1, S.formTotal))}`).join('  ');
  const hist = S.memberHist
    .map((v, i) => `${i}:${pct(v / Math.max(1, S.eligible))}`).join(' ');

  console.log(`  ${f2(shapeSecs)}s live; formation mix over held frames: ${forms}`);
  console.log(`  bodies in the column: ${hist}`);
  console.log(`  no reset in position, by cause: nobody behind ${S.dumpWhy[0]}, `
    + `out of range ${S.dumpWhy[1]}, wrong side of the mark ${S.dumpWhy[2]}`);
  console.log(`  the other six, per settled frame: ${f2(S.awayCut / Math.max(1, S.eligible))} `
    + `attacking a lane, ${f2(S.awayBehind / Math.max(1, S.eligible))} behind the disc, `
    + `${f2(S.awayShort / Math.max(1, S.eligible))} level with it`);
  if (process.env.AI_MAP) for (const m of S.maps) console.log('\n' + m);

  console.log('\n[assert] shape — the vertical stack');
  // Five cutters with two of them attacking a lane leaves three in the column,
  // and that is the shape being asserted: never fewer than two, usually three.
  // The baseline this replaced averaged 0.90 bodies and reached three in 2% of
  // frames, which is what "fourteen bodies with no relationship" measures as.
  const two = S.eligible
    ? (S.eligible - S.memberHist[0] - S.memberHist[1]) / S.eligible : 0;
  ok('the stack is actually populated', members >= 2.5 && two >= 0.90 && formed >= 0.55,
    `${f2(members)} bodies in the column per settled frame; two or more in ` +
    `${pct(two)} of ${S.eligible} frames, three or more in ${pct(formed)}`);
  ok('stack reads as a column (RMS residual)', resid <= 2.0,
    `${f2(resid)}m RMS perpendicular residual over ${S.frames} settled frames ` +
    `(worst ${f2(S.residMax)}m)`);
  ok('the column points downfield', axis >= 0.80,
    `|axis . attackDir| = ${f2(axis)} (1.0 = straight downfield)`);
  ok('stack spacing is even and open', gapAvg >= 3.4 && tight <= 0.25,
    `mean front-to-back gap ${f2(gapAvg)}m over ${S.gapN} pairs; ` +
    `${pct(tight)} of pairs under 3 m; span ${f2(span)}m`);
  ok('the stack sits downfield of the disc', lead >= 5.0 && lead <= 20,
    `front of the stack ${f2(lead)}m in front of the disc`);

  console.log('\n[assert] shape — cutter lanes and clearing');
  ok('the cutting lane stays open', laneOcc <= 0.45 && laneBusy <= 0.35,
    `${f2(laneOcc)} idle bodies in the open-side under lane per held frame; ` +
    `${pct(laneBusy)} of frames have at least one`);
  ok('a dead cut clears the lane quickly', clearAvg <= 2.0 && clearSlow <= 0.30,
    `mean ${f2(clearAvg)}s to get out of the way over ${S.clearN} dead cuts ` +
    `(worst ${f2(S.clearMax)}s; ${pct(clearSlow)} took over 2 s; ${S.clearNever} never cleared)`);

  console.log('\n[assert] shape — the dump');
  ok('a reset handler is stationed behind the disc', dumpPos >= 0.90,
    `${pct(dumpPos)} of ${S.dumpFrames} held frames had a handler 3-16 m behind ` +
    `the disc and not behind the mark (mean ${f2(S.dumpDistN ? S.dumpDistSum / S.dumpDistN : 0)}m ` +
    `away, ${f2(dumpSep)}m of separation)`);
  ok('the reset is in position when the stall climbs', dump7Pos >= 0.95,
    `${pct(dump7Pos)} of ${S.dump7Frames} frames at stall >= 7`);
  ok('the reset gets open as the stall climbs', dump7Open >= 0.70,
    `${pct(dump7Open)} open (>= 1.5 m of daylight — person coverage shades to ` +
    `about 1.9 m, so this is a handler his defender is not on) at stall >= 7, ` +
    `vs ${pct(dumpOpen)} across all held frames`);

  console.log('\n[assert] shape — the force');
  ok('the mark stands on the break side', markBreak >= 0.95,
    `${pct(markBreak)} of ${S.markFrames} marked frames; mean offset ` +
    `${f2(markOff)}m onto the break side (worst ${f2(S.markOffMin)}m)`);
  ok('the offence reads the force off the mark', openAgree >= 0.90,
    `${pct(openAgree)} of ${S.openFrames} held frames the offence's open side ` +
    `matched the defence's actual call`);

  if (process.env.AI_DIAG) {
    console.log('\n[diag] blocks');
    for (const b of sim.diag.blocks.slice(0, 14)) console.log('   ' + b);
    console.log('[diag] closest marks');
    for (const b of sim.diag.mark) console.log('   ' + b);
    console.log('[diag] marker outside 3 m while the count ran');
    for (const b of sim.diag.markOut) console.log('   ' + b);
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

  /* ------------------------------------------- liveness without a count */
  // The offence's urgency must not be sourced ENTIRELY from a number the
  // opposition produces. Here the stall count is pinned at zero forever, as if
  // no marker ever established: the thrower must still work through his own
  // clock and get rid of it, and the point must still play out.
  console.log('\n[sim] the stall count never starts — the offence must still play');
  const noCount = buildSim(778899, { x: 0.6, z: 0 });
  noCount.noStall = true;
  let ncThrows = 0;
  for (let i = 1; i <= 3; i++) {
    const r = runPoint(noCount, i, (i % 2) as 0 | 1, false);
    ncThrows += r.throws;
    restBetweenPoints(noCount.world.players, 45);
  }
  ok('a frozen stall count cannot deadlock the match',
    ncThrows >= 12 && noCount.totals.maxHold < 14 && noCount.totals.deadPoints === 0,
    `${ncThrows} throws over 3 points with the count pinned at 0; ` +
    `longest single carry ${f2(noCount.totals.maxHold)}s, ` +
    `${noCount.totals.deadPoints} points with no throw`);

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
  // Pooled over three seeds. One match between two rosters is a coin flip with
  // a thumb on it; three is enough that the thumb is what shows.
  const abScore = [0, 0];
  const E = { gain: 0, turns: 0, poss: 0 };
  const W = { gain: 0, turns: 0, poss: 0 };
  for (const abSeed of [555001, 12345, 99881]) {
    const ab = buildSim(abSeed, { x: 0.8, z: 0 });
    for (const p of ab.world.players) {
      const rr = new SeededRng(9000 + p.id);
      const overall = p.team === 0 ? 90 : 52;
      p.attr = makePlayer(p.id, p.team, p.archetype, rr, overall).attr;
    }
    let abRecv: 0 | 1 = 0;
    for (let i = 1; i <= 8; i++) {
      const r = runPoint(ab, i, abRecv, false);
      if (r.scoredBy != null) abScore[r.scoredBy]++;
      restBetweenPoints(ab.world.players, 45);
      abRecv = (r.scoredBy === null ? (1 - abRecv) : (1 - r.scoredBy)) as 0 | 1;
    }
    E.gain += ab.totals.byTeam[0].gain; E.turns += ab.totals.byTeam[0].turns;
    E.poss += ab.totals.byTeam[0].poss;
    W.gain += ab.totals.byTeam[1].gain; W.turns += ab.totals.byTeam[1].turns;
    W.poss += ab.totals.byTeam[1].poss;
  }
  const eYds = E.gain / Math.max(1, E.poss);
  const wYds = W.gain / Math.max(1, W.poss);
  const eTo = E.turns / Math.max(1, E.poss);
  const wTo = W.turns / Math.max(1, W.poss);
  // Points and turnover rate are the discriminators. Yards-per-possession is
  // reported but not gated on: a team that never turns it over gives its
  // opponent very few possessions, so the weak side's denominator collapses
  // and the ratio flatters it exactly when it is being beaten worst.
  ok('ratings change on-field outcomes',
    abScore[0] > abScore[1] && eTo < wTo * 0.7 && eYds > wYds,
    `points ${abScore[0]}-${abScore[1]}; yards/possession ${f2(eYds)} vs ${f2(wYds)}; ` +
    `turnovers/possession ${f2(eTo)} vs ${f2(wTo)}`);

  /* ------------------------------------------------ cross-seed robustness */
  /**
   * TWELVE SEEDS, NOT FIVE, because a completion ratio needs a denominator.
   *
   * Five seeds pool about 160 throws and the per-seed values run 57%-82% — a
   * 25-point spread — so the mean carries roughly +/-4.5 points of standard
   * error against a band whose edge is 75. Changing an unrelated cut-scoring
   * constant by 0.06 moved the pooled figure 69.6% -> 82.1% and back, which is
   * not a dose-response, it is the sample resampling itself. A threshold that a
   * no-op can flip is not measuring the thing it names.
   *
   * This is the same correction the directional-select floor needed in
   * `tools/test-game.ts` and it has the same shape: pool until the number
   * stops moving, then judge it.
   */
  console.log('\n[sim] cross-seed sweep (12 seeds x 4 points, calm)');
  let sThrows = 0, sComp = 0, sShade = 0, sShadeN = 0, sOob = 0, sMarkBad = 0, sMarkN = 0;
  const perSeed: string[] = [];
  for (const seed of [101, 20205, 777, 31415, 8675309,
    606011, 24601, 8128, 1729, 65537, 271828, 141421]) {
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

  /* ------------------------------------------------- force middle / trap */
  {
    /**
     * A POSITIONAL FORCE IS NOT A FIXED SIDE, which is the whole reason it
     * needed its own function. `openSideSign` takes only the call and the
     * attack direction, so it can express "force forehand" but not "force
     * middle" — the latter depends on which sideline the disc is nearest.
     *
     * Force middle invites the throw TOWARD x = 0: the mark stands between the
     * thrower and the near sideline, so a disc on +X has its open side at -X.
     * The trap is the mirror — take the middle away and invite the throw down
     * the line the offence is already stuck on.
     */
    const dir = 1 as const;
    ok('force middle opens toward the middle from the +X sideline',
      openSideFor('middle', dir, 14, null) === -1, 'disc at x=+14 -> open -X');
    ok('force middle opens toward the middle from the -X sideline',
      openSideFor('middle', dir, -14, null) === 1, 'disc at x=-14 -> open +X');
    ok('the trap opens down the near line, the mirror of middle',
      openSideFor('sideline', dir, 14, null) === 1
      && openSideFor('sideline', dir, -14, null) === -1, 'disc at +/-14');
    ok('break side is the opposite of open for a positional force',
      breakSideFor('middle', dir, 14, null) === -openSideFor('middle', dir, 14, null),
      'mirrored');

    // Hysteresis: the open side is what the whole offence is built on, so a
    // force that flips every time the disc crosses x = 0 rebuilds the stack,
    // the reset and the mark several times a second.
    ok('a positional force holds its call through the deadband',
      openSideFor('middle', dir, 1.0, 1) === 1 && openSideFor('middle', dir, -1.0, -1) === -1,
      `held inside +/-${FORCE_DEADBAND} m`);
    ok('and commits once the disc is clearly to one side',
      openSideFor('middle', dir, FORCE_DEADBAND + 1, 1) === -1,
      'flips outside the band even against a held call');
    ok('with no previous call it commits immediately',
      openSideFor('middle', dir, 0.5, null) === -1, 'no prev -> take the call fresh');

    // The three fixed forces must be completely unaffected.
    let fixedOk = true;
    for (const f of ['forehand', 'backhand', 'straight'] as const) {
      for (const d of [1, -1] as const) {
        for (const x of [-14, 0, 14]) {
          if (openSideFor(f, d, x, 1) !== openSideSign(f, d)) fixedOk = false;
        }
      }
    }
    ok('a fixed force ignores the disc position entirely', fixedOk,
      'forehand / backhand / straight unchanged at x = -14, 0, +14');
  }

  /* ------------------------------- the side stack knows which line it is on */
  console.log('\n[playbook] the side stack is a call about a sideline, not about x');
  {
    // A side stack isolates the open side by standing the column on the other
    // one. Called on the wrong line it isolates a strip the width of a corridor
    // — see the note on the trigger in `chooseFormation`.
    let trappedOpenOk = true;
    let trappedBreakOk = true;
    let isolatedRoom = Infinity;
    for (const dir of [1, -1] as const) {
      for (const openSign of [1, -1] as const) {
        for (const x of [-17, -15.5, 15.5, 17]) {
          // Mid-field z so the endzone call cannot pre-empt the side call.
          const disc = { x, z: 0 };
          const got = chooseFormation(disc, dir, 'vertical', 0, openSign);
          if (x * openSign > 0) {
            // Trapped ON the open side: the side stack must not be called.
            if (got === 'side') trappedOpenOk = false;
          } else {
            if (got !== 'side') trappedBreakOk = false;
            // And when it IS called, the isolated side has real room in it.
            const col = stackColumnX('side', disc, openSign);
            isolatedRoom = Math.min(isolatedRoom, Math.abs(col - openSign * FIELD.halfWidth));
          }
        }
      }
    }
    ok('a disc trapped on the OPEN side never calls a side stack', trappedOpenOk,
      'the trap is worked with the reset, not by isolating a 6 m strip');
    ok('a disc trapped on the BREAK side does call one', trappedBreakOk,
      'column on the trapped line, open side isolated');
    ok('and the isolated side is more than half the field', isolatedRoom >= 18,
      `narrowest isolated side ${f2(isolatedRoom)}m`);
    // The call is still off in the middle of the field, whatever the force.
    let midOk = true;
    for (const openSign of [1, -1] as const) {
      for (const x of [-13, 0, 13]) {
        if (chooseFormation({ x, z: 0 }, 1, 'vertical', 0, openSign) === 'side') midOk = false;
      }
    }
    ok('and it stays off inside 14 m of centre', midOk, 'x = -13, 0, +13 on both forces');
  }

  /* ------------------------------------------------------------- summary */
  console.log('\n' + '='.repeat(112));
  console.log(`  ${FAIL === 0 ? 'PASS' : 'FAIL'}  —  ${PASS} passed, ${FAIL} failed`);
  if (FAIL) for (const f of failures) console.log(`        - ${f}`);
  console.log('='.repeat(112));
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
