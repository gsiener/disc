import Foundation
import UltimateSim

/// `Vec3d`/`Quatd` against three.js r185, operation for operation.
///
/// Almost everything here is asserted **bit-exact**, and that is not ambition — every
/// operation is `+ - * /` and `sqrt`, all correctly rounded by IEEE 754, so two correct
/// implementations agree to the last bit or one of them has the operations in a
/// different order. The single exception is `Quatd.norm`, which the reference computes
/// with a four-argument `Math.hypot`.
///
/// `applyQuaternion` is the assertion that matters most in this file. It is the hot
/// operation in the flight derivative — disc normal, body axis, world angular velocity,
/// body-frame torque all go through it — so an operation-order difference there
/// compounds through RK4 and surfaces as a physics bug rather than a math bug.
enum SimMathTests {

    struct Case: Decodable {
        let v: [Double]
        let q: [Double]
        let other: [Double]
        let length: Double
        let lengthSq: Double
        let dot: Double
        let quatNorm: Double
        let applyQuaternion: [Double]
        let applyConjugate: [Double]
        let conjugate: [Double]
        let normalize: [Double]
        let multiplyScalar: [Double]
        let addScaledVector: [Double]
        let crossVectors: [Double]
    }
    struct File: Decodable {
        let note: String
        let cases: [Case]
    }

    /// `hypot` is not specified to the last ulp by any libm, and the reference uses the
    /// four-argument form for the quaternion norm. Everything else is exact.
    static let hypotTol = 1e-15

    static func run() throws {
        let g = try Goldens.load(File.self, "simmath")
        Check.eq(g.cases.count, 221, "simmath goldens cover the full case set")

        for (i, c) in g.cases.enumerated() {
            let v = Vec3d(c.v[0], c.v[1], c.v[2])
            let other = Vec3d(c.other[0], c.other[1], c.other[2])
            let q = Quatd(c.q[0], c.q[1], c.q[2], c.q[3])
            let at = "case \(i)"

            Check.bitEqViaJSON(v.length, c.length, "\(at) length")
            Check.bitEqViaJSON(v.lengthSq, c.lengthSq, "\(at) lengthSq")
            Check.bitEqViaJSON(v.dot(other), c.dot, "\(at) dot")

            expectVec(v.applying(q), c.applyQuaternion, "\(at) applyQuaternion")
            expectVec(v.applying(q.conjugated), c.applyConjugate, "\(at) applyConjugate")
            expectVec(v.normalized, c.normalize, "\(at) normalize")
            expectVec(v.scaled(-3.75), c.multiplyScalar, "\(at) multiplyScalar")
            expectVec(v.addingScaled(other, 2.5), c.addScaledVector, "\(at) addScaledVector")
            expectVec(v.cross(other), c.crossVectors, "\(at) crossVectors")

            let conj = q.conjugated
            Check.bitEqViaJSON(conj.x, c.conjugate[0], "\(at) conjugate.x")
            Check.bitEqViaJSON(conj.y, c.conjugate[1], "\(at) conjugate.y")
            Check.bitEqViaJSON(conj.z, c.conjugate[2], "\(at) conjugate.z")
            Check.bitEqViaJSON(conj.w, c.conjugate[3], "\(at) conjugate.w")

            Check.near(q.length, c.quatNorm, hypotTol, "\(at) quaternion norm")
        }

        algebraicIdentities()
    }

    private static func expectVec(_ got: Vec3d, _ want: [Double], _ what: String) {
        Check.bitEqViaJSON(got.x, want[0], "\(what).x")
        Check.bitEqViaJSON(got.y, want[1], "\(what).y")
        Check.bitEqViaJSON(got.z, want[2], "\(what).z")
    }

    /// Identities that must hold whatever three.js does. These would catch a port that
    /// matched the goldens by coincidence — a sign flip in both `applying` and the
    /// golden generator, say.
    private static func algebraicIdentities() {
        let rng = Rng(seed: 0xA1_9EB2)

        for i in 0..<200 {
            let v = Vec3d(rng.range(-20, 20), rng.range(-20, 20), rng.range(-20, 20))
            let axis = Vec3d(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalized
            let q = Quatd.fromAxisAngle(axis, rng.range(-Double.pi, Double.pi))

            // A rotation preserves length.
            let rotated = v.applying(q)
            Check.near(rotated.length, v.length, 1e-12, "rotation preserves length, \(i)")

            // Rotating by q then by its conjugate returns the original vector.
            let roundTrip = rotated.applying(q.conjugated)
            Check.near(roundTrip.x, v.x, 1e-12, "round trip x, \(i)")
            Check.near(roundTrip.y, v.y, 1e-12, "round trip y, \(i)")
            Check.near(roundTrip.z, v.z, 1e-12, "round trip z, \(i)")

            // Rotating the axis by its own quaternion is a no-op.
            let axisRotated = axis.applying(q)
            Check.near(axisRotated.x, axis.x, 1e-12, "axis is invariant x, \(i)")
            Check.near(axisRotated.y, axis.y, 1e-12, "axis is invariant y, \(i)")
            Check.near(axisRotated.z, axis.z, 1e-12, "axis is invariant z, \(i)")

            // A rotation preserves the angle between two vectors, so it preserves dot.
            let w = Vec3d(rng.range(-20, 20), rng.range(-20, 20), rng.range(-20, 20))
            Check.near(
                rotated.dot(w.applying(q)), v.dot(w), 1e-9, "rotation preserves dot, \(i)")

            // The cross product is orthogonal to both operands.
            let c = v.cross(w)
            Check.near(c.dot(v) / Swift.max(c.length * v.length, 1e-30), 0, 1e-12,
                "cross ⟂ v, \(i)")
            Check.near(c.dot(w) / Swift.max(c.length * w.length, 1e-30), 0, 1e-12,
                "cross ⟂ w, \(i)")
        }

        // A zero vector normalises to zero rather than NaN — three.js divides by
        // `length || 1`, and the flight derivative depends on it when the disc is at rest.
        let zero = Vec3d.zero.normalized
        Check.ok(zero == Vec3d.zero, "zero vector normalises to zero, not NaN")

        // A collapsed quaternion renormalises to identity rather than to NaN.
        var collapsed = Quatd(0, 0, 0, 0)
        collapsed.normalize()
        Check.ok(collapsed == Quatd.identity, "collapsed quaternion falls back to identity")
    }
}
