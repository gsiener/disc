import Foundation
import SimChecks

// The sim test runner.
//
//   swift run SimTests                     — everything
//   swift run SimTests rng                 — one suite
//   swift run SimTests --all               — print every failure, not just the first 25
//   swift run SimTests --show minisShape   — print only failures whose text contains the
//                                             given substring (suite name, file, line or
//                                             assertion label all match), uncapped
//
// Thin on purpose. The suites themselves live in the `SimChecks` library so the iOS app
// can run the identical assertions on device — see the note in Harness.swift. This file
// only turns a report into terminal output and an exit code.
//
// Issue #50: the printed failure list used to be a silent `.prefix(25)` — a targeted
// assertion past that cap was indistinguishable from a passing one in the output. `--show`
// and `--all` exist so chasing one assertion doesn't require hand-editing that cap and
// rebuilding, and the cap itself is now always paired with a count of what's hidden.

var args = Array(CommandLine.arguments.dropFirst())

let showAll = args.contains("--all")
args.removeAll { $0 == "--all" }

var showSubstring: String?
if let flagIndex = args.firstIndex(of: "--show") {
    guard flagIndex + 1 < args.count else {
        print("--show requires a substring argument, e.g. --show minisShape")
        exit(2)
    }
    showSubstring = args[flagIndex + 1]
    args.removeSubrange(flagIndex...(flagIndex + 1))
}

let requested = Set(args)
let unknown = requested.subtracting(checkSuiteNames)
if !unknown.isEmpty {
    print(
        "no such suite: \(unknown.sorted().joined(separator: " ")) — "
            + "have: \(checkSuiteNames.joined(separator: " "))")
    exit(2)
}

let report = await runChecks(only: requested)

for suite in report.suites {
    let name = suite.name.padding(toLength: 12, withPad: " ", startingAt: 0)
    print("  \(name) \(suite.assertions) assertions  \(String(format: "%.3f", suite.seconds))s")
}
for note in report.notes {
    print("  · \(note)")
}
if let m = report.worstMargin {
    print("  closest call: \(m.label) at \(String(format: "%.1f", m.ratio * 100))% of its tolerance (\(m.suite))")
}

if report.isGreen {
    print("\u{1B}[32m\u{1B}[1mPASS\u{1B}[0m  \(report.total) assertions, 0 failures")
    exit(0)
}

print("\u{1B}[31m\u{1B}[1mFAIL\u{1B}[0m  \(report.failures.count) of \(report.total) assertions")

var candidates = report.failures
if let needle = showSubstring {
    candidates = candidates.filter { $0.localizedCaseInsensitiveContains(needle) }
    print("  --show \"\(needle)\" matches \(candidates.count) of \(report.failures.count) failures")
}

// Cap the printed list unless --all or --show was requested: a structural porting bug
// fails thousands of assertions at once, and a screen of identical lines buries the
// summary. But never let the cap look like "everything's shown" — always say what's
// hidden and how to see it, since a truncated list is indistinguishable from a complete
// one otherwise (issue #50).
let cap = 25
let uncapped = showAll || showSubstring != nil
let shown = uncapped ? candidates : Array(candidates.prefix(cap))
for failure in shown { print("  · \(failure)") }
if shown.count < candidates.count {
    print(
        "  \(shown.count) of \(candidates.count) failures shown; "
            + "\(candidates.count - shown.count) hidden — see --all or --show <substring>")
}
exit(1)
