import Foundation
import UltimateSim

/// The integration layer, checked by playing it.
///
/// **This suite is deliberately weaker than every other one here, and says so.** Every
/// other suite is differential: it compares Swift against a golden generated from the
/// TypeScript, and a number that disagrees is a bug by definition. `Engine` has no
/// counterpart to differ against — `src/sim/Game.ts` is engine glue that imports three.js
/// and the web input layer, so there is nothing to generate a golden from.
///
/// So these are property assertions. They cannot tell you the wiring matches the
/// reference, because nothing can. What they can tell you is that the wiring does not
/// violate the things that must hold however it is written: play terminates, the score
/// only moves on a goal, nobody leaves the pitch, nothing goes non-finite, and one seed
/// is one match.
///
/// The components underneath are a different matter — `TeamAI` is 445,734 assertions
/// against a 1,280-frame trace, locomotion is 87,643, the flight model is exact to
/// 5e-15 m. What is unvalidated here is only the joins between them.
enum EngineTests {

    static func run() throws {
        buildsBothFormats()
        playsWithoutBlowingUp()
        scoreOnlyMovesOnGoals()
        theHumanCannotThrowADiscTheyDoNotHave()
        theCountRunsOut()
        deterministic()
    }

    /// A minis engine is three a side on the minis pitch; a sevens engine is seven on the
    /// regulation one. The whole reason `GameFormat` exists.
    private static func buildsBothFormats() {
        let minis = Engine(format: .minis, seed: 1)
        Check.eq(minis.players.count, 6, "a minis engine fields six players")
        Check.eq(minis.target, 7, "a minis game is to 7")
        Check.bitEqViaJSON(minis.format.field.length, 37, "on a 37 m pitch")

        let sevens = Engine(format: .sevens, seed: 1)
        Check.eq(sevens.players.count, 14, "a sevens engine fields fourteen players")
        Check.eq(sevens.target, 15, "a regulation game is to 15")
        Check.bitEqViaJSON(sevens.format.field.length, 100, "on a 100 m pitch")

        // Both TeamAIs exist and attack opposite ways, or there is no game.
        Check.eq(minis.ai.count, 2, "both sides have an AI")
        Check.ok(minis.dirFor(0) == -minis.dirFor(1), "the two teams attack opposite ways")
    }

    /// Ten minutes of 3v3 with both sides automated. Nothing here may go non-finite, and
    /// nobody may end a tick off the pitch.
    ///
    /// A NaN in one position propagates through the AI's distance sums into every
    /// decision within a frame, and on screen it looks like players simply vanishing — a
    /// symptom that tells you nothing about where it started. Checking every tick is what
    /// makes the first bad frame the reported one.
    private static func playsWithoutBlowingUp() {
        let e = Engine(format: .minis, seed: 7)
        e.autoTeams = [0, 1]
        var worstOut = 0.0
        var airborneSeen = false

        for _ in 0..<(120 * 600) where !e.isOver {
            e.step(dt: 1.0 / 120)
            for p in e.players {
                Check.ok(
                    p.pos.x.isFinite && p.pos.y.isFinite && p.pos.z.isFinite,
                    "player \(p.id) position stays finite")
                Check.ok(
                    p.vel.x.isFinite && p.vel.z.isFinite, "player \(p.id) velocity stays finite")
                Check.ok(
                    p.energy >= 0.12 && p.energy <= 1,
                    "player \(p.id) energy stays on its rails (\(p.energy))")
                worstOut = Swift.max(
                    worstOut,
                    Swift.max(
                        abs(p.pos.x) - e.format.field.sideline,
                        abs(p.pos.z) - e.format.field.endLine))
                if p.airborne { airborneSeen = true }
            }
            let d = e.disc.state.pos
            Check.ok(d.x.isFinite && d.y.isFinite && d.z.isFinite, "the disc stays finite")
        }

        // Locomotion clamps to the field, so any excursion at all is a path that skipped
        // the clamp. A metre of slack is allowed for a body carried out by momentum on
        // the very frame it crosses, which the reference also permits.
        Check.ok(worstOut < 1.0, "players stay on the pitch (worst excursion \(worstOut) m)")

        Check.note(
            "engine: \(Int(e.clock))s  score \(e.score[0])-\(e.score[1])  "
                + "throws \(e.stats.throwsMade)  completed \(e.stats.completions)  "
                + "blocked \(e.stats.blocks)  grounded \(e.stats.grounded)  "
                + "out \(e.stats.outOfBounds)  airborne seen: \(airborneSeen)")

        Check.ok(e.stats.throwsMade > 0, "the AI actually throws (\(e.stats.throwsMade))")
    }

