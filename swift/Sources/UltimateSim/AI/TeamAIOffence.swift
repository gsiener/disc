import Foundation

/// The offensive half of `TeamAI` — `src/sim/AI.ts` lines 1143-1975.
///
/// Everything about the shape on the field: where bodies stand when they are not
/// cutting, which slot in the column each of them holds, which cut each position is
/// allowed to offer, and how a route is run and retired.
///
/// **RNG draw order is behaviour in this file.** `tickCutters` draws once per candidate
/// cut kind *before* the lane checks that may discard it, and `tickHandlerCuts` draws
/// the swing's coin inside a short-circuiting `&&` chain and the route jitter only after
/// the lane check passes. Moving any of those either way produces a different but
/// entirely plausible offence from the same seed. Each site is commented.
extension TeamAI {

    // MARK: - offence

    func offence(_ world: AIWorld, _ dt: Double) -> [PlayerIntent] {
        let disc = world.disc
        var out: [PlayerIntent] = []
        refreshStackSlots(dt)

        // Disc on the ground: nearest player picks it up, the rest re-form.
        if disc.state == .ground {
            var best: AIPlayer?
            var bd = 1e9
            for p in mates {
                let d = Playbook.dist2(p.pos.x, p.pos.z, disc.pos.x, disc.pos.z)
                if d < bd {
                    bd = d
                    best = p
                }
            }
            // A turnover very often leaves the disc ON the line, and this is the one
            // target in the file that was not clamped inside it. It has to be.
            // `boundaryRoom` measures room along a ray, so a body standing on the
            // perimeter and pointed even slightly further out has ZERO room — and the
            // speed cap built on it caps TOTAL speed, not the outward component. A
            // collector who arrives level with a sideline disc is therefore frozen in
            // every direction, including the one he needs, and the match never
            // restarts: measured over twelve 400 s seeds, one wedged for 103 s with the
            // collector 6.35 m away and stationary.
            let cp = pb.clampToField(Vec2d(disc.pos.x, disc.pos.z), margin: 0.75)
            for p in mates {
                if p === best {
                    out.append(
                        intent(
                            p, cp.x, cp.z, 0, Double(dir), .sprint, 1.0,
                            bd < 1.1 ? .pickup : nil,
                            role: p.role.rawValue, state: "pickup", lane: nil, dt: dt))
                } else {
                    let st = stationFor(p, world, ax: disc.pos.x, az: disc.pos.z)
                    out.append(
                        intent(
                            p, st.x, st.z, 0, Double(dir), .jog, 0.55, nil,
                            role: p.role.rawValue, state: "reform", lane: nil, dt: dt))
                }
            }
            return out
        }

        // Smooth the formation anchor so the stack does not snap on every catch.
        // ALIAS SITE. Reference: `this.anchor.x += ...` writes through a stored literal;
        // a stored struct property assigns through to the owner.
        let k = Swift.min(1, dt * 4.0)
        anchor.x += (disc.pos.x - anchor.x) * k
        anchor.z += (disc.pos.z - anchor.z) * k

        readForce(world, dt)
        let windSpeed = Foundation.hypot(world.wind.x, world.wind.z)
        // Formation calls are held for a beat before they are honoured. The triggers are
        // thresholds on the disc position, and a disc sitting on one of them made the
        // whole stack slide 20 m across the field and back at whatever rate the thrower
        // pivoted. A shape that teleports is not a shape.
        let want = pb.chooseFormation(anchor, dir, cfg.formation, windSpeed, openSign)
        if want == formation {
            formWant = want
            formHold = 0
        } else {
            if want != formWant {
                formWant = want
                formHold = 0
            }
            formHold += dt
            if formHold >= 0.6 {
                formation = want
                formHold = 0
                applyRoleSplit(world, rebuild: false)
            }
        }

        if disc.state == .flight { return offenceInFlight(world, dt) }

        let thrower: AIPlayer? = disc.carrier.flatMap { byId[$0] }
        if let t = thrower, t.id == holdCarrier {
            holdTime += dt
        } else {
            holdCarrier = thrower?.id
            holdTime = 0
        }
        stallRead = Swift.max(disc.stall, holdTime - 2.5)
        if let t = thrower, t.id != lastCarrier {
            lastCarrier = t.id
            threwThisPossession = false
            choice = nil
            windup = 0
            assignHandlerStations(world)
        }

        tickCutters(world, dt, thrower)
        tickHandlerCuts(world, dt, thrower)

        // Thrower decision at 8 Hz, held between ticks so the choice does not flicker.
        var throwAction: PlayerAction?
        if let t = thrower {
            decisionTimer -= dt
            if decisionTimer <= 0 {
                decisionTimer = 0.125
                decide(world, t)
            }
            throwCooldown = Swift.max(0, throwCooldown - dt)
            // A released throw the game system never consumed must not deadlock the
            // thrower: the guard expires, it does not latch.
            if threwThisPossession && throwCooldown == 0 { threwThisPossession = false }
            if let c = choice {
                windup += dt
                let releaseAt = 0.20 + 0.12 * (1 - t.attr.throwPower / 100)
                if windup >= releaseAt && !threwThisPossession {
                    throwAction = release(world, t, c)
                    threwThisPossession = true
                    throwCooldown = 0.5
                    choice = nil
                }
            } else {
                windup = 0
            }
        }

        for p in mates {
            if let t = thrower, p.id == t.id {
                let aim = choice?.aim
                let fx = aim != nil ? aim!.x - p.pos.x : 0
                let fz = aim != nil ? aim!.z - p.pos.z : Double(dir)
                // The thrower holds his ground — but he is the one body in the game
                // asked to stand still next to a defender pressing in, and a pivot on
                // the sideline can be nudged over the line by contact separation with no
                // intent that ever brings him back. So his "stand here" is the nearest
                // legal point, and he steps in if he is not on one.
                let foot = pb.clampToField(
                    Vec2d(p.pos.x, p.pos.z), margin: pb.edgeMargin + 0.25)
                let outBy = Foundation.hypot(foot.x - p.pos.x, foot.z - p.pos.z)
                out.append(
                    intent(
                        p, foot.x, foot.z, fx, fz,
                        throwAction != nil ? .throw : (choice != nil ? .throw : .pivot),
                        outBy > 0.05 ? 0.22 : 0,
                        throwAction,
                        role: "thrower", state: choice != nil ? "windup" : "pivot",
                        lane: nil, dt: dt))
                continue
            }
            out.append(cutterIntent(p, world, dt))
        }
        return out
    }

