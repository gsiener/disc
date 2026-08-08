import Foundation
import UltimateSim

/// The disc runtime against `src/entities/Disc.ts`.
///
/// **These are traces, not a table, and the shape of the fixture is the point.** Almost
/// everything `DiscRuntime` can get wrong, it gets wrong only after several frames: the
/// clock and the release timer accumulate, the trail is a ring buffer that misbehaves
/// only once it is full or once samples begin ageing out, `groundY` is re-queried from a
/// closure every frame and does not reach ground contact until later, and the `probe`
/// scratch state is shared between `predictPath` and `probeThrow` so a leak between them
/// shows up only on the second call. So each case holds one runtime across hundreds of
/// fixed steps, scripts the state machine mid-flight, and compares the whole runtime.
///
/// ## What is asserted bit-for-bit and what is not
///
/// The runtime's own arithmetic is `+ − × ÷`, `min`, `max`, `clamp` and `Math.hypot`, all
/// of which are reproducible exactly — so the clock, the release timer, `state.t`, the
/// wear ledger, every trail timestamp, the seeded trail geometry and the ground closure
/// are `bitEqViaJSON`, and every discrete field is `eq`.
///
/// Anything downstream of the flight integration is not, and cannot be: RK4 runs `sin`,
/// `cos`, `atan2`, `exp` and `tanh` hundreds of times and no libm specifies those to the
/// last ulp. Those use a tolerance that WIDENS WITH HORIZON, identical in shape to
/// `FlightTests` — about a nanometre at release, a micrometre by six seconds — and the
/// suite reports the worst deviation it actually saw so the margin stays measured rather
/// than chosen. As written, roughly two fifths of the toleranced assertions land exactly
/// and the worst deviation on the whole suite is 8.8e-14 rad/s, on `omega.y` 114 frames
/// into a cross-wind hammer. That is drift in the last two bits, not a porting bug.
///
/// ## What was skipped, and why
///
/// `src/entities/Disc.ts` is an engine entity and roughly two thirds of it is the
/// renderer: `DiscSystem`, the lathed profile and its `THREE.BufferGeometry`, four texture
/// bakes, a shader injection for rotational motion blur, a pixel-budget readability
/// compensator, a sun-shadow decal, a ribbon trail mesh and a wear `DataTexture`. None of
/// that has a Swift counterpart in a module that imports Foundation and nothing else. The
/// simulation half is `DiscRuntime`, and it is what this suite covers, in full.
enum DiscRuntimeTests {

    // MARK: - fixture

    struct Frame: Decodable {
        let i: Int
        let t: Double
        let clock: Double
        let sinceRelease: Double
        let mode: String
        let holderId: Int
        let wear: Double
        let pos: [Double]
        let vel: [Double]
        let orient: [Double]
        let omega: [Double]
        /// Optional because a poisoned state makes both NaN, and `JSON.stringify(NaN)`
        /// emits `null`. `alpha` cannot: `refreshDerived` leaves it at zero when the
        /// airspeed comparison against 1e-5 is false, which a NaN airspeed always is.
        let spin: Double?
        let alpha: Double
        let airspeed: Double?
        let groundY: Double
        let atRest: Bool
        let touchedGround: Bool
        let trailCount: Int
        let trailAge: Double
        let trailFirstT: Double?
        let trailFirstPos: [Double]?
        let trailFirstSpeed: Double?
        let trailLastT: Double?
        let trailLastPos: [Double]?
        let trailLastSpeed: Double?
        let inBounds: Bool
    }

    struct Action: Decodable {
        let at: Int
        let kind: String
        let playerId: Int?
        let normal: [Double]?
        let spinPhase: Double?
        let strength: Double?
        let horizon: Double?
        let step: Double?
        let useStateLike: Bool?
        let pos: [Double]?
        let vel: [Double]?
    }

    struct PreHold: Decodable {
        let playerId: Int
        let pos: [Double]
        let normal: [Double]
        let spinPhase: Double
        let frames: Int
    }

    struct Req: Decodable {
        let type: String
        let from: [Double]
        let aim: [Double]
        let power: Double
        let angle: Double
        let spin: Double
        let hand: String?
        let bank: Double?
        let nose: Double?
        let speed: Double?
    }

    struct Release: Decodable {
        let vel: [Double]
        let frame: Frame
    }

    struct Event: Decodable {
        let at: Int
        let kind: String
        let frame: Frame?
    }

    struct Prediction: Decodable {
        let at: Int
        let horizon: Double
        let step: Double
        let useStateLike: Bool
        let pos: [Double]?
        let vel: [Double]?
        let mode: String
        /// `[t, x, y, z]` per sample.
        let path: [[Double]]
    }

    struct ScuffValue: Decodable {
        let rr: Double
        let ang: Double
        let top: Bool
        let strength: Double
    }

    struct ScuffRecord: Decodable {
        let at: Int
        let wear: Double
        let scuff: ScuffValue?
    }

    struct CrossingRecord: Decodable {
        let prev: [Double]
        let cur: [Double]
        let point: [Double]?
        let edge: String?
        let t: Double?
    }

    struct Trace: Decodable {
        let name: String
        let note: String
        let ground: String
        let wind: [Double]
        let trailCapacity: Int
        let trailSeconds: Double
        let preHold: PreHold?
        let preHoldFrames: [Frame]
        let req: Req
        let release: Release
        let frames: Int
        let sampleEvery: Int
        let watchBounds: Bool
        let script: [Action]
        let samples: [Frame]
        let events: [Event]
        let predictions: [Prediction]
        let scuffs: [ScuffRecord]
        let leftAtFrame: Int
        let crossing: CrossingRecord?
        let final: Frame
    }

    struct ProbeCase: Decodable {
        let ground: String
        let type: String
        let catchY: Double
        let from: [Double]
        let aim: [Double]
        let power: Double
        let angle: Double
        let spin: Double
        let hand: String?
        let bank: Double?
        let nose: Double?
        let speed: Double?
        let wind: [Double]
        let maxT: Double
        let dist: Double
        let lat: Double
        let t: Double
        let x: Double
        let z: Double
    }

