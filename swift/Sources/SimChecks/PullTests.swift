import Foundation
import UltimateSim

/// `Engine.autoPull`, against fixtures captured directly from `Game.ts`'s `doPull()`.
///
/// Issue #48/#2: `Engine.autoPull` used to be an independently invented pull rather than
/// a port of `doPull` — a different target distance, a different throw model entirely —
/// and every check that existed for it was a property (`EngineSeamTests`'s
/// `thePullIsSolvedForThePitchItIsThrownOn`): a pull is thrown, it stays roughly on the
/// pitch, it carries a plausible fraction of it. A property suite proves a *distribution*;
/// it cannot see "the aim, the speed, the bank and the nose are each the wrong formula but
/// still land somewhere on the pitch by coincidence of the bounds chosen". This suite pins
/// the actual numbers.
///
/// **Zero ticks between construction and the pull, on both sides.** `pull.json`'s cases
/// call `doPull()` immediately after `GameSystem.init(ctx)` — no `update()` loop — and
/// this suite calls `Engine.autoPull()` immediately after `Engine.init` returns, for the
/// same reason: `TeamAI` is handed the engine's own `rng` stream directly rather than a
/// fork of it (see `Engine.stagePoint`), so any tick that lets the AI decide something
/// before the pull fires would draw from that stream first and shift the pull's own
/// `jitter = rng.next()` draw by an AI-decision-cadence-dependent amount — a thing this
/// suite has no way to keep in step between two independently-ticking engines. Calling the
/// pull the instant the roster exists sidesteps needing that parity at all: the fixture is
/// then only about `doPull`'s own formula, not about tick-for-tick AI agreement.
///
/// `startingPullTeam` is forced to 1 in both languages: the reference's headless harness
/// (`tools/test-game.ts`) hardcodes `startingPullTeam: 1` inside `GameSystem.init`, and
/// `Engine`'s own default is team 0 (`EngineConfig.startingPullTeam ?? 0` — "the human's
/// team pulls to open"), so this suite overrides it explicitly to match.
///
/// **The puller's body is placed at the fixture's recorded position/facing before
/// `autoPull()` runs, rather than trusted to land there on its own.** `Engine.stagePoint`'s
/// opening formation and the reference's `lineUpForPull` are different formulas — measured
/// against seed 11, `(-3.7, 30.4)` against `(-5.0, 31.5)` — and reconciling those two is a
/// separate concern from `doPull`'s own arithmetic, which is what issue #48 is about and
/// what this fixture exists to pin. `puller.id`/`team`/`handed`/`throwPower` are still
/// asserted unmodified straight out of `buildRoster`, because those already agree with no
/// help (see the roster sanity checks below) — only the body's spatial fields are pinned.
enum PullTests {

