import Foundation
import RealityKit
import SwiftUI
import UltimateSim

#if canImport(UIKit)
    import UIKit
    typealias UIOrNSColor = UIColor
#else
    import AppKit
    typealias UIOrNSColor = NSColor
#endif

/// Everything `MatchView` puts in front of the camera, built once and then only moved.
///
/// Split out of the view for one reason: the view is about a thumb and a match, and the
/// scene is about geometry. Mixing them made a 400-line file where the interesting part —
/// how a drag becomes a throw — was buried under cylinder radii.
///
/// **Nothing here reads a file.** Every mesh, colour and pattern in this project is
/// generated: the mown stripes are geometry, the dusk sky is a ring of unlit quads, the
/// jersey numbers are `generateText`. That is a standing constraint, and it is the reason
/// there is no `Assets.xcassets` anywhere in the repo.
/// `@MainActor` because every RealityKit type it touches is: an `Entity` is not a value
/// you can build on a background thread and hand over.
@available(macOS 15.0, iOS 18.0, *)
@MainActor
enum PitchScene {

    // MARK: - palette

    /// A summer evening, an hour before the floodlights are needed.
    ///
    /// The greens are darker and less saturated than a daylight pitch because everything
    /// is lit by a low warm key; a mid-green base under a 1.0/0.90/0.72 light comes back
    /// as the yellow-green of a mown pitch at eight o'clock. Team colours are the two
    /// hues that stay separable at arm's length on a phone against that green — a blue
    /// and a red, not a blue and a purple.
    enum Palette {
        static let turfA = rgb(0.098, 0.235, 0.129)
        static let turfB = rgb(0.129, 0.290, 0.157)
        /// Grass beyond the pitch. Desaturated so the playing surface is the bright thing.
        static let surround = rgb(0.055, 0.105, 0.072)
        /// Endzone shading, applied at `endzoneOpacity`. Two earlier versions of this
        /// were wrong in the same direction: a blue tint made the scoring third look like
        /// a swimming pool, a near-black one made it look like a hole in the pitch. It
        /// has to stay grass. All it is allowed to do is stop being the *same* grass.
        static let endzone = rgb(0.0, 0.05, 0.10)
        static let endzoneOpacity: Float = 0.30
        static let line = rgb(0.98, 0.98, 0.94)
        static let cone = rgb(1.0, 0.55, 0.10)
        static let skin = rgb(0.72, 0.55, 0.42)
        static let disc = rgb(0.97, 0.97, 0.95)
        static let discTop = rgb(1.0, 0.62, 0.16)
        static let control = rgb(1.0, 0.78, 0.20)
        /// Defence. The one blue on the pitch that is not a jersey, and it belongs to
        /// exactly one idea: *you sent somebody*. The bid marker on the grass wears it and
        /// so does the `DefenceCall` plate's title, which is the point — the mark and the
        /// plate are one sentence about one decision, and a reader should not have to work
        /// that out from their positions.
        ///
        /// The same numbers as the plate's `Color(red: 0.45, green: 0.72, blue: 1)`, and
        /// lighter than the team blue on purpose: `team(0)` is worn by six running bodies
        /// and this has to stay tellable apart from all of them at arm's length.
        static let defence = rgb(0.45, 0.72, 1.0)

        static func team(_ t: Int) -> UIOrNSColor {
            t == 0 ? rgb(0.16, 0.50, 0.96) : rgb(0.93, 0.27, 0.22)
        }
        /// The same hue, darker — shorts, so a player is not one flat block of colour.
        static func shorts(_ t: Int) -> UIOrNSColor {
            t == 0 ? rgb(0.08, 0.24, 0.52) : rgb(0.50, 0.12, 0.10)
        }
        /// The same hue lifted towards white, for the ring under a throw's target. A
        /// brighter version of the team colour says "the disc is coming here" without
        /// also saying "this player has changed sides".
        static func targetRing(_ t: Int) -> UIOrNSColor {
            t == 0 ? rgb(0.62, 0.86, 1.0) : rgb(1.0, 0.72, 0.62)
        }

