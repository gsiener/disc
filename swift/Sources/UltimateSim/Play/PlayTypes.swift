import Foundation

/// The pieces of the play layer that outlived the interim engine.
///
/// `Play/Match.swift` held these alongside a whole invented game model — its own cutting,
/// marking and throw decisions, written to be deleted once `AI.ts` and `Locomotion.ts`
/// were ported. They are ported, `Engine` replaced that file, and it was deleted. What
/// stayed behind is what `Engine`, the renderer and the replay format all read: the pitch
/// as a value, the tally of how possessions end, and the one contested-catch margin.
///
/// Coordinates follow `Rules.swift`: **+z is downfield**, x is lateral, y is up.

// MARK: - field

/// Pitch geometry as a value rather than a global.
///
/// `Rules.swift` exposes `FIELD` as a module constant because the reference does. That
/// is a fair port and a bad foundation: it hardcodes one field size into 79 call sites,
/// and this game is played on two. Nothing here reads the global.
public struct FieldSpec: Equatable, Sendable {
    /// End line to end line, metres.
    public let length: Double
    /// Sideline to sideline, metres.
    public let width: Double
    public let endzoneDepth: Double
    /// Players per side.
    public let teamSize: Int
    /// Points needed to win.
    public let target: Int

    public var sideline: Double { width / 2 }
    public var endLine: Double { length / 2 }
    public var goalLine: Double { length / 2 - endzoneDepth }

    public init(length: Double, width: Double, endzoneDepth: Double, teamSize: Int, target: Int) {
        self.length = length
        self.width = width
        self.endzoneDepth = endzoneDepth
        self.teamSize = teamSize
        self.target = target
    }

    /// Regulation 7v7. USAU dimensions — `GameFormat.sevens`'s, not a second copy of
    /// them. `RulesTests` asserts `FieldSpec.full.gameFormat == GameFormat.sevens`, so
    /// this and the engine's own preset cannot drift the way `Rules.FIELD` and the
    /// free functions over it did (#45).
    public static let full = FieldSpec(format: .sevens, target: 15)

    /// 3v3 in the space of a single endzone, turned so its long axis is the direction of
    /// play. Game to 7 — short enough to finish on a phone, long enough that one lucky
    /// point does not decide it. `GameFormat.minis`'s pitch, not a second copy.
    public static let minis = FieldSpec(format: .minis, target: 7)

    // `inBounds(_:)`, `inAttackingEndzone(_:_:)` and `clamped(_:)` were here — all three
    // zero callers anywhere, including SimChecks. Deleted (#5). `FieldSpec` itself stays:
    // `sideline`/`endLine` above are read by `PitchScene`, and the type is used as data
    // (length/width/target/teamSize) across `MatchSetup`, `MatchView`, `Engine` and
    // `Replay` — only these three methods on it were dead.
}

// MARK: - how possessions end

/// A tally of how possessions end.
///
/// This exists because "the score stays 0-0" is a symptom with a dozen causes, and
/// guessing between them is how tuning turns into superstition. A count of *why* a
/// possession ended points straight at the one that is wrong: all `stalled` means the
/// thrower will not release, all `outOfBounds` means the aim or the power is off, all
/// `grounded` means the receivers are not getting there.
public struct MatchStats: Equatable, Sendable {
    public var throwsMade = 0
    public var completions = 0
    /// Caught by the other team.
    public var blocks = 0
    /// Landed in bounds with nobody on it.
    public var grounded = 0
    public var outOfBounds = 0
    /// The count ran out with the disc still in someone's hands.
    public var stalled = 0
    public var goals = 0

    public var completionRate: Double {
        throwsMade == 0 ? 0 : Double(completions) / Double(throwsMade)
    }
}

// MARK: - the contested catch