    /// Infer the force from where the mark is actually standing.
    ///
    /// The first sight of the mark in a possession is taken at face value — a team is
    /// told the force before the pull, and the offence should not spend two seconds
    /// working it out. After that it takes sustained contrary evidence to flip, because
    /// `openSign` is the axis the entire shape is built on: the stack column, both
    /// handler stations and the side every cut attacks. A shape that mirrors itself
    /// every time the marker shuffles is not a shape, and it is the difference between
    /// "the offence is playing a force" and "the offence is milling about".
    func readForce(_ world: AIWorld, _ dt: Double) {
        let disc = world.disc
        guard let carrier = disc.carrier, let t = byId[carrier] else { return }
        var markX = 0.0
        var bd = 3.6
        for f in foes {
            let d = Playbook.dist2(f.pos.x, f.pos.z, t.pos.x, t.pos.z)
            if d < bd {
                bd = d
                markX = f.pos.x - t.pos.x
            }
        }
        // Too far off or square in front: the marker is not saying anything yet.
        if !(bd < 3.6 && abs(markX) > 0.45) { return }
        // The mark stands on the side it is taking away, so open is the other side.
        let observed: Playbook.Sign = -jsSign(markX)

        if !forceSeen {
            forceSeen = true
            openRead = Double(observed)
            if openCommit != observed {
                openCommit = observed
                assignHandlerStations(world)
            }
            return
        }
        let k = Swift.min(1, dt / 0.45)
        openRead = clamp(openRead + (Double(observed) - openRead) * k, -1, 1)
        if openRead * Double(openCommit) < 0 && abs(openRead) > 0.55 {
            openCommit = openRead >= 0 ? 1 : -1
            assignHandlerStations(world)
        }
    }

    // MARK: - stations

    func assignHandlerStations(_ world: AIWorld) {
        let stations = pb.formationStations(formation, anchor, dir, openSign)
            .filter { $0.role == .handler }
        let throwerId = world.disc.carrier
        var ids = handlerRing.filter { $0 != throwerId && byId[$0] != nil }
        handlerStation.removeAll()
        // Fill stations IN ORDER, nearest free handler to each. Station 0 is the reset;
        // with two handlers and one of them holding the disc there is only ever one body
        // to place, and it has to be the one the dump goes to. Greedy-by-handler filled
        // whichever station happened to be closer, which is how a reset ends up standing
        // in front of the disc.
        var s = 0
        while s < stations.count && !ids.isEmpty {
            var bi = 0
            var bd = 1e9
            for i in 0..<ids.count {
                let p = byId[ids[i]]!
                let d = Playbook.dist2(p.pos.x, p.pos.z, stations[s].x, stations[s].z)
                if d < bd {
                    bd = d
                    bi = i
                }
            }
            handlerStation[ids[bi]] = s
            ids.remove(at: bi)
            s += 1
        }
    }

