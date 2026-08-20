import Foundation
import UltimateSim

/// **ONE CATCH-HEIGHT BAND — issue #4, and the two assertions nobody implemented twice.**
///
/// The rules engine owns the height a catch is paid out at: `CatchDecision.decide` refuses
/// a standing catch below `groundY + standingFloor` and lowers the floor to `proneFloor`
/// only for a body already horizontal. Every consumer used to carry its own number —
/// `1.45`, `1.35`, `0.12`, `0.85`, `0.20`, `0.35`, and a horizontal `1.9` pressed into
/// service as a height ceiling — and that has produced the same bug twice, from opposite
/// ends, five days apart:
///
///   - **6 August.** `predictCatchPoint` scanned for the first sample under a floor of its
///     own, `0.12`, and sent receivers to meet the disc where only a dive is legal. 80 % of
///     all bids were for a disc predicted under 0.2 m; the offence laid out 4.5 times a
///     minute.
///   - **9 August.** `ThrowSolver.probeThrow` reports where a flight *descends through* the
///     catch plane and falls through to ground contact when that crossing never happens.
///     The plane it was handed was 1.35 m and a disc leaves a standing hand at ~1.05 m, so
///     the crossing could not fire on any flat throw and the solver was solving for the
///     disc to reach the turf at the receiver's feet.
///
/// ## The taxonomy, because "one band" over-unifies
///
/// Four different quantities were wearing the same metres, and collapsing all four onto one
/// constant would be wrong:
///
/// | quantity | who owns it | value |
/// |---|---|---|
/// | the floor the rules pay a standing catch at | `CatchDecision` | 0.20 (0.02 prone) |
/// | the band a *rendezvous* may be picked in | `AIMath` | 0.85 … 1.45 |
/// | the height a throw is *aimed* to arrive at | `AIMath` | 1.35, a preference |
/// | the radius that makes a catch contested | `CatchDecision` | 1.9, **horizontal** |
///
/// The first three are heights and they are ordered; the fourth is a distance between two
/// bodies on the grass and shares nothing with them but the unit. It is asserted below to
/// be *outside* the band, so it can never quietly become a ceiling again — which is exactly
/// what `EngineHuman.bidPoint` had done with it.
///
/// # Why this needs no fixture
///
/// Every value the fixture used to pin is pinned by value elsewhere now — the four heights
/// and the two reach radii in `ConstantsTests`, the six catch-decision constants in
/// `TryCatchTests` — so the mirroring this suite used to do (a table of names bound to live
/// symbols, compared against a reference-scraped copy) is redundant with suites that catch a
/// moved constant more directly, by value rather than by relation.
///
/// What is not redundant, and what this suite still owns, are the two shapes of bug in the
/// header above. Both are properties of the AI's own functions under a swept input, not
/// recorded numbers, so both are generated here rather than read from a file — the sweep
/// this suite runs is wider than the one the fixture carried, not narrower.
///
/// ## What goes red
///
/// **1. The band stops being one band.** The relationships between the four quantities are
/// asserted, not remembered: the AI's rendezvous floor strictly inside the band the rules
/// pay, the last-chance height at the rules' floor plus a frame, the aim inside the band,
/// the contest radius outside it.
///
/// **2. `predictCatchPoint` returns a height the rules will not pay a catch at.** Swept over
/// every combination of a starting height, vertical and lateral speed, and sample step in
/// `grid` below — 6 × 5 × 4 × 3 = 360 synthetic descents, wider than the 75-case fixture it
/// replaces, chosen to bracket the floor from both sides the way the 6 August descent did.
///
/// **3. The plane handed to the solver is capped under the release.** Exercised through
/// `Engine.solveRelease`, the real entry point, rather than a reimplementation of `clamp`
/// compared to itself: two asks that both exceed the ceiling must solve to bit-identical
/// requests, because both are clamped to the same value before the solver ever sees them,
/// and an ask genuinely under the ceiling must solve to a different one.
///
/// What this suite does **not** assert: that a solved throw's flight actually rises above
/// the plane it was capped against. That is a property of the solver's own answer — "does
/// what it returns satisfy the request" — and belongs to `ThrowSolverTests`, which states
/// the solver's contract directly rather than through this suite's cap.
enum CatchBandTests {

