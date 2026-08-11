import Foundation
import UltimateSim

/// The enforcement half of the divergence registry — ADR-0007, option B.
///
/// ADR-0001 makes the TypeScript reference the oracle. ADR-0007 allows the port to
/// disagree with it *when the disagreement is declared*, and this suite is what makes
/// "declared" mean something. Everything it reads comes out of
/// `Goldens/divergences.json`, which `tools/goldens/divergences.ts` builds by scraping
/// `src/sim/*.ts`; nothing here is a second hand-typed copy of a number that also lives
/// in the reference. That is deliberate — issue #21 is a fixture whose two sides were
/// both typed by a human with nothing asserting they agreed.
///
/// ## What goes red
///
/// **A declared divergence that stopped being the one declared.** Each entry pins three
/// numbers against each other: what the human said Swift holds, what the live Swift
/// symbol actually holds, and what the reference's own source actually says. Move any
/// one of the three and this suite fails. A declared divergence therefore cannot grow,
/// shrink, or quietly close.
///
/// **A divergence that is no longer a divergence.** If the two values converge — because
/// the reference was fixed, say — the entry is a lie about the code and has to go.
///
/// **An undeclared divergence in a named constant.** `referenceConstants` is every
/// module-scope numeric constant in `src/sim/AI.ts`, scraped rather than listed, and
/// `mirrored` below binds each of those names to the live Swift symbol. Equality is the
/// default and the assertion is unconditional, so a Swift-side edit to any of them is
/// red without anyone having thought to write a check for it. A reference constant that
/// the port does not carry under that name has to appear in `unmirrored` with a reason,
/// so a *new* one fails until it is classified.
///
/// ## What it cannot see, stated plainly
///
/// Only values that are **named on the Swift side**. `SimChecks` links `UltimateSim` and
/// reads public symbols, not source text, and it has to: ADR-0002 requires these same
/// assertions to run inside the shipped app, where there is no checkout to parse. So the
/// two jump gates next door to the entry below — `land.y > 1.85` in `defenceInFlight`
/// and `land.y > 1.9` in `offenceInFlight` — are bare literals in both engines and
/// nothing here watches them. Giving a number a name is the price of being policed.
///
/// The other limit belongs to every fixture in this directory: the scrape happens when
/// somebody regenerates. A reference edit that is never regenerated leaves a stale
/// golden, and CI runs no TypeScript at all (ADR-0001, issue #15).
enum DivergenceTests {

    // MARK: fixture shapes

    struct Site: Decodable {
        let file: String
        let what: String
        /// The number read out of the reference's source, or `nil` if the pattern that
        /// was watching it no longer matches — a rename, or a reshuffled expression.
        let scraped: Double?
        let found: Int
        let expected: Int
    }

    struct Divergence: Decodable {
        let constant: String
        let swift: Double
        let reference: Double
        let reason: String
        let declared: String
        let sites: [Site]
    }

    struct File: Decodable {
        let note: String
        let divergences: [Divergence]
        let referenceConstants: [String: Double]
        /// `PULL_*` out of `src/sim/Game.ts`. Optional per name: `PULL_TARGET_Z` is an
        /// expression rather than a literal, so its pattern can stop matching.
        let referencePullConstants: [String: Double?]
    }

    // MARK: the Swift side, bound by name to live symbols

    /// Reference constant name → the **live** Swift value.
    ///
    /// The only thing typed by hand here is the binding. No value is transcribed, so a
    /// renamed Swift symbol is a compile error and an edited one is a failed assertion.
    /// Keys are the *reference's* spelling, because that is what the scrape produces;
    /// several of these are `camelCase` in the port.
    static let mirrored: [String: Double] = [
        "AIM_HEIGHT": AIM_HEIGHT,
        "BID_HESITATION": BID_HESITATION,
        "BID_LEAD": BID_LEAD,
        "CATCH_CEILING": CATCH_CEILING,
        "CATCH_DEAD": CATCH_DEAD,
        "CATCH_FLOOR": CATCH_FLOOR,
        "CATCH_SLOPE": catchSlope,
        "EXTENDED_REACH": EXTENDED_REACH,
        "HAND_HEIGHT": handHeight,
        "LOFT_ARC": loftArc,
        "LOFT_FLIGHT": loftFlight,
        "MIN_CUT_RUN": MIN_CUT_RUN,
        "STANDING_REACH": STANDING_REACH,
    ]

