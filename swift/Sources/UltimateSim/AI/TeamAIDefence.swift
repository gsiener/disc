import Foundation

/// The defensive half of `TeamAI` — `src/sim/AI.ts` lines 2396-2979.
///
/// The mark, the matchups, the poach/bracket logic, the zone shell and the in-flight
/// read, plus `predictCatchPoint`, which both halves of the AI share.
///
/// **Two maps in here are iterated and their order is behaviour.** `matchup` is walked
/// to find the defender assigned to the thrower and keeps the LAST match; `zoneRole` is
/// walked to find the cup-mark and keeps the last match. JavaScript `Map` iterates in
/// insertion order and Swift `Dictionary` does not iterate in any order you may rely on,
/// so both are `OrderedIntMap`. This is the single most likely place for a port to
/// produce a different but entirely plausible defence.
extension TeamAI {

    func defence(_ world: AIWorld, _ dt: Double) -> [PlayerIntent] {
        if world.disc.state == .flight { return defenceInFlight(world, dt) }
        if scheme == .zone { return zoneDefence(world, dt) }
        return personDefence(world, dt)
    }

    func pickScheme(_ world: AIWorld) {
        let windSpeed = Foundation.hypot(world.wind.x, world.wind.z)
        let diff = world.score[team] - world.score[1 - team]
        let played = world.score[0] + world.score[1]
        scheme =
            Playbook.shouldPlayZone(windSpeed, diff, played, cfg.zoneBias) ? .zone : .person
        // Under a strong crosswind, force to the upwind side — throws hang there.
        let odir: Dir = -dir
        if windSpeed > 5 {
            let upwindSign: Playbook.Sign = world.wind.x >= 0 ? -1 : 1
            force = Playbook.openSideSign(.forehand, odir) == upwindSign ? .forehand : .backhand
        } else {
            force = cfg.force
        }
    }

    func assignMatchups(_ world: AIWorld) {
        matchup.removeAll()
        zoneRole.removeAll()
        let offs = foes
        let defs = mates
        if scheme == .zone {
            let disc = Vec2d(world.disc.pos.x, world.disc.pos.z)
            let odir: Dir = -dir
            let stations = pb.zoneStations(
                disc, odir, Playbook.openSideSign(force, odir), nil)
            var free = stations
            // Best athlete deep, best defender in the cup. Total order via the id
            // tiebreak, so sort stability cannot matter.
            var order = defs.sorted { a, b in
                let sa = a.attr.speed + a.attr.jumping
                let sb = b.attr.speed + b.attr.jumping
                if sa != sb { return sb < sa }
                return a.id < b.id
            }
            let deepIdx = free.firstIndex { $0.role == .deep }
            if let deepIdx, !order.isEmpty {
                zoneRole.set(order[0].id, .deep)
                free.remove(at: deepIdx)
                order.removeFirst()
            }
            for d in order {
                if free.isEmpty { break }
                var bi = 0
                var bd = 1e9
                for i in 0..<free.count {
                    let dd = Playbook.dist2(d.pos.x, d.pos.z, free[i].x, free[i].z)
                    if dd < bd {
                        bd = dd
                        bi = i
                    }
                }
                zoneRole.set(d.id, free[bi].role)
                free.remove(at: bi)
            }
            return
        }
        // Person: greedy min-cost with an athletic-similarity term so the fast defender
        // ends up on the fast cutter.
        var pool = offs
        let dl = defs.sorted { a, b in
            if a.attr.defAwareness != b.attr.defAwareness {
                return b.attr.defAwareness < a.attr.defAwareness
            }
            return a.id < b.id
        }
        for d in dl {
            if pool.isEmpty { break }
            var bi = 0
            var bc = 1e9
            for i in 0..<pool.count {
                let o = pool[i]
                let cost =
                    Playbook.dist2(d.pos.x, d.pos.z, o.pos.x, o.pos.z)
                    + abs(d.attr.speed - o.attr.speed) * 0.12
                if cost < bc {
                    bc = cost
                    bi = i
                }
            }
            matchup.set(d.id, pool[bi].id)
            pool.remove(at: bi)
        }
    }

