import Foundation
import UltimateSim

/// The disc's aerodynamic coefficients, against the curves they claim to be.
///
/// # How this suite knows what is right
///
/// Nothing here is a recorded output. Every coefficient curve in `Aero/Coeffs.swift` has
/// a *stated* shape, and a shape can be checked without ever having run the function
/// before:
///
///  - **A law.** The attached-flow lift is a straight line, so two points on it recover
///    `CL0` and `CLa` and every other point must lie on the line they define. The
///    attached-flow drag is a parabola, so three points recover its vertex, its floor and
///    its curvature — and the vertex must be `alpha0`, the floor `CD0`, the curvature
///    `CDa`. Fully separated, the disc is a flat plate: `CL = CLplate·sin(2α)` and
///    `CD = CD0 + CDplate·sin²(α)`, so dividing the measured curve by `sin(2α)` and by
///    `sin²(α)` must return the two plate constants exactly. Fully reversed, the two
///    reversal numbers are pure multipliers, so they come back as ratios. The zero-lift
///    angle is a root: evaluate the lift there and it is zero. These are the strongest
///    assertions in the file, because no transcription of a *different* formula satisfies
///    them.
///  - **`Model`** — the same five curves written a second time, deliberately in a
///    different shape: smoothstep as `1 − (1−x)²(1+2x)` rather than `x²(3−2x)`, the stall
///    mix as `attached + s·(plate − attached)` rather than a two-term weighted sum, the
///    reversal as a lerp from `1` toward the multiplier rather than as `1 ± r(…)`, and
///    `tanh` rebuilt out of `expm1`. Same mathematics, different expression trees, so a
///    slip in one is not mirrored in the other.
///  - **The dependency structure.** Each curve declares exactly which coefficients it
///    reads. That is verified by moving every coefficient in turn and checking the curve
///    moves if and only if it declared that input — which is what catches a curve reading
///    the wrong constant while still producing entirely plausible numbers. It is also
///    what pins the one non-obvious edge in this module: `CL0` and `CLa` reach the *drag*
///    curve, because `zeroLiftAlpha` is where the reversal blend is anchored.
///
/// **`Model` is run against thirteen different coefficient sets, not just the shipped
/// one.** `AeroCoeffs` is `Decodable`, so a perturbed set can be built without a
/// memberwise initialiser — and a formula that agrees with its specification only at the
/// shipped values is not agreeing with the specification. This is the same mechanism the
/// dependency check uses.
///
/// The constants themselves are pinned by exact value as well as by law. A relation is
/// the right assertion for a curve and the wrong one for a tuning number: `CDplate = 1.10`
/// is a measurement of a circular plate, not a consequence of anything else in here.
enum CoeffsTests {

    // MARK: - tolerances

    /// The `Model` comparison, and every law that goes through `sin`, `tanh` or a
    /// division. Every quantity compared at this tolerance is of order 0.001–3, so this is
    /// twelve or more digits of agreement — far below any coefficient error that could
    /// matter, and far above what two expression trees for the same algebra can differ by.
    static let curveTol = 1e-13

    /// Recovering a constant from the curve costs a division by a small difference, so the
    /// extracted value carries more rounding than the curve itself does. Still eleven
    /// digits: a swapped or mistyped coefficient is off in the second.
    static let extractTol = 1e-11

    // MARK: - the coefficient table, by exact value

    /// Every field of `AeroCoeffs.standard`, named, with the number it must hold.
    ///
    /// This list is the base for `perturbed` below as well as the value pin, so the two
    /// cannot drift apart: `perturbed([:])` reconstructs `AeroCoeffs.standard` through
    /// JSON and is asserted equal to it, which is what proves the table transcribes the
    /// module rather than merely resembling it.
    struct Field<T>: Sendable {
        let name: String
        let read: @Sendable (T) -> Double
        let value: Double
    }

    static let aeroFields: [Field<AeroCoeffs>] = [
        .init(name: "rho", read: { $0.rho }, value: 1.225),
        .init(name: "g", read: { $0.g }, value: 9.81),
        .init(name: "CL0", read: { $0.CL0 }, value: 0.15),
        .init(name: "CLa", read: { $0.CLa }, value: 2.0),
        .init(name: "CD0", read: { $0.CD0 }, value: 0.08),
        .init(name: "CDa", read: { $0.CDa }, value: 2.6),
        .init(name: "alpha0", read: { $0.alpha0 }, value: -0.07),
        .init(name: "CM0", read: { $0.CM0 }, value: -0.0035),
        .init(name: "CMa", read: { $0.CMa }, value: 0.15),
        .init(name: "CMq", read: { $0.CMq }, value: -0.012),
        .init(name: "CMalphaSat", read: { $0.CMalphaSat }, value: 0.7),
        .init(name: "CRr", read: { $0.CRr }, value: -0.0030),
        .init(name: "CRp", read: { $0.CRp }, value: -0.0055),
        .init(name: "CNr", read: { $0.CNr }, value: -0.0045),
        .init(name: "aStall", read: { $0.aStall }, value: 0.40),
        .init(name: "aStallWidth", read: { $0.aStallWidth }, value: 0.35),
        .init(name: "CLplate", read: { $0.CLplate }, value: 1.0),
        .init(name: "CDplate", read: { $0.CDplate }, value: 1.10),
        .init(name: "revWidth", read: { $0.revWidth }, value: 0.22),
        .init(name: "revLift", read: { $0.revLift }, value: 0.15),
        .init(name: "revDrag", read: { $0.revDrag }, value: 2.2),
    ]

