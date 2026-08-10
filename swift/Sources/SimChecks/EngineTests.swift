import Foundation
import UltimateSim

/// The integration layer, checked by playing it.
///
/// **This suite is deliberately weaker than every other one here, and says so.** Every
/// other suite is differential: it compares Swift against a golden generated from the
/// TypeScript, and a number that disagrees is a bug by definition. `Engine` has no
/// counterpart to differ against — `src/sim/Game.ts` is engine glue that imports three.js
/// and the web input layer, so there is nothing to generate a golden from.
///
/// So these are property assertions. They cannot tell you the wiring matches the
/// reference, because nothing can. What they can tell you is that the wiring does not
/// violate the things that must hold however it is written: play terminates, the score
/// only moves on a goal, nobody leaves the pitch, nothing goes non-finite, and one seed
/// is one match.
///
/// Since `GameState` became the authority, four more things are checkable and are checked
/// here, because each of them was silently untrue while `Engine` owned the rules itself:
///
///  - **a pull happens**, and the point starts from it rather than from a disc conjured
///    into a handler's hand;
///  - **the count is the marker's**, and does not advance for a thrower nobody is on;
///  - **no reported action is ever refused** — an `ActionResult` with `ok: false` means
///    this file called a mutator from the wrong phase, and a refusal that is ignored
///    looks exactly like a working game until the phase it mattered in;
///  - **the disc and the rules agree about whose hand it is in**, every tick.
///
/// The components underneath are a different matter — `TeamAI` is 445,734 assertions
/// against a 1,280-frame trace, locomotion is 87,643, the flight model is exact to
/// 5e-15 m, and `GameState` is 3,098 against a scripted trace. What is unvalidated here
/// is only the joins between them.
enum EngineTests {

    static let dt = 1.0 / 120

    static func run() throws {
        buildsBothFormats()
        everyPointOpensWithAPull()
        playsWithoutBlowingUp()
        scoreOnlyMovesOnGoals()
        aGameHasAHalfAndAnEnd()
        theCountNeedsAMarker()
        theCountRunsOut()
        aRefusedActionChangesNothing()
        theHumanCannotThrowADiscTheyDoNotHave()
        thePreviewIsTheRelease()
        theDiscArrivesWhereItWasAimed()
        theAssistLeadsARunningReceiver()
        bidsReachTheBody()
        deterministic()
    }

    /// The player gets told who they meant, and gets a little help hitting them.
    ///
    /// **The assist is a nudge, not a lead solver, and writing this check is what made that
    /// clear.** The first version aimed straight at a receiver's chest 20 m away as he ran
    /// across at 7 m/s and asserted the assist would lead him. It does not, and it should
    /// not: that shot needs 27 degrees of lead and the window is twelve, so the assist
    /// declines entirely and the disc goes where it was pointed. What it buys is the last
    /// five degrees for somebody already nearly right.
    ///
    /// So a human still has to lead a runner by eye. That is the reference's design, stated
    /// in its own words — **timing skill buys accuracy; it does not buy aim** — and the
    /// bounds are asserted rather than trusted, because a helper that quietly drags a
    /// deliberate throwaway back onto a receiver is a control that lies.
    private static func theAssistLeadsARunningReceiver() {
        // A middling athlete. The assist's behaviour must not depend on who is running.
        let flatAttributes = AIAttributes(
            speed: 70, acceleration: 70, agility: 70, jumping: 70, catching: 70,
            throwAccuracy: [:], throwPower: 70, decision: 70, stamina: 70, defAwareness: 70)
        let from = Vec3d(0, 1.35, 0)
        // A receiver 20 m downfield, running across at 7 m/s.
        let runner = HumanTargeting.Body(
            id: 1, team: 0, pos: Vec3d(0, 0, 20), vel: Vec3d(7, 0, 0),
            attr: flatAttributes, energy: 1, available: true)

        // Where the lead actually is, and an aim eight degrees short of it — inside the
        // window, so the assist engages.
        let atChest = atan2(runner.pos.x - from.x, runner.pos.z - from.z)
        let declined = HumanTargeting.assistedYaw(
            rawYaw: atChest, quality: 1, power: 0.5, from: from, receiver: runner)
        Check.ok(
            abs(declined.leadError) > HumanTargeting.assistWindow,
            "leading a 7 m/s runner at 20 m is well outside the window "
                + "(\(declined.leadError) rad)")
        Check.bitEqViaJSON(
            declined.applied, 0, "so the assist declines and the disc goes where it was aimed")

        let ideal = atChest + declined.leadError
        let raw = ideal - 8 * Double.pi / 180
        let clean = HumanTargeting.assistedYaw(
            rawYaw: raw, quality: 1, power: 0.5, from: from, receiver: runner)
        Check.ok(clean.applied > 0, "an aim eight degrees short of the lead is nudged onto it")
        Check.ok(
            abs(clean.applied) <= HumanTargeting.assistMax + 1e-12,
            "and never rotates more than five degrees (\(clean.applied) rad)")
        Check.near(
            clean.leadError, 8 * Double.pi / 180, 1e-9,
            "and the reported lead error is the eight degrees it was given")

        // Quality scales it, and only it.
        let rushed = HumanTargeting.assistedYaw(
            rawYaw: raw, quality: 0.2, power: 0.5, from: from, receiver: runner)
        Check.ok(
            rushed.applied < clean.applied && rushed.applied > 0,
            "a rushed release gets less of it (\(rushed.applied) vs \(clean.applied))")
        Check.near(
            rushed.applied, clean.applied * 0.2, 1e-12,
            "in exact proportion to the quality")

        // Outside the window it must decline entirely.
        let elsewhere = HumanTargeting.assistedYaw(
            rawYaw: raw - 0.6, quality: 1, power: 0.5, from: from, receiver: runner)
        Check.bitEqViaJSON(
            elsewhere.applied, 0, "a throw aimed somewhere else is left alone")
        Check.bitEqViaJSON(
            elsewhere.yaw, raw - 0.6, "and its heading is untouched")
        Check.bitEqViaJSON(
            HumanTargeting.assistedYaw(
                rawYaw: raw, quality: 1, power: 0.5, from: from, receiver: nil).applied,
            0, "and with nobody selected there is nothing to lead")

        // The cone picks who you dragged at, and the lane term is what makes it more than
        // an angle test: a teammate screened by a defender loses to an open one.
        let thrower = HumanTargeting.Body(
            id: 0, team: 0, pos: from, vel: .zero, attr: flatAttributes,
            energy: 1, available: true)
        let screened = HumanTargeting.Body(
            id: 2, team: 0, pos: Vec3d(3, 0, 20), vel: .zero, attr: flatAttributes,
            energy: 1, available: true)
        let marker = HumanTargeting.Body(
            id: 3, team: 1, pos: Vec3d(1.5, 0, 10), vel: .zero, attr: flatAttributes,
            energy: 1, available: true)

        let openPick = HumanTargeting.resolveConeSelect(
            dx: 1.5, dz: 20, thrower: thrower, bodies: [thrower, runner, screened])
        Check.ok(openPick != nil, "a drag downfield finds somebody")

        let blocked = HumanTargeting.laneBlockage(
            from: 0, 0, to: screened, bodies: [thrower, screened, marker])
        let clear = HumanTargeting.laneBlockage(
            from: 0, 0, to: screened, bodies: [thrower, screened])
        Check.bitEqViaJSON(clear, 0, "an empty lane is not blocked")
        Check.ok(blocked > 0.2, "a defender standing in it is (\(blocked))")
        Check.ok(blocked <= 0.97, "and blockage is capped short of certainty")

        // Nobody in the cone at all.
        Check.ok(
            HumanTargeting.resolveConeSelect(
                dx: 0, dz: -20, thrower: thrower, bodies: [thrower, runner]) == nil,
            "a drag with nobody in front of it selects nobody")
    }

