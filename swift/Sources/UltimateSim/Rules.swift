import Foundation

/// ULTIMATE — rules primitives (WFDF 2021 / USAU 11th ed., 7v7 outdoor).
///
/// Everything in this file is a constant or a pure function: no state, no clock, no
/// RNG. That makes it safe to call from a fixed step and trivial to unit test. Ported
/// from `src/sim/Rules.ts`; `GameState.ts` layers the state machine on top there and
/// has no Swift counterpart yet.
///
/// Coordinate frame (matches BRIEF.md): origin at field centre, Y up, +Z toward one
/// endzone, X across.
///
/// ```
///        x = -18.5                          x = +18.5
///   z=+50 +--------------- end line ---------------+
///         |            endzone (18 m)              |
///   z=+32 +---------------- goal line -------------+
///   z=+14 .                  brick                 .
///         |          playing field proper          |
///   z=  0 .                 centre                 .
///   z=-14 .                  brick                 .
///   z=-32 +---------------- goal line -------------+
///         |            endzone (18 m)              |
///   z=-50 +--------------- end line ---------------+
/// ```

// MARK: - types

/// Team index, 0 or 1. Untyped like the reference — the sim never has more than two.
public typealias TeamId = Int
public typealias PlayerId = Int
/// Attacking direction: +1 = scoring in the +Z endzone, -1 = the -Z endzone.
public typealias Dir = Int

public enum Edge: String, Equatable, Decodable, Sendable {
    case sidelinePlusX = "sideline+x"
    case sidelineMinusX = "sideline-x"
    case endlinePlusZ = "endline+z"
    case endlineMinusZ = "endline-z"
}

/// Whether the marker may legally run a stall count this instant.
public enum MarkerStatus: String, Equatable, Decodable, Sendable {
    case legal
    case outOfRange = "out-of-range"
    case discSpace = "disc-space"
    case doubleTeam = "double-team"
    case none
}

// MARK: - field

/// Regulation field, metres. LENGTH = CENTRAL_LENGTH + 2 * ENDZONE_DEPTH.
public struct FieldConstants: Equatable, Decodable, Sendable {
    /// End line to end line.
    public let length: Double
    /// Sideline to sideline.
    public let width: Double
    public let endzoneDepth: Double
    /// "Playing field proper" — goal line to goal line.
    public let centralLength: Double
    /// |z| of either goal line.
    public let goalLine: Double
    /// |z| of either end line.
    public let endLine: Double
    /// |x| of either sideline.
    public let sideline: Double
    /// Brick mark is this far in from the goal line.
    public let brickIn: Double
    /// |z| of either brick mark (on the centre line, x = 0).
    public let brickZ: Double

    enum CodingKeys: String, CodingKey {
        case length = "LENGTH"
        case width = "WIDTH"
        case endzoneDepth = "ENDZONE_DEPTH"
        case centralLength = "CENTRAL_LENGTH"
        case goalLine = "GOAL_LINE"
        case endLine = "END_LINE"
        case sideline = "SIDELINE"
        case brickIn = "BRICK_IN"
        case brickZ = "BRICK_Z"
    }

    public static let standard = FieldConstants(
        length: 100,
        width: 37,
        endzoneDepth: 18,
        centralLength: 64,
        goalLine: 32,
        endLine: 50,
        sideline: 18.5,
        brickIn: 18,
        brickZ: 14
    )
}

public let FIELD = FieldConstants.standard

/// The eight cone positions (four field corners + four goal-line corners).
public let CONES: [Vec3d] = [
    Vec3d(-FIELD.sideline, 0, -FIELD.endLine),
    Vec3d(+FIELD.sideline, 0, -FIELD.endLine),
    Vec3d(-FIELD.sideline, 0, -FIELD.goalLine),
    Vec3d(+FIELD.sideline, 0, -FIELD.goalLine),
    Vec3d(-FIELD.sideline, 0, +FIELD.goalLine),
    Vec3d(+FIELD.sideline, 0, +FIELD.goalLine),
    Vec3d(-FIELD.sideline, 0, +FIELD.endLine),
    Vec3d(+FIELD.sideline, 0, +FIELD.endLine),
]

