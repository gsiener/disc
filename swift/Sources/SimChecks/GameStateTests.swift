import Foundation
import UltimateSim

/// The game state machine, against `src/sim/GameState.ts`.
///
/// The fixture is a **script**, not a table: each scenario is a list of actions, and
/// after every single action the reference's snapshot, its return value and the names of
/// the events it emitted were recorded. This suite replays the identical script and
/// compares all three, in order.
///
/// That shape is chosen for what it catches. The failures worth finding in a state
/// machine are ordering failures — a method that is right in isolation but sets a flag
/// one line too late gives you a game that works until the third turnover. No amount of
/// per-method spot-checking finds that; a trace finds it on the step where the two
/// machines first disagree, which is also the step where the bug is.
///
/// Three things are compared and each earns its place:
///
///  - **The snapshot**, because it is the state.
///  - **The return value**, because a refusal is behaviour. `release()` in the wrong
///    phase must return `ok: false` *and change nothing*, and a port that quietly
///    permitted it would pass any fixture built only from legal sequences. The scripts
///    deliberately attempt illegal actions.
///  - **The event names, in order**, because events are the renderer's entire contract
///    with the sim. A renamed or reordered event breaks the game without changing a
///    single number, so nothing else in this project would notice.
enum GameStateTests {

    // MARK: fixture shapes

    struct Snap: Decodable {
        let phase: String
        let clock: Double
        let point: Int
        let half: Int
        let score: [Int]
        let possession: Int?
        let thrower: Int?
        let stall: Int
        let attackDir: [Int]
        let pullingTeam: Int
        let target: Int
        let cap: String
    }

    struct Step: Decodable {
        let op: String
        /// Nil for the actions the reference declares `void`.
        let ok: Bool?
        let events: [String]
        let snap: Snap
    }

    /// Mirrors the `Action` union in `tools/goldens/gamestate.ts`. Every optional here is
    /// optional there; a required field decoded as optional would silently default and
    /// replay a different script than the one that was recorded.
    struct Action: Decodable {
        let op: String
        let team: Int?
        let ids: [Int]?
        let dt: Double?
        let puller: Int?
        let player: Int?
        let defender: Int?
        let caller: Int?
        let against: Int?
        let receiver: Int?
        let from: [Double]?
        let vel: [Double]?
        let at: [Double]?
        let pos: [Double]?
        let crossing: [Double]?
        let choice: String?
        let type: String?
        let contested: Bool?
    }

    struct TeamTotals: Decodable {
        let score: Int
        let goals: Int
        let assists: Int
        let blocks: Int
        let attempts: Int
        let completions: Int
        let throwaways: Int
        let drops: Int
        let stallOuts: Int
        let turnoversCommitted: Int
        let turnoversForced: Int
        let yardsThrown: Double
        let yardsReceived: Double
        let timeOfPossession: Double
        let possessions: Int
    }

    struct Scenario: Decodable {
        let label: String
        let format: String
        /// Per-scenario match clock. 0 for both is "no clock", which is every scenario
        /// but the timed one.
        let softCapAt: Double
        let hardCapAt: Double
        let actions: [Action]
        let steps: [Step]
        let teams: [TeamTotals]
        let logLines: Int
    }

    struct File: Decodable {
        let note: String
        let scenarios: [Scenario]
    }

    static func run() throws {
        let g = try Goldens.load(File.self, "gamestate")
        Check.ok(!g.scenarios.isEmpty, "there are gamestate scenarios to replay")

        var replayed = 0
        for s in g.scenarios {
            replay(s)
            replayed += s.steps.count
        }

        minis()
        agreesWithRulesFreeFunctions()

        Check.note("gamestate: \(g.scenarios.count) scenarios, \(replayed) scripted actions replayed")
    }

    // MARK: replay

    private static func vec(_ a: [Double]?) -> Vec3d? {
        guard let a, a.count == 3 else { return nil }
        return Vec3d(a[0], a[1], a[2])
    }