    // MARK: - person

    func personDefence(_ world: AIWorld, _ dt: Double) -> [PlayerIntent] {
        var out: [PlayerIntent] = []
        let odir: Dir = -dir
        let disc = world.disc
        let thrower: AIPlayer? = disc.carrier.flatMap { byId[$0] }
        // A positional force is re-read from the disc every step and latched, so "force
        // middle" actually swaps sides when the disc crosses the field.
        let forceX = thrower?.pos.x ?? disc.pos.x
        let openSign =
            calledForce ?? Playbook.openSideFor(force, odir, forceX, forceSide)
        let brk: Playbook.Sign = -openSign
        forceSide = openSign

        // ---- the mark: whoever is matched on the thrower, unless badly beaten.
        markerId = -1
        if let thrower {
            // ORDERED ITERATION. Last match wins, as JavaScript's `Map` walk does.
            var matched = -1
            for e in matchup.entries where e.value == thrower.id { matched = e.key }
            var markerP: AIPlayer? = matched >= 0 ? byId[matched] : nil
            if let mp = markerP {
                let md = Playbook.dist2(mp.pos.x, mp.pos.z, thrower.pos.x, thrower.pos.z)
                if md > 6 {
                    // Someone closer takes the mark; swap assignments so nobody is free.
                    var cand: AIPlayer?
                    var cd = md
                    for d in mates {
                        if d.id == mp.id { continue }
                        let dd = Playbook.dist2(
                            d.pos.x, d.pos.z, thrower.pos.x, thrower.pos.z)
                        if dd < cd - 1.5 {
                            cd = dd
                            cand = d
                        }
                    }
                    if let cand {
                        let candOld = matchup[cand.id]
                        matchup.set(cand.id, thrower.id)
                        if let candOld { matchup.set(mp.id, candOld) }
                        markerP = cand
                    }
                }
            }
            markerId = markerP?.id ?? -1
        }

        // ---- stall clock.
        if thrower != nil && markerId >= 0 {
            if markerId != stallMarker {
                stallMarker = markerId
                stallClock = 0
            }
            let mk = byId[markerId]!
            let d = Playbook.dist2(
                mk.pos.x, mk.pos.z, thrower!.pos.x, thrower!.pos.z)
            stallClock = tickStall(stallClock, d, dt)
        } else {
            stallClock = 0
            stallMarker = -1
        }
        if thrower == nil { stallClock = 0 }

        // ---- identify the deep threat and the deepest defender for the bracket.
        var deepThreat: AIPlayer?
        var dbest = -1e9
        for o in foes {
            let df = Double(odir) * (o.pos.z - disc.pos.z)
            if df > dbest {
                dbest = df
                deepThreat = o
            }
        }
        deepHelpId = -1
        var deepestDef = -1e9
        for d in mates {
            if d.id == markerId { continue }
            let df = Double(odir) * (d.pos.z - disc.pos.z)
            if df > deepestDef {
                deepestDef = df
                deepHelpId = d.id
            }
        }

        trySwitches(world, odir)

        for p in mates {
            let mm = m(p.id)

            if p.id == markerId, let thrower {
                let mp = Playbook.markPoint(
                    Vec2d(thrower.pos.x, thrower.pos.z), odir, brk, Playbook.PLAY.markDistance)
                var tx = mp.x
                var tz = mp.z
                // A marker on the wrong side of the thrower has to get to the break side,
                // and the straight line to the mark point goes through the thrower.
                // Steered at it directly he runs into disc space, the disc-space guard
                // shoves him back out radially — which preserves the side he is already on
                // — and he can sit there for the whole stall forcing the wrong way. That is
                // how a force ends up being a label on a config object rather than a thing
                // on the field.
                //
                // So the mark travels AROUND the thrower on the stand-off circle, which is
                // both legal and what a marker actually does.
                let bearNow = Foundation.atan2(
                    p.pos.z - thrower.pos.z, p.pos.x - thrower.pos.x)
                let bearWant = Foundation.atan2(
                    mp.z - thrower.pos.z, mp.x - thrower.pos.x)
                var dBear = bearWant - bearNow
                while dBear > Double.pi { dBear -= 2 * Double.pi }
                while dBear < -Double.pi { dBear += 2 * Double.pi }
                let radNow = Playbook.dist2(
                    p.pos.x, p.pos.z, thrower.pos.x, thrower.pos.z)
                // Only sweep from marking range. From further out the straight line is the
                // fast way in and does not cross disc space anyway.
                if abs(dBear) > 0.45 && radNow < 4.2 {
                    // Sweeping must also CLOSE: a marker orbiting at 4 m is not marking,
                    // because the stall clock only runs inside `markMax`. So the target
                    // sits ON the stand-off circle and only the BEARING is stepped — the
                    // marker spirals in rather than orbiting out.
                    let step = clamp(dBear, -0.65, 0.65)
                    let r = Playbook.PLAY.markDistance
                    tx = thrower.pos.x + Foundation.cos(bearNow + step) * r
                    tz = thrower.pos.z + Foundation.sin(bearNow + step) * r
                }
                // Respect disc space: back out rather than crowd the thrower. The check
                // anticipates a step of travel so momentum cannot carry the marker inside
                // the legal radius.
                let ahead = 0.28
                let ax = p.pos.x + p.vel.x * ahead - thrower.vel.x * ahead
                let az = p.pos.z + p.vel.z * ahead - thrower.vel.z * ahead
                let cur = Playbook.dist2(ax, az, thrower.pos.x, thrower.pos.z)
                if cur < Playbook.PLAY.discSpace + 1.10 {
                    // Back out ALONG THE CIRCLE toward the break side, not straight
                    // outward: a purely radial retreat preserves whichever side the marker
                    // is already on, so a marker who arrives open-side is pinned there for
                    // the whole stall.
                    let bail = bearNow + clamp(dBear, -0.55, 0.55)
                    tx = thrower.pos.x + Foundation.cos(bail) * (Playbook.PLAY.discSpace + 1.75)
                    tz = thrower.pos.z + Foundation.sin(bail) * (Playbook.PLAY.discSpace + 1.75)
                }
                // Closing effort tapers so the mark settles at range instead of barrelling
                // through the thrower; backing out of disc space is done at full effort and
                // is not asked to settle.
                let backing = cur < Playbook.PLAY.discSpace + 1.10
                let gap = Playbook.dist2(p.pos.x, p.pos.z, tx, tz)
                let c = avoidSidelines(tx, tz, p)
                out.append(
                    intent(
                        p, c.x, c.z,
                        thrower.pos.x - p.pos.x, thrower.pos.z - p.pos.z,
                        backing ? .backpedal : .mark,
                        backing ? 1 : clamp(gap * 0.55, 0.10, 1),
                        .stall(count: stallClock),
                        role: "marker", state: "mark", lane: nil, dt: dt))
                continue
            }

            let oid = matchup[p.id]
            let o: AIPlayer? = oid.flatMap { byId[$0] }
            guard let o else {
                let c = avoidSidelines(disc.pos.x, disc.pos.z + Double(odir) * 10, p)
                out.append(
                    intent(
                        p, c.x, c.z, 0, Double(odir), .jog, 0.5, nil,
                        role: "defender", state: "lost", lane: nil, dt: dt))
                continue
            }

            // Defensive reaction. A defender does not track his matchup's position
            // instantaneously — he reacts to it, and a sharp change of direction is
            // exactly what buys a cutter a step. Awareness sets the lag.
            let tau = 0.36 - 0.22 * (p.attr.defAwareness / 100)
            if mm.seenOf != o.id {
                mm.seenOf = o.id
                mm.seenX = o.pos.x
                mm.seenZ = o.pos.z
            }
            // Lateral position (which side you are on) is a stance a defender holds
            // consciously; depth is what he reacts to. So x tracks roughly twice as fast
            // as z.
            let kz = Swift.min(1, dt / Swift.max(0.04, tau))
            let kx = Swift.min(1, dt / Swift.max(0.04, tau * 0.5))
            mm.seenX += (o.pos.x - mm.seenX) * kx
            mm.seenZ += (o.pos.z - mm.seenZ) * kz

            // Base person position: shade the open side, play under or over.
            let lead = 0.22
            let px = mm.seenX + o.vel.x * lead
            let pz = mm.seenZ + o.vel.z * lead
            let downfield = Double(odir) * (o.pos.z - disc.pos.z)
            let goingDeep = Double(odir) * o.vel.z > 2.2
            let isDeepThreat = downfield > 14 || goingDeep
            let depth = isDeepThreat ? Playbook.PLAY.deepCushion : -Playbook.PLAY.underGap
            let skill = 0.65 + 0.35 * (p.attr.defAwareness / 100)
            var tx = px + Double(openSign) * Playbook.PLAY.shadeOpen * skill
            var tz = pz + Double(odir) * depth
            // The velocity lead must never flip the shade: a defender playing a force is
            // always on the open side of his matchup, whatever the cutter is doing. This
            // is the single most visible rule in the sport.
            let minShade = 1.05 + 0.75 * skill
            if (tx - o.pos.x) * Double(openSign) < minShade {
                tx = o.pos.x + Double(openSign) * minShade
            }

            // ---- poach / help / bracket
            let threat = threatOf(o, disc, odir)
            let wantPoach = threat < 0.30
            mm.poachHold = wantPoach ? mm.poachHold + dt : 0
            let engage = mm.poachHold > 0.35 && threat < 0.30
            let disengage = threat > 0.45
            mm.poach = clamp(
                mm.poach + (engage ? dt * 2.2 : (disengage ? -dt * 4.0 : -dt * 0.6)), 0, 1)

            if mm.poach > 0.05 {
                let isBracket = p.id == deepHelpId && deepThreat != nil
                let leash = isBracket ? 7.5 : 4.5
                var hx: Double
                var hz: Double
                if isBracket, let deepThreat {
                    hx = deepThreat.pos.x + Double(openSign) * 1.0
                    hz = deepThreat.pos.z + Double(odir) * 4.0
                } else {
                    // Help on the under: sit in the primary throwing lane.
                    hx = disc.pos.x + Double(openSign) * 5.0
                    hz = disc.pos.z + Double(odir) * 7.0
                }
                var nx = Playbook.lerp(tx, hx, mm.poach)
                var nz = Playbook.lerp(tz, hz, mm.poach)
                let ld = Playbook.dist2(nx, nz, o.pos.x, o.pos.z)
                if ld > leash {
                    let s = leash / ld
                    nx = o.pos.x + (nx - o.pos.x) * s
                    nz = o.pos.z + (nz - o.pos.z) * s
                }
                tx = nx
                tz = nz
            }

            // NOBODY BUT THE MARKER STANDS ON THE THROWER — USAU 16.G. A constraint
            // enforcing that here was built and REMOVED, and the measurement is worth
            // keeping because the conclusion is not the obvious one. With the rules layer
            // requiring a double team to STAND for 0.6 s before it is deemed called,
            // sustained violations run at 4-11 a match with the constraint and 4-6
            // without it — the transients it removed were never being called anyway. What
            // it did cost was four `test-ai` assertions, because moving every off-disc
            // defender a third of a metre re-points what the offence reads off them. So
            // the rule lives in `Rules.swift` where it is enforced, and the defence is
            // left alone.
            let gap = Playbook.dist2(p.pos.x, p.pos.z, tx, tz)
            let effort = clamp(0.35 + gap * 0.45, 0.35, 1)
            let mode: AIMoveMode = gap > 2.5 ? .sprint : (gap > 0.8 ? .shuffle : .idle)
            let c = avoidSidelines(tx, tz, p)
            out.append(
                intent(
                    p, c.x, c.z, o.pos.x - p.pos.x, o.pos.z - p.pos.z, mode, effort, nil,
                    role: "defender", state: mm.poach > 0.4 ? "poach" : "person", lane: nil,
                    dt: dt))
        }
        return out
    }

