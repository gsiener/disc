import Foundation
import RealityKit
import SwiftUI
import UltimateSim

/// The half of `MatchView` that faces the renderer: the entity handles, the per-frame
/// caches that keep the renderer from allocating, and the two functions that make a scene
/// and then move it.
///
/// **Why this is its own file.** It is the only part of the match view that owns state the
/// view cannot see — caches whose whole job is to remember what was already assigned to a
/// material or a position — and cached state has exactly one failure mode: something
/// changes the world without telling the cache. That happened. `markStep` was reset in all
/// three places a match can begin and `ringDimmed`/`ringPainted` in none of them, so
/// switching format mid-session could leave a downed player's control ring painted at full
/// strength for the rest of the game, which quietly drops §4's requirement that the layout
/// cost be legible.
///
/// The fix is structural rather than a fourth copy of the reset list: the caches live on
/// one object with one `invalidate()`, and the three places a match begins call it. A
/// cache added here is reset everywhere by construction, because there is only one
/// everywhere.
///
/// It reads the engine and never writes it — nothing in this file steps, throws or
/// commits. `MatchView.swift` owns the match and the thumb; `MatchHUD.swift` owns the
/// words on top; `PitchScene` owns the geometry this assembles.
@available(macOS 15.0, iOS 18.0, *)
@MainActor
final class MatchScene {

    // MARK: - the handles

    /// The handful of entities `sync` writes to every frame, held by reference.
    ///
    /// A class, and `@State`, because the two halves of a `RealityView` are separate
    /// closures: `build` makes the entities and `update` moves them, and there is no
    /// value type that can carry a handle from one to the other without SwiftUI copying
    /// it. Populated in `build` — including on a rebuild, when the format changes and
    /// every field is overwritten with the new scene's entities.
    var players: Entity?
    var rings: Entity?
    var targets: Entity?
    var chevron: Entity?
    var disc: Entity?
    var mark: ModelEntity?
    var post: Entity?
    var trail: Entity?
    var arrow: Entity?
    var preview: Entity?
    var bidMark: Entity?
    var pulse: ModelEntity?
    var camera: PerspectiveCamera?
    var focus: Entity?

    // MARK: - the caches

    /// Which rung of the ground mark's opacity ramp is currently on the mark. Cached so
    /// the material is only assigned when it actually changes, which for a disc sitting
    /// in someone's hand is never.
    var markStep = -1

    /// Which control ring currently wears which treatment, so the twelve dashes are only
    /// repainted when the answer actually changes. See `MatchView.sync`.
    var ringDimmed = false
    var ringPainted = -1

    /// Recent disc positions while it is in the air, oldest first. Collected in the tick
    /// loop rather than in the render pass, because the render pass runs once per drawn
    /// frame and a trail should sample the flight, not the frame rate.
    var trailSamples: [SIMD3<Float>] = []

    /// Phase for the chevron's bob, advanced by wall time rather than by frame count so
    /// the bob speed does not depend on the display's refresh rate.
    var bobPhase = 0.0

    /// The frame and the aim the memoised cone-select preview was computed for.
    ///
    /// `Engine.previewReceiver` allocates a fresh body array and reads every player's
    /// locomotion state, and it used to be called twice per rendered frame — once by
    /// `sync` for the bracket on the grass and once by `aimOverlay` for the jersey number
    /// beside the thumb — i.e. about 360 array allocations a second at 120 Hz, for two
    /// answers that are the same answer.
    ///
    /// The key is the frame counter *and* the aim, which between them cover everything the
    /// preview depends on: player positions move only inside a tick, and a tick only runs
    /// inside a frame, so a matching key means a recompute would return what is already
    /// here.
    private struct PreviewKey: Equatable {
        var frame: Int
        var aimX: Double
        var aimZ: Double
    }
    private var previewKey: PreviewKey?
    private var previewValue: Int?

