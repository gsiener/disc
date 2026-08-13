import Foundation
import ProbeContract

/// Contract tests for the dependency-free `ProbeContract` target — issue #21.
///
/// These tests verify the canonical launch-argument vocabulary, the probe-key enum,
/// the wire-format parser's defaults and safety behavior, and the package-layering
/// guarantees. They run via `SimTests` without a UI host.
///
/// Covers: VAL-LAUNCH-002, VAL-LAUNCH-013, VAL-PROBE-002, VAL-PROBE-005,
/// VAL-PROBE-006, VAL-PROBE-007, and the layering parts of VAL-CROSS-013.
enum ProbeContractTests {

    static func run() throws {
        launchArgVocabularyIsCanonical()
        unknownFlagsAreIgnored()
        edgeCaseParsing()
        wireFormatAndKeyPresence()
        probeKeyCoverage()
        probeIdentifierIsCanonical()
        parserAccessorDefaults()
        parserSafetyMalformedAndDuplicate()
        parserSafetyEmptyKeyAndValue()
        parserSafetyFiniteNumber()
        parserSafetyProcessLossSentinel()
        parserSafetyPitchParsing()
        layeringGuarantees()
    }

    // MARK: - VAL-LAUNCH-002: Recognized flag vocabulary is canonical

    /// The recognized launch-argument names are exactly the canonical set. Each
    /// canonical name with an accepted value yields a non-default option.
    static func launchArgVocabularyIsCanonical() {
        // The canonical set is exactly LaunchArg.allCases.
        Check.eq(LaunchArg.allCases.count, 10, "exactly ten canonical launch arguments")
        let names = Set(LaunchArg.allCases.map(\.rawValue))
        Check.eq(names, Set([
            "-format", "-points", "-receive", "-setup", "-charge",
            "-defend", "-cut", "-savecycle", "-probe", "-tab",
        ]), "canonical names match the expected set")

        // Each canonical name with an accepted value yields a non-default option.
        let format = LaunchOptions.parse(arguments: ["-format", "7v7"])
        Check.ok(format.format != nil, "-format with 7v7 yields non-default format")

        let points = LaunchOptions.parse(arguments: ["-points", "5"])
        Check.ok(points.points != nil, "-points with 5 yields non-default points")

        let receive = LaunchOptions.parse(arguments: ["-receive", "us"])
        Check.ok(receive.receiveTeam != nil, "-receive with us yields non-default receiveTeam")

        let setup = LaunchOptions.parse(arguments: ["-setup", "off"])
        Check.ok(setup.skipsSetup, "-setup with off yields non-default skipsSetup")

        let charge = LaunchOptions.parse(arguments: ["-charge", "0.85"])
        Check.ok(charge.demoCharge != nil, "-charge with 0.85 yields non-default demoCharge")

        let defend = LaunchOptions.parse(arguments: ["-defend", "on"])
        Check.ok(defend.autoDefend, "-defend with on yields non-default autoDefend")

        let cut = LaunchOptions.parse(arguments: ["-cut", "0.5,0.35"])
        Check.ok(cut.demoCut != nil, "-cut with 0.5,0.35 yields non-default demoCut")

        let savecycle = LaunchOptions.parse(arguments: ["-savecycle", "10"])
        Check.ok(savecycle.saveCycle != nil, "-savecycle with 10 yields non-default saveCycle")

        let probe = LaunchOptions.parse(arguments: ["-probe", "on"])
        Check.ok(probe.showsProbe, "-probe with on yields non-default showsProbe")

        let tab = LaunchOptions.parse(arguments: ["-tab", "checks"])
        Check.eq(tab.requestedTab, 3, "-tab with checks yields non-default requestedTab")
    }

    /// An unknown flag leaves every option at default.
    static func unknownFlagsAreIgnored() {
        let opts = LaunchOptions.parse(arguments: ["-unknown", "value", "-bogus", "x"])
        Check.eq(opts, .defaults, "unknown flags leave all options at default")

        // An unknown flag between known flags does not disrupt them.
        let mixed = LaunchOptions.parse(arguments: ["-probe", "on", "-unknown", "x", "-tab", "flight"])
        Check.ok(mixed.showsProbe, "known flags still work with unknown flags interspersed")
        Check.eq(mixed.requestedTab, 2, "interspersed unknown does not consume the next known flag's value")
    }

