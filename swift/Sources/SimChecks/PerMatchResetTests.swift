import Foundation

/// Tests the non-session half of the shared per-match reset boundary — issue #43, slimmed
/// by issue #16 Phase 2 when the eleven session fields (six countdown toasts, five
/// tap/refusal tallies) moved to `MatchSession`/`MatchSessionTests`.
///
/// `restart(_:)` and `adopt(_:from:setup:)` must both apply the same reset to all
/// non-session per-match state — the drag, the scene, the clock, the handoff-tracking seam,
/// and the restore bookkeeping. This suite verifies the `PerMatchReset` value type that
/// defines that boundary is complete and has the correct zero values, without importing
/// SwiftUI.
///
/// The test seam is the type itself: a field that is not in `PerMatchReset.allFields` is a
/// field that can silently drift between the two paths. (The seven fields `adopt` was
/// originally missing — issue #43 — turned out to all be session fields; see
/// `MatchSessionTests.restartOnlyFieldsAreExact` for where that half of the contract now
/// lives. This suite covers the other seven fields, which were already parallel between the
/// two paths before #43 and remain so.)
enum PerMatchResetTests {

    static func run() throws {
        sharedBoundaryIsComplete()
        zeroValuesAreCorrect()
        defaultInitProducesAllZeros()
        fieldEnumMatchesStructProperties()
    }

    /// The shared boundary covers every required non-session field.
    static func sharedBoundaryIsComplete() {
        let fields = Set([
            "drag", "sceneInvalidated", "clockReset", "lastControlled",
            "clearedAtEnd", "restoring", "resumable",
        ])
        for field in fields {
            Check.ok(
                PerMatchReset.allFields.contains(field),
                "\(field) is in the shared boundary — non-session fields cannot drift")
        }
        Check.eq(
            PerMatchReset.allFields.count, 7,
            "the shared boundary covers 7 non-session fields")
        // No duplicates.
        Check.eq(
            Set(PerMatchReset.allFields).count, PerMatchReset.allFields.count,
            "no duplicate field names in allFields")
    }

    /// The zero values are all nil / 0 / empty / false / true as the contract requires.
    static func zeroValuesAreCorrect() {
        let reset = PerMatchReset()

        Check.ok(reset.drag == nil, "drag is nil after reset (cancelDrag)")
        Check.eq(reset.sceneInvalidated, true, "scene is invalidated after reset")
        Check.eq(reset.clockReset, true, "clock is reset after reset")
        Check.ok(reset.lastControlled == nil, "lastControlled is caller-set after reset")
        Check.eq(reset.clearedAtEnd, false, "clearedAtEnd is false after reset")
        Check.ok(reset.restoring == nil, "restoring is nil after reset")
        Check.eq(reset.resumable, false, "resumable is false (no save) after reset")
    }

    /// A default-constructed `PerMatchReset` is the zero state, and two of them are
    /// equal — so both paths start from the same blank slate.
    static func defaultInitProducesAllZeros() {
        let a = PerMatchReset()
        let b = PerMatchReset()
        Check.eq(a, b, "two default PerMatchReset values are equal — one shared boundary")
        // Encoding roundtrip preserves the zero state.
        if let data = try? JSONEncoder().encode(a),
           let decoded = try? JSONDecoder().decode(PerMatchReset.self, from: data)
        {
            Check.eq(decoded, a, "PerMatchReset survives JSON unchanged — the contract is serializable")
        } else {
            Check.ok(false, "PerMatchReset encodes and decodes")
        }
    }

    /// The `Field` enum is the structural link between the descriptor and
    /// `MatchView.applyPerMatchReset()`. Every stored property of `PerMatchReset` must
    /// have a corresponding `Field` case, and vice versa — otherwise the exhaustive
    /// `switch` in `applyPerMatchReset()` could miss a field or carry a stale one.
    ///
    /// This is the executable completeness guarantee: `Mirror` reflection discovers the
    /// struct's actual stored properties and compares them to the enum's cases, so a
    /// property added without a `Field` case (or the reverse) fails this test. Combined
    /// with the compiler's exhaustive-switch check in `applyPerMatchReset()`, adding or
    /// removing a reset field cannot silently leave the application out of sync.
    static func fieldEnumMatchesStructProperties() {
        // Mirror reflection discovers the actual stored properties of the struct.
        let mirror = Mirror(reflecting: PerMatchReset())
        let propertyNames = Set(mirror.children.compactMap { $0.label })

        // The Field enum's raw values are the field names.
        let fieldNames = Set(PerMatchReset.Field.allCases.map { $0.rawValue })

        Check.eq(
            fieldNames, propertyNames,
            "every Field case corresponds to a PerMatchReset stored property and vice versa")
        Check.eq(
            PerMatchReset.Field.allCases.count, propertyNames.count,
            "Field case count matches stored property count — no extras on either side")
        Check.eq(
            PerMatchReset.allFields,
            PerMatchReset.Field.allCases.map { $0.rawValue },
            "allFields is derived from Field.allCases — the string list cannot drift")
    }
}
