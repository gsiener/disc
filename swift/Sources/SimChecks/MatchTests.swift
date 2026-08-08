import Foundation
import UltimateSim

/// The playable match, checked by playing it.
///
/// Every other suite in this project is *differential*: it compares Swift against a
/// golden generated from the TypeScript reference, and a number that disagrees is a bug
/// by definition. This one cannot work that way, because `Play/Match.swift` has no
/// reference — `GameState.ts` and `AI.ts` are not ported yet, and the cutting and
/// marking in the interim engine are inventions.
///
/// So the bar here is different and it is stated plainly: **a game that cannot be
/// finished is broken, and a game that finishes for the wrong reason is worse.** These
/// checks play whole matches headlessly and assert the things that must hold no matter
/// how the AI is later replaced — that play terminates, that the score only moves on a
/// goal, that nobody leaves the pitch, and that no quantity ever becomes NaN.
///
/// The last one earns its place. A single NaN in a position propagates through the
/// steering into every player within one frame, and on screen it looks like players
/// simply vanishing — a symptom that gives you no clue where it started.
enum MatchTests {

    static func run() throws {
        terminates()
        staysOnTheField()
        scoreOnlyMovesOnGoals()
        throwsGoWhereAimed()
        bothFormats()
        deterministic()
    }

    /// Let both sides play themselves and require the match to reach a final score.
    ///
    /// This is the check that caught the first version's real defect. With `autoTeams`
    /// empty nobody ever releases, every possession dies on the stall, and the match runs
    /// twenty scoreless minutes — a game whose score is not broken so much as unreachable.
    /// Requiring termination is what forced the computer to actually throw.
    private static func terminates() {
        let m = Match(field: .minis, seed: 1)
        m.autoTeams = [0, 1]
        var t = 0.0
        while !m.isOver && t < 60 * 20 {
            m.step(dt: 1.0 / 60)
            t += 1.0 / 60
        }
        let s = m.stats
        Check.note(
            "match: \(Int(t))s  score \(m.score[0])-\(m.score[1])  "
                + "throws \(s.throwsMade)  completed \(s.completions) "
                + "(\(Int(s.completionRate * 100))%)  blocked \(s.blocks)  "
                + "grounded \(s.grounded)  out \(s.outOfBounds)  stalled \(s.stalled)")

        Check.ok(m.isOver, "an unattended match reaches a final score (stopped at t=\(t)s)")
        Check.ok(
            m.score[0] >= m.field.target || m.score[1] >= m.field.target,
            "the winner actually reached the target: \(m.score)")

        // A game where almost nothing is caught is not a game, whatever the score says.
        // Real Ultimate completes well over 80%; this is a floor, not a target.
        Check.ok(
            s.completionRate > 0.45,
            "throws mostly get caught (\(s.completions)/\(s.throwsMade))")
    }

    /// Nobody may end a frame outside the field, and no coordinate may go non-finite.
    private static func staysOnTheField() {
        let m = Match(field: .minis, seed: 2)
        m.autoTeams = [0, 1]
        var worstOut = 0.0

        for _ in 0..<(60 * 300) {
            m.step(dt: 1.0 / 60)
            for p in m.players {
                Check.ok(
                    p.pos.x.isFinite && p.pos.y.isFinite && p.pos.z.isFinite,
                    "player \(p.id) position stays finite")
                Check.ok(
                    p.vel.x.isFinite && p.vel.z.isFinite, "player \(p.id) velocity stays finite")
                worstOut = Swift.max(
                    worstOut,
                    Swift.max(
                        abs(p.pos.x) - m.field.sideline,
                        abs(p.pos.z) - m.field.endLine))
            }
            Check.ok(
                m.disc.pos.x.isFinite && m.disc.pos.y.isFinite && m.disc.pos.z.isFinite,
                "disc position stays finite")
        }

        // Zero slack: `steerPlayers` clamps after every integration, so any excursion at
        // all means a path that skips the clamp rather than a rounding difference.
        Check.ok(worstOut <= 0, "no player leaves the pitch (worst excursion \(worstOut) m)")
    }

    /// The score may only ever increase, by exactly one, and only when a goal is scored.
    private static func scoreOnlyMovesOnGoals() {
        let m = Match(field: .minis, seed: 3)
        m.autoTeams = [0, 1]
        var last = m.score
        var goals = 0

        for _ in 0..<(60 * 600) where !m.isOver {
            m.step(dt: 1.0 / 60)
            let now = m.score
            if now != last {
                let delta = (now[0] - last[0]) + (now[1] - last[1])
                Check.eq(delta, 1, "the score moves by exactly one")
                Check.ok(
                    now[0] >= last[0] && now[1] >= last[1], "the score never goes down")
                if case .scored = m.phase {} else {
                    Check.ok(false, "the score moved outside a scored phase")
                }
                goals += 1
                last = now
            }
        }
        Check.ok(goals > 0, "at least one goal was scored across ten minutes (\(goals))")
    }

