import Foundation

/// Recording a match as a seed plus a list of inputs, and playing it back exactly.
///
/// The whole project is arranged so that this file can be short. The RNG is a bit-exact
/// port, nothing is compiled with fast-math, and `Engine` reads no clock — so the states
/// of a match are a pure function of `(field, seed, autoTeams, the inputs, the tick
/// sequence)`. A recording is therefore those five things and nothing else. It is not a
/// state dump: thirty seconds of 3v3 is a few hundred bytes here and about a quarter of
/// a million doubles if you write the frames down instead.
///
/// That makes it the strongest regression test available. A unit assertion says one
/// operation still produces one number; a replay says *every* operation in a thirty
/// second match still composes into the same number. A recorded match that diverges is
/// a change in behaviour even when every other assertion in the suite still passes.
///
/// # The frame-timing decision: inputs are stamped in ticks, not in seconds
///
/// This is the design decision the rest of the file exists to serve, and it is the one
/// that decides whether a replay made on a Mac plays back on a phone.
///
/// `Engine.step(dt:)` is **not associative in `dt`**. `step(0.02)` is not `step(0.01)`
/// twice: `Locomotion` integrates each body once per call and decays its gait with
/// `exp(-k * dt)`, `TeamAI` decides once per call from a world stamped with the
/// accumulated clock, the stall accumulates in whole `dt`s, and the disc is sampled for a
/// catch once per call. `Locomotion.step` even clamps a `dt` above 1/30 outright, so a
/// long step is not merely a coarse approximation of several short ones — it is a
/// different simulation. The sequence of `dt`s is therefore part of the input, exactly
/// like the seed is. Anything that changes it changes the match.
///
/// A display-paced loop hands the simulation whatever the wall clock last measured —
/// 16.7 ms, then 15.9, then 48 because a notification arrived. Those numbers are not
/// reproducible on the same machine twice, never mind across machines. Two consequences
/// follow, and they are the whole design:
///
///  1. **The simulation only ever advances by a fixed tick**, `1 / tickHz`, computed as
///     `1.0 / Double(tickHz)` at both record and replay time — one correctly rounded
///     IEEE division of two exactly representable values, so it is the same bit pattern
///     everywhere. Real time decides only *how many* whole ticks run, never how big they
///     are. `FixedClock` keeps the leftover fraction of a frame outside the simulation,
///     where it can never reach a number the sim reads.
///
///  2. **An input is stamped with the tick it will be consumed by**, an `Int`, not with
///     the second it happened at. A stamp in seconds has to be resolved to a frame
///     boundary at playback time, and with a different `dt` sequence it resolves to a
///     different boundary — the throw is released one frame later, off a position that
///     is a centimetre away, and the match diverges from there. An integer tick has no
///     such ambiguity: tick 412 is tick 412 on any hardware, at any frame rate, under
///     any scheduler.
///
/// The claim this buys, and which `ReplayTests` asserts rather than asserts by comment:
/// playing a recording produces a bit-identical match regardless of the real-time
/// chunking used to drive playback — tick by tick, in jittery 4-50 ms slices, or all at
/// once.
///
/// # Where an input is applied
///
/// `MatchRecorder.record` applies the input to the live match immediately, so a thumb
/// gets instant feedback, and stamps it with the tick that has not run yet. `ReplayPlayer`
/// applies inputs *before* the step of the tick they are stamped with. These are the same
/// state transition, because nothing else touches the match between the two moments. That
/// equivalence is what makes record and replay agree, and it is why the recorder must own
/// the loop rather than sit beside it.

// MARK: - what a recording holds

/// The pitch, flattened into a recording.
///
/// Deliberately a copy of the numbers rather than a reference to `FieldSpec.minis`. A
/// recording that named its format would silently change meaning the day somebody tunes
/// the constant, and a replay that quietly plays a different game is worse than one that
/// refuses to load.
public struct RecordedField: Codable, Equatable, Sendable {
    public var length: Double
    public var width: Double
    public var endzoneDepth: Double
    public var teamSize: Int
    public var target: Int

    public init(_ f: FieldSpec) {
        length = f.length
        width = f.width
        endzoneDepth = f.endzoneDepth
        teamSize = f.teamSize
        target = f.target
    }

    public var spec: FieldSpec {
        FieldSpec(
            length: length, width: width, endzoneDepth: endzoneDepth,
            teamSize: teamSize, target: target)
    }
}

