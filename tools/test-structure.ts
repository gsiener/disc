/**
 * tools/test-structure.ts — invariants the compiler cannot express
 *
 *   node tools/test-structure.ts            full run
 *   node tools/test-structure.ts --quiet    suppress the per-check lines
 *
 * ADR-0004 records the most expensive bug in this project's history: distances
 * that were only right at regulation, on a default game mode played on a pitch
 * a third the size. It also says where the durable fix has to live:
 *
 *   > Where the rule lives is itself the problem. It is written down in a
 *   > friction-log entry — somewhere neither the compiler nor the suite can see
 *   > it. Issue #18 is the durable fix: shape properties that hold at both
 *   > formats, so a violation is a red assertion rather than something found by
 *   > reading code one measurement at a time.
 *
 * `minisShape()` in `SimChecks` closed the behavioural half of that. This file
 * closes the structural half: a property about the *shape of the surface* rather
 * than about any number it produces.
 *
 * Why this cannot live in `SimChecks`: ADR-0002 requires the identical
 * assertions to run inside the shipped app, where there is no source tree to
 * read and no way to enumerate a module's declarations. A structural check has
 * to run where the sources are, which is here.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const QUIET = process.argv.includes('--quiet');
const ROOT = new URL('..', import.meta.url).pathname;

let pass = 0;
let fail = 0;
const failures: string[] = [];
let section = '';

function group(name: string): void {
  section = name;
  console.log(`\n\x1b[1m── ${name} ──\x1b[0m`);
}
function ok(cond: boolean, label: string, detail = ''): void {
  if (cond) {
    pass++;
    if (!QUIET) console.log(`  \x1b[32mPASS\x1b[0m ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(`[${section}] ${label} ${detail}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}  ${detail}`);
  }
}

function swiftFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...swiftFilesUnder(p));
    else if (entry.endsWith('.swift')) out.push(p);
  }
  return out;
}

/** File-scope declarations only — indented ones are members of some type. */
function fileScopeDecls(src: string): { name: string; line: number; kind: string }[] {
  const out: { name: string; line: number; kind: string }[] = [];
  const re = /^(?:public |internal )?(func|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  for (const m of src.matchAll(re)) {
    out.push({ kind: m[1], name: m[2], line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

console.log('\x1b[1mADR-0004 — a field question cannot be asked without a field\x1b[0m');

/**
 * The nine predicates that answer a question about the pitch.
 *
 * Each exists as a method on `FieldConstants`, which is reached through
 * `GameFormat.field` and therefore cannot answer without being told which pitch
 * it is. A file-scope copy of any of them can only close over a module constant,
 * and the only module constant available is regulation — which is the mechanism
 * ADR-0004 was written about.
 */
const FIELD_PREDICATES = [
  'isInBounds',
  'endzoneOf',
  'isInEndzone',
  'isGoal',
  'goalLineZ',
  'brickMark',
  'clampToField',
  'boundaryCrossing',
  'putIntoPlaySpot',
];

/**
 * A pitch frozen at module scope. `FIELD` was `FieldConstants.standard`, so every
 * free function above silently meant "regulation" — on a game whose default
 * format is minis.
 */
const FROZEN_PITCH = ['FIELD', 'CONES'];

group('UltimateSim declares no format-free field predicate');

const simFiles = swiftFilesUnder(join(ROOT, 'swift/Sources/UltimateSim')).sort();
ok(simFiles.length > 0, 'found the port', `${simFiles.length} files`);

for (const file of simFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const decls = fileScopeDecls(readFileSync(file, 'utf8'));
  const offenders = decls.filter(
    (d) =>
      (d.kind === 'func' && FIELD_PREDICATES.includes(d.name)) ||
      (d.kind !== 'func' && FROZEN_PITCH.includes(d.name)),
  );
  ok(
    offenders.length === 0,
    rel,
    offenders.map((o) => `line ${o.line} declares ${o.kind} ${o.name} at file scope`).join('; '),
  );
}

/**
 * The counterparts must actually exist, or the check above passes by having
 * deleted the capability rather than by having parameterised it.
 */
group('FieldConstants answers all nine');

const fieldSrc = readFileSync(join(ROOT, 'swift/Sources/UltimateSim/Game/GameFormat.swift'), 'utf8');
for (const p of FIELD_PREDICATES) {
  ok(
    new RegExp(`^\\s+public func ${p}\\b`, 'm').test(fieldSrc),
    `FieldConstants.${p}`,
    '',
  );
}

console.log(`\n\x1b[1m${fail === 0 ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m ${pass} passed, ${fail} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
