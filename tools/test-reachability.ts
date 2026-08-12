/**
 * tools/test-reachability.ts — the durable guard issue #5 asked for
 *
 *   node tools/test-reachability.ts            full run
 *   node tools/test-reachability.ts --quiet    suppress the per-symbol lines
 *   node tools/test-reachability.ts --list     print every flagged symbol and stop
 *
 * Five times running, this repository has shipped a validated, differentially-tested
 * capability in `UltimateSim` that nothing outside `SimChecks` ever calls: `drop` /
 * `block` / `pullDropped`, the self-officiation machine (`makeCall`/`resolveCall`),
 * `TeamAI.commandCut` (until it became the tap-a-cut feature), `GameState.callTimeout`,
 * and — the sweep that opened issue #5 — `markerLegal`, `stallRemaining`, `currentBrick`,
 * `clearLog`, `setTrail`, and `runningCut`. Each time it took a human noticing.
 *
 * This is that noticing, made executable. For every `public func` declared in
 * `UltimateSim`, it counts textual call sites across the rest of the repository —
 * `UltimateSim` itself, `FlightUI`, `FlightScope`, and `ios/` — and fails if the count is
 * zero. `SimChecks` is deliberately excluded from that count: a function whose only
 * caller is a differential test is exactly the pattern this guard exists to catch, not
 * evidence that it is used.
 *
 * ---------------------------------------------------------------------- what this cannot see
 *
 * This is a textual scan, not a call graph. Two limitations, both biased toward missing a
 * dead function rather than flagging a live one — a false negative here is a human still
 * has to notice; a false positive is a durable guard nobody trusts (ADR-0005's "a masked
 * job is worse than a red one" applies in reverse: a noisy one gets disabled).
 *
 *   - **Same-named overloads are conflated.** `clampToField` is declared four times
 *     across `Rules`, `GameFormat`, `Playbook` and `PlayTypes`; a call to any one of them
 *     satisfies all four here. Precise per-overload reachability needs a type checker,
 *     not a grep.
 *   - **A call chain that starts in `UltimateSim` and never reaches `FlightUI`/`ios/`
 *     still counts as reachable.** `stallCountFor` is called by `GameState.tickStall`
 *     and stops there — this guard cannot tell "reachable" from "reachable but the thing
 *     that reaches it is itself unreachable." That is the gap that let `CATCH_PLANE_DROP`
 *     (issue #4's family) hide; ADR-0007's registry, not this guard, closes it for named
 *     constants. Widening this into a real transitive-closure check is future work, not a
 *     reason to withhold the shallow version — the shallow version would have caught all
 *     six items in issue #5, which never had a caller at any distance.
 *
 * Operators (`==`, `+`, `~=`, …) and initializers are out of scope: neither is called by
 * the textual pattern this scan looks for, so every operator would read as unreachable
 * and the guard would be noise from line one.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const QUIET = process.argv.includes('--quiet');
const LIST = process.argv.includes('--list');
const ROOT = new URL('..', import.meta.url).pathname;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function swiftFilesUnder(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...swiftFilesUnder(p));
    else if (entry.endsWith('.swift')) out.push(p);
  }
  return out;
}

interface Decl {
  name: string;
  file: string;
  line: number;
}

/**
 * Every `public func` (including `public static func`) declared at any nesting depth in
 * `UltimateSim` — top-level, inside a type, inside an extension.
 *
 * Deliberately excludes `init`: it is called as `Type(...)`, a different textual shape
 * this scan does not look for, and treating "no call to `init(`" as unreachable would
 * flag every initializer in the library.
 *
 * Operators are excluded by the identifier-only name class in the pattern itself —
 * `func ==` or `func +` simply does not match `[A-Za-z_]\w*`.
 */
function publicFuncDecls(files: string[]): Decl[] {
  const out: Decl[] = [];
  const re = /^\s*public\s+(?:static\s+)?func\s+([A-Za-z_]\w*)\s*[(<]/;
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]!);
      if (m) out.push({ name: m[1]!, file, line: i + 1 });
    }
  }
  return out;
}

/**
 * Whether `name` is CALLED (not declared) anywhere in `file`.
 *
 * A line is a declaration of `name` — anywhere, any access level, any type, an overload
 * or a shadow — if it matches `func name(`/`func name<`. Declarations never count as
 * calls, including a re-declaration of the same name in a different type: that is exactly
 * the overload-conflation limitation documented above, and undercounting a decl as a call
 * would hide a function that is declared several times and invoked zero.
 */
