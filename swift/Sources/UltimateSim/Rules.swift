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

    /// THE MATCH CLOCK, and it is off by default.
    ///
    /// Timed play is the other half of the caps `applySoftCap` / `applyHardCap`
    /// already implement and nothing ever called. Seconds of `GameState.clock` at
    /// which each lands; 0 means that cap never fires, so a game with both at 0 —
    /// every game the sim has ever played — is untimed and behaves exactly as it
    /// always has.
    ///
    /// The two are independent, which is how the sport writes them: the soft cap
    /// moves the target to the leader + 1 and play carries on, and the hard cap
    /// makes the point in progress the last one. Setting only `hardCapAt` is a
    /// legal (if brutal) format.
    public var softCapAt: Double
    public var hardCapAt: Double

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
        softCapAt: Double = 0, hardCapAt: Double = 0,
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
        self.softCapAt = softCapAt
        self.hardCapAt = hardCapAt
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
    softCapAt: 0,
    hardCapAt: 0,

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

// MARK: - contact and the calling

/// SELF-OFFICIATION — the detection half.
///
/// `GameState.makeCall` / `resolveCall` have always known what to DO with a foul, a
/// pick or a strip. Nothing ever made one, because nothing in the sim looked at two
/// bodies and decided that what happened between them was worth stopping play for.
/// These are that decision, and they are here rather than in the engine for the same
/// reason `isTravel` is: they are pure geometry over two bodies, and the engine's job
/// is only to supply the bodies and to live with the answer.
///
/// THE DESIGN CONSTRAINT IS RARITY, and it is not a threshold — it is what gets
/// measured. A real 7v7 game has one to three calls in it, and the honest way to land
/// there is to ask the question a player asks, which is never "did we touch" but "did
/// that touch change what was about to happen". So:
///
///   - a marking foul is contact the MARKER drove into a thrower who is standing on
///     his pivot and cannot move out of the way;
///   - a pick is an obstruction that COST the defender — he lost speed and his matchup
///     gained ground over the same moment;
///   - a receiving foul / strip is contact at the instant a catch failed.
///
/// Measured over three fifteen-minute 7v7 matches, bare body contact between the mark
/// and the thrower happens 4-8 times and a defender brushes a body that is not his
/// matchup 200-280 times. Neither of those is a call. The predicates below cut them to
/// roughly one and two respectively, which is the sport's own number rather than a
/// tuned one.
///
/// Ported from `src/sim/Rules.ts`.

/// A body as the contact model needs it.
public protocol ContactBody {
    var id: PlayerId { get }
    var pos: Vec3d { get }
    var vel: Vec3d { get }
    /// Shoulder half-width, the same radius the hard contact tier separates on.
    var radius: Double { get }
}

public struct Contact: Equatable, Sendable {
    /// Centre-to-centre distance in XZ, metres.
    public var dist: Double
    /// True when the two bodies overlap.
    public var touching: Bool
    /// Closing speed of whichever body was closing harder, m/s. The same quantity
    /// `Locomotion.contactReaction` calls `impact` — a body standing still while
    /// somebody runs into it registers the runner's speed, not zero.
    public var impact: Double
    /// Who was closing harder: the one who ran into the other.
    public var aggressorId: PlayerId
}

public func contactBetween(_ a: some ContactBody, _ b: some ContactBody) -> Contact {
    let dx = b.pos.x - a.pos.x
    let dz = b.pos.z - a.pos.z
    let d = (dx * dx + dz * dz).squareRoot()
    let touching = d < a.radius + b.radius
    if d < 1e-6 {
        return Contact(dist: d, touching: touching, impact: 0, aggressorId: a.id)
    }
    let nx = dx / d, nz = dz / d
    let closeA = a.vel.x * nx + a.vel.z * nz
    let closeB = -(b.vel.x * nx + b.vel.z * nz)
    return Contact(
        dist: d, touching: touching,
        impact: Swift.max(closeA, closeB),
        aggressorId: closeA >= closeB ? a.id : b.id)
}