    struct ScuffCase: Decodable {
        let normal: [Double]
        let phase: Double
        let orient: [Double]?
        let wearBefore: Double?
        let first: ScuffValue?
        let second: ScuffValue?
        let wearAfter: Double?
        let saturation: [Double]?
    }

    struct TrailDecayStep: Decodable {
        let i: Int
        let count: Int
        let age: Double
        let firstT: Double?
        let lastT: Double?
    }

    struct TrailCase: Decodable {
        let kind: String
        let now: Double?
        let trail: [[Double]]?
        let trailAge: Double?
        let count: Int?
        let trailSeconds: Double?
        let trailCapacity: Int?
        let seeded: [[Double]]?
        let after: [TrailDecayStep]?
        let counts: [Int]?
    }

    struct FieldBox: Decodable {
        let sideline: Double
        let endLine: Double
        let eps: Double
    }

    struct Defaults: Decodable {
        let mode: String
        let holderId: Int
        let lastThrowTeam: Int
        let sinceRelease: Double
        let wear: Double
        let trailCapacity: Int
        let trailSeconds: Double
        let now: Double
        let trailAge: Double
        let groundAtOrigin: Double
        let wind: [Double]
    }

    struct GroundSample: Decodable {
        let x: Double
        let z: Double
        let flat: Double
        let sloped: Double
    }

    struct File: Decodable {
        let note: String
        let fixedDt: Double
        let halfHeight: Double
        let diameter: Double
        let field: FieldBox
        let defaults: Defaults
        let groundSamples: [GroundSample]
        let traces: [Trace]
        let probes: [ProbeCase]
        let scuffs: [ScuffCase]
        let trails: [TrailCase]
    }

    // MARK: - tolerances

    /// Position tolerance in metres at elapsed flight time `t`, identical in shape to
    /// `FlightTests`: about a nanometre at release, a micrometre by six seconds. A disc is
    /// 273 mm across, so both are far below anything the game could perceive, while still
    /// being tight enough that a transposed term fails on the first frame.
    static func posTol(_ t: Double) -> Double { 1e-9 * pow(10.0, t / 2.0) }

    /// Velocity drifts faster than position, because position is its integral and
    /// integration smooths.
    static func velTol(_ t: Double) -> Double { 1e-8 * pow(10.0, t / 2.0) }

    /// Quaternion components. Unit-magnitude, so this is an absolute angle budget of the
    /// same order as the position one.
    static func quatTol(_ t: Double) -> Double { 1e-9 * pow(10.0, t / 2.0) }

    nonisolated(unsafe) static var worstRatio = 0.0
    nonisolated(unsafe) static var worstAbs = 0.0
    nonisolated(unsafe) static var worstLabel = "none"

    /// A tolerance assertion that also records how much of its budget it used, so the
    /// suite can report a measured margin rather than a hopeful one.
    static func within(
        _ got: Double, _ want: Double, _ tol: Double, _ label: @autoclosure () -> String
    ) {
        let d = abs(got - want)
        let ratio = tol > 0 ? d / tol : 0
        if ratio > worstRatio {
            worstRatio = ratio
            worstAbs = d
            worstLabel = label()
        }
        Check.ok(d <= tol, "\(label()) — off by \(d), tolerance \(tol)")
    }

    // MARK: - ground closures

    /// The two ground closures the fixture was generated against.
    ///
    /// Built from `+ − ×` and `max` only, deliberately: a `sin`/`cos` terrain would put
    /// every trace behind a tolerance for a reason that has nothing to do with the disc.
    /// The operation order is transcribed rather than simplified.
    static func ground(_ name: String) -> (Double, Double) -> Double {
        switch name {
        case "flat": return { _, _ in 0 }
        case "sloped":
            return { x, z in
                0.03 * x - 0.02 * z + 0.25 * Swift.max(0, 1 - 0.05 * (x * x + z * z))
            }
        default: return { _, _ in 0 }
        }
    }

    static func hand(_ s: String?) -> ThrowOptions.Hand? {
        switch s {
        case "L": return .left
        case "R": return .right
        default: return nil
        }
    }

    static func request(_ r: Req) -> ThrowRequest {
        ThrowRequest(
            type: ThrowType(rawValue: r.type)!,
            from: Vec3d(r.from[0], r.from[1], r.from[2]),
            aim: Vec3d(r.aim[0], r.aim[1], r.aim[2]),
            power: r.power, angle: r.angle, spin: r.spin,
            hand: hand(r.hand), bank: r.bank, nose: r.nose, speed: r.speed)
    }

    // MARK: - run

    static func run() throws {
        let g = try Goldens.load(File.self, "discruntime")

        Check.bitEqViaJSON(g.fixedDt, FIXED_DT, "fixture stepped at the engine's fixed dt")
        Check.bitEqViaJSON(
            g.halfHeight, DiscBody.standard.halfHeight, "fixture used the standard half-height")
        Check.bitEqViaJSON(
            g.diameter, DiscBody.standard.diameter, "fixture used the standard diameter")
        Check.eq(g.traces.count, 6, "six multi-step traces")

        defaults(g.defaults)
        grounds(g.groundSamples)
        for tr in g.traces { replay(tr, field: g.field) }
        for (i, p) in g.probes.enumerated() { probe(p, i) }
        for (i, s) in g.scuffs.enumerated() { scuff(s, i) }
        for (i, t) in g.trails.enumerated() { trailCase(t, i) }
        proseClaims()

        Check.note(
            "worst disc-runtime deviation \(worstAbs) — "
                + "\(String(format: "%.2g", worstRatio * 100))% of the horizon tolerance "
                + "at \(worstLabel)")
    }

    // MARK: - defaults and ground

