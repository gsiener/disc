import Foundation

/// The mouth of a self-officiated sport: travel, marking foul, pick, receiving foul and
/// strip, split out of `Engine` so the five detectors sit on one screen.
///
/// **They are one subject and they were 300 lines apart.** All five end the same way — a
/// `makeCall` the machine may refuse, a `resolveCall` whose contest is scored by
/// `callContested`, and a reposition that puts the thrower back on his pivot so the call
/// does not fire again on the next tick. That common tail is `resolveWith`, and until
/// these were collected it was impossible to see that `policeTravel` does not use it.
///
/// Nothing here decides a rule. `GameState` owns what a call *means*; `Rules.swift` owns
/// whether the geometry is one; this file only notices, says it, and puts the bodies
/// back. `Engine` keeps the tick that calls in, because the order of `policeTravel` and
/// `policeCalls` against `game.step` is a property of the tick and not of the calls.

/// The state the calls layer owns, in one object.
///
/// **The failure mode of a latch is a latch that is never cleared**, and there were four
/// of these scattered through `Engine` among thirty other stored properties. Collecting
/// them makes the set visible: a match-long tally, a contact window, the marking-foul
/// latch and the per-defender pick watch. `Engine` holds one of these and reads
/// `callTally` through it, so the public surface is unchanged.
final class CallState {
    /// Calls made this match, by kind. Telemetry only; read out as `Engine.callTally`.
    var tally = Engine.CallTally()
    /// The hardest recent opposing hit on each body, kept for `CATCH_CONTACT_WINDOW`.
    /// Cleared at every point boundary by `stagePoint`, because a buffered hit whose
    /// bodies were rebuilt underneath it would be blamed on whoever inherited the id.
    var lastContact: [Int: Engine.ContactMark] = [:]
    /// Latched so one act of contact is one marking foul, not one per tick. Cleared the
    /// moment the two bodies come apart.
    var markFoulHeld = false
    /// Per defender: what he was doing when the obstruction on him began, and whether he
    /// has already called it. Cleared when the obstruction clears.
    var pickWatch: [Int: Engine.PickWatch] = [:]

    /// Team attempts at the moment the current point began, and which point that was.
    ///
    /// The one thing `Engine.considerTimeout` needs that is not derivable from the
    /// machine: "has this team thrown yet this point", which is what separates a set play
    /// called off the pull from one called in the middle of a possession. Lives here rather
    /// than as a new stored property on `Engine` because a stoppage is a stoppage — this
    /// object already holds the state of the other four.
    var pointAttempts: (Int, Int) = (0, 0)
    var attemptsPoint = -1

    /// `(team, that team's possession count)` for the last timeout called, so
    /// `Playbook.TimeoutRead.stoppedThisPossession` is derivable. `-1` is "never".
    var timeoutPossession: (TeamId, Int) = (-1, -1)
}

extension Engine {
    /// A travel, called and resolved.
    ///
    /// `GameState.observe` has already flagged it and written the play-by-play line; a
    /// flag is not a call. In a self-officiated sport somebody has to say it, and the
    /// only body close enough to see the foot is the mark — so a travel nobody is
    /// marking is a travel nobody calls, which is both the rule and the reason this is
    /// gated on there being a marker.
    ///
    /// The remedy is WFDF 18.2.4: the thrower returns to his pivot and the count backs
    /// up one. `resolveCall` owns both halves of that; all this does is put the body
    /// back on the spot the machine kept for it and re-establish the foot there, without
    /// which the same call fires again on the very next step.
    func policeTravel() {
        guard game.phase == .livePossession,
            let id = game.thrower, let thrower = player(id),
            let marker = game.marker,
            let foot = loco.pivotOf(id),
            isTravel(game.pivot, Vec3d(foot.x, 0, foot.z), game.rules)
        else { return }
        guard game.makeCall(.travel, marker, id, Vec3d(foot.x, 0, foot.z)).ok else { return }
        game.resolveCall(false)
        thrower.pos.x = game.pivot.x
        thrower.pos.z = game.pivot.z
        thrower.vel = .zero
        if let body = loco.get(id) {
            body.pos.x = game.pivot.x
            body.pos.z = game.pivot.z
            body.vel = .zero
        }
        loco.rePivot(id, game.pivot.x, game.pivot.z)
        calls.tally.travel += 1
    }

