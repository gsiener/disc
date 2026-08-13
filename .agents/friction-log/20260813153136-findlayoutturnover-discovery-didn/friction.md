---
title: 'findLayoutTurnover discovery didn''t account for hitstop cooldown, only for event presence'
severity: 'minor'
labels:
  - 'port-fidelity'
---

## Description

While fixing issue #56 (`Engine.stagePoint`'s opening formation), the full
`SimTests` run showed clean at the parent commit and red at mine — 9
failures spread across `engine`/`events`/`matchsave`/`tickloop`/`humancut`.
Most were straightforward "assertion count moved with a real behaviour
change" churn (floors lowered in `Harness.swift`/`HumanCutTests.swift`,
documented at each site), but `TickLoopTests.hitstopTickDropping` and
`.slowMoBurstBoundary` failed for a subtler reason worth recording.

`findLayoutTurnover()` swept seeds `[11, 23, 37, 53, 71, 89, 103, 127]`
with a bare `Engine.step(dt:)` loop, looking only for the first tick that
*drains* a `.turnover(...,.layout,...)` event, and handed that tick to two
scenarios that replay it through `TickLoopDriver`/`MatchDirector` expecting
a hitstop to start there. A layout turnover only starts a hitstop when
`FrameClock.canSlow`'s cooldown has cleared — real wall-clock time since
the last hitstop, not tick count — and a bare `Engine.step` loop has no
`FrameClock` at all, so it cannot see whether an *earlier*
hitstop-eligible event (a contested catch, for instance) left the cooldown
still warm a few ticks before the layout turnover it found.

Before the formation fix, every seed in the sweep happened to reach its
first layout turnover with the cooldown clear, so this gap was invisible.
The formation fix changed match trajectories enough that seeds 11–89 no
longer produce a layout turnover inside the 300 s sweep window at all, and
seed 103 — the one the sweep now lands on — has its first layout turnover
land a few ticks after an earlier hitstop-eligible catch, inside that
catch's own cooldown. The event still drains right where `findLayoutTurnover`
said it would; it just doesn't start a *hitstop* there, which is the only
thing the two consuming scenarios actually check.

## Fix

Rewrote `findLayoutTurnover` to discover its tick by driving through the
same `TickLoopDriver`/`MatchDirector` the scenarios themselves use (one
steady tick per call, wall time advancing in exact lockstep with tick
count — the same invariant `runSteady` relies on), and to only return a
tick where `hitstopsStarted` actually increased. That makes "found" and
"reproduces" the same claim, so a future seed-sweep landing shift can't
silently reintroduce this gap.

## Lesson

A discovery helper that bypasses the exact mechanism its own consumers
exercise (here: `FrameClock`'s cooldown) can find a tick that satisfies a
*necessary* condition (the event drains) without satisfying the *actual*
one (a hitstop starts) — and it will get away with it for as long as
every candidate in a fixed seed list happens not to expose the gap. Worth
a second look anywhere else a "find a seed where X happens" helper in this
suite uses a cheaper simulation than the scenario that consumes its
answer.
