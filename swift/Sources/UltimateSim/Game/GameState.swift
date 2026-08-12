import Foundation

/// ULTIMATE — the game state machine.
///
/// A deterministic, event-driven rules engine. It owns the phase machine, possession,
/// the stall count, scoring, halftime/caps, timeouts, self-officiated calls, and a full
/// box score. Ported from `src/sim/GameState.ts`.
///
/// It is deliberately decoupled from the renderer and the physics:
///   - physics/AI call the *report* methods (`pull`, `release`, `catchDisc`, `drop`,
///     `ground`, `outOfBounds`, `block`, …) when something happens;
///   - `step(dt, obs)` is driven at a fixed 1/120 s and runs the clocks;
///   - everything it decides comes back out as a `GameEvent`.
///
/// No RNG, no wall clock, no renderer. Construct it with a plain emitter:
///
/// ```swift
/// var log: [GameEvent] = []
/// let gs = GameState(GameStateOptions(emit: { log.append($0) }, format: .minis))
/// gs.startGame()
/// gs.pull(7, Vec3d(0, 1, 12.5))
/// ```
///
/// **The reference is 7v7-on-a-regulation-field throughout and this is not.** It
/// imports `FIELD` as a module constant and writes `7` literally in `defaultRoster()`,
/// in the constructor's `.slice(0, 7)` and in `setLine()`'s. Both assumptions are
/// parameters here, carried in `format` — see `GameFormat` for why and for what the
/// minis pitch works out to.
public final class GameState {
    public let rules: RuleSet
    /// The pitch and the roster size. Not in the reference — see `GameFormat`.
    public let format: GameFormat

    /// How long a double team must stand before the thrower is deemed to have called
    /// it (USAU 16.G is a call, not an automatic stoppage).
    private static let doubleTeamCall = 0.6

    // MARK: - phase / clocks

    public private(set) var phase: Phase = .prePull
    /// Sim seconds since `startGame()`.
    public private(set) var clock = 0.0
    /// Seconds in the current phase.
    public private(set) var phaseTimer = 0.0
    /// Points completed + 1 (1-based).
    public private(set) var point = 1
    /// 1 or 2.
    public private(set) var half = 1
    public private(set) var cap: CapState = .none
    /// Score a team must reach right now (moves under a cap).
    public private(set) var target: Int

    // MARK: - score / sides

    public private(set) var score: [Int] = [0, 0]
    public private(set) var attackDir: [Dir]
    public private(set) var pullingTeam: TeamId
    public private(set) var receivingTeam: TeamId
    public let openingPullTeam: TeamId

    // MARK: - possession

    public private(set) var possession: TeamId?
    public private(set) var thrower: PlayerId?
    /// Established pivot (where the next throw is measured from).
    public private(set) var pivot = Vec3d()
    public private(set) var discPos = Vec3d()

    // MARK: - stall

    public private(set) var stallCount = 0
    public private(set) var stallElapsed = 0.0
    public private(set) var stallRunning = false
    public private(set) var marker: PlayerId?
    public private(set) var markerState: MarkerStatus = .legal
    /// Seconds the current double team has stood; see the note in `observe`.
    private var doubleTeamHeld = 0.0
    private var doubleTeamCalled = false
    /// The dt of the step `observe` is running inside.
    ///
    /// The reference's comment says "0 when called standalone", but nothing ever resets
    /// it: `step` assigns it and `observe` only reads it. A standalone `observe()` after
    /// a step therefore charges the double-team hold the *previous* step's dt, and the
    /// documented 0 only holds before the first step. Ported as written rather than as
    /// documented, because the sim is driven by `step(dt:obs:)` and changing it would
    /// change how quickly a double team is called in every run that mixes the two entry
    /// points.
    private var observeDt = 0.0

    // MARK: - dead disc / restarts

    public private(set) var deadReason: DeadReason?
    /// Set while a pull is out of bounds and the receiver has not chosen yet.
    public private(set) var pullOobCrossing: Vec3d?
    /// Stall count to restore when play restarts from a CHECK.
    public private(set) var pendingStallResume = 0
    /// Phase to return to when a TIMEOUT/CHECK ends.
    public private(set) var resumeAfterStoppage: Phase = .livePossession
    public private(set) var pendingCall: PendingCall?
    /// Team that called the timeout currently in progress.
    public private(set) var timeoutTeam: TeamId?

    // MARK: - rosters

    /// The reference's `players` is a JS `Map`, which is insertion-ordered, and
    /// `allPlayers()` and `boxScore()` both depend on that order. A Swift `Dictionary`
    /// is not ordered, so the order is kept alongside rather than left to the hash.
    private var playersById: [PlayerId: PlayerStats] = [:]
    private var playerOrder: [PlayerId] = []
    public private(set) var teams: [TeamStats]
    public private(set) var lines: [[PlayerId]]

    // MARK: - per-throw bookkeeping

    private var throwOrigin = Vec3d()
    private var throwerOfPass: PlayerId?
    /// Chain of players who have touched the disc this possession.
    private var chain: [PlayerId] = []
    /// Payload of the most recent goal — for the HUD, replays and test harnesses.
    public private(set) var lastScore: ScoreRecord?
    private var lastScoringTeam: TeamId?
    private var pointReceivingTeam: TeamId = 0
    /// The team that received the pull this point, so a goal for them is a hold and a goal
    /// against them is a break. Read-only to the outside: it is set by `beginPoint` and by
    /// nobody else, and a caller that could write it could rewrite the hold/break column.
    public var pointReceiver: TeamId { pointReceivingTeam }
    private var travelFlagged = false
    private var hardCapPointIsLast = false

    // MARK: - io

    private let emitFn: (GameEvent) -> Void
    private let onLog: ((PlayLogEntry) -> Void)?
    private var logBuf: [PlayLogEntry] = []
    private let maxLog: Int

    public init(_ opts: GameStateOptions = GameStateOptions()) {
        rules = makeRules(opts.rules)
        format = opts.format
        maxLog = opts.maxLog ?? 4096
        onLog = opts.onLog
        emitFn = opts.emit ?? { _ in }

        let setup = opts.teams ?? (TeamSetup(), TeamSetup())
        let names = [setup.0.name ?? "HOME", setup.1.name ?? "AWAY"]
        teams = [
            TeamStats(team: 0, name: names[0], timeouts: rules.timeoutsPerHalf),
            TeamStats(team: 1, name: names[1], timeouts: rules.timeoutsPerHalf),
        ]

        lines = [[], []]
        for t in 0...1 {
            let roster =
                (t == 0 ? setup.0.players : setup.1.players)
                ?? GameState.defaultRoster(t, format.playersPerSide)
            for p in roster {
                let name = p.name ?? "\(names[t]) \(p.number ?? p.id)"
                playersById[p.id] = PlayerStats(id: p.id, team: t, name: name)
                playerOrder.append(p.id)
                lines[t].append(p.id)
            }
            // The reference slices to a literal 7 here; the line size is the format's.
            lines[t] = Array(lines[t].prefix(format.playersPerSide))
        }

        let d0: Dir = opts.startingDirTeam0 ?? 1
        attackDir = [d0, flipDir(d0)]
        openingPullTeam = opts.startingPullTeam ?? 1
        pullingTeam = openingPullTeam
        receivingTeam = otherTeam(pullingTeam)
        pointReceivingTeam = receivingTeam
        target = rules.gameTo
    }

