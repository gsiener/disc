import Foundation
import UltimateSim

/// THE TWO SUBSYSTEMS THAT EXISTED AND NEVER FIRED.
///
/// `GameState.callTimeout` and the 3-2-2 zone were both complete, both correct, both
/// covered by fixtures, and both unreachable from a match. This suite is the thing that
/// was missing in each case: an assertion that the *whole engine*, left to play itself,
/// actually reaches them.
///
/// **There are no goldens here and there cannot be.** The pure halves — the weather draw
/// and `Playbook.timeoutIntent` — are differed bit-exact against `tools/goldens/playbook.ts`
/// by `PlaybookTests`, which is where a divergence between the reference and the port would
/// show up. What is left over is reachability and consequence, and neither is a number the
/// reference publishes.
///
/// The reachability checks are written to be **immune to the tail-statistic problem** the
/// friction log records against per-seed telemetry bands: the weather is pinned rather than
/// drawn wherever the point of the check is the zone, and the timeout checks assert over a
/// pool. A check that can only be made green by re-rolling a seed is not a check.
enum StoppageTests {

    static let dt = 1.0 / 120.0
    /// The same eleven matches the rest of the suite measures over — and the same eleven
    /// `calls` and `matchdiff` measure over, which is why they are played once, in
    /// `MatchPool`, rather than three times here and twice more there.
    static let seeds: [UInt32] = MatchPool.seeds

    static func run() throws {
        theTimeoutIsCalled()
        theCountResumesOneHigher()
        theSetPlayTimeoutIsReachable()
        aTimeoutIsNotALineUp()
        theZoneIsReachableFromTheWeather()
        theCalmDayIsTheDayItAlwaysWas()
        aPullIsFlattenedIntoAHeadwind()
    }

    // MARK: - timeouts

    /// A match takes timeouts, and not more than the rules allow.
    ///
    /// Two per team per half is four per team per match and eight in the game. The floor is
    /// pooled over eleven matches rather than asserted per seed, because a windy match
    /// barely reaches a count of seven at all — the offence turns it over first — and a
    /// per-seed floor would be a statement about the weather.
    private static func theTimeoutIsCalled() {
        var called = 0

        for match in MatchPool.matches {
            let seed = match.seed
            var here = 0
            for t in 0..<2 {
                let used = match.timeoutsUsed[t]
                here += used
                // Two per half is four per team per match, and the machine is the only
                // thing that hands them out — so this is a check on the caller not having
                // found a way round it.
                Check.ok(
                    used <= 4,
                    "s\(seed): team \(t) used no more than four timeouts (\(used))")
            }
            called += here
        }

        let mean = Double(called) / Double(seeds.count)
        // THE WHOLE POINT OF THIS SUITE. Before the caller existed this was 0.00, in every
        // match this engine had ever played. Pooled rather than per seed: a windy match
        // barely reaches a count of seven at all, because the offence turns it over first,
        // so a per-seed floor would be a statement about the weather.
        Check.ok(mean >= 1.5, "a match takes timeouts (mean \(mean))")
        Check.ok(mean <= 8, "and never more than the eight the rules allow (mean \(mean))")
    }

    /// The count resumes one higher, and the possession survives.
    ///
    /// WFDF 19: play restarts at the count reached plus one, capped by `stallResumeCap`.
    /// `Playbook.timeoutIntent` takes the panic timeout three counts short of the turnover
    /// **for exactly this reason** — see the doc on `timeoutPanicBefore` — so the check that
    /// matters is that the resumed count lands inside the window the offence can still make
    /// a decision in, rather than past the 8.5 at which `TeamAI` throws anything at all.
    private static func theCountResumesOneHigher() {
        var resumed: [Int] = []
        // The first five matches of the pool, in seed order — the same five, and the same
        // transitions off the same ticks, as when this loop played them itself.
        for match in MatchPool.matches.prefix(5) {
            resumed.append(contentsOf: match.resumedCounts)
        }
        Check.ok(!resumed.isEmpty, "some timeout resumed a live possession")
        guard !resumed.isEmpty else { return }
        for r in resumed {
            Check.inRange(
                Double(r), 1, 9,
                "a resumed count is between one and the resume cap (\(r))")
        }
        // A panic timeout at 7 resumes at 8. Anything at 9 is the desperation throw the
        // trigger was chosen to avoid, so it must not be the common case.
        let atCap = resumed.filter { $0 >= 9 }.count
        Check.ok(
            Double(atCap) <= Double(resumed.count) * 0.5,
            "most timeouts resume below the cap (\(atCap) of \(resumed.count) at 9)")
    }

