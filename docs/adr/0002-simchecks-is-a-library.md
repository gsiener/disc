# ADR-0002 — `SimChecks` is a library, not an XCTest target

- **Status:** Accepted
- **Date:** recorded 2026-08-10, decided earlier (see `swift/Package.swift:29-40`, `Harness.swift:15-19`)

## Context

The differential suite has to run in two places:

- on a Mac, in the terminal, on every push, as the fast signal;
- **on the device**, because the risk this port carries is arm64 floating-point behaviour.
  A suite that only ever runs on a CI runner cannot see a divergence that only appears on
  an iPhone.

`XCTest` cannot run inside a shipped application. So an XCTest target would have meant two
bodies of assertions — one for the terminal and one for the device — which is the exact
class of duplication this project exists to avoid.

## Decision

`SimChecks` is a **library target**. `SimTests` is a thin executable that calls into it.
The app links the same library and runs the identical assertions in a debug tab.

## Consequences

**What it bought.** One body of assertions, two hosts. The on-device run is the same code,
not a port of it.

**What it cost.** Everything XCTest would have provided is hand-rolled or forgone:

| XCTest gives | `SimChecks` has |
|---|---|
| test discovery | `allSuites`, a hand-edited registry in `Harness.swift:161` |
| name filtering | `main.swift:14-19` |
| parallel execution | a bare sequential loop (`Harness.swift:196-215`) |
| per-test timing | printed by hand |
| `#file` / `#line` | **nothing** — every assertion carries a hand-built `String` label |
| `XCTExpectFailure` | a paragraph of prose in `AGENTS.md:104-108` |

The registry is a shared line-oriented file and therefore a merge hazard between agents —
logged in `.agents/friction-log/20260809175052-registering-a-simchecks/`, which records
that `AGENTS.md`'s pathspec rule actively breaks on it and put a non-building commit on
main.

## The library is not the deletable part

Issue #20 proposes deepening `Check` — margins, source location, an assertion floor,
per-suite results instead of a process-global counter. **That is not a proposal to adopt
XCTest**, and it should not be read as one. The global accumulator
(`Harness.swift:22-24`) is what forbids parallelism and what makes "measured but not
asserted" easy; it is separable from the decision recorded here.

## Not up for reconsideration

"Just use XCTest" should be declined unless it comes with an answer for how the identical
assertions run inside the shipped app on an iPhone.

Related: [ADR-0001](0001-the-typescript-reference-is-the-oracle.md), issue #20.
