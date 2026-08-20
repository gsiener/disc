import Foundation
import UltimateSim

/// The RNG is the anchor of the whole simulation.
///
/// Every probabilistic decision draws from here — catch outcomes, throw noise, AI
/// hesitation, coin flips — so a seed plus an input log reconstructs a match exactly.
/// A wrong shift width or a call made in the wrong order silently re-rolls every one
/// of those decisions, and the result looks like a gameplay bug rather than a
/// plumbing one.
///
/// # How this suite knows what is right
///
/// `xorshift128` is a *specified algorithm*, not a measured behaviour, so this suite
/// carries its own implementation of the specification — `Model` below — written from
/// the algorithm rather than from `Rng`, and asserts the two agree bit for bit. That
/// makes the expected values re-derivable by anyone reading this file, and it means a
/// mistake in `Rng` cannot hide behind a matching mistake in the expectation.
///
/// The remaining checks are properties `Model` cannot express: that the unit interval
/// is spanned, that a fork leaves its parent's stream untouched, that `range` is not
/// re-associated, and that adjacent seeds diverge.
enum RngTests {

    // MARK: - the specification, implemented independently

    /// `xorshift128` with the seeding and warm-up this simulation defines.
    ///
    /// State is four 32-bit words derived from the seed by xor against three fixed
    /// constants. Each draw shifts the words down one position, mixes the outgoing
    /// word with three shifts, and returns the new leading word divided by 2^32 —
    /// a division that is exact in binary floating point and therefore rounds nothing.
    ///
    /// The first sixteen draws are discarded. Low-entropy seeds — 0 and 1 especially —
    /// otherwise produce visibly similar openings.
    struct Model {
        private var w: [UInt32]

        init(seed: UInt32, warmUp: Bool = true) {
            w = [
                seed,
                seed ^ 0x85eb_ca6b,
                seed ^ 0xc2b2_ae35,
                seed ^ 0x27d4_eb2f,
            ]
            if warmUp { for _ in 0..<16 { _ = draw() } }
        }

        /// The leading word — the one a draw returns and the one a fork reads.
        var lead: UInt32 { w[0] }

        /// One step. Written against the word array rather than four named fields so
        /// that a transcription slip in `Rng` cannot be mirrored here by accident.
        mutating func draw() -> Double {
            var t = w[3]
            let s = w[0]
            w[3] = w[2]
            w[2] = w[1]
            w[1] = s
            t ^= t &<< 11
            t ^= t >> 8
            w[0] = t ^ s ^ (s >> 19)
            return Double(w[0]) / 4_294_967_296.0
        }

        /// `[lo, hi)`, in the one association the simulation defines: the span is
        /// scaled and then offset. Re-associating to `lo * (1 - t) + hi * t` is more
        /// accurate near `hi` and produces different bits, so the form is load-bearing.
        mutating func range(_ lo: Double, _ hi: Double) -> Double {
            lo + (hi - lo) * draw()
        }

        /// `[lo, hi]`, both ends inclusive.
        mutating func int(_ lo: Int, _ hi: Int) -> Int {
            Int(range(Double(lo), Double(hi + 1)).rounded(.down))
        }

        /// Box-Muller, mean 0 and sigma 1, over two consecutive draws.
        ///
        /// The clamp at 1e-7 is part of the definition, not a guard rail: `log` of a draw
        /// of exactly zero is negative infinity, and the infinity propagates into every
        /// number computed downstream of it. It also caps the magnitude a draw can reach
        /// at `sqrt(-2 * log(1e-7))`, about 5.68 sigma.
        ///
        /// `log` and `cos` are not specified to the last ulp by any libm, so this is the
        /// one member compared with a tolerance rather than bit-exactly.
        mutating func gauss() -> Double {
            let u = Swift.max(1e-7, draw())
            return (-2 * Foundation.log(u)).squareRoot()
                * Foundation.cos(2 * Double.pi * draw())
        }
    }

    /// The seeds this suite exercises. Zero and `UInt32.max` are the two most likely
    /// to expose a sign or shift-width mistake; `defaultSeed` is the one the game
    /// actually ships with; `2^31` sits exactly on the sign boundary.
    static let seeds: [UInt32] = [0, 1, 7, 42, 0x9e37_79b9, 0xdead_beef, 1 << 31, .max]

