import Foundation
import UltimateSim

/// The clock the game is played on, asserted rather than assumed.
///
/// **Why this suite exists.** Everything else in `SimChecks` measures the simulation, and
/// the simulation is a pure function of `(format, seed, inputs)` — it never reads a clock.
/// But something has to decide how much wall time the simulation is asked to spend, and
/// for as long as that decision was arithmetic scattered through a two-thousand-line
/// SwiftUI view, two million assertions had nothing to say about it. An independent review
/// of shipped `main` then found four player-facing bugs, and every one of them lived in
/// exactly that arithmetic:
///
///  - a charge that outlived the thumb, which pinned the aim overlay on screen for the
///    rest of the match and graded **every subsequent throw** `.overcharged`;
///  - a hitstop frozen by a backgrounding, so returning to the app played the next 0.4 s
///    of a fresh point at 0.35× speed;
///  - a tick loop with no notion of full time, buying 120 engine steps a second behind a
///    result card;
///  - and, on the save path, a setup that had drifted away from the match it described.
///
/// So the clock is now a value type — `FrameClock`, in the sim package, depending on
/// nothing — and this is what it promises. The last section is not about the clock at all;
/// it is the restore machinery being made to demonstrate, on real engines, why the save
/// has to be stamped with the setup a match is *played* under.
enum ClockTests {

    static func run() throws {
        fixedStepAndClamp()
        gapsAreAbandonedNotRepaid()
        slowMotionScalesTheInputNotTheStep()
        theChargeCannotOutliveTheThumb()
        aDriftedSetupCannotRestore()
    }

    /// One frame of the app's `advance`, in the order `advance` does it: pay in the wall
    /// time, spend it on whole ticks, then burn the real-time fuses.
    @discardableResult
    private static func frames(
        _ clock: inout FrameClock, count: Int, dt: Double, from start: Double = 0,
        deferAfterFirstTick: Bool = false
    ) -> Int {
        var ticks = 0
        for i in 0..<count {
            let now = start + Double(i + 1) * dt
            guard clock.beginFrame(at: now) != nil else { continue }
            while clock.takeTick() {
                ticks += 1
                if deferAfterFirstTick {
                    clock.deferRemainingTicks()
                    break
                }
            }
            clock.endFrame()
        }
        return ticks
    }

    // MARK: - the fixed step, and the clamp on it

    /// The step never varies, the debt is clamped, and a slow frame cannot cause the next
    /// one.
    ///
    /// `Replay.swift` establishes that `Engine.step` is not associative in `dt` and that
    /// the whole validation suite runs at 1/120, so the shipped game has exactly one
    /// freedom: how *many* ticks a frame buys. These are the bounds on that number.
    private static func fixedStepAndClamp() {
        Check.eq(FrameClock.tickHz, 120, "the shipped tick rate is the validated one")
        Check.bitEq(FrameClock.tickDt, 1.0 / 120.0, "the tick is 1/120 s exactly")
        Check.eq(
            FrameClock.maxTicksPerFrame, 30,
            "one frame can never demand more than 30 ticks — see the clamp")

        // A steady 60 Hz stream buys exactly two ticks a frame, forever, with nothing left
        // over. Sixty seconds of it is 7200 ticks and not 7199 or 7201: the leftover
        // fraction of a frame stays in the accumulator, so the sim runs at real speed
        // without the frame rate ever changing the step.
        var steady = FrameClock()
        let steadyTicks = frames(&steady, count: 3600, dt: 1.0 / 60.0)
        Check.eq(steadyTicks, 7198, "60 s at 60 Hz buys 7200 ticks, less the unmeasurable first frame")
        Check.ok(steady.accumulator < FrameClock.tickDt, "and leaves less than a tick owing")

        // An awkward rate that divides into nothing: 90 Hz for ten seconds. The count has
        // to land on the wall clock, not on the display's.
        var awkward = FrameClock()
        let awkwardTicks = frames(&awkward, count: 900, dt: 1.0 / 90.0)
        Check.inRange(
            Double(awkwardTicks), 1198, 1200,
            "10 s at 90 Hz buys the same ~1200 ticks — the display cannot change the game")

        // The clamp. A five-second frame — a hitch, a debugger pause, a spell in the
        // background with the stamp somehow kept — pays for 30 ticks and no more.
        var hitched = FrameClock()
        hitched.beginFrame(at: 0)
        hitched.beginFrame(at: 5)
        var burst = 0
        while hitched.takeTick() { burst += 1 }
        Check.eq(burst, 30, "a five-second frame yields 30 ticks, not 600")
        Check.ok(hitched.accumulator < FrameClock.tickDt, "and the rest of the debt is dropped")

        // And it does not spiral: a hundred one-second frames in a row each yield 30, so
        // the debt from a slow frame can never be what causes the next slow frame.
        var stalling = FrameClock()
        stalling.beginFrame(at: 0)
        var worst = 0
        for i in 1...100 {
            stalling.beginFrame(at: Double(i))
            var n = 0
            while stalling.takeTick() { n += 1 }
            worst = Swift.max(worst, n)
            stalling.endFrame()
        }
        Check.eq(worst, 30, "a hundred one-second frames still yield 30 ticks each")

        // The tick paid out is always the tick the suite validated, whatever came in.
        var exact = FrameClock()
        exact.beginFrame(at: 0)
        exact.beginFrame(at: 0.1)
        let before = exact.accumulator
        _ = exact.takeTick()
        Check.near(
            before - exact.accumulator, FrameClock.tickDt, 1e-15,
            "a tick taken is one tickDt of debt and never a fraction more, at any rate")
    }

