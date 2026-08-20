import Foundation
import UltimateSim

/// THE PULL — against the rules of Ultimate and the geometry of the throw, not against a
/// recording of eight seeds.
///
/// # The rule
///
/// WFDF 2021 rules 12 and 13 (USAU 11th ed. 8): each point begins with a pull. Both lines
/// signal readiness; the pulling team throws from its own goal line; nobody may cross that
/// line until the disc is released; and then one of five things happens, each with its own
/// remedy:
///
///  - the receivers **catch** it — play is live at once, with no check (13.1);
///  - the receivers **touch and drop** it — turnover, the pulling team gets it (13.5);
///  - the pulling team **touches** it first — the receivers get it where it was touched;
///  - it **lands in bounds** untouched — the receivers pick it up where it stopped, walking
///    it to the goal line if it stopped in the end zone they attack (13.3);
///  - it **lands out of bounds** — and the receivers get a **choice** (13.2): the brick mark,
///    or the point on the perimeter where it went out.
///
/// That last one is the whole reason a pull needs its own rules path rather than being a
/// throwaway with a different name, and it is the one this suite spends the most assertions
/// on. `pull.json` recorded no out-of-bounds pull at all: its eight cases each captured one
/// release and stopped.
///
/// # What the fixture pinned, and what is asserted instead
///
/// `pull.json` recorded, per seed, the release origin, the aim vector, and eight throw
/// parameters — then engineered the puller's body to the reference's own position first,
/// so the only thing it could ever check was the arithmetic downstream of a position it
/// supplied. Those numbers are restated here as the three things they actually are:
///
///  - **A law.** The aim is a *bearing*, and its two components mean something: `PULL_CARRY`
///    along the line to the middle of the far end zone, `PULL_DRIFT` across it to undo the
///    hyzer fade, mirrored by the throwing hand. So `|aim|`, `aim · ĥ` and the sign of the
///    cross term are asserted rather than the vector's coordinates — a wrong aim formula
///    that happens to have the right length still fails, and a correct one still passes
///    when the puller stands somewhere new.
///  - **Exact values for the throw's tuning constants.** `PULL_SPEED`, `PULL_BANK`,
///    `PULL_NOSE`, `PULL_SPIN`, `PULL_DRIFT`, `PULL_CARRY`, `PULL_TARGET_Z`. These are a
///    *fit*, not a derivation — nothing relates 32 m/s to anything — so a relation is the
///    wrong assertion and the number is the right one. This is issue #58's `CATCH_DEAD`
///    lesson applied before the fixture goes rather than after.
///  - **The rule**, driven through `GameState` directly, for the five outcomes above.
///
/// # Two places the implementation disagrees with the sport
///
/// Both are asserted as they behave and labelled loudly:
/// `aPullMayBeThrownFromAnywhere()` and `aCaughtPullIsNotWalkedOutOfTheEndZone()`. The
/// 0.5 m offside every puller stands at is `LineupTests`' to report.
enum PullTests {

    // MARK: - entry point

    static func run() throws {
        constants()
        thePullerIsTheBestArm()
        theReleaseLeavesTheThrowingHand()
        theAimIsABearingAtTheFarEndZone()
        theArmAndTheJitter()
        theThrowParametersAreThePullsOwn()
        thePullGoesToTheOtherTeam()
        theSmallPitchDoesNotGetTheFittedBallistic()

        // The rules path, driven through the machine.
        onlyThePullingTeamPullsAndOnlyFromPrePull()
        aPullMayBeThrownFromAnywhere()
        aCaughtPullIsLiveAtOnce()
        aCaughtPullIsNotWalkedOutOfTheEndZone()
        aDroppedPullIsATurnover()
        thePullingTeamMayNotCatchItsOwnPull()
        aLandedPullIsPickedUpWhereItStopped()
        anOutOfBoundsPullIsAChoice()
    }

    // MARK: - a common sample

    /// Eight seeds — `pull.json`'s own spread across puller, handedness and arm strength,
    /// kept because they are arbitrary and nothing below is tuned to them.
    private static let seeds: [UInt32] = [11, 22, 33, 44, 55, 66, 77, 88]

    /// A regulation match, pulled the instant it exists.
    ///
    /// **Zero ticks between construction and the pull**, which is load-bearing rather than
    /// incidental: `TeamAI` draws from the engine's own `rng` stream, so any tick that lets
    /// the AI decide something first shifts the pull's `jitter` draw by an
    /// AI-cadence-dependent amount. Calling the pull the instant the roster exists makes
    /// every assertion below a statement about `regulationPull`'s own arithmetic. The
    /// bodies are left wherever `stagePoint` put them — that is the position a real match
    /// pulls from, and the geometry laws hold from any position, which is exactly what
    /// makes them laws.
    private static func pulled(
        _ format: GameFormat = .sevens, seed: UInt32, pullingTeam: TeamId = 1
    ) -> (Engine, Engine.PullThrow)? {
        var cfg = EngineConfig()
        cfg.startingPullTeam = pullingTeam
        let e = Engine(format: format, seed: seed, config: cfg)
        e.autoPull()
        guard let t = e.lastPullThrow else {
            Check.ok(false, "s\(seed): autoPull() released no pull")
            return nil
        }
        return (e, t)
    }