    /// **The throw solver's actual property, asked directly.**
    ///
    /// This check exists because mutation testing found the suite could not see the solver
    /// at all. Deleting the lateral-drift heading correction, throwing away the elevation
    /// bisection, replacing `powerForSpeed` with a constant `0.5`, and solving to the
    /// ground instead of to chest height were each applied in turn — and every one of them
    /// left 2.2 million assertions green. A game in which every throw misses still scores;
    /// it just scores differently, and no aggregate of goals or completions distinguishes
    /// "the disc went where it was aimed" from "the disc went somewhere and somebody was
    /// standing there".
    ///
    /// So: solve a release, fly it against nobody, and see where it goes.
    ///
    /// **Measured in isolation, not in a match.** In a live game the disc is caught by a
    /// receiver running *onto* the lead, a metre or two short of the aim point, so a
    /// match-level "did it arrive" reads about 2.6 m whether the solver is working or
    /// deliberately broken — it is measuring the offence. Flown against nobody, the answer
    /// is the solver's alone, and the reference's claim is specific: two outer passes are
    /// enough to land inside a receiver's catch radius.
    ///
    /// The sweep is deliberately wide — every throw type, ranges from a five-metre dump to
    /// a huck, and headings all round the clock — because the two things most likely to be
    /// wrong are direction-dependent. A disc banks, so the lateral error changes sign with
    /// the heading, and a forehand and a backhand curve opposite ways.
    private static func theDiscArrivesWhereItWasAimed() {
        let e = Engine(format: .sevens, seed: 23)
        let rt = DiscRuntime()
        var misses: [Double] = []
        var byFraction: [Double: [Double]] = [:]
        var latByFraction: [Double: [Double]] = [:]
        var worst = (miss: 0.0, what: "")

        // A stand-in thrower, so the sweep asks for exactly what the AI would ask for.
        let arm = AIPlayer(
            id: 0, team: 0, attr: e.players[0].attr, archetype: .handler)
        arm.energy = 1

        for type in [AIThrowType.backhand, .forehand, .hammer] {
            guard let physType = ThrowType(rawValue: type.rawValue) else { continue }
            // Only ranges this throw can actually make. The AI never asks for more — it
            // skips any option whose `powerRatio` exceeds 1.05 — so a sweep that does is
            // testing the bisection's saturation behaviour rather than the solver, which
            // is how a hammer at 40 m came to be the "worst" case at 28 m of error.
            let reach = maxThrowRange(arm, type, 0)
            for fraction in [0.15, 0.3, 0.35, 0.4, 0.45, 0.5, 0.7, 0.9] {
                let range = reach * fraction
                for step in 0..<8 {
                    let heading = Double(step) * .pi / 4
                    let from = Vec3d(0, 1.35, 0)
                    let aim = Vec3d(
                        from.x + sin(heading) * range, 1.35, from.z + cos(heading) * range)
                    // **The AI's own release speed, which is not the distance over the
                    // flight time.** Those were one function once and were split precisely
                    // because they wanted opposite numbers; this measurement kept using
                    // the lead clock and so was never sweeping the throw the engine makes.
                    // It stopped being harmless when `throwFlightTime` gained the loft step
                    // at `ThrowSolver.loftRange`: dividing a deep ask by a flight time that
                    // had just gone up 75% asked the arm for a release it would never
                    // choose, and the sweep reported the resulting underthrow — a median
                    // 15 m miss at 90% of believed range — as a fault in the solver.
                    let speed = throwReleaseSpeed(arm, type, range)
                    guard
                        let req = e.solveRelease(
                            from: from, aim: aim, type: physType, speed: speed,
                            throwPower: arm.attr.throwPower, hand: .right)
                    else { continue }

                    // Fly it to rest, and take the closest the disc ever came to the aim.
                    //
                    // The whole flight, not just the part above catch height. `probeThrow`
                    // reports whichever comes first, a descent through the catch plane or
                    // the ground — so a flat short throw is solved to where it LANDS, and
                    // it genuinely arrives there at ankle height. An earlier version of
                    // this measurement stopped tracking below 0.35 m and reported those
                    // correct throws as 1.8 m misses.
                    rt.release(req)
                    var closest = Double.infinity
                    for _ in 0..<(120 * 8) {
                        rt.step(dt: dt)
                        closest = Swift.min(closest, distXZ(aim, rt.state.pos))
                        if rt.state.atRest { break }
                    }
                    guard closest.isFinite else { continue }
                    misses.append(closest)
                    byFraction[fraction, default: []].append(closest)
                    // The lateral half, on its own. The heading correction's entire job is
                    // to drive this to zero, and total miss cannot see it: at short range
                    // the drift is small enough to hide inside a catch radius, so deleting
                    // the correction left every other assertion green.
                    latByFraction[fraction, default: []].append(
                        abs(e.disc.probeThrow(req, catchY: 1.35, maxT: 6).lat))
                    if closest > worst.miss {
                        worst = (closest, "\(type.rawValue) \(Int(range)) m at \(step * 45) deg")
                    }
                }
            }
        }

        Check.ok(misses.count > 80, "there were throws to measure (\(misses.count))")
        guard misses.count > 80 else { return }

        func median(_ xs: [Double]) -> Double {
            xs.isEmpty ? .infinity : xs.sorted()[xs.count / 2]
        }
        for (fraction, xs) in byFraction.sorted(by: { $0.key < $1.key }) {
            Check.note(
                "throw solver at \(Int(fraction * 100))% of the AI's believed range: "
                    + "median miss " + String(format: "%.2f", median(xs)) + " m, median "
                    + "lateral " + String(format: "%.2f", median(latByFraction[fraction] ?? []))
                    + " m")
        }

        // **Where the two models part company, stated rather than hidden.**
        //
        // The AI decides what it can throw with `maxThrowRange` and derives a release speed
        // from `throwFlightTime`; the disc is then flown by the aerodynamic model. Those are
        // two different models, and they agree only up to about half of what the first one
        // believes. A backhand at 90% of `maxThrowRange` works out at about 14 m/s, which
        // `powerForSpeed` maps to 15% power — and no elevation in the bisection's range
        // carries 15% of a backhand forty metres. So the AI asks for hucks it cannot throw
        // and they land short.
        //
        // Both halves are faithful ports, so the reference has this too, and it is the
        // likely reason a huck is rare in either game. It is a real limitation of the
        // reference's design, not a porting error, and it is asserted at the range where
        // throws actually happen rather than papered over with a loose global bound.
        // **What this sweep found about the heading correction, recorded because it is not
        // what the commit that added it claimed.**
        //
        // `heading -= atan2(lat, want)` is inert below about a third of the AI's believed
        // range — `lat` never reaches its own 0.25 m gate — and above that it makes the
        // total miss *worse*, not better: at 35% it takes the median from 0.79 m to 2.32 m,
        // and at 50% from 4.81 m to 7.27 m. The reason is the shortfall above. Once the
        // disc cannot reach `want`, the elevation bisection saturates and the disc lands
        // short; rotating the heading by an angle computed for the full distance then
        // swings that short landing point sideways, away from the aim.
        //
        // Note also that `ThrowProbe.lat` is measured relative to the request's OWN aim
        // line, so it is unchanged by rotating that line — the median lateral figures above
        // are identical with the correction and without it. Anyone re-checking this should
        // measure the world-space offset from `from → aim`, not `lat`.
        //
        // The correction is kept because it is what the reference does and this port's rule
        // is that the reference wins over local judgement. But it is not earning anything
        // here, and the thing to fix is the disagreement below, not this line. A match-level
        // A/B is no use for deciding it: any change to the solver reshuffles the whole match
        // through the RNG, and removing this line moved sevens 7 → 3 goals while moving
        // minis 10 → 13. That is chaos, not evidence.
        let short = byFraction.filter { $0.key <= 0.3 }.flatMap(\.value)
        let long = byFraction.filter { $0.key >= 0.9 }.flatMap(\.value)
        Check.note(
            "throw solver: \(misses.count) flights, worst "
                + String(format: "%.2f", worst.miss) + " m on \(worst.what)")
        /**
         * **The worst case is BOUNDED now, and it was not before.**
         *
         * This line was a `Check.note` with no assertion anywhere behind it, and the
         * number it prints is the one that would have caught the regression this file
         * spends two screens describing: a solver that answered a 1 m dump with a 19.6 m
         * bomb moves this figure and nothing else. A note cannot fail, so it did not.
         * The bound is set a little over half again the measured 6.40 m, which is loose
         * enough to survive a libm difference in the integrator and tight enough that a
         * bomb — any bomb — trips it.
         */
        Check.ok(
            worst.miss < 10,
            "and no solved throw is a bomb (worst \(String(format: "%.2f", worst.miss)) m)")
        Check.ok(
            median(short) < 0.82,
            "a solved throw inside a third of the AI's believed range arrives in a catch "
                + "radius (median \(median(short)) m)")
        /**
         * **This assertion used to say the opposite, and it was right to, and it is now
         * right not to.**
         *
         * It read `median(long) > 3` — the AI believes in hucks the flight model will not
         * throw — and it was pinned that way deliberately so that fixing the disagreement
         * would be a visible event rather than a silent one. It is fixed, in two halves.
         * The catch plane is now clamped under the release (`ThrowSolver.catchDrop`), so a
         * solve is a solve rather than a search for where the disc hits the turf; and this
         * sweep now asks for the release speed the engine actually uses
         * (`throwReleaseSpeed`) rather than distance over the lead clock. The median miss
         * at 90% of believed range went 6.85 m -> 1.61 m and the worst case 11.75 -> 6.40.
         *
         * So the direction reverses: what is asserted now is that a deep ask ARRIVES, with
         * a ceiling rather than a floor. Anyone who reintroduces the disagreement fails
         * here, which is the same service the old assertion was performing in reverse.
         */
        Check.ok(
            median(long) < 3.5,
            "and a deep ask now arrives — no floor left under it "
                + "(median \(median(long)) m at 90% of believed range)")
    }

    /// A minis engine is three a side on the minis pitch; a sevens engine is seven on the
    /// regulation one. The whole reason `GameFormat` exists.
    private static func buildsBothFormats() {
        let minis = Engine(format: .minis, seed: 1)
        Check.eq(minis.players.count, 6, "a minis engine fields six players")
        Check.eq(minis.target, 7, "a minis game is to 7")
        Check.bitEqViaJSON(minis.format.field.length, 37, "on a 37 m pitch")

        let sevens = Engine(format: .sevens, seed: 1)
        Check.eq(sevens.players.count, 14, "a sevens engine fields fourteen players")
        Check.eq(sevens.target, 15, "a regulation game is to 15")
        Check.bitEqViaJSON(sevens.format.field.length, 100, "on a 100 m pitch")

        // Both TeamAIs exist and attack opposite ways, or there is no game.
        Check.eq(minis.ai.count, 2, "both sides have an AI")
        Check.ok(minis.dirFor(0) == -minis.dirFor(1), "the two teams attack opposite ways")

        // The machine is the authority from construction, and it says a match begins
        // before a pull rather than in the middle of a possession.
        Check.ok(minis.game.snapshot().phase == .prePull, "a match opens in PRE_PULL")
        Check.eq(minis.game.pullingTeam, 0, "with the human's team pulling")
        Check.eq(minis.carrier, minis.controlled, "and the disc in the controlled player's hand")
        Check.ok(minis.game.thrower == nil, "but the machine names no thrower until it is caught")
        Check.eq(minis.score, [0, 0], "and nil-nil")
        Check.eq(minis.game.rules.gameTo, minis.target, "the machine plays to the engine's target")
        Check.eq(sevens.game.rules.gameTo, 15, "and to fifteen on the regulation pitch")
        Check.ok(minis.refusals.isEmpty, "nothing was refused while standing the game up")
    }

