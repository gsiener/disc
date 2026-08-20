import Foundation
import UltimateSim

/// THE LINE-UP BEFORE A PULL — against the rules of Ultimate, not a recording of one.
///
/// # What the sport says
///
/// WFDF 2021 rule 12.1-12.2 (USAU 11th ed. 8.A): before every pull, *all* players line up
/// on their own goal line — the goal line of the end zone their team is defending — the
/// two teams facing each other, and nobody may cross that line until the disc is
/// released. That is four separate, checkable claims about `Engine.stagePoint`:
///
///  - **which line**: a team stands on the line it defends, not the one it attacks;
///  - **on it**: on the line, not in front of it;
///  - **on the pitch**: fourteen bodies between two sidelines, spread rather than stacked;
///  - **facing**: each team looks the way it attacks, so the two lines face each other.
///
/// # Why the old fixture could not say any of that
///
/// `lineup.json` recorded eight seeds' worth of `(x, z, facing)` for fourteen players. It
/// is a table of 336 coordinates, and the only claim it can make is "these are the numbers
/// the reference produced" — a claim that is *weaker than the truth in one direction and
/// stronger in another*. Weaker, because it cannot say that the formation is the same
/// under every seed, which it is and which is the property that matters (a formation that
/// varied with the seed would be a different bug on every fixture regeneration). Stronger,
/// because it pins `y`, which the port deliberately does not model, and it pins one
/// format, because the reference has only one pitch.
///
/// So this suite asserts the rule and the shape instead:
///
///  - **The rule**, cited, above.
///  - **A law**: the formation is a function of `(team, slot)` and of nothing else. Not of
///    the seed, not of the point number except through the attacking direction, not of who
///    is on the line. Swept over eight seeds, both formats, and the points either side of
///    halftime.
///  - **`Model`**: the spacing is restated from its description — evenly spaced across the
///    line, symmetric about the centre, a fixed margin in from each sideline — and
///    evaluated a second way (as a symmetric span with equal gaps) rather than by
///    re-running the implementation's own expression.
///  - **Exact values for the two tuning numbers this formation contains**, the 3.5 m
///    sideline margin and the 0.5 m depth offset, because a relation is right for a law and
///    wrong for a tuning number.
///
/// # A rules bug, asserted as it behaves and labelled as wrong
///
/// See `everybodyStandsHalfAMetreOffside()`. Both lines are staged **0.5 m into the field
/// of play**, in front of the goal line they are supposed to be standing on. Under WFDF
/// 12.2 that is offside, for both teams, on every pull this simulation has ever thrown.
enum LineupTests {

    // MARK: - entry point

    static func run() throws {
        theFormationIsSeedIndependent()
        eachTeamStandsOnTheLineItDefends()
        everybodyStandsHalfAMetreOffside()
        theSpacingIsEvenAndCentred()
        theMarginsArePinned()
        theTwoLinesFaceEachOther()
        nobodyIsStackedOrOffThePitch()
        theEndsSwapAndTheFormationFollows()
        theLineIsTheRoster()
    }

    // MARK: - a common sample

    /// Eight seeds — the same spread `lineup.json` used, kept because they are arbitrary
    /// and nothing here is tuned to them.
    private static let seeds: [UInt32] = [11, 22, 33, 44, 55, 66, 77, 88]

    private static let formats: [(String, GameFormat)] = [
        ("sevens", .sevens), ("minis", .minis),
    ]

    /// One engine, freshly constructed, so the read is at the zero-tick instant
    /// `stagePoint()` leaves behind.
    ///
    /// `Engine.init` calls `stagePoint()` on its own last line, so nothing has ticked, no
    /// `TeamAI` has moved anybody, and the bodies are exactly where the formation put
    /// them. That is what makes "the formation is a function of `(team, slot)`" a
    /// statement about the formation rather than about one frame of locomotion.
    private static func staged(
        _ format: GameFormat, seed: UInt32, pullingTeam: TeamId = 1
    ) -> Engine {
        var cfg = EngineConfig()
        cfg.startingPullTeam = pullingTeam
        return Engine(format: format, seed: seed, config: cfg)
    }

    /// Where slot `i` of team `t` is standing, in the plane. Nil if that body is missing,
    /// which is itself a failure and reported by the caller.
    private static func spot(_ e: Engine, team: TeamId, slot: Int) -> (Vec3d, Double)? {
        let id = team * e.format.playersPerSide + slot
        guard let lp = e.loco.get(id) else { return nil }
        return (lp.pos, lp.facing)
    }

    // MARK: - the law: the formation is a function of (team, slot)