    private static func defaults(_ d: Defaults) {
        let rt = DiscRuntime()
        Check.eq(rt.mode.rawValue, d.mode, "a fresh runtime starts on the ground")
        Check.eq(rt.holderId, d.holderId, "a fresh runtime is held by nobody")
        Check.eq(rt.lastThrowTeam, d.lastThrowTeam, "default last-throw team")
        Check.bitEqViaJSON(rt.sinceRelease, d.sinceRelease, "sinceRelease starts enormous")
        Check.bitEqViaJSON(rt.wear, d.wear, "a fresh disc is unworn")
        Check.eq(rt.trailCapacity, d.trailCapacity, "default trail capacity")
        Check.bitEqViaJSON(rt.trailSeconds, d.trailSeconds, "default trail seconds")
        Check.bitEqViaJSON(rt.now, d.now, "the clock starts at zero")
        Check.bitEqViaJSON(rt.trailAge, d.trailAge, "an empty trail reports the sentinel age")
        Check.bitEqViaJSON(
            rt.groundAt(3, -4), d.groundAtOrigin, "the default ground query is flat at zero")
        Check.bitEqViaJSON(rt.wind.x, d.wind[0], "default wind x")
        Check.bitEqViaJSON(rt.wind.y, d.wind[1], "default wind y")
        Check.bitEqViaJSON(rt.wind.z, d.wind[2], "default wind z")
    }

    private static func grounds(_ samples: [GroundSample]) {
        let flat = ground("flat")
        let sloped = ground("sloped")
        for s in samples {
            Check.bitEqViaJSON(flat(s.x, s.z), s.flat, "flat ground at (\(s.x), \(s.z))")
            Check.bitEqViaJSON(sloped(s.x, s.z), s.sloped, "sloped ground at (\(s.x), \(s.z))")
        }
    }

    // MARK: - traces

    private static func replay(_ tr: Trace, field f: FieldBox) {
        let rt = DiscRuntime()
        rt.groundAt = ground(tr.ground)
        rt.wind = Vec3d(tr.wind[0], tr.wind[1], tr.wind[2])
        rt.trailCapacity = tr.trailCapacity
        rt.trailSeconds = tr.trailSeconds

        // Held before the throw: `step` must advance the clock and decay the trail while
        // doing no physics whatsoever.
        if let ph = tr.preHold {
            rt.hold(
                ph.playerId, Vec3d(ph.pos[0], ph.pos[1], ph.pos[2]),
                Vec3d(ph.normal[0], ph.normal[1], ph.normal[2]), ph.spinPhase)
            compare(rt, tr.preHoldFrames[0], "\(tr.name) pre-hold 0", field: f)
            for i in 0..<ph.frames {
                rt.step(dt: FIXED_DT)
                compare(rt, tr.preHoldFrames[i + 1], "\(tr.name) pre-hold \(i + 1)", field: f)
            }
        }

        let releaseVel = rt.release(request(tr.req))
        // `throwDisc` builds the release frame from `cos`/`sin` of the elevation, so this
        // is the one place in the trace that is transcendental at t = 0. 1e-12 is the same
        // budget `ThrowsTests` measured for the same construction.
        within(releaseVel.x, tr.release.vel[0], 1e-12, "\(tr.name) release vel.x")
        within(releaseVel.y, tr.release.vel[1], 1e-12, "\(tr.name) release vel.y")
        within(releaseVel.z, tr.release.vel[2], 1e-12, "\(tr.name) release vel.z")
        compare(rt, tr.release.frame, "\(tr.name) release", field: f)

        var predictions = tr.predictions.makeIterator()
        var scuffs = tr.scuffs.makeIterator()
        var events = tr.events.makeIterator()
        var samples = tr.samples.makeIterator()
        var pendingPredictions = tr.predictions.count
        var pendingScuffs = tr.scuffs.count
        var pendingEvents = tr.events.count
        var pendingSamples = tr.samples.count

        let scuffOnTouch = tr.script.first { $0.kind == "scuffOnTouch" }
        var scuffed = false

        var prev = rt.state.pos
        var leftAtFrame = -1

        for i in 1...tr.frames {
            for a in tr.script where a.at == i {
                switch a.kind {
                case "hold":
                    rt.hold(
                        a.playerId!, rt.state.pos,
                        Vec3d(a.normal![0], a.normal![1], a.normal![2]), a.spinPhase!)
                    if let e = events.next() {
                        pendingEvents -= 1
                        Check.eq(e.at, i, "\(tr.name) hold event frame")
                        Check.eq(e.kind, "hold", "\(tr.name) hold event kind")
                        compare(rt, e.frame!, "\(tr.name) after hold at \(i)", field: f)
                    }
                case "settle":
                    rt.settle(rt.state.pos)
                    if let e = events.next() {
                        pendingEvents -= 1
                        Check.eq(e.at, i, "\(tr.name) settle event frame")
                        Check.eq(e.kind, "settle", "\(tr.name) settle event kind")
                        compare(rt, e.frame!, "\(tr.name) after settle at \(i)", field: f)
                    }
                case "markScuff":
                    rt.markScuff(a.strength!)
                    if let s = scuffs.next() {
                        pendingScuffs -= 1
                        compareScuff(rt, s, "\(tr.name) scuff at \(i)", tol: posTol(rt.state.t))
                    }
                case "poisonVelocity":
                    // Not expressible as a number in JSON, hence a named action.
                    rt.state.vel = Vec3d(.infinity, 0, 0)
                    if let e = events.next() {
                        pendingEvents -= 1
                        Check.eq(e.kind, "poisonVelocity", "\(tr.name) poison event kind")
                    }
                case "predict":
                    let usesLike = a.useStateLike!
                    let path = rt.predictPath(
                        pos: usesLike ? Vec3d(a.pos![0], a.pos![1], a.pos![2]) : nil,
                        vel: usesLike ? Vec3d(a.vel![0], a.vel![1], a.vel![2]) : nil,
                        horizon: a.horizon!, step: a.step!)
                    if let want = predictions.next() {
                        pendingPredictions -= 1
                        comparePath(
                            path, want, "\(tr.name) predict at \(i)", elapsed: rt.state.t,
                            mode: rt.mode)
                    }
                default:
                    break
                }
            }

            rt.step(dt: FIXED_DT)

            if let onTouch = scuffOnTouch, !scuffed, rt.state.touchedGround {
                scuffed = true
                rt.markScuff(onTouch.strength!)
                if let s = scuffs.next() {
                    pendingScuffs -= 1
                    Check.eq(s.at, i, "\(tr.name) first ground contact is frame \(s.at)")
                    compareScuff(rt, s, "\(tr.name) landing scuff", tol: posTol(rt.state.t))
                }
            }

            if tr.watchBounds && leftAtFrame < 0 && !inBounds(rt.state.pos, f) {
                leftAtFrame = i
                if let want = tr.crossing {
                    let c = boundaryCrossing(prev, rt.state.pos)
                    within(prev.x, want.prev[0], posTol(rt.state.t), "\(tr.name) crossing prev.x")
                    within(prev.z, want.prev[2], posTol(rt.state.t), "\(tr.name) crossing prev.z")
                    within(
                        rt.state.pos.x, want.cur[0], posTol(rt.state.t), "\(tr.name) crossing cur.x")
                    within(
                        rt.state.pos.z, want.cur[2], posTol(rt.state.t), "\(tr.name) crossing cur.z")
                    Check.eq(c != nil, want.point != nil, "\(tr.name) the segment leaves the field")
                    if let c, let pt = want.point, let wt = want.t, let we = want.edge {
                        Check.eq(c.edge.rawValue, we, "\(tr.name) crossing edge")
                        within(c.point.x, pt[0], posTol(rt.state.t), "\(tr.name) crossing point.x")
                        within(c.point.z, pt[2], posTol(rt.state.t), "\(tr.name) crossing point.z")
                        within(c.t, wt, 1e-7, "\(tr.name) crossing parameter")
                    }
                }
            }
            prev = rt.state.pos

            if i % tr.sampleEvery == 0, let want = samples.next() {
                pendingSamples -= 1
                compare(rt, want, "\(tr.name) frame \(i)", field: f)
            }
        }

        if tr.watchBounds {
            Check.eq(leftAtFrame, tr.leftAtFrame, "\(tr.name) leaves the field on the same frame")
            Check.ok(leftAtFrame > 0, "\(tr.name) really does leave the field")
        }
        Check.eq(pendingSamples, 0, "\(tr.name) consumed every sample")
        Check.eq(pendingPredictions, 0, "\(tr.name) consumed every prediction")
        Check.eq(pendingScuffs, 0, "\(tr.name) consumed every scuff")
        Check.eq(pendingEvents, 0, "\(tr.name) consumed every event")
        compare(rt, tr.final, "\(tr.name) final", field: f)
    }

