import Foundation
import UltimateSim

/// `humanReleaseParams`, against `src/sim/Game.ts`.
///
/// The mapping itself is five lines of arithmetic and the golden pins all of it bit for
/// bit. That is the cheap half. The half worth having is below `feel()`: the reference's
/// doc comment makes specific claims about what a throw feels like in the hand, and every
/// one of them is a claim about a FLIGHT, not about a number. A tap is short. Full charge
/// is long. More charge is always more distance. The curve does not invert as you charge.
/// A table of release parameters cannot fail any of those, which is exactly why the
/// original bug survived review — the numbers looked reasonable and the game played
/// wrong. So the claims are asserted by building the release and flying the real aero to
/// the ground, and the two counterfactual mappings are flown beside it so the assertions
/// can fail in the direction the bug actually went.
enum HumanReleaseTests {

    struct Case: Decodable {
        let type: String
        let power: Double
        let quality: Double
        let tilt: Double
        let speed: Double
        let angle: Double
        let spin: Double
        let bank: Double
        let nose: Double
    }
    struct Sweep: Decodable {
        let type: String
        let mapping: String
        let carry: [Double]
        let drift: [Double]
        let hang: [Double]
    }
    struct TiltProbe: Decodable {
        let tilt: Double
        let carry: Double
        let drift: Double
    }
    struct QualityProbe: Decodable {
        let quality: Double
        let carry: Double
        let drift: Double
    }
    struct Feel: Decodable {
        let releaseY: Double
        let charges: [Double]
        let sweeps: [Sweep]
        let tiltProbe: [TiltProbe]
        let qualityProbe: [QualityProbe]
    }
    struct File: Decodable {
        let note: String
        let minThrowSpeed: Double
        let huckHyzer: Double
        let powers: [Double]
        let qualities: [Double]
        let tilts: [Double]
        let cases: [Case]
        let feel: Feel
    }

    /// How far a flown landing point may differ from the reference's, metres.
    ///
    /// Wider than the release tolerance by design, and not because the integrator is
    /// loose. A flight ends on a threshold test — `pos.y > 0.05` — so a difference of one
    /// ulp near the ground changes the number of steps taken, and one step at landing
    /// speed is around 0.12 m of travel. Anything this suite is trying to catch is metres
    /// wide: the regression it exists for is a 20 m swing and a sign flip.
    static let flightTol = 0.5

    static func run() throws {
        let g = try Goldens.load(File.self, "humanrelease")

        Check.eq(
            g.cases.count,
            ThrowType.allCases.count * g.powers.count * g.qualities.count * g.tilts.count,
            "the grid is the full cross product of type x power x quality x tilt")
        Check.bitEqViaJSON(MIN_THROW_SPEED, g.minThrowSpeed, "MIN_THROW_SPEED")
        Check.bitEqViaJSON(HUCK_HYZER, g.huckHyzer, "HUCK_HYZER")

        // A grid that only samples inside the range proves nothing about a clamp. Assert
        // the fixture straddles both rails of both clamps before trusting what it says.
        Check.ok(
            g.powers.contains(where: { $0 < 0 }) && g.powers.contains(where: { $0 > 1 }),
            "the power grid runs off both ends of [0,1]")
        Check.ok(
            g.qualities.contains(where: { 0.35 + 0.55 * $0 < 0.1 })
                && g.qualities.contains(where: { 0.35 + 0.55 * $0 > 1 }),
            "the quality grid runs off both ends of the spin clamp")
        Check.ok(
            g.tilts.contains(where: { $0 < 0 }) && g.tilts.contains(where: { $0 > 0 }),
            "the tilt grid covers both curve directions")

        // Every output is built from + - * / min max clamp, all correctly rounded, so a
        // difference here is a logic bug rather than a libm difference.
        for c in g.cases {
            guard let type = ThrowType(rawValue: c.type) else {
                Check.ok(false, "unknown throw type \(c.type)")
                continue
            }
            let r = humanReleaseParams(
                type, power: c.power, quality: c.quality, tilt: c.tilt)
            let at = "\(c.type) p\(c.power) q\(c.quality) t\(c.tilt)"
            Check.bitEqViaJSON(r.speed, c.speed, "\(at) speed")
            Check.bitEqViaJSON(r.angle, c.angle, "\(at) angle")
            Check.bitEqViaJSON(r.spin, c.spin, "\(at) spin")
            Check.bitEqViaJSON(r.bank, c.bank, "\(at) bank")
            Check.bitEqViaJSON(r.nose, c.nose, "\(at) nose")
        }

        flownAgainstReference(g)
        feel(g)
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

    // MARK: - the flights, against the reference's own

    /// The same releases, flown here and flown in TypeScript, compared where they land.
    ///
    /// This is what makes the claims below worth anything: an envelope assertion only
    /// says the Swift sim is plausible, whereas these say it is the SAME sim. Both
    /// mappings are flown, so the fixture also records what the broken one did.
    private static func flownAgainstReference(_ g: File) {
        for sw in g.feel.sweeps {
            guard let type = ThrowType(rawValue: sw.type) else {
                Check.ok(false, "unknown throw type \(sw.type)")
                continue
            }
            for (i, p) in g.feel.charges.enumerated() {
                let f = fly(type, release(sw.mapping, type, power: p, quality: 1, tilt: 0))
                let at = "\(sw.mapping) \(sw.type) charge \(p)"
                Check.near(f.carry, sw.carry[i], flightTol, "\(at) carry")
                Check.near(f.drift, sw.drift[i], flightTol, "\(at) drift")
                // One step of slack: the flight ends on a threshold, not on a step count.
                Check.near(f.hang, sw.hang[i], 2 * FIXED_DT, "\(at) hang")
            }
        }

        for pr in g.feel.tiltProbe {
            let f = fly(.backhand, humanReleaseParams(.backhand, power: 0.8, quality: 1, tilt: pr.tilt))
            Check.near(f.carry, pr.carry, flightTol, "tilt \(pr.tilt) carry")
            Check.near(f.drift, pr.drift, flightTol, "tilt \(pr.tilt) drift")
        }
        for pr in g.feel.qualityProbe {
            let f = fly(.backhand, humanReleaseParams(.backhand, power: 0.8, quality: pr.quality, tilt: 0))
            Check.near(f.carry, pr.carry, flightTol, "quality \(pr.quality) carry")
            Check.near(f.drift, pr.drift, flightTol, "quality \(pr.quality) drift")
        }
    }

    // MARK: - the claims the mapping makes in prose, asserted as flights

    private static func feel(_ g: File) {
        let charges = g.feel.charges

        // The speed ramp is only a ramp if the top is above the floor, and the `max(0,…)`
        // guard is only unreachable while that holds. It holds for all six today.
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
        Check.bitEqViaJSON(
            humanReleaseParams(.backhand, power: 0.8, quality: 1, tilt: 0).nose, 0,
            "a clean release has no added nose")
        Check.ok(
            humanReleaseParams(.backhand, power: 0.8, quality: 0, tilt: 0).nose > 0,
            "a sloppy release comes out nose up")
    }
}
