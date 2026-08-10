import Foundation
import UltimateSim

/// FOUR SURFACES THAT HAVE ALREADY FAILED SILENTLY, EACH GUARDED UNTIL NOW BY "THE MATCH
/// DID NOT HANG".
///
/// Every check in this file names a regression that is recorded in the engine's own
/// comments as having shipped. That is the selection rule, and it is the reason this is a
/// separate suite rather than more of `EngineTests`: those are match-level properties —
/// a pull is thrown, nobody leaves the pitch, one seed is one match — and a match-level
/// property is exactly what each of these four bugs survived.
///
///   - **Marker inference.** `Engine.observation` reports the nearest defender inside
///     `markerRange + 0.6` as the mark, and `GameState` will not advance the count unless
///     that report says a legal mark exists. Both halves — the slack and the
///     nearest-wins tiebreak — were untested. Break either and the count silently stops
///     or silently starts, and the only visible symptom is that points take a different
///     length of time.
///   - **`collectDeadDisc`.** The pickup radius escalates after `pickupDwell` because
///     `AI.ts` caps a body's speed by the room left to the perimeter, so a disc on the
///     chalk is unreachable and the collector parks a metre short of it. The reference
///     measured one seed sitting in `TURNOVER_DEAD` for 152 seconds. Separately, a
///     stall-out is the one turnover that never takes the disc out of anyone's hand, and
///     for a while it did not.
///   - **`autoPull` / `solvePower`.** The pull shapes every point start and only "a pull
///     is thrown" was asserted. `solvePower` bisects the real flight model precisely
///     because the two pitches differ by a factor of nearly three and one constant
///     cannot serve both.
///   - **`syncDisc`'s control rule.** "You are always the player with a decision to
///     make" is the entire control scheme of the game and had no check at all.
///
/// **Where a bound would be satisfied by a wrong implementation, a property is asserted
/// instead.** The pickup radius is not checked against 1.6 and 3.6; it is checked by the
/// pair of facts that a body at 2.5 m is refused early and served late, which no single
/// radius can produce. The pull is not checked against a distance in metres; it is
/// checked by carrying the *same fraction of the pitch* on two pitches whose goal lines
/// differ by 2.56x, which no fixed power can produce. The marker is not checked by
/// "somebody is marking"; it is checked by moving two defenders past each other and
/// requiring the answer to swap.
enum EngineSeamTests {

    static let dt = 1.0 / 120.0

    static func run() throws {
        theMarkIsTheNearestDefenderInsideTheSlack()
        theMarkFollowsTheGeometryAndNotTheRoster()
        theCountRunsForALegalMarkAndOnlyThen()
        theDeadDiscEscalatesItsReach()
        aStallOutTakesTheDiscOutOfTheHand()
        thePullSpotIsNeverWorseThanTheBrick()
        thePullIsSolvedForThePitchItIsThrownOn()
        controlFollowsTheDisc()
    }

    // MARK: - getting to a live possession

    /// An engine parked on a live possession with a holder, and with both AIs' *throws*
    /// switched off so the disc stays in the hand while a check manipulates the bodies.
    ///
    /// `autoTeams` gates releases only — `updateTeam` still runs for both sides — so the
    /// defence keeps marking and the offence keeps cutting. That is what makes a held
    /// disc a stable fixture rather than a frozen one.
    private static func heldPossession(seed: UInt32, format: GameFormat = .minis) -> Engine? {
        let e = Engine(format: format, seed: seed)
        e.autoTeams = [0, 1]
        for _ in 0..<(120 * 180) {
            e.step(dt: dt)
            if e.game.phase == .livePossession, e.carrier != nil, e.game.thrower != nil {
                e.autoTeams = []
                return e
            }
        }
        return nil
    }

