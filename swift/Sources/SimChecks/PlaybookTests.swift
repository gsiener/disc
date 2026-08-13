import Foundation
import UltimateSim

/// The playbook port, against fixtures dumped from `src/sim/Playbook.ts`.
///
/// Playbook is almost entirely `+ - * / min max abs clamp` on doubles, all of which
/// IEEE 754 makes correctly rounded — so nearly everything here is asserted
/// **bit-for-bit** via `Check.bitEqViaJSON`. A tolerance would pass a sign flip on
/// `openSign`, a `-` for a `+` in a station offset, or a clamp bound applied to the
/// wrong end, because all three still land somewhere on the pitch.
///
/// Exactly three things are not bit-exact, and each says why:
///
///   - `dist2` and `markPoint` go through `Math.hypot`. V8 computes `Math.hypot` with
///     its own compensated sum-of-squares; Swift calls the platform libm's `hypot`.
///     Neither is specified to the last ulp, so those get a 4-ulp envelope. This is the
///     same treatment `SimMathTests` gives its quaternion norms.
///   - `sigmoid` goes through `Math.exp`, likewise unspecified in its last bit.
///
/// Everything downstream of `markPoint` — the whole `cup-mark` station of every zone
/// shell — inherits the envelope for the same reason, and only for that station.
///
/// ------------------------------------------------------------------ the pitch
///
/// The fixtures are generated against the reference's module-level `FIELD`, which is
/// the regulation 100 x 37 m pitch and the only one `Playbook.ts` can express. So every
/// golden comparison below runs against `Playbook.regulation`. That the Swift port
/// genuinely threads the pitch rather than hiding a constant is asserted separately, by
/// property, in `minisPitch()` — a port that quietly kept 18.5 would pass every fixture
/// in this file and fail there.
enum PlaybookTests {

    // MARK: - fixture shapes

    struct V2: Decodable {
        let x: Double
        let z: Double
        var vec: Vec2d { Vec2d(x, z) }
    }

    struct FieldDTO: Decodable {
        let halfWidth: Double
        let halfLength: Double
        let goalLine: Double
        let endzoneDepth: Double
        let brick: Double
        let edgeMargin: Double
    }

    struct PlayDTO: Decodable {
        let stackSpacing: Double
        let stackLead: Double
        let stackHold: Int
        let maxLiveCuts: Int
        let cutStagger: Double
        let setupTime: Double
        let plantTime: Double
        let underCutTime: Double
        let deepCutTime: Double
        let markDistance: Double
        let markMax: Double
        let discSpace: Double
        let shadeOpen: Double
        let deepCushion: Double
        let underGap: Double
    }

    struct Constants: Decodable {
        let FIELD: FieldDTO
        let PLAY: PlayDTO
        let FORCE_DEADBAND: Double
        let POSITIONAL_FORCES: [String]
        let ALL_LANES: [String]
    }

    struct ClampCase: Decodable { let v: Double; let lo: Double; let hi: Double; let want: Double }
    struct LerpCase: Decodable { let a: Double; let b: Double; let t: Double; let want: Double }
    struct SmoothstepCase: Decodable {
        let edge0: Double
        let edge1: Double
        let x: Double
        let want: Double
    }
    struct Dist2Case: Decodable {
        let ax: Double
        let az: Double
        let bx: Double
        let bz: Double
        let dist: Double
        let distSq: Double
    }
    struct SigmoidCase: Decodable { let x: Double; let k: Double; let want: Double }

    struct ClampToFieldCase: Decodable { let p: V2; let margin: Double?; let want: V2 }
    struct InBoundsCase: Decodable {
        let x: Double
        let z: Double
        let margin: Double
        let want: Bool
    }
    struct GoalCase: Decodable {
        let z: Double
        let dir: Int
        let yards: Double
        let attack: Bool
        let own: Bool
    }

    struct HandSideCase: Decodable {
        let handed: Playbook.Handedness
        let dir: Int
        let want: Int
    }
    struct OpenSideSignCase: Decodable {
        let force: Playbook.Force
        let dir: Int
        let open: Int
        let brk: Int
    }
    struct OpenSideForCase: Decodable {
        let force: Playbook.Force
        let dir: Int
        let discX: Double
        let prev: Int?
        let open: Int
        let brk: Int
    }
    struct ReleaseSideCase: Decodable {
        let handed: Playbook.Handedness
        let dir: Int
        let releaseSignX: Double
        let want: Playbook.ThrowSide
    }

    struct StackColumnCase: Decodable {
        let name: Playbook.FormationName
        let openSign: Int
        let a: V2
        let want: Double
    }
    struct StationDTO: Decodable {
        let x: Double
        let z: Double
        let role: Playbook.StationRole
        let depth: Int
    }
    struct FormationCase: Decodable {
        let name: Playbook.FormationName
        let a: V2
        let dir: Int
        let openSign: Int
        let want: [StationDTO]
    }
    struct HandlerCountCase: Decodable {
        let name: Playbook.FormationName
        let handlers: Int
        let column: Bool
    }
    struct ChooseFormationCase: Decodable {
        let disc: V2
        let dir: Int
        let prefer: Playbook.FormationName
        let windSpeed: Double
        let openSign: Int
        let foeZone: Bool
        let want: Playbook.FormationName
    }

    struct LaneCase: Decodable {
        let x: Double
        let z: Double
        let disc: V2
        let dir: Int
        let openSign: Int
        let want: Playbook.LaneKey
    }
    struct CutRouteDTO: Decodable {
        let kind: Playbook.CutKind
        let lane: Playbook.LaneKey
        let setup: V2
        let target: V2
        let side: Int
        let setupTime: Double
        let maxTime: Double
    }
    struct BuildCutCase: Decodable {
        let kind: Playbook.CutKind
        let from: V2
        let disc: V2
        let dir: Int
        let openSign: Int
        let side: Int
        let j: Double
        let want: CutRouteDTO
    }

    struct MarkPointCase: Decodable {
        let thrower: V2
        let dir: Int
        let breakSign: Int
        let distance: Double?
        let want: V2
    }

    struct ZoneStationDTO: Decodable {
        let role: Playbook.ZoneRole
        let x: Double
        let z: Double
    }
    struct ZoneCase: Decodable {
        let disc: V2
        let dir: Int
        let openSign: Int
        let deepThreat: V2?
        let want: [ZoneStationDTO]
    }
    struct ZoneCallCase: Decodable {
        let windSpeed: Double
        let scoreDiff: Int
        let pointsPlayed: Int
        let bias: Double
        let want: Bool
    }

    struct WeatherConstants: Decodable {
        let windyChance: Double
        let calmAcross: Double
        let calmAlong: Double
        let windyMin: Double
        let windyMax: Double
        let panicBefore: Double
        let setPlayStall: Double
    }

    struct WeatherCase: Decodable {
        let seed: UInt32
        let wind: V2
        let speed: Double
        let windy: Bool
    }

    struct TimeoutCase: Decodable {
        let stall: Double
        let stallMax: Double
        let remaining: Int
        let throwsThisPoint: Int
        let receiving: Bool
        let stoppedThisPossession: Bool
        let ours: Int
        let theirs: Int
        let toWin: Int
        let want: String
    }

    struct File: Decodable {
        let note: String
        let constants: Constants
        let clampCases: [ClampCase]
        let lerpCases: [LerpCase]
        let smoothstepCases: [SmoothstepCase]
        let dist2Cases: [Dist2Case]
        let sigmoidCases: [SigmoidCase]
        let clampToFieldCases: [ClampToFieldCase]
        let inBoundsCases: [InBoundsCase]
        let goalCases: [GoalCase]
        let handSideSignCases: [HandSideCase]
        let openSideSignCases: [OpenSideSignCase]
        let openSideForCases: [OpenSideForCase]
        let releaseSideTypeCases: [ReleaseSideCase]
        let stackColumnXCases: [StackColumnCase]
        let formationStationsCases: [FormationCase]
        let handlerCountCases: [HandlerCountCase]
        let chooseFormationCases: [ChooseFormationCase]
        let laneOfCases: [LaneCase]
        let buildCutCases: [BuildCutCase]
        let markPointCases: [MarkPointCase]
        let zoneStationsCases: [ZoneCase]
        let shouldPlayZoneCases: [ZoneCallCase]
        let weather: WeatherConstants
        let weatherCases: [WeatherCase]
        let timeoutCases: [TimeoutCase]
    }

    // MARK: - tolerance

    /// How many ulps of the expected value a `hypot`/`exp` result may drift.
    ///
    /// Stated as ulps rather than as an absolute number because the values here span
    /// four orders of magnitude — a corner-to-corner `dist2` is 107 m and a degenerate
    /// one is 0 — and a fixed 1e-15 would be four ulps at one end and a thousandth of
    /// an ulp at the other. Four is the envelope V8's compensated `Math.hypot` is worth
    /// against a platform libm; in practice the observed deviation is 0 or 1.
    private static let ULPS = 4.0

    /// The regulation pitch — the only geometry `Playbook.ts` can express, and
    /// therefore the only one the fixtures describe.
    private static let pb = Playbook.regulation

