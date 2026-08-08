import Foundation

/// Six-degree-of-freedom flight model for a 175 g disc. Ported from
/// `src/sim/DiscPhysics.ts`.
///
/// The disc is integrated as a rigid body with full rotational dynamics, not as a
/// ballistic arc with a lift fudge. That is what produces the behaviour the game is
/// actually about: a backhand that turns over at speed and fades as it slows, a hammer
/// that drops off the back end, a blade that knifes. All of it falls out of one
/// gyroscopic term — a pitching moment on a spinning disc becomes a *roll* ninety
/// degrees later — rather than being scripted per throw type.
///
/// State is carried as a flat 13-vector for the integrator:
///
///     0..2   position
///     3..5   velocity
///     6..9   orientation quaternion (x, y, z, w)
///     10..12 angular velocity, BODY frame
///
/// and it is `Double` throughout. See `SimMath` for why that is not negotiable.

public let FIXED_DT = 1.0 / 120.0

/// Which face is up and how the disc was released. Informational only — the physics
/// does not branch on it.
public enum ThrowKind: String, Sendable {
    case raw
}

public struct DiscState: Sendable {
    /// World position of the centre of mass, metres.
    public var pos = Vec3d.zero
    /// World velocity, m/s.
    public var vel = Vec3d.zero
    /// Body → world rotation. Body +Z is the disc normal.
    public var orient = Quatd.identity
    /// Angular velocity in the BODY frame, rad/s. `omega.z` is the spin.
    public var omega = Vec3d.zero

    /// Height of the ground plane under the disc, metres.
    public var groundY = 0.0
    /// True from the first frame the disc touches the ground.
    public var touchedGround = false
    /// True once it has stopped sliding.
    public var atRest = false
    /// Seconds since release.
    public var t = 0.0

    // Derived — refreshed by `step`, read-only for consumers.

    /// Signed spin rate about the disc normal, rad/s. Negative is clockwise from above.
    public private(set) var spin = 0.0
    /// Angle of attack, rad.
    public private(set) var alpha = 0.0
    /// Speed relative to the air, m/s.
    public private(set) var airspeed = 0.0

    public var throwKind: ThrowKind = .raw
    /// +1 right handed, −1 left handed.
    public var handed = 1

    public init() {}

    /// Whether every component is finite. A NaN here means the integrator has diverged,
    /// and it is worth checking rather than rendering a disc at coordinate NaN.
    public var isFinite: Bool {
        pos.x.isFinite && pos.y.isFinite && pos.z.isFinite
            && vel.x.isFinite && vel.y.isFinite && vel.z.isFinite
            && orient.x.isFinite && orient.y.isFinite && orient.z.isFinite && orient.w.isFinite
            && omega.x.isFinite && omega.y.isFinite && omega.z.isFinite
    }

    fileprivate mutating func setDerived(spin: Double, alpha: Double, airspeed: Double) {
        self.spin = spin
        self.alpha = alpha
        self.airspeed = airspeed
    }
}

/// The instantaneous aerodynamic breakdown, for tests, the HUD and debug draws.
public struct AeroProbe: Sendable {
    public var alpha = 0.0
    public var airspeed = 0.0
    public var CL = 0.0
    public var CD = 0.0
    public var CM = 0.0
    public var CR = 0.0
    /// Newtons.
    public var lift = 0.0
    public var drag = 0.0
    /// Newton-metres, signed about the aero pitch axis.
    public var pitchMoment = 0.0
    public var rollMoment = 0.0
    /// rad/s, signed about the disc normal.
    public var spin = 0.0
    /// World-space disc normal.
    public var normal = Vec3d.zero
}

