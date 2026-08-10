---
title: 'Every shape and value constant in the AI port is a metre count measured on 100 x 37 m, and the minis pitch inherits all of them silently'
severity: 'major'
---

## Description

`GameFormat` threads the pitch, so `GameState`, `Rules` and `Playbook.clampToField` are all
honestly parameterised. What is *not* parameterised is every number the AI decides with,
because `Playbook.ts` and `AI.ts` had one field and therefore no reason to distinguish
"eleven metres" from "a fifth of the way to the goal line". Ported literally, each of those
is a bug on the 37 x 18 m minis pitch, and none of them is visible at sevens:

- `formationStations` — the vertical stack spans `stackLead + 4 * stackSpacing` = **27.8 m**
  downfield. The minis end line is at 18.5, so all five stations clamped into the back of
  the endzone and stood on each other. The horizontal cutter row (15 m downfield, ±13.5 m
  wide) clamped into the same corner from the other direction; the side stack's column at
  ±12.5 m is 3.5 m outside a 9 m sideline.
- `buildCut` — the under resolves 5.5-9.5 m in front of the disc and the deep cut reaches
  24-38 m, on a pitch 12.5 m from centre to goal line.
- `laneOf` — the under/deep boundary is 16 m, further than the disc is from the back of the
  endzone, so **two of the six lanes were unreachable** and `liveLanes` collided cuts that
  were nowhere near each other.
- `laneClearOfLiveTargets` — 6 m between two live cut targets is a third of the minis
  width, so two cuts to opposite sidelines read as the same cut. Measured: 1,836 candidate
  routes discarded in one match against a target nowhere near them.
- `scoreCut` — an 8 m crowding radius counts most of the other team as standing on the
  target (mean crowd 1.06 at minis against 0.72 at sevens, with eight fewer bodies on the
  pitch); the deep penalty's `smoothstep(30, 12, yardsToGoal)` is saturated over the whole
  attacking half of a pitch whose goal line is at 12.5.
- `possessionValue` — the **64 and the 18 are the regulation goal-to-goal length and endzone
  depth**, so the entire minis pitch fits inside the flat top of the value curve. A
  completion gaining a quarter of the field was worth +0.036 while the turnover it risked
  still cost a full-size 0.46. A rational thrower holds; measured, the count reached 8 or 9
  on two thirds of releases and 56-89% of every turnover in a minis match was a stall-out.

## Why nothing caught it

Every telemetry band in the repository is a sevens band. `EngineTests.playAndMeasure` ran on
both formats — which is what found the first two of these — but the minis arm asserted
nothing: it printed a `Check.note` saying "minis is still a backward game". That note was
true when written, stopped being true silently, and was still being printed while the numbers
behind it had changed twice. A note cannot fail.

## Suggestion

The pattern that works is a scale expressed as a **ratio of two field numbers**, so it is
exactly `1.0` on the regulation pitch and every product is bit-identical there — which is
what keeps the goldens still. `Playbook.depthScale` / `widthScale` are that, and
`possessionValue(_:central:endzone:)` takes the pitch's own two lengths with the regulation
pair as defaults.

The real suggestion is smaller and more useful: **grep the AI for bare metre literals before
adding a second pitch, not after.** There were about forty, they took an afternoon to find
one measurement at a time, and the fast way to find the next one is that any absolute
distance which is not a stride, a reach or an arm's range is a fraction of a pitch wearing
a metre's clothes.