    /// A throw released along an aim must travel roughly along that aim.
    ///
    /// This is the check that catches the coordinate-frame mistake this project already
    /// made once: `Rules.swift` puts the goal lines on z while the first flight view put
    /// them on x. A throw aimed downfield that lands sideways is exactly what that bug
    /// looks like, and nothing else in the suite would have noticed.
    private static func throwsGoWhereAimed() {
        for (label, aim) in [
            ("downfield", Vec3d(0, 0, 1)),
            ("back", Vec3d(0, 0, -1)),
            ("right", Vec3d(1, 0, 0)),
        ] {
            let m = Match(field: .full, seed: 4)
            // The computer must not throw it before this check gets to.
            m.autoTeams = []
            // Settle into a held possession before throwing.
            for _ in 0..<30 { m.step(dt: 1.0 / 60) }
            guard let h = m.holder else {
                Check.ok(false, "\(label): expected a holder after the reset")
                continue
            }

            let from = m.players[h].pos
            m.release(.backhand, aim: aim, power: 0.7)
            var flightPos = m.disc.pos
            for _ in 0..<120 {
                m.step(dt: 1.0 / 120)
                if case .flight = m.phase { flightPos = m.disc.pos } else { break }
            }

            let travelled = Vec3d(flightPos.x - from.x, 0, flightPos.z - from.z)
            Check.ok(travelled.length > 1.0, "\(label): the throw actually went somewhere")
            // Discs curve, so this is a loose cone rather than a bearing — it is checking
            // the axis mapping, not the aerodynamics, which `throws` already covers to
            // 7.7e-14 m.
            let along = travelled.normalized.dot(aim.normalized)
            Check.ok(along > 0.7, "\(label): the throw goes where it was aimed (cos \(along))")
        }
    }

    /// Both formats are playable, and the minis pitch really is endzone-sized.
    private static func bothFormats() {
        Check.eq(FieldSpec.minis.teamSize, 3, "minis is 3v3")
        Check.eq(FieldSpec.full.teamSize, 7, "full is 7v7")
        Check.eq(FieldSpec.minis.target, 7, "minis is a game to 7")

        // The claim in the plan is that a minis pitch is "the space of an endzone". A
        // regulation endzone is 37 wide by 18 deep; minis is 37 long by 18 wide, the
        // same rectangle turned so its long axis is the direction of play.
        Check.near(
            FieldSpec.minis.length, FieldSpec.full.width, 1e-12,
            "the minis pitch is as long as a regulation field is wide")
        Check.near(
            FieldSpec.minis.width, FieldSpec.full.endzoneDepth, 1e-12,
            "the minis pitch is as wide as a regulation endzone is deep")

        for spec in [FieldSpec.minis, FieldSpec.full] {
            let m = Match(field: spec, seed: 5)
            m.autoTeams = [0, 1]
            Check.eq(m.players.count, spec.teamSize * 2, "both teams are on the pitch")
            // Ten minutes. A regulation field is nearly three times as long as a minis
            // pitch and the game is to 15, so a window that comfortably finishes 3v3
            // says nothing about 7v7.
            for _ in 0..<(60 * 600) where !m.isOver { m.step(dt: 1.0 / 60) }
            Check.ok(
                m.score[0] + m.score[1] > 0,
                "\(spec.teamSize)v\(spec.teamSize): points get scored "
                    + "(\(m.score[0])-\(m.score[1]) in \(m.stats.throwsMade) throws)")
        }
    }

    /// The same seed must produce the same match, exactly.
    ///
    /// Replay is the property the whole project is built around — it is why the RNG is
    /// bit-exact and why nothing uses fast-math. A game model that quietly reads a clock
    /// or iterates a `Set` in hash order would break it, and would break it invisibly.
    private static func deterministic() {
        func play(_ seed: UInt32) -> [Double] {
            let m = Match(field: .minis, seed: seed)
            m.autoTeams = [0, 1]
            var trace: [Double] = []
            for i in 0..<(60 * 90) {
                m.step(dt: 1.0 / 60)
                if i % 37 == 0 {
                    trace.append(m.disc.pos.x)
                    trace.append(m.disc.pos.z)
                    for p in m.players { trace.append(p.pos.x); trace.append(p.pos.z) }
                }
            }
            return trace
        }

        let a = play(9)
        let b = play(9)
        Check.eq(a.count, b.count, "two runs of one seed produce the same trace length")
        var same = true
        for (x, y) in zip(a, b) where x.bitPattern != y.bitPattern { same = false }
        Check.ok(same, "the same seed replays bit-for-bit")

        Check.note("match trace: \(a.count) sampled coordinates, replayed bit-exact")
    }
}