/// Closing speed at which contact on the thrower stops being incidental, m/s.
///
/// The thrower on his pivot is immovable — see `Locomotion.invMass` — so a mark that
/// walks into him is not resolved by physics at all; it is resolved by this. 0.8 m/s
/// is a step taken into a stationary man rather than a lean.
public let MARK_FOUL_IMPACT = 0.8

/// Speed a defender must lose to an obstruction before it is worth calling (m/s), and
/// the ground his matchup must gain over the same moment (m).
///
/// Both, not either. A defender who slows behind a body but stays with his man was not
/// picked, and one whose man pulls away while he is running free was simply beaten.
public let PICK_SPEED_LOSS = 0.9
public let PICK_GAP_GAIN = 0.25

/// Closing speed at which contact through a catch attempt is a foul, m/s.
public let CATCH_FOUL_IMPACT = 1.0

/// WFDF 17.1 / USAU 15.B — the marker may not make contact with the thrower.
///
/// Returns the impact when there is a call, 0 when there is not. Gated on the marker
/// being the one closing: a thrower who backs into his mark has fouled nobody, and on
/// his pivot he can hardly do even that.
public func markingFoulImpact(_ marker: some ContactBody, _ thrower: some ContactBody) -> Double {
    let c = contactBetween(marker, thrower)
    if !c.touching { return 0 }
    if c.aggressorId != marker.id { return 0 }
    return c.impact >= MARK_FOUL_IMPACT ? c.impact : 0
}

/// THE PICK — "the game's most common call", and the one that needs a cost.
///
/// A defender is obstructed when an offensive body who is neither the thrower nor his
/// own matchup is inside him. That alone is worth nothing: it happens two hundred times
/// a match and almost none of it matters. What makes it a call is that the obstruction
/// took something — `lostSpeed` is what he was doing when he ran into the body minus
/// what he is doing now, `gainedGap` is how much further away his matchup is than when
/// it started.
public func pickIsWorthCalling(lostSpeed: Double, gainedGap: Double) -> Bool {
    lostSpeed >= PICK_SPEED_LOSS && gainedGap >= PICK_GAP_GAIN
}

/// Who obstructed this defender, if anybody. `offence` should exclude nobody — the
/// thrower and the defender's own matchup are filtered here so the caller cannot
/// forget to.
public func obstructionOf<D: ContactBody, O: ContactBody>(
    _ defender: D,
    _ offence: [O],
    _ throwerId: PlayerId?,
    _ matchupId: PlayerId?
) -> PlayerId? {
    for o in offence {
        if o.id == throwerId || o.id == matchupId { continue }
        if contactBetween(defender, o).touching { return o.id }
    }
    return nil
}

/// How long after a hit a failed catch can still be blamed on it, seconds.
///
/// The contact and the incompletion are not the same tick and cannot be. The hard
/// contact resolver runs during locomotion and has already spent the closing velocity by
/// the time the disc is stepped — measured over three matches, every defender still
/// inside a receiver at the moment of a drop had a *post-impulse* closing speed of
/// 0.0-0.5 m/s, because the impulse is exactly what removed it. Deriving the foul from
/// the geometry at the catch therefore finds nothing, ever, and the honest reading of
/// that is not "there are no receiving fouls" but "you are asking the wrong tick".
///
/// So the call is made from `Locomotion`'s own contact event, which carries the impact
/// BEFORE the impulse and the id of whoever was closing harder, and this is how long
/// that event stays live. A fifth of a second is the width of a catch.
public let CATCH_CONTACT_WINDOW = 0.2

/// What a defender's contact at the catch is.
public enum CatchContactKind: String, Equatable, Sendable {
    case foul
    case strip
}

