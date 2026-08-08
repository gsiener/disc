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

    @State private var match: Match
    @State private var drag: DragState? = nil
    @State private var lastTick = Date()

    /// Recent disc positions while it is in the air, oldest first. Collected in the tick
    /// loop rather than in the render pass, because the render pass runs once per drawn
    /// frame and a trail should sample the flight, not the frame rate.
    @State private var trail: [SIMD3<Float>] = []

    /// Bumped once per simulated frame purely so SwiftUI knows something happened.
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
        _match = State(initialValue: Match(field: format))
    }

    public var body: some View {
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
                .id(match.field.teamSize)

                // Darkened corners. Drawn over the render and under the HUD, so it pulls
                // the eye to the middle of the pitch without ever dimming the score.
                vignette(in: geo.size).allowsHitTesting(false)

                scoreboard
                if let d = drag { aimOverlay(d, in: geo.size) }
                callout
            }
        }
        .task {
            // A display-paced loop. The disc still integrates at its own fixed 1/120
            // internally, so frame rate changes what you see and not what happens.
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(16))
                let now = Date()
                let dt = Swift.min(0.05, now.timeIntervalSince(lastTick))
                lastTick = now
                match.step(dt: dt)
                recordTrail()
                frame &+= 1
            }
        }
    }

    private func recordTrail() {
        guard case .flight = match.phase else {
            if !trail.isEmpty { trail.removeAll() }
            return
        }
        // Every other tick. Twenty-two beads at 60 Hz would be a quarter of a second of
        // flight, which reads as a smear on the disc rather than as a path it took.
        guard frame % 2 == 0 else { return }
        let p = match.disc.pos
        trail.append([Float(p.x), Float(p.y), Float(p.z)])
        if trail.count > PitchScene.trailLength { trail.removeFirst() }
    }

    // MARK: gesture

    private func throwGesture(in size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { g in
                guard match.holder != nil else { return }
                drag = interpret(from: g.startLocation, to: g.location, in: size)
                match.aiming = true
            }
            .onEnded { g in
                guard match.holder != nil, let d = drag else { return }
                match.release(d.type, aim: d.aim, power: d.power, loft: d.loft)
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
        let f = match.field
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
        let f = match.field
        let dir = Float(match.attackDirection(of: 0))
        let length = Float(f.length)
        let z = Float(match.disc.pos.z)
        // Lateral follow is deliberately partial. Full tracking centres the disc and
        // slides the pitch across the screen every time somebody runs to a sideline,
        // which reads as the world moving rather than the camera.
        let lateral = Float(match.disc.pos.x) * 0.25
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
        guard case .flight(let thrower) = match.phase else { return nil }
        let team = match.players[thrower].team
        let d = match.disc.pos
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
                    : Vec3d(match.disc.pos.x - p.pos.x, 0, match.disc.pos.z - p.pos.z)
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
            // A slow bob, so it is findable by movement as well as by colour.
            let bob = Foundation.sin(Double(frame) * 0.06) * 0.06
            chevron.position = [Float(p.pos.x), Float(2.28 + bob), Float(p.pos.z)]
        }

        if let disc = named["disc"] {
            let d = match.disc
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
            mark.position = [Float(match.disc.pos.x), 0.024, Float(match.disc.pos.z)]
            let alpha = Swift.max(0.06, 0.4 - Float(match.disc.pos.y) * 0.03)
            mark.model?.materials = [PitchScene.groundMarkMaterial(alpha)]
        }

        if let post = named["post"] {
            let inFlight: Bool = { if case .flight = match.phase { return true }; return false }()
            let h = Float(match.disc.pos.y)
            post.isEnabled = inFlight && h > 0.6
            post.position = [Float(match.disc.pos.x), h / 2, Float(match.disc.pos.z)]
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
            if simd_distance(from, want.from) > Float(match.field.length) * 0.35 {
                from = want.from
                at = want.at
            } else {
                from = simd_mix(from, want.from, SIMD3(repeating: 0.10))
                at = simd_mix(at, want.at, SIMD3(repeating: 0.10))
            }
            focus.position = at
            cam.look(at: at, from: from, relativeTo: nil)
        }
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
            } else if case .scored(let team) = match.phase {
                Text(team == 0 ? "GOAL" : "THEIR POINT")
                    .foregroundStyle(team == 0 ? .green : .orange)
            }

            Text("first to \(match.field.target)")
                .foregroundStyle(.white.opacity(0.4))

            // Both formats, because both were asked for. Switching restarts the match
            // rather than resizing the pitch underneath a live point — a disc in flight
            // towards an endzone that just moved is not a thing worth defining.
            ForEach([FieldSpec.minis, FieldSpec.full], id: \.teamSize) { spec in
                Button {
                    guard spec.teamSize != match.field.teamSize else { return }
                    match = Match(field: spec)
                    drag = nil
                    trail.removeAll()
                } label: {
                    Text("\(spec.teamSize)v\(spec.teamSize)")
                        .font(.system(size: 12, design: .monospaced).bold())
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background(
                            RoundedRectangle(cornerRadius: 5)
                                .fill(
                                    spec.teamSize == match.field.teamSize
                                        ? Color.orange : Color.white.opacity(0.12)))
                        .foregroundStyle(
                            spec.teamSize == match.field.teamSize ? .black : .white.opacity(0.7))
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

    /// The one thing worth interrupting the pitch for.
    @ViewBuilder private var callout: some View {
        if case .scored(let team) = match.phase {
            VStack(spacing: 3) {
                Text(team == 0 ? "GOAL" : "THEIR POINT")
                    .font(.system(size: 30, weight: .heavy, design: .monospaced))
                    .foregroundStyle(team == 0 ? Color(red: 0.5, green: 1, blue: 0.62) : .orange)
                Text("\(match.score[0]) — \(match.score[1])")
                    .font(.system(size: 16, design: .monospaced).bold())
                    .foregroundStyle(.white.opacity(0.75))
            }
            .padding(.horizontal, 22).padding(.vertical, 12)
            // A plate rather than a drop shadow. The first version was 46pt of unbacked
            // text across the middle of the pitch: it announced the goal and hid the
            // players who had just scored it.
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
