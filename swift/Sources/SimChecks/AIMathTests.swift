import Foundation
import UltimateSim

/// `AIMath` — the AI's pure functions — against their specification rather than a
/// recording of them.
///
/// # How this suite knows what is right
///
/// Every function in `AIMath` is a *stated* relationship: a rating maps linearly onto a
/// capability between two named endpoints, fatigue keeps a stated fraction of it, a
/// possession is worth a curve with a stated shape, a dive is worth it inside a stated
/// band, a ray leaves the pitch at the perimeter. None of that needs to be measured. So
/// this file asserts three kinds of thing and nothing else:
///
///  - **A law.** `boundaryRoom` returns the distance to the perimeter, so the point it
///    names is *on* the perimeter — simulate the ray forward and check. `reachShortfall`
///    is a kinematic integration, so integrating the same motion finely reproduces it.
///    `possessionValue` is a fraction of a pitch, so it agrees with itself on two pitches
///    of different sizes. These are the strongest assertions here because they cannot be
///    satisfied by any transcription of the wrong formula.
///  - **`Model`.** Where the relationship is a formula with no law behind it — a linear
///    ramp between two endpoints, a table of throw factors — the specification is
///    implemented a second time, deliberately in a different shape: endpoint
///    interpolation where `AIMath` writes base-plus-span, bilinear corners where it
///    writes a sum of terms, ordered data where it writes a sequence of statements. That
///    is what keeps a slip in one from being mirrored in the other. The endpoint form
///    and the base-plus-span form are algebraically equal and *not* bit-equal — `9.0 -
///    5.7` is not `3.3` — so those comparisons carry a tolerance, stated per section.
///  - **The dependency structure.** Every capability names exactly which ratings it reads
///    and whether fatigue touches it. That is asserted by perturbing each rating in turn,
///    which is the only check here that catches a function reading the wrong axis while
///    still producing entirely plausible numbers.
///
/// The one entry with no law at all is `makeAttributes`: **the order of its RNG draws is
/// behaviour.** Reorder a line and the same seed gives a different — but completely
/// plausible — player, and every replay in the project stops reproducing. `Model` states
/// that order as data rather than as a sequence of statements, and the suite also pins
/// the draw *count*, which is the failure that desynchronises a whole roster.
enum AIMathTests {

    // MARK: - tolerances

    /// Endpoint interpolation against base-plus-span. `lerp(5.7, 9.0, r)` and
    /// `5.7 + 3.3 * r` are the same number in exact arithmetic and differ in the last
    /// bit or two, because neither `9.0 - 5.7` nor `3.3` is the other. Every quantity
    /// compared at this tolerance is order 1–100, so this is 12+ digits of agreement.
    static let formTol = 1e-12

    // MARK: - entry point

    static func run() throws {
        capabilityCurves()
        capabilityFatigue()
        capabilityAxes()
        reachBand()
        shortfalls()
        possession()
        stakes()
        bidding()
        throwRange()
        releaseSpeed()
        flightTime()
        catching()
        stamina()
        boundaries()
        sheets()
        rosters()
    }

    // MARK: - the specification, implemented independently

    enum Model {

        /// A rating of 0…100 mapped onto `[atZero, atHundred]`.
        ///
        /// Written as an interpolation between the two endpoints the doc comments name,
        /// where `AIMath` writes the low endpoint plus a span. Same line, different
        /// parameterisation, so a wrong span here does not match a wrong span there.
        static func rated(_ atZero: Double, _ atHundred: Double, _ rating: Double) -> Double {
            let t = rating / 100
            return atZero * (1 - t) + atHundred * t
        }

        /// Fatigue as "what fraction survives an empty tank": full energy keeps all of
        /// it, empty keeps `keep`, and it is linear in between — including outside
        /// `[0, 1]`, which these functions do not clamp.
        static func fatigued(_ fresh: Double, keep: Double, _ energy: Double) -> Double {
            fresh * (keep * (1 - energy) + 1 * energy)
        }

        /// A function of two ratings, stated by its four corners rather than as a sum of
        /// independent terms. `layoutExtend` is the only one.
        static func bilinear(
            _ at00: Double, _ at10: Double, _ at01: Double, _ at11: Double,
            _ first: Double, _ second: Double
        ) -> Double {
            let a = first / 100
            let b = second / 100
            return at00 * (1 - a) * (1 - b) + at10 * a * (1 - b)
                + at01 * (1 - a) * b + at11 * a * b
        }

        static func clamped(_ v: Double, _ lo: Double, _ hi: Double) -> Double {
            v < lo ? lo : (v > hi ? hi : v)
        }

        // MARK: capability

        static func baseMaxSpeed(_ a: AIAttributes) -> Double { rated(5.7, 9.0, a.speed) }

        static func maxSpeed(_ a: AIAttributes, _ e: Double) -> Double {
            fatigued(baseMaxSpeed(a), keep: 0.80, e)
        }

        static func accel(_ a: AIAttributes, _ e: Double) -> Double {
            fatigued(rated(4.2, 9.0, a.acceleration), keep: 0.82, e)
        }

        static func decel(_ a: AIAttributes, _ e: Double) -> Double {
            fatigued(rated(6.0, 12.5, a.agility), keep: 0.85, e)
        }

        static func turnRate(_ a: AIAttributes) -> Double { rated(4.2, 9.6, a.agility) }

        static func reach(_ a: AIAttributes) -> Double { rated(2.02, 2.90, a.jumping) }

        /// Corners: no agility and no spring buys 0.85 m; full agility alone 1.80;
        /// full spring alone 1.20; both 2.15.
        static func layout(_ a: AIAttributes) -> Double {
            bilinear(0.85, 1.80, 1.20, 2.15, a.agility, a.jumping)
        }

        static func decision(_ a: AIAttributes, _ e: Double) -> Double {
            fatigued(a.decision, keep: 0.80, e)
        }

        // MARK: shortfalls

        static func arrivalShortfall(_ d: Double, _ t: Double, _ arrival: Double) -> Double {
            let usable = Swift.max(t, 1e-3)
            // "The fraction of the distance he does NOT get through", rather than
            // one minus the fraction he does.
            let missed = clamped((usable - arrival) / usable, 0, 1)
            return d * missed
        }

        /// The distance covered in `arrival` seconds, integrated in closed form from the
        /// component of velocity already pointed at the spot.
        static func reachShortfall(
            _ p: AIPlayer, _ x: Double, _ z: Double, _ arrival: Double
        ) -> Double {
            let dx = x - p.pos.x
            let dz = z - p.pos.z
            let d = Foundation.hypot(dx, dz)
            if d < 1e-6 || arrival <= 0 { return d }
            let v = Swift.max(0, (p.vel.x * dx + p.vel.z * dz) / d)
            let top = UltimateSim.effectiveMaxSpeed(p)
            let a = Swift.max(0.1, UltimateSim.effectiveAccel(p))
            let tTop = Swift.max(0, (top - v) / a)
            // Distance under the speed curve: a ramp for as long as the ramp lasts,
            // then a plateau at top speed for whatever time is left.
            let ramp = Swift.min(arrival, tTop)
            let plateau = Swift.max(0, arrival - tTop)
            let vAtRamp = v + a * ramp
            return d - ((v + vAtRamp) / 2 * ramp + top * plateau)
        }

        // MARK: valuation

        /// The curve as two straight lines: 0.82 on the attacking goal line falling to
        /// 0.40 on your own, then falling by another 0.42 across your own endzone.
        static func possessionValue(
            _ yards: Double, central: Double, endzone: Double
        ) -> Double {
            let onField = clamped(yards, 0, central) / central
            let behind = clamped((yards - central) / endzone, 0, 1)
            return 0.82 - 0.42 * onField - 0.42 * behind
        }

        static func discStakes(_ z: Double, _ dir: Dir, _ field: Playbook) -> Double {
            let ramp = 25 * field.depthScale
            let toGoal = field.yardsToGoal(z, dir)
            return clamped((ramp - toGoal) / ramp, 0, 1)
        }

        static func shouldBid(short: Double, deadline: Double, stakes: Double) -> Bool {
            let need = STANDING_REACH + BID_HESITATION * (1 - 0.60 * clamped(stakes, 0, 1))
            let inTime = deadline <= BID_LEAD
            let inBand = short > need && short < EXTENDED_REACH
            return inTime && inBand
        }

        // MARK: throws

        /// How far each throw goes as a fraction of a backhand.
        static let rangeFactor: [AIThrowType: Double] = [
            .backhand: 1.0, .forehand: 0.93, .hammer: 0.58, .scoober: 0.42, .push: 0.30,
        ]

        /// How long each throw hangs relative to a backhand of the same length: the
        /// reciprocal of how fast it crosses the ground.
        static let arriveFactor: [AIThrowType: Double] = [
            .backhand: 1.0, .forehand: 1.0, .hammer: 0.80, .scoober: 0.70, .push: 0.78,
        ]

        static func maxThrowRange(
            _ a: AIAttributes, _ e: Double, _ type: AIThrowType, _ windAlong: Double
        ) -> Double {
            let base = rated(21, 57, a.throwPower) * rangeFactor[type]!
            let wind = 1 + 0.045 * clamped(windAlong, -8, 8)
            return fatigued(base * wind, keep: 0.86, e)
        }

        /// The speed ceiling a throw of length `d` is released toward: arm speed, times
        /// the stretch a long throw earns.
        static func zip(_ a: AIAttributes, _ type: AIThrowType) -> Double {
            let armSlope = 7.5 * (type == .hammer ? 0.8 : 1)
            return 10.5 + armSlope * (a.throwPower / 100)
        }

        static func stretch(_ d: Double) -> Double {
            1 + 0.42 * Playbook.smoothstep(15, 23, d) + 0.28 * Playbook.smoothstep(23, 40, d)
        }

        /// `d / t`, where `t` is a fixed 0.28 s of wind-up plus the time the ceiling
        /// speed needs to cover the distance.
        static func releaseSpeed(_ a: AIAttributes, _ type: AIThrowType, _ d: Double) -> Double {
            d / (0.28 + d / (zip(a, type) * stretch(d)))
        }

        static func flatFlight(_ a: AIAttributes, _ type: AIThrowType, _ d: Double) -> Double {
            0.28 + d / (rated(11.0, 19.6, a.throwPower) * arriveFactor[type]!)
        }

        static func flightTime(_ a: AIAttributes, _ type: AIThrowType, _ d: Double) -> Double {
            let flat = flatFlight(a, type, d)
            return d >= ThrowSolver.loftRange ? flat * loftFlight : flat
        }

        // MARK: catching

        static func catchProbability(
            _ a: AIAttributes, _ e: Double, _ difficulty: Double
        ) -> Double {
            let hands = a.catching / 100
            let best = rated(0.952, 0.997, a.catching)
            let awake = fatigued(1.0, keep: 0.96, e)
            // A perfect pair of hands still pays 55% of the difficulty penalty.
            let exposure = 1 - 0.45 * hands
            let penalty = catchSlope * exposure * clamped(difficulty, 0, 1.8)
            return clamped(best * awake - penalty, 0.18, 0.995)
        }

        // MARK: stamina

        static func drain(_ a: AIAttributes, load: Double, dt: Double) -> Double {
            -dt * 0.017 * load * load / endurance(a)
        }

        static func recover(_ a: AIAttributes, load: Double, dt: Double) -> Double {
            dt * 0.034 * endurance(a) * (1 - load)
        }

        static func endurance(_ a: AIAttributes) -> Double { rated(0.35, 1.0, a.stamina) }

        static func tickStamina(_ p: AIPlayer, _ dt: Double) {
            let vmax = Swift.max(1e-3, UltimateSim.effectiveMaxSpeed(p))
            let load = clamped(Foundation.hypot(p.vel.x, p.vel.z) / vmax, 0, 1.2)
            let delta = load > 0.42
                ? drain(p.attr, load: load, dt: dt)
                : recover(p.attr, load: load, dt: dt)
            p.energy = clamped(p.energy + delta, 0.12, 1)
        }

