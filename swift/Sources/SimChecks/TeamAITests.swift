import Foundation
import UltimateSim

/// `TeamAI` against `src/sim/AI.ts` lines 653-3069.
///
/// This is a **replay**, not a table. The fixture carries, for every one of 1,280 frames,
/// the whole world the reference AI was shown — every player's position, velocity and
/// energy, the disc, the phase, the possession, the wind — and every `PlayerIntent` it
/// returned. The suite writes the inputs back, steps both teams, and compares all fourteen
/// intents field by field. Nothing about the crude driver that produced the motion is
/// reproduced or asserted; only the AI's answer to a known question is.
///
/// The inputs have to be replayed rather than re-derived because the interesting state is
/// not in them. A `TeamAI` carries a possession epoch, a formation hold timer, a five-state
/// cut machine per player with lanes reserved against a shared map, a stack-slot deal with
/// 0.35 s of hysteresis, a lagged perception of every matchup, a stall clock, an 8 Hz
/// decision tick, a windup and a private RNG stream. A single-frame fixture sees none of
/// it. The failures this catches are all late ones: a lane never released, a matchup map
/// iterated in a different order, a `stackOrder` rotation that drops a body, one RNG draw
/// taken on a branch that should not have taken it.
///
/// ------------------------------------------------------------------------ strictness
///
/// **This suite cannot be bit-exact and says so up front.** `Playbook.dist2` is
/// `Math.hypot`, which IEEE 754 does not require to be correctly rounded and on which V8's
/// compensated implementation and Darwin's libm differ by an ulp; `dist2` appears in
/// nearly every expression in `AI.ts`, from the nearest-defender scan to the cut score to
/// the stall geometry. `atan2`, `acos`, `cos`, `sin`, `exp` (through `sigmoid`) and `pow`
/// are all in here as well. So continuous quantities get an **ulp-relative** envelope,
/// stated as ulps rather than an absolute because the values here span from 0 to 50 m, and
/// the share of comparisons that land bit-identical is reported so a slow slide from
/// "identical" to merely "close" is visible before it is a failure.
///
/// Everything discrete is exact and that is where the real assertions live: `mode`, the
/// action kind, `role`, `state`, `lane`, `cutKind`, `cutDepth`, the scheme, the formation,
/// the open sign, the marker id, the reset id, who is holding the stack, the whole matchup
/// table and every zone assignment. A tolerance can hide a slightly different target. It
/// cannot hide a cut that never ended, a mark handed to the wrong body, or a stack that
/// quietly lost a player.
///
/// -------------------------------------------------------------------------- the claims
///
/// `claims()` asserts the module's prose as behaviour. Two of those doc comments cite
/// measured failures and both are checked here rather than trusted:
///
///  - **the four-hundred-second match.** A count that never starts freezes an offence
///    whose only source of urgency is the opposition's number. The fix has two halves and
///    both are asserted: `tickStall` starts the count at exactly `markMax` with no margin,
///    and the radius the disc-space guard backs a marker out to is *inside* that — the
///    start condition and the standing geometry are not allowed to disagree. Then the
///    behaviour: a whole segment of the trace runs with the published count pinned at
///    zero, and the offence must still work its reset and still release the disc.
///
///  - **the offence that walked backwards over its own goal line** (traced at -30.2,
///    -36.1, -42.1, -46.4). The live segment starts with the disc two metres off the
///    offence's own line, and no reset cut in it may target ground behind the floor.
///    `possessionValue` must also keep falling past 64, which is what stops the throw
///    being *wanted* rather than merely offered.
enum TeamAITests {

    // MARK: - fixture shapes

    struct Sheet: Decodable {
        let speed: Double
        let acceleration: Double
        let agility: Double
        let jumping: Double
        let catching: Double
        let throwAccuracy: [String: Double]
        let throwPower: Double
        let decision: Double
        let stamina: Double
        let defAwareness: Double
    }

    struct RosterRow: Decodable {
        let id: Int
        let team: Int
        let archetype: String
        let handed: String
        let role: String
        let energy: Double
        let attr: Sheet
    }

    struct CfgRow: Decodable {
        let formation: String
        let force: String
        let aggression: Double
        let zoneBias: Double
        let seed: Int
    }

    struct FieldRow: Decodable {
        let halfWidth: Double
        let halfLength: Double
        let goalLine: Double
        let endzoneDepth: Double
        let edgeMargin: Double
    }