    /// Stand the defence up for one tick: `gaps[i]` metres from the holder along +x for
    /// the first `gaps.count` defenders, everybody else parked 25 m away — well outside
    /// both `markerRange` and `doubleTeamRange`, so nothing but the placed bodies can
    /// affect the answer. Returns the defenders in roster order.
    ///
    /// Placement is on `AIPlayer.pos`, and it survives exactly one `step` because
    /// `Engine.step` builds its `FrameObservation` **before** locomotion moves anybody.
    /// That ordering is the fixture.
    @discardableResult
    private static func standTheDefence(_ e: Engine, _ gaps: [Double]) -> [AIPlayer] {
        guard let c = e.carrier, let holder = e.body(of: c) else { return [] }
        let defence = e.players.filter { $0.team != holder.team }
        for (i, d) in defence.enumerated() {
            let gap = i < gaps.count ? gaps[i] : 25.0
            d.pos = Vec3d(holder.pos.x + gap, d.pos.y, holder.pos.z)
            d.vel = .zero
        }
        return defence
    }

    // MARK: - the marker, and the slack that decides whether the count runs

    /// THE +0.6, AT ITS TWO EDGES.
    ///
    /// `observation` reports the nearest defender within `markerRange + 0.6`; `GameState`
    /// then runs `markerStatus`, which needs `d <= markerRange` for `.legal`. So the
    /// slack does not extend the mark — it extends who is *named* as the mark, and being
    /// named is what `policeTravel` and the marking-foul detector both require, and what
    /// separates `markerState == .outOfRange` from `.none`.
    ///
    /// Three probes, and the middle one is the whole test:
    ///
    ///   - 2.5 m: inside `markerRange`. Named, and legal.
    ///   - 3.3 m: outside `markerRange`, inside the slack. **Named, and not legal.**
    ///   - 3.9 m: outside the slack. Not named at all.
    ///
    /// Delete the `+ 0.6` and the middle probe reports no marker. Widen it to a metre and
    /// the last probe reports one. Neither is reachable from any match-level statistic,
    /// which is why both were free to be wrong.
    private static func theMarkIsTheNearestDefenderInsideTheSlack() {
        guard let e = heldPossession(seed: 11) else {
            Check.ok(false, "marker slack: no live possession inside three minutes")
            return
        }
        let range = e.rules.markerRange

        for (gap, wantNamed, wantState) in [
            (range - 0.5, true, MarkerStatus.legal),
            (range + 0.3, true, MarkerStatus.outOfRange),
            (range + 0.9, false, MarkerStatus.none),
        ] {
            let defence = standTheDefence(e, [gap])
            guard let near = defence.first else {
                Check.ok(false, "marker slack: no defence to stand up")
                return
            }
            e.step(dt: dt)
            Check.eq(
                e.game.marker, wantNamed ? near.id : nil,
                "a defender \(gap) m from the thrower is "
                    + "\(wantNamed ? "named as the mark" : "too far to be the mark") "
                    + "(markerRange \(range) + 0.6 of slack)")
            Check.eq(
                e.game.markerState, wantState,
                "and the machine grades that mark \(wantState)")
        }
    }

    /// NEAREST WINS, AND THE ANSWER MOVES WHEN THE BODIES DO.
    ///
    /// The tiebreak is a plain `d < bd` scan, so a wrong implementation that returns the
    /// *first* defender in roster order, or the assigned matchup rather than the body
    /// actually standing there, passes any check that only asks whether somebody is
    /// marking. The property it cannot pass is this one: swap which of two defenders is
    /// nearer and the named mark must swap with them.
    ///
    /// Both are placed inside the slack and both inside `doubleTeamRange`, so the grade
    /// is not the subject here — only the identity is.
    private static func theMarkFollowsTheGeometryAndNotTheRoster() {
        guard let e = heldPossession(seed: 23) else {
            Check.ok(false, "marker tiebreak: no live possession inside three minutes")
            return
        }
        let defence = standTheDefence(e, [2.6, 1.8])
        guard defence.count >= 2 else {
            Check.ok(false, "marker tiebreak: needs two defenders")
            return
        }
        let far = defence[0]
        let near = defence[1]

        standTheDefence(e, [2.6, 1.8])
        e.step(dt: dt)
        Check.eq(e.game.marker, near.id, "the nearer of two defenders is the mark")

        standTheDefence(e, [1.8, 2.6])
        e.step(dt: dt)
        Check.eq(
            e.game.marker, far.id,
            "and swapping which one is nearer swaps the mark — the scan reads the "
                + "geometry, not the roster order")
    }