function isCalledIn(name: string, file: string): boolean {
  const declPrefix = new RegExp(`^\\s*(?:public|internal|private|fileprivate)?\\s*(?:static\\s+)?func\\s+${name}\\s*[(<][^{]*\\{?`);
  // A preceding word character means this is a suffix of some other identifier
  // (`isMarkerLegal(` must not satisfy a search for `markerLegal`) — excluded. A
  // preceding `.` is exactly `receiver.name(`, the ordinary instance-method call
  // syntax this whole scan exists to find, and must NOT be excluded — the first cut
  // of this scanner did exclude it, and every name it fixed (`GameState.playerStats`
  // among them) turned out, on inspection, to have no FlightUI caller after all.
  // Issue #5's own closing note claimed otherwise for that name and for `Replay.record`/
  // `restore` — checked directly against this codebase rather than taken on trust, and
  // the note had drifted: `playerStats` is deleted below, `record`/`restore` are
  // allowlisted for a different, better reason than "called."
  const callToken = new RegExp(`(?<![A-Za-z0-9_])${name}\\(`);
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    // A one-line body — `func isAirborne(_ p: AIPlayer) -> Bool { loco.isAirborne(id:
    // p.id) }` — puts a real call on the same line as the declaration it is not. Strip
    // only the declaration's own `func NAME(` prefix and search what remains, rather
    // than discarding the whole line: that is what let `Engine.isAirborne` calling
    // `Locomotion.isAirborne(id:)` on one line read as zero callers for either.
    const m = declPrefix.exec(line);
    const remainder = m ? line.slice(m.index + m[0].length) : line;
    if (callToken.test(remainder)) return true;
  }
  return false;
}

/**
 * Symbols whose only caller is `SimChecks`, kept deliberately rather than wired or
 * deleted, with the reason on record. Add here only with a reason a future explorer of
 * issue #5's family would need in order not to re-flag it — not because the guard is
 * inconvenient this week.
 */
