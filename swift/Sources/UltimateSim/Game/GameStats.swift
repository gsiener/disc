import Foundation

/// ULTIMATE — the box score.
///
/// Distances are METRES (the field is metric). Multiply by `YARDS_PER_METRE` from
/// `Rules.swift` for a US-style display. `yards*` are the downfield component toward
/// the throwing team's attacking endzone and may be negative; `*Distance` is the
/// unsigned planar length of the throw.
///
/// **These are structs where the reference has objects, and that changes how they are
/// written to.** `GameState.ts` does `const tp = this.p(thrower); tp.throwaways++`,
/// mutating through a reference. Here the equivalent is `withPlayer(thrower) { $0
/// .throwaways += 1 }`, which writes back to the dictionary. Two live `inout` handles
/// to the same record would lose one of the two sets of increments, so the class only
/// ever holds one at a time — see the sequencing note in `creditCompletion`.
public struct PlayerStats: Equatable, Sendable {
    public var id: PlayerId
    public var team: TeamId
    public var name: String

    public var goals = 0
    public var assists = 0
    public var hockeyAssists = 0
    public var blocks = 0

    /// Passes thrown. `attempts == completions + throwaways + throwsDropped`.
    public var attempts = 0
    public var completions = 0
    public var throwaways = 0
    /// Subset of throwaways that a defender got a hand on.
    public var blockedThrows = 0
    /// Passes I threw that my receiver dropped (charged to them, not me).
    public var throwsDropped = 0

    /// Passes caught from a team-mate (goals included).
    public var catches = 0
    /// Every time this player gained possession, including pickups and Ds.
    public var touches = 0
    public var drops = 0
    public var stallOuts = 0

    public var pulls = 0
    public var pullsOutOfBounds = 0

    public var yardsThrown = 0.0
    public var yardsReceived = 0.0
    public var throwDistance = 0.0
    public var receiveDistance = 0.0

    /// Seconds holding the disc as the thrower.
    public var timeOfPossession = 0.0
    public var pointsPlayed = 0

    /// `(goals + assists + blocks) - (throwaways + drops + stallOuts)`.
    public var plusMinus = 0

    public var foulsCommitted = 0
    public var travels = 0
    public var picks = 0

    public init(id: PlayerId, team: TeamId, name: String) {
        self.id = id
        self.team = team
        self.name = name
    }
}

public struct TeamStats: Equatable, Sendable {
    public var team: TeamId
    public var name: String

    public var score = 0
    public var goals = 0
    public var assists = 0
    public var blocks = 0

    public var attempts = 0
    public var completions = 0
    public var throwaways = 0
    public var drops = 0
    public var stallOuts = 0

    public var turnoversCommitted = 0
    public var turnoversForced = 0

    public var yardsThrown = 0.0
    public var yardsReceived = 0.0

    /// Seconds this team had the disc (including its throws in flight).
    public var timeOfPossession = 0.0
    public var possessions = 0

    public var pulls = 0
    public var holds = 0
    public var breaks = 0
    public var pointsPlayed = 0

    public var timeoutsRemaining: Int
    public var timeoutsUsed = 0

    public init(team: TeamId, name: String, timeouts: Int) {
        self.team = team
        self.name = name
        self.timeoutsRemaining = timeouts
    }
}

/// `(goals + assists + blocks) - (throwaways + drops + stall-outs)`.
public func computePlusMinus(_ s: PlayerStats) -> Int {
    (s.goals + s.assists + s.blocks) - (s.throwaways + s.drops + s.stallOuts)
}
