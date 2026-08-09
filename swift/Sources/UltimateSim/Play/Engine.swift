import Foundation

/// The real game: ported AI, ported locomotion, ported disc runtime and the ported rules
/// machine, wired together.
///
/// **`GameState` is the authority and this file feeds it.** That is the one sentence that
/// describes the split. `GameState` owns the phase machine, possession, the score, the
/// stall count and every statistic; `Engine` owns the bodies, the disc and the translation
/// between them. Nothing here keeps a second copy of anything the machine owns — `score`,
/// `phase`, `possession`, `stall` and `stats` below are all reads through `game`, because
/// two copies of a number is two numbers that will eventually disagree, and the one that
/// is wrong is always the one on screen.
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
/// bit-exactness or near it against the TypeScript, and `GameState` is 3,098 assertions
/// against a scripted trace. The wiring is not. So the checks in `EngineTests` are
/// property assertions — a pull is thrown, the count only runs while a marker is legally
/// on the thrower, no reported action is ever refused, nobody leaves the pitch, one seed
/// is one match — rather than golden comparisons, and that is a weaker bar honestly
/// labelled.
///
/// The loop, once per fixed tick:
///
///   1. hand `GameState` a `FrameObservation` of where the bodies were, and step it —
///      that is where the clock runs and where the count is decided
///   2. do whatever the resulting phase demands of the play layer: stage a point, throw a
///      pull, send somebody to pick a dead disc up. A human pulling team gets until
///      `pullDeadline` to pull for itself, because a pull is a throw and `humanRelease`
///      will make it
///   3. build an `AIWorld` from the machine's state and ask both `TeamAI`s for intents
///   4. hand the intents to `Locomotion`, which moves the bodies
///   5. resolve any throw the AI released into a real flight, reported to the machine
///   6. step the disc, and report the catch, the block, the throwaway or the landing
public final class Engine {

    // MARK: configuration

    public let format: GameFormat
    /// Points needed to win, as configured. `game.target` is the live one and moves under
    /// a cap; this is the number a recording stores and a scoreboard was built for.
    public let target: Int

    /// The rules machine. Phase, possession, score, stall, fouls, caps, the box score and
    /// the play-by-play all live here, and every one of them is read rather than mirrored.
    ///
    /// Public because the HUD, the checks and any future commentary layer all want
    /// `snapshot()`, `teamStats`, `playerStats` and `getLog()`, and routing each of those
    /// through a hand-written forwarder on `Engine` would be a second surface to keep in
    /// step with the first.
    public let game: GameState

    // MARK: state this file actually owns

    /// The AI's view of every player, both teams. Long-lived, mutated in place, and built
    /// **once** — the roster is the same fourteen athletes all match, so `GameState`'s
    /// per-player box score means something across points.
    public private(set) var players: [AIPlayer] = []
    public private(set) var loco = Locomotion()
    public private(set) var ai: [TeamAI] = []
    public private(set) var disc = DiscRuntime()
    /// The player the human is controlling, always on team 0.
    public private(set) var controlled = 0

    private let rng: Rng
    private let sink: EngineEventSink
    private var records: [WorldPlayerRecord] = []
    /// Who last released the *physical* disc, which is not the same question as
    /// `game.thrower`.
    ///
    /// During a pull the machine has no thrower at all — a puller is not the offence's
    /// thrower and `beginPoint` leaves `thrower` nil — but the contest still has to know
    /// whose hand the disc has just left, so that he cannot catch it back off his own
    /// fingertips. This is a fact about the disc, not about the rules, which is why it
    /// lives here and is cleared the moment the disc is in somebody's hand again.
    private var thrownBy: Int?
    private var intendedReceiver: Int?
    /// The point number the bodies were last stood up for. See `stagePoint`.
    private var stagedPoint = -1

    /// Every action the machine refused, newest last.
    ///
    /// **A refusal that is ignored looks exactly like a working game until the phase it
    /// mattered in.** `ActionResult.ok == false` means this file called a mutator from the
    /// wrong phase, which is a wiring bug and never a rules event, so every call goes
    /// through `demand` and lands here. `EngineTests` asserts this stays empty through a
    /// full automated match; a non-empty list in a running game is a bug report with the
    /// phase already in it.
    public private(set) var refusals: [String] = []
    /// Capped so a pathological run cannot grow without bound; the first ones are the
    /// informative ones, because everything after the first desync is a consequence.
    private static let maxRefusals = 64

    /// The rule set in force. `GameState` owns it; this is the read.
    public var rules: RuleSet { game.rules }

    /// Seconds a computer-run `PRE_PULL` line-up is given before the pull is thrown.
    ///
    /// Not a rule — the rules have nothing to say about how long a team takes to signal
    /// ready — but the bodies have to arrive on their goal lines before the disc leaves,
    /// or the pull is thrown at an empty half.
    public static let pullSettle = 0.8

    /// Seconds a *human* pulling team is given before the engine pulls for them.
    ///
    /// The pull is a throw, and a human whose team is pulling should get to make it — see
    /// `humanRelease`. But a game that waits forever for a thumb that never arrives is a
    /// game that never starts, so the wait has an end. Long enough to line up and aim,
    /// short enough that an unattended match is only briefly boring.
    public static let pullDeadline = 5.0

