import Foundation
import UltimateSim

/// The catch decision — every catch, drop, block and interception in the game.
///
/// This is the function the components add up *to*. The defender-attacking gate, the roll
/// itself, the `interceptionSplit` and `catchReach` could each be broken with every
/// component check still green, which is why it has its own suite.
///
/// # Why this needs no recorded outcomes
///
/// `decide` takes its randomness as `roll: () -> Double`, so the roll is an input rather
/// than a draw. That turns the thing worth asserting into a law: **the outcome is a step
/// function of the roll, and the step is exactly at `p`.** A fixture that lists what
/// happened at a grid of rolls is a sampling of that step; asserting the step itself is
/// stronger, because it holds at every roll rather than at the twenty somebody chose.
///
/// So each scenario is evaluated by bisecting the roll axis to find where the outcome
/// changes, and the threshold that comes back is compared against the `p` the same call
/// reported. Nothing is transcribed.
enum TryCatchTests {

    // MARK: - scenarios

    /// An ordinary player. Every rating the same, so a scenario is about geometry rather
    /// than about which attribute the decision happened to read — `AIMathTests` is where
    /// the per-rating dependencies are pinned.
    static let ordinary = AIAttributes(
        speed: 60, acceleration: 60, agility: 60, jumping: 60, catching: 60,
        throwAccuracy: [.backhand: 60, .forehand: 60, .hammer: 60, .scoober: 60, .push: 60],
        throwPower: 60, decision: 60, stamina: 60, defAwareness: 60)

    /// A body, built from the few fields that actually steer the decision. The defaults are
    /// an ordinary standing receiver; each scenario changes only what it is about.
    static func body(
        id: Int, team: TeamId, x: Double, z: Double,
        state: String = "run", prone: Bool = false, airborne: Bool = false,
        groundY: Double = 0, hipHeight: Double = 0.95, reachTop: Double = 2.05,
        attacking: Bool = true, energy: Double = 1.0
    ) -> CatchDecision.Body {
        CatchDecision.Body(
            id: id, team: team, pos: Vec3d(x, 0, z), state: state, prone: prone,
            airborne: airborne, groundY: groundY, hipHeight: hipHeight, reachTop: reachTop,
            attacking: attacking, attr: ordinary, energy: energy)
    }

    /// The roll at which the outcome changes, found by bisection.
    ///
    /// Returns `nil` when the outcome never changes across the whole interval — which is a
    /// real answer, not a failure: a body that cannot reach the disc at all produces the
    /// same outcome at every roll, and a scenario claiming otherwise is the bug.
    static func threshold(
        _ evaluate: (Double) -> CatchDecision.Outcome?
    ) -> (low: CatchDecision.Outcome?, high: CatchDecision.Outcome?, at: Double)? {
        let atZero = evaluate(0.0)
        let atOne = evaluate(0.999_999)
        guard atZero != atOne else { return nil }
        var lo = 0.0, hi = 0.999_999
        // 60 halvings takes the bracket well below an ulp of the probabilities involved,
        // so the threshold that comes back is the real one and not the search's resolution.
        for _ in 0..<60 {
            let mid = (lo + hi) / 2
            if evaluate(mid) == atZero { lo = mid } else { hi = mid }
        }
        return (atZero, atOne, (lo + hi) / 2)
    }

