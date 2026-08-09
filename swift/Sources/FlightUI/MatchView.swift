import Foundation
import RealityKit
import SwiftUI
import UltimateSim

/// The game, as a thing you can play with a thumb.
///
/// Control follows the disc. You are always the player with a decision to make: hold the
/// disc and you are the thrower, catch it and you become the catcher. That was a
/// deliberate choice over pinning the camera to one player, which would make the other
/// five scenery and would mean the interesting moment — the catch — is the moment your
/// player stops mattering.
///
/// The throw is one gesture. Drag from the thrower: **direction** is where you drag,
/// **distance** is power, and **the throw type** is chosen by how far up or down the
/// screen you finish, because that is the axis that maps to what a throw does. A flat
/// drag is a backhand or forehand; dragging high gives the overheads that go up and over
/// a mark. Release to throw. Nothing here is a menu, because a menu is time and a mark
/// does not give you any.
///
/// What the scene looks like lives in `PitchScene`. This file owns the match, the
/// gesture, and the mapping from one to the other.
@available(macOS 15.0, iOS 18.0, *)
public struct MatchView: View {
    /// Starting format. A parameter rather than a constant for the same reason the app's
    /// initial tab is one: `simctl` can launch with arguments but cannot tap, so anything
    /// only reachable by finger is something that stops being looked at.
    private let startFormat: FieldSpec

    @State private var match: Engine
    @State private var drag: DragState? = nil

    /// The seed this match was built from. Freshly drawn from the clock for every new
    /// match — including the format-switch restart — so no two launches replay the same
    /// wind and rosters. Deliberately not shown anywhere yet; it is kept so a later
    /// result screen can display it, and so the match stays a pure function of
    /// `(format, seed, inputs)` exactly as `Replay.swift` requires. All randomness
    /// enters the engine through this one number.
    @State private var seed: UInt32

    // MARK: fixed-tick clock state
    //
    // The sim is advanced only in whole 1/120 s ticks; see the long comment on `body`'s
    // tick driver below and Sources/UltimateSim/Play/Replay.swift:19-56 for why.

    /// The moment the previous display frame arrived, if one has.
    @State private var lastFrame: Date? = nil
    /// Wall-clock seconds owed to the simulation but not yet spent on whole ticks.
    /// Clamped to `Self.maxAccumulated` so a hitch slows the game instead of
    /// fast-forwarding it.
    @State private var accumulator = 0.0
    /// Whole simulation ticks executed so far. The trail sampler keys off this, because
    /// the trail should sample the flight, not the display.
    @State private var tickCount = 0
    /// Duration of the last rendered frame, in seconds. Feeds the camera's time-based
    /// easing so a 120 Hz ProMotion display eases at the same speed as a 60 Hz one.
    @State private var frameDt = 1.0 / 60.0
    /// Phase for the chevron's bob, advanced by wall time rather than by frame count so
    /// the bob speed does not depend on the display's refresh rate.
    @State private var bobPhase = 0.0

    /// The one and only step the simulation is advanced by. 1/120 is the regime the
    /// entire validation suite runs at (see `Replay.swift`), so it is the regime the
    /// shipped game runs at.
    private static let tickDt = 1.0 / 120.0
    /// The most wall time the accumulator will hold — 0.25 s, i.e. 30 ticks of catch-up
    /// per frame at most. Anything beyond it (backgrounding, a debugger pause, a long
    /// hitch) is dropped rather than replayed, so a stall can never spiral.
    private static let maxAccumulated = 0.25

    /// Recent disc positions while it is in the air, oldest first. Collected in the tick
    /// loop rather than in the render pass, because the render pass runs once per drawn
    /// frame and a trail should sample the flight, not the frame rate.
    @State private var trail: [SIMD3<Float>] = []

    /// Watches the box score for turnovers, one diff per tick. See `MatchOverlays.swift`
    /// for why this is a diff and not a subscription: the engine's event emitter is
    /// spoken for before any view exists.
    @State private var turnoverWatch = TurnoverWatch()
    /// The turnover being shouted about, while there is one. Its `timeLeft` is burned
    /// down by wall time in `advance`, so the shout lasts 1.5 s at any refresh rate.
    @State private var turnoverFlash: TurnoverFlash? = nil