/// One thing a human did.
///
/// `drag` stores the gesture in screen points rather than the throw it was interpreted
/// as, so `ThrowGesture` runs again on playback. That is on purpose: it puts the control
/// scheme itself inside the replay's blast radius, so changing what a drag means shows up
/// as a diverging recording rather than as a silently different game.
///
/// `release` is for a throw whose parameters were decided without a screen — a scripted
/// check, a tutorial, an attract mode. `throwType` is the raw string rather than
/// `ThrowType` because `ThrowType` does not declare `Codable`, and a recording should not
/// be the reason it starts to.
///
/// `charged` is `release` plus the release *quality* the charge meter produced. It is a
/// separate case rather than a defaulted parameter on `release` because an enum case has
/// no defaults: widening `release` would rewrite the meaning of every recording already
/// written, which is the one thing the version field exists to prevent. Adding a case is
/// the compatible move — an old recording still decodes, and a recording that uses the
/// new case simply will not load on a build that predates it.
///
/// `defend` is the whole of the defensive control: a tap is a *call*, carrying no
/// coordinates (see `Engine.humanDefend`), so there is nothing to store but the tick.
public enum ReplayInput: Codable, Equatable, Sendable {
    case drag(dx: Double, dy: Double, shortEdge: Double)
    case release(throwType: String, aimX: Double, aimY: Double, aimZ: Double, power: Double, loft: Double)
    case charged(
        throwType: String, aimX: Double, aimY: Double, aimZ: Double, power: Double, loft: Double,
        quality: Double)
    case defend
}

/// An input and the tick it is consumed by. See the file comment for why this is an
/// integer tick and not a timestamp.
public struct RecordedInput: Codable, Equatable, Sendable {
    public var tick: Int
    public var input: ReplayInput

    public init(tick: Int, input: ReplayInput) {
        self.tick = tick
        self.input = input
    }
}

/// A whole match, as a seed and a list of inputs.
///
/// Everything here is small and human-readable on purpose: a bug report can be a JSON
/// file in an issue, and a regression fixture can be diffed.
public struct Recording: Codable, Equatable, Sendable {
    /// Bumped when the meaning of any field changes. An old recording is refused rather
    /// than reinterpreted, because a replay that plays a *different* match is a worse
    /// outcome than one that will not load.
    public static let currentVersion = 1

    public var version: Int
    public var seed: UInt32
    public var field: RecordedField
    /// Simulation ticks per second. The match is never stepped by anything else.
    public var tickHz: Int
    /// Teams whose throws the computer decides. Sorted, so the recording is canonical.
    public var autoTeams: [Int]
    /// How many ticks the recording covers. Playback runs exactly this many.
    public var durationTicks: Int
    public var inputs: [RecordedInput]

    public init(
        version: Int = Recording.currentVersion,
        seed: UInt32,
        field: RecordedField,
        tickHz: Int,
        autoTeams: [Int],
        durationTicks: Int,
        inputs: [RecordedInput]
    ) {
        self.version = version
        self.seed = seed
        self.field = field
        self.tickHz = tickHz
        self.autoTeams = autoTeams.sorted()
        self.durationTicks = durationTicks
        self.inputs = inputs
    }

    /// The fixed step, in seconds. One correctly rounded division, so every machine that
    /// reads this recording steps by the same bit pattern.
    public var dt: Double { 1.0 / Double(tickHz) }

    /// Seconds of match covered. Informational — nothing in the replay path reads it.
    public var seconds: Double { Double(durationTicks) * dt }

    /// The inputs in the order playback consumes them.
    ///
    /// Sorted by tick, ties broken by original position. `Array.sorted` is not documented
    /// to be stable, so the index is folded into the comparison rather than trusted to
    /// survive it — otherwise a recording with two inputs on one tick could replay
    /// differently on a different sort implementation, which is precisely the class of
    /// bug this file exists to rule out.
    public var ordered: [RecordedInput] {
        inputs.enumerated()
            .sorted {
                $0.element.tick == $1.element.tick
                    ? $0.offset < $1.offset
                    : $0.element.tick < $1.element.tick
            }
            .map(\.element)
    }

    /// Inputs stamped past the end of the recording, which playback will never reach.
    ///
    /// Not an error — a recording truncated after the fact is a normal thing to have —
    /// but worth being able to see, because "my throw is missing" and "my recording is
    /// two ticks short" are the same bug.
    public var strandedInputs: Int {
        inputs.reduce(0) { $0 + ($1.tick >= durationTicks ? 1 : 0) }
    }

    /// Rejects a recording that cannot be replayed, with a reason.
    ///
    /// Every check here is about a value the replay path would otherwise have to guess
    /// at. Guessing is what turns a corrupt file into a plausible-looking match.
    public func validate() throws {
        guard version == Recording.currentVersion else {
            throw ReplayError.unsupportedVersion(version)
        }
        // An upper bound as well as a lower one: `1/tickHz` underflowing towards zero
        // would make playback run forever rather than fail.
        guard tickHz > 0, tickHz <= 1_000_000 else { throw ReplayError.badTickRate(tickHz) }
        guard durationTicks >= 0 else { throw ReplayError.badDuration(durationTicks) }
        guard field.teamSize >= 1, field.target >= 1 else {
            throw ReplayError.badField("teamSize \(field.teamSize), target \(field.target)")
        }
        guard field.length.isFinite, field.length > 0,
            field.width.isFinite, field.width > 0,
            field.endzoneDepth.isFinite, field.endzoneDepth >= 0
        else {
            throw ReplayError.badField(
                "\(field.length) x \(field.width), endzone \(field.endzoneDepth)")
        }
        for t in autoTeams where t != 0 && t != 1 { throw ReplayError.badTeam(t) }

        for (i, entry) in inputs.enumerated() {
            guard entry.tick >= 0 else { throw ReplayError.negativeTick(entry.tick) }
            switch entry.input {
            case .drag(let dx, let dy, let shortEdge):
                guard dx.isFinite, dy.isFinite, shortEdge.isFinite else {
                    throw ReplayError.nonFiniteInput(i)
                }
            case .release(let type, let ax, let ay, let az, let power, let loft):
                guard ThrowType(rawValue: type) != nil else { throw ReplayError.unknownThrow(type) }
                guard ax.isFinite, ay.isFinite, az.isFinite, power.isFinite, loft.isFinite else {
                    throw ReplayError.nonFiniteInput(i)
                }
            case .charged(let type, let ax, let ay, let az, let power, let loft, let quality):
                guard ThrowType(rawValue: type) != nil else { throw ReplayError.unknownThrow(type) }
                guard ax.isFinite, ay.isFinite, az.isFinite, power.isFinite, loft.isFinite,
                    quality.isFinite
                else {
                    throw ReplayError.nonFiniteInput(i)
                }
            case .defend:
                break
            }
        }
    }
}

