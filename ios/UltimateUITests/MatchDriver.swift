import XCTest

/// The app, launched into a live match, plus the two things a touch test needs that the
/// screen alone will not give it: a way to read the match state, and a way to wait for a
/// moment when a control is legal.
///
/// **The whole of the harness is here so the tests can be about touches.** Each test is one
/// gesture and one assertion about what the game did; everything about getting to a state
/// where that gesture means something lives in this file.
///
/// The state comes from `MatchProbe` — a single `Text` the app draws only under
/// `-probe on`, holding `k=v;k=v`. Reading it is an accessibility query, so it is slower
/// than a variable and never faster than a frame; every wait here is therefore expressed as
/// a deadline rather than a sleep, and every poll is a fresh read.
struct MatchDriver {

    let app: XCUIApplication

    // MARK: - infrastructure attribution
    //
    // **Four failure modes must be distinguishable in the test report** (issue #46):
    // boot failure, launch failure, app-process loss, and a genuine gesture assertion.
    // The boot step is in the workflow; the other three are detected here. Each has a
    // distinct message prefix so a reader of the `.xcresult` can tell them apart without
    // guessing — "BOOT FAILURE", "LAUNCH FAILURE", "PROCESS LOSS", "PACING TIMEOUT".

    /// The app's bundle identifier, for diagnostics that name the app.
    private static let appIdentifier = "com.grahamsiener.ultimate"

    /// Mutable attribution state held in a reference type so `let match = MatchDriver()`
    /// in the tests does not need to become `var` — `MatchDriver` is a struct, and
    /// marking every method `mutating` would be a wider change than the diagnostics
    /// justify.
    final class Attribution {
        /// Set when `poll` or `probe` discovers the app process is gone. A caller that
        /// would emit a gesture-assertion `XCTFail` checks this first (via `fail`) and
        /// emits a process-loss diagnostic instead — so a crash is never reported as
        /// "four drags recorded no throw".
        var processLost = false
        /// When the last successful probe read happened, for the pacing-timeout diagnostic.
        var lastProbeAt: Date?
        /// The last probe value seen, for the process-loss diagnostic.
        var lastKnownState = ""
    }

    private let attribution = Attribution()

    /// Launch into a live match with the probe on.
    ///
    /// `-setup off` skips the pre-game sheet, which is the wall a launch argument was
    /// invented to climb and which a UI test could actually tap through — but tapping START
    /// on every test would mean every test also verifies the sheet, and a shared failure is
    /// a worse signal than five separate ones. `-points 9` buys a long enough game that a
    /// test waiting for its third possession does not run into full time.
    ///
    /// **`-receive` is the argument that made this suite fast, and every test states which
    /// side of it it wants.** `Engine.init` gives the opening pull to the human's team, so
    /// with no argument our first live possession is one whole opponent possession away —
    /// measured at 25–64 s, against waits that were therefore 90 s. `us` flips the coin
    /// toss: the opponent pulls, we receive, and the disc is in our hand within a few
    /// seconds of launch. `them` is the same statement in the other direction, for the
    /// defensive tap. It is a *default* here rather than a per-test argument for the tests
    /// that throw, because a test that forgets to say is a test that waits a minute.
    ///
    /// See `UltimateApp.startingPullTeam`, and
    /// `.agents/friction-log/20260810-waittothrow-waits-for` for the measurement.
    init(receives: Possession = .us) {
        Self.announce()
        let app = XCUIApplication()
        app.launchArguments =
            ["-setup", "off", "-probe", "on", "-points", "9", "-receive", receives.rawValue]
        app.launch()
        self.app = app

        // The coach cards, and the probe, waited for **together**.
        //
        // The cards are shown once per install, which on a simulator means once per fresh
        // clone of the device — so a suite meets them on exactly one run and then never
        // again, which is the worst possible frequency for something that blocks every input
        // on the screen. Skipping is what a player does with the same button.
        //
        // **The two waits are one wait because a `waitForExistence` that fails costs its whole
        // timeout.** Waiting for the skip button first meant that on every run after the first
        // — which is every run — each of the eleven tests paid the full coach timeout for a
        // button that was never going to appear, before it even started looking for the probe.
        // Racing them costs whichever arrives, which is the probe.
        //
        // Queried through locals rather than through `probeElement`, because a stored property
        // is still uninitialised at this point and reaching for `self` to read one computed
        // property does not compile. The queries are the same ones.
        let probe = app.descendants(matching: .any).matching(identifier: "match.probe").firstMatch
        // **Launch and readiness are separate diagnostics** (VAL-CI-003). The app not
        // running after `launch()` is a launch failure — the process never started or died
        // immediately. The app running but the probe never appearing is a readiness timeout
        // — the process is alive but never reached a frame. Both are infrastructure, not
        // gesture assertions, and each names the step and the device.
        guard Self.ready(app) else {
            let device = Self.deviceIdentity()
            if app.state == .notRunning {
                XCTFail(
                    "LAUNCH FAILURE: \(Self.appIdentifier) is not running after launch "
                        + "(state: \(app.state)) on \(device)")
            } else {
                XCTFail(
                    "LAUNCH FAILURE: \(Self.appIdentifier) launched but the probe never "
                        + "appeared within \(Int(Self.patience))s "
                        + "(slowdown ×\(String(format: "%.1f", Self.slowdown))) on \(device) "
                        + "— was the app launched with `-probe on`?")
            }
            pitchRect = nil
            return
        }

        // The rectangle the game is on, taken once, so every tap below can be a fraction of
        // the pitch rather than of the window. See `pitchPoint`.
        pitchRect = Probe(probe.label).pitch
    }

