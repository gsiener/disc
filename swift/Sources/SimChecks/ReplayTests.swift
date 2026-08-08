import Foundation
import UltimateSim

/// Recording a match and playing it back, asserted rather than hoped for.
///
/// `MatchTests.deterministic` already shows that one seed twice produces one match. This
/// suite asserts the harder and more useful thing: that a match with *human input in it*
/// can be reconstructed from a seed and a few hundred bytes of stamped inputs, and that
/// the reconstruction is bit-identical in every position, velocity, disc quantity, score
/// and counter.
///
/// That makes a recording the broadest regression test in the project. Every unit
/// assertion elsewhere pins one operation; a replay pins the composition of all of them
/// across thirty seconds of play. A recorded match that stops replaying is a behaviour
/// change even when all 379,674 other assertions still pass.
///
/// Two of these checks exist to keep the others honest:
///
///  - `differentInputsDiverge` is what makes `replaysBitForBit` non-vacuous. A replay
///    system that ignored its inputs entirely would pass a bit-equality check perfectly,
///    because both sides would be the same input-free match. So it is asserted that
///    changing one drag changes the match, and that the recorded match differs from the
///    same seed played with no input at all.
///  - `invariantToFrameTiming` is the claim `Replay.swift` makes in its design and is the
///    one that fails on a phone rather than on the machine it was written on. It is
///    asserted directly: the same recording, played tick by tick, in jittery wall-clock
///    slices, and in one enormous slice, must produce one match.
enum ReplayTests {

    static func run() throws {
        replaysBitForBit()
        differentInputsDiverge()
        invariantToFrameTiming()
        sameTickInputsKeepTheirOrder()
        degenerateRecordings()
        jsonRoundTrip()
    }

    /// Two inputs stamped on the same tick must replay in the order they were recorded.
    ///
    /// This was found by mutation testing rather than by design. Reversing the tie-break
    /// in the playback sort — the `$0.offset < $1.offset` that makes it stable — changed
    /// nothing, because every other fixture here puts at most one input on a tick. The
    /// stable sort was correct and completely unverified.
    ///
    /// It is reachable: `record()` stamps with the tick that has not run yet, so anything
    /// a single frame delivers twice lands on one stamp. Order matters there because the
    /// first input can change what the second one *means* — a throw followed by anything
    /// else is a different match from the reverse.
    private static func sameTickInputsKeepTheirOrder() {
        func run(reversed: Bool) -> MatchSnapshot {
            let rec = MatchRecorder(field: .minis, seed: 4242, tickHz: tickHz)
            rec.match.autoTeams = [1]
            for _ in 0..<120 { rec.tick() }
            // Two drags on one tick, pointing opposite ways. Only the first can be a
            // throw — the second arrives with the disc already gone — so the order is
            // the whole difference between the two matches.
            let a = ReplayInput.drag(dx: 0, dy: -200, shortEdge: shortEdge)
            let b = ReplayInput.drag(dx: 200, dy: 0, shortEdge: shortEdge)
            rec.record(reversed ? b : a)
            rec.record(reversed ? a : b)
            for _ in 0..<600 { rec.tick() }
            return MatchSnapshot(rec.match)
        }

        let forward = run(reversed: false)
        let backward = run(reversed: true)

        // Both stamps must be the same tick, or this is not testing what it claims.
        let rec = MatchRecorder(field: .minis, seed: 4242, tickHz: tickHz)
        rec.match.autoTeams = [1]
        for _ in 0..<120 { rec.tick() }
        rec.record(.drag(dx: 0, dy: -200, shortEdge: shortEdge))
        rec.record(.drag(dx: 200, dy: 0, shortEdge: shortEdge))
        let stamps = rec.recording.inputs.map(\.tick)
        Check.eq(stamps.count, 2, "both inputs were recorded")
        Check.ok(
            stamps.first == stamps.last,
            "two inputs delivered in one frame land on the same tick (\(stamps))")

        Check.ok(
            forward != backward,
            "swapping two same-tick inputs produces a different match")

        // And the recorded order replays faithfully.
        let tape = MatchRecorder(field: .minis, seed: 4242, tickHz: tickHz)
        tape.match.autoTeams = [1]
        for _ in 0..<120 { tape.tick() }
        tape.record(.drag(dx: 0, dy: -200, shortEdge: shortEdge))
        tape.record(.drag(dx: 200, dy: 0, shortEdge: shortEdge))
        for _ in 0..<600 { tape.tick() }
        let live = MatchSnapshot(tape.match)

        let player = try? ReplayPlayer(tape.recording)
        guard let player else {
            Check.ok(false, "the same-tick recording is playable")
            return
        }
        player.runToEnd()
        Check.ok(
            MatchSnapshot(player.match) == live,
            "a recording with two inputs on one tick replays bit-for-bit")
    }