    /// **The property the fixture could not express.** Where a player stands before the
    /// pull depends on which team he is on and which slot he occupies — and on nothing
    /// else.
    ///
    /// Not on the seed: the roster deal draws athletes, not positions, and a formation
    /// that moved with the seed would mean the opening shape of a match was random. Not on
    /// who is standing there: a line is a shape, and the shape is the same whichever seven
    /// people the deal produced.
    ///
    /// Eight seeds are compared against the first seed's formation, coordinate by
    /// coordinate, bit-exactly — there is no arithmetic between them that could round
    /// differently, so anything but bit-equality here is a real dependence.
    private static func theFormationIsSeedIndependent() {
        for (label, format) in formats {
            guard let first = seeds.first else { continue }
            let reference = staged(format, seed: first)

            for seed in seeds.dropFirst() {
                let e = staged(format, seed: seed)
                for t in 0..<2 {
                    for slot in 0..<format.playersPerSide {
                        guard let (want, wantFacing) = spot(reference, team: t, slot: slot),
                            let (got, gotFacing) = spot(e, team: t, slot: slot)
                        else {
                            Check.ok(false, "\(label)/s\(seed): team \(t) slot \(slot) has no body")
                            continue
                        }
                        let at = "\(label)/s\(seed): team \(t) slot \(slot)"
                        Check.bitEq(got.x, want.x, "\(at) stands where seed \(first) stands (x)")
                        Check.bitEq(got.z, want.z, "\(at) stands where seed \(first) stands (z)")
                        Check.bitEq(gotFacing, wantFacing, "\(at) faces the same way (facing)")
                    }
                }
            }
        }
    }

    // MARK: - the rule: which line

    /// WFDF 12.1 — a team lines up on the goal line of the end zone it is **defending**.
    ///
    /// The end a team defends is the one behind it: at attacking direction `dir`, its own
    /// goal line is at `z = -dir * goalLine`. Getting this backwards puts both teams in the
    /// same half and the pull is thrown the wrong way down the pitch, which is a bug no
    /// coordinate table can name — every number in it would still be a plausible position.
    ///
    /// Asserted for both starting pull teams, because `dir` is threaded from
    /// `game.attackDir` and a formation that read the wrong team's direction would be
    /// symmetric under the default and wrong under the swap.
    private static func eachTeamStandsOnTheLineItDefends() {
        for (label, format) in formats {
            for pulling in [TeamId(0), 1] {
                let e = staged(format, seed: 11, pullingTeam: pulling)
                for t in 0..<2 {
                    let dir = Double(e.dirFor(t))
                    let ownLine = -dir * format.field.goalLine
                    for slot in 0..<format.playersPerSide {
                        guard let (p, _) = spot(e, team: t, slot: slot) else { continue }
                        let at = "\(label)/pull\(pulling): team \(t) slot \(slot)"
                        // Same side of the halfway line as the end zone it defends, and
                        // within a metre of that goal line — the tolerance is the depth
                        // offset checked exactly in the next function.
                        Check.ok(
                            p.z * dir < 0,
                            "\(at) is in the half it defends (z=\(p.z), attacks dir \(dir))")
                        Check.ok(
                            abs(p.z - ownLine) <= 1,
                            "\(at) is on its own goal line (z=\(p.z), line \(ownLine))")
                    }
                    // The two teams are on opposite lines, a whole central zone apart.
                    guard let (mine, _) = spot(e, team: t, slot: 0),
                        let (theirs, _) = spot(e, team: otherTeam(t), slot: 0)
                    else { continue }
                    Check.ok(
                        mine.z * theirs.z < 0,
                        "\(label)/pull\(pulling): the two lines are on opposite sides of "
                            + "halfway (\(mine.z) against \(theirs.z))")
                    Check.near(
                        abs(mine.z - theirs.z), 2 * format.field.goalLine, 2,
                        "\(label)/pull\(pulling): and a central zone apart")
                }
            }
        }
    }

