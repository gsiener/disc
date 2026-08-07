import Foundation
import UltimateSim

/// The RNG is the anchor of the whole port.
///
/// Everything else in this suite gets a tolerance. This does not: xorshift128 is
/// pure uint32 shift and xor, and the division by 2^32 is exact in binary floating
/// point, so a correct port matches the TypeScript **bit for bit**. Divergence here
/// is never numeric drift — it is a wrong shift width or a call made in the wrong
/// order, and it would silently re-roll every probabilistic decision in the game.
///
/// Goldens come from `tools/gen-goldens.ts`, run against `src/sim/Playbook.ts`.
enum RngTests {

    struct Fork: Decodable {
        let salt: Int
        let next: [Double]
    }
    struct Case: Decodable {
        let seed: UInt32
        let next: [Double]
        let range: [Double]
        let int: [Int]
        let gauss: [Double]
        let forks: [Fork]
    }
    struct File: Decodable {
        let note: String
        let cases: [Case]
    }

    static func run() {
        let goldens = Goldens.load(File.self, "rng")

        // Fail loudly if a regenerate drops coverage. Seed 0 and seed 0xffffffff
        // are the two most likely to expose a sign or shift-width mistake.
        Check.eq(goldens.cases.count, 8, "rng goldens cover eight seeds")
        let seeds = Set(goldens.cases.map(\.seed))
        Check.ok(seeds.contains(0), "rng goldens include seed 0")
        Check.ok(seeds.contains(UInt32.max), "rng goldens include seed 0xffffffff")

        for c in goldens.cases {
            // next() — bit-exact, every seed, every draw.
            let rng = Rng(seed: c.seed)
            for (i, want) in c.next.enumerated() {
                Check.bitEq(rng.next(), want, "seed \(c.seed) next[\(i)]")
            }

            // range() — next() scaled. Bit-exact only if the expression is not
            // re-associated, which is the point of asserting it separately.
            let rangeRng = Rng(seed: c.seed)
            for (i, want) in c.range.enumerated() {
                Check.bitEq(rangeRng.range(-3.5, 12.25), want, "seed \(c.seed) range[\(i)]")
            }

            // int() — the floor and the inclusive upper bound.
            let intRng = Rng(seed: c.seed)
            for (i, want) in c.int.enumerated() {
                Check.eq(intRng.int(0, 6), want, "seed \(c.seed) int[\(i)]")
            }

            // gauss() — the one member that cannot be bit-exact, because `log`
            // and `cos` are not specified to the last ulp by any libm. The
            // tolerance is the honest statement of what this port promises.
            let gaussRng = Rng(seed: c.seed)
            for (i, want) in c.gauss.enumerated() {
                Check.near(gaussRng.gauss(), want, 1e-12, "seed \(c.seed) gauss[\(i)]")
            }

            // fork() — including 0x7fffffff, where the reference's float64 multiply
            // exceeds 2^53 and rounds. A UInt32 wrapping multiply agrees on small
            // salts and diverges here, which is exactly the bug that would ship.
            for f in c.forks {
                let parent = Rng(seed: c.seed)
                let child = parent.fork(salt: f.salt)
                for (i, want) in f.next.enumerated() {
                    Check.bitEq(child.next(), want, "seed \(c.seed) fork(\(f.salt))[\(i)]")
                }
            }
        }

        // Properties that hold regardless of the reference.

        let a = Rng(seed: 12345)
        let b = Rng(seed: 12345)
        _ = a.fork(salt: 99)
        for i in 0..<8 {
            Check.bitEq(a.next(), b.next(), "fork leaves the parent stream alone, draw \(i)")
        }

        let unit = Rng(seed: 0x00C0_FFEE)
        var low = 0.0
        var high = 0.0
        var outOfRange = 0
        for _ in 0..<100_000 {
            let v = unit.next()
            if v < 0.0 || v >= 1.0 { outOfRange += 1 }
            low = Swift.min(low, v)
            high = Swift.max(high, v)
        }
        Check.eq(outOfRange, 0, "next() stays in [0,1) over 100k draws")
        // A generator stuck in a corner of the interval passes the bounds check
        // above while being useless, so assert it actually spans the range.
        Check.ok(low < 0.01 && high > 0.99, "next() spans the unit interval (saw \(low)–\(high))")

        // Two different seeds must not produce the same opening. The sixteen
        // discarded warmup draws in the constructor exist for this.
        let s0 = Rng(seed: 0)
        let s1 = Rng(seed: 1)
        var identical = 0
        for _ in 0..<32 where s0.next() == s1.next() { identical += 1 }
        Check.eq(identical, 0, "adjacent seeds diverge immediately")
    }
}
