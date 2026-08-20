import Foundation
import UltimateSim

/// `Rules.swift` and `GameFormat.swift`'s geometry — against **the rules of Ultimate**,
/// not against a recording of the implementation.
///
/// # Why this suite is written the way it is
///
/// Almost everything in `Rules.swift` is a written rule with a number in it. WFDF 2021
/// and USAU 11th ed. say how deep an endzone is, how far ten feet is, how many counts a
/// marker gets, where a brick sits and what a soft cap does to the target. A fixture that
/// records `stallCountFor(7.0) == 7` proves the implementation is self-consistent; it
/// proves nothing about the sport. So this file asserts four kinds of thing:
///
///  - **The rule, cited.** The endzone is 18 m deep because Appendix A says so. The
///    double-team radius is 3.048 m because USAU 16.G is written in feet. The count
///    resumes at reached-plus-one capped at nine because WFDF 18.4 says so. These are
///    statements about Ultimate that happen to be checkable against this code.
///  - **A law.** The field's own arithmetic closes (`LENGTH = CENTRAL + 2·ENDZONE`) on
///    *every* format. `flipDir` and `otherTeam` are involutions. `stallElapsedFor` is a
///    right inverse of `stallCountFor`. `clampToField` is a projection. `boundaryCrossing`
///    lands on the segment *and* on the perimeter *and* is the first such point. A law
///    cannot be satisfied by a transcription of the wrong formula.
///  - **`Model`.** Where a function is a formula with no law behind it — the marker's
///    three-way legality verdict, the doubt arithmetic, the cap targets — the
///    specification is implemented a second time, from the prose, in a different shape,
///    and swept over a dense grid rather than checked at a handful of recorded points.
///  - **Exact values for every constant this module declares.** Issue #58's own hard
///    lesson: `aimath` shipped asserting `CATCH_DEAD < CATCH_FLOOR`, and a mutation of
///    the value survived, because only a golden that was about to be deleted had ever
///    pinned the number. A relation is the right assertion for a law and the wrong one
///    for a tuning value. Every `let` in `Rules.swift` and every field of `DEFAULT_RULES`
///    is pinned bit-exactly below, with a note saying whether the number comes from the
///    rulebook or from tuning.
///
/// # What is deliberately not asserted as correct
///
/// One place where this code and the sport disagree is recorded as a **KNOWN
/// DIVERGENCE** — asserted as it actually behaves, and labelled, so the disagreement is
/// visible in the suite instead of being quietly encoded as if it were the rule. See
/// `doubleTeamIsNotGuardingAware()`.
enum RulesTests {

    // MARK: - entry point

    static func run() throws {
        fieldConstants()
        ruleSetConstants()
        contactConstants()
        fieldIdentities()
        formatPresets()
        geometrySweep()
        boundarySweep()
        putIntoPlayRules()
        stallCounting()
        markerLegality()
        doubleTeam()
        doubleTeamIsNotGuardingAware()
        travel()
        contact()
        markingFoul()
        picks()
        catchContact()
        doubt()
        scoreAndCaps()
        involutions()
    }

    // MARK: - a deterministic sample source

    /// A 64-bit xorshift, written here rather than borrowed from `UltimateSim.Rng`.
    ///
    /// The point of every sweep below is to feed the implementation inputs nobody chose
    /// by looking at it. It must be reproducible — a check that only fails on some runs
    /// is not a check — and it must not be the sim's own generator, because a suite that
    /// samples with the thing it is testing near cannot claim independence.
    private struct Sample {
        private var s: UInt64
        init(_ seed: UInt64) { s = seed | 1 }
        mutating func next() -> UInt64 {
            s ^= s << 13
            s ^= s >> 7
            s ^= s << 17
            return s
        }
        /// Uniform in [lo, hi).
        mutating func unit(_ lo: Double, _ hi: Double) -> Double {
            lo + (hi - lo) * Double(next() >> 11) * (1.0 / 9_007_199_254_740_992.0)
        }
        mutating func bool() -> Bool { next() & 1 == 1 }
    }

    /// The geometric slack `GameFormat.swift` and `Rules.swift` both spell `1e-9`.
    ///
    /// Private in both files, so it is restated here rather than imported — and pinned by
    /// behaviour in `fieldIdentities()`, which asserts a point one decade inside it is in
    /// bounds and one decade outside it is not. A model that guessed the wrong epsilon
    /// would disagree with the implementation on the perimeter, which is exactly where
    /// every in-bounds question in this sport is decided.
    private static let eps = 1e-9

    /// Both pitches this game is played on. Every geometric law below is asserted on both
    /// — ADR-0004's rule that a shape property which holds at one format is not a shape
    /// property, and minis is the *default* format here.
    private static let fields: [(String, FieldConstants)] = [
        ("sevens", .standard), ("minis", .minis),
    ]

    // MARK: - constants: the field

    /// WFDF 2021 Appendix A / USAU 11th ed. Appendix A — the regulation pitch, metric.
    ///
    /// Every number pinned exactly. The endzone depth and the central length are the two a
    /// hand-entered preset gets wrong, and everything else in this file is measured off
    /// them.
    private static func fieldConstants() {
        let f = FieldConstants.standard
        Check.bitEq(f.length, 100, "regulation field is 100 m end line to end line (WFDF A.1)")
        Check.bitEq(f.width, 37, "regulation field is 37 m wide (WFDF A.1)")
        Check.bitEq(f.endzoneDepth, 18, "a regulation endzone is 18 m deep (WFDF A.1)")
        Check.bitEq(f.centralLength, 64, "the playing field proper is 64 m (WFDF A.1)")
        Check.bitEq(f.goalLine, 32, "each goal line is 32 m from centre")
        Check.bitEq(f.endLine, 50, "each end line is 50 m from centre")
        Check.bitEq(f.sideline, 18.5, "each sideline is 18.5 m from centre")
        Check.bitEq(f.brickIn, 18, "the brick mark is 18 m in from the goal line (WFDF A.1)")
        Check.bitEq(f.brickZ, 14, "so a brick sits at |z| = 14 m")

        // Minis is this project's own format and has no rulebook to cite, so its numbers
        // are pinned as declarations and their *derivation* is asserted in
        // `fieldIdentities()`. Pinning them matters exactly as much as pinning the
        // regulation ones: minis is the default game mode.
        let m = FieldConstants.minis
        Check.bitEq(m.length, 37, "minis is 37 m long")
        Check.bitEq(m.width, 18, "minis is 18 m wide")
        Check.bitEq(m.endzoneDepth, 6, "a minis endzone is 6 m deep")
        Check.bitEq(m.centralLength, 25, "minis' playing field proper is 25 m")
        Check.bitEq(m.goalLine, 12.5, "minis goal line at |z| = 12.5 m")
        Check.bitEq(m.endLine, 18.5, "minis end line at |z| = 18.5 m")
        Check.bitEq(m.sideline, 9, "minis sideline at |x| = 9 m")
        Check.bitEq(m.brickIn, 6, "minis brick is 6 m in from the goal line")
        Check.bitEq(m.brickZ, 6.5, "so a minis brick sits at |z| = 6.5 m")

        // The unit conversion the box score displays through. Exactly 0.9144 m to the
        // yard by international agreement, so the reciprocal is fixed rather than chosen.
        Check.bitEq(YARDS_PER_METRE, 1.0936133, "YARDS_PER_METRE")
        Check.near(
            YARDS_PER_METRE * 0.9144, 1, 1e-7,
            "and it really is the reciprocal of the international yard (0.9144 m)")

        // The eight cones, derived rather than typed. Order is load-bearing: the renderer
        // draws them in it.
        for (name, field) in fields {
            let c = field.cones
            Check.eq(c.count, 8, "\(name): eight cones — four corners, four goal-line ends")
            let want = [
                Vec3d(-field.sideline, 0, -field.endLine),
                Vec3d(+field.sideline, 0, -field.endLine),
                Vec3d(-field.sideline, 0, -field.goalLine),
                Vec3d(+field.sideline, 0, -field.goalLine),
                Vec3d(-field.sideline, 0, +field.goalLine),
                Vec3d(+field.sideline, 0, +field.goalLine),
                Vec3d(-field.sideline, 0, +field.endLine),
                Vec3d(+field.sideline, 0, +field.endLine),
            ]
            for i in 0..<Swift.min(8, c.count) {
                expectVec(c[i], want[i], "\(name): cone \(i)")
                Check.ok(
                    field.isInBounds(c[i]), "\(name): cone \(i) is on the pitch, not beyond it")
            }
        }
    }

    // MARK: - constants: the rule set