    /// 0…1 — how dangerous this offensive player is right now.
    func threatOf(_ o: AIPlayer, _ disc: AIDiscState, _ odir: Dir) -> Double {
        let d = Playbook.dist2(o.pos.x, o.pos.z, disc.pos.x, disc.pos.z)
        let sp = Foundation.hypot(o.vel.x, o.vel.z)
        let toward =
            d > 0.1
            ? ((disc.pos.x - o.pos.x) * o.vel.x + (disc.pos.z - o.pos.z) * o.vel.z)
                / (d * Swift.max(sp, 1e-3))
            : 0
        let downfield = Double(odir) * (o.pos.z - disc.pos.z)
        return clamp(
            0.42 * Playbook.smoothstep(0.8, 5.0, sp)
                + 0.30 * Playbook.smoothstep(42, 9, d)
                + 0.18 * clamp(toward, 0, 1)
                + 0.16 * Playbook.smoothstep(30, 6, abs(downfield)),
            0, 1)
    }

    /// Pairwise swap when two defenders have crossed. Iterates `mates` order, which is
    /// `world.players` order — the first improving pair found wins, so the order is
    /// behaviour and an unordered container would not do.
    func trySwitches(_ world: AIWorld, _ odir: Dir) {
        let ids = mates.map(\.id)
        for i in 0..<ids.count {
            for j in (i + 1)..<ids.count {
                guard let a = byId[ids[i]], let b = byId[ids[j]] else { continue }
                if a.id == markerId || b.id == markerId { continue }
                let ma = m(a.id)
                let mb = m(b.id)
                if ma.switchCd > 0 || mb.switchCd > 0 { continue }
                guard let oa = matchup[a.id], let ob = matchup[b.id] else { continue }
                guard let pa = byId[oa], let pbb = byId[ob] else { continue }
                let cur =
                    Playbook.dist2(a.pos.x, a.pos.z, pa.pos.x, pa.pos.z)
                    + Playbook.dist2(b.pos.x, b.pos.z, pbb.pos.x, pbb.pos.z)
                let swapped =
                    Playbook.dist2(a.pos.x, a.pos.z, pbb.pos.x, pbb.pos.z)
                    + Playbook.dist2(b.pos.x, b.pos.z, pa.pos.x, pa.pos.z)
                if swapped < cur - 3.0 {
                    // Overwriting an existing key does not move it in a JS `Map`, and
                    // `OrderedIntMap.set` matches that. Reordering here would change which
                    // defender `personDefence` picks up as the mark next frame.
                    matchup.set(a.id, ob)
                    matchup.set(b.id, oa)
                    ma.switchCd = 2.5
                    mb.switchCd = 2.5
                }
            }
        }
    }