    /// Which slot in the column each cutter holds — over the cutters actually STANDING
    /// IN IT, not over the whole squad.
    ///
    /// Counting absent bodies leaves a 4.2 m hole wherever somebody is away cutting, so
    /// a five-man stack with two cuts out reads as three people with no relationship to
    /// each other. Real stacks collapse to fill.
    ///
    /// And the slots are handed out in PHYSICAL order down the column, not by squad
    /// rank, so filling in never asks two settled players to swap through each other. A
    /// player on his way back from a cut is sorted to the tail, because the tail is
    /// where a clear goes.
    func refreshStackSlots(_ dt: Double) {
        slotScratch.removeAll(keepingCapacity: true)
        var sig = 17
        for id in stackOrder {
            let st = m(id).cutState
            if st == .stack || st == .clear {
                slotScratch.append(id)
                // The reference accumulates this in a double. With at most a handful of
                // ids the product stays far inside 2^53, so Int arithmetic is exact and
                // identical.
                sig = sig &* 31 &+ id
            }
        }
        // Slots are piecewise constant: they are re-dealt when somebody joins or leaves
        // the column, not continuously. Re-sorting by depth every frame lets two bodies
        // of nearly equal depth trade places at 120 Hz, which converges them onto each
        // other instead of onto their slots. A stack re-forms on an event; it does not
        // renegotiate itself every step.
        if sig == slotSig {
            slotPending = sig
            slotPendingT = 0
            return
        }
        if sig != slotPending {
            slotPending = sig
            slotPendingT = 0
        }
        slotPendingT += dt
        // And it re-forms once, not twice. A cut that starts and a cut that ends 200 ms
        // apart would otherwise shuffle every body 4.2 m up the column and then 4.2 m
        // back down it. A body with no slot at all is dealt in at once.
        var orphan = false
        for id in slotScratch where slotOf[id] == nil {
            orphan = true
            break
        }
        if !orphan && slotPendingT < 0.35 { return }
        slotSig = sig

        // Slots are dealt by depth, which is right for a column. Ordering by `pos.x` for
        // spread sets was tried and REVERTED: it costs a `test-ai` horizontal-shape
        // assertion and drops the human's directional receiver select from agreeing with
        // the stick 75%+ of the time to 67-69%, because two cutters end up near-equal on
        // angle and the openness term decides instead.
        func key(_ q: Int) -> Double {
            guard let p = byId[q] else { return 1e9 }
            let clearing = m(q).cutState == .clear ? 1e5 : 0.0
            return clearing + Double(dir) * (p.pos.z - anchor.z)
        }
        // Total order via the `|| (a - b)` tiebreak, so JavaScript's stable sort and
        // Swift's unstable one cannot disagree.
        slotScratch.sort { a, b in
            let ka = key(a)
            let kb = key(b)
            if ka != kb { return ka < kb }
            return a < b
        }
        slotOf.removeAll()
        for i in 0..<slotScratch.count { slotOf[slotScratch[i]] = i }
    }

    func stackSlot(_ id: Int) -> Int {
        slotOf[id] ?? Swift.max(0, slotOf.count)
    }

    /// How many cutters are holding the column right now.
    func stackedCount() -> Int {
        var n = 0
        for id in stackOrder where m(id).cutState == .stack { n += 1 }
        return n
    }

    /// Where this player wants to stand when not cutting.
    func stationFor(
        _ p: AIPlayer, _ world: AIWorld, ax: Double? = nil, az: Double? = nil
    ) -> Vec2d {
        let axx = ax ?? anchor.x
        let azz = az ?? anchor.z
        let stations = pb.formationStations(formation, Vec2d(axx, azz), dir, openSign)
        let handlers = stations.filter { $0.role == .handler }
        let cutters = stations.filter { $0.role == .cutter }
        if p.role == .handler {
            if let idx = handlerStation[p.id], idx >= 0, idx < handlers.count {
                return Vec2d(handlers[idx].x, handlers[idx].z)
            }
            // Overflow handler (three handlers, two stations): a deep reset, wide on the
            // open side. Never the back of the stack — that is a cutter's spot.
            return pb.clampToField(
                Vec2d(axx + Double(openSign) * 11, azz - Double(dir) * 9.5))
        }
        let si = stackOrder.contains(p.id) ? stackSlot(p.id) : cutters.count - 1
        // `cutters[clamp(si, 0, cutters.length - 1)]` indexes out of bounds and yields
        // `undefined` when the row is empty; the `??` below is that fallback.
        let idx = Int(clamp(Double(si), 0, Double(cutters.count - 1)))
        if idx >= 0 && idx < cutters.count {
            return Vec2d(cutters[idx].x, cutters[idx].z)
        }
        return Vec2d(axx, azz)
    }

    // MARK: - cutting

    func liveCutCount() -> Int {
        var n = 0
        for id in stackOrder {
            let st = m(id).cutState
            if st == .setup || st == .plant || st == .break { n += 1 }
        }
        return n
    }

