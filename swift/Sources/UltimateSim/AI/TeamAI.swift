import Foundation

/// ============================================================================
/// TEAM AI — one brain per team, ported from `src/sim/AI.ts` lines 653-3069
/// ============================================================================
///
/// Each fixed step `update` is handed the whole world and returns a `PlayerIntent`
/// for each of its own players. It decides *what a player wants to do*; it never
/// integrates motion and never touches the scene. `Move/Locomotion.swift` is the
/// consumer, and the contract between them is documented at the top of `AI.ts`.
///
/// The class is split across four files by subject, using extensions on one type:
///
/// | file | what lives there |
/// | --- | --- |
/// | `TeamAI.swift` | state, construction, `update`, bookkeeping, `lineUp`, `intent` |
/// | `TeamAIOffence.swift` | the offensive shape: stations, stack slots, cuts |
/// | `TeamAIThrow.swift` | the thrower's decision and the release |
/// | `TeamAIDefence.swift` | matchups, the mark, poaching, zone, in-flight reads |
///
/// Every stored property is therefore `internal` rather than `private`: Swift's
/// `private` is file-scoped, and an extension in another file cannot see it.
///
/// ---------------------------------------------------------------- what changed
///
/// **The pitch is threaded, not global.** The reference closes over a module-level
/// `FIELD`; this game runs 3v3 on 37x18 and 7v7 on 100x37, so `TeamAI` holds a
/// `Playbook` (which holds a `FieldConstants`) built at construction. `AIWorld` also
/// carries a field; they are expected to be the same pitch and `TeamAITests` asserts
/// that they are, because two disagreeing geometries would fail silently.
///
/// **Insertion order is behaviour in two maps.** `matchup` and `zoneRole` are
/// JavaScript `Map`s that the reference *iterates* and takes a last-wins result from
/// — `for (const [d, o] of this.matchup) if (o === thrower.id) matched = d` picks the
/// LAST defender assigned to the thrower, not an arbitrary one. Swift `Dictionary`
/// iteration order is unspecified and varies with the hash seed between runs, so both
/// are `OrderedIntMap`, which preserves insertion order exactly as a JS `Map` does
/// (including that overwriting an existing key does *not* move it to the end).
///
/// The other maps — `mem`, `byId`, `handlerStation`, `liveLanes`, `slotOf` — are
/// plain dictionaries, and each one is a deliberate call rather than an oversight:
///
///   - `mem` is iterated twice (`update`, `onPossessionChange`) and both loops apply
///     the same order-independent write to every element.
///   - `liveLanes` is iterated once, in `laneClearOfLiveTargets`, as a pure "does any
///     live target sit within 6 m" predicate. An `any` is order-independent.
///   - `byId`, `handlerStation` and `slotOf` are never iterated at all.
///
/// **`Mem` is a class.** The reference holds one long-lived record per player and
/// mutates it through the map (`this.m(id).cutState = 'plant'`). A struct in a Swift
/// dictionary would make every such write a no-op unless it were written back, which
/// is exactly the kind of bug that compiles and looks correct.

// MARK: - ordered map

/// An insertion-ordered `Int`-keyed map, matching JavaScript `Map` iteration order.
///
/// Only exists because two call sites in the defence iterate their map and keep the
/// last match. See the type doc above; this is a correctness type, not a convenience.
struct OrderedIntMap<Value> {
    private(set) var order: [Int] = []
    private var storage: [Int: Value] = [:]

    subscript(key: Int) -> Value? { storage[key] }

    /// Matches `Map.prototype.set`: a key that already exists keeps its position.
    mutating func set(_ key: Int, _ value: Value) {
        if storage.updateValue(value, forKey: key) == nil { order.append(key) }
    }

    mutating func removeAll() {
        order.removeAll()
        storage.removeAll()
    }

    var count: Int { order.count }

    /// Key/value pairs in insertion order.
    var entries: [(key: Int, value: Value)] {
        order.map { (key: $0, value: storage[$0]!) }
    }
}

// MARK: - internal records

/// The cut state machine. Handlers and cutters run different transitions over the
/// same five states.
enum CutState: String, Equatable, Sendable {
    case stack
    case setup
    case plant
    case `break`
    case clear
}

/// Per-player memory the AI owns. A class for the reason given in the type doc.
final class Mem {
    var id: Int
    /* offence */
    var cut: Playbook.CutRoute?
    var cutState: CutState
    var cutT: Double
    var cutCooldown: Double
    /// Depth in the column at the moment the live cut was offered; -1 if none.
    var cutDepth: Double
    /* defence */
    var poach: Double
    var poachHold: Double
    var switchCd: Double
    /// Lagged perception of the matchup — this is what defensive reaction *is*.
    var seenX: Double
    var seenZ: Double
    var seenOf: Int
    /// Flight epoch this player has committed to.
    var flightCommit: Int
    var bidCommit: Bool
    /* shared */
    var faceX: Double
    var faceZ: Double

