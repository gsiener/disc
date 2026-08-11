---
title: 'matchdiff has hidden an 8-11x engine gap on pull-drop under its absolute floor, with 0.08 events a match of headroom'
severity: 'major'
---

## Description

`MatchDiffTests.rateFloor = 1.35` exists so that "a kind that happens about once a match is
not held to a tolerance narrower than the noise on eleven samples". On `turnover:pull-drop`
it is not absorbing noise, it is absorbing a standing order-of-magnitude divergence.

Measured over four states of `src/sim/Playbook.ts`, same eleven matches, same seeds:

| state | reference | port | gap | band | verdict |
|---|---|---|---|---|---|
| `aa2a316` baseline | 1.45/match (16) | 0.18/match (2) | 1.27 | 1.35 | PASS by 0.08 |
| floor by role + cap at disc | 1.36/match (15) | 0.45/match (5) | 0.91 | 1.35 | PASS |
| floor by role + cap at disc+PIN_MARGIN | 1.73/match (19) | 0.18/match (2) | 1.55 | 1.35 | FAIL |
| floor by role + mirrored handler (shipped) | 2.09/match (23) | 0.18/match (2) | 1.91 | 1.57 | FAIL |

**The port sits at 2 pull-drops over eleven matches in three of the four states and never
exceeds 5. The reference sits at 15-23.** That is an 8-11x gap, and it is present at the
baseline, where the check is green. What the check is measuring at baseline is not agreement;
it is `1.27 < 1.35` — less than one extra pull-drop over the whole pool of headroom.

So an unrelated change that moves the *reference's* count by seven events out of twenty
turns it red without telling you anything about the port. That is what happened here: the
shipped change moved the reference from 16 to 23 (about 1.8 sigma on a Poisson mean of 16)
and the relative band, which is `0.75 * 2.09 = 1.57`, overtook the absolute floor.

`tools/test-game.ts`'s `and it changes hands at the sport's rate` is the same shape: the band
is `0.3 <= turnovers/point <= 2.5` and the baseline sits at 2.29 — 0.21 of headroom on a
six-to-thirteen point sample.

## Why nothing caught it

The band is honestly documented as "a tripwire for order-of-magnitude divergence ... not a
precision instrument", and the note that prints every run is
`matchdiff worst relative gap`, which reports the worst *relative* gap. `pull-drop` was never
the worst relative gap, because it was being carried by the *absolute* floor — so the one
number designed to make drift visible before it goes red is blind to exactly the kind that
was drifting. `MatchDiffTests.swift:67-71` lists the measured gaps at landing and `pull-drop`
is in that list at 0.54/match, so it has roughly tripled since, silently.

## Suggestion

Two things, and the second is the one that generalises.

1. `turnover:pull-drop` deserves its own look before the next agent trips it. Eleven matches
   produce 2 in the port and 16-23 in the reference; that is either a real difference in how
   the pull is contested or a roster artefact, and it is currently asserted by nothing.
2. **Print the headroom, not only the worst relative gap.** A pair passing on 0.08/match is
   indistinguishable in the output from one passing on 1.20/match, and only the first is a
   trap. The note wants to be "closest to its band: `turnover:pull-drop` at 94% of what it is
   allowed" — which is a number that would have been shouting for several commits.
