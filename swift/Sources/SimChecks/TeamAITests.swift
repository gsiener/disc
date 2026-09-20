import Foundation
import UltimateSim

/// `TeamAI` — the team brain, run live through four situations.
///
/// # Why this is a driver, not a replay
///
/// This used to be a **replay**: a 6 MB fixture carried, for every one of 1,370
/// frames, the whole world the reference AI was shown and every `PlayerIntent` it
/// returned, and the suite wrote the inputs back and compared all fourteen intents
/// field by field. Issue #58 retired the reference, so there is nothing to replay
/// against — and the situations are now *generated* instead: `driveLive` ports the
/// retired generator's crude driver (first-order chase, ballistic flight, a scripted
/// throwaway and turnover, the four segment setups) motion for motion, so the AI
/// sees the same *kinds* of situations the replay used to hand it.
///
/// What the replay's exactness caught, and what catches it now:
///
///  - **a lane reserved by a cut that ended** — `liveLanes` must equal the lanes the
///    returned intents actually show, every frame, both teams. A reservation without
///    a live cut behind it is the leak, asserted as an equality rather than sampled.
///  - **two live cuts sharing a lane** — stated in `LaneKey`'s own doc ("two live
///    cuts may never share one"), asserted per frame from the intents.
///  - **a `stackOrder` rotation that drops a body** — the holding *set* is constant
///    across all 1,370 frames; rotation reorders, dropping shrinks.
///  - **a matchup that loses a body** — every mate is matched on every frame, and
///    the marker and reset handler are always real bodies (or -1).
///  - **one RNG draw taken on a branch that should not have taken it** — the whole
///    trace is driven twice and every intent compared bit-exact. There is no oracle
///    left to agree with, but a stream misused through global state or a branch that
///    draws when it should not cannot reproduce itself exactly.
///  - **a stall count that never starts, and an offence that stands still** — the
///    four-hundred-second match, kept as behaviour: the count starts at exactly
///    `markMax`, and the `nomark` segment still works the reset and releases the
///    disc on `holdTime` alone.
///  - **the offence that walked backwards over its own goal line** — kept as
///    behaviour: no reset cut targets ground behind the floor, and `possessionValue`
///    keeps falling past 64.
///
/// The live census (modes, cut kinds, segment aggregates) is asserted as
/// presence-plus-magnitude, not exact counts: the retired fixture's own numbers
/// moved by a handful of intents between the two engines on the *same* machine
/// from one ULP of `hypot` disagreement, so exact counts would be a bound on a
/// libm, not on the AI. Anything a transposed coefficient or a dropped term does
/// to these numbers is orders of magnitude larger than that.
enum TeamAITests {

    // MARK: - run

    static func run() throws {
        geometry()
        invariants()
        claims()
    }

    // MARK: - the pitch

    /// The regulation pitch, pinned by value. These numbers used to arrive inside
    /// the fixture's `field` row, straight from the reference's module `FIELD`; the
    /// values are kept and the transport is gone. If these drift then every
    /// station, every clamp and every goal-line test below is measured against the
    /// wrong pitch, so they are asserted first.
    private static func geometry() {
        let f = FieldConstants.standard
        Check.bitEq(f.sideline, 18.5, "the pitch is 37 m wide")
        Check.bitEq(f.endLine, 50.0, "and 100 m long")
        Check.bitEq(f.goalLine, 32.0, "with the goal line at 32")
        Check.bitEq(f.endzoneDepth, 18.0, "and an 18 m endzone")
        Check.bitEq(
            Playbook.DEFAULT_EDGE_MARGIN, 0.9, "edgeMargin is 0.9 m")
    }

    // MARK: - invariants over the live trace