    // MARK: - lifecycle

    /// Reset clocks and open the first point. Safe to call once.
    public func startGame() {
        clock = 0
        point = 1
        half = 1
        beginPoint()
        log(
            "Game on. \(teams[pullingTeam].name) pulls to \(teams[receivingTeam].name). "
                + "\(teams[0].name) attacks \(attackDir[0] > 0 ? "+Z" : "-Z").")
    }

    /// Declare the line on the field for a team (affects `pointsPlayed` only).
    public func setLine(_ team: TeamId, _ ids: [PlayerId]) {
        lines[team] = Array(
            ids.filter { playersById[$0]?.team == team }.prefix(format.playersPerSide))
    }

    // MARK: - step

    /// Advance the simulation. Designed for a fixed dt of 1/120 s; any dt works.
    /// `obs` is optional live positional data — supply it and the stall count will
    /// respect marker range and disc space, and travels will be flagged.
    public func step(_ dt: Double, _ obs: FrameObservation? = nil) {
        if dt <= 0 { return }
        // `observe` is also a public entry point on its own, so the step it belongs to
        // is handed over rather than assumed.
        observeDt = dt
        if let obs { observe(obs) }
        if phase == .gameOver { return }

        clock += dt
        phaseTimer += dt
        tickCaps()

        switch phase {
        case .livePossession:
            if let possession { teams[possession].timeOfPossession += dt }
            if let thrower { withPlayer(thrower) { $0.timeOfPossession += dt } }
            tickStall(dt)
        case .discInFlight:
            if let possession { teams[possession].timeOfPossession += dt }
        case .pointScored:
            if phaseTimer >= rules.postScoreDelay { advanceAfterScore() }
        case .timeout:
            if phaseTimer >= rules.timeoutDuration { endTimeout() }
        case .halftime:
            if phaseTimer >= rules.halftimeDuration { resumeFromHalftime() }
        default:
            break
        }
    }

    /// Feed live positions without advancing the clock.
    public func observe(_ obs: FrameObservation) {
        if let discPos = obs.discPos { self.discPos = discPos }

        switch obs.markerId {
        case .unreported: break
        case .null: marker = nil
        case .value(let id): marker = id
        }
        let ref = obs.throwerPos ?? pivot

        if case .null = obs.markerId {
            markerState = .none
        } else if case .unreported = obs.markerPos {
            // Nothing said about the mark this frame: leave markerState alone.
        } else {
            let markerPos = obs.markerPos.unwrapped
            markerState = markerStatus(markerPos, ref, rules)
            if markerState == .discSpace {
                emit(
                    .violation(
                        .discSpace(
                            markerId: marker,
                            dist: markerPos.map { distXZ($0, ref) } ?? 0)))
            }
            // USAU 16.G. A double team is a MARKING VIOLATION, so it is handled the way
            // disc space is handled two lines up: the count does not run while it
            // stands. It is checked only when the mark is otherwise legal, because a
            // marker who is already out of range or inside disc space has stopped the
            // count for a reason that is nearer the disc and easier to read.
            if markerState == .legal, let defenders = obs.defenders, let offence = obs.offence {
                let off = doubleTeamOffender(
                    pivot, marker,
                    defenders.map { RulesActor(id: $0.id, pos: $0.pos) },
                    offence.map { RulesActor(id: $0.id, pos: $0.pos) },
                    thrower, rules)
                // IT HAS TO PERSIST BEFORE IT COUNTS, because in the rules it is a call
                // the THROWER makes — he has to see it and say it — and a body that
                // clips the bubble for a tenth of a second is not something anyone
                // calls.
                //
                // Enforcing it frame-by-frame instead was tried and measured: it fired
                // on 3-6% of held frames and stopped the count often enough that a
                // count never reached ten, one sweep seed finished a seven-minute match
                // 0-0, and every downstream shape metric moved. Most of those frames
                // were transients — a marker swap mid-pivot, or the rules layer naming
                // the nearest defender as the marker while the AI still had the
                // matchup-derived one, so the two disagreed about which body was
                // entitled to be there and each flagged the other.
                //
                // The hold time is what a call costs. Sustained double teams still stop
                // the count; brushes past the bubble no longer do.
                if let off {
                    doubleTeamHeld += observeDt
                    if doubleTeamHeld >= GameState.doubleTeamCall {
                        markerState = .doubleTeam
                        if !doubleTeamCalled {
                            doubleTeamCalled = true
                            emit(.violation(.doubleTeam(markerId: marker, playerId: off)))
                        }
                    }
                } else {
                    doubleTeamHeld = 0
                    doubleTeamCalled = false
                }
            } else {
                doubleTeamHeld = 0
                doubleTeamCalled = false
            }
        }

        if let foot = obs.pivotFoot, phase == .livePossession, let thrower {
            let travelling = isTravel(pivot, foot, rules)
            if travelling && !travelFlagged {
                travelFlagged = true
                withPlayer(thrower) { $0.travels += 1 }
                emit(.violation(.travel(playerId: thrower, pivot: pivot, foot: foot)))
                log("\(name(thrower)) travels (pivot slipped \(fixed(distXZ(pivot, foot), 2)) m).")
            } else if !travelling {
                travelFlagged = false
            }
        }
    }

    private func tickStall(_ dt: Double) {
        if !stallRunning { return }
        if markerState != .legal { return }  // no legal mark => the count does not run

        stallElapsed += dt
        let want = stallCountFor(stallElapsed, rules)
        while stallCount < want {
            stallCount += 1
            emit(
                .stallTick(
                    count: stallCount, max: rules.stallMax, playerId: thrower, team: possession,
                    markerId: marker))
            if stallCount >= rules.stallMax {
                stallOut()
                return
            }
        }
    }

    // MARK: - pull

    /// The pulling team releases the pull. Legal only from PRE_PULL.
    @discardableResult
    public func pull(_ pullerId: PlayerId, _ from: Vec3d, _ vel: Vec3d? = nil) -> ActionResult {
        if phase != .prePull { return reject("pull() in \(phase.rawValue)") }
        guard let p = playersById[pullerId] else {
            return reject("pull() by unknown player \(pullerId)")
        }
        if p.team != pullingTeam {
            return reject("pull() by \(name(pullerId)) who is not on the pulling team")
        }

        withPlayer(pullerId) { $0.pulls += 1 }
        teams[pullingTeam].pulls += 1
        discPos = from
        setPhase(.pullInFlight)
        emit(.pull(team: pullingTeam, playerId: pullerId, from: from, vel: vel))
        if rules.emitPhysicsEvents {
            emit(
                .discReleased(
                    pos: from, vel: vel ?? Vec3d(), spin: 0, throwType: "pull", playerId: pullerId,
                    team: pullingTeam, stall: nil))
        }
        log("\(name(pullerId)) pulls from z=\(fixed(from.z, 1)).")
        return ActionResult(ok: true)
    }

