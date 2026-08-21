import Foundation
import UltimateSim

/// `Locomotion` — the integration layer over `Move`'s primitives.
///
/// `MoveTests` covers the leaf functions this module composes: `derive` and its
/// scalar helpers, the gait-planning scalars (`stepRate`/`dutyFactor`/
/// `stanceHalfWidth`) and `plantForCut`, `gradeAlong`/`slopeMultiplier`,
/// `compliance`, and `predictPos`/`reachAt`. This suite does not re-derive any of
/// that. What it covers is everything `Locomotion` itself adds: `advanceGait`'s
/// phase oscillator and footstep placement, `accumulateSeparation`'s pairwise
/// solve, `DiscProbe`, `contestAir`'s scoring arithmetic (built on top of the
/// already-proven `predictPos`/`reachAt`), and the state machine, integrator and
/// contact resolver in `Locomotion.swift`/`LocomotionContacts.swift` themselves —
/// none of which has a second statement anywhere else in the codebase.
///
/// # Method
///
/// Almost everything `Locomotion` adds beyond `Move` is `private` or
/// module-internal — `classify`, `resolveMode`, `turnToward`, `solveGround`,
/// `startCut`/`endCut`, `beginJump`/`beginLayout`/`takeoff`, `slide`,
/// `getUpTime`, `conformY`, `stepPivot`/`openGrace` are none of them reachable
/// from this module. The only door in is the public surface: `create`, `step`,
/// `resolveCollisions`, `contest`, `timeToReach`, `intentToDesired`, `pivotOf`,
/// `rePivot`, `peakReach`, `apply`/`syncTo` — plus `LocoPlayer`'s stored
/// properties, which are all public and settable, so a scenario is built by
/// constructing a player directly in the state under test rather than by calling
/// a private setter.
///
/// That shapes the suite into four registers, matched per function to what it
/// actually claims rather than forced into one shape:
///
///  - **Independent models**, for the pieces with a clean closed-form
///    restatement: `advanceGait`'s phase oscillator, `accumulateSeparation`'s
///    pairwise solve, `contestAir`'s scoring arithmetic (typed fresh from
///    `Contest.swift`'s own doc comments, built on the already-proven
///    `predictPos`/`reachAt` rather than re-deriving those), `create`'s seating
///    and gait-offset draw, `fromAIAttributes`'s fallback chains, and
///    `intentToDesired`'s arrive/pose/action mapping.
///  - **An enumerated, total state sweep**, for `groundPhase`'s switch over the
///    thirteen `LocoStateName` cases — driven through `step()` by constructing a
///    player already in each state, at and around every threshold the switch
///    tests (`stateT >= stateDur`, a slide below 0.30 m/s, the 0.12 s prone
///    floor), the same discipline `GameStateTests` uses for the phase machine.
///  - **Physical laws**, where a trajectory has no second useful statement of
///    itself: velocity never exceeds the mode cap, a cut cannot reverse a
///    velocity in one step, gravity integrates the same way airborne and free,
///    landing never interpenetrates the ground, stamina stays in `[0, 100]`,
///    the soft separation tier writes no velocity, the hard tier's normal
///    impulse fires only on approach, an anchored thrower is immovable, a
///    locked pivot foot only drags under `PIVOT_ARREST`.
///  - **A self-driven trace**, replacing the golden's scripted replay, for
///    claims that only a trajectory can settle — a cut costs real speed but not
///    all of it, a jump gathers before it leaves the ground, uphill is slower
///    than downhill — read off a script this suite drives itself rather than
///    off recorded values.
///
/// # Tolerance
///
/// `advanceGait` and `contestAir` both read `p.facing` through `sin`/`cos`.
/// `SinCos.swift`'s own header explains why: LLVM may fuse an adjacent
/// `sin(x)`/`cos(x)` pair on the same argument into a single `__sincos_stret`
/// call that does not return the same `sin` `Foundation.sin` does on its own,
/// and production routes every trig call through `@inline(never)` wrappers
/// specifically to block that fusion. Test code is not under that discipline —
/// `Foundation.sin`/`Foundation.cos` here may or may not get fused by this
/// file's own optimizer pass — so anything downstream of a facing-dependent
/// direction is compared with a tight tolerance (`trigTol`) rather than
/// `bitEq`, even though the underlying arithmetic is otherwise exact. Anything
/// that only touches `+ - * / sqrt min max clamp floor` is bit-exact.
enum LocomotionTests {

    // MARK: - tolerances

    /// For anything downstream of a `sin`/`cos` call in this file's own model
    /// code. See the header for why this cannot be `bitEq`.
    private static let trigTol = 1e-9
    /// For anything downstream of `hypot`, `pow`, `exp`, `acos` — none specified
    /// to the last ulp by any libm, same rationale `MoveTests`/`FlightTests` use.
    private static let mathTol = 1e-9

    // MARK: - run

    static func run() throws {
        constants()
        createTests()
        gaitTests()
        separationTests()
        discProbeTests()
        contestTests()
        timeToReachTests()
        intentToDesiredTests()
        fromAIAttributesTests()
        syncApplyTests()

        stateMachine()
        cutMechanics()
        jumpLayoutMechanics()
        pivotMechanics()
        collisionMechanics()
        staminaTests()

        flatWorldClaims()
        selfDrivenTraceClaims()
    }

    // MARK: - constants

    /// Every tuning constant `Locomotion` declares, pinned by exact value — not
    /// merely by relation to its neighbours — for the reason `MoveTests`'
    /// `constants()` and issue #58's `aimath` finding both give: a relation
    /// survives the value moving, and the fixtures that used to pin these
    /// numbers are gone.
    private static func constants() {
        Check.bitEq(Locomotion.CUT_ANGLE, 45 * Double.pi / 180, "CUT_ANGLE")
        Check.bitEq(Locomotion.CUT_MIN_SPEED, 2.2, "CUT_MIN_SPEED")
        Check.bitEq(Locomotion.PLANT_GRIP, 1.8, "PLANT_GRIP")
        Check.bitEq(Locomotion.PLANT_BRAKE, 1.35, "PLANT_BRAKE")
        Check.bitEq(Locomotion.CUT_LOSS_BASE, 0.28, "CUT_LOSS_BASE")
        Check.bitEq(Locomotion.CUT_REFRACTORY, 0.22, "CUT_REFRACTORY")
        Check.bitEq(Locomotion.JUMP_GATHER, 0.12, "JUMP_GATHER")
        Check.bitEq(Locomotion.LAYOUT_GATHER, 0.06, "LAYOUT_GATHER")
        Check.bitEq(Locomotion.JUMP_HORIZ_KEEP, 0.88, "JUMP_HORIZ_KEEP")
        Check.bitEq(Locomotion.AIR_CONTROL, 0.7, "AIR_CONTROL")
        Check.bitEq(Locomotion.SLIDE_DECEL, 15.7, "SLIDE_DECEL")
        Check.bitEq(Locomotion.LAND_HORIZ_KEEP, 0.62, "LAND_HORIZ_KEEP")
        Check.bitEq(Locomotion.COLLIDE_BETA, 0.80, "COLLIDE_BETA")
        Check.bitEq(Locomotion.COLLIDE_SLOP, 0.002, "COLLIDE_SLOP")
        Check.bitEq(Locomotion.COLLIDE_RESTITUTION, 0.03, "COLLIDE_RESTITUTION")
        Check.bitEq(Locomotion.COLLIDE_FRICTION, 0.45, "COLLIDE_FRICTION")
        Check.bitEq(Locomotion.COLLIDE_Y_SPAN, 1.0, "COLLIDE_Y_SPAN")
        Check.bitEq(Locomotion.DEFAULT_RADIUS, 0.32, "DEFAULT_RADIUS")
        Check.bitEq(Locomotion.PIVOT_R, 0.75, "PIVOT_R")
        Check.bitEq(Locomotion.PIVOT_ARREST, 30.0, "PIVOT_ARREST")
        Check.bitEq(Locomotion.PIVOT_STOP_SPEED, 1.2, "PIVOT_STOP_SPEED")
        Check.bitEq(Locomotion.PIVOT_GRACE, 1.5, "PIVOT_GRACE")
        Check.bitEq(Locomotion.PIVOT_STOP_SLACK, 0.6, "PIVOT_STOP_SLACK")
        Check.bitEq(Locomotion.PIVOT_CARRY_MAX, 3.2, "PIVOT_CARRY_MAX")

        // Orderings the model relies on and never states as code.
        Check.ok(Locomotion.CUT_REFRACTORY > 0, "there is a real gap between consecutive cuts")
        Check.ok(
            Locomotion.PLANT_GRIP > 1 && Locomotion.PLANT_BRAKE > 1,
            "a planted foot grips and brakes harder than a running one")
        Check.ok(
            Locomotion.LAND_HORIZ_KEEP < Locomotion.JUMP_HORIZ_KEEP,
            "landing costs more speed than taking off does")
        Check.ok(Locomotion.AIR_CONTROL < 1, "air steering is a token amount")
        Check.ok(
            Locomotion.PIVOT_STOP_SLACK < Locomotion.PIVOT_CARRY_MAX,
            "the base slack is short of the hard cap — the cap can actually bind")
        Check.ok(
            Locomotion.COLLIDE_RESTITUTION < 1, "hard contact is inelastic, not a bounce")
    }

    // MARK: - create()

    /// `create()`'s own arithmetic: seating the body on the terrain at
    /// `heightAt + 0.53 * height`, deriving the initial capability cache, and
    /// drawing the gait-phase offset from a *forked* copy of the model's own
    /// stream — a draw that must not disturb the parent, or the very next
    /// `create()` would see a shifted sequence.
    private static func createTests() {
        let field = FieldLike(heightAt: { x, z in 0.2 * x - 0.1 * z }, normalAt: { _, _ in Vec3d(0, 1, 0) })

        let presets: [(id: Int, height: Double, mass: Double, pos: Vec3d, facing: Double, stamina: Double?)] = [
            (1, 1.83, 82, Vec3d(0, 0, 0), 0, nil),
            (2, 2.05, 100, Vec3d(3, 0, -4), 1.2, 55),
            (42, 1.60, 65, Vec3d(-7, 0, 12), -2.4, 0),
            (0x9e37, 1.90, 90, Vec3d(0.001, 0, -0.001), 3.0, 100),
        ]

        for preset in presets {
            let loco = Locomotion()
            loco.attach(LocoHost(field: field))
            var attr = Attributes.defaultAttrs
            attr.height = preset.height
            attr.mass = preset.mass
            let opts = CreateOpts(
                id: preset.id, pos: preset.pos, facing: preset.facing, stamina: preset.stamina)
            var withAttr = opts
            withAttr.attr = attr
            let p = loco.create(withAttr)

            let hipHeight = 0.53 * preset.height
            let wantY = field.heightAt!(preset.pos.x, preset.pos.z) + hipHeight
            let at = "create(id \(preset.id))"
            Check.bitEq(p.pos.x, preset.pos.x, "\(at).pos.x is untouched")
            Check.bitEq(p.pos.y, wantY, "\(at).pos.y sits on the terrain plus hip height")
            Check.bitEq(p.pos.z, preset.pos.z, "\(at).pos.z is untouched")
            Check.bitEq(p.groundY, p.pos.y - hipHeight, "\(at).groundY is the terrain height")
            Check.bitEq(p.hipHeight, hipHeight, "\(at).hipHeight is 0.53 * height")
            Check.bitEq(p.foot.pos.y, p.pos.y - hipHeight, "\(at).foot.pos.y starts at groundY")
            Check.bitEq(p.foot.pos.x, preset.pos.x, "\(at).foot.pos.x starts under the body")
            Check.bitEq(p.foot.pos.z, preset.pos.z, "\(at).foot.pos.z starts under the body")
            Check.eq(p.radius, Locomotion.DEFAULT_RADIUS, "\(at).radius defaults")
            Check.bitEq(
                p.personal, Swift.max(Locomotion.DEFAULT_RADIUS, PERSONAL_RADIUS),
                "\(at).personal is max(radius, PERSONAL_RADIUS)")
            Check.eq(p.stamina, preset.stamina ?? 100, "\(at).stamina defaults to 100")
            Check.eq(p.state, .idle, "\(at) starts idle")
            Check.ok(!p.anchored, "\(at) starts unanchored")

            let wantDerived = UltimateSim.derive(attr, stamina: p.stamina, speed: 0, mode: .run)
            Check.bitEq(p.derived.topSpeed, wantDerived.topSpeed, "\(at).derived.topSpeed")
            Check.bitEq(p.derived.accelMax, wantDerived.accelMax, "\(at).derived.accelMax")
            Check.bitEq(p.derived.modeCap, wantDerived.modeCap, "\(at).derived.modeCap")

            // The gait-phase draw: a fresh, unattached model's stream is the
            // literal default seed; a fork of it with salt `id*977+11` must not
            // disturb that stream, so a second `create()` on the same instance
            // sees the same fork it would have seen first.
            let model = Rng(seed: 0x10c0_5eed)
            let wantPhase = model.fork(salt: preset.id * 977 + 11).next() * 0.999
            Check.bitEq(p.foot.phase, wantPhase, "\(at).foot.phase is the forked draw")

            // get()/remove() round-trip.
            Check.ok(loco.get(preset.id) === p, "\(at): get(id) returns the same instance")
            loco.remove(preset.id)
            Check.ok(loco.get(preset.id) == nil, "\(at): remove(id) forgets it")
            Check.ok(
                !loco.players.contains(where: { $0 === p }),
                "\(at): remove(id) drops it from the roster")
        }

        // Two creates on the same instance: the second's fork must not have been
        // shifted by the first's draw.
        let loco = Locomotion()
        loco.attach(LocoHost())
        let a = loco.create(CreateOpts(id: 5))
        let b = loco.create(CreateOpts(id: 9))
        let model = Rng(seed: 0x10c0_5eed)
        let wantA = model.fork(salt: 5 * 977 + 11).next() * 0.999
        let wantB = model.fork(salt: 9 * 977 + 11).next() * 0.999
        Check.bitEq(a.foot.phase, wantA, "first create's phase draw is unaffected by the second")
        Check.bitEq(b.foot.phase, wantB, "second create's phase draw")

        // A parent stream: `attach` forks it with salt 0x10c0 before any `create`
        // draws off it.
        let parent = Rng(seed: 0xC0FF_EE)
        let attached = Locomotion()
        attached.attach(LocoHost(rand: parent))
        let c = attached.create(CreateOpts(id: 7))
        let parentModel = Rng(seed: 0xC0FF_EE)
        let base = parentModel.fork(salt: 0x10c0)
        let wantC = base.fork(salt: 7 * 977 + 11).next() * 0.999
        Check.bitEq(c.foot.phase, wantC, "a parent stream is forked before the id draw")
    }

    // MARK: - advanceGait

    /// `advanceGait`'s own model: a phase oscillator whose frequency is
    /// `stepRate(speed)` (already pinned in `MoveTests`), advanced by `rate *
    /// dt` each call and wrapped at 1; a plant fires on the step that wraps,
    /// placing the newly-planted foot ahead of the body along its direction of
    /// travel and offset to the stance side, sampling `groundY` there. Typed
    /// fresh from `Gait.swift`'s own doc comments rather than from
    /// `advanceGait` itself.
    private struct GaitModel {
        var contact: Bool
        var phase: Double
        var stride: Double
        var planted: Bool
        var footPlanted: Foot
        var footPos: Vec3d
        var footT: Double
        var footSpeed: Double
        var footHard: Bool
    }