    struct Observed: Decodable {
        let livePickups: Int
        let liveFlightFrames: Int
        let liveGroundFrames: Int
        let livePossessionFlips: Int
        let zoneFrames: Int
        let zoneStallFrames: Int
        let nomarkThrows: Int
        let nomarkDumps: Int
        let nomarkFirstThrowSecond: Double
        let nomarkMarkedFrames: Int
        let cutKinds: [String: Int]
        let modes: [String: Int]
    }

    /// One frame. The four packed-string arrays are documented in `tools/goldens/teamai.ts`;
    /// they exist because the generator writes with a two-space pretty-printer that puts
    /// every scalar on its own line, and the object form of this trace was 17.9 MB.
    struct Frame: Decodable {
        let seg: String
        let dt: Double
        let time: Double
        let phase: String
        let possession: Int
        let wx: Double
        let wz: Double
        let disc: DiscRow
        let pl: [PlayerRow]
        /// Energy after both updates — see the generator. This is the one input the AI
        /// itself changes during the frame, and recording it is what makes the
        /// `tickStamina` knife-edge visible instead of hidden.
        let pe: [String]
        let it: [IntentRow]
        let ts: [TeamRow]
    }

    struct File: Decodable {
        let note: String
        let teamSeed: UInt32
        let forkSalts: [Int]
        let cfg: [CfgRow]
        let dirs: [Int]
        let score: [Int]
        let scoreCap: Int
        let field: FieldRow
        let roster: [RosterRow]
        let observed: Observed
        let frames: [Frame]
    }

    // MARK: - tolerance

    /// Absolute tolerance for every continuous quantity in the trace.
    ///
    /// The number is MEASURED, not guessed — see the note the suite prints. It was 1e-9
    /// for most of this suite's life, six hundred times the then-worst deviation of
    /// 1.6e-12. The deep-shot valuation moved the worst case: a huck's completion reads
    /// `separation` through a LINEAR term where the old chain read it through a
    /// saturated sigmoid, and `separation` carries `timeToReach`'s `acos(dot)` — whose
    /// derivative is infinite at dot = 1, turning an ulp of cross-libm `hypot`
    /// disagreement into a square-root of an ulp (~1e-6) of turn time. Measured worst
    /// after that change: 1.8e-9 on a throw's expected completion, same option, same
    /// receiver, same aim to 1e-9. That is drift the old landscape masked, not a logic
    /// difference, so the bar moves with the measurement: 1e-7 keeps fifty times the
    /// observed worst in headroom while sitting four orders of magnitude below the
    /// parts-in-a-thousand a transposed coefficient or dropped term produces.
    ///
    /// It is absolute rather than ulp-relative on purpose, and the reason is
    /// cancellation. `effort` in the person defence is `clamp(0.35 + gap * 0.45, ...)`
    /// where `gap` is the distance between the defender and a target twenty metres away;
    /// an ulp of disagreement in the target — the target the suite then compares and
    /// finds equal, because `clampToField` has pinned it to the sideline — becomes a
    /// thousand ulps of `gap`, which is a subtraction of two large nearby numbers. Ulps
    /// of the *result* are not a meaningful unit for that. Metres are: 1e-7 m on a
    /// hundred-metre pitch is far below anything that could hide a logic difference, and
    /// every discrete consequence of these numbers — the mode, the action, the lane, the
    /// cut kind, the matchup — is asserted exactly regardless.
    private static let traceTol = 1e-7

    /// A bit-exactness census over the tolerance comparisons, matching `LocomotionTests`.
    /// The tolerance is the honest bar for a trace this deep, but it would also hide a
    /// slow slide from "identical" to "close", so the share that is bit-identical is
    /// counted and reported.
    nonisolated(unsafe) static var approxTotal = 0
    nonisolated(unsafe) static var approxExact = 0

    /// Stop comparing once the port is clearly wrong. Without this a structural
    /// divergence on frame 3 produces a quarter of a million failure strings.
    private static let FAIL_BUDGET = 40
    nonisolated(unsafe) static var failed = 0

    /// Frames on which a player's energy came out one `tickStamina` different.
    ///
    /// **This is conditioning, not a porting bug, and the suite proves it rather than
    /// assuming it.** `tickStamina` drains above `load > 0.42` and recovers below it,
    /// and `load` is `hypot(vel.x, vel.z) / effectiveMaxSpeed`. `hypot` is not correctly
    /// rounded and V8's compensated version and Darwin's libm land on opposite sides of
    /// that threshold on the handful of frames where a player happens to be running at
    /// exactly 42% of top speed. One tick is ~3e-4 of energy, which is ~5e-4 m/s of top
    /// speed — five thousand times the tolerance, so it cannot be absorbed. Instead the
    /// energy is compared explicitly, the disagreement is COUNTED, and that player's
    /// intents are skipped for that frame only. Energy is re-seeded from the fixture on
    /// the next frame, so it never accumulates.
    ///
    /// The count is asserted to stay small. If a real porting bug ever moved energy, this
    /// number would jump from tens to tens of thousands and the assertion below fails —
    /// which is the whole point of counting rather than tolerating.
    nonisolated(unsafe) static var staminaFlips = 0
    nonisolated(unsafe) static var staminaChecks = 0