    static func run() throws {
        let g = try Goldens.load(File.self, "playbook")

        constants(g.constants)
        maths(g)
        geometry(g)
        forces(g)
        formations(g)
        cuts(g)
        mark(g)
        zone(g)
        claims()
        minisPitch()
        minisShape()
    }

    // MARK: - constants

    /// Compared one at a time rather than as a struct, so a failure names the number
    /// that is wrong. A single typed digit here moves every station on the pitch by a
    /// plausible-looking amount.
    private static func constants(_ c: Constants) {
        // The reference's `FIELD` against the threaded `FieldConstants`. This is the
        // mapping the port's doc comment claims; asserting it is what stops the two
        // spellings drifting apart.
        Check.bitEqViaJSON(pb.field.sideline, c.FIELD.halfWidth, "FIELD.halfWidth = sideline")
        Check.bitEqViaJSON(pb.field.endLine, c.FIELD.halfLength, "FIELD.halfLength = endLine")
        Check.bitEqViaJSON(pb.field.goalLine, c.FIELD.goalLine, "FIELD.goalLine")
        Check.bitEqViaJSON(pb.field.endzoneDepth, c.FIELD.endzoneDepth, "FIELD.endzoneDepth")
        Check.bitEqViaJSON(pb.field.brickZ, c.FIELD.brick, "FIELD.brick = brickZ")
        Check.bitEqViaJSON(pb.edgeMargin, c.FIELD.edgeMargin, "FIELD.edgeMargin")

        Check.bitEqViaJSON(Playbook.PLAY.stackSpacing, c.PLAY.stackSpacing, "PLAY.stackSpacing")
        Check.bitEqViaJSON(Playbook.PLAY.stackLead, c.PLAY.stackLead, "PLAY.stackLead")
        Check.eq(Playbook.PLAY.stackHold, c.PLAY.stackHold, "PLAY.stackHold")
        Check.eq(Playbook.PLAY.maxLiveCuts, c.PLAY.maxLiveCuts, "PLAY.maxLiveCuts")
        Check.bitEqViaJSON(Playbook.PLAY.cutStagger, c.PLAY.cutStagger, "PLAY.cutStagger")
        Check.bitEqViaJSON(Playbook.PLAY.setupTime, c.PLAY.setupTime, "PLAY.setupTime")
        Check.bitEqViaJSON(Playbook.PLAY.plantTime, c.PLAY.plantTime, "PLAY.plantTime")
        Check.bitEqViaJSON(Playbook.PLAY.underCutTime, c.PLAY.underCutTime, "PLAY.underCutTime")
        Check.bitEqViaJSON(Playbook.PLAY.deepCutTime, c.PLAY.deepCutTime, "PLAY.deepCutTime")
        Check.bitEqViaJSON(Playbook.PLAY.markDistance, c.PLAY.markDistance, "PLAY.markDistance")
        Check.bitEqViaJSON(Playbook.PLAY.markMax, c.PLAY.markMax, "PLAY.markMax")
        Check.bitEqViaJSON(Playbook.PLAY.discSpace, c.PLAY.discSpace, "PLAY.discSpace")
        Check.bitEqViaJSON(Playbook.PLAY.shadeOpen, c.PLAY.shadeOpen, "PLAY.shadeOpen")
        Check.bitEqViaJSON(Playbook.PLAY.deepCushion, c.PLAY.deepCushion, "PLAY.deepCushion")
        Check.bitEqViaJSON(Playbook.PLAY.underGap, c.PLAY.underGap, "PLAY.underGap")

        Check.bitEqViaJSON(Playbook.FORCE_DEADBAND, c.FORCE_DEADBAND, "FORCE_DEADBAND")

        Check.eq(
            Playbook.POSITIONAL_FORCES.map(\.rawValue), c.POSITIONAL_FORCES,
            "POSITIONAL_FORCES")
        Check.eq(Playbook.ALL_LANES.map(\.rawValue), c.ALL_LANES, "ALL_LANES")
    }

    // MARK: - maths

    private static func maths(_ g: File) {
        for c in g.clampCases {
            // `clamp` is reused from `Move/Attributes.swift` rather than redefined here.
            // These cases pin that the shared one has the reference's exact chained
            // ternary — including the lo > hi case, where it returns `lo`.
            Check.bitEqViaJSON(
                clamp(c.v, c.lo, c.hi), c.want, "clamp(\(c.v), \(c.lo), \(c.hi))")
        }
        for c in g.lerpCases {
            Check.bitEqViaJSON(
                Playbook.lerp(c.a, c.b, c.t), c.want, "lerp(\(c.a), \(c.b), \(c.t))")
        }
        for c in g.smoothstepCases {
            Check.bitEqViaJSON(
                Playbook.smoothstep(c.edge0, c.edge1, c.x), c.want,
                "smoothstep(\(c.edge0), \(c.edge1), \(c.x))")
        }
        for c in g.dist2Cases {
            // `distSq2` is a sum of two products: bit-exact.
            Check.bitEqViaJSON(
                Playbook.distSq2(c.ax, c.az, c.bx, c.bz), c.distSq,
                "distSq2(\(c.ax),\(c.az) -> \(c.bx),\(c.bz))")
            // `dist2` is `Math.hypot`: an envelope.
            nearUlp(
                Playbook.dist2(c.ax, c.az, c.bx, c.bz), c.dist,
                "dist2(\(c.ax),\(c.az) -> \(c.bx),\(c.bz))")
        }
        for c in g.sigmoidCases {
            nearUlp(Playbook.sigmoid(c.x, c.k), c.want, "sigmoid(\(c.x), k \(c.k))")
        }
    }

    // MARK: - field geometry

    private static func geometry(_ g: File) {
        for c in g.clampToFieldCases {
            let got = c.margin.map { pb.clampToField(c.p.vec, margin: $0) }
                ?? pb.clampToField(c.p.vec)
            let at = "clampToField(\(c.p.x), \(c.p.z), margin \(c.margin.map { "\($0)" } ?? "default"))"
            Check.bitEqViaJSON(got.x, c.want.x, "\(at).x")
            Check.bitEqViaJSON(got.z, c.want.z, "\(at).z")
        }
        for c in g.inBoundsCases {
            Check.eq(
                pb.inBounds(c.x, c.z, margin: c.margin), c.want,
                "inBounds(\(c.x), \(c.z), margin \(c.margin))")
        }
        for c in g.goalCases {
            Check.bitEqViaJSON(
                pb.yardsToGoal(c.z, c.dir), c.yards, "yardsToGoal(\(c.z), dir \(c.dir))")
            Check.eq(
                pb.inAttackEndzone(c.z, c.dir), c.attack,
                "inAttackEndzone(\(c.z), dir \(c.dir))")
            Check.eq(
                pb.inOwnEndzone(c.z, c.dir), c.own, "inOwnEndzone(\(c.z), dir \(c.dir))")
        }
    }

    // MARK: - force / side

    private static func forces(_ g: File) {
        for c in g.handSideSignCases {
            Check.eq(
                Playbook.handSideSign(c.handed, c.dir), c.want,
                "handSideSign(\(c.handed.rawValue), dir \(c.dir))")
        }
        for c in g.openSideSignCases {
            let at = "\(c.force.rawValue), dir \(c.dir)"
            Check.eq(Playbook.openSideSign(c.force, c.dir), c.open, "openSideSign(\(at))")
            Check.eq(Playbook.breakSideSign(c.force, c.dir), c.brk, "breakSideSign(\(at))")
        }
        for c in g.openSideForCases {
            let at =
                "\(c.force.rawValue), dir \(c.dir), discX \(c.discX), "
                + "prev \(c.prev.map { "\($0)" } ?? "nil")"
            Check.eq(
                Playbook.openSideFor(c.force, c.dir, c.discX, c.prev), c.open,
                "openSideFor(\(at))")
            Check.eq(
                Playbook.breakSideFor(c.force, c.dir, c.discX, c.prev), c.brk,
                "breakSideFor(\(at))")
        }
        for c in g.releaseSideTypeCases {
            Check.eq(
                Playbook.releaseSideType(c.handed, c.dir, c.releaseSignX), c.want,
                "releaseSideType(\(c.handed.rawValue), dir \(c.dir), x \(c.releaseSignX))")
        }
    }

    // MARK: - formations

    private static func formations(_ g: File) {
        for c in g.stackColumnXCases {
            Check.bitEqViaJSON(
                Playbook.stackColumnX(c.name, c.a.vec, c.openSign), c.want,
                "stackColumnX(\(c.name.rawValue), a.x \(c.a.x), open \(c.openSign))")
        }

        for c in g.formationStationsCases {
            let got = pb.formationStations(c.name, c.a.vec, c.dir, c.openSign)
            let at =
                "formationStations(\(c.name.rawValue), disc \(c.a.x),\(c.a.z), "
                + "dir \(c.dir), open \(c.openSign))"
            Check.eq(got.count, c.want.count, "\(at).count")
            guard got.count == c.want.count else { continue }
            for (i, w) in c.want.enumerated() {
                Check.bitEqViaJSON(got[i].x, w.x, "\(at)[\(i)].x")
                Check.bitEqViaJSON(got[i].z, w.z, "\(at)[\(i)].z")
                Check.eq(got[i].role, w.role, "\(at)[\(i)].role")
                Check.eq(got[i].depth, w.depth, "\(at)[\(i)].depth")
            }
        }

        for c in g.handlerCountCases {
            Check.eq(
                Playbook.handlerCount(c.name), c.handlers, "handlerCount(\(c.name.rawValue))")
            Check.eq(Playbook.hasColumn(c.name), c.column, "hasColumn(\(c.name.rawValue))")
        }

        for c in g.chooseFormationCases {
            Check.eq(
                pb.chooseFormation(
                    c.disc.vec, c.dir, c.prefer, c.windSpeed, c.openSign, c.foeZone),
                c.want,
                "chooseFormation(disc \(c.disc.x),\(c.disc.z), dir \(c.dir), "
                    + "prefer \(c.prefer.rawValue), wind \(c.windSpeed), open \(c.openSign), "
                    + "foeZone \(c.foeZone))")
        }
    }

