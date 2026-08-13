---
title: 'Harness.swift''s allSuites array is a shared-line merge hazard for every new SimChecks suite'
severity: 'minor'
issue: 'gsiener/disc#51'
---

Registering a new `SimChecks` suite is two edits: a new file under `swift/Sources/SimChecks/`, plus one line appended to the `allSuites` array in `Harness.swift`. The new file belongs to whoever wrote it; the one line in `Harness.swift` is a line every agent adding a suite has to touch, in a shared checkout where several agents work at once.

AGENTS.md's staging rule says to commit with an explicit pathspec (`git commit -- swift/Sources/SimChecks/Harness.swift`), but a pathspec commit takes the **working-tree** state of that path — so it silently pulls in a peer's uncommitted registration line along with your own, referencing a suite file that peer hasn't committed yet. That produces a broken `main`: a commit whose `Harness.swift` references a class that doesn't exist in that commit's tree. The pathspec rule protects against a peer's changes to *other* files; it gives no protection when two agents are both editing the same line-oriented registry.

## Reproduction

Two agents each add a suite. Agent A commits first with a pathspec that includes `Harness.swift`. If agent B's uncommitted registration line is present in the working tree at that moment, A's commit contains B's line pointing at B's still-untracked file. Anyone who checks out A's commit cannot build.

## Workaround in use today

Restore `Harness.swift` to `HEAD`, re-apply only your own line, commit, then restore the shared working copy — a two-second window in which a peer writing the same file would still be clobbered. This is documented as a manual recipe, not a structural fix.

## Suggested fix

A registry that isn't a hand-edited shared list — e.g. have suite discovery read a per-suite declaration from each suite's own file (a static property, a registration macro, or a generated index), so adding a suite becomes a one-file change and the merge hazard disappears by construction. Failing that, `Harness.swift` should be named explicitly in AGENTS.md as the one file where the pathspec-commit rule is insufficient, with the recipe above as the documented answer.

Source: `.agents/friction-log/20260809175052-registering-a-simchecks/friction.md`
