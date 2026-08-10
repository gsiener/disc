---
title: 'Three suites played the same eleven matches, and nothing in the code said so'
severity: 'major'
---

## Description

`stoppage`, `calls` and `matchdiff` each measure the eleven canonical sevens matches —
seeds `[11, 23, 37, 2, 5, 7, 13, 19, 29, 41, 53]`, default config, `autoTeams = [0, 1]`,
`120 * 900` ticks at 1/120. Every one of them played those matches for itself, and
`stoppage` played them three times over:

| suite | function | match-plays |
|---|---|---|
| `stoppage` | `theTimeoutIsCalled` | 11 |
| `stoppage` | `theCountResumesOneHigher` | 5 (the first five, again) |
| `stoppage` | `aTimeoutIsNotALineUp` | 5 (the same five, a third time) |
| `calls` | `callsAreRare` | 3 + 8 |
| `matchdiff` | `theSameMatchesProduceTheSameEvents` | 11 |

Forty-three plays of eleven matches. Measured: `stoppage` 297.4 s, `calls` 120.7 s,
`matchdiff` 118.9 s — **537 of the suite's 724 seconds, for eleven matches' worth of
simulation.** The three suites were not disagreeing about what the matches are; they were
each looking at a different part of the same match and throwing the rest away.

The three seed lists were written out longhand in three files, so nothing anywhere said
they were the same eleven matches. `MatchDiffTests` even carries a fixture spec with the
seeds in it and never compared them to anything.

## What made it invisible

Nothing about it was hidden by the tooling: `Harness.swift` has recorded per-suite
assertions and seconds since it was written, and `SimTests` prints them on every run. The
table said `stoppage 4476 assertions 297.353s` next to `teamai 475891 assertions 0.224s`
for weeks. The cost was not measurement; it was that a suite's runtime and a *different*
suite's seed list are never on the same screen.

The tell is in the table itself and is worth naming, because it is the cheap way to find
the next instance: **assertions per second spanning six orders of magnitude between
suites.** `teamai` asserts 2.1 M/s off a recorded trace; `stoppage` asserted 15/s. A suite
whose rate is that far below the others is either integrating something expensive on
purpose or re-deriving a fixture, and it is worth opening to find out which.

## Wall-clock on this box is not a measurement

A second cost, and it is the reason this took two runs rather than one: load average on
the shared checkout's machine went 35 → 10 → 92 → 159 inside twenty minutes while peers
built, on ten cores. The same suite measured 640 s in the issue and 724 s here with
nothing changed between them but the neighbours. Anything measured once, while other
agents are compiling, is a measurement of the neighbours.

What survived that: a work *count* — forty-three match-plays reduced to eleven is a 4x
reduction in simulation whatever the box is doing. What did not: the wall-clock gain from
running independent matches concurrently, which is real on an idle CI runner and
unmeasurable here.

## Suggestion

Two, in the order they would have helped:

1. **A shared fixture per pool of matches, not per suite** — `MatchPool` now holds the
   eleven and records every observation any suite wants in one pass. A fourth suite that
   wants a fourth thing off the same matches should add a field, not a loop.
2. **`Harness` should print process CPU time next to wall-clock.** On a box at load 159
   the seconds column is noise, and this repo's whole method is measurement over argument.
   CPU seconds would have made the before/after here a single number instead of a caveat.
   (Not done in this change: `Harness.swift` is the file peers add suite lines to, and
   `20260809175052-registering-a-simchecks` is about exactly that collision.)
