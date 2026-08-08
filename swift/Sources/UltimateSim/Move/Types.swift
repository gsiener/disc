import Foundation

/// Shared vocabulary for the locomotion model. Ported from `src/sim/move/Types.ts`.
///
/// This started as a **partial** port covering only the fields the five leaf
/// modules under `Move/` (`Attributes`, `Gait`, `Separation`, `Contest`, `Ground`)
/// read or write. `Locomotion.swift` needs the rest — cut state, the state-machine
/// timers, stamina, the surface normal, the footstep-audio debounce and the
/// `derived` debug cache — so those are now here too, and `LocoPlayer` matches the
/// reference interface field for field.
///
/// Every field added for `Locomotion` carries a default and is appended to the end
/// of the initialiser, so the leaf-module call sites that predate it still read the
/// same. `DesiredMove` lives in `Locomotion.swift` alongside the only code that
/// consumes it.

/// Gait selection. `auto` derives the resolved mode from input elsewhere; the
/// five leaf modules only ever see the resolved cases.
public enum MoveMode: String, Equatable, Sendable {
    case auto, sprint, run, jog, backpedal, shuffle
}

public enum LocoStateName: String, Equatable, Sendable {
    // grounded, under control
    case idle, jog, run, sprint, backpedal, shuffle, cut
    // airborne
    case jump, layout
    // not under control
    case landing, recovery, fall, stumble
}

/// States in which the player cannot be given new movement orders.
public let committedStates: Set<LocoStateName> = [.jump, .layout, .landing, .recovery, .fall]

/// States in which the player is effectively out of the play.
public let unavailableStates: Set<LocoStateName> = [.layout, .landing, .recovery, .fall]

/// Raw player ratings, 0..100 (Madden-style). `height` is metres and `mass` is
/// kilograms — those two are physical, not ratings.
public struct Attributes: Equatable, Decodable, Sendable {
    /// Top-end straight-line speed.
    public var speed: Double
    /// Burst / how fast top speed is reached, and how hard they can brake.
    public var accel: Double
    /// Lateral grip, cut sharpness, plant duration, turn rate.
    public var agility: Double
    /// Wins contact, resists being moved, boxes out.
    public var strength: Double
    /// Vertical leap.
    public var vertical: Double
    /// Stamina pool drain/recovery rate.
    public var endurance: Double
    /// Resists stumbling and falling on contact; shortens get-ups.
    public var balance: Double
    /// Metres.
    public var height: Double
    /// Kilograms.
    public var mass: Double

    public init(
        speed: Double, accel: Double, agility: Double, strength: Double,
        vertical: Double, endurance: Double, balance: Double,
        height: Double, mass: Double
    ) {
        self.speed = speed
        self.accel = accel
        self.agility = agility
        self.strength = strength
        self.vertical = vertical
        self.endurance = endurance
        self.balance = balance
        self.height = height
        self.mass = mass
    }

    public static let defaultAttrs = Attributes(
        speed: 70, accel: 70, agility: 70, strength: 60,
        vertical: 65, endurance: 70, balance: 70,
        height: 1.83, mass: 82
    )
}

/// Everything the physics step actually reads, after ratings + fatigue + slope.
public struct Derived: Equatable, Decodable, Sendable {
    /// Flat-out sprint cap (m/s), fatigue applied.
    public var topSpeed: Double
    /// Cap for the currently selected movement mode (m/s).
    public var modeCap: Double
    /// Peak propulsive acceleration at v=0 (m/s^2).
    public var accelMax: Double
    /// Peak braking acceleration (m/s^2).
    public var brakeMax: Double
    /// Peak lateral (turning) acceleration (m/s^2).
    public var gripMax: Double
    /// Max yaw rate (rad/s) at the current speed.
    public var turnRate: Double
    /// Standing vertical leap (m).
    public var jumpHeight: Double
    /// Fingertip height when standing flat-footed (m).
    public var standingReach: Double
    /// Duration of a hard-cut foot plant (s).
    public var plantDur: Double
    /// 0 = fresh, 1 = cooked.
    public var fatigue: Double
    /// Multiplier already folded into topSpeed, exposed for HUD/debug.
    public var slopeMul: Double