    /// Bumped once per rendered frame purely so SwiftUI knows something happened.
    ///
    /// `Match` is a `final class` — deliberately, since passing a match around must not
    /// silently copy it — and SwiftUI does not observe mutations through a class
    /// reference. Without this the sim ticks correctly and the screen never redraws,
    /// which looks exactly like a frozen simulation and is not one. The frame counter is
    /// the honest fix: the view depends on the tick, and the tick depends on the clock.
    @State private var frame = 0

    /// A drag in progress, in view coordinates plus the throw it currently means.
    private struct DragState {
        var start: CGPoint
        var current: CGPoint
        var type: ThrowType
        var power: Double
        var loft: Double
        /// The world direction this drag currently means. Stored at interpretation time
        /// so the scene's aim arrow and the eventual release are the same number, and so
        /// nothing downstream has to know about view coordinates.
        var aim: Vec3d
    }

    public init(format: FieldSpec = .minis) {
        startFormat = format
        let s = Self.freshSeed()
        _seed = State(initialValue: s)
        _match = State(initialValue: Engine(format: format.gameFormat, seed: s))
    }

    /// A seed for a new match, drawn from the clock. The engine stays fully
    /// deterministic — replay a match by constructing an `Engine` with the same seed —
    /// but each *new* match gets its own wind and rosters instead of the compiled-in
    /// default that made every launch identical.
    private static func freshSeed() -> UInt32 {
        UInt32(truncatingIfNeeded: DispatchTime.now().uptimeNanoseconds)
    }

    public var body: some View {
        // The tick driver. `TimelineView(.animation)` re-evaluates once per rendered
        // frame, paced by the display on both platforms this target builds for, and the
        // `onChange` below turns each frame into zero or more *fixed* 1/120 s steps.
        //
        // Why fixed and not "whatever the wall clock measured": `Engine.step` is not
        // associative in `dt` — see Sources/UltimateSim/Play/Replay.swift:19-56.
        // `Locomotion` decays gait with `exp(-k * dt)` once per call and clamps a `dt`
        // above 1/30 outright, `TeamAI` decides once per call, the stall accumulates in
        // whole `dt`s — so `step(0.02)` is a *different simulation* from `step(0.01)`
        // twice, and the 2.2M-assertion validation suite runs entirely at 1/120. The
        // shipped game must run the same regime, or it ships a physics nobody validated.
        // Wall time therefore decides only *how many* whole ticks run, never how big
        // they are; the leftover fraction of a frame stays in `accumulator`, outside
        // the simulation, where nothing the sim computes can read it.
        TimelineView(.animation) { timeline in
            matchContent
                .onChange(of: timeline.date) { _, now in
                    advance(to: now)
                }
        }
    }

    private var matchContent: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                RealityView { content in
                    build(content)
                } update: { content in
                    // Reading `frame` is what subscribes this closure to the clock.
                    _ = frame
                    sync(content)
                }
                .background(Color(red: 0.055, green: 0.070, blue: 0.175))
                .gesture(throwGesture(in: geo.size))
                // The scene is built once, with one entity per player. Changing format
                // changes how many players there are, so the scene has to be rebuilt
                // rather than synced — without this, switching to 7v7 leaves eight
                // players with no body to move.
                .id(match.fieldSpec.teamSize)

                // Darkened corners. Drawn over the render and under the HUD, so it pulls
                // the eye to the middle of the pitch without ever dimming the score.
                vignette(in: geo.size).allowsHitTesting(false)

                scoreboard
                if let d = drag { aimOverlay(d, in: geo.size) }
                callout