        /// The treeline silhouette, hazed toward the sky behind it.
        ///
        /// It was near-black, and against a `(0.72, 0.40, 0.26)` horizon that read as a
        /// void stripe across the screen rather than as trees — the eye takes a
        /// high-contrast horizontal band as a hole in the render, not as distance.
        ///
        /// Aerial perspective is the fix and it is the physical one: air between you and
        /// a distant object scatters the sky's own light toward you, so a silhouette at
        /// the far end of a field is not black, it is a darkened version of what is
        /// behind it. Mixing a quarter of the horizon colour in is enough to read as
        /// haze while keeping the trees clearly darker than the sky.
        static let treeline: UIOrNSColor = {
            let haze = 0.25
            let base = (0.038, 0.062, 0.074)
            let sky = (0.72, 0.40, 0.26)
            return rgb(
                base.0 + (sky.0 - base.0) * haze,
                base.1 + (sky.1 - base.1) * haze,
                base.2 + (sky.2 - base.2) * haze)
        }()

        /// Dusk, horizon first. Sampled continuously by `skyColor` rather than used as
        /// discrete bands — five hard stripes across the top of the screen looked like a
        /// test card.
        static let sky: [(Double, Double, Double)] = [
            (0.72, 0.40, 0.26),  // the last of the sun, just above the trees
            (0.52, 0.30, 0.32),
            (0.30, 0.23, 0.36),
            (0.15, 0.15, 0.29),
            (0.055, 0.070, 0.175),  // zenith
        ]

        /// The sky at `t` from horizon (0) to zenith (1).
        static func skyColor(_ t: Double) -> UIOrNSColor {
            let clamped = Swift.min(1, Swift.max(0, t)) * Double(sky.count - 1)
            let i = Swift.min(sky.count - 2, Int(clamped))
            let f = clamped - Double(i)
            let a = sky[i]
            let b = sky[i + 1]
            return rgb(
                a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f, a.2 + (b.2 - a.2) * f)
        }

        static func rgb(_ r: Double, _ g: Double, _ b: Double) -> UIOrNSColor {
            .init(red: r, green: g, blue: b, alpha: 1)
        }
    }

    /// An unlit surface, optionally see-through.
    ///
    /// **`UnlitMaterial(color:)` silently discards the colour's alpha.** Transparency is
    /// a separate `blending` mode, and without it every "subtle" overlay in this scene
    /// rendered at full strength — the endzone tint came out as a solid black hole in the
    /// pitch and the disc trail as a string of opaque white beads. Opacity goes through
    /// this function so that cannot happen again.
    static func unlit(_ color: UIOrNSColor, opacity: Float = 1) -> UnlitMaterial {
        var m = UnlitMaterial(color: color)
        if opacity < 1 {
            m.blending = .transparent(opacity: .init(floatLiteral: opacity))
            m.opacityThreshold = nil
        }
        return m
    }

    /// A lit surface.
    ///
    /// `specular` defaults low and goes to zero for the ground. A physically based
    /// dielectric reflects almost everything at grazing incidence, and a 500 m ground
    /// plane is *entirely* grazing incidence past the far endzone — the first build of
    /// this scene turned the horizon into a sheet of grey satin. Grass does not do that,
    /// so the ground does not get a specular lobe.
    private static func lit(
        _ color: UIOrNSColor, roughness: Float, metallic: Float = 0, specular: Float = 0.2
    ) -> PhysicallyBasedMaterial {
        var m = PhysicallyBasedMaterial()
        m.baseColor = .init(tint: color)
        m.roughness = .init(floatLiteral: roughness)
        m.metallic = .init(floatLiteral: metallic)
        m.specular = .init(floatLiteral: specular)
        return m
    }

    // MARK: - the world

    /// Sky, surrounding grass, pitch, stripes, lines, bricks and cones — one entity,
    /// because none of it ever moves and `sync` should not have to walk past it.
    static func decor(_ f: FieldSpec) -> Entity {
        let root = Entity()
        root.name = "decor"
        root.addChild(sky(f))
        root.addChild(ground(f))
        root.addChild(markings(f))
        return root
    }

