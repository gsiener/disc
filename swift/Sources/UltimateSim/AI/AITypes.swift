import Foundation

/// The vocabulary of the team AI. Ported from the type declarations in
/// `src/sim/AI.ts` (lines 1-652) — the player model, the world model, the intent
/// the AI hands to locomotion, and the peer interfaces it probes for.
///
/// `class TeamAI` and its supporting private state (`Mem`, `CutState`,
/// `ThrowOption`) are deliberately NOT here; they live with the decision engine.
///
/// ---------------------------------------------------------------- naming
///
/// The reference has **two** unrelated `Attributes` types and **two** unrelated
/// `MoveMode` types, in different TypeScript modules that never import each other:
///
///   - `src/sim/move/Types.ts` — nine physical ratings plus height and mass, the
///     input to the locomotion solver. Ported as `Attributes` in `Move/Types.swift`.
///   - `src/sim/AI.ts` — eleven *sporting* ratings (throw accuracy per throw type,
///     decision, defensive awareness), the input to the decision engine. That is
///     this file's `AIAttributes`.
///
///   - `src/sim/move/Types.ts`'s `MoveMode` is five gaits plus `auto`; it is what
///     the physics knows how to integrate.
///   - `src/sim/AI.ts`'s `MoveMode` is a **superset**: the same gaits plus seven
///     poses (`plant`, `pivot`, `throw`, `catch`, `jump`, `layout`, `mark`) that
///     mean "honour the speed, do not path". That is this file's `AIMoveMode`.
///
/// TypeScript keeps them apart by module; Swift has one module here, so the AI ones
/// take the `AI` prefix. `Move/LocomotionTypes.swift`'s `fromAIAttributes` is the
/// bridge that already existed between the two rating vocabularies, and it takes a
/// `[String: Double]` — see `AIAttributes.asLocomotionRatings`.
///
/// `DiscState` is likewise taken: `DiscPhysics.swift` owns the rigid-body state of
/// a disc in flight, while `AI.ts`'s `DiscState` is the *game*'s view of it (who
/// holds it, who threw it, what the stall count is). Hence `AIDiscState`.

// MARK: - throws

/// The five throws the AI knows how to select.
///
/// A separate type from `Aero/Throws.swift`'s `ThrowType`, which carries a sixth
/// case, `blade`, that `AI.ts` never names. The distinction is load-bearing rather
/// than cosmetic: `Attributes.throwAccuracy` is a `Record<ThrowType, number>` in the
/// reference — **total** over exactly these five — and keying it by the aero type
/// would make "the AI has no accuracy rating for a blade" a runtime nil instead of
/// something the compiler rejects. Use `.aero` to cross the seam.
public enum AIThrowType: String, CaseIterable, Equatable, Hashable, Decodable, Sendable {
    case backhand, forehand, hammer, scoober, push

    /// The disc-physics throw this selects. Total in this direction; the reverse is
    /// not, which is why the types are separate.
    public var aero: ThrowType {
        switch self {
        case .backhand: return .backhand
        case .forehand: return .forehand
        case .hammer: return .hammer
        case .scoober: return .scoober
        case .push: return .push
        }
    }
}

/// The reference's `THROW_TYPES`, in its declaration order.
///
/// Written out rather than delegating to `allCases` because the order is observable:
/// `TeamAI` iterates it when scoring throw options and ties break on first-seen.
public let THROW_TYPES: [AIThrowType] = [.backhand, .forehand, .hammer, .scoober, .push]

/// Per-throw release accuracy, 0..100.
///
/// A struct with five stored fields rather than a dictionary, because the reference's
/// `Record<ThrowType, number>` is total and a dictionary is not. Every read goes
/// through the subscript, so a new throw type cannot be added without the compiler
/// pointing at this file.
public struct ThrowAccuracy: Equatable, Decodable, Sendable {
    public var backhand: Double
    public var forehand: Double
    public var hammer: Double
    public var scoober: Double
    public var push: Double

