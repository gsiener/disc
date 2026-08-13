import CoreGraphics
import Foundation

/// A parsed probe snapshot: `k=v;k=v` pairs decoded into a dictionary with typed
/// accessors.
///
/// The wire format is a semicolon-delimited list of `key=value` pairs with no
/// surrounding braces, no JSON, and no trailing separator. VAL-PROBE-002.
///
/// **Parser semantics** (VAL-PROBE-006, VAL-PROBE-007):
///
/// - A pair without `=` is skipped.
/// - An empty payload yields `fields == [:]` (all defaults).
/// - Duplicate keys: the **last** occurrence's value wins, deterministically.
/// - An empty key (`=v`) is inert — no accessor queries `""`, so it cannot shadow
///   or overwrite a named key.
/// - An empty value (`k=`) yields `fields["k"] == ""`, and the typed accessors return
///   their defaults for an empty string: `string→""`, `int→0`, `double→nil`,
///   `flag→false`.
/// - The `double` accessor returns whatever `Double(_:)` parses — it does **not**
///   coerce non-finite to nil — so `inf`/`-inf`/`nan` return non-nil, non-finite
///   values. A non-parseable token returns nil.
/// - The `flag` accessor returns `true` only for exactly `"1"`.
/// - The `pitch` accessor returns a non-nil rect only for exactly four comma-separated
///   doubles with positive width and height.
/// - A `process=lost` sentinel yields all-default match-state accessors because no
///   retained key is set.
public struct Probe: Equatable, Sendable {

    /// The raw label string, as read from the accessibility element.
    public let raw: String

    /// The parsed key-value dictionary. Public so contract tests can assert on
    /// exact contents (VAL-PROBE-007: `Probe("").fields == [:]`).
    public let fields: [String: String]

    public init(_ raw: String) {
        self.raw = raw
        var f: [String: String] = [:]
        for pair in raw.split(separator: ";") {
            guard let eq = pair.firstIndex(of: "=") else { continue }
            f[String(pair[pair.startIndex..<eq])] = String(pair[pair.index(after: eq)...])
        }
        self.fields = f
    }

    // MARK: - Basic typed accessors (String-keyed, for contract tests)

    /// The string value for a key, or `""` if the key is absent. VAL-PROBE-006.
    public func string(_ key: String) -> String { fields[key] ?? "" }

    /// The integer value for a key, or `0` if the key is absent or non-integer.
    /// VAL-PROBE-006.
    public func int(_ key: String) -> Int { Int(fields[key] ?? "") ?? 0 }

    /// The double value for a key, or nil if the key is absent or non-double.
    /// Returns non-finite values (inf, -inf, nan) as-is rather than coercing to nil.
    /// VAL-PROBE-006, VAL-PROBE-007.
    public func double(_ key: String) -> Double? { Double(fields[key] ?? "") }

    /// `true` only when the value is exactly `"1"`. VAL-PROBE-006.
    public func flag(_ key: String) -> Bool { fields[key] == "1" }

    // MARK: - Basic typed accessors (ProbeKey-keyed, for producer/consumer)

    public func string(_ key: ProbeKey) -> String { fields[key.rawValue] ?? "" }
    public func int(_ key: ProbeKey) -> Int { Int(fields[key.rawValue] ?? "") ?? 0 }
    public func double(_ key: ProbeKey) -> Double? { Double(fields[key.rawValue] ?? "") }
    public func flag(_ key: ProbeKey) -> Bool { fields[key.rawValue] == "1" }

    // MARK: - Semantic accessors (resolved through ProbeKey)

    /// `humanRelease`'s precondition: our man is holding it, so a drag will throw.
    public var canThrow: Bool { flag(.mine) }
    /// `humanCallCut`'s precondition, cooldown included.
    public var canCut: Bool { flag(.cutOk) }
    /// `humanDefend`'s situation: they have it or it is in the air.
    public var canDefend: Bool { flag(.defOk) }

    // Input-tape counters.
    public var thrown: Int { int(.thrown) }
    public var cuts: Int { int(.cuts) }
    public var defends: Int { int(.defends) }

    // The last release.
    public var grade: String { string(.grade) }
    public var hold: Double? { double(.hold) }
    public var throwType: String { string(.type) }

    // The gesture under the thumb.
    public var drag: String { string(.drag) }
    public var dragEnd: String { string(.dragend) }

    // The two order plates.
    public var cut: String { string(.cut) }
    public var defence: String { string(.def) }

    // Tap-ledger counters.
    public var taps: Int { int(.taps) }
    public var refused: Int { int(.refused) }
    public var widened: Int { int(.wide) }
    public var refusal: String { string(.refuse) }
    public var refusalTally: String { string(.tally) }

    // Phase.
    public var phase: String { string(.phase) }
    public var isLive: Bool { phase == "live" }

    /// The pitch rectangle, in the window's coordinates. Returns nil unless exactly
    /// four comma-separated doubles with positive width and height are present.
    /// VAL-PROBE-007.
    public var pitch: CGRect? {
        let parts = string(.rect).split(separator: ",").compactMap { Double($0) }
        guard parts.count == 4, parts[2] > 0, parts[3] > 0 else { return nil }
        return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
    }

    /// Seconds until the watched body is back on its feet, or nil while it is.
    public var recovery: Double? { double(.rec) }

    // Match flags.
    public var isOver: Bool { flag(.over) }
    public var paused: Bool { flag(.paused) }
    public var sheet: Bool { flag(.sheet) }

    /// The score as `"x-y"`.
    public var score: String { string(.score) }

    /// Which team has possession (0 = us, 1 = them).
    public var poss: Int { int(.poss) }
}