    // MARK: - the gap

    /// Time that passed while nobody was looking is not owed to the simulation.
    ///
    /// This is the invariant behind "a minute on the second coach card costs the match
    /// nothing". It also has to hold for the app being backgrounded for an hour, which is
    /// the case where the *clamp alone* is not an answer: 30 ticks of a point the player
    /// never saw, fired off in the first frame back, is a turnover they did not make.
    private static func gapsAreAbandonedNotRepaid() {
        var kept = FrameClock()
        kept.beginFrame(at: 0)
        kept.beginFrame(at: 1800)
        var repaid = 0
        while kept.takeTick() { repaid += 1 }
        Check.eq(
            repaid, 30,
            "keeping the stamp across half an hour would still fire 30 ticks in one frame")

        var dropped = FrameClock()
        dropped.beginFrame(at: 0)
        dropped.abandon()
        Check.eq(
            frames(&dropped, count: 1, dt: 1, from: 1800), 0,
            "the first frame after a gap measures nothing at all")
        // And from there it measures itself and nothing more: a second of frames after
        // an hour away is a second of game, not thirty ticks of catch-up. (Within one
        // tick — a frame worth exactly two of them lands either side of the boundary as
        // the accumulator carries its remainder, which is the mechanism working.)
        Check.inRange(
            Double(frames(&dropped, count: 60, dt: 1.0 / 60.0, from: 1801)), 119, 120,
            "and the frames after it are worth exactly what they measure")

        // What else the gap takes with it. Both are wall-clock state measured against a
        // moment that no longer exists.
        var interrupted = FrameClock()
        interrupted.beginCharge()
        interrupted.slow(.init(scale: 0.35, timeLeft: 0.45))
        frames(&interrupted, count: 6, dt: 1.0 / 60.0)
        Check.ok(interrupted.hold > 0, "the charge was running before the interruption")
        Check.ok(interrupted.slowMo != nil, "and so was the hitstop")
        interrupted.abandon()
        Check.ok(interrupted.slowMo == nil, "a hitstop does not survive a backgrounding")
        Check.ok(!interrupted.charging, "and neither does a charge")
        Check.bitEq(interrupted.hold, 0, "the charge reads zero, not merely stopped")
        Check.ok(interrupted.lastFrame == nil, "the frame stamp went with them")

        // A new match resets one more thing: the hitstop cooldown is per match, and starts
        // long enough ago that the first laid-out D of a game is never swallowed.
        var fresh = FrameClock()
        fresh.slow(.init(scale: 0.35, timeLeft: 0.45))
        Check.ok(!fresh.canSlow(after: 8), "a second hitstop inside the cooldown is refused")
        fresh.reset()
        Check.ok(fresh.canSlow(after: 8), "a new match may have its first hitstop immediately")
    }

    // MARK: - slow motion

