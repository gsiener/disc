import Foundation

/// The real game: ported AI, ported locomotion, ported disc runtime, wired together.
///
/// **This replaced `Play/Match.swift`, which has been deleted.** That file said in its own
/// doc comment that it was written to be deleted: its cutting, its marking and its
/// `DEFENDER_LAG` were inventions, made up to get a thumb onto a playable possession
/// before `AI.ts` and `Locomotion.ts` existed. They exist now. Its history is in git,
/// which is the only archive a deleted file needs.
///
/// One piece of it survives in `PlayTypes.swift` and is worth naming: `BID_EDGE`, the
/// margin by which a defender must beat a receiver to the disc. That was predicted to go
/// away with the AI port and did not, because the ported AI decides *where* a throw goes
/// rather than who wins the disc when it arrives.
///
/// The reference's equivalent is `src/sim/Game.ts`, which is **not** a port target: it
/// imports three.js, the engine's `Ctx`/`System` types and the web input layer, and is
/// integration glue rather than simulation. So this file is written against the ported
/// pieces rather than translated from that one, and it is the only file in the sim that
/// is not differentially validated — because there is nothing to differ against.
///
/// What that means for trust, stated plainly: every *component* here is validated to
/// bit-exactness or near it against the TypeScript. The wiring is not. So the checks in
/// `EngineTests` are property assertions — a point can be scored, nobody leaves the
/// pitch, no quantity goes non-finite, the same seed replays — rather than golden
/// comparisons, and that is a weaker bar honestly labelled.
///
/// The loop, once per fixed tick:
///
///   1. build an `AIWorld` from the current state
///   2. ask both `TeamAI`s for intents
///   3. hand the intents to `Locomotion`, which moves the bodies
///   4. write the bodies back onto the AI's own player records
///   5. resolve any throw the AI released into a real flight
///   6. step the disc, and resolve a catch, a block or a landing
public final class Engine {

    // MARK: configuration

    public let format: GameFormat
    /// Points needed to win.
    public let target: Int

    // MARK: state

    /// The AI's view of every player, both teams. Long-lived, mutated in place.
    public private(set) var players: [AIPlayer] = []
    public private(set) var loco = Locomotion()
    public private(set) var ai: [TeamAI] = []
    public private(set) var disc = DiscRuntime()
    public private(set) var score = [0, 0]
    public private(set) var phase: GamePhase = .setup
    /// Which team is on offence.
    public private(set) var possession: TeamId = 0
    /// Which way team 0 attacks; team 1 attacks the other way.
    public private(set) var attackDir: Dir = 1
    /// Seconds since the possession began, which is what the stall reads.
    public private(set) var possessionTime = 0.0
    public private(set) var clock = 0.0
    /// Whoever is holding, else nil.
    public private(set) var carrier: Int?
    /// The player the human is controlling, always on team 0.
    public private(set) var controlled = 0
    public private(set) var stats = MatchStats()

    /// The rule set. `stallMax` is the only part currently enforced here — the rest
    /// arrives when `GameState` is wired in, which is the next job.
    public let rules: RuleSet = DEFAULT_RULES

    private let rng: Rng
    private var records: [WorldPlayerRecord] = []
    /// The team that just scored, held for `scoreFlash` seconds so a callout can be read.
    ///
    /// It was cleared on the very next tick, which is correct as a signal and useless as
    /// something to draw: the GOAL banner would have existed for one frame at 120 Hz.
    /// The flag outlives the event on purpose, and the deadline is in sim time so it
    /// survives a replay at a different frame rate.
    public private(set) var justScored: TeamId?
    private var scoreFlashUntil = -1.0
    /// How long the goal callout stays up, seconds.
    public static let scoreFlash = 2.5

    public var isOver: Bool { score[0] >= target || score[1] >= target }

    /// Teams whose throws the computer makes. Defaults to the opponent only; set both and
    /// the game plays itself, which is how the checks run it headlessly.
    public var autoTeams: Set<TeamId> = [1]

    public init(
        format: GameFormat = .minis,
        target: Int? = nil,
        seed: UInt32 = 0x5eed_c0de
    ) {
        self.format = format
        // A minis game is to 7 and a regulation game to 15 — the same numbers
        // `FieldSpec` carried, kept here so the caller need not restate them.
        self.target = target ?? (format.playersPerSide <= 3 ? 7 : 15)
        self.rng = Rng(seed: seed)
        reset(receiving: 0)
    }