    /// A `GameState` alone, with no physics attached, standing in PRE_PULL.
    ///
    /// The rules path is checked on the machine rather than through the engine because the
    /// remedies are rules and not trajectories: what a dropped pull does to possession has
    /// nothing to do with how the disc got there, and driving it through an engine would
    /// make every one of these assertions conditional on an AI happening to drop one.
    private static func machine(
        _ format: GameFormat = .sevens, _ collect: ((GameEvent) -> Void)? = nil
    ) -> GameState {
        var opts = GameStateOptions()
        opts.format = format
        opts.emit = collect
        let g = GameState(opts)
        g.startGame()
        return g
    }

    // MARK: - the constants

    /// The pull's tuning numbers, pinned, and where each comes from.
    ///
    /// Not one of these is derivable. They are a *fit*: 32 m/s at 0.10 rad of launch with
    /// half a radian of hyzer carries 66 m in 5.7 s, and the reference's own note records
    /// that throwing harder made the carry worse before it made it better, because past the
    /// fit the disc turns over and dives. A relation between them would be an invention.
    private static func constants() {
        Check.bitEq(
            Engine.PULL_SPEED, 32.0,
            "a pull leaves the hand at 32 m/s — the fitted release speed of a throw taken "
                + "with a run-up, which no backhand in the throw table reaches (tuning)")
        Check.bitEq(
            Engine.PULL_BANK, -0.50,
            "half a radian of hyzer, which is the lever that holds the line against the "
                + "turnover a fast disc suffers (tuning)")
        Check.bitEq(
            Engine.PULL_NOSE, 0.02,
            "a flat nose — an offset, cancelling the backhand spec's own -0.02 (tuning)")
        Check.bitEq(Engine.PULL_SPIN, 0.85, "spin on the pull (tuning)")
        Check.bitEq(
            Engine.PULL_DRIFT, 8.4,
            "metres of cross-field fade the aim has to undo over the carry (measured fit)")
        Check.bitEq(
            Engine.PULL_CARRY, 66.0,
            "and the carry it fades over, in metres (measured fit)")
        Check.bitEq(
            Engine.PULL_TARGET_Z, 36.0,
            "a pull is aimed at the middle of the field four metres inside the far end "
                + "zone — the regulation goal line at 32 m, plus 4")
        Check.bitEq(
            Engine.PULL_TARGET_Z, FieldConstants.standard.goalLine + 4,
            "and that is where that 36 comes from, rather than a typed constant")

        // The fit's own internal claim, which is the one thing here that IS a relation: the
        // fade correction is a bearing, so what matters is its angle and not its two
        // lengths. atan(8.4 / 66) is a shade under 7.3 degrees.
        Check.near(
            Foundation.atan2(Engine.PULL_DRIFT, Engine.PULL_CARRY), 0.126_59, 1e-5,
            "the drift and the carry together are 7.3 degrees of aim correction")
    }

    // MARK: - who pulls

    /// The puller is the best arm on the pulling team's line, ties going to the lower id.
    ///
    /// Not a rule of the sport — the rules do not say who throws it — but it is the
    /// premise the whole fit rests on: `arm` is centred so that a *top* arm lands on
    /// `PULL_SPEED` rather than exceeding it, so a puller chosen any other way is throwing
    /// a pull calibrated for somebody else. The strict `>` and therefore the tie-break are
    /// what make a replay reproducible.
    private static func thePullerIsTheBestArm() {
        for (label, format) in [("sevens", GameFormat.sevens), ("minis", .minis)] {
            for seed in seeds {
                for pulling in [TeamId(0), 1] {
                    var cfg = EngineConfig()
                    cfg.startingPullTeam = pulling
                    let e = Engine(format: format, seed: seed, config: cfg)
                    let line = e.players.filter { $0.team == pulling }.sorted { $0.id < $1.id }
                    guard let best = line.max(by: { $0.attr.throwPower < $1.attr.throwPower })
                    else { continue }
                    let at = "\(label)/s\(seed)/pull\(pulling)"

                    Check.eq(e.body(of: e.puller)?.team, pulling, "\(at): the puller is on the line")
                    guard let chosen = e.body(of: e.puller) else { continue }
                    Check.bitEq(
                        chosen.attr.throwPower, best.attr.throwPower,
                        "\(at): nobody on the line throws harder than the puller")
                    // Strict `>` scanning in id order keeps the earliest of any tie.
                    let tied = line.filter { $0.attr.throwPower == best.attr.throwPower }
                    Check.eq(
                        e.puller, tied.first?.id,
                        "\(at): a tie on arm keeps the earlier name, so a replay is a replay")
                }
            }
        }
    }

    // MARK: - where it leaves from

