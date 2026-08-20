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
/// # What this is and is not
///
/// Text, not a type checker. It matches declarations and call tokens with regular expressions
/// over source, which means it cannot tell two overloads apart: a name declared twice and
/// called once reads as called. It is a smoke alarm, not an inventory — the cost of a miss is
/// a capability that stays wired, and the cost of a false alarm is a name in `allowlist`
/// with a reason, so it is tuned to under-report.
///
/// Initialisers are out of scope: `init` is not matched by the identifier class, and treating
/// "no call to `init(`" as unreachable would flag every initialiser in the library. Operators
/// are excluded the same way — `func ==` does not match `[A-Za-z_]\w*`.
///
/// # Why this is Swift and not a script
///
/// It audits the product, so it outlives the reference it used to live beside. Issue #58
/// deletes `tools/`, and with it the Node implementation this replaces — a guard that dies
/// with the oracle would take a real check on the shipped code down with it.

// MARK: - source

func swiftFiles(under dir: String) -> [String] {
    guard let e = FileManager.default.enumerator(atPath: dir) else { return [] }
    return e.compactMap { $0 as? String }
        .filter { $0.hasSuffix(".swift") }
        .map { dir + "/" + $0 }
        .sorted()
}

struct Decl { let name: String, file: String, line: Int }

func regex(_ p: String) -> NSRegularExpression {
    // A pattern that does not compile is a bug in this file, not in the tree it scans.
    try! NSRegularExpression(pattern: p)
}

extension NSRegularExpression {
    func firstMatch(in s: String) -> NSTextCheckingResult? {
        firstMatch(in: s, range: NSRange(s.startIndex..., in: s))
    }
    func matches(_ s: String) -> Bool { firstMatch(in: s) != nil }
}

