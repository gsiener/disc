import Foundation

/// One suite's assertion state, live only for the duration of that suite's run.
///
/// Issue #20: this used to be `nonisolated(unsafe) static var passed`/`failures` directly
/// on `Check`, one pair shared by every suite in the process. That is exactly why the six
/// mutually-independent match-playing suites in #6 could not run concurrently — every
/// assertion, from every suite, mutated the same two variables, so two suites running at
/// once would corrupt each other's counts and interleave each other's failure lists.
///
/// `@unchecked Sendable` is not a workaround here; correctness comes from scoping, not
/// from a lock. `runChecks` binds a fresh `Accumulator` to `CheckContext.$current` for the
/// exact duration of one suite's `Task` (see `withTaskGroup` below), and a suite's own body
/// is synchronous, single-threaded code — nothing inside a suite spawns a child task of its
/// own. So exactly one thread ever touches a given `Accumulator`, for exactly as long as
/// its suite runs, and `Check`'s static functions keep the same call shape they always
/// had — no threading a context parameter through ~2.25M call sites.
final class Accumulator: @unchecked Sendable {
    var passed = 0
    var failures: [String] = []

    /// The closest any `near` check in this run came to its own tolerance, and which
    /// check that was. `1.0` would be exactly on the edge; well under `1.0` is real
    /// headroom. `nil` until `near` records its first measurement — see `near` below.
    ///
    /// This is the margin `Harness.swift` used to have no room for at all: a check with
    /// 3500× headroom read identically to one at 99% of budget, because `near` reported
    /// only pass or fail. Suite-local reimplementations (`DiscRuntimeTests.worstRatio`,
    /// `CoeffsTests.worstDeviation`, `AIMathTests.worst`) grew to fill that gap, each with
    /// its own `nonisolated(unsafe) static var` — and, in `DiscRuntimeTests`' and
    /// `CoeffsTests`' case, no reset between runs, so the "worst" they reported was really
    /// the worst since process start, silently stale on a second `runChecks` call — which
    /// is precisely the on-device re-run `SimChecks` being a library exists for.
    var worstMargin: (label: String, ratio: Double)?

    var count: Int { passed + failures.count }
}