    /// The whole runtime, not just the position.
    private static func compare(
        _ rt: DiscRuntime, _ want: Frame, _ at: String, field f: FieldBox
    ) {
        let s = rt.state
        let pT = posTol(want.t)
        let vT = velTol(want.t)
        let qT = quatTol(want.t)

        // Exact: pure accumulation of the fixed step, and discrete state.
        Check.bitEqViaJSON(s.t, want.t, "\(at) flight time")
        Check.bitEqViaJSON(rt.now, want.clock, "\(at) runtime clock")
        Check.bitEqViaJSON(rt.sinceRelease, want.sinceRelease, "\(at) sinceRelease")
        Check.bitEqViaJSON(rt.wear, want.wear, "\(at) wear")
        Check.eq(rt.mode.rawValue, want.mode, "\(at) mode")
        Check.eq(rt.holderId, want.holderId, "\(at) holderId")
        Check.eq(s.atRest, want.atRest, "\(at) atRest")
        Check.eq(s.touchedGround, want.touchedGround, "\(at) touchedGround")
        Check.eq(rt.trail.count, want.trailCount, "\(at) trail count")
        Check.bitEqViaJSON(rt.trailAge, want.trailAge, "\(at) trail age")
        Check.eq(inBounds(s.pos, f), want.inBounds, "\(at) in bounds")
        // Cross-check that the fixture's field really is the one `Rules` carries, so the
        // threaded comparison above and the shared geometry cannot drift apart.
        Check.eq(isInBounds(s.pos), want.inBounds, "\(at) in bounds agrees with Rules")

        // Integrated: tolerance that widens with horizon.
        within(s.pos.x, want.pos[0], pT, "\(at) pos.x")
        within(s.pos.y, want.pos[1], pT, "\(at) pos.y")
        within(s.pos.z, want.pos[2], pT, "\(at) pos.z")
        within(s.vel.x, want.vel[0], vT, "\(at) vel.x")
        within(s.vel.y, want.vel[1], vT, "\(at) vel.y")
        within(s.vel.z, want.vel[2], vT, "\(at) vel.z")
        within(s.omega.x, want.omega[0], vT, "\(at) omega.x")
        within(s.omega.y, want.omega[1], vT, "\(at) omega.y")
        within(s.omega.z, want.omega[2], vT, "\(at) omega.z")
        within(s.groundY, want.groundY, pT, "\(at) groundY")

        // A quaternion and its negation are the same rotation, so align the sign before
        // comparing components. Comparing components rather than only `|dot|` catches an
        // axis transposition that leaves the magnitude intact.
        let d = s.orient.x * want.orient[0] + s.orient.y * want.orient[1]
            + s.orient.z * want.orient[2] + s.orient.w * want.orient[3]
        let sign = d < 0 ? -1.0 : 1.0
        within(sign * s.orient.x, want.orient[0], qT, "\(at) orient.x")
        within(sign * s.orient.y, want.orient[1], qT, "\(at) orient.y")
        within(sign * s.orient.z, want.orient[2], qT, "\(at) orient.z")
        within(sign * s.orient.w, want.orient[3], qT, "\(at) orient.w")

        if let ws = want.spin {
            within(s.spin, ws, vT, "\(at) spin")
        } else {
            Check.eq(s.spin.isNaN, true, "\(at) spin is NaN once the state has been poisoned")
        }
        // `alpha` and `airspeed` are only compared in flight. See `DiscRuntime.hold`: the
        // reference leaves both stale when a disc is taken into a hand and this port
        // cannot, because `DiscState.spin` is `private(set)` and the only way to zero it
        // from outside `DiscPhysics.swift` re-derives all three. Nothing in the sim
        // branches on either, and the next flight step recomputes both.
        if want.mode == "flight" {
            within(s.alpha, want.alpha, 1e-9 * pow(10.0, want.t / 2.0), "\(at) alpha")
            if let wa = want.airspeed {
                within(s.airspeed, wa, vT, "\(at) airspeed")
            } else {
                Check.eq(s.airspeed.isNaN, true, "\(at) airspeed is NaN once poisoned")
            }
        } else {
            Check.bitEqViaJSON(s.alpha, 0, "\(at) alpha is zero off flight")
            Check.bitEqViaJSON(s.airspeed, 0, "\(at) airspeed is zero off flight")
            Check.bitEqViaJSON(s.spin, 0, "\(at) spin is zero off flight")
        }

        // The trail's ends. Timestamps are clock arithmetic and therefore exact; the
        // geometry is the flight and therefore is not.
        if let wt = want.trailLastT {
            let last = rt.trail.last!
            Check.bitEqViaJSON(last.t, wt, "\(at) newest trail sample time")
            within(last.x, want.trailLastPos![0], pT, "\(at) newest trail x")
            within(last.y, want.trailLastPos![1], pT, "\(at) newest trail y")
            within(last.z, want.trailLastPos![2], pT, "\(at) newest trail z")
            within(last.speed, want.trailLastSpeed!, vT, "\(at) newest trail speed")
        } else {
            Check.eq(rt.trail.isEmpty, true, "\(at) trail is empty")
        }
        if let wt = want.trailFirstT {
            let first = rt.trail.first!
            Check.bitEqViaJSON(first.t, wt, "\(at) oldest trail sample time")
            within(first.x, want.trailFirstPos![0], pT, "\(at) oldest trail x")
            within(first.y, want.trailFirstPos![1], pT, "\(at) oldest trail y")
            within(first.z, want.trailFirstPos![2], pT, "\(at) oldest trail z")
            within(first.speed, want.trailFirstSpeed!, vT, "\(at) oldest trail speed")
        }
    }

