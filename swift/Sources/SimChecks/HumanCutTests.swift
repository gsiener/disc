import Foundation
import UltimateSim

/// The human's offensive input away from the disc, checked where it has to land.
///
/// **The claim under test is not "the tap does something".** It is that a called cut is the
/// *same object* an AI cut is, run by the same machinery, and that the human authoring one
/// costs the offence exactly what an AI cut costs it and no more. There were two ways to
/// give the player something to do off the disc: steer a body directly, or author one of
/// the routes `TeamAIOffence` already runs. The second is the only one where the commanded
/// cutter still moves like the other six — a setup step the wrong way, a plant, a break
/// into space, a lane nobody else may enter — and this suite exists to prove it was taken:
///
///   1. the order reaches `TeamAI`, and the route it armed is the route the AI is running;
///   2. it takes the lane, which is the invariant that keeps two cutters out of one piece
///      of field, and holds it for as long as it is running;
///   3. the direction the finger pointed decides *which* of the seven routes is run —
///      downfield is a deep, backfield is a reset — so the control means the same thing in
///      both attacking directions;
///   4. the commanded body actually runs it, arriving at the space it was sent to;
///   5. the order expires on the AI's own clock and the AI has the player back afterwards;
///   6. and a refused tap is free — no route, no lane, and **no RNG draw**, which is the
///      one failure that would not show up as a body standing still but as every AI
///      decision after it landing differently.
///
/// Nothing here asserts what a cut *is*. The seven route geometries are `Playbook.buildCut`
/// and are differed against the reference in `PlaybookTests`; the arbitration is
/// `TeamAITests`. This is the input path and only the input path.
enum HumanCutTests {

    static let dt = 1.0 / 120

    static func run() throws {
        aTapWithNothingToCallDoesNothing()
        aRefusedCallCostsNothingAtAll()
        aCalledCutIsTheRouteTheAIRuns()
        theFingerChoosesTheRoute()
        theCommandedReceiverRunsIt()
        theOrderExpiresAndTheAIGetsThePlayerBack()
        ordersAreRateLimited()
    }

    // MARK: - the gate

    /// A tap is refused when there is no cut to call: before the pull, and — the one that
    /// matters — while the *other* team has the disc, which is when the identical tap is
    /// `humanDefend`. The two halves of one gesture must never both fire.
    private static func aTapWithNothingToCallDoesNothing() {
        let e = Engine(format: .minis, seed: 11)
        e.autoTeams = []
        Check.eq(
            e.humanCallCut(atX: 0, atZ: 20) == nil, true,
            "no cut before the pull — there is nobody to send and nothing to send them at")
        Check.eq(e.calledCut == nil, true, "and no ghost was left behind")

        guard let theirs = possession(of: 1, seed: 7) else {
            Check.ok(false, "a possession of theirs was reached inside 240 s")
            return
        }
        let held = theirs.controlled
        Check.eq(
            theirs.humanCallCut(atX: 0, atZ: 0) == nil, true,
            "no cut while they have the disc — that tap is the defensive one")
        Check.eq(theirs.controlled, held, "and control did not move")
    }