    public init(
        backhand: Double, forehand: Double, hammer: Double, scoober: Double, push: Double
    ) {
        self.backhand = backhand
        self.forehand = forehand
        self.hammer = hammer
        self.scoober = scoober
        self.push = push
    }

    public subscript(_ t: AIThrowType) -> Double {
        get {
            switch t {
            case .backhand: return backhand
            case .forehand: return forehand
            case .hammer: return hammer
            case .scoober: return scoober
            case .push: return push
            }
        }
        set {
            switch t {
            case .backhand: backhand = newValue
            case .forehand: forehand = newValue
            case .hammer: hammer = newValue
            case .scoober: scoober = newValue
            case .push: push = newValue
            }
        }
    }
}

// MARK: - player model

/// Every rating is 0..100 and every one of them changes behaviour.
public struct AIAttributes: Equatable, Decodable, Sendable {
    /// Top-end sprint speed.
    public var speed: Double
    /// How fast top-end is reached; also how hard a plant can be.
    public var acceleration: Double
    /// Change of direction — turn rate, cut sharpness, layout extension.
    public var agility: Double
    public var jumping: Double
    public var catching: Double
    /// Per-throw release accuracy.
    public var throwAccuracy: ThrowAccuracy
    /// Maximum range.
    public var throwPower: Double
    /// Reads the field, values options correctly, does not force it.
    public var decision: Double
    /// Resistance to fatigue.
    public var stamina: Double
    /// Positioning, reading the disc in flight, poach timing.
    public var defAwareness: Double

    public init(
        speed: Double,
        acceleration: Double,
        agility: Double,
        jumping: Double,
        catching: Double,
        throwAccuracy: ThrowAccuracy,
        throwPower: Double,
        decision: Double,
        stamina: Double,
        defAwareness: Double
    ) {
        self.speed = speed
        self.acceleration = acceleration
        self.agility = agility
        self.jumping = jumping
        self.catching = catching
        self.throwAccuracy = throwAccuracy
        self.throwPower = throwPower
        self.decision = decision
        self.stamina = stamina
        self.defAwareness = defAwareness
    }

    /// The rating names `fromAIAttributes` in `Move/LocomotionTypes.swift` looks for.
    ///
    /// That function already existed and already spells the fallback chain
    /// (`accel` <- `acceleration`, `vertical` <- `jumping`, `endurance` <- `stamina`),
    /// so this only has to hand it the keys it reads. `catching`, `decision`,
    /// `throwPower` and `defAwareness` have no locomotion meaning and are omitted
    /// rather than mapped onto something that sounds similar.
    public var asLocomotionRatings: [String: Double] {
        [
            "speed": speed,
            "acceleration": acceleration,
            "agility": agility,
            "jumping": jumping,
            "stamina": stamina,
        ]
    }
}

public enum Archetype: String, CaseIterable, Equatable, Decodable, Sendable {
    case handler, cutter, deep, utility
}

/// The role the AI assigns at the start of each possession. A strict subset of
/// `Archetype`, and the reference declares it inline as `'handler' | 'cutter'`.
public enum PlayerRole: String, Equatable, Decodable, Sendable {
    case handler, cutter
}

/// One athlete, as the decision engine sees him.
///
/// **A class, not a struct**, for `LocoPlayer`'s reason: the reference is one
/// long-lived object per athlete whose `pos`/`vel` are written by locomotion and read
/// by the AI on the next step, and whose `energy` is integrated in place by
/// `tickStamina`. That is an identity, not a value — a struct would give every array
/// copy its own fatigue pool.
///
/// `pos` and `vel` are `Vec3d`, which IS a value: anywhere the TypeScript mutates
/// one through an alias (`p.pos.x = ...`), the port must assign the whole vector back
/// onto this class's stored property.
public final class AIPlayer {
    public var id: Int
    public var team: TeamId
    /// Written by locomotion, read by AI.
    public var pos: Vec3d
    public var vel: Vec3d
    public var attr: AIAttributes
    public var handed: Playbook.Handedness
    public var archetype: Archetype
    /// 0..1 fatigue pool. Owned by AI (see `tickStamina`).
    public var energy: Double
    /// Assigned by AI at the start of each possession.
    public var role: PlayerRole
    /// Optional, set by locomotion. The reference's `airborne?: boolean`, where
    /// "absent" and "false" are the same answer to every reader, so this is a plain
    /// `Bool` defaulting to false.
    public var airborne: Bool

