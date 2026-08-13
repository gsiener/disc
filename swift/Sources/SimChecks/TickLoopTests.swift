import Foundation
import UltimateSim

/// Phase 0 of issue #16 ("Lift the tick loop out of the SwiftUI view"): characterize
/// `MatchView.advance(to:)` (`MatchView.swift:799-940`) *before* anything is extracted from
/// it, by driving an `Engine` + `FrameClock` pair through the same order of operations and
/// pinning what comes out.
///
/// **What this suite mirrors, and what it deliberately leaves out.** `advance` does two
/// kinds of work: the simulation-relevant composition (accumulate wall time into whole
/// ticks, step the engine, drain events per tick so a catch-up burst cannot swallow one,
/// notice a handoff, defer the rest of a burst when a hitstop starts) and the
/// SwiftUI-specific bits that sit beside it (`bobPhase`, `Feel.play` haptics, the synthetic
/// fingers `autoDefend`/`demoCut`/`saveCycle`, `MatchSave` to disk). The issue's plan is
/// explicit that only the first kind is this suite's business — the second kind stays
/// view-side through Phase 1, when `MatchDirector` is extracted for real. `TickLoopDriver`
/// below is therefore a transcription of `advance`'s tick-loop mechanics only, built fresh
/// here rather than by touching `MatchView.swift` (owned by peer work on #21/#22 at the
/// time of writing — see the issue's risk table).
///
/// **Why a transcription and not a reference to the view.** `SimChecks` cannot import
/// `FlightUI` (ADR-0002/0008 — dependency direction), and the friction log
/// (`.agents/friction-log/20260809162502-no-launch-argument/`) already proved the cost of
/// not having this: a hand transcription of the loop caught a real bug — 120 wasted
/// `Engine.step` calls a second behind the result card — in under a second, and was thrown
/// away afterwards because it had nowhere to live. This suite is that transcription, done
/// on purpose, kept, and pointed at real engines. Phase 1 deletes it and points these same
/// assertions at the extracted `MatchDirector` instead — that is the acceptance suite this
/// suite exists to become.
///
/// **This suite pins CURRENT behavior, warts included.** `resultCardIdleLoopKeepsTicking`
/// below is the friction log's bug, still present on `main`: nothing in `advance` sets
/// `running = false` when `match.isOver` goes true, so the tick loop keeps spending wall
/// time on `Engine.step` behind a result card nobody is looking at. Pinning it here is not
/// endorsing it — it is the point of Phase 0: the suite that proves later phases changed
/// nothing must first agree with what "nothing changed" currently *is*, bug included. Fixing
/// it is out of scope for this phase and would need its own issue.
enum TickLoopTests {

    static func run() throws {
        tickCountsUnderCatchUpBurst()
        eventDrainCompletenessAcrossCatchUpBurst()
        hitstopTickDropping()
        fullTimePausedIdling()
        resultCardIdleLoopKeepsTicking()
        slowMoBurstBoundary()
        pauseResumeGap()
        replayEquivalence()
    }

    // MARK: - the driver

    /// The tick-loop mechanics of `MatchView.advance(to:)`, and nothing else.
    ///
    /// Mirrors, in order: the `running == false` abandon path; `clock.beginFrame`; the
    /// `while clock.takeTick()` loop stepping `Engine` by exactly `FrameClock.tickDt`;
    /// per-tick event drain (never per-frame — see `Replay.swift` and `ClockTests` on why
    /// batching would be a different, wrong, composition); the same `slowMo(for:)`
    /// hitstop-eligibility rule `MatchView` uses, gated by the same cooldown; handoff
    /// detection on `match.controlled` changing; `deferRemainingTicks()` + `break` the
    /// instant a hitstop starts; `clock.endFrame()`.
    ///
    /// Left out on purpose: `bobPhase`, `Feel.play`, the synthetic fingers, disk save/load.
    /// None of those touch the simulation — see the file comment.
    final class TickLoopDriver {
        let match: Engine
        var clock = FrameClock()

