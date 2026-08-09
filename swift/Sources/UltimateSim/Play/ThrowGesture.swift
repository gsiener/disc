import Foundation

/// Turning a drag into a throw.
///
/// This lives in the sim rather than in the view, and it is not a filing preference.
/// Which throw a gesture means is the single most important rule in the game — it is the
/// whole control scheme — and code that only exists inside a `DragGesture` closure cannot
/// be checked by anything. Here it is a pure function of numbers, so the checks can state
/// what a gesture means and fail if it ever changes by accident.
///
/// The screen convention is UIKit's: **+y is down**. Every sign below follows from that,
/// and getting it backwards would silently invert the whole control scheme — up would
/// throw a dump — which is exactly the sort of thing that reads fine and plays wrong.
public struct ThrowGesture: Equatable, Sendable {
    public let type: ThrowType
    /// 0…1 across the throw's speed range.
    public let power: Double
    /// Extra launch elevation, radians.
    public let loft: Double
    /// How far the drag went, in points. Kept for the aim overlay.
    public let length: Double

    /// The fraction of the screen's short edge that counts as full power.
    ///
    /// Expressed as a fraction so the same flick means the same throw on a phone and on
    /// a tablet. An absolute distance in points would make the iPad a weaker thrower.
    public static let fullPowerFraction = 0.45

    /// The shortest drag that means anything. Below this it is a tap, not a throw.
    public static let minimumDrag = 8.0

    /// Interpret a drag.
    ///
    /// - Parameters:
    ///   - dx: horizontal drag, points, positive right
    ///   - dy: vertical drag, points, **positive down** (UIKit convention)
    ///   - shortEdge: the smaller of the view's width and height, points
    public static func interpret(dx: Double, dy: Double, shortEdge: Double) -> ThrowGesture {
        let length = Foundation.hypot(dx, dy)
        let power = clamp01(length / Swift.max(1, shortEdge * fullPowerFraction))

        // `rise` in [-1, 1]: +1 is a drag straight up the screen, -1 straight down.
        let rise = length < 1e-9 ? 0 : -dy / length

        let type: ThrowType
        var loft = 0.0
        switch rise {
        case ..<(-0.25):
            // Dragging back towards yourself is a dump — the throw you make when the
            // count is up and there is nothing downfield.
            type = .push
        case 0.55...:
            // Steeply up asks for something that goes over the mark rather than around
            // it. A hammer is the throw that does that.
            type = .hammer
        case 0.25..<0.55:
            type = .blade
        default:
            // Flat. Which side you drag towards picks the throw, because a right-handed
            // backhand and forehand break to opposite sides — the same asymmetry the
            // throw table encodes as `spinSign`.
            type = dx >= 0 ? .forehand : .backhand
            loft = 0.10 * rise
        }

        // A floor on power, so a short deliberate drag still leaves the hand. A throw
        // that dribbles out at 15% of a push is never what anyone meant.
        return ThrowGesture(
            type: type, power: Swift.max(0.15, power), loft: loft, length: length)
    }

    /// How long the thumb has been down, turned into how clean the release was.
    ///
    /// See `ThrowCharge`. Kept as a nested alias so a caller that has a gesture has the
    /// timing that goes with it without a second import site.
    public static func charge(for type: ThrowType) -> ThrowCharge { ThrowCharge.for(type) }

    /// The world-space horizontal direction a drag points.
    ///
    /// Screen x maps to world x, and screen *up* maps downfield — which is the direction
    /// you are attacking, hence the `attackDir`. Deliberately not derived from the live
    /// camera: a camera that moves while you are aiming would change what your drag means
    /// part-way through the gesture.
    public static func aim(dx: Double, dy: Double, attackDir: Double) -> Vec3d {
        let v = Vec3d(dx, 0, -dy * attackDir)
        if v.lengthSq < 1e-12 { return Vec3d(0, 0, attackDir) }
        return v.normalized
    }
}

// MARK: - the charge

/// How long you held it, and what that cost.
///
/// A port of the quality half of `src/input/Throw.ts` — `DEFAULT_TIMING`,
/// `THROW_DIFFICULTY`, `applyDifficulty`, `releaseQuality`, `isPerfect`. Only the
/// quality half: the reference is a console charge where hold time also sets *power*,
/// and on a phone the drag already sets power, so `chargePower` has no job here. The
/// numbers are the reference's, unchanged, because the feel is tuned and this is an
/// exposure rather than a retune.
///
/// The shape, from that file's own diagram:
///
///     quality
///     1.0                      /\
///     0.9   _________________ /  \_______
///          /                              \
///     0.34 |                                \____ 0.28
///          0   minTime      fullTime  +grace   maxHold
///          rushed            perfect          overcharged
///
/// Which means: let go instantly and the throw is a scramble; hold for anything past a
/// beat and you are on a safe plateau; hit the window centred on `fullTime` and the
/// throw is perfect; hold past the grace and the wind-up starts telegraphing and
/// wobbling. `quality` is what `Engine.humanRelease` takes, where it buys spin and nose
/// and scales the aim assist — see the `spread = (1 - q) * 0.16` noise model there.
///
/// Pure, `Sendable`, and in the sim rather than in the view for exactly the reason
/// `ThrowGesture` is: a rule that only exists inside a `DragGesture` closure is a rule
/// nothing can check.
public struct ThrowCharge: Equatable, Sendable {
    /// Hold time at which the perfect window is centred.
    public let fullTime: Double
    /// Below this, the release is rushed and quality is scaled down hard.
    public let minTime: Double
    /// Half-width of the perfect window, seconds. The HUD draws the band from this.
    public let perfectWindow: Double
    /// Seconds past `fullTime` before the wind-up starts costing quality.
    public let overGrace: Double
    /// Where the overcharge bottoms out. Nothing fires itself at this on touch — see
    /// the note on `quality(hold:)`.
    public let maxHold: Double
    /// Quality at hold = 0.
    public let rushFloor: Double
    /// Quality on the safe plateau.
    public let plateau: Double
    /// Quality at `maxHold`.
    public let overFloor: Double