    // MARK: setup

    /// Build both rosters and stand them up for a point.
    ///
    /// The rosters are drawn from the RNG in a fixed order, so one seed is one set of
    /// athletes — `makePlayer` consumes a known number of draws per player and the whole
    /// squad is reproducible. Archetypes are dealt round-robin rather than randomly for
    /// the same reason a line has a shape: a team of seven deeps is not a team.
    public func reset(receiving: TeamId) {
        players = []
        loco = Locomotion()
        records = []

        let order: [Archetype] = [.handler, .cutter, .deep, .handler, .cutter, .utility, .deep]
        for t in 0..<2 {
            for i in 0..<format.playersPerSide {
                let id = t * format.playersPerSide + i
                let p = makePlayer(id, t, order[i % order.count], rng, overall: 72)
                players.append(p)
            }
        }

        possession = receiving
        attackDir = receiving == 0 ? 1 : -1
        phase = .live
        possessionTime = 0
        justScored = nil

        // Line up: the receiving team spread across their own half, the pulling team
        // across theirs. Positions are only a starting shape — the AI takes over on the
        // first tick and moves everyone where the formation actually wants them.
        for (i, p) in players.enumerated() {
            let onOffence = p.team == possession
            let dir = Double(dirFor(p.team))
            let slot = Double(i % format.playersPerSide)
            let span = Double(Swift.max(1, format.playersPerSide - 1))
            let lateral = (slot / span - 0.5) * format.field.width * 0.6
            let depth = -dir * format.field.goalLine * (onOffence ? 0.5 : 0.12)
            p.pos = Vec3d(lateral, 0.9, depth)
            p.vel = .zero
            p.energy = 1
            _ = loco.create(
                CreateOpts(
                    id: p.id, team: p.team, attr: fromAIAttributes(ratings(p.attr)),
                    pos: p.pos, facing: dir > 0 ? 0 : .pi))
            records.append(WorldPlayerRecord(id: p.id, pos: p.pos, vel: .zero))
        }

        // One TeamAI per side. Both fork from the same parent stream, and the fork salt
        // includes the team index, so the two do not make identical decisions.
        ai = (0..<2).map { t in
            var cfg = DEFAULT_TEAM_CONFIG
            cfg.seed = 1 + t
            return TeamAI(
                team: t, dir: dirFor(t), rng: rng, cfg: cfg, field: format.field)
        }

        // Start from a caught pull, as the interim engine did. A live pull is its own
        // sequence in `GameState` and wiring it is the next job, not this one.
        let handler = possession * format.playersPerSide
        carrier = handler
        controlled = possession == 0 ? handler : nearestOnTeam(0, to: players[handler].pos)
        disc = DiscRuntime()
        disc.hold(
            players[handler].id, Vec3d(players[handler].pos.x, 1.1, players[handler].pos.z),
            Vec3d(0, 1, 0))
        stats = MatchStats()
    }

    public func dirFor(_ team: TeamId) -> Dir { team == 0 ? attackDir : -attackDir }

    /// The pitch in the view layer's vocabulary.
    ///
    /// `GameFormat` is the sim's spelling — a `FieldConstants` plus a roster size — and
    /// `FieldSpec` is the renderer's, which also carries the target score because a
    /// scoreboard needs it. They describe the same rectangle. This bridges rather than
    /// unifying them, deliberately: the sim's version is what 3,098 gamestate assertions
    /// are written against, and the renderer's is what `PitchScene` builds geometry from.
    /// Collapsing them would mean editing one to suit the other, and the sim is not the
    /// one that should move.
    public var fieldSpec: FieldSpec {
        FieldSpec(
            length: format.field.length,
            width: format.field.width,
            endzoneDepth: format.field.endzoneDepth,
            teamSize: format.playersPerSide,
            target: target)
    }

    /// Whoever is holding, under the name the view already used.
    public var holder: Int? { carrier }

    public func attackDirection(of team: TeamId) -> Double { Double(dirFor(team)) }

    /// The AI's rating sheet as the name-keyed bag `fromAIAttributes` expects.
    ///
    /// The reference passes one duck-typed object between the two models, so the bridge
    /// is a dictionary rather than a typed conversion. Only the keys that bridge are
    /// listed: `strength` and `balance` have no AI counterpart and fall back to the
    /// locomotion defaults, which is what the reference does too.
    private func ratings(_ a: AIAttributes) -> [String: Double] {
        [
            "speed": a.speed,
            "acceleration": a.acceleration,
            "agility": a.agility,
            "jumping": a.jumping,
            "stamina": a.stamina,
        ]
    }

