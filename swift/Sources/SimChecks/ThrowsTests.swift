import Foundation
import UltimateSim

/// The throw table and `throwDisc`, against the geometry they claim to build.
///
/// # How this suite knows what is right
///
/// `throwDisc` scripts no flight. It sets the six things a human controls at release —
/// how fast, how much spin, which way it spins, how far it is banked about the flight
/// axis, how the nose sits, and the launch elevation — and everything after that is
/// `DiscPhysics`. So the release state is pure geometry, and geometry can be checked
/// without ever having run the function:
///
///  - **Closed forms.** The angle of attack at release is the nose angle, by definition
///    of "nose angle" — and bank is a rotation *about the velocity*, so it cannot move
///    the angle of attack at all. The signed spin about the normal is `spinSign × hand ×
///    rate`, because the body angular velocity is `(0, 0, rate)` and body +Z *is* the
///    normal. Airspeed at release is the release speed. The speed and spin lerps are
///    affine, so a midpoint is the midpoint of the endpoints. None of these needs a
///    recorded number to state.
///  - **Two symmetries of the whole flight, not just the release.** A left-handed throw
///    is the exact mirror of the right-handed one through the vertical plane containing
///    the aim — that is what "handedness mirrors the spin sign *and* the bank" means, and
///    it is the assertion that would have caught the mistake in this file's history: the
///    flight view once shipped presets that varied only the bank angle and so could not
///    express a forehand at all. And a throw aimed along any heading is the throw aimed
///    along +Z, rotated about the vertical — the sim has no preferred compass direction
///    in still air. Both are asserted on the integrated trajectory out to eight seconds,
///    where a sign error anywhere in the release frame has had time to become metres.
///  - **`Model`** — `throwDisc`'s geometry written a second time, deliberately in a
///    different shape. The release normal is reached by the closed form `ŷ cos θ −
///    û sin θ` rather than through two cross products and a projection; the bank is
///    Rodrigues' formula on plain triples rather than a quaternion; and the orientation
///    is checked by rotating the three body axes and comparing them to the frame, rather
///    than by rebuilding a quaternion from a basis. Same geometry, different expression
///    trees, so a slip in one is not mirrored in the other.
///  - **Exact-value pins for the table itself.** Six throws × ten fields. A relation is
///    the right assertion for a law and the wrong one for a tuning number: "a push is
///    slower than a backhand" stays true while the push's speed range moves. The speeds,
///    spins, banks, noses and elevations in `Throws.swift` are somebody's decision about
///    how the sport feels, and the only thing that can hold them is the number.
///
/// The prose in `Throws.swift` makes physical claims — a scoober breaks opposite to a
/// hammer, a blade knifes sideways and falls out of the sky, a push dies quickly. Those
/// are asserted too, as flown behaviour, because a table whose comments have quietly
/// stopped describing the throws is worse than one with no comments.
enum ThrowsTests {

    // MARK: - tolerances

    /// The `Model` comparison of a release state. Every quantity is of order 0.01–60, and
    /// both sides are a handful of transcendentals and IEEE-exact arithmetic, so this is
    /// thirteen or more digits of agreement.
    static let releaseTol = 1e-13

    /// A closed form recovered through `atan2`, `sqrt` and a quaternion round trip —
    /// alpha, spin, airspeed. One decade looser than `releaseTol` for the extra rounding.
    static let derivedTol = 1e-12

    /// The two flight symmetries, compared on positions after up to eight seconds of
    /// RK4 at 120 Hz. Measured worst case across the sweep below is ~5e-13; the budget
    /// is 1e-10, which is still nine decades under the millimetre at which a real sign
    /// error would show.
    static let symmetryTol = 1e-10

    // MARK: - the throw table, by exact value

    /// One row of `THROW_SPECS`, transcribed from `Throws.swift` with its meaning.
    ///
    /// `spinSign` is the field that separates a backhand from a forehand, and `bank` is
    /// the one that does not — see this file's header.
    struct Row {
        let type: ThrowType
        let speedLo: Double
        let speedHi: Double
        let spinLo: Double
        let spinHi: Double
        let spinSign: Double
        let bank: Double
        let nose: Double
        let planeRef: ThrowSpec.PlaneRef
        let elevation: Double
        let invert: Bool
    }

    static let rows: [Row] = [
        // The flat power throw. Nose very slightly down, released just above horizontal,
        // backhand-family spin: clockwise seen from above, so along −n.
        Row(type: .backhand, speedLo: 12, speedHi: 27, spinLo: 38, spinHi: 62,
            spinSign: -1, bank: 0, nose: -0.02, planeRef: .velocity, elevation: 0.10,
            invert: false),
        // The mirror: opposite spin sign, and a touch of bank the other way.
        Row(type: .forehand, speedLo: 11, speedHi: 25, spinLo: 34, spinHi: 56,
            spinSign: 1, bank: -0.04, nose: 0.0, planeRef: .velocity, elevation: 0.10,
            invert: false),
        // Overhead and upside down — `invert`, and a plane measured against the GROUND
        // because on an overhead the wrist sets the plane and the arm sets the direction.
        Row(type: .hammer, speedLo: 16, speedHi: 27, spinLo: 30, spinHi: 50,
            spinSign: 1, bank: 0, nose: 0.12, planeRef: .world, elevation: 0.68,
            invert: true),
        // Also inverted, also world-referenced, but backhand-family spin and heavily
        // banked — which is what makes it break the opposite way to a hammer.
        Row(type: .scoober, speedLo: 10, speedHi: 18, spinLo: 26, spinHi: 44,
            spinSign: -1, bank: 0.70, nose: 0.08, planeRef: .world, elevation: 0.34,
            invert: true),
        // The chest-height dump: the slowest speeds and the lowest spin in the table.
        Row(type: .push, speedLo: 7, speedHi: 14, spinLo: 20, spinHi: 34,
            spinSign: 1, bank: 0, nose: 0.02, planeRef: .velocity, elevation: 0.10,
            invert: false),
        // Thrown on edge: 1.30 rad of bank is most of a right angle, which is why it has
        // almost no vertical lift.
        Row(type: .blade, speedLo: 15, speedHi: 26, spinLo: 34, spinHi: 54,
            spinSign: 1, bank: 1.30, nose: 0.02, planeRef: .velocity, elevation: 0.55,
            invert: false),
    ]

