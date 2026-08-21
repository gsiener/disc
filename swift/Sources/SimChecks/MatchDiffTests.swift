import Foundation
import UltimateSim

/// THE MATCH-LEVEL REGRESSION — the one check in this suite that looks at the
/// *integration* rather than at a component.
///
/// # Why this exists
///
/// Every other suite here pins a number in and a number out for one function. Four
/// separate bugs slipped through every one of those checks in one day, because in every
/// case the components agreed and the assembled engine did not:
///
///   - strips fired 3 times over 11 reference matches and **zero** times over the same
///     11 in the port — `catchContactCall` itself differed bit-exact and green (#55);
///   - the throw solver bombed 42% of short throws in one engine and not the other;
///   - `throwReleaseSpeed` was never ported, and a Swift-only mutation of it survived
///     2.24M green assertions;
///   - the reference ran its deep game on a fallback glide integrator.
///
/// Same signature every time: **a discrete event happening at one rate and not another —
/// usually zero — where every component check stayed green.** No amount of
/// `CoeffsTests`/`ThrowsTests`/`DiscRuntimeTests` rigor catches a wiring bug between the
/// pieces they each individually got right. So this is the one place that plays whole
/// matches and counts what actually happened in them.
///
/// # What changed when the TypeScript reference retired
///
/// This used to compare the port against a second, independent engine — `src/sim/`,
/// walking the same eleven seeds through a structurally different roster deal and a
/// different RNG fork, so only *pooled, tolerance-banded* comparisons meant anything; a
/// per-seed or exact comparison would have been comparing two different games that
/// happened to share a seed number.
///
/// With one engine, that reason is gone. `baseline` below is this engine's own pooled
/// output over the same eleven matches `stoppage`, `calls` and `shape` already play —
/// captured, not invented, by running the pool and recording what came out — and every
/// count is asserted **exactly**, because a deterministic engine replaying a fixed dt
/// sequence on fixed seeds has no honest reason to produce a different number tomorrow
/// than it did today. Issue #59 is what makes that claim safe to make: before it, this
/// same engine produced two different match outcomes in debug and release from the
/// identical seed, which would have made an exact-match baseline worthless — it would
/// have started red on the next `swift build` in the other configuration. `cross-config`
/// CI now asserts debug and release agree at exactly this granularity, which is what an
/// exact baseline here is trusting.
///
/// A failure here is not "the reference disagrees" — it means **this engine's own
/// behaviour changed**, on purpose or not. That is a strictly stronger claim than the
/// differential it replaces, not a weaker one: a rate that drifts by 10% used to have
/// forty percent of headroom to hide in; now it has none.
///
/// # The one honest caveat
///
/// A full match is on the order of 100,000 chaotic integration steps, and this project
/// has already measured what that does across platforms: `coeffs.json` differs in a
/// handful of values by a ULP of V8 arithmetic across machines, and this family's own
/// predecessor moved 35% of its pooled counts the same way — one ULP anywhere in an aero
/// coefficient, amplified over enough ticks, is enough to flip a contested catch. This
/// baseline was captured on the canonical platform (macOS, arm64, the Swift toolchain
/// pinned in this repository) and should be regenerated there, the same discipline
/// `coeffs`/`matchdiff` freshness already used against the reference. A value drifting on
/// a different machine or toolchain is not automatically a bug; a value drifting on the
/// *same* platform between two runs would be, because nothing here should be able to do
/// that — the engine reads no clock, keeps no global mutable state, and is seeded once.
enum MatchDiffTests {

    /// This engine's own pooled output over the eleven canonical seeds, fifteen
    /// simulated minutes each — captured by running `MatchPool` and recording exactly
    /// what it produced, not chosen or estimated. Regenerate by running this suite with
    /// the capture lines this comment used to sit beside (see git history) rather than by
    /// hand-editing a number here: a hand-typed "fix" to a baseline is indistinguishable
    /// from a hand-typed cover-up of a regression.
    enum Baseline {
        static let matches = 11