    /// Every field of `DEFAULT_RULES`, pinned, and where the number comes from.
    private static func ruleSetConstants() {
        let r = DEFAULT_RULES

        // --- the stall, WFDF 18.1-18.4
        Check.eq(r.stallMax, 10, "the marker counts to ten (WFDF 18.1)")
        Check.bitEq(r.stallInterval, 1, "one count per second (WFDF 18.1)")
        Check.eq(
            r.stallResumeCap, 9,
            "a resumed count is capped at nine — 'stalling nine' is the highest a restart "
                + "may begin on (WFDF 18.4)")
        Check.bitEq(r.markerRange, 3, "the marker must be within three metres (WFDF 18.1)")
        Check.bitEq(r.discSpace, 0.274, "disc space is one disc diameter, 27.4 cm (WFDF 18.1)")
        Check.bitEq(
            r.doubleTeamRange, 3.048,
            "the double-team radius is ten feet, written in feet by USAU 16.G — 3.048 m, "
                + "not a round metric number")
        Check.near(r.doubleTeamRange, 10 * 0.3048, 1e-15, "and ten feet really is 3.048 m")
        // TUNING, not a rule. The rules define a travel by whether the pivot was
        // established and moved, not by a distance; a sim needs a number and this is it.
        Check.bitEq(r.travelTolerance, 0.35, "travel tolerance, m (tuning: no rulebook figure)")

        // --- the game, WFDF 10 / USAU 9
        Check.eq(r.gameTo, 15, "a game is to fifteen (WFDF 10.1)")
        Check.eq(r.halftimeAt, 8, "halftime when a team reaches eight (WFDF 10.2)")
        Check.eq(r.gameTo, 2 * r.halftimeAt - 1, "and eight is the halfway point of fifteen")
        Check.eq(r.winBy, 1, "no win-by-two in the default format")
        Check.eq(r.pointCap, 17, "the point cap is seventeen (WFDF 10.5)")
        Check.ok(r.pointCap > r.gameTo, "and a cap above the target is the only useful kind")

        // --- the clock. Zero means "no clock", which is every untimed game.
        Check.bitEq(r.softCapAt, 0, "no soft cap by default — the sim's games are untimed")
        Check.bitEq(r.hardCapAt, 0, "no hard cap by default")

        // --- timeouts, USAU 9.3 / 9.5
        Check.eq(r.timeoutsPerHalf, 2, "two timeouts per half (USAU 9.3)")
        Check.bitEq(r.timeoutDuration, 70, "a timeout is seventy seconds (USAU 9.3)")
        Check.ok(
            !r.defenseMayCallTimeout,
            "only the team in possession may call one during a point (USAU 9.3)")

        // --- pacing. Both are the sim's own, not the rulebook's.
        Check.bitEq(r.postScoreDelay, 3, "seconds in POINT_SCORED before the next pull (tuning)")
        Check.bitEq(r.halftimeDuration, 300, "halftime lasts five minutes (tuning)")

        // --- the three rule switches, each a real clause of the rulebook
        Check.ok(r.swapEndsAtHalftime, "teams switch ends at halftime (WFDF 10.3)")
        Check.ok(
            r.walkToGoalLineFromAttackingEndzone,
            "a dead disc in the endzone you attack is put into play at the goal line "
                + "(USAU 12.B)")
        Check.ok(
            r.walkOutOfDefendingEndzone,
            "possession gained in the endzone you defend may be walked out to the goal "
                + "line (USAU 12.A.2)")
        Check.ok(r.emitPhysicsEvents, "physics events on — the renderer's whole contract")

        // `makeRules` is `{ ...DEFAULT_RULES, ...over }` with a closure instead of a
        // spread. Two properties: no overrides is the default, and an override touches
        // only what it names.
        Check.eq(makeRules(), DEFAULT_RULES, "makeRules() with no overrides is DEFAULT_RULES")
        let over = makeRules { r in
            r.stallMax = 6
            r.gameTo = 21
        }
        Check.eq(over.stallMax, 6, "makeRules applies the override it was given")
        Check.eq(over.gameTo, 21, "and the second one")
        var expected = DEFAULT_RULES
        expected.stallMax = 6
        expected.gameTo = 21
        Check.eq(over, expected, "and changes nothing it was not asked to")
    }

    // MARK: - constants: contact and the calling

    /// The self-officiation thresholds. **None of these is in a rulebook** — the rules say
    /// "the marker may not make contact with the thrower", not "at 0.8 m/s". Every one is
    /// a tuning value chosen to land the sim on the sport's own call *rate*, and every one
    /// is therefore pinned by value here and nowhere else once the goldens go.
    private static func contactConstants() {
        Check.bitEq(
            MARK_FOUL_IMPACT, 0.8,
            "MARK_FOUL_IMPACT — a step taken into a stationary man, m/s (tuning)")
        Check.bitEq(MARK_SET_TIME, 0.4, "MARK_SET_TIME — seconds before a mark is a mark (tuning)")
        Check.bitEq(
            MARK_SETTLED_SPEED, 0.6,
            "MARK_SETTLED_SPEED — above this the thrower is still arriving, m/s (tuning)")
        Check.bitEq(PICK_SPEED_LOSS, 0.9, "PICK_SPEED_LOSS — m/s a pick must cost (tuning)")
        Check.bitEq(PICK_GAP_GAIN, 0.25, "PICK_GAP_GAIN — metres the matchup must gain (tuning)")
        Check.bitEq(CATCH_FOUL_IMPACT, 1.0, "CATCH_FOUL_IMPACT — m/s at the catch (tuning)")
        Check.bitEq(
            CATCH_CONTACT_WINDOW, 0.2,
            "CATCH_CONTACT_WINDOW — how long a hit can still be blamed, s (tuning)")
        Check.bitEq(
            CALL_SEVERITY_SPAN, 2.0,
            "CALL_SEVERITY_SPAN — m/s from 'at the threshold' to 'undeniable' (tuning)")

        // The relations the design prose claims, on top of the values. A catch foul must
        // be harder contact than a marking foul, because a receiver can move out of the
        // way and a thrower on his pivot cannot.
        Check.ok(
            CATCH_FOUL_IMPACT > MARK_FOUL_IMPACT,
            "a receiving foul takes harder contact than a marking foul")
        Check.ok(
            MARK_SETTLED_SPEED < MARK_FOUL_IMPACT,
            "a thrower slower than the foul threshold is the one who cannot get out of the "
                + "way")
    }

    // MARK: - the field's own arithmetic

    /// Identities every format must satisfy, plus the perimeter epsilon.
    private static func fieldIdentities() {
        for (name, f) in fields {
            Check.bitEq(
                f.length, f.centralLength + 2 * f.endzoneDepth,
                "\(name): length is the playing field proper plus both endzones")
            Check.bitEq(
                f.endLine, f.goalLine + f.endzoneDepth,
                "\(name): the end line is one endzone beyond the goal line")
            Check.bitEq(f.goalLine, f.centralLength / 2, "\(name): goal line halves the centre")
            Check.bitEq(f.endLine, f.length / 2, "\(name): end line halves the length")
            Check.bitEq(f.sideline, f.width / 2, "\(name): sideline halves the width")
            Check.bitEq(
                f.brickZ, f.goalLine - f.brickIn,
                "\(name): the brick sits BRICK_IN in from the goal line")
            Check.ok(
                f.brickIn < f.centralLength / 2, "\(name): and the brick is in the central zone")

            // THE PERIMETER IS IN BOUNDS. WFDF 17.3: the perimeter lines are part of the
            // playing field, so a disc on the line is in. Both sides of the epsilon are
            // asserted, which is what pins the slack to a decade either way.
            Check.ok(f.isInBounds(Vec3d(f.sideline, 0, 0)), "\(name): the sideline itself is in")
            Check.ok(f.isInBounds(Vec3d(0, 0, f.endLine)), "\(name): the end line itself is in")
            Check.ok(
                f.isInBounds(Vec3d(f.sideline + eps / 10, 0, 0)),
                "\(name): a tenth of the slack beyond the sideline is still in")
            Check.ok(
                !f.isInBounds(Vec3d(f.sideline + eps * 10, 0, 0)),
                "\(name): ten times the slack beyond the sideline is out")
            Check.ok(
                !f.isInBounds(Vec3d(0, 0, f.endLine + eps * 10)),
                "\(name): and ten times the slack beyond the end line is out")

            // The goal line belongs to the endzone: a receiver with a foot on the line has
            // scored (WFDF 17.3 again — a line is part of the area it bounds).
            Check.ok(
                f.isInEndzone(Vec3d(0, 0, f.goalLine), 1),
                "\(name): the goal line itself is in the endzone")
            Check.eq(f.endzoneOf(f.goalLine), 1, "\(name): endzoneOf agrees on the goal line")
            Check.eq(f.endzoneOf(-f.goalLine), -1, "\(name): and on the other one")
            Check.eq(f.endzoneOf(0), 0, "\(name): the centre is in neither endzone")

            // Height is not a bounds question. A disc two metres up over the sideline is
            // out and a disc two metres up over the middle is in; only x and z decide.
            Check.eq(
                f.isInBounds(Vec3d(1, 2, 1)), f.isInBounds(Vec3d(1, -5, 1)),
                "\(name): bounds ignore height")
        }
    }

    /// The two pitch presets the setup UI offers must be the two the engine plays on.
    ///
    /// `FieldSpec.full`/`.minis` derive their numbers from `GameFormat` rather than
    /// retyping them, so this asserts the derivation rather than two hardcoded copies.
    private static func formatPresets() {
        Check.eq(FieldSpec.full.gameFormat, GameFormat.sevens, "FieldSpec.full is sevens")
        Check.eq(FieldSpec.minis.gameFormat, GameFormat.minis, "FieldSpec.minis is minis")
        Check.eq(GameFormat.sevens.playersPerSide, 7, "sevens is seven a side (WFDF 6.1)")
        Check.eq(GameFormat.minis.playersPerSide, 3, "minis is three a side")
        Check.eq(GameFormat.sevens.field, FieldConstants.standard, "sevens plays on the big pitch")
        Check.eq(GameFormat.minis.field, FieldConstants.minis, "minis plays on the small one")

        // The claim minis is built on: a minis pitch is a regulation endzone, turned so its
        // long axis is the direction of play.
        let full = FieldConstants.standard
        let mini = FieldConstants.minis
        Check.bitEq(mini.length, full.width, "minis is as long as a regulation field is wide")
        Check.bitEq(mini.width, full.endzoneDepth, "minis is as wide as an endzone is deep")
        Check.bitEq(
            mini.brickIn, mini.endzoneDepth,
            "minis carries the regulation identity BRICK_IN == ENDZONE_DEPTH")
        Check.bitEq(full.brickIn, full.endzoneDepth, "which the regulation field satisfies too")
    }