        // MARK: geometry

        /// Distance along a ray to the inset rectangle, as a slab intersection written
        /// with the rectangle's two half-widths rather than four signed branches.
        static func boundaryRoom(
            _ px: Double, _ pz: Double, _ dx: Double, _ dz: Double, _ field: FieldConstants
        ) -> Double {
            let l = Foundation.hypot(dx, dz)
            if l < 1e-5 { return 1e3 }
            let ux = dx / l
            let uz = dz / l
            let bx = field.sideline - boundaryRoomMargin
            let bz = field.endLine - boundaryRoomMargin
            var t = 1e3
            // For each axis: the wall this component is heading toward is the one whose
            // sign matches the component's.
            if abs(ux) > 1e-6 { t = Swift.min(t, ((ux > 0 ? bx : -bx) - px) / ux) }
            if abs(uz) > 1e-6 { t = Swift.min(t, ((uz > 0 ? bz : -bz) - pz) / uz) }
            return Swift.max(0, t)
        }

        // MARK: attribute generation

        /// The per-archetype rating bias, transcribed from the specification.
        static let bias: [Archetype: [String: Double]] = [
            .handler: [
                "speed": -6, "acceleration": 2, "agility": 8, "throwPower": 10,
                "decision": 12, "catching": 6, "jumping": -6,
            ],
            .cutter: [
                "speed": 6, "acceleration": 6, "agility": 4, "catching": 4,
                "throwPower": -6, "decision": -2,
            ],
            .deep: [
                "speed": 12, "acceleration": 4, "jumping": 12, "catching": 2,
                "throwPower": -10, "decision": -6, "agility": -2,
            ],
            .utility: ["speed": 2, "agility": 2, "defAwareness": 6, "stamina": 6],
        ]

        /// Throwing hand bonus applied to every accuracy: a handler throws for a living,
        /// a deep does not.
        static let handBonus: [Archetype: Double] = [.handler: 8, .deep: -10]

        /// **The draw order, as data.**
        ///
        /// `makeAttributes` spells this as a sequence of `let` statements, and the
        /// sequence is the behaviour. Stating it as three ordered tables instead means a
        /// line moved there does not move a line here: throw power is drawn first, then
        /// the five athletic ratings, then the five accuracies in throw order, then the
        /// three head ratings.
        static let powerDraw = (key: "throwPower", spread: 8.0)
        static let athleticDraws: [(key: String, spread: Double)] = [
            ("speed", 9), ("acceleration", 9), ("agility", 9), ("jumping", 9),
            ("catching", 7),
        ]
        static let accuracyDraws: [(type: AIThrowType, penalty: Double)] = [
            (.backhand, 0), (.forehand, 6), (.hammer, 20), (.scoober, 26), (.push, 2),
        ]
        static let headDraws: [(key: String, spread: Double)] = [
            ("decision", 10), ("stamina", 9), ("defAwareness", 10),
        ]

        /// Fourteen gaussian draws per sheet, one uniform draw per player after it.
        static let gaussDrawsPerSheet = 14

        static func attributes(
            _ rng: Rng, _ archetype: Archetype, _ overall: Double
        ) -> AIAttributes {
            let b = bias[archetype] ?? [:]
            func roll(_ key: String, _ spread: Double) -> Double {
                clamped(overall + (b[key] ?? 0) + rng.gauss() * spread, 28, 99)
            }
            let bonus = handBonus[archetype] ?? 0
            func acc(_ penalty: Double) -> Double {
                clamped(overall + bonus - penalty + rng.gauss() * 8, 25, 99)
            }

            let power = roll(powerDraw.key, powerDraw.spread)
            var athletic: [String: Double] = [:]
            for d in athleticDraws { athletic[d.key] = roll(d.key, d.spread) }
            var accuracy: [AIThrowType: Double] = [:]
            for d in accuracyDraws { accuracy[d.type] = acc(d.penalty) }
            var head: [String: Double] = [:]
            for d in headDraws { head[d.key] = roll(d.key, d.spread) }

            return AIAttributes(
                speed: athletic["speed"]!,
                acceleration: athletic["acceleration"]!,
                agility: athletic["agility"]!,
                jumping: athletic["jumping"]!,
                catching: athletic["catching"]!,
                throwAccuracy: accuracy,
                throwPower: power,
                decision: head["decision"]!,
                stamina: head["stamina"]!,
                defAwareness: head["defAwareness"]!)
        }
    }

    // MARK: - helpers

    /// A sheet with every rating the same, so a capability's single input is unambiguous.
    static func flat(_ rating: Double) -> AIAttributes {
        AIAttributes(
            speed: rating, acceleration: rating, agility: rating, jumping: rating,
            catching: rating,
            throwAccuracy: [.backhand: rating, .forehand: rating, .hammer: rating,
                            .scoober: rating, .push: rating],
            throwPower: rating, decision: rating, stamina: rating, defAwareness: rating)
    }

    /// A sheet whose ratings are all different, so a function reading the wrong one
    /// produces a different number rather than the same one.
    static let distinct = AIAttributes(
        speed: 71, acceleration: 43, agility: 88, jumping: 34, catching: 62,
        throwAccuracy: [.backhand: 55, .forehand: 50, .hammer: 40, .scoober: 35, .push: 60],
        throwPower: 79, decision: 66, stamina: 51, defAwareness: 47)

    static func player(_ attr: AIAttributes, energy: Double = 1) -> AIPlayer {
        AIPlayer(id: 0, team: 0, attr: attr, archetype: .cutter, energy: energy)
    }

    static let ratingKeys = [
        "speed", "acceleration", "agility", "jumping", "catching", "throwPower",
        "decision", "stamina", "defAwareness",
    ]

    static func rating(_ a: AIAttributes, _ key: String) -> Double {
        switch key {
        case "speed": return a.speed
        case "acceleration": return a.acceleration
        case "agility": return a.agility
        case "jumping": return a.jumping
        case "catching": return a.catching
        case "throwPower": return a.throwPower
        case "decision": return a.decision
        case "stamina": return a.stamina
        default: return a.defAwareness
        }
    }

    static func setting(_ a: AIAttributes, _ key: String, _ v: Double) -> AIAttributes {
        var out = a
        switch key {
        case "speed": out.speed = v
        case "acceleration": out.acceleration = v
        case "agility": out.agility = v
        case "jumping": out.jumping = v
        case "catching": out.catching = v
        case "throwPower": out.throwPower = v
        case "decision": out.decision = v
        case "stamina": out.stamina = v
        default: out.defAwareness = v
        }
        return out
    }

    /// The rating sweep every capability is checked over: both ends and everything in
    /// between, at one-point resolution.
    static let ratings: [Double] = (0...100).map(Double.init)

    /// Energies including two outside `[0, 1]`. These functions deliberately do not clamp
    /// energy — `tickStamina` owns the pool's rails — so the ramp continues past both
    /// ends, and that is asserted rather than avoided.
    static let energies: [Double] = [-0.5, 0, 0.12, 0.25, 0.5, 0.75, 1, 1.5]

    // MARK: - capability: the ramps

    /// Each capability is a straight line from a rating of 0 to a rating of 100. Asserted
    /// against `Model`'s endpoint form across the whole rating range, and at both
    /// endpoints against the numbers the doc comments name.
    private static func capabilityCurves() {
        for r in ratings {
            let a = flat(r)
            Check.near(baseMaxSpeed(a), Model.baseMaxSpeed(a), formTol, "baseMaxSpeed(\(r))")
            Check.near(turnRateOf(player(a)), Model.turnRate(a), formTol, "turnRateOf(\(r))")
            Check.near(reachHeight(player(a)), Model.reach(a), formTol, "reachHeight(\(r))")
            Check.near(layoutExtend(player(a)), Model.layout(a), formTol, "layoutExtend(\(r))")

            for e in energies {
                let p = player(a, energy: e)
                let at = "(rating \(r), energy \(e))"
                Check.near(effectiveMaxSpeed(p), Model.maxSpeed(a, e), formTol, "maxSpeed\(at)")
                Check.near(effectiveAccel(p), Model.accel(a, e), formTol, "accel\(at)")
                Check.near(effectiveDecel(p), Model.decel(a, e), formTol, "decel\(at)")
                Check.near(effectiveDecision(p), Model.decision(a, e), formTol, "decision\(at)")
            }
        }

        // The endpoints, named. A rating of zero is the floor of the band and a hundred
        // is its ceiling; these six numbers are the specification of what a rating means.
        let zero = flat(0)
        let full = flat(100)
        Check.near(baseMaxSpeed(zero), 5.7, formTol, "a speed of 0 sprints at 5.7 m/s")
        Check.near(baseMaxSpeed(full), 9.0, formTol, "a speed of 100 sprints at 9.0 m/s")
        Check.near(effectiveAccel(player(zero)), 4.2, formTol, "0 acceleration is 4.2 m/s²")
        Check.near(effectiveAccel(player(full)), 9.0, formTol, "100 acceleration is 9.0 m/s²")
        Check.near(effectiveDecel(player(zero)), 6.0, formTol, "0 agility brakes at 6.0 m/s²")
        Check.near(effectiveDecel(player(full)), 12.5, formTol, "100 agility brakes at 12.5 m/s²")
        Check.near(turnRateOf(player(zero)), 4.2, formTol, "0 agility turns at 4.2 rad/s")
        Check.near(turnRateOf(player(full)), 9.6, formTol, "100 agility turns at 9.6 rad/s")
        Check.near(reachHeight(player(zero)), 2.02, formTol, "a 0 leap reaches 2.02 m")
        Check.near(reachHeight(player(full)), 2.90, formTol, "a 100 leap reaches 2.90 m")

        // Every ramp climbs. A rating is worth having, in every one of them.
        for i in 1..<ratings.count {
            let lo = flat(ratings[i - 1])
            let hi = flat(ratings[i])
            Check.ok(baseMaxSpeed(hi) > baseMaxSpeed(lo), "speed \(ratings[i]) sprints faster")
            Check.ok(
                effectiveAccel(player(hi)) > effectiveAccel(player(lo)),
                "acceleration \(ratings[i]) accelerates harder")
            Check.ok(
                effectiveDecel(player(hi)) > effectiveDecel(player(lo)),
                "agility \(ratings[i]) brakes harder")
            Check.ok(
                turnRateOf(player(hi)) > turnRateOf(player(lo)),
                "agility \(ratings[i]) turns faster")
            Check.ok(
                reachHeight(player(hi)) > reachHeight(player(lo)),
                "jumping \(ratings[i]) reaches higher")
            Check.ok(
                layoutExtend(player(hi)) > layoutExtend(player(lo)),
                "athleticism \(ratings[i]) extends further")
        }

        // Straight lines, not curves: equal steps in rating are equal steps in output.
        // A quadratic or a re-associated expression that still hits both endpoints fails
        // here, and passes every endpoint check above.
        for r in stride(from: 1.0, through: 99.0, by: 1.0) {
            let mid = baseMaxSpeed(flat(r))
            let straddle = (baseMaxSpeed(flat(r - 1)) + baseMaxSpeed(flat(r + 1))) / 2
            Check.near(mid, straddle, 1e-13, "baseMaxSpeed is linear at \(r)")
            let turn = turnRateOf(player(flat(r)))
            let turnStraddle =
                (turnRateOf(player(flat(r - 1))) + turnRateOf(player(flat(r + 1)))) / 2
            Check.near(turn, turnStraddle, 1e-13, "turnRateOf is linear at \(r)")
        }
    }

    // MARK: - capability: what fatigue costs

