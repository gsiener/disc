import Foundation
import SwiftUI
import UltimateSim

#if os(iOS)
    import UIKit
#endif

/// What the game says back to your hand, and the one thing it teaches your aim.
///
/// `MatchView` owns the match and the clock; `MatchOverlays` owns noticing turnovers;
/// this file owns the two feedback channels that are neither picture nor physics — the
/// taptic engine, and the assist read-out that is the only place the game admits what
/// it did to your throw.

// MARK: - haptics

/// The taptic vocabulary, chosen against `docs/gameplay-design.md` §5.
///
/// The spec is not "more feedback is better", it is a rhythm with a shape:
///
///   - **Release** is a tick you barely notice — §5 gives it 40 ms at 0.3, because a
///     throw is a heartbeat and a heartbeat you feel every time is a palpitation.
///   - **Completion** is the metronome: 70 ms at 0.5, "hand-slap SFX, nothing else".
///     Every completion feels the same, which is what makes it a beat rather than an
///     event.
///   - **A block is the big moment** — the peak of the sport on defence — and gets the
///     only heavy tap in the game, 120 ms at 0.7.
///   - **A drop gets nothing at all.** §5 is explicit: no slow-mo, no shake, "dead air
///     is the feedback". A drop that buzzed would be a drop the game congratulated you
///     for. So `.drop` exists as a case and deliberately plays silence — it is there so
///     the call site reads as a decision rather than as an omission.
///   - Every other turnover (throwaway, stall-out, out of bounds) gets the error-flavoured
///     rigid tap: sharper than a completion, lighter than a D.
///   - **A goal** is the notification, and the only one: success for ours, warning for
///     theirs. Ultimate has no horn (§5), and neither does this.
///
/// Guarded rather than stubbed at the import: `FlightUI` also builds for macOS through
/// the `FlightScope` executable, where `UIFeedbackGenerator` does not exist and there is
/// no Mac equivalent worth faking. On macOS every call below compiles to nothing.
@MainActor
enum Feel {
    enum Beat: Equatable {
        /// The disc leaves the hand, and how cleanly it was released.
        ///
        /// §5 gives an ordinary throw 40 ms at 0.3 and gives the perfect-window release
        /// its own signature — "meter flashes white, ring pulse, 40 ms rumble at 0.3"
        /// against the overcharged throw's "audible flutter". Until the charge existed
        /// every release was the same tap, because every release was quality 1. Now the
        /// tap is the first place the timing is answered, before the disc has moved far
        /// enough to show you what it cost.
        case release(ReleaseGrade)
        /// A team-mate caught it. The metronome.
        case completion
        /// A contested or laid-out catch. Not the metronome — this is the one the game
        /// slows down for, so it is not allowed to feel like the routine one.
        case bigCatch
        /// A D. The one event allowed the heavy tap.
        case block
        /// A drop. Deliberately silent; see the note above.
        case drop
        /// The player sent a defender at the disc.
        ///
        /// Not in §5, because §5 was written for a game with no defensive input at all.
        /// It is a *soft* tap on purpose and lighter than a release: the tap confirms the
        /// order was heard, and the game must not congratulate an order whose outcome —
        /// a D, or two seconds on the floor — has not happened yet.
        case commit
        /// Any other change of possession.
        case turnover
        /// We scored.
        case goal
        /// They scored.
        case conceded
    }

    static func play(_ beat: Beat) {
        #if os(iOS)
            switch beat {
            case .release(let grade):
                switch grade {
                // Crisper and a touch heavier than the ordinary throw, and the only
                // release that gets the rigid tap — it is meant to be tellable through
                // a thumb without looking at the meter.
                case .perfect: impact(.medium, intensity: 0.5)
                case .clean: impact(.light, intensity: 0.4)
                case .steady: impact(.light, intensity: 0.3)
                // Both mistakes read as *less*, not as more. A punishing buzz for a
                // rushed throw would be the game shouting at a player who already knows.
                case .rushed: impact(.soft, intensity: 0.2)
                case .overcharged: impact(.rigid, intensity: 0.22)
                }
            case .completion:
                impact(.soft, intensity: 0.5)
            case .bigCatch:
                impact(.medium, intensity: 0.65)
            case .block:
                impact(.heavy, intensity: 0.7)
            case .drop:
                break  // dead air, on purpose
            case .commit:
                impact(.soft, intensity: 0.28)
            case .turnover:
                impact(.rigid, intensity: 0.55)
            case .goal:
                notify(.success)
            case .conceded:
                notify(.warning)
            }
        #endif
    }

