import Foundation
import UltimateSim

/// The throw table and `throwDisc`, against `src/sim/aero/Throws.ts`.
///
/// This suite exists because of a mistake worth not repeating. The flight view shipped
/// with four hand-made presets, one of them labelled "anhyzer" — which is disc golf
/// vocabulary that appears nowhere in this project, and which named a *bank angle* as
/// though it were a throw. **A backhand and a forehand differ by `spinSign`, not by
/// bank**: opposite spin, so they turn and fade opposite ways. Presets that only varied
/// the bank angle could not express a forehand at all, and nothing tested them.
///
/// So the fixtures cover every throw type at three power levels in both hands. Both
/// hands matters: handedness mirrors the spin sign *and* the bank, and getting one of
/// those two mirrors wrong is completely invisible in a right-handed-only fixture.
enum ThrowsTests {

    struct Release: Decodable {
        let pos: [Double]
        let vel: [Double]
        let orient: [Double]
        let omega: [Double]
        let alpha: Double
        let spin: Double
        let airspeed: Double
    }
    struct Sample: Decodable {
        let t: Double
        let pos: [Double]
        let atRest: Bool
    }
    struct Case: Decodable {
        let type: String
        let hand: String
        let power: Double
        let release: Release
        let samples: [Sample]
    }
    struct File: Decodable {
        let note: String
        let cases: [Case]
    }

    nonisolated(unsafe) static var worstPos = 0.0

    static func run() throws {
        let g = try Goldens.load(File.self, "throws")
        Check.eq(g.cases.count, 36, "six throws × two hands × three powers")

        for c in g.cases {
            guard let type = ThrowType(rawValue: c.type) else {
                Check.ok(false, "unknown throw type \(c.type)")
                continue
            }
            var opts = ThrowOptions()
            opts.hand = c.hand == "L" ? .left : .right

            var s = throwDisc(
                type, from: Vec3d(0, 1.6, 0), aim: Vec3d(1, 0, 0),
                power: c.power, angle: 0, spin: 0.5, options: opts)

            let at = "\(c.type)/\(c.hand)/p\(c.power)"

            // The release state is pure arithmetic plus a handful of transcendentals, so
            // it is asserted tightly — this is where a mirrored sign or a swapped spec
            // field shows up cleanly, before integration can smear it.
            expect(s.vel, c.release.vel, 1e-12, "\(at) release velocity")
            expect(s.omega, c.release.omega, 1e-12, "\(at) release omega")
            Check.near(s.spin, c.release.spin, 1e-12, "\(at) release spin")
            Check.near(s.airspeed, c.release.airspeed, 1e-12, "\(at) release airspeed")
            Check.near(s.alpha, c.release.alpha, 1e-9, "\(at) release alpha")

            // Orientation compared as a rotation, since ±q are the same rotation.
            let q = s.orient
            let dot = abs(
                q.x * c.release.orient[0] + q.y * c.release.orient[1]
                    + q.z * c.release.orient[2] + q.w * c.release.orient[3])
            Check.ok(dot >= 1 - 1e-9, "\(at) release orientation — |dot| \(dot)")

            var index = 0
            for i in 0..<480 {
                s.step(dt: FIXED_DT)
                if (i + 1) % 12 == 0 {
                    let want = c.samples[index]
                    let tol = 1e-9 * pow(10.0, want.t / 2.0)
                    for (axis, d) in zip(
                        ["x", "y", "z"],
                        [s.pos.x - want.pos[0], s.pos.y - want.pos[1], s.pos.z - want.pos[2]])
                    {
                        worstPos = Swift.max(worstPos, abs(d))
                        Check.ok(abs(d) <= tol, "\(at) t=\(want.t) pos.\(axis) off by \(d)")
                    }
                    Check.eq(s.atRest, want.atRest, "\(at) t=\(want.t) atRest")
                    index += 1
                }
            }
        }

        vocabularyAndPhysics()
        // `worstPos` is redundant with the report: every sample that could move it
        // already went through `Check.ok(abs(d) <= tol, ...)` above.
    }

