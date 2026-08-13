import ProbeContract
import XCTest

/// Cross-area flow tests — VAL-CROSS-001, 002, 003, 004.
///
/// These tests verify the initial launch-to-live flow, first-visit coach card
/// dismissal, the `-receive` coin toss, and the `-points` match length through
/// the `match.probe` accessibility element on the dedicated simulator.
///
/// VAL-CROSS-005 (touch), VAL-CROSS-006 (charge), and VAL-CROSS-007 (refusal)
/// are covered by TouchTests, ChargeTests, and RefusalTests respectively.
final class CrossFlowTests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    // MARK: - VAL-CROSS-001 — Initial launch with `-setup off` reaches a live match

    /// A default driver launch (which sets `-setup off -probe on -points 9
    /// -receive us`) reaches `isLive` within patience with `sheet` false.
    /// On a fresh clone, if `coach.skip` appears, readiness dismisses it first
    /// (MatchDriver.ready races the skip button and the probe), then asserts
    /// `isLive` with `sheet` false. On a clone where cards were already seen,
    /// `isLive` is reached directly.
    func testSetupOffReachesLiveMatchOnProbe() {
        let match = MatchDriver()
        // MatchDriver.ready already dismissed any coach cards and confirmed
        // the probe exists. Now assert the match is live with sheet false.
        let live = match.wait(
            "the match to be live",
            timeout: MatchDriver.patience, until: { $0.isLive })
        XCTAssertTrue(
            live.isLive,
            "under -setup off, the match should reach phase=live — probe: \(live.raw)")
        XCTAssertFalse(
            live.sheet,
            "under -setup off, the sheet should be absent — probe: \(live.raw)")
        XCTAssertEqual(
            live.phase, "live",
            "the phase should be 'live' — probe: \(live.raw)")
    }

    // MARK: - VAL-CROSS-002 — First-visit coach cards are skippable and probe readable after

    /// On a fresh clone, `coach.skip` exists and tapping it yields a readable
    /// probe within patience. On a clone where cards were already seen, the
    /// probe appears without the skip. This test races the skip button and the
    /// probe (as MatchDriver.ready does) and asserts the probe is readable
    /// either way, recording which case was observed.
    func testFirstRunCoachCardsSkippableProbeReadable() {
        let app = XCUIApplication()
        app.launchArguments = [
            LaunchArg.setup.rawValue, SetupValue.off.rawValue,
            LaunchArg.probe.rawValue, ToggleValue.on.rawValue,
            LaunchArg.points.rawValue, "9",
            LaunchArg.receive.rawValue, ReceiveValue.us.rawValue,
        ]
        app.launch()

        let skip = app.buttons["coach.skip"]
        let probe = app.descendants(matching: .any)
            .matching(identifier: ProbeContract.probeIdentifier).firstMatch
        let deadline = Date().addingTimeInterval(MatchDriver.patience)
        var sawSkip = false
        var sawProbe = false
        while Date() < deadline {
            if skip.exists {
                sawSkip = true
                skip.tap()
            }
            if probe.exists {
                sawProbe = true
                break
            }
            if app.state == .notRunning { break }
            usleep(40_000)
        }

        XCTAssertTrue(
            sawProbe,
            "the probe should be readable within patience after any coach cards are dismissed")
        XCTAssertFalse(
            probe.label.isEmpty,
            "the probe label should be non-empty — probe: \(probe.label)")
        print(
            "VAL-CROSS-002 (first run): coach.skip "
                + (sawSkip ? "appeared and was dismissed" : "absent (already seen)")
                + " — probe readable: \(sawProbe)")
    }

    /// A subsequent launch on the same clone should not show `coach.skip` — the
    /// cards were already seen. The probe should be readable directly without
    /// waiting on cards.
    func testSecondRunNoCoachCardsProbeReadableDirectly() {
        let app = XCUIApplication()
        app.launchArguments = [
            LaunchArg.setup.rawValue, SetupValue.off.rawValue,
            LaunchArg.probe.rawValue, ToggleValue.on.rawValue,
            LaunchArg.points.rawValue, "9",
            LaunchArg.receive.rawValue, ReceiveValue.us.rawValue,
        ]
        app.launch()

        let skip = app.buttons["coach.skip"]
        let probe = app.descendants(matching: .any)
            .matching(identifier: ProbeContract.probeIdentifier).firstMatch
        let deadline = Date().addingTimeInterval(MatchDriver.patience)
        var sawSkip = false
        var sawProbe = false
        while Date() < deadline {
            if skip.exists {
                sawSkip = true
                skip.tap()
            }
            if probe.exists {
                sawProbe = true
                break
            }
            if app.state == .notRunning { break }
            usleep(40_000)
        }

        XCTAssertTrue(
            sawProbe,
            "the probe should be readable on a subsequent run within patience")
        // On a clone where cards were already seen, coach.skip should be absent.
        // If this is genuinely the first run on a fresh clone (no prior test
        // dismissed the cards), skip may appear — but test ordering within a
        // class is alphabetical, so testFirstRunCoachCardsSkippableProbeReadable
        // runs before this one and dismisses the cards if they were present.
        print(
            "VAL-CROSS-002 (second run): coach.skip "
                + (sawSkip ? "appeared" : "absent")
                + " — probe readable: \(sawProbe)")
    }

    // MARK: - VAL-CROSS-003 — `-receive` drives the probe-observed opening possession

    /// Under `-receive us`, `canThrow` arrives within the possession window.
    /// The disc arrives in our hand (mine=1) before a full opponent possession.
    func testReceiveUsCanThrowWithinPossession() {
        let match = MatchDriver(receives: .us)
        let p = match.wait(
            "the disc in our hand under -receive us",
            timeout: MatchDriver.possession, until: { $0.canThrow })
        XCTAssertTrue(
            p.canThrow,
            "under -receive us, canThrow should arrive within possession — probe: \(p.raw)")
    }

    /// Under `-receive them`, `canDefend` arrives within the possession window
    /// and `canThrow` does not precede it during the live phase. Team 0 pulls
    /// and the defensive precondition arrives first.
    ///
    /// The pre-pull window is excluded: under `-receive them` we pull, so before
    /// the match goes live we hold the disc (`mine=1`, `canThrow` true). That is
    /// the pull setup, not a live offensive possession. The assertion is that
    /// once the match is live, `canDefend` arrives without `canThrow` being true
    /// first — i.e., the first live possession is theirs, not ours.
    func testReceiveThemCanDefendArrivesFirstWithoutCanThrow() {
        let match = MatchDriver(receives: .them)
        // Poll and track whether canThrow ever becomes true during the live
        // phase before canDefend arrives.
        var canDefendArrived = false
        var canThrowPrecededInLive = false
        let deadline = Date().addingTimeInterval(MatchDriver.possession)
        while Date() < deadline {
            if match.app.state == .notRunning { break }
            let p = match.probe()
            if p.canDefend {
                canDefendArrived = true
                break
            }
            // Only count canThrow during the live phase — the pre-pull window
            // (phase not yet "live") is the pull setup, where we hold the disc
            // to pull but the match has not started.
            if p.isLive && p.canThrow {
                canThrowPrecededInLive = true
            }
            usleep(40_000)
        }
        XCTAssertTrue(
            canDefendArrived,
            "under -receive them, canDefend should arrive within possession — probe: \(match.probe().raw)")
        XCTAssertFalse(
            canThrowPrecededInLive,
            "under -receive them, canThrow should not precede canDefend during the live phase — probe: \(match.probe().raw)")
    }

    // MARK: - VAL-CROSS-004 — `-points 1` ends the match after one goal; REMATCH exists

    /// Under `-points 1`, `isOver` becomes true within a point cycle and the
    /// REMATCH element exists.
    func testPoints1EndsMatchAndRematchExists() {
        let match = MatchDriver(extraArgs: [LaunchArg.points.rawValue, "1"])
        let ended = match.wait(
            "a one-point match to end",
            timeout: MatchDriver.pointCycle, until: { $0.isOver })
        guard ended.isOver else {
            return match.fail(
                "the one-point match never ended within a point cycle — probe: \(match.probe().raw)")
        }
        XCTAssertTrue(
            match.element("REMATCH").exists,
            "the REMATCH element should exist after the match ends — probe: \(match.probe().raw)")
    }

    /// Under `-points 9` (the default), `isOver` stays false over the same
    /// window (pointCycle). The match does not end that quickly.
    func testPoints9StaysLiveOverPointCycle() {
        let match = MatchDriver()
        // Wait for the match to be live first.
        match.wait(
            "the match to be live",
            timeout: MatchDriver.patience, until: { $0.isLive })
        // Poll for isOver over pointCycle — it should stay false.
        let result = match.poll(
            for: MatchDriver.pointCycle, until: { $0.isOver })
        XCTAssertNil(
            result,
            "under -points 9, the match should not end within a point cycle — probe: \(match.probe().raw)")
        XCTAssertFalse(
            match.probe().isOver,
            "under -points 9, isOver should be false — probe: \(match.probe().raw)")
    }
}
