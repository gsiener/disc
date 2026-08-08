import * as THREE from 'three';

import type { Attributes, LocoPlayer, MoveMode } from '../../src/sim/move/Types.ts';
import { DEFAULT_ATTRS } from '../../src/sim/move/Types.ts';
import type { FieldLike } from '../../src/sim/move/Ground.ts';
import { Locomotion, type LocoHost } from '../../src/sim/Locomotion.ts';

/* --------------------------------------------------------------- locomotion */

/**
 * Fixtures for `src/sim/Locomotion.ts`.
 *
 * LOCOMOTION IS STATEFUL, so these are traces rather than case tables. One
 * `LocoPlayer` is a long-lived object mutated in place by a state machine, a
 * friction-ellipse solve, a phase oscillator and a ballistic integrator, and the
 * bugs worth catching are the ones that only appear on step 40: a `stateDur` that
 * is set but never compared, a cut that never releases, a `groundY` that is
 * sampled before the body moved instead of after. A single-shot fixture cannot see
 * any of them. So the generator seeds a player, drives it through a scripted
 * command sequence, and records the FULL player state after every single step.
 *
 * Two traces:
 *
 *   `soloTrace`  one athlete through accelerate / hold / hard cut / jump / layout /
 *                land / recover / uphill / brake / backpedal / shuffle / 180 cut.
 *                `resolveCollisions` is called every step even though there is only
 *                one body, because the re-seat pass runs regardless and it is the
 *                thing that puts the COM back on the surface.
 *
 *   `pairTrace`  two athletes run head-on. This is the only way to reach the soft
 *                separation tier, hard contact, the momentum transfer, the stumble
 *                and the foul draw — all of which are pairwise and therefore
 *                invisible to the solo trace.
 *
 * ------------------------------------------------------------------ strictness
 *
 * Almost every line of `Locomotion.ts` is `+ - * / sqrt min max clamp`, and the
 * Swift side asserts those bit-for-bit. The exceptions, all of which the consuming
 * suite states for itself:
 *
 *   - `Math.hypot` is everywhere in here (speed, distances, the ellipse magnitude).
 *     IEEE 754 does not require it to be correctly rounded and V8 and Darwin libm
 *     differ by a few ulps, so anything downstream of a speed gets a tolerance.
 *     Since the solve feeds velocity back into itself, that means the whole trace
 *     is a tolerance trace — but a TIGHT one, and the tolerance is checked against
 *     the worst observed deviation rather than picked to pass.
 *   - `Math.exp` in the gather/recovery decay, `Math.acos` in the cut test,
 *     `Math.cos` in the cut loss, `Math.sin`/`Math.cos`/`Math.atan2` in facing, and
 *     `Math.pow` inside `propulsiveAt`/`staminaRate`.
 *   - integration accumulates all of the above over hundreds of steps.
 *
 * Discrete state — `state`, `prone`, `airborne`, `foot.planted`, `foot.contact`,
 * `foot.hard`, the event kinds, `sepPairs`, the foul id and whether it was called —
 * is exact, and that is where the real assertions live: a tolerance can hide a
 * slightly different velocity, but it cannot hide a cut that never ended.
 */