    /// THE COUNT RUNS FOR A LEGAL MARK AND FOR NOTHING ELSE.
    ///
    /// The slack's consequence, stated as the thing a player would actually notice. Half
    /// a second of a marker at 2.5 m must put half a second on `stallElapsed`; half a
    /// second of the same defender 0.8 m further away must put none on it, because
    /// `tickStall` refuses to advance unless `markerState == .legal`.
    ///
    /// Asserted as a *delta over a window* rather than as a count, because a count is an
    /// integer that a badly-wrong implementation can land on by accident and a monotone
    /// accumulator over sixty ticks cannot.
    private static func theCountRunsForALegalMarkAndOnlyThen() {
        for (gap, shouldRun) in [(2.5, true), (3.3, false)] {
            guard let e = heldPossession(seed: 37) else {
                Check.ok(false, "stall window: no live possession inside three minutes")
                return
            }
            let before = e.possessionTime
            var ticks = 0
            for _ in 0..<60 {
                guard e.game.phase == .livePossession, e.carrier != nil else { break }
                standTheDefence(e, [gap])
                e.step(dt: dt)
                ticks += 1
            }
            let grew = e.possessionTime - before
            Check.ok(ticks >= 50, "stall window at \(gap) m: the possession survived \(ticks) ticks")
            if shouldRun {
                Check.near(
                    grew, Double(ticks) * dt, 2 * dt,
                    "a mark at \(gap) m runs the count for every tick it is legal")
            } else {
                Check.near(
                    grew, 0, 1e-9,
                    "a mark at \(gap) m is named but out of range, so the count does not "
                        + "move at all")
            }
        }
    }

    // MARK: - the dead disc

    /// THE PICKUP RADIUS IS A FUNCTION OF TIME, AND THAT IS THE WHOLE POINT.
    ///
    /// A dead disc on the chalk cannot be reached: `AI.ts` caps every body's speed by the
    /// room left to the perimeter, so the collector stops a metre short and, with a
    /// single fixed radius, stands there for the rest of the match — 152 seconds in
    /// `TURNOVER_DEAD` on the seed that found it. `collectDeadDisc` answers that by
    /// widening its reach after `pickupDwell`: after long enough standing over it, he
    /// bends down and takes it.
    ///
    /// Two runs of the same fixture, and neither one alone says anything:
    ///
    ///   - a collector held at **2.5 m** — outside `pickupRadius`, inside
    ///     `pickupDwellRadius` — must be refused until the dwell has elapsed, and served
    ///     shortly after it;
    ///   - a collector held at **1.0 m** must be served almost at once.
    ///
    /// A wrong implementation with no escalation hangs the first. One whose base radius
    /// is already the dwell radius serves the first immediately and fails it the other
    /// way. There is no single number that passes both.
    private static func theDeadDiscEscalatesItsReach() {
        for (gap, wantEarly) in [(2.5, false), (1.0, true)] {
            guard let (e, team) = deadDisc(seed: 11) else {
                Check.ok(false, "dead disc at \(gap) m: no turnover inside three minutes")
                return
            }
            let spot = e.game.discPos
            // Toward the middle of the pitch, so a disc near a sideline does not put the
            // collector off the park — the placement is the fixture, not the test.
            let inward = Vec3d(spot.x >= 0 ? -1 : 1, 0, 0)

            var servedAt: Double?
            for _ in 0..<(120 * 8) {
                guard e.game.phase == .turnoverDead else { break }
                let waited = e.game.phaseTimer
                for p in e.players where p.team == team {
                    p.pos = Vec3d(spot.x + inward.x * gap, p.pos.y, spot.z)
                    p.vel = .zero
                }
                e.step(dt: dt)
                if e.game.phase != .turnoverDead {
                    // `collectDeadDisc` sees `phaseTimer` *after* `game.step` has already
                    // added this tick's `dt`, so the timer it compared against the dwell
                    // is one tick later than the one read above.
                    servedAt = waited + dt
                    break
                }
            }

            guard let servedAt else {
                Check.ok(
                    false,
                    "a collector standing \(gap) m from a dead disc was never served — "
                        + "this is the 152-second hang")
                continue
            }
            let dwell = e.config.pickupDwell
            if wantEarly {
                Check.ok(
                    servedAt < dwell,
                    "a collector \(gap) m away is inside the standing radius and is served "
                        + "at once (\(servedAt) s, dwell is \(dwell) s)")
            } else {
                Check.ok(
                    servedAt >= dwell - 1e-9,
                    "a collector \(gap) m away is refused until the dwell has run "
                        + "(\(servedAt) s, dwell is \(dwell) s)")
                Check.ok(
                    servedAt < dwell + 0.5,
                    "and served promptly once it has — the escalation is a reach, not a "
                        + "second wait (\(servedAt) s)")
            }
        }
    }

