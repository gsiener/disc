---
title: 'EngineTests'' deep-game bands are per-seed maxima over a handful of hucks, so any unrelated change flips them'
severity: 'major'
---

`EngineTests.playAndMeasure` asserts, per seed, `completedDists.max() >= 28`
("and reaches downfield") and `hucksAttempted >= 2` ("the deep game exists").
Both are statistics of the **tail** of one fifteen-minute match: the seeds
attempt between 0 and 13 hucks, and the longest completion is the maximum over
that handful. The hold-share band is asserted per seed too, over 11-17 points.

Any change that reshuffles the match — and every change to the calls layer
reshuffles it, because a stoppage moves everything after it — resamples those
tails. Working on issue #59 (the foul detectors), five configurations of a
change that touched no throwing code at all produced these three seeds:

| config | s11 longest | s23 longest | s37 longest | s11/s23/s37 hucks |
|---|---|---|---|---|
| re-land only            | 35.4 | 33.9 | 33.1 | 8 / 3 / 4 |
| + marking-foul gate     | 35.4 | 33.9 | 27.4 | 5 / 3 / 1 |
| + defensive bid         | 35.4 | 26.2 | 26.2 | 11 / 2 / 2 |
| + a 1.20 m dive ceiling | 35.4 | 28.8 | 27.3 | 7 / 4 / 3 |
| + a 1.30 m dive ceiling | 35.4 | 27.4 | 27.3 | 9 / 0 / 3 |

Nothing in that table is a statement about the deep game. It is the same deep
game sampled five times.

## How it showed up

As two red checks per run that could not be made green by fixing anything,
only by re-rolling. Each re-roll costs a full `SimTests` run (about eight
minutes), and the check that says whether a laid-out D happens at all is a
0-or-1 count over three games, so the loop is eight minutes to resample a coin.

## What would help

Assert these **pooled over the asserted seeds** rather than per seed: "the
longest completion across the three matches is at least 28 m" and "hucks are
attempted at least twice a match on average" say the thing that was meant, and
a change that really did remove the deep game still fails them. The per-seed
version is only tighter in the sense that a coin is tighter than a die.

Same for `HumanDefenceTests`' laid-out-D floor: 0.3/game is "one over three
games", which cannot distinguish a rate of zero from a rate of one.