    // MARK: - VAL-LAUNCH-013: Edge-case argument parsing retains safe defaults

    static func edgeCaseParsing() {
        trailingFlagWithNoValue()
        duplicateFlagsFirstWins()
        flagLikeTokenAsValue()
        caseSensitivity()
        emptyStringValues()
        nonFiniteNumericHandling()
    }

    /// (a) A flag at end with no trailing value keeps its default.
    static func trailingFlagWithNoValue() {
        let opts = LaunchOptions.parse(arguments: ["-format"])
        Check.eq(opts.format, nil, "-format at end with no value → nil (default)")

        let opts2 = LaunchOptions.parse(arguments: ["-points"])
        Check.eq(opts2.points, nil, "-points at end with no value → nil (default)")

        let opts3 = LaunchOptions.parse(arguments: ["-receive"])
        Check.eq(opts3.receiveTeam, nil, "-receive at end with no value → nil (default)")

        let opts4 = LaunchOptions.parse(arguments: ["-setup"])
        Check.eq(opts4.skipsSetup, false, "-setup at end with no value → false (default)")

        let opts5 = LaunchOptions.parse(arguments: ["-charge"])
        Check.eq(opts5.demoCharge, nil, "-charge at end with no value → nil (default)")

        let opts6 = LaunchOptions.parse(arguments: ["-defend"])
        Check.eq(opts6.autoDefend, false, "-defend at end with no value → false (default)")

        let opts7 = LaunchOptions.parse(arguments: ["-cut"])
        Check.eq(opts7.demoCut, nil, "-cut at end with no value → nil (default)")

        let opts8 = LaunchOptions.parse(arguments: ["-savecycle"])
        Check.eq(opts8.saveCycle, nil, "-savecycle at end with no value → nil (default)")

        let opts9 = LaunchOptions.parse(arguments: ["-probe"])
        Check.eq(opts9.showsProbe, false, "-probe at end with no value → false (default)")

        let opts10 = LaunchOptions.parse(arguments: ["-tab"])
        Check.eq(opts10.requestedTab, 0, "-tab at end with no value → 0 (default)")
    }

    /// (b) Duplicate flags: the first occurrence wins.
    static func duplicateFlagsFirstWins() {
        let format = LaunchOptions.parse(arguments: ["-format", "7v7", "-format", "minis"])
        Check.eq(format.format, .full, "-format 7v7 -format minis → full (first wins)")

        let points = LaunchOptions.parse(arguments: ["-points", "1", "-points", "9"])
        Check.eq(points.points, 1, "-points 1 -points 9 → 1 (first wins)")

        let receive = LaunchOptions.parse(arguments: ["-receive", "us", "-receive", "them"])
        Check.eq(receive.receiveTeam, 1, "-receive us -receive them → 1 (first wins)")

        let tab = LaunchOptions.parse(arguments: ["-tab", "checks", "-tab", "play"])
        Check.eq(tab.requestedTab, 3, "-tab checks -tab play → 3 (first wins)")
    }

    /// (c) A flag-like token as a value is treated as a literal value, not a new flag;
    /// the token after it is consumed by the next flag that names it.
    static func flagLikeTokenAsValue() {
        // -format -points → format minis (because "-points" is the literal value of
        // -format, not "7v7"), and points nil (no trailing token for -points).
        let a = LaunchOptions.parse(arguments: ["-format", "-points"])
        Check.eq(a.format, .minis, "-format -points → format minis (flag-like value is literal)")
        Check.eq(a.points, nil, "-format -points → points nil (no trailing token)")

        // -format -points 5 → format minis and points 5 (the flag-like value is
        // literal, the trailing 5 is consumed by -points).
        let b = LaunchOptions.parse(arguments: ["-format", "-points", "5"])
        Check.eq(b.format, .minis, "-format -points 5 → format minis")
        Check.eq(b.points, 5, "-format -points 5 → points 5 (trailing token consumed by -points)")
    }