    static let bodyFields: [Field<DiscBody>] = [
        .init(name: "mass", read: { $0.mass }, value: 0.175),
        .init(name: "diameter", read: { $0.diameter }, value: 0.273),
        .init(name: "radius", read: { $0.radius }, value: 0.1365),
        .init(name: "area", read: { $0.area }, value: 0.0568),
        .init(name: "Ixx", read: { $0.Ixx }, value: 5.05e-4),
        .init(name: "Izz", read: { $0.Izz }, value: 1.01e-3),
        .init(name: "halfHeight", read: { $0.halfHeight }, value: 0.013),
    ]

    /// An `AeroCoeffs` with named fields overridden.
    ///
    /// Built through `Decodable` because the memberwise initialiser is internal to
    /// `UltimateSim`. That is not a workaround for a missing API — a checks module should
    /// not be able to hand the simulation a coefficient set the simulation cannot express,
    /// and going through the same decoder the module already declares keeps that true.
    static func perturbed(_ overrides: [String: Double]) -> AeroCoeffs {
        var fields = Dictionary(uniqueKeysWithValues: aeroFields.map { ($0.name, $0.value) })
        for (key, value) in overrides { fields[key] = value }
        let data = try! JSONSerialization.data(withJSONObject: fields)
        return try! JSONDecoder().decode(AeroCoeffs.self, from: data)
    }

    // MARK: - the specification, implemented independently

    /// The five curves, written a second time and in a different shape.
    ///
    /// Nothing in here calls `AeroCoeffs`' own methods; the coefficient set is read for
    /// its numbers only.
    enum Model {

        /// The Hermite smoothstep, as "one minus the mirrored ramp".
        ///
        /// `(1−x)²(1+2x)` expands to `1 − 3x² + 2x³`, so this is the same cubic
        /// `Coeffs.swift` writes as `x²(3 − 2x)` — reached through a different expression
        /// tree, which is the point.
        static func smoothstep(_ x: Double) -> Double {
            if x <= 0 { return 0 }
            if x >= 1 { return 1 }
            let m = 1 - x
            return 1 - m * m * (1 + 2 * x)
        }

        static func zeroLift(_ c: AeroCoeffs) -> Double { -(c.CL0 / c.CLa) }

        static func stall(_ c: AeroCoeffs, _ a: Double) -> Double {
            smoothstep((abs(a) - c.aStall) / c.aStallWidth)
        }

        static func reverse(_ c: AeroCoeffs, _ a: Double) -> Double {
            smoothstep((zeroLift(c) - a) / c.revWidth)
        }

        /// A linear blend written as "start, plus the fraction of the gap".
        static func mix(_ from: Double, _ to: Double, _ t: Double) -> Double {
            from + t * (to - from)
        }

        static func lift(_ c: AeroCoeffs, _ a: Double) -> Double {
            let attached = c.CL0 + c.CLa * a
            let plate = c.CLplate * Foundation.sin(2 * a)
            let blended = mix(attached, plate, stall(c, a))
            return blended * mix(1, c.revLift, reverse(c, a))
        }

        static func drag(_ c: AeroCoeffs, _ a: Double) -> Double {
            let d = a - c.alpha0
            let attached = c.CDa * (d * d) + c.CD0
            let sa = Foundation.sin(a)
            let plate = c.CDplate * (sa * sa) + c.CD0
            let blended = mix(attached, plate, stall(c, a))
            return blended * mix(1, c.revDrag, reverse(c, a))
        }

        /// `tanh` from its exponential definition, so the saturation is not taken on
        /// trust from libm's `tanh` on both sides.
        ///
        /// `expm1(2u) / (expm1(2u) + 2)` is `(e^{2u} − 1)/(e^{2u} + 1)` with the
        /// cancellation near `u = 0` removed — exactly zero at zero, and saturating to
        /// ±1 as `expm1` reaches ±∞ and −1.
        static func tanh(_ u: Double) -> Double {
            let e = Foundation.expm1(2 * u)
            if e.isInfinite { return 1 }
            return e / (e + 2)
        }

        static func pitch(_ c: AeroCoeffs, _ a: Double) -> Double {
            c.CM0 + c.CMa * c.CMalphaSat * tanh(a / c.CMalphaSat)
        }
    }

    // MARK: - entry point

    static func run() throws {
        constants()
        inertia()
        smoothstepShape()
        blendShapes()
        modelAgreement()
        attachedLine()
        attachedParabola()
        flatPlate()
        reversal()
        pitchSaturation()
        globalProperties()
        dependencyStructure()
    }

    // MARK: - the constants