    // MARK: the script

    /// Thirty seconds at 120 Hz. Long enough to contain turnovers and a restart, short
    /// enough that eight replays of it stay cheap.
    private static let totalTicks = 3600
    private static let tickHz = 120
    /// A phone's short edge in points, so the drags mean what they would mean in the hand.
    private static let shortEdge = 390.0

    /// The drags a human is pretending to make, and the tick each one lands on.
    ///
    /// The first is at tick 120 — one second in, while team 0 is certainly still holding
    /// the disc it received — so that at least one input is guaranteed to take effect no
    /// matter how the rest of the match unfolds. Without that guarantee every assertion
    /// below could be about a match with no human input in it.
    private static func script() -> [(tick: Int, dx: Double, dy: Double)] {
        [
            (120, 0, -300),
            (600, 150, -120),
            (1200, -200, 0),
            (1800, 0, 300),
            (2400, 220, -80),
            (3000, -60, -260),
        ]
    }

    /// Record a match, driving it with a deliberately irregular wall clock.
    ///
    /// The jitter is drawn from the project's own seeded RNG rather than from a real
    /// clock, so this check has no wall-clock dependency of its own — but it is the same
    /// shape of jitter a display-paced loop produces, and the recorder has to survive it.
    private static func record(
        seed: UInt32, drags: [(tick: Int, dx: Double, dy: Double)], jitterSeed: UInt32 = 4242
    ) -> MatchRecorder {
        let recorder = MatchRecorder(field: .minis, seed: seed, tickHz: tickHz, autoTeams: [1])
        let jitter = Rng(seed: jitterSeed)
        var pending = drags

        while recorder.tickCount < totalTicks {
            // An input lands on whichever tick boundary has been reached, which is what a
            // touch-up between frames actually does.
            while let next = pending.first, recorder.tickCount >= next.tick {
                pending.removeFirst()
                recorder.record(.drag(dx: next.dx, dy: next.dy, shortEdge: shortEdge))
            }
            // 4 ms to 50 ms: a fast frame to a badly dropped one.
            recorder.advance(realTime: jitter.range(0.004, 0.05), maxTicks: 32)
        }
        return recorder
    }

    // MARK: a recorded match replays bit-for-bit