    /// The disc leaves the throwing hand, not the middle of the chest.
    ///
    /// 0.34 m to the throwing side and 0.16 m in front of the body, at 1.10 hip heights
    /// off the ground. Asserted as the *decomposition* — how far to the side, how far
    /// forward, how high — rather than as three world coordinates, because the coordinates
    /// depend on where the puller happens to be standing and the decomposition does not.
    /// A left-hander's release must mirror; the forward reach must not.
    private static func theReleaseLeavesTheThrowingHand() {
        var lefts = 0
        var rights = 0
        for seed in seeds {
            guard let (e, t) = pulled(seed: seed), let p = e.body(of: e.puller),
                let body = e.loco.get(e.puller)
            else { continue }
            let at = "s\(seed)"

            let f = body.facing
            // Forward and right, in the plane, from the body's own facing.
            let fx = Foundation.sin(f), fz = Foundation.cos(f)
            let rx = fz, rz = -fx
            let dx = t.from.x - body.pos.x, dz = t.from.z - body.pos.z
            let side = dx * rx + dz * rz
            let ahead = dx * fx + dz * fz
            let hand: Double = p.handed == .left ? -1 : 1
            if p.handed == .left { lefts += 1 } else { rights += 1 }

            Check.near(
                side, hand * 0.34, 1e-12,
                "\(at): the release is 0.34 m to the \(p.handed == .left ? "left" : "right") "
                    + "— the throwing hand's side, which is the whole point of a break")
            Check.near(ahead, 0.16, 1e-12, "\(at): and 0.16 m in front of the body")
            Check.near(
                Foundation.hypot(dx, dz), Foundation.hypot(0.34, 0.16), 1e-12,
                "\(at): so the hand is a fixed reach from the sternum whichever way he faces")
            Check.near(
                t.from.y, body.groundY + body.hipHeight * 1.10, 1e-12,
                "\(at): and 1.10 hip heights up, which is where a disc is held")
            Check.ok(
                t.from.y > body.groundY,
                "\(at): the disc leaves above the turf it is standing on")
        }
        // Both hands have to be in the sample, or the mirror clause above proved nothing.
        Check.ok(lefts > 0, "the sample contains a left-handed puller (\(lefts))")
        Check.ok(rights > 0, "and a right-handed one (\(rights))")
    }

    // MARK: - the aim

    /// **The aim is a bearing, and the bearing has two named parts.**
    ///
    /// A pull is aimed at a *spot* — the middle of the field four metres inside the far end
    /// zone — and then offset across that line by the fade a hyzer disc will take, mirrored
    /// by hand. Only the aim's direction is read downstream, so the pair of lengths is
    /// exactly an angle: `PULL_CARRY` along the line to the spot and `PULL_DRIFT` across it.
    ///
    /// So three independent claims are asserted, and none of them is a coordinate:
    ///
    ///  - `aim · ĥ == PULL_CARRY`, where `ĥ` is the unit vector from the release point to
    ///    the aiming spot. A pull aimed downfield from the wrong origin — "straight ahead
    ///    plus a correction", which is what this used to be — fails this from a puller
    ///    standing anywhere but the centre of the line.
    ///  - the component across `ĥ` is `PULL_DRIFT`, and its **sign flips with the hand**.
    ///  - therefore `|aim| == hypot(PULL_CARRY, PULL_DRIFT)`, on every seed, exactly.
    ///
    /// Together those three pin the vector completely without ever writing one down.
    private static func theAimIsABearingAtTheFarEndZone() {
        var sawLeft = false
        var sawRight = false
        for seed in seeds {
            for pulling in [TeamId(0), 1] {
                guard let (e, t) = pulled(seed: seed, pullingTeam: pulling),
                    let p = e.body(of: e.puller)
                else { continue }
                let at = "s\(seed)/pull\(pulling)"
                let dir = Double(e.dirFor(e.game.pullingTeam))

                // The spot: the middle of the field, just inside the far end zone.
                let target = Vec3d(0, 0, dir * Engine.PULL_TARGET_Z)
                let lx = target.x - t.from.x, lz = target.z - t.from.z
                let len = Foundation.hypot(lx, lz)
                Check.ok(len > 1, "\(at): the puller is not standing on his own aiming spot")
                let hx = lx / len, hz = lz / len

                let along = t.aim.x * hx + t.aim.z * hz
                // Positive cross means "to the thrower's left of the line to the spot" in
                // this coordinate convention; a right-hander's hyzer fades right, so the
                // aim is offset left, and a left-hander's the other way.
                let across = t.aim.x * hz - t.aim.z * hx
                let hand: Double = p.handed == .left ? -1 : 1
                if p.handed == .left { sawLeft = true } else { sawRight = true }

                Check.near(
                    along, Engine.PULL_CARRY, 1e-9,
                    "\(at): the aim carries \(Engine.PULL_CARRY) m along the line to the "
                        + "middle of the far end zone")
                Check.near(
                    across, hand * Engine.PULL_DRIFT, 1e-9,
                    "\(at): and \(Engine.PULL_DRIFT) m across it, to the "
                        + "\(p.handed == .left ? "right" : "left") — undoing a "
                        + "\(p.handed == .left ? "left" : "right")-hander's hyzer fade")
                Check.near(
                    Foundation.hypot(t.aim.x, t.aim.z),
                    Foundation.hypot(Engine.PULL_CARRY, Engine.PULL_DRIFT), 1e-9,
                    "\(at): so the aim's length is the fit's own hypotenuse")
                Check.bitEq(t.aim.y, 0, "\(at): the aim is a bearing in the plane, not a point")

                // And it points at the receivers rather than at the puller's own end line.
                Check.ok(
                    t.aim.z * dir > 0,
                    "\(at): the aim points down the pitch the pulling team is attacking")
                Check.ok(
                    (target.z - t.from.z) * dir > 0,
                    "\(at): and the aiming spot is downfield of the release")
            }
        }
        Check.ok(sawLeft && sawRight, "both hands are in the aim sample, so the mirror is real")
    }

