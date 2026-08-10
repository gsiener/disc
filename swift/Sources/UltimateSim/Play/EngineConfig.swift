import Foundation

/// Every knob the `Engine` used to carry as an edit-the-constant: pacing waits, the
/// per-side style table, the human-assist geometry, and the match length. One value of
/// this struct is one difficulty level / game mode, constructed instead of recompiled.
///
/// **`.default` is behavior-identical to the constants it replaced.** The full check
/// suite's assertion count is the oracle for that — the telemetry assertions are
/// RNG-stream sensitive, so any drift in a default here shows up as a different count,
/// not just a failure.
public struct EngineConfig: Sendable {

    /// How one side plays: the formation it runs, the force its mark holds, and its
    /// tempo/scheme biases. See `Engine.stagePoint` for why the two default sides are
    /// deliberately different — it is the reference's single biggest measured tempo
    /// lever, and both values carry the measurements that chose them.
    public struct SideStyle: Sendable {
        public var formation: Playbook.FormationName
        public var force: Playbook.Force
        /// Folded into `Engine.aggression` multiplicatively rather than overriding it,
        /// so setting the engine-level knob still means something.
        public var aggressionScale: Double
        public var zoneBias: Double

        public init(
            formation: Playbook.FormationName, force: Playbook.Force,
            aggressionScale: Double, zoneBias: Double
        ) {
            self.formation = formation
            self.force = force
            self.aggressionScale = aggressionScale
            self.zoneBias = zoneBias
        }
    }

    /// One entry per team, indexed by team id (cycled if shorter than the team count).
    ///
    /// The defaults are the tuple table that lived inline in `stagePoint`: team 0 runs a
    /// vertical stack and forces forehand, team 1 runs horizontal and forces MIDDLE —
    /// a force that moves with the disc, which across the reference's six sweep seeds
    /// roughly doubled scoring. Both zone biases are pushed well negative because a zone
    /// renders as bodies with no visible relationship to each other.
    /// THE ZONE BIASES ARE ZERO, and they used to be -0.55 and -0.45.
    ///
    /// They were pushed well negative when a zone rendered as bodies with no visible
    /// relationship to each other, which is a rendering verdict on a tactic. It has since
    /// cost more than it bought: `Playbook.shouldPlayZone` maxes its wind term at 1.0, so
    /// a bias of -0.55 demanded a wind term above 1.05 and no wind on earth could reach
    /// it. The two negative numbers were a second, hidden reason zone could never be
    /// called, underneath the weather — fixing the weather alone would not have made the
    /// 3-2-2 cup appear even once.
    ///
    /// At zero, the wind and the scoreboard decide it and nothing else does, which is the
    /// whole content of `shouldPlayZone`. A game mode that wants a zone team can still say
    /// so here; that is what the knob is for.
    public var sideStyles: [SideStyle] = [
        SideStyle(formation: .vertical, force: .forehand, aggressionScale: 1.05, zoneBias: 0),
        SideStyle(formation: .horizontal, force: .middle, aggressionScale: 0.95, zoneBias: 0),
    ]

    // MARK: weather

    /// THE DAY THE MATCH IS PLAYED ON.
    ///
    /// The draw used to live inline in `Engine.init` as `Vec3d(w.range(-1.5, 1.5), 0,
    /// w.range(-1.1, 1.1))` — a breeze topping out at 1.86 m/s against a zone trigger
    /// whose smoothstep does not leave the floor until 4.5. Zone was not rare, it was
    /// unreachable. `Playbook.drawWeather` owns the distribution and the argument for it;
    /// this is the engine's hook for pinning or replacing it.
    ///
    /// `nil` draws the day from `Playbook.drawWeather` off a fork of the match seed, which
    /// is the shipping behaviour. Setting it pins the wind — which is how a check, a
    /// screenshot or a "windy day" game mode gets a guaranteed zone point instead of
    /// waiting for one match in ten.
    public var fixedWind: Vec2d? = nil

    /// The wind for a match, drawn from `rng` unless `fixedWind` says otherwise.
    ///
    /// Takes the fork rather than making one, so the salt stays at the call site where it
    /// has always been and a pinned day burns no draws at all.
    public func wind(from rng: Rng) -> Vec3d {
        if let w = fixedWind { return Vec3d(w.x, 0, w.z) }
        let day = Playbook.drawWeather(rng)
        return Vec3d(day.wind.x, 0, day.wind.z)
    }

    /// Initial value for `Engine.aggression` — how willing both offences are to let it
    /// go, 0.6 (conservative) to 1.6 (gunner). The reference's own knob and the only
    /// honest lever on pacing; see the property doc on `Engine.aggression`.
    public var aggression: Double = DEFAULT_TEAM_CONFIG.aggression

    /// Initial value for `Engine.autoTeams` — the teams whose throws the computer
    /// makes. Defaults to the opponent only; set both and the game plays itself.
    public var autoTeams: Set<TeamId> = [1]

    // MARK: match length