    // MARK: - zone

    func zoneDefence(_ world: AIWorld, _ dt: Double) -> [PlayerIntent] {
        var out: [PlayerIntent] = []
        let odir: Dir = -dir
        let disc = world.disc
        let thrower: AIPlayer? = disc.carrier.flatMap { byId[$0] }
        let openSign =
            calledForce
            ?? Playbook.openSideFor(
                force, odir, thrower?.pos.x ?? disc.pos.x, forceSide)
        forceSide = openSign

        var deepThreat: Vec2d?
        var dbest = -1e9
        for o in foes {
            let df = Double(odir) * (o.pos.z - disc.pos.z)
            if df > dbest {
                dbest = df
                deepThreat = Vec2d(o.pos.x, o.pos.z)
            }
        }
        let stations = pb.zoneStations(
            Vec2d(disc.pos.x, disc.pos.z), odir, openSign, deepThreat)
        var byRole: [Playbook.ZoneRole: Vec2d] = [:]
        for s in stations { byRole[s.role] = Vec2d(s.x, s.z) }

        // Cup mark applies the stall. ORDERED ITERATION, last match wins.
        var markerLocal = -1
        for e in zoneRole.entries where e.value == .cupMark { markerLocal = e.key }
        markerId = markerLocal
        if thrower != nil && markerLocal >= 0 {
            if markerLocal != stallMarker {
                stallMarker = markerLocal
                stallClock = 0
            }
            let mk = byId[markerLocal]
            let dd =
                mk != nil
                ? Playbook.dist2(
                    mk!.pos.x, mk!.pos.z, thrower!.pos.x, thrower!.pos.z) : 99
            stallClock = tickStall(stallClock, dd, dt)
        } else {
            stallClock = 0
            stallMarker = -1
        }

        for p in mates {
            let role = zoneRole[p.id] ?? .shortDeep
            let st = byRole[role] ?? Vec2d(disc.pos.x, disc.pos.z + Double(odir) * 12)
            var tx = st.x
            var tz = st.z

            var backing = false
            if role == .cupMark, let thrower {
                let ahead = 0.28
                let ax = p.pos.x + p.vel.x * ahead - thrower.vel.x * ahead
                let az = p.pos.z + p.vel.z * ahead - thrower.vel.z * ahead
                let cur = Playbook.dist2(ax, az, thrower.pos.x, thrower.pos.z)
                if cur < Playbook.PLAY.discSpace + 0.75 {
                    backing = true
                    let nowRaw = Playbook.dist2(
                        p.pos.x, p.pos.z, thrower.pos.x, thrower.pos.z)
                    // `|| 1` falls through on +0, -0 and NaN — a marker standing exactly on
                    // the thrower would otherwise divide by zero.
                    let now = (nowRaw == 0 || nowRaw.isNaN) ? 1 : nowRaw
                    tx = thrower.pos.x
                        + ((p.pos.x - thrower.pos.x) / now) * (Playbook.PLAY.discSpace + 1.75)
                    tz = thrower.pos.z
                        + ((p.pos.z - thrower.pos.z) / now) * (Playbook.PLAY.discSpace + 1.75)
                }
            }

            // Zone players still react to the nearest offensive body in their area.
            if role != .cupMark {
                var near: AIPlayer?
                var nd = 7.5
                for o in foes {
                    let d = Playbook.dist2(o.pos.x, o.pos.z, st.x, st.z)
                    if d < nd {
                        nd = d
                        near = o
                    }
                }
                if let near {
                    let pull = 0.45 * (0.6 + 0.4 * (p.attr.defAwareness / 100))
                    tx = Playbook.lerp(tx, near.pos.x + Double(openSign) * 0.8, pull)
                    tz = Playbook.lerp(tz, near.pos.z - Double(odir) * 0.8, pull)
                }
            }

            let gap = Playbook.dist2(p.pos.x, p.pos.z, tx, tz)
            let c = avoidSidelines(tx, tz, p)
            let action: PlayerAction? =
                p.id == markerLocal && thrower != nil ? .stall(count: stallClock) : nil
            out.append(
                intent(
                    p, c.x, c.z,
                    disc.pos.x - p.pos.x, disc.pos.z - p.pos.z,
                    backing
                        ? .backpedal
                        : (p.id == markerLocal ? .mark : (gap > 2.5 ? .sprint : .shuffle)),
                    backing ? 1 : clamp(0.35 + gap * 0.4, 0.3, 1), action,
                    role: "zone:\(role.rawValue)", state: "zone", lane: nil, dt: dt))
        }
        return out
    }

