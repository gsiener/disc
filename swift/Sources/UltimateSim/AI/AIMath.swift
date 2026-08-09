import Foundation

/// The AI's pure functions, ported from `src/sim/AI.ts` lines 281–652.
///
/// Everything here is a function of ratings and geometry with no state and no decisions —
/// how fast a player can run given their energy, how far a throw goes, whether a dive is
/// worth leaving your feet for. `TeamAI` is what uses them.
///
/// The one structural departure is `boundaryRoom`, which reads a module-level `FIELD` in
/// the reference and takes a `FieldConstants` here, for the reason recorded throughout
/// this port: the game runs on two pitch sizes and a module constant cannot be two
/// things at once.

// MARK: - capability

/// Top speed in m/s before fatigue, from the speed rating alone.
public func baseMaxSpeed(_ a: AIAttributes) -> Double { 5.7 + 3.3 * (a.speed / 100) }

/// Fatigue costs a fifth of top speed at empty. The floors differ per quantity on
/// purpose — you lose more of your acceleration than your top speed when tired, and more
/// of your top speed than your braking.
public func effectiveMaxSpeed(_ p: AIPlayer) -> Double {
    baseMaxSpeed(p.attr) * (0.80 + 0.20 * p.energy)
}

public func effectiveAccel(_ p: AIPlayer) -> Double {
    (4.2 + 4.8 * (p.attr.acceleration / 100)) * (0.82 + 0.18 * p.energy)
}

public func effectiveDecel(_ p: AIPlayer) -> Double {
    (6.0 + 6.5 * (p.attr.agility / 100)) * (0.85 + 0.15 * p.energy)
}

/// Yaw rate in rad/s. Deliberately not scaled by energy in the reference — a tired
/// player is slower, not clumsier.
public func turnRateOf(_ p: AIPlayer) -> Double { 4.2 + 5.4 * (p.attr.agility / 100) }

/// Highest point a standing or jumping catch can be made.
public func reachHeight(_ p: AIPlayer) -> Double { 2.02 + 0.88 * (p.attr.jumping / 100) }

/// Extra metres a full-extension layout buys.
///
/// This is the AI's own athleticism model and **buys nothing the rules will honour** —
/// the engine's layout extension is a flat 1.55 m. It exists so a more agile player
/// believes in a dive sooner, not so they reach further.
public func layoutExtend(_ p: AIPlayer) -> Double {
    0.85 + 0.95 * (p.attr.agility / 100) + 0.35 * (p.attr.jumping / 100)
}

public func effectiveDecision(_ p: AIPlayer) -> Double {
    p.attr.decision * (0.80 + 0.20 * p.energy)
}

// MARK: - layouts

/// Horizontal reach for a standing catch and for a full extension, metres.
///
/// Both are quoted from the rules engine's own catch and block radii, and the engine's
/// extension is a flat 1.55 m. **A dive therefore converts exactly 0.73 m of reach.**
/// Inside 0.82 m you run it down on your feet; past 1.55 m you do not reach it lying
/// down either, and you pay two seconds on the turf to find that out.
public let STANDING_REACH = 0.82
public let EXTENDED_REACH = 1.55

/// The height band a rendezvous with the disc may be picked in, metres.
public let CATCH_FLOOR = 0.85
public let CATCH_CEILING = 1.45

/// Below this the disc is gone. The point where the flight crosses it is the player's
/// last chance on their feet, and that — not the rendezvous — is the deadline a layout
/// has to beat.
public let CATCH_DEAD = 0.25

/// How much further than standing reach a player must be short before believing it.
/// The noise floor of `arrivalShortfall`, swept at 0.20/0.35/0.40 over five seeds.
public let BID_HESITATION = 0.35

/// Seconds of dive. Bidding earlier than this is not a bid, it is a belly-flop with a
/// good view of the catch.
public let BID_LEAD = 0.45

/// How far from the disc a player will actually be when it arrives, metres.
///
/// Measured rather than inferred from a time. They cover `d` in `t` seconds, so in the
/// `arrival` seconds they actually have they cover that fraction of it. The linear split
/// flatters a player starting from rest, so this reads slightly **short** of the true
/// shortfall — which is the direction a last resort should err in.
public func arrivalShortfall(_ d: Double, _ t: Double, _ arrival: Double) -> Double {
    d * clamp(1 - arrival / Swift.max(t, 1e-3), 0, 1)
}

/// How much is riding on this disc, 0…1.
///
/// Symmetric on purpose: the defender covering that endzone reads exactly the same
/// stakes the receiver does.
public func discStakes(_ z: Double, _ attackDir: Dir, field: Playbook = .regulation) -> Double
{
    clamp(1 - field.yardsToGoal(z, attackDir) / 25, 0, 1)
}

