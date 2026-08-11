import Foundation
import UltimateSim

/// A match you can put down and pick up, asserted rather than hoped for.
///
/// `ReplayTests` establishes the mechanism: a match is a seed and a list of stamped
/// inputs, and replaying that list reproduces every number bit for bit. This suite
/// asserts the *product* built on it — that killing the app in the middle of a game does
/// not end the game — and, more importantly, the three ways it is allowed to fail.
///
/// The interesting assertions here are the negative ones. A save system that restores
/// correctly is worth having; a save system that restores correctly **or refuses** is the
/// only kind worth shipping, because the alternative failure is silent: the player is put
/// back into a match with the right score and a disc that is somewhere else, and nothing
/// on screen ever says so. Every check below that ends in a discarded save is checking
/// that the silent outcome cannot happen:
///
///  - `staleSimIsRejected` — the build's simulation has been tuned since the save was
///    written, so the same inputs no longer produce the same match. This is not a
///    hypothetical: every number in this repo is under active gameplay tuning, and the
///    fingerprint is *measured* from a canary match precisely so that nobody has to
///    remember to bump a version constant in the commit that moves a coefficient.
///  - `divergenceIsRejected` — the replay ran and landed somewhere else. Whatever caused
///    it, resuming is wrong.
///  - `futureSaveIsRejected` — the file is from a build that writes a format this one does
///    not read.
enum MatchSaveTests {

    static func run() throws {
        savedMatchRestoresExactly()
        staleSimIsRejected()
        divergenceIsRejected()
        futureSaveIsRejected()
        fingerprintIsStableAndSensitive()
    }

    /// The tick the app runs at, and the one the whole validation suite runs at.
    private static let tickHz = 120
    private static let dt = 1.0 / Double(tickHz)

    /// The seed the saved match is played at. Arbitrary and fixed.
    private static let seed: UInt32 = 0x9e37_79b9

    /// The salt a check stamps with. Stands in for the app's difficulty mapping, which
    /// `SimChecks` cannot see and should not — see `MatchSave.fingerprint`.
    private static let salt = "simchecks"

    /// A configuration that is deliberately *not* `EngineConfig.default`.
    ///
    /// The app builds its engine from a difficulty the player chose, so the restore path
    /// it uses is `ReplayPlayer.init(_:match:)` with a caller-built engine — not
    /// `engineForRecording`, which builds a default one. A suite that only ever restored
    /// default engines would leave the shipped path unasserted, and an assist cone that
    /// differs by a degree is a different match from the first throw.
    private static var config: EngineConfig {
        var c = EngineConfig.default
        c.pointsToWin = 3
        c.selectCone = 44 * Double.pi / 180
        c.assistMax = 8 * Double.pi / 180
        if c.sideStyles.count > 1 { c.sideStyles[1].aggressionScale *= 1.3 }
        return c
    }

    private static func freshEngine() -> Engine {
        Engine(format: .minis, seed: seed, config: config)
    }

    // MARK: - a match, played by a synthetic thumb

    /// What a played match left behind: the engine, the tape, and everything the machine
    /// announced along the way.
    private struct Played {
        let match: Engine
        let inputs: [RecordedInput]
        let ticks: Int
        /// Every event, in order, rendered as text. Compared rather than the events
        /// themselves because `MatchEvent` does not declare `Equatable` and a save system
        /// should not be the reason it starts to.
        let events: [String]
    }

