import Foundation
import UltimateSim

/// The disc runtime — the bookkeeping layer between "a player wants to throw" and the
/// validated flight physics `FlightTests` already covers.
///
/// # Why this is not a replayed trace any more
///
/// `discruntime.json` held six multi-step traces: each one drove a runtime for hundreds of
/// fixed steps, scripted a catch or a block or a landing mid-flight, and dumped the whole
/// runtime every sixth frame for comparison against the TypeScript. That caught real bugs —
/// the trail is a ring buffer that only misbehaves once it is full or once samples start
/// ageing out, and `groundY` is re-queried from a closure every frame and does not reach
/// ground contact until later — by walking one path through the bookkeeping and comparing
/// every step of it. But it is still one recorded path, chosen once, and a bug in a
/// combination the recording never visited is invisible to it forever.
///
/// So this suite states what `DiscRuntime` actually is, in three registers:
///
///  - **A tiny, total state machine.** Three modes, three public transitions, each cell
///    driven from every starting mode. See `modeMachine()`.
///  - **Two subsystems with a specification worth restating independently.** The trail's
///    eviction rule (`decayTrail`) and the scuff geometry (`orientToNormal` +
///    `markScuff`) are both documented precisely enough in `DiscRuntime.swift`'s own
///    comments to write a second, independently-typed version of the rule and check the
///    real one against it — the same reasoning `RngTests.Model` uses for `xorshift128`,
///    and for the same benefit: a bug in the real implementation cannot hide behind a
///    matching bug in the check, because the two were written from the spec, not from
///    each other. Neither `orientToNormal` nor `decayTrail` is reachable from outside
///    `UltimateSim` — they are `internal`, not `public` — so this is arrived at through
///    `hold()`/`markScuff()`/`step()`, the same surface any real caller has.
///  - **Self-consistency, not re-derivation, for the two methods that touch the flight
///    integrator.** `predictPath` and `probeThrow` each keep their own scratch copy of
///    `DiscState` and step it by hand. Neither does anything to that copy that a caller
///    could not also do with the public `DiscState.step` — so both are checked by driving
///    an independent copy through the identical public sequence of calls and comparing
///    the two **bit-for-bit**. This is not a weaker check than a golden: unlike a
///    recorded value, it cannot go stale when the aero coefficients retune, and unlike a
///    reimplementation of RK4 it cannot acquire a transcription bug of its own — there is
///    only one flight model, called twice.
///
/// What this suite does NOT re-derive: RK4 itself, and ground-contact restitution
/// (`resolveGround`). Both are `FlightTests`' job — a disc released low comes to rest at
/// ground level is asserted there — and both are exactly the case that suite's own header
/// warns about: no independent second statement of either is worth writing, and forcing
/// one would risk the transcription bug the pattern exists to avoid. What `DiscRuntime`
/// adds on top of that physics — the clock, the mode gate, the trail, the scuff, the two
/// prediction queries — is what is asserted here.
///
/// # A trap avoided
///
/// The first draft of the trail model evicted by age using `clock`, the runtime's own
/// running total — and initially failed on nothing, which was the tell rather than the
/// reassurance (`FlightTests`' header describes the same shape of false confidence for a
/// mirror check that wasn't testing what it looked like it was). The reason: `clock` is
/// read AFTER `step()` has already advanced it, so an eviction computed against the
/// runtime's own post-step clock will always agree with the runtime's own post-step
/// eviction, however the eviction rule is written — even a `decayTrail` with the
/// comparison backwards would still "agree" with a check that copies the very value it
/// just produced. The model below is driven by the SUITE's own accumulated clock, kept as
/// a value the runtime never hands back, so the two really are two independent counts of
/// the same thing rather than one number compared to itself.
enum DiscRuntimeTests {

    // MARK: - a deterministic sample source, for sweeps wider than a hand-written grid

    /// A 64-bit xorshift, independent of `UltimateSim.Rng` for the same reason
    /// `GameStateTests.Sample` is: a suite that chooses its own inputs with the thing it
    /// is testing is not choosing them independently.
    private struct Sample {
        private var s: UInt64
        init(_ seed: UInt64) { s = seed | 1 }
        mutating func next() -> UInt64 {
            s ^= s << 13
            s ^= s >> 7
            s ^= s << 17
            return s
        }
        mutating func unit(_ lo: Double, _ hi: Double) -> Double {
            lo + (hi - lo) * Double(next() >> 11) * (1.0 / 9_007_199_254_740_992.0)
        }
        mutating func int(_ lo: Int, _ hi: Int) -> Int {
            lo + Int(next() % UInt64(hi - lo + 1))
        }
        mutating func bool() -> Bool { next() & 1 == 1 }
    }

    // MARK: - ground closures

    /// The two ground shapes exercised throughout. Built from `+ − ×` and `max` only,
    /// deliberately: a `sin`/`cos` terrain would put every check behind a tolerance for a
    /// reason that has nothing to do with the disc runtime.
    static func ground(_ name: String) -> (Double, Double) -> Double {
        switch name {
        case "sloped":
            return { x, z in 0.03 * x - 0.02 * z + 0.25 * Swift.max(0, 1 - 0.05 * (x * x + z * z)) }
        default:
            return { _, _ in 0 }
        }
    }

    // MARK: - run

    static func run() throws {
        defaults()
        modeMachine()
        trailLaws()
        scuffLaws()
        predictionLaws()
        probeLaws()
        boundaryLaw()
        proseClaims()
    }