/// Should this player leave their feet?
///
/// Three things have to be true at once: they cannot reach it standing, the dive does
/// reach it, and the last chance falls inside the time the dive is airborne. Agility
/// does not appear, because the rules engine's extension is flat — a quicker player
/// earns layouts by getting into the band, not by widening it.
public func shouldBid(
    _ p: AIPlayer, short: Double, deadline: Double, stakes: Double
) -> Bool {
    // Written as the reference writes it, `!(deadline <= BID_LEAD)`, rather than
    // `deadline > BID_LEAD`. Those differ on NaN: the negated form rejects, the direct
    // form also rejects, but only because `NaN > x` is false — keeping the reference's
    // spelling means the two agree by construction rather than by argument.
    if !(deadline <= BID_LEAD) { return false }
    let need = STANDING_REACH + BID_HESITATION * (1 - 0.60 * clamp(stakes, 0, 1))
    return short > need && short < EXTENDED_REACH
}

// MARK: - valuation

/// Rough probability a possession starting `yards` from the goal line ends in a score.
///
/// This is the currency the thrower's decision model trades in: every option is priced
/// as a change in it, and a turnover is charged exactly what it costs, the disc.
///
/// The second term is not decoration. Past 64 the disc is **inside your own endzone** and
/// it keeps getting worse — a turnover there is a goal against, not a field-position
/// swing. Clamping at 64 priced eighteen metres deep in your own endzone identically to
/// standing on your own goal line, and an offence could walk itself backwards over its
/// own line one locally-rational reset at a time.
public func possessionValue(_ yards: Double) -> Double {
    let core = 0.40 + 0.42 * (1 - clamp(yards, 0, 64) / 64)
    return core - 0.42 * clamp((yards - 64) / 18, 0, 1)
}

/// Max range in metres for a throw type, including the wind along the throw.
public func maxThrowRange(_ p: AIPlayer, _ type: AIThrowType, _ windAlong: Double) -> Double
{
    let typeFactor: [AIThrowType: Double] = [
        .backhand: 1.0, .forehand: 0.93, .hammer: 0.58, .scoober: 0.42, .push: 0.30,
    ]
    let base = (21 + 36 * (p.attr.throwPower / 100)) * typeFactor[type]!
    return base * (1 + 0.045 * clamp(windAlong, -8, 8)) * (0.86 + 0.14 * p.energy)
}

/// Seconds of flight the thrower will put on a throw of length `d`.
///
/// A huck is not a floated under: past ~15 m a real thrower puts arm into it, so the
/// implied release speed (`d / tf`, which the engine inverts back onto the physics power
/// band via `powerForSpeed`) climbs toward the top of the band instead of pinning at the
/// bottom. Without the stretch a 30 m request came out at 14 m/s — 15% power on a
/// [12,27] m/s backhand — and every deep shot landed a dozen metres short of everything.
public func throwFlightTime(_ p: AIPlayer, _ type: AIThrowType, _ d: Double) -> Double {
    let zip = 10.5 + 7.5 * (p.attr.throwPower / 100) * (type == .hammer ? 0.8 : 1)
    // Two pieces, fitted against the flight model directly — see the reference for
    // the sweep. The disc has a narrow speed window per distance; the sum of ramps
    // tracks the window's floor from ~18 m/s at 26 m to ~22 m/s at 36 m.
    let stretch =
        1 + 0.42 * Playbook.smoothstep(15, 23, d) + 0.28 * Playbook.smoothstep(23, 40, d)
    return 0.28 + d / (zip * stretch)
}

/// Probability a player completes the catch.
///
/// `difficulty` 0 is a chest-high disc standing still; 1.5 is a full-extension contested
/// grab. The floor of 0.18 matters — no disc is ever hopeless, which is what keeps a
/// desperation huck from being valued at exactly zero.
public func catchProbability(_ p: AIPlayer, _ difficulty: Double) -> Double {
    let base = 0.952 + 0.045 * (p.attr.catching / 100)
    let fatigue = 0.96 + 0.04 * p.energy
    let skill = 0.55 + 0.45 * (1 - p.attr.catching / 100)
    return clamp(base * fatigue - 0.38 * skill * clamp(difficulty, 0, 1.8), 0.18, 0.995)
}

// MARK: - stamina

/// Fatigue integration. Call once per fixed step per player you own.
///
/// Mutates `p.energy` in place, which is why `AIPlayer` is a class. The load threshold
/// of 0.42 is the same idea as `staminaRate`'s in the movement port: at or below a jog
/// you are recovering, above it you are spending.
public func tickStamina(_ p: AIPlayer, _ dt: Double) {
    let vmax = Swift.max(1e-3, effectiveMaxSpeed(p))
    let load = clamp(Foundation.hypot(p.vel.x, p.vel.z) / vmax, 0, 1.2)
    let endurance = 0.35 + 0.65 * (p.attr.stamina / 100)
    if load > 0.42 {
        p.energy -= dt * (0.017 * load * load) / endurance
    } else {
        p.energy += dt * 0.034 * endurance * (1 - load)
    }
    p.energy = clamp(p.energy, 0.12, 1)
}

// MARK: - geometry

