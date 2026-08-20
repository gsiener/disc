import Foundation

/// The body-vs-body half of `src/sim/Locomotion.ts`: the two separation tiers, the
/// re-seat that follows them, hard contact with momentum transfer, and the stumble /
/// foul call.
///
/// Split out of `Locomotion.swift` because it is the only part of the model that
/// reads more than one player at a time — everything in the main file advances one
/// athlete in isolation.
extension Locomotion {

    /// Two passes, in this order:
    ///
    ///   1. PERSONAL SPACE (`Separation.swift`). Positional, lateral, no velocity
    ///      written. Athletes make room for each other before they touch, so the
    ///      resting separation of two bodies that merely converged is ~1.26 m rather
    ///      than the 0.64 m hard-contact floor. This is what stops twelve off-ball
    ///      bodies reading as one silhouette.
    ///   2. HARD CONTACT (below). Impulses, momentum transfer, stumbles, fouls. Runs
    ///      on the post-separation geometry so it only ever fires on real collisions —
    ///      someone genuinely ran into someone else — rather than on the crowding that
    ///      pass 1 has already resolved.
    ///
    /// Set `separate = false` to run the hard tier alone.
    ///
    /// Both passes move bodies in XZ, and both are followed by a re-seat: the surface
    /// height under a body is sampled during `step()`, before either pass has run, so a
    /// body nudged sideways and left on its old `groundY` renders fractionally into the
    /// turf. It is a tenth of a millimetre in practice, but the contract "groundY is
    /// the surface under this body" is worth having exactly rather than nearly.
    public func resolveCollisions(_ dt: Double, list: [LocoPlayer]? = nil) {
        let list = list ?? players
        if separate { applySeparation(list, dt) }
        resolveContacts(dt, list)
        reseat(list)
    }

    /// Re-read the surface under every grounded body and put its centre of mass back at
    /// the right height above it. Idempotent: for a body that nothing moved this
    /// recomputes exactly what `stepGround` already stored. Airborne bodies are skipped
    /// — their Y is ballistic and belongs to `stepAir`.
    private func reseat(_ list: [LocoPlayer]) {
        for p in list {
            if p.air.airborne { continue }
            // ALIAS SITE. Reference fills the shared `SURF` scratch and then
            // `p.groundN.copy(SURF.n)`; `Vec3d` is a value so this is an assignment.
            let surf = probe.sample(p.pos.x, p.pos.z)
            p.groundY = surf.y
            p.groundN = surf.n
            conformY(p)
        }
    }

    /// Personal space. Jacobi-accumulated so the result does not depend on pair order,
    /// then applied in one go.
    ///
    /// The reference keeps three `Float64Array` scratch buffers on the instance and
    /// grows them when the roster does, purely to avoid an allocation per step. The
    /// Swift `accumulateSeparation` takes `inout [Double]` and allocates its own
    /// per-body radius buffer, so the two accumulators are local here. The numbers are
    /// identical; only the allocation is not.
    private func applySeparation(_ list: [LocoPlayer], _ dt: Double) {
        let n = list.count
        if n < 2 { return }
        var sx = [Double](repeating: 0, count: n)
        var sz = [Double](repeating: 0, count: n)

        discProbe.bind(host?.disc)
        discFocus = discProbe.read()

        sepWork = 0
        sepPairs = accumulateSeparation(list, dt: dt, outX: &sx, outZ: &sz, disc: discFocus)
        if sepPairs == 0 { return }

        for i in 0..<n {
            if sx[i] == 0 && sz[i] == 0 { continue }
            sepWork += Foundation.hypot(sx[i], sz[i])
            let p = list[i]
            p.pos.x += sx[i]
            p.pos.z += sz[i]
            // Carry the planted foot with the body. The foot IK pins the ankle to this
            // world point, so translating the hips without it stretches the leg and the
            // athlete skates. A separation step is footwork; it should move the foot.
            // (The footstep event has already been emitted at the original plant, so the
            // turf scuff and the audio are unaffected.)
            //
            // ALIAS SITE, and the subtle one. In the reference `p.foot.pos` is a live
            // `THREE.Vector3` and `p.foot.pos.x += …` edits the player's foot. Here
            // `FootState` is a value type held by a class, so the write must go through
            // `p.foot` — `var f = p.foot; f.pos.x += …` would edit a copy and be thrown
            // away, which is exactly the bug `Gait.swift` documents at its own returns.
            p.foot.pos.x += sx[i]
            p.foot.pos.z += sz[i]
        }
        // `reseat()` in `resolveCollisions` puts every moved body back on the surface
        // once both passes are done.
    }