    /// The fixture carries the field it measured in-bounds against, so the comparison is
    /// threaded rather than reaching for a module constant. This game runs on two pitches.
    private static func inBounds(_ p: Vec3d, _ f: FieldBox) -> Bool {
        abs(p.x) <= f.sideline + f.eps && abs(p.z) <= f.endLine + f.eps
    }

    private static func compareScuff(
        _ rt: DiscRuntime, _ want: ScuffRecord, _ at: String, tol: Double
    ) {
        Check.bitEqViaJSON(rt.wear, want.wear, "\(at) wear after")
        guard let w = want.scuff, let got = rt.pendingScuff else {
            Check.eq(rt.pendingScuff == nil, want.scuff == nil, "\(at) scuff presence")
            return
        }
        within(got.rr, w.rr, Swift.max(tol, 1e-12), "\(at) rr")
        within(got.ang, w.ang, Swift.max(tol, 1e-12), "\(at) ang")
        Check.eq(got.top, w.top, "\(at) which face struck")
        Check.bitEqViaJSON(got.strength, w.strength, "\(at) strength")
    }

    private static func comparePath(
        _ got: [FlightSample], _ want: Prediction, _ at: String, elapsed: Double, mode: DiscMode
    ) {
        Check.eq(mode.rawValue, want.mode, "\(at) mode at the call")
        Check.eq(got.count, want.path.count, "\(at) sample count")
        let n = Swift.min(got.count, want.path.count)
        for i in 0..<n {
            let w = want.path[i]
            // Sample times are `i * dt` with a clamped `dt`, so they are exact.
            Check.bitEqViaJSON(got[i].t, w[0], "\(at) sample \(i) t")
            let tol = posTol(elapsed + w[0])
            within(got[i].x, w[1], tol, "\(at) sample \(i) x")
            within(got[i].y, w[2], tol, "\(at) sample \(i) y")
            within(got[i].z, w[3], tol, "\(at) sample \(i) z")
        }
        Check.ok(got.count >= 2, "\(at) always returns at least two points")
    }

    // MARK: - probeThrow

    private static func probe(_ c: ProbeCase, _ i: Int) {
        let rt = DiscRuntime()
        rt.groundAt = ground(c.ground)
        rt.wind = Vec3d(c.wind[0], c.wind[1], c.wind[2])
        let req = ThrowRequest(
            type: ThrowType(rawValue: c.type)!,
            from: Vec3d(c.from[0], c.from[1], c.from[2]),
            aim: Vec3d(c.aim[0], c.aim[1], c.aim[2]),
            power: c.power, angle: c.angle, spin: c.spin,
            hand: hand(c.hand), bank: c.bank, nose: c.nose, speed: c.speed)
        let r = rt.probeThrow(req, catchY: c.catchY, maxT: c.maxT)
        let at = "probe \(i) \(c.type)/\(c.ground)/catchY=\(c.catchY)"

        // The stop time is an integer number of fixed steps, so it is exact — and if the
        // two implementations ever disagreed about WHICH frame crossed the catch plane
        // this is the assertion that would say so, rather than a position drifting.
        Check.bitEqViaJSON(r.t, c.t, "\(at) flight time at the catch plane")
        let tol = posTol(c.t)
        within(r.dist, c.dist, tol, "\(at) distance down the aim line")
        within(r.lat, c.lat, tol, "\(at) lateral offset")
        within(r.x, c.x, tol, "\(at) x")
        within(r.z, c.z, tol, "\(at) z")
    }

    // MARK: - scuff geometry