/// The packed 13-vector the integrator works on.
///
/// A fixed-size struct rather than an array: it is copied by value into the RK4 stages,
/// which keeps the hot loop allocation-free without needing the module-level scratch
/// buffers the reference uses. That is one of the few places this port is *simpler*
/// than the original rather than a transcription of it — the scratch pads exist in the
/// TypeScript to avoid GC pressure, and value-semantic structs make them unnecessary.
struct StateVec {
    var v0 = 0.0, v1 = 0.0, v2 = 0.0
    var v3 = 0.0, v4 = 0.0, v5 = 0.0
    var v6 = 0.0, v7 = 0.0, v8 = 0.0, v9 = 0.0
    var v10 = 0.0, v11 = 0.0, v12 = 0.0

    init() {}

    init(_ s: DiscState) {
        v0 = s.pos.x; v1 = s.pos.y; v2 = s.pos.z
        v3 = s.vel.x; v4 = s.vel.y; v5 = s.vel.z
        v6 = s.orient.x; v7 = s.orient.y; v8 = s.orient.z; v9 = s.orient.w
        v10 = s.omega.x; v11 = s.omega.y; v12 = s.omega.z
    }

    func unpack(into s: inout DiscState) {
        s.pos = Vec3d(v0, v1, v2)
        s.vel = Vec3d(v3, v4, v5)
        s.orient = Quatd(v6, v7, v8, v9)
        s.omega = Vec3d(v10, v11, v12)
    }

    var quat: Quatd { Quatd(v6, v7, v8, v9) }

    /// `y + k * scale`, the RK4 stage combination.
    func stepped(_ k: StateVec, _ scale: Double) -> StateVec {
        var o = StateVec()
        o.v0 = v0 + scale * k.v0; o.v1 = v1 + scale * k.v1; o.v2 = v2 + scale * k.v2
        o.v3 = v3 + scale * k.v3; o.v4 = v4 + scale * k.v4; o.v5 = v5 + scale * k.v5
        o.v6 = v6 + scale * k.v6; o.v7 = v7 + scale * k.v7; o.v8 = v8 + scale * k.v8
        o.v9 = v9 + scale * k.v9
        o.v10 = v10 + scale * k.v10; o.v11 = v11 + scale * k.v11; o.v12 = v12 + scale * k.v12
        return o
    }

    /// Renormalise the quaternion components in place.
    ///
    /// **This is the integrator's own normalisation and it is deliberately not
    /// `Quatd.normalize()`.** The reference uses a four-argument `Math.hypot` here with a
    /// `> 1e-12` guard, where `THREE.Quaternion.normalize()` uses `sqrt` with an
    /// `l === 0` guard. Two different normalisations in two different places in the same
    /// file; collapsing them would be a silent behavioural change, so both are kept.
    ///
    /// `hypot` is not specified to the last ulp by any libm, so this is the one place in
    /// the flight model that cannot be bit-exact against the TypeScript. The error it
    /// introduces is at the last bit of a value that is being divided out anyway.
    mutating func normalizeQuat() {
        let m = jsHypot4(v6, v7, v8, v9)
        if m > 1e-12 {
            let k = 1 / m
            v6 *= k; v7 *= k; v8 *= k; v9 *= k
        } else {
            v6 = 0; v7 = 0; v8 = 0; v9 = 1
        }
    }
}

/// A four-argument `hypot`, following the scale-by-max approach `Math.hypot` uses.
///
/// Written out rather than composed from two-argument `hypot` calls, because nesting
/// them changes the rounding in a way that is harder to reason about than this is.
@inline(__always)
func jsHypot4(_ a: Double, _ b: Double, _ c: Double, _ d: Double) -> Double {
    let m = Swift.max(abs(a), abs(b), abs(c), abs(d))
    if m == 0 || !m.isFinite { return m.isNaN ? Double.nan : m }
    let ra = a / m, rb = b / m, rc = c / m, rd = d / m
    return m * (ra * ra + rb * rb + rc * rc + rd * rd).squareRoot()
}

// MARK: - the derivative

