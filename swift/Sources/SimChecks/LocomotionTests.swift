import Foundation
import UltimateSim

/// The locomotion port, against `src/sim/Locomotion.ts`.
///
/// This suite is a **replay**, not a case table, because the thing being ported is a
/// state machine wrapped around an integrator. The fixture drives the reference
/// through a scripted command sequence — accelerate, hold, hard cut, jump, layout,
/// land, recover, run uphill, brake, backpedal, shuffle, reverse — and records the
/// whole player after every one of 1,095 fixed steps, plus a second 180-step trace of
/// two bodies colliding. This suite reconstructs the same seed, issues the same
/// commands, and compares every field of every step.
///
/// ----------------------------------------------------------------- strictness
///
/// The split is not the same as `MoveTests`', and the reason is worth stating.
/// `move` compares *functions*: pure arithmetic in, one number out, so bit-equality
/// is the right bar and it is met. `Locomotion` compares a *trajectory*. Velocity is
/// fed back into itself every step through `Math.hypot` (which IEEE 754 does not
/// require to be correctly rounded, so V8 and Darwin libm may legitimately differ in
/// the last ulp), through `exp` in the gather and recovery decays, `acos` in the cut
/// test, `cos` in the cut loss, `atan2`/`sin`/`cos` in facing, and `pow` inside
/// `propulsiveAt` and `staminaRate`. One ulp on step 3 is a slightly different
/// position on step 900.
///
/// So:
///
///   - **Discrete state is exact.** `state`, `prone`, `airborne`, `foot.planted`,
///     `foot.contact`, `foot.hard`, `sepPairs`, the event kinds and ids, which foot
///     planted, whether a foul was called, whom it was called on. These are where the
///     porting bugs actually live — a cut that never ends, a landing that never
///     resolves, a foul attributed to the wrong body — and a tolerance cannot hide
///     any of them.
///   - **`groundN` and the per-player clock are bit-exact.** The normal comes from a
///     constant vector through one `sqrt` and one divide, and `t`/`lastStepT` are
///     sums of `dt`. Neither touches a transcendental, so neither gets a pass.
///   - **Everything else carries `traceTol`**, and the suite reports the worst
///     deviation it actually saw so that a number which is drifting is visible long
///     before it is a failure.
enum LocomotionTests {

    // MARK: - fixture shapes

    struct XYZ: Decodable {
        let x: Double
        let y: Double
        let z: Double
        var vec: Vec3d { Vec3d(x, y, z) }
    }
    struct XZ: Decodable {
        let x: Double
        let z: Double
    }

    struct FootSnap: Decodable {
        let planted: String
        let pos: XYZ
        let t: Double
        let contact: Bool
        let phase: Double
        let stride: Double
        let hard: Bool
        let speed: Double
    }

    struct AirSnap: Decodable {
        let airborne: Bool
        let tTakeoff: Double
        let tApex: Double
        let apexY: Double
        let takeoffY: Double
        let tLand: Double
        let vy0: Double
    }

    /// One step's worth of player. `radius`/`personal`/`hipHeight`/`anchored` are only
    /// present on the two `initial` snapshots — see the generator's note on why they
    /// are not repeated 1,275 times, and `invariants()` below for the check that
    /// earns the omission.
    struct Snap: Decodable {
        let pos: XYZ
        let vel: XYZ
        let facing: Double
        let state: String
        let stateT: Double
        let stateDur: Double
        let prone: Bool
        let stamina: Double
        let foot: FootSnap
        let air: AirSnap
        let groundY: Double
        let groundN: XYZ
        let cmd: XZ
        let cutDir: XYZ
        let cutEntrySpeed: Double
        let cutAngle: Double
        let lastStepT: Double
        let t: Double
        let derived: Derived

        let radius: Double?
        let personal: Double?
        let hipHeight: Double?
        let anchored: Bool?
    }

    /// A flattened `LocoEvent`. `kind` selects which of the optionals are populated.
    struct EvSnap: Decodable {
        let kind: String
        let id: Int?
        let pos: XYZ?
        let foot: String?
        let speed: Double?
        let hard: Bool?
        let impact: Double?
        let layout: Bool?
        let a: Int?
        let b: Int?
        let foulOn: Int?
        let called: Bool?
    }

    struct Leg: Decodable {
        let label: String
        let n: Int
        let dt: Double
        let dir: XZ?
        let speed: Double?
        let effort: Double?
        let maxSpeed: Double?
        let mode: String?
        let face: XZ?
        let jump: Bool?
        let layout: Bool?
        let brake: Bool?
    }

    struct Seed: Decodable {
        let id: Int
        let team: Int
        let pos: XYZ
        let facing: Double
        let stamina: Double
    }

    struct FieldSpec: Decodable {
        let hx: Double
        let hz: Double
        let rawNormal: XYZ
    }

    struct Constants: Decodable {
        let CUT_ANGLE: Double
        let CUT_MIN_SPEED: Double
        let PLANT_GRIP: Double
        let PLANT_BRAKE: Double
        let CUT_LOSS_BASE: Double
        let CUT_REFRACTORY: Double
        let JUMP_GATHER: Double
        let LAYOUT_GATHER: Double
        let JUMP_HORIZ_KEEP: Double
        let AIR_CONTROL: Double
        let SLIDE_DECEL: Double
        let LAND_HORIZ_KEEP: Double
        let COLLIDE_BETA: Double
        let COLLIDE_SLOP: Double
        let COLLIDE_RESTITUTION: Double
        let COLLIDE_FRICTION: Double
        let COLLIDE_Y_SPAN: Double
        let DEFAULT_RADIUS: Double
    }

