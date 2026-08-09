import Foundation
import UltimateSim

/// The engine's event stream, and the charge that decides how cleanly a human throws.
///
/// Two surfaces, one suite, because they are the two halves of the same change: the
/// renderer could not tell a laid-out catch from a five-metre dish, and the player had no
/// way to throw one badly. Both were app-layer gaps over a simulation that already knew
/// the answer — `GameState` emitted every event and `Engine.humanRelease` already took a
/// quality — so nothing here asserts new physics. It asserts that what is now *exposed*
/// agrees with what the machine already counted.
///
/// The reconciliation checks are the load-bearing ones. An event stream that drifts from
/// the box score is worse than no event stream, because both look authoritative and only
/// one of them is on the scoreboard. So a full match is played, every event is drained
/// per tick exactly as `MatchView` drains it, and the tallies are compared against
/// `GameState.teamStats` — which is the same set of books the result card reads.
enum EventTests {

    static func run() throws {
        charge()
        chargeDifficulty()
        streamReconciles()
        streamIsDeterministic()
        stepShapeDoesNotChangeTheMatch()
    }

    // MARK: - the charge

    /// `ThrowCharge` against the reference's `releaseQuality` shape (`src/input/Throw.ts`).
    private static func charge() {
        let c = ThrowCharge.base

        Check.near(c.quality(hold: 0), c.rushFloor, 1e-12, "quality at zero hold is the rush floor")
        Check.near(c.quality(hold: c.fullTime), 1, 1e-12, "the centre of the window is perfect")
        // The plateau, sampled between the end of the rush and the start of the window's
        // influence. `perfectWindow` is 0.09, so 0.5 s is clear of both.
        Check.near(c.quality(hold: 0.5), c.plateau, 1e-12, "the safe plateau is the plateau")
        Check.ok(
            c.quality(hold: c.maxHold) < c.plateau,
            "holding to the end costs more than the plateau")
        Check.near(c.quality(hold: c.maxHold), c.overFloor, 1e-12, "the overcharge bottoms out")
        // Past `maxHold` the hold is clamped, not extrapolated — a thumb left on the
        // glass must not drive quality negative.
        Check.near(
            c.quality(hold: 30), c.overFloor, 1e-12, "an absurd hold clamps rather than diverging")

        // The window is a spike, not a step: quality falls away from the centre in both
        // directions and is back on the plateau at its edges.
        Check.ok(
            c.quality(hold: c.fullTime - 0.03) > c.quality(hold: c.fullTime - 0.07),
            "quality rises toward the window from below")
        Check.ok(
            c.quality(hold: c.fullTime + 0.03) > c.quality(hold: c.fullTime + 0.07),
            "quality falls away from the window from above")
        Check.near(
            c.quality(hold: c.fullTime - c.perfectWindow), c.plateau, 1e-12,
            "the window's lower edge sits on the plateau")

        // Nothing in the whole curve leaves 0…1, which is the contract `humanRelease`
        // relies on when it turns quality into `spread = (1 - q) * 0.16`.
        var hold = 0.0
        while hold <= 2.5 {
            let q = c.quality(hold: hold)
            Check.ok(q >= 0 && q <= 1, "quality stays in 0…1 at hold \(hold)")
            hold += 0.05
        }

        // The grades the HUD and the taptic engine both switch on.
        Check.eq(c.grade(hold: c.fullTime), .perfect, "dead centre grades perfect")
        Check.eq(c.grade(hold: 0.01), .rushed, "an instant release grades rushed")
        Check.eq(c.grade(hold: 0.5), .steady, "the plateau grades steady")
        Check.eq(
            c.grade(hold: c.fullTime + c.overGrace + 0.2), .overcharged,
            "past the grace grades overcharged")
        Check.ok(
            c.isPerfect(hold: c.fullTime) && c.inWindow(hold: c.fullTime),
            "perfect implies in-window")
        Check.ok(
            !c.isPerfect(hold: c.fullTime + c.perfectWindow * 0.9),
            "the window is wider than the perfect centre")
    }

    /// Harder throws have narrower windows. This is the entire reason the charge is a
    /// skill rather than a rhythm: a hammer must not forgive what a backhand does.
    private static func chargeDifficulty() {
        let backhand = ThrowGesture.charge(for: .backhand)
        let blade = ThrowGesture.charge(for: .blade)
        let hammer = ThrowGesture.charge(for: .hammer)

        Check.near(
            backhand.perfectWindow, ThrowCharge.base.perfectWindow, 1e-12,
            "the backhand is the baseline")
        Check.ok(blade.perfectWindow < hammer.perfectWindow, "a blade is tighter than a hammer")
        Check.ok(
            hammer.perfectWindow < backhand.perfectWindow, "a hammer is tighter than a backhand")
        Check.ok(blade.plateau < backhand.plateau, "the hard throws sit on a lower plateau")
        Check.ok(blade.minTime > backhand.minTime, "the hard throws need a longer wind-up")
        // The window still exists at the hardest setting, or the throw would be
        // unthrowable rather than hard.
        Check.ok(blade.perfectWindow > 0.02, "even the blade's window is hittable")
        // The centre does not move. The player learns one rhythm and the tolerance
        // changes around it, which is a skill; a moving target would be a lottery.
        for type in ThrowType.allCases {
            Check.near(
                ThrowGesture.charge(for: type).fullTime, ThrowCharge.base.fullTime, 1e-12,
                "\(type.rawValue) tops out at the same moment")
            Check.near(
                ThrowGesture.charge(for: type).quality(hold: ThrowCharge.base.fullTime), 1, 1e-12,
                "\(type.rawValue) is perfect at the centre")
        }
    }