    /// Calls made this match, by kind, plus how many of them were contested.
    /// Telemetry only — nothing in the simulation reads it. A call rate is the one
    /// number that says whether the detection below is a rule or a nuisance.
    public struct CallTally: Equatable, Sendable {
        public var foul = 0
        public var pick = 0
        public var strip = 0
        public var travel = 0
        public var contested = 0
        public var total: Int { foul + pick + strip + travel }
        public init() {}
    }

    /// THE HIT, RECORDED WHERE IT HAPPENS.
    ///
    /// `Locomotion` measures a collision's closing speed BEFORE it spends it on an
    /// impulse, and it is the only place in the game where that number exists. By the time
    /// the disc is stepped and a catch fails, the impulse has already removed the velocity
    /// that caused it: measured over three matches, every defender still inside a receiver
    /// at the instant of a drop had a residual closing speed of 0.0-0.5 m/s. A receiving
    /// foul derived from the geometry at the catch is therefore a detector that can never
    /// fire, and the honest reading of that is not "there are no receiving fouls" but "you
    /// are asking the wrong tick".
    ///
    /// So the contact is caught at source — `Locomotion`'s `.contact` event, via the
    /// `LocoHost` this engine attaches for exactly this — and kept for
    /// `CATCH_CONTACT_WINDOW`. Only opposing contact is kept: running into a team-mate is
    /// a foul on nobody.
    struct ContactMark {
        var otherId: Int
        var impact: Double
        var t: Double
    }

    func noteContact(_ id: Int, _ otherId: Int, _ impact: Double) {
        guard let me = player(id), let them = player(otherId), me.team != them.team else { return }
        // Within one window the hardest hit is the one that decided the play.
        if let prev = calls.lastContact[id], game.clock - prev.t <= CATCH_CONTACT_WINDOW,
            prev.impact >= impact
        { return }
        calls.lastContact[id] = ContactMark(otherId: otherId, impact: impact, t: game.clock)
    }

    /// Per defender: what he was doing when the obstruction on him began.
    struct PickWatch {
        var speed: Double
        var gap: Double
        var called: Bool
    }

