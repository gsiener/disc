import Foundation
import UltimateSim

/// THE ELEVEN MATCHES, PLAYED ONCE.
///
/// `stoppage`, `calls` and `matchdiff` all measure **the same eleven matches** — sevens,
/// the default config, `autoTeams = [0, 1]`, fifteen simulated minutes at 1/120 — and
/// before this file existed they each played them again from scratch. Counted:
///
///   - `stoppage` played the pool three times over: eleven matches for the timeout rate,
///     the first five again for the resumed count, and the same five a third time for the
///     thrower's drift — twenty-one match-plays;
///   - `calls` played all eleven (three for the rate, eight more for the pool);
///   - `matchdiff` played all eleven again.
///
/// Forty-three plays of eleven matches. That is 513 of the suite's 640 seconds, and it
/// bought nothing: the three suites do not disagree about what the matches are, they only
/// look at different parts of them. So the match is played once and **every** observation
/// any of them wants is recorded on the way past. Nothing is sampled, nothing is
/// shortened, and no assertion moved — the numbers the suites assert on are the same
/// numbers off the same ticks of the same matches.
///
/// # Why re-observing is free and re-simulating is not
///
/// The engine reads no clock and has no mutable global state, so a match is a pure
/// function of `(format, config, seed, autoTeams, the dt sequence)` — that is the property
/// `Replay.swift` is built on. Two of these suites therefore *were* running byte-identical
/// simulations and throwing one away. The one thing that differs between them is that
/// `matchdiff` drains the event buffer every tick and the other two never do; `Engine`
/// says in as many words that "a caller that never drains changes no outcome — it only
/// loses the events past the buffer's cap", so draining here is a superset of both
/// behaviours rather than a third one.
///
/// # Why the matches are played concurrently
///
/// `Engine.step(dt:)` is not associative in `dt` and the tick order inside a match is
/// load-bearing (see the header of `Replay.swift`) — **none of which is touched here.**
/// Each match keeps its own engine, its own `Rng`, and its own strictly sequential tick
/// loop; what runs in parallel is eleven *separate* matches, which share no state. The sim
/// has no `static var` anywhere in it, and the pitch, the playbook and the RNG are all
/// threaded as values rather than closed over as globals, on purpose.
///
/// `Check` is the one piece of shared mutable state in this target, and it is deliberately
/// **not** touched from a worker: the pool records numbers, the suites assert on them
/// afterwards, serially, in the order they always did. So the assertion sequence, the
/// failure list and the counts are order-independent of how the matches were scheduled.
enum MatchPool {

    static let dt = 1.0 / 120.0

    /// The canonical pool. `stoppage`'s eleven seeds, `calls`' three plus its eight, and
    /// `matchdiff`'s fixture spec are all this list, in this order — the order matters
    /// because `stoppage` and `calls` assert over a prefix of it.
    static let seeds: [UInt32] = [11, 23, 37, 2, 5, 7, 13, 19, 29, 41, 53]

    /// Fifteen simulated minutes, as `120 * 900` whole ticks. `matchdiff`'s fixture states
    /// the same span as `seconds / dt`, which is exactly 108000 in IEEE 754 doubles.
    static let ticks = 120 * 900

    /// Everything the three suites read off one match, gathered in a single pass.
    ///
    /// Recorded for all eleven matches even where only a prefix is asserted on: the cost is
    /// a counter, and a record that exists only for the seeds somebody currently asserts on
    /// is a record the next check has to re-simulate to extend.
    struct Match: Sendable {
        let seed: UInt32

        // MARK: stoppage
        /// `teamStats(t).timeoutsUsed`, per team.
        let timeoutsUsed: [Int]
        /// `pendingStallResume` at each `.timeout` → `.check` transition, in tick order.
        let resumedCounts: [Int]
        /// Ticks spent in `.timeout` with a thrower holding the disc.
        let timeoutFrames: Int
        /// Worst distance from the thrower to his pivot during those ticks.
        let worstThrowerDrift: Double
        /// Worst distance from any of the thrower's team-mates to the pivot, same ticks.
        let worstTeamMateDistance: Double

        // MARK: calls
        let calls: Engine.CallTally
        let score: [Int]
        let point: Int