    /// (d) Accepted value tokens are case-sensitive; uppercased/mixed-case variants
    /// fall through to default.
    static func caseSensitivity() {
        let setup = LaunchOptions.parse(arguments: ["-setup", "OFF"])
        Check.eq(setup.skipsSetup, false, "-setup OFF → false (case-sensitive)")

        let defend = LaunchOptions.parse(arguments: ["-defend", "ON"])
        Check.eq(defend.autoDefend, false, "-defend ON → false (case-sensitive)")

        let receive = LaunchOptions.parse(arguments: ["-receive", "US"])
        Check.eq(receive.receiveTeam, nil, "-receive US → nil (case-sensitive)")

        let format = LaunchOptions.parse(arguments: ["-format", "7V7"])
        Check.eq(format.format, .minis, "-format 7V7 → minis (case-sensitive)")

        let tab = LaunchOptions.parse(arguments: ["-tab", "Checks"])
        Check.eq(tab.requestedTab, 0, "-tab Checks → 0 (case-sensitive)")

        let probe = LaunchOptions.parse(arguments: ["-probe", "ON"])
        Check.eq(probe.showsProbe, false, "-probe ON → false (case-sensitive)")
    }

    /// (e) An empty-string value follows each flag's own default rule.
    static func emptyStringValues() {
        let format = LaunchOptions.parse(arguments: ["-format", ""])
        Check.eq(format.format, .minis, "-format '' → minis (not 7v7, so minis)")

        let points = LaunchOptions.parse(arguments: ["-points", ""])
        Check.eq(points.points, nil, "-points '' → nil (Int('') fails)")

        let receive = LaunchOptions.parse(arguments: ["-receive", ""])
        Check.eq(receive.receiveTeam, nil, "-receive '' → nil")

        let setup = LaunchOptions.parse(arguments: ["-setup", ""])
        Check.eq(setup.skipsSetup, false, "-setup '' → false")

        let charge = LaunchOptions.parse(arguments: ["-charge", ""])
        Check.eq(charge.demoCharge, nil, "-charge '' → nil")

        let defend = LaunchOptions.parse(arguments: ["-defend", ""])
        Check.eq(defend.autoDefend, false, "-defend '' → false")

        let cut = LaunchOptions.parse(arguments: ["-cut", ""])
        Check.eq(cut.demoCut, nil, "-cut '' → nil")

        let savecycle = LaunchOptions.parse(arguments: ["-savecycle", ""])
        Check.eq(savecycle.saveCycle, nil, "-savecycle '' → nil")

        let probe = LaunchOptions.parse(arguments: ["-probe", ""])
        Check.eq(probe.showsProbe, false, "-probe '' → false")

        let tab = LaunchOptions.parse(arguments: ["-tab", ""])
        Check.eq(tab.requestedTab, 0, "-tab '' → 0")
    }