    private static func expect(
        _ got: Vec3d, _ want: [Double], _ tol: Double, _ what: String
    ) {
        Check.near(got.x, want[0], tol, "\(what).x")
        Check.near(got.y, want[1], tol, "\(what).y")
        Check.near(got.z, want[2], tol, "\(what).z")
    }

    /// The claims the throw table makes in prose, asserted as behaviour.
    private static func vocabularyAndPhysics() {
        /// Fly to rest, and also hand back the RELEASE state.
        ///
        /// Both are needed and confusing them cost a round: `resolveGround` zeroes
        /// `omega` once the disc stops sliding, so the derived `spin` of a landed disc
        /// is 0 regardless of which way it was thrown. Spin claims must be read at
        /// release; travel claims at rest.
        func fly(_ type: ThrowType, hand: ThrowOptions.Hand = .right, power: Double = 1.0)
            -> (release: DiscState, rest: DiscState)
        {
            var opts = ThrowOptions()
            opts.hand = hand
            let released = throwDisc(
                type, from: Vec3d(0, 1.6, 0), aim: Vec3d(1, 0, 0),
                power: power, angle: 0, spin: 0.5, options: opts)
            var s = released
            for _ in 0..<(120 * 8) where !s.atRest { s.step(dt: FIXED_DT) }
            return (released, s)
        }

        // "Mirror of the backhand: opposite spin, so it turns and fades the other way."
        // This is the assertion that would have caught the preset mistake.
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

        // Handedness mirrors both the spin sign and the bank.
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

        // "Chest-height dump. Low speed, low spin, dies quickly."
        let push = fly(.push)
        Check.ok(
            Foundation.hypot(push.rest.pos.x, push.rest.pos.z)
                < Foundation.hypot(bh.rest.pos.x, bh.rest.pos.z),
            "a push travels less far than a backhand")

        // "Almost no vertical lift, so it knifes sideways and falls out of the sky."
        var blade = throwDisc(
            .blade, from: Vec3d(0, 1.6, 0), aim: Vec3d(1, 0, 0),
            power: 1, angle: 0, spin: 0.5)
        var bladePeak = blade.pos.y
        var bh2 = throwDisc(
            .backhand, from: Vec3d(0, 1.6, 0), aim: Vec3d(1, 0, 0),
            power: 1, angle: 0, spin: 0.5)
        var bhPeak = bh2.pos.y
        for _ in 0..<(120 * 8) {
            blade.step(dt: FIXED_DT)
            bh2.step(dt: FIXED_DT)
            bladePeak = Swift.max(bladePeak, blade.pos.y)
            bhPeak = Swift.max(bhPeak, bh2.pos.y)
        }
        Check.ok(
            abs(blade.pos.z) > abs(bh2.pos.z),
            "a blade deviates sideways more than a backhand")

        // Power is monotonic in distance for every throw. A spec with its speed range
        // transposed would still fly and would fail here.
        for type in ThrowType.allCases {
            let slow = fly(type, power: 0)
            let fast = fly(type, power: 1)
            Check.ok(
                Foundation.hypot(fast.rest.pos.x, fast.rest.pos.z)
                    > Foundation.hypot(slow.rest.pos.x, slow.rest.pos.z),
                "\(type.rawValue): more power goes further")
        }

        // The speed and spin lerps clamp rather than extrapolate.
        for type in ThrowType.allCases {
            let spec = THROW_SPECS[type]!
            Check.near(throwSpeed(type, -5), spec.speed.0, 1e-15, "\(type.rawValue) speed clamps low")
            Check.near(throwSpeed(type, 5), spec.speed.1, 1e-15, "\(type.rawValue) speed clamps high")
            Check.near(
                powerForSpeed(type, throwSpeed(type, 0.37)), 0.37, 1e-12,
                "\(type.rawValue) powerForSpeed inverts throwSpeed")
        }
    }
}