/// The field is metric; stats are stored in metres. Multiply for a US display.
public let YARDS_PER_METRE = 1.0936133

/// Floating point slack for "elapsed >= n * interval" comparisons.
private let T_EPS = 1e-9
/// Geometric slack, metres.
private let G_EPS = 1e-9

// MARK: - rules

public struct RuleSet: Equatable, Decodable, Sendable {
    /// Count that constitutes a stall-out. Marker counts "stalling one … ten".
    public var stallMax: Int
    /// Seconds between counts.
    public var stallInterval: Double
    /// After a stoppage the count resumes at reached+1, capped here.
    public var stallResumeCap: Int
    /// Marker must be within this of the thrower for the count to run (m).
    public var markerRange: Double
    /// Marker may not come closer than this — one disc diameter (m).
    public var discSpace: Double
    /// Radius of the double-team rule, metres. USAU 16.G is written in feet:
    /// "within ten feet of any pivot of the thrower". 10 ft = 3.048 m.
    public var doubleTeamRange: Double
    /// How far the pivot foot may slip before it is a travel (m).
    public var travelTolerance: Double

    /// Points required to win.
    public var gameTo: Int
    /// Halftime when either team reaches this.
    public var halftimeAt: Int
    /// Margin required to win (1 = normal, 2 = win-by-two variants).
    public var winBy: Int
    /// Absolute ceiling for a win-by-two game.
    public var pointCap: Int

    public var timeoutsPerHalf: Int
    /// Seconds a timeout lasts before play must restart.
    public var timeoutDuration: Double
    /// Only the team in possession may call a timeout during a point.
    public var defenseMayCallTimeout: Bool

    /// Seconds the machine sits in POINT_SCORED before setting up the next pull.
    public var postScoreDelay: Double
    /// Seconds of halftime.
    public var halftimeDuration: Double

    /// Teams change ends at halftime (in addition to the per-point direction flip).
    public var swapEndsAtHalftime: Bool
    /// Gaining possession in your attacking endzone => carry to the goal line.
    public var walkToGoalLineFromAttackingEndzone: Bool
    /// Gaining possession in the endzone you are DEFENDING => walk it out to the
    /// goal line (USAU 12.A.2).
    ///
    /// Unlike 12.B this is a CHOICE the rules give the player: 12.A.1 lets him
    /// establish a pivot on the spot instead, and faking or pausing commits him to
    /// doing exactly that. The sim always takes the walk, because the alternative
    /// is throwing from inside your own endzone, where the mark has a sideline and
    /// an end line helping it and a turnover is very nearly a goal against. Real
    /// teams take the walk for the same reason.
    public var walkOutOfDefendingEndzone: Bool
    /// Emit disc:released / disc:caught / disc:grounded as well as rules events.
    public var emitPhysicsEvents: Bool

    public init(
        stallMax: Int, stallInterval: Double, stallResumeCap: Int, markerRange: Double,
        discSpace: Double, doubleTeamRange: Double, travelTolerance: Double,
        gameTo: Int, halftimeAt: Int, winBy: Int, pointCap: Int,
        timeoutsPerHalf: Int, timeoutDuration: Double, defenseMayCallTimeout: Bool,
        postScoreDelay: Double, halftimeDuration: Double,
        swapEndsAtHalftime: Bool, walkToGoalLineFromAttackingEndzone: Bool,
        walkOutOfDefendingEndzone: Bool, emitPhysicsEvents: Bool
    ) {
        self.stallMax = stallMax
        self.stallInterval = stallInterval
        self.stallResumeCap = stallResumeCap
        self.markerRange = markerRange
        self.discSpace = discSpace
        self.doubleTeamRange = doubleTeamRange
        self.travelTolerance = travelTolerance
        self.gameTo = gameTo
        self.halftimeAt = halftimeAt
        self.winBy = winBy
        self.pointCap = pointCap
        self.timeoutsPerHalf = timeoutsPerHalf
        self.timeoutDuration = timeoutDuration
        self.defenseMayCallTimeout = defenseMayCallTimeout
        self.postScoreDelay = postScoreDelay
        self.halftimeDuration = halftimeDuration
        self.swapEndsAtHalftime = swapEndsAtHalftime
        self.walkToGoalLineFromAttackingEndzone = walkToGoalLineFromAttackingEndzone
        self.walkOutOfDefendingEndzone = walkOutOfDefendingEndzone
        self.emitPhysicsEvents = emitPhysicsEvents
    }
}