    /// Receiving team catches the pull cleanly — play is live immediately.
    @discardableResult
    public func pullCaught(_ playerId: PlayerId, _ at: Vec3d) -> ActionResult {
        if phase != .pullInFlight { return reject("pullCaught() in \(phase.rawValue)") }
        guard let p = playersById[playerId] else {
            return reject("pullCaught() unknown player \(playerId)")
        }
        if rules.emitPhysicsEvents {
            emit(.discCaught(playerId: playerId, pos: at, team: p.team, outcome: "pull"))
        }
        if p.team == pullingTeam {
            // The pulling team may not catch its own pull; treat as a dead disc for the
            // receivers.
            log("\(name(playerId)) touched their own pull — disc to \(teams[receivingTeam].name).")
            deadDisc(receivingTeam, at, .pullLanded)
            return ActionResult(ok: true)
        }
        gainPossession(p.team, playerId, at, live: true, walk: false)
        log("\(name(playerId)) catches the pull at z=\(fixed(at.z, 1)).")
        return ActionResult(ok: true)
    }

    /// Receiving team touched the pull and failed to catch it — turnover (WFDF 12.5).
    @discardableResult
    public func pullDropped(_ playerId: PlayerId, _ at: Vec3d) -> ActionResult {
        if phase != .pullInFlight { return reject("pullDropped() in \(phase.rawValue)") }
        guard let p = playersById[playerId] else {
            return reject("pullDropped() unknown player \(playerId)")
        }
        withPlayer(playerId) {
            $0.drops += 1
            $0.plusMinus = computePlusMinus($0)
        }
        teams[p.team].drops += 1
        if rules.emitPhysicsEvents { emit(.discGrounded(pos: at, reason: "pull-drop")) }
        registerTurnover(.pullDrop, p.team, otherTeam(p.team), playerId, at)
        deadDisc(otherTeam(p.team), at, .pullDropped)
        log("\(name(playerId)) drops the pull! Turnover.")
        return ActionResult(ok: true)
    }

    /// The pull lands in bounds untouched and comes to rest.
    @discardableResult
    public func pullLanded(_ at: Vec3d) -> ActionResult {
        if phase != .pullInFlight { return reject("pullLanded() in \(phase.rawValue)") }
        if rules.emitPhysicsEvents { emit(.discGrounded(pos: at, reason: "pull")) }
        deadDisc(receivingTeam, at, .pullLanded)
        log("Pull lands at z=\(fixed(at.z, 1)); \(teams[receivingTeam].name) to pick it up.")
        return ActionResult(ok: true)
    }

    /// The pull first contacts the ground out of bounds. The receiving team may take it
    /// at the brick mark or at the point on the perimeter where it crossed (WFDF 12.4).
    /// Pass the choice, or call `choosePullSpot()` later.
    @discardableResult
    public func pullOutOfBounds(_ crossing: Vec3d, _ choice: PullSpotChoice? = nil) -> ActionResult
    {
        if phase != .pullInFlight { return reject("pullOutOfBounds() in \(phase.rawValue)") }
        if rules.emitPhysicsEvents { emit(.discGrounded(pos: crossing, reason: "pull-oob")) }
        pullOobCrossing = format.field.clampToField(crossing)
        setPhase(.turnoverDead)
        deadReason = .pullOutOfBounds
        possession = nil
        log("Pull sails out of bounds — \(teams[receivingTeam].name) choose brick or sideline.")
        if let choice { choosePullSpot(choice) }
        return ActionResult(ok: true)
    }

    /// True while an out-of-bounds pull is waiting on brick-or-sideline.
    public func awaitingPullChoice() -> Bool { pullOobCrossing != nil }

    /// Resolve an out-of-bounds pull. Defaults to the brick mark.
    @discardableResult
    public func choosePullSpot(_ choice: PullSpotChoice = .brick) -> ActionResult {
        guard let crossing = pullOobCrossing else {
            return reject("choosePullSpot() with no OB pull pending")
        }
        let dir = attackDir[receivingTeam]
        let spot = choice == .brick ? format.field.brickMark(dir) : crossing
        pullOobCrossing = nil
        deadDisc(receivingTeam, spot, .pullOutOfBounds)
        log(
            "\(teams[receivingTeam].name) take it at the \(choice.rawValue) "
                + "(x=\(fixed(spot.x, 1)), z=\(fixed(spot.z, 1))).")
        return ActionResult(ok: true)
    }

    // MARK: - live play

    /// Pick a dead disc up and establish a pivot. Goes to CHECK when required.
    @discardableResult
    public func pickUp(_ playerId: PlayerId, _ at: Vec3d? = nil) -> ActionResult {
        if phase != .turnoverDead { return reject("pickUp() in \(phase.rawValue)") }
        guard let p = playersById[playerId] else {
            return reject("pickUp() unknown player \(playerId)")
        }
        if let possession, p.team != possession {
            return reject(
                "pickUp() by \(name(playerId)) — disc belongs to \(teams[possession].name)")
        }
        let team = p.team
        if awaitingPullChoice() { return reject("pickUp() before the OB pull spot has been chosen") }
        let spot = at ?? discPos
        // A turnover restarts with a check; a pull is live as soon as it is picked up.
        let needsCheck = deadReason == .turnover
        gainPossession(team, playerId, spot, live: !needsCheck, walk: true)
        if needsCheck {
            pendingStallResume = 0
            setPhase(.check)
            resumeAfterStoppage = .livePossession
            log(
                "\(name(playerId)) picks up at (x=\(fixed(pivot.x, 1)), z=\(fixed(pivot.z, 1))) "
                    + "— check.")
        } else {
            log(
                "\(name(playerId)) picks up at (x=\(fixed(pivot.x, 1)), z=\(fixed(pivot.z, 1))) "
                    + "— live.")
        }
        return ActionResult(ok: true)
    }

    /// Defence taps the disc in; play restarts.
    @discardableResult
    public func check() -> ActionResult {
        if phase != .check { return reject("check() in \(phase.rawValue)") }
        stallCount = pendingStallResume
        stallElapsed = stallElapsedFor(stallCount, rules)
        stallRunning = true
        pendingCall = nil
        deadReason = nil
        setPhase(.livePossession)
        log("Disc is in. Stall resumes at \(stallCount).")
        return ActionResult(ok: true)
    }

    /// Move the established pivot (e.g. after a walk-up or an uncontested travel).
    public func setPivot(_ at: Vec3d) {
        pivot = format.field.clampToField(at)
        travelFlagged = false
    }