    /// Play a match with a synthetic player in it.
    ///
    /// This mirrors `MatchView` deliberately and in the ways that matter: the sim is
    /// advanced only in whole `1/120 s` ticks, an input is applied the moment it is made
    /// and stamped with the tick that has not run yet, only inputs the engine *accepted*
    /// are written down, and the events are drained every tick. If any of those stopped
    /// being true of the app, this check would keep passing while the app stopped
    /// restoring — so the mirror is the load-bearing part, not the convenience.
    ///
    /// The thumb itself is scripted rather than random: throw whenever we are holding and
    /// the count has reached three, and send a defender whenever they have it and nothing
    /// is committed. That is a plausible bad player, and it produces both kinds of input
    /// in useful numbers.
    ///
    /// **`ticks` is a floor, not a length.** The two assertions below need one input of
    /// each kind in the recording, and both are produced by the *match* — a throw needs us
    /// holding at stall 3, a tap needs them holding — so whether thirty seconds contains
    /// one is a property of how that seed's point happens to run. Any change anywhere in
    /// the sim can move it, and when it does the failure reads as "the save format broke"
    /// rather than "the script did not get a turn". (It did: fixing #55 gave the contact
    /// events back to `policeCatch`, which moved this match enough that no possession of
    /// ours reached stall 3 inside 3600 ticks.) So the harness plays on until it has both,
    /// up to a cap, and everything downstream is already written in terms of
    /// `played.ticks`.
    private static func play(ticks: Int) -> Played {
        let match = freshEngine()
        var inputs: [RecordedInput] = []
        var events: [String] = []
        var tick = 0

        let cap = ticks * 4
        func haveBoth() -> Bool {
            inputs.contains { $0.input == .defend }
                && inputs.contains {
                    if case .charged = $0.input { return true } else { return false }
                }
        }

        while tick < ticks || (!haveBoth() && tick < cap) {
            // Offence: a throw down the field we are attacking, slightly off-axis so the
            // cone select has a decision to make.
            if match.holder != nil, match.stall >= 3, match.carrier == match.controlled {
                let dir = match.attackDirection(of: 0)
                let aim = Vec3d(0.3, 0, dir)
                let type: ThrowType = inputs.count % 2 == 0 ? .backhand : .forehand
                let power = 0.45 + Double(inputs.count % 3) * 0.18
                let quality = 0.6 + Double(inputs.count % 4) * 0.1
                if match.humanRelease(type, aim: aim, power: power, loft: 0, quality: quality) {
                    inputs.append(
                        RecordedInput(
                            tick: tick,
                            input: .charged(
                                throwType: type.rawValue,
                                aimX: aim.x, aimY: aim.y, aimZ: aim.z,
                                power: power, loft: 0, quality: quality)))
                }
            }

            // Defence: the tap, on the same terms the app offers it.
            if match.possession != 0, match.defensiveCommit == nil, tick % 90 == 0 {
                if match.humanDefend() != nil {
                    inputs.append(RecordedInput(tick: tick, input: .defend))
                }
            }

            match.step(dt: dt)
            tick += 1
            for event in match.drainEvents() { events.append(String(describing: event)) }
        }

        return Played(match: match, inputs: inputs, ticks: tick, events: events)
    }

    /// The save a played match would be written as.
    private static func save(_ played: Played, fingerprint: String) -> SavedMatch {
        SavedMatch(
            fingerprint: fingerprint,
            recording: Recording(
                seed: seed,
                field: RecordedField(played.match.fieldSpec),
                tickHz: tickHz,
                autoTeams: played.match.autoTeams.sorted(),
                durationTicks: played.ticks,
                inputs: played.inputs),
            checksum: MatchChecksum(played.match, tick: played.ticks),
            setup: Data("opaque to the sim".utf8))
    }

    // MARK: - the check that matters