    // MARK: - defaults, pinned directly

    /// A fresh runtime's defaults are constants `DiscRuntime` declares itself, so — per
    /// issue #58's standing finding — they are pinned by value here, not only checked for
    /// existence. `AIMathTests` once asserted `CATCH_DEAD < CATCH_FLOOR`, which survived
    /// `CATCH_DEAD` moving; the fixtures that pinned the actual number are exactly what is
    /// being deleted, which is the failure mode this guards against for these constants.
    private static func defaults() {
        let rt = DiscRuntime()
        Check.eq(rt.mode, .ground, "a fresh runtime starts on the ground")
        Check.eq(rt.holderId, -1, "a fresh runtime is held by nobody")
        Check.eq(rt.lastThrowTeam, 0, "default last-throw team is 0")
        Check.bitEq(rt.sinceRelease, 1e3, "sinceRelease starts enormous — never self-caught")
        Check.bitEq(rt.wear, 0, "a fresh disc is unworn")
        Check.eq(rt.trailCapacity, 72, "default trail capacity")
        Check.bitEq(rt.trailSeconds, 0.80, "default trail seconds")
        Check.bitEq(rt.now, 0, "the clock starts at zero")
        Check.bitEq(rt.trailAge, 1e3, "an empty trail reports the sentinel age, not NaN")
        Check.bitEq(rt.wind.x, 0, "default wind x")
        Check.bitEq(rt.wind.y, 0, "default wind y")
        Check.bitEq(rt.wind.z, 0, "default wind z")
        for (x, z) in [(0.0, 0.0), (3.0, -4.0), (117.0, -52.0)] {
            Check.bitEq(rt.groundAt(x, z), 0, "the default ground query is flat everywhere (\(x), \(z))")
        }
        Check.eq(rt.state.atRest, false, "a fresh state is not at rest")
        Check.eq(rt.state.touchedGround, false, "a fresh state has not touched ground")
        Check.eq(rt.trail.isEmpty, true, "a fresh runtime has no trail")
    }

    // MARK: - the mode machine: three states, three total transitions

