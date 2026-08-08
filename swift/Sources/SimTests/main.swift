import Foundation
import SimChecks

// The sim test runner.
//
//   swift run SimTests          — everything
//   swift run SimTests rng      — one suite
//
// Thin on purpose. The suites themselves live in the `SimChecks` library so the iOS app
// can run the identical assertions on device — see the note in Harness.swift. This file
// only turns a report into terminal output and an exit code.

let requested = Set(CommandLine.arguments.dropFirst())
let unknown = requested.subtracting(checkSuiteNames)
if !unknown.isEmpty {
    print(
        "no such suite: \(unknown.sorted().joined(separator: " ")) — "
            + "have: \(checkSuiteNames.joined(separator: " "))")
    exit(2)
}

let report = runChecks(only: requested)

for suite in report.suites {
    let name = suite.name.padding(toLength: 12, withPad: " ", startingAt: 0)
    print("  \(name) \(suite.assertions) assertions  \(String(format: "%.3f", suite.seconds))s")
}
for note in report.notes {
    print("  · \(note)")
}

if report.isGreen {
    print("\u{1B}[32m\u{1B}[1mPASS\u{1B}[0m  \(report.total) assertions, 0 failures")
    exit(0)
}

// Cap the printed list: a structural porting bug fails thousands of assertions at once,
// and a screen of identical lines buries the summary.
print("\u{1B}[31m\u{1B}[1mFAIL\u{1B}[0m  \(report.failures.count) of \(report.total) assertions")
for failure in report.failures.prefix(25) { print("  · \(failure)") }
if report.failures.count > 25 {
    print("  … and \(report.failures.count - 25) more")
}
exit(1)
