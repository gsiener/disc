import Foundation
import UltimateSim

/// The human's defensive input, checked where it actually has to land.
///
/// **The claim under test is not "the tap does something".** It is that a human bid
/// travels the *same* path an AI bid travels, and therefore that the contest treats it
/// identically. `Engine.tryCatch` will not let a defender play a disc unless that body's
/// current intent is an attacking one — `catchBodies` sets
/// `attacking: kind == "bid" || "jump" || "catch"`, and `CatchDecision.decide` drops any
/// non-attacking defender further than `passiveDefenderGap` (0.55 m) from the disc. So
/// there were exactly two ways to give the player a defensive act: write the intent into
/// the stream the AI writes into, or weaken the gate for human bodies. The second would
/// be a different physics for the player than for the opponent, and this suite exists to
/// prove the first was taken:
///
///   1. the tap produces a commitment, and only in a situation that has one to make;
///   2. the commitment appears in `actionOf` as `"bid"` — the reference's own
///      discriminator, read back through `Engine.reportedAction`;
///   3. `catchBodies` therefore reports that body as `attacking`, at a gap the passive
///      rule would have refused;
///   4. and `CatchDecision.decide`, handed those bodies, names that defender and returns
///      a block or an interception — where the identical bodies with the flag cleared
///      return nothing at all. That last pair is the whole point: the flag is not
///      decoration, it is the difference between a D and a body running past the disc.
///
/// Nothing here changes what the simulation *does* with a bid. The engine's own layout
/// cost, the roll, the interception split and the 0.62 defence scale are all
/// `CatchDecision`'s, differed against the reference in `TryCatchTests`, and untouched.
///
/// The suite also measures the hitstop budget the presentation layer spends — see
/// `theDecisiveMomentsAreRare`, which is a count of events and not a test of the view.
enum HumanDefenceTests {

    static let dt = 1.0 / 120

    static func run() throws {
        aTapWithNothingToCommitToDoesNothing()
        aHumanBidReachesTheIntentPath()
        aHumanBidCanProduceABlock()
        theCommitmentExpiresOnItsOwn()
        theDecisiveMomentsAreRare()
    }

    // MARK: - the gate

    /// A tap is refused when there is nothing to send anybody at: before the pull, and
    /// while the human's own team has the disc.
    ///
    /// The refusal matters more than it looks. `humanDefend` moves `controlled`, and a
    /// tap that committed a body during our own possession would move control off the
    /// thrower mid-drag — i.e. the offence's one gesture would be cancelled by the
    /// defence's one gesture.
    private static func aTapWithNothingToCommitToDoesNothing() {
        let e = Engine(format: .minis, seed: 11)
        e.autoTeams = []
        Check.eq(
            e.humanDefend() == nil, true,
            "no commitment before the pull — the point has not started")

        // Ours: run both computers until we are the team holding.
        let mine = Engine(format: .minis, seed: 11)
        mine.autoTeams = [0, 1]
        var ticks = 0
        while !(mine.game.phase == .livePossession && mine.possession == 0), ticks < 120 * 240 {
            mine.step(dt: dt)
            ticks += 1
        }
        if mine.possession == 0 && mine.game.phase == .livePossession {
            let held = mine.controlled
            Check.eq(mine.humanDefend() == nil, true, "no commitment while we have the disc")
            Check.eq(mine.controlled, held, "and control did not move")
        } else {
            Check.ok(false, "a possession of our own was reached inside 240 s")
        }
    }

    // MARK: - the intent path