/// WHAT A DEFENDER'S CONTACT AT THE CATCH IS.
///
///   - he was playing the disc and hit the body anyway => a receiving foul, and the
///     pass does not stand;
///   - he was not playing the disc at all and the receiver put it down => a STRIP: he
///     went through the man to get to a disc that was already caught.
///
/// Nil when the contact is too soft to have decided anything. `impact` is the closing
/// speed `Locomotion` measured at the collision, not a re-derivation.
public func catchContactCall(
    impact: Double,
    defenderPlayedDisc: Bool,
    possessionEstablished: Bool
) -> (kind: CatchContactKind, impact: Double)? {
    if impact < CATCH_FOUL_IMPACT { return nil }
    if !defenderPlayedDisc && possessionEstablished { return (.strip, impact) }
    return (.foul, impact)
}

/// CONTESTED OR NOT, AND NOT A COIN FLIP.
///
/// The player a call is made against contests it when he has a basis to, and the basis
/// is the situation: how much contact there actually was (a lot of it is undeniable and
/// nobody argues), whether he had a hand on the disc (the "all disc" defence, which is
/// the single most common reason a real foul call is contested), whether the call is a
/// geometry both players can see — a pick is, a body foul is not — and his own
/// `decision` rating, because reading the play correctly includes reading your own
/// contact correctly.
///
/// Deterministic on purpose. No RNG is drawn here, which is also why adding the whole
/// system shifts no other stream.
public struct CallSituation: Equatable, Sendable {
    /// Closing speed of the contact, m/s.
    public var impact: Double
    /// The impact at which this kind of contact became a call.
    public var threshold: Double
    /// The defender had a hand on the disc.
    public var playedDisc: Bool
    /// The call is a geometry, not a feeling.
    public var plainToSee: Bool
    /// `decision` rating of the player the call is made against, 0..100.
    public var decision: Double

    public init(
        impact: Double, threshold: Double, playedDisc: Bool, plainToSee: Bool, decision: Double
    ) {
        self.impact = impact
        self.threshold = threshold
        self.playedDisc = playedDisc
        self.plainToSee = plainToSee
        self.decision = decision
    }
}

/// How much basis the player called against has to contest. >0.5 and he does.
///
/// The numbers, and why they are where they are:
///
///   0.60 base            contact at exactly the threshold is arguable, and the
///                        argument is settled by the terms below.
///   -0.55 × severity     severity runs from 0 at the threshold to 1 at
///                        `CALL_SEVERITY_SPAN` above it. A defender who ran through
///                        somebody at speed knows he did, and says so. Measured across
///                        three matches, marking contact lands between 1 and 4 m/s, so
///                        this span is what actually separates a brush from a
///                        collision — normalising by the threshold instead put every
///                        real call at full severity and nothing was ever contested.
///   +0.30 played disc    "all disc" — the commonest reason a real call is contested,
///                        and the one the sport argues about most.
///   -0.25 plain to see   a pick is a geometry both players can point at, which is why
///                        picks are effectively never contested here, and why they are
///                        effectively never contested on a field.
///   ±(72 - decision)     judgement, centred on the roster's mean rating: a player who
///                        reads the game well reads his own contact well, and a player
///                        who does not, argues.
///
/// The spread of that last term over the roster (about ±0.19) is deliberately wide
/// enough to decide a marginal call and narrow enough that it cannot overturn an
/// obvious one.
public let CALL_SEVERITY_SPAN = 2.0

public func callDoubt(_ s: CallSituation) -> Double {
    let severity = s.threshold > 0
        ? Swift.min(1, Swift.max(0, (s.impact - s.threshold) / CALL_SEVERITY_SPAN))
        : 0
    var doubt = 0.60 - 0.55 * severity
    if s.playedDisc { doubt += 0.30 }
    if s.plainToSee { doubt -= 0.25 }
    doubt += (72 - s.decision) * 0.007
    return doubt
}

public func callContested(_ s: CallSituation) -> Bool { callDoubt(s) > 0.5 }

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