    /// "Fatigue costs a fifth of top speed at empty. The floors differ per quantity on
    /// purpose — you lose more of your acceleration than your top speed when tired, and
    /// more of your top speed than your braking."
    ///
    /// Asserted as ratios of the empty tank to the full one, which is the claim itself
    /// and is independent of every rating: swap two of the four floors and the table
    /// sweep above still passes on any single quantity read in isolation, but this does
    /// not.
    private static func capabilityFatigue() {
        for r in stride(from: 10.0, through: 100.0, by: 10.0) {
            let a = flat(r)
            let fresh = player(a, energy: 1)
            let empty = player(a, energy: 0)
            let at = "rating \(r)"
            Check.near(
                effectiveMaxSpeed(empty) / effectiveMaxSpeed(fresh), 0.80, 1e-14,
                "\(at): an empty tank keeps 80% of top speed")
            Check.near(
                effectiveAccel(empty) / effectiveAccel(fresh), 0.82, 1e-14,
                "\(at): an empty tank keeps 82% of acceleration")
            Check.near(
                effectiveDecel(empty) / effectiveDecel(fresh), 0.85, 1e-14,
                "\(at): an empty tank keeps 85% of braking")
            Check.near(
                effectiveDecision(empty) / effectiveDecision(fresh), 0.80, 1e-14,
                "\(at): an empty tank keeps 80% of decision making")

            // "A tired player is slower, not clumsier": turn rate is the one capability
            // fatigue does not touch, at all, bit for bit.
            for e in energies {
                Check.bitEq(
                    turnRateOf(player(a, energy: e)), turnRateOf(fresh),
                    "\(at): energy \(e) does not change turn rate")
                Check.bitEq(
                    reachHeight(player(a, energy: e)), reachHeight(fresh),
                    "\(at): energy \(e) does not change standing reach")
                Check.bitEq(
                    layoutExtend(player(a, energy: e)), layoutExtend(fresh),
                    "\(at): energy \(e) does not change layout extension")
            }

            // At full energy nothing is lost — the fatigue term is exactly 1.
            Check.near(
                effectiveMaxSpeed(fresh), baseMaxSpeed(a), 1e-14,
                "\(at): a full tank runs at base top speed")

            // The ramp is linear in energy and is not clamped at either end: half a tank
            // is halfway between empty and full, and 1.5 tanks continues the same line.
            let half = player(a, energy: 0.5)
            Check.near(
                effectiveMaxSpeed(half),
                (effectiveMaxSpeed(empty) + effectiveMaxSpeed(fresh)) / 2, 1e-13,
                "\(at): half a tank is halfway")
            let over = player(a, energy: 1.5)
            Check.near(
                effectiveMaxSpeed(over),
                effectiveMaxSpeed(fresh) + (effectiveMaxSpeed(fresh) - effectiveMaxSpeed(half)),
                1e-13,
                "\(at): energy is not clamped — the ramp continues past full")
        }
    }

    // MARK: - capability: which rating each one reads

    /// Every capability declares the ratings it depends on, and the declaration is
    /// checked by moving each rating in turn.
    ///
    /// This is the check for a function reading the wrong axis. `turnRateOf` built from
    /// `speed` instead of `agility` still returns a plausible turn rate, still climbs
    /// with the rating, still ignores energy, and still passes every sweep above when the
    /// whole sheet is flat. It does not pass this.
    private static func capabilityAxes() {
        struct Curve {
            let name: String
            let reads: Set<String>
            let fatigues: Bool
            let eval: (AIAttributes, Double) -> Double
        }

        let curves: [Curve] = [
            Curve(name: "baseMaxSpeed", reads: ["speed"], fatigues: false) { a, _ in
                baseMaxSpeed(a)
            },
            Curve(name: "effectiveMaxSpeed", reads: ["speed"], fatigues: true) { a, e in
                effectiveMaxSpeed(player(a, energy: e))
            },
            Curve(name: "effectiveAccel", reads: ["acceleration"], fatigues: true) { a, e in
                effectiveAccel(player(a, energy: e))
            },
            Curve(name: "effectiveDecel", reads: ["agility"], fatigues: true) { a, e in
                effectiveDecel(player(a, energy: e))
            },
            Curve(name: "turnRateOf", reads: ["agility"], fatigues: false) { a, e in
                turnRateOf(player(a, energy: e))
            },
            Curve(name: "reachHeight", reads: ["jumping"], fatigues: false) { a, e in
                reachHeight(player(a, energy: e))
            },
            Curve(name: "layoutExtend", reads: ["agility", "jumping"], fatigues: false) { a, e in
                layoutExtend(player(a, energy: e))
            },
            Curve(name: "effectiveDecision", reads: ["decision"], fatigues: true) { a, e in
                effectiveDecision(player(a, energy: e))
            },
            Curve(name: "maxThrowRange", reads: ["throwPower"], fatigues: true) { a, e in
                maxThrowRange(player(a, energy: e), .backhand, 3)
            },
            Curve(name: "throwReleaseSpeed", reads: ["throwPower"], fatigues: false) { a, e in
                throwReleaseSpeed(player(a, energy: e), .backhand, 30)
            },
            Curve(name: "throwFlightTime", reads: ["throwPower"], fatigues: false) { a, e in
                throwFlightTime(player(a, energy: e), .backhand, 30)
            },
            Curve(name: "catchProbability", reads: ["catching"], fatigues: true) { a, e in
                catchProbability(player(a, energy: e), 1.0)
            },
        ]

        for c in curves {
            let base = c.eval(distinct, 0.7)
            for key in ratingKeys {
                let moved = c.eval(setting(distinct, key, rating(distinct, key) + 17), 0.7)
                if c.reads.contains(key) {
                    Check.ok(moved != base, "\(c.name) reads \(key)")
                } else {
                    Check.bitEq(moved, base, "\(c.name) does not read \(key)")
                }
            }
            let tired = c.eval(distinct, 0.2)
            if c.fatigues {
                Check.ok(tired != base, "\(c.name) is affected by fatigue")
                Check.ok(tired < base, "\(c.name) is worse when tired")
            } else {
                Check.bitEq(tired, base, "\(c.name) is not affected by fatigue")
            }
        }
    }

    // MARK: - the reach band

    /// The band a layout is decided in, and the one claim the module makes about it in
    /// prose: a dive converts a fixed amount of reach and nothing else.
    private static func reachBand() {
        // Bound to the rules engine's own radii rather than re-quoted, so the AI cannot
        // believe in a reach the rules will not pay out.
        Check.bitEq(
            STANDING_REACH, CatchDecision.catchReach,
            "the AI's standing reach is the rules engine's catch radius")
        Check.bitEq(
            EXTENDED_REACH, CatchDecision.layoutReach,
            "the AI's extended reach is the rules engine's layout radius")

        // "A dive converts exactly 0.73 m of reach." Asserted to a tolerance rather than
        // bit for bit: `1.55 - 0.82` is 0.7300000000000001 because neither operand is
        // representable, and the claim is about the sport rather than about a bit
        // pattern.
        Check.near(
            EXTENDED_REACH - STANDING_REACH, 0.73, 1e-15,
            "a dive converts 0.73 m of reach")
        Check.ok(EXTENDED_REACH > STANDING_REACH, "a dive reaches further than standing")

        // The rendezvous band sits above the height the rules pay a standing catch out
        // at, and below the height a body can still be reaching at. `CatchBandTests` owns
        // the identities against the rules; what belongs here is that the band is a band.
        Check.ok(CATCH_DEAD < CATCH_FLOOR, "the disc dies below the band it is met in")
        Check.ok(CATCH_FLOOR < CATCH_CEILING, "the rendezvous band is not inverted")
        Check.ok(
            CATCH_FLOOR < AIM_HEIGHT && AIM_HEIGHT <= CATCH_CEILING,
            "the height a throw is asked for sits inside the band it will be met in")
        Check.ok(
            AIM_HEIGHT > handHeight,
            "and above the hand it leaves, which is why no flat throw can meet it")
        Check.ok(
            LAYOUT_CEILING < CATCH_CEILING,
            "a disc arriving at the top of the band is a jump, not a dive")
        Check.ok(
            LAYOUT_CEILING > handHeight * 0.9 && LAYOUT_CEILING < 1.4,
            "a prone body's reach ceiling is a little over a metre")
        Check.ok(BID_LEAD > 0 && BID_HESITATION > 0, "a dive takes time and costs conviction")
        Check.ok(loftFlight > 1, "a lofted huck hangs longer than the line drive")
        Check.ok(loftArc > 0, "a lofted huck peaks above the release line")
        Check.ok(
            handHeight > CATCH_DEAD && handHeight < CATCH_CEILING,
            "the disc leaves a standing hand inside the band it will be caught in")
    }

    // MARK: - shortfall