    private func nearestOnTeam(_ team: TeamId, to p: Vec3d) -> Int {
        players.filter { $0.team == team }
            .min { distXZ($0.pos, p) < distXZ($1.pos, p) }?.id
            ?? team * format.playersPerSide
    }

    // MARK: the tick

    /// Advance one fixed tick. `dt` is expected to be `1/120`; anything else works but a
    /// replay is only reproducible if the sequence of `dt`s is.
    public func step(dt: Double) {
        guard !isOver else { return }
        clock += dt
        possessionTime += dt
        if justScored != nil, clock > scoreFlashUntil { justScored = nil }

        let world = buildWorld(dt: dt)

        // 1. Both AIs decide. Team order is fixed rather than alternating, because the
        //    two calls draw from independent forked streams and swapping them would
        //    change nothing except make a replay depend on the order.
        var intents: [PlayerIntent] = []
        for team in ai { intents.append(contentsOf: updateTeam(team, world, dt)) }

        // 2. Bodies move. Locomotion owns position and velocity from here.
        loco.apply(intents.map(locoIntent), dt: dt, world: &records)

        // 3. Write the bodies back onto the AI's records. `syncTo` has already updated
        //    `records`; this is the copy back into the objects the AI reads next tick.
        for r in records {
            guard let p = players.first(where: { $0.id == r.id }) else { continue }
            if let pos = r.pos { p.pos = pos }
            if let vel = r.vel { p.vel = vel }
            p.airborne = r.airborne
            tickStamina(p, dt)
        }

        // 4. Any throw the AI released becomes a real flight — but only for a team the
        //    computer is playing. `autoTeams` was declared and never consulted in the
        //    first version of this file, so the AI threw for the human's side too and
        //    the player never got to make a decision. The checks caught it by asserting
        //    that with the computer switched off entirely, somebody is still holding.
        for intent in intents {
            guard case .throw(let type, let aim, _, _, let spin, let receiver, _) = intent.action
            else { continue }
            guard let p = players.first(where: { $0.id == intent.id }),
                autoTeams.contains(p.team)
            else { continue }
            release(by: intent.id, type: type, aim: aim, spin: spin, receiver: receiver)
            break  // one disc
        }

        // 5. The count. A possession that never ends is not a rules edge case, it is the
        //    game hanging: the first build of this file had no stall at all, and a
        //    handler the human was not throwing for stood holding the disc past thirteen
        //    seconds while the count on screen kept climbing.
        //
        //    `stallMax` comes from the rule set rather than a literal, because it is a
        //    rule and because minis may well want a shorter one on a pitch a third the
        //    size — that is a tuning decision with somewhere to live.
        if carrier != nil, possessionTime >= Double(rules.stallMax) {
            stats.stalled += 1
            stalled()
        }

        // 6. The disc.
        stepDisc(dt: dt)
    }

    /// Assemble the world the AI reads. Rebuilt each tick rather than mutated, because a
    /// stale field here is invisible and produces decisions from last frame's positions.
    private func buildWorld(dt: Double) -> AIWorld {
        var w = AIWorld()
        w.time = clock
        w.players = players
        w.possession = possession
        w.phase = phase
        w.score = score
        w.scoreCap = target
        w.rand = rng
        w.field = format.field
        w.wind = .zero
        w.disc = AIDiscState(
            pos: disc.state.pos,
            vel: disc.state.vel,
            state: discPhase,
            carrier: carrier,
            thrownBy: thrownBy,
            intendedReceiver: intendedReceiver,
            // The count the marker has produced. `possessionTime` is the offence's own
            // clock, and `TeamAI` deliberately watches both — see its `stallRead`.
            stall: Swift.min(10, possessionTime),
            spin: disc.state.spin,
            throwType: aiThrowType(disc.state.throwType))
        return w
    }

    private var discPhase: DiscPhase {
        if carrier != nil { return .held }
        return disc.state.atRest ? .ground : .flight
    }

    private var thrownBy: Int?
    private var intendedReceiver: Int?

    /// The AI's throw vocabulary is five; the aero table's is six. Everything the AI can
    /// choose exists in the aero table, so this never fails in practice — but it returns
    /// an optional rather than force-unwrapping, because a blade arriving here would mean
    /// something upstream changed and a crash is a poor way to learn that.
    private func aiThrowType(_ t: ThrowType?) -> AIThrowType? {
        guard let t else { return nil }
        return AIThrowType(rawValue: t.rawValue)
    }

