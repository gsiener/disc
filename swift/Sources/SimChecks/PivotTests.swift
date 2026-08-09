import Foundation
import UltimateSim

/// The pivot foot, and the travel call it makes possible.
///
/// Three layers have to agree before a travel means anything, and each of them was
/// individually fine and jointly dead before this suite existed:
///
///   1. `Locomotion.stepPivot` establishes a foot and holds the body to `PIVOT_R` of
///      it. Without it a thrower drifts wherever his momentum and the marker's
///      shoulder take him.
///   2. `Engine.observation` reports that foot, and moves the machine's pivot to it
///      once, at the moment it is established. Without that the rules layer compares
///      an established foot against the point of the *catch* and every running catch
///      reads as a travel.
///   3. `GameState` flags the slip and `makeCall`/`resolveCall` resolve it — pivot
///      reset, count back one, and a pass that was already in the air still stands.
///
/// So the assertions here run bottom-up: the constraint alone, then the momentum
/// allowance the rules owe a receiver, then a body that genuinely carries the disc,
/// then the whole path through a real engine.
///
/// **The measurement matters as much as the assertions.** A pivot constraint that
/// fires constantly is not a rule, it is a bug with a rulebook citation, so this
/// suite reports how often a travel is called in fifteen minutes of AI play and what
/// the momentum carry actually costs the defence.
enum PivotTests {

    static let dt = 1.0 / 120.0

    static func run() throws {
        constraintHolds()
        momentumAllowance()
        carryingIsATravel()
        theCallResolves()
        inAMatch()
    }

    // MARK: helpers

    private static func loco() -> Locomotion {
        let l = Locomotion()
        l.attach(LocoHost())
        return l
    }

    /// Drive one anchored body for `seconds`, returning the worst body excursion from
    /// its established foot and the worst slip of the foot itself.
    @discardableResult
    private static func drive(
        _ l: Locomotion, _ p: LocoPlayer, _ desired: DesiredMove, seconds: Double,
        onStep: ((Double) -> Void)? = nil
    ) -> (reach: Double, slip: Double, locked: Vec2d?) {
        var reach = 0.0
        var slip = 0.0
        var first: Vec2d?
        let steps = Int((seconds / dt).rounded())
        for i in 0..<steps {
            l.step(p, desired, dt)
            l.resolveCollisions(dt)
            if let foot = l.pivotOf(p.id) {
                if first == nil { first = foot }
                reach = Swift.max(reach, Foundation.hypot(p.pos.x - foot.x, p.pos.z - foot.z))
                if let f = first {
                    slip = Swift.max(slip, Foundation.hypot(foot.x - f.x, foot.z - f.z))
                }
            }
            onStep?(Double(i) * dt)
        }
        return (reach, slip, l.pivotOf(p.id))
    }

    // MARK: - the constraint