    /// Reference constants the port does not carry under a public name, and why.
    ///
    /// This exists so that a constant appearing in the reference cannot be *ignored*.
    /// Adding one to `src/sim/AI.ts` fails this suite until somebody either binds it
    /// above or writes down here why it has no counterpart.
    static let unmirrored: [String: String] = [
        "CATCH_PLANE_DROP":
            "declared and never read in the reference either — the live number is "
            + "`ThrowSolver.SOLVE_CATCH_DROP`, which `Game.aiThrow` caps the catch "
            + "plane with. Porting it would port dead code; `CatchBandTests` asserts "
            + "the two are still the same 0.25 so the dead copy cannot drift.",
        "LEAD_CUT":
            "ported as `TeamAI.leadCut`, internal to UltimateSim. Covered bit-exact by "
            + "the teamai and throwsolver goldens, which sweep the lead it produces.",
        "LEAD_RUN":
            "ported as `TeamAI.leadRun`, internal to UltimateSim. Same coverage as "
            + "LEAD_CUT.",
    ]

    // MARK: run

    static func run() throws {
        let g = try Goldens.load(File.self, "divergences")

        // The registry is allowed to be short. It is not allowed to be empty without
        // somebody noticing, because an empty registry and a registry nobody maintains
        // look identical from here.
        Check.ok(
            !g.divergences.isEmpty,
            "the divergence registry has at least one entry — an empty one is "
                + "indistinguishable from an abandoned one")

        var seen = Set<String>()
        for d in g.divergences {
            let tag = "divergence \(d.constant)"

            Check.ok(seen.insert(d.constant).inserted, "\(tag) is declared once")

            // Every field of the declaration has to be filled in. A registry entry with
            // no reason and no date is a number, and a bare number is what ADR-0007 was
            // written about.
            Check.ok(d.reason.count > 40, "\(tag) carries a reason, not a shrug")
            Check.ok(
                d.declared.count == 10 && d.declared.hasPrefix("20"),
                "\(tag) carries an ISO date it was declared on — got \(d.declared)")

            // --- half one: the declaration still describes the code -----------------

            guard let live = mirrored[d.constant] ?? liveDivergent[d.constant] else {
                Check.ok(
                    false,
                    "\(tag) names a constant DivergenceTests cannot read. Bind it in "
                        + "`liveDivergent` — a divergence in a value the suite cannot "
                        + "reach is a comment, not a declaration.")
                continue
            }

            Check.bitEq(live, d.swift, "\(tag): the live Swift value is what was declared")

            for s in d.sites {
                let where_ = "\(tag) @ \(s.file) (\(s.what))"
                guard let scraped = s.scraped else {
                    Check.ok(
                        false,
                        "\(where_): the reference's value could not be read — the pattern "
                            + "matched \(s.found)x and \(s.expected) was expected. The "
                            + "expression moved or was renamed; repoint it in "
                            + "tools/goldens/divergences.ts and say whether the divergence "
                            + "still holds.")
                    continue
                }
                Check.bitEq(
                    scraped, d.reference,
                    "\(where_): the reference still holds the value that was declared")
                Check.ok(
                    scraped != live,
                    "\(where_): still a divergence. The two sides agree at \(live) now, so "
                        + "this entry describes code that no longer exists — delete it.")
            }

            // A declaration whose two halves are equal is a claim about nothing.
            Check.ok(
                d.swift != d.reference,
                "\(tag): declared Swift \(d.swift) and reference \(d.reference) differ")
        }

        // --- half two: nothing diverges that was not declared ------------------------

        let declared = Set(g.divergences.map(\.constant))

        // Every constant the reference names is accounted for exactly once: mirrored
        // (and then asserted equal), classified as unmirrored, or declared divergent.
        Check.ok(
            !g.referenceConstants.isEmpty,
            "the reference-constant scrape found something — an empty map would make "
                + "every check below vacuously true")

        for (name, want) in g.referenceConstants.sorted(by: { $0.key < $1.key }) {
            if declared.contains(name) { continue }
            if let got = mirrored[name] {
                // The unconditional half. Nobody wrote this assertion for this constant;
                // it exists because equality with the oracle is the default.
                Check.bitEq(got, want, "\(name) matches the reference")
            } else if let why = unmirrored[name] {
                Check.ok(!why.isEmpty, "\(name) is classified as unported, with a reason")
            } else {
                Check.ok(
                    false,
                    "\(name) = \(want) is a reference constant DivergenceTests knows "
                        + "nothing about. Bind it in `mirrored`, classify it in "
                        + "`unmirrored`, or declare it in tools/goldens/divergences.ts.")
            }
        }

        // The tables cut both ways: a name that has left the reference must leave here
        // too, or the binding is quietly asserting against a constant nobody has.
        for name in mirrored.keys.sorted() where g.referenceConstants[name] == nil {
            Check.ok(
                declared.contains(name),
                "\(name) is bound in `mirrored` but the reference no longer declares it "
                    + "— drop the binding or declare the divergence")
        }
        for name in unmirrored.keys.sorted() where g.referenceConstants[name] == nil {
            Check.ok(
                false,
                "\(name) is classified in `unmirrored` but the reference no longer "
                    + "declares it — drop the classification")
        }

        thePullConstantsAreTheReferences(g)
    }

