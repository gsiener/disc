---
title: 'A HEAD-only generator for Harness.swift''s allSuites still leaks the merge hazard through suite removals'
severity: 'minor'
---

## Description

Investigated the structural fix suggested by issue #51 for `swift/Sources/SimChecks/Harness.swift`'s hand-maintained `allSuites` array (a merge hazard under pathspec-commit semantics — see that issue and `.agents/friction-log/20260809175052-registering-a-simchecks/friction.md`).

The naive generator design (scan `swift/Sources/SimChecks/*.swift` on disk for a per-suite declaration, regenerate `Harness.swift`, checked in like a golden) clearly just relocates the hazard: it can still read a peer's uncommitted suite file off the working-tree disk and bake a reference to it into the regenerated file.

A less obvious variant: have the generator read only from **committed HEAD state** (`git show HEAD:path` / `git ls-tree HEAD`), never the working tree. Under that design, registering a new suite becomes two sequential commits — (1) commit the new suite file alone, inert since nothing references it yet, (2) regenerate off the now-updated HEAD and commit the regenerated `Harness.swift`. Since the generator never touches the working tree, a peer's uncommitted file structurally cannot leak in. This does eliminate the hazard for **additions**.

It does not eliminate it for **removals**. To delete or rename a suite you must commit the file's deletion first — and at that instant HEAD's `Harness.swift` still references a type absent from HEAD's tree, which is exactly the broken-`main` state the whole exercise was trying to make impossible, just reached from the other direction instead of via a peer's uncommitted addition. The generator can't be run before the deletion is committed (it refuses to read the working tree by design), so removals fall back to the same manual recipe as before.

Confirmed via an opus advisor consulted specifically on this tradeoff, who independently derived the same gap.

Went with the documentation fallback instead (AGENTS.md rule 4, added in this session) — naming `Harness.swift` explicitly with the restore-to-HEAD recipe. Worth recording so a future agent tempted to build the HEAD-only generator doesn't have to re-derive the removal gap from scratch; if suite count grows much further or a real `main` break happens from this file, this reasoning is the starting point for reopening the structural option.