    private static func modelAdvanceGait(
        facing: Double, posX: Double, posZ: Double, pT: Double,
        footPlanted: Foot, footPos: Vec3d, footT: Double, footSpeed: Double, footHard: Bool,
        footPhase: Double,
        speed: Double, velX: Double, velZ: Double, mode: MoveMode, dt: Double,
        groundY: (Double, Double) -> Double
    ) -> GaitModel {
        if speed < GAIT_MIN_SPEED {
            return GaitModel(
                contact: true, phase: 0, stride: 0, planted: false, footPlanted: footPlanted,
                footPos: footPos, footT: footT, footSpeed: footSpeed, footHard: footHard)
        }
        let rate = stepRate(speed)
        let stride = speed / rate
        var phase = footPhase + rate * dt
        var planted = false
        if phase >= 1 {
            phase -= phase.rounded(.down)
            planted = true
        }
        let contact = phase < dutyFactor(speed)
        if !planted {
            return GaitModel(
                contact: contact, phase: phase, stride: stride, planted: false,
                footPlanted: footPlanted, footPos: footPos, footT: footT, footSpeed: footSpeed,
                footHard: footHard)
        }
        let next: Foot = footPlanted == .left ? .right : .left
        let inv = 1 / Swift.max(1e-6, speed)
        let dx = velX * inv
        let dz = velZ * inv
        let fx = Foundation.sin(facing)
        let fz = Foundation.cos(facing)
        let rx = -fz
        let rz = fx
        let half = stanceHalfWidth(speed, mode: mode) * (next == .right ? 1 : -1)
        let ahead = stride * 0.30
        let px = posX + dx * ahead + rx * half
        let pz = posZ + dz * ahead + rz * half
        let py = groundY(px, pz)
        return GaitModel(
            contact: true, phase: phase, stride: stride, planted: true, footPlanted: next,
            footPos: Vec3d(px, py, pz), footT: pT, footSpeed: speed, footHard: false)
    }

    private static func gaitTests() {
        struct Preset {
            let label: String
            let facing: Double
            let mode: MoveMode
            let speed: (Int) -> Double
            let velX: (Int) -> Double
            let velZ: (Int) -> Double
        }
        let presets: [Preset] = [
            Preset(
                label: "steady sprint north", facing: 0, mode: .sprint, speed: { _ in 8.0 },
                velX: { _ in 0 }, velZ: { _ in 8.0 }),
            Preset(
                label: "steady jog, facing east", facing: Double.pi / 2, mode: .jog,
                speed: { _ in 1.2 }, velX: { _ in 1.2 }, velZ: { _ in 0 }),
            Preset(
                label: "accelerating from a stand", facing: -0.6, mode: .run,
                speed: { i in Swift.min(6.0, Double(i) * 0.15) },
                velX: { i in Swift.min(6.0, Double(i) * 0.15) * 0.6 },
                velZ: { i in Swift.min(6.0, Double(i) * 0.15) * 0.8 }),
            Preset(
                label: "backpedal", facing: 2.1, mode: .backpedal, speed: { _ in 2.4 },
                velX: { _ in -1.0 }, velZ: { _ in -2.16 }),
            Preset(
                label: "diagonal shuffle", facing: -1.4, mode: .shuffle, speed: { _ in 3.1 },
                velX: { _ in 2.19 }, velZ: { _ in -2.19 }),
            Preset(
                label: "speed hovers right at GAIT_MIN_SPEED", facing: 0.3, mode: .run,
                speed: { i in i % 4 == 0 ? 0.30 : 0.40 }, velX: { _ in 0.35 }, velZ: { _ in 0.15 }),
            Preset(
                label: "speed param disagrees with hypot(vel)", facing: 1.0, mode: .sprint,
                speed: { _ in 5.0 }, velX: { _ in 0 }, velZ: { _ in 0.001 }),
        ]

        let ground: (Double, Double) -> Double = { x, z in 0.05 * x - 0.02 * z }
        let dt = 1.0 / 120.0

        for preset in presets {
            let p = LocoPlayer(id: 1, attr: .defaultAttrs, pos: Vec3d(2, 0, -3), facing: preset.facing)
            var model = GaitModel(
                contact: p.foot.contact, phase: p.foot.phase, stride: p.foot.stride,
                planted: false, footPlanted: p.foot.planted, footPos: p.foot.pos, footT: p.foot.t,
                footSpeed: p.foot.speed, footHard: p.foot.hard)

            for i in 0..<200 {
                p.t += dt
                p.facing = preset.facing
                let speed = preset.speed(i)
                let vx = preset.velX(i)
                let vz = preset.velZ(i)
                let before = (
                    planted: p.foot.planted, pos: p.foot.pos, t: p.foot.t, speed: p.foot.speed,
                    hard: p.foot.hard
                )

                let got = advanceGait(
                    p, speed: speed, velX: vx, velZ: vz, mode: preset.mode, dt: dt, groundY: ground)
                model = modelAdvanceGait(
                    facing: preset.facing, posX: p.pos.x, posZ: p.pos.z, pT: p.t,
                    footPlanted: before.planted, footPos: before.pos, footT: before.t,
                    footSpeed: before.speed, footHard: before.hard, footPhase: model.phase,
                    speed: speed, velX: vx, velZ: vz, mode: preset.mode, dt: dt, groundY: ground)

                let at = "advanceGait(\(preset.label))[\(i)]"
                Check.eq(p.foot.contact, model.contact, "\(at).contact")
                Check.near(p.foot.phase, model.phase, mathTol, "\(at).phase")
                Check.near(p.foot.stride, model.stride, mathTol, "\(at).stride")
                Check.eq(got.planted, model.planted, "\(at).plant fired")
                Check.eq(p.foot.planted, model.footPlanted, "\(at).foot.planted")
                Check.near(p.foot.pos.x, model.footPos.x, trigTol, "\(at).foot.pos.x")
                Check.bitEq(p.foot.pos.y, model.footPos.y, "\(at).foot.pos.y")
                Check.near(p.foot.pos.z, model.footPos.z, trigTol, "\(at).foot.pos.z")
                Check.bitEq(p.foot.t, model.footT, "\(at).foot.t")
                Check.bitEq(p.foot.speed, model.footSpeed, "\(at).foot.speed")
                Check.eq(p.foot.hard, model.footHard, "\(at).foot.hard is never hard from a run")
                if got.planted {
                    Check.eq(got.foot, model.footPlanted, "\(at).PlantResult.foot")
                    Check.near(got.x, model.footPos.x, trigTol, "\(at).PlantResult.x")
                    Check.bitEq(got.y, model.footPos.y, "\(at).PlantResult.y")
                    Check.near(got.z, model.footPos.z, trigTol, "\(at).PlantResult.z")
                    Check.bitEq(got.speed, speed, "\(at).PlantResult.speed")
                }
            }
        }

        // The standing branch: below GAIT_MIN_SPEED nothing but contact/phase/
        // stride moves, and repeated calls do not drift the foot.
        let stander = LocoPlayer(id: 1, attr: .defaultAttrs)
        stander.foot.planted = .right
        stander.foot.pos = Vec3d(1, 2, 3)
        stander.foot.t = 9
        stander.foot.speed = 4
        stander.foot.hard = true
        for _ in 0..<10 {
            let out = advanceGait(
                stander, speed: 0.1, velX: 0, velZ: 0, mode: .run, dt: dt, groundY: { _, _ in 0 })
            Check.ok(!out.planted, "standing never plants")
            Check.eq(stander.foot.contact, true, "standing: both feet loaded")
            Check.bitEq(stander.foot.phase, 0, "standing: phase held at zero")
            Check.bitEq(stander.foot.stride, 0, "standing: stride held at zero")
            Check.eq(stander.foot.planted, .right, "standing does not change which foot")
            Check.bitEq(stander.foot.pos.x, 1, "standing does not move the foot (x)")
            Check.bitEq(stander.foot.pos.y, 2, "standing does not move the foot (y)")
            Check.bitEq(stander.foot.pos.z, 3, "standing does not move the foot (z)")
            Check.bitEq(stander.foot.t, 9, "standing does not touch the plant clock")
            Check.bitEq(stander.foot.speed, 4, "standing does not touch the plant speed")
            Check.eq(stander.foot.hard, true, "standing does not clear a hard flag")
        }
    }

    // MARK: - accumulateSeparation

    /// `accumulateSeparation`'s own model, typed from `Separation.swift`'s doc
    /// comments: per-body soft radius faded toward a live disc by a smoothstep
    /// between `DISC_GRAB_R` and `DISC_FREE_R`; a Jacobi pass over every pair
    /// weighted by `compliance()` (already proven correct in `MoveTests`, reused
    /// here rather than re-derived); engagement ramped by a second smoothstep
    /// between the soft and hard radii; a half-step gain; and a per-body ceiling
    /// on the resultant. `pairAxis`'s constant (`LATERAL_MIN = 0.25`, "~14
    /// degrees either side of head-on") is typed from its doc comment, since the
    /// value itself is `private` and unreachable from this module.
    private static let modelLateralMin = 0.25

    private static func modelPairAxis(
        cmdA: Vec2d, cmdB: Vec2d, nx: Double, nz: Double, idA: Int, idB: Int
    ) -> (Double, Double) {
        var cx = cmdA.x - cmdB.x
        var cz = cmdA.z - cmdB.z
        let cl = (cx * cx + cz * cz).squareRoot()
        if cl < 1e-3 { return (nx, nz) }
        cx /= cl
        cz /= cl
        let along = nx * cx + nz * cz
        let px = nx - along * cx
        let pz = nz - along * cz
        let pl = (px * px + pz * pz).squareRoot()
        if pl >= modelLateralMin { return (px / pl, pz / pl) }
        let s: Double = idA < idB ? 1 : -1
        return (cz * s, -cx * s)
    }

    private struct SepBody {
        let id: Int
        let x, z, y: Double
        let cmd: Vec2d
        let compliance: Double
        let radius: Double
        let personal: Double
        /// Forces the real `compliance()` to see a body that yields no ground —
        /// the model's `compliance` field must be `0` whenever this is `true`.
        var anchored: Bool = false
        var mass: Double = Attributes.defaultAttrs.mass
        var strength: Double = Attributes.defaultAttrs.strength
    }

    private static func modelAccumulateSeparation(
        _ bodies: [SepBody], dt: Double, disc: DiscFocus?
    ) -> (outX: [Double], outZ: [Double], engaged: Int) {
        let n = bodies.count
        var outX = [Double](repeating: 0, count: n)
        var outZ = [Double](repeating: 0, count: n)
        var engaged = 0
        let step = SEP_RATE * dt

        var soften = [Double](repeating: 0, count: n)
        for i in 0..<n {
            let b = bodies[i]
            guard let disc = disc, disc.live else {
                soften[i] = b.personal
                continue
            }
            let d = ((b.x - disc.x) * (b.x - disc.x) + (b.z - disc.z) * (b.z - disc.z)).squareRoot()
            let t = clamp01((d - DISC_GRAB_R) / (DISC_FREE_R - DISC_GRAB_R))
            soften[i] = b.radius + (b.personal - b.radius) * (t * t * (3 - 2 * t))
        }

        for i in 0..<n {
            let a = bodies[i]
            let wa = a.compliance
            for j in (i + 1)..<n {
                let b = bodies[j]
                let wb = b.compliance
                let wsum = wa + wb
                if wsum <= 0 { continue }
                if abs(a.y - b.y) > SEP_Y_SPAN { continue }

                var sx = b.x - a.x
                var sz = b.z - a.z
                let soft = soften[i] + soften[j]
                let d2 = sx * sx + sz * sz
                if d2 >= soft * soft { continue }

                var dist = d2.squareRoot()
                if dist < 1e-4 {
                    let k = Double((a.id * 31 + b.id) % 16) * (Double.pi / 8)
                    sx = Foundation.cos(k)
                    sz = Foundation.sin(k)
                    dist = 1e-4
                }
                let nx = sx / dist, nz = sz / dist
                let pen = soft - dist - SEP_DEADBAND
                if pen <= 0 { continue }

                let hard = a.radius + b.radius
                let span = Swift.max(1e-4, soft - hard)
                let tw = clamp01((soft - dist) / span)
                let w = tw * tw * (3 - 2 * tw)
                let amount = Swift.min(step * w, pen * 0.5)
                if amount <= 1e-7 { continue }

                let L = modelPairAxis(cmdA: a.cmd, cmdB: b.cmd, nx: nx, nz: nz, idA: a.id, idB: b.id)
                let fa = wa / wsum, fb = wb / wsum
                outX[i] -= L.0 * amount * fa
                outZ[i] -= L.1 * amount * fa
                outX[j] += L.0 * amount * fb
                outZ[j] += L.1 * amount * fb
                engaged += 1
            }
        }

        if engaged > 0 {
            for i in 0..<n {
                let m = (outX[i] * outX[i] + outZ[i] * outZ[i]).squareRoot()
                if m > step {
                    let k = step / m
                    outX[i] *= k
                    outZ[i] *= k
                }
            }
        }
        return (outX, outZ, engaged)
    }

    private static func buildList(_ specs: [SepBody]) -> [LocoPlayer] {
        specs.map { s in
            var attr = Attributes.defaultAttrs
            attr.mass = s.mass
            attr.strength = s.strength
            let p = LocoPlayer(id: s.id, attr: attr, pos: Vec3d(s.x, s.y, s.z))
            p.radius = s.radius
            p.personal = s.personal
            p.cmd = s.cmd
            p.anchored = s.anchored
            return p
        }
    }

    private static func compareSeparation(_ specs: [SepBody], dt: Double, disc: DiscFocus?, _ at: String) {
        let list = buildList(specs)
        // `compliance()` reads state/prone/anchored/airborne, none of which
        // `buildList` sets, so every body here is a plain grounded, unanchored
        // athlete — `SepBody.compliance` is only used by the model, and is
        // asserted to equal what production's own `compliance()` sees.
        for (i, s) in specs.enumerated() {
            Check.bitEq(
                UltimateSim.compliance(list[i]), s.compliance, "\(at): body \(s.id)'s compliance()")
        }
        var outX = [Double](repeating: 0, count: list.count)
        var outZ = [Double](repeating: 0, count: list.count)
        let engaged = accumulateSeparation(list, dt: dt, outX: &outX, outZ: &outZ, disc: disc)
        let want = modelAccumulateSeparation(specs, dt: dt, disc: disc)
        Check.eq(engaged, want.engaged, "\(at).engaged")
        for i in 0..<list.count {
            Check.near(outX[i], want.outX[i], trigTol, "\(at).outX[\(i)]")
            Check.near(outZ[i], want.outZ[i], trigTol, "\(at).outZ[\(i)]")
        }
    }

