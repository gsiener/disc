import Foundation
import UltimateSim

/// The movement port, against `src/sim/move/*.ts`.
///
/// The strictness split follows the generator's own note. Anything built only from
/// `+ - * / sqrt min max clamp` is required to match **bit-for-bit**, because IEEE 754
/// makes those correctly rounded and any difference at all is a porting bug rather than
/// numeric drift. `pow`, and the `sin`/`cos` in the gait plant, are library functions
/// whose last bit is not specified, so those get a stated tolerance.
///
/// That split is the whole value of this suite. A tolerance applied uniformly would pass
/// a `derive` that had two attribute weights transposed, because the result would still
/// be the right order of magnitude.
enum MoveTests {

    // MARK: fixture shapes

    struct Constants: Decodable {
        let STAM_FADE: Double
        let G: Double
        let COST_JUMP: Double
        let COST_LAYOUT: Double
        let COST_CUT: Double
        let GAIT_MIN_SPEED: Double
        let PERSONAL_RADIUS: Double
        let SEP_RATE: Double
        let SEP_DEADBAND: Double
        let SEP_Y_SPAN: Double
        let DISC_GRAB_R: Double
        let DISC_FREE_R: Double
        let PRONE_Y: Double
    }

    struct ModeCapCase: Decodable {
        let mode: String
        let agility: Double
        let want: Double
    }
    struct DeriveCase: Decodable {
        let a: Attributes
        let stamina: Double
        let speed: Double
        let mode: String
        let slopeMul: Double
        let want: Derived
    }
    struct DerivedScalarCase: Decodable {
        let d: Derived
        let speed: Double?
        let cap: Double?
        let approachSpeed: Double?
        let want: Double
    }
    struct StaminaCase: Decodable {
        let a: Attributes
        let speed: Double
        let topSpeedFresh: Double
        let want: Double
    }
    struct SpeedCase: Decodable {
        let speed: Double
        let mode: String?
        let want: Double
    }
    struct XYZ: Decodable {
        let x: Double
        let y: Double
        let z: Double
    }
    struct GradeCase: Decodable {
        let n: XYZ
        let dx: Double
        let dz: Double
        let want: Double
    }
    struct SlopeCase: Decodable {
        let grade: Double
        let want: Double
    }
    struct ComplianceCase: Decodable {
        struct Spec: Decodable {
            let mass: Double
            let strength: Double
            /// A body that is airborne, on the floor, or on a pivot does not give way at
            /// all. Dropping these from the fixture makes every such case look like a
            /// plain standing player and hides the branch entirely.
            let airborne: Bool?
            let state: String?
            let prone: Bool?
            let anchored: Bool?
        }
        let spec: Spec
        let want: Double
    }
    struct PredictCase: Decodable {
        let who: String
        let t: Double
        let want: XYZ
    }
    struct ReachCase: Decodable {
        let who: String
        let t: Double
        let want: Double
    }
    struct PlantCase: Decodable {
        struct Want: Decodable {
            let planted: Bool
            let foot: String
            let x: Double
            let y: Double
            let z: Double
            let speed: Double
        }
        let pos: XYZ
        let speed: Double
        let velX: Double
        let velZ: Double
        let turnSign: Double
        let want: Want
    }

    struct File: Decodable {
        let note: String
        let constants: Constants
        let modeCapFractionCases: [ModeCapCase]
        let deriveCases: [DeriveCase]
        let propulsiveAtCases: [DerivedScalarCase]
        let leapHeightCases: [DerivedScalarCase]
        let takeoffVyCases: [DerivedScalarCase]
        let staminaRateCases: [StaminaCase]
        let stepRateCases: [SpeedCase]
        let dutyFactorCases: [SpeedCase]
        let stanceHalfWidthCases: [SpeedCase]
        let plantForCutCases: [PlantCase]
        let complianceCases: [ComplianceCase]
        let predictPosCases: [PredictCase]
        let reachAtCases: [ReachCase]
        let gradeAlongCases: [GradeCase]
        let slopeMultiplierCases: [SlopeCase]
    }

    /// `pow` and `sin`/`cos` are not correctly rounded, so anything downstream of one
    /// gets this rather than a bit-for-bit demand. It is still tight enough that a
    /// transposed coefficient cannot hide inside it.
    private static let transcendentalTol = 1e-12