    /// A ring of unlit quads standing in for the evening.
    ///
    /// The alternative was a flat background colour behind the render, which is what this
    /// replaced. A flat colour cannot give you a horizon, and without a horizon a pitch
    /// is a green shape floating in a void — you lose the sense that the far endzone is
    /// far away. Bands are sized as multiples of the camera height so the same code reads
    /// correctly on a 37 m pitch and a 100 m one, where the camera sits nearly three
    /// times higher.
    private static func sky(_ f: FieldSpec) -> Entity {
        let root = Entity()
        // Close enough that the treeline fills the band of screen between the far end
        // line and the horizon. The first attempt put it at three field lengths away,
        // which is geometrically honest and left a quarter of the screen as empty grass.
        let radius = Float(f.length) * 1.2 + 30
        let camHeight = Float(f.length) * 0.26
        // Below eye level, so the trees read as something standing on the ground. Taller
        // than the camera and they become a wall across the top third of the screen,
        // which is what the first attempt at this did.
        let treeTop = camHeight * 0.75
        let segments = 28
        let segWidth = 2 * Float.pi * radius / Float(segments) * 1.08  // overlap the seams

        // The treeline, with a per-segment height wobble so its top edge is a treeline
        // and not a fence. Deterministic, because a scene that looks different on every
        // launch is a scene you cannot screenshot-compare.
        for s in 0..<segments {
            let theta = Float(s) / Float(segments) * 2 * .pi
            let jitter = 1 + 0.13 * sin(Float(s) * 2.31) + 0.07 * sin(Float(s) * 5.77)
            let top = treeTop * jitter
            let panel = ModelEntity(
                // Rooted well below ground so no gap opens up on a slope of the terrain.
                mesh: .generatePlane(width: segWidth, height: top + 6),
                materials: [unlit(Palette.treeline)])
            panel.position = [radius * sin(theta), (top - 6) / 2, radius * cos(theta)]
            // A plane's normal is +Z; yaw by theta + pi turns it to face the centre.
            panel.orientation = simd_quatf(angle: theta + .pi, axis: [0, 1, 0])
            root.addChild(panel)
        }

        // Sky, sat just behind the treeline and starting below its lowest tree so the
        // wobble never opens a hole onto the void.
        //
        // Twelve bands, spaced by a power law rather than evenly. A broadcast camera
        // looks *down*, so the visible sky is a thin wedge just above the horizon and an
        // evenly-spaced gradient spends thirteen of its bands off the top of the screen.
        let skyRadius = radius * 1.10
        let skyWidth = 2 * Float.pi * skyRadius / Float(segments) * 1.08
        let bands = 12
        let bottom = treeTop * 0.55
        let top = camHeight * 9
        for band in 0..<bands {
            let t0 = pow(Float(band) / Float(bands), 1.8)
            let t1 = pow(Float(band + 1) / Float(bands), 1.8)
            let y0 = bottom + (top - bottom) * t0
            let y1 = bottom + (top - bottom) * t1
            // Sample the ramp at the band's own elevation, on the same power law, so the
            // steps between bands stay roughly equal in colour rather than in height.
            let mesh = MeshResource.generatePlane(width: skyWidth, height: y1 - y0)
            let material = unlit(Palette.skyColor(Double(Float(band) / Float(bands - 1))))
            for s in 0..<segments {
                let theta = Float(s) / Float(segments) * 2 * .pi
                let panel = ModelEntity(mesh: mesh, materials: [material])
                panel.position = [
                    skyRadius * sin(theta), (y0 + y1) / 2, skyRadius * cos(theta),
                ]
                panel.orientation = simd_quatf(angle: theta + .pi, axis: [0, 1, 0])
                root.addChild(panel)
            }
        }
        return root
    }

