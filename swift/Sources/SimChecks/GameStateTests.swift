import Foundation
import UltimateSim

/// THE PHASE MACHINE — asserted as a machine, not replayed as one run through it.
///
/// # Why the shape of this suite changed
///
/// `gamestate.json` was a **script**: nine scenarios, each a hand-written list of actions,
/// with the snapshot, the return value and the event names recorded after every one. It
/// found ordering bugs, which is the right thing to look for in a state machine, and it
/// found them the only way a fixture can — by walking one path and comparing every step of
/// it.
///
/// One path. Nine of them, and they were chosen by a person, so they cover what that
/// person thought of. The scripts never called `caughtOutOfBounds`, never called
/// `pullLanded`, never called `pullDropped`, never took the sideline instead of the brick,
/// never made a call from a dead disc, and never asked what happens if you try to check
/// during halftime. A recording cannot tell you which cells of the machine it left blank,
/// because from inside a recording every cell it visited looks like the whole machine.
///
/// So this suite asserts the machine instead, in four registers:
///
///  - **The transition table, enumerated and total.** Every phase × every reported action,
///    180 cells, each one driven for real: the legal ones must be accepted and land in a
///    phase the table names, and *every* illegal one must be refused **and change nothing**
///    — snapshot, box score and event stream all compared before and after. See
///    `everyCellOfTheTransitionTableIsDriven()`.
///  - **Reachability, both ways.** Every one of the ten phases is reached from a fresh
///    game, and no phase but `GAME_OVER` is a dead end. A phase that nothing can enter is a
///    phase that is not in the machine, and neither a fixture nor a type checker can see
///    that.
///  - **The laws, over a fuzz.** Twenty seeds of a referee that picks a *legal* action at
///    random from whatever phase the machine is in, tens of thousands of actions, with the
///    invariants of the sport checked after every single one: the score only ever goes up
///    and only ever by one and only ever with a goal announced; possession never crosses
///    from one team to the other without a turnover or a goal to explain it; the count
///    resets exactly when the rules say and runs only while somebody is marking; every
///    phase change is announced to the renderer exactly once, in order.
///  - **The box score reconciles.** Team totals against the sum of their players', every
///    player's `attempts` against what became of them, one team's turnovers committed
///    against the other's forced.
///
/// # Four places the implementation disagrees with the rules of Ultimate
///
/// Each is asserted as it actually behaves, in its own function, labelled — not folded into
/// the tables above as if it were the rule:
///
///  - `aCallBeforeThePullStrandsTheMachine()` — the sharpest of the four, and a hang.
///  - `aTimeoutMayBeCalledWhileThePullIsInTheAir()`
///  - `theDefenceMayNotCallATimeoutButAnyoneMayInADeadPhase()`
///  - and, in `PullTests`/`LineupTests`, the pull's own two.
enum GameStateTests {

    // MARK: - entry point

    static func run() throws {
        vocabulary()
        everyPhaseIsReachable()
        noPhaseButGameOverIsADeadEnd()
        everyCellOfTheTransitionTableIsDriven()

        aCallBeforeThePullStrandsTheMachine()
        aTimeoutMayBeCalledWhileThePullIsInTheAir()
        theDefenceMayNotCallATimeoutButAnyoneMayInADeadPhase()

        theCountRunsOnTheClockAndOnlyUnderAMark()
        theCountResumesWhereTheRulesSay()
        thePointLifecycle()
        theCapsMoveTheTarget()
        theTimeoutBudget()

        theRefereeSweep()

        minis()
    }

    // MARK: - a deterministic sample source

    /// A 64-bit xorshift, written here rather than borrowed from `UltimateSim.Rng`.
    ///
    /// The referee below has to be reproducible — a machine that only misbehaves on some
    /// runs is not something this suite could report — and it must not be the sim's own
    /// generator, because a suite that chooses its inputs with the thing it is testing is
    /// not choosing them independently.
    private struct Sample {
        private var s: UInt64
        init(_ seed: UInt64) { s = seed | 1 }
        mutating func next() -> UInt64 {
            s ^= s << 13
            s ^= s >> 7
            s ^= s << 17
            return s
        }
        mutating func int(_ n: Int) -> Int { n <= 0 ? 0 : Int(next() % UInt64(n)) }
        mutating func unit(_ lo: Double, _ hi: Double) -> Double {
            lo + (hi - lo) * Double(next() >> 11) * (1.0 / 9_007_199_254_740_992.0)
        }
        mutating func bool() -> Bool { next() & 1 == 1 }
    }

    // MARK: - the vocabulary

    /// The renderer's entire contract with the simulation, pinned.
    ///
    /// Every phase name, every turnover reason, every dead-disc reason, every call type and
    /// every event string. These are not laws and they are not tuning values — they are
    /// *names*, and a name is exactly the kind of thing that can be changed without
    /// changing a single number and without anything else in this project noticing. A
    /// renamed event breaks the HUD in silence.
    ///
    /// So they are enumerated exhaustively, not spot-checked: `allCases`-style lists
    /// written out here, with a count assertion, so a phase added to the machine and not
    /// added to this list fails rather than slipping past.
    private static func vocabulary() {
        let phases: [(Phase, String)] = [
            (.prePull, "PRE_PULL"), (.pullInFlight, "PULL_IN_FLIGHT"),
            (.livePossession, "LIVE_POSSESSION"), (.discInFlight, "DISC_IN_FLIGHT"),
            (.turnoverDead, "TURNOVER_DEAD"), (.check, "CHECK"),
            (.pointScored, "POINT_SCORED"), (.timeout, "TIMEOUT"),
            (.halftime, "HALFTIME"), (.gameOver, "GAME_OVER"),
        ]
        for (p, s) in phases { Check.eq(p.rawValue, s, "phase \(s) is spelled \(s)") }
        Check.eq(phases.count, 10, "the machine has ten phases")
        Check.eq(Set(phases.map(\.1)).count, 10, "and no two of them share a name")
        Check.eq(
            Set(phases.map(\.0)).count, 10, "and no two of the cases are the same case")

        let reasons: [(TurnoverReason, String)] = [
            (.drop, "drop"), (.throwaway, "throwaway"), (.outOfBounds, "out-of-bounds"),
            (.caughtOutOfBounds, "caught-out-of-bounds"), (.block, "block"),
            (.interception, "interception"), (.stallOut, "stall-out"),
            (.pullDrop, "pull-drop"), (.travelViolation, "travel-violation"),
            (.doubleTouch, "double-touch"),
        ]
        for (r, s) in reasons { Check.eq(r.rawValue, s, "turnover reason \(s)") }
        Check.eq(reasons.count, 10, "there are ten ways to lose the disc")

        let dead: [(DeadReason, String)] = [
            (.turnover, "turnover"), (.pullLanded, "pull-landed"),
            (.pullOutOfBounds, "pull-out-of-bounds"), (.pullDropped, "pull-dropped"),
        ]
        for (d, s) in dead { Check.eq(d.rawValue, s, "dead-disc reason \(s)") }
        Check.eq(dead.count, 4, "four ways for the disc to be dead")
        // Three of the four are pulls, which is the whole reason the reason exists: only a
        // turnover restarts with a check.
        Check.eq(dead.filter { $0.1.hasPrefix("pull") }.count, 3, "three of them are pulls")

        let calls: [(CallType, String)] = [
            (.foul, "foul"), (.travel, "travel"), (.pick, "pick"), (.strip, "strip"),
            (.violation, "violation"),
        ]
        for (c, s) in calls { Check.eq(c.rawValue, s, "call type \(s)") }
        Check.eq(calls.count, 5, "five things a player may call")

        Check.eq(PullSpotChoice.brick.rawValue, "brick", "the brick")
        Check.eq(PullSpotChoice.sideline.rawValue, "sideline", "or the sideline (WFDF 13.2)")

        // The event names, from real instances rather than from a switch written twice.
        let z = Vec3d()
        let events: [(GameEvent, String)] = [
            (.discReleased(pos: z, vel: z, spin: 0, throwType: "t", playerId: 0, team: 0, stall: nil),
                "disc:released"),
            (.discCaught(playerId: 0, pos: z, team: 0, outcome: "o"), "disc:caught"),
            (.discGrounded(pos: z, reason: "r"), "disc:grounded"),
            (.pull(team: 0, playerId: 0, from: z, vel: nil), "pull"),
            (.stallTick(count: 1, max: 10, playerId: nil, team: nil, markerId: nil), "stall:tick"),
            (.score(team: 0, playerId: 0, assistId: nil, score: [0, 0], scoreline: "", point: 1),
                "score"),
            (.turnover(
                reason: .drop, from: 0, to: 1, playerId: 0, pos: z, spot: z, point: 1,
                score: [0, 0]), "turnover"),
            (.stateChanged(
                from: .prePull, to: .prePull, clock: 0, point: 1, possession: nil, score: [0, 0]),
                "state:changed"),
            (.call(type: .foul, callerId: 0, againstId: 1, at: z, phaseAtCall: .prePull), "call"),
            (.callResolved(type: .foul, contested: false, outcome: "o", stallResume: 0),
                "call:resolved"),
            (.timeout(team: 0, playerId: nil, remaining: 0), "timeout"),
            (.half(half: 1, score: [0, 0]), "half"),
            (.gameOver(score: [0, 0], winner: 0, teamName: ""), "game:over"),
            (.violation(.travel(playerId: 0, pivot: z, foot: z)), "violation"),
            (.cap(kind: "soft", target: 1), "cap"),
        ]
        for (e, s) in events { Check.eq(e.name, s, "event \(s)") }
        Check.eq(events.count, 15, "fifteen events are the whole contract")
        Check.eq(Set(events.map(\.1)).count, 15, "and none of them shares a name")

        // The three shapes of `violation`, which all come out under one event name.
        Check.eq(
            Violation.discSpace(markerId: nil, dist: 0).type, "disc-space", "disc-space")
        Check.eq(
            Violation.doubleTeam(markerId: nil, playerId: 0).type, "double-team", "double-team")
        Check.eq(Violation.travel(playerId: 0, pivot: z, foot: z).type, "travel", "travel")
    }

