import Foundation

/// THE DISC, headless. Ported from the `DiscRuntime` half of `src/entities/Disc.ts`.
///
/// This is the layer between "a player wants to throw" and the validated flight model in
/// `DiscPhysics.swift`. It owns the disc's lifecycle — in a hand, in the air, on the
/// grass — the throw request, the trail history, the wear ledger, and the two prediction
/// queries the AI and the throw solver run against.
///
/// **It owns no aerodynamics.** Every number that describes how a disc flies comes out of
/// `DiscState.step`; everything here is bookkeeping around it. That separation is the
/// reference's and it is why a match can be simulated without a renderer.
///
/// ## What was NOT ported, and why
///
/// `src/entities/Disc.ts` also contains `DiscSystem`, which is roughly two thirds of the
/// file: a lathed 33-point profile swept into a `THREE.BufferGeometry`, four baked
/// textures, an injected shader for rotational motion blur, a broadcast-readability size
/// compensator specified in device pixels, a sun-shadow decal, a ribbon trail mesh and a
/// wear `DataTexture`. None of it has a Swift counterpart in `UltimateSim`, which imports
/// Foundation and nothing else. The full list is in the port report and in
/// `DiscRuntimeTests`.
///
/// ## Two things the reference does that value semantics make unnecessary
///
/// The TypeScript threads results through module-level scratch vectors (`_v`, `_v2`,
/// `_v3`, `_q1`, `_q2`) and through an `out:` parameter on `throwDisc`. Every one of those
/// sites is an alias mutation and every one is called out in a comment below, because
/// silently turning an alias into a copy — or failing to — is the single most likely bug
/// class in this port. Two of them are latent bugs in the reference, preserved as notes
/// rather than as behaviour:
///
///  - `release()` returns the module scratch `_v`, so the vector a caller is handed is
///    invalidated by the next `release()` **or `markScuff()`** on any runtime. Here it is
///    a value and cannot be.
///  - `markScuff()` writes the disc normal into that same `_v`.
///
/// ## No randomness
///
/// `DiscRuntime` never draws from an RNG, so there is no draw order to preserve.

// MARK: - types

/// Where the disc is in its lifecycle. The runtime never changes this by itself: the game
/// system decides, which is why a disc that has landed under its own power is still
/// `.flight` until somebody says otherwise.
public enum DiscMode: String, Equatable, Sendable {
    case held, flight, ground
}

/// One point of the real sampled flight path. Not a spline hint — the trail is the actual
/// integration output, so the curve of a huck is the curve `DiscPhysics` produced.
public struct TrailSample: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var z: Double
    /// Runtime clock at which this sample was taken, seconds.
    public var t: Double
    public var speed: Double

    public init(x: Double, y: Double, z: Double, t: Double, speed: Double) {
        self.x = x
        self.y = y
        self.z = z
        self.t = t
        self.speed = speed
    }
}

/// Everything a caller has to decide to throw.
///
/// `hand`, `bank`, `nose` and `speed` are optional in the reference and reach `throwDisc`
/// through `?? `defaults; they are optional here for the same reason, so that "not
/// specified" and "specified as zero" stay distinguishable at the call site.
public struct ThrowRequest: Sendable {
    public var type: ThrowType
    public var from: Vec3d
    /// Aim direction. Only the horizontal part sets the heading.
    public var aim: Vec3d
    public var power: Double
    public var angle: Double
    public var spin: Double
    public var hand: ThrowOptions.Hand?
    public var bank: Double?
    public var nose: Double?
    /// Absolute release speed in m/s, overriding `power`. See `ThrowOptions.speed`.
    public var speed: Double?

    public init(
        type: ThrowType, from: Vec3d, aim: Vec3d,
        power: Double, angle: Double, spin: Double,
        hand: ThrowOptions.Hand? = nil, bank: Double? = nil, nose: Double? = nil,
        speed: Double? = nil
    ) {
        self.type = type
        self.from = from
        self.aim = aim
        self.power = power
        self.angle = angle
        self.spin = spin
        self.hand = hand
        self.bank = bank
        self.nose = nose
        self.speed = speed
    }
}

/// Which part of the disc met the grass, in the disc's own polar frame. Produced by
/// `markScuff` and consumed by whatever draws wear.
public struct DiscScuff: Equatable, Sendable {
    /// Radius as a fraction of the disc radius, 0…1.
    public var rr: Double
    /// Angle about the disc normal, rad.
    public var ang: Double
    /// True when it was the TOP face that struck.
    public var top: Bool
    public var strength: Double

