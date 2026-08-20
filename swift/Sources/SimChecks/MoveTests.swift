import Foundation
import UltimateSim

/// The movement port's leaf functions: attribute derivation, gait planning, ground
/// grade, separation compliance, and aerial prediction/reach.
///
/// # Method
///
/// Same split the suite has always used, now applied without a fixture to lean on:
/// bit-exact where the underlying ops are `+ - * / sqrt min max clamp` (IEEE 754
/// correctly rounds those), a stated tolerance where `pow` appears. `gradeAlong` also
/// gets a tolerance rather than `bitEq` even though nothing here crosses a JS boundary
/// any more — two independently-written call sites into the same `hypot`, which no
/// libm is required to round to the last bit, are not guaranteed to agree bit-for-bit
/// just because they are both Swift. `RngTests.gauss` makes the identical call for
/// `log`/`cos`; this suite makes it for `hypot`.
///
/// `Model` below is a second implementation of every formula, typed fresh from
/// `Attributes.swift`'s own doc comment (the "reference athlete" figures) rather than
/// transcribed from `derive`, so a coefficient typo in production is not guaranteed to
/// be repeated here. It caught one thing worth recording: the doc comment's "13.4
/// m/s^2 braking" does not match the module's own formula, which gives 15.36 for that
/// same reference athlete — confirmed against move.json's `brakeMax` before that file
/// was deleted. That is a stale comment, not a functional bug (the formula is
/// internally consistent and every other reference figure in the same comment checks
/// out), and fixing a comment is outside this suite's file scope — pinned below as the
/// real behaviour instead of silently repeating the wrong number.
///
/// # Scope
///
/// `advanceGait`, `accumulateSeparation`, `DiscProbe` and `contestAir` are
/// `Locomotion`'s integration surface — `Locomotion.swift`/`LocomotionContacts.swift`
/// call each of them every frame — and are exercised there, in `LocomotionTests`, not
/// duplicated here. This suite covers the leaf functions `Locomotion` composes:
/// `derive` and its scalar helpers, the gait-planning scalars and `plantForCut`,
/// `gradeAlong`/`slopeMultiplier`, `compliance`, and `predictPos`/`reachAt`.
enum MoveTests {

    // MARK: - test fixtures (not golden data — built in-process)

    private static func attrs(
        speed: Double = 70, accel: Double = 70, agility: Double = 70, strength: Double = 60,
        vertical: Double = 65, endurance: Double = 70, balance: Double = 70,
        height: Double = 1.83, mass: Double = 82
    ) -> Attributes {
        Attributes(
            speed: speed, accel: accel, agility: agility, strength: strength,
            vertical: vertical, endurance: endurance, balance: balance,
            height: height, mass: mass)
    }

    private static let attributePresets: [Attributes] = [
        .defaultAttrs,
        attrs(speed: 0, accel: 0, agility: 0, strength: 0, vertical: 0, endurance: 0, balance: 0),
        attrs(
            speed: 100, accel: 100, agility: 100, strength: 100, vertical: 100, endurance: 100,
            balance: 100),
        attrs(speed: 30, accel: 90, agility: 10, vertical: 60, height: 2.05, mass: 70),
        attrs(speed: 85, accel: 20, agility: 55, vertical: 5, height: 1.60, mass: 100),
        attrs(speed: 50, accel: 50, agility: 50, vertical: 50, height: 1.83, mass: 82),
    ]

    private static let allModes: [MoveMode] = [.sprint, .run, .jog, .backpedal, .shuffle]

    private static let allStates: [LocoStateName] = [
        .idle, .jog, .run, .sprint, .backpedal, .shuffle, .cut,
        .jump, .layout, .landing, .recovery, .fall, .stumble,
    ]

    private static let transcendentalTol = 1e-12
    /// `gradeAlong`'s tolerance — see the header for why `hypot` gets one even here.
    private static let hypotTol = 1e-12

    // MARK: - the specification, implemented independently

    /// Every formula below is typed from `Attributes.swift`/`Gait.swift`/`Ground.swift`/
    /// `Separation.swift`/`Contest.swift`'s own doc comments and the reference-athlete
    /// figures they state, not copied from the functions under test.
    enum Model {
        static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double {
            Swift.min(Swift.max(v, lo), hi)
        }
        static func clamp01(_ v: Double) -> Double { clamp(v, 0, 1) }
        static func n01(_ v: Double) -> Double { clamp(v, 0, 100) / 100 }

        // MARK: attributes

        static func modeCapFraction(_ mode: MoveMode, agility: Double) -> Double {
            let agi = n01(agility)
            switch mode {
            case .sprint: return 1
            case .run: return 0.78
            case .jog: return 0.42
            case .backpedal: return 0.50 + 0.06 * agi
            case .shuffle: return 0.43 + 0.06 * agi
            case .auto: preconditionFailure("Model.modeCapFraction requires a resolved mode")
            }
        }

        struct MDerived {
            var topSpeed, modeCap, accelMax, brakeMax, gripMax: Double
            var turnRate, jumpHeight, standingReach, plantDur: Double
            var fatigue, slopeMul: Double
        }

