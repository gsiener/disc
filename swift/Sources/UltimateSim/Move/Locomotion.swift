import Foundation

/// ============================================================================
/// LOCOMOTION — the player movement model
/// ============================================================================
///
/// Ported from `src/sim/Locomotion.ts`. Designed for a FIXED 1/120 s timestep.
/// Everything is deterministic: no wall-clock reads, no allocation-dependent
/// behaviour, and the only randomness comes from a seeded `Rng`.
///
/// ---------------------------------------------------------------- how to use
///
/// ```swift
/// let loco = Locomotion()
/// loco.attach(LocoHost(events: { log.append($0) }))
/// let p = loco.create(CreateOpts(id: 3, team: 0, attr: attr, pos: Vec3d(0, 0, -12)))
///
/// // once per fixed step, per player, driven by the AI system:
/// loco.step(p, DesiredMove(dir: toTarget, mode: .sprint), dt)
/// // ...then once per fixed step, after every player has stepped:
/// loco.resolveCollisions(dt)
/// ```
///
/// ------------------------------------------------------------ the input side
///
/// `DesiredMove` is the AI system's request, not a command. The model may refuse or
/// delay any of it. A layout cannot be cancelled once accepted, a jump has a gather
/// phase, a hard cut has a plant that must play out, and no request can reverse a
/// velocity instantly — a direction change is always paid for with braking impulse
/// and re-acceleration, which is why a 90-degree cut leaves ~30% of your speed on
/// the grass.
///
/// ----------------------------------------------------------- the output side
///
/// `step()` mutates and returns the same `LocoPlayer`. Consumers read `pos`, `vel`,
/// `facing`, `state`/`stateT`/`prone`, `foot`, `air`, `stamina`, `derived`, and ask
/// `Locomotion.isAvailable(p)` whether the body is in the play at all.
///
/// ------------------------------------------------------------- ground truth
///
/// Surface height and normal come from `host.field` when a field system exists;
/// otherwise a flat plane at y=0. The field system is authored concurrently, so this
/// is re-resolved every step.
///
/// ------------------------------------------------- what the port changed, and why
///
/// The reference threads a module-level scratch `Surface` (`SURF`) and scratch
/// vector (`V3A`) through every probe and every event, purely to avoid allocating a
/// `THREE.Vector3` per call. Both disappear here: `GroundProbe.sample` returns a
/// `Surface` value and `Vec3d` is a value, so `p.groundN.copy(SURF.n)` becomes
/// `p.groundN = surf.n` and `V3A.set(x, y, z).clone()` becomes `Vec3d(x, y, z)`.
/// **Every such site is an alias-mutation site in the reference and an assignment
/// here**, and each is marked in the code below, because getting one wrong is the
/// single most likely bug in this port: in TypeScript `p.pos` and `SURF.n` are
/// references that outlive the statement, and in Swift they are not.
public final class Locomotion {

    // MARK: - tuning

    /// Angle between current velocity and requested direction that forces a plant.
    ///
    /// Written as the reference writes it, `45 * Math.PI / 180` left to right, purely so
    /// the two files read the same. It is worth being precise about why: these two
    /// spellings are **bit-identical** here — both are 0x3fe921fb54442d18 — because 45/180
    /// is exactly 1/4 and scaling a double by a power of two is exact. An earlier comment
    /// claimed they differed in the last bit, and a mutation test proved that wrong by
    /// swapping in `Double.pi / 4` and watching all 87,643 assertions still pass.
    ///
    /// The general worry is real and applies elsewhere in this port — `3x²−2x³` versus
    /// `x*x*(3−2x)` genuinely do differ. It just does not apply to this constant.
    public static let CUT_ANGLE = 45 * Double.pi / 180
    /// Below this speed you can just pivot; no plant needed.
    public static let CUT_MIN_SPEED = 2.2
    /// Grip multiplier while the cut foot is planted.
    public static let PLANT_GRIP = 1.8
    /// Brake multiplier while the cut foot is planted.
    public static let PLANT_BRAKE = 1.35
    /// Extra speed lost to the plant impact itself, at a full 180.
    public static let CUT_LOSS_BASE = 0.28
    /// Minimum gap between the end of one cut and the start of the next.
    public static let CUT_REFRACTORY = 0.22

    public static let JUMP_GATHER = 0.12
    public static let LAYOUT_GATHER = 0.06
    /// Horizontal speed retained through a vertical takeoff.
    public static let JUMP_HORIZ_KEEP = 0.88
    /// Air steering authority (m/s^2) — small, you are a projectile.
    public static let AIR_CONTROL = 0.7

    /// Kinetic friction of a sliding body on grass, as a deceleration (m/s^2).
    public static let SLIDE_DECEL = 15.7
    /// Horizontal speed retained on a two-foot landing.
    public static let LAND_HORIZ_KEEP = 0.62

    public static let COLLIDE_BETA = 0.80
    public static let COLLIDE_SLOP = 0.002
    public static let COLLIDE_RESTITUTION = 0.03
    public static let COLLIDE_FRICTION = 0.45
    /// Vertical separation beyond which two players simply miss each other.
    public static let COLLIDE_Y_SPAN = 1.0

    public static let DEFAULT_RADIUS = 0.32

    // MARK: - the pivot
    //
    // THE ONE CONSTRAINT THE SPORT IS BUILT ON: possession may not advance except
    // through the air. A thrower has one foot he may not move.
    //
    // Ultimate does not freeze a receiver the instant the disc touches his hands —
    // WFDF 18.2 / USAU 12.3 give him the steps he needs to stop. So this is two
    // regimes, not one:
    //
    //   GRACE   From the moment he is anchored until he is walking pace (or until
    //           the allowance runs out), his feet are his own. This is the momentum
    //           he arrived with, and the rules pay for it. The pivot is established
    //           where he ENDS this, not where he caught it, which is also how the
    //           yardage works in the real game.
    //   LOCKED  One foot is now a fixed point and the leg from it to the body is
    //           inextensible at PIVOT_R. Inside that disc he is free — he may turn,
    //           lean, step the free foot anywhere it reaches. At full stretch the
    //           leg pushes back, and the push is finite: PIVOT_ARREST is what a
    //           planted leg can take out of a moving body. Under that, the body is
    //           held and the foot does not move at all. Over it — a man who tries to
    //           run out of his own pivot, or one shoved hard — the foot is dragged,
    //           and the metres it is dragged are exactly what `isTravel` measures
    //           against `travelTolerance`.
    //
    // The arithmetic that ties the two constants to the rule: a body arriving at full
    // stretch with outward speed v drags the foot about v²/(2·PIVOT_ARREST) before the
    // leg wins. PIVOT_ARREST is set from the one case that has to stay legal — a
    // handler lunging out to a break-side throw. He can cover the 0.75 m from the
    // middle of his own stance at about 3.2 m/s while still driving, and at 30 m/s² the
    // leg takes that off him inside 0.21 m, comfortably under the 0.35 m tolerance.
    // Clearing the tolerance needs better than 4 m/s at full stretch, which no body
    // reaches inside the pivot disc — only one that was already running when the foot
    // went down. That is the intended shape: pivoting hard is free, carrying is a
    // travel.