    /// The load-bearing check: the tap becomes a `"bid"` in `actionOf`, and the contest's
    /// view of that body flips to `attacking` at a gap the passive rule would refuse.
    private static func aHumanBidReachesTheIntentPath() {
        guard let e = defensiveFlight(seed: 5) else {
            Check.ok(false, "a defensive flight was reached")
            return
        }
        guard let commit = e.humanDefend() else {
            Check.ok(false, "the tap committed a defender to a disc in the air")
            return
        }
        Check.eq(commit.kind, .bid, "a disc in the air makes the tap a bid")
        Check.eq(e.controlled, commit.defender, "control moved to the body that was sent")
        Check.eq(
            e.players.first(where: { $0.id == commit.defender })?.team, 0,
            "and the body sent is ours")

        // Run the commitment out and watch for the tick it becomes a bid. It is not
        // necessarily the first: outside layout range the commitment is a full-effort run
        // at the disc, and the dive is taken when the geometry earns it.
        var sawBid = false
        var bidGap = 0.0
        var attackingAtGap = false
        for _ in 0..<Int(Engine.defensiveCommitTime / dt) {
            e.step(dt: dt)
            guard e.reportedAction(of: commit.defender) == "bid" else { continue }
            sawBid = true
            let bodies = e.contestBodies()
            guard let me = bodies.first(where: { $0.id == commit.defender }) else { continue }
            Check.eq(me.attacking, true, "the contest sees the committed body as attacking")
            let gap = Foundation.hypot(
                me.pos.x - e.disc.state.pos.x, me.pos.z - e.disc.state.pos.z)
            bidGap = Swift.max(bidGap, gap)
            if gap > CatchDecision.passiveDefenderGap { attackingAtGap = true }
            break
        }
        Check.eq(sawBid, true, "the human's tap reached actionOf as a bid")
        Check.eq(
            attackingAtGap, true,
            "and it did so at \(bidGap) m — beyond the \(CatchDecision.passiveDefenderGap) m "
                + "a passive defender is held to")
    }

    /// The flag earns its keep: the same bodies, with the human's `attacking` cleared,
    /// stop producing a block.
    ///
    /// The roll is pinned at zero rather than drawn, because this asserts *who the
    /// decision considers*, not how the dice fell — a probabilistic version of this check
    /// would be a check that fails one seed in six for no reason.
    private static func aHumanBidCanProduceABlock() {
        var blocked = 0
        var considered = 0
        var refusedWithoutTheFlag = 0

        for seed in [5, 13, 23, 29, 41, 57, 71, 83] as [UInt32] {
            guard let e = defensiveFlight(seed: seed), var defender = e.humanDefend()?.defender
            else { continue }

            // A flight outlives one commitment, and a player watching a disc they have
            // sent someone at taps again. Re-committing while the disc is up is what the
            // thumb does, so it is what the check does.
            while e.discInFlight {
                if e.defensiveCommit == nil, let again = e.humanDefend() {
                    defender = again.defender
                }
                e.step(dt: dt)
                let bodies = e.contestBodies()
                guard let me = bodies.first(where: { $0.id == defender }), me.attacking
                else { continue }

                let offence: TeamId? =
                    e.game.phase == .pullInFlight ? e.game.receivingTeam : e.game.possession
                guard let got = CatchDecision.decide(
                    discPos: e.disc.state.pos, discVel: e.disc.state.vel,
                    pull: e.game.phase == .pullInFlight, offence: offence,
                    bodies: bodies, roll: { 0 }),
                    got.takerId == defender
                else { continue }

                considered += 1
                if got.outcome == .block || got.outcome == .interception { blocked += 1 }

                // The counterfactual: identical geometry, identical roll, flag cleared.
                let passive = bodies.map { b in
                    b.id == defender
                        ? CatchDecision.Body(
                            id: b.id, team: b.team, pos: b.pos, state: b.state, prone: b.prone,
                            airborne: b.airborne, groundY: b.groundY, hipHeight: b.hipHeight,
                            reachTop: b.reachTop, attacking: false, attr: b.attr,
                            energy: b.energy)
                        : b
                }
                let without = CatchDecision.decide(
                    discPos: e.disc.state.pos, discVel: e.disc.state.vel,
                    pull: e.game.phase == .pullInFlight, offence: offence,
                    bodies: passive, roll: { 0 })
                let gap = Foundation.hypot(
                    b_pos(bodies, defender).x - e.disc.state.pos.x,
                    b_pos(bodies, defender).z - e.disc.state.pos.z)
                if gap > CatchDecision.passiveDefenderGap, without?.takerId != defender {
                    refusedWithoutTheFlag += 1
                }
                break
            }
        }

        Check.ok(
            considered >= 1,
            "at least one human bid was actually weighed by the catch decision "
                + "(\(considered) of 8 seeds)")
        Check.ok(
            blocked >= 1,
            "and produced a block or an interception on a made roll (\(blocked))")
        Check.ok(
            refusedWithoutTheFlag >= 1,
            "while the same body with `attacking` cleared is dropped by the passive rule "
                + "(\(refusedWithoutTheFlag)) — the intent is what buys the play, not the "
                + "position")
    }

    private static func b_pos(_ bodies: [CatchDecision.Body], _ id: Int) -> Vec3d {
        bodies.first(where: { $0.id == id })?.pos ?? .zero
    }

