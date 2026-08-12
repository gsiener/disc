import Foundation
import UltimateSim

/// Rules primitives, against fixtures dumped from `src/sim/Rules.ts`.
///
/// Almost everything ported here is pure arithmetic — compare, add, multiply, divide,
/// sqrt, floor — so it is asserted **bit-exact** via `Check.bitEqViaJSON`. Nothing in
/// this file calls a transcendental function, so there is no tolerance anywhere below:
/// a mismatch is always a transcription bug, never platform rounding.
enum RulesTests {

    // MARK: - JSON shapes

    struct PointDTO: Decodable {
        let x: Double
        let y: Double
        let z: Double
        var vec: Vec3d { Vec3d(x, y, z) }
    }

    struct ActorDTO: Decodable {
        let id: Int
        let pos: PointDTO
    }

    struct CrossingDTO: Decodable {
        let point: PointDTO
        let edge: String
        let t: Double
    }

    struct MakeRulesOverride: Decodable { let want: RuleSet }

    struct V3Case: Decodable { let args: [Double]; let want: PointDTO }
    struct CopyCase: Decodable { let input: PointDTO; let want: PointDTO }
    struct DistXZCase: Decodable { let a: PointDTO; let b: PointDTO; let want: Double }
    struct IsInBoundsCase: Decodable { let p: PointDTO; let want: Bool }
    struct EndzoneOfCase: Decodable { let z: Double; let want: Int }
    struct IsInEndzoneCase: Decodable { let p: PointDTO; let dir: Int; let want: Bool }
    struct GoalLineZCase: Decodable { let dir: Int; let want: Double }
    struct BrickMarkCase: Decodable { let dir: Int; let want: PointDTO }
    struct ClampCase: Decodable { let p: PointDTO; let want: PointDTO }
    struct BoundaryCrossingCase: Decodable { let a: PointDTO; let b: PointDTO; let want: CrossingDTO? }
    struct PutIntoPlaySpotCase: Decodable {
        let spot: PointDTO; let attackDir: Int; let rules: RuleSet; let want: PointDTO
    }
    struct StallCountForCase: Decodable { let elapsed: Double; let rules: RuleSet; let want: Int }
    struct StallElapsedForCase: Decodable { let count: Int; let rules: RuleSet; let want: Double }
    struct ResumeStallCountCase: Decodable { let count: Int; let rules: RuleSet; let want: Int }
    struct DoubleTeamOffenderCase: Decodable {
        let label: String
        let pivot: PointDTO
        let markerId: Int?
        let defenders: [ActorDTO]
        let offence: [ActorDTO]
        let throwerId: Int?
        let rules: RuleSet
        let want: Int?
    }
    struct MarkerStatusCase: Decodable {
        let markerPos: PointDTO?; let throwerPos: PointDTO; let rules: RuleSet; let want: String
    }
    struct IsTravelCase: Decodable { let pivot: PointDTO; let foot: PointDTO; let rules: RuleSet; let want: Bool }
    struct EffectiveTargetCase: Decodable { let score: [Int]; let rules: RuleSet; let cap: String; let want: Int }
    struct IsGameOverCase: Decodable {
        let score: [Int]; let target: Int; let rules: RuleSet; let cap: String; let want: Bool
    }
    /// A body as `Rules.ContactBody` needs it, straight out of the fixture.
    struct BodyDTO: Decodable, ContactBody {
        let id: Int
        private let posDTO: PointDTO
        private let velDTO: PointDTO
        let radius: Double
        var pos: Vec3d { posDTO.vec }
        var vel: Vec3d { velDTO.vec }
        enum CodingKeys: String, CodingKey {
            case id
            case posDTO = "pos"
            case velDTO = "vel"
            case radius
        }
    }
    struct ContactWant: Decodable {
        let dist: Double
        let touching: Bool
        let impact: Double
        let aggressorId: Int
    }
    struct ContactCase: Decodable { let a: BodyDTO; let b: BodyDTO; let want: ContactWant }
    struct MarkingFoulCase: Decodable {
        let marker: BodyDTO; let thrower: BodyDTO; let age: Double; let want: Double
    }
    struct PickWorthCase: Decodable { let lost: Double; let gained: Double; let want: Bool }
    struct ObstructionCase: Decodable {
        let defender: BodyDTO
        let offence: [BodyDTO]
        let thrower: Int?
        let matchup: Int?
        let want: Int?
    }
    struct CatchContactWant: Decodable { let kind: String; let impact: Double }
    struct CatchContactCase: Decodable {
        let impact: Double
        let played: Bool
        let established: Bool
        let want: CatchContactWant?
    }
    struct CallDoubtCase: Decodable {
        let impact: Double
        let threshold: Double
        let playedDisc: Bool
        let plainToSee: Bool
        let decision: Double
        let doubt: Double
        let contested: Bool
    }