    /// Live values for constants that exist in the port and have no same-named
    /// counterpart in the reference, because the number they diverge from is a literal
    /// at a site rather than a constant.
    static let liveDivergent: [String: Double] = [
        "LAYOUT_CEILING": LAYOUT_CEILING
    ]

    /// `Game.ts`'s seven pull constants, bound to the live Swift symbols.
    ///
    /// **The port carried none of these and nothing noticed**, because ADR-0007's
    /// default-equality scrape was wired to `src/sim/AI.ts` and `doPull`'s constants are
    /// in `src/sim/Game.ts`. `Engine.autoPull` was an independently invented pull aiming
    /// 16.8 m short of every pull the reference throws, and it survived 2.25 M green
    /// assertions — the only fixture that could see it was `matchdiff`, where the
    /// resulting 8-11x `turnover:pull-drop` gap sat under an absolute floor with 0.08
    /// events a match of headroom. Issue #2.
    ///
    /// There is no `unmirrored` escape for this table. Seven names, all seven ported,
    /// and a new `PULL_*` in the reference should stop the suite until somebody says what
    /// the port does with it — which is exactly rule 3 of ADR-0007, applied where it was
    /// missing.
    static let mirroredPull: [String: Double] = [
        "PULL_BANK": Engine.PULL_BANK,
        "PULL_CARRY": Engine.PULL_CARRY,
        "PULL_DRIFT": Engine.PULL_DRIFT,
        "PULL_NOSE": Engine.PULL_NOSE,
        "PULL_SPEED": Engine.PULL_SPEED,
        "PULL_SPIN": Engine.PULL_SPIN,
        "PULL_TARGET_Z": Engine.PULL_TARGET_Z,
    ]

    private static func thePullConstantsAreTheReferences(_ g: File) {
        Check.ok(
            !g.referencePullConstants.isEmpty,
            "the pull-constant scrape found something in src/sim/Game.ts — an empty map "
                + "would make every check below vacuously true, which is the state the "
                + "port shipped an invented pull in")

        for (name, want) in g.referencePullConstants.sorted(by: { $0.key < $1.key }) {
            guard let want else {
                Check.ok(
                    false,
                    "\(name)'s value could not be read out of src/sim/Game.ts — the "
                        + "pattern in tools/goldens/divergences.ts stopped matching, so "
                        + "the expression moved or was renamed. Repoint it.")
                continue
            }
            guard let got = mirroredPull[name] else {
                Check.ok(
                    false,
                    "\(name) = \(want) is a pull constant the port does not carry under "
                        + "that name. `Engine.autoPull` has to say what it does with it "
                        + "— an unported pull constant is how issue #2 happened.")
                continue
            }
            Check.bitEq(got, want, "\(name) matches the reference")
        }

        for name in mirroredPull.keys.sorted() where g.referencePullConstants[name] == nil {
            Check.ok(
                false,
                "\(name) is bound in `mirroredPull` but src/sim/Game.ts no longer "
                    + "declares it — drop the binding")
        }
    }
}