    /// How long the goal callout stays up, seconds.
    public static let scoreFlash = 2.5

    /// Seconds of halftime.
    ///
    /// **A deliberate departure from `DEFAULT_RULES`, which says 300.** Five minutes is
    /// right for a match and is the game hanging for a player: `GameState` sits in
    /// `HALFTIME` doing nothing until the clock runs out, and there is no interface here
    /// that could fill it. The rule itself — ends swap, timeouts come back, the opening
    /// pull roles reverse — is wired and real; only its duration is tuned to something a
    /// thumb can sit through.
    public static let halftimeSeconds = 6.0

    /// True once the machine has declared the game over. Not a score comparison: the
    /// caps, the win-by margin and the point cap all decide this and they all live in
    /// `GameState`.
    public var isOver: Bool { game.phase == .gameOver }

    /// Teams whose throws the computer makes. Defaults to the opponent only; set both and
    /// the game plays itself, which is how the checks run it headlessly.
    ///
    /// The **pull is not an AI throw** and is not gated by this: it is a rules event the
    /// machine demands before a point can start, so it happens with the computer switched
    /// off entirely. That is what makes a human-only engine reach a live possession at all.
    public var autoTeams: Set<TeamId> = [1]

    public init(
        format: GameFormat = .minis,
        target: Int? = nil,
        seed: UInt32 = 0x5eed_c0de
    ) {
        self.format = format
        // A minis game is to 7 and a regulation game to 15 — the same numbers
        // `FieldSpec` carried, kept here so the caller need not restate them.
        let goal = target ?? (format.playersPerSide <= 3 ? 7 : 15)
        self.target = goal
        self.rng = Rng(seed: seed)

        // The emitter is handed to `GameState` at construction, before `self` exists, so
        // the tally it feeds is a separate object rather than a closure over the engine.
        let sink = EngineEventSink()
        self.sink = sink

        var opts = GameStateOptions()
        opts.format = format
        opts.emit = { [sink] event in sink.absorb(event) }
        // The human's team pulls to open. A coin toss decides this in the sport and
        // nothing decides it here, so it is chosen for the player rather than against
        // them: pulling is a throw, `humanRelease` will make it, and a game that opens
        // with something to do beats one that opens watching a disc arrive.
        opts.startingPullTeam = 0
        opts.rules = { r in
            r.gameTo = goal
            // Halftime at the midpoint of whatever length this game is, which reproduces
            // the regulation 8-of-15 and gives a minis game to 7 a break at 4.
            r.halftimeAt = (goal + 1) / 2
            r.halftimeDuration = Engine.halftimeSeconds
            // NOT shortened for minis, and the reason is worth recording because it was
            // tried and measured.
            //
            // Ten seconds is calibrated to a 100 x 37 m field, and a minis pitch is barely
            // a third that area, so a shorter count looks like the obvious way to quicken
            // a point that currently runs two and a half to three minutes. It is not a
            // configuration change, because **`TeamAI` hardcodes the ten**:
            //
            //     stall >= 8.5 ? -1e9 : (-0.135 - 0.26 * pow(clamp(stall, 0, 10) / 10, 2))
            //
            // 8.5 is where it abandons its standards and throws the best thing available.
            // Set `stallMax` to 7 and that point is never reached — the AI is still
            // holding out for a good look when the count expires. Measured over ten
            // simulated minutes: **80 stall-outs, 2 throws, 0 goals**, against 0 stall-outs
            // and 69 throws at ten.
            //
            // So the rule and the offence's sense of time are one thing, not two. Pacing
            // has to move through `cfg.aggression`, which is the knob the reference
            // exposes for exactly this, or by rescaling that curve — which is ported logic
            // and would need its own goldens.
        }
        self.game = GameState(opts)

        buildRoster()
        game.startGame()
        stagePoint()
    }

    // MARK: setup

    /// Deal both rosters. Called once.
    ///
    /// The rosters are drawn from the RNG in a fixed order, so one seed is one set of
    /// athletes — `makePlayer` consumes a known number of draws per player and the whole
    /// squad is reproducible. Archetypes are dealt round-robin rather than randomly for
    /// the same reason a line has a shape: a team of seven deeps is not a team.
    ///
    /// The ids are `team * playersPerSide + i`, which is exactly what
    /// `GameState.defaultRoster` builds, so the machine's box score and this roster are
    /// the same fourteen people rather than two coincidentally-sized lists.
    private func buildRoster() {
        players = []
        let order: [Archetype] = [.handler, .cutter, .deep, .handler, .cutter, .utility, .deep]
        for t in 0..<2 {
            for i in 0..<format.playersPerSide {
                let id = t * format.playersPerSide + i
                players.append(makePlayer(id, t, order[i % order.count], rng, overall: 72))
            }
        }
    }

