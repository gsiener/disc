import Foundation
import UltimateSim

#if canImport(UIKit)
    import UIKit
#elseif canImport(AppKit)
    import AppKit
#endif

/// Where a match in progress lives while the app is not running.
///
/// **The thing being saved is not a game state, it is a game.** `Replay.swift` already
/// establishes that a match is a pure function of `(how the engine was built, the seed,
/// the inputs, the tick sequence)`, and it already has the machinery to write that down
/// and play it back bit-exactly. A save file is therefore a `Recording` plus the two
/// things a recording does not need and a save does: a stamp of the simulation that wrote
/// it, and a checksum of where replaying it should land. Both live in `SavedMatch`; this
/// file is only the door to the disk.
///
/// A file rather than `UserDefaults`, which is where `Prefs` keeps the three small
/// settings beside it. The difference is size and shape: a setup is forty bytes and a
/// save is a few kilobytes that grows with the match, and `UserDefaults` is a property
/// list that is read in full on first touch and rewritten in full on every change. The
/// distinction the codebase already draws — small durable preferences there, documents
/// here — is the right one.
///
/// Every read is total. A save that will not decode, or that names a directory this
/// device does not have, is *no save* rather than an error: the only honest recovery from
/// a corrupt saved game is not offering to resume it.
enum MatchSave {
    /// The file. In Application Support rather than Documents because it is state the app
    /// keeps, not a document the player made, and because Documents on iOS is a folder a
    /// file browser can show.
    private static var url: URL? {
        let fm = FileManager.default
        guard
            let dir = try? fm.url(
                for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true)
        else { return nil }
        return dir.appendingPathComponent("match-in-progress.json")
    }

    /// The saved match, if there is one that decodes.
    static func load() -> SavedMatch? {
        guard let url, let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(SavedMatch.self, from: data)
    }

    /// Write, replacing whatever was there.
    ///
    /// Failures are swallowed on purpose. A save that cannot be written is a game that
    /// cannot be resumed, which is exactly where the player was before this existed —
    /// stopping the match to say so would turn a lost convenience into a lost game.
    @discardableResult
    static func write(_ saved: SavedMatch) -> Bool {
        guard let url, let data = try? JSONEncoder().encode(saved) else { return false }
        // Atomic, because the moment this is most likely to be interrupted is the moment
        // it is most likely to be needed: the app is being backgrounded, and the next
        // thing that happens may be the system killing it. A half-written file that
        // decodes into a truncated input list is the one failure mode the checksum would
        // have to catch after a minute of replaying; not creating it is cheaper.
        return (try? data.write(to: url, options: .atomic)) != nil
    }

    /// Forget the saved match. Called when one finishes and when a new one starts.
    static func clear() {
        guard let url else { return }
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - is this save still ours

    /// The stamp a save written under `setup` should carry.
    ///
    /// `SimFingerprint` measures what the *simulation* does, by running a canary match and
    /// hashing it. It cannot see this layer: `MatchSetup.engineConfig` is a mapping from
    /// three buttons onto thirty engine fields, it lives here, and re-tuning it — widening
    /// the easy cone, sharpening the hard opponent — changes a restored match exactly as
    /// surely as re-tuning the aero would. So the numbers that mapping produces are folded
    /// in as the salt, by bit pattern rather than by description, since a difficulty curve
    /// that moved by an ulp is still a different game.
    static func fingerprint(for setup: MatchSetup) -> String {
        SimFingerprint.stamp(salt: salt(for: setup))
    }

    /// The setup, as the numbers it actually hands the engine.
    private static func salt(for setup: MatchSetup) -> String {
        let c = setup.engineConfig
        var parts: [String] = [
            setup.format.rawValue,
            String(setup.fieldSpec.teamSize),
            String(c.pointsToWin ?? -1),
            String(c.halftimeAt ?? -1),
            String(c.selectCone.bitPattern, radix: 16),
            String(c.assistMax.bitPattern, radix: 16),
            String(c.aggression.bitPattern, radix: 16),
        ]
        for style in c.sideStyles {
            parts.append(String(style.aggressionScale.bitPattern, radix: 16))
        }
        return parts.joined(separator: ":")
    }

    // MARK: - the caller's half of a save

    /// The setup, encoded for `SavedMatch.setup`, which the sim carries and never reads.
    static func encode(_ setup: MatchSetup) -> Data? {
        try? JSONEncoder().encode(setup)
    }

    /// The setup a save was written under, if it still decodes into one this build knows.
    static func decodeSetup(_ data: Data?) -> MatchSetup? {
        guard let data else { return nil }
        return try? JSONDecoder().decode(MatchSetup.self, from: data)
    }

    // MARK: - the last moment to write

    /// The notification that says this process is about to end.
    ///
    /// Backgrounding is the save that matters — it is what happens when a phone call
    /// arrives, and it is the only one the system promises to give time for — but a player
    /// who swipes the app away from the switcher gets a terminate without a background on
    /// some paths, and a save that misses that case loses the game in the one way a player
    /// would most obviously blame the app for.
    static var willTerminate: Notification.Name? {
        #if canImport(UIKit)
            return UIApplication.willTerminateNotification
        #elseif canImport(AppKit)
            return NSApplication.willTerminateNotification
        #else
            return nil
        #endif
    }
}
