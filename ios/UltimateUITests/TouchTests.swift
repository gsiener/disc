import XCTest

/// The four things a finger does, done with a finger.
///
/// **This is the first play-testing this game has had.** Everything player-facing was
/// verified twice before now — headless calls to the same function a finger would call, and
/// launch arguments that pin a state for a screenshot — and neither of those is a touch. Six
/// agents established that synthetic touch injection does not reach this Simulator from
/// outside: `CGEvent` posting moves the cursor and delivers nothing, `AXIsProcessTrusted()`
/// returns true and changes nothing, `screencapture -R` is denied, `idb` is not installed,
/// and `xcrun simctl ui` only sets appearance. XCUITest is not outside — it runs in the app's
/// process and drives UIKit's own recognisers — so these are real touches on the real
/// `DragGesture` and `SpatialTapGesture` in `MatchView`.
///
/// Every test here asserts a *consequence*, never "did not crash":
///
///   - the drag asserts a throw was recorded in the match's own input tape, which is the
///     same list `saveMatch` writes and `Replay` replays;
///   - the offensive tap asserts the `GO DEEP / #7 IS GOING` plate is on screen;
///   - the defensive tap asserts the `GO GET IT / #9 IS BIDDING` plate is;
///   - the abort asserts the gesture took the cancel branch and that nothing was thrown —
///     see there for the one thing XCUITest turns out not to be able to see.
///
/// The charge — the one control that had never been checked at all — is in `ChargeTests`.
final class TouchTests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// **Drag from the thrower → a throw is released.**
    ///
    /// The oracle is `thrown`, which the probe counts off `MatchView.inputs` — the recorded
    /// input tape. That is a deliberately strict choice over "the disc moved": only a release
    /// the engine *accepted* is appended (see `throwGesture`), so a count that went up means
    /// `humanRelease` returned true and the throw is one a replay would reproduce. A visual
    /// oracle would also have passed for a disc that fell out of a hand.
    ///
    /// **`-receive us` is why this test is seconds rather than a minute**, and the driver
    /// defaults to it. What is waited for is a pull settling, flying and being caught, not a
    /// whole point cycle. Nothing about the gesture or the oracle changed with it.
    func testDragReleasesAThrow() {
        let match = MatchDriver()
        XCTAssertEqual(
            match.probe().thrown, 0, "nothing should have been thrown before the first drag")

        // Retried, because the disc can change hands between the wait and the gesture, and an
        // unlucky match is relaunched rather than waited out — see `MatchDriver.withTheDisc`. A
        // refused release spends an attempt and is not a pass.
        let after = match.withTheDisc(
            "a drag to throw",
            act: { _ in match.drag(hold: 0.4) },
            resolve: { before, now in now.thrown > before.thrown ? now : nil })
        guard let after else {
            return XCTFail(
                "four drags from our own thrower recorded no throw — probe: \(match.probe().raw)")
        }
        XCTAssertEqual(after.dragEnd, "throw", "the drag should have ended as a throw")
        // The drag went up and to the right, which `ThrowGesture.interpret` reads as flat and
        // right-handed. If the screen convention ever flips, this is where it shows.
        XCTAssertEqual(
            after.throwType, "forehand",
            "an up-and-right drag is a flat forehand — probe: \(after.raw)")
        // And the gesture is put down after itself. A drag that outlived its thumb used to
        // pin the aim overlay and grade every later throw `overcharged`; see `cancelDrag`.
        XCTAssertEqual(after.drag, "none", "the aim overlay should be gone after the release")
    }

    /// **Tap the grass on offence → a cutter is commanded.**
    ///
    /// Two oracles, because they say different halves. The `cuts` counter proves the engine
    /// took the order and wrote it to the input tape; the `hud.cut` plate proves the player was
    /// *told*, which is the whole reason `CutCall` exists — a commitment you cannot see is a
    /// button that does nothing.
    ///
    /// **The tap is still retried, and it now almost never needs to be.** A refused tap used
    /// to be the common case: `humanCallCut` returns nil when the 35° cone is empty, and on a
    /// minis pitch there are two team-mates, so most directions named nobody — measured with a
    /// finger, roughly one tap in three landed on somebody. `MatchView.callCut` now widens an
    /// empty cone to the half of the pitch the finger pointed at, so a tap on the grass during
    /// our own possession is an order almost every time; `RefusalTests` measures both rates in
    /// one run. The loop stays because the *legality* of a call still comes and goes with
    /// possession and the cooldown, which is a different thing from the aim being refused.
    func testTapOnOffenceCommandsACutter() {
        let match = MatchDriver()
        let before = match.waitToAct("a cut to be legal", until: { $0.canCut })
        XCTAssertEqual(before.cuts, 0)

        // Upfield of centre and spread across the width — the spaces a thrower actually
        // attacks. Every one is a point on the grass (anything above the horizon returns nil
        // from `MatchScene.groundPoint` and is not a tap at all), and every one is a fraction
        // of the *pitch* rather than of the window, so it is the same piece of grass in a
        // release build as in a debug one; see `MatchDriver.pitchPoint`.
        let targets = [
            (0.50, 0.34), (0.30, 0.36), (0.70, 0.36), (0.50, 0.46), (0.38, 0.30), (0.62, 0.30),
            (0.24, 0.46), (0.76, 0.46),
        ]
        var said: String?
        var tried = 0
        for attempt in 0..<16 where said == nil {
            let t = targets[attempt % targets.count]
            // Legal again: the previous refusal may have been the `cutStagger` cooldown rather
            // than an empty cone.
            match.waitToAct("a cut to be legal (attempt \(attempt + 1))", until: { $0.canCut })
            tried += 1
            if let plates = match.tapAndWatch(
                match.pitchPoint(t.0, t.1), counter: { $0.cuts }, plates: ["hud.cut"], within: 0.6)
            {
                said = plates["hud.cut"] ?? ""
            }
        }
        guard let said else {
            return XCTFail("\(tried) taps on the grass sent nobody — probe: \(match.probe().raw)")
        }
        XCTAssertFalse(
            said.isEmpty,
            "a cut was commanded and the order plate never appeared — probe: \(match.probe().raw)")
        // "GO DEEP", "COME UNDER", "STRIKE" — whichever route the cone resolved to — and then
        // the runner. `CutCall.detail` is "#<jersey> IS GOING" whenever a body was named, which
        // it always is on an accepted call.
        XCTAssertTrue(
            said.contains("IS GOING") || said.contains("CUTTING"),
            "the cut plate should name the runner, said: \(said)")
    }

    /// **Tap on defence → a defender is committed.**
    ///
    /// The same tap as the offensive one, routed by who has the disc — see `MatchView.tap`,
    /// where the two meanings are *decided* rather than moded. So this is also the only check
    /// that the routing is live: a bug that sent every tap down one branch would pass the
    /// offensive test and fail here.
    ///
    /// The location is deliberately ignored by the engine on defence — where to go is the
    /// disc's business — so this taps the middle of the pitch.
    ///
    /// **Two plates count as the screen answering, and the second one is the interesting
    /// case.** `defenceReadout` gives its rectangle to the recovery line first: once the
    /// committed body is on the floor, `DOWN / BACK UP IN 1.4s` replaces `GO GET IT`, because
    /// by then the order is history and the only fact left is when you get them back. A bid
    /// that turns into a dive within a frame or two of the tap therefore shows `hud.recovery`
    /// and never `hud.defence` — which is the HUD working as designed, and is the layout cost
    /// `docs/gameplay-design.md` §4 requires to be legible.
    func testTapOnDefenceCommitsADefender() {
        // **The one test that wants the opponent holding it**, so it is the one that asks for
        // `-receive them` — which is what the app does with no argument at all. Naming it here
        // rather than relying on the default is the point: this test's precondition is the
        // opposite of every other one's, and a silent default is how that gets lost.
        let match = MatchDriver(receives: .them)
        let before = match.waitToAct("the other team to have the disc", until: { $0.canDefend })
        XCTAssertEqual(before.defends, 0)

        var plates: [String: String]?
        var tried = 0
        for attempt in 0..<12 where plates == nil {
            match.waitToAct(
                "a defensive tap to be legal (attempt \(attempt + 1))", until: { $0.canDefend })
            tried += 1
            plates = match.tapAndWatch(
                match.pitchPoint(0.5, 0.5), counter: { $0.defends },
                plates: ["hud.defence", "hud.recovery"], within: 0.6)
        }
        guard let plates else {
            return XCTFail("\(tried) taps on defence committed nobody — probe: \(match.probe().raw)")
        }
        let order = plates["hud.defence"]
        let down = plates["hud.recovery"]
        XCTAssertFalse(
            plates.isEmpty,
            "a defender was committed and neither the order nor the recovery plate was up — "
                + "probe: \(match.probe().raw)")
        if let order {
            XCTAssertTrue(
                order.contains("GO GET IT") || order.contains("CLOSE HIM DOWN"),
                "the defence plate should name the order, said: \(order)")
        } else if let down {
            XCTAssertTrue(
                down.contains("BACK UP IN"),
                "the recovery plate should count the layout cost down, said: \(down)")
        }
    }

    /// **Drag back to the origin → the throw aborts.**
    ///
    /// **Two limits of XCUITest are load-bearing here and neither is hidden.**
    ///
    /// *There is no multi-waypoint drag.* `press(forDuration:thenDragTo:withVelocity:
    /// thenHoldForDuration:)` is one straight segment, so a literal out-and-back — thumb to the
    /// far side of the screen and home again — is not expressible in the public API. What is
    /// driven instead is the state that path produces, through the code that produces it: a drag
    /// long enough to pass `ThrowGesture.minimumDrag` (8 pt) and therefore start the gesture,
    /// whose live point is inside `MatchView.cancelRadius` (26 pt) of where it began.
    /// `interpret` recomputes `aborted` on every `onChanged` from exactly that comparison, so
    /// this is the same `DragState`, the same grey dashed line, and the same `onEnded` branch a
    /// returning thumb reaches.
    ///
    /// *The screen cannot be read while a gesture is running.* Every XCUITest gesture blocks
    /// the main thread for its whole duration, and moving it to another queue makes the runner
    /// throw `NSInternalInconsistencyException, "Must be called on the main thread"` — tried,
    /// and it crashes the runner mid-suite. So the CANCEL *label*, which exists only while the
    /// thumb is down, is not observable from a UI test at all. This asserts the abort's two
    /// lasting consequences instead: the gesture took the cancel branch, and nothing was
    /// thrown. That branch and the CANCEL rendering are selected by the same `d.aborted`
    /// boolean one frame apart, so what stays unverified is a single read inside the view.
    func testDragBackToTheOriginCancelsTheThrow() {
        let match = MatchDriver()

        // **A `refused` drag is a spent attempt, not a result, and this is where CI proved
        // it.** Run 31384063453 timed out here on a hardcoded 5 s with `poss=1;mine=0`: the
        // possession changed hands between the wait and the gesture, so the engine refused the
        // release and no `dragend` of either kind arrived. Resolving only on a drag *this
        // attempt* decided — `cancel` or `throw`, and different from what `dragend` already
        // said — makes that a retry instead of a failure, and keeps the assertion exactly as
        // strict: the decision has to be `cancel`.
        let resolved = match.withTheDisc(
            "a drag that comes home",
            act: { _ in
                // 19 pt across: past the 8 pt floor that starts the gesture, inside the 26 pt
                // radius that calls it off. In points via a coordinate offset rather than a
                // normalised one, because both thresholds are absolute point distances and
                // must not scale with the screen.
                let start = match.throwerPoint
                start.press(
                    forDuration: 0.01, thenDragTo: start.withOffset(CGVector(dx: 18, dy: -6)),
                    withVelocity: XCUIGestureVelocity(rawValue: 400),
                    thenHoldForDuration: 0.4)
            },
            resolve: { before, now -> (before: MatchDriver.Probe, after: MatchDriver.Probe)? in
                // **A change in `dragend`, not a value in it, and the difference is a real
                // failure rather than a style point.** `dragend` is sticky: `lastDragEnd` holds
                // the *previous* drag's outcome and nothing clears it, so `contains(now.dragEnd)`
                // on its own is also satisfied by an earlier attempt whose result landed after
                // that attempt's `settle` had expired. This poll would then return instantly, on
                // a gesture it never made, and the assertions below would name the cancel control
                // for a drag nobody in this attempt performed.
                //
                // `before` is the probe read a few milliseconds before the gesture — see
                // `withTheDisc` — so requiring the field to *move* across the gesture is a tight
                // statement of "this drag is the one that decided it". What it cannot catch is a
                // stale result that repeats a value verbatim (a late `cancel` read into `before`,
                // then a real `cancel`); that spends the attempt, so the worst case is this test
                // failing as "never resolved" — a complaint about the harness, which is where it
                // belongs — rather than as "the cancel threw something", which is a false
                // accusation about the game. Closing it entirely would need a per-gesture counter
                // on the probe, which `dragend` is not.
                guard now.dragEnd != before.dragEnd, ["cancel", "throw"].contains(now.dragEnd)
                else { return nil }
                return (before, now)
            })
        guard let resolved else {
            return XCTFail(
                "four drags inside the cancel radius were never resolved either way — probe: "
                    + match.probe().raw)
        }
        let (before, after) = resolved
        XCTAssertEqual(
            after.dragEnd, "cancel",
            "a drag released inside the cancel radius should have been called off — probe: "
                + after.raw)
        // **Against the count before the gesture, not against zero.** An attempt inside
        // `withTheDisc` may have relaunched the app, which resets `MatchView.inputs` — and even
        // where it has not, a literal 0 is an assertion about the whole match where the only
        // claim this test owns is about one drag. Same reasoning as `ChargeTests.throwOnce`.
        XCTAssertEqual(
            after.thrown, before.thrown,
            "a cancelled drag must not throw anything — \(before.thrown) thrown before the "
                + "gesture, \(after.thrown) after — probe: " + after.raw)
        XCTAssertEqual(after.drag, "none", "the aim overlay should be gone")
    }
}
