import Foundation

/// Sine and cosine, pinned so that the optimiser cannot substitute a different one.
///
/// LLVM's `SimplifyLibCalls` pass rewrites a neighbouring `sin(x)` and `cos(x)` on the
/// same argument into a single call to Darwin's `__sincos_stret`. That pass runs at `-O`
/// and not at `-Onone`, and **`__sincos_stret` does not return the same sine that `sin`
/// does** — the two differ by an ulp on some arguments. Neither is correctly rounded;
/// there is no accuracy argument for either. What matters is that the simulation gets the
/// same one every time.
///
/// Without this, an optimised build and an unoptimised build play *different matches*
/// from the same seed. The divergence is a single ulp in one body's velocity, and a
/// fifteen-minute match amplifies it into different possessions and a different score.
///
/// `@inline(never)` is the whole mechanism: the fusion happens after inlining, so a
/// function the optimiser cannot see into is a function whose call it cannot pair with
/// its neighbour. That also means the rule cannot be followed by reading the source —
/// a lone `sin` is fusable the moment an inlined caller computes `cos` of the same
/// angle — so **every** sine and cosine in this module goes through these two functions,
/// not just the ones that look like a pair.
///
/// The cost is about 3% of simulation time, measured over 120,000 ticks.
@inline(never)
func simSin(_ x: Double) -> Double { Foundation.sin(x) }

/// See `simSin`.
@inline(never)
func simCos(_ x: Double) -> Double { Foundation.cos(x) }
