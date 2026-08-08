import Foundation

/// ULTIMATE — the vocabulary of the game state machine.
///
/// Phases, turnover reasons, calls, observations and events, ported from the type
/// declarations at the head of `src/sim/GameState.ts`. The raw values are the
/// reference's exact strings, because the golden fixtures are generated from the
/// TypeScript and compared against these.

// MARK: - phases and reasons

public enum Phase: String, Equatable, Decodable, Sendable {
    case prePull = "PRE_PULL"
    case pullInFlight = "PULL_IN_FLIGHT"
    case livePossession = "LIVE_POSSESSION"
    case discInFlight = "DISC_IN_FLIGHT"
    case turnoverDead = "TURNOVER_DEAD"
    case check = "CHECK"
    case pointScored = "POINT_SCORED"
    case timeout = "TIMEOUT"
    case halftime = "HALFTIME"
    case gameOver = "GAME_OVER"
}

public enum TurnoverReason: String, Equatable, Decodable, Sendable {
    case drop
    case throwaway
    case outOfBounds = "out-of-bounds"
    case caughtOutOfBounds = "caught-out-of-bounds"
    case block
    case interception
    case stallOut = "stall-out"
    case pullDrop = "pull-drop"
    case travelViolation = "travel-violation"
    case doubleTouch = "double-touch"
}

/// Why the disc is currently dead and waiting to be put back into play.
public enum DeadReason: String, Equatable, Decodable, Sendable {
    case turnover
    case pullLanded = "pull-landed"
    case pullOutOfBounds = "pull-out-of-bounds"
    case pullDropped = "pull-dropped"
}

public enum CallType: String, Equatable, Decodable, Sendable {
    case foul
    case travel
    case pick
    case strip
    case violation
}

/// Which spot an out-of-bounds pull is taken from (WFDF 12.4).
public enum PullSpotChoice: String, Equatable, Decodable, Sendable {
    case brick
    case sideline
}

// MARK: - setup

public struct PlayerSetup: Equatable, Sendable {
    public let id: PlayerId
    public let name: String?
    public let number: Int?

    public init(id: PlayerId, name: String? = nil, number: Int? = nil) {
        self.id = id
        self.name = name
        self.number = number
    }
}

public struct TeamSetup: Equatable, Sendable {
    public let name: String?
    public let players: [PlayerSetup]?

    public init(name: String? = nil, players: [PlayerSetup]? = nil) {
        self.name = name
        self.players = players
    }
}

/// What a caller may hand the constructor. The reference's `rules?: Partial<RuleSet>`
/// becomes the mutating closure `makeRules` already established in `Rules.swift`;
/// Swift has no `Partial<T>` and a second dictionary-merge mechanism would be a worse
/// answer than the one the previous port picked.
public struct GameStateOptions {
    /// Called for every event. Nil is the reference's no-op emitter.
    public var emit: ((GameEvent) -> Void)?
    public var rules: (inout RuleSet) -> Void
    /// The pitch and the roster size. Not in the reference — see `GameFormat`.
    public var format: GameFormat
    public var teams: (TeamSetup, TeamSetup)?
    /// Which team pulls to open the game. Default 1.
    public var startingPullTeam: TeamId?
    /// Attacking direction of team 0 for the opening point. Default +1.
    public var startingDirTeam0: Dir?
    /// Called for every play-by-play line.
    public var onLog: ((PlayLogEntry) -> Void)?
    /// Ring-buffer size for `getLog()`. Default 4096.
    public var maxLog: Int?

    public init(
        emit: ((GameEvent) -> Void)? = nil,
        rules: @escaping (inout RuleSet) -> Void = { _ in },
        format: GameFormat = .sevens,
        teams: (TeamSetup, TeamSetup)? = nil,
        startingPullTeam: TeamId? = nil,
        startingDirTeam0: Dir? = nil,
        onLog: ((PlayLogEntry) -> Void)? = nil,
        maxLog: Int? = nil
    ) {
        self.emit = emit
        self.rules = rules
        self.format = format
        self.teams = teams
        self.startingPullTeam = startingPullTeam
        self.startingDirTeam0 = startingDirTeam0
        self.onLog = onLog
        self.maxLog = maxLog
    }
}

public struct PlayLogEntry: Equatable, Sendable {
    /// Sim seconds since `startGame()`.
    public let t: Double
    public let phase: Phase
    public let point: Int
    public let text: String
}

// MARK: - observations

/// A field that the caller may leave unset, may set to "there is none", or may give a
/// value.
///
/// The reference distinguishes `undefined` from `null` on `markerId` and `markerPos`
/// and the two mean different things: `undefined` is "I am not telling you about the
/// mark this frame, leave it alone", `null` is "there is nobody marking, so the count
/// may not run". A plain Swift `Optional` collapses those into one case and would
/// silently turn every frame that omits the marker into a frame that clears it.
public enum Reported<T>: Sendable where T: Sendable {
    case unreported
    case null
    case value(T)

    /// The value if one was given, else nil — the reference's `?? fallback` reading.
    public var unwrapped: T? {
        if case .value(let v) = self { return v }
        return nil
    }
}

/// A player position fed in from the physics/AI layer for the double-team test.
public struct Observed: Sendable {
    public let id: PlayerId
    public let pos: Vec3d
    public init(id: PlayerId, pos: Vec3d) {
        self.id = id
        self.pos = pos
    }
}