    /// (f) Numeric-flag non-finite and negative handling.
    ///
    /// charge and savecycle accept any Double-parseable token (finite, non-finite,
    /// or negative) as the literal parsed value; absent or non-Double-parseable
    /// yields nil. cut accepts a part only when Double(part) is non-nil AND in [0,1].
    static func nonFiniteNumericHandling() {
        // charge: inf, nan, negative all parse to non-nil.
        Check.ok(LaunchOptions.parse(arguments: ["-charge", "inf"]).demoCharge != nil, "-charge inf → non-nil")
        Check.ok(LaunchOptions.parse(arguments: ["-charge", "nan"]).demoCharge != nil, "-charge nan → non-nil")
        Check.ok(LaunchOptions.parse(arguments: ["-charge", "-0.5"]).demoCharge != nil, "-charge -0.5 → non-nil")
        Check.ok(LaunchOptions.parse(arguments: ["-charge", "abc"]).demoCharge == nil, "-charge abc → nil")
        Check.ok(LaunchOptions.parse(arguments: ["-charge", ""]).demoCharge == nil, "-charge '' → nil")

        // savecycle: inf, nan parse to non-nil.
        Check.ok(LaunchOptions.parse(arguments: ["-savecycle", "inf"]).saveCycle != nil, "-savecycle inf → non-nil")
        Check.ok(LaunchOptions.parse(arguments: ["-savecycle", "nan"]).saveCycle != nil, "-savecycle nan → non-nil")

        // cut: non-finite, negative, and >1 parts all yield nil.
        Check.eq(LaunchOptions.parse(arguments: ["-cut", "inf,0.5"]).demoCut, nil, "-cut inf,0.5 → nil")
        Check.eq(LaunchOptions.parse(arguments: ["-cut", "nan,0.5"]).demoCut, nil, "-cut nan,0.5 → nil")
        Check.eq(LaunchOptions.parse(arguments: ["-cut", "-0.1,0.5"]).demoCut, nil, "-cut -0.1,0.5 → nil")
        Check.eq(LaunchOptions.parse(arguments: ["-cut", "1.01,0.5"]).demoCut, nil, "-cut 1.01,0.5 → nil")

        // cut: valid values accepted.
        Check.ok(LaunchOptions.parse(arguments: ["-cut", "0.5,0.35"]).demoCut != nil, "-cut 0.5,0.35 → non-nil")
        Check.ok(LaunchOptions.parse(arguments: ["-cut", "0,0"]).demoCut != nil, "-cut 0,0 → non-nil")
        Check.ok(LaunchOptions.parse(arguments: ["-cut", "1,1"]).demoCut != nil, "-cut 1,1 → non-nil")

        // cut: malformed (wrong part count, non-double) yields nil.
        Check.eq(LaunchOptions.parse(arguments: ["-cut", "0.5"]).demoCut, nil, "-cut 0.5 → nil (one part)")
        Check.eq(LaunchOptions.parse(arguments: ["-cut", "0.5,0.35,0.1"]).demoCut, nil, "-cut 0.5,0.35,0.1 → nil (three parts)")
        Check.eq(LaunchOptions.parse(arguments: ["-cut", "0.5,abc"]).demoCut, nil, "-cut 0.5,abc → nil (non-double)")
    }

    // MARK: - VAL-PROBE-002: Wire format and key presence

    /// The probe label matches the k=v;k=v pattern. Every always-emitted key is
    /// present. Conditional keys (grade/hold/type) are "-" pre-throw and populated
    /// post-throw.
    static func wireFormatAndKeyPresence() {
        // A canonical pre-throw sample: every always-emitted key present,
        // grade/hold/type are "-".
        let preThrow = "poss=0;phase=live;mine=1;cut.ok=0;def.ok=0;rec=-;thrown=0;cuts=0;defends=0;taps=0;refused=0;wide=0;refuse=-;tally=-;rect=62,0,750,338;grade=-;hold=-;type=-;drag=none;dragend=-;cut=-;def=-;score=0-0;over=0;paused=0;sheet=0"
        let probe = Probe(preThrow)

        // Every retained key is present.
        for key in ProbeKey.allCases {
            Check.ok(probe.fields[key.rawValue] != nil, "\(key.rawValue) is present in pre-throw sample")
        }

        // Conditional keys are "-" before the first throw.
        Check.eq(probe.grade, "-", "grade is '-' pre-throw")
        Check.eq(probe.hold, nil, "hold is '-' (nil double) pre-throw")
        Check.eq(probe.throwType, "-", "type is '-' pre-throw")

        // No surrounding braces, no JSON, no trailing separator.
        Check.ok(!preThrow.hasPrefix("{"), "no leading brace")
        Check.ok(!preThrow.hasSuffix("}"), "no trailing brace")
        Check.ok(!preThrow.hasSuffix(";"), "no trailing separator")
        Check.ok(!preThrow.contains("\""), "no JSON quotes")

        // A post-throw sample: grade/hold/type are populated.
        let postThrow = "poss=0;phase=live;mine=1;cut.ok=0;def.ok=0;rec=-;thrown=1;cuts=0;defends=0;taps=0;refused=0;wide=0;refuse=-;tally=-;rect=62,0,750,338;grade=clean;hold=0.842;type=forehand;drag=none;dragend=throw;cut=-;def=-;score=0-0;over=0;paused=0;sheet=0"
        let postProbe = Probe(postThrow)
        Check.eq(postProbe.grade, "clean", "grade is populated post-throw")
        Check.ok(postProbe.hold != nil, "hold is populated post-throw")
        Check.eq(postProbe.throwType, "forehand", "type is populated post-throw")
    }

