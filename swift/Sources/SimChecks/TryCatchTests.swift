import Foundation
import UltimateSim

/// The catch decision, differed against the reference.
///
/// The second differential suite for the integration layer, and the one mutation testing
/// asked for by name: the defender attacking gate, the catch roll, the `p * 0.55`
/// interception split and `catchReach` could each be broken with every component golden
/// still green, because this is the function the components add up *to* — every catch,
/// drop, block and interception in the game goes through it.
///
/// The fixture (`tools/goldens/trycatch.ts`) evaluates hand-built scenarios at a fixed
/// grid of rolls, one scenario per branch that has to survive. The outcome at every
/// roll is compared by name, which is what pins the thresholds rather than one draw.
///
/// `difficulty` and `p` are held to 1e-12, not bit equality, and the reason is one
/// specific operation: the disc's speed. The reference takes it with JavaScript's
/// `Math.hypot(vx, vy, vz)` and this port with `Vec3d.length` (a square root of a sum),
/// and the two round differently — the first run of this suite failed by exactly one
/// ulp of `difficulty` on the hot-disc layout scenario, both sides correct. Everything
/// downstream is multiply-add-clamp, so an ulp stays an ulp; 1e-12 is ~3500× that with
/// the worst observed deviation reported alongside, same policy as the throw solver.
enum TryCatchTests {

    private struct Disc: Decodable {
        let x: Double
        let y: Double
        let z: Double
        let vx: Double
        let vy: Double
        let vz: Double
    }

    private struct Body: Decodable {
        let id: Int
        let team: Int
        let x: Double
        let z: Double
        let state: String
        let prone: Bool
        let airborne: Bool
        let groundY: Double
        let hipHeight: Double
        let reachTop: Double
        let attacking: Bool
        let catching: Double
        let energy: Double
    }

    private struct Scenario: Decodable {
        let name: String
        let disc: Disc
        let pull: Bool
        let offence: Int?
        let bodies: [Body]
        let taker: Int?
        let difficulty: Double?
        let p: Double?
        let laidOut: Bool?
        let contest: Double?
        let outcomes: [String]
    }

    private struct File: Decodable {
        let note: String
        let rolls: [Double]
        let scenarios: [Scenario]
    }

    /// Only `catching` (and `energy`, passed separately) reach `catchProbability`;
    /// everything else is a fixed 70 so the fixture cannot depend on it by accident.
    private static func attr(catching: Double) -> AIAttributes {
        AIAttributes(
            speed: 70, acceleration: 70, agility: 70, jumping: 70, catching: catching,
            throwAccuracy: [:], throwPower: 70, decision: 70, stamina: 70, defAwareness: 70)
    }

    static func run() throws {
        let file = try Goldens.load(File.self, "trycatch")
        Check.ok(file.scenarios.count >= 20, "the catch fixture has scenarios (\(file.scenarios.count))")

        var branches = Set<String>()
        var worst = 0.0
        for s in file.scenarios {
            let bodies = s.bodies.map {
                CatchDecision.Body(
                    id: $0.id, team: $0.team,
                    pos: Vec3d($0.x, 0, $0.z),
                    state: $0.state, prone: $0.prone, airborne: $0.airborne,
                    groundY: $0.groundY, hipHeight: $0.hipHeight, reachTop: $0.reachTop,
                    attacking: $0.attacking,
                    attr: attr(catching: $0.catching), energy: $0.energy)
            }
            let discPos = Vec3d(s.disc.x, s.disc.y, s.disc.z)
            let discVel = Vec3d(s.disc.vx, s.disc.vy, s.disc.vz)
            let offence: TeamId? = s.offence

            for (i, roll) in file.rolls.enumerated() {
                let d = CatchDecision.decide(
                    discPos: discPos, discVel: discVel, pull: s.pull, offence: offence,
                    bodies: bodies, roll: { roll })
                let outcome = d?.outcome.rawValue ?? "no-taker"
                Check.eq(outcome, s.outcomes[i], "\(s.name) @ roll \(roll)")
                branches.insert(outcome)
                if i == 0, let d {
                    Check.eq(d.takerId, s.taker ?? -1, "\(s.name): the same body takes it")
                    Check.near(d.difficulty, s.difficulty ?? .nan, 1e-12, "\(s.name): difficulty")
                    Check.near(d.p, s.p ?? .nan, 1e-12, "\(s.name): probability")
                    // The two facts the decision used to keep to itself. `Engine.grade`
                    // reads them now instead of writing the same expressions a second
                    // time, so they are differed here like everything else.
                    Check.eq(d.laidOut, s.laidOut ?? false, "\(s.name): laid out")
                    Check.bitEqViaJSON(
                        d.contest, s.contest ?? .nan, "\(s.name): contest term")
                    worst = Swift.max(
                        worst,
                        Swift.max(
                            abs(d.difficulty - (s.difficulty ?? .nan)),
                            abs(d.p - (s.p ?? .nan))))
                }
            }
        }

        // The fixture is only a fixture if it exercises every branch. A regenerated
        // sweep that quietly loses one (a scenario edit, a constant drift on the TS
        // side) fails here rather than passing on a narrower comparison.
        for want in [
            "catch", "drop", "none", "no-taker", "interception", "block",
            "pull-catch", "pull-drop", "pull-touch",
        ] {
            Check.ok(branches.contains(want), "the fixture reaches the \(want) branch")
        }
        // `worst` is redundant with the report: every sample that could move it already
        // went through `Check.near(..., 1e-12, ...)` above; scenario/roll coverage is
        // asserted by the branch-reachability loop just above.
    }
}