    /// How far the body centre may sit from the established pivot foot (m).
    public static let PIVOT_R = 0.75
    /// Deceleration a planted leg can take out of the body it is holding (m/s^2).
    public static let PIVOT_ARREST = 30.0
    /// At or below this ground speed the receiver has stopped and the pivot locks.
    public static let PIVOT_STOP_SPEED = 1.2
    /// Longest momentum-arresting window after gaining possession (s).
    public static let PIVOT_GRACE = 1.5
    /// One long step of slack on top of a maximal stop, before it is carrying (m).
    public static let PIVOT_STOP_SLACK = 0.6
    /// And no receiver is owed more than this, whatever he caught it at (m).
    ///
    /// A full-speed catch genuinely needs three metres or so of grass to stop in, and
    /// the rules pay for them. Nothing pays for more: past that a man is not stopping,
    /// he is running, and the budget has to end somewhere the offence cannot lean on.
    /// The exact figure is set by the reference harness, which holds the worst momentum
    /// excursion measured from the catch under 4.5 m — this cap plus the pivot radius
    /// plus a landing is what fits inside that.
    public static let PIVOT_CARRY_MAX = 3.2

    /// Live state of one holder's pivot. A struct in a dictionary, matching the
    /// reference's `Map<number, PivotState>`.
    struct PivotState {
        /// Sim time (this player's own clock) the grace window opened.
        var t0: Double
        /// True once the foot is established and may no longer be picked up.
        var locked: Bool
        /// World XZ of the established foot. Slips only when the leg is overpowered.
        var x: Double
        var z: Double
        /// Where the grace window opened, and how far it is allowed to run from there.
        var gx: Double
        var gz: Double
        var budget: Double
    }

    // MARK: - identity as a system

    public let name = "locomotion"
    public let order = 7

    /// When driven as a system, `update()` resolves collisions.
    public var autoResolve = true

    /// Run the soft personal-space pass before hard contact. See `Separation.swift`.
    public var separate = true

    /// Pairs the last separation pass engaged, and the metres it moved. Debug.
    public internal(set) var sepPairs = 0
    public internal(set) var sepWork = 0.0

    public private(set) var players: [LocoPlayer] = []

    var host: LocoHost?
    let probe = GroundProbe()
    /// Seeded from the reference's literal default when no parent stream is attached.
    var rng = Rng(seed: 0x10c0_5eed)
    var byId: [Int: LocoPlayer] = [:]
    var lastCutEnd: [Int: Double] = [:]
    var pivots: [Int: PivotState] = [:]
    let discProbe = DiscProbe()
    var discFocus = DiscFocus(x: 0, z: 0, live: false)

    public init() {}

    // MARK: - lifecycle

    /// Bind to the engine. `LocoHost` is a value, so this is a snapshot: rebind to
    /// hand the model a field system that only came into existence later.
    public func attach(_ host: LocoHost) {
        self.host = host
        if let parent = host.rand { rng = parent.fork(salt: 0x10c0) }
        probe.bind(host.field)
    }

    public func update(_ dt: Double) {
        if autoResolve { resolveCollisions(dt) }
    }

    // MARK: - roster

    @discardableResult
    public func create(_ opts: CreateOpts) -> LocoPlayer {
        let attr = opts.attr ?? .defaultAttrs
        let hipHeight = 0.53 * attr.height
        // `opts.pos ? opts.pos.clone() : new THREE.Vector3()` then `pos.y = ...`. The
        // clone is what stops `create` writing Y back into the caller's vector; a
        // `Vec3d` copy is structural, so the same protection is free here.
        let src = opts.pos ?? .zero
        let pos = Vec3d(src.x, probe.heightAt(src.x, src.z) + hipHeight, src.z)

        let stamina = opts.stamina ?? 100
        let radius = opts.radius ?? Locomotion.DEFAULT_RADIUS

        let p = LocoPlayer(
            id: opts.id,
            attr: attr,
            pos: pos,
            vel: .zero,
            facing: opts.facing ?? 0,
            state: .idle,
            prone: false,
            anchored: false,
            foot: FootState(
                planted: .right,
                pos: Vec3d(pos.x, pos.y - hipHeight, pos.z),
                t: 0,
                contact: true,
                phase: 0,
                stride: 0,
                hard: false,
                speed: 0
            ),
            air: AirState(),
            groundY: pos.y - hipHeight,
            radius: radius,
            personal: Swift.max(radius, opts.personal ?? PERSONAL_RADIUS),
            hipHeight: hipHeight,
            cmd: .zero,
            t: 0,
            team: opts.team,
            stateT: 0,
            stateDur: 0,
            stamina: stamina,
            groundN: Vec3d(0, 1, 0),
            cutDir: .zero,
            cutEntrySpeed: 0,
            cutAngle: 0,
            lastStepT: 0,
            derived: derive(attr, stamina: stamina, speed: 0, mode: .run)
        )
        // Deterministic gait offset so a whole team does not march in lockstep. `fork`
        // does not disturb this generator's own stream, so the roster can grow without
        // shifting any later contact draw.
        p.foot.phase = rng.fork(salt: opts.id * 977 + 11).next() * 0.999
        players.append(p)
        byId[p.id] = p
        return p
    }

    public func get(_ id: Int) -> LocoPlayer? { byId[id] }