    /// Play a match, save it, put the save through JSON, restore it, and assert the
    /// restored match is the same match in every component.
    ///
    /// "Every component" is `MatchSnapshot`: every player's position, velocity and energy,
    /// every disc quantity including orientation and spin, the score, the phase, who is
    /// holding, and the box score — reals by bit pattern, discretes exactly. The score and
    /// the phase agreeing is what a player would notice; the disc's angle of attack
    /// agreeing is what says the restore is the *same simulation* rather than a plausible
    /// reconstruction of it.
    private static func savedMatchRestoresExactly() {
        let stamp = SimFingerprint.stamp(salt: salt)
        let played = play(ticks: 3600)

        Check.ok(
            played.inputs.count >= 4,
            "the recorded match has human input in it — otherwise this asserts nothing "
                + "(\(played.inputs.count) inputs)")
        Check.ok(
            played.inputs.contains { $0.input == .defend },
            "the recorded match includes a defensive tap")
        Check.ok(
            played.inputs.contains {
                if case .charged = $0.input { return true } else { return false }
            },
            "the recorded match includes a charged throw")

        // Through JSON, because that is how it reaches the disk. A format that only
        // survives being held in memory is not a save format.
        let saved = save(played, fingerprint: stamp)
        guard let bytes = try? JSONEncoder().encode(saved),
            let reloaded = try? JSONDecoder().decode(SavedMatch.self, from: bytes)
        else {
            Check.ok(false, "a saved match encodes to JSON and decodes back")
            return
        }
        Check.eq(reloaded, saved, "a saved match survives JSON unchanged")

        // The restore, driven a tick at a time so the events can be drained the way the
        // live match drained them. The app runs it in larger chunks; `ReplayTests`
        // already asserts that the chunking cannot change the result.
        var restoredEvents: [String] = []
        let restore: MatchRestore
        do {
            restore = try MatchRestore(reloaded, fingerprint: stamp, engine: freshEngine())
        } catch {
            Check.ok(false, "a fresh save restores: \(error)")
            return
        }

        Check.eq(restore.totalTicks, played.ticks, "the restore has the whole match to replay")
        let started = DispatchTime.now()
        while !restore.isFinished {
            restore.advance(ticks: 1)
            for event in restore.match.drainEvents() {
                restoredEvents.append(String(describing: event))
            }
        }
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1e9

        do {
            let engine = try restore.finish()
            let want = MatchSnapshot(played.match)
            let got = MatchSnapshot(engine)
            Check.ok(
                got.firstDifference(from: want) == nil,
                "a saved match restores bit-for-bit — \(got.firstDifference(from: want) ?? "")")
            Check.eq(engine.score, played.match.score, "the restored score")
            Check.eq(engine.possession, played.match.possession, "the restored possession")
            Check.eq(engine.phase, played.match.phase, "the restored phase")
            Check.eq(engine.carrier ?? -1, played.match.carrier ?? -1, "the restored carrier")
            Check.eq(restore.tick, played.ticks, "the restore replayed every tick")

            // The event stream. Not a derived view of the state — it is what the machine
            // *announced*, in order, and a restore that reached the same state by a
            // different route would show up here and nowhere else.
            Check.eq(
                restoredEvents.count, played.events.count,
                "the restored match announced the same number of events")
            Check.ok(
                restoredEvents == played.events,
                "the restored match announced the same events in the same order")

            // A finished restore has drained its buffer, so the first frame of a resumed
            // match does not open with a burst of callouts for goals already on the board.
            Check.eq(
                engine.drainEvents().count, 0,
                "a restored match hands over with an empty event buffer")

            // A timing measurement, not an assertion: wall-clock restore speed varies by
            // machine and load, so there is no bound here that would not be either
            // decorative or flaky. Printed for visibility.
            print(
                "  · saved match: \(bytes.count) B of JSON for \(played.ticks) ticks and "
                    + "\(played.inputs.count) inputs, restored in "
                    + "\(String(format: "%.3f", elapsed)) s "
                    + "(\(Int(Double(played.ticks) / Swift.max(elapsed, 1e-9))) ticks/s, so a "
                    + "twenty-minute game restores in about "
                    + "\(String(format: "%.1f", elapsed * 144_000 / Double(played.ticks))) s)")
        } catch {
            Check.ok(false, "a fresh save finishes its restore: \(error)")
        }

        // What the canary costs, since it is paid on the save and on the resume. Also a
        // timing measurement rather than an assertion, for the same reason as above.
        let fingerprintStarted = DispatchTime.now()
        _ = SimFingerprint.stamp(salt: salt)
        let fingerprintCost =
            Double(DispatchTime.now().uptimeNanoseconds - fingerprintStarted.uptimeNanoseconds) / 1e9
        print(
            "  · sim fingerprint: \(SimFingerprint.canaryTicks) canary ticks in "
                + "\(String(format: "%.1f", fingerprintCost * 1000)) ms")
    }

    // MARK: - the three refusals

    /// A save written by a build whose simulation has moved is discarded, not replayed.
    ///
    /// The fingerprint is faked here rather than the simulation being changed, which is
    /// the only way to write this check — but it is the same string comparison the real
    /// case performs, and `fingerprintIsStableAndSensitive` covers the other half, that
    /// the string actually tracks anything.
    ///
    /// Note *where* it is caught: in `init`, before a single tick is replayed. A save that
    /// cannot possibly land should not cost the player twenty minutes of arithmetic first.
    private static func staleSimIsRejected() {
        let played = play(ticks: 600)
        let stale = save(played, fingerprint: "0000-a-build-that-no-longer-exists")
        do {
            _ = try MatchRestore(
                stale, fingerprint: SimFingerprint.stamp(salt: salt), engine: freshEngine())
            Check.ok(false, "a save from a different simulation is refused")
        } catch let error as RestoreError {
            if case .staleSim = error {
                Check.ok(true, "a save from a different simulation is refused")
            } else {
                Check.ok(false, "a stale save is refused as stale, not as \(error)")
            }
        } catch {
            Check.ok(false, "a stale save is refused with a RestoreError, not \(error)")
        }

        // And the whole match is still there afterwards: refusing to restore must not be
        // implemented by half-restoring.
        let good = save(played, fingerprint: SimFingerprint.stamp(salt: salt))
        Check.ok(
            (try? MatchRestore.restore(
                good, fingerprint: SimFingerprint.stamp(salt: salt), engine: freshEngine())) != nil,
            "the same recording with an honest stamp restores")
    }