    /// Exact values, one assertion per field.
    ///
    /// The relations elsewhere in this file are the right assertion for a *curve*; they
    /// are the wrong assertion for a *tuning value*, which nothing else constrains. Every
    /// number this module declares is pinned here, including the four (`CMq`, `CRr`,
    /// `CRp`, `CNr`) that no curve in `Coeffs.swift` reads — they are consumed by the
    /// flight derivative, and this is the file that owns their values.
    private static func constants() {
        let aero = AeroCoeffs.standard
        for f in aeroFields {
            Check.bitEq(f.read(aero), f.value, "AeroCoeffs.standard.\(f.name)")
        }
        let body = DiscBody.standard
        for f in bodyFields {
            Check.bitEq(f.read(body), f.value, "DiscBody.standard.\(f.name)")
        }
        Check.eq(aeroFields.count, 21, "every AeroCoeffs field is pinned")
        Check.eq(bodyFields.count, 7, "every DiscBody field is pinned")

        // The field table above is also what `perturbed` builds from, so this is what
        // stops the two from describing different coefficient sets.
        Check.eq(perturbed([:]), aero, "the pinned field table rebuilds AeroCoeffs.standard")

        // Signs are a statement about the physics, not about the numbers: damping opposes
        // the rate that drives it, and the disc makes lift at zero alpha.
        Check.ok(aero.CMq < 0, "pitch-rate damping opposes the pitch rate")
        Check.ok(aero.CRp < 0, "roll-rate damping opposes the roll rate")
        Check.ok(aero.CNr < 0, "skin friction opposes the spin")
        Check.ok(aero.CL0 > 0, "a disc makes lift at zero angle of attack")
        Check.ok(aero.CLa > 0, "lift rises with angle of attack")
        Check.ok(aero.CM0 < 0 && aero.CMa > 0, "nose-down when fast, nose-up when mushing")
        Check.ok(aero.revLift < 1 && aero.revDrag > 1, "reversed flow: less lift, more drag")
    }

    /// The disc as a rigid body.
    private static func inertia() {
        let b = DiscBody.standard
        Check.bitEq(b.radius, b.diameter / 2, "radius is half the diameter")

        // The perpendicular-axis theorem for a planar body: Izz = Ixx + Iyy, and the disc
        // is axisymmetric, so Iyy = Ixx. This is a law, not a tuning choice, and a swap of
        // the two moments is otherwise entirely plausible-looking.
        Check.bitEq(b.Izz, 2 * b.Ixx, "Izz = Ixx + Iyy for a flat, axisymmetric body")

        // **A STATED EXCEPTION.** The planform area is the published wind-tunnel reference
        // area for a 175 g disc, not π r² of the rim radius — the two differ by 3%,
        // because the rim is not the lifting edge. Asserted as the gap it is rather than
        // left to look like an error.
        let disk = Double.pi * b.radius * b.radius
        Check.inRange(
            b.area / disk, 0.96, 0.98,
            "planform area is the published reference area, ~3% under π r² (\(b.area) vs \(disk))")

        // A 175 g disc, 27.3 cm across: the sport's own specification.
        Check.inRange(b.mass, 0.170, 0.180, "a match disc weighs 175 g")
        Check.inRange(b.diameter, 0.26, 0.28, "a match disc is 27 cm across")
        Check.ok(b.halfHeight > 0 && b.halfHeight < b.radius, "the disc is thin")
    }

    // MARK: - the blends

    /// The smoothstep, by the four properties that define it.
    ///
    /// It is the unique cubic that is 0 at 0, 1 at 1, and flat at both ends. Asserted
    /// through `stallBlend`, which is the only way this module exposes it.
    private static func smoothstepShape() {
        let c = AeroCoeffs.standard
        // stallBlend(a) = smoothstep((|a| - aStall) / aStallWidth), so x = t maps to
        // alpha = aStall + t * aStallWidth on the positive side.
        func s(_ t: Double) -> Double { c.stallBlend(c.aStall + t * c.aStallWidth) }

        Check.bitEq(s(0), 0, "smoothstep is 0 at the start of the blend")
        Check.bitEq(s(1), 1, "smoothstep is 1 at the end of the blend")
        Check.near(s(0.5), 0.5, 1e-15, "smoothstep is a half at the midpoint")
        Check.bitEq(s(-1), 0, "smoothstep clamps below")
        Check.bitEq(s(2), 1, "smoothstep clamps above")

        // Flat at both ends: the one-sided slope collapses quadratically.
        for h in [1e-2, 1e-3, 1e-4] {
            Check.ok(
                s(h) / h < 3.1 * h, "smoothstep leaves 0 flat (slope \(s(h) / h) at h=\(h))")
            Check.ok(
                (1 - s(1 - h)) / h < 3.1 * h,
                "smoothstep arrives at 1 flat (slope \((1 - s(1 - h)) / h) at h=\(h))")
        }

        // Rotationally symmetric about its midpoint: S(t) + S(1-t) = 1.
        for i in 0...200 {
            let t = Double(i) / 200
            Check.near(s(t) + s(1 - t), 1, 1e-15, "smoothstep is symmetric about its midpoint at \(t)")
            Check.inRange(s(t), 0, 1, "smoothstep is bounded at \(t)")
        }

        // Monotone, so the blend never runs backwards.
        var prev = -1.0
        for i in -50...250 {
            let v = s(Double(i) / 200)
            Check.ok(v >= prev, "smoothstep is monotone at t=\(Double(i) / 200)")
            prev = v
        }
    }

