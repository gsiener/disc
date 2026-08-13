/// The tick-loop composition, lifted out of `MatchView.advance(to:)` — Phase 1 of
/// issue #16.
///
/// **What moved here and why.** `MatchView.advance` was the composition root of the
/// shipped simulation: it decided the `dt` sequence `Engine.step` ran under, which
/// `Replay.swift` establishes is part of the input, not an implementation detail. Being
/// a private method on a SwiftUI `View`, it was the one place the 2.2M-assertion
/// validation suite could not reach — the friction log
/// (`.agents/friction-log/20260809162502-no-launch-argument/`) records the cost: a
/// transcription of this exact loop caught a real bug in under a second and was thrown
/// away afterwards because it had nowhere to live. `TickLoopTests` in `SimChecks` is
/// that transcription done on purpose (Phase 0); this type is what it now points at.
///
/// **Decisions in, side effects out.** `MatchDirector` never plays a haptic, never
/// touches disk, never reads a clock outside the `FrameClock` it owns. `runTicks()`
/// returns a `FrameOutput` describing what happened — the events drained and who (if
/// anyone) just took control — and the caller (`MatchView`, or a headless SimChecks
/// driver) is the one that turns that into `Feel.play`, a `TurnoverFlash`, a save. That
/// is what makes this drivable with zero mocking: a terminal test asserts on the output
/// of a plain method call.
///
/// **What Phase 1 deliberately does not move.** Per the issue's phasing, this class owns
/// exactly "the tick loop, event drain, handoff detection, and `FrameClock` ownership."
/// It does *not* yet own:
/// - `bobPhase`, the synthetic fingers (`autoDefend`/`demoCut`/`saveCycle`), haptics
///   *playing* (only *deciding*, via the returned events), or disk save/load — all
///   still `MatchView`'s business, per the issue's Phase 1 scope.
/// - `MatchSession` (the six wall-clock countdowns and tap tallies) — Phase 2.
/// - `InputScript` (the synthetic fingers as data the director consumes rather than
///   the view dispatching) — Phase 3.
/// - `needsFrames` (the `TimelineView` quiescence seam) — Phase 4.
///
/// So `tap(at:)`/`defend(at:)`/`release(_:)`/`cancelCharge()` and `session` from the
/// issue's interface sketch are not implemented here: they are gesture intake and session
/// state that Phase 2/3 own, and stubbing them now with nothing behind them would be
/// scaffolding nobody asked for yet. `MatchView` still calls `match.humanDefend`/
/// `match.humanRelease` and drives `clock`'s charge directly, exactly as before — see
/// `match` and `clock` below, which exist so those ~100 other call sites do not have to
/// churn in this commit.
///
/// A plain, non-isolated class — not `@MainActor`-confined itself, same as `Engine`
/// today. `MatchView` confines it to the main actor by ownership (an `@State` reference,
/// same pattern `MatchScene` already uses for the same reason: SwiftUI does not observe
/// mutations through a class reference, so the view's `frame` counter is still what
/// drives the redraw).
public final class MatchDirector {

    /// The live match. Public and mutable — not merely set once at `init` — because
    /// `MatchView.restart`/`adopt` swap the whole engine out from under a running
    /// director (a restart is a new seed and a new `Engine`, a restore replays one from
    /// a recording). `MatchView.match` forwards straight through to this.
    public var match: Engine

    /// The wall clock — accounting only, no tick-loop opinions; see `FrameClock`.
    ///
    /// Exposed directly rather than wrapped, because `MatchView` already reaches into it
    /// outside the tick loop for the charge (`beginCharge`/`endCharge`/`hold`/
    /// `charging`, driven by `DragGesture.onChanged`/`onEnded`) and for `reset()` in
    /// `applyPerMatchReset`. Phase 1 does not change that boundary, only where the tick
    /// loop that also touches it lives.
    public var clock = FrameClock()

    /// Whole simulation ticks executed so far. Public and mutable for the same reason as
    /// `match`: `MatchView.saveMatch()` settles a pending tick by stepping the engine
    /// directly (not through `runTicks`), and `adopt` restores the count from a
    /// recording. Both bypass the tick loop by design — see their own documentation.
    public var tickCount = 0

