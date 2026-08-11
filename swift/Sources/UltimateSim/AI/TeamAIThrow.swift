import Foundation

/// The thrower's decision — `src/sim/AI.ts` lines 1976-2394.
///
/// Everything is priced in one currency: **the probability this possession ends in a
/// goal**. A 40 m score-throw and a 5 m dump are therefore compared in the same units,
/// and a turnover is charged exactly what it costs, the disc. That is what
/// `possessionValue` is for and it is why there is no separate "risk score".
///
/// Two RNG sites live here and both are per-frame-order sensitive:
///   - `decide` draws one `gauss()` **per option**, in `evaluateOptions` order, whether
///     or not that option wins. Skipping the losers' draws would shift the stream.
///   - `release` draws two `gauss()`, x then z.

/// **What makes a throw a DEEP SHOT**, measured on the regulation pitch. Issues #17, #28.
///
/// The downfield gain and the throw length that together send `evaluateOptions` into the
/// separate deep valuation: the jump-ball completion model, the out-of-bounds tax on the
/// aim point, the halved turnover charge and the credit for pinning the opponent. Both
/// scale by `Playbook.depthScale` at the site, which is exactly 1.0 at sevens.
///
/// ## "Deep" is five tests, and they now agree about the pitch
///
/// Issue #17 counts five places this codebase says what deep means. They cannot be one
/// number, because they do not measure one quantity and because three of them are what
/// `src/sim/*.ts` says — merging them would move the sevens goldens, which is the one
/// thing ADR-0004's scaling is designed never to do. What they can share, and now do, is
/// the answer to "which pitch is this":
///
/// | site | what it measures | scales by |
/// |---|---|---|
/// | `Playbook.laneOf` | `16` m — the under/deep LANE boundary from the disc | `depthScale` |
/// | `Playbook.buildCut` | `24…38` m — how far a deep CUT reaches | `depthScale` |
/// | `TeamAIOffence.scoreCut` | `smoothstep(30, 12, yardsToGoal)` — do not huck from close in | `depthScale` |
/// | `DEEP_SHOT_GAIN` / `DEEP_SHOT_REACH` | is this THROW the long one | `depthScale` |
/// | `ThrowSolver.loftRange` | `25` m — past which a disc must be lofted | **nothing** |
///
/// The fifth is the interesting one and it is deliberately absent from the list above.
/// `loftRange` is a property of the air, not of the field — ADR-0004 names it as the
/// worked example of a genuinely absolute distance — so a shorter pitch does not make a
/// disc hang sooner. It shares the number `25` with `DEEP_SHOT_REACH` at regulation by
/// coincidence of tuning, and they part company everywhere else. Scaling it would be the
/// mirror of the bug this constant fixes.
///
/// `TeamAIDefence.DefenceShape.deepThreatDownfield` (`14`) is a sixth reading of the same
/// word, on the other side of the disc; it scales too, for the same reason.
let DEEP_SHOT_GAIN = 22.0
let DEEP_SHOT_REACH = 25.0

extension TeamAI {
    /// How much of the flight time a receiver is led by.
    ///
    /// A receiver does not hold his velocity for the whole flight — he plants, he
    /// decelerates into the disc — so the lead is a FRACTION of the arrival time, and
    /// always has been. What changed is the clock: these were fitted against a
    /// `throwFlightTime` that ran 25-50% short, so what was actually applied was ~0.7 of
    /// the true flight on a run and ~1.2 on a cut. Refitted against the true clock they
    /// come to 0.42 and 0.60 — nearly the same lead in metres, but now `separationAt` and
    /// the deep-shot valuation get an honest horizon without the lead moving underneath
    /// them. Swept over eight seeds: 0.36/0.60 completes 75.4%, 0.42/0.60 78.5%,
    /// 0.42/0.55 79.3%, 0.48/0.60 77.0%, the old 0.5/0.85 on the true clock 71.2%.
    static let leadCut = 0.60
    static let leadRun = 0.42


    // MARK: - decide