    public func remove(_ id: Int) {
        guard let p = byId[id] else { return }
        byId.removeValue(forKey: id)
        pivots.removeValue(forKey: id)
        // `indexOf` is identity comparison in JS; `LocoPlayer` is a class, so `===` is
        // the faithful translation and not `==`.
        if let i = players.firstIndex(where: { $0 === p }) { players.remove(at: i) }
    }

    // MARK: - queries

    public static func isAvailable(_ p: LocoPlayer) -> Bool {
        !unavailableStates.contains(p.state)
    }
    public static func isCommitted(_ p: LocoPlayer) -> Bool {
        committedStates.contains(p.state)
    }
    public func isAvailable(_ p: LocoPlayer) -> Bool { !unavailableStates.contains(p.state) }

    /// Fingertip height `t` seconds from now.
    public func reachAt(_ p: LocoPlayer, t: Double = 0) -> Double {
        UltimateSim.reachAt(p, t: t)
    }

    /// Predicted COM position `t` seconds from now.
    public func predictPos(_ p: LocoPlayer, t: Double) -> Vec3d {
        UltimateSim.predictPos(p, t: t)
    }

    /// Peak height this player could reach if they left the ground right now.
    public func peakReach(_ p: LocoPlayer) -> Double {
        let speed = Foundation.hypot(p.vel.x, p.vel.z)
        let d = derive(p.attr, stamina: p.stamina, speed: speed, mode: .sprint)
        return p.groundY + p.attr.height * 1.30 + leapHeight(d, approachSpeed: speed)
    }

    /// Resolve two players going up for the same disc.
    ///
    /// The jitter draw comes off this model's stream, so it is reproducible from the
    /// seed — and it is drawn *before* `contestAir`, which matters for stream order.
    public func contest(
        _ a: LocoPlayer, _ b: LocoPlayer, discPos: Vec3d, tContest: Double
    ) -> ContestResult {
        let jitter = rng.next() * 2 - 1
        return contestAir(a, b, discPos: discPos, tContest: tContest, jitter: jitter)
    }

    // MARK: - AI peer contract

    /// Used by the AI to skip un-steerable bodies.
    public func isAirborne(_ p: LocoPlayer) -> Bool { p.air.airborne }

    /// The by-id form, for an AI record that carries no air state of its own.
    public func isAirborne(id: Int) -> Bool { byId[id]?.air.airborne ?? false }

    /// Seconds for this player to get to `(x, z)`, including the speed they will scrub
    /// turning toward it.
    public func timeToReach(_ p: LocoPlayer, x: Double, z: Double) -> Double {
        timeToReach(
            px: p.pos.x, pz: p.pos.z, vx: p.vel.x, vz: p.vel.z,
            cap: derive(p.attr, stamina: p.stamina, speed: 0, mode: .sprint),
            x: x, z: z)
    }

    /// The same, for any `{id, pos, vel, attr}` the AI hands us. If the id is one of
    /// ours we use our own ratings and stamina; otherwise the AI's ratings are
    /// translated and assumed fresh, exactly as `deriveLoose` does.
    public func timeToReach(_ a: AthleteLike, x: Double, z: Double) -> Double {
        let mine = a.id.flatMap { byId[$0] }
        let cap =
            mine.map { derive($0.attr, stamina: $0.stamina, speed: 0, mode: .sprint) }
            ?? derive(fromAIAttributes(a.attr ?? [:]), stamina: 100, speed: 0, mode: .sprint)
        return timeToReach(
            px: a.posX ?? mine?.pos.x ?? 0,
            pz: a.posZ ?? mine?.pos.z ?? 0,
            vx: a.velX ?? mine?.vel.x ?? 0,
            vz: a.velZ ?? mine?.vel.z ?? 0,
            cap: cap, x: x, z: z)
    }

    private func timeToReach(
        px: Double, pz: Double, vx: Double, vz: Double, cap: Derived, x: Double, z: Double
    ) -> Double {
        let d = Foundation.hypot(x - px, z - pz)
        if d < 1e-3 { return 0 }

        let top = Swift.max(0.5, cap.topSpeed)
        let A = Swift.max(0.5, cap.accelMax)

        // Entry speed after turning: the geometric scrub of a cut, plus the plant.
        let s = Foundation.hypot(vx, vz)
        var v0 = 0.0
        var extra = 0.0
        if s > 1e-4 {
            let cosang = ((x - px) * vx + (z - pz) * vz) / (d * s)
            let ang = Foundation.acos(clamp(cosang, -1, 1))
            // Two separate `cos(ang / 2)` calls in the reference, multiplied together
            // rather than squared. Same value, and kept as two calls on purpose.
            v0 =
                s * Swift.max(0, Foundation.cos(ang / 2))
                * Swift.max(0, Foundation.cos(ang / 2))
            if ang > Locomotion.CUT_ANGLE { extra = cap.plantDur }
        }

        // Invert x(t) = top*t - (top/A)(top - v0)(1 - e^(-tA/top)) by Newton.
        let tau = top / A
        let k = tau * (top - v0)
        var t = d / top + (top - v0) / (2 * A)
        for _ in 0..<8 {
            let e = Foundation.exp(-t / tau)
            let f = top * t - k * (1 - e) - d
            let df = top - (k / tau) * e
            if abs(df) < 1e-9 { break }
            let nt = t - f / df
            if !nt.isFinite { break }
            t = Swift.max(0, nt)
        }
        return t + extra
    }

    /// Consume one `PlayerIntent` from the AI system and step it.
    @discardableResult
    public func stepIntent(_ p: LocoPlayer, _ intent: IntentLike, _ dt: Double) -> LocoPlayer {
        step(p, intentToDesired(p, intent), dt)
    }