    /// `DiscMode` has exactly three values and exactly three public ways to change it —
    /// `hold`, `settle`, `release` — and every one of them is unconditional: the mode it
    /// names is where the runtime lands, regardless of where it started. That is small
    /// enough to drive every cell for real rather than sample it, the way
    /// `GameStateTests.everyCellOfTheTransitionTableIsDriven` does for the ten-phase game
    /// machine.
    private static func modeMachine() {
        func fresh(_ mode: DiscMode) -> DiscRuntime {
            let rt = DiscRuntime()
            switch mode {
            case .ground:
                rt.settle(Vec3d(-3, 0, 5))
            case .held:
                rt.hold(11, Vec3d(2, 1.1, -2), Vec3d(0, 1, 0), 0.2)
            case .flight:
                _ = rt.release(
                    ThrowRequest(
                        type: .backhand, from: Vec3d(0, 1.5, 0), aim: Vec3d(1, 0, 0),
                        power: 0.5, angle: 0, spin: 0.5))
            }
            return rt
        }

        var cells = 0
        for start: DiscMode in [.ground, .held, .flight] {
            // hold() — always lands in .held, always takes the caller's id/pos/normal,
            // always clears vel/omega, always clears the trail.
            do {
                let rt = fresh(start)
                rt.hold(5, Vec3d(4, 1.2, -1), Vec3d(0.3, 0.9, 0), 0.7)
                Check.eq(rt.mode, .held, "from \(start): hold() lands in held")
                Check.eq(rt.holderId, 5, "from \(start): hold() sets the caller's holder id")
                Check.bitEq(rt.state.pos.x, 4, "from \(start): hold() places x")
                Check.bitEq(rt.state.pos.y, 1.2, "from \(start): hold() places y")
                Check.bitEq(rt.state.pos.z, -1, "from \(start): hold() places z")
                Check.bitEq(rt.state.vel.x, 0, "from \(start): hold() zeroes vel.x")
                Check.bitEq(rt.state.vel.y, 0, "from \(start): hold() zeroes vel.y")
                Check.bitEq(rt.state.vel.z, 0, "from \(start): hold() zeroes vel.z")
                Check.eq(rt.state.atRest, false, "from \(start): a held disc is not at rest")
                Check.eq(rt.state.touchedGround, false, "from \(start): a held disc has not touched ground")
                Check.eq(rt.trail.isEmpty, true, "from \(start): hold() clears the trail")
                cells += 1
            }
            // settle() — always lands in .ground, at the target xz and groundAt(target) +
            // halfHeight, at rest, having touched ground, WITHOUT clearing the trail.
            do {
                let rt = fresh(start)
                rt.groundAt = { x, z in 1.5 + 0.1 * x - 0.2 * z }
                let before = rt.trail
                rt.settle(Vec3d(6, 99, -8))
                Check.eq(rt.mode, .ground, "from \(start): settle() lands on the ground")
                Check.eq(rt.holderId, -1, "from \(start): settle() releases any holder")
                Check.bitEq(rt.state.pos.x, 6, "from \(start): settle() places x")
                Check.bitEq(
                    rt.state.pos.y, 1.5 + 0.1 * 6 - 0.2 * -8 + DiscBody.standard.halfHeight,
                    "from \(start): settle() rests on the target's own ground height")
                Check.bitEq(rt.state.pos.z, -8, "from \(start): settle() places z")
                Check.eq(rt.state.atRest, true, "from \(start): a settled disc is at rest")
                Check.eq(rt.state.touchedGround, true, "from \(start): a settled disc has touched ground")
                Check.eq(rt.trail.count, before.count, "from \(start): settle() does not clear the trail")
                cells += 1
            }
            // release() — always lands in .flight, always frees any holder, always resets
            // sinceRelease to exactly zero, always starts a fresh one-sample trail.
            do {
                let rt = fresh(start)
                let v = rt.release(
                    ThrowRequest(
                        type: .forehand, from: Vec3d(1, 1.4, 2), aim: Vec3d(0, 0, 1),
                        power: 0.6, angle: 0, spin: 0.5, hand: .right))
                Check.eq(rt.mode, .flight, "from \(start): release() lands in flight")
                Check.eq(rt.holderId, -1, "from \(start): release() frees any holder")
                Check.bitEq(rt.sinceRelease, 0, "from \(start): release() resets the release timer")
                Check.eq(rt.trail.count, 1, "from \(start): release() starts a fresh one-sample trail")
                Check.eq(rt.state.atRest, false, "from \(start): a released disc is not at rest")
                Check.eq(rt.state.touchedGround, false, "from \(start): a released disc has not touched ground")
                Check.bitEq(v.x, rt.state.vel.x, "from \(start): the returned velocity is state.vel.x")
                Check.bitEq(v.y, rt.state.vel.y, "from \(start): the returned velocity is state.vel.y")
                Check.bitEq(v.z, rt.state.vel.z, "from \(start): the returned velocity is state.vel.z")
                cells += 1
            }
        }
        Check.eq(cells, 9, "every one of the nine (mode × transition) cells was driven")

        // The reference's `release()` hands back a module-scratch vector that the NEXT
        // release on ANY runtime overwrites out from under the caller — documented in
        // `DiscRuntime.swift` as a latent bug preserved as a comment, not as behaviour,
        // because Swift's `Vec3d` is a value. Assert the value semantics directly: take a
        // release's returned velocity, release a SECOND, unrelated runtime, and confirm
        // the first value is untouched.
        let a = DiscRuntime()
        let va = a.release(
            ThrowRequest(type: .backhand, from: .zero, aim: Vec3d(1, 0, 0), power: 0.7, angle: 0, spin: 0.5))
        let b = DiscRuntime()
        _ = b.release(
            ThrowRequest(type: .hammer, from: Vec3d(9, 9, 9), aim: Vec3d(0, 0, 1), power: 0.9, angle: 0, spin: 0.5))
        Check.bitEq(va.x, a.state.vel.x, "a release's returned velocity survives a second runtime's release")
        Check.bitEq(va.y, a.state.vel.y, "…in y")
        Check.bitEq(va.z, a.state.vel.z, "…in z")

        // "The game system is the single driver": a runtime not in flight does no physics,
        // however hard it is stepped, in EITHER of the two non-flight modes.
        for start: DiscMode in [.held, .ground] {
            let rt = fresh(start)
            let before = rt.state.pos
            for _ in 0..<300 { rt.step(dt: FIXED_DT) }
            Check.bitEq(rt.state.pos.x, before.x, "mode \(start): step() does not move x")
            Check.bitEq(rt.state.pos.y, before.y, "mode \(start): step() does not move y")
            Check.bitEq(rt.state.pos.z, before.z, "mode \(start): step() does not move z")
            Check.bitEq(rt.state.t, 0, "mode \(start): a runtime that never flew accrues no flight time")
        }
    }

    // MARK: - the trail ring buffer, against an independent model of its eviction rule

    /// `decayTrail`'s rule, transcribed from `DiscRuntime.swift`'s own comment rather than
    /// called — it is `private`, unreachable from this module — and driven by a clock this
    /// suite accumulates itself, not one read back off the runtime. See the header for why
    /// that distinction is the one that makes this a real second implementation rather
    /// than a value compared to itself.
    private struct TrailModel {
        var entries: [(t: Double, x: Double, y: Double, z: Double, speed: Double)] = []

        mutating func clear() { entries.removeAll() }

        mutating func push(_ e: (t: Double, x: Double, y: Double, z: Double, speed: Double)) {
            entries.append(e)
        }

        /// `cut = now - trailSeconds`; drop every leading entry older than the cut, THEN
        /// drop from the front again down to capacity. Same order as `decayTrail`: age
        /// first, capacity second.
        mutating func evict(now: Double, seconds: Double, capacity: Int) {
            let cut = now - seconds
            var drop = 0
            while drop < entries.count && entries[drop].t < cut { drop += 1 }
            if drop > 0 { entries.removeFirst(drop) }
            while entries.count > capacity { entries.removeFirst() }
        }
    }

    private static func assertTrailMatches(_ rt: DiscRuntime, _ model: TrailModel, _ at: String) {
        Check.eq(rt.trail.count, model.entries.count, "\(at) trail count")
        let n = Swift.min(rt.trail.count, model.entries.count)
        for k in 0..<n {
            let got = rt.trail[k]
            let want = model.entries[k]
            Check.bitEq(got.t, want.t, "\(at) sample \(k) t")
            Check.bitEq(got.x, want.x, "\(at) sample \(k) x")
            Check.bitEq(got.y, want.y, "\(at) sample \(k) y")
            Check.bitEq(got.z, want.z, "\(at) sample \(k) z")
            Check.bitEq(got.speed, want.speed, "\(at) sample \(k) speed")
        }
        Check.ok(rt.trail.count <= rt.trailCapacity, "\(at) never exceeds capacity")
        if let oldest = rt.trail.first {
            Check.ok(
                rt.now - oldest.t <= rt.trailSeconds + 1e-9,
                "\(at) the oldest sample is within the seconds budget")
        }
    }