    // MARK: - cuts

    private static func cuts(_ g: File) {
        for c in g.laneOfCases {
            Check.eq(
                Playbook.laneOf(c.x, c.z, c.disc.vec, c.dir, c.openSign), c.want,
                "laneOf(\(c.x),\(c.z) vs disc \(c.disc.x),\(c.disc.z), dir \(c.dir), "
                    + "open \(c.openSign))")
        }

        for c in g.buildCutCases {
            let got = pb.buildCut(
                c.kind, c.from.vec, c.disc.vec, c.dir, c.openSign, c.side, c.j)
            let at =
                "buildCut(\(c.kind.rawValue), from \(c.from.x),\(c.from.z), "
                + "disc \(c.disc.x),\(c.disc.z), dir \(c.dir), open \(c.openSign), "
                + "side \(c.side), j \(c.j))"
            Check.eq(got.kind, c.want.kind, "\(at).kind")
            Check.eq(got.lane, c.want.lane, "\(at).lane")
            Check.bitEqViaJSON(got.setup.x, c.want.setup.x, "\(at).setup.x")
            Check.bitEqViaJSON(got.setup.z, c.want.setup.z, "\(at).setup.z")
            Check.bitEqViaJSON(got.target.x, c.want.target.x, "\(at).target.x")
            Check.bitEqViaJSON(got.target.z, c.want.target.z, "\(at).target.z")
            Check.eq(got.side, c.want.side, "\(at).side")
            Check.bitEqViaJSON(got.setupTime, c.want.setupTime, "\(at).setupTime")
            Check.bitEqViaJSON(got.maxTime, c.want.maxTime, "\(at).maxTime")
        }
    }

    // MARK: - mark

    private static func mark(_ g: File) {
        for c in g.markPointCases {
            let got = c.distance.map { Playbook.markPoint(c.thrower.vec, c.dir, c.breakSign, $0) }
                ?? Playbook.markPoint(c.thrower.vec, c.dir, c.breakSign)
            let at =
                "markPoint(dir \(c.dir), break \(c.breakSign), "
                + "d \(c.distance.map { "\($0)" } ?? "default"))"
            nearUlp(got.x, c.want.x, "\(at).x")
            nearUlp(got.z, c.want.z, "\(at).z")
        }
    }

    // MARK: - zone

    private static func zone(_ g: File) {
        for c in g.zoneStationsCases {
            let got = pb.zoneStations(c.disc.vec, c.dir, c.openSign, c.deepThreat?.vec)
            let at =
                "zoneStations(disc \(c.disc.x),\(c.disc.z), dir \(c.dir), "
                + "open \(c.openSign), threat \(c.deepThreat.map { "\($0.x)" } ?? "nil"))"
            Check.eq(got.count, c.want.count, "\(at).count")
            guard got.count == c.want.count else { continue }
            for (i, w) in c.want.enumerated() {
                Check.eq(got[i].role, w.role, "\(at)[\(i)].role")
                if w.role == .cupMark {
                    // The only station downstream of `Math.hypot`.
                    nearUlp(got[i].x, w.x, "\(at)[\(i)].x")
                    nearUlp(got[i].z, w.z, "\(at)[\(i)].z")
                } else {
                    Check.bitEqViaJSON(got[i].x, w.x, "\(at)[\(i)].x")
                    Check.bitEqViaJSON(got[i].z, w.z, "\(at)[\(i)].z")
                }
            }
        }

        for c in g.shouldPlayZoneCases {
            Check.eq(
                Playbook.shouldPlayZone(c.windSpeed, c.scoreDiff, c.pointsPlayed, c.bias),
                c.want,
                "shouldPlayZone(wind \(c.windSpeed), diff \(c.scoreDiff), "
                    + "points \(c.pointsPlayed), bias \(c.bias))")
        }

        // ---- the weather ------------------------------------------------------
        //
        // The distribution's five constants, then sixty-four days drawn from the shared
        // generator. Three draws deep on either branch, so a port that reorders them — or
        // that takes the windy branch on the wrong side of the comparison — fails on the
        // first seed whose day disagrees.
        Check.bitEqViaJSON(Playbook.windyChance, g.weather.windyChance, "WEATHER.windyChance")
        Check.bitEqViaJSON(Playbook.calmAcross, g.weather.calmAcross, "WEATHER.calmAcross")
        Check.bitEqViaJSON(Playbook.calmAlong, g.weather.calmAlong, "WEATHER.calmAlong")
        Check.bitEqViaJSON(Playbook.windySpeed.min, g.weather.windyMin, "WEATHER.windyMin")
        Check.bitEqViaJSON(Playbook.windySpeed.max, g.weather.windyMax, "WEATHER.windyMax")
        Check.bitEqViaJSON(
            Playbook.timeoutPanicBefore, g.weather.panicBefore, "TIMEOUT_PLAY.panicBefore")
        Check.bitEqViaJSON(
            Playbook.timeoutSetPlayStall, g.weather.setPlayStall, "TIMEOUT_PLAY.setPlayStall")

        for c in g.weatherCases {
            let got = Playbook.drawWeather(Rng(seed: c.seed))
            let at = "drawWeather(seed \(c.seed))"
            Check.eq(got.windy, c.windy, "\(at).windy")
            Check.bitEqViaJSON(got.wind.x, c.wind.x, "\(at).wind.x")
            Check.bitEqViaJSON(got.wind.z, c.wind.z, "\(at).wind.z")
            // The speed is `Math.hypot` on a calm day and a raw `range` draw on a windy
            // one, so only the first of those needs the ulp envelope.
            if got.windy {
                Check.bitEqViaJSON(got.speed, c.speed, "\(at).speed")
            } else {
                nearUlp(got.speed, c.speed, "\(at).speed")
            }
        }

        // ---- the timeout decision --------------------------------------------
        for c in g.timeoutCases {
            let got = Playbook.timeoutIntent(
                Playbook.TimeoutRead(
                    stall: c.stall, stallMax: c.stallMax, remaining: c.remaining,
                    throwsThisPoint: c.throwsThisPoint, receiving: c.receiving,
                    stoppedThisPossession: c.stoppedThisPossession,
                    ours: c.ours, theirs: c.theirs, toWin: c.toWin))
            Check.eq(
                got.rawValue, c.want,
                "timeoutIntent(stall \(c.stall), left \(c.remaining), "
                    + "throws \(c.throwsThisPoint), recv \(c.receiving), "
                    + "stopped \(c.stoppedThisPossession), "
                    + "\(c.ours)-\(c.theirs) to \(c.toWin))")
        }
    }

    // MARK: - the claims the module makes in prose

