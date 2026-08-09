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
    enum Beat {
        /// The disc leaves the hand.
        case release
        /// A team-mate caught it. The metronome.
        case completion
        /// A D. The one event allowed the heavy tap.
        case block
        /// A drop. Deliberately silent; see the note above.
        case drop
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
            case .release:
                impact(.light, intensity: 0.3)
            case .completion:
                impact(.soft, intensity: 0.5)
            case .block:
                impact(.heavy, intensity: 0.7)
            case .drop:
                break  // dead air, on purpose
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

/// Turns the box score into taps, one diff per tick.
///
/// Same shape and same reason as `TurnoverWatch`: `GameState` emits `disc:caught` and
/// `score` events internally, but the emitter is handed to the engine's private stat
/// sink at construction and nothing re-exposes it — that is the engine-side gap. What
/// *is* public is monotone, which is enough: a completion is a completion counter that
/// went up, and a goal is a score that did.
///
/// Turnovers are not counted here. `TurnoverWatch` already classifies them for the
/// callout, and classifying the same event twice from the same counters is how the two
/// copies drift; `MatchView` feeds its flash straight into `Feel.Beat` instead.
struct BeatWatch {
    private var completions: [Int]?
    private var score: [Int]?

    /// Diff against the previous tick. Returns the beats that happened in it, in the
    /// order they should be felt.
    mutating func check(_ match: Engine) -> [Feel.Beat] {
        let nowCompletions = [match.game.teamStats(0).completions, match.game.teamStats(1).completions]
        let nowScore = match.score
        defer {
            completions = nowCompletions
            score = nowScore
        }
        guard let wasCompletions = completions, let wasScore = score else { return [] }

        var beats: [Feel.Beat] = []
        // Only our completions are the metronome. Theirs are the opponent's rhythm and
        // buzzing for them would make a defensive point feel like a good one.
        if nowCompletions[0] > wasCompletions[0] { beats.append(.completion) }
        if nowScore[0] > wasScore[0] { beats.append(.goal) }
        if nowScore[1] > wasScore[1] { beats.append(.conceded) }
        return beats
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
    static func make(_ assist: HumanTargeting.Assist, jersey: Int?) -> AssistToast {
        guard let jersey else {
            return AssistToast(
                title: "NO TARGET", detail: "OPEN THROW", tint: .neutral, timeLeft: duration)
        }
        let errorDeg = abs(assist.leadError) * 180 / .pi
        let appliedDeg = abs(assist.applied) * 180 / .pi
        let window = HumanTargeting.assistWindow * 180 / .pi

        if errorDeg > window {
            // The assist looked and refused. Say so, and say by how much, because that
            // number is the lesson.
            return AssistToast(
                title: "NO ASSIST", detail: "\(Self.deg(errorDeg)) WIDE", tint: .miss,
                timeLeft: duration)
        }
        // Under a degree and a half of lead error is inside the disc's own width at
        // catching range. Calling that perfect is not flattery, it is rounding.
        if errorDeg < 1.5 {
            return AssistToast(
                title: "PERFECT LEAD", detail: "TO #\(jersey)", tint: .good, timeLeft: duration)
        }
        if appliedDeg < 0.25 {
            // Inside the window but the release quality bought nothing. Rare, and worth
            // distinguishing from a refusal — the drag was fine, the timing was not.
            return AssistToast(
                title: "NO ASSIST", detail: "\(Self.deg(errorDeg)) OFF · #\(jersey)",
                tint: .miss, timeLeft: duration)
        }
        return AssistToast(
            title: "ASSIST \(Self.deg(appliedDeg))",
            detail: "\(Self.deg(errorDeg)) OFF · #\(jersey)", tint: .help, timeLeft: duration)
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
