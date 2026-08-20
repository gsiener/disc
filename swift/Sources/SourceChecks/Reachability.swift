import Foundation

/// Every public `UltimateSim` function, and whether anything outside `SimChecks` calls it.
///
/// Five times this repository has shipped a validated, differentially-tested capability that
/// nothing but its own checks ever called: `drop`/`block`/`pullDropped`, the self-officiation
/// machine, `TeamAI.commandCut`, `GameState.callTimeout`, and the sweep of `markerLegal`,
/// `stallRemaining`, `currentBrick`, `clearLog`, `setTrail` and `runningCut`. Every one took
/// a human noticing. A capability with no caller is not a feature — it is a suite asserting
/// against itself, and it passes forever.
///
/// Text, not a type checker. It cannot tell two overloads apart: a name declared twice and
/// called once reads as called. It is a smoke alarm, not an inventory — a miss leaves a
/// capability wired, a false alarm costs a line in `allowlist`, so it is tuned to
/// under-report. Initialisers are out of scope (`init` is not in the identifier class, and
/// "no call to `init(`" would flag every initialiser in the library); operators likewise.
enum Reachability {

    /// Symbols whose only caller is `SimChecks`, kept deliberately rather than wired or
    /// deleted. Add here only with a reason a future reader would need in order not to
    /// re-flag it — never because the guard is inconvenient this week.
    static let allowlist: [String: String] = [
            "runningCut":
            "Issue #5. Read-only test oracle for `commandCut` (the tap-a-cut feature, which DOES have a production caller in FlightUI): it is what lets `HumanCutTests` assert the AI actually ran the ordered route, not merely that a ghost appeared on screen. FlightUI's cut-call UI runs on three fixed timers deliberately decoupled from live AI state — wiring this into it would fight a documented design choice, not finish one. See `TeamAICutRead.swift`'s file header.",
            "laneHolder":
            "Issue #5, same reasoning and the same file as `runningCut` — its sibling read, used identically as test-oracle infrastructure in `HumanCutTests`.",
            "locoIntent":
            "Issue #5. Own doc comment: \"the single point where the ported AI's vocabulary becomes the ported locomotion's ... Exposing it is what lets the join be asserted at all.\" `Engine.swift`.",
            "reportedAction":
            "Issue #5. Own doc comment: \"the single fact `catchBodies` turns into the `attacking` flag ... 'the input reached the intent path' is exactly the assertion this read enables.\" `Engine.swift`.",
            "contestBodies":
            "Issue #5. Own doc comment: \"so a check can ask what the contest would be handed without re-deriving it ... a second copy of that derivation is a check that passes while the real one is wrong.\" `Engine.swift`.",
            "record":
            "Issue #5. `MatchRecorder` \"owns the loop rather than observing one\" (its own file comment) — a shape built for `ReplayTests` to script a match without hand-managing tick/clock bookkeeping. `MatchView` does not want that shape: it already owns its loop (SwiftUI-driven) and appends to its own `inputs` array directly. Different consumer, different shape, not a duplicate — verified against the full git history of `swift/Sources/FlightUI/`, which never once constructs a `MatchRecorder`.",
            "restore":
            "Issue #5. `MatchRestore`'s own doc comment on the static form: \"Replay the lot in one go. For a check, or for a save short enough that chunking it would only be ceremony.\" FlightUI's restore is chunked on purpose — `MatchPersistence.swift` drives the instance path (`advance(ticks:)`/`isFinished`/`progress`) across frames so a progress bar has something to show — which is the ceremony this static form is named as skipping.",
            "distSq2":
            "Issue #5. `Playbook.dist2` (hypot-based) is the form production paths use; this is its squared-distance sibling, differentially verified, uncalled outside the fixture that verifies it.",
            "inOwnEndzone":
            "Issue #5. Dead on both sides, not only the port: `src/sim/AI.ts` imports `inAttackEndzone` (used) but never `inOwnEndzone` — exported for symmetry with it and never called by the reference's own game logic either.",
            "isCommitted":
            "Issue #5. `Locomotion.isAvailable` (its sibling, same file) is the predicate production reads; `isCommitted` is differentially verified, uncalled outside the one fixture case that checks it.",
            "v3":
            "Issue #5. A test-fixture literal-vector constructor terse enough for `RulesTests`' own case tables; no production site builds a `Vec3d` this way.",
            "stackHolding":
            "Issue #5. \"Cutter ids currently HOLDING the stack\" — a debug-shaped read (`t.stackHolding().map(String.init).joined(...)`) used once, to print a state string a `TeamAITests` fixture compares against; no HUD or AI decision consumes it today.",
            "zoneRoleOf":
            "Issue #5. Sibling of `matchupOf` (used in production person-defence assignment); zone defence's own responsibility read, differentially verified, no identified caller once zone defence is actually playing zone.",
            "endzoneOf":
            "Issue #5. `FieldConstants.isInEndzone`/`isGoal` are what production calls; the three-way (`+1`/`-1`/`0`) form is bit-exact verified against the reference's own `endzoneOf` but nothing needs the three-way answer specifically. Not the free-function version — that one was deleted outright in #45.",
    ]

