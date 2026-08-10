---
title: 'A CI timeout override only reached the waits that took the default — two tests died on hardcoded 10 s and 5 s literals while the job looked configured'
severity: 'major'
---

## Description

`MatchDriver.patience` was the suite's one timing knob and it branched on `CI`:

```swift
static let patience: TimeInterval =
    ProcessInfo.processInfo.environment["CI"] == nil ? 10 : 90
```

It was reached by `MatchDriver.wait`'s *default* timeout and by nothing else. Every wait that
passed a number bypassed it, and the tests passed numbers:

| call site | literal | what it waits for |
|---|---|---|
| `ChargeTests.throwOnce` | `timeout: 10` | the release to be resolved |
| `TouchTests.testDragBackToTheOrigin…` | `timeout: 5` | the drag to be resolved |
| `TouchTests` cut/defence retries | `timeout: 90` | the control to be legal again |
| `RefusalTests` | `timeout: 150`, `180` | our own offence / a stoppage |

So the job was configured for a machine with no GPU in one place and for a developer's Mac in
five others. CI run 31384063453 (`affa2ed`) failed exactly there:

- `ChargeTests.testHoldingTooLongIsOvercharged` — `timed out after 10s waiting for the release
  to be resolved (attempt 1)`, probe `poss=0;mine=1;thrown=0`. A healthy app that had not yet
  written the throw down.
- `TouchTests.testDragBackToTheOriginCancelsTheThrow` — `timed out after 5s waiting for the
  drag to be resolved`, probe `poss=1;mine=0;refused=1;refuse=everybodyDown`.

**A knob half the waits ignore is worse than no knob**, because the job looks tuned. Nothing
in the suite made the literals visible: they read as local judgements about how long a
specific thing takes, and each one was individually reasonable.

## The second half: `CI` is not a safe thing to branch on

`CI=true` is exported by a dozen local tools. A developer with it set ran the whole suite at
the 90 s budget and could not have seen a regression that a tight local run fails on — the
override was silently one-way. The environment variable that selects a timing regime has to
be one that nothing else sets.

## Fix

Three named durations on `MatchDriver` — `patience`, `settle`, `samplingCap` — each a multiple
of one `slowdown` read from `UITEST_SLOWDOWN`, which `.github/workflows/ci.yml` sets to `4`
explicitly. `wait`'s default is `patience` and **no call in the suite passes a number**. The
scale is printed once per run by `MatchDriver.announce()`, because a duration only means
something next to the scale it was measured at.

## Suggestion

When a timeout is stretched for a slow machine, grep for every other timeout in the same
suite in the same commit. The stretch is only true of the ones that take the default.

## The third failure in that run was not a wait at all, and somebody else had already found it

`ChargeTests.testAimingAtTheWindowGetsACleanRelease` failed differently, at
`MatchDriver.swift:32` — `app.launch()` — after **88.6 s**, with `Application
'com.grahamsiener.ultimate' does not have a process ID`. No wait constant could fix it, and it
would have been easy to spend an afternoon looking for a launch race in the harness.

It is a **simulator that had not finished booting**. `xcodebuild test` boots a shut-down
simulator by itself, so the first boot lands *inside the first test*, where its cost is charged
to that test's timeout and its failure is reported as that test failing. That was diagnosed and
fixed in `2e38164` ("The touch job stops failing for reasons that are not the game") while this
entry was being written: the job now has `Boot the simulator` with `simctl bootstatus -b`, a
separate `build-for-testing` step, and a warm-up launch. Issue #14 has the evidence.

**Two agents were looking at the same red job from opposite ends** — one at the waits, one at
the runner — and the overlap was only visible because `git log` was re-read mid-task. Which is
the reusable part: on a red CI job with several distinct failures, check whether the ones that
are not your subject already have a commit before theorising about them.
