import RealityKit
import SwiftUI
import UltimateSim

/// A disc flying over a real pitch, in 3D, driven by the simulation at 120 Hz.
///
/// This is the first look at the question §E3 of the plan deliberately left open —
/// **Metal direct or RealityKit** — and it is deliberately the cheap side of that
/// question. RealityKit gives a scene graph, PBR materials, shadows and a camera for
/// free; the plan's worry was that the things it provides are the things this project
/// has opinions about. Finding out costs an afternoon here and six months later.
///
/// What it establishes regardless of which renderer wins: the sim's coordinate frame
/// maps straight onto a 3D scene with no conversion layer. Sim x is downfield, y is up,
/// z is lateral — which is already RealityKit's convention, so a disc position is a
/// position and a disc orientation is an orientation.
///
/// The disc's *attitude* is the point. A 2D path plot cannot show that a backhand is
/// flying nose-up and banked while it fades; here the disc visibly tilts, and that is
/// the half of the flight model the plots have been hiding.
@available(macOS 15.0, iOS 18.0, *)
public struct PitchView: View {
    @State private var preset = ThrowPreset.backhand
    @State private var format = Format.minis
    @State private var state = DiscState()
    @State private var trail: [Vec3d] = []
    @State private var playing = true
    @State private var flightTime = 0.0

    /// Pitch dimensions. Both formats exist because both are wanted — see the plan's
    /// second decision record. 7v7 is the regulation field; minis is the space of a
    /// single endzone, turned so its long axis is the direction of play.
    public enum Format: String, CaseIterable {
        case minis, full

        /// Playing length and width in metres, and the endzone depth.
        var geometry: (length: Double, width: Double, endzone: Double) {
            switch self {
            case .minis: (37, 18, 6)
            case .full: (100, 37, 18)
            }
        }

        var label: String {
            switch self {
            case .minis: "3v3 · 37 × 18 m"
            case .full: "7v7 · 100 × 37 m"
            }
        }
    }

    public init() {}