    // MARK: - drivers

    private static let n = GameFormat.sevens.playersPerSide
    private static let field = FieldConstants.standard

    /// A game plus the events it has emitted since the last time they were drained.
    private final class Stage {
        let game: GameState

        init(_ mutate: @escaping (inout RuleSet) -> Void = { _ in }, format: GameFormat = .sevens) {
            var opts = GameStateOptions()
            opts.format = format
            opts.rules = mutate
            let box = Box()
            opts.emit = { box.events.append($0) }
            game = GameState(opts)
            self.box = box
        }

        /// The emitter has to be installed before `self` is fully initialised, so it writes
        /// into a shared box rather than capturing `self`.
        private let box: Box
        final class Box { var events: [GameEvent] = [] }

        func drain() -> [GameEvent] {
            let e = box.events
            box.events.removeAll()
            return e
        }
    }

    /// Drive a fresh game into `phase` and hand it over, drained.
    ///
    /// Returns nil only if the drive failed, which is itself asserted by the caller — a
    /// phase that cannot be reached is the reachability failure this suite exists to catch.
    private static func stage(_ phase: Phase) -> Stage? {
        // Halftime and game over need a game short enough to finish; the rest do not care.
        let s: Stage
        switch phase {
        case .halftime: s = Stage { $0.halftimeAt = 1 }
        case .gameOver: s = Stage { $0.gameTo = 1; $0.halftimeAt = 99 }
        default: s = Stage()
        }
        let g = s.game
        g.startGame()
        if phase == .prePull { _ = s.drain(); return s }

        let pulling = g.pullingTeam
        let receiving = otherTeam(pulling)
        g.pull(pulling * n, Vec3d(0, 1, field.goalLineZ(flipDir(g.attackDir[pulling]))), Vec3d(0, 8, 20))
        if phase == .pullInFlight { _ = s.drain(); return s }

        if phase == .turnoverDead {
            // A dead disc from a landed pull — the simplest one, and the one where
            // `deadReason` is not `.turnover`, so `pickUp` restarts live.
            g.pullLanded(Vec3d(1, 0, -4))
            _ = s.drain()
            return s
        }

        g.pullCaught(receiving * n, Vec3d(0, 1, -10))
        if phase == .livePossession { _ = s.drain(); return s }
        if phase == .timeout {
            g.callTimeout(receiving, receiving * n)
            _ = s.drain()
            return s
        }
        if phase == .check {
            // A real turnover, picked up: the one restart that owes a check.
            g.release(playerId: receiving * n, pos: Vec3d(0, 1, -10), vel: Vec3d(0, 2, 12))
            g.ground(Vec3d(1, 0, 4))
            g.pickUp(pulling * n + 1, Vec3d(1, 0, 4))
            _ = s.drain()
            return s
        }

        g.release(playerId: receiving * n, pos: Vec3d(0, 1, -10), vel: Vec3d(0, 2, 12))
        if phase == .discInFlight { _ = s.drain(); return s }

        // Everything left needs a goal.
        let dir = g.attackDir[receiving]
        g.catchDisc(receiving * n + 1, Vec3d(2, 1, Double(dir) * (field.goalLine + 3)))
        if phase == .pointScored { _ = s.drain(); return s }

        g.advanceAfterScore()
        if phase == .halftime || phase == .gameOver {
            _ = s.drain()
            return g.phase == phase ? s : nil
        }
        return nil
    }

    // MARK: - reachability

    /// Every phase in the vocabulary is reachable from a fresh game.
    ///
    /// A phase nothing can enter is dead code with a name, and the type checker cannot see
    /// it because the enum case compiles perfectly well. The nine scripts in
    /// `gamestate.json` happened to reach eight of the ten; this asserts all ten, and
    /// asserts it by *arriving* there rather than by asserting a list.
    private static func everyPhaseIsReachable() {
        for phase in allPhases {
            guard let s = stage(phase) else {
                Check.ok(false, "\(phase.rawValue) is UNREACHABLE — nothing drives into it")
                continue
            }
            Check.eq(s.game.phase, phase, "\(phase.rawValue) is reachable from a fresh game")
        }
    }

    /// No phase but `GAME_OVER` is a dead end.
    ///
    /// The counterpart of reachability, and the one that catches a phase you can get into
    /// and not out of — which is a hang, not a wrong answer, and therefore the failure mode
    /// that does the most damage. Each phase is entered and then offered every action in
    /// turn plus a generous `step`; at least one of them must move it on.
    private static func noPhaseButGameOverIsADeadEnd() {
        for phase in allPhases where phase != .gameOver {
            var escaped = false
            for op in Op.allCases {
                guard let s = stage(phase) else { break }
                _ = apply(op, s)
                if s.game.phase != phase { escaped = true }
            }
            // …and the clock alone gets you out of the three timed phases.
            if let s = stage(phase) {
                s.game.step(400)
                if s.game.phase != phase { escaped = true }
            }
            Check.ok(escaped, "\(phase.rawValue) has a way out — it is not a dead end")
        }
        // And GAME_OVER really is final: nothing moves it, including a very long step.
        guard let over = stage(.gameOver) else { return }
        for op in Op.allCases {
            _ = apply(op, over)
            Check.eq(over.game.phase, .gameOver, "\(op.rawValue) does not restart a finished game")
        }
        over.game.step(3600)
        Check.eq(over.game.phase, .gameOver, "and neither does an hour of clock")
    }

    private static let allPhases: [Phase] = [
        .prePull, .pullInFlight, .livePossession, .discInFlight, .turnoverDead, .check,
        .pointScored, .timeout, .halftime, .gameOver,
    ]

    // MARK: - the transition table

    /// Every reported action the machine exposes that returns a verdict.
    ///
    /// The void methods (`startGame`, `setLine`, `step`, `setPivot`, `advanceAfterScore`,
    /// `resumeFromHalftime`, `endTimeout`, `applySoftCap`, `applyHardCap`) are not in here
    /// because they have no verdict to compare — they are guarded internally and are
    /// covered by the lifecycle and cap functions below, and by the dead-end sweep above,
    /// which offers `step` to every phase.
    private enum Op: String, CaseIterable {
        case pull, pullCaught, pullDropped, pullLanded, pullOutOfBounds, choosePullSpot
        case pickUp, check, release, catchDisc, drop, ground, outOfBounds, caughtOutOfBounds
        case block, callTimeout, makeCall, resolveCall
    }

    /// **The rule.** In which phases does the sport allow this action at all?
    ///
    /// Written from the rulebook rather than from `GameState.swift`, one row at a time:
    ///
    ///  - the five pull reports belong to a pull in the air, and nowhere else (WFDF 13);
    ///  - `choosePullSpot` and `resolveCall` are not phase-gated at all — they answer an
    ///    outstanding question, and with no question outstanding there is nothing to answer;
    ///  - `pickUp` needs a disc on the ground; `check` needs a stoppage to end;
    ///  - `release` needs a thrower with a live disc, and everything that resolves a pass
    ///    needs a pass in the air;
    ///  - `catchDisc`, `drop` and `outOfBounds` are also the pull's own reports under other
    ///    names, so they route rather than refuse while the pull is up;
    ///  - a timeout may be called by a team between points or, in possession, during one —
    ///    but never while the disc is in the air (WFDF 19.1), and not while the game is
    ///    stopped for something else;
    ///  - a call may be made whenever there is play to stop.
    private static func ruleSaysLegal(_ op: Op, _ phase: Phase) -> Bool {
        switch op {
        case .pull:
            return phase == .prePull
        case .pullCaught, .pullDropped, .pullLanded, .pullOutOfBounds:
            return phase == .pullInFlight
        case .choosePullSpot, .resolveCall:
            return false  // nothing is outstanding in any freshly staged phase
        case .pickUp:
            return phase == .turnoverDead
        case .check:
            return phase == .check
        case .release:
            return phase == .livePossession
        case .catchDisc, .drop, .outOfBounds:
            return phase == .discInFlight || phase == .pullInFlight
        case .ground, .caughtOutOfBounds, .block:
            return phase == .discInFlight
        case .callTimeout:
            switch phase {
            case .discInFlight, .pullInFlight, .timeout, .halftime, .gameOver: return false
            default: return true
            }
        case .makeCall:
            switch phase {
            case .timeout, .halftime, .gameOver: return false
            default: return true
            }
        }
    }

    /// The cells where this implementation knowingly answers something else, and why.
    ///
    /// Listed rather than silently folded into `ruleSaysLegal`, so the sweep below asserts
    /// the *rule* everywhere except here, and asserts the *behaviour* here — which is what
    /// keeps a disagreement with the sport visible instead of encoding it as if it were the
    /// sport. Each has its own function further down that shows what it costs.
    private static let divergences: [(op: Op, phase: Phase, note: String)] = [
        (
            .callTimeout, .pullInFlight,
            "WFDF 19.1: no timeout while the disc is in the air. `callTimeout` refuses only "
                + "DISC_IN_FLIGHT, so a pull — which is a disc in the air — goes through"
        )
    ]

