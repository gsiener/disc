import Foundation

/// The input, output and interop vocabulary of `Locomotion`. Ported from the
/// interface declarations at the top of `src/sim/Locomotion.ts` plus `DesiredMove`
/// from `src/sim/move/Types.ts`.
///
/// The reference leans on structural typing in three places, and each one becomes a
/// concrete type here:
///
///   - `LocoHost` is `{events?, rand?, sys?}` and `sys` is an untyped registry the
///     ground and disc probes duck-type every step. Swift already has `FieldLike?`
///     and `DiscRuntimeInfo?` for exactly that "may not exist" contract, so the host
///     carries those directly instead of a `Record<string, unknown>`.
///   - events are emitted as `emit(name, payload)` with an untyped payload. Here they
///     are a closed enum, the same choice `GameState` makes for `GameEvent`.
///   - `DesiredMove.dir`/`face` are `THREE.Vector3 | Vec2Like | null`. Only `.x` and
///     `.z` are ever read off either, so both collapse to `Vec2d?`.

/// The AI system's per-frame movement request. Every field is optional; a default
/// `DesiredMove()` means "stand still, keep facing".
public struct DesiredMove {
    /// Desired travel direction in world XZ. Need not be normalised.
    public var dir: Vec2d?
    /// Absolute target ground speed (m/s). Clamped to the mode cap.
    public var speed: Double?
    /// Fraction of the mode cap, used when `speed` is omitted. Default 1.
    public var effort: Double?
    /// Extra hard ceiling on ground speed (m/s) for this step.
    public var maxSpeed: Double?
    /// Gait selection. `.auto` derives it from `dir` vs `face`. Default `.auto`.
    public var mode: MoveMode?
    /// Where the player wants to look. Defaults to the travel direction.
    public var face: Vec2d?
    /// Request a vertical leap. Ignored unless grounded and controllable.
    public var jump: Bool
    /// Request a layout. Committed the moment it is accepted.
    public var layout: Bool
    /// Hard stop — overrides `speed` to 0 and uses full braking.
    public var brake: Bool

    public init(
        dir: Vec2d? = nil,
        speed: Double? = nil,
        effort: Double? = nil,
        maxSpeed: Double? = nil,
        mode: MoveMode? = nil,
        face: Vec2d? = nil,
        jump: Bool = false,
        layout: Bool = false,
        brake: Bool = false
    ) {
        self.dir = dir
        self.speed = speed
        self.effort = effort
        self.maxSpeed = maxSpeed
        self.mode = mode
        self.face = face
        self.jump = jump
        self.layout = layout
        self.brake = brake
    }
}

/// What the model tells the rest of the game about.
///
/// The reference emits `'player:footstep'`, `'player:land'` and `'player:contact'`
/// with object payloads. The payload of `player:footstep` is deliberately a *copy* of
/// the plant point there (`V3A.set(...).clone()`), because `V3A` is a module-level
/// scratch vector that the next footstep overwrites; `Vec3d` is a value type, so the
/// copy is structural rather than something the port has to remember to do.
public enum LocoEvent: Equatable {
    case footstep(id: Int, pos: Vec3d, foot: Foot, speed: Double, hard: Bool)
    case land(id: Int, pos: Vec3d, impact: Double, layout: Bool)
    /// `foulOn` is the id of whichever body was closing harder — the one who ran into
    /// the other. `called` is the deterministic RNG draw against `foulChance`.
    case contact(a: Int, b: Int, impact: Double, foulOn: Int, called: Bool)
}

/// Everything `Locomotion` needs from the engine around it.
public struct LocoHost {
    public var events: ((LocoEvent) -> Void)?
    /// Parent stream. When present, `attach` forks it with salt `0x10c0` so adding a
    /// draw elsewhere in the game cannot shift locomotion's decisions.
    public var rand: Rng?
    /// The terrain, if a field system exists yet.
    public var field: FieldLike?
    /// The disc, if a disc runtime exists yet. Read once per separation pass.
    public var disc: DiscRuntimeInfo?

    public init(
        events: ((LocoEvent) -> Void)? = nil,
        rand: Rng? = nil,
        field: FieldLike? = nil,
        disc: DiscRuntimeInfo? = nil
    ) {
        self.events = events
        self.rand = rand
        self.field = field
        self.disc = disc
    }
}

/// Roster entry. `attr` is a whole `Attributes` rather than the reference's
/// `Partial<Attributes>`: the merge `{...DEFAULT_ATTRS, ...opts.attr}` has no Swift
/// equivalent that is worth the machinery, so a caller who wants two ratings changed
/// starts from `.defaultAttrs` and assigns them. Passing `nil` is the same as
/// passing `.defaultAttrs`, matching the reference's `opts.attr ?? {}`.
public struct CreateOpts {
    public var id: Int
    public var team: Int
    public var attr: Attributes?
    public var pos: Vec3d?
    public var facing: Double?
    public var stamina: Double?
    /// Hard-contact radius (m).
    public var radius: Double?
    /// Soft personal-space radius (m); clamped to at least `radius`.
    public var personal: Double?