    /// THE ONE TURNOVER THAT LEAVES THE DISC IN THE THROWER'S HAND.
    ///
    /// Every other turnover moves the disc physically. A stall-out does not: the machine
    /// takes the possession away and nothing tells the runtime to let go, so the disc
    /// stayed held by a player who no longer had it and `carrier` disagreed with
    /// `game.thrower` on every tick of the dead phase. It went unnoticed for the life of
    /// the feature because the AI releases well inside a ten count and never stalled.
    ///
    /// Reached deliberately rather than waited for: `autoTeams` is emptied so no throw is
    /// ever released, and a defender is stood at a legal mark distance every tick so the
    /// count actually runs. Ten seconds later there is a stall-out, which is a legal,
    /// reachable outcome that no automated match had ever produced.
    ///
    /// Two assertions, and the second is the one the comment is about: the disc is out of
    /// the hand, and the match restarts.
    private static func aStallOutTakesTheDiscOutOfTheHand() {
        guard let e = heldPossession(seed: 5) else {
            Check.ok(false, "stall-out: no live possession inside three minutes")
            return
        }
        let stalledBefore = e.stats.stalled

        var reached = false
        for _ in 0..<(120 * 40) {
            if e.game.phase == .livePossession, e.carrier != nil { standTheDefence(e, [2.5]) }
            e.step(dt: dt)
            if e.stats.stalled > stalledBefore {
                reached = true
                break
            }
        }
        guard reached else {
            Check.ok(false, "stall-out: the count never reached ten in forty seconds")
            return
        }
        Check.eq(e.game.thrower, nil, "a stall-out leaves the machine with no thrower")
        Check.eq(
            e.carrier, nil,
            "and takes the disc out of the old thrower's hand — the hand and the "
                + "machine's thrower agree on the very first tick of the dead phase")

        // And the match restarts. Nobody is throwing, so this is `collectDeadDisc` alone
        // getting the disc back into play, which is the half of the same function the
        // escalation check drives from the other side.
        var restarted = false
        for tick in 0..<(120 * 30) {
            e.step(dt: dt)
            Check.ok(
                e.game.thrower != nil || e.carrier == nil,
                "tick \(tick) after the stall: nobody holds a disc the machine says is dead")
            if e.game.phase != .turnoverDead && e.game.phase != .check {
                restarted = true
                break
            }
        }
        Check.ok(restarted, "and the point restarts inside thirty seconds rather than hanging")
    }

    /// An engine parked on a dead disc, with the throws switched off so it stays dead
    /// until this file's own placement decides otherwise.
    private static func deadDisc(seed: UInt32) -> (Engine, TeamId)? {
        let e = Engine(format: .minis, seed: seed)
        e.autoTeams = [0, 1]
        for _ in 0..<(120 * 180) {
            e.step(dt: dt)
            guard e.game.phase == .turnoverDead, !e.game.awaitingPullChoice(),
                let team = e.game.possession
            else { continue }
            e.autoTeams = []
            return (e, team)
        }
        return nil
    }