    /// A point begins with a real pull: a disc released from the pulling team's own goal
    /// line, flown by the flight model, and resolved as caught, landed or out.
    ///
    /// The engine used to start each point from a *caught* pull, which meant every
    /// pull-shaped thing in `GameState` — `PULL_IN_FLIGHT`, `pullCaught`, `pullLanded`,
    /// `pullOutOfBounds`, the brick mark — was ported and dead.
    private static func everyPointOpensWithAPull() {
        let e = Engine(format: .minis, seed: 3)
        e.autoTeams = [0, 1]
        let pullingTeam = e.game.pullingTeam
        Check.ok(e.game.phase == .prePull, "the first point opens before the pull")

        var releasedAt: Vec3d?
        var flew = 0.0
        var reachedLive = false
        for _ in 0..<(120 * 40) {
            let before = e.game.phase
            e.step(dt: dt)
            if before == .prePull, e.game.phase == .pullInFlight {
                releasedAt = e.disc.state.pos
            }
            if let from = releasedAt, e.game.phase == .pullInFlight {
                flew = Swift.max(flew, distXZ(from, e.disc.state.pos))
            }
            if e.game.phase == .livePossession {
                reachedLive = true
                break
            }
        }

        Check.ok(releasedAt != nil, "the point passes through PULL_IN_FLIGHT")
        Check.ok(reachedLive, "and reaches a live possession from it")
        Check.ok(
            flew > e.format.field.goalLine * 0.5,
            "the pull is a real flight, not a hand-off (\(flew) m)")
        Check.eq(e.game.teamStats(pullingTeam).pulls, 1, "the pulling team is credited with it")
        Check.eq(
            e.game.teamStats(otherTeam(pullingTeam)).pulls, 0,
            "and the receiving team is not")
        Check.ok(e.refusals.isEmpty, "no action was refused getting there: \(e.refusals)")

        // The pull is a rules event, not an AI decision, so it happens with the computer
        // switched off entirely. Without that, a human-only engine never gets a disc.
        let unattended = Engine(format: .minis, seed: 4)
        unattended.autoTeams = []
        var sawFlight = false
        for _ in 0..<(120 * 40) {
            unattended.step(dt: dt)
            if unattended.game.phase == .pullInFlight { sawFlight = true }
        }
        Check.ok(sawFlight, "a pull is thrown even with both AIs switched off")
        Check.ok(
            unattended.game.teamStats(0).pulls + unattended.game.teamStats(1).pulls > 0,
            "and the machine counted it")

        // The regulation pitch is nearly three times as long, and the pull is solved
        // against the flight model rather than tuned to one constant — so the same code
        // has to produce a pull there too. This is the check that would fail if it were a
        // fitted number: a full-power minis pull is a disc in the car park at sevens.
        let big = Engine(format: .sevens, seed: 5)
        big.autoTeams = [0, 1]
        var bigReleased: Vec3d?
        var bigFlew = 0.0
        var bigLive = false
        for _ in 0..<(120 * 60) {
            let before = big.game.phase
            big.step(dt: dt)
            if before == .prePull, big.game.phase == .pullInFlight {
                bigReleased = big.disc.state.pos
            }
            if let from = bigReleased, big.game.phase == .pullInFlight {
                bigFlew = Swift.max(bigFlew, distXZ(from, big.disc.state.pos))
            }
            if big.game.phase == .livePossession {
                bigLive = true
                break
            }
        }
        Check.ok(bigLive, "a regulation pull is put into play too")
        Check.ok(
            bigFlew > big.format.field.goalLine,
            "and it crosses more than a goal line's worth of pitch (\(bigFlew) m)")
        Check.ok(big.refusals.isEmpty, "with nothing refused: \(big.refusals.prefix(3))")
    }

    /// Ten minutes of 3v3 with both sides automated. Nothing here may go non-finite,
    /// nobody may end a tick off the pitch, the disc and the rules must agree about whose
    /// hand it is in, and the machine must never refuse anything the engine reports.
    ///
    /// A NaN in one position propagates through the AI's distance sums into every
    /// decision within a frame, and on screen it looks like players simply vanishing — a
    /// symptom that tells you nothing about where it started. Checking every tick is what
    /// makes the first bad frame the reported one.
    private static func playsWithoutBlowingUp() {
        // Played to 25 rather than the minis 7 so that ten minutes of ticks is ten minutes
        // of ticks. This loop asserts a dozen properties per player per tick and is most of
        // the suite's assertion count, so a match that *finishes* early silently halves the
        // coverage — which is exactly what happened the moment the offence started scoring:
        // the engine reached 7-1 in 313 s and this test quietly stopped at half its budget.
        // Reaching the target, halftime and game-over are covered by `aGameHasAHalfAndAnEnd`
        // and `scoreOnlyMovesOnGoals`; what this one is for is the ten minutes in between.
        let e = Engine(format: .minis, target: 25, seed: 7)
        e.autoTeams = [0, 1]
        var worstOut = 0.0
        var airborneSeen = false
        var pullFlights = 0
        var occupancy: [String: Int] = [:]
        var longestDead = 0
        var deadRun = 0

        for _ in 0..<(120 * 600) where !e.isOver {
            let before = e.game.phase
            e.step(dt: dt)
            if before == .prePull, e.game.phase == .pullInFlight { pullFlights += 1 }
            occupancy[e.game.phase.rawValue, default: 0] += 1
            // A dead disc that nobody collects is the shape a wedged match takes: every
            // other assertion here keeps passing while the game quietly stops.
            deadRun = e.game.phase == .turnoverDead ? deadRun + 1 : 0
            longestDead = Swift.max(longestDead, deadRun)

            for p in e.players {
                Check.ok(
                    p.pos.x.isFinite && p.pos.y.isFinite && p.pos.z.isFinite,
                    "player \(p.id) position stays finite")
                Check.ok(
                    p.vel.x.isFinite && p.vel.z.isFinite, "player \(p.id) velocity stays finite")
                Check.ok(
                    p.energy >= 0.12 && p.energy <= 1,
                    "player \(p.id) energy stays on its rails (\(p.energy))")
                worstOut = Swift.max(
                    worstOut,
                    Swift.max(
                        abs(p.pos.x) - e.format.field.sideline,
                        abs(p.pos.z) - e.format.field.endLine))
                if p.airborne { airborneSeen = true }
            }
            let d = e.disc.state.pos
            Check.ok(d.x.isFinite && d.y.isFinite && d.z.isFinite, "the disc stays finite")
            Check.ok(e.stall.isFinite && e.possessionTime.isFinite, "the count stays finite")

            // Double bookkeeping is what the rewrite exists to remove, so the one place
            // the two layers each hold a fact — the disc's hand and the machine's thrower
            // — is asserted every tick rather than assumed.
            Check.ok(
                e.carrier == nil || e.carrier == e.game.thrower || e.game.phase == .prePull,
                "a held disc is held by the machine's thrower "
                    + "(disc \(String(describing: e.carrier)) vs "
                    + "rules \(String(describing: e.game.thrower)) in \(e.game.phase.rawValue))")
            Check.ok(
                e.stall <= Double(e.rules.stallMax), "the count never passes stallMax")
        }

        // **The bound is the reference's, which is not what this used to say.**
        //
        // It asserted one metre, with a comment claiming the reference permitted the same.
        // It does not: `PLAY_BOUND_X/Z` are `SIDELINE + 2.5` and `END_LINE + 2.5`, because
        // a sideline has run-off behind it and a body carrying speed across the line has
        // to go somewhere. One metre held only for as long as nothing perturbed the match;
        // the first change that did — a breeze — put a shoved body at 1.09 m and failed a
        // check that was measuring the wrong thing.
        //
        // Two and a half metres is now enforced rather than hoped for: `Engine.keepOnField`
        // is a hard clamp, ported from the reference, where before there was nothing but
        // the AI's perimeter *steering* cap — which cannot survive contact separation
        // pushing a body sideways.
        let runOff = 2.5
        Check.ok(
            worstOut <= runOff + 1e-9,
            "players stay inside the run-off (worst excursion \(worstOut) m)")
        Check.note("worst excursion onto the run-off: \(worstOut) m of 2.5")

        // Exactly one pull per point, and no point without one. The current point may not
        // have pulled yet, which is the only slack in the identity.
        let pulls = e.game.teamStats(0).pulls + e.game.teamStats(1).pulls
        Check.eq(pulls, pullFlights, "every pull thrown reached PULL_IN_FLIGHT")
        Check.ok(
            pulls == e.game.point || pulls == e.game.point - 1,
            "one pull per point (\(pulls) pulls, point \(e.game.point))")

        // Twenty seconds of nobody picking a dead disc up is not a rules edge case, it is
        // the match having stopped with the assertions still green.
        Check.ok(
            Double(longestDead) * dt < 20,
            "a dead disc is always collected (worst wait \(Double(longestDead) * dt)s)")

        Check.note(
            "engine: \(Int(e.clock))s  score \(e.score[0])-\(e.score[1])  "
                + "point \(e.game.point)  pulls \(pulls)  "
                + "throws \(e.stats.throwsMade)  completed \(e.stats.completions)  "
                + "blocked \(e.stats.blocks)  stalled \(e.stats.stalled)  "
                + "grounded \(e.stats.grounded)  out \(e.stats.outOfBounds)  "
                + "airborne seen: \(airborneSeen)")
        Check.note(
            "engine phases (s): "
                + occupancy.sorted { $0.value > $1.value }
                .map { "\($0.key) \(Int(Double($0.value) * dt))" }
                .joined(separator: "  "))

        Check.ok(e.stats.throwsMade > 0, "the AI actually throws (\(e.stats.throwsMade))")
        Check.ok(
            e.refusals.isEmpty,
            "the machine refused nothing in ten minutes of play: \(e.refusals.prefix(3))")

        // The play-by-play is written by the machine and was never read; a match that
        // produced no log line is a match that never told anybody what happened.
        Check.ok(e.game.getLog().count > 10, "the machine wrote a play-by-play")
    }

