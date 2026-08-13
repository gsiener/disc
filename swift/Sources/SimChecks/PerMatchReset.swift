import Foundation

/// The per-match state that both `restart(_:)` and `adopt(_:from:setup:)` must reset to
/// zero before establishing a new match, minus the session fields — issue #43, slimmed by
/// issue #16 Phase 2.
///
/// **What moved out.** The eleven fields that are the six wall-clock countdown toasts
/// (`turnoverFlash`, `assistToast`, `handoff`, `defenceCall`, `cutCall`, `refusedTap`) plus
/// the tap/refusal tallies (`offenceTaps`, `refusals`, `widenedCalls`, `lastRefusal`,
/// `refusalTally`) are now `MatchSession`'s fields — one value constructed once by both
/// reset paths, instead of eleven of the eighteen cases in this type's `Field` switch. See
/// `MatchSession` and `MatchSessionTests`.
///
/// **What is left is everything that is NOT a session field**: the seven fields below.
/// This value type is still the **single shared reset boundary** (issue #43) for them —
/// both `restart` and `adopt` construct one and apply its fields, so a new non-session
/// per-match field that is not listed here is a field that can silently diverge between
/// the two paths, exactly the bug `adopt` had when it omitted the seven restart-only
/// fields `restart` was clearing (all seven of which happened to be session fields, and now
/// live in `MatchSession` instead — see `MatchSessionTests.restartOnlyFieldsAreExact` for
/// where that contract now lives).
///
/// The type lives in `SimChecks` rather than `FlightUI` so the focused test seam
/// (`PerMatchResetTests`) can verify its completeness without importing SwiftUI. The actual
/// `@State` properties it mirrors are typed in `FlightUI`, but their *reset values* are all
/// nil / 0 / empty / false / true, which is why the contract can be expressed in primitives
/// here.
///
/// **Intentional differences between the two paths are not part of this boundary:**
/// `restart` creates a fresh engine and lands unpaused; `adopt` uses the replayed engine,
/// the saved seed / input tape / tick count, and lands paused. Those are identity and
/// landing semantics, not presentation state, and they are set by each caller after
/// `applyPerMatchReset()` has run.
public struct PerMatchReset: Equatable, Sendable, Codable {

    /// Cleared to nil via `cancelDrag()` — no drag in progress.
    public var drag: String? = nil

    /// Performed via `scene.invalidate()` — render caches are stale.
    public var sceneInvalidated: Bool = true

    /// Performed via `clock.reset()` — the frame clock starts fresh.
    public var clockReset: Bool = true

    /// Set to the new engine's `controlled` value by the caller after reset.
    public var lastControlled: Int? = nil

    /// Cleared to false — the new match has not finished.
    public var clearedAtEnd: Bool = false

    /// Cleared to nil — no restore is in progress.
    public var restoring: Double? = nil

    /// Cleared to false (nil in the view) — no resumable save after reset.
    public var resumable: Bool = false

    public init() {}

    // MARK: - Exhaustive field enumeration

    /// Every reset field as an exhaustive enum case, with the case name matching the
    /// stored property name. This enum is the structural link between the descriptor
    /// and `MatchView.applyPerMatchReset()`: the application method switches over
    /// `Field.allCases`, and Swift's exhaustive-switch check makes adding a `Field`
    /// case without handling it a **compile error**, not a silent drift.
    ///
    /// `PerMatchResetTests.fieldEnumMatchesStructProperties` uses `Mirror` reflection to
    /// verify that every `Field` case corresponds to a stored property and vice versa,
    /// closing the last gap: a property added to the struct without a `Field` case (or
    /// the reverse) fails the test.
    public enum Field: String, CaseIterable, Sendable {
        case drag, sceneInvalidated, clockReset, lastControlled
        case clearedAtEnd, restoring, resumable
    }

    /// All shared reset field names — derived from `Field.allCases` so the list cannot
    /// drift from the enum. The complete non-session boundary both paths must cover.
    public static let allFields: [String] =
        Field.allCases.map(\.rawValue)
}