    /// What the two blends are anchored to.
    private static func blendShapes() {
        let c = AeroCoeffs.standard

        // The stall blend depends on the MAGNITUDE of alpha: a disc does not know which
        // way up the flow is separating. An implementation that dropped the `abs` is
        // perfectly smooth and completely wrong on the negative side.
        for i in 0...600 {
            let a = Double(i) / 600 * Double.pi
            Check.bitEq(c.stallBlend(-a), c.stallBlend(a), "stallBlend is even at \(a)")
        }
        Check.bitEq(c.stallBlend(c.aStall), 0, "attached right up to aStall")
        Check.bitEq(c.stallBlend(-c.aStall), 0, "attached right down to -aStall")
        Check.bitEq(c.stallBlend(c.aStall + c.aStallWidth), 1, "fully separated at the far edge")
        Check.bitEq(c.stallBlend(Double.pi / 2), 1, "fully separated face-on")
        Check.ok(c.stallBlend(c.aStall + 1e-9) > 0, "separation starts immediately above aStall")

        // The reversal blend is anchored on the ZERO-LIFT angle, not on zero. That is what
        // makes it "the flow has crossed to the other face", and it is the edge that
        // carries CL0 and CLa into the drag curve.
        Check.bitEq(c.zeroLiftAlpha, -c.CL0 / c.CLa, "zeroLiftAlpha is the root of the attached line")
        Check.ok(c.zeroLiftAlpha < 0, "the zero-lift angle is slightly nose-down")
        Check.bitEq(c.reverseBlend(c.zeroLiftAlpha), 0, "no reversal at the zero-lift angle")
        Check.bitEq(
            c.reverseBlend(c.zeroLiftAlpha - c.revWidth), 1,
            "fully reversed revWidth below the zero-lift angle")
        Check.bitEq(c.reverseBlend(0), 0, "no reversal at zero alpha")
        Check.bitEq(c.reverseBlend(Double.pi / 2), 0, "no reversal face-on nose-up")
        Check.bitEq(c.reverseBlend(-Double.pi / 2), 1, "fully reversed face-on nose-down")

        // Monotone the other way round from the stall blend: more negative is more reversed.
        var prev = 2.0
        for i in -400...400 {
            let a = Double(i) / 400 * Double.pi
            let v = c.reverseBlend(a)
            Check.ok(v <= prev, "reverseBlend falls with rising alpha at \(a)")
            Check.inRange(v, 0, 1, "reverseBlend is bounded at \(a)")
            prev = v
        }
    }

    // MARK: - Model

    /// The alpha samples every curve comparison runs over: a dense uniform sweep plus the
    /// piecewise boundaries, where a clamp applied one step late shows up and a uniform
    /// sweep does not.
    static func alphas(_ c: AeroCoeffs) -> [Double] {
        let z = c.zeroLiftAlpha
        var out: [Double] = []
        for i in 0...720 { out.append(-Double.pi + Double(i) / 720 * 2 * Double.pi) }
        for edge in [
            0, z, c.aStall, c.aStall + c.aStallWidth, -c.aStall,
            -(c.aStall + c.aStallWidth), z - c.revWidth, z - c.revWidth / 2,
            c.aStall + c.aStallWidth / 2, -c.CM0 / c.CMa, c.alpha0,
            Double.pi / 4, Double.pi / 2, Double.pi, -Double.pi / 2, -Double.pi,
        ] {
            // Both sides of every boundary: a `<=` written as `<` only shows on one.
            out.append(contentsOf: [edge, edge - 1e-9, edge + 1e-9])
        }
        return out
    }

