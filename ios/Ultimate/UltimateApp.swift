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
    static let startFormat: FieldSpec = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-format"), i + 1 < args.count else { return .minis }
        return args[i + 1] == "7v7" ? .full : .minis
    }()

    @State private var tab: Int = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-tab"), i + 1 < args.count else { return 0 }
        return ["play": 0, "pitch": 1, "flight": 2, "checks": 3, "bench": 4][args[i + 1]] ?? 0
    }()

    var body: some Scene {
        WindowGroup {
            TabView(selection: $tab) {
                MatchView(format: Self.startFormat)
                    .tabItem { Label("Play", systemImage: "figure.run") }.tag(0)
                PitchView()
                    .tabItem { Label("Pitch", systemImage: "sportscourt") }.tag(1)
                FlightView()
                    .tabItem { Label("Flight", systemImage: "arrow.up.right") }.tag(2)
                SelfCheckView()
                    .tabItem { Label("Checks", systemImage: "checkmark.seal") }.tag(3)
                BenchView()
                    .tabItem { Label("Speed", systemImage: "gauge.with.needle") }.tag(4)
            }
            .preferredColorScheme(.dark)
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
