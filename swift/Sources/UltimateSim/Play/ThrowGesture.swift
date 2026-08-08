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
