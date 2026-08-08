import Foundation
import UltimateSim

/// Measures the sim's hot paths on the device actually running it.
///
/// **Why this exists.** The project plan has carried "under 0.5 ms per tick" since
/// before any Swift existed — an estimate extrapolated from the Node.js prototype, never
/// measured against this port. That number has been true by assertion for a while. This
/// file turns it into a number: a falsifiable claim, on real hardware, that a reader can
/// check against `BenchReport.measurements` rather than trust.
///
/// **Method.**
///  - Timing uses `DispatchTime.now().uptimeNanoseconds`, which is monotonic and immune
///    to wall-clock adjustment. `Date()` is not used anywhere in this file.
///  - Every measured loop warms up first — see each `warmup` count — so the numbers
///    reflect steady state rather than the first-call cost of page faults and cache
///    misses.
///  - Each `Measurement` reports median *and* worst, not mean. A mean of 1000 ticks
///    hides the one tick that took ten times as long, and a dropped frame is exactly
///    that one tick, not the average.
///  - Every timed call's result is folded into `checksum`, a value carried in the
///    report. Nothing timed here is a pure function of only its arguments discarded
///    afterwards — an optimiser that can prove a result is unused is entitled to delete
///    the work that produced it, and a benchmark that lets that happen measures nothing.
///
/// **This says nothing about a release build.** `swift build` and `swift run` default to
/// the debug configuration — `-Onone`, no inlining, full runtime checks — and it is
/// several times slower than what actually ships. `BenchReport.isDebugBuild` records
/// which one produced the numbers, and it is not decoration: a debug-only reading
/// presented without that caveat is the same mistake this file exists to correct, one
/// level down.
public enum Bench {
    /// True when this binary was compiled `-Onone` (SwiftPM's debug configuration).
    ///
    /// SwiftPM defines the `DEBUG` compilation condition for the debug configuration and
    /// only that one — `swift build -c release` does not set it. That makes `#if DEBUG`
    /// a fact about *this build*, not a guess, as long as nothing in `Package.swift`
    /// overrides the default active compilation conditions. Nothing does.
    public static let isDebugBuild: Bool = {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }()
}

/// What a benchmark run produced. Returned rather than printed, mirroring
/// `CheckReport` — so the CLI can print it and the app can draw it from the same values.
public struct BenchReport: Sendable {
    /// One operation, timed `samples` times after `warmup` untimed calls.
    public struct Measurement: Sendable {
        public let name: String
        public let warmup: Int
        public let samples: Int
        public let medianMicros: Double
        public let meanMicros: Double
        public let worstMicros: Double

        /// The 60fps frame budget is 16_666.7 µs. This is how much of it the *median*
        /// call spends — a quick way to see the headroom without doing the arithmetic
        /// while reading a report.
        public var fractionOf60fpsFrame: Double { medianMicros / 16_666.7 }
    }

    /// One full match, autoplayed by both teams, timed end to end.
    public struct MatchRun: Sendable {
        public let seed: UInt32
        public let teamSize: Int
        /// Sim-clock seconds the match covered before it finished or the timeout hit.
        public let simSeconds: Double
        public let wallSeconds: Double
        public let finished: Bool
        /// Sim-seconds simulated per wall-clock second — "how many times faster than
        /// real time." A phone that cannot clear 1.0 here cannot run the game live.
        public var realTimeFactor: Double { wallSeconds > 0 ? simSeconds / wallSeconds : .infinity }
    }

    public let measurements: [Measurement]
    public let matchRuns: [MatchRun]
    /// Median and worst across `matchRuns`, so one unlucky (or unusually long) match
    /// cannot stand in for the whole picture.
    public let medianRealTimeFactor: Double
    public let worstRealTimeFactor: Double
    public let isDebugBuild: Bool
    /// Every timed result folded together. Meaningless as a number; its only job is to
    /// exist, so the compiler cannot conclude the measured work was unobserved and
    /// delete it.
    public let checksum: Double
    /// Wall time the whole benchmark run took, including warmups.
    public let seconds: Double

    /// A one-line summary, matching `CheckReport.summary`'s "print this and move on"
    /// role.
    public var summary: String {
        let build = isDebugBuild ? "DEBUG (unoptimized, slower than a shipped build)" : "RELEASE"
        return "\(build)  \(measurements.count) measurements, "
            + "\(matchRuns.count) full matches, "
            + "median \(String(format: "%.0f", medianRealTimeFactor))x real time "
            + "(worst \(String(format: "%.0f", worstRealTimeFactor))x)"
    }
}

/// Runs every benchmark and returns the report.
///
/// - Parameters:
///   - matchSeeds: one full autoplayed match per seed. Varying the seed varies the
///     possessions played — a single scripted match could happen to be short or long
///     for reasons that have nothing to do with steady-state cost.
///   - matchTimeoutSimSeconds: matches `MatchTests.terminates()`'s own ceiling, so a
///     benchmark run and a correctness run agree on what "unreasonably long" means.
public func runBench(
    matchSeeds: [UInt32] = [101, 202, 303, 404, 505],
    matchTimeoutSimSeconds: Double = 60 * 20
) -> BenchReport {
    let started = DispatchTime.now()
    var checksum = 0.0

    var measurements: [BenchReport.Measurement] = []
    measurements.append(benchDiscStep(checksum: &checksum))
    measurements.append(benchMatchStep(field: .minis, label: "match.step 3v3", checksum: &checksum))
    measurements.append(benchMatchStep(field: .full, label: "match.step 7v7", checksum: &checksum))

    let matchRuns = matchSeeds.map {
        benchWholeMatch(seed: $0, timeoutSimSeconds: matchTimeoutSimSeconds, checksum: &checksum)
    }
    let factors = matchRuns.map(\.realTimeFactor).sorted()

    let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1e9

    return BenchReport(
        measurements: measurements,
        matchRuns: matchRuns,
        medianRealTimeFactor: factors.isEmpty ? 0 : factors[factors.count / 2],
        worstRealTimeFactor: factors.min() ?? 0,
        isDebugBuild: Bench.isDebugBuild,
        checksum: checksum,
        seconds: elapsed
    )
}

