import Foundation

/// ============================================================================
/// PLAYBOOK — the *geometry* of ultimate frisbee
/// ============================================================================
///
/// Ported from `src/sim/Playbook.ts`. Field constants, force/side algebra,
/// offensive formations, cut-route templates, zone shells and mark geometry.
/// Everything here is a pure function of numbers: no engine imports, no
/// `Math.random`, no mutable module state. The AI layer is the intended consumer.
///
/// Coordinate convention (matches BRIEF.md and `Rules.swift`):
///   origin  = field centre
///   +X      = one sideline direction, |x| <= `field.sideline`
///   +Y      = up
///   +Z      = toward the endzone team 0 attacks, |z| <= `field.endLine`
///
/// A team's attack direction is `Dir` — +1 or -1, the sign of the endzone they
/// are scoring in.
///
/// ------------------------------------------------- what the port changed, and why
///
/// **The reference reads a module-level `FIELD` constant.** `Playbook.ts` declares
/// its own `FIELD = { halfWidth: 18.5, halfLength: 50, goalLine: 32, endzoneDepth:
/// 18, brick: 14, edgeMargin: 0.9 }` and every geometric routine — `clampToField`,
/// `inBounds`, `yardsToGoal`, `inAttackEndzone`, `inOwnEndzone`,
/// `formationStations`, `chooseFormation`, `buildCut`, `zoneStations` — closes over
/// it. That hardcodes the regulation 100 x 37 m pitch, and this game also runs on
/// the 37 x 18 m minis pitch (`FieldConstants.minis`), so a module constant cannot
/// be both. The pitch is therefore threaded as a value, exactly as
/// `GameFormat.swift` threads it for `GameState`: geometry-dependent routines are
/// **instance methods** on `Playbook`, which holds a `FieldConstants`; routines that
/// touch no geometry at all stay `static`.
///
/// The mapping from the reference's names is one-to-one:
///
/// | `Playbook.ts` `FIELD` | here |
/// | --- | --- |
/// | `halfWidth`    18.5 | `field.sideline` |
/// | `halfLength`   50   | `field.endLine` |
/// | `goalLine`     32   | `field.goalLine` |
/// | `endzoneDepth` 18   | `field.endzoneDepth` |
/// | `brick`        14   | `field.brickZ` (declared but never read by `Playbook.ts`) |
/// | `edgeMargin`   0.9  | `edgeMargin`, a property of this value |
///
/// `edgeMargin` is the one that has no `FieldConstants` counterpart, because it is a
/// coaching margin rather than a dimension of the pitch — how far inside the paint
/// players are steered to stay. It is a stored property with the reference's 0.9 as
/// its default so `Playbook(field: .minis)` inherits the same margin.
///
/// **`SeededRng` and `RandomSource` are not ported here.** `Playbook.ts` carries a
/// copy of `core/Ctx.ts`'s xorshift128 purely so the sim can run headless in Node
/// without importing three.js; Swift has no such constraint and `Rng.swift` is
/// already the bit-exact port of that same generator. Duplicating it would create
/// two things that must stay identical forever. See `Rng`.
///
/// ------------------------------------------------------------ value vs reference
///
/// `Vec2d` is a struct. The reference's `{x, z}` object literals are heap
/// references, and `buildCut` mutates `target.z` / `target.x` in place after
/// building it. Every such site is marked below. None of them leaks — the reference
/// mutates only literals it constructed itself in the same function, and returns
/// `clampToField(...)` copies — but the audit is written down rather than assumed,
/// because a missed one is the single most likely bug in this port.
public struct Playbook: Sendable {

    // MARK: - the pitch

    /// The pitch this playbook is drawn for. Threaded rather than global — see the
    /// type doc.
    public let field: FieldConstants

    /// Players are steered to stay this far inside the perimeter. The reference's
    /// `FIELD.edgeMargin`.
    public let edgeMargin: Double

    /// The reference's `FIELD.edgeMargin`.
    public static let DEFAULT_EDGE_MARGIN = 0.9

    public init(field: FieldConstants, edgeMargin: Double = Playbook.DEFAULT_EDGE_MARGIN) {
        self.field = field
        self.edgeMargin = edgeMargin
    }

    /// The regulation 7v7 pitch — the one and only geometry `Playbook.ts` could
    /// express. Provided so a caller that genuinely means "regulation" says so.
    public static let regulation = Playbook(field: .standard)

    // MARK: - types

    public typealias Sign = Int

    public enum Handedness: String, Equatable, Decodable, Sendable {
        case right
        case left
    }

    /// The call the defence makes.
    ///
    /// The first three are FIXED to a side of the field for the whole point, which is
    /// how a team calls "force home" or "force flick": the open side does not move
    /// when the disc does. `straight` is a straight-up mark that takes neither side
    /// (and mostly takes away the huck).
    ///
    /// The last two are POSITION-DEPENDENT and cannot be expressed by `openSideSign`,
    /// which is why they need `openSideFor`:
    ///
    ///   `middle`   — force the disc back toward the middle of the field. The mark
    ///                takes away the sideline the disc is nearest, so the open side
    ///                always points at x = 0.
    ///   `sideline` — the trap. The mirror of `middle`: take away the middle and
    ///                invite the throw down the near line.
    public enum Force: String, Equatable, Decodable, Sendable {
        case forehand
        case backhand
        case straight
        case middle
        case sideline
    }

    /// Forces whose open side depends on where the disc is, not on the call alone.
    public static let POSITIONAL_FORCES: [Force] = [.middle, .sideline]

    /// How far off centre the disc must be before a positional force commits to a
    /// side. Inside this band the previous call is held.
    ///
    /// Without it, force middle flips every time the disc crosses x = 0 — and the open
    /// side is what the whole offence is built on, so a force that chatters makes the
    /// stack, the reset and the mark all rebuild several times a second.
    public static let FORCE_DEADBAND = 3.0

    public enum FormationName: String, Equatable, Decodable, Sendable {
        case vertical
        case horizontal
        case side
        case endzone
    }

    public enum CutKind: String, Equatable, Decodable, Sendable {
        /// Downfield cutter comes back toward the disc, open side.
        case under
        /// Same, but attacking the side the mark is taking away.
        case breakUnder = "break-under"
        /// Downfield cutter attacks the space behind the defence.
        case deep
        /// Short, sharp cut to the front cone in the endzone set.
        case strike
        /// Handler attacks the space up the line, open side.
        case upLine = "up-line"
        /// Handler reset behind the disc.
        case dump
        /// Handler reset that changes the angle of attack.
        case swing
    }

    /// A "lane" is the piece of field a cut consumes. Two live cuts may never share
    /// one — that is what stops the offence from clogging.
    public enum LaneKey: String, Equatable, Decodable, Sendable {
        case openUnder = "open-under"
        case openDeep = "open-deep"
        case breakUnder = "break-under"
        case breakDeep = "break-deep"
        case resetOpen = "reset-open"
        case resetBreak = "reset-break"
    }

    public static let ALL_LANES: [LaneKey] = [
        .openUnder, .openDeep, .breakUnder, .breakDeep, .resetOpen, .resetBreak,
    ]

    public enum StationRole: String, Equatable, Decodable, Sendable {
        case handler
        case cutter
    }

    public struct Station: Equatable, Sendable {
        public var x: Double
        public var z: Double
        public var role: StationRole
        /// 0 = closest to the disc within its role group.
        public var depth: Int