    /// NOBODY IS WATCHING BUT THE FOURTEEN OF THEM.
    ///
    /// Ultimate has no referee: a foul exists when the player it happened to says so,
    /// and it goes away when the player it is said about disagrees. The rules machine
    /// has always known the consequences — `makeCall` / `resolveCall` handle contested
    /// and uncontested, marking fouls, receiving fouls, picks and strips — and until now
    /// the only thing that ever spoke to it was `policeTravel`. This is the rest of the
    /// mouth.
    ///
    /// Two of the four live here, because both are things that are true of the frame
    /// rather than of an event: the mark leaning on a thrower who has nowhere to go, and
    /// a defender running into a body that was not his to worry about. The other two —
    /// the receiving foul and the strip — belong to the instant a catch fails and are
    /// made in `policeCatch`.
    ///
    /// ONE CALL PER EPISODE. Both detectors latch: a marking foul is not called again
    /// until the two bodies come apart, and a pick is not called again until the
    /// obstruction clears. Without that the first frame of contact is followed by a
    /// hundred and nineteen more of it, and a rule that is correct becomes a game that is
    /// unplayable.
    ///
    /// Ported from `Game.ts:policeCalls`.
    func policeCalls() {
        // The other thing somebody has to say out loud. It rides this hook rather than
        // getting its own line in `Engine.step` because the tick belongs to `Engine` and
        // this is the tick a stoppage is decided on; see `considerTimeout`.
        considerTimeout()
        guard game.phase == .livePossession,
            let throwerId = game.thrower,
            let thrower = loco.get(throwerId)
        else { return }

        let markerId = game.marker

        // THE MARK ON A MAN WHO CANNOT STEP AWAY.
        //
        // The thrower is `anchored` while he holds it, so the contact resolver gives him
        // infinite mass and the marker takes the whole positional correction — which is
        // the right physics and, in the rules, exactly the event being described. A
        // defender who has to be pushed back out of the thrower every tick has fouled him.
        if let markerId, let marker = loco.get(markerId) {
            if !contactBetween(marker, thrower).touching {
                calls.markFoulHeld = false
            } else if !calls.markFoulHeld {
                let impact = markingFoulImpact(marker, thrower, game.stallElapsed)
                if impact > 0 {
                    calls.markFoulHeld = true
                    let at = Vec3d(thrower.pos.x, 0, thrower.pos.z)
                    if game.makeCall(.foul, throwerId, markerId, at).ok {
                        resolveWith(
                            .foul,
                            CallSituation(
                                impact: impact, threshold: MARK_FOUL_IMPACT,
                                playedDisc: false, plainToSee: false,
                                decision: player(markerId)?.attr.decision ?? 72))
                        return
                    }
                }
            }
        } else {
            calls.markFoulHeld = false
        }

        // THE PICK, and what makes one a call rather than a collision.
        //
        // Bodies brush past each other two hundred times a match and none of that is a
        // pick. What a defender actually calls is an obstruction that COST him, so both
        // halves of the cost are measured against what he was doing at the instant it
        // started: the speed he has lost, and the ground his matchup has gained. See
        // `pickIsWorthCalling`.
        //
        // A zone defender has no matchup and cannot be picked; the mark is guarding the
        // disc rather than chasing anyone, and is left out for the same reason.
        guard let offenceTeam = game.possession else { return }
        let offence = players.compactMap { $0.team == offenceTeam ? loco.get($0.id) : nil }
            .filter { loco.isAvailable($0) }
        for d in players where d.team != offenceTeam {
            if d.id == markerId { continue }
            guard let dp = loco.get(d.id), loco.isAvailable(dp) else {
                calls.pickWatch.removeValue(forKey: d.id)
                continue
            }
            guard let matchupId = ai.first(where: { $0.team == d.team })?.matchupOf(d.id),
                let mp = loco.get(matchupId)
            else {
                calls.pickWatch.removeValue(forKey: d.id)
                continue
            }
            guard let obstructor = obstructionOf(dp, offence, throwerId, matchupId) else {
                calls.pickWatch.removeValue(forKey: d.id)
                continue
            }

            let speed = Foundation.hypot(dp.vel.x, dp.vel.z)
            let gap = Foundation.hypot(dp.pos.x - mp.pos.x, dp.pos.z - mp.pos.z)
            guard var w = calls.pickWatch[d.id] else {
                calls.pickWatch[d.id] = PickWatch(speed: speed, gap: gap, called: false)
                continue
            }
            if w.called { continue }
            if !pickIsWorthCalling(lostSpeed: w.speed - speed, gainedGap: gap - w.gap) {
                continue
            }
            w.called = true
            calls.pickWatch[d.id] = w
            guard game.makeCall(.pick, d.id, obstructor).ok else { continue }
            resolveWith(
                .pick,
                CallSituation(
                    impact: 0, threshold: 0, playedDisc: false, plainToSee: true,
                    decision: player(obstructor)?.attr.decision ?? 72))
            return
        }
    }