    static func run() throws {
        let g = try Goldens.load(File.self, "move")

        constants(g.constants)
        modeCap(g.modeCapFractionCases)
        derived(g.deriveCases)
        derivedScalars(g)
        stamina(g.staminaRateCases)
        gait(g)
        ground(g)
        bodies(g)
        claims()
    }

    // MARK: - constants

    /// The constants are compared individually rather than as a struct so a failure
    /// names the one that is wrong. A single typed digit here shifts every downstream
    /// number by a plausible-looking amount.
    private static func constants(_ c: Constants) {
        Check.bitEqViaJSON(STAM_FADE, c.STAM_FADE, "STAM_FADE")
        Check.bitEqViaJSON(moveG, c.G, "G")
        Check.bitEqViaJSON(COST_JUMP, c.COST_JUMP, "COST_JUMP")
        Check.bitEqViaJSON(COST_LAYOUT, c.COST_LAYOUT, "COST_LAYOUT")
        Check.bitEqViaJSON(COST_CUT, c.COST_CUT, "COST_CUT")
        Check.bitEqViaJSON(GAIT_MIN_SPEED, c.GAIT_MIN_SPEED, "GAIT_MIN_SPEED")
        Check.bitEqViaJSON(PERSONAL_RADIUS, c.PERSONAL_RADIUS, "PERSONAL_RADIUS")
        Check.bitEqViaJSON(SEP_RATE, c.SEP_RATE, "SEP_RATE")
        Check.bitEqViaJSON(SEP_DEADBAND, c.SEP_DEADBAND, "SEP_DEADBAND")
        Check.bitEqViaJSON(SEP_Y_SPAN, c.SEP_Y_SPAN, "SEP_Y_SPAN")
        Check.bitEqViaJSON(DISC_GRAB_R, c.DISC_GRAB_R, "DISC_GRAB_R")
        Check.bitEqViaJSON(DISC_FREE_R, c.DISC_FREE_R, "DISC_FREE_R")
        Check.bitEqViaJSON(PRONE_Y, c.PRONE_Y, "PRONE_Y")

        // A soft radius smaller than the hard one would make separation push bodies
        // together. The reference relies on this ordering without asserting it.
        Check.ok(DISC_FREE_R > DISC_GRAB_R, "the free radius is outside the grab radius")
    }

    private static func mode(_ s: String) -> MoveMode {
        MoveMode(rawValue: s) ?? .jog
    }

    private static func modeCap(_ cases: [ModeCapCase]) {
        for c in cases {
            Check.bitEqViaJSON(
                modeCapFraction(mode(c.mode), agility: c.agility), c.want,
                "modeCapFraction(\(c.mode), agility \(c.agility))")
        }
    }

    // MARK: - derive

    /// `derive` is compared as a whole struct, field by field.
    ///
    /// Eleven outputs come out of nine attributes, and the failure worth catching is two
    /// of them being swapped — `brakeMax` into `gripMax`, say. A spot check of one field
    /// passes straight through that; comparing all eleven cannot.
    private static func derived(_ cases: [DeriveCase]) {
        for c in cases {
            let got = derive(
                c.a, stamina: c.stamina, speed: c.speed, mode: mode(c.mode),
                slopeMul: c.slopeMul)
            let at = "derive(\(c.mode), stamina \(c.stamina), speed \(c.speed))"

            // These are ratios, sums and products of the attributes: bit-exact.
            Check.bitEqViaJSON(got.fatigue, c.want.fatigue, "\(at).fatigue")
            Check.bitEqViaJSON(got.slopeMul, c.want.slopeMul, "\(at).slopeMul")
            Check.bitEqViaJSON(got.topSpeed, c.want.topSpeed, "\(at).topSpeed")
            Check.bitEqViaJSON(got.modeCap, c.want.modeCap, "\(at).modeCap")
            Check.bitEqViaJSON(got.accelMax, c.want.accelMax, "\(at).accelMax")
            Check.bitEqViaJSON(got.brakeMax, c.want.brakeMax, "\(at).brakeMax")
            Check.bitEqViaJSON(got.gripMax, c.want.gripMax, "\(at).gripMax")
            Check.bitEqViaJSON(got.turnRate, c.want.turnRate, "\(at).turnRate")
            Check.bitEqViaJSON(got.jumpHeight, c.want.jumpHeight, "\(at).jumpHeight")
            Check.bitEqViaJSON(got.standingReach, c.want.standingReach, "\(at).standingReach")
            Check.bitEqViaJSON(got.plantDur, c.want.plantDur, "\(at).plantDur")
        }
    }

