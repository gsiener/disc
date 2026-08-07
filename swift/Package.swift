// swift-tools-version: 6.0
import PackageDescription

// The simulation, as a plain library with no platform dependency.
//
// This is deliberately not an app target and imports nothing from Metal,
// RealityKit, SwiftUI or UIKit. The sim is the part of this project worth the
// most and hardest to re-derive, so it stays buildable and testable from the
// command line — no Xcode, no simulator, no device. The renderer will depend on
// this package; this package will never depend on the renderer. That also means
// the entire sim port can proceed before Xcode is installed.
//
// Tests are an *executable*, not a test target, because `Testing` and `XCTest`
// both ship with Xcode rather than with the Command Line Tools. This mirrors the
// TypeScript reference, where each suite is a plain script run as
// `node tools/test-disc.ts` and reports `PASS n assertions, 0 failures`. For a
// determinism-critical sim that is arguably the better shape anyway: the run is
// ordered and single-threaded, so a failure reproduces exactly.
//
//   swift run SimTests            — everything
//   swift run SimTests rng disc   — only the named suites
let package = Package(
    name: "UltimateSim",
    products: [
        .library(name: "UltimateSim", targets: ["UltimateSim"]),
        .executable(name: "SimTests", targets: ["SimTests"]),
    ],
    targets: [
        // No fast-math, no `-Ounchecked`. Replay determinism depends on IEEE 754
        // basic ops staying correctly rounded and on `a*b+c` never being
        // contracted into an FMA. Swift gives us that by default — this note is
        // here so nobody adds a flag that takes it away.
        .target(name: "UltimateSim"),
        .executableTarget(name: "SimTests", dependencies: ["UltimateSim"]),
    ]
)