public enum ReplayError: Error, Equatable, CustomStringConvertible {
    case unsupportedVersion(Int)
    case badTickRate(Int)
    case badDuration(Int)
    case badField(String)
    case badTeam(Int)
    case negativeTick(Int)
    case unknownThrow(String)
    case nonFiniteInput(Int)

    public var description: String {
        switch self {
        case .unsupportedVersion(let v):
            "recording is version \(v), this build replays version \(Recording.currentVersion)"
        case .badTickRate(let hz): "tick rate \(hz) is not a usable fixed step"
        case .badDuration(let n): "duration \(n) ticks is negative"
        case .badField(let detail): "field is not playable: \(detail)"
        case .badTeam(let t): "team \(t) does not exist"
        case .negativeTick(let t): "an input is stamped at tick \(t)"
        case .unknownThrow(let name): "no throw is called '\(name)'"
        case .nonFiniteInput(let i): "input \(i) carries a non-finite number"
        }
    }
}

// MARK: - the fixed clock

/// Turns however much wall clock has passed into whole simulation ticks.
///
/// The residue lives here, outside the match, and that is the entire point: the
/// simulation never sees a partial tick, so nothing it computes can depend on when the
/// display happened to call. The residue is a real number that differs between machines;
/// the tick count it produces is an integer, and integers replay.
public struct FixedClock: Equatable, Sendable {
    public let tickHz: Int
    /// The one and only step the match is ever advanced by.
    public let dt: Double
    /// Wall-clock seconds not yet spent on a tick. Never reaches the simulation.
    private var carry = 0.0

    public init(tickHz: Int) {
        self.tickHz = Swift.max(1, tickHz)
        self.dt = 1.0 / Double(Swift.max(1, tickHz))
    }

    /// How many ticks `seconds` of wall clock has earned, capped at `limit`.
    ///
    /// The cap defers ticks rather than dropping them — the carry is kept — so a frame
    /// that arrives late slows the game down instead of changing it. A non-finite or
    /// negative elapsed time is ignored rather than propagated; a clock that hiccups
    /// must not be able to poison a simulation that never reads a clock.
    public mutating func ticksDue(forRealTime seconds: Double, limit: Int) -> Int {
        guard seconds.isFinite, seconds > 0 else { return 0 }
        carry += seconds
        var due = 0
        while carry >= dt && due < limit {
            carry -= dt
            due += 1
        }
        return due
    }
}

// MARK: - applying an input

/// Applies one recorded input to a match.
///
/// Shared by the recorder and the player, because two copies of this is exactly how a
/// replay system starts lying. `Engine.humanRelease` refuses unless the controlled player
/// is actually holding the disc, so an input that arrives at an impossible moment is
/// dropped identically on both paths.
func applyReplayInput(_ input: ReplayInput, to match: Engine) {
    switch input {
    case .drag(let dx, let dy, let shortEdge):
        let gesture = ThrowGesture.interpret(dx: dx, dy: dy, shortEdge: shortEdge)
        // The human is always on team 0 — `Engine.controlled` is documented that way — so
        // the aim frame is team 0's attacking direction, exactly as the view computes it.
        let aim = ThrowGesture.aim(dx: dx, dy: dy, attackDir: match.attackDirection(of: 0))
        match.humanRelease(gesture.type, aim: aim, power: gesture.power, loft: gesture.loft)

    case .release(let type, let ax, let ay, let az, let power, let loft):
        // Validation resolved this already; a recording that reached here with a bad name
        // is one nobody validated, and dropping the throw beats trapping in a game.
        guard let throwType = ThrowType(rawValue: type) else { return }
        match.humanRelease(throwType, aim: Vec3d(ax, ay, az), power: power, loft: loft)

    case .charged(let type, let ax, let ay, let az, let power, let loft, let quality):
        guard let throwType = ThrowType(rawValue: type) else { return }
        match.humanRelease(
            throwType, aim: Vec3d(ax, ay, az), power: power, loft: loft, quality: quality)

    case .defend:
        // Refused taps are dropped identically on both paths — `humanDefend` returns nil
        // and touches nothing when there is nothing to commit to — so a recorded tap that
        // no longer applies costs the replay exactly what it cost the live match.
        match.humanDefend()
    }
}

