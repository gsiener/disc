import ProbeContract
import XCTest

/// Probe accessibility, wire format, and field-semantics UI tests.
/// — VAL-PROBE-001, VAL-PROBE-002, VAL-PROBE-003, VAL-PROBE-004.
///
/// These tests verify the probe accessibility element through the real user
/// surface (XCUITest on the dedicated simulator). The Swift SimTests cover the
/// contract/parser parts of VAL-PROBE-002 and VAL-PROBE-004 and the
/// process-loss sentinel part of VAL-PROBE-001; the methods here cover the
/// XCUITest evidence each assertion also requires.
///
/// The probe is read via accessibility element with identifier
/// `ProbeContract.probeIdentifier` — black-box, no FlightUI import.
final class ProbeTests: XCTestCase {

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

    /// The set of always-emitted (retained) keys that must be present in every
    /// live probe payload. The conditional keys grade/hold/type are checked
    /// separately because they are "-" pre-throw.
    private static let alwaysEmittedKeys: [ProbeKey] = [
        .poss, .phase, .mine, .cutOk, .defOk, .rec,
        .thrown, .cuts, .defends, .taps, .refused, .wide,
        .refuse, .tally, .rect, .drag, .dragend, .cut, .def,
        .score, .over, .paused, .sheet,
    ]

    // MARK: - VAL-PROBE-001 — Probe element accessibility, readiness, and non-interference

    /// Under `-probe on`, the accessibility element exists, is queryable, has a
    /// non-empty label, and the snapshot parses with all retained keys present
    /// and a valid `rect`.
    func testProbeOnElementExistsAndSnapshotIsParseable() {
        let app = launch([
            LaunchArg.probe.rawValue, ToggleValue.on.rawValue,
            LaunchArg.setup.rawValue, SetupValue.off.rawValue,
        ])
        let el = probeElement(app)
        XCTAssertTrue(el.exists, "the probe element should exist under -probe on")
        XCTAssertFalse(el.label.isEmpty, "the probe label should be non-empty")

        let p = readProbe(app)
        XCTAssertFalse(p.raw.isEmpty, "the raw probe label should be non-empty")
        // Every always-emitted key is present.
        for key in Self.alwaysEmittedKeys {
            XCTAssertNotNil(
                p.fields[key.rawValue],
                "\(key.rawValue) should be present in a live probe payload — probe: \(p.raw)")
        }
        // The conditional keys are present too (as "-" pre-throw).
        XCTAssertNotNil(p.fields[ProbeKey.grade.rawValue], "grade should be present")
        XCTAssertNotNil(p.fields[ProbeKey.hold.rawValue], "hold should be present")
        XCTAssertNotNil(p.fields[ProbeKey.type.rawValue], "type should be present")
        // The rect parses to a valid pitch rect.
        guard let rect = p.pitch else {
            return XCTFail("the probe rect should parse to a valid rect — probe: \(p.raw)")
        }
        XCTAssertGreaterThan(rect.width, 0, "the pitch rect should have positive width")
        XCTAssertGreaterThan(rect.height, 0, "the pitch rect should have positive height")
    }

    /// The probe element persists throughout a live match — it is not dropped for
    /// opacity/size mid-match. Continuous probe reads during a poll loop return a
    /// non-empty label that parses to a snapshot with all retained keys.
    func testProbePersistsThroughLiveMatch() {
        let match = MatchDriver()
        // Wait for the match to be live.
        let live = match.wait(
            "the match to be live",
            timeout: MatchDriver.patience, until: { $0.isLive })
        XCTAssertTrue(live.isLive, "the match should be live — probe: \(live.raw)")

        // Poll the probe for a sustained window and confirm the element remains
        // in the tree with a non-empty, parseable label and all retained keys.
        let deadline = Date().addingTimeInterval(MatchDriver.possession)
        var samples = 0
        var allPresent = true
        while Date() < deadline {
            let el = match.app.descendants(matching: .any)
                .matching(identifier: ProbeContract.probeIdentifier).firstMatch
            XCTAssertTrue(
                el.exists,
                "the probe element should persist mid-match — samples: \(samples)")
            let raw = el.label
            if raw.isEmpty {
                XCTFail("the probe label should not be empty mid-match — samples: \(samples)")
                return
            }
            let p = Probe(raw)
            for key in Self.alwaysEmittedKeys {
                if p.fields[key.rawValue] == nil {
                    allPresent = false
                    XCTFail(
                        "\(key.rawValue) should be present in every live sample — probe: \(raw)")
                }
            }
            // The rect should remain valid.
            if p.pitch == nil {
                XCTFail("the probe rect should remain valid mid-match — probe: \(raw)")
                return
            }
            samples += 1
            usleep(200_000) // 0.2s between samples
        }
        XCTAssertGreaterThan(samples, 0, "at least one sample should have been taken")
        XCTAssertTrue(allPresent, "all retained keys should be present in every sample")
    }