    private static func scuff(_ c: ScuffCase, _ i: Int) {
        let rt = DiscRuntime()
        rt.groundAt = ground("flat")
        rt.hold(1, Vec3d(0, 1, 0), Vec3d(c.normal[0], c.normal[1], c.normal[2]), c.phase)
        let at = "scuff \(i) normal=\(c.normal) phase=\(c.phase)"

        if let saturation = c.saturation {
            for (k, w) in saturation.enumerated() {
                rt.markScuff(1)
                Check.bitEqViaJSON(rt.wear, w, "\(at) wear after \(k + 1) full-strength strikes")
            }
            Check.bitEqViaJSON(rt.wear, 1, "\(at) wear saturates at one")
            return
        }

        // The orientation comes from `setFromUnitVectors` and `setFromAxisAngle`, so it is
        // `sin`/`cos` of the phase and a `sqrt` — one transcendental deep, not hundreds.
        if let want = c.orient {
            let d = rt.state.orient.x * want[0] + rt.state.orient.y * want[1]
                + rt.state.orient.z * want[2] + rt.state.orient.w * want[3]
            let sign = d < 0 ? -1.0 : 1.0
            within(sign * rt.state.orient.x, want[0], 1e-15, "\(at) orient.x")
            within(sign * rt.state.orient.y, want[1], 1e-15, "\(at) orient.y")
            within(sign * rt.state.orient.z, want[2], 1e-15, "\(at) orient.z")
            within(sign * rt.state.orient.w, want[3], 1e-15, "\(at) orient.w")
        }

        Check.bitEqViaJSON(rt.wear, c.wearBefore!, "\(at) wear before the strike")
        rt.markScuff(0.6)
        let first = rt.pendingScuff!
        within(first.rr, c.first!.rr, 1e-15, "\(at) first rr")
        within(first.ang, c.first!.ang, 1e-15, "\(at) first ang")
        Check.eq(first.top, c.first!.top, "\(at) first face")
        Check.bitEqViaJSON(first.strength, c.first!.strength, "\(at) first strength")

        rt.markScuff(0.9)
        let second = rt.pendingScuff!
        within(second.rr, c.second!.rr, 1e-15, "\(at) second rr")
        within(second.ang, c.second!.ang, 1e-15, "\(at) second ang")
        Check.eq(second.top, c.second!.top, "\(at) second face")
        Check.bitEqViaJSON(second.strength, c.second!.strength, "\(at) second strength")
        Check.bitEqViaJSON(rt.wear, c.wearAfter!, "\(at) wear accumulates rather than replaces")
    }

    // MARK: - the trail ring buffer

    private static func trailCase(_ c: TrailCase, _ i: Int) {
        let at = "trail \(i) \(c.kind)"
        switch c.kind {
        case "setTrail-from-cold":
            let rt = DiscRuntime()
            rt.groundAt = ground("flat")
            var seeded: [TrailSample] = []
            for k in 0..<10 {
                let d = Double(k)
                seeded.append(
                    TrailSample(
                        x: d * 0.5, y: 1 + d * 0.1, z: -d * 0.25, t: 100 + d * 0.03,
                        speed: 12 - d))
            }
            rt.setTrail(seeded)
            Check.bitEqViaJSON(rt.now, c.now!, "\(at) clock")
            compareTrail(rt, c.trail!, at)
            Check.bitEqViaJSON(rt.trailAge, c.trailAge!, "\(at) newest sample lands on now")

        case "setTrail-then-decay":
            let rt = DiscRuntime()
            rt.groundAt = ground("flat")
            rt.trailSeconds = c.trailSeconds!
            rt.trailCapacity = c.trailCapacity!
            rt.hold(2, Vec3d(0, 1.2, 0), Vec3d(0, 1, 0), 0)
            for _ in 0..<30 { rt.step(dt: FIXED_DT) }
            var seeded: [TrailSample] = []
            for k in 0..<12 {
                let d = Double(k)
                seeded.append(TrailSample(x: d, y: 2, z: d * 0.5, t: d * 0.04, speed: d))
            }
            rt.setTrail(seeded)
            Check.eq(
                rt.trail.count, seeded.count,
                "\(at) setTrail does not itself decay — the next step does")
            for k in 0..<seeded.count {
                Check.bitEqViaJSON(rt.trail[k].x, c.seeded![k][0], "\(at) seeded \(k) x")
                Check.bitEqViaJSON(rt.trail[k].speed, c.seeded![k][4], "\(at) seeded \(k) speed")
            }
            for step in c.after! {
                rt.step(dt: FIXED_DT)
                Check.eq(rt.trail.count, step.count, "\(at) count after \(step.i)")
                Check.bitEqViaJSON(rt.trailAge, step.age, "\(at) age after \(step.i)")
                if let ft = step.firstT {
                    Check.bitEqViaJSON(rt.trail.first!.t, ft, "\(at) oldest t after \(step.i)")
                } else {
                    Check.eq(rt.trail.isEmpty, true, "\(at) trail emptied by \(step.i)")
                }
                if let lt = step.lastT {
                    Check.bitEqViaJSON(rt.trail.last!.t, lt, "\(at) newest t after \(step.i)")
                }
            }
            Check.bitEqViaJSON(rt.now, c.now!, "\(at) clock")
            compareTrail(rt, c.trail!, at)

        case "capacity-only":
            let rt = DiscRuntime()
            rt.groundAt = ground("flat")
            rt.trailSeconds = c.trailSeconds!
            rt.trailCapacity = c.trailCapacity!
            rt.release(
                ThrowRequest(
                    type: .backhand, from: Vec3d(0, 1.6, 0), aim: Vec3d(1, 0, 0),
                    power: 0.8, angle: 0.05, spin: 0.6))
            for (k, want) in c.counts!.enumerated() {
                rt.step(dt: FIXED_DT)
                Check.eq(rt.trail.count, want, "\(at) count after step \(k)")
            }
            Check.eq(
                rt.trail.count, c.trailCapacity!,
                "\(at) capacity, not the seconds budget, is what evicts")
            Check.bitEqViaJSON(rt.trailAge, c.trailAge!, "\(at) newest sample is this frame")
            for (k, w) in c.trail!.enumerated() {
                let s = rt.trail[k]
                Check.bitEqViaJSON(s.t, w[3], "\(at) sample \(k) time")
                within(s.x, w[0], posTol(s.t), "\(at) sample \(k) x")
                within(s.y, w[1], posTol(s.t), "\(at) sample \(k) y")
                within(s.z, w[2], posTol(s.t), "\(at) sample \(k) z")
                within(s.speed, w[4], velTol(s.t), "\(at) sample \(k) speed")
            }

        case "empty":
            let rt = DiscRuntime()
            Check.bitEqViaJSON(rt.now, c.now!, "\(at) clock")
            Check.bitEqViaJSON(rt.trailAge, c.trailAge!, "\(at) sentinel age")
            Check.eq(rt.trail.count, c.count!, "\(at) count")

        default:
            Check.ok(false, "\(at) is an unknown trail case")
        }
    }

    private static func compareTrail(_ rt: DiscRuntime, _ want: [[Double]], _ at: String) {
        Check.eq(rt.trail.count, want.count, "\(at) trail length")
        for (k, w) in want.enumerated() where k < rt.trail.count {
            let s = rt.trail[k]
            Check.bitEqViaJSON(s.x, w[0], "\(at) sample \(k) x")
            Check.bitEqViaJSON(s.y, w[1], "\(at) sample \(k) y")
            Check.bitEqViaJSON(s.z, w[2], "\(at) sample \(k) z")
            Check.bitEqViaJSON(s.t, w[3], "\(at) sample \(k) t")
            Check.bitEqViaJSON(s.speed, w[4], "\(at) sample \(k) speed")
        }
    }