// MARK: - building the match a recording describes

/// The engine a pitch and a seed name.
///
/// One function rather than two call sites, because the recorder and the player must
/// build *the same* match from the same numbers — an engine constructed even slightly
/// differently at playback would diverge on tick zero and the blame would land on the
/// simulation.
///
/// `target` is passed through rather than left to `Engine`'s own default. The two agree
/// for both shipped formats, but a recording stores its target, and a stored number the
/// replay path ignores is a lie in the file format rather than a redundancy.
public func engineForRecording(_ spec: FieldSpec, seed: UInt32) -> Engine {
    Engine(format: spec.gameFormat, target: spec.target, seed: seed)
}

// MARK: - recording

/// Plays a match and writes down what the human did.
///
/// This owns the loop rather than observing one. A recorder that watched a match somebody
/// else was stepping could not know what tick an input landed on, because it would not
/// know the step size — and the step size is the thing that has to be pinned.
public final class MatchRecorder {
    public let match: Engine
    /// Ticks executed so far. Also the stamp the next input receives.
    public private(set) var tickCount = 0

    private var clock: FixedClock
    private var inputs: [RecordedInput] = []
    private let seed: UInt32

    public init(
        field: FieldSpec = .minis,
        seed: UInt32 = 0x5eed_c0de,
        tickHz: Int = 120,
        autoTeams: Set<TeamId> = [1]
    ) {
        self.seed = seed
        self.clock = FixedClock(tickHz: tickHz)
        self.match = engineForRecording(field, seed: seed)
        self.match.autoTeams = autoTeams
    }

    /// The fixed step this recorder drives the match with.
    public var dt: Double { clock.dt }

    /// Note an input and apply it now.
    ///
    /// Stamped with `tickCount`, the tick that has not run yet, which is where the player
    /// will apply it. See the file comment on why applying now and applying then are the
    /// same transition.
    public func record(_ input: ReplayInput) {
        inputs.append(RecordedInput(tick: tickCount, input: input))
        applyReplayInput(input, to: match)
    }

    /// Advance exactly one fixed tick.
    public func tick() {
        match.step(dt: clock.dt)
        tickCount += 1
    }

    /// Advance by as many whole ticks as `realTime` seconds has earned.
    ///
    /// This is what a display-paced loop calls, and it is the only place wall-clock time
    /// enters the system. It returns the ticks run so a caller can tell it is falling
    /// behind rather than guessing from the frame rate.
    @discardableResult
    public func advance(realTime seconds: Double, maxTicks: Int = 32) -> Int {
        let due = clock.ticksDue(forRealTime: seconds, limit: maxTicks)
        for _ in 0..<due { tick() }
        return due
    }

    /// The recording as it stands. Safe to take at any moment.
    ///
    /// `durationTicks` covers the last input even if no tick has run since, so grabbing
    /// the tape immediately after a throw cannot silently discard it.
    public var recording: Recording {
        let lastInput = inputs.map(\.tick).max().map { $0 + 1 } ?? 0
        return Recording(
            seed: seed,
            field: RecordedField(match.fieldSpec),
            tickHz: clock.tickHz,
            autoTeams: match.autoTeams.sorted(),
            durationTicks: Swift.max(tickCount, lastInput),
            inputs: inputs)
    }
}

// MARK: - playback

/// Regenerates a match from a recording.
///
/// Playback is driven either tick by tick or by wall clock, and the two produce the same
/// states — that is the property `ReplayTests.invariantToFrameTiming` exists to falsify.
/// Wall clock affects only how quickly the ticks are handed over, never what they are.
public final class ReplayPlayer {
    public let recording: Recording
    public let match: Engine
    /// Ticks executed. Reaches exactly `recording.durationTicks` and stops.
    public private(set) var tick = 0

    private let script: [RecordedInput]
    private var cursor = 0
    private var clock: FixedClock

    /// - Throws: `ReplayError` if the recording could not produce a match. Nothing here
    ///   guesses at a missing or impossible value.
    public convenience init(_ recording: Recording) throws {
        try recording.validate()
        try self.init(recording, match: engineForRecording(recording.field.spec, seed: recording.seed))
    }