    public func intentToDesired(_ p: LocoPlayer, _ intent: IntentLike) -> DesiredMove {
        let dx = (intent.targetX ?? p.pos.x) - p.pos.x
        let dz = (intent.targetZ ?? p.pos.z) - p.pos.z
        let d = Foundation.hypot(dx, dz)

        let pose = POSE_MODES.contains(intent.mode ?? "")
        let gait: MoveMode =
            intent.mode == "sprint"
            ? .sprint
            : intent.mode == "jog"
                ? .jog
                : intent.mode == "backpedal"
                    ? .backpedal
                    : intent.mode == "shuffle" ? .shuffle : .run

        var speed = intent.desiredSpeed ?? intent.maxSpeed
        if intent.mode == "idle" { speed = 0 }
        // Arrive: taper inside the arrival radius so nobody orbits their target.
        let ar = intent.arriveRadius ?? 0.6
        if let s = speed, ar > 1e-3, d < ar { speed = s * clamp01(d / ar) }
        if d < 0.04 { speed = 0 }

        let action = intent.action
        var out = DesiredMove(
            dir: d > 1e-4 ? Vec2d(dx / d, dz / d) : nil,
            speed: speed,
            maxSpeed: intent.maxSpeed,
            mode: pose ? .run : gait,
            face: (intent.faceX != nil && intent.faceZ != nil)
                ? Vec2d(intent.faceX!, intent.faceZ!) : nil
        )
        if intent.mode == "jump" || action?.kind == "jump" { out.jump = true }
        if intent.mode == "layout" || action?.kind == "bid" {
            out.layout = true
            if action?.kind == "bid", let ax = action?.x, let az = action?.z {
                let bx = ax - p.pos.x
                let bz = az - p.pos.z
                let bl = Foundation.hypot(bx, bz)
                if bl > 1e-4 { out.dir = Vec2d(bx / bl, bz / bl) }
            }
        }
        return out
    }

    /// Step every intent then resolve contacts once.
    ///
    /// The reference overloads its third parameter as `WorldLike | number | null` so
    /// the caller can pass either a world or a dt. Swift has real overloads, so the
    /// union is gone: this is the no-world form, and `apply(_:dt:world:)` is the one
    /// that mirrors state back.
    public func apply(_ intents: [IntentLike], dt: Double = 1.0 / 120.0) {
        for it in intents {
            if let p = byId[it.id] { stepIntent(p, it, dt) }
        }
        resolveCollisions(dt)
    }

    public func apply(
        _ intents: [IntentLike], dt: Double = 1.0 / 120.0, world: inout [WorldPlayerRecord]
    ) {
        apply(intents, dt: dt)
        syncTo(&world)
    }

    /// Copy pos/vel/airborne onto the plain records the AI owns.
    ///
    /// The reference guards each write with `if (w.pos)` — a record with no `pos` field
    /// keeps not having one. That is why `pos`/`vel` are optional here and a `nil` one
    /// is left `nil` rather than filled in.
    public func syncTo(_ out: inout [WorldPlayerRecord]) {
        for i in out.indices {
            guard let p = byId[out[i].id] else { continue }
            if out[i].pos != nil { out[i].pos = Vec3d(p.pos.x, p.pos.y, p.pos.z) }
            if out[i].vel != nil { out[i].vel = Vec3d(p.vel.x, p.vel.y, p.vel.z) }
            out[i].airborne = p.air.airborne
        }
    }

    // MARK: - main step

    /// Advance one player by one fixed timestep. Call once per player per sim tick,
    /// then `resolveCollisions(dt)` once.
    @discardableResult
    public func step(_ p: LocoPlayer, _ desired: DesiredMove, _ dt: Double) -> LocoPlayer {
        var dt = dt
        if !(dt > 0) { return p }
        if dt > 1.0 / 30.0 { dt = 1.0 / 30.0 }

        probe.bind(host?.field)

        p.t += dt
        p.stateT += dt

        // Record the commanded line for the separation pass. `solveGround` refines this
        // once it has resolved cuts and braking; this is the fallback for the airborne
        // and committed paths, which never reach the solver.
        if let d = desired.dir, !desired.brake {
            let l = Foundation.hypot(d.x, d.z)
            p.cmd.x = l > 1e-5 ? d.x / l : 0
            p.cmd.z = l > 1e-5 ? d.z / l : 0
        } else {
            p.cmd.x = 0
            p.cmd.z = 0
        }

        // ALIAS SITE. Reference: `this.probe.sample(p.pos.x, p.pos.z, SURF)` fills a
        // shared scratch surface, then `p.groundN.copy(SURF.n)` copies out of it. Both
        // the scratch and the copy exist only to dodge allocation.
        let surf = probe.sample(p.pos.x, p.pos.z)
        p.groundY = surf.y
        p.groundN = surf.n

        if p.air.airborne {
            stepAir(p, desired, dt)
        } else {
            stepGround(p, desired, dt)
        }

        stepPivot(p, dt)
        stepStamina(p, dt)
        return p
    }

    // MARK: - pivot

    /// The disc holder's pivot foot. Runs after the solve, because it is a constraint
    /// on where the body ended up rather than a force in the budget: the friction
    /// ellipse decides how the man moves, and then his own planted leg decides how far
    /// that is allowed to take him.
    ///
    /// Engaged by `anchored`, which the play layer already sets for exactly one body —
    /// the thrower in LIVE_POSSESSION — and clears the moment he releases. See the
    /// note on `PIVOT_R` for the model.
    private func stepPivot(_ p: LocoPlayer, _ dt: Double) {
        if !p.anchored {
            pivots.removeValue(forKey: p.id)
            return
        }

        var s = pivots[p.id] ?? openGrace(p)

        // A body off its feet has no pivot foot to stand on. A sky catch or a knock-down
        // suspends the pivot and gives him the time back — but NOT the ground. The
        // budget is measured from where he gained the disc and is never refilled,
        // because a man who lands, jogs three metres, stumbles and jogs three more has
        // still walked six metres up the pitch with it.
        if p.air.airborne || p.prone {
            s.locked = false
            s.t0 = p.t
            s.x = p.foot.pos.x
            s.z = p.foot.pos.z
            pivots[p.id] = s
            return
        }

        let speed = Foundation.hypot(p.vel.x, p.vel.z)
        if !s.locked {
            let run = Foundation.hypot(p.pos.x - s.gx, p.pos.z - s.gz)
            if speed > Locomotion.PIVOT_STOP_SPEED && p.t - s.t0 < Locomotion.PIVOT_GRACE
                && run < s.budget
            {
                // Still arresting. His feet are his own; track them so the lock lands on
                // the foot he is actually standing on.
                s.x = p.foot.pos.x
                s.z = p.foot.pos.z
                pivots[p.id] = s
                return
            }
            s.locked = true
            s.x = p.foot.pos.x
            s.z = p.foot.pos.z
        }

        // Locked. The foot is a fixed point in the world; the gait no longer owns it, so
        // write it back over whatever the stride solver did with it.
        p.foot.pos.x = s.x
        p.foot.pos.z = s.z
        p.foot.pos.y = p.groundY
        p.foot.contact = true

        let dx = p.pos.x - s.x
        let dz = p.pos.z - s.z
        let r = Foundation.hypot(dx, dz)
        if r <= Locomotion.PIVOT_R {
            pivots[p.id] = s
            return
        }

        let nx = dx / r
        let nz = dz / r
        let vOut = p.vel.x * nx + p.vel.z * nz
        let allow = Locomotion.PIVOT_ARREST * dt
        if vOut > 0 {
            let cut = Swift.min(vOut, allow)
            p.vel.x -= nx * cut
            p.vel.z -= nz * cut
        }

        if vOut <= allow {
            // The leg wins: the body stops at full stretch and the foot stays put.
            p.pos.x = s.x + nx * Locomotion.PIVOT_R
            p.pos.z = s.z + nz * Locomotion.PIVOT_R
        } else {
            // The leg loses. He is dragging his pivot foot, which is the offence.
            s.x = p.pos.x - nx * Locomotion.PIVOT_R
            s.z = p.pos.z - nz * Locomotion.PIVOT_R
            p.foot.pos.x = s.x
            p.foot.pos.z = s.z
        }
        pivots[p.id] = s
    }

