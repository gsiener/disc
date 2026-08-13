import Foundation

/// How a point begins, and how the disc gets back into somebody's hand.
///
/// Three moments that are one subject, and were three hundred lines apart in `Engine`:
/// the roster is dealt, the lines are stood up for a point, and the disc is put back
/// into play — by a pull, or by somebody walking over and picking a dead one up.
///
/// **What makes them one subject is that all three are the places a match can stop.**
/// Not slow down: stop. `stagePoint` rebuilds `Locomotion` and re-attaches the contact
/// stream, and the point at which that attach was forgotten is the whole of #55 —
/// receiving fouls and strips were unreachable for the feature's entire life.
/// `collectDeadDisc` escalates its pickup radius because a fixed one parked a collector
/// a metre short of a disc on the chalk, measured at 152 seconds of `TURNOVER_DEAD` on
/// one seed. `autoPull` exists because a point that waits for a human who never taps is
/// a point that never opens. Each of those was a hang, and each was found separately.
///
/// `Engine` keeps `servicePhase`, which decides *when* each of these is owed, because
/// that is a fact about the phase machine rather than about the restart.

extension Engine {
    // MARK: - pull release, fitted against the aero rather than guessed

    /// Ported one-for-one from `src/sim/Game.ts:82-90`. These are a *fit*, not taste:
    /// 32 m/s, launch 0.10 rad (the backhand spec's own elevation, with `angle: 0` on
    /// top), bank −0.50, flat nose, spin 0.85 carries 66 m in 5.7 s peaking 7.7 m up —
    /// into the far endzone, with enough hang for the cover to run under it.
    ///
    /// They are **absolute air measurements, not pitch fractions** (ADR-0004): a release
    /// speed and a bank angle are properties of a thrower and of the air. They do not
    /// scale, which is exactly why `regulationPull` is gated on the regulation pitch
    /// rather than applied everywhere.
    public static let PULL_SPEED = 32.0
    public static let PULL_BANK = -0.50
    /// An offset, not an absolute: the backhand spec sits at −0.02 nose and the fit wants
    /// a flat nose, so this cancels it.
    public static let PULL_NOSE = 0.02
    public static let PULL_SPIN = 0.85
    /// Metres of cross-field fade the aim has to undo, and the carry it fades over.
    public static let PULL_DRIFT = 8.4
    public static let PULL_CARRY = 66.0
    /// Where a pull is aimed: the middle of the field, just inside the far endzone.
    /// `FIELD.GOAL_LINE + 4` on the regulation pitch.
    public static let PULL_TARGET_Z = FieldConstants.standard.goalLine + 4

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
    ///
    /// **issue #2 — `topRng`, not `self.rng`, and sevens matches the reference exactly.**
    /// `Game.ts`'s `buildRoster` deals from `ctx.rand.fork(0x0a11ce)`, a stream independent
    /// of `this.rng` — so shuffling the roster deal can never shift a single tick of match
    /// play, and vice versa. Drawing from `self.rng` here would tie the two together and
    /// was the port's actual divergence: not just the wrong overalls or the wrong
    /// archetype order, but the wrong *stream*. Sevens' order, `[76, 74]`, is
    /// `Game.ts`'s `ARCHETYPES` and `overall` verbatim. Minis has no reference — `src/sim/`
    /// is sevens-only — so its spread and its 72/72 overalls are the port's own call, kept
    /// exactly as they were rather than changed to match a reference that cannot express it.
    func buildRoster(topRng: Rng) {
        players = []
        let sevens: [Archetype] = [.handler, .handler, .handler, .cutter, .cutter, .deep, .utility]
        let minis: [Archetype] = [.handler, .cutter, .deep]
        let order = format.playersPerSide == 7 ? sevens : minis
        let overall: [Double] = format.playersPerSide == 7 ? [76, 74] : [72, 72]
        let rosterRng = topRng.fork(salt: 0x0a11ce)
        for t in 0..<2 {
            for i in 0..<format.playersPerSide {
                let id = t * format.playersPerSide + i
                players.append(makePlayer(id, t, order[i % order.count], rosterRng, overall: overall[t]))
                // issue #2 — burned, not used, and only at sevens.
                //
                // `Game.ts`'s roster loop draws three more `gauss()` calls right here, per
                // player, for `Locomotion`'s height/mass/strength (`rng.gauss()*0.045` for
                // height, `*5` for mass, `*8` for strength — the reference's own formulas,
                // not repeated here since nothing below reads the results). The port derives
                // its physical attributes from the rating sheet alone instead
                // (`fromAIAttributes`/`ratings` in `stagePoint`), and that architecture is
                // unchanged by this — sevens' bodies look exactly as they did before.
                //
                // But `rosterRng` is one shared stream across all fourteen deals. Leaving
                // these three draws out shifts every player after the first by three
                // `gauss()` calls relative to the reference: verified directly with a
                // throwaway probe against `Game.ts`'s own roster for several seeds — player
                // 0 (nothing yet to desync) matched the reference's full attribute sheet
                // bit for bit without this line, and player 1 (three calls behind) did not,
                // off by exactly this count. Burning them here, in the reference's order, is
                // what "one seed, one sevens roster" requires without building a second,
                // unused body-physics system to get it.
                //
                // Minis has no reference roster to align to — see this function's own
                // header — so it draws only what `makePlayer` needs.
                if format.playersPerSide == 7 {
                    _ = rosterRng.gauss()
                    _ = rosterRng.gauss()
                    _ = rosterRng.gauss()
                }
            }
        }
        checkRosterIsIndexable("buildRoster")
    }