    /// The release speed is `PULL_SPEED` scaled by the arm and nudged by a seeded jitter.
    ///
    /// `arm = 0.94 + 0.06 * throwPower/100`, so the very best arm in the game reaches
    /// `PULL_SPEED` exactly and nobody exceeds it — that centring is deliberate, because the
    /// carry falls away *above* the fitted speed (32.6 m/s hangs 4.6 s, 34.6 m/s hangs
    /// 3.2 s) and a puller who out-threw the fit would pull shorter, not longer.
    ///
    /// The jitter is drawn from the match RNG, so it cannot be predicted here — but it can
    /// be bounded, and it can be shown to actually vary. A jitter pinned to its midpoint
    /// satisfies every bound below and is caught by the spread clause.
    private static func theArmAndTheJitter() {
        var ratios: [Double] = []
        for seed in seeds {
            guard let (e, t) = pulled(seed: seed), let p = e.body(of: e.puller),
                let speed = t.speed
            else { continue }
            let at = "s\(seed)"
            let arm = 0.94 + 0.06 * (p.attr.throwPower / 100)

            Check.inRange(
                arm, 0.94, 1.0,
                "\(at): the arm scale runs from 0.94 to 1.0, so nobody out-throws the fit")
            let jitter = speed / (Engine.PULL_SPEED * arm)
            ratios.append(jitter)
            Check.inRange(
                jitter, 0.985, 1.015,
                "\(at): the seeded nudge is +/-1.5 percent and no more — the carry is very "
                    + "sensitive above the fit")
            Check.near(
                speed, Engine.PULL_SPEED * arm * jitter, 1e-12,
                "\(at): and the speed is exactly PULL_SPEED * arm * jitter")
            Check.ok(
                speed <= Engine.PULL_SPEED * 1.015,
                "\(at): so no pull leaves faster than the fit plus its nudge")
        }
        // Fourteen pulls are not one pull: the nudge has to move.
        let lo = ratios.min() ?? 1
        let hi = ratios.max() ?? 1
        Check.ok(
            hi - lo > 0.004,
            "the jitter actually varies across the sample (\(lo) to \(hi)) — a constant "
                + "would satisfy every bound above")
    }

    /// The throw parameters the pull overrides, and the ones it inherits.
    ///
    /// A pull is the one throw in the sport taken with a run-up and a full body rotation,
    /// so it overrides the backhand spec's release speed outright rather than asking for
    /// more `power`. `power` is therefore 1 and `angle` 0 — the elevation comes from the
    /// backhand spec itself — and the bank, nose and spin are the fit's.
    private static func theThrowParametersAreThePullsOwn() {
        for seed in seeds {
            guard let (e, t) = pulled(seed: seed), let p = e.body(of: e.puller) else { continue }
            let at = "s\(seed)"
            Check.bitEq(t.power, 1, "\(at): power is not the lever — the release speed is")
            Check.bitEq(t.angle, 0, "\(at): and the elevation is the backhand spec's own")
            Check.bitEq(t.spin, Engine.PULL_SPIN, "\(at): spin")
            Check.bitEq(t.bank ?? .nan, Engine.PULL_BANK, "\(at): bank")
            Check.bitEq(t.nose ?? .nan, Engine.PULL_NOSE, "\(at): nose")
            Check.eq(
                t.hand.map { $0 == .left ? "L" : "R" }, p.handed == .left ? "L" : "R",
                "\(at): thrown with the hand the puller throws with")
            // The release velocity is the aero model's answer to all of that, so a
            // parameter that never reached `disc.release` shows up as a disc going nowhere.
            Check.ok(
                Foundation.hypot(t.vel.x, t.vel.z) > 10,
                "\(at): the disc actually leaves at pace (\(t.vel))")
        }
    }

    /// **A pull goes to the other team.** The one thing every pull in every code of the
    /// sport has in common.
    ///
    /// Stated on the release velocity rather than on where it lands, because where it lands
    /// is `EngineSeamTests`' measurement and this is about the throw. Swept over both
    /// starting pull teams so a sign error cannot hide behind the default.
    private static func thePullGoesToTheOtherTeam() {
        for (label, format) in [("sevens", GameFormat.sevens), ("minis", .minis)] {
            for seed in seeds {
                for pulling in [TeamId(0), 1] {
                    guard let (e, t) = pulled(format, seed: seed, pullingTeam: pulling)
                    else { continue }
                    let dir = Double(e.dirFor(pulling))
                    let at = "\(label)/s\(seed)/pull\(pulling)"
                    Check.ok(
                        t.vel.z * dir > 0,
                        "\(at): the pull travels toward the receiving team (vel.z=\(t.vel.z), "
                            + "dir=\(dir))")
                    Check.ok(t.vel.y > 0, "\(at): and it leaves the hand going up")
                    Check.ok(
                        (t.from.z) * dir < 0,
                        "\(at): thrown from the pulling team's own half")
                }
            }
        }
    }