        static func derive(
            _ a: Attributes, stamina: Double, speed: Double, mode: MoveMode, slopeMul: Double
        ) -> MDerived {
            let spd = n01(a.speed)
            let acc = n01(a.accel)
            let agi = n01(a.agility)
            let ver = n01(a.vertical)

            let fatigue = clamp01((STAM_FADE - stamina) / STAM_FADE)

            let accelMul = mode == .backpedal ? 0.62 : (mode == .shuffle ? 0.72 : 1.0)
            let gripMul = mode == .backpedal ? 0.80 : (mode == .shuffle ? 1.15 : 1.0)

            let topSpeed = (6.6 + 3.0 * spd) * (1 - 0.22 * fatigue) * slopeMul
            let accelMax = (5.0 + 4.6 * acc) * (1 - 0.34 * fatigue) * slopeMul * accelMul
            let brakeMax = accelMax * (1.25 + 0.35 * agi)
            let gripMax = (7.5 + 5.0 * agi) * (1 - 0.20 * fatigue) * gripMul

            let sFrac = clamp01(speed / Swift.max(1e-3, topSpeed))
            let turnRate = (9.5 + 4.0 * agi) * (1 - 0.72 * sFrac)

            let jumpHeight = (0.30 + 0.55 * ver) * (1 - 0.18 * fatigue)
            let standingReach = a.height * 1.30
            let plantDur = 0.20 - 0.07 * agi

            let capFrac = mode == .sprint ? 1 : modeCapFraction(mode, agility: a.agility)

            return MDerived(
                topSpeed: topSpeed, modeCap: topSpeed * capFrac, accelMax: accelMax,
                brakeMax: brakeMax, gripMax: gripMax, turnRate: turnRate,
                jumpHeight: jumpHeight, standingReach: standingReach, plantDur: plantDur,
                fatigue: fatigue, slopeMul: slopeMul)
        }

        static func propulsiveAt(_ d: Derived, speed: Double, cap: Double) -> Double {
            let f = clamp01(speed / Swift.max(0.5, cap))
            return d.accelMax * Swift.max(0, 1 - Foundation.pow(f, 1.7))
        }

        static func leapHeight(_ d: Derived, approachSpeed: Double) -> Double {
            let f = clamp01(approachSpeed / Swift.max(1e-3, d.topSpeed))
            return d.jumpHeight * (1 + 0.38 * f)
        }

        static func takeoffVy(_ d: Derived, approachSpeed: Double) -> Double {
            (2 * moveG * leapHeight(d, approachSpeed: approachSpeed)).squareRoot()
        }

        static func staminaRate(_ a: Attributes, speed: Double, topSpeedFresh: Double) -> Double {
            let end = n01(a.endurance)
            let f = clamp01(speed / Swift.max(1e-3, topSpeedFresh))
            let IDLE_F = 0.42
            if f > IDLE_F {
                let drain = 2.6 + 2.4 * (1 - end)
                return -drain * Foundation.pow(f, 2.4)
            }
            let rec = 2.0 + 2.0 * end
            return rec * (1 - (f / IDLE_F) * 0.55)
        }

        // MARK: gait

        static func stepRate(_ speed: Double) -> Double {
            clamp(1.55 + 0.35 * speed, 1.55, 4.9)
        }
        static func dutyFactor(_ speed: Double) -> Double {
            clamp(0.64 - 0.045 * speed, 0.22, 0.65)
        }
        static func stanceHalfWidth(_ speed: Double, mode: MoveMode) -> Double {
            if mode == .shuffle { return 0.24 }
            if mode == .backpedal { return 0.14 }
            return clamp(0.155 - 0.008 * speed, 0.085, 0.16)
        }

        struct MPlant {
            var planted: Bool
            var foot: Foot
            var x, y, z, speed: Double
        }

        static func plantForCut(
            posX: Double, posZ: Double, speed: Double, velX: Double, velZ: Double,
            turnSign: Double, groundY: (Double, Double) -> Double
        ) -> MPlant {
            let foot: Foot = turnSign >= 0 ? .left : .right
            let inv = 1 / Swift.max(1e-6, speed)
            let dx = velX * inv
            let dz = velZ * inv
            let ox = dz * turnSign
            let oz = -dx * turnSign
            let ahead = clamp(0.16 + 0.045 * speed, 0.16, 0.62)
            let px = posX + dx * ahead + ox * 0.26
            let pz = posZ + dz * ahead + oz * 0.26
            let py = groundY(px, pz)
            return MPlant(planted: true, foot: foot, x: px, y: py, z: pz, speed: speed)
        }

        // MARK: ground

        static func gradeAlong(_ nx: Double, _ ny: Double, _ nz: Double, dx: Double, dz: Double)
            -> Double
        {
            let len = Foundation.hypot(dx, dz)
            if len < 1e-6 || ny <= 1e-4 { return 0 }
            let gx = -nx / ny
            let gz = -nz / ny
            return (gx * dx + gz * dz) / len
        }

        static func slopeMultiplier(_ grade: Double) -> Double {
            clamp(1 - 1.6 * grade, 0.6, 1.15)
        }

        // MARK: separation compliance

        static func compliance(
            airborne: Bool, state: LocoStateName, prone: Bool, anchored: Bool,
            mass: Double, strength: Double
        ) -> Double {
            // Typed independently from Types.swift's own doc comments rather than
            // reusing `committedStates` — sharing that Set would make this Model
            // blind to a bug in its membership, which is exactly the class of bug
            // `.stumble` turned out to be worth checking (see `complianceTests`).
            let committed: Set<LocoStateName> = [.jump, .layout, .landing, .recovery, .fall]
            if airborne { return 0 }
            if committed.contains(state) { return 0 }
            if prone { return 0 }
            if anchored { return 0 }
            let braced = mass * (1 + 0.35 * clamp01(strength / 100))
            return 1 / Swift.max(1, braced)
        }