    /// CONTACT AT THE CATCH — the receiving foul and the strip.
    ///
    /// Called from `tryCatch` at the instant the contest has decided the offence does not
    /// have it, and BEFORE that outcome is reported, because a foul means the pass never
    /// happened: the machine's receiving-foul remedy puts the disc in the receiver's
    /// hands at the spot, and it can only do that while the phase is still
    /// `DISC_IN_FLIGHT`.
    ///
    /// Returns true when a call was made, in which case the caller must not report the
    /// drop or the block — there is no turnover to report.
    ///
    /// Ported from `Game.ts:policeCatch`.
    func policeCatch(
        _ offence: TeamId?, at: Vec3d, established: Bool, taker: Int
    ) -> Bool {
        guard let offence, game.phase == .discInFlight else { return false }

        // The offensive body the disc was arriving at. A little wider than a catch,
        // because the man who was fouled is by definition the man who did not get his
        // hands to it.
        var receiver: LocoPlayer?
        var bestGap = CatchDecision.catchReach * 1.5
        for p in players where p.team == offence {
            guard let lp = loco.get(p.id) else { continue }
            let g = Foundation.hypot(lp.pos.x - at.x, lp.pos.z - at.z)
            if g < bestGap {
                bestGap = g
                receiver = lp
            }
        }
        guard let receiver else { return false }

        // Whoever hit him, and how hard, from `Locomotion`'s own measurement of the
        // collision rather than a re-derivation off the post-impulse velocities.
        guard let hit = calls.lastContact[receiver.id], game.clock - hit.t <= CATCH_CONTACT_WINDOW,
            let defender = player(hit.otherId), defender.team != offence
        else { return false }

        let kind = actionOf[defender.id]?.kind
        // A man who got a hand on it played the disc whatever his intent said he was
        // doing — the block is the evidence, and it is his whole defence.
        let defenderPlayed = defender.id == taker
            || kind == "bid" || kind == "jump" || kind == "catch"
        let call = catchContactCall(
            impact: hit.impact, defenderPlayedDisc: defenderPlayed,
            possessionEstablished: established)
        // One hit is one call.
        calls.lastContact.removeValue(forKey: receiver.id)
        guard let call else { return false }

        let type: CallType = call.kind == .strip ? .strip : .foul
        guard game.makeCall(type, receiver.id, defender.id, Vec3d(at.x, 0, at.z)).ok else {
            return false
        }
        resolveWith(
            type,
            CallSituation(
                impact: call.impact, threshold: CATCH_FOUL_IMPACT,
                playedDisc: defenderPlayed, plainToSee: false,
                decision: defender.attr.decision),
            receiverId: receiver.id)
        // The flight is over, but it did not end in a turnover: the machine has already
        // put the disc in a hand, so `afterFlight`'s `syncDisc` finds it there.
        afterFlight()
        return true
    }

    /// Resolve the outstanding call and put the bodies where the machine now says play
    /// restarts from.
    ///
    /// The reposition is `policeTravel`'s, for `policeTravel`'s reason: a stoppage that
    /// leaves the thrower two metres from his own pivot is a stoppage that hands out free
    /// yardage, and one that leaves the fouling body inside him calls the same foul again
    /// on the next tick.
    private func resolveWith(
        _ type: CallType, _ situation: CallSituation, receiverId: PlayerId? = nil
    ) {
        let contested = callContested(situation)
        game.resolveCall(contested, receiverId: receiverId)
        switch type {
        case .foul: calls.tally.foul += 1
        case .pick: calls.tally.pick += 1
        case .strip: calls.tally.strip += 1
        case .travel: calls.tally.travel += 1
        case .violation: break
        }
        if contested { calls.tally.contested += 1 }
        guard let id = game.thrower, let p = player(id) else { return }
        p.pos.x = game.pivot.x
        p.pos.z = game.pivot.z
        p.vel = .zero
        if let body = loco.get(id) {
            body.pos.x = game.pivot.x
            body.pos.z = game.pivot.z
            body.vel = .zero
        }
        loco.rePivot(id, game.pivot.x, game.pivot.z)
    }
}
