import Foundation
import UltimateSim

/// `humanReleaseParams` — charge, tilt and release quality mapped to disc release
/// parameters — checked against an independent restatement of its own arithmetic, and
/// against the claims its doc comment makes about what a throw feels like in the hand.
///
/// # Two kinds of contract, two kinds of check
///
/// The mapping itself is five lines of arithmetic: a linear speed ramp, a fixed angle
/// slope, a clamped spin term, a signed hyzer, a quality-scaled nose. Nothing in it is
/// transcendental, so `Model` below restates it from scratch — literal constants, not
/// `MIN_THROW_SPEED`/`HUCK_HYZER`, and a hand-written clamp rather than a call to
/// `clamp` — so a transcription slip in the production formula (a wrong offset, a
/// swapped clamp bound, a dropped `spinSign`) cannot hide behind a matching mistake in
/// the check. `throwSpeed` and `spinSign` are read from the aero spec table rather than
/// re-derived: they belong to `Throws.swift`, a different subsystem with its own suite,
/// and re-deriving them here would only be a second, riskier copy of data this mapping
/// merely consumes. The grid sweeps every clamp from both sides — power runs from -1 to
/// 1.75 against a [0,1] clamp, quality from -1 to 1.5 against a spin clamp of [0.1,1] —
/// so a moved rail is caught at the rail, not just somewhere in the middle.
///
/// The half a table of numbers cannot check is what the release actually *does* when you
/// fly it. The doc comment on `humanReleaseParams` makes specific claims — a tap is
/// short, full charge is long, more charge is always more distance, the curve does not
/// invert as you charge, a hyzer that opposes the throw's own turnover — and every one of
/// them is a claim about a FLIGHT. A table of parameters can satisfy all five and still
/// be the bug: the original regression here was measured, not derived, so `feel()` below
/// builds the release and flies it on the real aero to the ground, and flies the
/// regression itself — the one-unsigned-hyzer mapping, and the no-hyzer mapping before
/// it — beside it, so the assertions can fail in the direction the bug actually went.
///
/// # Why this needs no fixture
///
/// The arithmetic is checked against an independent model, not a recorded value — see
/// above. The flights are checked against physical claims a flight either satisfies or
/// does not — a dump does not carry 40 m, a curve does not reverse mid-charge — not
/// against a previously-flown trajectory. What a fixture-diff comparison against the
/// TypeScript's own flown numbers used to add on top of that was a second aero
/// integration to agree with, which is `FlightTests`' job and is redundant here: the
/// laws in `feel()` are what tell you the *mapping* is right, and `FlightTests` is what
/// tells you the *aero it flies through* is right. Carrying both would be asserting the
/// same fact about the aero port twice, from two files that cannot independently fail.
///
/// `HumanTargeting.swift` — aim-cone selection and the lead-error assist — is the other
/// half of the human release path and was never covered by this golden (the TypeScript
/// generator never called it; it has no TypeScript counterpart to have generated one
/// from). It is exercised in `EngineTests.theAssistLeadsARunningReceiver`, against the
/// same kind of property this file uses: the assist nudges toward a lead it does not
/// solve for outright, and declines entirely outside its window.
enum HumanReleaseTests {

    // MARK: - the arithmetic, restated independently

    /// `humanReleaseParams`, written from scratch rather than called into. See the file
    /// header for why every constant here is a literal rather than a shared symbol.
    enum Model {
        static func release(_ type: ThrowType, power: Double, quality: Double, tilt: Double)
            -> HumanRelease
        {
            let p = power < 0 ? 0.0 : (power > 1 ? 1.0 : power)
            let top = throwSpeed(type, 1)
            let minSpeed = 9.0
            let hyzer = 0.20
            let gain = top - minSpeed
            let speed = minSpeed + (gain > 0 ? gain : 0.0) * p
            let angle = 0.02 + 0.10 * p
            let spinRaw = 0.35 + 0.55 * quality
            let spin = spinRaw < 0.1 ? 0.1 : (spinRaw > 1 ? 1.0 : spinRaw)
            let bank = tilt * 0.85 + hyzer * p * p * THROW_SPECS[type]!.spinSign
            let nose = (1 - quality) * 0.08
            return HumanRelease(speed: speed, angle: angle, spin: spin, bank: bank, nose: nose)
        }
    }

