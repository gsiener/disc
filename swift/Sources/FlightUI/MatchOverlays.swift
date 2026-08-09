import Foundation
import SwiftUI
import UltimateSim

/// The HUD pieces that only exist because something just happened: the turnover
/// callout and the full-time result card. `MatchView` owns the match and the clock;
/// this file owns noticing and announcing.

// MARK: - turnover watching

/// A turnover callout, ready to draw: what to shout and whether it was good news.
struct TurnoverFlash: Equatable {
    let text: String
    /// True when the human's team (team 0) gained possession from it.
    let good: Bool
    /// Seconds of display remaining. Counted down by the frame loop, so the flash
    /// survives exactly as long on a 120 Hz display as on a 60 Hz one.
    var timeLeft: Double
}

/// Notices turnovers by diffing the machine's box score between ticks.
///
/// The engine already distinguishes every turnover kind — `GameState` emits a
/// `.turnover(reason:...)` event for each — but the emitter is handed to the engine's
/// private stat sink at construction, before any view exists to listen, and nothing
/// re-exposes the event or a `lastTurnover`. That is the engine-side gap. The public
/// stat surface is enough to reconstruct the kind, though, because each turnover path
/// increments a distinct, disjoint set of counters:
///
///   - `drops`        → a drop (pull drops included; they read the same on screen)
///   - `stallOuts`    → stalled out
///   - gainer `blocks`→ a block or an interception — told apart by what the machine
///                      did next: an interception keeps play live in the defender's
///                      hands (`livePossession`), a block leaves the disc dead
///   - `MatchStats.outOfBounds` (the engine's own event tally) → thrown or caught out
///   - otherwise      → a plain grounded throwaway
///
/// Called once per simulation tick, right after `step`, so at most one turnover can
/// land between snapshots. Nothing here writes to the engine; it only reads.
struct TurnoverWatch {
    private struct Counts: Equatable {
        var committed: [Int]
        var drops: [Int]
        var stallOuts: [Int]
        var blocks: [Int]
        var outOfBounds: Int
    }

    private var last: Counts?

    /// Diff the box score against the previous tick's. Returns a flash to show when a
    /// turnover happened in this tick, and re-baselines either way.
    mutating func check(_ match: Engine) -> TurnoverFlash? {
        let now = Self.read(match)
        defer { last = now }
        guard let prev = last, now != prev else { return nil }

        for team in 0...1 where now.committed[team] > prev.committed[team] {
            let gainer = 1 - team
            let text: String
            if now.drops[team] > prev.drops[team] {
                text = "DROPPED!"
            } else if now.stallOuts[team] > prev.stallOuts[team] {
                text = "STALLED OUT"
            } else if now.blocks[gainer] > prev.blocks[gainer] {
                // A catch block puts the disc straight into the defender's hands and
                // play stays live; a knock-down leaves it dead on the ground. (An
                // interception carried out of bounds is dead too and reads as a
                // block — the stat surface cannot split that hair, and it is a D
                // either way.)
                text = match.game.phase == .livePossession ? "INTERCEPTED!" : "BLOCKED!"
            } else if now.outOfBounds > prev.outOfBounds {
                text = "OUT OF BOUNDS"
            } else {
                text = "THROWN AWAY"
            }
            return TurnoverFlash(text: text, good: gainer == 0, timeLeft: 1.5)
        }
        return nil
    }

    private static func read(_ match: Engine) -> Counts {
        let a = match.game.teamStats(0)
        let b = match.game.teamStats(1)
        return Counts(
            committed: [a.turnoversCommitted, b.turnoversCommitted],
            drops: [a.drops, b.drops],
            stallOuts: [a.stallOuts, b.stallOuts],
            blocks: [a.blocks, b.blocks],
            outOfBounds: match.stats.outOfBounds)
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
    let onRematch: () -> Void

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

            Button(action: onRematch) {
                Text("REMATCH")
                    .font(.system(size: 15, design: .monospaced).bold())
                    .padding(.horizontal, 26).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange))
                    .foregroundStyle(.black)
            }
            .buttonStyle(.plain)
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