    // MARK: - VAL-PROBE-005: Every emitted key is a shared ProbeKey; identifier is canonical

    /// The ProbeKey enum covers all retained keys and excludes `flight` and `coach`.
    static func probeKeyCoverage() {
        let keys = Set(ProbeKey.allCases.map(\.rawValue))
        let expected = Set([
            "poss", "phase", "mine", "cut.ok", "def.ok", "rec",
            "thrown", "cuts", "defends", "taps", "refused", "wide",
            "refuse", "tally", "rect", "grade", "hold", "type",
            "drag", "dragend", "cut", "def", "score", "over", "paused", "sheet",
        ])
        Check.eq(keys, expected, "ProbeKey cases cover all retained keys")
        Check.eq(ProbeKey.allCases.count, 26, "exactly 26 retained probe keys")

        // flight and coach are absent. VAL-PROBE-004.
        Check.ok(!keys.contains("flight"), "flight is not in ProbeKey")
        Check.ok(!keys.contains("coach"), "coach is not in ProbeKey")
        Check.ok(ProbeKey(rawValue: "flight") == nil, "ProbeKey(rawValue: flight) is nil")
        Check.ok(ProbeKey(rawValue: "coach") == nil, "ProbeKey(rawValue: coach) is nil")
    }

    /// The probe identifier has one canonical definition.
    static func probeIdentifierIsCanonical() {
        Check.eq(ProbeContract.probeIdentifier, "match.probe", "probe identifier is match.probe")
    }

    // MARK: - VAL-PROBE-006: Parser accessor defaults

    /// The parser's accessors default missing or unparseable values deterministically:
    /// string→"", int→0, double→nil, flag→false (true only for "1").
    static func parserAccessorDefaults() {
        // Empty payload: all defaults.
        let empty = Probe("")
        Check.eq(empty.string("missing"), "", "string missing → ''")
        Check.eq(empty.int("missing"), 0, "int missing → 0")
        Check.ok(empty.double("missing") == nil, "double missing → nil")
        Check.eq(empty.flag("missing"), false, "flag missing → false")

        // Non-matching values.
        let nonInt = Probe("k=abc")
        Check.eq(nonInt.int("k"), 0, "int of abc → 0")
        Check.eq(nonInt.int("k"), 0, "int of 'abc' → 0")

        let nonDouble = Probe("k=abc")
        Check.ok(nonDouble.double("k") == nil, "double of abc → nil")

        // flag: true only for exactly "1".
        Check.eq(Probe("k=1").flag("k"), true, "flag of '1' → true")
        Check.eq(Probe("k=0").flag("k"), false, "flag of '0' → false")
        Check.eq(Probe("k=true").flag("k"), false, "flag of 'true' → false")
        Check.eq(Probe("k=yes").flag("k"), false, "flag of 'yes' → false")
        Check.eq(Probe("k=on").flag("k"), false, "flag of 'on' → false")
        Check.eq(Probe("k=").flag("k"), false, "flag of '' → false")

        // int of "-" (the probe's "no value" sentinel) → 0.
        Check.eq(Probe("k=-").int("k"), 0, "int of '-' → 0")
        // int of "1.5" → 0 (not a whole integer).
        Check.eq(Probe("k=1.5").int("k"), 0, "int of '1.5' → 0")
    }

    // MARK: - VAL-PROBE-007: Parser safety

    /// Malformed pairs (no `=`) are skipped; duplicate keys resolve to last-wins.
    static func parserSafetyMalformedAndDuplicate() {
        // Empty payload → empty fields.
        Check.eq(Probe("").fields, [:], "Probe('') → fields == [:]")

        // A pair without = is skipped; a valid pair beside it is parsed.
        let p = Probe("mine=1;garbage")
        Check.eq(p.flag("mine"), true, "mine=1 parsed, garbage (no =) skipped")
        Check.ok(p.fields["garbage"] == nil, "garbage is absent from fields")

        // Duplicate keys: last wins, deterministically.
        Check.eq(Probe("mine=1;mine=0").flag("mine"), false, "mine=1;mine=0 → false (last wins)")
        Check.eq(Probe("mine=0;mine=1").flag("mine"), true, "mine=0;mine=1 → true (last wins)")

        // A duplicate never produces an ambiguous result: the field has one value.
        Check.eq(Probe("mine=1;mine=0").fields["mine"], "0", "duplicate resolves to one value")
        Check.eq(Probe("mine=0;mine=1").fields["mine"], "1", "duplicate resolves to one value")
    }