        // MARK: aerial

        static func predictPos(
            posX: Double, posY: Double, posZ: Double, velX: Double, velY: Double, velZ: Double,
            airborne: Bool, isLayout: Bool, groundY: Double, hipHeight: Double, t: Double
        ) -> (x: Double, y: Double, z: Double) {
            let x = posX + velX * t
            let z = posZ + velZ * t
            var y = posY
            if airborne {
                let floor = groundY + (isLayout ? PRONE_Y : hipHeight)
                y = Swift.max(floor, posY + velY * t - 0.5 * moveG * t * t)
            }
            return (x, y, z)
        }

        static func reachAt(
            posY: Double, velY: Double, airborne: Bool, isLayout: Bool, groundY: Double,
            hipHeight: Double, height: Double, t: Double
        ) -> Double {
            var y = posY
            if airborne {
                let floor = groundY + (isLayout ? PRONE_Y : hipHeight)
                y = Swift.max(floor, posY + velY * t - 0.5 * moveG * t * t)
            }
            let rise = y - (groundY + hipHeight)
            return Swift.max(groundY + 0.6, groundY + height * 1.30 + rise)
        }
    }

    // MARK: - run

    static func run() throws {
        constants()
        modeCap()
        deriveTests()
        derivedScalars()
        stamina()
        gait()
        ground()
        complianceTests()
        aerial()
        claims()
    }

    // MARK: - constants

    /// Pinned individually, and by exact value — not merely their relation to each
    /// other — for the same reason `ConstantsTests` exists: `catchband`/`divergences`
    /// pinning `CATCH_DEAD` were both fixtures, and the value stayed unpinned the
    /// moment they left. These thirteen have no other suite that pins them.
    private static func constants() {
        Check.bitEq(STAM_FADE, 60.0, "STAM_FADE")
        Check.bitEq(moveG, 9.81, "G")
        Check.bitEq(COST_JUMP, 2.5, "COST_JUMP")
        Check.bitEq(COST_LAYOUT, 9.0, "COST_LAYOUT")
        Check.bitEq(COST_CUT, 1.2, "COST_CUT")
        Check.bitEq(GAIT_MIN_SPEED, 0.35, "GAIT_MIN_SPEED")
        Check.bitEq(PERSONAL_RADIUS, 0.63, "PERSONAL_RADIUS")
        Check.bitEq(SEP_RATE, 1.60, "SEP_RATE")
        Check.bitEq(SEP_DEADBAND, 0.02, "SEP_DEADBAND")
        Check.bitEq(SEP_Y_SPAN, 1.0, "SEP_Y_SPAN")
        Check.bitEq(DISC_GRAB_R, 1.15, "DISC_GRAB_R")
        Check.bitEq(DISC_FREE_R, 3.20, "DISC_FREE_R")
        Check.bitEq(PRONE_Y, 0.22, "PRONE_Y")

        // A soft radius smaller than the hard one would make separation push bodies
        // together. The reference relies on this ordering without asserting it.
        Check.ok(DISC_FREE_R > DISC_GRAB_R, "the free radius is outside the grab radius")
    }

    // MARK: - modeCapFraction

    private static func modeCap() {
        for i in 0...100 {
            let agi = Double(i)
            for mode in allModes {
                Check.bitEq(
                    modeCapFraction(mode, agility: agi), Model.modeCapFraction(mode, agility: agi),
                    "modeCapFraction(\(mode), agility \(agi))")
            }
        }
        // Out-of-band agility is clamped inside n01 before it reaches the formula.
        for agi in [-1000.0, -1.0, 100.001, 250.0, 1e9] {
            for mode in allModes {
                Check.bitEq(
                    modeCapFraction(mode, agility: agi), Model.modeCapFraction(mode, agility: agi),
                    "modeCapFraction(\(mode), out-of-band agility \(agi))")
            }
        }
        // Ordering holds over the whole domain: sprint > run > backpedal > shuffle > jog.
        // backpedal's range [0.50,0.56] and shuffle's [0.43,0.49] never overlap, so this
        // is not just true "on average" — it is true at every agility value.
        for i in stride(from: 0, through: 100, by: 10) {
            let agi = Double(i)
            let sprint = modeCapFraction(.sprint, agility: agi)
            let run = modeCapFraction(.run, agility: agi)
            let back = modeCapFraction(.backpedal, agility: agi)
            let shuf = modeCapFraction(.shuffle, agility: agi)
            let jog = modeCapFraction(.jog, agility: agi)
            Check.ok(sprint > run, "sprint cap above run cap at agility \(agi)")
            Check.ok(run > back, "run cap above backpedal cap at agility \(agi)")
            Check.ok(back > shuf, "backpedal cap above shuffle cap at agility \(agi)")
            Check.ok(shuf > jog, "shuffle cap above jog cap at agility \(agi)")
        }
    }

    // MARK: - derive

    /// Reference-athlete pins, taken directly from `Attributes.swift`'s own doc
    /// comment (four of five figures) and from move.json's last recorded golden for
    /// the fifth (`brakeMax`) — see the header for the discrepancy that pin exposes.
    ///
    /// These are chained arithmetic results, not raw constants, so a hand-typed
    /// decimal literal is not guaranteed to be the exact same double the chain of
    /// multiplications lands on (e.g. `0.30 + 0.55 * 1` is a whisker off the literal
    /// `0.85`) — `near` with a tolerance many orders tighter than any real coefficient
    /// bug would produce, rather than `bitEq`.
    private static let pinTol = 1e-9