    /// The grid. Each axis includes 0, 1, a negative and an above-range value, so both
    /// rails of both clamps — power's [0,1], the spin term's [0.1,1] — are hit from
    /// outside, not merely approached. Unchanged from the generator this suite replaces.
    static let powers: [Double] = [-1, -0.25, 0, 0.125, 0.25, 0.5, 0.75, 1, 1.75]
    static let qualities: [Double] = [-1, -0.5, 0, 0.35, 0.5, 1, 1.5]
    static let tilts: [Double] = [-1.4, -1, 0, 1, 1.4]

    static func run() throws {
        Check.bitEq(
            MIN_THROW_SPEED, 9.0,
            "MIN_THROW_SPEED is 9 m/s — the release speed at zero charge, below every "
                + "throw spec's own floor on purpose")
        Check.bitEq(
            HUCK_HYZER, 0.20,
            "HUCK_HYZER is 0.20 — the power-squared hyzer that stops a full-charge disc "
                + "turning over")

        // A grid that only samples inside the range proves nothing about a clamp.
        Check.ok(
            powers.contains(where: { $0 < 0 }) && powers.contains(where: { $0 > 1 }),
            "the power grid runs off both ends of [0,1]")
        Check.ok(
            qualities.contains(where: { 0.35 + 0.55 * $0 < 0.1 })
                && qualities.contains(where: { 0.35 + 0.55 * $0 > 1 }),
            "the quality grid runs off both ends of the spin clamp")
        Check.ok(
            tilts.contains(where: { $0 < 0 }) && tilts.contains(where: { $0 > 0 }),
            "the tilt grid covers both curve directions")

        // Every output is built from + - * / min max clamp, all correctly rounded, so a
        // difference from the independent model is a logic bug rather than a libm one.
        for type in ThrowType.allCases {
            for power in powers {
                for quality in qualities {
                    for tilt in tilts {
                        let r = humanReleaseParams(
                            type, power: power, quality: quality, tilt: tilt)
                        let m = Model.release(type, power: power, quality: quality, tilt: tilt)
                        let at = "\(type.rawValue) p\(power) q\(quality) t\(tilt)"
                        Check.bitEq(r.speed, m.speed, "\(at) speed")
                        Check.bitEq(r.angle, m.angle, "\(at) angle")
                        Check.bitEq(r.spin, m.spin, "\(at) spin")
                        Check.bitEq(r.bank, m.bank, "\(at) bank")
                        Check.bitEq(r.nose, m.nose, "\(at) nose")
                    }
                }
            }
        }

        laws()
        flownFeel()
    }

    // MARK: - laws the grid's discrete points do not, on their own, state