public let DEFAULT_RULES = RuleSet(
    stallMax: 10,
    stallInterval: 1,
    stallResumeCap: 9,
    markerRange: 3,
    discSpace: 0.274, // one disc diameter (WFDF 18.1)
    doubleTeamRange: 3.048, // ten feet (USAU 16.G)
    travelTolerance: 0.35,

    gameTo: 15,
    halftimeAt: 8,
    winBy: 1,
    pointCap: 17,

    timeoutsPerHalf: 2,
    timeoutDuration: 70,
    defenseMayCallTimeout: false,

    postScoreDelay: 3,
    halftimeDuration: 300,

    swapEndsAtHalftime: true,
    walkToGoalLineFromAttackingEndzone: true,
    walkOutOfDefendingEndzone: true,
    emitPhysicsEvents: true
)

/// Applies overrides on top of `DEFAULT_RULES`. Swift has no `Partial<T>`, so the
/// override is a mutating closure rather than a merged dictionary — equivalent to the
/// reference's `{ ...DEFAULT_RULES, ...over }` for every case that matters here.
public func makeRules(_ overrides: (inout RuleSet) -> Void = { _ in }) -> RuleSet {
    var rules = DEFAULT_RULES
    overrides(&rules)
    return rules
}

// MARK: - geometry

public func v3(_ x: Double = 0, _ y: Double = 0, _ z: Double = 0) -> Vec3d { Vec3d(x, y, z) }
public func copy(_ p: Vec3d) -> Vec3d { p }

public func distXZ(_ a: Vec3d, _ b: Vec3d) -> Double {
    let dx = a.x - b.x, dz = a.z - b.z
    return (dx * dx + dz * dz).squareRoot()
}

/// Perimeter lines count as in-bounds for the disc; a point strictly beyond is out.
public func isInBounds(_ p: Vec3d) -> Bool {
    abs(p.x) <= FIELD.sideline + G_EPS && abs(p.z) <= FIELD.endLine + G_EPS
}

/// +1 / -1 if inside that endzone, 0 if between the goal lines. Ignores bounds in X.
public func endzoneOf(_ z: Double) -> Int {
    if z >= FIELD.goalLine - G_EPS { return 1 }
    if z <= -FIELD.goalLine + G_EPS { return -1 }
    return 0
}

/// True when p is inside the endzone at the `dir` end and between the sidelines.
public func isInEndzone(_ p: Vec3d, _ dir: Dir) -> Bool {
    isInBounds(p) && p.z * Double(dir) >= FIELD.goalLine - G_EPS
}

/// A goal: an in-bounds catch in the endzone this team attacks.
public func isGoal(_ p: Vec3d, _ attackDir: Dir) -> Bool { isInEndzone(p, attackDir) }

/// z of the goal line at the `dir` end.
public func goalLineZ(_ dir: Dir) -> Double { Double(dir) * FIELD.goalLine }

/// The brick mark a team uses when the pull lands out of bounds: on the centre line,
/// BRICK_IN metres in from the goal line of the endzone they are DEFENDING (WFDF 12.4).
/// For attackDir = +1 that is z = -14.
public func brickMark(_ attackDir: Dir) -> Vec3d {
    Vec3d(0, 0, Double(attackDir) * (FIELD.brickIn - FIELD.goalLine))
}