    /// Slow motion scales the wall time paid *in* and never the tick paid *out*, and its
    /// own fuse burns in real seconds.
    ///
    /// The first half is what makes the effect invisible to a replay — the property that
    /// lets it exist at all. The second is what stops a 0.35 s hitstop lasting a second on
    /// the clock the player lives on.
    private static func slowMotionScalesTheInputNotTheStep() {
        var slowed = FrameClock()
        slowed.beginFrame(at: 0)
        // A fuse long enough to cover the whole measurement, so this isolates the scale.
        slowed.slow(.init(scale: 0.35, timeLeft: 100))
        let ticks = frames(&slowed, count: 60, dt: 1.0 / 60.0, from: 0)
        Check.inRange(
            Double(ticks), 41, 43,
            "one second at 0.35× buys ~42 ticks instead of 120 — the input is scaled")

        // The fuse. 0.45 s of *real* frames, not 0.45 s of slowed ones (which would be
        // 1.29 s of the player's life).
        var fused = FrameClock()
        fused.beginFrame(at: 0)
        fused.slow(.init(scale: 0.35, timeLeft: 0.45))
        frames(&fused, count: 26, dt: 1.0 / 60.0, from: 0)
        Check.ok(fused.slowMo != nil, "the hitstop is still on at 0.43 s of real time")
        frames(&fused, count: 4, dt: 1.0 / 60.0, from: 26.0 / 60.0)
        Check.ok(fused.slowMo == nil, "and off by 0.48 s, on the player's clock")

        // The cooldown, measured in the same real seconds.
        var cooling = FrameClock()
        cooling.beginFrame(at: 0)
        cooling.slow(.init(scale: 0.35, timeLeft: 0.45))
        frames(&cooling, count: 60 * 7, dt: 1.0 / 60.0, from: 0)
        Check.ok(!cooling.canSlow(after: 8), "a second hitstop 7 s later is still refused")
        frames(&cooling, count: 60 * 2, dt: 1.0 / 60.0, from: 7)
        Check.ok(cooling.canSlow(after: 8), "9 s later it is allowed")

        // "Starting at the catch frame": a burst of catch-up ticks owed when the hitstop
        // lands must not be spent before the screen has drawn the moment that caused it.
        var deferred = FrameClock()
        deferred.beginFrame(at: 0)
        deferred.beginFrame(at: 5)
        Check.eq(
            frames(&deferred, count: 0, dt: 1), 0, "a no-op frame count runs nothing")
        var spent = 0
        while deferred.takeTick() {
            spent += 1
            deferred.deferRemainingTicks()
            break
        }
        Check.eq(spent, 1, "the tick that scored the block is spent")
        Check.ok(
            deferred.accumulator <= FrameClock.tickDt,
            "and at most one more tick of the burst survives to the next frame")
    }

    // MARK: - the charge

    /// The throw's charge runs on the frame clock, and it dies with the gesture.
    ///
    /// It runs on the frame clock because `DragGesture.onChanged` only fires when the
    /// finger *moves* — a player who drags out and holds perfectly still would otherwise
    /// have a charge that stopped charging. That is also what made the shipped bug so
    /// bad: two exit paths returned without ending the charge, and there was no other
    /// clock to notice.
    private static func theChargeCannotOutliveTheThumb() {
        var c = FrameClock()
        c.beginFrame(at: 0)
        Check.ok(!c.charging, "no thumb, no charge")
        frames(&c, count: 30, dt: 1.0 / 60.0, from: 0)
        Check.bitEq(c.hold, 0, "and half a second of frames does not start one")

        c.beginCharge()
        frames(&c, count: 30, dt: 1.0 / 60.0, from: 0.5)
        Check.near(c.hold, 0.5, 0.02, "a held thumb charges on the frame clock")

        // `onChanged` fires again on every movement of the same gesture, and must not
        // restart the charge it is in the middle of.
        c.beginCharge()
        Check.near(c.hold, 0.5, 0.02, "a gesture that keeps moving keeps its charge")

        c.endCharge()
        frames(&c, count: 30, dt: 1.0 / 60.0, from: 1.0)
        Check.bitEq(c.hold, 0, "a released thumb leaves no charge behind")

        // The bug, as the player met it. A drag whose `onEnded` never cleared it kept
        // charging: five seconds of match later the next throw inherited the whole hold,
        // and `ThrowCharge` grades that overcharged for every throw in the game — a
        // permanent, invisible tax on the rest of the match.
        var stale = FrameClock()
        stale.beginCharge()
        frames(&stale, count: 300, dt: 1.0 / 60.0, from: 0)
        Check.ok(
            ThrowType.allCases.allSatisfy {
                ThrowGesture.charge(for: $0).isOvercharged(hold: stale.hold)
            },
            "a charge left running for 5 s overcharges every throw type in the game")

        // What the app now does at every exit from a drag, including the two that used to
        // fall through: end it. The next gesture starts from zero and can be released
        // cleanly.
        stale.endCharge()
        stale.beginCharge()
        frames(&stale, count: 21, dt: 1.0 / 60.0, from: 5)
        Check.ok(
            ThrowType.allCases.allSatisfy {
                !ThrowGesture.charge(for: $0).isOvercharged(hold: stale.hold)
            },
            "after the gesture is cancelled the next throw charges from zero again")

        // Same again through the path a backgrounding takes, which is the one SwiftUI
        // does not reliably follow with `onEnded` at all.
        var interrupted = FrameClock()
        interrupted.beginCharge()
        frames(&interrupted, count: 600, dt: 1.0 / 60.0, from: 0)
        interrupted.abandon()
        interrupted.beginCharge()
        frames(&interrupted, count: 21, dt: 1.0 / 60.0, from: 100)
        Check.ok(
            ThrowType.allCases.allSatisfy {
                !ThrowGesture.charge(for: $0).isOvercharged(hold: interrupted.hold)
            },
            "a charge interrupted by the app leaving the foreground does not tax the next throw")
    }