        /// Ticks run across the whole driven sequence.
        private(set) var tickCount = 0
        /// Every event drained, in the order it was drained — across every tick of every
        /// frame, exactly as `advance`'s per-tick drain sees them.
        private(set) var drainedEvents: [MatchEvent] = []
        /// `advance`'s handoff detector: `match.controlled` changing mid-tick.
        private(set) var handoffCount = 0
        /// How many times a hitstop actually started (i.e. `clock.slow` was called and the
        /// burst was cut short for it) — not how many eligible events were seen, since the
        /// cooldown can refuse one.
        private(set) var hitstopsStarted = 0
        /// `frame &+= 1`, bumped once per call regardless of how many ticks ran — including
        /// the abandoned-frame and zero-tick cases. Nothing in the driver reads this; it
        /// exists because "rendering happens every frame regardless" is part of the
        /// contract `advance`'s own comment states, and a suite that never counted it could
        /// not tell a caller who broke that apart.
        private(set) var framesRendered = 0

        private var lastControlled: Int

        static let tickDt = FrameClock.tickDt
        /// `MatchView.slowMoCooldown`, restated here rather than imported — it is a private
        /// constant on a SwiftUI view.
        static let slowMoCooldown = 8.0

        init(match: Engine) {
            self.match = match
            self.lastControlled = match.controlled
        }

        /// `MatchView.slowMo(for:)`, restated. A layout block or interception starts a
        /// hitstop; nothing else does.
        private static func slowMoTrigger(for event: MatchEvent) -> FrameClock.SlowMo? {
            guard case .turnover(let reason, _, _, _, let grade, _) = event else { return nil }
            switch reason {
            case .block, .interception:
                return grade == .layout ? FrameClock.SlowMo(scale: 0.35, timeLeft: 0.45) : nil
            default:
                return nil
            }
        }

        /// One rendered frame. Returns the ticks that ran, so a scenario can assert on the
        /// per-frame count as well as the running total.
        @discardableResult
        func advance(to now: Double, running: Bool) -> Int {
            defer { framesRendered &+= 1 }
            guard running else {
                clock.abandon()
                return 0
            }
            guard clock.beginFrame(at: now) != nil else { return 0 }

            var ticksThisFrame = 0
            while clock.takeTick() {
                match.step(dt: Self.tickDt)
                tickCount &+= 1
                ticksThisFrame &+= 1

                var slowed = false
                for event in match.drainEvents() {
                    drainedEvents.append(event)
                    if let s = Self.slowMoTrigger(for: event),
                        clock.canSlow(after: Self.slowMoCooldown)
                    {
                        clock.slow(s)
                        slowed = true
                    }
                }
                if match.controlled != lastControlled {
                    lastControlled = match.controlled
                    handoffCount &+= 1
                }
                if slowed {
                    hitstopsStarted &+= 1
                    clock.deferRemainingTicks()
                    break
                }
            }
            clock.endFrame()
            return ticksThisFrame
        }
    }

    /// Steadily advances `d` at exactly `tickDt` per frame, incrementing `now` by exactly
    /// `tickDt` each call, until it has run at least `target` ticks.
    ///
    /// **Why this lands on `target` exactly, and a fixed-count `for` loop over raw
    /// `Double(i) * tickDt` timestamps does not.** `TickLoopDriver.advance` drains its
    /// accumulator fully every call (`while clock.takeTick()`), so the leftover after any
    /// steady frame is always under one `tickDt` — which means a steady frame can never buy
    /// more than one tick, and `tickCount` can only step up by 0 or 1 per call. A `while
    /// d.tickCount < target` loop therefore cannot skip past `target`; it must land on it.
    /// A `for i in 1...N` loop computing each timestamp independently as `Double(i) *
    /// tickDt` has no such guarantee: the *count* of ticks bought by frame `N` depends on
    /// where the accumulator's fractional remainder happens to sit relative to the tick
    /// boundary, and that remainder is one ULP-scale floating rounding away from tipping
    /// the very last frame either into or out of a tick — which is exactly what turned
    /// "steady frames land five ticks short" into an off-by-one on a 7,446-frame approach
    /// the first time this file was written. `ClockTests.fixedStepAndClamp` hits the same
    /// thing over its own long steady runs and answers it with `Check.inRange`; this
    /// answers it by removing the ambiguity at the source instead.
    private static func runSteady(_ d: TickLoopDriver, to target: Int, now: inout Double) {
        while d.tickCount < target {
            now += TickLoopDriver.tickDt
            d.advance(to: now, running: true)
        }
    }

    // MARK: - tick counts under a catch-up burst

