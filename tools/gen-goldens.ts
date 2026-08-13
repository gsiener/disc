/**
 * Golden-vector generator for the Swift port.
 *
 *   node tools/gen-goldens.ts
 *
 * Writes JSON fixtures under `swift/Sources/SimChecks/Goldens/`, which ship as a
 * resource bundle so the same checks run on device as in the terminal. The Swift
 * sim is validated against these rather than against a re-reading of the
 * TypeScript by a human, because the whole risk of this port is silent
 * behavioural drift that reads correctly on the page.
 *
 * The rule for what belongs here: anything whose contract is a *number*. The RNG
 * must match bit-for-bit — it is the anchor, and divergence there means a
 * structural porting bug rather than numeric drift. Continuous state matches
 * within a tolerance the consuming test states for itself.
 *
 * These files are generated, committed, and read-only to the Swift side. When a
 * fixture changes, the diff is the record of a deliberate behaviour change.
 *
 * ---------------------------------------------------------------- structure
 *
 * This file is a thin index. Each module's fixtures live in `tools/goldens/<name>.ts`
 * and export one function returning the object to serialise. That split exists so
 * several modules can be ported at once without every author editing this file and
 * colliding — add a module there, add one line to GENERATORS here.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

import {
  CANONICAL_PLATFORM,
  currentPlatform,
  evidenceFor,
  isCanonicalPlatform,
  platformOverride,
  sensitivity,
} from './goldens/families.ts';

import { coeffGoldens } from './goldens/coeffs.ts';
import { aiMathGoldens } from './goldens/aimath.ts';
import { discRuntimeGoldens } from './goldens/discruntime.ts';
import { catchBandGoldens } from './goldens/catchband.ts';
import { divergenceGoldens } from './goldens/divergences.ts';
import { flightGoldens } from './goldens/flight.ts';
import { teamAIGoldens } from './goldens/teamai.ts';
import { humanReleaseGoldens } from './goldens/humanrelease.ts';
import { gameStateGoldens } from './goldens/gamestate.ts';
import { lineupGoldens } from './goldens/lineup.ts';
import { locomotionGoldens } from './goldens/locomotion.ts';
import { matchDiffGoldens } from './goldens/matchdiff.ts';
import { moveGoldens } from './goldens/move.ts';
import { playbookGoldens } from './goldens/playbook.ts';
import { pullGoldens } from './goldens/pull.ts';
import { rngGoldens } from './goldens/rng.ts';
import { rulesGoldens } from './goldens/rules.ts';
import { simMathGoldens } from './goldens/simmath.ts';
import { throwGoldens } from './goldens/throws.ts';
import { throwSolverGoldens } from './goldens/throwsolver.ts';
import { tryCatchGoldens } from './goldens/trycatch.ts';

const OUT = join(import.meta.dirname, '..', 'swift', 'Sources', 'SimChecks', 'Goldens');

function write(name: string, data: unknown): void {
  const path = join(OUT, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log(`  ${name}`);
}

/** Add a line here when a new module's fixtures land. */
const GENERATORS: Record<string, () => unknown> = {
  'rng.json': rngGoldens,
  'coeffs.json': coeffGoldens,
  'simmath.json': simMathGoldens,
  'flight.json': flightGoldens,
  'throws.json': throwGoldens,
  'rules.json': rulesGoldens,
  'gamestate.json': gameStateGoldens,
  'move.json': moveGoldens,
  'locomotion.json': locomotionGoldens,
  'playbook.json': playbookGoldens,
  // Issue #48/#2: `Game.doPull`, captured directly — see tools/goldens/pull.ts.
  'pull.json': pullGoldens,
  // Issue #56: `Game.ts`'s `lineUpForPull()`, captured directly — see
  // tools/goldens/lineup.ts. Regenerate alongside `pull` if you touch either.
  'lineup.json': lineupGoldens,
  'aimath.json': aiMathGoldens,
  'humanrelease.json': humanReleaseGoldens,
  'discruntime.json': discRuntimeGoldens,
  'teamai.json': teamAIGoldens,
  'throwsolver.json': throwSolverGoldens,
  'trycatch.json': tryCatchGoldens,
  // Issue #4: the catch height band and its consumers, plus the two invariants that
  // keep them one band. Regenerate it with `rules`, `aimath` or `throwsolver`.
  'catchband.json': catchBandGoldens,
  // Not a behavioural fixture: the declared Swift-vs-reference divergences (ADR-0007)
  // plus a scrape of the reference's own AI constants. Regenerate it whenever you touch
  // a constant on either side — it is the only fixture that reads the reference as text.
  'divergences.json': divergenceGoldens,
  // Slow (eleven full matches). Named-module runs skip it unless you ask for it.
  'matchdiff.json': matchDiffGoldens,
};

/**
 * Optional module filter. `node tools/gen-goldens.ts rules gamestate` rewrites
 * only `rules.json` and `gamestate.json`; no arguments rewrites every one.
 *
 * This exists because several agents share the checkout and each owns a subset
 * of the fixtures. An unfiltered run rewrites everyone's, which has already put
 * stale goldens on main once and forced two agents to hand-stage their own JSON.
 * Regenerate only what you own.
 *
 * It is also the difference between a fast regeneration and a slow one now that
 * `matchdiff` is here: every other module is arithmetic and finishes instantly,
 * that one plays eleven full matches and takes minutes. Naming your modules is
 * the way to not pay for it.
 */