    private static func trailLaws() {
        struct Config {
            let name: String
            let ground: String
            let capacity: Int
            let seconds: Double
            let preHoldFrames: Int
            let flightFrames: Int
            let settleAt: Int?  // frame at which to settle (keeps the trail) then continue
            let holdAt: Int?  // frame at which to hold (clears the trail) then continue
        }
        let configs = [
            Config(
                name: "capacity binds, seconds never does", ground: "flat", capacity: 9,
                seconds: 10, preHoldFrames: 0, flightFrames: 200, settleAt: nil, holdAt: nil),
            Config(
                name: "seconds binds, capacity never does", ground: "sloped", capacity: 500,
                seconds: 0.1, preHoldFrames: 0, flightFrames: 180, settleAt: nil, holdAt: nil),
            Config(
                name: "both bind, at different frames", ground: "flat", capacity: 16,
                seconds: 0.2, preHoldFrames: 0, flightFrames: 260, settleAt: nil, holdAt: nil),
            Config(
                name: "settle keeps the trail decaying by age", ground: "sloped",
                capacity: 40, seconds: 0.5, preHoldFrames: 0, flightFrames: 260,
                settleAt: 140, holdAt: nil),
            Config(
                name: "a catch mid-flight clears the trail outright", ground: "flat",
                capacity: 30, seconds: 5, preHoldFrames: 12, flightFrames: 150,
                settleAt: nil, holdAt: 80),
        ]

        for cfg in configs {
            let rt = DiscRuntime()
            rt.groundAt = ground(cfg.ground)
            rt.wind = Vec3d(0.4, 0, -0.3)
            rt.trailCapacity = cfg.capacity
            rt.trailSeconds = cfg.seconds
            var model = TrailModel()
            var clock = 0.0

            if cfg.preHoldFrames > 0 {
                rt.hold(2, Vec3d(0, 1.2, 0), Vec3d(0, 1, 0), 0)
                model.clear()
                for i in 0..<cfg.preHoldFrames {
                    rt.step(dt: FIXED_DT)
                    clock += FIXED_DT
                    model.evict(now: clock, seconds: cfg.seconds, capacity: cfg.capacity)
                    assertTrailMatches(rt, model, "\(cfg.name) pre-hold \(i)")
                }
            }

            _ = rt.release(
                ThrowRequest(
                    type: .backhand, from: Vec3d(0, 1.6, 0), aim: Vec3d(1, 0, 0.2),
                    power: 0.6, angle: 0.04, spin: 0.55))
            model.clear()
            model.push(
                (t: rt.trail[0].t, x: rt.trail[0].x, y: rt.trail[0].y, z: rt.trail[0].z,
                 speed: rt.trail[0].speed))
            model.evict(now: clock, seconds: cfg.seconds, capacity: cfg.capacity)
            assertTrailMatches(rt, model, "\(cfg.name) release")

            for i in 1...cfg.flightFrames {
                if let settleAt = cfg.settleAt, i == settleAt {
                    rt.settle(rt.state.pos)
                    // settle() does not clear the trail — model unchanged here.
                }
                if let holdAt = cfg.holdAt, i == holdAt {
                    rt.hold(3, rt.state.pos, Vec3d(0, 1, 0), 0)
                    model.clear()
                }
                let wasFlight = rt.mode == .flight
                rt.step(dt: FIXED_DT)
                clock += FIXED_DT
                if wasFlight, let last = rt.trail.last {
                    model.push((t: last.t, x: last.x, y: last.y, z: last.z, speed: last.speed))
                }
                model.evict(now: clock, seconds: cfg.seconds, capacity: cfg.capacity)
                assertTrailMatches(rt, model, "\(cfg.name) frame \(i)")
            }
        }
        Check.eq(configs.count, 5, "every trail configuration ran")
    }

    // MARK: - scuff geometry and wear, against an independent model of the spec

    /// `orientToNormal` and `markScuff`, transcribed from `DiscRuntime.swift`'s own
    /// documentation rather than called — both are `internal`, unreachable outside
    /// `UltimateSim`, so `hold()` + `markScuff()` is the only way in from here, exactly as
    /// for any real caller.
    ///
    /// `hypot2` here is plain `Foundation.hypot`, not `jsHypot2` — this suite cannot reach
    /// `jsHypot2` either, and does not need to: the geometry is one transcendental deep
    /// (`sin`/`cos` of the phase, and the final `atan2`), not RK4's hundreds, so a
    /// tolerance of 1e-12 comfortably separates "different rounding" from "wrong
    /// formula." The 0.055 wear-per-strike and 1.05 radius-fudge below are transcribed
    /// values, not references to a symbol — `markScuff` has no exported constant for
    /// either — so a production edit to either literal is exactly what this model will
    /// stop agreeing with, which is the pinning issue #58 asks for where there is no
    /// named symbol to pin.
    private enum ScuffModel {
        static func orient(normal: Vec3d, phase: Double) -> Quatd {
            var n = normal.normalized
            if n.lengthSq < 1e-6 { n = Vec3d(0, 1, 0) }
            let q1 = Quatd.fromUnitVectors(Vec3d(0, 0, 1), n)
            let q2 = Quatd.fromAxisAngle(Vec3d(0, 0, 1), phase)
            return (q1 * q2).normalized
        }