    struct FlipDirCase: Decodable { let d: Int; let want: Int }
    struct OtherTeamCase: Decodable { let t: Int; let want: Int }

    struct File: Decodable {
        let field: FieldConstants
        let cones: [PointDTO]
        let yardsPerMetre: Double
        let defaultRules: RuleSet
        let makeRulesOverride: MakeRulesOverride
        let makeRulesNoOverride: RuleSet

        let v3Cases: [V3Case]
        let copyCase: CopyCase

        let distXZCases: [DistXZCase]
        let isInBoundsCases: [IsInBoundsCase]
        let endzoneOfCases: [EndzoneOfCase]
        let isInEndzoneCases: [IsInEndzoneCase]
        let isGoalCases: [IsInEndzoneCase]
        let goalLineZCases: [GoalLineZCase]
        let brickMarkCases: [BrickMarkCase]
        let clampToFieldCases: [ClampCase]
        let boundaryCrossingCases: [BoundaryCrossingCase]
        let putIntoPlaySpotCases: [PutIntoPlaySpotCase]

        let stallCountForCases: [StallCountForCase]
        let stallElapsedForCases: [StallElapsedForCase]
        let resumeStallCountCases: [ResumeStallCountCase]
        let doubleTeamOffenderCases: [DoubleTeamOffenderCase]
        let markerStatusCases: [MarkerStatusCase]
        let isTravelCases: [IsTravelCase]

        let markFoulImpact: Double
        let markSetTime: Double
        let markSettledSpeed: Double
        let pickSpeedLoss: Double
        let pickGapGain: Double
        let catchFoulImpact: Double
        let catchContactWindow: Double
        let callSeveritySpan: Double
        let contactCases: [ContactCase]
        let markingFoulCases: [MarkingFoulCase]
        let pickWorthCases: [PickWorthCase]
        let obstructionCases: [ObstructionCase]
        let catchContactCases: [CatchContactCase]
        let callDoubtCases: [CallDoubtCase]

        let effectiveTargetCases: [EffectiveTargetCase]
        let isGameOverCases: [IsGameOverCase]
        let flipDirCases: [FlipDirCase]
        let otherTeamCases: [OtherTeamCase]
    }

