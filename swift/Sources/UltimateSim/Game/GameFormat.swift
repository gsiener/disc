import Foundation

/// ULTIMATE — the pitch the game is played on, as a *value* rather than a module
/// constant.
///
/// **This is the one deliberate structural departure from `src/sim/GameState.ts`.**
/// The reference imports `FIELD` from `Rules.ts` and reads it as a module-level
/// singleton (`isInBounds(p)`, `brickMark(dir)`, `putIntoPlaySpot(spot, dir, rules)`),
/// and it hardcodes seven a side in two places — `defaultRoster()` builds seven and
/// both the constructor and `setLine()` end with `.slice(0, 7)`. Neither assumption is
/// safe here: this game must run 3v3 on a 37 × 18 m pitch with 6 m endzones as well as
/// 7v7 on the regulation 100 × 37 m field, and a module constant cannot be two things
/// at once. So the pitch and the roster size are threaded: `GameState` holds a
/// `GameFormat`, every geometric decision goes through `format.field`, and the number
/// of players on the line comes from `format.playersPerSide` rather than the literal 7.
///
/// `Rules.swift`'s free functions and its `FIELD` global stay exactly as they are —
/// they are the regulation-field spelling, they are what `tools/goldens/rules.ts`
/// asserts bit-exactly, and the methods below are required to agree with them for
/// `FieldConstants.standard`. `GameStateTests` asserts that agreement rather than
/// assuming it, because a copied-and-edited geometry routine is precisely the kind of
/// thing that drifts by a sign.

// MARK: - field presets

extension FieldConstants {
    /// Minis: the space of a single regulation endzone, turned so its long axis is the
    /// direction of play. 37 m end line to end line, 18 m wide, 6 m endzones — the same
    /// numbers `FlightUI.PitchView.Format.minis` draws.
    ///
    /// The derived quantities follow the regulation field's own identities rather than
    /// being invented: `CENTRAL_LENGTH = LENGTH - 2 * ENDZONE_DEPTH`, `GOAL_LINE =
    /// CENTRAL_LENGTH / 2`, `END_LINE = LENGTH / 2`, `SIDELINE = WIDTH / 2`. The brick
    /// mark is the one that needs a decision, because a brick is defined in absolute
    /// metres and not as a fraction of anything. On the regulation field `BRICK_IN`
    /// (18) happens to equal `ENDZONE_DEPTH` (18), so that identity is what is carried
    /// across: the brick sits one endzone-depth in from the goal line, which on minis
    /// is 6 m in, at |z| = 6.5. Scaling it by length instead would put the brick at
    /// 6.66 m and buy nothing.
    public static let minis = FieldConstants(
        length: 37,
        width: 18,
        endzoneDepth: 6,
        centralLength: 25,
        goalLine: 12.5,
        endLine: 18.5,
        sideline: 9,
        brickIn: 6,
        brickZ: 6.5
    )
}

// MARK: - format

/// A pitch plus the number of bodies on it. Everything in `GameState` that the
/// reference took from a module constant comes from here instead.
public struct GameFormat: Equatable, Sendable {
    public let field: FieldConstants
    /// Players per team on the line. Rosters may be longer; the line is capped here.
    public let playersPerSide: Int

    public init(field: FieldConstants, playersPerSide: Int) {
        self.field = field
        self.playersPerSide = playersPerSide
    }

    /// Regulation outdoor Ultimate — what `GameState.ts` assumed throughout.
    public static let sevens = GameFormat(field: .standard, playersPerSide: 7)
    /// 3v3 on a single-endzone pitch.
    public static let minis = GameFormat(field: .minis, playersPerSide: 3)
}

// MARK: - geometry, parameterised by the field

/// Geometric slack, metres. Same value as `Rules.swift`'s `G_EPS`, which is private to
/// that file; duplicated rather than exposed so the free functions' surface does not
/// grow, and pinned by a bit-equality check in `GameStateTests`.
private let G_EPS = 1e-9