    /// A hitch (a frame that arrives very late), then a big frame: the composition's tick
    /// count must land exactly where `FrameClock`'s own clamp says it will, with real
    /// `Engine.step` calls behind every one of them — not just with the accounting
    /// `ClockTests` already proves in isolation.
    private static func tickCountsUnderCatchUpBurst() {
        let d = TickLoopDriver(match: Engine(format: .minis, seed: 101))
        d.match.autoTeams = [0, 1]

        // Establish the stamp.
        var now = 0.0
        Check.eq(d.advance(to: now, running: true), 0, "the first frame measures nothing")

        // A steady run for two seconds at 120 Hz — one tick a frame, forever.
        runSteady(d, to: 240, now: &now)
        Check.eq(d.tickCount, 240, "a steady 120 Hz stream buys one tick a frame")

        // The hitch: five real seconds pass in one frame. The clamp caps it at
        // `FrameClock.maxTicksPerFrame`, same as `ClockTests.fixedStepAndClamp`, now with
        // the engine actually stepping behind each one.
        now += 5
        let hitchTicks = d.advance(to: now, running: true)
        Check.eq(
            hitchTicks, FrameClock.maxTicksPerFrame,
            "a five-second hitch buys the clamp's ticks and not one more, with the engine "
                + "actually stepping behind each of them")
        Check.eq(
            d.tickCount, 240 + FrameClock.maxTicksPerFrame,
            "the running total is the steady ticks plus exactly the clamped burst")

        // And the very next frame does not inherit the dropped debt — the hitch cannot
        // cause the next frame to hitch too.
        now += TickLoopDriver.tickDt
        let nextTicks = d.advance(to: now, running: true)
        Check.ok(
            nextTicks <= 1,
            "the frame right after a clamped hitch buys at most one tick, not a second burst")
    }

    // MARK: - event-drain completeness across a catch-up burst

    /// Nothing dropped between frames. Draining per tick rather than per frame is what
    /// `advance`'s own comment names as the fix for "the old counter diffing" swallowing an
    /// event when two landed between snapshots — this proves the per-tick drain survives a
    /// catch-up burst that groups many ticks into one frame, by comparing it against the
    /// same match driven one tick at a time.
    private static func eventDrainCompletenessAcrossCatchUpBurst() {
        let seed: UInt32 = 202
        let ticks = 600

        // Reference: every tick its own frame, drained every tick — nothing to batch, so
        // nothing to swallow.
        let reference = Engine(format: .minis, seed: seed)
        reference.autoTeams = [0, 1]
        var referenceEvents: [MatchEvent] = []
        for _ in 0..<ticks {
            reference.step(dt: TickLoopDriver.tickDt)
            referenceEvents.append(contentsOf: reference.drainEvents())
        }

        // Subject: the identical match, driven through jittery, irregular frame times —
        // some frames buy zero ticks, some buy a burst of several — via the driver's
        // per-tick drain inside the burst.
        let subject = TickLoopDriver(match: Engine(format: .minis, seed: seed))
        subject.match.autoTeams = [0, 1]
        var now = 0.0
        subject.advance(to: now, running: true)  // establish the stamp
        var ranSoFar = 0
        // A jitter pattern that sums to more than `ticks` worth of wall time so the whole
        // reference run is covered: alternate a near-zero frame (buys nothing) with a
        // multi-tick burst.
        let jitterFrames: [Double] = [0.001, 6 * TickLoopDriver.tickDt, 0.0005, 11 * TickLoopDriver.tickDt]
        var jitterIndex = 0
        while ranSoFar < ticks {
            now += jitterFrames[jitterIndex % jitterFrames.count]
            jitterIndex += 1
            ranSoFar += subject.advance(to: now, running: true)
        }

        // The subject may have run a handful more ticks than the reference (its last burst
        // can overshoot `ticks`), so only the reference's own count is asked to be a
        // prefix — nothing about the property this checks depends on trimming exactly.
        let subjectPrefix = Array(subject.drainedEvents.prefix(referenceEvents.count))
        Check.eq(
            subjectPrefix.count, referenceEvents.count,
            "the burst-driven run drained at least as many events as the tick-by-tick "
                + "reference over the same span")
        Check.ok(
            subjectPrefix == referenceEvents,
            "and every one of them, in the same order — a catch-up burst that groups many "
                + "ticks into one frame drops nothing and reorders nothing, because the "
                + "drain happens per tick and not per frame")
    }

