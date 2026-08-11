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

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { coeffGoldens } from './goldens/coeffs.ts';
import { aiMathGoldens } from './goldens/aimath.ts';
import { discRuntimeGoldens } from './goldens/discruntime.ts';
import { catchBandGoldens } from './goldens/catchband.ts';
import { divergenceGoldens } from './goldens/divergences.ts';
import { flightGoldens } from './goldens/flight.ts';
import { teamAIGoldens } from './goldens/teamai.ts';
import { humanReleaseGoldens } from './goldens/humanrelease.ts';
import { gameStateGoldens } from './goldens/gamestate.ts';
import { locomotionGoldens } from './goldens/locomotion.ts';
import { matchDiffGoldens } from './goldens/matchdiff.ts';
import { moveGoldens } from './goldens/move.ts';
import { playbookGoldens } from './goldens/playbook.ts';
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

console.log(requested.length ? `goldens (${requested.join(' ')}) →` : 'goldens →');
for (const [name, gen] of selected) write(name, gen());
console.log('done');