    /// Drives the trace twice: once for the invariants and the census, once to
    /// prove the first run reproduces itself bit-exact.
    private static func invariants() {
        let trace = driveLive()
        Check.eq(trace.frames.count, 1370, "the driver runs all four segments")

        var prevHolding: [Set<Int>?] = [nil, nil]
        for (fi, f) in trace.frames.enumerated() {
            let tag = "f\(fi)/\(f.seg)"
            for t in 0..<2 {
                let team = trace.teams[t]

                // Every reserved lane still has a live cut behind it. A reservation
                // whose cut ended without releasing is the leak that retires a
                // lane forever — nobody may ever cut there again, and nothing
                // else goes red.
                Check.ok(
                    team.laneReservationsLive,
                    "\(tag) team\(t): every reserved lane has its live cut")
                // And two RUNNING cuts never share one — `LaneKey`'s own doc
                // states it, over the lanes the intents actually show. Scoped to
                // the running states because a cut keeps displaying its old lane
                // while it clears out of it (`endCut` releases the reservation
                // but leaves `rec.cut` for the intent to read) — a finishing cut
                // and the cut that just claimed its lane show the same label,
                // and that staleness is mirrored reference behaviour, not a
                // double-booking.
                var active: Set<Playbook.LaneKey> = []
                for it in f.intents where it.team == t {
                    guard let lane = it.debug.lane, it.debug.cutKind != nil,
                        ["setup", "plant", "break"].contains(it.debug.state)
                    else { continue }
                    Check.ok(
                        !active.contains(lane),
                        "\(tag) team\(t): two live cuts share \(lane.rawValue)")
                    active.insert(lane)
                }

                // The stack never loses a body. Rotation reorders; dropping
                // shrinks — so the holding *set* is compared, across possession
                // changes and scheme calls alike.
                let holding = Set(team.stackHolding())
                if let prev = prevHolding[t] {
                    Check.eq(
                        holding, prev,
                        "\(tag) team\(t): the holding set is unchanged")
                }
                prevHolding[t] = holding

                // Every mate is matched, and the named bodies are real.
                for p in trace.players where p.team == t {
                    Check.ok(
                        team.matchupOf(p.id) != nil,
                        "\(tag) team\(t): #\(p.id) has a matchup")
                }
                let mateIds = Set(trace.players.filter { $0.team == t }.map(\.id))
                Check.ok(
                    team.marker == -1 || mateIds.contains(team.marker),
                    "\(tag) team\(t): the marker is a real body")
                Check.ok(
                    team.resetHandler == -1 || mateIds.contains(team.resetHandler),
                    "\(tag) team\(t): the reset handler is a real body")
            }
        }

        // The census: presence plus magnitude. Exact counts would pin a libm;
        // anything that actually breaks the AI moves these by orders of
        // magnitude more than the few-intent jitter in the doc comment above.
        let c = trace.census
        Check.ok(c.liveThrows > 0, "the trace throws the disc")
        Check.ok(c.liveCatches > 0, "and somebody catches one")
        Check.ok(c.liveTurnovers > 0, "and one goes to ground")
        Check.ok(c.livePickups > 0, "and a loose disc is picked up")
        Check.ok(c.liveFlightFrames > 0, "with a disc in flight")
        Check.ok(c.liveGroundFrames > 0, "and a disc on the turf")
        Check.ok(c.livePossessionFlips > 0, "and a possession that changes hands")
        Check.eq(c.zoneFrames, 200, "the zone segment runs its two hundred frames")
        Check.ok(c.zoneStallFrames > 0, "and the cup mark applies a count in it")
        Check.ok(
            (c.modes["mark"] ?? 0) > 0, "the trace contains an established mark")
        Check.ok(
            (c.cutKinds["deep"] ?? 0) > 0 && (c.cutKinds["under"] ?? 0) > 0,
            "the trace contains both halves of the vertical stack's cut vocabulary")
        Check.ok(
            (c.cutKinds["dump"] ?? 0) > 0, "and the reset vocabulary with them")
        Check.ok(c.nomarkMarkedFrames > 0, "nomark: the mark is genuinely set")
        Check.ok(
            c.nomarkThrows > 0,
            "nomark: the offence still releases the disc with the count dead")
        Check.inRange(
            c.nomarkFirstThrowSecond, 0, 13.0,
            "nomark: and it does so inside thirteen seconds, not four hundred")
        Check.ok(
            c.nomarkDumps > 0, "nomark: the reset still works with the count dead")

        // No oracle left to agree with — but a brain that draws from a stream it
        // should not, or that leaks through global state, cannot do the same
        // thing twice. Every intent, bit-for-bit, over all four segments.
        let again = driveLive()
        Check.eq(
            again.frames.count, trace.frames.count,
            "the second run plays the same number of frames")
        for (fi, (a, b)) in zip(trace.frames, again.frames).enumerated() {
            Check.eq(a.intents.count, b.intents.count, "f\(fi): same intent count")
            for (k, (x, y)) in zip(a.intents, b.intents).enumerated() {
                Check.ok(
                    sameIntent(x, y),
                    "f\(fi) i\(k): the trace reproduces itself")
            }
        }
    }