    #if os(iOS)
        /// Generators are kept rather than made per tap. A freshly constructed generator
        /// has to spin the taptic engine up, which costs tens of milliseconds — long
        /// enough that the tap for a catch would arrive after the catch. `prepare()` on
        /// the way out keeps it warm for the next one.
        private static var impacts: [UIImpactFeedbackGenerator.FeedbackStyle:
            UIImpactFeedbackGenerator] = [:]
        private static let notifications = UINotificationFeedbackGenerator()

        private static func impact(
            _ style: UIImpactFeedbackGenerator.FeedbackStyle, intensity: CGFloat
        ) {
            let generator =
                impacts[style]
                ?? {
                    let g = UIImpactFeedbackGenerator(style: style)
                    impacts[style] = g
                    return g
                }()
            generator.impactOccurred(intensity: intensity)
            generator.prepare()
        }

        private static func notify(_ type: UINotificationFeedbackGenerator.FeedbackType) {
            notifications.notificationOccurred(type)
            notifications.prepare()
        }
    #endif
}

// MARK: - noticing the beats

extension Feel {
    /// What one event should feel like, or nothing when it should not be felt.
    ///
    /// This used to be `BeatWatch`, which diffed the completion counters and the score
    /// between ticks because `GameState`'s emitter was spoken for before any view
    /// existed. `Engine.drainEvents()` ended that, and with the real event the mapping
    /// gets two things the counters could not give it: the catch *grade*, so a laid-out
    /// grab does not feel like a five-metre dish, and the turnover reason, so the drop's
    /// deliberate silence is keyed off the machine saying "drop" rather than off which
    /// of five monotone integers moved.
    ///
    /// Only our beats are felt. The opponent's completions are their rhythm, and buzzing
    /// for them would make a defensive point feel like a good one.
    static func beat(for event: MatchEvent, humanTeam: TeamId = 0) -> Feel.Beat? {
        switch event {
        case .caught(_, let team, let grade, _):
            guard team == humanTeam else { return nil }
            return grade == .routine ? .completion : .bigCatch
        case .pullCaught(_, let team, _):
            return team == humanTeam ? .completion : nil
        case .score(let team, _, _, _):
            return team == humanTeam ? .goal : .conceded
        case .turnover(let reason, _, let to, _, _, _):
            switch reason {
            // Dead air is the feedback. §5 is explicit, and it holds whichever way the
            // disc went — a drop we caused is not a tap we get to enjoy.
            case .drop, .pullDrop: return .drop
            case .block, .interception: return to == humanTeam ? .block : .turnover
            default: return .turnover
            }
        case .pullThrown, .pullLanded, .pullOutOfBounds, .released:
            // The release tap is played by the gesture, which knows the grade; the pull
            // outcomes are the opening of a point rather than events in one.
            return nil
        }
    }
}

// MARK: - the assist read-out

/// A short, honest statement about what the aim assist just did.
///
/// This is the game's only teaching signal for aim. The assist is quality-scaled and
/// capped at five degrees, and — crucially — it **declines entirely** outside a twelve
/// degree window, because past that you are throwing somewhere else on purpose
/// (`HumanTargeting.assistedYaw`). A player who is never told that will read a wide
/// throw as the game ignoring them rather than as the game believing them, and will
/// never learn where the window is. So the toast reports the real numbers: how far off
/// the ideal lead the drag was, and how much of that the game closed.
struct AssistToast: Equatable {
    let title: String
    let detail: String
    let tint: Tint
    /// What the charge meter said about the release, as a line the player can read
    /// after the fact.
    ///
    /// The assist lines answer "did I point at the right place"; this answers "did I let
    /// go at the right moment", and they are different skills that used to be one. The
    /// second was invisible because every human throw was quality 1 — there was nothing
    /// to report.
    let release: ReleaseLine?

    struct ReleaseLine: Equatable {
        let text: String
        let perfect: Bool

