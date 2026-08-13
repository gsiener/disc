import Foundation
import UltimateSim

/// Headless coverage for `MatchDirector.InputScript`/`syntheticInputs()` — issue #16
/// Phase 3.
///
/// **This is the phase's concrete "Unlocks" payoff.** Per the issue: "Add director-suite
/// coverage for `saveCycle`, which today is only testable via minutes-long XCUITest
/// runs." Before this move, `-savecycle N` could only be exercised by launching the
/// Simulator, waiting real wall-clock minutes for `N` seconds of *simulated* play to
/// pass, and reading the result off a screenshot. `saveCycleFiresAtTheRightTick` below
/// drives the identical decision — `Double(tickCount) * MatchDirector.tickDt >=
/// saveCycleAfter` — through thousands of ticks in well under a second, because nothing
/// about the decision needs a screen, a clock, or disk I/O; it needs `tickCount`, which
/// the director already tracks.
///
/// `autoDefendFiresWhenUncommitted`/`demoCutRespectsCanCallCut` cover the other two
/// fields `syntheticInputs()` reports, for the same reason the issue calls out: "Also add
/// coverage for `autoDefend`/`demoCut` decision-timing if that logic moved into the
/// director" — it did.
enum InputScriptTests {

    static func run() throws {
        defaultScriptRequestsNothing()
        saveCycleFiresAtTheRightTick()
        saveCycleFiresUnderCatchUpBurst()
        saveCycleIsOneShot()
        autoDefendFiresWhenUncommittedAndStaysQuietOtherwise()
        demoCutRespectsCanCallCut()
        allThreeFieldsAreIndependent()
    }

    private static let tickDt = FrameClock.tickDt

    // MARK: - the default script changes nothing

    /// `.none` is what every director predating this type effectively had. If this ever
    /// reports a request, every non-launch-argument match in the shipped app starts
    /// issuing synthetic input it never asked for.
    private static func defaultScriptRequestsNothing() {
        let d = MatchDirector(match: Engine(format: .minis, seed: 1))
        Check.eq(d.script, InputScript.none, "a director with no script argument defaults to .none")

        let synthetic = d.syntheticInputs()
        Check.ok(!synthetic.defendRequested, "an unscripted director never requests a defend")
        Check.ok(synthetic.cutRequested == nil, "an unscripted director never requests a cut")
        Check.ok(
            !synthetic.saveCycleReached, "an unscripted director never reports a save cycle")

        // And running real ticks through it doesn't change that — 300 frames of a live,
        // scoring match, none of them should ever flip one of these on.
        var now = 0.0
        for _ in 0..<300 {
            now += tickDt
            d.clock.beginFrame(at: now)
            d.match.autoTeams = [0, 1]
            _ = d.runTicks()
            let s = d.syntheticInputs()
            if s.defendRequested || s.cutRequested != nil || s.saveCycleReached {
                Check.ok(false, "an unscripted director stayed quiet across 300 real frames")
                return
            }
            d.clock.endFrame()
        }
        Check.ok(true, "an unscripted director stayed quiet across 300 real frames")
    }

    // MARK: - saveCycle: the phase's headline coverage

    /// Drives a match to a chosen simulated-time threshold and asserts the director
    /// reports the boundary crossing on the exact tick it should — the "Unlocks" claim,
    /// made concrete: this runs in a fraction of a second, not minutes.
    private static func saveCycleFiresAtTheRightTick() {
        // A round, easy-to-reason-about threshold: 10 simulated seconds. At 120 Hz that
        // is tick 1200 — `Double(1200) * tickDt == 10.0` exactly, since `tickDt` is
        // `1.0 / 120.0` and 1200 is a multiple of 120, so this is not fighting floating
        // rounding to find its own answer.
        let threshold = 10.0
        let expectedTick = Int((threshold / tickDt).rounded())
        Check.eq(expectedTick, 1200, "sanity: 10s at 120Hz is tick 1200")

        let script = InputScript(saveCycleAfter: threshold)
        let d = MatchDirector(match: Engine(format: .minis, seed: 7), script: script)
        d.match.autoTeams = [0, 1]

        var firedAtTick: Int?
        var now = 0.0
        // Steady one-tick-per-frame, same technique `TickLoopTests.runSteady` uses, so
        // each `advance` buys exactly the next tick and `tickCount` cannot skip past the
        // threshold between two checks.
        for _ in 0..<(expectedTick + 20) {
            now += tickDt
            d.clock.beginFrame(at: now)
            let synthetic = d.syntheticInputs()
            if synthetic.saveCycleReached {
                firedAtTick = d.tickCount
                d.clock.endFrame()
                break
            }
            _ = d.runTicks()
            d.clock.endFrame()
        }

        Check.eq(
            firedAtTick, expectedTick,
            "the save-cycle boundary is reported at the exact tick the threshold is first "
                + "crossed — 10 simulated seconds at 120 Hz is tick 1200, not one before "
                + "or after")
    }