    /// The five curves against `Model`, over thirteen coefficient sets.
    ///
    /// The perturbations are not small: each moves one constant far enough that a curve
    /// reading the wrong one produces a visibly different number. A formula that only
    /// agrees with its specification at the shipped values is not agreeing with the
    /// specification.
    private static func modelAgreement() {
        var sets: [(String, AeroCoeffs)] = [("standard", .standard)]
        for (key, value) in [
            ("CL0", 0.42), ("CLa", 3.1), ("CD0", 0.19), ("CDa", 1.3), ("alpha0", 0.11),
            ("CM0", 0.021), ("CMa", -0.4), ("CMalphaSat", 0.31), ("aStall", 0.62),
            ("aStallWidth", 0.17), ("CLplate", 1.7), ("CDplate", 0.6), ("revWidth", 0.51),
            ("revLift", -0.4), ("revDrag", 0.35),
        ] {
            sets.append(("\(key)=\(value)", perturbed([key: value])))
        }
        Check.eq(sets.count, 16, "the model sweep covers the shipped set and one move per curve constant")

        for (label, c) in sets {
            for a in alphas(c) {
                // **A STATED EXCEPTION: the two spellings of the cubic are not bit-equal.**
                // `x²(3 − 2x)` and `1 − (1−x)²(1+2x)` are the same polynomial and round
                // differently — measured, up to three ulps apart in the middle of the blend.
                // Neither is more correct; there is no third, exact answer to prefer. So the
                // blends are compared at a tolerance like everything else, and the *choice*
                // of spelling is pinned by `smoothstepShape` below, which asserts the four
                // properties that make the cubic unique rather than the arithmetic.
                Check.near(c.stallBlend(a), Model.stall(c, a), 1e-15, "\(label) stallBlend(\(a))")
                Check.near(c.reverseBlend(a), Model.reverse(c, a), 1e-15, "\(label) reverseBlend(\(a))")
                Check.bitEq(c.zeroLiftAlpha, Model.zeroLift(c), "\(label) zeroLiftAlpha")

                Check.near(c.liftCoeff(a), Model.lift(c, a), curveTol, "\(label) lift(\(a))")
                Check.near(c.dragCoeff(a), Model.drag(c, a), curveTol, "\(label) drag(\(a))")
                Check.near(c.pitchCoeff(a), Model.pitch(c, a), curveTol, "\(label) pitch(\(a))")
            }
        }
    }

    // MARK: - the laws

    /// Where the flow is attached and not reversed, the coefficients are a line and a
    /// parabola. This is the window in which both blends are exactly zero.
    static func attachedWindow(_ c: AeroCoeffs) -> (lo: Double, hi: Double) {
        (c.zeroLiftAlpha, c.aStall)
    }

    /// Attached lift is a straight line, and two points on it recover the line.
    ///
    /// This is the assertion that pins `CL0` and `CLa` *through the curve* rather than
    /// through the table — a `liftCoeff` that read `CD0` where it means `CL0` would still
    /// hold the table's own values.
    private static func attachedLine() {
        for (label, c) in coefficientSets() {
            let w = attachedWindow(c)
            guard w.hi - w.lo > 0.05 else { continue }
            let a1 = w.lo + (w.hi - w.lo) * 0.25
            let a2 = w.lo + (w.hi - w.lo) * 0.75
            let y1 = c.liftCoeff(a1)
            let y2 = c.liftCoeff(a2)
            let slope = (y2 - y1) / (a2 - a1)
            let intercept = y1 - slope * a1
            Check.near(slope, c.CLa, extractTol, "\(label): attached lift slope is CLa")
            Check.near(intercept, c.CL0, extractTol, "\(label): attached lift at zero alpha is CL0")

            // And every other point in the window lies on that same line, so it is a line
            // and not two points of something else.
            for i in 0...200 {
                let a = w.lo + (w.hi - w.lo) * Double(i) / 200
                Check.near(
                    c.liftCoeff(a), c.CL0 + c.CLa * a, curveTol,
                    "\(label): attached lift is linear at \(a)")
            }

            // The root of that line is the zero-lift angle, which is the definition.
            Check.near(c.liftCoeff(c.zeroLiftAlpha), 0, 1e-15, "\(label): no lift at zeroLiftAlpha")
            Check.ok(
                c.liftCoeff(c.zeroLiftAlpha + 1e-6) > 0,
                "\(label): lift turns positive above the zero-lift angle")
        }
    }

    /// Attached drag is a parabola, and three points recover its vertex, floor and
    /// curvature — which must be `alpha0`, `CD0` and `CDa`.
    private static func attachedParabola() {
        for (label, c) in coefficientSets() {
            let w = attachedWindow(c)
            guard w.hi - w.lo > 0.05 else { continue }
            let h = (w.hi - w.lo) / 4
            let mid = (w.hi + w.lo) / 2
            let yl = c.dragCoeff(mid - h)
            let ym = c.dragCoeff(mid)
            let yr = c.dragCoeff(mid + h)

            // A parabola y = A(x-p)² + q through three evenly spaced points.
            let curvature = (yl - 2 * ym + yr) / (2 * h * h)
            let slopeAtMid = (yr - yl) / (2 * h)
            let vertex = mid - slopeAtMid / (2 * curvature)
            let floor = ym - curvature * (mid - vertex) * (mid - vertex)

            Check.near(curvature, c.CDa, extractTol, "\(label): attached drag curvature is CDa")
            Check.near(vertex, c.alpha0, extractTol, "\(label): attached drag is least at alpha0")
            Check.near(floor, c.CD0, extractTol, "\(label): least attached drag is CD0")

            for i in 0...200 {
                let a = w.lo + (w.hi - w.lo) * Double(i) / 200
                let d = a - c.alpha0
                Check.near(
                    c.dragCoeff(a), c.CD0 + c.CDa * d * d, curveTol,
                    "\(label): attached drag is quadratic at \(a)")
            }
        }
    }