    private static func replaysBitForBit() {
        let recorder = record(seed: 77, drags: script())
        let tape = recorder.recording
        let live = MatchSnapshot(recorder.match)

        // The recording is a seed and a handful of inputs, not a state dump. If this ever
        // becomes false the design has been abandoned rather than changed.
        Check.eq(tape.inputs.count, script().count, "every drag made it onto the tape")
        Check.ok(tape.durationTicks >= totalTicks, "the tape covers the match it recorded")
        Check.eq(tape.strandedInputs, 0, "no input is stamped past the end of the tape")
        Check.ok(
            recorder.match.stats.throwsMade > 0,
            "the recorded match actually contains throws — otherwise this suite asserts nothing")

        guard let replayed = try? ReplayPlayer.play(tape) else {
            Check.ok(false, "a freshly recorded tape replays at all")
            return
        }
        let after = MatchSnapshot(replayed)

        // One assertion for the whole match, naming the component that broke.
        Check.ok(
            after.firstDifference(from: live) == nil,
            "a recorded match replays bit-for-bit — \(after.firstDifference(from: live) ?? "")")

        // Then component by component, so a single drifting quantity is visible as one
        // failure rather than as one opaque one. Reals go through `bitEqViaJSON`: every
        // one of them is the output of `+ - * / sqrt min max clamp` and must agree to the
        // last bit, with the sign of a zero the only allowed slack.
        let labels = MatchSnapshot.realLabels(teamSize: replayed.field.teamSize)
        for i in after.reals.indices where i < live.reals.count {
            Check.bitEqViaJSON(after.reals[i], live.reals[i], "replayed \(labels[i])")
        }
        let discreteLabels = MatchSnapshot.discreteLabels(teamSize: replayed.field.teamSize)
        for i in after.discrete.indices where i < live.discrete.count {
            Check.eq(after.discrete[i], live.discrete[i], "replayed \(discreteLabels[i])")
        }

        // The score and the counters are the part a human would notice, so they are also
        // asserted by name rather than only by index.
        Check.eq(replayed.score, recorder.match.score, "the replayed score matches")
        Check.eq(replayed.stats, recorder.match.stats, "every possession ended the same way")
        Check.eq(replayed.phase, recorder.match.phase, "the replay ends in the same phase")

        // A match with nobody playing it — both teams on the computer — leans hardest on
        // the RNG, and has to replay from an empty input list just as exactly. This is
        // also the attract mode, and the case a resume-on-launch would use.
        let attract = MatchRecorder(field: .minis, seed: 3, tickHz: tickHz, autoTeams: [0, 1])
        while attract.tickCount < totalTicks { attract.tick() }
        Check.ok(attract.recording.inputs.isEmpty, "an unattended match records no inputs")
        if let replayedAttract = try? ReplayPlayer.play(attract.recording) {
            let got = MatchSnapshot(replayedAttract)
            Check.ok(
                got.firstDifference(from: MatchSnapshot(attract.match)) == nil,
                "an unattended match replays from its seed alone — "
                    + (got.firstDifference(from: MatchSnapshot(attract.match)) ?? ""))
            Check.ok(
                replayedAttract.stats.throwsMade > 0, "the unattended match contained throws")
        } else {
            Check.ok(false, "an unattended match replays at all")
        }

        Check.note(
            "replay: \(tape.durationTicks) ticks, \(tape.inputs.count) inputs, "
                + "\(after.reals.count) reals and \(after.discrete.count) discrete values "
                + "bit-identical  (score \(replayed.score[0])-\(replayed.score[1]), "
                + "\(replayed.stats.throwsMade) throws)")
    }

    // MARK: the check that proves the check can fail

