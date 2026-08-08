import FlightUI
import SimChecks
import SwiftUI

/// The app: a game, and the instruments used to build it.
///
/// **Play** is 3v3 to 7 on a minis pitch, thrown with one drag gesture.
///
/// The other three tabs are not debug leftovers, they are the reason the game can be
/// trusted. **Flight** plots a single throw against the tolerances; **Checks** runs the
/// whole differential suite *on the device*, which is the one property this port is
/// staking itself on and the one thing a desktop test run cannot tell you — the sim has
/// to produce the same numbers on arm64-ios as it does on the Mac.
@main
struct UltimateApp: App {
    var body: some Scene {
        WindowGroup {
            TabView {
                MatchView()
                    .tabItem { Label("Play", systemImage: "figure.run") }
                PitchView()
                    .tabItem { Label("Pitch", systemImage: "sportscourt") }
                FlightView()
                    .tabItem { Label("Flight", systemImage: "arrow.up.right") }
                SelfCheckView()
                    .tabItem { Label("Checks", systemImage: "checkmark.seal") }
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
        VStack(alignment: .leading, spacing: 2) {
            ForEach(r.suites, id: \.name) { s in
                Text(
                    "\(s.name.padding(toLength: 8, withPad: " ", startingAt: 0))"
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