    /// A gesture overlapping the probe frame is delivered to the game — the probe
    /// does not swallow touches. A tap on the pitch during our possession that
    /// increments `cuts` proves the touch reached the game through the probe's
    /// frame.
    func testProbeDoesNotSwallowTouches() {
        let match = MatchDriver()
        // Wait for a cut to be legal (our possession).
        let before = match.waitToAct("a cut to be legal", until: { $0.canCut })
        XCTAssertEqual(before.cuts, 0, "cuts should start at 0")

        // Tap on the pitch — the probe element covers the pitch, so this tap
        // overlaps the probe frame. If the probe swallowed touches, `cuts`
        // would never advance.
        var advanced = false
        let targets = [(0.50, 0.34), (0.30, 0.36), (0.70, 0.36), (0.50, 0.46)]
        for (i, t) in targets.enumerated() {
            match.waitToAct("a cut to be legal (attempt \(i + 1))", until: { $0.canCut })
            if match.tapAndWatch(
                match.pitchPoint(t.0, t.1), counter: { $0.cuts },
                plates: ["hud.cut"], within: 0.6) != nil
            {
                advanced = true
                break
            }
        }
        XCTAssertTrue(
            advanced,
            "a tap overlapping the probe frame should reach the pitch and advance cuts — probe: \(match.probe().raw)")
    }

    /// The probe reappears after relaunch with a ready snapshot.
    func testProbeReappearsAfterRelaunch() {
        let match = MatchDriver()
        // Confirm the probe is present initially.
        let el = match.app.descendants(matching: .any)
            .matching(identifier: ProbeContract.probeIdentifier).firstMatch
        XCTAssertTrue(el.exists, "the probe should exist before relaunch")

        // Relaunch.
        let ready = match.relaunch()
        XCTAssertTrue(ready, "the app should be ready after relaunch")

        // The probe reappears with a ready snapshot.
        let el2 = match.app.descendants(matching: .any)
            .matching(identifier: ProbeContract.probeIdentifier).firstMatch
        XCTAssertTrue(el2.exists, "the probe should reappear after relaunch")
        XCTAssertFalse(el2.label.isEmpty, "the probe label should be non-empty after relaunch")

        let p = Probe(el2.label)
        // The snapshot is parseable with all retained keys.
        for key in Self.alwaysEmittedKeys {
            XCTAssertNotNil(
                p.fields[key.rawValue],
                "\(key.rawValue) should be present after relaunch — probe: \(p.raw)")
        }
        XCTAssertNotNil(p.pitch, "the rect should be valid after relaunch — probe: \(p.raw)")
    }

    /// Without `-probe on`, no probe element exists.
    func testProbeAbsentWithoutOn() {
        let app = launchNoProbe([
            LaunchArg.setup.rawValue, SetupValue.off.rawValue,
        ])
        let el = probeElement(app)
        XCTAssertFalse(
            el.exists,
            "no probe element should exist without -probe on")
    }

    // MARK: - VAL-PROBE-002 — Wire format and key presence (XCUITest evidence)

