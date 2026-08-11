---
title: 'A sweep for low-value tests found the anti-pattern already absent, and every Check.ok(true, ...) that looks like a placeholder isn''t one'
severity: 'minor'
---

## Description

Tasked with a repo-wide sweep for tautological, duplicative, or no-op tests in
`SimChecks`, `tools/test-*.ts`, and `ios/UltimateUITests` (excluding
`EngineTests.swift`/`Harness.swift`, fenced for a peer). The specific pattern named as
the target — `Check.ok(true, ...)`, an assertion that always passes — turned up nine
times outside the fenced files. All nine were read in full context. None was a genuine
placeholder.

Three shapes account for all of them, and all three are legitimate:

1. **The pass branch of a do/catch where the failure mode is "should have thrown, didn't"**
   (`ClockTests.swift:344`, `MatchSaveTests.swift` ×5). The `try` path calls
   `Check.ok(false, ...)`; the `catch` path calls `Check.ok(true, ...)`. Removing the
   `catch` arm's call would silently drop assertion coverage for whether the throw
   happened at all — the two arms are one boolean, split across control flow rather than
   written as `Check.ok(error != nil, ...)` only because Swift's `do/catch` doesn't hand
   you a boolean.
2. **A switch-case standing in for equality on a non-`Equatable` value**
   (`RulesTests.swift:222`, `boundaryCrossing case i is nil`). `case (nil, nil):` is one
   arm of an exhaustive four-way match; the other three arms fail. It is `Check.eq(got,
   want)` written as a switch because `Optional<CrossingResult>` has no `==`.
3. **A private `record(ok: Bool, ...)` helper that reports both outcomes of a real,
   already-computed comparison** (`TeamAITests.swift:241`). `ok` comes from `approx`/`exact`
   evaluating a golden comparison; the `if ok { Check.ok(true, "") }` branch is not
   evaluated unconditionally, it's the pass report of a real per-value diff. Functionally
   identical to `Check.ok(ok, ok ? "" : label())`.

`MatchDiffTests.swift:187` was the one borderline case: the final `else` of a four-way
cascade over `(want, got)` reachability, reached only when both are already known to be
zero — at that point the call genuinely cannot fail. Left it alone rather than touch
`Check.note` call sites, since `Check.note` in this file is the pattern a peer agent is
already removing elsewhere (issue #7/#20) and duplicating that decision here without
coordinating felt like the wrong call more than the assertion itself was.

Also swept the rest of the differential-golden files (Rng, SimMath, Coeffs, TryCatch,
Divergence, BoxScore, Calls, Throws, Bench, MatchPool), all four iOS UI test files, and
grepped every remaining SimChecks file plus all ten `tools/test-*.ts` files for
tautology/duplicate/vacuous-assertion indicators (self-comparison, literal-true
conditions, copy-pasted assertion lines, "trivial"/"vacuous"/"no-op" comment markers).
Found nothing to remove. The `vacuous`/`no-op` grep hits that did turn up
(`CatchBandTests.swift:267`, `DivergenceTests.swift:193`, `ReplayTests.swift:243`, etc.)
were all comments where the test's own author had already reasoned about exactly this
risk and guarded against it.

## Why this is worth writing down

The task brief predicted small yield and named this file/line as the example to go
find more of. The instinct "the brief named an example, so the codebase must have more
of it" is exactly backwards here: the fact that someone already went looking hard
enough to write that description down, and the description doesn't quite match what's
on disk anymore, is itself evidence of how many passes this particular worry has
already been through. The friction log's own entries
(`20260810-three-suites-played`, `20260809222131-enginetests-deep-game`,
`20260810-per-seed-bands-again`) show this codebase has a working feedback loop for
exactly this class of problem — duplicate simulation, tautological bands — and has
already converged. A future sweep here should budget for "confirm it's still clean"
rather than "find the next batch," and should read the literal current text of a
`Check.ok(true, ...)` call before assuming the label matches the shape.

## Artifacts

None — no code changed. This entry is the artifact.