    /// **KNOWN DIVERGENCE FROM THE RULES OF ULTIMATE — reported, not endorsed.**
    ///
    /// WFDF 12.2: "*all offensive players must stand with one foot on their defending goal
    /// line*", and no player may cross that line until the pull is released. This
    /// formation stands every player on **both** teams exactly 0.5 m *in front of* the line
    /// — into the field of play, toward the end zone they attack. Every pull in this
    /// simulation is thrown by a team that is offside, to a team that is offside.
    ///
    /// It is asserted here as it actually behaves, exactly, and labelled, rather than being
    /// quietly folded into a tolerance in the function above. The number is a tuning value
    /// (there is no rulebook figure for "how far past the line to stand", because the
    /// answer is zero), so it is pinned bit-exactly: an implementation that changed it to
    /// 0.4 m would be no more legal and should still fail this and be looked at.
    ///
    /// Fixing it is a one-character change — drop the `+ dir * 0.5` — and it is deliberately
    /// not made here, because it moves every body on every opening line and therefore every
    /// match trajectory downstream of one.
    private static func everybodyStandsHalfAMetreOffside() {
        for (label, format) in formats {
            let e = staged(format, seed: 11)
            for t in 0..<2 {
                let dir = Double(e.dirFor(t))
                let ownLine = -dir * format.field.goalLine
                for slot in 0..<format.playersPerSide {
                    guard let (p, _) = spot(e, team: t, slot: slot) else { continue }
                    Check.bitEq(
                        (p.z - ownLine) * dir, 0.5,
                        "\(label): team \(t) slot \(slot) stands 0.5 m past its own goal line "
                            + "— OFFSIDE under WFDF 12.2, pinned as it behaves")
                }
            }
        }
    }

    // MARK: - Model: the spacing

    /// The line is evenly spaced, symmetric about the centre, and set in from each
    /// sideline by the same margin.
    ///
    /// That description is implemented here a second time and in a different shape from
    /// `stagePoint`'s. The implementation writes an affine map from slot index to `x`;
    /// this model states three independent properties of the resulting *set* of positions
    /// — that consecutive gaps are all equal, that the set is symmetric under `x -> -x`,
    /// and that the two extremes sit the same distance in from opposite sidelines — none
    /// of which is a transcription of that expression. A wrong affine map fails at least
    /// one of them: a wrong span breaks the margins, a wrong offset breaks the symmetry, a
    /// non-linear index breaks the equal gaps.
    ///
    /// Minis has three to a side, so there is exactly one interior gap and the equal-gaps
    /// clause is vacuous there — which is why symmetry and the margin are asserted
    /// separately rather than being folded into one check on the span.
    private static func theSpacingIsEvenAndCentred() {
        for (label, format) in formats {
            let e = staged(format, seed: 11)
            for t in 0..<2 {
                var xs: [Double] = []
                for slot in 0..<format.playersPerSide {
                    guard let (p, _) = spot(e, team: t, slot: slot) else { continue }
                    xs.append(p.x)
                }
                guard xs.count == format.playersPerSide, let lo = xs.first, let hi = xs.last
                else {
                    Check.ok(false, "\(label): team \(t) did not stand a full line up")
                    continue
                }
                let at = "\(label): team \(t)"

                // Monotone in the slot index: slot order is left-to-right across the line,
                // which is what makes "slot" mean anything to anything downstream.
                for i in 1..<xs.count {
                    Check.ok(
                        xs[i] > xs[i - 1],
                        "\(at) slot \(i) stands to the right of slot \(i - 1)")
                }

                // Equal gaps.
                let gap = (hi - lo) / Double(max(1, format.playersPerSide - 1))
                for i in 1..<xs.count {
                    Check.near(
                        xs[i] - xs[i - 1], gap, 1e-12,
                        "\(at): the gap from slot \(i - 1) to \(i) is the line's own gap")
                }

                // Symmetric about the centre of the pitch.
                Check.near(lo + hi, 0, 1e-12, "\(at): the line is centred on x = 0")
                for i in 0..<xs.count {
                    let mirror = xs[xs.count - 1 - i]
                    Check.near(
                        xs[i], -mirror, 1e-12,
                        "\(at): slot \(i) mirrors slot \(xs.count - 1 - i)")
                }

                // Same margin in from each sideline.
                Check.near(
                    lo + format.field.sideline, format.field.sideline - hi, 1e-12,
                    "\(at): the two ends of the line stand the same distance in from "
                        + "their own sideline")

                // And both teams stand the same line, laterally — the shape is a property
                // of the pitch, not of which end you are at.
                if t == 1 {
                    for slot in 0..<format.playersPerSide {
                        guard let (mine, _) = spot(e, team: 1, slot: slot),
                            let (theirs, _) = spot(e, team: 0, slot: slot)
                        else { continue }
                        Check.bitEq(
                            mine.x, theirs.x,
                            "\(label): slot \(slot) stands at the same x on both lines")
                    }
                }
            }
        }
    }

