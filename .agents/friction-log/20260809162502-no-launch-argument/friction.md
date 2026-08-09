---
title: 'No launch argument shortens a match, so verifying anything at full time costs ~10 minutes of Simulator wall time'
severity: 'minor'
---

## What happened

Fixing a bug in the result-card state (the tick loop kept running behind it) needed an on-device observation of `match.isOver == true`. The only way to get there is to play a whole game.

`-setup off` starts a match, but the length comes from `MatchSetup`, which lives in `Prefs`/`UserDefaults` and is only reachable through the pre-game sheet — i.e. through a tap, which this environment cannot synthesise. The shortest game the sheet offers is first-to-5 on minis, and a passive human side (no throws, stall-out every ten seconds, the AI scores) takes roughly 100 seconds per point: about **ten minutes of Simulator wall time per observation**, times two if you want the before and after.

## What would help

A `-points N` launch argument alongside the existing `-format`, `-setup off`, `-charge`, `-defend on` and `-savecycle` — the same door, the same reasoning as all five of those. `-points 1` would put the result card on screen in under two minutes.

## Workaround used

Transcribed the tick loop into a `SimChecks` suite against a real `Engine` built with `pointsToWin = 1`, which reproduced the defect headlessly in under a second (120 wasted `Engine.step` calls per second behind the result card), and used the ten-minute Simulator run only as a confirmation.