    func decide(_ world: AIWorld, _ thrower: AIPlayer) {
        var opts = evaluateOptions(world, thrower)
        noGoodLook = opts.isEmpty
        if opts.isEmpty {
            choice = nil
            return
        }

        let stall = stallRead
        // Decision noise: a poor decision-maker misvalues options.
        let noise = (1 - effectiveDecision(thrower) / 100) * 0.055
        var bestIndex: Int?
        // ALIAS SITE. The reference writes `o.ev = ev` into the option that has just
        // become the best and keeps a reference to it, so later comparisons run against
        // the NOISY best rather than its clean value. Ported by index so the write lands
        // in the array. Options that never win keep their clean `ev` and are discarded.
        for i in opts.indices {
            let ev = opts[i].ev + rng.gauss() * noise
            if bestIndex == nil || ev > opts[bestIndex!].ev {
                opts[i].ev = ev
                bestIndex = i
            }
        }
        guard let bi = bestIndex else {
            choice = nil
            return
        }
        let best = opts[bi]

        // The bar for pulling the trigger. High (selective) under a low stall, collapsing
        // as the count climbs; at 8.5 the best available goes up.
        //
        // This was once raised to -0.040 on the argument that "it is not a confidence
        // problem, it is a patience one." That over-corrected into a different failure.
        // Measured over a match at -0.040: MEAN RELEASE AT STALL 7.56, and the modal
        // throw — 35 of 73 — gained 0.35 m. Swept across six seeds, THREE OF THEM SCORED
        // NOTHING IN FIVE MINUTES despite thirty throws each: the disc moved, but only
        // sideways.
        //
        // The arithmetic says why. A routine 10 m open-side under from midfield scores
        // ev = -0.123 against a bar of -0.042 at stall 0, so the break-even completion
        // for a plain 10 m gain sat near 91.5% — roughly elite-league average. A thrower
        // who only takes better-than-average throws waits, and the count runs to 8.
        //
        // Lower and flatter: the 85%/10 m under now clears at stall 0, a 75%/8 m under
        // still waits to about stall 6.3, and a 55%/20 m huck still never clears before
        // 8.5.
        let hold =
            stall >= 8.5
            ? -1e9
            : (-0.155 - 0.26 * Foundation.pow(clamp(stall, 0, 10) / 10, 2)) * cfg.aggression
        noGoodLook = best.ev < hold - 0.03
        choice = best.ev > hold ? best : nil
        if choice != nil && windup == 0 { windup = 1e-6 }
        if choice == nil { windup = 0 }
    }