    // MARK: - geometry, against an independent model

    /// The pitch geometry restated from the rulebook, in a different shape.
    ///
    /// `FieldConstants` answers in terms of the derived half-extents it stores; this
    /// answers in terms of the *primary* dimensions — total length, total width, endzone
    /// depth — recomputing the halves each time. A slip in one of the stored derived
    /// values shows up here and could not show up in a self-comparison.
    private enum Model {
        static func inBounds(_ f: FieldConstants, _ p: Vec3d) -> Bool {
            abs(p.x) <= f.width / 2 + eps && abs(p.z) <= f.length / 2 + eps
        }
        static func endzoneOf(_ f: FieldConstants, _ z: Double) -> Int {
            let goal = f.length / 2 - f.endzoneDepth
            if z >= goal - eps { return 1 }
            if z <= -goal + eps { return -1 }
            return 0
        }
        static func inEndzone(_ f: FieldConstants, _ p: Vec3d, _ dir: Dir) -> Bool {
            inBounds(f, p) && endzoneOf(f, p.z) == dir
        }
        static func clamp(_ f: FieldConstants, _ p: Vec3d) -> Vec3d {
            Vec3d(
                Swift.min(f.width / 2, Swift.max(-f.width / 2, p.x)),
                0,
                Swift.min(f.length / 2, Swift.max(-f.length / 2, p.z)))
        }
        /// WFDF 13.3 — the brick you take is in the half you are defending: BRICK_IN in
        /// from your own goal line, on the centre line.
        static func brick(_ f: FieldConstants, _ attackDir: Dir) -> Vec3d {
            let ownGoal = -Double(attackDir) * (f.length / 2 - f.endzoneDepth)
            return Vec3d(0, 0, ownGoal + Double(attackDir) * f.endzoneDepth)
        }
    }

    /// Sweep both pitches on a half-metre lattice that runs well outside the perimeter,
    /// and compare every geometric predicate against the model.
    ///
    /// A lattice rather than only a random sample: the interesting answers are all on
    /// lines, and a half-metre lattice lands exactly on the goal lines and end lines of
    /// both formats (32, 50, 12.5, 18.5 are all multiples of 0.5), which a random sample
    /// reaches with probability zero. The random pass afterwards is what stops anything
    /// being true only *on* the lattice.
    private static func geometrySweep() {
        for (name, f) in fields {
            let xLimit = f.width / 2 + 4
            let zLimit = f.length / 2 + 4
            var points = 0

            var x = -xLimit
            while x <= xLimit + 1e-12 {
                var z = -zLimit
                while z <= zLimit + 1e-12 {
                    let p = Vec3d(x, 1.2, z)
                    points += 1
                    let at = "\(name) (\(x), \(z))"

                    Check.eq(f.isInBounds(p), Model.inBounds(f, p), "\(at): isInBounds")
                    Check.eq(f.endzoneOf(z), Model.endzoneOf(f, z), "\(at): endzoneOf")
                    for dir in [1, -1] {
                        Check.eq(
                            f.isInEndzone(p, dir), Model.inEndzone(f, p, dir),
                            "\(at): isInEndzone(\(dir))")
                        // A goal is nothing more than an in-bounds catch in the endzone
                        // this team attacks (WFDF 15.1). Same predicate, and asserting the
                        // identity is what stops one drifting from the other.
                        Check.eq(
                            f.isGoal(p, dir), f.isInEndzone(p, dir), "\(at): isGoal(\(dir))")
                    }

                    let c = f.clampToField(p)
                    Check.eq(c, Model.clamp(f, p), "\(at): clampToField")
                    // Clamping is a projection onto the pitch: the result is in bounds, is
                    // idempotent, moves nothing that was already in, and flattens.
                    Check.ok(f.isInBounds(c), "\(at): a clamped point is in bounds")
                    Check.eq(f.clampToField(c), c, "\(at): clampToField is idempotent")
                    Check.ok(
                        !f.isInBounds(p) || (c.x == p.x && c.z == p.z),
                        "\(at): clamping moves nothing already in bounds")
                    Check.bitEq(c.y, 0, "\(at): a put-into-play spot is on the ground")

                    z += 0.5
                }
                x += 0.5
            }
            Check.ok(points > 4000, "\(name): the lattice is dense enough to be a sweep (\(points))")

            // Off the lattice as well.
            var rng = Sample(0x5EED_0001 &+ UInt64(f.length.bitPattern))
            for _ in 0..<10_000 {
                let p = Vec3d(rng.unit(-xLimit, xLimit), rng.unit(0, 3), rng.unit(-zLimit, zLimit))
                Check.eq(f.isInBounds(p), Model.inBounds(f, p), "\(name): off-lattice isInBounds")
                Check.eq(f.endzoneOf(p.z), Model.endzoneOf(f, p.z), "\(name): off-lattice endzoneOf")
                Check.eq(
                    f.isInEndzone(p, 1), Model.inEndzone(f, p, 1), "\(name): off-lattice endzone +1")
                Check.eq(
                    f.isInEndzone(p, -1), Model.inEndzone(f, p, -1),
                    "\(name): off-lattice endzone -1")
                Check.eq(f.clampToField(p), Model.clamp(f, p), "\(name): off-lattice clamp")
            }

            for dir in [1, -1] {
                Check.bitEq(
                    f.goalLineZ(dir), Double(dir) * f.goalLine,
                    "\(name): goalLineZ(\(dir)) is that end's goal line")
                Check.ok(
                    f.isInEndzone(Vec3d(0, 0, f.goalLineZ(dir)), dir),
                    "\(name): standing on the goal line at the \(dir) end is in that endzone")
                Check.ok(
                    !f.isInEndzone(Vec3d(0, 0, f.goalLineZ(dir)), -dir),
                    "\(name): and is not in the other one")

                // THE BRICK. WFDF 13.3 — on the centre line, BRICK_IN in from the goal line
                // of the endzone the receiving team is DEFENDING.
                let b = f.brickMark(dir)
                expectVec(b, Model.brick(f, dir), "\(name): brickMark(\(dir))")
                Check.bitEq(b.x, 0, "\(name): a brick is on the centre line")
                Check.bitEq(b.y, 0, "\(name): and on the ground")
                Check.bitEq(
                    b.z, -Double(dir) * f.brickZ,
                    "\(name): a team attacking \(dir) bricks in the half it defends")
                Check.near(
                    abs(b.z - f.goalLineZ(-dir)), f.brickIn, 1e-12,
                    "\(name): and exactly BRICK_IN from its own goal line")
                Check.ok(f.isInBounds(b), "\(name): a brick is in bounds")
                Check.eq(f.endzoneOf(b.z), 0, "\(name): and in the central zone, not an endzone")
            }
        }
    }

    // MARK: - the boundary crossing