    /// Doc comments assert behaviour; behaviour can be checked.
    ///
    /// Every one of these would still pass every fixture above if the sign were flipped
    /// on both sides of the port, because a fixture only records what the reference
    /// does — not what it is supposed to mean. These say what it means.
    private static func claims() {
        let gl = pb.field.goalLine

        // ---- handedness ------------------------------------------------------
        // "a player facing +Z has their right hand at -X".
        Check.eq(Playbook.handSideSign(.right, 1), -1, "right hand is at -X facing +Z")
        Check.eq(Playbook.handSideSign(.left, 1), 1, "left hand is at +X facing +Z")
        Check.eq(Playbook.handSideSign(.right, -1), 1, "right hand is at +X facing -Z")

        // ---- force algebra ---------------------------------------------------
        for dir in [1, -1] {
            for f in [Playbook.Force.forehand, .backhand, .straight, .middle, .sideline] {
                Check.eq(
                    Playbook.breakSideSign(f, dir), -Playbook.openSideSign(f, dir),
                    "break side is the opposite of the open side (\(f.rawValue), \(dir))")
            }
            // "force forehand" and "force backhand" are opposite calls.
            Check.eq(
                Playbook.openSideSign(.forehand, dir),
                -Playbook.openSideSign(.backhand, dir),
                "forehand and backhand forces open opposite sides (dir \(dir))")
            // A forehand force opens the right-handed thrower's forehand side.
            Check.eq(
                Playbook.openSideSign(.forehand, dir),
                Playbook.handSideSign(.right, dir),
                "a forehand force opens the forehand side (dir \(dir))")
        }

        // "FORCE MIDDLE means ... the open side points at x = 0 — a disc on the +X line
        // has its open side at -X. The trap is the mirror."
        Check.eq(
            Playbook.openSideFor(.middle, 1, 15, nil), -1,
            "force middle on the +X line opens toward -X")
        Check.eq(
            Playbook.openSideFor(.middle, 1, -15, nil), 1,
            "force middle on the -X line opens toward +X")
        Check.eq(
            Playbook.openSideFor(.sideline, 1, 15, nil), 1,
            "the trap on the +X line invites the throw down that line")
        Check.eq(
            Playbook.openSideFor(.sideline, 1, -15, nil), -1,
            "the trap on the -X line invites the throw down that line")

        // "Inside this band the previous call is held" — and only inside it, and only
        // when a previous call exists.
        let db = Playbook.FORCE_DEADBAND
        for prev in [1, -1] {
            Check.eq(
                Playbook.openSideFor(.middle, 1, db - 1e-9, prev), prev,
                "inside the deadband the previous call is held (prev \(prev))")
            Check.eq(
                Playbook.openSideFor(.middle, 1, -(db - 1e-9), prev), prev,
                "inside the deadband on -X too (prev \(prev))")
            Check.eq(
                Playbook.openSideFor(.middle, 1, db, prev), -1,
                "exactly on the deadband the call commits (prev \(prev))")
        }
        Check.eq(
            Playbook.openSideFor(.middle, 1, 0.1, nil), -1,
            "with no previous call the deadband cannot hold anything")
        // A fixed force ignores the deadband entirely.
        Check.eq(
            Playbook.openSideFor(.forehand, 1, 0.1, 1),
            Playbook.openSideSign(.forehand, 1),
            "a fixed force is unaffected by the disc's x")

        // ---- release side ----------------------------------------------------
        // "a release on the forehand side requires a forehand".
        for handed in [Playbook.Handedness.right, .left] {
            for dir in [1, -1] {
                let fh = Playbook.handSideSign(handed, dir)
                Check.eq(
                    Playbook.releaseSideType(handed, dir, Double(fh) * 3), .forehand,
                    "a release on the forehand side is a forehand")
                Check.eq(
                    Playbook.releaseSideType(handed, dir, Double(-fh) * 3), .backhand,
                    "a release on the other side is a backhand")
                Check.eq(
                    Playbook.releaseSideType(handed, dir, 0), .forehand,
                    "a release exactly on the midline defaults to the forehand")
            }
        }

        // ---- formations ------------------------------------------------------
        // "hasColumn ... the one structural fact that separates the four looks".
        Check.ok(Playbook.hasColumn(.vertical), "vertical is a column")
        Check.ok(Playbook.hasColumn(.side), "side stack is a column")
        Check.ok(!Playbook.hasColumn(.horizontal), "ho is a row, not a column")
        Check.ok(!Playbook.hasColumn(.endzone), "the endzone set is a row, not a column")
        Check.eq(Playbook.handlerCount(.vertical), 2, "vert has two handlers")
        Check.eq(Playbook.handlerCount(.horizontal), 3, "ho has three handlers")

        for dir in [1, -1] {
            for openSign in [1, -1] {
                let disc = Vec2d(0, 0)

                // "STATION 0 IS THE RESET, and it must be on the OPEN side" — the
                // documented ho bug. Asserted for every set that has a reset.
                for name in [Playbook.FormationName.vertical, .horizontal, .side, .endzone] {
                    let st = pb.formationStations(name, disc, dir, openSign)
                    let s0 = st[0]
                    Check.eq(s0.role, .handler, "\(name.rawValue) station 0 is a handler")
                    Check.ok(
                        (s0.x - disc.x) * Double(openSign) > 0,
                        "\(name.rawValue) station 0 (the reset) is on the open side "
                            + "(dir \(dir), open \(openSign))")
                    Check.ok(
                        Double(dir) * (s0.z - disc.z) < 0,
                        "\(name.rawValue) station 0 is behind the disc "
                            + "(dir \(dir), open \(openSign))")
                    Check.eq(
                        st.filter { $0.role == .handler }.count,
                        Playbook.handlerCount(name),
                        "\(name.rawValue) places handlerCount handlers")
                    Check.eq(st.count, 7, "\(name.rawValue) places seven stations")
                }

                // "the break-side handler is the swing" — ho station 2 is on the break.
                let ho = pb.formationStations(.horizontal, disc, dir, openSign)
                Check.ok(
                    (ho[2].x - disc.x) * Double(openSign) < 0,
                    "ho station 2 (the swing) is on the break side")

                // The vertical stack is a COLUMN: every cutter shares one x, spaced by
                // `stackSpacing` and led by `stackLead`.
                let vert = pb.formationStations(.vertical, disc, dir, openSign)
                let cutters = vert.filter { $0.role == .cutter }
                Check.eq(cutters.count, 5, "vert stands five cutters")
                for i in 1..<cutters.count {
                    Check.bitEqViaJSON(
                        cutters[i].x, cutters[0].x, "vert cutter \(i) is in the column")
                    Check.near(
                        Double(dir) * (cutters[i].z - cutters[i - 1].z),
                        Playbook.PLAY.stackSpacing, 1e-12,
                        "vert cutters are stackSpacing apart")
                }
                Check.near(
                    Double(dir) * (cutters[0].z - disc.z), Playbook.PLAY.stackLead, 1e-12,
                    "the front of the stack sits stackLead downfield")

                // "The back cutter stands at stackLead + 4 * stackSpacing = 27.8 m
                // downfield" — the number `underCutTime` is sized against.
                Check.near(
                    Double(dir) * (cutters[4].z - disc.z),
                    Playbook.PLAY.stackLead + 4 * Playbook.PLAY.stackSpacing, 1e-12,
                    "the back of the stack is stackLead + 4 * stackSpacing out")

                // "a side stack ... puts the column on the break sideline".
                let sideSet = pb.formationStations(.side, disc, dir, openSign)
                for c in sideSet where c.role == .cutter {
                    Check.ok(
                        c.x * Double(openSign) < 0,
                        "the side stack column stands on the break sideline")
                }

                // "A RESET NEVER SETS UP BEHIND YOUR OWN GOAL LINE." Pin the disc on its
                // own line and check every handler station stays in front of the floor.
                let pinned = Vec2d(0, Double(-dir) * gl)
                for name in [Playbook.FormationName.vertical, .horizontal, .side, .endzone] {
                    for s in pb.formationStations(name, pinned, dir, openSign)
                    where s.role == .handler {
                        Check.ok(
                            Double(dir) * s.z >= -(gl - 2.0) - 1e-9,
                            "\(name.rawValue) keeps its handlers out of its own endzone "
                                + "(dir \(dir), open \(openSign))")
                    }
                }

                // The row-slide claim, stated against the failure it was written for:
                // with the disc wide at x = 17.4 the endzone handlers must NOT collapse
                // onto one another. The bug produced 10.5 / 10.5 / 4.0.
                let wide = pb.formationStations(.endzone, Vec2d(17.4, 0), dir, openSign)
                let hx = wide.filter { $0.role == .handler }.map(\.x).sorted()
                Check.near(hx[1] - hx[0], 6.5, 1e-12, "the endzone row keeps its spacing (lo)")
                Check.near(hx[2] - hx[1], 6.5, 1e-12, "the endzone row keeps its spacing (hi)")

                // Every station is inside the paint by the edge margin — that is what
                // `clampToField` is for, and it is applied to every push.
                for name in [Playbook.FormationName.vertical, .horizontal, .side, .endzone] {
                    for s in pb.formationStations(name, Vec2d(18.5, 49), dir, openSign) {
                        Check.ok(
                            abs(s.x) <= pb.field.sideline - pb.edgeMargin + 1e-9
                                && abs(s.z) <= pb.field.endLine - pb.edgeMargin + 1e-9,
                            "\(name.rawValue) stations stay inside the edge margin")
                    }
                }
            }
        }

        // ---- formation call --------------------------------------------------
        for dir in [1, -1] {
            let d = Double(dir)
            // "if yardsToGoal <= 13 return endzone" — from both sides of 13.
            Check.eq(
                pb.chooseFormation(Vec2d(0, d * (gl - 13)), dir, .vertical, 0, 1, false),
                .endzone, "the endzone set fires exactly at 13 m out")
            Check.eq(
                pb.chooseFormation(Vec2d(0, d * (gl - 13.5)), dir, .vertical, 0, 1, false),
                .vertical, "it does not fire at 13.5 m out")
            // "near a line, AND the open side pointing back into the field".
            Check.eq(
                pb.chooseFormation(Vec2d(17, 0), dir, .vertical, 0, -1, false), .side,
                "trapped on the break side calls the side stack")
            Check.eq(
                pb.chooseFormation(Vec2d(17, 0), dir, .vertical, 0, 1, false), .vertical,
                "trapped on the OPEN side does not call the side stack")
            Check.eq(
                pb.chooseFormation(Vec2d(14, 0), dir, .vertical, 0, -1, false), .vertical,
                "exactly 14 m out is not yet trapped")
            // "windSpeed > 7.5 return vertical" — when the foe is not known to be in zone.
            Check.eq(
                pb.chooseFormation(Vec2d(0, 0), dir, .horizontal, 8, 1, false), .vertical,
                "a big wind forces the vertical stack against a person mark")
            Check.eq(
                pb.chooseFormation(Vec2d(0, 0), dir, .horizontal, 7.5, 1, false), .horizontal,
                "exactly 7.5 m/s does not")
            // issue #57: a foe known to be running zone gets the anti-zone look
            // (horizontal) instead of vertical, regardless of wind — checked BEFORE the
            // wind gate, matching the reference's reordered rule.
            Check.eq(
                pb.chooseFormation(Vec2d(0, 0), dir, .horizontal, 8, 1, true), .horizontal,
                "a foe in zone gets horizontal even in a big wind")
            Check.eq(
                pb.chooseFormation(Vec2d(0, 0), dir, .horizontal, 0, 1, true), .horizontal,
                "and even with no wind at all — the zone read does not depend on wind")
            // "prefer === 'endzone' ? 'vertical' : prefer" — endzone is never a base look.
            Check.eq(
                pb.chooseFormation(Vec2d(0, 0), dir, .endzone, 0, 1, false), .vertical,
                "the endzone set is never a base look")
        }

        // ---- lanes -----------------------------------------------------------
        for dir in [1, -1] {
            for openSign in [1, -1] {
                let disc = Vec2d(0, 0)
                let d = Double(dir)
                let o = Double(openSign)
                Check.eq(
                    Playbook.laneOf(o * 3, disc.z + d * 1.0, disc, dir, openSign), .resetOpen,
                    "a point level with the disc on the open side is the open reset lane")
                Check.eq(
                    Playbook.laneOf(-o * 3, disc.z + d * 1.0, disc, dir, openSign),
                    .resetBreak, "and on the break side, the break reset lane")
                Check.eq(
                    Playbook.laneOf(o * 3, disc.z + d * 1.5, disc, dir, openSign), .openUnder,
                    "1.5 m downfield is already the under lane")
                Check.eq(
                    Playbook.laneOf(o * 3, disc.z + d * 16, disc, dir, openSign), .openDeep,
                    "16 m downfield is the deep lane")
                Check.eq(
                    Playbook.laneOf(disc.x, disc.z + d * 8, disc, dir, openSign), .openUnder,
                    "a point exactly on the disc's x counts as open")
            }
        }

        // ---- cuts ------------------------------------------------------------
        for dir in [1, -1] {
            for openSign in [1, -1] {
                let d = Double(dir)
                let o = Double(openSign)
                let disc = Vec2d(0, 0)

                // "A DEEP CUT ATTACKS THE SPACE BEHIND THE ... CUTTER" — the huck bug.
                // The back of the stack stands 27.8 m out; the target must be beyond him.
                let back = Vec2d(0, d * 27.8)
                for j in [0.0, 0.5, 1.0] {
                    let deep = pb.buildCut(.deep, back, disc, dir, openSign, openSign, j)
                    Check.ok(
                        d * (deep.target.z - back.z) > 0,
                        "a deep cut from the back of the stack runs forwards (j \(j))")
                }
                // ... and it is capped at 38 m so it cannot run off the end line.
                let far = pb.buildCut(.deep, Vec2d(0, d * 40), disc, dir, openSign, openSign, 1)
                Check.ok(
                    d * (far.target.z - disc.z) <= 38 + 1e-9,
                    "the deep reach is capped at 38 m")

                // "Sell deep first, then come back" — the under's setup step goes the
                // WRONG way, downfield of where the cutter starts.
                let from = Vec2d(0, d * 15)
                let under = pb.buildCut(.under, from, disc, dir, openSign, openSign, 0.5)
                Check.ok(
                    d * (under.setup.z - from.z) > 0,
                    "an under sets up by selling deep")
                Check.ok(
                    d * (under.target.z - from.z) < 0,
                    "and then attacks back toward the disc")

                // "A reset goes to the OPEN side and behind."
                let dump = pb.buildCut(.dump, Vec2d(0, -d * 5), disc, dir, openSign, openSign, 0.5)
                Check.ok(
                    (dump.target.x - disc.x) * o > 0, "a dump target is on the open side")
                Check.ok(d * (dump.target.z - disc.z) < 0, "a dump target is behind the disc")
                // "The setup sells the up-line hard the other way."
                Check.ok(
                    (dump.setup.x - 0) * o < 0, "the dump's setup step sells the break side")

                // "A RESET NEVER RUNS BEHIND YOUR OWN GOAL LINE", and "the ground the
                // floor takes away comes back as WIDTH".
                let pinnedDisc = Vec2d(0, -d * gl)
                for kind in [Playbook.CutKind.dump, .swing] {
                    let route = pb.buildCut(
                        kind, Vec2d(0, -d * (gl - 2)), pinnedDisc, dir, openSign, openSign, 0.5)
                    Check.ok(
                        d * route.target.z >= -(gl - 2.0) - 1e-9,
                        "a \(kind.rawValue) never resolves behind its own goal line "
                            + "(dir \(dir), open \(openSign))")
                    let free = pb.buildCut(
                        kind, Vec2d(0, 0), Vec2d(0, 0), dir, openSign, openSign, 0.5)
                    Check.ok(
                        abs(route.target.x - pinnedDisc.x) > abs(free.target.x) - 1e-9,
                        "a pinned \(kind.rawValue) gains width for the depth it gave up")
                    Check.ok(
                        abs(route.target.x) <= 13.0 + 1e-9,
                        "the width it gains is still inside SWING_BAND")
                }

                // "a setup step away from where you are going" — strike and up-line pay
                // a shorter setup than the downfield cuts do.
                let strike = pb.buildCut(.strike, Vec2d(0, d * 30), disc, dir, openSign, openSign, 0)
                Check.ok(
                    strike.setupTime < under.setupTime,
                    "a strike's setup step is shorter than an under's")
                Check.bitEqViaJSON(
                    strike.setupTime, Playbook.PLAY.setupTime * 0.7, "strike setupTime")

                // Every route lands inside the paint.
                for kind in [
                    Playbook.CutKind.under, .breakUnder, .deep, .strike, .upLine, .dump, .swing,
                ] {
                    let r = pb.buildCut(
                        kind, Vec2d(18, d * 45), Vec2d(18, d * 44), dir, openSign, openSign, 1)
                    Check.ok(
                        abs(r.target.x) <= pb.field.sideline - pb.edgeMargin + 1e-9
                            && abs(r.target.z) <= pb.field.endLine - pb.edgeMargin + 1e-9,
                        "a \(kind.rawValue) target is inside the edge margin")
                    Check.ok(
                        abs(r.setup.x) <= pb.field.sideline - pb.edgeMargin + 1e-9
                            && abs(r.setup.z) <= pb.field.endLine - pb.edgeMargin + 1e-9,
                        "a \(kind.rawValue) setup is inside the edge margin")
                    // The lane a route reports is the lane its target actually occupies.
                    Check.eq(
                        r.lane,
                        Playbook.laneOf(r.target.x, r.target.z, Vec2d(18, d * 44), dir, openSign),
                        "a \(kind.rawValue) reports the lane its target occupies")
                }

                // "underCutTime HAS TO COVER THE CANONICAL UNDER" — the longest cut.
                Check.ok(
                    under.maxTime >= Playbook.PLAY.deepCutTime,
                    "the under is allowed at least as long as the deep")
            }
        }

        // ---- mark ------------------------------------------------------------
        for dir in [1, -1] {
            for brk in [1, -1] {
                let thrower = Vec2d(2, -3)
                let m = Playbook.markPoint(thrower, dir, brk)
                Check.ok(
                    (m.x - thrower.x) * Double(brk) > 0,
                    "the marker stands on the break side (dir \(dir), break \(brk))")
                Check.ok(
                    Double(dir) * (m.z - thrower.z) > 0,
                    "and a touch downfield, in the break-throw release window")
                // "inside the stall radius".
                let d = Foundation.hypot(m.x - thrower.x, m.z - thrower.z)
                nearUlp(d, Playbook.PLAY.markDistance, "the mark stands off by markDistance")
                Check.ok(d <= Playbook.PLAY.markMax, "the mark is inside the legal maximum")
                Check.ok(d >= Playbook.PLAY.discSpace, "the mark respects disc space")
            }
        }

        // ---- zone ------------------------------------------------------------
        for dir in [1, -1] {
            for openSign in [1, -1] {
                let disc = Vec2d(0, 0)
                let z = pb.zoneStations(disc, dir, openSign, nil)
                Check.eq(z.count, 7, "a 3-2-2 zone stands seven bodies")
                func at(_ role: Playbook.ZoneRole) -> Playbook.ZoneStation {
                    z.first { $0.role == role }!
                }
                let d = Double(dir)
                // "three-person cup on the disc" — mark plus two, on either side.
                Check.ok(
                    at(.cupLeft).x < disc.x && at(.cupRight).x > disc.x,
                    "the cup's two wings sit either side of the disc")
                Check.ok(
                    d * (at(.cupLeft).z - disc.z) > 0 && d * (at(.cupRight).z - disc.z) > 0,
                    "the cup sits downfield of the disc")
                // "two wings" — one to each side of the force.
                Check.ok(
                    (at(.wingOpen).x - disc.x) * Double(openSign) > 0,
                    "the open wing is on the open side")
                Check.ok(
                    (at(.wingBreak).x - disc.x) * Double(openSign) < 0,
                    "the break wing is on the break side")
                // "a short deep and a deep" — layered, in that order.
                Check.ok(
                    d * at(.shortDeep).z > d * at(.cupLeft).z,
                    "the short deep plays behind the cup")
                Check.ok(
                    d * at(.deep).z > d * at(.shortDeep).z,
                    "the deep plays behind the short deep")
                // "the shell slides with the swing": move the disc, the shell moves.
                let swung = pb.zoneStations(Vec2d(10, 0), dir, openSign, nil)
                Check.ok(
                    swung.first { $0.role == .shortDeep }!.x
                        > z.first { $0.role == .shortDeep }!.x,
                    "the shell slides with the disc rather than chasing bodies")
                // The deep is pulled toward a live deep threat, and clamped to +/-9.
                let pulled = pb.zoneStations(disc, dir, openSign, Vec2d(18.5, d * 40))
                Check.ok(
                    pulled.first { $0.role == .deep }!.x > at(.deep).x,
                    "the deep shades toward a live deep threat")
                Check.ok(
                    abs(pulled.first { $0.role == .deep }!.x) <= 9 + 1e-9,
                    "but never further than 9 m off centre")
                // The deep never sets up further than 5 m past the goal line.
                let far = pb.zoneStations(Vec2d(0, d * 30), dir, openSign, nil)
                Check.ok(
                    d * far.first { $0.role == .deep }!.z <= gl + 5 + 1e-9,
                    "the deep never drops more than 5 m past the goal line")
            }
        }

        // "Wind is the classic trigger; a big late lead is the other one."
        Check.ok(
            Playbook.shouldPlayZone(20, 0, 0, 0), "a gale calls zone on its own")
        Check.ok(
            !Playbook.shouldPlayZone(0, 0, 0, 0), "a calm day with no lead does not")
        Check.ok(
            Playbook.shouldPlayZone(7, 3, 7, 0) && !Playbook.shouldPlayZone(7, 3, 6, 0),
            "the lead pull needs the game to be late as well as won")
        Check.ok(
            !Playbook.shouldPlayZone(7, 2, 7, 0),
            "and a two-point lead is not a big lead")
        Check.ok(
            Playbook.shouldPlayZone(0, 0, 0, 0.6) && !Playbook.shouldPlayZone(0, 0, 0, 0.5),
            "bias alone can call it, strictly above 0.5")

        // ---- maths -----------------------------------------------------------
        Check.bitEqViaJSON(Playbook.smoothstep(0, 1, -5), 0, "smoothstep is 0 below edge0")
        Check.bitEqViaJSON(Playbook.smoothstep(0, 1, 5), 1, "smoothstep is 1 above edge1")
        Check.ok(
            Playbook.smoothstep(0, 1, 0.6) > Playbook.smoothstep(0, 1, 0.4),
            "smoothstep rises between its edges")

        // JavaScript's `||` falls through on NaN as well as on +0 and -0, and the port
        // reproduces all three. The golden sampled the zeros but not NaN, so deleting
        // `|| span.isNaN` from the port changed nothing and all 20,419 assertions still
        // passed — a mutation test found that hole.
        //
        // It is observable, and not symmetrically. With `edge1` NaN the span is falsy, the
        // divide uses 1e-6, `t` saturates and the reference returns exactly 1. Drop the
        // NaN case and you get NaN instead, which then propagates into a cut target.
        // `edge0` NaN and `x` NaN really do give NaN in the reference, because the
        // numerator is NaN whatever the guard does — so those are asserted as NaN rather
        // than assumed to be symmetric.
        Check.bitEqViaJSON(
            Playbook.smoothstep(0, Double.nan, 0.5), 1,
            "a NaN upper edge takes the falsy branch and saturates, as in JavaScript")
        Check.ok(
            Playbook.smoothstep(Double.nan, 1, 0.5).isNaN,
            "a NaN lower edge still gives NaN — the numerator carries it")
        Check.ok(
            Playbook.smoothstep(0, 1, Double.nan).isNaN, "a NaN input still gives NaN")
        Check.bitEqViaJSON(Playbook.lerp(3, 9, 0), 3, "lerp at t=0 is a")
        Check.bitEqViaJSON(Playbook.lerp(3, 9, 1), 9, "lerp at t=1 is b")
        Check.bitEqViaJSON(Playbook.sigmoid(0), 0.5, "sigmoid(0) is one half")
        Check.ok(Playbook.sigmoid(2) > Playbook.sigmoid(1), "sigmoid rises with x")
        Check.ok(
            Playbook.sigmoid(1, 4) > Playbook.sigmoid(1, 1),
            "a steeper k saturates faster above zero")
        Check.bitEqViaJSON(Playbook.distSq2(3, 4, 0, 0), 25, "distSq2 is the square")
        nearUlp(Playbook.dist2(3, 4, 0, 0), 5, "dist2(3,4) is 5")
    }