    private static func replay(_ s: Scenario) {
        var events: [String] = []
        var opts = GameStateOptions()
        // Physics events on, because those are precisely the ones a renderer consumes
        // and therefore the ones a rename would break silently.
        opts.rules = {
            $0.emitPhysicsEvents = true
            $0.softCapAt = s.softCapAt
            $0.hardCapAt = s.hardCapAt
        }
        opts.emit = { events.append($0.name) }
        let game = GameState(opts)

        Check.eq(s.actions.count, s.steps.count, "\(s.label): one recorded step per action")

        for (i, a) in s.actions.enumerated() {
            guard i < s.steps.count else { break }
            let want = s.steps[i]
            events.removeAll()

            var got: ActionResult? = nil
            switch a.op {
            case "startGame": game.startGame()
            case "setLine": game.setLine(a.team ?? 0, a.ids ?? [])
            case "step": game.step(a.dt ?? 0)
            case "pull": got = game.pull(a.puller ?? -1, vec(a.from) ?? .zero, vec(a.vel))
            case "pullCaught": got = game.pullCaught(a.player ?? -1, vec(a.at) ?? .zero)
            case "pullDropped": got = game.pullDropped(a.player ?? -1, vec(a.at) ?? .zero)
            case "pullLanded": got = game.pullLanded(vec(a.at) ?? .zero)
            case "pullOutOfBounds":
                got = game.pullOutOfBounds(
                    vec(a.crossing) ?? .zero, a.choice.flatMap(PullSpotChoice.init(rawValue:)))
            case "choosePullSpot":
                got = game.choosePullSpot(
                    a.choice.flatMap(PullSpotChoice.init(rawValue:)) ?? .brick)
            case "pickUp": got = game.pickUp(a.player ?? -1, vec(a.at))
            case "check": got = game.check()
            case "setPivot": game.setPivot(vec(a.at) ?? .zero)
            case "release":
                got = game.release(playerId: a.player, pos: vec(a.pos), vel: vec(a.vel))
            case "catch": got = game.catchDisc(a.player ?? -1, vec(a.at) ?? .zero)
            case "drop": got = game.drop(a.player ?? -1, vec(a.at) ?? .zero)
            case "ground": got = game.ground(vec(a.at) ?? .zero)
            case "outOfBounds": got = game.outOfBounds(vec(a.crossing) ?? .zero)
            case "caughtOutOfBounds":
                got = game.caughtOutOfBounds(a.player ?? -1, vec(a.at) ?? .zero)
            case "block": got = game.block(a.defender ?? -1, vec(a.at) ?? .zero)
            case "advanceAfterScore": game.advanceAfterScore()
            case "resumeFromHalftime": game.resumeFromHalftime()
            case "callTimeout": got = game.callTimeout(a.team ?? 0, a.player)
            case "endTimeout": game.endTimeout()
            case "makeCall":
                got = game.makeCall(
                    a.type.flatMap(CallType.init(rawValue:)) ?? .foul,
                    a.caller ?? -1, a.against ?? -1, vec(a.at))
            case "resolveCall":
                got = game.resolveCall(a.contested ?? false, receiverId: a.receiver)
            case "applySoftCap": game.applySoftCap()
            case "applyHardCap": game.applyHardCap()
            default:
                Check.ok(false, "\(s.label) step \(i): unknown op \(a.op)")
                continue
            }

            let at = "\(s.label) step \(i) (\(a.op))"

            // A method the reference declares `void` must be void here too. If the port
            // started returning a result the fixture could not express it, and the two
            // would be quietly out of step.
            if let wantOk = want.ok {
                Check.eq(got?.ok, wantOk, "\(at): ok")
            } else {
                Check.ok(got == nil, "\(at): returns nothing, as the reference does")
            }

            Check.eq(events, want.events, "\(at): emitted events, in order")
            compare(game.snapshot(), want.snap, at)
        }

        // Accumulated totals. A single miscounted completion is invisible in any one
        // snapshot and unmissable here, because every step of the trace fed into it.
        for t in 0..<2 {
            let got = game.teamStats(t)
            let want = s.teams[t]
            let at = "\(s.label) team \(t)"
            Check.eq(got.score, want.score, "\(at).score")
            Check.eq(got.goals, want.goals, "\(at).goals")
            Check.eq(got.assists, want.assists, "\(at).assists")
            Check.eq(got.blocks, want.blocks, "\(at).blocks")
            Check.eq(got.attempts, want.attempts, "\(at).attempts")
            Check.eq(got.completions, want.completions, "\(at).completions")
            Check.eq(got.throwaways, want.throwaways, "\(at).throwaways")
            Check.eq(got.drops, want.drops, "\(at).drops")
            Check.eq(got.stallOuts, want.stallOuts, "\(at).stallOuts")
            Check.eq(
                got.turnoversCommitted, want.turnoversCommitted, "\(at).turnoversCommitted")
            Check.eq(got.turnoversForced, want.turnoversForced, "\(at).turnoversForced")
            // Yardages are sums of exact coordinate differences — no transcendental
            // anywhere — so they are required to be bit-identical.
            Check.bitEqViaJSON(got.yardsThrown, want.yardsThrown, "\(at).yardsThrown")
            Check.bitEqViaJSON(got.yardsReceived, want.yardsReceived, "\(at).yardsReceived")
            Check.bitEqViaJSON(
                got.timeOfPossession, want.timeOfPossession, "\(at).timeOfPossession")
            Check.eq(got.possessions, want.possessions, "\(at).possessions")
        }

        Check.eq(game.getLog().count, s.logLines, "\(s.label): play-by-play line count")
    }