    /// Where a disc left the field — the geometry every out-of-bounds ruling is measured
    /// from (WFDF 17.4: the disc is out where it *first* contacts the out-of-bounds area).
    ///
    /// Asserted as laws rather than against a table, because the laws are total: the
    /// answer lies on the segment, it lies on the perimeter, it is the *first* such point,
    /// and a segment that never leaves has no answer.
    private static func boundarySweep() {
        for (name, f) in fields {
            var rng = Sample(0xB0DE_2222 &+ UInt64(f.width.bitPattern))
            var exits = 0
            var nils = 0
            var missedExit = 0
            var notFirst = 0

            for _ in 0..<10_000 {
                let a = Vec3d(
                    rng.unit(-f.sideline * 1.6, f.sideline * 1.6), 0,
                    rng.unit(-f.endLine * 1.4, f.endLine * 1.4))
                let b = Vec3d(
                    rng.unit(-f.sideline * 1.6, f.sideline * 1.6), 0,
                    rng.unit(-f.endLine * 1.4, f.endLine * 1.4))

                guard let c = f.boundaryCrossing(a, b) else {
                    // Nil must mean the segment never leaves. Sample along it: if any
                    // point is out while the start was in, an exit was missed.
                    if f.isInBounds(a) {
                        for k in 0...50 {
                            let t = Double(k) / 50
                            let p = Vec3d(a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t)
                            if !f.isInBounds(p) {
                                missedExit += 1
                                break
                            }
                        }
                    }
                    nils += 1
                    continue
                }
                exits += 1
                let at = "\(name): crossing"

                // On the segment, at the reported parameter.
                Check.inRange(c.t, 0, 1, "\(at): t is inside the segment")
                Check.near(c.point.x, a.x + (b.x - a.x) * c.t, 1e-9, "\(at): x is on the segment")
                Check.near(c.point.z, a.z + (b.z - a.z) * c.t, 1e-9, "\(at): z is on the segment")
                Check.bitEq(c.point.y, 0, "\(at): and on the ground")

                // On the perimeter, on the edge it names.
                let onEdge: Double
                switch c.edge {
                case .sidelinePlusX: onEdge = abs(c.point.x - f.sideline)
                case .sidelineMinusX: onEdge = abs(c.point.x + f.sideline)
                case .endlinePlusZ: onEdge = abs(c.point.z - f.endLine)
                case .endlineMinusZ: onEdge = abs(c.point.z + f.endLine)
                }
                Check.near(onEdge, 0, 1e-9, "\(at): the point is on the \(c.edge.rawValue) it names")
                // And within the pitch on the other axis — an "exit" off the corner of the
                // rectangle is not a crossing of that edge.
                Check.ok(
                    abs(c.point.x) <= f.sideline + 1e-6 && abs(c.point.z) <= f.endLine + 1e-6,
                    "\(at): the exit point is on the perimeter, not past a corner")

                // It is the FIRST exit: everything strictly before it, from an in-bounds
                // start, is still in bounds.
                if f.isInBounds(a) {
                    for k in 0..<40 {
                        let t = c.t * Double(k) / 40
                        let p = Vec3d(a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t)
                        if !f.isInBounds(p) {
                            notFirst += 1
                            break
                        }
                    }
                }
            }

            Check.eq(missedExit, 0, "\(name): a segment reported as never leaving never leaves")
            Check.eq(notFirst, 0, "\(name): and a reported crossing is the first exit")
            Check.ok(exits > 1000, "\(name): the sweep found \(exits) real exits")
            Check.ok(nils > 100, "\(name): and \(nils) segments that never left")

            // A segment wholly inside never crosses; one wholly outside on the same side
            // never crosses either.
            Check.ok(
                f.boundaryCrossing(Vec3d(0, 0, 0), Vec3d(1, 0, 1)) == nil,
                "\(name): a pass in the middle of the pitch crosses nothing")
            Check.ok(
                f.boundaryCrossing(Vec3d(f.sideline + 5, 0, 0), Vec3d(f.sideline + 6, 0, 1)) == nil,
                "\(name): and neither does one entirely off the side")

            // The documented tie-break: a segment leaving exactly through a corner is
            // reported as the sideline, because sidelines are considered first.
            let corner = f.boundaryCrossing(Vec3d(0, 0, 0), Vec3d(2 * f.sideline, 0, 2 * f.endLine))
            Check.ok(corner != nil, "\(name): a diagonal to the corner does leave the pitch")
            Check.eq(
                corner?.edge, Edge.sidelinePlusX,
                "\(name): a corner exit resolves to the sideline — sideline before end line, "
                    + "as documented")

            // A pull straight down the middle leaves over the end line, not a sideline.
            let deep = f.boundaryCrossing(Vec3d(0, 0, 0), Vec3d(0, 0, f.endLine * 3))
            Check.eq(deep?.edge, Edge.endlinePlusZ, "\(name): a pull down the middle sails long")
            Check.near(
                deep?.point.z ?? .nan, f.endLine, 1e-9, "\(name): and crosses on the end line")
            Check.near(deep?.t ?? .nan, 1.0 / 3.0, 1e-12, "\(name): a third of the way along it")

            // Reversing a segment finds the other end of it, not the same point — the
            // function answers "where did THIS journey leave", which is direction-bearing.
            let outward = f.boundaryCrossing(Vec3d(0, 0, 0), Vec3d(0, 0, f.endLine * 3))
            let inward = f.boundaryCrossing(Vec3d(0, 0, f.endLine * 3), Vec3d(0, 0, 0))
            Check.ok(outward != nil && inward != nil, "\(name): both directions cross the line")
            Check.near(
                (outward?.point.z ?? .nan), (inward?.point.z ?? .nan), 1e-9,
                "\(name): and they meet the line at the same place")
        }
    }

    // MARK: - putting it back into play

    /// USAU 12.A / 12.B — where a team establishes its pivot when it gains the disc.
    ///
    /// Two clauses, symmetric and easy to get backwards, which is exactly why they are
    /// asserted as opposites of one another rather than as two recorded tables.
    private static func putIntoPlayRules() {
        for (name, f) in fields {
            for dir in [1, -1] {
                let d = Double(dir)

                // 12.B — dead in the endzone you ATTACK: put in at the closest point on
                // that goal line. The x coordinate is preserved; only z moves.
                for x in stride(from: -f.sideline, through: f.sideline, by: 0.5) {
                    let deep = Vec3d(x, 0, d * (f.goalLine + f.endzoneDepth / 2))
                    let spot = f.putIntoPlaySpot(deep, dir, DEFAULT_RULES)
                    Check.bitEq(
                        spot.z, f.goalLineZ(dir),
                        "\(name)/\(dir): a disc dead in the endzone we attack comes to that goal "
                            + "line (USAU 12.B)")
                    Check.bitEq(spot.x, x, "\(name)/\(dir): at the closest point — x is kept")
                }

                // 12.A.2 — possession gained in the endzone you DEFEND: walk it out to your
                // own goal line, the opposite line from 12.B.
                for x in stride(from: -f.sideline, through: f.sideline, by: 0.5) {
                    let own = Vec3d(x, 0, -d * (f.goalLine + f.endzoneDepth / 2))
                    let spot = f.putIntoPlaySpot(own, dir, DEFAULT_RULES)
                    Check.bitEq(
                        spot.z, f.goalLineZ(-dir),
                        "\(name)/\(dir): possession in the endzone we defend is walked to our own "
                            + "goal line (USAU 12.A.2)")
                    Check.bitEq(spot.x, x, "\(name)/\(dir): and x is kept")
                }

                // The two clauses send the disc to OPPOSITE lines for the same attacking
                // direction. Reversing either comparison collapses them onto one line,
                // which is the mistake this pair exists to catch.
                let attacking = f.putIntoPlaySpot(Vec3d(3, 0, d * f.endLine), dir, DEFAULT_RULES)
                let defending = f.putIntoPlaySpot(Vec3d(3, 0, -d * f.endLine), dir, DEFAULT_RULES)
                Check.bitEq(
                    attacking.z, -defending.z,
                    "\(name)/\(dir): the two endzone clauses resolve to opposite goal lines")

                // Between the goal lines nothing moves but the clamp.
                for z in stride(from: -f.goalLine + 0.5, through: f.goalLine - 0.5, by: 0.5) {
                    let p = Vec3d(1.5, 0, z)
                    Check.eq(
                        f.putIntoPlaySpot(p, dir, DEFAULT_RULES), f.clampToField(p),
                        "\(name)/\(dir): a disc at z=\(z) is put into play where it lies")
                }

                // A LEGAL PIVOT IS NEVER INSIDE AN ENDZONE. Both walk clauses together say
                // this and neither says it alone, which is why it is asserted over random
                // inputs from anywhere — including far off the pitch.
                var rng = Sample(0xF00D_3333 &+ UInt64(bitPattern: Int64(dir)))
                for _ in 0..<2000 {
                    let p = Vec3d(rng.unit(-60, 60), rng.unit(-2, 4), rng.unit(-90, 90))
                    let spot = f.putIntoPlaySpot(p, dir, DEFAULT_RULES)
                    Check.ok(
                        f.isInBounds(spot),
                        "\(name)/\(dir): a put-into-play spot is always on the pitch")
                    Check.ok(
                        abs(spot.z) <= f.goalLine + eps,
                        "\(name)/\(dir): and never deeper than a goal line — nobody puts the "
                            + "disc into play inside an endzone")
                }

                // Switching the rules off leaves the disc where it lies — the flags are real
                // switches, not decoration.
                let off = makeRules { r in
                    r.walkToGoalLineFromAttackingEndzone = false
                    r.walkOutOfDefendingEndzone = false
                }
                let stay = Vec3d(2, 0, d * f.endLine)
                expectVec(
                    f.putIntoPlaySpot(stay, dir, off), f.clampToField(stay),
                    "\(name)/\(dir): with both walk rules off the pivot is where it lies")
                let onlyOut = makeRules { $0.walkToGoalLineFromAttackingEndzone = false }
                Check.bitEq(
                    f.putIntoPlaySpot(Vec3d(2, 0, -d * f.endLine), dir, onlyOut).z,
                    f.goalLineZ(-dir),
                    "\(name)/\(dir): the two clauses are independently switchable")
            }
        }
    }

    // MARK: - the stall count