    /// The threshold check reads simulated time (`tickCount * tickDt`), not wall time —
    /// a hitch that buys many ticks in one frame must not let the boundary slip past
    /// unreported, and a director driven in irregular bursts must land on the same tick
    /// a steady one does.
    private static func saveCycleFiresUnderCatchUpBurst() {
        let threshold = 5.0  // tick 600
        let expectedTick = Int((threshold / tickDt).rounded())

        let script = InputScript(saveCycleAfter: threshold)
        let d = MatchDirector(match: Engine(format: .minis, seed: 11), script: script)
        d.match.autoTeams = [0, 1]

        // `FrameClock` clamps a single frame to `maxTicksPerFrame` (30 at 120 Hz) — see
        // `tickCountsUnderCatchUpBurst` in `TickLoopTests` for the same clamp exercised
        // directly — so reaching tick 600 takes repeated hitches, not one. Each hitch
        // here buys close to the clamp's own ceiling, so the threshold is crossed
        // mid-burst by some hitch rather than landed on exactly by a steady single-tick
        // frame.
        let hitch = Double(FrameClock.maxTicksPerFrame - 3) * tickDt
        var now = 0.0
        var fired = false
        var tickAtFire: Int?
        while d.tickCount < expectedTick + 90 {
            now += hitch
            d.clock.beginFrame(at: now)
            let synthetic = d.syntheticInputs()
            if synthetic.saveCycleReached, !fired {
                fired = true
                tickAtFire = d.tickCount
            }
            _ = d.runTicks()
            d.clock.endFrame()
        }

        Check.ok(
            fired,
            "the save-cycle boundary is reported even though it was reached inside a "
                + "multi-hitch catch-up burst rather than landed on exactly by a steady "
                + "frame")
        if let t = tickAtFire {
            Check.ok(
                t >= expectedTick,
                "and it is reported only once tickCount has actually reached the "
                    + "threshold (reported at tick \(t), threshold tick \(expectedTick))")
        }
    }

    /// `MatchView`'s old `cycled` flag was a one-shot for the process's lifetime — never
    /// reset by `restart`/`adopt`, both of which replace `match` in place rather than
    /// recreating the view (or, now, the director). `saveCycled` (private to
    /// `MatchDirector`) must have the identical property: once reported, never again for
    /// the life of this director instance.
    private static func saveCycleIsOneShot() {
        let threshold = 1.0  // tick 120
        let script = InputScript(saveCycleAfter: threshold)
        let d = MatchDirector(match: Engine(format: .minis, seed: 13), script: script)
        d.match.autoTeams = [0, 1]

        var now = 0.0
        var firstReachedCount = 0
        for _ in 0..<400 {
            now += tickDt
            d.clock.beginFrame(at: now)
            if d.syntheticInputs().saveCycleReached {
                firstReachedCount += 1
            }
            _ = d.runTicks()
            d.clock.endFrame()
        }

        Check.eq(
            firstReachedCount, 1,
            "the save-cycle boundary is reported exactly once across 400 frames spanning "
                + "well past the threshold, not once per frame the threshold stays crossed")
    }

    // MARK: - autoDefend

