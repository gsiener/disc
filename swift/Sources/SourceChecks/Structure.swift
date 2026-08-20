import Foundation

/// ADR-0004 — a field question cannot be asked without a field.
///
/// ADR-0004 records the most expensive bug in this project's history: distances that were
/// only right at regulation, on a game whose default format is played on a pitch a third the
/// size. It also says where the durable fix has to live — shape properties that hold at both
/// formats, so a violation is a red assertion rather than something found by reading code one
/// measurement at a time.
///
/// `minisShape()` in `SimChecks` closes the behavioural half. This closes the structural
/// half: a property about the shape of the surface rather than about any number it produces.
enum Structure {

    /// The nine predicates that answer a question about the pitch.
    ///
    /// Each exists as a method on `FieldConstants`, reached through `GameFormat.field`, and
    /// therefore cannot answer without being told which pitch it is. A file-scope copy can
    /// only close over a module constant, and the only module constant available is
    /// regulation — which is exactly the mechanism ADR-0004 was written about.
    static let fieldPredicates = [
        "isInBounds", "endzoneOf", "isInEndzone", "isGoal", "goalLineZ",
        "brickMark", "clampToField", "boundaryCrossing", "putIntoPlaySpot",
    ]

    /// A pitch frozen at module scope. `FIELD` was `FieldConstants.standard`, so every free
    /// function above silently meant "regulation".
    static let frozenPitch = ["FIELD", "CONES"]

    static let declRe = Source.regex(#"^(?:public |internal )?(func|let|var)\s+([A-Za-z_]\w*)"#)

    static func run(_ report: inout Report) {
        report.note("\nADR-0004 — a field question cannot be asked without a field")

        let files = Source.load(["\(Source.root)/swift/Sources/UltimateSim"])
        report.ok(!files.isEmpty, "found the port", "\(files.count) files")

        for file in files.keys.sorted() {
            var offenders: [String] = []
            for (i, line) in files[file]!.enumerated() {
                guard let m = declRe.firstMatch(in: line), m.numberOfRanges > 2,
                      let kr = Range(m.range(at: 1), in: line),
                      let nr = Range(m.range(at: 2), in: line) else { continue }
                let kind = String(line[kr]), name = String(line[nr])
                if (kind == "func" && fieldPredicates.contains(name))
                    || (kind != "func" && frozenPitch.contains(name)) {
                    offenders.append("line \(i + 1) declares \(kind) \(name) at file scope")
                }
            }
            report.ok(offenders.isEmpty, Source.rel(file), offenders.joined(separator: "; "))
        }

        // The counterparts must actually exist, or the check above passes by having deleted
        // the capability rather than by having parameterised it.
        report.note("\nFieldConstants answers all nine")
        let path = "\(Source.root)/swift/Sources/UltimateSim/Game/GameFormat.swift"
        let src = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        for p in fieldPredicates {
            report.ok(
                Source.regex(#"(?m)^\s+public func "# + p + #"\b"#).matches(src),
                "FieldConstants.\(p)")
        }
    }
}