    /// The score may only ever rise, by exactly one, and only on a goal — checked on both
    /// formats, because they do not play the same game and only one of them is the one the
    /// AI was written for.
    private static func scoreOnlyMovesOnGoals() {
        // Three sevens seeds, not one. The huck and tempo telemetry swings hard
        // between matches — holds/breaks moved 3/9 to 6/6 between two tuning runs
        // that differed by one constant — and a lever judged on a single seed is
        // judged on noise.
        var pool: [SevensSample] = []
        for seed in [UInt32(11), 23, 37] {
            if let sample = playAndMeasure(.sevens, seed: seed) { pool.append(sample) }
        }
        // **Minis is measured over three seeds too, and it is ASSERTED now.**
        //
        // It used to be one seed with the bands switched off and a note saying the game was
        // still backward. That note was true when it was written and it stopped being true
        // silently, which is the failure mode a `Check.note` always has. Minis is the format
        // the pre-game sheet offers by DEFAULT, so it is the first thing a new player sees
        // and it is the one that has never had a band under it.
        var minisPool: [SevensSample] = []
        for seed in [UInt32(11), 3, 7] {
            if let sample = playAndMeasure(.minis, seed: seed) { minisPool.append(sample) }
        }
        theDeepGameAndTheHoldShare(pool)
        minisIsPlayable(minisPool)
    }

    /// One seed's worth of the two numbers that are TAILS rather than rates, plus the
    /// rates the minis bands are built on.
    private struct SevensSample {
        let seed: UInt32
        let holds: Int
        let breaks: Int
        let longest: Double
        let hucks: Int
        /// Goals in the fifteen minutes measured.
        let goals: Int
        /// Seconds of LIVE_POSSESSION per throw attempt.
        let cadence: Double
        /// `completions / attempts` off the rules machine, as a percentage.
        let passPct: Double
        let stallOuts: Int
        /// Throwaways + drops + stall-outs + blocks: every way a possession changed hands
        /// other than a goal.
        let turnovers: Int
        let meanGain: Double
        /// Did the match reach its target inside the fifteen minutes measured? For minis
        /// this is the whole of "playable": a game to 7 that does not finish is the bug.
        let finished: Bool
    }

    /// **THE DEFAULT GAME MODE, ASSERTED.** Issue #66.
    ///
    /// A human-driven minis session on Normal measured possession alternating every ten
    /// seconds with every possession ending at the stall count, 0-0 after 150 s, and a UI
    /// test timing out after ninety seconds waiting for its own possession. Nothing in the
    /// suite failed, because everything in the suite was a sevens band and the one minis
    /// match was measured and not asserted.
    ///
    /// The four numbers below are the ones that were wrong, in the order they were wrong:
    /// the count reached 8 before anybody released, so almost nothing was thrown, so the
    /// possession died on the count, so nobody scored. Each is a rate over a hundred-odd
    /// throws or a dozen-odd points per match and they are pooled across the three seeds,
    /// because `.agents/friction-log` has two entries about per-seed bands resampling on
    /// any change that reshuffles the match — and every change to this game reshuffles it.
    private static func minisIsPlayable(_ pool: [SevensSample]) {
        guard !pool.isEmpty else { return }
        let n = Double(pool.count)
        let goals = pool.reduce(0) { $0 + $1.goals }
        let stalls = pool.reduce(0) { $0 + $1.stallOuts }
        let turnovers = pool.reduce(0) { $0 + $1.turnovers }
        let holds = pool.reduce(0) { $0 + $1.holds }
        let points = pool.reduce(0) { $0 + $1.holds + $1.breaks }
        let att = pool.reduce(0.0) { $0 + $1.passPct }
        let cadence = pool.reduce(0.0) { $0 + $1.cadence } / n
        let stallShare = turnovers > 0 ? Double(stalls) / Double(turnovers) : 0
        let holdShare = points > 0 ? Double(holds) / Double(points) : 0
        Check.note(
            "minis pooled over \(pool.count) matches: \(goals) goals, "
                + "\(stalls) stall-outs of \(turnovers) turnovers = "
                + String(format: "%.0f%%", stallShare * 100)
                + ", holds \(holds) of \(points) = " + String(format: "%.0f%%", holdShare * 100)
                + ", mean cadence " + String(format: "%.1f", cadence) + " s, mean completion "
                + String(format: "%.0f%%", att / n)
                + " (per seed: "
                + pool.map {
                    "s\($0.seed) \($0.goals)g " + String(format: "%.1f", $0.cadence) + "s "
                        + String(format: "%.0f%%", $0.passPct) + " \($0.stallOuts)so"
                }.joined(separator: ", ") + ")")

        /// **The count is not how a possession ends.** This is the assertion the whole issue
        /// is about: measured before the fix, 56-89% of the turnovers in a minis match were
        /// stall-outs, and with the computer playing both sides the release itself came at
        /// stall 8 or 9 on two thirds of throws. A stall-out is a real event in the sport and
        /// the bar is not zero; it is a small minority.
        Check.ok(
            stallShare <= 0.25,
            "minis possessions do not die on the count (\(stalls) stall-outs of "
                + "\(turnovers) turnovers = " + String(format: "%.0f%%", stallShare * 100) + ")")
        /// Tempo. Real throwers go every 3-6 s of live play; a 3v3 give-and-go game sits at
        /// the quick end of that and the sevens band (3.5-7.5) is the slow end of it. Before
        /// the fix this was 5.4-7.0 s and rising with the stall count that produced it.
        Check.ok(
            cadence >= 3.0 && cadence <= 6.5,
            "the disc moves at a 3v3 tempo (a release every "
                + String(format: "%.1f", cadence) + " s of live play)")
        /// Goals happen. A minis game is to 7, so this is also the statement that the default
        /// mode FINISHES: at this rate a game to 7 takes four to five minutes and a game to 3
        /// takes under two. The ceiling is here because a scoring rate this high is only
        /// authentic while the completions are, and the two are asserted together.
        /// **A game to seven finishes.** This is the plainest statement of the issue: the
        /// default mode was 0-0 after 150 s of real play and a UI test waited ninety seconds
        /// for a possession of its own. `Engine(format: .minis, seed:)` plays to 7, and the
        /// loop above runs for fifteen simulated minutes, so `isOver` is the whole question.
        Check.ok(
            pool.allSatisfy(\.finished),
            "a minis game to 7 finishes inside fifteen minutes "
                + "(\(pool.filter(\.finished).count) of \(pool.count))")
        Check.ok(
            goals >= 7 * pool.count && goals <= 34 * pool.count,
            "and goals are how it finishes (\(goals) in \(pool.count) matches)")
        Check.ok(
            att / n >= 80 && att / n <= 98,
            "at a completion rate a short-pass game would recognise "
                + String(format: "%.0f%%", att / n))
        Check.ok(
            points >= 12 && holdShare >= 0.30 && holdShare <= 0.90,
            "and the receiving team holds more often than not, over \(points) points "
                + "(\(holds) = " + String(format: "%.0f%%", holdShare * 100) + ")")
    }

    /// THE TWO NUMBERS THAT CANNOT BE ASSERTED ONE SEED AT A TIME.
    ///
    /// `playAndMeasure` asserts its own bands per seed, and that is right for a *rate*:
    /// completion percentage is a hundred and twenty throws, mean gain is a hundred
    /// completions, cadence is the whole match. Two of the numbers it was asserting are
    /// not rates:
    ///
    ///   - the **longest completion** is the maximum over the two to thirteen hucks a
    ///     match happens to attempt;
    ///   - the **hold share** is a ratio over eleven to seventeen points, and the comment
    ///     on the band says so itself: "three seeds cannot resolve a percentage to better
    ///     than about fifteen points".
    ///
    /// Asserted per seed, both resample on any change that reshuffles the match — and
    /// every change to the calls layer reshuffles it, because a stoppage moves everything
    /// after it. Five configurations of the #59 foul work, none of which touched throwing
    /// code, moved the three seeds' longest completions over 35/34/33, 35/34/27,
    /// 35/26/26, 35/29/27 and 35/27/27 m, and s37's hold share over 67 / 71 / 86%. None of
    /// that is a statement about the deep game; it is the same deep game sampled five
    /// times.
    ///
    /// So they are pooled, which is what they always meant. A build that really has lost
    /// the deep game has no 28 m completion in forty-five minutes of it, and a build that
    /// has stopped defending holds 86% of forty-four points rather than of fourteen.
    private static func theDeepGameAndTheHoldShare(_ sevensPool: [SevensSample]) {
        guard !sevensPool.isEmpty else { return }
        let longest = sevensPool.map(\.longest).max() ?? 0
        let holds = sevensPool.reduce(0) { $0 + $1.holds }
        let points = sevensPool.reduce(0) { $0 + $1.holds + $1.breaks }
        let hucks = sevensPool.reduce(0) { $0 + $1.hucks }
        let holdShare = points > 0 ? Double(holds) / Double(points) : 0
        Check.note(
            "sevens pooled over \(sevensPool.count) matches: holds \(holds) of \(points) = "
                + String(format: "%.0f%%", holdShare * 100) + ", \(hucks) hucks attempted, "
                + "longest completion " + String(format: "%.1f", longest) + " m "
                + "(per seed: "
                + sevensPool.map {
                    "s\($0.seed) \($0.holds)/\($0.holds + $0.breaks) "
                        + String(format: "%.1f", $0.longest) + " m"
                }.joined(separator: ", ") + ")")
        Check.ok(
            hucks >= 2 * sevensPool.count,
            "the deep game exists (\(hucks) huck attempts over \(sevensPool.count) matches)")
        Check.ok(
            longest >= 28,
            "and the deep game reaches downfield somewhere in \(sevensPool.count) matches "
                + "(longest completion " + String(format: "%.1f", longest) + " m)")
        Check.ok(
            points >= 24 && holdShare >= 0.30 && holdShare <= 0.85,
            "and the offence holds more often than not, over \(points) points "
                + "(\(holds) = " + String(format: "%.0f%%", holdShare * 100) + ")")
    }