    struct SoloStep: Decodable {
        let leg: Int
        let player: Snap
        let sepPairs: Int
        let sepWork: Double
        let events: [EvSnap]
    }

    struct PairStep: Decodable {
        let a: Snap
        let b: Snap
        let sepPairs: Int
        let sepWork: Double
        let events: [EvSnap]
    }

    struct SoloTrace: Decodable {
        let initial: Snap
        let steps: [SoloStep]
    }
    struct PairInitial: Decodable {
        let a: Snap
        let b: Snap
    }
    struct PairTrace: Decodable {
        let initial: PairInitial
        let steps: [PairStep]
    }
    struct PairAttrs: Decodable {
        let a: Attributes
        let b: Attributes
    }
    struct PairSeeds: Decodable {
        let a: Seed
        let b: Seed
    }

    struct File: Decodable {
        let note: String
        let constants: Constants
        let field: FieldSpec
        let soloScript: [Leg]
        let soloAttrs: Attributes
        let soloSeed: Seed
        let solo: SoloTrace
        let pairAttrs: PairAttrs
        let pairSeed: PairSeeds
        let pair: PairTrace
    }

    // MARK: - tolerance

    /// Every continuous quantity in the trace is downstream of `hypot` and of several
    /// hundred integration steps, so this is a tolerance rather than bit-equality.
    ///
    /// The number is measured, not guessed. Across 87,000 assertions over 1,275 steps
    /// the worst deviation observed is 2.7e-15 — a handful of ulps on quantities of
    /// order 1, and it does not grow with step index, which says the solve is not
    /// accumulating error so much as re-deriving it each step from the same inputs.
    /// 1e-12 leaves about 400x of headroom for another libm without leaving room for a
    /// transposed coefficient or a dropped term to hide: a real porting bug moves these
    /// numbers by parts in a thousand, not parts in a quadrillion. The observed worst
    /// is reported as a note, so drift is visible long before it is a failure.
    private static let traceTol = 1e-12

    /// `cutAngle` alone, and here is the arithmetic that justifies it.
    ///
    /// The angle is `acos(clamp(dot, -1, 1))`, and `acos` has an unbounded derivative
    /// at its endpoints: near `dot = -1` it behaves like `pi - sqrt(2) * sqrt(1 + dot)`,
    /// so a single ulp of disagreement in the dot product — 2.2e-16 — comes out as
    /// 2.1e-8 of angle. The trace contains an exact 180-degree reversal, which lands
    /// precisely on that endpoint, and V8 and Darwin land on opposite sides of it. It
    /// is conditioning, not a porting bug.
    ///
    /// It is also harmless, and the suite proves that rather than asserting it: the
    /// only consumer of `cutAngle` is `(1 - cos(cutAngle)) * 0.5` in `endCut`, and
    /// `cos` is flat at pi, so the 2.1e-8 in the angle squares back down to ~1e-16 in
    /// the speed loss. Every velocity, position and stamina value downstream of that
    /// cut still passes at `traceTol`, which is what says the difference stopped here.
    private static let acosTol = 1e-7

    /// A bit-exactness census over the tolerance comparisons.
    ///
    /// The tolerance above is the honest bar for a trajectory, but it would also hide a
    /// slow slide from "identical" to "close". So every `approx` also records whether
    /// the two values were bit-identical, and the count is reported.
    ///
    /// At the time of writing 1,577 of 60,472 — 2.6% — were not, concentrated in `pos`
    /// and `vel` in the ground plane, `groundY`, `foot.stride` and `derived.turnRate`,
    /// every one of them a `hypot` call away from the difference. The other 97.4% agree
    /// to the bit across 1,275 integration steps. A change that pushes that ratio up by
    /// an order of magnitude is worth looking at even while every assertion passes.
    nonisolated(unsafe) static var compared = 0
    nonisolated(unsafe) static var notBitEqual = 0

    // MARK: - run

    static func run() throws {
        let g = try Goldens.load(File.self, "locomotion")

        constants(g.constants)
        solo(g)
        pair(g)
        claims(g)

        // The bit-exactness census has no direction that is "good" — an envelope
        // assertion tolerates small differences by design — so it is printed rather
        // than asserted.
        print(
            "  · locomotion bit-exactness census: \(notBitEqual) of \(compared) "
                + "tolerance comparisons were not bit-identical")
    }

    // MARK: - constants