        static func scuff(orient: Quatd) -> (rr: Double, ang: Double, top: Bool) {
            let n = Vec3d(0, 0, 1).applying(orient)
            let top = n.y >= 0
            let down = Vec3d(0, -1, 0).applying(orient.conjugated)
            let rr = clamp(Foundation.hypot(down.x, down.y) * 1.05, 0, 1)
            let ang = Foundation.atan2(down.y, down.x)
            return (rr, ang, !top)
        }

        static func wear(_ prev: Double, strength: Double) -> Double {
            clamp(prev + strength * 0.055, 0, 1)
        }
    }

    private static func scuffLaws() {
        var rng = Sample(0xD15C)
        var cases: [(normal: Vec3d, phase: Double)] = [
            // Hand-picked to reach both faces, the clamp, and the degenerate fallback.
            (Vec3d(0, 1, 0), 0), (Vec3d(0, -1, 0), 0),
            (Vec3d(1, 0, 0), 0),  // in-plane normal: forces rr toward/at the clamp
            (Vec3d(0, 0, 1), 1.1),
            (Vec3d(0, 0, 0), 0.4),  // degenerate — falls back to world up
        ]
        for _ in 0..<250 {
            cases.append(
                (Vec3d(rng.unit(-1, 1), rng.unit(-1, 1), rng.unit(-1, 1)), rng.unit(-.pi, .pi)))
        }

        var sawClamp = false
        for (i, c) in cases.enumerated() {
            let rt = DiscRuntime()
            rt.groundAt = ground("flat")
            rt.hold(1, Vec3d(0, 1, 0), c.normal, c.phase)

            // hold() itself: the disc's face points at the requested normal (or world up,
            // for the degenerate input).
            let wantOrient = ScuffModel.orient(normal: c.normal, phase: c.phase)
            let d = rt.state.orient.x * wantOrient.x + rt.state.orient.y * wantOrient.y
                + rt.state.orient.z * wantOrient.z + rt.state.orient.w * wantOrient.w
            let sign = d < 0 ? -1.0 : 1.0
            let at = "scuff \(i) normal=\(c.normal) phase=\(c.phase)"
            Check.near(sign * rt.state.orient.x, wantOrient.x, 1e-12, "\(at) orient.x")
            Check.near(sign * rt.state.orient.y, wantOrient.y, 1e-12, "\(at) orient.y")
            Check.near(sign * rt.state.orient.z, wantOrient.z, 1e-12, "\(at) orient.z")
            Check.near(sign * rt.state.orient.w, wantOrient.w, 1e-12, "\(at) orient.w")

            var wantWear = 0.0
            for (k, strength) in [0.6, 0.9, 0.3].enumerated() {
                rt.markScuff(strength)
                wantWear = ScuffModel.wear(wantWear, strength: strength)
                let want = ScuffModel.scuff(orient: wantOrient)
                let got = rt.pendingScuff!
                Check.near(got.rr, want.rr, 1e-12, "\(at) strike \(k) rr")
                Check.near(got.ang, want.ang, 1e-12, "\(at) strike \(k) ang")
                Check.eq(got.top, want.top, "\(at) strike \(k) which face struck")
                Check.bitEq(got.strength, strength, "\(at) strike \(k) strength recorded as given")
                Check.bitEq(rt.wear, wantWear, "\(at) strike \(k) wear accumulates per the model")
                if want.rr >= 1 - 1e-9 { sawClamp = true }
            }
        }
        Check.eq(cases.count, 255, "the scuff sweep ran every case")
        Check.ok(sawClamp, "the sweep actually reached the rr clamp at least once")

        // Wear saturates at 1 and stays there — a thousand full-strength strikes, model
        // and runtime compared at every single one.
        let rt = DiscRuntime()
        rt.hold(1, Vec3d(0, 1, 0), Vec3d(0, 1, 0), 0)
        var w = 0.0
        for i in 0..<1000 {
            rt.markScuff(1)
            w = ScuffModel.wear(w, strength: 1)
            Check.bitEq(rt.wear, w, "wear after strike \(i) matches the model")
        }
        Check.bitEq(rt.wear, 1, "wear saturates at exactly one")
    }

    // MARK: - predictPath, against an independently driven copy of the same physics

