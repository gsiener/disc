import Foundation
import UltimateSim

/// Integrated disc flight, against the physics it is claimed to obey.
///
/// **This was the first suite that could not be bit-exact, and now it is the first family
/// stated entirely as law rather than as record.** A trajectory runs the aero coefficients
/// through RK4 hundreds of times, calling `sin`, `cos`, `atan2`, `exp` and `tanh` — none
/// specified to the last ulp by any libm — so a recorded trajectory could only ever be
/// matched to a widening tolerance, tight at release and loose by the sixth second. That
/// tolerance was already a confession: the suite's own header used to say the physical
/// assertions below "matter more" than the comparison sitting beside them, "and if they
/// ever disagree with the fixtures, believe them." Believing them exclusively is this suite,
/// unchanged in method, just no longer keeping a fixture around to defer to.
///
/// None of what follows is a `Model` in the sense the other converted suites use one — RK4
/// over a canonical set of aerodynamic forces has no second, differently-shaped statement of
/// itself worth writing, and reimplementing it a second time would risk the exact
/// transcription bug that pattern exists to avoid. What a flight *has* instead is physics:
/// energy that only falls in still air, a curve that bends opposite ways under opposite
/// bank, a carry that does not depend on the caller's frame rate, a result unmoved by a
/// mirror in the plane the model has no reason to prefer a side of.
enum FlightTests {


    static func run() throws {
        Check.near(FIXED_DT, 1.0 / 120.0, 1e-18, "the engine's fixed dt is what it has always been")
        physicalProperties()
        symmetryAndDeterminism()
    }

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

    /// What the fixture's five recorded scenarios used to stand in for: that flying twice
    /// from the same state gives the same answer, and that the model has no reason to
    /// prefer one side of the plane it flies through.
    private static func symmetryAndDeterminism() {
        // Determinism. `DiscState.step` reads no global mutable state — two identical
        // releases run in lock-step must land on the same bit, every step, not just at
        // the end, or a divergence mid-flight could cancel out by the time anyone looked.
        var a = release(speed: 21, nose: 0.03, bank: 0.15, invert: false, spin: -54, height: 1.6)
        var b = a
        for _ in 0..<(120 * 4) {
            a.step(dt: FIXED_DT)
            b.step(dt: FIXED_DT)
            Check.bitEq(a.pos.x, b.pos.x, "two identical releases stay bit-identical in x")
            Check.bitEq(a.pos.y, b.pos.y, "and in y")
            Check.bitEq(a.pos.z, b.pos.z, "and in z")
        }

        // Mirror symmetry, kept deliberately simple: no spin and no bank, so there is no
        // chirality anywhere in the state for a reflection to disagree with. A disc thrown
        // flat with a sideways velocity component +vz must fly the exact mirror of one
        // thrown identically with -vz — nothing in drag, lift or gravity has an opinion
        // about which side of the x-axis the disc is aimed toward. A sign error confined
        // to one axis of the force assembly would pass every straight-line check above,
        // where the flight never leaves the x-y plane, and fail only here.
        func flatRelease(vz: Double) -> DiscState {
            var s = DiscState()
            s.pos = Vec3d(0, 1.6, 0)
            s.vel = Vec3d(20, 0, vz)
            s.omega = .zero
            // Face flush into the direction of travel, wings level — the orientation a
            // flat, unspun disc would need for the velocity to be doing all the work.
            let vdir = s.vel.normalized
            let up = Vec3d(0, 1, 0)
            let right = vdir.cross(up).normalized
            let normal = right.cross(vdir).normalized
            s.orient = quatFromBasis(vdir, right, normal)
            return s
        }
        var plain = flatRelease(vz: 3)
        var mirrored = flatRelease(vz: -3)
        var worstMirrorGap = 0.0
        for _ in 0..<(120 * 3) {
            plain.step(dt: FIXED_DT)
            mirrored.step(dt: FIXED_DT)
            worstMirrorGap = Swift.max(worstMirrorGap, abs(plain.pos.x - mirrored.pos.x))
            worstMirrorGap = Swift.max(worstMirrorGap, abs(plain.pos.y - mirrored.pos.y))
            worstMirrorGap = Swift.max(worstMirrorGap, abs(plain.pos.z + mirrored.pos.z))
        }
        Check.ok(
            worstMirrorGap < 1e-6,
            "a flat, unspun release mirrored in vz flies the mirror of the original — "
                + "worst gap \(worstMirrorGap) m over 3 s")

        // Carry increases with launch speed. Not a specific number — that is the 37 m
        // assertion above's job — just that the model does not have a dead zone or a
        // reversal somewhere in the speed range a real throw uses.
        var lastCarry = 0.0
        for speed in [12.0, 16.0, 20.0, 24.0] {
            var s = release(speed: speed, nose: 0.05, bank: 0, invert: false, spin: -52, height: 1.6)
            for _ in 0..<(120 * 6) where !s.atRest { s.step(dt: FIXED_DT) }
            let carry = Foundation.hypot(s.pos.x, s.pos.z)
            Check.ok(
                carry > lastCarry,
                "carry increases with launch speed: \(speed) m/s -> \(carry) m, "
                    + "previous \(lastCarry) m")
            lastCarry = carry
        }

        // A disc released near the ground comes to rest near the ground, not somewhere
        // its potential energy would suggest a bounce.
        var low = release(speed: 10, nose: 0.05, bank: 0, invert: false, spin: -40, height: 0.3)
        for _ in 0..<(120 * 8) where !low.atRest { low.step(dt: FIXED_DT) }
        Check.ok(low.atRest, "a disc released low comes to rest")
        Check.inRange(low.pos.y, -0.01, 0.2, "and finishes at ground level, not airborne or buried")
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