    private static func differentInputsDiverge() {
        let base = record(seed: 77, drags: script())
        let baseline = MatchSnapshot(base.match)

        // One drag reversed: up the screen is a hammer, down the screen is a dump. Same
        // seed, same tick, same everything else.
        var altered = script()
        altered[0] = (120, 0, 300)
        let other = record(seed: 77, drags: altered)
        let changed = MatchSnapshot(other.match)

        Check.ok(
            baseline != changed,
            "one different drag produces a different match — so bit-equality above is a claim, not a tautology")

        // And a match with no human input at all is different again, which is what says
        // the inputs are being applied rather than merely carried.
        let silent = record(seed: 77, drags: [])
        Check.ok(
            MatchSnapshot(silent.match) != baseline,
            "the recorded inputs actually change the match they were recorded in")

        // Both variants have to be real matches, or "different" would be trivial.
        Check.ok(base.match.stats.throwsMade > 0, "the baseline match contains throws")
        Check.ok(other.match.stats.throwsMade > 0, "the altered match contains throws")

        // A different seed is a different match — but only where the seed reaches.
        //
        // It is worth being precise about this, because it is a real and surprising
        // property of the interim engine rather than a quirk of this check. `Match` draws
        // from the RNG in exactly one place: the backhand-or-forehand coin flip in
        // `autoThrow`. Everything else — cutting, marking, catching, the stall — is
        // geometry. So with only team 1 automated over thirty seconds, seeds 77 and 78
        // produce a *bit-identical* match, and asserting otherwise would be asserting a
        // coincidence. Put both teams on the computer, where the flip is reached often,
        // and the seed separates them immediately.
        let seeded = { (seed: UInt32) -> MatchSnapshot in
            let r = MatchRecorder(field: .minis, seed: seed, tickHz: tickHz, autoTeams: [0, 1])
            while r.tickCount < totalTicks { r.tick() }
            return MatchSnapshot(r.match)
        }
        Check.ok(seeded(77) != seeded(78), "a different seed is a different match")
        Check.ok(seeded(77) == seeded(77), "the same seed is the same match")
        Check.note(
            "the seed reaches the interim engine through one draw — the throw-type coin "
                + "flip in autoThrow — so an unautomated match is determined by its inputs alone")
    }

    // MARK: frame timing

    /// The claim `Replay.swift` is built around: playback does not depend on the wall
    /// clock, because inputs are stamped in fixed ticks and the sim is only ever stepped
    /// by `1 / tickHz`.
    ///
    /// This is the check that would have caught the failure mode the design exists to
    /// avoid — a replay that works at 60 fps on a Mac and drifts on a phone that drops to
    /// 42 and back. Three playbacks of one tape, chunked three ways.
    private static func invariantToFrameTiming() {
        let tape = record(seed: 91, drags: script()).recording

        guard let byTick = try? ReplayPlayer(tape),
            let byClock = try? ReplayPlayer(tape),
            let inOneGo = try? ReplayPlayer(tape)
        else {
            Check.ok(false, "three players open the same tape")
            return
        }

        byTick.runToEnd()

        // A jittery display: 4 ms to 50 ms slices, some of which earn no tick at all.
        let jitter = Rng(seed: 31337)
        var guardCount = 0
        while !byClock.isFinished && guardCount < 200_000 {
            byClock.advance(realTime: jitter.range(0.004, 0.05), maxTicks: 32)
            guardCount += 1
        }

        // A single slice far longer than the recording, which is what resuming from the
        // background looks like.
        inOneGo.advance(realTime: 600, maxTicks: Int.max)

        Check.eq(byTick.tick, tape.durationTicks, "tick-by-tick playback runs the whole tape")
        Check.eq(byClock.tick, tape.durationTicks, "wall-clock playback runs the whole tape")
        Check.eq(inOneGo.tick, tape.durationTicks, "one huge slice runs the whole tape, and no more")

        let a = MatchSnapshot(byTick.match)
        let b = MatchSnapshot(byClock.match)
        let c = MatchSnapshot(inOneGo.match)

        Check.ok(
            a.firstDifference(from: b) == nil,
            "a jittery frame clock replays identically to a fixed one — \(a.firstDifference(from: b) ?? "")")
        Check.ok(
            a.firstDifference(from: c) == nil,
            "playing the whole tape in one slice is identical — \(a.firstDifference(from: c) ?? "")")

        // Componentwise on the jittered playback, for the same reason as above: a single
        // quantity that drifts under variable timing should name itself.
        let labels = MatchSnapshot.realLabels(teamSize: byTick.match.field.teamSize)
        for i in a.reals.indices where i < b.reals.count {
            Check.bitEqViaJSON(b.reals[i], a.reals[i], "frame-timing invariant: \(labels[i])")
        }

        // A recording carries its own step. A tape made at 120 Hz must not be replayable
        // at 60 by accident, because that would be a different match wearing the same name.
        var retimed = tape
        retimed.tickHz = 60
        if let odd = try? ReplayPlayer.play(retimed) {
            Check.ok(
                MatchSnapshot(odd) != a,
                "replaying a 120 Hz tape at 60 Hz is a different match, and is not silently equal")
        } else {
            Check.ok(false, "a retimed tape still loads")
        }
        Check.bitEqViaJSON(tape.dt, 1.0 / 120.0, "the recorded step is exactly 1/120")
    }

