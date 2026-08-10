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

`ChargeTests` and `TouchTests.testDragReleasesAThrow` both fail this way on CI, where the
probe reads `poss=1;phase=live;mine=0;flight=0;thrown=0;score=0-0` — ninety seconds of live
play in which the opponent held throughout and we never touched it.

## Measured on a Mac with a GPU, same simulator, same invocation

Both tests **pass** locally either side of the issue-#66 pitch-scale fix; what changes is
how close they run to the 90 s wait timeout.

| test | before (`b3a7d10`) | after (`a87b7d5`), two samples |
|---|---|---|
| `ChargeTests.testAimingAtTheWindowGetsACleanRelease` | 76.1 s | 66.3 s, 44.6 s |
| `TouchTests.testDragReleasesAThrow` | 35.1 s | 9.5 s, 28.5 s |

So the fix roughly halves the wait, and 76 s against a 90 s timeout is why CI — which runs a
software renderer and is slower in wall-clock for the same match time — went red while a
developer machine stayed green. **The headroom roughly doubled and the structure did not
change**, and the sample-to-sample spread on `ChargeTests` is 22 s, so this is still a test
that passes on margin rather than by construction.

## Why nothing caught it

It was read as a minis authenticity bug — the default mode really was stalling out every
possession — so the timeout looked like a symptom of that. It is not: sevens, which has
never had the authenticity problem, waits 47-62 s on the same predicate, and no amount of
making the AI play better removes a wait that is one whole point cycle long.

## Suggestion

Do not make the test wait for the game to hand it a possession. Either

- give the driver a launch argument that starts a point with the disc in the controlled
  player's hand (`Engine.wound-forward` states already exist in `EngineTests`), or
- let the driver ask for possession the way `Engine` already can — `autoTeams = [0, 1]`
  until the test is ready, so the human's team plays on rather than stalling, and the wait
  becomes a wait for a *catch* rather than for a whole point cycle.

Raising the timeout is the wrong fix: it makes a 90 s test a 180 s test and it will drift
back the moment the pacing changes again.