    /// Defender intents where mode/action disagreed in exactly the shape the declared
    /// `LAYOUT_CEILING` divergence predicts (see `compareIntent`) — a bid attempt with
    /// `land.y` in [1.10, 1.85), where the reference bids and Swift, correctly per its own
    /// declared constant, does not. Counted rather than silently excused, for the same
    /// reason `staminaFlips` is: a real regression elsewhere would move this from a
    /// handful to thousands, and the assertion in `run()` is what would catch that.
    nonisolated(unsafe) static var layoutCeilingFlips = 0

    private static func approx(_ got: Double, _ want: Double, _ what: @autoclosure () -> String) {
        approxTotal += 1
        if got.bitPattern == want.bitPattern { approxExact += 1 }
        if got.isNaN || want.isNaN {
            // NaN is the reference's "no cut here", so it is a value and not an error.
            record(got.isNaN && want.isNaN, "\(what()): NaN mismatch (got \(got), want \(want))")
            return
        }
        let d = abs(got - want)
        record(d <= traceTol, "\(what()): off by \(d) (got \(got), want \(want))")
    }

    private static func exact<T: Equatable>(
        _ got: T, _ want: T, _ what: @autoclosure () -> String
    ) {
        record(got == want, "\(what()) — got \(got), want \(want)")
    }

    private static func record(_ ok: Bool, _ label: @autoclosure () -> String) {
        if ok {
            Check.ok(true, "")
        } else {
            failed += 1
            Check.ok(false, label())
        }
    }

    // MARK: - packed-row parsing
    //
    // ISSUE #19. `tools/goldens/teamai.ts` packs each row into a `|`-delimited string
    // (17.9 MB pretty-printed as plain objects; under 5 MB packed) and every row shape
    // used to be re-split and re-indexed at every call site that read one — `w[13]`,
    // `w[15]`, `w[17]`, both here and duplicated again in `claims()`. A field inserted
    // on the TypeScript side shifted every comparison after it, silently, because most
    // of them are geometric doubles compared inside a tolerance: some of those shifts
    // still passed. The four structs below are the one place that field order is
    // knowledge now. They decode the identical wire string — nothing about
    // `tools/goldens/teamai.ts` or the fixture's byte size changes — but every other
    // line in this file reads a name, not a position.

    private static func parts(_ s: String) -> [Substring] {
        s.split(separator: "|", omittingEmptySubsequences: false)
    }

    /// `Double(String)` is correctly rounded and `String(v)` in JavaScript emits the
    /// shortest representation that round-trips, so the wire form loses nothing. "nan" is
    /// the one spelling the pretty-printer could not carry as a number.
    private static func dbl(_ s: Substring) -> Double { Double(s) ?? Double.nan }
    private static func optInt(_ s: Substring) -> Int? { s.isEmpty ? nil : Int(s) }
    private static func optStr(_ s: Substring) -> String? { s.isEmpty ? nil : String(s) }

    /// `x|z|vx|vz|energy` — `tools/goldens/teamai.ts:playerRow`.
    struct PlayerRow: Decodable {
        let x, z, vx, vz, energy: Double
        init(from decoder: Decoder) throws {
            let w = parts(try decoder.singleValueContainer().decode(String.self))
            x = dbl(w[0]); z = dbl(w[1]); vx = dbl(w[2]); vz = dbl(w[3]); energy = dbl(w[4])
        }
    }

    /// `x|y|z|vx|vy|vz|state|carrier|intendedReceiver|stall` — `...teamai.ts:discRow`.
    struct DiscRow: Decodable {
        let x, y, z, vx, vy, vz: Double
        let state: String
        let carrier: Int?
        let intendedReceiver: Int?
        let stall: Double
        init(from decoder: Decoder) throws {
            let w = parts(try decoder.singleValueContainer().decode(String.self))
            x = dbl(w[0]); y = dbl(w[1]); z = dbl(w[2])
            vx = dbl(w[3]); vy = dbl(w[4]); vz = dbl(w[5])
            state = String(w[6])
            carrier = optInt(w[7]); intendedReceiver = optInt(w[8])
            stall = dbl(w[9])
        }
    }

