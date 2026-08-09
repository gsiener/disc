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
    public private(set) var players: [AIPlayer] = []
    public private(set) var loco = Locomotion()
    public private(set) var ai: [TeamAI] = []
    public private(set) var disc = DiscRuntime()
    /// The match's breeze. Fed to both the flight model and the AI's world — the reference
    /// sets both from one vector and they must not drift apart.
    public private(set) var wind = Vec3d.zero
    /// The player the human is controlling, always on team 0.
    public private(set) var controlled = 0

    private let rng: Rng
    private let sink: EngineEventSink
    /// Locomotion's contact events, buffered for the tick that reads them. A separate
    /// object rather than a closure over `self`, because the host is bound during `init`.
    private var contacts: ContactSink?
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

    /// Who the human's last drag was judged to mean, and what the assist did about it.
    /// Read by the HUD, so the player can see who they are throwing to before it leaves.
    public private(set) var selectedReceiver: Int?
    public private(set) var lastAssist: HumanTargeting.Assist?

    /// Every body as the targeting layer wants them.
    private func targetingBodies() -> [HumanTargeting.Body] {
        players.map { p in
            HumanTargeting.Body(
                id: p.id, team: p.team, pos: p.pos, vel: p.vel, attr: p.attr, energy: p.energy,
                available: loco.get(p.id).map { loco.isAvailable($0) } ?? true)
        }
    }

    /// The one cone select. `humanRelease` resolves the drag through this and nothing
    /// else, and `previewReceiver` calls the same function with the same config — which
    /// is what makes the mid-drag preview a promise rather than a guess.
    private func coneSelect(
        dx: Double, dz: Double, thrower: HumanTargeting.Body, bodies: [HumanTargeting.Body]
    ) -> Int? {
        HumanTargeting.resolveConeSelect(
            dx: dx, dz: dz, thrower: thrower, bodies: bodies, cone: config.selectCone)
    }

    /// Who the cone select would pick if the human released on this drag direction,
    /// right now — so the HUD can show the pick *before* the disc is gone rather than
    /// after, when the information is no longer actionable.
    ///
    /// Strictly read-only: it runs `coneSelect` — the exact computation `humanRelease`
    /// runs at release, over the same `targetingBodies` and the same `config.selectCone`
    /// — and mutates nothing, not even `selectedReceiver`, which stays the record of the
    /// last *actual* release. The HUD may therefore call this every frame of a drag.
    ///
    /// Nil when the cone is empty, and nil whenever a release would be refused anyway
    /// (the controlled player is not holding), because previewing a throw that cannot
    /// happen is a lie.
    public func previewReceiver(dx: Double, dz: Double) -> Int? {
        guard let c = carrier, c == controlled else { return nil }
        let bodies = targetingBodies()
        guard let me = bodies.first(where: { $0.id == c }) else { return nil }
        return coneSelect(dx: dx, dz: dz, thrower: me, bodies: bodies)
    }

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

    /// The four latches and the tally the self-officiated calls run on. See
    /// `EngineCalls.swift`, which owns every detector that reads or writes them.
    let calls = CallState()

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
        opts.startingPullTeam = 0
        opts.rules = { r in
            r.gameTo = goal
            // Halftime at the midpoint of whatever length this game is, which reproduces
            // the regulation 8-of-15 and gives a minis game to 7 a break at 4 — unless
            // the config says otherwise.
            r.halftimeAt = config.halftimeAt ?? (goal + 1) / 2
            r.halftimeDuration = config.halftimeSeconds
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

        // A light, steady breeze — enough that hucks bend and zone becomes a real call, not
        // enough that the flight model becomes unreadable.
        //
        // It was `.zero`, which is not a neutral default: `Playbook.shouldPlayZone` needs
        // `windSpeed` to clear its threshold, so with no wind at all it could never return
        // true and the whole zone defence, the upwind force flip in `pickScheme` and the
        // wind term in `maxThrowRange` were unreachable code. Forked from its own salt so
        // adding it does not shift any other stream.
        let w = rng.fork(salt: 0x117d)
        wind = Vec3d(w.range(-1.5, 1.5), 0, w.range(-1.1, 1.1))
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
    private func attachContacts() {
        guard let contacts else { return }
        loco.attach(LocoHost(events: { [contacts] event in contacts.absorb(event) }))
    }

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

        // **A point is a rest, not a reset.**
        //
        // Both fatigue pools used to be wiped clean here — `energy` set to 1, and
        // locomotion's `stamina` implicitly restored by rebuilding the whole `Locomotion`
        // from scratch. So no player was ever tired in the fourteenth point of a match,
        // which removes the whole reason `stamina` and the `endurance` rating exist: a
        // game to 15 was fifteen opening points played by fresh legs.
        //
        // The reference rests forty seconds' worth through `restBetweenPoints` — ported,
        // and until now with no caller — and hands locomotion a flat +32. Both are partial
        // on purpose, and both are attribute-weighted, so a high-stamina handler comes back
        // fuller than a deep who just ran four sprints.
        let carried = Dictionary(
            uniqueKeysWithValues: players.compactMap { p in
                loco.get(p.id).map { (p.id, $0.stamina) }
            })
        restBetweenPoints(players, seconds: 40)
        loco = Locomotion()
        // A new `Locomotion` has no host, and without one it emits contact into nothing.
        // See `attachContacts` — forgetting this line is #55.
        attachContacts()
        // Nothing from the last point is still in flight: a buffered hit whose bodies were
        // rebuilt underneath it would be blamed on whoever inherited the id.
        _ = contacts?.drain()
        calls.lastContact.removeAll(keepingCapacity: true)
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
            p.airborne = false
            let body = loco.create(
                CreateOpts(
                    id: p.id, team: p.team, attr: fromAIAttributes(ratings(p.attr)),
                    pos: p.pos, facing: dir > 0 ? 0 : .pi))
            // A fresh `Locomotion` starts everyone at full; carry the last point's legs
            // across and give them the reference's forty-second top-up.
            if let was = carried[p.id] { body.stamina = Swift.min(100, was + 32) }
            records.append(WorldPlayerRecord(id: p.id, pos: p.pos, vel: .zero))
        }

        // One TeamAI per side. Both fork from the same parent stream, and the fork salt
        // includes the team index *and the point number*, so the two sides do not make
        // identical decisions and one point is not a rerun of the last. `Rng.fork` reads
        // the parent's state without advancing it, so without the point in the salt every
        // point would re-fork the same two streams from the same place.
        // **The two sides do not play the same game**, and that is the reference's single
        // biggest measured tempo lever — not `aggression`, which an earlier sweep here
        // tried and correctly found did nothing across 0.8–2.0.
        //
        // Team 0 forces forehand: a fixed side for the whole point. Team 1 forces MIDDLE,
        // which is positional — the mark stands between the thrower and the near sideline,
        // so the open side swaps as the disc crosses the field. Across the reference's six
        // sweep seeds that roughly *doubles* scoring, 6/5/8/5/1/9 against 3/1/2/1/6/3, with
        // throws up from 53–77 to 66–87, "because a force that moves stops the offence
        // settling into one lane and grinding the stall". Both configs were sitting in
        // `Playbook` here, ported, with `.middle` and `.horizontal` never once selected.
        //
        // They also run different offences — a vertical stack against a horizontal — which
        // are the two base looks of the sport and read nothing alike. The reference's A/B
        // puts them at a dead heat on scoring, so this is chosen for legibility, not tempo.
        //
        // Both sides defend person. A zone renders as bodies with no visible relationship
        // to each other, so the bias is pushed well negative rather than left at default.
        //
        // The table itself lives on `EngineConfig.sideStyles` now, defaults unchanged, so
        // a mode can restyle a side without editing this file.
        let styles = config.sideStyles
        ai = (0..<2).map { t in
            var cfg = DEFAULT_TEAM_CONFIG
            cfg.seed = 1 + t + 2 * game.point
            let style = styles[t % styles.count]
            cfg.formation = style.formation
            cfg.force = style.force
            // `aggression` is the engine's exposed knob; the reference's per-side values
            // are folded into it rather than overriding it, so setting it still means
            // something and the two sides stay distinguishable.
            cfg.aggression = aggression * style.aggressionScale
            cfg.zoneBias = style.zoneBias
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
        disc.wind = wind
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

    func player(_ id: Int) -> AIPlayer? { players.first { $0.id == id } }

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

        // 3b. The human's defensive commitment, over the top of the AI's intent for that
        //     one body. Before `actionOf` on purpose — see `applyDefensiveCommit`, and
        //     `catchBodies`, which reads `actionOf` for the flag that decides whether a
        //     defender may play the disc at all.
        applyDefensiveCommit(&intents, dt: dt)

        actionOf.removeAll(keepingCapacity: true)
        for intent in intents where intent.action != nil { actionOf[intent.id] = intent.action }

        // 4. Bodies move. Locomotion owns position and velocity from here.
        //
        // Anchor the thrower before anyone steps. The soft separation tier runs *after*
        // locomotion, and without this a crowding marker walks the thrower off his own
        // pivot — which is a foul in the rules and free yardage in the sim: possession
        // advancing without a throw, the one thing the sport forbids. `anchored` is
        // honoured by both `Separation` and the contact resolver, and was never set.
        let anchorId = game.phase == .livePossession ? game.thrower : nil
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
        beginFlight(req.from)
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
        // `holderId` is an `Int` with a `-1` sentinel, not an optional, so the `!= nil`
        // this used to say was always true and the whole guard collapsed to its second
        // clause — settling the disc on every tick of a dead phase whether anyone was
        // holding it or not. The compiler had been saying so.
        if disc.holderId >= 0, game.thrower == nil {
            disc.settle(game.discPos)
        }

        // **Brick unless the sideline spot is genuinely further downfield.**
        //
        // This used to force `.brick` at the moment the pull went out, on the grounds that
        // there is no interface for a captain to pick and a pending choice would park the
        // machine. The second half is true and the first half is the wrong fix: the
        // reference answers the question *here*, one tick later, with the actual rule — and
        // answering it badly costs the receiving team the better mark on every pull that
        // sails out deep, which is exactly the pull they are owed compensation for. It also
        // made this guard, and `PullSpotChoice.sideline` with it, unreachable code.
        //
        // Answered *before* the possession guard, not after: `pullOutOfBounds` leaves
        // possession nil until the spot is chosen, so a choice gated on possession is a
        // choice that never gets made and a match that never restarts.
        if game.awaitingPullChoice() {
            let dir = Double(dirFor(game.receivingTeam))
            let brick = format.field.brickMark(dirFor(game.receivingTeam))
            let side = game.pullOobCrossing
            let useSide = side.map { $0.z * dir > brick.z * dir + 2 } ?? false
            demand(game.choosePullSpot(useSide ? .sideline : .brick))
            // And put the physical disc where the choice just placed it. Without this the
            // runtime keeps the disc at the point it crossed the line — the spot the AI
            // then walks to — while the rules measure the pickup against the brick, so the
            // collector stands over a disc the machine says is somewhere else and the
            // match never restarts.
            syncDisc()
            return
        }
        guard let team = game.possession else { return }
        let spot = game.discPos
        // **A dead disc on the line is unreachable by design.** `AI.ts` caps every player's
        // speed by the room left to the perimeter, so nobody is ever steered over a
        // sideline — and that parks the collector a metre short of a disc sitting on the
        // chalk. With a single fixed radius he stands there forever and the match stops:
        // the reference measured one seed sitting in `TURNOVER_DEAD` for 152 seconds. After
        // long enough standing over it, he bends down and takes it.
        let reach = game.phaseTimer > config.pickupDwell
            ? config.pickupDwellRadius : config.pickupRadius
        var best = -1
        var bestD = reach
        for p in players where p.team == team {
            guard let lp = loco.get(p.id), loco.isAvailable(lp) else { continue }
            let d = distXZ(p.pos, spot)
            if d < bestD {
                bestD = d
                best = p.id
            }
        }
        guard best >= 0 else { return }
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
        case .bid(let x, let z, _): IntentAction(kind: "bid", x: x, z: z)
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
    private func releaseOrigin(_ p: AIPlayer) -> Vec3d {
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
        let catchY = max(0.35, aim.y)

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
        // Stamp the grade on whatever the machine is about to emit. Set here rather than
        // read out of `CatchDecision.Result`, which does not carry it — see `CatchGrade`.
        sink.catchGrade = Engine.grade(taker: d.takerId, at: at, bodies: bodies)
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
    /// The two expressions are `CatchDecision.decide`'s own, on the same `Body` array it
    /// was handed: `laidOut` is its `b.state == "layout" || (b.prone && b.airborne)`, and
    /// the contest is its `contestCount`, which is the term that pushes `difficulty` up.
    /// Re-derived rather than returned because widening `Result` would change a struct
    /// that is differed against the reference fixture, and this layer does not own it.
    ///
    /// Layout outranks contested: a full-stretch grab with a defender on it is a layout,
    /// and that is the one the crowd stands up for.
    static func grade(taker: Int, at: Vec3d, bodies: [CatchDecision.Body]) -> CatchGrade {
        guard let b = bodies.first(where: { $0.id == taker }) else { return .routine }
        if b.state == "layout" || (b.prone && b.airborne) { return .layout }
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
    private func beginFlight(_ from: Vec3d) {
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
    ///
    /// **The release goes through `humanReleaseParams`**, which is a full port with its own
    /// suite and which, until now, had no caller outside that suite. Both regressions it
    /// was written to prevent were live in this build:
    ///
    ///   - **You could not throw short.** Passing the drag straight through as `power`
    ///     maps the charge across the *throw's own* range, and the backhand spec floors at
    ///     12 m/s — a release at zero charge still flew 23.6 m. There was no dump, no
    ///     reset, no five-metre swing, only bombs. `humanReleaseParams` drives an absolute
    ///     speed from `MIN_THROW_SPEED` instead, which puts a tap at about 10 m.
    ///   - **Harder was sideways.** A flat release turns over at speed: measured on the old
    ///     mapping the backhand's drift ran +3.1, +4.6, +4.3, +0.1, −3.3, −8.4, −16.7 m as
    ///     the charge went up. Aim at a receiver, pull harder, and the disc finishes
    ///     seventeen metres the *other* side of them. That is not difficulty, it is a
    ///     control that lies. The power-squared hyzer collapses that to 6.4 m, same-signed
    ///     all the way up, which is a curve a player can learn to lead.
    ///
    /// `quality` is the cleanliness of the release, 0…1. There is no timing meter on the
    /// drag gesture yet, so it defaults to a clean one; when there is, it is the value to
    /// feed here, because quality buys nose and spin rather than distance.
    @discardableResult
    public func humanRelease(
        _ type: ThrowType, aim: Vec3d, power: Double, loft: Double = 0, quality: Double = 1
    ) -> Bool {
        guard let c = carrier, c == controlled, let thrower = player(c) else { return false }

        let from = releaseOrigin(thrower)

        // Who did they mean, and how much help do they get hitting them.
        //
        // The drag direction is both the aim and the select — a phone has one gesture, and
        // the reference's cone exists precisely because a stick is a coarse instrument. The
        // assist is a nudge and not a lead solver: see `HumanTargeting`, where nothing at
        // all happens outside twelve degrees of the ideal lead, because past that the
        // player is throwing somewhere else on purpose.
        let bodies = targetingBodies()
        var yaw = atan2(aim.x, aim.z)
        if let me = bodies.first(where: { $0.id == c }) {
            let picked = coneSelect(dx: aim.x, dz: aim.z, thrower: me, bodies: bodies)
            selectedReceiver = picked
            let assist = HumanTargeting.assistedYaw(
                rawYaw: yaw, quality: quality, power: power, from: from,
                receiver: picked.flatMap { id in bodies.first { $0.id == id } },
                maxAssist: config.assistMax)
            yaw = assist.yaw
            lastAssist = assist
        }

        let r = humanReleaseParams(type, power: power, quality: quality, tilt: loft)
        let req = ThrowRequest(
            type: type,
            from: from,
            aim: Vec3d(sin(yaw), 0, cos(yaw)),
            // `power: 1` because the release below is fully specified: `speed` overrides
            // it, and the remaining terms come from the mapping rather than the table.
            power: 1,
            angle: r.angle,
            spin: r.spin,
            hand: thrower.handed == .left ? .left : .right,
            bank: r.bank,
            nose: r.nose,
            speed: r.speed)

        switch game.phase {
        case .prePull:
            return releasePull(req)
        case .livePossession:
            let vel = disc.release(req)
            thrownBy = c
            // The receiver the cone select judged the drag to mean. `TeamAIThrow`'s
            // in-flight branch reads this to decide who backs the catch up, so a human
            // throw used to be played by teammates as an unclaimed disc while an AI throw
            // was not.
            intendedReceiver = selectedReceiver
            beginFlight(from)
            return demand(
                game.release(
                    playerId: c, pos: from, vel: vel, spin: disc.state.spin, throwType: type.rawValue))
        default:
            // A check, a stoppage, a disc in the air: the machine would refuse it and so
            // does this, rather than putting a second disc into the sky to find out.
            return false
        }
    }

    // MARK: the human, on defence

    /// A defender the human has sent at the disc, and for how much longer.
    ///
    /// **The player's whole defensive possession used to be a cutscene.** Offence has a
    /// gesture; defence had nothing at all, which is roughly 80% of a point spent
    /// watching. This is the seam that fixes it, and it is deliberately the *same* seam
    /// `humanRelease` uses: the human does not get a private code path into the
    /// simulation, they get to author one of the intents the AI would otherwise have
    /// authored.
    ///
    /// That matters more than it sounds. `tryCatch` will not let a defender play a disc
    /// at all unless their **current intent** is an attacking one — `catchBodies` sets
    /// `attacking: kind == "bid" || "jump" || "catch"`, and everyone else has to be
    /// within 0.55 m of the disc to touch it. So a human bid that did not travel through
    /// `actionOf` would be a body sprinting through the disc, and the fix would have been
    /// to weaken the gate for humans — i.e. to give the player a different physics. The
    /// commitment is instead written into the intent stream in `applyDefensiveCommit`,
    /// one tick at a time, and from there everything downstream is unchanged.
    public struct DefensiveCommit: Equatable, Sendable {
        /// What the tap meant, which is decided by where the disc is.
        public enum Kind: String, Equatable, Sendable {
            /// The disc is in the air: go and take it.
            case bid
            /// The disc is in a hand: close it down.
            case close
        }
        public let defender: PlayerId
        public let kind: Kind
        /// Where the commitment is aimed — the predicted catch point for a bid, the
        /// thrower for a close. Refreshed every tick while the commitment lives.
        public var at: Vec3d
        /// Seconds of *simulation* time left on it.
        public var timeLeft: Double
        /// True on the ticks where the body is actually laid out or being scraped off the
        /// grass. The HUD draws the 2.04 s recovery from this rather than guessing.
        public var committed: Bool
    }

    /// The commitment in force, if any. Read by the HUD; written only by `humanDefend`
    /// and by the tick that expires it.
    public private(set) var defensiveCommit: DefensiveCommit?

    /// How long a commitment lives before the AI has its defender back, in seconds.
    ///
    /// Long enough to cover a bid and its landing, short enough that a tap is a *play*
    /// rather than a mode. A commitment is also dropped the moment the situation it was
    /// made in ends — see `applyDefensiveCommit`.
    public static let defensiveCommitTime = 1.6

    /// Send the best defender at the disc. The whole of the human's defensive input.
    ///
    /// **Which body: the best defender on the disc, not the controlled one.** Control
    /// follows the disc (see `syncDisc`), and on defence the disc is in the *opponent's*
    /// hand — so `controlled` is whoever last had it for us, which during a defensive
    /// possession is a stale, arbitrary body that may be forty metres from the play. A
    /// tap that committed that player would be a tap whose effect the player cannot
    /// predict, which is worse than no input. So the tap picks by time-to-reach the point
    /// that matters, exactly as `TeamAIDefence` picks its own man on the play, and then
    /// *moves control to them* — so the chevron, the ring and the camera all say who you
    /// just sent, and the next tap picks afresh.
    ///
    /// Returns the commitment, or nil when there was nothing to commit to: we have the
    /// disc, the point is dead, or every defender is already on the floor.
    @discardableResult
    public func humanDefend() -> DefensiveCommit? {
        // Only while the other lot have it. Attacking is what the drag is for.
        guard !isOver else { return nil }
        let live = game.phase == .livePossession || game.phase == .discInFlight
        guard live, possession != 0 else { return nil }

        let kind: DefensiveCommit.Kind = discInFlight ? .bid : .close
        guard let aim = kind == .bid ? bidPoint() : holdPoint() else { return nil }

        // Available only: a body mid-layout or being peeled off the turf cannot be sent
        // anywhere, and pretending otherwise is how an input stops meaning anything.
        var best: PlayerId?
        var bestT = Double.infinity
        for p in players where p.team == 0 {
            guard let lp = loco.get(p.id), loco.isAvailable(lp) else { continue }
            let t = timeToReach(p, aim.x, aim.z)
            if t < bestT {
                bestT = t
                best = p.id
            }
        }
        guard let defender = best else { return nil }

        let commit = DefensiveCommit(
            defender: defender, kind: kind, at: aim,
            timeLeft: Engine.defensiveCommitTime, committed: false)
        defensiveCommit = commit
        // The commitment is the decision, so the commitment is what you are watching.
        controlled = defender
        return commit
    }

    /// How long until a body is back in the point, in seconds, or nil while it is already
    /// available.
    ///
    /// `docs/gameplay-design.md` §4: "the 2.04 s layout cost must be legible, not
    /// mysterious". A player who dives and then spends two seconds unable to move, with
    /// nothing on screen saying why, reads it as the controls having stopped working —
    /// which is the worst possible lesson to draw from the most expensive decision the
    /// game lets you make. So the cost is a number the HUD can draw, taken from the same
    /// `stateDur`/`stateT` pair locomotion is actually counting down.
    ///
    /// Committed states only (`layout`, `fall`, `recovery`); a body that is merely
    /// running is not recovering from anything.
    public func recovery(of id: PlayerId) -> Double? {
        guard let lp = loco.get(id), !loco.isAvailable(lp) else { return nil }
        return Swift.max(0, lp.stateDur - lp.stateT)
    }

    /// Where a bid should be aimed: the first point the flight comes down into the band a
    /// body can actually take it in, or the landing point if it never does.
    ///
    /// Deliberately a re-read of `DiscRuntime.predictPath` — the same integrator the disc
    /// itself is stepped by, and the same one the AI's own `predictCatchPoint` probes
    /// through the disc peer — rather than a second flight model. A renderer-side or
    /// input-side copy of the flight is the one thing this project refuses to have.
    private func bidPoint() -> Vec3d? {
        guard discInFlight else { return nil }
        let path = disc.predictPath(horizon: 4, step: 1.0 / 60)
        guard let last = path.last else { return nil }
        // `1.9` is `CatchDecision`'s standing band, near enough: below it the disc is
        // takeable by somebody on their feet, and above it this is a jump, not a dive.
        for s in path where s.t > 0.05 && s.y <= 1.9 {
            return Vec3d(s.x, s.y, s.z)
        }
        return Vec3d(last.x, last.y, last.z)
    }

    /// How far short of the thrower a hard close stops, in metres.
    ///
    /// A stride. Comfortably outside `PIVOT_R` (0.75 m), which is the radius the pivot
    /// constraint and the contact resolver both defend, so the closing body settles just
    /// beyond the one circle it must not be inside.
    static let holdStandoff = 1.0

    /// Where a hard close should be aimed: the thrower, less a stride.
    ///
    /// Not the thrower's own spot. A body steered *into* the pivot is a body the contact
    /// resolver has to push back out every tick, and in the rules it is a foul rather than
    /// good defence — the pressure a close buys comes from being a metre away when the
    /// disc goes up, not from standing in someone.
    ///
    /// This returned the thrower's exact position for as long as it existed, which the
    /// comment above has always denied. On its own that was a metre of aim; combined with
    /// the per-tick re-aim and a full-effort run it drove a body into the pivot and held
    /// it there for the whole 1.6 s commitment — shove-and-separate against the contact
    /// resolver, and, now that the calls layer scores contact, a marking foul against the
    /// one body the player is watching.
    ///
    /// `defender` is nil while `humanDefend` is still *choosing* a body: with nobody to
    /// back off from there is no vector to back off along, and the thrower's own spot is
    /// the right thing to rank time-to-reach against. Once a body is committed the
    /// standoff is taken along thrower→defender, so the close approaches from wherever the
    /// defender actually is rather than through the thrower.
    private func holdPoint(for defender: PlayerId? = nil) -> Vec3d? {
        guard let c = carrier, let holder = player(c) else { return nil }
        guard let defender, let d = player(defender) else {
            return Vec3d(holder.pos.x, 0, holder.pos.z)
        }
        let dx = d.pos.x - holder.pos.x
        let dz = d.pos.z - holder.pos.z
        let l = Foundation.hypot(dx, dz)
        // Already inside the standoff, or standing exactly on him: aim at the thrower and
        // let the contact resolver do the separating. Backing off along a zero-length
        // vector would pick an arbitrary direction, and backing off along a very short one
        // would fling the aim across the pivot.
        guard l > 1e-3 else { return Vec3d(holder.pos.x, 0, holder.pos.z) }
        let k = Swift.min(Engine.holdStandoff, l) / l
        return Vec3d(holder.pos.x + dx * k, 0, holder.pos.z + dz * k)
    }

    /// Write the human's commitment into this tick's intents, over the AI's.
    ///
    /// Called from `step` after both `TeamAI`s have decided and **before** `actionOf` is
    /// filled, which is the whole point: `actionOf` is what `catchBodies` reads for the
    /// `attacking` flag, so a bid authored here is a bid the catch contest sees.
    ///
    /// The AI's intent for that body is *edited* rather than replaced. Everything on a
    /// `PlayerIntent` except the target, the mode and the action is the locomotion
    /// contract — `maxSpeed`, `maxAccel`, `maxDecel`, `turnRate`, and the boundary and
    /// arrival speed caps `TeamAI.intent` solved for this body on this tick. Rebuilding
    /// those here would be a second copy of the one function that keeps players on the
    /// pitch, and it would be the copy that is wrong.
    private func applyDefensiveCommit(_ intents: inout [PlayerIntent], dt: Double) {
        guard var commit = defensiveCommit else { return }

        commit.timeLeft -= dt
        // The situation that justified the tap is over: they no longer have it, the disc
        // has landed, the point is dead, or the clock ran out on the commitment.
        let live = game.phase == .livePossession || game.phase == .discInFlight
        let stillOn = commit.kind == .bid ? discInFlight : (carrier != nil)
        guard commit.timeLeft > 0, live, possession != 0, stillOn else {
            defensiveCommit = nil
            return
        }
        guard let idx = intents.firstIndex(where: { $0.id == commit.defender }),
            let p = player(commit.defender), let lp = loco.get(commit.defender)
        else {
            defensiveCommit = nil
            return
        }

        // Re-aim every tick. A bid at where the disc was going a fifth of a second ago is
        // a bid a body's length behind it.
        commit.at = (commit.kind == .bid ? bidPoint() : holdPoint(for: commit.defender)) ?? commit.at
        commit.committed = !loco.isAvailable(lp)

        // A body already on the floor — fallen or being scraped up — is not taking new
        // orders. The intent is left exactly as the AI wrote it, and the recovery plays
        // out undecorated: that is the 2.04 s the player is being asked to feel.
        //
        // A body *mid-dive* is a different case and the distinction is load-bearing. It
        // is unavailable too, but it is still attacking the disc, and `catchBodies` reads
        // the flag off this tick's intent — so dropping the override the instant the feet
        // leave the ground would author a bid that is cancelled by its own take-off. The
        // AI re-issues `.bid` on every tick of its dive for exactly this reason.
        if !loco.isAvailable(lp) && lp.state != .layout {
            defensiveCommit = commit
            return
        }

        var intent = intents[idx]
        intent.targetX = commit.at.x
        intent.targetZ = commit.at.z
        intent.faceX = commit.at.x - p.pos.x
        intent.faceZ = commit.at.z - p.pos.z
        intent.effort = 1

        // RAISE THE EFFORT, KEEP THE CAP.
        //
        // `desiredSpeed = min(maxSpeed * effort, capTo, capVel, arriveCap)` is where
        // `TeamAI.intent` puts the boundary constraint, so `desiredSpeed = maxSpeed` did
        // not "raise the effort" — it deleted the perimeter. Tap to bid on a disc drifting
        // toward the sideline and the committed body, the one body the player is watching,
        // ran flat out with nothing but the hard `keepOnField` backstop for the full
        // 1.6 s. That is the opposite of what the comment above this function promises.
        //
        // The cap has to be re-solved rather than reused: the commitment *re-aims* the
        // body, and the cap the AI solved was the cap toward the AI's target, which is no
        // longer where this body is going. `boundaryRoom` is the same function `TeamAI`
        // calls — a call, not the second copy of the perimeter the comment warns about.
        // No `arriveCap` term, for the reason `TeamAI` has none on a sprint: both branches
        // below set `.sprint`, `.jump` or `.layout`, and a body committed to a point is
        // not settling onto it.
        let roomTo = boundaryRoom(
            p.pos.x, p.pos.z, commit.at.x - p.pos.x, commit.at.z - p.pos.z, field: format.field)
        let roomVel = boundaryRoom(p.pos.x, p.pos.z, p.vel.x, p.vel.z, field: format.field)
        let capTo = (2 * intent.maxDecel * Swift.max(0, roomTo)).squareRoot()
        let capVel = (2 * intent.maxDecel * Swift.max(0, roomVel)).squareRoot()
        intent.desiredSpeed = Swift.min(intent.maxSpeed, Swift.min(capTo, capVel))

        switch commit.kind {
        case .bid:
            // The gap the body would still have at the rendezvous, in metres. This is
            // `TeamAIDefence`'s own `canPlay` expression and it is the honest gate: a dive
            // from ten metres away is not a bid, it is two seconds of the point thrown
            // away for nothing. Outside it the tap is still a full-effort run at the disc
            // — the commitment stands, it just is not yet a dive.
            let t = timeToReach(p, commit.at.x, commit.at.z)
            let reach = layoutExtend(p)
            let gap = Foundation.hypot(commit.at.x - p.pos.x, commit.at.z - p.pos.z)
            if lp.state == .layout {
                // Already in the air. Hold the bid so the flag survives the dive.
                intent.mode = .layout
                intent.action = .bid(x: commit.at.x, z: commit.at.z, extend: reach)
            } else if commit.at.y > 1.85 && commit.at.y < loco.reachAt(lp, t: 0) + 0.4 && gap < 2.2 {
                intent.mode = .jump
                intent.action = .jump(height: commit.at.y)
            } else if gap < reach + 1.4 || t < 0.45 {
                intent.mode = .layout
                intent.action = .bid(x: commit.at.x, z: commit.at.z, extend: reach)
            } else {
                intent.mode = .sprint
                intent.action = nil
            }
        case .close:
            // No action: a close is a position, not an act. `catch`/`bid` here would be a
            // claim on a disc that is in somebody's hand, which the contest would rightly
            // refuse and which would only cost this body its legs.
            intent.mode = .sprint
            intent.action = nil
        }
        intents[idx] = intent
        defensiveCommit = commit
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
