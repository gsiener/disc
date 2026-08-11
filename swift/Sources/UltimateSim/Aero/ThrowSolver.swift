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
///
/// **Elevation alone cannot make a short throw.** The rising-crossing scan records
/// nothing when the flattest legal launch already carries further than the ask, and
/// control then fell through to "throw it as far as it goes" — a 1 m dump released as a
/// 19.6 m bomb, 42% of asks under 6 m overshooting by more than three metres. Nor is it
/// only the bracketing: at the 0.12 power floor a backhand leaves at 13.8 m/s and carries
/// 4.8 m at its worst angle, so no elevation makes the throw. The human path solved this
/// years ago with an absolute release speed from `MIN_THROW_SPEED`; the solver now solves
/// for that speed as well.
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
    /// Slowest release the solver will ask an arm for, m/s, and how many times one solve
    /// may reach for it. See the THROW SOFTER note in `solve`.
    ///
    /// The same 9 m/s as `MIN_THROW_SPEED` in `HumanRelease.swift`, for the same reason:
    /// every throw spec's own speed floor is a twenty metre throw, so a solver that can
    /// only move inside the spec's band cannot make a dump at all.
    public static let speedMin = 9.0
    public static let speedDrops = 2
    /// Clamp on the residual heading trim, rad.
    public static let headingTrim = 0.15
    /// **How far under the throwing hand the solved catch plane is forced to sit, m.**
    ///
    /// `probeThrow` reports the distance at which a flight DESCENDS through the catch
    /// plane and falls through to the ground contact when that crossing never happens.
    /// `AI` used to ask for `aimY = 1.35` — a chest — while the release origin is a
    /// standing player's hand at `hipHeight * 1.10`, about 1.05 m, so on every flat throw
    /// in the game the crossing test could not fire and the solver was silently solving
    /// for the disc to hit the TURF at the receiver's feet. `predictCatchPoint` then read
    /// that flight back and sent the receiver to the first sample under 0.85 m, which on
    /// a 22 m pass is nine metres out. See the reference note on `SOLVE_CATCH_DROP`.
    ///
    /// **The clamp is the backstop, not the fix.** It repaired the flight and left the ask
    /// wrong by more than half a metre on every throw in the game, with nothing saying so.
    /// The ask is now `AIM_HEIGHT` = `handHeight - CATCH_PLANE_DROP`, and `CatchBandTests`
    /// asserts it is reachable from the modelled release — the assertion is red at 1.35.
    /// The clamp stays because a real hand is 1.00–1.11 m, not the model's 1.05 m.
    public static let catchDrop = 0.25
    /// At and beyond this ask the solver throws the LOFTED root — see `solveElevation`.
    public static let loftRange = 25.0

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
        heading: Double, want: Double, catchY: Double, lofted: Bool
    ) -> (angle: Double, lat: Double, reach: Double, floor: Double) {
        req.aim = Vec3d(sin(heading), 0, cos(heading))
        let step = (elevHi - elevLo) / Double(elevScan)

        var prevA = elevLo
        var prevD = -Double.infinity
        var peakA = elevLo
        var peakD = -Double.infinity
        var peakLat = 0.0
        var minA = elevLo
        var minD = Double.infinity
        var minLat = 0.0
        var loA = Double.nan
        var hiA = Double.nan
        var rising = true
        var fallLoA = Double.nan
        var fallHiA = Double.nan
        var riseLoA = Double.nan
        var riseHiA = Double.nan

        for i in 0...elevScan {
            let a = elevLo + step * Double(i)
            req.angle = a
            let r = probe.probeThrow(req, catchY: catchY, maxT: 6)
            if r.dist > peakD {
                peakD = r.dist
                peakA = a
                peakLat = r.lat
            }
            if r.dist < minD {
                minD = r.dist
                minA = a
                minLat = r.lat
            }
            if i > 0, r.dist >= want, prevD < want, !lofted {
                loA = prevA
                hiA = a
                break
            }
            if i > 0, r.dist >= want, prevD < want, lofted, riseLoA.isNaN {
                riseLoA = prevA
                riseHiA = a
            }
            // A FALLING CROSSING IS A ROOT TOO, and it is only ever the fallback. The
            // rising crossing above still wins outright: for any carry curve that starts
            // BELOW the ask — every throw long enough to need a peak — no falling crossing
            // can exist before it. This one fires on an INVERTED disc, whose carry falls
            // across the whole bracket instead of peaking inside it; see the reference.
            if i > 0, r.dist <= want, prevD > want, fallLoA.isNaN {
                fallLoA = prevA
                fallHiA = a
            }
            prevA = a
            prevD = r.dist
        }

        // A HUCK IS A LOFTED DISC, and the flat root is the wrong one for it. The flat
        // root delivers a 30 m backhand at a constant 1.0-1.1 m above the grass — a laser
        // through seven defenders at chest height — and once `flightPath` modelled that
        // honestly the AI could see the coverage and stopped throwing deep at all. A real
        // huck goes OVER the defence, which is the falling root: same distance, launched
        // up. See the reference note in `solveElevation`.
        if lofted, !fallLoA.isNaN {
            loA = fallLoA
            hiA = fallHiA
            rising = false
        } else if lofted, !riseLoA.isNaN {
            loA = riseLoA
            hiA = riseHiA
        } else if loA.isNaN, !fallLoA.isNaN {
            loA = fallLoA
            hiA = fallHiA
            rising = false
        }

        // NO CROSSING — two opposite failures, and this used to answer both with the peak.
        // Below the trough the ask is shorter than anything this release can throw, and
        // answering it with the maximum-distance angle turned a 1 m dump into a 19.6 m
        // bomb; above the peak it is genuinely out of range. Throw it as short as it goes,
        // or as far as it goes. The caller then drops the release SPEED and solves again.
        if loA.isNaN {
            if minD >= want {
                req.angle = minA
                return (minA, minLat, peakD, minD)
            }
            req.angle = peakA
            return (peakA, peakLat, peakD, minD)
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
            // Which half to keep depends on which way the carry runs across the cell.
            if (err < 0) == rising { loA = mid } else { hiA = mid }
        }
        req.angle = bestA
        return (bestA, bestLat, peakD, minD)
    }

    /// Solve power, elevation, bank and heading for a throw of `want` m along `heading0`.
    ///
    /// `req` carries the type, origin, power, spin and hand on the way in, and the
    /// solved angle, bank and aim on the way out.
    @discardableResult
    public static func solve(
        _ probe: DiscRuntime, _ req: inout ThrowRequest,
        heading0: Double, want: Double, catchY catchY0: Double
    ) -> Solution {
        // Both of these are properties of the throw, not of the caller — see `catchDrop`
        // and the loft note in `solveElevation`. The floor is the RULES' floor, read off
        // `CatchDecision` rather than retyped: under it there is no standing catch to
        // solve for, and a bare `0.20` here is how this bug family started.
        let catchY = clamp(catchY0, CatchDecision.standingFloor, req.from.y - catchDrop)
        let lofted = want >= loftRange
        var bank = 0.0
        var angle = 0.02
        var lat = 0.0
        var lifts = 0
        var drops = 0

        var pass = 0
        while pass < passes {
            req.bank = bank
            let e = solveElevation(
                probe, &req, heading: heading0, want: want, catchY: catchY, lofted: lofted)
            angle = e.angle
            lat = e.lat

            // THROW SOFTER RATHER THAN LONGER — the mirror of the lift below, and the half
            // of the problem the lift could never reach. `powerForSpeed` is clamped to a
            // floor of 0.12 in `aiThrow`, and 12% power on a backhand is still 13.8 m/s,
            // which carries about 19 m at the best angle and never less than 4.8 m at the
            // worst — so a 1 m dump to a named receiver was released as a 19.6 m bomb, and
            // 42% of the AI's asks under 6 m overshot by more than three metres.
            //
            // The human path was given an absolute release speed for exactly this
            // (`HumanRelease.swift`, `MIN_THROW_SPEED`) and the AI path never was.
            // `ThrowRequest.speed` is that same override; the solver reaches for it here,
            // scaling toward the shortest carry the scan could find, carry going roughly as
            // speed squared. See the reference for the measurements.
            let cur = req.speed ?? throwSpeed(req.type, req.power)
            if e.floor > want + reachTolerance, cur > speedMin, drops < speedDrops {
                drops += 1
                req.speed = clamp(cur * (want / max(0.5, e.floor)).squareRoot(), speedMin, cur)
                continue
            }

            // THROW HARDER RATHER THAN SHORTER. The release speed the AI asks for comes
            // from `throwFlightTime`, and above about a third of `maxThrowRange` that model
            // and the flight model disagree — a 42 m huck asked for at 22.7 m/s that no
            // launch angle carries past about 34 m. Carry goes roughly as speed squared, so
            // the lift is `sqrt(want / reach)` on power, capped at full. See the reference
            // header for the measurement.
            // `drops == 0` because the two are opposite corrections and the lift acts on
            // `power`, which an absolute `speed` has already overridden.
            if drops == 0, e.reach < want - reachTolerance, req.power < 1, lifts < powerLifts {
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