public func clampToField(_ p: Vec3d) -> Vec3d {
    Vec3d(
        min(FIELD.sideline, max(-FIELD.sideline, p.x)),
        0,
        min(FIELD.endLine, max(-FIELD.endLine, p.z))
    )
}

public struct Crossing: Equatable, Sendable {
    public let point: Vec3d
    public let edge: Edge
    public let t: Double
}

/// Where segment a->b leaves the field rectangle. Returns nil when the segment never
/// exits. Deterministic: ties resolve in sideline-then-endline order.
public func boundaryCrossing(_ a: Vec3d, _ b: Vec3d) -> Crossing? {
    var bestT = Double.infinity
    var bestEdge: Edge? = nil

    func consider(_ num: Double, _ den: Double, _ edge: Edge) {
        if abs(den) < 1e-12 { return }
        let t = num / den
        if t < 0 || t > 1 || t >= bestT { return }
        let x = a.x + (b.x - a.x) * t
        let z = a.z + (b.z - a.z) * t
        if edge == .sidelinePlusX || edge == .sidelineMinusX {
            if abs(z) > FIELD.endLine + 1e-9 { return }
        } else if abs(x) > FIELD.sideline + 1e-9 { return }
        bestT = t
        bestEdge = edge
    }

    consider(FIELD.sideline - a.x, b.x - a.x, .sidelinePlusX)
    consider(-FIELD.sideline - a.x, b.x - a.x, .sidelineMinusX)
    consider(FIELD.endLine - a.z, b.z - a.z, .endlinePlusZ)
    consider(-FIELD.endLine - a.z, b.z - a.z, .endlineMinusZ)

    guard let edge = bestEdge else { return nil }
    return Crossing(
        point: Vec3d(a.x + (b.x - a.x) * bestT, 0, a.z + (b.z - a.z) * bestT),
        edge: edge,
        t: bestT
    )
}

/// Where a team putting the disc into play establishes its pivot.
///
///  - always on or inside the perimeter (out-of-bounds discs come in at the spot
///    where they crossed — WFDF 13.2);
///  - possession gained in the endzone you are ATTACKING, other than by scoring,
///    is carried to the nearest point on that goal line (USAU 12.B). Mandatory:
///    "the player in possession must carry the disc directly to, and put it into
///    play at, the spot on the goal line closest to where the player stopped";
///  - possession gained in the endzone you are DEFENDING may be walked out to
///    the nearest point on that goal line (USAU 12.A.2).
///
/// THE TWO ARE NOT THE SAME RULE and only the first was here. 12.B is compulsory;
/// 12.A is a choice between putting it into play on the spot (12.A.1) and walking it
/// to the line (12.A.2), and the sim always takes the walk — see
/// `walkOutOfDefendingEndzone`.
///
/// Both walk to the goal line of the endzone the disc is IN, which is why the two
/// branches differ only in sign. `x` never moves: the closest point on a goal line is
/// straight out of it.
public func putIntoPlaySpot(_ spot: Vec3d, _ attackDir: Dir, _ rules: RuleSet) -> Vec3d {
    var p = clampToField(spot)
    let zone = p.z * Double(attackDir)
    if rules.walkToGoalLineFromAttackingEndzone && zone >= FIELD.goalLine - G_EPS {
        p.z = goalLineZ(attackDir)
    } else if rules.walkOutOfDefendingEndzone && zone <= -(FIELD.goalLine - G_EPS) {
        p.z = goalLineZ(-attackDir)
    }
    return p
}

// MARK: - stall

/// Stall number for an elapsed marking time. 0 means "no count yet".
public func stallCountFor(_ elapsed: Double, _ rules: RuleSet) -> Int {
    if elapsed <= 0 { return 0 }
    let n = (elapsed / rules.stallInterval + T_EPS).rounded(.down)
    return Int(min(Double(rules.stallMax), max(0, n)))
}

