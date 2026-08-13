import Foundation

/// The dependency-free contract shared by the production app and the UI-test bundle.
///
/// Issue #21: launch-argument names, receive-side values, probe keys, the probe
/// accessibility identifier, and the wire-format parser were duplicated across
/// `UltimateApp`, `FlightUI/MatchProbe`, and `UltimateUITests/MatchDriver`. A rename
/// on one side silently defaulted on the other. This target owns the canonical
/// vocabulary so a change is a compile error on both sides rather than a silent drift
/// at runtime.
///
/// The target imports only `Foundation` (and `CoreGraphics` for `CGPoint`/`CGRect`).
/// It must not import SwiftUI, RealityKit, UIKit, or `UltimateSim` — see the
/// dependency graph in `architecture.md`.
public enum ProbeContract {

    /// The canonical accessibility identifier for the match probe element.
    ///
    /// Defined once here and referenced by both the producer (`FlightUI/MatchProbe`)
    /// and the consumer (`UltimateUITests/MatchDriver`). VAL-PROBE-005 requires exactly
    /// one definition; this is it.
    public static let probeIdentifier = "match.probe"
}
