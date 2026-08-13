import Foundation

/// Tests the shared per-match reset boundary — issue #43.
///
/// `restart(_:)` and `adopt(_:from:setup:)` must both apply the same reset to all
/// per-match presentation and interaction state. This suite verifies the
/// `PerMatchReset` value type that defines that boundary is complete and has the
/// correct zero values, without importing SwiftUI.
///
/// The test seam is the type itself: a field that is not in `PerMatchReset.allFields`
/// is a field that can silently drift between the two paths, and the seven fields
/// `adopt` was missing are the proof that drift happens.
enum PerMatchResetTests {

    static func run() throws {
        restartOnlyFieldsAreExact()
        sharedBoundaryIsComplete()
        zeroValuesAreCorrect()
        defaultInitProducesAllZeros()
        fieldEnumMatchesStructProperties()
    }

    /// Exactly seven restart-only fields, matching the issue #43 contract.
    static func restartOnlyFieldsAreExact() {
        Check.eq(
            PerMatchReset.restartOnlyFields.count, 7,
            "exactly seven restart-only fields (issue #43)")
        let expected = Set([
            "cutCall", "refusedTap", "offenceTaps", "refusals",
            "widenedCalls", "lastRefusal", "refusalTally",
        ])
        Check.eq(
            Set(PerMatchReset.restartOnlyFields), expected,
            "the seven restart-only field names match the contract")
        // Every restart-only field is also in the full boundary.
        for field in PerMatchReset.restartOnlyFields {
            Check.ok(
                PerMatchReset.allFields.contains(field),
                "\(field) is in the shared boundary (allFields)")
        }
    }

    /// The shared reset boundary covers every required field — the seven restart-only
    /// fields plus the already-parallel shared fields.
    static func sharedBoundaryIsComplete() {
        // The already-parallel shared fields that must be in the boundary.
        let sharedFields = Set([
            "defenceCall", "turnoverFlash", "assistToast", "handoff",
            "drag", "sceneInvalidated", "clockReset", "lastControlled",
            "clearedAtEnd", "restoring", "resumable",
        ])
        for field in sharedFields {
            Check.ok(
                PerMatchReset.allFields.contains(field),
                "\(field) is in the shared boundary — already-parallel fields cannot drift")
        }
        // Seven restart-only + eleven already-parallel = eighteen total.
        Check.eq(
            PerMatchReset.allFields.count, 18,
            "the shared boundary covers 18 fields (7 restart-only + 11 already-parallel)")
        // No duplicates.
        Check.eq(
            Set(PerMatchReset.allFields).count, PerMatchReset.allFields.count,
            "no duplicate field names in allFields")
    }

    /// The zero values are all nil / 0 / empty / false as the contract requires.
    static func zeroValuesAreCorrect() {
        let reset = PerMatchReset()

        // The seven restart-only fields.
        Check.ok(reset.cutCall == nil, "cutCall is nil after reset")
        Check.ok(reset.refusedTap == nil, "refusedTap is nil after reset (no direct probe key)")
        Check.eq(reset.offenceTaps, 0, "offenceTaps is 0 after reset")
        Check.eq(reset.refusals, 0, "refusals is 0 after reset")
        Check.eq(reset.widenedCalls, 0, "widenedCalls is 0 after reset")
        Check.ok(reset.lastRefusal == nil, "lastRefusal is nil after reset")
        Check.ok(reset.refusalTally.isEmpty, "refusalTally is empty after reset")

        // Already-parallel shared fields.
        Check.ok(reset.defenceCall == nil, "defenceCall is nil after reset")
        Check.ok(reset.turnoverFlash == nil, "turnoverFlash is nil after reset")
        Check.ok(reset.assistToast == nil, "assistToast is nil after reset")
        Check.ok(reset.handoff == nil, "handoff is nil after reset")
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
        Check.eq(
            PerMatchReset.restartOnlyFields,
            PerMatchReset.Field.allCases.filter(\.isRestartOnly).map { $0.rawValue },
            "restartOnlyFields is derived from Field.isRestartOnly — the subset cannot drift")
        // Every restart-only field is also in the full boundary.
        for field in PerMatchReset.restartOnlyFields {
            Check.ok(
                PerMatchReset.allFields.contains(field),
                "\(field) is in the shared boundary (allFields)")
        }
    }
}