    /// A throw leaves the hand.
    @discardableResult
    public func release(
        playerId: PlayerId? = nil, pos: Vec3d? = nil, vel: Vec3d? = nil, spin: Double? = nil,
        throwType: String? = nil
    ) -> ActionResult {
        if phase != .livePossession { return reject("release() in \(phase.rawValue)") }
        guard let id = playerId ?? thrower else { return reject("release() with no thrower") }
        guard let p = playersById[id] else { return reject("release() unknown player \(id)") }

        throwerOfPass = id
        throwOrigin = pos ?? pivot
        withPlayer(id) { $0.attempts += 1 }
        teams[p.team].attempts += 1
        stallRunning = false
        travelFlagged = false
        setPhase(.discInFlight)
        if rules.emitPhysicsEvents {
            emit(
                .discReleased(
                    pos: throwOrigin, vel: vel ?? Vec3d(), spin: spin ?? 0,
                    throwType: throwType ?? "throw", playerId: id, team: p.team, stall: stallCount))
        }
        return ActionResult(ok: true)
    }

    /// A player catches the disc. Routes to completion / goal / interception /
    /// caught-out-of-bounds, and to `pullCaught()` during a pull.
    @discardableResult
    public func catchDisc(_ playerId: PlayerId, _ at: Vec3d) -> ActionResult {
        if phase == .pullInFlight { return pullCaught(playerId, at) }
        if phase != .discInFlight { return reject("catchDisc() in \(phase.rawValue)") }
        guard let p = playersById[playerId] else {
            return reject("catchDisc() unknown player \(playerId)")
        }

        let thrower = throwerOfPass
        let offense = possession

        if p.team != offense {
            // Interception — a catch block.
            if rules.emitPhysicsEvents {
                emit(
                    .discCaught(
                        playerId: playerId, pos: at, team: p.team, outcome: "interception"))
            }
            withPlayer(playerId) { $0.blocks += 1 }
            teams[p.team].blocks += 1
            if let thrower {
                var throwerTeam: TeamId = 0
                withPlayer(thrower) {
                    $0.throwaways += 1
                    $0.blockedThrows += 1
                    $0.plusMinus = computePlusMinus($0)
                    throwerTeam = $0.team
                }
                teams[throwerTeam].throwaways += 1
            }
            withPlayer(playerId) { $0.plusMinus = computePlusMinus($0) }
            registerTurnover(.interception, offense ?? otherTeam(p.team), p.team, playerId, at)
            if !format.field.isInBounds(at) {
                // Intercepted out of bounds: dead, back to the throwing team's opponents
                // at the line.
                deadDisc(p.team, format.field.clampToField(at), .turnover)
            } else {
                gainPossession(p.team, playerId, at, live: true, walk: true)
            }
            log("\(name(playerId)) intercepts! \(teams[p.team].name) possession.")
            return ActionResult(ok: true)
        }

        // Own team.
        if !format.field.isInBounds(at) { return caughtOutOfBounds(playerId, at) }

        let dir = attackDir[p.team]
        let goal = format.field.isGoal(at, dir)
        if rules.emitPhysicsEvents {
            emit(
                .discCaught(
                    playerId: playerId, pos: at, team: p.team,
                    outcome: goal ? "goal" : "completion"))
        }
        creditCompletion(thrower, playerId, at)

        if goal {
            scoreGoal(playerId, thrower, at)
            return ActionResult(ok: true)
        }

        gainPossession(p.team, playerId, at, live: true, walk: false, keepChain: true)
        log(
            "\(thrower.map(name) ?? "?") → \(name(playerId)) "
                + "(\(fixed(downfield(throwOrigin, at, dir), 1)) m) at z=\(fixed(at.z, 1)).")
        return ActionResult(ok: true)
    }

    /// A receiver gets two hands on it and puts it down. Turnover.
    @discardableResult
    public func drop(_ playerId: PlayerId, _ at: Vec3d) -> ActionResult {
        if phase == .pullInFlight { return pullDropped(playerId, at) }
        if phase != .discInFlight { return reject("drop() in \(phase.rawValue)") }
        guard let p = playersById[playerId] else {
            return reject("drop() unknown player \(playerId)")
        }

        withPlayer(playerId) {
            $0.drops += 1
            $0.plusMinus = computePlusMinus($0)
        }
        teams[p.team].drops += 1
        if let throwerOfPass { withPlayer(throwerOfPass) { $0.throwsDropped += 1 } }
        if rules.emitPhysicsEvents { emit(.discGrounded(pos: at, reason: "drop")) }

        let to = otherTeam(p.team)
        registerTurnover(.drop, p.team, to, playerId, at)
        deadDisc(to, at, .turnover)
        log("\(name(playerId)) drops it. Turnover to \(teams[to].name).")
        return ActionResult(ok: true)
    }

    /// The throw hits the ground untouched — a throwaway.
    @discardableResult
    public func ground(_ at: Vec3d) -> ActionResult {
        throwaway(at, format.field.isInBounds(at) ? .throwaway : .outOfBounds)
    }

    @discardableResult
    private func throwaway(_ at: Vec3d, _ reason: TurnoverReason) -> ActionResult {
        if phase != .discInFlight { return reject("ground() in \(phase.rawValue)") }
        let thrower = throwerOfPass
        guard let from = possession else { return reject("ground() with no possession") }

        if let thrower {
            var throwerTeam: TeamId = 0
            withPlayer(thrower) {
                $0.throwaways += 1
                $0.plusMinus = computePlusMinus($0)
                throwerTeam = $0.team
            }
            teams[throwerTeam].throwaways += 1
        }
        if rules.emitPhysicsEvents { emit(.discGrounded(pos: at, reason: reason.rawValue)) }

        let to = otherTeam(from)
        let oob = reason == .outOfBounds
        registerTurnover(reason, from, to, thrower ?? -1, at)
        deadDisc(to, format.field.clampToField(at), .turnover)
        log(
            "Throwaway by \(thrower.map(name) ?? "?")\(oob ? " (out of bounds)" : ""). "
                + "\(teams[to].name) at (x=\(fixed(discPos.x, 1)), z=\(fixed(discPos.z, 1))).")
        return ActionResult(ok: true)
    }

    /// The disc leaves the field. `crossing` is where it crossed the line; if you only
    /// have the last in-bounds point and the first out point, use
    /// `outOfBoundsSegment()` instead.
    @discardableResult
    public func outOfBounds(_ crossing: Vec3d) -> ActionResult {
        if phase == .pullInFlight { return pullOutOfBounds(crossing) }
        return throwaway(format.field.clampToField(crossing), .outOfBounds)
    }

    /// Convenience: derive the crossing point from the last in/first out samples.
    @discardableResult
    public func outOfBoundsSegment(_ lastIn: Vec3d, _ firstOut: Vec3d) -> ActionResult {
        let c = format.field.boundaryCrossing(lastIn, firstOut)
        return outOfBounds(c?.point ?? format.field.clampToField(firstOut))
    }

