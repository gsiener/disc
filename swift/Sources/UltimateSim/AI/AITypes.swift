import Foundation

/// The AI's own view of a player, ported from the first half of `src/sim/AI.ts`.
///
/// **There are two `Attributes` in this project and that is the reference's doing, not
/// a porting accident.** `Move/Types.swift` has one — nine physical ratings plus a mass
/// and a height, which is what the locomotion model integrates. This file has the other:
/// twelve ratings including per-throw accuracy, decision-making and defensive awareness,
/// which is what the AI reasons with. They overlap on speed and agility and disagree on
/// everything else.
///
/// TypeScript let both be called `Attributes` because they live in different modules.
/// Swift has one namespace per module, so the AI's is `AIAttributes` and the locomotion
/// one keeps the plain name — it is the one the physics uses, and it is the one that
/// already appears in 9,018 assertions. `Move/LocomotionTypes.swift` holds
/// `fromAIAttributes`, which is the only place the two meet.
///
/// The same reasoning applies to `AIMoveMode`: `Move/Types.swift` already has a
/// `MoveMode` with three cases that the gait model switches on, and the AI's has more.

// MARK: - throws

/// The throws the AI will choose between.
///
/// Deliberately five, where `Aero/Throws.swift` has six — the AI never selects a blade.
/// That is the reference's choice and not an omission here: a blade is a specialty throw
/// whose whole point is beating a mark in a way the decision model does not represent.
public enum AIThrowType: String, CaseIterable, Equatable, Decodable, Sendable {
    case backhand, forehand, hammer, scoober, push
}

/// The reference exports this as an ordered array and iterates it. Order is behaviour
/// wherever a tie is broken by first-wins, so it is preserved rather than left to
/// `CaseIterable`.
public let AI_THROW_TYPES: [AIThrowType] = [.backhand, .forehand, .hammer, .scoober, .push]

// MARK: - attributes

/// Every rating is 0…100 and every one of them changes behaviour.
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
    public var throwAccuracy: [AIThrowType: Double]
    /// Maximum range.
    public var throwPower: Double
    /// Reads the field, values options correctly, does not force it.
    public var decision: Double
    /// Resistance to fatigue.
    public var stamina: Double
    /// Positioning, reading the disc in flight, poach timing.
    public var defAwareness: Double

    public init(
        speed: Double, acceleration: Double, agility: Double, jumping: Double,
        catching: Double, throwAccuracy: [AIThrowType: Double], throwPower: Double,
        decision: Double, stamina: Double, defAwareness: Double
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
}

public enum Archetype: String, CaseIterable, Equatable, Decodable, Sendable {
    case handler, cutter, deep, utility
}

/// What a player is doing on this possession. Distinct from `Archetype`, which is what
/// they are: a deep can be handling and often is after a turn.
public enum PlayerRole: String, Equatable, Decodable, Sendable {
    case handler, cutter
}

/// A player as the AI sees one.
///
/// A **class**, matching `LocoPlayer`'s reasoning rather than `Vec3d`'s: the reference is
/// one long-lived object per athlete, written by locomotion and read by the AI within the
/// same frame. `tickStamina` mutates `energy` in place, and a value type would make that
/// silently do nothing at every call site that did not write the result back.
public final class AIPlayer {
    public var id: Int
    public var team: TeamId
    /// Written by locomotion, read by AI.
    public var pos: Vec3d
    public var vel: Vec3d
    public var attr: AIAttributes
    public var handed: Playbook.Handedness
    public var archetype: Archetype
    /// 0…1 fatigue pool. Owned by the AI — see `tickStamina`.
    public var energy: Double
    /// Assigned by the AI at the start of each possession.
    public var role: PlayerRole
    /// Optional in the reference, set by locomotion.
    public var airborne: Bool