    // MARK: - the pull

    /// THE BRICK IS A FLOOR, NOT A DEFAULT.
    ///
    /// A pull that sails out hands the receiving team a choice (WFDF 12.4), and this
    /// engine used to force `.brick` at the moment the pull went out — which made
    /// `PullSpotChoice.sideline` unreachable code and quietly cost the receivers the
    /// better mark on exactly the pulls they are owed compensation for.
    ///
    /// The property, over a sweep of deliberately bad pulls: **whatever is chosen is
    /// never further from the receiving team's endzone than the brick would have been.**
    /// That is the rule's purpose rather than its arithmetic, so it survives the constant
    /// being retuned and fails the moment the choice is hard-coded the wrong way.
    ///
    /// Two more, because a floor alone is satisfied by always taking the brick:
    ///
    ///   - both branches must actually be exercised across the sweep, which is what says
    ///     `.sideline` is reachable at all;
    ///   - the physical disc must be where the machine says the spot is. Forgetting that
    ///     leaves the collector standing over a disc the rules put somewhere else, and
    ///     the match never restarts.
    private static func thePullSpotIsNeverWorseThanTheBrick() {
        var brickTaken = 0
        var sidelineTaken = 0
        var oobPulls = 0

        // Aims across the sideline at a range of downfield angles, so the crossing point
        // sweeps from beside the puller to deep in the receivers' half.
        let aims: [Vec3d] = [
            Vec3d(1, 0, 0), Vec3d(1, 0, 0.6), Vec3d(1, 0, 1.2), Vec3d(1, 0, 2.2),
            Vec3d(1, 0, 4.0), Vec3d(0.35, 0, 1),
        ]
        for (i, rawAim) in aims.enumerated() {
            for seed in [UInt32(3), 17] {
                let e = Engine(format: .minis, seed: seed)
                // The computer plays the receiving side only, so the pull is this check's
                // to throw and nothing pulls for it first.
                e.autoTeams = [1]
                for _ in 0..<240 where e.game.phase == .prePull { e.step(dt: dt) }
                guard e.game.phase == .prePull, e.carrier != nil else { continue }

                let dir = Double(e.dirFor(e.game.receivingTeam))
                let aim = Vec3d(rawAim.x, 0, rawAim.z * -dir)
                guard e.humanRelease(.backhand, aim: aim, power: 1) else { continue }

                var crossing: Vec3d?
                var chosen: Vec3d?
                for _ in 0..<(120 * 20) {
                    e.step(dt: dt)
                    if let c = e.game.pullOobCrossing { crossing = c }
                    if crossing != nil, e.game.pullOobCrossing == nil {
                        chosen = e.game.discPos
                        break
                    }
                    if e.game.phase == .livePossession || e.game.phase == .discInFlight { break }
                }
                guard let crossing, let chosen else { continue }
                oobPulls += 1

                let brick = e.format.field.brickMark(e.dirFor(e.game.receivingTeam))
                Check.ok(
                    chosen.z * dir >= brick.z * dir - 0.01,
                    "aim \(i)/s\(seed): the spot the receivers get (\(chosen.z)) is never "
                        + "behind the brick (\(brick.z)), measured up their own attack "
                        + "direction")
                if abs(chosen.z - brick.z) < 0.01 && abs(chosen.x - brick.x) < 0.01 {
                    brickTaken += 1
                } else {
                    sidelineTaken += 1
                    Check.near(
                        chosen.z, crossing.z, 0.01,
                        "aim \(i)/s\(seed): taking it at the sideline means taking it "
                            + "where the disc crossed")
                }
                Check.near(
                    Foundation.hypot(
                        e.disc.state.pos.x - chosen.x, e.disc.state.pos.z - chosen.z),
                    0, 0.05,
                    "aim \(i)/s\(seed): and the physical disc is put on the spot the "
                        + "choice just named, so the collector walks to the right place")
            }
        }

        Check.ok(oobPulls >= 4, "the sweep produced \(oobPulls) out-of-bounds pulls to judge")
        Check.ok(
            brickTaken > 0 && sidelineTaken > 0,
            "and both answers are reachable — \(brickTaken) brick, \(sidelineTaken) "
                + "sideline. `PullSpotChoice.sideline` was unreachable code for the life "
                + "of the feature, and an all-brick implementation passes every other "
                + "assertion in this function")
    }