    /// The two tuning numbers in the formation, pinned.
    ///
    /// Neither comes from a rulebook. The sport says "on the line" and says nothing at all
    /// about how far in from the sideline the outermost player stands, so 3.5 m is a
    /// choice: it is roughly the width of the lane a puller needs to run into, and it is
    /// wide enough that the outside body is not on the chalk. The 0.5 m depth is the
    /// offside recorded above.
    ///
    /// Pinned bit-exactly, and derived from the *measured* positions rather than read back
    /// out of the source, so a change to the formula that happened to preserve the shape
    /// but move the margin still fails here. Issue #58's own lesson: a relation
    /// (`margin > 0`, `margin < sideline`) stays true across every value the number could
    /// take, which makes it worth nothing as a pin.
    private static func theMarginsArePinned() {
        for (label, format) in formats {
            let e = staged(format, seed: 11)
            guard let (left, _) = spot(e, team: 0, slot: 0),
                let (right, _) = spot(e, team: 0, slot: format.playersPerSide - 1)
            else {
                Check.ok(false, "\(label): the line is not standing")
                continue
            }
            Check.bitEq(
                left.x + format.field.sideline, 3.5,
                "\(label): the outermost player stands 3.5 m in from the sideline "
                    + "(tuning: no rulebook figure)")
            Check.bitEq(
                format.field.sideline - right.x, 3.5,
                "\(label): and 3.5 m in from the other one")
            Check.bitEq(
                right.x - left.x, 2 * format.field.sideline - 7,
                "\(label): so the line spans the pitch less two 3.5 m margins")
        }
    }

    // MARK: - the rule: facing

    /// The two lines face each other: each player looks the way his team attacks.
    ///
    /// `facing` is an angle about the vertical with 0 along +Z, so a team attacking +1
    /// faces 0 and a team attacking −1 faces π. Stated as a *direction* rather than as
    /// those two numbers: `(sin f, cos f)` must be the unit vector pointing the way the
    /// team attacks, which is the same claim without depending on which of the two
    /// equivalent angles the implementation picked for "backwards".
    private static func theTwoLinesFaceEachOther() {
        for (label, format) in formats {
            for pulling in [TeamId(0), 1] {
                let e = staged(format, seed: 11, pullingTeam: pulling)
                for t in 0..<2 {
                    let dir = Double(e.dirFor(t))
                    for slot in 0..<format.playersPerSide {
                        guard let (_, f) = spot(e, team: t, slot: slot) else { continue }
                        let at = "\(label)/pull\(pulling): team \(t) slot \(slot)"
                        Check.near(
                            Foundation.cos(f), dir, 1e-12,
                            "\(at) faces the way it attacks (downfield component)")
                        Check.near(
                            Foundation.sin(f), 0, 1e-12,
                            "\(at) faces straight down the pitch, not across it")
                    }
                    // …and the other line looks back.
                    guard let (_, mine) = spot(e, team: t, slot: 0),
                        let (_, theirs) = spot(e, team: otherTeam(t), slot: 0)
                    else { continue }
                    Check.near(
                        Foundation.cos(mine) + Foundation.cos(theirs), 0, 1e-12,
                        "\(label)/pull\(pulling): team \(t) and team \(otherTeam(t)) face "
                            + "opposite ways")
                }
            }
        }
    }

    /// Fourteen bodies, all on the pitch, none on top of another.
    ///
    /// The in-bounds clause is the one with teeth on minis, where the same 3.5 m margin is
    /// taken out of a 18 m pitch rather than a 37 m one and a formula that scaled wrongly
    /// would put the outside bodies over the chalk.
    private static func nobodyIsStackedOrOffThePitch() {
        for (label, format) in formats {
            for seed in seeds {
                let e = staged(format, seed: seed)
                var seen: [Vec3d] = []
                for t in 0..<2 {
                    for slot in 0..<format.playersPerSide {
                        guard let (p, _) = spot(e, team: t, slot: slot) else {
                            Check.ok(false, "\(label)/s\(seed): team \(t) slot \(slot) missing")
                            continue
                        }
                        Check.ok(
                            format.field.isInBounds(Vec3d(p.x, 0, p.z)),
                            "\(label)/s\(seed): team \(t) slot \(slot) is on the pitch "
                                + "(\(p.x), \(p.z))")
                        for q in seen {
                            Check.ok(
                                distXZ(p, q) > 0.5,
                                "\(label)/s\(seed): team \(t) slot \(slot) is not standing "
                                    + "on somebody else")
                        }
                        seen.append(p)
                    }
                }
                Check.eq(
                    seen.count, 2 * format.playersPerSide,
                    "\(label)/s\(seed): both full lines are standing")
            }
        }
    }

    // MARK: - the rule: the ends swap

