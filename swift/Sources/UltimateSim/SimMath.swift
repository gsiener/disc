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

    public var lengthSq: Double { x * x + y * y + z * z + w * w }

    /// `THREE.Quaternion.length()` — plain `sqrt` of the sum of squares, and bit-exact.
    ///
    /// **Not** the same as the integrator's `normQuat`, which uses a four-argument
    /// `Math.hypot`. The reference really does normalise quaternions two different ways
    /// in two different places, and collapsing them into one would be a silent
    /// behavioural change. See `DiscPhysics.normQuat`.
    public var length: Double { (x * x + y * y + z * z + w * w).squareRoot() }

    public func dot(_ q: Quatd) -> Double { x * q.x + y * q.y + z * q.z + w * q.w }

    /// `THREE.Quaternion.normalize()`, including its exact zero guard.
    public mutating func normalize() {
        var l = length
        if l == 0 {
            x = 0
            y = 0
            z = 0
            w = 1
        } else {
            l = 1 / l
            x *= l
            y *= l
            z *= l
            w *= l
        }
    }

    public var normalized: Quatd {
        var q = self
        q.normalize()
        return q
    }

    /// `THREE.Quaternion.multiplyQuaternions(a, b)`.
    public static func * (a: Quatd, b: Quatd) -> Quatd {
        Quatd(
            a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,
            a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z,
            a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x,
            a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
        )
    }

    /// `THREE.Quaternion.premultiply(q)` — i.e. `q * self`, applying `q` after `self`.
    public func premultiplied(by q: Quatd) -> Quatd { q * self }

    /// `THREE.Quaternion.setFromUnitVectors`. Both arguments are assumed unit.
    ///
    /// The antiparallel branch and its `1e-8` epsilon are copied deliberately: three.js
    /// picks a perpendicular axis by comparing `|x|` against `|z|`, and any other choice
    /// of fallback axis produces a different — still valid — rotation, which would show
    /// up as the disc settling onto the ground the other way round.
    public static func fromUnitVectors(_ from: Vec3d, _ to: Vec3d) -> Quatd {
        var r = from.dot(to) + 1
        var q: Quatd
        if r < 1e-8 {
            r = 0
            if abs(from.x) > abs(from.z) {
                q = Quatd(-from.y, from.x, 0, r)
            } else {
                q = Quatd(0, -from.z, from.y, r)
            }
        } else {
            q = Quatd(
                from.y * to.z - from.z * to.y,
                from.z * to.x - from.x * to.z,
                from.x * to.y - from.y * to.x,
                r
            )
        }
        q.normalize()
        return q
    }

    /// `THREE.Matrix4.makeBasis(x, y, z)` fed to `THREE.Quaternion.setFromRotationMatrix`,
    /// fused — the columns of the basis matrix are the three axes, so the matrix never
    /// needs to exist.
    ///
    /// This exists because the two-`fromUnitVectors` shortcut it replaced was *almost*
    /// equivalent: it agreed with the reference to 5e-15 everywhere except when the
    /// rotated +X landed antiparallel to the target axis, where `fromUnitVectors` takes
    /// its arbitrary-perpendicular fallback branch and returns a *different valid*
    /// rotation. A huck aimed exactly down the -x axis hit that branch and released with
    /// its nose/bank frame visibly wrong — metres of lateral drift the reference did not
    /// have. Shepperd's method below is the reference's own, branch for branch.
    public static func fromBasis(_ x: Vec3d, _ y: Vec3d, _ z: Vec3d) -> Quatd {
        let m11 = x.x, m12 = y.x, m13 = z.x
        let m21 = x.y, m22 = y.y, m23 = z.y
        let m31 = x.z, m32 = y.z, m33 = z.z
        let trace = m11 + m22 + m33
        var q: Quatd
        if trace > 0 {
            let s = 0.5 / (trace + 1.0).squareRoot()
            q = Quatd((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s)
        } else if m11 > m22 && m11 > m33 {
            let s = 2.0 * (1.0 + m11 - m22 - m33).squareRoot()
            q = Quatd(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s)
        } else if m22 > m33 {
            let s = 2.0 * (1.0 + m22 - m11 - m33).squareRoot()
            q = Quatd((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s)
        } else {
            let s = 2.0 * (1.0 + m33 - m11 - m22).squareRoot()
            q = Quatd((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s)
        }
        return q
    }

    /// `THREE.Quaternion.slerp(qb, t)`, including the shortest-arc flip and the
    /// lerp-then-normalise fast path below a `0.9995` dot.
    public func slerped(to qb: Quatd, _ t: Double) -> Quatd {
        var x = qb.x, y = qb.y, z = qb.z, w = qb.w
        var dot = self.dot(qb)
        var t = t

        if dot < 0 {
            x = -x
            y = -y
            z = -z
            w = -w
            dot = -dot
        }

        var s = 1 - t

        if dot < 0.9995 {
            let theta = Foundation.acos(dot)
            let sin = Foundation.sin(theta)
            s = Foundation.sin(s * theta) / sin
            t = Foundation.sin(t * theta) / sin
            return Quatd(
                self.x * s + x * t,
                self.y * s + y * t,
                self.z * s + z * t,
                self.w * s + w * t
            )
        }

        // Small angles: lerp, then normalise.
        var q = Quatd(
            self.x * s + x * t,
            self.y * s + y * t,
            self.z * s + z * t,
            self.w * s + w * t
        )
        q.normalize()
        return q
    }

    public static func fromAxisAngle(_ axis: Vec3d, _ angle: Double) -> Quatd {
        // three.js Quaternion.setFromAxisAngle — assumes `axis` is already unit.
        let half = angle / 2
        let s = Foundation.sin(half)
        return Quatd(axis.x * s, axis.y * s, axis.z * s, Foundation.cos(half))
    }
}
