import Foundation

/// Reading the tree as text, and keeping score.
///
/// These audits are invariants the compiler cannot express and `SimChecks` cannot run.
/// ADR-0002 requires the identical assertions to run inside the shipped app, where there is
/// no source tree to read and no way to enumerate a module's declarations — so a check about
/// the *shape of the source* has to live somewhere else, and this is that somewhere.

enum Source {
    static func swiftFiles(under dir: String) -> [String] {
        guard let e = FileManager.default.enumerator(atPath: dir) else { return [] }
        return e.compactMap { $0 as? String }
            .filter { $0.hasSuffix(".swift") }
            .map { dir + "/" + $0 }
            .sorted()
    }

    static func load(_ dirs: [String]) -> [String: [String]] {
        var out: [String: [String]] = [:]
        for d in dirs {
            for f in swiftFiles(under: d) {
                guard let t = try? String(contentsOfFile: f, encoding: .utf8) else { continue }
                out[f] = t.components(separatedBy: "\n")
            }
        }
        return out
    }

    static let root = ProcessInfo.processInfo.environment["REPO_ROOT"]
        ?? FileManager.default.currentDirectoryPath

    static func rel(_ p: String) -> String {
        p.hasPrefix(root + "/") ? String(p.dropFirst(root.count + 1)) : p
    }

    /// A pattern that does not compile is a bug in this target, not in the tree it scans.
    static func regex(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p) }
}

extension NSRegularExpression {
    func firstMatch(in s: String) -> NSTextCheckingResult? {
        firstMatch(in: s, range: NSRange(s.startIndex..., in: s))
    }
    func matches(_ s: String) -> Bool { firstMatch(in: s) != nil }
}

/// Failures collected across every audit, so one run reports all of them rather than
/// stopping at the first — a scan you have to run four times to see four problems is a scan
/// people run once.
struct Report {
    private(set) var failures: [String] = []
    let quiet: Bool

    mutating func ok(_ condition: Bool, _ label: String, _ detail: @autoclosure () -> String = "") {
        if condition {
            if !quiet { print("  ok       \(label)") }
        } else {
            let d = detail()
            failures.append(d.isEmpty ? label : "\(label) — \(d)")
            print("  FAIL     \(label)\(d.isEmpty ? "" : " — \(d)")")
        }
    }

    mutating func note(_ s: String) { print(s) }
}