    /// The teammate the cone select judges the drag to mean, computed at most once per
    /// frame per aim.
    func previewedReceiver(frame: Int, aimX: Double, aimZ: Double, compute: () -> Int?) -> Int? {
        let key = PreviewKey(frame: frame, aimX: aimX, aimZ: aimZ)
        if previewKey != key {
            previewKey = key
            previewValue = compute()
        }
        return previewValue
    }

    /// Everything a new match invalidates, in one place.
    ///
    /// Called from all three ways a match can begin — `build`, `restart`, `adopt` — and
    /// that is the point of it existing: three hand-maintained reset lists is how
    /// `ringDimmed` and `ringPainted` came to be reset by none of them while their sibling
    /// `markStep` was reset by all three.
    ///
    /// The entity handles are deliberately *not* cleared. They are replaced wholesale by
    /// `build` when the format changes and are otherwise still the scene the next match is
    /// played in; a nil handle here would mean a frame drawn against nothing.
    func invalidate() {
        markStep = -1
        ringDimmed = false
        ringPainted = -1
        trailSamples.removeAll()
        bobPhase = 0
        previewKey = nil
        previewValue = nil
    }
}

// MARK: - building it

@available(macOS 15.0, iOS 18.0, *)
extension MatchView {

    func build(_ content: RealityViewCameraContent) {
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
        scene.players = players
        scene.rings = rings
        scene.targets = targets

        let chevron = PitchScene.chevron()
        content.add(chevron)
        scene.chevron = chevron

        let disc = PitchScene.disc()
        content.add(disc)
        scene.disc = disc

        let mark = PitchScene.groundMark()
        content.add(mark)
        scene.mark = mark

        let post = PitchScene.altitudePost()
        post.isEnabled = false
        content.add(post)
        scene.post = post

        let trailRoot = PitchScene.trail()
        content.add(trailRoot)
        scene.trail = trailRoot

        let arrow = PitchScene.aimArrow()
        arrow.isEnabled = false
        content.add(arrow)
        scene.arrow = arrow

        let preview = Self.previewBracket()
        preview.isEnabled = false
        content.add(preview)
        scene.preview = preview

        let bidMark = Self.bidMarker()
        bidMark.isEnabled = false
        content.add(bidMark)
        scene.bidMark = bidMark

        let pulse = PitchScene.handoffPulse()
        pulse.isEnabled = false
        content.add(pulse)
        scene.pulse = pulse

        // A new scene is a new set of entities, so every cache that remembers what was
        // last assigned to one is now remembering somebody else's.
        scene.invalidate()

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
        content.add(camera)
        scene.camera = camera

        // The eased look-at point, parked in the scene graph rather than in `@State`.
        // Rebuilding the scene has to reset the camera's easing along with everything
        // else, and scene-graph state resets for free; view state does not.
        let focus = Entity()
        let want = cameraTarget()
        focus.position = want.at
        camera.look(at: want.at, from: want.from, relativeTo: nil)
        content.add(focus)
        scene.focus = focus
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
    func cameraTarget() -> (from: SIMD3<Float>, at: SIMD3<Float>) {
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

    /// The teammate the cone select currently judges the drag to mean, if any.
    ///
    /// `Engine.previewReceiver` is strictly read-only and runs the *same* cone select the
    /// release will run, so asking it keeps the highlight live as receivers run through
    /// the cone — and a derived value cannot go stale the way a stored one can. No drag,
    /// no preview; the highlight clears the instant the gesture ends, aborts, or the disc
    /// leaves the hand, because all of those make `drag` nil or `previewReceiver` return
    /// nil.
    ///
    /// It is asked twice a frame — once for the bracket on the grass and once for the
    /// jersey number by the thumb — and answered once: see `MatchScene.previewedReceiver`
    /// for what that memo is keyed on and why the key is exact rather than approximate.
    var previewedReceiver: Int? {
        // An aborted drag names nobody, because it is about to throw nobody the disc.
        guard let d = drag, !d.aborted else { return nil }
        return scene.previewedReceiver(frame: frame, aimX: d.aim.x, aimZ: d.aim.z) {
            match.previewReceiver(dx: d.aim.x, dz: d.aim.z)
        }
    }

    /// The bracket drawn under the previewed receiver while you drag. Four corner
    /// dashes rather than the control ring's twelve or the target ring's solid disc,
    /// so all three markers stay tellable apart at a glance — and in the gesture's own
    /// orange, so it reads as part of the throw you are lining up, not as a state of
    /// the world. Built here rather than in `PitchScene` because it exists purely for
    /// the drag, which this file owns.
    static func previewBracket() -> Entity {
        let root = Entity()
        let dash = MeshResource.generateBox(size: [0.34, 0.025, 0.08])
        let material = UnlitMaterial(color: .orange)
        for i in 0..<4 {
            let theta = (Float(i) + 0.5) / 4 * 2 * .pi
            let seg = ModelEntity(mesh: dash, materials: [material])
            seg.position = [0.85 * sin(theta), 0, 0.85 * cos(theta)]
            seg.orientation = simd_quatf(angle: theta, axis: [0, 1, 0])
            root.addChild(seg)
        }
        return root
    }

    /// The spot a committed defender has been sent to, drawn on the grass.
    ///
    /// A cross rather than a ring, and in the defence's blue rather than the gesture's
    /// orange, because the pitch already carries three rings — control, target and the
    /// drag's preview bracket — and a fourth would be one more thing to tell apart in the
    /// half second a flight lasts. It says one thing the plate cannot: *where*, which on a
    /// bid is the difference between a defender who is about to arrive and one who has
    /// been sent at a disc they will never touch.
    ///
    /// The blue is `Palette.defence`, the same numbers the `DefenceCall` plate's title is
    /// drawn in, and that is the whole argument: the mark and the plate are one sentence
    /// about one decision. It spent its first release in `Palette.control` — the gold worn
    /// by the control ring, the chevron and the handoff pulse — which is to say it shipped
    /// as the fourth gold thing on a pitch the paragraph above says must not have a
    /// fourth, and as the only half of the defensive call that was not blue.
    static func bidMarker() -> Entity {
        let root = Entity()
        let bar = MeshResource.generateBox(size: [1.5, 0.02, 0.10])
        let material = PitchScene.unlit(PitchScene.Palette.defence, opacity: 0.8)
        for i in 0..<2 {
            let seg = ModelEntity(mesh: bar, materials: [material])
            seg.orientation = simd_quatf(angle: Float(i) * .pi / 2, axis: [0, 1, 0])
            root.addChild(seg)
        }
        return root
    }

    /// The teammate a live throw is heading for, if there is one.
    ///
    /// "Nearest to the disc right now" rather than a predicted landing point: predicting
    /// would mean re-integrating the flight here, and a second copy of the flight model
    /// in the renderer is exactly the thing this project refuses to have.
    ///
    /// **A `PlayerId`, and it used to be an index that was compared against one.** The
    /// filter read `$0 != thrower` with `$0` an index into `players` and `thrower` an id
    /// from the engine — the same number today only because `buildRoster` deals
    /// `id == index`, and the wrong athlete excluded from the ring the moment that stops
    /// being true. Both sides are ids now, and the one consumer compares against `p.id`.
    var incomingReceiver: PlayerId? {
        guard let thrower = match.thrower,
            let team = match.body(of: thrower)?.team
        else { return nil }
        let d = match.disc.state.pos
        return match.players
            .filter { $0.team == team && $0.id != thrower }
            .min {
                Foundation.hypot($0.pos.x - d.x, $0.pos.z - d.z)
                    < Foundation.hypot($1.pos.x - d.x, $1.pos.z - d.z)
            }?.id
    }

    // MARK: - moving it

    /// A sample of the disc's flight, taken in the tick loop.
    func recordTrail() {
        guard match.discInFlight else {
            if !scene.trailSamples.isEmpty { scene.trailSamples.removeAll() }
            return
        }
        // Every fourth tick — 30 Hz of flight, the same cadence the old 60 Hz loop's
        // every-other-frame sampling gave. Twenty-two beads at 60 Hz would be a quarter
        // of a second of flight, which reads as a smear on the disc rather than as a
        // path it took.
        guard tickCount % 4 == 0 else { return }
        let p = match.disc.state.pos
        scene.trailSamples.append([Float(p.x), Float(p.y), Float(p.z)])
        if scene.trailSamples.count > PitchScene.trailLength { scene.trailSamples.removeFirst() }
    }

    /// Move everything the simulation moved.
    ///
    /// The entity handles come from `scene`, taken when it was built. They used to come
    /// from a dictionary rebuilt out of `content.entities` on every frame; the scene has
    /// one root per named thing and those roots are never replaced except by a full
    /// rebuild, so the dictionary was an allocation and a scene walk per frame to learn
    /// something that had not changed since launch.
    func sync(_ content: RealityViewCameraContent) {
        let receiver = incomingReceiver
        let bobPhase = scene.bobPhase

        if let players = scene.players, let rings = scene.rings, let targets = scene.targets {
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
                    ring.isEnabled = (p.id == match.controlled)
                    // Dimmed while this body cannot act — §4's legible layout cost. Only
                    // the controlled ring is ever drawn, so only it is ever repainted,
                    // and only on the two frames a match where the answer changes.
                    if p.id == match.controlled {
                        let dim = match.recovery(of: p.id) != nil
                        // Keyed on the ring as well as the treatment: control moves, and
                        // a cache that only remembered "dimmed" would leave the previous
                        // player's ring painted at 40% for the rest of the match.
                        if dim != scene.ringDimmed || p.id != scene.ringPainted {
                            scene.ringDimmed = dim
                            scene.ringPainted = p.id
                            let material = PitchScene.controlRingRamp[dim ? 1 : 0]
                            for seg in ring.children {
                                (seg as? ModelEntity)?.model?.materials = [material]
                            }
                        }
                    }
                }
                if i < targets.children.count {
                    let target = targets.children[i]
                    target.position = [Float(p.pos.x), 0.018, Float(p.pos.z)]
                    target.isEnabled = (p.id == receiver)
                }
            }
        }

        if let chevron = scene.chevron, let p = match.body(of: match.controlled) {
            // A slow bob, so it is findable by movement as well as by colour. Phased by
            // wall time (advanced in `advance`), not by frame count, so it bobs at the
            // same speed on a 120 Hz display as on a 60 Hz one.
            let bob = Foundation.sin(bobPhase) * 0.06
            chevron.position = [Float(p.pos.x), Float(2.28 + bob), Float(p.pos.z)]
        }

        if let disc = scene.disc {
            let d = match.disc.state
            // A held disc sits at the holder's own position, which puts it inside their
            // torso and therefore invisible — you could not tell who had it. Offset it to
            // an extended arm for display only; the sim's position is untouched, so
            // nothing about the throw or the catch changes.
            var shown = Vec3d(d.pos.x, Swift.max(d.pos.y, 0.02), d.pos.z)
            if let h = match.holder, let p = match.body(of: h) {
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

        if let mark = scene.mark {
            mark.position = [Float(match.disc.state.pos.x), 0.024, Float(match.disc.state.pos.z)]
            let alpha = Swift.max(
                PitchScene.groundMarkFaintest,
                PitchScene.groundMarkDarkest - Float(match.disc.state.pos.y) * 0.03)
            // A rung off the pre-baked ramp, and only when the rung changed. This line
            // used to allocate a fresh `UnlitMaterial` every frame — including the long
            // stretches where the disc is in somebody's hand and the number it encodes
            // has not moved at all.
            let step = PitchScene.groundMarkStep(alpha)
            if step != scene.markStep {
                scene.markStep = step
                mark.model?.materials = [PitchScene.groundMarkRamp[step]]
            }
        }

        // The handoff pulse: one expanding ring on whoever just took control. Position
        // is re-read every frame rather than frozen at the swap, because in the third of
        // a second this lasts the player is running.
        if let pulse = scene.pulse {
            if let h = handoff, let p = match.body(of: h.to) {
                pulse.isEnabled = true
                pulse.position = [Float(p.pos.x), 0.02, Float(p.pos.z)]
                pulse.scale = .init(repeating: Float(0.7 + 2.3 * h.progress))
                pulse.model?.materials = [PitchScene.handoffRamp[PitchScene.handoffStep(h.progress)]]
            } else {
                pulse.isEnabled = false
            }
        }

        if let post = scene.post {
            let inFlight = match.discInFlight
            let h = Float(match.disc.state.pos.y)
            post.isEnabled = inFlight && h > 0.6
            post.position = [Float(match.disc.state.pos.x), h / 2, Float(match.disc.state.pos.z)]
            post.scale = [1, Swift.max(h, 0.001), 1]
        }

        if let trailRoot = scene.trail {
            // Slot 0 holds the oldest sample and has the faintest material, so the trail
            // is filled from the end of the array backwards.
            let n = trailRoot.children.count
            let samples = scene.trailSamples
            for slot in 0..<n {
                let idx = samples.count - n + slot
                if idx >= 0 && idx < samples.count {
                    trailRoot.children[slot].position = samples[idx]
                    trailRoot.children[slot].isEnabled = true
                } else {
                    trailRoot.children[slot].isEnabled = false
                }
            }
        }

        if let arrow = scene.arrow {
            // An aborted drag keeps its line on screen — greyed, and saying CANCEL — but
            // takes its arrow off the grass. The arrow is a claim about where the disc is
            // going, and it is going nowhere.
            if let d = drag, !d.aborted, let h = match.holder, let p = match.body(of: h) {
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

        // The cone-select preview. Enabled only while a drag names somebody, which is
        // also the only time the disc is held — so this and the in-flight target ring
        // can never draw at once: the release that starts the flight is the same event
        // that ends the drag and clears this.
        if let bracket = scene.preview {
            if let r = previewedReceiver, let p = match.body(of: r) {
                bracket.isEnabled = true
                bracket.position = [Float(p.pos.x), 0.026, Float(p.pos.z)]
                // A slow pulse and creep, phased by wall time like the chevron's bob,
                // so it moves at the same speed at any refresh rate. Movement is what
                // makes "the pick just changed" visible in peripheral vision while the
                // eye is on the drag.
                bracket.scale = .init(repeating: Float(1 + 0.08 * Foundation.sin(bobPhase * 2.4)))
                bracket.orientation = simd_quatf(angle: Float(bobPhase * 0.45), axis: [0, 1, 0])
            } else {
                bracket.isEnabled = false
            }
        }

        // Where the committed defender was sent. Enabled only while a commitment is live,
        // which is at most 1.6 s and only ever on defence — so this and the drag's preview
        // bracket can no more draw at once than a throw and a defensive tap can happen at
        // once.
        if let mark = scene.bidMark {
            if let commit = match.defensiveCommit {
                mark.isEnabled = true
                mark.position = [Float(commit.at.x), 0.028, Float(commit.at.z)]
                // Spun by wall time, like the preview bracket, so it is findable in
                // peripheral vision while the eye is on the disc.
                mark.orientation = simd_quatf(angle: Float(bobPhase * 0.9), axis: [0, 1, 0])
            } else {
                mark.isEnabled = false
            }
        }

        if let cam = scene.camera, let focus = scene.focus {
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
                let blend = Float(1 - Foundation.exp(-6.32 * clock.frameDt))
                from = simd_mix(from, want.from, SIMD3(repeating: blend))
                at = simd_mix(at, want.at, SIMD3(repeating: blend))
            }
            focus.position = at
            cam.look(at: at, from: from, relativeTo: nil)
        }
    }
}
