import Foundation

/// A playable match: players, possession, the disc, and a score.
///
/// **This is the interim engine, and it is meant to be deleted.** `src/sim/GameState.ts`
/// and `src/sim/AI.ts` are the authoritative models and are still being ported; until
/// they land, something has to stand between the verified flight physics and a thumb on
/// a screen. That is this file. It borrows nothing it could instead call: the disc is
/// `DiscPhysics`, the release is `throwDisc`, the geometry is `FieldSpec`. What it adds
/// is only the part not yet ported — where players stand, who they chase, and when a
/// possession ends.
///
/// The distinction matters when reading it. Flight is validated against goldens to
/// 5e-15 m. Nothing in *this* file is validated against anything, because there is no
/// reference to differ against yet — the cutting and marking here are inventions, and
/// they will be replaced rather than tuned.
///
/// Coordinates follow `Rules.swift`, not the flight view: **+z is downfield**, x is
/// lateral, y is up. The two disagreed until this file was written, which is exactly the
/// sort of thing that is free to fix now and expensive to fix after an AI is built on it.

// MARK: - field

/// Pitch geometry as a value rather than a global.
///
/// `Rules.swift` exposes `FIELD` as a module constant because the reference does. That
/// is a fair port and a bad foundation: it hardcodes one field size into 79 call sites,
/// and this game is played on two. Nothing here reads the global.
public struct FieldSpec: Equatable, Sendable {
    /// End line to end line, metres.
    public let length: Double
    /// Sideline to sideline, metres.
    public let width: Double
    public let endzoneDepth: Double
    /// Players per side.
    public let teamSize: Int
    /// Points needed to win.
    public let target: Int

    public var sideline: Double { width / 2 }
    public var endLine: Double { length / 2 }
    public var goalLine: Double { length / 2 - endzoneDepth }

    public init(length: Double, width: Double, endzoneDepth: Double, teamSize: Int, target: Int) {
        self.length = length
        self.width = width
        self.endzoneDepth = endzoneDepth
        self.teamSize = teamSize
        self.target = target
    }

    /// Regulation 7v7. USAU dimensions.
    public static let full = FieldSpec(
        length: 100, width: 37, endzoneDepth: 18, teamSize: 7, target: 15)

    /// 3v3 in the space of a single endzone, turned so its long axis is the direction of
    /// play. Game to 7 — short enough to finish on a phone, long enough that one lucky
    /// point does not decide it.
    public static let minis = FieldSpec(
        length: 37, width: 18, endzoneDepth: 6, teamSize: 3, target: 7)

    public func inBounds(_ p: Vec3d) -> Bool {
        abs(p.x) <= sideline && abs(p.z) <= endLine
    }

    /// Is `p` inside the endzone that the team attacking in `dir` is aiming at?
    public func inAttackingEndzone(_ p: Vec3d, _ dir: Double) -> Bool {
        inBounds(p) && p.z * dir >= goalLine
    }

    public func clamped(_ p: Vec3d) -> Vec3d {
        Vec3d(
            Swift.min(Swift.max(p.x, -sideline), sideline), p.y,
            Swift.min(Swift.max(p.z, -endLine), endLine))
    }
}

// MARK: - players

public struct Player: Identifiable, Sendable {
    public var id: Int
    public var team: Int
    public var pos: Vec3d
    public var vel: Vec3d
    /// Where this player is currently trying to get to.
    public var target: Vec3d
    /// Index into the other team's roster, for a defender. -1 for offence.
    public var marking: Int = -1
    /// Sprint attributes, from the movement port.
    public var attr: Attributes = .defaultAttrs

    /// The player's own top speed, so a 3v3 does not read as six identical clones.
    /// Varied by id rather than randomly, because a replay must be reproducible.
    public var topSpeed: Double { 6.2 + Double((id * 7) % 5) * 0.28 }
}

/// What the match is doing right now. The disc being in the air is a *state*, not a
/// flag, because almost every rule question ("can they run?", "is it a turn?") is
/// answered differently while it is.
public enum PlayPhase: Equatable, Sendable {
    /// Someone is holding the disc; the thrower may pivot but not run.
    case held(by: Int)
    /// In flight, thrown by `by`, and whether the throw has already been touched.
    case flight(by: Int)
    /// The disc is down. A turnover is being walked to the spot.
    case dead(nextTeam: Int)
    /// A point was just scored by `team`.
    case scored(team: Int)
}

