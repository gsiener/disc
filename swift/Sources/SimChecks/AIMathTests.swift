import Foundation
import UltimateSim

/// The AI's pure functions, against `src/sim/AI.ts` lines 281–652.
///
/// Most of this is a table sweep, because most of these are functions of ratings and
/// geometry with nothing behind them. Two entries are not, and they are the ones that
/// earn the suite:
///
///  - **`makeAttributes` pins the RNG draw order.** The reference builds one object
///    literal and JavaScript evaluates its properties top to bottom: `throwPower` first,
///    then speed through catching, then the five throw accuracies, then decision,
///    stamina, awareness. Swift evaluates initialiser arguments in *call* order, which is
///    a different order, because `throwAccuracy` sits before `throwPower` in the
///    signature. Getting that wrong compiles, looks right, and produces a completely
///    plausible but completely different player from the same seed. **The port had it
///    wrong until this fixture was written.**
///  - **`tickStamina` mutates its player**, and drains or recovers on opposite sides of a
///    load threshold. A fixture sampling one branch would miss a flipped comparison.
enum AIMathTests {

    // MARK: fixture shapes

    struct Sheet: Decodable {
        let speed: Double
        let acceleration: Double
        let agility: Double
        let jumping: Double
        let catching: Double
        let throwAccuracy: [String: Double]
        let throwPower: Double
        let decision: Double
        let stamina: Double
        let defAwareness: Double
    }

    struct CapabilityRow: Decodable {
        let energy: Double
        let baseMaxSpeed: Double
        let effectiveMaxSpeed: Double
        let effectiveAccel: Double
        let effectiveDecel: Double
        let turnRateOf: Double
        let reachHeight: Double
        let layoutExtend: Double
        let effectiveDecision: Double
    }
    struct PossessionRow: Decodable {
        let yards: Double
        let want: Double
    }
    struct StakesRow: Decodable {
        let z: Double
        let dir: Int
        let want: Double
    }
    struct BidRow: Decodable {
        let energy: Double
        let short: Double
        let deadline: Double
        let stakes: Double
        let want: Bool
    }
    struct ThrowRow: Decodable {
        let type: String
        let energy: Double
        let windAlong: Double
        let d: Double
        let range: Double
        let flight: Double
        let releaseSpeed: Double
    }
    struct CatchRow: Decodable {
        let energy: Double
        let difficulty: Double
        let want: Double
    }
    struct StaminaRow: Decodable {
        let step: Int
        let speed: Double
        let energy: Double
    }
    struct RoomRow: Decodable {
        let px: Double
        let pz: Double
        let dx: Double
        let dz: Double
        let want: Double
    }
    struct SheetRow: Decodable {
        let archetype: String
        let overall: Double
        let seed: Int
        let attr: Sheet
    }
    struct RosterRow: Decodable {
        let id: Int
        let archetype: String
        let handed: String
        let role: String
        let energy: Double
        let attr: Sheet
    }

    struct File: Decodable {
        let note: String
        let probeAttrs: Sheet
        let capability: [CapabilityRow]
        let possession: [PossessionRow]
        let stakes: [StakesRow]
        let bids: [BidRow]
        let throwRows: [ThrowRow]
        let catches: [CatchRow]
        let staminaTrace: [StaminaRow]
        let room: [RoomRow]
        let sheets: [SheetRow]
        let roster: [[RosterRow]]
    }

    /// `gauss` runs `sqrt(-2 * log(u)) * cos(2 * pi * next())`, and `hypot` is not
    /// correctly rounded either. Nothing else here needs slack.
    private static let transcendentalTol = 1e-12

    nonisolated(unsafe) static var worst = 0.0

    static func run() throws {
        let g = try Goldens.load(File.self, "aimath")

        // Everything downstream is measured against this one sheet, so if it has drifted
        // every later comparison is meaningless. Assert it first and loudly.
        let probeSheet = makeAttributes(Rng(seed: 12345), .cutter, overall: 72)
        compare(probeSheet, g.probeAttrs, "probe sheet")

        capability(g)
        possession(g)
        stakes(g)
        bids(g)
        throwsAndFlight(g)
        catches(g)
        stamina(g)
        boundaries(g)
        sheets(g)
        rosters(g)
        claims()

        Check.note("worst AI-math deviation \(worst)")
    }