    init(id: Int, seenX: Double, seenZ: Double, faceZ: Double) {
        self.id = id
        self.cut = nil
        self.cutState = .stack
        self.cutT = 0
        self.cutCooldown = 0
        self.cutDepth = -1
        self.poach = 0
        self.poachHold = 0
        self.switchCd = 0
        self.seenX = seenX
        self.seenZ = seenZ
        self.seenOf = -1
        self.flightCommit = -1
        self.bidCommit = false
        self.faceX = 0
        self.faceZ = faceZ
    }
}

/// One throw the thrower is considering, priced end to end.
///
/// A **struct**, where the reference is an object. Two sites alias it and both are
/// reproduced deliberately:
///
///  - `decide` writes `o.ev` back into the option that just became the best. Ported
///    by index, so the write lands in the array rather than in a copy.
///  - `release` re-solves `aim`/`dist`/`flightTime` on the chosen option. Ported as a
///    local `var` copy, which is equivalent because `choice` is set to nil on the
///    same frame the release fires and nothing reads it in between.
struct ThrowOption {
    var receiverId: Int
    var type: AIThrowType
    var aim: Vec3d
    var dist: Double
    var flightTime: Double
    var separation: Double
    var blockage: Double
    var breakPenalty: Double
    var powerRatio: Double
    var completion: Double
    var value: Double
    var ev: Double
    var isGoal: Bool
    var isReset: Bool
}

// MARK: - defaults

/// The reference's `DEFAULT_TEAM_CONFIG`, which `AITypes.swift` declares the shape of
/// but does not carry a value for.
public let DEFAULT_TEAM_CONFIG = TeamConfig(
    formation: .vertical, force: .forehand, zoneBias: -0.15, aggression: 1.0, seed: 1)

/// Shortest route a COMMANDED cut may resolve to, metres. Below this the cutter
/// arrives on the frame it departs and the player who asked for a cut sees nothing
/// move. Sized just over the 1.5 m the game suite asserts.
/// Public so `SimChecks/DivergenceTests.swift` can read the live value: the
/// registry can only police a number it can reach through the module's API, because
/// on device there is no source tree to parse (ADR-0002, ADR-0007).
public let MIN_CUT_RUN = 1.8

// MARK: - TeamAI

public final class TeamAI {
    public let team: TeamId
    public let dir: Dir
    public let cfg: TeamConfig
    /// The pitch, and every geometric routine drawn for it. See the type doc for why
    /// this is a stored value rather than the reference's module constant.
    public let pb: Playbook
    let rng: Rng

    /* possession bookkeeping */
    var lastPossession: Int = -1
    /// The reference's `GamePhase | ''`; nil is the empty string.
    var lastPhase: GamePhase?
    var lastCarrier: Int?
    var markedCarrier: Int?
    /// The reference's `DiscPhase | ''`.
    var lastDiscState: DiscPhase?
    var flightEpoch = 0
    var possessionEpoch = 0

    /* offence */
    var formation: Playbook.FormationName = .vertical
    var formWant: Playbook.FormationName = .vertical
    var formHold: Double = 0
    /// Mutated in place by `offence`'s anchor smoothing, exactly as the reference
    /// mutates its `{x, z}` literal. A stored `var` struct property, so `anchor.x +=`
    /// writes through to the owner rather than to a copy.
    var anchor = Vec2d(0, 0)
    var stackOrder: [Int] = []
    var handlerRing: [Int] = []
    /// Everyone, best hands first. The handler/cutter split is a prefix of this.
    var rankedIds: [Int] = []
    var handlerStation: [Int: Int] = [:]
    var liveLanes: [Playbook.LaneKey: Int] = [:]
    var lastCutStart: Double = -99
    var decisionTimer: Double = 0
    var choice: ThrowOption?
    var windup: Double = 0
    var threwThisPossession = false
    var throwCooldown: Double = 0
    var noGoodLook = false
    /// Seconds the current carrier has actually held the disc.
    var holdTime: Double = 0
    var holdCarrier: Int?

    /// The count the OFFENCE plays to.
    ///
    /// Normally this is the marker's stall count. But the count is produced by the
    /// defence, and a defence that cannot establish a mark does not produce one — and
    /// an offence whose only source of urgency is a number the opposition failed to
    /// increment will stand there holding the disc forever. A whole four-hundred-second
    /// match once sat motionless on exactly that: a marker pinned on the sideline a few
    /// centimetres outside the stall radius, a count frozen at 0.49, and fourteen
    /// players in a textbook formation waiting for something that was never going to
    /// happen.
    ///
    /// So the offence also watches its own clock. `holdTime` is real seconds with the
    /// disc in the hand, offset by more than the mark ever takes to establish so that
    /// it never overtakes a healthy count: with a mark set in half a second the count
    /// always leads and this term changes nothing. It only becomes the larger of the
    /// two when the count has stopped, and then it bounds the deadlock to about eleven
    /// seconds — which is what the count would have done.
    var stallRead: Double = 0