        public init(x: Double, z: Double, role: StationRole, depth: Int) {
            self.x = x
            self.z = z
            self.role = role
            self.depth = depth
        }
    }

    public struct CutRoute: Equatable, Sendable {
        public var kind: CutKind
        public var lane: LaneKey
        /// Where the setup step goes — deliberately the WRONG way, to sell the cut.
        public var setup: Vec2d
        /// Where the cut attacks after the plant.
        public var target: Vec2d
        /// Which side of the field this cut is committed to.
        public var side: Sign
        public var setupTime: Double
        public var maxTime: Double

        public init(
            kind: CutKind, lane: LaneKey, setup: Vec2d, target: Vec2d, side: Sign,
            setupTime: Double, maxTime: Double
        ) {
            self.kind = kind
            self.lane = lane
            self.setup = setup
            self.target = target
            self.side = side
            self.setupTime = setupTime
            self.maxTime = maxTime
        }
    }

    public enum ThrowSide: String, Equatable, Decodable, Sendable {
        case forehand
        case backhand
    }

    public enum ZoneRole: String, Equatable, Decodable, Sendable {
        case cupMark = "cup-mark"
        case cupLeft = "cup-left"
        case cupRight = "cup-right"
        case wingOpen = "wing-open"
        case wingBreak = "wing-break"
        case shortDeep = "short-deep"
        case deep
    }

    public struct ZoneStation: Equatable, Sendable {
        public var role: ZoneRole
        public var x: Double
        public var z: Double

        public init(role: ZoneRole, x: Double, z: Double) {
            self.role = role
            self.x = x
            self.z = z
        }
    }

    // MARK: - tunables

    /// Tunables the AI reads; grouped here so behaviour can be tuned in one place.
    /// Spelled `PLAY` so this file and `Playbook.ts` read the same.
    public enum PLAY {
        /// Stack spacing, metres, front-to-back.
        public static let stackSpacing = 4.2
        /// How far downfield the front of a vertical stack sits from the disc.
        public static let stackLead = 11.0
        /// How many cutters must still be STANDING IN THE COLUMN before another one is
        /// allowed to go. A stack is the bodies that are not cutting; if there are
        /// none, there is no stack, only traffic.
        public static let stackHold = 3
        /// Max live downfield cuts at once.
        public static let maxLiveCuts = 2
        /// Minimum gap between the starts of two cuts, seconds. This is what makes a
        /// second cut read as a SECOND cut rather than as two people leaving at once.
        public static let cutStagger = 1.1
        /// Setup-step duration before the plant, seconds.
        public static let setupTime = 0.45
        /// Plant / change-of-direction duration, seconds.
        public static let plantTime = 0.16
        /// A cut is abandoned after this long.
        ///
        /// `underCutTime` HAS TO COVER THE CANONICAL UNDER, which is the longest cut in
        /// the sport that is not a huck: the back of the stack coming all the way back
        /// to the disc. The back cutter stands at `stackLead + 4 * stackSpacing` = 27.8
        /// m downfield and the under resolves 5.5-9.5 m in front of the disc, so the
        /// run is 18-22 m. From a standing start that is 3.0-3.4 s.
        public static let underCutTime = 3.4
        public static let deepCutTime = 3.2
        /// Marker stand-off distance and the legal limits either side of it.
        public static let markDistance = 2.15
        public static let markMax = 3.0
        public static let discSpace = 1.0
        /// Downfield defenders shade this far to the open side of their matchup.
        public static let shadeOpen = 1.75
        /// Cushion a defender gives a live deep threat, metres downfield.
        public static let deepCushion = 2.4
        /// How far under a defender plays a cutter who is not a deep threat.
        public static let underGap = 0.9
    }

    /// How far off centre a reset station is ever allowed to sit. The reset is the
    /// throw the offence falls back on, so it must be somewhere a disc can be thrown
    /// FROM next — and eighteen metres out, hard against a line, is not.
    static let RESET_BAND = 10.5
    static let SWING_BAND = 13.0
    /// How far in front of its own goal line the backfield is allowed to set up. See
    /// the floor in `formationStations` — this is what stops a pinned offence dumping
    /// itself backwards into its own endzone.
    static let PIN_MARGIN = 2.0

    /// The widest a row may sit: exactly the x-limit `clampToField` enforces.
    ///
    /// The reference is a module constant, `FIELD.halfWidth - FIELD.edgeMargin`. Here
    /// it is derived from the threaded pitch, so a minis pitch narrows it rather than
    /// letting a 17.6 m band leak onto a 9 m half-width.
    var fieldBand: Double { field.sideline - edgeMargin }

    // MARK: - pitch scale

    /// **The pitch every shape constant in this file was measured on.**
    ///
    /// `Playbook.ts` has one field and therefore no need to say this. Here it is the
    /// denominator of the two scales below, and it is `FieldConstants.standard` rather
    /// than a copy of its numbers so the two can never drift.
    public static let referenceField = FieldConstants.standard

    /// **How much of a regulation half-field of PLAYING FIELD this pitch has.**
    ///
    /// Every downfield offset in this file — the stack lead and its spacing, how far
    /// behind the disc a handler stands, how far in front of it an under resolves, how
    /// far a deep cut reaches — is an absolute number of metres chosen on a pitch whose
    /// goal line sits 32 m from the centre. On the minis pitch the goal line is at 12.5,
    /// so those numbers do not describe a shape any more: `stackLead + 4 * stackSpacing`
    /// is 27.8 m, which is nine metres PAST the minis end line. Measured, all five
    /// vertical-stack cutter stations clamped into the back of the endzone and stood on
    /// each other; the horizontal set's cutter row (15 m downfield, ±13.5 m wide) clamped
    /// into the same corner from the other direction.
    ///
    /// So the shape is expressed as a fraction of the pitch and multiplied back out. At
    /// regulation this is `32 / 32`, which is exactly 1.0, so every product below is
    /// bit-identical to the constant it replaced and `tools/goldens/playbook.ts` does not
    /// move. That is the whole reason it is written as a ratio of two field numbers
    /// rather than as a hand-entered 0.39.
    public var depthScale: Double { field.goalLine / Playbook.referenceField.goalLine }

    /// The same argument laterally: 18.5 m of half-width becomes 9 on minis, so a
    /// handler row spanning ±10 m and a side-stack column at ±12.5 are both off the pitch.
    public var widthScale: Double { field.sideline / Playbook.referenceField.sideline }

    /// `RESET_BAND`, `SWING_BAND` and `PIN_MARGIN` on the pitch actually being played.
    /// The raw constants stay as the regulation spelling — they are what the reference
    /// says and what the goldens assert — and these are what the shapes read.
    var resetBand: Double { Playbook.RESET_BAND * widthScale }
    var swingBand: Double { Playbook.SWING_BAND * widthScale }
    var pinMargin: Double { Playbook.PIN_MARGIN * depthScale }

    // MARK: - maths

    public static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double {
        a + (b - a) * t
    }

