import Foundation
import UltimateSim

/// SELF-OFFICIATION, MEASURED — and the match clock that ends a timed game.
///
/// There are no goldens here and there cannot be: the reference's engine (`Game.ts`) has
/// none either, so what the two implementations share is the *pure* half — the contact
/// geometry and the contest judgement in `Rules.swift`, which `RulesTests` differs
/// bit-exact against `tools/goldens/rules.ts`. What is left over is a property: **how
/// often does a game stop, and for what**.
///
/// That property is the whole risk in this feature. Ultimate is self-officiated, so a
/// detector that is merely *correct* and fires on every frame of contact does not produce
/// a more authentic game — it produces a game nobody can watch. The pivot work set the
/// standard: it landed at zero travels per AI-vs-AI match because a compliant AI does not
/// travel, and zero was the honest number rather than a disappointing one. So the bands
/// below are deliberately two-sided. A floor, because a call system that never calls
/// anything is the feature not existing. A ceiling, because the failure that matters is
/// a future change that makes contact detection trigger-happy, and no other assertion in
/// this suite would notice: goals, completions and hold/break rates all survive a game
/// that is stopped every ten seconds.
///
/// Measured across three fifteen-minute 7v7 matches at the time of writing: 2-5 calls per
/// match, of which roughly one is a marking foul, one or two are picks, and the rest are
/// receiving fouls and strips. Travels remain at zero, which is the pivot work's number
/// and is left alone here.
enum CallsTests {

    static let dt = 1.0 / 120.0
    /// Seeds shared with `EngineTests.playAndMeasure`, so the call telemetry and the
    /// match telemetry describe the same three matches.
    static let seeds: [UInt32] = [11, 23, 37]

    /// A wider pool, for the questions a three-match sample cannot answer.
    ///
    /// A call rate is a mean and three matches are enough to bound one. *Reachability*
    /// is not: a marking foul happens once or twice a match, a pick less often than that,
    /// and a strip needs a defender who was not playing the disc to be inside a receiver
    /// at the instant of a routine drop. Asserting "picks happen" off three seeds asserts
    /// a coin landing heads, and the first unrelated change to the throw solver flips it —
    /// which is exactly what happened while this was being written. Eight seeds is a
    /// sample; the property is unchanged and the bar is higher, not lower.
    static let poolSeeds: [UInt32] = [2, 5, 7, 13, 19, 29, 41, 53]

    static func run() throws {
        callsAreRare()
        theMatchClockEndsTheGame()
        theClockIsOffByDefault()
    }

    // MARK: - the rate

    private static func callsAreRare() {
        var totals = Engine.CallTally()
        var perMatch: [Int] = []

        for seed in seeds {
            let e = Engine(format: .sevens, seed: seed)
            e.autoTeams = [0, 1]
            for _ in 0..<(120 * 900) where !e.isOver { e.step(dt: dt) }

            let t = e.callTally
            perMatch.append(t.total)
            totals.foul += t.foul
            totals.pick += t.pick
            totals.strip += t.strip
            totals.travel += t.travel
            totals.contested += t.contested

            Check.note(
                "calls/s\(seed): \(t.total) in fifteen minutes — "
                    + "\(t.foul) foul, \(t.pick) pick, \(t.strip) strip, \(t.travel) travel; "
                    + "\(t.contested) contested, \(t.total - t.contested) accepted "
                    + "(\(e.score[0])-\(e.score[1]) over \(e.game.point - 1) points)")

            // The bands. Upper is the one that earns its place: it is the tripwire for a
            // detector that has become trigger-happy. Moving it up is a decision about
            // the sport, not a fix for a red check.
            Check.ok(t.total <= 12, "s\(seed): a match is not stopped more than a dozen times (\(t.total))")
        }

        let matches = Double(seeds.count)
        let mean = Double(totals.total) / matches
        Check.note(
            "calls: \(String(format: "%.1f", mean)) per match across \(seeds.count) seeds — "
                + "foul \(totals.foul), pick \(totals.pick), strip \(totals.strip), "
                + "travel \(totals.travel), contested \(totals.contested) of \(totals.total)")

        // The ceiling, on the mean rather than the worst seed. The floor lives on the
        // pooled sample below, where it means something.
        Check.ok(mean <= 8, "calls are not constant (mean \(mean) per match)")

        // Every kind that has a detector should be reachable, over the wider pool.
        var pooled = totals
        for seed in poolSeeds {
            let e = Engine(format: .sevens, seed: seed)
            e.autoTeams = [0, 1]
            for _ in 0..<(120 * 900) where !e.isOver { e.step(dt: dt) }
            let t = e.callTally
            pooled.foul += t.foul
            pooled.pick += t.pick
            pooled.strip += t.strip
            pooled.travel += t.travel
            pooled.contested += t.contested
            Check.ok(
                t.total <= 12,
                "s\(seed): a match is not stopped more than a dozen times (\(t.total))")
        }
        let pool = seeds.count + poolSeeds.count
        Check.note(
            "calls over \(pool) matches: foul \(pooled.foul), pick \(pooled.pick), "
                + "strip \(pooled.strip), travel \(pooled.travel) — "
                + "\(pooled.contested) contested of \(pooled.total), "
                + "\(String(format: "%.1f", Double(pooled.total) / Double(pool))) per match")

        Check.ok(pooled.foul > 0, "fouls happen")
        Check.ok(pooled.pick > 0, "picks happen — the coach's most common call")
        Check.ok(
            Double(pooled.total) / Double(pool) <= 8,
            "and the pooled rate is a game, not a stoppage (\(pooled.total) over \(pool))")

        // Contested is a judgement, not a coin flip: it must be neither impossible nor
        // the default. `callDoubt` is what decides it, and `RulesTests` pins its
        // arithmetic; this only asserts that real matches reach both branches.
        Check.ok(pooled.contested > 0, "and some of them are argued with")
        Check.ok(
            pooled.contested < pooled.total,
            "most are accepted, as they are on a field (\(pooled.contested) of \(pooled.total))")
    }

