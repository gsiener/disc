---
title: 'Registering a SimChecks suite means committing Harness.swift, which peers add lines to at the same time'
severity: 'minor'
issue: 'gsiener/disc#51'
---

## Description

Adding a check suite is two edits: a new file under `swift/Sources/SimChecks/`,
and one line in the `allSuites` array in `Harness.swift`. The new file is yours
alone; the one line is in a file every agent adding a suite touches.

AGENTS.md's staging rule says to commit with an explicit pathspec:

    git commit -- swift/Sources/SimChecks/Harness.swift

That does not help here, and quietly does the thing the rule exists to prevent.
A pathspec commit takes the **working-tree** state of that path — so it commits
the peer's uncommitted `Suite(name: "matchdiff", run: MatchDiffTests.run)` line
along with mine, referencing `MatchDiffTests.swift`, which is untracked. That is
a broken `main`: the exact failure AGENTS.md says has already happened twice.

The pathspec rule protects you from a peer's changes to *other files*. It gives
you nothing when you and a peer are both editing one line-oriented registry.

## Reproduction

Two agents each add a suite. Agent A commits first, with a pathspec:

    git commit -- swift/Sources/SimChecks/BoxScoreTests.swift \
                  swift/Sources/SimChecks/Harness.swift

The commit contains B's registration line and not B's suite file. Anyone who
checks that commit out cannot build.

## Workaround

Commit the file as HEAD-plus-your-line only, then put the shared working copy
back:

    cp swift/Sources/SimChecks/Harness.swift /tmp/harness.working
    git show HEAD:swift/Sources/SimChecks/Harness.swift > swift/Sources/SimChecks/Harness.swift
    # re-apply only your one line, then:
    git commit -- swift/Sources/SimChecks/Harness.swift swift/Sources/SimChecks/YourTests.swift
    cp /tmp/harness.working swift/Sources/SimChecks/Harness.swift

It works, and it is a two-second window in which a peer writing `Harness.swift`
would be clobbered. It should not be the documented answer.

## What would fix it

A registry that is not a hand-edited shared list: have `runChecks` discover
suites from a per-suite declaration in the suite's own file, so adding a suite is
a one-file change and the merge hazard disappears. Failing that, AGENTS.md should
name `Harness.swift` as the one file where the pathspec rule is not sufficient,
and give the recipe above.
