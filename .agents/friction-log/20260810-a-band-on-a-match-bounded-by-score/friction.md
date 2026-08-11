---
title: 'A richness band on a match bounded by SCORE fails when the game gets better, and reads as a regression'
severity: 'minor'
---

## Description

`EventTests.streamReconciles` played `Engine(format: .minis, target: 5)` for a tick budget
of `120 * 600` and then asserted `t.all.count > 40`, under the message "a ten-minute match
produces a stream worth checking". The match is not ten minutes and never was: it ends the
moment somebody reaches five, so the stream is exactly as long as the offence is
inefficient.

Scaling the AI's pitch constants for issue #17 made the minis offence more efficient. The
same seed produced the identical 0-5 scoreline in **10 attempts and 161 s instead of 18 and
215 s**, so the event stream went 54 -> 38 and the band went red. Nothing had gone wrong.
The assertion was measuring the offence's inefficiency and calling it coverage.

The cost was the diagnosis, not the fix: a red assertion whose message says "ten-minute
match" gives no hint that the match is score-bounded, so it reads as a regression in event
emission. Confirming otherwise took a second release build of the baseline commit in a
detached worktree to get the before-numbers — about fifteen minutes for one integer.

## Why nothing caught it

The neighbouring test in `EngineTests` already knows this and says so:

> Played to 25 rather than the minis 7 so that ten minutes of ticks is ten minutes of
> ticks. [...] a match that *finishes* early silently halves the coverage — which is
> exactly what happened the moment the offence started scoring.

That comment is in `playsWithoutBlowingUp`, one file away, and records the identical bug
being fixed once already. The lesson stayed local to the test it was learned in.

There is a second instance in the same file: the catch-grade pool at
`EventTests.swift:225` carries a comment explaining that a game to five is "about a dozen
catches, and a dozen draws is not a sample", and its author's remedy was to pool three more
seeds rather than to lengthen the match — so the file contains both the diagnosis and a
different fix for it.

## Suggestion

**A test that wants a LENGTH of play must not let the score end the match.** Pass a target
the tick budget cannot reach and let the budget bind; the reconciliation assertions are
equalities between the stream and the box score, so they hold at any length and get
strictly stronger with more of it. `play(seed:ticks:target:)` now takes the target and
`streamReconciles` asks for 99, which also makes its message true for the first time.

The general form, for the next one: **a band over "how much happened" is only a coverage
floor if the sample is bounded by TIME.** If it is bounded by an outcome, the band is a
measurement of how badly the thing under test performs, and improving it fails the test.