    /// The fitted ballistic is a regulation-pitch instrument and does not escape onto minis.
    ///
    /// 66 m of carry on a 37 m pitch is a disc in the car park, so the small pitch solves
    /// its power by bisection instead. The two are told apart by what they put in the
    /// request: the fitted pull overrides `speed` and names a bank and a nose, the solved
    /// one names none of the three and carries the backhand's own spin.
    private static func theSmallPitchDoesNotGetTheFittedBallistic() {
        for seed in seeds {
            guard let (_, big) = pulled(.sevens, seed: seed),
                let (_, small) = pulled(.minis, seed: seed)
            else { continue }
            let at = "s\(seed)"
            Check.ok(big.speed != nil, "\(at): the regulation pull names its own release speed")
            Check.ok(
                small.speed == nil,
                "\(at): the minis pull solves for power instead and names no speed")
            Check.ok(big.bank != nil, "\(at): the regulation pull is thrown on hyzer")
            Check.ok(small.bank == nil, "\(at): the minis pull is not")
            Check.bitEq(
                small.spin, 0.9, "\(at): and carries the solved pull's own spin (tuning)")
            Check.ok(
                small.power < 1,
                "\(at): a minis pull is not thrown flat out (power \(small.power))")
            Check.ok(
                small.angle >= 0.10 && small.angle <= 0.30,
                "\(at): and is lofted between the flat-and-driven floor and the calm-day "
                    + "0.30 rad (angle \(small.angle))")
        }
    }

    // MARK: - the rules path

    /// WFDF 12: the pull opens a point, is thrown by the pulling team, and happens once.
    private static func onlyThePullingTeamPullsAndOnlyFromPrePull() {
        let g = machine()
        let pulling = g.pullingTeam
        let receiving = otherTeam(pulling)
        let line = FieldConstants.standard.goalLineZ(flipDir(g.attackDir[pulling]))

        Check.eq(g.phase, .prePull, "a point opens before the pull")
        Check.ok(g.possession == nil, "and nobody has the disc yet")
        Check.bitEq(
            g.discPos.z, line, "the disc is spotted on the pulling team's own goal line")

        // A receiver may not pull.
        let byReceiver = g.pull(receiving * 7, Vec3d(0, 1, line), Vec3d(0, 8, 20))
        Check.ok(!byReceiver.ok, "a player on the receiving team may not pull")
        Check.eq(g.phase, .prePull, "and the refusal changed nothing")

        // Nor may somebody who is not in the game.
        Check.ok(!g.pull(9999, Vec3d(0, 1, line)).ok, "nor may a player who is not on a roster")
        Check.eq(g.phase, .prePull, "and that refusal changed nothing either")

        // The pulling team may.
        let ok = g.pull(pulling * 7, Vec3d(0, 1, line), Vec3d(0, 8, 20))
        Check.ok(ok.ok, "the pulling team pulls")
        Check.eq(g.phase, .pullInFlight, "and the disc is in the air")
        Check.ok(g.possession == nil, "nobody owns a pull in flight")
        Check.eq(g.teamStats(pulling).pulls, 1, "the pull is credited to the pulling team")
        Check.eq(
            g.allPlayers().first { $0.id == pulling * 7 }?.pulls, 1,
            "and to the player who threw it")

        // Once. A second pull while the first is airborne is not a thing in this sport.
        Check.ok(!g.pull(pulling * 7 + 1, Vec3d(0, 1, line)).ok, "a point has one pull in it")
        Check.eq(g.teamStats(pulling).pulls, 1, "and the refusal credited nobody")
    }

    /// **KNOWN GAP AGAINST THE RULES — reported, not endorsed.**
    ///
    /// WFDF 12.2 requires the pull to be released from the pulling team's goal line, and
    /// 12.3 makes a pull thrown from anywhere else an offside violation the receiving team
    /// may call. `GameState.pull(_:_:_:)` checks the phase and checks the thrower's team,
    /// and accepts **any** `from` — including a release from inside the receivers' end zone
    /// forty metres downfield, which is what this asserts.
    ///
    /// The gap is not academic: `gamestate.json`'s own scripts pulled from
    /// `z = -FIELD.END_LINE`, the **end** line, eighteen metres behind the goal line the
    /// rules name, and nothing in the fixture era ever objected. A recording cannot object;
    /// it records.
    ///
    /// Left as it behaves rather than fixed, because `Engine.releaseOrigin` puts the disc
    /// in a hand at a hip height above a body that `stagePoint` has already staged half a
    /// metre offside (see `LineupTests`), so a goal-line check added here would fail every
    /// pull the engine throws until that is fixed too. Both belong in one commit.
    private static func aPullMayBeThrownFromAnywhere() {
        let g = machine()
        let pulling = g.pullingTeam
        let far = FieldConstants.standard.goalLineZ(g.attackDir[pulling]) + 8

        let r = g.pull(pulling * 7, Vec3d(0, 1, far), Vec3d(0, 8, 20))
        Check.ok(
            r.ok,
            "GAP: a pull released from z=\(far) — inside the receivers' end zone — is "
                + "accepted. WFDF 12.2 says the goal line; nothing here checks it")
        Check.eq(g.phase, .pullInFlight, "and the machine proceeds as if it were legal")
        Check.bitEq(
            g.discPos.z, far, "with the disc spotted wherever the caller said it left from")
    }