/// Fill `out` with d/dt of the packed state `y`.
func deriv(
    _ y: StateVec, wind: Vec3d, coeffs c: AeroCoeffs, body b: DiscBody,
    probe: inout AeroProbe?
) -> StateVec {
    let q = y.quat

    // Disc normal and an arbitrary in-plane axis, both in world space.
    let n = Vec3d(0, 0, 1).applying(q)
    let bx = Vec3d(1, 0, 0).applying(q)

    let vrel = Vec3d(y.v3 - wind.x, y.v4 - wind.y, y.v5 - wind.z)
    let V = vrel.length

    // Gravity is the only force we always have.
    var fx = 0.0, fy = -b.mass * c.g, fz = 0.0
    var tx = 0.0, ty = 0.0, tz = 0.0

    var alpha = 0.0, CL = 0.0, CD = 0.0, CM = 0.0, CR = 0.0, lift = 0.0, drag = 0.0
    var pitchM = 0.0, rollM = 0.0

    // Angular velocity in world space, needed for the rate-damping terms.
    let wW = Vec3d(y.v10, y.v11, y.v12).applying(q)
    let spin = wW.dot(n)

    if V > 1e-5 {
        let u = vrel.scaled(1 / V)

        let vn = vrel.dot(n)
        let vp = vrel.addingScaled(n, -vn)
        let vpm = vp.length

        // Angle of attack: the angle between the relative wind and the disc plane.
        alpha = Foundation.atan2(-vn, vpm)

        // Aero frame. Flying exactly face-on leaves the in-plane flight direction
        // undefined; any in-plane axis will do, because lift is zero there anyway.
        let xa = vpm > 1e-6 ? vp.scaled(1 / vpm) : bx
        let ya = xa.cross(n)  // unit: xa and n are orthonormal

        let qdyn = 0.5 * c.rho * V * V * b.area

        CL = c.liftCoeff(alpha)
        CD = c.dragCoeff(alpha)

        // Lift acts perpendicular to the relative wind, in the plane spanned by the wind
        // and the disc normal, towards the normal side.
        let ld = n.addingScaled(u, -n.dot(u))
        let ldm = ld.length
        lift = qdyn * CL
        if ldm > 1e-6 {
            let k = lift / ldm
            fx += ld.x * k; fy += ld.y * k; fz += ld.z * k
        } else {
            lift = 0  // face-on: no lift direction exists
        }

        drag = qdyn * CD
        fx -= u.x * drag; fy -= u.y * drag; fz -= u.z * drag

        // Non-dimensional rates.
        let nd = b.diameter / (2 * V)
        let rhat = spin * nd
        let phat = wW.dot(xa) * nd
        let qhat = wW.dot(ya) * nd

        CM = c.pitchCoeff(alpha) + c.CMq * qhat
        CR = c.CRr * rhat + c.CRp * phat
        let CN = c.CNr * rhat

        let qd = qdyn * b.diameter
        pitchM = qd * CM
        rollM = qd * CR
        let spinM = qd * CN

        tx = xa.x * rollM + ya.x * pitchM + n.x * spinM
        ty = xa.y * rollM + ya.y * pitchM + n.y * spinM
        tz = xa.z * rollM + ya.z * pitchM + n.z * spinM
    }

    var out = StateVec()

    // Linear acceleration.
    let im = 1 / b.mass
    out.v0 = y.v3; out.v1 = y.v4; out.v2 = y.v5
    out.v3 = fx * im; out.v4 = fy * im; out.v5 = fz * im

    // Quaternion kinematics: qdot = 0.5 * q ⊗ (omega_body, 0)
    let qx = y.v6, qy = y.v7, qz = y.v8, qw = y.v9
    let wx = y.v10, wy = y.v11, wz = y.v12
    out.v6 = 0.5 * (qw * wx + qy * wz - qz * wy)
    out.v7 = 0.5 * (qw * wy + qz * wx - qx * wz)
    out.v8 = 0.5 * (qw * wz + qx * wy - qy * wx)
    out.v9 = 0.5 * (-qx * wx - qy * wy - qz * wz)

    // Euler's equations in the body frame. This term is the gyroscope: it is what turns
    // a pitching moment into a roll ninety degrees later, and therefore what makes a
    // disc behave like a disc instead of like a thrown plate.
    let mB = Vec3d(tx, ty, tz).applying(q.conjugated)
    let Ix = b.Ixx, Iz = b.Izz
    out.v10 = (mB.x - (Iz - Ix) * wy * wz) / Ix
    out.v11 = (mB.y - (Ix - Iz) * wz * wx) / Ix
    out.v12 = mB.z / Iz

    if probe != nil {
        probe!.alpha = alpha
        probe!.airspeed = V
        probe!.CL = CL; probe!.CD = CD; probe!.CM = CM; probe!.CR = CR
        probe!.lift = lift; probe!.drag = drag
        probe!.pitchMoment = pitchM; probe!.rollMoment = rollM
        probe!.spin = spin
        probe!.normal = n
    }

    return out
}

