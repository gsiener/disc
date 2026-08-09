/**
 * Goldens for `class TeamAI` — `src/sim/AI.ts` lines 653-3069.
 *
 * TEAMAI IS DEEPLY STATEFUL, so this is a trace and not a case table. One team brain
 * carries a possession epoch, a formation hold timer, a per-player cut state machine
 * with lanes reserved against a shared map, a stack-slot deal with 0.35 s hysteresis, a
 * lagged perception of every matchup, a stall clock, an 8 Hz decision tick, a windup and
 * a private RNG stream. Almost none of that is visible on the first frame. The bugs
 * worth catching are the ones that only appear on frame 400:
 *
 *   - a lane reserved by a cut that ended, so nobody may ever cut there again;
 *   - a matchup map iterated in a different order, so the mark is handed to a defender
 *     six metres away and the count restarts every frame;
 *   - a `stackOrder` rotation that drops a body, so the column silently shortens;
 *   - one RNG draw taken on a branch that should not have taken it, after which every
 *     later decision in the match is different-but-plausible;
 *   - a stall count that never starts, and an offence that stands still for the whole
 *     point waiting for it.
 *
 * So the generator builds a deterministic world, steps `updateTeam` for both teams
 * across four situations, and records EVERY returned `PlayerIntent` on EVERY frame,
 * alongside the inputs that produced it.
 *
 * ------------------------------------------------------------------ replay contract
 *
 * Each frame carries its own inputs — every player's `x, z, vx, vz, energy`, the whole
 * disc state, the phase, the possession and the wind — recorded BEFORE `updateTeam`
 * runs, and the intents recorded after. The consuming suite writes the inputs back
 * before each step, so the crude driver below never has to be ported: what is asserted
 * is the AI's response to a known world, plus all the AI-owned state that survives
 * between frames.
 *
 * `energy` is an input for the same reason. It is AI-owned (`tickStamina` mutates it
 * inside `update`), so leaving it to accumulate would make the whole trace a race
 * between two `Math.hypot` implementations. `AIMathTests` already pins `tickStamina`
 * against its own trace; re-seeding energy each frame keeps this fixture testing
 * decisions rather than re-testing that.
 *
 * ----------------------------------------------------------------- the four segments
 *
 *   `lineup`   phase 'setup'. The pre-pull spread, which is the only place `lineUp`
 *              runs and the only place the roster order matters to the output.
 *
 *   `live`     phase 'live', dt 1/120, THE DISC STARTING TWO METRES OFF THE OFFENCE'S
 *              OWN GOAL LINE. Person defence, a real mark, real cuts, throws, discs in
 *              flight, catches, drops, turnovers and possession flips. Starting pinned
 *              deep is deliberate: `possessionValue` past 64 and `buildCut`'s dump floor
 *              are the two halves of the fix for an offence that walked itself
 *              backwards over its own line one legal-looking reset at a time (traced:
 *              -30.2, -36.1, -42.1, -46.4), and this is the situation that exercises
 *              them.
 *
 *   `zone`     the wind comes up to 10.8 m/s and the phase is bounced through 'dead',
 *              which re-runs `pickScheme`. `shouldPlayZone` then calls zone for the
 *              defending team, and `pickScheme` re-points the force to the upwind side.
 *
 *   `nomark`   THE FOUR-HUNDRED-SECOND BUG. Person defence runs normally and the mark
 *              is genuinely set — but the game system never advances `disc.stall`, so
 *              the count the offence plays to is pinned at zero. A `TeamAI` whose only
 *              source of urgency is the opposition's count stands still forever. The
 *              offence must still work the reset and still release the disc, on
 *              `holdTime` alone. Run at dt 1/30 so seventeen seconds of it fits in five
 *              hundred frames.
 *
 * -------------------------------------------------------------------- no system peers
 *
 * `world.sys` is deliberately absent, so `predictCatchPoint` runs its own glide
 * integrator and `timeToReach` its own kinematic estimate. Those are the paths with
 * arithmetic in them; a peer would replace both with numbers this fixture did not
 * generate.
 */

import {
  FIELD, SeededRng, type AttackDir, type Sign,
} from '../../src/sim/Playbook.ts';
import {
  createTeamAI, updateTeam, makePlayer,
  type AIPlayer, type AIWorld, type Archetype, type DiscState, type GamePhase,
  type PlayerIntent, type TeamAI, type TeamConfig,
} from '../../src/sim/AI.ts';

