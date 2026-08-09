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
    @State private var paused = false

    @State private var match: Engine
    @State private var drag: DragState? = nil

    /// The match settings, as last chosen — length, format, difficulty. Loaded from
    /// `Prefs` at construction and written back whenever a match starts from them, so the
    /// second launch opens on the game you were playing rather than on the defaults.
    ///
    /// **This is the sheet's copy, and it is editable while a match is running.**
    /// `PreGameSheet` binds to it and writes every tap through live, and the gear on the
    /// scoreboard opens that sheet mid-point. Nothing here is the setup the match on
    /// screen is being played under — see `playedSetup`.
    @State private var setup: MatchSetup

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
    @State private var playedSetup: MatchSetup

    /// Whether the pre-game sheet is up. True at launch, because a game should be chosen
    /// before it is played; true again whenever the sheet is reopened from the scoreboard
    /// or from the result card.
    @State private var showSetup: Bool

    /// Whether the coach cards are up. Set once on the first launch that has never seen
    /// them, and set again by the sheet's HOW TO PLAY button.
    @State private var showCoach = false

    /// Whether the sheet, if dismissed, has a match to fall back onto. False before the
    /// first pull; true forever after, since a match — running, paused or finished —
    /// exists from then on.
    @State private var hasStarted = false

    /// The seed this match was built from. Freshly drawn from the clock for every new
    /// match — including the format-switch restart — so no two launches replay the same
    /// wind and rosters. Deliberately not shown anywhere yet; it is kept so a later
    /// result screen can display it, and so the match stays a pure function of
    /// `(format, seed, inputs)` exactly as `Replay.swift` requires. All randomness
    /// enters the engine through this one number.
    @State private var seed: UInt32

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
    @State private var inputs: [RecordedInput] = []

    /// The saved match found on disk at launch, while it is still on offer. Cleared the
    /// moment it is resumed, discarded, or superseded by a new match.
    ///
    /// Note what this is *not*: proof that the save can be restored. That costs a canary
    /// simulation to establish and is paid in `resume`, off the launch path — see
    /// `SimFingerprint`. This is the offer; the check is what happens when it is accepted.
    @State private var resumable: SavedMatch?

    /// How far a restore has got, 0…1, while one is running. Non-nil is what draws the
    /// veil, so a replay of twenty minutes of match is a progress bar rather than a
    /// freeze.
    @State private var restoring: Double?

    /// Why the last save was thrown away, if it was. Shown on the sheet, because a
    /// RESUME button that silently does nothing is worse than no button.
    @State private var restoreNote: String?

    /// Whether the save has already been cleared for this finished match, so the result
    /// overlay's arrival does not try to delete a file once per tick.
    @State private var clearedAtEnd = false

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
    @State private var clock = FrameClock()

    /// Whole simulation ticks executed so far. The trail sampler keys off this, because
    /// the trail should sample the flight, not the display.
    @State private var tickCount = 0
    /// Phase for the chevron's bob, advanced by wall time rather than by frame count so
    /// the bob speed does not depend on the display's refresh rate.
    @State private var bobPhase = 0.0

    /// The one and only step the simulation is advanced by. 1/120 is the regime the
    /// entire validation suite runs at (see `Replay.swift`), so it is the regime the
    /// shipped game runs at. Named here as well because the recording carries the rate
    /// and `saveMatch` settles the tick with it.
    private static let tickHz = FrameClock.tickHz
    private static let tickDt = FrameClock.tickDt

    /// Recent disc positions while it is in the air, oldest first. Collected in the tick
    /// loop rather than in the render pass, because the render pass runs once per drawn
    /// frame and a trail should sample the flight, not the frame rate.
    @State private var trail: [SIMD3<Float>] = []

    /// The turnover being shouted about, while there is one. Its `timeLeft` is burned
    /// down by wall time in `advance`, so the shout lasts 1.5 s at any refresh rate.
    ///
    /// Built from `Engine.drainEvents()` rather than from a box-score diff — see
    /// `TurnoverFlash`, and `MatchEvent` for why the surface is a drained buffer.
    @State private var turnoverFlash: TurnoverFlash? = nil

    /// The defender the player has just sent at the disc, while it is worth saying so.
    /// See `DefenceCall`.
    @State private var defenceCall: DefenceCall? = nil

    /// What the aim assist did to the last throw, while it is still worth saying.
    @State private var assistToast: AssistToast? = nil
    /// The control swap being announced, while there is one.
    @State private var handoff: Handoff? = nil
    /// Who had control at the end of the previous tick, so a change can be noticed.
    /// `Engine.controlled` moves silently on every catch and every turnover.
    @State private var lastControlled = 0

    /// Entity handles, looked up once when the scene is built.
    ///
    /// `sync` used to rebuild a `[String: Entity]` from `content.entities` on every
    /// frame — a dictionary allocation and a full walk of the scene roots, 120 times a
    /// second, to find nine entities that never move between roots. The scene graph is
    /// built exactly once per format, so the handles are taken exactly once per format.
    @State private var refs = SceneRefs()

    /// Which rung of the ground mark's opacity ramp is currently on the mark. Cached so
    /// the material is only assigned when it actually changes, which for a disc sitting
    /// in someone's hand is never.
    @State private var markStep = -1

    /// Which control ring currently wears which treatment, so the twelve dashes are only
    /// repainted when the answer actually changes. See `sync`.
    @State private var ringDimmed = false
    @State private var ringPainted = -1

    /// Bumped once per rendered frame purely so SwiftUI knows something happened.
    ///
    /// `Match` is a `final class` — deliberately, since passing a match around must not
    /// silently copy it — and SwiftUI does not observe mutations through a class
    /// reference. Without this the sim ticks correctly and the screen never redraws,
    /// which looks exactly like a frozen simulation and is not one. The frame counter is
    /// the honest fix: the view depends on the tick, and the tick depends on the clock.
    @State private var frame = 0

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
    private struct DragState {
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

    /// The handful of entities `sync` writes to every frame, held by reference.
    ///
    /// A class, and `@State`, because the two halves of a `RealityView` are separate
    /// closures: `build` makes the entities and `update` moves them, and there is no
    /// value type that can carry a handle from one to the other without SwiftUI copying
    /// it. Populated in `build` — including on a rebuild, when the format changes and
    /// every field is overwritten with the new scene's entities.
    @MainActor
    final class SceneRefs {
        var players: Entity?
        var rings: Entity?
        var targets: Entity?
        var chevron: Entity?
        var disc: Entity?
        var mark: ModelEntity?
        var post: Entity?
        var trail: Entity?
        var arrow: Entity?
        var preview: Entity?
        var bidMark: Entity?
        var pulse: ModelEntity?
        var camera: PerspectiveCamera?
        var focus: Entity?
    }

    public init(
        format: FieldSpec? = nil, active: Bool = true, skipsSetup: Bool = false,
        demoCharge: Double? = nil, autoDefend: Bool = false, saveCycle: Double? = nil
    ) {
        self.active = active
        self.autoDefend = autoDefend
        self.formatOverride = format
        self.skipsSetup = skipsSetup
        self.demoCharge = demoCharge
        self.saveCycle = saveCycle

        // The saved game, read off disk before anything is drawn. A file read of a few
        // kilobytes, and deliberately *only* a file read: whether it can actually be
        // restored is a question that costs a simulation to answer, and the launch path
        // is not where that is paid. See `resumable`.
        _resumable = State(initialValue: MatchSave.load())

        // The saved setup, with the launch argument — when there is one — overriding the
        // format it names and nothing else.
        var chosen = Prefs.loadSetup() ?? MatchSetup()
        if let format { chosen.format = format.teamSize <= 3 ? .minis : .full }
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
                // Defence, on a tap. Simultaneous rather than sequenced, and safe to be:
                // the throw is a `DragGesture(minimumDistance: 8)`, so a tap is input the
                // offence has never used and cannot use — there is no gesture to lose.
                //
                // `SpatialTapGesture` rather than `onTapGesture` only because the drag is
                // attached with `.gesture` and the two want to be siblings; the location
                // it reports is deliberately ignored. A tap on a phone is a *call*, not an
                // aim — you are telling a defender to go, not picking a spot on the grass
                // with a thumb that covers four metres of it. Where to go is a question
                // the engine can answer better than a finger can.
                .simultaneousGesture(
                    SpatialTapGesture().onEnded { _ in defend() })
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

        bobPhase += frameDt * 3.6

        // The finger a headless run does not have. See `autoDefend`.
        if autoDefend, match.defensiveCommit == nil { defend() }

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
            // spent before the screen has drawn it. The debt is kept — one tick of it,
            // anyway — so nothing is lost, only deferred to the next frame, where it
            // will be paid at the slowed rate like everything else.
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
        // The hitstop's own fuse and its cooldown, burned in real seconds rather than
        // slowed ones — a 0.35 s hitstop that lasted 0.35 s of *game* time would run for
        // the better part of a second on the clock the player lives on.
        clock.endFrame()
    }

    private func recordTrail() {
        guard match.discInFlight else {
            if !trail.isEmpty { trail.removeAll() }
            return
        }
        // Every fourth tick — 30 Hz of flight, the same cadence the old 60 Hz loop's
        // every-other-frame sampling gave. Twenty-two beads at 60 Hz would be a quarter
        // of a second of flight, which reads as a smear on the disc rather than as a
        // path it took.
        guard tickCount % 4 == 0 else { return }
        let p = match.disc.state.pos
        trail.append([Float(p.x), Float(p.y), Float(p.z)])
        if trail.count > PitchScene.trailLength { trail.removeFirst() }
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
                guard !d.aborted else { return cancelDrag() }
                // The charge, cashed in. The window narrows with the throw's own
                // difficulty — a blade is 1.60× harder to release cleanly than a
                // backhand — which is what makes the hard throws hard rather than
                // merely differently shaped.
                let charge = ThrowGesture.charge(for: d.type)
                let grade = charge.grade(hold: clock.hold)
                let quality = charge.quality(hold: clock.hold)
                let thrown = match.humanRelease(
                    d.type, aim: d.aim, power: d.power, loft: d.loft, quality: quality)
                cancelDrag()
                guard thrown else { return }
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
    /// A refused tap is silent. Taps are cheap and constant on a touchscreen — one during
    /// our own possession is somebody's palm, not a command — and buzzing at it would be
    /// the game telling the player off for holding the phone.
    private func defend() {
        guard running, let commit = match.humanDefend() else { return }
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
    private var meterHold: Double { demoCharge ?? clock.hold }

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
    private func cancelDrag() {
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

    private func build(_ content: RealityViewCameraContent) {
        let f = match.fieldSpec
        content.add(PitchScene.decor(f))

        let players = Entity()
        players.name = "players"
        let rings = Entity()
        rings.name = "rings"
        let targets = Entity()
        targets.name = "targets"
        for (i, p) in match.players.enumerated() {
            // A jersey number per player. Derived from the roster slot so a replay of the
            // same seed puts the same number on the same runner.
            players.addChild(PitchScene.player(team: p.team, number: jersey(i)))
            let ring = PitchScene.controlRing()
            ring.isEnabled = false
            rings.addChild(ring)
            let target = PitchScene.targetRing(team: p.team)
            target.isEnabled = false
            targets.addChild(target)
        }
        content.add(players)
        content.add(rings)
        content.add(targets)
        refs.players = players
        refs.rings = rings
        refs.targets = targets

        let chevron = PitchScene.chevron()
        content.add(chevron)
        refs.chevron = chevron

        let disc = PitchScene.disc()
        content.add(disc)
        refs.disc = disc

        let mark = PitchScene.groundMark()
        content.add(mark)
        refs.mark = mark
        markStep = -1

        let post = PitchScene.altitudePost()
        post.isEnabled = false
        content.add(post)
        refs.post = post

        let trailRoot = PitchScene.trail()
        content.add(trailRoot)
        refs.trail = trailRoot

        let arrow = PitchScene.aimArrow()
        arrow.isEnabled = false
        content.add(arrow)
        refs.arrow = arrow

        let preview = Self.previewBracket()
        preview.isEnabled = false
        content.add(preview)
        refs.preview = preview

        let bidMark = Self.bidMarker()
        bidMark.isEnabled = false
        content.add(bidMark)
        refs.bidMark = bidMark

        let pulse = PitchScene.handoffPulse()
        pulse.isEnabled = false
        content.add(pulse)
        refs.pulse = pulse

        for light in PitchScene.lights(f) { content.add(light) }

        // Behind-and-above the attacking direction, which for Ultimate is the view that
        // shows the field the thrower is throwing into. High enough that the whole pitch
        // fits without needing to pan, because a camera that moves while you are aiming
        // changes what your drag means mid-gesture.
        let camera = PerspectiveCamera()
        // A slightly longer lens than the 50° this started with. At 50 the pitch was a
        // small trapezoid in the middle of the frame with a third of the screen given
        // over to grass nobody plays on. 38 was better still for the pitch and pushed the
        // horizon off the top, which threw away the sky; 44 keeps both.
        camera.camera.fieldOfViewInDegrees = 44
        content.add(camera)
        refs.camera = camera

        // The eased look-at point, parked in the scene graph rather than in `@State`.
        // Rebuilding the scene has to reset the camera's easing along with everything
        // else, and scene-graph state resets for free; view state does not.
        let focus = Entity()
        let want = cameraTarget()
        focus.position = want.at
        camera.look(at: want.at, from: want.from, relativeTo: nil)
        content.add(focus)
        refs.focus = focus
    }

    /// Squad numbers. Arbitrary, but stable and not sequential, because 1-2-3-4-5-6 reads
    /// as a diagram and 4-7-11-23 reads as a team.
    private func jersey(_ index: Int) -> Int {
        let numbers = [4, 7, 11, 23, 2, 18, 9, 31, 5, 14, 8, 21, 3, 27]
        return numbers[index % numbers.count]
    }

    /// Where the camera wants to be. Behind the attacking direction, at about the height
    /// of a low stand.
    ///
    /// The first attempt put the camera at 0.62 of the field length up and looked at the
    /// centre. That is a tactics board, not a broadcast: from near-overhead a standing
    /// player foreshortens into a disc on the grass, and you lose the one thing a 3D view
    /// buys over a top-down one, which is being able to see how high the disc is.
    ///
    /// So: low enough that players stand up in frame, aimed downfield of the disc rather
    /// than at the centre circle, because the space you are throwing into is the part
    /// worth looking at. It tracks the disc laterally as well, so play on a sideline is
    /// not permanently in the corner of the screen.
    ///
    /// It is anchored to the disc rather than to a fraction of the disc's position, which
    /// is what the first version did. At 0.35 of the disc's z the camera hung around the
    /// middle of the pitch and a thrower on their own end line was cut in half by the
    /// bottom of the screen; the offsets below hold the disc at a constant two-thirds of
    /// the way down the frame wherever play is, which is both readable and steadier to
    /// watch. It still does not move while you aim, because a held disc does not move.
    private func cameraTarget() -> (from: SIMD3<Float>, at: SIMD3<Float>) {
        let f = match.fieldSpec
        let dir = Float(match.attackDirection(of: 0))
        let length = Float(f.length)
        let z = Float(match.disc.state.pos.z)
        // Lateral follow is deliberately partial. Full tracking centres the disc and
        // slides the pitch across the screen every time somebody runs to a sideline,
        // which reads as the world moving rather than the camera.
        let lateral = Float(match.disc.state.pos.x) * 0.25
        return (
            from: [lateral, length * 0.26, z - dir * length * 0.44],
            at: [lateral, 1.2, z + dir * length * 0.27]
        )
    }

    /// The teammate the cone select currently judges the drag to mean, if any.
    ///
    /// Computed fresh rather than stored: `Engine.previewReceiver` is strictly
    /// read-only and runs the *same* cone select the release will run, so asking it
    /// every frame keeps the highlight live as receivers run through the cone — and a
    /// derived value cannot go stale the way a stored one can. No drag, no preview;
    /// the highlight clears the instant the gesture ends, aborts, or the disc leaves
    /// the hand, because all of those make `drag` nil or `previewReceiver` return nil.
    private var previewedReceiver: Int? {
        // An aborted drag names nobody, because it is about to throw nobody the disc.
        guard let d = drag, !d.aborted else { return nil }
        return match.previewReceiver(dx: d.aim.x, dz: d.aim.z)
    }

    /// The bracket drawn under the previewed receiver while you drag. Four corner
    /// dashes rather than the control ring's twelve or the target ring's solid disc,
    /// so all three markers stay tellable apart at a glance — and in the gesture's own
    /// orange, so it reads as part of the throw you are lining up, not as a state of
    /// the world. Built here rather than in `PitchScene` because it exists purely for
    /// the drag, which this file owns.
    private static func previewBracket() -> Entity {
        let root = Entity()
        let dash = MeshResource.generateBox(size: [0.34, 0.025, 0.08])
        let material = UnlitMaterial(color: .orange)
        for i in 0..<4 {
            let theta = (Float(i) + 0.5) / 4 * 2 * .pi
            let seg = ModelEntity(mesh: dash, materials: [material])
            seg.position = [0.85 * sin(theta), 0, 0.85 * cos(theta)]
            seg.orientation = simd_quatf(angle: theta, axis: [0, 1, 0])
            root.addChild(seg)
        }
        return root
    }

    /// The spot a committed defender has been sent to, drawn on the grass.
    ///
    /// A cross rather than a ring, and in the defence's blue rather than the gesture's
    /// orange, because the pitch already carries three rings — control, target and the
    /// drag's preview bracket — and a fourth would be one more thing to tell apart in the
    /// half second a flight lasts. It says one thing the plate cannot: *where*, which on a
    /// bid is the difference between a defender who is about to arrive and one who has
    /// been sent at a disc they will never touch.
    private static func bidMarker() -> Entity {
        let root = Entity()
        let bar = MeshResource.generateBox(size: [1.5, 0.02, 0.10])
        let material = PitchScene.unlit(PitchScene.Palette.control, opacity: 0.8)
        for i in 0..<2 {
            let seg = ModelEntity(mesh: bar, materials: [material])
            seg.orientation = simd_quatf(angle: Float(i) * .pi / 2, axis: [0, 1, 0])
            root.addChild(seg)
        }
        return root
    }

    /// The teammate a live throw is heading for, if there is one.
    ///
    /// "Nearest to the disc right now" rather than a predicted landing point: predicting
    /// would mean re-integrating the flight here, and a second copy of the flight model
    /// in the renderer is exactly the thing this project refuses to have.
    private var incomingReceiver: Int? {
        guard let thrower = match.thrower,
            let team = match.players.first(where: { $0.id == thrower })?.team
        else { return nil }
        let d = match.disc.state.pos
        return match.players.indices
            .filter { match.players[$0].team == team && $0 != thrower }
            .min {
                Foundation.hypot(match.players[$0].pos.x - d.x, match.players[$0].pos.z - d.z)
                    < Foundation.hypot(match.players[$1].pos.x - d.x, match.players[$1].pos.z - d.z)
            }
    }

    /// Move everything the simulation moved.
    ///
    /// The entity handles come from `refs`, taken when the scene was built. They used to
    /// come from a dictionary rebuilt out of `content.entities` on every frame; the
    /// scene has one root per named thing and those roots are never replaced except by
    /// a full rebuild, so the dictionary was an allocation and a scene walk per frame to
    /// learn something that had not changed since launch.
    private func sync(_ content: RealityViewCameraContent) {
        let receiver = incomingReceiver

        if let players = refs.players, let rings = refs.rings, let targets = refs.targets {
            for (i, p) in match.players.enumerated() where i < players.children.count {
                let body = players.children[i]
                body.position = [Float(p.pos.x), 0, Float(p.pos.z)]
                // Face the way you are running; if stationary, face the disc.
                let facing =
                    p.vel.lengthSq > 0.04
                    ? p.vel
                    : Vec3d(match.disc.state.pos.x - p.pos.x, 0, match.disc.state.pos.z - p.pos.z)
                if facing.lengthSq > 1e-6 {
                    let yaw = Foundation.atan2(facing.x, facing.z)
                    // Lean into the run. Purely cosmetic and bounded at about ten
                    // degrees: it is what separates a sprint from a glide at a glance,
                    // and it pivots about the feet so nobody sinks into the pitch.
                    let lean = Float(Swift.min(1, p.vel.length / 7.0)) * 0.18
                    body.orientation =
                        simd_quatf(angle: Float(yaw), axis: [0, 1, 0])
                        * simd_quatf(angle: lean, axis: [1, 0, 0])
                }
                if i < rings.children.count {
                    let ring = rings.children[i]
                    ring.position = [Float(p.pos.x), 0.022, Float(p.pos.z)]
                    ring.isEnabled = (i == match.controlled)
                    // Dimmed while this body cannot act — §4's legible layout cost. Only
                    // the controlled ring is ever drawn, so only it is ever repainted,
                    // and only on the two frames a match where the answer changes.
                    if i == match.controlled {
                        let dim = match.recovery(of: p.id) != nil
                        // Keyed on the ring as well as the treatment: control moves, and
                        // a cache that only remembered "dimmed" would leave the previous
                        // player's ring painted at 40% for the rest of the match.
                        if dim != ringDimmed || i != ringPainted {
                            ringDimmed = dim
                            ringPainted = i
                            let material = PitchScene.controlRingRamp[dim ? 1 : 0]
                            for seg in ring.children {
                                (seg as? ModelEntity)?.model?.materials = [material]
                            }
                        }
                    }
                }
                if i < targets.children.count {
                    let target = targets.children[i]
                    target.position = [Float(p.pos.x), 0.018, Float(p.pos.z)]
                    target.isEnabled = (i == receiver)
                }
            }
        }

        if let chevron = refs.chevron, match.controlled < match.players.count {
            let p = match.players[match.controlled]
            // A slow bob, so it is findable by movement as well as by colour. Phased by
            // wall time (advanced in `advance`), not by frame count, so it bobs at the
            // same speed on a 120 Hz display as on a 60 Hz one.
            let bob = Foundation.sin(bobPhase) * 0.06
            chevron.position = [Float(p.pos.x), Float(2.28 + bob), Float(p.pos.z)]
        }

        if let disc = refs.disc {
            let d = match.disc.state
            // A held disc sits at the holder's own position, which puts it inside their
            // torso and therefore invisible — you could not tell who had it. Offset it to
            // an extended arm for display only; the sim's position is untouched, so
            // nothing about the throw or the catch changes.
            var shown = Vec3d(d.pos.x, Swift.max(d.pos.y, 0.02), d.pos.z)
            if let h = match.holder {
                let p = match.players[h]
                // Out to the side, away from the middle of the pitch, the way a thrower
                // holds it away from the mark.
                let side = p.pos.x >= 0 ? 1.0 : -1.0
                shown = Vec3d(p.pos.x + side * 0.42, 1.15, p.pos.z + 0.16)
            }
            disc.position = [Float(shown.x), Float(shown.y), Float(shown.z)]
            // The sim's body +Z is the disc normal; a RealityKit cylinder's axis is +Y.
            // One fixed quarter turn reconciles them and nothing else is corrected, which
            // is what makes this a rendering of the simulation rather than an animation
            // that resembles one.
            let q = d.orient
            let sim = simd_quatf(ix: Float(q.x), iy: Float(q.y), iz: Float(q.z), r: Float(q.w))
            disc.orientation = sim * simd_quatf(angle: .pi / 2, axis: [1, 0, 0])
        }

        if let mark = refs.mark {
            mark.position = [Float(match.disc.state.pos.x), 0.024, Float(match.disc.state.pos.z)]
            let alpha = Swift.max(
                PitchScene.groundMarkFaintest,
                PitchScene.groundMarkDarkest - Float(match.disc.state.pos.y) * 0.03)
            // A rung off the pre-baked ramp, and only when the rung changed. This line
            // used to allocate a fresh `UnlitMaterial` every frame — including the long
            // stretches where the disc is in somebody's hand and the number it encodes
            // has not moved at all.
            let step = PitchScene.groundMarkStep(alpha)
            if step != markStep {
                markStep = step
                mark.model?.materials = [PitchScene.groundMarkRamp[step]]
            }
        }

        // The handoff pulse: one expanding ring on whoever just took control. Position
        // is re-read every frame rather than frozen at the swap, because in the third of
        // a second this lasts the player is running.
        if let pulse = refs.pulse {
            if let h = handoff, h.to < match.players.count {
                let p = match.players[h.to]
                pulse.isEnabled = true
                pulse.position = [Float(p.pos.x), 0.02, Float(p.pos.z)]
                pulse.scale = .init(repeating: Float(0.7 + 2.3 * h.progress))
                pulse.model?.materials = [PitchScene.handoffRamp[PitchScene.handoffStep(h.progress)]]
            } else {
                pulse.isEnabled = false
            }
        }

        if let post = refs.post {
            let inFlight = match.discInFlight
            let h = Float(match.disc.state.pos.y)
            post.isEnabled = inFlight && h > 0.6
            post.position = [Float(match.disc.state.pos.x), h / 2, Float(match.disc.state.pos.z)]
            post.scale = [1, Swift.max(h, 0.001), 1]
        }

        if let trailRoot = refs.trail {
            // Slot 0 holds the oldest sample and has the faintest material, so the trail
            // is filled from the end of the array backwards.
            let n = trailRoot.children.count
            for slot in 0..<n {
                let idx = trail.count - n + slot
                if idx >= 0 && idx < trail.count {
                    trailRoot.children[slot].position = trail[idx]
                    trailRoot.children[slot].isEnabled = true
                } else {
                    trailRoot.children[slot].isEnabled = false
                }
            }
        }

        if let arrow = refs.arrow {
            // An aborted drag keeps its line on screen — greyed, and saying CANCEL — but
            // takes its arrow off the grass. The arrow is a claim about where the disc is
            // going, and it is going nowhere.
            if let d = drag, !d.aborted, let h = match.holder {
                let p = match.players[h]
                // Roughly how far this power carries. An approximation on purpose — the
                // exact range needs the aero solved, and a arrow that lies by a metre is
                // still worth more than no arrow.
                let reach = Float(4 + d.power * 30)
                arrow.isEnabled = true
                arrow.position = [Float(p.pos.x), 0.03, Float(p.pos.z)]
                arrow.orientation = simd_quatf(
                    angle: Float(Foundation.atan2(d.aim.x, d.aim.z)), axis: [0, 1, 0])
                if let shaft = arrow.children.first(where: { $0.name == "shaft" }) {
                    shaft.scale = [1, 1, reach]
                    shaft.position = [0, 0, reach / 2]
                }
                if let head = arrow.children.first(where: { $0.name == "head" }) {
                    head.position = [0, 0, reach + 0.4]
                }
            } else {
                arrow.isEnabled = false
            }
        }

        // The cone-select preview. Enabled only while a drag names somebody, which is
        // also the only time the disc is held — so this and the in-flight target ring
        // can never draw at once: the release that starts the flight is the same event
        // that ends the drag and clears this.
        if let bracket = refs.preview {
            if let r = previewedReceiver, let p = match.players.first(where: { $0.id == r }) {
                bracket.isEnabled = true
                bracket.position = [Float(p.pos.x), 0.026, Float(p.pos.z)]
                // A slow pulse and creep, phased by wall time like the chevron's bob,
                // so it moves at the same speed at any refresh rate. Movement is what
                // makes "the pick just changed" visible in peripheral vision while the
                // eye is on the drag.
                bracket.scale = .init(repeating: Float(1 + 0.08 * Foundation.sin(bobPhase * 2.4)))
                bracket.orientation = simd_quatf(angle: Float(bobPhase * 0.45), axis: [0, 1, 0])
            } else {
                bracket.isEnabled = false
            }
        }

        // Where the committed defender was sent. Enabled only while a commitment is live,
        // which is at most 1.6 s and only ever on defence — so this and the drag's preview
        // bracket can no more draw at once than a throw and a defensive tap can happen at
        // once.
        if let mark = refs.bidMark {
            if let commit = match.defensiveCommit {
                mark.isEnabled = true
                mark.position = [Float(commit.at.x), 0.028, Float(commit.at.z)]
                // Spun by wall time, like the preview bracket, so it is findable in
                // peripheral vision while the eye is on the disc.
                mark.orientation = simd_quatf(angle: Float(bobPhase * 0.9), axis: [0, 1, 0])
            } else {
                mark.isEnabled = false
            }
        }

        if let cam = refs.camera, let focus = refs.focus {
            let want = cameraTarget()
            var from = cam.position
            var at = focus.position
            // Ease, except when the whole view is supposed to change — a turnover that
            // swaps ends should cut, not sweep the camera the length of the pitch.
            if simd_distance(from, want.from) > Float(match.fieldSpec.length) * 0.35 {
                from = want.from
                at = want.at
            } else {
                // Time-based exponential smoothing. The old constant here was 0.10 per
                // frame, which assumed 60 fps frames — on a 120 Hz ProMotion display it
                // would ease twice as fast. `1 - exp(-rate * frameDt)` converges to the
                // same curve at any refresh rate; rate = 60 * -ln(0.9) ≈ 6.32 /s is
                // exactly what 0.10-per-frame was at 60 fps.
                let blend = Float(1 - Foundation.exp(-6.32 * clock.frameDt))
                from = simd_mix(from, want.from, SIMD3(repeating: blend))
                at = simd_mix(at, want.at, SIMD3(repeating: blend))
            }
            focus.position = at
            cam.look(at: at, from: from, relativeTo: nil)
        }
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
        trail.removeAll()
        tickCount = 0
        clock.reset()
        turnoverFlash = nil
        assistToast = nil
        handoff = nil
        defenceCall = nil
        lastControlled = match.controlled
        markStep = -1
        // A rematch is a resume: whatever paused the old match has been dealt with by
        // the time somebody taps a button on the result card.
        paused = false
    }

    // MARK: putting the match down and picking it up

    /// Write the match down, so killing the app does not end it.
    ///
    /// The recording is the seed and the inputs and nothing else; see `MatchSave` and
    /// `Replay.swift`. Three things are true of this function and worth stating:
    ///
    /// **It refuses to save a match there is no point saving.** A game that has not
    /// started, or that has already finished, is cleared rather than written — the file
    /// exists to answer "is there a game to come back to", and a file that says yes when
    /// the answer is no costs the player a tap and a lie.
    ///
    /// **It settles the tick first.** An input is stamped with the tick that has not run
    /// yet, so a throw released between two ticks is stamped at `tickCount` while the
    /// live match has already applied it. A recording that stopped at `tickCount` would
    /// strand that input — the restore would replay a match in which the throw never
    /// happened, land somewhere else, and be discarded by its own checksum. Stepping the
    /// pending ticks costs the player 1/120 s of a match they have just left, and buys the
    /// recording and the live match the same length.
    ///
    /// **It writes what it can and complains about nothing.** See `MatchSave.write`.
    private func saveMatch() {
        // A restore in flight is *replaying the very file this would delete*. The save
        // path runs on every `scenePhase` change, and `.inactive` is enough — it fires for
        // a notification banner, a Control Centre swipe, an incoming call — so during the
        // one-to-eight seconds of the replay bar the old code reached the `else` below and
        // removed the match it was in the middle of rebuilding. It survived in memory, so
        // nothing looked wrong; an OS kill in that window lost it with no file to return
        // to. There is nothing to write yet and nothing to clear: leave the disk alone.
        guard restoring == nil else { return }
        guard hasStarted, !match.isOver else {
            MatchSave.clear()
            return
        }
        // Consume anything stamped at or past the current tick. At most one tick's worth
        // in practice, because inputs arrive between frames and a frame is at least one
        // tick — the loop is written as a loop so it cannot be wrong if that changes.
        while let last = inputs.last?.tick, last >= tickCount {
            match.step(dt: Self.tickDt)
            tickCount &+= 1
        }
        guard tickCount > 0 else {
            MatchSave.clear()
            return
        }

        let recording = Recording(
            seed: seed,
            field: RecordedField(match.fieldSpec),
            tickHz: Self.tickHz,
            autoTeams: match.autoTeams.sorted(),
            durationTicks: tickCount,
            inputs: inputs)
        // `playedSetup`, emphatically not `setup`. The sheet's copy is editable *while a
        // match is running* — open the gear mid-point, flick FORMAT to see what 7v7 says,
        // tap BACK — and a save stamped with what the sheet last showed describes a match
        // nobody played. See `playedSetup` for the two ways that ended.
        let saved = SavedMatch(
            fingerprint: MatchSave.fingerprint(for: playedSetup),
            recording: recording,
            checksum: MatchChecksum(match, tick: tickCount),
            setup: MatchSave.encode(playedSetup))
        MatchSave.write(saved)
    }

    /// Rebuild a saved match and hand it back to the player.
    ///
    /// Restoring means *replaying*: the engine is built again from the seed and the setup,
    /// and the recorded inputs are fed back through the same `humanRelease` and
    /// `humanDefend` the thumb drove, tick by tick, until the tape runs out. There is no
    /// shortcut, because there is no state dump to load — and that is the trade this whole
    /// design makes, a few kilobytes on disk against some seconds of arithmetic.
    ///
    /// Measured, in `MatchSaveTests` and therefore also on the device's own Checks tab:
    /// a release build replays 3v3 at about 17,000 ticks per second, so half a minute of
    /// match comes back in a quarter of a second and a full twenty-minute game takes
    /// single-digit seconds. The `SimFingerprint` canary that decides whether the save is
    /// even ours costs another 48 ms on top, once.
    ///
    /// So it is done in chunks with the screen alive between them. The work is bounded by
    /// wall time rather than by a tick count, so a slow device draws the same progress bar
    /// as a fast one instead of a longer freeze.
    ///
    /// **Every failure discards the save.** A stale fingerprint, a checksum that does not
    /// match, a recording that will not validate: all three mean this build cannot
    /// faithfully reproduce the match the player left, and the only honest options are to
    /// say so and start fresh. Resuming into a match that has quietly diverged — the same
    /// score, a disc somewhere else — is the outcome this refuses to produce.
    private func resume(_ saved: SavedMatch) {
        guard restoring == nil else { return }
        restoreNote = nil
        restoring = 0
        showSetup = false
        showCoach = false

        // The setup the match was played under outranks the one on the sheet. Resuming a
        // 7v7 game to seven into a 3v3 engine would not be a restore.
        let played = MatchSave.decodeSetup(saved.setup) ?? setup
        setup = played

        Task { @MainActor in
            let engine = Engine(
                format: played.fieldSpec.gameFormat, seed: saved.recording.seed,
                config: played.engineConfig)
            do {
                let restore = try MatchRestore(
                    saved, fingerprint: MatchSave.fingerprint(for: played), engine: engine)
                while !restore.isFinished {
                    // A slice of work, then the screen. 24 ms is under two frames at 60 Hz
                    // and under three at 120, so the bar moves smoothly and the replay is
                    // never interrupted for longer than it takes to draw it.
                    let until = DispatchTime.now().uptimeNanoseconds + 24_000_000
                    while !restore.isFinished, DispatchTime.now().uptimeNanoseconds < until {
                        restore.advance(ticks: 256)
                    }
                    restoring = restore.progress
                    // A real suspension, not a `yield`: SwiftUI has to get a turn to draw
                    // the number that just changed, and a yield hands control back to a
                    // task queue rather than to a frame.
                    try? await Task.sleep(nanoseconds: 4_000_000)
                }
                adopt(try restore.finish(), from: saved, setup: played)
            } catch {
                MatchSave.clear()
                resumable = nil
                restoring = nil
                restoreNote = Self.restoreNote(for: error)
                showSetup = true
            }
        }
    }

    /// Take a restored match as the live one.
    ///
    /// Everything `restart` resets is reset here too, for the same reason: per-match state
    /// that survives a match change is state that lies. What is *not* reset is the pair
    /// that makes the restored match saveable again — the tick count and the input list
    /// come from the recording, so putting the game down a second time writes a tape that
    /// continues the first rather than starting from the middle.
    private func adopt(_ restored: Engine, from saved: SavedMatch, setup played: MatchSetup) {
        match = restored
        seed = saved.recording.seed
        inputs = saved.recording.inputs
        tickCount = saved.recording.durationTicks
        // The setup this match is now being played under is the one it was played under
        // before it was put down — not whatever the sheet happens to be showing.
        playedSetup = played

        cancelDrag()
        trail.removeAll()
        clock.reset()
        turnoverFlash = nil
        assistToast = nil
        handoff = nil
        defenceCall = nil
        lastControlled = restored.controlled
        markStep = -1
        clearedAtEnd = false

        hasStarted = true
        resumable = nil
        restoring = nil
        // Landing paused, exactly as returning from the background does. A player who has
        // just watched a progress bar is not looking at the pitch yet, and dropping them
        // into a live point mid-stall is how a restore gets blamed for a turnover. One
        // tap, and it is their game again.
        paused = true
    }

    /// What to tell the player about a save that could not be restored.
    ///
    /// Short, and specific enough to be a bug report. "The game has changed" is the
    /// common case and the one worth naming plainly: it is nobody's fault, it will happen
    /// on any update that touches the simulation, and a player who is told the truth about
    /// it once will not wonder whether the app lost their game.
    private static func restoreNote(for error: Error) -> String {
        switch error {
        case RestoreError.staleSim:
            "SAVED GAME WAS PLAYED ON AN OLDER BUILD — IT CANNOT BE REPLAYED EXACTLY"
        case RestoreError.diverged:
            "SAVED GAME DID NOT REPLAY TO WHERE IT WAS LEFT — DISCARDED"
        case RestoreError.unsupportedSave:
            "SAVED GAME IS IN A FORMAT THIS BUILD DOES NOT READ"
        default:
            "SAVED GAME COULD NOT BE READ — DISCARDED"
        }
    }

    /// The one line the RESUME button says about what is being resumed.
    private static func resumeSummary(_ saved: SavedMatch) -> String {
        let s = saved.checksum.score
        let minutes = Int(saved.seconds / 60)
        let clock = minutes >= 1 ? "\(minutes) MIN IN" : "JUST STARTED"
        return "\(s[0])–\(s[1]) · \(clock)"
    }

    // MARK: hud

    /// Corner darkening. Cheap, and it does most of the work of making a flat green
    /// rectangle look photographed rather than drawn. Sized from the view rather than a
    /// constant, so it lands in the same place on a phone and on an iPad.
    private func vignette(in size: CGSize) -> some View {
        RadialGradient(
            gradient: Gradient(stops: [
                .init(color: .clear, location: 0.42),
                .init(color: .black.opacity(0.14), location: 0.74),
                .init(color: .black.opacity(0.42), location: 1.0),
            ]),
            center: .center, startRadius: 0,
            endRadius: Foundation.hypot(size.width, size.height) * 0.58
        )
        .ignoresSafeArea()
    }

    private var scoreboard: some View {
        HStack(spacing: 14) {
            Text("YOU \(match.score[0])")
                .foregroundStyle(Color(red: 0.45, green: 0.72, blue: 1))
            Text("—").foregroundStyle(.white.opacity(0.35))
            Text("\(match.score[1]) THEM")
                .foregroundStyle(Color(red: 1, green: 0.48, blue: 0.42))

            windIndicator

            Spacer()

            // The stall count is the clock that matters, so it is the one that is shown.
            // It only exists while someone is holding, which is also the only time it
            // means anything.
            if match.holder != nil {
                Text("STALL \(Int(match.stall))")
                    .foregroundStyle(match.stall > 6 ? .orange : .white.opacity(0.7))
            } else if let team = match.justScored {
                Text(team == 0 ? "GOAL" : "THEIR POINT")
                    .foregroundStyle(team == 0 ? .green : .orange)
            }

            Text("first to \(match.fieldSpec.target)")
                .foregroundStyle(.white.opacity(0.4))

            // Where the format buttons used to be. They were two of the three match
            // settings, wedged into a scoreboard, and each tap silently binned the point
            // being played; the third setting did not exist at all. All three now live on
            // the pre-game sheet, and this is the door to it — it stops the match on the
            // way in, so nothing is thrown away by looking.
            Button {
                showSetup = true
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 13, weight: .bold))
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 5).fill(.white.opacity(0.12)))
                    .foregroundStyle(.white.opacity(0.75))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("match settings")
        }
        .font(.system(.subheadline, design: .monospaced).bold())
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        // A backing plate, because the sky behind the top of the screen is now a dusk
        // gradient rather than near-black and white-on-orange is not a score you can read.
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(.black.opacity(0.45))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(.white.opacity(0.10), lineWidth: 1))
        )
        .padding(.horizontal, 16)
        .padding(.top, 12)
    }

    /// Which way the wind is blowing, and how hard.
    ///
    /// Every match draws its own wind and every huck is bent by it, and until this it was
    /// shown nowhere at all — so a throw that faded out of a receiver's hands read as the
    /// flight model being capricious. It is a small thing on the scoreboard rather than a
    /// banner because it is a standing condition, not an event: you want to be able to
    /// find it, not to be told it.
    ///
    /// The arrow is oriented in the camera's frame, not the world's — see `WindReadout`
    /// for the derivation. An arrow pointing up the screen means the wind is going the
    /// way you are attacking; pointing down means you are throwing into it.
    @ViewBuilder private var windIndicator: some View {
        let speed = WindReadout.speed(match.wind)
        // Under a tenth of a metre per second is not weather, and drawing an arrow for it
        // would be a direction the player could act on that does not exist.
        if speed > 0.1 {
            HStack(spacing: 4) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 11, weight: .black))
                    .rotationEffect(
                        WindReadout.bearing(match.wind, attackDir: match.attackDirection(of: 0)))
                Text(String(format: "%.1f", speed))
            }
            .font(.system(size: 12, design: .monospaced).bold())
            .foregroundStyle(.white.opacity(0.55))
            .padding(.leading, 4)
            .accessibilityLabel("wind \(String(format: "%.1f", speed)) metres per second")
        }
    }

    /// What the aim assist did, for about as long as it takes to see the disc leave.
    ///
    /// Deliberately not in the middle of the screen: the goal and turnover callouts live
    /// there, and this fires on *every* throw. It sits under the scoreboard, on the same
    /// plate treatment, small — it is a read-out you learn to glance at, not a shout.
    @ViewBuilder private var assistReadout: some View {
        if let toast = assistToast {
            VStack(spacing: 1) {
                Text(toast.title)
                    .font(.system(size: 15, weight: .heavy, design: .monospaced))
                    .foregroundStyle(toast.color)
                Text(toast.detail)
                    .font(.system(size: 11, design: .monospaced).bold())
                    .foregroundStyle(.white.opacity(0.6))
                // The timing half of the throw, when it is worth mentioning. Silent on
                // the plateau — see `AssistToast.ReleaseLine`.
                if let release = toast.release {
                    Text(release.text)
                        .font(.system(size: 10, design: .monospaced).bold())
                        .foregroundStyle(
                            release.perfect
                                ? Color(red: 0.5, green: 1, blue: 0.62) : .orange.opacity(0.85))
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(.black.opacity(0.5))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(.white.opacity(0.10), lineWidth: 1)))
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, 62)
            .allowsHitTesting(false)
            .transition(.opacity)
        }
    }

    /// The defensive call, and then the bill for it.
    ///
    /// Two states in one place, at the foot of the screen where the thumb is, because they
    /// are two halves of one sentence: *this player is going* → *this player is on the
    /// floor for another 1.4 s*. The first is the order; the second is `§4`'s legible
    /// layout cost, and putting them anywhere but the same spot would make the cost read
    /// as unrelated to the decision that bought it.
    ///
    /// The recovery line outranks the call, because by the time a body is down the order
    /// is history and the only fact left is when you get them back. It is read straight
    /// off `Engine.recovery`, i.e. off locomotion's own countdown, rather than off a timer
    /// started here — a HUD clock that has to agree with a simulation clock is a HUD clock
    /// that will not.
    @ViewBuilder private var defenceReadout: some View {
        if let seconds = match.recovery(of: match.controlled) {
            defencePlate(
                title: "DOWN",
                tint: .orange,
                detail: String(format: "BACK UP IN %.1fs", seconds))
        } else if let call = defenceCall {
            defencePlate(
                title: call.title,
                tint: Color(red: 0.45, green: 0.72, blue: 1),
                detail: call.detail)
        }
    }

    private func defencePlate(title: String, tint: Color, detail: String) -> some View {
        VStack(spacing: 1) {
            Text(title)
                .font(.system(size: 15, weight: .heavy, design: .monospaced))
                .foregroundStyle(tint)
            Text(detail)
                .font(.system(size: 11, design: .monospaced).bold())
                .foregroundStyle(.white.opacity(0.6))
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(.black.opacity(0.5))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .strokeBorder(.white.opacity(0.10), lineWidth: 1)))
        // Padding inside the expanding frame, not outside it: a `.padding` wrapped
        // *around* an infinite frame makes the whole thing taller than its parent, and an
        // overflowing child gets centred rather than pinned — which is how this plate
        // spent its first screenshot in the middle of the pitch on top of the turnover
        // callout.
        .padding(.bottom, 96)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .allowsHitTesting(false)
        .transition(.opacity)
    }

    /// The one line that tells a player defence exists.
    ///
    /// Shown only while the other team has the disc, only before anything has been
    /// committed, and only until they have used it — after which it would be a permanent
    /// caption on half of every point. The coach cards teach the tap properly; this is the
    /// prompt at the moment it is usable, which is the only moment a prompt is worth
    /// anything.
    @ViewBuilder private var defenceHint: some View {
        if match.possession != 0, match.holder != nil || match.discInFlight,
            defenceCall == nil, match.defensiveCommit == nil, !Prefs.defenceUsed,
            !match.isOver
        {
            Text("TAP TO ATTACK THE DISC")
                .font(.system(size: 11, design: .monospaced).bold())
                .foregroundStyle(.white.opacity(0.55))
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 7).fill(.black.opacity(0.45)))
                .padding(.bottom, 96)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .allowsHitTesting(false)
        }
    }

    /// The paused state. One tap resumes, and until it comes the accumulator is not fed —
    /// see `advance`.
    private var pausedOverlay: some View {
        ZStack {
            Color.black.opacity(0.55)
            VStack(spacing: 6) {
                Text("PAUSED")
                    .font(.system(size: 26, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.9))
                Text("TAP TO RESUME")
                    .font(.system(size: 13, design: .monospaced).bold())
                    .foregroundStyle(.orange)
            }
        }
        .ignoresSafeArea()
        .contentShape(Rectangle())
        // The tap that ends the pause is also the last chance to throw away anything
        // measured against a moment that is gone: a drag whose `onEnded` never came, and a
        // hitstop frozen part-way through its 0.45 s. `FrameClock.abandon` has already
        // taken both — every paused frame runs it — and `cancelDrag` takes the drag state
        // the clock cannot see. Doing it here as well is what makes the resume path
        // *state* rather than a side effect of the pause path still ticking.
        .onTapGesture {
            paused = false
            cancelDrag()
        }
    }

    /// The match being rebuilt.
    ///
    /// A restore replays the whole game from its first tick, which is fast but not
    /// instant — a long match is a few seconds of arithmetic — and a few seconds of
    /// nothing is indistinguishable from a hang. So it says what it is doing and shows how
    /// far it has got, on the same plate treatment as the pause veil, because it is the
    /// same kind of thing: the pitch, stopped, with a reason.
    ///
    /// The bar is honest. It is `ticks replayed / ticks recorded`, not a timer dressed up
    /// as progress, so it slows down where the simulation does.
    private func restoringOverlay(_ progress: Double) -> some View {
        ZStack {
            Color.black.opacity(0.72)
            VStack(spacing: 10) {
                Text("RESTORING MATCH")
                    .font(.system(size: 20, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.9))
                Text("REPLAYING \(Int(progress * 100))%")
                    .font(.system(size: 12, design: .monospaced).bold())
                    .foregroundStyle(.orange)
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.16)).frame(width: 180, height: 6)
                    Capsule().fill(Color.orange)
                        .frame(width: Swift.max(2, 180 * progress), height: 6)
                }
                .frame(width: 180, height: 6)
            }
        }
        .ignoresSafeArea()
        // It takes the taps, so a thumb waiting on the bar cannot throw the disc of the
        // match being rebuilt underneath it.
        .contentShape(Rectangle())
        .onTapGesture {}
    }

    /// The two things worth interrupting the pitch for: a point, and the turnover that
    /// prevented one. A goal outranks a turnover — a Callahan is both at once, and the
    /// score is the half worth shouting.
    @ViewBuilder private var callout: some View {
        if let team = match.justScored {
            calloutPlate(
                title: team == 0 ? "GOAL" : "THEIR POINT",
                tint: team == 0 ? Color(red: 0.5, green: 1, blue: 0.62) : .orange,
                subtitle: "\(match.score[0]) — \(match.score[1])")
        } else if let flash = turnoverFlash {
            calloutPlate(
                title: flash.text,
                tint: flash.good ? Color(red: 0.5, green: 1, blue: 0.62) : .orange,
                subtitle: flash.good ? "YOUR DISC" : "THEY HAVE IT")
        }
    }

    /// The shared shout. A plate rather than a drop shadow: the first version was 46pt
    /// of unbacked text across the middle of the pitch — it announced the goal and hid
    /// the players who had just scored it.
    private func calloutPlate(title: String, tint: Color, subtitle: String) -> some View {
        VStack(spacing: 3) {
            Text(title)
                .font(.system(size: 30, weight: .heavy, design: .monospaced))
                .foregroundStyle(tint)
            Text(subtitle)
                .font(.system(size: 16, design: .monospaced).bold())
                .foregroundStyle(.white.opacity(0.75))
        }
        .padding(.horizontal, 22).padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(.black.opacity(0.5))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(.white.opacity(0.10), lineWidth: 1)))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(false)
        .transition(.opacity)
    }

    /// The aim line. Drawn in view space rather than in the scene because it is a
    /// statement about your gesture, not about the world — and because it must be legible
    /// against turf at any camera distance. The world-space half of the answer, the arrow
    /// on the grass, is in `PitchScene`.
    private func aimOverlay(_ d: DragState, in size: CGSize) -> some View {
        // Back inside the cancel radius: the whole gesture goes grey and the label stops
        // describing a throw. The line stays drawn rather than vanishing, because the
        // thumb is still down and a gesture that disappears under a finger reads as the
        // game having lost the touch rather than as the throw being off.
        let tint: Color = d.aborted ? .white.opacity(0.55) : .orange
        return ZStack {
            Path { p in
                p.move(to: d.start)
                p.addLine(to: d.current)
            }
            .stroke(.black.opacity(0.45), style: StrokeStyle(lineWidth: 7, lineCap: .round))

            Path { p in
                p.move(to: d.start)
                p.addLine(to: d.current)
            }
            .stroke(
                d.aborted
                    ? LinearGradient(colors: [tint, tint], startPoint: .top, endPoint: .bottom)
                    : LinearGradient(
                        colors: [.orange.opacity(0.25), .orange],
                        startPoint: .top, endPoint: .bottom),
                style: StrokeStyle(
                    lineWidth: 4, lineCap: .round,
                    dash: d.aborted ? [5, 5] : []))

            // The anchor, so it is obvious the throw comes from where you started and not
            // from where your thumb happens to be. It is also the cancel target, so while
            // the drag is aborted it is filled rather than outlined — the one place the
            // player is being told the gesture has a home.
            Circle()
                .strokeBorder(tint.opacity(0.7), lineWidth: 2)
                .background(Circle().fill(d.aborted ? .white.opacity(0.16) : .clear))
                .frame(width: 22, height: 22)
                .position(d.start)

            VStack(spacing: 3) {
                if d.aborted {
                    Text("CANCEL")
                        .font(.system(size: 13, design: .monospaced).bold())
                    Text("RELEASE TO KEEP IT")
                        .font(.system(size: 10, design: .monospaced).bold())
                        .foregroundStyle(.white.opacity(0.55))
                } else {
                    Text("\(d.type.rawValue.uppercased())  \(Int(d.power * 100))%")
                        .font(.system(size: 13, design: .monospaced).bold())
                    // Who the cone select currently means — the same pick the bracket on
                    // the grass is standing under, named here because a jersey number is
                    // readable when the receiver themselves is a few pixels tall.
                    if let r = previewedReceiver,
                        let idx = match.players.firstIndex(where: { $0.id == r })
                    {
                        Text("TO #\(jersey(idx))")
                            .font(.system(size: 11, design: .monospaced).bold())
                            .foregroundStyle(.orange.opacity(0.85))
                    }
                    Capsule()
                        .fill(.orange.opacity(0.25))
                        .frame(width: 74, height: 4)
                        .overlay(alignment: .leading) {
                            Capsule().fill(.orange).frame(width: 74 * d.power, height: 4)
                        }
                    chargeMeter(for: d.type)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 7).fill(.black.opacity(0.7)))
            .foregroundStyle(tint)
            .position(x: d.current.x, y: d.current.y - 34)
        }
        .allowsHitTesting(false)
    }

    /// The charge meter: a bar that fills while you hold, and a bright band you are
    /// trying to let go inside.
    ///
    /// It sits directly under the power bar, is the same width, and is the only other
    /// thing by the thumb — so the two halves of a throw read as one instrument. The band
    /// is drawn from `targetHold` and `targetHalfWidth` live (`ThrowCharge.fullTime` and
    /// `perfectWindow`), which means it *visibly narrows and shifts* when the drag
    /// crosses into a hammer or a blade. That is the lesson: the harder throw is not
    /// merely a different arc, it is a smaller window.
    ///
    /// The bar runs to a little past the end of the grace rather than to `maxHold`. Two
    /// seconds of track would put the band at 42% of it and give three-fifths of the
    /// meter to a region no one should ever be in.
    @ViewBuilder private func chargeMeter(for type: ThrowType) -> some View {
        let charge = ThrowGesture.charge(for: type)
        let span = charge.fullTime + charge.overGrace + 0.25
        let width = 74.0
        let progress = Swift.min(1, meterHold / span)
        let perfect = charge.isPerfect(hold: meterHold)
        let inWindow = charge.inWindow(hold: meterHold)
        let bandX = width * (charge.fullTime - charge.perfectWindow) / span
        let bandW = width * (2 * charge.perfectWindow) / span
        let green = Color(red: 0.5, green: 1, blue: 0.62)
        let fill: Color = perfect ? .white : (inWindow ? green : .orange)

        ZStack(alignment: .leading) {
            Capsule().fill(.white.opacity(0.16)).frame(width: width, height: 6)
            // The window. Always visible, because a target you can only see once you
            // have hit it is not a target you can aim at.
            Capsule()
                .fill(green.opacity(perfect ? 0.95 : 0.5))
                .frame(width: Swift.max(3, bandW), height: 6)
                .offset(x: bandX)
            Capsule().fill(fill).frame(width: width * progress, height: 6)
            // The head, so the exact instant is readable at a glance rather than by
            // judging the end of a bar against a band behind it.
            Capsule()
                .fill(.white)
                .frame(width: 2, height: 10)
                .offset(x: Swift.max(0, width * progress - 1))
        }
        .frame(width: width, height: 10)
        .overlay(alignment: .trailing) {
            if charge.isOvercharged(hold: meterHold) {
                Text("HELD")
                    .font(.system(size: 8, design: .monospaced).bold())
                    .foregroundStyle(.orange)
                    .offset(y: -11)
            }
        }
    }
}