    private static func referenceAthletePins() {
        // .defaultAttrs is not all-100, so build the doc's actual reference athlete.
        let maxed = attrs(
            speed: 100, accel: 100, agility: 100, strength: 100, vertical: 100, endurance: 100,
            balance: 100, height: 1.83, mass: 82)
        let ref = derive(maxed, stamina: 100, speed: 0, mode: .sprint, slopeMul: 1)
        Check.near(ref.topSpeed, 9.6, pinTol, "reference athlete: 9.6 m/s top speed")
        Check.near(ref.accelMax, 9.6, pinTol, "reference athlete: 9.6 m/s^2 burst")
        Check.near(ref.gripMax, 12.5, pinTol, "reference athlete: 12.5 m/s^2 lateral grip")
        Check.near(ref.jumpHeight, 0.85, pinTol, "reference athlete: 0.85 m standing vertical")
        // Not 13.4, per the header: the module's own formula gives 15.36 here.
        Check.near(
            ref.brakeMax, 15.36, pinTol,
            "reference athlete brakes at 15.36 m/s^2 (module's doc comment says 13.4 — stale)")
        Check.near(ref.turnRate, 13.5, pinTol, "reference athlete turnRate at speed 0")
        Check.near(ref.plantDur, 0.13, pinTol, "reference athlete plantDur")
        Check.bitEq(ref.fatigue, 0, "a fresh reference athlete is not fatigued")
        Check.near(ref.modeCap, 9.6, pinTol, "reference athlete sprint cap equals top speed")

        let zeroed = attrs(
            speed: 0, accel: 0, agility: 0, strength: 0, vertical: 0, endurance: 0, balance: 0,
            height: 1.83, mass: 82)
        let zero = derive(zeroed, stamina: 100, speed: 0, mode: .sprint, slopeMul: 1)
        Check.near(zero.topSpeed, 6.6, pinTol, "zero-rated athlete: 6.6 m/s top speed floor")
        Check.near(zero.accelMax, 5.0, pinTol, "zero-rated athlete: 5.0 m/s^2 burst floor")
        Check.near(zero.brakeMax, 6.25, pinTol, "zero-rated athlete: 6.25 m/s^2 braking floor")
        Check.near(zero.gripMax, 7.5, pinTol, "zero-rated athlete: 7.5 m/s^2 grip floor")
        Check.near(zero.jumpHeight, 0.30, pinTol, "zero-rated athlete: 0.30 m vertical floor")
        Check.near(zero.turnRate, 9.5, pinTol, "zero-rated athlete turnRate floor")
        Check.near(zero.plantDur, 0.20, pinTol, "zero-rated athlete plantDur ceiling")

        // A fully cooked (stamina 0) reference athlete, matching move.json's last
        // recorded fatigue=1 case exactly.
        let cooked = derive(maxed, stamina: 0, speed: 0, mode: .sprint, slopeMul: 1)
        Check.bitEq(cooked.fatigue, 1, "stamina 0 is maximally fatigued")
        Check.near(cooked.topSpeed, 7.488, pinTol, "cooked reference athlete top speed")
        Check.near(cooked.accelMax, 6.336, pinTol, "cooked reference athlete accel")
        Check.near(cooked.brakeMax, 10.1376, pinTol, "cooked reference athlete brake")
        Check.near(cooked.gripMax, 10, pinTol, "cooked reference athlete grip")
        Check.near(cooked.jumpHeight, 0.697, pinTol, "cooked reference athlete jump")
    }

    private static func deriveTests() {
        referenceAthletePins()

        let staminaGrid = [0.0, 15.0, 45.0, 60.0, 75.0, 100.0]
        let speedGrid = [0.0, 1.5, 4.0, 7.0, 10.0, 15.0]
        let slopeMulGrid = [0.4, 0.6, 1.0, 1.15, 1.4]

        for a in attributePresets {
            for stamina in staminaGrid {
                for speed in speedGrid {
                    for mode in allModes {
                        for slopeMul in slopeMulGrid {
                            let got = UltimateSim.derive(
                                a, stamina: stamina, speed: speed, mode: mode, slopeMul: slopeMul)
                            let want = Model.derive(
                                a, stamina: stamina, speed: speed, mode: mode, slopeMul: slopeMul)
                            let at =
                                "derive(agi \(a.agility), stamina \(stamina), speed \(speed), "
                                + "\(mode), slope \(slopeMul))"
                            Check.bitEq(got.fatigue, want.fatigue, "\(at).fatigue")
                            Check.bitEq(got.slopeMul, want.slopeMul, "\(at).slopeMul")
                            Check.bitEq(got.topSpeed, want.topSpeed, "\(at).topSpeed")
                            Check.bitEq(got.modeCap, want.modeCap, "\(at).modeCap")
                            Check.bitEq(got.accelMax, want.accelMax, "\(at).accelMax")
                            Check.bitEq(got.brakeMax, want.brakeMax, "\(at).brakeMax")
                            Check.bitEq(got.gripMax, want.gripMax, "\(at).gripMax")
                            Check.bitEq(got.turnRate, want.turnRate, "\(at).turnRate")
                            Check.bitEq(got.jumpHeight, want.jumpHeight, "\(at).jumpHeight")
                            Check.bitEq(
                                got.standingReach, want.standingReach, "\(at).standingReach")
                            Check.bitEq(got.plantDur, want.plantDur, "\(at).plantDur")
                        }
                    }
                }
            }
        }
    }

