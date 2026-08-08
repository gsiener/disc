import * as THREE from 'three';

import type { Attributes, Derived, FootState, LocoPlayer, LocoStateName, MoveMode, Vec2Like } from '../../src/sim/move/Types.ts';
import { DEFAULT_ATTRS } from '../../src/sim/move/Types.ts';
import {
  COST_CUT,
  COST_JUMP,
  COST_LAYOUT,
  STAM_FADE,
  G,
  derive,
  leapHeight,
  modeCapFraction,
  propulsiveAt,
  staminaRate,
  takeoffVy,
} from '../../src/sim/move/Attributes.ts';
import {
  GAIT_MIN_SPEED,
  advanceGait,
  dutyFactor,
  plantForCut,
  stanceHalfWidth,
  stepRate,
} from '../../src/sim/move/Gait.ts';
import {
  DISC_FREE_R,
  DISC_GRAB_R,
  DiscProbe,
  PERSONAL_RADIUS,
  SEP_DEADBAND,
  SEP_RATE,
  SEP_Y_SPAN,
  accumulateSeparation,
  compliance,
  type DiscFocus,
} from '../../src/sim/move/Separation.ts';
import { PRONE_Y, contestAir, predictPos, reachAt } from '../../src/sim/move/Contest.ts';
import { GroundProbe, gradeAlong, slopeMultiplier, type FieldLike } from '../../src/sim/move/Ground.ts';

/* --------------------------------------------------------------------- move */

/**
 * Locomotion fixtures for `src/sim/move/*.ts`.
 *
 * Almost everything here is `+ - * / sqrt min max clamp` and is asserted
 * BIT-EXACT on the Swift side. Three exceptions, each called out at its case
 * group below:
 *
 *   - `Math.pow` in `propulsiveAt`/`staminaRate` is a transcendental — tolerance.
 *   - `Math.sin`/`Math.cos` of `facing` in `advanceGait`'s plant projection —
 *     tolerance on the plant x/y/z only, not on the phase/contact/stride math
 *     that shares the same call, which stays bit-exact.
 *   - `Math.hypot`, used throughout `Separation.ts`/`Contest.ts`/`Ground.ts` for
 *     distance and grade. Unlike `sqrt`, IEEE 754 does not require `hypot` to be
 *     correctly rounded, and V8's implementation and Darwin's libm are free to
 *     differ by a handful of ulps on the same inputs (see the note on
 *     `Vec3d.length` in `SimMath.swift`, which chooses `sqrt` over `hypot` for
 *     exactly this reason). So every value downstream of a `Math.hypot` call
 *     gets a small tolerance rather than `bitEqViaJSON`, even though the
 *     surrounding arithmetic is exact.
 *
 * Only the `LocoPlayer` fields the five leaf modules actually read or write are
 * populated below — the same subset the Swift `LocoPlayer` port declares.
 */