    private static func separationTests() {
        let base = Attributes.defaultAttrs
        func compliance(mass: Double = base.mass, strength: Double = base.strength) -> Double {
            1 / Swift.max(1, mass * (1 + 0.35 * clamp01(strength / 100)))
        }
        let c0 = compliance()
        let dt = 1.0 / 120.0

        // Two bodies, closing distance from well outside personal space down
        // through the soft radius, through the ramp, to coincident.
        let distances = [3.0, 2.0, 1.4, 1.28, 1.0, 0.7, 0.64, 0.3, 0.05, 0.0]
        for d in distances {
            compareSeparation(
                [
                    SepBody(id: 1, x: 0, z: 0, y: 0, cmd: Vec2d(1, 0), compliance: c0, radius: 0.32, personal: 0.63),
                    SepBody(id: 2, x: d, z: 0, y: 0, cmd: Vec2d(-1, 0), compliance: c0, radius: 0.32, personal: 0.63),
                ], dt: dt, disc: nil, "two bodies at \(d) m, head-on cmd")
            compareSeparation(
                [
                    SepBody(id: 1, x: 0, z: 0, y: 0, cmd: Vec2d(0, 1), compliance: c0, radius: 0.32, personal: 0.63),
                    SepBody(id: 2, x: d, z: 0, y: 0, cmd: Vec2d(0, 1), compliance: c0, radius: 0.32, personal: 0.63),
                ], dt: dt, disc: nil, "two bodies at \(d) m, same cmd (degenerate lateral)")
            compareSeparation(
                [
                    SepBody(id: 1, x: 0, z: 0, y: 0, cmd: .zero, compliance: c0, radius: 0.32, personal: 0.63),
                    SepBody(id: 2, x: 0, z: d, y: 0, cmd: .zero, compliance: c0, radius: 0.32, personal: 0.63),
                ], dt: dt, disc: nil, "two bodies at \(d) m along z, no cmd at all")
        }

        // Vertical separation beyond SEP_Y_SPAN misses entirely.
        compareSeparation(
            [
                SepBody(id: 1, x: 0, z: 0, y: 0, cmd: .zero, compliance: c0, radius: 0.32, personal: 0.63),
                SepBody(id: 2, x: 0.2, z: 0, y: 1.5, cmd: .zero, compliance: c0, radius: 0.32, personal: 0.63),
            ], dt: dt, disc: nil, "bodies more than SEP_Y_SPAN apart")

        // A pair where one body is anchored — the real `compliance()` sees it
        // as zero — takes the whole correction; the other never engages this
        // pair at all if BOTH are anchored, since wsum is then zero.
        compareSeparation(
            [
                SepBody(id: 1, x: 0, z: 0, y: 0, cmd: Vec2d(1, 0), compliance: 0, radius: 0.32, personal: 0.63, anchored: true),
                SepBody(id: 2, x: 0.5, z: 0, y: 0, cmd: Vec2d(-1, 0), compliance: c0, radius: 0.32, personal: 0.63),
            ], dt: dt, disc: nil, "one body immovable")
        compareSeparation(
            [
                SepBody(id: 1, x: 0, z: 0, y: 0, cmd: .zero, compliance: 0, radius: 0.32, personal: 0.63, anchored: true),
                SepBody(id: 2, x: 0.5, z: 0, y: 0, cmd: .zero, compliance: 0, radius: 0.32, personal: 0.63, anchored: true),
            ], dt: dt, disc: nil, "both bodies immovable — wsum is zero")

        // Three bodies squeezed together, to exercise the per-body ceiling: the
        // middle body is engaged with both neighbours and could be handed the
        // sum of two full corrections.
        compareSeparation(
            [
                SepBody(id: 1, x: -0.5, z: 0, y: 0, cmd: Vec2d(1, 0), compliance: c0, radius: 0.32, personal: 0.63),
                SepBody(id: 2, x: 0, z: 0, y: 0, cmd: .zero, compliance: c0, radius: 0.32, personal: 0.63),
                SepBody(id: 3, x: 0.5, z: 0, y: 0, cmd: Vec2d(-1, 0), compliance: c0, radius: 0.32, personal: 0.63),
            ], dt: dt, disc: nil, "three bodies, middle one squeezed")

        // A pair with unequal compliance (asymmetric mass/strength): the
        // lighter body should take the larger share of the correction, and the
        // model and production must agree on the split, not just the total.
        let heavy = compliance(mass: 100, strength: 90)
        let light = compliance(mass: 60, strength: 20)
        compareSeparation(
            [
                SepBody(
                    id: 1, x: 0, z: 0, y: 0, cmd: Vec2d(1, 0), compliance: light, radius: 0.32,
                    personal: 0.63, mass: 60, strength: 20),
                SepBody(
                    id: 2, x: 0.9, z: 0, y: 0, cmd: Vec2d(-1, 0), compliance: heavy, radius: 0.32,
                    personal: 0.63, mass: 100, strength: 90),
            ], dt: dt, disc: nil, "unequal compliance")

        // The disc softening: dead disc, live disc far away (no fade), live
        // disc close (fully softened), live disc mid-fade.
        let discs: [(String, DiscFocus?)] = [
            ("no disc at all", nil),
            ("held disc (not live)", DiscFocus(x: 0, z: 0, live: false)),
            ("live disc far from both bodies", DiscFocus(x: 50, z: 50, live: true)),
            ("live disc between them", DiscFocus(x: 0.45, z: 0, live: true)),
            ("live disc right on body 1", DiscFocus(x: 0, z: 0, live: true)),
        ]
        for (label, disc) in discs {
            compareSeparation(
                [
                    SepBody(id: 1, x: 0, z: 0, y: 0, cmd: Vec2d(1, 0), compliance: c0, radius: 0.32, personal: 0.63),
                    SepBody(id: 2, x: 0.9, z: 0, y: 0, cmd: Vec2d(-1, 0), compliance: c0, radius: 0.32, personal: 0.63),
                ], dt: dt, disc: disc, "disc scenario: \(label)")
        }

        // A large dt, so the per-body ceiling (`step = SEP_RATE * dt`) actually
        // binds rather than the half-overlap term.
        compareSeparation(
            [
                SepBody(id: 1, x: 0, z: 0, y: 0, cmd: .zero, compliance: c0, radius: 0.32, personal: 0.63),
                SepBody(id: 2, x: 0.4, z: 0, y: 0, cmd: .zero, compliance: c0, radius: 0.32, personal: 0.63),
            ], dt: 1.0 / 10.0, disc: nil, "a large dt")

        // No engagement at all: nothing within soft range of anything.
        compareSeparation(
            [
                SepBody(id: 1, x: 0, z: 0, y: 0, cmd: .zero, compliance: c0, radius: 0.32, personal: 0.63),
                SepBody(id: 2, x: 20, z: 0, y: 0, cmd: .zero, compliance: c0, radius: 0.32, personal: 0.63),
            ], dt: dt, disc: nil, "nobody close enough to engage")

        // A law rather than a value: the resultant on any engaged body is
        // capped at `SEP_RATE * dt`, whatever the geometry threw at it.
        let list = buildList([
            SepBody(id: 1, x: 0, z: 0, y: 0, cmd: .zero, compliance: c0, radius: 0.32, personal: 0.63),
            SepBody(id: 2, x: 0.01, z: 0, y: 0, cmd: .zero, compliance: c0, radius: 0.32, personal: 0.63),
            SepBody(id: 3, x: -0.01, z: 0.02, y: 0, cmd: .zero, compliance: c0, radius: 0.32, personal: 0.63),
            SepBody(id: 4, x: 0.02, z: -0.01, y: 0, cmd: .zero, compliance: c0, radius: 0.32, personal: 0.63),
        ])
        var outX = [Double](repeating: 0, count: list.count)
        var outZ = [Double](repeating: 0, count: list.count)
        _ = accumulateSeparation(list, dt: dt, outX: &outX, outZ: &outZ, disc: nil)
        let ceiling = SEP_RATE * dt
        for i in 0..<list.count {
            let m = (outX[i] * outX[i] + outZ[i] * outZ[i]).squareRoot()
            Check.ok(m <= ceiling + 1e-9, "body \(i) in a four-way pileup stays under the per-step ceiling")
        }
    }

    // MARK: - DiscProbe

    private static func discProbeTests() {
        let p = DiscProbe()
        p.bind(nil)
        let noRuntime = p.read()
        Check.ok(!noRuntime.live, "no runtime bound: not live")
        Check.bitEq(noRuntime.x, 0, "no runtime: x is zero")
        Check.bitEq(noRuntime.z, 0, "no runtime: z is zero")

        p.bind(DiscRuntimeInfo(mode: "held", posX: 5, posZ: -3))
        let held = p.read()
        Check.ok(!held.live, "a held disc is not live")
        Check.bitEq(held.x, 0, "a held disc reports x=0, not its actual position")
        Check.bitEq(held.z, 0, "a held disc reports z=0, not its actual position")

        for mode in ["thrown", "loose", "flying", nil] {
            p.bind(DiscRuntimeInfo(mode: mode, posX: 7, posZ: -2))
            let live = p.read()
            Check.ok(live.live, "mode \(mode ?? "nil") is live (anything but 'held')")
            Check.bitEq(live.x, 7, "a live disc reports its real x")
            Check.bitEq(live.z, -2, "a live disc reports its real z")
        }

        p.bind(DiscRuntimeInfo(mode: "loose", posX: nil, posZ: -2))
        Check.ok(!p.read().live, "a missing x is treated as no runtime at all")
        p.bind(DiscRuntimeInfo(mode: "loose", posX: .nan, posZ: 1))
        Check.ok(!p.read().live, "a non-finite x is treated as no runtime at all")
        p.bind(DiscRuntimeInfo(mode: "loose", posX: 1, posZ: .infinity))
        Check.ok(!p.read().live, "a non-finite z is treated as no runtime at all")

        // Rebinding to nil forgets the previous runtime.
        p.bind(nil)
        Check.ok(!p.read().live, "rebinding to nil clears the previous live runtime")
    }

    // MARK: - contestAir

    /// `contestAir`'s own arithmetic, typed from `Contest.swift`'s doc comments,
    /// built on the already-proven `predictPos`/`reachAt` rather than
    /// re-deriving them. `catchRadius` (`0.55 * height`) is typed from its own
    /// doc comment for the same reason `pairAxis`'s constant is above: the
    /// function is `private` and unreachable from this module.
    private static func modelCatchRadius(_ p: LocoPlayer) -> Double { 0.55 * p.attr.height }

    private struct ContestModel {
        var winner: ContestWinner
        var margin: Double
        var contact: Bool
        var foulOn: Contestant?
        var foulChance: Double
        var aEffective: Double
        var bEffective: Double
        var aBoxOut: Double
        var bBoxOut: Double
        var aScore: Double
        var bScore: Double
    }

    private static func modelContestAir(
        _ a: LocoPlayer, _ b: LocoPlayer, discPos: Vec3d, tContest: Double, jitter: Double
    ) -> ContestModel {
        let PA = UltimateSim.predictPos(a, t: tContest)
        let PB = UltimateSim.predictPos(b, t: tContest)
        let gapA = ((discPos.x - PA.x) * (discPos.x - PA.x) + (discPos.z - PA.z) * (discPos.z - PA.z)).squareRoot()
        let gapB = ((discPos.x - PB.x) * (discPos.x - PB.x) + (discPos.z - PB.z) * (discPos.z - PB.z)).squareRoot()
        let reachA = UltimateSim.reachAt(a, t: tContest)
        let reachB = UltimateSim.reachAt(b, t: tContest)
        let effA = reachA - 1.15 * Swift.max(0, gapA - modelCatchRadius(a))
        let effB = reachB - 1.15 * Swift.max(0, gapB - modelCatchRadius(b))
        let inside = clamp((gapB - gapA) * 0.35, -0.30, 0.30)

        let bx = PB.x - PA.x, bz = PB.z - PA.z
        let dxA = discPos.x - PA.x, dzA = discPos.z - PA.z
        let bodyDist = (bx * bx + bz * bz).squareRoot()
        var sealA = 0.0
        if bodyDist > 1e-4 {
            let dl = (dxA * dxA + dzA * dzA).squareRoot()
            if dl > 1e-4 {
                let dot = (bx * -dxA + bz * -dzA) / (bodyDist * dl)
                sealA = clamp(dot, -1, 1) * 0.14
            }
        }
        let jostle = bodyDist < 0.95 ? 1 - bodyDist / 0.95 : 0
        let strTerm = ((a.attr.strength - b.attr.strength) / 100) * 0.22 * jostle
        let boxA = inside + sealA + strTerm + jitter * 0.02
        let boxB = -inside - sealA - strTerm - jitter * 0.02
        let scoreA = effA + boxA
        let scoreB = effB + boxB
        let margin = abs(scoreA - scoreB)

        let contact = bodyDist < 0.85
        var foulOn: Contestant? = nil
        var foulChance = 0.0
        if contact && bodyDist > 1e-4 {
            let nx = bx / bodyDist, nz = bz / bodyDist
            let closeA = a.vel.x * nx + a.vel.z * nz
            let closeB = -(b.vel.x * nx + b.vel.z * nz)
            let impact = Swift.max(closeA, closeB)
            if impact > 0.6 {
                foulOn = closeA >= closeB ? .a : .b
                foulChance = clamp01((impact - 0.6) / 4.0)
            }
        }
        return ContestModel(
            winner: margin < 0.03 ? .none : (scoreA > scoreB ? .a : .b), margin: margin, contact: contact,
            foulOn: foulOn, foulChance: foulChance, aEffective: effA, bEffective: effB, aBoxOut: boxA,
            bBoxOut: boxB, aScore: scoreA, bScore: scoreB)
    }

    private static func compareContest(
        _ a: LocoPlayer, _ b: LocoPlayer, discPos: Vec3d, t: Double, jitter: Double, _ at: String
    ) {
        let got = contestAir(a, b, discPos: discPos, tContest: t, jitter: jitter)
        let want = modelContestAir(a, b, discPos: discPos, tContest: t, jitter: jitter)
        Check.eq(got.winner, want.winner, "\(at).winner")
        Check.near(got.margin, want.margin, mathTol, "\(at).margin")
        Check.eq(got.contact, want.contact, "\(at).contact")
        Check.eq(got.foulOn, want.foulOn, "\(at).foulOn")
        Check.near(got.foulChance, want.foulChance, mathTol, "\(at).foulChance")
        Check.near(got.a.effective, want.aEffective, mathTol, "\(at).a.effective")
        Check.near(got.b.effective, want.bEffective, mathTol, "\(at).b.effective")
        Check.near(got.a.boxOut, want.aBoxOut, mathTol, "\(at).a.boxOut")
        Check.near(got.b.boxOut, want.bBoxOut, mathTol, "\(at).b.boxOut")
        Check.near(got.a.score, want.aScore, mathTol, "\(at).a.score")
        Check.near(got.b.score, want.bScore, mathTol, "\(at).b.score")
    }

    private static func contestTests() {
        func athlete(_ id: Int, pos: Vec3d, vel: Vec3d, strength: Double, height: Double = 1.83, airborne: Bool = true) -> LocoPlayer {
            var attr = Attributes.defaultAttrs
            attr.strength = strength
            attr.height = height
            return LocoPlayer(
                id: id, attr: attr, pos: pos, vel: vel, state: airborne ? .jump : .idle,
                air: AirState(airborne: airborne), groundY: 0, hipHeight: 0.9)
        }

        let disc = Vec3d(3, 2, 4)
        let scenarios: [(String, LocoPlayer, LocoPlayer, Double)] = [
            (
                "even race, both closing", athlete(1, pos: Vec3d(2, 1, 3), vel: Vec3d(2, 3, 2), strength: 60),
                athlete(2, pos: Vec3d(4, 1, 5), vel: Vec3d(-2, 3, -2), strength: 60), 0.6
            ),
            (
                "A much closer", athlete(1, pos: Vec3d(2.9, 1, 3.9), vel: Vec3d(0.5, 2, 0.5), strength: 50),
                athlete(2, pos: Vec3d(-5, 1, -5), vel: Vec3d(1, 1, 1), strength: 50), 0.4
            ),
            (
                "strength mismatch, close jostle", athlete(1, pos: Vec3d(2.7, 1, 3.7), vel: Vec3d(1, 2, 1), strength: 95),
                athlete(2, pos: Vec3d(3.0, 1, 4.0), vel: Vec3d(-1, 2, -1), strength: 20), 1.2
            ),
            (
                "grounded, not airborne", athlete(1, pos: Vec3d(2, 1, 3), vel: Vec3d(0, 0, 0), strength: 70, airborne: false),
                athlete(2, pos: Vec3d(4, 1, 5), vel: Vec3d(0, 0, 0), strength: 70, airborne: false), 0.9
            ),
            (
                "coincident bodies", athlete(1, pos: Vec3d(3, 1, 4), vel: Vec3d(1, 2, 0), strength: 70),
                athlete(2, pos: Vec3d(3, 1, 4), vel: Vec3d(-1, 2, 0), strength: 40), 0.7
            ),
            (
                "disc coincides with A's predicted spot", athlete(1, pos: Vec3d(1, 1, 2), vel: Vec3d(2, 3, 2), strength: 60),
                athlete(2, pos: Vec3d(6, 1, 8), vel: Vec3d(-1, 1, -1), strength: 60), 0.5
            ),
            (
                "taller athlete, short one", athlete(1, pos: Vec3d(2.5, 1, 3.5), vel: Vec3d(1, 2, 1), strength: 60, height: 2.05),
                athlete(2, pos: Vec3d(3.5, 1, 4.5), vel: Vec3d(-1, 2, -1), strength: 60, height: 1.60), 0.6
            ),
        ]

        for (label, a, b, t) in scenarios {
            for jitter in [-1.0, -0.3, 0.0, 0.55, 1.0] {
                compareContest(a, b, discPos: disc, t: t, jitter: jitter, "contest: \(label), jitter \(jitter)")
            }
        }

        // A partial symmetry the model must respect but never states as code:
        // `effective` reach depends only on a contestant's OWN predicted
        // position, reach and the disc — never on the other body — so it is
        // symmetric under relabeling regardless of argument order or jitter.
        // (`boxOut`/`score` are NOT symmetric this way: `sealA` is measured
        // one-sidedly, from A's own position, and is not its own negation
        // under a swap — a genuine asymmetry in the design, not a bug.)
        let a = athlete(11, pos: Vec3d(2, 1, 3), vel: Vec3d(1.5, 2, 1), strength: 65)
        let b = athlete(22, pos: Vec3d(4, 1, 5), vel: Vec3d(-1.5, 2, -1), strength: 45)
        let ab = contestAir(a, b, discPos: disc, tContest: 0.5, jitter: 0.3)
        let ba = contestAir(b, a, discPos: disc, tContest: 0.5, jitter: -0.3)
        Check.near(ab.a.effective, ba.b.effective, mathTol, "swapping contestants swaps their effective reach (a<->b)")
        Check.near(ab.b.effective, ba.a.effective, mathTol, "swapping contestants swaps their effective reach (b<->a)")
        Check.near(ab.a.reach, ba.b.reach, mathTol, "…and their raw reach (a<->b)")
        Check.near(ab.a.gap, ba.b.gap, mathTol, "…and their gap to the disc (a<->b)")

        // `Locomotion.contest` wraps `contestAir` with a jitter drawn from the
        // model's own stream — and the draw happens before `contestAir` runs,
        // so it must come off the model's default (unattached) seed.
        let loco = Locomotion()
        loco.attach(LocoHost())
        let p1 = loco.create(CreateOpts(id: 1, pos: Vec3d(2, 0, 3)))
        let p2 = loco.create(CreateOpts(id: 2, pos: Vec3d(4, 0, 5)))
        let wrapped = loco.contest(p1, p2, discPos: disc, tContest: 0.4)
        let jitterModel = Rng(seed: 0x10c0_5eed)
        // Two `create()` calls each drew one fork; the jitter is the third draw
        // off the SAME parent stream (forks do not disturb it — see `RngTests`).
        _ = jitterModel.fork(salt: 1 * 977 + 11)
        _ = jitterModel.fork(salt: 2 * 977 + 11)
        let wantJitter = jitterModel.next() * 2 - 1
        let wantResult = modelContestAir(p1, p2, discPos: disc, tContest: 0.4, jitter: wantJitter)
        Check.near(wrapped.margin, wantResult.margin, mathTol, "Locomotion.contest draws its jitter from the model's own stream")
        Check.eq(wrapped.winner, wantResult.winner, "…and the winner it produces matches")
    }

