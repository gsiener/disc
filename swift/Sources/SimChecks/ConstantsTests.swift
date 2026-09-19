import Foundation
import UltimateSim

/// The tuning constants, pinned to their values.
///
/// # Why a suite that just restates numbers is worth having
///
/// Every other suite here asserts a *law*: a length that must be one, a rotation that must
/// round-trip, a rule of the sport the implementation has to answer to. This one does the
/// opposite, deliberately. These fifteen numbers express no derivable relationship — a disc
/// dies below 0.25 m because someone decided it does — and a law-shaped assertion about them
/// is worse than useless, because it passes while the number moves.
///
/// That is not hypothetical. `AIMathTests` asserts `CATCH_DEAD < CATCH_FLOOR`, which is true
/// and worth saying, and it stays true when `CATCH_DEAD` moves from 0.25 to 0.30. The only
/// things pinning the value were `catchband` and `divergences` — both fixtures, both being
/// deleted. The coverage would not have gone at conversion; it would have gone at deletion,
/// which is the worst moment to find out.
///
/// So: a relation is the right assertion for a law, and the wrong one for a tuning value.
/// This suite is where the values live.
///
/// # What a failure here means
///
/// Not "the code is wrong". It means a number that the rest of the simulation was tuned
/// around has changed, and the change should be deliberate. Fixing it is one line — but the
/// line is a claim, so change it in the commit that changes the constant, and say why there.
/// The number is not sacred; the silence is what this prevents.
enum ConstantsTests {

    /// Each constant, its value, and what the number means.
    ///
    /// The name and the meaning are the load-bearing parts. A reader who wants to know
    /// whether 0.85 m is a sensible floor for a catch needs to know that it is the height
    /// below which a standing catch stops being one — not that some fixture recorded 0.85.
    struct Pin {
        let name: String
        let live: Double
        let want: Double
        let meaning: String
    }