// MARK: - integrate

func rk4(_ y: StateVec, dt: Double, wind: Vec3d, coeffs c: AeroCoeffs, body b: DiscBody)
    -> StateVec
{
    var none: AeroProbe? = nil

    let k1 = deriv(y, wind: wind, coeffs: c, body: b, probe: &none)

    var yt = y.stepped(k1, 0.5 * dt)
    yt.normalizeQuat()
    let k2 = deriv(yt, wind: wind, coeffs: c, body: b, probe: &none)

    yt = y.stepped(k2, 0.5 * dt)
    yt.normalizeQuat()
    let k3 = deriv(yt, wind: wind, coeffs: c, body: b, probe: &none)

    yt = y.stepped(k3, dt)
    yt.normalizeQuat()
    let k4 = deriv(yt, wind: wind, coeffs: c, body: b, probe: &none)

    let s = dt / 6
    var o = StateVec()
    o.v0 = y.v0 + s * (k1.v0 + 2 * k2.v0 + 2 * k3.v0 + k4.v0)
    o.v1 = y.v1 + s * (k1.v1 + 2 * k2.v1 + 2 * k3.v1 + k4.v1)
    o.v2 = y.v2 + s * (k1.v2 + 2 * k2.v2 + 2 * k3.v2 + k4.v2)
    o.v3 = y.v3 + s * (k1.v3 + 2 * k2.v3 + 2 * k3.v3 + k4.v3)
    o.v4 = y.v4 + s * (k1.v4 + 2 * k2.v4 + 2 * k3.v4 + k4.v4)
    o.v5 = y.v5 + s * (k1.v5 + 2 * k2.v5 + 2 * k3.v5 + k4.v5)
    o.v6 = y.v6 + s * (k1.v6 + 2 * k2.v6 + 2 * k3.v6 + k4.v6)
    o.v7 = y.v7 + s * (k1.v7 + 2 * k2.v7 + 2 * k3.v7 + k4.v7)
    o.v8 = y.v8 + s * (k1.v8 + 2 * k2.v8 + 2 * k3.v8 + k4.v8)
    o.v9 = y.v9 + s * (k1.v9 + 2 * k2.v9 + 2 * k3.v9 + k4.v9)
    o.v10 = y.v10 + s * (k1.v10 + 2 * k2.v10 + 2 * k3.v10 + k4.v10)
    o.v11 = y.v11 + s * (k1.v11 + 2 * k2.v11 + 2 * k3.v11 + k4.v11)
    o.v12 = y.v12 + s * (k1.v12 + 2 * k2.v12 + 2 * k3.v12 + k4.v12)
    o.normalizeQuat()
    return o
}

// MARK: - ground contact