    /// Fully separated, the disc is a flat plate.
    ///
    /// `CL = CLplate·sin(2α)` and `CD = CD0 + CDplate·sin²(α)`, exactly — the stall blend
    /// is saturated at 1 here, so there is no attached term left to mix in. Dividing the
    /// measured curve by its own shape returns the two plate constants, which is what
    /// catches `CDplate` being confused with a total `CD` or the two plate constants being
    /// swapped.
    private static func flatPlate() {
        for (label, c) in coefficientSets() {
            let start = c.aStall + c.aStallWidth
            guard start < Double.pi / 2 - 0.05 else { continue }
            for i in 0...100 {
                let a = start + (Double.pi / 2 - start) * Double(i) / 100
                let sa = Foundation.sin(a)
                Check.near(
                    c.liftCoeff(a), c.CLplate * Foundation.sin(2 * a), curveTol,
                    "\(label): separated lift is CLplate·sin(2a) at \(a)")
                Check.near(
                    c.dragCoeff(a), c.CD0 + c.CDplate * sa * sa, curveTol,
                    "\(label): separated drag is CD0 + CDplate·sin²(a) at \(a)")
                if a > start + 0.1 && a < Double.pi / 2 - 0.1 {
                    Check.near(
                        c.liftCoeff(a) / Foundation.sin(2 * a), c.CLplate, extractTol,
                        "\(label): CLplate recovered from the separated lift at \(a)")
                    Check.near(
                        (c.dragCoeff(a) - c.CD0) / (sa * sa), c.CDplate, extractTol,
                        "\(label): CDplate recovered from the separated drag at \(a)")
                }
            }
        }

        let c = AeroCoeffs.standard
        // Face-on the plate is edge-symmetric: no lift, and the drag of a flat circular
        // plate. 1.18 is the measured number for a disc-shaped plate normal to the flow,
        // and it is the single assertion that separates CDplate from a total CD.
        // `sin(2 · π/2)` is `sin(π)`, which libm returns as 1.2e-16 rather than as zero,
        // so this is exact to the limit the argument reduction allows and not further.
        Check.near(c.liftCoeff(Double.pi / 2), 0, 1e-15, "no lift face-on")
        Check.near(c.dragCoeff(Double.pi / 2), 1.18, 1e-15, "CD face-on is the flat-plate 1.18")
        Check.near(c.dragCoeff(-Double.pi / 2), 1.18 * c.revDrag, 1e-14, "face-on backwards costs revDrag")
    }

    /// Fully reversed, the two reversal numbers are pure multipliers on the curves the
    /// disc would otherwise have had.
    ///
    /// This is the window where the flow is reversed AND still attached, which is the only
    /// place the multipliers stand alone: `alpha` from `−aStall` up to `zeroLiftAlpha −
    /// revWidth`.
    private static func reversal() {
        for (label, c) in coefficientSets() {
            let hi = c.zeroLiftAlpha - c.revWidth
            let lo = -c.aStall
            guard hi - lo > 0.02 else { continue }
            for i in 0...100 {
                let a = lo + (hi - lo) * Double(i) / 100
                let attachedLift = c.CL0 + c.CLa * a
                let d = a - c.alpha0
                let attachedDrag = c.CD0 + c.CDa * d * d
                Check.near(
                    c.liftCoeff(a), attachedLift * c.revLift, curveTol,
                    "\(label): fully reversed lift is revLift × the attached line at \(a)")
                Check.near(
                    c.dragCoeff(a), attachedDrag * c.revDrag, curveTol,
                    "\(label): fully reversed drag is revDrag × the attached parabola at \(a)")
                if abs(attachedLift) > 1e-3 {
                    Check.near(
                        c.liftCoeff(a) / attachedLift, c.revLift, extractTol,
                        "\(label): revLift recovered at \(a)")
                }
                Check.near(
                    c.dragCoeff(a) / attachedDrag, c.revDrag, extractTol,
                    "\(label): revDrag recovered at \(a)")
            }
        }

        // What the reversal is FOR: an upside-down disc falls instead of gliding. Stated in
        // the units the header uses.
        let c = AeroCoeffs.standard
        let z = c.zeroLiftAlpha
        Check.ok(
            c.dragCoeff(z - c.revWidth) > c.dragCoeff(z + c.revWidth),
            "dome-first costs more drag than cavity-first")
        Check.ok(
            abs(c.liftCoeff(z - 0.3)) < abs(c.liftCoeff(z + 0.3)),
            "dome-first makes less lift than the mirrored normal angle")
    }