    /// Open the momentum allowance for a body that has just gained the disc.
    ///
    /// The distance budget is the rule itself, not a fudge factor: WFDF 18.2.2 says a
    /// receiver in motion must reduce speed *as quickly as possible*, so what he is
    /// owed is the ground a maximal stop from his catching speed needs — v0²/2a — plus
    /// one long step of slack. Stop that hard and the pivot is established wherever you
    /// came to rest, however far downfield that is. Coast instead, and the budget runs
    /// out underneath a body that is still moving: the foot locks under a man at speed,
    /// his own leg cannot check him, and it drags. Which is the call, and is why this is
    /// measured rather than timed.
    private func openGrace(_ p: LocoPlayer) -> PivotState {
        let v = Foundation.hypot(p.vel.x, p.vel.z)
        let brake = Swift.max(1, p.derived.brakeMax)
        return PivotState(
            t0: p.t,
            locked: false,
            x: p.foot.pos.x,
            z: p.foot.pos.z,
            gx: p.pos.x,
            gz: p.pos.z,
            budget: Swift.min(
                (v * v) / (2 * brake) + Locomotion.PIVOT_STOP_SLACK, Locomotion.PIVOT_CARRY_MAX)
        )
    }

    /// Where this player's pivot foot is established, or nil if he has none — he is not
    /// the thrower, or he is still inside the momentum allowance.
    ///
    /// The rules layer compares this against the pivot it recorded; the gap is a travel.
    /// Reporting nothing during the grace window is deliberate: a receiver who is still
    /// stopping has no established foot to have moved.
    public func pivotOf(_ id: Int) -> Vec2d? {
        guard let s = pivots[id], s.locked else { return nil }
        return Vec2d(s.x, s.z)
    }

    /// Re-establish the pivot under a body that has been put back on its spot — the
    /// remedy after an accepted travel. Without this the foot is still off its mark and
    /// the same call fires again on the next step, forever.
    public func rePivot(_ id: Int, _ x: Double, _ z: Double) {
        let p = byId[id]
        pivots[id] = PivotState(
            t0: p?.t ?? 0, locked: true, x: x, z: z, gx: x, gz: z,
            budget: Locomotion.PIVOT_STOP_SLACK)
        if let p {
            p.foot.pos.x = x
            p.foot.pos.z = z
            p.foot.pos.y = p.groundY
            p.foot.contact = true
        }
    }

    // MARK: - airborne

    private func stepAir(_ p: LocoPlayer, _ desired: DesiredMove, _ dt: Double) {
        // Layouts are committed — no steering at all. Jumps get a token amount.
        if p.state == .jump, let dir = desired.dir {
            let dx = dir.x
            let dz = dir.z
            let l = Foundation.hypot(dx, dz)
            if l > 1e-4 {
                p.vel.x += (dx / l) * Locomotion.AIR_CONTROL * dt
                p.vel.z += (dz / l) * Locomotion.AIR_CONTROL * dt
            }
        }

        p.vel.y -= moveG * dt
        p.pos.x += p.vel.x * dt
        p.pos.z += p.vel.z * dt
        p.pos.y += p.vel.y * dt

        // ALIAS SITE, as in `step`.
        let surf = probe.sample(p.pos.x, p.pos.z)
        p.groundY = surf.y
        p.groundN = surf.n

        let layout = p.state == .layout
        let landY = p.groundY + (layout ? PRONE_Y : p.hipHeight)
        if p.pos.y <= landY && p.vel.y <= 0 {
            let impact = -p.vel.y
            p.pos.y = landY
            p.vel.y = 0
            p.air.airborne = false
            p.prone = layout

            if layout {
                // Belly-in, then slide. `landing` runs until the slide stops.
                enter(p, .landing, 0)
            } else {
                p.vel.x *= Locomotion.LAND_HORIZ_KEEP
                p.vel.z *= Locomotion.LAND_HORIZ_KEEP
                let bal = clamp01(p.attr.balance / 100)
                enter(p, .landing, clamp(0.10 + 0.028 * impact * (1.4 - 0.6 * bal), 0.10, 0.42))
            }
            // ALIAS SITE. Reference: `pos: p.pos.clone()` — the payload must not be a
            // live handle on the player's own position vector. The copy is structural.
            emit(.land(id: p.id, pos: p.pos, impact: impact, layout: layout))
        }
    }

    // MARK: - grounded

    private func stepGround(_ p: LocoPlayer, _ desired: DesiredMove, _ dt: Double) {
        let control = groundPhase(p, desired, dt)
        if control > 0 { solveGround(p, desired, dt, control) }
        // Re-sample after moving so the body sits on the surface it ended on, not the
        // one it pushed off from. ALIAS SITE, as in `step`.
        let surf = probe.sample(p.pos.x, p.pos.z)
        p.groundY = surf.y
        p.groundN = surf.n
        // A takeoff can happen inside groundPhase; once airborne the COM is ballistic
        // and must NOT be snapped back onto the surface — doing so drops a layout's
        // centre of mass to prone height before the arc even starts.
        if !p.air.airborne { conformY(p) }
    }