    func evaluateOptions(_ world: AIWorld, _ thrower: AIPlayer) -> [ThrowOption] {
        let disc = world.disc
        let wind = world.wind
        let openSign = self.openSign
        let brk: Playbook.Sign = -openSign
        var opts: [ThrowOption] = []

        // Value of simply keeping the disc where it is, and how much a turnover is worth
        // avoiding. Risk aversion rises when backed up and when protecting a lead, and
        // falls for an aggressive team or one that is chasing.
        // Possession value on THIS pitch. `pv` is `possessionValue` with the field's own
        // goal-to-goal length and endzone depth rather than the regulation 64 and 18 —
        // see the doc on `possessionValue`. On the regulation field it is the identical
        // function, defaults and all.
        let central = pb.field.centralLength
        let endzoneD = pb.field.endzoneDepth
        func pv(_ yards: Double) -> Double {
            possessionValue(yards, central: central, endzone: endzoneD)
        }
        let holdValue = pv(pb.yardsToGoal(disc.pos.z, dir))
        let behindBy = Double(world.score[1 - team] - world.score[team])
        let risk = clamp(
            (1 / cfg.aggression)
                * (1 - 0.16 * clamp(behindBy / 4, 0, 1))
                * (0.85 + 0.30 * (effectiveDecision(thrower) / 100)),
            0.45, 1.8)

        // The marker: taken out of the lane-blockage sampling and priced as a break
        // penalty instead, which is how a real thrower thinks about it.
        var marker: AIPlayer?
        var md = 3.6
        for f in foes {
            let d = Playbook.dist2(f.pos.x, f.pos.z, thrower.pos.x, thrower.pos.z)
            if d < md {
                md = d
                marker = f
            }
        }

        for r in mates {
            if r.id == thrower.id { continue }
            let rm = m(r.id)

            // Two passes to converge lead point <-> flight time. A receiver is led along
            // his committed cut and NEVER past the end of it — throwing to where a cutter
            // would be if he kept running is how you throw it away.
            let live = rm.cutState == .break || rm.cutState == .plant
            let cutTo: Vec2d? = live ? rm.cut?.target : nil
            var tf = 1.0
            var aim = Vec3d(r.pos.x, 1.4, r.pos.z)
            var d = 0.0
            for _ in 0..<2 {
                let lx: Double
                let lz: Double
                if let cutTo {
                    let dx = cutTo.x - r.pos.x
                    let dz = cutTo.z - r.pos.z
                    let dl = Foundation.hypot(dx, dz)
                    let travel = Swift.min(dl, Foundation.hypot(r.vel.x, r.vel.z) * tf * TeamAI.leadCut)
                    lx = r.pos.x + (dl > 1e-3 ? dx / dl : 0) * travel
                    lz = r.pos.z + (dl > 1e-3 ? dz / dl : 0) * travel
                } else {
                    lx = r.pos.x + r.vel.x * tf * TeamAI.leadRun
                    lz = r.pos.z + r.vel.z * tf * TeamAI.leadRun
                }
                let cl = pb.clampToField(Vec2d(lx, lz), margin: 1.4)
                aim = Vec3d(cl.x, 1.4, cl.z)
                d = Playbook.dist2(thrower.pos.x, thrower.pos.z, aim.x, aim.z)
                tf = throwFlightTime(thrower, .backhand, d)
            }
            if d < 2.0 { continue }

            let relX = aim.x - thrower.pos.x
            let releaseSign: Playbook.Sign = jsSignOr(relX, 1)
            let isBreak = releaseSign == brk
            let baseType: AIThrowType =
                Playbook.releaseSideType(thrower.handed, dir, Double(releaseSign)) == .forehand
                ? .forehand : .backhand

            var candidates: [AIThrowType] = [baseType]
            let behind = Double(dir) * (aim.z - thrower.pos.z) < -1.5
            if behind { candidates.append(.push) }

            for type in candidates {
                // `d || 1`: falls through on +0, -0 and NaN. `d >= 2` here, so it never
                // fires — kept because the guard is the reference's and removing it would
                // be a silent behaviour change if the guard above ever moved.
                let dd = (d == 0 || d.isNaN) ? 1 : d
                let along = (wind.x * relX + wind.z * (aim.z - thrower.pos.z)) / dd
                let cross = abs(
                    (wind.x * (aim.z - thrower.pos.z) - wind.z * relX) / dd)
                let range = maxThrowRange(thrower, type, along)
                let powerRatio = d / Swift.max(6, range)
                if powerRatio > 1.05 { continue }

                let flightTime = throwFlightTime(thrower, type, d)
                let path = flightPath(thrower.pos, aim, flightTime, type)
                let blockage = laneBlockage(path, marker, r)
                let separation = separationAt(r, aim, flightTime)

                // Break penalty scales with how well the mark is actually positioned.
                var breakPenalty = 0.0
                if isBreak && marker != nil {
                    let markGood = clamp(1 - (md - Playbook.PLAY.markDistance) / 1.6, 0, 1)
                    breakPenalty = 0.30 * markGood
                }

                let acc = (thrower.attr.throwAccuracy[type] ?? 0) * (0.85 + 0.15 * thrower.energy)
                let pThrow = clamp(
                    (0.60 + 0.40 * (acc / 100))
                        * (1 - 0.30 * powerRatio * powerRatio - breakPenalty * 0.55
                            - 0.030 * cross),
                    0.05, 0.995)
                let pSep = Playbook.sigmoid(separation - 0.60, 1.30)
                let pLane = clamp(1 - blockage, 0.02, 1)
                let contest = clamp(1.1 - separation * 0.45, 0, 1.1)
                let pCatch = catchProbability(r, contest * 0.7 + powerRatio * 0.4)
                var completion = clamp(pThrow * pSep * pLane * pCatch, 0.01, 0.99)

                // ---- expected-possession-value model.
                let gain = Double(dir) * (aim.z - disc.pos.z)
                let isGoal = pb.inAttackEndzone(aim.z, dir)
                let isReset = gain < 0
                let newYards = pb.yardsToGoal(aim.z, dir)
                let gainValue = isGoal ? 1.0 : pv(newYards)
                // A turnover here hands the opponent the disc facing the other way.
                // Where the opponent gets it: `yards` from YOUR goal is
                // `central - yards` from theirs. The reference writes the regulation 64.
                let loss = pv(central - clamp(newYards, 0, central)) * risk
                let value = gainValue

                // ---- explicit deep-shot valuation — `src/sim/AI.ts` evaluateOptions.
                //
                // The multiplicative chain above cannot see a huck: `pSep` reads a
                // receiver even with his man as a coin flip and `pCatch` taxes the same
                // contest a second time, so a 30 m shot multiplied out near 0.2 and no
                // huck was ever thrown. Real teams throw 55% hucks ON PURPOSE: a cutter
                // with a step deep wins the contested disc with speed and hops, and even
                // the miss pins the opponent on their own goal line. So a deep shot's
                // completion IS the jump-ball model — not a `max` with the chain, which
                // is a discrete switch that flips on the last ulp of a separation
                // estimate — and its miss is priced as territory: half a turnover
                // charge, plus credit for the pin.
                //
                // **BOTH DISTANCES ARE SLICES OF PITCH AND BOTH SCALE.** They were bare
                // metres measured on a 32 m goal line, and on the 12.5 m one the branch is
                // not rare, it is unreachable: counted off `Engine.lastThrowAim` over five
                // minis seeds and 332 live releases it fired ZERO times, against 33 of 576
                // at sevens, because the longest a minis offence ever aims at is 18.5 m and
                // the floor was 22 before the 25 was even reached. So the jump-ball model,
                // the `pStay` out-of-bounds tax and the pin credit were dead code on the
                // default pitch, and every deep shot on it was priced by the multiplicative
                // chain this branch exists to bypass. Issues #17 and #28.
                //
                // `d` is a throw length and so is `ThrowSolver.loftRange`, which ADR-0004
                // names as correctly ABSOLUTE — twenty-five metres of air is twenty-five
                // metres on any pitch. The two share a number at regulation and are not the
                // same quantity: `loftRange` is an aerodynamic regime, the gate above is
                // "is this the long shot on THIS field", and the branch it guards prices
                // territory — a pin credit measured in goal lines. A gate that no throw on
                // the pitch can satisfy is not a conservative gate, it is a deleted branch.
                let deepGate = pb.depthScale
                let isDeepShot =
                    gain >= DEEP_SHOT_GAIN * deepGate && d >= DEEP_SHOT_REACH * deepGate
                    && !isReset
                let ev: Double
                if isDeepShot {
                    let def = nearestFoe(r.pos.x, r.pos.z)
                    let speedEdge = def != nil ? (r.attr.speed - def!.attr.speed) / 100 : 0.10
                    let jumpEdge = def != nil ? (r.attr.jumping - def!.attr.jumping) / 100 : 0.10
                    let step = clamp(separation / 2.5, -0.5, 1)
                    // No step, no huck: the base sits low and separation carries the
                    // term, and a shot near the arm's limit is taxed for the underthrow
                    // it will be. At a 0.52 base with a 0.20 step weight the AI spammed
                    // marginal hucks — 17 attempts at 12% completion in fifteen minutes.
                    let pJump = clamp(
                        0.40 + 0.30 * step + 0.50 * speedEdge + 0.35 * jumpEdge, 0.10, 0.80)
                        * (1 - 0.6 * Swift.max(0, powerRatio - 0.75))
                    // A huck near a line is a huck out of bounds: the release scatter
                    // at thirty metres is over a metre and the carry spread is more.
                    // Measured before this term, nine of fourteen attempts sailed out.
                    let room = Swift.min(
                        pb.field.sideline - abs(aim.x),
                        pb.field.endLine - abs(aim.z))
                    let pStay = Playbook.smoothstep(0.2, 4.5, room)
                    completion = clamp(
                        pJump * pLane * pStay * (0.75 + 0.25 * pThrow), 0.01, 0.99)
                    /// The pin: how bad the opponent's field position is after the miss.
                    ///
                    /// 0.30 was set when a huck never completed — with the catch point
                    /// mispredicted, deep throws went 3-for-25 — so the term was carrying the
                    /// whole deep game on the value of the MISS, and the AI was pulling the
                    /// trigger on shots it priced at 11%. With the chase fixed the same throws
                    /// go 21-for-57, and a credit sized to make bad hucks worth taking now buys
                    /// bad hucks on top of good ones: at 0.30 completion falls to 84.4%, outside
                    /// the sport's band, for a deep game that 0.24 delivers anyway. The pin is
                    /// real and it stays; it is no longer the reason to throw.
                    let pin = 1 - pv(central - clamp(newYards, 0, central))
                    ev = completion * gainValue
                        + (1 - completion) * (0.24 * pin - loss * 0.55)
                        - holdValue
                } else {
                    ev = completion * gainValue - (1 - completion) * loss - holdValue
                }
                opts.append(
                    ThrowOption(
                        receiverId: r.id, type: type, aim: aim, dist: d,
                        flightTime: flightTime, separation: separation, blockage: blockage,
                        breakPenalty: breakPenalty, powerRatio: powerRatio,
                        completion: completion, value: value, ev: ev, isGoal: isGoal,
                        isReset: isReset))
            }
        }
        return opts
    }