    public var body: some View {
        ZStack(alignment: .topLeading) {
            RealityView { content in
                build(content)
            } update: { content in
                updateDisc(content)
            }
            .background(Color(red: 0.05, green: 0.07, blue: 0.09))

            overlay
        }
        .onAppear { throwIt() }
        .task {
            // Step the sim on a display-paced loop. The sim itself is fixed at 1/120;
            // this only decides how often we look at it.
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(16))
                guard playing else { continue }
                if state.atRest || state.t > 12 {
                    try? await Task.sleep(for: .milliseconds(700))
                    throwIt()
                    continue
                }
                for _ in 0..<2 { state.step(dt: FIXED_DT) }
                flightTime = state.t
                trail.append(state.pos)
            }
        }
    }

    // MARK: scene

    private func build(_ content: RealityViewCameraContent) {
        let g = format.geometry

        // The pitch. A dark green plane with lighter goal lines laid on top, rather than
        // a texture — there are no binary assets in this project and this is one of the
        // places that constraint costs nothing.
        let turf = ModelEntity(
            mesh: .generatePlane(width: Float(g.length), depth: Float(g.width)),
            materials: [SimpleMaterial(color: .init(red: 0.16, green: 0.34, blue: 0.18, alpha: 1), roughness: 0.9, isMetallic: false)]
        )
        turf.name = "turf"
        content.add(turf)

        // Goal lines and sidelines.
        for offset in [-(g.length / 2 - g.endzone), g.length / 2 - g.endzone] {
            let line = ModelEntity(
                mesh: .generatePlane(width: 0.16, depth: Float(g.width)),
                materials: [UnlitMaterial(color: .init(white: 0.85, alpha: 0.75))])
            line.position = [Float(offset), 0.012, 0]
            content.add(line)
        }
        for side in [-g.width / 2, g.width / 2] {
            let line = ModelEntity(
                mesh: .generatePlane(width: Float(g.length), depth: 0.16),
                materials: [UnlitMaterial(color: .init(white: 0.85, alpha: 0.55))])
            line.position = [0, 0.012, Float(side)]
            content.add(line)
        }

        // The disc: a 273 mm cylinder, the real dimensions from `DiscBody`.
        let body = DiscBody.standard
        let disc = ModelEntity(
            mesh: .generateCylinder(height: Float(body.halfHeight * 2), radius: Float(body.radius)),
            materials: [SimpleMaterial(color: .init(red: 0.95, green: 0.94, blue: 0.92, alpha: 1), roughness: 0.35, isMetallic: false)]
        )
        disc.name = "disc"
        content.add(disc)

        // A marker on the ground under the disc. Depth on a flat pitch is genuinely hard
        // to read without one — this is the same reason sports broadcasts draw them.
        let shadow = ModelEntity(
            mesh: .generateCylinder(height: 0.01, radius: Float(body.radius * 0.9)),
            materials: [UnlitMaterial(color: .init(white: 0, alpha: 0.35))])
        shadow.name = "shadow"
        content.add(shadow)

        // Light: one key from high and behind the thrower's right, which is the
        // "summer evening, first TV deal" direction the art direction asks for.
        let sun = DirectionalLight()
        sun.light.intensity = 6000
        sun.light.color = .init(red: 1.0, green: 0.96, blue: 0.88, alpha: 1)
        sun.shadow = DirectionalLightComponent.Shadow()
        sun.look(at: [0, 0, 0], from: [-20, 30, 18], relativeTo: nil)
        content.add(sun)

        // A tele-broadcast camera: elevated, off the sideline, looking at midfield.
        // §4 of the plan calls for exactly this and rules out a behind-the-line camera,
        // because Ultimate has no line of scrimmage.
        let camera = PerspectiveCamera()
        camera.camera.fieldOfViewInDegrees = 38
        let back = Float(g.width) * 1.15 + 14
        camera.look(
            at: [Float(g.length) * 0.10, 1.4, 0],
            from: [Float(-g.length) * 0.22, 13, back],
            relativeTo: nil)
        content.add(camera)
    }

    private func updateDisc(_ content: RealityViewCameraContent) {
        guard let disc = content.entities.first(where: { $0.name == "disc" }) else { return }

        disc.position = SIMD3(Float(state.pos.x), Float(state.pos.y), Float(state.pos.z))

        // The sim's body +Z is the disc normal; a RealityKit cylinder's axis is +Y. One
        // fixed quarter turn reconciles them, and everything else is the sim's own
        // orientation — no per-frame correction, which is the property that makes this
        // a rendering of the simulation rather than an animation resembling it.
        let q = state.orient
        let simOrientation = simd_quatf(
            ix: Float(q.x), iy: Float(q.y), iz: Float(q.z), r: Float(q.w))
        let zUpToYUp = simd_quatf(angle: .pi / 2, axis: [1, 0, 0])
        disc.orientation = simOrientation * zUpToYUp

        if let shadow = content.entities.first(where: { $0.name == "shadow" }) as? ModelEntity {
            shadow.position = SIMD3(Float(state.pos.x), 0.02, Float(state.pos.z))
            // Fade the marker with height, so altitude is readable at a glance.
            let alpha = max(0.06, 0.4 - Float(state.pos.y) * 0.03)
            shadow.model?.materials = [UnlitMaterial(color: .init(white: 0, alpha: CGFloat(alpha)))]
        }
    }

    // MARK: overlay

    private var overlay: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text("ULTIMATE").font(.system(.headline, design: .monospaced)).bold()
                Text(format.label)
                    .font(.system(.caption, design: .monospaced)).foregroundStyle(.white.opacity(0.5))
                Spacer()
                Text(
                    String(
                        format: "%.1f m  ·  %.1f m/s  ·  %.0f°  ·  %.1f s",
                        Foundation.hypot(state.pos.x, state.pos.z), state.airspeed,
                        state.alpha * 180 / .pi, flightTime)
                )
                .font(.system(.caption, design: .monospaced)).foregroundStyle(.orange)
            }

            HStack(spacing: 6) {
                ForEach(ThrowPreset.allCases, id: \.self) { p in
                    chip(p.short, active: p == preset) {
                        preset = p
                        throwIt()
                    }
                }
                Divider().frame(height: 16).overlay(Color.white.opacity(0.2))
                ForEach(Format.allCases, id: \.self) { f in
                    chip(f.rawValue.uppercased(), active: f == format) { format = f }
                }
            }
        }
        .padding(16)
        .foregroundStyle(.white)
    }

    private func chip(_ text: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: 11, design: .monospaced))
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(active ? Color.orange : Color.black.opacity(0.45)))
                .foregroundStyle(active ? .black : .white.opacity(0.8))
        }
        .buttonStyle(.plain)
    }

    private func throwIt() {
        let g = format.geometry
        state = throwDisc(
            preset.type,
            from: Vec3d(-g.length / 2 + g.endzone + 2, 1.6, 0),
            aim: Vec3d(1, 0, 0),
            power: 0.8, angle: 0, spin: 0.5)
        trail = [state.pos]
        flightTime = 0
    }
}
