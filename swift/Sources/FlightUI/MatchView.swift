import Foundation
import RealityKit
import SwiftUI
import UltimateSim

/// The game, as a thing you can play with a thumb.
///
/// Control follows the disc. You are always the player with a decision to make: hold the
/// disc and you are the thrower, catch it and you become the catcher. That was a
/// deliberate choice over pinning the camera to one player, which would make the other
/// five scenery and would mean the interesting moment — the catch — is the moment your
/// player stops mattering.
///
/// The throw is one gesture. Drag from the thrower: **direction** is where you drag,
/// **distance** is power, and **the throw type** is chosen by how far up or down the
/// screen you finish, because that is the axis that maps to what a throw does. A flat
/// drag is a backhand or forehand; dragging high gives the overheads that go up and over
/// a mark. Release to throw. Nothing here is a menu, because a menu is time and a mark
/// does not give you any.
///
/// What the scene looks like lives in `PitchScene`. This file owns the match, the
/// gesture, and the mapping from one to the other.
@available(macOS 15.0, iOS 18.0, *)
public struct MatchView: View {
    /// A format forced from the command line, if one was. A parameter rather than a
    /// constant for the same reason the app's initial tab is one: `simctl` can launch
    /// with arguments but cannot tap, so anything only reachable by finger is something
    /// that stops being looked at.
    ///
    /// Nil — the normal case — means the format is whatever the player last chose in the
    /// pre-game sheet, which is the only place a person can set it.
    private let formatOverride: FieldSpec?

    /// How many goals the match is played to, if the command line said. Overrides the
    /// length the player last chose and nothing else about their setup.
    ///
    /// Same door as `formatOverride`, and it buys something specific: **observing anything
    /// that only happens near full time cost about ten minutes of Simulator per look**,
    /// because the shortest game the sheet offers is to 3 and the sheet needs a finger.
    /// `-points 1` makes the result card, the save-at-full-time clear and the REMATCH path
    /// reachable in one point.
    ///
    /// Nil — the normal case — means the length is whatever the player last chose.
    private let pointsOverride: Int?

    /// Whether to open straight into a live match instead of the pre-game sheet. Same
    /// argument as `formatOverride`: the sheet is a wall a launch argument cannot climb,
    /// and everything behind it would stop being screenshot-able.
    private let skipsSetup: Bool

    /// A charge to pin on screen, in seconds of hold, instead of waiting for a thumb.
    ///
    /// The throw gesture — aim line, power bar, receiver bracket and now the charge meter
    /// — exists only while a finger is down, and `xcrun simctl launch` can pass arguments
    /// but cannot drag. Same door and same reasoning as `formatOverride` and `skipsSetup`:
    /// a control that can only be photographed by hand is a control that stops being
    /// looked at. `-charge 0.85` draws the gesture mid-hold, at the moment the meter is
    /// in its window.
    ///
    /// Nil — the normal case — means the overlay is a real drag or nothing at all. It
    /// changes no simulation state: it is a `DragState` handed to the overlay, and it
    /// never reaches `humanRelease`, because nothing releases it.
    private let demoCharge: Double?

    /// A tap to issue automatically, in fractions of the screen, whenever the engine will
    /// take one.
    ///
    /// The offensive twin of `autoDefend`, and it exists for the same reason and one more.
    /// The reason it shares: everything a called cut puts on screen — the ghost route on
    /// the grass, the order plate, the prompt going away — lives behind a finger, and
    /// synthetic touch injection does not reach the Simulator. The reason it does not: this
    /// is the only control whose *screen coordinates* matter, so it is also the only way to
    /// photograph whether `MatchScene.groundPoint` puts the finger where the player thinks
    /// they put it. A tap at (0.5, 0.35) should send somebody up the middle of the frame.
    ///
    ///     xcrun simctl launch booted com.grahamsiener.ultimate -setup off -cut 0.5,0.35
    ///
    /// It drives `tap(at:in:)`, the identical function the finger drives, so a screenshot
    /// shows the real path. Nil in every normal run.
    private let demoCut: CGPoint?

    /// Whether to issue the defensive tap automatically, whenever there is one to issue.
    ///
    /// The same door as `-charge`, and for the same reason: `xcrun simctl launch` can pass
    /// arguments but cannot touch the screen, and synthetic touch injection into the
    /// Simulator does not reach it. The defensive call plate, the bid marker on the grass
    /// and the recovery countdown all exist only after a tap, so without this they are
    /// three pieces of HUD nobody can photograph — which is how a control stops being
    /// looked at.
    ///
    /// It drives `defend()`, the identical function the finger drives, so what a
    /// screenshot shows is the real path and not a mock of it. Off in every normal run.
    private let autoDefend: Bool

    /// Seconds of play after which to save the match, throw the engine away, and restore
    /// it from the save — the whole round trip, without a finger.
    ///
    /// Same door as `-charge` and `-defend on`, and the reason is sharper here than for
    /// either of them: the save path is driven by *backgrounding the app*, and the restore
    /// path by a button on a sheet, so between them they need a home button and a tap —
    /// neither of which this environment can synthesise. Without this argument the entire
    /// feature is unreachable on the Simulator, which is how a feature stops being looked
    /// at, and worse, stops being verified.
    ///
    /// It runs the real functions: the same `saveMatch()` the scene phase calls, and the
    /// same `resume(_:)` the sheet's button calls, on the same file on disk. What a
    /// screenshot shows is the restore, not a mock of it.
    ///
    /// Nil in every normal run.
    private let saveCycle: Double?

    /// Whether to draw the state probe a UI test reads. `-probe on`, and nothing else.
    ///
    /// See `MatchProbe`. It is the missing half of `XCUITest` being able to verify this
    /// game at all: XCUITest can deliver a real touch but can only assert on what is on
    /// screen, and the two facts a touch test needs — *is it legal to act yet* and *what
    /// hold produced that grade* — are deliberately not on the HUD. Off in every normal run,
    /// and it draws nothing and reads nothing when it is off.
    let showsProbe: Bool

    /// Whether this view is the one on screen.
    ///
    /// A `TabView` builds a tab when it is first selected and then keeps it alive
    /// forever, so an unselected match kept ticking — burning a phone's battery to
    /// simulate a game nobody was looking at, and, worse, running the *only* match
    /// instance ahead of wherever the player left it. The tab bar knows which tab is
    /// showing and nothing else does, so it passes the fact down. Defaults to true for
    /// every other caller, including the macOS scope, where there are no tabs.
    private let active: Bool

    @Environment(\.scenePhase) private var scenePhase

    /// Set whenever the app stops being frontmost, and cleared only by a tap.
    ///
    /// Auto-resuming on return would drop a player back into a live point they last saw
    /// half a second before a phone call — the sim would be correct and the player would
    /// be behind it. So coming back is a paused pitch and one tap.
    @State var paused = false

    @State var match: Engine
    @State var drag: DragState? = nil

    /// The match settings, as last chosen — length, format, difficulty. Loaded from
    /// `Prefs` at construction and written back whenever a match starts from them, so the
    /// second launch opens on the game you were playing rather than on the defaults.
    ///
    /// **This is the sheet's copy, and it is editable while a match is running.**
    /// `PreGameSheet` binds to it and writes every tap through live, and the gear on the
    /// scoreboard opens that sheet mid-point. Nothing here is the setup the match on
    /// screen is being played under — see `playedSetup`.
    @State var setup: MatchSetup

