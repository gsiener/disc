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

    /// The one and only step the simulation is advanced by, taken from the sim rather than
    /// respelled here — ADR-0003 makes `dt` part of the input, so a pool that stepped at its own
    /// private copy of the number would be a pool nobody could compare a fixture against.
    static let dt = FrameClock.tickDt

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
        struct ScoreEvent: Sendable {
            let delta: Int
            let didNotFall: Bool
            let scorerPresent: Bool
            let pointScoredPhase: Bool
            let recordMatchesBoard: Bool
        }

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
        let holds: Int
        let breaks: Int

        // MARK: matchdiff
        /// Turnovers by `reason.rawValue`, counted off the drained event stream.
        let turnovers: [String: Int]
        let attempts: Int
        let completions: Int
        let goals: Int
        let blocks: Int
        let stallOuts: Int

        // MARK: pivot
        let travels: Int
        let pinnedFrames: Int
        let heldFrames: Int
        let worstPivotReach: Double

        // MARK: EngineTests sevens telemetry
        let scoreEvents: [ScoreEvent]
        let meanGain: Double
        let longestCompletion: Double
        let hucksAttempted: Int
        let cadence: Double
        let passPct: Double
        let totalTurnovers: Int
        let finished: Bool
        let deepShots: Int
        let scaledDeepShots: Int
        let aimedThrows: Int
    }

    /// The pool, played on first use and kept. Ordered by `seeds`.
    ///
    /// A plain `static let` rather than a hand-rolled `if let cached` over a
    /// `nonisolated(unsafe) static var`, which is what this was: Swift initialises a static
    /// property lazily and **exactly once** through `swift_once`, so the memoisation is free and
    /// — unlike the hand-rolled version — atomic. The old shape was correct only for as long as
    /// nothing read `matches` from two threads at once, at which point both readers would have
    /// played all eleven matches and raced on the assignment. That is precisely the cost this
    /// file exists to remove.
    static let matches: [Match] = concurrently(seeds, playOne)

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
        var pinnedFrames = 0
        var heldFrames = 0
        var worstPivotReach = 0.0
        var lastScore = e.score
        var scoreEvents: [Match.ScoreEvent] = []
        var heldPos: Vec3d?
        var heldTeam: TeamId?
        var gains: [Double] = []
        var completionsSeen = 0
        var throwsSeen = 0
        var releasePos: Vec3d?
        var flightMax = 0.0
        var liveTicks = 0
        var completedDists: [Double] = []
        var attemptDists: [Double] = []
        var prevPhase = e.game.phase
        var deepShots = 0
        var scaledDeepShots = 0
        var aimedThrows = 0

        for _ in 0..<ticks where !e.isOver {
            e.step(dt: dt)

            if e.game.phase == .livePossession { liveTicks += 1 }
            if e.stats.throwsMade > throwsSeen {
                throwsSeen = e.stats.throwsMade
                if prevPhase == .livePossession, let hand = heldPos, let team = heldTeam,
                    let aimed = e.lastThrowAim
                {
                    aimedThrows += 1
                    let gain = Double(e.dirFor(team)) * (aimed.aim.z - hand.z)
                    let reach = Foundation.hypot(aimed.aim.x - hand.x, aimed.aim.z - hand.z)
                    let scale = e.format.field.goalLine / 32
                    if gain >= 22 && reach >= 25 { deepShots += 1 }
                    if gain >= 22 * scale && reach >= 25 * scale { scaledDeepShots += 1 }
                }
                releasePos = e.disc.state.pos
                flightMax = 0
            }
            if e.game.phase == .discInFlight, let rp = releasePos {
                flightMax = Swift.max(flightMax, distXZ(rp, e.disc.state.pos))
            } else if releasePos != nil, flightMax > 0, e.game.phase != .discInFlight {
                attemptDists.append(flightMax)
                releasePos = nil
                flightMax = 0
            }
            if e.stats.completions > completionsSeen, let from = heldPos, let team = heldTeam,
                let to = e.carrier.flatMap({ id in e.players.first { $0.id == id } })?.pos
            {
                gains.append(Double(e.dirFor(team)) * (to.z - from.z))
                completedDists.append(distXZ(from, to))
            }
            completionsSeen = e.stats.completions
            if let id = e.carrier, let player = e.players.first(where: { $0.id == id }) {
                heldPos = player.pos
                heldTeam = player.team
            }
            if e.score != lastScore {
                let delta = (e.score[0] - lastScore[0]) + (e.score[1] - lastScore[1])
                scoreEvents.append(.init(
                    delta: delta,
                    didNotFall: e.score[0] >= lastScore[0] && e.score[1] >= lastScore[1],
                    scorerPresent: e.justScored != nil,
                    pointScoredPhase: e.game.phase == .pointScored,
                    recordMatchesBoard: e.game.lastScore?.score == e.score))
                lastScore = e.score
            }
            prevPhase = e.game.phase

            for event in e.drainEvents() {
                guard case .turnover(let reason, _, _, _, _, _) = event else { continue }
                turnovers[reason.rawValue, default: 0] += 1
            }

            let inTimeout = e.game.phase == .timeout
            if wasTimeout && !inTimeout && e.game.phase == .check {
                resumed.append(e.game.pendingStallResume)
            }
            wasTimeout = inTimeout

            if e.game.phase == .livePossession, let id = e.game.thrower {
                heldFrames += 1
                if let body = e.loco.get(id), let foot = e.loco.pivotOf(id) {
                    pinnedFrames += 1
                    worstPivotReach = Swift.max(
                        worstPivotReach,
                        Foundation.hypot(body.pos.x - foot.x, body.pos.z - foot.z))
                }
            }

            guard inTimeout, let id = e.game.thrower,
                let thrower = e.players.first(where: { $0.id == id })
            else { continue }
            timeoutFrames += 1
            // `distXZ` rather than the expansion, which is what the loop this was lifted from
            // spelled out twice. The sim owns the definition of a ground distance; a second copy
            // here would be a second definition of one number.
            let pivot = e.game.pivot
            worstDrift = Swift.max(worstDrift, distXZ(thrower.pos, pivot))
            for p in e.players where p.team == thrower.team {
                worstSpread = Swift.max(worstSpread, distXZ(p.pos, pivot))
            }
        }

        var attempts = 0
        var completions = 0
        var goals = 0
        var blocks = 0
        var stallOuts = 0
        var travels = 0
        for team in 0..<2 {
            let ts = e.game.teamStats(team)
            attempts += ts.attempts
            completions += ts.completions
            goals += ts.goals
            blocks += ts.blocks
            stallOuts += ts.stallOuts
        }
        let byId = e.game.allPlayers()
        for player in e.players { travels += byId.first { $0.id == player.id }?.travels ?? 0 }
        let forwardGains = gains.reduce(0, +) / Double(Swift.max(1, gains.count))
        let passAttempts = e.game.teamStats(0).attempts + e.game.teamStats(1).attempts
        let completed = e.game.teamStats(0).completions + e.game.teamStats(1).completions
        let throwaways = e.game.teamStats(0).throwaways + e.game.teamStats(1).throwaways
        let drops = e.game.teamStats(0).drops + e.game.teamStats(1).drops
        let cadence = throwsSeen > 0 ? Double(liveTicks) * dt / Double(throwsSeen) : .infinity

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
            holds: e.game.teamStats(0).holds + e.game.teamStats(1).holds,
            breaks: e.game.teamStats(0).breaks + e.game.teamStats(1).breaks,
            turnovers: turnovers,
            attempts: attempts,
            completions: completions,
            goals: goals,
            blocks: blocks,
            stallOuts: stallOuts,
            travels: travels,
            pinnedFrames: pinnedFrames,
            heldFrames: heldFrames,
            worstPivotReach: worstPivotReach,
            scoreEvents: scoreEvents,
            meanGain: forwardGains,
            longestCompletion: completedDists.max() ?? 0,
            hucksAttempted: attemptDists.filter { $0 >= 28 }.count,
            cadence: cadence,
            passPct: passAttempts > 0 ? 100.0 * Double(completed) / Double(passAttempts) : 0,
            totalTurnovers: throwaways + drops + stallOuts + blocks,
            finished: e.isOver,
            deepShots: deepShots,
            scaledDeepShots: scaledDeepShots,
            aimedThrows: aimedThrows
        )
    }
}