    /// Stand both lines up for the point the machine has just opened.
    ///
    /// Called on the tick `PRE_PULL` is entered, once per point — including the one after
    /// halftime, where the ends have swapped and every attacking direction is the other
    /// one. That is why the `TeamAI`s are rebuilt here rather than reused: `TeamAI.dir` is
    /// a `let`, and a team that has changed ends and kept its old direction plays the
    /// whole point backwards.
    private func stagePoint() {
        stagedPoint = game.point
        loco = Locomotion()
        records = []

        // Both teams line up on their own goal lines, facing each other. Positions are
        // only a starting shape — the AI takes over on the first tick and moves everyone
        // where the formation actually wants them.
        for (i, p) in players.enumerated() {
            let dir = Double(dirFor(p.team))
            let slot = Double(i % format.playersPerSide)
            let span = Double(Swift.max(1, format.playersPerSide - 1))
            let lateral = (slot / span - 0.5) * format.field.width * 0.6
            p.pos = Vec3d(lateral, 0.9, -dir * format.field.goalLine * 0.95)
            p.vel = .zero
            p.energy = 1
            p.airborne = false
            _ = loco.create(
                CreateOpts(
                    id: p.id, team: p.team, attr: fromAIAttributes(ratings(p.attr)),
                    pos: p.pos, facing: dir > 0 ? 0 : .pi))
            records.append(WorldPlayerRecord(id: p.id, pos: p.pos, vel: .zero))
        }

        // One TeamAI per side. Both fork from the same parent stream, and the fork salt
        // includes the team index *and the point number*, so the two sides do not make
        // identical decisions and one point is not a rerun of the last. `Rng.fork` reads
        // the parent's state without advancing it, so without the point in the salt every
        // point would re-fork the same two streams from the same place.
        ai = (0..<2).map { t in
            var cfg = DEFAULT_TEAM_CONFIG
            cfg.seed = 1 + t + 2 * game.point
            return TeamAI(
                team: t, dir: dirFor(t), rng: rng, cfg: cfg, field: format.field)
        }

        // Declare the lines. They are already the default rosters, so this changes
        // nothing today; it is here because the machine's contract is that a line is
        // declared and a caller that starts fielding subs must not have to remember to
        // add the call.
        for t in 0..<2 {
            game.setLine(t, players.filter { $0.team == t }.map(\.id))
        }

        // The puller picks the disc up off the line and holds it until he pulls, which is
        // what makes `humanRelease` able to throw one.
        thrownBy = nil
        intendedReceiver = nil
        disc = DiscRuntime()
        controlled = nearestOnTeam(0, to: Vec3d(game.discPos.x, 0, game.discPos.z))
        syncDisc()
    }

    /// The player who pulls this point: the first name on the pulling team's line.
    ///
    /// Fixed rather than chosen, because who pulls is a captain's decision and there is
    /// nobody here to make it. Deterministic, which is what a replay needs.
    private var puller: PlayerId { game.pullingTeam * format.playersPerSide }

    /// Which way `team` attacks this point. The machine owns it; ends swap every point.
    public func dirFor(_ team: TeamId) -> Dir { game.attackDir[team] }

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

    private func player(_ id: Int) -> AIPlayer? { players.first { $0.id == id } }

    private func nearestOnTeam(_ team: TeamId, to p: Vec3d) -> Int {
        players.filter { $0.team == team }
            .min { distXZ($0.pos, p) < distXZ($1.pos, p) }?.id
            ?? team * format.playersPerSide
    }

    // MARK: reads through the machine

    public var score: [Int] { game.score }

    /// The point's phase in the AI's four-word vocabulary.
    ///
    /// `Phase` has ten cases and `GamePhase` has four, so this is a projection and the
    /// two collapses in it are the interesting part:
    ///
    ///  - `PULL_IN_FLIGHT` becomes `.live`, not `.pull`. The AI lines up on the goal line
    ///    for `.pull`, and a receiving team that lines up while the pull is in the air
    ///    never catches one. `.live` is what puts `offenceInFlight` on the receivers and
    ///    `defenceInFlight` on the pulling team, which is a pull being played.
    ///  - `TURNOVER_DEAD` and `CHECK` become `.live` for the same reason: the offence's
    ///    grounded-disc branch is what sends the nearest body to pick the disc up, and it
    ///    only runs when the point is live.
    public var phase: GamePhase {
        switch game.phase {
        case .prePull: .setup
        case .pullInFlight, .livePossession, .discInFlight, .turnoverDead, .check: .live
        case .pointScored, .timeout, .halftime, .gameOver: .dead
        }
    }

    /// Which team is on offence.
    ///
    /// The machine reports no possession before a pull is caught; the receiving team is
    /// the answer the AI needs there, because they are the ones about to have it.
    public var possession: TeamId { game.possession ?? game.receivingTeam }

    /// Which way team 0 attacks; team 1 attacks the other way.
    public var attackDir: Dir { game.attackDir[0] }

    /// Sim seconds since the opening pull. The machine's clock, which stops when it does.
    public var clock: Double { game.clock }