    // MARK: - the module's prose, asserted as behaviour

    /// Every claim below is written down in `DiscRuntime`'s own documentation or in the
    /// reference's. They would survive a retune of the flight model, and if they ever
    /// disagree with the fixtures, believe them.
    private static func proseClaims() {
        // "The game system is the single driver — it decides when the disc is in a hand,
        // in the air or on the grass." So a runtime that is not in flight does no physics,
        // however hard it is stepped.
        do {
            let rt = DiscRuntime()
            rt.groundAt = { x, _ in 0.5 + 0.1 * x }
            rt.wind = Vec3d(9, 0, -9)
            rt.hold(4, Vec3d(2, 1.3, -1), Vec3d(0, 1, 0), 0.3)
            let before = rt.state
            // 1/120 is not representable in binary, so the expected clock is accumulated
            // the same way rather than written as 5. Comparing against a round number here
            // would be asserting the rounding of the multiplication, not the sum.
            var clock = 0.0
            var since = 1e3
            for _ in 0..<600 {
                rt.step(dt: FIXED_DT)
                clock += FIXED_DT
                since += FIXED_DT
            }
            Check.bitEqViaJSON(rt.state.pos.x, before.pos.x, "a held disc does not move in x")
            Check.bitEqViaJSON(rt.state.pos.y, before.pos.y, "a held disc does not move in y")
            Check.bitEqViaJSON(rt.state.pos.z, before.pos.z, "a held disc does not move in z")
            Check.bitEqViaJSON(rt.state.t, 0, "a held disc accrues no flight time")
            Check.bitEqViaJSON(rt.now, clock, "the runtime clock runs regardless")
            Check.near(rt.now, 5, 1e-12, "five seconds of held frames really is five seconds")
            Check.bitEqViaJSON(rt.sinceRelease, since, "so does the release timer")
            Check.eq(rt.trail.isEmpty, true, "and a held disc leaves no trail")
        }

        // "Seconds since release; blocks self-catches for a few frames."
        do {
            let rt = DiscRuntime()
            Check.ok(rt.sinceRelease > 100, "an unthrown disc cannot be self-caught")
            rt.release(
                ThrowRequest(
                    type: .backhand, from: Vec3d(0, 1.5, 0), aim: Vec3d(1, 0, 0),
                    power: 0.5, angle: 0, spin: 0.5))
            Check.bitEqViaJSON(rt.sinceRelease, 0, "release resets the timer to exactly zero")
            var since = 0.0
            for _ in 0..<12 {
                rt.step(dt: FIXED_DT)
                since += FIXED_DT
            }
            Check.bitEqViaJSON(rt.sinceRelease, since, "and it accrues one dt per step")
        }

        // "A TRAIL THAT IS THE REAL PATH. Not a spline hint — the actual sampled flight."
        do {
            let rt = DiscRuntime()
            rt.release(
                ThrowRequest(
                    type: .backhand, from: Vec3d(0, 1.6, 0), aim: Vec3d(1, 0, 0.3),
                    power: 0.7, angle: 0.04, spin: 0.6))
            var positions: [Vec3d] = [rt.state.pos]
            for _ in 0..<40 {
                rt.step(dt: FIXED_DT)
                positions.append(rt.state.pos)
            }
            Check.eq(rt.trail.count, positions.count, "the trail has one sample per step")
            for (k, p) in positions.enumerated() {
                Check.bitEqViaJSON(rt.trail[k].x, p.x, "trail sample \(k) is the real path x")
                Check.bitEqViaJSON(rt.trail[k].y, p.y, "trail sample \(k) is the real path y")
                Check.bitEqViaJSON(rt.trail[k].z, p.z, "trail sample \(k) is the real path z")
            }
        }

        // "Park it rather than poisoning every consumer downstream."
        do {
            let rt = DiscRuntime()
            rt.groundAt = { _, _ in 1.25 }
            rt.release(
                ThrowRequest(
                    type: .forehand, from: Vec3d(0, 3, 0), aim: Vec3d(1, 0, 0),
                    power: 0.5, angle: 0, spin: 0.5))
            rt.step(dt: FIXED_DT)
            rt.state.vel = Vec3d(.nan, 0, 0)
            rt.step(dt: FIXED_DT)
            Check.ok(rt.state.isFinite, "a poisoned state is parked, not propagated")
            Check.bitEqViaJSON(rt.state.pos.x, 0, "parked at x = 0")
            Check.bitEqViaJSON(
                rt.state.pos.z, 0, "parked at z = 0")
            Check.bitEqViaJSON(
                rt.state.pos.y, 1.25 + DiscBody.standard.halfHeight,
                "parked resting on the ground it last queried")
            Check.eq(rt.state.atRest, true, "and it is at rest")
            Check.eq(rt.state.touchedGround, true, "and counts as having touched the ground")
        }

        // "predictPath ... step is clamped and the sample count is bounded", so no caller
        // can ask for an unbounded amount of integration.
        do {
            let rt = DiscRuntime()
            rt.release(
                ThrowRequest(
                    type: .backhand, from: Vec3d(0, 30, 0), aim: Vec3d(1, 0, 0),
                    power: 1, angle: 0.3, spin: 1))
            Check.eq(
                rt.predictPath(horizon: 1e6, step: 1e-9).count, 241,
                "a huge horizon and a tiny step still cost 240 integrations")
            Check.eq(
                rt.predictPath(horizon: -5, step: 1e9).count, 3,
                "a negative horizon still returns the floor of two steps")
            Check.ok(
                rt.predictPath(horizon: 0, step: 0).count >= 2,
                "predictPath always returns at least two points")
        }

        // "We integrate the real state when it is ours and in the air, and a matching
        // state otherwise." A live flight must ignore the caller's guess entirely.
        do {
            let rt = DiscRuntime()
            rt.release(
                ThrowRequest(
                    type: .backhand, from: Vec3d(0, 1.6, 0), aim: Vec3d(1, 0, 0),
                    power: 0.6, angle: 0.05, spin: 0.5))
            for _ in 0..<30 { rt.step(dt: FIXED_DT) }
            let ours = rt.predictPath(horizon: 2, step: 1.0 / 30.0)
            let theirs = rt.predictPath(
                pos: Vec3d(-40, 25, 17), vel: Vec3d(-3, -9, 2), horizon: 2, step: 1.0 / 30.0)
            for k in 0..<ours.count {
                Check.bitEqViaJSON(theirs[k].x, ours[k].x, "live flight ignores the caller's x")
                Check.bitEqViaJSON(theirs[k].y, ours[k].y, "live flight ignores the caller's y")
                Check.bitEqViaJSON(theirs[k].z, ours[k].z, "live flight ignores the caller's z")
            }
            rt.settle(Vec3d(0, 0, 0))
            let after = rt.predictPath(
                pos: Vec3d(-40, 25, 17), vel: Vec3d(-3, -9, 2), horizon: 2, step: 1.0 / 30.0)
            Check.bitEqViaJSON(after[0].x, -40, "off flight, the caller's position is taken")
            Check.bitEqViaJSON(after[0].y, 25, "off flight, the caller's height is taken")
            Check.bitEqViaJSON(after[0].z, 17, "off flight, the caller's z is taken")
        }

        // The `DiscPeer` conformance is the same call, so the AI cannot get a different
        // answer from the one the game gets.
        do {
            let rt = DiscRuntime()
            rt.release(
                ThrowRequest(
                    type: .hammer, from: Vec3d(1, 1.8, 2), aim: Vec3d(0, 0, 1),
                    power: 0.7, angle: 0, spin: 0.5))
            rt.settle(Vec3d(1, 0, 2))
            var ai = AIDiscState()
            ai.pos = Vec3d(4, 6, -2)
            ai.vel = Vec3d(1, 2, 3)
            let peer: DiscPeer = rt
            let viaPeer = peer.predictPath(ai, horizon: 3, step: 1.0 / 40.0)
            let direct = rt.predictPath(
                pos: ai.pos, vel: ai.vel, horizon: 3, step: 1.0 / 40.0)
            Check.eq(viaPeer.count, direct.count, "the peer contract returns the same path length")
            for k in 0..<viaPeer.count {
                Check.bitEqViaJSON(viaPeer[k].x, direct[k].x, "peer sample \(k) x")
                Check.bitEqViaJSON(viaPeer[k].y, direct[k].y, "peer sample \(k) y")
                Check.bitEqViaJSON(viaPeer[k].z, direct[k].z, "peer sample \(k) z")
            }
        }

        // "Settle() does NOT clear the trail" — that is what leaves a ribbon behind a disc
        // that was swatted down — where hold() does.
        do {
            let rt = DiscRuntime()
            rt.release(
                ThrowRequest(
                    type: .backhand, from: Vec3d(0, 1.6, 0), aim: Vec3d(1, 0, 0),
                    power: 0.6, angle: 0.05, spin: 0.5))
            for _ in 0..<20 { rt.step(dt: FIXED_DT) }
            let n = rt.trail.count
            Check.ok(n > 1, "a flown disc has a trail")
            rt.settle(Vec3d(3, 0, 0))
            Check.eq(rt.trail.count, n, "settle keeps the trail")
            rt.hold(2, Vec3d(3, 1, 0), Vec3d(0, 1, 0), 0)
            Check.eq(rt.trail.count, 0, "hold clears it")
        }

        // Wear accumulates and clamps; it is never assigned.
        do {
            let rt = DiscRuntime()
            rt.hold(1, Vec3d(0, 1, 0), Vec3d(0, 1, 0), 0)
            rt.markScuff(0.5)
            Check.bitEqViaJSON(rt.wear, 0.5 * 0.055, "one strike adds its share")
            rt.markScuff(0.5)
            Check.bitEqViaJSON(rt.wear, clamp(0.5 * 0.055 + 0.5 * 0.055, 0, 1), "two strikes add")
            for _ in 0..<1000 { rt.markScuff(1) }
            Check.bitEqViaJSON(rt.wear, 1, "wear saturates at one and stays there")
        }

        // The disc that struck is the face that is NOT up.
        do {
            let rt = DiscRuntime()
            rt.hold(1, Vec3d(0, 1, 0), Vec3d(0, 1, 0), 0)
            rt.markScuff(0.4)
            Check.eq(
                rt.pendingScuff!.top, false,
                "a disc lying face up is scuffed on its underside")
            rt.hold(1, Vec3d(0, 1, 0), Vec3d(0, -1, 0), 0)
            rt.markScuff(0.4)
            Check.eq(
                rt.pendingScuff!.top, true,
                "a disc lying face down is scuffed on its plate")
        }

        // `hold` with a degenerate normal must not produce NaN — the reference guards a
        // zero-length argument by falling back to world up.
        do {
            let rt = DiscRuntime()
            rt.hold(1, Vec3d(0, 1, 0), Vec3d(0, 0, 0), 0)
            let up = DiscRuntime()
            up.hold(1, Vec3d(0, 1, 0), Vec3d(0, 1, 0), 0)
            Check.bitEqViaJSON(
                rt.state.orient.x, up.state.orient.x, "a zero normal falls back to world up")
            Check.bitEqViaJSON(rt.state.orient.w, up.state.orient.w, "and stays a unit quaternion")
        }

        // `groundAt` is threaded, not global: two runtimes over different terrain settle at
        // different heights from the same call.
        do {
            let low = DiscRuntime()
            low.groundAt = { _, _ in 0 }
            let high = DiscRuntime()
            high.groundAt = { x, z in 2 + 0.1 * x - 0.05 * z }
            low.settle(Vec3d(5, 0, -3))
            high.settle(Vec3d(5, 0, -3))
            Check.bitEqViaJSON(
                low.state.pos.y, DiscBody.standard.halfHeight, "flat terrain settles at the lip")
            Check.bitEqViaJSON(
                high.state.pos.y, 2 + 0.1 * 5 - 0.05 * -3 + DiscBody.standard.halfHeight,
                "sloped terrain settles on its own surface")
        }
    }
}
