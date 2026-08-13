import FlightUI
import ProbeContract
import SimChecks
import SwiftUI
// For `FieldSpec`, which the -format launch argument selects. The app otherwise talks
// only to FlightUI and SimChecks.
import UltimateSim

/// The app: a game, and the instruments used to build it.
///
/// **Play** is 3v3 to 7 on a minis pitch, thrown with one drag gesture.
///
/// The other tabs are not debug leftovers, they are the reason the game can be trusted.
/// **Flight** plots a single throw against the tolerances. **Checks** runs the whole
/// differential suite *on the device*, which is the one property this port is staking
/// itself on and the one thing a desktop test run cannot tell you — the sim has to
/// produce the same numbers on arm64-ios as it does on the Mac. **Speed** measures the
/// tick, for the same reason: a benchmark taken on a laptop says nothing about a phone,
/// and the plan carried "under 0.5 ms per tick" as an extrapolation from Node for months
/// before anyone measured it anywhere.
///
/// They are also not the game, so they are compiled out of a release build — see
/// `showsInstruments`. A shipped build is Play, and nothing else.
@main
struct UltimateApp: App {
    /// The launch arguments, parsed once at the app boundary into an immutable typed
    /// value. Every launch flag flows through this one parse — no other site in the app,
    /// persistence, or UI reads `ProcessInfo.processInfo.arguments`. The value is threaded
    /// unchanged through initial construction, restart, and restore. Issue #21.
    ///
    /// The canonical argument names, receive-side values, and probe keys are shared
    /// contract symbols (`LaunchArg`, `ReceiveValue`, etc.), so a rename on one side is a
    /// compile error on the other rather than a silent default at runtime.
    static let launchOptions = LaunchOptions.parse(
        arguments: ProcessInfo.processInfo.arguments)

    /// Whether the four engineering instruments are part of this run.
    ///
    /// They are the reason the sim can be trusted and they are not the game. A build
    /// handed to somebody to *play* that opens onto a five-item tab bar, four of which
    /// are a differential test runner, a benchmark and two plotters, is not a game — it
    /// is a workbench with a game on it. So the shape of the app is decided at compile
    /// time: a debug build is the workbench, a release build is Play and nothing else.
    ///
    /// With one door left open. The on-device check run is the single property this port
    /// stakes itself on, and it has to be reachable in the configuration that ships —
    /// `xcrun simctl launch` can pass arguments but cannot tap, so a release build that
    /// *was asked for* an instrument builds the tab bar anyway:
    ///
    ///     xcrun simctl launch booted com.grahamsiener.ultimate -tab checks
    ///
    /// That keeps automation working against the real artifact without putting a test
    /// runner in front of a player, which is the whole point.
    static let showsInstruments: Bool = {
        #if DEBUG
            return true
        #else
            return launchOptions.requestedTab != 0
        #endif
    }()

    @State private var tab: Int = UltimateApp.launchOptions.requestedTab

    /// Mirrors `MatchView.isPlaying` while Play is the selected tab. Issue #54: the tab
    /// bar's chrome sits over the drag-to-throw gesture area and blocks it, so the bar
    /// is hidden while this is true — see `root`. It is not simply "is tab 0 selected":
    /// a plain `TabView` (unlike a `.page`-style one) has no swipe between tabs, so
    /// hiding the bar for the whole time Play is selected would strand a player with no
    /// way back to Pitch/Flight/Checks/Speed. Gating on "a point is actually live" as
    /// well means the bar is back the moment the player is at the pre-game sheet,
    /// paused, or looking at a result card — precisely when they might want another tab,
    /// and precisely when the screen space isn't being fought over by a gesture.
    @State private var matchIsPlaying = false

    var body: some Scene {
        WindowGroup {
            root.preferredColorScheme(.dark)
        }
    }