    /// Replay into an engine the caller built.
    ///
    /// `engineForRecording` builds an engine from `EngineConfig.default`, which is right
    /// for a fixture and wrong for a saved game: the shipped app builds its engine from a
    /// difficulty the player chose, and an assist cone that differs by a degree is a
    /// different match from the first throw. A recording does not store `EngineConfig` —
    /// it is thirty fields of pacing constants and storing them would make every recording
    /// a snapshot of the tuning it was made under — so the caller that knows how the match
    /// was built is the caller that rebuilds it. Handing the engine in is how the same
    /// playback path serves both.
    ///
    /// The engine must be freshly constructed and unstepped. Nothing here can check that,
    /// which is why this is the door the app uses and `init(_:)` stays the one a fixture
    /// uses.
    ///
    /// - Throws: `ReplayError` if the recording could not produce a match.
    public init(_ recording: Recording, match: Engine) throws {
        try recording.validate()
        self.recording = recording
        self.script = recording.ordered
        self.clock = FixedClock(tickHz: recording.tickHz)
        self.match = match
        self.match.autoTeams = Set(recording.autoTeams)
        // Inputs stamped before the first tick are consumed by tick 0, not dropped.
        // `validate` has already rejected negative stamps.
    }

    public var isFinished: Bool { tick >= recording.durationTicks }

    /// Run one tick: everything stamped for it, then the step.
    public func step() {
        guard !isFinished else { return }
        while cursor < script.count, script[cursor].tick <= tick {
            applyReplayInput(script[cursor].input, to: match)
            cursor += 1
        }
        match.step(dt: clock.dt)
        tick += 1
    }

    /// Advance by the ticks `realTime` seconds has earned, never past the end.
    @discardableResult
    public func advance(realTime seconds: Double, maxTicks: Int = 32) -> Int {
        let due = clock.ticksDue(forRealTime: seconds, limit: maxTicks)
        var ran = 0
        for _ in 0..<due where !isFinished {
            step()
            ran += 1
        }
        return ran
    }

    public func runToEnd() {
        while !isFinished { step() }
    }

    /// Replay a whole recording and hand back the match it produced.
    public static func play(_ recording: Recording) throws -> Engine {
        let player = try ReplayPlayer(recording)
        player.runToEnd()
        return player.match
    }
}

// MARK: - comparing two matches

/// Everything a replay has to reproduce, flattened so two matches can be compared
/// component by component.
///
/// Split into reals and discrete values because they are checked differently and the
/// difference matters. Reals are compared by **bit pattern**, never by `==`: `==` says a
/// negative zero equals a positive one and says a NaN equals nothing at all, so a
/// divergence into either would pass a naive comparison. Discrete state — score, phase,
/// who is holding — is exact by construction, and any difference at all is a bug.
///
/// The player rows are `Engine`'s `AIPlayer`s in roster order, which is the order they
/// were created in and never resorted. `energy` is in here with the positions rather than
/// treated as bookkeeping: it is the one player quantity that accumulates across the whole
/// match, so it is also the one that would expose a slow drift the positions recover from.
///
/// The disc is flattened from `DiscRuntime.state` — the integrated flight, which is what
/// the physics reads and writes. The runtime's other fields are deliberately left out:
/// `trail`, `wear` and `pendingScuff` exist for the renderer, and `mode`, `holderId` and
/// `lastThrowTeam` follow from `carrier` and the hold/release calls that are already
/// pinned here. Snapshotting a derived value adds a component that can only fail
/// alongside one already covered.
public struct MatchSnapshot: Sendable {
    public let teamSize: Int
    public let reals: [Double]
    public let discrete: [Int]

    public init(_ m: Engine) {
        teamSize = m.fieldSpec.teamSize

        var r: [Double] = []
        r.reserveCapacity(m.players.count * 7 + 21)
        for p in m.players {
            r.append(contentsOf: [
                p.pos.x, p.pos.y, p.pos.z,
                p.vel.x, p.vel.y, p.vel.z,
                p.energy,
            ])
        }
        let d = m.disc.state
        r.append(contentsOf: [
            d.pos.x, d.pos.y, d.pos.z,
            d.vel.x, d.vel.y, d.vel.z,
            d.orient.x, d.orient.y, d.orient.z, d.orient.w,
            d.omega.x, d.omega.y, d.omega.z,
            d.groundY, d.t, d.spin, d.alpha, d.airspeed,
        ])
        // `possessionTime` and `stall` are not the same number: `stall` reads zero while
        // the disc is in the air, and `possessionTime` keeps running. Both are recorded,
        // because a replay that diverged only in the flight clock would otherwise show up
        // several ticks later as a mystery.
        r.append(contentsOf: [m.possessionTime, m.stall, m.clock])
        reals = r

        var k: [Int] = []
        k.reserveCapacity(m.players.count * 3 + 19)
        for p in m.players { k.append(contentsOf: [p.id, p.team, p.airborne ? 1 : 0]) }
        k.append(contentsOf: [m.score[0], m.score[1]])
        let s = m.stats
        k.append(contentsOf: [
            s.throwsMade, s.completions, s.blocks, s.grounded, s.outOfBounds, s.stalled, s.goals,
        ])
        k.append(MatchSnapshot.phaseCode(m.phase))
        k.append(contentsOf: [
            m.possession, m.attackDir, m.controlled, m.carrier ?? -1, m.justScored ?? -1,
        ])
        k.append(contentsOf: [
            d.touchedGround ? 1 : 0, d.atRest ? 1 : 0, d.handed,
            d.throwType.flatMap { ThrowType.allCases.firstIndex(of: $0) } ?? -1,
        ])
        discrete = k
    }