    /// **The whole table, driven.** Ten phases by eighteen actions.
    ///
    /// For every cell: a fresh game is driven into the phase, its snapshot, box score and
    /// event stream are taken, the action is applied, and
    ///
    ///  - a legal action must return `ok: true` and land the machine in a phase this table
    ///    names as an outgoing edge of that phase;
    ///  - an **illegal action must return `ok: false`, carry a note saying why, emit
    ///    nothing at all, and leave the snapshot, both teams' statistics and every player's
    ///    line exactly as they were.**
    ///
    /// That second clause is the one a scripted fixture cannot get to. A script of legal
    /// sequences never asks it, and a script that attempts a handful of illegal ones asks
    /// it about the handful somebody thought of. A machine that quietly half-applied a
    /// refused action — incremented an attempt and then bailed — passes every fixture built
    /// out of legal play and loses a game three turnovers later.
    private static func everyCellOfTheTransitionTableIsDriven() {
        var legalCells = 0
        var refusedCells = 0

        for phase in allPhases {
            for op in Op.allCases {
                guard let s = stage(phase) else {
                    Check.ok(false, "could not stage \(phase.rawValue) for \(op.rawValue)")
                    continue
                }
                let diverges = divergences.first { $0.op == op && $0.phase == phase }
                let expected = diverges == nil ? ruleSaysLegal(op, phase) : !ruleSaysLegal(op, phase)
                let at = "\(phase.rawValue) + \(op.rawValue)"

                let before = s.game.snapshot()
                let beforeTeams = [s.game.teamStats(0), s.game.teamStats(1)]
                let beforePlayers = s.game.allPlayers()
                let beforeLog = s.game.getLog().count

                let got = apply(op, s)
                let events = s.drain()

                guard let got else {
                    Check.ok(false, "\(at): the driver returned no verdict")
                    continue
                }

                if let diverges {
                    Check.eq(
                        got.ok, expected,
                        "DIVERGENCE \(at): behaves as \(expected ? "legal" : "refused"). "
                            + diverges.note)
                } else {
                    Check.eq(got.ok, expected, "\(at): \(expected ? "is allowed" : "is refused")")
                }

                if got.ok {
                    legalCells += 1
                    Check.ok(got.note == nil, "\(at): an accepted action carries no complaint")
                    Check.ok(
                        outgoing(phase).contains(s.game.phase),
                        "\(at): lands in \(s.game.phase.rawValue), which \(phase.rawValue) "
                            + "may lead to")
                } else {
                    refusedCells += 1
                    Check.ok(got.note != nil, "\(at): a refusal says why, for the play log")
                    Check.eq(s.game.snapshot(), before, "\(at): the refusal changed no state")
                    Check.eq(
                        [s.game.teamStats(0), s.game.teamStats(1)], beforeTeams,
                        "\(at): and no team statistic")
                    Check.eq(
                        s.game.allPlayers(), beforePlayers, "\(at): and nobody's line")
                    Check.ok(
                        events.isEmpty,
                        "\(at): and told the renderer nothing (got \(events.map(\.name)))")
                    // The refusal is still written down: a machine that silently swallows
                    // an illegal report gives a caller nothing to debug with.
                    Check.eq(
                        s.game.getLog().count, beforeLog + 1,
                        "\(at): but is recorded in the play log")
                }
            }
        }

        Check.eq(
            legalCells + refusedCells, allPhases.count * Op.allCases.count,
            "every cell of the \(allPhases.count) x \(Op.allCases.count) table was driven")
        Check.ok(legalCells > 0, "\(legalCells) cells are legal")
        Check.ok(refusedCells > 0, "and \(refusedCells) are refused")
    }

    /// Which phases each phase may lead to. The edges of the machine, from the sport.
    ///
    /// A phase's own name is always in its own set, because most actions legal in a phase do
    /// not leave it — a `step` that does not tick past a boundary, a call resolved back to
    /// where it started.
    private static func outgoing(_ phase: Phase) -> Set<Phase> {
        switch phase {
        // A point begins with a pull, and a call or a timeout can stop it before one.
        case .prePull: return [.prePull, .pullInFlight, .check, .timeout]
        // The pull is caught (live), or it is not (dead) — and a timeout may divert it.
        case .pullInFlight: return [.pullInFlight, .livePossession, .turnoverDead, .check, .timeout]
        // Throw it, get stalled, stop play.
        case .livePossession: return [.livePossession, .discInFlight, .turnoverDead, .check, .timeout]
        // Complete it, score with it, or lose it.
        case .discInFlight:
            return [.discInFlight, .livePossession, .turnoverDead, .pointScored, .check]
        // Pick it up — live after a pull, checked after a turnover.
        case .turnoverDead: return [.turnoverDead, .livePossession, .check, .timeout]
        // Tap it in.
        case .check: return [.check, .livePossession, .timeout]
        // Set up the next point, or end the half, or end the game.
        case .pointScored: return [.pointScored, .prePull, .halftime, .gameOver, .check, .timeout]
        // Back on — to a check if somebody was holding it, else to where play stopped.
        case .timeout:
            return [.timeout, .check, .livePossession, .prePull, .turnoverDead, .pointScored]
        case .halftime: return [.halftime, .prePull]
        case .gameOver: return [.gameOver]
        }
    }

    /// Apply one action with arguments derived from the machine's own current state.
    ///
    /// The arguments matter: a legal action given an illegal actor would be refused for the
    /// wrong reason and the table above would read as if the phase were closed. So the
    /// thrower is the machine's thrower, the catcher is on the offence, the blocker is on
    /// the defence, and the puller is on the pulling team.
    private static func apply(_ op: Op, _ s: Stage) -> ActionResult? {
        let g = s.game
        let pulling = g.pullingTeam
        let receiving = otherTeam(pulling)
        let offence = g.possession ?? receiving
        let defence = otherTeam(offence)
        // Mid-pitch, in bounds, in neither end zone — so a catch here is a completion and
        // never accidentally a goal.
        let middle = Vec3d(2, 1, 0)
        let outside = Vec3d(field.sideline + 5, 0, 3)
        let onTheLine = Vec3d(field.sideline, 0, 3)

        switch op {
        case .pull:
            return g.pull(
                pulling * n + 1, Vec3d(0, 1, field.goalLineZ(flipDir(g.attackDir[pulling]))),
                Vec3d(0, 8, 20))
        case .pullCaught: return g.pullCaught(receiving * n + 2, middle)
        case .pullDropped: return g.pullDropped(receiving * n + 2, middle)
        case .pullLanded: return g.pullLanded(middle)
        case .pullOutOfBounds: return g.pullOutOfBounds(onTheLine)
        case .choosePullSpot: return g.choosePullSpot(.brick)
        case .pickUp: return g.pickUp(offence * n + 3, nil)
        case .check: return g.check()
        case .release:
            return g.release(playerId: g.thrower ?? offence * n, pos: g.pivot, vel: Vec3d(0, 2, 12))
        case .catchDisc: return g.catchDisc(offence * n + 4, middle)
        case .drop: return g.drop(offence * n + 4, middle)
        case .ground: return g.ground(middle)
        case .outOfBounds: return g.outOfBounds(onTheLine)
        case .caughtOutOfBounds: return g.caughtOutOfBounds(offence * n + 4, outside)
        case .block: return g.block(defence * n + 4, middle)
        case .callTimeout: return g.callTimeout(offence, offence * n)
        case .makeCall: return g.makeCall(.foul, offence * n, defence * n, nil)
        case .resolveCall: return g.resolveCall(false, receiverId: nil)
        }
    }

    // MARK: - the divergences, each shown for what it costs

    /// **KNOWN BUG — a reachable hang, reported and not endorsed.**
    ///
    /// `makeCall` refuses only `TIMEOUT`, `HALFTIME` and `GAME_OVER`, so a call may be made
    /// during `PRE_PULL`, before anybody has touched the disc. Its remedy is unconditional:
    /// stop play and go to `CHECK`, with `resumeAfterStoppage = LIVE_POSSESSION`. Tapping
    /// the disc in from that check then puts the machine into `LIVE_POSSESSION` with
    /// **`possession == nil` and `thrower == nil`** — live play, nobody holding the disc,
    /// and the pull never thrown.
    ///
    /// It does not recover. `tickStall` runs the count (there is a legal mark by default,
    /// and `stallRunning` was just set), the count reaches ten, and `stallOut()` bails on
    /// its own `guard let from = possession` without changing the phase — so the count
    /// keeps climbing past `stallMax` forever and no clock, action or step ever leaves
    /// `LIVE_POSSESSION`. The point cannot end and the match cannot proceed.
    ///
    /// The right remedy is that a call before the pull returns to `PRE_PULL`, not to a
    /// check; the phase to resume to is already recorded as `phaseAtCall` on the call and
    /// simply is not read. It is asserted here as it behaves, so the hang is visible and
    /// measured rather than latent.
    private static func aCallBeforeThePullStrandsTheMachine() {
        let s = Stage()
        let g = s.game
        g.startGame()
        Check.eq(g.phase, .prePull, "a fresh point, before the pull")
        Check.ok(g.possession == nil, "and nobody has the disc")

        let call = g.makeCall(.foul, 0, n, Vec3d(0, 1, 0))
        Check.ok(call.ok, "BUG: a foul may be called before the pull is thrown")
        Check.eq(
            g.phase, .check,
            "BUG: and its remedy is a CHECK, ignoring that the call's own `phaseAtCall` "
                + "says PRE_PULL")

        Check.ok(g.resolveCall(false).ok, "the call is accepted")
        Check.ok(g.check().ok, "and the disc is tapped in")
        Check.eq(
            g.phase, .livePossession,
            "BUG: the machine is now in LIVE_POSSESSION — live play, no pull thrown")
        Check.ok(g.possession == nil, "BUG: with nobody in possession")
        Check.ok(g.thrower == nil, "BUG: and nobody holding the disc")
        Check.ok(g.stallRunning, "BUG: and the stall count running on nobody")

        // Sixty seconds of clock, six times the stall the rules allow.
        for _ in 0..<(120 * 60) { g.step(1.0 / 120.0) }
        Check.eq(
            g.phase, .livePossession,
            "HANG: a minute of clock does not end the point — `stallOut` bails on its own "
                + "`guard let from = possession` without changing the phase")
        Check.eq(
            g.stallCount, g.rules.stallMax,
            "HANG: the count sat on ten and stopped — `stallOut` cleared `stallRunning` on "
                + "its way out of its own guard, so nothing counts and nothing resolves")
        Check.ok(
            g.stallRunning,
            "HANG: and the count is still notionally running — `stallOut` returns from its "
                + "own `guard let from = possession` before it can even stop it")
        Check.eq(g.score, [0, 0], "no point can be scored from here")
        Check.eq(g.point, 1, "and the match is stuck on point one")
    }

