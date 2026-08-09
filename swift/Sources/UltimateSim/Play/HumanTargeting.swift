import Foundation

/// Who the player meant, and how much help they get hitting them.
///
/// **Without this the game is watchable and not playable.** A drag gives a direction; a
/// receiver is running. Throwing at where somebody *is* misses them by however far they
/// travel during the flight, which at 7 m/s over a two-second huck is fourteen metres — so
/// a human had to lead every target by eye, with no feedback, against a disc that also
/// curves. The AI does not have this problem: `TeamAI` solves a converging lead and hands
/// `Engine` a point. This gives the player the same two things the reference gives them.
///
/// Ported from `Game.ts`. The reference drives selection from a separate stick; a phone has
/// one drag, so the drag direction is both the aim and the select — which is what the
/// reference's cone is for anyway, being "a generous cone because the stick is a coarse
/// instrument".
///
/// Written against plain values rather than against `Engine` so the checks can drive it
/// directly. Every constant is the reference's, and the reference marks them as targets
/// asserted by its own harness rather than preferences.
public enum HumanTargeting {

    /// Half-angle of the directional-select cone. The brief's 35 degrees.
    public static let selectCone = 35 * Double.pi / 180
    /// Selection score weights: 60% angular fit, 25% lane, 15% distance sanity.
    public static let wAngle = 0.60
    public static let wLane = 0.25
    public static let wDist = 0.15
    /// Below this the lane is too short to be a pass at all, metres.
    public static let selectMinRange = 1.5
    /// Aim assist only engages inside this much raw error. The brief's 12 degrees.
    public static let assistWindow = 12 * Double.pi / 180
    /// And may never rotate the release by more than this. The brief's 5 degrees.
    public static let assistMax = 5 * Double.pi / 180

    /// A body as the targeting layer needs it.
    public struct Body {
        public let id: Int
        public let team: TeamId
        public let pos: Vec3d
        public let vel: Vec3d
        public let attr: AIAttributes
        public let energy: Double
        /// `Locomotion.isAvailable` — a body mid-fall is not a receiver.
        public let available: Bool

        public init(
            id: Int, team: TeamId, pos: Vec3d, vel: Vec3d, attr: AIAttributes,
            energy: Double, available: Bool
        ) {
            self.id = id
            self.team = team
            self.pos = pos
            self.vel = vel
            self.attr = attr
            self.energy = energy
            self.available = available
        }
    }

    /// `Game.ts:smooth01`.
    static func smooth01(_ x: Double, _ edge0: Double, _ edge1: Double) -> Double {
        let span = edge1 - edge0
        let t = clamp((x - edge0) / (span == 0 ? 1e-6 : span), 0, 1)
        return t * t * (3 - 2 * t)
    }

    /// Shortest signed angle in (-pi, pi]. `Game.ts:wrapPi`.
    static func wrapPi(_ a: Double) -> Double {
        var v = a.truncatingRemainder(dividingBy: .pi * 2)
        if v > .pi {
            v -= .pi * 2
        } else if v <= -.pi {
            v += .pi * 2
        }
        return v
    }

    /// How blocked the straight lane from the disc to a receiver is, 0…1.
    ///
    /// The same model `TeamAI.laneBlockage` runs — a defender counts for how much of the
    /// corridor he can get a hand into by the time the disc arrives, scaled by his
    /// awareness — but expressed against a ground corridor rather than a sampled flight,
    /// and built out of `AI.ts`'s own `effectiveMaxSpeed` and `throwFlightTime` so the two
    /// cannot drift apart in their tuning.
    ///
    /// The first 0.6 m and the last 22% are skipped for the reason the AI skips them: the
    /// release window belongs to the mark and the tail belongs to the receiver's own
    /// defender, which is separation rather than blockage.
    public static func laneBlockage(
        from ox: Double, _ oz: Double, to target: Body, bodies: [Body]
    ) -> Double {
        let len = distXZ(Vec3d(ox, 0, oz), target.pos)
        guard len >= 1e-3 else { return 0 }
        let ux = (target.pos.x - ox) / len
        let uz = (target.pos.z - oz) / len
        let tf = throwFlightTime(scratch(target), .backhand, len)

        var worst = 0.0
        for f in bodies where f.team != target.team {
            guard f.available else { continue }
            let rx = f.pos.x - ox
            let rz = f.pos.z - oz
            let along = rx * ux + rz * uz
            if along < 0.6 || along > len * 0.78 { continue }
            let perp = abs(rx * uz - rz * ux)
            let t = (along / len) * tf
            let reachable = 0.60 + effectiveMaxSpeed(scratch(f)) * Swift.max(0, t - 0.14) * 0.72
            let awareness = 0.55 + 0.45 * (f.attr.defAwareness / 100)
            let w = clamp((reachable - perp) / 1.4, 0, 1) * awareness
            if w > worst { worst = w }
        }
        return clamp(worst, 0, 0.97)
    }

