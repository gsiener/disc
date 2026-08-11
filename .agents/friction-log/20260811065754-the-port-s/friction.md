---
title: 'The port''s autoPull is not a port of Game.doPull — it aims 16.8 m short, and that is the pull-drop gap'
severity: 'major'
---

## Description

`Engine.autoPull` (`swift/Sources/UltimateSim/Play/EnginePoint.swift:224`) is not a port of
`Game.doPull` (`src/sim/Game.ts:2662`). It is an independently invented pull, and every
part of it differs:

| | reference `doPull` | port `autoPull` |
|---|---|---|
| who pulls | best `throwPower` on the line | `pullingTeam * playersPerSide`, fixed |
| release height | `releaseOrigin` (hip) | literal `1.25` |
| aimed at | `PULL_TARGET_Z = FIELD.GOAL_LINE + 4` = **36** | `field.goalLine * 0.6` = **19.2** |
| throw model | fitted pull ballistic — `PULL_SPEED 32`, `PULL_BANK -0.50`, `PULL_NOSE 0.02`, `PULL_SPIN 0.85`, launch 0.10 rad | generic backhand, `solvePower` bisection + `pullAngle` |
| sideways fade | `PULL_DRIFT = 8.4` constant | `probeThrow` wind correction, calm-day deadband at 2 m/s |

**None of `PULL_SPEED`, `PULL_CARRY`, `PULL_DRIFT`, `PULL_TARGET_Z`, `PULL_BANK`,
`PULL_NOSE` or `PULL_SPIN` exists anywhere in `swift/Sources/`.** `grep -rn "PULL_" swift/Sources/UltimateSim/`
returns the phase name and two comments.

`doPull`'s own header says in as many words what the port did: *"A PULL IS NOT A BACKHAND,
and treating it as one is why every pull in this game used to die at midfield — measured
mean carry 42.9 m, max 46.2 m, against a far goal line 64 m away."* The port solves a
backhand for a range and lands it in the middle of the receiving half, which is the state
the reference moved away from.

## What it costs — this is issue #2's `turnover:pull-drop`

Measured on `main` (`91c6bc3`), the reference over the eleven `MatchPool` seeds, 170 pulls:

| outcome | count |
|---|---|
| caught by the receiving team | 143 |
| **`pull-drop` (muffed by the receiving team)** | **15** |
| landed untouched | 7 |
| out of bounds | 5 |
| touched by the pulling team (WFDF 12.5) | 0 |

**The receiving team puts a hand on 158 of 170 pulls — 93%.** The 15 drops are 9.5% of the
pulls they touch.

Where those pulls come down, `|z|`, goal line at 32: the 15 drops run **22.3 to 34.7**, the
catches **26.3 to 35.5**. Not one of the 170 resolutions is inside 22 m.

The port aims every pull at **19.2** and `solvePower` bisects until it gets there. The port's
pull lands short of *every pull the reference throws*, in space, 12.8 m in front of a
receiving line that is standing on its own goal line. Nobody is within `catchReach` of it, so
`CatchDecision.decide` returns `nil`, the disc reaches `pullLanded`, and no turnover is
recorded. That is the 8-11x `turnover:pull-drop` gap in
`.agents/friction-log/20260811-matchdiff-pull-drop`, and it explains the part of that entry
which had no explanation: why issue #29's `Playbook` change moved the **reference** 16 → 23
and left the port at 2, even though the change was mirrored into `Playbook.swift` faithfully.
It moved the handler row for a disc deep in its own endzone — which the reference's pull
reaches and the port's never does.

## Why nothing caught it

- `matchdiff` is the only fixture that sees a whole match, and its `turnover:pull-drop` band
  was carried by the absolute floor, not the relative one — the standing 8-11x gap sat under
  it with 0.08 events a match of headroom.
- ADR-0007's constant scrape covers **`src/sim/AI.ts` only**. The pull constants are in
  `src/sim/Game.ts`, so "a reference constant the port does not carry under that name has to
  be classified in `unmirrored` with a reason" never applied to them.
- `EngineSeamTests` checks the pull against *properties* — that a pull happens, that it flies,
  that an out-of-bounds pull offers the choice, that the carry scales with the pitch — and
  says so in its header. A property suite cannot see "aimed 16.8 m short of the oracle".

## Suggestion

Port `doPull`. It is a bounded change — puller selection, release origin, the five fitted
constants and `PULL_TARGET_Z` — but it is a gameplay change that moves every per-seed band
downstream of the pull, so it needs the Swift suite, and it should carry its own fixture:
the pull is a rules event with no AI in it, so a `pull.json` golden of "these seeds, these
release vectors, these landing points" is cheap and would have caught this on day one.

Extend the ADR-0007 scrape past `AI.ts` to `Game.ts` at the same time. The pull constants
are exactly the shape rule 3 was written for.
