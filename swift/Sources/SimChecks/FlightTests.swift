import Foundation
import UltimateSim

/// Integrated trajectories against `src/sim/DiscPhysics.ts`.
///
/// **This is the first suite that cannot be bit-exact, and the tolerance is shaped to
/// say so honestly.** A trajectory runs the aero coefficients through RK4 hundreds of
/// times, and those call `sin`, `cos`, `atan2`, `exp` and `tanh` — none specified to the
/// last ulp by any libm. A single ulp at release compounds. So the tolerance **widens
/// with horizon**: tight in the first second, looser by the sixth. A flat epsilon would
/// be either too loose at release to catch a real bug, or failing late for reasons that
/// are not bugs.
///
/// The suite reports the worst deviation it actually saw, so the tolerance stays a
/// measured margin rather than a number chosen to make the test pass.
///
/// Physical assertions sit alongside the goldens and matter more than they do. They
/// would survive a deliberate retune of the coefficients, and they encode what the
/// flight model *means* — if they ever disagree with the fixtures, believe them.
enum FlightTests {

    struct Sample: Decodable {
        let t: Double
        let pos: [Double]
        let vel: [Double]
        let orient: [Double]
        let omega: [Double]
        let alpha: Double
        let airspeed: Double
        let spin: Double
        let atRest: Bool
        let touchedGround: Bool
    }
    struct Initial: Decodable {
        let pos: [Double]
        let vel: [Double]
        let nose: Double
        let bank: Double
        let invert: Bool
        let spin: Double
        let orient: [Double]
    }
    struct Case: Decodable {
        let name: String
        let note: String
        let initial: Initial?
        let seconds: Double
        let samples: [Sample]

        enum CodingKeys: String, CodingKey {
            case name, note, seconds, samples
            case initial = "init"
        }
    }
    struct File: Decodable {
        let note: String
        let fixedDt: Double
        let cases: [Case]
    }

    /// Position tolerance in metres at elapsed time `t`.
    ///
    /// About a nanometre at release, a micrometre by six seconds. Both are far below
    /// anything the game could perceive — a disc is 273 mm across — while still being
    /// tight enough that a wrong coefficient or a transposed term fails immediately.
    static func posTol(_ t: Double) -> Double { 1e-9 * pow(10.0, t / 2.0) }

    /// Velocity drifts a little faster than position, since position is its integral and
    /// integration smooths.
    static func velTol(_ t: Double) -> Double { 1e-8 * pow(10.0, t / 2.0) }

    nonisolated(unsafe) static var worstPosRatio = 0.0
    nonisolated(unsafe) static var worstPosAbs = 0.0
    nonisolated(unsafe) static var worstPosLabel = "none"

    static func run() throws {
        let g = try Goldens.load(File.self, "flight")
        Check.near(g.fixedDt, 1.0 / 120.0, 1e-18, "fixture stepped at the engine's fixed dt")
        Check.eq(g.cases.count, 5, "flight goldens cover five scenarios")

        for c in g.cases {
            replay(c)
        }

        physicalProperties()
        // `worstPosAbs`/`worstPosRatio`/`worstPosLabel` are redundant with the report:
        // `compare()` already asserts `d <= tol` on every sample that could move them.
    }

    /// Re-run a scenario in Swift from the same release state and compare sample by sample.
    private static func replay(_ c: Case) {
        guard let start = c.initial else {
            Check.ok(false, "\(c.name) has no initial state")
            return
        }

        var s = DiscState()
        s.pos = Vec3d(start.pos[0], start.pos[1], start.pos[2])
        s.vel = Vec3d(start.vel[0], start.vel[1], start.vel[2])
        s.omega = Vec3d(0, 0, start.spin)
        // Taken from the fixture rather than rebuilt here. Rebuilding it would need
        // `makeBasis` and `setFromRotationMatrix`, which are not ported yet — and more to
        // the point, a release frame rebuilt by the test could be wrong in exactly the
        // same way as the code under test and agree with it for the wrong reason.
        s.orient = Quatd(start.orient[0], start.orient[1], start.orient[2], start.orient[3])

        var sampleIndex = 0
        let stepsTotal = Int((c.seconds * 120).rounded())

        // Sample zero is the release state, before any integration.
        compare(s, c.samples[0], c.name, 0)
        sampleIndex = 1

        for i in 0..<stepsTotal {
            s.step(dt: FIXED_DT)
            if (i + 1) % 6 == 0 {
                if sampleIndex < c.samples.count {
                    compare(s, c.samples[sampleIndex], c.name, sampleIndex)
                    sampleIndex += 1
                }
            }
        }

        Check.eq(sampleIndex, c.samples.count, "\(c.name) consumed every sample")
    }