    private static func predictionLaws() {
        // The bounds a caller cannot escape, whatever it asks for.
        do {
            let rt = DiscRuntime()
            _ = rt.release(
                ThrowRequest(
                    type: .backhand, from: Vec3d(0, 30, 0), aim: Vec3d(1, 0, 0),
                    power: 1, angle: 0.3, spin: 1))
            Check.eq(
                rt.predictPath(horizon: 1e6, step: 1e-9).count, 241,
                "a huge horizon and a tiny step still cost at most 240 integrations")
            Check.eq(
                rt.predictPath(horizon: -5, step: 1e9).count, 3,
                "a negative horizon still returns the floor of two steps plus the origin")
            Check.ok(
                rt.predictPath(horizon: 0, step: 0).count >= 2,
                "predictPath always returns at least two points")
        }

        /// Drive `p` through exactly the sequence `predictPath` documents: the horizon
        /// floor and the step clamp applied first, then re-querying `groundAt` every
        /// iteration, stopping early on ground contact. `rt` is untouched by this.
        func replicate(
            _ rt: DiscRuntime, seed p0: DiscState, horizon: Double, step: Double
        ) -> [(t: Double, x: Double, y: Double, z: Double)] {
            var p = p0
            p.touchedGround = false
            p.atRest = false
            var out: [(Double, Double, Double, Double)] = [(0, p.pos.x, p.pos.y, p.pos.z)]
            let dt = Swift.max(FIXED_DT, Swift.min(1.0 / 20.0, step))
            let n = Swift.max(2, Swift.min(240, Int((Swift.max(0.1, horizon) / dt).rounded())))
            for i in 1...n {
                p.groundY = rt.groundAt(p.pos.x, p.pos.z)
                p.step(dt: dt, wind: rt.wind, coeffs: rt.coeffs, body: rt.body)
                out.append((Double(i) * dt, p.pos.x, p.pos.y, p.pos.z))
                if p.touchedGround { break }
            }
            return out
        }

        func compare(_ got: [FlightSample], _ want: [(Double, Double, Double, Double)], _ at: String) {
            Check.eq(got.count, want.count, "\(at) sample count")
            for i in 0..<Swift.min(got.count, want.count) {
                Check.bitEq(got[i].t, want[i].0, "\(at) sample \(i) t")
                Check.bitEq(got[i].x, want[i].1, "\(at) sample \(i) x")
                Check.bitEq(got[i].y, want[i].2, "\(at) sample \(i) y")
                Check.bitEq(got[i].z, want[i].3, "\(at) sample \(i) z")
            }
        }

        let scenarios:
            [(String, String, Vec3d, ThrowType, Int, Double, Double)] = [
                ("flat, mid-flight, coarse step", "flat", Vec3d(0.5, 0, 0), .backhand, 40, 2.5, 1.0 / 30),
                ("sloped, wind, fine step", "sloped", Vec3d(-0.8, 0, 1.2), .hammer, 90, 4, 1.0 / 120),
                ("just after release", "flat", .zero, .blade, 1, 1.0, 1.0 / 60),
                ("long horizon", "sloped", Vec3d(0.2, 0, -0.6), .scoober, 150, 6, 1.0 / 30),
            ]
        for (name, gname, wind, type, warmup, horizon, step) in scenarios {
            let rt = DiscRuntime()
            rt.groundAt = ground(gname)
            rt.wind = wind
            _ = rt.release(
                ThrowRequest(
                    type: type, from: Vec3d(0, 1.6, 0), aim: Vec3d(1, 0, 0.3),
                    power: 0.65, angle: 0.03, spin: 0.55))
            for _ in 0..<warmup { rt.step(dt: FIXED_DT) }
            let got = rt.predictPath(horizon: horizon, step: step)
            let want = replicate(rt, seed: rt.state, horizon: horizon, step: step)
            compare(got, want, "predictPath live: \(name)")
        }

        // Off-flight: the caller's pos/vel seed the copy, but orientation and angular
        // velocity still come from the runtime's own state, per `DiscRuntime.swift`.
        do {
            let rt = DiscRuntime()
            rt.groundAt = ground("sloped")
            rt.wind = Vec3d(0.3, 0, 0.1)
            _ = rt.release(
                ThrowRequest(
                    type: .push, from: Vec3d(0, 1.3, 0), aim: Vec3d(1, 0, 0),
                    power: 0.5, angle: 0, spin: 0.4))
            for _ in 0..<10 { rt.step(dt: FIXED_DT) }
            rt.settle(rt.state.pos)
            let callerPos = Vec3d(-12, 8, 5)
            let callerVel = Vec3d(3, -6, 1)
            let got = rt.predictPath(pos: callerPos, vel: callerVel, horizon: 2.2, step: 1.0 / 45)
            var seed = rt.state
            seed.pos = callerPos
            seed.vel = callerVel
            let want = replicate(rt, seed: seed, horizon: 2.2, step: 1.0 / 45)
            compare(got, want, "predictPath off-flight")
        }

        // Live flight ignores the caller's guess entirely.
        do {
            let rt = DiscRuntime()
            _ = rt.release(
                ThrowRequest(
                    type: .backhand, from: Vec3d(0, 1.6, 0), aim: Vec3d(1, 0, 0),
                    power: 0.6, angle: 0.05, spin: 0.5))
            for _ in 0..<30 { rt.step(dt: FIXED_DT) }
            let ours = rt.predictPath(horizon: 2, step: 1.0 / 30.0)
            let theirs = rt.predictPath(
                pos: Vec3d(-40, 25, 17), vel: Vec3d(-3, -9, 2), horizon: 2, step: 1.0 / 30.0)
            for k in 0..<ours.count {
                Check.bitEq(theirs[k].x, ours[k].x, "live flight ignores the caller's x")
                Check.bitEq(theirs[k].y, ours[k].y, "live flight ignores the caller's y")
                Check.bitEq(theirs[k].z, ours[k].z, "live flight ignores the caller's z")
            }
        }

        // The `DiscPeer` conformance is the same call, so the AI cannot get a different
        // answer from the one the game gets.
        do {
            let rt = DiscRuntime()
            _ = rt.release(
                ThrowRequest(
                    type: .hammer, from: Vec3d(1, 1.8, 2), aim: Vec3d(0, 0, 1),
                    power: 0.7, angle: 0, spin: 0.5))
            rt.settle(Vec3d(1, 0, 2))
            var ai = AIDiscState()
            ai.pos = Vec3d(4, 6, -2)
            ai.vel = Vec3d(1, 2, 3)
            let peer: DiscPeer = rt
            let viaPeer = peer.predictPath(ai, horizon: 3, step: 1.0 / 40.0)
            let direct = rt.predictPath(pos: ai.pos, vel: ai.vel, horizon: 3, step: 1.0 / 40.0)
            Check.eq(viaPeer.count, direct.count, "the peer contract returns the same path length")
            for k in 0..<viaPeer.count {
                Check.bitEq(viaPeer[k].x, direct[k].x, "peer sample \(k) x")
                Check.bitEq(viaPeer[k].y, direct[k].y, "peer sample \(k) y")
                Check.bitEq(viaPeer[k].z, direct[k].z, "peer sample \(k) z")
            }
        }
    }