    /// A thrower standing on his pivot, told to sprint downfield for five seconds.
    ///
    /// He may lean out to `PIVOT_R` and no further, and — this is the part the travel
    /// call depends on — his foot may not creep while he does it. A constraint that
    /// leaks a millimetre a step is a travel every seven seconds of held disc, which
    /// is how a rule that fires "rarely" turns into one that fires constantly.
    private static func constraintHolds() {
        let l = loco()
        let p = l.create(CreateOpts(id: 1, team: 0, pos: Vec3d(0, 0, 0)))
        p.anchored = true

        guard let first = { () -> Vec2d? in
            l.step(p, DesiredMove(), dt)
            return l.pivotOf(p.id)
        }() else {
            Check.ok(false, "a stationary thrower establishes a pivot at once")
            return
        }

        var reach = 0.0
        var slipAt2 = 0.0
        for i in 0..<Int(5.0 / dt) {
            l.step(p, DesiredMove(dir: Vec2d(0, 1), mode: .sprint), dt)
            l.resolveCollisions(dt)
            guard let foot = l.pivotOf(p.id) else { continue }
            reach = Swift.max(reach, Foundation.hypot(p.pos.x - foot.x, p.pos.z - foot.z))
            if Double(i) * dt <= 2.0 {
                slipAt2 = Foundation.hypot(foot.x - first.x, foot.z - first.z)
            }
        }
        let slip = l.pivotOf(p.id).map { Foundation.hypot($0.x - first.x, $0.z - first.z) } ?? .infinity

        Check.inRange(
            reach, 0.5, Locomotion.PIVOT_R + 1e-6,
            "a thrower reaches his full stretch and no further")
        // The lunge itself is paid for: driving from the middle of his stance into
        // full extension drags the foot a little, and the leg has to absorb it inside
        // the tolerance or the lunge would be a call. Everything after that is free.
        Check.ok(
            slip < makeRules().travelTolerance,
            "a full lunge onto the leg drags the foot \(slip) m, inside the tolerance")
        Check.near(
            slip, slipAt2, 1e-9,
            "and three more seconds of sprinting into it move the foot no further")
        Check.ok(
            !isTravel(Vec3d(first.x, 0, first.z), Vec3d(l.pivotOf(p.id)!.x, 0, l.pivotOf(p.id)!.z),
                makeRules()),
            "which is not a travel")

        // And the freedom is real: the same body may work all the way around the disc.
        let ring = loco()
        let q = ring.create(CreateOpts(id: 2, team: 0, pos: Vec3d(0, 0, 0)))
        q.anchored = true
        ring.step(q, DesiredMove(), dt)
        guard let foot = ring.pivotOf(q.id) else {
            Check.ok(false, "the ring body established a pivot")
            return
        }
        var swept = 0.0
        var last = Foundation.atan2(q.pos.x - foot.x, q.pos.z - foot.z)
        for i in 0..<Int(6.0 / dt) {
            let a = Double(i) * dt * 2.2
            _ = ring.step(
                q, DesiredMove(dir: Vec2d(Foundation.cos(a), Foundation.sin(a)), mode: .run), dt)
            ring.resolveCollisions(dt)
            let now = Foundation.atan2(q.pos.x - foot.x, q.pos.z - foot.z)
            var d = now - last
            while d > Double.pi { d -= 2 * Double.pi }
            while d < -Double.pi { d += 2 * Double.pi }
            swept += abs(d)
            last = now
        }
        Check.ok(swept > Double.pi, "a handler can pivot right around his own foot (\(swept) rad)")
        let creep = ring.pivotOf(q.id).map {
            Foundation.hypot($0.x - foot.x, $0.z - foot.z)
        } ?? .infinity
        Check.ok(creep <= makeRules().travelTolerance, "without the foot creeping off (\(creep) m)")
    }

    // MARK: - the momentum the rules owe him

    /// A receiver catching at speed and stopping as fast as he can.
    ///
    /// WFDF 18.2 pays for the steps, so nothing here may be a travel — and the pivot
    /// must end up where he STOPPED, not where he caught it, which is the yardage a
    /// real receiver keeps.
    private static func momentumAllowance() {
        var carries: [(entry: Double, carry: Double)] = []
        for entry in [4.0, 6.0, 8.0] {
            let l = loco()
            let p = l.create(CreateOpts(id: 1, team: 0, pos: Vec3d(0, 0, 0)))
            p.vel = Vec3d(0, 0, entry)
            p.anchored = true

            var lockedAt: Vec2d?
            var lockT = Double.infinity
            let steps = Int(3.0 / dt)
            for i in 0..<steps {
                l.step(p, DesiredMove(brake: true), dt)
                l.resolveCollisions(dt)
                if lockedAt == nil, let f = l.pivotOf(p.id) {
                    lockedAt = f
                    lockT = Double(i) * dt
                }
            }
            guard let foot = lockedAt else {
                Check.ok(false, "a receiver at \(entry) m/s establishes a pivot within 3 s")
                continue
            }
            let carry = Foundation.hypot(foot.x, foot.z)
            Check.note(
                "pivot carry at \(entry) m/s: \(String(format: "%.3f", carry)) m, "
                    + "brakeMax \(String(format: "%.2f", p.derived.brakeMax)) m/s², "
                    + "lock at \(String(format: "%.3f", lockT)) s")
            carries.append((entry, carry))

            // THE FLOOR, WHICH IS THE HALF THIS CHECK WAS MISSING.
            //
            // The range started at zero, so a build that locked the pivot instantly at the
            // catch point — deleting the entire WFDF 18.2 momentum allowance this test
            // exists to prove — scored 0.0 m at every entry speed and passed. That is the
            // one bug the file is here to catch and it was the one case the assertion could
            // not see.
            //
            // The floor is derived rather than picked: a body braking flat out from `entry`
            // to `PIVOT_STOP_SPEED` covers `(v² - stop²) / 2a`, which is what the rules are
            // paying for, capped at `PIVOT_CARRY_MAX` because nothing pays past that. Half
            // of that is the bar — the sim's brake ramps in rather than stepping to max, so
            // the ideal is an upper bound on the real distance, not a target.
            //
            // **A pivot is a foot, so its resolution is a footfall**, and that is why the
            // floor only applies once the stop is longer than a stride. At 4 m/s the body
            // reaches walking pace in 0.23 s and never re-plants, so the pivot is honestly
            // the foot he caught it on and the measured carry is 0.000 m. At 6 and 8 m/s it
            // is 1.307 m and 2.689 m against ideals of 1.406 and 2.545 — i.e. the carry
            // tracks the physics closely wherever there is a stride to spend.
            let ideal = Swift.min(
                (entry * entry - Locomotion.PIVOT_STOP_SPEED * Locomotion.PIVOT_STOP_SPEED)
                    / (2 * p.derived.brakeMax),
                Locomotion.PIVOT_CARRY_MAX)
            let floor = ideal > strideLength ? 0.5 * ideal : 0
            Check.inRange(
                carry, floor, Locomotion.PIVOT_CARRY_MAX + 0.5,
                "a \(entry) m/s catch carries \(carry) m before the pivot is set — the "
                    + "rules owe him at least \(String(format: "%.3f", floor)) m of it "
                    + "(half the \(String(format: "%.3f", ideal)) m he needs to stop in)")
            Check.ok(lockT < Locomotion.PIVOT_GRACE + 1e-9, "and sets it in \(lockT) s")
            // The whole point of establishing where he stopped: measured from there,
            // stopping is not travelling.
            let after = l.pivotOf(p.id)!
            Check.ok(
                !isTravel(Vec3d(foot.x, 0, foot.z), Vec3d(after.x, 0, after.z), makeRules()),
                "and stopping hard is never a travel")
        }

        // AND THE ALLOWANCE SCALES, which no per-entry bound can say on its own. A build
        // that paid every receiver the same fixed carry would clear all three floors above
        // and still have thrown away the rule: 18.2 pays for the steps you actually needed,
        // so a faster catch must buy more ground than a slower one.
        for (a, b) in zip(carries, carries.dropFirst()) {
            Check.ok(
                b.carry > a.carry + 0.25,
                "a \(b.entry) m/s catch carries meaningfully further than a \(a.entry) m/s "
                    + "one (\(String(format: "%.3f", b.carry)) m vs "
                    + "\(String(format: "%.3f", a.carry)) m)")
        }
    }