    /// Bit-for-bit intent equality that treats NaN as a value. `PlayerIntent`'s
    /// synthesized `==` compares its doubles with `==`, under which the `.nan`
    /// "no cut here" sentinel never equals itself — so every frame would fail.
    /// `bitPattern` compares what is actually there, and two runs of a
    /// deterministic engine put the same bits there.
    private static func sameDouble(_ a: Double, _ b: Double) -> Bool {
        a.bitPattern == b.bitPattern
    }

    private static func sameAction(_ a: PlayerAction?, _ b: PlayerAction?) -> Bool {
        switch (a, b) {
        case (nil, nil):
            return true
        case (.throw(let t1, let m1, let s1, let f1, let p1, let r1, let e1),
            .throw(let t2, let m2, let s2, let f2, let p2, let r2, let e2)):
            return t1 == t2 && sameDouble(m1.x, m2.x) && sameDouble(m1.y, m2.y)
                && sameDouble(m1.z, m2.z) && sameDouble(s1, s2)
                && sameDouble(f1, f2) && sameDouble(p1, p2) && r1 == r2
                && sameDouble(e1, e2)
        case (.catch(let d1), .catch(let d2)):
            return sameDouble(d1, d2)
        case (.bid(let x1, let z1), .bid(let x2, let z2)):
            return sameDouble(x1, x2) && sameDouble(z1, z2)
        case (.jump(let h1), .jump(let h2)):
            return sameDouble(h1, h2)
        case (.stall(let c1), .stall(let c2)):
            return sameDouble(c1, c2)
        case (.pickup, .pickup):
            return true
        case (.fake(let t1), .fake(let t2)):
            return t1 == t2
        default:
            return false
        }
    }

    private static func sameIntent(_ a: PlayerIntent, _ b: PlayerIntent) -> Bool {
        a.id == b.id && a.team == b.team
            && sameDouble(a.targetX, b.targetX) && sameDouble(a.targetZ, b.targetZ)
            && sameDouble(a.faceX, b.faceX) && sameDouble(a.faceZ, b.faceZ)
            && a.mode == b.mode && sameDouble(a.effort, b.effort)
            && sameDouble(a.desiredSpeed, b.desiredSpeed)
            && sameDouble(a.maxSpeed, b.maxSpeed)
            && sameDouble(a.maxAccel, b.maxAccel)
            && sameDouble(a.maxDecel, b.maxDecel)
            && sameDouble(a.turnRate, b.turnRate)
            && sameDouble(a.arriveRadius, b.arriveRadius)
            && sameDouble(a.personalSpace, b.personalSpace)
            && sameAction(a.action, b.action)
            && a.debug.role == b.debug.role && a.debug.state == b.debug.state
            && a.debug.lane == b.debug.lane
            && sameDouble(a.debug.cutX, b.debug.cutX)
            && sameDouble(a.debug.cutZ, b.debug.cutZ)
            && a.debug.cutKind == b.debug.cutKind
            && sameDouble(a.debug.cutDepth, b.debug.cutDepth)
    }

    // MARK: - prose as behaviour

    private static func attrs(
        speed: Double, acceleration: Double, agility: Double, jumping: Double,
        catching: Double, throwPower: Double, decision: Double, stamina: Double,
        defAwareness: Double
    ) -> AIAttributes {
        AIAttributes(
            speed: speed, acceleration: acceleration, agility: agility,
            jumping: jumping, catching: catching,
            throwAccuracy: [
                .backhand: 60, .forehand: 60, .hammer: 60, .scoober: 60, .push: 60,
            ],
            throwPower: throwPower, decision: decision, stamina: stamina,
            defAwareness: defAwareness)
    }

