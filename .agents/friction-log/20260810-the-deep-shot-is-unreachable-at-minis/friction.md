---
title: 'isDeepShot is arithmetically unreachable at minis — 0 of 332 live releases — so the whole huck model is dead code on the default pitch'
severity: 'major'
---

## Description

`TeamAIThrow.evaluateOptions` enters a completely separate valuation for a deep shot:

```swift
let isDeepShot = gain >= 22 && d >= 25 && !isReset
```

Everything behind that branch — the jump-ball completion model, the `pStay`
out-of-bounds tax, the 0.24 pin credit, the halved turnover charge — exists because the
multiplicative chain above it "cannot see a huck" and prices a 30 m shot near 0.2. The
comment above the branch says as much, at length.

**The 22 and the 25 are absolute metres measured on a 32 m goal line.** On the minis
pitch the goal line is at 12.5 m and the end line at 18.5, so a throw that gains 22 m
downfield and travels 25 m has to span most of the 37 m pitch corner to corner. Measured
over five minis seeds and 332 live releases (autoTeams = [0, 1], fifteen simulated
minutes each):

| format | seeds | live releases | `isDeepShot` fired | longest aim |
|---|---|---|---|---|
| minis  | 11, 3, 7, 23, 37 | 332 | **0** | 18.5 m (1.47 goal lines) |
| sevens | 11, 3, 7, 23, 37 | 576 | 33 (4–12 a match) | 45.4 m (1.32 goal lines) |

It is not rare on the small pitch, it is unreachable. Read as a fraction of the pitch the
same test fires 40 times over three minis matches — the offence throws plenty of deep
shots, they are simply never *valued* as deep shots, so every one of them is priced by
the chain the branch exists to bypass.

This is issue #17's two literals in `TeamAIThrow`, with a number against them. It is the
last of the `20260810-every-shape-constant` family that had not been found: that entry
lists `formationStations`, `buildCut`, `laneOf`, `laneClearOfLiveTargets`, `scoreCut` and
`possessionValue`, all now scaled, and stops short of the throw decision.

## Why nothing caught it

Two reasons, and the second is the reusable one.

1. `isDeepShot` is a local in an internal function. `ThrowOption` is internal too, so
   `SimChecks` cannot see the decision at all — the branch can only be observed from
   outside by reconstructing the predicate from `Engine.lastThrowAim` against the
   thrower's position on the previous tick, which is what `EngineTests.playAndMeasure`
   now does.
2. Every minis number in the suite was in-bounds or a `Check.note`. `EngineTests`
   asserts `hucks >= 2 * matches` — but only on the sevens pool, and `hucksAttempted`
   counts a **flight of 28 m or more**, which is a different thing from the branch: a
   flight is a consequence, the branch is a decision. Nothing anywhere asserted that the
   deep valuation was entered, at either format.

## Suggestion

Scale the two literals the way `Playbook.depthScale` scales everything else — they are a
fraction of a pitch wearing a metre's clothes, which is the exact tell
`20260810-every-shape-constant` ends on. `22 / 32` and `25 / 32` of the goal line are
1.0 at regulation, so every sevens number and every golden is untouched.

The check is already in place either way: `minisIsPlayable` asserts the pitch-relative
reading of the test fires at least twice a match (measured 40 over three), and
`theDeepGameAndTheHoldShare` asserts the absolute reading fires at sevens (measured 17
over three) *and* that at sevens the two readings are the identical test. When the
literals are scaled, the absolute minis count stops being zero and can be asserted
directly at the same floor.

The general form, for the next one: **grep the AI for a bare metre literal in a
comparison, not just in a coordinate.** The station offsets were found because bodies
visibly stood on each other. A threshold that is never crossed looks like nothing at all.