    /// One stride, metres. The resolution of a pivot: below this a stopping body never
    /// re-plants, so the foot he caught it on is the foot he keeps.
    private static let strideLength = 1.0

    // MARK: - carrying

    /// The same catch, from a man who does not stop.
    ///
    /// The allowance is a distance — what a maximal stop from his catching speed
    /// needs — so a body that keeps driving runs out of it while still at speed. The
    /// foot locks under him, his own leg cannot check that much momentum, and it
    /// drags: the metres it drags are the travel.
    private static func carryingIsATravel() {
        let l = loco()
        let p = l.create(CreateOpts(id: 1, team: 0, pos: Vec3d(0, 0, 0)))
        p.vel = Vec3d(0, 0, 7)
        p.anchored = true

        var lockedAt: Vec2d?
        for _ in 0..<Int(3.0 / dt) {
            l.step(p, DesiredMove(dir: Vec2d(0, 1), mode: .sprint), dt)
            l.resolveCollisions(dt)
            if lockedAt == nil, let f = l.pivotOf(p.id) { lockedAt = f }
        }
        guard let foot = lockedAt, let now = l.pivotOf(p.id) else {
            Check.ok(false, "a man running with the disc still establishes a pivot")
            return
        }
        let slip = Foundation.hypot(now.x - foot.x, now.z - foot.z)
        Check.ok(slip > makeRules().travelTolerance, "running with the disc drags the foot \(slip) m")
        Check.ok(
            isTravel(Vec3d(foot.x, 0, foot.z), Vec3d(now.x, 0, now.z), makeRules()),
            "which the rules call a travel")
        // He does not get to keep running, either: the leg is still taking momentum
        // out of him the whole way.
        Check.ok(
            Foundation.hypot(p.vel.x, p.vel.z) < 3.0,
            "and the leg has most of his speed off him (\(Foundation.hypot(p.vel.x, p.vel.z)) m/s)")
    }

    // MARK: - the call