    /// The settings the live match is actually being played under.
    ///
    /// Written in exactly two places, `restart` and `adopt`, which are the only two ways
    /// a match comes into existence. Everything that describes the match rather than the
    /// sheet reads this: the save's fingerprint, the save's encoded setup, and REMATCH.
    ///
    /// **Why it has to be separate.** `setup` drifts the moment a player opens the gear
    /// mid-match and changes anything, and `onDismiss` is a plain "close the sheet" with
    /// no revert. Playing 3v3 to 5 on Normal, flicking FORMAT to 7v7 to see what it says,
    /// tapping BACK and then backgrounding the app used to write a save that claimed to be
    /// a 7v7 match: the resume built a 7v7 engine to replay a 3v3 tape, diverged, and
    /// **discarded the match**. Changing only the *length* was worse — the physics is
    /// identical until somebody reaches 5, so the checksum matched and the player was
    /// silently resumed into a game to 7 they never started. The fingerprint cannot catch
    /// either, because it is computed from the same drifted value on the write and on the
    /// read.
    @State var playedSetup: MatchSetup

    /// Whether the pre-game sheet is up. True at launch, because a game should be chosen
    /// before it is played; true again whenever the sheet is reopened from the scoreboard
    /// or from the result card.
    @State var showSetup: Bool

    /// Whether the coach cards are up. Set once on the first launch that has never seen
    /// them, and set again by the sheet's HOW TO PLAY button.
    @State var showCoach = false

    /// Whether the sheet, if dismissed, has a match to fall back onto. False before the
    /// first pull; true forever after, since a match — running, paused or finished —
    /// exists from then on.
    @State var hasStarted = false

    /// The seed this match was built from. Freshly drawn from the clock for every new
    /// match — including the format-switch restart — so no two launches replay the same
    /// wind and rosters. Deliberately not shown anywhere yet; it is kept so a later
    /// result screen can display it, and so the match stays a pure function of
    /// `(format, seed, inputs)` exactly as `Replay.swift` requires. All randomness
    /// enters the engine through this one number.
    @State var seed: UInt32

    // MARK: the match, written down
    //
    // A saved game here is not a state dump. It is the seed above plus the list below,
    // which is exactly what `Replay.swift` proves is enough to rebuild a match bit for
    // bit — see `MatchSave` for why that is the format and not merely a format.

    /// Every human input this match has taken, stamped with the tick it was consumed by.
    ///
    /// Appended by the two places a human can touch the simulation, `throwGesture` and
    /// `defend()`, and by nothing else. Cleared by `restart`, and adopted wholesale from
    /// the recording when a save is resumed, so a restored match can be saved again.
    @State var inputs: [RecordedInput] = []

    /// The saved match found on disk at launch, while it is still on offer. Cleared the
    /// moment it is resumed, discarded, or superseded by a new match.
    ///
    /// Note what this is *not*: proof that the save can be restored. That costs a canary
    /// simulation to establish and is paid in `resume`, off the launch path — see
    /// `SimFingerprint`. This is the offer; the check is what happens when it is accepted.
    @State var resumable: SavedMatch?

    /// How far a restore has got, 0…1, while one is running. Non-nil is what draws the
    /// veil, so a replay of twenty minutes of match is a progress bar rather than a
    /// freeze.
    @State var restoring: Double?

    /// Why the last save was thrown away, if it was. Shown on the sheet, because a
    /// RESUME button that silently does nothing is worse than no button.
    @State var restoreNote: String?

    /// Whether the save has already been cleared for this finished match, so the result
    /// overlay's arrival does not try to delete a file once per tick.
    @State var clearedAtEnd = false

    /// Whether `-savecycle` has already fired. It is a one-shot: a demo that saved and
    /// restored every ten seconds would never be playable.
    @State private var cycled = false

    // MARK: fixed-tick clock state
    //
    // The sim is advanced only in whole 1/120 s ticks; see the long comment on `body`'s
    // tick driver below and Sources/UltimateSim/Play/Replay.swift:19-56 for why.

    /// The wall clock, and everything measured against it: the frame stamp, the
    /// accumulator, the charge, the slow motion and its cooldown.
    ///
    /// One value type in the sim package rather than six `@State` properties here, and
    /// deliberately: those five quantities have invariants — the clamp, abandonment,
    /// real-time slow motion, a charge that must not outlive the thumb — and while they
    /// were arithmetic scattered through this file no check could reach a single one of
    /// them. See `FrameClock`, and `ClockTests` for what is now asserted.
    @State var clock = FrameClock()

    /// Whole simulation ticks executed so far. The trail sampler keys off this, because
    /// the trail should sample the flight, not the display.
    @State var tickCount = 0

    /// The one and only step the simulation is advanced by. 1/120 is the regime the
    /// entire validation suite runs at (see `Replay.swift`), so it is the regime the
    /// shipped game runs at. Named here as well because the recording carries the rate
    /// and `saveMatch` settles the tick with it.
    static let tickHz = FrameClock.tickHz
    static let tickDt = FrameClock.tickDt

    /// The turnover being shouted about, while there is one. Its `timeLeft` is burned
    /// down by wall time in `advance`, so the shout lasts 1.5 s at any refresh rate.
    ///
    /// Built from `Engine.drainEvents()` rather than from a box-score diff — see
    /// `TurnoverFlash`, and `MatchEvent` for why the surface is a drained buffer.
    @State var turnoverFlash: TurnoverFlash? = nil

    /// The defender the player has just sent at the disc, while it is worth saying so.
    /// See `DefenceCall`.
    @State var defenceCall: DefenceCall? = nil

    /// The cut the player has just called, while it is worth saying so. See `CutCall`.
    @State var cutCall: CutCall? = nil

    /// The tap the game would not take, while it is worth saying so. See `RefusedTap`.
    @State var refusedTap: RefusedTap? = nil

    /// The tap ledger, which is why this change is measurable rather than argued about.
    ///
    /// Three view-side counters, written only by `callCut`/`defend`/`refuse` and read only by
    /// the probe: how many taps the offence took, how many taps of either half were turned
    /// down, and how many of the accepted ones only landed because the empty cone was widened
    /// to a right angle. `offenceTaps - refusals - widenedCalls` over `offenceTaps` is the hit
    /// rate the 35° cone gets on its own, in the same run that measures the hit rate a player
    /// now gets — which is the before-and-after the whole exercise asked for, taken with a
    /// finger rather than modelled.
    @State var offenceTaps = 0
    @State var refusals = 0
    @State var widenedCalls = 0
    /// The reason the last refused tap gave, for the probe. Nil before the first one.
    @State var lastRefusal: RefusedTap.Reason? = nil
    /// Every refusal of the run, by reason. The last one says what the plate is showing; this
    /// says what a whole session of tapping ran into, which is what a measurement needs — "11 of
    /// 39 taps were refused" is not actionable until it is "7 of them named nobody and 4 were
    /// taps that arrived after the disc changed hands".
    @State var refusalTally: [String: Int] = [:]

    /// The last release the thumb made, with the hold that graded it. Written by
    /// `throwGesture` and read only by the probe — see `MatchProbe.Released` for why the
    /// hold has to be kept rather than re-derived.
    @State var lastRelease: Released? = nil

    /// How the last drag finished: `throw`, `cancel`, `refused`, or `-` before the first
    /// one. Written by `throwGesture`, read only by the probe.
    ///
    /// The abort is the one control in the game whose success is *nothing happening*, so
    /// without this a UI test cannot tell a working cancel from a gesture that never reached
    /// the app at all — which is precisely the failure this whole exercise is trying to rule
    /// out.
    @State var lastDragEnd: String = "-"