    public init(
        id: Int,
        team: Int = 0,
        attr: Attributes? = nil,
        pos: Vec3d? = nil,
        facing: Double? = nil,
        stamina: Double? = nil,
        radius: Double? = nil,
        personal: Double? = nil
    ) {
        self.id = id
        self.team = team
        self.attr = attr
        self.pos = pos
        self.facing = facing
        self.stamina = stamina
        self.radius = radius
        self.personal = personal
    }
}

// MARK: - AI interop

/// One action attached to an intent. The reference's `{kind, x?, z?}`.
public struct IntentAction: Equatable {
    public var kind: String
    public var x: Double?
    public var z: Double?
    public init(kind: String, x: Double? = nil, z: Double? = nil) {
        self.kind = kind
        self.x = x
        self.z = z
    }
}

/// The AI system's `PlayerIntent`, mirrored structurally rather than imported so the
/// two modules stay independently authorable. Every field is optional.
///
/// `mode` stays a `String` and not a `MoveMode`: the AI vocabulary is a *superset* of
/// ours (it includes poses like `throw` and `mark`, and the one-shots `jump` and
/// `layout`), and `intentToDesired` is the thing that narrows it.
public struct IntentLike {
    public var id: Int
    public var targetX: Double?
    public var targetZ: Double?
    public var faceX: Double?
    public var faceZ: Double?
    public var mode: String?
    public var effort: Double?
    public var desiredSpeed: Double?
    public var maxSpeed: Double?
    public var arriveRadius: Double?
    public var action: IntentAction?

    public init(
        id: Int,
        targetX: Double? = nil,
        targetZ: Double? = nil,
        faceX: Double? = nil,
        faceZ: Double? = nil,
        mode: String? = nil,
        effort: Double? = nil,
        desiredSpeed: Double? = nil,
        maxSpeed: Double? = nil,
        arriveRadius: Double? = nil,
        action: IntentAction? = nil
    ) {
        self.id = id
        self.targetX = targetX
        self.targetZ = targetZ
        self.faceX = faceX
        self.faceZ = faceZ
        self.mode = mode
        self.effort = effort
        self.desiredSpeed = desiredSpeed
        self.maxSpeed = maxSpeed
        self.arriveRadius = arriveRadius
        self.action = action
    }
}

/// A plain `{id, pos, vel, airborne}` record the AI owns, which `syncTo` writes back
/// onto. The reference mutates the caller's objects in place; a struct array needs
/// `inout` to do the same thing.
public struct WorldPlayerRecord {
    public var id: Int
    public var pos: Vec3d?
    public var vel: Vec3d?
    public var airborne: Bool

    public init(id: Int, pos: Vec3d? = nil, vel: Vec3d? = nil, airborne: Bool = false) {
        self.id = id
        self.pos = pos
        self.vel = vel
        self.airborne = airborne
    }
}

/// A foreign player record handed to `timeToReach` by the AI. `attr` is the AI's own
/// rating vocabulary, keyed by name — see `fromAIAttributes`.
public struct AthleteLike {
    public var id: Int?
    public var posX: Double?
    public var posZ: Double?
    public var velX: Double?
    public var velZ: Double?
    public var attr: [String: Double]?

    public init(
        id: Int? = nil,
        posX: Double? = nil,
        posZ: Double? = nil,
        velX: Double? = nil,
        velZ: Double? = nil,
        attr: [String: Double]? = nil
    ) {
        self.id = id
        self.posX = posX
        self.posZ = posZ
        self.velX = velX
        self.velZ = velZ
        self.attr = attr
    }
}

/// AI `mode` values that are poses rather than gaits — honour speed, do not path.
let POSE_MODES: Set<String> = ["plant", "pivot", "throw", "catch", "mark", "idle"]

/// Translate the AI system's rating vocabulary (speed/acceleration/agility/jumping/
/// stamina) into ours. Anything missing falls back to `DEFAULT_ATTRS`.
///
/// The fallback chains matter and are ported literally: `accel` falls back to
/// `acceleration` before the default, `vertical` to `jumping`, `endurance` to
/// `stamina`, and `balance` to whatever `agility` resolved to — *not* to
/// `DEFAULT_ATTRS.balance`. Collapsing that last one would make a low-agility AI
/// athlete unexpectedly hard to knock over.
public func fromAIAttributes(
    _ a: [String: Double], height: Double = 1.83, mass: Double = 82
) -> Attributes {
    func num(_ k: String, _ d: Double) -> Double { a[k] ?? d }
    let agility = num("agility", Attributes.defaultAttrs.agility)
    return Attributes(
        speed: num("speed", Attributes.defaultAttrs.speed),
        accel: num("accel", num("acceleration", Attributes.defaultAttrs.accel)),
        agility: agility,
        strength: num("strength", Attributes.defaultAttrs.strength),
        vertical: num("vertical", num("jumping", Attributes.defaultAttrs.vertical)),
        endurance: num("endurance", num("stamina", Attributes.defaultAttrs.endurance)),
        balance: num("balance", agility),
        height: num("height", height),
        mass: num("mass", mass)
    )
}
