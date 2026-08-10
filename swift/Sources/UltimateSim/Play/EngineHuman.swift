import Foundation

/// Everything the thumb can do, in one file: the cone select behind a drag, the release
/// it turns into, and the single tap that is the whole of the human's defence.
///
/// **Offence and defence are one subject here, and the reason is a shared rule.** Neither
/// half gets a private path into the simulation. `humanRelease` goes through the same
/// `solveRelease`/`disc.release`/`game.release` the AI does, and `applyDefensiveCommit`
/// *edits* the intent `TeamAI` already wrote for that body rather than authoring a new
/// one — because `catchBodies` reads the `attacking` flag off `actionOf`, so a bid that
/// did not travel through the intent stream is a body sprinting through the disc. Any
/// change on one side that reaches for a shortcut is now visibly a change on both.
///
/// `Engine` keeps the tick. `applyDefensiveCommit` runs from `step` after both `TeamAI`s
/// have decided and **before** `actionOf` is filled, and that ordering is a property of
/// the tick, so it stays where the tick is.

/// What the human's input has last been judged to mean.
///
/// Three facts, all of them written only by this file and read by the HUD, collected so
/// the read surface is one object rather than three stored properties among thirty.
/// `Engine` exposes each of them as a read-only computed property, so nothing outside
/// the package sees that they moved.
final class HumanInput {
    /// Who the human's last drag was judged to mean, and what the assist did about it.
    /// Read by the HUD, so the player can see who they are throwing to before it leaves.
    var selectedReceiver: Int?
    var lastAssist: HumanTargeting.Assist?
    /// The commitment in force, if any. Read by the HUD; written only by `humanDefend`
    /// and by the tick that expires it.
    var commit: Engine.DefensiveCommit?
    /// The last cut the human called, while it is still worth drawing. Written only by
    /// `humanCallCut` and by the tick that fades it.
    var calledCut: Engine.CalledCut?
    /// Seconds until another cut may be called. See `Engine.calledCutInterval`.
    var callCooldown: Double = 0
}

extension Engine {

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
    /// — and mutates nothing, not even `human.selectedReceiver`, which stays the record of the
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
            human.selectedReceiver = picked
            let assist = HumanTargeting.assistedYaw(
                rawYaw: yaw, quality: quality, power: power, from: from,
                receiver: picked.flatMap { id in bodies.first { $0.id == id } },
                maxAssist: config.assistMax)
            yaw = assist.yaw
            human.lastAssist = assist
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
            intendedReceiver = human.selectedReceiver
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

    // MARK: - off the disc

    /// A cut the human has called, kept for as long as it is worth drawing.
    ///
    /// **This is a receipt, not a control.** Nothing in the simulation reads it: by the
    /// time it exists the order has already been given, `TeamAI` owns the route, and
    /// `tickCutters` will run and retire it with no knowledge that a human asked. It is
    /// here so the player can see *the order they gave* next to the execution of it —
    /// `docs/gameplay-design.md` §4 — which is the difference between "my cutter is
    /// useless" and "I sent him into the one lane that was covered".
    public struct CalledCut: Equatable, Sendable {
        /// Who was sent.
        public let receiver: PlayerId
        /// Which of the seven routes the tap resolved to.
        public let kind: Playbook.CutKind
        /// The lane it claimed. Two live cuts may never share one, so this is the piece of
        /// field the order took off the rest of the offence.
        public let lane: Playbook.LaneKey
        /// Where the runner stood when the order was given. The ghost is drawn from here
        /// and does *not* follow him, on purpose: the point of it is to stay still while
        /// the body moves, so the two can be compared.
        public let from: Vec2d
        /// The setup step — deliberately the wrong way — and the space the cut attacks.
        public let setup: Vec2d
        public let target: Vec2d
        /// Seconds of ghost left.
        public var timeLeft: Double
    }

    /// How long the commanded route stays on screen, in seconds.
    ///
    /// The reference's `CUT_GHOST_TIME`. It is a *drawing* lifetime and nothing else: the
    /// cut itself lives as long as `CutRoute.maxTime` says, 1.6 s for an up-line and 3.4 s
    /// for the canonical under, and is retired by the AI's own `tickCutters`.
    public static let calledCutGhostTime = 1.5

    /// The shortest gap between two called cuts, in seconds.
    ///
    /// **A tap has no edge to fall off.** The reference drives this from a held stick and
    /// says so in `commandCut`'s contract — "call it on the edge of the hold, not every
    /// step, or the receiver will jog the setup step forever" — because every call rebuilds
    /// the route and restarts it at `setup`. A finger on glass gives one edge per tap and a
    /// player can produce ten a second, so on a phone the caller's idempotency obligation
    /// has to be a rate limit or it is nothing.
    ///
    /// `PLAY.cutStagger` rather than a new number, because it is the same quantity: the
    /// minimum gap the offence already imposes between the starts of two of its own cuts,
    /// and the thing that makes a second cut read as a *second cut* rather than as two
    /// people leaving at once. The human gets the tempo the AI gives itself. It is a limit
    /// on the *rate of orders*, not on which orders may be given — every route stays
    /// reachable at every moment.
    public static let calledCutInterval = Playbook.PLAY.cutStagger