    // MARK: recordings that are broken

    /// A truncated, empty or impossible recording must fail as a value, not as a crash.
    ///
    /// Recordings arrive from disk, from a bug report, from a build two versions old. The
    /// bar is that every one of these paths ends in a thrown `ReplayError` or in a sane
    /// empty match, and none of them ends in a trap.
    private static func degenerateRecordings() {
        let field = RecordedField(FieldSpec.minis)

        // Empty: no ticks, no inputs. The result is a match that has not started, which
        // is exactly what zero ticks of a match should be.
        let empty = Recording(
            seed: 5, field: field, tickHz: tickHz, autoTeams: [1], durationTicks: 0, inputs: [])
        guard let played = try? ReplayPlayer.play(empty) else {
            Check.ok(false, "an empty recording replays into a fresh match")
            return
        }
        let fresh = Match(field: .minis, seed: 5)
        Check.ok(
            MatchSnapshot(played).firstDifference(from: MatchSnapshot(fresh)) == nil,
            "an empty recording replays into exactly the opening position")
        Check.eq(empty.strandedInputs, 0, "an empty recording strands nothing")

        // Inputs with nowhere to run: a tape cut short after the fact. The inputs are
        // reported as stranded rather than silently applied at the wrong moment.
        let cut = Recording(
            seed: 5, field: field, tickHz: tickHz, autoTeams: [1], durationTicks: 0,
            inputs: [RecordedInput(tick: 0, input: .drag(dx: 0, dy: -300, shortEdge: shortEdge))])
        Check.eq(cut.strandedInputs, 1, "an input past the end of a tape is visible, not silent")
        guard let cutPlayed = try? ReplayPlayer.play(cut) else {
            Check.ok(false, "a tape truncated before its inputs still replays")
            return
        }
        Check.eq(cutPlayed.stats.throwsMade, 0, "a stranded input is never applied")

        // Out of order and duplicated stamps. Playback has to be a function of the tape,
        // not of the order the array happened to be built in, and `ordered` breaks ties by
        // position so that two inputs on one tick are still deterministic.
        let shuffled = Recording(
            seed: 5, field: field, tickHz: tickHz, autoTeams: [1], durationTicks: 400,
            inputs: [
                RecordedInput(tick: 300, input: .drag(dx: -200, dy: 0, shortEdge: shortEdge)),
                RecordedInput(tick: 120, input: .drag(dx: 0, dy: -300, shortEdge: shortEdge)),
                RecordedInput(tick: 120, input: .drag(dx: 120, dy: -40, shortEdge: shortEdge)),
            ])
        Check.eq(shuffled.ordered.map(\.tick), [120, 120, 300], "inputs replay in tick order")
        guard let first = try? ReplayPlayer.play(shuffled),
            let second = try? ReplayPlayer.play(shuffled)
        else {
            Check.ok(false, "an out-of-order tape replays")
            return
        }
        Check.ok(
            MatchSnapshot(first) == MatchSnapshot(second),
            "an out-of-order tape replays the same way twice")

        // Truncated JSON, at several depths. Every one of these is a thrown decode error.
        guard let bytes = try? JSONEncoder().encode(record(seed: 12, drags: script()).recording)
        else {
            Check.ok(false, "a recording encodes")
            return
        }
        for fraction in [0.0, 0.25, 0.5, 0.9] {
            let cutTo = Int(Double(bytes.count) * fraction)
            let partial = bytes.prefix(cutTo)
            var threw = false
            do { _ = try JSONDecoder().decode(Recording.self, from: partial) } catch { threw = true }
            Check.ok(threw, "a recording truncated to \(Int(fraction * 100))% fails to decode")
        }
        for junk in ["{}", "[]", "null", "{\"version\":1}"] {
            var threw = false
            do {
                _ = try JSONDecoder().decode(Recording.self, from: Data(junk.utf8))
            } catch { threw = true }
            Check.ok(threw, "'\(junk)' is not a recording")
        }

        // Impossible values. Each is refused with a reason rather than replayed into a
        // plausible-looking match.
        func refuses(_ recording: Recording, _ want: ReplayError, _ label: String) {
            do {
                _ = try ReplayPlayer(recording)
                Check.ok(false, "\(label) — the recording was accepted")
            } catch let e as ReplayError {
                Check.eq(e, want, label)
            } catch {
                Check.ok(false, "\(label) — threw \(error) rather than a ReplayError")
            }
        }

        var bad = Recording(
            seed: 5, field: field, tickHz: tickHz, autoTeams: [1], durationTicks: 10, inputs: [])
        bad.version = 99
        refuses(bad, .unsupportedVersion(99), "a recording from a future format is refused")

        bad = Recording(
            seed: 5, field: field, tickHz: 0, autoTeams: [1], durationTicks: 10, inputs: [])
        refuses(bad, .badTickRate(0), "a zero tick rate is refused rather than dividing by zero")

        bad = Recording(
            seed: 5, field: field, tickHz: tickHz, autoTeams: [1], durationTicks: -1, inputs: [])
        refuses(bad, .badDuration(-1), "a negative duration is refused")

        bad = Recording(
            seed: 5, field: field, tickHz: tickHz, autoTeams: [1], durationTicks: 10,
            inputs: [RecordedInput(tick: -3, input: .drag(dx: 0, dy: -1, shortEdge: shortEdge))])
        refuses(bad, .negativeTick(-3), "an input stamped before the match is refused")

        bad = Recording(
            seed: 5, field: field, tickHz: tickHz, autoTeams: [1], durationTicks: 10,
            inputs: [
                RecordedInput(
                    tick: 0,
                    input: .release(
                        throwType: "quaffle", aimX: 0, aimY: 0, aimZ: 1, power: 0.5, loft: 0))
            ])
        refuses(bad, .unknownThrow("quaffle"), "a throw this build does not have is refused")

        bad = Recording(
            seed: 5, field: field, tickHz: tickHz, autoTeams: [1], durationTicks: 10,
            inputs: [
                RecordedInput(
                    tick: 0, input: .drag(dx: Double.nan, dy: 0, shortEdge: shortEdge))
            ])
        refuses(bad, .nonFiniteInput(0), "a NaN in an input is refused before it reaches the sim")

        var badField = field
        badField.width = 0
        bad = Recording(
            seed: 5, field: badField, tickHz: tickHz, autoTeams: [1], durationTicks: 10, inputs: [])
        var threwField = false
        do { _ = try ReplayPlayer(bad) } catch { threwField = true }
        Check.ok(threwField, "a pitch with no width is refused")

        // A clock that hiccups cannot move the simulation. Negative and non-finite
        // elapsed times are absorbed outside the sim, which is the point of keeping the
        // accumulator out there.
        guard let player = try? ReplayPlayer(shuffled) else {
            Check.ok(false, "a player opens for the clock check")
            return
        }
        Check.eq(player.advance(realTime: -1), 0, "time running backwards advances nothing")
        Check.eq(player.advance(realTime: .nan), 0, "a NaN frame time advances nothing")
        Check.eq(player.advance(realTime: .infinity), 0, "an infinite frame time advances nothing")
        Check.eq(player.tick, 0, "and the match has not moved")
    }

