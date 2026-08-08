import Foundation
import UltimateSim

/// The coefficient curves, against a sweep dumped from `src/sim/aero/Coeffs.ts`.
///
/// Strictness is split on a principle rather than by taste. `stallBlend` and
/// `reverseBlend` are pure arithmetic — compare, divide, multiply — so they are
/// asserted **bit-exact**, and any difference is a transcription bug. `lift`, `drag`
/// and `pitch` call `sin` and `tanh`, which no libm specifies to the last ulp, so
/// they get a tolerance that is tight enough to catch a wrong coefficient and loose
/// enough to survive a platform's rounding.
enum CoeffsTests {

    struct Sample: Decodable {
        let alpha: Double
        let stallBlend: Double
        let reverseBlend: Double
        let lift: Double
        let drag: Double
        let pitch: Double
    }
    struct File: Decodable {
        let note: String
        let disc: DiscBody
        let aero: AeroCoeffs
        let zeroLiftAlpha: Double
        let named: [String: Sample]
        let sweep: [Sample]
    }

    /// One ulp near 1.0 is about 2.2e-16, so this is roughly forty ulps of slack on a
    /// value of order 1 — far below any coefficient error that would matter, and far
    /// above the disagreement two libm implementations can produce.
    static let transcendentalTol = 1e-14

    static func run() throws {
        let g = try Goldens.load(File.self, "coeffs")
        let aero = AeroCoeffs.standard

        // The constants themselves. One assertion each, so a mistyped coefficient
        // fails as "the constants differ" rather than as unexplained drift in a
        // trajectory two modules downstream.
        Check.eq(aero, g.aero, "AeroCoeffs.standard matches the reference constants")
        Check.eq(DiscBody.standard, g.disc, "DiscBody.standard matches the reference constants")
        Check.bitEq(aero.zeroLiftAlpha, g.zeroLiftAlpha, "zeroLiftAlpha")

        // The named boundary angles, which are where a piecewise curve goes wrong.
        // Sorted so the run order — and therefore a failure list — is stable.
        for name in g.named.keys.sorted() {
            let s = g.named[name]!
            assertSample(aero, s, "named \(name) (alpha \(s.alpha))")
        }

        Check.eq(g.sweep.count, 361, "coeff sweep covers the full domain")
        for s in g.sweep {
            assertSample(aero, s, "sweep alpha \(s.alpha)")
        }

        physicalProperties(aero)

        let headroom = transcendentalTol / Swift.max(worstDeviation, Double.leastNormalMagnitude)
        Check.note(
            "worst sin/tanh deviation \(worstDeviation) (\(worstLabel)) — "
                + "\(String(format: "%.0f", headroom))× under tolerance")
    }

    /// The largest deviation actually seen, so the tolerance above is a measured
    /// margin rather than a hopeful constant. Printed at the end of the suite: if it
    /// ever creeps toward `transcendentalTol` that is drift worth knowing about
    /// before it becomes a failure.
    nonisolated(unsafe) static var worstDeviation = 0.0
    nonisolated(unsafe) static var worstLabel = "none"

    private static func assertSample(_ aero: AeroCoeffs, _ s: Sample, _ what: String) {
        Check.bitEq(aero.stallBlend(s.alpha), s.stallBlend, "\(what) stallBlend")
        Check.bitEq(aero.reverseBlend(s.alpha), s.reverseBlend, "\(what) reverseBlend")
        near(aero.liftCoeff(s.alpha), s.lift, "\(what) lift")
        near(aero.dragCoeff(s.alpha), s.drag, "\(what) drag")
        near(aero.pitchCoeff(s.alpha), s.pitch, "\(what) pitch")
    }

    private static func near(_ got: Double, _ want: Double, _ label: @autoclosure () -> String) {
        let deviation = abs(got - want)
        if deviation > worstDeviation {
            worstDeviation = deviation
            worstLabel = label()
        }
        Check.near(got, want, transcendentalTol, label())
    }

    /// Properties that must hold whatever the reference says.
    ///
    /// These are the assertions that would survive a deliberate retune of the
    /// coefficients, and they are the ones that encode what the curves *mean* — so
    /// they are worth more than the sweep if the two ever disagree.
    private static func physicalProperties(_ aero: AeroCoeffs) {
        // Drag is strictly positive everywhere, or the disc gains energy from the air.
        var minDrag = Double.infinity
        var alpha = -Double.pi
        while alpha <= Double.pi {
            minDrag = Swift.min(minDrag, aero.dragCoeff(alpha))
            alpha += 0.001
        }
        Check.ok(minDrag > 0, "drag is positive across the whole domain (min \(minDrag))")

        // Both blends are bounded, and saturate rather than overshoot.
        for a in stride(from: -Double.pi, through: Double.pi, by: 0.01) {
            Check.inRange(aero.stallBlend(a), 0, 1, "stallBlend bounded at \(a)")
            Check.inRange(aero.reverseBlend(a), 0, 1, "reverseBlend bounded at \(a)")
        }

        // Lift vanishes at the zero-lift angle. That is the definition of the angle,
        // and it is the one place the reversal blend must not have kicked in yet.
        Check.near(aero.liftCoeff(aero.zeroLiftAlpha), 0, 1e-15, "no lift at zeroLiftAlpha")

        // Face-on, the disc is a flat circular plate: CD ≈ 1.18. This is the single
        // assertion that would catch CDplate being confused with a total CD.
        Check.near(aero.dragCoeff(Double.pi / 2), 1.18, 1e-12, "CD face-on is flat-plate")

        // Fully separated at 90°, so no lift.
        Check.near(aero.liftCoeff(Double.pi / 2), 0, 1e-15, "no lift face-on")
        Check.bitEq(aero.stallBlend(Double.pi / 2), 1, "fully stalled face-on")

        // The pitching moment is bounded by its saturation, which is the whole point
        // of the tanh — a tumbling disc must not produce runaway moments.
        let bound = abs(aero.CM0) + abs(aero.CMa * aero.CMalphaSat)
        for a in stride(from: -Double.pi, through: Double.pi, by: 0.01) {
            Check.ok(abs(aero.pitchCoeff(a)) <= bound, "pitch moment saturates at \(a)")
        }

        // Nose-down at the low alpha of a fast throw, nose-up once mushing. This is
        // the "high-speed turn, low-speed fade" the header describes, and it is a
        // sign convention that is easy to invert in a port without noticing.
        Check.ok(aero.pitchCoeff(0) < 0, "pitching moment is nose-down at alpha 0")
        Check.ok(aero.pitchCoeff(0.5) > 0, "pitching moment is nose-up at high alpha")

        // The reversal is what makes an upside-down disc fall instead of glide.
        let normal = aero.dragCoeff(0)
        let reversed = aero.dragCoeff(aero.zeroLiftAlpha - aero.revWidth)
        Check.ok(reversed > normal, "reversed flow costs more drag (\(reversed) vs \(normal))")
        Check.ok(
            abs(aero.liftCoeff(-0.5)) < abs(aero.liftCoeff(0.5)),
            "reversed flow makes less lift than the equivalent normal angle")
    }
}