    /// `id|targetX|targetZ|faceX|faceZ|mode|effort|desiredSpeed|maxSpeed|arriveRadius`
    /// `|role|state|lane|cutX|cutZ|cutKind|cutDepth|action` — `...teamai.ts:intentRow`.
    /// `action` is itself `,`-delimited (`compareAction` owns that shape: it is a
    /// discriminated union whose field count varies by kind, which is a different
    /// problem than a fixed row read by position).
    struct IntentRow: Decodable {
        let id: Int
        let targetX, targetZ, faceX, faceZ: Double
        let mode: String
        let effort, desiredSpeed, maxSpeed, arriveRadius: Double
        let role, state: String
        let lane: String?
        let cutX, cutZ: Double
        let cutKind: String?
        let cutDepth: Double
        let action: String
        init(from decoder: Decoder) throws {
            let w = parts(try decoder.singleValueContainer().decode(String.self))
            id = Int(w[0])!
            targetX = dbl(w[1]); targetZ = dbl(w[2]); faceX = dbl(w[3]); faceZ = dbl(w[4])
            mode = String(w[5])
            effort = dbl(w[6]); desiredSpeed = dbl(w[7]); maxSpeed = dbl(w[8])
            arriveRadius = dbl(w[9])
            role = String(w[10]); state = String(w[11])
            lane = optStr(w[12])
            cutX = dbl(w[13]); cutZ = dbl(w[14])
            cutKind = optStr(w[15])
            cutDepth = dbl(w[16])
            action = String(w[17])
        }
    }

    /// `stall|scheme|formation|openSign|stackAxisX|marker|resetHandler|openSideOnD`
    /// `|force|holding,csv|matchup,csv|zoneRole,csv` — `...teamai.ts:teamRow`.
    struct TeamRow: Decodable {
        let stall: Double
        let scheme, formation: String
        let openSign: Int
        let stackAxisX: Double
        let marker, resetHandler: Int
        let openSideOnD: Int?
        let force: String
        let holding, matchup, zoneRole: String
        init(from decoder: Decoder) throws {
            let w = parts(try decoder.singleValueContainer().decode(String.self))
            stall = dbl(w[0])
            scheme = String(w[1]); formation = String(w[2])
            openSign = Int(w[3])!
            stackAxisX = dbl(w[4])
            marker = Int(w[5])!; resetHandler = Int(w[6])!
            openSideOnD = optInt(w[7])
            force = String(w[8])
            holding = String(w[9]); matchup = String(w[10]); zoneRole = String(w[11])
        }
    }

    // MARK: - run

    static func run() throws {
        let g = try Goldens.load(File.self, "teamai")
        approxTotal = 0
        approxExact = 0
        failed = 0
        staminaFlips = 0
        staminaChecks = 0
        layoutCeilingFlips = 0

        geometry(g)
        replay(g)
        claims(g)

        // The bit-exactness census has no pass/fail direction of its own — an envelope
        // assertion tolerates small differences by design — so it is printed rather than
        // asserted.
        print(
            "  · teamai: \(g.frames.count) frames tested"
                + " — \(approxExact) of \(approxTotal) tolerance comparisons were bit-identical")
        // A handful is conditioning. Thousands would be a port that computes energy
        // differently, and that must not be excusable by the same mechanism.
        Check.ok(
            staminaFlips * 200 < staminaChecks,
            "tickStamina load-branch flips stay under 0.5% of player-frames "
                + "(\(staminaFlips)/\(staminaChecks))")
        // A handful is the declared LAYOUT_CEILING gap being crossed by coincidence.
        // Hundreds would be a real regression hiding behind it.
        Check.ok(
            layoutCeilingFlips < 20,
            "LAYOUT_CEILING bid-height disagreements stay rare (\(layoutCeilingFlips))")
    }

    // MARK: - the pitch

    /// The reference's module `FIELD` against the threaded `FieldConstants`. If these
    /// have drifted then every station, every clamp and every goal-line test in the
    /// replay below is measured against the wrong pitch, so it is asserted first.
    private static func geometry(_ g: File) {
        let f = FieldConstants.standard
        Check.bitEqViaJSON(f.sideline, g.field.halfWidth, "FIELD.halfWidth = sideline")
        Check.bitEqViaJSON(f.endLine, g.field.halfLength, "FIELD.halfLength = endLine")
        Check.bitEqViaJSON(f.goalLine, g.field.goalLine, "FIELD.goalLine")
        Check.bitEqViaJSON(f.endzoneDepth, g.field.endzoneDepth, "FIELD.endzoneDepth")
        Check.bitEqViaJSON(
            Playbook.DEFAULT_EDGE_MARGIN, g.field.edgeMargin, "FIELD.edgeMargin")
    }