    /// Smoothed read of which side the mark is giving up, -1…1.
    var openRead: Double = 0

    /// The side the offence is actually PLAYING to. Separate from `openRead` because
    /// the whole shape — stack column, handler stations, which side every cut attacks
    /// — hangs off it, and a shape that mirrors itself whenever the marker's hips
    /// wobble is not a shape. It snaps once when the mark is first seen, then needs
    /// sustained contrary evidence to flip.
    var openCommit: Playbook.Sign = 1

    /// The side a POSITIONAL force (middle / sideline) has committed to. Held through
    /// `FORCE_DEADBAND` so the call does not chatter as the disc crosses the middle of
    /// the field. Nil until the first call.
    var forceSide: Playbook.Sign?
    var forceSeen = false

    /// A force CALLED BY A HUMAN, overriding whatever `force` was configured.
    ///
    /// Calling the force is the defensive captaincy of this sport — one decision that
    /// re-points all seven bodies — so when a person is on the field it has to be
    /// theirs to make, not a string in a config object they cannot reach.
    ///
    /// It is deliberately applied at the DEFENCE and nowhere else. The offence already
    /// discovers the force the only way a real team can: `readForce` watches which side
    /// of the thrower the mark is actually standing on. So flipping this moves the
    /// marker's body, and the stack, the reset and the break side all re-orient off
    /// that — through the same path they would if an AI marker had moved.
    var calledForce: Playbook.Sign?

    /// Call the force to a sideline, or pass nil to hand it back to `force`.
    public func setCalledForce(_ side: Playbook.Sign?) { calledForce = side }
    public var called: Playbook.Sign? { calledForce }

    /// The open side this defence is actually playing, once the force — configured or
    /// called — has been resolved against the disc. Nil before the first live defensive
    /// step. The human's mark assist needs it to know which side of the thrower
    /// "holding the force" means standing on.
    public var openSideOnD: Playbook.Sign? { forceSide }

    /* defence */
    var scheme: DefenceScheme = .person
    public var force: Playbook.Force
    /// defenderId -> offenceId. Ordered: `personDefence` iterates it and keeps the
    /// last defender matched to the thrower.
    var matchup = OrderedIntMap<Int>()
    /// defenderId -> zone responsibility. Ordered for the same reason.
    var zoneRole = OrderedIntMap<Playbook.ZoneRole>()
    var stallClock: Double = 0
    /// Which defender the running count belongs to.
    var stallMarker: Int = -1
    var markerId: Int = -1
    var deepHelpId: Int = -1

    /* stack slots — see `refreshStackSlots` */
    var slotOf: [Int: Int] = [:]
    var slotScratch: [Int] = []
    var slotSig: Int = -1
    var slotPending: Int = -1
    var slotPendingT: Double = 0

    /* scratch, refreshed per update */
    var mates: [AIPlayer] = []
    var foes: [AIPlayer] = []
    var mem: [Int: Mem] = [:]
    var byId: [Int: AIPlayer] = [:]

    /// The locomotion peer, latched from the world exactly where the reference latches
    /// `world.sys` — in `refresh` and again in `predictCatchPoint`.
    var locoRef: LocomotionPeer?

    /// The reference disables a misbehaving disc peer permanently through a module
    /// `WeakMap` keyed on the peer object. Swift protocol values have no guaranteed
    /// identity (a peer may be a struct), so the latch is per-`TeamAI` instead. The
    /// observable difference is confined to the case where a peer returns a malformed
    /// path AND two TeamAIs share it: the second would re-probe once. Nothing in this
    /// port ships such a peer.
    var discPeerFailed = false

    /// `cfg` is a whole value here where the reference takes a `Partial` spread over
    /// `DEFAULT_TEAM_CONFIG`; pass `DEFAULT_TEAM_CONFIG` and mutate what you mean.
    ///
    /// **`field` has no default.** It used to be `.standard`, which made sevens the pitch
    /// an AI got for not saying — on a game whose DEFAULT format is minis. Every constant
    /// this class decides with was measured on the regulation field, so an omitted
    /// argument is not a mild convenience, it is the whole of issue #17 reintroduced by a
    /// keystroke. Making it required costs each caller five characters and makes the
    /// recurrence a compile error.
    ///
    /// It is still a `FieldConstants` and not a `GameFormat`, so `playersPerSide` cannot
    /// reach the AI: `Playbook.stackHoldFor` already has to be told the roster size
    /// separately. Widening it is a larger refactor than this change and is left to #17.
    public init(
        team: TeamId, dir: Dir, rng: Rng,
        cfg: TeamConfig = DEFAULT_TEAM_CONFIG,
        field: FieldConstants
    ) {
        self.team = team
        self.dir = dir
        self.cfg = cfg
        self.pb = Playbook(field: field)
        // The salt is the reference's, digit for digit. Changing it re-rolls every
        // decision this team will ever make from the same parent stream.
        self.rng = rng.fork(salt: cfg.seed * 7919 + team * 104729 + 17)
        self.formation = cfg.formation
        self.force = cfg.force
        self.openRead = Double(Playbook.openSideSign(cfg.force, dir))
        self.openCommit = self.openRead >= 0 ? 1 : -1
    }