    /// Stand both lines up for the point the machine has just opened.
    ///
    /// Called on the tick `PRE_PULL` is entered, once per point — including the one after
    /// halftime, where the ends have swapped and every attacking direction is the other
    /// one. That is why the `TeamAI`s are rebuilt here rather than reused: `TeamAI.dir` is
    /// a `let`, and a team that has changed ends and kept its old direction plays the
    /// whole point backwards.
    func stagePoint() {
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
        // …and neither is anything the two frame-shaped detectors latched. `pickWatch` is
        // the one that can actually lie: it holds the speed and the matchup gap a defender
        // had when an obstruction began, and the next point puts that same defender on a
        // line with a completely different baseline. One tick of contact on the new point
        // then reads as a metre of ground lost to a pick that happened before the pull.
        calls.pickWatch.removeAll(keepingCapacity: true)
        calls.markFoulHeld = false
        records = []

        // Both teams line up on their own goal lines, facing each other. Ported one-for-one
        // from `Game.ts`'s `lineUpForPull` (called from `onPhaseChange` the instant
        // `PRE_PULL` is entered — exactly this method's own cadence, once per point):
        // `x = -SIDELINE + 3.5 + (i/6) * (2*SIDELINE - 7)`, `z = -dir*GOAL_LINE + dir*0.5`.
        // `i/6` is `i / (playersPerSide - 1)` generalised past the reference's sevens-only
        // literal — the reference has no minis pitch to check this against, but it is the
        // same margin-from-sideline shape `TeamAI.lineUp` already uses once the AI takes
        // over (issue #56: this used to be a different, generic shape that put seed 11's
        // puller 1.5 m from where the reference has him at the zero-tick instant before any
        // AI runs).
        for (i, p) in players.enumerated() {
            let dir = Double(dirFor(p.team))
            let slot = Double(i % format.playersPerSide)
            let span = Double(Swift.max(1, format.playersPerSide - 1))
            let x = -format.field.sideline + 3.5 + (slot / span) * (2 * format.field.sideline - 7)
            let z = -dir * format.field.goalLine + dir * 0.5
            p.pos = Vec3d(x, 0.9, z)
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
        // Both sides defend person unless the day says otherwise — the zone biases are
        // zero and the wind decides. See `EngineConfig.sideStyles` for why they are no
        // longer negative, which is a story about arithmetic and not about taste.
        //
        // The table itself lives on `EngineConfig.sideStyles` now, defaults unchanged, so
        // a mode can restyle a side without editing this file.
        buildTeamAIs()

        // Declare the lines. They are already the default rosters, so this changes
        // nothing today; it is here because the machine's contract is that a line is
        // declared and a caller that starts fielding subs must not have to remember to
        // add the call.
        // The check is on the *line change*, not on the roster: `setLine` is the seam a
        // substitution system will arrive through, and the day it filters or reorders
        // `players` is the day every `players[someId]` in the app layer is wrong. See
        // `checkRosterIsIndexable`.
        for t in 0..<2 {
            game.setLine(t, players.filter { $0.team == t }.map(\.id))
        }
        checkRosterIsIndexable("setLine @ point \(game.point)")

        // The puller picks the disc up off the line and holds it until he pulls, which is
        // what makes `humanRelease` able to throw one.
        thrownBy = nil
        intendedReceiver = nil
        disc = DiscRuntime()
        disc.wind = wind
        controlled = nearestOnTeam(0, to: Vec3d(game.discPos.x, 0, game.discPos.z))
        syncDisc()
    }

    /// One `TeamAI` per side, from `config.sideStyles`.
    ///
    /// Called once per point by `stagePoint`, **and again by `considerTimeout`** — because
    /// a `TeamAI` carries the plan, not the bodies: stack slots, matchups, the defensive
    /// scheme and each cutter's live cut with the state it is in. None of that changes
    /// because play stopped, so a timeout that only paused the clock handed the offence
    /// back exactly the beaten shape it called the timeout to escape. Rebuilding is the
    /// huddle: same fourteen people, same disc on the same blade of grass, new plan.
    ///
    /// `epoch` keeps a mid-point rebuild from replaying the point's opening noise. It is
    /// derived — the two teams' `timeoutsUsed` added together — rather than stored, so
    /// there is no counter to forget to clear, and it is zero for every rebuild that
    /// happens at a point boundary of a match with no timeouts in it. Which is what makes
    /// this refactor bit-identical for such a match.
    func buildTeamAIs() {
        let styles = config.sideStyles
        let epoch = game.teamStats(0).timeoutsUsed + game.teamStats(1).timeoutsUsed
        ai = (0..<2).map { t in
            var cfg = DEFAULT_TEAM_CONFIG
            // The reference's `1 + t + 2 * point`, plus a stride per stoppage that is wide
            // enough not to collide with the next point's pair.
            cfg.seed = 1 + t + 2 * game.point + 4096 * epoch
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
    }

    /// The player who pulls this point: **the best arm on the pulling team's line.**
    ///
    /// Ported from `Game.doPull` — `for (const e of line) if (e.ai.attr.throwPower >
    /// puller.ai.attr.throwPower) puller = e`. Strict `>` over the line in id order, so a
    /// tie keeps the earlier name and the choice is deterministic, which is what a replay
    /// needs. This used to be `pullingTeam * playersPerSide`, the first name on the line,
    /// which meant `arm` in the fitted release below would have been centred on a
    /// middling thrower rather than on the top one it was fitted against.
    public var puller: PlayerId {
        let team = game.pullingTeam
        var best: AIPlayer? = nil
        for p in players where p.team == team {
            guard let b = best else { best = p; continue }
            if p.attr.throwPower > b.attr.throwPower { best = p }
        }
        return best?.id ?? team * format.playersPerSide
    }

    // MARK: - the pull

    /// The exact request the last pull released with, and what `disc.release` did with
    /// it. Telemetry only — nothing reads it to decide anything — kept so a test can see
    /// what `regulationPull`/`solvedPull` actually built without re-deriving it. See
    /// `SimChecks/PullTests.swift`, which is the reason this exists (issue #48/#2): a
    /// property test can see that a pull flew and landed somewhere plausible, but not
    /// that the aim, the speed, the bank or the nose is the wrong formula.
    public struct PullThrow: Sendable {
        public let from: Vec3d
        public let aim: Vec3d
        public let power: Double
        public let angle: Double
        public let spin: Double
        public let bank: Double?
        public let nose: Double?
        public let speed: Double?
        public let hand: ThrowOptions.Hand?
        public let vel: Vec3d
    }

    /// Send a pull on its way and report it. Everything about the throw is the caller's.
    ///
    /// The engine used to start each point from a *caught* pull — a shortcut inherited
    /// from the deleted interim engine — which meant `PULL_IN_FLIGHT`, `pullCaught`,
    /// `pullLanded`, `pullOutOfBounds` and the brick mark were all ported and all dead.
    @discardableResult
    func releasePull(_ req: ThrowRequest) -> Bool {
        guard game.phase == .prePull, carrier == puller else { return false }
        let vel = disc.release(req)
        lastPullThrow = PullThrow(
            from: req.from, aim: req.aim, power: req.power, angle: req.angle, spin: req.spin,
            bank: req.bank, nose: req.nose, speed: req.speed, hand: req.hand, vel: vel)
        thrownBy = puller
        intendedReceiver = nil
        beginFlight(req.from)
        return demand(game.pull(puller, req.from, vel))
    }

    /// The pull the computer throws.
    ///
    /// **Two implementations, and which one runs is decided by the pitch.**
    ///
    /// On the regulation field this is `Game.doPull`, ported (see `regulationPull`). The
    /// reference is the oracle there — it is the only pitch it can express, and it is the
    /// pitch `matchdiff` compares on — and the port's own invention aimed 16.8 m short of
    /// every pull the reference throws, which is issue #2's `turnover:pull-drop` gap.
    ///
    /// On minis the solved pull below stays, because **there is no oracle for minis**:
    /// `src/sim/` has exactly one field. The fitted ballistic is fitted to a 100 m pitch —
    /// 66 m of carry on a 37 m field is a disc in the car park — so it is not a candidate
    /// there, and the bisection plus the wind correction is what the small pitch has been
    /// measured against. This is not a declared divergence under ADR-0007: there is no
    /// reference value for a minis pull to disagree with.
    ///
    /// Public so `SimChecks/PullTests.swift` can call it the instant a match exists,
    /// with no `update()` tick in between — see that file's header for why the zero-tick
    /// timing is load-bearing rather than incidental. `servicePhase` is still what calls
    /// it in the ordinary tick loop; this does not change when a real match auto-pulls.
    public func autoPull() {
        guard let p = player(puller) else { return }
        if format.field == .standard {
            regulationPull(p)
        } else {
            solvedPull(p)
        }
    }

    /// `Game.doPull`, ported. Regulation pitch only — see `autoPull`.
    ///
    /// The reference's own header is worth keeping: *"A PULL IS NOT A BACKHAND, and
    /// treating it as one is why every pull in this game used to die at midfield —
    /// measured mean carry 42.9 m, max 46.2 m, against a far goal line 64 m away."* The
    /// backhand spec tops out at 27 m/s and no amount of `power` reaches the endzone with
    /// it, because a pull is the one throw in the sport taken with a run-up and a full
    /// body rotation rather than from a standing pivot with a mark in the face. So it gets
    /// a release speed of its own — `PULL_SPEED`, overriding `power` through
    /// `ThrowRequest.speed` — rather than a wider backhand range that every throw in a
    /// possession would then inherit.
    ///
    /// Two findings from the reference's fit that the port inherits rather than re-derives:
    /// throwing harder made the carry *worse* before it made it better (29 m/s falls to
    /// 50.1 m with 33 m of drift, because the disc turns over at speed and dives), and the
    /// lever is hyzer — half a radian of `PULL_BANK` holds the line against that turnover.
    private func regulationPull(_ p: AIPlayer) {
        let dir = Double(dirFor(game.pullingTeam))
        let from = releaseOrigin(p)

        // AIM AT A SPOT, NOT DOWN THE FIELD. The puller lines up wherever the line puts
        // him — measured, about 15 m off centre, hard against a sideline — so a heading of
        // "straight downfield plus a correction" starts from the wrong place and finishes
        // out of bounds. Aiming at the middle of the far endzone is self-correcting for
        // wherever he happens to stand.
        //
        // Then offset that spot by the fade. A hyzer pull drifts `PULL_DRIFT` metres
        // sideways over `PULL_CARRY` of flight — along the thrower's right in this
        // coordinate convention, mirrored by hand — so aiming that far the other way lands
        // it on the spot rather than beside it. Only the aim's *direction* is read by
        // `throwDisc`, so this pair of lengths is a bearing: atan(8.4 / 66) of correction.
        let handSign: Double = p.handed == .left ? -1 : 1
        var hx = -from.x
        var hz = dir * Engine.PULL_TARGET_Z - from.z
        let len0 = (hx * hx + hz * hz).squareRoot()
        // `Math.hypot(hx, hz) || 1` — a zero length divides by one rather than by zero.
        let len = len0 == 0 ? 1 : len0
        hx /= len
        hz /= len
        let fx = -hz * handSign
        let fz = hx * handSign
        let aim = Vec3d(
            hx * Engine.PULL_CARRY - fx * Engine.PULL_DRIFT,
            0,
            hz * Engine.PULL_CARRY - fz * Engine.PULL_DRIFT)

        // Arm and a seeded nudge, so fourteen pulls are not one pull — but kept tight on
        // purpose. The carry is very sensitive above the fitted speed: 32.6 m/s hangs 4.6 s
        // and 34.6 m/s hangs 3.2 s, because past the fit the disc turns over and dives. The
        // puller is always the strongest arm on the line, so `arm` is centred to land on
        // `PULL_SPEED` for a top arm rather than to exceed it.
        let arm = 0.94 + 0.06 * (p.attr.throwPower / 100)
        let jitter = 0.985 + 0.03 * rng.next()
        let req = ThrowRequest(
            type: .backhand,
            from: from,
            aim: aim,
            power: 1,
            angle: 0,
            spin: Engine.PULL_SPIN,
            hand: p.handed == .left ? .left : .right,
            bank: Engine.PULL_BANK,
            nose: Engine.PULL_NOSE,
            speed: Engine.PULL_SPEED * arm * jitter)
        releasePull(req)
    }

    /// The solved pull: downfield, into the middle of the receiving half. **Minis only.**
    ///
    /// A pull that lands in the middle is the one a receiving team has to come and get.
    /// One aimed at the back of the endzone sails out, which under WFDF 12.4 hands the
    /// receivers the brick — a worse result for the pulling team than a short pull. On the
    /// regulation pitch the oracle disagrees and the oracle wins; on the 37 m minis pitch,
    /// where there is no oracle, this argument still stands and this code is what the
    /// small pitch has been measured against.
    private func solvedPull(_ p: AIPlayer) {
        let dir = Double(dirFor(game.pullingTeam))
        let target = Vec3d(0, 0, dir * format.field.goalLine * 0.6)
        let from = Vec3d(p.pos.x, 1.25, p.pos.z)

        // AIM AT THE SPOT, THEN AIM AT WHERE THE MISS SAYS TO AIM.
        //
        // A pull drifts. It drifts because a backhand fades, and it drifts a great deal
        // more because the wind pushes it — and this aimed straight at the target and
        // accepted whatever came of that. On the minis pitch, which is 18 m wide, a 1.5 m/s
        // crosswind is enough to put the pull out the side: measured at **0.27 goal lines of
        // carry** on one of `EngineSeamTests`' four seeds, because the out-of-bounds spot is
        // where the pull resolved. The reference does not have this bug — `Game.ts` offsets
        // its aim by a `PULL_DRIFT` constant for exactly this reason, with the comment "this
        // is what a player does: pick a target, account for the curve."
        //
        // A constant is the wrong instrument here, because the drift is mostly the weather
        // and the weather is not a constant. `probeThrow` integrates the very flight that is
        // about to happen, wind and all, and reports where it lands — so the aim is
        // corrected by the miss it predicts. One iteration is enough: the correction is
        // perpendicular to the throw, so it barely changes the range the power was solved
        // for, and a second pass moves the landing by centimetres.
        var aimAt = target
        var req = pullRequest(from: from, at: aimAt, dir: dir)
        // **ONLY IN A WIND**, and the deadband is the same 2 m/s `pullAngle` uses. A calm
        // day's drift is the backhand's own fade, which is a metre and was there before any
        // of this; correcting it on a calm day would change the opening throw of nine
        // matches in ten and every per-seed statistic downstream of it, to fix a problem
        // those matches do not have. See `Playbook.drawWeather` for the same argument about
        // draw order.
        let windSpeed = (wind.x * wind.x + wind.z * wind.z).squareRoot()
        guard windSpeed > 2 else {
            releasePull(req)
            return
        }
        let probe = disc.probeThrow(req, catchY: 0.15)
        let line = Vec3d(aimAt.x - from.x, 0, aimAt.z - from.z)
        let len = (line.x * line.x + line.z * line.z).squareRoot()
        // A probe that did not resolve — `probeThrow` gives up after six seconds — reports
        // wherever the disc happened to be, and correcting off that is worse than not
        // correcting at all. The cap is the same argument one step further out: a correction
        // is a metre or three of drift, so anything past a third of the pitch is a sign the
        // probe is describing a different throw from the one about to be made.
        if len > 1e-9, probe.dist > 1 {
            let ux = line.x / len, uz = line.z / len
            // The miss, with its along-the-throw component removed — that half is
            // `solvePower`'s job and it has already done it.
            let mx = probe.x - target.x, mz = probe.z - target.z
            let along = mx * ux + mz * uz
            let cap = format.field.width * 0.35
            let fixX = Swift.min(cap, Swift.max(-cap, -(mx - along * ux)))
            let fixZ = Swift.min(cap, Swift.max(-cap, -(mz - along * uz)))
            aimAt = Vec3d(aimAt.x + fixX, 0, aimAt.z + fixZ)
            req = pullRequest(from: from, at: aimAt, dir: dir)
        }
        releasePull(req)
    }

    /// The pull as a throw request: aimed at `at`, lofted unless it is into a wind, and
    /// powered by whatever `solvePower` says reaches that far.
    private func pullRequest(from: Vec3d, at: Vec3d, dir: Double) -> ThrowRequest {
        let flat = Vec3d(at.x - from.x, 0, at.z - from.z)
        var req = ThrowRequest(
            type: .backhand,
            from: from,
            aim: flat.lengthSq < 1e-9 ? Vec3d(0, 0, dir) : flat.normalized,
            power: 1,
            // A pull is hucked up. The hang is what gives the receiving team the time to
            // read it, and it is the difference between a pull and a long pass.
            angle: pullAngle(into: flat),
            spin: 0.9,
            hand: player(puller)?.handed == .left ? .left : .right)
        req.power = solvePower(req, wantRange: flat.length)
        return req
    }

    /// Launch angle for a pull thrown along `flat`, flattened by any headwind.
    ///
    /// 0.30 rad of loft with nothing on it, falling by 0.022 rad for every metre per second
    /// of headwind past the first two, floored at 0.10 — flat and driven, which is what a
    /// puller does in a gale. A tailwind is left alone: extra hang downwind is a gift to
    /// the pulling team and the reason a captain takes that end.
    func pullAngle(into flat: Vec3d) -> Double {
        let len = (flat.x * flat.x + flat.z * flat.z).squareRoot()
        guard len > 1e-9 else { return 0.30 }
        // Positive is a tailwind: the wind pushing the disc the way it is going.
        let along = (wind.x * flat.x + wind.z * flat.z) / len
        let headwind = Swift.max(0, -along - 2)
        return Swift.max(0.10, 0.30 - 0.022 * headwind)
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
    func solvePower(_ base: ThrowRequest, wantRange: Double) -> Double {
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

    // MARK: - the dead disc

    /// Somebody has to walk over and pick it up.
    ///
    /// The AI already knows how: `TeamAI.offence` has a grounded-disc branch that sends
    /// the nearest body sprinting to the disc and raises a `.pickup` action inside 1.1 m.
    /// This is the half that turns that action into the rules event, and it also picks the
    /// disc up on proximity alone — a collector who arrives without the action still has
    /// his hands on it, and a possession that waits for a flag is a game that stops.
    func collectDeadDisc() {
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
}