/* --------------------------------------------------------------------- seeds */

/** Seeds the rosters. Separate from the team stream so neither disturbs the other. */
const ROSTER_SEED = 20260807;
/** The parent stream both `TeamAI`s fork from. `fork` does not disturb the parent, so
 *  the two forks are order-independent and the Swift side reproduces them from a bare
 *  `Rng(seed:)` without replaying anything. */
const TEAM_SEED = 424242;

const ARCHES: Archetype[] = ['handler', 'handler', 'handler', 'cutter', 'cutter', 'deep', 'utility'];

const CFG: [TeamConfig, TeamConfig] = [
  { formation: 'vertical', force: 'forehand', aggression: 1.05, zoneBias: -0.20, seed: 3 },
  { formation: 'horizontal', force: 'backhand', aggression: 0.95, zoneBias: 0.05, seed: 5 },
];

/* -------------------------------------------------------------- serialisation */

/**
 * ROWS ARE PACKED INTO DELIMITED STRINGS, and that is a transport decision with a
 * measured reason rather than a stylistic one.
 *
 * `tools/gen-goldens.ts` writes every fixture with `JSON.stringify(data, null, 2)`, which
 * puts each scalar — including each element of an array — on its own line. Written as
 * plain objects this trace came out at 17.9 MB for 1,560 frames, five times the largest
 * existing fixture, for the same 22,000 intents. Packing one intent into one line brings
 * it under 5 MB with not one number lost: `String(v)` emits the shortest representation
 * that round-trips a double exactly, and Swift's `Double(String)` parses it correctly
 * rounded, so the wire form is bit-exact in both directions — which `null` and the
 * pretty-printer are not, since neither can carry a NaN.
 *
 * Layouts, all `|`-delimited, empty field meaning null:
 *
 *   player  `x|z|vx|vz|energy`
 *   disc    `x|y|z|vx|vy|vz|state|carrier|intendedReceiver|stall`
 *   intent  `id|targetX|targetZ|faceX|faceZ|mode|effort|desiredSpeed|maxSpeed`
 *           `|arriveRadius|role|state|lane|cutX|cutZ|cutKind|cutDepth|action`
 *   team    `stall|scheme|formation|openSign|stackAxisX|marker|resetHandler|openSideOnD`
 *           `|force|holding,csv|matchup,csv|zoneRole,csv`
 *
 * `action` is itself `,`-delimited and its first field is the kind:
 *   `throw,type,aimX,aimY,aimZ,speed,flightTime,spin,receiverId,expected`
 *   `catch,difficulty` / `bid,x,z,extend` / `jump,height` / `stall,count` / `pickup`
 *
 * `maxAccel`, `maxDecel`, `turnRate` and `personalSpace` are deliberately absent: they
 * are pure functions of the player (`effectiveAccel` and friends, already pinned
 * bit-for-bit by `AIMathTests`) or a literal, and the consuming suite asserts them
 * against those functions directly. `desiredSpeed`, `maxSpeed` and `arriveRadius` are
 * present because each is a function of the intent as well as the player —
 * `arriveRadius` is the only externally visible trace of the `settle` flag.
 */
const n = (v: number): string => (Number.isNaN(v) ? 'nan' : String(v));
const oi = (v: number | null | undefined): string => (v == null ? '' : String(v));

function actionText(a: PlayerIntent['action']): string {
  if (!a) return '';
  switch (a.kind) {
    case 'throw':
      return [
        'throw', a.throwType, n(a.aimX), n(a.aimY), n(a.aimZ), n(a.speed),
        n(a.flightTime), n(a.spin), String(a.receiverId), n(a.expected),
      ].join(',');
    case 'catch': return `catch,${n(a.difficulty)}`;
    case 'bid': return `bid,${n(a.x)},${n(a.z)},${n(a.extend)}`;
    case 'jump': return `jump,${n(a.height)}`;
    case 'stall': return `stall,${n(a.count)}`;
    case 'pickup': return 'pickup';
    case 'fake': return `fake,${a.throwType}`;
  }
}

function intentRow(i: PlayerIntent): string {
  return [
    String(i.id), n(i.targetX), n(i.targetZ), n(i.faceX), n(i.faceZ),
    i.mode, n(i.effort), n(i.desiredSpeed), n(i.maxSpeed), n(i.arriveRadius),
    i.debug.role, i.debug.state, i.debug.lane ?? '',
    n(i.debug.cutX), n(i.debug.cutZ), i.debug.cutKind ?? '', n(i.debug.cutDepth),
    actionText(i.action),
  ].join('|');
}

