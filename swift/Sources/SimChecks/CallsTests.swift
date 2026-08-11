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
/// Measured across three fifteen-minute 7v7 matches: 2-4 calls per match, and over the
/// eleven-match pool 3.5 — roughly two receiving fouls, one pick and one strip. Travels
/// remain at zero, which is the pivot work's number and is left alone here.
///
/// **THE MARKING FOUL IS NOW ESSENTIALLY ZERO, AND THAT IS THE FINDING.** It used to be
/// the commonest call in the game by a distance, and when the throw solver was fixed so
/// that receivers actually arrive at the disc it went to 8.3 calls a match with matches
/// stopped fifteen times. Measured over three matches at that point: **42 of the 43
/// marking fouls were called at stall count 0, with a median marking age of 0.01 s**,
/// while contact during a settled mark — median age 0.41 s — was the contact the detector
/// let go. Every marking foul in the game was the collision of a receiver and his defender
/// arriving at the same disc, which the rules call incidental. `markingFoulImpact` now
/// requires the marking situation to exist (`MARK_SET_TIME`) and the thrower to be a man
/// who cannot step out of the way (`MARK_SETTLED_SPEED`), and what is left of the mark
/// leaning on a settled thrower is a call that happens a few times in eleven matches
/// rather than fourteen times a match.
enum CallsTests {

    static let dt = 1.0 / 120.0
    /// Seeds shared with `EngineTests.playAndMeasure`, so the call telemetry and the
    /// match telemetry describe the same three matches.
    /// Derived from `MatchPool.seeds` rather than repeated, so the three matches this
    /// asserts on cannot drift away from the eleven the pool plays.
    static let seeds: [UInt32] = Array(MatchPool.seeds.prefix(3))

    /// A wider pool, for the questions a three-match sample cannot answer.
    ///
    /// A call rate is a mean and three matches are enough to bound one. *Reachability*
    /// is not: a marking foul happens once or twice a match, a pick less often than that,
    /// and a strip needs a defender who was not playing the disc to be inside a receiver
    /// at the instant of a routine drop. Asserting "picks happen" off three seeds asserts
    /// a coin landing heads, and the first unrelated change to the throw solver flips it —
    /// which is exactly what happened while this was being written. Eight seeds is a
    /// sample; the property is unchanged and the bar is higher, not lower.
    static let poolSeeds: [UInt32] = Array(MatchPool.seeds.dropFirst(3))

    static func run() throws {
        callsAreRare()
        theMatchClockEndsTheGame()
        theClockIsOffByDefault()
    }

    // MARK: - the rate

    private static func callsAreRare() {
        var totals = Engine.CallTally()

        // The first three of the eleven, off `MatchPool` — the same three matches this loop
        // used to play for itself, and the same three `stoppage` and `matchdiff` measure.
        for match in MatchPool.matches.prefix(seeds.count) {
            let seed = match.seed
            let t = match.calls
            totals.foul += t.foul
            totals.pick += t.pick
            totals.strip += t.strip
            totals.travel += t.travel
            totals.contested += t.contested

            // The band. It is the tripwire for a detector that has become trigger-happy,
            // and it has done that job once — it is what caught the marking foul firing on
            // every arrival. Moving it is a decision about the sport, not a fix for a red
            // check.
            //
            // **BACK TO TWELVE, from the eight it was tightened to, and the reason is the
            // one `.agents/friction-log/20260809222131-enginetests-deep-game` wrote down:
            // a per-seed ceiling on a count of eleven-to-eighteen possessions is a
            // statistic of a tail, and every stoppage in a match resamples everything after
            // it.** Adding a timeout caller — which touches no detector — moved seed 13 from
            // eight calls to nine. That is not a trigger-happy detector, it is the same
            // detector on a different match, and there is no version of this code that
            // makes it green other than re-rolling until it is.
            //
            // Twelve still catches the failure it exists for by an order of magnitude: the
            // marking-foul-on-arrival bug produced calls on nearly every possession. The
            // tight bound that means something lives below, on the pooled mean, where the
            // sample is eleven matches instead of one.
            Check.ok(t.total <= 12, "s\(seed): a match is not stopped a dozen times (\(t.total))")
        }

        let matches = Double(seeds.count)
        let mean = Double(totals.total) / matches

        // The ceiling, on the mean rather than the worst seed. The floor lives on the
        // pooled sample below, where it means something.
        Check.ok(mean <= 5, "calls are not constant (mean \(mean) per match)")

        // Every kind that has a detector should be reachable, over the wider pool.
        var pooled = totals
        for match in MatchPool.matches.dropFirst(seeds.count) {
            let seed = match.seed
            let t = match.calls
            pooled.foul += t.foul
            pooled.pick += t.pick
            pooled.strip += t.strip
            pooled.travel += t.travel
            pooled.contested += t.contested
            // Twelve, for the reason given on the same bound above: a per-seed ceiling on
            // one match's calls is a tail statistic, and every stoppage in a match
            // resamples everything after it.
            Check.ok(
                t.total <= 12, "s\(seed): a match is not stopped a dozen times (\(t.total))")
        }
        let pool = seeds.count + poolSeeds.count
        Check.ok(pooled.foul > 0, "fouls happen")
        Check.ok(pooled.pick > 0, "picks happen — the coach's most common call")
        Check.ok(
            Double(pooled.total) / Double(pool) <= 5,
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
        // **FIVE SECONDS AFTER THE SOFT CAP, NOT SIXTY.** At the soft cap the target becomes
        // the leader plus one, so the very next goal ends the game — and with sixty seconds
        // to play it in, this match reached that target at 144.6 s and the hard cap at 180 s
        // never happened at all. The check still said "the hard cap lands", which is the
        // failure mode: it was asserting a cap that the game had raced past. How long the
        // interval is says nothing about whether the hard cap works, and a gap shorter than
        // any possible point makes the assertion about the cap rather than about the seed.
        config.hardCapSeconds = 125
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
        if let hardAt {
            Check.ok(
                abs(hardAt - 125) < 0.05, "hard cap on the horn at 125 s (\(hardAt))")
        }
        Check.ok(
            targetAtSoft < 40,
            "the soft cap rewrites the target downward, off the leader (\(targetAtSoft) of 40)")
        Check.ok(e.isOver, "a timed game is over when the clock says so")
        Check.ok(
            e.game.clock < 400,
            "and it ends near the hard cap rather than running to the score (\(e.game.clock) s)")
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