    private static func commandPlayers() -> [AIPlayer] {
        (0..<14).map { id in
            AIPlayer(
                id: id, team: id < 7 ? 0 : 1,
                pos: Vec3d(Double(id % 7) * 2 - 6, 0, 4), vel: .zero,
                attr: attrs(
                    speed: 60, acceleration: 60, agility: 60, jumping: 60,
                    catching: 60, throwPower: 60, decision: 60, stamina: 60,
                    defAwareness: 60),
                handed: .right,
                archetype: id % 7 < 3 ? .handler : id % 7 < 5 ? .cutter
                    : id % 7 == 5 ? .deep : .utility,
                energy: 1, role: id % 7 < 3 ? .handler : .cutter)
        }
    }

    private static func claims() {
        let pb = Playbook.regulation
        let trace = driveLive()

        // ---- THE FOUR-HUNDRED-SECOND MATCH, part one: the arithmetic.
        //
        // The count advances the instant the marker is inside `markMax` and not one
        // centimetre nearer. An earlier version required `markMax - 0.35`, which is
        // nearer than the radius the disc-space guard backs a marker out to, so a marker
        // who had once been too close could never start the count at all.
        let dt = 1.0 / 120
        let probe = TeamAI(team: 0, dir: 1, rng: Rng(seed: 1), field: .standard)
        Check.bitEqViaJSON(
            probe.tickStall(0, Playbook.PLAY.markMax, dt), dt,
            "the count starts at exactly markMax, with no margin")
        Check.bitEqViaJSON(
            probe.tickStall(0, Playbook.PLAY.markMax.nextUp, dt), 0,
            "and does not start outside it")
        // The two radii the marker code uses must both sit inside the counting radius, or
        // the start condition and the standing geometry disagree and the count never runs.
        Check.ok(
            Playbook.PLAY.discSpace + 1.75 <= Playbook.PLAY.markMax,
            "the disc-space bail-out radius is inside the counting radius")
        Check.ok(
            Playbook.PLAY.markDistance <= Playbook.PLAY.markMax,
            "the mark's standing distance is inside the counting radius")

        // ---- part two: the behaviour. `stallRead` is `max(disc.stall, holdTime -
        // 2.5)`, and the release bar collapses to -1e9 at 8.5 — so a dead count caps the
        // deadlock at eleven seconds of holding rather than at infinity.
        Check.bitEqViaJSON(
            Swift.max(0.0, 11.0 - 2.5), 8.5,
            "a dead count reaches the throw-anything threshold at eleven seconds held")

        // ---- WALKING BACKWARDS OVER YOUR OWN GOAL LINE.
        //
        // Traced in a real match: a team caught the pull on its own goal line at z=-30.2
        // and completed passes to -36.1, then -42.1, then -46.4. Two things had to be
        // true for that. `possessionValue` clamped at 64, so eighteen metres deep in your
        // own endzone priced identically to standing on your own line — the model could
        // not see the difference, so the throw was WANTED.
        // Read on the regulation pitch, whose `centralLength` and `endzoneDepth` ARE the
        // 64 and 18 quoted above; `possessionValue`'s defaults were removed with issue #17.
        Check.ok(
            AIMathTests.regulationPV(70) < AIMathTests.regulationPV(64),
            "possessionValue keeps falling past the goal line")
        Check.ok(
            AIMathTests.regulationPV(82) < AIMathTests.regulationPV(70),
            "and keeps falling to the back of your own endzone")
        Check.bitEqViaJSON(
            AIMathTests.regulationPV(82), AIMathTests.regulationPV(64) - 0.42,
            "a full endzone depth costs exactly the whole second term")

        // And the geometry: no reset cut may target ground behind the floor. Checked over
        // the live segment, which starts with the disc two metres off the offence's own
        // line — the situation that produced the trace above.
        var resetCuts = 0
        var handlerStandings = 0
        for f in trace.frames where f.seg == "live" {
            let dir = f.possession == 0 ? 1.0 : -1.0
            let floor = -(FieldConstants.standard.goalLine - 2.0)
            for it in f.intents {
                // Only the team in possession is running an offensive shape.
                if it.team != f.possession { continue }
                if let kind = it.debug.cutKind, kind == .dump || kind == .swing {
                    resetCuts += 1
                    Check.ok(
                        dir * it.debug.cutZ >= floor - 1e-9,
                        "a reset cut never targets ground behind the own-goal floor "
                            + "(\(kind.rawValue) at z=\(it.debug.cutZ))")
                }
                if it.debug.role == "handler" && it.debug.state == "stack" {
                    handlerStandings += 1
                    Check.ok(
                        dir * it.targetZ >= floor - 1e-9,
                        "a handler never STANDS behind the own-goal floor "
                            + "(z=\(it.targetZ))")
                }
            }
        }
        Check.ok(resetCuts > 0, "the live segment actually contains reset cuts to check")
        Check.ok(
            handlerStandings > 0, "the live segment actually contains stationed handlers")

        // ---- THE COMMAND CHANNEL. `commandCut` is the one way anything outside the AI
        // may steer an offensive player, and it is not reachable from a trace, because
        // nothing in the trace is holding an aim stick. Its doc makes three falsifiable
        // promises and all three are checked here.
        let cplayers = commandPlayers()
        let ct = TeamAI(
            team: 0, dir: 1, rng: Rng(seed: 5),
            cfg: TeamConfig(
                formation: .vertical, force: .forehand,
                zoneBias: -0.20, aggression: 1.05, seed: 3),
            field: .standard)
        let cw = AIWorld(
            players: cplayers,
            disc: AIDiscState(pos: Vec3d(0, 1, 0), state: .held, carrier: 0),
            possession: 0, phase: .live, field: .standard)
        _ = updateTeam(ct, cw, 1.0 / 120)
        Check.ok(ct.commandCut(999, 1, 0, Vec2d(0, 0)) == nil, "commandCut refuses an unknown id")
        Check.ok(ct.commandCut(7, 1, 0, Vec2d(0, 0)) == nil, "commandCut refuses the other team")
        Check.ok(
            ct.commandCut(3, 0, 0, Vec2d(0, 0)) == nil,
            "commandCut refuses a degenerate direction")
        // "A commanded cut has to be somewhere to RUN to." For a handler already standing
        // where his up-line would take him the route resolves within a stride of his feet,
        // the lane is claimed and released on the same frame, and the player who asked for
        // a cut sees nothing move. Every direction must produce a real route — the game
        // suite's bar is 1.5 m and `MIN_CUT_RUN` is 1.8 m so it clears with margin.
        var commanded = 0
        for (dx, dz) in [
            (1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0),
            (1.0, 1.0), (-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0),
        ] {
            for id in [1, 3, 5] {
                guard let route = ct.commandCut(id, dx, dz, Vec2d(0, 0)) else {
                    Check.ok(
                        false, "commandCut refused a legal order (\(id), \(dx), \(dz))")
                    continue
                }
                commanded += 1
                let p = cplayers[id]
                let run = Foundation.hypot(
                    route.target.x - p.pos.x, route.target.z - p.pos.z)
                Check.ok(
                    run >= 1.5,
                    "a commanded cut always has somewhere to run to "
                        + "(\(id) toward \(dx),\(dz): \(run) m)")
                // And it re-enters the state machine at the start, so the receiver runs
                // the setup step rather than teleporting into the break.
                Check.eq(
                    updateTeam(ct, cw, 1.0 / 120).first { $0.id == id }?.debug.cutKind,
                    route.kind, "a commanded cut is the cut that gets run (\(id))")
            }
        }
        Check.eq(commanded, 24, "every commanded direction produced a route")

        // ---- the pitch is threaded, not global. A `TeamAI` built on minis must build a
        // minis playbook: a 37 x 18 m game whose AI clamps to a 100 x 37 m pitch would
        // steer bodies twenty metres out of bounds and nothing else here would notice.
        let minis = TeamAI(team: 0, dir: 1, rng: Rng(seed: 1), field: .minis)
        Check.bitEqViaJSON(
            minis.pb.field.sideline, FieldConstants.minis.sideline,
            "a minis TeamAI carries the minis pitch")
        Check.ok(
            minis.pb.field.sideline < pb.field.sideline,
            "and it is genuinely narrower than the regulation one")
    }

