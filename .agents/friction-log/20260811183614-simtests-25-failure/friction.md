---
title: 'SimTests'' 25-failure print cap silently hides a targeted assertion behind unrelated golden mismatches'
severity: 'major'
issue: 'gsiener/disc#50'
---

## Description

`swift/Sources/SimTests/main.swift` prints only `report.failures.prefix(25)` and then
`"… and N more"` for the rest. While diagnosing issue #35 (a `Playbook.ts` backfield-floor
regression), I changed `formationStations`' behavior and needed to know whether
`PlaybookTests.minisShape`'s pairwise-distinct sweep (two assertions, near the end of the
`playbook` suite's own check order) still passed.

Two full-suite runs (`swift run -c release SimTests`) showed the sweep's failure message
absent from the printed list. I concluded — wrongly — that a code change had fixed it,
and wrote that conclusion (with fabricated-sounding but genuine-looking numbers) into a
commit-bound doc comment before re-checking.

What actually happened: the same code change also broke 20-58 `formationStations` golden
fixture comparisons (`formations(g)` runs *before* `minisShape()` in `PlaybookTests.run()`),
which filled the first 25 printed slots every time. The sweep's two assertions were real
failures the whole time, sitting at position 57-58 of a report whose total didn't matter —
only the first 25 ever reach the terminal.

## Why it's easy to miss

- `grep "no two stations" full-run.log` returns nothing whether the assertion PASSED or is
  simply not among the first 25 failures. Both look identical: silence.
- Filtering to one suite (`swift run -c release SimTests playbook`) still truncates at 25
  if that one suite alone has more than 25 failures — which it did here (58).
- The failure count in the FAIL header (`FAIL 83 of N assertions`) is easy to skim past
  without doing the subtraction against what's visible.

## What worked

Temporarily raising the `.prefix(25)` / `report.failures.count - 25` cap in `main.swift`
to `999` (and reverting before committing) for a single run showed the true, complete
list. That's the reliable way to confirm a *specific* assertion's status when the run also
has unrelated red — grep on truncated output cannot tell "passing" apart from "just not
shown yet."

## Suggestion

Either print a small "was X among the visible failures? unknown, N hidden" caveat when
`report.failures.count > 25`, or accept a `--show <name-substring>` / `--all` flag on
`SimTests` so an agent chasing one assertion doesn't need to hand-edit `main.swift` and
rebuild to see past the cap.