/// Horizontal slide friction once the disc is down, 1/s.
let GROUND_DRAG = 3.2
/// Spin bleed once the disc is down, 1/s.
let GROUND_SPIN_DRAG = 2.6
/// Below this horizontal speed a grounded disc is considered at rest, m/s.
let REST_SPEED = 0.25
/// How fast a grounded disc levels out, 1/s.
let GROUND_LEVEL_RATE = 14.0

let UP_AXIS = Vec3d(0, 1, 0)

/// Resolve ground contact: no meaningful bounce, a short skid, then rest.
func resolveGround(_ s: inout DiscState, dt: Double, body b: DiscBody) {
    let floor = s.groundY + b.halfHeight
    if s.pos.y > floor { return }

    s.touchedGround = true
    s.pos.y = floor
    if s.vel.y < 0 { s.vel.y = 0 }

    let k = Foundation.exp(-GROUND_DRAG * dt)
    s.vel.x *= k
    s.vel.z *= k

    let ks = Foundation.exp(-GROUND_SPIN_DRAG * dt)
    s.omega = s.omega.scaled(ks)

    // Settle flat over about a tenth of a second, keeping whichever face is down.
    let n = Vec3d(0, 0, 1).applying(s.orient)
    var flat = Quatd.fromUnitVectors(n, n.y >= 0 ? UP_AXIS : Vec3d(0, -1, 0))
    flat = flat.slerped(to: .identity, Foundation.exp(-GROUND_LEVEL_RATE * dt))
    s.orient = s.orient.premultiplied(by: flat).normalized

    if Foundation.hypot(s.vel.x, s.vel.z) < REST_SPEED {
        s.vel = .zero
        s.omega = .zero
        s.atRest = true
    }
}

func refreshDerived(_ s: inout DiscState, wind: Vec3d) {
    let q = s.orient
    let n = Vec3d(0, 0, 1).applying(q)
    let wW = s.omega.applying(q)
    let spin = wW.dot(n)

    let vrel = s.vel - wind
    let V = vrel.length
    var alpha = 0.0
    if V > 1e-5 {
        let vn = vrel.dot(n)
        let vp = vrel.addingScaled(n, -vn)
        alpha = Foundation.atan2(-vn, vp.length)
    }
    s.setDerived(spin: spin, alpha: alpha, airspeed: V)
}

// MARK: - stepping

extension DiscState {
    /// Advance one simulation step.
    ///
    /// Designed for `dt = 1/120`. A larger `dt` is sub-stepped at 1/120 internally so the
    /// result never depends on frame rate; a smaller one is taken as-is. The 4096-step
    /// guard is a backstop against a caller passing a nonsense `dt`, not a real limit.
    public mutating func step(
        dt: Double, wind: Vec3d = .zero,
        coeffs c: AeroCoeffs = .standard, body b: DiscBody = .standard
    ) {
        guard dt > 0 else { return }
        if atRest {
            t += dt
            return
        }

        var remaining = dt
        var guardCount = 0
        while remaining > 1e-9 && guardCount < 4096 {
            guardCount += 1
            let h = remaining > FIXED_DT ? FIXED_DT : remaining
            remaining -= h

            let y = rk4(StateVec(self), dt: h, wind: wind, coeffs: c, body: b)
            y.unpack(into: &self)
            t += h

            resolveGround(&self, dt: h, body: b)
            if atRest { break }
        }

        refreshDerived(&self, wind: wind)
    }

    /// The instantaneous aerodynamic breakdown at the current state.
    public func probe(wind: Vec3d = .zero, coeffs c: AeroCoeffs = .standard,
                      body b: DiscBody = .standard) -> AeroProbe {
        var p: AeroProbe? = AeroProbe()
        _ = deriv(StateVec(self), wind: wind, coeffs: c, body: b, probe: &p)
        return p!
    }

    /// World-space disc normal.
    public var normal: Vec3d { Vec3d(0, 0, 1).applying(orient) }
}
