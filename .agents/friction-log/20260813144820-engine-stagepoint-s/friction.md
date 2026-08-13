---
title: 'Engine.stagePoint''s opening formation is not lineUpForPull — puller position differs before a tick moves anyone'
severity: 'minor'
---

## Description

Building `swift/Sources/SimChecks/Goldens/pull.json` (issue #48) required calling
`Engine.autoPull()` immediately after `Engine.init`, with zero `update()` ticks in
between — matching the reference generator, which calls `doPull()` right after
`GameSystem.init(ctx)` with no `update()` loop either (see `tools/goldens/pull.ts`'s
header for why the zero-tick timing is load-bearing: `TeamAI` shares the engine's own
`rng` stream rather than a fork, so any AI decision before the pull draws from that
stream first and shifts the pull's own seeded jitter).

At that zero-tick instant, the two engines' rosters are NOT standing in the same
place. `Game.ts`'s `lineUpForPull()` (called from `GameSystem.init`) places the pulling
team hard against the sidelines, one row deep:

    x = -SIDELINE + 3.5 + (i/6) * (2*SIDELINE - 7)
    z = -dir*GOAL_LINE + dir*0.5

`Engine.stagePoint()` places everyone with a different, more generic opening-shape
formula:

    lateral = (slot/span - 0.5) * width * 0.6
    z = -dir * goalLine * 0.95

Measured for seed 11's puller (id 9, team 1): reference `(-5.0, 31.5)`, port
`(-3.7, 30.4)` — a real, reproducible gap, not a rounding difference. The port's own
comment on `stagePoint` says as much: "Positions are only a starting shape — the AI
takes over on the first tick and moves everyone where the formation actually wants
them." So the two engines converge only after ticks let `TeamAI`/`Playbook`
repositioning run, and there is no reference counterpart to compare that convergence
against, because `lineUpForPull` never moves the reference's puller at all — it stays
exactly where it was lined up until the pull is thrown.

## Why this didn't block issue #48

`pull.json`'s cases place the puller's `Locomotion` body explicitly at the fixture's
recorded position/facing/groundY/hipHeight before calling `autoPull()`, sidestepping
the question entirely — `doPull`'s own aim/throw formula is what issue #48 is about,
and engineering the input means the fixture is exactly as broad as that bug. But it
means `pull.json` does NOT verify that a real, ticked match ever puts the puller
where the reference would at the moment of a real pull — only that the formula is
right once a puller is wherever he ends up.

## Suggestion

Worth its own issue: either port `lineUpForPull`'s exact formula into
`Engine.stagePoint` (or a dedicated method called on entering `.prePull`, mirroring
`onPhaseChange`'s `if (to === 'PRE_PULL') this.lineUpForPull()`), or measure whether
`stagePoint` + a few ticks of `TeamAI` settling converges close enough that it doesn't
matter in practice. Given the pull fires after `pullSettle` (0.8s, ~96 ticks) or
`pullDeadline` (5s) of real match time, the AI likely has settled the line somewhere
reasonable by then — but "reasonable" and "the reference's exact lineup" are different
claims, and only the second is covered by anything today.