    // MARK: - hitstop tick-dropping

    /// `deferRemainingTicks`'s contract, exercised through the real loop and a real hitstop
    /// rather than asserted on the clock alone (`ClockTests` already covers the clock in
    /// isolation): "starting at the catch frame" — when a burst owed several ticks and one
    /// of them is the layout grab, the rest of the burst must not be spent in the same
    /// frame the screen has not yet drawn the grab on. At most one tick of the leftover
    /// debt is carried to the next frame; the rest is dropped.
    private static func hitstopTickDropping() {
        // Find a real layout block/interception naturally, tick by tick, so the tick index
        // it lands on is known and the scenario below can put a burst around it. Several
        // seeds, both sides throwing, is what `EngineSeamTests` does to reach a rare
        // in-match event — the same technique is used here.
        guard let (seed, eventTick) = findLayoutTurnover() else {
            Check.ok(
                false,
                "hitstop tick-dropping: no layout block/interception found across the seed "
                    + "sweep — cannot exercise deferRemainingTicks against a real hitstop")
            return
        }

        // Rebuild fresh and drive it: steady one-tick frames until a handful of ticks short
        // of the event (`runSteady`'s while-loop stopping condition lands on that target
        // exactly — see its own comment for why raw per-frame arithmetic cannot be trusted
        // to), then one hitching frame that buys far more than the remaining debt, so the
        // hitstop — not the clamp — is what ends the burst.
        let d = TickLoopDriver(match: Engine(format: .minis, seed: seed))
        d.match.autoTeams = [0, 1]
        var now = 0.0
        d.advance(to: now, running: true)

        let approachTarget = max(eventTick - 5, 0)
        runSteady(d, to: approachTarget, now: &now)
        Check.eq(
            d.tickCount, approachTarget,
            "s\(seed): steady frames land exactly on the approach target short of the "
                + "layout event")
        let offset = eventTick - d.tickCount
        Check.ok(
            offset > 0 && offset <= 5,
            "s\(seed): the approach left a small, known amount of debt for the hitch to "
                + "cover (\(offset) ticks)")

        let hitstopsBefore = d.hitstopsStarted
        // Comfortably more than `offset` ticks' worth of wall time, and comfortably under
        // the clamp, so the hitstop — not `maxTicksPerFrame` — is what ends the burst.
        now += Double(offset + 10) * TickLoopDriver.tickDt
        let burstTicks = d.advance(to: now, running: true)

        Check.eq(
            d.hitstopsStarted, hitstopsBefore + 1,
            "s\(seed): the hitch's burst reached the layout event and started a hitstop")
        Check.eq(
            burstTicks, offset,
            "s\(seed): the burst stopped at the tick that scored the block — the other "
                + "\(10) ticks the hitch would otherwise have bought are not spent in this "
                + "frame")
        Check.ok(
            d.clock.accumulator <= FrameClock.tickDt + 1e-9,
            "s\(seed): at most one tick of the dropped debt survives to the next frame")

        // And the next frame proves it was dropped, not merely postponed: it buys at most
        // one more tick, not the ten that were owed.
        now += TickLoopDriver.tickDt
        let nextTicks = d.advance(to: now, running: true)
        Check.ok(
            nextTicks <= 1,
            "s\(seed): the frame after the hitstop buys at most one tick — the rest of the "
                + "burst is gone, not carried forward (got \(nextTicks))")
    }

    /// Drives fresh engines across a handful of seeds, tick by tick, looking for the first
    /// `.turnover` event with `grade == .layout` — the one thing that starts a hitstop.
    /// Returns the seed and the 1-based tick count at which it drained.
    private static func findLayoutTurnover() -> (seed: UInt32, tick: Int)? {
        for seed: UInt32 in [11, 23, 37, 53, 71, 89, 103, 127] {
            let e = Engine(format: .minis, seed: seed)
            e.autoTeams = [0, 1]
            var tick = 0
            for _ in 0..<(120 * 300) {
                e.step(dt: TickLoopDriver.tickDt)
                tick += 1
                for event in e.drainEvents() {
                    if case .turnover(_, _, _, _, .layout, _) = event {
                        return (seed, tick)
                    }
                }
                if e.isOver { break }
            }
        }
        return nil
    }

