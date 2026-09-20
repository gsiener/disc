import Foundation
import UltimateSim

/// The AI throw solver, stated as a contract instead of remembered as numbers.
///
/// This suite used to differ the solver against a golden fixture — 960 solved
/// throws recorded out of the reference, compared field by field. That worked
/// until converting it surfaced a genuine production bug instead of a
/// test-conversion issue: `ThrowSolver.solve` returned elevations and banks
/// whose flown trajectories missed the requested target by metres, sometimes
/// tens of metres, and its own convergence check already knew it (issue #65).
/// A fixture cannot state "the answer satisfies the request"; it can only
/// remember what the answer was, bugs included. So this suite asks the solver
/// for throws and flies them, the way `CatchBandTests` flies descents.
///
/// # What is swept
///
/// Five throw types (every type the AI throws — `AIThrowType` has five cases;
/// `blade` lives in the aero table only) × eight range fractions of the AI's
/// own `maxThrowRange` × eight headings × three winds × both hands: 1,920
/// asks, driven through the real entry point (`Engine.solveRelease`) with the
/// release speed the engine actually feeds it (`throwReleaseSpeed`, not the
/// arrival clock — asking with the wrong speed measures the speed model, not
/// the solver) and a fixed 70-power arm, so the sweep cannot move when the
/// roster generator does.
///
/// The headings matter because a disc banks: lateral error changes sign with
/// the heading, and a forehand and a backhand curve opposite ways. The hands
/// matter because bank mirrors with the hand and the secant reads its sign
/// off the flight rather than a table — a mirrored-sign bug passes every
/// right-handed case. The winds are the fixture's three regimes: still air,
/// the breeze matches used to be limited to, and the strong crosswind that
/// found this solver blind (issue #32).
///
/// # What goes red
///
/// **1. A solved throw that does not go where it was asked.** Every ask at or
/// under half of believed range in still air or breeze must land within
/// `max(1.5 m, 12% of the ask)` of its aim — 960 assertions, zero misses
/// measured. This is the #65 regression test in its permanent form: with the
/// bank ceiling back at 0.35, the overhead throws at 0.3–0.35 miss by metres
/// and this fails. Short asks are covered twice over, here and by
/// `shortAsksStayShort` below.
///
/// **2. A solved throw that holds its line but falls short is still holding
/// its line.** Past half range the arm model and the flight model disagree
/// (the AI asks for hucks neither model can throw), so distance falls short
/// by design — but the bank secant's job has no range limit, and a lateral
/// miss there means the line was never held. At 0.7 and 0.9 of range in still
/// air or breeze, the lateral offset at closest approach must meet the same
/// budget the total miss meets closer in. Measured worst case is 61% of it.
///
/// **3. The strong-wind corner gets a backstop, not a budget.** At 9.5 m/s the
/// reachable asks scatter 2–4 m, and the long fractions spray. That corner
/// belongs to issue #66 (power-lift ceiling, heading-step budget, or a joint
/// solve), not to this suite. What this suite owns there is that no reachable
/// ask ever comes back tens of metres off: every ask at or under 0.35 of
/// range in strong wind must land within 12 m, 3× under the 36.5 m worst case
/// that motivated all of this. When #66 lands, this backstop is deleted and
/// the budget scope extends over the gale.
///
/// The 8–11 m class that used to live here shared one mechanism, visible in
/// the solution, not just the miss: heading 270° against wind (9.5, 2.0) read
/// a crosswind of 2.0 minus 2e-15, so the heading secant stayed out and the
/// calm-day trim — clamped at 0.15 rad, sized for aerodynamic fade — held a
/// 5 m wind residual. The deadband gate now carries a 1e-9 epsilon for that fp
/// edge (see the reference and the port), which runs the secant there and
/// took the class from 9.8 to 3.8 m worst case. What is left is scatter, not a
/// class — and scatter may still read differently across libms, which the
/// backstop's headroom absorbs.
///
/// **4. A solve that escapes its own brackets.** Elevation within
/// `[elevLo, elevHi]`, bank within `±bankMax`, heading within `headingMax` of
/// the caller's aim — on every one of the 1,920 asks, in every wind. These
/// are structural: the clamps guarantee them bit-for-bit, so they cost
/// nothing and catch a secant that escapes its ceiling or a clamp that gets
/// deleted, which no value pin can see (the constant hasn't moved).
///
/// The tuning constants themselves — the bracket, the scan counts, the
/// tolerances, the ceilings — are pinned by value in `ConstantsTests`, where
/// values live. A relation is the right assertion for a law and the wrong one
/// for a tuning value: `latTolerance < reachTolerance` stays true while the
/// tolerance doubles and the secant stops early, which is exactly the drift
/// the pins exist to catch.
///
/// # What this suite does not assert
///
/// Bit-equality with the reference implementation. The elevation search
/// evaluates the flight integrator — `atan2`, `sin`, `cos`, `exp`, a thousand
/// accumulated steps — and a libm that differs by an ulp can flip a discrete
/// branch in the final halving. The old suite's tolerances existed for exactly
/// this; the budgets here have orders more headroom than those tolerances did.
enum ThrowSolverTests {