    private static func compare(_ got: GameSnapshot, _ want: Snap, _ at: String) {
        Check.eq(got.phase.rawValue, want.phase, "\(at): phase")
        // The clock is a sum of the exact dt values the script supplied, so any drift is
        // a different accumulation order rather than rounding.
        Check.bitEqViaJSON(got.clock, want.clock, "\(at): clock")
        Check.eq(got.point, want.point, "\(at): point")
        Check.eq(got.half, want.half, "\(at): half")
        Check.eq(got.score, want.score, "\(at): score")
        Check.eq(got.possession, want.possession, "\(at): possession")
        Check.eq(got.thrower, want.thrower, "\(at): thrower")
        Check.eq(got.stall, want.stall, "\(at): stall")
        Check.eq(got.attackDir, want.attackDir, "\(at): attackDir")
        Check.eq(got.pullingTeam, want.pullingTeam, "\(at): pullingTeam")
        Check.eq(got.target, want.target, "\(at): target")
        Check.eq(got.cap.rawValue, want.cap, "\(at): cap")
    }

    // MARK: minis, which has no reference to differ against

    /// Minis is a Swift-side addition, so there is deliberately no golden for it.
    ///
    /// The reference reads its geometry from a module-level `FIELD` pinned to the
    /// regulation field. Running a minis script through it would not produce minis
    /// behaviour, it would produce regulation behaviour with minis-shaped inputs — and a
    /// golden generated that way would encode the wrong pitch as the truth, then fail a
    /// correct implementation and pass a broken one. So minis is checked as properties of
    /// the geometry instead, which is the honest bar available.
    private static func minis() {
        let f = FieldConstants.minis

        // The identities the regulation field satisfies must hold here too. These are the
        // ones a hand-entered preset gets wrong.
        Check.bitEqViaJSON(
            f.centralLength, f.length - 2 * f.endzoneDepth, "minis: central length closes")
        Check.bitEqViaJSON(f.goalLine, f.centralLength / 2, "minis: goal line is half the central length")
        Check.bitEqViaJSON(f.endLine, f.length / 2, "minis: end line is half the length")
        Check.bitEqViaJSON(f.sideline, f.width / 2, "minis: sideline is half the width")

        // The claim from the plan: a minis pitch is the space of a regulation endzone,
        // turned so its long axis is the direction of play.
        let full = FieldConstants.standard
        Check.bitEqViaJSON(f.length, full.width, "minis is as long as a regulation field is wide")
        Check.bitEqViaJSON(f.width, full.endzoneDepth, "minis is as wide as an endzone is deep")

        // The brick carries the regulation field's identity — one endzone-depth in from
        // the goal line — rather than being scaled by length, which would buy nothing.
        Check.bitEqViaJSON(f.brickIn, f.endzoneDepth, "minis: the brick is one endzone-depth in")
        Check.bitEqViaJSON(f.brickZ, f.goalLine - f.brickIn, "minis: brickZ follows from brickIn")
        Check.bitEqViaJSON(
            full.brickZ, full.goalLine - full.brickIn,
            "the regulation brick satisfies the same identity")

        // A minis game must actually be playable end to end, on three a side, and the
        // geometry must be the minis geometry rather than the global.
        var opts = GameStateOptions()
        opts.format = .minis
        let game = GameState(opts)
        Check.eq(game.format.playersPerSide, 3, "a minis game is three a side")

        game.startGame()
        game.setLine(0, [0, 1, 2, 3, 4, 5, 6])
        // The reference caps the line at a literal 7. Here it comes from the format,
        // which is the whole point of threading it.
        Check.ok(
            game.snapshot().phase == .prePull, "a minis game starts before the pull")

        // Points inside the regulation endzone but outside the minis pitch must be out.
        Check.ok(
            !game.format.field.isInBounds(Vec3d(0, 0, 25)),
            "z=25 is off the end of a minis pitch (it is in bounds on a regulation field)")
        Check.ok(
            FieldConstants.standard.endLine > 25,
            "and that same point really is in bounds under regulation geometry")
        Check.ok(game.format.field.isInBounds(Vec3d(0, 0, 10)), "z=10 is on the minis pitch")
        Check.ok(!game.format.field.isInBounds(Vec3d(10, 0, 0)), "x=10 is over a minis sideline")
    }

