---
title: 'MatchDriver.waitToThrow waits for OUR player to hold, which with no input happens once per point — 47-96 s against a 90 s timeout, at both formats'
severity: 'major'
---

## Description

`MatchDriver.waitToThrow` blocks on the app's `canThrow`, which is
`phase == .livePossession && carrier == controlled`. Control follows the disc, so that
predicate is really "team 0 is in live possession". A UI test driver throws only when it
decides to, and until then the human's team **cannot throw at all** — `Engine.autoTeams`
defaults to `[1]`, so every possession the driver does not act on runs the count out. Team 0
therefore touches the disc about once per point cycle, and each cycle spends 25-45 s in
`PRE_PULL`, `PULL_IN_FLIGHT`, `POINT_SCORED` and `TIMEOUT`, none of which is a live
possession.

Measured headlessly with no input, over 300 s per seed, on the same predicate the driver
waits on:

| format | first window | worst wait between windows | share of wall time in hand |
|---|---|---|---|
| minis, four seeds | 25-64 s | **38-96 s** | 14-34% |
| sevens, two seeds | 47-52 s | **47-62 s** | 21-29% |

`MatchDriver.wait`'s default timeout is 90 s. There is no margin on either format, and
`ChargeTests.testAimingAtTheWindowGetsACleanRelease` calls `waitToThrow` twice with five
retries each.

## Why nothing caught it

It was read as a minis authenticity bug — the default mode really was stalling out every
possession — so the timeout looked like a symptom of that. It is not: sevens, which has
never had the authenticity problem, waits 47-62 s on the same predicate. Fixing the minis
stall-out share to 0% (issue #66) moved these numbers around by seed and did not fix them,
because the wait is not caused by how the AI plays.

## Suggestion

Do not make the test wait for the game to hand it a possession. Either

- give the driver a launch argument that starts a point with the disc in the controlled
  player's hand (`Engine.wound-forward` states already exist in `EngineTests`), or
- let the driver ask for possession the way `Engine` already can — `autoTeams = [0, 1]`
  until the test is ready, so the human's team plays on rather than stalling, and the wait
  becomes a wait for a *catch* rather than for a whole point cycle.

Raising the timeout is the wrong fix: it makes a 90 s test a 180 s test and it will drift
back the moment the pacing changes again.