    /// The two "how far short is he" models, against their definitions and against a
    /// forward simulation.
    private static func shortfalls() {
        // `arrivalShortfall` splits a distance by the fraction of the needed time he has.
        for d in [0.0, 0.5, 2, 7.5, 30] {
            for t in [0.0, 1e-4, 0.05, 0.5, 1, 4] {
                for arrival in [-1.0, 0, 0.01, 0.25, 0.5, 1, 3, 10] {
                    let at = "arrivalShortfall(d \(d), t \(t), arrival \(arrival))"
                    let got = arrivalShortfall(d, t, arrival)
                    Check.near(got, Model.arrivalShortfall(d, t, arrival), 1e-14, at)
                    Check.inRange(got, 0, Swift.max(d, 0), "\(at) stays between nothing and all of it")
                }
            }
            // Given exactly the time he needs, he is not short at all; given none of it,
            // he is short the whole distance; given half, half.
            Check.near(arrivalShortfall(d, 2, 2), 0, 0, "given the time he needs, d \(d) is met")
            Check.near(arrivalShortfall(d, 2, 4), 0, 0, "given twice the time, d \(d) is met")
            Check.near(arrivalShortfall(d, 2, 0), d, 0, "given no time, d \(d) is all short")
            Check.near(arrivalShortfall(d, 2, 1), d / 2, 1e-15, "given half the time, half of \(d)")
        }

        // `reachShortfall` is kinematics: the distance he has left after `arrival`
        // seconds of accelerating from the speed he already carries toward the spot.
        //
        // The law, not the formula: integrate the same motion in ten thousand steps and
        // the distance covered has to match. A re-associated closed form, a dropped
        // half, or a plateau that never starts all fail this and none of them fail an
        // algebraic restatement of the same expression.
        let rng = Rng(seed: 0x1CE_B00D)
        for i in 0..<300 {
            let a = flat(rng.range(20, 99))
            let p = player(a, energy: rng.range(0.2, 1))
            p.pos = Vec3d(rng.range(-15, 15), 0, rng.range(-40, 40))
            let target = Vec3d(rng.range(-15, 15), 0, rng.range(-40, 40))
            p.vel = Vec3d(rng.range(-9, 9), 0, rng.range(-9, 9))
            let arrival = rng.range(0.02, 3)

            let got = reachShortfall(p, target.x, target.z, arrival)
            Check.near(
                got, Model.reachShortfall(p, target.x, target.z, arrival), 1e-12,
                "reachShortfall matches the closed form, case \(i)")

            let dx = target.x - p.pos.x
            let dz = target.z - p.pos.z
            let d = Foundation.hypot(dx, dz)
            if d < 1e-3 { continue }
            let top = effectiveMaxSpeed(p)
            let accel = Swift.max(0.1, effectiveAccel(p))
            // He cannot run faster than his own top speed, however fast he was going
            // when the deadline was set.
            var v = Swift.min(top, Swift.max(0, (p.vel.x * dx + p.vel.z * dz) / d))
            var covered = 0.0
            let steps = 10_000
            let h = arrival / Double(steps)
            for _ in 0..<steps {
                // Trapezoid on the speed curve, which is exact for a straight ramp and
                // for a plateau, and correct to O(h²) across the corner between them.
                let vNext = Swift.min(top, v + accel * h)
                covered += (v + vNext) / 2 * h
                v = vNext
            }
            Check.near(
                d - got, covered, 1e-4,
                "reachShortfall is the distance a forward simulation covers, case \(i)")
        }

        // A player already at top speed covers exactly `top * arrival` — the ramp is
        // empty, so this is the one case with a closed form simple enough to write down.
        let sprinter = player(distinct, energy: 0.8)
        sprinter.pos = .zero
        let top = effectiveMaxSpeed(sprinter)
        sprinter.vel = Vec3d(top, 0, 0)
        for arrival in [0.1, 0.45, 1.0, 2.5] {
            Check.near(
                reachShortfall(sprinter, 40, 0, arrival), 40 - top * arrival, 1e-12,
                "at top speed he covers exactly top × \(arrival)")
        }

        // Only the component of velocity pointed at the spot counts, and a player running
        // away covers nothing from it rather than losing ground.
        let base = player(distinct, energy: 0.8)
        base.pos = .zero
        base.vel = .zero
        let still = reachShortfall(base, 10, 0, 0.5)
        let away = player(distinct, energy: 0.8)
        away.pos = .zero
        away.vel = Vec3d(-7, 0, 0)
        Check.bitEq(
            reachShortfall(away, 10, 0, 0.5), still,
            "running away from the spot counts as standing still, not as losing ground")
        let sideways = player(distinct, energy: 0.8)
        sideways.pos = .zero
        sideways.vel = Vec3d(0, 0, 8)
        Check.near(
            reachShortfall(sideways, 10, 0, 0.5), still, 1e-12,
            "velocity across the line of the run counts for nothing")
        let toward = player(distinct, energy: 0.8)
        toward.pos = .zero
        toward.vel = Vec3d(5, 0, 6)
        let alongOnly = player(distinct, energy: 0.8)
        alongOnly.pos = .zero
        alongOnly.vel = Vec3d(5, 0, 0)
        Check.near(
            reachShortfall(toward, 10, 0, 0.5), reachShortfall(alongOnly, 10, 0, 0.5), 1e-12,
            "only the projection onto the line of the run is credited")

        // Degenerate arguments. Standing on the spot is not short of it; no time at all
        // leaves him short the whole way; and a player whose energy has been driven out
        // of range still returns a number rather than a NaN, because the acceleration
        // floor holds.
        let onIt = player(distinct)
        onIt.pos = Vec3d(3, 0, 4)
        Check.near(reachShortfall(onIt, 3, 4, 1), 0, 0, "standing on the spot is not short of it")
        let noTime = player(distinct)
        noTime.pos = .zero
        Check.near(
            reachShortfall(noTime, 3, 4, 0), 5, 1e-15, "with no time he is the whole way short")
        Check.near(
            reachShortfall(noTime, 3, 4, -1), 5, 1e-15,
            "a deadline already past is the whole way short")
        let broken = player(distinct, energy: -10)
        broken.pos = .zero
        Check.ok(
            reachShortfall(broken, 10, 0, 0.5).isFinite,
            "the acceleration floor keeps a nonsense energy from producing a NaN")

        // More time is never worse.
        let runner = player(distinct, energy: 0.6)
        runner.pos = .zero
        runner.vel = Vec3d(2, 0, 0)
        var previous = Double.infinity
        for arrival in stride(from: 0.05, through: 3.0, by: 0.05) {
            let s = reachShortfall(runner, 12, 0, arrival)
            Check.ok(s < previous, "more time is less shortfall at \(arrival)")
            previous = s
        }
    }

    // MARK: - possession value

    /// `possessionValue` on the regulation pitch. Kept as a named entry point because
    /// `TeamAITests` prices its own options through it.
    static func regulationPV(_ yards: Double) -> Double {
        possessionValue(
            yards,
            central: FieldConstants.standard.centralLength,
            endzone: FieldConstants.standard.endzoneDepth)
    }

    private static func possession() {
        let pitches: [(String, FieldConstants)] = [
            ("standard", .standard), ("minis", .minis),
        ]

        for (name, f) in pitches {
            func pv(_ y: Double) -> Double {
                possessionValue(y, central: f.centralLength, endzone: f.endzoneDepth)
            }
            let span = f.centralLength + f.endzoneDepth

            for y in stride(from: -20.0, through: span + 20, by: 0.5) {
                let at = "\(name) possessionValue(\(y))"
                Check.near(
                    pv(y),
                    Model.possessionValue(y, central: f.centralLength, endzone: f.endzoneDepth),
                    1e-15, at)
            }

            // The three corners of the curve, named. Standing on the line you are
            // attacking is worth 0.82; standing on your own is worth 0.40; the back of
            // your own endzone is worth 0.42 less again, which is below zero — a
            // turnover there is a goal against.
            Check.near(pv(0), 0.82, 1e-15, "\(name): on the attacking goal line, 0.82")
            Check.near(pv(f.centralLength), 0.40, 1e-15, "\(name): on your own goal line, 0.40")
            Check.near(
                pv(span), 0.40 - 0.42, 1e-15,
                "\(name): the back of your own endzone is a full disc worse")
            Check.ok(pv(span) < 0, "\(name): deep in your own endzone is worth less than nothing")

            // Both rails. Past the attacking goal line the disc is in the endzone and the
            // curve stops; past the back line there is no more field to lose.
            for y in [-40.0, -10, -1e-9] {
                Check.bitEq(pv(y), pv(0), "\(name): the curve is flat past the goal line (\(y))")
            }
            for y in [span + 1, span + 30, 1e6] {
                Check.bitEq(pv(y), pv(span), "\(name): the curve bottoms out past the end line (\(y))")
            }

            // Never increasing, anywhere. Every metre backwards costs something or costs
            // nothing; none of them pays.
            var previous = pv(-30)
            for y in stride(from: -30.0, through: span + 30, by: 0.25) {
                let v = pv(y)
                Check.ok(v <= previous, "\(name): field position never improves going backwards at \(y)")
                previous = v
            }

            // Two straight segments, and the second is steeper per metre than the first
            // whenever the endzone is shorter than the field — which it is on both
            // pitches. That steepening is the whole reason the second term exists.
            let onFieldSlope = (pv(0) - pv(f.centralLength)) / f.centralLength
            let behindSlope = (pv(f.centralLength) - pv(span)) / f.endzoneDepth
            Check.ok(
                behindSlope > onFieldSlope,
                "\(name): ground given up inside your own endzone costs more per metre")
        }

        // **The curve is a fraction of the pitch, not a count of metres.** The same
        // relative position on two pitches of very different sizes is worth the same, and
        // that is the property that stopped the whole minis field being priced inside the
        // flat top of a regulation curve.
        let s = FieldConstants.standard
        let m = FieldConstants.minis
        for fraction in stride(from: 0.0, through: 1.0, by: 0.02) {
            let onStandard = possessionValue(
                fraction * s.centralLength, central: s.centralLength, endzone: s.endzoneDepth)
            let onMinis = possessionValue(
                fraction * m.centralLength, central: m.centralLength, endzone: m.endzoneDepth)
            Check.near(
                onMinis, onStandard, 1e-15,
                "the same fraction of the field is worth the same on both pitches (\(fraction))")

            let deepStandard = possessionValue(
                s.centralLength + fraction * s.endzoneDepth,
                central: s.centralLength, endzone: s.endzoneDepth)
            let deepMinis = possessionValue(
                m.centralLength + fraction * m.endzoneDepth,
                central: m.centralLength, endzone: m.endzoneDepth)
            Check.near(
                deepMinis, deepStandard, 1e-15,
                "and so is the same depth into your own endzone (\(fraction))")
        }
    }

    // MARK: - stakes

    private static func stakes() {
        let pitches: [(String, Playbook)] = [
            ("standard", Playbook(field: .standard)), ("minis", Playbook(field: .minis)),
        ]

        for (name, book) in pitches {
            let ramp = 25 * book.depthScale
            for z in stride(from: -60.0, through: 60.0, by: 0.5) {
                for dir in [1, -1] as [Dir] {
                    let got = discStakes(z, dir, field: book)
                    Check.near(
                        got, Model.discStakes(z, dir, book), 1e-15,
                        "\(name) discStakes(\(z), \(dir))")
                    Check.inRange(got, 0, 1, "\(name) discStakes(\(z), \(dir)) is a fraction")

                    // "Symmetric on purpose: the defender covering that endzone reads
                    // exactly the same stakes the receiver does." Reflecting the pitch
                    // and the attack direction together must leave the number alone.
                    Check.bitEq(
                        discStakes(-z, -dir, field: book), got,
                        "\(name): the stakes are the same from both ends (\(z), \(dir))")
                }
            }

            // Which way it points. The goal line you are attacking is everything at
            // stake; the one you are defending is nothing.
            let goal = book.field.goalLine
            Check.near(
                discStakes(goal, 1, field: book), 1, 0,
                "\(name): on the line you attack, everything is at stake")
            Check.near(
                discStakes(-goal, 1, field: book), 0, 0,
                "\(name): on the line you defend, nothing is")
            Check.near(
                discStakes(goal + 20, 1, field: book), 1, 0,
                "\(name): inside the endzone it stays at everything")

            // The ramp is exactly `ramp` metres of field long, and it is linear over it.
            Check.near(
                discStakes(goal - ramp, 1, field: book), 0, 1e-15,
                "\(name): the ramp starts \(ramp) m out")
            Check.near(
                discStakes(goal - ramp / 2, 1, field: book), 0.5, 1e-15,
                "\(name): and is half-way at half of it")

            // Getting closer never lowers the stakes.
            var previous = -1.0
            for z in stride(from: -goal - 10, through: goal + 10, by: 0.25) {
                let v = discStakes(z, 1, field: book)
                Check.ok(v >= previous, "\(name): stakes never fall as the goal nears at \(z)")
                previous = v
            }
        }

        // **The ramp scales with the pitch.** A quarter of the way up a minis field is
        // worth the same stakes as a quarter of the way up a regulation one; a bare
        // regulation 25 would price the whole minis pitch above a quarter.
        let standard = Playbook(field: .standard)
        let minis = Playbook(field: .minis)
        for fraction in stride(from: -1.0, through: 1.0, by: 0.05) {
            Check.near(
                discStakes(fraction * minis.field.goalLine, 1, field: minis),
                discStakes(fraction * standard.field.goalLine, 1, field: standard), 1e-15,
                "the same fraction of the pitch reads the same stakes (\(fraction))")
        }
    }

    // MARK: - bidding

