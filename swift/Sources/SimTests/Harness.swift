import Foundation

/// The test harness, ported in spirit from the TypeScript suites.
///
/// Assertions are *envelope* assertions: a labelled condition, or a value inside
/// a stated range. That choice is what lets the same suites survive a port at
/// all — a golden-value suite would have to be regenerated the moment any libm
/// differs, whereas a range holds across an ulp of drift.
///
/// Where a value genuinely must be identical rather than close, use `bitEq`, and
/// mean it: reach for it only when the operation is correctly rounded by IEEE 754
/// and a difference would therefore be a logic bug rather than platform noise.
enum Check {
    nonisolated(unsafe) static var passed = 0
    nonisolated(unsafe) static var failures: [String] = []

    /// The number of assertions run, so a suite can report that it grew rather
    /// than silently stopped asserting.
    static var count: Int { passed + failures.count }

    static func ok(_ condition: Bool, _ label: @autoclosure () -> String) {
        if condition {
            passed += 1
        } else {
            failures.append(label())
        }
    }

    /// Exact equality for integers and other discrete values.
    static func eq<T: Equatable>(_ got: T, _ want: T, _ label: @autoclosure () -> String) {
        ok(got == want, "\(label()) — got \(got), want \(want)")
    }

    /// Bit-for-bit equality of two doubles.
    ///
    /// Compares bit patterns rather than using `==` so that a sign-of-zero or NaN
    /// difference cannot slip through as equal.
    static func bitEq(_ got: Double, _ want: Double, _ label: @autoclosure () -> String) {
        ok(
            got.bitPattern == want.bitPattern,
            "\(label()) — got \(got) (0x\(String(got.bitPattern, radix: 16))), "
                + "want \(want) (0x\(String(want.bitPattern, radix: 16)))"
        )
    }

    static func near(
        _ got: Double, _ want: Double, _ tol: Double, _ label: @autoclosure () -> String
    ) {
        ok(abs(got - want) <= tol, "\(label()) — got \(got), want \(want) ± \(tol)")
    }

    static func inRange(
        _ got: Double, _ lo: Double, _ hi: Double, _ label: @autoclosure () -> String
    ) {
        ok(got >= lo && got <= hi, "\(label()) — got \(got), want [\(lo), \(hi)]")
    }
}

/// Loads a golden fixture by name from `swift/Goldens/`.
///
/// Located relative to this source file rather than through a resource bundle,
/// because an executable target has no bundle and because a path that is wrong is
/// better as a hard crash at startup than as a silently skipped suite.
enum Goldens {
    static func load<T: Decodable>(_ type: T.Type, _ name: String) -> T {
        let root = URL(fileURLWithPath: #filePath)  // .../Sources/SimTests/Harness.swift
            .deletingLastPathComponent()  // .../Sources/SimTests
            .deletingLastPathComponent()  // .../Sources
            .deletingLastPathComponent()  // .../swift
        let url = root.appendingPathComponent("Goldens/\(name).json")

        guard let data = try? Data(contentsOf: url) else {
            FileHandle.standardError.write(
                Data(
                    """
                    cannot read \(url.path)
                    run `node tools/gen-goldens.ts` from the repo root first

                    """.utf8))
            exit(2)
        }
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            FileHandle.standardError.write(Data("\(name).json does not decode: \(error)\n".utf8))
            exit(2)
        }
    }
}

/// A named suite, so `swift run SimTests rng` can select one.
struct Suite {
    let name: String
    let run: () -> Void
}

func runSuites(_ all: [Suite]) -> Never {
    let requested = Set(CommandLine.arguments.dropFirst())
    let selected = requested.isEmpty ? all : all.filter { requested.contains($0.name) }

    if selected.isEmpty {
        let names = all.map(\.name).joined(separator: " ")
        print("no suite matched \(requested.sorted().joined(separator: " ")) — have: \(names)")
        exit(2)
    }

    for suite in selected {
        let before = Check.count
        suite.run()
        let ran = Check.count - before
        print("  \(suite.name.padding(toLength: 12, withPad: " ", startingAt: 0)) \(ran) assertions")
    }

    if Check.failures.isEmpty {
        print("\u{1B}[32m\u{1B}[1mPASS\u{1B}[0m  \(Check.count) assertions, 0 failures")
        exit(0)
    }

    // Cap the printed list: a structural porting bug fails thousands of
    // assertions at once, and a screen of identical lines buries the summary.
    print("\u{1B}[31m\u{1B}[1mFAIL\u{1B}[0m  \(Check.failures.count) of \(Check.count) assertions")
    for failure in Check.failures.prefix(25) { print("  · \(failure)") }
    if Check.failures.count > 25 {
        print("  … and \(Check.failures.count - 25) more")
    }
    exit(1)
}