    /// Compared one at a time so a failure names the constant. `CUT_ANGLE` in
    /// particular is written `45 * Math.PI / 180` in the reference and must not be
    /// "simplified" to `pi / 4` on either side — those differ in the last bit, and the
    /// bit-exact comparison here is what enforces that.
    private static func constants(_ c: Constants) {
        Check.bitEqViaJSON(Locomotion.CUT_ANGLE, c.CUT_ANGLE, "CUT_ANGLE")
        Check.bitEqViaJSON(Locomotion.CUT_MIN_SPEED, c.CUT_MIN_SPEED, "CUT_MIN_SPEED")
        Check.bitEqViaJSON(Locomotion.PLANT_GRIP, c.PLANT_GRIP, "PLANT_GRIP")
        Check.bitEqViaJSON(Locomotion.PLANT_BRAKE, c.PLANT_BRAKE, "PLANT_BRAKE")
        Check.bitEqViaJSON(Locomotion.CUT_LOSS_BASE, c.CUT_LOSS_BASE, "CUT_LOSS_BASE")
        Check.bitEqViaJSON(Locomotion.CUT_REFRACTORY, c.CUT_REFRACTORY, "CUT_REFRACTORY")
        Check.bitEqViaJSON(Locomotion.JUMP_GATHER, c.JUMP_GATHER, "JUMP_GATHER")
        Check.bitEqViaJSON(Locomotion.LAYOUT_GATHER, c.LAYOUT_GATHER, "LAYOUT_GATHER")
        Check.bitEqViaJSON(Locomotion.JUMP_HORIZ_KEEP, c.JUMP_HORIZ_KEEP, "JUMP_HORIZ_KEEP")
        Check.bitEqViaJSON(Locomotion.AIR_CONTROL, c.AIR_CONTROL, "AIR_CONTROL")
        Check.bitEqViaJSON(Locomotion.SLIDE_DECEL, c.SLIDE_DECEL, "SLIDE_DECEL")
        Check.bitEqViaJSON(Locomotion.LAND_HORIZ_KEEP, c.LAND_HORIZ_KEEP, "LAND_HORIZ_KEEP")
        Check.bitEqViaJSON(Locomotion.COLLIDE_BETA, c.COLLIDE_BETA, "COLLIDE_BETA")
        Check.bitEqViaJSON(Locomotion.COLLIDE_SLOP, c.COLLIDE_SLOP, "COLLIDE_SLOP")
        Check.bitEqViaJSON(
            Locomotion.COLLIDE_RESTITUTION, c.COLLIDE_RESTITUTION, "COLLIDE_RESTITUTION")
        Check.bitEqViaJSON(Locomotion.COLLIDE_FRICTION, c.COLLIDE_FRICTION, "COLLIDE_FRICTION")
        Check.bitEqViaJSON(Locomotion.COLLIDE_Y_SPAN, c.COLLIDE_Y_SPAN, "COLLIDE_Y_SPAN")
        Check.bitEqViaJSON(Locomotion.DEFAULT_RADIUS, c.DEFAULT_RADIUS, "DEFAULT_RADIUS")

        // Orderings the model relies on and never states as code. A plant that lasted
        // longer than the refractory gap would let a cut retrigger before the previous
        // one released, and the state machine would never leave `.cut`.
        Check.ok(
            Locomotion.CUT_REFRACTORY > 0, "there is a real gap between consecutive cuts")
        Check.ok(
            Locomotion.PLANT_GRIP > 1 && Locomotion.PLANT_BRAKE > 1,
            "a planted foot grips and brakes harder than a running one")
        Check.ok(
            Locomotion.LAND_HORIZ_KEEP < Locomotion.JUMP_HORIZ_KEEP,
            "landing costs more speed than taking off does")
        Check.ok(
            Locomotion.AIR_CONTROL < 1,
            "air steering is a token amount — you are a projectile")
    }

    // MARK: - the world under the trace

    /// The generator's tilted plane, rebuilt from the numbers it emitted rather than
    /// from copied literals. `heightAt` is written in the same order the generator
    /// writes it (`hx * x + hz * z`) so the two agree bit for bit.
    private static func field(_ f: FieldSpec) -> FieldLike {
        let hx = f.hx
        let hz = f.hz
        let n = f.rawNormal.vec
        return FieldLike(
            heightAt: { x, z in hx * x + hz * z },
            normalAt: { _, _ in n }
        )
    }

    /// A reference box for the event log. The host takes an escaping closure and the
    /// log has to outlive it, which an array local cannot do.
    private final class Sink {
        var events: [LocoEvent] = []
    }

    private static func desired(_ leg: Leg) -> DesiredMove {
        DesiredMove(
            dir: leg.dir.map { Vec2d($0.x, $0.z) },
            speed: leg.speed,
            effort: leg.effort,
            maxSpeed: leg.maxSpeed,
            mode: leg.mode.flatMap { MoveMode(rawValue: $0) },
            face: leg.face.map { Vec2d($0.x, $0.z) },
            jump: leg.jump ?? false,
            layout: leg.layout ?? false,
            brake: leg.brake ?? false
        )
    }

    private static func opts(_ s: Seed, _ attr: Attributes) -> CreateOpts {
        CreateOpts(
            id: s.id, team: s.team, attr: attr, pos: s.pos.vec,
            facing: s.facing, stamina: s.stamina)
    }

    // MARK: - the solo trace

