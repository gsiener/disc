import SwiftUI
import UltimateSim

/// The first thing in this project that is a *game* rather than a test: a disc thrown
/// with the real simulation, drawn as it flies.
///
/// Deliberately 2D. The renderer decision — Metal direct or RealityKit — is still open,
/// and nothing here prejudges it: this is Canvas drawing a trajectory the sim produced,
/// so it costs nothing to throw away. What it buys is the ability to *see* the flight
/// model on a phone, which no number in a test report gives you. A backhand that turns
/// over and fades looks wrong long before it measures wrong.
///
/// Two projections, because one is not enough to see what a disc does. The side view
/// shows the glide; the top view shows the curve, which is the half a sports game lives
/// on and the half a side view completely hides.
struct FlightView: View {
    @State private var throwKind = ThrowPreset.backhand
    @State private var samples: [Vec3d] = []
    @State private var carry = 0.0
    @State private var lateral = 0.0
    @State private var peak = 0.0
    @State private var flightTime = 0.0
    @State private var stepMicros = 0.0
    @State private var playhead = 0.0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            HStack(spacing: 12) {
                plot(title: "side · x-y", horizontal: \.x, vertical: \.y, flipVertical: false)
                plot(title: "top · x-z", horizontal: \.x, vertical: \.z, flipVertical: true)
            }

            controls
        }
        .padding(16)
        .background(Color.black)
        .task { fly() }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("ULTIMATE").font(.system(.headline, design: .monospaced)).bold()
            Text(throwKind.label)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
            Spacer()
            Text(
                "carry \(fmt(carry)) m   lateral \(fmt(lateral, signed: true)) m   "
                    + "peak \(fmt(peak)) m   \(fmt(flightTime)) s"
            )
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.orange)
        }
        .foregroundStyle(.white)
    }

    /// One projection of the flight path.
    ///
    /// The two axes share a scale so the shapes are comparable — an anhyzer that curves
    /// 10 m across a 35 m carry should *look* like a shallow curve, and independently
    /// normalised axes would draw it as a hairpin.
    private func plot(
        title: String,
        horizontal: KeyPath<Vec3d, Double>,
        vertical: KeyPath<Vec3d, Double>,
        flipVertical: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)

            Canvas { context, size in
                guard samples.count > 1 else { return }

                let hs = samples.map { $0[keyPath: horizontal] }
                let vs = samples.map { $0[keyPath: vertical] }
                let hMin = hs.min()!, hMax = hs.max()!
                let vMin = Swift.min(vs.min()!, 0), vMax = Swift.max(vs.max()!, 0)

                let span = Swift.max(Swift.max(hMax - hMin, vMax - vMin), 1)
                let pad = 12.0
                let scale = Swift.min(size.width - pad * 2, size.height - pad * 2) / span

                func project(_ p: Vec3d) -> CGPoint {
                    let h = (p[keyPath: horizontal] - hMin) * scale + pad
                    var v = (p[keyPath: vertical] - vMin) * scale + pad
                    if !flipVertical { v = size.height - v }  // side view: y is up
                    return CGPoint(x: h, y: v)
                }

                // Ground line on the side view, centre line on the top view.
                var ground = Path()
                let zero = project(Vec3d(hMin, flipVertical ? 0 : 0, 0))
                ground.move(to: CGPoint(x: 0, y: zero.y))
                ground.addLine(to: CGPoint(x: size.width, y: zero.y))
                context.stroke(ground, with: .color(.white.opacity(0.18)), lineWidth: 1)

                // The flight path.
                var path = Path()
                path.move(to: project(samples[0]))
                for p in samples.dropFirst() { path.addLine(to: project(p)) }
                context.stroke(
                    path,
                    with: .linearGradient(
                        Gradient(colors: [.cyan, .orange]),
                        startPoint: .zero, endPoint: CGPoint(x: size.width, y: size.height)),
                    lineWidth: 2)

                // The disc, at the scrubbed position.
                let index = Swift.min(samples.count - 1, Int(playhead * Double(samples.count - 1)))
                let at = project(samples[index])
                context.fill(
                    Path(ellipseIn: CGRect(x: at.x - 4, y: at.y - 4, width: 8, height: 8)),
                    with: .color(.white))
            }
            .background(Color.white.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("throw", selection: $throwKind) {
                ForEach(ThrowPreset.allCases, id: \.self) { Text($0.short).tag($0) }
            }
            .pickerStyle(.segmented)
            .onChange(of: throwKind) { _, _ in fly() }

            HStack(spacing: 10) {
                Text("t").font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                Slider(value: $playhead, in: 0...1)
                Text("\(fmt(stepMicros)) µs/tick")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.green)
            }
        }
    }

    /// Run the flight, and time it.
    ///
    /// The per-tick timing is the number the plan has been carrying as an *estimate*
    /// since before any Swift existed — "well under 0.5 ms per tick", extrapolated from
    /// Node. This is one disc rather than a full match, so it is a floor and not the
    /// answer, but it is measured on the actual hardware instead of reasoned about.
    private func fly() {
        var s = throwKind.release()
        var path: [Vec3d] = [s.pos]

        let started = DispatchTime.now()
        var ticks = 0
        while !s.atRest && s.t < 12 {
            s.step(dt: FIXED_DT)
            ticks += 1
            if ticks % 3 == 0 { path.append(s.pos) }
        }
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds)

        path.append(s.pos)
        samples = path
        carry = Foundation.hypot(s.pos.x, s.pos.z)
        lateral = s.pos.z
        peak = path.map(\.y).max() ?? 0
        flightTime = s.t
        stepMicros = ticks > 0 ? elapsed / Double(ticks) / 1000 : 0
        playhead = 1
    }

    private func fmt(_ v: Double, signed: Bool = false) -> String {
        String(format: signed ? "%+.1f" : "%.1f", v)
    }
}