    /// **KNOWN DIVERGENCE — a timeout may be called while the pull is in the air.**
    ///
    /// WFDF 19.1: a timeout may not be called while the disc is in the air. `callTimeout`
    /// implements that as a test against `DISC_IN_FLIGHT` alone, and a pull in flight is a
    /// separate phase, so it slips through — and by *either* team, because the
    /// possession-team restriction is also gated on `live`, which `PULL_IN_FLIGHT` is not.
    ///
    /// The consequence is not cosmetic: the pull is still airborne with no phase left to
    /// resolve it into. `resumeAfterStoppage` records `PULL_IN_FLIGHT`, so ending the
    /// timeout does put the machine back — which is the mitigation, and the reason this is
    /// a divergence rather than a second hang.
    private static func aTimeoutMayBeCalledWhileThePullIsInTheAir() {
        guard let s = stage(.pullInFlight) else { return }
        let g = s.game
        let pulling = g.pullingTeam

        let r = g.callTimeout(pulling, pulling * n)
        Check.ok(
            r.ok,
            "DIVERGENCE: a timeout is accepted with the pull in the air. WFDF 19.1 forbids "
                + "it; the guard names DISC_IN_FLIGHT only")
        Check.eq(g.phase, .timeout, "and play stops mid-pull")
        Check.eq(
            g.teamStats(pulling).timeoutsUsed, 1, "a timeout is spent to do it")

        g.endTimeout()
        Check.eq(
            g.phase, .pullInFlight,
            "the mitigation: `resumeAfterStoppage` puts the pull back in the air, so this "
                + "is a rules divergence and not a lost disc")

        // …and for contrast, the same call with a pass in the air is correctly refused.
        guard let air = stage(.discInFlight) else { return }
        let h = air.game
        Check.ok(
            !h.callTimeout(h.possession ?? 0, nil).ok,
            "with a *pass* in the air the same call is refused, which is the rule the pull "
                + "should be getting too")
    }

    /// Who may call a timeout, and when.
    ///
    /// WFDF 19.1: during a point only the team in possession may call one; between points
    /// either team may. `defenseMayCallTimeout` is the knob that relaxes the first clause,
    /// and it is off by default, which is the rule.
    ///
    /// The second clause is where this is looser than the sport: in every *stopped* phase —
    /// a dead disc, a check, after a goal — the machine lets either team call one with no
    /// test at all. That is right between points and questionable during a stoppage that
    /// somebody else caused, and it is recorded here rather than asserted as correct.
    private static func theDefenceMayNotCallATimeoutButAnyoneMayInADeadPhase() {
        guard let s = stage(.livePossession) else { return }
        let g = s.game
        guard let offence = g.possession else { return }
        let defence = otherTeam(offence)

        Check.ok(
            !g.callTimeout(defence, defence * n).ok,
            "the defence may not call a timeout during a point (WFDF 19.1)")
        Check.eq(
            g.teamStats(defence).timeoutsUsed, 0, "and the refusal spent nothing")
        Check.ok(g.callTimeout(offence, offence * n).ok, "the team in possession may")

        // The knob that relaxes it, which is off by default.
        let relaxed = Stage { $0.defenseMayCallTimeout = true }
        let h = relaxed.game
        h.startGame()
        let hp = h.pullingTeam
        h.pull(hp * n, Vec3d(0, 1, field.goalLineZ(flipDir(h.attackDir[hp]))), Vec3d(0, 8, 20))
        h.pullCaught(otherTeam(hp) * n, Vec3d(0, 1, -10))
        Check.ok(
            h.callTimeout(hp, hp * n).ok,
            "…unless the rule set says otherwise, which by default it does not")
        Check.ok(
            !DEFAULT_RULES.defenseMayCallTimeout,
            "and by default it does not (defenseMayCallTimeout)")

        // The looser half, recorded.
        guard let dead = stage(.turnoverDead) else { return }
        let k = dead.game
        guard let owner = k.possession else { return }
        Check.ok(
            k.callTimeout(otherTeam(owner), nil).ok,
            "LOOSE: with the disc dead, the team that does NOT have it may call a timeout "
                + "— right between points, unexamined during a stoppage")
    }

    // MARK: - the stall count

    /// **WFDF 18 — the count.** One per second, only under a legal mark, ten is a turnover.
    ///
    /// The count is a function of *elapsed marked time*, not of ticks, which is why it is
    /// driven here in uneven slices: a machine that counted ticks and a machine that floors
    /// elapsed seconds agree on round numbers and disagree everywhere else.
    ///
    /// The marked-time clause is the one with teeth. A marker out of range, inside disc
    /// space, or absent stops the count — the count is *the marker's*, and there is no
    /// marker — and this drives all three, comparing the count against a model that simply
    /// integrates the seconds during which a legal mark stood.
    private static func theCountRunsOnTheClockAndOnlyUnderAMark() {
        guard let s = stage(.livePossession) else { return }
        let g = s.game
        guard let offence = g.possession, let thrower = g.thrower else { return }
        let defence = otherTeam(offence)
        let pivot = g.pivot

        Check.eq(g.stallCount, 0, "a fresh possession starts at zero")
        Check.ok(g.stallRunning, "with the count running")

        // A model of the rule: seconds accumulated while a legal mark stood, floored.
        var marked = 0.0
        var rng = Sample(0x5741_11ee)
        var slices = 0
        var legalSlices = 0

        // Marks: legal (inside range, outside disc space), too far, and too close.
        let legalMark = Vec3d(pivot.x + 1.2, 0, pivot.z + 0.6)
        let farMark = Vec3d(pivot.x + 9, 0, pivot.z)
        let closeMark = Vec3d(pivot.x + 0.05, 0, pivot.z)

        while g.phase == .livePossession && slices < 300 {
            slices += 1
            let dt = rng.unit(0.05, 0.4)
            let pick = rng.int(6)
            let mark: Reported<Vec3d>
            let legal: Bool
            switch pick {
            case 0: mark = .value(farMark); legal = false
            case 1: mark = .value(closeMark); legal = false
            case 2: mark = .null; legal = false
            default: mark = .value(legalMark); legal = true
            }
            var obs = FrameObservation()
            obs.throwerPos = pivot
            obs.markerId = pick == 2 ? .null : .value(defence * n)
            obs.markerPos = mark
            g.step(dt, obs)
            if legal {
                marked += dt
                legalSlices += 1
            }
            Check.eq(
                g.markerLegal(), legal,
                "slice \(slices): the mark is \(legal ? "legal" : "not legal") and the "
                    + "machine agrees")
            if g.phase != .livePossession { break }
            Check.eq(
                g.stallCount, stallCountFor(marked, g.rules),
                "slice \(slices): the count is the floor of \(marked) marked seconds")
            Check.ok(
                g.stallCount <= g.rules.stallMax,
                "slice \(slices): and never exceeds the ten that ends it")
        }

        Check.ok(legalSlices > 0, "the sweep spent \(legalSlices) slices under a legal mark")
        Check.ok(
            slices > legalSlices, "and \(slices - legalSlices) with no legal mark, stopped")
        Check.eq(
            g.phase, .turnoverDead,
            "the count reached ten and the disc changed hands (WFDF 18.2)")
        Check.eq(g.possession, defence, "to the defence")
        Check.eq(g.teamStats(offence).stallOuts, 1, "charged as a stall-out")
        Check.eq(
            g.allPlayers().first { $0.id == thrower }?.stallOuts, 1, "against the thrower")
        Check.bitEq(
            g.discPos.z, field.putIntoPlaySpot(pivot, g.attackDir[defence], g.rules).z,
            "and the disc is spotted at the pivot, which is where the stall happened")

        // A count that is not running does not run, however long the clock is left.
        guard let dead = stage(.turnoverDead) else { return }
        for _ in 0..<600 { dead.game.step(1.0 / 120.0) }
        Check.eq(dead.game.stallCount, 0, "a dead disc is not being counted on")
        Check.ok(!dead.game.stallRunning, "because there is nobody to count")
    }

