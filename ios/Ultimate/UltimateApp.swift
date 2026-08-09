import FlightUI
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
    /// Which tab to open on, so a headless run can reach a specific screen.
    ///
    /// `xcrun simctl launch` can pass arguments but cannot tap, and the on-device check
    /// run is the property this port is staking itself on — a verification you can only
    /// trigger with a finger is one that stops happening. So:
    ///
    ///     xcrun simctl launch booted com.grahamsiener.ultimate -tab checks
    ///
    /// Defaults to the game, which is what a person opening the app wants.
    /// `-format 7v7` starts the game on the regulation field. Same reasoning as `-tab`.
    ///
    /// Nil when the argument is absent, which is the normal case: the format is then the
    /// one the player last chose on the pre-game sheet, and a launch argument is an
    /// override rather than a default.
    static let startFormat: FieldSpec? = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-format"), i + 1 < args.count else { return nil }
        return args[i + 1] == "7v7" ? .full : .minis
    }()

    /// `-setup off` opens straight into a live match instead of the pre-game sheet.
    ///
    /// The sheet is the right first screen for a person and a wall for automation, which
    /// can launch the app but cannot tap START. Same door, same reasoning, as `-tab`: the
    /// screens behind a finger have to stay reachable without one, or they stop being
    /// looked at.
    static let skipsSetup: Bool = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-setup"), i + 1 < args.count else { return false }
        return args[i + 1] == "off"
    }()

    /// `-charge 0.85` pins the throw gesture on screen at that hold, in seconds.
    ///
    /// The gesture — aim line, power bar, receiver bracket, charge meter — lives entirely
    /// under a finger, and `simctl` cannot drag. Same door as `-setup off`: the screens
    /// behind a finger have to stay reachable without one, or they stop being looked at.
    ///
    ///     xcrun simctl launch booted com.grahamsiener.ultimate -setup off -charge 0.85
    static let demoCharge: Double? = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-charge"), i + 1 < args.count else { return nil }
        return Double(args[i + 1])
    }()

    /// `-defend on` issues the defensive tap automatically, whenever there is one to
    /// issue.
    ///
    /// The defensive control is a tap, and a tap is the one input this environment cannot
    /// synthesise — `simctl` passes arguments and CGEvent posting never reaches the
    /// Simulator. Everything the tap puts on screen (the call plate, the marker on the
    /// grass where the defender was sent, the layout recovery countdown) is therefore
    /// unphotographable without this. Same door as `-charge`, same reasoning.
    ///
    ///     xcrun simctl launch booted com.grahamsiener.ultimate -setup off -defend on
    static let autoDefend: Bool = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-defend"), i + 1 < args.count else { return false }
        return args[i + 1] == "on"
    }()

    /// `-savecycle 20` plays for twenty seconds, saves the match, throws the engine away
    /// and restores it from the save — the whole persistence round trip, in one launch.
    ///
    /// The save is triggered by backgrounding the app and the restore by a button on the
    /// pre-game sheet, so between them the feature needs a home gesture and a tap, and
    /// this environment can synthesise neither. Same door as `-charge` and `-defend on`,
    /// and the same reasoning, sharpened: a feature that cannot be reached without a
    /// finger is a feature that cannot be *verified* without one.
    ///
    ///     xcrun simctl launch booted com.grahamsiener.ultimate -setup off -savecycle 20
    static let saveCycle: Double? = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-savecycle"), i + 1 < args.count else { return nil }
        return Double(args[i + 1])
    }()

    /// The tab named on the command line, or `play` when none was.
    static let requestedTab: Int = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-tab"), i + 1 < args.count else { return 0 }
        return ["play": 0, "pitch": 1, "flight": 2, "checks": 3, "bench": 4][args[i + 1]] ?? 0
    }()

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
            return requestedTab != 0
        #endif
    }()

    @State private var tab: Int = UltimateApp.requestedTab

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
                    format: Self.startFormat, active: tab == 0, skipsSetup: Self.skipsSetup,
                    demoCharge: Self.demoCharge, autoDefend: Self.autoDefend,
                    saveCycle: Self.saveCycle)
                    .tabItem { Label("Play", systemImage: "figure.run") }.tag(0)
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
                format: Self.startFormat, skipsSetup: Self.skipsSetup,
                demoCharge: Self.demoCharge, autoDefend: Self.autoDefend,
                saveCycle: Self.saveCycle)
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
            let result = runChecks()
            await MainActor.run {
                report = result
                running = false
            }
        }
    }
}
