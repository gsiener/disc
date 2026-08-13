import Foundation
import UltimateSim

/// `Engine.stagePoint`'s opening formation, against fixtures captured directly from
/// `Game.ts`'s `lineUpForPull()`.
///
/// Issue #56: `stagePoint` used to place the pulling-point roster with a different,
/// generic opening shape (`lateral = (slot/span - 0.5) * width * 0.6`, `z = -dir *
/// goalLine * 0.95`) rather than a port of `lineUpForPull` (`x = -SIDELINE + 3.5 + (i/6)
/// * (2*SIDELINE - 7)`, `z = -dir*GOAL_LINE + dir*0.5`) — found while building
/// `pull.json` for issue #48, whose fixture sidesteps the question by engineering the
/// puller's body directly rather than trusting the formation. Measured, seed 11's puller
/// (id 9) sat at `(-3.7, 30.4)` under the old formula against the reference's `(-5.0,
/// 31.5)` — a real, reproducible 1.5 m gap, not rounding noise.
///
/// **Zero ticks between construction and the read, on both sides**, for the same reason
/// `PullTests` insists on it: `Engine.init` calls `stagePoint()` on its own last line
/// (see `Engine.init`), so reading `loco.get(id)?.pos` immediately after `Engine.init`
/// returns is the exact same zero-tick instant `lineup.json` captures `lineUpForPull` at
/// — nothing has drawn from either engine's `rng` yet to disagree about, and no
/// `TeamAI` tick has moved anybody off the line this fixture is checking.
///
/// Only `x`/`z` are compared. `lineUpForPull`'s `y` comes from the reference's
/// `field.heightAt`/`hipHeight`, which `stagePoint` does not model (it sets a flat 0.9 m)
/// — a difference this fixture was never meant to pin, and out of scope for issue #56,
/// which is about the lateral/depth formula only. `facing` is compared: both sides reduce
/// to `dir > 0 ? 0 : π`.
enum LineupTests {

    static func run() throws {
        let g = try Goldens.load(File.self, "lineup")
        Check.ok(!g.cases.isEmpty, "lineup.json has cases to check")

        for c in g.cases {
            var cfg = EngineConfig()
            cfg.startingPullTeam = TeamId(c.pullingTeam)
            let e = Engine(format: .sevens, seed: UInt32(c.seed), config: cfg)

            Check.eq(e.game.pullingTeam, c.pullingTeam, "s\(c.seed): pullingTeam")
            Check.eq(e.dirFor(0), c.attackDir[0], "s\(c.seed): attackDir[0]")
            Check.eq(e.dirFor(1), c.attackDir[1], "s\(c.seed): attackDir[1]")

            for r in c.roster {
                guard let lp = e.loco.get(r.id) else {
                    Check.ok(false, "s\(c.seed): player \(r.id) has no LocoPlayer")
                    continue
                }
                Check.near(lp.pos.x, r.pos.x, 1e-9, "s\(c.seed): player \(r.id) pos.x")
                Check.near(lp.pos.z, r.pos.z, 1e-9, "s\(c.seed): player \(r.id) pos.z")
                Check.near(lp.facing, r.facing, 1e-9, "s\(c.seed): player \(r.id) facing")
            }
        }
    }

    // MARK: - JSON shapes

    struct V3DTO: Decodable { let x: Double; let y: Double; let z: Double }

    struct PlayerDTO: Decodable {
        let id: Int
        let team: Int
        let pos: V3DTO
        let facing: Double
    }

    struct CaseDTO: Decodable {
        let seed: Int
        let pullingTeam: Int
        let phase: String
        let attackDir: [Int]
        let roster: [PlayerDTO]
    }

    struct File: Decodable {
        let note: String
        let cases: [CaseDTO]
    }
}
