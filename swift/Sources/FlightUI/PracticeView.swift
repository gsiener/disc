import Foundation
import RealityKit
import SwiftUI
import UltimateSim

/// A place to throw the disc at a target, repeatedly, with the real drag-charge-release
/// gesture and the real disc physics — and nothing else.
///
/// Issue #55, narrowed by the repo owner's own three comments on the ticket: **single-
/// player** (no AI defender, no opposing team, no pressure variant), **no drills or
/// difficulty** (one target, no picker, no knobs), **presentation only** (this drives the
/// already-validated throw pipeline exactly as it runs in a match — nothing here is new
/// simulation logic, so nothing here needs its own `SimChecks` coverage).
///
/// **Why this does not build an `Engine`.** An `Engine` is the rules machine as much as it
/// is the disc: `canRelease` gates on `game.phase`, and a throw only leaves the hand from
/// `.prePull` (a pull) or `.livePossession` — reaching either means staging a point,
/// running a roster, and having somebody catch it, none of which a solo target session has
/// a use for. Configuring one for this would mean building a full roster and an opposing
/// "team" nobody plays, then *suppressing* the phase machine, the stall count and the
/// score, rather than genuinely being free of them — dragging the machinery along and
/// hiding it, not doing without it. The throw itself needs none of that: `DiscRuntime.
/// release(_:)` is the exact call `Engine.humanRelease` makes on a live possession, and
/// `humanReleaseParams` (`HumanRelease.swift`) is already a pure function of the charge and
/// the drag, with its own suite. This view drives both directly — the same gesture
/// interpretation (`ThrowGesture`), the same charge-to-quality curve (`ThrowCharge`), the
/// same release mapping, the same flight model. What it does not carry is `GameState`,
/// `TeamAI`, `Locomotion`, a roster, or a phase — there is nobody to defend, nobody to
/// mark, and nothing to stall.
///
/// **Why there is no cone select / aim assist.** `HumanTargeting`'s cone exists to pick a
/// *teammate* out of several candidates from a coarse drag; a solo target has exactly one
/// thing to aim at and the player either throws it there or does not — assisting that
/// throw would be assisting the very thing this mode exists to practise.
@available(macOS 15.0, iOS 18.0, *)
struct PracticeView: View {
    /// Back to the pre-game sheet.
    let onDismiss: () -> Void

    // MARK: geometry
    //
    // A fixed pitch, a fixed thrower, a fixed target. "No drills or difficulty" rules out
    // a distance picker as much as it rules out a difficulty slider — one honest target,
    // reused every rep.

    private static let fieldSpec = FieldSpec.minis
    private static let throwerPos = Vec3d(0, 0, -9)
    private static let targetPos = Vec3d(0, 0, 9)
    /// How close a landing spot counts as a hit. Wider than the drawn ring (0.95 m,
    /// `PitchScene.targetRing`) on purpose: the ring says roughly where "on target" is, and
    /// a hit judged one metre stricter than what a player can see would read as broken
    /// rather than as difficult.
    private static let hitRadius = 1.6
    /// Same cancel radius `MatchView` uses — a thumb that comes back to where it started
    /// is the universal "no".
    private static let cancelRadius = 26.0
    /// How long the result stays up before the disc resets to hand.
    private static let resetDelay = 1.6
    private static let tickDt = FrameClock.tickDt

    @State private var disc = DiscRuntime()
    @State private var clock = FrameClock()
    @State private var drag: DragState?
    @State private var scene = PracticeScene()
    @State private var settled = false
    @State private var result: Rep?
    @State private var landingPos: Vec3d?
    @State private var resultTimeLeft = 0.0
    @State private var viewSize: CGSize = .zero
    /// Bumped once a rendered frame, purely to give `RealityView.update` something to
    /// subscribe to — same reasoning as `MatchView.frame`.
    @State private var frame = 0

    /// A drag in progress, in view coordinates plus the throw it currently means. A smaller
    /// twin of `MatchView.DragState` — no receiver preview, because there is nobody to
    /// preview.
    struct DragState {
        var start: CGPoint
        var current: CGPoint
        var type: ThrowType
        var power: Double
        var loft: Double
        var aim: Vec3d
        var aborted: Bool
    }

    /// What the last throw did.
    struct Rep {
        let hit: Bool
        let distance: Double
    }

    var body: some View {
        TimelineView(.animation) { timeline in
            content
                .onChange(of: timeline.date) { _, now in advance(to: now) }
        }
    }

    private var content: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                RealityView { content in
                    build(content)
                } update: { content in
                    _ = frame
                    sync(content)
                }
                .background(Color(red: 0.055, green: 0.070, blue: 0.175))
                .gesture(throwGesture(in: geo.size))
                .onAppear { viewSize = geo.size }
                .onChange(of: geo.size) { _, new in viewSize = new }