    /// **WFDF 18.4 — a count resumes at reached-plus-one, capped at nine.** And the three
    /// remedies that do something else.
    ///
    /// This is the rule with the most exceptions in the sport, and each exception is a
    /// different number, so each is driven separately rather than sampled:
    ///
    ///  - a **contested** call, a **pick**, a **strip**, a **violation** and a **timeout**
    ///    all resume at reached + 1, capped (18.4, 19.2);
    ///  - a **marking foul** resets the count to zero — the mark was illegal, so the count
    ///    it was running was not a count (12.6);
    ///  - an accepted **travel** backs the count up by one, because the count continued
    ///    through a throw that did not happen (18.3);
    ///  - a **turnover** always starts a fresh possession at zero.
    ///
    /// The cap is asserted at the boundary rather than in the middle: a count reached at
    /// nine resumes at nine, not ten, because ten is a turnover and no restart may begin on
    /// one.
    private static func theCountResumesWhereTheRulesSay() {
        /// Drive to a live possession and run the count to `to`, then run `body`.
        func at(_ to: Int, _ body: (GameState, TeamId, TeamId) -> Void) {
            guard let s = stage(.livePossession) else { return }
            let g = s.game
            guard let offence = g.possession else { return }
            let defence = otherTeam(offence)
            var obs = FrameObservation()
            obs.throwerPos = g.pivot
            obs.markerId = .value(defence * n)
            obs.markerPos = .value(Vec3d(g.pivot.x + 1.2, 0, g.pivot.z))
            while g.stallCount < to && g.phase == .livePossession { g.step(0.1, obs) }
            Check.eq(g.stallCount, to, "the count reached \(to)")
            body(g, offence, defence)
        }

        let cap = DEFAULT_RULES.stallResumeCap

        at(6) { g, offence, defence in
            g.makeCall(.foul, offence * n, defence * n, nil)
            g.resolveCall(true)
            Check.eq(g.pendingStallResume, 7, "a contested call resumes at reached + 1 (18.4)")
            g.check()
            Check.eq(g.stallCount, 7, "and the tap-in sets the count to it")
            Check.eq(g.possession, offence, "with the disc still on the same team")
        }

        at(6) { g, offence, defence in
            // A marking foul: called by the thrower, against the marker, with the disc in
            // the hand rather than in the air.
            g.makeCall(.foul, offence * n, defence * n, nil)
            g.resolveCall(false)
            Check.eq(
                g.pendingStallResume, 0,
                "an accepted marking foul resets the count to zero — an illegal mark was "
                    + "not running a count")
            g.check()
            Check.eq(g.stallCount, 0, "and the tap-in starts again from nothing")
        }

        at(6) { g, offence, defence in
            g.makeCall(.travel, defence * n, offence * n, nil)
            g.resolveCall(false)
            Check.eq(
                g.pendingStallResume, 5,
                "an accepted travel backs the count up one (18.3), because the count ran "
                    + "through a throw that did not happen")
            Check.eq(
                g.allPlayers().first { $0.id == offence * n }?.travels, 1,
                "and the travel is recorded against the thrower")
        }

        at(6) { g, offence, defence in
            g.makeCall(.pick, offence * n, defence * n, nil)
            g.resolveCall(false)
            Check.eq(g.pendingStallResume, 7, "an accepted pick resumes at reached + 1")
            Check.eq(
                g.allPlayers().first { $0.id == offence * n }?.picks, 1,
                "credited to whoever called it")
        }

        at(9) { g, offence, defence in
            g.makeCall(.violation, offence * n, defence * n, nil)
            g.resolveCall(true)
            Check.eq(
                g.pendingStallResume, cap,
                "the cap bites: nine plus one is capped at \(cap), because a restart may "
                    + "not begin on the count that ends the possession")
            Check.ok(cap < DEFAULT_RULES.stallMax, "and \(cap) is short of the stall-out")
        }

        at(5) { g, offence, _ in
            g.callTimeout(offence, offence * n)
            Check.eq(g.pendingStallResume, 6, "a timeout resumes at reached + 1 too (19.2)")
            g.endTimeout()
            Check.eq(g.phase, .check, "and comes back through a check, because somebody had it")
            g.check()
            Check.eq(g.stallCount, 6, "which sets the count")
            Check.eq(g.possession, offence, "and the possession survives the stoppage")
        }

        at(7) { g, offence, _ in
            // A turnover, and the fresh possession that follows it.
            g.release(playerId: g.thrower, pos: g.pivot, vel: Vec3d(0, 2, 12))
            Check.eq(g.stallCount, 7, "a release does not clear the count on its own")
            Check.ok(!g.stallRunning, "but it does stop it running — the disc is gone")
            g.ground(Vec3d(1, 0, 6))
            Check.eq(g.stallCount, 0, "a turnover starts the next possession at zero")
            Check.eq(g.possession, otherTeam(offence), "on the other team")
            g.pickUp(otherTeam(offence) * n + 1, nil)
            Check.eq(g.pendingStallResume, 0, "a picked-up turnover owes no resume")
            g.check()
            Check.eq(g.stallCount, 0, "and restarts at zero")
        }

        // The cap is a value, not a shape: pin it and the count that ends a possession.
        Check.eq(DEFAULT_RULES.stallResumeCap, 9, "the resume cap is nine (WFDF 18.4)")
        Check.eq(DEFAULT_RULES.stallMax, 10, "and the count that ends it is ten (WFDF 18.1)")
        Check.eq(
            resumeStallCount(DEFAULT_RULES.stallMax, DEFAULT_RULES), DEFAULT_RULES.stallResumeCap,
            "so even a count that reached the maximum resumes at the cap")
    }

    // MARK: - the point, the half, the game

    /// How a point ends and the next one begins (WFDF 12.1, 10.2-10.3).
    ///
    /// Three rules, each asserted by driving rather than by inspection:
    ///
    ///  - **the scoring team pulls next**, because it stays in the end zone it scored in;
    ///  - **so the teams swap the end they attack after every goal** — which is what makes
    ///    the previous rule geometry rather than convention, and it is asserted as the
    ///    direction actually flipping for both teams and staying opposite;
    ///  - **the ends swap once more at halftime** (10.3), and both teams get their timeouts
    ///    back for the second half.
    private static func thePointLifecycle() {
        let s = Stage { $0.halftimeAt = 2; $0.gameTo = 3 }
        let g = s.game
        g.startGame()

        var dirs: [[Dir]] = [[g.attackDir[0], g.attackDir[1]]]
        var pullers: [TeamId] = [g.pullingTeam]
        var points: [Int] = [g.point]
        var halves: [Int] = [g.half]

        Check.eq(
            g.attackDir[0], flipDir(g.attackDir[1]),
            "the two teams attack opposite ends, which is the whole geometry of the pitch")
        Check.eq(
            g.receivingTeam, otherTeam(g.pullingTeam), "and the team that does not pull receives")
        Check.eq(g.target, g.rules.gameTo, "the target starts at the game's length")

        var scorers: [TeamId] = []
        var guard_ = 0
        while g.phase != .gameOver && guard_ < 12 {
            guard_ += 1
            if g.phase == .halftime {
                let before = [g.attackDir[0], g.attackDir[1]]
                let timeoutsBefore = [
                    g.teamStats(0).timeoutsRemaining, g.teamStats(1).timeoutsRemaining,
                ]
                g.resumeFromHalftime()
                Check.eq(g.half, 2, "the second half begins")
                Check.eq(
                    g.attackDir[0], flipDir(before[0]),
                    "and the ends swap once more at halftime (WFDF 10.3)")
                Check.eq(
                    g.pullingTeam, g.openingPullTeam,
                    "the team that pulled to open the game pulls to open the second half")
                for t in 0..<2 {
                    Check.eq(
                        g.teamStats(t).timeoutsRemaining, g.rules.timeoutsPerHalf,
                        "team \(t) gets its timeouts back for the half")
                    Check.ok(
                        g.teamStats(t).timeoutsRemaining >= timeoutsBefore[t],
                        "which is never fewer than it had")
                }
                continue
            }
            guard g.phase == .prePull else {
                Check.ok(false, "unexpected phase \(g.phase.rawValue) between points")
                break
            }

            let scorer = scorePoint(g)
            scorers.append(scorer)
            let dirBefore = [g.attackDir[0], g.attackDir[1]]
            let scoreBefore = g.score
            let pointBefore = g.point

            g.advanceAfterScore()

            Check.eq(g.point, pointBefore + 1, "the point number advances")
            Check.eq(g.score, scoreBefore, "and advancing does not move the scoreboard")
            Check.eq(
                g.attackDir[0], flipDir(dirBefore[0]),
                "team 0 attacks the other end next point (WFDF 12.1)")
            Check.eq(
                g.attackDir[1], flipDir(dirBefore[1]), "and so does team 1")
            Check.eq(
                g.attackDir[0], flipDir(g.attackDir[1]),
                "they are still attacking opposite ends, which is the point of swapping both")
            if g.phase != .gameOver {
                Check.eq(
                    g.pullingTeam, scorer,
                    "the team that scored pulls the next point — it is standing in that end "
                        + "zone")
                Check.eq(g.receivingTeam, otherTeam(scorer), "and the other one receives")
            }
            dirs.append([g.attackDir[0], g.attackDir[1]])
            pullers.append(g.pullingTeam)
            points.append(g.point)
            halves.append(g.half)
        }

        Check.eq(g.phase, .gameOver, "a game to \(g.rules.gameTo) ends")
        Check.eq(
            max(g.score[0], g.score[1]), g.rules.gameTo, "when somebody reaches the target")
        Check.ok(halves.contains(2), "and the match went through a half")
        Check.ok(points.count >= 3, "over \(points.count) points")
        for i in 1..<points.count {
            Check.ok(points[i] > points[i - 1], "the point number never goes backwards")
            Check.ok(halves[i] >= halves[i - 1], "and neither does the half")
        }
        // Nothing restarts a finished game.
        let finalScore = g.score
        g.advanceAfterScore()
        g.resumeFromHalftime()
        g.step(60)
        Check.eq(g.phase, .gameOver, "and nothing restarts it")
        Check.eq(g.score, finalScore, "or moves the final score")
    }