    // MARK: - the pitch is threaded, not global

    /// The claim the port's doc comment makes: the pitch is a value, so the same
    /// playbook drawn on a different pitch produces different geometry.
    ///
    /// None of this is golden-backed and it cannot be — `Playbook.ts` has no way to
    /// express a second pitch. It is asserted by property instead, and it is the only
    /// thing in this file that would catch a port that quietly kept 18.5 as a constant.
    private static func minisPitch() {
        let minis = Playbook(field: .minis)

        Check.bitEqViaJSON(minis.field.sideline, 9, "the minis pitch is 9 m to the sideline")
        Check.bitEqViaJSON(
            minis.edgeMargin, pb.edgeMargin,
            "the coaching edge margin is not a dimension of the pitch, so it carries over")

        // `clampToField` uses the pitch it was given, not the regulation one.
        let far = Vec2d(100, 100)
        let mc = minis.clampToField(far)
        let rc = pb.clampToField(far)
        Check.bitEqViaJSON(mc.x, 9 - minis.edgeMargin, "minis clamps x to its own sideline")
        Check.bitEqViaJSON(mc.z, 18.5 - minis.edgeMargin, "minis clamps z to its own end line")
        Check.ok(mc.x < rc.x && mc.z < rc.z, "the two pitches do not clamp to the same box")

        // `yardsToGoal` and the endzone tests follow the pitch too.
        Check.bitEqViaJSON(minis.yardsToGoal(0, 1), 12.5, "minis goal line is 12.5 m out")
        Check.ok(minis.inAttackEndzone(13, 1), "13 m is inside the minis endzone")
        Check.ok(!pb.inAttackEndzone(13, 1), "and nowhere near the regulation one")

        // Every station of every set fits on the smaller pitch. This is the assertion
        // that fails outright if any dimension is still hardcoded.
        for name in [Playbook.FormationName.vertical, .horizontal, .side, .endzone] {
            for dir in [1, -1] {
                for openSign in [1, -1] {
                    for disc in [Vec2d(0, 0), Vec2d(8, -10), Vec2d(-8, 10)] {
                        for s in minis.formationStations(name, disc, dir, openSign) {
                            Check.ok(
                                abs(s.x) <= 9 - minis.edgeMargin + 1e-9,
                                "minis \(name.rawValue) stations fit between the sidelines")
                            Check.ok(
                                abs(s.z) <= 18.5 - minis.edgeMargin + 1e-9,
                                "minis \(name.rawValue) stations fit between the end lines")
                        }
                        for kind in [
                            Playbook.CutKind.under, .breakUnder, .deep, .strike, .upLine,
                            .dump, .swing,
                        ] {
                            let r = minis.buildCut(
                                kind, disc, disc, dir, openSign, openSign, 0.5)
                            Check.ok(
                                abs(r.target.x) <= 9 - minis.edgeMargin + 1e-9
                                    && abs(r.target.z) <= 18.5 - minis.edgeMargin + 1e-9,
                                "a minis \(kind.rawValue) stays on the minis pitch")
                        }
                        for s in minis.zoneStations(disc, dir, openSign, nil) {
                            Check.ok(
                                abs(s.x) <= 9 - minis.edgeMargin + 1e-9
                                    && abs(s.z) <= 18.5 - minis.edgeMargin + 1e-9,
                                "a minis zone shell stays on the minis pitch")
                        }
                    }
                }
            }
        }

        // The endzone call fires at a pitch-relative distance, not an absolute one.
        //
        // **This check used to assert the bug.** Its comment said "pitch-relative" and the
        // assertion under it said `chooseFormation` at the centre of the minis pitch
        // returns `.endzone` — which is exactly the symptom, not the property. 13 m is a
        // fifth of a regulation half and the whole of a minis one, so the minis game was
        // in its endzone set from the pull onwards; and since that set makes every player
        // a handler, nobody cut and the offence threw backwards for fifteen minutes. A
        // check that pins the broken behaviour is worse than no check, because it turns
        // the fix into a failure.
        let regulation = Playbook(field: .standard)
        Check.eq(
            regulation.chooseFormation(Vec2d(0, 0), 1, .vertical, 0, 1, false), .vertical,
            "at the centre of a regulation pitch the offence runs its base look")
        Check.eq(
            regulation.chooseFormation(Vec2d(0, 26), 1, .vertical, 0, 1, false), .endzone,
            "and calls the endzone set six metres out")
        Check.eq(
            minis.chooseFormation(Vec2d(0, 0), 1, .vertical, 0, 1, false), .vertical,
            "at the centre of a minis pitch it runs its base look too")
        Check.eq(
            minis.chooseFormation(Vec2d(0, 10), 1, .vertical, 0, 1, false), .endzone,
            "and calls the endzone set two and a half metres out — the same fraction "
                + "of a shorter pitch")
    }