const ALLOWLIST: Record<string, string> = {
  runningCut:
    'Issue #5. Read-only test oracle for `commandCut` (the tap-a-cut feature, which DOES ' +
    'have a production caller in FlightUI): it is what lets `HumanCutTests` assert the AI ' +
    'actually ran the ordered route, not merely that a ghost appeared on screen. FlightUI\'s ' +
    'cut-call UI runs on three fixed timers deliberately decoupled from live AI state — ' +
    'wiring this into it would fight a documented design choice, not finish one. See ' +
    '`TeamAICutRead.swift`\'s file header.',
  laneHolder:
    'Issue #5, same reasoning and the same file as `runningCut` — its sibling read, used ' +
    'identically as test-oracle infrastructure in `HumanCutTests`.',

  // --- self-documented test-oracle reads: the doc comment on the declaration itself
  // states the assertion it exists to enable, in the same voice as `runningCut`'s file
  // header. Found by this guard's first run (#5); not one of the issue's own six.
  locoIntent:
    'Issue #5. Own doc comment: "the single point where the ported AI\'s vocabulary ' +
    'becomes the ported locomotion\'s ... Exposing it is what lets the join be asserted ' +
    'at all." `Engine.swift`.',
  reportedAction:
    'Issue #5. Own doc comment: "the single fact `catchBodies` turns into the `attacking` ' +
    'flag ... \'the input reached the intent path\' is exactly the assertion this read ' +
    'enables." `Engine.swift`.',
  contestBodies:
    'Issue #5. Own doc comment: "so a check can ask what the contest would be handed ' +
    'without re-deriving it ... a second copy of that derivation is a check that passes ' +
    'while the real one is wrong." `Engine.swift`.',

  // --- design-documented test/short-path convenience: FlightUI\'s own production path
  // takes a deliberately different shape for a stated reason, found in the type\'s own
  // doc comment rather than inferred.
  record:
    'Issue #5. `MatchRecorder` "owns the loop rather than observing one" (its own file ' +
    'comment) — a shape built for `ReplayTests` to script a match without hand-managing ' +
    'tick/clock bookkeeping. `MatchView` does not want that shape: it already owns its ' +
    'loop (SwiftUI-driven) and appends to its own `inputs` array directly. Different ' +
    'consumer, different shape, not a duplicate — verified against the full git history ' +
    'of `swift/Sources/FlightUI/`, which never once constructs a `MatchRecorder`.',
  restore:
    'Issue #5. `MatchRestore`\'s own doc comment on the static form: "Replay the lot in ' +
    'one go. For a check, or for a save short enough that chunking it would only be ' +
    'ceremony." FlightUI\'s restore is chunked on purpose — `MatchPersistence.swift` ' +
    'drives the instance path (`advance(ticks:)`/`isFinished`/`progress`) across frames ' +
    'so a progress bar has something to show — which is the ceremony this static form ' +
    'is named as skipping.',

  // --- differentially-verified port primitives with no identified production need.
  // Each is bit-exact tested against the TypeScript oracle already (locality: the
  // coverage this guard cares about exists), and none is one of #5's own six items —
  // wiring any of them means designing a feature that would consume it, which is a
  // product decision this guard cannot make and a reachability scan cannot evidence.
  // Weaker justification than the two categories above; revisit if a use turns up.
  distSq2: 'Issue #5. `Playbook.dist2` (hypot-based) is the form production paths use; ' +
    'this is its squared-distance sibling, differentially verified, uncalled outside ' +
    'the fixture that verifies it.',
  inOwnEndzone: 'Issue #5. Dead on both sides, not only the port: `src/sim/AI.ts` imports ' +
    '`inAttackEndzone` (used) but never `inOwnEndzone` — exported for symmetry with it ' +
    'and never called by the reference\'s own game logic either.',
  isCommitted: 'Issue #5. `Locomotion.isAvailable` (its sibling, same file) is the ' +
    'predicate production reads; `isCommitted` is differentially verified, uncalled ' +
    'outside the one fixture case that checks it.',
  v3: 'Issue #5. A test-fixture literal-vector constructor terse enough for `RulesTests`\' ' +
    'own case tables; no production site builds a `Vec3d` this way.',
  stackHolding: 'Issue #5. "Cutter ids currently HOLDING the stack" — a debug-shaped read ' +
    '(`t.stackHolding().map(String.init).joined(...)`) used once, to print a state string ' +
    'a `TeamAITests` fixture compares against; no HUD or AI decision consumes it today.',
  zoneRoleOf: 'Issue #5. Sibling of `matchupOf` (used in production person-defence ' +
    'assignment); zone defence\'s own responsibility read, differentially verified, no ' +
    'identified caller once zone defence is actually playing zone.',
  endzoneOf: 'Issue #5. `FieldConstants.isInEndzone`/`isGoal` are what production calls; ' +
    'the three-way (`+1`/`-1`/`0`) form is bit-exact verified against the reference\'s own ' +
    '`endzoneOf` but nothing needs the three-way answer specifically. Not the free-' +
    'function version — that one was deleted outright in #45.',
};

/**
 * Found by this guard's first run, evidenced as real rather than a scanner artifact, and
 * deliberately NOT resolved here — each would need the kind of behavioural verification
 * ADR-0007 gave `LAYOUT_CEILING` (tracing what the reference actually does at runtime)
 * before a wire-or-delete call is responsible, and two of them touch live AI/physics
 * code whose blast radius is larger than a GameState accessor's. Listed in the reason
 * string so `--list`'s raw output stays honest about what is still open, without turning
 * into a second GitHub issue for something #5's own text already covers by precedent
 * (`commandCut`, before it became the tap-a-cut feature, is the same shape).
 *
 *   - `TeamAI.setCalledForce` / `.called` — a whole force-calling read+write pair, unused
 *     on BOTH ends (the getter, a `var`, is invisible to this func-only scan but was
 *     found investigating the setter). Looks like `commandCut` before it was wired.
 *   - `Locomotion.peakReach` — per-player attribute-derived leap height. AI bid-height
 *     gating (`TeamAIDefence.swift`) uses the fixed `CATCH_CEILING`/`LAYOUT_CEILING`
 *     constants instead. Whether AI leap height should vary by player is a design
 *     question, not a reachability question.
 *   - `Playbook.breakSideFor` (static) — `src/sim/AI.ts` imports and calls it; the Swift
 *     port's `TeamAIDefence.swift` computes the break side via `breakSideSign` (position-
 *     independent) at its one call site instead, never `breakSideFor` (position-aware).
 *     Possibly a real behavioural gap between port and reference; needs the reference's
 *     actual call site read in context before concluding either way.
 *   - `Locomotion.contest`/`Move/Contest.swift`'s `contestAir` — an entire alternate
 *     catch-contest model; production resolves a contested catch through `CatchDecision`
 *     instead. Deleting risks cascading into a file this pass has not fully read.
 */