    // MARK: - the stream

    /// Everything the stream said, in one bag.
    private struct Tally {
        var released = [0, 0]
        var caught = [0, 0]
        var goals = [0, 0]
        var turnovers = [0, 0]  // indexed by the team that lost it
        var blocks = [0, 0]  // indexed by the team that got it
        var stallOuts = [0, 0]
        var drops = [0, 0]
        var grades: [CatchGrade: Int] = [:]
        var pullsThrown = 0
        var pullOutcomes = 0
        var lastScore: [Int] = [0, 0]
        var all: [MatchEvent] = []
    }

    /// Play a match, draining every tick the way the view does, and tally what came out.
    private static func play(seed: UInt32, ticks: Int) -> (Engine, Tally) {
        let match = Engine(format: .minis, target: 5, seed: seed)
        var t = Tally()
        for _ in 0..<ticks {
            if match.isOver { break }
            match.step(dt: 1.0 / 120)
            for e in match.drainEvents() {
                t.all.append(e)
                switch e {
                case .pullThrown:
                    t.pullsThrown += 1
                case .pullCaught, .pullLanded, .pullOutOfBounds:
                    t.pullOutcomes += 1
                case .released(_, let team, _, _):
                    t.released[team] += 1
                case .caught(_, let team, let grade, _):
                    t.caught[team] += 1
                    t.grades[grade, default: 0] += 1
                case .turnover(let reason, let from, let to, _, _, _):
                    t.turnovers[from] += 1
                    switch reason {
                    case .block, .interception: t.blocks[to] += 1
                    case .stallOut: t.stallOuts[from] += 1
                    case .drop: t.drops[from] += 1
                    default: break
                    }
                case .score(let team, _, _, let score):
                    t.goals[team] += 1
                    t.lastScore = score
                }
            }
        }
        return (match, t)
    }

    /// The stream against the box score. If these two ever disagree, one of them is
    /// lying to the player.
    private static func streamReconciles() {
        // Long enough to reach several points on a minis pitch, which is what puts pulls,
        // drops, blocks and stall-outs all in the same sample.
        let (match, t) = play(seed: 0x0e7e_51a1, ticks: 120 * 600)

        let a = match.game.teamStats(0)
        let b = match.game.teamStats(1)

        Check.ok(t.all.count > 40, "a ten-minute match produces a stream worth checking")
        Check.eq(
            t.released[0] + t.released[1], a.attempts + b.attempts,
            "one release event per throw attempt")
        Check.eq(t.caught[0], a.completions, "our catches reconcile with our completions")
        Check.eq(t.caught[1], b.completions, "their catches reconcile with their completions")
        Check.eq(
            t.turnovers[0] + t.turnovers[1], a.turnoversCommitted + b.turnoversCommitted,
            "one turnover event per turnover")
        Check.eq(t.blocks[0], a.blocks, "our blocks reconcile")
        Check.eq(t.blocks[1], b.blocks, "their blocks reconcile")
        Check.eq(t.stallOuts[0], a.stallOuts, "our stall-outs reconcile")
        Check.eq(t.stallOuts[1], b.stallOuts, "their stall-outs reconcile")
        Check.eq(t.goals[0], match.score[0], "our goals reconcile with the scoreboard")
        Check.eq(t.goals[1], match.score[1], "their goals reconcile with the scoreboard")
        if t.goals[0] + t.goals[1] > 0 {
            Check.eq(t.lastScore, [match.score[0], match.score[1]], "the last score event is final")
        }

        // The throwaway/out-of-bounds split the engine's own summary carries, counted a
        // second way — out of the events rather than out of the sink's counters.
        var grounded = 0
        var out = 0
        for case .turnover(let reason, _, _, _, _, _) in t.all {
            switch reason {
            case .throwaway: grounded += 1
            case .outOfBounds, .caughtOutOfBounds: out += 1
            default: break
            }
        }
        Check.eq(grounded, match.stats.grounded, "throwaways reconcile with MatchStats")
        Check.eq(out, match.stats.outOfBounds, "out-of-bounds reconcile with MatchStats")

        // Every point starts with exactly one pull and ends it exactly one way. The pull
        // that is still in the air when the sample ends is the only permitted difference.
        Check.ok(
            t.pullsThrown - t.pullOutcomes >= 0 && t.pullsThrown - t.pullOutcomes <= 1,
            "every pull thrown gets an outcome, bar one possibly in flight "
                + "(\(t.pullsThrown) thrown, \(t.pullOutcomes) resolved)")

        // The grades. All three must be reachable, or the whole reason for the event
        // stream — telling a contested catch from a routine one — is theoretical.
        //
        // **Reachability is pooled across seeds; only "every catch is graded" is asked of
        // this one match.** A minis game to five is about a dozen catches, and a dozen
        // draws is not a sample: this seed carried exactly one contested catch, so any
        // change anywhere upstream that reshuffled the stream flipped the assertion
        // without saying anything true about grading. (The self-officiated calls did
        // exactly that — one marking foul lands in this match, and a stoppage moves
        // everything after it.) Three seeds and a hundred-odd catches is a sample; the
        // property being asserted is unchanged and the bar is higher, not lower.
        let graded = t.grades.values.reduce(0, +)
        Check.eq(graded, t.caught[0] + t.caught[1], "every catch carries a grade")

        var pooled: [CatchGrade: Int] = t.grades
        for seed in [UInt32(0x51de_1ded), 0x0d1a_1000, 0x0f00_d123] {
            let (_, extra) = play(seed: seed, ticks: 120 * 600)
            for (g, n) in extra.grades { pooled[g, default: 0] += n }
        }
        Check.ok(pooled[.routine, default: 0] > 0, "routine catches happen")
        Check.ok(
            pooled[.contested, default: 0] > 0,
            "contested catches happen — got \(pooled[.contested, default: 0])")
        Check.ok(pooled[.layout, default: 0] > 0, "and so do layouts")
        Check.note(
            "catch grades over four matches: routine \(pooled[.routine, default: 0]), "
                + "contested \(pooled[.contested, default: 0]), "
                + "layout \(pooled[.layout, default: 0])")

        // A grade only ever rides on an event that resolved through a contest. A
        // stall-out has no catch, and must never inherit the previous one.
        for case .turnover(let reason, _, _, _, let grade, _) in t.all {
            switch reason {
            case .drop, .block, .interception, .pullDrop: break
            default:
                Check.ok(grade == nil, "a \(reason.rawValue) carries no catch grade")
            }
        }

        // Draining is destructive, which is the whole contract: the view must not see the
        // same catch twice on the next tick.
        Check.eq(match.drainEvents().count, 0, "a second drain is empty")
    }