    // MARK: - full-time / paused idling

    /// The `running == false` path: paused, backgrounded, on a tab nobody is looking at, or
    /// over. `clock.abandon()` runs, `frame` still bumps (rendering happens every frame
    /// regardless), and — the property this exists to pin — the engine never steps and the
    /// tick count never moves, no matter how much wall time or how many "frames" pass while
    /// `running` is false.
    private static func fullTimePausedIdling() {
        let d = TickLoopDriver(match: Engine(format: .minis, seed: 303))
        d.match.autoTeams = [0, 1]
        d.advance(to: 0, running: true)
        d.advance(to: 1, running: true)
        let tickCountBeforePause = d.tickCount

        for i in 0..<600 {
            let ran = d.advance(to: 1 + Double(i) * 0.05, running: false)
            Check.eq(ran, 0, "paused frame \(i) runs zero ticks")
        }
        Check.eq(
            d.tickCount, tickCountBeforePause,
            "thirty seconds of paused wall time moves the tick count by exactly nothing")
        Check.eq(
            d.framesRendered, 2 + 600,
            "every paused frame still bumps the render frame — a paused pitch is a "
                + "picture, not a black screen")

        // Resuming does not repay the paused span: the first frame back measures nothing
        // (no stamp to measure from), and normal cadence resumes from there.
        let firstBack = d.advance(to: 1 + 600 * 0.05, running: true)
        Check.eq(firstBack, 0, "the first frame back from a pause measures nothing")
        let secondBack = d.advance(to: 1 + 600 * 0.05 + TickLoopDriver.tickDt, running: true)
        Check.ok(
            secondBack <= 1,
            "and the frame after that buys at most one tick — the paused span was never owed")
    }

    // MARK: - result-card idle loop (the friction log's bug)

    /// `.agents/friction-log/20260809162502-no-launch-argument/friction.md`: fixing a bug
    /// in the result-card state needed an on-device observation of `match.isOver == true`,
    /// because nothing short of playing a whole game reaches it — and the bug it was
    /// chasing is pinned here. `advance` clears the save once `match.isOver` flips, but
    /// nothing in it sets `running = false`; `running` is a `MatchView` `@State` the result
    /// card's own view code is responsible for flipping, and at the time of writing nothing
    /// does. So a match that has finished, with the app still in the foreground and the
    /// result card on screen, keeps buying and spending ticks — the friction log measured
    /// 120 wasted `Engine.step` calls a second.
    ///
    /// **This is pinned as current behavior, not endorsed.** Phase 0 is a suite that agrees
    /// with `main`, bug included, precisely so a later phase's "nothing changed" has
    /// something honest to compare against. Fixing it is a different issue.
    private static func resultCardIdleLoopKeepsTicking() {
        // `target: 1` reaches `isOver` fast without a long match — the same shortcut the
        // friction log asked for as a launch argument and never got.
        let d = TickLoopDriver(match: Engine(format: .minis, target: 1, seed: 404))
        d.match.autoTeams = [0, 1]
        d.advance(to: 0, running: true)

        var now = 0.0
        var becameOverAt: Int?
        for i in 1...(120 * 120) {
            now = Double(i) * TickLoopDriver.tickDt
            d.advance(to: now, running: true)
            if d.match.isOver, becameOverAt == nil { becameOverAt = i }
        }
        guard let becameOverAt else {
            Check.ok(false, "result-card idle loop: the match never reached full time")
            return
        }
        let ticksAtFullTime = d.tickCount

        // Full time reached with `running` never flipped false — the exact state the
        // result card is shown in today. A further two seconds of frames at 120 Hz still
        // buys ticks: the loop has no notion that the game is over.
        for i in 1...240 {
            now += TickLoopDriver.tickDt
            d.advance(to: now, running: true)
            _ = i
        }
        Check.ok(
            d.tickCount > ticksAtFullTime,
            "current behavior: with `running` still true, ticks keep running behind a "
                + "finished match — full time was reached at tick \(becameOverAt) with "
                + "\(ticksAtFullTime) ticks run, and \(d.tickCount - ticksAtFullTime) more "
                + "ran in the next two seconds nobody was watching")
        // Within a tick of 240: exact equality would be asserting the floating-point
        // remainder of a 14,640-frame steady run (see `runSteady`'s comment on why that
        // remainder is not something a raw per-frame timestamp loop controls), not the
        // behavior. The behavior is "the full, undamped rate — 120 Hz, not throttled at
        // all", which is the shape of the friction log's "120 wasted Engine.step calls a
        // second", and a one-tick window still says that plainly.
        Check.inRange(
            Double(d.tickCount - ticksAtFullTime), 239, 240,
            "and it runs at the full, undamped rate — 120 Hz, not throttled at all")
    }

