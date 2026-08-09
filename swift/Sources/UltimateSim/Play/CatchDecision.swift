import Foundation

/// The catch resolved as a pure decision, so it can be differed against the reference.
///
/// `Engine.tryCatch` is a port of `Game.ts:tryCatch`, and mutation testing showed it was
/// the largest surface the checks could not see: the defender attacking gate, the catch
/// roll itself, the `p * 0.55` interception split and `catchReach` could each be broken
/// with 2.2 million assertions still green — every one of them a component golden the
/// integration layer never touches. The throw solver got a differential fixture for the
/// same reason, and the recipe requires a seam: a function of plain values, no
/// `Locomotion`, no `GameState`, no RNG, that a TypeScript transcription can sweep.
///
/// This is that seam. `Engine.tryCatch` builds the bodies and the roll and applies the
/// outcome; everything that *decides* lives here, and every constant is the reference's
/// (`Game.ts:1798-1892`).
public enum CatchDecision {

    /// XZ radius inside which a standing body can play the disc, metres.
    public static let catchReach = 0.82
    /// And at full stretch. `Game.ts:LAYOUT_REACH`.
    public static let layoutReach = 1.55
    /// A defender who has not attacked the disc must be this close — a body's width,
    /// not an arm's reach plus a window.
    public static let passiveDefenderGap = 0.55
    /// A defence's roll is scaled by this, because a D is harder than a catch.
    public static let defenceScale = 0.62
    /// And an interception is the harder half of that again.
    public static let interceptionSplit = 0.55
    /// Below this difficulty a failed offensive roll is charged as a drop; at full
    /// stretch a miss is just a disc that keeps flying.
    public static let dropThreshold = 0.85
    /// What a full-extension bid costs, scaled across the reach band.
    ///
    /// **This was a flat +0.55 the moment a body left the ground**, which priced a disc
    /// 0.83 m away — a fingertip past a standing catch — identically to one at 1.54 m, a
    /// genuine full-extension bid. Those are not the same catch, and in a match where 42%
    /// of receptions are layouts the difference is most of the drop rate. Scaled across
    /// the band and widened to 0.90, so the top of it is HARDER than it was: the
    /// near-layout falls from 0.55 to ~0.05 and the full-stretch grab rises to 0.90.
    public static let layoutStretch = 0.90

    /// A body as the catch decision needs it — locomotion already read off.
    public struct Body {
        public let id: Int
        public let team: TeamId
        /// The XZ position the reference measures gaps from.
        public let pos: Vec3d
        /// `Locomotion` state name. Only "fall", "recovery" and "layout" are read.
        public let state: String
        public let prone: Bool
        public let airborne: Bool
        public let groundY: Double
        public let hipHeight: Double
        /// `loco.reachAt(lp, t: 0)` — the ceiling of what this body covers right now,
        /// passed in as a number so the fixture does not need the jump model.
        public let reachTop: Double
        /// Whether this tick's intent attacked the disc (`bid`, `jump` or `catch`).
        public let attacking: Bool
        public let attr: AIAttributes
        public let energy: Double

        public init(
            id: Int, team: TeamId, pos: Vec3d, state: String, prone: Bool, airborne: Bool,
            groundY: Double, hipHeight: Double, reachTop: Double, attacking: Bool,
            attr: AIAttributes, energy: Double
        ) {
            self.id = id
            self.team = team
            self.pos = pos
            self.state = state
            self.prone = prone
            self.airborne = airborne
            self.groundY = groundY
            self.hipHeight = hipHeight
            self.reachTop = reachTop
            self.attacking = attacking
            self.attr = attr
            self.energy = energy
        }
    }

    /// What the roll decided. The engine maps these onto `GameState` calls; the fixture
    /// compares them by name.
    public enum Outcome: String {
        /// Somebody could have played it and rolled through — the disc keeps flying.
        case none
        case catchDisc = "catch"
        case drop
        /// A defender caught it clean.
        case interception
        /// A defender got a hand to it.
        case block
        /// The receiving team caught the pull.
        case pullCatch = "pull-catch"
        /// The receiving team put the pull down.
        case pullDrop = "pull-drop"
        /// The pulling team touched their own pull — WFDF 12.5, disc to the receivers.
        case pullTouch = "pull-touch"
    }