    public init(
        id: Int, team: TeamId, pos: Vec3d = .zero, vel: Vec3d = .zero,
        attr: AIAttributes, handed: Playbook.Handedness = .right,
        archetype: Archetype, energy: Double = 1, role: PlayerRole = .cutter,
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

// MARK: - team configuration

public struct TeamConfig: Equatable, Sendable {
    /// Base offensive look.
    public var formation: Playbook.FormationName
    /// Base defensive call.
    public var force: Playbook.Force
    /// −0.4…0.4 — how much this team likes zone regardless of conditions.
    public var zoneBias: Double
    /// 0.6 (conservative) … 1.6 (gunner) — scales willingness to take risk.
    public var aggression: Double
    /// Deterministic seed salt.
    public var seed: Int

    public init(
        formation: Playbook.FormationName, force: Playbook.Force,
        zoneBias: Double, aggression: Double, seed: Int
    ) {
        self.formation = formation
        self.force = force
        self.zoneBias = zoneBias
        self.aggression = aggression
        self.seed = seed
    }
}

// MARK: - world model

/// The disc as the AI sees it. Distinct from `DiscState` in `DiscPhysics.swift`, which is
/// the integrated flight state — this one is the *game's* view: who threw it, who it is
/// meant for, what the count is. The physics one is named `DiscState` because it was here
/// first and is the one the flight suites assert; this is `AIDiscState`.
public struct AIDiscState: Equatable, Sendable {
    public var pos: Vec3d
    public var vel: Vec3d
    public var state: DiscPhase
    /// Player currently holding it, else nil.
    public var carrier: Int?
    public var thrownBy: Int?
    public var intendedReceiver: Int?
    /// 0…10, maintained by the game system from the marker's `stall` action.
    public var stall: Double
    public var spin: Double
    public var throwType: AIThrowType?

    public init(
        pos: Vec3d = .zero, vel: Vec3d = .zero, state: DiscPhase = .ground,
        carrier: Int? = nil, thrownBy: Int? = nil, intendedReceiver: Int? = nil,
        stall: Double = 0, spin: Double = 0, throwType: AIThrowType? = nil
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

/// The call a team's defence is running. Hoisted to module scope (rather than nested in
/// `TeamAI`, where the reference's ad hoc `'person' | 'zone'` union lived before this) so
/// `AIWorld.scheme` below — the channel that lets the offence read the opposing team's
/// already-decided call — can reference it without reaching into `TeamAI` internals.
public enum DefenceScheme: String, Equatable, Sendable {
    case person
    case zone
}

/// Everything one AI update sees.
///
/// The reference carries a `sys` bag of duck-typed peers read defensively. Here the two
/// peers it actually looks for are typed optionals, matching how `Ground.swift` and
/// `Separation.swift` already handle the same pattern — a dictionary of `Any` is not
/// portable to a language that checks types, and the defensive reads existed only because
/// it was.
public struct AIWorld {
    public var time: Double
    public var players: [AIPlayer]
    public var disc: AIDiscState
    /// Which team is on offence right now.
    public var possession: TeamId
    public var phase: GamePhase
    /// Wind velocity in m/s, field space.
    public var wind: Vec2d
    public var score: [Int]
    public var scoreCap: Int
    public var rand: Rng
    /// The pitch. A value rather than the reference's module constant, for the reason
    /// recorded throughout this port: this game runs on two of them.
    public var field: FieldConstants
    public var locomotion: LocomotionPeer?
    public var discPeer: DiscPeer?
    /// Each team's most recently CALLED defensive scheme, indexed by `TeamId` — see the
    /// reference's `AIWorld.scheme` (src/sim/AI.ts) for why this exists: it is the one
    /// channel `chooseFormation` has to know a zone is coming, rather than inferring it
    /// from the same wind reading the defence used. `Engine.buildWorld` fills this from
    /// each `TeamAI`'s own persistent `currentScheme` (not reset per tick the way the rest
    /// of `AIWorld` is), since the struct itself is rebuilt fresh every tick.
    public var scheme: [DefenceScheme]

    public init(
        time: Double = 0, players: [AIPlayer] = [], disc: AIDiscState = AIDiscState(),
        possession: TeamId = 0, phase: GamePhase = .setup, wind: Vec2d = .zero,
        score: [Int] = [0, 0], scoreCap: Int = 15, rand: Rng = Rng(),
        field: FieldConstants = .standard,
        locomotion: LocomotionPeer? = nil, discPeer: DiscPeer? = nil,
        scheme: [DefenceScheme] = [.person, .person]
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
        self.field = field
        self.locomotion = locomotion
        self.discPeer = discPeer
        self.scheme = scheme
    }
}

// MARK: - intents

/// What the body is being asked to do. `Move/Types.swift` has a three-case `MoveMode` the
/// gait model switches on; this is the AI's larger vocabulary, and the two are different
/// alphabets rather than one split in half.
public enum AIMoveMode: String, Equatable, Sendable {
    case idle, jog, sprint, backpedal, shuffle
    case plant, pivot, `throw`, `catch`, jump, layout, mark
}

/// The discrete thing a player is doing this frame, if anything.
public enum PlayerAction: Equatable, Sendable {
    case `throw`(
        throwType: AIThrowType,
        /// Where the disc is aimed, **including** the thrower's error.
        aim: Vec3d,
        /// Release speed in m/s and the flight time the thrower intends.
        speed: Double, flightTime: Double, spin: Double,
        receiverId: Int,
        /// The thrower's own estimate of completion, 0…1. Telemetry and commentary.
        expected: Double)
    case `catch`(difficulty: Double)
    /// A dive at a point. **Only the point**: how far the diver extends is not carried,
    /// because nothing downstream can honour it. `Locomotion` gives every layout the same
    /// extension and `CatchDecision` pays out on a flat `EXTENDED_REACH`, so the per-player
    /// `layoutExtend` that decides *whether* to bid stays where it is used — the gates in
    /// `TeamAIDefence.canPlay` and `EngineHuman` — rather than riding along here looking
    /// like a reach somebody applies. The reference (`src/sim/AI.ts`) still carries an
    /// `extend` field on its own `bid`; it is write-only there too.
    case bid(x: Double, z: Double)
    case jump(height: Double)
    case stall(count: Double)
    case pickup
    case fake(throwType: AIThrowType)

    /// The reference's discriminator, recovered so fixtures can compare it.
    public var kind: String {
        switch self {
        case .throw: "throw"
        case .catch: "catch"
        case .bid: "bid"
        case .jump: "jump"
        case .stall: "stall"
        case .pickup: "pickup"
        case .fake: "fake"
        }
    }
}

/// Telemetry only. Locomotion must ignore it.
///
/// `cutKind` and `cutDepth` are not decoration: which cut belongs to which position *is*
/// the vertical stack, so this is the only handle a test has on whether the shape on the
/// field is the shape the sport plays. From outside, every cut looks identical whether it
/// came from the front of the stack or the back.
public struct IntentDebug: Equatable, Sendable {
    public var role: String = ""
    public var state: String = ""
    public var lane: Playbook.LaneKey? = nil
    /// The point the committed cut is attacking, if any.
    public var cutX: Double = 0
    public var cutZ: Double = 0
    public var cutKind: Playbook.CutKind? = nil
    public var cutDepth: Double = -1

    public init() {}
}

/// One frame's instruction for one player. This is the entire AI-to-locomotion contract.
public struct PlayerIntent: Equatable, Sendable {
    public var id: Int
    public var team: TeamId
    public var targetX: Double
    public var targetZ: Double
    /// Unit-ish (x, z) the torso should face.
    public var faceX: Double
    public var faceZ: Double
    public var mode: AIMoveMode
    /// 0…1 fraction of `maxSpeed` wanted right now.
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
        id: Int, team: TeamId, targetX: Double, targetZ: Double,
        faceX: Double, faceZ: Double, mode: AIMoveMode, effort: Double,
        desiredSpeed: Double, maxSpeed: Double, maxAccel: Double, maxDecel: Double,
        turnRate: Double, arriveRadius: Double, personalSpace: Double,
        action: PlayerAction? = nil, debug: IntentDebug = IntentDebug()
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

public struct FlightSample: Equatable, Sendable {
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

/// The two points on a flight anybody in the air cares about: where to run to, and where
/// the disc stops being playable on your feet.
public struct CatchPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var z: Double
    public var t: Double
    public var lastX: Double
    public var lastZ: Double
    public var lastT: Double

    public init(
        x: Double, y: Double, z: Double, t: Double,
        lastX: Double, lastZ: Double, lastT: Double
    ) {
        self.x = x
        self.y = y
        self.z = z
        self.t = t
        self.lastX = lastX
        self.lastZ = lastZ
        self.lastT = lastT
    }
}

/// Optional in the reference because the peer may not be registered. A protocol here, so
/// "not registered" is `nil` rather than a missing key in a bag of `Any`.
public protocol LocomotionPeer {
    func timeToReach(_ p: AIPlayer, _ x: Double, _ z: Double) -> Double
    func isAirborne(_ p: AIPlayer) -> Bool
}

public protocol DiscPeer {
    func predictPath(_ state: AIDiscState, horizon: Double, step: Double) -> [FlightSample]
}
