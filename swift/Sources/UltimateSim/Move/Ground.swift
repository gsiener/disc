import Foundation

/// Surface queries against whatever the field system exposes. The field system
/// is authored concurrently, so we never assume it exists nor that it has any
/// particular method — we duck-type `heightAt` / `normalAt` every call and fall
/// back to a flat plane at y=0 with an up normal.
///
/// Ported from `src/sim/move/Ground.ts`. The reference duck-types a field off an
/// untyped system registry (`sys['field']`) and threads a scratch `THREE.Vector3`
/// through `normalAt` to avoid an allocation per query. Neither concern applies
/// in Swift: `FieldLike?` already expresses "may not exist" with a real type, and
/// `Vec3d` is a value, so `normalAt` just returns one instead of writing through
/// an out-parameter. The numeric behaviour — the flat-plane fallback, the
/// finite/`n.y` guards — is unchanged.
public struct FieldLike {
    public var heightAt: ((Double, Double) -> Double)?
    public var normalAt: ((Double, Double) -> Vec3d)?

    public init(
        heightAt: ((Double, Double) -> Double)? = nil,
        normalAt: ((Double, Double) -> Vec3d)? = nil
    ) {
        self.heightAt = heightAt
        self.normalAt = normalAt
    }
}

public struct Surface: Equatable {
    public var y: Double
    public var n: Vec3d
    public init(y: Double, n: Vec3d) {
        self.y = y
        self.n = n
    }
}

private let UP = Vec3d(0, 1, 0)

public final class GroundProbe {
    /// Set true the first time a real field is found; useful for debug.
    public private(set) var hasField = false

    private var field: FieldLike?

    public init() {}

    /// Re-resolve the field system. Cheap; call per frame.
    public func bind(_ field: FieldLike?) {
        self.field = (field?.heightAt != nil) ? field : nil
        hasField = self.field != nil
    }

    public func heightAt(_ x: Double, _ z: Double) -> Double {
        guard let h = field?.heightAt else { return 0 }
        let y = h(x, z)
        return y.isFinite ? y : 0
    }

    public func normalAt(_ x: Double, _ z: Double) -> Vec3d {
        guard let n = field?.normalAt else { return UP }
        let nv = n(x, z)
        if !nv.x.isFinite || !nv.y.isFinite || nv.y <= 1e-4 { return UP }
        return nv.normalized
    }

    public func sample(_ x: Double, _ z: Double) -> Surface {
        Surface(y: heightAt(x, z), n: normalAt(x, z))
    }
}

/// Grade in the direction of travel: +1 is straight up a 45-degree wall.
/// Returns 0 on flat ground or when the direction is degenerate.
public func gradeAlong(_ n: Vec3d, dx: Double, dz: Double) -> Double {
    let len = Foundation.hypot(dx, dz)
    if len < 1e-6 || n.y <= 1e-4 { return 0 }
    // Height gradient of the surface is (-nx/ny, -nz/ny); travelling uphill along
    // d means a positive dot with that gradient.
    let gx = -n.x / n.y
    let gz = -n.z / n.y
    return (gx * dx + gz * dz) / len
}

/// Speed/accel multiplier from terrain grade. Fields are near flat, so gentle.
public func slopeMultiplier(_ grade: Double) -> Double {
    clamp(1 - 1.6 * grade, 0.6, 1.15)
}