    /// The grass: an unbounded-looking surround, the pitch itself, and mown stripes.
    ///
    /// The stripes are the cheapest depth cue in the scene. Bands of constant *z* run
    /// across the direction of play, so they compress towards the far endzone exactly as
    /// perspective says they should, and a disc travelling downfield visibly crosses
    /// them. A plain green plane gives the eye nothing to measure distance against.
    private static func ground(_ f: FieldSpec) -> Entity {
        let root = Entity()

        let far = Float(f.length) * 8 + 200
        let surround = ModelEntity(
            mesh: .generatePlane(width: far, depth: far),
            materials: [lit(Palette.surround, roughness: 1.0, specular: 0)])
        surround.position = [0, -0.03, 0]
        root.addChild(surround)

        let turf = ModelEntity(
            mesh: .generatePlane(width: Float(f.width), depth: Float(f.length)),
            materials: [lit(Palette.turfA, roughness: 0.95, specular: 0)])
        root.addChild(turf)

        // Even count, so the two endzones are mown the same way.
        let count = Swift.max(8, Int((f.length / 5).rounded()) / 2 * 2)
        let depth = Float(f.length) / Float(count)
        let stripe = MeshResource.generatePlane(width: Float(f.width), depth: depth)
        let stripeMaterial = lit(Palette.turfB, roughness: 0.95, specular: 0)
        for i in stride(from: 0, to: count, by: 2) {
            let band = ModelEntity(mesh: stripe, materials: [stripeMaterial])
            band.position = [0, 0.004, Float(-f.length / 2) + (Float(i) + 0.5) * depth]
            root.addChild(band)
        }

        // Endzone shading. Subtle: it should say "this is the scoring third" at a glance
        // and never compete with the goal line, which is the edge that actually matters.
        let tint = MeshResource.generatePlane(
            width: Float(f.width), depth: Float(f.endzoneDepth))
        for sign in [-1.0, 1.0] {
            let zone = ModelEntity(
                mesh: tint,
                materials: [unlit(Palette.endzone, opacity: Palette.endzoneOpacity)])
            zone.position = [0, 0.008, Float(sign * (f.endLine - f.endzoneDepth / 2))]
            root.addChild(zone)
        }
        return root
    }

    private static func markings(_ f: FieldSpec) -> Entity {
        let root = Entity()
        // Chalk is opaque. An earlier version drew the sidelines at 55% and the effect
        // at arm's length was a pitch whose edges you had to look for.
        let bright = unlit(Palette.line)
        let soft = unlit(Palette.line, opacity: 0.62)

        // End lines are the brighter pair: they are the boundary of the world.
        for z in [-f.endLine, f.endLine] {
            let line = ModelEntity(
                mesh: .generatePlane(width: Float(f.width), depth: 0.16), materials: [bright])
            line.position = [0, 0.014, Float(z)]
            root.addChild(line)
        }
        for z in [-f.goalLine, f.goalLine] {
            let line = ModelEntity(
                mesh: .generatePlane(width: Float(f.width), depth: 0.16), materials: [bright])
            line.position = [0, 0.014, Float(z)]
            root.addChild(line)
        }
        for x in [-f.sideline, f.sideline] {
            let line = ModelEntity(
                mesh: .generatePlane(width: 0.16, depth: Float(f.length)), materials: [soft])
            line.position = [Float(x), 0.014, 0]
            root.addChild(line)
        }

        // Brick marks: where a pull that goes out is brought in to. Scaled with the
        // pitch, since a 37 m field cannot spare the regulation 18 m.
        let brick = Swift.min(18.0, f.length * 0.18)
        for z in [-(f.goalLine - brick), f.goalLine - brick] {
            let across = ModelEntity(
                mesh: .generatePlane(width: 1.0, depth: 0.14), materials: [soft])
            across.position = [0, 0.016, Float(z)]
            let along = ModelEntity(
                mesh: .generatePlane(width: 0.14, depth: 1.0), materials: [soft])
            along.position = [0, 0.016, Float(z)]
            root.addChild(across)
            root.addChild(along)
        }

        // The eight corners a pitch is actually coned: four at the end lines, four where
        // the goal lines meet the sidelines.
        let coneMesh = MeshResource.generateCone(height: 0.36, radius: 0.14)
        let coneMaterial = lit(Palette.cone, roughness: 0.6)
        for x in [-f.sideline, f.sideline] {
            for z in [-f.endLine, -f.goalLine, f.goalLine, f.endLine] {
                let cone = ModelEntity(mesh: coneMesh, materials: [coneMaterial])
                cone.position = [Float(x), 0.18, Float(z)]
                root.addChild(cone)
            }
        }
        return root
    }

    // MARK: - people