    // MARK: - minis has a SHAPE, not only bounds

    /// **The properties `minisPitch()` above cannot express.** Issue #18.
    ///
    /// Every minis assertion in `minisPitch()` has the form `abs(s.x) <= 9 - edgeMargin`,
    /// and `clampToField` satisfies all of them unconditionally — it is the function that
    /// puts the point there. The bug they were written after is *in bounds*: the vertical
    /// stack spans `stackLead + 4 * stackSpacing` = 27.8 m, the minis end line is at 18.5,
    /// so the back of it clamped into the endzone and stood on itself — with the disc at
    /// the centre, three of the five cutter stations came back as the same point. Seven
    /// players, five distinct places to stand, every one of them between the lines. It
    /// would pass the suite written for it.
    ///
    /// Three shape properties are asserted here, and each is stated so that it holds at
    /// **both** formats — which is the only way a property about scaling can be checked at
    /// all. A bound that is true only on the pitch it was measured on is the metre literal
    /// this whole class of bug is made of; see
    /// `.agents/friction-log/20260810-every-shape-constant`.
    ///
    /// The fourth property in the issue — that `isDeepShot` ever fires in a minis match —
    /// needs a match, so it lives in `EngineTests.playAndMeasure`. It is also the one that
    /// found something: see `minisIsPlayable`.
    private static func minisShape() {
        let minis = Playbook(field: .minis)
        let formats: [(String, Playbook)] = [("sevens", pb), ("minis", minis)]
        let names: [Playbook.FormationName] = [.vertical, .horizontal, .side, .endzone]
        let dirs: [Dir] = [1, -1]
        let signs: [Playbook.Sign] = [1, -1]

        // ==== 1. THE STATIONS OF A SET ARE SEVEN DISTINCT POINTS ==================
        //
        // The sharp form first, on the exact shape the bug had: the five cutters of a
        // vertical stack at the centre of the pitch, which is where the minis game starts
        // every possession and where three of the five used to coincide. Every gap is one
        // `stackSpacing` scaled to the pitch — 4.2 m at sevens, 1.640625 m at minis.
        //
        // 1e-12 rather than `bitEq`: the gap is the difference of two independently rounded
        // sums, so it lands a couple of ulps either side of the product. That is nine orders
        // of magnitude below the metre this is protecting, and the failure it exists for
        // — a clamp swallowing a slot — moves a gap to zero, not to its last bit.
        for (label, p) in formats {
            let column = p.formationStations(.vertical, Vec2d(0, 0), 1, 1)
                .filter { $0.role == .cutter }
            Check.eq(column.count, 5, "\(label): the vertical set stands five cutters")
            let want = Playbook.PLAY.stackSpacing * p.depthScale
            for i in 1..<column.count {
                Check.near(
                    column[i].z - column[i - 1].z, want, 1e-12,
                    "\(label): vertical stack slot \(i) is one scaled stackSpacing behind "
                        + "slot \(i - 1)")
            }
            Check.ok(
                abs(column.last!.z) <= p.field.endLine - p.edgeMargin - 1e-9,
                "\(label): and the back of the stack is inside the end line without being "
                    + "clamped there (\(column.last!.z) m)")
        }

        // The general form: over every place the offence can hold the disc, the set it
        // would actually run there never puts two of its seven stations on the same spot.
        //
        // `chooseFormation` picks the set rather than the loop, deliberately. A vertical
        // stack asked for with the disc 0.8 goal lines out really does clamp its back two
        // cutters together, on either pitch — but no offence stands in a vertical stack
        // there, because `chooseFormation` has been in its endzone set since 13 m (scaled)
        // from the line, and asserting on a set nobody calls would be asserting on nothing.
        //
        // **THE DOMAIN RUNS FROM THE OFFENCE'S OWN END LINE TO THE GOAL LINE IT ATTACKS,
        // and both ends of that are a decision.** Issue #29.
        //
        // It used to stop at the offence's own goal line, and that cost the assertion the
        // bug it was built to catch. The pin floor in `formationStations` was applied to
        // every station rather than to the backfield, so once the disc was more than a
        // stack lead BEHIND the offence's own line the floor dragged the front of the
        // stack onto one z: the side set's front two cutters were at distance exactly 0
        // from z = -43.2 at sevens and z = -16.875 at minis, and the vertical set's from
        // -45.2 and -17.65625. The ho set collapsed a HANDLER onto a cutter, also exactly,
        // where the fixed handler row crossed the disc-relative cutter row — disc
        // (-5.5, -45) at sevens. All of it in bounds; all of it two goal lines outside the
        // sweep. A disc behind your own goal line is not an edge case — it is where a
        // caught pull starts, which is why `TeamAIGoldens`' live segment begins two metres
        // off that line.
        //
        // The far end stays at the attacking goal line because a held disc past it is a
        // goal, so no offence sets up there. Which is just as well: the endzone set really
        // does put its middle handler on its inner cutter deep in that endzone (0.08 m at
        // sevens with the disc at z = 48.32, 0.027 m at minis), and that one is
        // `clampToField` squeezing `ez` against `a.z - dir * 6.5`, not the floor. Widening
        // this end would assert on a position the rules do not allow to exist.
        //
        // The floor was 0.75 m — a body, not an epsilon — while `formationStations` stood
        // a floored handler in front of the disc rather than at the line (`2 * a.z - z`,
        // #29's second commit). That reading is retired by issue #35: the mirror only
        // reached the floor when the disc was within a handler's own offset of it
        // (about 6.5 m), so beyond that it quietly stood the reset up to 6.5 m into the
        // offence's own endzone — measured on the fixed sevens match `tools/test-
        // game.ts` plays, 0.88 turnovers a point with a plain floor became 3.17 with the
        // mirror, and it is the mirror that is wrong, not the plain floor. See
        // `formationStations` for the fix and the full measurement.
        //
        // A plain floor reopens the coincidence #29 closed: the ho set's handler and its
        // cutter row (`a.z + dir * 15`, disc-relative) can land at the same z, and here —
        // unlike the row-on-row collapse #29's FIRST commit fixed by role — the two
        // stations belong to DIFFERENT rows with no shared anchor to slide, so there is
        // no `rowShift`-shaped fix available without either resurrecting the mirror (and
        // its 3.17 turnovers a point) or nudging the cutter row too (untested, and out of
        // scope for #35). Measured with the plain floor, over this exact widened domain:
        // 0.1300 m at sevens (horizontal, disc (-0.30, -1.403) of the pitch = z -44.88)
        // and 0.0528 m at minis (disc (-0.30, -1.410) = z -17.625) — both real, both a
        // handler's own body away from the exact-zero collapse this test exists to catch,
        // and both confined to a disc position deeper in the offence's own endzone than a
        // handler's own reset offset, which needs a caught pull to reach at all.
        //
        // The bound below is set under both those measurements rather than at a body,
        // with the gap they leave as the margin: a REAL future collapse (two stations at
        // the same point, distance 0) still fails loudly, and so does any regression that
        // pushes this specific near-miss materially worse (say, past a few centimetres).
        // What it no longer catches is the exact centimetre-scale value measured today,
        // which is knowingly accepted here rather than re-derived by a mirror that traded
        // it for a metre-scale turnover-rate bug. Over the widened domain apart from this
        // one mechanism the worst case is still 4.2000 m at sevens (one `stackSpacing`,
        // the design gap between two slots of a side stack, disc on its own end line) and
        // 1.0063 m at minis (the back of a vertical stack one step short of the endzone
        // call) — both comfortably inside a body, and both unaffected by this bound.
        let bodyWidth = 0.04
        for (label, p) in formats {
            var worst = Double.infinity
            var worstWhere = ""
            // Attack-relative, in goal lines: -1 is the offence's own goal line and +1 the
            // one it attacks, so `-endLine / goalLine` is its own end line on either pitch
            // — 1.5625 goal lines back at sevens, 1.48 at minis. The two are not the same
            // number, which is the point: the pitches are not similar rectangles, and the
            // domain has to be named off each pitch's own dimensions rather than off a
            // fraction measured on one of them.
            let ownEndLine = -p.field.endLine / p.field.goalLine
            for prefer in [Playbook.FormationName.vertical, .horizontal, .side] {
                for wind in [0.0, 9.0] {
                    for dir in dirs {
                        for openSign in signs {
                            for fx in stride(from: -1.0, through: 1.0, by: 0.05) {
                                for fz in stride(from: ownEndLine, through: 1.0, by: 0.01) {
                                    let a = Vec2d(
                                        fx * p.field.sideline,
                                        Double(dir) * fz * p.field.goalLine)
                                    let name = p.chooseFormation(
                                        a, dir, prefer, wind, openSign, false)
                                    let st = p.formationStations(name, a, dir, openSign)
                                    for i in 0..<st.count {
                                        for j in (i + 1)..<st.count {
                                            let d = Foundation.hypot(
                                                st[i].x - st[j].x, st[i].z - st[j].z)
                                            if d < worst {
                                                worst = d
                                                worstWhere =
                                                    "\(name.rawValue) dir \(dir) "
                                                    + "open \(openSign) wind \(wind) "
                                                    + "disc "
                                                    + String(format: "(%.2f, %.3f)", fx, fz)
                                                    + " of the pitch = z "
                                                    + String(format: "%.4f", a.z)
                                                    + ", stations \(i)/\(j)"
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Check.ok(
                worst >= bodyWidth,
                "\(label): no two stations of the set the offence would actually run stand "
                    + "inside a body of each other, anywhere from its own end line to the "
                    + "goal line it attacks — closest was "
                    + String(format: "%.4f", worst) + " m at \(worstWhere)")
        }

        // ==== 2. A FORMATION IS THE SAME FRACTION OF THE PITCH AT BOTH FORMATS =====
        //
        // The property `depthScale` exists to produce, stated as `EngineSeamTests` states
        // the pull's: put the disc at the same fractional point on each pitch and the set's
        // downfield extents — how far in front of the disc its front station stands, how
        // far behind its deepest handler sits, and the span between them — must come out as
        // the same fraction of the goal line. A single unscaled metre literal anywhere in
        // `formationStations` breaks this, and no in-bounds check can see it.
        //
        // The tolerance is 1e-12 rather than a percentage because the claim is not "close":
        // `depthScale` is a ratio of two field numbers, so every offset is the regulation
        // one times an exact factor and the two fractions agree to the last few bits.
        // Measured worst over the whole sweep: 4.4e-16.
        //
        // **The domain stops at 0.53 goal lines, and that is a finding rather than a
        // convenience.** The two pitches are not similar rectangles: the minis end line is
        // 1.48 goal lines out where the regulation one is 1.5625, so the 0.869-goal-line
        // vertical stack runs out of endzone to stand in earlier on the small pitch. Beyond
        // 0.5393 goal lines `clampToField` starts taking the back of the minis stack and
        // the fractions part company — 7.5e-4 at 0.540, 5.1e-2 by the endzone call at
        // 0.59375, and 1.264e-01 at worst over the whole pitch. That is the same shortfall
        // the assertion above measures as 1.01 m, seen from the other side.
        let sameFractionTo = 0.53
        for name in names {
            for dir in dirs {
                for openSign in signs {
                    var worst = 0.0
                    var worstWhere = ""
                    for fx in stride(from: -1.0, through: 1.0, by: 0.1) {
                        for fz in stride(from: -1.0, through: sameFractionTo, by: 0.005) {
                            let big = downfieldFractions(pb, name, fx, fz, dir, openSign)
                            let small = downfieldFractions(minis, name, fx, fz, dir, openSign)
                            let d = Swift.max(
                                abs(big.front - small.front),
                                Swift.max(
                                    abs(big.back - small.back), abs(big.span - small.span)))
                            if d > worst {
                                worst = d
                                worstWhere =
                                    "disc " + String(format: "(%.2f, %.3f)", fx, fz)
                                    + " of the pitch — sevens front "
                                    + String(format: "%.6f", big.front) + " back "
                                    + String(format: "%.6f", big.back) + ", minis front "
                                    + String(format: "%.6f", small.front) + " back "
                                    + String(format: "%.6f", small.back)
                            }
                        }
                    }
                    Check.ok(
                        worst <= 1e-12,
                        "the \(name.rawValue) set occupies the same fraction of the pitch at "
                            + "both formats (dir \(dir), open \(openSign)): worst deviation "
                            + String(format: "%.3e", worst) + " at \(worstWhere)")
                }
            }
        }

        // ==== 3. ALL SIX LANES ARE REACHABLE AT BOTH FORMATS ======================
        //
        // `laneOf`'s under/deep boundary was a flat 16 m, which is further than the minis
        // disc is from the back of the endzone — so every cut classified as an under, both
        // deep lanes were unreachable, and `liveLanes` became a two-lane table that
        // collided cuts nowhere near each other. A lane is the piece of field a cut
        // consumes, and a six-lane vocabulary collapsed to two is an offence that will not
        // let two people run at once.
        //
        // Reachability is asserted three ways, weakest to strongest: somewhere on the
        // pitch, from every disc position the open field offers, and by the cut vocabulary
        // `buildCut` can actually build.
        let allLanes = Set(Playbook.ALL_LANES.map(\.rawValue))
        Check.eq(allLanes.count, 6, "there are six lanes to reach")

        for (label, p) in formats {
            var union: Set<String> = []
            var worstFromOneDisc = Int.max
            var worstWhere = ""
            for dir in dirs {
                for openSign in signs {
                    // The disc a stride inside the coaching band and in the open field —
                    // on the sideline itself there is no break side to reach, and past the
                    // endzone call the deep game is over on either pitch.
                    for fx in [-0.8, -0.4, 0.0, 0.4, 0.8] {
                        for fz in [-1.0, -0.5, 0.0, 0.3, 0.59] {
                            let disc = Vec2d(
                                fx * p.field.sideline, Double(dir) * fz * p.field.goalLine)
                            var seen: Set<String> = []
                            for gx in stride(from: -1.0, through: 1.0, by: 0.05) {
                                for gz in stride(from: -1.0, through: 1.0, by: 0.02) {
                                    let q = p.clampToField(
                                        Vec2d(gx * p.field.sideline, gz * p.field.endLine))
                                    seen.insert(p.laneOf(q.x, q.z, disc, dir, openSign).rawValue)
                                }
                            }
                            union.formUnion(seen)
                            if seen.count < worstFromOneDisc {
                                worstFromOneDisc = seen.count
                                worstWhere =
                                    "dir \(dir) open \(openSign) disc "
                                    + String(format: "(%.2f, %.2f)", fx, fz)
                                    + " of the pitch reached \(seen.sorted())"
                            }
                        }
                    }
                }
            }
            for lane in Playbook.ALL_LANES {
                Check.ok(
                    union.contains(lane.rawValue),
                    "\(label): the \(lane.rawValue) lane is somewhere on the pitch")
            }
            Check.eq(
                worstFromOneDisc, 6,
                "\(label): every one of the six lanes is reachable from every open-field "
                    + "disc position — \(worstWhere)")

            // And the offence can build a cut into each of them. `laneOf` classifying a
            // corner of the pitch as `break-deep` is worth nothing if no route the playbook
            // knows how to draw ever lands there.
            var built: Set<String> = []
            for dir in dirs {
                for openSign in signs {
                    for side in signs {
                        for fx in [-0.8, -0.4, 0.0, 0.4, 0.8] {
                            for fz in [-1.0, -0.5, 0.0, 0.3, 0.59] {
                                let disc = Vec2d(
                                    fx * p.field.sideline, Double(dir) * fz * p.field.goalLine)
                                for kind in [
                                    Playbook.CutKind.under, .breakUnder, .deep, .strike,
                                    .upLine, .dump, .swing,
                                ] {
                                    for j in [0.0, 0.5, 1.0] {
                                        for ahead in [-0.2, 0.3, 0.8] {
                                            let from = p.clampToField(
                                                Vec2d(
                                                    disc.x,
                                                    disc.z + Double(dir) * ahead
                                                        * p.field.goalLine))
                                            built.insert(
                                                p.buildCut(
                                                    kind, from, disc, dir, openSign, side, j
                                                ).lane.rawValue)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            for lane in Playbook.ALL_LANES {
                Check.ok(
                    built.contains(lane.rawValue),
                    "\(label): the cut vocabulary can build a route into the "
                        + "\(lane.rawValue) lane")
            }
        }
    }

    /// A formation's downfield extents relative to the disc, as fractions of the goal line.
    ///
    /// `fz` is ATTACK-RELATIVE — `dir * fz * goalLine` — so the same `fz` names the same
    /// point of the same pitch whichever way the team is going, which is what makes the two
    /// formats comparable at all.
    private struct DownfieldFractions {
        let front: Double
        let back: Double
        let span: Double
    }

    private static func downfieldFractions(
        _ p: Playbook, _ name: Playbook.FormationName, _ fx: Double, _ fz: Double,
        _ dir: Dir, _ openSign: Playbook.Sign
    ) -> DownfieldFractions {
        let a = Vec2d(fx * p.field.sideline, Double(dir) * fz * p.field.goalLine)
        let rel = p.formationStations(name, a, dir, openSign).map {
            Double(dir) * ($0.z - a.z)
        }
        let front = (rel.max() ?? 0) / p.field.goalLine
        let back = (rel.min() ?? 0) / p.field.goalLine
        return DownfieldFractions(front: front, back: back, span: front - back)
    }

    // MARK: - helpers

    /// An ulp-relative envelope, for the `hypot`/`exp` results only.
    private static func nearUlp(_ got: Double, _ want: Double, _ what: String) {
        let d = abs(got - want)
        let unit = want == 0 ? Double.ulpOfOne : want.ulp
        let tol = ULPS * unit
        Check.ok(d <= tol, "\(what): off by \(d) (\(d / unit) ulp; got \(got), want \(want))")
    }
}