/// A few throws worth looking at, built the way the flight fixtures build them.
///
/// Not the real throw table — `aero/Throws.ts` and `throwDisc` are not ported yet, and
/// these are hand-set release states rather than the game's actual specs. They exist to
/// exercise the flight model, not to be balanced.
enum ThrowPreset: String, CaseIterable {
    case backhand, hammer, anhyzer, huck

    var short: String {
        switch self {
        case .backhand: "BH"
        case .hammer: "HAM"
        case .anhyzer: "ANH"
        case .huck: "HUCK"
        }
    }

    var label: String {
        switch self {
        case .backhand: "flat backhand · 20 m/s"
        case .hammer: "hammer · inverted, drops off the back"
        case .anhyzer: "anhyzer · banked, curves right"
        case .huck: "huck · 27 m/s, nose up"
        }
    }

    func release() -> DiscState {
        switch self {
        case .backhand: Self.make(speed: 20, nose: 0.05, bank: 0, invert: false, spin: -52)
        case .hammer: Self.make(speed: 14, nose: 0, bank: 0, invert: true, spin: 46, climb: 4)
        case .anhyzer: Self.make(speed: 22, nose: 0.05, bank: 0.44, invert: false, spin: -55)
        case .huck: Self.make(speed: 27, nose: 0.14, bank: -0.2, invert: false, spin: -58, climb: 3)
        }
    }

    private static func make(
        speed: Double, nose: Double, bank: Double, invert: Bool, spin: Double,
        climb: Double = 0, height: Double = 1.6
    ) -> DiscState {
        var s = DiscState()
        s.pos = Vec3d(0, height, 0)
        s.vel = Vec3d(speed, climb, 0)
        s.omega = Vec3d(0, 0, spin)

        let vdir = s.vel.normalized
        let right = vdir.cross(Vec3d(0, 1, 0)).normalized
        let upPerp = right.cross(vdir).normalized

        var normal = upPerp.scaled(Foundation.cos(nose)).addingScaled(vdir, -Foundation.sin(nose))
        if invert { normal = -normal }
        normal = normal.applying(Quatd.fromAxisAngle(vdir, bank)).normalized

        let bodyX = vdir.addingScaled(normal, -vdir.dot(normal)).normalized
        let q1 = Quatd.fromUnitVectors(Vec3d(0, 0, 1), normal)
        let q2 = Quatd.fromUnitVectors(Vec3d(1, 0, 0).applying(q1), bodyX)
        s.orient = (q2 * q1).normalized
        return s
    }
}
