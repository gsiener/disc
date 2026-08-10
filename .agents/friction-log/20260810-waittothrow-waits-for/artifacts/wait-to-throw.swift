import Foundation
import UltimateSim

/// How long a UI test that waits for "the disc in our hand" actually waits.
///
/// `MatchDriver.waitToThrow` blocks on the app's `canThrow`, which is
/// `phase == .livePossession && carrier == controlled`. This measures the same predicate
/// in the headless engine with no input at all — the state a UI test is in before its
/// first drag — and reports the gaps between windows.
enum Waits {
    static let dt = 1.0 / 120.0

    static func measure(_ format: GameFormat, seed: UInt32, seconds: Double) {
        let e = Engine(format: format, seed: seed)
        var t = 0.0
        var gaps: [Double] = []
        var lastEnd = 0.0
        var inWindow = false
        var first: Double?
        var windowSecs = 0.0
        for _ in 0..<Int(seconds / dt) {
            e.step(dt: dt)
            t += dt
            let can = e.game.phase == .livePossession && e.carrier == e.controlled
            if can {
                windowSecs += dt
                if !inWindow {
                    inWindow = true
                    if first == nil { first = t }
                    gaps.append(t - lastEnd)
                }
            } else if inWindow {
                inWindow = false
                lastEnd = t
            }
        }
        let name = format.field.length > 50 ? "sevens" : " minis"
        print(
            "\(name) s\(seed): first window at \(String(format: "%5.1f", first ?? -1)) s, "
                + "\(gaps.count) windows in \(Int(seconds)) s, "
                + "worst wait \(String(format: "%5.1f", gaps.max() ?? -1)) s, "
                + "mean wait \(String(format: "%4.1f", gaps.reduce(0, +) / Double(max(1, gaps.count)))) s, "
                + "in-hand \(String(format: "%.0f%%", 100 * windowSecs / seconds))")
    }
}