    public init(rr: Double, ang: Double, top: Bool, strength: Double) {
        self.rr = rr
        self.ang = ang
        self.top = top
        self.strength = strength
    }
}

/// The answer `probeThrow` gives the throw solver: where a released disc first descends
/// through the catch plane, resolved along and across the aim line.
public struct ThrowProbe: Equatable, Sendable {
    /// Metres down the aim line. Negative means the throw came back past the thrower.
    public var dist: Double
    /// Metres off the aim line, positive to the aim's left in this basis.
    public var lat: Double
    /// Flight time at that point, seconds.
    public var t: Double
    public var x: Double
    public var z: Double

    public init(dist: Double, lat: Double, t: Double, x: Double, z: Double) {
        self.dist = dist
        self.lat = lat
        self.t = t
        self.x = x
        self.z = z
    }
}

// MARK: - JS-compatible hypot

/// `Math.hypot` as V8 implements it: scale by the largest magnitude, then a
/// **Kahan-compensated** sum of the squares.
///
/// The compensation earns its place, but only at three arguments — and the distinction is
/// worth stating precisely, because an earlier version of this comment claimed 6 % for
/// both and that is not what the measurement says. Bit-mismatches against V8, 4 000
/// random inputs each, compared by bit pattern:
///
/// |                          | two arguments | three arguments |
/// |--------------------------|---------------|-----------------|
/// | this Kahan form          | 0             | 0               |
/// | uncompensated scale-by-max | 0           | 200 (5 %)       |
/// | `sqrt(x*x + y*y)`        | 1445 (36 %)   | —               |
///
/// So at two arguments the compensation is genuinely redundant and `jsHypot2` could be
/// the simpler form. It is kept identical to `jsHypot3` anyway, because the thing that
/// must not drift is that both spell V8's algorithm — and two functions claiming to be
/// the same algorithm while being written differently is how a port acquires a difference
/// nobody meant.
///
/// What the table does establish is the real reason these exist: `sqrt(x*x + y*y)` is
/// wrong more than a third of the time. That is why the three `Math.hypot` call sites in
/// the reference runtime — the trail's speed, the aim line's length and the scuff radius —
/// go through here rather than through `Foundation.hypot` or `Vec3d.length`.
///
/// **Deliberately not `jsHypot4` from `DiscPhysics.swift`.** That one is the integrator's
/// own quaternion normalisation, written uncompensated and documented there as the one
/// place the flight model cannot be bit-exact. Two different roundings in two different
/// places is the reference's doing; collapsing them would be a silent behavioural change.
@inline(__always)
func jsHypot2(_ a: Double, _ b: Double) -> Double {
    if a.isInfinite || b.isInfinite { return .infinity }
    if a.isNaN || b.isNaN { return .nan }
    var m = 0.0
    let aa = abs(a), ab = abs(b)
    if aa > m { m = aa }
    if ab > m { m = ab }
    if m == 0 { return 0 }
    // Unrolled rather than looped over an array literal: this runs once per frame per
    // disc and the loop is the only thing here that could allocate. Same operations, in
    // the same order.
    var sum = 0.0
    var comp = 0.0
    var n = a / m
    var summand = n * n - comp
    var preliminary = sum + summand
    comp = (preliminary - sum) - summand
    sum = preliminary
    n = b / m
    summand = n * n - comp
    preliminary = sum + summand
    comp = (preliminary - sum) - summand
    sum = preliminary
    return sum.squareRoot() * m
}

/// Three-argument `Math.hypot`. Same algorithm as `jsHypot2`; see there for why.
@inline(__always)
func jsHypot3(_ a: Double, _ b: Double, _ c: Double) -> Double {
    if a.isInfinite || b.isInfinite || c.isInfinite { return .infinity }
    if a.isNaN || b.isNaN || c.isNaN { return .nan }
    var m = 0.0
    let aa = abs(a), ab = abs(b), ac = abs(c)
    if aa > m { m = aa }
    if ab > m { m = ab }
    if ac > m { m = ac }
    if m == 0 { return 0 }
    var sum = 0.0
    var comp = 0.0
    var n = a / m
    var summand = n * n - comp
    var preliminary = sum + summand
    comp = (preliminary - sum) - summand
    sum = preliminary
    n = b / m
    summand = n * n - comp
    preliminary = sum + summand
    comp = (preliminary - sum) - summand
    sum = preliminary
    n = c / m
    summand = n * n - comp
    preliminary = sum + summand
    comp = (preliminary - sum) - summand
    sum = preliminary
    return sum.squareRoot() * m
}

