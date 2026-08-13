import Foundation

/// The retained probe keys, as a `String`-backed enum.
///
/// The producer (`FlightUI/MatchProbe`) emits only keys that are cases of this enum;
/// the consumer (`UltimateUITests/MatchDriver`) resolves every accessor through it.
/// VAL-PROBE-005 requires `Set(emittedKeys) == Set(ProbeKey.allCases.map(\.rawValue))`.
///
/// `flight` and `coach` are deliberately absent — they were producer-only fields with
/// no consumer, removed by issue #21. VAL-PROBE-004 requires the enum to exclude both.
public enum ProbeKey: String, CaseIterable, Sendable {
    // Whose disc, and the coarse phase.
    case poss = "poss"
    case phase = "phase"
    // Whether the controlled body is the holder.
    case mine = "mine"
    // Legality flags.
    case cutOk = "cut.ok"
    case defOk = "def.ok"
    // Recovery seconds, or "-".
    case rec = "rec"
    // Input-tape counters.
    case thrown = "thrown"
    case cuts = "cuts"
    case defends = "defends"
    // Tap-ledger counters.
    case taps = "taps"
    case refused = "refused"
    case wide = "wide"
    // Last refusal reason, or "-".
    case refuse = "refuse"
    // Every refusal by reason, sorted, or "-".
    case tally = "tally"
    // The pitch rectangle, four comma-separated integers.
    case rect = "rect"
    // The last release: grade, hold, type — or "-" before the first throw.
    case grade = "grade"
    case hold = "hold"
    case type = "type"
    // The gesture under the thumb.
    case drag = "drag"
    // How the last drag finished (sticky).
    case dragend = "dragend"
    // The two order plates, as title|detail or "-".
    case cut = "cut"
    case def = "def"
    // The score and match flags.
    case score = "score"
    case over = "over"
    case paused = "paused"
    case sheet = "sheet"
}