    // MARK: - propulsiveAt / leapHeight / takeoffVy / staminaRate

    private static func derivedScalars() {
        var derivedPool: [Derived] = []
        for a in attributePresets {
            for stamina in [0.0, 60.0, 100.0] {
                for mode in [MoveMode.sprint, .jog] {
                    derivedPool.append(
                        UltimateSim.derive(a, stamina: stamina, speed: 0, mode: mode, slopeMul: 1))
                }
            }
        }

        let speedGrid = [0.0, 1.0, 3.0, 6.0, 9.0, 13.0]
        let capGrid = [0.5, 3.0, 6.0, 9.0, 12.0]
        for d in derivedPool {
            for speed in speedGrid {
                for cap in capGrid {
                    Check.near(
                        propulsiveAt(d, speed: speed, cap: cap),
                        Model.propulsiveAt(d, speed: speed, cap: cap), transcendentalTol,
                        "propulsiveAt(topSpeed \(d.topSpeed), speed \(speed), cap \(cap))")
                }
            }
        }

        let approachGrid = [0.0, 1.0, 3.0, 5.0, 8.0, 12.0]
        for d in derivedPool {
            for approach in approachGrid {
                Check.bitEq(
                    leapHeight(d, approachSpeed: approach),
                    Model.leapHeight(d, approachSpeed: approach),
                    "leapHeight(jumpHeight \(d.jumpHeight), approach \(approach))")
                Check.bitEq(
                    takeoffVy(d, approachSpeed: approach),
                    Model.takeoffVy(d, approachSpeed: approach),
                    "takeoffVy(jumpHeight \(d.jumpHeight), approach \(approach))")
            }
        }
    }

