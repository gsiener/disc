import Foundation
import UltimateSim

/// The box score's *stored* numbers, against the functions they are stored copies of.
///
/// `PlayerStats.plusMinus` is maintained by `GameState`, which recomputes it on every
/// event that can move it, and `computePlusMinus(_:)` derives the same quantity from the
/// same six counters. One quantity, two sources — and the result card read the function
/// while the phone's own stat lines read the field, which is a divergence nobody would
/// notice until the two disagreed on somebody's game.
///
/// This suite exists because the renderer stopped calling the function. `ResultOverlay`
/// evaluated `computePlusMinus(p)` twice per row — once for the number and once for the
/// colour — and now reads `p.plusMinus` once. That is only a safe swap while the field is
/// exactly what the function would return, for every player, at every point of a match:
/// so that is what is asserted, rather than assumed.
///
/// Deliberately whole-match rather than unit-shaped. The failure mode is not "the formula
/// is wrong", it is "some path that can move a counter forgot to refresh the field" — a
/// callahan, a stall-out, a block by a player who then throws it away — and only a real
/// game reaches enough of those paths to notice.
enum BoxScoreTests {

    static func run() throws {
        // Three seeds and both formats, played to full time. The counters that feed
        // plus-minus are rare events, so the sample has to be games rather than ticks.
        for (seed, spec) in [(11, FieldSpec.minis), (23, .minis), (37, .full)] {
            var config = EngineConfig.default
            config.pointsToWin = 3
            let engine = Engine(format: spec.gameFormat, seed: UInt32(seed), config: config)

            var checkedPlayers = 0
            var sampled = 0
            var seenNonZero = false
            var tick = 0
            // Ten minutes at 1/120 is a hard ceiling, not an expectation: a game to 3
            // finishes well inside it and this only stops a broken build hanging.
            while !engine.isOver, tick < 72_000 {
                engine.step(dt: 1.0 / 120.0)
                tick += 1
                // Every half second of play. Sampling rather than every tick keeps the
                // suite's cost in line with what it is buying, and the field is written
                // on the event, so a half second cannot hide one.
                guard tick % 60 == 0 else { continue }
                sampled += 1
                for p in engine.game.allPlayers() {
                    if p.plusMinus != 0 { seenNonZero = true }
                    if p.plusMinus != computePlusMinus(p) {
                        Check.eq(
                            p.plusMinus, computePlusMinus(p),
                            "seed \(seed): \(p.name)'s stored plus-minus at tick \(tick)")
                        return
                    }
                    checkedPlayers += 1
                }
            }

            // One assertion for the sweep rather than one per player per sample: a match
            // is a hundred thousand comparisons and a suite that counts them all reports
            // its own sample size as if it were coverage.
            Check.ok(
                checkedPlayers > 0,
                "seed \(seed): stored plus-minus agrees with computePlusMinus "
                    + "(\(checkedPlayers) player-samples over \(sampled) sample points)")

            // The assertion above is worthless if nothing ever scored, blocked or dropped
            // — every stat would be zero and the two sources would agree vacuously.
            Check.ok(seenNonZero, "seed \(seed): the match moved somebody's plus-minus")

            // Full time, where the result card actually reads it.
            Check.ok(engine.isOver, "seed \(seed): the match reached full time")
            for p in engine.game.allPlayers() {
                Check.eq(
                    p.plusMinus, computePlusMinus(p),
                    "seed \(seed): \(p.name)'s plus-minus on the result card")
            }
        }
    }
}