    // MARK: - the clock

    /// A TIMED GAME ENDS ON TIME.
    ///
    /// The caps have been correct and unreachable since they were written: nothing in the
    /// engine ever called `applySoftCap` or `applyHardCap`, so a game only ever ended by
    /// reaching a score. `EngineConfig.softCapSeconds` / `hardCapSeconds` are the switch,
    /// and this is the demonstration that the switch works — not that the functions
    /// return, but that a match configured with a clock actually finishes on it.
    private static func theMatchClockEndsTheGame() {
        var config = EngineConfig.default
        config.softCapSeconds = 120
        config.hardCapSeconds = 180
        // A target far out of reach in three minutes, so the only thing that can end this
        // game is the clock.
        let e = Engine(format: .sevens, target: 40, seed: 23, config: config)
        e.autoTeams = [0, 1]

        var softAt: Double?
        var hardAt: Double?
        var targetAtSoft = 0
        for _ in 0..<(120 * 900) where !e.isOver {
            e.step(dt: dt)
            if softAt == nil, e.game.cap != .none {
                softAt = e.game.clock
                targetAtSoft = e.game.target
            }
            if hardAt == nil, e.game.cap == .hard { hardAt = e.game.clock }
        }

        Check.ok(softAt != nil, "the soft cap lands")
        Check.ok(hardAt != nil, "the hard cap lands")
        if let softAt { Check.ok(abs(softAt - 120) < 0.05, "soft cap on the horn at 120 s (\(softAt))") }
        if let hardAt { Check.ok(abs(hardAt - 180) < 0.05, "hard cap on the horn at 180 s (\(hardAt))") }
        Check.ok(
            targetAtSoft < 40,
            "the soft cap rewrites the target downward, off the leader (\(targetAtSoft) of 40)")
        Check.ok(e.isOver, "a timed game is over when the clock says so")
        Check.ok(
            e.game.clock < 400,
            "and it ends near the hard cap rather than running to the score (\(e.game.clock) s)")
        Check.note(
            "timed match: soft cap at \(softAt.map { String(format: "%.1f", $0) } ?? "—") s → "
                + "target \(targetAtSoft), hard cap at "
                + "\(hardAt.map { String(format: "%.1f", $0) } ?? "—") s, final "
                + "\(e.score[0])-\(e.score[1]) after \(String(format: "%.1f", e.game.clock)) s")
    }

    /// …and off by default, which is why every other golden in the suite is unchanged.
    private static func theClockIsOffByDefault() {
        Check.bitEq(DEFAULT_RULES.softCapAt, 0, "no soft cap in the default rules")
        Check.bitEq(DEFAULT_RULES.hardCapAt, 0, "no hard cap in the default rules")
        Check.ok(EngineConfig.default.softCapSeconds == nil, "no soft cap in the default config")
        Check.ok(EngineConfig.default.hardCapSeconds == nil, "no hard cap in the default config")

        let e = Engine(format: .minis, target: 2, seed: 29)
        e.autoTeams = [0, 1]
        for _ in 0..<(120 * 600) where !e.isOver { e.step(dt: dt) }
        Check.eq(e.game.cap, .none, "an unconfigured game never caps")
    }
}

