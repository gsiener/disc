import * as THREE from 'three';

import { DiscRuntime, type ThrowRequest } from '../../src/sim/DiscRuntime.ts';
import { DISC, FIXED_DT } from '../../src/sim/DiscPhysics.ts';
import { boundaryCrossing, isInBounds } from '../../src/sim/Rules.ts';
import type { ThrowType } from '../../src/sim/aero/Throws.ts';

/* ================================================================ discruntime */

/**
 * The disc RUNTIME — the layer between "a player wants to throw" and the
 * validated flight physics. Ported to `swift/Sources/UltimateSim/Play/DiscRuntime.swift`.
 *
 * These are MULTI-STEP TRACES rather than a table, and the reason is the whole
 * point of this fixture. Everything in `DiscRuntime` that can go wrong goes
 * wrong over time: `clock` and `sinceRelease` accumulate, the trail is a ring
 * buffer that only misbehaves once it is full or once samples start ageing out,
 * `state.groundY` is re-queried every frame from a closure and threads into
 * ground contact several frames later, and `probe` is a scratch object shared
 * between `predictPath` and `probeThrow` so a leak between them is only visible
 * on the second call. A one-shot fixture sees none of that.
 *
 * So each trace holds a runtime for hundreds of fixed steps, scripts the state
 * machine mid-flight (a catch, a block put down, a landing, a scuff), and dumps
 * the entire runtime — not just the position — every sixth frame.
 *
 * NO RANDOMNESS. `DiscRuntime` never draws from an RNG, so there is no draw
 * order to preserve here; the only nondeterminism the port could introduce is
 * float ordering, which is what the bit-equality assertions are for.
 */

/* ------------------------------------------------------------------- ground */

/**
 * The two ground closures the traces run against, named so the Swift side can
 * bind the identical function rather than infer it from data.
 *
 * `sloped` is deliberately built from `+ - *` and `max` only. A `sin`/`cos`
 * terrain would be transcendental and would put the whole trace behind a
 * tolerance for a reason that has nothing to do with the disc.
 */
const GROUNDS: Record<string, (x: number, z: number) => number> = {
  flat: () => 0,
  sloped: (x, z) => 0.03 * x - 0.02 * z + 0.25 * Math.max(0, 1 - 0.05 * (x * x + z * z)),
};

/* -------------------------------------------------------------- script types */

type Action =
  | { at: number; kind: 'hold'; playerId: number; normal: number[]; spinPhase: number }
  | { at: number; kind: 'settle' }
  | { at: number; kind: 'markScuff'; strength: number }
  | { at: number; kind: 'scuffOnTouch'; strength: number }
  | { at: number; kind: 'predict'; horizon: number; step: number; useStateLike: boolean;
      pos?: number[]; vel?: number[] }
  | { at: number; kind: 'poisonVelocity' };

interface TraceSpec {
  name: string;
  note: string;
  ground: string;
  wind: number[];
  trailCapacity?: number;
  trailSeconds?: number;
  /** Frames held in hand before the throw, to exercise the non-flight branch of step(). */
  preHold?: { playerId: number; pos: number[]; normal: number[]; spinPhase: number; frames: number };
  req: {
    type: ThrowType; from: number[]; aim: number[];
    power: number; angle: number; spin: number;
    hand?: 'R' | 'L'; bank?: number; nose?: number; speed?: number;
  };
  frames: number;
  sampleEvery: number;
  script: Action[];
  /** Track the frame at which the disc first leaves the field rectangle. */
  watchBounds?: boolean;
}

/* ------------------------------------------------------------------- traces */

