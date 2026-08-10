---
title: 'The throw solver takes no wind term, so a windy day is 21% throwaways rather than a harder game'
severity: 'major'
---

## Description

`src/sim/aero/ThrowSolver.ts` and `Aero/ThrowSolver.swift` contain no reference to wind.
`DiscPhysics.simulate` takes a wind vector and integrates it properly; the solver that
decides *what release to aim* does not see it. Every throw in the game is therefore aimed
as if the air were still, and the flight it gets is the aimed flight plus however far the
wind moves it.

That did not matter while the match wind was drawn from ±1.5 m/s. Making the zone
defence reachable (issue #20) required a wind that clears 4.5 m/s, and at that point the
gap becomes the dominant term in the match. Measured over eleven fifteen-minute matches
with the day pinned, TS reference engine:

| wind | completion | throwaways | hucks >=30 m |
|---|---|---|---|
| 0 m/s   | 86.8% | 7.9%  | 1.5/match |
| 2 m/s   | 90.8% | 6.1%  | 3.0/match |
| 4 m/s   | 87.7% | 9.0%  | 3.0/match |
| 6 m/s   | 85.7% | 11.1% | 4.0/match |
| 8 m/s   | 78.8% | 16.9% | 13.0/match |
| 10 m/s  | 79.5% | 18.7% | 9.5/match  |

One throw in five missing entirely at 8 m/s is not "the wind punishes hucks", it is an
aiming bug that scales with wind speed. `tools/test-ai.ts` has been carrying a red
assertion that says so in one line — `windy completion % stays sane: 47.9% in wind vs
76.0% calm` — and it predates this work.

Two consequences beyond completion percentage, both measured:

- The offence responds to wind by **hucking more**, 4x at 8 m/s, because
  `AI.maxThrowRange` grows 4.5% per m/s of tailwind and nothing costs it for the
  crosswind. A zone point currently averages 7.1 throws against a person point's 10.8 —
  the offence is going deep into a cup with a deep, rather than working it sideways,
  which is the opposite of what a zone point looks like.
- The **pull** had the same blindness and it was worse, because a pull is lofted. Fixed
  for the pull only, in `Engine.autoPull`: `probeThrow` integrates the actual flight, so
  the aim is now corrected by the miss it predicts, and the launch angle flattens into a
  headwind. Before that, a 1.5 m/s crosswind on the minis pitch was enough to put a pull
  out the side.

## Suggestion

`ThrowSolver` already bisects; the wind belongs in the same loop the way
`Engine.solvePower` now uses it. Until then any weather stronger than a breeze reads as
a broken game rather than a hard one, and `shouldPlayZone`'s 4.5 m/s threshold cannot be
met by a match anyone would want to watch.
