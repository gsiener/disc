import FlightUI
import SwiftUI

/// A macOS window showing the flight model, so the sim can be *looked at* without an
/// iOS simulator in the loop.
///
/// This exists because the simulator on this machine stopped enumerating destinations
/// and a reboot is the fix — but waiting for a reboot to see whether a disc flies
/// correctly is a bad trade. The view is identical to the one the iOS app shows: same
/// `FlightUI` library, same `UltimateSim` underneath, same numbers.
///
/// It is also just useful. A desktop window with a scrubber is a better place to tune
/// flight constants than a phone is, and it will stay useful after the simulator is
/// working again.
///
///     swift run FlightScope
@main
struct FlightScopeApp: App {
    @MainActor
    init() {
        // `--snapshot <path>` renders and exits without ever showing a window, so the
        // view can be captured from a script or a CI job.
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
            Snapshot.run(path: args[i + 1])
        }
    }

    var body: some Scene {
        WindowGroup("Ultimate · flight") {
            FlightView()
                .frame(minWidth: 900, minHeight: 520)
                .preferredColorScheme(.dark)
        }
        .defaultSize(width: 1100, height: 620)
    }
}