    /// `syntheticInputs().defendRequested` mirrors `MatchView`'s old `if autoDefend,
    /// match.defensiveCommit == nil` exactly: on while the script wants it and nothing
    /// is committed, off the instant something is.
    private static func autoDefendFiresWhenUncommittedAndStaysQuietOtherwise() {
        // A fresh match starts at `.prePull` — `canDefend` needs a live/in-flight phase
        // and the *other* team holding (`Engine.canDefend`) — so `attemptDefend()` has
        // nothing to commit to yet. Confirm the requested/uncommitted read still holds
        // in that state before advancing.
        let script = InputScript(autoDefend: true)
        let fresh = MatchDirector(match: Engine(format: .minis, seed: 17), script: script)
        Check.ok(
            fresh.match.defensiveCommit == nil,
            "sanity: a fresh match has no defensive commit yet")
        Check.ok(
            fresh.syntheticInputs().defendRequested,
            "autoDefend requests a defend while nothing is committed, even before the "
                + "match has anything to commit to")

        // Advance the default-configured match (`autoTeams` defaults to `[1]`, so team 1
        // auto-throws and team 0 never does) until team 1 holds the disc live — the
        // state `attemptDefend()` actually needs, same technique
        // `HumanDefenceTests.aTapWithNothingToCommitToDoesNothing`'s counterpart uses.
        let e = Engine(format: .minis, seed: 17)
        var ticks = 0
        while !(e.game.phase == .livePossession && e.possession == 1), ticks < 120 * 240 {
            e.step(dt: tickDt)
            ticks += 1
        }
        guard e.game.phase == .livePossession, e.possession == 1 else {
            Check.ok(false, "a live possession for team 1 was reached inside 240 s")
            return
        }

        let d = MatchDirector(match: e, script: script)
        Check.ok(
            d.syntheticInputs().defendRequested,
            "still requested once there is something real to commit to")

        // An unscripted director sharing the same, still-uncommitted match never
        // requests one — proving the difference is the script, not the match state.
        let quiet = MatchDirector(match: e)
        Check.ok(
            !quiet.syntheticInputs().defendRequested,
            "a director with autoDefend off never requests a defend, uncommitted or not")

        // Commit one directly through the engine's own entry point — the same one
        // `MatchView.defend(at:)` calls — so the scenario proves the *director's* read
        // of `defensiveCommit`, not a hand-rolled substitute for it.
        if case .success = e.attemptDefend() {
            Check.ok(
                !d.syntheticInputs().defendRequested,
                "and stops requesting one the instant a defensive commit exists — the "
                    + "director reads live match state, not a cached decision")
        } else {
            Check.ok(
                false,
                "attemptDefend() should succeed once team 1 holds the disc live and "
                    + "team 0 has an available defender")
        }
    }

    // MARK: - demoCut

