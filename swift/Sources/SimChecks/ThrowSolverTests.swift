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
/// The solve has since moved out of `Engine.swift` into `Aero/ThrowSolver.swift`, and gained a
/// second axis: it solves the release BANK as well as the elevation, by secant on the probe's
/// lateral error. `bank` is compared below for exactly the reason the rest of this list is —
/// a port that dropped the secant agrees on power, spin and heading right up until the disc
/// leaves the hand.
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
/// elevation search, which evaluates the flight integrator — `atan2`, `sin`, `cos`, `exp` and a
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
        /// Absolute release speed, m/s, or null where the solve stayed inside the throw
        /// table's own band. This is the solver's fourth output and the one that makes a
        /// dump possible at all — see the THROW SOFTER note in `Aero/ThrowSolver.swift`.
        let speed: Double?
        let angle: Double
        let spin: Double
        /// Release bank, rad. The solver's second axis — see `Aero/ThrowSolver.swift`.
        let bank: Double
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
        // Three sweeps since issue #32: still air, the breeze the match used to be
        // limited to, and the strong wind issue #20 made reachable and #32 found this
        // solver blind to — see the fixture's own note and `ThrowSolver.solve`'s header.
        Check.eq(file.sweeps.count, 3, "the solver fixture sweeps still air, a breeze, and real wind")

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


                // The solved request.
                //
                // **`power` USED to be held to bit equality and no longer can be.** The
                // rationale was that it had no integrator behind it: `powerForSpeed` is a
                // subtraction and a division, and pinning it exactly is what catches a
                // constant substituted for it. That stopped being true when the solver
                // gained the power lift — a throw the flight model cannot reach at the
                // asked-for speed is now re-solved at `power * sqrt(want / reach)`, and
                // `reach` is a probe result, so the value arrives through the integrator
                // and a square root. Measured, V8 and Darwin then disagree by one ulp on
                // 73 of 480 cases, all of them hammers and scoobers past a third of range.
                //
                // 1e-12 is four decades under the smallest power in the fixture (0.12), so
                // a substituted constant is still caught at a glance; what is given up is
                // the last bit, not the assertion.
                Check.near(req.power, c.solved.power, 1e-12, "\(label): release power")
                // The absolute speed, including its absence. A port that kept the old
                // power-only solve answers every short case with the maximum-distance
                // angle instead, and this is where that shows.
                switch (req.speed, c.solved.speed) {
                case (nil, nil):
                    break
                case let (mine?, want?):
                    Check.near(mine, want, 1e-9, "\(label): absolute release speed")
                default:
                    Check.ok(
                        false,
                        "\(label): release speed is present in both or neither "
                            + "(\(String(describing: req.speed)) vs "
                            + "\(String(describing: c.solved.speed)))")
                }
                Check.near(req.angle, c.solved.angle, 1e-9, "\(label): launch elevation")
                Check.bitEqViaJSON(req.spin, c.solved.spin, "\(label): spin")
                // Bank is solved, not tabulated, so it is as much the solver's output as the
                // elevation is — and a port that dropped the secant would still agree on
                // everything else until the disc flew.
                Check.near(req.bank ?? 0, c.solved.bank, 1e-9, "\(label): release bank")
                Check.near(req.aim.x, c.solved.aimX, 1e-9, "\(label): corrected heading x")
                Check.near(req.aim.z, c.solved.aimZ, 1e-9, "\(label): corrected heading z")
                worstSolve = Swift.max(
                    worstSolve,
                    Swift.max(
                        abs(req.angle - c.solved.angle),
                        Swift.max(
                            abs(req.aim.x - c.solved.aimX),
                            abs((req.bank ?? 0) - c.solved.bank))))

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
        // `worstSolve`/`worstVel`/`worstFlight` are redundant with the report: every
        // sample that could move them already went through its own `Check.near` above,
        // each at a stated tolerance (1e-9 / 1e-6).

        shortAsksStayShort()
    }

    /// A DUMP IS NOT A BOMB. The golden pins the numbers; this states the property, in the
    /// units a reader has an opinion about.
    ///
    /// The solver used to answer any ask shorter than its own flattest carry with the
    /// MAXIMUM-distance angle — an ask it could not bracket was treated as an ask it could
    /// not reach — so a 1 m reset to a named receiver left the hand as a 19.6 m huck. The
    /// floor below is a physical one, not a tuning one: a disc released at a person's
    /// slowest throw still crosses a few metres before it can descend through the catch
    /// plane, which is the same floor the human's `MIN_THROW_SPEED` sets.
    ///
    /// **The plane the flight is measured against is the one the solver aims at**, which
    /// is `ThrowSolver.catchDrop` under the release rather than the release height itself.
    /// It has to be: `probeThrow` reports a DESCENDING crossing, and a disc released at
    /// 1.35 m and never above it cannot descend through 1.35 m — measuring against that
    /// height reports the ground contact instead, which on a 1 m ask is 4.8 m away and
    /// looks exactly like the bomb this test exists to catch.
    private static func shortAsksStayShort() {
        let e = Engine(format: .sevens, seed: 3)
        let rt = DiscRuntime()
        let from = Vec3d(0, 1.35, 0)
        for type in [ThrowType.backhand, .forehand, .hammer, .scoober, .push] {
            for want in [1.0, 2.0, 4.0, 6.0] {
                let aim = Vec3d(0, 1.35, want)
                guard
                    let req = e.solveRelease(
                        from: from, aim: aim, type: type, speed: want / 0.6,
                        throwPower: 70, hand: .right)
                else {
                    Check.ok(false, "\(type.rawValue) \(want) m solves at all")
                    continue
                }
                _ = rt.release(req)
                let plane = from.y - ThrowSolver.catchDrop
                var flown = 0.0
                var prevY = rt.state.pos.y
                for _ in 0..<(120 * 8) {
                    rt.step(dt: 1.0 / 120)
                    flown = distXZ(from, rt.state.pos)
                    if (rt.state.pos.y <= plane && prevY > plane) || rt.state.touchedGround {
                        break
                    }
                    prevY = rt.state.pos.y
                }
                Check.ok(
                    flown <= want + 3,
                    "a \(want) m \(type.rawValue) is not a bomb "
                        + "(flew \(String(format: "%.2f", flown)) m)")
            }
        }
    }
}
