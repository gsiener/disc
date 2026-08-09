import Foundation

/// The test harness, ported in spirit from the TypeScript suites.
///
/// Assertions are *envelope* assertions: a labelled condition, or a value inside a
/// stated range. That choice is what lets the same suites survive a port at all — a
/// golden-value suite would have to be regenerated the moment any libm differs,
/// whereas a range holds across an ulp of drift.
///
/// Where a value genuinely must be identical rather than close, use `bitEq`, and mean
/// it: reach for it only when the operation is correctly rounded by IEEE 754 and a
/// difference would therefore be a logic bug rather than platform noise.
///
/// **This is a library, not a test target, and that is what lets it run on the phone.**
/// `Testing` and `XCTest` both ship with Xcode rather than the Command Line Tools, and
/// neither runs inside a shipped app. Keeping the checks in a plain library means the
/// *same assertions* run in CI and on device — which matters more here than it would
/// elsewhere, because the whole risk of this port is numbers that differ by platform.
/// A suite that only ever runs on the Mac cannot tell you the arm64 build agrees.
public enum Check {
    nonisolated(unsafe) static var passed = 0
    nonisolated(unsafe) static var failures: [String] = []
    nonisolated(unsafe) static var notes: [String] = []

    /// The number of assertions run, so a suite can report that it grew rather than
    /// silently stopped asserting.
    static var count: Int { passed + failures.count }

    static func reset() {
        passed = 0
        failures = []
        notes = []
    }

    /// Free-form diagnostics that are not pass/fail — a measured margin, say. Surfaced
    /// in the report so a number that is drifting is visible before it is a failure.
    static func note(_ text: String) {
        notes.append(text)
    }

    static func ok(_ condition: Bool, _ label: @autoclosure () -> String) {
        if condition {
            passed += 1
        } else {
            failures.append(label())
        }
    }

    /// Exact equality for integers and other discrete values.
    static func eq<T: Equatable>(_ got: T, _ want: T, _ label: @autoclosure () -> String) {
        ok(got == want, "\(label()) — got \(got), want \(want)")
    }

    /// Bit-for-bit equality of two doubles.
    ///
    /// Compares bit patterns rather than using `==` so that a sign-of-zero or NaN
    /// difference cannot slip through as equal.
    static func bitEq(_ got: Double, _ want: Double, _ label: @autoclosure () -> String) {
        ok(
            got.bitPattern == want.bitPattern,
            "\(label()) — got \(got) (0x\(String(got.bitPattern, radix: 16))), "
                + "want \(want) (0x\(String(want.bitPattern, radix: 16)))"
        )
    }

    /// Bit-equality for values that reached us through a JSON golden.
    ///
    /// Identical to `bitEq` except that `+0` and `-0` compare equal, because
    /// `JSON.stringify(-0)` emits `0` and the fixture therefore cannot carry the sign of
    /// a zero. This is a limit of the transport, not a relaxation of the port: asserting
    /// something the file format cannot express would just be asserting the generator's
    /// rounding.
    ///
    /// Signed zero is not load-bearing in this sim. The one place it could propagate is
    /// `atan2(-vn, vpm)` feeding the angle of attack, and every coefficient curve is
    /// linear in alpha near zero — `CL0 + CLa * (-0)` is `CL0`. If that ever stops being
    /// true, the trajectory suites catch it, because they compare integrated flights
    /// rather than single operations.
    static func bitEqViaJSON(
        _ got: Double, _ want: Double, _ label: @autoclosure () -> String
    ) {
        if got == 0 && want == 0 {
            ok(true, label())
            return
        }
        bitEq(got, want, label())
    }

    static func near(
        _ got: Double, _ want: Double, _ tol: Double, _ label: @autoclosure () -> String
    ) {
        ok(abs(got - want) <= tol, "\(label()) — got \(got), want \(want) ± \(tol)")
    }

    static func inRange(
        _ got: Double, _ lo: Double, _ hi: Double, _ label: @autoclosure () -> String
    ) {
        ok(got >= lo && got <= hi, "\(label()) — got \(got), want [\(lo), \(hi)]")
    }
}