    /// Whoever is holding, else nil.
    ///
    /// Asked of the **disc**, not of the rules: `GameState.thrower` stays set through a
    /// throw's whole flight, because the offence still has a thrower until somebody
    /// catches it. "Is it in a hand" is a question about the disc and is answered there.
    /// The two agree during a live possession by construction — the disc is only ever put
    /// into the hand the machine named.
    public var carrier: Int? { disc.mode == .held ? disc.holderId : nil }

    /// Whoever is holding, under the name the view already used.
    public var holder: Int? { carrier }

    /// The count the marker has reached, 0…`stallMax`.
    ///
    /// **This changed meaning and the change is the point of the exercise.** It used to be
    /// seconds since the possession began, which ran whether or not anybody was marking.
    /// It is now `GameState`'s count, which only advances while a marker is legally within
    /// range of the thrower — so a thrower nobody is marking is not on a count at all.
    public var stall: Double { Double(game.stallCount) }

    /// Seconds of legal marking accumulated on this possession — the elapsed time the
    /// count is derived from, which is what a smooth on-screen dial wants.
    public var possessionTime: Double { game.stallElapsed }

    /// The team that just scored, held for `scoreFlash` seconds so a callout can be read.
    ///
    /// Derived from the machine's `POINT_SCORED` phase and its timer rather than latched
    /// here, so there is nothing to clear and nothing to leak into the next point.
    public var justScored: TeamId? {
        guard game.phase == .pointScored, game.phaseTimer < Engine.scoreFlash else { return nil }
        return game.lastScore?.team
    }

    /// How possessions ended, in the play layer's summary vocabulary.
    ///
    /// Every field is derived: five come straight off the machine's team totals, and the
    /// throwaway/out-of-bounds split — which `TeamStats` does not carry separately — is
    /// counted from the `turnover` events the machine emits. Nothing here is incremented
    /// by hand at a decision site, so it cannot disagree with the box score.
    public var stats: MatchStats {
        let a = game.teamStats(0)
        let b = game.teamStats(1)
        var s = MatchStats()
        s.throwsMade = a.attempts + b.attempts
        s.completions = a.completions + b.completions
        s.blocks = a.blocks + b.blocks
        s.goals = a.goals + b.goals
        s.stalled = a.stallOuts + b.stallOuts
        s.grounded = sink.grounded
        s.outOfBounds = sink.outOfBounds
        return s
    }

    // MARK: the tick

    /// Advance one fixed tick. `dt` is expected to be `1/120`; anything else works but a
    /// replay is only reproducible if the sequence of `dt`s is.
    public func step(dt: Double) {
        guard !isOver else { return }

        // 1. The rules machine, fed what the bodies looked like at the end of the last
        //    tick. This is where the clock runs, where the count ticks, and where a
        //    post-score delay, a timeout or halftime expires.
        game.step(dt, observation())
        if isOver { return }

        // 2. Whatever the resulting phase demands of the play layer.
        servicePhase()

        let world = buildWorld()

        // 3. Both AIs decide. Team order is fixed rather than alternating, because the
        //    two calls draw from independent forked streams and swapping them would
        //    change nothing except make a replay depend on the order.
        var intents: [PlayerIntent] = []
        for team in ai { intents.append(contentsOf: updateTeam(team, world, dt)) }

        // 4. Bodies move. Locomotion owns position and velocity from here.
        loco.apply(intents.map(Engine.locoIntent), dt: dt, world: &records)

        // 5. Write the bodies back onto the AI's records. `syncTo` has already updated
        //    `records`; this is the copy back into the objects the AI reads next tick.
        for r in records {
            guard let p = player(r.id) else { continue }
            if let pos = r.pos { p.pos = pos }
            if let vel = r.vel { p.vel = vel }
            p.airborne = r.airborne
            tickStamina(p, dt)
        }

        // 6. Any throw the AI released becomes a real flight — but only for a team the
        //    computer is playing. `autoTeams` was declared and never consulted in the
        //    first version of this file, so the AI threw for the human's side too and
        //    the player never got to make a decision. The checks caught it by asserting
        //    that with the computer switched off entirely, somebody is still holding.
        for intent in intents {
            guard case .throw(let type, let aim, _, _, let spin, let receiver, _) = intent.action
            else { continue }
            guard let p = player(intent.id), autoTeams.contains(p.team) else { continue }
            releaseThrow(by: intent.id, type: type, aim: aim, spin: spin, receiver: receiver)
            break  // one disc
        }

        // 7. The disc. The count is no longer in this list, because the count is not a
        //    timer here any more — it is the marker's, and it ran in step 1.
        stepDisc(dt: dt)
    }