    /// Empty keys are inert; empty values yield typed defaults.
    static func parserSafetyEmptyKeyAndValue() {
        // Empty-key pairs do not crash and do not affect named accessors.
        let emptyKeys = Probe("=;=;")
        Check.ok(emptyKeys.fields[""] != nil, "=;=; parses without crash")
        // No named accessor is affected.
        Check.eq(emptyKeys.flag("mine"), false, "=;=; does not set mine")
        Check.eq(emptyKeys.int("thrown"), 0, "=;=; does not set thrown")
        Check.eq(emptyKeys.string("phase"), "", "=;=; does not set phase")

        // An empty-key pair cannot shadow a real key.
        // =mine=1 is one pair: key="", value="mine=1". It does not set "mine".
        let shadow = Probe("=mine=1")
        Check.ok(shadow.fields[""] != nil, "=mine=1 creates an empty-key entry")
        Check.eq(shadow.flag("mine"), false, "=mine=1 does not set mine (no shadow)")
        Check.ok(shadow.fields["mine"] == nil, "=mine=1 does not create a mine key")

        // A pair k= yields key "k" with value "", and typed accessors return defaults.
        let emptyVal = Probe("x=")
        Check.eq(emptyVal.string("x"), "", "x= → string '' ")
        Check.eq(emptyVal.int("x"), 0, "x= → int 0")
        Check.ok(emptyVal.double("x") == nil, "x= → double nil")
        Check.eq(emptyVal.flag("x"), false, "x= → flag false")
    }

    /// The double accessor returns non-finite values as-is (inf, -inf, nan), not nil.
    static func parserSafetyFiniteNumber() {
        let inf = Probe("hold=inf")
        let infVal = inf.double("hold")
        Check.ok(infVal != nil, "double of 'inf' is non-nil")
        Check.ok(infVal?.isInfinite == true, "double of 'inf' is infinite (not coerced to nil)")

        let nan = Probe("hold=nan")
        let nanVal = nan.double("hold")
        Check.ok(nanVal != nil, "double of 'nan' is non-nil")
        Check.ok(nanVal?.isNaN == true, "double of 'nan' is NaN (not coerced to nil)")

        let negInf = Probe("hold=-inf")
        let negInfVal = negInf.double("hold")
        Check.ok(negInfVal != nil, "double of '-inf' is non-nil")
        Check.ok(negInfVal?.isInfinite == true, "double of '-inf' is infinite")

        // A non-parseable token returns nil.
        Check.ok(Probe("hold=abc").double("hold") == nil, "double of 'abc' → nil")
    }

    /// A process-loss sentinel payload yields all-default match-state accessors.
    static func parserSafetyProcessLossSentinel() {
        let sentinel = Probe("process=lost")
        // canThrow, isLive, isOver all false.
        Check.eq(sentinel.canThrow, false, "process=lost → canThrow false")
        Check.eq(sentinel.isLive, false, "process=lost → isLive false")
        Check.eq(sentinel.isOver, false, "process=lost → isOver false")
        // Counters all 0.
        Check.eq(sentinel.thrown, 0, "process=lost → thrown 0")
        Check.eq(sentinel.cuts, 0, "process=lost → cuts 0")
        Check.eq(sentinel.defends, 0, "process=lost → defends 0")
        Check.eq(sentinel.taps, 0, "process=lost → taps 0")
        Check.eq(sentinel.refused, 0, "process=lost → refused 0")
        // No retained key is set.
        for key in ProbeKey.allCases {
            Check.ok(sentinel.fields[key.rawValue] == nil, "process=lost does not set \(key.rawValue)")
        }
    }

