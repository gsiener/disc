import UltimateSim
import XCTest

/// The charge meter, held by a thumb.
///
/// **This is the control that had never been checked by anything.** `ThrowCharge` has a unit
/// suite and the curve is a faithful port; `-charge 0.85` can pin the meter on screen for a
/// screenshot. What neither of those touches is the path in between — a real touch-down, a
/// real `FrameClock.beginCharge`, a real accumulation across frames, and a real `onEnded`
/// that reads `clock.hold` and grades it. Every one of those could be wrong in a way that
/// makes the meter a decoration, and until this file nothing would have noticed.
///
/// **The honest problem, stated before the tests.** XCUITest's finest timing control is
/// `press(forDuration:thenDragTo:withVelocity:thenHoldForDuration:)`, whose total touch
/// duration is the sum of three intervals of which the caller names two; the app then starts
/// its own clock at the first `onChanged`, a frame or two later. The perfect window for a
/// forehand is `perfectWindow / 1.08 ≈ 83 ms` wide, and the flash at its centre
/// (`isPerfect`) is `× 0.35` of that — under 30 ms. Asking a UI test to hit 30 ms blind
/// would be asking it to flake.
///
/// So the tests do two separable things, and neither of them is "assume the hold we asked
/// for is the hold we got":
///
///   1. **The mapping is asserted against the model.** For every throw, the grade the app
///      reported is checked against `ThrowCharge.for(type).grade(hold:)` evaluated on the
///      hold the app *measured*. That is the wiring — thumb → clock → charge → HUD — and it
///      is a real assertion: a release that read the wrong clock, applied the wrong throw's
///      difficulty, or graded against a stale hold fails it.
///   2. **The window is reached by calibration.** One throw measures the fixed overhead
///      between the hold requested and the hold delivered; the next aims at `fullTime` minus
///      that overhead and must land in the window. This is the end-to-end claim: a thumb
///      aiming at the bright band hits the bright band.
///
/// Both extremes are unambiguous and are asserted flat out: let go instantly and the game
/// must say `rushed`, hold for two seconds and it must say `overcharged`.
final class ChargeTests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// The throw the drag in `MatchDriver` makes: up and to the right is flat and
    /// right-handed, so the difficulty is the forehand's 1.08 and the window is
    /// `0.09 / 1.08`.
    private let charge = ThrowGesture.charge(for: .forehand)

    /// Drag, release, and report what the app measured and what it called it.
    ///
    /// **Retried, because the engine is allowed to refuse a release.** `humanRelease` returns
    /// false whenever the rules machine will not take the throw — the disc is in the air, the
    /// point is stopped for the check, the pull has not been staged — and `MatchView` records
    /// that as `dragend=refused` and nothing else. It happens: a run of this file caught one
    /// with the probe reading `mine=1` and the release refused a frame later. A player shrugs
    /// and throws again, so this does too, and the retry is bounded so a genuinely broken
    /// release still fails.
    private func throwOnce(_ match: MatchDriver, hold: TimeInterval) -> (hold: Double, grade: String) {
        var after: MatchDriver.Probe?
        for attempt in 0..<5 where after == nil {
            let before = match.waitToThrow()
            match.drag(hold: hold)
            let settled = match.wait(
                "the release to be resolved (attempt \(attempt + 1))", timeout: 10,
                until: { $0.thrown > before.thrown || $0.dragEnd == "refused" })
            if settled.thrown > before.thrown { after = settled }
        }
        guard let after else {
            XCTFail("five drags were all refused by the engine — probe: \(match.probe().raw)")
            return (0, "")
        }
        guard let measured = after.hold else {
            XCTFail("the probe reported no hold for a recorded throw — \(after.raw)")
            return (0, "")
        }
        XCTAssertEqual(
            after.throwType, "forehand",
            "the calibration assumes a forehand's window — probe: \(after.raw)")
        // (1) above: the grade must be the grade the model specifies for the hold the app
        // measured. Checked on every throw in this file rather than once, because it is the
        // cheap half and it is the half that catches a mis-wiring.
        XCTAssertEqual(
            after.grade, charge.grade(hold: measured).rawValue,
            "held \(measured)s: the app said \(after.grade), the model says "
                + charge.grade(hold: measured).rawValue)
        return (measured, after.grade)
    }

    /// **Let go immediately → RUSHED.**
    ///
    /// `minTime` for a forehand is `0.14 × 1.08 ≈ 151 ms`, and the shortest touch XCUITest
    /// will make is far inside that, so this needs no calibration and gets none. It is also
    /// the assertion that proves the clock starts at all: a `beginCharge` that never ran
    /// would report a hold of zero and grade `rushed` for the wrong reason — which is why the
    /// measured hold is asserted to be *nonzero* as well as short.
    func testLettingGoImmediatelyIsRushed() {
        let match = MatchDriver(self)
        let r = throwOnce(match, hold: 0)
        XCTAssertLessThan(
            r.hold, charge.minTime,
            "a flick should be inside minTime (\(charge.minTime)s)")
        XCTAssertEqual(r.grade, ReleaseGrade.rushed.rawValue)
    }

    /// **Hold for two seconds → OVERCHARGED.**
    ///
    /// `fullTime + overGrace / 1.08 ≈ 1.13 s` is where the wind-up starts costing quality, so
    /// two seconds is unambiguously past it however imprecise the harness is. `maxHold` is
    /// also 2.0, which means this is the bottom of the curve and the one hold where the app
    /// clamps — a good place for the clamp to be exercised by a real thumb.
    func testHoldingTooLongIsOvercharged() {
        let match = MatchDriver(self)
        let r = throwOnce(match, hold: 2.0)
        XCTAssertGreaterThan(
            r.hold, charge.fullTime + charge.overGrace,
            "two seconds of thumb should be past the grace")
        XCTAssertEqual(r.grade, ReleaseGrade.overcharged.rawValue)
    }

    /// **Aim at the bright band → the release is graded inside the window.**
    ///
    /// The end-to-end claim, and the one the charge exists to make: the meter promises that
    /// letting go when the bar reaches the band is a clean release, and a thumb that does so
    /// gets one.
    ///
    /// Calibrated rather than guessed. The first throw is a probe — a requested hold well
    /// inside the plateau, whose measured value gives the fixed overhead the harness adds
    /// (the initial press, the drag interpolation, and the frame or two before
    /// `beginCharge`). The second aims at `fullTime` less that overhead. If the overhead is
    /// stable — it is a sum of constants and one frame — the second throw lands in a window
    /// 83 ms wide.
    ///
    /// The assertion is `perfect` **or** `clean`, i.e. `inWindow`. Not `perfect` alone: that
    /// is a 30 ms target and demanding it would be demanding that XCUITest have precision it
    /// does not advertise. `inWindow` is still the interesting claim — outside it the game
    /// says nothing at all about your timing.
    func testAimingAtTheWindowGetsACleanRelease() {
        let match = MatchDriver(self)

        // The calibration throw. 0.60 s is on the plateau and well clear of both edges, so
        // whatever it measures is the overhead and not a clamp.
        let requested = 0.60
        let calibration = throwOnce(match, hold: requested)
        let overhead = calibration.hold - requested
        XCTAssertGreaterThanOrEqual(
            overhead, 0,
            "the app cannot have measured a shorter hold than the thumb was down for")

        // Aim at the centre of the band.
        let target = max(0, charge.fullTime - overhead)
        let aimed = throwOnce(match, hold: target)

        XCTAssertTrue(
            charge.inWindow(hold: aimed.hold),
            "aimed at \(charge.fullTime)s with \(String(format: "%.3f", overhead))s of measured "
                + "overhead; the app measured \(String(format: "%.3f", aimed.hold))s, which is "
                + "outside the ±\(String(format: "%.3f", charge.perfectWindow))s window and "
                + "graded \(aimed.grade)")
        XCTAssertTrue(
            aimed.grade == ReleaseGrade.perfect.rawValue
                || aimed.grade == ReleaseGrade.clean.rawValue,
            "a release in the window should be perfect or clean, was \(aimed.grade)")
    }
}