    // MARK: - defence in flight

    func defenceInFlight(_ world: AIWorld, _ dt: Double) -> [PlayerIntent] {
        var out: [PlayerIntent] = []
        let land = predictCatchPoint(world)
        let odir: Dir = -dir
        let brk = Playbook.breakSideSign(force, odir)
        // A disc dropping in the endzone they are defending is a goal, so it is worth the
        // ground; one at midfield is a possession, and is not.
        let stakes = discStakes(land.z, odir, field: pb)

        // Whoever gets there first is the man on the play. A second defender diving in
        // behind him blocks nothing and takes himself out of the point for two seconds —
        // that is a trailing defender, and trailing defenders stay up.
        var tOf: [Int: Double] = [:]
        var onPlay = -1
        var bestT = 1e9
        for p in mates {
            let t = timeToReach(p, land.x, land.z)
            tOf[p.id] = t
            if t < bestT {
                bestT = t
                onPlay = p.id
            }
        }

        for p in mates {
            let rec = m(p.id)
            if rec.flightCommit != flightEpoch {
                rec.flightCommit = flightEpoch
                // DRAW SITE. One read per flight: awareness decides whether he ever sees a
                // bid on this disc at all. Whether one is warranted is re-asked every step,
                // because the geometry that decides it is still moving.
                rec.bidCommit = rng.next() < 0.45 + 0.55 * (p.attr.defAwareness / 100)
            }
            let t = tOf[p.id] ?? timeToReach(p, land.x, land.z)
            let gap = (t - land.t) * effectiveMaxSpeed(p)
            let canPlay = gap < layoutExtend(p) + 0.5

            if canPlay {
                var mode: AIMoveMode = .sprint
                var action: PlayerAction?
                if gap <= 0.1 && land.y > 1.85 && land.y < reachHeight(p) + 0.4 {
                    mode = .jump
                    action = .jump(height: land.y)
                } else if rec.bidCommit && p.id == onPlay && land.y < 1.85
                    && wantsBid(p, land, stakes: stakes)
                {
                    mode = .layout
                    action = .bid(x: land.x, z: land.z, extend: layoutExtend(p))
                }
                let c = pb.clampToField(Vec2d(land.x, land.z), margin: 0.45)
                out.append(
                    intent(
                        p, c.x, c.z, land.x - p.pos.x, land.z - p.pos.z, mode, 1.0, action,
                        role: "defender", state: "read-disc", lane: nil, dt: dt, settle: true))
                continue
            }
            // No play on the disc. If it is landing near you, break down and set the mark
            // now rather than running through the catch — that is both the correct read
            // and how a defender avoids fouling into disc space.
            let toLand = Playbook.dist2(p.pos.x, p.pos.z, land.x, land.z)
            if toLand < 7 {
                let mp = Playbook.markPoint(
                    Vec2d(land.x, land.z), odir, brk, Playbook.PLAY.markDistance + 0.30)
                let c = avoidSidelines(mp.x, mp.z, p)
                out.append(
                    intent(
                        p, c.x, c.z, land.x - p.pos.x, land.z - p.pos.z, .shuffle, 1, nil,
                        role: "defender", state: "mark-up", lane: nil, dt: dt, settle: true))
                continue
            }
            let o: AIPlayer? = matchup[p.id].flatMap { byId[$0] }
            let tx = o?.pos.x ?? land.x
            let tz = o?.pos.z ?? land.z
            let c = avoidSidelines(tx, tz, p)
            out.append(
                intent(
                    p, c.x, c.z, land.x - p.pos.x, land.z - p.pos.z, .sprint, 0.85, nil,
                    role: "defender", state: "recover", lane: nil, dt: dt))
        }
        return out
    }