    // MARK: - telemetry

    /// Current stall count the marker has reached (0 when not marking).
    public var stall: Double { stallClock }
    public var currentScheme: DefenceScheme { scheme }
    public var currentFormation: Playbook.FormationName { formation }
    /// X sign of the open side, as this team currently understands it.
    public var openSign: Playbook.Sign { openCommit }
    /// X of the column this team's stack is built on.
    public var stackAxisX: Double {
        pb.stackColumnX(formation, anchor, openCommit)
    }

    /// Cutter ids currently HOLDING the stack, front to back.
    public func stackHolding() -> [Int] {
        var out: [Int] = []
        for id in stackOrder where m(id).cutState == .stack { out.append(id) }
        return out
    }

    /// The handler the offence would reset to, or -1.
    public var resetHandler: Int {
        for id in handlerRing where handlerStation[id] == 0 { return id }
        return handlerRing.isEmpty ? -1 : handlerRing[0]
    }

    /// Id of the player currently marking the disc, or -1.
    public var marker: Int { markerId }

    /// Who a defender is assigned to. Nil in zone or unassigned.
    public func matchupOf(_ defenderId: Int) -> Int? { matchup[defenderId] }

    /// This defender's zone responsibility, or nil in person.
    public func zoneRoleOf(_ defenderId: Int) -> Playbook.ZoneRole? { zoneRole[defenderId] }

    // MARK: - the stall count

    /// The stall count belongs to a mark that is actually THERE.
    ///
    /// The count advances only while the marker is inside `markMax`, and it goes back to
    /// zero when the mark is handed to a DIFFERENT defender — a body sprinting in from
    /// six metres has not established anything, and counting on through the handover is
    /// both wrong by rule and the only thing that ever put a "marker" four metres from
    /// the disc while the count ran.
    ///
    /// What this deliberately does NOT do is add a margin to the threshold the count
    /// starts at. An earlier version required the marker inside `markMax - 0.35` to
    /// begin, which is nearer than the radius the disc-space guard backs him out to — so
    /// a marker who had once been too close could never start the count, the thrower was
    /// never put under pressure, no cutter ever went, and **the entire match sat
    /// motionless for four hundred seconds**. The start condition and the standing
    /// geometry are not allowed to disagree.
    /// Public where the reference is private, so `TeamAITests` can assert the start
    /// condition directly rather than inferring it from a trace. The claim above is the
    /// most expensive bug this file has had; it is worth a testable surface.
    public func tickStall(_ clock: Double, _ markDist: Double, _ dt: Double) -> Double {
        markDist <= Playbook.PLAY.markMax ? clock + dt : clock
    }

    // MARK: - command channel

