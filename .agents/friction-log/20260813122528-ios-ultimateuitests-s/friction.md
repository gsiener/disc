---
title: 'ios/UltimateUITests''s app.launch() quiescence measurement is a worktree-only exercise since Ultimate.xcodeproj is gitignored'
severity: 'minor'
---

## Description

Measuring `app.launch()` wall time before/after a change (issue #16 Phase 4)
required checking out both commits into isolated `git worktree`s so a
`swift build`-style verify recipe could compare them. Neither worktree
contained `ios/Ultimate.xcodeproj` — it is generated from `ios/project.yml`
by `xcodegen` and gitignored (`ios/*.xcodeproj/` per `.gitignore`'s comment
"Generated from ios/project.yml by xcodegen — the YAML is the reviewable
source"), so `xcodebuild -project Ultimate.xcodeproj -list` in a fresh
worktree fails with "does not contain an Xcode project, workspace or
package." `xcodegen generate` in the worktree's `ios/` fixes it in about a
second, but nothing in AGENTS.md/BRIEF.md/project.yml's comments says a
worktree needs this extra step before `xcodebuild` will run — the existing
worktree recipe (`git worktree add --detach "$W" HEAD && cd swift && swift
build`) never touches `ios/` at all.

## Impact

Cost about 5 minutes of confused debugging (the error message reads like a
bad path, not a missing generated project) before checking `.gitignore` and
finding `xcodegen` already on PATH. Anyone doing a before/after `xcodebuild`
comparison across commits — which Phase 4's own acceptance gate calls for —
will hit this once per worktree.

## Fix / workaround

Before any `xcodebuild` command in a fresh worktree's `ios/`, run:

    cd "$WORKTREE/ios" && xcodegen generate

Second finding, more important: the actual before/after `app.launch()`
measurement (`testBareLaunchShowsPreGameSheet`, alternated across three
warm-simulator trials per side, isolated worktrees for `88a1821` vs
Phase 4's `f242a19`) did NOT show the expected improvement — BEFORE's
launch→idle delta was ~1.9–3.0s (median ~2.1s) and AFTER's was ~3.3–3.6s
(median ~3.58s), i.e. Phase 4 measured *slower* on this specific quick
test, not faster. Neither number is anywhere near the "tens of seconds"
hang the issue describes, which suggests this fast smoke test (assert the
pre-game sheet, tear down) never sits at the paused screen long enough to
exercise the bug either before or after the fix — a single quick launch
isn't the right instrument for a quiescence-over-time defect. A test that
sits at the paused/result-card screen for real wall-clock seconds (not just
until the first assertion passes) is needed to see the payoff; recording
this now so Phase 5 doesn't reach for `testBareLaunchShowsPreGameSheet` as
"the" before/after test and declare victory on a number that doesn't
demonstrate what it's being cited for.