    public init(
        id: Int,
        team: TeamId,
        pos: Vec3d = .zero,
        vel: Vec3d = .zero,
        attr: AIAttributes,
        handed: Playbook.Handedness = .right,
        archetype: Archetype,
        energy: Double = 1,
        role: PlayerRole,
        airborne: Bool = false
    ) {
        self.id = id
        self.team = team
        self.pos = pos
        self.vel = vel
        self.attr = attr
        self.handed = handed
        self.archetype = archetype
        self.energy = energy
        self.role = role
        self.airborne = airborne
    }
}

// MARK: - world model

public enum DiscPhase: String, Equatable, Decodable, Sendable {
    case held, flight, ground, pull
}

public enum GamePhase: String, Equatable, Decodable, Sendable {
    case setup, pull, live, dead
}

/// The game's view of the disc. See the file doc for why this is not `DiscState`.
public struct AIDiscState: Equatable, Sendable {
    public var pos: Vec3d
    public var vel: Vec3d
    public var state: DiscPhase
    /// Player currently holding it, else nil.
    public var carrier: Int?
    public var thrownBy: Int?
    public var intendedReceiver: Int?
    /// 0..10, maintained by the game system from the marker's `stall` action.
    public var stall: Double
    public var spin: Double
    public var throwType: AIThrowType?

    public init(
        pos: Vec3d = .zero,
        vel: Vec3d = .zero,
        state: DiscPhase = .ground,
        carrier: Int? = nil,
        thrownBy: Int? = nil,
        intendedReceiver: Int? = nil,
        stall: Double = 0,
        spin: Double = 0,
        throwType: AIThrowType? = nil
    ) {
        self.pos = pos
        self.vel = vel
        self.state = state
        self.carrier = carrier
        self.thrownBy = thrownBy
        self.intendedReceiver = intendedReceiver
        self.stall = stall
        self.spin = spin
        self.throwType = throwType
    }
}

/// The reference's `ctx.sys` — an untyped registry the AI duck-types every step.
///
/// `Move/LocomotionTypes.swift` made the same call for `LocoHost`: a
/// `Record<string, unknown>` whose only two documented keys are probed defensively
/// is better expressed as two optional fields than as a heterogeneous dictionary.
/// "Absent" and "present but the wrong shape" both collapse to `nil` here, which is
/// exactly what the reference's validation reduces them to.
public struct AISystems {
    public var locomotion: LocomotionPeer?
    public var disc: DiscPeer?

    public init(locomotion: LocomotionPeer? = nil, disc: DiscPeer? = nil) {
        self.locomotion = locomotion
        self.disc = disc
    }
}

public struct AIWorld {
    public var time: Double
    public var players: [AIPlayer]
    public var disc: AIDiscState
    /// Which team is on offence right now.
    public var possession: TeamId
    public var phase: GamePhase
    /// Wind velocity in m/s, field-space.
    public var wind: Vec2d
    public var score: (Int, Int)
    public var scoreCap: Int
    public var rand: Rng
    /// `ctx.sys`. Read defensively — every peer is optional.
    public var sys: AISystems?