public struct FrameObservation: Sendable {
    public var discPos: Vec3d?
    /// Live position of the player holding the disc.
    public var throwerPos: Vec3d?
    /// Live position of the thrower's pivot foot (travel detection).
    public var pivotFoot: Vec3d?
    public var markerId: Reported<PlayerId>
    public var markerPos: Reported<Vec3d>
    /// Every defender and every offensive player, for the double-team test.
    public var defenders: [Observed]?
    public var offence: [Observed]?

    public init(
        discPos: Vec3d? = nil,
        throwerPos: Vec3d? = nil,
        pivotFoot: Vec3d? = nil,
        markerId: Reported<PlayerId> = .unreported,
        markerPos: Reported<Vec3d> = .unreported,
        defenders: [Observed]? = nil,
        offence: [Observed]? = nil
    ) {
        self.discPos = discPos
        self.throwerPos = throwerPos
        self.pivotFoot = pivotFoot
        self.markerId = markerId
        self.markerPos = markerPos
        self.defenders = defenders
        self.offence = offence
    }
}

/// Whether a report method was legal. `note` carries the rejection reason, which is
/// also written to the play log.
public struct ActionResult: Equatable, Sendable {
    public let ok: Bool
    public let note: String?

    public init(ok: Bool, note: String? = nil) {
        self.ok = ok
        self.note = note
    }
}

public struct PendingCall: Equatable, Sendable {
    public let type: CallType
    public let callerId: PlayerId
    public let callerTeam: TeamId
    public let againstId: PlayerId
    public let againstTeam: TeamId
    public let at: Vec3d
    /// Phase the game was in when the call was made.
    public let phaseAtCall: Phase
    public let stallAtCall: Int
}

/// The payload of the most recent goal — for the HUD, replays and test harnesses.
public struct ScoreRecord: Equatable, Sendable {
    public let team: TeamId
    public let playerId: PlayerId
    public let assistId: PlayerId?
    public let score: [Int]
    public let point: Int
}

/// What `snapshot()` returns: the whole state a caller needs to draw a scoreboard.
public struct GameSnapshot: Equatable, Sendable {
    public let phase: Phase
    public let clock: Double
    public let point: Int
    public let half: Int
    public let score: [Int]
    public let possession: TeamId?
    public let thrower: PlayerId?
    public let stall: Int
    public let attackDir: [Dir]
    public let pullingTeam: TeamId
    public let target: Int
    public let cap: CapState
}

// MARK: - events

/// A marking or travelling violation. Three shapes in the reference, all emitted under
/// the single event name `violation`.
public enum Violation: Equatable, Sendable {
    case discSpace(markerId: PlayerId?, dist: Double)
    case doubleTeam(markerId: PlayerId?, playerId: PlayerId)
    case travel(playerId: PlayerId, pivot: Vec3d, foot: Vec3d)

    public var type: String {
        switch self {
        case .discSpace: "disc-space"
        case .doubleTeam: "double-team"
        case .travel: "travel"
        }
    }
}

/// Everything the machine decides comes back out as one of these.
///
/// The reference emits `(event: string, payload: any)`. A string-keyed bag of `Any` is
/// not portable to a language with types, and the whole point of the sim being
/// decoupled from the renderer is that the renderer can be handed a payload it can
/// read. So the payloads are made explicit here and `name` recovers the reference's
/// event string — which is what the golden fixtures compare, so a renamed or reordered
/// event is a test failure rather than a silent behaviour change.
public enum GameEvent: Equatable, Sendable {
    case discReleased(
        pos: Vec3d, vel: Vec3d, spin: Double, throwType: String, playerId: PlayerId,
        team: TeamId, stall: Int?)
    case discCaught(playerId: PlayerId, pos: Vec3d, team: TeamId, outcome: String)
    case discGrounded(pos: Vec3d, reason: String)
    case pull(team: TeamId, playerId: PlayerId, from: Vec3d, vel: Vec3d?)
    case stallTick(count: Int, max: Int, playerId: PlayerId?, team: TeamId?, markerId: PlayerId?)
    case score(
        team: TeamId, playerId: PlayerId, assistId: PlayerId?, score: [Int], scoreline: String,
        point: Int)
    case turnover(
        reason: TurnoverReason, from: TeamId, to: TeamId, playerId: PlayerId, pos: Vec3d,
        spot: Vec3d, point: Int, score: [Int])
    case stateChanged(
        from: Phase, to: Phase, clock: Double, point: Int, possession: TeamId?, score: [Int])
    case call(type: CallType, callerId: PlayerId, againstId: PlayerId, at: Vec3d, phaseAtCall: Phase)
    case callResolved(type: CallType, contested: Bool, outcome: String, stallResume: Int)
    case timeout(team: TeamId, playerId: PlayerId?, remaining: Int)
    case half(half: Int, score: [Int])
    case gameOver(score: [Int], winner: TeamId, teamName: String)
    case violation(Violation)
    case cap(kind: String, target: Int)

    /// The reference's event string.
    public var name: String {
        switch self {
        case .discReleased: "disc:released"
        case .discCaught: "disc:caught"
        case .discGrounded: "disc:grounded"
        case .pull: "pull"
        case .stallTick: "stall:tick"
        case .score: "score"
        case .turnover: "turnover"
        case .stateChanged: "state:changed"
        case .call: "call"
        case .callResolved: "call:resolved"
        case .timeout: "timeout"
        case .half: "half"
        case .gameOver: "game:over"
        case .violation: "violation"
        case .cap: "cap"
        }
    }
}
