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

    /// The active synthetic-finger configuration — issue #16 Phase 3. `.none` (the
    /// default) reproduces every non-launch-argument run exactly: every field in
    /// `syntheticInputs()`'s result is the "off" value, so a caller that never sets this
    /// sees no behavior change from before this type existed.
    public var script: InputScript

    /// Whether the save-cycle threshold has already fired once. `MatchView`'s old
    /// `cycled` flag, moved here unchanged: a one-shot for the lifetime of the director,
    /// never reset by `restart`/`adopt` (neither reset the view's `@State private var
    /// cycled` either — both replace `match` in place and keep the same director/view
    /// alive), so a script that names a save cycle fires it exactly once per launch.
    private var saveCycled = false

    public init(match: Engine, script: InputScript = .none) {
        self.match = match
        self.lastControlled = match.controlled
        self.script = script
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

    /// The synthetic-finger decisions for one frame — issue #16 Phase 3.
    ///
    /// **What moved here and why.** `autoDefend`/`demoCut`/`saveCycle` used to be three
    /// `if` blocks inline in `MatchView.advance(to:)`, each guarding a call the view made
    /// itself. Per the issue's Phase 3 split, the *timing decision* of each — is there
    /// currently no defensive commit, can a cut currently be called, has the tick
    /// threshold now been crossed — is simulation-state arithmetic the director already
    /// has everything it needs for, so it moves here. What does **not** move is the
    /// *execution*: `defend(at:)`/`callCut(at:in:)` update `MatchSession`, play a haptic
    /// via `Feel`, and record a `RecordedInput` — all `FlightUI`-only state this module
    /// cannot see (ADR-0002/0008) — and the save/restore round trip is disk I/O, ruled
    /// out by the same "decisions in, side effects out" rule `FrameOutput` already
    /// follows for events and handoffs. So the caller still calls those; this only says
    /// whether to.
    ///
    /// **Called once per frame, before that frame's ticks run** — the same relative
    /// position the three `if` blocks held in `MatchView.advance` (between
    /// `clock.beginFrame` and `runTicks()`), because that ordering is observable: a
    /// synthetic action taken before this frame's ticks run takes effect a tick sooner
    /// than one taken after. All three fields read `match`/`tickCount` as they stand at
    /// the moment of the call — none of `defendRequested`, `cutRequested`, or
    /// `saveCycleReached` depends on the others, so evaluating them together here is
    /// equivalent to the original sequential checks (verified in
    /// `InputScriptTests`/`TickLoopTests`).
    ///
    /// **Not a field on `FrameOutput`.** `FrameOutput` is what `runTicks()` returns after
    /// ticks actually ran; the save-cycle boundary, in particular, is checked *before*
    /// deciding whether to run any ticks at all this frame (a triggered save skips the
    /// tick loop entirely, exactly as `MatchView.advance` used to `return` before
    /// reaching it) — so it cannot be reported by the same call that runs the ticks. A
    /// separate result, read first, is what the actual data dependency is.
    public func syntheticInputs() -> SyntheticFrame {
        let defendRequested = script.autoDefend && match.defensiveCommit == nil

        let cutRequested: NormalizedPoint?
        if let target = script.demoCut, match.canCallCut {
            cutRequested = target
        } else {
            cutRequested = nil
        }

        var saveCycleReached = false
        if let after = script.saveCycleAfter, !saveCycled,
            Double(tickCount) * Self.tickDt >= after
        {
            saveCycled = true
            saveCycleReached = true
        }

        return SyntheticFrame(
            defendRequested: defendRequested, cutRequested: cutRequested,
            saveCycleReached: saveCycleReached)
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

    /// The quiescence seam `TimelineView` pauses on — issue #16 Phase 4.
    ///
    /// **Why this takes `running` rather than deriving it alone.** `MatchView.running`
    /// folds in state this class cannot see and should not try to — `scenePhase`,
    /// `paused`, the setup/coach sheets, `restoring` — all `MatchView`-only `@State`. The
    /// director does not reconstruct that; the caller passes the same `running` it already
    /// computes for `advance(to:running:)`, at the same call site, for the same reason: see
    /// that method's own comment.
    ///
    /// **Not simply `running`, on purpose, even though the two never diverge today.** Once
    /// `!running` reaches `advance(to:running:)`, `clock.abandon()` cancels slow motion and
    /// empties the accumulator in the same call — so by the time `running` is false, there
    /// is never anything left pending regardless. But that is a guarantee `advance`'s
    /// ordering happens to provide, not one this method should assume: a caller that reads
    /// `needsFrames` before it has called `advance` this frame (exactly what `body` does,
    /// since `TimelineView`'s pause has to be decided before the frame it would gate)
    /// deserves an answer that checks the clock's actual state rather than trusting a
    /// side effect elsewhere to have already run. Checking `clock.slowMo` and
    /// `clock.accumulator` directly is what keeps a hitstop or a still-draining catch-up
    /// burst from going dark if `abandon()`'s timing ever changes.
    ///
    /// **Never false during a hitstop.** `running` stays true for the whole match while a
    /// hitstop plays — nothing about slow motion pauses, backgrounds, or ends the match —
    /// so the `running ||` half alone already covers it; `clock.slowMo != nil` only matters
    /// for the theoretical case where a caller checks between an abandonment and its
    /// effects landing.
    public func needsFrames(running: Bool) -> Bool {
        running || clock.slowMo != nil || clock.accumulator >= Self.tickDt
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

/// A point in the unit square — screen-fraction coordinates (0...1 on each axis),
/// independent of any concrete view size.
///
/// `LaunchOptions.demoCut` is already in this space: `LaunchOptions.parseCut` rejects
/// anything outside `[0, 1]` on either axis. So `MatchDirector` can consume it directly
/// without depending on `viewSize` — a view-metric quantity this module has no business
/// knowing about (ADR-0002/0008); only the eventual unit-square→screen→ground
/// conversion (`viewSize`, then `MatchScene.groundPoint`'s camera projection) stays with
/// the caller, because that really is view-metric work `UltimateSim` cannot do.
///
/// Deliberately not `CGPoint`: this module otherwise has no reason to import
/// `CoreGraphics`, and not `Vec2d`: that name already means a ground-plane XZ pair
/// elsewhere in this module (metres on the pitch, not fractions of a screen), and
/// reusing it here would invite exactly the mixup a distinct type exists to rule out.
public struct NormalizedPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// The active synthetic-finger configuration for a `MatchDirector` — issue #16 Phase 3.
///
/// Parsing stays at the app boundary (`ProbeContract.LaunchOptions`, already true per
/// #21); this is the typed value that boundary's three fields (`autoDefend`, `demoCut`,
/// `saveCycle`) become once they cross into the sim. `.none`, the default, reproduces
/// every non-launch-argument run exactly — every check `syntheticInputs()` makes against
/// it is false or nil, so a `MatchDirector` nobody hands a script behaves exactly as one
/// predating this type.
public struct InputScript: Equatable, Sendable {
    /// Mirrors `LaunchOptions.autoDefend`. See `MatchDirector.syntheticInputs()`.
    public var autoDefend: Bool

    /// Mirrors `LaunchOptions.demoCut` — already a unit-square point, so no conversion
    /// happens crossing this boundary. See `NormalizedPoint`.
    public var demoCut: NormalizedPoint?

    /// Mirrors `LaunchOptions.saveCycle`: seconds of *simulated* play
    /// (`tickCount * MatchDirector.tickDt`), not wall time, after which the save-cycle
    /// boundary is reported once. See `MatchDirector.syntheticInputs()`.
    public var saveCycleAfter: Double?

    public static let none = InputScript()

    public init(
        autoDefend: Bool = false, demoCut: NormalizedPoint? = nil,
        saveCycleAfter: Double? = nil
    ) {
        self.autoDefend = autoDefend
        self.demoCut = demoCut
        self.saveCycleAfter = saveCycleAfter
    }
}

/// What `MatchDirector.syntheticInputs()` decided for one frame, before that frame's
/// ticks run. See that method's doc comment for the full reasoning; in short, these are
/// *decisions* — the caller (a view, or a headless test) still performs the
/// corresponding *action* (`defend(at:)`, `callCut(at:in:)`, the save/restore round
/// trip), because each of those touches state (`MatchSession`, `Feel`, disk) this module
/// does not and should not depend on.
public struct SyntheticFrame {
    /// True when `InputScript.autoDefend` is on and `match.defensiveCommit == nil` right
    /// now — mirrors `MatchView`'s old `if autoDefend, match.defensiveCommit == nil`.
    /// The point a defensive tap lands on is irrelevant to whether it fires (the engine
    /// picks the defender by time-to-reach, not by the tap's own position) — see
    /// `MatchView.defend(at:)` — so unlike `cutRequested` there is nothing to carry here
    /// beyond the yes/no.
    public let defendRequested: Bool

    /// `InputScript.demoCut`, unchanged, when the script has one **and**
    /// `match.canCallCut` is true right now — mirrors `MatchView`'s old `if let u =
    /// demoCut, viewSize != .zero, match.canCallCut`, minus the `viewSize != .zero`
    /// half, which stays the caller's own gate (see `NormalizedPoint`'s doc comment for
    /// why). Nil whenever the script has no cut configured or the engine will not
    /// currently accept one.
    public let cutRequested: NormalizedPoint?

    /// True exactly once, the frame `tickCount * MatchDirector.tickDt` first reaches
    /// `InputScript.saveCycleAfter`. One-shot per director instance — see
    /// `MatchDirector.saveCycled`. The caller is responsible for the save/restore round
    /// trip itself (`MatchSave`, disk I/O — `MatchView.saveMatch()`/`resume(_:)`) and,
    /// per the original behavior this mirrors, for skipping this frame's tick loop
    /// entirely when this is true rather than running ticks and then saving.
    public let saveCycleReached: Bool
}