    /// THE `callCut` ENTRY POINT — the one way anything outside this file may steer an
    /// offensive player, and deliberately the only one.
    ///
    /// A human holding a direction on the aim stick is giving an order, not driving a
    /// body: "you, go there". The order has to become a real cut — a setup step the
    /// wrong way, a plant, a hard break into space, a lane claimed so nobody else runs
    /// into it — or the commanded receiver moves differently from the other six and the
    /// offence stops reading as a shape. So the command is expressed in exactly the
    /// vocabulary the AI already runs.
    ///
    /// Contract:
    ///   - `dirX`/`dirZ` are a WORLD XZ direction and need not be unit.
    ///   - The commanded cut OUTRANKS an AI cut already holding the same lane: that
    ///     player is sent to clear.
    ///   - Idempotency is the CALLER's job. Every call rebuilds the route and restarts it
    ///     at `setup`; call it on the edge of the hold, not every step.
    ///   - Safe to call before the first `update()`: it no-ops until the roster has been
    ///     seen.
    ///
    /// Returns the route committed, or nil if the command was refused (unknown player,
    /// wrong team, degenerate direction).
    ///
    /// **Consumes exactly one RNG draw on the success path**, for `buildCut`'s jitter,
    /// and none on any refusal path. That is the reference's draw budget and it is
    /// load-bearing: a refusal that consumed a draw would shift every later decision.
    @discardableResult
    public func commandCut(
        _ receiverId: Int, _ dirX: Double, _ dirZ: Double, _ disc: Vec2d
    ) -> Playbook.CutRoute? {
        guard let p = byId[receiverId], p.team == team else { return nil }
        let l = Foundation.hypot(dirX, dirZ)
        if !(l > 1e-3) { return nil }

        let ux = dirX / l
        let uz = dirZ / l
        let openSign = self.openSign
        let downfield = Double(dir) * uz
        // `Math.sign(ux) || openSign` — the `||` falls through on +0, -0 and NaN.
        let side: Playbook.Sign = jsSignOr(ux, openSign)
        let isHandler = handlerRing.contains(receiverId)

        let kind: Playbook.CutKind
        if downfield > 0.55 {
            kind = formation == .endzone ? .strike : .deep
        } else if downfield < -0.30 {
            kind = abs(ux) > 0.72 ? .swing : .dump
        } else if isHandler && abs(ux) > 0.50 {
            kind = .upLine
        } else {
            kind = side == openSign ? .under : .breakUnder
        }

        var cut = pb.buildCut(
            kind, Vec2d(p.pos.x, p.pos.z), disc, dir, openSign, side, rng.next())

        // A commanded cut has to be somewhere to RUN to. `buildCut` places the target
        // from the receiver's own position and the disc, and for some geometries — a
        // handler already standing where his up-line would take him, most often — it
        // resolves within a stride of his feet. That is not a route: the cutter arrives
        // on the frame he departs, the lane is claimed and released immediately, and the
        // player who asked for a cut sees nothing happen.
        //
        // ALIAS SITE. Reference: `cut.target.x = ...` writes through the route object it
        // just built. `cut` is a local `var` struct here, so the assignment is direct and
        // the returned copy carries it.
        let rx = cut.target.x - p.pos.x
        let rz = cut.target.z - p.pos.z
        let rl = Foundation.hypot(rx, rz)
        if rl < MIN_CUT_RUN {
            let ex = rl > 1e-3 ? rx / rl : ux
            let ez = rl > 1e-3 ? rz / rl : uz
            cut.target.x = p.pos.x + ex * MIN_CUT_RUN
            cut.target.z = p.pos.z + ez * MIN_CUT_RUN
        }

        let mm = m(receiverId)
        if let held = mm.cut, liveLanes[held.lane] == receiverId {
            liveLanes.removeValue(forKey: held.lane)
        }
        if let holder = liveLanes[cut.lane], holder != receiverId {
            let hm = m(holder)
            hm.cut = nil
            hm.cutState = .clear
            hm.cutT = 0
            liveLanes.removeValue(forKey: cut.lane)
        }
        beginCut(receiverId, cut, .setup)
        mm.cutCooldown = 0
        liveLanes[cut.lane] = receiverId
        return cut
    }

    // MARK: - update

    public func update(_ world: AIWorld, _ dt: Double) -> [PlayerIntent] {
        refresh(world)

        for p in mates { tickStamina(p, dt) }

        // Flight epoch: bump whenever the disc leaves a hand.
        if world.disc.state == .flight && lastDiscState != .flight { flightEpoch += 1 }
        lastDiscState = world.disc.state

        // A throw is emitted exactly once per time the disc is in a hand.
        if world.disc.state != .held {
            threwThisPossession = false
            choice = nil
            windup = 0
        }
        // The stall clock belongs to the disc, not the marker: it resets whenever a
        // different player picks it up.
        if world.disc.carrier != markedCarrier {
            markedCarrier = world.disc.carrier
            stallClock = 0
        }

        let possessionChanged = world.possession != lastPossession
        let phaseChanged = world.phase != lastPhase
        if possessionChanged || phaseChanged {
            onPossessionChange(world)
            lastPossession = world.possession
            lastPhase = world.phase
        }

        // Order-independent: the same clamped decrement is applied to every record.
        for (_, rec) in mem {
            rec.cutCooldown = Swift.max(0, rec.cutCooldown - dt)
            rec.switchCd = Swift.max(0, rec.switchCd - dt)
        }

        // See .agents/friction-log/20260810-teamai-lines-up/ — .dead also covers a mid-point stoppage (timeout/contest/check), which this sends to the goal line instead of holding position.
        if world.phase == .setup || world.phase == .pull || world.phase == .dead {
            return lineUp(world, dt)
        }
        return world.possession == team ? offence(world, dt) : defence(world, dt)
    }

    // MARK: - bookkeeping

    func refresh(_ world: AIWorld) {
        locoRef = world.locomotion
        mates.removeAll(keepingCapacity: true)
        foes.removeAll(keepingCapacity: true)
        byId.removeAll(keepingCapacity: true)
        for p in world.players {
            byId[p.id] = p
            if p.team == team { mates.append(p) } else { foes.append(p) }
        }
        for p in mates where mem[p.id] == nil {
            // Seeded from the player's CURRENT position, unlike `m(id)` below which
            // seeds from the origin. That asymmetry is the reference's: a defender
            // created here starts with a correct lagged read, one created lazily starts
            // with a read of (0, 0) and snaps in over `tau`.
            mem[p.id] = Mem(id: p.id, seenX: p.pos.x, seenZ: p.pos.z, faceZ: Double(dir))
        }
    }