    func tickCutters(_ world: AIWorld, _ dt: Double, _ thrower: AIPlayer?) {
        let disc = Vec2d(world.disc.pos.x, world.disc.pos.z)

        // THE LOOP READS `stackOrder` LIVE, AND THAT IS BEHAVIOUR, NOT STYLE.
        //
        // `endCut(id, .clear)` rotates the player it just retired to the BACK of
        // `stackOrder` — that rotation is the mechanic that keeps a stack from
        // collapsing after a cut — and the reference runs this loop as `for (const id of
        // this.stackOrder)`, whose iterator reads `array[i++]` from the live array on
        // every step. So splicing element `i` out and pushing it to the end has two
        // visible effects in the same frame: the element that was at `i + 1` is SKIPPED,
        // and the retired player is VISITED A SECOND TIME at the tail — this time in
        // `clear`, where `cutT += dt` and the lane test can send him straight back to
        // `stack` on the very frame his cut ended.
        //
        // `for id in stackOrder` in Swift iterates a copy, so it does neither, and a
        // cutter spends one extra frame clearing. That one frame is enough to keep the
        // lane reserved through the next cut-initiation pass, so a DIFFERENT player is
        // offered the next cut and the two simulations part company for good. It showed
        // up on frame 1,202 of a 1,280-frame trace and nowhere earlier, which is exactly
        // the failure mode this fixture exists to catch.
        var i = 0
        while i < stackOrder.count {
            let id = stackOrder[i]
            i += 1
            guard let p = byId[id] else { continue }
            let rec = m(id)
            if rec.cutState == .stack { continue }
            rec.cutT += dt
            guard let cut = rec.cut else {
                rec.cutState = .stack
                continue
            }

            switch rec.cutState {
            case .setup:
                let d = Playbook.dist2(p.pos.x, p.pos.z, cut.setup.x, cut.setup.z)
                if rec.cutT >= cut.setupTime || d < 0.8 {
                    rec.cutState = .plant
                    rec.cutT = 0
                }
            case .plant:
                if rec.cutT >= Playbook.PLAY.plantTime {
                    rec.cutState = .break
                    rec.cutT = 0
                }
            case .break:
                let d = Playbook.dist2(p.pos.x, p.pos.z, cut.target.x, cut.target.z)
                let dead = thrower == nil || world.disc.state != .held
                // Keep running while the thrower is winding up to you — bailing out
                // mid-windup is how a cutter turns a good look into a turnover.
                let beingThrownTo = choice?.receiverId == id && rec.cutT < cut.maxTime + 0.9
                if !beingThrownTo && (d < 1.3 || rec.cutT >= cut.maxTime || dead) {
                    endCut(id, .clear)
                }
            case .clear:
                // A clear is finished when the body is OUT OF THE LANE, not when it has
                // jogged all the way to the back of the stack. Waiting for the latter
                // kept every cutter in the "clearing" state for most of the possession
                // and emptied the column; the lane is vacated the moment he is back on
                // the line of the stack.
                let back = stationFor(p, world)
                let axis = stackAxisX
                let lat = abs(p.pos.x - axis)
                let d = Playbook.dist2(p.pos.x, p.pos.z, back.x, back.z)
                if lat < 3.2 || d < 2.4 || rec.cutT >= 2.2 {
                    rec.cutState = .stack
                    rec.cutT = 0
                    rec.cut = nil
                    rec.cutCooldown =
                        0.55 + 1.0 * (1 - p.attr.stamina / 100) * (1.4 - p.energy)
                }
            case .stack:
                break
            }
        }

        // ------------------------------------------------ initiate a new cut
        guard thrower != nil, world.disc.state == .held else { return }
        if liveCutCount() >= Playbook.PLAY.maxLiveCuts { return }
        if world.time - lastCutStart < Playbook.PLAY.cutStagger { return }
        // The stack has to survive the cut. At stall 8 the shape stops mattering and
        // getting rid of the disc starts to; before then, a cutter who would leave fewer
        // than `stackHold` bodies in the column stays where he is.
        let stackHold = Playbook.stackHold(playersPerSide: rankedIds.count)
        let hold =
            stallRead >= 8
            ? stackHold - 2
            : (stallRead >= 6 ? stackHold - 1 : stackHold)
        if stackedCount() - 1 < hold { return }

        let openSign = self.openSign
        let brk: Playbook.Sign = -openSign
        let stall = stallRead
        var bestId = -1
        var bestCut: Playbook.CutRoute?
        var bestScore = 0.0
        var bestDepth = -1

        for id in stackOrder {
            guard let p = byId[id] else { continue }
            let rec = m(id)
            if rec.cutState != .stack || rec.cutCooldown > 0 { continue }

            let from = Vec2d(p.pos.x, p.pos.z)
            var kinds: [(kind: Playbook.CutKind, side: Playbook.Sign)] = []
            // WHICH CUT YOU MAKE IS DECIDED BY WHERE YOU STAND, not by your place in
            // `stackOrder`, which `endCut` rotates on every clear — that says who cut
            // least recently, a fairness counter rather than a position on the field.
            // `stackSlot` is the geometric one: it is what `stationFor` uses to place the
            // body, so slot 0 is the man actually standing at the front.
            let depth = stackSlot(id)
            let nCol = Swift.max(1, slotOf.count)
            if formation == .endzone {
                kinds.append((.strike, openSign))
                kinds.append((.strike, brk))
            } else if !Playbook.hasColumn(formation) {
                // A ROW HAS NO FRONT AND NO BACK. In a horizontal set all four cutters
                // stand at the same depth, so a depth rule sorts them by noise; the shape
                // exists to give each of them the same two options in their own lane —
                // four isolated one-on-ones across the width of the field. The lane
                // system is what stops them clogging, and it already does.
                kinds.append((.deep, openSign))
                kinds.append((.under, openSign))
                kinds.append((.breakUnder, brk))
            } else {
                // THE FRONT OF THE STACK GOES DEEP AND THE BACK COMES UNDER. This was
                // exactly backwards once, and it is the rule the whole shape is built on.
                //
                // A vertical stack manufactures two spaces: the under, between the disc
                // and the front of the column, and the deep, behind the back of it. The
                // man at the FRONT is marked from in front — his defender is between him
                // and the disc, protecting the under — so his open cut is the one that
                // runs away. The man at the BACK is marked from behind, so his open cut
                // is the one coming back.
                //
                // Inverted, every cut in the game was contested by construction.
                if depth <= 1 {
                    kinds.append((.deep, openSign))
                    kinds.append((.deep, brk))
                }
                if depth >= nCol - 2 {
                    kinds.append((.under, openSign))
                    kinds.append((.breakUnder, brk))
                }
                if kinds.isEmpty { kinds.append((.under, openSign)) }
            }

            for kc in kinds {
                // DRAW SITE. The jitter is consumed for every candidate kind, BEFORE the
                // two lane rejections below. A port that drew after the checks would
                // consume fewer draws on a busy possession and diverge from there on.
                let j = rng.next()
                let cut = pb.buildCut(kc.kind, from, disc, dir, openSign, kc.side, j)
                if liveLanes[cut.lane] != nil { continue }
                if !laneClearOfLiveTargets(cut) { continue }
                let s = scoreCut(p, cut, world, depth, stall)
                if bestCut == nil || s > bestScore {
                    bestId = id
                    bestCut = cut
                    bestScore = s
                    bestDepth = depth
                }
            }
        }

        if let cut = bestCut, bestScore > 0.18 {
            // The depth recorded is provably the depth that was scored, rather than a
            // second reading of `stackSlot` that only happens to agree.
            beginCut(bestId, cut, .setup, depth: Double(bestDepth))
            liveLanes[cut.lane] = bestId
            lastCutStart = world.time
        }
    }