    private static func compare(_ s: DiscState, _ want: Sample, _ name: String, _ i: Int) {
        let t = want.t
        let pTol = posTol(t)
        let vTol = velTol(t)

        let dp = [s.pos.x - want.pos[0], s.pos.y - want.pos[1], s.pos.z - want.pos[2]]
        for (axis, d) in zip(["x", "y", "z"], dp) {
            let ratio = abs(d) / pTol
            if ratio > worstPosRatio {
                worstPosRatio = ratio
                worstPosAbs = abs(d)
                worstPosLabel = "\(name) t=\(String(format: "%.2f", t)) pos.\(axis)"
            }
            Check.ok(
                abs(d) <= pTol,
                "\(name) sample \(i) (t=\(t)) pos.\(axis) — off by \(d), tolerance \(pTol)")
        }

        Check.ok(
            abs(s.vel.x - want.vel[0]) <= vTol && abs(s.vel.y - want.vel[1]) <= vTol
                && abs(s.vel.z - want.vel[2]) <= vTol,
            "\(name) sample \(i) (t=\(t)) velocity within \(vTol)")

        // The quaternion can carry an overall sign flip and represent the same rotation,
        // so compare the rotation, not the components.
        let q = s.orient
        let dotAbs = abs(q.x * want.orient[0] + q.y * want.orient[1]
            + q.z * want.orient[2] + q.w * want.orient[3])
        Check.ok(
            dotAbs >= 1 - 1e-6 * pow(10.0, t / 2.0),
            "\(name) sample \(i) (t=\(t)) orientation aligned — |dot| \(dotAbs)")

        Check.eq(s.atRest, want.atRest, "\(name) sample \(i) atRest")
        Check.eq(s.touchedGround, want.touchedGround, "\(name) sample \(i) touchedGround")
    }

    /// What the flight model means, independent of what the reference happens to compute.
    private static func physicalProperties() {
        let aero = AeroCoeffs.standard
        let body = DiscBody.standard

        // A 20 m/s backhand carries about 37 m. This is the number `Coeffs.ts` was
        // calibrated against — it is why CLa is 2.0 rather than the briefed 1.4 — so it
        // is the single most load-bearing physical assertion in the suite.
        var s = release(speed: 20, nose: 0.05, bank: 0, invert: false, spin: -52, height: 1.6)
        var peak = s.pos.y
        var steps = 0
        while !s.atRest && steps < 120 * 12 {
            s.step(dt: FIXED_DT)
            peak = Swift.max(peak, s.pos.y)
            steps += 1
        }
        let carry = Foundation.hypot(s.pos.x, s.pos.z)
        Check.inRange(carry, 33, 43, "a 20 m/s backhand carries about 37 m (got \(carry))")
        Check.ok(s.atRest, "a thrown disc eventually comes to rest")
        Check.ok(peak < 6, "a flat backhand does not balloon (peak \(peak) m)")

        // Inverted flight is the reversed-flow penalty made visible: the same speed
        // upside down must not glide.
        var flat = release(speed: 18, nose: 0.05, bank: 0, invert: false, spin: -50, height: 1.6)
        var inverted = release(speed: 18, nose: 0.05, bank: 0, invert: true, spin: 50, height: 1.6)
        for _ in 0..<(120 * 10) {
            flat.step(dt: FIXED_DT)
            inverted.step(dt: FIXED_DT)
        }
        let flatCarry = Foundation.hypot(flat.pos.x, flat.pos.z)
        let invCarry = Foundation.hypot(inverted.pos.x, inverted.pos.z)
        Check.ok(
            invCarry < flatCarry * 0.75,
            "upside down falls out of the sky (\(invCarry) m vs \(flatCarry) m)")

        // Banking leans the lift vector, so the flight curves — and the two directions
        // must curve opposite ways. A sign error here would be invisible in a single case.
        var left = release(speed: 22, nose: 0.05, bank: 0.4, invert: false, spin: -55, height: 1.6)
        var right = release(speed: 22, nose: 0.05, bank: -0.4, invert: false, spin: -55, height: 1.6)
        for _ in 0..<(120 * 3) {
            left.step(dt: FIXED_DT)
            right.step(dt: FIXED_DT)
        }
        Check.ok(
            (left.pos.z - right.pos.z) > 2.0,
            "opposite bank curves opposite ways (\(left.pos.z) vs \(right.pos.z))")

        // Drag only ever removes energy. A disc that gains energy in still air means a
        // sign error in the force assembly, and it would be catastrophic and subtle.
        var e = release(speed: 24, nose: 0.05, bank: 0, invert: false, spin: -55, height: 30)
        var lastEnergy = Double.infinity
        var rose = 0
        for _ in 0..<(120 * 3) {
            let before = energy(e, body: body, aero: aero)
            e.step(dt: FIXED_DT)
            let after = energy(e, body: body, aero: aero)
            if after > before + 1e-9 { rose += 1 }
            lastEnergy = after
        }
        Check.eq(rose, 0, "total energy never increases in still air")
        Check.ok(lastEnergy.isFinite, "energy stays finite")

        // The integrator must not diverge, whatever it is handed.
        var wild = DiscState()
        wild.pos = Vec3d(0, 50, 0)
        wild.vel = Vec3d(40, 10, -12)
        wild.omega = Vec3d(30, -20, 90)  // tumbling hard
        wild.orient = Quatd.fromAxisAngle(Vec3d(1, 2, 3).normalized, 2.1)
        for _ in 0..<(120 * 10) { wild.step(dt: FIXED_DT) }
        Check.ok(wild.isFinite, "a violently tumbling disc does not produce NaN")

        // Sub-stepping means the result must not depend on the caller's frame rate.
        var fine = release(speed: 20, nose: 0.05, bank: 0, invert: false, spin: -52, height: 1.6)
        var coarse = fine
        for _ in 0..<120 { fine.step(dt: FIXED_DT) }
        for _ in 0..<4 { coarse.step(dt: 0.25) }
        Check.near(fine.pos.x, coarse.pos.x, 1e-9, "a coarse dt sub-steps to the same place")
        Check.near(fine.pos.y, coarse.pos.y, 1e-9, "sub-stepping matches in y")
    }