    // MARK: - probeThrow, against an independently driven copy of the same physics

    /// `probeThrow` keeps its own scratch `DiscState`, built by the same `throwDisc` call
    /// `release()` makes, and steps it with the same per-frame `groundAt` re-query
    /// `DiscRuntime.step()` uses. That means a second runtime driven by hand through the
    /// public `release()` + `step()` sequence has to reach the identical crossing frame,
    /// bit for bit — there is only one flight model and one ground query, called through
    /// two different call sites. This is the check that would catch `req.speed` silently
    /// stopping being forwarded, which is exactly the regression `DiscRuntime.swift`'s own
    /// header records having happened once.
    private static func probeLaws() {
        let grounds: [(String, (Double, Double) -> Double)] = [
            ("flat", ground("flat")), ("sloped", ground("sloped")),
        ]
        let winds = [Vec3d.zero, Vec3d(0.8, 0, -0.4), Vec3d(-1.2, 0, 0.6)]
        let catchYs = [1.9, 1.35, 0.85, 0.25]

        var swept = 0
        for (gname, g) in grounds {
            for type in ThrowType.allCases {
                for wind in winds {
                    for catchY in catchYs {
                        swept += 1
                        let req = ThrowRequest(
                            type: type, from: Vec3d(-1, 1.55, -8), aim: Vec3d(0.3, 0, 1),
                            power: 0.65, angle: 0.02, spin: 0.5,
                            hand: type == .forehand ? .left : .right, bank: 0.05, nose: -0.01,
                            speed: 31)

                        let rt = DiscRuntime()
                        rt.groundAt = g
                        rt.wind = wind
                        let ans = rt.probeThrow(req, catchY: catchY, maxT: 5)

                        let replay = DiscRuntime()
                        replay.groundAt = g
                        replay.wind = wind
                        _ = replay.release(req)
                        var prevY = replay.state.pos.y
                        let steps = Int((5.0 / FIXED_DT).rounded())
                        for _ in 0..<steps {
                            replay.step(dt: FIXED_DT)
                            if (replay.state.pos.y <= catchY && prevY > catchY) || replay.state.touchedGround {
                                break
                            }
                            prevY = replay.state.pos.y
                        }
                        let at = "probe \(type)/\(gname) wind=\(wind) catchY=\(catchY)"
                        Check.bitEq(ans.t, replay.state.t, "\(at) crossing time matches an independent replay")
                        Check.bitEq(ans.x, replay.state.pos.x, "\(at) crossing x")
                        Check.bitEq(ans.z, replay.state.pos.z, "\(at) crossing z")

                        // dist/lat is a rotation of (dx, dz) onto the aim line, which
                        // preserves length whenever the aim has a real horizontal part.
                        let dx = ans.x - req.from.x, dz = ans.z - req.from.z
                        let h = Foundation.hypot(req.aim.x, req.aim.z)
                        if h > 1e-9 {
                            let mag = dx * dx + dz * dz
                            Check.near(
                                ans.dist * ans.dist + ans.lat * ans.lat, mag,
                                Swift.max(1e-9, mag * 1e-9),
                                "\(at) the aim-line projection preserves distance")
                        }
                    }
                }
            }
        }
        Check.eq(swept, grounds.count * ThrowType.allCases.count * winds.count * catchYs.count,
                  "the probe sweep ran every combination")

        // Degenerate aim: `hypot(hx, hz) || 1` is the guard, and a purely vertical aim is
        // the only thing that reaches it — dist/lat collapse to exactly zero regardless of
        // where the disc actually goes.
        do {
            let rt = DiscRuntime()
            rt.groundAt = ground("flat")
            let req = ThrowRequest(
                type: .backhand, from: Vec3d(0, 1.5, 0), aim: Vec3d(0, 1, 0),
                power: 0.5, angle: 0, spin: 0.5)
            let r = rt.probeThrow(req, catchY: 1.2, maxT: 4)
            Check.bitEq(r.dist, 0, "straight-up aim: dist is exactly zero")
            Check.bitEq(r.lat, 0, "straight-up aim: lat is exactly zero")
        }

        // Aim exactly along +x: the projection basis is the identity, so dist/lat equal
        // dx/dz exactly, bit for bit — no hypot rounding anywhere in the way.
        do {
            let rt = DiscRuntime()
            rt.groundAt = ground("flat")
            let req = ThrowRequest(
                type: .backhand, from: Vec3d(2, 1.5, 3), aim: Vec3d(1, 0, 0),
                power: 0.6, angle: 0.05, spin: 0.5)
            let r = rt.probeThrow(req, catchY: 1.0, maxT: 5)
            Check.bitEq(r.dist, r.x - req.from.x, "aim along +x: dist is exactly dx")
            Check.bitEq(r.lat, r.z - req.from.z, "aim along +x: lat is exactly dz")
        }
    }