    /// WFDF 13.1 — a caught pull is live immediately. No check, no stoppage, count running.
    private static func aCaughtPullIsLiveAtOnce() {
        var events: [String] = []
        let g = machine(.sevens, { events.append($0.name) })
        let pulling = g.pullingTeam
        let receiving = otherTeam(pulling)
        let line = FieldConstants.standard.goalLineZ(flipDir(g.attackDir[pulling]))
        g.pull(pulling * 7, Vec3d(0, 1, line), Vec3d(0, 8, 20))
        events.removeAll()

        let catcher = receiving * 7 + 2
        let at = Vec3d(3, 1, -10)
        let r = g.pullCaught(catcher, at)
        Check.ok(r.ok, "the receivers catch the pull")
        Check.eq(g.phase, .livePossession, "and play is live at once — no check (WFDF 13.1)")
        Check.eq(g.possession, receiving, "the receiving team has it")
        Check.eq(g.thrower, catcher, "and the catcher is the thrower")
        Check.eq(g.stallCount, 0, "the count starts at zero")
        Check.ok(g.stallRunning, "and it is running, because play never stopped")
        Check.ok(g.deadReason == nil, "the disc is not dead")
        Check.bitEq(g.pivot.x, at.x, "the pivot is where he caught it (x)")
        Check.bitEq(g.pivot.z, at.z, "the pivot is where he caught it (z)")
        Check.ok(
            events.contains("state:changed"), "and the renderer is told the phase moved")

        // A caught pull is not a completion: nobody threw it to him.
        Check.eq(g.teamStats(receiving).completions, 0, "a pull is not a completed pass")
        Check.eq(g.teamStats(pulling).attempts, 0, "and the puller is charged no attempt")
        Check.eq(
            g.allPlayers().first { $0.id == catcher }?.catches, 0,
            "nor is the receiver credited a catch")
        Check.eq(g.teamStats(receiving).possessions, 1, "it is their first possession")
    }

    /// **KNOWN DIVERGENCE FROM THE RULES — reported, not endorsed.**
    ///
    /// WFDF 13.4: a pull caught (or picked up) in the end zone the receiving team is
    /// *defending* may be walked out to the goal line, and this simulation's stated policy
    /// is to always take that walk — `RuleSet.walkOutOfDefendingEndzone` is `true` by
    /// default and its own doc says real teams take it because throwing from inside your
    /// own end zone gives the mark a sideline and an end line to work with.
    ///
    /// An **untouched** pull that lands there is walked out: `pullLanded` goes through
    /// `deadDisc`, which applies `putIntoPlaySpot`. A **caught** one is not: `pullCaught`
    /// calls `gainPossession(walk: false)` and leaves the pivot where the catch happened.
    /// So the same disc, in the same place, gets two different spots depending on whether a
    /// receiver got a hand on it — which is not a distinction the rules draw.
    ///
    /// Asserted as it behaves, exactly, and labelled.
    private static func aCaughtPullIsNotWalkedOutOfTheEndZone() {
        let field = FieldConstants.standard
        // Deep inside the end zone the receivers are defending.
        let deep = Vec3d(2, 1, 0)

        func spotAfter(_ body: (GameState, TeamId, TeamId, Vec3d) -> Void) -> Vec3d {
            let g = machine()
            let pulling = g.pullingTeam
            let receiving = otherTeam(pulling)
            let line = field.goalLineZ(flipDir(g.attackDir[pulling]))
            g.pull(pulling * 7, Vec3d(0, 1, line), Vec3d(0, 8, 20))
            let z = -Double(g.attackDir[receiving]) * (field.goalLine + 8)
            body(g, pulling, receiving, Vec3d(deep.x, deep.y, z))
            return g.pivot
        }

        let caught = spotAfter { g, _, receiving, at in g.pullCaught(receiving * 7 + 1, at) }
        let landed = spotAfter { g, _, _, at in g.pullLanded(at) }

        Check.ok(
            abs(caught.z) > field.goalLine,
            "DIVERGENCE: a pull caught \(abs(caught.z)) m out — inside the end zone the "
                + "receivers defend — leaves the pivot in the end zone. WFDF 13.4 and this "
                + "sim's own `walkOutOfDefendingEndzone` both say walk it to the line")
        Check.near(
            abs(landed.z), field.goalLine, 1e-9,
            "…while the identical pull, merely untouched, IS walked out to the goal line")
        Check.ok(
            abs(caught.z) > abs(landed.z),
            "so getting a hand on it costs the receivers \(abs(caught.z) - abs(landed.z)) m "
                + "of field, which is the shape of the bug")
    }