    /// Score one point from `PRE_PULL`, returning the team that scored.
    @discardableResult
    private static func scorePoint(_ g: GameState) -> TeamId {
        let pulling = g.pullingTeam
        let receiving = otherTeam(pulling)
        g.pull(
            pulling * n, Vec3d(0, 1, field.goalLineZ(flipDir(g.attackDir[pulling]))),
            Vec3d(0, 8, 20))
        g.pullCaught(receiving * n, Vec3d(0, 1, -Double(g.attackDir[receiving]) * 10))
        g.release(playerId: receiving * n, pos: g.pivot, vel: Vec3d(0, 2, 12))
        g.catchDisc(
            receiving * n + 1, Vec3d(2, 1, Double(g.attackDir[receiving]) * (field.goalLine + 3)))
        return receiving
    }

    /// The caps, which are how a timed game ends (WFDF 10.4, USAU 9.C).
    ///
    /// A **soft cap** moves the target to the leader's score plus one and play carries
    /// straight on. A **hard cap** makes the point in progress the last one. The match clock
    /// brings each exactly once and the hard one subsumes the soft.
    ///
    /// `effectiveTarget` and `isGameOver` are `Rules.swift`'s and are swept there; what is
    /// asserted here is the machine's use of them — that the clock fires them, that they
    /// fire once, and that a hard-capped point really is the last one.
    private static func theCapsMoveTheTarget() {
        // Untimed is the default, and an untimed game never caps however long it runs.
        let plain = Stage()
        plain.game.startGame()
        plain.game.step(3600)
        Check.eq(plain.game.cap, .none, "with no clock set, no cap ever lands")
        Check.bitEq(DEFAULT_RULES.softCapAt, 0, "the soft cap is off by default (0 = no clock)")
        Check.bitEq(DEFAULT_RULES.hardCapAt, 0, "and so is the hard one")

        let s = Stage { $0.softCapAt = 4; $0.hardCapAt = 7 }
        let g = s.game
        g.startGame()
        var caps: [String] = []

        // Three seconds: nothing yet.
        g.step(1)
        g.step(1)
        g.step(1)
        Check.eq(g.cap, .none, "at 3 s neither cap has landed")
        Check.eq(g.target, g.rules.gameTo, "and the target is the game's own")

        // Score one, so the leader is not level when the soft cap lands.
        scorePoint(g)
        g.advanceAfterScore()
        let leader = max(g.score[0], g.score[1])
        Check.eq(leader, 1, "somebody leads by one")

        _ = s.drain()
        g.step(1.5)
        for e in s.drain() { if case .cap(let kind, _) = e { caps.append(kind) } }
        Check.eq(g.cap, .soft, "the soft cap lands when the clock passes it")
        Check.eq(g.target, leader + 1, "and the target becomes the leader plus one")
        Check.eq(caps, ["soft"], "announced once")

        // It does not land twice.
        g.step(1)
        for e in s.drain() { if case .cap(let kind, _) = e { caps.append(kind) } }
        Check.eq(caps, ["soft"], "and only once, however much more clock runs")

        g.step(1.5)
        for e in s.drain() { if case .cap(let kind, _) = e { caps.append(kind) } }
        Check.eq(g.cap, .hard, "the hard cap lands next")
        Check.eq(caps, ["soft", "hard"], "announced once, after the soft one")
        g.step(5)
        for e in s.drain() { if case .cap(let kind, _) = e { caps.append(kind) } }
        Check.eq(caps, ["soft", "hard"], "and does not land twice either")

        // The point in progress is the last one — *unless it leaves the scores level*,
        // which is the universe point every code of the sport plays out rather than
        // declaring a draw. Both halves of that are driven: a levelling goal plays on, and
        // the next goal, which cannot level anything, ends it.
        let leveller = scorePoint(g)
        g.advanceAfterScore()
        Check.eq(
            g.score[leveller], g.score[otherTeam(leveller)],
            "the hard-capped point ended level at \(g.score[0])-\(g.score[1])")
        Check.eq(
            g.phase, .prePull,
            "so play goes on — a hard cap does not end a match in a draw, it plays the "
                + "universe point")
        let winner = scorePoint(g)
        g.advanceAfterScore()
        Check.eq(g.phase, .gameOver, "and the next goal is the last one under a hard cap")
        Check.ok(
            g.score[winner] > g.score[otherTeam(winner)],
            "with whoever took it taking the match (\(g.score[0])-\(g.score[1]))")

        // A hard cap arriving on its own still applies the soft cap's target first — a horn
        // both teams missed leaves the same thing behind.
        let harsh = Stage { $0.hardCapAt = 2 }
        harsh.game.startGame()
        scorePoint(harsh.game)
        harsh.game.advanceAfterScore()
        harsh.game.step(2.5)
        Check.eq(harsh.game.cap, .hard, "a hard cap with no soft one still lands")
        Check.eq(
            harsh.game.target, max(harsh.game.score[0], harsh.game.score[1]) + 1,
            "and moves the target as the soft one would have")
    }

    /// The timeout budget: two per team per half, restored at halftime, and no borrowing.
    private static func theTimeoutBudget() {
        Check.eq(DEFAULT_RULES.timeoutsPerHalf, 2, "two timeouts a half (WFDF 19.1)")
        Check.bitEq(DEFAULT_RULES.timeoutDuration, 70, "of seventy seconds each (tuning)")

        let s = Stage()
        let g = s.game
        g.startGame()
        let team = g.pullingTeam
        Check.eq(
            g.teamStats(team).timeoutsRemaining, g.rules.timeoutsPerHalf, "a team starts with two")

        var taken = 0
        for i in 0..<5 {
            let r = g.callTimeout(team, nil)
            if r.ok {
                taken += 1
                Check.eq(g.phase, .timeout, "timeout \(i) stops play")
                g.endTimeout()
                Check.ok(g.phase != .timeout, "and ending it restarts")
            } else {
                Check.ok(
                    g.teamStats(team).timeoutsRemaining == 0,
                    "a timeout is only refused once there are none left")
            }
        }
        Check.eq(taken, g.rules.timeoutsPerHalf, "exactly two get taken")
        Check.eq(g.teamStats(team).timeoutsUsed, 2, "and both are counted as used")
        Check.eq(g.teamStats(team).timeoutsRemaining, 0, "with none remaining")
        Check.eq(
            g.teamStats(otherTeam(team)).timeoutsRemaining, g.rules.timeoutsPerHalf,
            "and the other team's are untouched — a budget is per team")

        // The clock ends one that nobody ends by hand.
        let auto = Stage()
        auto.game.startGame()
        auto.game.callTimeout(auto.game.pullingTeam, nil)
        Check.eq(auto.game.phase, .timeout, "a timeout is running")
        auto.game.step(auto.game.rules.timeoutDuration * 0.5)
        Check.eq(auto.game.phase, .timeout, "and is still running at half time")
        auto.game.step(auto.game.rules.timeoutDuration * 0.6)
        Check.ok(
            auto.game.phase != .timeout,
            "but the clock ends it after \(auto.game.rules.timeoutDuration)s, so a caller "
                + "who forgets does not hang the match")
    }

    // MARK: - the referee sweep

