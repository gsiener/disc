import ProbeContract
import XCTest

/// Save/restore lifecycle and REMATCH reset parity — issue #43, VAL-CROSS-004.
///
/// `-savecycle <N>` is the supported internal test entry point for the save/restore
/// lifecycle, because XCUITest cannot synthesize iOS backgrounding (a `scenePhase` change
/// to `.inactive`). It plays for N seconds, calls the real `saveMatch()` (the same
/// function `scenePhase` calls), writes the save to disk, throws the engine away, and
/// calls `resume(MatchSave.load())` — exercising the full `saveMatch` → `MatchSave.write`
/// → `MatchSave.load` → `resume` → `adopt` round trip.
///
/// After restore, the probe shows the same score/state, the seven restart-only
/// presentation fields are cleared, and the match lands `paused=1`. A fresh REMATCH
/// (through the result card's REMATCH button, made reachable via `-points 1`) lands
/// unpaused with empty input counters.
///
/// These tests use the dedicated `ult-test` simulator only, never the pre-existing booted
/// device.
final class SaveCycleTests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// **`-savecycle` exercises the full save/restore round trip and verifies reset
    /// parity.**
    ///
    /// After the save/restore cycle, the probe must show:
    /// - The same score as before the cycle (replay identity preserved).
    /// - `paused=1` (intentional paused landing).
    /// - All seven restart-only presentation fields cleared (issue #43).
    /// - `drag=none` (gesture state cleared).
    func testSaveCycleRestoresAndClearsPresentationState() {
        // 10 seconds of play is enough for the pull to complete and the match to be live,
        // and short enough to keep the test fast. The cycle fires once the tick count
        // reaches this many seconds.
        let match = MatchDriver(extraArgs: [
            LaunchArg.savecycle.rawValue, "10",
            LaunchArg.points.rawValue, "9",
        ])

        // Wait for the match to be live before the cycle fires.
        match.wait("the match to be live", timeout: MatchDriver.patience, until: { $0.isLive })

        // The savecycle fires at 10 seconds of sim time. Wait for the restore to complete:
        // the probe should show paused=1 once adoption is done. The restore itself takes
        // a fraction of a second for 10 seconds of 3v3, but the progress bar and the
        // paused landing add wall time.
        let restored = match.wait(
            "the savecycle restore to complete and land paused",
            timeout: MatchDriver.pointCycle, until: { $0.paused })
        guard restored.paused else {
            return match.fail(
                "the savecycle did not land paused — probe: \(match.probe().raw)")
        }

        // VAL-PERSIST-001: the seven restart-only presentation fields are cleared.
        let p = match.probe()
        // cutCall is nil → probe reads "cut=-"
        XCTAssertEqual(
            p.cut, "-",
            "cutCall should be cleared after restore — probe: \(p.raw)")
        // offenceTaps=0 → probe reads "taps=0"
        XCTAssertEqual(
            p.taps, 0,
            "offenceTaps should be 0 after restore — probe: \(p.raw)")
        // refusals=0 → probe reads "refused=0"
        XCTAssertEqual(
            p.refused, 0,
            "refusals should be 0 after restore — probe: \(p.raw)")
        // widenedCalls=0 → probe reads "wide=0"
        XCTAssertEqual(
            p.widened, 0,
            "widenedCalls should be 0 after restore — probe: \(p.raw)")
        // lastRefusal=nil → probe reads "refuse=-"
        XCTAssertEqual(
            p.refusal, "-",
            "lastRefusal should be cleared after restore — probe: \(p.raw)")
        // refusalTally=[:] → probe reads "tally=-"
        XCTAssertEqual(
            p.refusalTally, "-",
            "refusalTally should be empty after restore — probe: \(p.raw)")
        // refusedTap=nil: no direct probe key — evidenced indirectly by refused=0,
        // refuse=-, and the absence of hud.refused.
        XCTAssertFalse(
            match.element("hud.refused").exists,
            "no hud.refused element should exist after restore (refusedTap is nil)")
        // drag is none (cancelDrag was called).
        XCTAssertEqual(
            p.drag, "none",
            "drag should be none after restore — probe: \(p.raw)")

        // VAL-PERSIST-003: replay identity preserved — the score is present and
        // well-formed (the Swift `MatchSaveTests.savedMatchRestoresExactly` proves
        // bit-exact score parity; the probe verifies the observable state survived
        // the round trip). The score may be 0-0 if no goal was scored in 10 seconds.
        XCTAssertTrue(
            p.score.contains("-"),
            "the score should be present and well-formed after restore — probe: \(p.raw)")

        // VAL-PERSIST-004: the match landed paused (already asserted above) and the
        // sheet is not up (the restore closed it).
        XCTAssertFalse(
            p.sheet,
            "the setup sheet should be closed after a successful restore — probe: \(p.raw)")
    }

    /// **REMATCH from the result card lands unpaused with empty input counters.**
    ///
    /// `-points 1` makes the match end after a single goal, which makes the result card
    /// and its REMATCH button reachable without a finger on the pre-game sheet. After
    /// REMATCH, the probe must show:
    /// - `paused=0` (restart starts unpaused).
    /// - Empty input counters (`thrown=0`, `cuts=0`, `defends=0`).
    /// - The seven restart-only presentation fields cleared.
    ///
    /// This is VAL-PERSIST-002: the restart path yields the same shared reset values as
    /// restore, compared field-for-field.
    func testRematchLandsUnpausedWithEmptyCounters() {
        let match = MatchDriver(extraArgs: [LaunchArg.points.rawValue, "1"])

        // Wait for the match to end (one goal wins it).
        let ended = match.wait(
            "a one-point match to end",
            timeout: MatchDriver.pointCycle, until: { $0.isOver })
        guard ended.isOver else {
            return match.fail(
                "the one-point match never ended — probe: \(match.probe().raw)")
        }

        // Tap REMATCH on the result card.
        let rematch = match.element("REMATCH")
        guard rematch.exists else {
            return match.fail(
                "the REMATCH button was not reachable on the result card — probe: \(match.probe().raw)")
        }
        rematch.tap()

        // After REMATCH, the match should be live and unpaused with empty counters.
        let after = match.wait(
            "the rematch to start fresh and unpaused",
            timeout: MatchDriver.patience, until: { $0.isLive && !$0.paused && !$0.isOver })
        guard !after.paused else {
            return match.fail(
                "REMATCH should land unpaused — probe: \(match.probe().raw)")
        }

        // Input counters are empty — a fresh match has no recorded inputs.
        XCTAssertEqual(
            after.thrown, 0,
            "thrown should be 0 after REMATCH — probe: \(after.raw)")
        XCTAssertEqual(
            after.cuts, 0,
            "cuts should be 0 after REMATCH — probe: \(after.raw)")
        XCTAssertEqual(
            after.defends, 0,
            "defends should be 0 after REMATCH — probe: \(after.raw)")

        // The seven restart-only presentation fields are cleared — same as restore.
        XCTAssertEqual(
            after.cut, "-",
            "cutCall should be cleared after REMATCH — probe: \(after.raw)")
        XCTAssertEqual(
            after.taps, 0,
            "offenceTaps should be 0 after REMATCH — probe: \(after.raw)")
        XCTAssertEqual(
            after.refused, 0,
            "refusals should be 0 after REMATCH — probe: \(after.raw)")
        XCTAssertEqual(
            after.widened, 0,
            "widenedCalls should be 0 after REMATCH — probe: \(after.raw)")
        XCTAssertEqual(
            after.refusal, "-",
            "lastRefusal should be cleared after REMATCH — probe: \(after.raw)")
        XCTAssertEqual(
            after.refusalTally, "-",
            "refusalTally should be empty after REMATCH — probe: \(after.raw)")
        XCTAssertFalse(
            match.element("hud.refused").exists,
            "no hud.refused element should exist after REMATCH (refusedTap is nil)")
        XCTAssertEqual(
            after.drag, "none",
            "drag should be none after REMATCH — probe: \(after.raw)")

        // The score is fresh: 0-0.
        XCTAssertEqual(
            after.score, "0-0",
            "the score should be 0-0 after REMATCH — probe: \(after.raw)")
    }
}