    static func run() throws {
        let g = try Goldens.load(File.self, "rules")

        Check.eq(FieldConstants.standard, g.field, "FIELD matches the reference constants")
        Check.bitEqViaJSON(YARDS_PER_METRE, g.yardsPerMetre, "YARDS_PER_METRE")
        Check.eq(DEFAULT_RULES, g.defaultRules, "DEFAULT_RULES matches the reference")
        Check.eq(makeRules(), g.makeRulesNoOverride, "makeRules() with no overrides is DEFAULT_RULES")
        Check.eq(
            makeRules { r in
                r.stallMax = 6
                r.gameTo = 21
            }, g.makeRulesOverride.want, "makeRules(over) merges onto DEFAULT_RULES")

        // The `rules` fixture comes from `src/sim/Rules.ts`, whose geometry is
        // regulation and unparameterised. So the differential replay names the pitch it
        // is replaying: `.standard`. The port's own geometry is `FieldConstants`', and
        // the minis half of it is asserted by `minisShape()` — see #45, ADR-0004.
        let field = FieldConstants.standard

        for c in g.cones.enumerated() {
            expectVec(FieldConstants.standard.cones[c.offset], c.element, "cone \(c.offset)")
        }

        for (i, c) in g.v3Cases.enumerated() {
            let args = c.args + Array(repeating: 0.0, count: max(0, 3 - c.args.count))
            expectVec(v3(args[0], args[1], args[2]), c.want, "v3 case \(i)")
        }
        expectVec(copy(g.copyCase.input.vec), g.copyCase.want, "copy")

        for (i, c) in g.distXZCases.enumerated() {
            Check.bitEqViaJSON(distXZ(c.a.vec, c.b.vec), c.want, "distXZ case \(i)")
        }
        for (i, c) in g.isInBoundsCases.enumerated() {
            Check.eq(field.isInBounds(c.p.vec), c.want, "isInBounds case \(i)")
        }
        for (i, c) in g.endzoneOfCases.enumerated() {
            Check.eq(field.endzoneOf(c.z), c.want, "endzoneOf case \(i)")
        }
        for (i, c) in g.isInEndzoneCases.enumerated() {
            Check.eq(field.isInEndzone(c.p.vec, c.dir), c.want, "isInEndzone case \(i)")
        }
        for (i, c) in g.isGoalCases.enumerated() {
            Check.eq(field.isGoal(c.p.vec, c.dir), c.want, "isGoal case \(i)")
        }
        for (i, c) in g.goalLineZCases.enumerated() {
            Check.bitEqViaJSON(field.goalLineZ(c.dir), c.want, "goalLineZ case \(i)")
        }
        for (i, c) in g.brickMarkCases.enumerated() {
            expectVec(field.brickMark(c.dir), c.want, "brickMark case \(i)")
        }
        for (i, c) in g.clampToFieldCases.enumerated() {
            expectVec(field.clampToField(c.p.vec), c.want, "clampToField case \(i)")
        }
        for (i, c) in g.boundaryCrossingCases.enumerated() {
            let got = field.boundaryCrossing(c.a.vec, c.b.vec)
            switch (got, c.want) {
            case (nil, nil):
                Check.ok(true, "boundaryCrossing case \(i) is nil")
            case (nil, .some):
                Check.ok(false, "boundaryCrossing case \(i) — got nil, want a crossing")
            case (.some, nil):
                Check.ok(false, "boundaryCrossing case \(i) — got a crossing, want nil")
            case let (.some(got), .some(want)):
                expectVec(got.point, want.point, "boundaryCrossing case \(i) point")
                Check.eq(got.edge.rawValue, want.edge, "boundaryCrossing case \(i) edge")
                Check.bitEqViaJSON(got.t, want.t, "boundaryCrossing case \(i) t")
            }
        }
        for (i, c) in g.putIntoPlaySpotCases.enumerated() {
            expectVec(field.putIntoPlaySpot(c.spot.vec, c.attackDir, c.rules), c.want, "putIntoPlaySpot case \(i)")
        }

        for (i, c) in g.stallCountForCases.enumerated() {
            Check.eq(stallCountFor(c.elapsed, c.rules), c.want, "stallCountFor case \(i)")
        }
        for (i, c) in g.stallElapsedForCases.enumerated() {
            Check.bitEqViaJSON(stallElapsedFor(c.count, c.rules), c.want, "stallElapsedFor case \(i)")
        }
        for (i, c) in g.resumeStallCountCases.enumerated() {
            Check.eq(resumeStallCount(c.count, c.rules), c.want, "resumeStallCount case \(i)")
        }
        for c in g.doubleTeamOffenderCases {
            let defenders = c.defenders.map { RulesActor(id: $0.id, pos: $0.pos.vec) }
            let offence = c.offence.map { RulesActor(id: $0.id, pos: $0.pos.vec) }
            let got = doubleTeamOffender(c.pivot.vec, c.markerId, defenders, offence, c.throwerId, c.rules)
            Check.eq(got, c.want, "doubleTeamOffender: \(c.label)")
        }
        for (i, c) in g.markerStatusCases.enumerated() {
            let got = markerStatus(c.markerPos?.vec, c.throwerPos.vec, c.rules)
            Check.eq(got.rawValue, c.want, "markerStatus case \(i)")
        }
        for (i, c) in g.isTravelCases.enumerated() {
            Check.eq(isTravel(c.pivot.vec, c.foot.vec, c.rules), c.want, "isTravel case \(i)")
        }

        // --- contact and the self-officiated calls
        //
        // Every threshold below is sampled from both sides in the fixture, and every
        // number is compare-and-arithmetic, so all of it is asserted bit-exact.
        Check.bitEqViaJSON(MARK_FOUL_IMPACT, g.markFoulImpact, "MARK_FOUL_IMPACT")
        Check.bitEqViaJSON(MARK_SET_TIME, g.markSetTime, "MARK_SET_TIME")
        Check.bitEqViaJSON(MARK_SETTLED_SPEED, g.markSettledSpeed, "MARK_SETTLED_SPEED")
        Check.bitEqViaJSON(PICK_SPEED_LOSS, g.pickSpeedLoss, "PICK_SPEED_LOSS")
        Check.bitEqViaJSON(PICK_GAP_GAIN, g.pickGapGain, "PICK_GAP_GAIN")
        Check.bitEqViaJSON(CATCH_FOUL_IMPACT, g.catchFoulImpact, "CATCH_FOUL_IMPACT")
        Check.bitEqViaJSON(CATCH_CONTACT_WINDOW, g.catchContactWindow, "CATCH_CONTACT_WINDOW")
        Check.bitEqViaJSON(CALL_SEVERITY_SPAN, g.callSeveritySpan, "CALL_SEVERITY_SPAN")

        for (i, c) in g.contactCases.enumerated() {
            let got = contactBetween(c.a, c.b)
            Check.bitEqViaJSON(got.dist, c.want.dist, "contactBetween case \(i) dist")
            Check.eq(got.touching, c.want.touching, "contactBetween case \(i) touching")
            Check.bitEqViaJSON(got.impact, c.want.impact, "contactBetween case \(i) impact")
            Check.eq(got.aggressorId, c.want.aggressorId, "contactBetween case \(i) aggressor")
        }
        for (i, c) in g.markingFoulCases.enumerated() {
            Check.bitEqViaJSON(
                markingFoulImpact(c.marker, c.thrower, c.age), c.want,
                "markingFoulImpact case \(i)")
        }
        for (i, c) in g.pickWorthCases.enumerated() {
            Check.eq(
                pickIsWorthCalling(lostSpeed: c.lost, gainedGap: c.gained), c.want,
                "pickIsWorthCalling case \(i)")
        }
        for (i, c) in g.obstructionCases.enumerated() {
            let got = obstructionOf(c.defender, c.offence, c.thrower, c.matchup)
            Check.eq(got, c.want, "obstructionOf case \(i)")
        }
        for (i, c) in g.catchContactCases.enumerated() {
            let got = catchContactCall(
                impact: c.impact, defenderPlayedDisc: c.played,
                possessionEstablished: c.established)
            Check.eq(got?.kind.rawValue, c.want?.kind, "catchContactCall case \(i) kind")
            Check.bitEqViaJSON(
                got?.impact ?? 0, c.want?.impact ?? 0, "catchContactCall case \(i) impact")
        }
        for (i, c) in g.callDoubtCases.enumerated() {
            let s = CallSituation(
                impact: c.impact, threshold: c.threshold, playedDisc: c.playedDisc,
                plainToSee: c.plainToSee, decision: c.decision)
            Check.bitEqViaJSON(callDoubt(s), c.doubt, "callDoubt case \(i)")
            Check.eq(callContested(s), c.contested, "callContested case \(i)")
        }

        for (i, c) in g.effectiveTargetCases.enumerated() {
            let cap = CapState(rawValue: c.cap)!
            Check.eq(
                effectiveTarget((c.score[0], c.score[1]), c.rules, cap), c.want,
                "effectiveTarget case \(i)")
        }
        for (i, c) in g.isGameOverCases.enumerated() {
            let cap = CapState(rawValue: c.cap)!
            Check.eq(
                isGameOver((c.score[0], c.score[1]), c.target, c.rules, cap), c.want,
                "isGameOver case \(i)")
        }
        for (i, c) in g.flipDirCases.enumerated() {
            Check.eq(flipDir(c.d), c.want, "flipDir case \(i)")
        }
        for (i, c) in g.otherTeamCases.enumerated() {
            Check.eq(otherTeam(c.t), c.want, "otherTeam case \(i)")
        }

        properties()
    }