    /// WFDF 18.1-18.4. The marker counts "stalling one … ten" at one-second intervals; the
    /// throw must be released before "ten"; after a stoppage the count restarts at the last
    /// number uttered plus one, and never above nine.
    private static func stallCounting() {
        // Several rule sets, so nothing here can be true only of ten-at-one-second.
        let sets: [(String, RuleSet)] = [
            ("default", DEFAULT_RULES),
            ("fast", makeRules { $0.stallInterval = 0.5 }),
            ("slow", makeRules { $0.stallInterval = 2 }),
            ("short", makeRules { $0.stallMax = 5; $0.stallResumeCap = 4 }),
            ("long", makeRules { $0.stallMax = 13; $0.stallResumeCap = 12 }),
        ]

        for (name, r) in sets {
            // The count restated as "how many whole intervals have gone by", counted
            // rather than divided — the same statement in a shape that cannot share a
            // division bug with the implementation.
            func modelCount(_ elapsed: Double) -> Int {
                if elapsed <= 0 { return 0 }
                var n = 0
                while n < r.stallMax,
                    elapsed + 1e-9 * r.stallInterval >= Double(n + 1) * r.stallInterval
                {
                    n += 1
                }
                return n
            }

            var previous = 0
            var samples = 0
            var t = -1.0
            while t <= Double(r.stallMax) * r.stallInterval + 3 {
                let got = stallCountFor(t, r)
                Check.eq(got, modelCount(t), "\(name): count at \(t) s")
                // Monotone: a count never goes down while the marker keeps counting.
                Check.ok(got >= previous, "\(name): the count never runs backwards at \(t) s")
                Check.inRange(
                    Double(got), 0, Double(r.stallMax), "\(name): the count stays in range at \(t)")
                previous = got
                samples += 1
                t += 0.002
            }
            Check.ok(samples > 1000, "\(name): the stall sweep is dense (\(samples) samples)")

            // The exact instants. A count arrives ON its second, not after it.
            for n in 0...r.stallMax {
                let at = Double(n) * r.stallInterval
                Check.eq(stallCountFor(at, r), n, "\(name): count \(n) arrives at \(at) s")
                Check.bitEq(
                    stallElapsedFor(n, r), at,
                    "\(name): stallElapsedFor is the exact instant of count \(n)")
                // Right inverse: the elapsed time a count names produces that count.
                Check.eq(
                    stallCountFor(stallElapsedFor(n, r), r), n,
                    "\(name): stallElapsedFor round-trips at \(n)")
                if n > 0 {
                    Check.eq(
                        stallCountFor(at - r.stallInterval * 0.001, r), n - 1,
                        "\(name): and a hair before \(at) s the count is still \(n - 1)")
                }
            }

            Check.eq(
                stallCountFor(Double(r.stallMax) * r.stallInterval, r), r.stallMax,
                "\(name): the count reaches its maximum exactly on time")
            Check.eq(
                stallCountFor(1e6, r), r.stallMax,
                "\(name): and never exceeds it however long the mark stands")
            Check.eq(stallCountFor(0, r), 0, "\(name): no marking time is no count")
            Check.eq(stallCountFor(-5, r), 0, "\(name): and negative time is not a count either")
            Check.bitEq(stallElapsedFor(-3, r), 0, "\(name): nor does a negative count name a time")

            // WFDF 18.4 — the restart. Reached plus one, capped, and it is a genuine cost:
            // the offence never gets the count back.
            for reached in 0...(r.stallMax + 3) {
                let resumed = resumeStallCount(reached, r)
                Check.eq(
                    resumed, Swift.min(r.stallResumeCap, reached + 1),
                    "\(name): a count reached at \(reached) resumes at reached+1, capped")
                Check.ok(
                    resumed > reached || resumed == r.stallResumeCap,
                    "\(name): the restart costs a count unless it is already at the cap "
                        + "(from \(reached))")
                Check.ok(
                    resumed <= r.stallResumeCap,
                    "\(name): and never exceeds the cap (from \(reached))")
                Check.ok(
                    resumed < r.stallMax,
                    "\(name): a restart can never itself be a stall-out (from \(reached))")
            }
            Check.eq(resumeStallCount(-4, r), 1, "\(name): a negative count resumes at one")
        }
    }

    // MARK: - the mark

    /// WFDF 18.1 — the marker must be within three metres of the thrower for the count to
    /// run, and no closer than one disc diameter.
    private static func markerLegality() {
        let r = DEFAULT_RULES

        // Restated as three named bands rather than as a chain of comparisons.
        func model(_ d: Double) -> MarkerStatus {
            if d > r.markerRange { return .outOfRange }
            if d < r.discSpace { return .discSpace }
            return .legal
        }

        Check.eq(
            markerStatus(nil, Vec3d(1, 0, 2), r), MarkerStatus.none,
            "with nobody marking there is no mark, and no count (WFDF 18.1)")

        var seen: Set<String> = []
        var samples = 0
        var d = 0.0
        while d <= 6 {
            // Sampled around the circle, not only along an axis: the rule is a radius.
            for k in 0..<8 {
                let a = Double(k) * .pi / 4
                let thrower = Vec3d(1.5, 0, -2)
                let marker = Vec3d(
                    thrower.x + d * Foundation.cos(a), 1.0, thrower.z + d * Foundation.sin(a))
                let got = markerStatus(marker, thrower, r)
                Check.eq(got, model(distXZ(marker, thrower)), "the mark at \(d) m, bearing \(k)")
                seen.insert(got.rawValue)
                samples += 1
            }
            d += 0.004
        }
        Check.ok(samples > 4000, "the mark's legality is swept as a radius (\(samples) samples)")
        Check.eq(seen.count, 3, "and all three verdicts are reachable: \(seen.sorted())")

        // The two boundaries, from both sides, at the exact rule distances.
        let t = Vec3d.zero
        Check.eq(
            markerStatus(Vec3d(r.markerRange, 0, 0), t, r), MarkerStatus.legal,
            "a marker exactly three metres away may count")
        Check.eq(
            markerStatus(Vec3d(r.markerRange + 1e-9, 0, 0), t, r), MarkerStatus.outOfRange,
            "a hair further and he may not")
        Check.eq(
            markerStatus(Vec3d(r.discSpace, 0, 0), t, r), MarkerStatus.legal,
            "a marker exactly one disc diameter away is still legal")
        Check.eq(
            markerStatus(Vec3d(r.discSpace - 1e-9, 0, 0), t, r), MarkerStatus.discSpace,
            "a hair closer and disc space is violated")
        Check.eq(
            markerStatus(t, t, r), MarkerStatus.discSpace,
            "standing on the thrower is the extreme case of it")

        // Height is not distance: a marker with his hand over the disc is judged in the
        // ground plane, which is how the rule is written and measured.
        Check.eq(
            markerStatus(Vec3d(2, 2.5, 0), t, r), MarkerStatus.legal,
            "the mark is measured in the ground plane, not in three dimensions")

        // The range is the rule set's, not a constant baked into the function.
        let tight = makeRules { $0.markerRange = 1 }
        Check.eq(
            markerStatus(Vec3d(2, 0, 0), t, tight), MarkerStatus.outOfRange,
            "the marking range comes from the rule set")
        let roomy = makeRules { $0.discSpace = 1.5 }
        Check.eq(
            markerStatus(Vec3d(1, 0, 0), t, roomy), MarkerStatus.discSpace,
            "and so does disc space")
    }

    // MARK: - the double team

    /// USAU 16.G — "a defensive player within ten feet of any pivot of the thrower without
    /// also being within ten feet of, and guarding, another offensive player".
    private static func doubleTeam() {
        let r = DEFAULT_RULES
        let pivot = Vec3d.zero
        let far = Vec3d(40, 0, 40)

        // The radius, swept. One extra defender, no other offence anywhere near: inside ten
        // feet he is a double team, outside it he is not.
        var samples = 0
        var d = 0.0
        while d <= 6 {
            for k in 0..<8 {
                let a = Double(k) * .pi / 4
                let extra = Vec3d(d * Foundation.cos(a), 0, d * Foundation.sin(a))
                let got = doubleTeamOffender(
                    pivot, 1,
                    [RulesActor(id: 1, pos: Vec3d(0.5, 0, 0)), RulesActor(id: 2, pos: extra)],
                    [RulesActor(id: 10, pos: pivot), RulesActor(id: 11, pos: far)],
                    10, r)
                let want: PlayerId? = distXZ(extra, pivot) <= r.doubleTeamRange + eps ? 2 : nil
                Check.eq(got, want, "a second defender at \(d) m, bearing \(k)")
                samples += 1
            }
            d += 0.004
        }
        Check.ok(
            samples > 4000,
            "the double-team radius is swept from the pivot (\(samples) samples)")

        // THE MARKER IS NEVER THE OFFENDER. He is the one player entitled to be there, so
        // 16.G excludes him rather than counting him.
        Check.ok(
            doubleTeamOffender(
                pivot, 1, [RulesActor(id: 1, pos: pivot)], [RulesActor(id: 10, pos: pivot)], 10, r)
                == nil,
            "the marker himself is never the double-team offender, however close he stands")

        // THE THROWER IS NOT THE OTHER OFFENSIVE PLAYER. A defender standing on the disc
        // cannot excuse himself by being near the man everybody is standing on.
        Check.eq(
            doubleTeamOffender(
                pivot, 1,
                [RulesActor(id: 1, pos: Vec3d(1, 0, 0)), RulesActor(id: 2, pos: Vec3d(0.2, 0, 0))],
                [RulesActor(id: 10, pos: pivot), RulesActor(id: 11, pos: far)],
                10, r),
            2,
            "being near the thrower does not excuse a second defender (USAU 16.G)")

        // THE EXCEPTION IS THE POINT OF THE RULE. A defender near a cutter who has come
        // through the area is legitimately close and is not double teaming.
        Check.ok(
            doubleTeamOffender(
                pivot, 1,
                [RulesActor(id: 1, pos: Vec3d(1, 0, 0)), RulesActor(id: 2, pos: Vec3d(0.2, 0, 0))],
                [RulesActor(id: 10, pos: pivot), RulesActor(id: 11, pos: Vec3d(0.25, 0, 0))],
                10, r) == nil,
            "a defender covering a cutter in the area is not double teaming (USAU 16.G)")

        // Nobody near the disc at all: no call either way.
        Check.ok(
            doubleTeamOffender(pivot, nil, [], [], nil, r) == nil,
            "an empty field is not a double team")
        Check.ok(
            doubleTeamOffender(
                pivot, nil, [RulesActor(id: 3, pos: far)], [RulesActor(id: 10, pos: pivot)], 10, r)
                == nil,
            "and neither is a defender forty metres away")

        // With no marker named, a lone defender on the disc IS the offender — the
        // exclusion is of the marker, not of "the first defender".
        Check.eq(
            doubleTeamOffender(
                pivot, nil, [RulesActor(id: 3, pos: Vec3d(0.2, 0, 0))],
                [RulesActor(id: 10, pos: pivot), RulesActor(id: 11, pos: far)], 10, r),
            3,
            "with nobody named as the marker there is nobody entitled to be on the disc")

        // The radius is a rule with a number: widening the rule set widens the call.
        let wide = makeRules { $0.doubleTeamRange = 12 }
        Check.eq(
            doubleTeamOffender(
                pivot, 1,
                [RulesActor(id: 1, pos: Vec3d(1, 0, 0)), RulesActor(id: 2, pos: Vec3d(8, 0, 0))],
                [RulesActor(id: 10, pos: pivot), RulesActor(id: 11, pos: far)],
                10, wide),
            2,
            "the double-team radius comes from the rule set, not from a constant in the function")
        Check.ok(
            doubleTeamOffender(
                pivot, 1,
                [RulesActor(id: 1, pos: Vec3d(1, 0, 0)), RulesActor(id: 2, pos: Vec3d(8, 0, 0))],
                [RulesActor(id: 10, pos: pivot), RulesActor(id: 11, pos: far)],
                10, r) == nil,
            "and at ten feet the same defender is eight metres away and legal")

        // Deterministic in the face of several offenders: the first in the frame wins, so
        // the same frame always names the same player.
        Check.eq(
            doubleTeamOffender(
                pivot, 1,
                [
                    RulesActor(id: 1, pos: Vec3d(1, 0, 0)),
                    RulesActor(id: 5, pos: Vec3d(0.3, 0, 0)),
                    RulesActor(id: 6, pos: Vec3d(0.4, 0, 0)),
                ],
                [RulesActor(id: 10, pos: pivot), RulesActor(id: 11, pos: far)], 10, r),
            5,
            "with two offenders the first in the frame is named, deterministically")
    }