    /// `MatchView`'s old `advance`-local `lastControlled`, moved: who had control at the
    /// end of the previous tick, so `runTicks` can notice a change. Private because
    /// nothing outside the tick loop needs it — `resetHandoffTracking()` is the seam a
    /// caller uses instead.
    private var lastControlled: Int

    static let tickDt = FrameClock.tickDt

    /// `MatchView.slowMoCooldown`, moved alongside the decision that reads it.
    static let slowMoCooldown = 8.0

    public init(match: Engine) {
        self.match = match
        self.lastControlled = match.controlled
    }

    /// Forgets the tick loop's own handoff tracking and re-arms it against the current
    /// `match.controlled`. Call after swapping in a new or restored engine (`restart`,
    /// `adopt`) so the first tick of a fresh match cannot report a spurious handoff
    /// carried over from the old one's final possession.
    public func resetHandoffTracking() {
        lastControlled = match.controlled
    }

    /// `MatchView.slowMo(for:)`, moved here unchanged: a decision, not a side effect, so
    /// it stays a pure function of the event and can be reasoned about — and measured —
    /// without a clock.
    ///
    /// **Time stops for a D you had to dive for, and for nothing else.**
    /// `docs/gameplay-design.md` §5 hands slow motion to every contested or laid-out catch
    /// and to every block — measured, that is 86 hitstops in a full 7v7 game, which reads
    /// as stuttering rather than emphatic. Narrowed to laid-out blocks/interceptions only,
    /// measured over five full 7v7 games (seeds 3, 19, 37, 41, 71), hitstops per game:
    ///
    /// | rule | per game |
    /// |---|---|
    /// | §5 as written | 86.2 |
    /// | + only catches in the red zone | 50.6 |
    /// | + only catches that score or land in the endzone | 25.0 |
    /// | laid-out D **and** laid-out scoring catch | 9.6 |
    /// | **laid-out D only (this)** | **3.2** |
    ///
    /// Two or three a game, the broadcast number. `slowMoCooldown` (8 s) trims a further
    /// 0.4 of the 3.2 for the case the rate never averages away — two blocks in the same
    /// scramble.
    static func slowMo(for event: MatchEvent) -> FrameClock.SlowMo? {
        guard case .turnover(let reason, _, _, _, let grade, _) = event else { return nil }
        switch reason {
        case .block, .interception:
            return grade == .layout ? FrameClock.SlowMo(scale: 0.35, timeLeft: 0.45) : nil
        default:
            return nil
        }
    }

    /// One rendered frame, start to finish: the stamp, the clamp, the tick loop, the
    /// fuses — `clock.beginFrame` + `runTicks()` + `clock.endFrame()`, or `clock.abandon()`
    /// when nobody is running the match this frame.
    ///
    /// This is the convenience a caller with nothing to sandwich in the middle wants —
    /// chiefly a headless SimChecks driver. `MatchView` does not call it: it has view-only
    /// work (`bobPhase`, the synthetic fingers, the save-cycle escape hatch) that sat
    /// between `clock.beginFrame` and the tick loop in the method this replaces, and that
    /// ordering is observable — a synthetic tap issued before this frame's ticks run
    /// takes effect a tick sooner than one issued after. So `MatchView` calls `clock`
    /// (above) and `runTicks()` (below) separately, in that same relative position,
    /// rather than going through this one call and shifting everything by a frame. See
    /// `runTicks`'s own comment.
    @discardableResult
    public func advance(to now: Double, running: Bool) -> FrameOutput {
        guard running else {
            clock.abandon()
            return FrameOutput(ticksRun: 0, events: [], handoffTo: nil, hitstopStarted: false)
        }
        guard clock.beginFrame(at: now) != nil else {
            return FrameOutput(ticksRun: 0, events: [], handoffTo: nil, hitstopStarted: false)
        }
        let output = runTicks()
        clock.endFrame()
        return output
    }