    // MARK: helpers

    private static func near(_ got: Double, _ want: Double, _ tol: Double, _ what: String) {
        let d = abs(got - want)
        worst = Swift.max(worst, d)
        Check.ok(d <= tol, "\(what): off by \(d) (got \(got), want \(want))")
    }

    private static func probe(_ energy: Double) -> AIPlayer {
        let p = makePlayer(1, 0, .cutter, Rng(seed: 12345), overall: 72)
        p.energy = energy
        return p
    }

    private static func archetype(_ s: String) -> Archetype {
        Archetype(rawValue: s) ?? .utility
    }

    /// Compare a whole rating sheet field by field.
    ///
    /// Whole-sheet rather than spot-checked precisely because the failure worth catching
    /// is two fields being swapped, or the draw order shifting — both of which leave
    /// every individual value looking entirely reasonable.
    private static func compare(_ got: AIAttributes, _ want: Sheet, _ at: String) {
        // Each of these is a clamp of a sum containing one `gauss()`, so they inherit
        // that transcendental's slack and nothing more.
        near(got.speed, want.speed, transcendentalTol, "\(at).speed")
        near(got.acceleration, want.acceleration, transcendentalTol, "\(at).acceleration")
        near(got.agility, want.agility, transcendentalTol, "\(at).agility")
        near(got.jumping, want.jumping, transcendentalTol, "\(at).jumping")
        near(got.catching, want.catching, transcendentalTol, "\(at).catching")
        near(got.throwPower, want.throwPower, transcendentalTol, "\(at).throwPower")
        near(got.decision, want.decision, transcendentalTol, "\(at).decision")
        near(got.stamina, want.stamina, transcendentalTol, "\(at).stamina")
        near(got.defAwareness, want.defAwareness, transcendentalTol, "\(at).defAwareness")

        Check.eq(got.throwAccuracy.count, want.throwAccuracy.count, "\(at): five accuracies")
        for t in AI_THROW_TYPES {
            guard let w = want.throwAccuracy[t.rawValue], let a = got.throwAccuracy[t] else {
                Check.ok(false, "\(at): missing accuracy for \(t.rawValue)")
                continue
            }
            near(a, w, transcendentalTol, "\(at).throwAccuracy.\(t.rawValue)")
        }
    }

    // MARK: sweeps

    private static func capability(_ g: File) {
        for row in g.capability {
            let p = probe(row.energy)
            let at = "capability(energy \(row.energy))"
            // All eight are sums and products of ratings — bit-exact, no exceptions.
            Check.bitEqViaJSON(baseMaxSpeed(p.attr), row.baseMaxSpeed, "\(at).baseMaxSpeed")
            Check.bitEqViaJSON(effectiveMaxSpeed(p), row.effectiveMaxSpeed, "\(at).maxSpeed")
            Check.bitEqViaJSON(effectiveAccel(p), row.effectiveAccel, "\(at).accel")
            Check.bitEqViaJSON(effectiveDecel(p), row.effectiveDecel, "\(at).decel")
            Check.bitEqViaJSON(turnRateOf(p), row.turnRateOf, "\(at).turnRate")
            Check.bitEqViaJSON(reachHeight(p), row.reachHeight, "\(at).reachHeight")
            Check.bitEqViaJSON(layoutExtend(p), row.layoutExtend, "\(at).layoutExtend")
            Check.bitEqViaJSON(effectiveDecision(p), row.effectiveDecision, "\(at).decision")
        }
    }

    private static func possession(_ g: File) {
        for row in g.possession {
            Check.bitEqViaJSON(
                possessionValue(row.yards), row.want, "possessionValue(\(row.yards))")
        }
    }

    private static func stakes(_ g: File) {
        for row in g.stakes {
            Check.bitEqViaJSON(
                discStakes(row.z, row.dir), row.want, "discStakes(\(row.z), \(row.dir))")
        }
    }