    /// THE PULL IS SOLVED AGAINST THE PITCH, NOT AGAINST A CONSTANT.
    ///
    /// `solvePower` bisects the real flight integrator twelve times rather than reading a
    /// fitted curve, and the reason is measurable: a minis goal line is 12.5 m out and a
    /// regulation one is 32 m, so full power on the big pitch is a pull and on the small
    /// one is a disc in the car park.
    ///
    /// The assertion is therefore **scale-free**. `autoPull` aims at
    /// `dir * goalLine * 0.6` from `-dir * goalLine * 0.95`, which is 1.55 goal lines of
    /// carry on either pitch; so the carry measured *in goal lines* must agree between
    /// the two formats. Any fixed power constant fails this by construction — it can be
    /// tuned to hit one pitch's band and then misses the other's by more than the whole
    /// distance the small pitch has to offer.
    ///
    /// Measured where the pull resolves rather than where it was aimed, because a pull is
    /// usually caught on the way down; that costs a little carry on both pitches equally,
    /// which a ratio absorbs and an absolute bound would not.
    private static func thePullIsSolvedForThePitchItIsThrownOn() {
        var carried: [String: [Double]] = [:]

        for (label, format) in [("minis", GameFormat.minis), ("sevens", GameFormat.sevens)] {
            for seed in [UInt32(11), 23, 37, 53] {
                let e = Engine(format: format, seed: seed)
                e.autoTeams = [0, 1]
                let dir = Double(e.dirFor(e.game.pullingTeam))
                guard let from = e.body(of: e.game.pullingTeam * format.playersPerSide)?.pos
                else { continue }

                var landed: Vec3d?
                for _ in 0..<(120 * 30) {
                    e.step(dt: dt)
                    for event in e.drainEvents() {
                        switch event {
                        case .pullCaught(_, _, let pos): landed = landed ?? pos
                        case .pullLanded(let pos): landed = landed ?? pos
                        case .pullOutOfBounds(let pos): landed = landed ?? pos
                        // A DROPPED PULL IS ALSO A RESOLVED PULL, and it was the one
                        // resolution this switch did not have a case for — so a receiver
                        // who bobbled it made the whole measurement report "the pull never
                        // resolved". It went unnoticed because the four seeds here happened
                        // not to drop one; re-drawing the match wind was enough to make
                        // minis/s11 drop one, and the pull it dropped had carried 1.77 goal
                        // lines. The disc is where the disc is, however it got there.
                        case .turnover(.pullDrop, _, _, _, _, let pos):
                            landed = landed ?? pos
                        default: break
                        }
                    }
                    if landed != nil { break }
                }
                guard let landed else {
                    Check.ok(false, "\(label)/s\(seed): the pull never resolved")
                    continue
                }
                // Carry down the pitch, in goal lines, measured up the pulling team's
                // attacking direction so the sign is the same on both formats.
                carried[label, default: []].append(
                    (landed.z - from.z) * dir / format.field.goalLine)
            }
        }

        guard let small = carried["minis"], let big = carried["sevens"],
            !small.isEmpty, !big.isEmpty
        else {
            Check.ok(false, "pull carry: no pulls resolved on one of the two formats")
            return
        }
        let smallMean = small.reduce(0, +) / Double(small.count)
        let bigMean = big.reduce(0, +) / Double(big.count)
        Check.note(
            "pull carry in goal lines: minis \(smallMean) over \(small.count), "
                + "sevens \(bigMean) over \(big.count)")

        // Every pull must clear the halfway line and stop short of the back of the
        // receivers' endzone; both are stated as fractions of the pitch and hold on
        // either one. A pull that does not reach the receivers is not a pull, and one
        // that reaches the back line is the out-of-bounds brick the doc warns about.
        for (label, xs) in [("minis", small), ("sevens", big)] {
            for c in xs {
                Check.inRange(
                    c, 0.95, 2.15,
                    "\(label): a pull carries past halfway and short of the back line "
                        + "(\(c) goal lines)")
            }
        }
        // THE PROPERTY. Same fraction of the pitch on two pitches 2.56x apart.
        Check.near(
            smallMean, bigMean, 0.6,
            "the pull carries the same fraction of the pitch on a 12.5 m goal line as on "
                + "a 32 m one — which is the bisection working, and which no fixed power "
                + "constant can produce. Measured at 1.57 against 1.23 goal lines; a "
                + "constant tuned to either pitch misses the other by more than a whole "
                + "goal line, so the band is loose against noise and tight against the "
                + "failure it is for")
    }