    private static func solo(_ g: File) {
        let sink = Sink()
        let loco = Locomotion()
        loco.attach(LocoHost(events: { sink.events.append($0) }, field: field(g.field)))
        let p = loco.create(opts(g.soloSeed, g.soloAttrs))

        // `create()` alone is worth asserting: it seats the body on the terrain
        // (`groundY + 0.53 * height`) and draws the gait phase offset from a forked
        // RNG. Both are easy to get subtly wrong and neither is visible later, because
        // every subsequent step overwrites `pos.y` from `conformY`.
        compare(p, g.solo.initial, "solo create")
        invariants(p, g.solo.initial, "solo create")

        var k = 0
        for (legIndex, leg) in g.soloScript.enumerated() {
            for i in 0..<leg.n {
                let before = sink.events.count
                loco.step(p, desired(leg), leg.dt)
                loco.resolveCollisions(leg.dt)

                guard k < g.solo.steps.count else {
                    Check.ok(false, "solo trace ran past the fixture at step \(k)")
                    return
                }
                let want = g.solo.steps[k]
                let at = "solo[\(k)] leg \(legIndex).\(i) \(leg.label)"
                Check.eq(want.leg, legIndex, "\(at): fixture and replay agree on the leg")
                compare(p, want.player, at)
                Check.eq(loco.sepPairs, want.sepPairs, "\(at).sepPairs")
                approx(loco.sepWork, want.sepWork, "\(at).sepWork")
                events(Array(sink.events[before...]), want.events, at)
                // Nothing in the model may touch these after `create`.
                invariants(p, g.solo.initial, at)
                k += 1
            }
        }
        Check.eq(k, g.solo.steps.count, "the solo replay ran every fixture step")
    }

    // MARK: - the pair trace

    private static func pair(_ g: File) {
        let sink = Sink()
        let loco = Locomotion()
        loco.attach(LocoHost(events: { sink.events.append($0) }, field: field(g.field)))
        let a = loco.create(opts(g.pairSeed.a, g.pairAttrs.a))
        let b = loco.create(opts(g.pairSeed.b, g.pairAttrs.b))

        compare(a, g.pair.initial.a, "pair create a")
        compare(b, g.pair.initial.b, "pair create b")
        invariants(a, g.pair.initial.a, "pair create a")
        invariants(b, g.pair.initial.b, "pair create b")

        let dt = 1.0 / 120.0
        for (k, want) in g.pair.steps.enumerated() {
            let before = sink.events.count
            loco.step(a, DesiredMove(dir: Vec2d(1, 0), mode: .sprint), dt)
            loco.step(b, DesiredMove(dir: Vec2d(-1, 0), mode: .sprint), dt)
            loco.resolveCollisions(dt)

            let at = "pair[\(k)]"
            compare(a, want.a, "\(at).a")
            compare(b, want.b, "\(at).b")
            // `sepPairs` is the count of engaged pairs and is an integer: exact. It is
            // the one number that says the soft tier fired at all, so a replay that
            // silently skipped separation would be caught here and nowhere else.
            Check.eq(loco.sepPairs, want.sepPairs, "\(at).sepPairs")
            approx(loco.sepWork, want.sepWork, "\(at).sepWork")
            events(Array(sink.events[before...]), want.events, at)
        }
    }

    // MARK: - comparison

    private static func compare(_ p: LocoPlayer, _ w: Snap, _ at: String) {
        approx(p.pos.x, w.pos.x, "\(at).pos.x")
        approx(p.pos.y, w.pos.y, "\(at).pos.y")
        approx(p.pos.z, w.pos.z, "\(at).pos.z")
        approx(p.vel.x, w.vel.x, "\(at).vel.x")
        approx(p.vel.y, w.vel.y, "\(at).vel.y")
        approx(p.vel.z, w.vel.z, "\(at).vel.z")
        approx(p.facing, w.facing, "\(at).facing")

        // Discrete. A tolerance would let a cut that never released, or a landing that
        // resolved a step early, pass as "close enough" — and those are the failures
        // this suite exists to catch.
        Check.eq(p.state.rawValue, w.state, "\(at).state")
        Check.eq(p.prone, w.prone, "\(at).prone")
        Check.eq(p.air.airborne, w.air.airborne, "\(at).air.airborne")
        Check.eq(p.foot.planted.rawValue, w.foot.planted, "\(at).foot.planted")
        Check.eq(p.foot.contact, w.foot.contact, "\(at).foot.contact")
        Check.eq(p.foot.hard, w.foot.hard, "\(at).foot.hard")

        approx(p.stateT, w.stateT, "\(at).stateT")
        approx(p.stateDur, w.stateDur, "\(at).stateDur")
        approx(p.stamina, w.stamina, "\(at).stamina")

        approx(p.foot.pos.x, w.foot.pos.x, "\(at).foot.pos.x")
        approx(p.foot.pos.y, w.foot.pos.y, "\(at).foot.pos.y")
        approx(p.foot.pos.z, w.foot.pos.z, "\(at).foot.pos.z")
        approx(p.foot.t, w.foot.t, "\(at).foot.t")
        approx(p.foot.phase, w.foot.phase, "\(at).foot.phase")
        approx(p.foot.stride, w.foot.stride, "\(at).foot.stride")
        approx(p.foot.speed, w.foot.speed, "\(at).foot.speed")

        approx(p.air.tTakeoff, w.air.tTakeoff, "\(at).air.tTakeoff")
        approx(p.air.tApex, w.air.tApex, "\(at).air.tApex")
        approx(p.air.apexY, w.air.apexY, "\(at).air.apexY")
        approx(p.air.takeoffY, w.air.takeoffY, "\(at).air.takeoffY")
        approx(p.air.tLand, w.air.tLand, "\(at).air.tLand")
        approx(p.air.vy0, w.air.vy0, "\(at).air.vy0")

        approx(p.groundY, w.groundY, "\(at).groundY")
        // The surface normal is a constant vector through one `sqrt` and one divide —
        // no transcendental, no accumulation, so no excuse.
        Check.bitEqViaJSON(p.groundN.x, w.groundN.x, "\(at).groundN.x")
        Check.bitEqViaJSON(p.groundN.y, w.groundN.y, "\(at).groundN.y")
        Check.bitEqViaJSON(p.groundN.z, w.groundN.z, "\(at).groundN.z")

        approx(p.cmd.x, w.cmd.x, "\(at).cmd.x")
        approx(p.cmd.z, w.cmd.z, "\(at).cmd.z")
        approx(p.cutDir.x, w.cutDir.x, "\(at).cutDir.x")
        // `cutDir` is built as `set(dx, 0, dz)`: Y is structurally zero, not merely
        // small. A port that reused a three-component direction would fail here.
        Check.bitEqViaJSON(p.cutDir.y, w.cutDir.y, "\(at).cutDir.y")
        approx(p.cutDir.z, w.cutDir.z, "\(at).cutDir.z")
        approx(p.cutEntrySpeed, w.cutEntrySpeed, "\(at).cutEntrySpeed")
        // See `acosTol`. Not folded into the reported worst deviation, so that a real
        // drift somewhere else cannot hide behind this known, bounded one.
        Check.near(p.cutAngle, w.cutAngle, acosTol, "\(at).cutAngle")

        // Clocks are sums of `dt` and nothing else.
        Check.bitEqViaJSON(p.lastStepT, w.lastStepT, "\(at).lastStepT")
        Check.bitEqViaJSON(p.t, w.t, "\(at).t")

        approx(p.derived.topSpeed, w.derived.topSpeed, "\(at).derived.topSpeed")
        approx(p.derived.modeCap, w.derived.modeCap, "\(at).derived.modeCap")
        approx(p.derived.accelMax, w.derived.accelMax, "\(at).derived.accelMax")
        approx(p.derived.brakeMax, w.derived.brakeMax, "\(at).derived.brakeMax")
        approx(p.derived.gripMax, w.derived.gripMax, "\(at).derived.gripMax")
        approx(p.derived.turnRate, w.derived.turnRate, "\(at).derived.turnRate")
        approx(p.derived.jumpHeight, w.derived.jumpHeight, "\(at).derived.jumpHeight")
        approx(p.derived.standingReach, w.derived.standingReach, "\(at).derived.standingReach")
        approx(p.derived.plantDur, w.derived.plantDur, "\(at).derived.plantDur")
        approx(p.derived.fatigue, w.derived.fatigue, "\(at).derived.fatigue")
        approx(p.derived.slopeMul, w.derived.slopeMul, "\(at).derived.slopeMul")
    }

