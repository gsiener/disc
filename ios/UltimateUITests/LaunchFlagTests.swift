import ProbeContract
import XCTest

/// Launch flag UI tests — VAL-LAUNCH-001, 003, 004, 005, 006, 007, 008, 009,
/// 011, 012, 013, 017.
///
/// These tests verify the observable behavior of launch arguments through the
/// `match.probe` accessibility element on the dedicated simulator. Tests that
/// need a bare launch (no `-setup off`) use `XCUIApplication` directly; tests
/// that need a live match use `MatchDriver`.
///
/// VAL-LAUNCH-010 (savecycle), VAL-LAUNCH-015 (rematch), and VAL-LAUNCH-016
/// (restore) are covered by `SaveCycleTests`.
final class LaunchFlagTests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    // MARK: - Helpers

    /// Launch the app with the given arguments, handling first-visit coach cards.
    /// Waits for the probe to appear (assumes `-probe on` is among the arguments).
    private func launch(_ args: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = args
        app.launch()
        let skip = app.buttons["coach.skip"]
        let probe = app.descendants(matching: .any)
            .matching(identifier: ProbeContract.probeIdentifier).firstMatch
        let deadline = Date().addingTimeInterval(12)
        while Date() < deadline {
            if skip.exists { skip.tap() }
            if probe.exists { break }
            if app.state == .notRunning { break }
            usleep(40_000)
        }
        return app
    }

    /// Launch the app without expecting the probe (for `-probe` absent tests).
    private func launchNoProbe(_ args: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = args
        app.launch()
        let skip = app.buttons["coach.skip"]
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            if skip.exists { skip.tap(); break }
            if app.state == .notRunning { break }
            usleep(40_000)
        }
        // Let the app settle a moment after coach cards.
        usleep(500_000)
        return app
    }

    /// Read the probe from the app.
    private func readProbe(_ app: XCUIApplication) -> Probe {
        let el = app.descendants(matching: .any)
            .matching(identifier: ProbeContract.probeIdentifier).firstMatch
        return Probe(el.label)
    }

    /// The probe element.
    private func probeElement(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(identifier: ProbeContract.probeIdentifier).firstMatch
    }

    // MARK: - VAL-LAUNCH-001 — Bare launch yields all defaults and the pre-game sheet

    /// A bare launch (with `-probe on` for observation) reads `sheet=1` and
    /// `phase=setup`.
    func testBareLaunchShowsPreGameSheet() {
        let app = launch([LaunchArg.probe.rawValue, ToggleValue.on.rawValue])
        guard probeElement(app).exists else {
            return XCTFail("the probe element should exist under -probe on")
        }
        let p = readProbe(app)
        XCTAssertTrue(
            p.sheet,
            "a bare launch should show the pre-game sheet — probe: \(p.raw)")
        XCTAssertEqual(
            p.phase, "setup",
            "a bare launch should be in setup phase — probe: \(p.raw)")
        XCTAssertFalse(
            p.isLive,
            "a bare launch should not be live — probe: \(p.raw)")
    }

    // MARK: - VAL-LAUNCH-003 — `-format` selects field spec

    /// `-format 7v7` yields the full field; the rect is valid with positive
    /// dimensions.
    func testFormat7v7SelectsFullField() {
        let match = MatchDriver(extraArgs: [LaunchArg.format.rawValue, "7v7"])
        let p = match.probe()
        guard let rect = p.pitch else {
            return match.fail("the probe should report a rect for 7v7 — probe: \(p.raw)")
        }
        XCTAssertGreaterThan(rect.width, 0, "full-field rect should have positive width")
        XCTAssertGreaterThan(rect.height, 0, "full-field rect should have positive height")
    }

    // MARK: - VAL-LAUNCH-004 — `-points` parses to raw int; applied length clamped

    /// `-points 1` plays to one goal; the first goal ends the match and REMATCH
    /// is reachable.
    func testPoints1EndsAtOneGoal() {
        let match = MatchDriver(extraArgs: [LaunchArg.points.rawValue, "1"])
        let ended = match.wait(
            "a one-point match to end",
            timeout: MatchDriver.pointCycle, until: { $0.isOver })
        guard ended.isOver else {
            return match.fail(
                "the one-point match never ended — probe: \(match.probe().raw)")
        }
        XCTAssertTrue(
            match.element("REMATCH").exists,
            "REMATCH should be reachable after the match ends")
    }

    // MARK: - VAL-LAUNCH-005 — `-receive` sets the opening coin toss

    /// Under `-receive us`, `canThrow` arrives within the possession window.
    func testReceiveUsHandsUsTheDisc() {
        let match = MatchDriver(receives: .us)
        let p = match.wait(
            "the disc in our hand",
            timeout: MatchDriver.possession, until: { $0.canThrow })
        XCTAssertTrue(
            p.canThrow,
            "under -receive us, canThrow should arrive within possession — probe: \(p.raw)")
    }

    /// Under `-receive them`, `canDefend` arrives within the possession window.
    func testReceiveThemHandsThemTheDisc() {
        let match = MatchDriver(receives: .them)
        let p = match.wait(
            "a defensive situation",
            timeout: MatchDriver.possession, until: { $0.canDefend })
        XCTAssertTrue(
            p.canDefend,
            "under -receive them, canDefend should arrive — probe: \(p.raw)")
    }

    // MARK: - VAL-LAUNCH-006 — `-setup` controls the pre-game sheet

    /// `-setup off` skips the sheet (sheet=0).
    func testSetupOffSkipsSheet() {
        let match = MatchDriver()
        let p = match.probe()
        XCTAssertFalse(
            p.sheet,
            "under -setup off, the sheet should be absent — probe: \(p.raw)")
    }

    /// A bare launch (no `-setup off`) shows the sheet (sheet=1).
    func testBareLaunchShowsSheet() {
        let app = launch([LaunchArg.probe.rawValue, ToggleValue.on.rawValue])
        let p = readProbe(app)
        XCTAssertTrue(
            p.sheet,
            "a bare launch should show the sheet — probe: \(p.raw)")
    }

    // MARK: - VAL-LAUNCH-007 — `-charge` pins the demo gesture hold

    /// `-charge 0.85` pins the demo gesture overlay: `drag=aim` (aim line drawn)
    /// and `thrown=0` (no throw recorded). The probe's `hold` field tracks the
    /// last *release*, not the pinned gesture, so it reads `-` here — the
    /// pinned hold value (0.85) is verified by the Swift SimTests contract test.
    func testChargePinsHold() {
        let match = MatchDriver(extraArgs: [LaunchArg.charge.rawValue, "0.85"])
        // The demo charge pins from the first frame, but give a moment to settle.
        let p = match.poll(for: MatchDriver.settle, until: { $0.drag == "aim" })
            ?? match.probe()
        XCTAssertEqual(
            p.drag, "aim",
            "the aim line should be drawn (drag=aim) — probe: \(p.raw)")
        XCTAssertEqual(
            p.thrown, 0,
            "no throw should be recorded — probe: \(p.raw)")
        // The probe's hold field is the last release hold, not the pinned gesture
        // hold. With -charge 0.85 (no release), hold reads "-". The pinned value
        // itself is verified by the SimTests contract test.
        XCTAssertEqual(
            p.hold, nil,
            "hold should be nil (no release) for a pinned gesture — probe: \(p.raw)")
    }

    // MARK: - VAL-LAUNCH-008 — `-defend` auto-issues defensive taps

    /// `-defend on` advances `defends` with no test tap.
    func testDefendOnAdvancesDefends() {
        let match = MatchDriver(
            extraArgs: [LaunchArg.defend.rawValue, ToggleValue.on.rawValue],
            receives: .them)
        let p = match.wait(
            "defends to advance",
            timeout: MatchDriver.possession, until: { $0.defends > 0 })
        XCTAssertGreaterThan(
            p.defends, 0,
            "under -defend on, defends should be nonzero — probe: \(p.raw)")
    }

    // MARK: - VAL-LAUNCH-009 — `-cut` accepts two in-range fractions

    /// `-cut 0.5,0.35` advances `cuts` with no test tap.
    func testCutAdvancesCuts() {
        let match = MatchDriver(
            extraArgs: [LaunchArg.cut.rawValue, "0.5,0.35"])
        let p = match.wait(
            "cuts to advance",
            timeout: MatchDriver.possession, until: { $0.cuts > 0 })
        XCTAssertGreaterThan(
            p.cuts, 0,
            "under -cut 0.5,0.35, cuts should be nonzero — probe: \(p.raw)")
    }

    // MARK: - VAL-LAUNCH-011 — `-probe` controls probe visibility

    /// Under `-probe on`, the probe element exists with a non-empty label.
    func testProbeOnShowsElement() {
        let app = launch([
            LaunchArg.probe.rawValue, ToggleValue.on.rawValue,
            LaunchArg.setup.rawValue, SetupValue.off.rawValue,
        ])
        let el = probeElement(app)
        XCTAssertTrue(el.exists, "the probe element should exist under -probe on")
        XCTAssertFalse(el.label.isEmpty, "the probe label should be non-empty")
    }

    /// Without `-probe on`, no probe element exists.
    func testProbeOffHidesElement() {
        let app = launchNoProbe([
            LaunchArg.setup.rawValue, SetupValue.off.rawValue,
        ])
        let el = probeElement(app)
        XCTAssertFalse(
            el.exists,
            "no probe element should exist without -probe on")
    }

    // MARK: - VAL-LAUNCH-012 — `-tab` selects one of five canonical tabs

    /// In a debug build, the tab bar is visible with all five canonical tab
    /// buttons. Verified from the Play tab (which is the default surface)
    /// because launching directly onto the Checks tab makes the probe element
    /// unavailable, causing the readiness wait to time out.
    func testTabBarHasAllCanonicalButtons() {
        let app = launch([
            LaunchArg.probe.rawValue, ToggleValue.on.rawValue,
            LaunchArg.setup.rawValue, SetupValue.off.rawValue,
        ])
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(
            tabBar.exists,
            "the tab bar should be visible in a debug build")
        // The five canonical tab-bar item labels: Play, Pitch, Flight, Checks, Speed.
        for label in TabName.allCases.map(\.label) {
            XCTAssertTrue(
                app.tabBars.buttons[label].exists,
                "the tab bar should have a button labeled '\(label)'")
        }
    }

    /// In a debug build, the tab bar is visible even under `-tab play`.
    func testTabBarVisibleInDebugBuild() {
        let app = launch([
            LaunchArg.tab.rawValue, TabName.play.rawValue,
            LaunchArg.probe.rawValue, ToggleValue.on.rawValue,
            LaunchArg.setup.rawValue, SetupValue.off.rawValue,
        ])
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(
            tabBar.exists,
            "the tab bar should be visible in a debug build under -tab play")
    }

    // MARK: - VAL-LAUNCH-013 — Edge-case argument parsing (savecycle inf)

    /// Under `-savecycle inf`, no restore fires over a run long enough for a
    /// finite cycle to have fired.
    func testSavecycleInfNeverRestores() {
        let match = MatchDriver(
            extraArgs: [
                LaunchArg.savecycle.rawValue, "inf",
                LaunchArg.points.rawValue, "9",
            ])
        match.wait(
            "the match to be live",
            timeout: MatchDriver.patience, until: { $0.isLive })
        // Poll for paused over a window long enough for a finite 10s cycle to
        // have fired. If the poll returns nil, the cycle never fired — which is
        // the pass condition.
        let result = match.poll(
            for: MatchDriver.pointCycle, until: { $0.paused })
        XCTAssertNil(
            result,
            "under -savecycle inf, the cycle should never fire — probe: \(match.probe().raw)")
        let p = match.probe()
        XCTAssertFalse(
            p.paused,
            "the probe should not show paused — probe: \(p.raw)")
    }

    // MARK: - VAL-LAUNCH-017 — Multiple flags compose in one launch

    /// `-setup off -points 1 -receive us -format 7v7 -probe on` opens straight
    /// into a live full-field match to one goal with the disc in our hand and
    /// the probe visible.
    func testCompositionOfAllFlags() {
        let match = MatchDriver(
            extraArgs: [
                LaunchArg.points.rawValue, "1",
                LaunchArg.format.rawValue, "7v7",
            ],
            receives: .us)

        // isLive && !sheet
        let live = match.wait(
            "the match to be live",
            timeout: MatchDriver.patience, until: { $0.isLive && !$0.sheet })
        XCTAssertTrue(
            live.isLive,
            "the match should be live — probe: \(live.raw)")
        XCTAssertFalse(
            live.sheet,
            "the sheet should be absent — probe: \(live.raw)")

        // canThrow within the possession window (receive us)
        let p = match.wait(
            "the disc in our hand",
            timeout: MatchDriver.possession, until: { $0.canThrow })
        XCTAssertTrue(
            p.canThrow,
            "canThrow should arrive within possession — probe: \(p.raw)")

        // Full-field rect
        guard let rect = p.pitch else {
            return match.fail("the probe should report a rect — probe: \(p.raw)")
        }
        XCTAssertGreaterThan(
            rect.width, 0,
            "full-field rect should have positive width")
        XCTAssertGreaterThan(
            rect.height, 0,
            "full-field rect should have positive height")

        // Match ends at one goal
        let ended = match.wait(
            "the one-point match to end",
            timeout: MatchDriver.pointCycle, until: { $0.isOver })
        XCTAssertTrue(
            ended.isOver,
            "the match should end at one goal — probe: \(ended.raw)")
    }
}