    static let pins: [Pin] = [
        // MARK: - the catch band
        //
        // Four heights that partition the air above the turf into what a receiver can do
        // with a disc arriving there. They are ordered, and the ordering is asserted
        // separately in `AIMathTests`; the numbers are here.
        Pin(name: "CATCH_DEAD", live: CATCH_DEAD, want: 0.25,
            meaning: "below this the disc has hit the turf in all but name — no catch resolves"),
        Pin(name: "CATCH_FLOOR", live: CATCH_FLOOR, want: 0.85,
            meaning: "the lowest a standing catch reaches; under it a body has to leave its feet"),
        Pin(name: "CATCH_CEILING", live: CATCH_CEILING, want: 1.45,
            meaning: "the highest a standing catch reaches, hands above the head"),
        Pin(name: "LAYOUT_CEILING", live: LAYOUT_CEILING, want: 1.10,
            meaning: "the highest a disc can arrive and still be a dive — a layout is "
                + "horizontal, so a prone body's reach ceiling is a little over a metre. "
                + "1.10 was a deliberate correction, not a port: a defender's bid guard used "
                + "to sit at 1.85, and measured over three full matches across 202k "
                + "evaluations of that branch, land.y never once exceeded 1.4498 — the guard "
                + "was inert, gated behind a height predictCatchPoint's own CATCH_CEILING "
                + "clamp (1.45) had already made unreachable. A defender was leaving his feet "
                + "for a disc he could only ever have jumped at, and spending two seconds on "
                + "the turf when he missed. 1.10 is the height a prone body actually reaches"),

        // MARK: - reach
        Pin(name: "STANDING_REACH", live: STANDING_REACH, want: 0.82,
            meaning: "how far a standing body's hands travel from its centre"),
        Pin(name: "EXTENDED_REACH", live: EXTENDED_REACH, want: 1.55,
            meaning: "the same at full extension, which is what a layout buys"),
        Pin(name: "HAND_HEIGHT", live: handHeight, want: 1.05,
            meaning: "where a held disc sits — inside the catch band, which "
                + "`AIMathTests` asserts as a relation"),

        // MARK: - bidding
        Pin(name: "BID_HESITATION", live: BID_HESITATION, want: 0.35,
            meaning: "seconds a defender spends deciding before committing to a bid"),
        Pin(name: "BID_LEAD", live: BID_LEAD, want: 0.45,
            meaning: "how far ahead of the disc a bid is aimed"),
        Pin(name: "CATCH_SLOPE", live: catchSlope, want: 0.24,
            meaning: "how fast catch probability falls away from the centre of the band"),

        // MARK: - throwing and cutting
        Pin(name: "AIM_HEIGHT", live: AIM_HEIGHT, want: 1.35,
            meaning: "the height a throw is aimed at, inside the receiver's catch band"),
        Pin(name: "LOFT_ARC", live: loftArc, want: 6.4,
            meaning: "how high a lofted throw arcs, in metres"),
        Pin(name: "LOFT_FLIGHT", live: loftFlight, want: 1.75,
            meaning: "seconds of hang a loft buys, which is what makes it a loft"),
        Pin(name: "MIN_CUT_RUN", live: MIN_CUT_RUN, want: 1.8,
            meaning: "the shortest run that counts as a cut rather than a shuffle"),
        Pin(name: "BOUNDARY_ROOM_MARGIN", live: boundaryRoomMargin, want: 0.55,
            meaning: "how far inside the line a target is kept, so a receiver arriving "
                + "at speed does not carry itself out"),

        // MARK: - the throw solver
        //
        // `ThrowSolver`'s search brackets, iteration counts, tolerances and
        // ceilings, declared in `Aero/ThrowSolver.swift`. Converted off the
        // throwsolver golden in issue #58: relations live in `ThrowSolverTests`
        // (a secant that escapes its ceiling trips the envelope laws there),
        // but a relation is the wrong assertion for a tuning value — so the
        // values live here, where a changed constant fails loudly instead of
        // drifting silently inside a still-true inequality.
        Pin(name: "SOLVE_ELEV_LO", live: ThrowSolver.elevLo, want: -0.34,
            meaning: "low end of the launch-elevation bracket, rad — the range of a human wrist"),
        Pin(name: "SOLVE_ELEV_HI", live: ThrowSolver.elevHi, want: 0.62,
            meaning: "high end of the launch-elevation bracket, rad"),
        Pin(name: "SOLVE_ELEV_SCAN", live: Double(ThrowSolver.elevScan), want: 12,
            meaning: "coarse steps across the bracket, used to find the flat root's cell"),
        Pin(name: "SOLVE_ELEV_HALVINGS", live: Double(ThrowSolver.elevHalvings), want: 5,
            meaning: "bisection halvings inside the bracketed elevation cell"),
        Pin(name: "SOLVE_PASSES", live: Double(ThrowSolver.passes), want: 6,
            meaning: "elevation solves per throw; the bank secant moves at most one step "
                + "per pass from a standing start of zero, and overhead roots sit far out"),
        Pin(name: "SOLVE_LAT_TOL", live: ThrowSolver.latTolerance, want: 0.25,
            meaning: "lateral error in metres the solver stops caring about"),
        Pin(name: "SOLVE_BANK_PROBE", live: ThrowSolver.bankProbe, want: 0.05,
            meaning: "finite-difference step in rad for the bank secant"),
        Pin(name: "SOLVE_BANK_STEP", live: ThrowSolver.bankStep, want: 0.30,
            meaning: "most bank one secant step may ask for — the secant is local, the curve is not"),
        Pin(name: "SOLVE_BANK_MAX", live: ThrowSolver.bankMax, want: 1.0,
            meaning: "bank ceiling in rad; 0.35 capped the secant below every overhead "
                + "throw's root (issue #65)"),
        Pin(name: "SOLVE_REACH_TOL", live: ThrowSolver.reachTolerance, want: 0.5,
            meaning: "how far short the flight may fall in metres before the solver reaches for more arm"),
        Pin(name: "SOLVE_POWER_LIFTS", live: Double(ThrowSolver.powerLifts), want: 2,
            meaning: "how many times one solve may lift the power toward an unreachable ask"),
        Pin(name: "SOLVE_SPEED_MIN", live: ThrowSolver.speedMin, want: 9.0,
            meaning: "slowest release in m/s the solver will ask an arm for — a person's slowest throw"),
        Pin(name: "SOLVE_SPEED_DROPS", live: Double(ThrowSolver.speedDrops), want: 2,
            meaning: "how many times one solve may drop toward the absolute release speed for a dump"),
        Pin(name: "SOLVE_HEADING_TRIM", live: ThrowSolver.headingTrim, want: 0.15,
            meaning: "clamp in rad on the residual heading trim — the calm-day case only"),
        Pin(name: "SOLVE_WIND_DEADBAND", live: ThrowSolver.windDeadband, want: 2.0,
            meaning: "crosswind in m/s below which the solve runs the calm-day trim rather than the wind secant"),
        Pin(name: "SOLVE_HEADING_PROBE", live: ThrowSolver.headingProbe, want: 0.05,
            meaning: "finite-difference step in rad for the heading secant"),
        Pin(name: "SOLVE_HEADING_STEP", live: ThrowSolver.headingStep, want: 0.5,
            meaning: "most heading one secant step may ask for in rad"),
        Pin(name: "SOLVE_HEADING_MAX", live: ThrowSolver.headingMax, want: 1.4,
            meaning: "total heading offset in rad from the caller's aim — a sanity ceiling on the secant"),
        Pin(name: "SOLVE_CATCH_DROP", live: ThrowSolver.catchDrop, want: 0.25,
            meaning: "how far under the throwing hand the solved catch plane is forced to sit, in metres"),
        Pin(name: "SOLVE_LOFT_RANGE", live: ThrowSolver.loftRange, want: 25.0,
            meaning: "at and beyond this ask distance in metres the solver throws the lofted root"),
    ]

    static func run() throws {
        for p in pins {
            Check.bitEq(p.live, p.want, "\(p.name) is \(p.want) — \(p.meaning)")
        }

        // A pin bound to the wrong symbol would pass while pinning nothing, so assert the
        // set is the size it should be rather than trusting the literal above to be whole.
        Check.eq(pins.count, 35, "every tuning constant is pinned")
        Check.eq(Set(pins.map(\.name)).count, pins.count, "no constant is pinned twice")

        // Each meaning has to be a sentence, not a shrug. The number is the easy half.
        for p in pins {
            Check.ok(p.meaning.count > 30, "\(p.name) carries a meaning, not a label")
        }
    }
}
