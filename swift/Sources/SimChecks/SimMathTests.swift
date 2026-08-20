import Foundation
import UltimateSim

/// `Vec3d` and `Quatd` against the mathematics they claim to implement.
///
/// # How this suite knows what is right
///
/// Vector and quaternion algebra is *defined*, not measured, so nothing here is a
/// recorded output. Every expectation is one of three kinds:
///
/// 1. **A closed form.** A rotation preserves length. A cross product is orthogonal to
///    both operands. `x̂ × ŷ = ẑ`. A unit vector has length one. These are asserted
///    bit-exactly wherever the operation is `+ - * /` and `sqrt` on values that round
///    exactly — which is most of this file, because every one of those operations is
///    correctly rounded by IEEE 754.
/// 2. **`Model`** — rotation written a second, deliberately different way: as 3×3
///    matrices, with quaternions carried as a scalar and a vector rather than four
///    named fields, and slerp expressed as "take the relative rotation to the power
///    `t`" rather than as a sine-weighted blend. Structuring it differently is the
///    point: a transcription slip in `SimMath` cannot be mirrored here by accident.
///    Matrix arithmetic rounds differently from quaternion arithmetic, so these
///    comparisons carry a tolerance — around 1e-13 of the magnitude involved, which is
///    a hundred times tighter than any error that could come from a wrong operation.
/// 3. **The exceptions**, stated rather than hidden: three.js divides by `length || 1`,
///    so a zero vector normalises to zero and a collapsed quaternion to identity;
///    `length` is `sqrt` of the sum of squares rather than `hypot`, so it overflows
///    where `hypot` would not; and `slerped` really does switch to lerp-then-normalise
///    above a `0.9995` dot, so `Model` reproduces that branch instead of pretending the
///    function is a pure geodesic.
///
/// `applying` is the assertion that matters most. It is the hot operation in the flight
/// derivative — disc normal, body axis, world angular velocity, body-frame torque all go
/// through it — so an error there compounds through RK4 and surfaces as a physics bug
/// rather than a math bug.
enum SimMathTests {

    // MARK: - the specification, implemented independently

    /// Rotation, written as matrices.
    ///
    /// Nothing in here calls `Vec3d` or `Quatd`. Vectors are plain triples, quaternions
    /// are a vector part plus a scalar, a rotation applied to a vector goes through a
    /// 3×3 matrix rather than through three.js's `v + 2w(u×v) + 2u×(u×v)`, and a
    /// quaternion product is `(w₁w₂ − v₁·v₂, w₁v₂ + w₂v₁ + v₁×v₂)` rather than four
    /// scalar lines. Same mathematics, different shape, so the two agreeing means both
    /// are right rather than that one was copied from the other.
    enum Model {
        typealias V = (x: Double, y: Double, z: Double)
        /// A quaternion as the mathematics writes it: a vector part and a scalar.
        typealias Q = (v: V, w: Double)