    /// **The laws of the machine, over tens of thousands of legal actions nobody chose.**
    ///
    /// A referee that looks at whatever phase the machine is in and picks, at random, one of
    /// the actions the rules allow from there — throw it, drop it, block it, stall it out,
    /// call a foul, take a timeout, score. Twenty seeds. After **every single action**, the
    /// invariants below are checked; none of them is a comparison against a recorded value,
    /// and every one of them is a sentence about Ultimate:
    ///
    ///  - a score only goes up, only by one, only for one team at a time, and only when a
    ///    goal is announced;
    ///  - **possession never crosses from one team to the other without a turnover or a
    ///    goal to explain it** — the law the brief names, and the one a trace can only
    ///    illustrate;
    ///  - a turnover names the team that lost it and the team that got it, and both teams'
    ///    books move by one;
    ///  - every phase change is announced exactly once, and the announcements chain: the
    ///    `from` of the first is the phase we were in, the `to` of the last is the phase we
    ///    are in;
    ///  - the count is only ever running in `LIVE_POSSESSION`, only ever rises on a step,
    ///    and is zero the moment the disc changes hands;
    ///  - the clock only moves on a step and never backwards.
    ///
    /// Then, at the end of each match, the box score is reconciled: team totals against the
    /// sum of their players', and every player's `attempts` against what became of each one.
    private static func theRefereeSweep() {
        var totalActions = 0
        var goals = 0
        var turnovers = 0
        var timeouts = 0
        var stallOuts = 0
        var opsSeen: Set<String> = []

        for seed in 0..<20 {
            let s = Stage { $0.gameTo = 4; $0.halftimeAt = 2 }
            let g = s.game
            g.startGame()
            _ = s.drain()
            var rng = Sample(0x9E37_79B9_7F4A_7C15 &* UInt64(seed &+ 1))
            var actions = 0

            var gained: [Int] = [0, 0]

            while g.phase != .gameOver && actions < 700 {
                let beforePhase = g.phase
                let beforeScore = g.score
                let beforePossession = g.possession
                let beforeStall = g.stallCount
                let beforeClock = g.clock
                let beforePoint = g.point
                let beforeTurns = [
                    g.teamStats(0).turnoversCommitted, g.teamStats(1).turnoversCommitted,
                ]
                let beforeForced = [
                    g.teamStats(0).turnoversForced, g.teamStats(1).turnoversForced,
                ]

                let op = referee(g, &rng)
                opsSeen.insert(op)
                actions += 1
                totalActions += 1
                let events = s.drain()
                let at = "s\(seed) #\(actions) \(beforePhase.rawValue)/\(op)"

                // --- the scoreboard
                let scored = events.compactMap { e -> TeamId? in
                    if case .score(let t, _, _, _, _, _) = e { return t }
                    return nil
                }
                for t in 0..<2 {
                    Check.ok(
                        g.score[t] >= beforeScore[t],
                        "\(at): team \(t)'s score never goes down")
                    Check.ok(
                        g.score[t] - beforeScore[t] <= 1,
                        "\(at): and never rises by more than one at a time")
                }
                let delta = (g.score[0] - beforeScore[0]) + (g.score[1] - beforeScore[1])
                Check.eq(
                    delta, scored.count,
                    "\(at): the scoreboard moves exactly when a goal is announced")
                if let t = scored.first {
                    Check.eq(g.score[t] - beforeScore[t], 1, "\(at): for the team that scored")
                    Check.eq(g.possession, t, "\(at): who keeps the disc until the next pull")
                    goals += 1
                }
                for t in 0..<2 {
                    Check.eq(
                        g.teamStats(t).score, g.score[t],
                        "\(at): the box score and the scoreboard agree for team \(t)")
                    Check.eq(
                        g.teamStats(t).goals, g.score[t],
                        "\(at): and a goal is a point, for team \(t)")
                }

                // --- possession
                let turns = events.compactMap { e -> (TeamId, TeamId)? in
                    if case .turnover(_, let from, let to, _, _, _, _, _) = e { return (from, to) }
                    return nil
                }
                if let before = beforePossession, let after = g.possession, before != after {
                    Check.ok(
                        !turns.isEmpty || !scored.isEmpty,
                        "\(at): possession went \(before) -> \(after) and something explained "
                            + "why (turnover or goal)")
                }
                for (from, to) in turns {
                    turnovers += 1
                    Check.ok(from != to, "\(at): a turnover has two different teams in it")
                    Check.eq(to, otherTeam(from), "\(at): and they are the only two teams")
                    Check.eq(
                        g.possession, to, "\(at): the team it went to is the team that has it")
                    Check.eq(
                        g.teamStats(from).turnoversCommitted, beforeTurns[from] + 1,
                        "\(at): charged to the team that lost it")
                    Check.eq(
                        g.teamStats(to).turnoversForced, beforeForced[to] + 1,
                        "\(at): and credited to the team that took it")
                }
                Check.eq(
                    g.teamStats(0).turnoversCommitted, g.teamStats(1).turnoversForced,
                    "\(at): every turnover one team commits is one the other forces")
                Check.eq(
                    g.teamStats(1).turnoversCommitted, g.teamStats(0).turnoversForced,
                    "\(at): and the other way round")

                if beforePossession != g.possession, let now = g.possession { gained[now] += 1 }

                // --- the phase, and what the renderer was told
                let changes = events.compactMap { e -> (Phase, Phase)? in
                    if case .stateChanged(let from, let to, _, _, _, _) = e { return (from, to) }
                    return nil
                }
                if changes.isEmpty {
                    Check.eq(g.phase, beforePhase, "\(at): no announcement, so no phase change")
                } else {
                    Check.eq(
                        changes.first?.0, beforePhase,
                        "\(at): the first announcement leaves the phase we were in")
                    Check.eq(
                        changes.last?.1, g.phase,
                        "\(at): and the last arrives at the one we are in")
                    for (i, c) in changes.enumerated() {
                        Check.ok(c.0 != c.1, "\(at): announcement \(i) is a real change")
                        if i > 0 {
                            Check.eq(
                                changes[i - 1].1, c.0,
                                "\(at): announcement \(i) starts where \(i - 1) ended")
                        }
                    }
                    Check.ok(
                        outgoing(beforePhase).contains(g.phase),
                        "\(at): \(beforePhase.rawValue) -> \(g.phase.rawValue) is an edge of "
                            + "the machine")
                }

                // --- the count
                Check.ok(
                    !g.stallRunning || g.phase == .livePossession,
                    "\(at): a count only ever runs during live possession")
                Check.inRange(
                    Double(g.stallCount), 0, Double(g.rules.stallMax),
                    "\(at): the count stays inside nought to ten")
                if g.stallCount > beforeStall {
                    Check.ok(
                        op == "step" || op == "check",
                        "\(at): the count only rises on the clock, or is restored by a "
                            + "check after a stoppage (WFDF 18.4)")
                    if op == "step" {
                        let ticks = events.filter {
                            if case .stallTick = $0 { return true } else { return false }
                        }
                        Check.eq(
                            ticks.count, g.stallCount - beforeStall,
                            "\(at): and every count the marker reaches is called out")
                    }
                }
                if let before = beforePossession, let after = g.possession, before != after {
                    Check.eq(g.stallCount, 0, "\(at): a new possession starts at nought")
                }

                // --- the clock and the point
                Check.ok(g.clock >= beforeClock, "\(at): the clock never runs backwards")
                if g.clock > beforeClock {
                    Check.eq(op, "step", "\(at): and only a step moves it")
                }
                Check.ok(g.point >= beforePoint, "\(at): the point number never goes backwards")
                Check.ok(g.half == 1 || g.half == 2, "\(at): there are two halves")
                Check.ok(g.target >= 1, "\(at): the target is a real target")

                if op == "callTimeout" { timeouts += 1 }
            }

            // A throw the action budget cut off mid-flight is still an attempt with no
            // outcome against it, which would read as a book-keeping failure and is not
            // one. Land it before reconciling.
            if g.phase == .discInFlight { g.ground(Vec3d(0, 0, 0)) }

            // --- the box score, once the match is over
            reconcile(g, "s\(seed)")
            stallOuts += g.teamStats(0).stallOuts + g.teamStats(1).stallOuts
            for t in 0..<2 {
                Check.ok(
                    g.teamStats(t).possessions <= gained[t],
                    "s\(seed): team \(t)'s possession count is not more than the times it "
                        + "actually gained the disc")
                Check.ok(
                    g.teamStats(t).timeOfPossession <= g.clock + 1e-9,
                    "s\(seed): team \(t) cannot have held the disc longer than the match")
            }
            Check.ok(
                g.teamStats(0).timeOfPossession + g.teamStats(1).timeOfPossession
                    <= g.clock + 1e-9,
                "s\(seed): and the two of them together cannot either")
        }

        // The sweep has to have actually been a game, or every law above held vacuously.
        Check.ok(totalActions > 3500, "the referee ran \(totalActions) actions")
        Check.ok(goals > 20, "and \(goals) goals were scored")
        Check.ok(turnovers > 100, "with \(turnovers) turnovers")
        Check.ok(timeouts > 0, "\(timeouts) timeouts were taken")
        Check.ok(stallOuts > 0, "and \(stallOuts) possessions were stalled out")
        // Every action the referee can pick must actually have been picked, or the sweep
        // is narrower than it reads.
        for op in [
            "pull", "pullCaught", "pullDropped", "pullLanded", "pullOutOfBounds", "pickUp",
            "check", "release", "catchDisc", "drop", "ground", "outOfBounds",
            "caughtOutOfBounds", "block", "callTimeout", "makeCall", "resolveCall", "step",
            "advanceAfterScore", "endTimeout", "resumeFromHalftime", "choosePullSpot",
        ] {
            Check.ok(opsSeen.contains(op), "the sweep exercised \(op)")
        }
    }

    /// One legal action, chosen from whatever phase the machine is in. Returns its name.
    ///
    /// Deliberately *only* legal actions: the refusals have their own exhaustive sweep, and
    /// mixing them in here would spend the fuzz's budget re-asserting that nothing happened.
    private static func referee(_ g: GameState, _ rng: inout Sample) -> String {
        let pulling = g.pullingTeam
        let receiving = otherTeam(pulling)
        let offence = g.possession ?? receiving
        let defence = otherTeam(offence)
        let dir = g.attackDir[offence]

        func spot() -> Vec3d {
            Vec3d(rng.unit(-field.sideline, field.sideline), 1, rng.unit(-30, 30))
        }
        func endzone() -> Vec3d {
            Vec3d(rng.unit(-8, 8), 1, Double(dir) * rng.unit(field.goalLine + 0.5, field.endLine))
        }

        switch g.phase {
        case .prePull:
            g.pull(
                pulling * n + rng.int(n),
                Vec3d(0, 1, field.goalLineZ(flipDir(g.attackDir[pulling]))), Vec3d(0, 8, 20))
            return "pull"

        case .pullInFlight:
            switch rng.int(10) {
            case 0:
                g.pullDropped(receiving * n + rng.int(n), spot())
                return "pullDropped"
            case 1:
                // A third of these leave the choice outstanding, which is the only way
                // `choosePullSpot` is ever reached as an action in its own right.
                let pick = rng.int(3)
                g.pullOutOfBounds(
                    Vec3d(field.sideline, 0, rng.unit(-20, 20)),
                    pick == 0 ? nil : (pick == 1 ? .brick : .sideline))
                return "pullOutOfBounds"
            case 2:
                g.pullLanded(spot())
                return "pullLanded"
            default:
                g.pullCaught(receiving * n + rng.int(n), spot())
                return "pullCaught"
            }

        case .livePossession:
            // A thrower who has already let the count reach three keeps holding it, so
            // possessions really do get stalled out rather than only theoretically. Without
            // this the count resets on a release long before ten and `stall-out` is a branch
            // the sweep never takes.
            if g.stallCount >= 3 {
                g.step(rng.unit(0.2, 1.6), mark(g, defence))
                return "step"
            }
            switch rng.int(16) {
            case 0...8:
                g.step(rng.unit(0.2, 1.6), mark(g, defence))
                return "step"
            case 9:
                g.callTimeout(offence, g.thrower)
                return "callTimeout"
            case 10:
                g.makeCall(
                    rng.bool() ? .foul : .pick, offence * n + rng.int(n),
                    defence * n + rng.int(n), nil)
                return "makeCall"
            default:
                g.release(playerId: g.thrower, pos: g.pivot, vel: Vec3d(0, 2, 12))
                return "release"
            }

        case .discInFlight:
            switch rng.int(14) {
            case 0:
                g.drop(offence * n + rng.int(n), spot())
                return "drop"
            case 1:
                g.ground(spot())
                return "ground"
            case 2:
                g.outOfBounds(Vec3d(field.sideline, 0, rng.unit(-20, 20)))
                return "outOfBounds"
            case 3:
                g.caughtOutOfBounds(
                    offence * n + rng.int(n), Vec3d(field.sideline + 3, 1, rng.unit(-20, 20)))
                return "caughtOutOfBounds"
            case 4:
                g.block(defence * n + rng.int(n), spot())
                return "block"
            case 5:
                g.catchDisc(defence * n + rng.int(n), spot())
                return "catchDisc"
            case 6...8:
                g.catchDisc(offence * n + rng.int(n), endzone())
                return "catchDisc"
            default:
                g.catchDisc(offence * n + rng.int(n), Vec3d(rng.unit(-8, 8), 1, rng.unit(-20, 20)))
                return "catchDisc"
            }

        case .turnoverDead:
            if g.awaitingPullChoice() {
                g.choosePullSpot(rng.bool() ? .brick : .sideline)
                return "choosePullSpot"
            }
            g.pickUp((g.possession ?? offence) * n + rng.int(n), nil)
            return "pickUp"

        case .check:
            if g.pendingCall != nil, rng.bool() {
                g.resolveCall(rng.bool(), receiverId: offence * n + rng.int(n))
                return "resolveCall"
            }
            g.check()
            return "check"

        case .pointScored:
            g.advanceAfterScore()
            return "advanceAfterScore"

        case .timeout:
            g.endTimeout()
            return "endTimeout"

        case .halftime:
            g.resumeFromHalftime()
            return "resumeFromHalftime"

        case .gameOver:
            return "gameOver"
        }
    }