// MARK: - the match

public final class Match {
    public let field: FieldSpec
    public private(set) var players: [Player] = []
    public private(set) var disc = DiscState()
    public private(set) var phase: PlayPhase = .dead(nextTeam: 0)
    public private(set) var score = [0, 0]
    /// Seconds since the current phase began.
    public private(set) var phaseTime = 0.0
    /// Stall count on the current possession, in seconds held.
    public private(set) var stall = 0.0
    /// Which way team 0 attacks. Team 1 attacks the other way.
    public private(set) var attackDir = 1.0
    /// The player the human is controlling. Always on team 0.
    public private(set) var controlled = 0

    private let rng: Rng
    /// Set while a throw is being aimed, so the thrower does not drift.
    public var aiming = false

    public var isOver: Bool { score[0] >= field.target || score[1] >= field.target }

    public init(field: FieldSpec = .minis, seed: UInt32 = 0x5eed_c0de) {
        self.field = field
        self.rng = Rng(seed: seed)
        reset(pullingTeam: 1)
    }

    /// Line both teams up for a pull and put the disc in the receiver's hands.
    ///
    /// A real pull is a live throw from the end line and it is the next thing to add.
    /// Starting from a caught pull is a deliberate shortcut: it gets a thumb onto a
    /// playable possession without also inventing an unported kickoff.
    public func reset(pullingTeam: Int) {
        let recv = 1 - pullingTeam
        // The receiving team attacks away from its own endzone.
        attackDir = recv == 0 ? 1 : -1
        players = []

        for t in 0..<2 {
            let dir = t == 0 ? attackDir : -attackDir
            for i in 0..<field.teamSize {
                // Spread across the width, backed up towards their own goal line.
                let lateral = field.width * (Double(i) / Double(Swift.max(1, field.teamSize - 1)) - 0.5) * 0.7
                let depth = (t == recv ? field.goalLine * 0.55 : field.goalLine * 0.15) * -dir
                players.append(
                    Player(
                        id: t * field.teamSize + i, team: t,
                        pos: Vec3d(lateral, 0, depth), vel: .zero,
                        target: Vec3d(lateral, 0, depth)))
            }
        }
        assignMarks()

        let handler = recv * field.teamSize
        disc = DiscState()
        disc.pos = players[handler].pos
        phase = .held(by: handler)
        controlled = recv == 0 ? handler : nearestTeammateToDisc(team: 0)
        stall = 0
        phaseTime = 0
    }

    /// Each defender picks the nearest unclaimed attacker. Greedy and stable, which is
    /// enough for a first version — real matchups come with the AI port.
    private func assignMarks() {
        for t in 0..<2 {
            var taken = Set<Int>()
            for i in indices(of: t) {
                var best = -1
                var bestD = Double.infinity
                for j in indices(of: 1 - t) where !taken.contains(j) {
                    let d = distXZ(players[i].pos, players[j].pos)
                    if d < bestD { bestD = d; best = j }
                }
                if best >= 0 {
                    taken.insert(best)
                    players[i].marking = best
                }
            }
        }
    }

    private func indices(of team: Int) -> Range<Int> {
        team == 0 ? 0..<field.teamSize : field.teamSize..<(field.teamSize * 2)
    }

    public func attackDirection(of team: Int) -> Double {
        team == 0 ? attackDir : -attackDir
    }

    private func nearestTeammateToDisc(team: Int) -> Int {
        indices(of: team).min { distXZ(players[$0].pos, disc.pos) < distXZ(players[$1].pos, disc.pos) }
            ?? indices(of: team).lowerBound
    }

    // MARK: stepping

