---
title: 'The same two per-seed human-input checks flipped again, one day after they were re-stated for exactly this reason'
severity: 'minor'
---

## Description

Porting `Game.doPull` into `Engine.autoPull` (issue #2) changes the opening throw of every
match, so every per-seed statistic downstream of it resamples. Two assertions went red,
and they are **the same two** `.agents/friction-log/20260810-per-seed-bands-again` had to
re-state a day earlier for an unrelated change:

| suite | assertion | before | after |
|---|---|---|---|
| `HumanDefenceTests` | `considered >= 2` — the bid is weighed by the catch decision on a real number of seeds | 2 of 3 commitments | **1 of 8 commitments** |
| `HumanCutTests` | `ran >= reached - 1` — every ordered body but at most one arrived | 7 of 8 | **6 of 8, worst approach 10.30 m** |

Both were `>= 3` and `== 8` before 2026-08-10, when giving the opposing AI its timeouts
(issue #20) moved them to `>= 2` and `>= reached - 1` with nothing in either feature's
path touched. That is two unrelated gameplay changes in two days, each moving these two
checks by one seed, and each time the diagnosis has been re-derived from the failure text.

## Why they keep moving

Both count a **coincidence of two conditions on one match**, and the denominator is
"seeds on which the scenario occurred at all":

- `HumanDefenceTests` needs a defensive flight *and* a committed body close enough for
  `CatchDecision` to weigh the bid. Only 3 of 8 seeds ever reached a commitment; the
  count that has to be `>= 2` is drawn from those 3.
- `HumanCutTests` needs a possession of ours with a real downfield space in it, and the
  ordered body has to arrive before the possession ends. A stoppage that ends the
  possession scores the seed as "did not arrive" — which is what a 10.30 m closest
  approach means: the route was abandoned, not refused.

So each is a Bernoulli count over three to eight samples, asserted with a bound taken
from one observation of the RNG stream. `20260809222131-enginetests-deep-game` said this
about tail statistics — "only tighter in the sense that a coin is tighter than a die" —
and both entries recommended pooling. Neither of these two was pooled; the bound was
loosened by one instead, which buys exactly one more unrelated change.

## Suggestion

**Do not loosen either one again.** A third `- 1` would make both vacuous. The two honest
options, and they differ per check:

1. `HumanCutTests` is pooled in the right shape already — it just has too few samples.
   Its seed list is eight literals; sixteen or thirty-two would make `ran / reached` a
   fraction with a real denominator, and the bound could then be a rate ("at least 70% of
   ordered bodies arrive") that a one-seed re-roll cannot reach. The check plays a match
   per seed, so this costs simulation time and nothing else.
2. `HumanDefenceTests` is measuring the wrong thing. What the feature claims is *"a tap
   that reaches `actionOf` is a tap the catch contest sees"* — which is a property of a
   single evaluation and needs a constructed flight with a committed body, not eight full
   matches hoping the coincidence lands. As written, the assertion's denominator is the
   coincidence rate and its numerator is the feature; only one of those is under test.

Both are per-seed bands on a rare coincidence, which is the failure this log has now
recorded four times. The general fix is `20260810-per-seed-bands-again`'s: *a bound whose
value came from a measurement of one seed is a bound on that seed; either pool it or set
it where a re-roll cannot reach it.*
