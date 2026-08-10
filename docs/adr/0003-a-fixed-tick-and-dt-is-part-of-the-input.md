# ADR-0003 — A fixed 1/120 s tick, and the `dt` sequence is part of the input

- **Status:** Accepted
- **Date:** recorded 2026-08-10, decided earlier (see `swift/Sources/UltimateSim/Play/Replay.swift:19-56`)

## Context

`Engine.step(dt:)` advances the whole simulation: disc physics, locomotion, the AI, and the
rules machine. It is **not associative in `dt`** — `step(2h)` is not `step(h); step(h)`.

That is not a bug to be fixed. It falls out of the model:

- `Locomotion` clamps `dt > 1/30` (`Locomotion.swift:491-493`).
- `DiscRuntime.predictPath` clamps differently, at `1/20` (`DiscRuntime.swift:517`).
- The rules machine, the stall accumulator and the disc integrate the *unclamped* `dt`.

So `step(0.5)` is not a coarse tick. It is a tick in which the bodies advanced 33 ms while
the stall count advanced 500 ms. Nothing notices, and the drift lands between
`GameState.clock` and where the players actually are.

## Decision

The simulation runs at a **fixed 1/120 s tick**, everywhere, including the shipped app.

A replay is reproducible only if the *sequence* of `dt`s is reproduced — so the `dt`
sequence is treated as **part of the input**, alongside the field, the seed and the player
inputs. `Recording` stores the tick sequence for this reason.

`FixedClock` (`Replay.swift:295-330`) is the adapter that enforces this.

## Consequences

**What it bought.** Replays are exact. The entire 2.25 M-assertion suite runs in one `dt`
regime, so a golden recorded once stays valid. Frame-rate variation on a phone cannot change
the outcome of a match.

**What it costs.** The display does not tick at 120 Hz, so something must accumulate frame
time into fixed steps. Today that something is `MatchView.advance(to:)` — a private method
of a SwiftUI `View`, which is the one module deciding the shipped `dt` sequence and the one
module the suite cannot reach. See issue #16. That is a *placement* problem, not a challenge
to this ADR.

**What the interface does not carry.** `Engine.step`'s doc comment says only that `dt` "is
expected to be `1/120`; anything else works." The non-associativity, the two different
clamps, and the consequence of exceeding them are documented forty lines away in a file a
caller has no reason to open. `FixedClock` carries the invariant and is *optional* —
`MatchView` and `SimChecks` both call `step(dt:)` directly.

## Not up for reconsideration

Variable-timestep proposals ("just use the frame delta", "scale `dt` for slow-mo") should be
declined. Slow-motion is implemented by choosing how many fixed ticks to run, never by
changing `dt`.

Related: issue #16.