/// Elapsed marking time that corresponds exactly to a given count.
public func stallElapsedFor(_ count: Int, _ rules: RuleSet) -> Double {
    Double(max(0, count)) * rules.stallInterval
}

/// After a stoppage the count restarts at reached+1, capped (WFDF 18.4).
public func resumeStallCount(_ count: Int, _ rules: RuleSet) -> Int {
    min(rules.stallResumeCap, max(0, count) + 1)
}

/// A defender in the double-team check, paired with an id so the offender can be
/// reported back to the caller.
public struct RulesActor: Sendable {
    public let id: PlayerId
    public let pos: Vec3d
    public init(id: PlayerId, pos: Vec3d) {
        self.id = id
        self.pos = pos
    }
}

/// USAU 16.G — DOUBLE TEAM. Returns the offending defender, or nil.
///
///   "a defensive player within ten feet of any pivot of the thrower without also
///    being within ten feet of, and guarding, another offensive player"
///
/// Two halves, and the second is the one that is easy to miss: a second body near the
/// disc is only a double team if he is not there for somebody else. A defender whose
/// own matchup has cut through the area is legitimately close and is not double
/// teaming, which is exactly why the rule is written as an exception rather than as a
/// simple radius.
///
/// The marker himself is never the offender — he is the one player entitled to be
/// there — so he is excluded rather than counted.
public func doubleTeamOffender(
    _ pivot: Vec3d,
    _ markerId: PlayerId?,
    _ defenders: [RulesActor],
    _ offence: [RulesActor],
    _ throwerId: PlayerId?,
    _ rules: RuleSet
) -> PlayerId? {
    let r = rules.doubleTeamRange
    for d in defenders {
        if d.id == markerId { continue }
        if distXZ(d.pos, pivot) > r + G_EPS { continue }
        var excused = false
        for o in offence {
            if o.id == throwerId { continue }
            if distXZ(d.pos, o.pos) <= r + G_EPS {
                excused = true
                break
            }
        }
        if !excused { return d.id }
    }
    return nil
}

/// Marker legality: must be inside markerRange and no closer than discSpace.
public func markerStatus(_ markerPos: Vec3d?, _ throwerPos: Vec3d, _ rules: RuleSet) -> MarkerStatus {
    guard let markerPos else { return .none }
    let d = distXZ(markerPos, throwerPos)
    if d > rules.markerRange { return .outOfRange }
    if d < rules.discSpace { return .discSpace }
    return .legal
}

/// The pivot foot has left its spot by more than the tolerance.
public func isTravel(_ pivot: Vec3d, _ foot: Vec3d, _ rules: RuleSet) -> Bool {
    distXZ(pivot, foot) > rules.travelTolerance
}

// MARK: - score / caps

public enum CapState: String, Equatable, Decodable, Sendable {
    case none
    case soft
    case hard
}

/// The score a team must reach. Soft cap (time cap during a point) sets the target to
/// the current leader + 1; hard cap ends the game on the next goal.
public func effectiveTarget(_ score: (Int, Int), _ rules: RuleSet, _ cap: CapState) -> Int {
    let lead = max(score.0, score.1)
    switch cap {
    case .hard: return lead + 1
    case .soft: return min(rules.pointCap, lead + 1)
    case .none: return rules.gameTo
    }
}

public func isGameOver(_ score: (Int, Int), _ target: Int, _ rules: RuleSet, _ cap: CapState) -> Bool {
    let hi = max(score.0, score.1)
    let margin = abs(score.0 - score.1)
    if hi >= rules.pointCap && margin >= 1 { return true }
    if cap == .hard { return hi >= target && margin >= 1 }
    return hi >= target && margin >= rules.winBy
}

public func flipDir(_ d: Dir) -> Dir { d == 1 ? -1 : 1 }
public func otherTeam(_ t: TeamId) -> TeamId { t == 0 ? 1 : 0 }
