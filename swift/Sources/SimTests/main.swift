// The sim test runner.
//
//   swift run SimTests          — everything
//   swift run SimTests rng      — one suite
//
// Suites are listed in port order, which is also dependency order: the RNG anchors
// the differential harness, disc physics pins the flight model, rules pin the state
// machine. Add each new suite here as its module lands.

runSuites([
    Suite(name: "rng", run: RngTests.run),
    Suite(name: "coeffs", run: CoeffsTests.run),
])