    /// Sampled flight path. Prefers the disc system's own predictor when present — which
    /// this one does not, deliberately: an eleven-point parabola is enough to answer "is
    /// somebody's body in the way", and it costs nothing.
    func flightPath(_ from: Vec3d, _ to: Vec3d, _ tf: Double, _ type: AIThrowType)
        -> [FlightSample]
    {
        let n = 10
        var out: [FlightSample] = []
        // **A disc is not a shell, and this used to model one.** The bulge was
        // `0.28 + 0.36 * tf^2`, a ballistic arc sized off gravity, and `laneBlockage`
        // reads the height back to decide whether a defender can reach the flight —
        // discarding every sample above his reach. Together they asserted that any throw
        // over about 26 m sails clean over everybody: measured over four fifteen-minute
        // matches, `blockage` was 0.008 on the mean completion and identically 0.000 on
        // every throw that was actually blocked or intercepted. The AI was not misjudging
        // coverage; it was blind to it.
        //
        // The disc flies flat. Sampled off the real integrator through the solved release,
        // a backhand released at 1.05 m holds 0.9 to 1.3 m for the whole flight at every
        // distance from 6 m to 30 m. A huck is the exception and genuinely goes over the
        // top — see `ThrowSolver.loftRange`.
        let throwLen = Playbook.dist2(from.x, from.z, to.x, to.z)
        let arc =
            type == .hammer
            ? 3.2 : (throwLen >= ThrowSolver.loftRange ? loftArc : 0.16)
        // `from` is a player's ground position and `to` is a catch point, so neither y is
        // the disc's. The flight runs hand to hands.
        let y0 = Swift.max(from.y, handHeight)
        let y1 = Swift.max(from.y, handHeight - ThrowSolver.catchDrop)
        for i in 0...n {
            let s = Double(i) / Double(n)
            out.append(
                FlightSample(
                    t: s * tf,
                    x: Playbook.lerp(from.x, to.x, s),
                    y: Playbook.lerp(y0, y1, s) + arc * 4 * s * (1 - s),
                    z: Playbook.lerp(from.z, to.z, s)))
        }
        return out
    }