    /// Commit a player to a route. THE ONE PLACE `m.cut` IS ARMED.
    ///
    /// `cutDepth` is telemetry the shape assertions are built on, and it is a property OF
    /// THE CUT — which position in the column offered it — so it has to be written and
    /// cleared with the cut, not near it. It was once set at only one of the three sites
    /// that arm a route, so a handler's dump and a human-commanded cut both published
    /// whatever depth that player last happened to cut from as a stack cutter: measured,
    /// 249 dumps reporting a mean stack depth of 1.00.
    ///
    /// Depth is meaningless for a cut that did not come out of the column, and -1 says so
    /// rather than lying with a stale number.
    func beginCut(
        _ id: Int, _ cut: Playbook.CutRoute, _ state: CutState, depth: Double = -1
    ) {
        let rec = m(id)
        rec.cut = cut
        rec.cutState = state
        rec.cutT = 0
        rec.cutDepth = depth
    }

    /// Order-independent: a pure "does any live target sit within 6 m of this one".
    func laneClearOfLiveTargets(_ cut: Playbook.CutRoute) -> Bool {
        for (_, id) in liveLanes {
            guard let other = m(id).cut else { continue }
            if Playbook.dist2(cut.target.x, cut.target.z, other.target.x, other.target.z)
                < 6.0
            {
                return false
            }
        }
        return true
    }

    func endCut(_ id: Int, _ next: CutState) {
        let rec = m(id)
        if let cut = rec.cut, liveLanes[cut.lane] == id {
            liveLanes.removeValue(forKey: cut.lane)
        }
        rec.cutState = next
        rec.cutT = 0
        if next == .clear {
            // Rotate to the back of the stack — the real mechanic that keeps the stack
            // from collapsing after a cut.
            if let i = stackOrder.firstIndex(of: id) {
                stackOrder.remove(at: i)
                stackOrder.append(id)
            }
        }
    }

