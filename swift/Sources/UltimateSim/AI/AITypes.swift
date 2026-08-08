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