    /// Runs the committed / uncontrolled state machine. Returns how much steering
    /// authority the player has this step (0 = none, 1 = full).
    private func groundPhase(_ p: LocoPlayer, _ desired: DesiredMove, _ dt: Double) -> Double {
        switch p.state {
        case .jump, .layout:
            // Gather: still on the ground, loading the legs.
            let decay = Foundation.exp(-2.2 * dt)
            p.vel.x *= decay
            p.vel.z *= decay
            advanceGaitFor(p, desired, dt)
            if p.stateT >= p.stateDur { takeoff(p) }
            return 0

        case .landing:
            if p.prone {
                slide(p, dt)
                let s = Foundation.hypot(p.vel.x, p.vel.z)
                if s < 0.30 && p.stateT > 0.12 { enter(p, .recovery, getUpTime(p)) }
                return 0
            }
            if p.stateT >= p.stateDur {
                enter(p, .idle, 0)
                return 1
            }
            return 0.25

        case .fall:
            slide(p, dt)
            let s = Foundation.hypot(p.vel.x, p.vel.z)
            if p.stateT >= p.stateDur && s < 0.30 { enter(p, .recovery, getUpTime(p)) }
            return 0

        case .recovery:
            let decay = Foundation.exp(-12 * dt)
            p.vel.x *= decay
            p.vel.z *= decay
            if p.stateT >= p.stateDur {
                p.prone = false
                enter(p, .idle, 0)
                return 1
            }
            return 0

        case .stumble:
            if p.stateT >= p.stateDur {
                enter(p, .idle, 0)
                return 1
            }
            return 0.40

        case .cut:
            if p.stateT >= p.stateDur { endCut(p) }
            return 1

        default:
            return 1
        }
    }

    // MARK: - movement solve

    private func solveGround(
        _ p: LocoPlayer, _ desired: DesiredMove, _ dt: Double, _ control: Double
    ) {
        let vx0 = p.vel.x
        let vz0 = p.vel.z
        let speed0 = Foundation.hypot(vx0, vz0)
        let inCut = p.state == .cut

        // ---- requested direction ------------------------------------------------
        var dx = 0.0
        var dz = 0.0
        if inCut {
            dx = p.cutDir.x
            dz = p.cutDir.z
        } else if let d = desired.dir {
            let l = Foundation.hypot(d.x, d.z)
            if l > 1e-5 {
                dx = d.x / l
                dz = d.z / l
            }
        }
        let hasDir = dx != 0 || dz != 0

        // ---- gait selection -----------------------------------------------------
        let mode = resolveMode(p, desired, dx, dz)

        // ---- terrain ------------------------------------------------------------
        let grade = gradeAlong(p.groundN, dx: hasDir ? dx : vx0, dz: hasDir ? dz : vz0)
        let slopeMul = slopeMultiplier(grade)

        let der = derive(p.attr, stamina: p.stamina, speed: speed0, mode: mode, slopeMul: slopeMul)
        p.derived = der

        var cap = control >= 1 ? der.modeCap : der.modeCap * control
        if let ms = desired.maxSpeed { cap = Swift.min(cap, Swift.max(0, ms)) }

        // ---- hard cut detection -------------------------------------------------
        if !inCut && control >= 1 && hasDir && speed0 > Locomotion.CUT_MIN_SPEED {
            let dot = (vx0 * dx + vz0 * dz) / speed0
            let ang = Foundation.acos(clamp(dot, -1, 1))
            let since = p.t - (lastCutEnd[p.id] ?? -99)
            if ang > Locomotion.CUT_ANGLE && since > Locomotion.CUT_REFRACTORY && !desired.brake {
                startCut(p, dx, dz, ang, speed0, der.plantDur)
                // The plant happens this step; the solve below runs with plant grip.
                solveGround(p, desired, dt, control)
                return
            }
        }

        // ---- target velocity ----------------------------------------------------
        var tgt: Double
        if desired.brake || !hasDir {
            tgt = 0
        } else if let s = desired.speed {
            tgt = s
        } else {
            tgt = cap * clamp01(desired.effort ?? 1)
        }
        tgt = clamp(tgt, 0, cap)

        // The line this body is actually committed to travelling this step — the cut
        // direction while planting, the request otherwise, and nothing at all if they
        // were told to stop. Separation slides bodies ACROSS this rather than against
        // it, so making room never costs progress toward the spot.
        if hasDir && tgt > 0.05 {
            p.cmd.x = dx
            p.cmd.z = dz
        } else {
            p.cmd.x = 0
            p.cmd.z = 0
        }

        let tvx = dx * tgt
        let tvz = dz * tgt

        // ---- ground-force budget (a friction ellipse) ---------------------------
        // The axis is the current direction of travel: "along" is drive/brake, "lat" is
        // the sideways force that bends the path. The requested vector is scaled
        // UNIFORMLY onto the ellipse so its direction survives clamping — scaling the
        // two components independently would leave a residual sideways force during a
        // pure 180 and slowly spiral the player.
        var ux: Double
        var uz: Double
        if speed0 > 0.20 {
            ux = vx0 / speed0
            uz = vz0 / speed0
        } else if hasDir {
            ux = dx
            uz = dz
        } else if speed0 > 1e-4 {
            ux = vx0 / speed0
            uz = vz0 / speed0
        } else {
            ux = 0
            uz = 0
        }

        let rx = (tvx - vx0) / dt
        let rz = (tvz - vz0) / dt

        var along = rx * ux + rz * uz
        var latx = rx - along * ux
        var latz = rz - along * uz
        let lat0 = Foundation.hypot(latx, latz)

        let brakeLim = der.brakeMax * (inCut ? Locomotion.PLANT_BRAKE : 1)
        let latLim = Swift.max(
            1e-6, der.gripMax * (inCut ? Locomotion.PLANT_GRIP : 1) * control)
        let axisLim = along >= 0 ? Swift.max(der.accelMax * control, 0.1) : brakeLim

        let mag = Foundation.hypot(along / axisLim, lat0 / latLim)
        if mag > 1 {
            let s = 1 / mag
            along *= s
            latx *= s
            latz *= s
        }

        // Top-end falloff: at speed there is simply no more drive left in the legs.
        let propLim = propulsiveAt(der, speed: speed0, cap: der.topSpeed) * control
        if along > propLim { along = propLim }

        let ax = along * ux + latx
        let az = along * uz + latz

        p.vel.x = vx0 + ax * dt
        p.vel.z = vz0 + az * dt

        // Never gain speed above the cap; shed any excess gently.
        var ns = Foundation.hypot(p.vel.x, p.vel.z)
        let limit = Swift.max(cap, speed0 - 3 * dt)
        if ns > limit && ns > 1e-6 {
            let k = limit / ns
            p.vel.x *= k
            p.vel.z *= k
            ns = limit
        }
        if ns < 0.02 {
            p.vel.x = 0
            p.vel.z = 0
            ns = 0
        }

        p.pos.x += p.vel.x * dt
        p.pos.z += p.vel.z * dt

        // ---- facing -------------------------------------------------------------
        turnToward(p, desired, mode, dx, dz, ns, der.turnRate, dt)

        // ---- gait ---------------------------------------------------------------
        if !inCut { advanceGaitFor(p, desired, dt, mode, ns) }

        // ---- takeoff requests ---------------------------------------------------
        if control >= 1 && !inCut {
            if desired.layout {
                beginLayout(p, dx, dz, ns)
                return
            }
            if desired.jump {
                beginJump(p)
                return
            }
        }

        // ---- state classification ----------------------------------------------
        if !inCut && !committedStates.contains(p.state) && p.state != .stumble {
            p.state = classify(mode, ns, der.topSpeed)
        }
    }