    /// The three wind regimes, in the fixture's order: still air, the breeze
    /// matches used to be limited to, and the strong crosswind of issue #32.
    /// Index 2 is the gale the budget does not cover — see the header.
    static let winds: [Vec2d] = [Vec2d(0, 0), Vec2d(1.2, -0.8), Vec2d(9.5, 2.0)]

    static let fractions = [0.05, 0.10, 0.15, 0.3, 0.35, 0.5, 0.7, 0.9]

    static let hands: [ThrowOptions.Hand] = [.right, .left]

    /// Backstop for the strong-wind corner issue #66 owns: no reachable ask
    /// comes back tens of metres off. Measured worst is 3.8 m against this
    /// 12.0 line (was 11.0 m before the deadband-epsilon fix); the 36.5 m
    /// worst case that motivated the #65 fix is 3× above it. The remaining
    /// 2–4 m gale scatter is the noisy residual field #66 records, not a
    /// defect class — extending the calm budget over it is still open.
    static let galeBackstop = 12.0

    static func run() throws {
        // A fixed arm, so the sweep cannot move when the roster generator does —
        // the fixture's fixed 70-power arm, spelled the same way. Only throwPower
        // and energy feed anything below: `maxThrowRange` and `throwReleaseSpeed`
        // read power (and energy), `solveRelease` derives spin from power.
        let attr = AIAttributes(
            speed: 70, acceleration: 70, agility: 70, jumping: 70, catching: 70,
            throwAccuracy: [:], throwPower: 70, decision: 70, stamina: 70,
            defAwareness: 70)
        let arm = AIPlayer(id: 0, team: 0, attr: attr, archetype: .handler)
        arm.energy = 1

        // One engine for `solveRelease`; a separate runtime to fly in. The wind
        // is set from the sweep, not left at the engine's own: `solveRelease`
        // bisects against `Engine.disc`, and that runtime carries the match's
        // breeze — so the solved elevation is a function of the wind as much as
        // of the aim.
        let e = Engine(format: .sevens, seed: 1)
        let rt = DiscRuntime()

        let from = Vec3d(0, 1.35, 0)
        var total = 0

        for (wi, wind) in winds.enumerated() {
            e.disc.wind = Vec3d(wind.x, 0, wind.z)
            rt.wind = Vec3d(wind.x, 0, wind.z)
            let gale = wi == 2
            for type in AI_THROW_TYPES {
                guard let physType = ThrowType(rawValue: type.rawValue) else {
                    Check.ok(false, "\(type.rawValue) is missing from the aero table")
                    continue
                }
                let reach = maxThrowRange(arm, type, 0)
                for fraction in fractions {
                    let range = reach * fraction
                    for step in 0..<8 {
                        let heading0 = Double(step) * .pi / 4
                        let aim = Vec3d(
                            from.x + sin(heading0) * range, from.y,
                            from.z + cos(heading0) * range)
                        let speed = throwReleaseSpeed(arm, type, range)
                        for hand in hands {
                            total += 1
                            guard
                                let req = e.solveRelease(
                                    from: from, aim: aim, type: physType, speed: speed,
                                    throwPower: arm.attr.throwPower, hand: hand)
                            else {
                                Check.ok(
                                    false,
                                    "\(type.rawValue) \(hand) \(Int(fraction * 100))% "
                                        + "\(String(format: "%.1f", range))m solves at all")
                                continue
                            }

                            let label =
                                "\(type.rawValue) \(hand) \(Int(fraction * 100))% "
                                + "\(String(format: "%.1f", range))m @\(step * 45)° "
                                + "wind\(wi)"

                            // The envelope: the solver's own brackets, on every ask.
                            Check.inRange(
                                req.angle, ThrowSolver.elevLo, ThrowSolver.elevHi,
                                "\(label): launch elevation inside the wrist bracket")
                            Check.inRange(
                                req.bank ?? 0, -ThrowSolver.bankMax, ThrowSolver.bankMax,
                                "\(label): bank inside its ceiling")
                            let solvedHeading = atan2(req.aim.x, req.aim.z)
                            // atan2 wraps; the secant clamps without wrapping, so
                            // compare the wrapped deviation, not the raw values.
                            let dev = abs(
                                atan2(
                                    sin(solvedHeading - heading0),
                                    cos(solvedHeading - heading0)))
                            Check.ok(
                                dev <= ThrowSolver.headingMax,
                                "\(label): heading within its ceiling of the aim "
                                    + "(\(String(format: "%.3f", dev)) rad)")

                            // Fly it to rest, tracking the closest approach and the
                            // lateral offset where it happened.
                            let tx = aim.x - from.x
                            let tz = aim.z - from.z
                            let want = (tx * tx + tz * tz).squareRoot()
                            let ux = tx / want
                            let uz = tz / want
                            _ = rt.release(req)
                            var closest = Double.infinity
                            var latAtClosest = 0.0
                            for _ in 0..<(120 * 8) {
                                rt.step(dt: 1.0 / 120)
                                let dx = rt.state.pos.x - from.x
                                let dz = rt.state.pos.z - from.z
                                let d = Foundation.hypot(dx - tx, dz - tz)
                                if d < closest {
                                    closest = d
                                    latAtClosest = abs(-dx * uz + dz * ux)
                                }
                                if rt.state.atRest { break }
                            }

                            let budget = Swift.max(1.5, 0.12 * want)
                            if !gale, fraction <= 0.5 {
                                // The contract: a reachable ask in air the solver
                                // claims arrives. Zero misses measured.
                                Check.near(
                                    closest, 0, budget,
                                    "\(label): lands within budget of the aim")
                            } else if gale, fraction <= 0.35 {
                                // Issue #66's corner: the budget does not hold
                                // here yet (four backhand misses by 8–11 m, long
                                // fractions spray), so this is a backstop
                                // against the tens-of-metres class, not a
                                // convergence claim.
                                Check.near(
                                    closest, 0, galeBackstop,
                                    "\(label): gale miss under the backstop (issue #66)")
                            }
                            if !gale, fraction == 0.7 || fraction == 0.9 {
                                // Past half range the arm model over-promises and
                                // distance falls short by design — but the miss
                                // must be shortfall along the line, not spray:
                                // the bank secant holds the line at any range.
                                Check.near(
                                    latAtClosest, 0, budget,
                                    "\(label): long miss is shortfall, not spray")
                            }
                        }
                    }
                }
            }
        }

        Check.eq(total, 1920, "the sweep asks every case (5 types × 8 fractions × 8 headings × 3 winds × 2 hands)")

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
