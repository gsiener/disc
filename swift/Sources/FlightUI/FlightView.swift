import SwiftUI
import UltimateSim

/// The first thing in this project that is a *game* rather than a test: a disc thrown
/// with the real simulation, drawn as it flies.
///
/// Deliberately 2D. The renderer decision — Metal direct or RealityKit — is still open,
/// and nothing here prejudges it: this is Canvas drawing a trajectory the sim produced,
/// so it costs nothing to throw away. What it buys is the ability to *see* the flight
/// model, which no number in a test report gives you. A backhand that turns over wrongly
/// looks wrong long before it measures wrong.
///
/// Two projections, because one is not enough. The side view shows the glide; the top
/// view shows the curve, which is the half a sports game lives on and the half a side
/// view hides completely.
///
/// **Both plots keep a true 1:1 metre aspect and are sized to their data** rather than
/// squeezed into equal boxes. A disc flight really is shallow — 3 m of height over 38 m
/// of carry — and exaggerating the vertical would read better while lying about the
/// shape being tuned. So the box gets short and wide instead, and the axes are labelled
/// in metres so the scale is never in question.
///
/// The controls are drawn rather than composed from `Picker` and `Slider`. Those render
/// as blank bars under `ImageRenderer`, which would make every headless snapshot wrong —
/// and headless snapshots are the point of the capture mode.
public struct FlightView: View {
    @State private var preset = ThrowPreset.backhand
    @State private var flight = Flight()
    @State private var playhead = 1.0

    public init(preset: ThrowPreset = .backhand) {
        _preset = State(initialValue: preset)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            plot(flight.side, title: "side · downfield × height")
            plot(flight.top, title: "top · downfield × lateral")
            controls
            Spacer(minLength: 0)
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.black)
        .task { fly() }
    }

    // MARK: header

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("ULTIMATE").font(.system(.headline, design: .monospaced)).bold()
                .foregroundStyle(.white)
            Text(preset.label)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.white.opacity(0.5))
            Spacer()
            stat("carry", flight.carry, "m")
            stat("lateral", flight.lateral, "m", signed: true)
            stat("peak", flight.peak, "m")
            stat("time", flight.seconds, "s")
            stat("tick", flight.microsPerTick, "µs", tint: .green)
        }
    }

    private func stat(
        _ name: String, _ value: Double, _ unit: String,
        signed: Bool = false, tint: Color = .orange
    ) -> some View {
        HStack(spacing: 4) {
            Text(name).foregroundStyle(.white.opacity(0.4))
            Text(String(format: signed ? "%+.1f" : "%.1f", value) + unit).foregroundStyle(tint)
        }
        .font(.system(.caption, design: .monospaced))
    }

    // MARK: plots

    /// A projection, sized to its own data so the aspect stays true without wasting space.
    private func plot(_ p: Projection, title: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.45))
                Text(p.extentLabel)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.28))
            }

            // `aspectRatio` rather than a computed height: an earlier version derived
            // the Canvas height from the live width inside a GeometryReader while the
            // outer frame used a hardcoded one, so any plot taller than that guess
            // overflowed and collided with the next label.
            Canvas { context, size in draw(p, in: context, size: size) }
                .background(Color.white.opacity(0.035))
                .clipShape(RoundedRectangle(cornerRadius: 5))
                .aspectRatio(p.spanH / p.spanV, contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: 230, alignment: .leading)
        }
    }

    private func draw(_ p: Projection, in context: GraphicsContext, size: CGSize) {
        guard p.points.count > 1 else { return }
        let pad = 10.0
        // Scale must satisfy BOTH axes, not just the horizontal. Deriving it from width
        // alone overflows the box vertically by exactly the padding, and the clip shape
        // then eats the top of the arc — which reads as a gap in the flight path rather
        // than as a layout bug, and cost a round to spot.
        let scale = Swift.min(
            (size.width - pad * 2) / Swift.max(p.spanH, 0.001),
            (size.height - pad * 2) / Swift.max(p.spanV, 0.001))

        func project(_ h: Double, _ v: Double) -> CGPoint {
            CGPoint(
                x: (h - p.minH) * scale + pad,
                y: size.height - ((v - p.minV) * scale + pad)
            )
        }

        // Distance grid, so "38 m" is legible as a shape and not just a number.
        var grid = Path()
        var labels: [(CGPoint, String)] = []
        var d = ceil(p.minH / p.gridStep) * p.gridStep
        while d <= p.maxH {
            let x = project(d, p.minV).x
            grid.move(to: CGPoint(x: x, y: 0))
            grid.addLine(to: CGPoint(x: x, y: size.height))
            labels.append((CGPoint(x: x + 3, y: size.height - 11), "\(Int(d))"))
            d += p.gridStep
        }
        context.stroke(grid, with: .color(.white.opacity(0.07)), lineWidth: 1)
        for (at, text) in labels {
            context.draw(
                Text(text).font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.3)),
                at: at, anchor: .topLeading)
        }

        // The zero line: the ground on the side view, the aim line on the top view.
        var zero = Path()
        let zy = project(p.minH, 0).y
        zero.move(to: CGPoint(x: 0, y: zy))
        zero.addLine(to: CGPoint(x: size.width, y: zy))
        context.stroke(
            zero, with: .color(.white.opacity(0.22)),
            style: StrokeStyle(lineWidth: 1, dash: p.isSide ? [] : [3, 3]))

        // The flight path, cyan at release fading to orange at ground.
        var path = Path()
        path.move(to: project(p.points[0].h, p.points[0].v))
        for pt in p.points.dropFirst() { path.addLine(to: project(pt.h, pt.v)) }
        context.stroke(
            path,
            with: .linearGradient(
                Gradient(colors: [.cyan, .orange]),
                startPoint: .zero, endPoint: CGPoint(x: size.width, y: 0)),
            style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))

        // The disc at the scrubbed moment.
        let i = Swift.min(p.points.count - 1, Int(playhead * Double(p.points.count - 1)))
        let at = project(p.points[i].h, p.points[i].v)
        context.fill(
            Path(ellipseIn: CGRect(x: at.x - 3.5, y: at.y - 3.5, width: 7, height: 7)),
            with: .color(.white))
    }

    // MARK: controls

    private var controls: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                ForEach(ThrowPreset.allCases, id: \.self) { p in
                    Button {
                        preset = p
                        fly()
                    } label: {
                        Text(p.short)
                            .font(.system(.caption, design: .monospaced))
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(
                                RoundedRectangle(cornerRadius: 5)
                                    .fill(p == preset ? Color.orange : Color.white.opacity(0.09)))
                            .foregroundStyle(p == preset ? .black : .white.opacity(0.75))
                    }
                    .buttonStyle(.plain)
                }
            }

            // A drawn scrubber. `Slider` renders as a blank bar under ImageRenderer,
            // which would silently corrupt every headless snapshot.
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.12)).frame(height: 4)
                    Capsule().fill(Color.orange)
                        .frame(width: Swift.max(4, geo.size.width * playhead), height: 4)
                    Circle().fill(.white).frame(width: 11, height: 11)
                        .offset(x: geo.size.width * playhead - 5.5)
                }
                .frame(height: 16)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0).onChanged { g in
                        playhead = Swift.min(1, Swift.max(0, g.location.x / geo.size.width))
                    })
            }
            .frame(height: 16)
        }
    }

    // MARK: running the flight

    private func fly() {
        flight = Flight(preset: preset)
        playhead = 1
    }
}