    /// How good this cut looks, 0…~1.6. Attributes drive most of it.
    func scoreCut(
        _ p: AIPlayer, _ cut: Playbook.CutRoute, _ world: AIWorld, _ depth: Int,
        _ stall: Double
    ) -> Double {
        let def = nearestFoe(p.pos.x, p.pos.z)
        var s = 0.30

        // Athletic edge over the matched defender.
        if let def {
            let edge =
                (p.attr.speed - def.attr.speed) * 0.004
                + (p.attr.acceleration - def.attr.acceleration) * 0.003
                + (p.attr.agility - def.attr.agility) * 0.002
            s += clamp(edge, -0.30, 0.35)
            // Cutting away from where the defender is standing is worth a lot.
            let dx = cut.target.x - p.pos.x
            let dz = cut.target.z - p.pos.z
            let lRaw = Foundation.hypot(dx, dz)
            let l = lRaw == 0 || lRaw.isNaN ? 1 : lRaw
            let gx = def.pos.x - p.pos.x
            let gz = def.pos.z - p.pos.z
            let glRaw = Foundation.hypot(gx, gz)
            let gl = glRaw == 0 || glRaw.isNaN ? 1 : glRaw
            let alignment = (dx / l) * (gx / gl) + (dz / l) * (gz / gl)
            s += -0.22 * alignment
        }

        // Space: how empty is the target? Accumulated in `world.players` order, because
        // floating-point addition is not associative and this is a running sum.
        var crowd = 0.0
        for q in world.players {
            if q.id == p.id { continue }
            let d = Playbook.dist2(q.pos.x, q.pos.z, cut.target.x, cut.target.z)
            if d < 8 { crowd += (8 - d) / 8 }
        }
        s -= 0.12 * crowd

        // Situational weighting.
        let deep = cut.kind == .deep
        if deep {
            s += 0.16 * cfg.aggression
            s -= 0.30 * Playbook.smoothstep(3, 8, stall)  // no hucks at stall 8
            s -= 0.35 * Playbook.smoothstep(30, 12, pb.yardsToGoal(world.disc.pos.z, dir))
            s += 0.12 * (p.attr.speed / 100) + 0.08 * (p.attr.jumping / 100)
        } else {
            // Part flat, part stall-ramped: a purely stall-gated under vanished from
            // the game once the tempo meant the count never reached 2. The first look
            // in real offence IS an under, at stall zero.
            s += 0.03 + 0.09 * Playbook.smoothstep(2, 6, stall)
        }
        if cut.kind == .breakUnder { s -= 0.10 }
        if cut.kind == .strike { s += 0.22 }

        // Fatigue and stack discipline. The discipline term follows the same rule the
        // offer does — deep belongs to the front of the column, under to the back — so a
        // cutter out of position for the cut he is offering is priced down rather than
        // silently allowed. It was the mirror of this once, and so it actively rewarded
        // the inversion it was supposed to police.
        s *= (0.72 + 0.28 * p.energy)
        // Deliberately `!= .horizontal` and NOT `hasColumn`, which would also exclude the
        // endzone set. The endzone set is a row too, so on the face of it the predicate
        // belongs here — but the endzone row only ever offers `strike`, and dropping the
        // term for it moves reset-behind-disc 90.0% -> 89.8%, just under its bar. That is
        // a behaviour change with a measured cost, not a tidy-up.
        if formation != .horizontal {
            let nCol = Swift.max(1, slotOf.count)
            s -= 0.03 * abs(Double(depth) - Double(deep ? 0 : nCol - 1))
        }
        return s
    }