    /// THE SECOND REASON A TEAM CALLS ONE, and it needs a game that reaches an endgame.
    ///
    /// `Playbook.timeoutIntent` has two branches. The panic call fires several times a
    /// match and is asserted above; the set play fires when either side is within two of the
    /// game with a margin of one or less, and a fifteen-minute 7v7 to 15 finishes 8-10 or
    /// 5-5 — it never gets near 13, so **that branch is unreachable in the format the rest
    /// of this suite measures**. Asserting it there would have been asserting nothing, which
    /// is the exact failure this whole issue was about.
    ///
    /// A game to 5 reaches its endgame in ten minutes. Told apart from a panic call by the
    /// count it resumes at: a set play is taken off the catch, so the count comes back at
    /// one, where a panic call comes back at eight.
    private static func theSetPlayTimeoutIsReachable() {
        // Not the canonical pool — a different target is a different match — so there is
        // nothing to share. Eleven independent matches still need not be played one after
        // another, though; see `MatchPool.concurrently` for why that is safe and why the
        // counting happens back here rather than in the worker.
        let counted = MatchPool.concurrently(seeds) { seed -> (Int, Int) in
            let e = Engine(format: .sevens, target: 5, seed: seed)
            e.autoTeams = [0, 1]
            var setPlays = 0
            var panics = 0
            var wasTimeout = false
            for _ in 0..<(120 * 900) where !e.isOver {
                e.step(dt: dt)
                let inTimeout = e.game.phase == .timeout
                if wasTimeout && !inTimeout && e.game.phase == .check {
                    if e.game.pendingStallResume <= 3 { setPlays += 1 } else { panics += 1 }
                }
                wasTimeout = inTimeout
            }
            return (setPlays, panics)
        }
        let setPlays = counted.reduce(0) { $0 + $1.0 }
        let panics = counted.reduce(0) { $0 + $1.1 }
        Check.ok(setPlays > 0, "the set-play timeout is reachable (\(setPlays))")
        Check.ok(panics > 0, "and the panic timeout still is (\(panics))")
    }

    /// A TIMEOUT DOES NOT EMPTY THE FIELD, and it does not move the disc.
    ///
    /// `TeamAI` sends every body to its own goal line for a `.setup`, `.pull` or `.dead`
    /// phase, so mapping `.timeout` onto any of those turns a stoppage into a line-up:
    /// measured at 83 m of thrower drift over one twelve-second timeout, which is a
    /// possession carried the length of the field. Both halves are asserted — the thrower
    /// stays on his pivot, and the rest of his side stays in the same half of the pitch as
    /// the disc.
    private static func aTimeoutIsNotALineUp() {
        var worstDrift = 0.0
        var timeouts = 0
        var worstSpread = 0.0

        // Per-tick during the pool's own pass: every `.timeout` frame with a thrower on the
        // disc, the thrower's distance from his pivot, and the furthest team-mate from it —
        // maxima over the same five matches, which a max over per-match maxima is.
        for match in MatchPool.matches.prefix(5) {
            timeouts += match.timeoutFrames
            worstDrift = Swift.max(worstDrift, match.worstThrowerDrift)
            // Nobody on the offence should be at the far goal line waiting for a pull.
            worstSpread = Swift.max(worstSpread, match.worstTeamMateDistance)
        }

        Check.ok(timeouts > 0, "there were timeout frames to measure")
        guard timeouts > 0 else { return }
        // The pivot radius plus the integrator's own step, which is the same bar
        // `PivotTests` holds a live thrower to.
        Check.ok(
            worstDrift <= 3.2,
            "the thrower holds his pivot through a timeout (\(worstDrift) m)")
        // Two goal lines apart is the line-up. An offence re-forming around the disc is
        // inside one.
        Check.ok(
            worstSpread <= 60,
            "the offence stays around the disc rather than lining up (\(worstSpread) m)")
    }