    static let knownUnresolved: [String: String] = [
            "setCalledForce":
            "A whole force-calling read+write pair, unused on both ends — looks like `commandCut` before it was wired. Needs a product decision, not a scanner verdict.",
            "peakReach":
            "AI bid-height gating uses the fixed CATCH_CEILING/LAYOUT_CEILING constants instead of this per-player derived reach. Whether leap height should vary by player is a design question.",
            "breakSideFor":
            "src/sim/AI.ts calls this; TeamAIDefence.swift computes the break side via `breakSideSign` (position-independent) at its one call site instead. Possibly a real port/reference behavioural gap — needs the reference read in context first.",
            "contest":
            "Entry point to an entire alternate catch-contest model (Move/Contest.swift); production resolves catches through CatchDecision instead. Deleting risks cascading into a file this pass has not fully read.",
    ]
    static let declRe = Source.regex(#"^\s*public\s+(?:static\s+)?func\s+([A-Za-z_]\w*)\s*[(<]"#)

    /// Whether `name` is *called* — not declared — anywhere in these lines.
    ///
    /// A declaration never counts as a call, at any access level and in any type: counting a
    /// re-declaration as a call would hide a function declared several times and invoked
    /// zero. A preceding word character means the token is the tail of another identifier,
    /// so `isMarkerLegal(` must not answer a search for `markerLegal`; a preceding `.` must
    /// NOT be excluded, because `receiver.name(` is the ordinary call this scan exists to
    /// find. And a one-line body puts a real call on the same line as the declaration it is
    /// not, so the declaration's own prefix is stripped and the remainder searched rather
    /// than the line discarded.
    static func isCalled(_ name: String, in lines: [String]) -> Bool {
        let escaped = NSRegularExpression.escapedPattern(for: name)
        let declPrefix = Source.regex(
            #"^\s*(?:public|internal|private|fileprivate)?\s*(?:static\s+)?func\s+"#
            + escaped + #"\s*[(<][^{]*\{?"#)
        let callToken = Source.regex(#"(?<![A-Za-z0-9_])"# + escaped + #"\("#)
        for line in lines {
            var rest = line
            if let m = declPrefix.firstMatch(in: line), let r = Range(m.range, in: line) {
                rest = String(line[r.upperBound...])
            }
            if callToken.matches(rest) { return true }
        }
        return false
    }

    static func run(_ report: inout Report) {
        report.note("\nReachability — every public UltimateSim func, outside SimChecks")

        let declDirs = ["\(Source.root)/swift/Sources/UltimateSim"]
        let searchDirs = declDirs + [
            "\(Source.root)/swift/Sources/FlightUI",
            "\(Source.root)/swift/Sources/FlightScope",
            "\(Source.root)/ios",
        ]
        let declFiles = Source.load(declDirs)
        let searchFiles = Source.load(searchDirs)
        report.ok(!declFiles.isEmpty, "found the port", "\(declFiles.count) files")

        var byName: [String: [(file: String, line: Int)]] = [:]
        for (file, lines) in declFiles {
            for (i, line) in lines.enumerated() {
                guard let m = declRe.firstMatch(in: line), m.numberOfRanges > 1,
                      let r = Range(m.range(at: 1), in: line) else { continue }
                byName[String(line[r]), default: []].append((file, i + 1))
            }
        }

        var unresolved = 0
        for name in byName.keys.sorted() {
            let sites = byName[name]!
                .map { "\(Source.rel($0.file)):\($0.line)" }.joined(separator: ", ")
            if let reason = allowlist[name] {
                if !report.quiet { print("  ALLOWED  \(name) (\(sites)) — \(reason)") }
                continue
            }
            if searchFiles.values.contains(where: { isCalled(name, in: $0) }) {
                if !report.quiet { print("  ok       \(name)") }
                continue
            }
            if let note = knownUnresolved[name] {
                unresolved += 1
                print("  UNRESOLVED \(name) (\(sites)) — \(note)")
                continue
            }
            report.ok(false, name, "no caller outside SimChecks (\(sites))")
        }
        if unresolved > 0 {
            report.note("  \(unresolved) unresolved — see knownUnresolved for what each needs.")
        }
    }
}