    private static func derivedScalars(_ g: File) {
        // `propulsiveAt` runs the speed fraction through `pow(f, 1.7)`.
        for c in g.propulsiveAtCases {
            let got = propulsiveAt(c.d, speed: c.speed ?? 0, cap: c.cap ?? 0)
            Check.near(got, c.want, transcendentalTol, "propulsiveAt(speed \(c.speed ?? 0), cap \(c.cap ?? 0))")
        }
        // Pure arithmetic on the run-up fraction.
        for c in g.leapHeightCases {
            Check.bitEqViaJSON(
                leapHeight(c.d, approachSpeed: c.approachSpeed ?? 0), c.want,
                "leapHeight(approach \(c.approachSpeed ?? 0))")
        }
        // A square root of the above — still correctly rounded, so still bit-exact.
        for c in g.takeoffVyCases {
            Check.bitEqViaJSON(
                takeoffVy(c.d, approachSpeed: c.approachSpeed ?? 0), c.want,
                "takeoffVy(approach \(c.approachSpeed ?? 0))")
        }
    }

    /// `staminaRate` has `pow(f, 2.4)` on the drain branch and plain arithmetic on the
    /// recovery branch, and the sign of the result is the branch.
    private static func stamina(_ cases: [StaminaCase]) {
        for c in cases {
            let got = staminaRate(c.a, speed: c.speed, topSpeedFresh: c.topSpeedFresh)
            Check.near(got, c.want, transcendentalTol, "staminaRate(speed \(c.speed))")
            // Draining and recovering must not be confusable: assert the sign matches
            // as well as the magnitude, since a tolerance around zero would not.
            Check.ok(
                (got < 0) == (c.want < 0),
                "staminaRate(speed \(c.speed)) agrees on drain vs recover")
        }
    }

    // MARK: - gait

    private static func gait(_ g: File) {
        for c in g.stepRateCases {
            Check.bitEqViaJSON(stepRate(c.speed), c.want, "stepRate(\(c.speed))")
        }
        for c in g.dutyFactorCases {
            Check.bitEqViaJSON(dutyFactor(c.speed), c.want, "dutyFactor(\(c.speed))")
        }
        for c in g.stanceHalfWidthCases {
            Check.bitEqViaJSON(
                stanceHalfWidth(c.speed, mode: mode(c.mode ?? "jog")), c.want,
                "stanceHalfWidth(\(c.speed), \(c.mode ?? "jog"))")
        }

        // `plantForCut` has no trig in it, unlike `advanceGait` — so it is bit-exact.
        //
        // The plant is taken on the generator's sloped test plane rather than on the
        // flat. That matters: on flat ground every plant lands at y = 0 and the whole
        // surface-height path is untested, which is how the first version of this suite
        // passed a plant that ignored the ground entirely.
        let testGround: (Double, Double) -> Double = { x, z in 0.25 * x - 0.125 * z }
        for c in g.plantForCutCases {
            let p = LocoPlayer(
                id: 1, attr: .defaultAttrs, pos: Vec3d(c.pos.x, c.pos.y, c.pos.z), t: 1.5)
            let got = plantForCut(
                p, speed: c.speed, velX: c.velX, velZ: c.velZ, turnSign: c.turnSign,
                groundY: testGround)
            let at = "plantForCut(speed \(c.speed), turn \(c.turnSign))"
            Check.eq(got.planted, c.want.planted, "\(at).planted")
            Check.eq(got.foot == .left ? "L" : "R", c.want.foot, "\(at).foot")
            Check.bitEqViaJSON(got.x, c.want.x, "\(at).x")
            Check.bitEqViaJSON(got.y, c.want.y, "\(at).y")
            Check.bitEqViaJSON(got.z, c.want.z, "\(at).z")
            Check.bitEqViaJSON(got.speed, c.want.speed, "\(at).speed")
        }
    }

    // MARK: - ground

    private static func ground(_ g: File) {
        for c in g.gradeAlongCases {
            Check.bitEqViaJSON(
                gradeAlong(Vec3d(c.n.x, c.n.y, c.n.z), dx: c.dx, dz: c.dz), c.want,
                "gradeAlong(n \(c.n.x),\(c.n.y),\(c.n.z) along \(c.dx),\(c.dz))")
        }
        for c in g.slopeMultiplierCases {
            Check.bitEqViaJSON(
                slopeMultiplier(c.grade), c.want, "slopeMultiplier(\(c.grade))")
        }
    }