        static let turnovers: [String: Int] = [
            "block": 36, "caught-out-of-bounds": 0, "double-touch": 0, "drop": 41,
            "interception": 59, "out-of-bounds": 0, "pull-drop": 21, "stall-out": 0,
            "throwaway": 0, "travel-violation": 0,
        ]
        static let calls: [String: Int] = [
            "contested": 11, "foul": 22, "pick": 8, "strip": 7, "travel": 0,
        ]
        static let totals: [String: Int] = [
            "attempts": 1414, "blocks": 95, "completions": 1275, "goals": 170,
            "points": 180, "stallOuts": 0,
        ]
    }

    private static func pct(_ part: Int, _ whole: Int) -> Double {
        whole == 0 ? 0 : 100 * Double(part) / Double(whole)
    }

    static func run() throws {
        var turnovers: [String: Int] = [:]
        for key in Baseline.turnovers.keys { turnovers[key] = 0 }
        var calls = ["foul": 0, "pick": 0, "strip": 0, "travel": 0, "contested": 0]
        var totals = [
            "attempts": 0, "completions": 0, "goals": 0, "blocks": 0, "stallOuts": 0,
            "points": 0,
        ]
        var matches = 0

        for match in MatchPool.matches {
            for (reason, count) in match.turnovers { turnovers[reason, default: 0] += count }
            matches += 1
            totals["points"]! += match.point
            let t = match.calls
            calls["foul"]! += t.foul
            calls["pick"]! += t.pick
            calls["strip"]! += t.strip
            calls["travel"]! += t.travel
            calls["contested"]! += t.contested
            totals["attempts"]! += match.attempts
            totals["completions"]! += match.completions
            totals["goals"]! += match.goals
            totals["blocks"]! += match.blocks
            totals["stallOuts"]! += match.stallOuts
        }

        Check.eq(matches, Baseline.matches, "the pool still plays eleven matches")

        // Every discrete count, exact. This is the whole suite's claim: a deterministic
        // engine on fixed seeds and a fixed dt sequence reproduces its own prior behaviour
        // bit-for-bit, or it has genuinely changed and this must go red.
        for (key, want) in Baseline.turnovers.sorted(by: { $0.key < $1.key }) {
            Check.eq(
                turnovers[key] ?? 0, want,
                "turnover:\(key) over \(Baseline.matches) matches matches the baseline")
        }
        for (key, want) in Baseline.calls.sorted(by: { $0.key < $1.key }) {
            Check.eq(
                calls[key] ?? 0, want,
                "call:\(key) over \(Baseline.matches) matches matches the baseline")
        }
        for (key, want) in Baseline.totals.sorted(by: { $0.key < $1.key }) {
            Check.eq(
                totals[key] ?? 0, want,
                "total:\(key) over \(Baseline.matches) matches matches the baseline")
        }

        // The two ratios, kept as an independent sanity check on the baseline itself —
        // not on the engine. If somebody hand-edits `Baseline` without noticing the new
        // numbers describe a sport that does not make sense, these catch that a
        // component-by-component diff against the old baseline would not: a completion
        // rate outside what any Ultimate offence produces, or a game that changes
        // possession on a wildly different rhythm than a point actually plays at.
        let gotPct = pct(totals["completions"]!, totals["attempts"]!)
        Check.inRange(
            gotPct, 60.0, 95.0,
            "completion rate is a plausible Ultimate offence's, not a broken solver's "
                + "(\(String(format: "%.1f", gotPct))%)")

        let gotTOs = turnovers.values.reduce(0, +)
        let gotPerPoint = Double(gotTOs) / Double(Swift.max(1, totals["points"]!))
        Check.inRange(
            gotPerPoint, 0.1, 3.0,
            "turnovers per point is a plausible game's, not a broken catch contest's "
                + "(\(String(format: "%.2f", gotPerPoint)))")
    }
}
