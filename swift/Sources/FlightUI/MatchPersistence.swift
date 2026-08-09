import Foundation
import SwiftUI
import UltimateSim

/// Putting the match down, and picking it up again.
///
/// **A saved game here is not a state dump.** It is the seed plus the list of human
/// inputs, which is exactly what `Replay.swift` proves is enough to rebuild a match bit
/// for bit — see `MatchSave` for why that is the format and not merely a format. So a
/// restore is a *replay*: the engine is built again from the seed and the setup and the
/// recorded inputs are fed back through the same `humanRelease` and `humanDefend` the
/// thumb drove, tick by tick, until the tape runs out. A few kilobytes on disk against
/// some seconds of arithmetic.
///
/// That trade is why this is worth its own file. Everything in it is written against one
/// standard — **the match on screen and the match on disk must be the same match** — and
/// every bug this code has had was a way of being not-quite the same: a save stamped with
/// a setup the sheet had drifted to, a recording one tick shorter than the live match, a
/// save path that deleted the file a restore was in the middle of reading. The reasoning
/// lives on each function; what belongs here is the note that they are one argument and
/// not five.
///
/// **Every failure discards the save**, and that is deliberate. Resuming into a match that
/// has quietly diverged — the same score, a disc somewhere else — is the outcome this
/// refuses to produce.
@available(macOS 15.0, iOS 18.0, *)
extension MatchView {

    /// Write the match down, so killing the app does not end it.
    ///
    /// The recording is the seed and the inputs and nothing else; see `MatchSave` and
    /// `Replay.swift`. Three things are true of this function and worth stating:
    ///
    /// **It refuses to save a match there is no point saving.** A game that has not
    /// started, or that has already finished, is cleared rather than written — the file
    /// exists to answer "is there a game to come back to", and a file that says yes when
    /// the answer is no costs the player a tap and a lie.
    ///
    /// **It settles the tick first.** An input is stamped with the tick that has not run
    /// yet, so a throw released between two ticks is stamped at `tickCount` while the
    /// live match has already applied it. A recording that stopped at `tickCount` would
    /// strand that input — the restore would replay a match in which the throw never
    /// happened, land somewhere else, and be discarded by its own checksum. Stepping the
    /// pending ticks costs the player 1/120 s of a match they have just left, and buys the
    /// recording and the live match the same length.
    ///
    /// **It writes what it can and complains about nothing.** See `MatchSave.write`.
    func saveMatch() {
        // A restore in flight is *replaying the very file this would delete*. The save
        // path runs on every `scenePhase` change, and `.inactive` is enough — it fires for
        // a notification banner, a Control Centre swipe, an incoming call — so during the
        // one-to-eight seconds of the replay bar the old code reached the `else` below and
        // removed the match it was in the middle of rebuilding. It survived in memory, so
        // nothing looked wrong; an OS kill in that window lost it with no file to return
        // to. There is nothing to write yet and nothing to clear: leave the disk alone.
        guard restoring == nil else { return }
        guard hasStarted, !match.isOver else {
            MatchSave.clear()
            return
        }
        // Consume anything stamped at or past the current tick. At most one tick's worth
        // in practice, because inputs arrive between frames and a frame is at least one
        // tick — the loop is written as a loop so it cannot be wrong if that changes.
        while let last = inputs.last?.tick, last >= tickCount {
            match.step(dt: Self.tickDt)
            tickCount &+= 1
        }
        guard tickCount > 0 else {
            MatchSave.clear()
            return
        }

        let recording = Recording(
            seed: seed,
            field: RecordedField(match.fieldSpec),
            tickHz: Self.tickHz,
            autoTeams: match.autoTeams.sorted(),
            durationTicks: tickCount,
            inputs: inputs)
        // `playedSetup`, emphatically not `setup`. The sheet's copy is editable *while a
        // match is running* — open the gear mid-point, flick FORMAT to see what 7v7 says,
        // tap BACK — and a save stamped with what the sheet last showed describes a match
        // nobody played. See `playedSetup` for the two ways that ended.
        let saved = SavedMatch(
            fingerprint: MatchSave.fingerprint(for: playedSetup),
            recording: recording,
            checksum: MatchChecksum(match, tick: tickCount),
            setup: MatchSave.encode(playedSetup))
        MatchSave.write(saved)
    }