    /// Is a defender's body in the flight path? Samples the first 78% of the flight (the
    /// tail is the receiver's defender, priced as separation) and asks whether each
    /// defender can get a hand into that window.
    func laneBlockage(_ path: [FlightSample], _ marker: AIPlayer?, _ receiver: AIPlayer)
        -> Double
    {
        var worst = 0.0
        let cut = path[path.count - 1].t * 0.78
        for f in foes {
            // Identity, not id: `AIPlayer` is a class and the reference compares object
            // references here.
            let isMark = marker != nil && f === marker!
            let reach = reachHeight(f)
            let v = effectiveMaxSpeed(f)
            let awareness = 0.55 + 0.45 * (f.attr.defAwareness / 100)
            for s in path {
                // The mark is planted, so he only counts in the release window and only
                // for what he can reach without running — but his body IS in the lane,
                // and pretending otherwise is how a reset gets blocked.
                if isMark ? s.t > 0.42 : (s.t > cut || s.t < 0.05) { continue }
                if s.y > reach || s.y < 0.15 { continue }
                let hd = Playbook.dist2(f.pos.x, f.pos.z, s.x, s.z)
                let reachable =
                    isMark
                    ? 0.80 + v * Swift.max(0, s.t - 0.08) * 0.32
                    : 0.60 + v * Swift.max(0, s.t - 0.14) * 0.72
                let w = clamp((reachable - hd) / 1.4, 0, 1) * awareness
                if w > worst { worst = w }
            }
        }
        // A receiver already at the catch point shields their own space a little.
        let last = path[path.count - 1]
        return clamp(
            worst
                * (1 - 0.12
                    * Playbook.smoothstep(
                        6, 2,
                        Playbook.dist2(receiver.pos.x, receiver.pos.z, last.x, last.z))),
            0, 0.97)
    }

    /// Metres of separation the receiver will have when the disc arrives.
    ///
    /// **The threat is whoever gets to the DISC first, not whoever is standing nearest
    /// the receiver.** This used to pick the defender closest to the receiver's current
    /// position and price the pass off him alone, which makes a poach, an undercut and the
    /// deep help invisible: none of them is the receiver's man, so none of them existed.
    /// Measured over four fifteen-minute matches, the median interception was a disc taken
    /// 1.2 m from the intended receiver by a defender 0.5 m off it, on a throw the model
    /// had priced at 4.1 m of separation.
    func separationAt(_ r: AIPlayer, _ aim: Vec3d, _ tf: Double) -> Double {
        var onMan: AIPlayer?
        var onDisc: AIPlayer?
        var bd = 1e9
        var ad = 1e9
        for f in foes {
            let d = Playbook.dist2(f.pos.x, f.pos.z, r.pos.x, r.pos.z)
            if d < bd {
                bd = d
                onMan = f
            }
            let a = Playbook.dist2(f.pos.x, f.pos.z, aim.x, aim.z)
            if a < ad {
                ad = a
                onDisc = f
            }
        }
        if let onDisc, onDisc !== onMan {
            return Swift.min(
                separationFrom(r, onMan, aim, tf), separationFrom(r, onDisc, aim, tf))
        }
        return separationFrom(r, onMan, aim, tf)
    }