extension FieldConstants {
    /// Perimeter lines count as in-bounds for the disc; a point strictly beyond is out.
    public func isInBounds(_ p: Vec3d) -> Bool {
        abs(p.x) <= sideline + G_EPS && abs(p.z) <= endLine + G_EPS
    }

    /// +1 / -1 if inside that endzone, 0 if between the goal lines. Ignores bounds in X.
    public func endzoneOf(_ z: Double) -> Int {
        if z >= goalLine - G_EPS { return 1 }
        if z <= -goalLine + G_EPS { return -1 }
        return 0
    }

    /// True when p is inside the endzone at the `dir` end and between the sidelines.
    public func isInEndzone(_ p: Vec3d, _ dir: Dir) -> Bool {
        isInBounds(p) && p.z * Double(dir) >= goalLine - G_EPS
    }

    /// A goal: an in-bounds catch in the endzone this team attacks.
    public func isGoal(_ p: Vec3d, _ attackDir: Dir) -> Bool { isInEndzone(p, attackDir) }

    /// z of the goal line at the `dir` end.
    public func goalLineZ(_ dir: Dir) -> Double { Double(dir) * goalLine }

    /// The brick mark a team uses when the pull lands out of bounds: on the centre
    /// line, BRICK_IN metres in from the goal line of the endzone they are DEFENDING
    /// (WFDF 12.4). For attackDir = +1 on the regulation field that is z = -14.
    public func brickMark(_ attackDir: Dir) -> Vec3d {
        Vec3d(0, 0, Double(attackDir) * (brickIn - goalLine))
    }

    public func clampToField(_ p: Vec3d) -> Vec3d {
        Vec3d(
            min(sideline, max(-sideline, p.x)),
            0,
            min(endLine, max(-endLine, p.z))
        )
    }

    /// Where segment a->b leaves the field rectangle. Returns nil when the segment
    /// never exits. Deterministic: ties resolve in sideline-then-endline order.
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
                if abs(z) > endLine + 1e-9 { return }
            } else if abs(x) > sideline + 1e-9 { return }
            bestT = t
            bestEdge = edge
        }

        consider(sideline - a.x, b.x - a.x, .sidelinePlusX)
        consider(-sideline - a.x, b.x - a.x, .sidelineMinusX)
        consider(endLine - a.z, b.z - a.z, .endlinePlusZ)
        consider(-endLine - a.z, b.z - a.z, .endlineMinusZ)

        guard let edge = bestEdge else { return nil }
        return Crossing(
            point: Vec3d(a.x + (b.x - a.x) * bestT, 0, a.z + (b.z - a.z) * bestT),
            edge: edge,
            t: bestT
        )
    }

    /// Where a team putting the disc into play establishes its pivot. See the free
    /// `putIntoPlaySpot` in `Rules.swift` for the full reading of USAU 12.A and 12.B —
    /// this is that function with the field supplied rather than imported.
    public func putIntoPlaySpot(_ spot: Vec3d, _ attackDir: Dir, _ rules: RuleSet) -> Vec3d {
        var p = clampToField(spot)
        let zone = p.z * Double(attackDir)
        if rules.walkToGoalLineFromAttackingEndzone && zone >= goalLine - G_EPS {
            p.z = goalLineZ(attackDir)
        } else if rules.walkOutOfDefendingEndzone && zone <= -(goalLine - G_EPS) {
            p.z = goalLineZ(-attackDir)
        }
        return p
    }

    /// The eight cone positions (four field corners + four goal-line corners), in the
    /// order `Rules.swift`'s `CONES` uses.
    public var cones: [Vec3d] {
        [
            Vec3d(-sideline, 0, -endLine),
            Vec3d(+sideline, 0, -endLine),
            Vec3d(-sideline, 0, -goalLine),
            Vec3d(+sideline, 0, -goalLine),
            Vec3d(-sideline, 0, +goalLine),
            Vec3d(+sideline, 0, +goalLine),
            Vec3d(-sideline, 0, +endLine),
            Vec3d(+sideline, 0, +endLine),
        ]
    }
}