    // MARK: - timeToReach

    private static func timeToReachTests() {
        let loco = Locomotion()
        loco.attach(LocoHost())
        let p = loco.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))

        Check.bitEq(loco.timeToReach(p, x: 0, z: 0), 0, "no travel time to where you already are")
        Check.bitEq(loco.timeToReach(p, x: 0.0005, z: 0), 0, "under the 1mm-ish dead zone is free")

        var lastT = 0.0
        for d in [1.0, 5.0, 10.0, 20.0, 40.0, 80.0] {
            let t = loco.timeToReach(p, x: d, z: 0)
            Check.ok(t > lastT, "time to reach \(d) m grows monotonically with distance")
            lastT = t
        }

        // Turning costs time: sprinting away from the target, then being asked
        // to reach it, must take longer than starting from a standstill.
        let far = loco.timeToReach(p, x: 25, z: 0)
        p.vel = Vec3d(-8, 0, 0)
        let turning = loco.timeToReach(p, x: 25, z: 0)
        Check.ok(turning > far, "sprinting the wrong way costs time to turn around")
        p.vel = .zero

        // A closed-form law: the Newton solve converges on a root of
        // `top*t - k*(1-e^(-t/tau)) - d = 0`, so the returned time (minus any
        // plantDur trim) must make that residual tiny — independent of the
        // exact iteration count or step used inside `timeToReach` itself.
        func residual(top: Double, tau: Double, k: Double, d: Double, t: Double) -> Double {
            top * t - k * (1 - Foundation.exp(-t / tau)) - d
        }
        let der = UltimateSim.derive(p.attr, stamina: p.stamina, speed: 0, mode: .sprint)
        let top = Swift.max(0.5, der.topSpeed)
        let A = Swift.max(0.5, der.accelMax)
        let tau = top / A
        for (dx, dz) in [(3.0, 0.0), (12.0, 5.0), (0.5, 0.5), (40.0, -30.0)] {
            let d = (dx * dx + dz * dz).squareRoot()
            let t = loco.timeToReach(p, x: dx, z: dz)
            // No turning component (p.vel is zero here), so v0 = 0 and k = tau*top.
            let k = tau * top
            let r = residual(top: top, tau: tau, k: k, d: d, t: t)
            Check.near(r, 0, 1e-6, "timeToReach(\(dx),\(dz)) converged: residual \(r)")
        }

        // The `AthleteLike` overload: an id we do not own falls back to
        // translated AI ratings, fresh (stamina 100).
        let stranger = AthleteLike(id: 999, posX: 0, posZ: 0, velX: 0, velZ: 0, attr: ["speed": 90])
        let strangerCap = UltimateSim.derive(
            fromAIAttributes(["speed": 90]), stamina: 100, speed: 0, mode: .sprint)
        let strangerT = loco.timeToReach(stranger, x: 10, z: 0)
        Check.ok(strangerT > 0, "a foreign athlete gets a real, positive time")
        Check.ok(strangerCap.topSpeed > 0, "and a real top speed to compute it from")

        // An id we DO own uses our own player's stamina and position, not the
        // caller-supplied ones, when the caller leaves them nil.
        p.pos = Vec3d(5, 0, 5)
        let mine = AthleteLike(id: 1, posX: nil, posZ: nil, velX: nil, velZ: nil, attr: nil)
        let viaAthlete = loco.timeToReach(mine, x: 15, z: 5)
        let viaPlayer = loco.timeToReach(p, x: 15, z: 5)
        Check.bitEq(viaAthlete, viaPlayer, "an owned id falls back to our own player's position/velocity")
    }

    // MARK: - intentToDesired

    private static func intentToDesiredTests() {
        let loco = Locomotion()
        loco.attach(LocoHost())
        let p = loco.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))

        // Arrive taper: outside the radius the speed stands, inside it tapers
        // linearly, and inside 4cm it is forced to zero.
        let ar = 0.6
        for d in [5.0, 1.0, ar + 0.1] {
            let out = loco.intentToDesired(p, IntentLike(id: 1, targetX: d, targetZ: 0, desiredSpeed: 6))
            Check.bitEq(out.speed ?? -1, 6, "outside the arrive radius (d=\(d)) the speed stands")
        }
        for d in [0.5, 0.3, 0.1, 0.05] {
            let out = loco.intentToDesired(p, IntentLike(id: 1, targetX: d, targetZ: 0, desiredSpeed: 6))
            let want = 6 * clamp01(d / ar)
            Check.near(out.speed ?? -1, want, mathTol, "inside the arrive radius (d=\(d)) the speed tapers")
        }
        let onTop = loco.intentToDesired(p, IntentLike(id: 1, targetX: 0.01, targetZ: 0, desiredSpeed: 6))
        Check.bitEq(onTop.speed ?? -1, 0, "on top of the target (d<0.04) the speed is forced to zero")

        // A custom arrive radius.
        let customAr = loco.intentToDesired(
            p, IntentLike(id: 1, targetX: 2, targetZ: 0, desiredSpeed: 6, arriveRadius: 3))
        Check.near(customAr.speed ?? -1, 6 * clamp01(2.0 / 3.0), mathTol, "a custom arriveRadius is honoured")

        // `idle` forces speed to zero regardless of distance.
        let idled = loco.intentToDesired(p, IntentLike(id: 1, targetX: 10, targetZ: 0, mode: "idle"))
        Check.bitEq(idled.speed ?? -1, 0, "mode idle forces speed to zero")

        // Gait mapping: only sprint/jog/backpedal/shuffle are named explicitly;
        // everything else (including every pose) falls back to run.
        let gaitMap: [(String, MoveMode)] = [
            ("sprint", .sprint), ("jog", .jog), ("backpedal", .backpedal), ("shuffle", .shuffle),
            ("throw", .run), ("mark", .run), ("catch", .run), ("plant", .run), ("pivot", .run),
            ("idle", .run), ("something-unrecognised", .run),
        ]
        for (mode, want) in gaitMap {
            let out = loco.intentToDesired(p, IntentLike(id: 1, targetX: 10, targetZ: 0, mode: mode))
            Check.eq(out.mode, want, "AI mode '\(mode)' resolves to gait \(want)")
        }
        // With no mode at all, the same fallback applies.
        Check.eq(
            loco.intentToDesired(p, IntentLike(id: 1, targetX: 10, targetZ: 0)).mode, .run,
            "no mode at all resolves to run")

        // Direction: unit vector toward the target, or nil once close enough
        // that `d <= 1e-4`.
        let toward = loco.intentToDesired(p, IntentLike(id: 1, targetX: 3, targetZ: 4, desiredSpeed: 1))
        Check.near(toward.dir?.x ?? -99, 0.6, mathTol, "dir.x is the unit vector toward the target")
        Check.near(toward.dir?.z ?? -99, 0.8, mathTol, "dir.z is the unit vector toward the target")
        let already = loco.intentToDesired(p, IntentLike(id: 1, targetX: 0, targetZ: 0))
        Check.ok(already.dir == nil, "no target displacement means no direction")

        // face is passed through only when BOTH components are present.
        let facedBoth = loco.intentToDesired(
            p, IntentLike(id: 1, targetX: 5, targetZ: 0, faceX: 1, faceZ: 0))
        Check.ok(facedBoth.face != nil, "face passes through when both components are present")
        let facedOne = loco.intentToDesired(p, IntentLike(id: 1, targetX: 5, targetZ: 0, faceX: 1))
        Check.ok(facedOne.face == nil, "face is nil when only one component is present")

        // jump/layout actions.
        let jumpMode = loco.intentToDesired(p, IntentLike(id: 1, targetX: 5, targetZ: 0, mode: "jump"))
        Check.ok(jumpMode.jump, "mode jump requests a jump")
        let jumpAction = loco.intentToDesired(
            p, IntentLike(id: 1, targetX: 5, targetZ: 0, action: IntentAction(kind: "jump")))
        Check.ok(jumpAction.jump, "action kind jump requests a jump")
        let layoutMode = loco.intentToDesired(p, IntentLike(id: 1, targetX: 5, targetZ: 0, mode: "layout"))
        Check.ok(layoutMode.layout, "mode layout requests a layout")

        let bid = loco.intentToDesired(
            p, IntentLike(id: 1, targetX: 5, targetZ: 0, action: IntentAction(kind: "bid", x: 0, z: 3)))
        Check.ok(bid.layout, "a bid action requests a layout")
        Check.near(bid.dir?.x ?? -99, 0, mathTol, "a bid steers toward the bid point, not the path target (x)")
        Check.near(bid.dir?.z ?? -99, 1, mathTol, "a bid steers toward the bid point, not the path target (z)")

        // A bid with no reachable point (both nil, or on top of the body) keeps
        // the path direction instead — it does not null out the direction.
        let bidNoPoint = loco.intentToDesired(
            p, IntentLike(id: 1, targetX: 5, targetZ: 0, action: IntentAction(kind: "bid")))
        Check.ok(bidNoPoint.layout, "a bid with no x/z still requests a layout")
        Check.near(
            bidNoPoint.dir?.x ?? -99, 1, mathTol, "…but with nothing to steer toward, the path direction stands")

        // maxSpeed passes through untouched, independent of desiredSpeed/effort.
        let capped = loco.intentToDesired(
            p, IntentLike(id: 1, targetX: 5, targetZ: 0, desiredSpeed: 9, maxSpeed: 2))
        Check.bitEq(capped.maxSpeed ?? -1, 2, "maxSpeed passes straight through")

        // desiredSpeed missing falls back to maxSpeed.
        let fallback = loco.intentToDesired(p, IntentLike(id: 1, targetX: 5, targetZ: 0, maxSpeed: 4))
        Check.bitEq(fallback.speed ?? -1, 4, "with no desiredSpeed, maxSpeed stands in for it")
    }

    // MARK: - fromAIAttributes

    private static func fromAIAttributesTests() {
        let d = Attributes.defaultAttrs

        let full = fromAIAttributes([
            "speed": 88, "accel": 77, "agility": 66, "strength": 55, "vertical": 44,
            "endurance": 33, "balance": 22,
        ])
        Check.bitEq(full.speed, 88, "speed passes through")
        Check.bitEq(full.accel, 77, "accel passes through")
        Check.bitEq(full.agility, 66, "agility passes through")
        Check.bitEq(full.strength, 55, "strength passes through")
        Check.bitEq(full.vertical, 44, "vertical passes through")
        Check.bitEq(full.endurance, 33, "endurance passes through")
        Check.bitEq(full.balance, 22, "balance is honoured explicitly when present")

        // The fallback chains, each exercised in isolation.
        let accelFallback = fromAIAttributes(["acceleration": 91])
        Check.bitEq(accelFallback.accel, 91, "accel falls back to the AI's 'acceleration'")
        let verticalFallback = fromAIAttributes(["jumping": 88])
        Check.bitEq(verticalFallback.vertical, 88, "vertical falls back to the AI's 'jumping'")
        let enduranceFallback = fromAIAttributes(["stamina": 44])
        Check.bitEq(enduranceFallback.endurance, 44, "endurance falls back to the AI's 'stamina'")
        let balanceFallback = fromAIAttributes(["agility": 12])
        Check.bitEq(
            balanceFallback.balance, 12, "balance falls back to agility, not to the default balance")
        Check.ok(
            balanceFallback.balance != d.balance || d.balance == 12,
            "the balance fallback is agility, not DEFAULT_ATTRS.balance")

        // accel/vertical/endurance's own primary name wins over the fallback
        // when both are present.
        let bothNamed = fromAIAttributes(["accel": 10, "acceleration": 90])
        Check.bitEq(bothNamed.accel, 10, "'accel' wins over 'acceleration' when both are present")

        let empty = fromAIAttributes([:])
        Check.bitEq(empty.speed, d.speed, "empty ratings default speed")
        Check.bitEq(empty.accel, d.accel, "empty ratings default accel")
        Check.bitEq(empty.agility, d.agility, "empty ratings default agility")
        Check.bitEq(empty.strength, d.strength, "empty ratings default strength")
        Check.bitEq(empty.vertical, d.vertical, "empty ratings default vertical")
        Check.bitEq(empty.endurance, d.endurance, "empty ratings default endurance")
        Check.bitEq(empty.balance, d.balance, "empty ratings default balance (agility also defaults)")
        Check.bitEq(empty.height, 1.83, "empty ratings default height")
        Check.bitEq(empty.mass, 82, "empty ratings default mass")

        // height/mass overrides.
        let sized = fromAIAttributes([:], height: 2.1, mass: 105)
        Check.bitEq(sized.height, 2.1, "height override is honoured")
        Check.bitEq(sized.mass, 105, "mass override is honoured")
    }

    // MARK: - apply / syncTo / stepIntent

    private static func syncApplyTests() {
        let loco = Locomotion()
        loco.attach(LocoHost())
        let p1 = loco.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
        let p2 = loco.create(CreateOpts(id: 2, pos: Vec3d(5, 0, 0)))

        var world = [
            WorldPlayerRecord(id: 1, pos: Vec3d(), vel: Vec3d(), airborne: false),
            WorldPlayerRecord(id: 2, pos: nil, vel: nil, airborne: false),
            WorldPlayerRecord(id: 99, pos: Vec3d(), vel: Vec3d(), airborne: false),
        ]

        loco.apply(
            [
                IntentLike(id: 1, targetX: 10, targetZ: 0, desiredSpeed: 5),
                IntentLike(id: 2, targetX: -10, targetZ: 0, desiredSpeed: 5),
                IntentLike(id: 42, targetX: 0, targetZ: 0),  // unknown id: ignored, not a crash
            ], dt: 1.0 / 120.0, world: &world)

        Check.bitEq(world[0].pos?.x ?? -999, p1.pos.x, "syncTo writes pos when the record had one")
        Check.bitEq(world[0].vel?.x ?? -999, p1.vel.x, "syncTo writes vel when the record had one")
        Check.eq(world[0].airborne, p1.air.airborne, "syncTo always writes airborne")
        Check.ok(world[1].pos == nil, "syncTo leaves pos nil when the record started nil")
        Check.ok(world[1].vel == nil, "syncTo leaves vel nil when the record started nil")
        Check.eq(world[1].airborne, p2.air.airborne, "…but still writes airborne for that record")
        Check.eq(world[2].airborne, false, "an id nobody owns is left alone entirely")
        Check.ok(p1.pos.x > 0, "p1 actually moved toward its intent's target")
        Check.ok(p2.pos.x < 5, "p2 actually moved toward its intent's target")

        // `stepIntent` is `step(p, intentToDesired(p, intent), dt)` — same
        // result as calling the two in sequence by hand.
        let solo = Locomotion()
        solo.attach(LocoHost())
        let a = solo.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
        let b = solo.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
        let intent = IntentLike(id: 1, targetX: 4, targetZ: 3, desiredSpeed: 5)
        _ = solo.stepIntent(a, intent, 1.0 / 120.0)
        let desired = solo.intentToDesired(b, intent)
        _ = solo.step(b, desired, 1.0 / 120.0)
        Check.bitEq(a.pos.x, b.pos.x, "stepIntent matches intentToDesired + step by hand (x)")
        Check.bitEq(a.pos.z, b.pos.z, "stepIntent matches intentToDesired + step by hand (z)")
    }

    // MARK: - state machine

    private static func freshLoco() -> Locomotion {
        let l = Locomotion()
        l.attach(LocoHost())
        return l
    }

    /// A player constructed directly in a given state, since `groundPhase` and
    /// its siblings are unreachable except through `step()`. Every field the
    /// switch reads is set explicitly rather than defaulted, so a scenario
    /// cannot silently pass because of a lucky default.
    private static func stateTestPlayer(
        state: LocoStateName, stateT: Double, stateDur: Double, prone: Bool = false,
        airborne: Bool = false, vel: Vec3d = .zero, hipHeight: Double = 0.9
    ) -> LocoPlayer {
        LocoPlayer(
            id: 1, attr: .defaultAttrs, pos: Vec3d(0, hipHeight, 0), vel: vel, state: state,
            prone: prone, air: AirState(airborne: airborne), groundY: 0, hipHeight: hipHeight,
            stateT: stateT, stateDur: stateDur)
    }

    private static func stateMachine() {
        let dt = 1.0 / 120.0

        // ---- jump / layout: the gather, and its takeoff boundary ----
        for state: LocoStateName in [.jump, .layout] {
            for (label, stateT, stateDur, shouldTakeOff) in [
                ("well before the gather ends", 0.0, 0.12, false),
                ("one step short of the boundary", 0.12 - 2 * dt, 0.12, false),
                ("exactly at the boundary", 0.12 - dt, 0.12, true),
                ("past the boundary already", 0.12 + dt, 0.12, true),
            ] {
                let p = stateTestPlayer(state: state, stateT: stateT, stateDur: stateDur)
                p.vel = Vec3d(4, 0, 3)
                let vxBefore = p.vel.x
                let vzBefore = p.vel.z
                let loco = freshLoco()
                _ = loco.step(p, DesiredMove(), dt)
                let at = "\(state.rawValue) gather, \(label)"
                if shouldTakeOff {
                    Check.ok(p.air.airborne, "\(at): takes off")
                    Check.eq(p.state, state, "\(at): state name is unchanged by takeoff")
                    Check.ok(p.air.tTakeoff > 0, "\(at): tTakeoff is recorded")
                    Check.bitEq(p.air.vy0, p.vel.y, "\(at): vy0 caches the takeoff velocity")
                } else {
                    Check.ok(!p.air.airborne, "\(at): still gathering, not airborne")
                    Check.eq(p.state, state, "\(at): still \(state.rawValue)")
                    // The gather decay: exp(-2.2*dt) applied to the vel it had
                    // BEFORE the step (dt too small here for takeoff, so the
                    // gather branch, not takeoff, produced this vel).
                    let decay = Foundation.exp(-2.2 * dt)
                    Check.near(p.vel.x, vxBefore * decay, mathTol, "\(at): vel.x decays under the gather")
                    Check.near(p.vel.z, vzBefore * decay, mathTol, "\(at): vel.z decays under the gather")
                }
            }
        }

        // ---- landing, upright: control returns before stateDur, and idle at it
        for (label, stateT, stateDur, wantIdle) in [
            ("not yet due", 0.10, 0.20, false),
            ("exactly at the boundary", 0.20 - dt, 0.20, true),
            ("past the boundary already", 0.20 + dt, 0.20, true),
        ] {
            let p = stateTestPlayer(state: .landing, stateT: stateT, stateDur: stateDur, prone: false)
            let loco = freshLoco()
            _ = loco.step(p, DesiredMove(), dt)
            let at = "landing (upright), \(label)"
            Check.eq(p.state, wantIdle ? .idle : .landing, "\(at)")
        }

        // ---- landing, prone: waits on BOTH the slide slowing and a 0.12s floor
        do {
            let p = stateTestPlayer(state: .landing, stateT: 0.05, stateDur: 0.30, prone: true)
            p.vel = Vec3d(0.20, 0, 0)  // already under 0.30 m/s
            let loco = freshLoco()
            _ = loco.step(p, DesiredMove(), dt)
            Check.eq(
                p.state, .landing,
                "a slow slide still waits for the 0.12s floor even though speed already qualifies")
        }
        do {
            let p = stateTestPlayer(state: .landing, stateT: 0.13, stateDur: 0.30, prone: true)
            p.vel = Vec3d(0.20, 0, 0)
            let loco = freshLoco()
            _ = loco.step(p, DesiredMove(), dt)
            Check.eq(p.state, .recovery, "past the 0.12s floor and under 0.30 m/s: recovers")
            let want = clamp(1.45 - 0.35 * clamp01(p.attr.agility / 100) - 0.30 * clamp01(p.attr.balance / 100), 0.75, 1.45)
            Check.bitEq(p.stateDur, want, "…with getUpTime's own formula for the duration")
        }
        do {
            // Slide decelerates a fast body: it must NOT recover before the
            // slide has actually brought it under 0.30 m/s, however long
            // stateDur has elapsed.
            let p = stateTestPlayer(state: .landing, stateT: 1.0, stateDur: 0.30, prone: true)
            p.vel = Vec3d(5.0, 0, 0)
            let loco = freshLoco()
            _ = loco.step(p, DesiredMove(), dt)
            Check.eq(p.state, .landing, "a fast slide has not qualified for recovery yet, however old stateT is")
            let want = Swift.max(0, 5.0 - Locomotion.SLIDE_DECEL * dt)
            Check.near((p.vel.x * p.vel.x + p.vel.z * p.vel.z).squareRoot(), want, mathTol, "…and slide() shed exactly SLIDE_DECEL * dt")
        }

        // ---- fall: requires BOTH stateT >= stateDur AND the slide below 0.30
        do {
            let p = stateTestPlayer(state: .fall, stateT: 1.0, stateDur: 0.30, prone: true)
            p.vel = Vec3d(5.0, 0, 0)  // way over 0.30 m/s
            let loco = freshLoco()
            _ = loco.step(p, DesiredMove(), dt)
            Check.eq(p.state, .fall, "stateDur elapsed, but still sliding fast: stays down")
        }
        do {
            let p = stateTestPlayer(state: .fall, stateT: 0.30 - dt, stateDur: 0.30, prone: true)
            p.vel = Vec3d(0.05, 0, 0)  // already slow
            let loco = freshLoco()
            _ = loco.step(p, DesiredMove(), dt)
            Check.eq(p.state, .recovery, "stateDur elapsed exactly this step, already slow: recovers")
        }
        do {
            let p = stateTestPlayer(state: .fall, stateT: 0.10, stateDur: 0.30, prone: true)
            p.vel = Vec3d(0.05, 0, 0)  // slow, but stateDur has not elapsed
            let loco = freshLoco()
            _ = loco.step(p, DesiredMove(), dt)
            Check.eq(p.state, .fall, "already slow, but stateDur has not elapsed: stays down")
        }
        do {
            // The threshold check runs AFTER `slide()` has already decelerated this
            // tick's velocity by SLIDE_DECEL * dt (15.7 * 1/120 ≈ 0.131 m/s) — so the
            // speed that matters is the post-slide one, not whatever is set here. 0.35
            // pre-slide lands at ≈0.219 post-slide: strictly between the recovery
            // threshold's two candidate values (0.30 in source, 0.15 as a deliberate
            // mutant). The two existing slow cases above use 0.05 m/s, which stays under
            // both even before sliding, so neither can tell the two thresholds apart.
            let p = stateTestPlayer(state: .fall, stateT: 1.0, stateDur: 0.30, prone: true)
            p.vel = Vec3d(0.35, 0, 0)
            let loco = freshLoco()
            _ = loco.step(p, DesiredMove(), dt)
            Check.eq(p.state, .recovery, "stateDur elapsed, under 0.30 but not under 0.15: recovers")
        }

        // ---- recovery: decays velocity, clears prone at stateDur
        for (label, stateT, stateDur, wantDone) in [
            ("not yet due", 0.5, 1.0, false),
            ("exactly at the boundary", 1.0 - dt, 1.0, true),
        ] {
            let p = stateTestPlayer(state: .recovery, stateT: stateT, stateDur: stateDur, prone: true)
            p.vel = Vec3d(1.0, 0, 0.5)
            let vxBefore = p.vel.x, vzBefore = p.vel.z
            let loco = freshLoco()
            _ = loco.step(p, DesiredMove(), dt)
            let at = "recovery, \(label)"
            if wantDone {
                // `enter(p, .idle, 0)` fires, but the SAME step then returns
                // control=1 and runs `solveGround`, whose own end-of-step
                // `classify()` can immediately reclassify a body that still
                // has real residual velocity into .jog/.run/.sprint rather
                // than leaving it at .idle — so the only state this can
                // promise is "no longer .recovery", not the specific bin.
                Check.ok(p.state != .recovery, "\(at): recovery released, not still recovering")
                Check.ok(!p.prone, "\(at): no longer prone")
            } else {
                Check.eq(p.state, .recovery, "\(at): still recovering")
                Check.ok(p.prone, "\(at): still prone")
                let decay = Foundation.exp(-12 * dt)
                Check.near(p.vel.x, vxBefore * decay, mathTol, "\(at): vel.x decays under recovery")
                Check.near(p.vel.z, vzBefore * decay, mathTol, "\(at): vel.z decays under recovery")
            }
        }

        // ---- stumble: a fixed timeout back to idle, nothing else
        for (label, stateT, stateDur, wantDone) in [
            ("not yet due", 0.1, 0.4, false),
            ("exactly at the boundary", 0.4 - dt, 0.4, true),
        ] {
            let p = stateTestPlayer(state: .stumble, stateT: stateT, stateDur: stateDur)
            let loco = freshLoco()
            _ = loco.step(p, DesiredMove(), dt)
            Check.eq(p.state, wantDone ? .idle : .stumble, "stumble, \(label)")
        }

        // ---- idle/jog/run/sprint: classify() bins a fresh mover by speed
        // fraction of topSpeed, once the state is not committed/cut/stumble.
        let capLoco = freshLoco()
        let capPlayer = capLoco.create(CreateOpts(id: 1))
        let topSpeed = UltimateSim.derive(capPlayer.attr, stamina: 100, speed: 0, mode: .sprint).topSpeed
        // 0.40 sits strictly between the jog/run boundary's two candidate values
        // (0.45 in source, 0.30 as a deliberate mutant) — 0.20 alone cannot tell them
        // apart, since it sits under both.
        let bins: [(Double, LocoStateName)] = [
            (0.0, .idle), (0.20, .jog), (0.40, .jog), (0.60, .run), (0.85, .sprint),
        ]
        for (frac, want) in bins {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1))
            // Prime the body up toward the target fraction of top speed over a
            // sprint request; `classify` runs every step, so the state read
            // right off the loop that got it there is the classification —
            // stamina stays comfortably above STAM_FADE (60) over this many
            // steps, so topSpeed itself does not drift from fatigue mid-test.
            for _ in 0..<500 {
                _ = loco.step(p, DesiredMove(dir: Vec2d(0, 1), mode: .sprint), dt)
                let s = (p.vel.x * p.vel.x + p.vel.z * p.vel.z).squareRoot()
                if s >= frac * topSpeed { break }
            }
            Check.eq(p.state, want, "a body near \(frac) of top speed classifies as \(want.rawValue)")
        }

        // backpedal/shuffle classify directly off the mode, independent of speed.
        for mode: MoveMode in [.backpedal, .shuffle] {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1))
            _ = loco.step(p, DesiredMove(dir: Vec2d(0, -1), mode: mode), dt)
            let want: LocoStateName = mode == .backpedal ? .backpedal : .shuffle
            Check.eq(p.state, want, "mode \(mode) classifies as \(want.rawValue) however slow")
        }

        // ---- committed states are never reclassified out from under a cut/
        // stumble by ordinary movement: only their own transition in
        // `groundPhase` moves them on.
        do {
            let p = stateTestPlayer(state: .stumble, stateT: 0, stateDur: 10)
            let loco = freshLoco()
            _ = loco.step(p, DesiredMove(dir: Vec2d(0, 1), mode: .sprint), dt)
            Check.eq(p.state, .stumble, "a stumbling body is not reclassified by a movement request")
        }
    }

    // MARK: - a shared stamina model, reused by cut/jump/layout/stamina tests

    /// `stepStamina`'s own formula, typed from its source: an optional one-shot
    /// cost subtracted first (cut/jump/layout), then the continuous
    /// `staminaRate` (already proven correct in `MoveTests`) applied over `dt`,
    /// using speed 0 and a 0.4 multiplier while airborne or prone, clamped to
    /// `[0, 100]`.
    private static func modelStaminaStep(
        prevStamina: Double, oneShotCost: Double, attr: Attributes, finalSpeed: Double,
        airborneOrProne: Bool, dt: Double
    ) -> Double {
        let afterCost = Swift.max(0, prevStamina - oneShotCost)
        let fresh = 6.6 + 3.0 * clamp01(attr.speed / 100)
        let rate =
            airborneOrProne
            ? staminaRate(attr, speed: 0, topSpeedFresh: fresh) * 0.4
            : staminaRate(attr, speed: finalSpeed, topSpeedFresh: fresh)
        return clamp(afterCost + rate * dt, 0, 100)
    }

    // MARK: - cut mechanics

    private static func cutMechanics() {
        let dt = 1.0 / 120.0

        // A clean trigger: sprinting +z, asked to cut hard to +x. 90 degrees is
        // well past CUT_ANGLE (45), and CUT_MIN_SPEED (2.2) is well under 8.
        do {
            var events: [LocoEvent] = []
            let loco = Locomotion()
            loco.attach(LocoHost(events: { events.append($0) }))
            let p = loco.create(CreateOpts(id: 1))
            p.vel = Vec3d(0, 0, 8)
            _ = loco.step(p, DesiredMove(dir: Vec2d(1, 0), mode: .sprint), dt)

            Check.eq(p.state, .cut, "a 90-degree request at speed triggers a cut")
            Check.near(p.cutDir.x, 1, trigTol, "cutDir.x is the normalized requested direction")
            Check.bitEqViaJSON(p.cutDir.y, 0, "cutDir.y is structurally zero")
            Check.near(p.cutDir.z, 0, trigTol, "cutDir.z is the normalized requested direction")
            Check.near(p.cutEntrySpeed, 8, mathTol, "cutEntrySpeed is the speed at the moment of the plant")
            Check.near(p.cutAngle, Double.pi / 2, mathTol, "a dead-perpendicular request cuts at 90 degrees")
            let der = UltimateSim.derive(p.attr, stamina: 100, speed: 8, mode: .sprint)
            Check.near(p.stateDur, der.plantDur, mathTol, "the plant lasts plantDur")
            let finalSpeed = (p.vel.x * p.vel.x + p.vel.z * p.vel.z).squareRoot()
            let wantStamina = modelStaminaStep(
                prevStamina: 100, oneShotCost: COST_CUT, attr: p.attr, finalSpeed: finalSpeed,
                airborneOrProne: false, dt: dt)
            Check.near(p.stamina, wantStamina, mathTol, "a cut costs COST_CUT plus the ordinary drain")
            Check.ok(
                events.contains { if case .footstep(_, _, _, _, let hard) = $0 { return hard } else { return false } },
                "starting a cut emits a hard-planted footstep")
        }

        // Refusals: each condition tested in isolation, everything else held at
        // values that WOULD trigger a cut.
        func attempt(vel: Vec3d, dir: Vec2d, brake: Bool = false, mode: MoveMode = .sprint) -> LocoPlayer {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1))
            p.vel = vel
            _ = loco.step(p, DesiredMove(dir: dir, mode: mode, brake: brake), dt)
            return p
        }
        Check.ok(
            attempt(vel: Vec3d(0, 0, 8), dir: Vec2d(0.15, 1)).state != .cut,
            "a shallow request (well under CUT_ANGLE) does not trigger a cut")
        Check.ok(
            attempt(vel: Vec3d(0, 0, 2.0), dir: Vec2d(1, 0)).state != .cut,
            "under CUT_MIN_SPEED, a sharp request does not trigger a cut")
        Check.ok(
            attempt(vel: Vec3d(0, 0, 8), dir: Vec2d(1, 0), brake: true).state != .cut,
            "braking never triggers a cut, however sharp the request")

        // The refractory gap: end a cut, then immediately request another one.
        do {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1))
            p.vel = Vec3d(0, 0, 8)
            _ = loco.step(p, DesiredMove(dir: Vec2d(1, 0), mode: .sprint), dt)
            Check.eq(p.state, .cut, "the first cut starts")

            let plantDur = p.stateDur
            var t = 0.0
            while t < plantDur {
                _ = loco.step(p, DesiredMove(dir: Vec2d(1, 0), mode: .sprint), dt)
                t += dt
            }
            // `endCut` releases into `.run`, but the SAME step then runs one
            // more tick of `solveGround`, whose own `classify()` can
            // immediately reclassify a body still carrying real speed into
            // `.sprint` — so the only state this can promise is "not .cut".
            Check.ok(p.state != .cut, "the plant released")

            // Immediately: another hard cut request, well inside CUT_REFRACTORY.
            p.vel = Vec3d(4, 0, 0)
            _ = loco.step(p, DesiredMove(dir: Vec2d(0, 1), mode: .sprint), dt)
            Check.ok(p.state != .cut, "a second cut inside CUT_REFRACTORY is refused")

            // Run the refractory gap out, then the same request must succeed.
            var waited = 0.0
            while waited < Locomotion.CUT_REFRACTORY + 2 * dt {
                _ = loco.step(p, DesiredMove(dir: Vec2d(1, 0), mode: .sprint), dt)
                waited += dt
            }
            p.vel = Vec3d(4, 0, 0)
            _ = loco.step(p, DesiredMove(dir: Vec2d(0, 1), mode: .sprint), dt)
            Check.eq(p.state, .cut, "once CUT_REFRACTORY has elapsed, the same request succeeds")
        }

        // The speed loss at the end of a cut, over a spread of angles: the
        // model's own formula, `CUT_LOSS_BASE * (1 - 0.45*agi) * (1-cos(angle)) * 0.5`.
        for (velDir, reqDir, label) in [
            (Vec3d(0, 0, 8), Vec2d(1, 0), "90 degrees"),
            (Vec3d(0, 0, 8), Vec2d(1, 1), "45-ish"),
            (Vec3d(0, 0, 8), Vec2d(0, -1), "180 degrees"),
        ] {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1))
            p.vel = velDir
            _ = loco.step(p, DesiredMove(dir: reqDir, mode: .sprint), dt)
            guard p.state == .cut else {
                Check.ok(false, "\(label): expected a cut to start")
                continue
            }
            let entrySpeed = p.cutEntrySpeed
            let cutAngle = p.cutAngle
            let plantDur = p.stateDur
            var speedJustBeforeRelease = entrySpeed
            var t = 0.0
            while t < plantDur + 4 * dt {
                if p.state != .cut {
                    // Already released last iteration.
                    break
                }
                speedJustBeforeRelease = (p.vel.x * p.vel.x + p.vel.z * p.vel.z).squareRoot()
                _ = loco.step(p, DesiredMove(dir: reqDir, mode: .sprint), dt)
                t += dt
            }
            Check.ok(p.state != .cut, "\(label): the cut released")

            let agi = clamp01(p.attr.agility / 100)
            let loss = Locomotion.CUT_LOSS_BASE * (1 - 0.45 * agi) * (1 - Foundation.cos(cutAngle)) * 0.5
            let k = Swift.max(0, 1 - loss)
            Check.inRange(k, 0, 1, "\(label): the cut-loss multiplier k stays in [0,1]")
            let wantScrubbed = speedJustBeforeRelease * k
            let exitSpeed = (p.vel.x * p.vel.x + p.vel.z * p.vel.z).squareRoot()
            // The release step runs one more tick of the friction-ellipse solve
            // on top of the scrub, which can move speed by at most
            // accelMax*dt/brakeMax*dt — a couple tenths of a m/s at 1/120s —
            // so the scrub itself is checked to within that budget, not
            // bit-exactly.
            Check.near(
                exitSpeed, wantScrubbed, 0.3,
                "\(label): the plant's own scrub (\(String(format: "%.3f", k))x) dominates the release speed")
        }

        // The physical law the old fixture asserted directly: a 90-degree cut
        // costs real speed but not all of it.
        do {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1))
            p.vel = Vec3d(0, 0, 9)
            _ = loco.step(p, DesiredMove(dir: Vec2d(1, 0), mode: .sprint), dt)
            Check.eq(p.state, .cut, "the law's setup: a clean 90-degree cut")
            let entry = p.cutEntrySpeed
            let plantDur = p.stateDur
            var t = 0.0
            while p.state == .cut && t < plantDur + 4 * dt {
                _ = loco.step(p, DesiredMove(dir: Vec2d(1, 0), mode: .sprint), dt)
                t += dt
            }
            let exit = (p.vel.x * p.vel.x + p.vel.z * p.vel.z).squareRoot()
            Check.inRange(exit / entry, 0.45, 0.95, "a 90-degree cut costs real speed but not all of it")
        }
    }

    // MARK: - jump / layout mechanics

    private static func jumpLayoutMechanics() {
        let dt = 1.0 / 120.0

        // ---- jump takeoff: vy0 is takeoffVy(der, approachSpeed), horizontal
        // speed scaled by JUMP_HORIZ_KEEP, and the air-state cache follows.
        do {
            let p = stateTestPlayer(
                state: .jump, stateT: Locomotion.JUMP_GATHER - dt, stateDur: Locomotion.JUMP_GATHER)
            p.vel = Vec3d(3, 0, 4)
            p.t = 5.0
            // The gather's own decay (`exp(-2.2*dt)`) runs unconditionally
            // BEFORE the stateDur check, even on the tick that triggers
            // takeoff — so `takeoff()` sees the decayed velocity, not the raw
            // one this test set.
            let gatherDecay = Foundation.exp(-2.2 * dt)
            let decayedVel = Vec3d(3 * gatherDecay, 0, 4 * gatherDecay)
            let approachSpeed = (decayedVel.x * decayedVel.x + decayedVel.z * decayedVel.z).squareRoot()
            let der = UltimateSim.derive(p.attr, stamina: p.stamina, speed: approachSpeed, mode: .sprint)
            let wantVy = UltimateSim.takeoffVy(der, approachSpeed: approachSpeed)
            let loco = freshLoco()
            _ = loco.step(p, DesiredMove(), dt)
            Check.ok(p.air.airborne, "jump takeoff: airborne")
            Check.near(
                p.vel.x, decayedVel.x * Locomotion.JUMP_HORIZ_KEEP, mathTol,
                "jump: horizontal x scaled by JUMP_HORIZ_KEEP (of the gather-decayed velocity)")
            Check.near(
                p.vel.z, decayedVel.z * Locomotion.JUMP_HORIZ_KEEP, mathTol,
                "jump: horizontal z scaled by JUMP_HORIZ_KEEP (of the gather-decayed velocity)")
            Check.near(p.vel.y, wantVy, mathTol, "jump: vy0 is takeoffVy(der, approachSpeed)")
            Check.bitEq(p.air.vy0, p.vel.y, "jump: air.vy0 caches vel.y")
            Check.near(p.air.tTakeoff, p.t, mathTol, "jump: tTakeoff is the current clock")
            Check.near(p.air.tApex, p.t + p.vel.y / moveG, mathTol, "jump: tApex")
            Check.near(p.air.apexY, p.pos.y + p.vel.y * p.vel.y / (2 * moveG), mathTol, "jump: apexY")
            let landY = p.groundY + p.hipHeight
            let disc = p.vel.y * p.vel.y + 2 * moveG * (p.pos.y - landY)
            let wantTLand = p.t + (p.vel.y + Swift.max(0, disc).squareRoot()) / moveG
            Check.near(p.air.tLand, wantTLand, mathTol, "jump: tLand")
            Check.ok(!p.prone, "a jump does not lay the body down")
        }

        // ---- layout takeoff, with a real cutDir set: the push ADDS along
        // cutDir (not a scale, unlike a jump's horizontal keep), and vy0 is a
        // flat formula independent of `derive`/`takeoffVy`.
        do {
            let p = stateTestPlayer(
                state: .layout, stateT: Locomotion.LAYOUT_GATHER - dt, stateDur: Locomotion.LAYOUT_GATHER)
            p.cutDir = Vec3d(0.6, 0, 0.8)
            p.vel = Vec3d(1, 0, 1)
            p.t = 2.0
            // Same gather-decay caveat as the jump case above.
            let gatherDecay = Foundation.exp(-2.2 * dt)
            let vxBefore = 1 * gatherDecay, vzBefore = 1 * gatherDecay
            let acc = clamp01(p.attr.accel / 100)
            let ver = clamp01(p.attr.vertical / 100)
            let push = 0.4 + 0.8 * acc
            let loco = freshLoco()
            _ = loco.step(p, DesiredMove(), dt)
            Check.ok(p.air.airborne, "layout takeoff: airborne")
            Check.ok(p.prone, "layout takeoff: prone immediately, not only on landing")
            Check.near(p.vel.x, vxBefore + 0.6 * push, mathTol, "layout: push ADDS along cutDir.x (over the gather-decayed velocity)")
            Check.near(p.vel.z, vzBefore + 0.8 * push, mathTol, "layout: push ADDS along cutDir.z (over the gather-decayed velocity)")
            Check.near(
                p.vel.y, 0.9 + 0.6 * ver, mathTol,
                "layout: vy0 is the flat 0.9+0.6*vertical formula, not takeoffVy")
        }

        // ---- layout with no cutDir: falls back to facing.
        do {
            let facing = 0.7
            let p = stateTestPlayer(
                state: .layout, stateT: Locomotion.LAYOUT_GATHER - dt, stateDur: Locomotion.LAYOUT_GATHER)
            p.facing = facing
            p.cutDir = .zero
            p.vel = .zero
            let acc = clamp01(p.attr.accel / 100)
            let push = 0.4 + 0.8 * acc
            let loco = freshLoco()
            _ = loco.step(p, DesiredMove(), dt)
            Check.near(p.vel.x, Foundation.sin(facing) * push, trigTol, "layout with no cutDir pushes along facing (x)")
            Check.near(p.vel.z, Foundation.cos(facing) * push, trigTol, "layout with no cutDir pushes along facing (z)")
        }

        // ---- law: airborne velocity integrates gravity exactly, same
        // constant the rest of the sim uses.
        do {
            let p = stateTestPlayer(state: .jump, stateT: 0, stateDur: 0, airborne: true)
            p.vel = Vec3d(2, 5, 0)
            p.pos = Vec3d(0, 3.0, 0)
            let vyBefore = p.vel.y
            let loco = freshLoco()
            _ = loco.step(p, DesiredMove(), dt)
            Check.near(p.vel.y, vyBefore - moveG * dt, mathTol, "gravity integrates vel.y by -g*dt")
            Check.near(p.pos.x, 2 * dt, mathTol, "airborne x integrates at constant vel")
        }

        // ---- law: a body never sinks through the floor it lands on.
        do {
            let p = stateTestPlayer(state: .jump, stateT: 0, stateDur: 0, airborne: true)
            p.vel = Vec3d(1, 0, 0)
            p.pos = Vec3d(0, 4.0, 0)
            let loco = freshLoco()
            var minY = Double.infinity
            for _ in 0..<600 {
                _ = loco.step(p, DesiredMove(), dt)
                minY = Swift.min(minY, p.pos.y)
                if !p.air.airborne && p.state != .jump { break }
            }
            Check.ok(minY >= p.groundY + p.hipHeight - 1e-9, "the body never sinks through its landing floor")
            Check.ok(!p.air.airborne, "the body actually landed within the test window")
        }

        // ---- jump/layout stamina costs, isolated from the classify/movement
        // machinery above.
        do {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1))
            _ = loco.step(p, DesiredMove(jump: true), dt)
            let finalSpeed = (p.vel.x * p.vel.x + p.vel.z * p.vel.z).squareRoot()
            let want = modelStaminaStep(
                prevStamina: 100, oneShotCost: COST_JUMP, attr: p.attr, finalSpeed: finalSpeed,
                airborneOrProne: p.air.airborne, dt: dt)
            Check.near(p.stamina, want, mathTol, "a jump costs COST_JUMP plus the ordinary drain")
        }
        do {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1))
            _ = loco.step(p, DesiredMove(layout: true), dt)
            let finalSpeed = (p.vel.x * p.vel.x + p.vel.z * p.vel.z).squareRoot()
            let want = modelStaminaStep(
                prevStamina: 100, oneShotCost: COST_LAYOUT, attr: p.attr, finalSpeed: finalSpeed,
                airborneOrProne: p.air.airborne, dt: dt)
            Check.near(p.stamina, want, mathTol, "a layout costs COST_LAYOUT plus the ordinary drain")
        }
    }

    // MARK: - pivot mechanics

    private static func pivotMechanics() {
        let dt = 1.0 / 120.0

        // Unanchored: never has a pivot, however it moves.
        do {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1))
            for _ in 0..<20 { _ = loco.step(p, DesiredMove(dir: Vec2d(0, 1), mode: .sprint), dt) }
            Check.ok(loco.pivotOf(1) == nil, "an unanchored player never has an established pivot")
        }

        // At rest: below PIVOT_STOP_SPEED from the first tick, so it locks
        // immediately.
        do {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1))
            p.anchored = true
            _ = loco.step(p, DesiredMove(), dt)
            Check.ok(loco.pivotOf(1) != nil, "a body at rest locks its pivot on the very first tick")
        }

        // The invariant: whenever the pivot is locked, the body sits within
        // PIVOT_R of its own established foot — never beyond it, whatever the
        // drive requested. `stepPivot` guarantees this by construction (the
        // leg either wins and pulls the body back to the radius, or loses and
        // the foot is redefined at the radius), and this drives a body hard
        // enough, for long enough, to actually reach the constraint.
        do {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1))
            p.anchored = true
            p.vel = Vec3d(0, 0, 10)
            var everLocked = false
            for _ in 0..<400 {
                _ = loco.step(p, DesiredMove(dir: Vec2d(0, 1), mode: .sprint), dt)
                if let foot = loco.pivotOf(1) {
                    everLocked = true
                    let r = ((p.pos.x - foot.x) * (p.pos.x - foot.x) + (p.pos.z - foot.z) * (p.pos.z - foot.z)).squareRoot()
                    Check.ok(r <= Locomotion.PIVOT_R + 1e-6, "locked: body stays within PIVOT_R of its foot (r=\(r))")
                }
            }
            Check.ok(everLocked, "a sustained sprint eventually exhausts the grace window and locks")
        }

        // The grace window: a body that stops itself well within its budget
        // locks with its foot wherever it actually is, and the very fast
        // sprint above is NOT locked on the first tick — the grace window
        // gives him at least one tick of his own feet.
        do {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1))
            p.anchored = true
            p.vel = Vec3d(0, 0, 10)
            _ = loco.step(p, DesiredMove(dir: Vec2d(0, 1), mode: .sprint), dt)
            Check.ok(
                loco.pivotOf(1) == nil,
                "a body still well above PIVOT_STOP_SPEED is not locked on the very tick it is anchored")
        }

        // rePivot re-establishes the foot exactly where asked, and pivotOf
        // reflects it immediately.
        do {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1, pos: Vec3d(2, 0, 2)))
            loco.rePivot(1, 5, -3)
            let foot = loco.pivotOf(1)
            Check.ok(foot != nil, "rePivot establishes a locked pivot")
            Check.bitEq(foot?.x ?? .nan, 5, "rePivot's x is exact")
            Check.bitEq(foot?.z ?? .nan, -3, "rePivot's z is exact")
            Check.bitEq(p.foot.pos.x, 5, "rePivot also moves the animated foot (x)")
            Check.bitEq(p.foot.pos.z, -3, "rePivot also moves the animated foot (z)")
            Check.ok(p.foot.contact, "rePivot leaves the foot in contact")
        }

        // A body that goes airborne suspends the pivot (no longer locked).
        do {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1))
            p.anchored = true
            _ = loco.step(p, DesiredMove(), dt)
            Check.ok(loco.pivotOf(1) != nil, "locked at rest")
            // Send him airborne well above his landing floor, or `stepAir`'s own
            // landing check fires on this same tick and undoes it immediately.
            p.state = .jump
            p.air.airborne = true
            p.pos.y = 5.0
            p.vel = Vec3d(0, 2, 0)
            _ = loco.step(p, DesiredMove(), dt)
            Check.ok(loco.pivotOf(1) == nil, "airborne suspends the lock")
        }

        // A prone body (down after a layout) also suspends the pivot.
        do {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1))
            p.anchored = true
            _ = loco.step(p, DesiredMove(), dt)
            Check.ok(loco.pivotOf(1) != nil, "locked at rest")
            p.prone = true
            p.state = .landing
            p.stateDur = 10  // hold him prone for the tick we're inspecting
            _ = loco.step(p, DesiredMove(), dt)
            Check.ok(loco.pivotOf(1) == nil, "a prone body suspends the lock too")
        }
    }

    // MARK: - collision mechanics

    private static func collisionMechanics() {
        let dt = 1.0 / 120.0

        // The restitution law: for two bodies of EQUAL mass and strength (so
        // the impulse split is even and cancels out of the closing-speed
        // algebra), the closing speed along the contact normal after impact is
        // exactly `-COLLIDE_RESTITUTION` times the closing speed before it —
        // independent of the mass split, because the normal impulse is sized
        // exactly to produce that. Friction is tangential and does not touch
        // this component.
        do {
            let a = LocoPlayer(id: 1, attr: .defaultAttrs, pos: Vec3d(0, 0, 0), vel: Vec3d(3, 0, 0))
            let b = LocoPlayer(id: 2, attr: .defaultAttrs, pos: Vec3d(0.5, 0, 0), vel: Vec3d(-3, 0, 0))
            let vnBefore = (b.vel.x - a.vel.x) * 1 + (b.vel.z - a.vel.z) * 0  // normal is +x here
            let loco = freshLoco()
            loco.separate = false
            loco.resolveCollisions(dt, list: [a, b])
            let vnAfter = (b.vel.x - a.vel.x)
            Check.near(
                vnAfter, -Locomotion.COLLIDE_RESTITUTION * vnBefore, mathTol,
                "closing speed after impact is exactly -COLLIDE_RESTITUTION times before")
        }

        // Positional correction never makes an overlapping pair overlap MORE —
        // the correction only ever pushes them apart or leaves them be.
        do {
            let a = LocoPlayer(id: 1, attr: .defaultAttrs, pos: Vec3d(0, 0, 0), vel: Vec3d(0.5, 0, 0))
            let b = LocoPlayer(id: 2, attr: .defaultAttrs, pos: Vec3d(0.4, 0, 0), vel: Vec3d(-0.5, 0, 0))
            let distBefore = abs(b.pos.x - a.pos.x)
            let loco = freshLoco()
            loco.separate = false
            loco.resolveCollisions(dt, list: [a, b])
            let distAfter = ((b.pos.x - a.pos.x) * (b.pos.x - a.pos.x) + (b.pos.z - a.pos.z) * (b.pos.z - a.pos.z)).squareRoot()
            Check.ok(
                distAfter >= distBefore - 1e-9, "positional correction never deepens an overlap (\(distBefore) -> \(distAfter))")
        }

        // Stumble and the foul call, off a hard, symmetric head-on collision:
        // `impact = 6` clears the stumble threshold (resist = 4.65 for two
        // default-attribute bodies) but not the fall threshold (resist*1.9),
        // and a dead-tied closing speed attributes the foul to whichever body
        // the tie-break favours (A, since `closeA >= closeB`).
        do {
            var events: [LocoEvent] = []
            let a = LocoPlayer(id: 1, attr: .defaultAttrs, pos: Vec3d(0, 0, 0), vel: Vec3d(3, 0, 0))
            let b = LocoPlayer(id: 2, attr: .defaultAttrs, pos: Vec3d(0.5, 0, 0), vel: Vec3d(-3, 0, 0))
            let loco = Locomotion()
            loco.attach(LocoHost(events: { events.append($0) }))
            loco.separate = false
            loco.resolveCollisions(dt, list: [a, b])

            guard case .contact(let ca, let cb, let impact, let foulOn, _)? = events.first else {
                Check.ok(false, "a hard head-on collision emits a .contact event")
                return
            }
            Check.eq(ca, 1, "contact.a is the first body")
            Check.eq(cb, 2, "contact.b is the second body")
            Check.near(impact, 6, 0.05, "the recorded impact matches the closing speed")
            Check.eq(foulOn, 1, "a dead-tied closing speed attributes the foul to A (closeA >= closeB)")

            Check.ok(
                a.state == .stumble || b.state == .stumble,
                "an impact past the resist threshold (but under the fall threshold) stumbles somebody")
            Check.ok(
                a.state != .fall && b.state != .fall, "…but does not knock either body down outright")
        }

        // A harder collision (well past resist * 1.9) knocks the body down
        // instead of merely stumbling it.
        do {
            let a = LocoPlayer(id: 1, attr: .defaultAttrs, pos: Vec3d(0, 0, 0), vel: Vec3d(6, 0, 0))
            let b = LocoPlayer(id: 2, attr: .defaultAttrs, pos: Vec3d(0.5, 0, 0), vel: Vec3d(-6, 0, 0))
            let loco = freshLoco()
            loco.separate = false
            loco.resolveCollisions(dt, list: [a, b])
            Check.ok(
                (a.state == .fall && a.prone) || (b.state == .fall && b.prone),
                "a very hard collision knocks a body down prone, not merely stumbling it")
        }

        // A gentle graze (impact well under the resist threshold) stumbles
        // nobody at all.
        do {
            let a = LocoPlayer(id: 1, attr: .defaultAttrs, pos: Vec3d(0, 0, 0), vel: Vec3d(0.3, 0, 0))
            let b = LocoPlayer(id: 2, attr: .defaultAttrs, pos: Vec3d(0.5, 0, 0), vel: Vec3d(-0.3, 0, 0))
            let loco = freshLoco()
            loco.separate = false
            loco.resolveCollisions(dt, list: [a, b])
            Check.eq(a.state, .idle, "a gentle graze does not stumble A")
            Check.eq(b.state, .idle, "a gentle graze does not stumble B")
        }

        // The resist threshold's base term, isolated. resist = 2.0 + 2.5*bal + 1.5*str,
        // and for two default-attribute bodies (balance 70, strength 60) that is 4.65 —
        // the head-on collision above uses impact 6, which clears both 4.65 and a
        // deliberate mutant of 5.65 with room either way, so it cannot tell the base
        // term's value apart from a mutation to it. An impact between the two, 5.2,
        // clears 4.65 but not 5.65.
        do {
            let a = LocoPlayer(id: 1, attr: .defaultAttrs, pos: Vec3d(0, 0, 0), vel: Vec3d(2.6, 0, 0))
            let b = LocoPlayer(id: 2, attr: .defaultAttrs, pos: Vec3d(0.5, 0, 0), vel: Vec3d(-2.6, 0, 0))
            let loco = freshLoco()
            loco.separate = false
            loco.resolveCollisions(dt, list: [a, b])
            Check.ok(
                a.state == .stumble || b.state == .stumble,
                "an impact of 5.2 clears the real resist threshold (4.65) — somebody stumbles")
        }

        // The invMass strength coefficient, isolated. Every collision test above pairs
        // two default-attribute bodies, so both sides get the identical effective mass
        // and the positional correction splits 50/50 regardless of what the strength
        // coefficient actually is — no magnitude chosen for a symmetric pairing can ever
        // read it. Only an asymmetric-strength collision does, so that is what this
        // builds: a maximally strong body against a maximally weak one, both stationary
        // and already overlapping so only the positional correction fires (there is no
        // closing velocity, so the impulse branch never engages) — and the expected
        // split is computed here from the same formula production uses, independently
        // of any recorded value.
        do {
            var strong = Attributes.defaultAttrs
            strong.strength = 100
            var weak = Attributes.defaultAttrs
            weak.strength = 0
            let a = LocoPlayer(id: 1, attr: strong, pos: Vec3d(0, 0, 0), vel: .zero)
            let b = LocoPlayer(id: 2, attr: weak, pos: Vec3d(0.4, 0, 0), vel: .zero)
            let rsum = a.radius + b.radius
            let penBefore = rsum - 0.4

            // Mirrors invMass's own formula rather than guessing at it a second way — it
            // is the definition invMass is defined by, not an independent restatement:
            // p.attr.mass * (1 + 0.35 * str) * (prone ? 2.5 : 1).
            func effMass(_ strength: Double) -> Double {
                let str = clamp01(strength / 100)
                return Attributes.defaultAttrs.mass * (1 + 0.35 * str)
            }
            let invA = 1 / effMass(100)
            let invB = 1 / effMass(0)
            let invSum = invA + invB
            let corr = Swift.max(0, penBefore - Locomotion.COLLIDE_SLOP) * Locomotion.COLLIDE_BETA
            let expectedShiftA = corr * (invA / invSum)
            let expectedShiftB = corr * (invB / invSum)

            let loco2 = freshLoco()
            loco2.separate = false
            loco2.resolveCollisions(dt, list: [a, b])

            // The strong body is displaced LESS — asserted as a direction before a
            // magnitude, because a coefficient sign error would show up here first.
            let shiftA = abs(a.pos.x - 0)
            let shiftB = abs(b.pos.x - 0.4)
            Check.ok(
                shiftA < shiftB,
                "the stronger body is displaced less by the same overlap (\(shiftA) vs \(shiftB))")
            Check.near(shiftA, expectedShiftA, 1e-9, "the strong body's push matches invMass's own ratio")
            Check.near(shiftB, expectedShiftB, 1e-9, "and so does the weak body's, on the other side")
        }

        // A committed body (already airborne/laid out) is never stumbled by
        // contact — `maybeStumble` refuses committed states outright.
        do {
            let a = LocoPlayer(
                id: 1, attr: .defaultAttrs, pos: Vec3d(0, 0, 0), vel: Vec3d(6, 0, 0), state: .layout,
                air: AirState(airborne: false))
            let b = LocoPlayer(id: 2, attr: .defaultAttrs, pos: Vec3d(0.5, 0, 0), vel: Vec3d(-6, 0, 0))
            let loco = freshLoco()
            loco.separate = false
            loco.resolveCollisions(dt, list: [a, b])
            Check.eq(a.state, .layout, "a body already committed to a layout is not knocked into stumble/fall")
        }

        // The normal impulse only fires on approach — two bodies already
        // separating, still overlapping, take positional correction but no
        // velocity change.
        do {
            let a = LocoPlayer(id: 1, attr: .defaultAttrs, pos: Vec3d(0, 0, 0), vel: Vec3d(-2, 0, 0))
            let b = LocoPlayer(id: 2, attr: .defaultAttrs, pos: Vec3d(0.5, 0, 0), vel: Vec3d(2, 0, 0))
            let loco = freshLoco()
            loco.separate = false
            loco.resolveCollisions(dt, list: [a, b])
            Check.bitEqViaJSON(a.vel.x, -2, "no impulse on an already-separating pair (a)")
            Check.bitEqViaJSON(b.vel.x, 2, "no impulse on an already-separating pair (b)")
        }
    }

    // MARK: - stamina

    private static func staminaTests() {
        let dt = 1.0 / 120.0

        // The bound: stamina never leaves [0, 100], under a long sustained
        // sprint (drain) and a long sustained stand-still (recovery).
        do {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1, stamina: 100))
            for _ in 0..<3000 {
                _ = loco.step(p, DesiredMove(dir: Vec2d(0, 1), mode: .sprint), dt)
                Check.inRange(p.stamina, 0, 100, "stamina stays in [0,100] under sustained sprinting")
            }
            Check.ok(p.stamina < 100, "a long sprint actually drains stamina")
        }
        do {
            let loco = freshLoco()
            let p = loco.create(CreateOpts(id: 1, stamina: 0))
            for _ in 0..<3000 {
                _ = loco.step(p, DesiredMove(), dt)
                Check.inRange(p.stamina, 0, 100, "stamina stays in [0,100] under sustained recovery")
            }
            Check.ok(p.stamina > 0, "standing still actually recovers stamina")
        }

        // The airborne/prone 0.4 multiplier: a body committed to a jump
        // recovers (or drains) at 0.4x the rate `staminaRate` would otherwise
        // give it, computed at speed 0 rather than its actual airborne speed.
        do {
            let loco = freshLoco()
            let p = stateTestPlayer(state: .jump, stateT: 0, stateDur: 10, airborne: true)
            p.stamina = 50
            p.vel = Vec3d(3, 2, 0)
            _ = loco.step(p, DesiredMove(), dt)
            let fresh = 6.6 + 3.0 * clamp01(p.attr.speed / 100)
            let want = clamp(50 + staminaRate(p.attr, speed: 0, topSpeedFresh: fresh) * 0.4 * dt, 0, 100)
            Check.near(p.stamina, want, mathTol, "airborne stamina uses speed=0 and a 0.4x multiplier")
        }

        // The one-shot costs are pinned by exact value — a suite that only
        // checked the sign of the drain could not tell COST_CUT from
        // COST_JUMP from COST_LAYOUT.
        Check.bitEq(COST_JUMP, 2.5, "COST_JUMP")
        Check.bitEq(COST_LAYOUT, 9.0, "COST_LAYOUT")
        Check.bitEq(COST_CUT, 1.2, "COST_CUT")
        Check.ok(COST_LAYOUT > COST_JUMP && COST_JUMP > COST_CUT, "a layout costs more than a jump costs more than a cut")
    }

    // MARK: - the claims the module makes in prose

    /// Doc comments assert behaviour; behaviour can be checked. A flat,
    /// fieldless world, so these read as physics rather than as terrain.
    private static func flatWorldClaims() {
        let dt = 1.0 / 120.0

        // "false while laid out / down / getting up".
        for s in [LocoStateName.layout, .landing, .recovery, .fall] {
            let p = LocoPlayer(id: 1, attr: .defaultAttrs, state: s)
            Check.ok(!Locomotion.isAvailable(p), "a player in \(s.rawValue) is unavailable")
        }
        // `.jump` is committed but NOT unavailable — a body at the top of a
        // jump is very much in the play.
        for s in [LocoStateName.idle, .run, .sprint, .cut, .jump, .stumble] {
            let p = LocoPlayer(id: 1, attr: .defaultAttrs, state: s)
            Check.ok(Locomotion.isAvailable(p), "a player in \(s.rawValue) is still available to play the disc")
        }
        for s in [LocoStateName.jump, .layout, .landing, .recovery, .fall] {
            let p = LocoPlayer(id: 1, attr: .defaultAttrs, state: s)
            Check.ok(Locomotion.isCommitted(p), "\(s.rawValue) is a committed state")
        }
        for s in [LocoStateName.idle, .jog, .run, .sprint, .backpedal, .shuffle, .cut, .stumble] {
            let p = LocoPlayer(id: 1, attr: .defaultAttrs, state: s)
            Check.ok(!Locomotion.isCommitted(p), "\(s.rawValue) is NOT a committed state")
        }

        // "A layout cannot be cancelled once accepted."
        do {
            let l = freshLoco()
            let p = l.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
            p.vel = Vec3d(5, 0, 0)
            l.step(p, DesiredMove(dir: Vec2d(1, 0), mode: .sprint, layout: true), dt)
            Check.eq(p.state, .layout, "the layout was accepted")
            for _ in 0..<30 {
                l.step(p, DesiredMove(dir: Vec2d(-1, 0), mode: .sprint, brake: true), dt)
            }
            Check.ok(
                p.state == .layout || p.prone, "braking cannot cancel a layout once it has been accepted")
        }

        // "Layouts are committed — no steering at all. Jumps get a token amount."
        do {
            let l = freshLoco()
            let jumper = l.create(CreateOpts(id: 1))
            jumper.state = .jump
            jumper.air.airborne = true
            jumper.pos = Vec3d(0, 5, 0)
            let jvx = jumper.vel.x
            l.step(jumper, DesiredMove(dir: Vec2d(1, 0)), dt)
            Check.ok(jumper.vel.x > jvx, "a jumper can nudge themselves in the air")

            let diver = l.create(CreateOpts(id: 2))
            diver.state = .layout
            diver.air.airborne = true
            diver.pos = Vec3d(0, 5, 0)
            let dvx = diver.vel.x
            l.step(diver, DesiredMove(dir: Vec2d(1, 0)), dt)
            Check.bitEqViaJSON(diver.vel.x, dvx, "a layout cannot be steered at all")
        }

        // "no request can reverse a velocity instantly".
        do {
            let l = freshLoco()
            let p = l.create(CreateOpts(id: 1))
            p.vel = Vec3d(7, 0, 0)
            l.step(p, DesiredMove(dir: Vec2d(-1, 0), mode: .sprint), dt)
            Check.ok(p.vel.x > 0, "a 180 cannot reverse the velocity in a single step")
        }

        // "A THROWER ON HIS PIVOT IS IMMOVABLE."
        do {
            let l = freshLoco()
            let thrower = l.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
            thrower.anchored = true
            let marker = l.create(CreateOpts(id: 2, pos: Vec3d(0.30, 0, 0)))
            marker.vel = Vec3d(-3, 0, 0)
            let tx = thrower.pos.x
            let tz = thrower.pos.z
            let mx = marker.pos.x
            l.resolveCollisions(dt)
            Check.bitEqViaJSON(thrower.pos.x, tx, "an anchored thrower is not displaced in x")
            Check.bitEqViaJSON(thrower.pos.z, tz, "an anchored thrower is not displaced in z")
            Check.ok(marker.pos.x > mx, "the marker takes the whole correction instead")
        }

        // "Positional correction adds no energy" — the soft tier must never
        // write velocity.
        do {
            let l = freshLoco()
            let a = l.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
            let b = l.create(CreateOpts(id: 2, pos: Vec3d(0.9, 0, 0)))
            a.vel = Vec3d(1, 0, 0.5)
            b.vel = Vec3d(-1, 0, 0.25)
            let av = a.vel
            let bv = b.vel
            l.resolveCollisions(dt)
            Check.ok(l.sepPairs == 1, "the soft tier engaged on a pair inside personal space")
            Check.bitEqViaJSON(a.vel.x, av.x, "separation writes no velocity (a.x)")
            Check.bitEqViaJSON(a.vel.z, av.z, "separation writes no velocity (a.z)")
            Check.bitEqViaJSON(b.vel.x, bv.x, "separation writes no velocity (b.x)")
            Check.bitEqViaJSON(b.vel.z, bv.z, "separation writes no velocity (b.z)")
        }

        // "the normal impulse only fires on approach".
        do {
            let l = freshLoco()
            let a = l.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
            let b = l.create(CreateOpts(id: 2, pos: Vec3d(0.5, 0, 0)))
            a.vel = Vec3d(-2, 0, 0)
            b.vel = Vec3d(2, 0, 0)
            l.separate = false
            l.resolveCollisions(dt)
            Check.bitEqViaJSON(a.vel.x, -2, "no impulse on a separating pair (a)")
            Check.bitEqViaJSON(b.vel.x, 2, "no impulse on a separating pair (b)")
        }

        // "Vertical separation beyond which two players simply miss each other."
        do {
            let l = freshLoco()
            let a = l.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
            let b = l.create(CreateOpts(id: 2, pos: Vec3d(0.1, 0, 0)))
            b.pos.y = a.pos.y + Locomotion.COLLIDE_Y_SPAN + 0.01
            b.air.airborne = true
            a.vel = Vec3d(2, 0, 0)
            let ax = a.pos.x
            l.resolveCollisions(dt)
            Check.bitEqViaJSON(a.pos.x, ax, "bodies more than COLLIDE_Y_SPAN apart miss each other")
        }

        // "Horizontal speed retained through a vertical takeoff" / "on a
        // two-foot landing" — both are losses, and the landing is the bigger one.
        do {
            let l = freshLoco()
            let p = l.create(CreateOpts(id: 1))
            p.vel = Vec3d(6, 0, 0)
            p.state = .jump
            p.stateDur = 0
            p.stateT = 1
            let before = p.vel.x
            l.step(p, DesiredMove(), dt)
            Check.ok(p.air.airborne, "the gather finished and the body left the ground")
            Check.ok(p.vel.y > 0, "a takeoff has upward velocity")
            Check.ok(p.vel.x < before && p.vel.x > 0, "a vertical takeoff costs some, not all, horizontal speed")
        }

        // `timeToReach`: zero distance is free, and farther takes longer.
        do {
            let l = freshLoco()
            let p = l.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
            Check.bitEqViaJSON(l.timeToReach(p, x: 0, z: 0), 0, "no travel time to where you already are")
            let near = l.timeToReach(p, x: 5, z: 0)
            let far = l.timeToReach(p, x: 25, z: 0)
            Check.ok(far > near, "a farther spot takes longer to reach")
            Check.ok(near > 0, "a real distance takes real time")
            p.vel = Vec3d(-8, 0, 0)
            Check.ok(l.timeToReach(p, x: 25, z: 0) > far, "sprinting away from the target costs time to turn around")
        }

        // `intentToDesired`'s arrive taper.
        do {
            let l = freshLoco()
            let p = l.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
            let far = l.intentToDesired(p, IntentLike(id: 1, targetX: 10, targetZ: 0, desiredSpeed: 6))
            let close = l.intentToDesired(p, IntentLike(id: 1, targetX: 0.3, targetZ: 0, desiredSpeed: 6))
            let onTop = l.intentToDesired(p, IntentLike(id: 1, targetX: 0.01, targetZ: 0, desiredSpeed: 6))
            Check.bitEqViaJSON(far.speed ?? -1, 6, "outside the arrive radius the speed stands")
            Check.ok((close.speed ?? -1) < 6, "inside the arrive radius the speed tapers")
            Check.bitEqViaJSON(onTop.speed ?? -1, 0, "on top of the target the speed is zero")

            let pose = l.intentToDesired(p, IntentLike(id: 1, targetX: 10, targetZ: 0, mode: "throw"))
            Check.eq(pose.mode, MoveMode.run, "a pose mode falls back to the run gait")
            let bid = l.intentToDesired(
                p, IntentLike(id: 1, targetX: 10, targetZ: 0, action: IntentAction(kind: "bid", x: 0, z: 5)))
            Check.ok(bid.layout, "a bid action requests a layout")
            Check.ok((bid.dir?.z ?? 0) > 0.99, "a bid steers toward the bid point, not the path target")
        }

        // `fromAIAttributes`: the fallback chains are load-bearing.
        do {
            let a = fromAIAttributes(["acceleration": 91, "jumping": 88, "stamina": 44, "agility": 12])
            Check.bitEqViaJSON(a.accel, 91, "accel falls back to the AI's `acceleration`")
            Check.bitEqViaJSON(a.vertical, 88, "vertical falls back to the AI's `jumping`")
            Check.bitEqViaJSON(a.endurance, 44, "endurance falls back to the AI's `stamina`")
            Check.bitEqViaJSON(a.balance, 12, "balance falls back to agility, not to the default balance")
            let empty = fromAIAttributes([:])
            Check.bitEqViaJSON(empty.speed, Attributes.defaultAttrs.speed, "empty ratings default")
        }
    }

    // MARK: - a self-driven trace, for claims only a trajectory can settle

    /// Replaces the golden's scripted replay with a script this suite drives
    /// itself: accelerate, hold, hard cut, jump, layout, run uphill/downhill,
    /// brake, reverse. Every claim below reads off the resulting trajectory —
    /// no value from it is pinned, since a trace is exactly the kind of thing
    /// `FlightTests`' header warns cannot be usefully re-recorded as a second
    /// fixture; it is checked as physics instead.
    private struct TraceLeg {
        let label: String
        let n: Int
        let dir: Vec2d?
        let mode: MoveMode?
        let jump: Bool
        let layout: Bool
        let brake: Bool
        let dt: Double
        init(
            _ label: String, _ n: Int, _ dir: Vec2d? = nil, _ mode: MoveMode? = nil,
            jump: Bool = false, layout: Bool = false, brake: Bool = false, dt: Double = 1.0 / 120.0
        ) {
            self.label = label
            self.n = n
            self.dir = dir
            self.mode = mode
            self.jump = jump
            self.layout = layout
            self.brake = brake
            self.dt = dt
        }
    }

    private static func selfDrivenTraceClaims() {
        let hx = 0.1, hz = -0.05
        let field = FieldLike(
            heightAt: { x, z in hx * x + hz * z }, normalAt: { _, _ in Vec3d(-hx, 1, -hz) })

        let script: [TraceLeg] = [
            TraceLeg("stand still", 12),
            TraceLeg("accelerate north at a sprint", 60, Vec2d(0, 1), .sprint),
            TraceLeg("hold the sprint at speed", 20, Vec2d(0, 1), .sprint),
            TraceLeg("hard cut 90 degrees to +x", 50, Vec2d(1, 0), .sprint),
            TraceLeg("settle onto the new line", 20, Vec2d(1, 0), .run),
            TraceLeg("request a jump", 1, Vec2d(1, 0), .run, jump: true),
            TraceLeg("gather, take off, fly, land", 160, Vec2d(1, 0), .run),
            TraceLeg("rebuild speed after the landing", 40, Vec2d(1, 0), .run),
            TraceLeg("request a layout", 1, Vec2d(1, 0), .run, layout: true),
            TraceLeg("gather, dive, land prone, slide, get up", 250, nil),
            TraceLeg("run uphill (+x is up this plane)", 60, Vec2d(1, 0), .sprint),
            TraceLeg("run downhill", 60, Vec2d(-1, 0), .sprint),
            TraceLeg("hard stop", 25, Vec2d(-1, 0), nil, brake: true),
            TraceLeg("reverse 180 degrees", 60, Vec2d(-1, -1), .sprint),
            TraceLeg("oversized dt gets clamped to 1/30", 4, Vec2d(1, 1), .sprint, dt: 1.0 / 10.0),
            TraceLeg("zero dt is a no-op", 2, Vec2d(1, 1), .sprint, dt: 0),
        ]

        let loco = Locomotion()
        loco.attach(LocoHost(field: field))
        let p = loco.create(CreateOpts(id: 3, pos: Vec3d(-4, 0, -6), stamina: 92))
        let initialStamina = p.stamina

        var sawCutEntry: Double? = nil
        var sawCutExit: Double? = nil
        var cutTicks = 0
        var sawJumpGatherOnGround = false
        var sawJumpAirborneAfter = false
        var uphillSlopeMul: Double? = nil
        var downhillSlopeMul: Double? = nil
        var checkedSeat = 0
        var sawLayoutAirborne = false
        var sawRecoveryProne = false
        var recoveryYFirst: Double? = nil
        var recoveryYLast: Double? = nil

        for leg in script {
            for i in 0..<leg.n {
                let desired = DesiredMove(
                    dir: leg.dir, mode: leg.mode, jump: leg.jump, layout: leg.layout, brake: leg.brake)

                if leg.label.hasPrefix("zero dt") {
                    let tBefore = p.t
                    loco.step(p, desired, leg.dt)
                    loco.resolveCollisions(leg.dt)
                    Check.bitEqViaJSON(p.t, tBefore, "zero dt does not advance the clock")
                } else {
                    loco.step(p, desired, leg.dt)
                    loco.resolveCollisions(leg.dt)
                }

                if p.state == .cut {
                    cutTicks += 1
                    if sawCutEntry == nil { sawCutEntry = p.cutEntrySpeed }
                } else if sawCutEntry != nil && sawCutExit == nil {
                    sawCutExit = (p.vel.x * p.vel.x + p.vel.z * p.vel.z).squareRoot()
                }

                if leg.jump && p.state == .jump && !p.air.airborne { sawJumpGatherOnGround = true }
                if sawJumpGatherOnGround && p.air.airborne { sawJumpAirborneAfter = true }

                if leg.label.hasPrefix("run uphill") { uphillSlopeMul = p.derived.slopeMul }
                if leg.label.hasPrefix("run downhill") { downhillSlopeMul = p.derived.slopeMul }

                if leg.label.hasPrefix("gather, dive") && p.air.airborne && p.state == .layout {
                    sawLayoutAirborne = true
                }
                if p.state == .recovery && p.prone {
                    sawRecoveryProne = true
                    if recoveryYFirst == nil { recoveryYFirst = p.pos.y }
                    recoveryYLast = p.pos.y
                }

                if !p.air.airborne && !p.prone && p.state != .recovery {
                    let want = hx * p.pos.x + hz * p.pos.z
                    Check.near(p.groundY, want, mathTol, "groundY(\(leg.label)[\(i)]) is the surface under the body")
                    checkedSeat += 1
                }
            }
        }

        Check.ok(sawCutEntry != nil, "the trace contains a completed hard cut")
        if let entry = sawCutEntry, let exit = sawCutExit {
            Check.inRange(exit / entry, 0.45, 0.95, "a hard cut costs real speed but not all of it")
        }
        Check.ok(cutTicks > 1, "a cut always plays out over several ticks, not a single one")

        Check.ok(sawJumpGatherOnGround, "the trace contains a jump that gathers on the ground first")
        Check.ok(sawJumpAirborneAfter, "…and then actually leaves the ground")

        if let u = uphillSlopeMul, let d = downhillSlopeMul {
            Check.ok(u < 1, "running uphill scales capability down (\(u))")
            Check.ok(d > 1, "running downhill scales it up (\(d))")
        } else {
            Check.ok(false, "the trace ran both an uphill and a downhill leg")
        }

        Check.ok(checkedSeat > 100, "the re-seat claim was checked over most of the trace (\(checkedSeat) ticks)")

        Check.ok(sawLayoutAirborne, "the trace contains a layout in flight")
        Check.ok(sawRecoveryProne, "a layout ends face down and has to get up")
        if let first = recoveryYFirst, let last = recoveryYLast {
            Check.ok(last > first, "getting up raises the centre of mass (\(first) -> \(last))")
        }

        Check.ok(p.stamina < initialStamina, "a whole trace of sprinting, cutting and laying out costs stamina")

        // ---- the pair trace: head-on contact, fouls and stumbles ----
        var pairAttrsA = Attributes.defaultAttrs
        pairAttrsA.mass = 68
        pairAttrsA.strength = 35
        pairAttrsA.balance = 40
        pairAttrsA.agility = 85
        var pairAttrsB = Attributes.defaultAttrs
        pairAttrsB.mass = 104
        pairAttrsB.strength = 88
        pairAttrsB.balance = 80
        pairAttrsB.agility = 55

        var pairEvents: [LocoEvent] = []
        let pairLoco = Locomotion()
        pairLoco.attach(LocoHost(events: { pairEvents.append($0) }))
        var optsA = CreateOpts(id: 11, team: 0, pos: Vec3d(-3.2, 0, 0), facing: Double.pi / 2, stamina: 100)
        optsA.attr = pairAttrsA
        var optsB = CreateOpts(id: 4, team: 1, pos: Vec3d(3.2, 0, 0), facing: -Double.pi / 2, stamina: 100)
        optsB.attr = pairAttrsB
        let a = pairLoco.create(optsA)
        let b = pairLoco.create(optsB)

        var aWentDown = false
        var bWentDown = false
        for _ in 0..<180 {
            pairLoco.step(a, DesiredMove(dir: Vec2d(1, 0), mode: .sprint), 1.0 / 120.0)
            pairLoco.step(b, DesiredMove(dir: Vec2d(-1, 0), mode: .sprint), 1.0 / 120.0)
            pairLoco.resolveCollisions(1.0 / 120.0)
            if a.state == .stumble || a.state == .fall { aWentDown = true }
            if b.state == .stumble || b.state == .fall { bWentDown = true }
        }

        let contacts = pairEvents.compactMap { ev -> (Int, Int, Int)? in
            if case .contact(let ca, let cb, _, let foulOn, _) = ev { return (ca, cb, foulOn) }
            return nil
        }
        Check.ok(!contacts.isEmpty, "the pair trace actually collided")
        Check.ok(
            contacts.allSatisfy { $0.2 == $0.0 || $0.2 == $0.1 },
            "a foul is always called on one of the two bodies involved")
        Check.ok(aWentDown || bWentDown, "hard contact stumbles the player who was less braced")
        // A is deliberately the lighter, weaker, worse-balanced athlete.
        Check.ok(aWentDown, "the lighter, weaker, worse-balanced body is the one that goes down")
    }
}