    /// `separationAt` against one named defender.
    func separationFrom(_ r: AIPlayer, _ bestDef: AIPlayer?, _ aim: Vec3d, _ tf: Double)
        -> Double
    {
        guard let bestDef else { return 6 }
        let tR = timeToReach(r, aim.x, aim.z)
        let reaction = 0.30 - 0.18 * (bestDef.attr.defAwareness / 100)
        let tD = timeToReach(bestDef, aim.x, aim.z) + reaction
        // A receiver who cannot beat the disc to the spot is not open at all, however far
        // away his defender is.
        if tR > tf + 0.30 { return clamp(-2.5 - (tR - tf) * 4, -8, 0) }
        let slack = clamp(tf - tR, -1.5, 3)
        // How far the defender is from the catch point at the moment of arrival.
        let lead = (tD - Swift.max(tR, tf * 0.6)) * effectiveMaxSpeed(bestDef)
        return clamp(lead + 0.30 * slack, -6, 8)
    }

    /// HOW CLOSE THIS PLAYER CAN BE TO THE DISC AT ONE END OF THE CATCH WINDOW.
    ///
    /// A flight offers a whole window, not an instant: the disc drops into the standing
    /// band at the rendezvous and stays in it until `CATCH_DEAD`, and a receiver only has
    /// to be on it once. Judging him at one end of that window is what left three
    /// quarters of the surviving bids diving for discs they went on to catch upright a
    /// tenth of a second later. The window is short enough that the best moment is always
    /// at one of its two ends, so two `timeToReach` solves settle it.
    ///
    /// A CHANCE IS A SHORTFALL **AND** A DEADLINE, and separating them is what killed the
    /// layout.
    ///
    /// `bidShortfall` used to return the better of the two ends of the window and both
    /// call sites then paired it with `land.lastT`, the deadline of the *late* end. That
    /// pairing was harmless while the throw solver was aiming the disc at the receiver's
    /// feet, because a disc diving into the turf reaches the rendezvous and `CATCH_DEAD`
    /// within a tenth of a second of each other and the two deadlines are the same number.
    ///
    /// The disc flies flat now — 0.9 to 1.3 m for the whole flight — and is therefore
    /// catchable for the whole of it, so `lastT` is a second or more past the rendezvous
    /// and `deadline <= BID_LEAD` is false for every frame in which a dive would still
    /// have reached the disc. By the time it is true the disc is ten metres downfield and
    /// `short < EXTENDED_REACH` is false instead. Between them the two clauses closed the
    /// gate on every bid in the game: **zero layouts and zero laid-out D's over four
    /// measured matches**, offence and defence alike, which is also the hitstop's only
    /// trigger.
    ///
    /// So each end of the window is now asked as its own question, with its own deadline.
    /// That is the same test `shouldBid` always described — "the last chance falls inside
    /// the time the dive is airborne" — asked about a chance rather than about a mixture
    /// of two.
    func bidChance(_ p: AIPlayer, _ land: CatchPoint, late: Bool) -> Double {
        let x = late ? land.lastX : land.x
        let z = late ? land.lastZ : land.z
        let t = late ? land.lastT : land.t
        // The late chance is seconds away and the ratio form is fine there. The early one
        // is a fraction of a second away, which is where it is worst — see
        // `reachShortfall`.
        return late
            ? arrivalShortfall(Playbook.dist2(p.pos.x, p.pos.z, x, z), timeToReach(p, x, z), t)
            : reachShortfall(p, x, z, t)
    }

    func wantsBid(_ p: AIPlayer, _ land: CatchPoint, stakes: Double) -> Bool {
        shouldBid(p, short: bidChance(p, land, late: false), deadline: land.t, stakes: stakes)
            || shouldBid(
                p, short: bidChance(p, land, late: true), deadline: land.lastT, stakes: stakes)
    }