    private func classify(_ mode: MoveMode, _ speed: Double, _ topSpeed: Double) -> LocoStateName {
        if mode == .backpedal { return .backpedal }
        if mode == .shuffle { return .shuffle }
        let f = speed / Swift.max(0.1, topSpeed)
        if f < 0.06 { return .idle }
        if f < 0.45 { return .jog }
        if f < 0.80 { return .run }
        return .sprint
    }

    /// `.auto` picks the gait from the angle between where the player is looking and
    /// where they are going: backwards is a backpedal, sideways is a slide.
    ///
    /// Note the early `return .run` on the no-`face` branch — with no explicit face
    /// there is no meaningful "looking" direction to compare against yet, so the two
    /// `sin`/`cos` values computed just above it are dead. Ported as written; the
    /// reference's structure makes it look as if facing were consulted, and it is not.
    private func resolveMode(
        _ p: LocoPlayer, _ desired: DesiredMove, _ dx: Double, _ dz: Double
    ) -> MoveMode {
        let m = desired.mode ?? .auto
        if m != .auto { return m }
        if dx == 0 && dz == 0 { return .run }

        var fxv = Foundation.sin(p.facing)
        var fzv = Foundation.cos(p.facing)
        if let f = desired.face {
            let l = Foundation.hypot(f.x, f.z)
            if l > 1e-5 {
                fxv = f.x / l
                fzv = f.z / l
            }
        } else {
            return .run
        }
        let dot = clamp(fxv * dx + fzv * dz, -1, 1)
        if dot < -0.55 { return .backpedal }  // >123 deg from facing
        if dot < 0.42 { return .shuffle }  // >65 deg from facing
        return .run
    }

    private func turnToward(
        _ p: LocoPlayer, _ desired: DesiredMove, _ mode: MoveMode,
        _ dx: Double, _ dz: Double, _ speed: Double, _ turnRate: Double, _ dt: Double
    ) {
        var tx = 0.0
        var tz = 0.0
        if let f = desired.face {
            let l = Foundation.hypot(f.x, f.z)
            if l > 1e-5 {
                tx = f.x / l
                tz = f.z / l
            }
        } else if mode == .backpedal {
            if speed > 0.3 {
                let l = Foundation.hypot(p.vel.x, p.vel.z)
                tx = -p.vel.x / l
                tz = -p.vel.z / l
            } else if dx != 0 || dz != 0 {
                tx = -dx
                tz = -dz
            }
        } else if mode == .shuffle {
            return  // hold the current look
        } else if speed > 0.5 {
            let l = Foundation.hypot(p.vel.x, p.vel.z)
            tx = p.vel.x / l
            tz = p.vel.z / l
        } else if dx != 0 || dz != 0 {
            tx = dx
            tz = dz
        }
        if tx == 0 && tz == 0 { return }

        let want = Foundation.atan2(tx, tz)
        var d = want - p.facing
        while d > Double.pi { d -= Double.pi * 2 }
        while d < -Double.pi { d += Double.pi * 2 }
        let step = turnRate * dt
        p.facing += clamp(d, -step, step)
        if p.facing > Double.pi { p.facing -= Double.pi * 2 }
        if p.facing < -Double.pi { p.facing += Double.pi * 2 }
    }

    // MARK: - cuts

    private func startCut(
        _ p: LocoPlayer, _ dx: Double, _ dz: Double, _ ang: Double, _ speed: Double,
        _ plantDur: Double
    ) {
        // ALIAS SITE. Reference: `p.cutDir.set(dx, 0, dz)` writes through the player's
        // own vector. `Vec3d` is a value, so this is a whole-property assignment.
        p.cutDir = Vec3d(dx, 0, dz)
        p.cutEntrySpeed = speed
        p.cutAngle = ang
        enter(p, .cut, plantDur)
        p.stamina = Swift.max(0, p.stamina - COST_CUT)

        // Outside foot goes down; the turn pivots about it.
        let rxv = -p.vel.z / speed  // right of travel
        let rzv = p.vel.x / speed
        let side = dx * rxv + dz * rzv
        let turnSign: Double = side >= 0 ? 1 : -1

        let plant = plantForCut(
            p, speed: speed, velX: p.vel.x, velZ: p.vel.z, turnSign: turnSign,
            groundY: { [probe] x, z in probe.heightAt(x, z) })
        emitFootstep(p, plant.foot, plant.x, plant.y, plant.z, speed, true)
    }

    private func endCut(_ p: LocoPlayer) {
        // The plant itself costs energy on top of the geometric speed scrub.
        let agi = clamp01(p.attr.agility / 100)
        let loss =
            Locomotion.CUT_LOSS_BASE * (1 - 0.45 * agi) * (1 - Foundation.cos(p.cutAngle)) * 0.5
        let k = Swift.max(0, 1 - loss)
        p.vel.x *= k
        p.vel.z *= k
        lastCutEnd[p.id] = p.t
        enter(p, .run, 0)
    }

    // MARK: - jump / layout

