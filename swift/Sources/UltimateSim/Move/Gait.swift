import Foundation

/// Foot-plant bookkeeping. The gait is a phase oscillator whose frequency is a
/// function of ground speed; every time the phase wraps, the opposite foot
/// plants and we record exactly where. That plant point is what the animation
/// system pins the foot to and what the field system scuffs.
///
/// Ported from `src/sim/move/Gait.ts`.

/// Steps per second (not strides — a stride is two steps).
public func stepRate(_ speed: Double) -> Double {
    clamp(1.55 + 0.35 * speed, 1.55, 4.9)
}

/// Fraction of the step during which the planted foot bears load.
public func dutyFactor(_ speed: Double) -> Double {
    clamp(0.64 - 0.045 * speed, 0.22, 0.65)
}

/// Half the lateral distance between the feet (m).
public func stanceHalfWidth(_ speed: Double, mode: MoveMode) -> Double {
    if mode == .shuffle { return 0.24 }
    if mode == .backpedal { return 0.14 }
    return clamp(0.155 - 0.008 * speed, 0.085, 0.16)
}

/// Speed below which the player is considered planted-and-still.
public let GAIT_MIN_SPEED = 0.35

public struct PlantResult: Equatable {
    public var planted: Bool = false
    public var foot: Foot = .left
    public var x: Double = 0
    public var y: Double = 0
    public var z: Double = 0
    public var speed: Double = 0
}

/// Advance the gait phase and, if a foot came down this step, fill and return
/// the plant. `groundY` is queried at the plant point so feet sit on terrain.
///
/// The reference reads and mutates `p.foot` through a local alias (`const f =
/// p.foot`) — safe there because `p.foot` is a heap object. `FootState` here is
/// a value type, so the same pattern needs an explicit `p.foot = f` write-back
/// at every return, or the plant would be computed and thrown away.
@discardableResult
public func advanceGait(
    _ p: LocoPlayer,
    speed: Double,
    velX: Double,
    velZ: Double,
    mode: MoveMode,
    dt: Double,
    groundY: (Double, Double) -> Double
) -> PlantResult {
    var out = PlantResult()
    var f = p.foot

    if speed < GAIT_MIN_SPEED {
        // Standing: the last plant stays where it is, both feet are loaded.
        f.contact = true
        f.phase = 0
        f.stride = 0
        p.foot = f
        return out
    }

    let rate = stepRate(speed)
    f.stride = speed / rate
    f.phase += rate * dt

    var planted = false
    if f.phase >= 1 {
        f.phase -= f.phase.rounded(.down)
        planted = true
    }
    f.contact = f.phase < dutyFactor(speed)

    if !planted {
        p.foot = f
        return out
    }

    let next: Foot = f.planted == .left ? .right : .left
    let inv = 1 / Swift.max(1e-6, speed)
    let dx = velX * inv
    let dz = velZ * inv

    // Right-hand vector for the current facing (yaw 0 = +Z, +yaw toward +X).
    let fx = sin(p.facing)
    let fz = cos(p.facing)
    let rx = -fz
    let rz = fx

    let half = stanceHalfWidth(speed, mode: mode) * (next == .right ? 1 : -1)
    let ahead = f.stride * 0.30

    let px = p.pos.x + dx * ahead + rx * half
    let pz = p.pos.z + dz * ahead + rz * half
    let py = groundY(px, pz)

    f.planted = next
    f.hard = false
    f.t = p.t
    f.speed = speed
    f.contact = true
    f.pos = Vec3d(px, py, pz)
    p.foot = f

    out.planted = true
    out.foot = next
    out.x = px
    out.y = py
    out.z = pz
    out.speed = speed
    return out
}

/// Force a plant for a hard cut. The outside foot goes down — turning left you
/// plant the right foot — and the whole direction change pivots about it.
/// `turnSign` is +1 for a turn toward the player's right, -1 toward the left.
@discardableResult
public func plantForCut(
    _ p: LocoPlayer,
    speed: Double,
    velX: Double,
    velZ: Double,
    turnSign: Double,
    groundY: (Double, Double) -> Double
) -> PlantResult {
    var out = PlantResult()
    var f = p.foot
    let foot: Foot = turnSign >= 0 ? .left : .right // outside foot
    let inv = 1 / Swift.max(1e-6, speed)
    let dx = velX * inv
    let dz = velZ * inv
    // Perpendicular to travel, on the OUTSIDE of the turn: turning right (+1)
    // the outside is the player's left, which is -right = (dz, -dx).
    let ox = dz * turnSign
    let oz = -dx * turnSign

    let ahead = clamp(0.16 + 0.045 * speed, 0.16, 0.62)
    let px = p.pos.x + dx * ahead + ox * 0.26
    let pz = p.pos.z + dz * ahead + oz * 0.26
    let py = groundY(px, pz)

    f.planted = foot
    f.hard = true
    f.t = p.t
    f.speed = speed
    f.contact = true
    f.phase = 0
    f.pos = Vec3d(px, py, pz)
    p.foot = f

    out.planted = true
    out.foot = foot
    out.x = px
    out.y = py
    out.z = pz
    out.speed = speed
    return out
}
