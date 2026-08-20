import Foundation

/// Aerodynamic and inertial constants for a 175 g Ultimate disc, and the
/// coefficient curves that drive `DiscPhysics`. Ported from `src/sim/aero/Coeffs.ts`.
///
/// Conventions, carried over unchanged because everything downstream assumes them:
///
///   BODY FRAME   body +Z is the disc normal (the spin axis, "up" out of the top
///                plate). body +X / +Y lie in the disc plane. The disc is
///                axisymmetric, so the phase of +X about +Z is physically
///                irrelevant; only the normal matters.
///
///   AERO FRAME   built fresh each step from the relative wind:
///                  xa = unit(v_rel projected into the disc plane)   "flight axis"
///                  ya = xa × n                                      "pitch axis"
///                  n  = disc normal
///                A positive pitching-moment coefficient CM is NOSE UP. A positive
///                rolling-moment coefficient CR is a right-hand torque about xa.
///
///   ALPHA        angle of attack — the angle between the relative wind and the disc
///                plane, positive when the air hits the underside (nose up).
///                alpha = atan2(-v_rel·n, |v_rel in plane|).
///
/// Magnitudes follow published wind-tunnel fits for a 175 g disc (Hummel; Potts &
/// Crowther), plus two things the published fits do not cover but a game needs: a
/// smooth post-stall blend to flat-plate behaviour, and a reversed-flow penalty for
/// flying dome-first.
///
/// **The tuning rationale lives in the TypeScript reference and is not repeated
/// here.** Three coefficients (`CLa`, `CM0`, `CRr`) were calibrated against flight
/// behaviour rather than taken at face value, and the arithmetic justifying each is
/// in the header of `src/sim/aero/Coeffs.ts`. Do not "correct" them toward the
/// published values without reading it.

/// Mass and inertia of the disc itself.
public struct DiscBody: Equatable, Decodable, Sendable {
    /// kg
    public let mass: Double
    /// m
    public let diameter: Double
    /// m
    public let radius: Double
    /// m², planform
    public let area: Double
    /// kg m², transverse (Ixx = Iyy)
    public let Ixx: Double
    /// kg m², about the spin axis
    public let Izz: Double
    /// m, half-thickness used for the ground contact plane
    public let halfHeight: Double

    public static let standard = DiscBody(
        mass: 0.175,
        diameter: 0.273,
        radius: 0.1365,
        area: 0.0568,
        Ixx: 5.05e-4,
        Izz: 1.01e-3,
        halfHeight: 0.013
    )
}

public struct AeroCoeffs: Equatable, Decodable, Sendable {
    /// kg/m³
    public let rho: Double
    /// m/s², magnitude
    public let g: Double

    // lift: CL = CL0 + CLa * alpha (pre-stall)
    public let CL0: Double
    public let CLa: Double

    // drag: CD = CD0 + CDa * (alpha - alpha0)² (pre-stall)
    public let CD0: Double
    public let CDa: Double
    public let alpha0: Double

    // pitching moment: CM = CM0 + CMa * alpha + CMq * qhat
    public let CM0: Double
    public let CMa: Double
    /// pitch-rate damping, negative
    public let CMq: Double
    /// saturation half-width applied to alpha inside CM, rad
    public let CMalphaSat: Double

    /// rolling moment: CR = CRr * rhat + CRp * phat.
    ///
    /// `CRr < 0` encodes the advancing/retreating blade asymmetry in this frame: the
    /// blade advancing into the wind makes more lift, which for a right-hand-backhand
    /// disc (spin along −n) is a +xa torque.
    public let CRr: Double
    /// roll-rate damping, negative
    public let CRp: Double

    /// spin-axis moment: CN = CNr * rhat (skin friction, negative)
    public let CNr: Double

    /// |alpha| at which separation starts, rad
    public let aStall: Double
    /// blend width in |alpha|, rad
    public let aStallWidth: Double
    /// fully separated lift peak, CL = CLplate * sin(2a)
    public let CLplate: Double
    /// fully separated drag, CD = CD0 + CDplate * sin(a)². 1.10 gives CD ≈ 1.18
    /// face-on, which is a flat circular plate.
    public let CDplate: Double

