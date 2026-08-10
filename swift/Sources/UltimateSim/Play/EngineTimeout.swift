import Foundation

/// THE TIMEOUT NOBODY WAS CALLING.
///
/// `GameState.callTimeout` has been complete and correct since it was written — two per
/// half, only the team in possession, never while the disc is in the air, the count
/// resuming at reached-plus-one — and it had **no caller anywhere outside the test
/// fixtures**. A capability that is ported, asserted and unreachable is not a feature; it
/// is a promise the match never keeps. This file is that caller.
///
/// It decides nothing itself. `Playbook.timeoutIntent` owns when and why, so the decision
/// is a pure function with goldens on both sides of the port rather than a condition
/// buried in a tick. All that lives here is the read — turning the machine's state into
/// the eight numbers that function asks for — and the consequence.
///
/// **The consequence is the interesting half, and getting it wrong made the feature
/// negative.** A timeout on its own only pauses the clock and puts the count up by one, so
/// the first working version of this measured *worse* than not calling one at all: drops
/// per attempt went 3.2% → 6.1% across three seeds, because the offence came back on a
/// higher count holding the same beaten shape. What a timeout actually buys is a new plan,
/// and the plan lives in `TeamAI` — so the timeout rebuilds both of them. With the huddle
/// in, the same three seeds went to 3.8% drops and holds rose from 43.6% to 61.9%. See
/// `Engine.buildTeamAIs`.
extension Engine {

    /// Consider calling a timeout, every tick, for whichever side is holding.
    ///
    /// Cheap by construction: everything before `Playbook.timeoutIntent` is a field read
    /// off the machine, and the function itself is four comparisons.
    ///
    /// **Gated on `autoTeams`, like every throw in this engine, and it took a measurement to
    /// get there.** The first version was not: a timeout is a captain's call and there is no
    /// interface for making one, so having the machine take them for both sides looked like
    /// the generous reading. It is not, because the count reaching seven is not evidence of
    /// anything when the side holding the disc is a person. A human aiming for eight seconds
    /// is aiming; the machine spending his timeout on it takes the disc out of his hands,
    /// destroys whatever cut he had commanded — `buildTeamAIs` rebuilds the plan, and a
    /// called cut lives in the plan — and gives him a stoppage he did not ask for. Measured
    /// as `HumanCutTests` reading a commanded cut's throw at 2.9 m where it wants 4–16.
    ///
    /// So the computer takes timeouts for the sides it plays, and a human's timeout waits for
    /// a button. That is one line of interface away and it is the right shape of missing.
    func considerTimeout() {
        guard game.phase == .livePossession, let team = game.possession,
            autoTeams.contains(team)
        else { return }

        // Snapshot the attempts column at the top of each point, which is the only thing
        // "has this team thrown yet" can be derived from.
        if calls.attemptsPoint != game.point {
            calls.attemptsPoint = game.point
            calls.pointAttempts = (game.teamStats(0).attempts, game.teamStats(1).attempts)
        }
        let atPointStart = team == 0 ? calls.pointAttempts.0 : calls.pointAttempts.1
        let stats = game.teamStats(team)

        let intent = Playbook.timeoutIntent(
            Playbook.TimeoutRead(
                // Both are integer counts on the machine; the read is `Double` so the
                // decision can be expressed in counts-short-of-the-turnover.
                stall: Double(game.stallCount),
                stallMax: Double(game.rules.stallMax),
                remaining: stats.timeoutsRemaining,
                throwsThisPoint: stats.attempts - atPointStart,
                receiving: game.pointReceiver == team,
                stoppedThisPossession: calls.timeoutPossession
                    == (team, stats.possessions),
                ours: game.score[team],
                theirs: game.score[1 - team],
                toWin: game.target))
        guard intent != .none else { return }

        // The machine is allowed to refuse — the phase can move between the read and the
        // call — and a refusal is not an error, so this does not go through `demand`.
        guard game.callTimeout(team, game.thrower).ok else { return }
        calls.timeoutPossession = (team, stats.possessions)

        // The huddle. Both sides get a new plan out of it, not only the side that called
        // it: the defence has the same stoppage to re-mark and to re-pick its scheme.
        buildTeamAIs()
    }
}