    // MARK: - the specification, implemented independently

    /// `throwDisc`'s geometry, written a second time and in a different shape.
    ///
    /// Nothing in here constructs a `Quatd` or calls `Vec3d`. Vectors are plain triples,
    /// the release normal comes out of a closed form rather than out of cross products,
    /// and the bank is Rodrigues' formula rather than a quaternion conjugation.
    enum Model {
        typealias V = (x: Double, y: Double, z: Double)

        static func add(_ a: V, _ b: V) -> V { (a.x + b.x, a.y + b.y, a.z + b.z) }
        static func scale(_ a: V, _ s: Double) -> V { (a.x * s, a.y * s, a.z * s) }
        static func dot(_ a: V, _ b: V) -> Double { a.x * b.x + a.y * b.y + a.z * b.z }
        static func cross(_ a: V, _ b: V) -> V {
            (a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
        }
        static func unit(_ a: V) -> V { scale(a, 1 / dot(a, a).squareRoot()) }

        /// Rodrigues' rotation of `v` about unit `k` by `angle`.
        static func rotate(_ v: V, about k: V, by angle: Double) -> V {
            let c = Foundation.cos(angle)
            let s = Foundation.sin(angle)
            return add(
                add(scale(v, c), scale(cross(k, v), s)),
                scale(k, dot(k, v) * (1 - c)))
        }

        /// The release frame: the flight direction, the disc normal, and the two body
        /// axes, all as a function of the heading angle and the four release angles.
        ///
        /// The normal is the whole point of writing this out again. `Throws.swift` builds
        /// it as `upPerp·cos ν − vdir·sin ν`, where `upPerp` is `right × vdir` and `right`
        /// is `heading × ŷ`. That composition collapses: `upPerp` is `ŷ cos E − û sin E`,
        /// so tilting it back by `ν` in the same plane just adds the two angles, and the
        /// whole thing is `ŷ cos(E + ν) − û sin(E + ν)`. World-referenced, `E` is not in
        /// it at all — the wrist sets the plane against the ground — so the same
        /// expression with `E = 0`.
        static func frame(
            heading h: Double, elevation E: Double, nose ν: Double,
            planeRef: ThrowSpec.PlaneRef, invert: Bool, bank β: Double
        ) -> (u: V, vdir: V, right: V, normal: V, bodyX: V, bodyY: V) {
            let u: V = (Foundation.sin(h), 0, Foundation.cos(h))
            let vdir: V = (u.x * Foundation.cos(E), Foundation.sin(E), u.z * Foundation.cos(E))
            let right: V = (-Foundation.cos(h), 0, Foundation.sin(h))

            let θ = planeRef == .velocity ? E + ν : ν
            var n: V = (
                -u.x * Foundation.sin(θ), Foundation.cos(θ), -u.z * Foundation.sin(θ))
            if invert { n = scale(n, -1) }
            n = unit(rotate(n, about: unit(vdir), by: β))

            let along = dot(vdir, n)
            let bodyX = unit(add(vdir, scale(n, -along)))
            let bodyY = unit(cross(n, bodyX))
            return (u, unit(vdir), right, n, bodyX, bodyY)
        }

        /// The angle of attack a release must have, in closed form.
        ///
        /// Velocity-referenced, the nose angle IS the angle between the plane and the
        /// velocity, so alpha is the nose angle. World-referenced, the plane is set
        /// against the ground while the velocity is `E` above it, so the angle between
        /// them is `ν − E`. Turning the disc over negates the normal and so negates the
        /// angle. Bank appears nowhere: it is a rotation about the velocity, which cannot
        /// change the angle between the plane and the velocity.
        static func alpha(
            elevation E: Double, nose ν: Double, planeRef: ThrowSpec.PlaneRef, invert: Bool
        ) -> Double {
            let a = planeRef == .velocity ? ν : ν - E
            return invert ? -a : a
        }
    }

    // MARK: - entry point

    static func run() throws {
        table()
        lerps()
        modelAgreement()
        closedForms()
        options()
        headingDegenerate()
        handMirror()
        headingEquivariance()
        vocabularyAndPhysics()
    }

    // MARK: - the table