    // MARK: - world construction

    private static func attrs(_ s: Sheet) -> AIAttributes {
        var acc: [AIThrowType: Double] = [:]
        for (k, v) in s.throwAccuracy {
            if let t = AIThrowType(rawValue: k) { acc[t] = v }
        }
        return AIAttributes(
            speed: s.speed, acceleration: s.acceleration, agility: s.agility,
            jumping: s.jumping, catching: s.catching, throwAccuracy: acc,
            throwPower: s.throwPower, decision: s.decision, stamina: s.stamina,
            defAwareness: s.defAwareness)
    }

    private static func config(_ c: CfgRow) -> TeamConfig {
        TeamConfig(
            formation: Playbook.FormationName(rawValue: c.formation)!,
            force: Playbook.Force(rawValue: c.force)!,
            zoneBias: c.zoneBias, aggression: c.aggression, seed: c.seed)
    }

    // MARK: - replay

    private static func replay(_ g: File) {
        let players = g.roster.map { r in
            AIPlayer(
                id: r.id, team: r.team, pos: .zero, vel: .zero, attr: attrs(r.attr),
                handed: Playbook.Handedness(rawValue: r.handed)!,
                archetype: Archetype(rawValue: r.archetype)!,
                energy: r.energy, role: PlayerRole(rawValue: r.role)!)
        }

        // The fixture forks both teams off one parent stream, and `fork` does not disturb
        // the parent — so the two forks are order-independent and this reproduces them
        // from a bare seed without replaying anything the generator did.
        let trng = Rng(seed: g.teamSeed)
        let teams = [
            TeamAI(
                team: 0, dir: g.dirs[0], rng: trng.fork(salt: g.forkSalts[0]),
                cfg: config(g.cfg[0]), field: .standard),
            TeamAI(
                team: 1, dir: g.dirs[1], rng: trng.fork(salt: g.forkSalts[1]),
                cfg: config(g.cfg[1]), field: .standard),
        ]
        let mates = [
            players.filter { $0.team == 0 },
            players.filter { $0.team == 1 },
        ]

        var world = AIWorld(
            players: players, possession: 0, phase: .setup,
            score: g.score, scoreCap: g.scoreCap, rand: Rng(seed: 7),
            field: .standard)

        for (fi) in g.frames.indices {
            if failed >= FAIL_BUDGET {
                // Early-exit notice, not a new claim: every failure counted in `failed`
                // already went through `Check.ok(false, ...)` via `record()`.
                print("  · teamai: stopped replaying at frame \(fi) after \(failed) failures")
                return
            }
            let f = g.frames[fi]

            // ---- write the recorded inputs back.
            for (i, row) in f.pl.enumerated() {
                players[i].pos = Vec3d(row.x, 0, row.z)
                players[i].vel = Vec3d(row.vx, 0, row.vz)
                players[i].energy = row.energy
            }
            let d = f.disc
            world.disc = AIDiscState(
                pos: Vec3d(d.x, d.y, d.z),
                vel: Vec3d(d.vx, d.vy, d.vz),
                state: DiscPhase(rawValue: d.state)!,
                carrier: d.carrier, thrownBy: nil,
                intendedReceiver: d.intendedReceiver, stall: d.stall)
            world.time = f.time
            world.phase = GamePhase(rawValue: f.phase)!
            world.possession = f.possession
            world.wind = Vec2d(f.wx, f.wz)

            // ---- step, in the reference's order: team 0 then team 1.
            let a = updateTeam(teams[0], world, f.dt)
            let b = updateTeam(teams[1], world, f.dt)
            let got = a + b

            let tag = "f\(fi)/\(f.seg)"

            // Energy is the one input the AI itself rewrites during the frame, so it is
            // compared before anything computed from it. A disagreement here is the
            // documented `tickStamina` knife-edge; the player it belongs to is excused
            // for this frame and counted.
            var flipped = Set<Int>()
            for (i, want) in f.pe.enumerated() {
                staminaChecks += 1
                let w = Double(want) ?? Double.nan
                if abs(players[i].energy - w) > traceTol {
                    staminaFlips += 1
                    flipped.insert(players[i].id)
                }
            }

            exact(got.count, f.it.count, "\(tag) intent count")
            if got.count == f.it.count {
                for k in 0..<got.count {
                    // Issue #20: this used to be a bare `continue`, which drops every
                    // field `compareIntent`/`structural` would have checked for this
                    // player this frame — position, mode, action, lane, cut kind,
                    // matchup — with nothing recording that it happened. The 0.5% flip-
                    // rate ceiling below bounds how OFTEN this fires; it says nothing
                    // about how many comparisons vanished each time, which is more than
                    // one. A counted, passing, self-describing assertion means the total
                    // reflects every skip rather than shrinking silently around it.
                    if flipped.contains(got[k].id) {
                        Check.ok(
                            true,
                            "\(tag) i\(k) — #\(got[k].id) skipped: energy diverged past the "
                                + "documented tickStamina libm knife-edge, not a porting bug")
                        continue
                    }
                    compareIntent(got[k], f.it[k], "\(tag) i\(k)")
                    structural(got[k], players, "\(tag) i\(k)")
                }
            }
            for t in 0..<2 {
                compareTeam(teams[t], mates[t], f.ts[t], "\(tag) team\(t)")
            }
        }
    }