    /// The pitching moment, by what the `tanh` is there to do.
    private static func pitchSaturation() {
        for (label, c) in coefficientSets() {
            // Odd about CM0: the saturation is a symmetric function of alpha, so the curve
            // is CM0 plus something antisymmetric. This is a structural statement that
            // does not depend on `tanh` at all.
            for i in 0...300 {
                let a = Double(i) / 300 * Double.pi
                Check.near(
                    c.pitchCoeff(a) + c.pitchCoeff(-a), 2 * c.CM0, 1e-15,
                    "\(label): the pitching moment is odd about CM0 at \(a)")
            }
            Check.bitEq(c.pitchCoeff(0), c.CM0, "\(label): the pitching moment at zero alpha is CM0")

            // Near zero the saturation is transparent: sat·tanh(a/sat) → a, so the slope is
            // CMa. That is what makes CMalphaSat a *saturation half-width* and not a gain.
            let h = 1e-6
            let slope = (c.pitchCoeff(h) - c.pitchCoeff(-h)) / (2 * h)
            Check.near(slope, c.CMa, 1e-9, "\(label): the pitching moment starts with slope CMa")

            // Far out it saturates at CM0 ± CMa·sat, which is the runaway the tanh prevents.
            let reach = abs(c.CMa * c.CMalphaSat)
            let bound = abs(c.CM0) + reach
            for i in 0...300 {
                let a = -Double.pi + Double(i) / 300 * 2 * Double.pi
                Check.ok(
                    abs(c.pitchCoeff(a)) <= bound,
                    "\(label): the pitching moment is bounded at \(a)")
            }
            Check.near(
                c.pitchCoeff(40 * c.CMalphaSat), c.CM0 + c.CMa * c.CMalphaSat, 1e-15,
                "\(label): the pitching moment saturates at CM0 + CMa·CMalphaSat")
            Check.near(
                c.pitchCoeff(-40 * c.CMalphaSat), c.CM0 - c.CMa * c.CMalphaSat, 1e-15,
                "\(label): and at CM0 − CMa·CMalphaSat going the other way")

            // The half-width is where the saturation has spent tanh(1) of its reach — the
            // definition of the parameter, read off the curve.
            Check.near(
                c.pitchCoeff(c.CMalphaSat) - c.CM0, c.CMa * c.CMalphaSat * Foundation.tanh(1),
                curveTol, "\(label): CMalphaSat is the half-width of the saturation")
        }

        // The sign convention, which is easy to invert without anything looking wrong:
        // nose-down at the low alpha of a fast throw, nose-up once the disc is mushing.
        // Precessed 90° by the spin, this is the high-speed turn and the low-speed fade.
        let c = AeroCoeffs.standard
        Check.ok(c.pitchCoeff(0) < 0, "nose-down at zero alpha")
        Check.ok(c.pitchCoeff(0.5) > 0, "nose-up at the high alpha of a slow disc")
        Check.near(
            c.pitchCoeff(-c.CM0 / c.CMa), 0, 3e-4,
            "the trim angle is near -CM0/CMa, where the saturation is still transparent")
    }

    /// Properties that hold across the whole domain, whatever the coefficients say.
    private static func globalProperties() {
        let c = AeroCoeffs.standard

        // Drag is strictly positive everywhere, or the disc gains energy from the air.
        var minDrag = Double.infinity
        var minAt = 0.0
        for i in 0...6283 {
            let a = -Double.pi + Double(i) / 6283 * 2 * Double.pi
            let d = c.dragCoeff(a)
            Check.ok(d > 0, "drag is positive at \(a)")
            // **THE ARGMIN CLAIM IS RESTRICTED TO THE REACHABLE DOMAIN, AND THAT IS A REAL
            // FACT ABOUT THIS MODEL.** `Coeffs.swift` says the curves are valid on [−π, π],
            // but `alpha` is `atan2(-v·n, |v in plane|)` and an in-plane speed is never
            // negative, so no flight can produce an angle outside [−π/2, π/2]. Past π/2 the
            // flat-plate terms turn back round — `sin²(π)` is zero — and the model reports
            // the *least* drag it has anywhere at α = ±π, which is nonsense the simulation
            // never sees. `ThrowsTests` asserts the reachable range from the flight side.
            if abs(a) <= Double.pi / 2, d < minDrag {
                minDrag = d
                minAt = a
            }
        }
        // Inside that window the floor is the attached floor, at alpha0 — nothing in the
        // stall or reversal branches dips under it.
        Check.near(minDrag, c.CD0, 1e-4, "the least reachable drag is CD0 (\(minDrag))")
        Check.near(minAt, c.alpha0, 1e-3, "and it is at alpha0 (\(minAt))")
        Check.near(
            c.dragCoeff(Double.pi), c.CD0, 1e-15,
            "the model wraps at ±π back to CD0 — outside the reachable domain, stated not hidden")

        // Continuity. Both blends are smooth and the branch guards are on the blend, so no
        // sample may jump: over a 1e-4 step nothing may move more than a Lipschitz step.
        var prevL = c.liftCoeff(-Double.pi)
        var prevD = c.dragCoeff(-Double.pi)
        var prevM = c.pitchCoeff(-Double.pi)
        for i in 1...62832 {
            let a = -Double.pi + Double(i) / 10000
            let l = c.liftCoeff(a)
            let d = c.dragCoeff(a)
            let m = c.pitchCoeff(a)
            if abs(l - prevL) > 1e-3 || abs(d - prevD) > 1e-3 || abs(m - prevM) > 1e-3 {
                Check.ok(false, "the coefficient curves are continuous at \(a)")
            }
            prevL = l
            prevD = d
            prevM = m
        }
        Check.ok(true, "the coefficient curves are continuous across the whole domain")

        // A BLEND STAYS BETWEEN WHAT IT BLENDS. Above the zero-lift angle the reversal is
        // inactive, so the published curve *is* the stall mix, and a mix with a weight
        // outside [0,1] — a smoothstep that never clamps, a blend applied with the wrong
        // sign — leaves the interval between its two branches. Nothing else in this file
        // catches that: both branches would still be right.
        let z = c.zeroLiftAlpha
        for i in 0...6283 {
            let a = -Double.pi + Double(i) / 6283 * 2 * Double.pi
            guard a >= z else { continue }
            let sa = Foundation.sin(a)
            let d = a - c.alpha0
            let liftBranches = [c.CL0 + c.CLa * a, c.CLplate * Foundation.sin(2 * a)]
            let dragBranches = [c.CD0 + c.CDa * d * d, c.CD0 + c.CDplate * sa * sa]
            Check.inRange(
                c.liftCoeff(a), liftBranches.min()! - 1e-12, liftBranches.max()! + 1e-12,
                "lift stays between its attached and flat-plate branches at \(a)")
            Check.inRange(
                c.dragCoeff(a), dragBranches.min()! - 1e-12, dragBranches.max()! + 1e-12,
                "drag stays between its attached and flat-plate branches at \(a)")
        }
    }