    /// Wait for a freshly launched app to be ready to be touched: the coach cards dealt with
    /// and the probe on screen. Returns whether it got there.
    ///
    /// Static and taking the app, because `init` calls it before `self` exists and `relaunch`
    /// calls it afterwards, and the two must not drift.
    ///
    /// **Paced at 40 ms, for the same reason `poll` is** — an `exists` query is an accessibility
    /// snapshot, and this loop runs at launch, which is exactly when the app is trying to render
    /// a first frame on a machine slow enough to need `UITEST_SLOWDOWN`. Spinning here floods
    /// the app with snapshot requests while it works on the very frame being waited for.
    ///
    /// Not named `settle`, though it once was: `settle` is a duration in this file, and a
    /// duration and a readiness check answering to one name 100 lines apart is a trap. `poll`
    /// cannot be reused here — it reads the probe's *label*, which does not exist yet.
    private static func ready(_ app: XCUIApplication) -> Bool {
        let skip = app.buttons["coach.skip"]
        let probe = app.descendants(matching: .any).matching(identifier: "match.probe").firstMatch
        let deadline = Date().addingTimeInterval(patience)
        while Date() < deadline {
            // Skip first, and deliberately not the other way around. The probe may well be in
            // the element tree *behind* the coach cards, in which case testing it first would
            // return true on the one run that has cards, leave them up, and every tap after
            // that would hit a card instead of the pitch.
            if skip.exists { skip.tap() }
            if probe.exists { return true }
            // Checked after the probe, not before, so a state that is briefly `.notRunning`
            // right after `app.launch()` is not a false positive. If the app crashed during
            // launch, the probe will not exist and `app.state` will confirm it.
            if app.state == .notRunning { return false }
            usleep(40_000)
        }
        return false
    }

    /// Throw this match away and start another one.
    ///
    /// **This is what replaced the long wait, and it is the whole reason the suite has no
    /// timeout sized to a point cycle any more.** `-receive us` puts the disc in our hand a few
    /// seconds after launch — but it cannot promise the possession *survives* to the gesture. A
    /// dropped pull hands it straight back, and the next time our team touches it is one point
    /// cycle later: measured, 35-43 s, on roughly one launch in fifteen.
    ///
    /// Waiting that out means a timeout sized to the worst case, which is the thing this task
    /// existed to remove. A relaunch is a *fresh point with a fresh seed* and it costs **1.3 s**
    /// — measured, from `Terminate` to the probe being readable. So an unlucky match is not
    /// waited out, it is discarded, and the budget stays sized to the common case.
    ///
    /// Nothing about the gesture under test changes: the new match is the same launch
    /// arguments, the same configuration, and the same `-receive` side. `pitchRect` is
    /// deliberately not re-read — it is a fact about the configuration and the device, not about
    /// the match, and `testThePitchIsTheRectangleTheTapsAssume` is what guards that.
    @discardableResult
    func relaunch() -> Bool {
        app.terminate()
        app.launch()
        attribution.processLost = false
        return Self.ready(app)
    }