    /// Seconds for this player to reach `(x, z)`, including the cost of turning.
    ///
    /// Prefers the locomotion peer when one is registered and its answer is sane; the
    /// internal estimate is the fallback. The reference wraps the peer call in a
    /// try/catch because a sibling module might throw; Swift has no such hazard, so only
    /// the finiteness and range guards survive — and they are the ones that matter,
    /// because a peer returning NaN would poison every separation estimate on the field.
    func timeToReach(_ p: AIPlayer, _ x: Double, _ z: Double) -> Double {
        if let peer = locoRef {
            let t = peer.timeToReach(p, x, z)
            if t.isFinite && t >= 0 && t < 60 { return t }
        }
        let d = Playbook.dist2(p.pos.x, p.pos.z, x, z)
        let vmax = effectiveMaxSpeed(p)
        let a = effectiveAccel(p)
        // Change of direction is the expensive part, and it costs twice: the time spent
        // turning AND the ground carried the wrong way while turning. A thrower who
        // ignores this throws behind cutters all day.
        let sp = Foundation.hypot(p.vel.x, p.vel.z)
        var turnTime = 0.0
        var drift = 0.0
        if sp > 0.6 && d > 0.05 {
            let dot = clamp(
                (p.vel.x * (x - p.pos.x) + p.vel.z * (z - p.pos.z)) / (sp * d), -1, 1)
            turnTime = Foundation.acos(dot) / turnRateOf(p)
            drift = sp * turnTime * (1 - Swift.max(0, dot)) * 0.6
        }
        let dEff = d + drift
        let tAcc = vmax / a
        let dAcc = 0.5 * a * tAcc * tAcc
        return turnTime
            + (dEff <= dAcc ? (2 * dEff / a).squareRoot() : tAcc + (dEff - dAcc) / vmax)
    }

    // MARK: - release

    /// Turn the committed choice into the one-shot `throw` action.
    ///
    /// ALIAS SITE. The reference mutates `o.aim`, `o.dist` and `o.flightTime` on the
    /// option object, which is the same object as `this.choice`. Here `o` is a local
    /// `var` copy, which is equivalent because the only caller nils `choice` on the same
    /// frame and nothing reads it in between. **Two `gauss()` draws, x then z.**
    func release(_ world: AIWorld, _ thrower: AIPlayer, _ option: ThrowOption)
        -> PlayerAction
    {
        var o = option
        // The choice can be up to a decision tick plus a windup old. Re-solve the lead
        // against where the receiver actually is now.
        if let r = byId[o.receiverId] {
            let rm = m(r.id)
            let cutTo: Vec2d? =
                (rm.cutState == .break || rm.cutState == .plant) ? rm.cut?.target : nil
            var tf = o.flightTime
            for _ in 0..<2 {
                let lx: Double
                let lz: Double
                if let cutTo {
                    let dx = cutTo.x - r.pos.x
                    let dz = cutTo.z - r.pos.z
                    let dl = Foundation.hypot(dx, dz)
                    let travel = Swift.min(dl, Foundation.hypot(r.vel.x, r.vel.z) * tf * TeamAI.leadCut)
                    lx = r.pos.x + (dl > 1e-3 ? dx / dl : 0) * travel
                    lz = r.pos.z + (dl > 1e-3 ? dz / dl : 0) * travel
                } else {
                    lx = r.pos.x + r.vel.x * tf * TeamAI.leadRun
                    lz = r.pos.z + r.vel.z * tf * TeamAI.leadRun
                }
                let cl = pb.clampToField(Vec2d(lx, lz), margin: 1.4)
                o.aim = Vec3d(cl.x, 1.4, cl.z)
                o.dist = Playbook.dist2(thrower.pos.x, thrower.pos.z, o.aim.x, o.aim.z)
                tf = throwFlightTime(thrower, o.type, o.dist)
            }
            o.flightTime = tf
        }
        let acc = (thrower.attr.throwAccuracy[o.type] ?? 0) * (0.85 + 0.15 * thrower.energy)
        let cross = Foundation.hypot(world.wind.x, world.wind.z)
        // Release scatter, metres per axis. **Every coefficient here is 0.6 of what it
        // was**: the old spread put a 20 m pass a full metre from the receiver on average
        // — a Gaussian per axis at sigma 1.0 is 1.25 m of radial error, exactly the band
        // between a standing catch (0.82 m reach) and a full layout (1.55 m). The match
        // was diving for 42% of its catches. At 0.6 the same pass lands 0.75 m out.
        let sigma =
            (0.156 + 0.87 * (1 - acc / 100)) * (0.55 + 0.030 * o.dist)
            + 0.51 * o.powerRatio * o.powerRatio
            + 0.33 * o.breakPenalty
            + 0.021 * cross * (o.dist / 20)
        let ex = rng.gauss() * sigma
        let ez = rng.gauss() * sigma
        let aimX = clamp(o.aim.x + ex, -pb.field.sideline - 1.5, pb.field.sideline + 1.5)
        let aimZ = clamp(o.aim.z + ez, -pb.field.endLine - 1.5, pb.field.endLine + 1.5)
        return .throw(
            throwType: o.type,
            aim: Vec3d(aimX, AIM_HEIGHT, aimZ),
            // Release speed and arrival time are separate models now — see
            // `throwFlightTime`. Dividing the distance by the lead time was the coupling
            // that forced one curve to do both jobs.
            speed: throwReleaseSpeed(thrower, o.type, o.dist),
            flightTime: o.flightTime,
            spin: 22 + 14 * (thrower.attr.throwPower / 100),
            receiverId: o.receiverId,
            expected: o.completion)
    }