    /// The phase as an integer.
    ///
    /// `GamePhase` is a `String` enum and its raw values would compare exactly, but the
    /// snapshot's discrete half is `[Int]` and one code per case keeps it that way. The
    /// interim engine's `PlayPhase` carried a payload — who was holding, who had thrown —
    /// and needed two integers; `GamePhase` describes the point rather than the disc, so
    /// the payload lives in `carrier` instead and is recorded separately.
    private static func phaseCode(_ phase: GamePhase) -> Int {
        switch phase {
        case .setup: 0
        case .pull: 1
        case .live: 2
        case .dead: 3
        }
    }

    /// Names for `reals`, in the same order. Built on demand, because a failure message
    /// is worth a string and a passing comparison is not.
    public static func realLabels(teamSize: Int) -> [String] {
        var l: [String] = []
        for i in 0..<(teamSize * 2) {
            for field in ["pos.x", "pos.y", "pos.z", "vel.x", "vel.y", "vel.z", "energy"] {
                l.append("player[\(i)].\(field)")
            }
        }
        l.append(contentsOf: [
            "disc.pos.x", "disc.pos.y", "disc.pos.z",
            "disc.vel.x", "disc.vel.y", "disc.vel.z",
            "disc.orient.x", "disc.orient.y", "disc.orient.z", "disc.orient.w",
            "disc.omega.x", "disc.omega.y", "disc.omega.z",
            "disc.groundY", "disc.t", "disc.spin", "disc.alpha", "disc.airspeed",
        ])
        l.append(contentsOf: ["possessionTime", "stall", "clock"])
        return l
    }

    /// Names for `discrete`, in the same order.
    public static func discreteLabels(teamSize: Int) -> [String] {
        var l: [String] = []
        for i in 0..<(teamSize * 2) {
            l.append(contentsOf: ["player[\(i)].id", "player[\(i)].team", "player[\(i)].airborne"])
        }
        l.append(contentsOf: ["score[0]", "score[1]"])
        l.append(contentsOf: [
            "stats.throwsMade", "stats.completions", "stats.blocks", "stats.grounded",
            "stats.outOfBounds", "stats.stalled", "stats.goals",
        ])
        l.append(contentsOf: [
            "phase", "possession", "attackDir", "controlled", "carrier", "justScored",
        ])
        l.append(contentsOf: [
            "disc.touchedGround", "disc.atRest", "disc.handed", "disc.throwType",
        ])
        return l
    }

    /// The first component that differs, named, or `nil` if the two are bit-identical.
    ///
    /// A replay failure is otherwise unreadable: two matches disagree somewhere in a
    /// hundred numbers and the report says `false`. Naming the component is the
    /// difference between "the replay broke" and "the disc's alpha broke".
    public func firstDifference(from other: MatchSnapshot) -> String? {
        if teamSize != other.teamSize {
            return "teamSize — got \(teamSize), want \(other.teamSize)"
        }
        if reals.count != other.reals.count {
            return "real component count — got \(reals.count), want \(other.reals.count)"
        }
        if discrete.count != other.discrete.count {
            return "discrete component count — got \(discrete.count), want \(other.discrete.count)"
        }
        for i in reals.indices where reals[i].bitPattern != other.reals[i].bitPattern {
            let name = MatchSnapshot.realLabels(teamSize: teamSize)[i]
            return "\(name) — got \(reals[i]), want \(other.reals[i])"
        }
        for i in discrete.indices where discrete[i] != other.discrete[i] {
            let name = MatchSnapshot.discreteLabels(teamSize: teamSize)[i]
            return "\(name) — got \(discrete[i]), want \(other.discrete[i])"
        }
        return nil
    }
}

extension MatchSnapshot: Equatable {
    /// Bit-exact equality.
    ///
    /// Written out rather than synthesised so that reals compare by bit pattern. The
    /// synthesised version would use `Double.==`, under which `-0 == 0` and `NaN != NaN`
    /// — the two ways a diverged replay could report itself identical.
    public static func == (a: MatchSnapshot, b: MatchSnapshot) -> Bool {
        a.firstDifference(from: b) == nil
    }
}

// MARK: - a match you can put down and pick up

/// What a build's simulation *does*, as one short string.
///
/// A saved game is a seed and a list of inputs, so restoring it means running the
/// simulation again — and a simulation that has been tuned since the save was written
/// will run it somewhere else. Every number in this repo is under active gameplay
/// tuning: a catch radius, a stall curve, an aggression scale, the aero table. Any of
/// them moves the third throw of a restored game a metre, and from there the restored
/// match is a *different* match wearing the old score. That is worse than losing the
/// save, because nothing on screen says it happened.
///
/// The honest defence is to notice. A hand-maintained version constant does not: it is a
/// number somebody has to remember to bump in the same commit that changed a coefficient,
/// and the commit that forgets is exactly the commit that needed it. So the stamp is
/// *measured* instead — a fixed-seed match is run for a fixed number of ticks and its
/// `MatchSnapshot` is hashed. Change anything the simulation reads and the hash changes
/// by itself; change nothing and it cannot change at all.
///
/// It is a fingerprint, not a checksum of the source: two builds agree exactly when they
/// produce the same numbers, which is the only property a replay cares about.
public enum SimFingerprint {
    /// How long the canary match runs. Two seconds of 3v3 with both sides on the machine,
    /// which is long enough to have moved twelve bodies through locomotion, run both
    /// `TeamAI`s several times, pulled, and put the disc in somebody's hands — i.e. long
    /// enough that most tuning lands in it — and short enough to run on the launch path.
    /// Measured in `MatchSaveTests`, and noted there, so a canary that gets slow is a
    /// number in the report rather than a hitch on somebody's phone.
    public static let canaryTicks = 240

