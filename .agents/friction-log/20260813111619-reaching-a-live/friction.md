---
title: 'Reaching a live canDefend/canCallCut state in headless SimChecks needs autoTeams=[1] plus a real tick-driven wait, not a fresh Engine'
severity: 'minor'
---

## Description

Writing headless SimChecks coverage for `MatchDirector.syntheticInputs()` (issue #16
Phase 3 — `autoDefend`/`demoCut` decision timing) against a freshly constructed
`Engine` fails silently useful assertions: a fresh `Engine` sits at `Phase.prePull`,
so `Engine.canDefend` (needs `possession != 0` and a live/in-flight phase) and
`Engine.canCallCut` (needs `.livePossession` and `carrier == controlled`) are both
false, and `attemptDefend()`/humanCallCut-style checks against it either refuse or
(worse) pass vacuously because the "true" branch of a conditional assertion never
runs.

Getting a match into a state where these are actually testable needs a real
tick-driven wait, the same technique `HumanCutTests.ourPossession` and
`HumanDefenceTests`' own possession helper already use:

```swift
let e = Engine(format: .minis, seed: S)   // autoTeams defaults to [1]
var ticks = 0
while !(e.game.phase == .livePossession && e.possession == 0 /* or 1 */), ticks < 120 * 240 {
    e.step(dt: 1.0/120)
    ticks += 1
}
```

`autoTeams` defaulting to `[1]` is load-bearing (documented on
`HumanCutTests.ourPossession` but not obvious from `Engine`'s own doc comments):
team 1 auto-throws so the match actually progresses; team 0 never auto-throws, so
once team 0 catches it stays "ours" long enough to assert against instead of being
thrown away on the very next tick.

A second trap on the same axis: `FrameClock.maxTicksPerFrame` (30 at 120 Hz) clamps
a single `beginFrame`/`runTicks` call, so a naive "one big hitch buys hundreds of
ticks" catch-up-burst scenario silently caps at 30 ticks per call and never reaches
a threshold hundreds of ticks away — it needs a loop of hitches, not one. This is
the same clamp `TickLoopTests.tickCountsUnderCatchUpBurst` already exercises
directly, but it is easy to forget when writing a *new* scenario against
`MatchDirector` rather than reading that one first.

## Where this bit

`swift/Sources/SimChecks/InputScriptTests.swift`, writing headless coverage for
issue #16 Phase 3 (`MatchDirector.InputScript`/`syntheticInputs()`). First-draft
tests asserted against a match seeded with `autoTeams = [0, 1]` or `[]` and got
either 4 outright failures (attemptDefend() refusing, "saw neither branch") or,
worse, ~600 assertions that were silently vacuous (the "true" branch of an
`if e.canCallCut { assert... } else { assert nil }` split never actually taking the
`true` arm across 600 ticks). Neither failure mode is obvious from a green run —
the second only surfaces if you count assertions per branch, which nothing does
automatically.