const TRACES: TraceSpec[] = [
  {
    name: 'backhand-then-catch',
    note:
      'Held for twelve frames, released as a backhand, flown for two seconds, then caught '
      + 'with hold() and held for twelve more. Exercises the held branch of step(), the '
      + 'trail being cleared at release and again at the catch, sinceRelease resetting, '
      + 'and predictPath called from the middle of a live flight.',
    ground: 'flat',
    wind: [0, 0, 0],
    preHold: { playerId: 3, pos: [0, 1.1, 0], normal: [0, 1, 0], spinPhase: 0.4, frames: 12 },
    req: {
      type: 'backhand', from: [0, 1.1, 0], aim: [1, 0, 0.2],
      power: 0.62, angle: 0.03, spin: 0.55, hand: 'R',
    },
    frames: 252,
    sampleEvery: 6,
    script: [
      { at: 90, kind: 'predict', horizon: 2.5, step: 1 / 30, useStateLike: false },
      // Live wins: the runtime is in flight, so the caller's pos/vel must be IGNORED.
      { at: 150, kind: 'predict', horizon: 6, step: 1 / 30, useStateLike: true,
        pos: [5, 3, 1], vel: [10, 1, 2] },
      // A catch is exactly hold(): the runtime has no separate catch resolution, and
      // this asserts that hold() is a legal thing to do to a disc that is in the air.
      { at: 240, kind: 'hold', playerId: 7, normal: [0, 1, 0], spinPhase: 1.2 },
      // Not live any more, so this one DOES take the caller's pos/vel.
      { at: 246, kind: 'predict', horizon: 2, step: 1 / 30, useStateLike: true,
        pos: [12, 4, 3], vel: [-6, 2, -1] },
    ],
  },
  {
    name: 'hammer-blocked-to-ground',
    note:
      'A left-handed hammer into a cross-wind over sloped ground, knocked down at frame '
      + '120 with settle(). A block is settle() plus the game changing possession; the '
      + 'runtime half is the settle. Note settle() does NOT clear the trail, which is '
      + 'what leaves a ribbon hanging behind a swatted disc.',
    ground: 'sloped',
    wind: [1.5, 0, -0.8],
    req: {
      type: 'hammer', from: [-2, 1.75, -6], aim: [0.4, 0, 1],
      power: 0.8, angle: 0, spin: 0.6, hand: 'L', bank: 0.1, nose: -0.05,
    },
    frames: 200,
    sampleEvery: 6,
    script: [
      { at: 60, kind: 'predict', horizon: 3, step: 1 / 60, useStateLike: false },
      { at: 120, kind: 'settle' },
      { at: 150, kind: 'markScuff', strength: 0.45 },
      { at: 180, kind: 'predict', horizon: 2, step: 1 / 30, useStateLike: true,
        pos: [1, 2, 3], vel: [-4, 2, 1] },
    ],
  },
  {
    name: 'push-lands-and-rests',
    note:
      'A low dump that reaches the grass under its own power and comes to rest. The '
      + 'trail must keep decaying after the disc stops, sinceRelease must keep climbing, '
      + 'and the first frame with touchedGround is where the game stamps a scuff.',
    ground: 'flat',
    wind: [0, 0, 0],
    trailCapacity: 40,
    trailSeconds: 0.5,
    req: {
      type: 'push', from: [3, 0.95, 4], aim: [0, 0, 1],
      power: 0.35, angle: -0.05, spin: 0.4,
    },
    frames: 420,
    sampleEvery: 6,
    script: [
      { at: 0, kind: 'scuffOnTouch', strength: 0.8 },
      { at: 300, kind: 'markScuff', strength: 0.35 },
    ],
  },
  {
    name: 'pull-out-of-bounds',
    note:
      'A 30 m/s pull with the speed override, aimed across the +x sideline. Records the '
      + 'exact frame the disc leaves the field rectangle and the boundary crossing of the '
      + 'two straddling positions, which is how the game turns a flight into a turnover.',
    ground: 'flat',
    wind: [0, 0, 2.0],
    req: {
      type: 'backhand', from: [14, 1.6, -10], aim: [1, 0, 0.6],
      power: 0.5, angle: 0.12, spin: 0.7, speed: 30,
    },
    frames: 360,
    sampleEvery: 6,
    script: [],
    watchBounds: true,
  },
  {
    name: 'scoober-left-handed',
    note:
      'A left-handed scoober over sloped ground with a small trail budget, so the ring '
      + 'buffer both ages samples out and hits its capacity. predictPath is sampled three '
      + 'times across the flight and once after the disc is on the grass, which is the '
      + 'branch where the caller-supplied pos/vel takes over.',
    ground: 'sloped',
    wind: [-0.6, 0, 0.4],
    trailCapacity: 16,
    trailSeconds: 0.2,
    req: {
      type: 'scoober', from: [1, 1.5, 2], aim: [-0.7, 0, 1],
      power: 0.7, angle: 0.05, spin: 0.5, hand: 'L', bank: -0.2, nose: 0.03,
    },
    frames: 260,
    sampleEvery: 6,
    script: [
      { at: 30, kind: 'predict', horizon: 1, step: 1 / 120, useStateLike: false },
      { at: 90, kind: 'predict', horizon: 4, step: 0.005, useStateLike: false },
      { at: 150, kind: 'predict', horizon: 0.05, step: 1, useStateLike: false },
      { at: 200, kind: 'settle' },
      { at: 220, kind: 'predict', horizon: 3, step: 1 / 30, useStateLike: true,
        pos: [-4, 6, 12], vel: [2, -3, 8] },
    ],
  },
  {
    name: 'pathological-release-parks',
    note:
      'The module claims a non-finite state "can only come from a pathological release" '
      + 'and is parked rather than poisoning consumers. Asserted as behaviour: the '
      + 'velocity is poisoned mid-flight and the very next step must leave the disc at '
      + 'rest, on the ground, at x = z = 0 and y = groundY + halfHeight.',
    ground: 'sloped',
    wind: [0, 0, 0],
    req: {
      type: 'forehand', from: [2, 1.4, -3], aim: [1, 0, 0],
      power: 0.6, angle: 0.05, spin: 0.5,
    },
    frames: 40,
    sampleEvery: 6,
    script: [{ at: 20, kind: 'poisonVelocity' }],
  },
];