const KNOWN_UNRESOLVED: Record<string, string> = {
  setCalledForce:
    'A whole force-calling read+write pair, unused on both ends — looks like ' +
    '`commandCut` before it was wired. Needs a product decision, not a scanner verdict.',
  peakReach:
    'AI bid-height gating uses the fixed CATCH_CEILING/LAYOUT_CEILING constants instead ' +
    'of this per-player derived reach. Whether leap height should vary by player is a ' +
    'design question.',
  breakSideFor:
    'src/sim/AI.ts calls this; TeamAIDefence.swift computes the break side via ' +
    '`breakSideSign` (position-independent) at its one call site instead. Possibly a ' +
    'real port/reference behavioural gap — needs the reference read in context first.',
  contest:
    'Entry point to an entire alternate catch-contest model (Move/Contest.swift); ' +
    'production resolves catches through CatchDecision instead. Deleting risks ' +
    'cascading into a file this pass has not fully read.',
};

console.log('\x1b[1mReachability — every public UltimateSim func, outside SimChecks\x1b[0m');

const ultimateSimFiles = swiftFilesUnder(join(ROOT, 'swift/Sources/UltimateSim')).sort();
const searchFiles = [
  ...ultimateSimFiles,
  ...swiftFilesUnder(join(ROOT, 'swift/Sources/FlightUI')),
  ...swiftFilesUnder(join(ROOT, 'swift/Sources/FlightScope')),
  ...swiftFilesUnder(join(ROOT, 'ios')),
].sort();

const decls = publicFuncDecls(ultimateSimFiles);
const byName = new Map<string, Decl[]>();
for (const d of decls) {
  if (!byName.has(d.name)) byName.set(d.name, []);
  byName.get(d.name)!.push(d);
}

if (LIST) {
  for (const [name, ds] of byName) {
    const called = searchFiles.some((f) => isCalledIn(name, f));
    if (!called && !ALLOWLIST[name]) {
      const tag = KNOWN_UNRESOLVED[name] ? ' [known-unresolved]' : '';
      console.log(`${name}${tag}\t${ds.map((d) => `${relative(ROOT, d.file)}:${d.line}`).join(', ')}`);
    }
  }
  process.exit(0);
}

let warn = 0;

for (const [name, ds] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const label = `${name} (${ds.map((d) => `${relative(ROOT, d.file)}:${d.line}`).join(', ')})`;

  if (ALLOWLIST[name]) {
    // Still has to be called by SOMETHING, even if only SimChecks — an allowlisted name
    // the reference no longer calls at all has drifted from its own justification.
    const calledAnywhere = searchFiles.some((f) => isCalledIn(name, f))
      || swiftFilesUnder(join(ROOT, 'swift/Sources/SimChecks')).some((f) => isCalledIn(name, f));
    if (calledAnywhere) {
      pass++;
      if (!QUIET) console.log(`  \x1b[33mALLOWED\x1b[0m ${label}`);
    } else {
      fail++;
      failures.push(`${label} is allowlisted but called nowhere at all, including SimChecks — drop the entry, it has no justification left`);
      console.log(`  \x1b[31mFAIL\x1b[0m ${label}  allowlisted but uncalled anywhere`);
    }
    continue;
  }

  const called = searchFiles.some((f) => isCalledIn(name, f));
  if (called) {
    pass++;
    if (!QUIET) console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
    continue;
  }

  if (KNOWN_UNRESOLVED[name]) {
    // Does NOT fail the gate — these need a product or gameplay-behaviour decision this
    // scan cannot make, not a mechanical fix. Does NOT pass quietly either: a masked
    // finding is a finding nobody looks at again, which is the failure mode #5 itself
    // is about. Visible every run, at every effort level, until someone resolves or
    // reclassifies it.
    warn++;
    console.log(`  \x1b[33mUNRESOLVED\x1b[0m ${label}\n           ${KNOWN_UNRESOLVED[name]}`);
    continue;
  }

  fail++;
  failures.push(
    `${label} has no caller outside SimChecks. Wire it, delete it, or add it to ` +
      `ALLOWLIST or KNOWN_UNRESOLVED in tools/test-reachability.ts with a reason — see issue #5.`,
  );
  console.log(`  \x1b[31mFAIL\x1b[0m ${label}  no caller outside SimChecks`);
}

if (warn > 0) {
  console.log(`\n\x1b[33m${warn} unresolved\x1b[0m — see KNOWN_UNRESOLVED above for what each needs.`);
}

console.log(`\n\x1b[1m${fail === 0 ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m ${pass} passed, ${fail} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