    private static func expectVec(_ got: Vec3d, _ want: PointDTO, _ what: String) {
        Check.bitEqViaJSON(got.x, want.x, "\(what).x")
        Check.bitEqViaJSON(got.y, want.y, "\(what).y")
        Check.bitEqViaJSON(got.z, want.z, "\(what).z")
    }

    /// Properties that encode what the rules *mean*, and would survive a retune of the
    /// numbers above — the kind of thing a golden sweep alone would not catch if both
    /// the reference and the port made the same sign error.
    private static func properties() {
        // The field's own arithmetic identity: LENGTH = CENTRAL_LENGTH + 2*ENDZONE_DEPTH.
        //
        // Asserted on every format, not just regulation. It used to read the `FIELD`
        // global and so could only ever describe the regulation pitch — and a shape
        // property that holds at one format is exactly what ADR-0004 says is not a shape
        // property. Minis is the default game mode; it gets the same identity.
        for (name, field) in [("sevens", FieldConstants.standard), ("minis", FieldConstants.minis)] {
            Check.bitEq(
                field.length, field.centralLength + 2 * field.endzoneDepth,
                "\(name): field length is central length plus both endzones")
            Check.bitEq(
                field.endLine, field.goalLine + field.endzoneDepth,
                "\(name): the end line is one endzone beyond the goal line")
            Check.bitEq(
                field.brickZ, field.goalLine - field.brickIn,
                "\(name): the brick mark sits BRICK_IN in from the goal line")
        }

        // USAU 16.G double-team radius is ten feet, not a round number of metres.
        Check.bitEq(DEFAULT_RULES.doubleTeamRange, 3.048, "double-team radius is 10 ft = 3.048 m")
        Check.bitEq(DEFAULT_RULES.discSpace, 0.274, "disc space is one disc diameter")

        // A defender guarding his own matchup nearby is not a double team, however close
        // he is to the pivot — the exception is the whole point of 16.G, not an edge case.
        let pivot = Vec3d(0, 0, 0)
        let closeButGuarding = doubleTeamOffender(
            pivot, 1,
            [RulesActor(id: 1, pos: Vec3d(0.05, 0, 0)), RulesActor(id: 2, pos: Vec3d(0.01, 0, 0))],
            [RulesActor(id: 10, pos: Vec3d(5, 0, 0)), RulesActor(id: 11, pos: Vec3d(0.01, 0, 0.01))],
            10, DEFAULT_RULES)
        Check.ok(closeButGuarding == nil, "a defender guarding a nearby cutter is not a double team")

        // The marker is never the double-team offender, no matter how close he stands.
        let markerAtZero = doubleTeamOffender(
            pivot, 1, [RulesActor(id: 1, pos: pivot)], [RulesActor(id: 10, pos: pivot)], 10, DEFAULT_RULES)
        Check.ok(markerAtZero == nil, "the marker himself is excluded from the double-team check")

        // Stalling out takes exactly stallMax seconds at the default one-count-per-second
        // interval, and the count never exceeds it no matter how long marking continues.
        Check.eq(
            stallCountFor(Double(DEFAULT_RULES.stallMax) * DEFAULT_RULES.stallInterval, DEFAULT_RULES),
            DEFAULT_RULES.stallMax, "stall reaches stallMax exactly at stallMax seconds")
        Check.eq(
            stallCountFor(1000, DEFAULT_RULES), DEFAULT_RULES.stallMax,
            "stall count never exceeds stallMax")

        // A resumed count is always higher than what was reached, up to the cap — the
        // point of WFDF 18.4 is that a stoppage costs the offence a count, not a reset.
        for reached in 0...12 {
            let resumed = resumeStallCount(reached, DEFAULT_RULES)
            Check.ok(
                resumed >= min(reached + 1, DEFAULT_RULES.stallResumeCap),
                "resume count at least reached+1 up to the cap, from \(reached)")
            Check.ok(resumed <= DEFAULT_RULES.stallResumeCap, "resume count never exceeds the cap, from \(reached)")
        }

        // flipDir / otherTeam are involutions: applying twice is the identity.
        for d in [1, -1] {
            Check.eq(flipDir(flipDir(d)), d, "flipDir is its own inverse, from \(d)")
        }
        for t in [0, 1] {
            Check.eq(otherTeam(otherTeam(t)), t, "otherTeam is its own inverse, from \(t)")
        }

        // The point cap is an absolute ceiling: once either team is there with any lead,
        // the game is over regardless of what cap state or target says otherwise.
        Check.ok(
            isGameOver((DEFAULT_RULES.pointCap, DEFAULT_RULES.pointCap - 1), 5, DEFAULT_RULES, .none),
            "point cap ends the game even against a stale target")

        // Walking out of the defending endzone and carrying out of the attacking endzone
        // move the pivot to opposite goal lines for the same attack direction.
        let deep = FieldConstants.standard.putIntoPlaySpot(Vec3d(3, 0, 40), 1, DEFAULT_RULES) // attacking endzone at +z
        let shallow = FieldConstants.standard.putIntoPlaySpot(Vec3d(3, 0, -40), 1, DEFAULT_RULES) // defending endzone at -z
        Check.bitEq(deep.z, FieldConstants.standard.goalLine, "carry from the attacking endzone stops at its own goal line")
        Check.bitEq(shallow.z, -FieldConstants.standard.goalLine, "walk from the defending endzone stops at its own goal line")
    }
}