export function moveGoldens() {
  const v = (x: number, y: number, z: number) => ({ x, y, z });
  const v2 = (x: number, z: number): Vec2Like => ({ x, z });

  type PlayerSpec = {
    id?: number;
    attr?: Attributes;
    pos?: { x: number; y: number; z: number };
    vel?: { x: number; y: number; z: number };
    facing?: number;
    state?: LocoStateName;
    prone?: boolean;
    anchored?: boolean;
    airborne?: boolean;
    foot?: Partial<FootState>;
    groundY?: number;
    radius?: number;
    personal?: number;
    hipHeight?: number;
    cmd?: { x: number; z: number };
    t?: number;
  };

  // Builds exactly the subset of LocoPlayer the move/ leaf modules read or
  // write. Type stripping means the object need not satisfy the full
  // interface — the same "partial port" contract the Swift LocoPlayer states.
  function mkPlayer(s: PlayerSpec = {}): LocoPlayer {
    const p = s.pos ?? v(0, 0, 0);
    const vel = s.vel ?? v(0, 0, 0);
    const foot: FootState = {
      planted: 'L',
      pos: new THREE.Vector3(0, 0, 0),
      t: 0,
      contact: false,
      phase: 0,
      stride: 0,
      hard: false,
      speed: 0,
      ...(s.foot ?? {}),
    };
    return {
      id: s.id ?? 1,
      team: 0,
      attr: s.attr ?? DEFAULT_ATTRS,
      pos: new THREE.Vector3(p.x, p.y, p.z),
      vel: new THREE.Vector3(vel.x, vel.y, vel.z),
      facing: s.facing ?? 0,
      state: s.state ?? 'idle',
      stateT: 0,
      stateDur: 0,
      prone: s.prone ?? false,
      anchored: s.anchored ?? false,
      stamina: 100,
      foot,
      air: { airborne: s.airborne ?? false, tTakeoff: 0, tApex: 0, apexY: 0, takeoffY: 0, tLand: 0, vy0: 0 },
      groundY: s.groundY ?? 0,
      groundN: new THREE.Vector3(0, 1, 0),
      radius: s.radius ?? 0.32,
      personal: s.personal ?? 0.63,
      hipHeight: s.hipHeight ?? 0.9,
      cmd: s.cmd ?? v2(0, 0),
      cutDir: new THREE.Vector3(0, 0, 1),
      cutEntrySpeed: 0,
      cutAngle: 0,
      lastStepT: 0,
      t: s.t ?? 0,
      derived: {} as Derived,
    };
  }

  const attrsGrid: Attributes[] = [
    DEFAULT_ATTRS,
    { ...DEFAULT_ATTRS, speed: 0, accel: 0, agility: 0, strength: 0, vertical: 0, endurance: 0, balance: 0 },
    { ...DEFAULT_ATTRS, speed: 100, accel: 100, agility: 100, strength: 100, vertical: 100, endurance: 100, balance: 100 },
    { ...DEFAULT_ATTRS, speed: -20, accel: 150, agility: 50.5, strength: -5, vertical: 40, endurance: 30, balance: 90, height: 1.6, mass: 60 },
    { ...DEFAULT_ATTRS, speed: 45, height: 2.05, mass: 120 },
  ];

  const modes: MoveMode[] = ['sprint', 'run', 'jog', 'backpedal', 'shuffle'];

  /* ------------------------------------------------------------ Attributes */

  const modeCapFractionCases = modes.flatMap((mode) =>
    [-10, 0, 30, 70, 100, 130].map((agility) => ({ mode, agility, want: modeCapFraction(mode as any, agility) })));

  const staminaGrid = [-20, 0, 1, 30, 59, 60, 61, 90, 100, 150];
  const speedGrid = [-5, 0, 0.5, 3, 6.6, 9.6, 12, 20];
  const slopeGrid = [0.6, 1, 1.15];

  const deriveCases: {
    a: Attributes; stamina: number; speed: number; mode: MoveMode; slopeMul: number; want: Derived;
  }[] = [];
  for (const a of attrsGrid) {
    for (const stamina of [0, STAM_FADE, 100]) {
      for (const speed of [0, 4, 9.6]) {
        for (const mode of modes) {
          for (const slopeMul of slopeGrid) {
            deriveCases.push({ a, stamina, speed, mode, slopeMul, want: derive(a, stamina, speed, mode as any, slopeMul) });
          }
        }
      }
    }
  }
  // Extra boundary sweep on stamina/speed alone, default attrs, sprint gait —
  // the fatigue clamp01 and turnRate's speed-fraction clamp01 both have edges.
  for (const stamina of staminaGrid) {
    for (const speed of speedGrid) {
      deriveCases.push({
        a: DEFAULT_ATTRS, stamina, speed, mode: 'sprint', slopeMul: 1,
        want: derive(DEFAULT_ATTRS, stamina, speed, 'sprint', 1),
      });
    }
  }

  const derivedSamples: Derived[] = [
    derive(DEFAULT_ATTRS, 100, 0, 'sprint', 1),
    derive(DEFAULT_ATTRS, 40, 5, 'run', 1),
    derive(attrsGrid[1], 0, 0, 'jog', 1),
    derive(attrsGrid[2], 100, 9, 'sprint', 1),
  ];

  const propulsiveAtCases: { d: Derived; speed: number; cap: number; want: number }[] = [];
  for (const d of derivedSamples) {
    for (const speed of [-1, 0, 0.25, 0.5, 3, d.topSpeed, d.topSpeed * 2]) {
      for (const cap of [0, 0.5, 3, d.modeCap]) {
        propulsiveAtCases.push({ d, speed, cap, want: propulsiveAt(d, speed, cap) });
      }
    }
  }

  const leapHeightCases: { d: Derived; approachSpeed: number; want: number }[] = [];
  const takeoffVyCases: { d: Derived; approachSpeed: number; want: number }[] = [];
  for (const d of derivedSamples) {
    for (const approachSpeed of [-2, 0, 1e-4, 3, d.topSpeed, d.topSpeed * 3]) {
      leapHeightCases.push({ d, approachSpeed, want: leapHeight(d, approachSpeed) });
      takeoffVyCases.push({ d, approachSpeed, want: takeoffVy(d, approachSpeed) });
    }
  }

  const staminaRateCases: { a: Attributes; speed: number; topSpeedFresh: number; want: number }[] = [];
  for (const a of attrsGrid) {
    for (const speed of [-2, 0, 1, 3, 4.032, 6.6, 9.6, 20]) {
      for (const topSpeedFresh of [0, 6.6, 9.6]) {
        staminaRateCases.push({ a, speed, topSpeedFresh, want: staminaRate(a, speed, topSpeedFresh) });
      }
    }
  }

  /* ------------------------------------------------------------------ Gait */

  const gaitSpeedGrid = [-1, 0, 0.1, 0.34, 0.35, 0.36, 1, 5, 10, 30, 100];
  const stepRateCases = gaitSpeedGrid.map((speed) => ({ speed, want: stepRate(speed) }));
  const dutyFactorCases = gaitSpeedGrid.map((speed) => ({ speed, want: dutyFactor(speed) }));
  const stanceHalfWidthCases = modes.flatMap((mode) =>
    gaitSpeedGrid.map((speed) => ({ speed, mode, want: stanceHalfWidth(speed, mode) })));

  // A simple, exactly-representable ground so both sides can compute f.pos.y
  // arithmetically without a shared closure.
  const groundY = (x: number, z: number): number => 0.25 * x - 0.125 * z;

  // Deterministic multi-step trace: the phase oscillator carries state (foot
  // side, phase, stride) across calls, so a single-shot fixture cannot catch a
  // bug that only shows up after several plants.
  type GaitStep = { speed: number; velX: number; velZ: number; mode: MoveMode; dt: number; facing: number };
  const gaitSteps: GaitStep[] = [
    { speed: 0.1, velX: 0, velZ: 0, mode: 'jog', dt: 1 / 60, facing: 0 }, // below GAIT_MIN_SPEED
    { speed: 2.0, velX: 2.0, velZ: 0, mode: 'jog', dt: 1 / 60, facing: 0 },
    { speed: 2.2, velX: 1.5, velZ: 1.5, mode: 'run', dt: 1 / 60, facing: Math.PI / 6 },
    { speed: 5.0, velX: 4.9, velZ: -0.5, mode: 'sprint', dt: 1 / 60, facing: -Math.PI / 3 },
    { speed: 5.1, velX: 5.0, velZ: 0.3, mode: 'sprint', dt: 1 / 20, facing: Math.PI },
    { speed: 1.2, velX: -1.0, velZ: 0.6, mode: 'backpedal', dt: 1 / 60, facing: Math.PI / 2 },
    { speed: 0.9, velX: 0.9, velZ: 0.0, mode: 'shuffle', dt: 1 / 60, facing: -1.9 },
    { speed: 0.34, velX: 0.3, velZ: 0.1, mode: 'jog', dt: 1 / 60, facing: 0 }, // drops back under GAIT_MIN_SPEED
  ];
  const gaitPlayer = mkPlayer({ pos: v(1, 0, -2), facing: 0 });
  const advanceGaitTrace = gaitSteps.map((step) => {
    const result = advanceGait(gaitPlayer, step.speed, step.velX, step.velZ, step.mode, step.dt, groundY);
    gaitPlayer.facing = step.facing; // facing is caller-owned; advance it between steps like Locomotion.ts would
    return {
      step,
      result: { planted: result.planted, foot: result.foot, x: result.x, y: result.y, z: result.z, speed: result.speed },
      footAfter: {
        planted: gaitPlayer.foot.planted,
        t: gaitPlayer.foot.t,
        contact: gaitPlayer.foot.contact,
        phase: gaitPlayer.foot.phase,
        stride: gaitPlayer.foot.stride,
        hard: gaitPlayer.foot.hard,
        speed: gaitPlayer.foot.speed,
        pos: v(gaitPlayer.foot.pos.x, gaitPlayer.foot.pos.y, gaitPlayer.foot.pos.z),
      },
    };
  });
  const advanceGaitInitial = { pos: v(1, 0, -2), facing: 0 };

  // plantForCut has no trig anywhere in it, unlike advanceGait — bit-exact.
  //
  // Both `advanceGait` and `plantForCut` return the SAME module-level scratch
  // object (`Gait.ts`'s `OUT`) to avoid an allocation per call — the fixture
  // must copy its fields out immediately after each call, before the next
  // call mutates it in place, or every stored "result" ends up aliased to
  // whatever the last call in the loop wrote.
  const plantForCutCases: {
    pos: { x: number; y: number; z: number }; speed: number; velX: number; velZ: number; turnSign: number;
    want: { planted: boolean; foot: string; x: number; y: number; z: number; speed: number };
  }[] = [];
  for (const turnSign of [1, -1, 0]) {
    for (const speed of [0.01, 1, 4.5, 9]) {
      const p = mkPlayer({ pos: v(2, 0, 3), t: 1.5 });
      const velX = speed * 0.6, velZ = speed * 0.8;
      const r = plantForCut(p, speed, velX, velZ, turnSign, groundY);
      const want = { planted: r.planted, foot: r.foot, x: r.x, y: r.y, z: r.z, speed: r.speed };
      plantForCutCases.push({ pos: v(2, 0, 3), speed, velX, velZ, turnSign, want });
    }
  }

  /* ------------------------------------------------------------- Separation */

  type ComplianceSpec = {
    airborne?: boolean; state?: LocoStateName; prone?: boolean; anchored?: boolean; mass: number; strength: number;
  };
  const complianceSpecs: ComplianceSpec[] = [
    { mass: 82, strength: 60 },
    { mass: 82, strength: 60, airborne: true },
    { mass: 82, strength: 60, state: 'layout' },
    { mass: 82, strength: 60, state: 'landing' },
    { mass: 82, strength: 60, state: 'recovery' },
    { mass: 82, strength: 60, state: 'fall' },
    { mass: 82, strength: 60, state: 'jump' },
    { mass: 82, strength: 60, prone: true },
    { mass: 82, strength: 60, anchored: true },
    { mass: 1, strength: 0 }, // minimum braced mass clamp: max(1, braced)
    { mass: 40, strength: 0 },
    { mass: 200, strength: 100 },
    { mass: 0, strength: 100 }, // degenerate zero mass
    { mass: -10, strength: 50 }, // negative mass, should still clamp via max(1, .)
  ];
  const complianceCases = complianceSpecs.map((spec) => {
    const p = mkPlayer({
      attr: { ...DEFAULT_ATTRS, mass: spec.mass, strength: spec.strength },
      airborne: spec.airborne, state: spec.state, prone: spec.prone, anchored: spec.anchored,
    });
    return { spec, want: compliance(p) };
  });

  // accumulateSeparation: scenarios exercise the pass, not just a single pair,
  // because the per-body resultant ceiling and the Jacobi summation only show
  // up with >=2 pairs touching one body.
  type SepPlayerSpec = {
    id: number; pos: { x: number; z: number; y?: number }; cmd?: { x: number; z: number };
    radius?: number; personal?: number; state?: LocoStateName; airborne?: boolean; anchored?: boolean; prone?: boolean;
    mass?: number; strength?: number;
  };
  function sepPlayer(s: SepPlayerSpec): LocoPlayer {
    return mkPlayer({
      id: s.id,
      pos: v(s.pos.x, s.pos.y ?? 0, s.pos.z),
      cmd: s.cmd ?? v2(0, 0),
      radius: s.radius ?? 0.32,
      personal: s.personal ?? 0.63,
      state: s.state,
      airborne: s.airborne,
      anchored: s.anchored,
      prone: s.prone,
      attr: { ...DEFAULT_ATTRS, mass: s.mass ?? 82, strength: s.strength ?? 60 },
    });
  }

  type SepScenario = {
    label: string;
    dt: number;
    players: SepPlayerSpec[];
    disc?: DiscFocus;
  };
  const sepScenarios: SepScenario[] = [
    {
      label: 'two bodies, both compliant, well inside the soft radius, no cmd (lateral fallback)',
      dt: 1 / 60,
      players: [{ id: 1, pos: { x: 0, z: 0 } }, { id: 2, pos: { x: 0.4, z: 0 } }],
    },
    {
      label: 'same pair, ids swapped, checks the fallback side flips with id order',
      dt: 1 / 60,
      players: [{ id: 2, pos: { x: 0, z: 0 } }, { id: 1, pos: { x: 0.4, z: 0 } }],
    },
    {
      label: 'commanded approach axis present: correction should be lateral to it',
      dt: 1 / 60,
      players: [
        { id: 1, pos: { x: -0.2, z: 0 }, cmd: { x: 1, z: 0 } },
        { id: 2, pos: { x: 0.2, z: 0 }, cmd: { x: -1, z: 0 } },
      ],
    },
    {
      label: 'already outside the soft radius: no engagement',
      dt: 1 / 60,
      players: [{ id: 1, pos: { x: 0, z: 0 } }, { id: 2, pos: { x: 5, z: 0 } }],
    },
    {
      label: 'inside deadband only: penetration <= 0, ignored',
      dt: 1 / 60,
      players: [{ id: 1, pos: { x: 0, z: 0 } }, { id: 2, pos: { x: 1.26 - SEP_DEADBAND / 2, z: 0 } }],
    },
    {
      label: 'exactly coincident: id-based angle tie-break (uses cos/sin — tolerance)',
      dt: 1 / 60,
      players: [{ id: 3, pos: { x: 1, z: 1 } }, { id: 7, pos: { x: 1, z: 1 } }],
    },
    {
      label: 'vertical gap beyond SEP_Y_SPAN: miss entirely',
      dt: 1 / 60,
      players: [{ id: 1, pos: { x: 0, y: 0, z: 0 } }, { id: 2, pos: { x: 0.2, y: SEP_Y_SPAN + 0.1, z: 0 } }],
    },
    {
      label: 'one body airborne: zero compliance, other takes the whole correction',
      dt: 1 / 60,
      players: [{ id: 1, pos: { x: 0, z: 0 }, airborne: true }, { id: 2, pos: { x: 0.3, z: 0 } }],
    },
    {
      label: 'one anchored (thrower on pivot): does not yield',
      dt: 1 / 60,
      players: [{ id: 1, pos: { x: 0, z: 0 }, anchored: true }, { id: 2, pos: { x: 0.3, z: 0 } }],
    },
    {
      label: 'three bodies wedged: per-body resultant ceiling engages',
      dt: 1 / 30,
      players: [
        { id: 1, pos: { x: 0, z: 0 } },
        { id: 2, pos: { x: 0.3, z: 0 } },
        { id: 3, pos: { x: -0.3, z: 0.1 } },
      ],
    },
    {
      label: 'heavier body yields less: unequal compliance splits the correction unevenly',
      dt: 1 / 60,
      players: [
        { id: 1, pos: { x: 0, z: 0 }, mass: 60, strength: 0 },
        { id: 2, pos: { x: 0.4, z: 0 }, mass: 150, strength: 100 },
      ],
    },
    {
      label: 'loose disc nearby fades personal space toward the grab radius',
      dt: 1 / 60,
      players: [{ id: 1, pos: { x: 0, z: 0 } }, { id: 2, pos: { x: 1.0, z: 0 } }],
      disc: { x: 0.5, z: 0, live: true },
    },
    {
      label: 'disc present but not live: full personal space still applies',
      dt: 1 / 60,
      players: [{ id: 1, pos: { x: 0, z: 0 } }, { id: 2, pos: { x: 1.0, z: 0 } }],
      disc: { x: 0.5, z: 0, live: false },
    },
    {
      label: 'disc beyond DISC_FREE_R: fade has no effect',
      dt: 1 / 60,
      players: [{ id: 1, pos: { x: 0, z: 0 } }, { id: 2, pos: { x: 1.0, z: 0 } }],
      disc: { x: 100, z: 100, live: true },
    },
    {
      label: 'disc inside DISC_GRAB_R of both: personal space fully suppressed',
      dt: 1 / 60,
      players: [{ id: 1, pos: { x: 0, z: 0 } }, { id: 2, pos: { x: 0.4, z: 0 } }],
      disc: { x: 0.2, z: 0, live: true },
    },
  ];
  const accumulateSeparationCases = sepScenarios.map((s) => {
    const players = s.players.map(sepPlayer);
    const outX = new Float64Array(players.length);
    const outZ = new Float64Array(players.length);
    const engaged = accumulateSeparation(players, s.dt, outX, outZ, s.disc ?? null);
    return {
      label: s.label,
      dt: s.dt,
      players: s.players,
      disc: s.disc ?? null,
      want: { engaged, outX: Array.from(outX), outZ: Array.from(outZ) },
    };
  });

  // Swift's DiscProbe reuses the TS bind()/read() *contract* but not its
  // registry duck-typing (there is no `sys['game'] ?? sys['disc']` lookup on
  // the Swift side — `DiscRuntimeInfo` is a plain struct the caller builds).
  // So the fixture drives the reference through the simplest binding shape
  // (`{ disc: { mode, state: { pos } } }`) that reaches the same `read()`
  // logic, rather than exercising the registry fallback Swift never ported.
  // Non-finite input is exercised on the Swift side directly (see
  // `MoveTests`'s `discProbeNonFinite` property check) because `JSON.stringify`
  // cannot carry `NaN` across the fixture boundary — the same limitation
  // `Check.bitEqViaJSON` documents for signed zero.
  const discProbe = new DiscProbe();
  type DiscProbeCase = { label: string; runtime: { mode: string; x: number; z: number } | null };
  const discProbeSpecs: DiscProbeCase[] = [
    { label: 'no runtime bound', runtime: null },
    { label: 'loose disc, valid position: live passthrough', runtime: { mode: 'loose', x: 3, z: -4 } },
    { label: 'held disc: not live, position zeroed', runtime: { mode: 'held', x: 3, z: -4 } },
    { label: 'loose disc at the origin', runtime: { mode: 'loose', x: 0, z: 0 } },
  ];
  const discProbeCases = discProbeSpecs.map((c) => {
    const sys = c.runtime ? { disc: { mode: c.runtime.mode, state: { pos: { x: c.runtime.x, z: c.runtime.z } } } } : null;
    discProbe.bind(sys);
    const out: DiscFocus = { x: 0, z: 0, live: false };
    const got = discProbe.read(out);
    return { label: c.label, runtime: c.runtime, want: { x: got.x, z: got.z, live: got.live } };
  });

  /* ---------------------------------------------------------------- Contest */

  const contestPlayerSpecs = {
    grounded: mkPlayer({ pos: v(0, 0.9, 0), vel: v(0, 0, 0), hipHeight: 0.9, attr: DEFAULT_ATTRS }),
    airborneRising: mkPlayer({ pos: v(0, 1.2, 0), vel: v(1, 3, 0.5), airborne: true, hipHeight: 0.9, attr: DEFAULT_ATTRS }),
    layoutDiving: mkPlayer({ pos: v(1, 0.6, 0.5), vel: v(2, 1.5, 0.2), airborne: true, state: 'layout', hipHeight: 0.9, attr: DEFAULT_ATTRS }),
  };

  const predictPosCases: { who: keyof typeof contestPlayerSpecs; t: number; want: { x: number; y: number; z: number } }[] = [];
  const reachAtCases: { who: keyof typeof contestPlayerSpecs; t: number; want: number }[] = [];
  for (const who of Object.keys(contestPlayerSpecs) as (keyof typeof contestPlayerSpecs)[]) {
    const p = contestPlayerSpecs[who];
    for (const t of [-0.2, 0, 0.15, 0.5, 1.2]) {
      const out = new THREE.Vector3();
      const pos = predictPos(p, t, out);
      predictPosCases.push({ who, t, want: v(pos.x, pos.y, pos.z) });
      reachAtCases.push({ who, t, want: reachAt(p, t) });
    }
  }

  type ContestScenario = {
    label: string;
    a: { pos: [number, number, number]; vel: [number, number, number]; airborne?: boolean; state?: LocoStateName; strength?: number; height?: number };
    b: { pos: [number, number, number]; vel: [number, number, number]; airborne?: boolean; state?: LocoStateName; strength?: number; height?: number };
    disc: [number, number, number];
    tContest: number;
    jitter?: number;
  };
  const contestScenarios: ContestScenario[] = [
    {
      label: 'A closer and rising, B flat-footed: A should win',
      a: { pos: [0, 1.0, 0], vel: [1, 3, 0], airborne: true },
      b: { pos: [3, 0.9, 0], vel: [0, 0, 0] },
      disc: [0.2, 2.0, 0],
      tContest: 0.3,
    },
    {
      label: 'symmetric except strength, bodies jostling close: stronger wins the box-out',
      a: { pos: [0, 0.9, 0], vel: [0, 0, 0], strength: 90 },
      b: { pos: [0.5, 0.9, 0], vel: [0, 0, 0], strength: 20 },
      disc: [0.25, 1.5, 0],
      tContest: 0.2,
    },
    {
      label: 'margin under 0.03: declared a tie (none)',
      a: { pos: [0, 0.9, 0], vel: [0, 0, 0] },
      b: { pos: [0, 0.9, 0.001], vel: [0, 0, 0] },
      disc: [0, 1.5, 0],
      tContest: 0.1,
    },
    {
      label: 'A driving hard into B at contact distance: foul on A',
      a: { pos: [0, 0.9, 0], vel: [3, 0, 0] },
      b: { pos: [0.5, 0.9, 0], vel: [0, 0, 0] },
      disc: [0.25, 1.5, 0],
      tContest: 0.1,
    },
    {
      label: 'bodies well apart: no contact, no foul',
      a: { pos: [0, 0.9, 0], vel: [0, 0, 0] },
      b: { pos: [4, 0.9, 0], vel: [0, 0, 0] },
      disc: [2, 1.5, 0],
      tContest: 0.1,
    },
    {
      label: 'jitter tie-break moves the margin without flipping a clear winner',
      a: { pos: [0, 0.9, 0], vel: [0, 0, 0] },
      b: { pos: [3, 0.9, 0], vel: [0, 0, 0] },
      disc: [0.1, 1.5, 0],
      tContest: 0.1,
      jitter: 1,
    },
    {
      label: 'layout diver vs standing defender',
      a: { pos: [0.3, 0.6, 0.2], vel: [2, 1, 0.3], airborne: true, state: 'layout' },
      b: { pos: [0.6, 0.9, 0.1], vel: [0, 0, 0] },
      disc: [0.4, 1.0, 0.2],
      tContest: 0.05,
    },
    {
      label: 'B moving into A hard enough for the foul: foul on B',
      a: { pos: [0, 0.9, 0], vel: [0, 0, 0] },
      b: { pos: [0.4, 0.9, 0], vel: [-3, 0, 0] },
      disc: [0.2, 1.5, 0],
      tContest: 0.1,
    },
  ];
  function mkContestPlayer(spec: ContestScenario['a']): LocoPlayer {
    return mkPlayer({
      pos: v(...spec.pos), vel: v(...spec.vel), airborne: spec.airborne, state: spec.state,
      attr: { ...DEFAULT_ATTRS, strength: spec.strength ?? 60, height: spec.height ?? 1.83 },
    });
  }
  const contestAirCases = contestScenarios.map((s) => {
    const a = mkContestPlayer(s.a);
    const b = mkContestPlayer(s.b);
    const disc = new THREE.Vector3(...s.disc);
    const got = contestAir(a, b, disc, s.tContest, s.jitter ?? 0);
    return {
      label: s.label,
      a: s.a, b: s.b, disc: v(...s.disc), tContest: s.tContest, jitter: s.jitter ?? 0,
      want: {
        winner: got.winner,
        a: got.a, b: got.b,
        margin: got.margin,
        contact: got.contact,
        foulOn: got.foulOn,
        foulChance: got.foulChance,
      },
    };
  });

  /* ----------------------------------------------------------------- Ground */

  // Deterministic field stand-ins, all exactly-representable arithmetic so the
  // Swift side can reproduce them with an equivalent closure and compare
  // heightAt bit-exact; only the normal's normalisation goes through a
  // tolerance-worthy path (division, not a transcendental — kept bit-exact
  // here since it is a single divide, matching Vec3d.normalized).
  const flatField: FieldLike = {};
  const slopedField: FieldLike = {
    heightAt: (x, z) => 0.1 * x - 0.2 * z,
    normalAt: (x, z, out) => (out ?? new THREE.Vector3()).set(0.2, 0.9, -0.1),
  };
  const brokenField: FieldLike = {
    heightAt: () => NaN,
    normalAt: (_x, _z, out) => (out ?? new THREE.Vector3()).set(NaN, 1, 0),
  };
  const nearFlatNormalField: FieldLike = {
    heightAt: (x, z) => x + z,
    normalAt: (_x, _z, out) => (out ?? new THREE.Vector3()).set(1, 1e-5, 0), // n.y <= 1e-4: falls back to UP
  };
  const heightOnlyField: FieldLike = {
    heightAt: (x, z) => 5 + x,
    // no normalAt at all
  };
  const normalOnlyField: FieldLike = {
    // no heightAt: per Ground.ts, this makes bind() treat the whole field as absent
    normalAt: (_x, _z, out) => (out ?? new THREE.Vector3()).set(0, 1, 0),
  };

  type GroundCase = { label: string; field: FieldLike | null; points: [number, number][] };
  const groundCases: GroundCase[] = [
    { label: 'no field bound', field: null, points: [[0, 0], [3, -2]] },
    { label: 'flat field object with no methods', field: flatField, points: [[0, 0], [3, -2]] },
    { label: 'sloped field, well-formed', field: slopedField, points: [[0, 0], [4, -3], [-2.5, 6.25]] },
    { label: 'broken field: NaN height and NaN normal component', field: brokenField, points: [[1, 1]] },
    { label: 'near-flat normal below the 1e-4 floor falls back to UP', field: nearFlatNormalField, points: [[2, 2]] },
    { label: 'heightAt only, no normalAt: normal falls back to UP', field: heightOnlyField, points: [[1, 0]] },
    { label: 'normalAt only, no heightAt: whole field treated as absent', field: normalOnlyField, points: [[1, 0]] },
  ];
  const groundProbeCases = groundCases.map((c) => {
    const probe = new GroundProbe();
    probe.bind(c.field ? { field: c.field } : null);
    const samples = c.points.map(([x, z]) => {
      const h = probe.heightAt(x, z);
      const n = probe.normalAt(x, z, new THREE.Vector3());
      const s = probe.sample(x, z, { y: 0, n: new THREE.Vector3() });
      return { x, z, height: h, normal: v(n.x, n.y, n.z), sampleY: s.y, sampleN: v(s.n.x, s.n.y, s.n.z) };
    });
    return { label: c.label, hasField: probe.hasField, samples };
  });

  const gradeAlongCases: { n: { x: number; y: number; z: number }; dx: number; dz: number; want: number }[] = [];
  const normals = [
    v(0, 1, 0),
    v(0.2, 0.9797958971132712, 0.05),
    v(-0.3, 0.9539392014169456, 0),
    v(0.1, 1e-5, 0), // degenerate: n.y <= 1e-4
  ];
  const dirs: [number, number][] = [[1, 0], [0, 1], [1, 1], [-1, -1], [0, 0], [1e-8, 1e-8]];
  for (const n of normals) {
    for (const [dx, dz] of dirs) {
      gradeAlongCases.push({ n, dx, dz, want: gradeAlong(new THREE.Vector3(n.x, n.y, n.z), dx, dz) });
    }
  }

  const gradeGrid = [-2, -0.5, -0.34375, 0, 0.09375, 0.5, 2];
  const slopeMultiplierCases = gradeGrid.map((grade) => ({ grade, want: slopeMultiplier(grade) }));

  return {
    note:
      'Generated by tools/gen-goldens.ts from src/sim/move/*.ts. Pure arithmetic ' +
      '(+ - * / sqrt min max clamp) is bit-exact; Math.pow, the sin/cos in the gait ' +
      'plant projection, and everything downstream of Math.hypot get a stated ' +
      'tolerance instead — see the doc comment in tools/goldens/move.ts.',

    constants: {
      STAM_FADE, G, COST_JUMP, COST_LAYOUT, COST_CUT,
      GAIT_MIN_SPEED,
      PERSONAL_RADIUS, SEP_RATE, SEP_DEADBAND, SEP_Y_SPAN, DISC_GRAB_R, DISC_FREE_R,
      PRONE_Y,
    },

    modeCapFractionCases,
    deriveCases,
    propulsiveAtCases,
    leapHeightCases,
    takeoffVyCases,
    staminaRateCases,

    stepRateCases,
    dutyFactorCases,
    stanceHalfWidthCases,
    advanceGaitInitial,
    advanceGaitTrace,
    plantForCutCases,

    complianceCases,
    accumulateSeparationCases,
    discProbeCases,

    predictPosCases,
    reachAtCases,
    contestAirCases,

    groundProbeCases,
    gradeAlongCases,
    slopeMultiplierCases,
  };
}