/// `public func name(` / `public static func name<` — the declarations this scan is about.
let declRe = regex(#"^\s*public\s+(?:static\s+)?func\s+([A-Za-z_]\w*)\s*[(<]"#)

func publicFuncDecls(_ files: [String: [String]]) -> [Decl] {
    var out: [Decl] = []
    for (file, lines) in files {
        for (i, line) in lines.enumerated() {
            guard let m = declRe.firstMatch(in: line), m.numberOfRanges > 1,
                  let r = Range(m.range(at: 1), in: line) else { continue }
            out.append(Decl(name: String(line[r]), file: file, line: i + 1))
        }
    }
    return out
}

/// Whether `name` is *called* — not declared — anywhere in these lines.
///
/// A declaration never counts as a call, at any access level and in any type, which is the
/// overload limitation above stated as a rule: counting a re-declaration as a call would hide
/// a function declared several times and invoked zero.
///
/// A preceding word character means the token is the tail of some other identifier, so
/// `isMarkerLegal(` must not answer a search for `markerLegal`. A preceding `.` must NOT be
/// excluded — `receiver.name(` is the ordinary instance call this whole scan exists to find.
///
/// A one-line body puts a real call on the same line as the declaration it is not:
/// `public func isAirborne(_ p: AIPlayer) -> Bool { loco.isAirborne(id: p.id) }`. So the
/// declaration's own prefix is stripped and the remainder searched, rather than the line
/// being discarded.
func isCalled(_ name: String, in lines: [String]) -> Bool {
    let declPrefix = regex(#"^\s*(?:public|internal|private|fileprivate)?\s*(?:static\s+)?func\s+"#
        + NSRegularExpression.escapedPattern(for: name) + #"\s*[(<][^{]*\{?"#)
    let callToken = regex(#"(?<![A-Za-z0-9_])"#
        + NSRegularExpression.escapedPattern(for: name) + #"\("#)
    for line in lines {
        var rest = line
        if let m = declPrefix.firstMatch(in: line), let r = Range(m.range, in: line) {
            rest = String(line[r.upperBound...])
        }
        if callToken.matches(rest) { return true }
    }
    return false
}

// MARK: - the exceptions, with their reasons

/// Symbols whose only caller is `SimChecks`, kept deliberately rather than wired or deleted.
/// Add here only with a reason a future reader would need in order not to re-flag it — never
/// because the guard is inconvenient this week.
let allowlist: [String: String] = [
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

let knownUnresolved: [String: String] = [
    "setCalledForce":
        "A whole force-calling read+write pair, unused on both ends — looks like `commandCut` before it was wired. Needs a product decision, not a scanner verdict.",
    "peakReach":
        "AI bid-height gating uses the fixed CATCH_CEILING/LAYOUT_CEILING constants instead of this per-player derived reach. Whether leap height should vary by player is a design question.",
    "breakSideFor":
        "src/sim/AI.ts calls this; TeamAIDefence.swift computes the break side via `breakSideSign` (position-independent) at its one call site instead. Possibly a real port/reference behavioural gap — needs the reference read in context first.",
    "contest":
        "Entry point to an entire alternate catch-contest model (Move/Contest.swift); production resolves catches through CatchDecision instead. Deleting risks cascading into a file this pass has not fully read.",
]

// MARK: - the scan

let root = ProcessInfo.processInfo.environment["REPO_ROOT"]
    ?? FileManager.default.currentDirectoryPath
let quiet = CommandLine.arguments.contains("--quiet")

/// `UltimateSim` declares; everything a product build can reach is allowed to call.
let declDirs = ["\(root)/swift/Sources/UltimateSim"]
let searchDirs = declDirs + [
    "\(root)/swift/Sources/FlightUI",
    "\(root)/swift/Sources/FlightScope",
    "\(root)/ios",
]

func load(_ dirs: [String]) -> [String: [String]] {
    var out: [String: [String]] = [:]
    for d in dirs {
        for f in swiftFiles(under: d) {
            guard let text = try? String(contentsOfFile: f, encoding: .utf8) else { continue }
            out[f] = text.components(separatedBy: "\n")
        }
    }
    return out
}

// Read once. The Node implementation re-read every file for every name; the tree is small
// enough that it did not matter, and holding it is simpler than explaining why it did not.
let declFiles = load(declDirs)
let searchFiles = load(searchDirs)

var byName: [String: [Decl]] = [:]
for d in publicFuncDecls(declFiles) { byName[d.name, default: []].append(d) }

func rel(_ p: String) -> String { p.hasPrefix(root + "/") ? String(p.dropFirst(root.count + 1)) : p }

print("Reachability — every public UltimateSim func, outside SimChecks")

var failures: [String] = []
var unresolved = 0

for name in byName.keys.sorted() {
    let ds = byName[name]!
    let where_ = ds.map { "\(rel($0.file)):\($0.line)" }.joined(separator: ", ")
    let called = searchFiles.values.contains { isCalled(name, in: $0) }

    if let reason = allowlist[name] {
        // An allowlisted name still has to be called by something, even if only by the
        // checks. One that nothing calls at all has drifted from its own justification.
        if !quiet { print("  ALLOWED  \(name) (\(where_)) — \(reason)") }
        continue
    }
    if called {
        if !quiet { print("  ok       \(name)") }
        continue
    }
    if let note = knownUnresolved[name] {
        unresolved += 1
        print("  UNRESOLVED \(name) (\(where_)) — \(note)")
        continue
    }
    failures.append("\(name) (\(where_))")
}

if unresolved > 0 {
    print("\n\(unresolved) unresolved — see knownUnresolved for what each needs.")
}

if failures.isEmpty {
    print("\nEvery public UltimateSim func has a caller outside SimChecks.")
    exit(0)
}

print("\n\(failures.count) public func(s) with no caller outside SimChecks:")
for f in failures { print("  \(f)") }
print("""

Wire it to something a player can reach, delete it, or add it to `allowlist` or
`knownUnresolved` in this file with a reason — see issue #5.
""")
exit(1)