    /// Properties that hold over the whole domain, not just the grid's sample points —
    /// stated directly rather than inferred from a finite set of bit-exact matches.
    private static func laws() {
        // Power maps monotonically to speed: charging harder never asks for less speed,
        // for any throw. Swept far outside [0,1] too, because the clamp must hold there.
        for type in ThrowType.allCases {
            var prevSpeed = -Double.infinity
            var power = -0.5
            while power <= 1.5 + 1e-9 {
                let speed = humanReleaseParams(type, power: power, quality: 1, tilt: 0).speed
                Check.ok(
                    speed >= prevSpeed,
                    "\(type.rawValue): speed never falls as charge rises (p=\(power), "
                        + "got \(speed), previous \(prevSpeed))")
                prevSpeed = speed
                power += 0.05
            }
            // And it stays inside the throw's own band, however power is clamped.
            let top = throwSpeed(type, 1)
            Check.near(
                humanReleaseParams(type, power: 0, quality: 1, tilt: 0).speed, 9.0, 1e-12,
                "\(type.rawValue): zero charge is the floor")
            Check.near(
                humanReleaseParams(type, power: 1, quality: 1, tilt: 0).speed, top, 1e-12,
                "\(type.rawValue): full charge is the throw's own top speed")
        }

        // The spin clamp holds continuously in quality, not only at the grid's sample
        // points — a quality sweep well past both rails must never leave [0.1, 1].
        var quality = -2.0
        while quality <= 2.0 + 1e-9 {
            let spin = humanReleaseParams(.backhand, power: 0.5, quality: quality, tilt: 0).spin
            Check.inRange(spin, 0.1, 1.0, "quality \(quality): spin stays inside its clamp")
            quality += 0.1
        }

        // The speed clamp holds continuously in power too: whatever the caller passes,
        // the release speed never leaves [MIN_THROW_SPEED, the throw's own top].
        for type in ThrowType.allCases {
            let top = throwSpeed(type, 1)
            var power = -3.0
            while power <= 4.0 + 1e-9 {
                let speed = humanReleaseParams(
                    type, power: power, quality: 1, tilt: 0
                ).speed
                Check.inRange(
                    speed, 9.0, top,
                    "\(type.rawValue) power \(power): release speed stays inside "
                        + "[MIN_THROW_SPEED, top]")
                power += 0.25
            }
        }
    }

    // MARK: - the two counterfactual mappings

    /// `humanReleaseParams` with ONE unsigned hyzer for every throw — the value fitted
    /// against the backhand — instead of taking the correction along `spinSign`.
    ///
    /// This is the bug, kept runnable. It is not a strawman: it is what the mapping
    /// looked like when it was measured as correct, because the backhand's `spinSign` is
    /// -1 and the backhand is therefore bit-for-bit unaffected by the difference.
    static func unsignedRelease(
        _ type: ThrowType, power: Double, quality: Double, tilt: Double
    ) -> HumanRelease {
        let p = clamp(power, 0, 1)
        let top = throwSpeed(type, 1)
        return HumanRelease(
            speed: MIN_THROW_SPEED + Swift.max(0, top - MIN_THROW_SPEED) * p,
            angle: 0.02 + 0.10 * p,
            spin: clamp(0.35 + 0.55 * quality, 0.1, 1),
            bank: tilt * 0.85 - HUCK_HYZER * p * p,
            nose: (1 - quality) * 0.08)
    }

    /// `humanReleaseParams` with no hyzer at all — a flat release at every charge.
    ///
    /// The starting point, and the reason the term exists. Without it the disc turns over
    /// under its own speed and the drift changes sign part-way up the trigger.
    static func flatRelease(
        _ type: ThrowType, power: Double, quality: Double, tilt: Double
    ) -> HumanRelease {
        let p = clamp(power, 0, 1)
        let top = throwSpeed(type, 1)
        return HumanRelease(
            speed: MIN_THROW_SPEED + Swift.max(0, top - MIN_THROW_SPEED) * p,
            angle: 0.02 + 0.10 * p,
            spin: clamp(0.35 + 0.55 * quality, 0.1, 1),
            bank: tilt * 0.85,
            nose: (1 - quality) * 0.08)
    }

    static func release(
        _ mapping: String, _ type: ThrowType, power: Double, quality: Double, tilt: Double
    ) -> HumanRelease {
        switch mapping {
        case "unsigned": return unsignedRelease(type, power: power, quality: quality, tilt: tilt)
        case "flat": return flatRelease(type, power: power, quality: quality, tilt: tilt)
        default: return humanReleaseParams(type, power: power, quality: quality, tilt: tilt)
        }
    }

    // MARK: - flying it

    /// Where a human release leaves the hand, metres. Matches `Game.humanThrow`.
    static let releaseY = 1.55

    /// Charge levels a sweep flies at, 0 through full in tenths.
    static let charges: [Double] = stride(from: 0.0, through: 1.0, by: 0.1).map { $0 }