    /// A legal mark on the thrower, so the count runs during the sweep's `step`s.
    private static func mark(_ g: GameState, _ defence: TeamId) -> FrameObservation {
        var obs = FrameObservation()
        obs.throwerPos = g.pivot
        obs.markerId = .value(defence * n)
        obs.markerPos = .value(Vec3d(g.pivot.x + 1.2, 0, g.pivot.z + 0.4))
        return obs
    }

    /// **The box score has to add up.** Team totals against their players', and every
    /// player's throwing line against what became of each throw.
    ///
    /// This is the class of failure a snapshot cannot see and a final-totals fixture can
    /// only see for the one trace it recorded: a path that increments the player's counter
    /// and forgets the team's, or the other way round, is invisible in every state the
    /// machine passes through and shows up only as two numbers that should have been the
    /// same.
    private static func reconcile(_ g: GameState, _ at: String) {
        let players = g.allPlayers()
        Check.ok(!players.isEmpty, "\(at): there are players to reconcile")

        for t in 0..<2 {
            let mine = players.filter { $0.team == t }
            let team = g.teamStats(t)
            func sum(_ f: (PlayerStats) -> Int) -> Int { mine.reduce(0) { $0 + f($1) } }
            func sumD(_ f: (PlayerStats) -> Double) -> Double { mine.reduce(0) { $0 + f($1) } }

            Check.eq(sum(\.goals), team.goals, "\(at)/team \(t): goals add up")
            Check.eq(sum(\.assists), team.assists, "\(at)/team \(t): assists add up")
            Check.eq(sum(\.blocks), team.blocks, "\(at)/team \(t): blocks add up")
            Check.eq(sum(\.attempts), team.attempts, "\(at)/team \(t): attempts add up")
            Check.eq(sum(\.completions), team.completions, "\(at)/team \(t): completions add up")
            Check.eq(sum(\.throwaways), team.throwaways, "\(at)/team \(t): throwaways add up")
            Check.eq(sum(\.drops), team.drops, "\(at)/team \(t): drops add up")
            Check.eq(sum(\.stallOuts), team.stallOuts, "\(at)/team \(t): stall-outs add up")
            Check.eq(sum(\.pulls), team.pulls, "\(at)/team \(t): pulls add up")
            Check.near(
                sumD(\.yardsThrown), team.yardsThrown, 1e-9,
                "\(at)/team \(t): thrown yardage adds up")
            Check.near(
                sumD(\.yardsReceived), team.yardsReceived, 1e-9,
                "\(at)/team \(t): received yardage adds up")

            // A goal is worth a point and nothing else is.
            Check.eq(team.goals, team.score, "\(at)/team \(t): every goal is a point")
            Check.eq(
                team.holds + team.breaks, team.goals,
                "\(at)/team \(t): every goal is either a hold or a break")
            Check.ok(
                team.assists <= team.goals,
                "\(at)/team \(t): no goal has more than one assist on it")
            Check.ok(
                team.completions <= team.attempts,
                "\(at)/team \(t): a completion is an attempt that arrived")
            Check.ok(
                team.timeoutsUsed + team.timeoutsRemaining >= 0,
                "\(at)/team \(t): the timeout budget is a number")
        }

        for p in players {
            let at = "\(at)/#\(p.id)"
            Check.eq(
                p.attempts, p.completions + p.throwaways + p.throwsDropped,
                "\(at): every throw was completed, thrown away, or dropped by the receiver")
            Check.ok(
                p.blockedThrows <= p.throwaways,
                "\(at): a blocked throw is a kind of throwaway")
            Check.ok(p.goals <= p.catches, "\(at): a goal is a catch")
            // A goal is the one catch that does not become a possession — the point is
            // over, so `gainPossession` never runs and no touch is recorded. Every other
            // catch does, and so does every pickup and every D.
            Check.ok(
                p.catches <= p.touches + p.goals,
                "\(at): every catch but a scoring one is also a touch")
            Check.ok(p.goals >= 0 && p.attempts >= 0, "\(at): no counter went negative")
        }
    }

    // MARK: - minis

    /// Minis is a Swift-side format with no rulebook of its own, so it is checked as
    /// properties of the geometry and of the machine actually running on it.
    ///
    /// The identities are the ones a hand-entered preset gets wrong, and the reason they are
    /// worth restating here rather than leaving to `RulesTests` is that this is the *default
    /// format of the game*: every one of them being right at sevens says nothing about the
    /// pitch most matches are played on.
    private static func minis() {
        let f = FieldConstants.minis

        Check.bitEq(f.centralLength, f.length - 2 * f.endzoneDepth, "minis: central length closes")
        Check.bitEq(f.goalLine, f.centralLength / 2, "minis: goal line is half the central length")
        Check.bitEq(f.endLine, f.length / 2, "minis: end line is half the length")
        Check.bitEq(f.sideline, f.width / 2, "minis: sideline is half the width")

        let full = FieldConstants.standard
        Check.bitEq(f.length, full.width, "minis is as long as a regulation field is wide")
        Check.bitEq(f.width, full.endzoneDepth, "minis is as wide as an endzone is deep")

        Check.bitEq(f.brickIn, f.endzoneDepth, "minis: the brick is one endzone-depth in")
        Check.bitEq(f.brickZ, f.goalLine - f.brickIn, "minis: brickZ follows from brickIn")
        Check.bitEq(
            full.brickZ, full.goalLine - full.brickIn,
            "the regulation brick satisfies the same identity")

        var opts = GameStateOptions()
        opts.format = .minis
        let game = GameState(opts)
        Check.eq(game.format.playersPerSide, 3, "a minis game is three a side")

        game.startGame()
        game.setLine(0, [0, 1, 2, 3, 4, 5, 6])
        Check.eq(
            game.lines[0].count, 3,
            "the line comes from the format, not from a literal seven")
        Check.eq(game.snapshot().phase, .prePull, "a minis game starts before the pull")

        Check.ok(
            !game.format.field.isInBounds(Vec3d(0, 0, 25)),
            "z=25 is off the end of a minis pitch (it is in bounds on a regulation field)")
        Check.ok(
            FieldConstants.standard.endLine > 25,
            "and that same point really is in bounds under regulation geometry")
        Check.ok(game.format.field.isInBounds(Vec3d(0, 0, 10)), "z=10 is on the minis pitch")
        Check.ok(!game.format.field.isInBounds(Vec3d(10, 0, 0)), "x=10 is over a minis sideline")

        // …and a whole minis point plays, on the minis geometry rather than the global.
        let m = Stage(format: .minis)
        let g = m.game
        g.startGame()
        let scorer = scorePointMinis(g)
        Check.eq(g.phase, .pointScored, "a minis point can be scored")
        Check.eq(g.score[scorer], 1, "by the team that caught it in the end zone")
        g.advanceAfterScore()
        Check.eq(g.pullingTeam, scorer, "and the scorer pulls the next one")
        reconcile(g, "minis")
    }

    /// One minis point, from pull to goal, at three a side.
    @discardableResult
    private static func scorePointMinis(_ g: GameState) -> TeamId {
        let k = GameFormat.minis.playersPerSide
        let f = FieldConstants.minis
        let pulling = g.pullingTeam
        let receiving = otherTeam(pulling)
        g.pull(pulling * k, Vec3d(0, 1, f.goalLineZ(flipDir(g.attackDir[pulling]))), Vec3d(0, 6, 12))
        g.pullCaught(receiving * k, Vec3d(0, 1, -Double(g.attackDir[receiving]) * 4))
        g.release(playerId: receiving * k, pos: g.pivot, vel: Vec3d(0, 2, 10))
        g.catchDisc(
            receiving * k + 1, Vec3d(1, 1, Double(g.attackDir[receiving]) * (f.goalLine + 2)))
        return receiving
    }
}