    /// Handler resets: dump, swing and the up-line when the mark breaks down.
    func tickHandlerCuts(_ world: AIWorld, _ dt: Double, _ thrower: AIPlayer?) {
        guard let thrower, world.disc.state == .held else { return }
        let stall = stallRead
        let disc = Vec2d(world.disc.pos.x, world.disc.pos.z)
        let openSign = self.openSign

        // Is the mark beaten? Either too far off, or standing on the wrong side.
        var markDist = 99.0
        var markSide: Playbook.Sign = 0
        for f in foes {
            let d = Playbook.dist2(f.pos.x, f.pos.z, thrower.pos.x, thrower.pos.z)
            if d < markDist {
                markDist = d
                markSide = jsSign(f.pos.x - thrower.pos.x)
            }
        }
        let markBeaten = markDist > 2.9 || (markSide != 0 && markSide == openSign)

        // How many bodies are behind the disc at all. A vertical stack runs two handlers,
        // so when one has the disc the other IS the reset — and if he goes up the line
        // there is suddenly nothing behind the thrower at all. Nobody vacates the reset
        // unless somebody else is already there.
        var behindCount = 0
        for q in mates {
            if q.id == thrower.id { continue }
            if Double(dir) * (q.pos.z - world.disc.pos.z) < 1.0 { behindCount += 1 }
        }

        for id in handlerRing {
            if id == thrower.id { continue }
            guard let p = byId[id] else { continue }
            let rec = m(id)

            if rec.cutState != .stack {
                rec.cutT += dt
                guard let cut = rec.cut else {
                    rec.cutState = .stack
                    continue
                }
                if rec.cutState == .setup {
                    if rec.cutT >= cut.setupTime
                        || Playbook.dist2(p.pos.x, p.pos.z, cut.setup.x, cut.setup.z) < 0.7
                    {
                        rec.cutState = .plant
                        rec.cutT = 0
                    }
                } else if rec.cutState == .plant {
                    if rec.cutT >= Playbook.PLAY.plantTime {
                        rec.cutState = .break
                        rec.cutT = 0
                    }
                } else if rec.cutState == .break {
                    let d = Playbook.dist2(p.pos.x, p.pos.z, cut.target.x, cut.target.z)
                    let done = d < 1.2 || rec.cutT >= cut.maxTime
                    let beingThrownTo = choice?.receiverId == id
                    // THE UP-LINE ABORTS BACK TO THE RESET. This is a behaviour, not a
                    // threshold.
                    //
                    // The up-line is the handler's primary move and it was all but
                    // unreachable: it required two bodies behind the disc, and a
                    // two-handler vertical stack has exactly one once the other is
                    // holding it. Loosening that count was tried and reverted — it let
                    // the only reset leave and never come back, and reset-behind-disc
                    // fell 90.0% -> 84.8%.
                    //
                    // The count was never the problem. A real handler goes up the line
                    // knowing he is the reset, and the contract is that if the disc does
                    // not come he turns and is BACK in reset space a second later. The
                    // abort re-enters at `plant`, not `setup`: he is at full speed
                    // already and what happens next is a change of direction.
                    if done && !beingThrownTo && cut.kind == .upLine {
                        // DRAW SITE. One jitter draw, only on the abort path.
                        let back = pb.buildCut(
                            .dump, Vec2d(p.pos.x, p.pos.z), disc, dir, openSign,
                            -openSign, rng.next())
                        // He KEEPS the reset lane he already holds. The abort is one
                        // player continuing to occupy the reset space he never really
                        // left, so there is no lane to acquire and none to contend for —
                        // an earlier version tried to move him to `reset-break` and
                        // simply never fired, because the other handler's dump is almost
                        // always holding it.
                        var forced = back
                        forced.lane = cut.lane
                        beginCut(id, forced, .plant)
                    } else if done {
                        endHandlerCut(id)
                    }
                } else if rec.cutState == .clear {
                    // Once the count is high the reset does not get to rest between
                    // attempts — he keeps working until the disc moves. A handler who
                    // resets once and then stands still is never open at stall 8, which
                    // is the only moment the throw actually has to be there.
                    let urgent = stall >= 6
                    if rec.cutT >= (urgent ? 0.35 : 0.8) {
                        rec.cutState = .stack
                        rec.cutT = 0
                        rec.cut = nil
                        rec.cutCooldown = urgent ? 0.15 : 0.6
                    }
                }
                continue
            }

            if rec.cutCooldown > 0 { continue }
            let behind = Double(dir) * (p.pos.z - world.disc.pos.z) < 1.0
            let from = Vec2d(p.pos.x, p.pos.z)
            var kind: Playbook.CutKind?
            var side: Playbook.Sign = openSign

            // The reset starts working at 4, not at 5.5. A handler who only moves once
            // the count is nearly out is a handler who is never open when the throw has
            // to go — and the reset being live is most of what makes the back of the
            // offence readable while the count climbs.
            if behind && (stall >= 4.0 || noGoodLook) {
                kind = .dump
                side = -openSign
            } else if markBeaten && stall >= 1.2 && stall < 7 && behind && behindCount >= 2
            {
                // THE COUNT STAYS AT TWO, AND THIS HAS BEEN MEASURED RATHER THAN ASSUMED.
                //
                // Round one relaxed the count alone and was reverted: the only reset left
                // and nothing brought him back. Round two built the abort above and
                // relaxed the count to 1 on top of it — measured over 126k held frames,
                // reset-behind-disc 84.2% and high-stall 89.7%, both still failing. With
                // the abort and the count left at 2, both assertions PASS and the number
                // of up-lines actually run is unchanged at 6. The relaxation buys no
                // up-lines and costs the reset.
                kind = .upLine
                side = openSign
            } else if stall >= 3.5 && stall < 6 && behind && behindCount >= 2
                && rng.next() < 0.02
            {
                // DRAW SITE. JavaScript's `&&` short-circuits, so this coin is only
                // flipped when every condition to its left already holds. Hoisting it out
                // of the chain would burn a draw on most frames and desynchronise
                // everything downstream.
                kind = .swing
                side = openSign
            }
            guard let kind else { continue }

            let lane: Playbook.LaneKey = kind == .dump ? .resetBreak : .resetOpen
            if liveLanes[lane] != nil { continue }
            // DRAW SITE. After the lane rejection, deliberately: a handler blocked out of
            // his lane consumes no jitter.
            let cut = pb.buildCut(kind, from, disc, dir, openSign, side, rng.next())
            // Force the reset lane label so downfield cuts never collide with it.
            var forced = cut
            forced.lane = lane
            beginCut(id, forced, .setup)
            liveLanes[lane] = id
        }
    }