    /// WFDF 13.5 — the receiving team touches the pull and fails to catch it: turnover.
    private static func aDroppedPullIsATurnover() {
        var events: [String] = []
        let g = machine(.sevens, { events.append($0.name) })
        let pulling = g.pullingTeam
        let receiving = otherTeam(pulling)
        let line = FieldConstants.standard.goalLineZ(flipDir(g.attackDir[pulling]))
        g.pull(pulling * 7, Vec3d(0, 1, line), Vec3d(0, 8, 20))
        events.removeAll()

        let butterFingers = receiving * 7 + 3
        let r = g.pullDropped(butterFingers, Vec3d(1, 0, -6))
        Check.ok(r.ok, "the receivers drop the pull")
        Check.eq(g.possession, pulling, "and the PULLING team gets it (WFDF 13.5)")
        Check.eq(g.phase, .turnoverDead, "the disc is dead where it fell")
        Check.eq(g.deadReason, .pullDropped, "and the machine records why")
        Check.ok(events.contains("turnover"), "a possession change is announced")
        Check.eq(
            g.teamStats(receiving).turnoversCommitted, 1, "charged to the team that dropped it")
        Check.eq(g.teamStats(pulling).turnoversForced, 1, "and credited to the other one")
        Check.eq(g.teamStats(receiving).drops, 1, "it is a drop")
        Check.eq(
            g.allPlayers().first { $0.id == butterFingers }?.drops, 1, "against his name")
        Check.eq(g.stallCount, 0, "the count is not running on a dead disc")
        Check.ok(!g.stallRunning, "…at all")
    }

    /// The pulling team may not catch its own pull; the receivers get it where it was
    /// touched. Not a turnover — nobody had possession to lose.
    private static func thePullingTeamMayNotCatchItsOwnPull() {
        let g = machine()
        let pulling = g.pullingTeam
        let receiving = otherTeam(pulling)
        let line = FieldConstants.standard.goalLineZ(flipDir(g.attackDir[pulling]))
        g.pull(pulling * 7, Vec3d(0, 1, line), Vec3d(0, 8, 20))

        let r = g.pullCaught(pulling * 7 + 4, Vec3d(0, 1, -4))
        Check.ok(r.ok, "the touch is reported")
        Check.eq(g.possession, receiving, "and the receivers get the disc")
        Check.eq(g.phase, .turnoverDead, "dead, to be picked up")
        Check.eq(g.deadReason, .pullLanded, "treated as a pull that came down")
        Check.eq(
            g.teamStats(pulling).turnoversCommitted, 0,
            "nobody committed a turnover — a pull is not a possession")
        Check.eq(g.teamStats(receiving).turnoversForced, 0, "so nobody forced one either")
    }

    /// WFDF 13.3 — an untouched pull that lands in bounds is picked up where it stopped,
    /// and a pull that stops in the end zone the receivers attack is walked to the goal
    /// line. Picking it up is **live**: only a turnover restarts with a check.
    private static func aLandedPullIsPickedUpWhereItStopped() {
        let field = FieldConstants.standard
        let g = machine()
        let pulling = g.pullingTeam
        let receiving = otherTeam(pulling)
        let dir = g.attackDir[receiving]
        let line = field.goalLineZ(flipDir(g.attackDir[pulling]))
        g.pull(pulling * 7, Vec3d(0, 1, line), Vec3d(0, 8, 20))

        let rest = Vec3d(4, 0, Double(dir) * -3)
        Check.ok(g.pullLanded(rest).ok, "the pull comes down in the central zone")
        Check.eq(g.phase, .turnoverDead, "and waits to be picked up")
        Check.eq(g.possession, receiving, "by the receiving team")
        Check.eq(g.deadReason, .pullLanded, "which is not a turnover")
        Check.bitEq(g.discPos.x, rest.x, "spotted where it stopped (x)")
        Check.bitEq(g.discPos.z, rest.z, "spotted where it stopped (z)")

        let collector = receiving * 7 + 5
        Check.ok(g.pickUp(collector, rest).ok, "somebody walks over and picks it up")
        Check.eq(
            g.phase, .livePossession,
            "and play is live at once — a pull needs no check, only a turnover does")
        Check.ok(g.stallRunning, "so the count is running")
        Check.eq(g.thrower, collector, "on the collector")

        // …and one that stops in the end zone they attack is walked to the line.
        let h = machine()
        let hPull = h.pullingTeam
        let hRecv = otherTeam(hPull)
        let hDir = h.attackDir[hRecv]
        h.pull(hPull * 7, Vec3d(0, 1, field.goalLineZ(flipDir(h.attackDir[hPull]))), Vec3d(0, 8, 20))
        h.pullLanded(Vec3d(1, 0, Double(hDir) * (field.goalLine + 10)))
        Check.bitEq(
            h.discPos.z, field.goalLineZ(hDir),
            "a pull that stops in the end zone the receivers attack comes out to the goal "
                + "line (WFDF 13.3)")
        Check.bitEq(h.discPos.x, 1, "and stays on the same line across the pitch")
    }