    /// The probe label matches the `k=v;k=v` pattern (semicolon-delimited, no
    /// braces, no JSON, no trailing separator), and the conditional keys
    /// grade/hold/type are "-" pre-throw and populated post-throw.
    func testWireFormatAndConditionalKeys() {
        let match = MatchDriver()

        // --- Pre-throw: read the probe before any gesture. ---
        let preThrow = match.wait(
            "the match to be live",
            timeout: MatchDriver.patience, until: { $0.isLive })
        XCTAssertTrue(preThrow.isLive, "the match should be live — probe: \(preThrow.raw)")

        // The label matches k=v;k=v: no braces, no JSON quotes, no trailing separator.
        let raw = preThrow.raw
        XCTAssertFalse(raw.hasPrefix("{"), "no leading brace — probe: \(raw)")
        XCTAssertFalse(raw.hasSuffix("}"), "no trailing brace — probe: \(raw)")
        XCTAssertFalse(raw.hasSuffix(";"), "no trailing separator — probe: \(raw)")
        XCTAssertFalse(raw.contains("\""), "no JSON quotes — probe: \(raw)")

        // Every pair contains an "=".
        for pair in raw.split(separator: ";") {
            XCTAssertTrue(
                pair.contains("="),
                "every pair should contain '=' — pair: \(pair) — probe: \(raw)")
        }

        // Conditional keys are "-" pre-throw.
        XCTAssertEqual(preThrow.grade, "-", "grade should be '-' pre-throw — probe: \(raw)")
        XCTAssertEqual(preThrow.hold, nil, "hold should be nil ('-') pre-throw — probe: \(raw)")
        XCTAssertEqual(preThrow.throwType, "-", "type should be '-' pre-throw — probe: \(raw)")

        // --- Post-throw: perform a drag and read the probe after. ---
        let after = match.withTheDisc(
            "a drag to throw",
            act: { _ in match.drag(hold: 0.4) },
            resolve: { before, now in now.thrown > before.thrown ? now : nil })
        guard let after else {
            return match.fail(
                "a drag should have produced a throw — probe: \(match.probe().raw)")
        }

        // The label still matches k=v;k=v.
        let postRaw = after.raw
        XCTAssertFalse(postRaw.hasPrefix("{"), "no leading brace post-throw — probe: \(postRaw)")
        XCTAssertFalse(postRaw.hasSuffix("}"), "no trailing brace post-throw — probe: \(postRaw)")
        XCTAssertFalse(postRaw.hasSuffix(";"), "no trailing separator post-throw — probe: \(postRaw)")
        XCTAssertFalse(postRaw.contains("\""), "no JSON quotes post-throw — probe: \(postRaw)")

        // Conditional keys are populated post-throw.
        XCTAssertNotEqual(after.grade, "-", "grade should be populated post-throw — probe: \(postRaw)")
        XCTAssertNotNil(after.hold, "hold should be populated post-throw — probe: \(postRaw)")
        XCTAssertNotEqual(after.throwType, "-", "type should be populated post-throw — probe: \(postRaw)")
    }

    // MARK: - VAL-PROBE-003 — Retained key/value field semantics

