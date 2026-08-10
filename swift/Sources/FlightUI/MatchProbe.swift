import Foundation
import SwiftUI
import UltimateSim

/// The match, as one line of text a UI test can read.
///
/// **Why this exists.** Every player-facing control in this game — the drag that throws,
/// the hold that grades the release, the tap that sends a cutter, the tap that sends a
/// defender — was verified for years by calling the same function a finger would call, or
/// by pinning a state with a launch argument for a screenshot (`-charge`, `-defend on`,
/// `-cut`). Neither of those is a touch. `XCUITest` is, and it drives real UIKit gestures
/// in-process, so it can finally close that gap — but a test that can only *see* the screen
/// needs something on the screen to read.
///
/// Most of what a test wants to assert is already on screen and is asserted there: the cut
/// plate says `GO DEEP / #7 IS GOING`, the defence plate says `GO GET IT / #9 IS BIDDING`,
/// the aim label says `CANCEL`, the assist read-out says `PERFECT RELEASE`. What the HUD
/// deliberately does *not* say is the two things a test needs in between:
///
///   - **When it is legal to act.** A drag only throws while our man is holding, a cut is
///     only called on our possession and off cooldown, a defensive tap is only taken while
///     they have it. A test that taps blind is a test that flakes, and a test that waits on
///     a *hint* plate is a test that depends on `Prefs.cutUsed` — a preference that
///     survives the install and is therefore false exactly once per simulator.
///   - **The number behind a grade.** `PERFECT RELEASE` proves the HUD said something; it
///     does not prove the hold that produced it. The whole point of the charge test is that
///     the grade must match the hold the app actually measured, and only the app knows that
///     number. Reporting it is what turns "the plate lit up" into "0.842 s of thumb graded
///     `clean`, which is what `ThrowCharge` promises for 0.842 s".
///
/// So: one `Text`, `k=v` pairs, `;`-separated, hung off the bottom of the pitch and
/// readable by identifier. It is **not** part of the game — `MatchView` draws it only when
/// the app was launched with `-probe on`, which nothing but a test passes, and it holds no
/// state of its own. Everything in it is read from the live `Engine` and the live `@State`
/// the finger writes, so a probe that says a throw happened is a probe reading the same
/// recorded input the save file would carry.
///
/// It reads and never writes, and it is `.allowsHitTesting(false)` — a diagnostic that
/// swallowed a throw would be worse than no diagnostic.
@available(macOS 15.0, iOS 18.0, *)
extension MatchView {

    /// The identifier a UI test looks the probe up by.
    public static let probeIdentifier = "match.probe"

    /// The last release the thumb made, as the charge graded it.
    ///
    /// Kept because it is the one fact about a throw that is gone the instant it happens:
    /// `clock.hold` is zeroed by `cancelDrag`, and the assist read-out that shows the grade
    /// is silent on the plateau by design (see `AssistToast.ReleaseLine`) and gone after
    /// 1.2 s either way. A single value, overwritten per throw.
    struct Released: Equatable {
        var type: ThrowType
        /// Seconds the thumb was down, as `FrameClock` measured it.
        var hold: Double
        var grade: ReleaseGrade
    }

    /// The whole readable state, as `k=v;k=v`.
    ///
    /// Terse on purpose — it is parsed, not read aloud — and every field is derived, so
    /// there is no way for it to disagree with the game.
    var probeState: String {
        var f: [String] = []
        func put(_ k: String, _ v: String) { f.append("\(k)=\(v)") }
        func flag(_ k: String, _ v: Bool) { put(k, v ? "1" : "0") }

        // Whose disc, and whether the body the player is driving is the one holding it.
        //
        // `mine` is `humanRelease`'s own precondition — `carrier == controlled` — and
        // deliberately says nothing about possession, because a *pull* is a throw and the
        // human gets to make it: during `prePull` our man is holding while `possession`
        // still reads as the receiving team. A drag test that waited for possession 0 would
        // sleep through the one moment the disc is guaranteed to be in our hand.
        put("poss", "\(match.possession)")
        flag("mine", match.holder != nil && match.holder == match.controlled)
        flag("flight", match.discInFlight)
        flag("cut.ok", match.canCallCut)
        // `humanDefend`'s precondition, minus the "is anybody on their feet" part it can
        // only answer by asking.
        flag("def.ok", match.possession != 0 && (match.holder != nil || match.discInFlight))
        // Whether the body the player is watching is on the floor. It is the reason a tap can
        // be accepted and *still* not put the call plate on screen: `defenceReadout` gives the
        // rectangle to the "DOWN / BACK UP IN x.xs" line first, because by the time a body is
        // down the order is history. A test that only looked for the order would read that as
        // a tap that did nothing.
        put("rec", match.recovery(of: match.controlled).map { String(format: "%.1f", $0) } ?? "-")

        // What the finger has actually got the engine to accept. Counted off the recording
        // — the same list `saveMatch` writes — so a throw here is a throw a replay would
        // reproduce, not a gesture that was merely attempted.
        var thrown = 0, cuts = 0, defends = 0
        for i in inputs {
            switch i.input {
            case .charged, .release, .drag: thrown += 1
            case .callCut: cuts += 1
            case .defend: defends += 1
            }
        }
        put("thrown", "\(thrown)")
        put("cuts", "\(cuts)")
        put("defends", "\(defends)")

        // The charge, which is the one thing on this line the screen never shows.
        if let r = lastRelease {
            put("grade", r.grade.rawValue)
            put("hold", String(format: "%.3f", r.hold))
            put("type", r.type.rawValue)
        } else {
            put("grade", "-")
            put("hold", "-")
            put("type", "-")
        }

        // The gesture under the thumb right now, in the three states the aim overlay draws.
        put("drag", drag == nil ? "none" : (drag!.aborted ? "cancel" : "aim"))
        // And how the last one finished. The abort is a *non-event* — no throw, no plate, no
        // recorded input — so the only way to tell "the cancel worked" from "the gesture
        // never arrived" is to have the gesture say which one it was.
        put("dragend", lastDragEnd)

        // The two order plates, as the words they are printing.
        put("cut", cutCall.map { "\($0.title)|\($0.detail)" } ?? "-")
        put("def", defenceCall.map { "\($0.title)|\($0.detail)" } ?? "-")

        put("score", "\(match.score[0])-\(match.score[1])")
        flag("over", match.isOver)
        flag("paused", paused)
        flag("sheet", showSetup)
        flag("coach", showCoach)
        return f.joined(separator: ";")
    }

    /// The probe on screen. Small, dim, bottom-left, and out of the way of every plate the
    /// HUD pins to the bottom centre.
    ///
    /// Deliberately visible rather than hidden. A zero-opacity or zero-sized element is the
    /// kind of thing SwiftUI is entitled to drop out of the accessibility tree, and a probe
    /// that vanishes is a test suite that fails for the one reason that is not a bug. Being
    /// legible also means a screenshot taken by a failing test carries the state that failed
    /// it.
    @ViewBuilder var probeOverlay: some View {
        if showsProbe {
            Text(probeState)
                .font(.system(size: 7, design: .monospaced))
                .foregroundStyle(.white.opacity(0.55))
                .lineLimit(3)
                .padding(.horizontal, 6)
                .padding(.bottom, 4)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                .allowsHitTesting(false)
                .accessibilityIdentifier(Self.probeIdentifier)
        }
    }
}