        init?(_ grade: ReleaseGrade) {
            switch grade {
            case .perfect: self.init(text: "PERFECT RELEASE", perfect: true)
            case .clean: self.init(text: "CLEAN RELEASE", perfect: false)
            // The plateau is the throw most throws are. Saying so every time would turn
            // the one line that means something into wallpaper.
            case .steady: return nil
            case .rushed: self.init(text: "RUSHED", perfect: false)
            case .overcharged: self.init(text: "OVERCHARGED", perfect: false)
            }
        }

        private init(text: String, perfect: Bool) {
            self.text = text
            self.perfect = perfect
        }
    }
    /// Seconds of display remaining, burned down by the frame loop like the turnover
    /// flash — 1.2 s, which is long enough to read four characters and short enough that
    /// it is gone before the disc lands.
    var timeLeft: Double

    enum Tint: Equatable {
        case good, help, miss, neutral
    }

    static let duration = 1.2

    /// Build the read-out for a release.
    ///
    /// `jersey` is the number of whoever the cone select landed on, or nil when the drag
    /// named nobody — which matters, because an assist with no receiver reports a lead
    /// error of zero, and reporting that as "PERFECT LEAD" would be the one lie this
    /// whole overlay exists to avoid.
    /// `grade` is what the charge meter read at release. It is a second line rather than
    /// a second toast because the two facts are about the same throw and arrive in the
    /// same instant, and two overlapping plates in the middle of the screen is how you
    /// make a player read neither.
    static func make(
        _ assist: HumanTargeting.Assist, jersey: Int?, grade: ReleaseGrade
    ) -> AssistToast {
        let line = ReleaseLine(grade)
        func toast(_ title: String, _ detail: String, _ tint: Tint) -> AssistToast {
            AssistToast(
                title: title, detail: detail, tint: tint, release: line, timeLeft: duration)
        }

        guard let jersey else {
            return toast("NO TARGET", "OPEN THROW", .neutral)
        }
        let errorDeg = abs(assist.leadError) * 180 / .pi
        let appliedDeg = abs(assist.applied) * 180 / .pi
        let window = HumanTargeting.assistWindow * 180 / .pi

        if errorDeg > window {
            // The assist looked and refused. Say so, and say by how much, because that
            // number is the lesson.
            return toast("NO ASSIST", "\(Self.deg(errorDeg)) WIDE", .miss)
        }
        // Under a degree and a half of lead error is inside the disc's own width at
        // catching range. Calling that perfect is not flattery, it is rounding.
        if errorDeg < 1.5 {
            return toast("PERFECT LEAD", "TO #\(jersey)", .good)
        }
        if appliedDeg < 0.25 {
            // Inside the window but the release quality bought nothing — which is now a
            // sentence with teeth, because the assist is scaled by exactly the quality
            // the charge meter just showed. A rushed release is the usual cause, and the
            // release line underneath says so.
            return toast("NO ASSIST", "\(Self.deg(errorDeg)) OFF · #\(jersey)", .miss)
        }
        return toast(
            "ASSIST \(Self.deg(appliedDeg))", "\(Self.deg(errorDeg)) OFF · #\(jersey)", .help)
    }

    private static func deg(_ v: Double) -> String { "\(Int(v.rounded()))°" }

    var color: Color {
        switch tint {
        case .good: Color(red: 0.5, green: 1, blue: 0.62)
        case .help: Color(red: 1, green: 0.78, blue: 0.20)
        case .miss: .orange
        case .neutral: .white.opacity(0.7)
        }
    }
}

// MARK: - control handoff

/// Control just moved to another player, and for the next third of a second the screen
/// says so.
///
/// Control follows the disc — catch it and you are the catcher — which is the right rule
/// and an invisible one: on a completion the chevron and the ring simply appear somewhere
/// else, and if your eye was on the flight you never saw the swap. The pulse is the
/// smallest thing that fixes it: one expanding ring on the new player, gone before the
/// next decision.
struct Handoff: Equatable {
    let to: Int
    var timeLeft: Double

    static let duration = 0.3

    /// 0 at the moment of the swap, 1 when it is over.
    var progress: Double { 1 - Swift.max(0, timeLeft) / Self.duration }
}

// MARK: - the defensive call