function playerRow(p: AIPlayer): string {
  return [n(p.pos.x), n(p.pos.z), n(p.vel.x), n(p.vel.z), n(p.energy)].join('|');
}

function discRow(d: DiscState): string {
  return [
    n(d.pos.x), n(d.pos.y), n(d.pos.z), n(d.vel.x), n(d.vel.y), n(d.vel.z),
    d.state, oi(d.carrier), oi(d.intendedReceiver), n(d.stall),
  ].join('|');
}

function teamRow(t: TeamAI, mates: AIPlayer[]): string {
  return [
    n(t.stall), t.currentScheme, t.currentFormation, String(t.openSign),
    n(t.stackAxisX), String(t.marker), String(t.resetHandler), oi(t.openSideOnD),
    t.force,
    t.stackHolding().join(','),
    mates.map((p) => oi(t.matchupOf(p.id))).join(','),
    mates.map((p) => t.zoneRoleOf(p.id) ?? '').join(','),
  ].join('|');
}

/* ------------------------------------------------------------------ the driver */

/**
 * A crude first-order chase. NOT a port of anything and never asserted — its only job
 * is to move bodies somewhere plausible so that the AI sees a changing world. Every
 * position it produces is recorded, so the Swift side replays rather than reproduces.
 */
function integrate(intents: PlayerIntent[], byId: Map<number, AIPlayer>, dt: number): void {
  for (const it of intents) {
    const p = byId.get(it.id);
    if (!p) continue;
    const dx = it.targetX - p.pos.x;
    const dz = it.targetZ - p.pos.z;
    const d = Math.hypot(dx, dz);
    const want = Math.min(it.desiredSpeed, d / Math.max(dt, 1e-6));
    const ux = d > 1e-9 ? dx / d : 0;
    const uz = d > 1e-9 ? dz / d : 0;
    const tvx = ux * want;
    const tvz = uz * want;
    const a = it.maxAccel * dt;
    p.vel.x += Math.max(-a, Math.min(a, tvx - p.vel.x));
    p.vel.z += Math.max(-a, Math.min(a, tvz - p.vel.z));
    p.pos.x = Math.max(-FIELD.halfWidth, Math.min(FIELD.halfWidth, p.pos.x + p.vel.x * dt));
    p.pos.z = Math.max(-FIELD.halfLength, Math.min(FIELD.halfLength, p.pos.z + p.vel.z * dt));
  }
}

interface Flight {
  fx: number; fy: number; fz: number;
  vx: number; vy: number; vz: number;
  t: number; T: number; by: 0 | 1;
}

