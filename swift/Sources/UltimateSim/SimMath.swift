import Foundation

/// Double-precision vector and quaternion math for the simulation.
///
/// **These are doubles, and that is the single most consequential decision in the
/// port.** The reference integrates RK4 over `Float64Array` state, and the flight
/// model, the `predictPath`/`predictLanding` contracts the camera depends on, and every
/// test envelope are all double-precision. A renderer's `Float`-based vector type would
/// silently halve that and degrade disc flight in ways that are near-impossible to
/// attribute afterwards. Conversion to single precision happens exactly once per frame,
/// at the render boundary, and never in here.
///
/// **These are structs, unlike `Rng`.** Value semantics are the right default for math
/// types and they remove the aliasing hazard the TypeScript manages by hand with
/// module-level scratch vectors. The reference relies on `THREE.Vector3` being a heap
/// reference in places — `DiscState.pos` is mutated through an alias — so when porting
/// code that reads that way, the mutation has to become an explicit assignment. That is
/// the main bug class in this port and it is worth suspecting first.
///
/// Operation order is copied from three.js r185 rather than rewritten, because the
/// suites assert bit-equality. Every operation here is `+ - * /` and `sqrt`, all
/// correctly rounded by IEEE 754, so bit-equality is achievable and any difference is a
/// transcription error rather than platform noise.

public struct Vec3d: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var z: Double

    public init(_ x: Double = 0, _ y: Double = 0, _ z: Double = 0) {
        self.x = x
        self.y = y
        self.z = z
    }

    public static let zero = Vec3d(0, 0, 0)

    public var lengthSq: Double { x * x + y * y + z * z }

    /// Note this is `sqrt(x² + y² + z²)`, not `hypot`. That matches three.js, and it is
    /// also the bit-exact choice: `sqrt` is correctly rounded, `hypot` is not specified
    /// to the last ulp by any libm.
    public var length: Double { (x * x + y * y + z * z).squareRoot() }

    public func dot(_ v: Vec3d) -> Double { x * v.x + y * v.y + z * v.z }

    public func cross(_ v: Vec3d) -> Vec3d {
        Vec3d(
            y * v.z - z * v.y,
            z * v.x - x * v.z,
            x * v.y - y * v.x
        )
    }

    public func scaled(_ s: Double) -> Vec3d { Vec3d(x * s, y * s, z * s) }

    public func addingScaled(_ v: Vec3d, _ s: Double) -> Vec3d {
        Vec3d(x + v.x * s, y + v.y * s, z + v.z * s)
    }

    /// Unit vector, or zero if the length is zero.
    ///
    /// three.js divides by `length || 1`, so a zero vector normalises to zero rather
    /// than to NaN. Reproduced exactly — the derivative relies on it when the disc is
    /// momentarily at rest.
    public var normalized: Vec3d {
        let l = length
        return scaled(1 / (l == 0 ? 1 : l))
    }

    public func applying(_ q: Quatd) -> Vec3d {
        // three.js r185 Vector3.applyQuaternion, operation for operation:
        //   t = 2 * cross(q.xyz, v)
        //   v + q.w * t + cross(q.xyz, t)
        // The algebraically equal q*v*q⁻¹ rounds differently. Do not "simplify" this.
        let vx = x, vy = y, vz = z
        let qx = q.x, qy = q.y, qz = q.z, qw = q.w

        let tx = 2 * (qy * vz - qz * vy)
        let ty = 2 * (qz * vx - qx * vz)
        let tz = 2 * (qx * vy - qy * vx)

        return Vec3d(
            vx + qw * tx + qy * tz - qz * ty,
            vy + qw * ty + qz * tx - qx * tz,
            vz + qw * tz + qx * ty - qy * tx
        )
    }

    public static func + (a: Vec3d, b: Vec3d) -> Vec3d { Vec3d(a.x + b.x, a.y + b.y, a.z + b.z) }
    public static func - (a: Vec3d, b: Vec3d) -> Vec3d { Vec3d(a.x - b.x, a.y - b.y, a.z - b.z) }
    public static prefix func - (v: Vec3d) -> Vec3d { Vec3d(-v.x, -v.y, -v.z) }
}

public struct Quatd: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var z: Double
    public var w: Double

    public init(_ x: Double = 0, _ y: Double = 0, _ z: Double = 0, _ w: Double = 1) {
        self.x = x
        self.y = y
        self.z = z
        self.w = w
    }

    public static let identity = Quatd(0, 0, 0, 1)

    /// The conjugate, which for a unit quaternion is the inverse rotation.
    public var conjugated: Quatd { Quatd(-x, -y, -z, w) }

    /// The 4-component norm.
    ///
    /// The reference uses `Math.hypot(x, y, z, w)` here, and this is one of only two
    /// calls in the whole sim where `hypot` is not a two-argument planar distance that a
    /// bit-exact `sqrt` could replace. `hypot` is not specified to the last ulp, so this
    /// value — alone among the ops in this file — is asserted on a tolerance rather than
    /// bit-exactly. It is used to renormalise the quaternion each step, where a
    /// last-ulp difference is immediately washed out.
    public var norm: Double {
        // Deliberately `sqrt` of the sum of squares rather than a composed `hypot`.
        // `hypot` exists to avoid overflow when a component is near the top of the
        // double range; this quaternion is always near-unit, so that protection buys
        // nothing and costs predictability. The difference from the reference is at the
        // last ulp, which is why `norm` is the one operation in this file asserted on a
        // tolerance instead of bit-exactly.
        (x * x + y * y + z * z + w * w).squareRoot()
    }

    /// Renormalise in place, falling back to identity if the quaternion has collapsed.
    public mutating func normalize() {
        let m = norm
        if m > 1e-12 {
            let k = 1 / m
            x *= k
            y *= k
            z *= k
            w *= k
        } else {
            x = 0
            y = 0
            z = 0
            w = 1
        }
    }

    public static func fromAxisAngle(_ axis: Vec3d, _ angle: Double) -> Quatd {
        // three.js Quaternion.setFromAxisAngle — assumes `axis` is already unit.
        let half = angle / 2
        let s = Foundation.sin(half)
        return Quatd(axis.x * s, axis.y * s, axis.z * s, Foundation.cos(half))
    }
}