    /// Hard contact with momentum transfer. Position correction adds no energy (so
    /// resting contacts do not jitter) and the normal impulse only fires on approach.
    /// Hard contact stumbles the player who was less braced.
    private func resolveContacts(_ dt: Double, _ list: [LocoPlayer]) {
        let n = list.count
        for i in 0..<n {
            let a = list[i]
            for j in (i + 1)..<n {
                let b = list[j]
                if abs(a.pos.y - b.pos.y) > Locomotion.COLLIDE_Y_SPAN { continue }

                var dx = b.pos.x - a.pos.x
                var dz = b.pos.z - a.pos.z
                var dist = Foundation.hypot(dx, dz)
                let rsum = a.radius + b.radius
                if dist >= rsum { continue }

                if dist < 1e-4 {
                    // Perfectly coincident — pick a deterministic axis. Unlike the
                    // separation tier's id-based tie-break this draws from the RNG, so
                    // the stream position matters: the draw happens here, before the
                    // foul draw in `contactReaction`.
                    let ang = rng.next() * Double.pi * 2
                    dx = simCos(ang)
                    dz = simSin(ang)
                    dist = 1e-4
                }
                let nx = dx / dist
                let nz = dz / dist
                let pen = rsum - dist

                let invA = invMass(a)
                let invB = invMass(b)
                let invSum = invA + invB
                if invSum <= 0 { continue }

                // --- positional correction (no velocity change => no jitter)
                let corr = Swift.max(0, pen - Locomotion.COLLIDE_SLOP) * Locomotion.COLLIDE_BETA
                a.pos.x -= nx * corr * (invA / invSum)
                a.pos.z -= nz * corr * (invA / invSum)
                b.pos.x += nx * corr * (invB / invSum)
                b.pos.z += nz * corr * (invB / invSum)

                // --- normal impulse, only when closing
                let rvx = b.vel.x - a.vel.x
                let rvz = b.vel.z - a.vel.z
                let vn = rvx * nx + rvz * nz
                if vn >= 0 { continue }

                let jn = (-(1 + Locomotion.COLLIDE_RESTITUTION) * vn) / invSum
                a.vel.x -= nx * jn * invA
                a.vel.z -= nz * jn * invA
                b.vel.x += nx * jn * invB
                b.vel.z += nz * jn * invB

                // --- tangential friction (shoulders scrape past each other)
                let tx = -nz
                let tz = nx
                let vt = rvx * tx + rvz * tz
                let jt = clamp(
                    (-vt / invSum) * Locomotion.COLLIDE_FRICTION, -jn * 0.8, jn * 0.8)
                a.vel.x -= tx * jt * invA
                a.vel.z -= tz * jt * invA
                b.vel.x += tx * jt * invB
                b.vel.z += tz * jt * invB

                contactReaction(a, b, -vn, nx, nz, dt)
            }
        }
    }

    /// A THROWER ON HIS PIVOT IS IMMOVABLE, because the alternative is not physics — it
    /// is a foul.
    ///
    /// `anchored` already makes the separation tier yield him no ground, but hard
    /// contact split its positional correction by inverse mass, so the marker standing
    /// on him pushed him off his pivot a few centimetres at a time. That is the limit
    /// cycle the travel work could not explain: the inward pull genuinely converged
    /// (traced at 2.17 -> 1.85 -> 1.54 -> 1.23 m) and then contact shoved the body back
    /// out and it started over. Ablating separation changed nothing because separation
    /// was never the tier doing the shoving.
    ///
    /// Infinite mass here means the marker takes the whole correction, which is both
    /// the correct resolution and the correct call: a defender who displaces the
    /// thrower has fouled him.
    private func invMass(_ p: LocoPlayer) -> Double {
        if p.anchored { return 0 }
        // Bracing and being on the ground both make you harder to move.
        let str = clamp01(p.attr.strength / 100)
        let eff = p.attr.mass * (1 + 0.35 * str) * (p.prone ? 2.5 : 1)
        return 1 / Swift.max(1, eff)
    }

    /// Stumbles, falls and the foul call. Ultimate is non-contact.
    private func contactReaction(
        _ a: LocoPlayer, _ b: LocoPlayer, _ impact: Double, _ nx: Double, _ nz: Double,
        _ dt: Double
    ) {
        if impact < 0.8 { return }

        let closeA = a.vel.x * nx + a.vel.z * nz
        let closeB = -(b.vel.x * nx + b.vel.z * nz)
        let foulOn = closeA >= closeB ? a.id : b.id
        let chance = clamp01((impact - 1.6) / 5.0)
        let called = rng.next() < chance

        emit(.contact(a: a.id, b: b.id, impact: impact, foulOn: foulOn, called: called))

        maybeStumble(a, impact * (b.attr.mass / a.attr.mass))
        maybeStumble(b, impact * (a.attr.mass / b.attr.mass))
    }

    private func maybeStumble(_ p: LocoPlayer, _ impact: Double) {
        if committedStates.contains(p.state) { return }
        let bal = clamp01(p.attr.balance / 100)
        let str = clamp01(p.attr.strength / 100)
        let resist = 2.0 + 2.5 * bal + 1.5 * str
        if impact <= resist { return }
        if impact > resist * 1.9 {
            p.prone = true
            enter(p, .fall, clamp(0.25 + 0.05 * impact, 0.25, 0.6))
            return
        }
        let dur = clamp(0.25 + 0.18 * (impact - resist), 0.25, 0.90)
        if p.state == .stumble && p.stateDur >= dur { return }
        enter(p, .stumble, dur)
    }
}
