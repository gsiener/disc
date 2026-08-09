/// The wall clock the renderer lives on, and the only thing that decides how much of it
/// the simulation is asked to spend.
///
/// **Why this is a value type in the sim package rather than six `@State` properties in
/// the view.** `Replay.swift` establishes that a match is a pure function of
/// `(format, seed, inputs)` and that `Engine.step` is not associative in `dt` — so the
/// shipped game must advance in whole 1/120 s ticks, and the *only* freedom the renderer
/// has is how many of them a frame buys. That freedom has real invariants:
///
///   - **the clamp** — a hitch, a debugger pause or a spell in the background yields at
///     most `maxAccumulated` of catch-up and the rest is dropped, so a slow frame can
///     never demand enough ticks to cause the next slow frame;
///   - **abandonment** — time that passed while nobody was looking is not owed to the
///     simulation at all, and neither is the frame stamp it was measured from;
///   - **slow motion** — it scales the wall time paid *in*, never the tick paid *out*,
///     and it burns down in real seconds rather than slowed ones;
///   - **the charge** — the throw's hold runs on the frame clock, because
///     `DragGesture.onChanged` only fires when the finger moves, and it must not survive
///     a gap in which the thumb was never lifted.
///
/// Every one of those was previously expressed as arithmetic in one 2000-line SwiftUI
/// view, where nothing could reach it: a suite of two million assertions had nothing to
/// say about any of them, and four shipped bugs lived in exactly this arithmetic. Here
/// they are a struct with no dependencies — not on SwiftUI, not on `Date`, not even on
/// Foundation — which is what lets `ClockTests` assert them on the terminal and on the
/// phone.
///
/// The type deliberately does *not* own the tick loop. Draining events, spotting a
/// handoff and deciding to defer the rest of a burst are the view's business and they
/// interleave with the ticks; what belongs here is the accounting, which is the part
/// with the invariants.
public struct FrameClock: Equatable, Sendable {

    /// Slow motion: a scale on the wall time paid into the accumulator, and a real-time
    /// fuse.
    ///
    /// **The simulation does not know this exists.** `Engine.step` is handed `tickDt` and
    /// only `tickDt` at every rate, so slow motion is invisible to a replay — which is
    /// the property that lets it exist at all.
    public struct SlowMo: Equatable, Sendable {
        /// Wall time is multiplied by this before it reaches the accumulator.
        public var scale: Double
        /// Seconds of *real* time remaining. Real on purpose: the effect is 0.35 s of the
        /// player's life, not 0.35 s of a game that is running at 45%.
        public var timeLeft: Double

        public init(scale: Double, timeLeft: Double) {
            self.scale = scale
            self.timeLeft = timeLeft
        }
    }

    /// The one and only step the simulation is advanced by. 1/120 is the regime the
    /// entire validation suite runs at (see `Replay.swift`), so it is the regime the
    /// shipped game runs at.
    public static let tickHz = 120
    public static let tickDt = 1.0 / Double(tickHz)

    /// The most wall time the accumulator will hold — 0.25 s. Anything beyond it is
    /// dropped rather than replayed, so a stall can never spiral.
    public static let maxAccumulated = 0.25

    /// What the clamp is worth in ticks: the most `Engine.step` calls one frame can ever
    /// demand. Stated so a check can assert the bound rather than restate the arithmetic.
    public static var maxTicksPerFrame: Int { Int(maxAccumulated / tickDt) }

    /// A `sinceSlowMo` large enough that the first hitstop of a match is never swallowed
    /// by the cooldown.
    public static let longAgo = 999.0

    /// Wall-clock seconds owed to the simulation but not yet spent on whole ticks.
    public private(set) var accumulator = 0.0

    /// The moment the previous usable frame arrived, on whatever monotonic scale the
    /// caller measures in. Nil means the next frame measures nothing — see `abandon`.
    public private(set) var lastFrame: Double?

    /// Duration of the last frame, clamped. Feeds the camera easing and the HUD's own
    /// countdowns, so a 120 Hz display eases at the same speed as a 60 Hz one.
    public private(set) var frameDt = 1.0 / 60.0

    /// How long the thumb has been down on the current drag, in seconds of wall time.
    public private(set) var hold = 0.0

    /// Whether a throw is being charged, i.e. whether `hold` is running.
    public private(set) var charging = false

    /// The slow motion in effect, if any.
    public private(set) var slowMo: SlowMo?

    /// Real seconds since the last hitstop started, so the cooldown has something to
    /// measure.
    public private(set) var sinceSlowMo = FrameClock.longAgo

    public init() {}