    // MARK: - how long anything is allowed to take
    //
    // **There are exactly five durations in this suite and every wait names one of them.**
    // That is a rule with a scar behind it. `patience` used to be the only knob, and it was
    // stretched to 90 s under CI — while `wait(timeout: 10)` and `wait(timeout: 5)` literals
    // sat in the tests, untouched by the override. So the job looked configured for a slow
    // machine and was not: CI run 31384063453 lost `testHoldingTooLongIsOvercharged` to a
    // hardcoded 10 s and `testDragBackToTheOriginCancelsTheThrow` to a hardcoded 5 s, both
    // with a healthy probe. A knob half the waits ignore is worse than no knob, because it
    // makes the job look tuned. **No `wait` call in this suite passes a number.**

    /// How much slower than a developer's Mac to assume this machine is.
    ///
    /// **Named by the runner, not sniffed from the environment, and that is deliberate.** The
    /// old spelling branched on `CI`, which a dozen local tools set for their own reasons — so
    /// a developer with `CI=true` exported got the 90 s waits and would never have seen a
    /// regression that a tight local run fails on. Nothing sets `UITEST_SLOWDOWN` by accident;
    /// `.github/workflows/ci.yml` sets it explicitly, and the number it sets is reviewable.
    ///
    /// **Set it as `TEST_RUNNER_UITEST_SLOWDOWN`, not as `UITEST_SLOWDOWN`.** This code runs in
    /// the simulator, and `xcodebuild` does not forward the host environment there — it forwards
    /// exactly the variables prefixed `TEST_RUNNER_`, stripping the prefix. A bare
    /// `UITEST_SLOWDOWN=4` reaches `xcodebuild` and dies there, which is what CI did from the
    /// day this was introduced until 2026-08-10: every run took the fallback of 1 under a job
    /// that said 4.
    ///
    ///     TEST_RUNNER_UITEST_SLOWDOWN=2 xcodebuild test-without-building …
    ///
    /// Clamped, because an unparseable or absurd value should be a local run rather than a
    /// silently infinite one, and echoed by `announce()` so every run says which regime it took.
    /// That echo is the only reason the broken plumbing was ever found — the tests passed the
    /// whole time, because the runner turned out to be fast enough at ×1.
    static let slowdown: Double = {
        guard let raw = ProcessInfo.processInfo.environment["UITEST_SLOWDOWN"],
            let v = Double(raw), v >= 1, v <= 20
        else { return 1 }
        return v
    }()

    /// How long to wait for the app to be *there* — a first frame, the probe on screen, a
    /// stoppage that is true the instant the match opens.
    ///
    /// **12 s, down from 90.** 90 s was sized for the wait it shared with the disc, and that one
    /// has moved to `possession`, where its worst case can be stated honestly. What is left here
    /// is a launch and a render, and if those take twelve seconds something is wrong with the
    /// machine rather than with the pacing — which is a thing a suite should say quickly.
    static let patience: TimeInterval = 12 * slowdown

    /// How long to wait for **the game to hand us the disc**, before giving up on this match
    /// and starting another one.
    ///
    /// `-receive us` makes the common case a pull settling, flying and being caught: measured,
    /// 2–6 s. What it cannot promise is that the possession survives to the gesture — a dropped
    /// pull hands the disc straight back, and then our team next touches it one point cycle
    /// later, 25–45 s away.
    ///
    /// **The answer to that is `relaunch()`, not a bigger number here.** A timeout sized to the
    /// worst case is exactly what this suite was asked to stop doing: it makes every unlucky run
    /// slow and it hides the day the common case regresses. Twelve seconds is generous against a
    /// 2–6 s median and short enough that discarding the match is cheaper than waiting for it.
    static let possession: TimeInterval = 12 * slowdown

    /// How long to wait for a gesture the app has *already been given* to show up in the
    /// state — a throw reaching the input tape, a drag resolving to throw or cancel.
    ///
    /// Much shorter than `patience` on purpose: this is not waiting for the game to arrive at
    /// anything, it is waiting for a frame or two plus one accessibility read. If this expires
    /// the gesture did not land, which is the failure the suite exists to report.
    static let settle: TimeInterval = 4 * slowdown

    /// How long a test that *samples* — taps repeatedly to measure a rate — may spend doing it,
    /// as a safety cap rather than as its plan. See `RefusalTests`, which stops on a tap count.
    ///
    /// **This is the one test in the suite that genuinely wants a lot of real possession**, and
    /// it is budgeted rather than waited for: every tap needs our own offence and 1.1 s of
    /// `calledCutInterval` since the last call, so a rate over a dozen taps costs the better
    /// part of a minute however fast the possessions arrive. It is not a wait that can be
    /// removed, because the taps *are* the measurement.
    static let samplingCap: TimeInterval = 60 * slowdown

