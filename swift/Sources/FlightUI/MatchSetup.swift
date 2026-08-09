import Foundation
import UltimateSim

/// What a player chose before the whistle: how long the game is, how many bodies are on
/// the pitch, and how much help they want.
///
/// `EngineConfig` is the sim's spelling of the same idea and it has thirty fields, most
/// of which are pacing constants nobody outside the engine should be asked about. This is
/// the three decisions worth putting in front of a thumb, plus the mapping down to those
/// thirty. The mapping is one-way and lives here rather than in the sheet, so the sheet
/// stays a set of buttons and the difficulty curve stays one readable table.
struct MatchSetup: Equatable, Codable {

    // MARK: format

    /// Which pitch, spelled as something storable. `FieldSpec` is a struct of doubles and
    /// is not `Codable`; the choice a player made is one of two things and survives as
    /// one of two things.
    enum Format: String, Codable, CaseIterable {
        case minis
        case full

        var spec: FieldSpec { self == .minis ? .minis : .full }
        var label: String { self == .minis ? "3v3" : "7v7" }
        var detail: String { self == .minis ? "MINIS" : "REGULATION" }
    }

    // MARK: difficulty

    /// How much the game does for you, and how hard the other side plays.
    ///
    /// Only levers the engine actually exposes are used, and each does something a player
    /// would recognise:
    ///
    ///   - **`selectCone`** is the half-angle of the drag-to-select cone — how roughly you
    ///     may point at a receiver and still be understood. Wide is forgiving; narrow
    ///     means you must actually aim at somebody.
    ///   - **`assistMax`** caps how far aim assist may rotate your release. It is the
    ///     difference between a throw that is nudged onto the lead and one that goes
    ///     exactly where your thumb said.
    ///   - **the opponent's `aggressionScale`** is how willing *their* offence is to let
    ///     it go, folded multiplicatively into the engine-level knob. Ours is left alone,
    ///     because difficulty should change what the other team does, not silently
    ///     re-tune the side you are playing.
    ///
    /// The engine-level `aggression` is left at its default on every level. It scales
    /// *both* offences at once, so moving it is a pacing change dressed as a difficulty
    /// change — the per-side scale is the honest lever.
    enum Difficulty: String, Codable, CaseIterable {
        case easy
        case normal
        case hard

        var label: String {
            switch self {
            case .easy: "EASY"
            case .normal: "NORMAL"
            case .hard: "HARD"
            }
        }

        /// One line of "what this actually changes", because a difficulty picker that
        /// only says EASY/NORMAL/HARD is asking the player to guess.
        var detail: String {
            switch self {
            case .easy: "WIDE CONE · MORE ASSIST"
            case .normal: "THE TUNED GAME"
            case .hard: "TIGHT CONE · YOU AIM"
            }
        }

        /// Half-angle of the receiver-select cone, radians. Normal is the brief's pinned
        /// 35°; easy opens it to 50°, hard closes it to 24°.
        var selectCone: Double {
            switch self {
            case .easy: 50 * Double.pi / 180
            case .normal: HumanTargeting.selectCone
            case .hard: 24 * Double.pi / 180
            }
        }

        /// Cap on assist rotation, radians. Normal is the pinned 5°.
        ///
        /// Note the ceiling that is not ours: `HumanTargeting.assistWindow` is 12° and the
        /// assist declines entirely outside it, on every level. Easy therefore buys a
        /// bigger correction *within* the window, not a wider window — past 12° you are
        /// throwing somewhere else on purpose and the game still believes you.
        var assistMax: Double {
            switch self {
            case .easy: 9 * Double.pi / 180
            case .normal: HumanTargeting.assistMax
            case .hard: 3 * Double.pi / 180
            }
        }

        /// Multiplier on the opposing side's `aggressionScale`, whose default is 0.95.
        var opponentAggression: Double {
            switch self {
            case .easy: 0.78
            case .normal: 1.0
            case .hard: 1.30
            }
        }
    }

    // MARK: the three choices

    var format: Format = .minis
    /// First to this many goals. The sheet offers 3, 5 and 7.
    ///
    /// Not 15. A regulation game is to 15 and this one is played on a phone: a game to 7
    /// already runs twenty to forty minutes, which is a commute, not a session. Five is
    /// the default because three can be decided by one lucky point.
    var pointsToWin: Int = 5
    var difficulty: Difficulty = .normal

    /// The lengths the sheet offers, shortest first.
    static let lengths = [3, 5, 7]

    // MARK: down to the engine

    /// The sim's spelling of this setup.
    var engineConfig: EngineConfig {
        var config = EngineConfig.default
        config.pointsToWin = pointsToWin
        config.selectCone = difficulty.selectCone
        config.assistMax = difficulty.assistMax

        // Scale the opponent's willingness, leave ours alone. Index 1 is the computer's
        // side; `EngineConfig` cycles the table if it is shorter than the team count, so
        // the two entries cover both teams on either pitch.
        if config.sideStyles.count > 1 {
            config.sideStyles[1].aggressionScale *= difficulty.opponentAggression
        }

        // Halftime is a six-second hold with nothing on screen — see
        // `EngineConfig.halftimeSeconds`, which already cut it from five minutes. In a
        // game to three the derived midpoint lands after two goals, so a third of the
        // match would be spent watching a paused pitch. Longer games keep the break.
        if pointsToWin <= 3 { config.halftimeAt = pointsToWin * 2 + 1 }

        return config
    }

    /// The pitch, with the chosen target on it, so the scoreboard's "first to N" and the
    /// engine's win condition are the same number.
    var fieldSpec: FieldSpec {
        let base = format.spec
        return FieldSpec(
            length: base.length, width: base.width, endzoneDepth: base.endzoneDepth,
            teamSize: base.teamSize, target: pointsToWin)
    }
}

// MARK: - persistence

/// Where the last-used setup and the "has this player been taught the controls" flag
/// live.
///
/// `UserDefaults` rather than a file: two small values, both of which should survive an
/// app update and none of which is worth a migration. Reads are total — a decode failure
/// is treated as "no preference yet" rather than as an error, because the only honest
/// recovery from a corrupt three-field preference is the default three fields.
enum Prefs {
    private static let setupKey = "match.setup.v1"
    private static let coachKey = "coach.seen.v1"

    private static var store: UserDefaults { .standard }

    static func loadSetup() -> MatchSetup? {
        guard let data = store.data(forKey: setupKey) else { return nil }
        return try? JSONDecoder().decode(MatchSetup.self, from: data)
    }

    static func save(_ setup: MatchSetup) {
        guard let data = try? JSONEncoder().encode(setup) else { return }
        store.set(data, forKey: setupKey)
    }

    /// Whether the coach overlay has already been sat through once.
    static var coachSeen: Bool {
        get { store.bool(forKey: coachKey) }
        set { store.set(newValue, forKey: coachKey) }
    }
}