    // MARK: - dependency structure

    /// Which coefficients each curve reads.
    ///
    /// This is the check that catches a curve reading a plausible but wrong constant. Every
    /// coefficient is moved in turn and every curve is watched: it must move if and only if
    /// it declared that input.
    ///
    /// The one entry worth reading twice is `CL0`/`CLa` on the *drag* curve. They are lift
    /// constants and they reach drag anyway, because `zeroLiftAlpha` is where the reversal
    /// blend is anchored — so retuning the lift line moves the drag of an inverted disc.
    /// Real, load-bearing, and invisible in the source of `dragCoeff`.
    static let reads: [String: Set<String>] = [
        "stallBlend": ["aStall", "aStallWidth"],
        "reverseBlend": ["CL0", "CLa", "revWidth"],
        "lift": ["CL0", "CLa", "aStall", "aStallWidth", "CLplate", "revWidth", "revLift"],
        "drag": [
            "CL0", "CLa", "CD0", "CDa", "alpha0", "aStall", "aStallWidth", "CDplate",
            "revWidth", "revDrag",
        ],
        "pitch": ["CM0", "CMa", "CMalphaSat"],
    ]

    private static func dependencyStructure() {
        // Probe angles chosen to sit one in each regime: attached, mid-stall, fully
        // separated, mid-reversal, fully reversed, and face-on both ways.
        let probes = [0.0, 0.2, 0.45, 0.6, 0.9, 1.4, -0.05, -0.15, -0.35, -0.8, -1.4, 2.6, -2.6]
        let base = AeroCoeffs.standard

        func curves(_ c: AeroCoeffs, _ a: Double) -> [String: Double] {
            [
                "stallBlend": c.stallBlend(a), "reverseBlend": c.reverseBlend(a),
                "lift": c.liftCoeff(a), "drag": c.dragCoeff(a), "pitch": c.pitchCoeff(a),
            ]
        }

        for field in aeroFields {
            // A large, deliberate move: the question is "does this input reach that curve
            // at all", and a small step invites a false negative from rounding.
            let moved = perturbed([field.name: field.value + 0.37 + abs(field.value) * 0.5])
            var everMoved: Set<String> = []
            for a in probes {
                let before = curves(base, a)
                let after = curves(moved, a)
                for (name, value) in before where after[name]! != value {
                    everMoved.insert(name)
                }
            }
            for (name, inputs) in reads.sorted(by: { $0.key < $1.key }) {
                let declared = inputs.contains(field.name)
                Check.eq(
                    everMoved.contains(name), declared,
                    "\(name) \(declared ? "reads" : "does not read") \(field.name)")
            }
        }

        // And the four that no curve here reads at all — they belong to the flight
        // derivative, and a curve that started reading one would be reading the wrong axis.
        for name in ["rho", "g", "CMq", "CRr", "CRp", "CNr"] {
            for (curve, inputs) in reads {
                Check.ok(
                    !inputs.contains(name),
                    "\(curve) does not read \(name) — it belongs to the flight derivative")
            }
        }
    }

    /// The shipped set plus a handful of retunes, for the laws that must hold at any
    /// coefficients rather than only at these ones.
    private static func coefficientSets() -> [(String, AeroCoeffs)] {
        [
            ("standard", .standard),
            ("stiff-lift", perturbed(["CL0": 0.31, "CLa": 3.4])),
            ("draggy", perturbed(["CD0": 0.14, "CDa": 4.1, "alpha0": 0.03])),
            ("late-stall", perturbed(["aStall": 0.55, "aStallWidth": 0.2])),
            ("plate", perturbed(["CLplate": 1.6, "CDplate": 0.9])),
            ("reversal", perturbed(["revWidth": 0.4, "revLift": -0.2, "revDrag": 3.1])),
            ("moment", perturbed(["CM0": 0.006, "CMa": -0.22, "CMalphaSat": 0.45])),
        ]
    }
}
