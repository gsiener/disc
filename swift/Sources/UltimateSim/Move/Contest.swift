import Foundation

/// Aerial contests. Two bodies going up for the same disc is resolved as a
/// reach comparison plus a positioning (box-out) term — not a coin flip. The
/// player who timed their jump so that their apex coincides with the disc, who
/// got there first, and who has the inside shoulder, wins.
///
/// Ported from `src/sim/move/Contest.ts`.

/// COM height of a body lying on the turf, above the surface.
public let PRONE_Y = 0.22

public struct ContestScore: Equatable {
    /// Fingertip height at the contest instant (world Y).
    public var reach: Double
    /// Horizontal distance from the disc at the contest instant (m).
    public var gap: Double
    /// Reach after the horizontal-gap penalty (m).
    public var effective: Double
    /// Positional advantage, in metres-of-reach equivalent.
    public var boxOut: Double
    public var score: Double
}

public enum ContestWinner: String, Equatable {
    case a, b, none
}

public enum Contestant: String, Equatable {
    case a, b
}

public struct ContestResult: Equatable {
    public var winner: ContestWinner
    public var a: ContestScore
    public var b: ContestScore
    /// |scoreA - scoreB| in metres.
    public var margin: Double
    /// Bodies within contact distance at the contest instant.
    public var contact: Bool
    /// Who initiated the contact, if any.
    public var foulOn: Contestant?
    /// 0..1 likelihood the contact is called.
    public var foulChance: Double
}

/// Predicted COM position `t` seconds from now.
///
/// The reference writes through an `out` `THREE.Vector3` reused across calls to
/// avoid allocation; `Vec3d` is a value, so this just returns one.
public func predictPos(_ p: LocoPlayer, t: Double) -> Vec3d {
    let x = p.pos.x + p.vel.x * t
    let z = p.pos.z + p.vel.z * t
    let y: Double
    if p.air.airborne {
        let floor = p.groundY + (p.state == .layout ? PRONE_Y : p.hipHeight)
        y = Swift.max(floor, p.pos.y + p.vel.y * t - 0.5 * moveG * t * t)
    } else {
        y = p.pos.y
    }
    return Vec3d(x, y, z)
}

/// Fingertip height `t` seconds from now (world Y).
public func reachAt(_ p: LocoPlayer, t: Double) -> Double {
    var y = p.pos.y
    if p.air.airborne {
        let floor = p.groundY + (p.state == .layout ? PRONE_Y : p.hipHeight)
        y = Swift.max(floor, p.pos.y + p.vel.y * t - 0.5 * moveG * t * t)
    }
    let rise = y - (p.groundY + p.hipHeight)
    return Swift.max(p.groundY + 0.6, p.groundY + p.attr.height * 1.30 + rise)
}

/// How far to the side a player can still get a hand on the disc.
private func catchRadius(_ p: LocoPlayer) -> Double {
    0.55 * p.attr.height
}

/// - Parameters:
///   - tContest: seconds from now that the disc arrives
///   - jitter: deterministic tie-breaker in [-1,1]; pass 0 for a pure model
public func contestAir(
    _ a: LocoPlayer,
    _ b: LocoPlayer,
    discPos: Vec3d,
    tContest: Double,
    jitter: Double = 0
) -> ContestResult {
    let PA = predictPos(a, t: tContest)
    let PB = predictPos(b, t: tContest)

    let gapA = Foundation.hypot(discPos.x - PA.x, discPos.z - PA.z)
    let gapB = Foundation.hypot(discPos.x - PB.x, discPos.z - PB.z)

    let reachA = reachAt(a, t: tContest)
    let reachB = reachAt(b, t: tContest)

    let effA = reachA - 1.15 * Swift.max(0, gapA - catchRadius(a))
    let effB = reachB - 1.15 * Swift.max(0, gapB - catchRadius(b))

    // Inside position: nearer the disc horizontally is worth real reach.
    let inside = clamp((gapB - gapA) * 0.35, -0.30, 0.30)

    // Sealing: standing between the opponent and the disc.
    let bx = PB.x - PA.x, bz = PB.z - PA.z
    let dxA = discPos.x - PA.x, dzA = discPos.z - PA.z
    let bodyDist = Foundation.hypot(bx, bz)
    var sealA = 0.0
    if bodyDist > 1e-4 {
        let dl = Foundation.hypot(dxA, dzA)
        if dl > 1e-4 {
            // >0 when the opponent is on the far side of A from the disc.
            let dot = (bx * -dxA + bz * -dzA) / (bodyDist * dl)
            sealA = clamp(dot, -1, 1) * 0.14
        }
    }

    // Strength only matters when bodies are actually jostling.
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
        let closeA = a.vel.x * nx + a.vel.z * nz // A moving into B
        let closeB = -(b.vel.x * nx + b.vel.z * nz) // B moving into A
        let impact = Swift.max(closeA, closeB)
        if impact > 0.6 {
            foulOn = closeA >= closeB ? .a : .b
            foulChance = clamp01((impact - 0.6) / 4.0)
        }
    }

    return ContestResult(
        winner: margin < 0.03 ? .none : (scoreA > scoreB ? .a : .b),
        a: ContestScore(reach: reachA, gap: gapA, effective: effA, boxOut: boxA, score: scoreA),
        b: ContestScore(reach: reachB, gap: gapB, effective: effB, boxOut: boxB, score: scoreB),
        margin: margin,
        contact: contact,
        foulOn: foulOn,
        foulChance: foulChance
    )
}