    public init(
        time: Double = 0,
        players: [AIPlayer] = [],
        disc: AIDiscState = AIDiscState(),
        possession: TeamId = 0,
        phase: GamePhase = .setup,
        wind: Vec2d = .zero,
        score: (Int, Int) = (0, 0),
        scoreCap: Int = 15,
        rand: Rng,
        sys: AISystems? = nil
    ) {
        self.time = time
        self.players = players
        self.disc = disc
        self.possession = possession
        self.phase = phase
        self.wind = wind
        self.score = score
        self.scoreCap = scoreCap
        self.rand = rand
        self.sys = sys
    }
}

// MARK: - intents

/// What the AI asks locomotion for. A superset of `Move/Types.swift`'s `MoveMode` —
/// see the file doc.
public enum AIMoveMode: String, Equatable, Decodable, Sendable {
    case idle, jog, sprint, backpedal, shuffle
    case plant, pivot
    // `throw` and `catch` are Swift keywords; the raw values keep the wire format
    // identical to the reference's string union, which `IntentLike.mode` consumes.
    case throwPose = "throw"
    case catchPose = "catch"
    case jump, layout, mark
}

/// A one-shot event for one step, handed to the disc / game system.
public enum PlayerAction: Equatable {
    case throwDisc(
        throwType: AIThrowType,
        /// Where the disc is aimed, INCLUDING the thrower's error.
        aimX: Double, aimY: Double, aimZ: Double,
        /// Release speed (m/s) and the flight time the thrower intends.
        speed: Double, flightTime: Double, spin: Double,
        receiverId: Int,
        /// The thrower's own estimate of completion, 0..1. Telemetry / commentary.
        expected: Double)
    case catchDisc(difficulty: Double)
    case bid(x: Double, z: Double, extend: Double)
    case jump(height: Double)
    case stall(count: Double)
    case pickup
    case fake(throwType: AIThrowType)

    /// The reference's discriminant string, which the disc system switches on.
    public var kind: String {
        switch self {
        case .throwDisc: return "throw"
        case .catchDisc: return "catch"
        case .bid: return "bid"
        case .jump: return "jump"
        case .stall: return "stall"
        case .pickup: return "pickup"
        case .fake: return "fake"
        }
    }
}

/// Telemetry only; locomotion should ignore it.
public struct IntentDebug: Equatable {
    public var role: String
    public var state: String
    public var lane: Playbook.LaneKey?
    /// The point the committed cut is attacking, if any.
    public var cutX: Double
    public var cutZ: Double
    /// The kind of cut being run, if any, and the runner's depth in the column when
    /// it was offered. Which cut belongs to which position IS the vertical stack, so
    /// this is the only handle a test has on whether the shape on the field is the
    /// shape the sport plays — everything else about a cut looks identical from
    /// outside whether it came from the front or the back.
    public var cutKind: Playbook.CutKind?
    public var cutDepth: Double

    public init(
        role: String = "",
        state: String = "",
        lane: Playbook.LaneKey? = nil,
        cutX: Double = 0,
        cutZ: Double = 0,
        cutKind: Playbook.CutKind? = nil,
        cutDepth: Double = -1
    ) {
        self.role = role
        self.state = state
        self.lane = lane
        self.cutX = cutX
        self.cutZ = cutZ
        self.cutKind = cutKind
        self.cutDepth = cutDepth
    }
}

public struct PlayerIntent {
    public var id: Int
    public var team: TeamId
    public var targetX: Double
    public var targetZ: Double
    /// Unit-ish (x,z) the torso should face.
    public var faceX: Double
    public var faceZ: Double
    public var mode: AIMoveMode
    /// 0..1 fraction of `maxSpeed` wanted right now.
    public var effort: Double
    /// m/s — `maxSpeed * effort`, precomputed for locomotion.
    public var desiredSpeed: Double
    public var maxSpeed: Double
    public var maxAccel: Double
    public var maxDecel: Double
    /// rad/s
    public var turnRate: Double
    public var arriveRadius: Double
    public var personalSpace: Double
    public var action: PlayerAction?
    public var debug: IntentDebug