    /// **KNOWN DIVERGENCE — 16.G's exception ignores who the defender is guarding.**
    ///
    /// The rule excuses a defender who is "within ten feet of, **and guarding**, another
    /// offensive player". `doubleTeamOffender` tests only the proximity half: any
    /// non-thrower offensive body inside the radius excuses him, whether or not that body
    /// is his matchup — the function is never told the matchups at all.
    ///
    /// On a real field the consequence is that a poaching defender parked on the disc is
    /// excused the moment *any* cutter drifts past him, which is the commonest way a double
    /// team actually happens. Asserted here as it behaves, and reported rather than
    /// silently encoded as correct: fixing it means threading matchups into the signature.
    private static func doubleTeamIsNotGuardingAware() {
        let r = DEFAULT_RULES
        let pivot = Vec3d.zero
        // Defender 2 is parked on the disc. Offensive player 11 is not his matchup in any
        // sense — he simply happens to be within ten feet of him.
        let got = doubleTeamOffender(
            pivot, 1,
            [RulesActor(id: 1, pos: Vec3d(1, 0, 0)), RulesActor(id: 2, pos: Vec3d(0.1, 0, 0))],
            [RulesActor(id: 10, pos: pivot), RulesActor(id: 11, pos: Vec3d(2.9, 0, 0))],
            10, r)
        Check.ok(
            got == nil,
            "KNOWN DIVERGENCE (USAU 16.G): proximity to any offensive player excuses a double "
                + "team — the 'and guarding' half of the exception is not modelled, because "
                + "the function is never told the matchups")
    }

    // MARK: - the travel

    /// The pivot foot. The rules define a travel by the pivot having moved, not by a
    /// distance; `travelTolerance` is the sim's slack for a physics engine that jitters.
    private static func travel() {
        let r = DEFAULT_RULES
        var rng = Sample(0x7A7A_4444)
        for _ in 0..<10_000 {
            let pivot = Vec3d(rng.unit(-18, 18), 0, rng.unit(-50, 50))
            let foot = Vec3d(pivot.x + rng.unit(-1, 1), rng.unit(-1, 2), pivot.z + rng.unit(-1, 1))
            Check.eq(
                isTravel(pivot, foot, r), distXZ(pivot, foot) > r.travelTolerance,
                "a travel is the pivot slipping further than the tolerance")
        }

        Check.ok(!isTravel(.zero, Vec3d(r.travelTolerance, 0, 0), r), "exactly at tolerance is not")
        Check.ok(isTravel(.zero, Vec3d(r.travelTolerance + 1e-9, 0, 0), r), "a hair beyond it is")
        Check.ok(!isTravel(.zero, .zero, r), "a foot that has not moved is not a travel")
        Check.ok(
            !isTravel(.zero, Vec3d(0, 3, 0), r),
            "and jumping straight up is not a travel — the pivot is a ground-plane fact")
        let strict = makeRules { $0.travelTolerance = 0.05 }
        Check.ok(isTravel(.zero, Vec3d(0.1, 0, 0), strict), "the tolerance comes from the rule set")
    }

    // MARK: - contact

    private struct Body: ContactBody {
        let id: PlayerId
        let pos: Vec3d
        let vel: Vec3d
        let radius: Double
    }

    /// `contactBetween` is pure geometry over two bodies, so it is asserted as identities
    /// against `distXZ`, as a symmetry, and against a model of the closing speed.
    private static func contact() {
        var rng = Sample(0xC077_5555)
        var touching = 0
        for _ in 0..<10_000 {
            let a = Body(
                id: 1, pos: Vec3d(rng.unit(-3, 3), rng.unit(0, 2), rng.unit(-3, 3)),
                vel: Vec3d(rng.unit(-9, 9), rng.unit(-2, 2), rng.unit(-9, 9)),
                radius: rng.unit(0.2, 0.6))
            let b = Body(
                id: 2, pos: Vec3d(rng.unit(-3, 3), rng.unit(0, 2), rng.unit(-3, 3)),
                vel: Vec3d(rng.unit(-9, 9), rng.unit(-2, 2), rng.unit(-9, 9)),
                radius: rng.unit(0.2, 0.6))

            let c = contactBetween(a, b)
            if c.touching { touching += 1 }

            // The distance is the same planar distance every other rule is measured with.
            Check.bitEq(c.dist, distXZ(a.pos, b.pos), "contact distance is the planar distance")
            // Touching is overlap of two discs of the stated radii.
            Check.eq(c.touching, c.dist < a.radius + b.radius, "touching is an overlap of radii")
            // Height never enters it.
            let raised = Body(
                id: 2, pos: Vec3d(b.pos.x, b.pos.y + 7, b.pos.z), vel: b.vel, radius: b.radius)
            Check.bitEq(contactBetween(a, raised).dist, c.dist, "contact ignores height")

            // Symmetry: who was closing harder does not depend on the argument order.
            let flipped = contactBetween(b, a)
            Check.bitEq(flipped.dist, c.dist, "contact distance is symmetric")
            Check.eq(flipped.touching, c.touching, "and so is touching")
            Check.near(flipped.impact, c.impact, 1e-12, "and so is the impact")

            // The impact is the larger of the two closing speeds, and the aggressor is
            // whoever owns it — computed here from the unit vector rather than by reusing
            // the implementation's normalisation.
            if c.dist >= 1e-6 {
                let ux = (b.pos.x - a.pos.x) / c.dist
                let uz = (b.pos.z - a.pos.z) / c.dist
                let closeA = a.vel.x * ux + a.vel.z * uz
                let closeB = -(b.vel.x * ux + b.vel.z * uz)
                Check.near(
                    c.impact, Swift.max(closeA, closeB), 1e-12,
                    "the impact is the harder of the two closing speeds")
                Check.eq(
                    c.aggressorId, closeA >= closeB ? 1 : 2, "and the aggressor is whoever owns it")
                // A body standing still while somebody runs into it registers the runner's
                // speed, not zero — the property the doc comment claims.
                let still = Body(id: 2, pos: b.pos, vel: .zero, radius: b.radius)
                Check.near(
                    contactBetween(a, still).impact, Swift.max(closeA, 0), 1e-12,
                    "a stationary body registers the runner's speed, not zero")
            }
        }
        Check.ok(touching > 300, "the sweep produced \(touching) real collisions")

        // Coincident bodies: no direction to close along, so no impact and a stable answer
        // rather than a NaN.
        let same = Body(id: 4, pos: Vec3d(1, 0, 1), vel: Vec3d(5, 0, 5), radius: 0.4)
        let onTop = Body(id: 9, pos: Vec3d(1, 0, 1), vel: Vec3d(-5, 0, -5), radius: 0.4)
        let c0 = contactBetween(same, onTop)
        Check.bitEq(c0.impact, 0, "two bodies in the same spot have no closing direction")
        Check.eq(c0.aggressorId, 4, "and the first is named, deterministically")
        Check.ok(c0.touching, "though they are certainly touching")
        Check.ok(!c0.dist.isNaN, "and the distance is a number, not a NaN")
    }

    // MARK: - the marking foul