    private static func bids(_ g: File) {
        for row in g.bids {
            let p = probe(row.energy)
            Check.eq(
                shouldBid(p, short: row.short, deadline: row.deadline, stakes: row.stakes),
                row.want,
                "shouldBid(short \(row.short), deadline \(row.deadline), stakes \(row.stakes))")
        }
    }

    private static func throwsAndFlight(_ g: File) {
        for row in g.throwRows {
            guard let t = AIThrowType(rawValue: row.type) else {
                Check.ok(false, "unknown throw type \(row.type)")
                continue
            }
            let p = probe(row.energy)
            let at = "\(row.type)/e\(row.energy)"
            Check.bitEqViaJSON(
                maxThrowRange(p, t, row.windAlong), row.range,
                "\(at) maxThrowRange(wind \(row.windAlong))")
            Check.bitEqViaJSON(
                throwFlightTime(p, t, row.d), row.flight, "\(at) throwFlightTime(d \(row.d))")
            // `throwReleaseSpeed` appeared in no fixture until this line: the reviewer
            // mutated its stretch term in Swift alone — changing how hard every throw
            // over 15 m is released — and 2,240,645 assertions stayed green. The
            // generator's distances straddle both of its smoothsteps and its type sweep
            // reaches the hammer's zip factor, so a mutation of either dies here.
            Check.bitEqViaJSON(
                throwReleaseSpeed(p, t, row.d), row.releaseSpeed,
                "\(at) throwReleaseSpeed(d \(row.d))")
        }
    }

    private static func catches(_ g: File) {
        for row in g.catches {
            let p = probe(row.energy)
            Check.bitEqViaJSON(
                catchProbability(p, row.difficulty), row.want,
                "catchProbability(e \(row.energy), d \(row.difficulty))")
        }
    }

    /// Replays the drain/recover trace, driving speed the same way the generator does.
    private static func stamina(_ g: File) {
        let p = probe(1)
        let vmax = effectiveMaxSpeed(p)
        var plan: [Double] = []
        plan.append(contentsOf: Array(repeating: 1.0, count: 120))
        plan.append(contentsOf: Array(repeating: 0.0, count: 60))
        plan.append(contentsOf: Array(repeating: 0.41, count: 30))
        plan.append(contentsOf: Array(repeating: 0.43, count: 30))
        plan.append(contentsOf: Array(repeating: 1.2, count: 60))

        var index = 0
        for (i, frac) in plan.enumerated() {
            p.vel.x = frac * vmax
            p.vel.z = 0
            tickStamina(p, 1.0 / 60)
            if i % 10 == 0 {
                guard index < g.staminaTrace.count else { break }
                let want = g.staminaTrace[index]
                Check.eq(i, want.step, "stamina trace step alignment")
                // `hypot` inside the load term is not correctly rounded, and this is an
                // accumulation of 120+ steps of it.
                near(p.energy, want.energy, transcendentalTol, "stamina[\(i)].energy")
                index += 1
            }
        }
        if index < g.staminaTrace.count {
            let want = g.staminaTrace[index]
            near(p.energy, want.energy, transcendentalTol, "stamina[final].energy")
        }
    }

    private static func boundaries(_ g: File) {
        for row in g.room {
            Check.bitEqViaJSON(
                boundaryRoom(row.px, row.pz, row.dx, row.dz), row.want,
                "boundaryRoom((\(row.px),\(row.pz)) along (\(row.dx),\(row.dz)))")
        }
    }

    /// The draw-order check. See the type doc — this is the reason the suite exists.
    private static func sheets(_ g: File) {
        for row in g.sheets {
            let got = makeAttributes(
                Rng(seed: UInt32(row.seed)), archetype(row.archetype), overall: row.overall)
            compare(got, row.attr, "makeAttributes(\(row.archetype), overall \(row.overall))")
        }
    }