    /// Fifteen simulated minutes, asserted and measured.
    ///
    /// **The measurement half of this is not decoration.** For most of this project the
    /// only number anyone looked at was the completion rate, and it hid the exact opposite
    /// of what it appeared to show: one version of the throw solver reached 89% completion
    /// and scored nothing at all in fifteen minutes, because players can swing a disc side
    /// to side all afternoon without ever facing the endzone. So the gain is measured
    /// directly — metres downfield, signed toward the throwing team's attacking end.
    ///
    /// Running it on **both** formats is what located every minis bug this file has ever
    /// carried, and the reason both are asserted now rather than one. `AI.ts` and
    /// `Playbook.ts` are ported faithfully; what was wrong each time was that their *shape*
    /// and *value* constants assume seven players on a hundred metres.
    ///
    ///  - `chooseFormation` switched to the endzone set inside 13 m of the goal, which on a
    ///    12.5 m minis half is the entire pitch. Scaled off the goal line.
    ///  - the endzone set made every player a handler and `PLAY.stackHold` blocked every cut
    ///    at a three-player roster, so nobody ever cut at all. Both proportional to the
    ///    roster now — `Playbook.handlerCount`, `Playbook.stackHold`.
    ///  - every downfield offset in `formationStations` and `buildCut` was metres chosen on a
    ///    32 m half-field: the vertical stack's five stations span 27.8 m, which is nine
    ///    metres past the minis END LINE, so all five clamped into the back of the endzone
    ///    and stood on each other. `Playbook.depthScale` / `widthScale`.
    ///  - `possessionValue`'s 64 and 18 are the regulation goal-to-goal length and endzone
    ///    depth, so the whole minis pitch fitted inside the flat top of the value curve: a
    ///    completion that gained a quarter of the field was priced at +0.04 while the
    ///    turnover it risked still cost a full-size 0.46. A rational thrower held, the count
    ///    ran to 8, and 56-89% of every turnover in a minis match was a stall-out.
    ///
    /// Each of those was invisible at sevens, and each is invisible again the moment a scale
    /// is 1.0 — which it is, exactly, on the regulation field. That is what makes it safe:
    /// every sevens number in this file, to the last digit, is unchanged by the whole set.
    ///
    /// The reference's own headless harness (`node tools/test-game.ts`) is the outside
    /// number to hold this against: 8 points, 109 throws, 86 completions in 600 s of 7v7.
    @discardableResult
    private static func playAndMeasure(_ format: GameFormat, seed: UInt32) -> SevensSample? {
        let e = Engine(format: format, seed: seed)
        let label = (format.field.length > 50 ? "sevens" : "minis") + "/s\(seed)"
        e.autoTeams = [0, 1]
        var last = e.score
        var goals = 0

        var completions = 0
        var heldPos: Vec3d?
        var heldTeam: TeamId?
        var gains: [Double] = []
        var closest = Double.infinity

        // Huck and tempo telemetry: how far each throw actually travelled (release point
        // to the completing catch), how far each attempt flew whether or not it was
        // caught, and how many seconds of live possession sit between releases.
        var throwsSeen = 0
        var releasePos: Vec3d?
        var flightMax = 0.0
        var liveTicks = 0
        var completedDists: [Double] = []
        var attemptDists: [Double] = []
        var statsAtRelease: (Int, Int, Int, Int)?
        var stallAtRelease = 0.0
        var huckStalls: [Double] = []
        var huckOutcomes: [String: Int] = [:]

        for _ in 0..<(120 * 900) where !e.isOver {
            e.step(dt: dt)
            if e.game.phase == .livePossession { liveTicks += 1 }

            if e.stats.throwsMade > throwsSeen {
                throwsSeen = e.stats.throwsMade
                releasePos = e.disc.state.pos
                flightMax = 0
                statsAtRelease = (
                    e.stats.completions, e.stats.blocks, e.stats.grounded, e.stats.outOfBounds
                )
                stallAtRelease = e.stall
            }
            if e.game.phase == .discInFlight, let rp = releasePos {
                flightMax = Swift.max(flightMax, distXZ(rp, e.disc.state.pos))
            } else if let _ = releasePos, flightMax > 0, e.game.phase != .discInFlight {
                // The flight ended one way or another: record the attempt and how it died.
                attemptDists.append(flightMax)
                if flightMax >= 28, let s0 = statsAtRelease {
                    huckStalls.append(stallAtRelease)
                    if e.stats.completions > s0.0 {
                        huckOutcomes["caught", default: 0] += 1
                    } else if e.stats.blocks > s0.1 {
                        huckOutcomes["blocked", default: 0] += 1
                    } else if e.stats.grounded > s0.2 {
                        huckOutcomes["grounded", default: 0] += 1
                    } else if e.stats.outOfBounds > s0.3 {
                        huckOutcomes["out", default: 0] += 1
                    } else {
                        huckOutcomes["other", default: 0] += 1
                    }
                }
                releasePos = nil
                flightMax = 0
            }

            if e.stats.completions > completions, let from = heldPos, let team = heldTeam,
                let to = e.carrier.flatMap({ id in e.players.first { $0.id == id } })?.pos
            {
                gains.append(Double(e.dirFor(team)) * (to.z - from.z))
                completedDists.append(distXZ(from, to))
            }
            completions = e.stats.completions
            if let id = e.carrier, let p = e.players.first(where: { $0.id == id }) {
                heldPos = p.pos
                heldTeam = p.team
                closest = min(
                    closest, abs(e.format.field.goalLine * Double(e.dirFor(p.team)) - p.pos.z))
            }

            if e.score != last {
                let delta = (e.score[0] - last[0]) + (e.score[1] - last[1])
                Check.eq(delta, 1, "the score moves by exactly one")
                Check.ok(
                    e.score[0] >= last[0] && e.score[1] >= last[1], "the score never falls")
                Check.ok(e.justScored != nil, "a score is accompanied by a scoring team")
                Check.ok(
                    e.game.phase == .pointScored, "and by the machine's POINT_SCORED phase")
                Check.eq(
                    e.game.lastScore?.score ?? [], e.score, "the goal record carries the new score")
                goals += 1
                last = e.score
            }
        }
        Check.eq(
            e.score[0] + e.score[1], e.stats.goals, "every point on the board is a goal in the box")

        let forward = gains.filter { $0 > 0.5 }.count
        let back = gains.filter { $0 < -0.5 }.count
        let mean = gains.reduce(0, +) / Double(max(1, gains.count))
        let holds = e.game.teamStats(0).holds + e.game.teamStats(1).holds
        let breaks = e.game.teamStats(0).breaks + e.game.teamStats(1).breaks
        let meanText = String(format: "%+.2f", mean)
        let longestText = String(format: "%+.1f", gains.max() ?? 0)
        Check.note(
            "\(label): \(goals) goals in fifteen minutes, \(holds) holds / \(breaks) breaks, "
                + "\(gains.count) completions, mean gain \(meanText) m "
                + "(\(forward) forward / \(back) back), longest \(longestText) m")

        // Authenticity telemetry: hucks and tempo. A huck is a throw that travelled 30 m
        // or more; attempts are measured off the flight itself, so an underthrown bomb
        // that dies 28 m out still counts as intent. Tempo is seconds of LIVE_POSSESSION
        // per release — real throwers go every 3-6 s.
        let hucksCompleted = completedDists.filter { $0 >= 30 }.count
        let hucksAttempted = attemptDists.filter { $0 >= 28 }.count
        let throwsTotal = e.stats.throwsMade
        let compPct = throwsTotal > 0
            ? 100.0 * Double(e.stats.completions) / Double(throwsTotal) : 0
        let cadence = throwsTotal > 0
            ? Double(liveTicks) * dt / Double(throwsTotal) : .infinity
        // Where the incompletions go, off the RULES MACHINE's box score rather than the
        // engine's counters.
        //
        // **The engine's `throwsMade` counts pulls, and a pull is not a pass.** Fourteen
        // pulls in a fifteen-minute match against about sixty completions is a ten-point
        // hole in any completion percentage computed from it, and every one of those pulls
        // also lands as a `grounded` or an `out`. The percentage below is
        // `completions / attempts` from `TeamStats`, which is the sport's own definition
        // and the number the 85-96% real-ultimate band is quoted against.
        let att = e.game.teamStats(0).attempts + e.game.teamStats(1).attempts
        let comp = e.game.teamStats(0).completions + e.game.teamStats(1).completions
        let aways = e.game.teamStats(0).throwaways + e.game.teamStats(1).throwaways
        let drops = e.game.teamStats(0).drops + e.game.teamStats(1).drops
        let stalls = e.game.teamStats(0).stallOuts + e.game.teamStats(1).stallOuts
        let passPct = att > 0 ? 100.0 * Double(comp) / Double(att) : 0
        Check.note(
            "\(label) passing: \(comp)/\(att) = " + String(format: "%.0f%%", passPct)
                + "  (\(aways) throwaways, \(drops) drops, \(stalls) stall-outs); "
                + "engine counters incl. pulls: \(e.stats.completions) caught  "
                + "\(e.stats.blocks) blocked  \(e.stats.grounded) grounded  "
                + "\(e.stats.outOfBounds) out  of \(throwsTotal)")
        Check.note(
            "\(label) tempo/hucks: \(throwsTotal) throws, "
                + String(format: "%.0f%%", compPct) + " completed, release every "
                + String(format: "%.1f", cadence) + " s of live play, hucks "
                + "\(hucksAttempted) attempted / \(hucksCompleted) completed >=30 m, "
                + "longest throw " + String(format: "%.1f", completedDists.max() ?? 0) + " m")
        if !huckOutcomes.isEmpty {
            let lateHucks = huckStalls.filter { $0 >= 7 }.count
            Check.note(
                "\(label) huck outcomes: "
                    + huckOutcomes.sorted { $0.value > $1.value }
                    .map { "\($0.key) \($0.value)" }.joined(separator: "  ")
                    + "  (\(lateHucks) of \(huckStalls.count) released at stall >= 7)")
        }

        // The one assertion that says the sport is happening. Sevens is the shape the AI
        // was written and validated for, so it is held to it; minis is knowingly below the
        // bar and is measured rather than asserted, so this file reports the gap instead of
        // going quietly green on a game where nobody cuts.
        /**
         * **The bands, asserted rather than printed.**
         *
         * Everything above this was a `Check.note`, and fifteen minutes of sevens was
         * guarded by `goals > 0` and `mean > 0` — one goal and a centimetre of average
         * gain passed. That is not a test of the sport; it is a test that the engine
         * runs. The numbers below are the ones this file lands on, widened for seed
         * variance, and each of them fails on a different real regression:
         *
         *  - `passPct` is `completions / attempts` off the RULES MACHINE, the sport's own
         *    definition and the one the 85-96% real-ultimate band is quoted against. The
         *    three asserted seeds sit at 84 / 89 / 90%. The floor is 80 rather than 85
         *    because s11 is genuinely under the sport's band and saying so is the point;
         *    the ceiling catches an offence that has stopped taking any risk at all.
         *  - the HOLD SHARE is the number issue #17 is about: what fraction of points the
         *    receiving team scores. Real elite ultimate holds about 70%. These seeds sit
         *    at 40 / 58 / 62% and the pooled reference measurement over 24 fifteen-minute
         *    matches is 57%, up from 49%. The band is deliberately wide — three seeds
         *    cannot resolve a percentage to better than about fifteen points — but it has
         *    a FLOOR, which is what stops a change that quietly hands the disc away.
         *  - mean gain, cadence and the deep game are the three that a completion
         *    percentage alone cannot see, and the reason this function measures at all:
         *    an offence can swing a disc sideways at 99% forever.
         *
         * The hold share, the huck count and the longest completion are asserted by
         * `theDeepGameAndTheHoldShare` over the three sevens seeds together rather than
         * here, one seed at a time. They are tails and ratios over a dozen events, not
         * rates over a hundred, and per seed they resample on any change that reshuffles
         * the match. What is asserted per seed is what a single match can resolve.
         */
        var sample: SevensSample?
        if format.field.length > 50 {
            Check.ok(goals >= 8 && goals <= 24, "sevens scores like sevens (\(goals) goals)")
            Check.ok(
                mean >= 3 && mean <= 14,
                "and the offence advances (mean \(meanText) m per completion)")
            Check.ok(
                passPct >= 80 && passPct <= 96,
                "at a completion rate the sport would recognise "
                    + "(\(String(format: "%.0f%%", passPct)))")
            let points = holds + breaks
            let holdShare = points > 0 ? Double(holds) / Double(points) : 0
            // The hold share and the longest completion are pooled across the three sevens
            // seeds by `theDeepGameAndTheHoldShare` — see there for why neither survives
            // being asserted one match at a time.
            Check.ok(points >= 8, "and a match is a match (\(points) points)")
            Check.ok(
                cadence >= 3.5 && cadence <= 7.5,
                "the disc moves at a human tempo (a release every "
                    + String(format: "%.1f", cadence) + " s of live play)")
        }
        // The sample is built for BOTH formats. It used to be built only inside the sevens
        // branch, with the minis arm of the `if` printing a note that the game was still
        // backward — so the format the pre-game sheet offers by default had no pooled
        // measurement to assert and no band to fail. `minisIsPlayable` asserts these; the
        // sevens tails go to `theDeepGameAndTheHoldShare`.
        sample = SevensSample(
            seed: seed, holds: holds, breaks: breaks,
            longest: completedDists.max() ?? 0, hucks: hucksAttempted,
            goals: goals, cadence: cadence, passPct: passPct, stallOuts: stalls,
            turnovers: aways + drops + stalls + e.stats.blocks, meanGain: mean,
            finished: e.isOver)
        return sample
    }

