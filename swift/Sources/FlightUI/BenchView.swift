import SimChecks
import SwiftUI
import UltimateSim

/// Turns the plan's long-carried "under 0.5 ms per tick" into a number measured on this
/// device, rather than the Node.js-derived estimate it has been since before any Swift
/// existed.
///
/// Runs `SimChecks.runBench()` once, off the main actor so the measurement loops do not
/// fight the view for CPU time while they run, then draws the `BenchReport` it returns.
/// Same house style as `FlightView`: monospaced, dark, and controls hand-drawn rather
/// than `Picker`/`Slider`, which render blank under `ImageRenderer`.
///
/// **The numbers on screen may be debug numbers.** `BenchReport.isDebugBuild` is read
/// and shown, not assumed — a build run through `swift run` is `-Onone` and several
/// times slower than what ships, and a view that hid that distinction would be actively
/// misleading about the one thing this screen exists to be honest about.
@available(macOS 15.0, iOS 18.0, *)
public struct BenchView: View {
    @State private var report: BenchReport?
    @State private var isRunning = false

    public init() {}

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if let report {
                    buildBanner(report)
                    measurementsSection(report)
                    matchSection(report)
                    footer(report)
                } else {
                    runningNotice
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(Color.black)
        .task { await run() }
    }

    // MARK: running

    private func run() async {
        isRunning = true
        // `runBench()` is synchronous CPU-bound work — several thousand timed calls plus
        // a handful of full matches played to completion. Detaching it keeps that loop
        // off whatever executor is driving the view, so the measurements reflect the
        // sim's own cost rather than contention with SwiftUI.
        let result = await Task.detached(priority: .userInitiated) {
            runBench()
        }.value
        report = result
        isRunning = false
    }