    /// What the aim assist did to the last throw, while it is still worth saying.
    @State var assistToast: AssistToast? = nil
    /// The control swap being announced, while there is one.
    @State var handoff: Handoff? = nil
    /// Who had control at the end of the previous tick, so a change can be noticed.
    /// `Engine.controlled` moves silently on every catch and every turnover.
    @State var lastControlled = 0

    /// The scene in front of the camera: the entity handles, taken once when it was
    /// built, and the per-frame caches that keep the render pass from allocating.
    ///
    /// A class, and `@State`, for the reason `MatchScene` gives: the two halves of a
    /// `RealityView` are separate closures and no value type survives the trip between
    /// them. `sync` used to rebuild a `[String: Entity]` from `content.entities` on every
    /// frame — a dictionary allocation and a full walk of the scene roots, 120 times a
    /// second, to find nine entities that never move between roots.
    @State var scene = MatchScene()

    /// The size of the pitch on screen, as last measured. Written by the one
    /// `GeometryReader` that knows it, read by `-cut`'s synthetic tap and by the probe.
    ///
    /// **The probe reads it because a debug build and a release build play on different
    /// rectangles.** `UltimateApp.showsInstruments` puts a five-item tab bar under the pitch
    /// in a debug build, which on an iPhone 17 Pro in landscape leaves the game 874 × 338 of
    /// an 874 × 402 window; a release build has the whole window. A touch test that expressed
    /// its taps as fractions of the *window* was therefore aiming at different grass in the
    /// configuration that ships than in the one it ran in. Reporting the rectangle lets a test
    /// aim at fractions of the pitch instead, and lets it assert which rectangle it got.
    @State var viewSize: CGSize = .zero

    /// The same rectangle, in the window's coordinates.
    ///
    /// **The pitch is not the window and it is not the window minus a tab bar either.** Measured
    /// on an iPhone 17 Pro in landscape, a debug build gives the game 750 × 338 of an 874 × 402
    /// window: the instruments tab bar takes a strip, and the notch and the home indicator take
    /// insets on three sides. A touch test that turned a fraction into a window offset was
    /// therefore aiming a few degrees off wherever it thought it was aiming, in the debug
    /// configuration *and* in the release one, differently. The origin is the missing half of
    /// fixing that, so the probe reports the whole rectangle.
    @State var viewFrame: CGRect = .zero

    /// Bumped once per rendered frame purely so SwiftUI knows something happened.
    ///
    /// `Match` is a `final class` — deliberately, since passing a match around must not
    /// silently copy it — and SwiftUI does not observe mutations through a class
    /// reference. Without this the sim ticks correctly and the screen never redraws,
    /// which looks exactly like a frozen simulation and is not one. The frame counter is
    /// the honest fix: the view depends on the tick, and the tick depends on the clock.
    @State var frame = 0

    /// Time, slowed, for as long as the moment is worth watching.
    ///
    /// `docs/gameplay-design.md` §5 hands slow motion to every contested or laid-out
    /// catch and to every block. **Measured, that is 86 hitstops in a full 7v7 game** —
    /// five headless games at 15 points gave 19–41 contested and 41–53 laid-out catches
    /// each, against 3–9 blocks and 4–10 interceptions. Broadcast ultimate slows down two
    /// or three moments a game; at 86 the game does not feel emphatic, it feels like it
    /// is stuttering, and the effect stops meaning anything at all because it is on the
    /// metronome. See `slowMo(for:)` for what replaced it and what that measures.
    ///
    /// The catch frame rule still holds for what remains: **starting at the moment it
    /// resolves**, never before, because pre-slowing telegraphs a dice roll that has not
    /// been rolled.
    ///
    /// **The simulation does not know this exists.** §5 specifies it as "a render-side
    /// scale on the fixed-step accumulator", and that is exactly what it is: `Engine.step`
    /// is still handed 1/120 and nothing else, and the only thing that changes is how much
    /// wall time `advance` pays into the accumulator. A match is a pure function of
    /// `(format, seed, inputs)` — frame rate already varies the *number* of ticks per
    /// frame and never their size, and this varies the same number the same way. Slow
    /// motion is therefore invisible to a replay, which is the property that lets it
    /// exist at all.
    /// The pair of numbers themselves live in `FrameClock`, with the accumulator they
    /// scale — see there for why the fuse burns in real seconds, and for the gap that used
    /// to freeze it.
    private typealias SlowMo = FrameClock.SlowMo

    /// The one place an event turns into a slowed clock.
    ///
    /// **Time stops for a D you had to dive for, and for nothing else.**
    ///
    /// That is §5's own sentence narrowed rather than contradicted: §5 already says the
    /// block is "the peak moment of the sport on defence" and "the one event allowed the
    /// full hitstop treatment". What it did not anticipate is how often this simulation
    /// produces a laid-out *catch* — 41 to 53 of them in a full 7v7 game, because the
    /// receiver AI bids hard — so "contested or laid-out catch" turned out to be a rule
    /// that fires on a quarter of all completions. The fix belongs here and not in the
    /// sim: nothing about what counts as a layout is wrong, only what the screen does
    /// about it.
    ///
    /// Measured over five full 7v7 games (seeds 3, 19, 37, 41, 71), hitstops per game:
    ///
    /// | rule | per game |
    /// |---|---|
    /// | §5 as written | 86.2 |
    /// | + only catches in the red zone | 50.6 |
    /// | + only catches that score or land in the endzone | 25.0 |
    /// | laid-out D **and** laid-out scoring catch | 9.6 |
    /// | **laid-out D only (this)** | **3.2** |
    ///
    /// Two or three a game, which is the broadcast number, and every one of them is a
    /// possession changing on a play nobody could have made standing up. The scoring
    /// layout catch is the one real casualty and it was worth 6.4 a game on its own —
    /// most goals in this sim are taken at full stretch, so slowing them slows the end of
    /// most points, which is a metronome again.
    ///
    /// Everything dropped from §5 keeps its *other* feedback: a contested or laid-out
    /// catch still gets `Feel.bigCatch`'s heavier tap, a goal still gets the callout and
    /// the notification haptic. Only the clock is reserved.
    ///
    /// It also gives the new defensive tap the best possible payoff: the one thing the
    /// game slows down for is exactly the thing `Engine.humanDefend` exists to let you
    /// do.
    private static func slowMo(for event: MatchEvent) -> SlowMo? {
        guard case .turnover(let reason, _, _, _, let grade, _) = event else { return nil }
        switch reason {
        // An interception is a catch block and counts. A *standing* block is a good play
        // and a common one; it gets the heavy haptic and no more.
        case .block, .interception:
            return grade == .layout ? SlowMo(scale: 0.35, timeLeft: 0.45) : nil
        default:
            return nil
        }
    }

    /// The least real time between two hitstops, in seconds.
    ///
    /// A second lever, and deliberately a small one: measured, the laid-out D's are spread
    /// across a twenty-five minute game, so a cooldown removes 0.4 of the 3.2 rather than
    /// most of them. It is here for the case the rate never averages away — two blocks in
    /// the same scramble, where the second slow-motion lands on a screen still coming out
    /// of the first and reads as a dropped frame rather than as a second highlight.
    private static let slowMoCooldown = 8.0

    /// A drag in progress, in view coordinates plus the throw it currently means.
    struct DragState {
        var start: CGPoint
        var current: CGPoint
        var type: ThrowType
        var power: Double
        var loft: Double
        /// The world direction this drag currently means. Stored at interpretation time
        /// so the scene's aim arrow and the eventual release are the same number, and so
        /// nothing downstream has to know about view coordinates.
        var aim: Vec3d
        /// True while the thumb is back inside the cancel radius of where the drag
        /// started. A drag in this state draws grey, names no receiver, and throws
        /// nothing at all if it is released here.
        var aborted: Bool
    }

