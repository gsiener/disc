import Foundation

/// The field format selected by `-format`.
///
/// `7v7` selects `.full` (the regulation full field); any other value selects
/// `.minis`. Absence yields nil, meaning the saved sheet choice is used.
/// VAL-LAUNCH-003.
public enum LaunchFormat: Equatable, Sendable {
    case full
    case minis
}