    /// How far below the zero-lift alpha the reversal is complete, rad.
    ///
    /// A disc is not symmetric: the domed top is cambered and the bottom is an open
    /// cavity with a sharp rim. Below the zero-lift angle the air arrives dome-first
    /// into the cavity's wake, the flow separates off the rim immediately, and the
    /// disc loses most of its lift while its drag jumps. This is why an upside-down
    /// disc falls out of the sky instead of gliding, and what makes a hammer drop off
    /// the back end.
    public let revWidth: Double
    /// Lift multiplier in fully reversed flow.
    public let revLift: Double
    /// Drag multiplier in fully reversed flow.
    public let revDrag: Double

    public static let standard = AeroCoeffs(
        rho: 1.225,
        g: 9.81,

        CL0: 0.15,
        CLa: 2.0,

        CD0: 0.08,
        CDa: 2.6,
        alpha0: -0.07,

        CM0: -0.0035,
        CMa: 0.15,
        CMq: -0.012,
        CMalphaSat: 0.7,

        CRr: -0.0030,
        CRp: -0.0055,

        CNr: -0.0045,

        aStall: 0.40,
        aStallWidth: 0.35,
        CLplate: 1.0,
        CDplate: 1.10,

        revWidth: 0.22,
        revLift: 0.15,
        revDrag: 2.2
    )
}

// MARK: - curves

/// Hermite smoothstep clamped to [0,1].
///
/// Written as `x * x * (3 - 2 * x)` to match the reference exactly. The algebraically
/// equal `3x² − 2x³` rounds differently, and these curves are asserted bit-for-bit.
@inline(__always)
func smoothstep01(_ x: Double) -> Double {
    if x <= 0 { return 0 }
    if x >= 1 { return 1 }
    return x * x * (3 - 2 * x)
}

extension AeroCoeffs {

    /// 0 = fully attached, 1 = fully separated.
    public func stallBlend(_ alpha: Double) -> Double {
        smoothstep01((abs(alpha) - aStall) / aStallWidth)
    }

    /// Angle of attack at which the disc makes no lift, rad. Slightly negative.
    public var zeroLiftAlpha: Double {
        -CL0 / CLa
    }

    /// 0 = normal (cavity into the wind), 1 = fully reversed (dome into the wind).
    public func reverseBlend(_ alpha: Double) -> Double {
        smoothstep01((zeroLiftAlpha - alpha) / revWidth)
    }

    /// Lift coefficient, valid for any alpha in [−π, π].
    public func liftCoeff(_ alpha: Double) -> Double {
        let s = stallBlend(alpha)
        let attached = CL0 + CLa * alpha
        var cl = attached
        // The `s > 0` guard is kept from the reference rather than folded into the
        // blend. It is not an optimisation: it keeps the attached branch free of a
        // multiply by zero, which is how a signed zero would otherwise appear here.
        if s > 0 { cl = attached * (1 - s) + CLplate * simSin(2 * alpha) * s }
        let r = reverseBlend(alpha)
        return r > 0 ? cl * (1 - r * (1 - revLift)) : cl
    }

    /// Drag coefficient, valid for any alpha in [−π, π]. Always > 0.
    public func dragCoeff(_ alpha: Double) -> Double {
        let s = stallBlend(alpha)
        let d = alpha - alpha0
        let attached = CD0 + CDa * d * d
        var cd = attached
        if s > 0 {
            let sa = simSin(alpha)
            cd = attached * (1 - s) + (CD0 + CDplate * sa * sa) * s
        }
        let r = reverseBlend(alpha)
        return r > 0 ? cd * (1 + r * (revDrag - 1)) : cd
    }

    /// Static pitching-moment coefficient, with no rate damping. The alpha term is
    /// softly saturated so a tumbling disc cannot produce runaway moments.
    ///
    /// Note the sign change: `CM0 < 0` with `CMa > 0` means the moment is nose-DOWN
    /// at the low alpha of a fast throw and nose-UP once the disc has slowed and is
    /// mushing along at high alpha. Precessed 90° by the spin, that is exactly the
    /// "high-speed turn, low-speed fade" of a real disc.
    public func pitchCoeff(_ alpha: Double) -> Double {
        let sat = CMalphaSat
        return CM0 + CMa * sat * tanh(alpha / sat)
    }
}