    func m(_ id: Int) -> Mem {
        if let v = mem[id] { return v }
        let v = Mem(id: id, seenX: 0, seenZ: 0, faceZ: Double(dir))
        mem[id] = v
        return v
    }

    // MARK: - refusals

    /// Roster lookups this brain could not make, in the words `Engine.refusals` uses.
    ///
    /// **Three `byId[...]!`s used to stand where `body(_:_:)` does now**, and each was
    /// correct only because the roster is fixed: `stackOrder`'s comparator, the handler
    /// station fill and the stall clock's marker all spend an id that came out of a list
    /// built one or more frames earlier, and every one of them was reachable only because
    /// nothing has ever left `byId` between the two. `Engine.setLine` is documented as the
    /// seam a substitution system arrives through, and the first line change that drops or
    /// swaps a body turns each of those into a crash in the middle of a match.
    ///
    /// The pattern is `Engine.checkRosterIsIndexable`'s, for the same reason: trap in a
    /// debug build where a developer sees it, and in release hand the note up to the
    /// engine, which merges it into `refusals` — a list `EngineTests` asserts stays empty
    /// across full automated matches on both formats. So a substitution that breaks this
    /// fails a check rather than either crashing a player's game or passing quietly.
    ///
    /// Capped like the engine's own list: a brain that has lost its roster produces one of
    /// these per body per tick, and an unbounded array would be the second failure.
    public private(set) var refusals: [String] = []
    static let maxRefusals = 32

    /// The body carrying this id — **the lookup, not the force-unwrap.** Nil, with a
    /// report, for an id that is no longer on this brain's roster.
    func body(_ id: Int, _ site: String) -> AIPlayer? {
        if let p = byId[id] { return p }
        note("no body on the roster for id \(id) (\(site))")
        return nil
    }

    func note(_ text: String) {
        if refusals.count < TeamAI.maxRefusals { refusals.append("team \(team): \(text)") }
        assertionFailure("\(text) [team \(team)]")
    }

    /// Hand the notes to the owner and forget them. `Engine.step` calls this every tick,
    /// which is what puts them in front of the checks.
    public func drainRefusals() -> [String] {
        if refusals.isEmpty { return [] }
        defer { refusals.removeAll(keepingCapacity: true) }
        return refusals
    }

    /// Re-form after a turnover, a score or the start of a point.
    func onPossessionChange(_ world: AIWorld) {
        possessionEpoch += 1
        liveLanes.removeAll()
        choice = nil
        windup = 0
        threwThisPossession = false
        stallClock = 0
        holdTime = 0
        holdCarrier = nil
        stallRead = 0
        lastCarrier = nil
        lastCutStart = -99
        forceSeen = false
        // Order-independent: every record is reset to the same constants.
        for (_, rec) in mem {
            rec.cut = nil
            rec.cutState = .stack
            rec.cutT = 0
            rec.cutCooldown = 0
            rec.poach = 0
            rec.poachHold = 0
            rec.bidCommit = false
            rec.flightCommit = -1
        }
        // ALIAS SITE. Reference: `this.anchor.x = world.disc.pos.x` writes through the
        // stored literal. A stored struct property assigns through to the owner.
        anchor.x = world.disc.pos.x
        anchor.z = world.disc.pos.z

        // Roles: the best decision-makers with hands become handlers.
        //
        // The `- p.id * 1e-4` term makes the comparator a total order, so JavaScript's
        // stable sort and Swift's unstable one agree by construction rather than by
        // luck. Every sort in this port has the same property; they are called out
        // individually.
        // Broken into separate accumulations because one older-toolchain compiler
        // (GitHub's macos-15 runner) could not type-check the single expression in
        // reasonable time. The arithmetic and its evaluation order are unchanged.
        func score(_ p: AIPlayer) -> Double {
            var s: Double = p.attr.decision * 1.0
            s += (p.attr.throwAccuracy[.backhand] ?? 0) * 0.5
            s += (p.attr.throwAccuracy[.forehand] ?? 0) * 0.5
            s += p.attr.throwPower * 0.25
            s += (p.archetype == .handler ? 60.0 : 0.0)
            s -= Double(p.id) * 1e-4
            return s
        }
        let ranked = mates.sorted { score($0) > score($1) }
        rankedIds = ranked.map(\.id)
        applyRoleSplit(world, rebuild: true)

        if world.possession != team {
            pickScheme(world)
            assignMatchups(world)
        }
    }