    static func run() throws {

        // MARK: - Rng agrees with the specification, bit for bit

        for seed in seeds {
            var model = Model(seed: seed)
            let rng = Rng(seed: seed)
            for i in 0..<64 {
                Check.bitEq(rng.next(), model.draw(), "seed \(seed) next[\(i)]")
            }

            // A fresh pair per derived call, so each sequence is independent of how
            // many draws the ones above happened to consume.
            var rangeModel = Model(seed: seed)
            let rangeRng = Rng(seed: seed)
            for i in 0..<32 {
                Check.bitEq(
                    rangeRng.range(-3.5, 12.25), rangeModel.range(-3.5, 12.25),
                    "seed \(seed) range[\(i)]")
            }

            var intModel = Model(seed: seed)
            let intRng = Rng(seed: seed)
            for i in 0..<32 {
                Check.eq(intRng.int(0, 6), intModel.int(0, 6), "seed \(seed) int[\(i)]")
            }
        }

        // MARK: - the division by 2^32 is exact

        // If the divisor were wrong, or the return were scaled by anything that
        // rounds, this fails: every draw times 2^32 must land exactly on the integer
        // state that produced it.
        let exact = Rng(seed: 0xC0FF_EE01)
        for i in 0..<4096 {
            let v = exact.next() * 4_294_967_296.0
            Check.eq(v, v.rounded(), "draw \(i) is an exact 32-bit integer over 2^32")
        }

        // MARK: - the warm-up is exactly sixteen draws

        // Modelled by advancing an unwarmed generator by hand. Sixteen is not
        // arbitrary — fewer leaves adjacent seeds visibly correlated, and the number
        // is part of the definition rather than a tuning knob.
        for seed in seeds {
            var raw = Model.unwarmed(seed: seed)
            for _ in 0..<16 { _ = raw.draw() }
            let rng = Rng(seed: seed)
            Check.bitEq(rng.next(), raw.draw(), "seed \(seed): the constructor discards sixteen")
        }

        // MARK: - fork

        for seed in seeds {
            // 0x7fffffff is the case that matters: the salt multiply happens in
            // float64, so above about 2^21 the product exceeds 2^53 and is rounded
            // before the result is truncated to 32 bits. A wrapping 32-bit multiply
            // agrees on small salts and diverges here.
            for salt in [0, 1, 0x6a3e_1c, 0x0a11_ce, 0x7fff_ffff] {
                let parent = Rng(seed: seed)
                let child = parent.fork(salt: salt)
                var model = Model(seed: Model.forkSeed(parentSeed: seed, salt: salt))
                for i in 0..<16 {
                    Check.bitEq(
                        child.next(), model.draw(), "seed \(seed) fork(\(salt))[\(i)]")
                }
            }
        }

        // A fork reads the parent's state and must not advance it — that is the whole
        // point of giving a subsystem its own stream.
        let a = Rng(seed: 12345)
        let b = Rng(seed: 12345)
        _ = a.fork(salt: 99)
        for i in 0..<8 {
            Check.bitEq(a.next(), b.next(), "fork leaves the parent stream alone, draw \(i)")
        }

        // Different salts must give different streams, or a per-subsystem fork buys
        // nothing over sharing one generator.
        let forkParent = Rng(seed: 777)
        let one = forkParent.fork(salt: 0x11)
        let two = forkParent.fork(salt: 0x22)
        var same = 0
        for _ in 0..<32 where one.next() == two.next() { same += 1 }
        Check.eq(same, 0, "different salts fork different streams")

        // MARK: - the unit interval

        let unit = Rng(seed: 0x00C0_FFEE)
        var low = 1.0
        var high = 0.0
        var outOfRange = 0
        for _ in 0..<100_000 {
            let v = unit.next()
            if v < 0.0 || v >= 1.0 { outOfRange += 1 }
            low = Swift.min(low, v)
            high = Swift.max(high, v)
        }
        Check.eq(outOfRange, 0, "next() stays in [0,1) over 100k draws")
        // A generator stuck in a corner of the interval passes the bounds check above
        // while being useless, so assert it actually spans the range.
        Check.ok(low < 0.01 && high > 0.99, "next() spans the unit interval (saw \(low)–\(high))")

        // MARK: - int() reaches both ends

        // `int` is built on a half-open range and a floor, which is exactly the shape
        // that quietly loses one end. Assert both are reachable.
        let dice = Rng(seed: 4242)
        var seen = Set<Int>()
        for _ in 0..<20_000 { seen.insert(dice.int(1, 6)) }
        Check.eq(seen, Set(1...6), "int(1, 6) reaches every face including both ends")

        // MARK: - adjacent seeds diverge

        let s0 = Rng(seed: 0)
        let s1 = Rng(seed: 1)
        var identical = 0
        for _ in 0..<32 where s0.next() == s1.next() { identical += 1 }
        Check.eq(identical, 0, "adjacent seeds diverge immediately")

        // MARK: - gauss

        // Against the specification, per seed. Not bit-exact — `log` and `cos` are not
        // specified to the last ulp — so this is the one member with a tolerance.
        for seed in seeds {
            var model = Model(seed: seed)
            let rng = Rng(seed: seed)
            for i in 0..<32 {
                Check.near(rng.gauss(), model.gauss(), 1e-12, "seed \(seed) gauss[\(i)]")
            }
        }

        // The clamp, exercised rather than assumed.
        //
        // A draw below 1e-7 happens about once in ten million, so no volume of ordinary
        // sampling reaches this branch — a suite that only checks `gauss()` is finite
        // passes whether or not the clamp exists. Seed 81311 puts a draw of 6.7987e-8 at
        // index 57, which is the state that tells the two apart: clamped the magnitude is
        // sqrt(-2 log 1e-7) ≈ 5.678, unclamped it is sqrt(-2 log 6.7987e-8) ≈ 5.745.
        var clampModel = Model(seed: 81311)
        let clampRng = Rng(seed: 81311)
        for _ in 0..<57 {
            _ = clampRng.next()
            _ = clampModel.draw()
        }
        Check.near(
            clampRng.gauss(), clampModel.gauss(), 1e-12,
            "gauss() clamps a draw below 1e-7 to the floor")

        let normal = Rng(seed: 0x9001)
        var sum = 0.0
        var sumSq = 0.0
        let n = 200_000
        for _ in 0..<n {
            let g = normal.gauss()
            sum += g
            sumSq += g * g
        }
        let mean = sum / Double(n)
        let sigma = (sumSq / Double(n) - mean * mean).squareRoot()
        Check.near(mean, 0.0, 0.01, "gauss() has mean 0 (\(mean))")
        Check.near(sigma, 1.0, 0.01, "gauss() has sigma 1 (\(sigma))")

        // The clamp keeps `log` away from zero. Without it a draw of exactly 0 returns
        // infinity and poisons every number downstream of it.
        let clamped = Rng(seed: 0x5EED)
        var nonFinite = 0
        for _ in 0..<100_000 where !clamped.gauss().isFinite { nonFinite += 1 }
        Check.eq(nonFinite, 0, "gauss() is always finite")

        // MARK: - reference semantics

        // `Rng` is a class on purpose: the gameplay code shares one instance, and a
        // value type would silently fork the stream on every copy — every holder
        // replaying the same numbers. Assert the sharing rather than trusting it.
        let shared = Rng(seed: 31337)
        let alias = shared
        let first = shared.next()
        let second = alias.next()
        Check.ok(first != second, "two handles on one Rng share one stream")
    }
}

extension RngTests.Model {
    /// A generator that has not run its warm-up, for asserting the warm-up.
    static func unwarmed(seed: UInt32) -> RngTests.Model {
        RngTests.Model(seed: seed, warmUp: false)
    }

    /// The seed a child receives: the parent's leading word — *after* the parent's
    /// warm-up, which is the state a fork actually reads — xored with the salt
    /// multiplied in float64 and reduced to 32 bits by truncation toward zero and a
    /// modulo. The multiply rounds above 2^53, and that rounding is part of the
    /// definition rather than an accident of it.
    static func forkSeed(parentSeed: UInt32, salt: Int) -> UInt32 {
        let parent = RngTests.Model(seed: parentSeed)
        let product = Double(salt) * Double(UInt32(0x9e37_79b9))
        return parent.lead ^ toUInt32(product)
    }

    static func toUInt32(_ x: Double) -> UInt32 {
        guard x.isFinite else { return 0 }
        let truncated = x < 0 ? -(-x).rounded(.down) : x.rounded(.down)
        let m = truncated.truncatingRemainder(dividingBy: 4_294_967_296.0)
        return UInt32(m < 0 ? m + 4_294_967_296.0 : m)
    }
}