const requested = process.argv.slice(2).map((a) => a.replace(/\.json$/, ''));

const selected = requested.length
  ? Object.entries(GENERATORS).filter(([name]) => requested.includes(name.replace(/\.json$/, '')))
  : Object.entries(GENERATORS);

const unknown = requested.filter(
  (r) => !Object.keys(GENERATORS).some((name) => name.replace(/\.json$/, '') === r),
);
if (unknown.length) {
  console.error(`unknown golden module(s): ${unknown.join(', ')}`);
  console.error(`known: ${Object.keys(GENERATORS).map((n) => n.replace(/\.json$/, '')).join(' ')}`);
  process.exit(1);
}

/* -------------------------------------------------------------- provenance */

/**
 * Which machine produced each fixture.
 *
 * A golden regenerated at the commit that wrote it does not reproduce on another
 * machine. Measured: `coeffs.json` differs in 4 of 2,297 numbers across platforms
 * (one or two ULP of V8 arithmetic), and `matchdiff.json` — eleven fifteen-minute
 * matches, ~108,000 chaotic ticks apiece — moves **35 % of its counts**, because one
 * ULP anywhere is enough. See `.agents/friction-log/20260811070423-a-golden-regenerated/`
 * and #41. Which families that has been measured for lives in `goldens/families.ts`,
 * as data, because `check-goldens.ts` has to make the same distinction and prose in two
 * places drifts.
 *
 * That makes a regenerated fixture indistinguishable, from the suite's point of view,
 * from a genuine behaviour change: it silently rebases every band in `MatchDiffTests`
 * onto whichever machine ran the generator. The friction log records a case where
 * regenerating turned a red assertion green with nothing about either engine changed.
 *
 * So the fixtures now say where they came from. This is a **sidecar** rather than a key
 * inside each fixture on purpose: adding a field to the fixtures themselves would mean
 * rewriting all nineteen, which for the chaotic families means committing exactly the
 * bug this records — and hand-editing a golden is forbidden outright (ADR-0001).
 *
 * Entries are per family and merged, so `gen-goldens.ts rng` updates `rng` and leaves
 * the rest alone. A family with no entry has not been regenerated since this landed,
 * and "unknown" is the honest thing to say about it.
 *
 * No timestamp: it would change on every run and make the sidecar the one file that can
 * never be byte-reproducible. The commit is the timestamp that matters.
 */
interface Provenance {
  node: string;
  platform: string;
  commit: string;
  /** True when `src/sim/` had uncommitted changes — then `commit` does not describe it. */
  dirty?: boolean;
}

function gitOutput(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function currentProvenance(): Provenance {
  const commit = gitOutput(['rev-parse', 'HEAD']) || 'unknown';
  // Only `src/sim/` matters: it is what the generators read. A dirty `swift/` or a
  // half-written doc does not make the numbers unattributable, and flagging it would
  // train people to ignore the flag.
  const dirty = gitOutput(['status', '--porcelain', '--', 'src/sim']) !== '';
  const p: Provenance = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    commit,
  };
  if (dirty) p.dirty = true;
  return p;
}

function recordProvenance(families: string[]): void {
  const path = join(OUT, 'provenance.json');
  let existing: Record<string, Provenance> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Provenance>;
    } catch {
      existing = {};
    }
  }
  const now = currentProvenance();
  for (const f of families) existing[f] = now;
  // Sorted so the diff of a one-family regeneration is one hunk, not a reordering.
  const sorted = Object.fromEntries(Object.entries(existing).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`  provenance.json  (${now.node} ${now.platform}${now.dirty ? ' DIRTY' : ''})`);
}

/**
 * Say so before rewriting a fixture that will not reproduce here.
 *
 * A warning rather than a refusal, deliberately: regenerating `matchdiff` on a foreign
 * machine is the right move when you are investigating whether a *rate* moved, and an
 * unfiltered run on a developer's Linux box should not become an error. What must never
 * happen is *committing* the result, and what enforces that is `check-goldens.ts` on the
 * canonical runner. This is the part a human sees before paying for eleven matches.
 */
function warnOffCanonical(families: string[]): void {
  const override = platformOverride();
  if (override) console.error(`GOLDENS_PLATFORM override in effect: ${override}`);
  if (isCanonicalPlatform()) return;
  const risky = families.filter((f) => sensitivity(f) === 'sensitive');
  if (!risky.length) return;
  console.error(
    `\n⚠︎  ${risky.join(', ')} regenerated on ${currentPlatform()}, not the canonical ${CANONICAL_PLATFORM}.`,
  );
  for (const f of risky) console.error(`   ${f}: ${evidenceFor(f)}`);
  console.error(
    `   The numbers below are this machine's. Do not commit them: they read as a behaviour change.\n`,
  );
}

console.log(requested.length ? `goldens (${requested.join(' ')}) →` : 'goldens →');
warnOffCanonical(selected.map(([name]) => name.replace(/\.json$/, '')));
for (const [name, gen] of selected) write(name, gen());
recordProvenance(selected.map(([name]) => name.replace(/\.json$/, '')));
console.log('done');