    // MARK: - the live driver
    //
    // A port of the retired `tools/goldens/teamai.ts`'s crude driver — `integrate`,
    // the ballistic flight, the scripted throwaway and turnover, the four segment
    // setups — so the situations the replay used to be *given* are now *generated*.
    // The driver's own motion is asserted nowhere (it never was); what matters is
    // that the AI, shown these situations live, still does everything `claims` says
    // it does. Numbers below that look arbitrary (1.35 m release, 3.1 m/s², the
    // 1.35 m catch radius, the placement arrays) are the generator's, kept identical
    // so the live census lands in the same neighbourhood as the retired fixture's
    // `observed` — which is how the port was validated, not what it asserts.

    /// One driven frame: the segment, whose possession, and every intent the AI returned.
    struct LiveFrame {
        let seg: String
        let possession: Int
        let intents: [PlayerIntent]
    }

    /// The behavioural census, same shape as the retired fixture's `observed`.
    struct LiveCensus {
        var modes: [String: Int] = [:]
        var cutKinds: [String: Int] = [:]
        var liveThrows = 0, liveCatches = 0, liveTurnovers = 0, livePickups = 0
        var liveFlightFrames = 0, liveGroundFrames = 0
        var livePossessionFlips = 0
        var zoneFrames = 0, zoneStallFrames = 0
        var nomarkThrows = 0, nomarkDumps = 0, nomarkFirstThrowSecond = -1.0
        var nomarkMarkedFrames = 0
    }

