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
/// **This file's header used to say `src/sim/Game.ts` was "not a port target: it imports
/// three.js … integration glue rather than simulation". That sentence was wrong, and it
/// cost the project months.** Nobody read the file, and so the throw solver, the catch
/// resolution and the out-of-bounds rule were all *invented* here — each of them sitting a
/// few hundred lines away from a measured reference answer, and each of them wrong in a
/// way that made the offence stop attacking. `Game.ts` is 3,400 lines and much of it
/// genuinely is glue: renderers, cameras, the input layer, the attract-mode tableaux. The
/// simulation inside it is not, and the parts of this file that correspond to it are now
/// translated rather than guessed — `aiThrow`, `tryCatch`, `stepDisc`, `releaseOrigin`,
/// `contestCount` — with the divergences that remain marked as scope rather than left
/// silent.
///
/// `BID_EDGE` and the `contestWinner`/`contestAir` catch that replaced it are both gone.
/// Neither was the reference's answer: `contestAir` is `Locomotion`'s own API, which the
/// AI uses to *predict* a contest, and the reference resolves an actual catch with a
/// probability roll against `catchProbability`. See `tryCatch`.
///
/// What that means for trust, stated plainly: every *component* here is validated to
/// bit-exactness or near it against the TypeScript, and `GameState` is 3,098 assertions
/// against a scripted trace. The wiring is still not differentially validated — there are
/// no goldens for `Game.ts` — so the checks in `EngineTests` remain property assertions: a
/// pull is thrown, the count only runs while a marker is legally on the thrower, no
/// reported action is ever refused, nobody leaves the pitch, one seed is one match. That
/// is a weaker bar, honestly labelled. What it now has alongside it is a *behavioural*
/// comparison: `tools/test-game.ts` runs the reference headless, and the numbers it prints
/// — points, throws, completions per ten minutes — are the target this engine is measured
/// against.
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
    public internal(set) var players: [AIPlayer] = []
    public internal(set) var loco = Locomotion()
    public internal(set) var ai: [TeamAI] = []
    public internal(set) var disc = DiscRuntime()
    /// The match's breeze. Fed to both the flight model and the AI's world — the reference
    /// sets both from one vector and they must not drift apart.
    public private(set) var wind = Vec3d.zero
    /// The player the human is controlling, always on team 0.
    public internal(set) var controlled = 0

    let rng: Rng
    private let sink: EngineEventSink
    /// Locomotion's contact events, buffered for the tick that reads them. A separate
    /// object rather than a closure over `self`, because the host is bound during `init`.
    var contacts: ContactSink?
    var records: [WorldPlayerRecord] = []
    /// Who last released the *physical* disc, which is not the same question as
    /// `game.thrower`.
    ///
    /// During a pull the machine has no thrower at all — a puller is not the offence's
    /// thrower and `beginPoint` leaves `thrower` nil — but the contest still has to know
    /// whose hand the disc has just left, so that he cannot catch it back off his own
    /// fingertips. This is a fact about the disc, not about the rules, which is why it
    /// lives here and is cleared the moment the disc is in somebody's hand again.
    var thrownBy: Int?
    var intendedReceiver: Int?

    /// What the last AI release was asked for, so a check can ask whether it was delivered.
    ///
    /// **This exists because no match-level statistic can express the throw solver's actual
    /// property.** Mutation testing of `releaseThrow` found that deleting the lateral-drift
    /// correction, discarding the elevation bisection entirely, replacing `powerForSpeed`
    /// with a constant, and solving to the ground instead of to chest height *all* left the
    /// suite green — because a game where every throw misses can still score, just
    /// differently. The question "did the disc arrive where the AI aimed" has to be asked
    /// directly, and asking it needs the aim.
    public struct ThrowAim: Sendable {
        public let from: Vec3d
        /// The point the AI wanted the disc to arrive at, its own error already included.
        public let aim: Vec3d
        /// The release speed the AI asked for, m/s.
        public let speed: Double
    }
    public private(set) var lastThrowAim: ThrowAim?

    /// Flight bookkeeping, ported from `Game.ts`.
    ///
    /// A disc is only in or out **where it comes to ground**. Testing it every tick of the
    /// flight, which is what this file used to do, makes any throw that bows over the
    /// sideline and back an instant turnover — and on the minis pitch, whose sideline is
    /// nine metres from the middle, that is most of the curving throws in the sport. So
    /// the last in-bounds point is remembered instead, and the judgement is made once, at
    /// the moment the disc actually lands.
    private var lastInBounds = Vec3d.zero
    private var hadInBounds = false
    private var flightSettled = false

    /// What each player's AI asked for this frame.
    ///
    /// The catch needs it: a defender may only play a disc they have actually *attacked*.
    /// Without this, a marker standing at the rules' 2.15 m mark distance intercepted any
    /// throw that passed within arm's reach of him, on the release tick, without ever
    /// bidding for it — which is a large part of why the offence had stopped throwing
    /// downfield at all.
    var actionOf: [Int: PlayerAction] = [:]
    /// The point number the bodies were last stood up for. See `stagePoint`.
    var stagedPoint = -1

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

    /// The four latches and the tally the self-officiated calls run on. See
    /// `EngineCalls.swift`, which owns every detector that reads or writes them.
    let calls = CallState()

    /// What the thumb has last been judged to mean. See `EngineHuman.swift`, which owns
    /// every line that reads or writes it.
    let human = HumanInput()

    /// Who the human's last drag was judged to mean, and what the assist did about it.
    /// Read by the HUD, so the player can see who they are throwing to before it leaves.
    public var selectedReceiver: Int? { human.selectedReceiver }
    public var lastAssist: HumanTargeting.Assist? { human.lastAssist }

    /// The defensive commitment in force, if any. Read by the HUD; written only by
    /// `humanDefend` and by the tick that expires it.
    public var defensiveCommit: DefensiveCommit? { human.commit }

    /// The cut the human last called, while it is still worth drawing. Read by the HUD;
    /// written only by `humanCallCut` and by the tick that fades it. Nothing in the
    /// simulation reads it — see `CalledCut`.
    public var calledCut: CalledCut? { human.calledCut }

    /// Whether a cut may be called right now. The HUD greys its prompt on this rather than
    /// inventing a second copy of the rule.
    public var canCallCut: Bool {
        human.callCooldown <= 0 && game.phase == .livePossession && carrier == controlled
    }

    /// Calls made this match, by kind, plus how many of them were contested.
    /// Telemetry only — nothing in the simulation reads it.
    public var callTally: CallTally { calls.tally }

    /// The rule set in force. `GameState` owns it; this is the read.
    public var rules: RuleSet { game.rules }

    /// Every tuning knob this engine reads: pacing waits, the per-side style table, the
    /// human-assist geometry, the match length. `.default` is today's engine exactly;
    /// each field's story lives on the field. Fixed at construction because most of what
    /// it sets — the rules, the rosters, the first point's `TeamAI`s — is spent by the
    /// time `init` returns.
    public let config: EngineConfig

    /// True once the machine has declared the game over. Not a score comparison: the
    /// caps, the win-by margin and the point cap all decide this and they all live in
    /// `GameState`.
    public var isOver: Bool { game.phase == .gameOver }

    /// How willing both offences are to let it go, 0.6 (conservative) to 1.6 (gunner).
    ///
    /// The reference's own knob, and the only honest lever on pacing. Shortening the
    /// count looks like the obvious one and is not available — see the rules override in
    /// `init` — because `TeamAI` hardcodes the ten it paces itself against. This scales
    /// the *threshold a throw must clear*, so a higher value takes the same looks sooner
    /// rather than inventing worse ones.
    ///
    /// Changing it after kickoff has no effect until the next point, since each point
    /// builds fresh `TeamAI`s. Starts at `config.aggression`.
    public var aggression: Double

    /// Teams whose throws the computer makes. Defaults to the opponent only; set both and
    /// the game plays itself, which is how the checks run it headlessly.
    ///
    /// The **pull is not an AI throw** and is not gated by this: it is a rules event the
    /// machine demands before a point can start, so it happens with the computer switched
    /// off entirely. That is what makes a human-only engine reach a live possession at all.
    ///
    /// Starts at `config.autoTeams`.
    public var autoTeams: Set<TeamId>

    public init(
        format: GameFormat = .minis,
        target: Int? = nil,
        seed: UInt32 = 0x5eed_c0de,
        config: EngineConfig = .default
    ) {
        self.format = format
        precondition(!config.sideStyles.isEmpty, "EngineConfig.sideStyles must not be empty")
        self.config = config
        self.aggression = config.aggression
        self.autoTeams = config.autoTeams
        // A minis game is to 7 and a regulation game to 15 — the same numbers
        // `FieldSpec` carried, kept here so the caller need not restate them. An explicit
        // `target:` still outranks the config's override, because that parameter predates
        // the config and the checks lean on it.
        let goal = target ?? config.pointsToWin ?? (format.playersPerSide <= 3 ? 7 : 15)
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
        //
        // `EngineConfig.startingPullTeam` is the toss, for the caller who needs the other
        // side of it. Nil is this line unchanged.
        opts.startingPullTeam = config.startingPullTeam ?? 0
        opts.rules = { r in
            r.gameTo = goal
            // Halftime at the midpoint of whatever length this game is, which reproduces
            // the regulation 8-of-15 and gives a minis game to 7 a break at 4 — unless
            // the config says otherwise.
            r.halftimeAt = config.halftimeAt ?? (goal + 1) / 2
            r.halftimeDuration = config.halftimeSeconds
            // Seventy seconds of dead frame is what the rule says; see the property doc.
            r.timeoutDuration = config.timeoutSeconds
            // The match clock. Both default to nil, which leaves the rules' own 0 —
            // "no clock" — in place, so an unconfigured engine is untimed exactly as it
            // has always been.
            if let t = config.softCapSeconds { r.softCapAt = t }
            if let t = config.hardCapSeconds { r.hardCapAt = t }
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

        // The day this match is played on. Still forked from its own salt so the draw does
        // not shift any other stream; the distribution and the argument for it now live in
        // `Playbook.drawWeather`, reached through `EngineConfig` so a mode can pin it.
        //
        // It was `.zero` once, and then a ±1.5 m/s breeze — neither of which
        // `Playbook.shouldPlayZone` can ever clear, so the zone defence, the upwind force
        // flip in `pickScheme` and the wind term in `maxThrowRange` were all unreachable.
        let w = rng.fork(salt: 0x117d)
        wind = config.wind(from: w)
        disc.wind = wind

        buildRoster()
        // Locomotion's event stream, for the contact impacts `policeCatch` needs. Only
        // `events` is set: `rand` would fork locomotion's RNG off this engine's and shift
        // every stream in the game, and `field` / `disc` are nil here exactly as they were
        // when nothing was attached at all, so this changes no behaviour on its own.
        let contacts = ContactSink()
        self.contacts = contacts
        attachContacts()
        game.startGame()
        stagePoint()
    }

    // MARK: setup

    /// Wire locomotion's event stream into the `ContactSink` that `policeCatch` reads.
    ///
    /// **This must be re-run every time `loco` is replaced, and `stagePoint` replaces it
    /// once a point.** `LocoHost` is a value held by the `Locomotion` instance, so a fresh
    /// instance has no host and emits into nothing. That is the whole of #55: the attach
    /// happened once in `init`, `stagePoint()` ran on the very next line to open the first
    /// point, and the stream was severed before a single tick of a single match had been
    /// simulated. Measured after the fact, `lastContact` was empty on every one of the
    /// twenty-one contests `policeCatch` reached across three full matches — so the
    /// receiving foul and the strip were not rare in the port, they were **unreachable**,
    /// and had been since the feature landed.
    ///
    /// Only `events` is set. `rand` would fork locomotion's RNG off this engine's and shift
    /// every stream in the game, and `field` / `disc` are nil here exactly as they were
    /// when nothing was attached at all.
    func attachContacts() {
        guard let contacts else { return }
        loco.attach(LocoHost(events: { [contacts] event in contacts.absorb(event) }))
    }

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
    func ratings(_ a: AIAttributes) -> [String: Double] {
        [
            "speed": a.speed,
            "acceleration": a.acceleration,
            "agility": a.agility,
            "jumping": a.jumping,
            "stamina": a.stamina,
        ]
    }

    func player(_ id: Int) -> AIPlayer? { players.first { $0.id == id } }

    /// The body carrying this id — **the lookup, not the subscript.**
    ///
    /// `holder`, `controlled`, `thrower` and every id on a `MatchEvent` are `PlayerId`s,
    /// and the app layer had been spending them as `players[id]` because `buildRoster`
    /// happens to deal `id == index` and nothing has ever reordered the array. That is a
    /// coincidence, not a contract: `setLine` exists precisely so a caller can start
    /// fielding substitutions, and the first line change that reorders `players` turns
    /// every one of those subscripts into an out-of-range crash — or worse, into a
    /// highlight drawn on the wrong athlete, which nothing would report at all.
    ///
    /// So there is one public read that goes through the id, it is the one the renderer
    /// uses, and `checkRosterIsIndexable` asserts the coincidence still holds everywhere
    /// it could be broken. Fourteen elements: the linear scan is not the cost.
    public func body(of id: PlayerId) -> AIPlayer? { player(id) }

    /// Where in `players` the body with this id sits, for the two callers that genuinely
    /// need a slot rather than a body — a parallel array of entities, say. Nil for an id
    /// no longer on the roster, which a raw subscript would have crashed on.
    public func index(of id: PlayerId) -> Int? { players.firstIndex { $0.id == id } }

    /// **`PlayerId` and "index into `players`" are the same number, and until now nothing
    /// said so.**
    ///
    /// The invariant is real and it is load-bearing: `buildRoster` deals
    /// `id = team * playersPerSide + i`, which is exactly `GameState.defaultRoster`'s
    /// numbering, and every `players[someId]` in the app layer is correct only because of
    /// it. It is also the invariant with no owner — `setLine` is documented as the seam a
    /// substitution system will arrive through, and a substitution that reorders or
    /// filters `players` breaks this silently in three different ways at once.
    ///
    /// Checked where it can be broken rather than where it is spent: after the roster is
    /// dealt and after every line declaration. `assertionFailure` traps a debug build on
    /// the spot; the `note` is what the release suite sees, because `EngineTests` asserts
    /// `refusals` stays empty through a full automated match — so a future substitution
    /// system cannot land this quietly.
    func checkRosterIsIndexable(_ site: String) {
        for (i, p) in players.enumerated() where p.id != i {
            note("roster is no longer indexable by id: players[\(i)].id == \(p.id) (\(site))")
            assertionFailure("players[\(i)].id == \(p.id); the app layer indexes by id (\(site))")
            return
        }
    }

    func nearestOnTeam(_ team: TeamId, to p: Vec3d) -> Int {
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
        // A TIMEOUT IS NOT A LINE-UP, and calling it `.dead` emptied the field.
        //
        // `TeamAI.update` sends every body to its own goal line for `.setup`, `.pull` and
        // `.dead` — right for a pull, catastrophic here. A timeout leaves the disc where it
        // was and the thrower on his pivot; the machine resumes at `.check` with the same
        // possession. Line the teams up for it and the whole offence, thrower included,
        // jogs twenty metres downfield during the stoppage and the possession teleports on
        // the check. `.live` is the honest answer to "is there a disc on this field in
        // somebody's hand" — and nothing can be thrown during the stoppage regardless,
        // because `releaseThrow` is gated on `.livePossession`. So both sides re-form
        // around the disc and neither can act, which is what the timeout is buying.
        case .timeout: .live
        case .pointScored, .halftime, .gameOver: .dead
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
        guard game.phase == .pointScored, game.phaseTimer < config.scoreFlash else { return nil }
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

    /// Everything that has happened since the last time this was asked, oldest first.
    ///
    /// The engine's answer to "what just happened" — see `MatchEvent` for why it is a
    /// drained buffer rather than a tap or a `lastEvent`. Call it once per tick, right
    /// after `step`, which is the cadence the fixed-tick loop already runs at.
    ///
    /// Nothing in the simulation reads this and nothing outside it can write to it, so a
    /// caller that never drains changes no outcome — it only loses the events past the
    /// buffer's cap.
    public func drainEvents() -> [MatchEvent] { sink.drain() }

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
        // The machine has flagged any travel; somebody still has to call it.
        policeTravel()
        policeCalls()

        // 2. Whatever the resulting phase demands of the play layer.
        servicePhase()

        let world = buildWorld()

        // 3. Both AIs decide. Team order is fixed rather than alternating, because the
        //    two calls draw from independent forked streams and swapping them would
        //    change nothing except make a replay depend on the order.
        var intents: [PlayerIntent] = []
        for team in ai { intents.append(contentsOf: updateTeam(team, world, dt)) }
        // A brain that could not find a body on its own roster says so here rather than
        // trapping on a `byId[...]!`. Same channel as everything else the machine refused,
        // because `EngineTests` asserts that channel is empty over a full match — see
        // `TeamAI.refusals` and `checkRosterIsIndexable`.
        for team in ai { for r in team.drainRefusals() { note(r) } }

        // 3b. The human's defensive commitment, over the top of the AI's intent for that
        //     one body. Before `actionOf` on purpose — see `applyDefensiveCommit`, and
        //     `catchBodies`, which reads `actionOf` for the flag that decides whether a
        //     defender may play the disc at all.
        applyDefensiveCommit(&intents, dt: dt)
        // 3c. The offensive command has nothing to apply here — a called cut is armed in
        //     `Mem.cut` at the moment it is called and the AI has already run it into
        //     `intents` above. All that is left is to age the ghost and the call cooldown.
        expireCalledCut(dt)

        actionOf.removeAll(keepingCapacity: true)
        for intent in intents where intent.action != nil { actionOf[intent.id] = intent.action }

        // 4. Bodies move. Locomotion owns position and velocity from here.
        //
        // Anchor the thrower before anyone steps. The soft separation tier runs *after*
        // locomotion, and without this a crowding marker walks the thrower off his own
        // pivot — which is a foul in the rules and free yardage in the sim: possession
        // advancing without a throw, the one thing the sport forbids. `anchored` is
        // honoured by both `Separation` and the contact resolver, and was never set.
        // …and through a TIMEOUT, which is mapped to a `.live` AI phase so both teams
        // re-form around the disc rather than lining up. The thrower must not join in: he
        // is still holding it and the pivot is still his. Unanchored he walks to whatever
        // stack slot the fresh plan gave him, measured at 83 m of drift over a twelve-second
        // timeout — not a drift, a possession carried the length of the field.
        let holding =
            game.phase == .livePossession || game.phase == .timeout || game.phase == .check
        let anchorId = holding ? game.thrower : nil
        for p in players {
            loco.get(p.id)?.anchored = p.id == anchorId
        }
        loco.apply(intents.map(Engine.locoIntent), dt: dt, world: &records)
        // Whatever the bodies did to each other on the way. Drained here rather than
        // handled in the sink so the recording happens on the engine's clock, in the tick
        // the collision belongs to.
        if let contacts {
            for (a, b, impact) in contacts.drain() {
                noteContact(a, b, impact)
                noteContact(b, a, impact)
            }
        }
        // The clamp, and then the sync **again**.
        //
        // `apply` syncs the bodies into `records` on its way out, so clamping after it left
        // the AI reading the unclamped copy — a body pinned on the run-off kept the outward
        // velocity this had just zeroed, and `tryCatch` mixed sources, taking its gap from
        // the stale `AIPlayer.pos` and its reach from the clamped `LocoPlayer`. Worse, the
        // check written to justify the clamp measures `AIPlayer.pos`, so it could only pass
        // while the clamp never actually did anything. The reference has one source of
        // truth: it clamps the body and copies loco → ai at the top of the next frame.
        keepOnField()
        loco.syncTo(&records)

        // 5. Write the bodies back onto the AI's records. `syncTo` has already updated
        //    `records`; this is the copy back into the objects the AI reads next tick.
        for r in records {
            guard let p = player(r.id) else { continue }
            if let pos = r.pos { p.pos = pos }
            if let vel = r.vel { p.vel = vel }
            p.airborne = r.airborne
        }
        // `tickStamina` is deliberately NOT called here. `TeamAI.update` already runs it
        // over its own side's `AIPlayer` objects, and `AIPlayer` is a class — so a second
        // pass over the same references drained every player at twice the validated rate.
        // Fatigue feeds `effectiveMaxSpeed`, so that was two-for-one on every cut, every
        // close-out and every separation estimate the AI made. The reference's `update`
        // does not call it either; it is `updateTeam`'s job alone.

        // 6. Any throw the AI released becomes a real flight — but only for a team the
        //    computer is playing. `autoTeams` was declared and never consulted in the
        //    first version of this file, so the AI threw for the human's side too and
        //    the player never got to make a decision. The checks caught it by asserting
        //    that with the computer switched off entirely, somebody is still holding.
        for intent in intents {
            guard case .throw(let type, let aim, let speed, _, _, let receiver, _) = intent.action
            else { continue }
            guard let p = player(intent.id), autoTeams.contains(p.team) else { continue }
            releaseThrow(by: intent.id, type: type, aim: aim, speed: speed, receiver: receiver)
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
    /// `pivotFoot` IS reported now, and only when there is one to report.
    ///
    /// It used to be left out with a note that locomotion had no pivot constraint, so a
    /// thrower drifted a metre while he looked the field off and every held frame would
    /// have read as a travel. `Locomotion.stepPivot` is that constraint: it gives a
    /// receiver the steps the rules owe him, establishes a foot where he stops, and
    /// holds him to `PIVOT_R` of it thereafter. `pivotOf` reports the foot only once it
    /// is established — during the momentum allowance there is no pivot yet, and a
    /// receiver who is still stopping has no foot that could have moved.
    private func observation() -> FrameObservation {
        var obs = FrameObservation()

        // **The physics owns the disc while it is live; the RULES own it while it is dead.**
        //
        // This used to report the physical position unconditionally. `deadDisc()` has
        // already walked the disc to a legal spot on the line, and reporting where it
        // physically came to rest puts it back out of bounds where nobody can legally
        // reach it — so the machine was being told, every tick of a dead phase, that its
        // own considered decision was wrong. In `PRE_PULL` it was worse than that: the
        // machine's `discPos` was being continuously overwritten with the puller's hand.
        if game.phase != .turnoverDead, game.phase != .prePull {
            obs.discPos = disc.state.pos
        }

        guard let c = carrier, let holder = player(c) else {
            // Nobody is holding, so there is nobody to mark and the count may not run.
            // `.null` is not `.unreported`: the first says so, the second would leave the
            // last frame's mark standing over a disc that is in the air.
            obs.markerId = .null
            return obs
        }
        obs.throwerPos = holder.pos

        // **Whoever is actually on the thrower, not whoever was assigned to them.**
        //
        // This used to report the defending `TeamAI`'s own `marker` — the matchup it drew
        // the mark for. Those are different players the moment the assigned marker is
        // beaten or the defence switches, and `GameState`'s own port note calls out this
        // exact disagreement as a source of spurious double-team flags. Worse for the
        // game: when the assigned marker is beaten, the count stops even though somebody
        // is standing on the thrower, and the offence gets free time it did not earn.
        let defence = otherTeam(holder.team)
        var bd = rules.markerRange + 0.6
        var markerId = -1
        for p in players where p.team == defence {
            let d = distXZ(p.pos, holder.pos)
            if d < bd {
                bd = d
                markerId = p.id
            }
        }
        if markerId >= 0, let marker = player(markerId) {
            obs.markerId = .value(markerId)
            obs.markerPos = .value(marker.pos)
        } else {
            obs.markerId = .null
        }
        obs.defenders = players.filter { $0.team == defence }.map { Observed(id: $0.id, pos: $0.pos) }
        obs.offence = players.filter { $0.team == holder.team }.map { Observed(id: $0.id, pos: $0.pos) }

        // THE PIVOT IS ESTABLISHED WHERE HE STOPS, not where he caught it — which is
        // also why a receiver keeps the yards his momentum earned him. So the machine's
        // pivot is moved once, at the moment locomotion locks the foot, and every travel
        // after that is measured from there.
        if game.phase == .livePossession, let foot = loco.pivotOf(holder.id) {
            if pivotOwner != holder.id {
                pivotOwner = holder.id
                game.setPivot(Vec3d(foot.x, 0, foot.z))
            }
            obs.pivotFoot = Vec3d(foot.x, 0, foot.z)
        } else {
            pivotOwner = nil
        }
        return obs
    }

    /// Whose established pivot the machine has already been told about.
    private var pivotOwner: Int?


    /// The duties a phase puts on the play layer, before anybody decides anything.
    private func servicePhase() {
        switch game.phase {
        case .prePull:
            if stagedPoint != game.point { stagePoint() }
            // A computer-run team pulls as soon as its line is standing. A human one gets
            // until the deadline to pull for itself; see `humanRelease`.
            let waited = game.phaseTimer
            let mine = !autoTeams.contains(game.pullingTeam)
            if waited >= (mine ? config.pullDeadline : config.pullSettle) { autoPull() }
        case .turnoverDead:
            collectDeadDisc()
        case .check:
            // Nobody is modelled tapping the disc in, so the defence taps it — but after
            // the reference's `CHECK_WAIT`, not on the same tick. Every other constant in
            // that block was transcribed and this one was missed, which quietly removed
            // two-thirds of a second of dead time from every single turnover. It is a
            // pacing difference rather than a rules one, and the sport has that pause.
            if game.phaseTimer >= config.checkWait {
                demand(game.check())
                syncDisc()
            }
        default:
            break
        }
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
        w.wind = Vec2d(wind.x, wind.z)
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
        // The two peers `AI.ts` reaches through `ctx.sys`, which this file had left nil.
        //
        // Both are declared on `AIWorld`, both are read — `TeamAI` caches `locoRef`, and
        // `predictCatchPoint` wants the disc's own integrator — and both implementations
        // were sitting here ported and unused. Without them the AI falls back to its
        // internal kinematic estimate for every separation and every catch point, which is
        // to say it reasons about bodies that move differently from the ones on the pitch.
        w.locomotion = self
        w.discPeer = disc
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
        case .bid(let x, let z): IntentAction(kind: "bid", x: x, z: z)
        case .jump: IntentAction(kind: "jump")
        default: nil
        }
    }

    // MARK: the disc

    /// Where the disc leaves: the throwing hand, not the middle of the chest.
    ///
    /// A third of a metre to the side of the sternum sounds like set dressing, and for a
    /// throw down an open lane it is. It is not set dressing around a mark, which is the
    /// only situation in this sport where a throw is contested at the moment it leaves —
    /// the whole point of a break is that the hand is on the far side of the defender
    /// from where they are shading, and a release modelled at the body's centre gives the
    /// mark a block it should not have.
    ///
    /// Ported from `Game.ts:releaseOrigin`. The airborne-grip branch there has no
    /// counterpart here, because nothing in this engine throws mid-layout.
    func releaseOrigin(_ p: AIPlayer) -> Vec3d {
        guard let lp = loco.get(p.id) else { return Vec3d(p.pos.x, 1.25, p.pos.z) }
        let right: Double = p.handed == .left ? -1 : 1
        let f = lp.facing
        let fx = sin(f)
        let fz = cos(f)
        return Vec3d(
            lp.pos.x + fz * right * 0.34 + fx * 0.16,
            lp.groundY + lp.hipHeight * 1.10,
            lp.pos.z - fx * right * 0.34 + fz * 0.16)
    }

    /// Solve the release for an AI throw. A port of `Game.ts:aiThrow`.
    ///
    /// **This was invented for most of the project's life, and the invention was wrong in
    /// three separate ways.** The file's own header used to claim `Game.ts` was "not a
    /// port target… integration glue rather than simulation", and on the strength of that
    /// sentence nobody read it. It is glue in places. This function is not: it is the
    /// solver that turns what the AI asked for into a disc, and every line of it is a
    /// measured answer to a question this file had been guessing at.
    ///
    /// What the old code did, and what the reference does:
    ///
    ///   - **Power.** Was `clamp01((range - 4) / 26)` — a lerp with no derivation. The AI
    ///     hands over an explicit release speed (`dist / flightTime`, `AI.ts:2311`) and
    ///     `powerForSpeed` inverts the throw table onto it. The old code took `speed` as
    ///     `_` and discarded it, so a floated 8 m dump and a flat 8 m strike left the hand
    ///     identically, and the AI's whole notion of pace did nothing.
    ///   - **Elevation.** Was `range > 18 ? 0.10 : 0`, a step. Power is fixed by the speed
    ///     the AI asked for, so *elevation* is the free variable, and it is bisected
    ///     against the real integrator — seven halvings over [-0.34, 0.62].
    ///   - **Heading.** Was aimed straight at the target. A disc is not a projectile; it
    ///     banks and it fades, and `probeThrow` reports that as `lat`. The reference flies
    ///     the throw, reads how far off the line it finished, and aims off by
    ///     `atan2(lat, want)` to put it back. Aiming straight at a receiver means missing
    ///     them sideways by however much the disc curves, every single time.
    ///
    /// Two outer passes: the corrected heading changes the flight, so the elevation is
    /// re-bisected against the heading that will actually be thrown.
    ///
    /// `catchY` is the aim's own height — `AI.ts` sets `aimY: 1.35`, chest height on a
    /// running receiver. Solving to the ground instead makes every pass fall short, since
    /// a disc arriving at the receiver's feet crossed their chest metres earlier.
    /// Solve a release without throwing it.
    ///
    /// Public, and split out from `releaseThrow`, so the checks can measure the solver on
    /// its own. That is not a convenience: in a live match the disc is caught by a receiver
    /// running *onto* the lead, a metre or two before the aim point, so a match-level
    /// measurement of "did it arrive" is measuring the offence and not the solver — it read
    /// 2.59 m median either way, with the solver working and with it deliberately broken.
    /// Flown against nobody, the answer is the solver's alone.
    ///
    /// Returns nil when the aim is close enough to be nothing to solve — `atan2` of a point
    /// you are standing on is noise.
    public func solveRelease(
        from: Vec3d, aim: Vec3d, type: ThrowType, speed: Double, throwPower: Double,
        hand: ThrowOptions.Hand
    ) -> ThrowRequest? {
        let tx = aim.x - from.x
        let tz = aim.z - from.z
        let want = (tx * tx + tz * tz).squareRoot()
        guard want >= 0.4 else { return nil }

        // The reference derives spin from the arm rather than passing the AI's through.
        let spin = clamp(0.45 + 0.55 * (throwPower / 100), 0, 1)
        let power = clamp(powerForSpeed(type, speed) * 1.02, 0.12, 1)
        // **THE CATCH PLANE IS CAPPED HERE, WHERE THE RELEASE HEIGHT IS KNOWN.**
        //
        // `probeThrow` reports where a flight DESCENDS through this plane and falls
        // through to ground contact when that crossing never happens, so a plane above
        // the release is a different question silently answered with the turf. The AI
        // asks for `AIM_HEIGHT`, a chest, and no flat throw reaches it: 1699 of 1699
        // throws over the eleven canonical matches. `ThrowSolver.solve` has clamped it
        // since August, but two modules from the caller — so the ask stayed wrong and
        // unobservable. `from.y` is this throw's actual release and this is the only
        // site that has it. Bit-identical to the clamp downstream; see CatchBandTests.
        let catchY = clamp(aim.y, CatchDecision.standingFloor, from.y - ThrowSolver.catchDrop)

        // Elevation, bank and heading all come out of `Aero/ThrowSolver.swift`, which
        // is the port of `src/sim/aero/ThrowSolver.ts`. It used to be open-coded here,
        // solving elevation only; its own header carries why that was wrong on both
        // axes.
        var req = ThrowRequest(
            type: type,
            from: from,
            aim: Vec3d(sin(atan2(tx, tz)), 0, cos(atan2(tx, tz))),
            power: power,
            angle: 0.02,
            spin: spin,
            hand: hand,
            bank: 0)
        ThrowSolver.solve(disc, &req, heading0: atan2(tx, tz), want: want, catchY: catchY)
        return req
    }

    private func releaseThrow(
        by id: Int, type: AIThrowType, aim: Vec3d, speed: Double, receiver: Int
    ) {
        guard game.phase == .livePossession, carrier == id, let thrower = player(id) else { return }
        guard let physType = ThrowType(rawValue: type.rawValue) else { return }

        let from = releaseOrigin(thrower)
        guard
            let req = solveRelease(
                from: from, aim: aim, type: physType, speed: speed,
                throwPower: thrower.attr.throwPower,
                hand: thrower.handed == .left ? .left : .right)
        else { return }
        let vel = disc.release(req)

        thrownBy = id
        intendedReceiver = receiver
        lastThrowAim = ThrowAim(from: from, aim: aim, speed: speed)
        beginFlight(from)
        demand(
            game.release(
                playerId: id, pos: from, vel: vel, spin: disc.state.spin, throwType: physType.rawValue))
    }

    // The check-wait, pickup radii and release deadtime moved to `EngineConfig`, docs
    // and all; this file only reads them through `config`.

    private func stepDisc(dt: Double) {
        // Held: the disc rides with the holder's hand.
        if let c = carrier, let p = player(c) {
            disc.hold(c, Vec3d(p.pos.x, 1.1, p.pos.z), Vec3d(0, 1, 0))
            return
        }
        guard disc.mode == .flight else { return }

        disc.step(dt: dt)
        let s = disc.state
        if format.field.isInBounds(Vec3d(s.pos.x, 0, s.pos.z)) {
            lastInBounds = s.pos
            hadInBounds = true
        }

        guard game.phase == .discInFlight || game.phase == .pullInFlight else {
            // A disc in the air with no flight phase to report it into is a desync, and a
            // desync that is left alone is a match that never restarts. Park it, and say
            // so loudly enough that the checks can fail on it.
            note("a disc was in flight during \(game.phase.rawValue)")
            syncDisc()
            return
        }

        if disc.sinceRelease > config.releaseDeadtime, tryCatch() { return }

        guard s.touchedGround, !flightSettled else { return }
        flightSettled = true
        let at = Vec3d(s.pos.x, 0, s.pos.z)
        disc.markScuff(clamp(Vec3d(s.vel.x, 0, s.vel.z).length / 14 + 0.35, 0.3, 1))
        if format.field.isInBounds(at) {
            demand(game.phase == .pullInFlight ? game.pullLanded(at) : game.ground(at))
        } else if hadInBounds {
            demand(game.outOfBoundsSegment(Vec3d(lastInBounds.x, 0, lastInBounds.z), at))
        } else {
            demand(game.outOfBounds(format.field.clampToField(at)))
        }
        syncDisc()
        // A landing the machine refused leaves the phase in flight with `flightSettled`
        // already true, which means this branch never runs again and the disc is stepped
        // forever with nothing reported. The reference ends its settle branch by forcing
        // the disc to ground unconditionally; this says so first, because a refusal here is
        // a wiring bug and `refusals` is asserted empty.
        if game.phase == .discInFlight || game.phase == .pullInFlight {
            note("a landing was refused in \(game.phase.rawValue)")
            disc.settle(Vec3d(game.discPos.x, 0, game.discPos.z))
        }
    }

    /// Catch resolution. A port of `Game.ts:tryCatch`.
    ///
    /// **A catch is a roll, not a geometry test.** What stood here before was the latter:
    /// whoever was inside a fixed radius took the disc, every time, and `contestAir`
    /// picked between two of them. That made the entire ratings sheet inert at the one
    /// moment it should matter — nobody ever dropped a disc, nobody ever got a fingertip
    /// to one, and every defensive play in the game was a clean interception. `drop`,
    /// `block` and `pullDropped` were ported, validated, and had no caller in the package.
    ///
    /// Three things the geometry test got wrong, all of which pushed the offence into
    /// throwing backwards:
    ///
    ///   - **Defenders got the disc for standing near it.** The reference lets a defender
    ///     play a disc only if they bid, jumped or went for the catch — otherwise they
    ///     must be within 0.55 m, which is a body's width, not an arm's reach plus a
    ///     window. A mark at the rules' 2.15 m took every throw released past him.
    ///   - **Reach was a constant.** It is `loco.reachAt` now: a taller player, or one
    ///     already in the air, genuinely covers more sky, and a layout reaches 1.55 m
    ///     rather than 0.82 m.
    ///   - **The roll did not exist.** `catchProbability` was ported and consulted only by
    ///     the AI, to score its own throws — the AI has always believed in drops that the
    ///     engine could not produce.
    ///
    /// A defence's roll is scaled by 0.62, because a D is harder than a catch, and an
    /// interception is the harder half of that again (`p * 0.55`).
    private func tryCatch() -> Bool {
        let phase = game.phase
        let s = disc.state
        let offence: TeamId? = phase == .pullInFlight ? game.receivingTeam : game.possession

        // The decision itself lives in `CatchDecision.decide` so it can be differed
        // against the reference — see that file's header. This builds its inputs and
        // applies its outcome; nothing here decides anything.
        let bodies = catchBodies()
        guard let d = CatchDecision.decide(
            discPos: s.pos, discVel: s.vel, pull: phase == .pullInFlight,
            offence: offence, bodies: bodies, roll: { rng.next() })
        else { return false }

        let at = s.pos
        // Stamp the grade on whatever the machine is about to emit — see `Engine.grade`.
        sink.catchGrade = Engine.grade(d, at: at, bodies: bodies)
        defer { sink.catchGrade = nil }
        switch d.outcome {
        case .none:
            return false
        case .catchDisc, .interception:
            demand(game.catchDisc(d.takerId, at))
        case .block:
            // A block through the receiver's body is a foul, not a block.
            if policeCatch(offence, at: at, established: false, taker: d.takerId) { return true }
            demand(game.block(d.takerId, at))
        case .drop:
            // Routine, and he put it down — unless somebody put it down for him.
            if policeCatch(offence, at: at, established: true, taker: d.takerId) { return true }
            demand(game.drop(d.takerId, at))
        // A pull cannot be stolen, but it can be touched: a member of the pulling team
        // who touches their own pull before the receivers have hands it straight to
        // them at that spot (WFDF 12.5). The machine does that inside `pullCaught`.
        case .pullCatch, .pullTouch:
            demand(game.pullCaught(d.takerId, at))
        case .pullDrop:
            demand(game.pullDropped(d.takerId, at))
        }
        afterFlight()
        return true
    }

    /// How hard the catch the contest just resolved was.
    ///
    /// **`laidOut` is read off the decision now, and the second expression turned out not
    /// to be a copy of anything.** This function used to write out both of `decide`'s own
    /// locals a second time, off the same body array, with a comment claiming they were
    /// `decide`'s: "`laidOut` is its `b.state == "layout" || (b.prone && b.airborne)`, and
    /// the contest is its `contestCount`, which is the term that pushes `difficulty` up."
    /// The first half was true and is now simply a field on `Result`. The second half was
    /// not: `decide` prices difficulty with `catchContest`, which is gated on whether a
    /// defender is actually playing the disc, and this asked `contestCount`, which is not
    /// gated at all. The two were one function once and were split precisely because they
    /// answer different questions; the grade was left on the wrong side of the split and
    /// the comment was left describing the other one.
    ///
    /// So the fix is not to point this at `Result.contest`. Measured over four minis
    /// matches, `contest > 0` on **none** of 55 catches while the crowd question was true
    /// on 40 of them — because by the time a disc arrives the defender is usually beaten,
    /// and a beaten defender is exactly who `catchContest` excludes. `contest` prices the
    /// roll and must exclude him; a grade describes what the moment LOOKED like, and a
    /// defender arriving a body-width late is what the crowd calls a contested catch. That
    /// is `contestCount`, the reference's own "did it come down in a crowd", and it is
    /// asked here deliberately rather than by accident. `Result.contest` is carried out and
    /// differed all the same, so the decision's term can no longer drift unseen.
    ///
    /// Layout outranks contested: a full-stretch grab with a defender on it is a layout,
    /// and that is the one the crowd stands up for.
    static func grade(_ d: CatchDecision.Result, at: Vec3d, bodies: [CatchDecision.Body])
        -> CatchGrade
    {
        if d.laidOut { return .layout }
        guard let b = bodies.first(where: { $0.id == d.takerId }) else { return .routine }
        return CatchDecision.contestCount(at.x, at.z, b.team, bodies) > 0 ? .contested : .routine
    }

    /// What this tick's intent asked of one body, by the reference's own discriminator —
    /// `"bid"`, `"jump"`, `"catch"`, `"throw"`, `"stall"`, `"pickup"`, `"fake"` — or nil
    /// when it asked for nothing discrete.
    ///
    /// Public purely so the checks can see `actionOf`, which is otherwise invisible from
    /// outside and is the single fact `catchBodies` turns into the `attacking` flag. A
    /// human bid that does not appear here cannot be played by `CatchDecision` at all, so
    /// "the input reached the intent path" is exactly the assertion this read enables.
    public func reportedAction(of id: PlayerId) -> String? { actionOf[id]?.kind }

    /// The roster as `CatchDecision` sees it, right now.
    ///
    /// A read of the same builder `tryCatch` uses, so a check can ask what the contest
    /// would be handed without re-deriving it from `players` and `loco` — a second copy
    /// of that derivation is a check that passes while the real one is wrong.
    public func contestBodies() -> [CatchDecision.Body] { catchBodies() }

    /// The roster as `CatchDecision` needs it. Every body goes in — the eligibility
    /// filtering is the decision's job, and bodies that cannot take the disc still count
    /// toward the contest.
    private func catchBodies() -> [CatchDecision.Body] {
        players.compactMap { p in
            guard let lp = loco.get(p.id) else { return nil }
            let kind = actionOf[p.id]?.kind
            return CatchDecision.Body(
                id: p.id, team: p.team, pos: p.pos,
                state: lp.state.rawValue, prone: lp.prone, airborne: lp.air.airborne,
                groundY: lp.groundY, hipHeight: lp.hipHeight,
                reachTop: loco.reachAt(lp, t: 0),
                attacking: kind == "bid" || kind == "jump" || kind == "catch",
                attr: p.attr, energy: p.energy)
        }
    }

    /// Nobody leaves the park. Locomotion caps speed; this is the hard backstop.
    ///
    /// Ported from `Game.ts:keepOnField`, and it had no counterpart here at all — this
    /// engine relied entirely on the AI's perimeter speed cap, which is a *steering*
    /// constraint and cannot survive being shoved. Contact separation has no clamp of its
    /// own, so a body squeezed between two others walked off the pitch, and the checks
    /// caught it the first time anything perturbed the match: 1.09 m out against a 1.0 m
    /// tolerance. Two and a half metres of run-off outside the line, which is what a
    /// sideline actually has.
    ///
    /// The non-finite reset is the reference's too. A NaN position is unrecoverable and
    /// silently poisons every distance in the frame; putting the body back on the centre
    /// spot is a visible, survivable failure instead of an invisible fatal one.
    private func keepOnField() {
        let boundX = format.field.sideline + 2.5
        let boundZ = format.field.endLine + 2.5
        for p in players {
            guard let lp = loco.get(p.id) else { continue }
            if lp.pos.x > boundX {
                lp.pos.x = boundX
                if lp.vel.x > 0 { lp.vel.x = 0 }
            } else if lp.pos.x < -boundX {
                lp.pos.x = -boundX
                if lp.vel.x < 0 { lp.vel.x = 0 }
            }
            if lp.pos.z > boundZ {
                lp.pos.z = boundZ
                if lp.vel.z > 0 { lp.vel.z = 0 }
            } else if lp.pos.z < -boundZ {
                lp.pos.z = -boundZ
                if lp.vel.z < 0 { lp.vel.z = 0 }
            }
            if !lp.pos.x.isFinite || !lp.pos.y.isFinite || !lp.pos.z.isFinite {
                lp.pos = Vec3d(0, lp.groundY + lp.hipHeight, 0)
                lp.vel = .zero
                note("a body went non-finite and was reset to the centre spot")
            }
        }
    }

    /// A new flight starts. The release point is in bounds by construction — a thrower
    /// standing off the pitch is a rules event, not a disc event — so it seeds
    /// `lastInBounds`, which is what a disc that leaves the sideline and never comes back
    /// is measured against.
    func beginFlight(_ from: Vec3d) {
        flightSettled = false
        hadInBounds = format.field.isInBounds(Vec3d(from.x, 0, from.z))
        lastInBounds = from
    }

    /// The flight is over, however it ended. Clears the bookkeeping and puts the physical
    /// disc where the machine now says it is.
    func afterFlight() {
        thrownBy = nil
        intendedReceiver = nil
        flightSettled = true
        // The reference scuffs the disc on every turnover in the air, as the landing path
        // already does here. Only the scuff map reads `wear` and nothing branches on it, so
        // this is cosmetic — but the asymmetry was accidental rather than chosen.
        disc.markScuff(0.5)
        syncDisc()
    }

    /// Put the physical disc where the machine now says it is.
    ///
    /// Called after every reported action, and it is what keeps `carrier` — which is read
    /// off the disc — agreeing with `game.thrower`. One function rather than a line at
    /// each call site, because the failure mode of forgetting one is a disc that is in
    /// nobody's hand while the rules think a possession is live.
    func syncDisc() {
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
    func demand(_ result: ActionResult) -> Bool {
        if !result.ok { note(result.note ?? "refused with no reason given") }
        return result.ok
    }

    func note(_ text: String) {
        if refusals.count < Engine.maxRefusals {
            refusals.append("\(game.phase.rawValue) @ \(clock)s: \(text)")
        }
    }
}

// MARK: - the event stream

/// How hard the catch was, as the contest actually resolved it.
///
/// `CatchDecision.decide` computes both halves of this — a `bestLaidOut` flag and a
/// contest count that feeds `difficulty` — but its `Result` carries only `difficulty`
/// and `p` out, so neither is reachable from the outside. Rather than widen that struct
/// (it is differed against the reference fixture and is not this layer's to change), the
/// engine re-derives the same two facts from the same `Body` array it just handed in,
/// with the same expressions, at the one call site that has them.
///
/// The grade exists because the renderer needs to tell three catches apart that the box
/// score cannot: a routine completion is the metronome, a contested or laid-out one is
/// the moment the game slows down for (`docs/gameplay-design.md` §5).
public enum CatchGrade: String, Equatable, Sendable {
    /// Nobody within contesting range and both feet under you.
    case routine
    /// At least one opponent inside the 1.9 m contest radius.
    case contested
    /// Full stretch, off the ground.
    case layout
}

/// One thing that happened, as the play layer says it.
///
/// This is the surface `#39` asked for, and the shape is a **drained buffer** rather
/// than a tap the view installs. Three reasons, in order of weight:
///
///   1. `GameState` takes its emitter at construction, before an `Engine` exists to be
///      captured — which is the whole reason the events were unreachable in the first
///      place. A buffer the engine owns needs no closure retained anywhere.
///   2. The engine is stepped from a fixed-tick loop that already runs zero-or-more
///      whole ticks per rendered frame. `drainEvents()` at the foot of the tick is the
///      same cadence the loop already has, so nothing has to be re-entrant and nothing
///      fires while the engine is half-way through a step.
///   3. A `lastEvent` — the other option, mirroring `lastScore` — cannot survive a
///      catch-up burst: two turnovers in one frame would show as one. The buffer is
///      lossless within a frame, which is exactly the failure the counter-diffing
///      watchers had.
///
/// These are **not** a second set of books. Every case is a translation of a
/// Locomotion's body-contact events, buffered until the engine drains them.
///
/// A class rather than a closure over the engine because `LocoHost` is bound inside
/// `Engine.init`, where `self` does not exist yet — the same reason `EngineEventSink` is
/// a separate object. It holds only the two ids and the pre-impulse closing speed, which
/// is the one number about a collision that cannot be recovered afterwards.
final class ContactSink {
    private var buffer: [(Int, Int, Double)] = []

    func absorb(_ event: LocoEvent) {
        guard case .contact(let a, let b, let impact, _, _) = event else { return }
        buffer.append((a, b, impact))
    }

    func drain() -> [(Int, Int, Double)] {
        defer { buffer.removeAll(keepingCapacity: true) }
        return buffer
    }
}

/// `GameEvent` the rules machine already emitted, with no arithmetic of its own — the
/// one thing added is `CatchGrade`, which the engine derives at the contest it is about
/// to resolve because the machine's event does not carry it.
public enum MatchEvent: Equatable, Sendable {
    /// The pull left the puller's hand.
    case pullThrown(team: TeamId, playerId: PlayerId)
    /// The receiving team caught the pull cleanly (or the pulling team touched their
    /// own, which the rules resolve the same way).
    case pullCaught(playerId: PlayerId, team: TeamId, pos: Vec3d)
    /// The pull was allowed to land in bounds.
    case pullLanded(pos: Vec3d)
    /// The pull went out. The receivers take it at the brick or the sideline.
    case pullOutOfBounds(pos: Vec3d)
    /// A throw left a hand. `stall` is the count it went at, when there was one.
    case released(playerId: PlayerId, team: TeamId, throwType: String, stall: Int?)
    /// Somebody on the throwing team caught it. The completion.
    case caught(playerId: PlayerId, team: TeamId, grade: CatchGrade, pos: Vec3d)
    /// Possession changed. `reason` is the machine's own vocabulary — drop, throwaway,
    /// out-of-bounds, caught-out-of-bounds, block, interception, stall-out, pull-drop,
    /// travel, double-touch — so nothing here has to guess which of them it was.
    ///
    /// `grade` is present on the three that resolved through a contest (drop, block,
    /// interception) and nil on the rest, because a stall-out has no catch to grade.
    case turnover(
        reason: TurnoverReason, from: TeamId, to: TeamId, playerId: PlayerId,
        grade: CatchGrade?, pos: Vec3d)
    /// A point. `score` is the machine's, after the goal.
    case score(team: TeamId, playerId: PlayerId, assistId: PlayerId?, score: [Int])

    /// The team this event happened *to* — whoever gained on a turnover, whoever caught
    /// or scored. Nil for the events that are nobody's in particular.
    public var team: TeamId? {
        switch self {
        case .pullThrown(let t, _): t
        case .pullCaught(_, let t, _): t
        case .released(_, let t, _, _): t
        case .caught(_, let t, _, _): t
        case .turnover(_, _, let to, _, _, _): to
        case .score(let t, _, _, _): t
        case .pullLanded, .pullOutOfBounds: nil
        }
    }
}

/// Turns the machine's events into the play layer's summary and its event stream.
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

    /// How the contest currently being resolved graded out. Set by `Engine.tryCatch`
    /// immediately before it asks the machine to apply an outcome and cleared
    /// immediately after, so any catch, drop, block or interception event emitted during
    /// that call is stamped with it and nothing else ever is.
    var catchGrade: CatchGrade?

    /// The undrained events, oldest first.
    ///
    /// Capped, and the cap drops the *oldest*. This is a per-tick hand-off, not a log —
    /// `GameState.getLog()` is the log — and a headless engine that runs a whole match
    /// without a renderer must not grow a buffer nobody will ever read. A caller draining
    /// every tick, which is the intended use and the only one in the app, can never reach
    /// the cap: at most one turnover and one catch fit in a 1/120 s tick.
    private var buffer: [MatchEvent] = []
    static let maxBuffered = 512

    func absorb(_ event: GameEvent) {
        // The stat split first, unchanged.
        if case .turnover(let reason, _, _, _, _, _, _, _) = event {
            switch reason {
            case .throwaway: grounded += 1
            case .outOfBounds, .caughtOutOfBounds: outOfBounds += 1
            default: break
            }
        }
        guard let translated = Self.translate(event, grade: catchGrade) else { return }
        buffer.append(translated)
        if buffer.count > Self.maxBuffered { buffer.removeFirst(buffer.count - Self.maxBuffered) }
    }

    func drain() -> [MatchEvent] {
        defer { buffer.removeAll(keepingCapacity: true) }
        return buffer
    }

    /// One machine event → zero or one play-layer events.
    ///
    /// Zero for the ones that are already said another way. Every `disc:grounded` except
    /// the two pull outcomes is accompanied by a `turnover` carrying the reason, and
    /// reporting both would make every throwaway two events — which is precisely the sort
    /// of double count the counter-diffing watchers used to produce.
    private static func translate(_ event: GameEvent, grade: CatchGrade?) -> MatchEvent? {
        switch event {
        case .pull(let team, let playerId, _, _):
            return .pullThrown(team: team, playerId: playerId)
        case .discReleased(_, _, _, let throwType, let playerId, let team, let stall):
            // A pull emits both `pull` and `disc:released`. Said once, by the first —
            // which keeps `released` countable against the box score's `attempts`, a
            // number that does not count pulls either.
            if throwType == "pull" { return nil }
            return .released(playerId: playerId, team: team, throwType: throwType, stall: stall)
        case .discCaught(let playerId, let pos, let team, let outcome):
            switch outcome {
            case "pull":
                return .pullCaught(playerId: playerId, team: team, pos: pos)
            case "interception":
                // Said once, by the turnover — which is the event that carries who lost
                // it as well as who took it, and which is graded the same way.
                return nil
            default:
                return .caught(playerId: playerId, team: team, grade: grade ?? .routine, pos: pos)
            }
        case .discGrounded(let pos, let reason):
            switch reason {
            case "pull": return .pullLanded(pos: pos)
            case "pull-oob": return .pullOutOfBounds(pos: pos)
            default: return nil
            }
        case .turnover(let reason, let from, let to, let playerId, let pos, _, _, _):
            // Only the three that resolved through a contest carry a grade. A stall-out
            // or a travel has no catch to grade and must not inherit the last one.
            let contested: Bool
            switch reason {
            case .drop, .block, .interception, .pullDrop: contested = true
            default: contested = false
            }
            return .turnover(
                reason: reason, from: from, to: to, playerId: playerId,
                grade: contested ? grade : nil, pos: pos)
        case .score(let team, let playerId, let assistId, let score, _, _):
            return .score(team: team, playerId: playerId, assistId: assistId, score: score)
        default:
            return nil
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

/// The locomotion peer the AI asks about bodies.
///
/// `AI.ts` reaches this through `ctx.sys.locomotion`; here it is the engine itself, which
/// is the object that owns the `Locomotion` instance actually moving the players. The
/// alternative — conforming `Locomotion` directly — would still need the engine to hand it
/// over, and this way the AI cannot be given a locomotion that is not the live one.
extension Engine: LocomotionPeer {
    public func timeToReach(_ p: AIPlayer, _ x: Double, _ z: Double) -> Double {
        loco.timeToReach(
            AthleteLike(id: p.id, posX: p.pos.x, posZ: p.pos.z, velX: p.vel.x, velZ: p.vel.z),
            x: x, z: z)
    }

    public func isAirborne(_ p: AIPlayer) -> Bool { loco.isAirborne(id: p.id) }
}