    /// How close to the drag's own starting point counts as calling it off, in points.
    ///
    /// `ThrowGesture.minimumDrag` is 8 and a drag only reaches this file once it has
    /// passed that, so the sim's rule stands: any *release* it is asked about is a throw.
    /// What the sim has no opinion on is whether to ask, and it should not be asked when
    /// the thumb has come home — dragging back to where you started is the universal
    /// "no", and before this it threw a minimum-power push at whatever was behind you.
    /// Deliberately wider than the 8 pt floor: a cancel you have to hit precisely is a
    /// cancel that fails exactly when you are panicking.
    private static let cancelRadius = 26.0

    public init(
        format: FieldSpec? = nil, points: Int? = nil, active: Bool = true,
        skipsSetup: Bool = false, demoCharge: Double? = nil, autoDefend: Bool = false,
        saveCycle: Double? = nil, demoCut: CGPoint? = nil, showsProbe: Bool = false
    ) {
        self.active = active
        self.showsProbe = showsProbe
        self.autoDefend = autoDefend
        self.demoCut = demoCut
        self.formatOverride = format
        self.pointsOverride = points
        self.skipsSetup = skipsSetup
        self.demoCharge = demoCharge
        self.saveCycle = saveCycle

        // The saved game, read off disk before anything is drawn. A file read of a few
        // kilobytes, and deliberately *only* a file read: whether it can actually be
        // restored is a question that costs a simulation to answer, and the launch path
        // is not where that is paid. See `resumable`.
        _resumable = State(initialValue: MatchSave.load())

        // The saved setup, with the launch arguments — when there are any — overriding
        // the two things they name and nothing else. Neither is written back to `Prefs`:
        // an override is for this launch, and a screenshot run must not quietly become the
        // game the player finds next time they open the app.
        var chosen = Prefs.loadSetup() ?? MatchSetup()
        if let format { chosen.format = format.teamSize <= 3 ? .minis : .full }
        // Clamped rather than trusted. The target is the engine's win condition and the
        // scoreboard's "first to N", and a zero or a negative would be a game that is over
        // before the pull.
        if let points { chosen.pointsToWin = Swift.max(1, Swift.min(99, points)) }
        _setup = State(initialValue: chosen)
        // The match built below is played under `chosen`, and `-setup off` starts it
        // without anybody pressing START — so the two agree from the first frame.
        _playedSetup = State(initialValue: chosen)
        _showSetup = State(initialValue: !skipsSetup)
        _hasStarted = State(initialValue: skipsSetup)

        let s = Self.freshSeed()
        _seed = State(initialValue: s)
        // A match exists from the first frame even while the sheet is up, because the
        // sheet is drawn over a pitch and the pitch has to be something. It is the same
        // match the START button keeps if nothing is changed — restart draws a new seed,
        // so the only cost of touching a setting is a different wind.
        _match = State(
            initialValue: Engine(
                format: chosen.fieldSpec.gameFormat, seed: s, config: chosen.engineConfig))
    }

    /// A seed for a new match, drawn from the clock. The engine stays fully
    /// deterministic — replay a match by constructing an `Engine` with the same seed —
    /// but each *new* match gets its own wind and rosters instead of the compiled-in
    /// default that made every launch identical.
    private static func freshSeed() -> UInt32 {
        UInt32(truncatingIfNeeded: DispatchTime.now().uptimeNanoseconds)
    }