/* ------------------------------------------------------------------ helpers */

function v3(a: number[]): THREE.Vector3 {
  return new THREE.Vector3(a[0], a[1], a[2]);
}

function snapshot(rt: DiscRuntime, i: number) {
  const s = rt.state;
  const trail = rt.trail;
  const last = trail.length ? trail[trail.length - 1] : null;
  const first = trail.length ? trail[0] : null;
  return {
    i,
    t: s.t,
    clock: rt.now,
    sinceRelease: rt.sinceRelease,
    mode: rt.mode,
    holderId: rt.holderId,
    wear: rt.wear,
    pos: [s.pos.x, s.pos.y, s.pos.z],
    vel: [s.vel.x, s.vel.y, s.vel.z],
    orient: [s.orient.x, s.orient.y, s.orient.z, s.orient.w],
    omega: [s.omega.x, s.omega.y, s.omega.z],
    spin: s.spin,
    alpha: s.alpha,
    airspeed: s.airspeed,
    groundY: s.groundY,
    atRest: s.atRest,
    touchedGround: s.touchedGround,
    trailCount: trail.length,
    trailAge: rt.trailAge,
    trailFirstT: first ? first.t : null,
    trailFirstPos: first ? [first.x, first.y, first.z] : null,
    trailFirstSpeed: first ? first.speed : null,
    trailLastT: last ? last.t : null,
    trailLastPos: last ? [last.x, last.y, last.z] : null,
    trailLastSpeed: last ? last.speed : null,
    inBounds: isInBounds(s.pos),
  };
}

function scuffOf(rt: DiscRuntime) {
  const p = rt.pendingScuff;
  return p ? { rr: p.rr, ang: p.ang, top: p.top, strength: p.strength } : null;
}

/* -------------------------------------------------------------------- driver */