    /// What the machine is told about the frame that just finished.
    ///
    /// This is the whole reason the count means something. `GameState.tickStall` refuses
    /// to advance unless `markerState == .legal`, and `markerState` is whatever the last
    /// observation said — so an engine that never fills this in has a count that never
    /// runs, and an engine that fills it in wrongly has one that runs when nobody is
    /// marking. The marker itself is the defending `TeamAI`'s own read, which is the same
    /// player it is drawing the mark for.
    ///
    /// `pivotFoot` is deliberately **not** reported; see the note on `travels` in the
    /// engine's report. Locomotion has no pivot constraint, so a thrower drifts a metre
    /// while he looks the field off and every held frame would read as a travel.
    private func observation() -> FrameObservation {
        var obs = FrameObservation()
        obs.discPos = disc.state.pos

        guard let c = carrier, let holder = player(c) else {
            // Nobody is holding, so there is nobody to mark and the count may not run.
            // `.null` is not `.unreported`: the first says so, the second would leave the
            // last frame's mark standing over a disc that is in the air.
            obs.markerId = .null
            return obs
        }
        obs.throwerPos = holder.pos

        let defence = otherTeam(holder.team)
        let markerId = ai.count > defence ? ai[defence].marker : -1
        if markerId >= 0, let marker = player(markerId) {
            obs.markerId = .value(markerId)
            obs.markerPos = .value(marker.pos)
        } else {
            obs.markerId = .null
        }
        obs.defenders = players.filter { $0.team == defence }.map { Observed(id: $0.id, pos: $0.pos) }
        obs.offence = players.filter { $0.team == holder.team }.map { Observed(id: $0.id, pos: $0.pos) }
        return obs
    }

    /// The duties a phase puts on the play layer, before anybody decides anything.
    private func servicePhase() {
        switch game.phase {
        case .prePull:
            if stagedPoint != game.point { stagePoint() }
            // A computer-run team pulls as soon as its line is standing. A human one gets
            // until the deadline to pull for itself; see `humanRelease`.
            let waited = game.phaseTimer
            let mine = !autoTeams.contains(game.pullingTeam)
            if waited >= (mine ? Engine.pullDeadline : Engine.pullSettle) { autoPull() }
        case .turnoverDead:
            collectDeadDisc()
        case .check:
            // Nobody is modelled tapping the disc in, so the defence taps it at once.
            // A check that never happens is a possession that never restarts.
            demand(game.check())
            syncDisc()
        default:
            break
        }
    }

    // MARK: the pull

    /// Send a pull on its way and report it. Everything about the throw is the caller's.
    ///
    /// The engine used to start each point from a *caught* pull — a shortcut inherited
    /// from the deleted interim engine — which meant `PULL_IN_FLIGHT`, `pullCaught`,
    /// `pullLanded`, `pullOutOfBounds` and the brick mark were all ported and all dead.
    @discardableResult
    private func releasePull(_ req: ThrowRequest) -> Bool {
        guard game.phase == .prePull, carrier == puller else { return false }
        let vel = disc.release(req)
        thrownBy = puller
        intendedReceiver = nil
        return demand(game.pull(puller, req.from, vel))
    }

    /// The pull the computer throws: downfield, into the middle of the receiving half.
    ///
    /// A pull that lands in the middle is the one a receiving team has to come and get.
    /// One aimed at the back of the endzone sails out, which under WFDF 12.4 hands the
    /// receivers the brick — a worse result for the pulling team than a short pull.
    private func autoPull() {
        guard let p = player(puller) else { return }
        let dir = Double(dirFor(game.pullingTeam))
        let landZ = dir * format.field.goalLine * 0.6
        let flat = Vec3d(-p.pos.x, 0, landZ - p.pos.z)

        var req = ThrowRequest(
            type: .backhand,
            from: Vec3d(p.pos.x, 1.25, p.pos.z),
            aim: flat.lengthSq < 1e-9 ? Vec3d(0, 0, dir) : flat.normalized,
            power: 1,
            // A pull is hucked up. The hang is what gives the receiving team the time to
            // read it, and it is the difference between a pull and a long pass.
            angle: 0.30,
            spin: 0.9,
            hand: p.handed == .left ? .left : .right)
        req.power = solvePower(req, wantRange: flat.length)
        releasePull(req)
    }

    /// The release power that puts a throw down about `wantRange` metres away.
    ///
    /// A bisection on the flight model rather than a fitted curve, because the two pitches
    /// this game runs on differ by a factor of nearly three in length and one constant
    /// cannot serve both: full power on the regulation field is a pull and on the minis
    /// pitch is a disc in the car park. `probeThrow` integrates the same physics the real
    /// flight will use, so the answer is the model's rather than a guess about it.
    ///
    /// Deterministic and side-effect free as far as the sim is concerned: `probeThrow`
    /// touches only `DiscRuntime`'s prediction scratch, which nothing branches on.
    private func solvePower(_ base: ThrowRequest, wantRange: Double) -> Double {
        var lo = 0.0
        var hi = 1.0
        var req = base
        // Twelve halvings resolve power to about one part in 4,000, which on the longest
        // pitch here is a couple of centimetres of carry.
        for _ in 0..<12 {
            let mid = (lo + hi) * 0.5
            req.power = mid
            if disc.probeThrow(req, catchY: 0.15).dist < wantRange { lo = mid } else { hi = mid }
        }
        return (lo + hi) * 0.5
    }