    // MARK: - the zone

    /// THE ZONE IS REACHABLE, and it is reachable *from the weather*.
    ///
    /// Pinned rather than drawn, on purpose. A drawn windy day is one match in ten and a
    /// check that waits for one is a check that passes or fails on a seed. What is asserted
    /// here is the implication: **if the day is a blow, the defence plays zone** — which is
    /// the whole of what was impossible before, twice over. The wind could not reach 4.5 m/s
    /// and the two default zone biases demanded a wind term above 1.0, which is more than
    /// the term can produce.
    private static func theZoneIsReachableFromTheWeather() {
        // The bottom of the windy band, so this asserts the worst blow the draw can make
        // rather than a convenient gale.
        var mutable = EngineConfig.default
        mutable.fixedWind = Vec2d(0, Playbook.windySpeed.min)
        // Immutable before it is captured: a `var` cannot cross into a concurrent closure,
        // and the config a match was played with should not be editable afterwards anyway.
        let cfg = mutable

        let pinned = MatchPool.concurrently(Array(seeds.prefix(3))) { seed -> (Int, Int) in
            let e = Engine(format: .sevens, seed: seed, config: cfg)
            e.autoTeams = [0, 1]
            var zonePoints = 0
            var points = 0
            var lastPoint = -1
            for _ in 0..<(120 * 600) where !e.isOver {
                e.step(dt: dt)
                guard e.game.phase == .livePossession, e.game.point != lastPoint else { continue }
                lastPoint = e.game.point
                points += 1
                if e.ai.contains(where: { $0.currentScheme == .zone }) { zonePoints += 1 }
            }
            return (zonePoints, points)
        }
        let zonePoints = pinned.reduce(0) { $0 + $1.0 }
        let points = pinned.reduce(0) { $0 + $1.1 }
        Check.ok(points > 0, "the pinned-weather matches played points")
        Check.eq(
            zonePoints, points,
            "every point of a blow is a zone point (\(zonePoints) of \(points) on a pinned "
                + "\(Playbook.windySpeed.min) m/s day)")

        // …and the mirror image: a calm day is never a zone day off the wind alone.
        var calm = EngineConfig.default
        calm.fixedWind = Vec2d(1.5, 1.1)
        let e = Engine(format: .sevens, seed: 11, config: calm)
        e.autoTeams = [0, 1]
        var calmZone = 0
        var calmPoints = 0
        var lastPoint = -1
        for _ in 0..<(120 * 300) where !e.isOver {
            e.step(dt: dt)
            guard e.game.phase == .livePossession, e.game.point != lastPoint else { continue }
            lastPoint = e.game.point
            calmPoints += 1
            if e.ai.contains(where: { $0.currentScheme == .zone }) { calmZone += 1 }
        }
        Check.ok(calmPoints > 0, "the calm match played points")
        // A big late lead can still call it — that is `shouldPlayZone`'s other term and it
        // is meant to be reachable — so this bounds rather than forbids.
        Check.ok(
            Double(calmZone) <= Double(calmPoints) * 0.5,
            "a calm day is mostly person defence (\(calmZone) of \(calmPoints))")
    }