// MARK: - free geometry

/// World-space disc normal. Body +Z is the disc's face direction, which is what the
/// flight model and `throwDisc` both assume.
///
/// ALIAS SITE — the reference is `discNormalWorld(s, out)` writing into the caller's
/// vector, and every call site passes the module scratch `_v`. Returned by value here.
func discNormalWorld(_ s: DiscState) -> Vec3d {
    Vec3d(0, 0, 1).applying(s.orient)
}

/// Point the disc's body +Z at `normal`, with `phase` radians of spin about it.
///
/// The zero-length guard reads backwards and is copied that way on purpose: the reference
/// normalises FIRST and only then tests `lengthSq() < 1e-6`. A normalised vector has
/// length 1 or, for a zero input, length 0 — three.js divides by `length || 1` — so the
/// test only ever fires for a zero-length argument, which is what it is for. Testing
/// before normalising would additionally reject any legitimate normal shorter than 1 mm.
///
/// ALIAS SITE — the reference threads `_v3`, `_v2`, `_q1` and `_q2` module scratch through
/// this, and reuses `_v2` for two different vectors within it.
func orientToNormal(_ s: inout DiscState, _ normal: Vec3d, _ phase: Double) {
    var n = normal.normalized
    if n.lengthSq < 1e-6 { n = Vec3d(0, 1, 0) }
    let q1 = Quatd.fromUnitVectors(Vec3d(0, 0, 1), n)
    let q2 = Quatd.fromAxisAngle(Vec3d(0, 0, 1), phase)
    s.orient = (q1 * q2).normalized
}

// MARK: - the runtime

/// The headless disc.
///
/// A **class**, matching the reference's single long-lived object and `AIPlayer`'s
/// reasoning elsewhere in this port: it is written by the game system and read by the AI
/// and the renderer within the same frame, and `step` mutates it in place. A value type
/// would make every call site that forgot to write the result back silently do nothing.
public final class DiscRuntime {

    /// The integrated flight state. Public and mutable because the reference's is: the
    /// game pokes `groundY` and the tests poke a pathological velocity.
    public var state = DiscState()

    public var mode: DiscMode = .ground

    /// Player id holding it, or −1.
    public var holderId = -1

    /// Team of the last thrower. Set by the game; used for trail tint and possession.
    public var lastThrowTeam = 0

    /// Seconds since release. Starts enormous so that a disc which has never been thrown
    /// cannot be self-caught, and blocks self-catches for a few frames after one that has.
    public var sinceRelease = 1e3

    /// 0…1 cumulative match wear. Drives the scuff map's overall strength.
    public var wear = 0.0

    /// Sampled flight path, newest last.
    public private(set) var trail: [TrailSample] = []
    public var trailCapacity = 72

    /// Seconds of path kept. Long enough to show a huck's curve, short enough that the
    /// tail is never a bar across the lens.
    public var trailSeconds = 0.80

    /// Ground height query, bound to the field system by the game.
    ///
    /// A closure rather than a field constant, and that is deliberate: the terrain is not
    /// the pitch rectangle, and the runtime must not know how big the pitch is. Field
    /// geometry stays with whoever owns the field.
    public var groundAt: (Double, Double) -> Double = { _, _ in 0 }

    public var wind = Vec3d.zero

    /// Set whenever the disc lands; the visual layer consumes and clears it.
    public var pendingScuff: DiscScuff? = nil

    /// The disc's physical constants and the air it flies in.
    ///
    /// Stored rather than defaulted at each call so that neither is a hidden global — the
    /// same reasoning that keeps the pitch out of this file.
    public var body: DiscBody = .standard
    public var coeffs: AeroCoeffs = .standard

    private var clock = 0.0

    /// Scratch state for `predictPath` and `probeThrow`.
    ///
    /// **Shared between them, and persistent, exactly as the reference's is.** Neither
    /// method initialises every field of it — `spin`, `alpha`, `airspeed`, `throwType` and
    /// `handed` survive from whichever ran last — so a fresh state per call would not be
    /// the same object. The physics never branches on any of those, so this cannot change
    /// a predicted path; it is preserved because "cannot" is a claim the fixtures should
    /// be allowed to check rather than one the port should assume.
    private var probe = DiscState()

    public init() {}

    // MARK: driving

