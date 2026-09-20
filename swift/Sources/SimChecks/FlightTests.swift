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
        flightShape()
        flightWindAndConvergence()
        flightReleaseResponse()
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

    /// A flight reduced to its sport-visible numbers. Aim is assumed +Z, so
    /// lateral drift is +X, the thrower's left.
    private struct Flight {
        var distance, downrange, drift, maxHeight, time: Double
        var landed: Bool
        var descentDeg: Double
        var alphaMax, alphaStep: Double
        var invertedFrac: Double
        var v0, vEnd: Double
        var state: DiscState
    }

    private static func fly(
        _ s: DiscState, wind: Vec3d = .zero, maxT: Double = 12
    ) -> Flight {
        var s = s
        let start = s.pos
        var f = Flight(
            distance: 0, downrange: 0, drift: 0, maxHeight: 0, time: 0,
            landed: false, descentDeg: 0, alphaMax: -9, alphaStep: 0,
            invertedFrac: 0, v0: s.vel.length, vEnd: 0, state: s)
        var prevAlpha = s.alpha
        var inverted = 0, airborne = 0
        var lastVel = s.vel
        for _ in 0..<Int((maxT / FIXED_DT).rounded()) {
            lastVel = s.vel
            s.step(dt: FIXED_DT, wind: wind)
            if s.touchedGround {
                f.landed = true
                f.time = s.t
                break
            }
            airborne += 1
            f.maxHeight = Swift.max(f.maxHeight, s.pos.y - start.y)
            f.alphaMax = Swift.max(f.alphaMax, s.alpha)
            f.alphaStep = Swift.max(f.alphaStep, abs(s.alpha - prevAlpha))
            prevAlpha = s.alpha
            if s.normal.y < 0 { inverted += 1 }
        }
        if !f.landed { f.time = s.t }
        f.vEnd = lastVel.length
        f.downrange = s.pos.z - start.z
        f.drift = s.pos.x - start.x
        f.distance = Foundation.hypot(f.drift, f.downrange)
        f.invertedFrac = airborne > 0 ? Double(inverted) / Double(airborne) : 0
        f.descentDeg = Foundation.atan2(
            -lastVel.y, Foundation.hypot(lastVel.x, lastVel.z)) * 180 / Double.pi
        f.state = s
        return f
    }

    /// Bank angle about the flight axis, rad. Positive = right edge down.
    private static func bankAngle(_ s: DiscState) -> Double {
        let heading = Vec3d(s.vel.x, 0, s.vel.z)
        if heading.lengthSq < 1e-10 { return 0 }
        let h = heading.normalized
        let right = h.cross(Vec3d(0, 1, 0))
        return Foundation.atan2(s.normal.dot(right), s.normal.y)
    }

    private static func bh(
        _ speed: Double, angle: Double = 0, spin: Double = 0.6,
        opts: ThrowOptions = ThrowOptions()
    ) -> DiscState {
        throwDisc(
            .backhand, from: Vec3d(0, 1.3, 0), aim: Vec3d(0, 0, 1),
            power: powerForSpeed(.backhand, speed), angle: angle, spin: spin,
            options: opts)
    }

    private static func noseOpts(_ nose: Double) -> ThrowOptions {
        var o = ThrowOptions()
        o.nose = nose
        return o
    }

    private static func bankOpts(_ bank: Double) -> ThrowOptions {
        var o = ThrowOptions()
        o.bank = bank
        return o
    }

    /// Phase 1b (`tools/test-disc.ts` sections 1–3): the sport-visible shape of a
    /// flight. The laws above say energy falls and bank curves; they do not say a
    /// flat backhand turns over early and fades late, that a forehand goes the
    /// other way, that a left hand mirrors a right, or that a hammer falls out
    /// of the sky. Those are the behaviours a player actually sees, measured off
    /// real integration at the engine's fixed step — same releases, same bounds
    /// as the reference suite.
    private static func flightShape() {

        // A flat 20 m/s right-handed backhand: plausible carry, hang and apex,
        // drag bleeding speed — and turn-then-fade, banks right early and rolls
        // back onto hyzer late.
        let flat20 = fly(bh(20))
        Check.ok(flat20.landed, "a flat backhand lands (does not fly forever)")
        Check.inRange(flat20.distance, 35, 55, "its distance is plausible")
        Check.inRange(flat20.time, 2.0, 6.0, "its hang time is plausible")
        Check.inRange(flat20.maxHeight, 0.0, 8.0, "its apex is plausible")
        Check.ok(flat20.state.isFinite, "state finite at landing")
        Check.ok(
            flat20.vEnd < flat20.v0 * 0.75, "drag bleeds speed")
        Check.ok(
            flat20.alphaStep < 0.02,
            "angle of attack is smooth over the whole flight at 1/120 s")
        do {
            var p = bh(20)
            var banks: [Double] = []
            for i in 0..<1200 {
                if p.touchedGround { break }
                p.step(dt: FIXED_DT)
                if i % 12 == 0 { banks.append(bankAngle(p) * 180 / Double.pi) }
            }
            let early = banks.prefix(banks.count * 2 / 5).max() ?? 0
            let late = banks.suffix(from: banks.count / 2).min() ?? 0
            Check.ok(
                early > 0.5, "high-speed turn: banks right (turns over) early")
            Check.ok(
                late < -5, "low-speed fade: rolls back onto hyzer and finishes left")
            Check.ok(
                late < early - 10, "the roll reverses direction mid-flight")
        }

        // Backhand and forehand curve to opposite sides, measurably, finishing
        // left and right respectively for a right hand.
        let b = fly(bh(20))
        let fh = fly(throwDisc(
            .forehand, from: Vec3d(0, 1.3, 0), aim: Vec3d(0, 0, 1),
            power: powerForSpeed(.forehand, 20), angle: 0, spin: 0.6))
        Check.ok(b.drift * fh.drift < 0, "drift signs are opposite")
        Check.ok(abs(b.drift) > 1.0, "backhand curve is measurable")
        Check.ok(abs(fh.drift) > 1.0, "forehand curve is measurable")
        Check.ok(b.drift > 0, "RH backhand finishes LEFT")
        Check.ok(fh.drift < 0, "RH forehand finishes RIGHT")

        // A left hand is an exact mirror: same distance, opposite drift.
        var leftOpts = ThrowOptions()
        leftOpts.hand = .left
        let lh = fly(throwDisc(
            .backhand, from: Vec3d(0, 1.3, 0), aim: Vec3d(0, 0, 1),
            power: powerForSpeed(.backhand, 20), angle: 0, spin: 0.6,
            options: leftOpts))
        Check.ok(
            abs(lh.drift + b.drift) < 1e-6,
            "left-handed backhand is an exact mirror")
        Check.ok(
            abs(lh.distance - b.distance) < 1e-6, "mirror keeps the same distance")

        // A hammer flies upside down and falls off hard: steeper than a
        // backhand, steeper than it launched, shorter, collapsing late. A
        // scoober breaks the other way.
        let h = fly(throwDisc(
            .hammer, from: Vec3d(0, 2.0, 0), aim: Vec3d(0, 0, 1),
            power: 0.75, angle: 0, spin: 0.6))
        Check.ok(h.invertedFrac > 0.9, "a hammer flies upside down")
        Check.ok(
            h.descentDeg > b.descentDeg + 10,
            "it drops far more steeply than a backhand")
        Check.ok(h.descentDeg > 35, "descent is genuinely steep")
        Check.ok(
            h.distance < b.distance, "it covers less ground than a backhand")
        let launchDeg = throwSpec(.hammer).elevation * 180 / Double.pi
        Check.ok(
            h.descentDeg > launchDeg + 8, "it comes down steeper than it went up")
        let sc = fly(throwDisc(
            .scoober, from: Vec3d(0, 1.6, 0), aim: Vec3d(0, 0, 1),
            power: 0.7, angle: 0, spin: 0.6))
        Check.ok(
            sc.drift * h.drift < 0, "scoober breaks the opposite way to the hammer")
    }

    /// Phase 1b (`tools/test-disc.ts` sections 4–6): wind response, long-run
    /// stability, and timestep convergence. A tailwind carries, a headwind
    /// balloons past the stall angle, a crosswind pushes laterally, and a gale
    /// stops a huck dead; the integrator sheds energy and spin monotonically
    /// for 2,000 steps without NaN; and 1/120 agrees with an 8x finer step and
    /// sub-steps a 1/30 call exactly.
    private static func flightWindAndConvergence() {
        let aero = AeroCoeffs.standard
        let body = DiscBody.standard

        // Wind with the throw carries; wind against it balloons past the stall
        // angle; wind across it pushes laterally.
        let withWind = fly(bh(20, angle: 0.12), wind: Vec3d(0, 0, 6))
        let against = fly(bh(20, angle: 0.12), wind: Vec3d(0, 0, -6))
        let still = fly(bh(20, angle: 0.12))
        Check.ok(
            withWind.distance > against.distance + 8,
            "downwind travels measurably further")
        Check.ok(
            withWind.distance > still.distance, "downwind beats still air")
        Check.ok(
            against.distance < still.distance, "upwind falls short of still air")
        Check.ok(
            against.maxHeight > withWind.maxHeight,
            "upwind huck climbs higher (it balloons)")
        Check.ok(
            against.alphaMax > withWind.alphaMax,
            "upwind reaches a higher angle of attack")
        Check.ok(
            against.alphaMax > aero.aStall, "and pushes past the stall angle")

        // Upwind stall: a 9 m/s headwind stops a 22 m/s huck dead.
        let gale = fly(bh(22, angle: 0.25), wind: Vec3d(0, 0, -9))
        Check.ok(
            gale.downrange < 12,
            "a big upwind throw makes almost no progress downfield")
        Check.ok(gale.maxHeight > 8, "it just balloons instead")

        // Crosswind pushes the disc downwind laterally.
        let cross = fly(bh(20, angle: 0.12), wind: Vec3d(5, 0, 0))
        Check.ok(
            cross.drift > still.drift,
            "crosswind pushes the disc downwind laterally")

        // Stability: 2,000 steps with no ground. Energy and spin magnitude fall
        // monotonically (zero wind, so aero forces are purely dissipative), the
        // quaternion stays unit, alpha never jumps.
        do {
            var s = bh(24, angle: 0.35, spin: 1.0)
            s.groundY = -5000
            var e = energy(s, body: body, aero: aero)
            var spinMag = abs(s.spin)
            var energyViolations = 0
            var spinViolations = 0
            var maxAlphaStep = 0.0
            var prevAlpha = s.alpha
            var finite = true
            var firstSpin = 0.0
            for i in 0..<2000 {
                s.step(dt: FIXED_DT)
                if !s.isFinite { finite = false; break }
                let ne = energy(s, body: body, aero: aero)
                if ne > e + 1e-9 { energyViolations += 1 }
                e = ne
                let sm = abs(s.spin)
                if sm > spinMag + 1e-12 { spinViolations += 1 }
                spinMag = sm
                maxAlphaStep = Swift.max(maxAlphaStep, abs(s.alpha - prevAlpha))
                prevAlpha = s.alpha
                if i == 0 { firstSpin = s.spin }
            }
            Check.ok(finite, "nothing goes NaN or infinite over 2000 steps")
            Check.eq(
                energyViolations, 0,
                "total energy is monotonically non-increasing")
            Check.eq(
                spinViolations, 0, "spin magnitude is monotonically decreasing")
            Check.ok(
                abs(s.spin) < abs(firstSpin) * 0.95, "spin actually decays")
            Check.ok(
                abs(s.orient.length - 1) < 1e-9, "quaternion stays unit")
            Check.ok(
                maxAlphaStep < 0.4,
                "angle of attack stays bounded even in a long tumble")
        }

        // Convergence: 1/120 agrees with an 8x finer step; identical inputs are
        // bit-identical; a 1/30 call sub-steps to exactly four 1/120 steps.
        do {
            func run(_ dt: Double) -> (pos: Vec3d, alpha: Double) {
                var s = bh(22, angle: 0.1, spin: 0.7)
                s.groundY = -5000
                for _ in 0..<Int((3.0 / dt).rounded()) { s.step(dt: dt) }
                return (s.pos, s.alpha)
            }
            let coarse = run(FIXED_DT)
            let fine = run(1.0 / 960.0)
            let posErr = (coarse.pos - fine.pos).length
            Check.ok(
                posErr < 0.05,
                "position after 3 s agrees with an 8x finer step")
            Check.ok(
                abs(coarse.alpha - fine.alpha) < 1e-3,
                "angle of attack agrees with an 8x finer step")
            let a = run(FIXED_DT), b2 = run(FIXED_DT)
            Check.ok(
                a.pos.x == b2.pos.x && a.pos.y == b2.pos.y && a.pos.z == b2.pos.z,
                "integration is bit-for-bit deterministic")
            var s1 = bh(20)
            s1.groundY = -5000
            var s2 = bh(20)
            s2.groundY = -5000
            for _ in 0..<60 { s1.step(dt: 1.0 / 30.0) }
            for _ in 0..<240 { s2.step(dt: FIXED_DT) }
            Check.ok(
                (s1.pos - s2.pos).length < 1e-9,
                "a 1/30 s call sub-steps to exactly four 1/120 s steps")
        }
    }

    /// Phase 1b (`tools/test-disc.ts` sections 7, 8, 8b, 9): release response.
    /// The probe reads sane forces at 20 m/s and alpha tracks the wrist; more
    /// power means more carry up to an interior release angle; bank is a real
    /// control (hyzer holds the line a flat backhand turns over); and every
    /// throw type lands, covers ground, and keeps its character (push short,
    /// blade steep).
    private static func flightReleaseResponse() {
        let body = DiscBody.standard

        // The aero probe at a 20 m/s backhand release: lift around one disc
        // weight, drag under two newtons, precession a slow roll not a flip.
        // Precession is |M_perp| / |Izz * spin|, the axis rate the reference
        // probe reports — derived here from the probe's own moments.
        do {
            let s = bh(20)
            let p = s.probe()
            Check.inRange(
                p.lift, 1.3, 2.6, "lift at 20 m/s is around one disc weight")
            Check.inRange(p.drag, 0.9, 1.8, "drag at 20 m/s")
            let precession = Foundation.hypot(p.pitchMoment, p.rollMoment)
                / abs(body.Izz * p.spin)
            Check.inRange(
                precession, 0.05, 1.2,
                "precession rate is a slow roll, not a flip")
        }

        // Alpha tracks the wrist: nose ±0.15 moves alpha by exactly that, and
        // more alpha means more lift. A nose-up release balloons over nose-down.
        do {
            let specNose = throwSpec(.backhand).nose
            let up = bh(20, opts: noseOpts(0.15))
            let dn = bh(20, opts: noseOpts(-0.15))
            Check.ok(
                abs(up.alpha - (specNose + 0.15)) < 1e-6,
                "nose-up release gives alpha = nose angle")
            Check.ok(
                abs(dn.alpha - (specNose - 0.15)) < 1e-6,
                "nose-down release gives negative alpha")
            Check.ok(
                up.probe().CL > dn.probe().CL, "more alpha means more lift")
            let fUp = fly(bh(20, opts: noseOpts(0.12)))
            let fDn = fly(bh(20, opts: noseOpts(-0.12)))
            Check.ok(
                fUp.maxHeight > fDn.maxHeight, "nose-up release balloons")
        }

        // Power: carry rises monotonically; release angle has an interior
        // optimum — too flat stalls the glide, too steep wastes speed on climb.
        do {
            var last = 0.0
            var mono = true
            for v in [12.0, 16.0, 20.0, 24.0, 27.0] {
                let d = fly(bh(v, angle: 0.10)).distance
                if d <= last { mono = false }
                last = d
            }
            Check.ok(mono, "distance increases monotonically with power")
            let angles = [-0.1, 0.0, 0.1, 0.2, 0.35, 0.5]
            let dists = angles.map { fly(bh(24, angle: $0)).distance }
            let best = dists.indices.max(by: { dists[$0] < dists[$1] }) ?? 0
            Check.ok(
                best > 0 && best < angles.count - 1,
                "an interior release angle maximises distance")
        }

        // Bank: a flat max-power backhand turns over right; hyzer holds the
        // line and holds the distance; release bank orders peak bank
        // monotonically without flipping the disc.
        do {
            func peakBank(_ bank: Double) -> Double {
                var p = bh(26, spin: 0.8, opts: bankOpts(bank))
                var peak = -180.0
                for _ in 0..<1400 {
                    if p.touchedGround { break }
                    p.step(dt: FIXED_DT)
                    peak = Swift.max(peak, bankAngle(p) * 180 / Double.pi)
                }
                return peak
            }
            let flat = fly(bh(26, spin: 0.8))
            let hyzer = fly(bh(26, spin: 0.8, opts: bankOpts(-0.25)))
            let anhyzer = fly(bh(26, spin: 0.8, opts: bankOpts(0.25)))
            Check.ok(
                flat.drift < -5,
                "a flat max-power backhand turns over to the right")
            Check.ok(
                hyzer.drift > flat.drift + 8,
                "hyzer holds the line against the turnover")
            let pFlat = peakBank(0), pHy = peakBank(-0.25), pAn = peakBank(0.25)
            Check.ok(
                pAn > pFlat && pFlat > pHy,
                "bank at release orders the turnover monotonically")
            Check.ok(
                hyzer.distance > anhyzer.distance + 5,
                "a big huck has to be thrown with hyzer to hold its distance")
            Check.inRange(
                pFlat, 12, 60,
                "the disc rolls onto its right edge but does not flip")
        }

        // Every throw type lands, stays finite, covers ground — and keeps its
        // character: the push is short, the blade knifes down steeply and hard.
        do {
            let heights: [ThrowType: Double] = [
                .backhand: 1.3, .forehand: 1.2, .hammer: 2.0,
                .scoober: 1.6, .push: 1.1, .blade: 2.0,
            ]
            var results: [ThrowType: Flight] = [:]
            for t in ThrowType.allCases {
                let st = throwDisc(
                    t, from: Vec3d(0, heights[t] ?? 1.3, 0), aim: Vec3d(0, 0, 1),
                    power: 0.8, angle: 0, spin: 0.7)
                results[t] = fly(st)
            }
            for t in ThrowType.allCases {
                Check.ok(results[t]?.landed ?? false, "\(t) lands")
                Check.ok(
                    results[t]?.state.isFinite ?? false, "\(t) stays finite")
                Check.ok(
                    (results[t]?.distance ?? 0) > 3, "\(t) covers ground")
            }
            if let push = results[.push], let bh = results[.backhand] {
                Check.ok(
                    push.distance < bh.distance * 0.6,
                    "push pass is a short throw")
            }
            if let blade = results[.blade] {
                Check.ok(
                    blade.descentDeg > 40, "blade knifes down steeply")
                Check.ok(
                    abs(blade.drift) > 3, "blade curves hard")
            }
        }
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