    /// WFDF 17.1 / USAU 15.B — the marker may not make contact with the thrower.
    ///
    /// Four gates, and every one of them is asserted by moving only that input.
    private static func markingFoul() {
        let thrower = Body(id: 10, pos: .zero, vel: .zero, radius: 0.4)
        // A marker inside him, closing hard.
        let marker = Body(id: 1, pos: Vec3d(0.5, 0, 0), vel: Vec3d(-3, 0, 0), radius: 0.4)

        let base = markingFoulImpact(marker, thrower, 1.0)
        Check.bitEq(base, 3, "a settled mark driving into a stationary thrower is a foul, at 3 m/s")

        // Gate 1 — the mark has to have existed long enough to be a mark.
        Check.bitEq(
            markingFoulImpact(marker, thrower, MARK_SET_TIME - 1e-9), 0,
            "the collision of arrival is not a marking foul (below MARK_SET_TIME)")
        Check.ok(
            markingFoulImpact(marker, thrower, MARK_SET_TIME) > 0,
            "and at MARK_SET_TIME exactly the mark is set")

        // Gate 2 — the thrower has to be a man who cannot step out of the way.
        let running = Body(
            id: 10, pos: .zero, vel: Vec3d(0, 0, MARK_SETTLED_SPEED + 1e-6), radius: 0.4)
        Check.bitEq(
            markingFoulImpact(marker, running, 1.0), 0,
            "a thrower still carrying the catch is a party to the collision, not a victim")
        let settled = Body(
            id: 10, pos: .zero, vel: Vec3d(0, 0, MARK_SETTLED_SPEED - 1e-6), radius: 0.4)
        Check.ok(markingFoulImpact(marker, settled, 1.0) > 0, "and a thrower on his pivot is not")
        // Vertical motion is not running: a thrower who jumps is still on his pivot.
        let jumping = Body(id: 10, pos: .zero, vel: Vec3d(0, 4, 0), radius: 0.4)
        Check.ok(
            markingFoulImpact(marker, jumping, 1.0) > 0,
            "the settled test is a ground-plane speed, so a jump does not excuse the mark")

        // Gate 3 — they have to be touching.
        let apart = Body(id: 1, pos: Vec3d(3, 0, 0), vel: Vec3d(-6, 0, 0), radius: 0.4)
        Check.bitEq(
            markingFoulImpact(apart, thrower, 1.0), 0,
            "a marker running at the thrower from three metres has not fouled him yet")

        // Gate 4 — the MARKER has to be the one closing. A thrower who backs into his mark
        // has fouled nobody, and on his pivot he can hardly do even that.
        let leaning = Body(id: 1, pos: Vec3d(0.5, 0, 0), vel: .zero, radius: 0.4)
        let backing = Body(id: 10, pos: .zero, vel: Vec3d(2, 0, 0), radius: 0.4)
        Check.bitEq(
            markingFoulImpact(leaning, backing, 1.0), 0,
            "a thrower backing into a stationary mark has fouled nobody (WFDF 17.1)")

        // The threshold itself, from both sides, with everything else held; then monotone
        // above it, and equal to the closing speed that made the call.
        var previous = 0.0
        var v = MARK_FOUL_IMPACT - 0.4
        while v <= 8 {
            let m = Body(id: 1, pos: Vec3d(0.5, 0, 0), vel: Vec3d(-v, 0, 0), radius: 0.4)
            let got = markingFoulImpact(m, thrower, 1.0)
            Check.eq(
                got > 0, v >= MARK_FOUL_IMPACT,
                "closing at \(v) m/s is a marking foul exactly above the threshold")
            Check.ok(got >= previous, "a marking foul's impact rises with the contact (\(v))")
            if got > 0 { Check.near(got, v, 1e-12, "and is the closing speed itself (\(v))") }
            previous = got
            v += 0.002
        }
    }

    // MARK: - the pick

    /// "The game's most common call", and the one the design gives a *cost*: both halves
    /// are required, because a defender who slowed but stayed with his man was not picked
    /// and one whose man pulled away while he ran free was simply beaten.
    private static func picks() {
        var both = 0
        var lost = -0.5
        while lost <= 3 {
            var gained = -0.5
            while gained <= 1.5 {
                let got = pickIsWorthCalling(lostSpeed: lost, gainedGap: gained)
                Check.eq(
                    got, lost >= PICK_SPEED_LOSS && gained >= PICK_GAP_GAIN,
                    "a pick needs both halves (lost \(lost), gained \(gained))")
                if got { both += 1 }
                gained += 0.01
            }
            lost += 0.01
        }
        Check.ok(both > 100, "and the sweep reached the corner where both hold (\(both))")

        Check.ok(
            !pickIsWorthCalling(lostSpeed: 99, gainedGap: PICK_GAP_GAIN - 1e-9),
            "a defender who lost everything but stayed with his man was not picked")
        Check.ok(
            !pickIsWorthCalling(lostSpeed: PICK_SPEED_LOSS - 1e-9, gainedGap: 99),
            "and one whose man pulled away while he ran free was simply beaten")
        Check.ok(
            pickIsWorthCalling(lostSpeed: PICK_SPEED_LOSS, gainedGap: PICK_GAP_GAIN),
            "exactly on both thresholds is a call")

        // The obstruction half. A defender is obstructed by an offensive body inside him
        // that is neither the thrower nor his own matchup — both filtered in the function
        // so a caller cannot forget to.
        let defender = Body(id: 1, pos: .zero, vel: .zero, radius: 0.4)
        let thrower = Body(id: 10, pos: Vec3d(0.1, 0, 0), vel: .zero, radius: 0.4)
        let matchup = Body(id: 11, pos: Vec3d(0.1, 0, 0.1), vel: .zero, radius: 0.4)
        let third = Body(id: 12, pos: Vec3d(0.1, 0, -0.1), vel: .zero, radius: 0.4)
        let away = Body(id: 13, pos: Vec3d(20, 0, 20), vel: .zero, radius: 0.4)

        Check.ok(
            obstructionOf(defender, [thrower], 10, 11) == nil,
            "running into the thrower is not a pick — he is the man being marked")
        Check.ok(
            obstructionOf(defender, [matchup], 10, 11) == nil,
            "and running into your own matchup is not a pick either")
        Check.eq(
            obstructionOf(defender, [thrower, matchup, third], 10, 11), 12,
            "a third body inside the defender is the obstruction")
        Check.ok(
            obstructionOf(defender, [away], 10, 11) == nil,
            "and a body twenty metres away obstructs nobody")
        Check.ok(
            obstructionOf(defender, [Body](), nil, nil) == nil,
            "an empty offence obstructs nobody")
        Check.eq(
            obstructionOf(defender, [third, matchup], nil, nil), 12,
            "with no thrower and no matchup named, the first body inside is returned")

        // The radius is the two bodies' own, so a bigger body obstructs from further out.
        let wide = Body(id: 12, pos: Vec3d(1.1, 0, 0), vel: .zero, radius: 0.8)
        Check.eq(
            obstructionOf(defender, [wide], 10, 11), 12,
            "obstruction is measured off the bodies' radii, not a fixed distance")
    }

    // MARK: - contact at the catch

    /// A receiving foul and a strip are the same contact told apart by *what the defender
    /// was doing* and *whether the catch had been made*.
    private static func catchContact() {
        var kinds: Set<String> = []
        var impact = 0.0
        while impact <= 6 {
            for played in [true, false] {
                for established in [true, false] {
                    let got = catchContactCall(
                        impact: impact, defenderPlayedDisc: played,
                        possessionEstablished: established)
                    // Restated: too soft to have decided anything is no call; going through
                    // a man to reach a disc he already has is a strip; anything else hard
                    // enough is a foul.
                    let want: CatchContactKind? =
                        impact < CATCH_FOUL_IMPACT
                        ? nil : (!played && established ? .strip : .foul)
                    Check.eq(
                        got?.kind, want,
                        "catch contact at \(impact) m/s, played \(played), established "
                            + "\(established)")
                    if let got {
                        Check.bitEq(got.impact, impact, "and the call carries the impact")
                        kinds.insert(got.kind.rawValue)
                    }
                }
            }
            impact += 0.002
        }
        Check.eq(kinds, ["foul", "strip"], "both verdicts are reachable")

        Check.ok(
            catchContactCall(
                impact: CATCH_FOUL_IMPACT - 1e-9, defenderPlayedDisc: false,
                possessionEstablished: true) == nil,
            "contact below the threshold decided nothing and is not a call")
        Check.eq(
            catchContactCall(
                impact: CATCH_FOUL_IMPACT, defenderPlayedDisc: false, possessionEstablished: true)?
                .kind, .strip,
            "going through a man who already has it is a strip")
        Check.eq(
            catchContactCall(
                impact: CATCH_FOUL_IMPACT, defenderPlayedDisc: true, possessionEstablished: true)?
                .kind, .foul,
            "playing the disc and hitting the body anyway is a receiving foul")
        Check.eq(
            catchContactCall(
                impact: 5, defenderPlayedDisc: false, possessionEstablished: false)?.kind, .foul,
            "and hard contact before possession is a foul, not a strip")
    }

    // MARK: - contesting the call