    /// Every field of every throw spec, pinned to its value.
    private static func table() {
        Check.eq(rows.count, ThrowType.allCases.count, "every throw type is pinned")
        Check.eq(
            Set(rows.map(\.type)).count, rows.count, "no throw type is pinned twice")
        Check.eq(THROW_SPECS.count, ThrowType.allCases.count, "THROW_SPECS is total")

        for r in rows {
            let s = throwSpec(r.type)
            let at = r.type.rawValue
            Check.bitEq(s.speed.0, r.speedLo, "\(at) slowest release, m/s")
            Check.bitEq(s.speed.1, r.speedHi, "\(at) fastest release, m/s")
            Check.bitEq(s.spin.0, r.spinLo, "\(at) lowest spin rate, rad/s")
            Check.bitEq(s.spin.1, r.spinHi, "\(at) highest spin rate, rad/s")
            Check.bitEq(
                s.spinSign, r.spinSign,
                "\(at) spins \(r.spinSign < 0 ? "backhand" : "forehand")-family about "
                    + "the body normal — this, not the bank, is what separates the two")
            Check.bitEq(s.bank, r.bank, "\(at) release bank about the flight axis, rad")
            Check.bitEq(s.nose, r.nose, "\(at) nose angle, rad")
            Check.bitEq(s.elevation, r.elevation, "\(at) launch elevation, rad")
            Check.ok(s.planeRef == r.planeRef, "\(at) measures its nose against \(r.planeRef)")
            Check.eq(s.invert, r.invert, "\(at) is released \(r.invert ? "upside down" : "flat")")

            // Speeds and spins are ranges, and a transposed pair would still fly.
            Check.ok(s.speed.0 < s.speed.1, "\(at) speed range runs low to high")
            Check.ok(s.spin.0 < s.spin.1, "\(at) spin range runs low to high")

            // The dictionary is derived from the switch. If it ever became a second copy
            // of the numbers, this is where the copies would diverge.
            guard let d = THROW_SPECS[r.type] else {
                Check.ok(false, "\(at) is in THROW_SPECS")
                continue
            }
            Check.bitEq(d.speed.0, s.speed.0, "\(at) THROW_SPECS speed lo matches throwSpec")
            Check.bitEq(d.speed.1, s.speed.1, "\(at) THROW_SPECS speed hi matches throwSpec")
            Check.bitEq(d.spin.0, s.spin.0, "\(at) THROW_SPECS spin lo matches throwSpec")
            Check.bitEq(d.spin.1, s.spin.1, "\(at) THROW_SPECS spin hi matches throwSpec")
            Check.bitEq(d.spinSign, s.spinSign, "\(at) THROW_SPECS spin sign matches throwSpec")
            Check.bitEq(d.bank, s.bank, "\(at) THROW_SPECS bank matches throwSpec")
            Check.bitEq(d.nose, s.nose, "\(at) THROW_SPECS nose matches throwSpec")
            Check.bitEq(d.elevation, s.elevation, "\(at) THROW_SPECS elevation matches throwSpec")
            Check.eq(d.invert, s.invert, "\(at) THROW_SPECS invert matches throwSpec")
            Check.ok(d.planeRef == s.planeRef, "\(at) THROW_SPECS planeRef matches throwSpec")

            // The HUD reads `about`. A label is not a description of a throw.
            Check.ok(s.about.count > 40, "\(at) carries a description, not a label")
        }
    }

    // MARK: - the lerps

    /// `throwSpeed`, `throwSpinRate` and `powerForSpeed` are affine maps on a clamped
    /// input, which is a complete specification and needs no recorded value.
    private static func lerps() {
        for type in ThrowType.allCases {
            let s = throwSpec(type)
            let at = type.rawValue

            // Endpoints are exact: `lo + (hi − lo) · 0` and `lo + (hi − lo) · 1`.
            Check.bitEq(throwSpeed(type, 0), s.speed.0, "\(at): zero power is the speed floor")
            Check.bitEq(throwSpeed(type, 1), s.speed.1, "\(at): full power is the speed ceiling")
            Check.bitEq(throwSpinRate(type, 0), s.spin.0, "\(at): zero spin is the spin floor")
            Check.bitEq(throwSpinRate(type, 1), s.spin.1, "\(at): full spin is the spin ceiling")

            // Clamped, not extrapolated — an out-of-range power is a caller's bug, not a
            // faster disc.
            for t in [-5.0, -1e-9, 1 + 1e-9, 5.0, .infinity, -.infinity] {
                let wantSpeed = t > 0.5 ? s.speed.1 : s.speed.0
                let wantSpin = t > 0.5 ? s.spin.1 : s.spin.0
                Check.bitEq(throwSpeed(type, t), wantSpeed, "\(at): speed clamps at \(t)")
                Check.bitEq(throwSpinRate(type, t), wantSpin, "\(at): spin clamps at \(t)")
                Check.inRange(
                    powerForSpeed(type, s.speed.0 + (s.speed.1 - s.speed.0) * t), 0, 1,
                    "\(at): powerForSpeed clamps into [0,1] at \(t)")
            }

            for i in 0...40 {
                let t = Double(i) / 40
                let u = Double(40 - i) / 40

                // Affine: the map of a midpoint is the midpoint of the maps.
                Check.near(
                    throwSpeed(type, (t + u) / 2),
                    (throwSpeed(type, t) + throwSpeed(type, u)) / 2, 1e-13,
                    "\(at): speed is affine in power at \(t)")
                Check.near(
                    throwSpinRate(type, (t + u) / 2),
                    (throwSpinRate(type, t) + throwSpinRate(type, u)) / 2, 1e-13,
                    "\(at): spin rate is affine at \(t)")

                // The range is exactly the declared range, and monotone within it.
                Check.inRange(throwSpeed(type, t), s.speed.0, s.speed.1, "\(at): speed in band")
                Check.inRange(throwSpinRate(type, t), s.spin.0, s.spin.1, "\(at): spin in band")
                if i > 0 {
                    let prev = Double(i - 1) / 40
                    Check.ok(
                        throwSpeed(type, t) > throwSpeed(type, prev),
                        "\(at): more power is strictly more speed at \(t)")
                    Check.ok(
                        throwSpinRate(type, t) > throwSpinRate(type, prev),
                        "\(at): more spin is strictly more spin rate at \(t)")
                }

                // `powerForSpeed` is declared the inverse of `throwSpeed`, both ways round.
                Check.near(
                    powerForSpeed(type, throwSpeed(type, t)), t, 1e-14,
                    "\(at): powerForSpeed inverts throwSpeed at \(t)")
                let speed = s.speed.0 + (s.speed.1 - s.speed.0) * t
                Check.near(
                    throwSpeed(type, powerForSpeed(type, speed)), speed, 1e-13,
                    "\(at): throwSpeed inverts powerForSpeed at \(speed) m/s")
            }
        }
    }