    /// A player, 1.78 m to the crown, feet at the entity's origin.
    ///
    /// Built from the pieces that make a human silhouette read at 30 m: legs that are
    /// narrower than the torso, shoulders that are wider than it, and a head. The
    /// shoulder box is what makes facing legible — a cylinder looks identical from every
    /// angle, and which way a player is facing is most of what you need to know about
    /// them. The jersey number goes on both sides because at this camera the offence
    /// shows you its back and the defence shows you its front.
    static func player(team: Int, number: Int) -> Entity {
        let body = Entity()
        let kit = lit(Palette.team(team), roughness: 0.75)
        let shorts = lit(Palette.shorts(team), roughness: 0.8)
        let skin = lit(Palette.skin, roughness: 0.85)

        let leg = MeshResource.generateCylinder(height: 0.54, radius: 0.085)
        for x in [-0.115, 0.115] as [Float] {
            let l = ModelEntity(mesh: leg, materials: [skin])
            l.position = [x, 0.27, 0]
            body.addChild(l)
        }

        let hips = ModelEntity(
            mesh: .generateCylinder(height: 0.36, radius: 0.225), materials: [shorts])
        hips.position = [0, 0.68, 0]
        body.addChild(hips)

        let torso = ModelEntity(
            mesh: .generateCylinder(height: 0.50, radius: 0.215), materials: [kit])
        torso.position = [0, 1.10, 0]
        body.addChild(torso)

        let shoulders = ModelEntity(
            mesh: .generateBox(size: [0.52, 0.17, 0.27], cornerRadius: 0.07), materials: [kit])
        shoulders.position = [0, 1.36, 0]
        body.addChild(shoulders)

        let arm = MeshResource.generateCylinder(height: 0.56, radius: 0.065)
        for x in [-0.30, 0.30] as [Float] {
            let a = ModelEntity(mesh: arm, materials: [skin])
            a.position = [x, 1.08, 0]
            // Splayed a few degrees, which is what stops the arms reading as railings.
            a.orientation = simd_quatf(angle: x < 0 ? 0.13 : -0.13, axis: [0, 0, 1])
            body.addChild(a)
        }

        let neck = ModelEntity(
            mesh: .generateCylinder(height: 0.10, radius: 0.062), materials: [skin])
        neck.position = [0, 1.48, 0]
        body.addChild(neck)

        let head = ModelEntity(mesh: .generateSphere(radius: 0.135), materials: [skin])
        head.position = [0, 1.645, 0]
        body.addChild(head)

        if let glyph = numberMesh(number) {
            let white = unlit(Palette.rgb(1, 1, 1))
            for (z, yaw, scale) in [(-0.222 as Float, Float.pi, 1.0 as Float), (0.222, 0, 0.78)] {
                let glyphEntity = ModelEntity(mesh: glyph.mesh, materials: [white])
                glyphEntity.position = glyph.centring
                let holder = Entity()
                holder.position = [0, 1.14, z]
                holder.orientation = simd_quatf(angle: yaw, axis: [0, 1, 0])
                holder.scale = .init(repeating: scale)
                holder.addChild(glyphEntity)
                body.addChild(holder)
            }
        }
        return body
    }

    /// A centred number glyph. `generateText` lays out from a baseline, so the mesh's own
    /// bounds are the only honest way to find its middle.
    private static func numberMesh(_ n: Int) -> (mesh: MeshResource, centring: SIMD3<Float>)? {
        let mesh = MeshResource.generateText(
            "\(n)",
            extrusionDepth: 0.012,
            font: .systemFont(ofSize: 0.24, weight: .heavy),
            containerFrame: .zero,
            alignment: .center,
            lineBreakMode: .byClipping)
        return (mesh, -mesh.bounds.center)
    }

    /// The ring under the player you are controlling: twelve dashes rather than a solid
    /// disc, because a solid disc at this size reads as a puddle and a dashed one reads
    /// as a marker somebody drew.
    static func controlRing() -> Entity {
        let ring = Entity()
        let dash = MeshResource.generateBox(size: [0.09, 0.02, 0.20])
        let material = unlit(Palette.control)
        let count = 12
        for i in 0..<count {
            let theta = Float(i) / Float(count) * 2 * .pi
            let seg = ModelEntity(mesh: dash, materials: [material])
            seg.position = [0.66 * sin(theta), 0, 0.66 * cos(theta)]
            seg.orientation = simd_quatf(angle: theta, axis: [0, 1, 0])
            ring.addChild(seg)
        }
        return ring
    }

    /// The control ring's two treatments: in the play, and on the floor.
    ///
    /// `docs/gameplay-design.md` §4 asks for "ring at 40% opacity while your body is
    /// unavailable — the 2.04 s layout cost must be legible, not mysterious". Two
    /// materials built once rather than one built per frame, for the same reason the
    /// ground mark has a ramp: this is a value that changes twice a layout and was
    /// otherwise a fresh `UnlitMaterial` allocation 120 times a second.
    ///
    /// Index 0 is available, 1 is recovering. Kept as an array so the call site indexes
    /// with a `Bool` and cannot get the two the wrong way round.
    static let controlRingRamp: [UnlitMaterial] = [
        unlit(Palette.control), unlit(Palette.control, opacity: 0.4),
    ]