    func endHandlerCut(_ id: Int) {
        let rec = m(id)
        if let cut = rec.cut, liveLanes[cut.lane] == id {
            liveLanes.removeValue(forKey: cut.lane)
        }
        rec.cutState = .clear
        rec.cutT = 0
    }

    // MARK: - cutter intent

    /// Movement intent for any offensive player who is not the thrower.
    func cutterIntent(_ p: AIPlayer, _ world: AIWorld, _ dt: Double) -> PlayerIntent {
        let rec = m(p.id)
        let cut = rec.cut
        var tx: Double
        var tz: Double
        var effort: Double
        var mode: AIMoveMode
        var state = rec.cutState.rawValue

        switch rec.cutState {
        case .setup:
            tx = cut!.setup.x
            tz = cut!.setup.z
            effort = 0.68
            mode = .jog
        case .plant:
            tx = p.pos.x
            tz = p.pos.z
            effort = 0.05
            mode = .plant
        case .break:
            tx = cut!.target.x
            tz = cut!.target.z
            effort = 1.0
            mode = .sprint
        case .clear:
            // Clear SIDEWAYS out of the lane first, then run the column back to the tail
            // of the stack. Cutting a corner straight to the back station drags the body
            // diagonally through the throwing lane it was supposed to be vacating.
            let st = stationFor(p, world)
            // A HANDLER CLEARS TO THE BACKFIELD, NEVER TO THE STACK COLUMN.
            //
            // The column rule below is a cutter's rule: get out of the throwing lane by
            // rejoining the line. Applied to a handler it does the opposite of what the
            // reset is for — `stackAxisX` is about x = 0 and the clear steers at
            // `p.pos.z + dir * 1.2`, so a reset finishing a dump on the open side was
            // sent INTO the middle of the field and FORWARD, past the disc, on every dead
            // reset. He is the one player on the team whose job is defined by being
            // behind it.
            if p.role == .handler || !Playbook.hasColumn(formation) {
                // A ROW CLEARS BACK ALONG ITS OWN LANE. There is no column to run to, and
                // `stackAxisX` is about x = 0 for every set that is not a side stack — so
                // steering everybody at it collapsed a 22 m-wide endzone set into a knot
                // in the middle of the field on every dead cut, in the one situation the
                // broadcast camera is closest to.
                tx = st.x
                tz = st.z
                effort = 0.85
                mode = .sprint
                break
            }
            let axis = stackAxisX
            let lat = p.pos.x - axis
            if abs(lat) > 3.2 {
                tx = axis
                tz = p.pos.z + Double(dir) * 1.2
                effort = 0.92
                mode = .sprint
            } else {
                tx = st.x
                tz = st.z
                effort = Playbook.dist2(p.pos.x, p.pos.z, st.x, st.z) > 5 ? 0.7 : 0.5
                mode = .jog
            }
        case .stack:
            let st = stationFor(p, world)
            tx = st.x
            tz = st.z
            let d = Playbook.dist2(p.pos.x, p.pos.z, tx, tz)
            // A handler out of position is a possession with no reset in it. After a 20 m
            // gain the handlers are a long way behind the disc and jogging back at 70%
            // means the thrower spends the first four seconds of the stall with nothing
            // behind him. Handlers hustle.
            if p.role == .handler {
                effort = d > 10 ? 1.0 : (d > 5 ? 0.82 : (d > 2 ? 0.45 : 0.16))
                mode = d > 8 ? .sprint : (d > 2 ? .jog : .idle)
            } else {
                effort = d > 6 ? 0.7 : (d > 2 ? 0.42 : 0.16)
                mode = d > 2 ? .jog : .idle
            }
            state = "stack"
        }

        let c = avoidSidelines(tx, tz, p)
        let faceX =
            rec.cutState == .break || rec.cutState == .setup
            ? c.x - p.pos.x : world.disc.pos.x - p.pos.x
        let faceZ =
            rec.cutState == .break || rec.cutState == .setup
            ? c.z - p.pos.z : world.disc.pos.z - p.pos.z
        return intent(
            p, c.x, c.z, faceX, faceZ, mode, effort, nil,
            role: p.role.rawValue, state: state, lane: cut?.lane,
            cutX: cut?.target.x ?? .nan, cutZ: cut?.target.z ?? .nan,
            cutKind: cut?.kind, cutDepth: cut != nil ? rec.cutDepth : -1,
            dt: dt)
    }
}