    /// Rebuild a saved match and hand it back to the player.
    ///
    /// Restoring means *replaying*: the engine is built again from the seed and the setup,
    /// and the recorded inputs are fed back through the same `humanRelease` and
    /// `humanDefend` the thumb drove, tick by tick, until the tape runs out. There is no
    /// shortcut, because there is no state dump to load — and that is the trade this whole
    /// design makes, a few kilobytes on disk against some seconds of arithmetic.
    ///
    /// Measured, in `MatchSaveTests` and therefore also on the device's own Checks tab:
    /// a release build replays 3v3 at about 17,000 ticks per second, so half a minute of
    /// match comes back in a quarter of a second and a full twenty-minute game takes
    /// single-digit seconds. The `SimFingerprint` canary that decides whether the save is
    /// even ours costs another 48 ms on top, once.
    ///
    /// So it is done in chunks with the screen alive between them. The work is bounded by
    /// wall time rather than by a tick count, so a slow device draws the same progress bar
    /// as a fast one instead of a longer freeze.
    ///
    /// **Every failure discards the save.** A stale fingerprint, a checksum that does not
    /// match, a recording that will not validate: all three mean this build cannot
    /// faithfully reproduce the match the player left, and the only honest options are to
    /// say so and start fresh. Resuming into a match that has quietly diverged — the same
    /// score, a disc somewhere else — is the outcome this refuses to produce.
    func resume(_ saved: SavedMatch) {
        guard restoring == nil else { return }
        restoreNote = nil
        restoring = 0
        showSetup = false
        showCoach = false

        // The setup the match was played under outranks the one on the sheet. Resuming a
        // 7v7 game to seven into a 3v3 engine would not be a restore.
        let played = MatchSave.decodeSetup(saved.setup) ?? setup
        setup = played

        Task { @MainActor in
            let engine = Engine(
                format: played.fieldSpec.gameFormat, seed: saved.recording.seed,
                config: played.engineConfig)
            do {
                let restore = try MatchRestore(
                    saved, fingerprint: MatchSave.fingerprint(for: played), engine: engine)
                while !restore.isFinished {
                    // A slice of work, then the screen. 24 ms is under two frames at 60 Hz
                    // and under three at 120, so the bar moves smoothly and the replay is
                    // never interrupted for longer than it takes to draw it.
                    let until = DispatchTime.now().uptimeNanoseconds + 24_000_000
                    while !restore.isFinished, DispatchTime.now().uptimeNanoseconds < until {
                        restore.advance(ticks: 256)
                    }
                    restoring = restore.progress
                    // A real suspension, not a `yield`: SwiftUI has to get a turn to draw
                    // the number that just changed, and a yield hands control back to a
                    // task queue rather than to a frame.
                    try? await Task.sleep(nanoseconds: 4_000_000)
                }
                adopt(try restore.finish(), from: saved, setup: played)
            } catch {
                MatchSave.clear()
                resumable = nil
                restoring = nil
                restoreNote = Self.restoreNote(for: error)
                showSetup = true
            }
        }
    }

    /// Take a restored match as the live one.
    ///
    /// Everything `restart` resets is reset here too, for the same reason: per-match state
    /// that survives a match change is state that lies. What is *not* reset is the pair
    /// that makes the restored match saveable again — the tick count and the input list
    /// come from the recording, so putting the game down a second time writes a tape that
    /// continues the first rather than starting from the middle.
    private func adopt(_ restored: Engine, from saved: SavedMatch, setup played: MatchSetup) {
        match = restored
        seed = saved.recording.seed
        inputs = saved.recording.inputs
        tickCount = saved.recording.durationTicks
        // The setup this match is now being played under is the one it was played under
        // before it was put down — not whatever the sheet happens to be showing.
        playedSetup = played

        cancelDrag()
        scene.invalidate()
        clock.reset()
        turnoverFlash = nil
        assistToast = nil
        handoff = nil
        defenceCall = nil
        lastControlled = restored.controlled
        clearedAtEnd = false

        hasStarted = true
        resumable = nil
        restoring = nil
        // Landing paused, exactly as returning from the background does. A player who has
        // just watched a progress bar is not looking at the pitch yet, and dropping them
        // into a live point mid-stall is how a restore gets blamed for a turnover. One
        // tap, and it is their game again.
        paused = true
    }

    /// What to tell the player about a save that could not be restored.
    ///
    /// Short, and specific enough to be a bug report. "The game has changed" is the
    /// common case and the one worth naming plainly: it is nobody's fault, it will happen
    /// on any update that touches the simulation, and a player who is told the truth about
    /// it once will not wonder whether the app lost their game.
    private static func restoreNote(for error: Error) -> String {
        switch error {
        case RestoreError.staleSim:
            "SAVED GAME WAS PLAYED ON AN OLDER BUILD — IT CANNOT BE REPLAYED EXACTLY"
        case RestoreError.diverged:
            "SAVED GAME DID NOT REPLAY TO WHERE IT WAS LEFT — DISCARDED"
        case RestoreError.unsupportedSave:
            "SAVED GAME IS IN A FORMAT THIS BUILD DOES NOT READ"
        default:
            "SAVED GAME COULD NOT BE READ — DISCARDED"
        }
    }

    /// The one line the RESUME button says about what is being resumed.
    static func resumeSummary(_ saved: SavedMatch) -> String {
        let s = saved.checksum.score
        let minutes = Int(saved.seconds / 60)
        let clock = minutes >= 1 ? "\(minutes) MIN IN" : "JUST STARTED"
        return "\(s[0])–\(s[1]) · \(clock)"
    }
}
