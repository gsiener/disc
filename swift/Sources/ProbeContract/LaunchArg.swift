import Foundation

/// Canonical launch-argument names, shared by the app parser and the UI-test driver.
///
/// Each raw value includes the leading `-` so it can be used directly with
/// `firstIndex(of:)` on `ProcessInfo.processInfo.arguments` and in
/// `XCUIApplication.launchArguments`. VAL-LAUNCH-002 requires that the recognized
/// names are exactly this set, spelled identically on both sides.
///
/// VAL-CROSS-013 requires that no raw canonical-name string literal is spelled in the
/// app boundary outside this contract — both the app and the test driver resolve names
/// through `LaunchArg.rawValue`.
public enum LaunchArg: String, CaseIterable, Sendable {
    case format = "-format"
    case points = "-points"
    case receive = "-receive"
    case setup = "-setup"
    case charge = "-charge"
    case defend = "-defend"
    case cut = "-cut"
    case savecycle = "-savecycle"
    case probe = "-probe"
    case tab = "-tab"
}

/// Receive-side values for `-receive`.
///
/// `us` hands the opening pull to team 1 (we receive); `them` hands it to team 0
/// (we pull). Any other value or absence yields nil (engine default). VAL-LAUNCH-005.
public enum ReceiveValue: String, CaseIterable, Sendable {
    case us
    case them
}

/// The value that skips the pre-game sheet: `-setup off`.
///
/// Any other value or absence keeps the sheet shown. VAL-LAUNCH-006.
public enum SetupValue: String, CaseIterable, Sendable {
    case off
}

/// The value that activates a boolean toggle: `-defend on`, `-probe on`.
///
/// Any other value or absence is off. VAL-LAUNCH-008, VAL-LAUNCH-011.
public enum ToggleValue: String, CaseIterable, Sendable {
    case on
}

/// Canonical tab names for `-tab`, mapping to the indices the app's `TabView` uses.
///
/// VAL-LAUNCH-012: `play`→0, `pitch`→1, `flight`→2, `checks`→3, `bench`→4.
/// An unknown name or absence defaults to play (0). The tab-bar item labels are
/// `Play`, `Pitch`, `Flight`, `Checks`, `Speed` respectively — `bench` the argument
/// is `Speed` the label, because the tab measures speed.
public enum TabName: String, CaseIterable, Sendable {
    case play
    case pitch
    case flight
    case checks
    case bench

    public var index: Int {
        switch self {
        case .play: return 0
        case .pitch: return 1
        case .flight: return 2
        case .checks: return 3
        case .bench: return 4
        }
    }

    /// The tab-bar item label shown in the UI, which differs from the argument
    /// name for `bench` → `Speed`.
    public var label: String {
        switch self {
        case .play: return "Play"
        case .pitch: return "Pitch"
        case .flight: return "Flight"
        case .checks: return "Checks"
        case .bench: return "Speed"
        }
    }
}