    // MARK: - comparison

    private static func compareIntent(_ got: PlayerIntent, _ w: IntentRow, _ tag: String) {
        exact(got.id, w.id, "\(tag) id")
        approx(got.targetX, w.targetX, "\(tag) targetX")
        approx(got.targetZ, w.targetZ, "\(tag) targetZ")
        approx(got.faceX, w.faceX, "\(tag) faceX")
        approx(got.faceZ, w.faceZ, "\(tag) faceZ")

        // LAYOUT_CEILING is a DECLARED divergence (ADR-0007, `tools/goldens/divergences.ts`):
        // Swift guards a defensive bid at 1.10 m, a prone body's real reach; the reference
        // guards it at 1.85 m, which the registry's own measurement (three matches, 202k
        // evaluations) found inert relative to ITSELF — nothing ever reached 1.85 — but
        // that measurement never claimed 1.10 was inert too, and `land.y` does reach as
        // high as 1.4498. So for any bid attempt with `land.y` in [1.10, 1.85), the two
        // engines are DECLARED to disagree on whether it happens at all: the reference
        // bids (`land.y < 1.85` holds), Swift does not (`land.y < 1.10` fails). Traced to
        // this exact frame/site while diagnosing issue #36's Swift fallout (a `nomark`
        // replay whose trajectory happens to put a bid attempt in that gap at
        // `f1237-1238/i11`, which never occurred in this fixture before): `land.y` there
        // measured 1.3709, inside the gap, `wantsBid` true on the reference side.
        //
        // `land.y` itself is not visible from here (`predictCatchPoint` is private, and
        // exposing it publicly is a bigger surface than this narrow case needs), so the
        // exception is keyed on the decision's SHAPE instead: both sides agree this is a
        // defender reading the disc (`debug.role`/`debug.state`, checked as normal below,
        // so a mismatch THERE still fails), and the only disagreement is exactly
        // mode=`.layout`+action=`.bid` on one side against mode=`.sprint`+no action on the
        // other. Nothing else about the intent is excused — position, effort, speed, cut
        // fields all still compare normally — and the count is asserted small in
        // `replay`, the same shape `staminaFlips` uses, so a REAL regression (this firing
        // on far more than a bid-height coincidence) still goes red.
        let wantMode = w.mode
        let wantActionKind = w.action.split(separator: ",").first.map(String.init) ?? ""
        let gotIsLayoutBid: Bool = {
            if case .bid = got.action { return got.mode == .layout }
            return false
        }()
        let wantIsLayoutBid = wantMode == "layout" && wantActionKind == "bid"
        let isDefenderReadDisc = got.debug.role == "defender" && w.role == "defender"
            && got.debug.state == "read-disc" && w.state == "read-disc"
        if isDefenderReadDisc && gotIsLayoutBid != wantIsLayoutBid {
            layoutCeilingFlips += 1
        } else {
            exact(got.mode.rawValue, wantMode, "\(tag) mode")
            compareAction(got.action, w.action, tag)
        }

        approx(got.effort, w.effort, "\(tag) effort")
        approx(got.desiredSpeed, w.desiredSpeed, "\(tag) desiredSpeed")
        approx(got.maxSpeed, w.maxSpeed, "\(tag) maxSpeed")
        // Discrete in practice — it takes one of three literals — so an exact compare is
        // what makes the `settle` flag visible from outside at all.
        Check.bitEqViaJSON(got.arriveRadius, w.arriveRadius, "\(tag) arriveRadius")
        exact(got.debug.role, w.role, "\(tag) debug.role")
        exact(got.debug.state, w.state, "\(tag) debug.state")
        exact(got.debug.lane?.rawValue, w.lane, "\(tag) debug.lane")
        approx(got.debug.cutX, w.cutX, "\(tag) debug.cutX")
        approx(got.debug.cutZ, w.cutZ, "\(tag) debug.cutZ")
        exact(got.debug.cutKind?.rawValue, w.cutKind, "\(tag) debug.cutKind")
        Check.bitEqViaJSON(got.debug.cutDepth, w.cutDepth, "\(tag) debug.cutDepth")
    }