    public init(
        topSpeed: Double, modeCap: Double, accelMax: Double, brakeMax: Double,
        gripMax: Double, turnRate: Double, jumpHeight: Double, standingReach: Double,
        plantDur: Double, fatigue: Double, slopeMul: Double
    ) {
        self.topSpeed = topSpeed
        self.modeCap = modeCap
        self.accelMax = accelMax
        self.brakeMax = brakeMax
        self.gripMax = gripMax
        self.turnRate = turnRate
        self.jumpHeight = jumpHeight
        self.standingReach = standingReach
        self.plantDur = plantDur
        self.fatigue = fatigue
        self.slopeMul = slopeMul
    }

    /// All-zero placeholder, for the one field on `LocoPlayer` the reference leaves
    /// uninitialised until the first `solveGround` overwrites it. The reference's
    /// `create()` seeds it with a real `derive()` call; this exists only so
    /// `LocoPlayer.init` has a default and a hand-built test player does not have to
    /// invent eleven numbers it will never read.
    public static let zero = Derived(
        topSpeed: 0, modeCap: 0, accelMax: 0, brakeMax: 0, gripMax: 0, turnRate: 0,
        jumpHeight: 0, standingReach: 0, plantDur: 0, fatigue: 0, slopeMul: 0
    )
}

/// Plain XZ pair — the ground-plane commands and axes `Separation` and `Gait`
/// work with never touch Y, so they use this rather than `Vec3d`.
public struct Vec2d: Equatable, Sendable {
    public var x: Double
    public var z: Double
    public init(_ x: Double = 0, _ z: Double = 0) {
        self.x = x
        self.z = z
    }
    public static let zero = Vec2d(0, 0)
}

public enum Foot: String, Equatable, Sendable {
    case left = "L"
    case right = "R"
}

public struct FootState {
    /// Which foot most recently planted.
    public var planted: Foot
    /// World position of that plant — animation IK target, turf scuff origin.
    public var pos: Vec3d
    /// Sim time at which it planted.
    public var t: Double
    /// True while that foot is still bearing load (stance phase).
    public var contact: Bool
    /// 0..1 through the current stride.
    public var phase: Double
    /// Stride length used for the current step (m).
    public var stride: Double
    /// True when this plant is the pivot of a hard cut.
    public var hard: Bool
    /// Speed at the moment of the plant (m/s) — audio uses this for weight.
    public var speed: Double

    public init(
        planted: Foot = .left, pos: Vec3d = .zero, t: Double = 0, contact: Bool = false,
        phase: Double = 0, stride: Double = 0, hard: Bool = false, speed: Double = 0
    ) {
        self.planted = planted
        self.pos = pos
        self.t = t
        self.contact = contact
        self.phase = phase
        self.stride = stride
        self.hard = hard
        self.speed = speed
    }
}

public struct AirState {
    /// True while the centre of mass is off the ground.
    public var airborne: Bool
    /// Sim time of takeoff.
    public var tTakeoff: Double
    /// Sim time the ballistic arc peaks.
    public var tApex: Double
    /// Predicted peak COM height (world Y).
    public var apexY: Double
    /// COM height at takeoff (world Y).
    public var takeoffY: Double
    /// Predicted sim time of ground contact.
    public var tLand: Double
    /// Vertical velocity at takeoff (m/s).
    public var vy0: Double

    public init(
        airborne: Bool = false, tTakeoff: Double = 0, tApex: Double = 0, apexY: Double = 0,
        takeoffY: Double = 0, tLand: Double = 0, vy0: Double = 0
    ) {
        self.airborne = airborne
        self.tTakeoff = tTakeoff
        self.tApex = tApex
        self.apexY = apexY
        self.takeoffY = takeoffY
        self.tLand = tLand
        self.vy0 = vy0
    }
}

/// A player in the locomotion model.
///
/// **This is a class, not a struct**, matching `Rng`'s rationale rather than
/// `Vec3d`'s: the reference is one long-lived JS object per athlete, mutated in
/// place by independent systems every frame (gait advances the foot plant,
/// separation nudges position, contests read velocity) — an identity, not a
/// value. `pos`/`vel`/`foot.pos` are `Vec3d`, so any place that reads like the
/// TypeScript mutating a `THREE.Vector3` through an alias (`f.pos.set(...)`,
/// `out.copy(...)`) must become an explicit assignment on this class's stored
/// property instead — the value-vs-reference bug class the whole port watches for.
public final class LocoPlayer {
    public var id: Int
    public var attr: Attributes

