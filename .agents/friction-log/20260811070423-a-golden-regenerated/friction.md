---
title: 'A golden regenerated at the commit that wrote it does not reproduce on another machine — and matchdiff turns 1 ULP into 35% of its counts'
severity: 'major'
---

## Description

A golden regenerated at **the very commit whose diff wrote it** does not reproduce on a
different machine. Measured here on Linux x86_64, Node v22.22.2:

**`coeffs.json` at `41a48d8`** — 4 of 2297 numbers differ, worst relative error
`3.4e-16`. One or two ULP, in `sweep[43].drag` and three neighbours. That is a V8 math
difference, not a source change; nothing in `tools/goldens/coeffs.ts` or `src/sim/aero/`
moved between the commit and the regeneration, because the regeneration *is* at that commit.

**`matchdiff.json` at `ded9173`** — **every count in the file differs**, because eleven
fifteen-minute matches are 108,000 chaotic ticks apiece and one ULP anywhere is enough:

| | committed at `ded9173` | regenerated here at `ded9173` |
|---|---|---|
| `drop` | 49 | 43 |
| `block` | 44 | 36 |
| `interception` | 76 | 68 |
| **`pull-drop`** | **23** | **15** |
| `strip` | 7 | 10 |
| `contested` | 7 | 12 |
| `attempts` | 1630 | 1599 |
| `points` | 176 | 170 |

The engine is perfectly deterministic *within* a machine — HEAD (`91c6bc3`) and `ded9173`
regenerate byte-identically here, which incidentally says the catch-band work in
`ee29260`/`e0ce282` moves `matchdiff` by nothing at all.

## Why this is a trap and not a curiosity

`matchdiff.json` is compared against the **Swift port**, which never re-runs the reference.
So a fixture regenerated on machine B and committed is, from the suite's point of view,
indistinguishable from a genuine behaviour change — and it silently rebases every band in
`MatchDiffTests` onto machine B's dice.

Concretely, today: `main` is red on
`turnover:pull-drop happens at the reference's rate — ref 2.09/match, port 0.18/match,
allowed ±1.57`. **Regenerating `matchdiff` on this machine turns that assertion green**, at
ref 15 vs port 2: `allowed = max(1.35, 0.75 × 1.36) = 1.35`, `gap = 1.18`. Nothing about
the port changed. Nothing about the reference's *code* changed. The check would go green
because a different libm muffed eight fewer pulls.

That is band-widening wearing a fixture's clothes, and it is the move
`PlaybookTests.swift:1163-1176` exists to warn about. It is also exactly option 2 —
"re-measure the pool" — in issue #2's list of ways out, so the option needs striking off
for anyone not on the machine that produced the committed file.

It cuts the other way too: `20260811-matchdiff-golden-is-stale` diagnosed `matchdiff` as
stale since `c2460aa` because a regeneration "still moves it by fifteen counts" after
reverting the change under test. On this evidence that observation is at least partly the
same machine effect, and the entry's proposed `git log <golden>` vs `git log <inputs>`
staleness check would report `matchdiff` stale here while it is in fact byte-current.

## Suggestion

The counts are not the problem — the *claim* that they are reproducible is. Three options,
cheapest first:

1. **Say so in the fixture.** `matchdiff.json`'s spec should carry the Node version and
   platform that generated it, and `MatchDiffTests` should note them. An agent seeing
   "generated on darwin/arm64 node v24.x" before regenerating on linux/x64 stops.
2. **Make regeneration of this one fixture a named job on one machine**, the way the
   goldens' own header implies ("generated, committed, and read-only to the Swift side") but
   nothing enforces.
3. **Stop asserting raw counts on a chaotic fixture.** A count that moves by 35% under a
   1-ULP perturbation is not a number the suite can hold to ±0.75 relative; the parity check
   and the two dimensionless ratios survive this and the per-kind rate band does not.

Costed about ninety minutes: two full pool regenerations (~15 min each) plus a detached
worktree at `41a48d8` to establish that the drift was environmental and not a source change.