    /// A refused tap is free, and "free" is stricter than "did nothing visible".
    ///
    /// `humanCallCut` runs `coneSelect` and may reach `TeamAI.commandCut`, which draws
    /// exactly one jitter on its success path. If any refusal path drew — a route built
    /// before the guard that throws it away, say — the refused tap would silently shift
    /// every AI decision for the rest of the match, and no assertion about positions,
    /// lanes or routes would see it. So the check is a twin: two engines from one seed, one
    /// of which is tapped at every moment it must refuse, stepped ninety seconds and
    /// compared bit for bit.
    private static func aRefusedCallCostsNothingAtAll() {
        let a = Engine(format: .minis, seed: 21)
        let b = Engine(format: .minis, seed: 21)
        a.autoTeams = [0, 1]
        b.autoTeams = [0, 1]
        var refusals = 0
        for _ in 0..<(120 * 90) {
            // Tap on every tick the engine must refuse: theirs, dead, or in the air. Never
            // on a tick it would accept — that would be a different match by design.
            if !(a.game.phase == .livePossession && a.possession == 0
                && a.carrier == a.controlled)
            {
                if a.humanCallCut(atX: 3, atZ: 12) == nil { refusals += 1 }
            }
            a.step(dt: dt)
            b.step(dt: dt)
        }
        Check.ok(refusals > 500, "the sweep actually refused a lot of taps (\(refusals))")
        Check.eq(
            a.disc.state.pos.x.bitPattern, b.disc.state.pos.x.bitPattern,
            "90 s of refused taps left the disc bit-identical to the untapped twin — no "
                + "refusal path consumes an RNG draw")
        Check.eq(
            a.disc.state.pos.z.bitPattern, b.disc.state.pos.z.bitPattern, "…in z as well")
        Check.eq(
            a.game.score, b.game.score, "…and the two matches are still the same match")
    }

    // MARK: - the route

    /// The load-bearing check: the order becomes a route in `Mem.cut`, and it is *that*
    /// route the AI runs and *that* lane it holds.
    ///
    /// Read back through `TeamAI.runningCut` and `TeamAI.laneHolder`, which are reads of
    /// the AI's own state rather than of anything the input path stored — so an
    /// implementation that recorded a pretty ghost and never reached `commandCut` fails
    /// here rather than passing on its own bookkeeping.
    private static func aCalledCutIsTheRouteTheAIRuns() {
        guard let e = ourPossession(seed: 5), let side = teamAI(e, 0) else {
            Check.ok(false, "a possession of ours was reached inside 240 s")
            return
        }
        guard let at = probe(e, downfield: true) else {
            Check.ok(false, "there was a downfield space to point at")
            return
        }
        guard let called = e.humanCallCut(atX: at.x, atZ: at.z) else {
            Check.ok(false, "a tap into the deep space called a cut")
            return
        }

        Check.ok(called.receiver != e.controlled, "the order went to somebody else")
        Check.eq(
            e.players.first(where: { $0.id == called.receiver })?.team, 0,
            "and to one of ours")
        guard let armed = side.runningCut(of: called.receiver) else {
            Check.ok(false, "the commanded player is running a route at all")
            return
        }
        Check.eq(
            armed.target, called.target,
            "the route the AI is running is the route the order committed")
        Check.eq(armed.setup, called.setup, "…including its setup step")
        Check.eq(armed.kind, called.kind, "…and its kind")
        Check.eq(
            side.laneHolder(called.lane), called.receiver,
            "the order took the lane — nobody else may run into that space")
        // The route has somewhere to run to. `commandCut`'s `MIN_CUT_RUN` guard exists
        // because some geometries resolve a target inside a stride of the runner's feet,
        // and a cut that finishes on the frame it starts is an order that visibly does
        // nothing.
        let run = Foundation.hypot(
            called.target.x - called.from.x, called.target.z - called.from.z)
        Check.ok(run >= 1.5, "and it is a real run rather than a shuffle (\(run) m)")
        Check.eq(e.calledCut?.receiver, called.receiver, "the ghost names the runner")
    }