    public init(
        fullTime: Double, minTime: Double, perfectWindow: Double, overGrace: Double,
        maxHold: Double, rushFloor: Double, plateau: Double, overFloor: Double
    ) {
        self.fullTime = fullTime
        self.minTime = minTime
        self.perfectWindow = perfectWindow
        self.overGrace = overGrace
        self.maxHold = maxHold
        self.rushFloor = rushFloor
        self.plateau = plateau
        self.overFloor = overFloor
    }

    /// `DEFAULT_TIMING`, minus the two power fields a touch charge does not use.
    public static let base = ThrowCharge(
        fullTime: 0.85, minTime: 0.14, perfectWindow: 0.09, overGrace: 0.30,
        maxHold: 2.00, rushFloor: 0.34, plateau: 0.90, overFloor: 0.28)

    /// `THROW_DIFFICULTY`. Backhand is the baseline; the dump shares it, because a reset
    /// to a handler five metres away is the throw you make when everything has already
    /// gone wrong and it should not also be the hard one.
    public static func difficulty(_ type: ThrowType) -> Double {
        switch type {
        case .backhand: 1.00
        case .push: 1.00
        case .forehand: 1.08
        case .hammer: 1.35
        case .scoober: 1.45
        case .blade: 1.60
        }
    }

    /// `applyDifficulty`: harder throws get a narrower window, need a longer wind-up
    /// before they stop being rushed, lose their grace faster and sit on a lower plateau.
    public static func `for`(_ type: ThrowType) -> ThrowCharge {
        base.scaled(by: difficulty(type))
    }

    public func scaled(by d: Double) -> ThrowCharge {
        let k = Swift.max(0.25, d)
        return ThrowCharge(
            fullTime: fullTime,
            minTime: minTime * k,
            perfectWindow: perfectWindow / k,
            overGrace: overGrace / k,
            maxHold: maxHold,
            rushFloor: clamp01(rushFloor - 0.06 * (k - 1)),
            plateau: clamp01(plateau - 0.12 * (k - 1)),
            overFloor: overFloor)
    }

    /// Hold time in seconds → release quality in 0…1.
    ///
    /// The reference fires the throw for you at `maxHold`; this does not, because a phone
    /// throw that leaves your hand while your thumb is still on the glass is a throw you
    /// did not make. Instead the curve simply keeps decaying and the hold is clamped, so
    /// holding forever is its own punishment and never a surprise.
    public func quality(hold: Double) -> Double {
        let h = Swift.max(0, Swift.min(hold, maxHold))
        let overStart = fullTime + overGrace
        var base: Double
        if h < minTime {
            base = Self.lerp(rushFloor, plateau, smoothstep01(h / Swift.max(1e-6, minTime)))
        } else if h <= overStart {
            base = plateau
        } else {
            let span = Swift.max(1e-6, maxHold - overStart)
            base = Self.lerp(plateau, overFloor, smoothstep01((h - overStart) / span))
        }
        let d = abs(h - fullTime)
        let bump = 1 - smoothstep01(d / Swift.max(1e-6, perfectWindow))
        return clamp01(base + (1 - base) * bump)
    }

    private static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }

    /// The tight centre of the window — what the meter flashes on, and the only release
    /// the game calls perfect out loud.
    public func isPerfect(hold: Double) -> Bool { abs(hold - fullTime) <= perfectWindow * 0.35 }

    /// Anywhere in the window at all. Quality is 1.0 at the centre and falls off across
    /// this, so the band the HUD draws is this one and the flash is `isPerfect`.
    public func inWindow(hold: Double) -> Bool { abs(hold - fullTime) <= perfectWindow }

    public func isRushed(hold: Double) -> Bool { hold < minTime }
    public func isOvercharged(hold: Double) -> Bool { hold > fullTime + overGrace }

    /// How a release should be described to the player in two words.
    public func grade(hold: Double) -> ReleaseGrade {
        if isPerfect(hold: hold) { return .perfect }
        if isRushed(hold: hold) { return .rushed }
        if isOvercharged(hold: hold) { return .overcharged }
        return inWindow(hold: hold) ? .clean : .steady
    }
}

/// What the charge meter just said, in the vocabulary the HUD and the taptic engine
/// both read. Ordered worst to best is deliberately *not* the case order — these are
/// names, not a scale, and the game says a different sentence for each.
public enum ReleaseGrade: String, Equatable, Sendable {
    /// Dead centre of the window.
    case perfect
    /// Inside the window but off centre.
    case clean
    /// On the plateau. The safe throw, and the one most releases are.
    case steady
    /// Let go before the wind-up finished.
    case rushed
    /// Held past the grace. The physics wobbles the nose for this one.
    case overcharged
}