// MARK: - flight data

/// One projection of a path, in metres, with the geometry needed to draw it true to scale.
struct Projection {
    struct P {
        let h: Double
        let v: Double
    }
    var points: [P] = []
    var isSide = true

    var minH = 0.0, maxH = 0.0, minV = 0.0, maxV = 0.0
    var spanH: Double { Swift.max(maxH - minH, 0.001) }
    var spanV: Double { Swift.max(maxV - minV, 0.001) }

    /// 5 m gridlines under 60 m of carry, 10 m beyond — enough to read, not enough to fur.
    var gridStep: Double { spanH > 60 ? 10 : 5 }

    var extentLabel: String {
        String(format: "%.0f m × %.1f m · 1:1", spanH, spanV)
    }

    init() {}

    init(_ raw: [(Double, Double)], isSide: Bool) {
        self.isSide = isSide
        points = raw.map { P(h: $0.0, v: $0.1) }
        minH = points.map(\.h).min() ?? 0
        maxH = points.map(\.h).max() ?? 1
        minV = Swift.min(points.map(\.v).min() ?? 0, 0)
        maxV = Swift.max(points.map(\.v).max() ?? 1, 0)
    }
}

/// A flown trajectory plus the numbers worth reading off it.
struct Flight {
    var side = Projection()
    var top = Projection()
    var carry = 0.0
    var lateral = 0.0
    var peak = 0.0
    var seconds = 0.0
    var microsPerTick = 0.0

    init() {}

    /// Fly the preset and time it.
    ///
    /// The per-tick figure is one disc on whatever hardware this is running on — a floor,
    /// not the sim's budget, which will also carry fourteen locomotion bodies, O(n²)
    /// separation and team AI.
    init(preset: ThrowPreset) {
        var s = preset.release()
        var path: [Vec3d] = [s.pos]

        let started = DispatchTime.now()
        var ticks = 0
        while !s.atRest && s.t < 12 {
            s.step(dt: FIXED_DT)
            ticks += 1
            if ticks % 3 == 0 { path.append(s.pos) }
        }
        let nanos = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds)
        path.append(s.pos)

        side = Projection(path.map { ($0.x, $0.y) }, isSide: true)
        top = Projection(path.map { ($0.x, $0.z) }, isSide: false)
        carry = Foundation.hypot(s.pos.x, s.pos.z)
        lateral = s.pos.z
        peak = path.map(\.y).max() ?? 0
        seconds = s.t
        microsPerTick = ticks > 0 ? nanos / Double(ticks) / 1000 : 0
    }
}

/// A few throws worth looking at, built the way the flight fixtures build them.
///
/// Not the real throw table — `aero/Throws.ts` and `throwDisc` are not ported yet, and
/// these are hand-set release states rather than the game's actual specs. They exist to
/// exercise the flight model, not to be balanced.
public enum ThrowPreset: String, CaseIterable {
    case backhand, hammer, anhyzer, huck

    var short: String {
        switch self {
        case .backhand: "BACKHAND"
        case .hammer: "HAMMER"
        case .anhyzer: "ANHYZER"
        case .huck: "HUCK"
        }
    }

    var label: String {
        switch self {
        case .backhand: "flat backhand · 20 m/s, fades left"
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