    /// The ticks one already-begun frame bought: `MatchView.advance`'s old `while
    /// clock.takeTick() { ... }`, moved verbatim. In order: step the engine by exactly
    /// `FrameClock.tickDt`, drain events *per tick* (never per frame — a catch-up burst
    /// must not be allowed to swallow one, same reasoning `Replay.swift` and
    /// `TickLoopTests` give), notice a hitstop-eligible event and defer the rest of the
    /// burst the instant one starts ("starting at the catch frame" — see
    /// `FrameClock.deferRemainingTicks`), and notice a handoff.
    ///
    /// Assumes `clock.beginFrame` already ran for this frame; call `advance(to:running:)`
    /// instead when that is not already true. Split out from it precisely so `MatchView`
    /// can sandwich its own bits in between, in the exact position they held before this
    /// method existed — see `advance`'s comment.
    ///
    /// `onTick` fires once per tick actually run, after `tickCount` is incremented and
    /// before that tick's events are drained — the same point `MatchView.recordTrail()`
    /// sampled the disc's flight from before this move. It exists only for that: trail
    /// sampling needs the intermediate tick count *inside* a catch-up burst (every fourth
    /// tick), not just the final one, and `MatchScene` — what it writes into — is a
    /// `FlightUI` type this module cannot depend on (ADR-0002/0008), so a callback is the
    /// boundary rather than a result the caller has to replay a loop over.
    @discardableResult
    public func runTicks(onTick: () -> Void = {}) -> FrameOutput {
        var events: [MatchEvent] = []
        var handoffTo: Int?
        var ticksRun = 0
        var hitstopStarted = false

        while clock.takeTick() {
            match.step(dt: Self.tickDt)
            tickCount &+= 1
            ticksRun &+= 1
            onTick()

            var slowed = false
            for event in match.drainEvents() {
                events.append(event)
                if let s = Self.slowMo(for: event), clock.canSlow(after: Self.slowMoCooldown) {
                    clock.slow(s)
                    slowed = true
                }
            }
            // Control moves on catches and on turnovers, both of which happen inside a
            // tick, so this is checked where they happen rather than once a frame.
            if match.controlled != lastControlled {
                lastControlled = match.controlled
                handoffTo = match.controlled
            }

            if slowed {
                clock.deferRemainingTicks()
                hitstopStarted = true
                break
            }
        }

        return FrameOutput(
            ticksRun: ticksRun, events: events, handoffTo: handoffTo,
            hitstopStarted: hitstopStarted)
    }
}

/// What one frame's tick loop decided, for the caller to apply.
///
/// Slimmer than the issue's interface sketch on purpose. The sketch's
/// `haptics: [Feel.Beat]` would require `UltimateSim` to depend on `FlightUI`'s `Feel`
/// type, inverting the dependency direction ADR-0002/0008 exists to fix — so this carries
/// the raw `[MatchEvent]` instead, and the caller derives `Feel.Beat`/`TurnoverFlash` from
/// them exactly as `MatchView.advance` did inline before. `saveRequested` is left out for
/// a similar reason: the save-cycle decision still needs `MatchView`'s own `cycled`
/// one-shot and `viewSize` (both view-only state Phase 2/3 have not lifted yet), so Phase
/// 1 leaves that call at the view rather than half-wiring a field nothing yet fills in.
public struct FrameOutput {
    /// Ticks actually run this frame. Zero when the frame was abandoned, measured
    /// nothing (the first frame, or the first back from a gap), or bought less than one
    /// tick's worth of wall time.
    public let ticksRun: Int

    /// Every event drained this frame, across every tick of a catch-up burst, in the
    /// order the simulation produced them.
    public let events: [MatchEvent]

    /// Non-nil when a handoff was noticed this frame: `match.controlled`'s value at the
    /// moment it last changed. Only the last matters within a frame, exactly as
    /// `MatchView.advance` only ever kept the last `Handoff(to:...)` it built inside a
    /// burst — earlier changes within the same frame are superseded, not lost (nothing
    /// downstream distinguished them before this move either).
    public let handoffTo: Int?

    /// Whether a hitstop actually started this frame — `clock.slow` was called and the
    /// burst was cut short for it — as opposed to merely containing an eligible event
    /// the cooldown refused. `clock.slowMo` alone cannot answer this after the fact: it
    /// stays non-nil for the hitstop's whole 0.35–0.45 s duration, spanning several
    /// frames, so a caller (chiefly a test) that wants to know "did one begin just now"
    /// needs the decision reported, not just the state it left behind.
    public let hitstopStarted: Bool
}
