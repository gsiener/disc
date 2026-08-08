// swift-tools-version: 6.0
import PackageDescription

// The simulation, as a plain library with no platform dependency.
//
// `UltimateSim` imports nothing from Metal, RealityKit, SwiftUI or UIKit, and it never
// will: the renderer depends on this package, this package never depends on the
// renderer. That is what keeps a renderer swap — including a fall back to Unity via a
// native plugin — cheap, and it is why the sim is being built first.
//
// `SimChecks` holds the assertions as a *library* rather than a test target, so the
// identical checks run in the terminal and inside the iOS app on device. `Testing` and
// `XCTest` both ship with Xcode rather than the Command Line Tools and neither runs in
// a shipped app; for a port whose whole risk is numbers that differ by platform, a
// suite that only ever runs on the Mac cannot tell you the arm64 build agrees.
//
//   swift run SimTests            — everything
//   swift run SimTests rng        — one suite
let package = Package(
    name: "UltimateSim",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "UltimateSim", targets: ["UltimateSim"]),
        .library(name: "SimChecks", targets: ["SimChecks"]),
        .library(name: "FlightUI", targets: ["FlightUI"]),
        .executable(name: "SimTests", targets: ["SimTests"]),
        .executable(name: "FlightScope", targets: ["FlightScope"]),
    ],
    targets: [
        // No fast-math, no `-Ounchecked`. Replay determinism depends on IEEE 754 basic
        // ops staying correctly rounded and on `a*b+c` never being contracted into an
        // FMA. Swift gives us that by default — this note is here so nobody adds a flag
        // that takes it away.
        .target(name: "UltimateSim"),
        .target(
            name: "SimChecks",
            dependencies: ["UltimateSim"],
            resources: [.copy("Goldens")]
        ),
        .executableTarget(name: "SimTests", dependencies: ["SimChecks"]),

        // The flight view, shared by the iOS app and the macOS window so there is one
        // implementation and not two that drift. `FlightUI` imports SwiftUI but nothing
        // platform-specific; `UltimateSim` stays clean of both.
        .target(name: "FlightUI", dependencies: ["UltimateSim"]),
        .executableTarget(name: "FlightScope", dependencies: ["FlightUI"]),
    ]
)
