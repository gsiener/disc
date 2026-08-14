import ProbeContract
import XCTest

/// Issue #55 — the throwing practice mode is reachable from the pre-game sheet, shows a
/// target and a thrower, and a drag-charge-release gesture actually flies the disc.
///
/// This is a manual-verification aid, not a differential check: the throw pipeline
/// (`DiscRuntime`, `humanReleaseParams`, `ThrowSolver`) is already validated by
/// `SimChecks`, and `PracticeView` is presentation only — a new composition of code
/// that's already tested, not new simulation logic. What this test can catch that
/// `SimChecks` cannot is the one thing a differential suite never touches: whether a
/// real finger on real glass reaches the view at all. Two screenshots are attached
/// (`.keepAlways`) so a run can be read back after the fact without a live Simulator.
final class PracticeModeTests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testPracticeModeReachableAndThrowable() {
        let app = XCUIApplication()
        app.launchArguments = [LaunchArg.probe.rawValue, ToggleValue.on.rawValue]
        app.launch()

        // A fresh install shows the coach cards over the sheet; skip them the same way
        // every other cross-flow test does. Race the skip against the PRACTICE button
        // rather than waiting out a fixed timeout for cards that usually never appear.
        let skip = app.buttons["coach.skip"]
        let practiceButton = app.buttons["PRACTICE"]
        let sheetDeadline = Date().addingTimeInterval(12)
        while Date() < sheetDeadline {
            if skip.exists { skip.tap() }
            if practiceButton.exists { break }
            if app.state == .notRunning { break }
            usleep(40_000)
        }

        guard practiceButton.waitForExistence(timeout: 10) else {
            return XCTFail(
                "the PRACTICE button should exist on the pre-game sheet, app state: \(app.state)")
        }
        practiceButton.tap()

        // PracticeView's own DONE button (top-right) is the signal the view actually
        // built and is on screen, in the same accessibility-existence spirit as the
        // rest of this suite — see `MatchDriver`'s comment on why touch tests do not
        // reach for a raw screen coordinate to prove a view showed up.
        let doneButton = app.buttons["DONE"]
        guard doneButton.waitForExistence(timeout: 10) else {
            return XCTFail("PracticeView (header/DONE) should appear after tapping PRACTICE")
        }

        attach(app.screenshot(), name: "practice-before-throw")

        // The throw: a drag from roughly where the thrower's hand is (see
        // `PracticeView.releaseOrigin`, offset a little in front of the player's feet)
        // straight up the screen. `ThrowGesture.interpret` reads a near-vertical drag
        // as a hammer (`rise >= 0.55`) and `ThrowGesture.aim` reads dx≈0 as "straight
        // downfield" — which is where this practice pitch's one target sits.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.80))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.28))
        start.press(
            forDuration: 0.05, thenDragTo: end,
            withVelocity: XCUIGestureVelocity(rawValue: 3000),
            thenHoldForDuration: 0.05)

        // Flight time plus the 1.6s result hold (`PracticeView.resetDelay`) plus
        // margin for the Simulator's own render pacing.
        usleep(3_000_000)
        attach(app.screenshot(), name: "practice-after-throw")

        // The view must still be alive and still be practice (not, say, crashed back
        // to the sheet) — DONE staying on screen is the cheap way to say so.
        XCTAssertTrue(
            app.buttons["DONE"].exists,
            "PracticeView should still be showing after a throw resolves")

        // Repeatability (issue #55): the disc resets to hand on its own
        // (`PracticeView.resetDisc`, fired `resetDelay` after touchdown) with no
        // relaunch and no leaving the view — so a second throw right here must fly
        // exactly like the first one did.
        start.press(
            forDuration: 0.05, thenDragTo: end,
            withVelocity: XCUIGestureVelocity(rawValue: 3000),
            thenHoldForDuration: 0.05)
        usleep(3_000_000)
        attach(app.screenshot(), name: "practice-second-throw")
        XCTAssertTrue(
            app.buttons["DONE"].exists,
            "PracticeView should still be showing after a second throw — the reset-to-hand"
                + " path must not need a relaunch")

        // DONE returns to the sheet, and the sheet's own controls should be reachable
        // again — the repeatability the issue asks for is "throw again", but "leave and
        // the app is not stuck" is the other half of not breaking the normal flow.
        app.buttons["DONE"].tap()
        XCTAssertTrue(
            app.buttons["PRACTICE"].waitForExistence(timeout: 10),
            "leaving practice should return to the pre-game sheet")
    }

    private func attach(_ screenshot: XCUIScreenshot, name: String) {
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