    /// The one seed the canary is run at. Arbitrary, fixed forever, and *not* the engine's
    /// default: a fingerprint that shared a seed with the checks would go quiet the day
    /// somebody decided that particular match was the interesting one to special-case.
    static let canarySeed: UInt32 = 0x51_5a_9d_01

    /// The stamp for this build.
    ///
    /// `salt` folds in anything the *caller* contributes to how the engine was built — the
    /// difficulty mapping in the app's own setup, say — which the canary cannot see because
    /// the canary is deliberately a plain engine. A caller that passes nothing is stamping
    /// the simulation alone, which is a true statement about a smaller thing.
    public static func stamp(salt: String = "") -> String {
        let m = Engine(format: .minis, target: 7, seed: canarySeed)
        m.autoTeams = [0, 1]
        let dt = 1.0 / 120.0
        for _ in 0..<canaryTicks { m.step(dt: dt) }

        // FNV-1a over the bit patterns. Not a cryptographic hash and not trying to be:
        // this defends against drift, not against forgery, and the file it stamps is one
        // the player's own device wrote.
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        func mix(_ x: UInt64) {
            h = (h ^ x) &* 0x100_0000_01b3
        }
        let snap = MatchSnapshot(m)
        for r in snap.reals { mix(r.bitPattern) }
        for k in snap.discrete { mix(UInt64(bitPattern: Int64(k))) }
        for b in salt.utf8 { mix(UInt64(b)) }
        // The formats themselves are part of the promise: a recording that decodes into
        // different meaning is a divergence a re-run of the sim cannot show.
        mix(UInt64(Recording.currentVersion))
        mix(UInt64(SavedMatch.currentVersion))
        mix(UInt64(canaryTicks))
        return String(h, radix: 16)
    }
}

/// The handful of facts a restored match must still agree about.
///
/// Deliberately *not* a `MatchSnapshot`: that is 100 doubles and integers, it is the right
/// tool for asking whether a replay is bit-exact, and it is the wrong thing to write into
/// a save file — storing it would mean shipping a state dump beside the recording that
/// exists precisely so no state dump is needed. This is the small, discrete, load-bearing
/// half: the numbers a player would notice were wrong.
///
/// The fingerprint should already have caught a build whose simulation moved. This catches
/// what the fingerprint cannot: a save truncated mid-write, a recording edited by hand, a
/// change in the *app's* input path that the canary's plain engine never exercises. It is
/// the second lock, and its answer is always to discard.
public struct MatchChecksum: Codable, Equatable, Sendable {
    public var tick: Int
    public var score: [Int]
    public var phase: String
    public var possession: Int
    public var carrier: Int
    public var controlled: Int

    public init(_ m: Engine, tick: Int) {
        self.tick = tick
        self.score = [m.score[0], m.score[1]]
        self.phase = m.phase.rawValue
        self.possession = m.possession
        self.carrier = m.carrier ?? -1
        self.controlled = m.controlled
    }

    /// A one-line description, for the failure message that says why a save was thrown
    /// away. "It diverged" is not a bug report; "it diverged, and the score was 2-1 rather
    /// than 2-2" is.
    public var summary: String {
        "tick \(tick), \(score[0])-\(score[1]), \(phase), possession \(possession)"
    }
}

/// A match in progress, on disk.
///
/// A seed and a list of inputs — the same thing `Recording` has always been — plus the
/// three things a *save* needs and a fixture does not: a stamp of the simulation that
/// wrote it, a checksum of where it should end up, and an opaque blob of whatever the
/// caller needs to rebuild the engine.
///
/// `setup` is `Data` and stays `Data` all the way through this file. The sim does not know
/// what a difficulty setting is and should not learn: the layer that chose the engine's
/// configuration is the layer that can encode it, and every attempt to put it here ends
/// with `UltimateSim` importing a preference.
public struct SavedMatch: Codable, Equatable, Sendable {
    /// Bumped when the meaning of any field here changes. A save that does not understand
    /// itself is discarded, exactly like a recording from the future.
    public static let currentVersion = 1

    public var version: Int
    /// `SimFingerprint.stamp` as of the build that wrote this.
    public var fingerprint: String
    public var recording: Recording
    /// Where replaying `recording` in full must arrive.
    public var checksum: MatchChecksum
    /// The caller's own encoding of how the engine was built. Never interpreted here.
    public var setup: Data?
    /// When it was written. Shown to the player — "resume" is a different offer for a game
    /// abandoned four seconds ago and one abandoned in March — and read by nothing else.
    public var savedAt: Date