    /// A tap is a play, not a mode: the commitment lets go of the body on its own, and it
    /// lets go the instant the situation that justified it ends.
    private static func theCommitmentExpiresOnItsOwn() {
        guard let e = defensiveFlight(seed: 13), e.humanDefend() != nil else {
            Check.ok(false, "a defensive flight was reached and committed to")
            return
        }
        var ticks = 0
        while e.defensiveCommit != nil, ticks < Int(4 / dt) {
            e.step(dt: dt)
            ticks += 1
        }
        Check.ok(
            e.defensiveCommit == nil,
            "the commitment released the body without another tap (\(Double(ticks) * dt) s)")
        Check.ok(
            Double(ticks) * dt <= Engine.defensiveCommitTime + 2 * dt,
            "and never outlived its own clock (\(Double(ticks) * dt) s vs "
                + "\(Engine.defensiveCommitTime) s)")
    }

    // MARK: - the hitstop budget

    /// How many moments in a full game are worth stopping time for.
    ///
    /// **Not a test of the view.** The hitstop rule lives in `MatchView`, which this
    /// target cannot import and must not mirror — a copy of the policy here would pass
    /// happily while the shipped one drifted. What is asserted instead is the *event*
    /// fact the policy was chosen against, so that if the simulation's own rates move the
    /// budget fails and the rule gets revisited. That is the only way a frequency claim
    /// stays true after the thing it counted changes.
    ///
    /// `docs/gameplay-design.md` §5 gives slow motion to every contested or laid-out catch
    /// and to every block. Measured here, that is not the ~28 a game the design brief
    /// assumed — it is around 86, because this offence takes a *lot* of discs at full
    /// stretch. `MatchView.slowMo(for:)` therefore keeps only the laid-out blocks and
    /// interceptions: a possession changing on a play nobody could have made standing up.
    ///
    /// Both numbers are measured below, and the second is the one with a ceiling on it.
    private static func theDecisiveMomentsAreRare() {
        var laidOutD = 0
        var otherD = 0
        var nonRoutine = 0
        var routine = 0
        var games = 0

        for seed in [3, 19, 37] as [UInt32] {
            let e = Engine(format: .sevens, seed: seed)
            e.autoTeams = [0, 1]
            var ticks = 0
            while !e.isOver, ticks < 120 * 60 * 45 {
                e.step(dt: dt)
                ticks += 1
                for event in e.drainEvents() {
                    switch event {
                    case .caught(_, _, let grade, _):
                        if grade == .routine { routine += 1 } else { nonRoutine += 1 }
                    case .turnover(let reason, _, _, _, let grade, _):
                        guard reason == .block || reason == .interception else { continue }
                        if grade == .layout { laidOutD += 1 } else { otherD += 1 }
                    default:
                        continue
                    }
                }
            }
            if e.isOver { games += 1 }
        }

        guard games > 0 else {
            Check.ok(false, "at least one full 7v7 game finished inside 45 minutes")
            return
        }
        let asWritten = Double(nonRoutine + laidOutD + otherD) / Double(games)
        let shipped = Double(laidOutD) / Double(games)
        Check.note(
            "hitstop budget over \(games) full 7v7 games: \(routine) routine and "
                + "\(nonRoutine) non-routine catches, \(laidOutD) laid-out and \(otherD) "
                + "standing blocks/interceptions — §5 as written fires "
                + "\(String(format: "%.1f", asWritten))/game, laid-out D's alone "
                + "\(String(format: "%.1f", shipped))/game")
        Check.inRange(
            shipped, 0, 6,
            "a laid-out D stays a rare enough thing to stop the clock for "
                + "(§5 as written would be \(String(format: "%.1f", asWritten))/game)")
        Check.ok(
            asWritten > 20,
            "and §5 as written is still far outside the broadcast budget, i.e. this "
                + "narrowing is still needed (\(String(format: "%.1f", asWritten))/game)")
    }

    // MARK: - helpers

    /// An engine wound forward to the first moment the opponent has thrown and the disc
    /// is in the air — the situation the tap exists for.
    private static func defensiveFlight(seed: UInt32) -> Engine? {
        let e = Engine(format: .sevens, seed: seed)
        e.autoTeams = [0, 1]
        var ticks = 0
        while ticks < 120 * 240 {
            e.step(dt: dt)
            ticks += 1
            if e.discInFlight, e.possession != 0, e.game.phase == .discInFlight { return e }
        }
        return nil
    }
}