    /// Split the roster into handlers and stack to match the formation actually being
    /// run. This used to be a hard three handlers whatever the look, which left the
    /// vertical stack — a five-cutter set — with only four bodies. Two of those are
    /// always cutting and one is always clearing, so the column the whole sport is read
    /// by was chronically down to a body or two, and the spare handler wandered behind
    /// the disc with nothing to do.
    func applyRoleSplit(_ world: AIWorld, rebuild: Bool) {
        let ranked = rankedIds.filter { byId[$0] != nil }
        if ranked.isEmpty { return }
        let want = Swift.min(
            Playbook.handlerCount(formation, playersPerSide: ranked.count), ranked.count)
        let ring = Array(ranked.prefix(want))
        let cutters = Array(ranked.dropFirst(want))
        let same = ring.count == handlerRing.count
            && zip(ring, handlerRing).allSatisfy { $0 == $1 }
        if same && !rebuild { return }

        // Handlers and cutters run different cut state machines. A player crossing
        // between them mid-cut would leave a lane reserved forever.
        if !rebuild {
            for id in ranked where handlerRing.contains(id) != ring.contains(id) {
                abandonCut(id)
            }
        }

        handlerRing = ring
        for id in ranked {
            if let p = byId[id] { p.role = ring.contains(id) ? .handler : .cutter }
        }

        if rebuild {
            // Front of the stack is whoever is closest to the disc.
            let d = world.disc.pos
            // Total order via the `|| (a - b)` id tiebreak, so stability is moot.
            //
            // Sorted over the BODIES rather than over the ids, so the roster lookup happens
            // once per cutter and outside the comparator. `cutters` is a slice of `ranked`,
            // which was filtered on `byId` a dozen lines up, so this drops nobody today —
            // and the day it does, `body` says so instead of the comparator trapping.
            stackOrder = cutters.compactMap { body($0, "stack order") }
                .sorted { pa, pb in
                    let da = Playbook.dist2(pa.pos.x, pa.pos.z, d.x, d.z)
                    let db = Playbook.dist2(pb.pos.x, pb.pos.z, d.x, d.z)
                    if da != db { return da < db }
                    return pa.id < pb.id
                }
                .map(\.id)
        } else {
            // Keep the order the stack already has; a demoted handler joins the back.
            var next = stackOrder.filter { cutters.contains($0) }
            for id in cutters where !next.contains(id) { next.append(id) }
            stackOrder = next
        }

        handlerStation.removeAll()
        assignHandlerStations(world)
    }

    /// Drop a cut on the floor and release its lane.
    func abandonCut(_ id: Int) {
        let rec = m(id)
        if let cut = rec.cut, liveLanes[cut.lane] == id {
            liveLanes.removeValue(forKey: cut.lane)
        }
        rec.cut = nil
        rec.cutState = .stack
        rec.cutT = 0
        rec.cutCooldown = 0.4
    }

    // MARK: - line up

    /// Pre-pull: everyone on their own goal line, ready to go.
    func lineUp(_ world: AIWorld, _ dt: Double) -> [PlayerIntent] {
        var out: [PlayerIntent] = []
        let goalZ = Double(-dir) * pb.field.goalLine
        let n = mates.isEmpty ? 1 : mates.count
        let sorted = mates.sorted { $0.id < $1.id }
        for i in 0..<sorted.count {
            let p = sorted[i]
            let t = n == 1 ? 0.5 : Double(i) / Double(n - 1)
            let x = Playbook.lerp(-pb.field.sideline + 3.5, pb.field.sideline - 3.5, t)
            let face = Double(world.possession == team ? dir : -dir)
            out.append(
                intent(
                    p, x, goalZ + Double(dir) * 0.4, 0, face, .jog, 0.42, nil,
                    role: p.role.rawValue, state: "lineup", lane: nil, dt: dt))
        }
        return out
    }

    // MARK: - helpers

    /// Pull a target back inside the lines. Speed is capped separately, in `intent`.
    ///
    /// The reference takes a player it never reads; the parameter is kept so the two
    /// files line up call for call.
    func avoidSidelines(_ x: Double, _ z: Double, _ p: AIPlayer) -> Vec2d {
        pb.clampToField(Vec2d(x, z), margin: pb.edgeMargin + 0.7)
    }

    func nearestFoe(_ x: Double, _ z: Double) -> AIPlayer? {
        var best: AIPlayer?
        var bd = 1e9
        for f in foes {
            let d = Playbook.dist2(f.pos.x, f.pos.z, x, z)
            if d < bd {
                bd = d
                best = f
            }
        }
        return best
    }