    /// Advance the whole match by `dt`. The disc integrates at its own fixed 1/120
    /// internally; players use `dt` directly because their motion is a first-order
    /// steer, not an integrated trajectory, and does not need the same care.
    public func step(dt: Double) {
        phaseTime += dt

        switch phase {
        case .held(let holder):
            stall += dt
            disc.pos = Vec3d(players[holder].pos.x, 1.1, players[holder].pos.z)
            if stall >= 10 { turnover(at: disc.pos, from: players[holder].team) }

        case .flight:
            disc.step(dt: dt)
            resolveFlight()

        case .dead(let nextTeam):
            // A short reset, then the nearest player picks it up.
            if phaseTime > 1.0 {
                let taker = nearestTeammateToDisc(team: nextTeam)
                players[taker].pos = Vec3d(disc.pos.x, 0, disc.pos.z)
                attackDir = nextTeam == 0 ? attackDir : attackDir
                phase = .held(by: taker)
                stall = 0
                phaseTime = 0
                if nextTeam == 0 { controlled = taker }
            }

        case .scored:
            if phaseTime > 2.0 {
                if case .scored(let team) = phase { reset(pullingTeam: team) }
            }
        }

        steerPlayers(dt: dt)
    }

    /// Catches, drops, goals and out-of-bounds — everything that can end a throw.
    private func resolveFlight() {
        guard case .flight(let thrower) = phase else { return }
        let throwerTeam = players[thrower].team

        // Out of bounds while airborne is a turn at the crossing point.
        if !field.inBounds(disc.pos) {
            turnover(at: field.clamped(disc.pos), from: throwerTeam)
            return
        }

        // A catch. Anyone within reach of a low disc may take it; the closest wins, and
        // a defender within the same reach takes it instead, which is a block.
        if disc.pos.y < 2.3 {
            var best = -1
            var bestD = DISC_GRAB_R
            for (i, p) in players.enumerated() where i != thrower || disc.t > 0.35 {
                let d = distXZ(p.pos, disc.pos)
                if d < bestD { bestD = d; best = i }
            }
            if best >= 0 {
                catchDisc(by: best, thrownBy: thrower)
                return
            }
        }

        if disc.atRest { turnover(at: disc.pos, from: throwerTeam) }
    }

    private func catchDisc(by receiver: Int, thrownBy thrower: Int) {
        let team = players[receiver].team
        if team != players[thrower].team {
            // A block. The intercepting team gets it where it was caught.
            possess(receiver)
            if team == 0 { controlled = receiver }
            return
        }
        if field.inAttackingEndzone(players[receiver].pos, attackDirection(of: team)) {
            score[team] += 1
            phase = .scored(team: team)
            phaseTime = 0
            return
        }
        possess(receiver)
        // Catching moves control to the catcher — the decision recorded in the plan.
        // The alternative, keeping the camera on one player, makes the other five
        // scenery; this way the player is always the person with a decision to make.
        if team == 0 { controlled = receiver }
    }

    private func possess(_ i: Int) {
        players[i].vel = .zero
        disc = DiscState()
        disc.pos = Vec3d(players[i].pos.x, 1.1, players[i].pos.z)
        phase = .held(by: i)
        stall = 0
        phaseTime = 0
        assignMarks()
    }

    private func turnover(at spot: Vec3d, from team: Int) {
        disc.pos = Vec3d(spot.x, 0, spot.z)
        phase = .dead(nextTeam: 1 - team)
        phaseTime = 0
        stall = 0
    }

    // MARK: throwing

    /// Release a throw from the current holder.
    ///
    /// - Parameters:
    ///   - type: which throw
    ///   - aim: horizontal direction, world
    ///   - power: 0…1 across the throw's speed range
    ///   - loft: extra launch elevation, radians
    public func release(_ type: ThrowType, aim: Vec3d, power: Double, loft: Double = 0) {
        guard case .held(let holder) = phase else { return }
        var opts = ThrowOptions()
        opts.groundY = 0
        disc = throwDisc(
            type, from: Vec3d(players[holder].pos.x, 1.25, players[holder].pos.z),
            aim: aim, power: power, angle: loft, spin: 0.6, options: opts)
        phase = .flight(by: holder)
        phaseTime = 0
        aiming = false
    }

    // MARK: movement