    public init(
        id: Int,
        team: TeamId,
        targetX: Double = 0,
        targetZ: Double = 0,
        faceX: Double = 0,
        faceZ: Double = 1,
        mode: AIMoveMode = .idle,
        effort: Double = 0,
        desiredSpeed: Double = 0,
        maxSpeed: Double = 0,
        maxAccel: Double = 0,
        maxDecel: Double = 0,
        turnRate: Double = 0,
        arriveRadius: Double = 0,
        personalSpace: Double = 0,
        action: PlayerAction? = nil,
        debug: IntentDebug = IntentDebug()
    ) {
        self.id = id
        self.team = team
        self.targetX = targetX
        self.targetZ = targetZ
        self.faceX = faceX
        self.faceZ = faceZ
        self.mode = mode
        self.effort = effort
        self.desiredSpeed = desiredSpeed
        self.maxSpeed = maxSpeed
        self.maxAccel = maxAccel
        self.maxDecel = maxDecel
        self.turnRate = turnRate
        self.arriveRadius = arriveRadius
        self.personalSpace = personalSpace
        self.action = action
        self.debug = debug
    }
}

// MARK: - system peers

/// One sample of a predicted flight. `t` is seconds FROM NOW.
public struct FlightSample: Equatable, Decodable, Sendable {
    public var t: Double
    public var x: Double
    public var y: Double
    public var z: Double

    public init(t: Double, x: Double, y: Double, z: Double) {
        self.t = t
        self.x = x
        self.y = y
        self.z = z
    }
}

/// Optional services locomotion MAY expose. Modelled as optional closures rather
/// than a protocol with optional requirements, matching `LocoHost.events`: the
/// reference declares both members with `?`, and the AI checks `typeof === 'function'`
/// before every call.
public struct LocomotionPeer {
    /// Seconds to reach (x, z), including turn cost.
    public var timeToReach: ((AIPlayer, Double, Double) -> Double)?
    public var isAirborne: ((AIPlayer) -> Bool)?

    public init(
        timeToReach: ((AIPlayer, Double, Double) -> Double)? = nil,
        isAirborne: ((AIPlayer) -> Bool)? = nil
    ) {
        self.timeToReach = timeToReach
        self.isAirborne = isAirborne
    }
}

/// The optional service the disc system MAY expose: `predictPath(state, horizon, step)`.
///
/// The reference *probes* this rather than trusting it — a sibling module may expose a
/// `predictPath` with an entirely different signature, and calling it blind returns
/// NaN. Swift's type system does the validation the reference does at runtime, so the
/// `DISC_PEER_OK` WeakMap and `validFlightSamples` have no port; what survives is the
/// "may be absent" half, which is the optional closure.
public struct DiscPeer {
    public var predictPath: ((AIDiscState, Double, Double) -> [FlightSample])?

    public init(predictPath: ((AIDiscState, Double, Double) -> [FlightSample])? = nil) {
        self.predictPath = predictPath
    }
}

// MARK: - team config

public struct TeamConfig: Equatable, Sendable {
    /// Base offensive look.
    public var formation: Playbook.FormationName
    /// Base defensive call.
    public var force: Playbook.Force
    /// -0.4..0.4 — how much this team likes zone regardless of conditions.
    public var zoneBias: Double
    /// 0.6 (conservative) .. 1.6 (gunner) — scales willingness to take risk.
    public var aggression: Double
    /// Deterministic seed salt.
    public var seed: Int

    public init(
        formation: Playbook.FormationName,
        force: Playbook.Force,
        zoneBias: Double,
        aggression: Double,
        seed: Int
    ) {
        self.formation = formation
        self.force = force
        self.zoneBias = zoneBias
        self.aggression = aggression
        self.seed = seed
    }
}

public let DEFAULT_TEAM_CONFIG = TeamConfig(
    formation: .vertical, force: .forehand, zoneBias: -0.15, aggression: 1.0, seed: 1
)
