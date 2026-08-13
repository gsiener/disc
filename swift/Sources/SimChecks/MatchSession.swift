import Foundation

/// A primitive-typed `SimChecks` mirror of `FlightUI.MatchSession` — issue #16, Phase 2.
///
/// `MatchSession` (in `FlightUI`) collects the six wall-clock countdown `@State` fields
/// (`turnoverFlash`, `assistToast`, `handoff`, `defenceCall`, `cutCall`, `refusedTap`) plus
/// the tap/refusal tallies (`offenceTaps`, `refusals`, `widenedCalls`, `lastRefusal`,
/// `refusalTally`) that `MatchView` used to carry as eleven separate `@State` lines. Both
/// the countdowns' formatted strings and `RefusedTap`'s screen-space `CGPoint` are
/// `FlightUI` display concerns (ADR-0002/0008), so the struct itself stays there — this
/// type exists only so the completeness check (`MatchSessionTests`, the same pattern
/// `PerMatchReset` already uses) can run in the terminal `SimChecks` binary without
/// importing SwiftUI.
///
/// Same reasoning as `PerMatchReset`: the *reset values* of all eleven fields are nil / 0 /
/// empty, so the contract is expressible in primitives, and `Field`/`Mirror` here is the
/// structural link that keeps `FlightUI.MatchSession`'s stored properties from drifting out
/// from under it.
public struct MatchSession: Equatable, Sendable, Codable {

    /// Cleared to nil — the prior match's turnover shout is not the new match's.
    public var turnoverFlash: String? = nil

    /// Cleared to nil — what the aim assist did to the last throw does not carry over.
    public var assistToast: String? = nil

    /// Cleared to nil — the control handoff is not the new match's.
    public var handoff: String? = nil

    /// Cleared to nil — the defensive call plate is not the new match's.
    public var defenceCall: String? = nil

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

    public init() {}

    /// Every session field as an exhaustive enum case, with the case name matching the
    /// stored property name — the structural link `MatchSessionTests` verifies by `Mirror`
    /// reflection against `FlightUI.MatchSession`'s own stored properties.
    public enum Field: String, CaseIterable, Sendable {
        // The seven restart-only fields — issue #43's contract, moved here from
        // `PerMatchReset` in Phase 2 because all seven turned out to be session fields.
        case cutCall, refusedTap, offenceTaps, refusals
        case widenedCalls, lastRefusal, refusalTally

        // Already-parallel shared session fields.
        case turnoverFlash, assistToast, handoff, defenceCall

        /// Whether this field is one of the seven `restart(_:)` clears that
        /// `adopt(_:from:setup:)` previously omitted (issue #43).
        public var isRestartOnly: Bool {
            switch self {
            case .cutCall, .refusedTap, .offenceTaps, .refusals,
                 .widenedCalls, .lastRefusal, .refusalTally:
                true
            default:
                false
            }
        }
    }

    /// All session field names — derived from `Field.allCases` so the list cannot drift
    /// from the enum.
    public static let allFields: [String] =
        Field.allCases.map(\.rawValue)

    /// The seven restart-only field names — derived from `Field.isRestartOnly` so the
    /// list cannot drift from the enum. These are the fields `restart(_:)` clears that
    /// `adopt(_:from:setup:)` previously omitted (issue #43).
    public static let restartOnlyFields: [String] =
        Field.allCases.filter(\.isRestartOnly).map(\.rawValue)
}
