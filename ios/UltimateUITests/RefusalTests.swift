import XCTest

/// The taps the game will not take, and the rate at which it takes the rest.
///
/// **Why this suite exists.** The first play session with a real finger measured two things
/// about the tap, and they were the same finding twice: roughly one tap in three found
/// somebody on a minis pitch, and the other two were refused *silently* — nothing on screen
/// distinguished "nobody was there" from "my tap did not register". A control that fails
/// invisibly two times in three cannot be learned, because every failure teaches the player
/// something different and none of them is true.
///
/// So there are two kinds of test here and they guard the two halves of the fix:
///
///   - **The refusal is visible.** Each of these drives a tap whose refusal is *provable* from
///     the state the app is in — not "usually refused" — and asserts the words are on the
///     screen. `hud.refused` carries both lines of the plate as one label, so the assertion is
///     on the sentence a player reads. The two provable ones are the phase (nothing is legal
///     before a pull) and the geometry (a ray above the horizon never meets the grass); the
///     cooldown is not testable at this timing resolution and there is a note below saying why.
///   - **The hit rate is measured.** `testTheOffensiveTapUsuallyMeansSomething` taps the grass
///     as many times as a two-minute possession allows and reports both rates off the probe's
///     tap ledger: what the 35° cone alone would have accepted, and what the widened tap path
///     actually accepted. Both numbers come out of the same taps, so nothing has to be
///     re-measured against an older build to compare.
///
/// **The plate outlives an accessibility read on purpose.** `RefusedTap.duration` is 1.4 s
/// against the order plates' 1.1 s, because one `XCUIElement.label` read against this view
/// tree costs 0.4–0.9 s on this simulator (see `.agents/friction-log`) — a legibility fix that
/// could not be read by the test guarding it would be a legibility fix on trust.
final class RefusalTests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// **Tap before the pull → NOT IN PLAY.**
    ///
    /// The most provable refusal in the game and the one a new player hits first: the app opens
    /// with `-setup off` straight into `prePull`, where a disc is in a hand and the point has
    /// not started. Neither half of the tap is available — `humanCallCut` demands
    /// `livePossession` and `humanDefend` demands a live point — so this tap is refused
    /// whichever way `MatchView.tap` routes it, which is why the assertion is on the reason and
    /// not on which branch produced it.
    ///
    /// **The phase is waited for rather than raced.** `-setup off` opens in `prePull` and the
    /// engine pulls for itself five seconds later, which is less than a launch plus a coach-card
    /// dismissal plus a first accessibility read has to spare. So this waits for the probe to
    /// report a phase that is not `live` — true the instant the app opens, and true again at
    /// every stoppage after a goal, so the test cannot lose its window.
    ///
    /// **And it asks for `-receive them`, which is the one thing here that is not the default.**
    /// The window this test needs is `PRE_PULL`, and how long that lasts depends on who is
    /// pulling: a computer-run line pulls after `EngineConfig.pullSettle`, 0.8 s, while a human
    /// one gets `pullDeadline`, 5 s, before the engine pulls for it. `-receive us` hands the pull
    /// to the opponent and would close this window in under a second — before a launch and a
    /// first accessibility read can reach it — leaving nothing but the next goal, a whole point
    /// away. So the test that needs the pre-pull phase is the test that wants our team pulling.
    func testATapBeforeThePullSaysTheGameIsNotLive() {
        let match = MatchDriver(receives: .them)
        // **On `pointCycle`, and this is the one wait in the suite that genuinely needs a point.**
        // The `prePull` window this test wants is 5 s and may already be gone when the app
        // finishes launching; the fallback is the next stoppage, which is a goal away. Every
        // other budget here is sized to a launch or a possession and would expire first, naming
        // the timeout rather than the control.
        match.wait("a stoppage", timeout: MatchDriver.pointCycle, until: { !$0.isLive })
        // Nothing has been refused yet, so anything below is this tap's.
        XCTAssertEqual(match.probe().refused, 0)

        guard let said = match.tapForRefusal(match.pitchPoint(0.5, 0.45)) else {
            return XCTFail(
                "a tap before the pull said nothing at all — probe: \(match.probe().raw)")
        }
        XCTAssertTrue(
            said.contains("NOT IN PLAY"),
            "the refusal should say the point has not started, said: \(said)")
        XCTAssertTrue(
            said.contains("WAIT FOR THE PULL"),
            "the refusal should say what to do about it, said: \(said)")

        // And the probe agrees with the screen, which is what makes the reason assertable by
        // name in the tests below rather than by matching on words.
        let after = match.probe()
        XCTAssertGreaterThan(after.refused, 0, "the refusal should be counted")
        XCTAssertEqual(after.refusal, "notLive", "probe: \(after.raw)")
    }

    /// **Tap the sky → OFF THE PITCH.**
    ///
    /// The one refusal this view owns rather than the engine: `MatchScene.groundPoint` returns
    /// nil for a ray that never descends, which is a real thing a finger does because the pitch
    /// does not fill the frame. Provable for the same reason as the pull tap — the geometry does
    /// not depend on the state of the match — and it is the case that used to be least
    /// distinguishable from a broken control, since a tap on the sky is exactly what a player
    /// does when they mean "deep".
    ///
    /// **The point is measured, not guessed, and it is in the corner for a reason.** Photographed
    /// on an iPhone 17 Pro in landscape, y = 0.05 of the pitch is above the horizon and y = 0.17
    /// is already grass — so the sky is a strip about 50 pt tall, and the scoreboard (pinned 12 pt
    /// down, ~40 pt tall, full width bar the 16 pt margins) covers most of it and is the one piece
    /// of HUD that takes touches. The far left of that strip is outside the scoreboard's margin,
    /// which makes it the one piece of sky a finger can actually reach.
    ///
    /// **It waits for our own offence, because the sky only means "off the pitch" there.** The
    /// defensive half of the tap ignores where the finger landed on purpose — where to go is the
    /// disc's business — so a tap on the sky while they have it is a legitimate commitment and
    /// not a refusal. `cut.ok` is the state that guarantees `MatchView.tap` routes to the half
    /// that reads the location.
    func testATapOnTheSkyIsRefusedWithTheGrassAsTheFix() {
        let match = MatchDriver()
        match.waitToAct("our own offence", until: { $0.canCut })

        guard let said = match.tapForRefusal(match.pitchPoint(0.012, 0.05)) else {
            return XCTFail("a tap above the horizon said nothing — probe: \(match.probe().raw)")
        }
        XCTAssertTrue(
            said.contains("OFF THE PITCH") && said.contains("TAP THE GRASS"),
            "the refusal should send the player back to the grass, said: \(said)")
        XCTAssertEqual(match.probe().refusal, "offPitch", "probe: \(match.probe().raw)")
    }

    // **There is deliberately no test for the cooldown refusal, and the reason is worth
    // keeping.** `TOO SOON` is the refusal a player provokes most deliberately — tap again
    // because the first tap did not obviously work — and `Engine.calledCutInterval` is 1.1 s,
    // which is not long enough to drive from a UI test. Two taps have to straddle it with no
    // probe read in between (one read costs up to 0.9 s of the window), and an
    // `XCUICoordinate.tap()` is not a bounded-duration operation: measured on a loaded machine
    // the second tap of a back-to-back pair landed *after* the cooldown had expired and was
    // refused for a different reason entirely (`nobodyThere`, probe confirmed). A test that
    // asserts which of two refusals happened, on a machine that decides how far apart the taps
    // are, is a coin flip wearing a green tick — see the friction log on per-seed bands for what
    // this project already pays for tests like that.
    //
    // What covers it instead: the reason is on the probe as `refuse`/`tally` in every run, and
    // `testTheOffensiveTapUsuallyMeansSomething` asserts that whatever refusals a run of real
    // taps produced, the screen said so.

    /// **Tap the grass on offence, as many times as the match allows → most of them are
    /// orders, and the ones that are not say why.**
    ///
    /// This is the measurement the change was made against, and it is taken with a finger
    /// because the number it is compared to was. The reporter's figure was "about one tap in
    /// three finds somebody on minis"; the probe's tap ledger reproduces that and the improved
    /// rate from the same taps:
    ///
    ///   - `taps` — every tap the offence took;
    ///   - `refused` — every one that produced nothing;
    ///   - `wide` — every accepted call that only landed because `MatchView.callCut` widened an
    ///     empty 35° cone to the half of the pitch the finger pointed at.
    ///
    /// So `(taps - refused - wide) / taps` is what the cone alone accepts — the *before* — and
    /// `(taps - refused) / taps` is what a player now gets. Both are printed, because a
    /// measurement nobody reads is a measurement nobody has.
    ///
    /// **The assertion is deliberately loose and the print is the point.** The rate depends on
    /// where two team-mates happen to be standing, which is a simulation whose seed this test
    /// does not pin; asserting a tight number would make an unrelated AI change fail here (see
    /// the friction log on per-seed bands). What is asserted is the property the fix claims:
    /// the great majority of taps on the grass mean something, and every tap that does not is
    /// visible — checked by reading the plate on the first refusal of the run.
    func testTheOffensiveTapUsuallyMeansSomething() {
        let match = MatchDriver()
        match.waitToAct("a cut to be legal", until: { $0.canCut })

        // **A grid over the whole pitch rather than the spaces a thrower attacks**, because the
        // subject is a tap that names nobody and a sample that only points upfield hides it.
        // Measured on an iPhone 17 Pro, both sets of taps in the same build:
        //
        //   - ten upfield attacking spaces: the 35° cone alone accepted 27/37 = 73%;
        //   - this twenty-point grid:       the 35° cone alone accepted 15/33 = 45%.
        //
        // The widened tap accepted 97% and 94% of the same taps. So how bad the cone looks
        // depends entirely on how much of the pitch the sample covers, which is the argument for
        // the grid: a player pointing at the near sideline is making a real tap.
        //
        // Fractions of the pitch, so this measures the same grass in a release build as in a
        // debug one.
        let targets = [
            (0.08, 0.26), (0.30, 0.26), (0.52, 0.26), (0.74, 0.26), (0.92, 0.26),
            (0.08, 0.44), (0.30, 0.44), (0.52, 0.44), (0.74, 0.44), (0.92, 0.44),
            (0.08, 0.62), (0.30, 0.62), (0.52, 0.62), (0.74, 0.62), (0.92, 0.62),
            (0.08, 0.78), (0.30, 0.78), (0.52, 0.78), (0.74, 0.78), (0.92, 0.78),
        ]
        // **Stopped by a tap count, capped by wall time — and it used to be the other way
        // round.** A flat 150 s budget meant this test always cost 150 s: it kept tapping long
        // after the rate had stopped moving, and on CI run 31384063453 it passed in 164 s, which
        // was most of that job. What the measurement needs is a sample, so the loop asks for one
        // — a dozen taps, which at the 1.1 s `calledCutInterval` plus a possession to make them
        // in is most of a minute — and `MatchDriver.samplingCap` is the cap on that, not the
        // plan. The assertion floor below is unchanged at eight.
        let wanted = 12
        let deadline = Date().addingTimeInterval(MatchDriver.samplingCap)
        var attempt = 0
        var refusalsSeen = 0
        var platesSeen = 0
        while Date() < deadline, attempt < wanted {
            // One read, used both as the legality check and as the before-tap ledger. It used
            // to be two back-to-back reads of the same state, and an accessibility read is the
            // most expensive thing a touch test does — three per tap is most of what this loop
            // spends its budget on.
            //
            // **Waited for rather than spun on.** `guard before.canCut else { continue }` re-read
            // the probe as fast as the accessibility layer would answer, for as long as the cut
            // was illegal — which is most of the time, since a call needs our own offence plus
            // 1.1 s of `calledCutInterval`. That is the unpaced read this very comment calls the
            // most expensive thing here. `poll` is the same loop with the 40 ms the rest of the
            // suite uses.
            //
            // **`continue` and not `break`, which is a mistake this loop has already made once.**
            // Nil here means one possession did not arrive inside `possession`, not that the
            // sampling is over — the cut this test measures needs *our* offence, so a lapse
            // longer than 12 s is an ordinary turnover and the next possession is the point of
            // having a 60 s cap at all. Breaking on it ended run 31395668095 with 5 taps against
            // a floor of 8, which reads as the tap control being broken and was the sampler
            // giving up. The outer `while` owns when to stop; this only owns pacing.
            guard let before = match.poll(for: MatchDriver.possession, until: { $0.canCut })
            else { continue }
            let t = targets[attempt % targets.count]
            attempt += 1
            match.pitchPoint(t.0, t.1).tap()
            let after = match.probe()
            // **Every refusal of the run is looked for on screen and only the whole run is
            // asserted.** One `exists` read can lose the race with a 1.8 s plate, so a per-tap
            // assertion would be a flake; a run in which taps were refused and the screen never
            // once said so is the failure worth having.
            if after.refused > before.refused {
                refusalsSeen += 1
                if match.element("hud.refused").exists { platesSeen += 1 }
            }
        }

        // **The ledger reads 11 for 12 attempts, and that is expected rather than a shortfall.**
        // Measured on CI at both ×1 and ×2 — so it is not the sampling cap, which doubled
        // between those runs. The twelfth tap is made; it is simply not yet visible in this
        // probe read, which happens immediately after it. The floor of 8 is what makes that
        // harmless, and it is why the floor is not 12.
        let ledger = match.probe()
        XCTAssertGreaterThanOrEqual(
            ledger.taps, 8,
            "not enough taps to measure a rate — probe: \(ledger.raw)")

        let accepted = ledger.taps - ledger.refused
        let coneOnly = accepted - ledger.widened
        let now = Double(accepted) / Double(ledger.taps)
        let cone = Double(coneOnly) / Double(ledger.taps)
        print(
            """
            TAP HIT RATE over \(ledger.taps) real taps on the grass:
              35° cone alone : \(coneOnly)/\(ledger.taps) = \(pct(cone))
              widened tap    : \(accepted)/\(ledger.taps) = \(pct(now))
              refused        : \(ledger.refused) — \(ledger.refusalTally)
            """)

        // **0.6, well under the 0.72–0.94 measured, and the looseness is deliberate.** The rate
        // depends on where two team-mates happen to be standing over the two minutes this test
        // gets, and a band tight against a measurement is a band an unrelated AI change breaks —
        // see the friction log on per-seed bands, twice. What is defended is the property: a tap
        // on the grass is normally an order and not nothing, which is the opposite of the 33% the
        // cone alone scored on the same taps.
        XCTAssertGreaterThan(
            now, 0.6,
            "a tap on the grass during our own possession should be an order — "
                + "\(ledger.refused) of \(ledger.taps) were refused, last \(ledger.refusal)")
        XCTAssertGreaterThanOrEqual(
            now, cone, "the widening cannot make the tap worse")
        if refusalsSeen > 0 {
            XCTAssertGreaterThan(
                platesSeen, 0,
                "\(refusalsSeen) taps were refused and the screen never said so — which is the "
                    + "exact bug this suite exists for. Probe: \(ledger.raw)")
        }
    }

    /// **The rectangle the game is played on is the rectangle these tests tap.**
    ///
    /// Measured on an iPhone 17 Pro in landscape, in an 874 × 402 window:
    ///
    ///   - **debug:  pitch 750 × 338 at (62, 0)** — `UltimateApp.showsInstruments` wraps the match
    ///     in a `TabView` and its bar takes 64 pt off the bottom;
    ///   - **release: pitch 750 × 382 at (62, 0)** — no tab bar, so the bottom inset is 20 pt of
    ///     home indicator and the game is 44 pt taller.
    ///
    /// Neither is the window: both lose 62 pt on each side to the notch and the display cutout.
    /// So a tap expressed as a fraction of the *window* is a different piece of grass in the
    /// configuration that ships than in the one the tests run in — which is exactly the trap this
    /// test keeps shut. Every tap in this suite goes through `MatchDriver.pitchPoint`, a fraction
    /// of the rectangle the probe reports, and this asserts which rectangle a run actually got.
    ///
    /// Run it both ways — `xcodebuild test` and `xcodebuild test -configuration Release` — which
    /// CI now does. "Which rectangle did the game get" is the first question about a touch test
    /// that passes in one configuration and not the other.
    func testThePitchIsTheRectangleTheTapsAssume() {
        let match = MatchDriver()
        guard let pitch = match.pitchRect else {
            return XCTFail("the probe never reported a pitch rect — probe: \(match.probe().raw)")
        }
        let window = match.app.frame
        let bottom = window.maxY - pitch.maxY
        // **Named with the device that produced it, which is the whole of issue #13.**
        //
        // Two rectangles were known and measured by hand on an iPhone 17 Pro (above). CI then
        // reported a third — `rect=62,0,750,349` — and there was no way to tell what it came
        // from, because the runner picks whatever iPhone its Xcode happens to ship (see the
        // `Pick a simulator` step) and this line named only the numbers. A rectangle nobody can
        // attribute is a rectangle nobody can decide is correct.
        //
        // The simulator sets these three in every process it hosts, so no UIKit import and no
        // guessing. Empty on a physical device, which is honest rather than wrong.
        let env = ProcessInfo.processInfo.environment
        let device = env["SIMULATOR_DEVICE_NAME"] ?? "unknown device"
        let model = env["SIMULATOR_MODEL_IDENTIFIER"] ?? "?"
        let runtime = env["SIMULATOR_RUNTIME_VERSION"] ?? "?"
        print(
            "PLAYABLE RECT: on \(device) (\(model), iOS \(runtime)) — "
                + "pitch \(pitch) of window \(window) — "
                + "insets l\(pitch.minX - window.minX) t\(pitch.minY - window.minY) "
                + "r\(window.maxX - pitch.maxX) b\(bottom)")

        XCTAssertTrue(
            window.contains(pitch), "the pitch cannot be outside the window it is drawn in")
        // Side insets are the device's, not the layout's, so they are the same in both
        // configurations and symmetric. If they ever stop being, `pitchPoint` is mapping x wrong.
        XCTAssertEqual(
            pitch.minX - window.minX, window.maxX - pitch.maxX, accuracy: 1,
            "the pitch should be centred between the display cutouts")
        // Big enough to still be a game either way: a pitch squeezed to a fraction of the screen
        // would make every tap fraction in this suite meaningless.
        XCTAssertGreaterThan(pitch.width, window.width * 0.7)
        XCTAssertGreaterThan(pitch.height, window.height * 0.7)

        // The bottom is the one edge the configuration decides, and it is the whole difference
        // between the layout the tests exercise and the layout that ships.
        #if DEBUG
            XCTAssertGreaterThan(
                bottom, 40,
                "a debug build has the instruments tab bar under the pitch — if this fails, "
                    + "`showsInstruments` has changed and the touch tests are exercising the "
                    + "shipped layout by accident")
        #else
            XCTAssertLessThan(
                bottom, 40,
                "a release build is the match and nothing else, so the only thing under the pitch "
                    + "is the home indicator — pitch \(pitch), window \(window)")
        #endif
    }

    private func pct(_ x: Double) -> String { String(format: "%.0f%%", x * 100) }
}