    private func beginJump(_ p: LocoPlayer) {
        enter(p, .jump, Locomotion.JUMP_GATHER)
        p.stamina = Swift.max(0, p.stamina - COST_JUMP)
    }

    private func beginLayout(_ p: LocoPlayer, _ dx: Double, _ dz: Double, _ speed: Double) {
        var dx = dx
        var dz = dz
        if dx == 0 && dz == 0 {
            if speed > 0.2 {
                dx = p.vel.x / speed
                dz = p.vel.z / speed
            } else {
                dx = Foundation.sin(p.facing)
                dz = Foundation.cos(p.facing)
            }
        }
        // ALIAS SITE, as in `startCut`.
        p.cutDir = Vec3d(dx, 0, dz)
        enter(p, .layout, Locomotion.LAYOUT_GATHER)
        p.stamina = Swift.max(0, p.stamina - COST_LAYOUT)
    }

    private func takeoff(_ p: LocoPlayer) {
        let speed = Foundation.hypot(p.vel.x, p.vel.z)
        let der = derive(p.attr, stamina: p.stamina, speed: speed, mode: .sprint)

        if p.state == .layout {
            let ver = clamp01(p.attr.vertical / 100)
            let acc = clamp01(p.attr.accel / 100)
            let push = 0.4 + 0.8 * acc
            var dx = p.cutDir.x
            var dz = p.cutDir.z
            let l = Foundation.hypot(dx, dz)
            if l > 1e-5 {
                dx /= l
                dz /= l
            } else {
                dx = Foundation.sin(p.facing)
                dz = Foundation.cos(p.facing)
            }
            p.vel.x += dx * push
            p.vel.z += dz * push
            p.vel.y = 0.9 + 0.6 * ver
            p.prone = true
        } else {
            p.vel.x *= Locomotion.JUMP_HORIZ_KEEP
            p.vel.z *= Locomotion.JUMP_HORIZ_KEEP
            p.vel.y = takeoffVy(der, approachSpeed: speed)
        }

        p.air.airborne = true
        p.air.tTakeoff = p.t
        p.air.vy0 = p.vel.y
        p.air.takeoffY = p.pos.y
        p.air.tApex = p.t + p.vel.y / moveG
        p.air.apexY = p.pos.y + (p.vel.y * p.vel.y) / (2 * moveG)
        let landY = p.groundY + (p.state == .layout ? PRONE_Y : p.hipHeight)
        let disc = p.vel.y * p.vel.y + 2 * moveG * (p.pos.y - landY)
        p.air.tLand = p.t + (p.vel.y + Swift.max(0, disc).squareRoot()) / moveG
    }

    // MARK: - ground

    private func slide(_ p: LocoPlayer, _ dt: Double) {
        let s = Foundation.hypot(p.vel.x, p.vel.z)
        if s <= 1e-6 {
            p.vel.x = 0
            p.vel.z = 0
            return
        }
        let ns = Swift.max(0, s - Locomotion.SLIDE_DECEL * dt)
        let k = ns / s
        p.vel.x *= k
        p.vel.z *= k
        p.pos.x += p.vel.x * dt
        p.pos.z += p.vel.z * dt
    }

    private func getUpTime(_ p: LocoPlayer) -> Double {
        let agi = clamp01(p.attr.agility / 100)
        let bal = clamp01(p.attr.balance / 100)
        return clamp(1.45 - 0.35 * agi - 0.30 * bal, 0.75, 1.45)
    }

    func conformY(_ p: LocoPlayer) {
        if p.state == .recovery && p.stateDur > 0 {
            let k = clamp01(p.stateT / p.stateDur)
            // Smoothstep written exactly as the reference writes it. `k * k * (3 - 2 * k)`
            // and `3 * k * k - 2 * k * k * k` round differently; do not "simplify".
            p.pos.y = p.groundY + PRONE_Y + (p.hipHeight - PRONE_Y) * (k * k * (3 - 2 * k))
            return
        }
        p.pos.y = p.groundY + (p.prone ? PRONE_Y : p.hipHeight)
    }

    private func advanceGaitFor(
        _ p: LocoPlayer, _ desired: DesiredMove, _ dt: Double,
        _ mode: MoveMode? = nil, _ speed: Double? = nil
    ) {
        if p.prone { return }
        let s = speed ?? Foundation.hypot(p.vel.x, p.vel.z)
        let m: MoveMode
        if let mode { m = mode } else if desired.mode == nil || desired.mode == .auto {
            m = .run
        } else {
            m = desired.mode!
        }
        let plant = advanceGait(
            p, speed: s, velX: p.vel.x, velZ: p.vel.z, mode: m, dt: dt,
            groundY: { [probe] x, z in probe.heightAt(x, z) })
        if plant.planted && s >= GAIT_MIN_SPEED {
            emitFootstep(p, plant.foot, plant.x, plant.y, plant.z, plant.speed, false)
        }
    }

    // MARK: - stamina

    private func stepStamina(_ p: LocoPlayer, _ dt: Double) {
        let speed = Foundation.hypot(p.vel.x, p.vel.z)
        // Fresh, flat-ground sprint top speed — the reference the drain curve uses.
        let fresh = 6.6 + 3.0 * clamp01(p.attr.speed / 100)
        let rate =
            (p.prone || p.air.airborne)
            ? staminaRate(p.attr, speed: 0, topSpeedFresh: fresh) * 0.4
            : staminaRate(p.attr, speed: speed, topSpeedFresh: fresh)
        p.stamina = clamp(p.stamina + rate * dt, 0, 100)
    }

    // MARK: - utils

    func enter(_ p: LocoPlayer, _ state: LocoStateName, _ dur: Double) {
        p.state = state
        p.stateT = 0
        p.stateDur = dur
    }

    private func emitFootstep(
        _ p: LocoPlayer, _ foot: Foot, _ x: Double, _ y: Double, _ z: Double,
        _ speed: Double, _ hard: Bool
    ) {
        p.lastStepT = p.t
        // ALIAS SITE. Reference: `V3A.set(x, y, z).clone()` — the module scratch vector
        // is reused by the next footstep, so the payload must be a copy.
        emit(.footstep(id: p.id, pos: Vec3d(x, y, z), foot: foot, speed: speed, hard: hard))
    }

    func emit(_ event: LocoEvent) {
        host?.events?(event)
    }
}
