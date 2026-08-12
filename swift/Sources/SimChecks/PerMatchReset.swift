import Foundation

/// The per-match presentation and interaction state that both `restart(_:)` and
/// `adopt(_:from:setup:)` must reset to zero before establishing a new match.
///
/// This value type is the **single shared reset boundary** (issue #43). Both entry
/// paths construct one and apply its fields, so a new presentation field that is not
/// listed here is a field that can silently diverge between the two paths — exactly
/// the bug `adopt` had when it omitted the seven fields `restart` was clearing.
///
/// The type lives in `SimChecks` rather than `FlightUI` so the focused test seam
/// (`PerMatchResetTests`) can verify its completeness without importing SwiftUI. The
/// actual `@State` properties it mirrors are typed in `FlightUI` (`CutCall?`,
/// `RefusedTap?`, …), but their *reset values* are all nil / 0 / empty / false, which
/// is why the contract can be expressed in primitives here.
///
/// **Intentional differences between the two paths are not part of this boundary:**
/// `restart` creates a fresh engine and lands unpaused; `adopt` uses the replayed
/// engine, the saved seed / input tape / tick count, and lands paused. Those are
/// identity and landing semantics, not presentation state, and they are set by each
/// caller after `applyPerMatchReset()` has run.
public struct PerMatchReset: Equatable, Sendable, Codable {

    // MARK: - The seven restart-only presentation fields
    //
    // These are the fields `restart(_:)` has always cleared and `adopt(_:from:setup:)`
    // previously omitted — issue #43. A restored match that carried the prior match's
    // cut call, refusal message, and tap ledger was not the match the player put down.

    /// Cleared to nil — the prior match's cut order is not the new match's.
    public var cutCall: String? = nil

    /// Cleared to nil. **No direct probe key** — evidenced indirectly via `refusals=0`,
    /// `lastRefusal="-"`, and the absence of `hud.refused`, plus the Swift reset test.
    public var refusedTap: String? = nil

    /// Cleared to 0 — the tap ledger starts empty.
    public var offenceTaps: Int = 0

    /// Cleared to 0 — the refusal counter starts empty.
    public var refusals: Int = 0

    /// Cleared to 0 — the widened-call counter starts empty.
    public var widenedCalls: Int = 0

    /// Cleared to nil — no refusal reason carries over.
    public var lastRefusal: String? = nil

    /// Cleared to empty — the per-reason tally starts fresh.
    public var refusalTally: [String: Int] = [:]

    // MARK: - Already-parallel shared fields
    //
    // These were already reset by both paths before #43; they are listed here so the
    // shared boundary is complete and a new field cannot be added to one path without
    // adding it to the other.

    /// Cleared to nil — the defensive call plate is not the new match's.
    public var defenceCall: String? = nil

    /// Cleared to nil — the turnover callout is not the new match's.
    public var turnoverFlash: String? = nil

    /// Cleared to nil — the assist read-out is not the new match's.
    public var assistToast: String? = nil

    /// Cleared to nil — the control handoff is not the new match's.
    public var handoff: String? = nil

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

    /// The seven restart-only field names — the fields `restart(_:)` clears that
    /// `adopt(_:from:setup:)` previously omitted (issue #43).
    public static let restartOnlyFields: [String] = [
        "cutCall", "refusedTap", "offenceTaps", "refusals",
        "widenedCalls", "lastRefusal", "refusalTally",
    ]

    /// All shared reset field names — the complete boundary both paths must cover.
    public static let allFields: [String] = [
        "cutCall", "refusedTap", "offenceTaps", "refusals",
        "widenedCalls", "lastRefusal", "refusalTally",
        "defenceCall", "turnoverFlash", "assistToast", "handoff",
        "drag", "sceneInvalidated", "clockReset", "lastControlled",
        "clearedAtEnd", "restoring", "resumable",
    ]
}
