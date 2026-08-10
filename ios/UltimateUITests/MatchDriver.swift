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
    /// The test that owns this driver, for failure attribution.
    private let test: XCTestCase

    /// Launch into a live match with the probe on.
    ///
    /// `-setup off` skips the pre-game sheet, which is the wall a launch argument was
    /// invented to climb and which a UI test could actually tap through — but tapping START
    /// on every test would mean every test also verifies the sheet, and a shared failure is
    /// a worse signal than five separate ones. `-points 9` buys a long enough game that a
    /// test waiting for its third possession does not run into full time.
    init(_ test: XCTestCase, arguments extra: [String] = []) {
        self.test = test
        let app = XCUIApplication()
        app.launchArguments = ["-setup", "off", "-probe", "on", "-points", "9"] + extra
        app.launch()
        self.app = app

        // The coach cards. They are shown once per install, which on a simulator means once
        // per fresh clone of the device — so a test suite meets them on exactly one run and
        // then never again, which is the worst possible frequency for something that blocks
        // every input on the screen. Skipping is what a player does with the same button.
        let skip = app.buttons["coach.skip"]
        if skip.waitForExistence(timeout: 3) {
            skip.tap()
        }

        // The probe itself. If this never appears, nothing below can mean anything, so it is
        // asserted here rather than being allowed to fail later as a timeout.
        //
        // Queried through a local rather than through `probeElement`, because a stored property
        // is still uninitialised at this point and reaching for `self` to read one computed
        // property does not compile. The query is the same one.
        let probe = app.descendants(matching: .any).matching(identifier: "match.probe").firstMatch
        XCTAssertTrue(
            probe.waitForExistence(timeout: 10),
            "the match probe never appeared — was the app launched with `-probe on`?")

        // The rectangle the game is on, taken once, so every tap below can be a fraction of
        // the pitch rather than of the window. See `pitchPoint`.
        pitchRect = Probe(probe.label).pitch
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
    func probe() -> Probe { Probe(probeElement.label) }

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
            where_.tap()
            let plate = element("hud.refused")
            guard plate.exists else { continue }
            let said = plate.label
            if !said.isEmpty { return said }
        }
        return nil
    }

    // MARK: - waiting

    /// Poll the probe until a condition holds, and return the state it held in.
    ///
    /// A deadline and a fresh read each time, rather than `sleep` plus one read: the match
    /// runs at 120 ticks a second behind this and the interesting states — our man holding
    /// the disc, a cut being legal — last for a fraction of a second at a time.
    @discardableResult
    func wait(
        _ what: String, timeout: TimeInterval = 90, until condition: (Probe) -> Bool,
        file: StaticString = #filePath, line: UInt = #line
    ) -> Probe {
        let deadline = Date().addingTimeInterval(timeout)
        var last = probe()
        while Date() < deadline {
            last = probe()
            if condition(last) { return last }
            // A tenth of the shortest thing worth waiting for. Tighter than this and the
            // accessibility traffic starts costing the app frames.
            usleep(40_000)
        }
        XCTFail(
            "timed out after \(Int(timeout))s waiting for \(what) — probe: \(last.raw)",
            file: file, line: line)
        return last
    }

    /// Wait for our man to be holding the disc, which is the only state a drag throws in.
    @discardableResult
    func waitToThrow(file: StaticString = #filePath, line: UInt = #line) -> Probe {
        wait("the disc in our hand", until: { $0.canThrow }, file: file, line: line)
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