    /// A match reaches halftime, comes back from it, and ends.
    ///
    /// Halftime, the second-half restart and the game-over decision were all ported and
    /// none of them had a caller: the engine ended a match by comparing two integers and
    /// never had a second half at all. Played to two here so the whole shape fits in a few
    /// hundred simulated seconds — the machine puts halftime at the midpoint of whatever
    /// length the game is, so a game to two breaks after the first goal.
    private static func aGameHasAHalfAndAnEnd() {
        let e = Engine(format: .minis, target: 2, seed: 29)
        e.autoTeams = [0, 1]
        Check.eq(e.game.rules.halftimeAt, 1, "a game to two breaks at one")
        let openingDirs = [e.game.attackDir[0], e.game.attackDir[1]]
        let openingPuller = e.game.pullingTeam

        var sawHalftime = false
        var dirsAtHalf: [Dir] = []
        var ticks = 0
        while !e.isOver && ticks < 120 * 1200 {
            e.step(dt: dt)
            ticks += 1
            if e.game.phase == .halftime, !sawHalftime {
                sawHalftime = true
                dirsAtHalf = [e.game.attackDir[0], e.game.attackDir[1]]
                Check.eq(e.game.half, 1, "the break happens at the end of the first half")
                Check.ok(e.carrier == nil, "and nobody is holding through it")
            }
        }

        Check.ok(sawHalftime, "the match reached halftime")
        Check.ok(e.isOver, "and then ended (\(e.score[0])-\(e.score[1]) after \(Int(e.clock))s)")
        Check.ok(e.game.phase == .gameOver, "the machine declared it over")
        Check.eq(e.game.half, 2, "in the second half")
        Check.ok(
            abs(e.score[0] - e.score[1]) >= e.rules.winBy, "with a winning margin")
        Check.ok(
            Swift.max(e.score[0], e.score[1]) >= e.game.target, "and somebody on the target")
        // Guarded rather than indexed blind. `dirsAtHalf` is only filled if halftime was
        // observed, and when it was not this line crashed the entire suite with an index
        // out of range — turning one failed assertion into no report at all. A check that
        // cannot fail cleanly is worse than one that fails.
        if let atHalf = dirsAtHalf.first {
            Check.ok(
                e.game.attackDir[0] != atHalf || e.game.attackDir[0] != openingDirs[0],
                "ends were swapped along the way")
        } else {
            Check.ok(false, "no halftime was observed, so ends could not be checked")
        }
        Check.eq(
            e.game.openingPullTeam, openingPuller, "the opening pull team is remembered")
        Check.ok(e.refusals.isEmpty, "and nothing was refused: \(e.refusals.prefix(3))")

        // A finished game stays finished: stepping it must not restart the clock or move
        // a body, which is the difference between an ending and a pause.
        let frozenClock = e.clock
        let frozenScore = e.score
        let frozenPositions = e.players.map(\.pos.z)
        for _ in 0..<600 { e.step(dt: dt) }
        Check.bitEqViaJSON(e.clock, frozenClock, "a finished game's clock has stopped")
        Check.eq(e.score, frozenScore, "and its score")
        Check.eq(e.players.map(\.pos.z), frozenPositions, "and nobody is still running")

        Check.note(
            "engine: a game to two took \(Int(e.clock))s and "
                + "\(e.game.point - 1) points, halftime included")
    }

    /// The count is the marker's, and it does not run without one.
    ///
    /// Driven against `GameState` directly rather than through the engine, because the
    /// property under test is the *contract the engine must satisfy*: feed the machine a
    /// frame with no mark, or with a mark standing off, and ten seconds of holding is not
    /// a stall. An engine that forgets to report the marker gets a count that never runs;
    /// one that reports it wrongly gets a count that runs while nobody is on the thrower.
    private static func theCountNeedsAMarker() {
        let rules = DEFAULT_RULES
        let holder = Vec3d(0, 0, -8)

        /// The counts the machine called out loud.
        ///
        /// Sampled from `stall:tick` rather than from `stallCount`, because the tick that
        /// reaches `stallMax` also stalls the thrower out and resets the count to zero in
        /// the same call — so a caller polling the field after `step` never sees ten.
        let calls = CountRecorder()

        /// A minis game wound forward to a live possession for player 0 (team 0), the
        /// receiving side, with player 3 (team 1) available to mark.
        func live() -> GameState {
            var opts = GameStateOptions()
            opts.format = .minis
            opts.emit = { [calls] event in calls.absorb(event) }
            let g = GameState(opts)
            g.startGame()
            Check.ok(g.pull(3, Vec3d(0, 1, 11.8)).ok, "the pull is legal from PRE_PULL")
            Check.ok(g.pullCaught(0, holder).ok, "and catching it is legal in PULL_IN_FLIGHT")
            Check.ok(g.phase == .livePossession, "a caught pull is a live possession")
            return g
        }

        // Nobody marking at all.
        let unmarked = live()
        for _ in 0..<(120 * 12) {
            unmarked.step(dt, FrameObservation(throwerPos: holder, markerId: .null))
        }
        Check.eq(unmarked.stallCount, 0, "twelve seconds with nobody marking is not a count")
        Check.ok(!unmarked.markerLegal(), "and there is no legal mark to run one")
        Check.ok(unmarked.phase == .livePossession, "the possession is still live")

        // A marker, but standing off outside `markerRange`.
        let far = live()
        let standoff = Vec3d(0, 0, holder.z - (rules.markerRange + 2))
        for _ in 0..<(120 * 12) {
            far.step(
                dt,
                FrameObservation(
                    throwerPos: holder, markerId: .value(3), markerPos: .value(standoff)))
        }
        Check.eq(far.stallCount, 0, "a marker outside markerRange is not marking")
        Check.ok(!far.markerLegal(), "and the machine says so")

        Check.eq(calls.highest, 0, "nothing so far has produced a single count")

        // A marker on him, legally.
        let marked = live()
        let onHim = Vec3d(0, 0, holder.z - 1.5)
        var ticks = 0
        while marked.phase == .livePossession && ticks < 120 * 20 {
            marked.step(
                dt,
                FrameObservation(throwerPos: holder, markerId: .value(3), markerPos: .value(onHim)))
            ticks += 1
        }
        Check.ok(marked.phase == .turnoverDead, "a legal mark runs the count all the way out")
        Check.eq(calls.highest, rules.stallMax, "and the marker counts to stallMax exactly")
        Check.eq(calls.ticks, rules.stallMax, "one call per interval, none skipped")
        let elapsed = Double(ticks) * dt
        Check.ok(
            elapsed >= Double(rules.stallMax) * rules.stallInterval - 2 * dt,
            "which takes stallMax intervals of real marking (\(elapsed)s)")

        // A marker inside disc space stops the count too — the same rule, other end.
        let tooClose = live()
        for _ in 0..<(120 * 12) {
            tooClose.step(
                dt,
                FrameObservation(
                    throwerPos: holder, markerId: .value(3),
                    markerPos: .value(Vec3d(0, 0, holder.z - rules.discSpace * 0.5))))
        }
        Check.eq(tooClose.stallCount, 0, "a marker inside disc space is not marking either")

        // And the engine only ever advances the count with a legal mark in place: the
        // wiring above, asserted on a match nobody is steering.
        let e = Engine(format: .minis, seed: 19)
        e.autoTeams = []
        var previous = e.game.stallCount
        var advances = 0
        for _ in 0..<(120 * 240) where !e.isOver {
            e.step(dt: dt)
            let now = e.game.stallCount
            if now > previous {
                advances += 1
                Check.ok(e.game.markerLegal(), "the count only advanced under a legal mark")
                Check.ok(e.game.marker != nil, "and with a named marker")
                Check.ok(
                    e.game.phase == .livePossession || e.game.phase == .turnoverDead,
                    "and only during a possession")
            }
            previous = now
        }
        Check.ok(advances > 0, "the count did advance at some point (\(advances) ticks)")
    }