                // Full time. Drawn over everything, including the callouts — once the
                // game is over the only interesting fact left is the result, and the
                // only interesting input left is the rematch button.
                if match.isOver {
                    ResultOverlay(match: match) { restart(match.fieldSpec) }
                }
            }
        }
    }

    /// One rendered frame's worth of simulation: accumulate the wall time since the
    /// previous frame and spend it on whole 1/120 s ticks. Rendering happens every
    /// frame regardless of how many ticks ran — including zero, when a frame arrives
    /// before a full tick's worth of wall time has accrued — so frame rate changes
    /// what you see, never what happens.
    private func advance(to now: Date) {
        defer {
            lastFrame = now
            // The redraw subscription: `sync` reads this, so bumping it once per frame
            // is what keeps the RealityView following the sim (and the eased camera
            // moving even on frames where no tick ran).
            frame &+= 1
        }
        guard let last = lastFrame else { return }
        let wallDt = now.timeIntervalSince(last)
        // A hiccup — a suspended app resuming, a clock adjustment — must not poison a
        // simulation that never reads a clock.
        guard wallDt.isFinite, wallDt > 0 else { return }

        frameDt = Swift.min(wallDt, Self.maxAccumulated)
        bobPhase += frameDt * 3.6

        // Clamp the *accumulated* debt, not just this frame's: a hitch or a spell in
        // the background yields at most 0.25 s (30 ticks) of catch-up, and the rest is
        // dropped. The game slows down for a moment instead of fast-forwarding, and a
        // slow frame can never demand enough ticks to cause the next slow frame.
        accumulator = Swift.min(accumulator + wallDt, Self.maxAccumulated)
        while accumulator >= Self.tickDt {
            accumulator -= Self.tickDt
            match.step(dt: Self.tickDt)
            tickCount &+= 1
            recordTrail()
            // At most one turnover fits in a tick, so checking per tick — rather than
            // per frame — means a catch-up burst cannot swallow one.
            if let flash = turnoverWatch.check(match) { turnoverFlash = flash }
        }

        // The callout clock runs on wall time, outside the simulation, like everything
        // else that is display and not physics.
        if var flash = turnoverFlash {
            flash.timeLeft -= frameDt
            turnoverFlash = flash.timeLeft > 0 ? flash : nil
        }
    }

    private func recordTrail() {
        guard match.discInFlight else {
            if !trail.isEmpty { trail.removeAll() }
            return
        }
        // Every fourth tick — 30 Hz of flight, the same cadence the old 60 Hz loop's
        // every-other-frame sampling gave. Twenty-two beads at 60 Hz would be a quarter
        // of a second of flight, which reads as a smear on the disc rather than as a
        // path it took.
        guard tickCount % 4 == 0 else { return }
        let p = match.disc.state.pos
        trail.append([Float(p.x), Float(p.y), Float(p.z)])
        if trail.count > PitchScene.trailLength { trail.removeFirst() }
    }

    // MARK: gesture

    private func throwGesture(in size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { g in
                guard match.holder != nil else { return }
                drag = interpret(from: g.startLocation, to: g.location, in: size)
            }
            .onEnded { g in
                guard match.holder != nil, let d = drag else { return }
                match.humanRelease(d.type, aim: d.aim, power: d.power, loft: d.loft)
                drag = nil
            }
    }

    /// Turn a drag into a throw. The rule itself lives in `ThrowGesture`, in the sim,
    /// where the checks can reach it — this only supplies the numbers.
    private func interpret(from start: CGPoint, to current: CGPoint, in size: CGSize) -> DragState {
        let dx = Double(current.x - start.x)
        let dy = Double(current.y - start.y)
        let g = ThrowGesture.interpret(
            dx: dx, dy: dy, shortEdge: Double(Swift.min(size.width, size.height)))
        let aim = ThrowGesture.aim(dx: dx, dy: dy, attackDir: match.attackDirection(of: 0))
        return DragState(
            start: start, current: current, type: g.type, power: g.power, loft: g.loft, aim: aim)
    }

    // MARK: scene

    private func build(_ content: RealityViewCameraContent) {
        let f = match.fieldSpec
        content.add(PitchScene.decor(f))

        let players = Entity()
        players.name = "players"
        let rings = Entity()
        rings.name = "rings"
        let targets = Entity()
        targets.name = "targets"
        for (i, p) in match.players.enumerated() {
            // A jersey number per player. Derived from the roster slot so a replay of the
            // same seed puts the same number on the same runner.
            players.addChild(PitchScene.player(team: p.team, number: jersey(i)))
            let ring = PitchScene.controlRing()
            ring.isEnabled = false
            rings.addChild(ring)
            let target = PitchScene.targetRing(team: p.team)
            target.isEnabled = false
            targets.addChild(target)
        }
        content.add(players)
        content.add(rings)
        content.add(targets)

        let chevron = PitchScene.chevron()
        chevron.name = "chevron"
        content.add(chevron)

        let disc = PitchScene.disc()
        disc.name = "disc"
        content.add(disc)

        let mark = PitchScene.groundMark()
        mark.name = "discMark"
        content.add(mark)

        let post = PitchScene.altitudePost()
        post.name = "post"
        post.isEnabled = false
        content.add(post)

        let trailRoot = PitchScene.trail()
        trailRoot.name = "trail"
        content.add(trailRoot)

        let arrow = PitchScene.aimArrow()
        arrow.name = "aim"
        arrow.isEnabled = false
        content.add(arrow)

        for light in PitchScene.lights(f) { content.add(light) }

        // Behind-and-above the attacking direction, which for Ultimate is the view that
        // shows the field the thrower is throwing into. High enough that the whole pitch
        // fits without needing to pan, because a camera that moves while you are aiming
        // changes what your drag means mid-gesture.
        let camera = PerspectiveCamera()
        // A slightly longer lens than the 50° this started with. At 50 the pitch was a
        // small trapezoid in the middle of the frame with a third of the screen given
        // over to grass nobody plays on. 38 was better still for the pitch and pushed the
        // horizon off the top, which threw away the sky; 44 keeps both.
        camera.camera.fieldOfViewInDegrees = 44
        camera.name = "camera"
        content.add(camera)

        // The eased look-at point, parked in the scene graph rather than in `@State`.
        // Rebuilding the scene has to reset the camera's easing along with everything
        // else, and scene-graph state resets for free; view state does not.
        let focus = Entity()
        focus.name = "camFocus"
        let want = cameraTarget()
        focus.position = want.at
        camera.look(at: want.at, from: want.from, relativeTo: nil)
        content.add(focus)
    }

    /// Squad numbers. Arbitrary, but stable and not sequential, because 1-2-3-4-5-6 reads
    /// as a diagram and 4-7-11-23 reads as a team.
    private func jersey(_ index: Int) -> Int {
        let numbers = [4, 7, 11, 23, 2, 18, 9, 31, 5, 14, 8, 21, 3, 27]
        return numbers[index % numbers.count]
    }

    /// Where the camera wants to be. Behind the attacking direction, at about the height
    /// of a low stand.
    ///
    /// The first attempt put the camera at 0.62 of the field length up and looked at the
    /// centre. That is a tactics board, not a broadcast: from near-overhead a standing
    /// player foreshortens into a disc on the grass, and you lose the one thing a 3D view
    /// buys over a top-down one, which is being able to see how high the disc is.
    ///
    /// So: low enough that players stand up in frame, aimed downfield of the disc rather
    /// than at the centre circle, because the space you are throwing into is the part
    /// worth looking at. It tracks the disc laterally as well, so play on a sideline is
    /// not permanently in the corner of the screen.
    ///
    /// It is anchored to the disc rather than to a fraction of the disc's position, which
    /// is what the first version did. At 0.35 of the disc's z the camera hung around the
    /// middle of the pitch and a thrower on their own end line was cut in half by the
    /// bottom of the screen; the offsets below hold the disc at a constant two-thirds of
    /// the way down the frame wherever play is, which is both readable and steadier to
    /// watch. It still does not move while you aim, because a held disc does not move.
    private func cameraTarget() -> (from: SIMD3<Float>, at: SIMD3<Float>) {
        let f = match.fieldSpec
        let dir = Float(match.attackDirection(of: 0))
        let length = Float(f.length)
        let z = Float(match.disc.state.pos.z)
        // Lateral follow is deliberately partial. Full tracking centres the disc and
        // slides the pitch across the screen every time somebody runs to a sideline,
        // which reads as the world moving rather than the camera.
        let lateral = Float(match.disc.state.pos.x) * 0.25
        return (
            from: [lateral, length * 0.26, z - dir * length * 0.44],
            at: [lateral, 1.2, z + dir * length * 0.27]
        )
    }

    /// The teammate a live throw is heading for, if there is one.
    ///
    /// "Nearest to the disc right now" rather than a predicted landing point: predicting
    /// would mean re-integrating the flight here, and a second copy of the flight model
    /// in the renderer is exactly the thing this project refuses to have.
    private var incomingReceiver: Int? {
        guard let thrower = match.thrower,
            let team = match.players.first(where: { $0.id == thrower })?.team
        else { return nil }
        let d = match.disc.state.pos
        return match.players.indices
            .filter { match.players[$0].team == team && $0 != thrower }
            .min {
                Foundation.hypot(match.players[$0].pos.x - d.x, match.players[$0].pos.z - d.z)
                    < Foundation.hypot(match.players[$1].pos.x - d.x, match.players[$1].pos.z - d.z)
            }
    }

    private func sync(_ content: RealityViewCameraContent) {
        let named = Dictionary(
            content.entities.compactMap { $0.name.isEmpty ? nil : ($0.name, $0) },
            uniquingKeysWith: { a, _ in a })

        let receiver = incomingReceiver

        if let players = named["players"], let rings = named["rings"],
            let targets = named["targets"]
        {
            for (i, p) in match.players.enumerated() where i < players.children.count {
                let body = players.children[i]
                body.position = [Float(p.pos.x), 0, Float(p.pos.z)]
                // Face the way you are running; if stationary, face the disc.
                let facing =
                    p.vel.lengthSq > 0.04
                    ? p.vel
                    : Vec3d(match.disc.state.pos.x - p.pos.x, 0, match.disc.state.pos.z - p.pos.z)
                if facing.lengthSq > 1e-6 {
                    let yaw = Foundation.atan2(facing.x, facing.z)
                    // Lean into the run. Purely cosmetic and bounded at about ten
                    // degrees: it is what separates a sprint from a glide at a glance,
                    // and it pivots about the feet so nobody sinks into the pitch.
                    let lean = Float(Swift.min(1, p.vel.length / 7.0)) * 0.18
                    body.orientation =
                        simd_quatf(angle: Float(yaw), axis: [0, 1, 0])
                        * simd_quatf(angle: lean, axis: [1, 0, 0])
                }
                if i < rings.children.count {
                    let ring = rings.children[i]
                    ring.position = [Float(p.pos.x), 0.022, Float(p.pos.z)]
                    ring.isEnabled = (i == match.controlled)
                }
                if i < targets.children.count {
                    let target = targets.children[i]
                    target.position = [Float(p.pos.x), 0.018, Float(p.pos.z)]
                    target.isEnabled = (i == receiver)
                }
            }
        }

        if let chevron = named["chevron"], match.controlled < match.players.count {
            let p = match.players[match.controlled]
            // A slow bob, so it is findable by movement as well as by colour. Phased by
            // wall time (advanced in `advance`), not by frame count, so it bobs at the
            // same speed on a 120 Hz display as on a 60 Hz one.
            let bob = Foundation.sin(bobPhase) * 0.06
            chevron.position = [Float(p.pos.x), Float(2.28 + bob), Float(p.pos.z)]
        }

        if let disc = named["disc"] {
            let d = match.disc.state
            // A held disc sits at the holder's own position, which puts it inside their
            // torso and therefore invisible — you could not tell who had it. Offset it to
            // an extended arm for display only; the sim's position is untouched, so
            // nothing about the throw or the catch changes.
            var shown = Vec3d(d.pos.x, Swift.max(d.pos.y, 0.02), d.pos.z)
            if let h = match.holder {
                let p = match.players[h]
                // Out to the side, away from the middle of the pitch, the way a thrower
                // holds it away from the mark.
                let side = p.pos.x >= 0 ? 1.0 : -1.0
                shown = Vec3d(p.pos.x + side * 0.42, 1.15, p.pos.z + 0.16)
            }
            disc.position = [Float(shown.x), Float(shown.y), Float(shown.z)]
            // The sim's body +Z is the disc normal; a RealityKit cylinder's axis is +Y.
            // One fixed quarter turn reconciles them and nothing else is corrected, which
            // is what makes this a rendering of the simulation rather than an animation
            // that resembles one.
            let q = d.orient
            let sim = simd_quatf(ix: Float(q.x), iy: Float(q.y), iz: Float(q.z), r: Float(q.w))
            disc.orientation = sim * simd_quatf(angle: .pi / 2, axis: [1, 0, 0])
        }

        if let mark = named["discMark"] as? ModelEntity {
            mark.position = [Float(match.disc.state.pos.x), 0.024, Float(match.disc.state.pos.z)]
            let alpha = Swift.max(0.06, 0.4 - Float(match.disc.state.pos.y) * 0.03)
            mark.model?.materials = [PitchScene.groundMarkMaterial(alpha)]
        }

        if let post = named["post"] {
            let inFlight = match.discInFlight
            let h = Float(match.disc.state.pos.y)
            post.isEnabled = inFlight && h > 0.6
            post.position = [Float(match.disc.state.pos.x), h / 2, Float(match.disc.state.pos.z)]
            post.scale = [1, Swift.max(h, 0.001), 1]
        }

        if let trailRoot = named["trail"] {
            // Slot 0 holds the oldest sample and has the faintest material, so the trail
            // is filled from the end of the array backwards.
            let n = trailRoot.children.count
            for slot in 0..<n {
                let idx = trail.count - n + slot
                if idx >= 0 && idx < trail.count {
                    trailRoot.children[slot].position = trail[idx]
                    trailRoot.children[slot].isEnabled = true
                } else {
                    trailRoot.children[slot].isEnabled = false
                }
            }
        }

        if let arrow = named["aim"] {
            if let d = drag, let h = match.holder {
                let p = match.players[h]
                // Roughly how far this power carries. An approximation on purpose — the
                // exact range needs the aero solved, and a arrow that lies by a metre is
                // still worth more than no arrow.
                let reach = Float(4 + d.power * 30)
                arrow.isEnabled = true
                arrow.position = [Float(p.pos.x), 0.03, Float(p.pos.z)]
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

        if let cam = named["camera"] as? PerspectiveCamera, let focus = named["camFocus"] {
            let want = cameraTarget()
            var from = cam.position
            var at = focus.position
            // Ease, except when the whole view is supposed to change — a turnover that
            // swaps ends should cut, not sweep the camera the length of the pitch.
            if simd_distance(from, want.from) > Float(match.fieldSpec.length) * 0.35 {
                from = want.from
                at = want.at
            } else {
                // Time-based exponential smoothing. The old constant here was 0.10 per
                // frame, which assumed 60 fps frames — on a 120 Hz ProMotion display it
                // would ease twice as fast. `1 - exp(-rate * frameDt)` converges to the
                // same curve at any refresh rate; rate = 60 * -ln(0.9) ≈ 6.32 /s is
                // exactly what 0.10-per-frame was at 60 fps.
                let blend = Float(1 - Foundation.exp(-6.32 * frameDt))
                from = simd_mix(from, want.from, SIMD3(repeating: blend))
                at = simd_mix(at, want.at, SIMD3(repeating: blend))
            }
            focus.position = at
            cam.look(at: at, from: from, relativeTo: nil)
        }
    }

    /// Tear the match down and start a new one on `spec`'s pitch. Both restarts — the
    /// format switch and the rematch button — come through here, so neither can forget
    /// a piece of per-match state.
    ///
    /// A restart is a new match, so it draws a new seed — otherwise restarting would be
    /// the one path back to the compiled-in default and its identical wind and rosters.
    private func restart(_ spec: FieldSpec) {
        seed = Self.freshSeed()
        match = Engine(format: spec.gameFormat, seed: seed)
        drag = nil
        trail.removeAll()
        tickCount = 0
        accumulator = 0
        turnoverWatch = TurnoverWatch()
        turnoverFlash = nil
    }

    // MARK: hud

    /// Corner darkening. Cheap, and it does most of the work of making a flat green
    /// rectangle look photographed rather than drawn. Sized from the view rather than a
    /// constant, so it lands in the same place on a phone and on an iPad.
    private func vignette(in size: CGSize) -> some View {
        RadialGradient(
            gradient: Gradient(stops: [
                .init(color: .clear, location: 0.42),
                .init(color: .black.opacity(0.14), location: 0.74),
                .init(color: .black.opacity(0.42), location: 1.0),
            ]),
            center: .center, startRadius: 0,
            endRadius: Foundation.hypot(size.width, size.height) * 0.58
        )
        .ignoresSafeArea()
    }

    private var scoreboard: some View {
        HStack(spacing: 14) {
            Text("YOU \(match.score[0])")
                .foregroundStyle(Color(red: 0.45, green: 0.72, blue: 1))
            Text("—").foregroundStyle(.white.opacity(0.35))
            Text("\(match.score[1]) THEM")
                .foregroundStyle(Color(red: 1, green: 0.48, blue: 0.42))

            Spacer()

            // The stall count is the clock that matters, so it is the one that is shown.
            // It only exists while someone is holding, which is also the only time it
            // means anything.
            if match.holder != nil {
                Text("STALL \(Int(match.stall))")
                    .foregroundStyle(match.stall > 6 ? .orange : .white.opacity(0.7))
            } else if let team = match.justScored {
                Text(team == 0 ? "GOAL" : "THEIR POINT")
                    .foregroundStyle(team == 0 ? .green : .orange)
            }

            Text("first to \(match.fieldSpec.target)")
                .foregroundStyle(.white.opacity(0.4))

            // Both formats, because both were asked for. Switching restarts the match
            // rather than resizing the pitch underneath a live point — a disc in flight
            // towards an endzone that just moved is not a thing worth defining.
            ForEach([FieldSpec.minis, FieldSpec.full], id: \.teamSize) { spec in
                Button {
                    guard spec.teamSize != match.fieldSpec.teamSize else { return }
                    restart(spec)
                } label: {
                    Text("\(spec.teamSize)v\(spec.teamSize)")
                        .font(.system(size: 12, design: .monospaced).bold())
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background(
                            RoundedRectangle(cornerRadius: 5)
                                .fill(
                                    spec.teamSize == match.fieldSpec.teamSize
                                        ? Color.orange : Color.white.opacity(0.12)))
                        .foregroundStyle(
                            spec.teamSize == match.fieldSpec.teamSize ? .black : .white.opacity(0.7))
                }
                .buttonStyle(.plain)
            }
        }
        .font(.system(.subheadline, design: .monospaced).bold())
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        // A backing plate, because the sky behind the top of the screen is now a dusk
        // gradient rather than near-black and white-on-orange is not a score you can read.
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(.black.opacity(0.45))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(.white.opacity(0.10), lineWidth: 1))
        )
        .padding(.horizontal, 16)
        .padding(.top, 12)
    }

    /// The two things worth interrupting the pitch for: a point, and the turnover that
    /// prevented one. A goal outranks a turnover — a Callahan is both at once, and the
    /// score is the half worth shouting.
    @ViewBuilder private var callout: some View {
        if let team = match.justScored {
            calloutPlate(
                title: team == 0 ? "GOAL" : "THEIR POINT",
                tint: team == 0 ? Color(red: 0.5, green: 1, blue: 0.62) : .orange,
                subtitle: "\(match.score[0]) — \(match.score[1])")
        } else if let flash = turnoverFlash {
            calloutPlate(
                title: flash.text,
                tint: flash.good ? Color(red: 0.5, green: 1, blue: 0.62) : .orange,
                subtitle: flash.good ? "YOUR DISC" : "THEY HAVE IT")
        }
    }

    /// The shared shout. A plate rather than a drop shadow: the first version was 46pt
    /// of unbacked text across the middle of the pitch — it announced the goal and hid
    /// the players who had just scored it.
    private func calloutPlate(title: String, tint: Color, subtitle: String) -> some View {
        VStack(spacing: 3) {
            Text(title)
                .font(.system(size: 30, weight: .heavy, design: .monospaced))
                .foregroundStyle(tint)
            Text(subtitle)
                .font(.system(size: 16, design: .monospaced).bold())
                .foregroundStyle(.white.opacity(0.75))
        }
        .padding(.horizontal, 22).padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(.black.opacity(0.5))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(.white.opacity(0.10), lineWidth: 1)))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(false)
        .transition(.opacity)
    }

    /// The aim line. Drawn in view space rather than in the scene because it is a
    /// statement about your gesture, not about the world — and because it must be legible
    /// against turf at any camera distance. The world-space half of the answer, the arrow
    /// on the grass, is in `PitchScene`.
    private func aimOverlay(_ d: DragState, in size: CGSize) -> some View {
        ZStack {
            Path { p in
                p.move(to: d.start)
                p.addLine(to: d.current)
            }
            .stroke(.black.opacity(0.45), style: StrokeStyle(lineWidth: 7, lineCap: .round))

            Path { p in
                p.move(to: d.start)
                p.addLine(to: d.current)
            }
            .stroke(
                LinearGradient(
                    colors: [.orange.opacity(0.25), .orange],
                    startPoint: .top, endPoint: .bottom),
                style: StrokeStyle(lineWidth: 4, lineCap: .round))

            // The anchor, so it is obvious the throw comes from where you started and not
            // from where your thumb happens to be.
            Circle()
                .strokeBorder(.orange.opacity(0.7), lineWidth: 2)
                .frame(width: 22, height: 22)
                .position(d.start)

            VStack(spacing: 3) {
                Text("\(d.type.rawValue.uppercased())  \(Int(d.power * 100))%")
                    .font(.system(size: 13, design: .monospaced).bold())
                Capsule()
                    .fill(.orange.opacity(0.25))
                    .frame(width: 74, height: 4)
                    .overlay(alignment: .leading) {
                        Capsule().fill(.orange).frame(width: 74 * d.power, height: 4)
                    }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 7).fill(.black.opacity(0.7)))
            .foregroundStyle(.orange)
            .position(x: d.current.x, y: d.current.y - 34)
        }
        .allowsHitTesting(false)
    }
}