    private static func compareAction(_ got: PlayerAction?, _ text: String, _ tag: String) {
        if text.isEmpty {
            exact(got?.kind, nil, "\(tag) action absent")
            return
        }
        let a = text.split(separator: ",", omittingEmptySubsequences: false)
        guard let got else {
            record(false, "\(tag) action missing — want \(a[0])")
            return
        }
        exact(got.kind, String(a[0]), "\(tag) action kind")
        switch got {
        case .throw(let type, let aim, let speed, let ft, let spin, let rid, let expected):
            exact(type.rawValue, String(a[1]), "\(tag) throw type")
            approx(aim.x, dbl(a[2]), "\(tag) throw aimX")
            approx(aim.y, dbl(a[3]), "\(tag) throw aimY")
            approx(aim.z, dbl(a[4]), "\(tag) throw aimZ")
            approx(speed, dbl(a[5]), "\(tag) throw speed")
            approx(ft, dbl(a[6]), "\(tag) throw flightTime")
            approx(spin, dbl(a[7]), "\(tag) throw spin")
            exact(rid, Int(a[8])!, "\(tag) throw receiverId")
            approx(expected, dbl(a[9]), "\(tag) throw expected")
        case .catch(let difficulty):
            approx(difficulty, dbl(a[1]), "\(tag) catch difficulty")
        case .bid(let x, let z):
            approx(x, dbl(a[1]), "\(tag) bid x")
            approx(z, dbl(a[2]), "\(tag) bid z")
            // `a[3]` is the reference's `extend`, deliberately unread. It is write-only in
            // `src/sim/AI.ts` too — nothing there consumes it either — so the port no longer
            // carries it on `.bid`. What it holds is `layoutExtend(p)` for the bidding
            // player, which `AIMathTests` already pins bit for bit against `aimath.json`.
        case .jump(let height):
            approx(height, dbl(a[1]), "\(tag) jump height")
        case .stall(let count):
            approx(count, dbl(a[1]), "\(tag) stall count")
        case .pickup:
            break
        case .fake(let type):
            exact(type.rawValue, String(a[1]), "\(tag) fake type")
        }
    }

    /// The four intent fields the fixture deliberately does not carry.
    ///
    /// They are pure functions of the player, which `AIMathTests` already pins bit for
    /// bit — so what is worth asserting is that `intent` wired the right function to the
    /// right field, which this does without four more doubles on every row. `bitEq`
    /// rather than a tolerance: both sides are the same Swift call.
    private static func structural(_ i: PlayerIntent, _ players: [AIPlayer], _ tag: String) {
        guard let p = players.first(where: { $0.id == i.id }) else {
            record(false, "\(tag) intent for unknown player \(i.id)")
            return
        }
        Check.bitEq(i.maxAccel, effectiveAccel(p), "\(tag) maxAccel = effectiveAccel")
        Check.bitEq(i.maxDecel, effectiveDecel(p), "\(tag) maxDecel = effectiveDecel")
        Check.bitEq(i.turnRate, turnRateOf(p), "\(tag) turnRate = turnRateOf")
        Check.bitEq(i.personalSpace, 0.72, "\(tag) personalSpace")
        exact(i.team, p.team, "\(tag) team")
    }

    private static func compareTeam(
        _ t: TeamAI, _ mates: [AIPlayer], _ w: TeamRow, _ tag: String
    ) {
        approx(t.stall, w.stall, "\(tag) stall")
        exact(t.currentScheme.rawValue, w.scheme, "\(tag) scheme")
        exact(t.currentFormation.rawValue, w.formation, "\(tag) formation")
        exact(t.openSign, w.openSign, "\(tag) openSign")
        approx(t.stackAxisX, w.stackAxisX, "\(tag) stackAxisX")
        exact(t.marker, w.marker, "\(tag) marker")
        exact(t.resetHandler, w.resetHandler, "\(tag) resetHandler")
        exact(t.openSideOnD, w.openSideOnD, "\(tag) openSideOnD")
        exact(t.force.rawValue, w.force, "\(tag) force")
        exact(t.stackHolding().map(String.init).joined(separator: ","), w.holding,
            "\(tag) stackHolding")
        // The matchup table is the single most order-sensitive structure in the port: the
        // reference iterates a JS `Map` and keeps the LAST defender matched to the
        // thrower. Comparing the whole table every frame is what makes an unordered
        // container fail loudly instead of intermittently.
        exact(
            mates.map { t.matchupOf($0.id).map(String.init) ?? "" }.joined(separator: ","),
            w.matchup, "\(tag) matchups")
        exact(
            mates.map { t.zoneRoleOf($0.id)?.rawValue ?? "" }.joined(separator: ","),
            w.zoneRole, "\(tag) zoneRoles")
    }

