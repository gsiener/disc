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
    func buildRoster() {
        players = []
        let order: [Archetype] = [.handler, .cutter, .deep, .handler, .cutter, .utility, .deep]
        for t in 0..<2 {
            for i in 0..<format.playersPerSide {
                let id = t * format.playersPerSide + i
                players.append(makePlayer(id, t, order[i % order.count], rng, overall: 72))
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

    /// The player who pulls this point: the first name on the pulling team's line.
    ///
    /// Fixed rather than chosen, because who pulls is a captain's decision and there is
    /// nobody here to make it. Deterministic, which is what a replay needs.
    var puller: PlayerId { game.pullingTeam * format.playersPerSide }

    // MARK: - the pull

    /// Send a pull on its way and report it. Everything about the throw is the caller's.
    ///
    /// The engine used to start each point from a *caught* pull — a shortcut inherited
    /// from the deleted interim engine — which meant `PULL_IN_FLIGHT`, `pullCaught`,
    /// `pullLanded`, `pullOutOfBounds` and the brick mark were all ported and all dead.
    @discardableResult
    func releasePull(_ req: ThrowRequest) -> Bool {
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
    func autoPull() {
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