    // MARK: - a light integration touch: a real flight feeding the field's own geometry

    /// `isInBounds`/`boundaryCrossing` are `RulesTests`' subsystem, exhaustively covered
    /// there. What is genuinely `DiscRuntime`'s to prove is narrower: that a disc it
    /// actually flies, fed into that geometry, produces a crossing that really sits on the
    /// edge it claims and really lies within the stepped segment.
    private static func boundaryLaw() {
        let rt = DiscRuntime()
        rt.groundAt = ground("flat")
        rt.wind = Vec3d(0, 0, 2.0)
        _ = rt.release(
            ThrowRequest(
                type: .backhand, from: Vec3d(14, 1.6, -10), aim: Vec3d(1, 0, 0.6),
                power: 0.5, angle: 0.12, spin: 0.7, speed: 30))
        var prev = rt.state.pos
        var crossing: Crossing? = nil
        var left = false
        for _ in 1...300 {
            rt.step(dt: FIXED_DT)
            if !FieldConstants.standard.isInBounds(rt.state.pos) {
                left = true
                crossing = FieldConstants.standard.boundaryCrossing(prev, rt.state.pos)
                break
            }
            prev = rt.state.pos
        }
        Check.ok(left, "a wide, wind-assisted pull leaves the regulation field")
        guard let c = crossing else {
            Check.ok(false, "boundaryCrossing finds the exit the flown disc actually made")
            return
        }
        switch c.edge {
        case .sidelinePlusX:
            Check.near(c.point.x, FieldConstants.standard.sideline, 1e-9, "crossing sits on the +x sideline")
        case .sidelineMinusX:
            Check.near(c.point.x, -FieldConstants.standard.sideline, 1e-9, "crossing sits on the -x sideline")
        case .endlinePlusZ:
            Check.near(c.point.z, FieldConstants.standard.endLine, 1e-9, "crossing sits on the +z end line")
        case .endlineMinusZ:
            Check.near(c.point.z, -FieldConstants.standard.endLine, 1e-9, "crossing sits on the -z end line")
        }
        Check.inRange(c.t, 0, 1, "the crossing parameter falls within the stepped segment")
    }

    // MARK: - the module's remaining prose, asserted as behaviour

    /// What is left here is what the sections above do not already cover: parking a
    /// pathological release, and `groundAt` being threaded rather than global. Both would
    /// survive a retune of the flight model, and if they ever disagree with the assertions
    /// above, believe these.
    private static func proseClaims() {
        // "A non-finite state can only come from a pathological release; park it rather
        // than poisoning every consumer downstream."
        do {
            let rt = DiscRuntime()
            rt.groundAt = { _, _ in 1.25 }
            _ = rt.release(
                ThrowRequest(
                    type: .forehand, from: Vec3d(0, 3, 0), aim: Vec3d(1, 0, 0),
                    power: 0.5, angle: 0, spin: 0.5))
            rt.step(dt: FIXED_DT)
            rt.state.vel = Vec3d(.nan, 0, 0)
            rt.step(dt: FIXED_DT)
            Check.ok(rt.state.isFinite, "a poisoned state is parked, not propagated")
            Check.bitEq(rt.state.pos.x, 0, "parked at x = 0")
            Check.bitEq(rt.state.pos.z, 0, "parked at z = 0")
            Check.bitEq(
                rt.state.pos.y, 1.25 + DiscBody.standard.halfHeight,
                "parked resting on the ground it last queried")
            Check.eq(rt.state.atRest, true, "and it is at rest")
            Check.eq(rt.state.touchedGround, true, "and counts as having touched the ground")
        }

        // `hold` with a degenerate normal must not produce NaN — the reference guards a
        // zero-length argument by falling back to world up.
        do {
            let rt = DiscRuntime()
            rt.hold(1, Vec3d(0, 1, 0), Vec3d(0, 0, 0), 0)
            let up = DiscRuntime()
            up.hold(1, Vec3d(0, 1, 0), Vec3d(0, 1, 0), 0)
            Check.bitEq(rt.state.orient.x, up.state.orient.x, "a zero normal falls back to world up")
            Check.bitEq(rt.state.orient.w, up.state.orient.w, "and stays a unit quaternion")
        }

        // `groundAt` is threaded, not global: two runtimes over different terrain settle
        // at different heights from the same call.
        do {
            let low = DiscRuntime()
            low.groundAt = { _, _ in 0 }
            let high = DiscRuntime()
            high.groundAt = { x, z in 2 + 0.1 * x - 0.05 * z }
            low.settle(Vec3d(5, 0, -3))
            high.settle(Vec3d(5, 0, -3))
            Check.bitEq(low.state.pos.y, DiscBody.standard.halfHeight, "flat terrain settles at the lip")
            Check.bitEq(
                high.state.pos.y, 2 + 0.1 * 5 - 0.05 * -3 + DiscBody.standard.halfHeight,
                "sloped terrain settles on its own surface")
        }
    }
}