    // MARK: - bodies

    /// The three named players the fixtures refer to, rebuilt to match
    /// `tools/goldens/move.ts`. If these drift the comparison is meaningless, so they
    /// are written out rather than approximated.
    private static func namedPlayer(_ who: String) -> LocoPlayer {
        switch who {
        case "airborneRising":
            LocoPlayer(
                id: 2, attr: .defaultAttrs, pos: Vec3d(0, 1.2, 0), vel: Vec3d(1, 3, 0.5),
                air: AirState(airborne: true), hipHeight: 0.9)
        case "layoutDiving":
            LocoPlayer(
                id: 3, attr: .defaultAttrs, pos: Vec3d(1, 0.6, 0.5), vel: Vec3d(2, 1.5, 0.2),
                state: .layout, air: AirState(airborne: true), hipHeight: 0.9)
        default:
            LocoPlayer(
                id: 1, attr: .defaultAttrs, pos: Vec3d(0, 0.9, 0), vel: .zero, hipHeight: 0.9)
        }
    }

    private static func bodies(_ g: File) {
        for c in g.complianceCases {
            var a = Attributes.defaultAttrs
            a.mass = c.spec.mass
            a.strength = c.spec.strength
            let p = LocoPlayer(
                id: 1, attr: a,
                state: LocoStateName(rawValue: c.spec.state ?? "idle") ?? .idle,
                prone: c.spec.prone ?? false,
                anchored: c.spec.anchored ?? false,
                air: AirState(airborne: c.spec.airborne ?? false))
            let at =
                "compliance(mass \(c.spec.mass), strength \(c.spec.strength), "
                + "state \(c.spec.state ?? "idle"), airborne \(c.spec.airborne ?? false), "
                + "prone \(c.spec.prone ?? false), anchored \(c.spec.anchored ?? false))"
            Check.near(compliance(p), c.want, transcendentalTol, at)
        }

        // Ballistic prediction: position under gravity, so bit-exact.
        for c in g.predictPosCases {
            let got = predictPos(namedPlayer(c.who), t: c.t)
            Check.bitEqViaJSON(got.x, c.want.x, "predictPos(\(c.who), t \(c.t)).x")
            Check.bitEqViaJSON(got.y, c.want.y, "predictPos(\(c.who), t \(c.t)).y")
            Check.bitEqViaJSON(got.z, c.want.z, "predictPos(\(c.who), t \(c.t)).z")
        }
        for c in g.reachAtCases {
            Check.bitEqViaJSON(
                reachAt(namedPlayer(c.who), t: c.t), c.want, "reachAt(\(c.who), t \(c.t))")
        }
    }

    // MARK: - the claims the module makes in prose

    /// Doc comments assert behaviour; behaviour can be checked. Each of these would still
    /// pass every fixture above if the sign were flipped, because a fixture only says
    /// what the reference does — not what it is supposed to mean.
    private static func claims() {
        let fresh = derive(.defaultAttrs, stamina: 100, speed: 0, mode: .sprint)
        let cooked = derive(.defaultAttrs, stamina: 0, speed: 0, mode: .sprint)
        Check.ok(cooked.fatigue > fresh.fatigue, "a tired player is more fatigued")
        Check.ok(cooked.topSpeed < fresh.topSpeed, "a tired player is slower")
        Check.ok(cooked.accelMax < fresh.accelMax, "a tired player accelerates worse")

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
        Check.bitEqViaJSON(
            gradeAlong(Vec3d(0, 1, 0), dx: 1, dz: 0), 0, "flat ground has no grade")

        // A heavier, stronger body is harder to shove.
        var light = Attributes.defaultAttrs
        light.mass = 60
        light.strength = 40
        var heavy = Attributes.defaultAttrs
        heavy.mass = 100
        heavy.strength = 90
        Check.ok(
            compliance(LocoPlayer(id: 1, attr: heavy))
                < compliance(LocoPlayer(id: 2, attr: light)),
            "a bigger, stronger player gives way less")

        // Faster running means more steps and less time with a foot down.
        Check.ok(stepRate(7) > stepRate(2), "you take more steps per second when running")
        Check.ok(dutyFactor(7) < dutyFactor(2), "less of each stride is spent on the ground")
    }

}