/// Where `Check`'s assertion functions look for the accumulator to write into.
///
/// A task-local rather than a parameter: `Check.ok`/`.eq`/`.near`/… keep their existing
/// signatures, so no suite file needs to change to pick up per-run isolation.
enum CheckContext {
    @TaskLocal static var current = Accumulator()
}

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
    /// The number of assertions run in the current task's accumulator, so a suite can
    /// report that it grew rather than silently stopped asserting. See `Suite.minAssertions`
    /// below for the part that actually asserts on it, rather than only reporting it.
    static var count: Int { CheckContext.current.count }

    /// Every other assertion in this enum funnels through here — it is the one place
    /// that touches the accumulator and the one place source location gets attached.
    ///
    /// `#fileID` rather than `#filePath`: a diagnostic label is not a path to open —
    /// `Goldens.load`'s own comment above records why resolving a *real* path against
    /// `#filePath` fails on a phone — and `#fileID` (`"SimChecks/EngineTests.swift"`)
    /// carries no absolute, machine-specific prefix into 2.25M failure strings.
    static func ok(
        _ condition: Bool, _ label: @autoclosure () -> String,
        file: StaticString = #fileID, line: UInt = #line
    ) {
        let acc = CheckContext.current
        if condition {
            acc.passed += 1
        } else {
            acc.failures.append("\(file):\(line): \(label())")
        }
    }

    /// Exact equality for integers and other discrete values.
    static func eq<T: Equatable>(
        _ got: T, _ want: T, _ label: @autoclosure () -> String,
        file: StaticString = #fileID, line: UInt = #line
    ) {
        ok(got == want, "\(label()) — got \(got), want \(want)", file: file, line: line)
    }

    /// Bit-for-bit equality of two doubles.
    ///
    /// Compares bit patterns rather than using `==` so that a sign-of-zero or NaN
    /// difference cannot slip through as equal.
    static func bitEq(
        _ got: Double, _ want: Double, _ label: @autoclosure () -> String,
        file: StaticString = #fileID, line: UInt = #line
    ) {
        ok(
            got.bitPattern == want.bitPattern,
            "\(label()) — got \(got) (0x\(String(got.bitPattern, radix: 16))), "
                + "want \(want) (0x\(String(want.bitPattern, radix: 16)))",
            file: file, line: line
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
        _ got: Double, _ want: Double, _ label: @autoclosure () -> String,
        file: StaticString = #fileID, line: UInt = #line
    ) {
        if got == 0 && want == 0 {
            ok(true, label(), file: file, line: line)
            return
        }
        bitEq(got, want, label(), file: file, line: line)
    }

    /// A value within `tol` of another — an absolute tolerance, not a relative one; the
    /// caller picks a number in the same units as `got`/`want`, not a fraction of `want`.
    ///
    /// **NaN is a value, not a numeric miss, and is reported as one.** Issue #20:
    /// `TryCatchTests.swift`, `CatchBandTests.swift` and others feed `s.field ?? .nan` on
    /// the "want" side when a golden's optional is absent — and the old `near` folded
    /// that into "got 12.5, want nan ± 1e-12," which *reads* like a numeric near-miss and
    /// is not one. Exactly one side NaN now fails with a message that says so plainly;
    /// both sides NaN — the reference's own "no value here" convention, exercised by
    /// `TeamAITests`' wire-format fields — passes, and also says so. Neither case changes
    /// what verdict a real call site gets: today's "exactly one side NaN" already fails
    /// (`NaN <= tol` is always false), and no call site before this change ever hit the
    /// both-NaN branch through `near` directly (only through `TeamAITests.approx`'s own,
    /// separate, deliberate carve-out — left as is; see that file).
    ///
    /// **Passing measures its margin.** `ratio = |got - want| / tol`: `0` is exact, `1` is
    /// exactly on the edge, closer to `1` is less headroom. The worst (closest-to-1) ratio
    /// seen this run is kept on the current accumulator and surfaced on `CheckReport`, so
    /// "3500× headroom" and "99% of budget" stop looking identical — which they did, and
    /// three files (`AIMathTests`, `DiscRuntimeTests`, `CoeffsTests`) each grew their own
    /// tracker to say so, one of them (`DiscRuntimeTests.worstRatio`) never reset between
    /// runs. Both are folded into this one, correctly-scoped implementation now — see
    /// those files for what remains genuinely theirs (an ulp-relative tolerance, or extra
    /// bookkeeping this margin does not replace).
    static func near(
        _ got: Double, _ want: Double, _ tol: Double, _ label: @autoclosure () -> String,
        file: StaticString = #fileID, line: UInt = #line
    ) {
        // Evaluated once. `label` is `@autoclosure`, and this function reads it up to
        // three times (NaN branch, margin tracking, the final message) — calling the
        // closure that many times would be wasted work at 2.25M-call volume even where
        // it is harmless, and would stop being harmless the day a label ever carries a
        // side effect.
        let text = label()
        if got.isNaN || want.isNaN {
            if got.isNaN && want.isNaN {
                ok(true, "\(text) — both absent (NaN), agree", file: file, line: line)
            } else {
                ok(
                    false,
                    "\(text) — one side is absent (NaN: got \(got), want \(want)), "
                        + "not a numeric miss",
                    file: file, line: line
                )
            }
            return
        }
        let d = abs(got - want)
        let ratio = tol > 0 ? d / tol : (d == 0 ? 0 : Double.infinity)
        let acc = CheckContext.current
        if acc.worstMargin == nil || ratio > acc.worstMargin!.ratio {
            acc.worstMargin = (text, ratio)
        }
        ok(d <= tol, "\(text) — got \(got), want \(want) ± \(tol)", file: file, line: line)
    }

    static func inRange(
        _ got: Double, _ lo: Double, _ hi: Double, _ label: @autoclosure () -> String,
        file: StaticString = #fileID, line: UInt = #line
    ) {
        ok(got >= lo && got <= hi, "\(label()) — got \(got), want [\(lo), \(hi)]", file: file, line: line)
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
    /// Always empty. Kept so `SimTests/main.swift` and the iOS report view — neither
    /// owned by this file — keep compiling without a change on their side. There is no
    /// producer left: `Check` had a `note()` case that could not fail, the same call
    /// shape and home enum as `ok`/`eq`/`near` while asserting nothing, and every call
    /// site has been promoted to a real assertion or resolved. See issue #20.
    public let notes: [String]
    public let seconds: Double
    /// The closest any `near` check in the whole run came to its own tolerance, and which
    /// suite and label that was. See `Accumulator.worstMargin`.
    public let worstMargin: (suite: String, label: String, ratio: Double)?

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
    /// The real assertion count this suite ran, measured and committed, so a suite that
    /// silently stops asserting fails loudly instead of just reporting a smaller number.
    ///
    /// Issue #20: `count` used to exist only to be *printed* — nothing compared it to
    /// anything. The concrete case that motivated this: `TeamAITests.swift` drops an
    /// entire per-player `compareIntent` — position, mode, action, lane, cut kind,
    /// matchup — whenever that player's stamina landed on the documented libm knife-edge
    /// (`flipped.contains(got[k].id) { continue }`), bounded only by a 0.5% flip-rate
    /// assertion elsewhere in the same file. That 0.5% ceiling bounds the *rate*; it says
    /// nothing about the *count*, and the skipped comparisons vanished from the total
    /// rather than failing. `TeamAITests.swift` now counts each skip as an explicit,
    /// labelled, passing assertion instead of a bare `continue` — see that file — so this
    /// floor is the general form of the same fix: any suite, not only that one.
    ///
    /// A floor only ever needs to move up (a suite growing new coverage) or be lowered
    /// with a reason (real coverage deliberately removed) — never drift silently, which
    /// is the whole point.
    let minAssertions: Int
}

/// Every suite, in port order — which is also dependency order: the RNG anchors the
/// differential harness, then the aero curves, then the flight model that uses them.
///
/// `minAssertions` is each suite's measured count at the time this line was written,
/// verified in an isolated worktree — not a round number and not a guess. Update it
/// deliberately, in the same commit as whatever changed the suite's real coverage.
let allSuites: [Suite] = [
    Suite(name: "rng", run: RngTests.run, minAssertions: 6042),
    Suite(name: "coeffs", run: CoeffsTests.run, minAssertions: 101663),
    // Issue #58: `simmath` no longer loads a golden. 7,749 recorded comparisons become
    // 392,341 assertions against closed forms and an independently written rotation
    // model — see SimMathTests.swift's header.
    Suite(name: "simmath", run: SimMathTests.run, minAssertions: 392341),
    Suite(name: "flight", run: FlightTests.run, minAssertions: 1458),
    // Issue #58: `throws` no longer loads a golden. 36 recorded flights become 211,410
    // assertions against the release geometry in closed form, an independently written
    // frame model, two flight symmetries, and exact-value pins on the throw table — see
    // ThrowsTests.swift's header.
    Suite(name: "throws", run: ThrowsTests.run, minAssertions: 211410),
    Suite(name: "rules", run: RulesTests.run, minAssertions: 935920),
    Suite(name: "move", run: MoveTests.run, minAssertions: 9018),
    Suite(name: "locomotion", run: LocomotionTests.run, minAssertions: 87643),
    Suite(name: "playbook", run: PlaybookTests.run, minAssertions: 21897),
    Suite(name: "aimath", run: AIMathTests.run, minAssertions: 138497),
    Suite(name: "humanrelease", run: HumanReleaseTests.run, minAssertions: 9990),
    Suite(name: "discruntime", run: DiscRuntimeTests.run, minAssertions: 14154),
    // Lowered from 476751 deliberately: `TeamAITests.structural` now runs on frame zero
    // instead of all 1,370 frames, because the wiring it checks cannot vary by frame (one
    // construction site, both sides reading the same player at the same instant). That is
    // 95,635 identical comparisons removed, not coverage — see `structural`'s own comment.
    Suite(name: "teamai", run: TeamAITests.run, minAssertions: 381115),
    // Issue #58: `gamestate` no longer loads a golden. Nine hand-written scripts and 2,223
    // recorded comparisons become 89,808 assertions against the machine itself — every cell
    // of the phase x action table driven, every phase reached and shown not to be a dead
    // end, and twenty seeds of a referee picking legal actions with the laws of the sport
    // checked after each one. See GameStateTests.swift's header.
    Suite(name: "gamestate", run: GameStateTests.run, minAssertions: 89808),
    // Issue #58: `pull` no longer loads a golden. The recorded release parameters become
    // the bearing law they encode, the fit's constants pinned to their values, and WFDF 12
    // and 13 driven through `GameState` — including the brick-or-sideline choice, which the
    // fixture never captured at all. See PullTests.swift's header.
    Suite(name: "pull", run: PullTests.run, minAssertions: 616),
    // Issue #58: `lineup` no longer loads a golden. 336 recorded coordinates become the
    // opening formation's own laws — seed-independent, evenly spaced, symmetric, on the
    // line each team defends, facing the way it attacks — on both pitches. See
    // LineupTests.swift's header.
    Suite(name: "lineup", run: LineupTests.run, minAssertions: 1752),
    Suite(name: "throwsolver", run: ThrowSolverTests.run, minAssertions: 12618),
    Suite(name: "trycatch", run: TryCatchTests.run, minAssertions: 33),
    Suite(name: "catchband", run: CatchBandTests.run, minAssertions: 1022),
    // Floor lowered from 1587533 with issue #56's stagePoint formation fix: a genuinely
    // different pulling-team opening shape shifts match trajectories (different
    // score/turnover timing downstream of a real pull-position change) enough to move
    // this real, deterministic count. Measured 1587509 in an isolated worktree at the
    // commit that made the change; not chased further, per this repo's own guidance on
    // per-seed bands moving as expected fallout of a real behaviour fix.
    Suite(name: "engine", run: EngineTests.run, minAssertions: 1587509),
    Suite(name: "engineseam", run: EngineSeamTests.run, minAssertions: 149),
    // Floor lowered from 125 to 123 for the same reason as `engine` above — issue #56.
    Suite(name: "events", run: EventTests.run, minAssertions: 123),
    Suite(name: "humandefence", run: HumanDefenceTests.run, minAssertions: 20),
    Suite(name: "humancut", run: HumanCutTests.run, minAssertions: 37),
    Suite(name: "pivot", run: PivotTests.run, minAssertions: 38),
    Suite(name: "calls", run: CallsTests.run, minAssertions: 29),
    Suite(name: "stoppage", run: StoppageTests.run, minAssertions: 4477),
    // Issue #58: the off-ball game, measured off bodies rather than recorded. Thirty
    // assertions over pooled aggregates — a small count carrying a large measurement, which
    // is the shape of every property assertion in here: each one is a statement about
    // hundreds of thousands of frames rather than one comparison.
    Suite(name: "shape", run: ShapeTests.run, minAssertions: 30),
    Suite(name: "replay", run: ReplayTests.run, minAssertions: 258),
    // Floor lowered from 35 to 34 for the same reason as `engine` above — issue #56.
    Suite(name: "matchsave", run: MatchSaveTests.run, minAssertions: 34),
    Suite(name: "permatchreset", run: PerMatchResetTests.run, minAssertions: 21),
    Suite(name: "matchsession", run: MatchSessionTests.run, minAssertions: 39),
    Suite(name: "clock", run: ClockTests.run, minAssertions: 40),
    Suite(name: "tickloop", run: TickLoopTests.run, minAssertions: 646),
    Suite(name: "inputscript", run: InputScriptTests.run, minAssertions: 422),
    Suite(name: "boxscore", run: BoxScoreTests.run, minAssertions: 35),
    Suite(name: "matchdiff", run: MatchDiffTests.run, minAssertions: 41),
    // Issue #58: the tuning constants, pinned to their values. A relation is the right
    // assertion for a law and the wrong one for a tuning number — `CATCH_DEAD < CATCH_FLOOR`
    // stays true while `CATCH_DEAD` moves. Until this existed, the only things holding these
    // fifteen numbers were fixtures that are being deleted.
    Suite(name: "constants", run: ConstantsTests.run, minAssertions: 32),
    Suite(name: "divergences", run: DivergenceTests.run, minAssertions: 34),
    Suite(name: "probecontract", run: ProbeContractTests.run, minAssertions: 224),
]

public var checkSuiteNames: [String] { allSuites.map(\.name) }

/// Runs the checks and reports. Pass suite names to run a subset.
///
/// `async`, and every selected suite runs on its own child task, each bound to its own
/// fresh `Accumulator` via `CheckContext.$current.withValue`. Issue #20: the suites this
/// runs are independent by construction — separate seeds, separate engines, no shared
/// model — and the only thing that ever stopped them running concurrently was one shared
/// mutable `Check.passed`/`.failures` pair. That is gone; this is the proof it is gone,
/// not just the claim.
///
/// A suite's `run` closure is itself synchronous — nothing inside a suite spawns work of
/// its own — so `CheckContext.$current.withValue`'s synchronous overload is correct here:
/// the task-local is bound for the exact, single-threaded duration of that one suite.
public func runChecks(only requested: Set<String> = []) async -> CheckReport {
    let selected = requested.isEmpty ? allSuites : allSuites.filter { requested.contains($0.name) }
    let started = DispatchTime.now()

    struct Outcome {
        let index: Int
        let result: CheckReport.SuiteResult
        let passed: Int
        let failures: [String]
        let worstMargin: (label: String, ratio: Double)?
    }

    let outcomes = await withTaskGroup(of: Outcome.self) { group in
        for (index, suite) in selected.enumerated() {
            group.addTask {
                let acc = Accumulator()
                let suiteStarted = DispatchTime.now()
                CheckContext.$current.withValue(acc) {
                    do {
                        try suite.run()
                    } catch {
                        acc.failures.append("\(suite.name) could not run: \(error)")
                    }
                }
                let elapsed =
                    Double(DispatchTime.now().uptimeNanoseconds - suiteStarted.uptimeNanoseconds)
                    / 1e9
                var failures = acc.failures
                if acc.count < suite.minAssertions {
                    failures.append(
                        "\(suite.name) ran \(acc.count) assertions, below its committed floor "
                            + "of \(suite.minAssertions) (Suite.minAssertions in Harness.swift) "
                            + "— a suite that silently stopped asserting must fail loudly, "
                            + "see issue #20")
                }
                return Outcome(
                    index: index,
                    result: .init(name: suite.name, assertions: acc.count, seconds: elapsed),
                    passed: acc.passed, failures: failures, worstMargin: acc.worstMargin)
            }
        }
        var collected: [Outcome] = []
        for await outcome in group { collected.append(outcome) }
        return collected.sorted { $0.index < $1.index }
    }

    var worstMargin: (suite: String, label: String, ratio: Double)?
    for (outcome, suite) in zip(outcomes, selected) {
        if let m = outcome.worstMargin, worstMargin == nil || m.ratio > worstMargin!.ratio {
            worstMargin = (suite.name, m.label, m.ratio)
        }
    }

    return CheckReport(
        suites: outcomes.map(\.result),
        passed: outcomes.reduce(0) { $0 + $1.passed },
        failures: outcomes.flatMap(\.failures),
        notes: [],
        seconds: Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1e9,
        worstMargin: worstMargin
    )
}