/// Distance from `(px, pz)` to the playing-surface perimeter along `(dx, dz)`.
///
/// Locomotion turns this into a speed cap, which is what guarantees nobody is steered
/// over a line: a player is never asked to run faster than they can stop in.
///
/// The reference reads a module-level `FIELD`; the pitch is a parameter here because
/// this game is played on two of them. The 0.55 m inset is the reference's own.
public func boundaryRoom(
    _ px: Double, _ pz: Double, _ dx: Double, _ dz: Double,
    field: FieldConstants = .standard
) -> Double {
    let l = Foundation.hypot(dx, dz)
    if l < 1e-5 { return 1e3 }
    let ux = dx / l
    let uz = dz / l
    let bx = field.sideline - 0.55
    let bz = field.endLine - 0.55
    var t = 1e3
    if ux > 1e-6 {
        t = Swift.min(t, (bx - px) / ux)
    } else if ux < -1e-6 {
        t = Swift.min(t, (-bx - px) / ux)
    }
    if uz > 1e-6 {
        t = Swift.min(t, (bz - pz) / uz)
    } else if uz < -1e-6 {
        t = Swift.min(t, (-bz - pz) / uz)
    }
    return Swift.max(0, t)
}

// MARK: - attribute generation

/// Per-archetype rating bias. A handler is slower and throws further; a deep is faster,
/// jumps higher and throws worse.
let ARCH_BIAS: [Archetype: [String: Double]] = [
    .handler: [
        "speed": -6, "acceleration": 2, "agility": 8, "throwPower": 10, "decision": 12,
        "catching": 6, "jumping": -6,
    ],
    .cutter: [
        "speed": 6, "acceleration": 6, "agility": 4, "catching": 4, "throwPower": -6,
        "decision": -2,
    ],
    .deep: [
        "speed": 12, "acceleration": 4, "jumping": 12, "catching": 2, "throwPower": -10,
        "decision": -6, "agility": -2,
    ],
    .utility: ["speed": 2, "agility": 2, "defAwareness": 6, "stamina": 6],
]

/// Deterministic rating profile. `overall` around 55…90 shifts the whole sheet.
///
/// **The order of the RNG draws is behaviour, not style.** Every `roll` and every `acc`
/// consumes from the same stream, so reordering these lines gives a different player from
/// the same seed. They are written in the reference's order and must stay that way.
public func makeAttributes(
    _ rng: Rng, _ archetype: Archetype, overall: Double = 72
) -> AIAttributes {
    let bias = ARCH_BIAS[archetype] ?? [:]
    func roll(_ k: String, _ spread: Double = 9) -> Double {
        clamp(overall + (bias[k] ?? 0) + rng.gauss() * spread, 28, 99)
    }

    let throwBase = roll("throwPower", 8)
    let handBonus: Double = archetype == .handler ? 8 : (archetype == .deep ? -10 : 0)
    func acc(_ penalty: Double) -> Double {
        clamp(overall + handBonus - penalty + rng.gauss() * 8, 25, 99)
    }

    // **Every draw below is written out as a separate statement, in the reference's
    // order, and that is load-bearing.**
    //
    // The reference builds one object literal, and JavaScript evaluates its properties
    // top to bottom: throwPower first (above), then speed through catching, then the five
    // accuracies, then decision, stamina, defAwareness. Swift would evaluate the
    // arguments to `AIAttributes(...)` in *call* order, which is not the same order,
    // because `throwAccuracy` sits before `throwPower` in that initialiser's signature.
    //
    // Getting this wrong does not fail to compile and does not look wrong. It produces a
    // completely different — but entirely plausible — player from the same seed, which is
    // the whole determinism guarantee gone. It was wrong here once.
    let speed = roll("speed")
    let acceleration = roll("acceleration")
    let agility = roll("agility")
    let jumping = roll("jumping")
    let catching = roll("catching", 7)
    let backhand = acc(0)
    let forehand = acc(6)
    let hammer = acc(20)
    let scoober = acc(26)
    let push = acc(2)
    let decision = roll("decision", 10)
    let stamina = roll("stamina", 9)
    let defAwareness = roll("defAwareness", 10)

    return AIAttributes(
        speed: speed,
        acceleration: acceleration,
        agility: agility,
        jumping: jumping,
        catching: catching,
        throwAccuracy: [
            .backhand: backhand, .forehand: forehand, .hammer: hammer,
            .scoober: scoober, .push: push,
        ],
        throwPower: throwBase,
        decision: decision,
        stamina: stamina,
        defAwareness: defAwareness
    )
}

/// 14% of players are left handed, which is roughly the real rate and is drawn from the
/// same stream as everything else so a seed reproduces a whole roster.
public func makePlayer(
    _ id: Int, _ team: TeamId, _ archetype: Archetype, _ rng: Rng, overall: Double = 72
) -> AIPlayer {
    let attr = makeAttributes(rng, archetype, overall: overall)
    return AIPlayer(
        id: id, team: team, pos: .zero, vel: .zero, attr: attr,
        handed: rng.next() < 0.86 ? .right : .left,
        archetype: archetype, energy: 1,
        role: archetype == .handler ? .handler : .cutter)
}
