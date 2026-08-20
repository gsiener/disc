import Foundation

/// Release conditions for the throws in the game. Ported from `src/sim/aero/Throws.ts`.
///
/// **Nothing here scripts a flight path.** Each entry sets only the six things a human
/// actually controls at release — how fast, how much spin, which way it spins, how far
/// it is banked about the flight axis, how the nose sits, and the launch elevation.
/// Every curve you see comes out of `DiscPhysics` afterwards.
///
/// `spinSign` is relative to the body normal (body +Z, out of the top plate):
///
///   −1  backhand-family grip — a right-handed backhand spins clockwise seen from
///       above, so angular velocity lies along −n
///   +1  forehand-family grip
///
/// **This is the axis that separates a backhand from a forehand**, and it is not the
/// bank angle. A forehand is the mirror of a backhand: opposite spin, so it turns and
/// fades the other way. Two throws with the same bank and opposite `spinSign` curve in
/// opposite directions, which is the whole point.
///
/// `invert` rolls the disc 180° about the flight axis at release, flipping the normal
/// to point downwards — that is what makes a hammer a hammer.
///
/// All signed quantities are mirrored for a left-handed thrower by `throwDisc`.
public enum ThrowType: String, CaseIterable, Sendable {
    case backhand, forehand, hammer, scoober, push, blade
}

public struct ThrowSpec: Sendable {
    /// Release speed range in m/s, lerped by `power` in [0,1].
    public let speed: (Double, Double)
    /// Spin rate range in rad/s, lerped by `spin` in [0,1].
    public let spin: (Double, Double)
    /// Sign of the spin about the body normal.
    public let spinSign: Double
    /// Bank about the flight axis at release, rad. Positive banks to the thrower's right.
    public let bank: Double

    /// Nose angle, rad. Positive is nose up.
    ///
    /// `planeRef` says what it is measured against: `.velocity` is the angle between the
    /// disc plane and the velocity vector — the "nose angle" players talk about on flat
    /// throws — while `.world` is the angle against the ground, because on an overhead
    /// the wrist sets the plane and the arm sets the direction.
    public let nose: Double
    public let planeRef: PlaneRef
    /// Launch elevation above horizontal, rad. The caller's `angle` adds to this.
    public let elevation: Double
    /// Release the disc upside down.
    public let invert: Bool
    /// Human-readable note for the HUD and debug overlay.
    public let about: String

    public enum PlaneRef: Sendable { case velocity, world }
}

/// The release conditions for one throw — **total by the compiler**, which the dictionary
/// below is not.
///
/// `THROW_SPECS[type]!` stood at four call sites in this file, and every one of them was
/// safe only because the literal happens to list all six cases of a six-case enum. That is
/// an unreachable runtime trap guarding a fact the type system can prove: a seventh throw
/// would compile and crash on release. The switch is the same table, checked where a
/// missing case is a build error instead of a crash mid-flight.
///
/// The dictionary is kept and derived from this, because it is public API and callers
/// enumerate it — a second copy of the numbers is exactly what this is avoiding.
public func throwSpec(_ type: ThrowType) -> ThrowSpec {
    switch type {
    case .backhand: return specBackhand
    case .forehand: return specForehand
    case .hammer: return specHammer
    case .scoober: return specScoober
    case .push: return specPush
    case .blade: return specBlade
    }
}

public let THROW_SPECS: [ThrowType: ThrowSpec] = Dictionary(
    uniqueKeysWithValues: ThrowType.allCases.map { ($0, throwSpec($0)) })

private let specBackhand = ThrowSpec(
    speed: (12, 27), spin: (38, 62), spinSign: -1, bank: 0, nose: -0.02,
    planeRef: .velocity, elevation: 0.10, invert: false,
    about: "Flat power throw. Turns over slightly while fast, fades back to the left as it slows."
)
private let specForehand = ThrowSpec(
    speed: (11, 25), spin: (34, 56), spinSign: 1, bank: -0.04, nose: 0.0,
    planeRef: .velocity, elevation: 0.10, invert: false,
    about: "Mirror of the backhand: opposite spin, so it turns and fades the other way."
)
private let specHammer = ThrowSpec(
    speed: (16, 27), spin: (30, 50), spinSign: 1, bank: 0, nose: 0.12,
    planeRef: .world, elevation: 0.68, invert: true,
    about: "Overhead, upside down. Inverted lift pulls it over the top and it drops hard and left."
)
private let specScoober = ThrowSpec(
    speed: (10, 18), spin: (26, 44), spinSign: -1, bank: 0.70, nose: 0.08,
    planeRef: .world, elevation: 0.34, invert: true,
    about: "Upside-down backhand grip. Short, breaks the opposite way to a hammer."
)
private let specPush = ThrowSpec(
    speed: (7, 14), spin: (20, 34), spinSign: 1, bank: 0, nose: 0.02,
    planeRef: .velocity, elevation: 0.10, invert: false,
    about: "Chest-height dump. Low speed, low spin, dies quickly."
)
private let specBlade = ThrowSpec(
    speed: (15, 26), spin: (34, 54), spinSign: 1, bank: 1.30, nose: 0.02,
    planeRef: .velocity, elevation: 0.55, invert: false,
    about: "Thrown on edge. Almost no vertical lift, so it knifes sideways and falls out of the sky."
)

// The reference writes the `[0,1]` clamp out longhand in each of these three functions
// and also exports it as `clamp01` from `move/Attributes.ts`. Swift has one namespace
// per module, so here they are the same function — see `Move/Attributes.swift`. The
// ternary is identical, so this is a naming change and not a numeric one.

