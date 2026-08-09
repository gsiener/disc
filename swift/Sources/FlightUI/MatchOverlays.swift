import Foundation
import SwiftUI
import UltimateSim

/// The HUD pieces that only exist because something just happened: the turnover
/// callout and the full-time result card. `MatchView` owns the match and the clock;
/// this file owns noticing and announcing.

// MARK: - turnover watching

/// A turnover callout, ready to draw: what to shout and whether it was good news.
///
/// **Built from the machine's own event, not from its box score.** This used to diff
/// five monotone counters between ticks and reconstruct the kind from which of them
/// moved, because `GameState`'s emitter was handed to the engine's private stat sink at
/// construction and nothing re-exposed it. `Engine.drainEvents()` is that surface now,
/// and the reconstruction is gone — with it goes the one hair the counters could not
/// split (an interception carried out of bounds reads as a block on the stat sheet, and
/// read as one on screen) and the whole class of bug where two things in one tick show
/// as one.
struct TurnoverFlash: Equatable {
    let text: String
    /// True when the human's team (team 0) gained possession from it.
    let good: Bool
    /// Seconds of display remaining. Counted down by the frame loop, so the flash
    /// survives exactly as long on a 120 Hz display as on a 60 Hz one.
    var timeLeft: Double

    static let duration = 1.5

    /// The callout for an event, or nil if it is not one worth shouting about.
    ///
    /// Every branch is on `TurnoverReason`, which is the rules machine's own vocabulary,
    /// so nothing here has to infer what happened — the exhaustive switch also means a
    /// new reason is a compile error rather than a silent "THROWN AWAY".
    static func make(_ event: MatchEvent, humanTeam: TeamId = 0) -> TurnoverFlash? {
        guard case .turnover(let reason, _, let to, _, let grade, _) = event else { return nil }
        let text: String
        switch reason {
        case .drop:
            text = grade == .layout ? "LAID OUT — DROPPED" : "DROPPED!"
        case .throwaway: text = "THROWN AWAY"
        case .outOfBounds: text = "OUT OF BOUNDS"
        case .caughtOutOfBounds: text = "CAUGHT OUT"
        case .block: text = "BLOCKED!"
        case .interception: text = "INTERCEPTED!"
        case .stallOut: text = "STALLED OUT"
        case .pullDrop: text = "PULL DROPPED"
        case .travelViolation: text = "TRAVEL"
        case .doubleTouch: text = "DOUBLE TOUCH"
        }
        return TurnoverFlash(text: text, good: to == humanTeam, timeLeft: duration)
    }
}

// MARK: - full time

/// The result card. Shown over the frozen pitch when the machine reaches `GAME_OVER`,
/// which is the moment the old build turned into an unexplained freeze-frame.
///
/// Everything on it is read straight off `GameState`'s box score — nothing is tallied
/// here — and the one button constructs a whole new match, seed and all, upstream in
/// `MatchView` where the other restart path already lives.
@available(macOS 15.0, iOS 18.0, *)
struct ResultOverlay: View {
    let match: Engine
    /// Play the same fixture again — same length, format and difficulty, new seed.
    let onRematch: () -> Void
    /// Open the pre-game sheet instead. The rematch button is the right default and the
    /// wrong only option: full time is exactly when a player knows that game was too
    /// long, or too easy, and a result card with one button makes them go and find the
    /// settings while the scoreboard is still up.
    let onSetup: () -> Void

    private var won: Bool { match.score[0] > match.score[1] }

    var body: some View {
        VStack(spacing: 14) {
            Text(won ? "YOU WIN" : "THEY TAKE IT")
                .font(.system(size: 30, weight: .heavy, design: .monospaced))
                .foregroundStyle(won ? Color(red: 0.5, green: 1, blue: 0.62) : .orange)

            Text("YOU \(match.score[0]) — \(match.score[1]) THEM")
                .font(.system(size: 18, design: .monospaced).bold())
                .foregroundStyle(.white.opacity(0.85))

            statSheet

            HStack(spacing: 12) {
                Button(action: onSetup) {
                    Text("CHANGE MATCH")
                        .font(.system(size: 12, design: .monospaced).bold())
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: 8)
                                .strokeBorder(.white.opacity(0.18), lineWidth: 1))
                        .foregroundStyle(.white.opacity(0.7))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Button(action: onRematch) {
                    Text("REMATCH")
                        .font(.system(size: 15, design: .monospaced).bold())
                        .padding(.horizontal, 26).padding(.vertical, 10)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange))
                        .foregroundStyle(.black)
                }
                .buttonStyle(.plain)
            }
            .padding(.top, 4)
        }
        .padding(.horizontal, 28).padding(.vertical, 22)
        // The same plate the scoreboard and the goal callout sit on, because the result
        // is HUD, not scenery.
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(.black.opacity(0.72))
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .strokeBorder(.white.opacity(0.10), lineWidth: 1)))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .transition(.opacity)
    }

    /// The human team's box score, small enough to read over a pitch. Team totals on
    /// top, one line per player under them.
    private var statSheet: some View {
        let team = match.game.teamStats(0)
        let players = match.game.allPlayers().filter { $0.team == 0 }
        return VStack(alignment: .leading, spacing: 5) {
            row("completions", "\(team.completions)/\(team.attempts)")
            row("assists", "\(team.assists)")
            row("holds / breaks", "\(team.holds) / \(team.breaks)")
            row("blocks", "\(team.blocks)")

            Divider().overlay(.white.opacity(0.15)).padding(.vertical, 3)

            // Header + a line per player: goals, assists, completions, plus-minus.
            HStack {
                Text("").frame(width: 76, alignment: .leading)
                Text("G").frame(width: 26)
                Text("A").frame(width: 26)
                Text("CMP").frame(width: 50)
                Text("+/-").frame(width: 36)
            }
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(.white.opacity(0.45))
            ForEach(players, id: \.id) { p in
                HStack {
                    Text(p.name).frame(width: 76, alignment: .leading)
                        .foregroundStyle(.white.opacity(0.85))
                    Text("\(p.goals)").frame(width: 26)
                    Text("\(p.assists)").frame(width: 26)
                    Text("\(p.completions)/\(p.attempts)").frame(width: 50)
                    Text(plusMinus(computePlusMinus(p))).frame(width: 36)
                        .foregroundStyle(
                            computePlusMinus(p) >= 0
                                ? Color(red: 0.5, green: 1, blue: 0.62).opacity(0.9)
                                : Color.orange.opacity(0.9))
                }
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.white.opacity(0.7))
            }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.white.opacity(0.5))
            Spacer(minLength: 24)
            Text(value).foregroundStyle(.white.opacity(0.9))
        }
        .font(.system(size: 13, design: .monospaced))
    }

    private func plusMinus(_ v: Int) -> String { v > 0 ? "+\(v)" : "\(v)" }
}