    // MARK: - the catch point

    /// Where and when the disc becomes catchable. Uses the disc peer if present.
    ///
    /// **The floor matters more than it looks.** Most throws in this game never rise
    /// above `CATCH_CEILING` at all — the release is at ~1.35 m and a flat forehand stays
    /// under it for its whole flight — so the descending-through-the-ceiling branch never
    /// fires and the whole rendezvous falls through to the floor. With the floor at 0.12 m
    /// that made the target THE POINT WHERE THE DISC HITS THE TURF, which the rules engine
    /// will not award a standing catch at. Measured: 80% of all layouts were bids for a
    /// disc whose predicted catch point was below 0.2 m. The offence was not diving
    /// because it was beaten; it was diving because it had been sent to meet the disc on
    /// the floor, and only a body already prone can catch it there.
    ///
    /// `last*` is a second, later point on the same flight — where the disc drops out of
    /// the standing band entirely. Running to the rendezvous is what a receiver DOES;
    /// beating the last chance to it is the only thing that makes a layout necessary.
    func predictCatchPoint(_ world: AIWorld) -> CatchPoint {
        locoRef = world.locomotion
        if let peer = world.discPeer, !discPeerFailed {
            // The peer is PROBED, not trusted: a sibling module may expose a
            // `predictPath` that returns something else entirely, and feeding the reads
            // below a malformed path yields NaN targets rather than an error. A peer that
            // fails the shape check is disabled for good and the glide integrator takes
            // over — it is accurate to well under a metre over a typical flight.
            let raw = peer.predictPath(world.disc, horizon: 6, step: 1.0 / 30)
            if validFlightSamples(raw) {
                let path = raw
                var met: FlightSample?
                var dead: FlightSample = path[path.count - 1]
                for i in 1..<path.count {
                    let s = path[i]
                    if met == nil
                        && ((s.y <= CATCH_CEILING && path[i - 1].y > CATCH_CEILING)
                            || s.y <= CATCH_FLOOR)
                    {
                        met = s
                    }
                    if s.y <= CATCH_DEAD {
                        dead = path[i - 1]
                        break
                    }
                }
                let mm = met ?? dead
                return CatchPoint(
                    x: mm.x, y: mm.y, z: mm.z, t: mm.t,
                    lastX: dead.x, lastZ: dead.z, lastT: Swift.max(dead.t, mm.t))
            }
            discPeerFailed = true
        }
        // Fallback glide integrator: gravity partly offset by lift, light drag.
        var x = world.disc.pos.x
        var y = world.disc.pos.y
        var z = world.disc.pos.z
        var vx = world.disc.vel.x
        var vy = world.disc.vel.y
        var vz = world.disc.vel.z
        let h = 1.0 / 60
        var met: (x: Double, y: Double, z: Double, t: Double)?
        var t = 0.0
        while t < 6 {
            vy -= 3.1 * h
            let drag = 1 - 0.11 * h
            vx *= drag
            vz *= drag
            x += vx * h
            y += vy * h
            z += vz * h
            if met == nil && y <= CATCH_CEILING && vy < 0 {
                met = (x: x, y: Swift.max(y, CATCH_FLOOR), z: z, t: t + h)
            }
            if y <= CATCH_DEAD {
                let mm = met ?? (x: x, y: Swift.max(y, CATCH_FLOOR), z: z, t: t + h)
                return CatchPoint(
                    x: mm.x, y: mm.y, z: mm.z, t: mm.t,
                    lastX: x, lastZ: z, lastT: Swift.max(t + h, mm.t))
            }
            t += h
        }
        let mm = met ?? (x: x, y: Swift.max(y, CATCH_FLOOR), z: z, t: 6)
        return CatchPoint(
            x: mm.x, y: mm.y, z: mm.z, t: mm.t,
            lastX: x, lastZ: z, lastT: Swift.max(6, mm.t))
    }
}

/// The shape check the reference applies to a disc peer's first answer.
func validFlightSamples(_ v: [FlightSample]) -> Bool {
    if v.count < 2 { return false }
    let a = v[0]
    return a.t.isFinite && a.x.isFinite && a.y.isFinite && a.z.isFinite
}
