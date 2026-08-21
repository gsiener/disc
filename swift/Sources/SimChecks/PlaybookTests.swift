import Foundation
import UltimateSim

/// The playbook port, checked against its own claims rather than a recorded fixture.
///
/// # Method
///
/// `Playbook.swift` is almost entirely `+ - * / min max abs clamp` on doubles, all of
/// which IEEE 754 makes correctly rounded. So most of what follows is asserted against
/// `Model` — a second, independently typed implementation of every formula, written
/// from `Playbook.swift`'s own doc comments and literal constants rather than
/// transcribed from the functions under test. Model's constants are hand-typed
/// literals, not references to `Playbook.PLAY` or the module's own internal bands —
/// reading the module's own constant would make a mutation of that constant invisible,
/// since both sides would move together. Two spots go through a transcendental
/// function with no ulp guarantee (`dist2`/`markPoint` through `hypot` vs `sqrt`,
/// `sigmoid` through `exp` vs `tanh`) and those, plus every other Model comparison, get
/// a small absolute tolerance (`nearEq`, 1e-9 m) rather than bit-exact — generous next
/// to any real defect on a pitch measured in tens of metres, and tight enough that nothing
/// but a genuine logic difference clears it.
///
/// `claims()`, `minisPitch()` and `minisShape()` below never touched a fixture and are
/// unchanged by this conversion — see their own headers for what they assert and why.
/// Everything above them is new.
///
/// ------------------------------------------------------------------ the pitch
///
/// `Playbook.ts` (the deleted reference's intent, read for INTENT only — nothing here
/// is ported from it) could express only the regulation pitch, so the sweeps below run
/// against `Playbook.regulation`. That the Swift port genuinely threads the pitch
/// rather than hiding a constant is asserted separately, by property, in `minisPitch()`
/// and `minisShape()` — a port that quietly kept 18.5 as a constant would pass every
/// comparison in this file up to that point and fail there.
enum PlaybookTests {

    // MARK: - shared fixtures

    private static let pb = Playbook.regulation
    private static let DIRS: [Dir] = [1, -1]
    private static let SIGNS: [Playbook.Sign] = [1, -1]
    private static let FORCES: [Playbook.Force] = [.forehand, .backhand, .straight, .middle, .sideline]
    private static let FORMATIONS: [Playbook.FormationName] = [.vertical, .horizontal, .side, .endzone]
    private static let KINDS: [Playbook.CutKind] = [
        .under, .breakUnder, .deep, .strike, .upLine, .dump, .swing,
    ]
    private static let HANDS: [Playbook.Handedness] = [.right, .left]

    static func run() throws {
        constants()
        maths()
        geometry()
        forces()
        formations()
        cuts()
        mark()
        zone()
        claims()
        minisPitch()
        minisShape()
    }

    // MARK: - tolerance

    /// The Model comparison tolerance. Every quantity compared this way is O(0.01-100),
    /// so 1e-9 is many orders of magnitude below anything a real geometry bug could
    /// produce (a metre or more, typically — a sign flip, a swapped clamp bound, a
    /// dropped scale factor) and comfortably above the rounding noise between two
    /// independently ordered floating computations or two different transcendental
    /// call shapes (`hypot` vs `sqrt(dx*dx+dz*dz)`, `exp` vs `tanh`).
    private static func nearEq(_ got: Double, _ want: Double, _ what: String) {
        Check.near(got, want, 1e-9, what)
    }

    /// An ulp-relative envelope, for the `hypot`/`exp` results in `claims()` only.
    private static let ULPS = 4.0
    private static func nearUlp(_ got: Double, _ want: Double, _ what: String) {
        let d = abs(got - want)
        let unit = want == 0 ? Double.ulpOfOne : want.ulp
        let tol = ULPS * unit
        Check.ok(d <= tol, "\(what): off by \(d) (\(d / unit) ulp; got \(got), want \(want))")
    }

    // MARK: - the specification, implemented independently

    /// Every formula below is hand-typed from `Playbook.swift`'s own doc comments and
    /// literal numbers, not copied from the functions under test. Constants are always
    /// spelled as literals here, never read from `Playbook.PLAY` or its internal bands
    /// (`RESET_BAND`, `SWING_BAND`, `PIN_MARGIN`, both inaccessible from this module
    /// anyway) — a mutation to one of those numbers in production must show up as a
    /// disagreement between this file and `UltimateSim`, which reading the same static
    /// property would silently erase.
    enum Model {
        static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double {
            v < lo ? lo : (v > hi ? hi : v)
        }
        static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }

        /// Alternate expression tree from production's `t*t*(3-2t)`: "one minus the
        /// mirrored ramp", `1 - (1-t)^2(1+2t)` — the same cubic reached a different way,
        /// as `CoeffsTests.Model.smoothstep` does for the aero curves.
        static func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
            let span = edge1 - edge0
            let den = (span == 0 || span.isNaN) ? 1e-6 : span
            let t = clamp((x - edge0) / den, 0, 1)
            let m = 1 - t
            return 1 - m * m * (1 + 2 * t)
        }
        static func distSq2(_ ax: Double, _ az: Double, _ bx: Double, _ bz: Double) -> Double {
            let dx = ax - bx
            let dz = az - bz
            return dx * dx + dz * dz
        }
        /// `sqrt` of the sum of squares rather than `hypot` — a different algorithm
        /// (no overflow-guarding scale step), not just a different call site.
        static func dist2(_ ax: Double, _ az: Double, _ bx: Double, _ bz: Double) -> Double {
            distSq2(ax, az, bx, bz).squareRoot()
        }
        /// Sigmoid via the `tanh` identity rather than `1/(1+exp(-kx))`.
        static func sigmoid(_ x: Double, _ k: Double) -> Double {
            0.5 * (1 + Foundation.tanh(k * x / 2))
        }

        // MARK: field geometry

        static func clampToField(_ p: Playbook, _ pt: Vec2d, _ margin: Double?) -> Vec2d {
            let m = margin ?? p.edgeMargin
            return Vec2d(
                clamp(pt.x, -p.field.sideline + m, p.field.sideline - m),
                clamp(pt.z, -p.field.endLine + m, p.field.endLine - m))
        }
        static func inBounds(_ p: Playbook, _ x: Double, _ z: Double, _ margin: Double) -> Bool {
            abs(x) <= p.field.sideline - margin && abs(z) <= p.field.endLine - margin
        }
        static func yardsToGoal(_ p: Playbook, _ z: Double, _ dir: Dir) -> Double {
            p.field.goalLine - Double(dir) * z
        }
        static func inAttackEndzone(_ p: Playbook, _ z: Double, _ dir: Dir) -> Bool {
            Double(dir) * z >= p.field.goalLine
        }
        static func inOwnEndzone(_ p: Playbook, _ z: Double, _ dir: Dir) -> Bool {
            Double(dir) * z <= -p.field.goalLine
        }

        // MARK: force / side

        static func handSideSign(_ handed: Playbook.Handedness, _ dir: Dir) -> Playbook.Sign {
            let rightHandX = -dir
            return handed == .right ? rightHandX : -rightHandX
        }
        static func openSideSign(_ force: Playbook.Force, _ dir: Dir) -> Playbook.Sign {
            if force == .straight { return -dir }
            if force == .middle || force == .sideline { return -dir }
            let forehandX = handSideSign(.right, dir)
            return force == .forehand ? forehandX : -forehandX
        }
        static func breakSideSign(_ force: Playbook.Force, _ dir: Dir) -> Playbook.Sign {
            -openSideSign(force, dir)
        }
        static func openSideFor(
            _ force: Playbook.Force, _ dir: Dir, _ discX: Double, _ prev: Playbook.Sign?
        ) -> Playbook.Sign {
            if force != .middle && force != .sideline { return openSideSign(force, dir) }
            if let prev, abs(discX) < 3.0 { return prev }  // FORCE_DEADBAND, literal
            let towardMiddle: Playbook.Sign = discX > 0 ? -1 : 1
            return force == .middle ? towardMiddle : -towardMiddle
        }
        static func breakSideFor(
            _ force: Playbook.Force, _ dir: Dir, _ discX: Double, _ prev: Playbook.Sign?
        ) -> Playbook.Sign {
            -openSideFor(force, dir, discX, prev)
        }
        static func releaseSideType(
            _ handed: Playbook.Handedness, _ dir: Dir, _ releaseSignX: Double
        ) -> Playbook.ThrowSide {
            let forehandX = handSideSign(handed, dir)
            let v = (releaseSignX == 0 || releaseSignX.isNaN) ? Double(forehandX) : releaseSignX
            let s: Playbook.Sign = v < 0 ? -1 : (v > 0 ? 1 : 0)
            return s == forehandX ? .forehand : .backhand
        }

        // MARK: formations

        /// `Playbook.ts`'s literal spelling: field-independent, regulation numbers only.
        static func stackColumnXStatic(
            _ name: Playbook.FormationName, _ a: Vec2d, _ openSign: Playbook.Sign
        ) -> Double {
            if name == .side { return Double(-openSign) * 12.5 }
            return clamp(a.x * 0.3, -5, 5)
        }
        static func stackColumnX(
            _ p: Playbook, _ name: Playbook.FormationName, _ a: Vec2d, _ openSign: Playbook.Sign
        ) -> Double {
            let w = p.widthScale
            if name == .side { return Double(-openSign) * 12.5 * w }
            return clamp(a.x * 0.3, -5 * w, 5 * w)
        }

        static func rowShift(_ anchor: Double, _ lo: Double, _ hi: Double, _ band: Double) -> Double {
            hi - lo >= 2 * band ? 0 : clamp(anchor, -band - lo, band - hi)
        }

        struct MStation { let x: Double; let z: Double; let role: Playbook.StationRole; let depth: Int }

        static func formationStations(
            _ p: Playbook, _ name: Playbook.FormationName, _ a: Vec2d, _ dir: Dir,
            _ openSign: Playbook.Sign
        ) -> [MStation] {
            let brk: Playbook.Sign = -openSign
            var out: [MStation] = []
            // Literal bands, not `p`'s own internal (inaccessible) `resetBand`/
            // `fieldBand`/`pinMargin` — 10.5, 13.0 and 2.0 are `RESET_BAND`, `SWING_BAND`
            // and `PIN_MARGIN` in `Playbook.swift`, read off its own comments.
            let resetBand = 10.5 * p.widthScale
            let fieldBand = p.field.sideline - p.edgeMargin
            let pinMargin = 2.0 * p.depthScale
            let floorZ = Double(-dir) * (p.field.goalLine - pinMargin)

            func push(_ x: Double, _ z: Double, _ role: Playbook.StationRole, _ depth: Int) {
                let zz = role == .handler ? (dir > 0 ? Swift.max(z, floorZ) : Swift.min(z, floorZ)) : z
                let pt = clampToField(p, Vec2d(x, zz), nil)
                out.append(MStation(x: pt.x, z: pt.z, role: role, depth: depth))
            }

            let dz = p.depthScale
            let wx = p.widthScale

            switch name {
            case .vertical:
                let vReset = Double(openSign) * 4.5 * wx
                let vSwing = Double(brk) * 6.5 * wx
                let vs = rowShift(a.x, Swift.min(vReset, vSwing), Swift.max(vReset, vSwing), resetBand)
                push(vs + vReset, a.z - Double(dir) * 6.5 * dz, .handler, 0)
                push(vs + vSwing, a.z - Double(dir) * 3.5 * dz, .handler, 1)
                let sx = stackColumnX(p, .vertical, a, openSign)
                for i in 0..<5 {
                    push(sx, a.z + Double(dir) * (11.0 + 4.2 * Double(i)) * dz, .cutter, i)
                }
            case .horizontal:
                let hs = rowShift(a.x, -10.0 * wx, 10.0 * wx, fieldBand)
                push(hs + Double(openSign) * 10.0 * wx, a.z - Double(dir) * 5.5 * dz, .handler, 0)
                push(hs, a.z - Double(dir) * 4.0 * dz, .handler, 1)
                push(hs + Double(brk) * 10.0 * wx, a.z - Double(dir) * 5.5 * dz, .handler, 2)
                let xs = [-13.5, -4.5, 4.5, 13.5]
                for i in 0..<4 { push(xs[i] * wx, a.z + Double(dir) * 15 * dz, .cutter, i) }
            case .side:
                let sReset = Double(openSign) * 4.0 * wx
                let sSwing = Double(brk) * 6.0 * wx
                let ss = rowShift(a.x, Swift.min(sReset, sSwing), Swift.max(sReset, sSwing), resetBand)
                push(ss + sReset, a.z - Double(dir) * 6.5 * dz, .handler, 0)
                push(ss + sSwing, a.z - Double(dir) * 3.0 * dz, .handler, 1)
                let lx = stackColumnX(p, .side, a, openSign)
                for i in 0..<5 {
                    push(lx, a.z + Double(dir) * (9.0 + 4.2 * Double(i)) * dz, .cutter, i)
                }
            case .endzone:
                let es = rowShift(a.x, -6.5 * wx, 6.5 * wx, resetBand)
                push(es + Double(openSign) * 6.5 * wx, a.z - Double(dir) * 5.0 * dz, .handler, 0)
                push(es, a.z - Double(dir) * 6.5 * dz, .handler, 1)
                push(es + Double(brk) * 6.5 * wx, a.z - Double(dir) * 5.0 * dz, .handler, 2)
                let ez = Double(dir) * clamp(
                    Double(dir) * a.z + 12 * dz,
                    p.field.goalLine + 3 * dz,
                    p.field.goalLine + p.field.endzoneDepth * 0.55)
                let xs = [-11.0, -4.0, 4.0, 11.0]
                for i in 0..<4 { push(xs[i] * wx, ez, .cutter, i) }
            }
            return out
        }

        static func handlerCount(_ name: Playbook.FormationName) -> Int {
            name == .horizontal || name == .endzone ? 3 : 2
        }
        static func hasColumn(_ name: Playbook.FormationName) -> Bool {
            name == .vertical || name == .side
        }

        static func chooseFormation(
            _ p: Playbook, _ disc: Vec2d, _ dir: Dir, _ prefer: Playbook.FormationName,
            _ windSpeed: Double, _ openSign: Playbook.Sign, _ foeZone: Bool
        ) -> Playbook.FormationName {
            let dz = p.depthScale
            let wx = p.widthScale
            if yardsToGoal(p, disc.z, dir) <= 13 * dz { return .endzone }
            if abs(disc.x) > 14.0 * wx && disc.x * Double(openSign) < 0 { return .side }
            if foeZone { return .horizontal }
            if windSpeed > 7.5 { return .vertical }
            return prefer == .endzone ? .vertical : prefer
        }

        // MARK: cuts

        static func laneOfStatic(
            _ x: Double, _ z: Double, _ disc: Vec2d, _ dir: Dir, _ openSign: Playbook.Sign
        ) -> Playbook.LaneKey {
            let downfield = Double(dir) * (z - disc.z)
            let open = (x - disc.x) * Double(openSign) >= 0
            if downfield < 1.5 { return open ? .resetOpen : .resetBreak }
            if downfield < 16 { return open ? .openUnder : .breakUnder }
            return open ? .openDeep : .breakDeep
        }
        static func laneOf(
            _ p: Playbook, _ x: Double, _ z: Double, _ disc: Vec2d, _ dir: Dir,
            _ openSign: Playbook.Sign
        ) -> Playbook.LaneKey {
            let downfield = Double(dir) * (z - disc.z)
            let open = (x - disc.x) * Double(openSign) >= 0
            if downfield < 1.5 { return open ? .resetOpen : .resetBreak }
            if downfield < 16 * p.depthScale { return open ? .openUnder : .breakUnder }
            return open ? .openDeep : .breakDeep
        }

        struct MCutRoute {
            let kind: Playbook.CutKind
            let lane: Playbook.LaneKey
            let setup: Vec2d
            let target: Vec2d
            let side: Playbook.Sign
            let setupTime: Double
            let maxTime: Double
        }

        static func buildCut(
            _ p: Playbook, _ kind: Playbook.CutKind, _ from: Vec2d, _ disc: Vec2d, _ dir: Dir,
            _ openSign: Playbook.Sign, _ side: Playbook.Sign, _ j: Double
        ) -> MCutRoute {
            let brk: Playbook.Sign = -openSign
            var setup: Vec2d
            var target: Vec2d
            var maxTime: Double = 3.4  // underCutTime, the default

            let d = Double(dir)
            let sd = Double(side)
            let bd = Double(brk)
            let od = Double(openSign)
            let dz = p.depthScale
            let wx = p.widthScale

            switch kind {
            case .under:
                setup = Vec2d(from.x + sd * 1.2, from.z + d * 3.0)
                target = Vec2d(disc.x + sd * (6 + 3 * j) * wx, disc.z + d * (5.5 + 4 * j) * dz)
            case .breakUnder:
                setup = Vec2d(from.x + bd * 0.8, from.z + d * 2.6)
                target = Vec2d(disc.x + bd * (7 + 3 * j) * wx, disc.z + d * (3 + 2.5 * j) * dz)
            case .deep:
                setup = Vec2d(from.x - sd * 1.0, from.z - d * 2.8)
                let ahead = d * (from.z - disc.z)
                let reach = Swift.min(
                    38 * dz, Swift.max((24 + 8 * j) * dz, ahead + 13 * dz + 6 * j * dz))
                target = Vec2d(disc.x + sd * (4 + 5 * j) * wx, disc.z + d * reach)
                maxTime = 3.2
            case .strike:
                setup = Vec2d(from.x - sd * 1.6, from.z + d * 1.2)
                target = Vec2d(
                    disc.x + sd * (4 + 3 * j) * wx, d * (p.field.goalLine + 2 * dz + 4 * j * dz))
                maxTime = 1.8
            case .upLine:
                setup = Vec2d(from.x - od * 1.6, from.z - d * 1.0)
                target = Vec2d(disc.x + od * (2.0 + 1.5 * j) * wx, disc.z + d * (5 + 2 * j) * dz)
                maxTime = 1.6
            case .dump:
                setup = Vec2d(from.x + bd * 2.4, from.z + d * 2.8)
                target = Vec2d(
                    clamp(
                        disc.x + od * (6.5 + 2.5 * j) * wx, -10.5 * wx - 2 * wx, 10.5 * wx + 2 * wx),
                    disc.z - d * (7.5 + 2 * j) * dz)
                maxTime = 2.0
            case .swing:
                setup = Vec2d(from.x - od * 1.4, from.z - d * 1.2)
                target = Vec2d(
                    clamp(disc.x + od * (8 + 2 * j) * wx, -13.0 * wx, 13.0 * wx),
                    disc.z - d * (2 + 2 * j) * dz)
                maxTime = 1.8
            }

            if kind == .dump || kind == .swing {
                let floor = Double(-dir) * (p.field.goalLine - 2.0 * dz)
                let rawZ = target.z
                target.z = dir > 0 ? Swift.max(rawZ, floor) : Swift.min(rawZ, floor)
                let lost = abs(rawZ - target.z)
                if lost > 0.1 {
                    let raw = target.x - disc.x
                    let signed: Playbook.Sign = raw < 0 ? -1 : (raw > 0 ? 1 : 0)
                    let away: Playbook.Sign = (signed == 0) ? openSign : signed
                    target.x = clamp(target.x + Double(away) * lost * 0.8, -13.0 * wx, 13.0 * wx)
                }
            }

            let t = clampToField(p, target, nil)
            return MCutRoute(
                kind: kind,
                lane: laneOf(p, t.x, t.z, disc, dir, openSign),
                setup: clampToField(p, setup, nil),
                target: t,
                side: side,
                setupTime: kind == .strike || kind == .upLine ? 0.45 * 0.7 : 0.45,
                maxTime: maxTime)
        }

        // MARK: mark

        /// `sqrt(dx^2+dz^2)` rather than `hypot` — see the header.
        static func markPoint(
            _ thrower: Vec2d, _ dir: Dir, _ breakSign: Playbook.Sign, _ distance: Double
        ) -> Vec2d {
            let dx = Double(breakSign) * 0.90
            let dz = Double(dir) * 0.44
            let l = (dx * dx + dz * dz).squareRoot()
            return Vec2d(thrower.x + (dx / l) * distance, thrower.z + (dz / l) * distance)
        }

        // MARK: zone

        struct MZoneStation { let role: Playbook.ZoneRole; let x: Double; let z: Double }

        static func zoneStations(
            _ p: Playbook, _ disc: Vec2d, _ dir: Dir, _ openSign: Playbook.Sign,
            _ deepThreat: Vec2d?
        ) -> [MZoneStation] {
            let brk: Playbook.Sign = -openSign
            let m = markPoint(disc, dir, brk, 2.15)  // PLAY.markDistance, literal
            let cupR = 4.4
            let dz = p.depthScale
            let wx = p.widthScale
            let deepX = deepThreat.map { clamp($0.x * 0.55, -9 * wx, 9 * wx) } ?? 0
            var deepZ = disc.z + Double(dir) * 26 * dz
            if Double(dir) * deepZ > p.field.goalLine + 5 * dz {
                deepZ = Double(dir) * (p.field.goalLine + 5 * dz)
            }
            let d = Double(dir)
            let raw: [MZoneStation] = [
                MZoneStation(role: .cupMark, x: m.x, z: m.z),
                MZoneStation(role: .cupLeft, x: disc.x - cupR * 0.88, z: disc.z + d * cupR * 0.6),
                MZoneStation(role: .cupRight, x: disc.x + cupR * 0.88, z: disc.z + d * cupR * 0.6),
                MZoneStation(
                    role: .wingOpen, x: disc.x + Double(openSign) * 10.5 * wx,
                    z: disc.z + d * 7.5 * dz),
                MZoneStation(
                    role: .wingBreak, x: disc.x + Double(brk) * 10.5 * wx, z: disc.z + d * 7.5 * dz),
                MZoneStation(role: .shortDeep, x: disc.x * 0.4, z: disc.z + d * 15 * dz),
                MZoneStation(role: .deep, x: deepX, z: deepZ),
            ]
            return raw.map { s in
                let pt = clampToField(p, Vec2d(s.x, s.z), nil)
                return MZoneStation(role: s.role, x: pt.x, z: pt.z)
            }
        }

        /// Calls production's already-separately-tested `smoothstep` for the wind term —
        /// this function's own claim is the threshold arithmetic around it, not the curve.
        static func shouldPlayZone(
            _ windSpeed: Double, _ scoreDiff: Int, _ pointsPlayed: Int, _ bias: Double
        ) -> Bool {
            let windPull = Playbook.smoothstep(4.5, 11, windSpeed)
            let leadPull = scoreDiff >= 3 && pointsPlayed > 6 ? 0.35 : 0.0
            return windPull + leadPull + bias > 0.5
        }

        // MARK: weather

        static func drawWeather(_ rng: Rng) -> Playbook.Weather {
            let calm = Vec2d(rng.range(-1.5, 1.5), rng.range(-1.1, 1.1))
            if rng.next() >= 0.10 {
                return Playbook.Weather(
                    wind: calm, speed: (calm.x * calm.x + calm.z * calm.z).squareRoot(),
                    windy: false)
            }
            let speed = rng.range(8.0, 9.5)
            let bearing = rng.range(-Double.pi, Double.pi)
            return Playbook.Weather(
                wind: Vec2d(Foundation.cos(bearing) * speed, Foundation.sin(bearing) * speed),
                speed: speed, windy: true)
        }

        // MARK: timeouts

        static func timeoutIntent(_ r: Playbook.TimeoutRead) -> Playbook.TimeoutIntent {
            if r.remaining <= 0 || r.stoppedThisPossession { return .none }
            let endgame = Swift.max(r.ours, r.theirs) >= r.toWin - 2 && abs(r.ours - r.theirs) <= 1
            if endgame && r.receiving && r.throwsThisPoint == 0 && r.stall <= 2.0 {
                return .setPlay
            }
            if r.stall >= r.stallMax - 3.0 && (r.remaining >= 2 || !endgame) {
                return .stallReset
            }
            return .none
        }
    }

    // MARK: - constants

    /// Every field this module declares, by exact value. A relation is the right
    /// assertion for a law and the wrong one for a tuning number: nothing else in this
    /// file (or, since the goldens are gone, anywhere) constrains `PLAY.stackSpacing`
    /// to be 4.2 rather than some other positive number, so it is pinned here directly.
    private static func constants() {
        // FIELD — the mapping the port's doc comment claims: `Playbook.regulation`
        // plays on exactly `FieldConstants.standard`.
        Check.bitEq(pb.field.sideline, 18.5, "regulation FIELD.halfWidth = sideline")
        Check.bitEq(pb.field.endLine, 50, "regulation FIELD.halfLength = endLine")
        Check.bitEq(pb.field.goalLine, 32, "regulation FIELD.goalLine")
        Check.bitEq(pb.field.endzoneDepth, 18, "regulation FIELD.endzoneDepth")
        Check.bitEq(pb.field.brickZ, 14, "regulation FIELD.brick = brickZ")
        Check.eq(pb.field, FieldConstants.standard, "Playbook.regulation plays on FieldConstants.standard")
        Check.bitEq(pb.edgeMargin, 0.9, "FIELD.edgeMargin")
        Check.bitEq(Playbook.DEFAULT_EDGE_MARGIN, 0.9, "DEFAULT_EDGE_MARGIN")

        Check.bitEq(Playbook.PLAY.stackSpacing, 4.2, "PLAY.stackSpacing")
        Check.bitEq(Playbook.PLAY.stackLead, 11.0, "PLAY.stackLead")
        Check.eq(Playbook.PLAY.stackHold, 3, "PLAY.stackHold")
        Check.eq(Playbook.PLAY.maxLiveCuts, 2, "PLAY.maxLiveCuts")
        Check.bitEq(Playbook.PLAY.cutStagger, 1.1, "PLAY.cutStagger")
        Check.bitEq(Playbook.PLAY.setupTime, 0.45, "PLAY.setupTime")
        Check.bitEq(Playbook.PLAY.plantTime, 0.16, "PLAY.plantTime")
        Check.bitEq(Playbook.PLAY.underCutTime, 3.4, "PLAY.underCutTime")
        Check.bitEq(Playbook.PLAY.deepCutTime, 3.2, "PLAY.deepCutTime")
        Check.bitEq(Playbook.PLAY.markDistance, 2.15, "PLAY.markDistance")
        Check.bitEq(Playbook.PLAY.markMax, 3.0, "PLAY.markMax")
        Check.bitEq(Playbook.PLAY.discSpace, 1.0, "PLAY.discSpace")
        Check.bitEq(Playbook.PLAY.shadeOpen, 1.75, "PLAY.shadeOpen")
        Check.bitEq(Playbook.PLAY.deepCushion, 2.4, "PLAY.deepCushion")
        Check.bitEq(Playbook.PLAY.underGap, 0.9, "PLAY.underGap")

        Check.bitEq(Playbook.FORCE_DEADBAND, 3.0, "FORCE_DEADBAND")
        Check.eq(
            Playbook.POSITIONAL_FORCES.map(\.rawValue), ["middle", "sideline"], "POSITIONAL_FORCES")
        Check.eq(
            Playbook.ALL_LANES.map(\.rawValue),
            ["open-under", "open-deep", "break-under", "break-deep", "reset-open", "reset-break"],
            "ALL_LANES")

        // The weather / timeout tunables — see the header on the aimath finding in
        // issue #58: a relation survives the value moving, and nothing else in this
        // suite constrains these seven numbers.
        Check.bitEq(Playbook.windyChance, 0.10, "windyChance")
        Check.bitEq(Playbook.calmAcross, 1.5, "calmAcross")
        Check.bitEq(Playbook.calmAlong, 1.1, "calmAlong")
        Check.bitEq(Playbook.windySpeed.min, 8.0, "windySpeed.min")
        Check.bitEq(Playbook.windySpeed.max, 9.5, "windySpeed.max")
        Check.bitEq(Playbook.timeoutPanicBefore, 3.0, "timeoutPanicBefore")
        Check.bitEq(Playbook.timeoutSetPlayStall, 2.0, "timeoutSetPlayStall")

        // The minis pitch too — `Playbook.ts` could not express it, but it is what
        // `depthScale`/`widthScale` divide against, so its numbers are load-bearing for
        // every shape assertion in `minisPitch`/`minisShape` below.
        let minis = FieldConstants.minis
        Check.bitEq(minis.sideline, 9, "minis SIDELINE")
        Check.bitEq(minis.endLine, 18.5, "minis END_LINE")
        Check.bitEq(minis.goalLine, 12.5, "minis GOAL_LINE")
        Check.bitEq(minis.endzoneDepth, 6, "minis ENDZONE_DEPTH")
        Check.bitEq(minis.brickZ, 6.5, "minis BRICK_Z")

        Check.eq(Playbook.referenceRoster, 7, "referenceRoster")
        Check.eq(
            Playbook.referenceField, FieldConstants.standard, "referenceField is the regulation pitch")
    }

    // MARK: - maths

    private static let clampCases: [(v: Double, lo: Double, hi: Double)] = [
        (0, -1, 1), (-2, -1, 1), (2, -1, 1), (-1, -1, 1), (1, -1, 1),
        (-1.0000000000000002, -1, 1), (0.9999999999999999, -1, 1),
        (0, 5, -5), (0.3, 0, 0), (-0, -1, 1),
    ]
    private static let lerpCases: [(a: Double, b: Double, t: Double)] = [
        (0, 1, 0), (0, 1, 1), (0, 1, 0.5), (0, 1, -0.5), (0, 1, 1.5),
        (-3.25, 7.75, 0.3), (5, 5, 0.7), (1e8, 1e-8, 0.25),
    ]
    private static let smoothstepCases: [(e0: Double, e1: Double, x: Double)] = [
        (0, 1, -1), (0, 1, 0), (0, 1, 0.25), (0, 1, 0.5), (0, 1, 0.75), (0, 1, 1), (0, 1, 2),
        (1, 0, 0.25), (1, 0, 0.75),
        (4, 4, 3.9999995), (4, 4, 4), (4, 4, 4.0000005), (4, 4, 5),
        (4.5, 11, 0), (4.5, 11, 4.5), (4.5, 11, 7.75), (4.5, 11, 11), (4.5, 11, 20),
    ]
    private static let dist2Cases: [(ax: Double, az: Double, bx: Double, bz: Double)] = [
        (0, 0, 0, 0), (3, 0, 0, 4), (-3, -4, 0, 0), (1.5, -2.25, -9.75, 8.125),
        (-18.5, -50, 18.5, 50), (0.1, 0.2, 0.1, 0.2),
    ]
    private static let sigmoidCases: [(x: Double, k: Double)] = [
        (0, 1), (1, 1), (-1, 1), (3, 2), (-3, 2), (0.5, 0), (10, 1), (-10, 1),
    ]

    private static func maths() {
        for c in clampCases {
            Check.bitEq(
                clamp(c.v, c.lo, c.hi), Model.clamp(c.v, c.lo, c.hi),
                "clamp(\(c.v), \(c.lo), \(c.hi))")
        }
        for c in lerpCases {
            Check.bitEq(
                Playbook.lerp(c.a, c.b, c.t), Model.lerp(c.a, c.b, c.t),
                "lerp(\(c.a), \(c.b), \(c.t))")
        }
        for c in smoothstepCases {
            nearEq(
                Playbook.smoothstep(c.e0, c.e1, c.x), Model.smoothstep(c.e0, c.e1, c.x),
                "smoothstep(\(c.e0), \(c.e1), \(c.x))")
        }
        for c in dist2Cases {
            Check.bitEq(
                Playbook.distSq2(c.ax, c.az, c.bx, c.bz), Model.distSq2(c.ax, c.az, c.bx, c.bz),
                "distSq2(\(c.ax),\(c.az) -> \(c.bx),\(c.bz))")
            nearEq(
                Playbook.dist2(c.ax, c.az, c.bx, c.bz), Model.dist2(c.ax, c.az, c.bx, c.bz),
                "dist2(\(c.ax),\(c.az) -> \(c.bx),\(c.bz))")
        }
        for c in sigmoidCases {
            nearEq(Playbook.sigmoid(c.x, c.k), Model.sigmoid(c.x, c.k), "sigmoid(\(c.x), k \(c.k))")
        }
    }

    // MARK: - field geometry

    private static func geometry() {
        let M = pb.edgeMargin
        var points: [Vec2d] = []
        for x in [
            0.0, pb.field.sideline - M, pb.field.sideline - M + 1e-9, pb.field.sideline - M - 1e-9,
            -pb.field.sideline + M, -pb.field.sideline + M - 1e-9, 100, -100,
        ] {
            points.append(Vec2d(x, 0))
        }
        for z in [
            pb.field.endLine - M, pb.field.endLine - M + 1e-9, -pb.field.endLine + M,
            -pb.field.endLine + M - 1e-9, 100, -100,
        ] {
            points.append(Vec2d(0, z))
        }
        for margin: Double? in [nil, 0, M, 2.5, 25] {
            for p in points {
                let got = margin.map { pb.clampToField(p, margin: $0) } ?? pb.clampToField(p)
                let want = Model.clampToField(pb, p, margin)
                let at = "clampToField(\(p.x), \(p.z), margin \(margin.map { "\($0)" } ?? "default"))"
                nearEq(got.x, want.x, "\(at).x")
                nearEq(got.z, want.z, "\(at).z")
            }
        }

        for margin in [0.0, 0.9, 5.0] {
            for (x, z) in [
                (0.0, 0.0),
                (pb.field.sideline - margin, 0.0), (pb.field.sideline - margin + 1e-9, 0.0),
                (-(pb.field.sideline - margin), 0.0), (-(pb.field.sideline - margin) - 1e-9, 0.0),
                (0.0, pb.field.endLine - margin), (0.0, pb.field.endLine - margin + 1e-9),
                (0.0, -(pb.field.endLine - margin)), (0.0, -(pb.field.endLine - margin) - 1e-9),
                (30.0, 60.0),
            ] {
                Check.eq(
                    pb.inBounds(x, z, margin: margin), Model.inBounds(pb, x, z, margin),
                    "inBounds(\(x), \(z), margin \(margin))")
            }
        }

        for dir in DIRS {
            for z in [
                0.0, 14, -14, pb.field.goalLine, -pb.field.goalLine,
                pb.field.goalLine - 1e-9, pb.field.goalLine + 1e-9,
                -pb.field.goalLine + 1e-9, -pb.field.goalLine - 1e-9,
                pb.field.endLine, -pb.field.endLine, 13, -13,
            ] {
                nearEq(
                    pb.yardsToGoal(z, dir), Model.yardsToGoal(pb, z, dir),
                    "yardsToGoal(\(z), dir \(dir))")
                Check.eq(
                    pb.inAttackEndzone(z, dir), Model.inAttackEndzone(pb, z, dir),
                    "inAttackEndzone(\(z), dir \(dir))")
                Check.eq(
                    pb.inOwnEndzone(z, dir), Model.inOwnEndzone(pb, z, dir),
                    "inOwnEndzone(\(z), dir \(dir))")
            }
        }
    }

    // MARK: - force / side

    private static func forces() {
        for handed in HANDS {
            for dir in DIRS {
                Check.eq(
                    Playbook.handSideSign(handed, dir), Model.handSideSign(handed, dir),
                    "handSideSign(\(handed.rawValue), dir \(dir))")
            }
        }
        for force in FORCES {
            for dir in DIRS {
                let at = "\(force.rawValue), dir \(dir)"
                Check.eq(
                    Playbook.openSideSign(force, dir), Model.openSideSign(force, dir),
                    "openSideSign(\(at))")
                Check.eq(
                    Playbook.breakSideSign(force, dir), Model.breakSideSign(force, dir),
                    "breakSideSign(\(at))")
            }
        }

        let deadbandXs: [Double] = [
            0, 1.5, -1.5,
            3.0 - 1e-9, 3.0, 3.0 + 1e-9, -(3.0 - 1e-9), -3.0, -(3.0 - 1e-9),
            9.4, -9.4, 18.5, -18.5,
        ]
        for force in FORCES {
            for dir in DIRS {
                for discX in deadbandXs {
                    for prev: Playbook.Sign? in [nil, 1, -1] {
                        let at =
                            "\(force.rawValue), dir \(dir), discX \(discX), "
                            + "prev \(prev.map { "\($0)" } ?? "nil")"
                        Check.eq(
                            Playbook.openSideFor(force, dir, discX, prev),
                            Model.openSideFor(force, dir, discX, prev), "openSideFor(\(at))")
                        Check.eq(
                            Playbook.breakSideFor(force, dir, discX, prev),
                            Model.breakSideFor(force, dir, discX, prev), "breakSideFor(\(at))")
                    }
                }
            }
        }

        for handed in HANDS {
            for dir in DIRS {
                for x in [0.0, -0.0, 1, -1, 0.001, -0.001, 12.5, -12.5] {
                    Check.eq(
                        Playbook.releaseSideType(handed, dir, x),
                        Model.releaseSideType(handed, dir, x),
                        "releaseSideType(\(handed.rawValue), dir \(dir), x \(x))")
                }
            }
        }
    }

    // MARK: - formations

    private static let formationDiscs: [Vec2d] = [
        Vec2d(0, 0), Vec2d(0, 20), Vec2d(12.5, -8), Vec2d(-12.5, 8), Vec2d(17.4, 0),
        Vec2d(-17.6, 3), Vec2d(0, -30), Vec2d(0, 30), Vec2d(3.5, 31.9), Vec2d(-9, -44),
    ]

    private static func formations() {
        for name in FORMATIONS {
            for openSign in SIGNS {
                for ax in [0.0, 5, -5, 16.6, 16.666666666666668, 16.7, 18.5, -18.5, 50, -50] {
                    Check.bitEq(
                        Playbook.stackColumnX(name, Vec2d(ax, 0), openSign),
                        Model.stackColumnXStatic(name, Vec2d(ax, 0), openSign),
                        "stackColumnX(\(name.rawValue), a.x \(ax), open \(openSign))")
                    nearEq(
                        pb.stackColumnX(name, Vec2d(ax, 0), openSign),
                        Model.stackColumnX(pb, name, Vec2d(ax, 0), openSign),
                        "pb.stackColumnX(\(name.rawValue), a.x \(ax), open \(openSign))")
                }
            }
        }

        for name in FORMATIONS {
            for dir in DIRS {
                for openSign in SIGNS {
                    for a in formationDiscs {
                        let got = pb.formationStations(name, a, dir, openSign)
                        let want = Model.formationStations(pb, name, a, dir, openSign)
                        let at =
                            "formationStations(\(name.rawValue), disc \(a.x),\(a.z), "
                            + "dir \(dir), open \(openSign))"
                        Check.eq(got.count, want.count, "\(at).count")
                        guard got.count == want.count else { continue }
                        for i in 0..<got.count {
                            nearEq(got[i].x, want[i].x, "\(at)[\(i)].x")
                            nearEq(got[i].z, want[i].z, "\(at)[\(i)].z")
                            Check.eq(got[i].role, want[i].role, "\(at)[\(i)].role")
                            Check.eq(got[i].depth, want[i].depth, "\(at)[\(i)].depth")
                        }
                    }
                }
            }
        }

        for name in FORMATIONS {
            Check.eq(
                Playbook.handlerCount(name), Model.handlerCount(name), "handlerCount(\(name.rawValue))")
            Check.eq(Playbook.hasColumn(name), Model.hasColumn(name), "hasColumn(\(name.rawValue))")
        }

        for dir in DIRS {
            for openSign in SIGNS {
                for prefer in FORMATIONS {
                    for windSpeed in [0.0, 7.5, 7.500000000000001, 12] {
                        for foeZone in [false, true] {
                            for disc in [
                                Vec2d(0, 0),
                                Vec2d(0, Double(dir) * 19),
                                Vec2d(0, Double(dir) * 19.000000000000004),
                                Vec2d(0, Double(dir) * 18.9),
                                Vec2d(14.0, 0), Vec2d(14.000000000000002, 0),
                                Vec2d(-14.000000000000002, 0),
                                Vec2d(17.9, -4), Vec2d(-17.9, -4),
                            ] {
                                let got = pb.chooseFormation(
                                    disc, dir, prefer, windSpeed, openSign, foeZone)
                                let want = Model.chooseFormation(
                                    pb, disc, dir, prefer, windSpeed, openSign, foeZone)
                                Check.eq(
                                    got, want,
                                    "chooseFormation(disc \(disc.x),\(disc.z), dir \(dir), "
                                        + "prefer \(prefer.rawValue), wind \(windSpeed), "
                                        + "open \(openSign), foeZone \(foeZone))")
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - cuts

    private static func cuts() {
        for dir in DIRS {
            for openSign in SIGNS {
                let disc = Vec2d(2, -5)
                for dz in [
                    -10.0, 0, 1.4999999999999998, 1.5, 1.5000000000000002,
                    8, 15.999999999999998, 16, 16.000000000000004, 30,
                ] {
                    for dx in [-8.0, -1e-9, 0, 1e-9, 8] {
                        let x = disc.x + dx
                        let z = disc.z + Double(dir) * dz
                        Check.eq(
                            Playbook.laneOf(x, z, disc, dir, openSign),
                            Model.laneOfStatic(x, z, disc, dir, openSign),
                            "laneOf(\(x),\(z) vs disc \(disc.x),\(disc.z), dir \(dir), open \(openSign))")
                        Check.eq(
                            pb.laneOf(x, z, disc, dir, openSign),
                            Model.laneOf(pb, x, z, disc, dir, openSign),
                            "pb.laneOf(\(x),\(z) vs disc \(disc.x),\(disc.z), dir \(dir), open \(openSign))")
                    }
                }
            }
        }

        let cutFromDiscPairs: [(from: Vec2d, disc: Vec2d)] = [
            (Vec2d(0, 12), Vec2d(0, 0)),
            (Vec2d(-6, 26), Vec2d(3.5, 2)),
            (Vec2d(16, 5), Vec2d(17.4, 1)),
            (Vec2d(1, -28), Vec2d(0, -30)),
            (Vec2d(-2, -33), Vec2d(-1, -31.5)),
            (Vec2d(0, 28), Vec2d(0, 0)),
        ]
        for kind in KINDS {
            for dir in DIRS {
                for openSign in SIGNS {
                    for side in SIGNS {
                        for j in [0.0, 0.5, 1.0] {
                            for pair in cutFromDiscPairs {
                                let got = pb.buildCut(
                                    kind, pair.from, pair.disc, dir, openSign, side, j)
                                let want = Model.buildCut(
                                    pb, kind, pair.from, pair.disc, dir, openSign, side, j)
                                let at =
                                    "buildCut(\(kind.rawValue), from \(pair.from.x),\(pair.from.z), "
                                    + "disc \(pair.disc.x),\(pair.disc.z), dir \(dir), "
                                    + "open \(openSign), side \(side), j \(j))"
                                Check.eq(got.kind, want.kind, "\(at).kind")
                                Check.eq(got.lane, want.lane, "\(at).lane")
                                nearEq(got.setup.x, want.setup.x, "\(at).setup.x")
                                nearEq(got.setup.z, want.setup.z, "\(at).setup.z")
                                nearEq(got.target.x, want.target.x, "\(at).target.x")
                                nearEq(got.target.z, want.target.z, "\(at).target.z")
                                Check.eq(got.side, want.side, "\(at).side")
                                nearEq(got.setupTime, want.setupTime, "\(at).setupTime")
                                nearEq(got.maxTime, want.maxTime, "\(at).maxTime")
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - mark

    private static func mark() {
        for dir in DIRS {
            for breakSign in SIGNS {
                for distance: Double? in [nil, 0, Playbook.PLAY.markDistance, Playbook.PLAY.markMax, 5] {
                    let thrower = Vec2d(3.5, -7.25)
                    let got = distance.map { Playbook.markPoint(thrower, dir, breakSign, $0) }
                        ?? Playbook.markPoint(thrower, dir, breakSign)
                    let want = Model.markPoint(
                        thrower, dir, breakSign, distance ?? Playbook.PLAY.markDistance)
                    let at =
                        "markPoint(dir \(dir), break \(breakSign), "
                        + "d \(distance.map { "\($0)" } ?? "default"))"
                    nearEq(got.x, want.x, "\(at).x")
                    nearEq(got.z, want.z, "\(at).z")
                }
            }
        }
    }

    // MARK: - zone

    private static func zone() {
        let zoneDiscs = [Vec2d(0, 0), Vec2d(12, -10), Vec2d(-15, 20), Vec2d(0, 28), Vec2d(4, 31)]
        let deepThreats: [Vec2d?] = [
            nil, Vec2d(0, 0), Vec2d(16.36, 30), Vec2d(-16.36, 30), Vec2d(-18.5, 0),
        ]
        for dir in DIRS {
            for openSign in SIGNS {
                for disc in zoneDiscs {
                    for threat in deepThreats {
                        let got = pb.zoneStations(disc, dir, openSign, threat)
                        let want = Model.zoneStations(pb, disc, dir, openSign, threat)
                        let at =
                            "zoneStations(disc \(disc.x),\(disc.z), dir \(dir), open \(openSign), "
                            + "threat \(threat.map { "\($0.x)" } ?? "nil"))"
                        Check.eq(got.count, want.count, "\(at).count")
                        guard got.count == want.count else { continue }
                        for i in 0..<got.count {
                            Check.eq(got[i].role, want[i].role, "\(at)[\(i)].role")
                            nearEq(got[i].x, want[i].x, "\(at)[\(i)].x")
                            nearEq(got[i].z, want[i].z, "\(at)[\(i)].z")
                        }
                    }
                }
            }
        }

        for windSpeed in [0.0, 4.5, 7, 7.75, 11, 20] {
            for scoreDiff in [0, 2, 3, 4, -5] {
                for pointsPlayed in [0, 6, 7, 20] {
                    // `leadPull` is 0.35 with no windPull term of its own, so a mutation
                    // to that one number only shows up when `windPull + bias` sits in a
                    // narrow band just below the 0.5 threshold — 0.0 and 0.15 are both
                    // outside it (0 -> 0.35 either way still <=0.5 at 0.30 but the sum
                    // at 0.15 lands exactly on 0.5 for both values). 0.1 and 0.18 are
                    // chosen to fall inside that band at windSpeed 0/4.5, where windPull
                    // is exactly 0.
                    for bias in [0.0, 0.1, 0.15, 0.18, 0.5, -0.4] {
                        Check.eq(
                            Playbook.shouldPlayZone(windSpeed, scoreDiff, pointsPlayed, bias),
                            Model.shouldPlayZone(windSpeed, scoreDiff, pointsPlayed, bias),
                            "shouldPlayZone(wind \(windSpeed), diff \(scoreDiff), "
                                + "points \(pointsPlayed), bias \(bias))")
                    }
                }
            }
        }

        // The weather draw, over enough seeds that both modes are represented. Three
        // draws deep on either branch, so a port that reorders them fails on the first
        // seed whose day disagrees.
        for seed in UInt32(1)...64 {
            let got = Playbook.drawWeather(Rng(seed: seed))
            let want = Model.drawWeather(Rng(seed: seed))
            let at = "drawWeather(seed \(seed))"
            Check.eq(got.windy, want.windy, "\(at).windy")
            nearEq(got.wind.x, want.wind.x, "\(at).wind.x")
            nearEq(got.wind.z, want.wind.z, "\(at).wind.z")
            nearEq(got.speed, want.speed, "\(at).speed")
        }

        // The timeout decision.
        for stall in [0.0, 1, 2, 2.5, 6.9, 7, 8, 9.5] {
            for remaining in [0, 1, 2] {
                for throwsThisPoint in [0, 1] {
                    for receiving in [true, false] {
                        for stoppedThisPossession in [false, true] {
                            for (ours, theirs) in [(0, 0), (3, 2), (5, 5), (5, 4), (4, 5), (6, 2)] {
                                let r = Playbook.TimeoutRead(
                                    stall: stall, stallMax: 10, remaining: remaining,
                                    throwsThisPoint: throwsThisPoint, receiving: receiving,
                                    stoppedThisPossession: stoppedThisPossession, ours: ours,
                                    theirs: theirs, toWin: 7)
                                Check.eq(
                                    Playbook.timeoutIntent(r), Model.timeoutIntent(r),
                                    "timeoutIntent(stall \(stall), left \(remaining), "
                                        + "throws \(throwsThisPoint), recv \(receiving), "
                                        + "stopped \(stoppedThisPossession), \(ours)-\(theirs))")
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - the claims the module makes in prose

    /// Doc comments assert behaviour; behaviour can be checked.
    ///
    /// Every one of these would still pass every comparison above if the sign were
    /// flipped on both sides of the port, because a `Model` comparison only shows the
    /// port agrees with a second transcription — not that either transcription means
    /// what the doc comment says. These say what it means.
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
        // reproduces all three. The golden that used to cover this sampled the zeros
        // but not NaN, so deleting `|| span.isNaN` from the port changed nothing under
        // that fixture — a mutation test found that hole.
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
        // fifth of a regulation half and the WHOLE of a minis one, so the minis game was
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
}