    /// First to this many goals wins. `nil` derives it from the format the way the
    /// engine always has: a minis game to 7, a regulation game to 15. An explicit
    /// `target:` passed to `Engine.init` still wins over this, since that parameter
    /// predates the config and the checks lean on it.
    public var pointsToWin: Int? = nil

    /// Halftime after this many total goals. `nil` keeps the derived midpoint —
    /// `(goal + 1) / 2`, which reproduces the regulation 8-of-15 and gives a minis
    /// game to 7 a break at 4.
    public var halftimeAt: Int? = nil

    /// THE MATCH CLOCK — seconds of game time at which each cap lands. `nil` for both
    /// (the default) is an untimed game and is exactly today's behaviour.
    ///
    /// This is the switch for issue #22 and it is deliberately a switch rather than a
    /// default: `applySoftCap` / `applyHardCap` have been correct and unreachable since
    /// they were written, every golden in the suite was generated from an untimed game,
    /// and a cap that fired by default would rewrite all of them for a format nobody
    /// asked for. Set either and `GameState.tickCaps` does the rest off its own clock —
    /// at the soft cap the target becomes the leader + 1 and play carries on, at the hard
    /// cap the point in progress is the last one.
    ///
    /// A timed game is the sport's normal one: a WFDF-timed final is 100 minutes with a
    /// soft cap on the horn and a hard cap fifteen minutes later. Scaled to the sim's
    /// pace, `softCapSeconds: 480, hardCapSeconds: 600` gives a fifteen-minute match that
    /// ends on time rather than whenever fifteen points happen.
    public var softCapSeconds: Double? = nil
    public var hardCapSeconds: Double? = nil

    /// Seconds of halftime.
    ///
    /// **A deliberate departure from `DEFAULT_RULES`, which says 300.** Five minutes is
    /// right for a match and is the game hanging for a player: `GameState` sits in
    /// `HALFTIME` doing nothing until the clock runs out, and there is no interface
    /// that could fill it. The rule itself — ends swap, timeouts come back, the opening
    /// pull roles reverse — is wired and real; only its duration is tuned to something
    /// a thumb can sit through.
    public var halftimeSeconds: Double = 6.0

    /// Seconds a timeout lasts.
    ///
    /// **A deliberate departure from `DEFAULT_RULES`, which says 70**, and the same
    /// departure the reference makes: `Game.ts` passes 12. Seventy seconds of game clock is
    /// what the rule says and it is 8400 ticks of a frame in which nothing whatsoever
    /// happens. Twelve is long enough for both sides to re-form around the disc — which is
    /// the whole of what a timeout buys, see `Engine.considerTimeout` — and short enough
    /// that a watcher does not put the phone down.
    public var timeoutSeconds: Double = 12.0

    // MARK: pacing waits

    /// Seconds a computer-run `PRE_PULL` line-up is given before the pull is thrown.
    ///
    /// Not a rule — the rules have nothing to say about how long a team takes to signal
    /// ready — but the bodies have to arrive on their goal lines before the disc
    /// leaves, or the pull is thrown at an empty half.
    public var pullSettle: Double = 0.8

    /// Seconds a *human* pulling team is given before the engine pulls for them.
    ///
    /// The pull is a throw, and a human whose team is pulling should get to make it —
    /// see `Engine.humanRelease`. But a game that waits forever for a thumb that never
    /// arrives is a game that never starts, so the wait has an end. Long enough to line
    /// up and aim, short enough that an unattended match is only briefly boring.
    public var pullDeadline: Double = 5.0

    /// How long the goal callout stays up, seconds.
    public var scoreFlash: Double = 2.5

    /// The pause before the defence taps a checked disc back in. `Game.ts:134`.
    public var checkWait: Double = 0.65

    /// How close a player must be to a dead disc to pick it up, metres. `Game.ts:136`.
    public var pickupRadius: Double = 1.6
    /// …escalating to `pickupDwellRadius` after standing over it this long. See
    /// `Engine.collectDeadDisc`.
    public var pickupDwell: Double = 1.4
    public var pickupDwellRadius: Double = 3.6

    /// Nobody may touch a disc for the first tenth of a second after it leaves the
    /// hand. Without it the mark is on top of the release point and takes it back off
    /// the thrower's fingertips. `Game.ts:150`.
    public var releaseDeadtime: Double = 0.10

    // MARK: human assist

    /// Half-angle of the drag-to-select cone the engine hands `HumanTargeting`.
    /// Defaults to `HumanTargeting.selectCone` — the brief's 35 degrees — which stays
    /// the reference-pinned constant; this is the engine's override of what it *passes*,
    /// not a change to that constant.
    public var selectCone: Double = HumanTargeting.selectCone

    /// Cap on how far aim assist may rotate a human release, radians. Defaults to
    /// `HumanTargeting.assistMax` — the brief's 5 degrees — under the same contract as
    /// `selectCone`: the pinned constant is untouched, this is what the engine passes.
    public var assistMax: Double = HumanTargeting.assistMax

    /// Today's engine, exactly.
    public static let `default` = EngineConfig()

    public init() {}
}