    /// A save whose replay lands somewhere else is discarded.
    ///
    /// Simulated by moving the checksum, which is the one way to produce a divergence on
    /// demand from a deterministic simulation — but the comparison being exercised is the
    /// real one, and it is the last line of defence: the fingerprint catches a build whose
    /// sim moved, and this catches everything else, including a file truncated mid-write
    /// and a change in the app's own input path that the canary never exercises.
    private static func divergenceIsRejected() {
        let played = play(ticks: 900)
        var tampered = save(played, fingerprint: SimFingerprint.stamp(salt: salt))
        tampered.checksum.score = [tampered.checksum.score[0] + 1, tampered.checksum.score[1]]

        do {
            _ = try MatchRestore.restore(
                tampered, fingerprint: SimFingerprint.stamp(salt: salt), engine: freshEngine())
            Check.ok(false, "a save that replays to a different state is discarded")
        } catch let error as RestoreError {
            if case .diverged = error {
                Check.ok(true, "a save that replays to a different state is discarded")
            } else {
                Check.ok(false, "a diverged save is refused as diverged, not as \(error)")
            }
        } catch {
            Check.ok(false, "a diverged save is refused with a RestoreError, not \(error)")
        }

        // A truncated tape is the same failure with a likelier cause: the file was being
        // written when the system killed the app. It must not restore to a state that
        // looks plausible.
        var truncated = save(played, fingerprint: SimFingerprint.stamp(salt: salt))
        truncated.recording.inputs = Array(truncated.recording.inputs.dropLast())
        if played.inputs.count >= 2 {
            do {
                _ = try MatchRestore.restore(
                    truncated, fingerprint: SimFingerprint.stamp(salt: salt),
                    engine: freshEngine())
                // Not automatically a failure: dropping the last input of a match that
                // was about to end anyway can leave the checksum's coarse facts intact.
                // Worth saying out loud rather than asserting either way.
                print(
                    "  · a save missing its last input still satisfied the checksum — the "
                        + "checksum is the coarse net, the fingerprint is the fine one")
            } catch {
                Check.ok(true, "a save missing an input is discarded (\(error))")
            }
        }
    }

    /// A save from a build that writes a newer format is discarded rather than guessed at.
    private static func futureSaveIsRejected() {
        let played = play(ticks: 240)
        var future = save(played, fingerprint: SimFingerprint.stamp(salt: salt))
        future.version = SavedMatch.currentVersion + 1

        do {
            _ = try MatchRestore(
                future, fingerprint: SimFingerprint.stamp(salt: salt), engine: freshEngine())
            Check.ok(false, "a save in an unknown format is refused")
        } catch let error as RestoreError {
            if case .unsupportedSave = error {
                Check.ok(true, "a save in an unknown format is refused")
            } else {
                Check.ok(false, "a future save is refused as unsupported, not as \(error)")
            }
        } catch {
            Check.ok(false, "a future save is refused with a RestoreError, not \(error)")
        }

        // The version check comes before the fingerprint check, because a file this build
        // cannot parse is not a file it can meaningfully compare stamps from.
        do {
            _ = try MatchRestore(future, fingerprint: "irrelevant", engine: freshEngine())
            Check.ok(false, "an unreadable save is refused on its version first")
        } catch let error as RestoreError {
            if case .unsupportedSave = error {
                Check.ok(true, "an unreadable save is refused on its version first")
            } else {
                Check.ok(false, "version is checked before the stamp, got \(error)")
            }
        } catch {
            Check.ok(false, "an unreadable save is refused with a RestoreError, not \(error)")
        }
    }

    /// The fingerprint is the same twice on one build, and different for different inputs.
    ///
    /// Both halves are load-bearing and they pull against each other. Unstable, and every
    /// save is refused on the next launch, which is the feature not existing. Insensitive,
    /// and no save is ever refused, which is the feature being actively harmful. This
    /// cannot assert the property that matters most — that it changes when the *sim*
    /// changes — because a check runs inside one build; what it can assert is that the
    /// stamp is a function of a match's numbers, which is what makes that property follow.
    private static func fingerprintIsStableAndSensitive() {
        Check.eq(
            SimFingerprint.stamp(salt: salt), SimFingerprint.stamp(salt: salt),
            "the sim fingerprint is the same twice on one build")
        Check.ok(
            SimFingerprint.stamp(salt: "easy") != SimFingerprint.stamp(salt: "hard"),
            "the sim fingerprint separates two setups that build different engines")
        Check.ok(
            SimFingerprint.stamp() != SimFingerprint.stamp(salt: salt),
            "an unsalted stamp is not a salted one")
        Check.ok(
            !SimFingerprint.stamp(salt: salt).isEmpty,
            "the sim fingerprint is something you can write in a file")
    }
}