    /// The same seed says the same things in the same order.
    private static func streamIsDeterministic() {
        let (_, first) = play(seed: 0x51de_1ded, ticks: 120 * 120)
        let (_, second) = play(seed: 0x51de_1ded, ticks: 120 * 120)
        Check.ok(first.all.count > 10, "the determinism sample has events in it")
        Check.eq(first.all.count, second.all.count, "the same seed emits the same many events")
        Check.ok(first.all == second.all, "the same seed emits the same events in the same order")
    }

    /// **The slow-motion invariant.**
    ///
    /// `MatchView` implements the §5 hitstop as a scale on how much wall time is paid
    /// into its fixed-step accumulator, which changes *how many* whole 1/120 s ticks run
    /// in a rendered frame and never how big one is. That is only safe if the match does
    /// not care how the ticks are grouped — so this asserts exactly that, by playing the
    /// same seed twice: once at a steady tick per iteration, and once in ragged bursts of
    /// one to thirty, which is the whole range the accumulator's 0.25 s clamp allows.
    ///
    /// If this ever fails, slow motion has become a gameplay change and must come out.
    private static func stepShapeDoesNotChangeTheMatch() {
        let seed: UInt32 = 0x5104_3110
        let total = 120 * 300

        let steady = Engine(format: .minis, target: 5, seed: seed)
        var steadyEvents: [MatchEvent] = []
        for _ in 0..<total {
            if steady.isOver { break }
            steady.step(dt: 1.0 / 120)
            steadyEvents.append(contentsOf: steady.drainEvents())
        }

        // A cheap deterministic burst pattern standing in for a frame rate that lurches
        // — which is what a hitstop, a hitch and a 60/120 Hz display all look like from
        // the accumulator's side.
        let ragged = Engine(format: .minis, target: 5, seed: seed)
        var raggedEvents: [MatchEvent] = []
        var done = 0
        var burst = 1
        while done < total {
            if ragged.isOver { break }
            let n = Swift.min(burst, total - done)
            for _ in 0..<n {
                ragged.step(dt: 1.0 / 120)
                raggedEvents.append(contentsOf: ragged.drainEvents())
            }
            done += n
            burst = burst % 30 + 1
        }

        Check.eq(
            steady.score, ragged.score, "regrouping the ticks does not change the score")
        Check.eq(
            steadyEvents.count, raggedEvents.count,
            "regrouping the ticks does not change how much happened")
        Check.ok(
            steadyEvents == raggedEvents,
            "regrouping the ticks does not change what happened — slow motion is render-side")
    }
}