    /// "Three things have to be true at once: they cannot reach it standing, the dive
    /// does reach it, and the last chance falls inside the time the dive is airborne."
    private static func bidding() {
        let shorts = stride(from: 0.0, through: 2.4, by: 0.02).map { $0 }
        let deadlines: [Double] = [-1, 0, 0.1, 0.3, 0.44, 0.45, 0.4500000000000001, 0.5, 1, 4]
        let stakeValues: [Double] = [-2, -0.001, 0, 0.25, 0.5, 0.75, 1, 1.001, 5]

        let anyone = player(distinct, energy: 0.4)
        for short in shorts {
            for deadline in deadlines {
                for stake in stakeValues {
                    Check.eq(
                        shouldBid(anyone, short: short, deadline: deadline, stakes: stake),
                        Model.shouldBid(short: short, deadline: deadline, stakes: stake),
                        "shouldBid(short \(short), deadline \(deadline), stakes \(stake))")
                }
            }
        }

        // The band, at both edges. Inside standing reach you run it down; past the
        // extension you do not reach it lying down either.
        for stake in stakeValues {
            let need = STANDING_REACH + BID_HESITATION * (1 - 0.60 * clamp(stake, 0, 1))
            Check.ok(
                !shouldBid(anyone, short: need, deadline: 0.2, stakes: stake),
                "at exactly the threshold there is no bid (stakes \(stake))")
            Check.ok(
                shouldBid(anyone, short: need + 1e-9, deadline: 0.2, stakes: stake),
                "a hair past it there is (stakes \(stake))")
            Check.ok(
                !shouldBid(anyone, short: EXTENDED_REACH, deadline: 0.2, stakes: stake),
                "at exactly the extension there is no bid (stakes \(stake))")
            Check.ok(
                shouldBid(anyone, short: EXTENDED_REACH - 1e-9, deadline: 0.2, stakes: stake),
                "a hair inside it there is (stakes \(stake))")
            Check.ok(
                !shouldBid(anyone, short: STANDING_REACH, deadline: 0.2, stakes: stake),
                "you never dive for a disc you can reach standing (stakes \(stake))")
        }

        // The deadline is inclusive at `BID_LEAD` and excludes anything later. "Bidding
        // earlier than this is not a bid, it is a belly-flop with a good view."
        Check.ok(
            shouldBid(anyone, short: 1.2, deadline: BID_LEAD, stakes: 1),
            "a dive exactly one dive-length before the last chance is a bid")
        Check.ok(
            !shouldBid(anyone, short: 1.2, deadline: BID_LEAD.nextUp, stakes: 1),
            "one ulp earlier is not")

        // NaN rejects. The comparison is spelled as a negation for exactly this reason —
        // a deadline that is not a number is not a deadline you can dive at.
        Check.ok(
            !shouldBid(anyone, short: 1.2, deadline: .nan, stakes: 1),
            "a NaN deadline is refused rather than accepted")
        Check.ok(
            !shouldBid(anyone, short: .nan, deadline: 0.2, stakes: 1),
            "a NaN shortfall is refused")

        // Stakes only ever help, and they clamp at both ends: everything on it cannot buy
        // more hesitation away than the hesitation there is.
        for short in shorts {
            var everBid = false
            var lastFalseAfterTrue = false
            for stake in [0.0, 0.2, 0.4, 0.6, 0.8, 1.0] {
                let bid = shouldBid(anyone, short: short, deadline: 0.2, stakes: stake)
                if bid { everBid = true } else if everBid { lastFalseAfterTrue = true }
            }
            Check.ok(
                !lastFalseAfterTrue,
                "raising the stakes never makes a player less willing to bid (short \(short))")
        }
        for short in shorts {
            Check.eq(
                shouldBid(anyone, short: short, deadline: 0.2, stakes: 5),
                shouldBid(anyone, short: short, deadline: 0.2, stakes: 1),
                "stakes above everything are still everything (short \(short))")
            Check.eq(
                shouldBid(anyone, short: short, deadline: 0.2, stakes: -3),
                shouldBid(anyone, short: short, deadline: 0.2, stakes: 0),
                "stakes below nothing are still nothing (short \(short))")
        }

        // "Agility does not appear, because the rules engine's extension is flat — a
        // quicker player earns layouts by getting into the band, not by widening it."
        // Two players who share nothing must answer identically.
        let sloth = player(flat(28), energy: 0.12)
        let freak = player(flat(99), energy: 1)
        for short in shorts {
            for deadline in [0.1, 0.45, 1.0] {
                Check.eq(
                    shouldBid(sloth, short: short, deadline: deadline, stakes: 0.5),
                    shouldBid(freak, short: short, deadline: deadline, stakes: 0.5),
                    "who you are does not widen the band (short \(short), deadline \(deadline))")
            }
        }

        // `layoutExtend` is the AI's athleticism model and buys nothing the rules honour.
        // It must be a *different* quantity from the flat band a bid is priced against,
        // or the two reach models have quietly merged.
        Check.ok(
            layoutExtend(freak) > EXTENDED_REACH,
            "the athleticism model is not the rules engine's flat extension")
    }

    // MARK: - throw range

    private static func throwRange() {
        let winds: [Double] = [-40, -20, -8.0001, -8, -5, -1, 0, 1, 5, 8, 8.0001, 20, 40]

        for type in AI_THROW_TYPES {
            for r in stride(from: 0.0, through: 100.0, by: 5.0) {
                let a = flat(r)
                for e in energies {
                    let p = player(a, energy: e)
                    for w in winds {
                        Check.near(
                            maxThrowRange(p, type, w), Model.maxThrowRange(a, e, type, w),
                            1e-12, "maxThrowRange(\(type.rawValue), rating \(r), e \(e), wind \(w))")
                    }
                }
            }
        }

        let p = player(flat(70))

        // The type table, as ratios rather than as five absolute numbers: a flick goes
        // 93% of a backhand, a hammer 58%, a scoober 42%, a push 30%. The ratio is
        // independent of the thrower, which is the claim the table actually makes.
        for r in stride(from: 0.0, through: 100.0, by: 10.0) {
            let thrower = player(flat(r))
            let backhand = maxThrowRange(thrower, .backhand, 0)
            for (type, factor) in Model.rangeFactor {
                Check.near(
                    maxThrowRange(thrower, type, 0) / backhand, factor, 1e-14,
                    "a \(type.rawValue) goes \(factor) of a backhand (rating \(r))")
            }
        }
        for type in AI_THROW_TYPES where type != .backhand {
            Check.ok(
                maxThrowRange(p, type, 0) < maxThrowRange(p, .backhand, 0),
                "a backhand outranges a \(type.rawValue)")
            Check.ok(
                maxThrowRange(p, type, 0) >= maxThrowRange(p, .push, 0),
                "a push is the shortest throw there is (\(type.rawValue))")
        }

        // Wind. Linear at 4.5% of the throw per m/s along it, clamped to a gale of 8 in
        // either direction — clamped rather than compounding, so a hurricane is a gale.
        let still = maxThrowRange(p, .backhand, 0)
        for w in stride(from: -8.0, through: 8.0, by: 0.5) {
            Check.near(
                maxThrowRange(p, .backhand, w) / still, 1 + 0.045 * w, 1e-14,
                "wind is worth 4.5% of the throw per m/s (\(w))")
        }
        for w in [8.0001, 12, 40, 1e6] {
            Check.bitEq(
                maxThrowRange(p, .backhand, w), maxThrowRange(p, .backhand, 8),
                "a tailwind above a gale is still a gale (\(w))")
            Check.bitEq(
                maxThrowRange(p, .backhand, -w), maxThrowRange(p, .backhand, -8),
                "and so is a headwind (\(w))")
        }
        Check.ok(
            maxThrowRange(p, .backhand, 5) > maxThrowRange(p, .backhand, -5),
            "a tailwind throws further than a headwind")

        // Arm and tank, at their endpoints.
        Check.near(
            maxThrowRange(player(flat(0)), .backhand, 0), 21, 1e-13,
            "no arm at all still throws 21 m")
        Check.near(
            maxThrowRange(player(flat(100)), .backhand, 0), 57, 1e-13,
            "the best arm in the game throws 57 m")
        Check.near(
            maxThrowRange(player(flat(70), energy: 0), .backhand, 0)
                / maxThrowRange(player(flat(70), energy: 1), .backhand, 0),
            0.86, 1e-14,
            "an empty tank keeps 86% of the range")
    }

    // MARK: - release speed

    private static func releaseSpeed() {
        let distances = stride(from: 0.0, through: 90.0, by: 0.5).map { $0 }

        for type in AI_THROW_TYPES {
            for r in stride(from: 0.0, through: 100.0, by: 10.0) {
                let a = flat(r)
                let p = player(a)
                for d in distances {
                    let got = throwReleaseSpeed(p, type, d)
                    let at = "throwReleaseSpeed(\(type.rawValue), rating \(r), d \(d))"
                    Check.near(got, Model.releaseSpeed(a, type, d), 1e-12, at)

                    // The law behind the formula: a throw of length `d` released at
                    // speed `s` implies a flight of `d / s` seconds, and that time is a
                    // fixed 0.28 s of wind-up plus the distance over the arm's ceiling
                    // speed for this throw. Inverting the returned speed has to recover
                    // that ceiling.
                    if d > 0 {
                        let implied = d / got - 0.28
                        Check.near(
                            d / implied, Model.zip(a, type) * Model.stretch(d), 1e-9,
                            "\(at) inverts to the arm's ceiling speed")
                        Check.ok(got < Model.zip(a, type) * Model.stretch(d), "\(at) is under the ceiling")
                    }
                }
            }
        }

        let p = player(flat(70))

        // A throw of no length leaves the hand at no speed.
        Check.near(throwReleaseSpeed(p, .backhand, 0), 0, 0, "a throw of zero length has no speed")

        // Longer means harder, everywhere, without exception.
        for type in AI_THROW_TYPES {
            var previous = -1.0
            for d in distances {
                let s = throwReleaseSpeed(p, type, d)
                Check.ok(s > previous, "a longer \(type.rawValue) is thrown harder at \(d)")
                previous = s
            }
        }

        // The stretch. Below 15 m there is none; the first ramp is spent by 23 m; the
        // second by 40 m and nothing beyond it adds more.
        for d in [0.0, 3, 10, 14.99, 15] {
            Check.near(
                throwReleaseSpeed(p, .backhand, d), d / (0.28 + d / Model.zip(flat(70), .backhand)),
                1e-12 * Swift.max(1, d),
                "an under is thrown with no stretch at all (\(d))")
        }
        Check.near(Model.stretch(15), 1, 0, "the stretch has not started at 15 m")
        Check.near(Model.stretch(23), 1.42, 1e-15, "the first ramp is spent at 23 m")
        Check.near(Model.stretch(40), 1.70, 1e-15, "the second is spent at 40 m")
        for d in [40.0, 60, 120, 400] {
            Check.near(Model.stretch(d), Model.stretch(40), 0, "nothing past 40 m stretches further (\(d))")
        }
        // A huck is genuinely a different throw: over the stretch the release speed
        // climbs faster than distance alone would carry it.
        let per15 = throwReleaseSpeed(p, .backhand, 15) / 15
        let per40 = throwReleaseSpeed(p, .backhand, 40) / 40
        Check.ok(per40 > per15 * 0.5, "a huck is not simply a long under")
        Check.ok(
            throwReleaseSpeed(p, .backhand, 30) > throwReleaseSpeed(p, .backhand, 15) * 1.5,
            "past 15 m a real thrower puts arm into it")

        // Only the hammer is thrown with less zip, and only through the arm term — a
        // thrower with no arm at all throws every type at the same speed, which is what
        // says the 0.8 multiplies the arm and not the whole release.
        for type in AI_THROW_TYPES where type != .hammer {
            for d in [5.0, 20, 45] {
                Check.bitEq(
                    throwReleaseSpeed(p, type, d), throwReleaseSpeed(p, .backhand, d),
                    "only the hammer is thrown softer (\(type.rawValue), \(d) m)")
            }
        }
        for d in [5.0, 20, 45] {
            Check.ok(
                throwReleaseSpeed(p, .hammer, d) < throwReleaseSpeed(p, .backhand, d),
                "a hammer leaves the hand slower than a backhand (\(d) m)")
            Check.bitEq(
                throwReleaseSpeed(player(flat(0)), .hammer, d),
                throwReleaseSpeed(player(flat(0)), .backhand, d),
                "with no arm at all a hammer and a backhand are the same throw (\(d) m)")
        }

        // **The wind-up floor is unreachable and this asserts that it is.** The
        // denominator is `max(0.2, 0.28 + d / v)`, and `0.28` alone already clears `0.2`
        // for every non-negative distance, so the floor never binds. Removing it entirely
        // would change no number in this game — the honest assertion is the reachability
        // claim, not the branch.
        for type in AI_THROW_TYPES {
            for r in [0.0, 50, 100] {
                for d in distances {
                    Check.ok(
                        0.28 + d / (Model.zip(flat(r), type) * Model.stretch(d)) > 0.2,
                        "the wind-up floor cannot bind (\(type.rawValue), rating \(r), \(d) m)")
                }
            }
        }
    }