    // MARK: - the setup a match is played under

    /// Why the save has to be stamped with the setup the match was *played* under, and not
    /// with whatever the pre-game sheet was last showing.
    ///
    /// The sheet binds to its setup and writes every tap through live, and it can be
    /// opened from the scoreboard mid-point. Two engines built from a drifted setup are
    /// handed the same tape here, and they fail in the two different ways the player met:
    /// one is discarded, and — much worse — one is not.
    private static func aDriftedSetupCannotRestore() {
        let seed: UInt32 = 0xdead_beef
        let salt = "clockchecks"
        let dt = FrameClock.tickDt
        let ticks = 3600

        // The match as played: 3v3, to 5.
        var played = EngineConfig.default
        played.pointsToWin = 5
        let match = Engine(format: .minis, seed: seed, config: played)
        for _ in 0..<ticks { match.step(dt: dt) }

        let saved = SavedMatch(
            fingerprint: SimFingerprint.stamp(salt: salt),
            recording: Recording(
                seed: seed, field: RecordedField(match.fieldSpec), tickHz: FrameClock.tickHz,
                autoTeams: match.autoTeams.sorted(), durationTicks: ticks, inputs: []),
            checksum: MatchChecksum(match, tick: ticks),
            setup: nil)

        // FORMAT flicked to 7v7 and the sheet dismissed: the save claims 7v7, so the
        // resume builds a 7v7 engine to replay a 3v3 tape. It cannot land, and the whole
        // match is thrown away.
        do {
            _ = try MatchRestore.restore(
                saved, fingerprint: SimFingerprint.stamp(salt: salt),
                engine: Engine(format: .sevens, seed: seed, config: played))
            Check.ok(false, "a tape replayed into the wrong format is refused")
        } catch {
            Check.ok(true, "a tape replayed into the wrong format is refused — \(error)")
        }

        // The quiet one. Only the LENGTH changed, 5 → 7: the physics is identical until
        // somebody reaches 5, so the checksum matches, the restore succeeds, and the
        // player is put back into a game to 7 they never started. Nothing downstream can
        // catch this — which is why it has to be impossible upstream, and is: `saveMatch`
        // stamps `playedSetup`, written only by `restart` and `adopt`.
        var drifted = EngineConfig.default
        drifted.pointsToWin = 7
        do {
            let restored = try MatchRestore.restore(
                saved, fingerprint: SimFingerprint.stamp(salt: salt),
                engine: Engine(format: .minis, seed: seed, config: drifted))
            Check.eq(
                restored.config.pointsToWin, 7,
                "a length-drifted save restores SILENTLY into the wrong game — no check "
                    + "downstream of the setup can see this, so the setup must not drift")
        } catch {
            Check.ok(false, "the length-drifted restore was expected to succeed: \(error)")
        }

        // The same tape into the engine it was played on, which must still restore.
        do {
            let restored = try MatchRestore.restore(
                saved, fingerprint: SimFingerprint.stamp(salt: salt),
                engine: Engine(format: .minis, seed: seed, config: played))
            Check.eq(restored.score, match.score, "the setup it was played under restores")
        } catch {
            Check.ok(false, "the honest restore failed: \(error)")
        }
    }
}