    /// A pull in the air: caught, landed, or out.
    private func resolvePull(from previous: Vec3d) {
        let pos = disc.state.pos
        if !format.field.isInBounds(pos) {
            let crossing =
                format.field.boundaryCrossing(previous, pos)?.point
                ?? format.field.clampToField(pos)
            // Choose the brick immediately: there is no interface for a captain to pick,
            // and leaving the choice pending would park the machine in TURNOVER_DEAD with
            // `pickUp` refusing until somebody answered.
            demand(game.pullOutOfBounds(crossing, .brick))
            syncDisc()
            return
        }

        // The receiving team is the offence for the purpose of the contest. A pulling
        // player who gets to it first is handled by the machine: touching your own pull
        // hands it to the receivers where it was touched.
        if pos.y < 2.3, pos.y > 0.15, let taker = contestWinner(offence: game.receivingTeam) {
            guard let p = player(taker) else { return }
            demand(game.pullCaught(taker, Vec3d(p.pos.x, 0, p.pos.z)))
            syncDisc()
            return
        }

        if disc.state.atRest {
            demand(game.pullLanded(Vec3d(pos.x, 0, pos.z)))
            syncDisc()
        }
    }

    // MARK: dead discs

    /// Somebody has to walk over and pick it up.
    ///
    /// The AI already knows how: `TeamAI.offence` has a grounded-disc branch that sends
    /// the nearest body sprinting to the disc and raises a `.pickup` action inside 1.1 m.
    /// This is the half that turns that action into the rules event, and it also picks the
    /// disc up on proximity alone — a collector who arrives without the action still has
    /// his hands on it, and a possession that waits for a flag is a game that stops.
    private func collectDeadDisc() {
        // Get it out of the old thrower's hand first.
        //
        // A stall-out is the one turnover the disc never physically leaves anyone on: the
        // machine takes the possession away, but nothing here had told the runtime to let
        // go, so the disc stayed held by a player who no longer had it. The invariant that
        // the disc's hand and the machine's thrower agree then failed on every tick of the
        // dead phase.
        //
        // It went unnoticed because the AI never stalled — it releases well inside a
        // ten-count — so the path only opened when the count was shortened and the AI
        // began running out of time. A legal, reachable outcome that no play had reached.
        if disc.holderId != nil, game.thrower == nil {
            disc.settle(game.discPos)
        }

        guard let team = game.possession else { return }
        if game.awaitingPullChoice() { return }
        let spot = game.discPos
        var best = -1
        var bestD = Double.infinity
        for p in players where p.team == team {
            let d = distXZ(p.pos, spot)
            if d < bestD {
                bestD = d
                best = p.id
            }
        }
        guard best >= 0, bestD <= DISC_GRAB_R else { return }
        demand(game.pickUp(best))
        syncDisc()
    }

    // MARK: the world the AI reads