        static func add(_ a: V, _ b: V) -> V { (a.x + b.x, a.y + b.y, a.z + b.z) }
        static func scale(_ a: V, _ s: Double) -> V { (a.x * s, a.y * s, a.z * s) }
        static func dot(_ a: V, _ b: V) -> Double { a.x * b.x + a.y * b.y + a.z * b.z }
        static func cross(_ a: V, _ b: V) -> V {
            (a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
        }
        static func len(_ a: V) -> Double { dot(a, a).squareRoot() }
        static func unit(_ a: V) -> V { scale(a, 1 / len(a)) }

        static func dot4(_ a: Q, _ b: Q) -> Double { dot(a.v, b.v) + a.w * b.w }
        static func len4(_ a: Q) -> Double { dot4(a, a).squareRoot() }
        static func negated(_ a: Q) -> Q { (v: scale(a.v, -1), w: -a.w) }
        static func conj(_ a: Q) -> Q { (v: scale(a.v, -1), w: a.w) }
        static func normalized(_ a: Q) -> Q {
            let l = len4(a)
            return (v: scale(a.v, 1 / l), w: a.w / l)
        }

        /// Hamilton's product, in scalar-and-vector form.
        static func mul(_ a: Q, _ b: Q) -> Q {
            (
                v: add(add(scale(b.v, a.w), scale(a.v, b.w)), cross(a.v, b.v)),
                w: a.w * b.w - dot(a.v, b.v)
            )
        }

        /// A rotation of `angle` about a unit `axis`, right-handed.
        static func axisAngle(_ axis: V, _ angle: Double) -> Q {
            (v: scale(unit(axis), Foundation.sin(angle / 2)), w: Foundation.cos(angle / 2))
        }

        /// Rodrigues' formula — a rotation of a vector with no quaternion anywhere in it.
        static func rotate(axis k: V, angle: Double, _ v: V) -> V {
            let c = Foundation.cos(angle)
            let s = Foundation.sin(angle)
            return add(
                add(scale(v, c), scale(cross(k, v), s)),
                scale(k, dot(k, v) * (1 - c)))
        }

        /// The rotation matrix of a unit quaternion, row major.
        ///
        /// Only a rotation for unit input: three.js's `applyQuaternion` is
        /// `v + 2w(u×v) + 2u×(u×v)`, whose linear term is `1 − 2|u|²` rather than
        /// `w² − |u|²`, and the two agree exactly when `w² + |u|² = 1`.
        static func matrix(_ q: Q) -> [[Double]] {
            let (x, y, z, w) = (q.v.x, q.v.y, q.v.z, q.w)
            return [
                [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
            ]
        }

        static func apply(_ m: [[Double]], _ v: V) -> V {
            (
                m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
                m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
                m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z
            )
        }

        static func apply(_ q: Q, _ v: V) -> V { apply(matrix(q), v) }

        /// The rotation carrying unit `from` onto unit `to`, by the shortest path.
        ///
        /// Stated as an axis and an angle: rotate about `from × to` by the angle between
        /// them. Antiparallel inputs have no defined axis, and three.js resolves that by
        /// rotating a half turn about a reference axis crossed into `from` — `ẑ` when
        /// `|from.x| > |from.z|`, `x̂` otherwise. That choice is arbitrary but it is not
        /// free: the other one is a different, equally valid rotation, and it decides
        /// which way round a disc settles onto the ground.
        static func fromUnitVectors(_ from: V, _ to: V) -> Q {
            let d = dot(from, to)
            if d + 1 < 1e-8 {
                let reference: V = abs(from.x) > abs(from.z) ? (0, 0, 1) : (1, 0, 0)
                return (v: unit(cross(reference, from)), w: 0)
            }
            return axisAngle(cross(from, to), Foundation.acos(Swift.min(1, Swift.max(-1, d))))
        }

        /// `slerped`, expressed as a power of the relative rotation.
        ///
        /// `a` and `b` are unit. Take the rotation that carries `a` to `b`, keep `t` of
        /// its angle, and apply that to `a`. Above a `0.9995` dot the production code
        /// switches to lerp-then-normalise, which is a *different function* — accurate to
        /// about `θ³/48` rather than exact — so the branch is part of the specification
        /// and is reproduced here rather than idealised away.
        static func slerp(_ a: Q, _ b0: Q, _ t: Double) -> Q {
            var b = b0
            var d = dot4(a, b)
            // The shortest arc: `q` and `−q` are the same rotation, so take whichever
            // representative is on the near side.
            if d < 0 {
                b = negated(b)
                d = -d
            }
            if d >= 0.9995 {
                let lerped: Q = (
                    v: add(scale(a.v, 1 - t), scale(b.v, t)), w: a.w * (1 - t) + b.w * t
                )
                return normalized(lerped)
            }
            let relative = mul(conj(a), b)
            let angle = 2 * Foundation.acos(Swift.min(1, Swift.max(-1, relative.w)))
            return mul(a, axisAngle(relative.v, angle * t))
        }
    }

    // MARK: - bridges between the two shapes

    static func v3(_ v: Model.V) -> Vec3d { Vec3d(v.x, v.y, v.z) }
    static func model(_ v: Vec3d) -> Model.V { (v.x, v.y, v.z) }
    static func model(_ q: Quatd) -> Model.Q { (v: (q.x, q.y, q.z), w: q.w) }

    static func expect(
        _ got: Vec3d, _ want: Model.V, _ tol: Double, _ what: String,
        file: StaticString = #fileID, line: UInt = #line
    ) {
        Check.near(got.x, want.x, tol, "\(what).x", file: file, line: line)
        Check.near(got.y, want.y, tol, "\(what).y", file: file, line: line)
        Check.near(got.z, want.z, tol, "\(what).z", file: file, line: line)
    }

    static func expectExactly(
        _ got: Vec3d, _ want: Vec3d, _ what: String,
        file: StaticString = #fileID, line: UInt = #line
    ) {
        Check.bitEq(got.x, want.x, "\(what).x", file: file, line: line)
        Check.bitEq(got.y, want.y, "\(what).y", file: file, line: line)
        Check.bitEq(got.z, want.z, "\(what).z", file: file, line: line)
    }

    static func expectExactly(
        _ got: Quatd, _ want: Quatd, _ what: String,
        file: StaticString = #fileID, line: UInt = #line
    ) {
        Check.bitEq(got.x, want.x, "\(what).x", file: file, line: line)
        Check.bitEq(got.y, want.y, "\(what).y", file: file, line: line)
        Check.bitEq(got.z, want.z, "\(what).z", file: file, line: line)
        Check.bitEq(got.w, want.w, "\(what).w", file: file, line: line)
    }

    static func expect(
        _ got: Quatd, _ want: Model.Q, _ tol: Double, _ what: String,
        file: StaticString = #fileID, line: UInt = #line
    ) {
        Check.near(got.x, want.v.x, tol, "\(what).x", file: file, line: line)
        Check.near(got.y, want.v.y, tol, "\(what).y", file: file, line: line)
        Check.near(got.z, want.v.z, tol, "\(what).z", file: file, line: line)
        Check.near(got.w, want.w, tol, "\(what).w", file: file, line: line)
    }

    /// Two unit quaternions describe the same rotation when they agree up to sign.
    static func expectSameRotation(
        _ got: Quatd, _ want: Model.Q, _ tol: Double, _ what: String,
        file: StaticString = #fileID, line: UInt = #line
    ) {
        let aligned = Model.dot4(model(got), want) < 0 ? Model.negated(want) : want
        expect(got, aligned, tol, what, file: file, line: line)
    }

    // MARK: - the cases

    /// Vectors chosen to break things rather than to be typical: the zero vector (the
    /// `length || 1` guard), the three axes and their negation (exact cross products),
    /// something small enough to square to a denormal-adjacent value, and something large
    /// enough that a `hypot`-shaped implementation would be the only one not to overflow.
    static let edgeVectors: [Vec3d] = [
        Vec3d(0, 0, 0),
        Vec3d(1, 0, 0),
        Vec3d(0, 1, 0),
        Vec3d(0, 0, 1),
        Vec3d(-1, -1, -1),
        Vec3d(1e-9, 0, 0),
        Vec3d(1e8, -1e8, 1e8),
        Vec3d(3, 4, 12),
        Vec3d(-0.5, 0.25, -0.125),
    ]

    /// Quaternions with components that are exact in binary floating point, so the
    /// rotations they describe can be asserted to the bit rather than to a tolerance.
    /// `(0,0,0,1)` is identity, the three half turns are the axes, and `(½,½,½,½)` is the
    /// 120° turn that cycles the axes.
    static let edgeQuats: [Quatd] = [
        Quatd(0, 0, 0, 1),
        Quatd(1, 0, 0, 0),
        Quatd(0, 1, 0, 0),
        Quatd(0, 0, 1, 0),
        Quatd(0.5, 0.5, 0.5, 0.5),
        Quatd(-0.5, 0.5, -0.5, 0.5),
    ]

    static func run() throws {
        vectorClosedForms()
        vectorLaws()
        quaternionClosedForms()
        rotationAgainstTheModel()
        exactRotations()
        axisAngle()
        multiplication()
        fromUnitVectors()
        fromBasis()
        slerp()
        theDocumentedExceptions()
    }

    // MARK: - Vec3d, closed forms

    /// The members whose value is fixed by a formula rather than by a measurement.
    private static func vectorClosedForms() {
        let rng = Rng(seed: 0x5EED_C0DE)

        // Pythagorean quadruples: the only length inputs whose answer is an integer, and
        // therefore the only ones where "correct" and "bit-exact" are the same statement.
        let exactLengths: [(Vec3d, Double)] = [
            (Vec3d(3, 4, 12), 13), (Vec3d(1, 2, 2), 3), (Vec3d(2, 3, 6), 7),
            (Vec3d(4, 4, 7), 9), (Vec3d(-1, -4, -8), 9), (Vec3d(2, 10, 11), 15),
            (Vec3d(1, 0, 0), 1), (Vec3d(0, -6, 0), 6), (Vec3d(0, 0, 0), 0),
        ]
        for (v, want) in exactLengths {
            Check.bitEq(v.length, want, "|\(v)| is exactly \(want)")
            Check.bitEq(v.lengthSq, want * want, "|\(v)|² is exactly \(want * want)")
        }

        for i in 0..<300 {
            let v = Vec3d(rng.range(-20, 20), rng.range(-20, 20), rng.range(-20, 20))
            let w = Vec3d(rng.range(-20, 20), rng.range(-20, 20), rng.range(-20, 20))
            let s = rng.range(-5, 5)
            let at = "case \(i)"

            // `lengthSq` is the vector dotted with itself, and `length` its square root.
            Check.bitEq(v.lengthSq, v.dot(v), "\(at) lengthSq is v·v")
            Check.bitEq(v.length, v.lengthSq.squareRoot(), "\(at) length is sqrt(lengthSq)")

            // Dot is symmetric and bilinear.
            Check.bitEq(v.dot(w), w.dot(v), "\(at) dot is symmetric")
            Check.near(
                v.dot(w.scaled(s)), v.dot(w) * s, 1e-11,
                "\(at) dot is linear in its second argument")
            Check.near(
                v.dot(w), Model.dot(model(v), model(w)), 1e-12, "\(at) dot matches the model")

            // Cross is antisymmetric — bit-exactly, because `a−b` and `b−a` differ only in
            // their sign bit — and vanishes on parallel operands.
            expectExactly(v.cross(w), -w.cross(v), "\(at) cross is antisymmetric")
            expectExactly(v.cross(v), Vec3d.zero, "\(at) v × v is zero")
            expect(v.cross(w), Model.cross(model(v), model(w)), 1e-11, "\(at) cross")

            // Orthogonality and Lagrange's identity, |a×b|² = |a|²|b|² − (a·b)², which
            // together pin the magnitude as well as the direction.
            let c = v.cross(w)
            Check.near(c.dot(v) / Swift.max(c.length * v.length, 1e-30), 0, 1e-14,
                "\(at) cross ⟂ v")
            Check.near(c.dot(w) / Swift.max(c.length * w.length, 1e-30), 0, 1e-14,
                "\(at) cross ⟂ w")
            let lagrange = v.lengthSq * w.lengthSq - v.dot(w) * v.dot(w)
            Check.near(c.lengthSq / lagrange, 1, 1e-12, "\(at) Lagrange's identity")

            // `scaled`, pinned by the cases where the answer is forced: doubling is
            // addition, −1 is negation, and a power of two is exactly reversible.
            expectExactly(v.scaled(2), v + v, "\(at) scaled(2) is v + v")
            expectExactly(v.scaled(-1), -v, "\(at) scaled(-1) is −v")
            expectExactly(v.scaled(1), v, "\(at) scaled(1) is v")
            expectExactly(v.scaled(0.25).scaled(4), v, "\(at) scaling by 1/4 then 4 is exact")
            // Scaling by zero gives a zero vector — signed, because IEEE says `−3 × 0` is
            // `−0`, so this is a magnitude check rather than a bit-pattern one.
            Check.bitEq(v.scaled(0).lengthSq, 0, "\(at) scaled(0) is zero")

            // `addingScaled` is `self + v*s` with the multiply first. Asserting it against
            // that composition is what would catch it being re-associated to `(self+v)*s`
            // or fused into a different rounding.
            expectExactly(
                v.addingScaled(w, s), v + w.scaled(s), "\(at) addingScaled is v + w·s")
            expectExactly(v.addingScaled(w, 0), v, "\(at) addingScaled by 0 is v")
            expectExactly(v.addingScaled(w, 1), v + w, "\(at) addingScaled by 1 is v + w")
            expectExactly(v.addingScaled(w, -1), v - w, "\(at) addingScaled by −1 is v − w")

            // Addition: commutative, and subtraction is addition of the negation.
            expectExactly(v + w, w + v, "\(at) addition commutes")
            expectExactly(v - w, v + (-w), "\(at) subtraction is adding the negation")
            expectExactly(v - v, Vec3d.zero, "\(at) v − v is zero")
            expectExactly(v + Vec3d.zero, v, "\(at) zero is the additive identity")

            // A unit vector has length one and points the same way as its source.
            let n = v.normalized
            Check.near(n.length, 1, 1e-15, "\(at) normalized has length 1")
            Check.near(n.dot(v), v.length, 1e-13, "\(at) normalized·v recovers the length")
            expect(n, Model.unit(model(v)), 1e-15, "\(at) normalize")
            // Direction, not just length: the cross with the original must vanish.
            Check.near(n.cross(v).length, 0, 1e-14, "\(at) normalized is parallel to v")
            // Scaling a vector does not change its direction.
            expect(v.scaled(7).normalized, model(n), 1e-15, "\(at) normalize is scale-invariant")
        }

        // The axis cross products, which fix the handedness of the whole frame. Any
        // swapped component or flipped sign in `cross` changes one of these six.
        let x = Vec3d(1, 0, 0), y = Vec3d(0, 1, 0), z = Vec3d(0, 0, 1)
        expectExactly(x.cross(y), z, "x̂ × ŷ = ẑ")
        expectExactly(y.cross(z), x, "ŷ × ẑ = x̂")
        expectExactly(z.cross(x), y, "ẑ × x̂ = ŷ")
        // Written out rather than as `-z`, because negating `(0,0,1)` gives `(−0,−0,−1)`
        // and a cross product produces `+0` in those slots.
        expectExactly(y.cross(x), Vec3d(0, 0, -1), "ŷ × x̂ = −ẑ")
        expectExactly(z.cross(y), Vec3d(-1, 0, 0), "ẑ × ŷ = −x̂")
        expectExactly(x.cross(z), Vec3d(0, -1, 0), "x̂ × ẑ = −ŷ")
        Check.bitEq(x.dot(y), 0, "x̂ · ŷ = 0")
        Check.bitEq(x.dot(x), 1, "x̂ · x̂ = 1")

        // The default initialiser is the zero vector, and `zero` is that value.
        Check.ok(Vec3d() == Vec3d.zero, "Vec3d() is the zero vector")
        Check.ok(Vec3d.zero == Vec3d(0, 0, 0), "Vec3d.zero is (0,0,0)")
    }

    // MARK: - Vec3d under rotation

    /// The laws a rotation obeys, over the edge vectors as well as random ones.
    private static func vectorLaws() {
        let rng = Rng(seed: 0x0A11_CE)

        var vectors = edgeVectors
        for _ in 0..<200 {
            vectors.append(Vec3d(rng.range(-20, 20), rng.range(-20, 20), rng.range(-20, 20)))
        }
        var quats = edgeQuats
        for _ in 0..<200 {
            let axis = Vec3d(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalized
            quats.append(Quatd.fromAxisAngle(axis, rng.range(-Double.pi, Double.pi)))
        }

        for (i, v) in vectors.enumerated() {
            // A tolerance in the units of the vector: these are absolute checks, and one
            // of the edge vectors is 1e8 on a side.
            let tol = 1e-13 * Swift.max(1, v.length)
            for (j, q) in quats.enumerated() {
                let at = "v\(i) q\(j)"
                let rotated = v.applying(q)

                // A rotation preserves length.
                Check.near(rotated.length, v.length, tol, "\(at) rotation preserves length")

                // Rotating by `q` and then by its conjugate is the identity — the
                // conjugate really is the inverse rotation.
                let back = rotated.applying(q.conjugated)
                expect(back, model(v), tol, "\(at) conjugate undoes the rotation")

                // `q` and `−q` are the same rotation.
                let negated = Quatd(-q.x, -q.y, -q.z, -q.w)
                expect(v.applying(negated), model(rotated), tol, "\(at) −q rotates like q")
            }
        }

        // A rotation is linear and preserves the inner product, so it preserves angles
        // and areas as well as lengths.
        for i in 0..<200 {
            let a = Vec3d(rng.range(-20, 20), rng.range(-20, 20), rng.range(-20, 20))
            let b = Vec3d(rng.range(-20, 20), rng.range(-20, 20), rng.range(-20, 20))
            let s = rng.range(-4, 4)
            let axis = Vec3d(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalized
            let q = Quatd.fromAxisAngle(axis, rng.range(-Double.pi, Double.pi))
            let at = "linearity \(i)"

            let ra = a.applying(q), rb = b.applying(q)
            expect((a + b).applying(q), model(ra + rb), 1e-12, "\(at) rotation is additive")
            expect(a.scaled(s).applying(q), model(ra.scaled(s)), 1e-12, "\(at) rotation is homogeneous")
            Check.near(ra.dot(rb), a.dot(b), 1e-11, "\(at) rotation preserves dot")
            // Handedness: a rotation is orientation-preserving, so it commutes with the
            // cross product. A mirror would pass every check above and fail this one.
            expect(a.cross(b).applying(q), model(ra.cross(rb)), 1e-11, "\(at) rotation preserves cross")
            // The axis of the rotation is the one direction it leaves alone.
            expect(axis.applying(q), model(axis), 1e-14, "\(at) the axis is invariant")
        }
    }

    // MARK: - Quatd, closed forms

    private static func quaternionClosedForms() {
        let rng = Rng(seed: 0xC0FF_EE01)

        for i in 0..<300 {
            let raw = Quatd(
                rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2))
            let at = "quat \(i)"

            Check.bitEq(raw.lengthSq, raw.dot(raw), "\(at) lengthSq is q·q")
            Check.bitEq(raw.length, raw.lengthSq.squareRoot(), "\(at) length is sqrt(lengthSq)")
            Check.near(raw.length, Model.len4(model(raw)), 1e-14, "\(at) length matches the model")

            // The conjugate flips the vector part and leaves the scalar, so it is its own
            // inverse and it preserves length.
            let c = raw.conjugated
            expectExactly(c, Quatd(-raw.x, -raw.y, -raw.z, raw.w), "\(at) conjugate flips xyz only")
            expectExactly(c.conjugated, raw, "\(at) conjugation is an involution")
            Check.bitEq(c.length, raw.length, "\(at) conjugation preserves length")

            // Normalising gives a unit quaternion pointing the same way — same rotation,
            // and the same sign, which matters because `−q` is the same rotation but not
            // the same four numbers.
            let n = raw.normalized
            Check.near(n.length, 1, 1e-15, "\(at) normalized has length 1")
            Check.near(n.dot(raw), raw.length, 1e-14, "\(at) normalized·q recovers the length")
            expect(n, Model.normalized(model(raw)), 1e-15, "\(at) normalize matches the model")
            Check.ok(n.w * raw.w >= 0, "\(at) normalize preserves the sign of w")
            // Idempotent: normalising a unit quaternion changes nothing measurable.
            expect(n.normalized, model(n), 1e-15, "\(at) normalize is idempotent")

            // The mutating form and the computed property are the same operation.
            var mutated = raw
            mutated.normalize()
            expectExactly(mutated, n, "\(at) normalize() and normalized agree")

            // A unit quaternion times its conjugate is the identity.
            let product = n * n.conjugated
            expect(product, (v: (0, 0, 0), w: 1), 1e-14, "\(at) q·q* is identity")
        }

        // Exact norms: components that square and sum exactly.
        Check.bitEq(Quatd(0.5, 0.5, 0.5, 0.5).length, 1, "(½,½,½,½) is exactly unit")
        Check.bitEq(Quatd(0, 0, 0, 1).length, 1, "identity is exactly unit")
        Check.bitEq(Quatd(0, 3, 0, 4).length, 5, "(0,3,0,4) has length exactly 5")
        Check.bitEq(Quatd(1, 2, 2, 4).length, 5, "(1,2,2,4) has length exactly 5")

        // The default initialiser is the identity rotation, not the zero quaternion — a
        // zero-initialised quaternion would rotate every vector to nothing.
        Check.ok(Quatd() == Quatd.identity, "Quatd() is the identity rotation")
        Check.ok(Quatd.identity == Quatd(0, 0, 0, 1), "Quatd.identity is (0,0,0,1)")
    }

    // MARK: - applying, against the matrix model

    /// `applying` against a rotation matrix built two independent ways.
    private static func rotationAgainstTheModel() {
        let rng = Rng(seed: 0xB0DE_1234)

        for i in 0..<300 {
            let axis = Vec3d(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalized
            let angle = rng.range(-Double.pi, Double.pi)
            let q = Quatd.fromAxisAngle(axis, angle)
            let v = Vec3d(rng.range(-20, 20), rng.range(-20, 20), rng.range(-20, 20))
            let at = "model \(i)"
            let tol = 1e-12 * Swift.max(1, v.length)

            // Against Rodrigues' formula, which involves no quaternion at all. This is the
            // check that pins `fromAxisAngle` and `applying` together against geometry
            // rather than against each other.
            expect(
                v.applying(q), Model.rotate(axis: model(axis), angle: angle, model(v)),
                tol, "\(at) applying matches Rodrigues")

            // Against the quaternion's rotation matrix, which is the same map written as
            // nine numbers rather than as two cross products.
            expect(v.applying(q), Model.apply(model(q), model(v)), tol, "\(at) applying matches the matrix")

            // The conjugate rotates by the negated angle about the same axis.
            expect(
                v.applying(q.conjugated),
                Model.rotate(axis: model(axis), angle: -angle, model(v)),
                tol, "\(at) the conjugate rotates by −angle")

            // The matrix of a rotation is orthonormal: its columns are the images of the
            // axes, and they stay unit and mutually perpendicular.
            let cx = Vec3d(1, 0, 0).applying(q)
            let cy = Vec3d(0, 1, 0).applying(q)
            let cz = Vec3d(0, 0, 1).applying(q)
            Check.near(cx.length, 1, 1e-14, "\(at) the image of x̂ is unit")
            Check.near(cy.length, 1, 1e-14, "\(at) the image of ŷ is unit")
            Check.near(cz.length, 1, 1e-14, "\(at) the image of ẑ is unit")
            Check.near(cx.dot(cy), 0, 1e-14, "\(at) the images of x̂ and ŷ stay perpendicular")
            Check.near(cx.dot(cz), 0, 1e-14, "\(at) the images of x̂ and ẑ stay perpendicular")
            Check.near(cy.dot(cz), 0, 1e-14, "\(at) the images of ŷ and ẑ stay perpendicular")
            expect(cx.cross(cy), model(cz), 1e-14, "\(at) the image frame is right-handed")

            // The rotation angle recovered from the image of a perpendicular vector is the
            // angle that went in, with the right sign about the axis.
            let perp = axis.cross(Vec3d(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1))).normalized
            let turned = perp.applying(q)
            Check.near(
                Foundation.acos(Swift.min(1, Swift.max(-1, perp.dot(turned)))), abs(angle), 1e-11,
                "\(at) the rotation turns by |angle|")
            Check.ok(
                perp.cross(turned).dot(axis) * angle >= -1e-12,
                "\(at) the rotation turns the right way about its axis")
        }
    }

    // MARK: - the rotations that are exact

    /// Rotations whose answers are integers, asserted to the bit.
    ///
    /// A half turn about an axis has quaternion components of exactly 0 and 1, so every
    /// product in `applying` is exact and the result is the input with two signs flipped.
    /// These catch a swapped component or a dropped term that a tolerance-based check on
    /// random data could only catch statistically.
    private static func exactRotations() {
        let rng = Rng(seed: 0x1234_5678)
        var vectors = [Vec3d(1, 2, 3), Vec3d(-7.5, 0.25, 11), Vec3d(1e8, -3, 1e-9)]
        for _ in 0..<100 {
            vectors.append(Vec3d(rng.range(-20, 20), rng.range(-20, 20), rng.range(-20, 20)))
        }

        for (i, v) in vectors.enumerated() {
            let at = "exact \(i)"
            expectExactly(v.applying(.identity), v, "\(at) identity leaves v alone")
            expectExactly(
                v.applying(Quatd(1, 0, 0, 0)), Vec3d(v.x, -v.y, -v.z),
                "\(at) a half turn about x̂")
            expectExactly(
                v.applying(Quatd(0, 1, 0, 0)), Vec3d(-v.x, v.y, -v.z),
                "\(at) a half turn about ŷ")
            expectExactly(
                v.applying(Quatd(0, 0, 1, 0)), Vec3d(-v.x, -v.y, v.z),
                "\(at) a half turn about ẑ")
            // (½,½,½,½) is the 120° turn about (1,1,1)/√3, which cycles the axes
            // x̂ → ŷ → ẑ → x̂. The products are halves of the components, so the answer is
            // a permutation — to a tolerance rather than to the bit, because the sums do
            // cancel and `v` here spans seventeen orders of magnitude.
            let tol = 1e-15 * Swift.max(1, abs(v.x) + abs(v.y) + abs(v.z))
            expect(
                v.applying(Quatd(0.5, 0.5, 0.5, 0.5)), (v.z, v.x, v.y), tol,
                "\(at) the 120° turn about (1,1,1) cycles the axes")
            expect(
                v.applying(Quatd(-0.5, -0.5, -0.5, 0.5)), (v.y, v.z, v.x), tol,
                "\(at) its inverse cycles them the other way")
        }
    }

    // MARK: - fromAxisAngle

    private static func axisAngle() {
        let rng = Rng(seed: 0x9E37_79B9)

        // The degenerate and half-turn cases, where the answer is forced.
        expectExactly(Quatd.fromAxisAngle(Vec3d(1, 0, 0), 0), .identity, "a zero-angle turn is identity")
        expectExactly(
            Quatd.fromAxisAngle(Vec3d(0, 1, 0), 0), .identity, "a zero-angle turn about ŷ is identity")
        for (name, axis) in [("x̂", Vec3d(1, 0, 0)), ("ŷ", Vec3d(0, 1, 0)), ("ẑ", Vec3d(0, 0, 1))] {
            // A half turn: sin(π/2) is exactly 1 and cos(π/2) is 6.1e-17, not 0, so the
            // scalar part is asserted as small rather than as zero.
            let half = Quatd.fromAxisAngle(axis, Double.pi)
            expect(half, (v: model(axis), w: 0), 1e-15, "a half turn about \(name)")
            // A full turn is −identity: the same rotation, the other representative.
            let full = Quatd.fromAxisAngle(axis, 2 * Double.pi)
            expect(full, (v: (0, 0, 0), w: -1), 1e-15, "a full turn about \(name) is −identity")
        }

        for i in 0..<300 {
            let axis = Vec3d(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalized
            let a = rng.range(-Double.pi, Double.pi)
            let b = rng.range(-Double.pi, Double.pi)
            let at = "axisAngle \(i)"

            let qa = Quatd.fromAxisAngle(axis, a)
            Check.near(qa.length, 1, 1e-15, "\(at) a unit axis gives a unit quaternion")
            expect(qa, Model.axisAngle(model(axis), a), 1e-15, "\(at) matches the model")

            // The scalar part is the cosine of the half angle, so the angle is recoverable.
            Check.near(2 * Foundation.acos(Swift.min(1, Swift.max(-1, qa.w))), abs(a), 1e-11,
                "\(at) the half-angle convention holds")
            // The vector part points along the axis, with the sign of the angle.
            Check.near(qa.x * axis.y - qa.y * axis.x, 0, 1e-15, "\(at) the vector part is along the axis")
            Check.ok(qa.dot(Quatd(axis.x, axis.y, axis.z, 0)) * a >= -1e-15,
                "\(at) the vector part carries the sign of the angle")

            // Turns about one axis add: this is the property that would break if the
            // half-angle were dropped or doubled.
            let composed = Quatd.fromAxisAngle(axis, b) * qa
            expectSameRotation(
                composed, model(Quatd.fromAxisAngle(axis, a + b)), 1e-14,
                "\(at) turns about a shared axis add")
            // Turning the other way is the inverse rotation: sine is odd and cosine even,
            // so negating the angle negates the vector part and leaves the scalar — which
            // is the conjugate.
            expect(
                Quatd.fromAxisAngle(axis, -a), model(qa.conjugated), 1e-16,
                "\(at) the negated angle gives the conjugate")
            // Negating the axis instead does the same thing, for the same reason.
            expect(
                Quatd.fromAxisAngle(-axis, a), model(qa.conjugated), 1e-15,
                "\(at) the negated axis gives the conjugate")
        }
    }

    // MARK: - multiplication

    private static func multiplication() {
        let rng = Rng(seed: 0x7FFF_FFFF)

        for i in 0..<300 {
            let qs = (0..<3).map { _ -> Quatd in
                let axis = Vec3d(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalized
                return Quatd.fromAxisAngle(axis, rng.range(-Double.pi, Double.pi))
            }
            let (a, b, c) = (qs[0], qs[1], qs[2])
            let v = Vec3d(rng.range(-20, 20), rng.range(-20, 20), rng.range(-20, 20))
            let at = "multiply \(i)"

            // Against Hamilton's product in scalar-and-vector form.
            expect(a * b, Model.mul(model(a), model(b)), 1e-15, "\(at) matches Hamilton's product")

            // The identity is an identity on both sides, exactly: every term it
            // contributes is a multiply by 1 or by 0.
            expectExactly(a * .identity, a, "\(at) right identity")
            expectExactly(Quatd.identity * a, a, "\(at) left identity")

            // Associative, and multiplicative in the norm.
            expect((a * b) * c, model(a * (b * c)), 1e-14, "\(at) multiplication is associative")
            Check.near((a * b).length, a.length * b.length, 1e-14, "\(at) the norm is multiplicative")

            // The composition rule that decides the argument order everywhere else in the
            // sim: applying `a * b` is applying `b` and then `a`.
            expect(
                v.applying(a * b), model(v.applying(b).applying(a)), 1e-12,
                "\(at) a·b applies b first, then a")

            // The conjugate of a product reverses the order.
            expect((a * b).conjugated, model(b.conjugated * a.conjugated), 1e-15,
                "\(at) (ab)* = b*a*")

            // `premultiplied(by:)` is the other order, and nothing else.
            expectExactly(a.premultiplied(by: b), b * a, "\(at) premultiplied(by: b) is b·a")
            expectExactly(b.premultiplied(by: a), a * b, "\(at) premultiplied is not commutative")

            // Quaternion multiplication does not commute, and a suite that never noticed
            // would accept an implementation that had lost the cross-product term.
            let forward = a * b, backward = b * a
            let gap = abs(forward.x - backward.x) + abs(forward.y - backward.y)
                + abs(forward.z - backward.z)
            Check.ok(gap > 1e-9, "\(at) a·b differs from b·a")
        }
    }

    // MARK: - fromUnitVectors

    private static func fromUnitVectors() {
        let rng = Rng(seed: 0xDEAD_BEEF)
        var antiparallelSeen = 0
        var nearParallelSeen = 0

        for i in 0..<300 {
            let from = Vec3d(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalized
            let to = Vec3d(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalized
            let at = "fromUnitVectors \(i)"

            let q = Quatd.fromUnitVectors(from, to)
            Check.near(q.length, 1, 1e-15, "\(at) the result is unit")
            // What the function is for: it carries `from` onto `to`.
            expect(from.applying(q), model(to), 1e-14, "\(at) carries from onto to")
            expect(q, Model.fromUnitVectors(model(from), model(to)), 1e-13, "\(at) matches the model")

            // It is the *shortest* such rotation: it turns in the plane of the two
            // vectors, so their common perpendicular is left alone. Any rotation with an
            // extra twist about `to` would still carry `from` onto `to` and fail this.
            let perp = from.cross(to).normalized
            expect(perp.applying(q), model(perp), 1e-14, "\(at) the common perpendicular is fixed")

            // Reversing the arguments inverts the rotation.
            expectSameRotation(
                Quatd.fromUnitVectors(to, from), model(q.conjugated), 1e-13,
                "\(at) swapping the arguments conjugates")
        }

        // The identity case, and the antiparallel branch, which is the one that decides
        // which way a disc settles onto the ground.
        for (name, from) in [
            ("x̂", Vec3d(1, 0, 0)), ("ŷ", Vec3d(0, 1, 0)), ("ẑ", Vec3d(0, 0, 1)),
            ("−x̂", Vec3d(-1, 0, 0)), ("(1,1,1)", Vec3d(1, 1, 1).normalized),
            ("(1,0,1)", Vec3d(1, 0, 1).normalized), ("(0.3,0.4,0.5)", Vec3d(0.3, 0.4, 0.5).normalized),
            ("(-0.6,0.1,0.2)", Vec3d(-0.6, 0.1, 0.2).normalized),
        ] {
            let same = Quatd.fromUnitVectors(from, from)
            Check.near(same.length, 1, 1e-15, "\(name) onto itself is unit")
            expect(same, (v: (0, 0, 0), w: 1), 1e-14, "\(name) onto itself is the identity")
            nearParallelSeen += 1

            let flipped = -from
            let half = Quatd.fromUnitVectors(from, flipped)
            antiparallelSeen += 1
            Check.near(half.length, 1, 1e-15, "\(name) onto its opposite is unit")
            // A half turn: the scalar part is zero, so the rotation is exactly 180°.
            Check.near(half.w, 0, 1e-15, "\(name) onto its opposite is a half turn")
            // About an axis perpendicular to `from`, which is the only thing that makes
            // it carry `from` onto `−from`.
            Check.near(
                Vec3d(half.x, half.y, half.z).dot(from), 0, 1e-15,
                "\(name): the fallback axis is perpendicular to from")
            expect(from.applying(half), model(flipped), 1e-14, "\(name) onto its opposite lands")
            // Which perpendicular, specifically: three.js takes `ẑ × from` when
            // |from.x| > |from.z| and `x̂ × from` otherwise, and the other choice is a
            // different — equally valid, visibly different — rotation.
            expect(
                half, Model.fromUnitVectors(model(from), model(flipped)), 1e-14,
                "\(name): the fallback picks three.js's axis")
        }

        Check.ok(antiparallelSeen >= 8, "the antiparallel branch is exercised")
        Check.ok(nearParallelSeen >= 8, "the parallel case is exercised")
    }

    // MARK: - fromBasis

    private static func fromBasis() {
        let rng = Rng(seed: 0x5150_1234)
        // Shepperd's method has four branches — one per candidate largest component —
        // and a suite that only ever landed in the first would miss three quarters of it.
        var branchHits = [0, 0, 0, 0]

        var rotations: [(axis: Vec3d, angle: Double)] = [
            (Vec3d(1, 0, 0), 0),  // identity: trace 3, the trace branch
            (Vec3d(1, 0, 0), Double.pi),  // trace −1, m11 largest
            (Vec3d(0, 1, 0), Double.pi),  // trace −1, m22 largest
            (Vec3d(0, 0, 1), Double.pi),  // trace −1, m33 largest
        ]
        for _ in 0..<300 {
            let axis = Vec3d(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalized
            rotations.append((axis, rng.range(-Double.pi, Double.pi)))
        }

        for (i, r) in rotations.enumerated() {
            let at = "fromBasis \(i)"
            // The basis comes from Rodrigues rather than from `applying`, so the
            // expectation does not depend on the code under test.
            let mx = Model.rotate(axis: model(r.axis), angle: r.angle, (1, 0, 0))
            let my = Model.rotate(axis: model(r.axis), angle: r.angle, (0, 1, 0))
            let mz = Model.rotate(axis: model(r.axis), angle: r.angle, (0, 0, 1))

            let trace = mx.x + my.y + mz.z
            if trace > 0 {
                branchHits[0] += 1
            } else if mx.x > my.y && mx.x > mz.z {
                branchHits[1] += 1
            } else if my.y > mz.z {
                branchHits[2] += 1
            } else {
                branchHits[3] += 1
            }

            let q = Quatd.fromBasis(v3(mx), v3(my), v3(mz))
            Check.near(q.length, 1, 1e-14, "\(at) an orthonormal basis gives a unit quaternion")

            // The specification of `makeBasis`: the quaternion rotates the world axes onto
            // the three basis vectors, in order. Column, not row — a transposed
            // implementation gives the inverse rotation and passes every length check.
            expect(Vec3d(1, 0, 0).applying(q), mx, 1e-13, "\(at) x̂ maps onto the first axis")
            expect(Vec3d(0, 1, 0).applying(q), my, 1e-13, "\(at) ŷ maps onto the second axis")
            expect(Vec3d(0, 0, 1).applying(q), mz, 1e-13, "\(at) ẑ maps onto the third axis")

            // And it is the same rotation the axis and angle describe, up to sign.
            expectSameRotation(
                q, Model.axisAngle(model(r.axis), r.angle), 1e-13,
                "\(at) recovers the rotation that built the basis")
        }

        for (i, hits) in branchHits.enumerated() {
            Check.ok(hits > 0, "fromBasis branch \(i) is exercised (\(hits) cases)")
        }
    }

    // MARK: - slerp

    private static func slerp() {
        let rng = Rng(seed: 0x51E8_9000)
        var geodesicPath = 0
        var lerpPath = 0

        // Pairs spread across the branch boundary on purpose: separations from a
        // whole turn down to a microradian, so both the geodesic path and the
        // lerp-then-normalise path above a 0.9995 dot are exercised, and so is the
        // neighbourhood of the threshold itself.
        var pairs: [(Quatd, Quatd)] = []
        for _ in 0..<200 {
            let axisA = Vec3d(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalized
            let a = Quatd.fromAxisAngle(axisA, rng.range(-Double.pi, Double.pi))
            let axisB = Vec3d(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalized
            let b = Quatd.fromAxisAngle(axisB, rng.range(-Double.pi, Double.pi))
            pairs.append((a, b))
        }
        for separation in [3.0, 1.0, 0.3, 0.1, 0.0632, 0.0628, 0.0624, 0.02, 1e-3, 1e-6, 0.0] {
            for _ in 0..<10 {
                let axisA = Vec3d(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalized
                let a = Quatd.fromAxisAngle(axisA, rng.range(-Double.pi, Double.pi))
                let axisB = Vec3d(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalized
                let b = Quatd.fromAxisAngle(axisB, separation) * a
                pairs.append((a, b))
            }
        }

        let ts = [0.0, 0.125, 0.25, 0.5, 0.75, 0.875, 1.0]

        for (i, pair) in pairs.enumerated() {
            let (a, b) = pair
            let at = "slerp \(i)"
            let dot = abs(a.dot(b))
            if dot < 0.9995 { geodesicPath += 1 } else { lerpPath += 1 }

            for t in ts {
                let got = a.slerped(to: b, t)

                // The result is always a rotation. The lerp path only reaches this by
                // normalising afterwards, which is exactly the step that gets dropped.
                Check.near(got.length, 1, 1e-14, "\(at) t=\(t) result is unit")

                // Against the model — which reproduces the branch, because above a
                // 0.9995 dot the production code computes a different function.
                expect(got, Model.slerp(model(a), model(b), t), 1e-12, "\(at) t=\(t) matches the model")

                // Constant angular velocity along the geodesic: the angle travelled is
                // `t` of the total. Only asserted on the geodesic path — the lerp path is
                // an approximation to it and deliberately does not obey this exactly.
                //
                // Stated as a chord rather than as an angle: `acos` near 1 is
                // ill-conditioned enough that the `t = 0` case alone would read as a 4e-8
                // error in a function that returned its argument untouched.
                if dot < 0.9995 {
                    let total = 2 * Foundation.acos(Swift.min(1, dot))
                    Check.near(
                        abs(a.dot(got)), Foundation.cos(t * total / 2), 1e-12,
                        "\(at) t=\(t) travels t of the arc")
                }

                // Never the long way round: the result stays on the near side of both
                // endpoints, which is what the `dot < 0` flip is for.
                Check.ok(abs(a.dot(got)) >= dot - 1e-12, "\(at) t=\(t) stays on the short arc")
            }

            // The endpoints. On the geodesic path they are exact — the weights come out as
            // exactly 1 and exactly 0 — and on the lerp path they are a renormalisation
            // away, which for a unit input is an ulp.
            if dot < 0.9995 {
                expectExactly(a.slerped(to: b, 0), a, "\(at) t=0 is exactly the start")
                let signedEnd = a.dot(b) < 0 ? Quatd(-b.x, -b.y, -b.z, -b.w) : b
                expectExactly(a.slerped(to: b, 1), signedEnd, "\(at) t=1 is exactly the end")
            } else {
                expect(a.slerped(to: b, 0), model(a), 1e-15, "\(at) t=0 is the start")
                expectSameRotation(a.slerped(to: b, 1), model(b), 1e-15, "\(at) t=1 is the end")
            }

            // The midpoint bisects: it is equidistant from both ends.
            let mid = a.slerped(to: b, 0.5)
            Check.near(abs(a.dot(mid)), abs(b.dot(mid)), 1e-11, "\(at) the midpoint bisects the arc")

            // `−b` is the same rotation as `b`, and slerp must treat it as one — that is
            // the whole point of the shortest-arc flip.
            let negated = Quatd(-b.x, -b.y, -b.z, -b.w)
            for t in ts {
                expectSameRotation(
                    a.slerped(to: negated, t), model(a.slerped(to: b, t)), 1e-13,
                    "\(at) t=\(t) slerping to −b matches slerping to b")
            }

            // Slerping onto itself goes nowhere.
            expect(a.slerped(to: a, 0.37), model(a), 1e-15, "\(at) slerp to self is a no-op")
        }

        Check.ok(geodesicPath > 50, "the geodesic path is exercised (\(geodesicPath) pairs)")
        Check.ok(lerpPath > 20, "the lerp-then-normalise path is exercised (\(lerpPath) pairs)")

        // The threshold itself. A pair separated by just under the branch angle takes the
        // lerp path, one just over takes the geodesic path, and the two must agree to
        // within the approximation error of the lerp — about θ³/48, which is 2e-7 here.
        // A moved threshold shows up as a discontinuity larger than that.
        let base = Quatd.fromAxisAngle(Vec3d(0.3, 0.5, 0.8).normalized, 0.7)
        let axis = Vec3d(-0.6, 0.5, 0.2).normalized
        // cos(θ/2) = 0.9995 at θ = 0.06325 rad.
        let below = Quatd.fromAxisAngle(axis, 0.0630) * base
        let above = Quatd.fromAxisAngle(axis, 0.0635) * base
        Check.ok(abs(base.dot(below)) >= 0.9995, "the 0.0630 rad pair is on the lerp side")
        Check.ok(abs(base.dot(above)) < 0.9995, "the 0.0635 rad pair is on the geodesic side")
        for t in ts {
            let lo = base.slerped(to: below, t)
            let hi = base.slerped(to: above, t)
            Check.near(
                abs(base.dot(lo)), Foundation.cos(t * 0.0630 / 2), 1e-7,
                "t=\(t) the lerp path tracks the arc it approximates")
            Check.near(
                abs(base.dot(hi)), Foundation.cos(t * 0.0635 / 2), 1e-12,
                "t=\(t) the geodesic path is exact across the threshold")
        }
    }

    // MARK: - the documented exceptions

    /// The three places where this math deliberately does not do the textbook thing.
    private static func theDocumentedExceptions() {
        // three.js divides by `length || 1`, so the zero vector normalises to zero rather
        // than to NaN. The flight derivative relies on it: the disc is momentarily at rest
        // at the top of a float, and a NaN there poisons the rest of the integration.
        let zero = Vec3d.zero.normalized
        Check.ok(zero == Vec3d.zero, "the zero vector normalises to zero, not NaN")
        Check.ok(zero.x.isFinite && zero.y.isFinite && zero.z.isFinite, "and it stays finite")

        // The same guard on the quaternion side falls back to identity rather than to
        // zero — a zero quaternion would rotate every vector to nothing.
        var collapsed = Quatd(0, 0, 0, 0)
        collapsed.normalize()
        Check.ok(collapsed == Quatd.identity, "a collapsed quaternion falls back to identity")
        Check.ok(Quatd(0, 0, 0, 0).normalized == Quatd.identity, "and so does the computed form")
        expectExactly(
            Vec3d(1, 2, 3).applying(Quatd(0, 0, 0, 0).normalized), Vec3d(1, 2, 3),
            "so a collapsed quaternion rotates nothing")

        // `length` is `sqrt(x²+y²+z²)`, not `hypot`. That is the bit-exact choice — `sqrt`
        // is correctly rounded and `hypot` is not specified to the last ulp by any libm —
        // and the price is that the sum of squares can overflow where `hypot` would not.
        // Nothing in the sim comes within thirty orders of magnitude of this; it is here
        // so the trade is asserted rather than assumed.
        let huge = Vec3d(1e200, 1e200, 1e200)
        Check.ok(huge.lengthSq.isInfinite, "the sum of squares overflows at 1e200")
        Check.ok(huge.length.isInfinite, "and so does the length")
        Check.ok(huge.normalized == Vec3d.zero, "so a 1e200 vector normalises to zero")
        // Well inside that, it behaves: 1e8 on a side is the largest magnitude any
        // fixture ever used.
        let big = Vec3d(1e8, -1e8, 1e8)
        Check.near(big.length, 1e8 * 3.0.squareRoot(), 1e-7, "1e8 on a side is fine")
        Check.near(big.normalized.length, 1, 1e-15, "and normalises to a unit vector")
        // The same trade at the small end, where it bites a great deal sooner than at the
        // large one: squaring halves the exponent range, so components below about 1e-154
        // square into the denormals and lose precision, and below about 1e-162 they
        // underflow to zero outright — at which point the `length || 1` guard returns the
        // vector unchanged rather than a unit vector. `hypot` would scale first and get
        // all three right. Nothing in the sim is within a hundred orders of magnitude of
        // this either; it is asserted for the same reason as the overflow above.
        let tiny = Vec3d(1e-9, 0, 0)
        // Not bit-exact even here: `1e-9` is not a binary fraction, so squaring and
        // square-rooting it does not return the same double.
        Check.near(tiny.normalized.x, 1, 1e-15, "a 1e-9 vector normalises to x̂")
        Check.near(
            Vec3d(1e-150, 2e-150, -2e-150).normalized.length, 1, 1e-15,
            "1e-150 still normalises exactly")
        Check.near(
            Vec3d(1e-160, 2e-160, -2e-160).normalized.length, 1, 1e-5,
            "1e-160 normalises to within 1e-5 — its squares are denormal")
        let underflowed = Vec3d(1e-165, 2e-165, -2e-165)
        Check.bitEq(underflowed.lengthSq, 0, "1e-165 squares to exactly zero")
        expectExactly(
            underflowed.normalized, underflowed,
            "so the guard returns a 1e-165 vector unchanged rather than NaN")

        // `Vec3d` and `Quatd` are structs: a copy is a value, so a mutation cannot reach
        // back through an alias. The port's main bug class is code written against
        // three.js, where `DiscState.pos` is mutated through a reference.
        let original = Vec3d(1, 2, 3)
        var copy = original
        copy.x = 99
        Check.bitEq(original.x, 1, "mutating a copy of a Vec3d leaves the original alone")
        var q = Quatd(0, 0, 0, 1)
        let qCopy = q
        q.normalize()
        Check.ok(qCopy == Quatd.identity, "normalizing a Quatd does not reach through a copy")
    }
}
