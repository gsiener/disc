/**
 * THE MATCH-LEVEL DIFFERENTIAL — the fixture that looks at the integration.
 *
 * Every other fixture in this directory pins a *component*: a number in, a
 * number out, bit-exact. That is the right shape for `Rules`, `SimMath` and the
 * aero curves, and it has caught real porting bugs. It has also, four separate
 * times in one day, been completely blind to the bug that actually shipped —
 * because in every one of those four the components agreed and the integration
 * did not:
 *
 *   - strips fired 3 times over 11 reference matches and **zero** times over the
 *     same 11 in the port, with `catchContactCall` itself differed bit-exact and
 *     green (#55);
 *   - the throw solver bombed 42% of short throws in one engine and not the
 *     other, while its own goldens passed;
 *   - `throwReleaseSpeed` was never ported at all, and a Swift-only mutation of
 *     it survived 2.24M green assertions;
 *   - the reference ran its deep game on a fallback glide integrator, because
 *     the catch predictor reached the disc through the render system, which does
 *     not exist headless.
 *
 * All four have the same signature: **a discrete event that happens at one rate
 * in one engine and a different rate — often zero — in the other.** That is what
 * this fixture measures, and it is the only fixture here that measures anything
 * about a whole match.
 *
 * ---------------------------------------------------------------- what it is
 *
 * Eleven full 7v7 matches of the reference, and the pooled count of every
 * discrete thing that happened in them: turnovers by reason, calls by kind,
 * attempts, completions, goals, points, blocks, stall-outs. No floats, no
 * positions, no times — the facts a box score would carry.
 *
 * ------------------------------------------------------- what it is NOT, and why
 *
 * It is **not** tick-identity, and it cannot be. The two engines are not the same
 * program from the same seed and never have been:
 *
 *   - the reference derives its engine seed (`ctx.rand.fork(0x6a3e1c).int(…)`)
 *     while the port seeds `Rng(seed:)` directly;
 *   - the reference deals its roster from a *separate* fork (`0x0a11ce`) at team
 *     overalls `[76, 74]`, the port deals its from the engine stream at 72 for
 *     both, off a different archetype order;
 *   - the port forks a wind stream at construction that the reference does not.
 *
 * So seed 11 is a 3-9 game in the reference and an 8-9 game in the port, with
 * fourteen different athletes on the field. Making those identical is a re-port
 * of construction and roster generation that would move every other fixture in
 * this directory, and it is not what this task is. Recorded here rather than in
 * a report so the next person does not rediscover it.
 *
 * What survives that is the *distribution*, and a distribution is enough for the
 * bug shape above. `SimChecks/MatchDiffTests.swift` asserts two things off this
 * file, and the first is the one with the teeth:
 *
 *   1. **Reachability parity.** Every event kind the reference produces, the port
 *      must also produce, and vice versa. This is exactly the 3-versus-0 that #55
 *      was, and it is the only assertion here that would have caught all four
 *      bugs above.
 *   2. **Rate agreement**, per match, inside a band the check states for itself.
 *
 * And the honest limit: a kind that happens 0.27 times per match — strips — is
 * bounded away from zero only *because eleven matches is enough to see three of
 * them*. A kind rarer than that would need a pool this fixture cannot afford, and
 * the check says so at the point where it would matter.
 */

import * as THREE from 'three';

import { EventBus, QUALITY_PRESETS, Rng, type Ctx } from '../../src/core/Ctx.ts';
import { GameSystem } from '../../src/sim/Game.ts';
import type { TeamId } from '../../src/sim/Rules.ts';

/** The pool. Shared with `CallsTests.swift`, so the two read as one experiment. */
const SEEDS = [11, 23, 37, 2, 5, 7, 13, 19, 29, 41, 53];

/** A full fifteen-minute 7v7 match, the length every other match check uses. */
const SECONDS = 900;
const DT = 1 / 120;

/**
 * Every turnover reason the rules can emit, listed rather than discovered.
 *
 * Discovering the keys from the run would make a reason that stopped happening
 * disappear from the fixture instead of showing up as a zero — which is the
 * exact failure this file exists to catch, so the vocabulary is written out.
 * It is `TurnoverReason` in `Rules.ts` and `GameTypes.swift`, identically.
 */
const REASONS = [
  'drop', 'throwaway', 'out-of-bounds', 'caught-out-of-bounds', 'block',
  'interception', 'stall-out', 'pull-drop', 'travel-violation', 'double-touch',
] as const;

function makeCtx(seed: number): Ctx {
  return {
    renderer: null as unknown as THREE.WebGLRenderer,
    scene: null as unknown as THREE.Scene,
    camera: null as unknown as THREE.PerspectiveCamera,
    composer: null,
    time: 0, dt: 0, rawDt: 0, timeScale: 1, frame: 0,
    width: 1920, height: 1080, dpr: 1,
    quality: { ...QUALITY_PRESETS.high },
    events: new EventBus(),
    rand: new Rng(seed),
    sys: Object.create(null),
    debug: false,
    capture: false,
  } as unknown as Ctx;
}

export function matchDiffGoldens(): unknown {
  const turnovers: Record<string, number> = {};
  for (const r of REASONS) turnovers[r] = 0;
  const calls = { foul: 0, pick: 0, strip: 0, travel: 0, contested: 0 };
  let attempts = 0, completions = 0, goals = 0, blocks = 0, stallOuts = 0, points = 0;
  let matches = 0;

  for (const seed of SEEDS) {
    const ctx = makeCtx(seed);
    const game = new GameSystem();
    ctx.sys['game'] = game;
    ctx.events.on('turnover', (p: { reason?: string }) => {
      const r = p?.reason ?? '?';
      turnovers[r] = (turnovers[r] ?? 0) + 1;
    });
    game.init(ctx);

    for (let i = 0; i < Math.round(SECONDS / DT); i++) {
      if (game.gs.phase === 'GAME_OVER') break;
      ctx.time += DT;
      game.update(DT, ctx);
    }

    matches += 1;
    points += game.gs.point;
    for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k] += game.callTally[k];
    for (let t = 0 as TeamId; t <= 1; t = (t + 1) as TeamId) {
      const ts = game.gs.teamStats(t);
      attempts += ts.attempts;
      completions += ts.completions;
      goals += ts.goals;
      blocks += ts.blocks;
      stallOuts += ts.stallOuts;
    }
  }

  return {
    spec: { seeds: SEEDS, seconds: SECONDS, dt: DT, format: 'sevens', playersPerSide: 7 },
    matches,
    turnovers,
    calls,
    totals: { attempts, completions, goals, blocks, stallOuts, points },
  };
}