    /// The pitch accessor returns nil for invalid rects and a valid rect for good input.
    static func parserSafetyPitchParsing() {
        // Too few parts.
        Check.ok(Probe("rect=62,0").pitch == nil, "pitch nil for 2 parts")
        // Zero height.
        Check.ok(Probe("rect=62,0,750,0").pitch == nil, "pitch nil for zero height")
        // Negative height.
        Check.ok(Probe("rect=62,0,750,-5").pitch == nil, "pitch nil for negative height")
        // Zero width.
        Check.ok(Probe("rect=62,0,0,338").pitch == nil, "pitch nil for zero width")
        // Negative width.
        Check.ok(Probe("rect=62,0,-5,338").pitch == nil, "pitch nil for negative width")
        // Valid rect.
        let valid = Probe("rect=62,0,750,338")
        Check.ok(valid.pitch != nil, "pitch valid for 62,0,750,338")
        if let r = valid.pitch {
            Check.eq(r.origin.x, 62, "pitch x is 62")
            Check.eq(r.origin.y, 0, "pitch y is 0")
            Check.eq(r.width, 750, "pitch width is 750")
            Check.eq(r.height, 338, "pitch height is 338")
        }
        // Non-double parts.
        Check.ok(Probe("rect=62,0,abc,338").pitch == nil, "pitch nil for non-double part")
        // Missing rect key.
        Check.ok(Probe("").pitch == nil, "pitch nil when rect key absent")
    }

    // MARK: - VAL-CROSS-013: Layering guarantees (static/structural parts)

    /// The contract target is dependency-free; UltimateSim does not depend on it;
    /// the probe key enum excludes flight/coach; the identifier is one constant.
    static func layeringGuarantees() {
        // ProbeKey has no flight or coach case (also checked in probeKeyCoverage,
        // but restated here because VAL-CROSS-013 requires it).
        Check.ok(ProbeKey(rawValue: "flight") == nil, "layering: no flight key")
        Check.ok(ProbeKey(rawValue: "coach") == nil, "layering: no coach key")

        // The identifier is a single canonical constant.
        Check.eq(ProbeContract.probeIdentifier, "match.probe", "layering: one canonical identifier")

        // LaunchArg has exactly the canonical names, no more, no less.
        Check.eq(LaunchArg.allCases.count, 10, "layering: exactly 10 canonical launch args")

        // TabName maps all five canonical tabs.
        Check.eq(TabName.allCases.count, 5, "layering: 5 canonical tab names")
        Check.eq(TabName.play.index, 0, "play → 0")
        Check.eq(TabName.pitch.index, 1, "pitch → 1")
        Check.eq(TabName.flight.index, 2, "flight → 2")
        Check.eq(TabName.checks.index, 3, "checks → 3")
        Check.eq(TabName.bench.index, 4, "bench → 4")

        // Tab bar labels.
        Check.eq(TabName.play.label, "Play", "play label is Play")
        Check.eq(TabName.pitch.label, "Pitch", "pitch label is Pitch")
        Check.eq(TabName.flight.label, "Flight", "flight label is Flight")
        Check.eq(TabName.checks.label, "Checks", "checks label is Checks")
        Check.eq(TabName.bench.label, "Speed", "bench label is Speed")

        // ReceiveValue covers the two receive-side values.
        Check.eq(ReceiveValue.allCases.count, 2, "exactly 2 receive-side values")
        Check.eq(ReceiveValue.us.rawValue, "us", "us raw value")
        Check.eq(ReceiveValue.them.rawValue, "them", "them raw value")

        // Default launch options match VAL-LAUNCH-001.
        let d = LaunchOptions.defaults
        Check.eq(d.format, nil, "default format is nil")
        Check.eq(d.points, nil, "default points is nil")
        Check.eq(d.receiveTeam, nil, "default receiveTeam is nil")
        Check.eq(d.skipsSetup, false, "default skipsSetup is false")
        Check.eq(d.demoCharge, nil, "default demoCharge is nil")
        Check.eq(d.autoDefend, false, "default autoDefend is false")
        Check.eq(d.demoCut, nil, "default demoCut is nil")
        Check.eq(d.saveCycle, nil, "default saveCycle is nil")
        Check.eq(d.showsProbe, false, "default showsProbe is false")
        Check.eq(d.requestedTab, 0, "default requestedTab is 0")

        // Parse of empty argument list gives defaults.
        Check.eq(LaunchOptions.parse(arguments: []), .defaults, "empty args → defaults")
    }
}