    /// A team-mate catches it but lands out of bounds. Turnover at the line.
    @discardableResult
    public func caughtOutOfBounds(_ playerId: PlayerId, _ at: Vec3d) -> ActionResult {
        if phase != .discInFlight { return reject("caughtOutOfBounds() in \(phase.rawValue)") }
        guard let p = playersById[playerId] else {
            return reject("caughtOutOfBounds() unknown player \(playerId)")
        }
        if let thrower = throwerOfPass {
            var throwerTeam: TeamId = 0
            withPlayer(thrower) {
                $0.throwaways += 1
                $0.plusMinus = computePlusMinus($0)
                throwerTeam = $0.team
            }
            teams[throwerTeam].throwaways += 1
        }
        if rules.emitPhysicsEvents { emit(.discGrounded(pos: at, reason: "caught-oob")) }
        let to = otherTeam(p.team)
        let spot =
            format.field.boundaryCrossing(throwOrigin, at)?.point ?? format.field.clampToField(at)
        registerTurnover(.caughtOutOfBounds, p.team, to, playerId, at)
        deadDisc(to, spot, .turnover)
        log("\(name(playerId)) catches it out of bounds. Turnover to \(teams[to].name).")
        return ActionResult(ok: true)
    }

    /// A defender knocks the disc down (not a catch). Turnover where it lands.
    @discardableResult
    public func block(_ defenderId: PlayerId, _ at: Vec3d) -> ActionResult {
        if phase != .discInFlight { return reject("block() in \(phase.rawValue)") }
        guard let d = playersById[defenderId] else {
            return reject("block() unknown player \(defenderId)")
        }
        guard let from = possession, d.team != from else { return reject("block() by the offense") }

        withPlayer(defenderId) {
            $0.blocks += 1
        }
        teams[d.team].blocks += 1
        withPlayer(defenderId) { $0.plusMinus = computePlusMinus($0) }
        if let thrower = throwerOfPass {
            var throwerTeam: TeamId = 0
            withPlayer(thrower) {
                $0.throwaways += 1
                $0.blockedThrows += 1
                $0.plusMinus = computePlusMinus($0)
                throwerTeam = $0.team
            }
            teams[throwerTeam].throwaways += 1
        }
        if rules.emitPhysicsEvents { emit(.discGrounded(pos: at, reason: "block")) }
        registerTurnover(.block, from, d.team, defenderId, at)
        deadDisc(d.team, format.field.clampToField(at), .turnover)
        log("D! \(name(defenderId)) blocks it. \(teams[d.team].name) possession.")
        return ActionResult(ok: true)
    }

    // MARK: - stall-out

    private func stallOut() {
        let thrower = self.thrower
        guard let from = possession else { return }
        if let thrower {
            var throwerTeam: TeamId = 0
            withPlayer(thrower) {
                $0.stallOuts += 1
                $0.plusMinus = computePlusMinus($0)
                throwerTeam = $0.team
            }
            teams[throwerTeam].stallOuts += 1
        }
        let to = otherTeam(from)
        let spot = pivot
        registerTurnover(.stallOut, from, to, thrower ?? -1, spot)
        if rules.emitPhysicsEvents { emit(.discGrounded(pos: spot, reason: "stall-out")) }
        stallRunning = false
        deadDisc(to, spot, .turnover)
        log("STALL TEN — \(thrower.map(name) ?? "?") is stalled out. Turnover.")
    }

    // MARK: - scoring

    private func scoreGoal(_ scorerId: PlayerId, _ assistId: PlayerId?, _ at: Vec3d) {
        var team: TeamId = 0
        withPlayer(scorerId) {
            $0.goals += 1
            team = $0.team
        }
        teams[team].goals += 1
        withPlayer(scorerId) { $0.plusMinus = computePlusMinus($0) }

        if let assistId, assistId != scorerId {
            withPlayer(assistId) {
                $0.assists += 1
            }
            teams[team].assists += 1
            withPlayer(assistId) { $0.plusMinus = computePlusMinus($0) }
        }
        // Hockey assist: the thrower two passes back.
        let n = chain.count
        if n >= 2 {
            let hockey = chain[n - 2]
            if hockey != assistId && hockey != scorerId {
                withPlayer(hockey) { $0.hockeyAssists += 1 }
            }
        }

        score[team] += 1
        teams[team].score = score[team]
        if team == pointReceivingTeam { teams[team].holds += 1 } else { teams[team].breaks += 1 }

        lastScoringTeam = team
        possession = team
        thrower = nil
        stallRunning = false
        discPos = at
        // `target` is fixed at construction and only moves when a cap is applied.

        lastScore = ScoreRecord(
            team: team, playerId: scorerId, assistId: assistId, score: [score[0], score[1]],
            point: point)
        emit(
            .score(
                team: team, playerId: scorerId, assistId: assistId, score: [score[0], score[1]],
                scoreline: "\(teams[0].name) \(score[0]) - \(score[1]) \(teams[1].name)",
                point: point))
        setPhase(.pointScored)
        log(
            "GOAL — \(name(scorerId))\(assistId.map { " from \(name($0))" } ?? ""). "
                + "\(teams[0].name) \(score[0]) - \(score[1]) \(teams[1].name).")
    }

    /// Leave POINT_SCORED: swap direction of attack, hand the pull to the scoring team,
    /// then go to PRE_PULL / HALFTIME / GAME_OVER. Called automatically
    /// `rules.postScoreDelay` seconds after the goal.
    public func advanceAfterScore() {
        if phase != .pointScored { return }
        guard let scorer = lastScoringTeam else { return }

        // Teams swap the direction they attack; the scoring team pulls.
        attackDir = [flipDir(attackDir[0]), flipDir(attackDir[1])]
        pullingTeam = scorer
        receivingTeam = otherTeam(scorer)
        point += 1

        if isGameOver((score[0], score[1]), target, rules, cap)
            || (hardCapPointIsLast && score[0] != score[1])
        {
            let winner: TeamId = score[0] > score[1] ? 0 : 1
            setPhase(.gameOver)
            emit(
                .gameOver(
                    score: [score[0], score[1]], winner: winner, teamName: teams[winner].name))
            log(
                "GAME OVER — \(teams[winner].name) win "
                    + "\(max(score[0], score[1]))-\(min(score[0], score[1])).")
            return
        }

        if half == 1 && max(score[0], score[1]) >= rules.halftimeAt {
            setPhase(.halftime)
            possession = nil
            thrower = nil
            emit(.half(half: 1, score: [score[0], score[1]]))
            log("HALFTIME — \(teams[0].name) \(score[0]) - \(score[1]) \(teams[1].name).")
            return
        }

        beginPoint()
    }

    /// Second half: ends swap again and the opening roles reverse (WFDF 10.3).
    public func resumeFromHalftime() {
        if phase != .halftime { return }
        half = 2
        for t in 0...1 { teams[t].timeoutsRemaining = rules.timeoutsPerHalf }
        if rules.swapEndsAtHalftime {
            attackDir = [flipDir(attackDir[0]), flipDir(attackDir[1])]
        }
        pullingTeam = openingPullTeam
        receivingTeam = otherTeam(pullingTeam)
        beginPoint()
        log("Second half. \(teams[pullingTeam].name) pulls.")
    }