/// Loads a golden fixture by name.
///
/// Read from the module's resource bundle rather than from the source tree. An earlier
/// version resolved paths relative to `#filePath`, which works on the Mac and fails on
/// a phone, where there is no checkout to be relative to.
enum Goldens {
    static func load<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        guard let url = Bundle.module.url(forResource: "Goldens/\(name)", withExtension: "json")
        else {
            throw CheckError.missingGolden(
                "\(name).json is not in the bundle — run `node tools/gen-goldens.ts`")
        }
        do {
            return try JSONDecoder().decode(type, from: Data(contentsOf: url))
        } catch {
            throw CheckError.missingGolden("\(name).json does not decode: \(error)")
        }
    }
}

enum CheckError: Error, CustomStringConvertible {
    case missingGolden(String)

    var description: String {
        switch self {
        case .missingGolden(let detail): return detail
        }
    }
}

/// What a run produced. Returned rather than printed, so the CLI can exit on it and the
/// app can draw it.
public struct CheckReport: Sendable {
    public struct SuiteResult: Sendable {
        public let name: String
        public let assertions: Int
        public let seconds: Double
    }

    public let suites: [SuiteResult]
    public let passed: Int
    public let failures: [String]
    public let notes: [String]
    public let seconds: Double

    public var total: Int { passed + failures.count }
    public var isGreen: Bool { failures.isEmpty }

    /// A one-line summary, identical in the terminal and on the phone.
    public var summary: String {
        isGreen
            ? "PASS  \(total) assertions, 0 failures"
            : "FAIL  \(failures.count) of \(total) assertions"
    }
}

/// A named suite, so a caller can select one.
struct Suite: Sendable {
    let name: String
    let run: @Sendable () throws -> Void
}

/// Every suite, in port order — which is also dependency order: the RNG anchors the
/// differential harness, then the aero curves, then the flight model that uses them.
let allSuites: [Suite] = [
    Suite(name: "rng", run: RngTests.run),
    Suite(name: "coeffs", run: CoeffsTests.run),
    Suite(name: "simmath", run: SimMathTests.run),
    Suite(name: "flight", run: FlightTests.run),
    Suite(name: "throws", run: ThrowsTests.run),
    Suite(name: "rules", run: RulesTests.run),
    Suite(name: "move", run: MoveTests.run),
    Suite(name: "locomotion", run: LocomotionTests.run),
    Suite(name: "playbook", run: PlaybookTests.run),
    Suite(name: "aimath", run: AIMathTests.run),
    Suite(name: "humanrelease", run: HumanReleaseTests.run),
    Suite(name: "discruntime", run: DiscRuntimeTests.run),
    Suite(name: "teamai", run: TeamAITests.run),
    Suite(name: "gamestate", run: GameStateTests.run),
    Suite(name: "throwsolver", run: ThrowSolverTests.run),
    Suite(name: "trycatch", run: TryCatchTests.run),
    Suite(name: "engine", run: EngineTests.run),
    Suite(name: "events", run: EventTests.run),
    Suite(name: "humandefence", run: HumanDefenceTests.run),
    Suite(name: "pivot", run: PivotTests.run),
    Suite(name: "calls", run: CallsTests.run),
    Suite(name: "replay", run: ReplayTests.run),
    Suite(name: "matchsave", run: MatchSaveTests.run),
    Suite(name: "clock", run: ClockTests.run),
    Suite(name: "boxscore", run: BoxScoreTests.run),
]

public var checkSuiteNames: [String] { allSuites.map(\.name) }

/// Runs the checks and reports. Pass suite names to run a subset.
public func runChecks(only requested: Set<String> = []) -> CheckReport {
    Check.reset()

    let selected = requested.isEmpty ? allSuites : allSuites.filter { requested.contains($0.name) }
    var results: [CheckReport.SuiteResult] = []
    let started = DispatchTime.now()

    for suite in selected {
        let before = Check.count
        let suiteStarted = DispatchTime.now()
        do {
            try suite.run()
        } catch {
            Check.failures.append("\(suite.name) could not run: \(error)")
        }
        let elapsed =
            Double(DispatchTime.now().uptimeNanoseconds - suiteStarted.uptimeNanoseconds) / 1e9
        results.append(
            .init(name: suite.name, assertions: Check.count - before, seconds: elapsed))
    }

    return CheckReport(
        suites: results,
        passed: Check.passed,
        failures: Check.failures,
        notes: Check.notes,
        seconds: Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1e9
    )
}