    /// Advance the flight by one fixed step. No-op on the physics when held or grounded —
    /// but the clock, the release timer and the trail decay all still run.
    public func step(dt: Double) {
        clock += dt
        sinceRelease += dt
        if mode != .flight {
            decayTrail()
            return
        }

        state.groundY = groundAt(state.pos.x, state.pos.z)
        state.step(dt: dt, wind: wind, coeffs: coeffs, body: body)
        if !state.isFinite {
            // A non-finite state can only come from a pathological release; park it rather
            // than poisoning every consumer downstream.
            //
            // ALIAS SITE — `vel.set`, `omega.set` and `pos.set` in the reference, all
            // mutating the live state through its own fields. Explicit assignment here.
            //
            // Note `groundY` is whatever the last finite position asked for, not the
            // ground under the origin the disc is being parked at. That is the
            // reference's behaviour and it is visible for exactly one frame, until the
            // next `step` re-queries it at x = z = 0.
            state.vel = .zero
            state.omega = .zero
            state.pos = Vec3d(0, state.groundY + body.halfHeight, 0)
            state.atRest = true
            state.touchedGround = true
        }
        pushTrail()
    }

    /// Launch. Returns the release velocity so callers can log or emit it.
    @discardableResult
    public func release(_ req: ThrowRequest) -> Vec3d {
        var opts = ThrowOptions()
        opts.hand = req.hand ?? .right
        opts.bank = req.bank ?? 0
        opts.nose = req.nose ?? 0
        opts.speed = req.speed
        opts.groundY = groundAt(req.from.x, req.from.z)

        // ALIAS SITE — the reference passes `out: this.state`, so `throwDisc` resets and
        // fills the live state in place. Swift's `throwDisc` returns a fresh value, so
        // this is an explicit whole-state assignment. It is equivalent because the
        // reference's `resetDiscState` clears *every* field first, including `t`, `spin`,
        // `alpha` and `airspeed`; if it ever stopped doing so, this line would diverge.
        state = throwDisc(
            req.type, from: req.from, aim: req.aim,
            power: req.power, angle: req.angle, spin: req.spin, options: opts)

        mode = .flight
        holderId = -1
        sinceRelease = 0
        trail.removeAll()
        pushTrail()

        // ALIAS SITE — the reference returns `_v.copy(this.state.vel)`, a module scratch
        // vector that the next `release()` or `markScuff()` on ANY runtime overwrites
        // under the caller. A value here, so it cannot be.
        return state.vel
    }

    /// Pin the disc into a hand. `normal` is the disc's face direction.
    ///
    /// This is also what a catch is: the runtime has no separate catch resolution, because
    /// deciding whether a catch happened is the game's job and the disc's job is only to
    /// stop flying when told.
    ///
    /// **One forced divergence.** The reference assigns `state.spin = 0` and leaves
    /// `alpha` and `airspeed` at whatever the last flight left them. `DiscState.spin` is
    /// `private(set)` in `DiscPhysics.swift`, so the only way to zero it from here is
    /// `refreshDerived`, which zeroes all three. The two extra fields are derived
    /// diagnostics that nothing in the sim branches on and that the next `step` recomputes
    /// before any physics reads them; carrying a stale angle of attack on a disc that is
    /// in somebody's hand is not a behaviour worth reproducing anyway.
    public func hold(_ playerId: Int, _ pos: Vec3d, _ normal: Vec3d, _ spinPhase: Double = 0) {
        mode = .held
        holderId = playerId
        // ALIAS SITE — `this.state.pos.copy(pos)`.
        state.pos = pos
        state.vel = .zero
        state.omega = .zero
        state.atRest = false
        state.touchedGround = false
        state.groundY = groundAt(pos.x, pos.z)
        // See the divergence note above. Zero wind, so this cannot pick up the runtime's
        // wind as an airspeed on a disc that is not moving through the air.
        refreshDerived(&state, wind: .zero)
        orientToNormal(&state, normal, spinPhase)
        trail.removeAll()
    }

    /// Park the disc on the grass at `pos`.
    ///
    /// Deliberately does NOT clear the trail — that is what leaves a ribbon hanging behind
    /// a disc that has just been swatted down. Same `spin` divergence as `hold`.
    public func settle(_ pos: Vec3d) {
        mode = .ground
        holderId = -1
        // ALIAS SITE — `this.state.pos.set(x, y, z)`. Note the y is the ground under the
        // TARGET position, not under wherever the disc currently is.
        state.pos = Vec3d(pos.x, groundAt(pos.x, pos.z) + body.halfHeight, pos.z)
        state.vel = .zero
        state.omega = .zero
        state.atRest = true
        state.touchedGround = true
        refreshDerived(&state, wind: .zero)
        orientToNormal(&state, Vec3d(0, 1, 0), 0)
    }