    /// Build one player's instruction for this step.
    ///
    /// Two guarantees live here and both are speed caps rather than position clamps,
    /// because momentum — not intent — is what carries a player over a line:
    ///
    ///   - nobody leaves the field: speed is capped to `sqrt(2 a s)` over the room left
    ///     to the perimeter in BOTH the target direction and the direction already
    ///     travelled;
    ///   - the marker never enters disc space: `mark` and `shuffle` (and anything
    ///     flagged `settle`) additionally brake to a stop at the target.
    func intent(
        _ p: AIPlayer, _ tx: Double, _ tz: Double, _ fx: Double, _ fz: Double,
        _ mode: AIMoveMode, _ effort: Double, _ action: PlayerAction?,
        role: String, state: String, lane: Playbook.LaneKey?,
        cutX: Double = .nan, cutZ: Double = .nan,
        cutKind: Playbook.CutKind? = nil, cutDepth: Double = -1,
        dt _: Double, settle: Bool = false
    ) -> PlayerIntent {
        // issue #33 — every target reaches a `PlayerIntent` through here, so this
        // is the one place a target on or beyond `boundaryRoom`'s own perimeter
        // can be closed off for every call site at once. Reference: `AI.ts`'s
        // `intent()`, which has the full rationale (a body resting on the line
        // and aimed even slightly further out reads zero room and freezes in
        // every direction). The margin matches `boundaryRoomMargin` exactly, the
        // same shared constant `boundaryRoom` itself uses.
        let safeTarget = pb.clampToField(Vec2d(tx, tz), margin: boundaryRoomMargin)
        let tx = safeTarget.x
        let tz = safeTarget.z
        let rec = m(p.id)
        let fl = Foundation.hypot(fx, fz)
        // Facing is LATCHED, not defaulted: a body asked to face a zero-length vector
        // keeps the direction it last had rather than snapping to +X.
        if fl > 1e-4 {
            rec.faceX = fx / fl
            rec.faceZ = fz / fl
        }
        let maxSpeed = effectiveMaxSpeed(p)
        let decel = effectiveDecel(p)
        let e = clamp(effort, 0, 1)
        let roomTo = boundaryRoom(
            p.pos.x, p.pos.z, tx - p.pos.x, tz - p.pos.z, field: pb.field)
        let roomVel = boundaryRoom(p.pos.x, p.pos.z, p.vel.x, p.vel.z, field: pb.field)
        let capTo = (2 * decel * Swift.max(0, roomTo)).squareRoot()
        let capVel = (2 * decel * Swift.max(0, roomVel)).squareRoot()
        var arriveCap = 1e3
        if settle || mode == .mark || mode == .shuffle {
            let dt2 = Foundation.hypot(tx - p.pos.x, tz - p.pos.z)
            arriveCap = (2 * decel * Swift.max(0, dt2)).squareRoot() * 0.92 + 0.25
        }
        var debug = IntentDebug()
        debug.role = role
        debug.state = state
        debug.lane = lane
        debug.cutX = cutX
        debug.cutZ = cutZ
        debug.cutKind = cutKind
        debug.cutDepth = cutDepth
        return PlayerIntent(
            id: p.id, team: p.team,
            targetX: tx, targetZ: tz,
            faceX: rec.faceX, faceZ: rec.faceZ,
            mode: mode, effort: e,
            desiredSpeed: Swift.min(Swift.min(maxSpeed * e, capTo), Swift.min(capVel, arriveCap)),
            maxSpeed: Swift.min(maxSpeed, Swift.max(capVel, 0.4)),
            maxAccel: effectiveAccel(p),
            maxDecel: decel,
            turnRate: turnRateOf(p),
            arriveRadius: settle ? 1.5 : (mode == .sprint ? 0.6 : (mode == .mark ? 1.5 : 1.1)),
            personalSpace: 0.72,
            action: action,
            debug: debug)
    }
}

// MARK: - JavaScript sign semantics

/// `Math.sign(x)`: -1, 0 or +1, with NaN mapping to NaN. Callers below only ever want
/// the integer cases, so NaN is folded into 0 — which is the value the `||` fallbacks
/// then reject, exactly as JavaScript's falsy test does.
func jsSign(_ x: Double) -> Playbook.Sign {
    if x < 0 { return -1 }
    if x > 0 { return 1 }
    return 0
}

/// `Math.sign(x) || fallback`. JavaScript's `||` falls through on +0, -0 and NaN alike.
func jsSignOr(_ x: Double, _ fallback: Playbook.Sign) -> Playbook.Sign {
    let s = jsSign(x)
    return s == 0 ? fallback : s
}

// MARK: - public API

// `createTeamAI(...)` was here — "the reference's factory shape," a one-line pass
// through to `TeamAI.init`. Deleted (#5): the one production construction site,
// `EnginePoint.swift:256`, calls `TeamAI(...)` directly and always has.

/// Produce this fixed step's intents for one team. Call once per team per 1/120 s
/// step, before locomotion.
public func updateTeam(_ team: TeamAI, _ world: AIWorld, _ dt: Double) -> [PlayerIntent] {
    team.update(world, dt)
}

/// Rest between points: players get some of the tank back.
public func restBetweenPoints(_ players: [AIPlayer], seconds: Double = 45) {
    for p in players {
        let endurance = 0.4 + 0.6 * (p.attr.stamina / 100)
        p.energy = clamp(p.energy + seconds * 0.012 * endurance, 0.12, 1)
    }
}