    private static func stamina() {
        let speedGrid = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 7.0, 9.0]
        let topSpeedGrid = [4.0, 6.0, 9.0, 12.0]
        for a in attributePresets {
            for speed in speedGrid {
                for topSpeedFresh in topSpeedGrid {
                    let got = staminaRate(a, speed: speed, topSpeedFresh: topSpeedFresh)
                    let want = Model.staminaRate(a, speed: speed, topSpeedFresh: topSpeedFresh)
                    let at = "staminaRate(endurance \(a.endurance), speed \(speed), top \(topSpeedFresh))"
                    Check.near(got, want, transcendentalTol, at)
                    // The sign is the branch (drain vs recover); a tolerance around
                    // zero would not catch the two being confused near the boundary.
                    Check.ok((got < 0) == (want < 0), "\(at) agrees on drain vs recover")
                }
            }
            // The IDLE_F=0.42 boundary belongs to recovery, not drain (condition is
            // `f > IDLE_F`, strictly greater) — exercised at exactly f == IDLE_F.
            for topSpeedFresh in topSpeedGrid {
                let boundarySpeed = topSpeedFresh * 0.42
                let got = staminaRate(a, speed: boundarySpeed, topSpeedFresh: topSpeedFresh)
                Check.ok(
                    got > 0,
                    "staminaRate at exactly f == IDLE_F recovers, not drains (endurance "
                        + "\(a.endurance), top \(topSpeedFresh))")
            }
        }
    }

    // MARK: - gait

    private static func gait() {
        let speedGrid = stride(from: -2.0, through: 15.0, by: 0.25).map { $0 }
        for speed in speedGrid {
            Check.bitEq(stepRate(speed), Model.stepRate(speed), "stepRate(\(speed))")
            Check.bitEq(dutyFactor(speed), Model.dutyFactor(speed), "dutyFactor(\(speed))")
            for mode in allModes {
                Check.bitEq(
                    stanceHalfWidth(speed, mode: mode), Model.stanceHalfWidth(speed, mode: mode),
                    "stanceHalfWidth(\(speed), \(mode))")
            }
        }
        // Both ends of stepRate's and dutyFactor's clamp are reached over the grid
        // above — a law the bit-exact loop cannot see failing to hold on its own.
        Check.bitEq(stepRate(-2.0), 1.55, "stepRate clamps to its floor")
        Check.bitEq(stepRate(15.0), 4.9, "stepRate clamps to its ceiling")
        Check.bitEq(dutyFactor(15.0), 0.22, "dutyFactor clamps to its floor")
        Check.bitEq(dutyFactor(-2.0), 0.65, "dutyFactor clamps to its ceiling")

        plantForCutGrid()
    }

    private static func plantForCutGrid() {
        let positions: [(Double, Double)] = [(0, 0), (5, -3), (-12, 8)]
        let speeds = [0.4, 2.0, 5.0, 8.0, 11.0]
        let velocities: [(Double, Double)] = [
            (1, 0), (0, 1), (-1, 0), (1, 1), (-0.6, 0.8),
        ]
        let turnSigns = [1.0, -1.0]
        let grounds: [(Double, Double) -> Double] = [
            { _, _ in 0 },
            { x, z in 0.25 * x - 0.125 * z },
        ]

        for (posX, posZ) in positions {
            for speed in speeds {
                for (vx, vz) in velocities {
                    for turnSign in turnSigns {
                        for ground in grounds {
                            let p = LocoPlayer(
                                id: 1, attr: .defaultAttrs, pos: Vec3d(posX, 0, posZ), t: 2.25)
                            let got = plantForCut(
                                p, speed: speed, velX: vx, velZ: vz, turnSign: turnSign,
                                groundY: ground)
                            let want = Model.plantForCut(
                                posX: posX, posZ: posZ, speed: speed, velX: vx, velZ: vz,
                                turnSign: turnSign, groundY: ground)
                            let at =
                                "plantForCut(pos \(posX),\(posZ), speed \(speed), vel \(vx),\(vz), "
                                + "turn \(turnSign))"
                            Check.eq(got.planted, want.planted, "\(at).planted")
                            Check.eq(got.foot, want.foot, "\(at).foot")
                            Check.bitEq(got.x, want.x, "\(at).x")
                            Check.bitEq(got.y, want.y, "\(at).y")
                            Check.bitEq(got.z, want.z, "\(at).z")
                            Check.bitEq(got.speed, want.speed, "\(at).speed")
                        }
                    }
                }
            }
        }
    }

    // MARK: - ground

    private static func ground() {
        let normals: [(Double, Double, Double)] = [
            (0, 1, 0), (0.3, 0.95, -0.1), (-0.2, 0.98, 0.15), (0.6, 0.8, 0),
            (0.05, 0.0005, 0.02),  // n.y at the 1e-4 threshold: degenerate
            (0.5, -0.3, 0.1),  // n.y negative: degenerate
        ]
        let directions: [(Double, Double)] = [
            (1, 0), (0, 1), (-1, 0), (1, 1), (-0.7, 0.7), (3, -4), (0, 0),
        ]
        for (nx, ny, nz) in normals {
            for (dx, dz) in directions {
                let got = gradeAlong(Vec3d(nx, ny, nz), dx: dx, dz: dz)
                let want = Model.gradeAlong(nx, ny, nz, dx: dx, dz: dz)
                Check.near(
                    got, want, hypotTol, "gradeAlong(n \(nx),\(ny),\(nz), along \(dx),\(dz))")
            }
        }
        // Reversing the direction of travel reverses the sign of the grade — a body
        // running the other way up the same slope is running down it.
        for (nx, ny, nz) in normals where ny > 1e-4 {
            for (dx, dz) in directions where Foundation.hypot(dx, dz) > 1e-6 {
                let forward = gradeAlong(Vec3d(nx, ny, nz), dx: dx, dz: dz)
                let backward = gradeAlong(Vec3d(nx, ny, nz), dx: -dx, dz: -dz)
                Check.near(
                    forward, -backward, hypotTol,
                    "gradeAlong reverses sign when the direction reverses "
                        + "(n \(nx),\(ny),\(nz), along \(dx),\(dz))")
            }
        }
        Check.eq(gradeAlong(Vec3d(0, 1, 0), dx: 1, dz: 0), 0.0, "flat ground has no grade")

        let gradeGrid = stride(from: -1.0, through: 1.0, by: 0.05).map { $0 }
        for grade in gradeGrid {
            Check.bitEq(
                slopeMultiplier(grade), Model.slopeMultiplier(grade), "slopeMultiplier(\(grade))")
        }
        Check.bitEq(slopeMultiplier(1.0), 0.6, "slopeMultiplier clamps to its floor")
        Check.bitEq(slopeMultiplier(-1.0), 1.15, "slopeMultiplier clamps to its ceiling")
    }

    // MARK: - separation compliance

    private static func complianceTests() {
        // Every cell of the state x airborne x prone x anchored table, at one fixed
        // body. `.stumble` is deliberately included and deliberately NOT in
        // `committedStates` (see Types.swift) — a stumbling body still yields ground
        // under this function, unlike `.jump`/`.layout`/`.landing`/`.recovery`/`.fall`.
        // That is exercised explicitly below rather than only falling out of the loop,
        // because it is easy to misread as an oversight.
        for state in allStates {
            for airborne in [false, true] {
                for prone in [false, true] {
                    for anchored in [false, true] {
                        let p = LocoPlayer(
                            id: 1, attr: .defaultAttrs, state: state, prone: prone,
                            anchored: anchored, air: AirState(airborne: airborne))
                        let got = UltimateSim.compliance(p)
                        let want = Model.compliance(
                            airborne: airborne, state: state, prone: prone, anchored: anchored,
                            mass: p.attr.mass, strength: p.attr.strength)
                        Check.bitEq(
                            got, want,
                            "compliance(state \(state), airborne \(airborne), prone \(prone), "
                                + "anchored \(anchored))")
                    }
                }
            }
        }
        // `.stumble` in particular does not zero compliance, unlike every other
        // "not under control" state — proved with a real assertion, not a comment.
        let stumbling = LocoPlayer(id: 1, attr: .defaultAttrs, state: .stumble)
        Check.ok(
            UltimateSim.compliance(stumbling) > 0,
            "a stumbling body still yields ground — .stumble is not in committedStates")
        for committed: LocoStateName in [.jump, .layout, .landing, .recovery, .fall] {
            let p = LocoPlayer(id: 1, attr: .defaultAttrs, state: committed)
            Check.eq(
                UltimateSim.compliance(p), 0.0,
                "a body committed to \(committed) does not yield ground")
        }

        // The continuous part of the formula: mass/strength, at a neutral state.
        let massGrid = [40.0, 60.0, 82.0, 100.0, 130.0, 160.0]
        let strengthGrid = [0.0, 25.0, 60.0, 90.0, 100.0, 150.0]
        for mass in massGrid {
            for strength in strengthGrid {
                var a = Attributes.defaultAttrs
                a.mass = mass
                a.strength = strength
                let p = LocoPlayer(id: 1, attr: a, state: .idle)
                let got = UltimateSim.compliance(p)
                let want = Model.compliance(
                    airborne: false, state: .idle, prone: false, anchored: false, mass: mass,
                    strength: strength)
                Check.bitEq(got, want, "compliance(mass \(mass), strength \(strength))")
            }
        }
        // Strength above 100 is clamped, same as agility above: 100 and 150 must
        // yield identically.
        for mass in [60.0, 100.0] {
            var low = Attributes.defaultAttrs
            low.mass = mass
            low.strength = 100
            var high = Attributes.defaultAttrs
            high.mass = mass
            high.strength = 150
            let pLow = LocoPlayer(id: 1, attr: low, state: .idle)
            let pHigh = LocoPlayer(id: 2, attr: high, state: .idle)
            Check.bitEq(
                UltimateSim.compliance(pLow), UltimateSim.compliance(pHigh),
                "strength above 100 is clamped, mass \(mass)")
        }
    }

    // MARK: - predictPos / reachAt

    private static func aerial() {
        struct Body {
            let label: String
            let pos: Vec3d
            let vel: Vec3d
            let airborne: Bool
            let isLayout: Bool
            let groundY: Double
            let hipHeight: Double
            let height: Double
        }
        let bodies: [Body] = [
            Body(
                label: "grounded idle", pos: Vec3d(0, 0.9, 0), vel: .zero, airborne: false,
                isLayout: false, groundY: 0, hipHeight: 0.9, height: 1.83),
            Body(
                label: "airborne rising", pos: Vec3d(0, 1.2, 0), vel: Vec3d(1, 3, 0.5),
                airborne: true, isLayout: false, groundY: 0, hipHeight: 0.9, height: 1.83),
            Body(
                label: "airborne falling past floor", pos: Vec3d(0, 3.0, 0),
                vel: Vec3d(2, -8, 0), airborne: true, isLayout: false, groundY: 0,
                hipHeight: 0.9, height: 1.83),
            Body(
                label: "layout diving", pos: Vec3d(1, 0.6, 0.5), vel: Vec3d(2, 1.5, 0.2),
                airborne: true, isLayout: true, groundY: 0, hipHeight: 0.9, height: 1.83),
            Body(
                label: "elevated platform", pos: Vec3d(0, 5.2, 0), vel: Vec3d(0, 2, 0),
                airborne: true, isLayout: false, groundY: 4.3, hipHeight: 0.95, height: 2.0),
            Body(
                label: "short athlete grounded", pos: Vec3d(-2, 0.7, 3), vel: Vec3d(-1, 0, 2),
                airborne: false, isLayout: false, groundY: 0, hipHeight: 0.7, height: 1.55),
        ]
        let times = [-1.0, 0.0, 0.05, 0.2, 0.5, 1.0, 2.0, 5.0]

        for b in bodies {
            for t in times {
                let p = LocoPlayer(
                    id: 1, attr: attrs(height: b.height), pos: b.pos, vel: b.vel,
                    state: b.isLayout ? .layout : .idle,
                    air: AirState(airborne: b.airborne), groundY: b.groundY,
                    hipHeight: b.hipHeight)
                let got = predictPos(p, t: t)
                let want = Model.predictPos(
                    posX: b.pos.x, posY: b.pos.y, posZ: b.pos.z, velX: b.vel.x, velY: b.vel.y,
                    velZ: b.vel.z, airborne: b.airborne, isLayout: b.isLayout, groundY: b.groundY,
                    hipHeight: b.hipHeight, t: t)
                let at = "predictPos(\(b.label), t \(t))"
                Check.bitEq(got.x, want.x, "\(at).x")
                Check.bitEq(got.y, want.y, "\(at).y")
                Check.bitEq(got.z, want.z, "\(at).z")

                let gotReach = reachAt(p, t: t)
                let wantReach = Model.reachAt(
                    posY: b.pos.y, velY: b.vel.y, airborne: b.airborne, isLayout: b.isLayout,
                    groundY: b.groundY, hipHeight: b.hipHeight, height: b.height, t: t)
                Check.bitEq(gotReach, wantReach, "reachAt(\(b.label), t \(t))")
            }

            // A grounded body's predicted y does not move with t — only an airborne
            // one is on a ballistic arc.
            if !b.airborne {
                let p = LocoPlayer(
                    id: 1, attr: attrs(height: b.height), pos: b.pos, vel: b.vel, groundY: b.groundY,
                    hipHeight: b.hipHeight)
                for t in [0.0, 1.0, 100.0] {
                    Check.bitEq(
                        predictPos(p, t: t).y, b.pos.y,
                        "\(b.label): grounded y does not move with t (t \(t))")
                }
            }
        }

        // Ballistic law: an airborne body's predicted height, sampled densely around
        // its analytic apex time (vy0/g), peaks there and nowhere else in the window —
        // and the value at the apex matches the closed-form apex height. Distinct from
        // the bit-exact grid above, which only ever checks isolated instants and could
        // not catch e.g. a sign flip in the quadratic term that still passes at t=0.
        let vy0 = 6.0
        let apexT = vy0 / moveG
        let riser = LocoPlayer(
            id: 1, attr: .defaultAttrs, pos: Vec3d(0, 1.0, 0), vel: Vec3d(0, vy0, 0),
            air: AirState(airborne: true), hipHeight: 0.9)
        var peakY = -Double.infinity
        var peakT = 0.0
        for i in -40...40 {
            let t = apexT + Double(i) * 0.01
            guard t >= 0 else { continue }
            let y = predictPos(riser, t: t).y
            if y > peakY { peakY = y; peakT = t }
        }
        Check.near(peakT, apexT, 0.011, "the sampled peak lands within one step of vy0/g")
        let analyticApexY = 1.0 + 0.5 * vy0 * apexT
        Check.near(peakY, analyticApexY, 1e-6, "the sampled peak height matches the closed form")

        // Floor clamp: far enough past the apex the predicted height sits exactly on
        // the floor, not below it and not still falling.
        let longT = apexT + 5.0
        let floored = predictPos(riser, t: longT).y
        Check.bitEq(floored, 0 + 0.9, "long after the apex, predicted y sits exactly on the floor")
    }

    // MARK: - the claims the module makes in prose

    /// Doc comments assert behaviour; behaviour can be checked. Each of these would
    /// still pass every bit-exact assertion above if the sign were flipped, because
    /// those only say what the code does — not what it is supposed to mean.
    private static func claims() {
        let fresh = derive(.defaultAttrs, stamina: 100, speed: 0, mode: .sprint, slopeMul: 1)
        let cooked = derive(.defaultAttrs, stamina: 0, speed: 0, mode: .sprint, slopeMul: 1)
        Check.ok(cooked.fatigue > fresh.fatigue, "a tired player is more fatigued")
        Check.ok(cooked.topSpeed < fresh.topSpeed, "a tired player is slower")
        Check.ok(cooked.accelMax < fresh.accelMax, "a tired player accelerates worse")
        Check.ok(cooked.gripMax < fresh.gripMax, "a tired player grips worse")
        Check.ok(cooked.jumpHeight < fresh.jumpHeight, "a tired player jumps lower")

        // "Peak propulsive acceleration at v=0" — so it must fall off with speed.
        Check.ok(
            propulsiveAt(fresh, speed: fresh.topSpeed, cap: fresh.topSpeed)
                < propulsiveAt(fresh, speed: 0, cap: fresh.topSpeed),
            "you accelerate harder from a standstill than at top speed")

        // Sprinting is faster than jogging is faster than walking, at equal agility.
        let sprint = modeCapFraction(.sprint, agility: 70)
        let jog = modeCapFraction(.jog, agility: 70)
        Check.ok(sprint > jog, "a sprint cap is above a jog cap")

        // "Effective leap height including the run-up bonus" — a run-up must help.
        Check.ok(
            leapHeight(fresh, approachSpeed: fresh.topSpeed) > leapHeight(fresh, approachSpeed: 0),
            "a run-up jumps higher than a standing leap")
        Check.ok(
            takeoffVy(fresh, approachSpeed: 5) > takeoffVy(fresh, approachSpeed: 0),
            "a higher leap leaves the ground faster")

        // "signed: negative drains" — sprinting drains, standing recovers.
        Check.ok(
            staminaRate(.defaultAttrs, speed: 8, topSpeedFresh: 8) < 0,
            "sprinting drains stamina")
        Check.ok(
            staminaRate(.defaultAttrs, speed: 0, topSpeedFresh: 8) > 0,
            "standing still recovers stamina")

        // Running uphill costs you speed and downhill does not.
        Check.ok(slopeMultiplier(0.2) < slopeMultiplier(0), "uphill is slower than flat")
        Check.ok(slopeMultiplier(-0.05) >= slopeMultiplier(0), "a slight downhill is not slower")

        // A flat surface has no grade in any direction.
        Check.eq(gradeAlong(Vec3d(0, 1, 0), dx: 1, dz: 0), 0.0, "flat ground has no grade")

        // A heavier, stronger body is harder to shove.
        var light = Attributes.defaultAttrs
        light.mass = 60
        light.strength = 40
        var heavy = Attributes.defaultAttrs
        heavy.mass = 100
        heavy.strength = 90
        Check.ok(
            UltimateSim.compliance(LocoPlayer(id: 1, attr: heavy))
                < UltimateSim.compliance(LocoPlayer(id: 2, attr: light)),
            "a bigger, stronger player gives way less")

        // Faster running means more steps and less time with a foot down.
        Check.ok(stepRate(7) > stepRate(2), "you take more steps per second when running")
        Check.ok(dutyFactor(7) < dutyFactor(2), "less of each stride is spent on the ground")

        // A layout's reach ceiling is lower than a standing jump's: PRONE_Y (0.22) is
        // well under a standing hip height, so an airborne layout's floor sits lower
        // than an airborne jump's floor at the same instant.
        let jumping = LocoPlayer(
            id: 1, attr: .defaultAttrs, pos: Vec3d(0, 5, 0), vel: .zero, state: .jump,
            air: AirState(airborne: true), hipHeight: 0.9)
        let laying = LocoPlayer(
            id: 2, attr: .defaultAttrs, pos: Vec3d(0, 5, 0), vel: .zero, state: .layout,
            air: AirState(airborne: true), hipHeight: 0.9)
        Check.ok(
            reachAt(laying, t: 100) < reachAt(jumping, t: 100),
            "long after launch, a layout's floor reach sits lower than a jump's")
    }
}
