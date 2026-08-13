import Foundation

/// The wall-clock countdown toasts and tap tallies `MatchView` carries per match — issue
/// #16, Phase 2.
///
/// **Deliberate deviation from the issue's original sketch**, which drew `MatchSession`
/// living in `UltimateSim` as `director.session`. It stays in `FlightUI` instead: the six
/// countdown types (`TurnoverFlash`, `AssistToast`, `Handoff`, `DefenceCall`, `CutCall`,
/// `RefusedTap`) are display types with formatted strings and, in `RefusedTap`'s case, a
/// screen-space `CGPoint` — moving them across the `UltimateSim`/`FlightUI` boundary
/// (ADR-0002/0008) is out of scope for a phase sized "mechanical once the seam exists."
/// `SimChecks.MatchSession` is the primitive-typed mirror that lets the completeness check
/// run without importing SwiftUI — see its own documentation.
///
/// One value, constructed once, replaces the eleven separate `@State` lines `MatchView`
/// used to carry: `session = MatchSession()` is the whole of the session-clearing step in
/// `applyPerMatchReset()`, where before it was eleven individual assignments split across
/// two `Field` cases each.
struct MatchSession: Equatable {
    /// The turnover being shouted about, while there is one. See `MatchView.advance`.
    var turnoverFlash: TurnoverFlash? = nil

    /// What the aim assist did to the last throw, while it is still worth saying.
    var assistToast: AssistToast? = nil

    /// The control swap being announced, while there is one.
    var handoff: Handoff? = nil

    /// The defender the player has just sent at the disc, while it is worth saying so.
    var defenceCall: DefenceCall? = nil

    /// The cut the player has just called, while it is worth saying so.
    var cutCall: CutCall? = nil

    /// The tap the game would not take, while it is worth saying so.
    var refusedTap: RefusedTap? = nil

    /// How many taps the offence took. Written only by `callCut`, read only by the probe.
    var offenceTaps = 0

    /// How many taps of either half were turned down. Written only by `refuse`, read only
    /// by the probe.
    var refusals = 0

    /// How many of the accepted calls only landed because the empty cone was widened to a
    /// right angle. Written only by `callCut`, read only by the probe.
    var widenedCalls = 0

    /// The reason the last refused tap gave, for the probe. Nil before the first one.
    var lastRefusal: RefusedTap.Reason? = nil

    /// Every refusal of the run, by reason. See the field's own comment on the old
    /// `MatchView` property for what this is for.
    var refusalTally: [String: Int] = [:]
}