    /// How long to wait for **a whole point to come round**, for the one test that cannot
    /// arrange its precondition and has to meet it on the next cycle.
    ///
    /// **This exists because removing the literals nearly broke the test they were protecting.**
    /// `testATapBeforeThePullSaysTheGameIsNotLive` used to pass `timeout: 180`, and the sweep
    /// that deleted every number in the suite turned it into the `patience` default — 12 s. But
    /// that test's own subject is the pre-pull window, which lasts `prePullSeconds` (5 s) and is
    /// gone before a launch, a coach-card dismissal and a first accessibility read are done. Its
    /// designed fallback is therefore the *next* stoppage, one goal away: measured at 25–96 s
    /// headless, and this suite runs on a renderer several times slower than that.
    ///
    /// 45 s local, 180 s on CI — which is the number that test used to carry, now scaled with
    /// everything else instead of standing outside the knob. It is a real budget for a real
    /// wait, not a pathology ceiling: unlike `possession` there is no relaunch that shortens it,
    /// because a relaunch lands in the same pre-pull window that is too short to catch.
    static let pointCycle: TimeInterval = 45 * slowdown

    /// Say which timing regime this run took, once, before the first test can be misread.
    ///
    /// A duration in this file is only meaningful next to the scale it was measured at, and
    /// the first question about a UI test that passed slowly is which one it got.
    static func announce() {
        guard !announced else { return }
        announced = true
        // Every duration, not a selection. `possession` used to be missing from this line and
        // it is the one that bounds nearly every wait the suite makes, so the answer to "which
        // budget expired" was a number the run never printed.
        print(
            "UITEST TIMING: slowdown ×\(slowdown) — patience \(patience)s, "
                + "possession \(possession)s, settle \(settle)s, "
                + "sampling cap \(samplingCap)s, point cycle \(pointCycle)s")
    }
    private nonisolated(unsafe) static var announced = false

    /// Which team the launch should hand the opening pull to, said from the test's point of
    /// view rather than the engine's. See `init`.
    enum Possession: String {
        /// We receive the opening pull: the disc is in our hand seconds after launch. Every
        /// test whose subject is a throw, a charge or an offensive tap wants this.
        case us
        /// They receive it, which is what the app does with no argument at all. Only the
        /// defensive tap wants it, because it is the one control that needs them holding it.
        case them
    }