    /// Hermite smoothstep between two edges.
    ///
    /// `t * t * (3 - 2 * t)` is written exactly as the reference writes it. This is
    /// NOT the same rounding as `3 * t * t - 2 * t * t * t`; do not "simplify".
    public static func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
        // The reference guards the divide with `(edge1 - edge0 || 1e-6)`. JavaScript's
        // `||` falls through on every falsy value, which for a number means +0, -0 and
        // NaN — so all three are reproduced here, not just the plain-zero case.
        let span = edge1 - edge0
        let den = (span == 0 || span.isNaN) ? 1e-6 : span
        let t = clamp((x - edge0) / den, 0, 1)
        return t * t * (3 - 2 * t)
    }

    /// Planar distance. `Math.hypot` in the reference, `Foundation.hypot` here —
    /// neither is correctly rounded, so this is the one arithmetic helper whose port
    /// is asserted to a tolerance rather than bit-for-bit.
    public static func dist2(_ ax: Double, _ az: Double, _ bx: Double, _ bz: Double) -> Double {
        Foundation.hypot(ax - bx, az - bz)
    }

    public static func distSq2(_ ax: Double, _ az: Double, _ bx: Double, _ bz: Double) -> Double {
        let dx = ax - bx
        let dz = az - bz
        return dx * dx + dz * dz
    }

    /// Signed logistic in [0,1]; `k` is the steepness.
    public static func sigmoid(_ x: Double, _ k: Double = 1) -> Double {
        1 / (1 + Foundation.exp(-k * x))
    }

    // MARK: - field geometry

    /// Squeeze a point inside the playing surface. Returns a new value.
    ///
    /// Value semantics make this structurally a copy; the reference returns a fresh
    /// object literal for the same reason, so callers may not write through it.
    public func clampToField(_ p: Vec2d, margin: Double? = nil) -> Vec2d {
        let m = margin ?? edgeMargin
        return Vec2d(
            clamp(p.x, -field.sideline + m, field.sideline - m),
            clamp(p.z, -field.endLine + m, field.endLine - m)
        )
    }

    public func inBounds(_ x: Double, _ z: Double, margin: Double = 0) -> Bool {
        abs(x) <= field.sideline - margin && abs(z) <= field.endLine - margin
    }

    /// Metres from `z` to the goal line the team attacks. Negative once in the endzone.
    public func yardsToGoal(_ z: Double, _ dir: Dir) -> Double {
        field.goalLine - Double(dir) * z
    }

    public func inAttackEndzone(_ z: Double, _ dir: Dir) -> Bool {
        Double(dir) * z >= field.goalLine
    }

    public func inOwnEndzone(_ z: Double, _ dir: Dir) -> Bool {
        Double(dir) * z <= -field.goalLine
    }

    // MARK: - force / sides

    /// X sign of a player's forehand side while facing `dir`.
    ///
    /// three.js is right-handed with +Y up, so a player facing +Z has their right hand
    /// at -X (right = forward x up = (0,0,1) x (0,1,0) = (-1,0,0)).
    public static func handSideSign(_ handed: Handedness, _ dir: Dir) -> Sign {
        let rightHandX = -dir
        return handed == .right ? rightHandX : -rightHandX
    }

    /// X sign of the OPEN side — the side the force invites throws toward — for a team
    /// attacking `dir`. Defined against a right-handed reference thrower, which is how
    /// real teams call it: the call is fixed to a side of the field for the whole point
    /// ("force home"), not re-derived per thrower.
    public static func openSideSign(_ force: Force, _ dir: Dir) -> Sign {
        if force == .straight { return -dir }
        // A positional force has no fixed side; this is only its neutral prior, and
        // callers that can see the disc must use `openSideFor` instead.
        if force == .middle || force == .sideline { return -dir }
        let forehandX = handSideSign(.right, dir)
        return force == .forehand ? forehandX : -forehandX
    }

    /// The open side, for a force that may depend on where the disc is.
    ///
    /// `discX` is the thrower's x. `prev` is the side this defence last committed to;
    /// pass it and the deadband is honoured, pass nil and the call is taken fresh. For
    /// the three fixed forces this is exactly `openSideSign`.
    ///
    /// Note which way round these are. FORCE MIDDLE means the throw is invited toward
    /// the middle, so the mark stands between the thrower and the near sideline and the
    /// open side points at x = 0 — a disc on the +X line has its open side at -X. The
    /// trap is the mirror: the mark takes the middle away and the offence is invited
    /// down the line it is already stuck on.
    public static func openSideFor(
        _ force: Force, _ dir: Dir, _ discX: Double, _ prev: Sign? = nil
    ) -> Sign {
        if force != .middle && force != .sideline { return openSideSign(force, dir) }
        if let prev, abs(discX) < FORCE_DEADBAND { return prev }
        let towardMiddle: Sign = discX > 0 ? -1 : 1
        return force == .middle ? towardMiddle : -towardMiddle
    }

    /// Break side for a force that may depend on where the disc is.
    public static func breakSideFor(
        _ force: Force, _ dir: Dir, _ discX: Double, _ prev: Sign? = nil
    ) -> Sign {
        -openSideFor(force, dir, discX, prev)
    }

    /// X sign of the BREAK side — the side the mark is taking away.
    public static func breakSideSign(_ force: Force, _ dir: Dir) -> Sign {
        -openSideSign(force, dir)
    }

    /// Which throw a release on `releaseSignX` requires, for a thrower of the given
    /// handedness facing `dir`. Used to price throw difficulty per player.
    public static func releaseSideType(
        _ handed: Handedness, _ dir: Dir, _ releaseSignX: Double
    ) -> ThrowSide {
        let forehandX = handSideSign(handed, dir)
        // `Math.sign(releaseSignX || forehandX)`. The `||` falls through on +0, -0 and
        // NaN alike, so a release exactly on the midline is priced as the forehand.
        let v = (releaseSignX == 0 || releaseSignX.isNaN) ? Double(forehandX) : releaseSignX
        let s: Sign = v < 0 ? -1 : (v > 0 ? 1 : 0)
        return s == forehandX ? .forehand : .backhand
    }

    // MARK: - formations

    /// Lay a backfield row out around an anchor so that every station lands inside the
    /// band — by SLIDING THE WHOLE ROW, never by clamping the stations one at a time.
    ///
    /// Clamping individually collapses the row: with the disc wide at x = 17.4 the
    /// endzone set wanted its handlers at 17.0 / 10.5 / 4.0, and the first two both hit
    /// the 10.5 band and came back as 10.5 / 10.5 / 4.0 — two handlers on the same x,
    /// 1.5 m apart in z. Two players standing on each other is one player and a shadow.
    ///
    /// Sliding preserves the SHAPE and gives up only the tracking, which is the right
    /// thing to give up — handlers bringing a wide disc back toward the middle is the
    /// behaviour the band exists to produce.
    ///
    /// It returns the SHIFT rather than the placed row, deliberately: the reference
    /// measured 4.42 rebuilds per tick, and a version taking an offsets array and
    /// returning a mapped one cost three allocations a call and ran 58-81% slower.
    static func rowShift(_ anchor: Double, _ lo: Double, _ hi: Double, _ band: Double) -> Double {
        // If the row is wider than the band there is nothing to preserve; centre it.
        hi - lo >= 2 * band ? 0 : clamp(anchor, -band - lo, band - hi)
    }

    /// X of the column a stack set is built on. One source of truth: the formation
    /// builds the stack here, the AI clears cutters back to here, and the HUD can draw
    /// the same line without guessing.
    ///
    /// Reads no field dimension in the reference either — the 12.5 and the +/-5 clamp
    /// are absolute metres — so the reference spelling stays `static` and is what
    /// `tools/goldens/playbook.ts` asserts.
    public static func stackColumnX(_ name: FormationName, _ a: Vec2d, _ openSign: Sign) -> Double {
        if name == .side { return Double(-openSign) * 12.5 }
        return clamp(a.x * 0.3, -5, 5)
    }

    /// The same column, on the pitch being played. `12.5` is the regulation BREAK
    /// SIDELINE minus a stride; on a pitch 9 m wide it is four metres into the crowd,
    /// and `clampToField` turns "stand on the break line" into "stand on the line
    /// wherever the disc is", which is not a side stack, it is a wall.
    public func stackColumnX(_ name: FormationName, _ a: Vec2d, _ openSign: Sign) -> Double {
        let w = widthScale
        if name == .side { return Double(-openSign) * 12.5 * w }
        return clamp(a.x * 0.3, -5 * w, 5 * w)
    }

    /// Where the seven offensive players want to stand, given the disc position. The
    /// thrower is not expected to run to a station — the AI leaves one unused.
    public func formationStations(
        _ name: FormationName, _ a: Vec2d, _ dir: Dir, _ openSign: Sign
    ) -> [Station] {
        let brk: Sign = -openSign
        var out: [Station] = []

        // A RESET NEVER SETS UP BEHIND YOUR OWN GOAL LINE.
        //
        // Handler stations are placed relative to the disc — `a.z - dir * 6.5` and so
        // on — which is right in the middle of the field and catastrophic when the disc
        // is already on your own line: the dump goes backwards over it, the next one
        // goes further, and the offence walks itself into its own endzone one
        // legal-looking reset at a time. Traced in a real match: a team caught the pull
        // on their own goal line at z=-30.2 and completed passes to -36.1, then -42.1,
        // then -46.4, four metres from their own end line.
        //
        // Real handlers pinned deep go LATERAL, not backward — a swing, not a dump.
        //
        // THE FLOOR IS THE BACKFIELD'S, AND IT RUNS OUT OF ROOM BEFORE THE PITCH DOES.
        // Two separate things, both wrong until issue #29, and the sentence above is the
        // contract they are both meant to serve.
        //
        // *It is the BACKFIELD's, so it is applied by role.* Cutter stations are
        // `a.z + dir * ...`, so they are always downfield OF THE DISC — which keeps them
        // clear of a floor fixed at the goal line for exactly as long as the disc is in
        // front of it, and no longer. Behind the line the disc is itself below the floor,
        // so the floor stops being a floor and becomes a magnet, dragging the front of
        // the stack forward until two stations arrive as the same point. Measured off
        // this builder, disc on the centre line, dir +1: the side stack's front two
        // cutters coincide from z = -43.2 and the vertical stack's from z = -45.2 (minis:
        // -16.875 and -17.65625). `buildCut` draws this line by role already — its floor
        // is on `dump` and `swing` only, never on a downfield cut. `PIN_MARGIN` is
        // untouched by this and keeps its one meaning: how far in front of its own goal
        // line the BACKFIELD sets up.
        //
        // *And a floored handler is mirrored rather than pinned to the line.* The floor
        // is an absolute z while every other offset in the set is disc-relative, so past
        // a certain depth the two rows cross. The ho cutter row is `a.z + dir * 15`: with
        // the disc at z = -45 the floored handler row is at -30 and so is the cutter row,
        // and at x = -5.5 a handler and a cutter come back as ONE POINT, exactly.
        // Clamping every handler to the same floor is the z-axis version of the mistake
        // `rowShift` exists to avoid on x, and it has the same symptom: the row loses its
        // shape and its members land on top of something.
        //
        // So a handler that cannot stand `off` behind the disc stands `off` in FRONT of
        // it instead — `2 * a.z - z` — and the goal-line floor still applies on top. That
        // keeps the row's own spacing, keeps every handler a real distance from the
        // thrower rather than parked on the mark, and is INERT until the mirror is itself
        // past the floor: `a.z + off < -(goalLine - PIN_MARGIN)`, which needs the disc
        // more than two metres inside its own endzone. Nothing on the playing field
        // proper moves, and the golden case pinned exactly on the goal line does not move
        // either.
        //
        // The alternative was capping the floor at the disc plus `PIN_MARGIN`, and it was
        // measured and rejected: two metres in front of a pinned thrower is where the
        // MARK stands, and `tools/test-ai.ts` went from `marker respects 1 m disc space
        // closest approach 1.75m` to `0.70m`.
        //
        // All of it is in bounds, so no `clampToField` check can see any of it. The
        // property that does is `PlaybookTests.minisShape`'s pairwise-distinct sweep,
        // whose domain now runs to the offence's own END line rather than its goal line.
        let floorZ = Double(-dir) * (field.goalLine - pinMargin)

        func push(_ x: Double, _ z: Double, _ role: StationRole, _ depth: Int) {
            var zz = z
            if role == .handler {
                let mirrored = 2 * a.z - z
                let back =
                    dir > 0 ? Swift.min(floorZ, mirrored) : Swift.max(floorZ, mirrored)
                zz = dir > 0 ? Swift.max(z, back) : Swift.min(z, back)
            }
            let p = clampToField(Vec2d(x, zz))
            out.append(Station(x: p.x, z: p.z, role: role, depth: depth))
        }

        // Every offset below is a FRACTION OF THE PITCH, spelled as the regulation number
        // times the scale. Both are exactly 1.0 on the regulation field. See `depthScale`.
        let dz = depthScale
        let wx = widthScale

        switch name {
        case .vertical:
            // 2 handlers behind, 5 cutters stacked through the middle of the field so
            // both sidelines stay live.
            //
            // Station 0 is THE RESET and it is deliberately first: with two handlers
            // one of them is usually holding the disc, so whichever station gets filled
            // has to be the one a dump can be thrown to. It sits behind the disc on the
            // OPEN side — a reset thrown through the mark is the single most punished
            // decision in the sport.
            //
            // Coached reset geometry is 45 degrees behind the thrower at about 9 m: the
            // measured mean distance was already right at 8.80 m, so this is 8.8 m at
            // exactly 45.
            let vReset = Double(openSign) * 4.5 * wx
            let vSwing = Double(brk) * 6.5 * wx
            let vs = Playbook.rowShift(
                a.x, Swift.min(vReset, vSwing), Swift.max(vReset, vSwing), resetBand)
            push(vs + vReset, a.z - Double(dir) * 6.5 * dz, .handler, 0)
            push(vs + vSwing, a.z - Double(dir) * 3.5 * dz, .handler, 1)
            let sx = stackColumnX(.vertical, a, openSign)
            for i in 0..<5 {
                push(
                    sx,
                    a.z + Double(dir) * (PLAY.stackLead + PLAY.stackSpacing * Double(i)) * dz,
                    .cutter, i)
            }

        case .horizontal:
            // 3 handlers behind, 4 cutters spread the full width 15 m downfield.
            // Coached geometry: the outside handlers sit 10-15 yd (9.1-13.7 m) either
            // side of the middle one. At 7 m "three handlers across the field" read as a
            // huddle rather than as the width the set exists to create.
            //
            // The full playing surface, not a reset band: the ho handler row IS the
            // width of the set, so the only limit on it is the field.
            let hs = Playbook.rowShift(a.x, -10.0 * wx, 10.0 * wx, fieldBand)
            // STATION 0 IS THE RESET, and it must be on the OPEN side. The AI fills
            // these in order and treats station 0 as the dump. The horizontal set once
            // had station 0 on the BREAK side, so the moment ho was enabled the offence
            // nominated a reset standing behind the mark: the one place in the sport a
            // reset may never be. Measured: a reset handler was stationed behind the
            // disc in 84.6% of held frames against 90.0% for vert.
            //
            // Open side, centre, break side. The break-side handler is the swing.
            push(hs + Double(openSign) * 10.0 * wx, a.z - Double(dir) * 5.5 * dz, .handler, 0)
            push(hs, a.z - Double(dir) * 4.0 * dz, .handler, 1)
            push(hs + Double(brk) * 10.0 * wx, a.z - Double(dir) * 5.5 * dz, .handler, 2)
            let xs = [-13.5, -4.5, 4.5, 13.5]
            for i in 0..<4 { push(xs[i] * wx, a.z + Double(dir) * 15 * dz, .cutter, i) }

        case .side:
            // 5 cutters stacked on the break sideline, isolating the whole open side.
            let sReset = Double(openSign) * 4.0 * wx
            let sSwing = Double(brk) * 6.0 * wx
            let ss = Playbook.rowShift(
                a.x, Swift.min(sReset, sSwing), Swift.max(sReset, sSwing), resetBand)
            push(ss + sReset, a.z - Double(dir) * 6.5 * dz, .handler, 0)
            push(ss + sSwing, a.z - Double(dir) * 3.0 * dz, .handler, 1)
            let lx = stackColumnX(.side, a, openSign)
            for i in 0..<5 {
                push(
                    lx, a.z + Double(dir) * (9 + PLAY.stackSpacing * Double(i)) * dz,
                    .cutter, i)
            }

        case .endzone:
            // 3 handlers behind the disc, 4 cutters spread across the endzone ready to
            // strike to the front cone. They sit a little over half the endzone deep,
            // not against the back line: pinned to the back line they are 25 m from a
            // disc 12 m out, and the team reads as two disconnected knots of people.
            // Symmetric about the middle handler, so the extremes are +/-6.5 either way.
            let es = Playbook.rowShift(a.x, -6.5 * wx, 6.5 * wx, resetBand)
            push(es + Double(openSign) * 6.5 * wx, a.z - Double(dir) * 5.0 * dz, .handler, 0)
            push(es, a.z - Double(dir) * 6.5 * dz, .handler, 1)
            push(es + Double(brk) * 6.5 * wx, a.z - Double(dir) * 5.0 * dz, .handler, 2)
            // The row stays CONNECTED TO THE DISC. Pinned to an absolute depth it sat
            // 26.4 m ahead of the disc at the exact moment the endzone call fired.
            // Making it disc-relative tightens it smoothly as the disc advances instead
            // of snapping.
            let ez = Double(dir) * clamp(
                Double(dir) * a.z + 12 * dz,
                field.goalLine + 3 * dz,
                field.goalLine + field.endzoneDepth * 0.55)
            let xs = [-11.0, -4.0, 4.0, 11.0]
            for i in 0..<4 { push(xs[i] * wx, ez, .cutter, i) }
        }

        return out
    }

    /// The reference's roster: everything shaped in this file was measured at seven.
    public static let referenceRoster = 7

    /// How many of a side stand behind the disc as handlers.
    ///
    /// **The reference's answer is a constant because the reference only ever played
    /// seven-a-side.** Ported literally it is a bug at any other roster size, and at three
    /// it is a total one: `handlerCount(.endzone)` is 3, which at 3v3 makes *every* player
    /// a handler, empties the cutter stack, and leaves `tickCutters` with nobody to run.
    /// Measured over fifteen simulated minutes of minis, the offence launched **zero**
    /// downfield cuts, threw backwards on 59 of 77 completions and scored nothing — while
    /// the identical code at sevens scored seven goals and gained seven metres a throw.
    ///
    /// So the count is proportional to the roster, and at least one body is always left
    /// out of the ring, because a set with no cutters is not a set. At seven this returns
    /// the reference's 2 and 3 exactly, which is what keeps the goldens bit-identical.
    public static func handlerCount(_ name: FormationName, playersPerSide: Int = referenceRoster)
        -> Int
    {
        let base = name == .horizontal || name == .endzone ? 3 : 2
        guard playersPerSide != referenceRoster else { return base }
        let scaled = (Double(base * playersPerSide) / Double(referenceRoster)).rounded()
        return Swift.max(1, Swift.min(Int(scaled), playersPerSide - 1))
    }

    /// How many cutters must still be standing in the column before another may go.
    ///
    /// `PLAY.stackHold` is 3, which is a fifth of a seven-a-side stack and the whole of a
    /// three-a-side one — so at 3v3 the gate `stackedCount() - 1 < hold` could never pass
    /// at any stall count, and no cut was ever initiated even in the vertical set. Scaled
    /// down, it still does its job: with two cutters, one may go and the other holds.
    public static func stackHold(playersPerSide: Int = referenceRoster) -> Int {
        guard playersPerSide != referenceRoster else { return PLAY.stackHold }
        return Swift.max(
            0, Int(Double(PLAY.stackHold * playersPerSide) / Double(referenceRoster)))
    }

    /// Does this set stand its cutters in a COLUMN, or spread them in a ROW?
    ///
    /// It is the one structural fact that separates the four looks, and three different
    /// rules in the AI turn on it: which cut a cutter is offered (a column has a front
    /// and a back, a row does not), whether being out of position for that cut should be
    /// priced down, and where a dead cut clears to (a column has a line to rejoin; a row
    /// clears back along its own lane).
    public static func hasColumn(_ name: FormationName) -> Bool {
        name == .vertical || name == .side
    }

    /// Situational formation call. `prefer` is the team's base look.
    public func chooseFormation(
        _ disc: Vec2d, _ dir: Dir, _ prefer: FormationName, _ windSpeed: Double,
        _ openSign: Sign
    ) -> FormationName {
        // The endzone set is a real look but it is not a column, so it is worth asking
        // for it only when it is genuinely an endzone situation. At 22 m it was firing
        // from a third of the way up the field. 13, not 17: the row is disc-relative
        // now, and firing the call later keeps the set connected.
        //
        // Scaled off the goal line rather than left absolute, because 13 m is a fifth of
        // a regulation half and the WHOLE of a minis one — `yardsToGoal <= 13` is true
        // everywhere on a pitch whose goal line is at 12.5 m, so the minis game was
        // permanently in its endzone set, from the pull onwards. `depthScale` is exactly
        // 1.0 at regulation, so this is 13 there; it was spelled `field.goalLine / 32`
        // before that scale existed and is the same number.
        if yardsToGoal(disc.z, dir) <= 13 * depthScale { return .endzone }
        // The side stack is called when the disc is genuinely trapped on a line. At
        // 11.5 m it was firing on a third of possessions, and every call moved the whole
        // column across the field.
        //
        // IT ALSO HAS TO KNOW WHICH LINE. `stackColumnX` builds the column at
        // `-openSign * 12.5` — the break sideline. That is right when the disc is
        // trapped on the break side: the column stands on the line the disc is already
        // stuck to, and the isolated open side is the other 30 m of field. On the OPEN
        // sideline it is the same call and the opposite shape — the column goes to the
        // far side and "isolates" a corridor no cutter can turn around in, against the
        // one force in the sport designed to put it there.
        //
        // So the trigger asks for both: near a line, AND the open side pointing back
        // into the field.
        // 14 m from the middle is "trapped on a line" on a pitch 18.5 m to the sideline;
        // on the minis pitch the sideline is at 9, so the call could never fire at all.
        if abs(disc.x) > 14.0 * widthScale && disc.x * Double(openSign) < 0 { return .side }
        if windSpeed > 7.5 { return .vertical }
        return prefer == .endzone ? .vertical : prefer
    }

    // MARK: - cuts

    /// Classify a point into the lane it occupies, on the pitch being played.
    ///
    /// The 16 m under/deep boundary is a regulation-field number: on the minis pitch it
    /// is larger than the whole distance from the disc to the back of the endzone, so
    /// EVERY cut classified as an under and the two deep lanes were unreachable — which
    /// makes `liveLanes` a two-lane table instead of a six-lane one and collides cuts
    /// that are nowhere near each other. The 1.5 m behind-the-disc threshold is a stride,
    /// not a fraction of a field, and stays absolute.
    public func laneOf(
        _ x: Double, _ z: Double, _ disc: Vec2d, _ dir: Dir, _ openSign: Sign
    ) -> LaneKey {
        let downfield = Double(dir) * (z - disc.z)
        let open = (x - disc.x) * Double(openSign) >= 0
        if downfield < 1.5 { return open ? .resetOpen : .resetBreak }
        if downfield < 16 * depthScale { return open ? .openUnder : .breakUnder }
        return open ? .openDeep : .breakDeep
    }

    /// The reference spelling, on the regulation field. Asserted by
    /// `tools/goldens/playbook.ts`; the instance method above is what the AI reads.
    public static func laneOf(
        _ x: Double, _ z: Double, _ disc: Vec2d, _ dir: Dir, _ openSign: Sign
    ) -> LaneKey {
        let downfield = Double(dir) * (z - disc.z)
        let open = (x - disc.x) * Double(openSign) >= 0
        if downfield < 1.5 { return open ? .resetOpen : .resetBreak }
        if downfield < 16 { return open ? .openUnder : .breakUnder }
        return open ? .openDeep : .breakDeep
    }

    /// Build a committed cut: a setup step away from where you are going, a plant, and a
    /// hard change of direction into the target. `j` is a deterministic jitter in [0,1]
    /// so cuts are not identical.
    public func buildCut(
        _ kind: CutKind, _ from: Vec2d, _ disc: Vec2d, _ dir: Dir, _ openSign: Sign,
        _ side: Sign, _ j: Double
    ) -> CutRoute {
        let brk: Sign = -openSign
        // ALIAS SITE (1). The reference builds `setup` and `target` as object literals
        // and then writes through `target.z` / `target.x` below. Those writes are
        // reference mutations there and plain assignments to a local value here. Nothing
        // outside this function ever held the literal, so the two are equivalent — but
        // the equivalence is checked rather than assumed, because `from` and `disc` are
        // caller-owned references in the reference and are never written to.
        var setup: Vec2d
        var target: Vec2d
        var maxTime: Double = PLAY.underCutTime

        let d = Double(dir)
        let sd = Double(side)
        let bd = Double(brk)
        let od = Double(openSign)
        // Targets are field geometry and scale with the pitch; the SETUP STEP is a
        // stride, so it does not. See `depthScale`.
        let dz = depthScale
        let wx = widthScale

        switch kind {
        case .under:
            // Sell deep first, then come back to the disc on the open side.
            setup = Vec2d(from.x + sd * 1.2, from.z + d * 3.0)
            target = Vec2d(
                disc.x + sd * (6 + 3 * j) * wx, disc.z + d * (5.5 + 4 * j) * dz)

        case .breakUnder:
            setup = Vec2d(from.x + bd * 0.8, from.z + d * 2.6)
            target = Vec2d(
                disc.x + bd * (7 + 3 * j) * wx, disc.z + d * (3 + 2.5 * j) * dz)

        case .deep:
            // Sell the under first, plant, and attack the space behind.
            //
            // A DEEP CUT ATTACKS THE SPACE BEHIND THE DEEPEST DEFENDER, which is behind
            // the CUTTER — not a fixed offset from the disc. Measured only from the disc
            // it resolved behind the feet of the man it was handed to: `deep` is offered
            // to the back of the stack, who already stands 23-28 m downfield, so a
            // target at disc + 24 m asked him to jog 4 m forward, or at slot 4 to run
            // 3.8 m BACKWARDS. Only 3 of 73 throws in a match gained over 20 m.
            setup = Vec2d(from.x - sd * 1.0, from.z - d * 2.8)
            let ahead = d * (from.z - disc.z)
            // The scale multiplies each TERM, not the sum: `ahead + 13 * dz + 6 * j * dz`
            // keeps the reference's `(ahead + 13) + 6 * j` association, and `a + b * 1.0`
            // is `a + b` for every double. Bracketing it as `ahead + (13 + 6 * j) * dz`
            // would round differently, which is exactly the kind of silent drift the
            // goldens exist to catch.
            let reach = Swift.min(
                38 * dz, Swift.max((24 + 8 * j) * dz, ahead + 13 * dz + 6 * j * dz))
            target = Vec2d(disc.x + sd * (4 + 5 * j) * wx, disc.z + d * reach)
            maxTime = PLAY.deepCutTime

        case .strike:
            setup = Vec2d(from.x - sd * 1.6, from.z + d * 1.2)
            // Term by term for the same association reason as `deep` above.
            target = Vec2d(
                disc.x + sd * (4 + 3 * j) * wx,
                d * (field.goalLine + 2 * dz + 4 * j * dz))
            maxTime = 1.8

        case .upLine:
            setup = Vec2d(from.x - od * 1.6, from.z - d * 1.0)
            target = Vec2d(
                disc.x + od * (2.0 + 1.5 * j) * wx, disc.z + d * (5 + 2 * j) * dz)
            maxTime = 1.6

        case .dump:
            // A reset goes to the OPEN side and behind. Throwing the reset through the
            // mark is the single most punished decision in the sport.
            //
            // It also has to MOVE. The reset already stands behind the disc on the open
            // side, so a two-metre shuffle to a target he is practically standing on
            // generates no separation and dies on the arrival test the moment it starts.
            // The setup sells the up-line hard the other way.
            setup = Vec2d(from.x + bd * 2.4, from.z + d * 2.8)
            target = Vec2d(
                clamp(disc.x + od * (6.5 + 2.5 * j) * wx,
                    -resetBand - 2 * wx, resetBand + 2 * wx),
                disc.z - d * (7.5 + 2 * j) * dz)
            maxTime = 2.0

        case .swing:
            setup = Vec2d(from.x - od * 1.4, from.z - d * 1.2)
            target = Vec2d(
                clamp(disc.x + od * (8 + 2 * j) * wx, -swingBand, swingBand),
                disc.z - d * (2 + 2 * j) * dz)
            maxTime = 1.8
        }

        // A RESET NEVER RUNS BEHIND YOUR OWN GOAL LINE — the same rule the backfield
        // stations obey, applied to the cut that actually gets run.
        //
        // Flooring `formationStations` was half a fix. It parks both handlers level with
        // a pinned disc correctly, and then `buildCut` sends one of them backwards over
        // the line anyway: with the disc on its own goal line at z = -30, the dump target
        // resolved to z = -38.5, six and a half metres deep in the offence's own endzone.
        // `clampToField` does not catch it because the end line is at 50, not 32.
        //
        // The ground the floor takes away comes back as WIDTH: pinned deep, handlers
        // swing across the field instead of dumping backwards.
        if kind == .dump || kind == .swing {
            let floor = Double(-dir) * (field.goalLine - pinMargin)
            let rawZ = target.z
            // ALIAS SITE (2). Reference: `target.z = ...` mutates the literal in place.
            target.z = dir > 0 ? Swift.max(rawZ, floor) : Swift.min(rawZ, floor)
            let lost = abs(rawZ - target.z)
            if lost > 0.1 {
                // `Math.sign(target.x - disc.x) || openSign` — falls through on +0, -0
                // and NaN, so a cut dead on the disc's x is pushed to the open side.
                let raw = target.x - disc.x
                let signed: Sign = raw < 0 ? -1 : (raw > 0 ? 1 : 0)
                let away: Sign = (signed == 0) ? openSign : signed
                // ALIAS SITE (3). Reference: `target.x = ...`, same literal.
                target.x = clamp(
                    target.x + Double(away) * lost * 0.8, -swingBand, swingBand)
            }
        }

        // ALIAS SITE (4). Reference: `clampToField` returns a FRESH object, so `t` and
        // `setup` in the returned route are not the literals built above. Copies here
        // are structural, so the guarantee is the same one for free.
        let t = clampToField(target)
        return CutRoute(
            kind: kind,
            lane: laneOf(t.x, t.z, disc, dir, openSign),
            setup: clampToField(setup),
            target: t,
            side: side,
            setupTime: kind == .strike || kind == .upLine
                ? PLAY.setupTime * 0.7 : PLAY.setupTime,
            maxTime: maxTime
        )
    }

    // MARK: - mark

    /// Where the marker stands: inside the stall radius, angled to the break side and a
    /// touch downfield so his body is in the break-throw release window.
    ///
    /// Field-independent — the 0.90 / 0.44 are a direction, not a dimension — so it is
    /// `static`.
    public static func markPoint(
        _ thrower: Vec2d, _ dir: Dir, _ breakSign: Sign,
        _ distance: Double = PLAY.markDistance
    ) -> Vec2d {
        let dx = Double(breakSign) * 0.90
        let dz = Double(dir) * 0.44
        let l = Foundation.hypot(dx, dz)
        return Vec2d(thrower.x + (dx / l) * distance, thrower.z + (dz / l) * distance)
    }

    // MARK: - zone

    /// A 3-2-2 zone: three-person cup on the disc, two wings, a short deep and a deep.
    /// Positions are anchored to the disc, which is what makes a zone read as a zone —
    /// the shell slides with the swing rather than chasing bodies.
    public func zoneStations(
        _ disc: Vec2d, _ dir: Dir, _ openSign: Sign, _ deepThreat: Vec2d?
    ) -> [ZoneStation] {
        let brk: Sign = -openSign
        let m = Playbook.markPoint(disc, dir, brk, PLAY.markDistance)
        // The cup is a ring of three bodies round the disc: a body's reach, not a
        // fraction of the pitch. Everything outside the cup is field geometry.
        let cupR = 4.4
        let dz = depthScale
        let wx = widthScale
        let deepX = deepThreat.map { clamp($0.x * 0.55, -9 * wx, 9 * wx) } ?? 0
        var deepZ = disc.z + Double(dir) * 26 * dz
        if Double(dir) * deepZ > field.goalLine + 5 * dz {
            deepZ = Double(dir) * (field.goalLine + 5 * dz)
        }

        let d = Double(dir)
        let raw: [ZoneStation] = [
            ZoneStation(role: .cupMark, x: m.x, z: m.z),
            ZoneStation(role: .cupLeft, x: disc.x - cupR * 0.88, z: disc.z + d * cupR * 0.6),
            ZoneStation(role: .cupRight, x: disc.x + cupR * 0.88, z: disc.z + d * cupR * 0.6),
            ZoneStation(
                role: .wingOpen, x: disc.x + Double(openSign) * 10.5 * wx,
                z: disc.z + d * 7.5 * dz),
            ZoneStation(
                role: .wingBreak, x: disc.x + Double(brk) * 10.5 * wx,
                z: disc.z + d * 7.5 * dz),
            ZoneStation(role: .shortDeep, x: disc.x * 0.4, z: disc.z + d * 15 * dz),
            ZoneStation(role: .deep, x: deepX, z: deepZ),
        ]
        // The reference's `.map` builds a new object per station rather than writing
        // `s.x = p.x` back through the element. Value semantics make that automatic.
        return raw.map { s in
            let p = clampToField(Vec2d(s.x, s.z))
            return ZoneStation(role: s.role, x: p.x, z: p.z)
        }
    }

    /// Should the defence call zone? Wind is the classic trigger; a big late lead is the
    /// other one (slow the game down, make them work).
    public static func shouldPlayZone(
        _ windSpeed: Double, _ scoreDiff: Int, _ pointsPlayed: Int, _ bias: Double
    ) -> Bool {
        let windPull = smoothstep(4.5, 11, windSpeed)
        let leadPull = scoreDiff >= 3 && pointsPlayed > 6 ? 0.35 : 0
        return windPull + leadPull + bias > 0.5
    }

    // MARK: weather

    /// THE DAY THE MATCH IS PLAYED ON.
    ///
    /// `shouldPlayZone` above is a smoothstep whose foot is at 4.5 m/s and whose midpoint
    /// is therefore 7.75 — a real number for the sport, where zone is a strong-wind call
    /// and not a mood. The match's wind used to be drawn uniformly from ±1.5 m/s across
    /// and ±1.1 along, which tops out at 1.86 m/s. The zone was arithmetically
    /// unreachable: not rare, not unlikely, *impossible*, and the 3-2-2 cup, the upwind
    /// force flip in `pickScheme` and the wind term in `maxThrowRange` were all dead code
    /// behind it.
    ///
    /// The fix is the weather, not the threshold. A windy day is the thing that should be
    /// rare; the tactic is the ordinary response to it. So this is a two-mode draw rather
    /// than a wider uniform:
    ///
    ///  - **A still day, nine in ten.** Literally the old draw: ±1.5 m/s across the field
    ///    and ±1.1 along it — the same two `range` calls in the same order, so nine matches
    ///    in ten are played in exactly the conditions every golden and every telemetry band
    ///    in this repo was measured under. The anisotropy matters and is not decoration: the
    ///    old draw's ALONG-field component never exceeded 1.1 m/s, and a pull is thrown
    ///    along the field. An isotropic 1.9 m/s calm circle was tried first and it pushed
    ///    the shortest pull in `tools/test-game.ts` from 55.4 m to 54.6 m, through a
    ///    headwind the old draw could not produce.
    ///  - **A blow, one match in ten.** 8–11 m/s, which is 18–27 mph: the conditions in which every
    ///    team in the sport plays zone. The band starts at 8 rather than at the 4.5 the
    ///    smoothstep's foot sits at because the smoothstep's MIDPOINT is 7.75, and it is
    ///    the midpoint that decides the call. Choosing the windy band to be the band where
    ///    the tactic is the right answer is the honest version of this; moving the
    ///    threshold down to meet a gentler band would have been the dishonest one, because
    ///    4.5 m/s is a real number and a 4.5 m/s day is not a zone day.
    ///
    /// Widening the uniform instead would have done the opposite of what was wanted: it
    /// would have made every match slightly windy — moving completion percentage, huck
    /// range and drop rate on all of them — while still almost never reaching the number
    /// the tactic keys off.
    public struct Weather: Equatable, Sendable {
        /// Wind on the field plane, m/s.
        public var wind: Vec2d
        /// Its magnitude, which is what every consumer actually asks for.
        public var speed: Double
        /// True when this match drew the windy mode. Telemetry and tests; no logic reads it.
        public var windy: Bool

        public init(wind: Vec2d, speed: Double, windy: Bool) {
            self.wind = wind
            self.speed = speed
            self.windy = windy
        }
    }

    /// Fraction of matches played in a real blow, and the two speed bands.
    public static let windyChance = 0.10
    /// A calm day, across the field and along it — the draw this game has always used.
    public static let calmAcross = 1.5
    public static let calmAlong = 1.1
    public static let windySpeed = (min: 8.0, max: 9.5)

    /// THE CALM DRAW COMES FIRST, AND THAT IS THE WHOLE TRICK.
    ///
    /// Reading the two calm values *before* rolling for the day means a calm day consumes
    /// exactly the two draws the old inline code consumed, in the same order, and therefore
    /// produces **the same wind vector today's engine produces**. Nine matches in ten are
    /// consequently bit-identical to the version of this game that had no weather model at
    /// all — every golden, every telemetry band and every per-seed reachability check in the
    /// repo is untouched by them.
    ///
    /// The first version rolled the day first. That is the obvious order and it costs one
    /// draw at the front, which shifts the two range calls by one and therefore changes the
    /// wind on *every* match by a metre or so a second. Nothing about that is wrong, and it
    /// re-rolled the entire suite: twelve assertions in three suites that touch neither wind
    /// nor weather went red, because they are per-seed statistics of a match and the match
    /// had been resampled.
    ///
    /// A windy day pays two extra draws for its speed and bearing. It has already changed
    /// the match beyond recognition, so it has nothing left to preserve.
    ///
    /// Callers hand this a fork of their own stream, so even the windy branch cannot move
    /// anybody else's numbers. A blow's direction is uniform over the full circle: along the
    /// field is the classic upwind/downwind point, but a crosswind is the one `pickScheme`
    /// flips its force for, and neither deserves a thumb on the scale.
    public static func drawWeather(_ rng: Rng) -> Weather {
        let calm = Vec2d(rng.range(-calmAcross, calmAcross), rng.range(-calmAlong, calmAlong))
        if rng.next() >= windyChance {
            // `Math.hypot` in the reference, `Foundation.hypot` here — same convention as
            // `dist2` above, so the two agree to within hypot's unspecified last bit.
            return Weather(wind: calm, speed: Foundation.hypot(calm.x, calm.z), windy: false)
        }
        let speed = rng.range(windySpeed.min, windySpeed.max)
        let bearing = rng.range(-Double.pi, Double.pi)
        return Weather(
            wind: Vec2d(cos(bearing) * speed, sin(bearing) * speed), speed: speed, windy: true)
    }

    // MARK: timeouts

    /// What a timeout would be *for*. `none` means do not call one.
    public enum TimeoutIntent: String, Equatable, Sendable {
        case none
        case stallReset = "stall-reset"
        case setPlay = "set-play"
    }

    /// Everything the decision below is allowed to see.
    public struct TimeoutRead: Equatable, Sendable {
        /// The count on the thrower right now.
        public var stall: Double
        /// The count at which the disc turns over — `RuleSet.stallMax`, normally 10.
        public var stallMax: Double
        /// Timeouts this team has left in this half.
        public var remaining: Int
        /// Throws this team has made since the point began. Zero is straight off the pull.
        public var throwsThisPoint: Int
        /// True when this team received the pull this point, so a goal here is a hold.
        public var receiving: Bool
        /// True when this possession has already been stopped for a timeout.
        ///
        /// Without it the feature spends both timeouts inside two ticks. A panic timeout at
        /// 7 resumes the count at 8, and 8 still satisfies "nearly up" — so the very next
        /// frame of live play calls the second one, which resumes at 9, which is the
        /// desperation throw the first one was taken to avoid. Measured as a phase trace
        /// reading `LIVE_POSSESSION@2874 TIMEOUT@2875`: one tick.
        ///
        /// One per possession is also the sport. A team that has already stopped this
        /// possession has had its look; the second timeout is for the next mess.
        public var stoppedThisPossession: Bool
        public var ours: Int
        public var theirs: Int
        /// Goals that win the match.
        public var toWin: Int

        public init(
            stall: Double, stallMax: Double, remaining: Int, throwsThisPoint: Int,
            receiving: Bool, stoppedThisPossession: Bool, ours: Int, theirs: Int, toWin: Int
        ) {
            self.stoppedThisPossession = stoppedThisPossession
            self.stall = stall
            self.stallMax = stallMax
            self.remaining = remaining
            self.throwsThisPoint = throwsThisPoint
            self.receiving = receiving
            self.ours = ours
            self.theirs = theirs
            self.toWin = toWin
        }
    }

    /// How far short of the turnover the panic call is made, in stall counts.
    ///
    /// Three, not two, and the reason is `resumeStallCount`: play restarts at the count
    /// reached **plus one**, capped at 9. Take it at 8 and the offence comes back on a 9
    /// count, which is past the 8.5 at which `TeamAI` abandons its standards and throws
    /// the best thing available — so the timeout buys the desperation throw and nothing
    /// else. Take it at 7 and the count resumes at 8, still inside the window where the
    /// offence is allowed to want something.
    public static let timeoutPanicBefore = 3.0
    /// A set play is called off the catch, before the count means anything.
    public static let timeoutSetPlayStall = 2.0

    /// WHEN A TEAM CALLS ITS TIMEOUT.
    ///
    /// Two situations, both of which a watcher can read off the screen without being
    /// told, and both of which change what happens next:
    ///
    ///   **`stallReset`** — the count is nearly up and nothing is open. The possession is
    ///   broken and the alternative is a throw nobody wanted. The offence gets its shape
    ///   back and comes on at a count one higher.
    ///
    ///   **`setPlay`** — a must-hold point late in a tight game, called at the top of the
    ///   possession while the count is still nothing. This is the timeout teams keep in
    ///   their pocket all match, and it is deliberately allowed to spend the last one:
    ///   the endgame is what it was being kept for.
    ///
    /// The endgame test reserves the last timeout for that: while either side is within
    /// two of the game and the margin is one or less, a count of 7 is not worth the
    /// timeout that is being saved for the point that decides it.
    public static func timeoutIntent(_ r: TimeoutRead) -> TimeoutIntent {
        if r.remaining <= 0 || r.stoppedThisPossession { return .none }
        let endgame = max(r.ours, r.theirs) >= r.toWin - 2 && abs(r.ours - r.theirs) <= 1
        if endgame && r.receiving && r.throwsThisPoint == 0 && r.stall <= timeoutSetPlayStall {
            return .setPlay
        }
        if r.stall >= r.stallMax - timeoutPanicBefore && (r.remaining >= 2 || !endgame) {
            return .stallReset
        }
        return .none
    }
}
