import Foundation

/// Deliberately break the simulation and check that something notices.
///
/// # Why this exists
///
/// A check written against code that already passes it proves nothing: it locks in the
/// behaviour it found, bugs included. The only evidence that an assertion is load-bearing is
/// that it fails when the thing it describes is broken. So every suite that replaces a
/// fixture under issue #58 has to earn it — introduce the bug the assertion claims to catch,
/// and watch it go red.
///
/// That discipline has already paid for itself twice. `rng`'s first pass left the `gauss`
/// clamp unasserted, because a draw below 1e-7 happens about once in ten million and no
/// volume of sampling reaches it. `shape`'s clearing bound was green against a build where
/// clears never left the lane, because the mean was diluted by cuts that had nothing to
/// clear. Neither was visible by reading.
///
/// # What a mutation is
///
/// A file, an exact string to find, and what to put there instead. Exact rather than a
/// pattern on purpose: a regular expression that silently matches nothing reports a survivor,
/// and a survivor that is really a typo is worse than no result at all — it sends you looking
/// for a gap in a suite that does not have one. A mutation that does not apply is an error
/// here, not a pass.
///
/// # Reading the output
///
/// `RED` is the good outcome: the bug was introduced and the suite caught it. `SURVIVED` is a
/// gap — the simulation is wrong and nothing said so. `BUILD FAILED` means the mutation did
/// not compile, so it tested nothing; rewrite it into something the compiler accepts.
///
/// Restoration is unconditional. A mutation left in the tree makes every measurement after it
/// a measurement of a broken sim, which has already happened here once, in a worktree that
/// carried `maxLiveCuts = 5` through an entire run.

struct Mutation {
    let name: String
    let file: String
    let find: String
    let replace: String
    let suites: [String]
}

enum Outcome: String {
    case red = "RED"           // caught — the good one
    case survived = "SURVIVED" // a gap
    case notApplied = "NOT APPLIED"
    case buildFailed = "BUILD FAILED"
}

let root = ProcessInfo.processInfo.environment["REPO_ROOT"]
    ?? FileManager.default.currentDirectoryPath
let swiftDir = root + "/swift"

@discardableResult
func shell(_ args: [String], cwd: String) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    p.arguments = args
    p.currentDirectoryURL = URL(fileURLWithPath: cwd)
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try? p.run()
    p.waitUntilExit()
    return p.terminationStatus
}

/// One mutation, applied and undone. The `defer` is the whole safety argument: the file is
/// restored whether the build fails, the suite fails, or this exits early.
func evaluate(_ m: Mutation) -> Outcome {
    let path = root + "/" + m.file
    guard let original = try? String(contentsOfFile: path, encoding: .utf8) else {
        return .notApplied
    }
    guard original.contains(m.find) else { return .notApplied }

    defer { try? original.write(toFile: path, atomically: true, encoding: .utf8) }

    guard let range = original.range(of: m.find) else { return .notApplied }
    let mutated = original.replacingCharacters(in: range, with: m.replace)
    guard (try? mutated.write(toFile: path, atomically: true, encoding: .utf8)) != nil else {
        return .notApplied
    }

    if shell(["swift", "build", "-c", "release", "--product", "SimTests"], cwd: swiftDir) != 0 {
        return .buildFailed
    }
    // A non-zero exit is a failing suite, which is the outcome being hoped for.
    let status = shell([".build/release/SimTests"] + m.suites, cwd: swiftDir)
    return status == 0 ? .survived : .red
}

// MARK: - the mutation set

/// Parsed from a plain file so the set is data rather than code, and a family's mutations can
/// be added in the same commit as the suite that should catch them.
///
///     name        | file | find | replace | suite,suite
///
/// Blank lines and `#` comments are ignored. Pipes are the separator because Swift source is
/// full of commas and colons and nothing else was unambiguous.
func parse(_ text: String) -> [Mutation] {
    text.components(separatedBy: "\n").compactMap { line in
        let t = line.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, !t.hasPrefix("#") else { return nil }
        let f = t.components(separatedBy: "|").map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        guard f.count == 5 else { return nil }
        return Mutation(
            name: f[0], file: f[1], find: f[2], replace: f[3],
            suites: f[4].components(separatedBy: ",").map {
                $0.trimmingCharacters(in: .whitespaces)
            })
    }
}

let specPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : root + "/swift/mutations.txt"

guard let spec = try? String(contentsOfFile: specPath, encoding: .utf8) else {
    print("no mutation spec at \(specPath)")
    exit(2)
}

let mutations = parse(spec)
guard !mutations.isEmpty else {
    print("no mutations parsed from \(specPath)")
    exit(2)
}

print("\(mutations.count) mutations\n")

var counts: [Outcome: Int] = [:]
var gaps: [String] = []

for (i, m) in mutations.enumerated() {
    let outcome = evaluate(m)
    counts[outcome, default: 0] += 1
    if outcome != .red { gaps.append("\(m.name) [\(outcome.rawValue)] — \(m.suites.joined(separator: ","))") }
    let mark = outcome == .red ? "  ok  " : "  ??  "
    print("\(mark)[\(i + 1)/\(mutations.count)] \(outcome.rawValue.padding(toLength: 12, withPad: " ", startingAt: 0)) \(m.name)")
}

print("\nred \(counts[.red] ?? 0)  survived \(counts[.survived] ?? 0)"
    + "  not-applied \(counts[.notApplied] ?? 0)  build-failed \(counts[.buildFailed] ?? 0)")

// **Rebuild before leaving.** The source is restored after each mutation, but the binary
// is not — so without this the last mutation stays compiled into `.build/release/SimTests`,
// and the next person to run the suite gets a failure that is not real. That happened once
// and cost a bisect of a bug that did not exist.
print("\nrebuilding from restored source…")
if shell(["swift", "build", "-c", "release", "--product", "SimTests"], cwd: swiftDir) != 0 {
    print("the restored tree does not build — check for a mutation left behind")
    exit(2)
}

if gaps.isEmpty {
    print("Every mutation was caught.")
    exit(0)
}
print("\nNot caught:")
for g in gaps { print("  \(g)") }
exit(1)
