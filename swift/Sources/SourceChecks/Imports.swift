import Foundation

/// ADR-0008 — the reference does not depend on the client, and the Swift port mirrors
/// that layering.
///
/// The TypeScript version checks that `src/sim/` never value-imports from renderer trees.
/// The Swift port enforces the same intent on the Swift sources: `UltimateSim` depends on
/// nothing but the standard library, and `ProbeContract` is a dependency-free contract
/// shared across the process boundary (issue #21).
enum Imports {

    static let ultimateSimAllowlist: Set<String> = ["Foundation"]
    static let probeContractAllowlist: Set<String> = ["Foundation", "CoreGraphics"]

    static let importRe = Source.regex(#"^\s*import\s+([A-Za-z_]\w*)"#)

    static func run(_ report: inout Report) {
        report.note("\nADR-0008 — layering (imports)")

        // UltimateSim: Foundation only
        let ultimateSimFiles = Source.load(["\(Source.root)/swift/Sources/UltimateSim"])
        report.ok(!ultimateSimFiles.isEmpty, "UltimateSim found", "\(ultimateSimFiles.count) files")

        var badUltimateSim: [(file: String, imports: [String])] = []
        for (file, lines) in ultimateSimFiles {
            var imports: [String] = []
            for line in lines {
                guard let m = importRe.firstMatch(in: line),
                      m.numberOfRanges > 1,
                      let r = Range(m.range(at: 1), in: line) else { continue }
                let imp = String(line[r])
                if !ultimateSimAllowlist.contains(imp) {
                    imports.append(imp)
                }
            }
            if !imports.isEmpty {
                badUltimateSim.append((Source.rel(file), imports))
            }
        }

        if badUltimateSim.isEmpty {
            report.ok(true, "UltimateSim", "Foundation only")
        } else {
            for (file, imports) in badUltimateSim {
                report.ok(false, "UltimateSim/\(file)", "imports \(imports.joined(separator: ", ")) outside allowlist")
            }
        }

        // ProbeContract: Foundation and CoreGraphics only
        let probeContractFiles = Source.load(["\(Source.root)/swift/Sources/ProbeContract"])
        report.ok(!probeContractFiles.isEmpty, "ProbeContract found", "\(probeContractFiles.count) files")

        var badProbeContract: [(file: String, imports: [String])] = []
        for (file, lines) in probeContractFiles {
            var imports: [String] = []
            for line in lines {
                guard let m = importRe.firstMatch(in: line),
                      m.numberOfRanges > 1,
                      let r = Range(m.range(at: 1), in: line) else { continue }
                let imp = String(line[r])
                if !probeContractAllowlist.contains(imp) {
                    imports.append(imp)
                }
            }
            if !imports.isEmpty {
                badProbeContract.append((Source.rel(file), imports))
            }
        }

        if badProbeContract.isEmpty {
            report.ok(true, "ProbeContract", "Foundation and CoreGraphics only")
        } else {
            for (file, imports) in badProbeContract {
                report.ok(false, "ProbeContract/\(file)", "imports \(imports.joined(separator: ", ")) outside allowlist")
            }
        }

        // One Rng implementation (no duplicate xorshift128)
        let allSwiftFiles = Source.load(["\(Source.root)/swift/Sources/UltimateSim", "\(Source.root)/swift/Sources/ProbeContract"])
        var rngImplementations: [String] = []
        for (file, lines) in allSwiftFiles {
            let src = lines.joined(separator: "\n")
            // The warm-up loop fingerprint: discards 16 draws in constructor
            if src.contains("for _ in 0..<16 { _ = next() }") {
                rngImplementations.append(Source.rel(file))
            }
        }
        report.ok(
            rngImplementations.count == 1 && rngImplementations[0] == "swift/Sources/UltimateSim/Rng.swift",
            "one Rng implementation",
            rngImplementations.isEmpty ? "nowhere" : "in \(rngImplementations.count): \(rngImplementations.joined(separator: ", "))"
        )
    }
}