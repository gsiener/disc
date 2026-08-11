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

    /// **THE BOTTOM OF THE CATCH BAND — the number every other module was guessing at.**
    ///
    /// `decide` awards the disc to a body whose fingertips are on it, and the height test
    /// it applies is `groundY + standingFloor` on his feet, `groundY + proneFloor` once he
    /// is already horizontal. Below the standing floor there is no legal catch except a
    /// layout; below the prone floor the disc has hit the turf.
    ///
    /// It is public because it has been rediscovered from the wrong end twice, both times
    /// by a consumer inventing its own number. `AI.predictCatchPoint` shipped with a 0.12 m
    /// floor and sent receivers to meet the disc where only a dive is legal — 80 % of all
    /// bids were for a disc predicted under 0.2 m. Three days later `ThrowSolver` was found
    /// clamping the same quantity against a bare `0.20` connected to nothing, under an aim
    /// plane above the release height, so the descending-crossing test fell through to
    /// ground contact and every flat throw was solved into the receiver's ankles.
    /// `Rules.STANDING_CATCH_FLOOR` is the reference's copy; `SimChecks/CatchBandTests`
    /// asserts that these, the AI's band and the solver's clamp are still one band.
    ///
    /// **These are heights.** `catchReach`, `layoutReach` and the 1.9 m in `catchContest`
    /// are horizontal radii, and `EngineHuman.bidPoint` scanned a flight for `y <= 1.9`
    /// under a comment naming this type as its authority — a contest radius wearing a
    /// height band's clothes. Different quantity, same number of metres.
    public static let standingFloor = 0.20
    public static let proneFloor = 0.02

    /// How close an opponent must be to make a catch a contest, metres — **horizontal**.
    /// Named so it stops being mistaken for a height; see `standingFloor`.
    public static let contestRadius = 1.9
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
        /// Whether the taker was at full stretch — `state == "layout"`, or prone and in
        /// the air. The flag that decided which reach and which floor applied above.
        public let laidOut: Bool
        /// The contest term that priced `difficulty`: `catchContest` capped at two and
        /// scaled by 0.30, so zero means nobody was playing the disc but the taker.
        ///
        /// **These last two are carried out because `Engine.grade` was re-deriving them by
        /// hand.** It had the same body array and it wrote the same two expressions —
        /// which is the shape that produced this project's worst bugs, and it had already
        /// drifted: the grade asked `contestCount`, "did the disc come down in a crowd",
        /// while its own comment claimed it was asking the difficulty term. One of these
        /// is what the decision actually decided, and it is this one.
        public let contest: Double
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
            let bot = b.groundY + (laidOut ? proneFloor : standingFloor)
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
        let contest = catchContest(discPos.x, discPos.z, taker.team, bodies) * 0.30
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
            Result(
                takerId: taker.id, outcome: o, difficulty: difficulty, p: p,
                laidOut: bestLaidOut, contest: contest)
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

    /// How many opponents are actually CONTESTING this catch, as opposed to merely
    /// standing near it.
    ///
    /// `contestCount` below answers a different question — whether the disc came down in a
    /// crowd, which is what decides whether a call is available — and `decide` used it to
    /// price catch difficulty as well. Those are not the same thing, and using one for
    /// both is what made the drop rate what it was: a defender who fails the
    /// `passiveDefenderGap` gate above cannot take the disc, cannot deflect it and does
    /// nothing to the receiver's hands, yet he was charged 0.30 of difficulty, and there
    /// is nearly always one of him. Measured over four fifteen-minute matches, the MEDIAN
    /// drop was a 6 m dump to a stationary, standing receiver with exactly one defender
    /// inside 1.9 m and none of them laid out, completing 89% where the sport completes
    /// better than 98%. So the difficulty term applies the same gate the block does: to
    /// contest a catch you have to be playing the disc.
    static func catchContest(_ x: Double, _ z: Double, _ team: TeamId, _ bodies: [Body])
        -> Double
    {
        var n = 0.0
        for b in bodies where b.team != team {
            let gap = distXZ(b.pos, Vec3d(x, 0, z))
            if gap >= contestRadius { continue }
            if !b.attacking, gap > passiveDefenderGap { continue }
            n += 1
        }
        return Swift.min(2, n)
    }

    /// How many opponents are close enough to make a catch a contest. `Game.ts:1885`.
    static func contestCount(_ x: Double, _ z: Double, _ team: TeamId, _ bodies: [Body]) -> Double {
        var n = 0.0
        for b in bodies where b.team != team {
            if distXZ(b.pos, Vec3d(x, 0, z)) < contestRadius { n += 1 }
        }
        return Swift.min(2, n)
    }

    /// `catchProbability` takes an `AIPlayer`; this makes one carrying the only two
    /// fields it reads.
    private static func scratch(_ b: Body) -> AIPlayer {
        AIPlayer(id: b.id, team: b.team, attr: b.attr, archetype: .cutter, energy: b.energy)
    }
}