    /// Each retained field encodes its documented state. This test reads the
    /// probe at several documented app states and verifies the fields match.
    func testRetainedFieldSemantics() {
        // --- State 1: live match, our possession (-receive us). ---
        let match = MatchDriver(receives: .us)
        let live = match.wait(
            "the match to be live",
            timeout: MatchDriver.patience, until: { $0.isLive })
        XCTAssertTrue(live.isLive, "the match should be live — probe: \(live.raw)")

        // phase is "live" during a live match.
        XCTAssertEqual(live.phase, "live", "phase should be 'live' — probe: \(live.raw)")
        // poss is 0 or 1 (a team).
        XCTAssertTrue(
            live.poss == 0 || live.poss == 1,
            "poss should be 0 or 1 — probe: \(live.raw)")
        // score is "x-y".
        XCTAssertTrue(
            live.score.contains("-"),
            "score should be 'x-y' — probe: \(live.raw)")
        // over/paused/sheet are flags (0 or 1).
        XCTAssertFalse(live.isOver, "over should be 0 in a live match — probe: \(live.raw)")
        XCTAssertFalse(live.paused, "paused should be 0 in a live match — probe: \(live.raw)")
        XCTAssertFalse(live.sheet, "sheet should be 0 under -setup off — probe: \(live.raw)")
        // drag is none/aim/cancel.
        XCTAssertTrue(
            ["none", "aim", "cancel"].contains(live.drag),
            "drag should be none/aim/cancel — probe: \(live.raw)")
        // dragend is throw/cancel/refused/-.
        XCTAssertTrue(
            ["throw", "cancel", "refused", "-"].contains(live.dragEnd),
            "dragend should be throw/cancel/refused/- — probe: \(live.raw)")
        // refuse is a reason or "-".
        // tally is sorted reason:count or "-".
        // rec is recovery seconds or "-".
        // cut/def are plate title|detail or "-".
        // Counters are non-negative integers.
        XCTAssertGreaterThanOrEqual(live.thrown, 0, "thrown should be >= 0 — probe: \(live.raw)")
        XCTAssertGreaterThanOrEqual(live.cuts, 0, "cuts should be >= 0 — probe: \(live.raw)")
        XCTAssertGreaterThanOrEqual(live.defends, 0, "defends should be >= 0 — probe: \(live.raw)")
        XCTAssertGreaterThanOrEqual(live.taps, 0, "taps should be >= 0 — probe: \(live.raw)")
        XCTAssertGreaterThanOrEqual(live.refused, 0, "refused should be >= 0 — probe: \(live.raw)")
        XCTAssertGreaterThanOrEqual(live.widened, 0, "wide should be >= 0 — probe: \(live.raw)")

        // --- State 2: under -receive us, mine becomes 1 within the possession window. ---
        let withDisc = match.wait(
            "the disc in our hand",
            timeout: MatchDriver.possession, until: { $0.canThrow })
        XCTAssertTrue(
            withDisc.canThrow,
            "canThrow should arrive under -receive us — probe: \(withDisc.raw)")
        // mine is 1 iff the controlled body is the holder.
        XCTAssertEqual(
            withDisc.poss, 0,
            "poss should be 0 (us) when we have the disc — probe: \(withDisc.raw)")
        // canThrow is flag(.mine), so mine=1 when canThrow is true.
        XCTAssertEqual(
            withDisc.flag(.mine), true,
            "mine should be 1 when canThrow is true — probe: \(withDisc.raw)")

        // --- State 3: under -receive them, canDefend arrives and mine is 0. ---
        let match2 = MatchDriver(receives: .them)
        let def = match2.wait(
            "a defensive situation",
            timeout: MatchDriver.possession, until: { $0.canDefend })
        XCTAssertTrue(
            def.canDefend,
            "canDefend should arrive under -receive them — probe: \(def.raw)")
        // When they have the disc, mine is 0.
        XCTAssertEqual(
            def.flag(.mine), false,
            "mine should be 0 when they have the disc — probe: \(def.raw)")

        // --- State 4: after a throw, grade/hold/type are populated. ---
        let match3 = MatchDriver()
        let after = match3.withTheDisc(
            "a drag to throw",
            act: { _ in match3.drag(hold: 0.4) },
            resolve: { before, now in now.thrown > before.thrown ? now : nil })
        guard let after else {
            return match3.fail(
                "a throw should have been recorded — probe: \(match3.probe().raw)")
        }
        XCTAssertGreaterThan(after.thrown, 0, "thrown should be > 0 after a throw — probe: \(after.raw)")
        XCTAssertNotEqual(after.grade, "-", "grade should be populated after a throw — probe: \(after.raw)")
        XCTAssertNotNil(after.hold, "hold should be populated after a throw — probe: \(after.raw)")
        XCTAssertNotEqual(after.throwType, "-", "type should be populated after a throw — probe: \(after.raw)")
        XCTAssertEqual(after.dragEnd, "throw", "dragend should be 'throw' after a release — probe: \(after.raw)")
        XCTAssertEqual(after.drag, "none", "drag should be 'none' after release — probe: \(after.raw)")
    }

    // MARK: - VAL-PROBE-004 — `flight` and `coach` keys are removed (XCUITest evidence)

    /// A probe label read during a live match contains neither `flight=` nor
    /// `coach=`.
    func testNoFlightOrCoachInProbeLabel() {
        let match = MatchDriver()
        // Wait for the match to be live and read the probe.
        let live = match.wait(
            "the match to be live",
            timeout: MatchDriver.patience, until: { $0.isLive })
        XCTAssertTrue(live.isLive, "the match should be live — probe: \(live.raw)")

        // Assert neither token appears in the label.
        XCTAssertFalse(
            live.raw.contains("flight="),
            "the probe label should not contain 'flight=' — probe: \(live.raw)")
        XCTAssertFalse(
            live.raw.contains("coach="),
            "the probe label should not contain 'coach=' — probe: \(live.raw)")

        // Also check after a throw, when more fields are populated.
        let after = match.withTheDisc(
            "a drag to throw",
            act: { _ in match.drag(hold: 0.4) },
            resolve: { before, now in now.thrown > before.thrown ? now : nil })
        if let after {
            XCTAssertFalse(
                after.raw.contains("flight="),
                "the probe label should not contain 'flight=' post-throw — probe: \(after.raw)")
            XCTAssertFalse(
                after.raw.contains("coach="),
                "the probe label should not contain 'coach=' post-throw — probe: \(after.raw)")
        }
    }
}