function runTrace(spec: TraceSpec) {
  const rt = new DiscRuntime();
  rt.groundAt = GROUNDS[spec.ground];
  rt.wind.set(spec.wind[0], spec.wind[1], spec.wind[2]);
  if (spec.trailCapacity !== undefined) rt.trailCapacity = spec.trailCapacity;
  if (spec.trailSeconds !== undefined) rt.trailSeconds = spec.trailSeconds;

  const samples: unknown[] = [];
  const predictions: unknown[] = [];
  const scuffs: unknown[] = [];
  const events: unknown[] = [];

  // Held frames before the throw. step() must advance the clock and decay the trail
  // while doing no physics at all.
  const preHoldFrames: unknown[] = [];
  if (spec.preHold) {
    rt.hold(spec.preHold.playerId, v3(spec.preHold.pos), v3(spec.preHold.normal),
      spec.preHold.spinPhase);
    preHoldFrames.push(snapshot(rt, -1));
    for (let i = 0; i < spec.preHold.frames; i++) {
      rt.step(FIXED_DT);
      preHoldFrames.push(snapshot(rt, -1 - (i + 1)));
    }
  }

  const req: ThrowRequest = {
    type: spec.req.type,
    from: v3(spec.req.from),
    aim: v3(spec.req.aim),
    power: spec.req.power,
    angle: spec.req.angle,
    spin: spec.req.spin,
    hand: spec.req.hand,
    bank: spec.req.bank,
    nose: spec.req.nose,
    speed: spec.req.speed,
  };
  const releaseVel = rt.release(req);
  const release = {
    vel: [releaseVel.x, releaseVel.y, releaseVel.z],
    frame: snapshot(rt, 0),
  };

  const scuffOnTouch = spec.script.find((a) => a.kind === 'scuffOnTouch') as
    | { at: number; kind: 'scuffOnTouch'; strength: number } | undefined;
  let scuffed = false;

  let prevPos = rt.state.pos.clone();
  let crossing: unknown = null;
  let leftAtFrame = -1;

  for (let i = 1; i <= spec.frames; i++) {
    // Actions fire BEFORE the step at their frame index, so `at: 120` means "the
    // disc was knocked down at the top of frame 120 and frame 120 is stepped in
    // whatever mode that left it in".
    for (const a of spec.script) {
      if (a.at !== i) continue;
      switch (a.kind) {
        case 'hold':
          rt.hold(a.playerId, rt.state.pos.clone(), v3(a.normal), a.spinPhase);
          events.push({ at: i, kind: 'hold', frame: snapshot(rt, i) });
          break;
        case 'settle':
          rt.settle(rt.state.pos.clone());
          events.push({ at: i, kind: 'settle', frame: snapshot(rt, i) });
          break;
        case 'markScuff':
          rt.markScuff(a.strength);
          scuffs.push({ at: i, wear: rt.wear, scuff: scuffOf(rt) });
          break;
        case 'poisonVelocity':
          // Not expressible as a number in JSON, hence a named action rather than a value.
          rt.state.vel.set(Infinity, 0, 0);
          events.push({ at: i, kind: 'poisonVelocity' });
          break;
        case 'predict': {
          const like = a.useStateLike
            ? { pos: { x: a.pos![0], y: a.pos![1], z: a.pos![2] },
                vel: { x: a.vel![0], y: a.vel![1], z: a.vel![2] } }
            : {};
          const path = rt.predictPath(like, a.horizon, a.step);
          predictions.push({
            at: i,
            horizon: a.horizon,
            step: a.step,
            useStateLike: a.useStateLike,
            pos: a.pos ?? null,
            vel: a.vel ?? null,
            mode: rt.mode,
            path: path.map((p) => [p.t, p.x, p.y, p.z]),
          });
          break;
        }
        case 'scuffOnTouch':
          break;
      }
    }

    rt.step(FIXED_DT);

    if (scuffOnTouch && !scuffed && rt.state.touchedGround) {
      scuffed = true;
      rt.markScuff(scuffOnTouch.strength);
      scuffs.push({ at: i, wear: rt.wear, scuff: scuffOf(rt) });
    }

    if (spec.watchBounds && leftAtFrame < 0 && !isInBounds(rt.state.pos)) {
      leftAtFrame = i;
      const c = boundaryCrossing(prevPos, rt.state.pos);
      crossing = {
        prev: [prevPos.x, prevPos.y, prevPos.z],
        cur: [rt.state.pos.x, rt.state.pos.y, rt.state.pos.z],
        point: c ? [c.point.x, c.point.y, c.point.z] : null,
        edge: c ? c.edge : null,
        t: c ? c.t : null,
      };
    }
    prevPos = rt.state.pos.clone();

    if (i % spec.sampleEvery === 0) samples.push(snapshot(rt, i));
  }

  return {
    name: spec.name,
    note: spec.note,
    ground: spec.ground,
    wind: spec.wind,
    trailCapacity: rt.trailCapacity,
    trailSeconds: rt.trailSeconds,
    preHold: spec.preHold ?? null,
    preHoldFrames,
    req: spec.req,
    release,
    frames: spec.frames,
    sampleEvery: spec.sampleEvery,
    /** Only one trace is aimed off the pitch; the rest never look. */
    watchBounds: spec.watchBounds ?? false,
    script: spec.script,
    samples,
    events,
    predictions,
    scuffs,
    leftAtFrame,
    crossing,
    final: snapshot(rt, spec.frames),
  };
}

/* ------------------------------------------------------------- probeThrow */

/**
 * `probeThrow` is the throw solver's inner loop, and it is worth its own block
 * because it is the one method whose answer is a DISTANCE rather than a state:
 * how far down the aim line the disc first descends through the catch plane, and
 * how far off it. A sign error in `lat` is invisible in a trajectory dump and
 * catastrophic in the solver.
 *
 * Note it deliberately does NOT forward `req.speed` — the reference builds its
 * options bag without it — so a probe of a speed-overridden pull answers for the
 * power-lerped speed instead. Recorded here so the port cannot quietly "fix" it.
 */