    /// World position of the centre of mass. Y is hip height above the surface.
    public var pos: Vec3d
    /// World velocity. XZ is ground plane, Y only meaningful when airborne.
    public var vel: Vec3d
    /// Yaw in radians, 0 = +Z, increasing toward +X.
    public var facing: Double

    public var state: LocoStateName
    /// Seconds spent in the current state.
    public var stateT: Double
    /// Seconds the current state must run before it can end (committed states).
    public var stateDur: Double
    /// True while the body is on the ground rather than upright.
    public var prone: Bool
    /// True while this body is a thrower standing on an established pivot.
    public var anchored: Bool

    public var foot: FootState
    public var air: AirState

    /// Surface height under the player's feet this step.
    public var groundY: Double
    /// Surface normal under the player's feet this step.
    ///
    /// The reference keeps a `THREE.Vector3` here and writes into it with
    /// `p.groundN.copy(SURF.n)` from a module-level scratch surface. `Vec3d` is a
    /// value, so the port assigns instead — which is also why the scratch object can
    /// go away entirely.
    public var groundN: Vec3d

    /// Which side. Carried for the consumers; the movement solve never reads it.
    public var team: Int

    /// 0..100.
    public var stamina: Double

    /// Direction the cut is pivoting toward, valid while `state == .cut`.
    public var cutDir: Vec3d
    /// Entry speed of the current/last cut (m/s).
    public var cutEntrySpeed: Double
    /// Turn angle of the current/last cut (radians).
    public var cutAngle: Double

    /// Sim time this player last emitted a footstep — debounce for audio.
    public var lastStepT: Double

    /// Scratch: last step's derived capabilities, for debug/HUD.
    public var derived: Derived

    /// Hard-contact radius (m) — the volume no other body may enter.
    public var radius: Double
    /// Soft "personal space" radius (m). Always >= `radius`.
    public var personal: Double
    /// Hip height when standing (m).
    public var hipHeight: Double

    /// Unit XZ direction this player was commanded to travel on the most recent
    /// step, or (0,0) if they were given none.
    public var cmd: Vec2d

    /// Monotonic per-player sim clock (seconds).
    public var t: Double

    public init(
        id: Int,
        attr: Attributes,
        pos: Vec3d = .zero,
        vel: Vec3d = .zero,
        facing: Double = 0,
        state: LocoStateName = .idle,
        prone: Bool = false,
        anchored: Bool = false,
        foot: FootState = FootState(),
        air: AirState = AirState(),
        groundY: Double = 0,
        radius: Double = 0.32,
        personal: Double = 0.63,
        hipHeight: Double = 0.9,
        cmd: Vec2d = .zero,
        t: Double = 0,
        // Appended for the `Locomotion` port. Order matters: putting these last keeps
        // every leaf-module call site that predates them compiling unchanged.
        team: Int = 0,
        stateT: Double = 0,
        stateDur: Double = 0,
        stamina: Double = 100,
        groundN: Vec3d = Vec3d(0, 1, 0),
        cutDir: Vec3d = .zero,
        cutEntrySpeed: Double = 0,
        cutAngle: Double = 0,
        lastStepT: Double = 0,
        derived: Derived = .zero
    ) {
        self.id = id
        self.attr = attr
        self.pos = pos
        self.vel = vel
        self.facing = facing
        self.state = state
        self.stateT = stateT
        self.stateDur = stateDur
        self.prone = prone
        self.anchored = anchored
        self.foot = foot
        self.air = air
        self.groundY = groundY
        self.groundN = groundN
        self.team = team
        self.stamina = stamina
        self.cutDir = cutDir
        self.cutEntrySpeed = cutEntrySpeed
        self.cutAngle = cutAngle
        self.lastStepT = lastStepT
        self.derived = derived
        self.radius = radius
        self.personal = personal
        self.hipHeight = hipHeight
        self.cmd = cmd
        self.t = t
    }
}