    // MARK: header

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("BENCH").font(.system(.headline, design: .monospaced)).bold()
                .foregroundStyle(.white)
            Text("tick cost, measured — not the plan's estimate")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.white.opacity(0.4))
            Spacer()
            if let report {
                stat("total", report.seconds, "s")
            }
        }
    }

    private var runningNotice: some View {
        Text(isRunning ? "running…" : "")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.white.opacity(0.5))
    }

    private func stat(_ name: String, _ value: Double, _ unit: String) -> some View {
        HStack(spacing: 4) {
            Text(name).foregroundStyle(.white.opacity(0.4))
            Text(String(format: "%.2f", value) + unit).foregroundStyle(.orange)
        }
        .font(.system(.caption, design: .monospaced))
    }

    // MARK: build caveat

    /// The one line that has to be impossible to miss: which build produced everything
    /// below it. Red for debug, because the numbers read faster than the truth if the
    /// caveat is easy to skip past.
    private func buildBanner(_ report: BenchReport) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(report.isDebugBuild ? Color.red : Color.green)
                .frame(width: 8, height: 8)
            Text(report.isDebugBuild ? "DEBUG BUILD" : "RELEASE BUILD")
                .font(.system(.caption, design: .monospaced)).bold()
                .foregroundStyle(report.isDebugBuild ? .red : .green)
            Text(
                report.isDebugBuild
                    ? "swift run defaults here — unoptimized, several times slower than a shipped app"
                    : "optimized — closer to what a shipped app costs"
            )
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(.white.opacity(0.45))
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 5)
                .fill((report.isDebugBuild ? Color.red : Color.green).opacity(0.12)))
    }

    // MARK: measurements

    private func measurementsSection(_ report: BenchReport) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("per-tick cost · median bar, orange tick = worst · log scale")
            benchBudgetAxis()
            ForEach(Array(report.measurements.enumerated()), id: \.offset) { _, m in
                measurementRow(m)
            }
        }
    }

    /// The 60 fps reference line, labelled once above the bars it runs through rather
    /// than on every row — so a reader can see at a glance how much of the frame budget
    /// the median tick spends, which is the whole point of drawing this as a chart
    /// instead of a table.
    private func benchBudgetAxis() -> some View {
        GeometryReader { geo in
            let bx = logX(16_667, width: geo.size.width)
            ZStack(alignment: .topLeading) {
                Rectangle().fill(Color.white.opacity(0.18)).frame(width: 1)
                    .offset(x: bx)
                Text("16.7 ms · 60 fps budget")
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.4))
                    .fixedSize()
                    .offset(x: Swift.min(bx + 4, geo.size.width - 130))
            }
        }
        .frame(height: 14)
    }

    private func measurementRow(_ m: BenchReport.Measurement) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(m.name)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.75))
                Spacer()
                Text(
                    "median \(microLabel(m.medianMicros))  "
                        + "worst \(microLabel(m.worstMicros))  "
                        + "mean \(microLabel(m.meanMicros))"
                )
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.white.opacity(0.5))
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.06)).frame(height: 8)
                    Rectangle().fill(Color.white.opacity(0.18)).frame(width: 1, height: 12)
                        .offset(x: logX(16_667, width: geo.size.width))
                    Capsule()
                        .fill(m.fractionOf60fpsFrame > 1 ? Color.red : Color.green)
                        .frame(width: Swift.max(2, logX(m.medianMicros, width: geo.size.width)), height: 8)
                    Rectangle().fill(Color.orange)
                        .frame(width: 2, height: 12)
                        .offset(x: Swift.max(0, logX(m.worstMicros, width: geo.size.width) - 1))
                }
            }
            .frame(height: 12)
            Text("\(m.samples) samples, \(m.warmup) warm-up · "
                + "\(String(format: "%.2f", m.fractionOf60fpsFrame * 100))% of a 60 fps frame at median")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(.white.opacity(0.3))
        }
    }

    /// Log10 position across `width` for a value in microseconds, floored at 0.1 µs so
    /// the smallest measured calls still land on the chart rather than at a
    /// mathematically undefined `log10(0)`.
    private func logX(_ micros: Double, width: CGFloat) -> CGFloat {
        let lo = Foundation.log10(0.1)
        let hi = Foundation.log10(16_667.0 * 1.4)
        let v = Foundation.log10(Swift.max(micros, 0.1))
        return CGFloat((v - lo) / (hi - lo)) * width
    }

    private func microLabel(_ micros: Double) -> String {
        micros >= 1000
            ? String(format: "%.2fms", micros / 1000)
            : String(format: "%.1fµs", micros)
    }

    // MARK: match runs

    private func matchSection(_ report: BenchReport) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("whole matches, autoplayed · sim-seconds per wall-second")
            HStack(spacing: 18) {
                factorStat("median", report.medianRealTimeFactor)
                factorStat("worst", report.worstRealTimeFactor)
            }
            ForEach(report.matchRuns, id: \.seed) { run in
                HStack(spacing: 10) {
                    Text("seed \(run.seed)")
                        .foregroundStyle(.white.opacity(0.4))
                    Text("\(run.teamSize)v\(run.teamSize)")
                        .foregroundStyle(.white.opacity(0.4))
                    Text("\(String(format: "%.1f", run.simSeconds))s sim")
                        .foregroundStyle(.white.opacity(0.6))
                    Text("in \(String(format: "%.3f", run.wallSeconds))s wall")
                        .foregroundStyle(.white.opacity(0.6))
                    Text("\(String(format: "%.0f", run.realTimeFactor))x")
                        .foregroundStyle(.cyan)
                    if !run.finished {
                        Text("timed out").foregroundStyle(.red)
                    }
                }
                .font(.system(.caption2, design: .monospaced))
            }
        }
    }

    private func factorStat(_ name: String, _ value: Double) -> some View {
        HStack(spacing: 4) {
            Text(name).foregroundStyle(.white.opacity(0.4))
            Text("\(String(format: "%.0f", value))x real time").foregroundStyle(.cyan)
        }
        .font(.system(.caption, design: .monospaced))
    }

    // MARK: footer

    private func footer(_ report: BenchReport) -> some View {
        Text(
            "\(report.summary)  ·  checksum \(String(format: "%.4f", report.checksum)) "
                + "(consumed, not meaningful)"
        )
        .font(.system(size: 9, design: .monospaced))
        .foregroundStyle(.white.opacity(0.25))
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(.white.opacity(0.45))
    }
}