        // MARK: matchdiff
        /// Turnovers by `reason.rawValue`, counted off the drained event stream.
        let turnovers: [String: Int]
        let attempts: Int
        let completions: Int
        let goals: Int
        let blocks: Int
        let stallOuts: Int
    }

    private nonisolated(unsafe) static var cached: [Match]?

    /// The pool, played on first use and kept. Ordered by `seeds`.
    static var matches: [Match] {
        if let cached { return cached }
        let played = play(seeds)
        cached = played
        return played
    }

    /// Plays the given seeds concurrently and returns their records in the given order.
    static func play(_ seeds: [UInt32]) -> [Match] {
        concurrently(seeds, playOne)
    }

    /// Runs one independent match per seed, in parallel, and returns what each observation
    /// produced **in seed order** regardless of the order they finished in.
    ///
    /// For the loops that are not the canonical pool — a game to a different target, a
    /// pinned-weather day — where there is nothing to share but the matches are still
    /// independent of each other. `body` gets a seed, builds its own engine, and returns a
    /// value; it must not call `Check`, which is shared mutable state, so the caller
    /// asserts on the returned values afterwards.
    static func concurrently<T: Sendable>(
        _ seeds: [UInt32], _ body: @Sendable (UInt32) -> T
    ) -> [T] {
        let list = seeds
        let buffer = UnsafeMutablePointer<T?>.allocate(capacity: list.count)
        buffer.initialize(repeating: nil, count: list.count)
        defer {
            buffer.deinitialize(count: list.count)
            buffer.deallocate()
        }
        DispatchQueue.concurrentPerform(iterations: list.count) { i in
            buffer[i] = body(list[i])
        }
        return (0..<list.count).map { buffer[$0]! }
    }

    /// One match, observed once.
    ///
    /// The body of this function is the union of the three suites' old loops, tick for
    /// tick. Each observation reads engine state after the same `step` it always read it
    /// after; none of them writes to the engine.
    private static func playOne(_ seed: UInt32) -> Match {
        let e = Engine(format: .sevens, seed: seed)
        e.autoTeams = [0, 1]

        var turnovers: [String: Int] = [:]
        var resumed: [Int] = []
        var wasTimeout = false
        var timeoutFrames = 0
        var worstDrift = 0.0
        var worstSpread = 0.0

        for _ in 0..<ticks where !e.isOver {
            e.step(dt: dt)

            for event in e.drainEvents() {
                guard case .turnover(let reason, _, _, _, _, _) = event else { continue }
                turnovers[reason.rawValue, default: 0] += 1
            }

            let inTimeout = e.game.phase == .timeout
            if wasTimeout && !inTimeout && e.game.phase == .check {
                resumed.append(e.game.pendingStallResume)
            }
            wasTimeout = inTimeout

            guard inTimeout, let id = e.game.thrower,
                let thrower = e.players.first(where: { $0.id == id })
            else { continue }
            timeoutFrames += 1
            let pivot = e.game.pivot
            let d = (
                (thrower.pos.x - pivot.x) * (thrower.pos.x - pivot.x)
                    + (thrower.pos.z - pivot.z) * (thrower.pos.z - pivot.z)
            ).squareRoot()
            worstDrift = Swift.max(worstDrift, d)
            for p in e.players where p.team == thrower.team {
                let away = (
                    (p.pos.x - pivot.x) * (p.pos.x - pivot.x)
                        + (p.pos.z - pivot.z) * (p.pos.z - pivot.z)
                ).squareRoot()
                worstSpread = Swift.max(worstSpread, away)
            }
        }

        var attempts = 0
        var completions = 0
        var goals = 0
        var blocks = 0
        var stallOuts = 0
        for team in 0..<2 {
            let ts = e.game.teamStats(team)
            attempts += ts.attempts
            completions += ts.completions
            goals += ts.goals
            blocks += ts.blocks
            stallOuts += ts.stallOuts
        }

        return Match(
            seed: seed,
            timeoutsUsed: (0..<2).map { e.game.teamStats($0).timeoutsUsed },
            resumedCounts: resumed,
            timeoutFrames: timeoutFrames,
            worstThrowerDrift: worstDrift,
            worstTeamMateDistance: worstSpread,
            calls: e.callTally,
            score: e.score,
            point: e.game.point,
            turnovers: turnovers,
            attempts: attempts,
            completions: completions,
            goals: goals,
            blocks: blocks,
            stallOuts: stallOuts
        )
    }
}