    private func beginPoint() {
        possession = nil
        thrower = nil
        marker = nil
        markerState = .legal
        stallCount = 0
        stallElapsed = 0
        stallRunning = false
        deadReason = nil
        pullOobCrossing = nil
        pendingCall = nil
        chain = []
        throwerOfPass = nil
        pointReceivingTeam = receivingTeam
        for t in 0...1 {
            teams[t].pointsPlayed += 1
            for id in lines[t] { withPlayer(id) { $0.pointsPlayed += 1 } }
        }
        // Teams line up on their own goal lines.
        pivot = Vec3d(0, 0, format.field.goalLineZ(flipDir(attackDir[receivingTeam])))
        discPos = Vec3d(0, 0, format.field.goalLineZ(flipDir(attackDir[pullingTeam])))
        setPhase(.prePull)
    }

    // MARK: - timeouts

    /// Returns `ok: false` when the team has none left or may not call one now.
    @discardableResult
    public func callTimeout(_ team: TeamId, _ playerId: PlayerId? = nil) -> ActionResult {
        if teams[team].timeoutsRemaining <= 0 {
            return reject("\(teams[team].name) have no timeouts left")
        }
        // The reference computes `live` over both LIVE_POSSESSION and DISC_IN_FLIGHT and
        // then rejects DISC_IN_FLIGHT on the very next line, so the second half of that
        // disjunction can never reach the possession test. Kept as written — collapsing
        // it would be a behaviour change the moment the in-air rejection is relaxed.
        let live = phase == .livePossession || phase == .discInFlight
        if phase == .discInFlight { return reject("timeout while the disc is in the air") }
        if live && possession != team && !rules.defenseMayCallTimeout {
            return reject("only the team in possession may call a timeout during a point")
        }
        if phase == .timeout || phase == .halftime || phase == .gameOver {
            return reject("timeout in \(phase.rawValue)")
        }

        teams[team].timeoutsRemaining -= 1
        teams[team].timeoutsUsed += 1
        timeoutTeam = team
        resumeAfterStoppage = phase == .livePossession ? .livePossession : phase
        pendingStallResume = phase == .livePossession ? resumeStallCount(stallCount, rules) : 0
        stallRunning = false
        setPhase(.timeout)
        emit(.timeout(team: team, playerId: playerId, remaining: teams[team].timeoutsRemaining))
        log("Timeout \(teams[team].name) (\(teams[team].timeoutsRemaining) left).")
        return ActionResult(ok: true)
    }

    /// End the timeout early; otherwise `step()` ends it after `timeoutDuration`.
    public func endTimeout() {
        if phase != .timeout { return }
        timeoutTeam = nil
        if resumeAfterStoppage == .livePossession && possession != nil {
            setPhase(.check)
            log("Back on. Stall will resume at \(pendingStallResume).")
        } else {
            setPhase(resumeAfterStoppage)
            log("Back on.")
        }
    }

    // MARK: - calls and fouls

    /// Self-officiated call. Play stops; resolve it with `resolveCall()`. Fouls,
    /// travels and picks are all routed through here.
    @discardableResult
    public func makeCall(
        _ type: CallType, _ callerId: PlayerId, _ againstId: PlayerId, _ at: Vec3d? = nil
    ) -> ActionResult {
        if phase == .gameOver || phase == .halftime || phase == .timeout {
            return reject("makeCall() in \(phase.rawValue)")
        }
        guard let caller = playersById[callerId], let against = playersById[againstId] else {
            return reject("makeCall() with an unknown player")
        }

        let call = PendingCall(
            type: type, callerId: callerId, callerTeam: caller.team, againstId: againstId,
            againstTeam: against.team, at: at ?? discPos, phaseAtCall: phase,
            stallAtCall: stallCount)
        pendingCall = call
        stallRunning = false
        resumeAfterStoppage = .livePossession
        setPhase(.check)
        emit(
            .call(
                type: type, callerId: callerId, againstId: againstId, at: call.at,
                phaseAtCall: call.phaseAtCall))
        log("\(name(callerId)) calls \(type.rawValue) on \(name(againstId)).")
        return ActionResult(ok: true)
    }

    /// Resolve the outstanding call.
    ///  - contested                       => disc back to the thrower, check, stall
    ///                                       resumes at reached+1 (capped). This is the
    ///                                       brief's mandated rule.
    ///  - uncontested foul on the marker  => stall count resets to 0.
    ///  - uncontested foul on a receiver  => that receiver gains possession at the spot
    ///                                       of the foul (if the pass fell).
    ///  - uncontested travel              => thrower returns to the pivot, count backs
    ///                                       up one; a completed pass stands.
    ///  - uncontested pick                => play restarts where it stopped.
    ///  - uncontested strip               => the stripped player regains possession.
    @discardableResult
    public func resolveCall(_ contested: Bool, receiverId: PlayerId? = nil) -> ActionResult {
        guard let c = pendingCall else { return reject("resolveCall() with no call pending") }

        var outcome = "back-to-thrower"
        if contested {
            restoreToThrower(c)
            pendingStallResume = resumeStallCount(c.stallAtCall, rules)
        } else {
            let offense = possession
            let onOffense = c.againstTeam == offense
            switch c.type {
            case .travel:
                withPlayer(c.againstId) { $0.travels += 1 }
                if c.phaseAtCall == .livePossession {
                    setPivot(pivot)
                    pendingStallResume = max(0, c.stallAtCall - 1)
                    outcome = "travel-pivot-reset"
                } else {
                    // Called after the release: the result of the pass stands.
                    pendingStallResume = 0
                    outcome = "play-on"
                }
            case .pick:
                withPlayer(c.callerId) { $0.picks += 1 }
                restoreToThrower(c)
                pendingStallResume = resumeStallCount(c.stallAtCall, rules)
                outcome = "pick-reset"
            case .foul:
                withPlayer(c.againstId) { $0.foulsCommitted += 1 }
                if onOffense {
                    // Offensive foul on an incomplete pass: disc back to the thrower.
                    restoreToThrower(c)
                    pendingStallResume = resumeStallCount(c.stallAtCall, rules)
                    outcome = "offensive-foul"
                } else if c.phaseAtCall == .discInFlight {
                    // The reference guards this branch with `(receiverId ?? callerId) !==
                    // null`, which cannot be false — a PlayerId is never null there. Only
                    // the phase test is load-bearing.
                    let rid = receiverId ?? c.callerId
                    if let rp = playersById[rid], rp.team == offense {
                        voidThrowAttempt(c)
                        gainPossession(rp.team, rid, c.at, live: false, walk: true, keepChain: true)
                        outcome = "receiving-foul"
                    } else {
                        restoreToThrower(c)
                        outcome = "defensive-foul"
                    }
                    pendingStallResume = 0
                } else {
                    // Marking foul: the count restarts from zero.
                    restoreToThrower(c)
                    pendingStallResume = 0
                    outcome = "marking-foul"
                }
            case .strip:
                withPlayer(c.againstId) { $0.foulsCommitted += 1 }
                // A strip called on a disc that was still in the air nullifies the pass
                // the same way a receiving foul does. Without this the thrower is left
                // charged with an attempt that has no completion, no throwaway and no
                // drop against it, and the box score's own invariant
                // `attempts == completions + throwaways + throwsDropped` breaks.
                voidThrowAttempt(c)
                let rid = receiverId ?? c.callerId
                if let rp = playersById[rid] {
                    undoLastTurnoverTo(rp.team)
                    gainPossession(rp.team, rid, c.at, live: false, walk: true)
                }
                pendingStallResume = resumeStallCount(c.stallAtCall, rules)
                outcome = "strip"
            case .violation:
                restoreToThrower(c)
                pendingStallResume = resumeStallCount(c.stallAtCall, rules)
                outcome = "violation"
            }
        }

        emit(
            .callResolved(
                type: c.type, contested: contested, outcome: outcome,
                stallResume: pendingStallResume))
        log(
            "\(c.type.rawValue) \(contested ? "contested" : "accepted") → \(outcome); "
                + "stall will resume at \(pendingStallResume).")
        pendingCall = nil
        setPhase(.check)
        return ActionResult(ok: true)
    }

