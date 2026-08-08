import Foundation

/// Human throw feel — charge, tilt and release quality to disc release parameters.
/// Ported from `humanReleaseParams` and its two constants in `src/sim/Game.ts`.
///
/// `MIN_THROW_SPEED` is the release speed at zero charge, and it sits **below every
/// throw spec's own floor on purpose**: that floor is a 20 m throw and a dump is not.
/// Driving the charge through a throw's own `power` range instead cannot produce a short
/// throw at all — measured on that mapping, a release at ZERO charge still flew 23.6 m,
/// so there was no dump and no reset, only bombs.
///
/// `HUCK_HYZER` is the power-squared bank that stops a full-charge disc turning over and
/// inverting its own curve. With a flat release the drift on a backhand ran
/// +3.1, +4.6, +4.3, +0.1, -3.3, -8.4, -16.7 m as the charge went up: aim at a receiver,
/// pull harder, and the disc finishes seventeen metres the OTHER side of him. That is not
/// difficulty, it is a control that lies.
public let MIN_THROW_SPEED = 9.0
public let HUCK_HYZER = 0.20

/// Release parameters for a human throw. See `humanReleaseParams`.
///
/// These are the arguments to `throwDisc`, not a flight path: `speed` overrides the power
/// lerp (`ThrowOptions.speed`), `angle` adds to the spec's elevation, and `bank`/`nose`
/// are the `ThrowOptions` offsets. Nothing here scripts a curve — the aero does.
public struct HumanRelease: Equatable, Sendable {
    public let speed: Double
    public let angle: Double
    public let spin: Double
    public let bank: Double
    public let nose: Double

    // Public so a check can build a counterfactual release — the regression this mapping
    // exists to prevent is only expressible as a release you can fly beside the real one.
    public init(speed: Double, angle: Double, spin: Double, bank: Double, nose: Double) {
        self.speed = speed
        self.angle = angle
        self.spin = spin
        self.bank = bank
        self.nose = nose
    }
}

/// Charge, tilt and release quality -> disc release parameters.
///
/// Pure so the FEEL is testable. This mapping is the whole of what a throw feels like in
/// the hand, and it used to live inside a private method where the only way to check it
/// was to play the game and squint. The properties that matter — a tap is short, full
/// charge is long, more charge is always more distance, and the curve never inverts on
/// you — are asserted in `HumanReleaseTests` by flying the actual aero with these numbers.
///
/// - Parameters:
///   - type: which throw
///   - power: charge, clamped to [0,1]
///   - quality: release quality; buys spin and a clean nose. Clamped through the spin term.
///   - tilt: the curve control, radians per 0.85. Unclamped, and signed: opposite tilt
///     curves the disc to opposite sides.
public func humanReleaseParams(
    _ type: ThrowType, power: Double, quality: Double, tilt: Double
) -> HumanRelease {
    let p = clamp(power, 0, 1)
    let spec = THROW_SPECS[type]!
    let top = throwSpeed(type, 1)
    // Hyzer has to oppose the throw's OWN turnover, and the turnover follows the spin. A
    // backhand and a forehand spin opposite ways, so a single signed bank cannot serve
    // both: applied uniformly it straightened the backhand and made the forehand worse —
    // 20.5 m of drift, a sign flip, and a dip in the distance curve. `spinSign` is the
    // axis that decides which way a fast disc rolls, so it is the axis the correction is
    // taken along. (Handedness needs no special case: `throwDisc` mirrors spin and bank
    // together, so a left hand flips both and the correction still opposes the turn.)
    return HumanRelease(
        speed: MIN_THROW_SPEED + Swift.max(0, top - MIN_THROW_SPEED) * p,
        angle: 0.02 + 0.10 * p,
        spin: clamp(0.35 + 0.55 * quality, 0.1, 1),
        bank: tilt * 0.85 + HUCK_HYZER * p * p * spec.spinSign,
        nose: (1 - quality) * 0.08
    )
}