    /// Record a ground strike so the visual layer can stamp the scuff map.
    ///
    /// Pure geometry: rotate world-down into the disc's own frame and read off where it
    /// points. `top` comes back INVERTED — the face that struck the grass is the one that
    /// is not pointing up.
    public func markScuff(_ strength: Double) {
        // ALIAS SITE — the reference writes this into `_v`, the same scratch vector
        // `release()` hands back to its caller.
        let n = discNormalWorld(state)
        let top = n.y >= 0

        // Which part of the disc met the grass: the low edge in world space.
        //
        // ALIAS SITE — `_q1.copy(q).conjugate()` and `_v2.set(0,-1,0)`. Note `conjugate()`
        // does not renormalise, so a drifted quaternion produces a slightly non-unit
        // rotation here; reproduced rather than corrected.
        let inv = state.orient.conjugated
        let down = Vec3d(0, -1, 0).applying(inv)
        let rr = clamp(jsHypot2(down.x, down.y) * 1.05, 0, 1)
        let ang = Foundation.atan2(down.y, down.x)
        pendingScuff = DiscScuff(rr: rr, ang: ang, top: !top, strength: strength)
        wear = clamp(wear + strength * 0.055, 0, 1)
    }

    /// Age of the newest trail sample, seconds. 1e3 when there is no trail, so that a
    /// consumer comparing against a threshold never has to special-case an empty one.
    public var trailAge: Double {
        guard let s = trail.last else { return 1e3 }
        return clock - s.t
    }

    /// Runtime clock, seconds since construction.
    public var now: Double { clock }

    // MARK: prediction

    /// Sample where the disc will be.
    ///
    /// The runtime integrates its OWN state when the disc is genuinely in the air and it
    /// is ours; otherwise it takes the caller's position and velocity and flies those
    /// instead — with our orientation and spin, because the caller's record has neither.
    ///
    /// `step` is clamped to `[FIXED_DT, 1/20]` and the sample count to `[2, 240]`, so a
    /// caller cannot ask for a prediction that costs an unbounded amount of integration.
    /// The horizon floor of 0.1 s is applied before the division, not after.
    public func predictPath(
        pos: Vec3d? = nil, vel: Vec3d? = nil,
        horizon: Double = 6, step: Double = 1.0 / 30.0
    ) -> [FlightSample] {
        // ALIAS SITE — the reference copies field by field into the persistent `this.probe`
        // (`p.pos.copy(...)`, `p.vel.copy(...)`, …). Read out, mutate, write back, so the
        // scratch state stays shared with `probeThrow` the way the reference's is.
        var p = probe
        let live = mode == .flight
        p.pos = state.pos
        p.vel = state.vel
        p.orient = state.orient
        p.omega = state.omega
        p.groundY = state.groundY
        p.touchedGround = false
        p.atRest = false
        p.t = 0
        if !live, let sp = pos, let sv = vel {
            p.pos = sp
            p.vel = sv
        }

        var out: [FlightSample] = [FlightSample(t: 0, x: p.pos.x, y: p.pos.y, z: p.pos.z)]
        let dt = Swift.max(FIXED_DT, Swift.min(1.0 / 20.0, step))
        let n = Swift.max(2, Swift.min(240, Int((Swift.max(0.1, horizon) / dt).rounded())))
        for i in 1...n {
            p.groundY = groundAt(p.pos.x, p.pos.z)
            p.step(dt: dt, wind: wind, coeffs: coeffs, body: body)
            out.append(FlightSample(t: Double(i) * dt, x: p.pos.x, y: p.pos.y, z: p.pos.z))
            if p.touchedGround { break }
        }
        if out.count < 2 {
            // Unreachable while `n >= 2`, but the reference guarantees at least two points
            // and callers difference consecutive samples.
            out.append(FlightSample(t: dt, x: out[0].x, y: out[0].y, z: out[0].z))
        }
        probe = p
        return out
    }