    // MARK: - control follows the disc

    /// "YOU ARE ALWAYS THE PLAYER WITH A DECISION TO MAKE."
    ///
    /// The whole control scheme, in one rule inside `syncDisc`, with no check on it. It
    /// has three clauses and they are asserted on every tick of three full matches
    /// rather than sampled:
    ///
    ///   - the controlled player is always a real body on team 0. An id that has drifted
    ///     out of the roster is an out-of-range crash in the renderer.
    ///   - while our side holds it, the controlled player **is** the thrower.
    ///   - while our side is pulling, the controlled player is the puller — the one
    ///     moment in a point where a disc is in a hand and the rules name nobody.
    ///
    /// And one property no per-tick clause can express: control has to actually *move*.
    /// An implementation that pins `controlled` to a single body satisfies clause one on
    /// every tick of the match, so the number of distinct bodies controlled across a
    /// match is asserted too.
    private static func controlFollowsTheDisc() {
        for seed in [UInt32(11), 23, 37] {
            let e = Engine(format: .minis, seed: seed)
            e.autoTeams = [0, 1]

            var offRoster = 0
            var notTheThrower = 0
            var notThePuller = 0
            var checkedHeld = 0
            var checkedPull = 0
            var seen: Set<Int> = []

            for _ in 0..<(120 * 600) where !e.isOver {
                e.step(dt: dt)
                seen.insert(e.controlled)
                if e.body(of: e.controlled)?.team != 0 { offRoster += 1 }

                switch e.game.phase {
                case .livePossession, .check, .timeout:
                    guard let t = e.game.thrower, e.body(of: t)?.team == 0 else { break }
                    checkedHeld += 1
                    if e.controlled != t { notTheThrower += 1 }
                case .prePull:
                    guard e.game.pullingTeam == 0 else { break }
                    checkedPull += 1
                    if e.controlled != e.game.pullingTeam * e.format.playersPerSide {
                        notThePuller += 1
                    }
                default:
                    break
                }
            }

            Check.ok(
                checkedHeld > 2000 && checkedPull > 200,
                "s\(seed): the sweep saw \(checkedHeld) held ticks and \(checkedPull) "
                    + "pre-pull ticks, so the clauses below are not vacuous")
            Check.eq(offRoster, 0, "s\(seed): the controlled id is always a body on team 0")
            Check.eq(
                notTheThrower, 0,
                "s\(seed): while our side holds it, control is on the thrower")
            Check.eq(
                notThePuller, 0,
                "s\(seed): while our side is pulling, control is on the puller")
            Check.ok(
                seen.count >= 3,
                "s\(seed): and control actually moves — \(seen.count) different bodies "
                    + "were controlled, which an implementation that pins it to one "
                    + "cannot produce")
        }
    }
}