    // MARK: - slow-mo burst boundary

    /// A hitstop that starts *inside* a hitching frame, rather than on a steady one. Two
    /// things have to both be true at once: the burst breaks at the tick that started it
    /// (already pinned by `hitstopTickDropping`), and the fuse the hitstop burns down on
    /// (`slowMo.timeLeft`) is charged the frame's own clamped `frameDt` — not the raw,
    /// unclamped wall-clock gap that produced the burst. A hitstop that started on the far
    /// side of a 4-second hitch and then burned down by 4 real seconds in one `endFrame`
    /// would be over before the player saw it; burning down by the clamped `frameDt`
    /// instead is what keeps the effect's length independent of how late the frame that
    /// found it arrived.
    private static func slowMoBurstBoundary() {
        guard let (seed, eventTick) = findLayoutTurnover() else {
            Check.ok(false, "slow-mo burst boundary: no layout event found across the sweep")
            return
        }

        let d = TickLoopDriver(match: Engine(format: .minis, seed: seed))
        d.match.autoTeams = [0, 1]
        var now = 0.0
        d.advance(to: now, running: true)

        // Steady frames to one tick short of the event, then a 4-second hitch that reaches
        // it — the hitstop starts on a frame whose own wall-clock gap vastly exceeds the
        // 0.25 s clamp.
        let target = max(eventTick - 1, 0)
        runSteady(d, to: target, now: &now)
        Check.eq(
            d.tickCount, target,
            "s\(seed): steady frames land exactly one tick short of the layout event")

        now += 4.0
        d.advance(to: now, running: true)
        Check.eq(
            d.hitstopsStarted, 1, "s\(seed): the 4-second hitch's burst reached the event "
                + "and started exactly one hitstop")
        guard let slowMo = d.clock.slowMo else {
            Check.ok(false, "s\(seed): a hitstop was reported started but the clock carries none")
            return
        }
        // `FrameClock.beginFrame` clamps `frameDt` at `maxAccumulated` (0.25 s); `endFrame`
        // burns the fuse down by exactly that, not by the 4 s the wall clock actually saw.
        Check.near(
            slowMo.timeLeft, 0.45 - FrameClock.maxAccumulated, 1e-9,
            "s\(seed): the fuse is burned by the frame's clamped duration, not the raw "
                + "4 s wall-clock gap that produced the burst")
        Check.ok(
            slowMo.timeLeft > 0.45 - 4.0,
            "s\(seed): in particular it is NOT burned by the full hitch — that would end "
                + "the hitstop before the next frame ever draws it")
    }

    // MARK: - pause -> resume gap