    static func run() throws {
        let g = try Goldens.load(File.self, "pull")
        Check.ok(!g.cases.isEmpty, "pull.json has cases to check")

        for c in g.cases {
            var cfg = EngineConfig()
            cfg.startingPullTeam = TeamId(c.pullingTeam)
            let e = Engine(format: .sevens, seed: UInt32(c.seed), config: cfg)

            Check.eq(e.game.pullingTeam, c.pullingTeam, "s\(c.seed): pullingTeam")
            Check.eq(e.dirFor(e.game.pullingTeam), c.attackDir, "s\(c.seed): attackDir")

            // The roster the fixture was captured against — a sanity check that
            // `buildRoster` still deals the same puller for this seed before trusting
            // anything downstream of him.
            Check.eq(e.puller, c.puller.id, "s\(c.seed): puller id")
            guard let p = e.players.first(where: { $0.id == e.puller }) else {
                Check.ok(false, "s\(c.seed): puller \(c.puller.id) has no AIPlayer")
                continue
            }
            Check.eq(p.team, c.puller.team, "s\(c.seed): puller team")
            Check.eq(
                p.handed == .left ? "left" : "right", c.puller.handed, "s\(c.seed): puller handed")
            Check.near(p.attr.throwPower, c.puller.throwPower, 1e-9, "s\(c.seed): puller throwPower")

            // Place the body where the fixture recorded it — see the header on why the
            // engine's own pre-pull formation is not what this suite is checking.
            guard let lp = e.loco.get(e.puller) else {
                Check.ok(false, "s\(c.seed): puller \(c.puller.id) has no LocoPlayer")
                continue
            }
            lp.pos = Vec3d(c.puller.pos.x, c.puller.pos.y, c.puller.pos.z)
            lp.facing = c.puller.facing
            lp.groundY = c.puller.groundY
            lp.hipHeight = c.puller.hipHeight

            e.autoPull()

            guard let got = e.lastPullThrow else {
                Check.ok(false, "s\(c.seed): autoPull() did not release a pull")
                continue
            }

            let r = c.request
            Check.near(got.from.x, r.from.x, 1e-9, "s\(c.seed): from.x")
            Check.near(got.from.y, r.from.y, 1e-9, "s\(c.seed): from.y")
            Check.near(got.from.z, r.from.z, 1e-9, "s\(c.seed): from.z")
            Check.near(got.aim.x, r.aim.x, 1e-9, "s\(c.seed): aim.x")
            Check.near(got.aim.y, r.aim.y, 1e-9, "s\(c.seed): aim.y")
            Check.near(got.aim.z, r.aim.z, 1e-9, "s\(c.seed): aim.z")
            Check.near(got.power, r.power, 1e-12, "s\(c.seed): power")
            Check.near(got.angle, r.angle, 1e-12, "s\(c.seed): angle")
            Check.near(got.spin, r.spin, 1e-12, "s\(c.seed): spin — PULL_SPIN")
            Check.near(got.bank ?? .nan, r.bank, 1e-12, "s\(c.seed): bank — PULL_BANK")
            Check.near(got.nose ?? .nan, r.nose, 1e-12, "s\(c.seed): nose — PULL_NOSE")
            Check.near(got.speed ?? .nan, r.speed, 1e-9, "s\(c.seed): speed — PULL_SPEED*arm*jitter")
            Check.eq(
                (got.hand == .left ? "L" : "R"), r.hand, "s\(c.seed): hand")

            // The final release velocity — `disc.release(req)`'s own output, so this is
            // also an end-to-end check that the aero model agrees on the pull's throw
            // parameters specifically, not only on parameters DiscRuntimeTests already
            // covers in isolation. Same tolerance DiscRuntimeTests uses for this exact
            // quantity (`release vel`, 1e-12).
            Check.near(got.vel.x, c.vel.x, 1e-12, "s\(c.seed): release vel.x")
            Check.near(got.vel.y, c.vel.y, 1e-12, "s\(c.seed): release vel.y")
            Check.near(got.vel.z, c.vel.z, 1e-12, "s\(c.seed): release vel.z")
        }
    }

    // MARK: - JSON shapes

    struct V3DTO: Decodable { let x: Double; let y: Double; let z: Double }

    struct PullerDTO: Decodable {
        let id: Int
        let team: Int
        let handed: String
        let throwPower: Double
        let pos: V3DTO
        let facing: Double
        let groundY: Double
        let hipHeight: Double
    }

    struct RequestDTO: Decodable {
        let type: String
        let from: V3DTO
        let aim: V3DTO
        let power: Double
        let angle: Double
        let spin: Double
        let bank: Double
        let nose: Double
        let speed: Double
        let hand: String
    }

    struct CaseDTO: Decodable {
        let seed: Int
        let pullingTeam: Int
        let attackDir: Int
        let puller: PullerDTO
        let request: RequestDTO
        let from: V3DTO
        let vel: V3DTO
    }

    struct File: Decodable {
        let note: String
        let cases: [CaseDTO]
    }
}
