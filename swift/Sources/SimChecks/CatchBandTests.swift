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
///     minute. The friction entry proposed a shared constant and assertion 2 below. Neither
///     was implemented.
///   - **9 August.** `ThrowSolver.probeThrow` reports where a flight *descends through* the
///     catch plane and falls through to ground contact when that crossing never happens.
///     The plane it was handed was 1.35 m and a disc leaves a standing hand at ~1.05 m, so
///     the crossing could not fire on any flat throw and the solver was solving for the
///     disc to reach the turf at the receiver's feet. Median over 379 completions: aimed
///     9.9 m, caught at 6.8 m.
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
/// ## What goes red
///
/// **1. The band stops being one band.** Every constant is bound to the live Swift symbol
/// and compared with the reference's, and the relationships between them are asserted, not
/// remembered: the AI's rendezvous floor strictly inside the band the rules pay, the
/// last-chance height at the rules' floor plus a frame, the aim inside the band.
///
/// **2. `predictCatchPoint` returns a height the rules will not pay a catch at.** The
/// assertion the 6 August entry asked for. It is not vacuous: the disc-peer branch used to
/// report the raw height of the first sample under the floor while the glide branch
/// clamped, so on a descending disc at a 1/30 s step it returned heights far below its own
/// floor — 27 of the 75 grid cases below, three of them below the rules' floor entirely,
/// and live, 47 % of 536 k rendezvous over the eleven canonical matches, down to 0.013 m.
///
/// **3. The solver is handed an aim plane the throw cannot reach.** The one the entry did
/// not ask for, and the one that would have caught the second occurrence: a throw that never
/// rises above its aim plane cannot descend through it, and `probeThrow` answers that case
/// with the ground contact rather than an error. The ask itself is deliberately unreachable
/// — a chest — so what is asserted is the CAP, at the seam where the release height is
/// known. While that cap lived inside `solveRelease`, two modules from the caller, the plane
/// handed in was above the release on 1699 of 1699 live throws and nothing said so.
///
/// The grid is deliberately synthetic. A match produces the sample-step-skips-the-band case
/// occasionally; a fixture can produce it every time, and the 9 August bug is proof that
/// "it did not come up in eleven matches" is not the same as "it cannot happen".
enum CatchBandTests {

    // MARK: fixture

    struct Rendezvous: Decodable {
        let id: Int
        let y0: Double
        let vy: Double
        let vz: Double
        let step: Double
        let y: Double
        let z: Double
        let t: Double
        let lastZ: Double
        let lastT: Double
    }

    struct Solve: Decodable {
        let id: Int
        let fromY: Double
        let type: String
        let want: Double
        /// What the AI asked for, uncapped — `AIM_HEIGHT`.
        let asked: Double
        /// The plane the reference's solve was handed, after the cap under the release.
        let plane: Double
        /// The highest the flown disc reached. Must exceed `plane`, or the crossing test
        /// `probeThrow` performs cannot fire and the solve is against a plane the flight
        /// never touches.
        let peak: Double
        let closest: Double
    }

    struct File: Decodable {
        let note: String
        let band: [String: Double]
        let rendezvous: [Rendezvous]
        let solves: [Solve]
    }

    /// Reference constant name → the **live** Swift value. Only the binding is typed here;
    /// no number is transcribed, so a renamed symbol is a compile error and an edited one is
    /// a failed assertion. Same discipline as `DivergenceTests.mirrored`, and for the same
    /// reason — issue #21 is a fixture whose two sides were both typed by a human.
    static let live: [String: Double] = [
        "STANDING_CATCH_FLOOR": CatchDecision.standingFloor,
        "PRONE_CATCH_FLOOR": CatchDecision.proneFloor,
        "CATCH_CONTEST_RADIUS": CatchDecision.contestRadius,
        "CATCH_FLOOR": CATCH_FLOOR,
        "CATCH_CEILING": CATCH_CEILING,
        "CATCH_DEAD": CATCH_DEAD,
        "AIM_HEIGHT": AIM_HEIGHT,
        "HAND_HEIGHT": handHeight,
        // The reference declares this and reads `SOLVE_CATCH_DROP` instead, so the port
        // carries no separate symbol (see `DivergenceTests.unmirrored`). Binding the dead
        // copy to the live number is what stops the two drifting apart unnoticed.
        "CATCH_PLANE_DROP": ThrowSolver.catchDrop,
        "SOLVE_CATCH_DROP": ThrowSolver.catchDrop,
    ]