/// Release speed in m/s for a normalised power in [0,1].
public func throwSpeed(_ type: ThrowType, _ power: Double) -> Double {
    let s = throwSpec(type).speed
    return s.0 + (s.1 - s.0) * clamp01(power)
}

/// Normalised power in [0,1] that produces `speed` m/s. Inverse of `throwSpeed`.
public func powerForSpeed(_ type: ThrowType, _ speed: Double) -> Double {
    let s = throwSpec(type).speed
    return clamp01((speed - s.0) / (s.1 - s.0))
}

/// Unsigned spin rate in rad/s for a normalised spin in [0,1].
public func throwSpinRate(_ type: ThrowType, _ spin: Double) -> Double {
    let s = throwSpec(type).spin
    return s.0 + (s.1 - s.0) * clamp01(spin)
}

// MARK: - building a release state

public struct ThrowOptions: Sendable {
    /// `.right` (default) or `.left`. Mirrors spin sign and bank.
    public var hand: Hand = .right
    /// Extra bank about the flight axis, rad. Positive banks to the thrower's right.
    /// This is how you make an inside-out or outside-in throw.
    public var bank: Double = 0
    /// Extra nose angle relative to the velocity, rad. Positive is nose up.
    public var nose: Double = 0
    /// Ground height under the throw.
    public var groundY: Double = 0
    /// Absolute release speed in m/s, overriding the `power` lerp.
    ///
    /// This exists for the pull and should stay that way. A pull is the one throw in the
    /// sport taken with a run-up and a full body rotation rather than from a standing
    /// pivot with a mark in your face, and it is genuinely faster than anything in the
    /// table: the backhand tops out at 27 m/s and a pull that reaches the far endzone
    /// needs about 32. Widening the backhand's range instead would hand that speed to
    /// every throw in a possession, which is not the same claim.
    public var speed: Double? = nil

    public enum Hand: Sendable { case right, left }
    public var sign: Double { hand == .left ? -1 : 1 }

    public init() {}
}

/// Build the release state for a throw.
///
/// - Parameters:
///   - type: which throw
///   - from: release position, world
///   - aim: aim direction; only the horizontal part sets the heading
///   - power: 0…1 across the throw's speed range
///   - angle: extra launch elevation in radians, added to the throw's own
///   - spin: 0…1 across the throw's spin range
public func throwDisc(
    _ type: ThrowType,
    from: Vec3d,
    aim: Vec3d,
    power: Double,
    angle: Double = 0,
    spin: Double = 0.5,
    options opts: ThrowOptions = ThrowOptions()
) -> DiscState {
    let spec = throwSpec(type)
    let hand = opts.sign

    var s = DiscState()
    s.throwType = type
    s.handed = Int(hand)
    s.groundY = opts.groundY

    // Heading: horizontal projection of the aim.
    var heading = Vec3d(aim.x, 0, aim.z)
    if heading.lengthSq < 1e-10 { heading = Vec3d(0, 0, 1) }
    heading = heading.normalized

    let elev = spec.elevation + angle
    var vdir = heading.scaled(simCos(elev))
    vdir.y += simSin(elev)
    vdir = vdir.normalized

    // Release frame. `right` is the thrower's right looking down the aim.
    let right = heading.cross(Vec3d(0, 1, 0)).normalized
    let upPerp = right.cross(vdir).normalized

    let nose = spec.nose + opts.nose
    // Bank is measured in the disc's own frame, so positive always means "the lift
    // vector leans to the thrower's right" and therefore always curves right — upside
    // down or not. Turning the disc over would otherwise silently reverse the control.
    let bank = (spec.bank + opts.bank) * hand * (spec.invert ? -1 : 1)

    // Nose up tips the normal backwards. On a flat throw that is measured off the
    // velocity; on an overhead the wrist sets the plane against the ground.
    var normal: Vec3d
    if spec.planeRef == .world {
        normal = Vec3d(0, 1, 0).scaled(simCos(nose))
            .addingScaled(heading, -simSin(nose))
    } else {
        normal = upPerp.scaled(simCos(nose))
            .addingScaled(vdir, -simSin(nose))
    }
    // Turning the disc over is literally that: the same plane, other face up.
    if spec.invert { normal = -normal }
    normal = normal.applying(Quatd.fromAxisAngle(vdir, bank)).normalized

    // Body frame: +X along the in-plane flight direction, +Z the normal.
    var bodyX = vdir.addingScaled(normal, -vdir.dot(normal))
    if bodyX.lengthSq < 1e-10 { bodyX = right }
    bodyX = bodyX.normalized

    // The reference's `makeBasis` + `setFromRotationMatrix`, exactly. This was a
    // two-`setFromUnitVectors` shortcut for most of the port's life — "equivalent",
    // and it was, to 5e-15, except when the rotated +X landed antiparallel to `bodyX`:
    // there `fromUnitVectors` takes its arbitrary-axis fallback and returns a different
    // valid rotation, so a huck aimed straight down the -x axis released with a tilted
    // frame and metres of lateral drift the reference did not have.
    let bodyY = normal.cross(bodyX).normalized
    s.orient = Quatd.fromBasis(bodyX, bodyY, normal).normalized

    s.pos = from
    s.vel = vdir.scaled(opts.speed ?? throwSpeed(type, power))
    s.omega = Vec3d(0, 0, spec.spinSign * hand * throwSpinRate(type, spin))

    refreshDerived(&s, wind: .zero)
    return s
}