    /// The doubt arithmetic. No rulebook here — the rules say a call is contested or it is
    /// not — so this is a `Model` of the documented terms plus the behavioural claims the
    /// doc comment makes.
    private static func doubt() {
        func model(_ s: CallSituation) -> Double {
            let severity =
                s.threshold > 0
                ? Swift.min(1, Swift.max(0, (s.impact - s.threshold) / CALL_SEVERITY_SPAN)) : 0
            // Written as a sum of named terms rather than as a running mutation.
            let base = 0.60
            let bySeverity = -0.55 * severity
            let byDisc = s.playedDisc ? 0.30 : 0.0
            let byPlain = s.plainToSee ? -0.25 : 0.0
            let byJudgement = (72 - s.decision) * 0.007
            return base + bySeverity + byDisc + byPlain + byJudgement
        }

        var rng = Sample(0xD00B_7777)
        var contested = 0
        var uncontested = 0
        for _ in 0..<20_000 {
            let s = CallSituation(
                impact: rng.unit(0, 8), threshold: rng.bool() ? rng.unit(0, 3) : 0,
                playedDisc: rng.bool(), plainToSee: rng.bool(), decision: rng.unit(20, 99))
            let got = callDoubt(s)
            Check.near(got, model(s), 1e-12, "callDoubt is the sum of its five documented terms")
            Check.eq(callContested(s), got > 0.5, "and a call is contested above 0.5 doubt")
            if callContested(s) { contested += 1 } else { uncontested += 1 }
        }
        Check.ok(contested > 500, "\(contested) of the sweep's calls were contested")
        Check.ok(uncontested > 500, "and \(uncontested) were not — both outcomes are reachable")

        // The claims the prose makes, each isolated by moving one input.
        let neutral = CallSituation(
            impact: 1, threshold: 1, playedDisc: false, plainToSee: false, decision: 72)
        Check.bitEq(
            callDoubt(neutral), 0.60,
            "contact exactly at the threshold, by an average player, is 0.60 — arguable")
        Check.ok(callContested(neutral), "and therefore contested")

        var disc = neutral
        disc.playedDisc = true
        Check.near(
            callDoubt(disc) - callDoubt(neutral), 0.30, 1e-12,
            "'all disc' adds 0.30 — the commonest reason a real call is argued")

        var plain = neutral
        plain.plainToSee = true
        Check.near(
            callDoubt(plain) - callDoubt(neutral), -0.25, 1e-12,
            "a geometry both players can point at takes 0.25 off")

        // Severity: undeniable contact is not argued.
        var hard = neutral
        hard.impact = 1 + CALL_SEVERITY_SPAN
        Check.near(
            callDoubt(hard) - callDoubt(neutral), -0.55, 1e-12,
            "a full span of severity takes 0.55 off — a man who ran through somebody knows "
                + "he did")
        Check.ok(!callContested(hard), "and does not contest it")
        var harder = hard
        harder.impact = 40
        Check.bitEq(
            callDoubt(harder), callDoubt(hard),
            "severity saturates at the span — there is no more to concede")

        // Judgement, centred on the roster's mean of 72, and the spread the doc claims.
        var poor = neutral
        poor.decision = 45
        var good = neutral
        good.decision = 99
        Check.ok(callDoubt(poor) > callDoubt(good), "a player who reads the game badly argues more")
        Check.near(
            (callDoubt(poor) - callDoubt(good)) / 2, 0.189, 1e-12,
            "and the spread over the roster is about ±0.19 — wide enough to decide a marginal "
                + "call, narrow enough not to overturn an obvious one")

        // A zero threshold means "no threshold was stated", and severity contributes nothing
        // rather than dividing by it.
        let noThreshold = CallSituation(
            impact: 50, threshold: 0, playedDisc: false, plainToSee: false, decision: 72)
        Check.bitEq(callDoubt(noThreshold), 0.60, "with no stated threshold there is no severity")

        // Monotone in impact, for any fixed situation.
        var previous = Double.infinity
        var i = 0.0
        while i <= 6 {
            var s = neutral
            s.impact = i
            let d = callDoubt(s)
            Check.ok(d <= previous + 1e-15, "doubt never rises with harder contact (\(i))")
            previous = d
            i += 0.002
        }
    }

    // MARK: - the score and the caps

    /// WFDF 10 — a game is to fifteen; a soft cap moves the target to the leader plus one;
    /// a hard cap makes the next goal the last; the point cap is absolute.
    private static func scoreAndCaps() {
        let sets: [(String, RuleSet)] = [
            ("default", DEFAULT_RULES),
            ("winByTwo", makeRules { $0.winBy = 2 }),
            ("shortGame", makeRules { $0.gameTo = 5; $0.pointCap = 7; $0.halftimeAt = 3 }),
        ]

        for (name, r) in sets {
            var everOver = 0
            var everLive = 0

            for a in 0...(r.pointCap + 3) {
                for b in 0...(r.pointCap + 3) {
                    let lead = Swift.max(a, b)
                    let margin = abs(a - b)

                    for cap in [CapState.none, .soft, .hard] {
                        // Restated from the prose: no cap plays to the target the format
                        // names; a soft cap plays to the leader plus one but never past the
                        // point cap; a hard cap ends on the next goal.
                        let wantTarget: Int
                        switch cap {
                        case .none: wantTarget = r.gameTo
                        case .soft: wantTarget = Swift.min(r.pointCap, lead + 1)
                        case .hard: wantTarget = lead + 1
                        }
                        let gotTarget = effectiveTarget((a, b), r, cap)
                        Check.eq(
                            gotTarget, wantTarget,
                            "\(name): target at \(a)-\(b) under \(cap.rawValue) cap")
                        // Under any cap the target is always reachable by one more goal.
                        Check.ok(
                            cap == .none || gotTarget <= lead + 1,
                            "\(name): a capped game is always one goal from over (\(a)-\(b))")
                        // Symmetric in the two teams — the rules do not know which side of
                        // the scoreboard a team is printed on.
                        Check.eq(
                            effectiveTarget((b, a), r, cap), gotTarget,
                            "\(name): the target is symmetric at \(a)-\(b)")

                        for target in [r.gameTo, gotTarget, lead, lead + 1] {
                            // The point cap is absolute; under a hard cap one goal is
                            // enough; otherwise the format's own winning margin applies.
                            let wantOver: Bool
                            if lead >= r.pointCap && margin >= 1 {
                                wantOver = true
                            } else if cap == .hard {
                                wantOver = lead >= target && margin >= 1
                            } else {
                                wantOver = lead >= target && margin >= r.winBy
                            }
                            let gotOver = isGameOver((a, b), target, r, cap)
                            Check.eq(
                                gotOver, wantOver,
                                "\(name): \(a)-\(b) to \(target) under \(cap.rawValue)")
                            if gotOver { everOver += 1 } else { everLive += 1 }

                            // A drawn game is never over: somebody has to win it.
                            Check.ok(a != b || !gotOver, "\(name): \(a)-\(a) is never a finished game")
                            Check.eq(
                                isGameOver((b, a), target, r, cap), gotOver,
                                "\(name): the verdict is symmetric at \(a)-\(b)")
                        }
                    }
                }
            }

            Check.ok(everOver > 0 && everLive > 0, "\(name): the sweep reached both verdicts")

            // The named cases, spelled out.
            Check.eq(
                effectiveTarget((0, 0), r, .none), r.gameTo,
                "\(name): an untimed game plays to the format's target")
            Check.eq(
                effectiveTarget((r.pointCap, r.pointCap - 2), r, .soft), r.pointCap,
                "\(name): a soft cap never pushes the target past the point cap")
            Check.ok(
                isGameOver((r.pointCap, r.pointCap - 1), 999, r, .none),
                "\(name): the point cap ends the game even against a stale target")
            Check.ok(
                !isGameOver((r.pointCap, r.pointCap), 999, r, .none),
                "\(name): but not while it is level — somebody must win it")
            Check.ok(
                isGameOver((r.gameTo, r.gameTo - r.winBy), r.gameTo, r, .none),
                "\(name): reaching the target with the winning margin ends it")
            if r.winBy > 1 {
                Check.ok(
                    !isGameOver((r.gameTo, r.gameTo - 1), r.gameTo, r, .none),
                    "\(name): win-by-two does not end on a one-point lead")
                Check.ok(
                    isGameOver((r.gameTo, r.gameTo - 1), r.gameTo, r, .hard),
                    "\(name): but a hard cap ends it on any lead")
            }
        }
    }

    // MARK: - the two involutions

    private static func involutions() {
        for d in [1, -1] {
            Check.eq(flipDir(flipDir(d)), d, "flipDir is its own inverse, from \(d)")
            Check.eq(flipDir(d), -d, "and it really is a negation, from \(d)")
        }
        // Total: anything that is not +1 comes back as +1, so the machine can never end up
        // attacking a direction that is neither.
        for d in [0, 2, -7, 99] {
            Check.eq(flipDir(d), 1, "flipDir of the nonsense value \(d) is still a direction")
        }
        for t in [0, 1] {
            Check.eq(otherTeam(otherTeam(t)), t, "otherTeam is its own inverse, from \(t)")
            Check.ok(otherTeam(t) != t, "and never returns the same team, from \(t)")
        }
        for t in [2, -1, 7] {
            Check.eq(otherTeam(t), 0, "otherTeam of the nonsense value \(t) is still a team")
        }

        // v3 and copy are the vector constructors the rest of the file is written in.
        expectVec(v3(), Vec3d.zero, "v3() is the origin")
        expectVec(v3(1, 2, 3), Vec3d(1, 2, 3), "v3 takes its arguments in order")
        expectVec(v3(4), Vec3d(4, 0, 0), "and defaults the rest to zero")
        let p = Vec3d(-1.5, 2.25, 9)
        expectVec(copy(p), p, "copy is the identity on a value type")

        // distXZ is the planar distance every rule in this file is measured with.
        var rng = Sample(0x0D15_8888)
        for _ in 0..<10_000 {
            let a = Vec3d(rng.unit(-50, 50), rng.unit(-3, 3), rng.unit(-50, 50))
            let b = Vec3d(rng.unit(-50, 50), rng.unit(-3, 3), rng.unit(-50, 50))
            let c = Vec3d(rng.unit(-50, 50), 0, rng.unit(-50, 50))
            let d = distXZ(a, b)
            Check.ok(d >= 0, "distXZ is never negative")
            Check.bitEq(distXZ(b, a), d, "distXZ is symmetric")
            Check.bitEq(
                distXZ(a, Vec3d(b.x, b.y + 12, b.z)), d, "distXZ ignores height, by construction")
            Check.ok(
                distXZ(a, c) <= distXZ(a, b) + distXZ(b, c) + 1e-9,
                "distXZ satisfies the triangle inequality")
        }
        Check.bitEq(distXZ(.zero, .zero), 0, "and is zero on a point against itself")
        Check.bitEq(distXZ(.zero, Vec3d(3, 99, 4)), 5, "3-4-5, whatever the height")
    }

    // MARK: - helpers

    private static func expectVec(_ got: Vec3d, _ want: Vec3d, _ what: String) {
        Check.bitEq(got.x, want.x, "\(what).x")
        Check.bitEq(got.y, want.y, "\(what).y")
        Check.bitEq(got.z, want.z, "\(what).z")
    }
}