    /// Contested-call remedy: the disc goes back to the thrower at the pivot.
    private func restoreToThrower(_ c: PendingCall) {
        guard let id = throwerOfPass ?? thrower, let offense = possession else { return }
        guard let p = playersById[id], p.team == offense else { return }
        voidThrowAttempt(c)
        thrower = id
        discPos = pivot
    }

    /// Undo the stat effect of a pass that a call nullified. Keeps the invariant
    /// `attempts == completions + throwaways + throwsDropped` intact.
    private func voidThrowAttempt(_ c: PendingCall) {
        if c.phaseAtCall != .discInFlight { return }
        guard let id = throwerOfPass, let p = playersById[id] else { return }
        withPlayer(id) { $0.attempts = max(0, $0.attempts - 1) }
        teams[p.team].attempts = max(0, teams[p.team].attempts - 1)
        throwerOfPass = nil
    }

    /// Used by an uncontested strip: give the possession back.
    private func undoLastTurnoverTo(_ team: TeamId) {
        if let possession, possession != team {
            teams[possession].turnoversForced = max(0, teams[possession].turnoversForced - 1)
            teams[team].turnoversCommitted = max(0, teams[team].turnoversCommitted - 1)
        }
    }

    // MARK: - caps

    /// Time cap during a point: target becomes the leader's score + 1.
    public func applySoftCap() {
        cap = .soft
        target = effectiveTarget((score[0], score[1]), rules, cap)
        emit(.cap(kind: "soft", target: target))
        log("SOFT CAP — game to \(target).")
    }

    /// Hard cap: the point in progress is the last one.
    public func applyHardCap() {
        cap = .hard
        hardCapPointIsLast = true
        target = effectiveTarget((score[0], score[1]), rules, cap)
        emit(.cap(kind: "hard", target: target))
        log("HARD CAP — this is the last point (game to \(target)).")
    }

    /// THE MATCH CLOCK, driving the caps that were built and never called.
    ///
    /// Both `softCapAt` and `hardCapAt` default to 0, which means "no clock", so this is
    /// a no-op in every game the sim has played to date and every golden is untouched.
    /// Give either of them a time and the sport's own timed format appears: at the soft
    /// cap the target becomes the leader + 1 and play carries straight on, at the hard
    /// cap the point in progress is the last one.
    ///
    /// Each fires once, and the hard cap subsumes the soft one — arriving at a hard cap
    /// that was never softened still applies the soft cap's target first, which is what a
    /// horn that both teams missed would leave behind anyway.
    private func tickCaps() {
        if phase == .gameOver || phase == .halftime { return }
        if rules.softCapAt > 0, cap == .none, clock >= rules.softCapAt { applySoftCap() }
        if rules.hardCapAt > 0, cap != .hard, clock >= rules.hardCapAt { applyHardCap() }
    }

    // MARK: - internal helpers

    private func creditCompletion(_ throwerId: PlayerId?, _ receiverId: PlayerId, _ at: Vec3d) {
        // The reference holds `rp` and `tp` as references and would have them alias if a
        // player ever threw to himself. Sequencing the two `withPlayer` blocks reproduces
        // that: the second reads the record the first wrote back.
        var receiverTeam: TeamId = 0
        withPlayer(receiverId) { receiverTeam = $0.team }
        let dir = attackDir[receiverTeam]
        let down = downfield(throwOrigin, at, dir)
        let dist = distXZ(throwOrigin, at)

        withPlayer(receiverId) {
            $0.catches += 1
            $0.yardsReceived += down
            $0.receiveDistance += dist
        }
        teams[receiverTeam].yardsReceived += down

        if let throwerId {
            var throwerTeam: TeamId = 0
            withPlayer(throwerId) {
                $0.completions += 1
                $0.yardsThrown += down
                $0.throwDistance += dist
                $0.plusMinus = computePlusMinus($0)
                throwerTeam = $0.team
            }
            teams[throwerTeam].completions += 1
            teams[throwerTeam].yardsThrown += down
        }
    }

    private func downfield(_ from: Vec3d, _ to: Vec3d, _ dir: Dir) -> Double {
        (to.z - from.z) * Double(dir)
    }

    /// A team takes possession. `live` false leaves the phase alone (the caller will set
    /// CHECK). `walk` applies the "carry it to the goal line" rule.
    private func gainPossession(
        _ team: TeamId, _ playerId: PlayerId, _ at: Vec3d,
        live: Bool, walk: Bool, keepChain: Bool = false
    ) {
        let changed = possession != team
        if changed || !keepChain { chain = [] }
        possession = team
        thrower = playerId
        pivot =
            walk
            ? format.field.putIntoPlaySpot(at, attackDir[team], rules)
            : format.field.clampToField(at)
        discPos = pivot
        stallCount = 0
        stallElapsed = 0
        stallRunning = live
        travelFlagged = false
        throwerOfPass = nil
        deadReason = nil
        chain.append(playerId)
        withPlayer(playerId) { $0.touches += 1 }
        if changed { teams[team].possessions += 1 }
        if live { setPhase(.livePossession) }
    }

    /// Disc is on the ground and belongs to `team`; they must pick it up.
    private func deadDisc(_ team: TeamId, _ at: Vec3d, _ reason: DeadReason) {
        possession = team
        thrower = nil
        stallRunning = false
        stallCount = 0
        stallElapsed = 0
        chain = []
        throwerOfPass = nil
        discPos = format.field.putIntoPlaySpot(at, attackDir[team], rules)
        pivot = discPos
        deadReason = reason
        setPhase(.turnoverDead)
    }