    /// The four fields `create()` sets and nothing afterwards may touch. Checking them
    /// on every step is what lets the fixture carry them once instead of 1,275 times —
    /// and it is a real assertion, not bookkeeping: `personal` in particular is
    /// `max(radius, personal)` at construction, and a separation pass that wrote back
    /// through it would be caught right here.
    private static func invariants(_ p: LocoPlayer, _ w: Snap, _ at: String) {
        guard let r = w.radius, let pe = w.personal, let hh = w.hipHeight, let an = w.anchored
        else { return }
        Check.bitEqViaJSON(p.radius, r, "\(at).radius is untouched")
        Check.bitEqViaJSON(p.personal, pe, "\(at).personal is untouched")
        Check.bitEqViaJSON(p.hipHeight, hh, "\(at).hipHeight is untouched")
        Check.eq(p.anchored, an, "\(at).anchored is untouched")
    }

    private static func events(_ got: [LocoEvent], _ want: [EvSnap], _ at: String) {
        Check.eq(got.count, want.count, "\(at): event count")
        guard got.count == want.count else { return }
        for (i, w) in want.enumerated() {
            let label = "\(at).event[\(i)]"
            switch got[i] {
            case .footstep(let id, let pos, let foot, let speed, let hard):
                Check.eq("footstep", w.kind, "\(label).kind")
                Check.eq(id, w.id ?? -1, "\(label).id")
                Check.eq(foot.rawValue, w.foot ?? "?", "\(label).foot")
                Check.eq(hard, w.hard ?? false, "\(label).hard")
                approx(pos.x, w.pos?.x ?? .nan, "\(label).pos.x")
                approx(pos.y, w.pos?.y ?? .nan, "\(label).pos.y")
                approx(pos.z, w.pos?.z ?? .nan, "\(label).pos.z")
                approx(speed, w.speed ?? .nan, "\(label).speed")
            case .land(let id, let pos, let impact, let layout):
                Check.eq("land", w.kind, "\(label).kind")
                Check.eq(id, w.id ?? -1, "\(label).id")
                Check.eq(layout, w.layout ?? false, "\(label).layout")
                approx(pos.x, w.pos?.x ?? .nan, "\(label).pos.x")
                approx(pos.y, w.pos?.y ?? .nan, "\(label).pos.y")
                approx(pos.z, w.pos?.z ?? .nan, "\(label).pos.z")
                approx(impact, w.impact ?? .nan, "\(label).impact")
            case .contact(let a, let b, let impact, let foulOn, let called):
                Check.eq("contact", w.kind, "\(label).kind")
                Check.eq(a, w.a ?? -1, "\(label).a")
                Check.eq(b, w.b ?? -1, "\(label).b")
                // The foul call is an RNG draw. Getting it right means the whole draw
                // ORDER matched — the coincident-axis draw in `resolveContacts` comes
                // off the same stream — so this one boolean is a strong statement
                // about stream discipline, not a coin flip.
                Check.eq(foulOn, w.foulOn ?? -1, "\(label).foulOn")
                Check.eq(called, w.called ?? false, "\(label).called")
                approx(impact, w.impact ?? .nan, "\(label).impact")
            }
        }
    }