    // MARK: - offence in flight

    func offenceInFlight(_ world: AIWorld, _ dt: Double) -> [PlayerIntent] {
        var out: [PlayerIntent] = []
        let land = predictCatchPoint(world)
        let target = world.disc.intendedReceiver
        let stakes = discStakes(land.z, dir, field: pb)

        // Whoever is nearest the disc backs up the intended receiver.
        var backupId = -1
        var bd = 1e9
        for p in mates {
            if p.id == target { continue }
            let t = timeToReach(p, land.x, land.z)
            if t < bd {
                bd = t
                backupId = p.id
            }
        }

        for p in mates {
            let rec = m(p.id)
            if rec.flightCommit != flightEpoch {
                rec.flightCommit = flightEpoch
                rec.bidCommit = false
            }
            let isTarget = p.id == target
            if isTarget || p.id == backupId {
                let t = timeToReach(p, land.x, land.z)
                let gap = (t - land.t) * effectiveMaxSpeed(p)
                // Time the arrival. Sprinting flat out to a spot the disc reaches a second
                // later just means running through it and having to come back — unless a
                // defender is contesting, in which case get there first.
                var contested = false
                for f in foes
                where Playbook.dist2(f.pos.x, f.pos.z, land.x, land.z) < 4.5 {
                    contested = true
                    break
                }
                let pace =
                    contested ? 1 : clamp(0.34 + 0.85 * (t / Swift.max(0.08, land.t)), 0.34, 1)
                var mode: AIMoveMode = .sprint
                var action: PlayerAction?
                if gap <= 0.15 && land.y > 1.9 && land.y < reachHeight(p) + 0.5 {
                    mode = .jump
                    action = .jump(height: land.y)
                } else if isTarget && wantsBid(p, land, stakes: stakes) {
                    // You lay out for a disc you cannot otherwise reach — not for one you
                    // can simply run down. `shouldBid` is the whole test.
                    mode = .layout
                    action = .bid(x: land.x, z: land.z)
                } else if gap <= 0.05 {
                    mode = .catch
                    let diff = clamp(
                        0.20 + 0.5 * clamp((land.y - 1.7) / 1.0, 0, 1)
                            + 0.35 * contestAt(land.x, land.z), 0, 1.6)
                    action = .catch(difficulty: diff)
                }
                let c = pb.clampToField(Vec2d(land.x, land.z), margin: 0.45)
                out.append(
                    intent(
                        p, c.x, c.z, land.x - p.pos.x, land.z - p.pos.z, mode, pace, action,
                        role: p.role.rawValue, state: "attack-disc", lane: nil,
                        dt: dt, settle: true))
                continue
            }
            // Everyone else clears out and re-forms around the likely new disc spot.
            if rec.cutState == .setup || rec.cutState == .plant || rec.cutState == .break {
                endCut(p.id, .clear)
            }
            let st = stationFor(p, world, ax: land.x, az: land.z)
            let c = avoidSidelines(st.x, st.z, p)
            out.append(
                intent(
                    p, c.x, c.z, land.x - p.pos.x, land.z - p.pos.z, .jog, 0.55, nil,
                    role: p.role.rawValue, state: "clear", lane: nil, dt: dt))
        }
        return out
    }

    func contestAt(_ x: Double, _ z: Double) -> Double {
        var n = 0.0
        for f in foes where Playbook.dist2(f.pos.x, f.pos.z, x, z) < 1.8 { n += 1 }
        return clamp(n, 0, 2)
    }
}