    /// Send a teammate into the space the human just pointed at. The whole of the human's
    /// offensive input away from the disc.
    ///
    /// **A tap names a SPACE, and the space names the cutter.** The alternative was to tap
    /// a body and give it the cut that best fits where it stands, and that is the wrong way
    /// round for this sport: a thrower does not pick a person and then wonder where they
    /// will go, they see a piece of field they want attacked and the right cutter is
    /// whoever can attack it. It is also the only version that survives a thumb — a finger
    /// covers about four metres of pitch, so "the player you tapped" is a coin toss in a
    /// stack and "the direction you tapped" is not.
    ///
    /// So the tap is resolved exactly as a drag is: `atX`/`atZ` is a point on the grass,
    /// the direction from the thrower to it goes through the **same** `coneSelect` the
    /// throw gesture runs, and the teammate that 35° cone picks — 60% angular fit, 25% lane
    /// openness, 15% distance sanity — is the one sent. Point at the deep space and the
    /// best-placed body in that direction goes deep. The player learns one targeting model,
    /// not two, and the man the tap sends is the man a drag in the same direction would
    /// have thrown to.
    ///
    /// **What it does not do is move anybody.** The order goes through `TeamAI.commandCut`,
    /// the AI's one documented entry point, which builds a real route out of `buildCut` and
    /// arms it in the same `Mem.cut` the AI's own cuts live in. From there `tickCutters`
    /// runs it, `cutterIntent` steers it and the lane table protects it, none of them
    /// knowing a human was involved. That is the same rule `humanRelease` and
    /// `applyDefensiveCommit` obey: the human authors an intent the AI could have authored,
    /// and never gets a private path into the simulation.
    ///
    /// **What it costs.** One RNG draw, the lane, and the tempo. `commandCut` evicts an AI
    /// cut already holding the lane the order claims — sending that player to clear, which
    /// re-solves him back into the stack on the next pass — so the human outranks the AI,
    /// exactly once, for one lane. And the order ignores the initiation gates the AI holds
    /// itself to (`maxLiveCuts`, `stackHold`, `cutStagger`), because those are the AI
    /// deciding whether a cut is *worth* making and the human has already decided. The
    /// `calledCutInterval` above is what keeps that from emptying the stack.
    ///
    /// Returns the order, or nil when there is nothing to order: the disc is not in our
    /// hand, the point is dead, the cone is empty, or the last call was too recent. A
    /// refused tap changes nothing at all — no draw is consumed on any refusal path.
    @discardableResult
    public func humanCallCut(atX: Double, atZ: Double) -> CalledCut? {
        guard !isOver, game.phase == .livePossession else { return nil }
        // Our disc, in the hand of the body the player is driving. On defence the same tap
        // is `humanDefend`, and the two can never both apply: one wants us holding it and
        // the other wants them holding it.
        guard let c = carrier, c == controlled, let thrower = player(c) else { return nil }
        guard human.callCooldown <= 0 else { return nil }

        let dx = atX - thrower.pos.x
        let dz = atZ - thrower.pos.z
        let bodies = targetingBodies()
        guard let me = bodies.first(where: { $0.id == c }),
            let picked = coneSelect(dx: dx, dz: dz, thrower: me, bodies: bodies),
            let side = ai.first(where: { $0.team == thrower.team })
        else { return nil }

        let d = disc.state.pos
        guard let route = side.commandCut(picked, dx, dz, Vec2d(d.x, d.z)),
            let runner = player(picked)
        else { return nil }

        let called = CalledCut(
            receiver: picked, kind: route.kind, lane: route.lane,
            from: Vec2d(runner.pos.x, runner.pos.z),
            setup: route.setup, target: route.target,
            timeLeft: Engine.calledCutGhostTime)
        human.calledCut = called
        human.callCooldown = Engine.calledCutInterval
        return called
    }

    /// Burn down the ghost and the call cooldown by one tick.
    ///
    /// Called from `step`, next to `applyDefensiveCommit`, and it is the whole of the
    /// per-tick cost of the offensive command — one subtraction and a compare. There is
    /// deliberately no per-tick *re-issue* here, and that is the difference between the two
    /// halves of the control scheme rather than an omission: a defensive commitment has to
    /// be rewritten into the intent stream every tick because it overrides what the AI
    /// wants that body to do, and a called cut does not because it *is* what the AI wants
    /// that body to do — it lives in `Mem.cut`, the same slot an AI cut lives in, and the
    /// AI carries it to completion and retires it on its own clock.
    func expireCalledCut(_ dt: Double) {
        human.callCooldown = Swift.max(0, human.callCooldown - dt)
        guard var cut = human.calledCut else { return }
        cut.timeLeft -= dt
        human.calledCut = cut.timeLeft > 0 ? cut : nil
    }

    // MARK: - on defence

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
        human.commit = commit
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
    func applyDefensiveCommit(_ intents: inout [PlayerIntent], dt: Double) {
        guard var commit = human.commit else { return }

        commit.timeLeft -= dt
        // The situation that justified the tap is over: they no longer have it, the disc
        // has landed, the point is dead, or the clock ran out on the commitment.
        let live = game.phase == .livePossession || game.phase == .discInFlight
        let stillOn = commit.kind == .bid ? discInFlight : (carrier != nil)
        guard commit.timeLeft > 0, live, possession != 0, stillOn else {
            human.commit = nil
            return
        }
        guard let idx = intents.firstIndex(where: { $0.id == commit.defender }),
            let p = player(commit.defender), let lp = loco.get(commit.defender)
        else {
            human.commit = nil
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
            human.commit = commit
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
        human.commit = commit
    }
}