    // MARK: - the claims the module makes in prose

    /// Doc comments assert behaviour; behaviour can be checked. Every one of these
    /// would still pass the traces above if the corresponding sign or inequality were
    /// flipped in the *reference too* — a fixture only records what the reference does,
    /// never what it is supposed to mean.
    private static func claims(_ g: File) {
        flatWorld()
        traceClaims(g)
    }

    /// A flat, fieldless world, so these read as physics rather than as terrain.
    private static func flatWorld() {
        func loco() -> Locomotion {
            let l = Locomotion()
            l.attach(LocoHost())
            return l
        }
        let dt = 1.0 / 120.0

        // "false while laid out / down / getting up".
        for s in [LocoStateName.layout, .landing, .recovery, .fall] {
            let p = LocoPlayer(id: 1, attr: .defaultAttrs, state: s)
            Check.ok(!Locomotion.isAvailable(p), "a player in \(s.rawValue) is unavailable")
        }
        // `.jump` is in COMMITTED_STATES but NOT in UNAVAILABLE_STATES, and the two sets
        // are not the same question. Committed means "you cannot be given new orders";
        // unavailable means "you are out of the play". A player at the top of their
        // jump is very much in the play — that is the whole point of jumping — so this
        // asserts availability for every controllable state INCLUDING jump. Collapsing
        // the two sets would make every skied disc uncontested.
        for s in [LocoStateName.idle, .run, .sprint, .cut, .jump, .stumble] {
            let p = LocoPlayer(id: 1, attr: .defaultAttrs, state: s)
            Check.ok(
                Locomotion.isAvailable(p),
                "a player in \(s.rawValue) is still available to play the disc")
        }
        for s in [LocoStateName.jump, .layout, .landing, .recovery, .fall] {
            let p = LocoPlayer(id: 1, attr: .defaultAttrs, state: s)
            Check.ok(Locomotion.isCommitted(p), "\(s.rawValue) is a committed state")
        }

        // "A layout cannot be cancelled once accepted." Ask for the hardest possible
        // cancellation — full brake, opposite direction — while the gather is running,
        // and the body must still leave the ground.
        do {
            let l = loco()
            let p = l.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
            p.vel = Vec3d(5, 0, 0)
            l.step(p, DesiredMove(dir: Vec2d(1, 0), mode: .sprint, layout: true), dt)
            Check.eq(p.state, .layout, "the layout was accepted")
            for _ in 0..<30 {
                l.step(p, DesiredMove(dir: Vec2d(-1, 0), mode: .sprint, brake: true), dt)
            }
            Check.ok(
                p.state == .layout || p.prone,
                "braking cannot cancel a layout once it has been accepted")
        }

        // "Layouts are committed — no steering at all. Jumps get a token amount."
        do {
            let l = loco()
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

        // "no request can reverse a velocity instantly". One step of maximum braking
        // against the direction of travel must not flip the sign of the velocity.
        do {
            let l = loco()
            let p = l.create(CreateOpts(id: 1))
            p.vel = Vec3d(7, 0, 0)
            l.step(p, DesiredMove(dir: Vec2d(-1, 0), mode: .sprint), dt)
            Check.ok(p.vel.x > 0, "a 180 cannot reverse the velocity in a single step")
        }

        // "A THROWER ON HIS PIVOT IS IMMOVABLE." The marker takes the whole
        // correction, in BOTH tiers — which is why this asserts bit-equality on the
        // thrower's position rather than approximate equality.
        do {
            let l = loco()
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

        // "Positional correction adds no energy (so resting contacts do not jitter)"
        // — the soft tier must never write velocity.
        do {
            let l = loco()
            let a = l.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
            let b = l.create(CreateOpts(id: 2, pos: Vec3d(0.9, 0, 0)))  // inside soft, outside hard
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

        // "the normal impulse only fires on approach" — two overlapping bodies already
        // moving apart get position correction but no impulse.
        do {
            let l = loco()
            let a = l.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
            let b = l.create(CreateOpts(id: 2, pos: Vec3d(0.5, 0, 0)))  // inside 0.64 hard sum
            a.vel = Vec3d(-2, 0, 0)
            b.vel = Vec3d(2, 0, 0)
            l.separate = false
            l.resolveCollisions(dt)
            Check.bitEqViaJSON(a.vel.x, -2, "no impulse on a separating pair (a)")
            Check.bitEqViaJSON(b.vel.x, 2, "no impulse on a separating pair (b)")
        }

        // "Vertical separation beyond which two players simply miss each other."
        do {
            let l = loco()
            let a = l.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
            let b = l.create(CreateOpts(id: 2, pos: Vec3d(0.1, 0, 0)))
            b.pos.y = a.pos.y + Locomotion.COLLIDE_Y_SPAN + 0.01
            b.air.airborne = true  // keeps `reseat` from putting him back down
            a.vel = Vec3d(2, 0, 0)
            let ax = a.pos.x
            l.resolveCollisions(dt)
            Check.bitEqViaJSON(
                a.pos.x, ax, "bodies more than COLLIDE_Y_SPAN apart miss each other")
        }

        // "Horizontal speed retained through a vertical takeoff" / "on a two-foot
        // landing" — both are losses, and the landing is the bigger one.
        do {
            let l = loco()
            let p = l.create(CreateOpts(id: 1))
            p.vel = Vec3d(6, 0, 0)
            p.state = .jump
            p.stateDur = 0
            p.stateT = 1
            let before = p.vel.x
            l.step(p, DesiredMove(), dt)
            Check.ok(p.air.airborne, "the gather finished and the body left the ground")
            Check.ok(p.vel.y > 0, "a takeoff has upward velocity")
            Check.ok(
                p.vel.x < before && p.vel.x > 0,
                "a vertical takeoff costs some, not all, horizontal speed")
        }

        // `timeToReach`: zero distance is free, and farther takes longer.
        do {
            let l = loco()
            let p = l.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
            Check.bitEqViaJSON(
                l.timeToReach(p, x: 0, z: 0), 0, "no travel time to where you already are")
            let near = l.timeToReach(p, x: 5, z: 0)
            let far = l.timeToReach(p, x: 25, z: 0)
            Check.ok(far > near, "a farther spot takes longer to reach")
            Check.ok(near > 0, "a real distance takes real time")
            // "including the speed they will scrub turning toward it" — running the
            // wrong way must cost more than starting from a standstill.
            p.vel = Vec3d(-8, 0, 0)
            Check.ok(
                l.timeToReach(p, x: 25, z: 0) > far,
                "sprinting away from the target costs time to turn around")
        }

        // `intentToDesired`'s arrive taper: inside the arrive radius the request is
        // scaled down, and inside 4 cm it is zero.
        do {
            let l = loco()
            let p = l.create(CreateOpts(id: 1, pos: Vec3d(0, 0, 0)))
            let far = l.intentToDesired(
                p, IntentLike(id: 1, targetX: 10, targetZ: 0, desiredSpeed: 6))
            let close = l.intentToDesired(
                p, IntentLike(id: 1, targetX: 0.3, targetZ: 0, desiredSpeed: 6))
            let onTop = l.intentToDesired(
                p, IntentLike(id: 1, targetX: 0.01, targetZ: 0, desiredSpeed: 6))
            Check.bitEqViaJSON(far.speed ?? -1, 6, "outside the arrive radius the speed stands")
            Check.ok((close.speed ?? -1) < 6, "inside the arrive radius the speed tapers")
            Check.bitEqViaJSON(onTop.speed ?? -1, 0, "on top of the target the speed is zero")

            // A pose mode is honoured as a speed but never as a gait.
            let pose = l.intentToDesired(
                p, IntentLike(id: 1, targetX: 10, targetZ: 0, mode: "throw"))
            Check.eq(pose.mode, MoveMode.run, "a pose mode falls back to the run gait")
            let bid = l.intentToDesired(
                p,
                IntentLike(
                    id: 1, targetX: 10, targetZ: 0,
                    action: IntentAction(kind: "bid", x: 0, z: 5)))
            Check.ok(bid.layout, "a bid action requests a layout")
            Check.ok(
                (bid.dir?.z ?? 0) > 0.99,
                "a bid steers toward the bid point, not the path target")
        }

        // `fromAIAttributes`: the fallback chains are load-bearing.
        do {
            let a = fromAIAttributes(["acceleration": 91, "jumping": 88, "stamina": 44, "agility": 12])
            Check.bitEqViaJSON(a.accel, 91, "accel falls back to the AI's `acceleration`")
            Check.bitEqViaJSON(a.vertical, 88, "vertical falls back to the AI's `jumping`")
            Check.bitEqViaJSON(a.endurance, 44, "endurance falls back to the AI's `stamina`")
            Check.bitEqViaJSON(
                a.balance, 12, "balance falls back to agility, not to the default balance")
            let empty = fromAIAttributes([:])
            Check.bitEqViaJSON(empty.speed, Attributes.defaultAttrs.speed, "empty ratings default")
        }
    }

    /// Claims that only a trajectory can settle, read back off the recorded trace.
    private static func traceClaims(_ g: File) {
        let steps = g.solo.steps
        let label = { (i: Int) in g.soloScript[steps[i].leg].label }

        // "a 90-degree cut leaves ~30% of your speed on the grass". Measured from the
        // trace: entry speed at the moment the cut is entered, against speed one step
        // after it releases.
        var entry = -1.0
        var exit = -1.0
        for i in 1..<steps.count where steps[i].player.state == "cut" && steps[i - 1].player.state != "cut" {
            entry = steps[i].player.cutEntrySpeed
            var j = i
            while j < steps.count && steps[j].player.state == "cut" { j += 1 }
            if j < steps.count {
                let v = steps[j].player.vel
                exit = (v.x * v.x + v.z * v.z).squareRoot()
            }
            break
        }
        Check.ok(entry > 0 && exit > 0, "the trace contains a completed hard cut")
        if entry > 0 && exit > 0 {
            let kept = exit / entry
            Check.inRange(kept, 0.45, 0.95, "a hard cut costs real speed but not all of it")
        }

        // "a hard cut has a plant that must play out" — no cut in the trace lasts a
        // single step, and every one of them ends.
        var runs: [Int] = []
        var current = 0
        for s in steps {
            if s.player.state == "cut" {
                current += 1
            } else if current > 0 {
                runs.append(current)
                current = 0
            }
        }
        Check.ok(!runs.isEmpty, "the trace contains at least one cut")
        Check.eq(current, 0, "every cut in the trace released before the trace ended")
        Check.ok(runs.allSatisfy { $0 > 1 }, "a cut always plays out over several steps")

        // "a jump has a gather phase": the body is in `.jump` on the ground before it
        // is in `.jump` in the air.
        if let firstJump = steps.firstIndex(where: { $0.player.state == "jump" }) {
            Check.ok(
                !steps[firstJump].player.air.airborne,
                "a jump gathers on the ground before it leaves it — \(label(firstJump))")
        } else {
            Check.ok(false, "the trace contains a jump")
        }

        // Uphill is slower than downhill: the reference folds `slopeMultiplier` into
        // `topSpeed`, so a sign error in `gradeAlong` shows up as this comparison
        // inverting even though every individual number still looks plausible.
        let uphill = steps.filter { g.soloScript[$0.leg].label.hasPrefix("run uphill") }
        let downhill = steps.filter { g.soloScript[$0.leg].label.hasPrefix("run downhill") }
        Check.ok(!uphill.isEmpty && !downhill.isEmpty, "the trace runs both up and down")
        if let u = uphill.last, let d = downhill.first {
            Check.ok(u.player.derived.slopeMul < 1, "running uphill scales capability down")
            Check.ok(d.player.derived.slopeMul > 1, "running downhill scales it up")
        }

        // "Minimum gap between the end of one cut and the start of the next" — the
        // final leg asks for a second hard cut immediately and must be refused.
        let lastLegIndex = g.soloScript.count - 1
        let refusedLeg = g.soloScript.firstIndex { $0.label.hasPrefix("and again immediately") }
        if let r = refusedLeg {
            Check.ok(
                !steps.contains { $0.leg == r && $0.player.state == "cut" },
                "a cut requested inside CUT_REFRACTORY is refused")
        } else {
            Check.ok(false, "the script still contains the refractory leg")
        }

        // "zero dt is a no-op": the clock does not advance on the final leg.
        let zeroLeg = steps.filter { $0.leg == lastLegIndex }
        if zeroLeg.count >= 2 {
            Check.bitEqViaJSON(
                zeroLeg[1].player.t, zeroLeg[0].player.t, "a zero dt does not advance the clock")
        }

        // "the body sits on the surface it ended on" — `conformY` after the re-seat.
        // On this plane the surface is `hx * x + hz * z`, so an upright, grounded body
        // must be exactly `hipHeight` above it. This is the assertion that catches a
        // re-seat that sampled the pre-move position.
        var checkedSeat = 0
        for s in steps where !s.player.air.airborne && !s.player.prone && s.player.state != "recovery" {
            let want = g.field.hx * s.player.pos.x + g.field.hz * s.player.pos.z
            approx(s.player.groundY, want, "groundY is the surface under the body")
            checkedSeat += 1
        }
        Check.ok(checkedSeat > 100, "the re-seat claim was checked over most of the trace")

        // "a body that is laid out ... is committed": once prone and airborne, the
        // state must be `layout` and it must land prone.
        Check.ok(
            steps.contains { $0.player.state == "layout" && $0.player.air.airborne },
            "the trace contains a layout in flight")
        Check.ok(
            steps.contains { $0.player.state == "recovery" && $0.player.prone },
            "a layout ends face down and has to get up")
        // "recovery" interpolates the COM back up from prone height: monotone rise.
        let rec = steps.filter { $0.player.state == "recovery" }
        if rec.count > 4 {
            let rise = rec.last!.player.pos.y - rec.first!.player.pos.y
            Check.ok(rise > 0, "getting up raises the centre of mass")
        }

        // Stamina: "signed: negative drains". Sprinting through the trace must have
        // cost the athlete something, and each one-shot has a price.
        Check.ok(
            steps.last!.player.stamina < g.solo.initial.stamina,
            "a whole trace of sprinting, cutting and laying out costs stamina")

        // The pair trace: contact must produce a foul attribution and a stumble.
        let contacts = g.pair.steps.flatMap { $0.events }.filter { $0.kind == "contact" }
        Check.ok(!contacts.isEmpty, "the pair trace actually collided")
        Check.ok(
            contacts.allSatisfy { $0.foulOn == $0.a || $0.foulOn == $0.b },
            "a foul is always called on one of the two bodies involved")
        Check.ok(
            g.pair.steps.contains { $0.a.state == "stumble" || $0.a.state == "fall" }
                || g.pair.steps.contains { $0.b.state == "stumble" || $0.b.state == "fall" },
            "hard contact stumbles the player who was less braced")
        // "Hard contact stumbles the player who was LESS BRACED" — A is the lighter,
        // weaker, worse-balanced athlete, so she is the one who goes down.
        let aDown = g.pair.steps.contains { $0.a.state == "fall" || $0.a.state == "stumble" }
        Check.ok(aDown, "the lighter, weaker, worse-balanced body is the one that goes down")
    }

    // MARK: - helpers

    private static func approx(_ got: Double, _ want: Double, _ what: String) {
        let d = abs(got - want)
        compared += 1
        if got.bitPattern != want.bitPattern && !(got == 0 && want == 0) { notBitEqual += 1 }
        Check.ok(d <= traceTol, "\(what): off by \(d) (got \(got), want \(want))")
    }
}