    /// A straight-line descent, sampled the way a real prediction is: fixed step, `x = 0`.
    /// Not an integrator — see the module note on `DiscPeer` for why a straight line is the
    /// harder case, not an easier one: an integrated arc has more headroom before its first
    /// sample crosses the floor than a line does.
    static func syntheticPath(y0: Double, vy: Double, vz: Double, step: Double)
        -> [FlightSample]
    {
        var out: [FlightSample] = []
        out.reserveCapacity(181)
        for i in 0...180 {
            let t = Double(i) * step
            out.append(FlightSample(t: t, x: 0, y: y0 + vy * t, z: vz * t))
        }
        return out
    }

    /// A `DiscPeer` that hands back a path built ahead of time, rather than integrating one.
    struct FixedPath: DiscPeer {
        let path: [FlightSample]
        func predictPath(_ state: AIDiscState, horizon: Double, step: Double)
            -> [FlightSample]
        { path }
    }

    static func run() throws {

        // --- 1. the band is one band --------------------------------------------------

        Check.ok(
            CATCH_FLOOR > CatchDecision.standingFloor,
            "the AI's rendezvous floor (\(CATCH_FLOOR)) is strictly above the height the "
                + "rules pay a standing catch at (\(CatchDecision.standingFloor)) — a "
                + "rendezvous at or under the rules' floor is a dive the AI did not ask for")
        Check.ok(
            CATCH_FLOOR - CatchDecision.standingFloor >= 0.5,
            "and it clears it by a stride (\(CATCH_FLOOR - CatchDecision.standingFloor) m), "
                + "so the last stride into the catch has somewhere to happen")
        Check.bitEq(
            CATCH_DEAD, CatchDecision.standingFloor + 0.05,
            "the last-chance height is the rules' standing floor plus a frame of margin")
        Check.ok(
            CATCH_CEILING > CATCH_FLOOR,
            "the rendezvous band is a band: ceiling \(CATCH_CEILING) above floor \(CATCH_FLOOR)")
        Check.inRange(
            AIM_HEIGHT, CatchDecision.standingFloor, CATCH_CEILING,
            "the aim height is inside the band a catch is paid out in")

        // The contest radius is NOT a height. `EngineHuman.bidPoint` once scanned a flight
        // for `y <= 1.9` under a comment naming `CatchDecision` as its authority; 1.9 is the
        // radius inside which an opponent contests a catch, a distance between two bodies
        // on the grass, and using it as a ceiling accepts discs above the band.
        Check.ok(
            CatchDecision.contestRadius > CATCH_CEILING,
            "the contest radius (\(CatchDecision.contestRadius) m, HORIZONTAL) sits outside "
                + "the height band")

        // The tuning value this suite is the only owner of.
        Check.bitEq(
            ThrowSolver.catchDrop, 0.25,
            "catchDrop is 0.25 m — how far under the release a solved throw's catch plane "
                + "is allowed to sit")

        // --- 2. predictCatchPoint never returns a height the rules will not pay --------

        // Brackets the floor from both sides on purpose: y0 spans comfortably above it to
        // comfortably below, vy carries a level and a diving path, vz varies how far the
        // disc travels before the sample step catches it, and step is swept because a
        // coarser step is what let the 6 August bug's line skip past the floor between
        // samples rather than landing on it.
        let y0s: [Double] = [2.2, 1.7, 1.2, 0.9, 0.5, 0.1]
        let vys: [Double] = [-0.5, -1.5, -3.0, -6.0, -12.0]
        let vzs: [Double] = [0.0, 4.0, 8.0, 12.0]
        let steps: [Double] = [1.0 / 30, 1.0 / 60, 1.0 / 120]

        let ai = TeamAI(team: 0, dir: 1, rng: Rng(seed: 4040), field: .standard)
        var worstY = Double.infinity
        var swept = 0
        for y0 in y0s {
            for vy in vys {
                for vz in vzs {
                    for step in steps {
                        swept += 1
                        let path = syntheticPath(y0: y0, vy: vy, vz: vz, step: step)
                        var world = AIWorld()
                        world.phase = .live
                        world.disc = AIDiscState(
                            pos: Vec3d(0, y0, 0), vel: Vec3d(0, vy, vz), state: .flight)
                        world.discPeer = FixedPath(path: path)
                        let cp = ai.predictCatchPoint(world)
                        let tag = "y0 \(y0) vy \(vy) vz \(vz) step \(step)"

                        // THE ASSERTION THE 6 AUGUST ENTRY ASKED FOR.
                        Check.ok(
                            cp.y >= CatchDecision.standingFloor,
                            "\(tag): the rendezvous is at a height the rules will pay a "
                                + "standing catch at — got \(cp.y), floor "
                                + "\(CatchDecision.standingFloor). Below this the receiver "
                                + "has been sent somewhere only a dive is legal.")
                        // And the AI's own, stronger floor, which its doc comment has
                        // always claimed and which one of its two branches did not honour.
                        Check.ok(
                            cp.y >= CATCH_FLOOR,
                            "\(tag): the rendezvous is inside the AI's own band — got "
                                + "\(cp.y), floor \(CATCH_FLOOR). Both branches of "
                                + "predictCatchPoint clamp; a value under this means one of "
                                + "them stopped.")
                        worstY = Swift.min(worstY, cp.y)
                    }
                }
            }
        }
        Check.eq(swept, y0s.count * vys.count * vzs.count * steps.count, "the sweep ran every combination")
        Check.ok(
            worstY >= CATCH_FLOOR,
            "lowest rendezvous over the whole sweep is \(worstY), floor \(CATCH_FLOOR)")

        // The same floor, through the OTHER half of `predictCatchPoint` — the fallback
        // glide integrator, used whenever there is no peer to ask. A discPeer sweep alone
        // cannot reach this code at all, and it has its own two clamp sites: one on the
        // ordinary descent-through-the-ceiling case, one on a disc that never crosses the
        // band within the six-second horizon and falls through to the final fallback.
        var worstGlideY = Double.infinity
        for y0 in y0s {
            for vy in vys {
                for vz in vzs {
                    var world = AIWorld()
                    world.phase = .live
                    world.disc = AIDiscState(pos: Vec3d(0, y0, 0), vel: Vec3d(0, vy, vz), state: .flight)
                    // discPeer left nil — routes straight to the glide integrator.
                    let cp = ai.predictCatchPoint(world)
                    let tag = "glide y0 \(y0) vy \(vy) vz \(vz)"
                    Check.ok(
                        cp.y >= CatchDecision.standingFloor,
                        "\(tag): the glide integrator's rendezvous pays a legal catch — "
                            + "got \(cp.y), floor \(CatchDecision.standingFloor)")
                    Check.ok(
                        cp.y >= CATCH_FLOOR,
                        "\(tag): and honours the AI's own band — got \(cp.y), floor \(CATCH_FLOOR)")
                    worstGlideY = Swift.min(worstGlideY, cp.y)
                }
            }
        }
        // A disc that starts far above the band and falls too slowly to reach it inside
        // the six-second horizon: `met` is never set, and the loop exits by time. This is
        // the one case in the whole suite that reaches the POST-loop fallback rather than
        // the in-loop one — free fall over 6 s covers only about 56 m, so starting at 200 m
        // with no initial vertical speed leaves the disc around 144 m up when the horizon
        // ends, nowhere near the ceiling.
        do {
            var world = AIWorld()
            world.phase = .live
            world.disc = AIDiscState(pos: Vec3d(0, 200, 0), vel: Vec3d(0, 0, 0), state: .flight)
            let cp = ai.predictCatchPoint(world)
            Check.ok(
                cp.y >= CatchDecision.standingFloor,
                "a disc that never reaches the band within the horizon still clamps at "
                    + "the fallback — got \(cp.y)")
            Check.ok(cp.t >= 5.9, "and reports the full horizon, not an early exit (t=\(cp.t))")
            worstGlideY = Swift.min(worstGlideY, cp.y)
        }
        Check.ok(
            worstGlideY >= CATCH_FLOOR,
            "lowest glide-integrator rendezvous over the whole sweep is \(worstGlideY), "
                + "floor \(CATCH_FLOOR)")

        // The `Swift.max(y, CATCH_FLOOR)` on the loop's POST-exit fallback line — reached
        // only when `met` stayed nil for the full six seconds — is provably a no-op given
        // this integrator, not an untested branch. `vy` is strictly decreasing every tick
        // (`vy -= 3.1 * h`, nothing opposes it, nothing bounces), so once it first goes
        // negative it stays negative. `met` only stays nil past that point while
        // `y > CATCH_CEILING`, so if it is still nil when the loop's six seconds run out,
        // `y` at that moment is necessarily above the ceiling — and the ceiling sits above
        // `CATCH_FLOOR`. There is no initial condition under which this line's `max` can
        // ever raise `y`, and a check that cannot distinguish the clamp present from the
        // clamp deleted is not exercising it, however the input is chosen. Asserted rather
        // than pretended: the one case that reaches this line (`y0: 200`, above) always
        // arrives above the ceiling, never near the floor the clamp guards.
        Check.ok(
            CATCH_CEILING > CatchDecision.standingFloor,
            "the fallback's clamp is provably dead: met can only stay nil while y is above "
                + "the ceiling, and the ceiling (\(CATCH_CEILING)) already sits above the "
                + "floor (\(CatchDecision.standingFloor)) the clamp exists to enforce")

        // --- 3. the plane handed to the solver is capped under the release -------------

        // The AI's ask is a PREFERENCE and it is deliberately unreachable — a chest, which
        // no flat throw gets to. What has to be true is that the ask is capped before the
        // solver sees it, at the seam where the release height is known — `Engine.solveRelease`,
        // which computes the same `clamp(aim.y, CatchDecision.standingFloor, from.y -
        // ThrowSolver.catchDrop)` its own comment calls "bit-identical to the clamp
        // downstream" inside `ThrowSolver.solve`.
        //
        // The property is observable without reading `catchY` at all: **two asks that both
        // exceed the ceiling clamp to the same value, so they must solve to the same
        // request.** That is exercised through the real entry point, not a reimplementation
        // of `clamp` compared to itself — the four mutations this replaced a self-check
        // with (removing either clamp bound, at either of the two sites) each go red
        // against this version and did not against the one it replaced.
        Check.ok(
            AIM_HEIGHT > handHeight - ThrowSolver.catchDrop,
            "the AI's ask (\(AIM_HEIGHT) m) is above what the modelled release can deliver "
                + "(\(handHeight - ThrowSolver.catchDrop) m) — it is a preference, and the "
                + "assertions below are about the cap, not about the ask. If this ever "
                + "goes false the cap has become dead code and these checks are vacuous.")

        let e = Engine(format: .sevens, seed: 4242)
        e.disc.wind = .zero

        func solved(from: Vec3d, askY: Double, want: Double) -> ThrowRequest? {
            e.solveRelease(
                from: from, aim: Vec3d(0, askY, want), type: .backhand, speed: 15,
                throwPower: 70, hand: .right)
        }

        // `Engine.solveRelease` clamps `aim.y` to the ceiling BEFORE it ever reaches
        // `ThrowSolver.solve`, which has the identical clamp inside it — belt and braces,
        // per its own header. That means a sweep through `solved` above can never hand
        // `ThrowSolver.solve` an out-of-range `catchY`, so it cannot tell that clamp broken
        // from working. This calls `ThrowSolver.solve` directly, the raw ask un-clamped by
        // anything in between, so the clamp actually under test is the one exercised.
        let rt = DiscRuntime()
        rt.wind = .zero
        func solvedDirect(from: Vec3d, catchY0: Double, want: Double) -> ThrowRequest {
            // Straight down the +z axis, so heading is 0 and the aim direction is (0,0,1)
            // without needing UltimateSim's internal trig wrapper from test code.
            let power = clamp(powerForSpeed(.backhand, 15) * 1.02, 0.12, 1)
            var req = ThrowRequest(
                type: .backhand, from: from, aim: Vec3d(0, 0, 1),
                power: power, angle: 0.02, spin: 0.7, hand: .right, bank: 0)
            ThrowSolver.solve(
                rt, &req, heading0: 0, want: want, catchY: catchY0,
                wind: Vec2d(0, 0))
            return req
        }

        // Release heights a real roster produces, low sidearm to tall standing.
        let releaseYs: [Double] = [0.65, 0.85, 1.05, 1.25, 1.45, 1.65]
        var boundPairs = 0
        for fromY in releaseYs {
            let ceiling = fromY - ThrowSolver.catchDrop
            let from = Vec3d(0, fromY, 0)

            // Two asks that are always above the ceiling regardless of release height —
            // one a metre over it, one five — must solve identically, because both clamp
            // to the same catchY before the solver ever sees them.
            guard
                let modest = solved(from: from, askY: ceiling + 1.0, want: 10),
                let absurd = solved(from: from, askY: ceiling + 5.0, want: 10)
            else {
                Check.ok(false, "\(fromY) m release: both above-ceiling asks solve at all")
                continue
            }
            Check.bitEq(
                modest.angle, absurd.angle,
                "from \(fromY) m: two asks above the ceiling solve to the same elevation "
                    + "— both clamp to \(ceiling) m before the solver sees them")
            Check.eq(
                modest.bank, absurd.bank,
                "from \(fromY) m: and the same bank")
            boundPairs += 1

            // The AI's own chest-height preference is capped only when it genuinely
            // exceeds this release's ceiling — otherwise the ask is already reachable and
            // is not, and should not be, touched.
            if AIM_HEIGHT > ceiling, let atPreference = solved(from: from, askY: AIM_HEIGHT, want: 10) {
                Check.bitEq(
                    atPreference.angle, modest.angle,
                    "from \(fromY) m: the AI's chest-height ask, which exceeds this "
                        + "release's ceiling, solves the same as any other above-ceiling ask")
            }

            // `ThrowSolver.solve`'s own clamp, exercised directly — the ceiling half.
            // The ask exactly at the ceiling and asks a little and a lot above it, all
            // un-clamped by anything upstream, must reach the solver at the same catchY
            // and so solve identically. The small excess matters: two asks that are both
            // absurdly high can both saturate the elevation search at its own bound
            // (`ThrowSolver.elevHi`) and agree for a reason that has nothing to do with
            // this clamp — the first version of this check compared two such asks and did
            // not notice the clamp was gone.
            let directAtCeiling = solvedDirect(from: from, catchY0: ceiling, want: 10)
            let directModest = solvedDirect(from: from, catchY0: ceiling + 0.05, want: 10)
            let directAbsurd = solvedDirect(from: from, catchY0: ceiling + 5.0, want: 10)
            Check.bitEq(
                directAtCeiling.angle, directModest.angle,
                "from \(fromY) m: ThrowSolver.solve's own ceiling clamp — an ask exactly "
                    + "at the ceiling and one a little above it solve identically")
            Check.bitEq(
                directAtCeiling.angle, directAbsurd.angle,
                "from \(fromY) m: and one far above it solves the same too")

            // The floor half. Two raw asks below the rules' standing floor must also both
            // clamp to the same value and solve identically.
            let directLow = solvedDirect(
                from: from, catchY0: CatchDecision.standingFloor - 0.10, want: 10)
            let directLower = solvedDirect(
                from: from, catchY0: CatchDecision.standingFloor - 0.50, want: 10)
            Check.bitEq(
                directLow.angle, directLower.angle,
                "from \(fromY) m: ThrowSolver.solve's own floor clamp — two raw asks "
                    + "below it solve identically")

            // And the un-clamped middle actually differs from the clamped ceiling case,
            // so the two clamped results above are equal because of the clamp and not
            // because the solver ignores catchY.
            if ceiling > CatchDecision.standingFloor + 0.05 {
                let directMiddle = solvedDirect(
                    from: from, catchY0: (CatchDecision.standingFloor + ceiling) / 2, want: 10)
                Check.ok(
                    abs(directMiddle.angle - directModest.angle) > 1e-6,
                    "from \(fromY) m: an un-clamped middle ask solves differently than the "
                        + "clamped ceiling case — \(directMiddle.angle) vs \(directModest.angle)")
            }

            // An ask genuinely below the ceiling is a different request and, for a throw
            // with real carry, solves to a measurably different elevation — confirming the
            // capped cases above are equal *because* of the clamp and not because the
            // solver is insensitive to catchY altogether.
            if ceiling > CatchDecision.standingFloor + 0.05 {
                guard let atFloor = solved(from: from, askY: CatchDecision.standingFloor, want: 10)
                else { continue }
                Check.ok(
                    abs(atFloor.angle - modest.angle) > 1e-6,
                    "from \(fromY) m: an ask actually at the rules' floor solves to a "
                        + "different elevation than a capped above-ceiling ask — "
                        + "\(atFloor.angle) vs \(modest.angle)")
            }
        }
        Check.ok(
            boundPairs == releaseYs.count,
            "every release height in the sweep produced a comparable pair (\(boundPairs) of "
                + "\(releaseYs.count))")
    }
}