    /// The score may only ever rise, by exactly one, and only on a goal.
    private static func scoreOnlyMovesOnGoals() {
        let e = Engine(format: .minis, seed: 11)
        e.autoTeams = [0, 1]
        var last = e.score
        var goals = 0

        for _ in 0..<(120 * 900) where !e.isOver {
            e.step(dt: 1.0 / 120)
            if e.score != last {
                let delta = (e.score[0] - last[0]) + (e.score[1] - last[1])
                Check.eq(delta, 1, "the score moves by exactly one")
                Check.ok(
                    e.score[0] >= last[0] && e.score[1] >= last[1], "the score never falls")
                Check.ok(e.justScored != nil, "a score is accompanied by a scoring team")
                goals += 1
                last = e.score
            }
        }
        Check.note("engine: \(goals) goals in fifteen simulated minutes")
    }

    /// The human may not throw a disc they are not holding.
    ///
    /// Worth an assertion rather than a comment: the failure mode is not a crash, it is a
    /// second disc appearing mid-flight, and every downstream assertion would still pass.
    private static func theHumanCannotThrowADiscTheyDoNotHave() {
        let e = Engine(format: .minis, seed: 13)
        e.autoTeams = []

        // Settle, then throw legitimately.
        for _ in 0..<60 { e.step(dt: 1.0 / 120) }
        let held = e.carrier
        Check.ok(held != nil, "someone is holding after the reset")

        if held == e.controlled {
            Check.ok(
                e.humanRelease(.backhand, aim: Vec3d(0, 0, 1), power: 0.6),
                "the controlled holder can throw")
            Check.ok(e.carrier == nil, "and the disc leaves their hand")
            // Now they are not holding, so a second release must be refused.
            Check.ok(
                !e.humanRelease(.backhand, aim: Vec3d(0, 0, 1), power: 0.6),
                "a second throw with no disc is refused")
        } else {
            Check.ok(
                !e.humanRelease(.backhand, aim: Vec3d(0, 0, 1), power: 0.6),
                "a player who is not holding cannot throw")
        }
    }

    /// A possession the human never throws must end on the count.
    ///
    /// The first build of `Engine` had no stall at all. With the computer switched off
    /// for team 0, its handler simply stood there and the count on screen climbed past
    /// thirteen — which is not a rules edge case, it is the game hanging. Nothing in the
    /// suite noticed, because both other tests automate both teams and the AI throws long
    /// before the count matters.
    private static func theCountRunsOut() {
        let e = Engine(format: .minis, seed: 17)
        // Nobody throws: not the computer, and no human input either.
        e.autoTeams = []

        for _ in 0..<60 { e.step(dt: 1.0 / 120) }
        guard let first = e.carrier else {
            Check.ok(false, "somebody is holding to start with")
            return
        }
        let firstTeam = e.players.first { $0.id == first }?.team

        // Run past the count with a margin.
        for _ in 0..<Int(120 * (Double(e.rules.stallMax) + 2)) { e.step(dt: 1.0 / 120) }

        Check.ok(e.stats.stalled > 0, "the count ran out at least once (\(e.stats.stalled))")
        Check.ok(
            e.stall <= Double(e.rules.stallMax),
            "the count never exceeds stallMax (reached \(e.stall))")
        let nowTeam = e.carrier.flatMap { id in e.players.first { $0.id == id }?.team }
        Check.ok(
            nowTeam != nil, "somebody still has the disc after the turnover")
        Check.ok(
            nowTeam != firstTeam,
            "a stall-out hands the disc to the other team")
    }

    /// One seed, one match — the property the whole project is built on.
    ///
    /// This reaches further than `MatchTests`' version, because the interim engine drew
    /// from the RNG exactly once (a throw-type coin flip) while this one draws a whole
    /// roster and forks two independent AI streams. If the fork salt or the roster draw
    /// order ever changes, this fails.
    private static func deterministic() {
        func play(_ seed: UInt32) -> [Double] {
            let e = Engine(format: .minis, seed: seed)
            e.autoTeams = [0, 1]
            var trace: [Double] = []
            for i in 0..<(120 * 120) {
                e.step(dt: 1.0 / 120)
                if i % 97 == 0 {
                    trace.append(e.disc.state.pos.x)
                    trace.append(e.disc.state.pos.z)
                    for p in e.players { trace.append(p.pos.x); trace.append(p.pos.z) }
                }
            }
            return trace
        }

        let a = play(21)
        let b = play(21)
        Check.eq(a.count, b.count, "two runs of a seed produce the same trace length")
        var same = true
        for (x, y) in zip(a, b) where x.bitPattern != y.bitPattern { same = false }
        Check.ok(same, "the same seed replays bit-for-bit")

        // And a different seed must actually differ, or the check above is vacuous.
        let c = play(22)
        var differs = false
        for (x, y) in zip(a, c) where x.bitPattern != y.bitPattern { differs = true }
        Check.ok(differs, "a different seed produces a different match")

        Check.note("engine trace: \(a.count) sampled coordinates, replayed bit-exact")
    }
}
