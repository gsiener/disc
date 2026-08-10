---
title: 'A UI test cannot wait for a second possession — a lost pull costs a whole point cycle, so the fix is to relaunch the app (1.3 s) rather than wait (40 s)'
severity: 'major'
---

## Description

`-receive us` (`EngineConfig.startingPullTeam`) gives the human's team the opening pull, so a
touch test gets the disc 2–6 s after launch instead of one opponent possession later. That fixes
the *first* possession and nothing else, and the second one is the interesting case.

There is no way for a test to ask for another possession. If the pull is dropped or turned over
before the gesture lands, the disc goes to the opponent and our team next touches it **one whole
point cycle later**. Measured across ~33 test launches on an iPhone 17 Pro, this happened on
roughly one launch in fifteen, and cost 35–43 s each time:

| test | median | unlucky launch |
|---|---|---|
| `TouchTests.testDragReleasesAThrow` | 7.9 s | **45.6 s** |
| `ChargeTests.testLettingGoImmediatelyIsRushed` | 7.4 s | timed out at 12 s (`score=0-1`, `thrown=0`, `dragend=-`) |

The instinct is to size the timeout to the worst case. That is exactly the trap: it makes every
unlucky run slow, and it hides the day the *common* case regresses, because one number now covers
both. It is how `MatchDriver.patience` became 90 s in the first place.

## Fix

**Discard the match instead of waiting for it.** `app.terminate(); app.launch()` costs **1.3 s**
— measured, from `Terminate` to the probe being readable — and `MatchView.freshSeed()` draws a new
seed per launch, so a relaunch is a fresh point with fresh luck. `MatchDriver.withTheDisc` waits
12 s for the disc and relaunches if it does not arrive, up to four attempts.

Two things this depends on, both worth knowing before copying it:

- **The oracle has to be a difference across the gesture, not a baseline captured up front.** A
  relaunch resets `MatchView.inputs`, so `thrown` goes back to 0. `ChargeTests` throws twice in
  one test, and a baseline of 1 read before a relaunch can never be beaten again — a hang that
  would have looked like a broken release. `withTheDisc` hands `resolve` both the before and the
  now state so a test cannot make that mistake.
- **`pitchRect` is deliberately not re-read.** It is a fact about the configuration and the
  device, not about the match, and `testThePitchIsTheRectangleTheTapsAssume` is what guards it.

Result, same machine, same eleven tests: **527 s → 151 s (debug) / 142 s (release)**, slowest
test 34 s, and the 45 s tail is bounded at ~25 s.

## Suggestion

When a test needs a state the simulation only reaches sometimes, price *restarting* against
*waiting* before choosing a timeout. On this app a relaunch is 1.3 s against a 40 s wait, a
factor of thirty, and it turns a long tail into a bounded retry. The general form: if the state
is cheap to re-roll, re-roll it — a timeout sized to the worst case is a timeout that hides the
best case regressing.
