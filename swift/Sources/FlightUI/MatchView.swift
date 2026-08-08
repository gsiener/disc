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
@available(macOS 15.0, iOS 18.0, *)
public struct MatchView: View {
    @State private var match = Match(field: .minis)
    @State private var drag: DragState? = nil
    @State private var lastTick = Date()

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
    }

    public init() {}

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
                .background(Color(red: 0.05, green: 0.07, blue: 0.09))
                .gesture(throwGesture(in: geo.size))

                scoreboard
                if let d = drag { aimOverlay(d, in: geo.size) }
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
                frame &+= 1
            }
        }
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
                let aim = aimVector(d, in: size)
                match.release(d.type, aim: aim, power: d.power, loft: d.loft)
                drag = nil
            }
    }

    /// Turn a drag into a throw. The rule itself lives in `ThrowGesture`, in the sim,
    /// where the checks can reach it — this only supplies the numbers.
    private func interpret(from start: CGPoint, to current: CGPoint, in size: CGSize) -> DragState {
        let g = ThrowGesture.interpret(
            dx: Double(current.x - start.x),
            dy: Double(current.y - start.y),
            shortEdge: Double(Swift.min(size.width, size.height)))
        return DragState(start: start, current: current, type: g.type, power: g.power, loft: g.loft)
    }

    private func aimVector(_ d: DragState, in size: CGSize) -> Vec3d {
        ThrowGesture.aim(
            dx: Double(d.current.x - d.start.x),
            dy: Double(d.current.y - d.start.y),
            attackDir: match.attackDirection(of: 0))
    }

    // MARK: scene

    private func build(_ content: RealityViewCameraContent) {
        let f = match.field

        let turf = ModelEntity(
            mesh: .generatePlane(width: Float(f.width), depth: Float(f.length)),
            materials: [SimpleMaterial(color: .init(red: 0.16, green: 0.34, blue: 0.18, alpha: 1), roughness: 0.9, isMetallic: false)])
        content.add(turf)

        // Goal lines, and a brighter pair of end lines. Drawn as thin planes rather than
        // a texture because there are no binary assets in this project.
        for z in [-f.goalLine, f.goalLine] {
            let line = ModelEntity(
                mesh: .generatePlane(width: Float(f.width), depth: 0.14),
                materials: [UnlitMaterial(color: .init(white: 0.9, alpha: 0.8))])
            line.position = [0, 0.012, Float(z)]
            content.add(line)
        }
        for x in [-f.sideline, f.sideline] {
            let line = ModelEntity(
                mesh: .generatePlane(width: 0.14, depth: Float(f.length)),
                materials: [UnlitMaterial(color: .init(white: 0.9, alpha: 0.55))])
            line.position = [Float(x), 0.012, 0]
            content.add(line)
        }

        // Players. A capsule is enough to read position, team and facing at this camera
        // distance, and it costs nothing to replace later — the sim does not know or
        // care what a player looks like.
        for p in match.players {
            let kit = SimpleMaterial(color: teamColor(p.team), roughness: 0.6, isMetallic: false)

            // Torso, head, and a small chest plate that sticks out the front. The plate
            // is the only reason the shape is not a plain cylinder: at this camera
            // distance you cannot read which way a cylinder faces, and which way a
            // player is facing is most of what you need to know about them.
            let body = Entity()
            body.name = "player\(p.id)"

            let torso = ModelEntity(mesh: .generateCylinder(height: 1.25, radius: 0.28), materials: [kit])
            torso.position = [0, 0.62, 0]
            body.addChild(torso)

            let head = ModelEntity(
                mesh: .generateSphere(radius: 0.16),
                materials: [SimpleMaterial(color: .init(white: 0.82, alpha: 1), roughness: 0.7, isMetallic: false)])
            head.position = [0, 1.42, 0]
            body.addChild(head)

            let chest = ModelEntity(mesh: .generateBox(size: [0.30, 0.34, 0.12]), materials: [kit])
            chest.position = [0, 0.95, 0.24]
            body.addChild(chest)

            body.position = [Float(p.pos.x), 0, Float(p.pos.z)]
            content.add(body)

            // A ring under whoever you are controlling, so "which one am I" is never a
            // question you have to stop and answer.
            let ring = ModelEntity(
                mesh: .generateCylinder(height: 0.02, radius: 0.62),
                materials: [UnlitMaterial(color: .init(red: 1, green: 0.72, blue: 0.15, alpha: 0.9))])
            ring.name = "ring\(p.id)"
            ring.position = [Float(p.pos.x), 0.02, Float(p.pos.z)]
            ring.isEnabled = false
            content.add(ring)
        }

        let bodySpec = DiscBody.standard
        let disc = ModelEntity(
            mesh: .generateCylinder(height: Float(bodySpec.halfHeight * 2), radius: Float(bodySpec.radius)),
            materials: [SimpleMaterial(color: .init(white: 0.96, alpha: 1), roughness: 0.35, isMetallic: false)])
        disc.name = "disc"
        content.add(disc)

        let shadow = ModelEntity(
            mesh: .generateCylinder(height: 0.01, radius: Float(bodySpec.radius * 0.9)),
            materials: [UnlitMaterial(color: .init(white: 0, alpha: 0.35))])
        shadow.name = "discShadow"
        content.add(shadow)

        let sun = DirectionalLight()
        sun.light.intensity = 6500
        sun.light.color = .init(red: 1.0, green: 0.96, blue: 0.88, alpha: 1)
        sun.shadow = DirectionalLightComponent.Shadow()
        sun.look(at: [0, 0, 0], from: [-18, 34, -14], relativeTo: nil)
        content.add(sun)

        // Behind-and-above the attacking direction, which for Ultimate is the view that
        // shows the field the thrower is throwing into. High enough that the whole pitch
        // fits without needing to pan, because a camera that moves while you are aiming
        // changes what your drag means mid-gesture.
        let camera = PerspectiveCamera()
        camera.camera.fieldOfViewInDegrees = 50
        camera.name = "camera"
        content.add(camera)
        place(camera)
    }

    /// Behind the attacking direction, at about the height of a low stand.
    ///
    /// The first attempt put the camera at 0.62 of the field length up and looked at the
    /// centre. That is a tactics board, not a broadcast: from near-overhead a standing
    /// player foreshortens into a disc on the grass, and you lose the one thing a 3D view
    /// buys over a top-down one, which is being able to see how high the disc is.
    ///
    /// So: low enough that players stand up in frame, aimed downfield of the disc rather
    /// than at the centre circle, because the space you are throwing into is the part
    /// worth looking at.
    private func place(_ camera: PerspectiveCamera) {
        let f = match.field
        let dir = Float(match.attackDirection(of: 0))
        let focus = Float(match.disc.pos.z) * 0.35
        camera.look(
            at: [0, 1.2, focus + dir * Float(f.length) * 0.16],
            from: [0, Float(f.length) * 0.26, focus - dir * Float(f.length) * 0.56],
            relativeTo: nil)
    }

    private func teamColor(_ team: Int) -> UIOrNSColor {
        team == 0
            ? .init(red: 0.20, green: 0.55, blue: 0.95, alpha: 1)
            : .init(red: 0.93, green: 0.32, blue: 0.26, alpha: 1)
    }

    private func sync(_ content: RealityViewCameraContent) {
        for p in match.players {
            if let e = content.entities.first(where: { $0.name == "player\(p.id)" }) {
                e.position = [Float(p.pos.x), 0, Float(p.pos.z)]
                // Face the way you are running; if stationary, face the disc.
                let facing = p.vel.lengthSq > 0.04
                    ? p.vel
                    : Vec3d(match.disc.pos.x - p.pos.x, 0, match.disc.pos.z - p.pos.z)
                if facing.lengthSq > 1e-6 {
                    let yaw = Foundation.atan2(facing.x, facing.z)
                    e.orientation = simd_quatf(angle: Float(yaw), axis: [0, 1, 0])
                }
            }
            if let ring = content.entities.first(where: { $0.name == "ring\(p.id)" }) {
                ring.position = [Float(p.pos.x), 0.02, Float(p.pos.z)]
                ring.isEnabled = (p.id == match.controlled)
            }
        }

        if let disc = content.entities.first(where: { $0.name == "disc" }) {
            let d = match.disc
            disc.position = [Float(d.pos.x), Float(Swift.max(d.pos.y, 0.02)), Float(d.pos.z)]
            // The sim's body +Z is the disc normal; a RealityKit cylinder's axis is +Y.
            // One fixed quarter turn reconciles them and nothing else is corrected, which
            // is what makes this a rendering of the simulation rather than an animation
            // that resembles one.
            let q = d.orient
            let sim = simd_quatf(ix: Float(q.x), iy: Float(q.y), iz: Float(q.z), r: Float(q.w))
            disc.orientation = sim * simd_quatf(angle: .pi / 2, axis: [1, 0, 0])
        }
        if let shadow = content.entities.first(where: { $0.name == "discShadow" }) as? ModelEntity {
            shadow.position = [Float(match.disc.pos.x), 0.02, Float(match.disc.pos.z)]
            let alpha = Swift.max(0.06, 0.4 - Float(match.disc.pos.y) * 0.03)
            shadow.model?.materials = [UnlitMaterial(color: .init(white: 0, alpha: CGFloat(alpha)))]
        }
        if let cam = content.entities.first(where: { $0.name == "camera" }) as? PerspectiveCamera {
            place(cam)
        }
    }

    // MARK: hud

    private var scoreboard: some View {
        HStack(spacing: 14) {
            Text("YOU \(match.score[0])")
                .foregroundStyle(Color(red: 0.35, green: 0.65, blue: 1))
            Text("—").foregroundStyle(.white.opacity(0.35))
            Text("\(match.score[1]) THEM")
                .foregroundStyle(Color(red: 1, green: 0.45, blue: 0.4))

            Spacer()

            // The stall count is the clock that matters, so it is the one that is shown.
            // It only exists while someone is holding, which is also the only time it
            // means anything.
            if match.holder != nil {
                Text("STALL \(Int(match.stall))")
                    .foregroundStyle(match.stall > 6 ? .orange : .white.opacity(0.6))
            } else if case .scored(let team) = match.phase {
                Text(team == 0 ? "GOAL" : "THEIR POINT")
                    .foregroundStyle(team == 0 ? .green : .orange)
            }

            Text("first to \(match.field.target)")
                .foregroundStyle(.white.opacity(0.35))
        }
        .font(.system(.subheadline, design: .monospaced).bold())
        .padding(.horizontal, 20)
        .padding(.top, 14)
    }

    /// The aim line. Drawn in view space rather than in the scene because it is a
    /// statement about your gesture, not about the world — and because it must be legible
    /// against turf at any camera distance.
    private func aimOverlay(_ d: DragState, in size: CGSize) -> some View {
        ZStack {
            Path { p in
                p.move(to: d.start)
                p.addLine(to: d.current)
            }
            .stroke(
                LinearGradient(
                    colors: [.orange.opacity(0.25), .orange],
                    startPoint: .top, endPoint: .bottom),
                style: StrokeStyle(lineWidth: 4, lineCap: .round))

            Text("\(d.type.rawValue.uppercased())  \(Int(d.power * 100))%")
                .font(.system(size: 13, design: .monospaced).bold())
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 6).fill(.black.opacity(0.65)))
                .foregroundStyle(.orange)
                .position(x: d.current.x, y: d.current.y - 28)
        }
        .allowsHitTesting(false)
    }
}

#if canImport(UIKit)
    import UIKit
    typealias UIOrNSColor = UIColor
#else
    import AppKit
    typealias UIOrNSColor = NSColor
#endif
