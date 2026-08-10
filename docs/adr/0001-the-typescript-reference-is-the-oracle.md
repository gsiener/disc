# ADR-0001 — The TypeScript reference is the oracle, and it evolves first

- **Status:** Accepted
- **Date:** recorded 2026-08-10, decided much earlier (see `AGENTS.md`, `BRIEF.md`)

## Context

This repository holds two implementations of one simulation: `src/sim/*.ts`, which came
first and shipped as a Three.js web build, and `swift/Sources/UltimateSim/`, which is the
one that ships in the iOS game.

Two implementations of the same physics and rules will diverge. The question was not
whether to prevent divergence — it was which one gets to be right when they disagree, and
how that is settled.

## Decision

**The TypeScript reference is the oracle.** It is executable, so agreement with it is a
matter of running it rather than of reading it.

The order of work is fixed and one-directional:

1. A gameplay or model change lands in `src/sim/`.
2. It is mirrored in Swift.
3. `tools/gen-goldens.ts` regenerates the JSON fixtures.
4. `SimChecks` replays them.

Never the reverse. Never by editing Swift alone to make a check pass. Never by hand-editing
a golden JSON.

## Consequences

**What it bought.** 2.25 M assertions that are meaningful rather than tautological. The
Swift port is trusted because the reference is *runnable*, not because the port looks right.
Mutation testing works: a Swift-only change that nothing catches is a real gap in the
fixtures, and has twice been exactly that.

**What it costs, and this is not small.** A change that is *correct* but that the reference
does not make requires Swift to deliberately disagree with the oracle — which means a
permanent documented divergence plus a golden regeneration. The port's cheapest path is
therefore always to match the reference, even where the reference is wrong.

That cost produced a visible pathology: `AIMath.LAYOUT_CEILING` was added with a twelve-line
proof that the reference's `1.85` is unreachable, and then **never called**, because calling
it would mean diverging. [ADR-0007](0007-when-correct-and-matching-the-oracle-disagree.md)
settles that tension — divergence is allowed and must be declared in a registry the
differential suite enforces — and `LAYOUT_CEILING` is its first entry and is now called.

**What is unenforced.** Steps 1–3 are enforced by prose in `AGENTS.md` and by nothing
executable. CI runs no TypeScript at all. See issue #15 — this is a gap in the *enforcement*
of this ADR, not a reason to revisit it.

## Not up for reconsideration

Proposals that amount to "let Swift lead and backport" or "drop the TypeScript side" should
be declined unless they come with an answer for what replaces the oracle. Deleting the
reference deletes the reason the port is trusted.

Related: [ADR-0002](0002-simchecks-is-a-library.md), [ADR-0007](0007-when-correct-and-matching-the-oracle-disagree.md).