    // MARK: - the frame

    /// A frame arrived at `now`, in seconds on any monotonic scale.
    ///
    /// Returns the frame's duration, or nil when there is nothing to measure from (the
    /// first frame, or the first frame after an abandonment) or when the clock did
    /// something impossible — a suspended app resuming, a clock adjustment. Either way
    /// the stamp is taken, so the *next* frame measures one frame.
    ///
    /// The accumulator is fed here and nowhere else, scaled by slow motion and clamped.
    @discardableResult
    public mutating func beginFrame(at now: Double) -> Double? {
        let last = lastFrame
        lastFrame = now
        guard let last else { return nil }
        let wallDt = now - last
        // A hiccup must not poison a simulation that never reads a clock.
        guard wallDt.isFinite, wallDt > 0 else { return nil }

        frameDt = Swift.min(wallDt, Self.maxAccumulated)
        if charging { hold += frameDt }

        // Clamp the *accumulated* debt, not just this frame's: the game slows down for a
        // moment instead of fast-forwarding.
        accumulator = Swift.min(
            accumulator + wallDt * (slowMo?.scale ?? 1), Self.maxAccumulated)
        return frameDt
    }

    /// Take one tick's worth of accumulated time, if there is one. The caller runs
    /// `Engine.step(dt: FrameClock.tickDt)` for each.
    public mutating func takeTick() -> Bool {
        guard accumulator >= Self.tickDt else { return false }
        accumulator -= Self.tickDt
        return true
    }

    /// Keep at most one tick of the remaining debt and **drop the rest**.
    ///
    /// "Starting at the catch frame": if a burst of catch-up ticks was owed and the third
    /// of them was the layout grab, the rest must not be spent before the screen has drawn
    /// it. One tick is carried into the next frame; everything above that is discarded.
    ///
    /// This comment used to say "nothing is lost — only deferred", which is not what a
    /// `min` does, and a reviewer caught it. Dropping is the right behaviour and worth
    /// stating plainly: the discarded ticks belong to a hitch the player already lived
    /// through, and paying them back at 0.35× would stretch a 0.2 s stall into most of a
    /// second of slow motion — the debt would be visible precisely because it was repaid.
    public mutating func deferRemainingTicks() {
        accumulator = Swift.min(accumulator, Self.tickDt)
    }

    /// End of frame: burn the real-time fuses.
    public mutating func endFrame() {
        sinceSlowMo += frameDt
        if var s = slowMo {
            s.timeLeft -= frameDt
            slowMo = s.timeLeft > 0 ? s : nil
        }
    }

    // MARK: - the gap

    /// Nobody is looking: paused, backgrounded, on another tab, behind a sheet, or the
    /// match is over.
    ///
    /// The accumulator is emptied and the frame stamp is *dropped* rather than kept.
    /// Keeping it would mean the first frame after a resume measures the whole spell away
    /// — thirty seconds in someone's pocket — and the clamp would still hand the sim its
    /// full 0.25 s of catch-up, i.e. thirty ticks of game the player never saw, fired off
    /// in one frame.
    ///
    /// **It also ends the charge and cancels slow motion**, and that is the point of it
    /// being one function rather than two lines at a call site. Both are wall-clock state
    /// measured against a moment that no longer exists: a hold that began before a phone
    /// call is not a hold, and a 0.45 s hitstop that was frozen mid-burn would otherwise
    /// resume an hour later and play the next 0.4 s of a fresh point at 0.35× speed.
    public mutating func abandon() {
        lastFrame = nil
        accumulator = 0
        slowMo = nil
        endCharge()
    }

    /// Everything a new match resets: the gap, plus the hitstop cooldown, which is per
    /// match and starts long ago so the first one lands.
    public mutating func reset() {
        abandon()
        sinceSlowMo = Self.longAgo
    }

    // MARK: - the charge

    /// The thumb went down. Idempotent: a gesture that keeps moving keeps its charge.
    public mutating func beginCharge() {
        guard !charging else { return }
        charging = true
        hold = 0
    }

    /// The thumb came up, or the drag was called off, or the moment it was measured
    /// against is gone.
    public mutating func endCharge() {
        charging = false
        hold = 0
    }

    // MARK: - slow motion

    /// Whether a hitstop is allowed to start, given the least real time between two.
    public func canSlow(after cooldown: Double) -> Bool {
        sinceSlowMo >= cooldown
    }

    /// Start a hitstop. The caller has already asked `canSlow`.
    public mutating func slow(_ s: SlowMo) {
        slowMo = s
        sinceSlowMo = 0
    }
}