    // MARK: - flight time

    private static func flightTime() {
        let distances = stride(from: 0.0, through: 60.0, by: 0.5).map { $0 }

        for type in AI_THROW_TYPES {
            for r in stride(from: 0.0, through: 100.0, by: 10.0) {
                let a = flat(r)
                let p = player(a)
                for d in distances {
                    Check.near(
                        throwFlightTime(p, type, d), Model.flightTime(a, type, d), 1e-13,
                        "throwFlightTime(\(type.rawValue), rating \(r), d \(d))")
                }
            }
        }

        let p = player(flat(70))

        // A throw of no length still takes the release: 0.28 s of it.
        Check.near(throwFlightTime(p, .backhand, 0), 0.28, 1e-15, "a throw of zero length takes 0.28 s")

        // Below the loft range the clock is a straight line in distance, so equal steps
        // add equal time whatever the thrower and whatever the throw.
        for type in AI_THROW_TYPES {
            for r in [20.0, 70, 99] {
                let thrower = player(flat(r))
                let step = throwFlightTime(thrower, type, 10) - throwFlightTime(thrower, type, 5)
                for d in stride(from: 5.0, through: 15.0, by: 5.0) {
                    Check.near(
                        throwFlightTime(thrower, type, d + 5) - throwFlightTime(thrower, type, d),
                        step, 1e-14,
                        "a line drive's clock is linear in distance (\(type.rawValue), \(r), \(d))")
                }
            }
        }

        // **The step at the loft range is a real step, and it is inclusive at 25 m.**
        // Past it the solver throws the disc over the top instead of on a line, and the
        // flight roughly doubles.
        for type in AI_THROW_TYPES {
            let justUnder = throwFlightTime(p, type, ThrowSolver.loftRange.nextDown)
            let atIt = throwFlightTime(p, type, ThrowSolver.loftRange)
            Check.near(
                atIt / justUnder, loftFlight, 1e-12,
                "the loft step is exactly the loft factor (\(type.rawValue))")
            Check.ok(atIt > justUnder * 1.5, "a huck hangs (\(type.rawValue))")
            for d in [ThrowSolver.loftRange, 30, 40, 55] {
                Check.near(
                    throwFlightTime(p, type, d), Model.flatFlight(flat(70), type, d) * loftFlight,
                    1e-13, "past the loft range the clock is the flat clock times \(loftFlight)")
            }
        }

        // Longer always hangs longer, including across the step.
        for type in AI_THROW_TYPES {
            var previous = -1.0
            for d in distances {
                let t = throwFlightTime(p, type, d)
                Check.ok(t > previous, "a longer \(type.rawValue) hangs longer at \(d)")
                previous = t
            }
        }

        // A better arm gets it there sooner, at every distance.
        for type in AI_THROW_TYPES {
            for d in [10.0, 24, 26, 45] {
                Check.ok(
                    throwFlightTime(player(flat(99)), type, d)
                        < throwFlightTime(player(flat(30)), type, d),
                    "a stronger arm gets a \(type.rawValue) there sooner (\(d) m)")
            }
        }

        // The type table for the clock is a different table from the one for range: a
        // forehand crosses the ground exactly as fast as a backhand here, while the
        // three off-hand throws are slower.
        for d in [10.0, 20, 30] {
            Check.bitEq(
                throwFlightTime(p, .forehand, d), throwFlightTime(p, .backhand, d),
                "a flick and a backhand share a clock (\(d) m)")
            for type in [AIThrowType.hammer, .scoober, .push] {
                Check.ok(
                    throwFlightTime(p, type, d) > throwFlightTime(p, .backhand, d),
                    "a \(type.rawValue) hangs longer than a backhand of the same length (\(d) m)")
            }
            // And the clock table is not the range table: a push outranges nothing but a
            // scoober is the slowest thing in the air.
            Check.ok(
                throwFlightTime(p, .scoober, d) > throwFlightTime(p, .push, d),
                "the clock table is not the range table (\(d) m)")
        }

        // The two throw tables have to disagree, or one of them has been read for the
        // other: a push is the shortest throw and the hammer is not, while the hammer
        // hangs longer than the push does.
        Check.ok(
            Model.rangeFactor[.push]! < Model.rangeFactor[.hammer]!
                && Model.arriveFactor[.push]! < Model.arriveFactor[.hammer]!,
            "the range table and the clock table rank the throws differently")
    }

    // MARK: - catching

    private static func catching() {
        let difficulties = stride(from: -0.5, through: 3.0, by: 0.05).map { $0 }

        for r in stride(from: 0.0, through: 100.0, by: 5.0) {
            let a = flat(r)
            for e in energies {
                let p = player(a, energy: e)
                for d in difficulties {
                    let got = catchProbability(p, d)
                    let at = "catchProbability(catching \(r), e \(e), difficulty \(d))"
                    Check.near(got, Model.catchProbability(a, e, d), 1e-14, at)
                    Check.inRange(got, 0.18, 0.995, "\(at) stays on its rails")
                }
            }
        }

        let p = player(flat(70))

        // Difficulty clamps at both ends. A disc easier than easy is still a catch; a
        // disc harder than the hardest the model prices is priced at the hardest.
        for d in [-5.0, -1, -1e-9] {
            Check.bitEq(catchProbability(p, d), catchProbability(p, 0), "negative difficulty is zero (\(d))")
        }
        for d in [1.8, 2, 5, 1e6] {
            Check.bitEq(
                catchProbability(p, d), catchProbability(p, 1.8),
                "difficulty past 1.8 is priced at 1.8 (\(d))")
        }

        // Harder is worse, monotonically, over the whole live range.
        var previous = 2.0
        for d in stride(from: 0.0, through: 1.8, by: 0.02) {
            let v = catchProbability(p, d)
            Check.ok(v < previous, "a harder disc is less certain at \(d)")
            previous = v
        }

        // And the cost of difficulty is exactly `catchSlope` times the exposure a pair of
        // hands leaves — so it is linear in difficulty with a stated slope.
        for r in stride(from: 0.0, through: 100.0, by: 10.0) {
            let hands = player(flat(r))
            let exposure = 1 - 0.45 * (r / 100)
            let slope = (catchProbability(hands, 0.5) - catchProbability(hands, 1.5))
            Check.near(
                slope, catchSlope * exposure * 1.0, 1e-13,
                "difficulty costs catchSlope × exposure per unit (catching \(r))")
        }

        // Better hands and a fuller tank both help, everywhere.
        for d in [0.0, 0.5, 1.0, 1.5] {
            Check.ok(
                catchProbability(player(flat(99)), d) > catchProbability(player(flat(30)), d),
                "better hands catch more (\(d))")
            Check.ok(
                catchProbability(player(flat(70), energy: 1), d)
                    > catchProbability(player(flat(70), energy: 0.12), d),
                "a fresher player catches more (\(d))")
        }
        Check.near(
            catchProbability(player(flat(70), energy: 0), 0)
                / catchProbability(player(flat(70), energy: 1), 0),
            0.96, 1e-13,
            "an empty tank keeps 96% of a catch")

        // The ceiling is reached and the floor is not.
        //
        // The best hands in the game on a chest-high disc price at 0.997 before the
        // rails, so 0.995 binds and nothing is ever certain. **The floor of 0.18 cannot
        // bind at all**: the difficulty clamp caps the penalty at
        // `catchSlope × 1 × 1.8 = 0.432`, and the worst base-times-fatigue in the model
        // is `0.952 × 0.96 = 0.914`, so the lowest reachable probability is about 0.48.
        // Asserted as the reachability claim rather than pretended to be exercised.
        Check.near(
            catchProbability(player(flat(100), energy: 1), 0), 0.995, 0,
            "no disc is ever a certainty")
        var worst = 1.0
        for r in stride(from: 0.0, through: 100.0, by: 1.0) {
            for e in stride(from: -1.0, through: 1.5, by: 0.1) {
                worst = Swift.min(worst, catchProbability(player(flat(r), energy: e), 3))
            }
        }
        Check.ok(
            worst > 0.18,
            "the 0.18 floor is unreachable while difficulty clamps at 1.8 (worst seen \(worst))")
        Check.ok(worst > 0.4, "and no disc in this model is close to hopeless (\(worst))")
    }

    // MARK: - stamina