    // MARK: JSON

    private static func jsonRoundTrip() {
        let tape = record(seed: 77, drags: script()).recording

        let encoder = JSONEncoder()
        // Sorted keys so the encoding is a function of the recording and not of a
        // dictionary's iteration order — a recording that encoded differently each time
        // could not be diffed or checksummed.
        encoder.outputFormatting = [.sortedKeys]
        guard let bytes = try? encoder.encode(tape) else {
            Check.ok(false, "a recording encodes to JSON")
            return
        }
        guard let again = try? encoder.encode(tape) else {
            Check.ok(false, "a recording encodes twice")
            return
        }
        Check.eq(bytes, again, "encoding is deterministic")

        guard let decoded = try? JSONDecoder().decode(Recording.self, from: bytes) else {
            Check.ok(false, "a recording decodes from its own JSON")
            return
        }

        Check.eq(decoded.version, tape.version, "version survives the round trip")
        Check.eq(decoded.seed, tape.seed, "seed survives the round trip")
        Check.eq(decoded.tickHz, tape.tickHz, "tick rate survives the round trip")
        Check.eq(decoded.durationTicks, tape.durationTicks, "duration survives the round trip")
        Check.eq(decoded.autoTeams, tape.autoTeams, "the computer's teams survive the round trip")
        Check.eq(decoded.inputs.count, tape.inputs.count, "every input survives the round trip")
        Check.eq(decoded.field, tape.field, "the pitch survives the round trip")

        // The numbers inside the inputs are compared bitwise, not with `==`: a round trip
        // that lost the last bit of a drag would still compare equal under `==` for a
        // signed zero, and would replay a different match.
        for (i, pair) in zip(decoded.inputs, tape.inputs).enumerated() {
            Check.eq(pair.0.tick, pair.1.tick, "input \(i) keeps its tick")
            let got = numbers(in: pair.0.input)
            let want = numbers(in: pair.1.input)
            Check.eq(got.count, want.count, "input \(i) keeps its shape")
            for (j, values) in zip(got, want).enumerated() {
                Check.bitEqViaJSON(values.0, values.1, "input \(i) component \(j) survives JSON")
            }
        }
        Check.ok(decoded == tape, "the decoded recording equals the one that was written")

        // And the only test of a round trip that really matters: does it still replay to
        // the same match?
        guard let fromOriginal = try? ReplayPlayer.play(tape),
            let fromJSON = try? ReplayPlayer.play(decoded)
        else {
            Check.ok(false, "both the original and the decoded recording replay")
            return
        }
        let a = MatchSnapshot(fromOriginal)
        let b = MatchSnapshot(fromJSON)
        Check.ok(
            b.firstDifference(from: a) == nil,
            "a recording that has been through JSON replays bit-for-bit — \(b.firstDifference(from: a) ?? "")")

        // Size. The claim is that a recording is a seed and some inputs; the falsifiable
        // form of that claim is a byte count that does not grow with the match's length.
        // A per-frame dump of the same match would be `durationTicks * reals` doubles.
        let dumped = tape.durationTicks * a.reals.count
        Check.ok(
            bytes.count < 2048,
            "a thirty-second recording is a few hundred bytes, not a state dump (\(bytes.count) B)")
        Check.note(
            "recording: \(bytes.count) B of JSON for \(tape.durationTicks) ticks and "
                + "\(tape.inputs.count) inputs — a per-frame dump of the same match would be "
                + "\(dumped) doubles (~\(dumped * 8 / 1024) KiB before punctuation)")
    }

    /// The doubles inside an input, in a fixed order, for bitwise comparison.
    private static func numbers(in input: ReplayInput) -> [Double] {
        switch input {
        case .drag(let dx, let dy, let shortEdge): [dx, dy, shortEdge]
        case .release(_, let ax, let ay, let az, let power, let loft): [ax, ay, az, power, loft]
        }
    }
}