    @ViewBuilder private var root: some View {
        if Self.showsInstruments {
            TabView(selection: $tab) {
                // `active:` is what stops a tab nobody is looking at from simulating.
                // A `TabView` builds a tab on first selection and then keeps it alive,
                // so without this the match and the flight loop both keep running behind
                // whatever is on screen.
                MatchView(
                    options: Self.launchOptions, active: tab == 0,
                    isPlaying: $matchIsPlaying)
                    .tabItem { Label("Play", systemImage: "figure.run") }.tag(0)
                    .toolbar(tab == 0 && matchIsPlaying ? .hidden : .visible, for: .tabBar)
                PitchView(active: tab == 1)
                    .tabItem { Label("Pitch", systemImage: "sportscourt") }.tag(1)
                FlightView()
                    .tabItem { Label("Flight", systemImage: "arrow.up.right") }.tag(2)
                SelfCheckView()
                    .tabItem { Label("Checks", systemImage: "checkmark.seal") }.tag(3)
                BenchView()
                    .tabItem { Label("Speed", systemImage: "gauge.with.needle") }.tag(4)
            }
        } else {
            MatchView(
                options: Self.launchOptions)
        }
    }
}

struct SelfCheckView: View {
    @State private var report: CheckReport?
    @State private var running = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header

                if let report {
                    verdict(report)
                    suites(report)
                    if !report.notes.isEmpty { notes(report) }
                    if !report.failures.isEmpty { failures(report) }
                } else if running {
                    ProgressView("running…")
                } else {
                    Text("tap to run").foregroundStyle(.secondary)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color.black)
        .contentShape(Rectangle())
        .onTapGesture { run() }
        .task { run() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("ULTIMATE").font(.system(.title2, design: .monospaced)).bold()
            Text("sim self-check · \(deviceDescription)")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }

    private func verdict(_ r: CheckReport) -> some View {
        HStack(spacing: 10) {
            Text(r.isGreen ? "PASS" : "FAIL")
                .font(.system(.title3, design: .monospaced)).bold()
                .foregroundStyle(r.isGreen ? .green : .red)
            Text("\(r.total) assertions, \(r.failures.count) failures")
                .font(.system(.body, design: .monospaced))
            Spacer()
            Text(String(format: "%.3fs", r.seconds))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }

    private func suites(_ r: CheckReport) -> some View {
        // `String.padding(toLength:)` TRUNCATES anything longer than the length, so a
        // fixed 8 turned "gamestate" into "gamestat" and ran it into the number beside
        // it. The column is derived from the longest name instead, and padding is only
        // ever added — a report about correctness that garbles its own suite names is
        // not one you would trust.
        let width = (r.suites.map(\.name.count).max() ?? 0) + 2
        return VStack(alignment: .leading, spacing: 2) {
            ForEach(r.suites, id: \.name) { s in
                Text(
                    s.name + String(repeating: " ", count: Swift.max(1, width - s.name.count))
                        + "\(s.assertions) assertions  \(String(format: "%.3fs", s.seconds))"
                )
                .font(.system(.caption, design: .monospaced))
            }
        }
    }

    private func notes(_ r: CheckReport) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("measured").font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
            ForEach(r.notes, id: \.self) { note in
                Text(note).font(.system(.caption2, design: .monospaced)).foregroundStyle(.orange)
            }
        }
    }

    private func failures(_ r: CheckReport) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("failures").font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
            // Capped for the same reason the terminal output is: a structural bug fails
            // thousands at once, and a wall of identical lines hides the summary.
            ForEach(Array(r.failures.prefix(20)), id: \.self) { f in
                Text(f).font(.system(.caption2, design: .monospaced)).foregroundStyle(.red)
            }
            if r.failures.count > 20 {
                Text("… and \(r.failures.count - 20) more")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var deviceDescription: String {
        #if targetEnvironment(simulator)
            return "simulator"
        #else
            return "device"
        #endif
    }

    private func run() {
        guard !running else { return }
        running = true
        // Off the main actor: the suites are pure computation and the sweep is long
        // enough to drop frames if it runs on the main thread.
        Task.detached(priority: .userInitiated) {
            let result = await runChecks()
            await MainActor.run {
                report = result
                running = false
            }
        }
    }
}