    /// A possession the human never throws must end on the count.
    ///
    /// The first build of `Engine` had no stall at all. With the computer switched off
    /// for team 0, its handler simply stood there and the count on screen climbed past
    /// thirteen — which is not a rules edge case, it is the game hanging. Nothing in the
    /// suite noticed, because both other tests automate both teams and the AI throws long
    /// before the count matters.
    private static func theCountRunsOut() {
        let e = Engine(format: .minis, seed: 17)
        // Nobody throws: not the computer, and no human input either. The pull still
        // happens, because a pull is a rule rather than a decision.
        e.autoTeams = []

        // The first *possession*, not the first hand on the disc: the puller is holding it
        // before the point starts, and he is not on a count.
        var firstTeam: TeamId?
        var ticks = 0
        while firstTeam == nil && ticks < 120 * 60 {
            e.step(dt: dt)
            ticks += 1
            if e.game.phase == .livePossession { firstTeam = e.possession }
        }
        Check.ok(firstTeam != nil, "the pull is put into play")

        // Run until the first stall-out and read the possession there. Reading it at the
        // end instead would prove nothing: stall-outs alternate, so after an even number
        // of them the disc is legitimately back where it started.
        var stalledTo: TeamId?
        var sawDead = false
        var sawCheck = false
        while ticks < 120 * 300 && !e.isOver {
            e.step(dt: dt)
            ticks += 1
            Check.ok(
                e.stall <= Double(e.rules.stallMax),
                "the count never exceeds stallMax (reached \(e.stall))")
            if e.stats.stalled > 0, stalledTo == nil { stalledTo = e.possession }
            if e.game.phase == .turnoverDead { sawDead = true }
            if e.game.phase == .check { sawCheck = true }
            if sawDead && sawCheck && stalledTo != nil { break }
        }
        // A stall-out leaves the disc on the ground where the pivot was, and it takes a
        // pick-up and a check to restart. Both were ported and neither had a caller.
        Check.ok(sawDead, "the stalled disc goes dead on the ground")
        Check.ok(sawCheck, "and comes back in on a check")

        Check.ok(e.stats.stalled > 0, "the count ran out (\(e.stats.stalled))")
        Check.eq(
            e.game.teamStats(0).stallOuts + e.game.teamStats(1).stallOuts, e.stats.stalled,
            "the engine's tally is the machine's")
        Check.ok(
            stalledTo != nil && stalledTo != firstTeam,
            "a stall-out hands the disc to the other team")
        Check.ok(e.refusals.isEmpty, "and nothing was refused doing it: \(e.refusals.prefix(3))")
    }

    /// A refused `ActionResult` changes nothing.
    ///
    /// The trap this exists for: `GameState` answers an illegal call with `ok: false` and
    /// otherwise does nothing, so an engine that ignores the answer looks like a working
    /// game right up to the phase it mattered in. Both halves are asserted — that the
    /// machine really does refuse, and that the refusal leaves the snapshot untouched.
    private static func aRefusedActionChangesNothing() {
        let e = Engine(format: .minis, seed: 23)
        e.autoTeams = [0, 1]
        var ticks = 0
        while e.game.phase != .livePossession && ticks < 120 * 60 {
            e.step(dt: dt)
            ticks += 1
        }
        Check.ok(e.game.phase == .livePossession, "the match reached a live possession")

        let before = e.game.snapshot()
        let logged = e.game.getLog().count

        let pull = e.game.pull(0, Vec3d(0, 1, 0))
        Check.ok(!pull.ok, "a pull during a live possession is refused")
        Check.ok(pull.note != nil, "and says why")
        Check.eq(e.game.snapshot(), before, "the refused pull changed nothing")

        let check = e.game.check()
        Check.ok(!check.ok, "a check with nothing to check is refused")
        Check.eq(e.game.snapshot(), before, "the refused check changed nothing")

        let pickUp = e.game.pickUp(0)
        Check.ok(!pickUp.ok, "picking up a disc that is in a hand is refused")
        Check.eq(e.game.snapshot(), before, "the refused pick-up changed nothing")

        let block = e.game.block(0, Vec3d())
        Check.ok(!block.ok, "a block with no disc in the air is refused")
        Check.eq(e.game.snapshot(), before, "the refused block changed nothing")

        Check.ok(
            e.game.getLog().count > logged,
            "a refusal is still written down — silence is what makes them invisible")
        Check.ok(
            e.refusals.isEmpty,
            "and none of the engine's own calls was among them: \(e.refusals.prefix(3))")
    }

    /// The human may not throw a disc they are not holding.
    ///
    /// Worth an assertion rather than a comment: the failure mode is not a crash, it is a
    /// second disc appearing mid-flight, and every downstream assertion would still pass.
    private static func theHumanCannotThrowADiscTheyDoNotHave() {
        let e = Engine(format: .minis, seed: 13)
        e.autoTeams = []

        // The point opens with the human's team pulling, so the first thing there is to
        // throw is the pull — and the controlled player is the one holding it.
        Check.eq(e.carrier, e.controlled, "the human's player has the disc on the line")
        Check.ok(
            e.humanRelease(.backhand, aim: Vec3d(0, 0, Double(e.dirFor(0))), power: 0.7),
            "and a gesture pulls it")
        Check.ok(e.game.phase == .pullInFlight, "the machine has a pull in the air")
        Check.eq(e.game.teamStats(0).pulls, 1, "credited to the pulling team")
        Check.ok(e.carrier == nil, "and nobody is holding it any more")
        Check.ok(
            !e.humanRelease(.backhand, aim: Vec3d(0, 0, 1), power: 0.6),
            "a second pull with the disc already gone is refused")

        // Nobody throws for either side, so the disc comes round on the count until the
        // controlled player has it.
        var ticks = 0
        while !(e.game.phase == .livePossession && e.carrier == e.controlled) && ticks < 120 * 240 {
            e.step(dt: dt)
            ticks += 1
            if e.carrier != nil && e.carrier != e.controlled {
                Check.ok(
                    !e.humanRelease(.backhand, aim: Vec3d(0, 0, 1), power: 0.6),
                    "a player who is not holding cannot throw")
            }
        }
        Check.ok(e.carrier != nil, "the controlled player gets the disc")
        Check.eq(e.carrier, e.controlled, "and control follows it")

        let throwsBefore = e.stats.throwsMade
        Check.ok(
            e.humanRelease(.backhand, aim: Vec3d(0, 0, Double(e.dirFor(0))), power: 0.6),
            "the controlled holder can throw")
        Check.ok(e.carrier == nil, "and the disc leaves their hand")
        Check.ok(e.game.phase == .discInFlight, "and the machine has it in the air")
        Check.eq(e.stats.throwsMade, throwsBefore + 1, "and counts the attempt")

        // Now they are not holding, so a second release must be refused.
        Check.ok(
            !e.humanRelease(.backhand, aim: Vec3d(0, 0, 1), power: 0.6),
            "a second throw with no disc is refused")
        Check.ok(e.refusals.isEmpty, "no engine call was refused: \(e.refusals.prefix(3))")

        aTapIsNotABomb()
    }

    /// **The bracket the HUD draws mid-drag and the receiver the release picks are the
    /// same pick.** `Engine.previewReceiver` exists so the player can see who the cone
    /// select means *before* the disc is gone; a preview that could ever disagree with
    /// the release would be worse than none, because it would teach the player a select
    /// that is not the one being played. Both paths funnel through the engine's one
    /// `coneSelect`, and this is the check that fails if a second copy ever appears.
    ///
    /// Also asserted: previewing is read-only. `selectedReceiver` is the record of the
    /// last actual release, and a HUD that polls every frame must not be able to write
    /// history by looking at it.
    private static func thePreviewIsTheRelease() {
        // Straight downfield, both diagonals, a flat swing, and straight back — the
        // last so the empty-cone case is exercised too: a preview of nobody and a
        // release that selects nobody must also agree.
        let drags: [(dx: Double, dz: Double)] = [
            (0, 1), (0.6, 0.8), (-0.6, 0.8), (0.95, 0.2), (0, -1),
        ]
        var somebody = 0
        for (i, d) in drags.enumerated() {
            // A fresh engine per direction, same seed: a release consumes the held
            // disc, so each direction gets its own copy of the identical situation.
            let e = Engine(format: .minis, seed: 29)
            e.autoTeams = []
            var ticks = 0
            while !(e.game.phase == .livePossession && e.carrier == e.controlled),
                ticks < 120 * 240
            {
                e.step(dt: dt)
                ticks += 1
            }
            guard e.carrier == e.controlled else {
                Check.ok(false, "a live disc reached the controlled player")
                return
            }

            // Downfield-relative, so the drag means the same thing whichever end the
            // human attacks after the flip.
            let aim = Vec3d(d.dx, 0, d.dz * Double(e.dirFor(0)))
            let before = e.selectedReceiver
            let preview = e.previewReceiver(dx: aim.x, dz: aim.z)
            Check.eq(
                e.previewReceiver(dx: aim.x, dz: aim.z), preview,
                "drag \(i): the preview is a pure function of the state it reads")
            Check.eq(
                e.selectedReceiver, before,
                "drag \(i): previewing wrote nothing — selectedReceiver still records "
                    + "the last actual release")
            Check.ok(
                e.humanRelease(.backhand, aim: aim, power: 0.6),
                "drag \(i): the same direction releases")
            Check.eq(
                e.selectedReceiver, preview,
                "drag \(i): the release selected exactly who the preview showed "
                    + "(\(String(describing: preview)))")
            if preview != nil { somebody += 1 }
        }
        Check.ok(
            somebody >= 1,
            "at least one drag actually had a receiver in the cone (\(somebody) of "
                + "\(drags.count)) — an all-nil sweep would assert nothing")

        // And with no disc in hand there is nothing to preview: the HUD's highlight
        // must clear the moment a release would be refused.
        let flying = Engine(format: .minis, seed: 29)
        flying.autoTeams = []
        Check.ok(
            flying.humanRelease(.backhand, aim: Vec3d(0, 0, Double(flying.dirFor(0))), power: 0.7),
            "the pull releases")
        Check.eq(
            flying.previewReceiver(dx: 0, dz: Double(flying.dirFor(0))), nil,
            "and with the disc out of the hand the preview is nobody")
    }