    // MARK: - the release state, against the model

    /// The sweep the whole file rests on: every throw, both hands, across power, spin,
    /// launch angle, bank and nose, compared field by field against `Model`.
    private static func modelAgreement() {
        let headings = [0.0, 0.9, -2.4]
        let powers = [0.0, 0.3, 1.0]
        let spins = [0.0, 0.62, 1.0]
        let angles = [-0.30, 0.0, 0.45]
        let banks = [-0.5, 0.0, 0.25]
        let noses = [-0.15, 0.0, 0.20]

        for type in ThrowType.allCases {
            let spec = throwSpec(type)
            for handed in [ThrowOptions.Hand.right, .left] {
                let hand: Double = handed == .left ? -1 : 1
                for h in headings {
                    for power in powers {
                        for spinT in spins {
                            for angle in angles {
                                for bank in banks {
                                    for nose in noses {
                                        var opts = ThrowOptions()
                                        opts.hand = handed
                                        opts.bank = bank
                                        opts.nose = nose
                                        opts.groundY = 0.37
                                        let from = Vec3d(3, 1.6, -2)
                                        let s = throwDisc(
                                            type, from: from,
                                            aim: Vec3d(Foundation.sin(h), 0, Foundation.cos(h)),
                                            power: power, angle: angle, spin: spinT,
                                            options: opts)

                                        let E = spec.elevation + angle
                                        let ν = spec.nose + nose
                                        let β = (spec.bank + bank) * hand * (spec.invert ? -1 : 1)
                                        let f = Model.frame(
                                            heading: h, elevation: E, nose: ν,
                                            planeRef: spec.planeRef, invert: spec.invert,
                                            bank: β)
                                        let speed = throwSpeed(type, power)
                                        let rate = throwSpinRate(type, spinT)

                                        let at =
                                            "\(type.rawValue)/\(handed)/h\(h)/p\(power)/"
                                            + "s\(spinT)/a\(angle)/b\(bank)/n\(nose)"

                                        // Position and ground pass straight through.
                                        Check.bitEq(s.pos.x, from.x, "\(at): release x")
                                        Check.bitEq(s.pos.y, from.y, "\(at): release y")
                                        Check.bitEq(s.pos.z, from.z, "\(at): release z")
                                        Check.bitEq(s.groundY, 0.37, "\(at): ground under the throw")
                                        Check.eq(s.handed, Int(hand), "\(at): handedness recorded")
                                        Check.ok(s.throwType == type, "\(at): throw type recorded")

                                        // Velocity is the flight direction times the speed.
                                        near(s.vel, Model.scale(f.vdir, speed), releaseTol,
                                            "\(at): release velocity")
                                        // Angular velocity is in the BODY frame, about +Z.
                                        Check.near(s.omega.x, 0, 0, "\(at): no body-x spin")
                                        Check.near(s.omega.y, 0, 0, "\(at): no body-y spin")
                                        Check.bitEq(
                                            s.omega.z, spec.spinSign * hand * rate,
                                            "\(at): body-z spin is spinSign × hand × rate")

                                        // The orientation, checked by what it does to the
                                        // three body axes rather than by rebuilding it.
                                        near(
                                            Vec3d(0, 0, 1).applying(s.orient), f.normal,
                                            releaseTol, "\(at): body +Z is the disc normal")
                                        near(
                                            Vec3d(1, 0, 0).applying(s.orient), f.bodyX,
                                            releaseTol, "\(at): body +X is the in-plane flight axis")
                                        near(
                                            Vec3d(0, 1, 0).applying(s.orient), f.bodyY,
                                            releaseTol, "\(at): body +Y completes the frame")
                                        let q = s.orient
                                        Check.near(
                                            (q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w)
                                                .squareRoot(),
                                            1, 1e-15, "\(at): the release orientation is a unit rotation")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - closed forms on the derived quantities

    /// The three derived fields `refreshDerived` fills in at release, each of which has a
    /// closed form the release geometry forces.
    private static func closedForms() {
        for type in ThrowType.allCases {
            let spec = throwSpec(type)
            for handed in [ThrowOptions.Hand.right, .left] {
                let hand: Double = handed == .left ? -1 : 1
                for power in [0.0, 0.4, 1.0] {
                    for spinT in [0.0, 0.5, 1.0] {
                        for angle in [-0.25, 0.0, 0.33] {
                            for bank in [-0.6, 0.0, 0.8] {
                                for nose in [-0.1, 0.0, 0.17] {
                                    var opts = ThrowOptions()
                                    opts.hand = handed
                                    opts.bank = bank
                                    opts.nose = nose
                                    let s = throwDisc(
                                        type, from: Vec3d(0, 1.6, 0), aim: Vec3d(0.4, 0, 1),
                                        power: power, angle: angle, spin: spinT, options: opts)
                                    let at =
                                        "\(type.rawValue)/\(handed)/p\(power)/s\(spinT)/"
                                        + "a\(angle)/b\(bank)/n\(nose)"

                                    // Airspeed at release is the release speed: still air,
                                    // and the disc is not yet moving relative to it.
                                    Check.near(
                                        s.airspeed, throwSpeed(type, power), derivedTol,
                                        "\(at): airspeed at release is the release speed")

                                    // Signed spin about the normal. Body +Z is the normal,
                                    // so rotating `(0,0,rate)` into the world and dotting
                                    // it with the normal returns the rate itself.
                                    Check.near(
                                        s.spin, spec.spinSign * hand * throwSpinRate(type, spinT),
                                        derivedTol,
                                        "\(at): spin about the normal is spinSign × hand × rate")

                                    // THE ANGLE OF ATTACK IS THE NOSE ANGLE, and bank does
                                    // not appear — a rotation about the velocity cannot
                                    // change the angle between the plane and the velocity.
                                    // `bank` is swept above precisely so that this claim
                                    // is tested rather than assumed.
                                    Check.near(
                                        s.alpha,
                                        Model.alpha(
                                            elevation: spec.elevation + angle,
                                            nose: spec.nose + nose,
                                            planeRef: spec.planeRef, invert: spec.invert),
                                        derivedTol,
                                        "\(at): alpha at release is the nose angle, bank-independent")
                                }
                            }
                        }
                    }
                }
            }

            // `invert` is what makes a hammer a hammer: the disc leaves the hand with its
            // top plate pointing at the ground.
            let s = throwDisc(
                type, from: Vec3d(0, 1.6, 0), aim: Vec3d(0, 0, 1),
                power: 0.6, angle: 0, spin: 0.5)
            let n = Vec3d(0, 0, 1).applying(s.orient)
            Check.eq(
                n.y < 0, spec.invert,
                "\(type.rawValue): the release normal points \(spec.invert ? "down" : "up")")
        }
    }

    // MARK: - the options

    /// Each `ThrowOptions` field does the one thing it says it does.
    private static func options() {
        let from = Vec3d(0, 1.6, 0)
        let aim = Vec3d(0, 0, 1)

        for type in ThrowType.allCases {
            let at = type.rawValue

            // `speed` is an absolute override and `power` stops mattering. This is the
            // pull's escape hatch from the table's own band, and the solver's.
            for want in [3.0, 9.0, 22.5, 32.0] {
                for power in [0.0, 0.5, 1.0] {
                    var opts = ThrowOptions()
                    opts.speed = want
                    let s = throwDisc(
                        type, from: from, aim: aim, power: power, angle: 0, spin: 0.5,
                        options: opts)
                    Check.near(
                        s.vel.length, want, 1e-13,
                        "\(at): an absolute release speed of \(want) overrides power \(power)")
                }
            }

            // `groundY` is carried into the state, untouched.
            for g in [-1.5, 0.0, 2.25] {
                var opts = ThrowOptions()
                opts.groundY = g
                let s = throwDisc(
                    type, from: from, aim: aim, power: 0.5, angle: 0, spin: 0.5, options: opts)
                Check.bitEq(s.groundY, g, "\(at): ground height \(g) reaches the state")
            }

            // `angle` adds to the throw's own elevation, which is a statement about the
            // velocity's climb: `vy / |v| = sin(spec.elevation + angle)`.
            for angle in [-0.4, -0.1, 0.0, 0.2, 0.7] {
                let s = throwDisc(
                    type, from: from, aim: aim, power: 0.8, angle: angle, spin: 0.5)
                Check.near(
                    s.vel.y / s.vel.length,
                    Foundation.sin(throwSpec(type).elevation + angle), 1e-14,
                    "\(at): angle \(angle) adds to the spec's own launch elevation")
            }

            // `bank` tilts the lift vector to the thrower's right by exactly that many
            // radians, and handedness mirrors it. Stated on a throw trimmed to zero angle
            // of attack, where the un-banked normal is perpendicular to the velocity and
            // the rotation is therefore a clean sine in the `right` direction. That trim
            // is `nose = 0` on a velocity-referenced throw and `nose = elevation` on a
            // world-referenced one, which is the same closed form `Model.alpha` states.
            let spec = throwSpec(type)
            let flatNose = spec.planeRef == .velocity ? 0 : spec.elevation
            for handed in [ThrowOptions.Hand.right, .left] {
                let hand: Double = handed == .left ? -1 : 1
                for bank in [-0.5, -0.2, 0.0, 0.3, 0.6] {
                    var opts = ThrowOptions()
                    opts.hand = handed
                    opts.nose = flatNose - spec.nose
                    opts.bank = bank - spec.bank
                    let s = throwDisc(
                        type, from: from, aim: aim, power: 0.7, angle: 0, spin: 0.5,
                        options: opts)
                    let n = Vec3d(0, 0, 1).applying(s.orient)
                    // `right` for a +Z aim is −x̂ (see `Model.frame`). **`invert` flips
                    // the plate but not the control**, and this is where that claim is
                    // cashed: `Throws.swift` negates the bank for an inverted throw, and
                    // it has to, because turning the disc over also negates the axis the
                    // bank leans about. The two negations cancel, so the same closed form
                    // holds for a hammer as for a backhand — which is exactly what
                    // "positive always curves right, upside down or not" means.
                    let toRight = -n.x
                    Check.near(
                        toRight, Foundation.sin(bank * hand), 1e-13,
                        "\(at)/\(handed): bank \(bank) leans the disc that far to the right")
                    Check.near(
                        s.alpha, 0, derivedTol,
                        "\(at)/\(handed): bank \(bank) leaves the angle of attack alone")
                }
            }
        }
    }

    /// A straight-up aim has no heading in it, and the fallback is +Z rather than a NaN.
    private static func headingDegenerate() {
        for type in ThrowType.allCases {
            for aim in [Vec3d(0, 1, 0), Vec3d(0, -3, 0), Vec3d.zero, Vec3d(1e-6, 5, 0)] {
                let s = throwDisc(
                    type, from: Vec3d(0, 1.6, 0), aim: aim, power: 0.5, angle: 0, spin: 0.5)
                let elev = throwSpec(type).elevation
                Check.ok(s.isFinite, "\(type.rawValue): a vertical aim \(aim) still releases")
                Check.near(
                    s.vel.z / s.vel.length, Foundation.cos(elev), 1e-9,
                    "\(type.rawValue): a vertical aim \(aim) falls back to +Z")
                Check.near(
                    s.vel.x / s.vel.length, 0, 1e-9,
                    "\(type.rawValue): a vertical aim \(aim) has no lateral component")
            }

            // Only the horizontal part of the aim sets the heading — its length and its
            // vertical component are ignored entirely.
            let a = throwDisc(
                type, from: Vec3d(0, 1.6, 0), aim: Vec3d(0.6, 0, 0.8),
                power: 0.5, angle: 0, spin: 0.5)
            let b = throwDisc(
                type, from: Vec3d(0, 1.6, 0), aim: Vec3d(60, -17, 80),
                power: 0.5, angle: 0, spin: 0.5)
            near(a.vel, (b.vel.x, b.vel.y, b.vel.z), 1e-14,
                "\(type.rawValue): only the horizontal direction of the aim matters")
        }
    }

    // MARK: - the two symmetries

    /// A LEFT-HANDED THROW IS THE MIRROR OF THE RIGHT-HANDED ONE, all the way to the grass.
    ///
    /// This is the assertion that would have caught the preset mistake in this file's
    /// history. Handedness mirrors the spin sign *and* the bank, and getting exactly one
    /// of those two mirrors wrong leaves a release that still looks plausible and a flight
    /// that curves the wrong way — which is invisible to any right-handed-only check and
    /// to any assertion that only asks which side of the aim line the disc ended up on.
    ///
    /// The mirror plane is the vertical plane containing the aim: distance along the aim
    /// and height are preserved, lateral offset negates.
    private static func handMirror() {
        for type in ThrowType.allCases {
            for h in [0.0, 0.7, -2.1] {
                for power in [0.0, 0.55, 1.0] {
                    for extraBank in [-0.3, 0.0, 0.4] {
                        let ux = Foundation.sin(h), uz = Foundation.cos(h)
                        let aim = Vec3d(ux, 0, uz)
                        func release(_ hand: ThrowOptions.Hand) -> DiscState {
                            var o = ThrowOptions()
                            o.hand = hand
                            o.bank = extraBank
                            return throwDisc(
                                type, from: Vec3d(0, 1.6, 0), aim: aim,
                                power: power, angle: 0.05, spin: 0.5, options: o)
                        }
                        var r = release(.right)
                        var l = release(.left)
                        let at = "\(type.rawValue)/h\(h)/p\(power)/bank\(extraBank)"

                        // The spin sign is the first half of the mirror.
                        Check.near(
                            r.spin, -l.spin, derivedTol,
                            "\(at): the two hands spin exactly opposite")
                        // …and the angle of attack is untouched by it, since the mirror
                        // plane contains the velocity.
                        Check.near(r.alpha, l.alpha, derivedTol, "\(at): same angle of attack")
                        Check.near(
                            r.airspeed, l.airspeed, derivedTol, "\(at): same release speed")

                        func lat(_ v: Vec3d) -> Double { -v.x * uz + v.z * ux }
                        func along(_ v: Vec3d) -> Double { v.x * ux + v.z * uz }

                        for i in 0..<(120 * 8) {
                            r.step(dt: FIXED_DT)
                            l.step(dt: FIXED_DT)
                            guard (i + 1) % 120 == 0 else { continue }
                            let t = Double(i + 1) / 120
                            Check.near(
                                along(r.pos), along(l.pos), symmetryTol,
                                "\(at): t=\(t) both hands travel the same distance down the aim")
                            Check.near(
                                lat(r.pos), -lat(l.pos), symmetryTol,
                                "\(at): t=\(t) the two hands drift exactly opposite ways")
                            Check.near(
                                r.pos.y, l.pos.y, symmetryTol,
                                "\(at): t=\(t) both hands fly at the same height")
                            Check.eq(
                                r.atRest, l.atRest, "\(at): t=\(t) both hands land together")
                        }
                    }
                }
            }
        }
    }

    /// THE SIM HAS NO PREFERRED COMPASS DIRECTION. A throw aimed along any heading is the
    /// throw aimed along +Z, rotated about the vertical — release state and flight alike.
    ///
    /// In still air nothing in `throwDisc` or `DiscPhysics` may reference a world axis
    /// except "up", so this holds by construction and fails loudly if a hard-coded x or z
    /// ever creeps into the release frame. It is the reason a huck aimed down −x is not a
    /// special case, and the bug the `fromBasis` note in `Throws.swift` records — a
    /// two-`fromUnitVectors` shortcut that produced metres of lateral drift for exactly
    /// that aim — is precisely a violation of it.
    private static func headingEquivariance() {
        for type in ThrowType.allCases {
            for handed in [ThrowOptions.Hand.right, .left] {
                var base = throwDisc(
                    type, from: Vec3d(0, 1.6, 0), aim: Vec3d(0, 0, 1),
                    power: 0.85, angle: 0, spin: 0.5,
                    options: { var o = ThrowOptions(); o.hand = handed; return o }())

                var rotated: [(Double, DiscState)] = []
                for h in [0.5, 1.3, 2.9, -2.0, Double.pi] {
                    rotated.append(
                        (h,
                         throwDisc(
                            type, from: Vec3d(0, 1.6, 0),
                            aim: Vec3d(Foundation.sin(h), 0, Foundation.cos(h)),
                            power: 0.85, angle: 0, spin: 0.5,
                            options: { var o = ThrowOptions(); o.hand = handed; return o }())))
                }

                for i in 0..<(120 * 8) {
                    base.step(dt: FIXED_DT)
                    for j in rotated.indices { rotated[j].1.step(dt: FIXED_DT) }
                    guard (i + 1) % 120 == 0 else { continue }
                    let t = Double(i + 1) / 120
                    for (h, s) in rotated {
                        let c = Foundation.cos(h), sn = Foundation.sin(h)
                        let at = "\(type.rawValue)/\(handed)/h\(h) t=\(t)"
                        Check.near(
                            s.pos.x, base.pos.x * c + base.pos.z * sn, symmetryTol,
                            "\(at): x is the +Z throw rotated")
                        Check.near(
                            s.pos.z, -base.pos.x * sn + base.pos.z * c, symmetryTol,
                            "\(at): z is the +Z throw rotated")
                        Check.near(s.pos.y, base.pos.y, symmetryTol, "\(at): height is unchanged")
                        Check.eq(s.atRest, base.atRest, "\(at): lands at the same instant")
                    }
                }
            }
        }
    }

    // MARK: - the claims the table makes in prose

    /// Every physical claim `Throws.swift` makes about a throw, asserted as flown
    /// behaviour rather than left as a comment nobody can check.
    private static func vocabularyAndPhysics() {
        /// Fly to rest, and also hand back the RELEASE state.
        ///
        /// Both are needed and confusing them cost a round: `resolveGround` zeroes
        /// `omega` once the disc stops sliding, so the derived `spin` of a landed disc
        /// is 0 regardless of which way it was thrown. Spin claims must be read at
        /// release; travel claims at rest.
        func fly(_ type: ThrowType, hand: ThrowOptions.Hand = .right, power: Double = 1.0)
            -> (release: DiscState, rest: DiscState, apex: Double)
        {
            var opts = ThrowOptions()
            opts.hand = hand
            let released = throwDisc(
                type, from: Vec3d(0, 1.6, 0), aim: Vec3d(1, 0, 0),
                power: power, angle: 0, spin: 0.5, options: opts)
            var s = released
            var apex = s.pos.y
            for _ in 0..<(120 * 8) where !s.atRest {
                s.step(dt: FIXED_DT)
                apex = Swift.max(apex, s.pos.y)
            }
            return (released, s, apex)
        }

        // "Mirror of the backhand: opposite spin, so it turns and fades the other way."
        let bh = fly(.backhand)
        let fh = fly(.forehand)
        Check.ok(
            bh.release.spin < 0, "a right-handed backhand spins negative about the normal")
        Check.ok(
            fh.release.spin > 0, "a right-handed forehand spins positive about the normal")
        Check.ok(
            bh.rest.pos.z * fh.rest.pos.z < 0,
            "backhand and forehand fade to OPPOSITE sides "
                + "(\(bh.rest.pos.z) vs \(fh.rest.pos.z))")

        // Handedness mirrors both the spin sign and the bank. `handMirror` above states
        // this exactly; this is the human-readable form of the same fact.
        let bhLeft = fly(.backhand, hand: .left)
        Check.ok(bhLeft.release.spin > 0, "a left-handed backhand spins the other way")
        Check.ok(
            bh.rest.pos.z * bhLeft.rest.pos.z < 0,
            "left and right backhands fade to opposite sides")

        // "Short, breaks the opposite way to a hammer."
        let hammer = fly(.hammer)
        let scoober = fly(.scoober)
        Check.ok(
            hammer.rest.pos.z * scoober.rest.pos.z < 0,
            "a scoober breaks opposite to a hammer "
                + "(\(hammer.rest.pos.z) vs \(scoober.rest.pos.z))")
        Check.ok(
            Foundation.hypot(scoober.rest.pos.x, scoober.rest.pos.z)
                < Foundation.hypot(hammer.rest.pos.x, hammer.rest.pos.z),
            "a scoober is the shorter of the two overheads")

        // "Inverted lift pulls it over the top and it drops hard." The two throws top out
        // at the same 27 m/s, so this is not a speed claim — an upside-down disc makes
        // negative lift, which is what takes a hammer out of the sky early.
        Check.bitEq(
            throwSpeed(.hammer, 1), throwSpeed(.backhand, 1),
            "a hammer and a backhand leave the hand at the same top speed")
        Check.ok(
            Foundation.hypot(hammer.rest.pos.x, hammer.rest.pos.z)
                < Foundation.hypot(bh.rest.pos.x, bh.rest.pos.z),
            "…and the hammer still lands far shorter "
                + "(\(Foundation.hypot(hammer.rest.pos.x, hammer.rest.pos.z)) m vs "
                + "\(Foundation.hypot(bh.rest.pos.x, bh.rest.pos.z)) m)")
        Check.ok(
            throwSpec(.hammer).elevation > throwSpec(.backhand).elevation,
            "a hammer is thrown overhead, at a far steeper launch angle")

        // "Chest-height dump. Low speed, low spin, dies quickly."
        let push = fly(.push)
        Check.ok(
            Foundation.hypot(push.rest.pos.x, push.rest.pos.z)
                < Foundation.hypot(bh.rest.pos.x, bh.rest.pos.z),
            "a push travels less far than a backhand")
        Check.ok(
            abs(push.release.spin) < abs(bh.release.spin),
            "a push leaves the hand with less spin than a backhand")
        Check.ok(
            push.release.airspeed < bh.release.airspeed,
            "a push leaves the hand slower than a backhand")

        // "Thrown on edge. Almost no vertical lift, so it knifes sideways and falls out
        // of the sky." Both halves: sideways more than a backhand, and up less than one
        // despite leaving the hand at a far steeper angle.
        let blade = fly(.blade)
        Check.ok(
            abs(blade.rest.pos.z) > abs(bh.rest.pos.z),
            "a blade deviates sideways more than a backhand")
        Check.ok(
            throwSpec(.blade).elevation > throwSpec(.backhand).elevation,
            "a blade is launched at a steeper angle than a backhand")

        // HOW MUCH LIFT EACH THROW MAKES, measured rather than asserted by adjective.
        //
        // A disc with no aerodynamic lift at all is a thrown stone: it peaks
        // `vy² / 2g` above the hand. So the apex divided by that ballistic apex is a
        // direct reading of the lift, in units a reader has an opinion about — and it is
        // what turns the table's three prose claims into three separated numbers rather
        // than three vague ones. It also cannot be satisfied by a throw that merely goes
        // high: the elevation is divided back out.
        func liftRatio(_ type: ThrowType) -> Double {
            let f = fly(type)
            let vy = f.release.vel.y
            return (f.apex - 1.6) / (vy * vy / (2 * AeroCoeffs.standard.g))
        }
        // "Flat power throw" — a flat disc makes lift, and holds itself up for many times
        // the height its launch angle alone would buy.
        for type in [ThrowType.backhand, .forehand, .push] {
            let r = liftRatio(type)
            Check.ok(r > 2, "\(type.rawValue) flies well above its ballistic arc (×\(r))")
        }
        // "Almost no vertical lift" — a blade is thrown on edge, so it is very nearly the
        // thrown stone.
        Check.inRange(
            liftRatio(.blade), 0.7, 1.5,
            "a blade is on edge and flies a near-ballistic arc (×\(liftRatio(.blade)))")
        // "Inverted lift pulls it over the top" — negative lift, so an overhead peaks far
        // BELOW its ballistic arc.
        for type in [ThrowType.hammer, .scoober] {
            let r = liftRatio(type)
            Check.ok(r < 0.6, "\(type.rawValue) is pulled under its ballistic arc (×\(r))")
        }

        // Power is monotonic in distance for every throw. A spec with its speed range
        // transposed would still fly and would fail here.
        for type in ThrowType.allCases {
            let slow = fly(type, power: 0)
            let mid = fly(type, power: 0.5)
            let fast = fly(type, power: 1)
            let d = { (s: DiscState) in Foundation.hypot(s.pos.x, s.pos.z) }
            Check.ok(
                d(mid.rest) > d(slow.rest),
                "\(type.rawValue): half power goes further than none")
            Check.ok(
                d(fast.rest) > d(mid.rest),
                "\(type.rawValue): full power goes further than half")

            // And every throw in the table is a throw: it leaves the hand, it comes down,
            // and it stops. A spec that could not do that is not a throw.
            Check.ok(fast.rest.atRest, "\(type.rawValue): a full-power throw comes to rest")
            Check.ok(
                d(fast.rest) > 3, "\(type.rawValue): a full-power throw travels (\(d(fast.rest)) m)")
            Check.ok(fast.rest.touchedGround, "\(type.rawValue): a full-power throw lands")
        }
    }

    // MARK: - helpers

    private static func near(
        _ got: Vec3d, _ want: Model.V, _ tol: Double, _ what: String
    ) {
        Check.near(got.x, want.x, tol, "\(what).x")
        Check.near(got.y, want.y, tol, "\(what).y")
        Check.near(got.z, want.z, tol, "\(what).z")
    }
}