    /// A whole roster from one seed, which pins the sheet order *and* the handedness draw
    /// that follows it — a port that consumed one extra number anywhere would desync
    /// every player after the first.
    private static func rosters(_ g: File) {
        for group in g.roster {
            guard let first = group.first else { continue }
            let rng = Rng(seed: 4242)
            for (i, want) in group.enumerated() {
                let p = makePlayer(i, 0, archetype(first.archetype), rng, overall: 72)
                let at = "roster \(first.archetype)[\(i)]"
                Check.eq(p.id, want.id, "\(at).id")
                Check.eq(p.archetype.rawValue, want.archetype, "\(at).archetype")
                Check.eq(p.handed.rawValue, want.handed, "\(at).handed")
                Check.eq(p.role.rawValue, want.role, "\(at).role")
                Check.bitEqViaJSON(p.energy, want.energy, "\(at).energy")
                compare(p.attr, want.attr, at)
            }
        }
    }

    // MARK: the claims the module makes in prose

    /// Doc comments assert behaviour, and behaviour can be checked. Every one of these
    /// would still pass the whole table above if its sign were flipped, because a table
    /// only says what the reference does — not what it is supposed to mean.
    private static func claims() {
        let fresh = probe(1)
        let cooked = probe(0.12)

        Check.ok(
            effectiveMaxSpeed(cooked) < effectiveMaxSpeed(fresh), "a tired player is slower")
        Check.ok(
            effectiveAccel(cooked) < effectiveAccel(fresh),
            "a tired player accelerates worse")
        Check.ok(
            effectiveDecision(cooked) < effectiveDecision(fresh),
            "a tired player decides worse")
        // "a tired player is slower, not clumsier" — turn rate must NOT depend on energy.
        Check.bitEqViaJSON(
            turnRateOf(cooked), turnRateOf(fresh), "fatigue does not change turn rate")

        // "a dive converts exactly 0.73 m of reach".
        //
        // Asserted to a tolerance rather than bit-for-bit, and the difference is the
        // point: `1.55 - 0.82` is 0.7300000000000001, because neither operand is
        // representable. The claim in the prose is about the sport, not about a bit
        // pattern, and writing a decimal literal for it means writing down whichever of
        // the two neighbouring doubles the subtraction happens to land on. It landed on
        // the other one here on the first attempt.
        near(
            EXTENDED_REACH - STANDING_REACH, 0.73, 1e-15,
            "the layout band is the 0.73 m the rules engine pays out on")

        // A layout is a last resort: inside standing reach, never; past extended, never.
        let p = probe(1)
        Check.ok(
            !shouldBid(p, short: 0.5, deadline: 0.2, stakes: 1),
            "you do not dive for a disc you can reach standing")
        Check.ok(
            !shouldBid(p, short: 3.0, deadline: 0.2, stakes: 1),
            "you do not dive for a disc three metres away")
        Check.ok(
            !shouldBid(p, short: 1.3, deadline: 5.0, stakes: 1),
            "you do not dive five seconds early")
        Check.ok(
            shouldBid(p, short: 1.3, deadline: 0.2, stakes: 1),
            "you do dive for one inside the band, late, with everything on it")
        // Stakes buy most of the hesitation down, so a goal-line disc is bid on sooner.
        Check.ok(
            shouldBid(p, short: 1.0, deadline: 0.2, stakes: 1)
                || !shouldBid(p, short: 1.0, deadline: 0.2, stakes: 0),
            "higher stakes never make a player less willing to bid")

        // "a turnover in your own endzone is a goal against, not a field-position swing"
        Check.ok(
            possessionValue(82) < possessionValue(64),
            "deep in your own endzone is worth less than your own goal line")
        Check.ok(
            possessionValue(0) > possessionValue(40), "closer to the goal is worth more")
        Check.ok(
            possessionValue(0) > possessionValue(82),
            "the endzone you are attacking beats the one you are defending")

        // Throw table: a backhand outranges everything, a push outranges nothing.
        let windless = AI_THROW_TYPES.map { (t: AIThrowType) in (t, maxThrowRange(p, t, 0)) }
        let backhand = windless.first { $0.0 == .backhand }!.1
        for (t, r) in windless where t != .backhand {
            Check.ok(r < backhand, "a backhand outranges a \(t.rawValue)")
        }
        Check.ok(
            windless.allSatisfy { $0.0 == .push || $0.1 > windless.first { $0.0 == .push }!.1 },
            "a push is the shortest throw there is")

        // Tailwind helps, headwind hurts, and both clamp.
        Check.ok(
            maxThrowRange(p, .backhand, 5) > maxThrowRange(p, .backhand, -5),
            "a tailwind throws further than a headwind")
        Check.bitEqViaJSON(
            maxThrowRange(p, .backhand, 20), maxThrowRange(p, .backhand, 8),
            "wind clamps rather than compounding")

        // Longer throws hang longer, and a hammer hangs longer than a backhand of the
        // same length because it is thrown with less zip.
        Check.ok(
            throwFlightTime(p, .backhand, 40) > throwFlightTime(p, .backhand, 10),
            "a longer throw is in the air longer")
        Check.ok(
            throwFlightTime(p, .hammer, 30) > throwFlightTime(p, .backhand, 30),
            "a hammer hangs longer than a backhand of the same distance")

        // Catching: harder is worse, and it never reaches certainty or hopelessness.
        Check.ok(
            catchProbability(p, 1.5) < catchProbability(p, 0),
            "a full-extension grab is less certain than a chest-high disc")
        Check.inRange(catchProbability(p, 0), 0.18, 0.995, "catch probability stays on its rails")
        Check.inRange(catchProbability(p, 5), 0.18, 0.995, "even an impossible disc keeps the floor")

        // Stamina: sprinting drains, standing recovers, and the pool has rails.
        let sprinter = probe(1)
        sprinter.vel = Vec3d(effectiveMaxSpeed(sprinter), 0, 0)
        let before = sprinter.energy
        tickStamina(sprinter, 1.0 / 60)
        Check.ok(sprinter.energy < before, "sprinting drains stamina")

        let rester = probe(0.5)
        rester.vel = .zero
        let restBefore = rester.energy
        tickStamina(rester, 1.0 / 60)
        Check.ok(rester.energy > restBefore, "standing still recovers stamina")

        let empty = probe(0.12)
        empty.vel = Vec3d(99, 0, 0)
        for _ in 0..<600 { tickStamina(empty, 1.0 / 60) }
        Check.ok(empty.energy >= 0.12, "stamina never falls through its floor")
        let full = probe(1)
        full.vel = .zero
        for _ in 0..<600 { tickStamina(full, 1.0 / 60) }
        Check.ok(full.energy <= 1, "stamina never rises above full")

        // boundaryRoom: a player in the middle has room; one on the line has none; a
        // degenerate direction is not a division by zero.
        Check.ok(
            boundaryRoom(0, 0, 1, 0) > boundaryRoom(17, 0, 1, 0),
            "the middle of the pitch has more room than the sideline")
        Check.ok(
            boundaryRoom(0, 0, 0, 0) > 100, "a zero direction reports effectively no limit")
        Check.ok(boundaryRoom(0, 0, -1, 0) > 0, "running away from a line still has room")
        Check.ok(
            boundaryRoom(FieldConstants.standard.sideline, 0, 1, 0) <= 0,
            "standing on the sideline, there is no room left going out")

        // Minis is a smaller pitch and must actually report less room. This is the check
        // that fails if the field is ever quietly re-globalised.
        Check.ok(
            boundaryRoom(0, 0, 1, 0, field: .minis)
                < boundaryRoom(0, 0, 1, 0, field: .standard),
            "a minis pitch really is narrower")

        // Archetypes have to differ, or the bias table is not being read. Averaged over a
        // squad, because one draw of one player proves nothing.
        func meanSpeed(_ a: Archetype) -> Double {
            let rng = Rng(seed: 31337)
            var total = 0.0
            for i in 0..<40 { total += makePlayer(i, 0, a, rng, overall: 72).attr.speed }
            return total / 40
        }
        Check.ok(
            meanSpeed(.deep) > meanSpeed(.handler),
            "deeps are faster than handlers on average")

        // The same seed must produce the same roster. This is the property that makes a
        // replay a replay.
        let a = makeAttributes(Rng(seed: 99), .cutter, overall: 72)
        let b = makeAttributes(Rng(seed: 99), .cutter, overall: 72)
        Check.bitEqViaJSON(a.speed, b.speed, "one seed, one sheet")
        Check.bitEqViaJSON(a.throwAccuracy[.hammer]!, b.throwAccuracy[.hammer]!, "and one hammer")
    }
}