    /// **WFDF 13.2 — an out-of-bounds pull is a CHOICE, and this is what makes a pull a
    /// pull.**
    ///
    /// The receiving team may put it into play at the brick mark — on the centre line,
    /// `BRICK_IN` metres in from the goal line of the end zone they are *defending* — or at
    /// the point on the perimeter where the disc went out. Until they say which, the disc
    /// may not be put into play at all, and that is checkable: `pickUp` before the choice
    /// must be refused.
    ///
    /// The brick option is asserted as its *geometry* rather than as a coordinate: on the
    /// centre line, `brickIn` in from the defended goal line, on the defending side of
    /// halfway. And on both pitches, because a brick is defined in absolute metres and a
    /// scaled one would still be "some point on the centre line".
    private static func anOutOfBoundsPullIsAChoice() {
        for (label, format) in [("sevens", GameFormat.sevens), ("minis", .minis)] {
            let field = format.field
            let n = format.playersPerSide

            // --- the choice is owed, and blocks play until it is made
            var events: [String] = []
            let g = machine(format, { events.append($0.name) })
            let pulling = g.pullingTeam
            let receiving = otherTeam(pulling)
            let dir = g.attackDir[receiving]
            g.pull(
                pulling * n, Vec3d(0, 1, field.goalLineZ(flipDir(g.attackDir[pulling]))),
                Vec3d(20, 8, 20))
            events.removeAll()

            let crossing = Vec3d(field.sideline, 0, Double(dir) * -2)
            Check.ok(g.pullOutOfBounds(crossing).ok, "\(label): the pull sails out")
            Check.eq(g.phase, .turnoverDead, "\(label): play stops")
            Check.ok(g.awaitingPullChoice(), "\(label): and the receivers owe a choice")
            Check.ok(
                g.possession == nil,
                "\(label): nobody has the disc until they say where they want it")
            Check.ok(
                !g.pickUp(receiving * n, crossing).ok,
                "\(label): so it may not be picked up yet")
            Check.ok(g.awaitingPullChoice(), "\(label): and the refusal left the choice owed")
            Check.eq(
                g.teamStats(receiving).turnoversForced, 0,
                "\(label): an out-of-bounds pull is not a turnover — nobody had it")

            // --- the brick
            Check.ok(g.choosePullSpot(.brick).ok, "\(label): they take the brick")
            Check.ok(!g.awaitingPullChoice(), "\(label): and the choice is settled")
            Check.eq(g.possession, receiving, "\(label): the receivers have it")
            Check.eq(g.deadReason, .pullOutOfBounds, "\(label): recorded as an OB pull")
            Check.bitEq(g.discPos.x, 0, "\(label): the brick is on the centre line")
            Check.bitEq(
                g.discPos.z, Double(dir) * (field.brickIn - field.goalLine),
                "\(label): \(field.brickIn) m in from the goal line they defend (WFDF 13.2)")
            Check.ok(
                g.discPos.z * Double(dir) < 0,
                "\(label): which is on their own side of halfway")
            Check.near(
                abs(g.discPos.z - field.goalLineZ(flipDir(dir))), field.brickIn, 1e-9,
                "\(label): stated the other way — brickIn from their own goal line")
            Check.ok(
                field.isInBounds(g.discPos), "\(label): and the brick is on the pitch")
            // Now it may be picked up, and it is live at once, like any pull.
            Check.ok(g.pickUp(receiving * n, nil).ok, "\(label): now it can be picked up")
            Check.eq(g.phase, .livePossession, "\(label): live at once, no check")

            // --- the sideline
            let h = machine(format)
            let hPull = h.pullingTeam
            let hRecv = otherTeam(hPull)
            let hDir = h.attackDir[hRecv]
            h.pull(
                hPull * n, Vec3d(0, 1, field.goalLineZ(flipDir(h.attackDir[hPull]))),
                Vec3d(20, 8, 20))
            let out = Vec3d(field.sideline + 6, 0, Double(hDir) * 3)
            Check.ok(
                h.pullOutOfBounds(out, .sideline).ok,
                "\(label): the choice may be given with the report")
            Check.ok(!h.awaitingPullChoice(), "\(label): and settles it immediately")
            Check.bitEq(
                h.discPos.x, field.sideline,
                "\(label): the sideline spot is on the perimeter line, not past it")
            Check.bitEq(h.discPos.z, out.z, "\(label): at the point where it crossed")
            Check.ok(
                field.isInBounds(h.discPos), "\(label): so the spot is on the pitch")

            // --- the default
            let k = machine(format)
            let kPull = k.pullingTeam
            let kRecv = otherTeam(kPull)
            let kDir = k.attackDir[kRecv]
            k.pull(
                kPull * n, Vec3d(0, 1, field.goalLineZ(flipDir(k.attackDir[kPull]))),
                Vec3d(20, 8, 20))
            k.pullOutOfBounds(Vec3d(field.sideline, 0, Double(kDir) * 4))
            Check.ok(k.choosePullSpot().ok, "\(label): a caller who does not choose gets one")
            Check.bitEq(
                k.discPos.z, Double(kDir) * (field.brickIn - field.goalLine),
                "\(label): and the default is the brick")

            // --- and asking again, with nothing pending, is refused
            Check.ok(
                !k.choosePullSpot(.sideline).ok,
                "\(label): the choice may not be made twice")
        }
    }
}