    /// Any element by identifier, whatever type SwiftUI decided to make it.
    ///
    /// `.accessibilityElement(children: .combine)` on a HUD plate produces an element whose
    /// *type* is an implementation detail of the SwiftUI version — `.other` today, and
    /// nothing in the framework promises that. Matching on identifier across all descendants
    /// asks the question the test actually has.
    func element(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private var probeElement: XCUIElement { element("match.probe") }

    // MARK: - reading the match

    /// The match state, right now.
    ///
    /// Also the process-loss sentinel: if the app is not running, `processLost` is set and
    /// the last known state is returned so callers that read the probe in an assertion
    /// message see something informative rather than an empty string or a hung snapshot.
    func probe() -> Probe {
        if app.state == .notRunning {
            attribution.processLost = true
            return Probe(attribution.lastKnownState.isEmpty ? "process=lost" : attribution.lastKnownState)
        }
        let raw = probeElement.label
        if !raw.isEmpty {
            attribution.lastProbeAt = Date()
            attribution.lastKnownState = raw
        }
        return Probe(raw)
    }

    /// One line of `MatchProbe.probeState`, parsed.
    struct Probe {
        let raw: String
        private let fields: [String: String]

        init(_ raw: String) {
            self.raw = raw
            var f: [String: String] = [:]
            for pair in raw.split(separator: ";") {
                guard let eq = pair.firstIndex(of: "=") else { continue }
                f[String(pair[pair.startIndex..<eq])] = String(pair[pair.index(after: eq)...])
            }
            self.fields = f
        }

        func string(_ key: String) -> String { fields[key] ?? "" }
        func int(_ key: String) -> Int { Int(fields[key] ?? "") ?? 0 }
        func double(_ key: String) -> Double? { Double(fields[key] ?? "") }
        func flag(_ key: String) -> Bool { fields[key] == "1" }

        /// `humanRelease`'s precondition: our man is holding it, so a drag will throw.
        var canThrow: Bool { flag("mine") }
        /// `humanCallCut`'s precondition, cooldown included.
        var canCut: Bool { flag("cut.ok") }
        /// `humanDefend`'s situation: they have it or it is in the air.
        var canDefend: Bool { flag("def.ok") }

        var thrown: Int { int("thrown") }
        var cuts: Int { int("cuts") }
        var defends: Int { int("defends") }
        var grade: String { string("grade") }
        var hold: Double? { double("hold") }
        var throwType: String { string("type") }
        var drag: String { string("drag") }
        var dragEnd: String { string("dragend") }
        var cut: String { string("cut") }
        var defence: String { string("def") }

        /// Taps the offence took, taps either half refused, and accepted calls that only
        /// landed because the empty cone was widened. See `MatchView.callCut`.
        var taps: Int { int("taps") }
        var refused: Int { int("refused") }
        var widened: Int { int("wide") }
        /// Why the last refusal happened, spelled as `RefusedTap.Reason`.
        var refusal: String { string("refuse") }
        /// Every refusal of the run by reason, `nobodyThere:7|tooSoon:2`.
        var refusalTally: String { string("tally") }
        /// `Engine.phase`: `setup` before a pull, `live` in a point, `dead` between.
        var phase: String { string("phase") }
        var isLive: Bool { phase == "live" }

        /// The rectangle the game is drawn and tapped on, in the window's coordinates.
        ///
        /// **It is not the window, and it is a different rectangle in each configuration.**
        /// Measured on an iPhone 17 Pro in landscape, in an 874 × 402 window: a debug build gives
        /// the game 750 × 338 at (62, 0) — the instruments tab bar takes 64 pt off the bottom — and
        /// a release build gives it 750 × 382 at (62, 0), 44 pt more pitch, with only the home
        /// indicator below it. Both lose 62 pt a side to the display cutout. So a fraction of the
        /// window is a different piece of grass from a fraction of the pitch, in both
        /// configurations and differently. See `pitchPoint`.
        var pitch: CGRect? {
            let parts = string("rect").split(separator: ",").compactMap { Double($0) }
            guard parts.count == 4, parts[2] > 0, parts[3] > 0 else { return nil }
            return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
        }
        /// Seconds until the watched body is back on its feet, or nil while it is.
        var recovery: Double? { double("rec") }
        var isOver: Bool { flag("over") }
    }

    /// Tap, then poll for a counter on the probe to move, and grab a HUD plate the instant it
    /// does.
    ///
    /// **The ordering is the whole point and it is load-bearing.** Both order plates live for
    /// 1.1 s (`CutCall.duration`, `DefenceCall.duration`) and one accessibility snapshot costs
    /// a good fraction of a second on this simulator, so a test that confirms the counter with
    /// a leisurely poll and *then* looks for the plate spends the plate's whole life on the
    /// confirmation and finds nothing. That is exactly how the first run of these tests failed.
    /// Polling in short slices and querying the screen the moment the counter moves is what
    /// fits both reads inside the window.
    ///
    /// Returns the plate labels that were up, or nil if the tap was refused — which is a
    /// designed outcome on both halves of the tap and not a failure: on offence the cone can be
    /// empty, on defence the situation can have ended.
    func tapAndWatch(
        _ where_: XCUICoordinate, counter: (Probe) -> Int, plates: [String], within: TimeInterval
    ) -> [String: String]? {
        let base = counter(probe())
        where_.tap()
        let deadline = Date().addingTimeInterval(within)
        while Date() < deadline {
            if attribution.processLost { return nil }
            if counter(probe()) > base {
                var found: [String: String] = [:]
                for id in plates {
                    let e = element(id)
                    if e.exists { found[id] = e.label }
                }
                return found
            }
        }
        return nil
    }

    /// Tap somewhere the tap is expected to be refused, and read the refusal plate.
    ///
    /// **The retry is a race with the accessibility layer, not with the game.** `RefusedTap`
    /// lives 1.8 s and a `label` read costs up to 0.9 s of it, with `exists` costing another
    /// — measured, a single-suite run found the plate and a full-suite run missed the same
    /// plate for the same tap, with the probe confirming the refusal had happened. Tapping
    /// again re-arms the plate, which turns a lost race into a slower pass. It is only safe
    /// for refusals that *stay* refused — a cooldown expires, so a second tap there would be
    /// accepted, and that test asserts the reason off the probe instead.
    ///
    /// Returns the plate's sentence, or nil if every tap left the screen silent.
    func tapForRefusal(_ where_: XCUICoordinate, attempts: Int = 4) -> String? {
        for _ in 0..<attempts {
            if app.state == .notRunning { attribution.processLost = true; return nil }
            where_.tap()
            let plate = element("hud.refused")
            guard plate.exists else { continue }
            let said = plate.label
            if !said.isEmpty { return said }
        }
        return nil
    }

    // MARK: - waiting

    /// Poll the probe until a condition holds, and return the state it held in — failing the
    /// test if it never does.
    ///
    /// **The timeout is `patience` by default and no caller in this suite passes a number.**
    /// `waitToAct` names `Self.possession`, the pre-pull test names `Self.pointCycle`, and the
    /// rest take the default; see the durations note above for the two tests that the literals
    /// which used to live here cost on the runner.
    @discardableResult
    func wait(
        _ what: String, timeout: TimeInterval = MatchDriver.patience,
        until condition: (Probe) -> Bool,
        file: StaticString = #filePath, line: UInt = #line
    ) -> Probe {
        if let held = poll(for: timeout, until: condition) { return held }
        // **Process loss and pacing timeout are separate diagnostics** (VAL-CI-004,
        // VAL-CI-005). `poll` sets `processLost` when the app dies; a pacing timeout
        // means the app is alive but the simulation never reached the waited state.
        if attribution.processLost {
            XCTFail(processLossMessage(), file: file, line: line)
            return Probe(attribution.lastKnownState)
        }
        let last = probe()
        let probeTime = attribution.lastProbeAt.map { String(describing: $0) } ?? "never"
        XCTFail(
            "PACING TIMEOUT: \(what) — budget \(Int(timeout))s "
                + "(slowdown ×\(String(format: "%.1f", Self.slowdown))) "
                + "— last probe at \(probeTime): \(last.raw)",
            file: file, line: line)
        return last
    }

    /// `wait` without the verdict: the state the condition held in, or nil if it never did.
    ///
    /// **A deadline and a fresh read each time, rather than `sleep` plus one read.** The match
    /// runs at 120 ticks a second behind this and the interesting states — our man holding the
    /// disc, a cut being legal — last for a fraction of a second at a time, so a single read
    /// after a sleep would miss most of them.
    ///
    /// This is the one loop; `wait` adds the failure and nothing else. It is separate because a
    /// *retry* needs to know that a state did not arrive without that being the test's verdict —
    /// see `withTheDisc`.
    func poll<T>(for timeout: TimeInterval, _ transform: (Probe) -> T?) -> T? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            // Process loss is infrastructure, not a gesture assertion (VAL-CI-004).
            // Checking `app.state` before each probe read catches a crash mid-wait
            // and sets the flag the caller checks to emit the right diagnostic.
            if app.state == .notRunning {
                attribution.processLost = true
                return nil
            }
            if let found = transform(probe()) { return found }
            // A tenth of the shortest thing worth waiting for. Tighter than this and the
            // accessibility traffic starts costing the app frames.
            usleep(40_000)
        }
        return nil
    }

    /// The same loop asked as a yes/no question, which is what most callers want.
    ///
    /// The mapping form above is the general one because `withTheDisc`'s `resolve` produces a
    /// *value*, and expressing that through a predicate meant running `resolve` twice — once to
    /// decide and once to get the answer back out — which silently required every `resolve` a
    /// test writes to be pure.
    func poll(for timeout: TimeInterval, until condition: (Probe) -> Bool) -> Probe? {
        poll(for: timeout) { condition($0) ? $0 : nil }
    }

    /// Wait for a control to become legal — a cut, a defensive commit — on the same budget as
    /// the disc itself, because both are the game handing the test a situation rather than the
    /// app answering for a gesture. The tap tests loop over this, so a situation that comes and
    /// goes is already tolerated; what they cannot tolerate is it never coming, which is what
    /// the budget bounds.
    @discardableResult
    func waitToAct(
        _ what: String, until condition: (Probe) -> Bool,
        file: StaticString = #filePath, line: UInt = #line
    ) -> Probe {
        wait(what, timeout: Self.possession, until: condition, file: file, line: line)
    }

    /// Wait for the disc, do something with it, and try again if the possession was gone by
    /// the time the gesture landed.
    ///
    /// **The gap between the wait and the gesture is real and it has failed on CI.** `wait`
    /// returns on a probe read; the gesture that follows costs a press, a drag interpolation
    /// and a hold, and the match runs at 120 Hz throughout. On run 31384063453
    /// `testDragBackToTheOriginCancelsTheThrow` waited for `mine=1`, dragged, and read
    /// `poss=1;mine=0` — the disc had changed hands mid-gesture, so the drag was refused and
    /// no `dragend` ever arrived. That is not the control being broken and a test must not
    /// report it as such.
    ///
    /// So the shape is: get the disc, act, and let `resolve` say whether the action *reached the
    /// simulation*. Nil from `resolve` spends the attempt.
    ///
    /// **An attempt that never gets the disc at all relaunches rather than waits.** That is the
    /// difference between this and every earlier version of the harness: a match whose pull we
    /// lost is discarded for 1.3 s instead of waited out for 40, so no budget here is sized to a
    /// point cycle. See `relaunch()`.
    ///
    /// `resolve` is handed the state *before* the gesture as well as the state now, so a test can
    /// ask "did the count go up" without capturing a baseline that a relaunch would invalidate —
    /// a relaunch resets the input tape to zero, and a baseline read before it would never be
    /// beaten again.
    ///
    /// **Nothing in here calls `XCTFail`, and the caller's `guard` is the failure.** A `wait`
    /// that failed inside would report "timed out waiting for the disc in our hand" for a test
    /// whose actual complaint is "no gesture produced anything", which names the wrong thing and
    /// sends the next reader to the wrong file.
    func withTheDisc<T>(
        _ what: String, attempts: Int = 4, act: (Probe) -> Void,
        resolve: (_ before: Probe, _ now: Probe) -> T?
    ) -> T? {
        for attempt in 0..<attempts {
            guard let before = poll(for: Self.possession, until: { $0.canThrow }) else {
                // If the app died, stop retrying — the caller's `fail` will emit the
                // process-loss diagnostic, not a gesture assertion.
                if attribution.processLost { return nil }
                // This match is not going to give us the disc soon. Take another one — but not
                // on the last attempt, where a relaunch would only cost time nobody reads.
                //
                // A relaunch that never comes back has already spent `patience`; polling the
                // next attempt against an app that is not there would spend `possession` again
                // for a state that cannot arrive, so stop and let the caller's `guard` report it.
                if attempt == attempts - 1 { break }
                guard relaunch() else { break }
                continue
            }
            act(before)
            if let done = poll(for: Self.settle, { resolve(before, $0) }) { return done }
            if attribution.processLost { return nil }
        }
        return nil
    }

    // MARK: - failure attribution

    /// Fail with a process-loss diagnostic if the app died, or with the caller's assertion
    /// message otherwise.
    ///
    /// **This is the seam that keeps a crash from wearing a gesture assertion's label**
    /// (VAL-CI-004). `withTheDisc` and `poll` set `processLost` when they detect the app
    /// process is gone; the caller's `guard … XCTFail(…)` is a gesture assertion. Routing
    /// the failure through here means a crash is reported as "PROCESS LOSS", not as "four
    /// drags recorded no throw" — which is the misattribution issue #46 describes.
    func fail(
        _ message: @autoclosure () -> String,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        if attribution.processLost {
            XCTFail(processLossMessage(), file: file, line: line)
        } else {
            XCTFail(message(), file: file, line: line)
        }
    }

    /// The process-loss diagnostic: names the app, the last known state, and the loss
    /// type (VAL-CI-004).
    private func processLossMessage() -> String {
        let device = Self.deviceIdentity()
        let timestamp = attribution.lastProbeAt.map { String(describing: $0) } ?? "never"
        let state = attribution.lastKnownState.isEmpty ? "no probe reading" : attribution.lastKnownState
        return "PROCESS LOSS: \(Self.appIdentifier) is not running (state: \(app.state)) "
            + "on \(device) — last known state at \(timestamp): \(state)"
    }

    /// The simulator device identity from the environment, for diagnostics that name the
    /// device. Set by `xcodebuild` in every simulator process.
    private static func deviceIdentity() -> String {
        let env = ProcessInfo.processInfo.environment
        let name = env["SIMULATOR_DEVICE_NAME"] ?? "unknown device"
        let udid = env["SIMULATOR_UDID"] ?? "no-udid"
        return "\(name) (\(udid))"
    }

    // MARK: - touching

    /// A point on the pitch, as a fraction of the screen.
    ///
    /// Coordinate-based on purpose and not by compromise: the pitch is a RealityKit scene
    /// with no per-player accessibility elements, and the two taps are *resolved as
    /// directions from the thrower* by `MatchScene.groundPoint` and the same 35° cone the
    /// drag uses — so where on the glass the finger lands is the input, and an element
    /// query would be answering a question the game does not ask.
    ///
    /// **These offsets are fractions of the *window*, which is not the pitch in a debug
    /// build.** `UltimateApp.showsInstruments` puts a five-item tab bar across the bottom, so
    /// on an iPhone 17 Pro in landscape the pitch is 874 × 338 of an 874 × 402 window and
    /// anything below y ≈ 0.84 is a tab, not grass; a release build has no tab bar and the
    /// pitch is the whole window. So the same fraction is different grass in the configuration
    /// that ships than in the one the tests ran in — which is why anything aiming at the game
    /// should use `pitchPoint` instead, and why `testThePitchIsTheRectangleTheTapsAssume`
    /// exists to say which rectangle a run got.
    func point(_ x: Double, _ y: Double) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
    }

    /// A point as a fraction of **the pitch** — the rectangle the game is actually drawn and
    /// tapped on, wherever it sits in the window.
    ///
    /// The rectangle comes off the probe (`MatchView.viewFrame`, the one `GeometryReader` that
    /// knows it), origin included, because it is inset on every side and by a different amount
    /// in each configuration. So `pitchPoint(0.5, 0.5)` is the middle of the grass in a debug
    /// build and in a release build, and a tap that means something in one means the same thing
    /// in the other.
    ///
    /// Falls back to the window if the probe has not reported a rectangle yet, which only
    /// happens before the first frame.
    func pitchPoint(_ x: Double, _ y: Double) -> XCUICoordinate {
        guard let pitch = pitchRect else { return point(x, y) }
        return app.coordinate(withNormalizedOffset: .zero)
            .withOffset(
                CGVector(
                    dx: pitch.minX + x * pitch.width,
                    dy: pitch.minY + y * pitch.height))
    }

    /// The pitch rectangle, read once at launch. It cannot change during a test — nothing here
    /// rotates the device — and reading it is an accessibility query, which is the most
    /// expensive thing a touch test does.
    let pitchRect: CGRect?

    /// The thrower's end of the drag.
    ///
    /// The lower-left third, which is where a 3v3 handler stands with the camera behind the
    /// attack. `MatchView.throwGesture` is a `DragGesture` on the whole render surface and
    /// does not care where the drag began — direction and distance are the input — so this
    /// is chosen to look like a thumb on a player rather than because it has to be one.
    var throwerPoint: XCUICoordinate { pitchPoint(0.34, 0.62) }

    /// Where a flat forehand at full power finishes: up and to the right, which
    /// `ThrowGesture.interpret` reads as `rise ≈ 0.19` — flat — and `dx >= 0` — forehand.
    var forehandPoint: XCUICoordinate { pitchPoint(0.62, 0.50) }

    /// Drag from the thrower and release, with the thumb down for about `hold` seconds.
    ///
    /// **The hold is approximate and the test must not pretend otherwise.** `press(
    /// forDuration:thenDragTo:withVelocity:thenHoldForDuration:)` is the finest control
    /// XCUITest offers and it is a sum of three intervals, only two of which the caller
    /// names; the app's own `FrameClock` then starts counting from the first `onChanged`,
    /// which is a frame or two after the touch went down. So this returns nothing about
    /// timing and the caller reads the hold the app *measured* off the probe. See
    /// `ChargeTests` for how the perfect window is reached in spite of that.
    func drag(hold: TimeInterval, from: XCUICoordinate? = nil, to: XCUICoordinate? = nil) {
        let start = from ?? throwerPoint
        let end = to ?? forehandPoint
        // The move itself is made as brief as the API allows so that almost all of the hold
        // is the part this call actually controls. 4000 pt/s covers the ~250 pt drag in
        // about 60 ms.
        start.press(
            forDuration: 0.01, thenDragTo: end,
            withVelocity: XCUIGestureVelocity(rawValue: 4000),
            thenHoldForDuration: max(0, hold))
    }
}