function probeCases() {
  const types: ThrowType[] = ['backhand', 'forehand', 'hammer', 'scoober', 'push', 'blade'];
  const out: unknown[] = [];
  for (const ground of ['flat', 'sloped']) {
    for (const type of types) {
      for (const catchY of [1.0, 1.9]) {
        const rt = new DiscRuntime();
        rt.groundAt = GROUNDS[ground];
        rt.wind.set(0.8, 0, -0.4);
        const req: ThrowRequest = {
          type,
          from: new THREE.Vector3(-1, 1.55, -8),
          aim: new THREE.Vector3(0.3, 0, 1),
          power: 0.65,
          angle: 0.02,
          spin: 0.5,
          hand: type === 'forehand' ? 'L' : 'R',
          bank: 0.05,
          nose: -0.01,
          // Present, and deliberately ignored by probeThrow.
          speed: 31,
        };
        const r = rt.probeThrow(req, catchY, 5);
        out.push({
          ground, type, catchY,
          from: [req.from.x, req.from.y, req.from.z],
          aim: [req.aim.x, req.aim.y, req.aim.z],
          power: req.power, angle: req.angle, spin: req.spin,
          hand: req.hand, bank: req.bank, nose: req.nose, speed: req.speed,
          wind: [0.8, 0, -0.4],
          maxT: 5,
          dist: r.dist, lat: r.lat, t: r.t, x: r.x, z: r.z,
        });
      }
    }
  }

  // Degenerate aim: `Math.hypot(hx, hz) || 1` is the guard, and a purely vertical
  // aim is the only thing that reaches it.
  {
    const rt = new DiscRuntime();
    rt.groundAt = GROUNDS.flat;
    const req: ThrowRequest = {
      type: 'backhand',
      from: new THREE.Vector3(0, 1.5, 0),
      aim: new THREE.Vector3(0, 1, 0),
      power: 0.5, angle: 0, spin: 0.5,
    };
    const r = rt.probeThrow(req, 1.2, 4);
    out.push({
      ground: 'flat', type: 'backhand', catchY: 1.2,
      from: [0, 1.5, 0], aim: [0, 1, 0],
      power: 0.5, angle: 0, spin: 0.5, hand: undefined, bank: undefined,
      nose: undefined, speed: undefined,
      wind: [0, 0, 0], maxT: 4,
      dist: r.dist, lat: r.lat, t: r.t, x: r.x, z: r.z,
    });
  }

  return out;
}

/* ------------------------------------------------------------- scuff geometry */

/**
 * `markScuff` is pure geometry: it asks which point of the disc met the grass by
 * rotating world-down into the disc's own frame. Driven here from a set of
 * orientations built with `hold()`, because that is the only public way to put a
 * known attitude on the runtime.
 *
 * `top` is inverted on the way out (`top: !top`) — the face that struck the grass
 * is the one that is NOT pointing up — and that negation is exactly the sort of
 * thing a port drops.
 */
function scuffCases() {
  const normals: number[][] = [
    [0, 1, 0], [0, -1, 0], [1, 0, 0], [0, 0, 1],
    [0.3, 0.9, -0.2], [-0.5, -0.4, 0.75], [0, 0, 0],
  ];
  const phases = [0, 0.7, -2.1];
  const out: unknown[] = [];
  for (const n of normals) {
    for (const phase of phases) {
      const rt = new DiscRuntime();
      rt.groundAt = GROUNDS.flat;
      rt.hold(1, new THREE.Vector3(0, 1, 0), v3(n), phase);
      const before = rt.wear;
      rt.markScuff(0.6);
      const s = rt.pendingScuff!;
      // Twice, to prove `wear` accumulates and clamps rather than being assigned.
      rt.markScuff(0.9);
      out.push({
        normal: n, phase,
        orient: [rt.state.orient.x, rt.state.orient.y, rt.state.orient.z, rt.state.orient.w],
        wearBefore: before,
        first: { rr: s.rr, ang: s.ang, top: s.top, strength: s.strength },
        second: scuffOf(rt),
        wearAfter: rt.wear,
      });
    }
  }

  // Wear saturates at 1 rather than running away.
  {
    const rt = new DiscRuntime();
    rt.hold(1, new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0), 0);
    const wears: number[] = [];
    for (let i = 0; i < 60; i++) { rt.markScuff(1); wears.push(rt.wear); }
    out.push({ normal: [0, 1, 0], phase: 0, saturation: wears });
  }

  return out;
}

