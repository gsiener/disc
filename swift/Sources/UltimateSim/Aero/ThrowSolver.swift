import Foundation

/// The AI's release solver — a port of `src/sim/aero/ThrowSolver.ts`.
///
/// Read that file's header for the two measurements this design rests on. In short:
///
/// **Range is not monotonic in launch elevation.** A 20.5 m/s backhand peaks near
/// -0.02 rad and falls away on both sides, so almost every reachable distance has a
/// flat root and a lofted one. The plain bisection that stood here walked past the
/// peak onto the lofted root every time — six times the lateral curve, and long
/// enough in the air for a defender to get there. The scan below stops at the first
/// crossing on the way up, which is the flat root; only a genuinely unreachable ask
/// falls through to the peak.
///
/// **Bank is the axis that holds a line; heading is not.** With no bank the only
/// correction available was to rotate the aim off the receiver and hope the curve
/// came back, which is what put a third of the AI's hucks out of bounds. Bank is
/// solved for by a secant on the probe's own lateral error, so its sign is read off
/// the flight rather than tabulated — which is what makes it right for either hand,
/// either spin direction, and either side of the turnover speed at once.
public enum ThrowSolver {
    /// Launch-elevation bracket, rad — the range of a human wrist.
    public static let elevLo = -0.34
    public static let elevHi = 0.62
    /// Coarse steps across the bracket, used to find the flat root's cell.
    public static let elevScan = 12
    /// Halvings inside the bracketed cell.
    public static let elevHalvings = 5
    /// Elevation solves, each of which may be followed by a bank correction.
    public static let passes = 3
    /// Lateral error the solver stops caring about, m.
    public static let latTolerance = 0.25
    /// Finite-difference step for the bank secant, rad.
    public static let bankProbe = 0.05
    /// Most bank one secant step may ask for, rad.
    public static let bankStep = 0.30
    /// Bank ceiling, rad.
    public static let bankMax = 0.35
    /// How far short the flight may fall before the solver reaches for more arm, m.
    public static let reachTolerance = 0.5
    /// How many times one solve may lift the power. See `solve`.
    public static let powerLifts = 2
    /// Clamp on the residual heading trim, rad.
    public static let headingTrim = 0.15

    public struct Solution: Equatable, Sendable {
        /// Launch elevation above the throw's own spec elevation, rad.
        public var angle: Double
        /// Bank about the flight axis at release, rad.
        public var bank: Double
        /// Aim heading, rad, as atan2(x, z).
        public var heading: Double
    }

    /// Solve the launch elevation that carries `want` metres, preferring the flat root.
    ///
    /// Leaves the solved angle and the probing aim on `req`, as the reference does.
    private static func solveElevation(
        _ probe: DiscRuntime, _ req: inout ThrowRequest,
        heading: Double, want: Double, catchY: Double
    ) -> (angle: Double, lat: Double, reach: Double) {
        req.aim = Vec3d(sin(heading), 0, cos(heading))
        let step = (elevHi - elevLo) / Double(elevScan)

        var prevA = elevLo
        var prevD = -Double.infinity
        var peakA = elevLo
        var peakD = -Double.infinity
        var peakLat = 0.0
        var loA = Double.nan
        var hiA = Double.nan

        for i in 0...elevScan {
            let a = elevLo + step * Double(i)
            req.angle = a
            let r = probe.probeThrow(req, catchY: catchY, maxT: 6)
            if r.dist > peakD {
                peakD = r.dist
                peakA = a
                peakLat = r.lat
            }
            if i > 0, r.dist >= want, prevD < want {
                loA = prevA
                hiA = a
                break
            }
            prevA = a
            prevD = r.dist
        }

        // Out of range: throw it as far as it goes. The AI's range model is more
        // optimistic than the flight model above about a third of `maxThrowRange`,
        // so this branch is taken on purpose and often.
        if loA.isNaN {
            req.angle = peakA
            return (peakA, peakLat, peakD)
        }

        var bestA = loA
        var bestErr = Double.infinity
        var bestLat = 0.0
        for _ in 0..<elevHalvings {
            let mid = (loA + hiA) * 0.5
            req.angle = mid
            let r = probe.probeThrow(req, catchY: catchY, maxT: 6)
            let err = r.dist - want
            if abs(err) < abs(bestErr) {
                bestErr = err
                bestA = mid
                bestLat = r.lat
            }
            if err < 0 { loA = mid } else { hiA = mid }
        }
        req.angle = bestA
        return (bestA, bestLat, peakD)
    }

    /// Solve power, elevation, bank and heading for a throw of `want` m along `heading0`.
    ///
    /// `req` carries the type, origin, power, spin and hand on the way in, and the
    /// solved angle, bank and aim on the way out.
    @discardableResult
    public static func solve(
        _ probe: DiscRuntime, _ req: inout ThrowRequest,
        heading0: Double, want: Double, catchY: Double
    ) -> Solution {
        var bank = 0.0
        var angle = 0.02
        var lat = 0.0
        var lifts = 0

        var pass = 0
        while pass < passes {
            req.bank = bank
            let e = solveElevation(probe, &req, heading: heading0, want: want, catchY: catchY)
            angle = e.angle
            lat = e.lat

            // THROW HARDER RATHER THAN SHORTER. The release speed the AI asks for comes
            // from `throwFlightTime`, and above about a third of `maxThrowRange` that model
            // and the flight model disagree — a 42 m huck asked for at 22.7 m/s that no
            // launch angle carries past about 34 m. Carry goes roughly as speed squared, so
            // the lift is `sqrt(want / reach)` on power, capped at full. See the reference
            // header for the measurement.
            if e.reach < want - reachTolerance, req.power < 1, lifts < powerLifts {
                lifts += 1
                req.power = clamp(req.power * (want / max(1, e.reach)).squareRoot(), req.power, 1)
                continue
            }

            if abs(lat) <= latTolerance || pass == passes - 1 { break }

            // Secant on bank: one extra probe buys the local dLat/dBank.
            req.bank = bank + bankProbe
            req.angle = angle
            req.aim = Vec3d(sin(heading0), 0, cos(heading0))
            let r2 = probe.probeThrow(req, catchY: catchY, maxT: 6)
            let slope = (r2.lat - lat) / bankProbe
            req.bank = bank
            if abs(slope) < 1e-3 { break }

            bank = clamp(bank + clamp(-lat / slope, -bankStep, bankStep), -bankMax, bankMax)
            pass += 1
        }

        var heading = heading0
        if abs(lat) > latTolerance, want > 1 {
            heading -= clamp(atan2(lat, want), -headingTrim, headingTrim)
        }

        req.bank = bank
        req.angle = angle
        req.aim = Vec3d(sin(heading), 0, cos(heading))
        return Solution(angle: angle, bank: bank, heading: heading)
    }
}