// MARK: - individual benchmarks

/// A fresh throw to measure from, well clear of the ground and slow to get back to it —
/// a hammer's high loft keeps the disc airborne for several seconds, which matters here
/// only in that it means most timed calls land in ordinary flight rather than the ground
/// contact branch.
private func freshFlight() -> DiscState {
    throwDisc(.hammer, from: Vec3d(0, 1.6, 0), aim: Vec3d(1, 0, 0), power: 0.9, spin: 0.6)
}

/// The innermost hot loop: one call to `DiscState.step(dt:)`.
///
/// Every player's throw, every frame the disc is in the air, goes through exactly this.
/// If anything in the sim is going to blow the frame budget, it is either this or the
/// per-frame cost of everyone's steering, and this is the one call site nothing else
/// wraps.
private func benchDiscStep(checksum: inout Double) -> BenchReport.Measurement {
    let warmup = 200
    let samples = 2000
    var s = freshFlight()

    func stepOnce() -> Double {
        if s.atRest { s = freshFlight() }
        s.step(dt: FIXED_DT)
        return s.pos.x + s.pos.y + s.pos.z
    }

    for _ in 0..<warmup { checksum += stepOnce() }

    var micros = [Double]()
    micros.reserveCapacity(samples)
    for _ in 0..<samples {
        let t0 = DispatchTime.now().uptimeNanoseconds
        let result = stepOnce()
        let t1 = DispatchTime.now().uptimeNanoseconds
        micros.append(Double(t1 - t0) / 1000)
        checksum += result
    }

    return summarize("disc.step (flight, innermost)", warmup: warmup, micros: micros)
}

/// One `Match.step(dt:)` call with both teams on autopilot, at the field size named.
///
/// This is the number that actually answers "under 0.5 ms per tick": a tick in the game
/// is this call, not the disc step alone, because every frame also steers every player,
/// resolves catches, and — for whichever side is on autopilot — decides whether to
/// throw. 7v7 repeats the O(n²) separation pass over more than twice the bodies of 3v3,
/// so the two are measured separately rather than assumed to scale the same way.
private func benchMatchStep(
    field: FieldSpec, label: String, checksum: inout Double
) -> BenchReport.Measurement {
    let warmup = 50
    let samples = 500
    let dt = 1.0 / 60  // the app's own display-paced loop steps at this cadence.

    // One long-running match rather than a fresh one per sample: a fresh match spends
    // its first tick in the post-pull setup, which is not what a steady-state tick
    // costs, and a match that runs the full warmup-plus-samples span passes through
    // held, flight and dead phases the way real play does.
    let m = Match(field: field, seed: 909)
    m.autoTeams = [0, 1]

    func stepOnce() -> Double {
        if m.isOver { m.reset(pullingTeam: 0) }
        m.step(dt: dt)
        return Double(m.score[0] + m.score[1]) + m.disc.pos.x
    }

    for _ in 0..<warmup { checksum += stepOnce() }

    var micros = [Double]()
    micros.reserveCapacity(samples)
    for _ in 0..<samples {
        let t0 = DispatchTime.now().uptimeNanoseconds
        let result = stepOnce()
        let t1 = DispatchTime.now().uptimeNanoseconds
        micros.append(Double(t1 - t0) / 1000)
        checksum += result
    }

    return summarize(label, warmup: warmup, micros: micros)
}

/// Plays one match to completion, both teams on autopilot, and reports sim-seconds
/// simulated per wall-clock second.
///
/// This is the "how many times faster than real time" number, and it is the one that
/// most directly answers whether the sim can run live: below 1x it cannot keep up with
/// a game clock no matter how the rest of the app is built.
private func benchWholeMatch(
    seed: UInt32, timeoutSimSeconds: Double, checksum: inout Double
) -> BenchReport.MatchRun {
    let m = Match(field: .minis, seed: seed)
    m.autoTeams = [0, 1]
    let dt = 1.0 / 60

    var simSeconds = 0.0
    let started = DispatchTime.now()
    while !m.isOver && simSeconds < timeoutSimSeconds {
        m.step(dt: dt)
        simSeconds += dt
    }
    let wallSeconds = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1e9

    checksum += Double(m.score[0] + m.score[1]) + m.disc.pos.x

    return BenchReport.MatchRun(
        seed: seed, teamSize: m.field.teamSize,
        simSeconds: simSeconds, wallSeconds: wallSeconds, finished: m.isOver)
}

/// Median and worst, in microseconds, over a set of per-call timings.
private func summarize(_ name: String, warmup: Int, micros: [Double]) -> BenchReport.Measurement {
    let sorted = micros.sorted()
    let median = sorted[sorted.count / 2]
    let worst = sorted.last ?? 0
    let mean = sorted.reduce(0, +) / Double(sorted.count)
    return BenchReport.Measurement(
        name: name, warmup: warmup, samples: sorted.count,
        medianMicros: median, meanMicros: mean, worstMicros: worst)
}