    private func locoIntent(_ i: PlayerIntent) -> IntentLike {
        IntentLike(
            id: i.id,
            targetX: i.targetX, targetZ: i.targetZ,
            faceX: i.faceX, faceZ: i.faceZ,
            mode: i.mode.rawValue,
            effort: i.effort,
            desiredSpeed: i.desiredSpeed,
            maxSpeed: i.maxSpeed,
            arriveRadius: i.arriveRadius,
            action: nil)
    }

    // MARK: the disc

    private func release(
        by id: Int, type: AIThrowType, aim: Vec3d, spin: Double, receiver: Int
    ) {
        guard carrier == id, let thrower = players.first(where: { $0.id == id }) else { return }
        guard let physType = ThrowType(rawValue: type.rawValue) else { return }

        // Aim carries the AI's intended landing point; the throw table turns a direction
        // and a power into a release. Power is solved from the range the AI wants rather
        // than passed through, because `maxThrowRange` and `throwSpeed` are two different
        // curves and the AI reasons in the first.
        let flat = Vec3d(aim.x - thrower.pos.x, 0, aim.z - thrower.pos.z)
        let range = flat.length
        let dir = flat.lengthSq < 1e-9 ? Vec3d(0, 0, Double(dirFor(thrower.team))) : flat.normalized

        var opts = ThrowOptions()
        opts.hand = thrower.handed == .left ? .left : .right
        opts.groundY = 0

        let power = clamp01((range - 4) / 26)
        let req = ThrowRequest(
            type: physType,
            from: Vec3d(thrower.pos.x, 1.25, thrower.pos.z),
            aim: dir,
            power: power,
            angle: range > 18 ? 0.10 : 0,
            spin: clamp01(spin),
            hand: opts.hand)
        _ = disc.release(req)

        carrier = nil
        thrownBy = id
        intendedReceiver = receiver
        stats.throwsMade += 1
        possessionTime = 0
    }

    private func stepDisc(dt: Double) {
        guard carrier == nil else {
            // Held: the disc rides with the thrower's hand.
            if let c = carrier, let p = players.first(where: { $0.id == c }) {
                disc.hold(c, Vec3d(p.pos.x, 1.1, p.pos.z), Vec3d(0, 1, 0))
            }
            return
        }

        disc.step(dt: dt)
        let pos = disc.state.pos

        if !format.field.isInBounds(pos) {
            stats.outOfBounds += 1
            turnover(at: format.field.clampToField(pos))
            return
        }

        // A catch. The receiver attacks the disc, so an offensive player wins a contest
        // unless a defender is clearly closer — the same rule the interim engine landed
        // on, and for the same measured reason: a defender trails on the side a throw
        // arrives from, so "nearest" alone hands the defence almost everything.
        if pos.y < 2.3, pos.y > 0.15 {
            let throwerTeam = thrownBy.flatMap { id in players.first { $0.id == id }?.team }
            var bestOff = -1, bestOffD = DISC_GRAB_R
            var bestDef = -1, bestDefD = DISC_GRAB_R
            for p in players {
                if p.id == thrownBy && disc.state.t < 0.35 { continue }
                let d = distXZ(p.pos, pos)
                guard d < DISC_GRAB_R else { continue }
                if p.team == throwerTeam {
                    if d < bestOffD { bestOffD = d; bestOff = p.id }
                } else if d < bestDefD {
                    bestDefD = d
                    bestDef = p.id
                }
            }
            if bestOff >= 0 && (bestDef < 0 || bestDefD > bestOffD - BID_EDGE) {
                caught(by: bestOff)
                return
            }
            if bestDef >= 0 {
                caught(by: bestDef)
                return
            }
        }

        if disc.state.atRest {
            stats.grounded += 1
            turnover(at: pos)
        }
    }

