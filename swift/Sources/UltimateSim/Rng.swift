import Foundation

/// Seeded xorshift128, a bit-exact port of `SeededRng` in `src/sim/Playbook.ts`.
///
/// Every probabilistic decision in the game draws from here: catch outcomes,
/// throw noise, AI hesitation, coin flips. Seed plus input log reconstructs a
/// match exactly, which is what makes replay, and therefore the resume-on-launch
/// behaviour a phone needs, close to free.
///
/// **This is a class, not a struct, and that is deliberate.** A struct would be
/// faster and would suit the rest of `SimMath`, but a random generator carries
/// mutable state whose whole value is that there is exactly one of it. Passing a
/// struct by value silently forks the stream — every copy replays the same
/// numbers — and the resulting divergence looks like a gameplay bug, not a
/// plumbing bug. The reference implementation is a JavaScript class and the
/// gameplay code shares one instance; matching that reference semantics is worth
/// more than avoiding one allocation per point.
public final class Rng {
    private var a: UInt32
    private var b: UInt32
    private var c: UInt32
    private var d: UInt32

    public static let defaultSeed: UInt32 = 0x9e37_79b9

    public init(seed: UInt32 = Rng.defaultSeed) {
        a = seed
        b = seed ^ 0x85eb_ca6b
        c = seed ^ 0xc2b2_ae35
        d = seed ^ 0x27d4_eb2f
        // The reference discards the first sixteen draws to wash out low-entropy
        // seeds — seed 0 and seed 1 otherwise produce visibly similar openings.
        for _ in 0..<16 { _ = next() }
    }

    /// A uniform double in `[0, 1)`.
    ///
    /// The uint32 arithmetic here is bit-identical to the JavaScript despite the
    /// signedness difference: `^`, `<<` and `>>>` in JS all truncate to 32 bits,
    /// and xor and left-shift produce the same bit pattern whether the operand is
    /// read as signed or unsigned. `>>` on `UInt32` in Swift is a logical shift,
    /// which is what `>>>` means. The final divide by 2^32 is exact in binary
    /// floating point, so it introduces no rounding of its own.
    @discardableResult
    public func next() -> Double {
        var t = d
        let s = a
        d = c
        c = b
        b = s
        t ^= t &<< 11
        t ^= t >> 8
        a = t ^ s ^ (s >> 19)
        return Double(a) / 4_294_967_296.0
    }

    /// A uniform double in `[lo, hi)`.
    ///
    /// Written as `lo + (hi - lo) * next()` to match the reference exactly.
    /// Re-associating this — `lo * (1 - t) + hi * t`, say — is more accurate near
    /// `hi` and would break bit-equality, so it is left alone on purpose.
    public func range(_ lo: Double, _ hi: Double) -> Double {
        lo + (hi - lo) * next()
    }

    /// A uniform integer in `[lo, hi]`, both ends inclusive.
    public func int(_ lo: Int, _ hi: Int) -> Int {
        Int(range(Double(lo), Double(hi + 1)).rounded(.down))
    }

    /// Box-Muller, mean 0, sigma 1.
    ///
    /// The one member that is not bit-exact across platforms: `log` and `cos` are
    /// not specified to the last ulp by any libm, so this agrees with the
    /// TypeScript to about 1e-12 rather than exactly. `sqrt` is correctly rounded
    /// and contributes nothing. The clamp at 1e-7 keeps `log` away from zero and
    /// must stay, or a draw of exactly 0 returns infinity.
    public func gauss() -> Double {
        let u = Swift.max(1e-7, next())
        return (-2 * Foundation.log(u)).squareRoot() * simCos(2 * Double.pi * next())
    }

    /// A child generator derived from this one's current state, without disturbing it.
    ///
    /// Used to give a subsystem its own stream so that adding a draw in one place
    /// does not shift every downstream decision.
    ///
    /// The salt multiply is the subtle part. The reference computes
    /// `(this.a ^ (salt * 0x9e3779b9)) >>> 0`, and in JavaScript that multiply
    /// happens in **float64** — so for salts above about 2^21 the product exceeds
    /// 2^53 and is *rounded* before `^` truncates it. Multiplying in `UInt32` with
    /// wrapping would agree for small salts and quietly diverge for large ones.
    /// So the rounding is reproduced first, then JavaScript's ToUint32 is applied
    /// to the result.
    public func fork(salt: Int) -> Rng {
        let product = Double(salt) * Double(Rng.defaultSeed)
        return Rng(seed: a ^ Rng.jsToUInt32(product))
    }

    /// JavaScript's `ToUint32`: truncate toward zero, then reduce modulo 2^32.
    ///
    /// `truncatingRemainder` is exact for integer-valued doubles of any magnitude,
    /// so no precision is lost beyond the rounding the caller already incurred.
    static func jsToUInt32(_ x: Double) -> UInt32 {
        guard x.isFinite else { return 0 }
        let truncated = x < 0 ? -(-x).rounded(.down) : x.rounded(.down)
        let m = truncated.truncatingRemainder(dividingBy: 4_294_967_296.0)
        return UInt32(m < 0 ? m + 4_294_967_296.0 : m)
    }
}