export function teamAIGoldens() {
  /* ------------------------------------------------------------------ rosters */

  const rrng = new SeededRng(ROSTER_SEED);
  const players: AIPlayer[] = [];
  for (let t = 0; t < 2; t++) {
    for (let i = 0; i < 7; i++) {
      const overall = 62 + rrng.range(0, 20);
      players.push(makePlayer(t * 7 + i, t as 0 | 1, ARCHES[i], rrng.fork(t * 31 + i), overall));
    }
  }
  const byId = new Map(players.map((p) => [p.id, p]));
  // Snapshot BEFORE the trace: `role` is reassigned by `applyRoleSplit` on every
  // possession change, so reading it at the end would hand the replay a roster that
  // starts where this one finished.
  const roster = players.map((p) => ({
    id: p.id, team: p.team, archetype: p.archetype, handed: p.handed,
    role: p.role, energy: p.energy, attr: p.attr,
  }));

  const disc: DiscState = {
    pos: { x: 0, y: 1.0, z: -30 },
    vel: { x: 0, y: 0, z: 0 },
    state: 'held',
    carrier: 0,
    thrownBy: null,
    intendedReceiver: null,
    stall: 0,
    spin: 0,
    throwType: null,
  };

  const world: AIWorld = {
    time: 0,
    players,
    disc,
    possession: 0,
    phase: 'setup',
    wind: { x: 0.8, z: -0.4 },
    score: [0, 0],
    scoreCap: 15,
    rand: new SeededRng(7).fork(999),
    sys: undefined,
  };

  const trng = new SeededRng(TEAM_SEED);
  const teams: [TeamAI, TeamAI] = [
    createTeamAI(0, 1 as AttackDir, trng.fork(11), CFG[0]),
    createTeamAI(1, -1 as AttackDir, trng.fork(22), CFG[1]),
  ];
  const mates: [AIPlayer[], AIPlayer[]] = [
    players.filter((p) => p.team === 0),
    players.filter((p) => p.team === 1),
  ];

  let flight: Flight | null = null;
  /** Pinned in the `nomark` segment: the count the game system publishes never moves. */
  let publishStall = true;
  /** Wall clock at the start of the current segment, so "seconds into the segment" is
   *  a number the consuming suite can assert against a bound. */
  let segStart = 0;

  const frames: unknown[] = [];
  /** Behaviour the segments must show, collected while the trace runs. */
  const observed = {
    liveThrows: 0,
    liveCatches: 0,
    liveTurnovers: 0,
    livePickups: 0,
    liveBids: 0,
    liveFlightFrames: 0,
    liveGroundFrames: 0,
    livePossessionFlips: 0,
    zoneFrames: 0,
    zoneStallFrames: 0,
    nomarkThrows: 0,
    nomarkDumps: 0,
    nomarkFirstThrowSecond: -1,
    nomarkMarkedFrames: 0,
    cutKinds: {} as Record<string, number>,
    modes: {} as Record<string, number>,
  };

  function place(x: number[], z: number[]): void {
    for (let i = 0; i < players.length; i++) {
      players[i].pos.x = x[i];
      players[i].pos.z = z[i];
      players[i].pos.y = 0;
      players[i].vel.x = 0;
      players[i].vel.y = 0;
      players[i].vel.z = 0;
    }
  }

  function step(seg: string, dt: number): void {
    // ---- inputs, recorded BEFORE the AI sees them.
    const pl = players.map(playerRow);
    const inDisc = discRow(disc);

    const a = updateTeam(teams[0], world, dt);
    const b = updateTeam(teams[1], world, dt);
    const intents = [...a, ...b];

    frames.push({
      seg, dt, time: world.time, phase: world.phase, possession: world.possession,
      wx: world.wind.x, wz: world.wind.z,
      disc: inDisc,
      pl,
      // Energy AFTER both updates, which is the value every intent in this frame was
      // computed from. `tickStamina` branches on `load > 0.42`, and `load` is a
      // `Math.hypot` away from that threshold — so on the handful of frames where a
      // player is running at exactly 42% of top speed the two platforms take opposite
      // branches and the energy differs by one tick. Recording the reference's answer is
      // what lets the consuming suite SEE that happen and count it, rather than
      // absorbing it into a tolerance a hundred thousand times too loose.
      pe: players.map((p) => n(p.energy)),
      it: intents.map(intentRow),
      ts: [teamRow(teams[0], mates[0]), teamRow(teams[1], mates[1])],
    });

    // ---- census (the behavioural claims the Swift side re-derives from `it`).
    for (const it of intents) {
      observed.modes[it.mode] = (observed.modes[it.mode] ?? 0) + 1;
      if (it.debug.cutKind) {
        observed.cutKinds[it.debug.cutKind] = (observed.cutKinds[it.debug.cutKind] ?? 0) + 1;
        if (seg === 'nomark' && it.debug.cutKind === 'dump') observed.nomarkDumps++;
      }
      if (it.action?.kind === 'bid' && seg === 'live') observed.liveBids++;
    }
    if (seg === 'live' && disc.state === 'flight') observed.liveFlightFrames++;
    if (seg === 'live' && disc.state === 'ground') observed.liveGroundFrames++;
    if (seg === 'zone') {
      observed.zoneFrames++;
      if (teams[1].stall > 0 || teams[0].stall > 0) observed.zoneStallFrames++;
    }
    if (seg === 'nomark' && teams[1].stall > 0) observed.nomarkMarkedFrames++;

    // ---- resolve the one-shot actions the disc system would consume.
    const before = world.possession;
    for (const it of intents) {
      const act = it.action;
      if (!act) continue;
      if (act.kind === 'throw' && disc.state === 'held' && disc.carrier === it.id) {
        const from = byId.get(it.id)!;
        const T = Math.max(0.2, act.flightTime);
        flight = {
          fx: from.pos.x, fy: 1.35, fz: from.pos.z,
          vx: (act.aimX - from.pos.x) / T,
          vy: (act.aimY - 1.35) / T + 0.5 * 3.1 * T,
          vz: (act.aimZ - from.pos.z) / T,
          t: 0, T, by: it.team,
        };
        disc.state = 'flight';
        disc.carrier = null;
        disc.thrownBy = it.id;
        disc.intendedReceiver = act.receiverId;
        disc.stall = 0;
        if (seg === 'live') observed.liveThrows++;
        if (seg === 'nomark') {
          observed.nomarkThrows++;
          if (observed.nomarkFirstThrowSecond < 0) {
            observed.nomarkFirstThrowSecond = world.time - segStart;
          }
        }
      } else if (act.kind === 'pickup' && disc.state === 'ground') {
        disc.state = 'held';
        disc.carrier = it.id;
        disc.stall = 0;
        world.possession = it.team;
        if (seg === 'live') observed.livePickups++;
      } else if (act.kind === 'stall' && publishStall) {
        disc.stall = act.count;
      }
    }

    integrate(intents, byId, dt);

    // ---- advance the disc.
    if (flight) {
      flight.t += dt;
      const t = flight.t;
      disc.pos.x = flight.fx + flight.vx * t;
      disc.pos.y = flight.fy + flight.vy * t - 0.5 * 3.1 * t * t;
      disc.pos.z = flight.fz + flight.vz * t;
      disc.vel.x = flight.vx;
      disc.vel.y = flight.vy - 3.1 * t;
      disc.vel.z = flight.vz;
      if (t >= flight.T || disc.pos.y <= 0.05) {
        // Nearest body inside 1.8 m takes it; nobody there is a turnover. Crude on
        // purpose — what matters is that BOTH outcomes appear in the trace.
        let best: AIPlayer | null = null;
        let bd = 1.35;
        for (const p of players) {
          const d = Math.hypot(p.pos.x - disc.pos.x, p.pos.z - disc.pos.z);
          if (d < bd) { bd = d; best = p; }
        }
        if (best) {
          disc.state = 'held';
          disc.carrier = best.id;
          disc.pos.y = 1.0;
          world.possession = best.team;
          if (seg === 'live') observed.liveCatches++;
        } else {
          disc.state = 'ground';
          disc.pos.y = 0.05;
          disc.vel.x = 0; disc.vel.y = 0; disc.vel.z = 0;
          world.possession = (1 - flight.by) as 0 | 1;
          if (seg === 'live') observed.liveTurnovers++;
        }
        disc.intendedReceiver = null;
        disc.stall = 0;
        flight = null;
      }
    } else if (disc.state === 'held' && disc.carrier != null) {
      const c = byId.get(disc.carrier)!;
      disc.pos.x = c.pos.x;
      disc.pos.y = 1.0;
      disc.pos.z = c.pos.z;
      disc.vel.x = 0; disc.vel.y = 0; disc.vel.z = 0;
    }
    if (world.possession !== before && seg === 'live') observed.livePossessionFlips++;

    world.time += dt;
  }

  /* ------------------------------------------------------- segment 0: line up */

  place(
    [-12, -6, 0, 6, 12, -16, 16, -12, -6, 0, 6, 12, -16, 16],
    [-32, -32, -32, -32, -32, -32, -32, 32, 32, 32, 32, 32, 32, 32],
  );
  for (let i = 0; i < 30; i++) step('lineup', 1 / 120);

  /* -------------------------------- segment 1: live, pinned on own goal line */

  world.phase = 'live' as GamePhase;
  world.possession = 0;
  place(
    [0, 5.0, -6.0, 0.5, -0.5, 0.0, 0.0, 1.9, 5.6, -5.0, 0.5, 1.0, -1.0, 0.0],
    [-30, -33.0, -31.0, -19.0, -14.8, -10.6, -6.4, -29.4, -33.5, -31.5, -21.0, -16.5, -12.0, -8.0],
  );
  disc.state = 'held';
  disc.carrier = 0;
  disc.thrownBy = null;
  disc.intendedReceiver = null;
  disc.stall = 0;
  disc.pos.x = 0; disc.pos.y = 1.0; disc.pos.z = -30;
  flight = null;
  for (let i = 0; i < 300; i++) step('live', 1 / 60);

  // A SCRIPTED THROWAWAY, resolved by the driver. `livePossessionFlips` counts a
  // possession that changes hands INSIDE `step` — the flight turnover branch — and for
  // most of this fixture's life it happened to be fed by the AI's own drops. The
  // deep-shot valuation made the offence complete this segment's throws, and the flip
  // count silently fell to zero, which the consuming suite rightly failed. A situation
  // the trace must contain is staged, not hoped for: a flight from the thrower into
  // empty space, landing where nobody stands.
  flight = {
    fx: disc.pos.x, fy: 1.35, fz: disc.pos.z,
    vx: 11, vy: 2.2, vz: 3,
    t: 0, T: 0.8, by: 0,
  };
  disc.state = 'flight';
  disc.carrier = null;
  disc.thrownBy = 0;
  disc.intendedReceiver = null;
  disc.stall = 0;
  for (let i = 0; i < 90; i++) step('live', 1 / 60);

  // A SCRIPTED TURNOVER. Three situations only reachable from a live loose disc — the
  // `ground` branch of `offence` (nearest body collects, everyone else re-forms), the
  // `pickup` action, and the whole `onPossessionChange` rebuild for the team that just
  // gained it — are otherwise at the mercy of whether the crude driver happens to drop
  // one. So one is dropped on purpose, on the far sideline where the pickup target has
  // to be pulled back inside the line.
  disc.state = 'ground';
  disc.carrier = null;
  disc.thrownBy = null;
  disc.intendedReceiver = null;
  disc.stall = 0;
  disc.pos.x = 18.5; disc.pos.y = 0.05; disc.pos.z = 4;
  disc.vel.x = 0; disc.vel.y = 0; disc.vel.z = 0;
  flight = null;
  world.possession = 1;
  for (let i = 0; i < 350; i++) step('live', 1 / 60);

  /* --------------------------------------------- segment 2: wind, and a zone */

  world.wind = { x: 9, z: 6 };
  world.phase = 'dead' as GamePhase;
  step('zone', 1 / 60);
  world.phase = 'live' as GamePhase;
  for (let i = 0; i < 199; i++) step('zone', 1 / 60);

  /* ------------------------- segment 3: a mark that is set, and a count that is not */

  world.wind = { x: 0.8, z: -0.4 };
  world.phase = 'dead' as GamePhase;
  world.possession = 0;
  place(
    [4, 8.0, -7.0, 2.0, -2.0, 1.0, -1.0, 5.9, 9.0, -6.0, 2.5, -2.5, 0.0, 1.0],
    [-6, -12.0, -10.0, 6.0, 10.5, 15.0, 19.0, -5.4, -12.5, -10.5, 4.0, 8.0, 12.5, 16.5],
  );
  disc.state = 'held';
  disc.carrier = 0;
  disc.thrownBy = null;
  disc.intendedReceiver = null;
  disc.stall = 0;
  disc.pos.x = 4; disc.pos.y = 1.0; disc.pos.z = -6;
  flight = null;
  publishStall = false;
  segStart = world.time;
  step('nomark', 1 / 30);
  world.phase = 'live' as GamePhase;
  for (let i = 0; i < 399; i++) step('nomark', 1 / 30);

  /* ------------------------------------------------------------------ output */

  return {
    note:
      'Generated by tools/gen-goldens.ts from src/sim/AI.ts lines 653-3069. A multi-frame '
      + 'trace: every frame carries the inputs recorded before updateTeam, the energies '
      + 'after it, and every PlayerIntent it returned. Math.hypot is in dist2 and '
      + 'therefore in nearly every expression here, so the consuming suite states a '
      + 'measured absolute tolerance; discrete fields (mode, action kind, lane, cutKind, '
      + 'ids, scheme, formation, matchups) are exact. Rows are packed into delimited '
      + 'strings — see the serialisation block — purely to keep the two-space '
      + 'pretty-printer from turning 22,000 intents into 17.9 MB.',
    rosterSeed: ROSTER_SEED,
    teamSeed: TEAM_SEED,
    forkSalts: [11, 22],
    cfg: CFG,
    dirs: [1, -1],
    score: world.score,
    scoreCap: world.scoreCap,
    field: {
      halfWidth: FIELD.halfWidth, halfLength: FIELD.halfLength,
      goalLine: FIELD.goalLine, endzoneDepth: FIELD.endzoneDepth,
      edgeMargin: FIELD.edgeMargin,
    },
    roster,
    observed,
    frames,
  };
}