    public init(
        version: Int = SavedMatch.currentVersion,
        fingerprint: String,
        recording: Recording,
        checksum: MatchChecksum,
        setup: Data?,
        savedAt: Date = Date()
    ) {
        self.version = version
        self.fingerprint = fingerprint
        self.recording = recording
        self.checksum = checksum
        self.setup = setup
        self.savedAt = savedAt
    }

    /// Seconds of match this save covers. What a resume prompt should say, because "a
    /// recording of 41,000 ticks" is not a thing a player has any feeling about.
    public var seconds: Double { recording.seconds }
}

public enum RestoreError: Error, Equatable, CustomStringConvertible {
    /// Written by a build whose save format this one does not read.
    case unsupportedSave(Int)
    /// Written by a build whose simulation this one no longer reproduces.
    case staleSim(saved: String, current: String)
    /// Replayed to the end and arrived somewhere else. The save is discarded.
    case diverged(want: String, got: String)

    public var description: String {
        switch self {
        case .unsupportedSave(let v):
            "save is version \(v), this build reads version \(SavedMatch.currentVersion)"
        case .staleSim(let saved, let current):
            "save was written by simulation \(saved), this build is \(current)"
        case .diverged(let want, let got):
            "replay arrived at \(got) but the save says \(want)"
        }
    }
}

/// Replays a saved match back to where it was left, in pieces.
///
/// In pieces because a restore is not instant and is not allowed to look like a hang. A
/// point of 3v3 is a couple of thousand ticks and a full game to five is a couple of
/// hundred thousand; the fast path runs them far quicker than real time — that is the
/// whole point of a recording — but "far quicker than twenty minutes" is still long enough
/// to owe the player a progress bar. `advance(ticks:)` runs a bounded chunk and returns, so
/// the caller keeps its frame loop and can draw one.
///
/// The two checks sit at the two ends. The fingerprint is checked in `init`, before a
/// single tick is spent on a save that cannot possibly land; the checksum is checked in
/// `finish`, after the last one. **Neither ever repairs anything.** A save that fails
/// either is thrown away, because resuming into a match that quietly differs from the one
/// the player left is the failure this whole mechanism exists to avoid.
public final class MatchRestore {
    public let saved: SavedMatch
    private let player: ReplayPlayer

    /// - Parameters:
    ///   - engine: a freshly built, unstepped engine, configured the way the saved match
    ///     was. See `ReplayPlayer.init(_:match:)`.
    ///   - fingerprint: this build's `SimFingerprint.stamp`, with the same salt the save
    ///     was written with.
    /// - Throws: `RestoreError` for a save this build must not resume, `ReplayError` for
    ///   one that is not a recording at all.
    public init(_ saved: SavedMatch, fingerprint: String, engine: Engine) throws {
        guard saved.version == SavedMatch.currentVersion else {
            throw RestoreError.unsupportedSave(saved.version)
        }
        guard saved.fingerprint == fingerprint else {
            throw RestoreError.staleSim(saved: saved.fingerprint, current: fingerprint)
        }
        self.saved = saved
        self.player = try ReplayPlayer(saved.recording, match: engine)
    }

    /// The match being rebuilt. Not finished until `finish` has said so.
    public var match: Engine { player.match }
    public var tick: Int { player.tick }
    public var totalTicks: Int { saved.recording.durationTicks }
    public var isFinished: Bool { player.isFinished }
    /// 0…1, for a progress bar.
    public var progress: Double {
        totalTicks <= 0 ? 1 : Swift.min(1, Double(player.tick) / Double(totalTicks))
    }

    /// Replay at most `ticks` more ticks. Returns how many ran.
    @discardableResult
    public func advance(ticks: Int) -> Int {
        var ran = 0
        while ran < ticks && !player.isFinished {
            player.step()
            ran += 1
        }
        return ran
    }

    /// The restored match, if the replay landed where the save said it would.
    ///
    /// - Throws: `RestoreError.diverged`, and the caller's only correct response is to
    ///   discard the save.
    public func finish() throws -> Engine {
        let got = MatchChecksum(player.match, tick: player.tick)
        guard got == saved.checksum else {
            throw RestoreError.diverged(want: saved.checksum.summary, got: got.summary)
        }
        // The events of a whole match have been piling up in a buffer nobody drained. They
        // are real events that really happened — several minutes ago, to a player who was
        // not watching — and handing them to a renderer would open the restored match with
        // a burst of callouts and haptics for goals that are already on the scoreboard.
        _ = player.match.drainEvents()
        return player.match
    }

    /// Replay the lot in one go. For a check, or for a save short enough that chunking it
    /// would only be ceremony.
    public static func restore(
        _ saved: SavedMatch, fingerprint: String, engine: Engine
    ) throws -> Engine {
        let r = try MatchRestore(saved, fingerprint: fingerprint, engine: engine)
        r.advance(ticks: r.totalTicks)
        return try r.finish()
    }
}