    // MARK: the rewrite must not have changed regulation behaviour

    /// `GameFormat`'s methods are the parameterised rewrite of `Rules.swift`'s free
    /// functions, which are themselves asserted bit-exactly by the `rules` suite.
    ///
    /// So for the regulation field the two must agree exactly. This is the check that
    /// says the rewrite from a module constant to a threaded value did not change any
    /// behaviour — a copied-and-edited geometry routine is precisely the kind of thing
    /// that drifts by a sign and stays plausible.
    private static func agreesWithRulesFreeFunctions() {
        let format = GameFormat.sevens
        var probes: [Vec3d] = []
        for x in stride(from: -25.0, through: 25.0, by: 6.25) {
            for z in stride(from: -60.0, through: 60.0, by: 7.5) {
                probes.append(Vec3d(x, 0, z))
            }
        }

        for p in probes {
            Check.eq(
                format.field.isInBounds(p), isInBounds(p),
                "isInBounds agrees at (\(p.x), \(p.z))")
            Check.eq(
                format.field.endzoneOf(p.z), endzoneOf(p.z),
                "endzoneOf agrees at z=\(p.z)")
            for dir in [1, -1] {
                Check.eq(
                    format.field.isInEndzone(p, dir), isInEndzone(p, dir),
                    "isInEndzone(dir \(dir)) agrees at (\(p.x), \(p.z))")
                Check.eq(
                    format.field.isGoal(p, dir), isGoal(p, dir),
                    "isGoal(dir \(dir)) agrees at (\(p.x), \(p.z))")
            }
            let a = format.field.clampToField(p)
            let b = clampToField(p)
            Check.bitEqViaJSON(a.x, b.x, "clampToField.x agrees at (\(p.x), \(p.z))")
            Check.bitEqViaJSON(a.z, b.z, "clampToField.z agrees at (\(p.x), \(p.z))")
        }

        for dir in [1, -1] {
            Check.bitEqViaJSON(
                format.field.goalLineZ(dir), goalLineZ(dir), "goalLineZ(\(dir)) agrees")
            let m = format.field.brickMark(dir)
            let n = brickMark(dir)
            Check.bitEqViaJSON(m.x, n.x, "brickMark(\(dir)).x agrees")
            Check.bitEqViaJSON(m.z, n.z, "brickMark(\(dir)).z agrees")
        }

        // Boundary crossings, including segments that stay in, leave sideways, and leave
        // over an end line — the three shapes the routine branches on.
        let segments: [(Vec3d, Vec3d)] = [
            (Vec3d(0, 0, 0), Vec3d(0, 0, 10)),
            (Vec3d(0, 0, 0), Vec3d(30, 0, 0)),
            (Vec3d(0, 0, 0), Vec3d(0, 0, 70)),
            (Vec3d(-10, 0, -40), Vec3d(25, 0, 55)),
            (Vec3d(19, 0, 0), Vec3d(-19, 0, 0)),
        ]
        for (a, b) in segments {
            let got = format.field.boundaryCrossing(a, b)
            let want = boundaryCrossing(a, b)
            Check.eq(got == nil, want == nil, "boundaryCrossing agrees on whether it crossed")
            if let got, let want {
                Check.bitEqViaJSON(got.point.x, want.point.x, "crossing.x agrees")
                Check.bitEqViaJSON(got.point.z, want.point.z, "crossing.z agrees")
                Check.eq(got.edge, want.edge, "crossing edge agrees")
            }
        }

        let rules = DEFAULT_RULES
        for dir in [1, -1] {
            for spot in [Vec3d(5, 0, 20), Vec3d(-19, 0, -55), Vec3d(0, 0, 0)] {
                let got = format.field.putIntoPlaySpot(spot, dir, rules)
                let want = putIntoPlaySpot(spot, dir, rules)
                Check.bitEqViaJSON(got.x, want.x, "putIntoPlaySpot.x agrees")
                Check.bitEqViaJSON(got.z, want.z, "putIntoPlaySpot.z agrees")
            }
        }

        Check.eq(format.field.cones.count, CONES.count, "the same number of cones")
        for (i, c) in format.field.cones.enumerated() {
            Check.bitEqViaJSON(c.x, CONES[i].x, "cone \(i).x agrees")
            Check.bitEqViaJSON(c.z, CONES[i].z, "cone \(i).z agrees")
        }
    }
}
