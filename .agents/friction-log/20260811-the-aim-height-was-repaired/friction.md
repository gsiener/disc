---
title: 'A callee that silently repairs its caller''s bad input makes the input unobservable: 1699 of 1699 throws asked for an unreachable aim plane with every fixture green'
severity: 'major'
---

## Description

Issue #4's second occurrence was fixed in August by `ThrowSolver.SOLVE_CATCH_DROP`, which
clamps the solved catch plane under the release height so `probeThrow`'s
descending-crossing test is unconditional. That fix is correct and the note documenting it
is thorough. It also **left the caller's ask wrong and made it unobservable**, because the
repair happened two modules away from the caller that needed it.

`AI.ts` asked for `aimY: 1.35`. `solveRelease` clamped it to `from.y - 0.25`, about 0.79 m.
Measured over the eleven canonical matches, instrumenting the *ask* rather than the outcome:

| | before | after |
|---|---|---|
| throws handing the solver a plane above the reachable one | **1699 of 1699** | 0 of 1658 |
| `predictCatchPoint().y` below the AI's own floor (0.85 m) | **251,940 of 536,030** | 0 |
| `predictCatchPoint().y` below the rules' floor (0.20 m) | **280** | 0 |
| lowest rendezvous returned | **0.013 m** | 0.850 m |

Every one of those is a 100 % or 47 % failure rate on a property, sustained for days, with
2.25 M assertions green throughout. Nothing was flaky and nothing was rare.

## Why nothing saw it

**The clamp made the symptom disappear.** After it the flight is fine: the disc arrives at
0.79 m, the receiver meets it, completion sits at 89 %. The only surviving trace is a
0.55 m disagreement between what one module asks for and what another does, which appears
in no output.

**The fixture that owns the solver cannot reach the case.** `tools/goldens/throwsolver.ts`
sweeps `from = (0, 1.35, 0)` — a release height of 1.35 m — against `aim.y = 1.35`. At that
release the ask clamps to 1.10, the crossing fires, and the solve is well posed. The bug
needs a real body: `Locomotion` puts the hip at `0.53 * height` and `Game.releaseOrigin`
puts the hand at `hipHeight * 1.10`, so a 1.72–1.90 m roster releases from 1.00–1.11 m.
**The fixture's own release height is 24 cm above the tallest player in the game**, and that
one number is why 640 solver cases could not see a defect present in 100 % of live throws.

## The obvious fix is the wrong one, and it costs 2.3 points of completion

The tempting repair is to make the ask literally reachable:
`AIM_HEIGHT = HAND_HEIGHT - CATCH_PLANE_DROP` = 0.80 m. It was tried, and it is a real
gameplay regression, because a constant cannot track the thrower's body while
`from.y - 0.25` can:

| | `aimY = 1.35`, clamped downstream | `aimY = 0.80` |
|---|---|---|
| `test-game.ts` pooled completion (6 seeds) | 85.2 % — inside the 85–96 % band | **82.9 % — out of band** |
| completion over 11 matches | 89.4 % | 88.6 % |
| `test-game.ts` failures | 1 (the known `seed 33333`) | 2 |
| `SimTests` | green | 2 red, incl. matchdiff reachability parity |

The plane the disc is delivered at *should* depend on the thrower's height; a named
constant makes it not. So the fix that landed keeps the ask at 1.35 as a stated
**preference** and moves the cap from inside `solveRelease` to `Game.aiThrow`, which is the
only site holding this throw's real release height. Bit-identical — the plane the solver
uses is the plane it always used — and it is what makes the precondition assertable at the
seam rather than trusted to a callee.

## What would help

- **Assert the input at the seam, not the output at the end.** A clamp is a statement that
  the input may be wrong; the assertion that it usually is not belongs where the caller can
  see it. `CatchBandTests` now asserts that the plane handed to the solver sits under the
  release — red for every throw in the game before the cap moved, green after, and it costs
  nothing to run.
- **A synthetic fixture's constants are part of the test.** `from.y = 1.35` was chosen for
  convenience and quietly became the reason the sweep was blind. Where a fixture picks a
  value the production code derives, it should derive it the same way or say in one line
  why it does not.
- **"It did not come up in eleven matches" is not "it cannot happen."** The rendezvous grid
  in `tools/goldens/catchband.ts` is synthetic on purpose: it sweeps descent rates past the
  point where one sample step crosses the whole band, which live play produces only
  occasionally and a fixture can produce every time.

The reproduction is in `artifacts/`: `catchband.ts` instruments the ask and the rendezvous
over eleven matches (copy to `tools/_catchband.ts`, gitignored by pattern, and add the two
`__BAND` probe lines its header names), and `solveprobe.ts` flies the solver against nobody
at real release heights.