    /// The finger chooses the route, and it chooses it in *field* terms rather than screen
    /// ones: point at the space behind the defence and somebody goes deep, point behind the
    /// disc and somebody resets. Checked in both attacking directions over a sweep, because
    /// an attack-direction sign error in the input path is invisible on the half of the
    /// points that happen to attack +Z.
    private static func theFingerChoosesTheRoute() {
        var deepRight = 0
        var deepAsked = 0
        var resetRight = 0
        var resetAsked = 0
        var reached = 0
        var dirsSeen = Set<Int>()
        var wrong: [String] = []
        let seeds: [UInt32] = [5, 13, 23, 29, 41, 57, 71, 83]

        for seed in seeds {
            guard let e = ourPossession(seed: seed) else { continue }
            reached += 1
            dirsSeen.insert(Int(e.attackDirection(of: 0)))

            if let at = probe(e, downfield: true) {
                deepAsked += 1
                if let deep = e.humanCallCut(atX: at.x, atZ: at.z) {
                    // `strike` is the endzone set's deep — the same order, in a set with no
                    // room left behind the defence to run into.
                    if deep.kind == .deep || deep.kind == .strike { deepRight += 1 }
                    else { wrong.append("seed \(seed) deep -> \(deep.kind.rawValue)") }
                } else {
                    wrong.append("seed \(seed) deep refused")
                }
            }

            // The same possession, one `calledCutInterval` later — the disc has not moved,
            // because the computer is not playing our side, so this is the same thrower
            // asking a second question rather than a second match.
            for _ in 0..<Int((Engine.calledCutInterval + 0.1) / dt) { e.step(dt: dt) }
            guard e.carrier != nil, e.possession == 0 else { continue }
            if let at = probe(e, downfield: false) {
                resetAsked += 1
                if let back = e.humanCallCut(atX: at.x, atZ: at.z) {
                    if back.kind == .dump || back.kind == .swing { resetRight += 1 }
                    else { wrong.append("seed \(seed) reset -> \(back.kind.rawValue)") }
                } else {
                    wrong.append("seed \(seed) reset refused")
                }
            }
        }

        Check.eq(reached, seeds.count, "every seed reached a possession of ours")
        Check.eq(
            dirsSeen.count, 2,
            "and the sweep covered both attacking directions (\(dirsSeen.sorted())) — a sign "
                + "error in the tap path only shows on one of them")
        // THE DENOMINATORS ARE STATED AND THEN ASSERTED, because "0 wrong out of 1 asked"
        // is not a result. A shape only offers a backfield space to point at when there is
        // a body behind the disc, which a possession pinned on its own goal line does not
        // have — so the reset bar is lower than the deep one and both are floors on how
        // often the question was actually put.
        Check.ok(
            deepAsked >= 7,
            "there was a downfield space to point at on nearly every seed (\(deepAsked) of "
                + "\(reached))")
        Check.ok(
            resetAsked >= 4,
            "and a backfield one on half of them (\(resetAsked) of \(reached))")
        Check.eq(
            deepRight, deepAsked,
            "every tap into the deep space is a deep cut (\(deepRight) of \(deepAsked))"
                + (wrong.isEmpty ? "" : " — \(wrong.joined(separator: ", "))"))
        Check.eq(
            resetRight, resetAsked,
            "and every tap behind the disc is a reset (\(resetRight) of \(resetAsked))"
                + (wrong.isEmpty ? "" : " — \(wrong.joined(separator: ", "))"))
    }