    /// `syntheticInputs().cutRequested` mirrors `MatchView`'s old `if let u = demoCut,
    /// viewSize != .zero, match.canCallCut` minus the view-metric half: the director
    /// reports the script's point unchanged exactly when `canCallCut` is true, and nil
    /// otherwise — including when the script has no cut configured at all.
    private static func demoCutRespectsCanCallCut() {
        let point = NormalizedPoint(x: 0.5, y: 0.35)
        let script = InputScript(demoCut: point)

        // False case: a fresh match sits at `.prePull` — `Engine.canCallCut` needs
        // `.livePossession` — so nothing is requested yet.
        let fresh = MatchDirector(match: Engine(format: .minis, seed: 23), script: script)
        Check.ok(
            !fresh.match.canCallCut,
            "sanity: a fresh match has not reached a live cut window yet")
        Check.ok(
            fresh.syntheticInputs().cutRequested == nil,
            "cutRequested is nil while canCallCut is false")

        // True case: advance to our own live possession, holding the disc, with the
        // carrier already the controlled body — `Engine.canCallCut`'s exact three
        // conditions (cooldown aside). Same technique
        // `HumanCutTests.ourPossession` uses: `autoTeams` defaults to `[1]`, so team 0
        // never auto-throws it away once caught.
        let e = Engine(format: .minis, seed: 23)
        var ticks = 0
        var reached = false
        while ticks < 120 * 240 {
            e.step(dt: tickDt)
            ticks += 1
            if e.game.phase == .livePossession, e.possession == 0, e.carrier != nil,
                e.carrier == e.controlled
            {
                reached = true
                break
            }
        }
        guard reached else {
            Check.ok(false, "our own live possession, disc in hand, was reached inside 240 s")
            return
        }

        let d = MatchDirector(match: e, script: script)
        Check.ok(e.canCallCut, "sanity: our own settled live possession is a cut window")
        Check.eq(
            d.syntheticInputs().cutRequested, point,
            "cutRequested carries the script's point unchanged while canCallCut is true")

        // Keep driving real ticks through the director from here (nothing ever calls
        // the cut, so nothing consumes the cooldown or moves the disc on purpose) and
        // check every single frame's answer against `e.canCallCut` directly, rather than
        // trusting the one instant above — this is the loop-shaped coverage the "decision
        // timing" half of the phase asks for. A stall-out eventually turns the disc over
        // (team 0 never throws it away on purpose here), which is exactly the transition
        // back to `canCallCut == false` this loop wants to see too.
        var now = 0.0
        var sawTrue = false
        var sawFalse = false
        for _ in 0..<400 {
            now += tickDt
            d.clock.beginFrame(at: now)
            let synthetic = d.syntheticInputs()
            if e.canCallCut {
                sawTrue = true
                Check.eq(
                    synthetic.cutRequested, point,
                    "cutRequested keeps carrying the script's point on every frame "
                        + "canCallCut reads true")
            } else {
                sawFalse = true
                Check.ok(
                    synthetic.cutRequested == nil,
                    "cutRequested drops to nil the moment canCallCut reads false — "
                        + "e.g. once the possession turns over")
            }
            _ = d.runTicks()
            d.clock.endFrame()
        }
        Check.ok(
            sawTrue,
            "the 400-frame follow-on run visited at least one canCallCut-true frame")
        // Not asserting `sawFalse`: whether the window closes within 400 frames depends
        // on the stall clock and is not this test's claim — the two branches above are
        // exercised whichever way it goes, and `sawTrue` is the one guaranteed by setup.
        _ = sawFalse

        // No script configured at all: never requested, independent of canCallCut.
        let quiet = MatchDirector(match: e)
        Check.ok(
            quiet.syntheticInputs().cutRequested == nil,
            "a director with no demoCut configured never requests a cut, even in a live "
                + "cut window")
    }

    // MARK: - independence

    /// The three fields are evaluated from independent conditions — verify none of them
    /// leaks into another when all three are scripted at once, the way a real
    /// `-defend on -cut x,y -savecycle N` launch would.
    private static func allThreeFieldsAreIndependent() {
        let threshold = 2.0  // tick 240
        let point = NormalizedPoint(x: 0.2, y: 0.8)
        let script = InputScript(autoDefend: true, demoCut: point, saveCycleAfter: threshold)
        let d = MatchDirector(match: Engine(format: .minis, seed: 31), script: script)
        d.match.autoTeams = []  // nobody auto-plays; only the script's own decisions act

        var now = 0.0
        var sawSaveCycle = false
        for _ in 0..<300 {
            now += tickDt
            d.clock.beginFrame(at: now)
            let synthetic = d.syntheticInputs()
            // Whatever the individual booleans read, cutRequested (when non-nil) is
            // always exactly the scripted point, never influenced by defendRequested or
            // saveCycleReached having also fired this frame.
            if let cut = synthetic.cutRequested {
                Check.eq(
                    cut, point,
                    "cutRequested stays exactly the scripted point even on a frame where "
                        + "the other two fields also fire")
            }
            if synthetic.saveCycleReached {
                sawSaveCycle = true
            }
            _ = d.runTicks()
            d.clock.endFrame()
        }
        Check.ok(
            sawSaveCycle,
            "the combined script still reaches its save-cycle threshold across 300 "
                + "frames — the other two fields being live does not starve it")
    }
}