    static func run() throws {

        // MARK: - an uncontested catch steps exactly at p

        // One receiver, nobody near, disc at chest height in his hands. The only question
        // is the roll, so the outcome must be a clean step and the step must be `p`.
        do {
            let disc = Vec3d(0, 1.2, 0)
            let vel = Vec3d(0, 0, -8)
            let bodies = [body(id: 1, team: 0, x: 0, z: 0)]
            var reported = 0.0
            let step = threshold { r in
                let d = CatchDecision.decide(
                    discPos: disc, discVel: vel, pull: false, offence: 0,
                    bodies: bodies, roll: { r })
                if let d { reported = d.p }
                return d?.outcome
            }
            Check.ok(step != nil, "an uncontested catch has a roll that changes the outcome")
            if let step {
                Check.eq(step.low, .catchDisc, "a roll under p is a catch")
                Check.ok(step.high == .drop, "a roll over p is a drop (\(String(describing: step.high)))")
                // The whole claim of this suite, in one line.
                Check.near(step.at, reported, 1e-9, "the outcome steps exactly at the reported p")
                Check.inRange(reported, 0.0, 1.0, "p is a probability")
            }
        }

        // MARK: - the reach is a hard edge

        // `catchReach` is a distance, so it partitions the plane: a body inside it can take
        // the disc at some roll, a body outside it cannot at any roll. Asserting the edge
        // is what pins the constant — a relation would survive moving it.
        do {
            let disc = Vec3d(0, 1.2, 0)
            func reachable(_ gap: Double) -> Bool {
                CatchDecision.decide(
                    discPos: disc, discVel: .zero, pull: false, offence: 0,
                    bodies: [body(id: 1, team: 0, x: gap, z: 0)], roll: { 0.0 }) != nil
            }
            Check.ok(reachable(CatchDecision.catchReach - 0.01), "inside catchReach the disc is playable")
            Check.ok(!reachable(CatchDecision.catchReach + 0.01), "outside it, nothing is")

            // And a layout buys the longer reach, which is the point of leaving your feet.
            func layoutReachable(_ gap: Double) -> Bool {
                CatchDecision.decide(
                    discPos: disc, discVel: .zero, pull: false, offence: 0,
                    bodies: [body(id: 1, team: 0, x: gap, z: 0, state: "layout")],
                    roll: { 0.0 }) != nil
            }
            Check.ok(
                layoutReachable(CatchDecision.layoutReach - 0.01),
                "a layout reaches further")
            Check.ok(!layoutReachable(CatchDecision.layoutReach + 0.01), "but not indefinitely")
            Check.ok(
                CatchDecision.layoutReach > CatchDecision.catchReach,
                "which is the whole reason to leave your feet")
        }

        // MARK: - the vertical band

        // Above the reach top plus its margin, or below the standing floor, there is no
        // catch at any roll. The band is the catch band, asserted as an edge rather than
        // sampled at heights somebody picked.
        do {
            func playable(_ y: Double, state: String = "run", prone: Bool = false) -> Bool {
                CatchDecision.decide(
                    discPos: Vec3d(0, y, 0), discVel: .zero, pull: false, offence: 0,
                    bodies: [body(id: 1, team: 0, x: 0, z: 0, state: state, prone: prone)],
                    roll: { 0.0 }) != nil
            }
            let top = 2.05 + 0.16
            Check.ok(playable(top - 0.01), "just under the reach ceiling is playable")
            Check.ok(!playable(top + 0.01), "over it is not")
            Check.ok(playable(CatchDecision.standingFloor + 0.01), "just over the standing floor is playable")
            Check.ok(!playable(CatchDecision.standingFloor - 0.01), "under it is not")
            Check.ok(
                CatchDecision.proneFloor < CatchDecision.standingFloor,
                "a prone body reaches lower than a standing one — that is what a dive is for")
        }

        // MARK: - the passive-defender gate

        // A defender who is not attacking the disc only takes it from very close. That gate
        // is `passiveDefenderGap`, and it applies to the defence and not to the offence —
        // which is the asymmetry worth asserting, because a gate applied to both would look
        // correct in any single scenario.
        do {
            let disc = Vec3d(0, 1.2, 0)
            let gap = CatchDecision.passiveDefenderGap + 0.05
            func taker(team: TeamId, attacking: Bool) -> Int? {
                CatchDecision.decide(
                    discPos: disc, discVel: .zero, pull: false, offence: 0,
                    bodies: [body(id: 7, team: team, x: gap, z: 0, attacking: attacking)],
                    roll: { 0.0 })?.takerId
            }
            Check.eq(taker(team: 1, attacking: false), nil, "a passive defender beyond the gap does not take it")
            Check.eq(taker(team: 1, attacking: true), 7, "an attacking defender at the same gap does")
            Check.eq(taker(team: 0, attacking: false), 7, "and the gate does not apply to the offence")
        }

        // MARK: - a defender's failed roll is a block, an offence's is a drop

        do {
            let disc = Vec3d(0, 1.2, 0)
            func outcome(team: TeamId, roll: Double) -> CatchDecision.Outcome? {
                CatchDecision.decide(
                    discPos: disc, discVel: .zero, pull: false, offence: 0,
                    bodies: [body(id: 3, team: team, x: 0, z: 0)], roll: { roll })?.outcome
            }
            Check.eq(outcome(team: 1, roll: 0.0), .interception, "a defender who makes the play intercepts")
            // A defender who misses does NOT block — the disc simply carries on, and the
            // decision reports nothing rather than an event. `block` belongs to a different
            // path; asserting it here was an assumption, and the code disagreed.
            Check.eq(
                outcome(team: 1, roll: 0.999_999), CatchDecision.Outcome.none,
                "and one who does not leaves the disc in the air")
            Check.eq(outcome(team: 0, roll: 0.0), .catchDisc, "an offensive player catches")
        }

        // MARK: - a pull is its own set of outcomes

        do {
            let disc = Vec3d(0, 1.2, 0)
            func outcome(roll: Double) -> CatchDecision.Outcome? {
                CatchDecision.decide(
                    discPos: disc, discVel: .zero, pull: true, offence: 0,
                    bodies: [body(id: 4, team: 0, x: 0, z: 0)], roll: { roll })?.outcome
            }
            Check.eq(outcome(roll: 0.0), .pullCatch, "a caught pull is a pull-catch, not a catch")
            let missed = outcome(roll: 0.999_999)
            Check.ok(
                missed == .pullDrop || missed == .pullTouch,
                "and a missed one is a pull-drop or a pull-touch (\(String(describing: missed)))")
        }

        // MARK: - the constants this module owns

        // Pinned by value, because these are tuning numbers and a relation survives moving
        // them — the lesson `CATCH_DEAD` taught when only a fixture held its value.
        Check.bitEq(CatchDecision.catchReach, 0.82, "catchReach is 0.82 m — a standing body's hands")
        Check.bitEq(CatchDecision.layoutReach, 1.55, "layoutReach is 1.55 m — at full stretch")
        Check.bitEq(CatchDecision.standingFloor, 0.20, "standingFloor is 0.20 m")
        Check.bitEq(CatchDecision.proneFloor, 0.02, "proneFloor is 0.02 m — a prone body is almost on the turf")
        Check.bitEq(CatchDecision.contestRadius, 1.9, "contestRadius is 1.9 m")
        Check.bitEq(CatchDecision.passiveDefenderGap, 0.55, "passiveDefenderGap is 0.55 m")
        Check.bitEq(CatchDecision.defenceScale, 0.62, "defenceScale is 0.62 — a D is harder than a catch")
        Check.bitEq(CatchDecision.interceptionSplit, 0.55, "interceptionSplit is 0.55")
        Check.bitEq(CatchDecision.dropThreshold, 0.85, "dropThreshold is 0.85")
        Check.bitEq(CatchDecision.layoutStretch, 0.90, "layoutStretch is 0.90")
    }
}