    /// NINE MATCHES IN TEN ARE PLAYED ON THE DAY THIS GAME HAS ALWAYS BEEN PLAYED ON.
    ///
    /// The calm branch of `Playbook.drawWeather` is the draw it replaced, call for call:
    /// `range(-1.5, 1.5)` across and `range(-1.1, 1.1)` along. That is a stronger statement
    /// than "the mean is similar" and it is the reason the telemetry bands in this repo
    /// survive the change, so it is asserted as an envelope rather than trusted.
    private static func theCalmDayIsTheDayItAlwaysWas() {
        var windy = 0
        let n = 4000
        for seed in 1...UInt32(n) {
            let day = Playbook.drawWeather(Rng(seed: seed))
            if day.windy {
                Check.inRange(
                    day.speed, Playbook.windySpeed.min, Playbook.windySpeed.max,
                    "a blow is inside its band (\(day.speed))")
                // Every blow clears the midpoint of `shouldPlayZone`'s ramp, which is what
                // makes the zone the ordinary answer to it rather than a coin flip.
                Check.ok(
                    Playbook.shouldPlayZone(day.speed, 0, 0, 0),
                    "a blow calls zone on its own (\(day.speed) m/s)")
                windy += 1
            } else {
                Check.ok(
                    abs(day.wind.x) <= Playbook.calmAcross
                        && abs(day.wind.z) <= Playbook.calmAlong,
                    "a calm day is inside the old draw's envelope "
                        + "(\(day.wind.x), \(day.wind.z))")
            }
        }
        let rate = Double(windy) / Double(n)
        // A tenth, with the slack a 4000-sample binomial earns.
        Check.inRange(
            rate, 0.08, 0.12,
            "a blow is one day in ten (\(windy) of \(n) days, \(rate))")
    }

    /// A pull is flattened into a headwind, and untouched otherwise.
    ///
    /// `solvePower` bisects against the real wind, so the power was never the problem — a
    /// launch angle is not something power can fix. At 0.30 rad into the top of the windy
    /// band the disc balloons, stalls and lands 0.27 goal lines away on the minis pitch.
    private static func aPullIsFlattenedIntoAHeadwind() {
        var cfg = EngineConfig.default
        for (label, format) in [("minis", GameFormat.minis), ("sevens", GameFormat.sevens)] {
            for wind in [Playbook.windySpeed.min, Playbook.windySpeed.max] {
                // Both signs, so whichever end the pulling team is on, one of the two is a
                // headwind for it.
                for sign in [1.0, -1.0] {
                    cfg.fixedWind = Vec2d(0, sign * wind)
                    let e = Engine(format: format, seed: 11, config: cfg)
                    e.autoTeams = [0, 1]
                    let dir = Double(e.dirFor(e.game.pullingTeam))
                    guard
                        let from = e.body(of: e.game.pullingTeam * format.playersPerSide)?.pos
                    else { continue }

                    var landed: Vec3d?
                    for _ in 0..<(120 * 30) {
                        e.step(dt: dt)
                        for event in e.drainEvents() {
                            switch event {
                            case .pullCaught(_, _, let pos): landed = landed ?? pos
                            case .pullLanded(let pos): landed = landed ?? pos
                            case .pullOutOfBounds(let pos): landed = landed ?? pos
                            // A dropped pull is a resolved pull. See the same case in
                            // `EngineSeamTests`, where its absence read as "the pull never
                            // resolved".
                            case .turnover(.pullDrop, _, _, _, _, let pos):
                                landed = landed ?? pos
                            default: break
                            }
                        }
                        if landed != nil { break }
                    }
                    guard let landed else {
                        Check.ok(
                            false,
                            "\(label): the pull never resolved in \(sign * wind) m/s")
                        continue
                    }
                    let carry = (landed.z - from.z) * dir / format.field.goalLine
                    // NOT 0.95, which is `EngineSeamTests`' calm-day bound, and the
                    // difference is physics rather than tuning. Swept at full power over
                    // launch angles 0.05–0.40 into 9.5 m/s of headwind, the best carry the
                    // flight model will give is 28.1 m — 0.88 goal lines on the sevens pitch
                    // — and the optimum sits at 0.10 rad, which is where `pullAngle` puts
                    // it. A pull that barely clears midfield into a 21 mph headwind is the
                    // sport, not a bug; what would be a bug is the 0.27 goal lines a lofted
                    // pull produced before the angle moved.
                    Check.ok(
                        carry >= 0.8,
                        "\(label): a pull still reaches the receiving half in \(wind) m/s "
                            + "(\(carry) goal lines)")
                }
            }
        }
    }


}