    /// **The player must be able to throw short.**
    ///
    /// `humanReleaseParams` is a full port with its own suite, and it had no caller outside
    /// that suite — `humanRelease` was passing the drag straight through as `power`, which
    /// maps the charge across the *throw's own* range. The backhand spec floors at 12 m/s,
    /// so a release at zero charge still flew about 23 m: there was no dump, no reset, no
    /// five-metre swing in the game at all, only bombs. The mapping exists to drive an
    /// absolute release speed from `MIN_THROW_SPEED` instead.
    ///
    /// Measured through the engine rather than through the mapping, because the mapping was
    /// already correct and already asserted — the bug was that nothing called it. This is
    /// the check that fails if the wiring is undone again.
    private static func aTapIsNotABomb() {
        var carries: [Double] = []
        for power in [0.0, 0.5, 1.0] {
            let e = Engine(format: .sevens, seed: 17)
            e.autoTeams = []
            // Skip the pull and get a live disc into the controlled player's hand.
            var ticks = 0
            while !(e.game.phase == .livePossession && e.carrier == e.controlled),
                ticks < 120 * 240
            {
                e.step(dt: dt)
                ticks += 1
            }
            guard e.carrier == e.controlled, let thrower = e.players.first(where: { $0.id == e.carrier })
            else {
                Check.ok(false, "a live disc reached the controlled player")
                return
            }

            let from = thrower.pos
            Check.ok(
                e.humanRelease(.backhand, aim: Vec3d(0, 0, Double(e.dirFor(0))), power: power),
                "a backhand at power \(power) releases")
            // Fly it until it comes down.
            var carry = 0.0
            for _ in 0..<(120 * 12) where e.game.phase == .discInFlight {
                e.step(dt: dt)
                carry = Swift.max(carry, distXZ(from, e.disc.state.pos))
            }
            carries.append(carry)
        }

        Check.inRange(carries[0], 4, 16, "a tap is a dump, not a bomb (\(carries[0]) m)")
        Check.ok(
            carries[2] > carries[0] * 1.8,
            "and full power is a different throw entirely "
                + "(\(carries[0]) m vs \(carries[2]) m)")
        Check.ok(
            carries[1] > carries[0] && carries[2] > carries[1],
            "the charge is monotonic: \(carries.map { Int($0) })")
        Check.note(
            "human backhand carry by charge: "
                + carries.map { String(format: "%.1f m", $0) }.joined(separator: "  "))
    }

    /// The AI's one-shot actions reach the body, with their target intact.
    ///
    /// `Engine` passed `action: nil` to locomotion for its whole first life, and the
    /// omission survived because it *almost* worked: locomotion also reads `intent.mode`,
    /// so `"jump"` and `"layout"` still fired and players still left the ground. What was
    /// dropped is the bid's target point, which `stepIntent` uses to aim the dive. A
    /// layout without it extends along whatever heading the player already had rather
    /// than at the disc — the difference between a bid that reaches and one that lands a
    /// body's length short, and invisible in every summary statistic.
    ///
    /// Asserted as a pure translation rather than through a played match, deliberately:
    /// the current AI bids rarely enough that no fixed seed reliably produces one, and a
    /// check that only sometimes exercises its subject is not a check.
    private static func bidsReachTheBody() {
        let bid = Engine.locoAction(.bid(x: 12.5, z: -7.25, extend: 1.4))
        Check.eq(bid?.kind, "bid", "a bid becomes a bid")
        Check.bitEqViaJSON(bid?.x ?? .nan, 12.5, "and carries its target x")
        Check.bitEqViaJSON(bid?.z ?? .nan, -7.25, "and its target z")

        Check.eq(Engine.locoAction(.jump(height: 0.7))?.kind, "jump", "a jump becomes a jump")

        // Everything else is a decision for the rules machine, not an instruction for a
        // body. Translating one would be inventing a meaning locomotion does not have.
        Check.ok(Engine.locoAction(.catch(difficulty: 0.5)) == nil, "a catch is not a body act")
        Check.ok(Engine.locoAction(.stall(count: 4)) == nil, "a stall is not a body act")
        Check.ok(Engine.locoAction(.pickup) == nil, "a pickup is not a body act")
        Check.ok(Engine.locoAction(nil) == nil, "no action stays no action")

        // And the translation must actually be USED. Asserting `locoAction` alone left
        // the real hole open: putting `action: nil` back at the call site passed every
        // check above, because none of them looked at what `locoIntent` produces. That is
        // the same shape as the original bug — a correct function nobody calls.
        var intent = PlayerIntent(
            id: 3, team: 0, targetX: 4, targetZ: 5, faceX: 0, faceZ: 1,
            mode: .layout, effort: 1, desiredSpeed: 8, maxSpeed: 8.5,
            maxAccel: 7, maxDecel: 9, turnRate: 6, arriveRadius: 0.4,
            personalSpace: 0.6, action: .bid(x: 9.5, z: -3.25, extend: 1.2))
        var carried = Engine.locoIntent(intent)
        Check.eq(carried.action?.kind, "bid", "locoIntent carries the bid through")
        Check.bitEqViaJSON(carried.action?.x ?? .nan, 9.5, "with its target x intact")
        Check.bitEqViaJSON(carried.action?.z ?? .nan, -3.25, "and its target z intact")
        Check.eq(carried.mode, "layout", "and the mode locomotion also reads")

        // The rest of the contract, since this is the only place it is checked at all.
        Check.eq(carried.id, 3, "id")
        Check.bitEqViaJSON(carried.targetX ?? .nan, 4, "targetX")
        Check.bitEqViaJSON(carried.desiredSpeed ?? .nan, 8, "desiredSpeed")
        Check.bitEqViaJSON(carried.maxSpeed ?? .nan, 8.5, "maxSpeed")
        Check.bitEqViaJSON(carried.arriveRadius ?? .nan, 0.4, "arriveRadius")

        intent.action = nil
        carried = Engine.locoIntent(intent)
        Check.ok(carried.action == nil, "and no action stays none through the contract")
    }

    /// One seed, one match — the property the whole project is built on.
    ///
    /// The seed reaches much further here than it did in the interim engine, which drew
    /// from the RNG exactly once — a throw-type coin flip — so that two seeds could
    /// produce a bit-identical match. This one deals a whole roster from the seed and
    /// forks an independent stream per `TeamAI` per point, so two seeds diverge from the
    /// opening tick. If the fork salt or the roster draw order ever changes, this fails.
    private static func deterministic() {
        func play(_ seed: UInt32) -> ([Double], [Int]) {
            let e = Engine(format: .minis, seed: seed)
            e.autoTeams = [0, 1]
            var trace: [Double] = []
            var discrete: [Int] = []
            for i in 0..<(120 * 120) {
                e.step(dt: dt)
                if i % 97 == 0 {
                    trace.append(e.disc.state.pos.x)
                    trace.append(e.disc.state.pos.z)
                    trace.append(e.stall)
                    for p in e.players { trace.append(p.pos.x); trace.append(p.pos.z) }
                    discrete.append(e.score[0])
                    discrete.append(e.score[1])
                    discrete.append(e.game.point)
                    discrete.append(e.carrier ?? -1)
                }
            }
            return (trace, discrete)
        }

        let (a, ka) = play(21)
        let (b, kb) = play(21)
        Check.eq(a.count, b.count, "two runs of a seed produce the same trace length")
        var same = true
        for (x, y) in zip(a, b) where x.bitPattern != y.bitPattern { same = false }
        Check.ok(same, "the same seed replays bit-for-bit")
        Check.eq(ka, kb, "and the rules state replays exactly")

        // And a different seed must actually differ, or the check above is vacuous.
        let (c, _) = play(22)
        var differs = false
        for (x, y) in zip(a, c) where x.bitPattern != y.bitPattern { differs = true }
        Check.ok(differs, "a different seed produces a different match")

        Check.note("engine trace: \(a.count) sampled coordinates, replayed bit-exact")
    }
}

/// Every count the machine called out loud.
///
/// A class because `GameState` takes its emitter at construction and the recorder has to
/// outlive the call. Reading `stallCount` after `step` instead would miss the last one:
/// the tick that reaches `stallMax` stalls the thrower out and zeroes the count inside the
/// same call, so the field never shows ten and the event always does.
private final class CountRecorder {
    private(set) var highest = 0
    private(set) var ticks = 0

    func absorb(_ event: GameEvent) {
        guard case .stallTick(let count, _, _, _, _) = event else { return }
        highest = Swift.max(highest, count)
        ticks += 1
    }
}