    /// Assemble the world the AI reads. Rebuilt each tick rather than mutated, because a
    /// stale field here is invisible and produces decisions from last frame's positions.
    private func buildWorld() -> AIWorld {
        var w = AIWorld()
        w.time = game.clock
        w.players = players
        w.possession = possession
        w.phase = phase
        w.score = game.score
        w.scoreCap = game.target
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
            // The count the marker has actually produced. `TeamAI` runs its own marking
            // clock as well and deliberately watches both — see its `stallRead`.
            stall: Double(game.stallCount),
            spin: disc.state.spin,
            throwType: aiThrowType(disc.state.throwType))
        return w
    }

    private var discPhase: DiscPhase {
        if carrier != nil { return .held }
        return disc.mode == .flight && !disc.state.atRest ? .flight : .ground
    }

    /// The AI's throw vocabulary is five; the aero table's is six. Everything the AI can
    /// choose exists in the aero table, so this never fails in practice — but it returns
    /// an optional rather than force-unwrapping, because a blade arriving here would mean
    /// something upstream changed and a crash is a poor way to learn that.
    private func aiThrowType(_ t: ThrowType?) -> AIThrowType? {
        guard let t else { return nil }
        return AIThrowType(rawValue: t.rawValue)
    }

    /// The whole AI-to-locomotion contract, as one pure function.
    ///
    /// Public and static because it is a *contract*, not an implementation detail: it is
    /// the single point where the ported AI's vocabulary becomes the ported locomotion's,
    /// and both sides of it are separately validated to bit-exactness while the join
    /// between them is not. Exposing it is what lets the join be asserted at all.
    public static func locoIntent(_ i: PlayerIntent) -> IntentLike {
        IntentLike(
            id: i.id,
            targetX: i.targetX, targetZ: i.targetZ,
            faceX: i.faceX, faceZ: i.faceZ,
            mode: i.mode.rawValue,
            effort: i.effort,
            desiredSpeed: i.desiredSpeed,
            maxSpeed: i.maxSpeed,
            arriveRadius: i.arriveRadius,
            action: Engine.locoAction(i.action))
    }

    /// Translate the AI's action into the one-shot locomotion understands.
    ///
    /// This was `nil` and the omission was subtle rather than obvious, which is why it
    /// survived: locomotion also reads `intent.mode`, so `"jump"` and `"layout"` still
    /// fired and players still left the ground. What was silently dropped is the bid's
    /// **target point**, and `stepIntent` uses it to aim the dive:
    ///
    ///     if action.kind == "bid", let ax = action.x, let az = action.z {
    ///         out.dir = (toward that point)
    ///     }
    ///
    /// Without it a layout extends along whatever heading the player already had, not at
    /// the disc — which looks almost right, and is the difference between a bid that
    /// reaches and one that lands a body's length short.
    ///
    /// Only the two locomotion acts on are translated. A throw, a catch or a stall are
    /// decisions for the rules machine, not instructions for a body, and passing them
    /// here would be inventing a meaning locomotion does not have.
    public static func locoAction(_ a: PlayerAction?) -> IntentAction? {
        switch a {
        case .bid(let x, let z, _): IntentAction(kind: "bid", x: x, z: z)
        case .jump: IntentAction(kind: "jump")
        default: nil
        }
    }

    // MARK: the disc

    private func releaseThrow(
        by id: Int, type: AIThrowType, aim: Vec3d, spin: Double, receiver: Int
    ) {
        guard game.phase == .livePossession, carrier == id, let thrower = player(id) else { return }
        guard let physType = ThrowType(rawValue: type.rawValue) else { return }

        // Aim carries the AI's intended landing point; the throw table turns a direction
        // and a power into a release. Power is solved from the range the AI wants rather
        // than passed through, because `maxThrowRange` and `throwSpeed` are two different
        // curves and the AI reasons in the first.
        let flat = Vec3d(aim.x - thrower.pos.x, 0, aim.z - thrower.pos.z)
        let range = flat.length
        let dir = flat.lengthSq < 1e-9 ? Vec3d(0, 0, Double(dirFor(thrower.team))) : flat.normalized

        let from = Vec3d(thrower.pos.x, 1.25, thrower.pos.z)
        let req = ThrowRequest(
            type: physType,
            from: from,
            aim: dir,
            power: clamp01((range - 4) / 26),
            angle: range > 18 ? 0.10 : 0,
            spin: clamp01(spin),
            hand: thrower.handed == .left ? .left : .right)
        let vel = disc.release(req)

        thrownBy = id
        intendedReceiver = receiver
        demand(
            game.release(
                playerId: id, pos: from, vel: vel, spin: req.spin, throwType: physType.rawValue))
    }

    private func stepDisc(dt: Double) {
        // Held: the disc rides with the holder's hand.
        if let c = carrier, let p = player(c) {
            disc.hold(c, Vec3d(p.pos.x, 1.1, p.pos.z), Vec3d(0, 1, 0))
            return
        }
        guard disc.mode == .flight else { return }

        let previous = disc.state.pos
        disc.step(dt: dt)

        switch game.phase {
        case .pullInFlight: resolvePull(from: previous)
        case .discInFlight: resolveFlight(from: previous)
        default:
            // A disc in the air with no flight phase to report it into is a desync, and a
            // desync that is left alone is a match that never restarts. Park it, and say
            // so loudly enough that the checks can fail on it.
            note("a disc was in flight during \(game.phase.rawValue)")
            syncDisc()
        }
    }

    /// A thrown disc in the air: caught, blocked, thrown away, or out.
    private func resolveFlight(from previous: Vec3d) {
        let pos = disc.state.pos
        if !format.field.isInBounds(pos) {
            demand(game.outOfBoundsSegment(previous, pos))
            syncDisc()
            return
        }

        // A catch. The receiver attacks the disc, so an offensive player wins a contest
        // unless a defender is clearly closer — the same rule the interim engine landed
        // on, and for the same measured reason: a defender trails on the side a throw
        // arrives from, so "nearest" alone hands the defence almost everything.
        if pos.y < 2.3, pos.y > 0.15, let taker = contestWinner(offence: possession) {
            guard let p = player(taker) else { return }
            // Everything a catch can be — completion, goal, interception, caught out of
            // bounds — is the machine's decision, not this file's.
            demand(game.catchDisc(taker, Vec3d(p.pos.x, 0, p.pos.z)))
            syncDisc()
            return
        }

        if disc.state.atRest {
            demand(game.ground(Vec3d(pos.x, 0, pos.z)))
            syncDisc()
        }
    }

    /// Who comes down with it, or nil if nobody is close enough.
    private func contestWinner(offence: TeamId) -> Int? {
        let pos = disc.state.pos
        var bestOff = -1
        var bestOffD = DISC_GRAB_R
        var bestDef = -1
        var bestDefD = DISC_GRAB_R
        for p in players {
            if p.id == thrownBy && disc.state.t < 0.35 { continue }
            let d = distXZ(p.pos, pos)
            guard d < DISC_GRAB_R else { continue }
            if p.team == offence {
                if d < bestOffD {
                    bestOffD = d
                    bestOff = p.id
                }
            } else if d < bestDefD {
                bestDefD = d
                bestDef = p.id
            }
        }
        if bestOff >= 0 && (bestDef < 0 || bestDefD > bestOffD - BID_EDGE) { return bestOff }
        return bestDef >= 0 ? bestDef : nil
    }

    /// Put the physical disc where the machine now says it is.
    ///
    /// Called after every reported action, and it is what keeps `carrier` — which is read
    /// off the disc — agreeing with `game.thrower`. One function rather than a line at
    /// each call site, because the failure mode of forgetting one is a disc that is in
    /// nobody's hand while the rules think a possession is live.
    private func syncDisc() {
        switch game.phase {
        case .livePossession, .check, .timeout:
            guard let t = game.thrower, let p = player(t) else { return }
            disc.hold(t, Vec3d(p.pos.x, 1.1, p.pos.z), Vec3d(0, 1, 0))
            thrownBy = nil
            intendedReceiver = nil
            // Control follows the disc, which is the decision recorded in the plan: you
            // are always the player with a decision to make.
            if p.team == 0 { controlled = t }
        case .prePull:
            // The puller holds it. He is *not* the machine's `thrower` — the offence has
            // no thrower until the pull is caught — which is the one moment in a point
            // where the disc is in a hand and the rules name nobody.
            guard let p = player(puller) else { return }
            disc.hold(puller, Vec3d(p.pos.x, 1.1, p.pos.z), Vec3d(0, 1, 0))
            thrownBy = nil
            intendedReceiver = nil
            if p.team == 0 { controlled = puller }
        case .turnoverDead, .pointScored, .halftime, .gameOver:
            disc.settle(Vec3d(game.discPos.x, 0, game.discPos.z))
            thrownBy = nil
            intendedReceiver = nil
            if game.possession == 0 { controlled = nearestOnTeam(0, to: disc.state.pos) }
        case .pullInFlight, .discInFlight:
            break
        }
    }

    // MARK: the human

    /// Release a throw on behalf of the controlled player.
    ///
    /// The gesture mapping is `ThrowGesture`, in the sim and asserted there. This only
    /// turns the resulting throw into a disc, and it refuses when the controlled player is
    /// not actually holding — a human cannot throw a disc they do not have, and silently
    /// doing nothing is better than teleporting one into their hand.
    ///
    /// **A pull is a throw and the human gets to make it.** When the point has not started
    /// and the controlled player is the one with the disc on the line, the gesture pulls;
    /// `PRE_PULL` and `LIVE_POSSESSION` are therefore the only two phases this does
    /// anything in, and in both of them the test is the same one — are you holding it. If
    /// the thumb never arrives, `pullDeadline` pulls for them.
    @discardableResult
    public func humanRelease(
        _ type: ThrowType, aim: Vec3d, power: Double, loft: Double = 0
    ) -> Bool {
        guard let c = carrier, c == controlled, let thrower = player(c) else { return false }

        let from = Vec3d(thrower.pos.x, 1.25, thrower.pos.z)
        let req = ThrowRequest(
            type: type,
            from: from,
            aim: aim,
            power: power,
            angle: loft,
            spin: 0.6,
            hand: thrower.handed == .left ? .left : .right)

        switch game.phase {
        case .prePull:
            return releasePull(req)
        case .livePossession:
            let vel = disc.release(req)
            thrownBy = c
            intendedReceiver = nil
            return demand(
                game.release(
                    playerId: c, pos: from, vel: vel, spin: req.spin, throwType: type.rawValue))
        default:
            // A check, a stoppage, a disc in the air: the machine would refuse it and so
            // does this, rather than putting a second disc into the sky to find out.
            return false
        }
    }

    /// Is the disc in the air right now?
    ///
    /// The interim engine spelled this as a `PlayPhase.flight(by:)` case carrying the
    /// thrower. Here `GamePhase` is the ported vocabulary — setup, pull, live, dead —
    /// which is about the *point*, not the disc, so "in flight" is a question about the
    /// disc and is answered from the disc.
    public var discInFlight: Bool { disc.mode == .flight && !disc.state.atRest }

    /// Who threw the disc that is currently in the air, if one is.
    public var thrower: Int? { discInFlight ? thrownBy : nil }

    // MARK: refusals

    /// Record a refusal. Returns what the machine said, so callers can bail on it.
    @discardableResult
    private func demand(_ result: ActionResult) -> Bool {
        if !result.ok { note(result.note ?? "refused with no reason given") }
        return result.ok
    }

    private func note(_ text: String) {
        if refusals.count < Engine.maxRefusals {
            refusals.append("\(game.phase.rawValue) @ \(clock)s: \(text)")
        }
    }
}

// MARK: - the event tally

/// Turns the machine's `turnover` events into the play layer's summary.
///
/// A class, and constructed before the `GameState` that feeds it, because `GameState`
/// takes its emitter at construction — before `Engine` exists to be captured. Nothing
/// here decides anything: every number is a count of a decision the machine already made
/// and emitted, which is the difference between a derived tally and a second set of books.
///
/// Only the throwaway/out-of-bounds split is counted here. Everything else `MatchStats`
/// carries is already a team total on the box score and is read from there.
private final class EngineEventSink {
    /// Throws that hit the ground in bounds with nobody on them.
    var grounded = 0
    /// Discs that left the field, thrown or carried.
    var outOfBounds = 0

    func absorb(_ event: GameEvent) {
        guard case .turnover(let reason, _, _, _, _, _, _, _) = event else { return }
        switch reason {
        case .throwaway: grounded += 1
        case .outOfBounds, .caughtOutOfBounds: outOfBounds += 1
        default: break
        }
    }
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
