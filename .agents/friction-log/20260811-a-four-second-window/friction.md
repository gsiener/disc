---
title: 'HumanCutTests scored "had further to run" as "never went", so its arrival count was a bound on how far the probe pointed'
severity: 'minor'
---

## Description

`HumanCutTests.theCommandedReceiverRunsIt` measures the ordered body's closest approach
to its target over a fixed **four-second** window and scores anything past 2.3 m as not
arrived. `probe` points 24 m out along the heading of the furthest downfield team-mate,
so the route length is whatever the shape happened to offer — between 3.3 m and 28.7 m
across a 32-seed sweep. A body sent 28.7 m cannot cover it in four seconds including the
setup step and the plant, so it scores as a failure of the command path.

That is what the `worst 10.30 m against the 1.3 m the AI's own arrival test uses` in
`.agents/friction-log/20260811-the-same-two-per-seed-checks` actually was. Measured over
32 seeds, every seed that missed the bar:

| commit | seed | sent | closest | closed | possession ended early? |
|---|---|---|---|---|---|
| fb085ad | 13 | 28.73 m | 10.30 m | 18.43 m | no |
| fb085ad | 19 | 28.52 m | 8.11 m | 20.41 m | no |
| fb085ad | 109 | 21.34 m | 5.16 m | 16.18 m | no |
| d25c992 | 41 | 15.97 m | 9.61 m | 6.36 m | no |
| d25c992 | 59 | 18.45 m | 13.29 m | 5.16 m | no |
| d25c992 | 103 | 18.39 m | 8.55 m | 9.84 m | no |
| d25c992 | 113 | 26.66 m | 5.94 m | 20.72 m | no |

Every one of them ran the full window with the possession still ours, and every one of
them closed at least 5.16 m. None is a body sent to the wrong place. The check's own
comment says a route abandoned by a stoppage "is not a route that failed" and breaks the
loop when the possession ends — but it then scores that seed as a miss anyway, so the two
cases were indistinguishable in the result until this sweep separated them.

## Why it looked like a regression

Because the miss count is a tail statistic of a quantity nobody was asserting: how long a
route the shape offered. `d25c992` and `fb085ad` run **byte-identical** command-path code
— the pull port touches only `EnginePoint.swift` — and produced 21 of 25 arrivals against
27 of 30. The branch is the *better* of the two, and its alarming 10.30 m worst approach
is a smaller tail than the parent's own 13.29 m.

This is the third time a per-seed count on this pair has been read as a regression from
the failure text alone. Two of those readings were wrong.

## Suggestion

**Measure the pooled rate at the parent commit as well as at yours before you touch a
bound.** It costs one detached worktree and one suite run, and it is the only thing that
distinguishes resampling from a defect — which is the discipline `28e61f5` used to
*confirm* the windy-completion defect rather than bury it. AGENTS.md already says pooling
is a way to find out whether a failure is noise, not a way to make one pass; the missing
half is that the finding needs a baseline to be a finding at all.

For a check like this one, the durable form is a pair: a **rate** over a denominator a
single re-roll cannot move, and an **exact per-seed floor on the thing the rate cannot
say**. Here that is "every ordered body either arrived or closed at least 3 m", which is
0 m for a route nobody ran and 5.16 m at the worst measured across both commits — so it
fails on the defect the arrival count was written to catch, on the first seed, without
depending on how far the probe happened to point.