    private static func stamina() {
        // Against the model over a long, varied trace. The plan crosses the load
        // threshold in both directions and spends time on both sides of it.
        let plan: [Double] =
            Array(repeating: 1.0, count: 120)
            + Array(repeating: 0.0, count: 60)
            + Array(repeating: 0.41, count: 30)
            + Array(repeating: 0.43, count: 30)
            + Array(repeating: 1.2, count: 60)
            + Array(repeating: 0.42, count: 40)
            + Array(repeating: 2.0, count: 40)

        for r in [30.0, 55, 72, 99] {
            let a = flat(r)
            let live = player(a)
            let model = player(a)
            let vmax = effectiveMaxSpeed(live)
            for (i, frac) in plan.enumerated() {
                live.vel = Vec3d(frac * vmax, 0, 0)
                model.vel = Vec3d(frac * vmax, 0, 0)
                tickStamina(live, 1.0 / 60)
                Model.tickStamina(model, 1.0 / 60)
                Check.near(
                    live.energy, model.energy, 1e-15,
                    "tickStamina(stamina \(r)) step \(i)")
            }
        }

        // **The threshold is inclusive on the recovering side.** At exactly a jog you are
        // recovering; a hair above it you are spending. A flipped comparison lands on the
        // wrong side of exactly this pair.
        let a = flat(72)
        // The load is a fraction of *this* player's top speed, and top speed fades with
        // the tank — so a speed meant to be a given fraction of it has to be built
        // against the energy the player will actually be carrying.
        func vmaxAt(_ e: Double) -> Double { effectiveMaxSpeed(player(a, energy: e)) }
        let vmax = vmaxAt(1)
        //
        // The speed is walked to the last representable value on each side of the
        // threshold rather than assumed, because `0.42 * vmax / vmax` is not reliably
        // 0.42 and the whole point of this pair is which side of the line it lands on.
        let jogging = vmaxAt(0.5)
        var atJog = 0.42 * jogging
        while atJog / jogging > 0.42 { atJog = atJog.nextDown }
        var overJog = atJog
        while overJog / jogging <= 0.42 { overJog = overJog.nextUp }

        let onThreshold = player(a, energy: 0.5)
        onThreshold.vel = Vec3d(atJog, 0, 0)
        tickStamina(onThreshold, 1.0 / 60)
        Check.ok(onThreshold.energy > 0.5, "at exactly a jog you are recovering")

        let overThreshold = player(a, energy: 0.5)
        overThreshold.vel = Vec3d(overJog, 0, 0)
        tickStamina(overThreshold, 1.0 / 60)
        Check.ok(overThreshold.energy < 0.5, "one ulp above a jog you are spending")

        // Standing still recovers fastest, and recovery falls away as the load rises to
        // the threshold.
        var lastGain = Double.infinity
        for frac in stride(from: 0.0, through: 0.40, by: 0.02) {
            let q = player(a, energy: 0.5)
            q.vel = Vec3d(frac * jogging, 0, 0)
            tickStamina(q, 1.0 / 60)
            let gain = q.energy - 0.5
            Check.ok(gain > 0, "under the threshold you recover (\(frac))")
            Check.ok(gain < lastGain, "and recover more slowly the harder you work (\(frac))")
            lastGain = gain
        }

        // Drain grows with the square of the load, and stops growing at 1.2 — a sprint
        // beyond top speed costs no more than the cap.
        let working = vmaxAt(0.9)
        var lastLoss = 0.0
        for frac in stride(from: 0.43, through: 1.2, by: 0.02) {
            let q = player(a, energy: 0.9)
            q.vel = Vec3d(frac * working, 0, 0)
            tickStamina(q, 1.0 / 60)
            let loss = 0.9 - q.energy
            Check.ok(loss > lastLoss, "the harder you run the more it costs (\(frac))")
            lastLoss = loss
        }
        let capped = player(a, energy: 0.9)
        capped.vel = Vec3d(1.5 * working, 0, 0)
        tickStamina(capped, 1.0 / 60)
        for frac in [1.5, 3.0, 40.0, 1e6] {
            let q = player(a, energy: 0.9)
            q.vel = Vec3d(frac * working, 0, 0)
            tickStamina(q, 1.0 / 60)
            Check.bitEq(q.energy, capped.energy, "load is capped at 1.2 (\(frac))")
        }
        // The square, stated: doubling the load past the threshold quadruples the drain.
        let atHalf = player(a, energy: 0.9)
        atHalf.vel = Vec3d(0.5 * working, 0, 0)
        tickStamina(atHalf, 1.0 / 60)
        let atOne = player(a, energy: 0.9)
        atOne.vel = Vec3d(1.0 * working, 0, 0)
        tickStamina(atOne, 1.0 / 60)
        Check.near(
            (0.9 - atOne.energy) / (0.9 - atHalf.energy), 4, 1e-9,
            "drain goes with the square of the load")

        // Speed is a magnitude: which way he is running does not change what it costs.
        for angle in stride(from: 0.0, through: 6.0, by: 0.25) {
            let q = player(a, energy: 0.9)
            q.vel = Vec3d(
                0.8 * working * Foundation.cos(angle), 0, 0.8 * working * Foundation.sin(angle))
            tickStamina(q, 1.0 / 60)
            let straight = player(a, energy: 0.9)
            straight.vel = Vec3d(0.8 * working, 0, 0)
            tickStamina(straight, 1.0 / 60)
            Check.near(q.energy, straight.energy, 1e-15, "direction does not change the cost (\(angle))")
        }

        // Endurance: a fitter player spends less and recovers more.
        for frac in [0.8, 1.0, 1.2] {
            let fit = player(flat(99), energy: 0.9)
            let unfit = player(flat(28), energy: 0.9)
            fit.vel = Vec3d(frac * effectiveMaxSpeed(fit), 0, 0)
            unfit.vel = Vec3d(frac * effectiveMaxSpeed(unfit), 0, 0)
            tickStamina(fit, 1.0 / 60)
            tickStamina(unfit, 1.0 / 60)
            Check.ok(fit.energy > unfit.energy, "a fitter player spends less at load \(frac)")
        }
        let fitRest = player(flat(99), energy: 0.5)
        let unfitRest = player(flat(28), energy: 0.5)
        fitRest.vel = .zero
        unfitRest.vel = .zero
        tickStamina(fitRest, 1.0 / 60)
        tickStamina(unfitRest, 1.0 / 60)
        Check.ok(fitRest.energy > unfitRest.energy, "and recovers faster")

        // **The step is a scale factor and nothing else.** The rate reads the tank only
        // through the top speed the load is measured against, so halving the step and
        // taking two of them lands within a hundred-millionth of taking one — and at zero
        // load, where top speed cannot enter at all, within an ulp.
        let resting = vmaxAt(0.6)
        for frac in [0.0, 0.3, 0.9] {
            let one = player(a, energy: 0.6)
            one.vel = Vec3d(frac * resting, 0, 0)
            tickStamina(one, 1.0 / 30)
            let two = player(a, energy: 0.6)
            two.vel = Vec3d(frac * resting, 0, 0)
            tickStamina(two, 1.0 / 60)
            tickStamina(two, 1.0 / 60)
            Check.near(
                one.energy, two.energy, frac == 0 ? 1e-15 : 1e-7,
                "stamina integrates linearly in dt (\(frac))")

            let none = player(a, energy: 0.6)
            none.vel = Vec3d(frac * resting, 0, 0)
            tickStamina(none, 0)
            Check.bitEq(none.energy, 0.6, "a step of no time changes nothing (\(frac))")
        }

        // Both rails, reached and held. Empty is 0.12, not 0 — a player who has emptied
        // the tank is still a player.
        let flogged = player(a, energy: 1)
        for _ in 0..<5_000 {
            flogged.vel = Vec3d(2 * vmax, 0, 0)
            tickStamina(flogged, 1.0 / 60)
            Check.inRange(flogged.energy, 0.12, 1, "the pool stays on its rails while draining")
        }
        Check.near(flogged.energy, 0.12, 0, "a flogged player bottoms out at 0.12, not at 0")

        let rested = player(a, energy: 0.12)
        for _ in 0..<5_000 {
            rested.vel = .zero
            tickStamina(rested, 1.0 / 60)
            Check.inRange(rested.energy, 0.12, 1, "the pool stays on its rails while recovering")
        }
        Check.near(rested.energy, 1, 0, "a rested player tops out at exactly full")

        // The top-speed floor. A player whose energy has been driven out of range has a
        // non-positive top speed, and the guard is what keeps the load — and therefore
        // the whole pool — from going to NaN.
        let broken = player(a, energy: -50)
        broken.vel = Vec3d(3, 0, 0)
        tickStamina(broken, 1.0 / 60)
        Check.ok(broken.energy.isFinite, "a nonsense top speed does not poison the pool")
        Check.inRange(broken.energy, 0.12, 1, "and the result is still on the rails")

        // `tickStamina` mutates in place. `AIPlayer` is a class precisely so it can, and
        // a value type would make every call site silently do nothing.
        let subject = player(a, energy: 0.9)
        subject.vel = Vec3d(vmax, 0, 0)
        let alias = subject
        tickStamina(subject, 1.0 / 60)
        Check.ok(alias.energy < 0.9, "tickStamina writes through to every holder of the player")
    }

    // MARK: - boundary room

    private static func boundaries() {
        let pitches: [(String, FieldConstants)] = [("standard", .standard), ("minis", .minis)]
        let directions: [(Double, Double)] = [
            (1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1),
            (0.6, -0.8), (-0.6, 0.8), (3, 1), (1, 3), (-2, 5), (7, -2),
        ]

        for (name, f) in pitches {
            let bx = f.sideline - boundaryRoomMargin
            let bz = f.endLine - boundaryRoomMargin

            for px in stride(from: -bx + 0.01, through: bx - 0.01, by: bx / 4) {
                for pz in stride(from: -bz + 0.01, through: bz - 0.01, by: bz / 4) {
                    for (dx, dz) in directions {
                        let at = "\(name) boundaryRoom((\(px),\(pz)) along (\(dx),\(dz)))"
                        let t = boundaryRoom(px, pz, dx, dz, field: f)
                        Check.near(t, Model.boundaryRoom(px, pz, dx, dz, f), 1e-12, at)

                        // **The law: `t` metres along the ray is exactly the perimeter.**
                        // Not near it, not past it — on it. This is the assertion a
                        // wrong sign, a swapped axis or a dropped `max` cannot satisfy,
                        // and it does not depend on knowing the formula at all.
                        let l = Foundation.hypot(dx, dz)
                        let ex = px + t * dx / l
                        let ez = pz + t * dz / l
                        Check.ok(
                            abs(abs(ex) - bx) < 1e-9 || abs(abs(ez) - bz) < 1e-9,
                            "\(at): the ray ends on the perimeter")
                        Check.ok(
                            abs(ex) <= bx + 1e-9 && abs(ez) <= bz + 1e-9,
                            "\(at): and does not pass through it")
                        // A hair short of it is strictly inside, so `t` is the *first*
                        // crossing rather than a later one.
                        let sx = px + t * 0.99 * dx / l
                        let sz = pz + t * 0.99 * dz / l
                        Check.ok(
                            abs(sx) < bx + 1e-9 && abs(sz) < bz + 1e-9,
                            "\(at): and everything before it is inside")
                        Check.ok(t > 0 && t < 1e3, "\(at): a real direction finds a real limit")

                        // Room is a property of the ray, not of the length of the vector
                        // that names it.
                        for scale in [0.5, 2.0, 50.0] {
                            Check.near(
                                boundaryRoom(px, pz, dx * scale, dz * scale, field: f), t, 1e-9,
                                "\(at): scaling the direction changes nothing (\(scale))")
                        }

                        // Reflection. The pitch is symmetric about both axes, so
                        // reflecting the position and the direction together must give
                        // the same room — which pins the sign on each of the four walls.
                        Check.near(
                            boundaryRoom(-px, pz, -dx, dz, field: f), t, 1e-9,
                            "\(at): symmetric across the halfway line")
                        Check.near(
                            boundaryRoom(px, -pz, dx, -dz, field: f), t, 1e-9,
                            "\(at): symmetric across the centre line")
                        Check.near(
                            boundaryRoom(-px, -pz, -dx, -dz, field: f), t, 1e-9,
                            "\(at): symmetric under a half turn")
                    }
                }
            }

            // The inset, exactly. From the middle of the pitch the room to the sideline
            // is the sideline less the margin, and to the end line the end line less it.
            Check.bitEq(boundaryRoom(0, 0, 1, 0, field: f), bx, "\(name): +x room is the inset sideline")
            Check.bitEq(boundaryRoom(0, 0, -1, 0, field: f), bx, "\(name): −x room is too")
            Check.bitEq(boundaryRoom(0, 0, 0, 1, field: f), bz, "\(name): +z room is the inset end line")
            Check.bitEq(boundaryRoom(0, 0, 0, -1, field: f), bz, "\(name): −z room is too")

            // Standing on the inset line and heading out, there is nothing left; the
            // result is floored at nothing rather than going negative.
            for (dx, dz) in directions {
                let outward = boundaryRoom(bx * 2, 0, dx, dz, field: f)
                Check.ok(outward >= 0, "\(name): room is never negative, even out of bounds")
            }
            Check.near(
                boundaryRoom(bx, 0, 1, 0, field: f), 0, 0,
                "\(name): on the line and heading out, there is no room")
            Check.near(
                boundaryRoom(0, bz, 0, 1, field: f), 0, 0,
                "\(name): the same at the end line")
            Check.near(
                boundaryRoom(bx, 0, -1, 0, field: f), 2 * bx, 1e-13,
                "\(name): on the line and heading back, the whole width of it")
        }

        // A direction of nothing is not a division by zero — it reports effectively no
        // limit, because there is no ray to run out of room along.
        for (dx, dz) in [(0.0, 0.0), (1e-9, 0), (0, -1e-9), (5e-6, 5e-6)] {
            Check.near(
                boundaryRoom(0, 0, dx, dz), 1e3, 0,
                "a direction of nothing reports no limit ((\(dx),\(dz)))")
        }
        // And just past the degenerate threshold it is a real direction again.
        Check.ok(
            boundaryRoom(0, 0, 1e-4, 0) < 1e3,
            "a direction long enough to be a direction finds the sideline")

        // The margin itself: a player is steered to stay this far inside the perimeter,
        // and the number is shared with the target clamp rather than duplicated.
        Check.ok(
            boundaryRoomMargin > 0 && boundaryRoomMargin < 1,
            "the inset is a stride, not a metre and not nothing")
        Check.near(
            FieldConstants.standard.sideline - boundaryRoom(0, 0, 1, 0), boundaryRoomMargin, 1e-13,
            "room is measured against an inset perimeter")

        // A smaller pitch really is smaller. This is the check that fails if the field
        // ever goes back to being a module constant.
        Check.ok(
            boundaryRoom(0, 0, 1, 0, field: .minis) < boundaryRoom(0, 0, 1, 0, field: .standard),
            "a minis pitch really is narrower")
        Check.ok(
            boundaryRoom(0, 0, 0, 1, field: .minis) < boundaryRoom(0, 0, 0, 1, field: .standard),
            "and shorter")
    }