/// The defender you just sent, and what you sent them to do.
///
/// **A commitment you cannot see is a button that does nothing.** The engine's answer to
/// a tap is a body forty metres away changing what it is running at, which on a phone
/// screen at this camera distance is a few pixels moving slightly differently — and the
/// cost of being wrong is 2.04 s of that body lying on the grass. So the call is said out
/// loud: who, and what.
///
/// Three things say it together and they say different halves. This plate names the
/// player, because a jersey number is readable when the player is eight pixels tall. The
/// control ring and the chevron move to them, because `Engine.humanDefend` moves
/// `controlled` — which also means the existing handoff pulse fires on the swap for free,
/// and the camera-following-the-disc story is unchanged. And `MatchView.recoveryReadout`
/// counts the layout cost down afterwards, per `docs/gameplay-design.md` §4: "the 2.04 s
/// layout cost must be legible, not mysterious".
struct DefenceCall: Equatable {
    /// The squad number of whoever was sent, when there is one to show.
    let jersey: Int?
    let kind: Engine.DefensiveCommit.Kind
    var timeLeft: Double

    /// Roughly a flight. Long enough to find the player you were given, short enough to
    /// be gone before the disc lands.
    static let duration = 1.1

    /// What the order was, in two words.
    var title: String {
        switch kind {
        case .bid: "GO GET IT"
        case .close: "CLOSE HIM DOWN"
        }
    }

    var detail: String {
        guard let jersey else { return kind == .bid ? "BIDDING" : "CLOSING" }
        return "#\(jersey) \(kind == .bid ? "IS BIDDING" : "IS CLOSING")"
    }
}

/// The cut the player just called, while it is worth saying so.
///
/// The offensive twin of `DefenceCall`, and deliberately the same shape: a title that
/// names the order in two words and a line that names the runner. The reason it is worth
/// saying at all is that the ghost on the grass answers *where* and cannot answer *what* —
/// an under and a break-under differ by which side of the mark they attack, which is a
/// distinction of three metres on the pitch and the whole of the decision.
@available(macOS 15.0, iOS 18.0, *)
struct CutCall: Equatable {
    /// The squad number of whoever was sent, when there is one to show.
    let jersey: Int?
    let kind: Playbook.CutKind
    var timeLeft: Double

    /// Shorter than the ghost it accompanies (1.5 s), because the words are read once and
    /// the line on the grass is what you keep watching.
    static let duration = 1.1

    /// What the order was, in the words a team would actually shout.
    var title: String {
        switch kind {
        case .deep: "GO DEEP"
        case .under: "COME UNDER"
        case .breakUnder: "BREAK SIDE"
        case .strike: "STRIKE"
        case .upLine: "UP THE LINE"
        case .dump: "DUMP"
        case .swing: "SWING IT"
        }
    }

    var detail: String {
        guard let jersey else { return "CUTTING" }
        return "#\(jersey) IS GOING"
    }
}

// MARK: - wind

/// The wind, in the frame the camera is actually looking through.
///
/// The engine draws a wind vector per match and bends every huck with it, and until now
/// it was shown nowhere — which makes a fading huck read as the physics being unfair
/// rather than as a crosswind you should have thrown into. The arrow has to point the
/// way the wind blows *on screen*, so it has to know which way the camera is facing.
///
/// `MatchView`'s camera sits behind the attacking direction and looks along `dir * +z`,
/// with world `+y` up. A camera looking down `-Z_local` therefore has
/// `Z_local = (0, 0, -dir)` and `X_local = Y × Z = (-dir, 0, 0)`: world `+x` is screen
/// *left* when the team attacks toward `+z`. Downfield is up the screen either way,
/// which is the whole point of the camera.
///
/// The returned angle is a compass bearing for SwiftUI's `rotationEffect`, which turns
/// clockwise: zero draws an arrow pointing up the screen, i.e. straight downfield.
enum WindReadout {
    static func speed(_ wind: Vec3d) -> Double { (wind.x * wind.x + wind.z * wind.z).squareRoot() }

    static func bearing(_ wind: Vec3d, attackDir: Double) -> Angle {
        let screenX = -attackDir * wind.x
        let screenUp = attackDir * wind.z
        return .radians(atan2(screenX, screenUp))
    }
}
