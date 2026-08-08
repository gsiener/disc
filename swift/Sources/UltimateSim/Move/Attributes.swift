import Foundation

/// Ratings -> physical capability curves. Every magic number here is a tuning
/// knob and every one of them is in SI units, so it can be argued with.
/// Ported from `src/sim/move/Attributes.ts`.
///
/// Reference athlete (all ratings 100): 9.6 m/s top speed, 9.6 m/s^2 burst,
/// 13.4 m/s^2 braking, 12.5 m/s^2 lateral grip, 0.85 m standing vertical.

public let moveG = 9.81

/// Below this stamina, capability starts to fade.
public let STAM_FADE = 60.0

@inline(__always)
public func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double {
    v < lo ? lo : (v > hi ? hi : v)
}

@inline(__always)
public func clamp01(_ v: Double) -> Double {
    v < 0 ? 0 : (v > 1 ? 1 : v)
}

@inline(__always)
private func n01(_ v: Double) -> Double {
    clamp(v, 0, 100) / 100
}

/// Fraction of top speed each gait is capped at.
public func modeCapFraction(_ mode: MoveMode, agility: Double) -> Double {
    let agi = n01(agility)
    switch mode {
    case .sprint: return 1
    case .run: return 0.78
    case .jog: return 0.42
    // Backpedalling and shuffling are deliberately slow: this is the whole
    // reason a receiver can beat a defender deep.
    case .backpedal: return 0.50 + 0.06 * agi
    case .shuffle: return 0.43 + 0.06 * agi
    case .auto:
        preconditionFailure("modeCapFraction requires a resolved mode, not .auto")
    }
}

/// - Parameters:
///   - a: ratings
///   - stamina: 0..100
///   - speed: current ground speed (m/s), used for the turn-rate curve
///   - mode: resolved gait
///   - slopeMul: multiplier from terrain grade (1 on the flat)
public func derive(
    _ a: Attributes, stamina: Double, speed: Double, mode: MoveMode, slopeMul: Double = 1
) -> Derived {
    let spd = n01(a.speed)
    let acc = n01(a.accel)
    let agi = n01(a.agility)
    let ver = n01(a.vertical)

    let fatigue = clamp01((STAM_FADE - stamina) / STAM_FADE)

    // Gaits are not equally powerful. You cannot drive off the ground backwards
    // or sideways the way you can running forwards.
    let accelMul = mode == .backpedal ? 0.62 : (mode == .shuffle ? 0.72 : 1)
    let gripMul = mode == .backpedal ? 0.80 : (mode == .shuffle ? 1.15 : 1)

    let topSpeed = (6.6 + 3.0 * spd) * (1 - 0.22 * fatigue) * slopeMul
    let accelMax = (5.0 + 4.6 * acc) * (1 - 0.34 * fatigue) * slopeMul * accelMul
    let brakeMax = accelMax * (1.25 + 0.35 * agi)
    let gripMax = (7.5 + 5.0 * agi) * (1 - 0.20 * fatigue) * gripMul

    // Yaw authority collapses with speed — you cannot pirouette at 9 m/s.
    let sFrac = clamp01(speed / Swift.max(1e-3, topSpeed))
    let turnRate = (9.5 + 4.0 * agi) * (1 - 0.72 * sFrac)

    let jumpHeight = (0.30 + 0.55 * ver) * (1 - 0.18 * fatigue)
    let standingReach = a.height * 1.30
    let plantDur = 0.20 - 0.07 * agi

    let capFrac = mode == .sprint ? 1 : modeCapFraction(mode, agility: a.agility)

    return Derived(
        topSpeed: topSpeed,
        modeCap: topSpeed * capFrac,
        accelMax: accelMax,
        brakeMax: brakeMax,
        gripMax: gripMax,
        turnRate: turnRate,
        jumpHeight: jumpHeight,
        standingReach: standingReach,
        plantDur: plantDur,
        fatigue: fatigue,
        slopeMul: slopeMul
    )
}

/// Propulsive acceleration available at a given speed. Falls off toward the top
/// end so the speed curve is an exponential-ish approach rather than a ramp.
public func propulsiveAt(_ d: Derived, speed: Double, cap: Double) -> Double {
    let f = clamp01(speed / Swift.max(0.5, cap))
    return d.accelMax * Swift.max(0, 1 - pow(f, 1.7))
}

// MARK: - vertical

/// Effective leap height including the run-up bonus.
public func leapHeight(_ d: Derived, approachSpeed: Double) -> Double {
    let f = clamp01(approachSpeed / Swift.max(1e-3, d.topSpeed))
    return d.jumpHeight * (1 + 0.38 * f)
}

public func takeoffVy(_ d: Derived, approachSpeed: Double) -> Double {
    (2 * moveG * leapHeight(d, approachSpeed: approachSpeed)).squareRoot()
}

// MARK: - stamina

/// Stamina points per second, signed: negative drains.
public func staminaRate(_ a: Attributes, speed: Double, topSpeedFresh: Double) -> Double {
    let end = n01(a.endurance)
    let f = clamp01(speed / Swift.max(1e-3, topSpeedFresh))
    let IDLE_F = 0.42 // at or below a jog you are recovering
    if f > IDLE_F {
        let drain = 2.6 + 2.4 * (1 - end)
        return -drain * pow(f, 2.4)
    }
    let rec = 2.0 + 2.0 * end
    return rec * (1 - (f / IDLE_F) * 0.55)
}

/// One-shot stamina costs.
public let COST_JUMP = 2.5
public let COST_LAYOUT = 9.0
public let COST_CUT = 1.2