    /// Build the release and fly it to the ground, exactly as `Game.humanThrow` does:
    /// `power` is 1 and the release speed is supplied absolutely, because the whole point
    /// of `MIN_THROW_SPEED` is that the charge does NOT run through the throw's own range.
    static func fly(_ type: ThrowType, _ r: HumanRelease) -> (carry: Double, drift: Double, hang: Double) {
        var opts = ThrowOptions()
        opts.hand = .right
        opts.bank = r.bank
        opts.nose = r.nose
        opts.speed = r.speed
        var s = throwDisc(
            type, from: Vec3d(0, releaseY, 0), aim: Vec3d(0, 0, 1),
            power: 1, angle: r.angle, spin: r.spin, options: opts)
        var t = 0.0
        while s.pos.y > 0.05 && t < 20 {
            s.step(dt: FIXED_DT)
            t += FIXED_DT
        }
        return (s.pos.z, s.pos.x, t)
    }

    /// What a charge sweep did, in the terms the claims are stated in.
    struct SweepStats {
        var carry: [Double] = []
        var drift: [Double] = []
        /// Charge levels where more charge bought LESS distance.
        var dips = 0
        var worstDip = 0.0
        /// Times the drift changed side. A dead band of 1 m keeps a throw that finishes
        /// on the line from reading as a flip.
        var signFlips = 0
        var maxAbsDrift = 0.0
        var driftRange = 0.0
        /// The drift at its largest, keeping its SIGN — which side the throw finally
        /// bends towards. Read at the peak rather than at full charge because the drift
        /// curve comes back through zero at the top, and a claim about which side a
        /// throw bends to should not be decided by a half-metre near a crossing.
        var peakDrift = 0.0
    }

    static func sweep(
        _ mapping: String, _ type: ThrowType, charges: [Double]
    ) -> SweepStats {
        var st = SweepStats()
        var prevCarry = -Double.infinity
        var prevSign = 0.0
        var lo = Double.infinity
        var hi = -Double.infinity
        for p in charges {
            let f = fly(type, release(mapping, type, power: p, quality: 1, tilt: 0))
            st.carry.append(f.carry)
            st.drift.append(f.drift)
            if f.carry < prevCarry {
                st.dips += 1
                st.worstDip = Swift.min(st.worstDip, f.carry - prevCarry)
            }
            prevCarry = f.carry
            if abs(f.drift) > st.maxAbsDrift { st.peakDrift = f.drift }
            st.maxAbsDrift = Swift.max(st.maxAbsDrift, abs(f.drift))
            lo = Swift.min(lo, f.drift)
            hi = Swift.max(hi, f.drift)
            let sign = f.drift > 1.0 ? 1.0 : (f.drift < -1.0 ? -1.0 : 0.0)
            if sign != 0 && prevSign != 0 && sign != prevSign { st.signFlips += 1 }
            if sign != 0 { prevSign = sign }
        }
        st.driftRange = hi - lo
        return st
    }

    // MARK: - the claims the mapping makes in prose, asserted as flights