    /// The formation follows the attacking direction, point by point — including across
    /// halftime, where it does **not** move.
    ///
    /// Teams change ends after every goal (WFDF 12.1: the scoring team stays in the end zone
    /// it scored in and pulls from there), so the line a team stands on this point is the
    /// other line from the one it stood on last point. **Except at halftime**, where WFDF
    /// 10.3 swaps the ends a second time — so the two flips cancel and a team opens the
    /// first point of the second half on the same line it opened the last point of the
    /// first. That cancellation is the interesting half of this: an implementation that
    /// only ever alternated would look right for a whole half and be wrong from the break
    /// onward.
    ///
    /// Driven through a real match rather than by poking `attackDir`, because the thing
    /// under test is that `stagePoint` re-reads the direction each time it re-stages, which
    /// a direct write would not exercise. Positions are sampled on the first tick of each
    /// new point, so a body has had at most one frame to drift off the line it was staged
    /// on — hence a tolerance here, with the bit-exact spot asserted at zero ticks in
    /// `everybodyStandsHalfAMetreOffside()`.
    private static func theEndsSwapAndTheFormationFollows() {
        let format = GameFormat.minis
        var cfg = EngineConfig.default
        cfg.pointsToWin = 4
        let e = Engine(format: format, seed: 23, config: cfg)

        var opened: [(point: Int, half: Int, dir0: Dir, z0: Double)] = []
        var lastPoint = 0
        for _ in 0..<(120 * 900) where !e.isOver {
            e.step(dt: 1.0 / 120.0)
            guard e.game.phase == .prePull, e.game.point != lastPoint else { continue }
            lastPoint = e.game.point
            guard let (p, _) = spot(e, team: 0, slot: 0) else { continue }
            opened.append((e.game.point, e.game.half, e.dirFor(0), p.z))
        }

        Check.ok(opened.count >= 3, "the match opened \(opened.count) points to look at")
        var directions: Set<Dir> = []
        var swaps = 0
        var breaks = 0
        for o in opened {
            let dir = Double(o.dir0)
            directions.insert(o.dir0)
            Check.ok(
                o.z0 * dir < 0,
                "point \(o.point): team 0 opens in the half it is defending this point")
            Check.near(
                o.z0, -dir * format.field.goalLine + dir * 0.5, 0.05,
                "point \(o.point): on the line it defends, which moved with the direction")
        }
        for i in 1..<max(1, opened.count) {
            let sameHalf = opened[i].half == opened[i - 1].half
            if sameHalf {
                swaps += 1
                Check.ok(
                    opened[i].dir0 != opened[i - 1].dir0,
                    "point \(opened[i].point): the ends swapped after the goal (WFDF 12.1), "
                        + "so the line did")
                Check.ok(
                    opened[i].z0 * opened[i - 1].z0 < 0,
                    "point \(opened[i].point): and team 0 is standing on the other line")
            } else {
                breaks += 1
                Check.eq(
                    opened[i].dir0, opened[i - 1].dir0,
                    "point \(opened[i].point): across halftime the goal-swap and the "
                        + "halftime swap cancel (WFDF 10.3), so the ends are unchanged")
                Check.ok(
                    opened[i].z0 * opened[i - 1].z0 > 0,
                    "point \(opened[i].point): and team 0 opens on the line it just left")
            }
        }
        Check.eq(directions.count, 2, "team 0 attacked both ends over the match")
        Check.ok(swaps > 0, "\(swaps) points swapped ends within a half")
        Check.ok(breaks > 0, "and \(breaks) crossed the break, where they do not")
    }

    /// The line is the roster: `playersPerSide` a side, ids dealt `team * n + slot`, and
    /// the machine's declared line is the same fourteen people the bodies belong to.
    ///
    /// This is the seam a substitution system would arrive through, and it is the reason
    /// `spot(_:team:slot:)` above may index by arithmetic at all.
    private static func theLineIsTheRoster() {
        for (label, format) in formats {
            let e = staged(format, seed: 11)
            Check.eq(
                e.players.count, 2 * format.playersPerSide,
                "\(label): both squads are dealt")
            for t in 0..<2 {
                let mine = e.players.filter { $0.team == t }.map(\.id).sorted()
                Check.eq(
                    mine, (0..<format.playersPerSide).map { t * format.playersPerSide + $0 },
                    "\(label): team \(t)'s ids are team * \(format.playersPerSide) + slot")
                Check.eq(
                    e.game.lines[t].sorted(), mine,
                    "\(label): and the machine's declared line is those same people")
            }
        }
    }
}