    /// Steer everyone towards their target with a speed cap and a simple approach taper,
    /// then push apart anyone who has ended up inside someone else.
    private func steerPlayers(dt: Double) {
        decideTargets()

        for i in players.indices {
            if case .held(let holder) = phase, holder == i {
                // The thrower has a pivot, not legs.
                players[i].vel = .zero
                continue
            }
            let p = players[i]
            var toGo = Vec3d(p.target.x - p.pos.x, 0, p.target.z - p.pos.z)
            let dist = toGo.length
            if dist < 0.05 {
                players[i].vel = players[i].vel.scaled(0.82)
            } else {
                toGo = toGo.normalized
                // Ease into the last metre so players settle instead of oscillating.
                let want = toGo.scaled(p.topSpeed * Swift.min(1, dist / 1.5))
                let blend = Swift.min(1, dt * 6.5)
                players[i].vel = p.vel.addingScaled(want.addingScaled(p.vel, -1), blend)
            }
            players[i].pos = field.clamped(p.pos.addingScaled(players[i].vel, dt))
            players[i].pos.y = 0
        }

        // Bodies are not ghosts. Two players inside `PERSONAL_RADIUS` of each other are
        // pushed apart along the line between them, which is the cheap half of what
        // `Move/Separation.swift` does properly.
        for a in players.indices {
            for b in (a + 1)..<players.count {
                var d = Vec3d(players[b].pos.x - players[a].pos.x, 0, players[b].pos.z - players[a].pos.z)
                let dist = d.length
                let minDist = PERSONAL_RADIUS * 2
                guard dist > 1e-6, dist < minDist else { continue }
                d = d.normalized.scaled((minDist - dist) * 0.5)
                players[a].pos = field.clamped(players[a].pos.addingScaled(d, -1))
                players[b].pos = field.clamped(players[b].pos.addingScaled(d, 1))
            }
        }
    }

    /// Where everyone wants to be. Offence cuts, defence marks.
    private func decideTargets() {
        let holder: Int? = { if case .held(let h) = phase { return h } else { return nil } }()
        let discXZ = Vec3d(disc.pos.x, 0, disc.pos.z)

        for i in players.indices {
            let p = players[i]
            let attacking = holder.map { players[$0].team == p.team } ?? (p.team == phaseTeam)
            let dir = attackDirection(of: p.team)

            if case .flight = phase {
                // Everyone converges on where the disc is going to be low enough to take.
                players[i].target = Vec3d(disc.pos.x, 0, disc.pos.z)
                continue
            }

            if attacking {
                if holder == i { players[i].target = p.pos; continue }
                // Cut downfield, fanning out by roster slot so three players do not
                // stack. The phase clock drives an in-and-out so a cut has a moment
                // where it is open rather than being permanently covered.
                let slot = Double(i % field.teamSize) - Double(field.teamSize - 1) / 2
                let swing = Foundation.sin(phaseTime * 0.9 + Double(i)) * 0.5 + 0.5
                let lane = slot * field.width * 0.30
                let depth = discXZ.z + dir * (5 + swing * 11)
                players[i].target = field.clamped(Vec3d(lane, 0, depth))
            } else {
                let m = p.marking
                guard m >= 0, m < players.count else { players[i].target = p.pos; continue }
                let mark = players[m]
                if holder == m {
                    // Mark the thrower: stand a body's length off, on the disc side.
                    var off = Vec3d(mark.pos.x - discXZ.x, 0, mark.pos.z - discXZ.z)
                    off = off.lengthSq < 1e-6 ? Vec3d(0, 0, -dir) : off.normalized
                    players[i].target = mark.pos.addingScaled(off, 0.9)
                } else {
                    // Deny the cut: sit between the receiver and their own endzone.
                    players[i].target = field.clamped(
                        Vec3d(mark.pos.x, 0, mark.pos.z + attackDirection(of: mark.team) * 1.4))
                }
            }
        }
    }

    /// Which team is on offence when nobody is holding the disc.
    private var phaseTeam: Int {
        switch phase {
        case .held(let h): players[h].team
        case .flight(let t): players[t].team
        case .dead(let next): next
        case .scored(let team): 1 - team
        }
    }

    // MARK: queries for the view

    public var holder: Int? {
        if case .held(let h) = phase { return h }
        return nil
    }

    /// The controllable teammates a throw could go to, nearest first.
    public func receivers() -> [Player] {
        guard let h = holder else { return [] }
        let team = players[h].team
        return indices(of: team).filter { $0 != h }.map { players[$0] }
            .sorted { distXZ($0.pos, disc.pos) < distXZ($1.pos, disc.pos) }
    }
}