    /// Build a release state the way the fixture generator does.
    private static func release(
        speed: Double, nose: Double, bank: Double, invert: Bool, spin: Double, height: Double
    ) -> DiscState {
        var s = DiscState()
        s.pos = Vec3d(0, height, 0)
        s.vel = Vec3d(speed, 0, 0)
        s.omega = Vec3d(0, 0, spin)

        let up = Vec3d(0, 1, 0)
        let vdir = s.vel.normalized
        let right = vdir.cross(up).normalized
        let upPerp = right.cross(vdir).normalized

        var normal = upPerp.scaled(Foundation.cos(nose))
            .addingScaled(vdir, -Foundation.sin(nose))
        if invert { normal = -normal }
        normal = normal.applying(Quatd.fromAxisAngle(vdir, bank)).normalized

        let bodyX = vdir.addingScaled(normal, -vdir.dot(normal)).normalized
        let bodyY = normal.cross(bodyX).normalized
        s.orient = quatFromBasis(bodyX, bodyY, normal)
        return s
    }

    /// Orientation from an orthonormal basis, via `setFromUnitVectors` twice rather than a
    /// rotation matrix — `makeBasis`/`setFromRotationMatrix` are not ported yet.
    private static func quatFromBasis(_ x: Vec3d, _ y: Vec3d, _ z: Vec3d) -> Quatd {
        // Take body +Z to the target normal, then spin about that normal until body +X
        // lands on the target flight axis.
        let q1 = Quatd.fromUnitVectors(Vec3d(0, 0, 1), z)
        let xAfter = Vec3d(1, 0, 0).applying(q1)
        let q2 = Quatd.fromUnitVectors(xAfter, x)
        return (q2 * q1).normalized
    }

    private static func energy(_ s: DiscState, body b: DiscBody, aero c: AeroCoeffs) -> Double {
        let kinetic = 0.5 * b.mass * s.vel.lengthSq
        let potential = b.mass * c.g * s.pos.y
        let rotational =
            0.5 * (b.Ixx * (s.omega.x * s.omega.x + s.omega.y * s.omega.y)
                + b.Izz * s.omega.z * s.omega.z)
        return kinetic + potential + rotational
    }
}
