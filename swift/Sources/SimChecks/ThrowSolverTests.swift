import Foundation
import UltimateSim

/// The AI throw solver, differed against the reference.
///
/// **This is the first differential suite the integration layer has ever had.** Every other
/// suite here compares a ported *component* against a golden; `Engine` had none, because its
/// header claimed for most of the project that `src/sim/Game.ts` was "not a port target …
/// integration glue rather than simulation". That was wrong, and the throw solver is the
/// clearest case: it is a self-contained numerical function, it was invented here instead of
/// translated, and the invention was wrong in three separate ways.
///
/// Property assertions were added after the fact and they do help — one of them measures the
/// solver flown against nobody, which is the only way to see it at all. But a property check
/// asks "is this plausible"; a golden asks "is this the same". For a function that is a
/// transcription of a reference function, the second question is the right one, and mutation
/// testing showed why: four separate breaks of this solver — deleting the lateral-drift
/// correction, discarding the elevation bisection, replacing `powerForSpeed` with a constant,
/// and solving to the ground instead of chest height — all left 2.2 million assertions green.
///
/// What is compared, per case:
///
///   - the **solved request** — power, elevation, spin, and the corrected heading. This is
///     the solver's own output and the thing a mutation changes first.
///   - the **released velocity**, so a solver that agrees but hands the disc runtime
///     something different still fails.
///   - the **flown result** — closest approach to the aim, and where it came to rest — so
///     that agreement is end-to-end and not just at the seam.
///
/// Tolerances rather than bit-equality, and the reason is specific. `powerForSpeed` is
/// division and could be pinned exactly, but everything downstream of it runs through the
/// bisection, which evaluates the flight integrator — `atan2`, `sin`, `cos`, `exp` and a
/// thousand accumulated steps. A libm that differs by an ulp moves the seventh halving's
/// comparison and can select a neighbouring elevation, which is a discrete branch flip, not
/// drift. So the assertion is a stated envelope and the *worst observed* deviation is
/// reported alongside it, which is what tells you when something is creeping.
enum ThrowSolverTests {

    private struct Vec: Decodable {
        let x: Double
        let y: Double?
        let z: Double
    }

    private struct Solved: Decodable {
        let power: Double
        let angle: Double
        let spin: Double
        let aimX: Double
        let aimZ: Double
    }

    private struct Flight: Decodable {
        let closest: Double
        let steps: Int
        let restX: Double
        let restZ: Double
    }

    private struct Case: Decodable {
        let type: String
        let fraction: Double
        let range: Double
        let speed: Double
        let from: Vec
        let aim: Vec
        let solved: Solved
        let released: Vec
        let flight: Flight
    }

    private struct Sweep: Decodable {
        let wind: Vec
        let cases: [Case]
    }

    private struct File: Decodable {
        let note: String
        let sweeps: [Sweep]
    }

    static func run() throws {
        let file = try Goldens.load(File.self, "throwsolver")
        Check.eq(file.sweeps.count, 2, "the solver fixture sweeps still air and a breeze")

        // One engine for `solveRelease`; a separate runtime to fly in.
        let e = Engine(format: .sevens, seed: 1)
        let rt = DiscRuntime()

        var worstSolve = 0.0
        var worstVel = 0.0
        var worstFlight = 0.0
        var skipped = 0
        var total = 0

        for sweep in file.sweeps {
            // **The wind is set from the fixture, not left at the engine's own.**
            //
            // `solveRelease` bisects against `Engine.disc`, and that runtime carries the
            // match's breeze — so the solved elevation is a function of the wind as much as of
            // the aim. This suite was first written against a still-air fixture and an engine
            // that had just been given weather, and it disagreed by up to 0.6 rad with both
            // sides correct. The bisection's last halving is a discrete branch: a nudged probe
            // picks a neighbouring angle rather than drifting by an ulp.
            e.disc.wind = Vec3d(sweep.wind.x, 0, sweep.wind.z)
            rt.wind = Vec3d(sweep.wind.x, 0, sweep.wind.z)
            total += sweep.cases.count
            for c in sweep.cases {
                guard let type = ThrowType(rawValue: c.type) else {
                    skipped += 1
                    continue
                }
                let from = Vec3d(c.from.x, c.from.y ?? 0, c.from.z)
                let aim = Vec3d(c.aim.x, c.aim.y ?? 0, c.aim.z)
                guard
                    let req = e.solveRelease(
                        from: from, aim: aim, type: type, speed: c.speed,
                        throwPower: 70, hand: .right)
                else {
                    Check.ok(false, "\(c.type) at \(c.range) m solves at all")
                    continue
                }

                let label = "\(c.type) \(Int(c.fraction * 100))% \(String(format: "%.1f", c.range))m"

                // The solved request. `power` is the one value with no integrator behind it —
                // `powerForSpeed` is a subtraction and a division — so it is held to bit
                // equality, which is what catches a constant substituted for it.
                Check.bitEqViaJSON(req.power, c.solved.power, "\(label): release power")
                Check.near(req.angle, c.solved.angle, 1e-9, "\(label): launch elevation")
                Check.bitEqViaJSON(req.spin, c.solved.spin, "\(label): spin")
                Check.near(req.aim.x, c.solved.aimX, 1e-9, "\(label): corrected heading x")
                Check.near(req.aim.z, c.solved.aimZ, 1e-9, "\(label): corrected heading z")
                worstSolve = Swift.max(
                    worstSolve,
                    Swift.max(abs(req.angle - c.solved.angle), abs(req.aim.x - c.solved.aimX)))

                // The velocity handed to the disc.
                let vel = rt.release(req)
                Check.near(vel.x, c.released.x, 1e-9, "\(label): release velocity x")
                Check.near(vel.y, c.released.y ?? 0, 1e-9, "\(label): release velocity y")
                Check.near(vel.z, c.released.z, 1e-9, "\(label): release velocity z")
                worstVel = Swift.max(worstVel, abs(vel.x - c.released.x))

                // And the flight it produces, end to end.
                var closest = Double.infinity
                var steps = 0
                for _ in 0..<(120 * 8) {
                    rt.step(dt: 1.0 / 120)
                    steps += 1
                    closest = Swift.min(closest, distXZ(aim, rt.state.pos))
                    if rt.state.atRest { break }
                }
                Check.eq(steps, c.flight.steps, "\(label): the flight lasts as long")
                Check.near(closest, c.flight.closest, 1e-6, "\(label): closest approach to the aim")
                Check.near(rt.state.pos.x, c.flight.restX, 1e-6, "\(label): comes to rest at x")
                Check.near(rt.state.pos.z, c.flight.restZ, 1e-6, "\(label): comes to rest at z")
                worstFlight = Swift.max(worstFlight, abs(closest - c.flight.closest))
            }
        }

        Check.eq(skipped, 0, "every throw type in the fixture exists in the aero table")
        Check.ok(total > 200, "the solver fixture has cases (\(total))")
        Check.note(
            "throw solver golden: \(total) cases, worst solve deviation "
                + "\(worstSolve), worst release velocity \(worstVel), worst flown "
                + "\(worstFlight)")
    }
}