    // MARK: - attribute generation

    private static let seeds: [UInt32] = [0, 1, 42, 777, 4242, 12345, 0x9e37_79b9, .max]
    private static let overalls: [Double] = [55, 60, 72, 90]

    /// The draw order, the spreads, the biases and the clamps — against `Model`, which
    /// states the order as data rather than as a sequence of statements.
    private static func sheets() {
        for seed in seeds {
            for archetype in Archetype.allCases {
                for overall in overalls {
                    let got = makeAttributes(Rng(seed: seed), archetype, overall: overall)
                    let want = Model.attributes(Rng(seed: seed), archetype, overall)
                    compare(
                        got, want,
                        "makeAttributes(seed \(seed), \(archetype.rawValue), overall \(overall))")
                }
            }
        }

        // **The draw count.** Fourteen gaussians, no more and no fewer. A sheet that
        // consumed one extra number would still look entirely plausible and would
        // desynchronise every player drawn after it.
        for seed in seeds {
            for archetype in Archetype.allCases {
                let used = Rng(seed: seed)
                _ = makeAttributes(used, archetype, overall: 72)
                let counted = Rng(seed: seed)
                for _ in 0..<Model.gaussDrawsPerSheet { _ = counted.gauss() }
                for i in 0..<8 {
                    Check.bitEq(
                        used.next(), counted.next(),
                        "a sheet costs exactly \(Model.gaussDrawsPerSheet) draws "
                            + "(seed \(seed), \(archetype.rawValue), \(i))")
                }
            }
        }

        // The same seed is the same player, bit for bit. This is the property that makes
        // a replay a replay.
        for seed in seeds {
            let a = makeAttributes(Rng(seed: seed), .cutter, overall: 72)
            let b = makeAttributes(Rng(seed: seed), .cutter, overall: 72)
            compare(a, b, "one seed, one sheet (seed \(seed))")
        }

        // **The two clamps are different clamps.** A rating floors at 28 and an accuracy
        // at 25, and driving `overall` off the bottom is what tells them apart.
        let floored = makeAttributes(Rng(seed: 5), .cutter, overall: -1000)
        for key in ratingKeys {
            Check.near(rating(floored, key), 28, 0, "a rating floors at 28 (\(key))")
        }
        for type in AI_THROW_TYPES {
            Check.near(
                floored.throwAccuracy[type]!, 25, 0, "an accuracy floors at 25 (\(type.rawValue))")
        }
        let ceilinged = makeAttributes(Rng(seed: 5), .cutter, overall: 1000)
        for key in ratingKeys {
            Check.near(rating(ceilinged, key), 99, 0, "a rating ceilings at 99 (\(key))")
        }
        for type in AI_THROW_TYPES {
            Check.near(
                ceilinged.throwAccuracy[type]!, 99, 0,
                "an accuracy ceilings at 99 (\(type.rawValue))")
        }

        // **`overall` shifts the whole sheet by exactly itself.** Same seed, same
        // gaussians, so away from the clamps every rating moves by the shift and nothing
        // else does.
        for seed in seeds {
            let low = makeAttributes(Rng(seed: seed), .cutter, overall: 60)
            let high = makeAttributes(Rng(seed: seed), .cutter, overall: 70)
            for key in ratingKeys where unclamped(rating(low, key)) && unclamped(rating(high, key)) {
                Check.near(
                    rating(high, key) - rating(low, key), 10, 1e-12,
                    "ten points of overall is ten points of \(key) (seed \(seed))")
            }
            for type in AI_THROW_TYPES
            where unclamped(low.throwAccuracy[type]!, 25) && unclamped(high.throwAccuracy[type]!, 25) {
                Check.near(
                    high.throwAccuracy[type]! - low.throwAccuracy[type]!, 10, 1e-12,
                    "and ten points of \(type.rawValue) accuracy (seed \(seed))")
            }
        }

        // **The archetype bias, exactly.** Two archetypes drawn from the same seed
        // consume the same gaussians, so away from the clamps the difference between
        // their sheets is the difference between their biases and nothing else. That
        // turns a table of twenty-odd numbers into an assertion rather than a hope.
        for seed in seeds {
            for lhs in Archetype.allCases {
                for rhs in Archetype.allCases where lhs != rhs {
                    let a = makeAttributes(Rng(seed: seed), lhs, overall: 60)
                    let b = makeAttributes(Rng(seed: seed), rhs, overall: 60)
                    for key in ratingKeys where unclamped(rating(a, key)) && unclamped(rating(b, key)) {
                        let want = (Model.bias[lhs]?[key] ?? 0) - (Model.bias[rhs]?[key] ?? 0)
                        Check.near(
                            rating(a, key) - rating(b, key), want, 1e-12,
                            "\(lhs.rawValue) − \(rhs.rawValue) is the bias table on \(key) "
                                + "(seed \(seed))")
                    }
                    let handWant = (Model.handBonus[lhs] ?? 0) - (Model.handBonus[rhs] ?? 0)
                    for type in AI_THROW_TYPES
                    where unclamped(a.throwAccuracy[type]!, 25)
                        && unclamped(b.throwAccuracy[type]!, 25) {
                        Check.near(
                            a.throwAccuracy[type]! - b.throwAccuracy[type]!, handWant, 1e-12,
                            "\(lhs.rawValue) − \(rhs.rawValue) is the hand bonus on "
                                + "\(type.rawValue) (seed \(seed))")
                    }
                }
            }
        }

        // **The accuracy penalties.** Each accuracy is drawn from its own gaussian, so
        // this is a claim about the mean rather than about a draw: over four thousand
        // sheets the gaussians cancel and the penalties do not. A backhand is free; a
        // scoober costs 26 points of accuracy.
        var totals: [AIThrowType: Double] = [:]
        let sampler = Rng(seed: 0xACC0)
        let samples = 4000
        for _ in 0..<samples {
            let a = Model.attributes(sampler, .utility, 72)
            for type in AI_THROW_TYPES { totals[type, default: 0] += a.throwAccuracy[type]! }
        }
        for (type, penalty) in Model.accuracyDraws {
            let mean = totals[type]! / Double(samples)
            Check.near(
                mean, 72 - penalty, 0.6,
                "a \(type.rawValue) costs \(penalty) points of accuracy on average (\(mean))")
        }

        // The archetypes the bias table describes in prose: "a handler is slower and
        // throws further; a deep is faster, jumps higher and throws worse."
        func mean(_ archetype: Archetype, _ key: String) -> Double {
            let rng = Rng(seed: 0xB1A5)
            var total = 0.0
            for _ in 0..<400 { total += rating(makeAttributes(rng, archetype, overall: 60), key) }
            return total / 400
        }
        Check.ok(mean(.handler, "speed") < mean(.cutter, "speed"), "a handler is slower than a cutter")
        Check.ok(
            mean(.handler, "throwPower") > mean(.cutter, "throwPower"),
            "and throws further")
        Check.ok(mean(.deep, "speed") > mean(.handler, "speed"), "a deep is faster than a handler")
        Check.ok(mean(.deep, "jumping") > mean(.handler, "jumping"), "and jumps higher")
        Check.ok(
            mean(.deep, "throwPower") < mean(.handler, "throwPower"), "and throws worse")
        Check.ok(
            mean(.utility, "stamina") > mean(.cutter, "stamina"),
            "a utility player has more in the tank")
        Check.ok(
            mean(.utility, "defAwareness") > mean(.cutter, "defAwareness"),
            "and reads the field better on defence")

        // The spreads, as the width of the distribution each rating is drawn from.
        // Catching is drawn tighter than speed, and the accuracies tighter still.
        let widthRng = Rng(seed: 0x5EED_5)
        var sums: [String: Double] = [:]
        var squares: [String: Double] = [:]
        let n = 6000
        for _ in 0..<n {
            let a = Model.attributes(widthRng, .utility, 60)
            for key in ratingKeys where (Model.bias[.utility]?[key] ?? 0) == 0 {
                sums[key, default: 0] += rating(a, key)
                squares[key, default: 0] += rating(a, key) * rating(a, key)
            }
        }
        let expectedSpread: [String: Double] = [
            "acceleration": 9, "jumping": 9, "catching": 7, "throwPower": 8, "decision": 10,
        ]
        for (key, spread) in expectedSpread {
            let m = sums[key]! / Double(n)
            let sd = (squares[key]! / Double(n) - m * m).squareRoot()
            Check.near(m, 60, 0.5, "\(key) is centred on the overall (\(m))")
            Check.near(sd, spread, 0.5, "\(key) is drawn with a spread of \(spread) (\(sd))")
        }
    }

    private static func unclamped(_ v: Double, _ floor: Double = 28) -> Bool {
        v > floor + 1e-9 && v < 99 - 1e-9
    }

    /// Compare two whole sheets field by field.
    ///
    /// Whole-sheet rather than spot-checked, precisely because the failure worth catching
    /// is two fields swapped or the draw order shifted — both of which leave every
    /// individual value looking entirely reasonable.
    private static func compare(_ got: AIAttributes, _ want: AIAttributes, _ at: String) {
        for key in ratingKeys {
            Check.bitEq(rating(got, key), rating(want, key), "\(at).\(key)")
        }
        Check.eq(got.throwAccuracy.count, AI_THROW_TYPES.count, "\(at): five accuracies")
        for type in AI_THROW_TYPES {
            guard let g = got.throwAccuracy[type], let w = want.throwAccuracy[type] else {
                Check.ok(false, "\(at): missing accuracy for \(type.rawValue)")
                continue
            }
            Check.bitEq(g, w, "\(at).throwAccuracy.\(type.rawValue)")
        }
    }

    // MARK: - rosters

    /// A whole roster from one seed. `makePlayer` draws handedness from the same stream
    /// immediately after the sheet, so this pins the sheet order *and* the draw that
    /// follows it — a port that consumed one extra number anywhere would desynchronise
    /// every player after the first.
    private static func rosters() {
        for seed in seeds {
            for archetype in Archetype.allCases {
                let live = Rng(seed: seed)
                let model = Rng(seed: seed)
                for i in 0..<7 {
                    let p = makePlayer(i, 1, archetype, live, overall: 72)
                    let wantAttr = Model.attributes(model, archetype, 72)
                    let wantHanded: Playbook.Handedness = model.next() < 0.86 ? .right : .left
                    let at = "roster(seed \(seed), \(archetype.rawValue))[\(i)]"

                    compare(p.attr, wantAttr, at)
                    Check.eq(p.id, i, "\(at).id")
                    Check.eq(p.team, 1, "\(at).team")
                    Check.eq(p.archetype, archetype, "\(at).archetype")
                    Check.eq(p.handed, wantHanded, "\(at).handed")
                    Check.eq(
                        p.role, archetype == .handler ? PlayerRole.handler : PlayerRole.cutter,
                        "\(at).role — a handler handles, everyone else cuts")
                    Check.bitEq(p.energy, 1, "\(at) starts with a full tank")
                    Check.ok(p.pos == .zero && p.vel == .zero, "\(at) starts at rest at the origin")
                }
            }
        }

        // 14% of players are left handed, which is roughly the real rate. A threshold read
        // the wrong way round would make it 86%, and a roster of lefties is not a crash.
        let rng = Rng(seed: 0x1EF7)
        var left = 0
        let roster = 20_000
        for i in 0..<roster where makePlayer(i, 0, .cutter, rng, overall: 72).handed == .left {
            left += 1
        }
        let rate = Double(left) / Double(roster)
        Check.near(rate, 0.14, 0.01, "about one player in seven is left handed (\(rate))")
        Check.ok(left > 0 && left < roster, "both hands appear on a roster")
    }
}