    /// A soft disc under whoever a throw is heading for.
    static func targetRing(team: Int) -> Entity {
        let e = ModelEntity(
            mesh: .generateCylinder(height: 0.012, radius: 0.95),
            materials: [unlit(Palette.targetRing(team), opacity: 0.5)])
        return e
    }

    /// A chevron over the controlled player's head. The ring answers "which one is me"
    /// when the pitch is empty around you; this answers it in a crowd, where the ring is
    /// hidden behind other people's legs.
    static func chevron() -> Entity {
        let e = ModelEntity(
            mesh: .generateCone(height: 0.30, radius: 0.17),
            materials: [unlit(Palette.control)])
        e.orientation = simd_quatf(angle: .pi, axis: [1, 0, 0])
        return e
    }

    // MARK: - disc

    /// The disc, at its real 273 mm. A white body with a coloured top, so which face is
    /// up is visible — which is the whole reason for rendering flight in 3D at all.
    static func disc() -> Entity {
        let spec = DiscBody.standard
        let root = Entity()
        let body = ModelEntity(
            mesh: .generateCylinder(
                height: Float(spec.halfHeight * 2), radius: Float(spec.radius)),
            materials: [lit(Palette.disc, roughness: 0.35)])
        root.addChild(body)
        let top = ModelEntity(
            mesh: .generateCylinder(
                height: Float(spec.halfHeight * 0.9), radius: Float(spec.radius * 0.6)),
            materials: [lit(Palette.discTop, roughness: 0.4)])
        top.position = [0, Float(spec.halfHeight * 0.8), 0]
        root.addChild(top)
        return root
    }

    /// Darkest and lightest the ground mark is allowed to be. How dark it is *is* the
    /// altitude readout, so the range is fixed here and the view only picks a rung.
    static let groundMarkFaintest: Float = 0.06
    static let groundMarkDarkest: Float = 0.40

    /// The ground mark's opacity, pre-baked into rungs.
    ///
    /// This used to be one freshly allocated `UnlitMaterial` per frame — a `Material` is
    /// not a value you hand to RealityKit for free, and at 120 Hz that is 120 of them a
    /// second thrown away to express a number that only ever takes about a dozen visibly
    /// distinct values. Sixteen rungs is finer than the eye can resolve on a shadow under
    /// a disc, and the whole ramp is built once.
    static let groundMarkRamp: [UnlitMaterial] = (0..<16).map { i in
        let t = Float(i) / 15
        return unlit(
            Palette.rgb(0, 0, 0),
            opacity: groundMarkFaintest + (groundMarkDarkest - groundMarkFaintest) * t)
    }

    /// Which rung of `groundMarkRamp` an opacity lands on.
    static func groundMarkStep(_ opacity: Float) -> Int {
        let t = (opacity - groundMarkFaintest) / (groundMarkDarkest - groundMarkFaintest)
        return Swift.min(groundMarkRamp.count - 1, Swift.max(0, Int((t * 15).rounded())))
    }

    static func groundMark() -> ModelEntity {
        ModelEntity(
            mesh: .generateCylinder(height: 0.01, radius: Float(DiscBody.standard.radius * 1.1)),
            materials: [groundMarkRamp[groundMarkStep(0.35)]])
    }

    /// The ring that expands out of whoever just took control.
    ///
    /// A filled disc rather than the control ring's dashes, because it is scaled to three
    /// times its size in a third of a second and dashes at that speed read as debris. It
    /// is one `ModelEntity` on purpose: the fade is a material swap per frame, and one
    /// swap is affordable where twelve would not be.
    static func handoffPulse() -> ModelEntity {
        ModelEntity(
            mesh: .generateCylinder(height: 0.012, radius: 1),
            materials: [handoffRamp[handoffRamp.count - 1]])
    }

    /// The handoff pulse fading out, pre-baked for the same reason the ground mark's is.
    /// Slot 0 is gone, the last slot is the flash at the moment of the swap.
    static let handoffRamp: [UnlitMaterial] = (0..<12).map { i in
        unlit(Palette.control, opacity: Float(i) / 11 * 0.5)
    }