    /// The commanded body actually goes: it leaves where it was standing and arrives in the
    /// space it was sent to.
    ///
    /// The bar is `Playbook`'s own arrival test — `tickCutters` retires a cut at 1.3 m from
    /// the target — with a metre of slack, because a cut can also be retired by its
    /// `maxTime` with the runner a stride short. What it will not tolerate is a body that
    /// never went: the ordered player's closest approach is measured against where he
    /// *stood when the order was given*, so an implementation that armed a route nobody ran
    /// scores a closing distance of zero.
    private static func theCommandedReceiverRunsIt() {
        var ran = 0
        var reached = 0
        var worstApproach = 0.0
        let seeds: [UInt32] = [5, 13, 23, 29, 41, 57, 71, 83]

        for seed in seeds {
            guard let e = ourPossession(seed: seed), let at = probe(e, downfield: true)
            else { continue }
            guard let called = e.humanCallCut(atX: at.x, atZ: at.z) else {
                Check.ok(false, "seed \(seed): a tap at a real downfield space was taken")
                continue
            }
            reached += 1

            let start = Foundation.hypot(
                called.target.x - called.from.x, called.target.z - called.from.z)
            var closest = start
            // The route's own clock plus the plant and setup either side of it. Beyond this
            // the cut has been retired and the body is clearing, so a later arrival is not
            // the order being run.
            for _ in 0..<Int(4.0 / dt) {
                e.step(dt: dt)
                guard let p = e.players.first(where: { $0.id == called.receiver }) else { break }
                closest = Swift.min(
                    closest,
                    Foundation.hypot(called.target.x - p.pos.x, called.target.z - p.pos.z))
                // Stop measuring once the disc has moved: a route abandoned because the
                // possession ended is not a route that failed.
                if e.carrier == nil || e.possession != 0 { break }
            }
            worstApproach = Swift.max(worstApproach, closest)
            if closest <= 2.3 { ran += 1 }
        }

        // **NEARLY EVERY SEED, NOT EVERY SEED**, and one arrival may miss. Both counts are
        // per-seed statistics of a scenario that has to occur before it can be measured: a
        // possession of ours with a real downfield space in it, on a particular match. An
        // unrelated stoppage — the opposing AI's timeouts, issue #20 — took the space away
        // from one seed of the eight and the runner short on another, with nothing in the
        // command path touched. The floor is what the feature claims: a tap commands a run,
        // on the seeds that can be asked, nearly always.
        Check.ok(
            reached >= seeds.count - 1,
            "nearly every seed took an order (\(reached) of \(seeds.count))")
        Check.ok(
            ran >= reached - 1,
            "and every ordered body but at most one arrived in the space it was sent to "
                + "(\(ran) of \(reached), worst \(String(format: "%.2f", worstApproach)) m "
                + "against the 1.3 m the AI's own arrival test uses)")
    }

    /// An order is a play, not a mode. The AI retires the route on its own clock, releases
    /// the lane, and goes on offering cuts to the same shape it had before.
    private static func theOrderExpiresAndTheAIGetsThePlayerBack() {
        guard let e = ourPossession(seed: 13), let side = teamAI(e, 0) else {
            Check.ok(false, "a possession of ours was reached inside 240 s")
            return
        }
        guard let at = probe(e, downfield: true),
            let called = e.humanCallCut(atX: at.x, atZ: at.z)
        else {
            Check.ok(false, "an order was given")
            return
        }
        Check.ok(e.calledCut != nil, "the ghost is up while the order is fresh")

        var ticks = 0
        var ghostTicks = -1
        // The longest route in the book plus its setup and plant, and a second on top. A
        // cut that outlives this is not being retired by anything.
        let ceiling = Int((Playbook.PLAY.underCutTime + 1.5) / dt)
        while side.runningCut(of: called.receiver) != nil, ticks < ceiling {
            e.step(dt: dt)
            ticks += 1
            if ghostTicks < 0 && e.calledCut == nil { ghostTicks = ticks }
            if e.carrier == nil || e.possession != 0 { break }
        }

        Check.ok(
            side.runningCut(of: called.receiver) == nil,
            "the route retired itself without a second tap (\(String(format: "%.2f", Double(ticks) * dt)) s)")
        Check.ok(
            side.laneHolder(called.lane) != called.receiver,
            "and it gave the lane back")
        // The ghost is a drawing lifetime and a short one: it fades long before the route
        // it describes is finished, which is the point — you are meant to watch the
        // execution, not the order.
        if ghostTicks >= 0 {
            Check.inRange(
                Double(ghostTicks) * dt,
                Engine.calledCutGhostTime - 4 * dt, Engine.calledCutGhostTime + 4 * dt,
                "the ghost faded on its own \(Engine.calledCutGhostTime) s clock")
        } else {
            Check.ok(
                e.calledCut != nil,
                "the ghost is either still up or was seen to fade")
        }

        // And the offence is the AI's again: it goes on calling its own cuts, for somebody,
        // after the human's has been retired.
        var aiCutSeen = false
        for _ in 0..<Int(8.0 / dt) where !aiCutSeen {
            e.step(dt: dt)
            guard e.possession == 0 else { break }
            for p in e.players where p.team == 0 {
                if side.runningCut(of: p.id) != nil { aiCutSeen = true }
            }
        }
        Check.ok(
            aiCutSeen,
            "the AI went on initiating cuts of its own once the order was done — the human "
                + "borrows one route, not the offence")
    }