    /// `effectiveMaxSpeed` and `throwFlightTime` take an `AIPlayer`; this makes one that
    /// carries the only two fields either of them reads.
    private static func scratch(_ b: Body) -> AIPlayer {
        AIPlayer(id: b.id, team: b.team, attr: b.attr, archetype: .cutter, energy: b.energy)
    }

    /// Resolve a drag direction to the teammate it means, or nil if the cone is empty.
    ///
    /// The cone is generous because a drag is a coarse instrument. The lane term is what
    /// stops it handing you the player standing behind a defender, and the distance term is
    /// what stops a 2 m dish and a 55 m prayer from outscoring the 20 m cut you were
    /// obviously looking at.
    public static func resolveConeSelect(
        dx: Double, dz: Double, thrower: Body, bodies: [Body]
    ) -> Int? {
        let l = (dx * dx + dz * dz).squareRoot()
        guard l > 1e-3 else { return nil }
        let ux = dx / l
        let uz = dz / l
        let ox = thrower.pos.x
        let oz = thrower.pos.z

        var best: Int?
        var bestScore = -1.0
        for r in bodies where r.team == thrower.team && r.id != thrower.id {
            guard r.available else { continue }
            let vx = r.pos.x - ox
            let vz = r.pos.z - oz
            let d = (vx * vx + vz * vz).squareRoot()
            if d < selectMinRange { continue }
            let cosine = clamp((vx * ux + vz * uz) / d, -1, 1)
            let angle = acos(cosine)
            if angle > selectCone { continue }

            let angular = 1 - angle / selectCone
            let openness = 1 - laneBlockage(from: ox, oz, to: r, bodies: bodies)
            // Everything from a 6 m dish out to a 30 m strike is worth full marks,
            // tapering to nothing at the 46 m the arm cannot reach anyway.
            let sanity = smooth01(d, 2.0, 6.0) * (1 - smooth01(d, 30, 46))
            let score = wAngle * angular + wLane * openness + wDist * sanity
            if score > bestScore {
                bestScore = score
                best = r.id
            }
        }
        return best
    }

    /// What the assist did, so the HUD can show it and a check can assert it.
    public struct Assist: Equatable, Sendable {
        /// The heading to release on, after any rotation.
        public let yaw: Double
        /// Signed error between the raw aim and the ideal lead, radians.
        public let leadError: Double
        /// Signed rotation applied, radians. Zero when the assist declined.
        public let applied: Double
    }

    /// Quality-scaled aim assist.
    ///
    /// If the raw aim is already within 12 degrees of the ideal lead, rotate toward the
    /// lead by up to 5 degrees, scaled by release quality — a clean release gets all five,
    /// a rushed one almost none. **Timing skill buys accuracy; it does not buy aim.**
    /// Outside the window nothing happens at all, because at that point the player is
    /// throwing somewhere else on purpose and the disc must go there.
    ///
    /// The lead is solved against the receiver's own velocity in two passes, which is the
    /// same converging lead `AI.ts` uses and is accurate to well inside the five degrees
    /// this is allowed to move.
    public static func assistedYaw(
        rawYaw: Double, quality: Double, power: Double, from: Vec3d, receiver: Body?
    ) -> Assist {
        guard let r = receiver else {
            return Assist(yaw: rawYaw, leadError: 0, applied: 0)
        }
        let speed = clamp(9 + 19 * power, 8, 27)
        var lx = r.pos.x
        var lz = r.pos.z
        for _ in 0..<2 {
            let d = distXZ(Vec3d(lx, 0, lz), from)
            let t = clamp(d / (speed * 0.82), 0, 3.5)
            lx = r.pos.x + r.vel.x * t
            lz = r.pos.z + r.vel.z * t
        }
        let ideal = atan2(lx - from.x, lz - from.z)
        let err = wrapPi(ideal - rawYaw)
        guard abs(err) <= assistWindow else {
            return Assist(yaw: rawYaw, leadError: err, applied: 0)
        }
        let rot = clamp(err, -assistMax, assistMax) * clamp(quality, 0, 1)
        return Assist(yaw: rawYaw + rot, leadError: err, applied: rot)
    }
}