    // MARK: - prose as behaviour

    private static func claims(_ g: File) {
        let pb = Playbook.regulation

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

        // ---- part two: the behaviour. In the `nomark` segment a mark IS set — the
        // marker reaches counting range on 152 of 400 frames — but the game system never
        // publishes a count. An offence with no clock of its own stands still forever.
        Check.ok(
            g.observed.nomarkMarkedFrames > 0,
            "nomark segment: the mark is genuinely established")
        Check.ok(
            g.observed.nomarkThrows > 0,
            "nomark segment: the offence still releases the disc with the count dead")
        Check.inRange(
            g.observed.nomarkFirstThrowSecond, 0, 13.0,
            "nomark segment: and it does so inside thirteen seconds, not four hundred")
        Check.ok(
            g.observed.nomarkDumps > 0,
            "nomark segment: the reset still works with the count dead")
        // The bound the doc comment quotes: `stallRead` is `max(disc.stall, holdTime -
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
        for f in g.frames where f.seg == "live" {
            let dir = Double(g.dirs[f.possession])
            let floor = -(FieldConstants.standard.goalLine - 2.0)
            for w in f.it {
                // Only the team in possession is running an offensive shape.
                if (w.id < 7 ? 0 : 1) != f.possession { continue }
                let kind = w.cutKind
                if kind == "dump" || kind == "swing" {
                    resetCuts += 1
                    Check.ok(
                        dir * w.cutZ >= floor - 1e-9,
                        "a reset cut never targets ground behind the own-goal floor "
                            + "(\(kind!) at z=\(w.cutZ))")
                }
                if w.role == "handler" && w.state == "stack" {
                    handlerStandings += 1
                    Check.ok(
                        dir * w.targetZ >= floor - 1e-9,
                        "a handler never STANDS behind the own-goal floor "
                            + "(z=\(w.targetZ))")
                }
            }
        }
        Check.ok(resetCuts > 0, "the live segment actually contains reset cuts to check")
        Check.ok(
            handlerStandings > 0, "the live segment actually contains stationed handlers")

        // ---- the segments did what they were built to do. Asserted so a fixture that
        // silently stops producing flights, ground discs or zone frames is caught here
        // rather than by everything downstream quietly passing.
        Check.ok(g.observed.liveFlightFrames > 0, "the trace contains a disc in flight")
        Check.ok(g.observed.liveGroundFrames > 0, "the trace contains a loose disc")
        Check.ok(g.observed.livePickups > 0, "the trace contains a pickup")
        Check.ok(g.observed.livePossessionFlips > 0, "the trace contains a turnover")
        Check.ok(g.observed.zoneFrames > 0, "the trace contains a zone")
        Check.ok(
            g.observed.zoneStallFrames > 0, "the cup mark applies a count in the zone")
        Check.ok(
            (g.observed.modes["mark"] ?? 0) > 0, "the trace contains an established mark")
        Check.ok(
            (g.observed.cutKinds["deep"] ?? 0) > 0 && (g.observed.cutKinds["under"] ?? 0) > 0,
            "the trace contains both halves of the vertical stack's cut vocabulary")

        // ---- THE COMMAND CHANNEL. `commandCut` is the one way anything outside the AI
        // may steer an offensive player, and it is not reachable from a trace, because
        // nothing in the trace is holding an aim stick. Its doc makes three falsifiable
        // promises and all three are checked here.
        let cplayers = g.roster.map { r in
            AIPlayer(
                id: r.id, team: r.team, pos: Vec3d(Double(r.id % 7) * 2 - 6, 0, 4),
                vel: .zero, attr: attrs(r.attr),
                handed: Playbook.Handedness(rawValue: r.handed)!,
                archetype: Archetype(rawValue: r.archetype)!,
                energy: 1, role: PlayerRole(rawValue: r.role)!)
        }
        let ct = TeamAI(
            team: 0, dir: 1, rng: Rng(seed: 5), cfg: config(g.cfg[0]), field: .standard)
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
                    record(false, "commandCut refused a legal order (\(id), \(dx), \(dz))")
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
                exact(
                    updateTeam(ct, cw, 1.0 / 120).first { $0.id == id }?.debug.cutKind,
                    route.kind, "a commanded cut is the cut that gets run (\(id))")
            }
        }
        exact(commanded, 24, "every commanded direction produced a route")

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
}