    public struct Result {
        public let takerId: Int
        public let outcome: Outcome
        /// The difficulty the taker faced, and the probability they were given — recorded
        /// so the fixture pins the numbers and not just the branch.
        public let difficulty: Double
        public let p: Double
    }

    /// The decision. `nil` means nobody was in a position to play the disc at all.
    ///
    /// `bodies` must be the whole roster, not just candidates: a body mid-fall cannot
    /// take the disc but still counts toward the contest, exactly as the reference's
    /// `contestCount` runs over the full roster.
    ///
    /// `roll` is a closure, not a number, because the reference draws from the match RNG
    /// only after a taker is found — a plain parameter would consume a draw on every
    /// no-taker tick and silently desync the whole match stream.
    public static func decide(
        discPos: Vec3d, discVel: Vec3d, pull: Bool, offence: TeamId?,
        bodies: [Body], roll: () -> Double
    ) -> Result? {
        var best: Body?
        var bestScore = Double.infinity
        var bestHigh = 0.0
        var bestLaidOut = false
        var bestReach = 0.0

        for b in bodies {
            if b.state == "fall" || b.state == "recovery" { continue }
            let laidOut = b.state == "layout" || (b.prone && b.airborne)
            let gap = distXZ(b.pos, discPos)
            guard gap <= (laidOut ? layoutReach : catchReach) else { continue }
            let top = b.reachTop + 0.16
            let bot = b.groundY + (laidOut ? 0.02 : 0.20)
            if discPos.y > top || discPos.y < bot { continue }
            if b.team != offence {
                if !b.attacking, gap > passiveDefenderGap { continue }
            }
            let high = clamp((discPos.y - (b.groundY + b.hipHeight + 0.35)) / 0.9, 0, 1)
            let score = gap + high * 0.4 + (b.team == offence ? 0 : 0.25)
            if score < bestScore {
                bestScore = score
                best = b
                bestHigh = high
                bestLaidOut = laidOut
                bestReach = gap
            }
        }
        guard let taker = best else { return nil }

        let speed = discVel.length
        let contest = contestCount(discPos.x, discPos.z, taker.team, bodies) * 0.30
        let stretch =
            bestLaidOut
            ? layoutStretch * clamp((bestReach - catchReach) / (layoutReach - catchReach), 0, 1)
            : 0
        let difficulty = clamp(
            0.12 + bestHigh * 0.55 + stretch + contest
                + clamp((speed - 17) / 22, 0, 0.45),
            0, 1.7)
        var p = catchProbability(scratch(taker), difficulty)
        if taker.team != offence { p *= defenceScale }
        let r = roll()

        func result(_ o: Outcome) -> Result {
            Result(takerId: taker.id, outcome: o, difficulty: difficulty, p: p)
        }

        if taker.team != offence {
            if pull {
                return result(r < p ? .pullTouch : .none)
            }
            if r < p * interceptionSplit { return result(.interception) }
            if r < p { return result(.block) }
            return result(.none)
        }
        if r < p { return result(pull ? .pullCatch : .catchDisc) }
        if difficulty < dropThreshold { return result(pull ? .pullDrop : .drop) }
        return result(.none)
    }

    /// How many opponents are close enough to make a catch a contest. `Game.ts:1885`.
    static func contestCount(_ x: Double, _ z: Double, _ team: TeamId, _ bodies: [Body]) -> Double {
        var n = 0.0
        for b in bodies where b.team != team {
            if distXZ(b.pos, Vec3d(x, 0, z)) < 1.9 { n += 1 }
        }
        return Swift.min(2, n)
    }

    /// `catchProbability` takes an `AIPlayer`; this makes one carrying the only two
    /// fields it reads.
    private static func scratch(_ b: Body) -> AIPlayer {
        AIPlayer(id: b.id, team: b.team, attr: b.attr, archetype: .cutter, energy: b.energy)
    }
}