    /// What an order costs, stated as a rule: one every `calledCutInterval`.
    ///
    /// **A tap has no edge to fall off.** `commandCut`'s contract puts idempotency on the
    /// caller — every call rebuilds the route and restarts it at `setup` — and a finger can
    /// produce ten calls a second, which would leave the commanded body jogging the setup
    /// step forever and would let a player empty the stack. The limit is `PLAY.cutStagger`,
    /// the same gap the AI holds itself to between its own cuts.
    private static func ordersAreRateLimited() {
        /// **The seed is the first one that produces the scenario, not a fixed one.**
        ///
        /// It was seed 29 alone, and what this measures needs a possession of ours *and* a
        /// downfield space to point at — two conditions on one match. Any change that
        /// reshuffles a match can take that space away from a given seed, and one did:
        /// giving the opposing AI its timeouts (issue #20) left seed 29 with a possession
        /// and nowhere downfield to tap, so "the first order was taken" failed while the
        /// rate limit it exists to measure was untouched. Trying candidates in order is not
        /// a weaker check — the rate limit is asserted exactly as before — it is the same
        /// check with the scenario found rather than assumed.
        var found: (Engine, Vec3d, Engine.CalledCut)?
        for seed in [UInt32(29), 13, 5, 23, 41, 57, 71, 83] {
            guard let e = ourPossession(seed: seed) else { continue }
            guard let at = probe(e, downfield: true) else { continue }
            guard e.canCallCut, let first = e.humanCallCut(atX: at.x, atZ: at.z) else { continue }
            found = (e, Vec3d(at.x, 0, at.z), first)
            break
        }
        guard let (e, at, first) = found else {
            Check.ok(false, "the first order was taken on some seed")
            return
        }
        Check.ok(true, "an order may be given")
        Check.eq(
            e.humanCallCut(atX: at.x, atZ: at.z) == nil, true,
            "a second order on the same tick is refused")
        Check.eq(e.canCallCut, false, "and the HUD can see that it would be")
        Check.eq(
            e.calledCut?.receiver, first.receiver,
            "the refused tap did not disturb the order already given")

        var ticks = 0
        while !e.canCallCut, ticks < Int(3.0 / dt) {
            e.step(dt: dt)
            ticks += 1
            if e.possession != 0 || e.carrier == nil { break }
        }
        let waited = Double(ticks) * dt
        if e.possession == 0 && e.carrier != nil {
            Check.inRange(
                waited,
                Engine.calledCutInterval - 4 * dt, Engine.calledCutInterval + 4 * dt,
                "and the next one may be given exactly \(Engine.calledCutInterval) s later "
                    + "(\(String(format: "%.2f", waited)) s)")
        }
    }

    // MARK: - helpers

