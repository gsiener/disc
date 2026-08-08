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

    /// Regulation 7v7. USAU dimensions.
    public static let full = FieldSpec(
        length: 100, width: 37, endzoneDepth: 18, teamSize: 7, target: 15)

    /// 3v3 in the space of a single endzone, turned so its long axis is the direction of
    /// play. Game to 7 — short enough to finish on a phone, long enough that one lucky
    /// point does not decide it.
    public static let minis = FieldSpec(
        length: 37, width: 18, endzoneDepth: 6, teamSize: 3, target: 7)

    public func inBounds(_ p: Vec3d) -> Bool {
        abs(p.x) <= sideline && abs(p.z) <= endLine
    }

    /// Is `p` inside the endzone that the team attacking in `dir` is aiming at?
    public func inAttackingEndzone(_ p: Vec3d, _ dir: Double) -> Bool {
        inBounds(p) && p.z * dir >= goalLine
    }

    public func clamped(_ p: Vec3d) -> Vec3d {
        Vec3d(
            Swift.min(Swift.max(p.x, -sideline), sideline), p.y,
            Swift.min(Swift.max(p.z, -endLine), endLine))
    }
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

/// How much closer than the receiver a defender must be to take the disc away.
///
/// This is the single number that decides whether the game is playable. At 0 the defence
/// catches everything, because a marker trails on the side the throw comes from. Large
/// enough and the defence never matters. It is a stand-in for everything the real contest
/// involves — who saw it first, who is running onto it, who has position.
///
/// It was introduced in the interim engine and described there as a stand-in that the
/// `AI.ts` and `Contest` ports would remove. That prediction was wrong, and the claim is
/// corrected here rather than left standing: the AI is ported, the interim engine is
/// gone, and `Engine.stepDisc` still resolves every contested catch with this margin. It
/// survives because the ported AI decides *where* a throw goes, not who wins the disc
/// once it arrives. `Move/Contest.swift` is the model that could replace it, and nothing
/// calls it from the play layer yet.
public let BID_EDGE = 0.55