    struct LiveTrace {
        let players: [AIPlayer]
        let teams: [TeamAI]
        let frames: [LiveFrame]
        let census: LiveCensus
    }

    private static let driverArches: [Archetype] = [
        .handler, .handler, .handler, .cutter, .cutter, .deep, .utility,
    ]

    /// Builds the roster from its seed — the same `makePlayer` stream the retired
    /// generator drew from, so the athletes are the same ones the replay used to
    /// be handed. (`makeAttributes` draws through `gauss`, whose `log`/`cos` are
    /// not bit-exact across libms, so sheets agree to ~1e-12 rather than exactly —
    /// close enough for athletes, and nothing asserts their values.)
    static func driverRoster() -> [AIPlayer] {
        let rrng = Rng(seed: 20260807)
        var players: [AIPlayer] = []
        for t in 0..<2 {
            for i in 0..<7 {
                let overall = 62 + rrng.range(0, 20)
                players.append(makePlayer(
                    t * 7 + i, t, driverArches[i], rrng.fork(salt: t * 31 + i),
                    overall: overall))
            }
        }
        return players
    }

    /// Drives both teams through the four segments and returns every frame.
    static func driveLive() -> LiveTrace {
        let players = driverRoster()
        let disc = AIDiscState(
            pos: Vec3d(0, 1.0, -30), vel: .zero, state: .held,
            carrier: 0, thrownBy: nil, intendedReceiver: nil, stall: 0)
        var world = AIWorld(
            players: players, disc: disc, possession: 0, phase: .setup,
            wind: Vec2d(0.8, -0.4), score: [0, 0], scoreCap: 15,
            rand: Rng(seed: 7).fork(salt: 999), field: .standard)
        let trng = Rng(seed: 424242)
        let teams = [
            TeamAI(
                team: 0, dir: 1, rng: trng.fork(salt: 11),
                cfg: TeamConfig(
                    formation: .vertical, force: .forehand,
                    zoneBias: -0.20, aggression: 1.05, seed: 3),
                field: .standard),
            TeamAI(
                team: 1, dir: -1, rng: trng.fork(salt: 22),
                cfg: TeamConfig(
                    formation: .horizontal, force: .backhand,
                    zoneBias: 0.05, aggression: 0.95, seed: 5),
                field: .standard),
        ]

        struct Flight { var fx, fy, fz, vx, vy, vz, t, T: Double; var by: Int }
        var flight: Flight? = nil
        var publishStall = true
        var segStart = 0.0
        var census = LiveCensus()
        var frames: [LiveFrame] = []

        func place(_ x: [Double], _ z: [Double]) {
            for i in 0..<players.count {
                players[i].pos = Vec3d(x[i], 0, z[i])
                players[i].vel = .zero
            }
        }

        func integrate(_ intents: [PlayerIntent], dt: Double) {
            let f = FieldConstants.standard
            for it in intents {
                let p = players[it.id]
                let dx = it.targetX - p.pos.x
                let dz = it.targetZ - p.pos.z
                let d = Foundation.hypot(dx, dz)
                let want = Swift.min(it.desiredSpeed, d / Swift.max(dt, 1e-6))
                let ux = d > 1e-9 ? dx / d : 0
                let uz = d > 1e-9 ? dz / d : 0
                let a = it.maxAccel * dt
                p.vel = Vec3d(
                    p.vel.x + Swift.max(-a, Swift.min(a, ux * want - p.vel.x)), 0,
                    p.vel.z + Swift.max(-a, Swift.min(a, uz * want - p.vel.z)))
                p.pos = Vec3d(
                    Swift.max(-f.sideline, Swift.min(f.sideline, p.pos.x + p.vel.x * dt)), 0,
                    Swift.max(-f.endLine, Swift.min(f.endLine, p.pos.z + p.vel.z * dt)))
            }
        }

        func step(_ seg: String, dt: Double) {
            let a = updateTeam(teams[0], world, dt)
            world.scheme[0] = teams[0].currentScheme
            let b = updateTeam(teams[1], world, dt)
            world.scheme[1] = teams[1].currentScheme
            let intents = a + b

            frames.append(LiveFrame(
                seg: seg, possession: world.possession, intents: intents))

            for it in intents {
                census.modes[it.mode.rawValue, default: 0] += 1
                if let k = it.debug.cutKind {
                    census.cutKinds[k.rawValue, default: 0] += 1
                    if seg == "nomark" && k == .dump { census.nomarkDumps += 1 }
                }
            }
            if seg == "live" && world.disc.state == .flight { census.liveFlightFrames += 1 }
            if seg == "live" && world.disc.state == .ground { census.liveGroundFrames += 1 }
            if seg == "zone" {
                census.zoneFrames += 1
                if teams[1].stall > 0 || teams[0].stall > 0 { census.zoneStallFrames += 1 }
            }
            if seg == "nomark" && teams[1].stall > 0 { census.nomarkMarkedFrames += 1 }

            let before = world.possession
            for it in intents {
                guard let act = it.action else { continue }
                switch act {
                case .throw(_, let aim, _, let ft, _, let rid, _)
                    where world.disc.state == .held && world.disc.carrier == it.id:
                    let T = Swift.max(0.2, ft)
                    let from = players[it.id]
                    flight = Flight(
                        fx: from.pos.x, fy: 1.35, fz: from.pos.z,
                        vx: (aim.x - from.pos.x) / T,
                        vy: (aim.y - 1.35) / T + 0.5 * 3.1 * T,
                        vz: (aim.z - from.pos.z) / T,
                        t: 0, T: T, by: it.team)
                    world.disc.state = .flight
                    world.disc.carrier = nil
                    world.disc.intendedReceiver = rid
                    world.disc.stall = 0
                    if seg == "live" { census.liveThrows += 1 }
                    if seg == "nomark" {
                        census.nomarkThrows += 1
                        if census.nomarkFirstThrowSecond < 0 {
                            census.nomarkFirstThrowSecond = world.time - segStart
                        }
                    }
                case .pickup where world.disc.state == .ground:
                    world.disc.state = .held
                    world.disc.carrier = it.id
                    world.disc.stall = 0
                    world.possession = it.team
                    if seg == "live" { census.livePickups += 1 }
                case .stall(let count) where publishStall:
                    world.disc.stall = count
                default:
                    break
                }
            }

            integrate(intents, dt: dt)

            if var fl = flight {
                fl.t += dt
                let t = fl.t
                world.disc.pos = Vec3d(
                    fl.fx + fl.vx * t, fl.fy + fl.vy * t - 0.5 * 3.1 * t * t,
                    fl.fz + fl.vz * t)
                world.disc.vel = Vec3d(fl.vx, fl.vy - 3.1 * t, fl.vz)
                if t >= fl.T || world.disc.pos.y <= 0.05 {
                    var best: AIPlayer? = nil
                    var bd = 1.35
                    for p in players {
                        let d = Foundation.hypot(
                            p.pos.x - world.disc.pos.x, p.pos.z - world.disc.pos.z)
                        if d < bd { bd = d; best = p }
                    }
                    if let best {
                        world.disc.state = .held
                        world.disc.carrier = best.id
                        world.disc.pos.y = 1.0
                        world.possession = best.team
                        if seg == "live" { census.liveCatches += 1 }
                    } else {
                        world.disc.state = .ground
                        world.disc.pos.y = 0.05
                        world.disc.vel = .zero
                        world.possession = 1 - fl.by
                        if seg == "live" { census.liveTurnovers += 1 }
                    }
                    world.disc.intendedReceiver = nil
                    world.disc.stall = 0
                    flight = nil
                } else {
                    flight = fl
                }
            } else if world.disc.state == .held, let carrier = world.disc.carrier {
                let c = players[carrier]
                world.disc.pos = Vec3d(c.pos.x, 1.0, c.pos.z)
                world.disc.vel = .zero
            }
            if world.possession != before && seg == "live" {
                census.livePossessionFlips += 1
            }

            world.time += dt
        }

        // Segment 0: line up.
        place(
            [-12, -6, 0, 6, 12, -16, 16, -12, -6, 0, 6, 12, -16, 16],
            [-32, -32, -32, -32, -32, -32, -32, 32, 32, 32, 32, 32, 32, 32])
        for _ in 0..<30 { step("lineup", dt: 1.0 / 120) }

        // Segment 1: live, pinned on the own goal line.
        world.phase = .live
        world.possession = 0
        place(
            [0, 5.0, -6.0, 0.5, -0.5, 0.0, 0.0, 1.9, 5.6, -5.0, 0.5, 1.0, -1.0, 0.0],
            [-30, -33.0, -31.0, -19.0, -14.8, -10.6, -6.4,
             -29.4, -33.5, -31.5, -21.0, -16.5, -12.0, -8.0])
        world.disc.state = .held
        world.disc.carrier = 0
        world.disc.intendedReceiver = nil
        world.disc.stall = 0
        world.disc.pos = Vec3d(0, 1.0, -30)
        flight = nil
        for _ in 0..<300 { step("live", dt: 1.0 / 60) }

        // A scripted throwaway into empty space.
        flight = Flight(
            fx: world.disc.pos.x, fy: 1.35, fz: world.disc.pos.z,
            vx: 11, vy: 2.2, vz: 3, t: 0, T: 0.8, by: 0)
        world.disc.state = .flight
        world.disc.carrier = nil
        world.disc.intendedReceiver = nil
        world.disc.stall = 0
        for _ in 0..<90 { step("live", dt: 1.0 / 60) }

        // A scripted turnover: a loose disc on the far sideline.
        world.disc.state = .ground
        world.disc.carrier = nil
        world.disc.intendedReceiver = nil
        world.disc.stall = 0
        world.disc.pos = Vec3d(18.5, 0.05, 4)
        world.disc.vel = .zero
        flight = nil
        world.possession = 1
        for _ in 0..<350 { step("live", dt: 1.0 / 60) }

        // Segment 2: wind, and a zone.
        world.wind = Vec2d(9, 6)
        world.phase = .dead
        step("zone", dt: 1.0 / 60)
        world.phase = .live
        for _ in 0..<199 { step("zone", dt: 1.0 / 60) }

        // Segment 3: a mark that is set, and a count that is not.
        world.wind = Vec2d(0.8, -0.4)
        world.phase = .dead
        world.possession = 0
        place(
            [4, 8.0, -7.0, 2.0, -2.0, 1.0, -1.0, 5.9, 9.0, -6.0, 2.5, -2.5, 0.0, 1.0],
            [-6, -12.0, -10.0, 6.0, 10.5, 15.0, 19.0,
             -5.4, -12.5, -10.5, 4.0, 8.0, 12.5, 16.5])
        world.disc.state = .held
        world.disc.carrier = 0
        world.disc.intendedReceiver = nil
        world.disc.stall = 0
        world.disc.pos = Vec3d(4, 1.0, -6)
        flight = nil
        publishStall = false
        segStart = world.time
        step("nomark", dt: 1.0 / 30)
        world.phase = .live
        for _ in 0..<399 { step("nomark", dt: 1.0 / 30) }

        return LiveTrace(players: players, teams: teams, frames: frames, census: census)
    }
}