    private static func flownFeel() {
        // The speed ramp is only a ramp if the top is above the floor. The check below —
        // asserted for all six types — is also the reachability proof for the
        // `Swift.max(0, top - MIN_THROW_SPEED)` guard in `humanReleaseParams`: when
        // `top > MIN_THROW_SPEED` holds, `top - MIN_THROW_SPEED` is already positive, so
        // `Swift.max(0, …)` returns its argument unchanged and the guard is a no-op. It
        // is a no-op for every type today — push's top is 14 m/s, the lowest of the six,
        // 5 m/s clear of the 9 m/s floor — so a mutation that deletes the guard computes
        // the bit-identical speed for every `type` and every `power`, and no assertion
        // against the current spec table can tell the two formulas apart. That is not
        // "rare", the way the gauss clamp in `RngTests` is rare; it is mathematically
        // identical over the whole reachable domain, and stays that way until some throw
        // spec's top speed drops under 9 m/s. See `swift/mutations.txt`, humanrelease
        // section, for why that mutation is listed as deliberately omitted rather than
        // silently absent.
        for type in ThrowType.allCases {
            Check.ok(
                throwSpeed(type, 1) > MIN_THROW_SPEED,
                "\(type.rawValue): the charge ramp climbs — top \(throwSpeed(type, 1)) "
                    + "is above MIN_THROW_SPEED \(MIN_THROW_SPEED)")
            let zero = humanReleaseParams(type, power: 0, quality: 1, tilt: 0)
            let full = humanReleaseParams(type, power: 1, quality: 1, tilt: 0)
            Check.bitEq(
                zero.speed, MIN_THROW_SPEED, "\(type.rawValue): zero charge is the floor")
            // `near`, not `bitEq`: `min + (top - min)` is a round trip through a
            // subtraction and is not required to land back exactly on `top`. It does for
            // all six specs today, and asserting the tight version would be asserting
            // that the table happens to hold integers.
            Check.near(
                full.speed, throwSpeed(type, 1), 1e-12,
                "\(type.rawValue): full charge is the throw's own top speed")
        }

        // "Below every throw spec's own floor on purpose" — true of five of the six. The
        // push floors at 7 m/s, which is BELOW MIN_THROW_SPEED, so a tapped push leaves
        // the hand slightly faster than the slowest push the table can express. That is
        // harmless (a push is the dump already) but the prose overstates itself, and a
        // check that repeated the prose would be asserting a comfortable falsehood.
        for type in ThrowType.allCases where type != .push {
            Check.ok(
                MIN_THROW_SPEED < THROW_SPECS[type]!.speed.0,
                "\(type.rawValue): a tap is slower than anything the spec's own range can produce")
        }
        Check.ok(
            MIN_THROW_SPEED > THROW_SPECS[.push]!.speed.0,
            "push is the documented exception — its spec floor \(THROW_SPECS[.push]!.speed.0) "
                + "is under MIN_THROW_SPEED")

        // 1 & 2. A tap is a dump and full charge is a huck. Mapping the charge across a
        // throw's own power range cannot do the first: the backhand spec floors at
        // 12 m/s and a 12 m/s backhand carries about 20 m no matter what the trigger says.
        for type in [ThrowType.backhand, .forehand] {
            let tap = fly(type, humanReleaseParams(type, power: 0, quality: 1, tilt: 0))
            let huck = fly(type, humanReleaseParams(type, power: 1, quality: 1, tilt: 0))
            Check.inRange(tap.carry, 5, 14, "\(type.rawValue): a tap is a dump, not a bomb (m)")
            Check.inRange(huck.carry, 38, 60, "\(type.rawValue): full charge is a huck (m)")
        }

        // 3. More charge is always more distance — for every throw, not just the two the
        // player hucks with. A dip is a charge level nobody can use.
        var signed: [ThrowType: SweepStats] = [:]
        for type in ThrowType.allCases {
            let st = sweep("signed", type, charges: charges)
            signed[type] = st
            Check.eq(
                st.dips, 0,
                "\(type.rawValue): more charge is always more distance "
                    + "(worst step \(st.worstDip) m)")
        }

        // 4. The curve does not invert, and stays leadable. Asserted for the two flat
        // throws: a blade is thrown on edge and is SUPPOSED to knife 20 m sideways.
        for type in [ThrowType.backhand, .forehand] {
            let st = signed[type]!
            Check.eq(st.signFlips, 0, "\(type.rawValue): the curve does not invert as you charge")
            Check.inRange(
                st.maxAbsDrift, 0, 12,
                "\(type.rawValue): drift stays leadable across the charge (m)")
        }

        // ---- the hyzer must oppose the throw's OWN turnover ------------------
        //
        // Three mappings, flown side by side, because the claim is comparative and no
        // single flight can carry it.

        // Flat: the disc turns over under its own speed and the drift changes side
        // part-way up the trigger. This is the failure the term exists for.
        for type in [ThrowType.backhand, .forehand] {
            let flat = sweep("flat", type, charges: charges)
            let st = signed[type]!
            Check.ok(
                flat.signFlips >= 1,
                "\(type.rawValue): a flat release DOES invert as you charge "
                    + "(\(flat.signFlips) flip(s), drift \(flat.drift.map { ($0 * 10).rounded() / 10 }))")
            Check.ok(
                flat.driftRange > 1.5 * st.driftRange,
                "\(type.rawValue): hyzer collapses the drift range "
                    + "(\(flat.driftRange) m flat vs \(st.driftRange) m with hyzer)")
        }

        // Unsigned: one bank for both. The backhand cannot tell the difference — its
        // `spinSign` is -1, so the unsigned constant IS its own correction, bit for bit.
        // That is precisely why the bug looked fixed.
        for p in charges {
            let a = humanReleaseParams(.backhand, power: p, quality: 1, tilt: 0)
            let b = unsignedRelease(.backhand, power: p, quality: 1, tilt: 0)
            Check.bitEq(
                a.bank, b.bank,
                "backhand charge \(p): the signed and unsigned mappings are the same throw")
        }

        // The forehand spins the other way, so the same bank ADDS to its turnover. This
        // is the measured regression the doc cites: 20.5 m of drift, a sign flip, and a
        // dip in the distance curve.
        let fhUnsigned = sweep("unsigned", .forehand, charges: charges)
        let fhSigned = signed[.forehand]!
        Check.ok(
            fhUnsigned.maxAbsDrift > 20,
            "one unsigned bank drifts a forehand off the map — \(fhUnsigned.maxAbsDrift) m")
        Check.ok(
            fhUnsigned.signFlips >= 1,
            "one unsigned bank flips the forehand's curve mid-charge "
                + "(\(fhUnsigned.signFlips) flip(s))")
        Check.ok(
            fhUnsigned.dips >= 1,
            "one unsigned bank dips the forehand's distance curve "
                + "(\(fhUnsigned.dips) dip(s), worst \(fhUnsigned.worstDip) m)")
        Check.ok(
            fhSigned.maxAbsDrift < 8 && fhSigned.maxAbsDrift * 2 < fhUnsigned.maxAbsDrift,
            "taking the correction along spinSign straightens the forehand instead — "
                + "\(fhSigned.maxAbsDrift) m vs \(fhUnsigned.maxAbsDrift) m")

        // And the two throws end up on OPPOSITE sides, which is what a backhand and a
        // forehand are. A mapping that straightened both onto the same side would pass
        // every drift-magnitude check above and would still be wrong.
        Check.ok(
            signed[.backhand]!.peakDrift * fhSigned.peakDrift < 0,
            "a backhand and a forehand still bend to opposite sides "
                + "(\(signed[.backhand]!.peakDrift) vs \(fhSigned.peakDrift))")

        // ---- tilt is the curve control, and quality is the cost of a bad release ----
        let left = fly(.backhand, humanReleaseParams(.backhand, power: 0.8, quality: 1, tilt: -1))
        let right = fly(.backhand, humanReleaseParams(.backhand, power: 0.8, quality: 1, tilt: 1))
        Check.ok(
            left.drift > right.drift + 8,
            "tilt buys curve, and the two ends go opposite ways "
                + "(tilt -1 -> \(left.drift) m, tilt +1 -> \(right.drift) m)")

        let clean = fly(.backhand, humanReleaseParams(.backhand, power: 0.8, quality: 1, tilt: 0))
        let sloppy = fly(.backhand, humanReleaseParams(.backhand, power: 0.8, quality: 0, tilt: 0))
        Check.ok(
            sloppy.carry < clean.carry,
            "a poor release costs distance (\(sloppy.carry) m vs \(clean.carry) m clean)")
        // It costs it through the nose, which is the mechanism the mapping claims.
        Check.bitEq(
            humanReleaseParams(.backhand, power: 0.8, quality: 1, tilt: 0).nose, 0,
            "a clean release has no added nose")
        Check.ok(
            humanReleaseParams(.backhand, power: 0.8, quality: 0, tilt: 0).nose > 0,
            "a sloppy release comes out nose up")
    }
}