    public var body: some View {
        // The tick driver. `TimelineView(.animation)` re-evaluates once per rendered
        // frame, paced by the display on both platforms this target builds for, and the
        // `onChange` below turns each frame into zero or more *fixed* 1/120 s steps.
        //
        // Why fixed and not "whatever the wall clock measured": `Engine.step` is not
        // associative in `dt` — see Sources/UltimateSim/Play/Replay.swift:19-56.
        // `Locomotion` decays gait with `exp(-k * dt)` once per call and clamps a `dt`
        // above 1/30 outright, `TeamAI` decides once per call, the stall accumulates in
        // whole `dt`s — so `step(0.02)` is a *different simulation* from `step(0.01)`
        // twice, and the 2.2M-assertion validation suite runs entirely at 1/120. The
        // shipped game must run the same regime, or it ships a physics nobody validated.
        // Wall time therefore decides only *how many* whole ticks run, never how big
        // they are; the leftover fraction of a frame stays in `accumulator`, outside
        // the simulation, where nothing the sim computes can read it.
        TimelineView(.animation) { timeline in
            matchContent
                .onChange(of: timeline.date) { _, now in
                    advance(to: now)
                }
        }
        // Leaving the foreground pauses the match and writes it down. Note what this does
        // *not* do: resume it. See `paused`.
        //
        // This is the save that matters. Everything that ends a session on a phone —
        // a call, the home gesture, the system reclaiming memory an hour later — passes
        // through here first, and it is the only moment the system promises to give the
        // app time to do anything at all.
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                paused = true
                // A gesture interrupted by the system is a gesture that never ends:
                // SwiftUI does not reliably deliver `DragGesture.onEnded` when a call, a
                // notification banner or the home gesture takes the touch away. See
                // `cancelDrag` for what a drag that outlives its thumb does to the rest of
                // the match.
                cancelDrag()
                saveMatch()
            }
        }
        // The swipe out of the app switcher, which on some paths terminates without a
        // background first. Same call, later moment, and cheap enough to do twice.
        .onReceive(
            NotificationCenter.default.publisher(
                for: MatchSave.willTerminate ?? Notification.Name("flightui.never"))
        ) { _ in
            saveMatch()
        }
        // The one path to the coach cards that does not go through the sheet: a first run
        // launched straight into a match by `-setup off`. A player who has never been
        // taught the gesture should be taught it however the app was started.
        .onAppear {
            if skipsSetup && !Prefs.coachSeen { showCoach = true }
        }
    }

    /// Whether the simulation should be advancing at all: the tab is showing, the app is
    /// frontmost, nobody has paused it, nothing is being read over the top of it, and the
    /// game is not already won.
    ///
    /// The sheet and the coach cards ride the pause path rather than inventing their own,
    /// which is what makes reading them free: `advance` drops the frame stamp and empties
    /// the accumulator while this is false, so a minute spent on the second coach card
    /// costs the match nothing and buys it nothing.
    ///
    /// **Full time is one of them.** `Engine.step` early-returns once the game is over, so
    /// nothing diverged — but the loop went on buying 120 of those returns a second, for
    /// as long as the result card was on screen, and `sync` went on easing a camera over a
    /// match that had finished. That is unbounded work and battery on a screen whose only
    /// remaining input is one button.
    private var running: Bool {
        active && scenePhase == .active && !paused && !showSetup && !showCoach
            && restoring == nil && !match.isOver
    }

    private var matchContent: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                RealityView { content in
                    build(content)
                } update: { content in
                    // Reading `frame` is what subscribes this closure to the clock.
                    _ = frame
                    sync(content)
                }
                .background(Color(red: 0.055, green: 0.070, blue: 0.175))
                .gesture(throwGesture(in: geo.size))
                // THE WHOLE GRAMMAR: **drag from the disc to throw, tap the grass to send
                // a cutter, and the same tap on defence sends your best defender at the
                // disc.** Simultaneous with the drag rather than sequenced, and safe to be:
                // the throw is a `DragGesture(minimumDistance: 8)`, so a tap can never be
                // the start of a throw and a throw can never end as a tap. `SpatialTapGesture`
                // rather than `onTapGesture` only because the drag is attached with
                // `.gesture` and the two want to be siblings.
                //
                // **The location is used on offence and ignored on defence**, which is not
                // an inconsistency but the two different questions being asked. On defence
                // the question is *when* — where to go is the disc's business and the engine
                // can answer it better than a thumb that covers four metres of grass. On
                // offence the question is *where*: which piece of field you want attacked.
                // And even there the point is only ever read as a **direction** from the
                // thrower, resolved by the same 35 degree cone the drag uses, so the thumb's
                // coarseness is priced in exactly once for both halves of the offence.
                .simultaneousGesture(
                    SpatialTapGesture().onEnded { g in tap(at: g.location, in: geo.size) })
                // The scene is built once, with one entity per player. Changing format
                // changes how many players there are, so the scene has to be rebuilt
                // rather than synced — without this, switching to 7v7 leaves eight
                // players with no body to move.
                .id(match.fieldSpec.teamSize)

                // Darkened corners. Drawn over the render and under the HUD, so it pulls
                // the eye to the middle of the pitch without ever dimming the score.
                vignette(in: geo.size).allowsHitTesting(false)

                scoreboard
                if let d = drag ?? demoDrag(in: geo.size) { aimOverlay(d, in: geo.size) }
                callout
                assistReadout
                defenceReadout
                defenceHint
                cutReadout
                cutHint

                // The tap that was not taken. Above the order plates because it is about the
                // touch that just happened rather than about the match, and it cannot collide
                // with them: an accepted call clears it, and its own rectangle is clamped out
                // of the plate strip. See `refusedOverlay`.
                if let refused = refusedTap { refusedOverlay(refused, in: geo.size) }

                // Full time. Drawn over everything, including the callouts — once the
                // game is over the only interesting fact left is the result, and the
                // only interesting input left is the rematch button.
                if match.isOver {
                    // REMATCH is "again", so it is the setup the match just played was
                    // played under — not whatever the sheet was last left showing. Same
                    // drift as the save's, with a milder ending: a rematch on a format
                    // nobody chose.
                    ResultOverlay(match: match) {
                        restart(playedSetup)
                    } onSetup: {
                        showSetup = true
                    }
                }

                // Paused. Over even the result card, because a paused game that looks
                // live is the bug this exists to fix. It takes the taps, which is also
                // what stops a resume gesture being read as a throw.
                if paused && active { pausedOverlay }

                // The pre-game sheet, over everything including the pause veil — it is
                // the thing you asked for, and the match behind it is stopped either way.
                if showSetup && active {
                    PreGameSheet(
                        setup: $setup, isRematch: hasStarted,
                        // The saved game, offered rather than forced. A player who opens
                        // the app wanting a fresh match should not have to finish an old
                        // one first, and a player who was three points up should not have
                        // to be asked twice.
                        resume: resumable.map { saved in
                            PreGameSheet.Resume(
                                summary: Self.resumeSummary(saved),
                                action: { resume(saved) },
                                discard: {
                                    MatchSave.clear()
                                    resumable = nil
                                    restoreNote = nil
                                })
                        },
                        note: restoreNote,
                        onStart: {
                            Prefs.save(setup)
                            showSetup = false
                            hasStarted = true
                            restart(setup)
                            // First run: teach the gesture before the first pull rather
                            // than after the first five throws have gone nowhere.
                            if !Prefs.coachSeen { showCoach = true }
                        },
                        // Replaying the lesson does not dismiss the sheet: the cards are
                        // drawn over it and dismissing them puts you back on the choices
                        // you were making, which is where you were.
                        onCoach: { showCoach = true },
                        // Nothing to go back to before the first pull.
                        onDismiss: hasStarted ? { showSetup = false } : nil)
                }

                // The restore, over everything including the sheet it was started from.
                // A match being rebuilt is not a match that can be played or configured,
                // and the veil is what says so.
                if let progress = restoring, active { restoringOverlay(progress) }

                // The coach cards, over the sheet that can summon them.
                if showCoach && active {
                    CoachOverlay {
                        Prefs.coachSeen = true
                        showCoach = false
                    }
                }

                // The state a UI test reads, when one asked for it. Last in the stack so
                // nothing can cover it, and hit-testing-transparent so it cannot cost the
                // game an input. See `MatchProbe`.
                probeOverlay
            }
            // `-charge` promises the *whole* gesture and used to deliver two thirds of it.
            // `demoDrag` reached the aim overlay directly, so the aim line, power bar and
            // charge meter drew — but `drag` itself stayed nil, and the receiver bracket
            // and the arrow on the grass are both drawn by `sync` from `drag`. The two
            // pieces the argument exists to photograph were the two it could not reach.
            // Setting the state the finger would have set fixes that and costs nothing:
            // the charge is *not* started, so `clock.hold` stays zero and the meter keeps
            // drawing the pinned value.
            .onAppear {
                if demoCharge != nil, drag == nil { drag = demoDrag(in: geo.size) }
                viewSize = geo.size
                viewFrame = geo.frame(in: .global)
            }
            // The one thing `advance` cannot know on its own. The synthetic tap `-cut`
            // issues is in *screen* coordinates, and the screen's size lives only inside
            // this `GeometryReader`; the tick loop is outside it. `onChange` covers a
            // rotation or a split view, both of which move the same fraction of the screen
            // to a different piece of grass.
            .onChange(of: geo.size) { _, new in
                viewSize = new
                viewFrame = geo.frame(in: .global)
            }
        }
    }

    /// One rendered frame's worth of simulation: accumulate the wall time since the
    /// previous frame and spend it on whole 1/120 s ticks. Rendering happens every
    /// frame regardless of how many ticks ran — including zero, when a frame arrives
    /// before a full tick's worth of wall time has accrued — so frame rate changes
    /// what you see, never what happens.
    private func advance(to now: Date) {
        // Full time. There is nothing left to come back to, so the file that says
        // otherwise goes — once, not once per tick. Checked before `running` and not
        // after the tick loop, because full time is now one of the things that *stops*
        // the loop.
        if match.isOver, !clearedAtEnd {
            clearedAtEnd = true
            MatchSave.clear()
            resumable = nil
        }

        // Paused, backgrounded, on a tab nobody is looking at, or over.
        //
        // See `FrameClock.abandon` for what that costs and why: the stamp is dropped, the
        // accumulator emptied, the charge ended and any slow motion cancelled. Rendering
        // still happens — `frame` is bumped regardless — so a paused pitch is a picture
        // rather than a black screen.
        guard running else {
            clock.abandon()
            frame &+= 1
            return
        }

        defer {
            // The redraw subscription: `sync` reads this, so bumping it once per frame
            // is what keeps the RealityView following the sim (and the eased camera
            // moving even on frames where no tick ran).
            frame &+= 1
        }
        // The stamp, the clamp, the slow-motion scale and the charge, all in one place.
        // Nil means there is nothing to measure from — the first frame, or the first
        // frame back from a gap — or that the clock did something impossible.
        guard let frameDt = clock.beginFrame(at: now.timeIntervalSinceReferenceDate)
        else { return }

        scene.bobPhase += frameDt * 3.6

        // The finger a headless run does not have. See `autoDefend`.
        // The middle of the render surface, because that is where `-defend on` documents the
        // tap as landing and because the defensive half ignores the point anyway — it is
        // carried only so a refusal has somewhere to draw itself.
        if autoDefend, match.defensiveCommit == nil {
            defend(at: CGPoint(x: viewSize.width / 2, y: viewSize.height / 2))
        }

        // And its offensive twin. See `demoCut`, and `viewSize` for the one fact this
        // needs that the tick loop cannot see. Every frame, because the engine's own
        // cooldown is what decides when a tap is taken — this is a finger held down, not
        // a schedule of its own.
        if let u = demoCut, viewSize != .zero, match.canCallCut {
            tap(
                at: CGPoint(x: u.x * viewSize.width, y: u.y * viewSize.height),
                in: viewSize)
        }

        // The home button and the sheet tap a headless run does not have either. See
        // `saveCycle`.
        if let after = saveCycle, !cycled,
            Double(tickCount) * Self.tickDt >= after
        {
            cycled = true
            saveMatch()
            if let saved = MatchSave.load() { resume(saved) }
            return
        }

        // The ticks the frame bought. The debt was clamped and scaled as it was paid in,
        // above; `Engine.step` is handed `tickDt` and only `tickDt`, in every branch, at
        // every rate — see `FrameClock`.
        while clock.takeTick() {
            match.step(dt: Self.tickDt)
            tickCount &+= 1
            recordTrail()

            // Everything the machine decided in this tick, in the order it decided it.
            // Drained per tick rather than per frame so a catch-up burst cannot swallow
            // one — which is what the old counter diffing did whenever two things landed
            // between snapshots.
            var slowed = false
            for event in match.drainEvents() {
                if let flash = TurnoverFlash.make(event) { turnoverFlash = flash }
                if let b = Feel.beat(for: event) { Feel.play(b) }
                // The cooldown is checked here rather than inside `slowMo(for:)`, which
                // stays a pure function of the event so it can be reasoned about — and
                // measured — without a clock.
                if let s = Self.slowMo(for: event), clock.canSlow(after: Self.slowMoCooldown) {
                    clock.slow(s)
                    slowed = true
                }
            }
            // Control moves on catches and on turnovers, both of which happen inside a
            // tick, so this is checked where they happen rather than once a frame.
            if match.controlled != lastControlled {
                lastControlled = match.controlled
                handoff = Handoff(to: match.controlled, timeLeft: Handoff.duration)
            }

            // "Starting at the catch frame". If a burst of catch-up ticks was owed and
            // the third of them was the layout grab, the remaining ticks must not be
            // spent before the screen has drawn it. At most one tick of the debt is
            // carried to the next frame and **the rest is dropped** — see
            // `FrameClock.deferRemainingTicks`, which is a `min` and not a subtraction.
            // Dropping is the right half of the trade: the ticks in question are ones the
            // player was never going to see anyway, and paying them out would fast-forward
            // through the very moment the hitstop exists to hold on.
            if slowed {
                clock.deferRemainingTicks()
                break
            }
        }

        // The callout clocks run on wall time, outside the simulation, like everything
        // else that is display and not physics.
        if var flash = turnoverFlash {
            flash.timeLeft -= frameDt
            turnoverFlash = flash.timeLeft > 0 ? flash : nil
        }
        if var toast = assistToast {
            toast.timeLeft -= frameDt
            assistToast = toast.timeLeft > 0 ? toast : nil
        }
        if var h = handoff {
            h.timeLeft -= frameDt
            handoff = h.timeLeft > 0 ? h : nil
        }
        if var call = defenceCall {
            call.timeLeft -= frameDt
            defenceCall = call.timeLeft > 0 ? call : nil
        }
        if var call = cutCall {
            call.timeLeft -= frameDt
            cutCall = call.timeLeft > 0 ? call : nil
        }
        if var refused = refusedTap {
            refused.timeLeft -= frameDt
            refusedTap = refused.timeLeft > 0 ? refused : nil
        }
        // The hitstop's own fuse and its cooldown, burned in real seconds rather than
        // slowed ones — a 0.35 s hitstop that lasted 0.35 s of *game* time would run for
        // the better part of a second on the clock the player lives on.
        clock.endFrame()
    }

    // MARK: gesture

    private func throwGesture(in size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { g in
                // The disc left the hand while the thumb was down: the stall count reached
                // ten, or the point ended. There is no throw to aim any more, so the
                // gesture is *cancelled* rather than merely ignored — see `cancelDrag`.
                guard match.holder != nil else { return cancelDrag() }
                // The first frame of a gesture starts the charge. `hold` runs on the
                // frame clock from here — see `FrameClock`, and `advance`.
                clock.beginCharge()
                drag = interpret(from: g.startLocation, to: g.location, in: size)
            }
            .onEnded { _ in
                guard match.holder != nil, let d = drag else { return cancelDrag() }
                // The abort. `ThrowGesture` has no say here on purpose: it is a pure
                // function of a drag's numbers and it is right that *if* a release is
                // made, an 8 pt drag is a throw. Whether to make one is this file's
                // decision, and a thumb that came back to where it started has said no.
                guard !d.aborted else {
                    lastDragEnd = "cancel"
                    return cancelDrag()
                }
                // The charge, cashed in. The window narrows with the throw's own
                // difficulty — a blade is 1.60× harder to release cleanly than a
                // backhand — which is what makes the hard throws hard rather than
                // merely differently shaped.
                let charge = ThrowGesture.charge(for: d.type)
                let held = clock.hold
                let grade = charge.grade(hold: held)
                let quality = charge.quality(hold: held)
                let thrown = match.humanRelease(
                    d.type, aim: d.aim, power: d.power, loft: d.loft, quality: quality)
                cancelDrag()
                lastDragEnd = thrown ? "throw" : "refused"
                guard thrown else { return }
                // The one fact about the throw that nothing else keeps: `clock.hold` was
                // just zeroed by `cancelDrag`, and the grade is on screen for 1.2 s and not
                // at all on the plateau. See `MatchProbe`.
                lastRelease = Released(type: d.type, hold: held, grade: grade)
                // Written down at the tick that has not run yet, which is where a replay
                // will apply it — see `Replay.swift` on why the two are the same state
                // transition. Only a throw the engine accepted is recorded, so the tape
                // holds what happened rather than what was attempted.
                inputs.append(
                    RecordedInput(
                        tick: tickCount,
                        input: .charged(
                            throwType: d.type.rawValue,
                            aimX: d.aim.x, aimY: d.aim.y, aimZ: d.aim.z,
                            power: d.power, loft: d.loft, quality: quality)))
                Feel.play(.release(grade))
                // Read after the release, not before: `humanRelease` is what runs the
                // cone select and the assist, and `selectedReceiver` and `lastAssist`
                // are its answer. Asking the preview instead would report what the drag
                // meant a frame ago rather than what the throw actually did.
                if let assist = match.lastAssist {
                    let slot = match.selectedReceiver
                        .flatMap { id in match.players.firstIndex { $0.id == id } }
                    assistToast = AssistToast.make(
                        assist, jersey: slot.map(jersey), grade: grade)
                }
            }
    }

    /// One tap, two meanings, decided by who has the disc.
    ///
    /// There is no mode here and no modifier: on defence the tap is `defend()` and on
    /// offence it is `callCut(at:)`, and the two can never both apply because one needs
    /// them holding it and the other needs us holding it. Both engine entry points refuse
    /// silently when their situation is not the live one, so the routing does not have to
    /// be exhaustive — it only has to try the right one first.
    ///
    /// **What is no longer silent is the refusal.** Both halves still refuse for the same
    /// reasons and the engine is unchanged; what changed is that a refused tap now says so at
    /// the point of the tap, and says *which* reason, because the reasons ask for different
    /// things from the player. See `RefusedTap`, and `MatchHUD.refusedOverlay`.
    private func tap(at point: CGPoint, in size: CGSize) {
        guard running else { return }
        if match.possession != 0 || match.holder == nil {
            defend(at: point)
            return
        }
        callCut(at: point, in: size)
    }

    /// Send a teammate into the space you just pointed at.
    ///
    /// **The problem this fixes is that off the disc there was nothing to do.** Two of the
    /// three phases had input — the drag on the disc, the tap on defence — and the third,
    /// which is most of a possession, was watching seven bodies play without you. What was
    /// missing was never a movement system: `Playbook.buildCut` builds the routes and
    /// `TeamAIOffence` runs them. What was missing was a way to *ask*.
    ///
    /// So the tap picks a **space** and the engine picks the body: see
    /// `Engine.humanCallCut` for why that is the right way round for this sport and for the
    /// thumb. This file's whole job is turning a screen point into a point on the grass —
    /// `MatchScene.groundPoint` — and a refusal into silence.
    ///
    /// **A tap is an order, so a tap always means something.** The cone was chosen for a
    /// *drag*, where the player is aiming along a line and the disc has to go where they
    /// pointed; a tap is a point on a pitch with two team-mates on it, and 35 degrees of
    /// either side of it names nobody most of the time. Measured with a finger, roughly one
    /// tap in three found a body on minis and the other two did nothing at all.
    ///
    /// So when the cone comes back empty this widens it to the whole half of the pitch the
    /// finger was pointing at and sends the nearest team-mate to that heading — see
    /// `nearestCutter(toward:)`. It is the same command with a different point in it:
    /// `humanCallCut` runs its own cone select over the substituted heading, keeps the veto
    /// on a body that is unavailable or too close to pass to, and may still pick a *different*
    /// team-mate if the lane and distance terms prefer one. Nothing in the engine changed and
    /// nothing but the tap path can reach this — a drag still means exactly where it points,
    /// because there the direction is the throw.
    ///
    /// The 90 degrees is the whole of the widening and it is deliberately not 180: past a
    /// right angle the runner the game picked would be behind the space the player pointed
    /// at, which is a worse answer than NOBODY THERE.
    private func callCut(at point: CGPoint, in size: CGSize) {
        offenceTaps += 1
        guard let camera = scene.camera,
            let at = Self.groundPoint(tap: point, in: size, camera: camera)
        else { return refuse(.offPitch, at: point) }

        if let called = match.humanCallCut(atX: at.x, atZ: at.z) {
            return accept(called, aimedAt: at)
        }

        // Why not. `Engine.canCallCut` is the engine's own answer to the three refusals that
        // are about the *situation* rather than the direction — so if it says the call was
        // available, an empty cone is the only thing left, and the widening is worth trying.
        guard match.canCallCut else { return refuse(situationalRefusal(), at: point) }
        guard let alternative = nearestCutter(toward: at) else {
            return refuse(.nobodyThere, at: point)
        }
        // The team-mate's own position as the aim, which is a heading the cone cannot refuse:
        // zero degrees of angular error against a body it has already been told is available.
        let aim = (x: alternative.pos.x, z: alternative.pos.z)
        guard let called = match.humanCallCut(atX: aim.x, atZ: aim.z) else {
            // A body was named and `TeamAI.commandCut` had no route to give them. Rare, and a
            // different sentence: pointing somewhere else is the fix, waiting is not.
            return refuse(.noRoute, at: point)
        }
        widenedCalls += 1
        accept(called, aimedAt: aim)
    }

    /// Record an accepted call and say who is going.
    ///
    /// **The recorded point is the one the engine was actually given**, not the one the finger
    /// landed on, because `ReplayInput.callCut` carries a point and replays it through this
    /// same `humanCallCut` — a tape holding the raw tap would resolve a different cone on the
    /// way back and desync. The widening therefore happens once, here, and the tape is a list
    /// of headings the engine accepted.
    private func accept(_ called: Engine.CalledCut, aimedAt at: (x: Double, z: Double)) {
        inputs.append(
            RecordedInput(tick: tickCount, input: .callCut(x: at.x, z: at.z)))
        Prefs.cutUsed = true
        refusedTap = nil
        let slot = match.players.firstIndex { $0.id == called.receiver }
        cutCall = CutCall(
            jersey: slot.map(jersey), kind: called.kind, timeLeft: CutCall.duration)
        Feel.play(.commit)
    }

    /// Which of `humanCallCut`'s situational refusals applied, for a tap that got as far as
    /// the grass and was still turned down.
    ///
    /// Read off the engine's own public state in the same order the engine tests them, so the
    /// words on screen cannot claim a reason the engine did not have. It is only ever called
    /// once `canCallCut` is false, so one of these three is true by construction; the fall
    /// through is the cooldown, which is the one the engine keeps to itself.
    ///
    /// **One read is coarser than the engine's own and knowingly so.** `canCallCut` tests
    /// `GameState`'s fine phase (`livePossession`), and the only phase this side of the package
    /// boundary is `Engine.phase`, which folds `check` and `turnoverDead` into `.live`. So a
    /// tap during the stoppage after a call, with the disc back in our hand, reads as TOO SOON
    /// rather than NOT IN PLAY — the same instruction (wait), a less exact reason. Fixing it
    /// properly means the engine saying why it refused, which is `EngineHuman`'s to give and
    /// not this file's to guess: see the report on this change.
    private func situationalRefusal() -> RefusedTap.Reason {
        if match.phase != .live { return .notLive }
        if match.holder != match.controlled { return .notYours }
        return .tooSoon
    }

    /// The team-mate nearest in heading to the space the player pointed at, within a right
    /// angle of it.
    ///
    /// A read-only pass over the same facts the engine's own select reads — team, id,
    /// availability, and `HumanTargeting.selectMinRange`, taken from the engine rather than
    /// copied — so a body this picks is a body the cone will accept when it is handed that
    /// heading. `Engine.recovery` is availability: it is non-nil exactly while locomotion has
    /// a body committed to a layout, a fall or the scrape off the grass.
    private func nearestCutter(toward at: (x: Double, z: Double)) -> AIPlayer? {
        guard let held = match.holder, let thrower = match.body(of: held) else { return nil }
        let dx = at.x - thrower.pos.x
        let dz = at.z - thrower.pos.z
        let aim = (dx * dx + dz * dz).squareRoot()
        guard aim > 1e-3 else { return nil }

        var best: AIPlayer?
        // cos 90°, so a team-mate square to the aim is already out.
        var bestCosine = 0.0
        for p in match.players where p.team == thrower.team && p.id != held {
            guard match.recovery(of: p.id) == nil else { continue }
            let vx = p.pos.x - thrower.pos.x
            let vz = p.pos.z - thrower.pos.z
            let d = (vx * vx + vz * vz).squareRoot()
            guard d >= HumanTargeting.selectMinRange else { continue }
            let cosine = (vx * dx + vz * dz) / (d * aim)
            if cosine > bestCosine {
                bestCosine = cosine
                best = p
            }
        }
        return best
    }

    /// Say no, where the thumb was.
    ///
    /// The counters are for the measurement this change exists to make: `offenceTaps` against
    /// `refusals` is the hit rate a finger actually gets, and `widenedCalls` is how much of it
    /// the widening bought. They are read by the probe and by nothing else — see `MatchProbe`.
    private func refuse(_ reason: RefusedTap.Reason, at point: CGPoint) {
        refusals += 1
        lastRefusal = reason
        refusalTally[reason.rawValue, default: 0] += 1
        refusedTap = RefusedTap(reason: reason, at: point, timeLeft: RefusedTap.duration)
    }

    /// The defensive half of the control scheme, and the whole of it: send your best
    /// defender at the disc.
    ///
    /// **The problem this fixes is that the opponent's possession was a cutscene.** The
    /// player had one gesture, it required holding the disc, and the disc is in the other
    /// team's hand for roughly half of every point — so half the game was watching. A tap
    /// was free input the whole time: the throw is a drag with an 8 pt floor, so nothing
    /// on offence has ever wanted one.
    ///
    /// What it commits and why is `Engine.humanDefend`'s decision, not this file's: the
    /// engine picks by time-to-reach the point that matters and moves `controlled` to
    /// whoever it sent, which is what makes the chevron, the control ring and the handoff
    /// pulse all say who is going without any of them being told about defence.
    ///
    /// A refused tap no longer passes in silence, but it is still not scolded: no haptic
    /// fires on a refusal and the words are grey. Taps are cheap and constant on a
    /// touchscreen — one during our own possession is somebody's palm, not a command — so
    /// buzzing at it would be the game telling the player off for holding the phone. Saying
    /// quietly which of the two defensive refusals happened is a different thing: `NOT IN
    /// PLAY` and `NOBODY UP` are the difference between waiting and having already spent
    /// your defenders.
    private func defend(at point: CGPoint) {
        guard running else { return }
        guard let commit = match.humanDefend() else {
            // Three refusals, in the order `humanDefend` tests them: the point is not running;
            // the disc is ours or nobody's, so there is nothing to chase and no thrower to
            // call a cut off; or everybody who could have gone is on the floor.
            if match.phase != .live { return refuse(.notLive, at: point) }
            if match.possession == 0 { return refuse(.discUnsettled, at: point) }
            return refuse(.everybodyDown, at: point)
        }
        refusedTap = nil
        // A tap that committed somebody is an input; a tap that was refused changed
        // nothing and is not one. `humanDefend` refuses identically on replay, so either
        // choice would restore correctly — recording only the taps that did something
        // keeps the tape a list of what happened.
        inputs.append(RecordedInput(tick: tickCount, input: .defend))
        Prefs.defenceUsed = true
        let slot = match.players.firstIndex { $0.id == commit.defender }
        defenceCall = DefenceCall(
            jersey: slot.map(jersey), kind: commit.kind, timeLeft: DefenceCall.duration)
        Feel.play(.commit)
    }

    /// The pinned gesture `-charge` asks for, if it asked for one. A drag up and to the
    /// right of a plausible thrower, which reads as a flat forehand at about two-thirds
    /// power — enough of a drag to name a throw type and fill a power bar, which is what
    /// the screenshot is for.
    private func demoDrag(in size: CGSize) -> DragState? {
        guard demoCharge != nil else { return nil }
        return interpret(
            from: CGPoint(x: size.width * 0.34, y: size.height * 0.62),
            to: CGPoint(x: size.width * 0.62, y: size.height * 0.50),
            in: size)
    }

    /// The hold the meter should draw: the real one, or the pinned one.
    var meterHold: Double { demoCharge ?? clock.hold }

    /// Put the gesture down: no aim line, no power bar, no charge.
    ///
    /// **Every way out of a drag comes through here.** A completed throw, a release the
    /// engine refused, a thumb that came home to cancel, a holder who stopped being one
    /// mid-gesture, a release delivered when there is no longer a drag to release, the app
    /// leaving the foreground — which SwiftUI does not reliably follow with `onEnded` at
    /// all — the tap that ends a pause, and a match being restarted or restored.
    ///
    /// Two of those used to `return` without clearing anything, and the resulting
    /// state was terminal: `drag` stayed non-nil for the rest of the match, which pinned
    /// the aim overlay on screen, kept the grass arrow pointed at whoever had the disc —
    /// including the other team — and, because the old `onChanged` only zeroed the charge
    /// when `drag` was nil, graded **every subsequent throw of the match** as
    /// `.overcharged` no matter what the player did with the meter. Nothing but a restart
    /// or a restore could clear it.
    func cancelDrag() {
        if drag != nil { drag = nil }
        if clock.charging { clock.endCharge() }
    }

    /// Turn a drag into a throw. The rule itself lives in `ThrowGesture`, in the sim,
    /// where the checks can reach it — this only supplies the numbers.
    private func interpret(from start: CGPoint, to current: CGPoint, in size: CGSize) -> DragState {
        let dx = Double(current.x - start.x)
        let dy = Double(current.y - start.y)
        let g = ThrowGesture.interpret(
            dx: dx, dy: dy, shortEdge: Double(Swift.min(size.width, size.height)))
        let aim = ThrowGesture.aim(dx: dx, dy: dy, attackDir: match.attackDirection(of: 0))
        return DragState(
            start: start, current: current, type: g.type, power: g.power, loft: g.loft, aim: aim,
            aborted: Foundation.hypot(dx, dy) <= Self.cancelRadius)
    }

    // MARK: scene

    /// Squad numbers. Arbitrary, but stable and not sequential, because 1-2-3-4-5-6 reads
    /// as a diagram and 4-7-11-23 reads as a team.
    /// A `static let`, because this is called once per player when the scene is built and
    /// then once per drawn frame for the jersey number beside a drag — and an array
    /// literal in the body is a fresh fourteen-element allocation every time it is
    /// evaluated.
    static let jerseyNumbers = [4, 7, 11, 23, 2, 18, 9, 31, 5, 14, 8, 21, 3, 27]

    func jersey(_ index: Int) -> Int {
        Self.jerseyNumbers[index % Self.jerseyNumbers.count]
    }

    /// Tear the match down and start a new one on `setup`'s pitch, at its length and its
    /// difficulty. Every restart — the sheet's START, the result card's REMATCH — comes
    /// through here, so none of them can forget a piece of per-match state.
    ///
    /// A restart is a new match, so it draws a new seed — otherwise restarting would be
    /// the one path back to the compiled-in default and its identical wind and rosters.
    private func restart(_ setup: MatchSetup) {
        // Starting a game throws the old one away, and that includes the copy of it on
        // disk. A saved match that outlived the decision to start a new one would be
        // offered again on the next launch, which is the app arguing with the last thing
        // the player told it.
        MatchSave.clear()
        resumable = nil
        restoreNote = nil
        inputs.removeAll()
        clearedAtEnd = false
        restoring = nil

        // This is the moment, and the only moment besides `adopt`, that a chosen setup
        // becomes the setup a match is being *played* under. See `playedSetup`.
        playedSetup = setup

        seed = Self.freshSeed()
        match = Engine(
            format: setup.fieldSpec.gameFormat, seed: seed, config: setup.engineConfig)
        cancelDrag()
        // Every render cache the new match invalidates, in one call — see
        // `MatchScene.invalidate`, and the three-copy reset list it replaced.
        scene.invalidate()
        tickCount = 0
        clock.reset()
        turnoverFlash = nil
        assistToast = nil
        handoff = nil
        defenceCall = nil
        cutCall = nil
        // The refusal and the tap ledger belong to the match that was being played, not to the
        // one starting: a REMATCH that opened with "NOBODY THERE" still on screen would be the
        // new match answering the old match's tap.
        refusedTap = nil
        offenceTaps = 0
        refusals = 0
        widenedCalls = 0
        lastRefusal = nil
        refusalTally = [:]
        lastControlled = match.controlled
        // A rematch is a resume: whatever paused the old match has been dealt with by
        // the time somebody taps a button on the result card.
        paused = false
    }
}
