import CoreGraphics
import Foundation

/// Immutable typed launch options, parsed once from `ProcessInfo.processInfo.arguments`
/// at the app boundary.
///
/// VAL-LAUNCH-014: there is exactly one parse function, and the resulting value is
/// threaded unchanged through initial construction, restart, and restore. No gesture
/// handler, timeline callback, or restore task rereads process arguments.
///
/// VAL-LAUNCH-001: with no arguments, every field is its default.
public struct LaunchOptions: Equatable, Sendable {

    /// `-format 7v7` → `.full`, any other value → `.minis`, absent → nil (saved choice).
    public let format: LaunchFormat?

    /// `-points N` parsed as `Int(N)` — the parser does not clamp. Absent or
    /// non-integer → nil. The applied match length is `max(1, min(99, raw))`.
    /// VAL-LAUNCH-004.
    public let points: Int?

    /// `-receive us` → 1, `-receive them` → 0, other/absent → nil.
    /// VAL-LAUNCH-005.
    public let receiveTeam: Int?

    /// `-setup off` → true, other/absent → false. VAL-LAUNCH-006.
    public let skipsSetup: Bool

    /// `-charge <v>` parsed as `Double(v)`. Accepts any Double-parseable token
    /// including non-finite (`inf`, `-inf`, `nan`) and negative. Absent or
    /// non-Double-parseable → nil. VAL-LAUNCH-007, VAL-LAUNCH-013.
    public let demoCharge: Double?

    /// `-defend on` → true, other/absent → false. VAL-LAUNCH-008.
    public let autoDefend: Bool

    /// `-cut x,y` parsed as `CGPoint(x, y)` when exactly two comma parts, both
    /// `Double`-parseable, and each in `[0, 1]`. Malformed or absent → nil.
    /// VAL-LAUNCH-009, VAL-LAUNCH-013.
    public let demoCut: CGPoint?

    /// `-savecycle <v>` parsed as `Double(v)`. Same parse rules as `demoCharge`.
    /// A non-finite value never satisfies its time threshold. VAL-LAUNCH-010.
    public let saveCycle: Double?

    /// `-probe on` → true, other/absent → false. VAL-LAUNCH-011.
    public let showsProbe: Bool

    /// `-tab name` → `TabName.index`, unknown/absent → 0 (play). VAL-LAUNCH-012.
    public let requestedTab: Int

    public init(
        format: LaunchFormat? = nil, points: Int? = nil, receiveTeam: Int? = nil,
        skipsSetup: Bool = false, demoCharge: Double? = nil, autoDefend: Bool = false,
        demoCut: CGPoint? = nil, saveCycle: Double? = nil, showsProbe: Bool = false,
        requestedTab: Int = 0
    ) {
        self.format = format
        self.points = points
        self.receiveTeam = receiveTeam
        self.skipsSetup = skipsSetup
        self.demoCharge = demoCharge
        self.autoDefend = autoDefend
        self.demoCut = demoCut
        self.saveCycle = saveCycle
        self.showsProbe = showsProbe
        self.requestedTab = requestedTab
    }

    /// The default options when no launch arguments are present.
    public static let defaults = LaunchOptions()

    // MARK: - Parsing

    /// Parse a raw argument list into typed launch options.
    ///
    /// Each flag is looked up by its **first** occurrence (`firstIndex(of:)`), and the
    /// following token is taken as its value. This gives:
    ///
    /// - **Duplicate flags: first occurrence wins.** VAL-LAUNCH-013(b).
    /// - **Flag-like tokens as values are literal.** `-format -points` → format minis
    ///   (because `-points` is the literal value of `-format`, not `"7v7"`), and the
    ///   trailing token is consumed by the next flag that names it. VAL-LAUNCH-013(c).
    /// - **Unknown flags are ignored.** A token not in `LaunchArg.allCases` has no
    ///   effect on any option. VAL-LAUNCH-002.
    /// - **Case-sensitive values.** Uppercased/mixed-case variants fall through to
    ///   default. VAL-LAUNCH-013(d).
    /// - **Trailing flag with no value keeps its default.** VAL-LAUNCH-013(a).
    public static func parse(arguments: [String]) -> LaunchOptions {
        func value(for arg: LaunchArg) -> String? {
            guard let i = arguments.firstIndex(of: arg.rawValue),
                i + 1 < arguments.count
            else { return nil }
            return arguments[i + 1]
        }

        let format: LaunchFormat? = value(for: .format).map {
            $0 == "7v7" ? .full : .minis
        }

        let points: Int? = value(for: .points).flatMap { Int($0) }

        let receiveTeam: Int? = value(for: .receive).flatMap { raw in
            switch raw {
            case ReceiveValue.us.rawValue: return 1
            case ReceiveValue.them.rawValue: return 0
            default: return nil
            }
        }

        let skipsSetup = value(for: .setup) == SetupValue.off.rawValue

        let demoCharge: Double? = value(for: .charge).flatMap { Double($0) }

        let autoDefend = value(for: .defend) == ToggleValue.on.rawValue

        let demoCut: CGPoint? = value(for: .cut).flatMap { parseCut($0) }

        let saveCycle: Double? = value(for: .savecycle).flatMap { Double($0) }

        let showsProbe = value(for: .probe) == ToggleValue.on.rawValue

        let requestedTab = value(for: .tab).map { tabIndex($0) } ?? 0

        return LaunchOptions(
            format: format, points: points, receiveTeam: receiveTeam,
            skipsSetup: skipsSetup, demoCharge: demoCharge,
            autoDefend: autoDefend, demoCut: demoCut,
            saveCycle: saveCycle, showsProbe: showsProbe,
            requestedTab: requestedTab)
    }

    /// Parse a `-cut x,y` value into a `CGPoint`, requiring exactly two comma parts,
    /// both `Double`-parseable, and each in `[0, 1]`.
    ///
    /// Non-finite values (`inf`, `nan`) are rejected by the range check.
    /// `1e400` returns nil from `Double(_:)` because it overflows. VAL-LAUNCH-013.
    private static func parseCut(_ raw: String) -> CGPoint? {
        let parts = raw.split(separator: ",")
        guard parts.count == 2,
            let x = Double(parts[0]), let y = Double(parts[1]),
            x >= 0, x <= 1, y >= 0, y <= 1
        else { return nil }
        return CGPoint(x: x, y: y)
    }

    /// Map a tab name string to its index, defaulting to 0 for unknowns.
    private static func tabIndex(_ name: String) -> Int {
        TabName(rawValue: name)?.index ?? 0
    }
}