    private func registerTurnover(
        _ reason: TurnoverReason, _ from: TeamId, _ to: TeamId, _ playerId: PlayerId, _ pos: Vec3d
    ) {
        teams[from].turnoversCommitted += 1
        teams[to].turnoversForced += 1
        emit(
            .turnover(
                reason: reason, from: from, to: to, playerId: playerId, pos: pos,
                spot: format.field.putIntoPlaySpot(pos, attackDir[to], rules), point: point,
                score: [score[0], score[1]]))
    }

    private func setPhase(_ next: Phase) {
        let from = phase
        if from == next {
            phaseTimer = 0
            return
        }
        phase = next
        phaseTimer = 0
        emit(
            .stateChanged(
                from: from, to: next, clock: clock, point: point, possession: possession,
                score: [score[0], score[1]]))
    }

    private func emit(_ event: GameEvent) { emitFn(event) }

    private func reject(_ note: String) -> ActionResult {
        log("[illegal] \(note)")
        return ActionResult(ok: false, note: note)
    }

    /// Read-modify-write a player's stats, creating the record on first sight.
    ///
    /// This is the reference's `p(id)`, which auto-vivifies an unknown id onto team 0 so
    /// a stat report from a player who was never in a roster cannot crash the machine.
    /// The insertion order is recorded too, because `allPlayers()` and `boxScore()`
    /// depend on it.
    private func withPlayer(_ id: PlayerId, _ body: (inout PlayerStats) -> Void) {
        if playersById[id] == nil {
            playersById[id] = PlayerStats(id: id, team: 0, name: "#\(id)")
            playerOrder.append(id)
        }
        body(&playersById[id]!)
    }

    // MARK: - queries

    public func name(_ id: PlayerId) -> String { playersById[id]?.name ?? "#\(id)" }

    // `getLastScore()` and `playerStats(_:)` were here — both zero callers outside
    // `SimChecks` (`getLastScore`: none at all; `playerStats`: three, since moved to
    // `allPlayers()`). `Engine.justScored` already reads `lastScore` directly rather
    // than through the method wrapper. Deleted, #5.
    public func teamStats(_ t: TeamId) -> TeamStats { teams[t] }
    public func allPlayers() -> [PlayerStats] { playerOrder.compactMap { playersById[$0] } }

    /// True when the marker may legally be running the count.
    ///
    /// `Engine.markerLegal` is the forwarded read a caller outside `UltimateSim` actually
    /// uses (see #5) — this is the one place that projects `markerState` to a bool.
    public func markerLegal() -> Bool { markerState == .legal }

    public func snapshot() -> GameSnapshot {
        GameSnapshot(
            phase: phase, clock: clock, point: point, half: half, score: [score[0], score[1]],
            possession: possession, thrower: thrower, stall: stallCount,
            attackDir: [attackDir[0], attackDir[1]], pullingTeam: pullingTeam, target: target,
            cap: cap)
    }

    // MARK: - log

    private func log(_ text: String) {
        let entry = PlayLogEntry(t: clock, phase: phase, point: point, text: text)
        logBuf.append(entry)
        if logBuf.count > maxLog { logBuf.removeFirst() }
        onLog?(entry)
    }

    /// The whole match log, oldest first. Self-capped at `maxLog` by `log(_:)` above; a
    /// headless engine that runs a whole match without a renderer must not grow a buffer
    /// nobody will ever read (see `Engine.swift`'s note on this method).
    ///
    /// There used to be a `clearLog()` beside this that emptied the buffer outright — with
    /// no caller anywhere, including tests, and nothing in the lifecycle (a new point, a new
    /// match) that was supposed to reset it. The design here is that the log persists for the
    /// whole session; deleted rather than wired, see #5.
    public func getLog() -> [PlayLogEntry] { logBuf }

    /// Human-readable box score, for the HUD or a test harness.
    public func boxScore() -> String {
        var rows: [String] = []
        rows.append(
            "\(teams[0].name) \(score[0]) - \(score[1]) \(teams[1].name)"
                + "   (\(point - 1) points, \(fixed(clock, 1))s, \(phase.rawValue))")
        for t in 0...1 {
            let ts = teams[t]
            let pct =
                ts.attempts != 0
                ? fixed(100 * Double(ts.completions) / Double(ts.attempts), 1) : "0.0"
            rows.append("")
            rows.append(
                "\(ts.name): \(ts.score) pts | \(ts.completions)/\(ts.attempts) (\(pct)%) | "
                    + "blk \(ts.blocks) | TO \(ts.turnoversCommitted) | "
                    + "TOP \(fixed(ts.timeOfPossession, 1))s | "
                    + "holds \(ts.holds) breaks \(ts.breaks) | timeouts used \(ts.timeoutsUsed)")
            rows.append(
                "  " + padEnd("player", 12)
                    + "G  A  D  Cmp/Att  TA  Dr  yThr   yRec   TOP    +/-")
            for p in allPlayers() where p.team == t {
                rows.append(
                    "  " + padEnd(p.name, 12)
                        + padStart(String(p.goals), 2) + " "
                        + padStart(String(p.assists), 2) + " "
                        + padStart(String(p.blocks), 2) + "  "
                        + padStart("\(p.completions)/\(p.attempts)", 7) + " "
                        + padStart(String(p.throwaways), 3) + " "
                        + padStart(String(p.drops), 3) + " "
                        + padStart(fixed(p.yardsThrown, 1), 6) + " "
                        + padStart(fixed(p.yardsReceived, 1), 6) + " "
                        + padStart(fixed(p.timeOfPossession, 1), 6) + " "
                        + padStart(String(computePlusMinus(p)), 4))
            }
        }
        return rows.joined(separator: "\n")
    }

    // MARK: - factories

    /// The reference builds seven and offsets by `team * 7`; both come from the format.
    static func defaultRoster(_ team: TeamId, _ playersPerSide: Int) -> [PlayerSetup] {
        let base = team * playersPerSide
        return (0..<playersPerSide).map { PlayerSetup(id: base + $0, number: $0 + 1) }
    }
}

// MARK: - string helpers

/// JavaScript's `Number.prototype.toFixed`, near enough for a play-by-play line.
///
/// **Not near enough to assert bit-exactly, and the suites do not.** `toFixed` is
/// specified over the exact decimal value of the double with ties going away from zero;
/// C's `%f` rounds ties to even. They disagree on values like 0.25 at one place. Every
/// number that matters is asserted from the stats and the snapshot, which are doubles;
/// the log is diagnostic prose.
private func fixed(_ v: Double, _ places: Int) -> String {
    String(format: "%.\(places)f", v)
}

private func padEnd(_ s: String, _ width: Int) -> String {
    s.count >= width ? s : s + String(repeating: " ", count: width - s.count)
}

private func padStart(_ s: String, _ width: Int) -> String {
    s.count >= width ? s : String(repeating: " ", count: width - s.count) + s
}