    /// An engine wound forward to a possession of ours that will still be ours in a
    /// second's time.
    ///
    /// **`autoTeams = [1]` is the load-bearing line.** The computer plays their side and
    /// not ours, which is exactly the shipped game's arrangement — see `Engine.autoTeams`,
    /// and the throw dispatch in `step` that consults it. Without it the first thing our
    /// AI does with a fresh possession is throw it, and every check below spends its
    /// measurement window watching a disc that is already in the air: the order is given at
    /// t=0 and the possession ends at t=0.25 s, so a route that ran perfectly and a route
    /// that was never armed produce the same numbers.
    ///
    /// `settle` then lets the shape form. A cut is offered out of a stack, and the stack is
    /// still walking to its stations on the frame the disc is caught.
    private static func ourPossession(seed: UInt32, settle: Double = 1.2) -> Engine? {
        let e = Engine(format: .sevens, seed: seed)
        e.autoTeams = [1]
        var ticks = 0
        while ticks < 120 * 240 {
            e.step(dt: dt)
            ticks += 1
            guard e.game.phase == .livePossession, e.possession == 0,
                e.carrier != nil, e.carrier == e.controlled
            else { continue }
            for _ in 0..<Int(settle / dt) { e.step(dt: dt) }
            guard e.game.phase == .livePossession, e.possession == 0,
                e.carrier != nil, e.carrier == e.controlled
            else { continue }
            return e
        }
        return nil
    }

    /// An engine wound forward to the first moment `team` is holding the disc in a live
    /// possession, with both computers playing. Used only for the situations the tap must
    /// *refuse*, where nothing has to survive being watched.
    private static func possession(of team: TeamId, seed: UInt32) -> Engine? {
        let e = Engine(format: .sevens, seed: seed)
        e.autoTeams = [0, 1]
        var ticks = 0
        while ticks < 120 * 240 {
            e.step(dt: dt)
            ticks += 1
            guard e.game.phase == .livePossession, e.possession == team, e.carrier != nil
            else { continue }
            if team != 0 || e.carrier == e.controlled { return e }
        }
        return nil
    }

    /// Where a player would actually put their finger, and what the route ought to be.
    ///
    /// **A geometric probe is not a tap.** "24 m straight at the endzone" is a direction
    /// with nobody in it about a third of the time — a disc trapped on a sideline in a side
    /// stack has its whole team at 105-143 degrees, and a disc pinned on its own goal line
    /// has *nobody* behind it, because `formationStations` floors the backfield at the
    /// line. Both refusals are correct: the cone is empty and there is no cut to call. A
    /// player does not tap empty grass, they tap the space a body is heading for.
    ///
    /// So the probe is taken through the teammate furthest downfield (or furthest behind
    /// the disc), 24 m out along that heading — which is a direction the cone can always
    /// resolve, and which still tests the thing under test: the route family is decided by
    /// the direction's *downfield component*, so an attacking-direction sign error in the
    /// input path turns every deep probe into a dump.
    ///
    /// Returns nil when there is no body far enough that way to be pointing at, which is a
    /// fact about the shape rather than a failure of the tap.
    private static func probe(_ e: Engine, downfield: Bool) -> (x: Double, z: Double)? {
        guard let c = e.carrier, let t = e.players.first(where: { $0.id == c }) else { return nil }
        let dir = Double(e.attackDirection(of: 0))
        var bestU: (x: Double, z: Double)?
        var bestScore = -2.0
        for p in e.players where p.team == 0 && p.id != c {
            let vx = p.pos.x - t.pos.x
            let vz = p.pos.z - t.pos.z
            let d = Foundation.hypot(vx, vz)
            guard d > 2.0 else { continue }
            // The downfield component of the heading, +1 straight at the endzone we are
            // attacking. This is exactly the quantity `commandCut` switches on.
            let along = dir * vz / d * (downfield ? 1 : -1)
            if along > bestScore {
                bestScore = along
                bestU = (vx / d, vz / d)
            }
        }
        // `commandCut`'s own thresholds, with a margin: deep needs > 0.55 and a reset needs
        // < -0.30. Inside the margin the answer is a coin toss on the shape rather than on
        // the input path, and a check should not assert a coin toss.
        guard let u = bestU, bestScore > (downfield ? 0.62 : 0.40) else { return nil }
        return (t.pos.x + u.x * 24, t.pos.z + u.z * 24)
    }

    private static func teamAI(_ e: Engine, _ team: TeamId) -> TeamAI? {
        e.ai.first { $0.team == team }
    }
}