    private func caught(by id: Int) {
        guard let p = players.first(where: { $0.id == id }) else { return }
        let throwerTeam = thrownBy.flatMap { t in players.first { $0.id == t }?.team }

        if p.team != throwerTeam {
            stats.blocks += 1
            possess(id, team: p.team)
            return
        }
        if format.field.isInEndzone(p.pos, dirFor(p.team)) {
            stats.completions += 1
            stats.goals += 1
            score[p.team] += 1
            phase = .dead
            // Line up for the next point immediately. Leaving the disc in flight after a
            // goal is what made completions outnumber throws in the first run of this
            // file: the score went up, nothing else changed, and the same disc was caught
            // again a frame later.
            //
            // `justScored` is set AFTER the reset, not before, because `reset` clears it
            // — it has to, or the flag would survive into the next point. Setting it
            // first meant every goal raised the score and reported nobody had scored.
            let scorer = p.team
            if !isOver { reset(receiving: scorer == 0 ? 1 : 0) }
            justScored = scorer
            scoreFlashUntil = clock + Engine.scoreFlash
            return
        }
        stats.completions += 1
        possess(id, team: p.team)
    }

    private func possess(_ id: Int, team: TeamId) {
        carrier = id
        thrownBy = nil
        intendedReceiver = nil
        possession = team
        possessionTime = 0
        phase = .live
        // Control follows the disc, which is the decision recorded in the plan: you are
        // always the player with a decision to make.
        if team == 0 { controlled = id }
        if let p = players.first(where: { $0.id == id }) {
            disc.hold(id, Vec3d(p.pos.x, 1.1, p.pos.z), Vec3d(0, 1, 0))
        }
    }

    /// The count ran out. The disc goes over on the spot, which is where the thrower is.
    private func stalled() {
        guard let c = carrier, let p = players.first(where: { $0.id == c }) else { return }
        let taking: TeamId = p.team == 0 ? 1 : 0
        let taker = nearestOnTeam(taking, to: p.pos)
        possess(taker, team: taking)
    }

    private func turnover(at spot: Vec3d) {
        let losing = thrownBy.flatMap { id in players.first { $0.id == id }?.team } ?? possession
        let taking: TeamId = losing == 0 ? 1 : 0
        let taker = nearestOnTeam(taking, to: spot)
        possess(taker, team: taking)
    }

    // MARK: the human

    /// Release a throw on behalf of the controlled player.
    ///
    /// The gesture mapping is `ThrowGesture`, in the sim and asserted there. This only
    /// turns the resulting throw into a disc, and it refuses when the controlled player is
    /// not actually holding — a human cannot throw a disc they do not have, and silently
    /// doing nothing is better than teleporting one into their hand.
    @discardableResult
    public func humanRelease(
        _ type: ThrowType, aim: Vec3d, power: Double, loft: Double = 0
    ) -> Bool {
        guard let c = carrier, c == controlled,
            let thrower = players.first(where: { $0.id == c })
        else { return false }

        var opts = ThrowOptions()
        opts.hand = thrower.handed == .left ? .left : .right
        let req = ThrowRequest(
            type: type,
            from: Vec3d(thrower.pos.x, 1.25, thrower.pos.z),
            aim: aim,
            power: power,
            angle: loft,
            spin: 0.6,
            hand: opts.hand)
        _ = disc.release(req)
        carrier = nil
        thrownBy = c
        intendedReceiver = nil
        stats.throwsMade += 1
        possessionTime = 0
        return true
    }

    /// Is the disc in the air right now?
    ///
    /// The interim engine spelled this as a `PlayPhase.flight(by:)` case carrying the
    /// thrower. Here `GamePhase` is the ported vocabulary — setup, pull, live, dead —
    /// which is about the *point*, not the disc, so "in flight" is a question about the
    /// disc and is answered from the disc.
    public var discInFlight: Bool { carrier == nil && !disc.state.atRest }

    /// Who threw the disc that is currently in the air, if one is.
    public var thrower: Int? { discInFlight ? thrownBy : nil }

    /// Seconds the current holder has had it, which is what a stall count reads.
    public var stall: Double { carrier == nil ? 0 : possessionTime }
}

extension FieldSpec {
    /// The same pitch in the sim's vocabulary. The inverse of `Engine.fieldSpec`.
    ///
    /// The view picks a format from a button and the sim needs a `GameFormat`; this is
    /// that one conversion, in one place, rather than each caller rebuilding it from
    /// remembered numbers.
    public var gameFormat: GameFormat {
        GameFormat(
            field: FieldConstants(
                length: length,
                width: width,
                endzoneDepth: endzoneDepth,
                centralLength: length - 2 * endzoneDepth,
                goalLine: (length - 2 * endzoneDepth) / 2,
                endLine: length / 2,
                sideline: width / 2,
                brickIn: endzoneDepth,
                brickZ: (length - 2 * endzoneDepth) / 2 - endzoneDepth),
            playersPerSide: teamSize)
    }
}