                header
                if let d = drag { aimReadout(d) }
                if let result { resultBanner(result) }
            }
        }
        .ignoresSafeArea()
    }

    // MARK: HUD

    private var header: some View {
        HStack {
            Text("PRACTICE")
                .font(.system(size: 15, weight: .heavy, design: .monospaced))
                .foregroundStyle(.orange)
            Spacer()
            Text("THROW AT THE TARGET")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.white.opacity(0.45))
            Spacer()
            Button(action: onDismiss) {
                Text("DONE")
                    .font(.system(size: 12, design: .monospaced).bold())
                    .foregroundStyle(.white.opacity(0.85))
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(.white.opacity(0.3), lineWidth: 1))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 18)
        .padding(.top, 14)
    }

    private func aimReadout(_ d: DragState) -> some View {
        Text(d.aborted ? "CANCEL" : "\(d.type.rawValue.uppercased()) · \(Int(d.power * 100))%")
            .font(.system(size: 13, weight: .bold, design: .monospaced))
            .foregroundStyle(d.aborted ? .white.opacity(0.5) : .orange)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Capsule().fill(.black.opacity(0.55)))
            .padding(.top, 60)
            .frame(maxWidth: .infinity)
    }

    private func resultBanner(_ r: Rep) -> some View {
        Text(r.hit ? "ON TARGET" : String(format: "%.1f M OFF TARGET", r.distance))
            .font(.system(size: 20, weight: .heavy, design: .monospaced))
            .foregroundStyle(r.hit ? Color.green : Color.orange)
            .padding(.horizontal, 20).padding(.vertical, 10)
            .background(Capsule().fill(.black.opacity(0.7)))
            .padding(.top, 96)
            .frame(maxWidth: .infinity)
    }

    // MARK: the tick

    /// One rendered frame: accumulate wall time and spend it on whole 1/120 s ticks of
    /// `disc.step`, exactly the regime the flight model is validated at (see
    /// `MatchView.advance`'s own comment on why `Engine.step` is not associative in `dt` —
    /// the same is true of `DiscState.step`, which is the same integrator).
    private func advance(to now: Date) {
        defer { frame &+= 1 }
        guard let frameDt = clock.beginFrame(at: now.timeIntervalSinceReferenceDate) else {
            return
        }

        while clock.takeTick() {
            disc.step(dt: Self.tickDt)
            // Caught once, the first tick the disc reports it touched down — mirrors
            // `Engine.stepDisc`'s own `flightSettled` latch.
            if !settled, disc.state.touchedGround {
                settled = true
                let s = disc.state
                landingPos = s.pos
                let dx = s.pos.x - Self.targetPos.x
                let dz = s.pos.z - Self.targetPos.z
                let distance = (dx * dx + dz * dz).squareRoot()
                result = Rep(hit: distance <= Self.hitRadius, distance: distance)
                resultTimeLeft = Self.resetDelay
            }
        }

        if result != nil {
            resultTimeLeft -= frameDt
            if resultTimeLeft <= 0 { resetDisc() }
        }
        clock.endFrame()
    }

    // MARK: gesture

    private func throwGesture(in size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { g in
                guard disc.mode == .held else { return }
                clock.beginCharge()
                drag = interpret(from: g.startLocation, to: g.location, in: size)
            }
            .onEnded { _ in
                defer { cancelDrag() }
                guard disc.mode == .held, let d = drag, !d.aborted else { return }
                let charge = ThrowGesture.charge(for: d.type)
                let quality = charge.quality(hold: clock.hold)
                let r = humanReleaseParams(d.type, power: d.power, quality: quality, tilt: d.loft)
                let req = ThrowRequest(
                    type: d.type, from: releaseOrigin(), aim: d.aim,
                    power: 1, angle: r.angle, spin: r.spin,
                    hand: .right, bank: r.bank, nose: r.nose, speed: r.speed)
                disc.release(req)
                settled = false
                result = nil
                landingPos = nil
            }
    }

    private func cancelDrag() {
        drag = nil
        if clock.charging { clock.endCharge() }
    }

    /// Turn a drag into a throw. Mirrors `MatchView.interpret` — same gesture, same
    /// vocabulary — with `attackDir` pinned to 1 rather than read off a live match, since
    /// the thrower here always faces the target.
    private func interpret(from start: CGPoint, to current: CGPoint, in size: CGSize) -> DragState
    {
        let dx = Double(current.x - start.x)
        let dy = Double(current.y - start.y)
        let g = ThrowGesture.interpret(
            dx: dx, dy: dy, shortEdge: Double(Swift.min(size.width, size.height)))
        let aim = ThrowGesture.aim(dx: dx, dy: dy, attackDir: 1)
        return DragState(
            start: start, current: current, type: g.type, power: g.power, loft: g.loft, aim: aim,
            aborted: Foundation.hypot(dx, dy) <= Self.cancelRadius)
    }

    /// Where the disc leaves the hand. A fixed twin of `Engine.releaseOrigin` — there is no
    /// `AIPlayer`/`Locomotion` body here to read a real stance from, so the offset uses the
    /// same magnitudes for a stationary, right-handed thrower facing the target.
    private func releaseOrigin() -> Vec3d {
        Vec3d(Self.throwerPos.x + 0.34, 1.30, Self.throwerPos.z + 0.16)
    }

    /// Put the disc back in the hand, ready for another rep.
    private func resetDisc() {
        disc.hold(0, releaseOrigin(), Vec3d(0, 1, 0))
        settled = false
        result = nil
        landingPos = nil
        resultTimeLeft = 0
    }

    // MARK: scene

    func build(_ content: RealityViewCameraContent) {
        let f = Self.fieldSpec
        content.add(PitchScene.decor(f))
        for light in PitchScene.lights(f) { content.add(light) }

        let thrower = PitchScene.player(team: 0, number: 0)
        thrower.position = [Float(Self.throwerPos.x), 0, Float(Self.throwerPos.z)]
        content.add(thrower)
        scene.thrower = thrower

        let target = PitchScene.targetRing(team: 0)
        target.position = [Float(Self.targetPos.x), 0.02, Float(Self.targetPos.z)]
        content.add(target)
        scene.target = target

        let discEntity = PitchScene.disc()
        content.add(discEntity)
        scene.disc = discEntity

        let arrow = PitchScene.aimArrow()
        arrow.isEnabled = false
        content.add(arrow)
        scene.arrow = arrow

        let mark = ModelEntity(
            mesh: .generateSphere(radius: 0.14),
            materials: [PitchScene.unlit(PitchScene.Palette.rgb(1, 1, 1), opacity: 0.9)])
        mark.isEnabled = false
        content.add(mark)
        scene.landingMark = mark

        let camera = PerspectiveCamera()
        camera.camera.fieldOfViewInDegrees = 44
        camera.look(
            at: [0, 1.2, Float((Self.throwerPos.z + Self.targetPos.z) / 2)],
            from: [0, 8, Float(Self.throwerPos.z) - 11],
            relativeTo: nil)
        content.add(camera)
        scene.camera = camera

        resetDisc()
    }

    func sync(_ content: RealityViewCameraContent) {
        if let d = scene.disc {
            let s = disc.state
            let shown = disc.mode == .held ? releaseOrigin() : Vec3d(s.pos.x, Swift.max(s.pos.y, 0.02), s.pos.z)
            d.position = [Float(shown.x), Float(shown.y), Float(shown.z)]
            let q = s.orient
            let sim = simd_quatf(ix: Float(q.x), iy: Float(q.y), iz: Float(q.z), r: Float(q.w))
            d.orientation = sim * simd_quatf(angle: .pi / 2, axis: [1, 0, 0])
        }

        if let arrow = scene.arrow {
            if let d = drag, !d.aborted, disc.mode == .held {
                let from = releaseOrigin()
                let reach = Float(4 + d.power * 30)
                arrow.isEnabled = true
                arrow.position = [Float(from.x), 0.03, Float(from.z)]
                arrow.orientation = simd_quatf(
                    angle: Float(Foundation.atan2(d.aim.x, d.aim.z)), axis: [0, 1, 0])
                if let shaft = arrow.children.first(where: { $0.name == "shaft" }) {
                    shaft.scale = [1, 1, reach]
                    shaft.position = [0, 0, reach / 2]
                }
                if let head = arrow.children.first(where: { $0.name == "head" }) {
                    head.position = [0, 0, reach + 0.4]
                }
            } else {
                arrow.isEnabled = false
            }
        }

        if let mark = scene.landingMark {
            if let landingPos, let result {
                mark.isEnabled = true
                mark.position = [Float(landingPos.x), 0.10, Float(landingPos.z)]
                mark.model?.materials = [
                    PitchScene.unlit(
                        result.hit
                            ? PitchScene.Palette.rgb(0.42, 1.0, 0.55)
                            : PitchScene.Palette.rgb(1.0, 0.55, 0.20), opacity: 0.9)
                ]
            } else {
                mark.isEnabled = false
            }
        }
    }
}

/// The handful of entities `PracticeView.sync` writes to every frame, held by reference —
/// same reasoning as `MatchScene`: a `RealityView`'s `build` and `update` closures are
/// separate, and a class is what survives the trip between them.
@available(macOS 15.0, iOS 18.0, *)
@MainActor
final class PracticeScene {
    var thrower: Entity?
    var target: Entity?
    var disc: Entity?
    var arrow: Entity?
    var landingMark: ModelEntity?
    var camera: PerspectiveCamera?
}
