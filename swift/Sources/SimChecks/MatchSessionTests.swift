import Foundation

/// Tests the session half of the shared per-match reset boundary — issue #43, split from
/// `PerMatchResetTests` by issue #16 Phase 2.
///
/// `restart(_:)` and `adopt(_:from:setup:)` must both apply the same reset to the six
/// wall-clock countdown toasts and the tap/refusal tallies. This suite verifies the
/// `MatchSession` value type that defines that boundary is complete and has the correct
/// zero values, without importing SwiftUI — the same seam `PerMatchResetTests` already
/// used before this split, now pointed at `MatchSession` instead.
///
/// The test seam is the type itself: a field that is not in `MatchSession.allFields` is a
/// field that can silently drift between `restart` and `adopt` — the seven fields `adopt`
/// was missing were exactly the ones now covered here.
enum MatchSessionTests {

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
            MatchSession.restartOnlyFields.count, 7,
            "exactly seven restart-only fields (issue #43)")
        let expected = Set([
            "cutCall", "refusedTap", "offenceTaps", "refusals",
            "widenedCalls", "lastRefusal", "refusalTally",
        ])
        Check.eq(
            Set(MatchSession.restartOnlyFields), expected,
            "the seven restart-only field names match the contract")
        // Every restart-only field is also in the full boundary.
        for field in MatchSession.restartOnlyFields {
            Check.ok(
                MatchSession.allFields.contains(field),
                "\(field) is in the shared session boundary (allFields)")
        }
    }

    /// The session boundary covers every required field — the seven restart-only fields
    /// plus the already-parallel shared fields.
    static func sharedBoundaryIsComplete() {
        // The already-parallel shared fields that must be in the boundary.
        let sharedFields = Set(["defenceCall", "turnoverFlash", "assistToast", "handoff"])
        for field in sharedFields {
            Check.ok(
                MatchSession.allFields.contains(field),
                "\(field) is in the shared session boundary — already-parallel fields cannot drift")
        }
        // Seven restart-only + four already-parallel = eleven total.
        Check.eq(
            MatchSession.allFields.count, 11,
            "the shared session boundary covers 11 fields (7 restart-only + 4 already-parallel)")
        // No duplicates.
        Check.eq(
            Set(MatchSession.allFields).count, MatchSession.allFields.count,
            "no duplicate field names in allFields")
    }

    /// The zero values are all nil / 0 / empty as the contract requires.
    static func zeroValuesAreCorrect() {
        let session = MatchSession()

        // The seven restart-only fields.
        Check.ok(session.cutCall == nil, "cutCall is nil after reset")
        Check.ok(session.refusedTap == nil, "refusedTap is nil after reset (no direct probe key)")
        Check.eq(session.offenceTaps, 0, "offenceTaps is 0 after reset")
        Check.eq(session.refusals, 0, "refusals is 0 after reset")
        Check.eq(session.widenedCalls, 0, "widenedCalls is 0 after reset")
        Check.ok(session.lastRefusal == nil, "lastRefusal is nil after reset")
        Check.ok(session.refusalTally.isEmpty, "refusalTally is empty after reset")

        // Already-parallel shared fields.
        Check.ok(session.defenceCall == nil, "defenceCall is nil after reset")
        Check.ok(session.turnoverFlash == nil, "turnoverFlash is nil after reset")
        Check.ok(session.assistToast == nil, "assistToast is nil after reset")
        Check.ok(session.handoff == nil, "handoff is nil after reset")
    }

    /// A default-constructed `MatchSession` is the zero state, and two of them are equal —
    /// so both paths start from the same blank slate.
    static func defaultInitProducesAllZeros() {
        let a = MatchSession()
        let b = MatchSession()
        Check.eq(a, b, "two default MatchSession values are equal — one shared boundary")
        // Encoding roundtrip preserves the zero state.
        if let data = try? JSONEncoder().encode(a),
           let decoded = try? JSONDecoder().decode(MatchSession.self, from: data)
        {
            Check.eq(decoded, a, "MatchSession survives JSON unchanged — the contract is serializable")
        } else {
            Check.ok(false, "MatchSession encodes and decodes")
        }
    }

    /// The `Field` enum is the structural link between this descriptor and its own stored
    /// properties (the same pattern `PerMatchResetTests` uses for `PerMatchReset`). Every
    /// stored property must have a corresponding `Field` case, and vice versa — otherwise
    /// `Field.allCases` could silently omit a field this type actually carries.
    ///
    /// This is the executable completeness guarantee: `Mirror` reflection discovers the
    /// struct's actual stored properties and compares them to the enum's cases, so a
    /// property added without a `Field` case (or the reverse) fails this test.
    static func fieldEnumMatchesStructProperties() {
        // Mirror reflection discovers the actual stored properties of the struct.
        let mirror = Mirror(reflecting: MatchSession())
        let propertyNames = Set(mirror.children.compactMap { $0.label })

        // The Field enum's raw values are the field names.
        let fieldNames = Set(MatchSession.Field.allCases.map { $0.rawValue })

        Check.eq(
            fieldNames, propertyNames,
            "every Field case corresponds to a MatchSession stored property and vice versa")
        Check.eq(
            MatchSession.Field.allCases.count, propertyNames.count,
            "Field case count matches stored property count — no extras on either side")
        Check.eq(
            MatchSession.allFields,
            MatchSession.Field.allCases.map { $0.rawValue },
            "allFields is derived from Field.allCases — the string list cannot drift")
        Check.eq(
            MatchSession.restartOnlyFields,
            MatchSession.Field.allCases.filter(\.isRestartOnly).map { $0.rawValue },
            "restartOnlyFields is derived from Field.isRestartOnly — the subset cannot drift")
        // Every restart-only field is also in the full boundary.
        for field in MatchSession.restartOnlyFields {
            Check.ok(
                MatchSession.allFields.contains(field),
                "\(field) is in the shared session boundary (allFields)")
        }
    }
}