    /// A shorter, more ordinary version of `fullTimePausedIdling`: one tap to pause, a
    /// realistic gap (a coach card, a menu, a phone call under thirty seconds), one tap to
    /// resume. The point is the boundary frames specifically — the last frame before the
    /// pause, the first frame after resume, and the one after that — which is where a
    /// stamp reused across the gap would show up as a burst of catch-up ticks.
    private static func pauseResumeGap() {
        let d = TickLoopDriver(match: Engine(format: .minis, seed: 505))
        d.match.autoTeams = [0, 1]
        var now = 0.0
        d.advance(to: now, running: true)
        runSteady(d, to: 120, now: &now)
        let tickCountAtPause = d.tickCount
        Check.eq(tickCountAtPause, 120, "steady frames land exactly on 120 ticks before the pause")

        // Paused for 12 s of wall time, expressed as a handful of frames the way a
        // `TimelineView` still bumping under a menu would produce them.
        let pauseStart = now
        for i in 0..<10 {
            let ran = d.advance(to: pauseStart + Double(i) * 1.2, running: false)
            Check.eq(ran, 0, "pause frame \(i) runs no ticks")
        }
        Check.eq(
            d.tickCount, tickCountAtPause, "the pause itself moved the tick count by nothing")

        // Resume. The first frame back measures nothing (no stamp survived the abandon).
        let resumeAt = pauseStart + 12.0
        let firstBack = d.advance(to: resumeAt, running: true)
        Check.eq(firstBack, 0, "the first frame after resume measures nothing")

        // A handful of steady frames right after: no lingering catch-up means their total
        // lands within a tick of what that much real time buys under ordinary play —
        // stated as a range rather than a hard per-frame count, because a boundary frame
        // landing a rounding error either side of a tick threshold is exactly the
        // floating-point noise `ClockTests.fixedStepAndClamp` tolerates over its own long
        // steady runs, and asserting a single frame's exact count here would be asserting
        // that noise rather than the behavior.
        var resumeNow = resumeAt
        var postResumeTicks = 0
        for _ in 0..<5 {
            resumeNow += TickLoopDriver.tickDt
            postResumeTicks += d.advance(to: resumeNow, running: true)
        }
        Check.inRange(
            Double(postResumeTicks), 4, 5,
            "the five frames right after resume buy about five ticks total between them — "
                + "not a burst of the 12 s the gap was worth, and not a stall either")
    }

    // MARK: - replay equivalence: director-style driving vs a raw Engine.step loop

    /// The "no goldens move" tripwire the issue's plan calls for, proved now rather than
    /// merely asserted later: a director-style driven sequence (irregular frame times,
    /// per-tick draining, the whole `TickLoopDriver` composition above) and a raw
    /// `Engine.step` loop, same seed, must land on a bit-identical box score. `Replay.swift`
    /// establishes why this can even be true — `Engine.step` only ever sees `tickDt`, at
    /// every rate, so nothing about *how* the ticks were grouped into frames can reach the
    /// simulation. This is that claim, checked rather than trusted, and it is the check
    /// Phase 1's extraction has to keep passing.
    private static func replayEquivalence() {
        for seed: UInt32 in [7, 13, 29] {
            let plainTicks = 900

            let plain = Engine(format: .minis, seed: seed)
            plain.autoTeams = [0, 1]
            for _ in 0..<plainTicks { plain.step(dt: TickLoopDriver.tickDt) }

            let d = TickLoopDriver(match: Engine(format: .minis, seed: seed))
            d.match.autoTeams = [0, 1]
            d.advance(to: 0, running: true)
            var now = 0.0
            // Deliberately irregular: a jitter pattern of frame gaps, none of them 1/120 s,
            // that nonetheless sums to exactly `plainTicks` worth of simulation time so the
            // two runs cover the identical span.
            let pattern: [Double] = [
                0.9 * TickLoopDriver.tickDt, 1.4 * TickLoopDriver.tickDt,
                0.2 * TickLoopDriver.tickDt, 3.5 * TickLoopDriver.tickDt,
            ]
            var patternIndex = 0
            while d.tickCount < plainTicks {
                now += pattern[patternIndex % pattern.count]
                patternIndex += 1
                d.advance(to: now, running: true)
            }
            // The driver may have run a few ticks past `plainTicks` on its last burst;
            // trim by continuing the *plain* loop to match exactly, so both snapshots are
            // taken at the identical tick count. Extra ticks on either side would compare
            // two different matches and call it a divergence.
            let extra = plain
            if d.tickCount > plainTicks {
                for _ in 0..<(d.tickCount - plainTicks) { extra.step(dt: TickLoopDriver.tickDt) }
            }
            let referenceSnapshot = MatchSnapshot(extra)
            let directorSnapshot = MatchSnapshot(d.match)

            if let diff = directorSnapshot.firstDifference(from: referenceSnapshot) {
                Check.ok(
                    false,
                    "s\(seed): director-driven and raw-loop matches diverged at tick "
                        + "\(d.tickCount) — \(diff)")
            } else {
                Check.ok(
                    true,
                    "s\(seed): \(d.tickCount) ticks under a jittery, catch-up-burst frame "
                        + "schedule land on the identical box score a plain tick-by-tick "
                        + "loop produces — the frame grouping is invisible to the "
                        + "simulation, exactly as `Replay.swift` claims")
            }
        }
    }
}