    /// The rules half, end to end: flag, call, remedy.
    ///
    /// The remedy is the reason any of this is worth wiring — pivot back where it was,
    /// count back one, and a pass already thrown still stands.
    private static func theCallResolves() {
        var opts = GameStateOptions()
        var events: [String] = []
        opts.emit = { events.append($0.name) }
        let game = GameState(opts)
        game.startGame()
        game.setLine(0, [0, 1, 2, 3, 4, 5, 6])
        game.setLine(1, [7, 8, 9, 10, 11, 12, 13])
        game.pull(7, Vec3d(0, 1, -46))
        game.catchDisc(0, Vec3d(0, 1, 10))

        Check.eq(game.phase, .livePossession, "the receiving team is live")
        let pivot = game.pivot

        // Four seconds of a legal mark, with the foot where it was established: the
        // count runs and nothing is called.
        var obs = FrameObservation()
        obs.throwerPos = Vec3d(pivot.x, 0, pivot.z)
        obs.pivotFoot = pivot
        obs.markerId = .value(7)
        obs.markerPos = .value(Vec3d(pivot.x + 1.5, 0, pivot.z))
        for _ in 0..<Int(4.0 / dt) { game.step(dt, obs) }
        Check.ok(game.stallCount >= 3, "the count runs on a legal mark (\(game.stallCount))")
        Check.eq(game.playerStats(0)?.travels ?? -1, 0, "and a still pivot is not a travel")

        // Now the foot slips a metre.
        let reached = game.stallCount
        obs.pivotFoot = Vec3d(pivot.x, 0, pivot.z + 1.0)
        game.step(dt, obs)
        Check.ok((game.playerStats(0)?.travels ?? 0) > 0, "a metre of slip is flagged")
        Check.ok(events.contains("violation"), "and announced")

        // Called by the mark and accepted by the thrower.
        Check.ok(game.makeCall(.travel, 7, 0, obs.pivotFoot).ok, "the mark calls it")
        Check.eq(game.phase, .check, "play stops")
        Check.ok(game.resolveCall(false).ok, "the thrower accepts it")
        Check.near(distXZ(game.pivot, pivot), 0, 1e-9, "the pivot is where it always was")
        Check.eq(
            game.pendingStallResume, Swift.max(0, reached - 1),
            "and the count backs up exactly one")

        // A travel called after the release does not undo the pass.
        game.check()
        let before = game.teamStats(0).completions
        game.release(playerId: 0, pos: pivot, vel: Vec3d(0, 0, 12))
        game.catchDisc(1, Vec3d(0, 1, 25))
        Check.eq(game.teamStats(0).completions, before + 1, "a completed pass is a completion")
        Check.ok(game.makeCall(.travel, 7, 0, pivot).ok, "a travel is called after the fact")
        game.resolveCall(false)
        Check.eq(
            game.teamStats(0).completions, before + 1,
            "and the completed pass still stands")
    }

    // MARK: - in a match

    /// Fifteen minutes of AI play, with the constraint live.
    ///
    /// The numbers are reported rather than pinned, because `EngineTests` owns the
    /// telemetry bands. What is asserted here is only what this change is responsible
    /// for: the offence still works, the thrower is genuinely pinned to a foot, and
    /// travels are rare. A compliant AI thrower stops when he catches and stands still
    /// while he looks the field off, so the honest expectation is *zero* travels in a
    /// clean match — the call exists for bodies that carry the disc, and the check
    /// above proves that path fires. Anything above a handful here would mean the
    /// constraint is wrong rather than the threshold.
    private static func inAMatch() {
        let e = Engine(format: .sevens, seed: 11)
        e.autoTeams = [0, 1]

        var travels = 0
        var worstReach = 0.0
        var pinnedFrames = 0
        var heldFrames = 0

        for _ in 0..<(120 * 900) where !e.isOver {
            e.step(dt: dt)
            guard e.game.phase == .livePossession, let id = e.game.thrower else { continue }
            heldFrames += 1
            guard let body = e.loco.get(id) else { continue }
            if let foot = e.loco.pivotOf(id) {
                pinnedFrames += 1
                worstReach = Swift.max(
                    worstReach, Foundation.hypot(body.pos.x - foot.x, body.pos.z - foot.z))
            }
        }
        for p in e.players { travels += e.game.playerStats(p.id)?.travels ?? 0 }

        let pinned = heldFrames > 0 ? 100.0 * Double(pinnedFrames) / Double(heldFrames) : 0
        Check.note(
            "pivot: \(travels) travels in fifteen minutes, thrower on an established foot "
                + String(format: "%.0f%%", pinned) + " of held frames, worst reach "
                + String(format: "%.2f", worstReach) + " m of "
                + String(format: "%.2f", Locomotion.PIVOT_R))

        Check.ok(travels <= 6, "travels are rare in a clean match (\(travels))")
        Check.ok(
            worstReach <= Locomotion.PIVOT_R + 0.05,
            "no thrower is ever further from his foot than his leg is long (\(worstReach) m)")
        Check.ok(pinned > 50, "and most held frames are on an established pivot (\(pinned)%)")
        Check.ok(e.stats.completions > 20, "the offence still completes passes (\(e.stats.completions))")
        Check.ok(e.stats.goals > 0, "and still scores (\(e.stats.goals))")
    }
}