export function locomotionGoldens() {
  const v = (x: number, y: number, z: number) => ({ x, y, z });

  /* -------------------------------------------------------------- the world */

  // A tilted plane, chosen so the slope terms are genuinely exercised: the grade
  // along +x is 0.1, which is slopeMultiplier 0.84 — not 1, and not clamped, so a
  // sign error in `gradeAlong`'s dot or in `slopeMultiplier` shows up as a speed
  // difference rather than as a clamp that swallows it. Both sides define this
  // arithmetic literally; there is no shared closure to lean on.
  const H_X = 0.1;
  const H_Z = -0.05;
  const heightAt = (x: number, z: number): number => H_X * x + H_Z * z;
  // Consistent with that gradient: n ∝ (-dh/dx, 1, -dh/dz). GroundProbe normalises.
  const RAW_N = { x: -H_X, y: 1, z: -H_Z };

  const field: FieldLike = {
    heightAt,
    normalAt: (_x, _z, out) => (out ?? new THREE.Vector3()).set(RAW_N.x, RAW_N.y, RAW_N.z),
  };

  type Ev =
    | { kind: 'footstep'; id: number; pos: { x: number; y: number; z: number }; foot: string; speed: number; hard: boolean }
    | { kind: 'land'; id: number; pos: { x: number; y: number; z: number }; impact: number; layout: boolean }
    | { kind: 'contact'; a: number; b: number; impact: number; foulOn: number; called: boolean };

  function mkHost(sink: Ev[]): LocoHost {
    return {
      events: {
        emit(evt: string, payload?: unknown): void {
          const p = payload as Record<string, any>;
          if (evt === 'player:footstep') {
            sink.push({ kind: 'footstep', id: p.id, pos: v(p.pos.x, p.pos.y, p.pos.z), foot: p.foot, speed: p.speed, hard: p.hard });
          } else if (evt === 'player:land') {
            sink.push({ kind: 'land', id: p.id, pos: v(p.pos.x, p.pos.y, p.pos.z), impact: p.impact, layout: p.layout });
          } else if (evt === 'player:contact') {
            sink.push({ kind: 'contact', a: p.a, b: p.b, impact: p.impact, foulOn: p.foulOn, called: p.called });
          }
        },
      },
      // No `rand`: the model falls back to its own literal seed, `new Rng(0x10c05eed)`,
      // which is what the Swift port must also construct. Handing it a parent stream
      // here would mean the fixture, not the reference, chose the seed.
      sys: { field } as unknown as Record<string, unknown>,
    };
  }

  /* ------------------------------------------------------------- the snapshot */

  /**
   * Every field of a `LocoPlayer` that the model can change.
   *
   * `radius`, `personal`, `hipHeight` and `anchored` are set by `create()` and never
   * written again, so they appear once in each trace's `initial` rather than 1100
   * times over — and the Swift side asserts they really did not move, which is the
   * claim that justifies leaving them out.
   */
  function snapFull(p: LocoPlayer) {
    return {
      ...snap(p),
      radius: p.radius,
      personal: p.personal,
      hipHeight: p.hipHeight,
      anchored: p.anchored,
    };
  }

  function snap(p: LocoPlayer) {
    return {
      pos: v(p.pos.x, p.pos.y, p.pos.z),
      vel: v(p.vel.x, p.vel.y, p.vel.z),
      facing: p.facing,
      state: p.state,
      stateT: p.stateT,
      stateDur: p.stateDur,
      prone: p.prone,
      stamina: p.stamina,
      foot: {
        planted: p.foot.planted,
        pos: v(p.foot.pos.x, p.foot.pos.y, p.foot.pos.z),
        t: p.foot.t,
        contact: p.foot.contact,
        phase: p.foot.phase,
        stride: p.foot.stride,
        hard: p.foot.hard,
        speed: p.foot.speed,
      },
      air: {
        airborne: p.air.airborne,
        tTakeoff: p.air.tTakeoff,
        tApex: p.air.tApex,
        apexY: p.air.apexY,
        takeoffY: p.air.takeoffY,
        tLand: p.air.tLand,
        vy0: p.air.vy0,
      },
      groundY: p.groundY,
      groundN: v(p.groundN.x, p.groundN.y, p.groundN.z),
      cmd: { x: p.cmd.x, z: p.cmd.z },
      cutDir: v(p.cutDir.x, p.cutDir.y, p.cutDir.z),
      cutEntrySpeed: p.cutEntrySpeed,
      cutAngle: p.cutAngle,
      lastStepT: p.lastStepT,
      t: p.t,
      derived: { ...p.derived },
    };
  }

  /* ------------------------------------------------------------- the script */

  type Leg = {
    label: string;
    /** How many fixed steps this leg runs for. */
    n: number;
    dt: number;
    dir: { x: number; z: number } | null;
    speed?: number;
    effort?: number;
    maxSpeed?: number;
    mode?: MoveMode;
    face?: { x: number; z: number } | null;
    jump?: boolean;
    layout?: boolean;
    brake?: boolean;
  };

  const DT = 1 / 120;

  // Jump and layout are one-step legs on purpose. Holding the flag would be
  // harmless while the body is committed (a committed state returns control 0 and
  // never reaches the takeoff request), but it would fire again the instant the
  // landing resolved to idle, and the trace would be a pogo stick instead of a
  // sequence.
  //
  // Leg lengths are the shortest that let each mechanism finish. They are not
  // padding: the jump leg has to cover a 0.12 s gather, a ~0.8 s arc and a landing
  // recovery, and the layout leg a gather, a dive, a slide to rest and a ~1 s
  // get-up. Shortening either would leave the mechanism half-played and the trace
  // would stop asserting the thing it exists for.
  const soloScript: Leg[] = [
    { label: 'stand still, no direction at all', n: 12, dt: DT, dir: null },
    { label: 'accelerate north at a sprint', n: 60, dt: DT, dir: { x: 0, z: 1 }, mode: 'sprint' },
    { label: 'hold the sprint at speed', n: 20, dt: DT, dir: { x: 0, z: 1 }, mode: 'sprint' },
    // 90 degrees off the line of travel, above CUT_MIN_SPEED: forces a plant.
    { label: 'hard cut 90 degrees to +x', n: 40, dt: DT, dir: { x: 1, z: 0 }, mode: 'sprint' },
    { label: 'settle onto the new line', n: 20, dt: DT, dir: { x: 1, z: 0 }, mode: 'run' },
    { label: 'request a jump', n: 1, dt: DT, dir: { x: 1, z: 0 }, mode: 'run', jump: true },
    { label: 'gather, take off, fly, land', n: 160, dt: DT, dir: { x: 1, z: 0 }, mode: 'run' },
    { label: 'rebuild speed after the landing', n: 40, dt: DT, dir: { x: 1, z: 0 }, mode: 'run' },
    { label: 'request a layout', n: 1, dt: DT, dir: { x: 1, z: 0 }, mode: 'run', layout: true },
    { label: 'gather, dive, land prone, slide, get up', n: 250, dt: DT, dir: null },
    { label: 'run uphill (+x is up this plane)', n: 60, dt: DT, dir: { x: 1, z: 0 }, mode: 'sprint' },
    { label: 'run downhill', n: 60, dt: DT, dir: { x: -1, z: 0 }, mode: 'sprint' },
    { label: 'hard stop', n: 25, dt: DT, dir: { x: -1, z: 0 }, brake: true },
    // face opposite the travel direction: resolveMode's 'auto' picks backpedal.
    { label: 'backpedal, auto gait from the facing', n: 50, dt: DT, dir: { x: 0, z: -1 }, face: { x: 0, z: 1 }, mode: 'auto' },
    // face 90 degrees off travel: 'auto' picks shuffle, and turnToward holds the look.
    { label: 'shuffle, auto gait from the facing', n: 50, dt: DT, dir: { x: 1, z: 0 }, face: { x: 0, z: 1 }, mode: 'auto' },
    { label: 'auto gait with no face at all falls back to run', n: 30, dt: DT, dir: { x: 1, z: 1 }, mode: 'auto' },
    { label: 'part effort', n: 30, dt: DT, dir: { x: 1, z: 1 }, mode: 'sprint', effort: 0.35 },
    { label: 'absolute speed request under the cap', n: 30, dt: DT, dir: { x: 1, z: 1 }, mode: 'sprint', speed: 3.5 },
    { label: 'maxSpeed ceiling below the mode cap', n: 30, dt: DT, dir: { x: 1, z: 1 }, mode: 'sprint', maxSpeed: 2.0 },
    { label: 'release the ceiling and sprint', n: 60, dt: DT, dir: { x: 1, z: 1 }, mode: 'sprint' },
    // A full 180: the largest cut loss the model can produce.
    { label: 'reverse 180 degrees', n: 40, dt: DT, dir: { x: -1, z: -1 }, mode: 'sprint' },
    { label: 'and again immediately — inside CUT_REFRACTORY, so refused', n: 20, dt: DT, dir: { x: 1, z: 1 }, mode: 'sprint' },
    // dt above the 1/30 clamp, and a non-positive dt that must be a no-op.
    { label: 'oversized dt gets clamped to 1/30', n: 4, dt: 1 / 10, dir: { x: 1, z: 1 }, mode: 'sprint' },
    { label: 'zero dt is a no-op', n: 2, dt: 0, dir: { x: 1, z: 1 }, mode: 'sprint' },
  ];

  const soloAttrs: Attributes = { ...DEFAULT_ATTRS };
  // Emitted rather than duplicated on the Swift side. The seed is half of what a
  // trace comparison means: a replay that starts a centimetre away agrees with
  // nothing, and a hand-copied literal is exactly how that happens.
  const soloSeed = { id: 3, team: 0 as const, pos: v(-4, 0, -6), facing: 0, stamina: 92 };

  function runSolo() {
    const events: Ev[] = [];
    const loco = new Locomotion();
    loco.attach(mkHost(events));
    const p = loco.create({
      id: soloSeed.id, team: soloSeed.team, attr: soloAttrs,
      pos: new THREE.Vector3(soloSeed.pos.x, soloSeed.pos.y, soloSeed.pos.z),
      facing: soloSeed.facing, stamina: soloSeed.stamina,
    });
    const initial = snapFull(p);
    const steps: unknown[] = [];
    soloScript.forEach((leg, legIndex) => {
      for (let i = 0; i < leg.n; i++) {
        const before = events.length;
        loco.step(p, {
          dir: leg.dir,
          speed: leg.speed,
          effort: leg.effort,
          maxSpeed: leg.maxSpeed,
          mode: leg.mode,
          face: leg.face ?? null,
          jump: leg.jump,
          layout: leg.layout,
          brake: leg.brake,
        }, leg.dt);
        loco.resolveCollisions(leg.dt);
        steps.push({
          leg: legIndex,
          player: snap(p),
          sepPairs: loco.sepPairs,
          sepWork: loco.sepWork,
          events: events.slice(before),
        });
      }
    });
    return { initial, steps };
  }

  /* ---------------------------------------------------------------- the pair */

  // Two bodies on a collision course. The lighter, weaker one is on the left so the
  // unequal inverse-mass split is observable in the positional correction, and
  // neither is anchored, so both tiers move both bodies.
  const pairAttrsA: Attributes = { ...DEFAULT_ATTRS, mass: 68, strength: 35, balance: 40, agility: 85 };
  const pairAttrsB: Attributes = { ...DEFAULT_ATTRS, mass: 104, strength: 88, balance: 80, agility: 55 };
  const pairSeedA = { id: 11, team: 0 as const, pos: v(-3.2, 0, 0), facing: Math.PI / 2, stamina: 100 };
  const pairSeedB = { id: 4, team: 1 as const, pos: v(3.2, 0, 0), facing: -Math.PI / 2, stamina: 100 };
  const PAIR_STEPS = 180;

  function runPair() {
    const events: Ev[] = [];
    const loco = new Locomotion();
    loco.attach(mkHost(events));
    const mk = (s: typeof pairSeedA, attr: Attributes) => loco.create({
      id: s.id, team: s.team, attr,
      pos: new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z), facing: s.facing, stamina: s.stamina,
    });
    const a = mk(pairSeedA, pairAttrsA);
    const b = mk(pairSeedB, pairAttrsB);
    const initial = { a: snapFull(a), b: snapFull(b) };
    const steps: unknown[] = [];
    // 180 steps is long enough to sprint in, hit, and play the stumble out. The ids
    // are 11 and 4 — deliberately NOT in list order — because `Separation`'s
    // degenerate tie-break and `resolveContacts`'s foul attribution both read ids,
    // and an ascending roster would let an id/index confusion pass.
    for (let i = 0; i < PAIR_STEPS; i++) {
      const before = events.length;
      loco.step(a, { dir: { x: 1, z: 0 }, mode: 'sprint' }, DT);
      loco.step(b, { dir: { x: -1, z: 0 }, mode: 'sprint' }, DT);
      loco.resolveCollisions(DT);
      steps.push({
        a: snap(a), b: snap(b),
        sepPairs: loco.sepPairs,
        sepWork: loco.sepWork,
        events: events.slice(before),
      });
    }
    return { initial, steps };
  }

  const solo = runSolo();
  const pair = runPair();

  return {
    note:
      'Generated by tools/gen-goldens.ts from src/sim/Locomotion.ts. Multi-step ' +
      'traces, one snapshot of the whole player per fixed step. Discrete state ' +
      '(state, prone, airborne, foot side/contact/hard, event kinds, sepPairs, ' +
      'foulOn, called) is exact; continuous state carries a stated tolerance ' +
      'because Math.hypot feeds the velocity solve and the solve integrates — see ' +
      'the doc comment in tools/goldens/locomotion.ts.',

    constants: {
      CUT_ANGLE: 45 * Math.PI / 180,
      CUT_MIN_SPEED: 2.2,
      PLANT_GRIP: 1.8,
      PLANT_BRAKE: 1.35,
      CUT_LOSS_BASE: 0.28,
      CUT_REFRACTORY: 0.22,
      JUMP_GATHER: 0.12,
      LAYOUT_GATHER: 0.06,
      JUMP_HORIZ_KEEP: 0.88,
      AIR_CONTROL: 0.7,
      SLIDE_DECEL: 15.7,
      LAND_HORIZ_KEEP: 0.62,
      COLLIDE_BETA: 0.80,
      COLLIDE_SLOP: 0.002,
      COLLIDE_RESTITUTION: 0.03,
      COLLIDE_FRICTION: 0.45,
      COLLIDE_Y_SPAN: 1.0,
      DEFAULT_RADIUS: 0.32,
    },

    field: { hx: H_X, hz: H_Z, rawNormal: RAW_N },

    soloScript,
    soloAttrs,
    soloSeed,
    solo,

    pairAttrs: { a: pairAttrsA, b: pairAttrsB },
    pairSeed: { a: pairSeedA, b: pairSeedB },
    pair,
  };
}
