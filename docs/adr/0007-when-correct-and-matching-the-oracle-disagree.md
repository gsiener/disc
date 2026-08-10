# ADR-0007 — When "correct" and "matches the oracle" disagree

- **Status:** **Proposed — needs a decision.** This ADR records a tension, not a resolution.
- **Date:** 2026-08-10

## Context

[ADR-0001](0001-the-typescript-reference-is-the-oracle.md) makes the TypeScript reference the
oracle: Swift mirrors it, and disagreement is settled by running the reference. That is what
makes 2.25 M assertions meaningful.

It also means the port has **no cheap way to be right when the reference is wrong.** Making
Swift correct requires:

1. a deliberate, permanent divergence from the oracle,
2. a golden regeneration,
3. and a note at the site explaining a mismatch that will otherwise read as a porting bug
   forever.

Matching the reference costs nothing. So the incentive is always to match.

## The evidence that this is a real pathology, not a hypothetical

`AIMath.swift:96` declares:

```swift
LAYOUT_CEILING = 1.10
```

with a twelve-line doc comment **proving** that the `1.85` the bid guards use is unreachable,
because `land.y` is clamped to `CATCH_CEILING = 1.45`.

`LAYOUT_CEILING` has **zero references outside its declaration.** The three real sites still
say `1.85` (`TeamAIDefence.swift:576,579`) and `1.9` (`TeamAIThrow.swift:614`), because
`src/sim/AI.ts:3228` says `1.85`.

Someone did the analysis, wrote down the correct number, and did not wire it up. That is not
carelessness — it is the incentive working exactly as designed.

The same shape recurs:

- `EngineHuman.swift:437` uses a horizontal contest radius as a height band, under a comment
  naming `CatchDecision` as its authority (issue #4).
- `PlayerAction.bid(extend:)` is computed per player and discarded at `Engine.swift:878`
  (issue #22) — the capability exists, is plumbed, and is unreachable.
- Issue #5: six ported, validated capabilities with no production caller.

Expect this family to keep recurring for as long as "correct" and "matches the oracle" are
different answers with no recorded way to choose between them.

## Options

**A — The oracle is always right; correctness waits.** Divergence is never allowed. A wrong
reference is fixed in `src/sim/` first, always, even for a Swift-only concern. Simplest rule,
strongest guarantee, and it means the shipped game stays wrong until someone edits a frozen
codebase.

**B — Divergence is allowed, and it must be declared.** A `Divergences.swift` (or a section
in `AGENTS.md`) lists every deliberate mismatch: the constant, both values, the reason, the
date. The differential suite reads that list and *asserts the mismatch is still exactly the
one declared* — so an undeclared divergence fails, and a declared one cannot silently grow.
More machinery; makes the cost visible instead of prohibitive.

**C — Unfreeze the reference for correctness fixes only.** The reference stops being frozen
for bugs, stays frozen for features. Keeps one implementation of the truth; costs a golden
regeneration per fix and reopens a codebase that was deliberately closed.

## Recommendation

**B.** It is the only option under which `LAYOUT_CEILING` gets wired up this month, and the
assertion-on-the-declared-list is what stops "divergence allowed" from decaying into "the two
engines drift". A is honest but leaves known-wrong numbers shipping. C gives up the property
that made freezing valuable.

## Decision

*Not yet made. Do not implement any of the above until this is decided —* an undeclared
divergence landed today is indistinguishable from a porting bug found next month.

Related: [ADR-0001](0001-the-typescript-reference-is-the-oracle.md), issues #3, #4, #5, #22.
