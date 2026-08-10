import Foundation
import UltimateSim

/// The task-#66 measurement table, identical for both formats so they can be compared.
enum Table {
    static let dt = 1.0 / 120.0

    static func measure(_ format: GameFormat, seed: UInt32, auto: Set<TeamId>, seconds: Double) {
        let e = Engine(format: format, target: 999, seed: seed)
        e.autoTeams = auto
        var liveSecs = 0.0
        var throwsSeen = 0
        var stalls: [Double] = []
        var gains: [Double] = []
        var completions = 0
        var heldPos: Vec3d?
        var heldTeam: TeamId?
        var dists: [Double] = []
        for _ in 0..<Int(seconds / dt) {
            e.step(dt: dt)
            if e.game.phase == .livePossession { liveSecs += dt }
            if e.stats.throwsMade > throwsSeen {
                throwsSeen = e.stats.throwsMade
                stalls.append(e.stall)
            }
            if e.stats.completions > completions, let from = heldPos, let t = heldTeam,
                let to = e.carrier.flatMap({ id in e.players.first { $0.id == id } })?.pos
            {
                gains.append(Double(e.dirFor(t)) * (to.z - from.z))
                dists.append(hypot(to.x - from.x, to.z - from.z))
            }
            completions = e.stats.completions
            if let id = e.carrier, let p = e.players.first(where: { $0.id == id }) {
                heldPos = p.pos
                heldTeam = p.team
            }
        }
        let ts = (0...1).map { e.game.teamStats($0) }
        func sum(_ f: (TeamStats) -> Int) -> Int { ts.reduce(0) { $0 + f($1) } }
        let att = sum { $0.attempts }, comp = sum { $0.completions }
        let aways = sum { $0.throwaways }, drops = sum { $0.drops }, so = sum { $0.stallOuts }
        let holds = sum { $0.holds }, breaks = sum { $0.breaks }
        let blocks = e.stats.blocks
        let turnovers = aways + drops + so + blocks
        let points = holds + breaks
        let name = format.field.length > 50 ? "sevens" : " minis"
        let goals = e.score[0] + e.score[1]
        func pc(_ a: Int, _ b: Int) -> String { b > 0 ? String(format: "%.0f%%", 100.0 * Double(a) / Double(b)) : "  - " }
        print(
            "\(name) s\(seed) auto\(auto.count)  goals/15min \(String(format: "%5.1f", Double(goals) * 900.0 / seconds))"
                + "  cadence \(String(format: "%4.1f", liveSecs / Double(max(1, att))))s"
                + "  comp \(pc(comp, att))"
                + "  holds \(pc(holds, points))"
                + "  stall-out share \(pc(so, max(1, turnovers)))"
                + "  late(>=7) \(pc(stalls.filter { $0 >= 7 }.count, stalls.count))"
                + "  gain \(String(format: "%+5.2f", gains.reduce(0, +) / Double(max(1, gains.count))))m"
                + "  longest \(String(format: "%4.1f", dists.max() ?? 0))m"
                + "  | att \(att) TO: away \(aways) drop \(drops) stall \(so) block \(blocks)")
    }
}