    /// Where a released disc first descends through `catchY`, and how far that is from the
    /// release point, resolved along and across the aim line.
    ///
    /// **`req.speed` IS forwarded**, and this comment used to say it was not — "it looks
    /// like an oversight and it may be one, but the throw solver is tuned against these
    /// numbers". It was an oversight, and the reference has fixed it: `speed` was the one
    /// release parameter `release` honoured and this did not, so a request carrying an
    /// absolute release speed probed at its `power` speed and then flew at a completely
    /// different one. The solver's whole job is comparing the probe against the flight,
    /// and it now solves for that speed.
    public func probeThrow(_ req: ThrowRequest, catchY: Double, maxT: Double = 6) -> ThrowProbe {
        var opts = ThrowOptions()
        opts.hand = req.hand ?? .right
        opts.bank = req.bank ?? 0
        opts.nose = req.nose ?? 0
        opts.speed = req.speed
        opts.groundY = groundAt(req.from.x, req.from.z)

        // ALIAS SITE — `out: this.probe`, so the reference reuses and resets the same
        // scratch state `predictPath` uses. Assigned whole here for the same reason.
        var p = throwDisc(
            req.type, from: req.from, aim: req.aim,
            power: req.power, angle: req.angle, spin: req.spin, options: opts)

        let hx = req.aim.x, hz = req.aim.z
        let h = jsHypot2(hx, hz)
        // `Math.hypot(hx, hz) || 1` — a straight-up aim is the only thing that reaches it.
        // JS `||` treats NaN as falsy too, hence both tests.
        let hl = (h == 0 || h.isNaN) ? 1 : h
        let ux = hx / hl, uz = hz / hl

        var prevY = p.pos.y
        let steps = Int((maxT / FIXED_DT).rounded())
        for _ in 0..<steps {
            p.groundY = groundAt(p.pos.x, p.pos.z)
            p.step(dt: FIXED_DT, wind: wind, coeffs: coeffs, body: body)
            let dx = p.pos.x - req.from.x, dz = p.pos.z - req.from.z
            if (p.pos.y <= catchY && prevY > catchY) || p.touchedGround {
                probe = p
                return ThrowProbe(
                    dist: dx * ux + dz * uz,
                    lat: -dx * uz + dz * ux,
                    t: p.t, x: p.pos.x, z: p.pos.z)
            }
            prevY = p.pos.y
        }
        let dx = p.pos.x - req.from.x, dz = p.pos.z - req.from.z
        probe = p
        return ThrowProbe(
            dist: dx * ux + dz * uz,
            lat: -dx * uz + dz * ux,
            t: p.t, x: p.pos.x, z: p.pos.z)
    }

    // MARK: trail

    /// Seed the trail directly — used when a tableau stages a mid-flight disc.
    ///
    /// Re-bases every timestamp so the NEWEST sample lands exactly on `now`, which is what
    /// makes a staged trail decay at the same rate a flown one does.
    public func setTrail(_ samples: [TrailSample]) {
        trail.removeAll()
        guard let last = samples.last else { return }
        for s in samples {
            // The reference spreads `{...s}` and overrides `t`; x, y, z and speed are
            // carried through untouched.
            trail.append(
                TrailSample(x: s.x, y: s.y, z: s.z, t: clock - (last.t - s.t), speed: s.speed))
        }
    }

    private func pushTrail() {
        let s = state
        // `Math.hypot` of the three components, NOT `vel.length`. The reference really
        // does use a different rounding here from the one the physics uses internally.
        let speed = jsHypot3(s.vel.x, s.vel.y, s.vel.z)
        trail.append(TrailSample(x: s.pos.x, y: s.pos.y, z: s.pos.z, t: clock, speed: speed))
        decayTrail()
    }

    private func decayTrail() {
        let cut = clock - trailSeconds
        var drop = 0
        while drop < trail.count && trail[drop].t < cut { drop += 1 }
        if drop > 0 { trail.removeFirst(drop) }
        while trail.count > trailCapacity { trail.removeFirst() }
    }
}

// MARK: - the AI peer contract

/// The disc runtime is what implements `predictPath` for the AI, so it conforms directly
/// rather than through an adapter.
///
/// `AIDiscState` always carries a position and a velocity, where the reference's duck-typed
/// record may carry neither and is tested for both. The `!live && pos && vel` condition
/// therefore collapses to `!live` here, which is the same branch for every input the AI
/// can actually produce.
extension DiscRuntime: DiscPeer {
    public func predictPath(
        _ state: AIDiscState, horizon: Double, step: Double
    ) -> [FlightSample] {
        predictPath(pos: state.pos, vel: state.vel, horizon: horizon, step: step)
    }
}