    /// Which rung of `handoffRamp` a 0…1 progress through the pulse lands on. Squared, so
    /// the ring is bright at the moment control moves and spends most of its life
    /// vanishing — a linear fade reads as a ring that hangs around.
    static func handoffStep(_ progress: Double) -> Int {
        let fade = Swift.max(0, 1 - progress)
        let t = Float(fade * fade)
        return Swift.min(handoffRamp.count - 1, Swift.max(0, Int((t * 11).rounded())))
    }

    /// A one-metre post that gets scaled to the disc's height every frame.
    ///
    /// Height above a flat pitch is the one thing a 3D view is supposed to tell you and
    /// the one thing perspective alone hides: a disc at 2 m over there and a disc at 8 m
    /// over here project to the same place. Broadcast graphics solve it the same way.
    static func altitudePost() -> ModelEntity {
        ModelEntity(
            mesh: .generateCylinder(height: 1, radius: 0.02),
            materials: [unlit(Palette.rgb(1, 0.96, 0.88), opacity: 0.22)])
    }

    static let trailLength = 22

    /// Fading beads behind the disc. The alpha is baked into one material per slot at
    /// build time so that a flight costs twenty-two position writes and no allocations.
    static func trail() -> Entity {
        let root = Entity()
        let bead = MeshResource.generateSphere(radius: 0.06)
        for i in 0..<trailLength {
            let age = Float(i) / Float(trailLength - 1)  // 0 = oldest
            let e = ModelEntity(
                mesh: bead,
                materials: [unlit(Palette.rgb(1.0, 0.95, 0.85), opacity: 0.06 + age * 0.5)])
            e.isEnabled = false
            root.addChild(e)
        }
        return root
    }

    /// The ground arrow drawn from the thrower while a throw is being aimed.
    ///
    /// The overlay line in view space says what your *thumb* is doing; this says what the
    /// *disc* will do, on the pitch, in the direction it will actually go. Both are worth
    /// having, and this one is the one that answers "will that reach him".
    static func aimArrow() -> Entity {
        let root = Entity()
        let material = unlit(Palette.rgb(1.0, 0.72, 0.18), opacity: 0.5)
        let shaft = ModelEntity(mesh: .generateBox(size: [0.26, 0.02, 1]), materials: [material])
        shaft.name = "shaft"
        root.addChild(shaft)
        let head = ModelEntity(mesh: .generateCone(height: 0.8, radius: 0.36), materials: [material])
        head.name = "head"
        // Tipped forward so the apex points downfield, then squashed along what is now
        // the vertical: an unsquashed cone is half buried in the pitch and reads as a
        // half-eaten circle rather than as an arrowhead.
        head.orientation = simd_quatf(angle: .pi / 2, axis: [1, 0, 0])
        head.scale = [1, 1, 0.10]
        root.addChild(head)
        return root
    }

    // MARK: - light

    /// A low warm key with shadows, and a cold fill from the opposite side.
    ///
    /// One light alone leaves the shaded side of every player pure black, which on a
    /// phone reads as a hole rather than a shadow. The fill is dim, blue, and casts
    /// nothing — it is the sky, not a second sun.
    static func lights(_ f: FieldSpec) -> [Entity] {
        let reach = Float(f.length)

        let sun = DirectionalLight()
        sun.light.intensity = 9000
        sun.light.color = .init(red: 1.0, green: 0.90, blue: 0.72, alpha: 1)
        sun.shadow = DirectionalLightComponent.Shadow(
            maximumDistance: reach * 0.9, depthBias: 2.0)
        // Off to one side and a third of the way up the sky: long shadows are what say
        // "evening" rather than "noon", but at twenty degrees of elevation a player's
        // shadow is five metres of grey smear and stops reading as a person at all.
        sun.look(at: [0, 0, 0], from: [-reach * 0.72, reach * 0.52, -reach * 0.30], relativeTo: nil)

        let fill = DirectionalLight()
        fill.light.intensity = 2600
        fill.light.color = .init(red: 0.58, green: 0.70, blue: 0.95, alpha: 1)
        fill.shadow = nil
        fill.look(at: [0, 0, 0], from: [reach * 0.6, reach * 0.8, reach * 0.5], relativeTo: nil)

        return [sun, fill]
    }
}
