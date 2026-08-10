---
title: 'Locomotion deletes the pivot the moment `anchored` goes false, so every check hands the thrower a fresh grace budget'
severity: 'minor'
---

## Description

`Locomotion.stepPivot` opens with:

```ts
if (!p.anchored) { this.pivots.delete(p.id); return; }
```

The pivot state it deletes holds the grace budget — the metres of run a body is allowed
while arresting before the foot locks. Deleting it means the next frame with `anchored`
true calls `openGrace` again and gets a **new** budget.

The game layer set `anchored` only during `LIVE_POSSESSION`. A `CHECK` is not that phase,
so every check — after a call, after a timeout, after a turnover is collected — dropped
the pivot and refilled the budget. Measured while wiring timeouts: worst settled thrower
drift went from the pivot radius to **6.95 m**, entirely in the frames after checks, and
`tools/test-game.ts`'s drift assertions caught it only because a timeout made checks
common enough to matter.

Both halves are now anchored in the game layer (`LIVE_POSSESSION || TIMEOUT || CHECK`),
which is also the honest statement: a check is a disc in a hand on a chosen spot, the
most anchored moment in the sport.

## Why nothing caught it

Checks were rare and short — 1% of match time — so the refilled budget bought a metre or
two a few times a match, inside the noise of assertions written as percentiles over
twenty thousand frames.

## Suggestion

The budget should be a property of the possession, not of the `anchored` flag: keep the
pivot state and mark it suspended, the way `stepPivot` already does for an airborne body
(`s.locked = false` and keep the entry) rather than deleting it.