    /// A `DiscPeer` that hands back a path the caller built. The straight-line descent the
    /// fixture sweeps, not an integrator — see the generator's note on why.
    struct FixedPath: DiscPeer {
        let path: [FlightSample]
        func predictPath(_ state: AIDiscState, horizon: Double, step: Double)
            -> [FlightSample]
        { path }
    }

    /// The same four multiplications in the same order as `tools/goldens/catchband.ts`, so
    /// the path is bit-identical before `predictCatchPoint` ever sees it.
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

    // MARK: run

    static func run() throws {
        let g = try Goldens.load(File.self, "catchband")

        // --- 1. the band is one band --------------------------------------------------

        for (name, want) in g.band.sorted(by: { $0.key < $1.key }) {
            guard let got = live[name] else {
                Check.ok(
                    false,
                    "\(name) = \(want) is in the catch-band fixture and bound to no live "
                        + "Swift symbol. Bind it in `CatchBandTests.live` — an unbound "
                        + "constant is the state this suite exists to end.")
                continue
            }
            Check.bitEq(got, want, "catch band: \(name) matches the reference")
        }
        for name in live.keys.sorted() where g.band[name] == nil {
            Check.ok(
                false,
                "\(name) is bound in `CatchBandTests.live` but the fixture no longer "
                    + "carries it — drop the binding or add it to tools/goldens/catchband.ts")
        }

        // The relationships, which are the actual content of "one band". Each of these was
        // a sentence in a doc comment before it was an assertion, and every one of those
        // sentences was true when written and false by the time it mattered.
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
        // The reference declares `CATCH_PLANE_DROP` and reads `SOLVE_CATCH_DROP`; both are
        // in the fixture, and this is what keeps the unread copy from drifting away from
        // the one the game actually uses.
        Check.bitEq(
            g.band["CATCH_PLANE_DROP"] ?? .nan, g.band["SOLVE_CATCH_DROP"] ?? .nan,
            "the reference's declared catch-plane drop and the solver's live one agree")
        Check.inRange(
            AIM_HEIGHT, CatchDecision.standingFloor, CATCH_CEILING,
            "the aim height is inside the band a catch is paid out in")

        // The contest radius is NOT a height, and this is the assertion that says so.
        // `EngineHuman.bidPoint` scanned a flight for `y <= 1.9` under a comment naming
        // `CatchDecision` as its authority; 1.9 is the radius inside which an opponent
        // contests a catch, a distance between two bodies on the grass.
        Check.ok(
            CatchDecision.contestRadius > CATCH_CEILING,
            "the contest radius (\(CatchDecision.contestRadius) m, HORIZONTAL) sits outside "
                + "the height band, so using it as a ceiling accepts discs above the band — "
                + "which is the bug ADR-0007 names at EngineHuman.bidPoint")

        // --- 2. predictCatchPoint never aims under the rules' floor -------------------

        let ai = TeamAI(team: 0, dir: 1, rng: Rng(seed: 4040))
        var worstY = Double.infinity
        for c in g.rendezvous {
            let path = syntheticPath(y0: c.y0, vy: c.vy, vz: c.vz, step: c.step)
            var world = AIWorld()
            world.phase = .live
            world.disc = AIDiscState(
                pos: Vec3d(0, c.y0, 0), vel: Vec3d(0, c.vy, c.vz), state: .flight)
            world.discPeer = FixedPath(path: path)
            let cp = ai.predictCatchPoint(world)
            let tag = "rendezvous \(c.id) (y0 \(c.y0), vy \(c.vy), vz \(c.vz))"

            // The differential half: the port picks the same point as the reference. The
            // path has no integrator in it, so this is bit-exact rather than an envelope.
            Check.bitEq(cp.y, c.y, "\(tag): rendezvous height matches the reference")
            Check.bitEq(cp.z, c.z, "\(tag): rendezvous z matches the reference")
            Check.bitEq(cp.t, c.t, "\(tag): rendezvous time matches the reference")
            Check.bitEq(cp.lastT, c.lastT, "\(tag): last-chance time matches the reference")

            // THE ASSERTION THE 6 AUGUST ENTRY ASKED FOR.
            Check.ok(
                cp.y >= CatchDecision.standingFloor,
                "\(tag): the rendezvous is at a height the rules will pay a standing catch "
                    + "at — got \(cp.y), floor \(CatchDecision.standingFloor). Below this "
                    + "the receiver has been sent somewhere only a dive is legal.")
            // And the AI's own, stronger floor, which its doc comment has always claimed
            // and which one of its two branches did not honour.
            Check.ok(
                cp.y >= CATCH_FLOOR,
                "\(tag): the rendezvous is inside the AI's own band — got \(cp.y), floor "
                    + "\(CATCH_FLOOR). Both branches of predictCatchPoint clamp; a value "
                    + "under this means one of them stopped.")
            worstY = Swift.min(worstY, cp.y)
        }
        Check.ok(
            worstY >= CATCH_FLOOR,
            "lowest rendezvous over the whole grid is \(worstY), floor \(CATCH_FLOOR)")

        // --- 3. the solver is never handed a plane the throw cannot reach --------------

        // The AI's ask is a PREFERENCE and it is deliberately unreachable — a chest, which
        // no flat throw gets to. What has to be true is that the ask is capped before the
        // solver sees it, by the site that knows this throw's release height. That site is
        // `Engine.solveThrow` / `Game.aiThrow`; the assertion is at that seam, because
        // that is where the precondition either holds or does not.
        Check.ok(
            AIM_HEIGHT > handHeight - ThrowSolver.catchDrop,
            "the AI's ask (\(AIM_HEIGHT) m) is above what the modelled release can deliver "
                + "(\(handHeight - ThrowSolver.catchDrop) m) — it is a preference, and the "
                + "assertions below are about the cap, not about the ask. If this ever "
                + "goes false the cap has become dead code and these checks are vacuous.")

        // Every case is a release height a real roster produces, which is what the
        // throwsolver fixture does not sweep: that one releases from 1.35 m, where a 1.35 m
        // ask clamps to 1.10 and the crossing fires anyway. The bug needs a body.
        var worstMargin = Double.infinity
        var capped = 0
        for c in g.solves {
            let tag = "solve \(c.id) (\(c.type) \(String(format: "%.1f", c.want)) m from "
                + "\(c.fromY) m)"
            // Recomputed the way the engine does it, not read from the fixture, so a port
            // that caps differently fails here rather than agreeing by transcription.
            let plane = clamp(
                c.asked, CatchDecision.standingFloor, c.fromY - ThrowSolver.catchDrop)
            Check.bitEq(plane, c.plane, "\(tag): the capped catch plane matches the reference")

            // THE ASSERTION THAT MAKES THIS BUG CLASS A RED TEST. Red for every throw in
            // the game while the cap lived inside `solveRelease` and the ask reached it
            // unmodified — 1699 of 1699 over the eleven canonical matches.
            Check.ok(
                plane <= c.fromY - ThrowSolver.catchDrop,
                "\(tag): the plane handed to the solver sits under the release "
                    + "(\(plane) <= \(c.fromY) - \(ThrowSolver.catchDrop)). A throw that "
                    + "never rises above its aim plane cannot descend through it, and "
                    + "probeThrow answers that case with the ground contact.")
            // And the consequence, flown: the disc actually gets above the plane, so the
            // descending-crossing test has something to fire on.
            Check.ok(
                c.peak > plane,
                "\(tag): the flight rises above the plane it was solved against — peak "
                    + "\(c.peak), plane \(plane). When it does not, probeThrow reports the "
                    + "ground contact and the solve is against a plane the disc never meets.")
            if plane < c.asked { capped += 1 }
            worstMargin = Swift.min(worstMargin, c.peak - plane)
        }
        Check.ok(
            worstMargin > 0,
            "every solved throw in the sweep clears its own catch plane — worst margin "
                + "\(worstMargin) m")
        // If the cap never binds the sweep is not exercising it, and the assertion above
        // is true for a reason that has nothing to do with the code under test.
        Check.ok(
            capped == g.solves.count,
            "the cap binds on every case in the sweep (\(capped) of \(g.solves.count)) — a "
                + "sweep the cap never touches would pass with the cap deleted")
    }
}