/* ------------------------------------------------------------------- trail */

/**
 * The trail ring buffer on its own, driven by `setTrail` and by the clock, so the
 * two independent eviction rules — older than `trailSeconds`, and more than
 * `trailCapacity` — are each exercised past their boundary.
 */
function trailCases() {
  const out: unknown[] = [];

  // `setTrail-from-cold` and `setTrail-then-decay` were here, driving `setTrail(_:)`
  // against a re-basing edge case. Deleted with the Swift method (#5): it had no caller
  // outside these two fixture-driven test cases on the port side, and no FlightUI
  // consumer of `DiscRuntime.trail` to seed. The reference's own `setTrail` stays —
  // deleting the port's dead capability is not a reason to touch the oracle it mirrors
  // (see issue #22's resolution for the same call) — it is simply not exercised here
  // any longer.

  {
    // A long flight against a capacity that the seconds budget alone would never
    // reach, so the `> trailCapacity` shift is what does the evicting.
    const rt = new DiscRuntime();
    rt.groundAt = GROUNDS.flat;
    rt.trailSeconds = 10;
    rt.trailCapacity = 9;
    rt.release({
      type: 'backhand', from: new THREE.Vector3(0, 1.6, 0), aim: new THREE.Vector3(1, 0, 0),
      power: 0.8, angle: 0.05, spin: 0.6,
    });
    const counts: number[] = [];
    for (let i = 0; i < 60; i++) { rt.step(FIXED_DT); counts.push(rt.trail.length); }
    out.push({
      kind: 'capacity-only',
      trailSeconds: 10,
      trailCapacity: 9,
      counts,
      trail: rt.trail.map((s) => [s.x, s.y, s.z, s.t, s.speed]),
      trailAge: rt.trailAge,
    });
  }

  {
    // An empty trail must report the sentinel age rather than NaN.
    const rt = new DiscRuntime();
    out.push({ kind: 'empty', now: rt.now, trailAge: rt.trailAge, count: rt.trail.length });
  }

  return out;
}

/* ------------------------------------------------------------------- exports */

export function discRuntimeGoldens() {
  return {
    note:
      'Generated by tools/gen-goldens.ts from src/sim/DiscRuntime.ts; '
      + 'DiscSystem is renderer-only and has no Swift counterpart). Multi-step traces: each '
      + 'holds one runtime across hundreds of fixed 1/120 steps, scripts the state machine '
      + 'mid-flight, and dumps the whole runtime every sixth frame. Everything here is '
      + 'reachable from + - * / sqrt min max clamp plus the flight integration, so the '
      + 'consuming suite asserts bit-equality except where it states otherwise.',
    fixedDt: FIXED_DT,
    halfHeight: DISC.halfHeight,
    diameter: DISC.diameter,
    /** The field the in-bounds column was measured against, and its epsilon. */
    field: { sideline: 18.5, endLine: 50, eps: 1e-9 },
    /** Reference defaults, so the port cannot silently pick different ones. */
    defaults: (() => {
      const rt = new DiscRuntime();
      return {
        mode: rt.mode,
        holderId: rt.holderId,
        lastThrowTeam: rt.lastThrowTeam,
        sinceRelease: rt.sinceRelease,
        wear: rt.wear,
        trailCapacity: rt.trailCapacity,
        trailSeconds: rt.trailSeconds,
        now: rt.now,
        trailAge: rt.trailAge,
        groundAtOrigin: rt.groundAt(3, -4),
        wind: [rt.wind.x, rt.wind.y, rt.wind.z],
      };
    })(),
    /** Sampled so the Swift side can bind the identical ground closures. */
    groundSamples: (() => {
      const pts = [[0, 0], [3, -4], [-7.5, 2.25], [1.5, 1.5], [20, -30], [0.5, -0.5]];
      return pts.map(([x, z]) => ({
        x, z, flat: GROUNDS.flat(x, z), sloped: GROUNDS.sloped(x, z),
      }));
    })(),
    traces: TRACES.map(runTrace),
    probes: probeCases(),
    scuffs: scuffCases(),
    trails: trailCases(),
  };
}
