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
        .library(name: "ProbeContract", targets: ["ProbeContract"]),
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

        // The dependency-free launch and probe contract — issue #21. Canonical
        // launch-argument names, receive-side values, probe keys, the probe
        // accessibility identifier, and the wire-format parser live here so a rename
        // is a compile error on both sides rather than a silent default at runtime.
        // Must not import SwiftUI, RealityKit, UIKit, or UltimateSim.
        .target(name: "ProbeContract"),

        // `SimChecks` depends on both the sim and the contract, because the contract
        // tests (ProbeContractTests) run through the same harness as the sim checks.
        // UltimateSim still does not depend on ProbeContract — the layering boundary
        // is preserved.
        .target(
            name: "SimChecks",
            dependencies: ["UltimateSim", "ProbeContract"],
            resources: [.copy("Goldens")]
        ),
        .executableTarget(name: "SimTests", dependencies: ["SimChecks"]),

        // Source-level audit of the product: every public `UltimateSim` func, and whether
        // anything a player can reach calls it. Deliberately dependency-free — it reads the
        // tree as text rather than parsing it, for the reasons its own header gives.
        .executableTarget(name: "Reachability"),

        // The flight view, shared by the iOS app and the macOS window so there is one
        // implementation and not two that drift. `FlightUI` imports SwiftUI but nothing
        // platform-specific; `UltimateSim` stays clean of both.
        // Depends on `SimChecks` as well as the sim, because `BenchView` draws a
        // `BenchReport` and the self-check screen draws a `CheckReport`. Both are
        // *returned* rather than printed precisely so a view can render them — see the
        // note at the top of `Harness.swift`.
        // Depends on `ProbeContract` so the probe producer (`MatchProbe`) emits only
        // shared `ProbeKey` cases and references the canonical probe identifier — issue #21.
        .target(name: "FlightUI", dependencies: ["UltimateSim", "SimChecks", "ProbeContract"]),
        .executableTarget(name: "FlightScope", dependencies: ["FlightUI"]),
    ]
)
