import Foundation

/// Invariants over the source tree, which is the one place `SimChecks` cannot look.
///
/// ADR-0002 requires the identical assertions to run inside the shipped app. On a phone there
/// is no source tree to read and no way to enumerate a module's declarations, so a check
/// about the shape of the source has to run where the sources are. That is this target, and
/// it is the reason these are not suites.
///
/// Both audits run every time and failures are pooled: a scan you have to run four times to
/// see four problems is a scan people run once.
let quiet = CommandLine.arguments.contains("--quiet")
var report = Report(quiet: quiet)

Reachability.run(&report)
Structure.run(&report)

if report.failures.isEmpty {
    print("\nPASS — every source invariant holds.")
    exit(0)
}
print("\n\(report.failures.count) failure(s):")
for f in report.failures { print("  \(f)") }
exit(1)
