/**
 * tools/test-imports.ts — ADR-0008's dependency direction, as an assertion
 *
 *   node tools/test-imports.ts            full run
 *   node tools/test-imports.ts --quiet    suppress the per-file lines
 *
 * ADR-0008 says the reference "may depend on simulation modules and minimal
 * math/runtime adapters, but not on render systems, capture scenarios, meshes,
 * materials, DOM, or GL context". That was prose, and prose does not fail. A
 * `src/sim/` file that imports the engine drags `three/addons`'s
 * `EffectComposer` in behind it, which is the renderer the reference exists to
 * not need — and nothing noticed for 68 commits.
 *
 * Two things this deliberately does NOT flag:
 *
 *   - `import * as THREE from 'three'`. ADR-0008 excuses it explicitly: a
 *     library dependency for vector and quaternion maths, not a web runtime.
 *     Removing it is a later mechanical substitution.
 *   - `import type`. Type-only imports erase at runtime, so they cannot pull a
 *     renderer into a headless process. ADR-0008 allows the transitional
 *     capture/input adapters on `GameSystem`, and those are the type imports.
 *
 * What is left is the thing that actually matters: a *value* import that runs
 * another module's top level.
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

/* ------------------------------------------------------------------ walking */

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

interface Import {
  /** The module specifier, verbatim. */
  spec: string;
  /** 1-based line, so a failure names the line an editor can jump to. */
  line: number;
  /** `import type {…}` / `export type {…}` — erased at runtime. */
  typeOnly: boolean;
}

/**
 * Every static import in a file.
 *
 * A regex is the wrong tool for parsing TypeScript in general and the right one
 * here: the only construct that can pull a renderer into a headless process is
 * a static `import`/`export … from`, which is by specification at the top level
 * and lexically unambiguous. A dynamic `import()` is deliberately not matched —
 * it does not run unless awaited, and the reference has none.
 */
function importsOf(src: string): Import[] {
  const out: Import[] = [];
  const re = /^[ \t]*(?:import|export)\b([\s\S]*?)from\s*['"]([^'"]+)['"]/gm;
  for (const m of src.matchAll(re)) {
    const clause = m[1];
    out.push({
      spec: m[2],
      line: src.slice(0, m.index).split('\n').length,
      // `import type {…}` and `import {type A, type B}` both erase. A clause
      // mixing `type` with a bare binding does not, and must not be excused.
      typeOnly: /^\s*type\s/.test(clause) || /^\s*\{[^}]*\}\s*$/.test(clause)
        ? /^\s*type\s/.test(clause) || clause.replace(/[{}]/g, '').split(',')
            .filter((s) => s.trim().length > 0).every((s) => /^\s*type\s/.test(s))
        : false,
    });
  }
  return out;
}

/** Where a specifier resolves to, relative to the repo root. */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // a package, not a path
  const dir = join(fromFile, '..');
  return relative(ROOT, join(dir, spec)).replace(/\\/g, '/');
}

/* ------------------------------------------------------------------- checks */

/**
 * The renderer trees. `src/sim/` may not run any of their top levels, and
 * nothing here is grandfathered — these are ADR-0008's "render systems, meshes,
 * materials, DOM, GL context".
 *
 * `src/core/` is the load-bearing one: `Ctx.ts` imports `three/addons`'s
 * `EffectComposer` at line 2, so a single value import of it is the entire
 * post-processing stack, in a process whose whole purpose is not to have one.
 */
const RENDERER_TREES = [
  'src/core/',
  'src/render/',
  'src/world/',
  'src/entities/',
  'src/camera/',
  'src/ui/',
  'src/audio/',
];

/**
 * The capture/input adapters ADR-0008 grandfathers, exactly.
 *
 * The ADR tolerates the ones that exist — "`GameSystem` is transitional and
 * still has capture/input adapters" — and then says the thing this list is for:
 * "no new dependency of that kind may be added, and they are moved behind
 * adapters incrementally". An allowlist enforces both halves. Adding an import
 * fails because it is not on the list; moving one behind an adapter fails
 * because the list still claims it, which is the correct moment to shorten it.
 *
 * Both entries are `src/sim/Game.ts`, and #42 is the issue that removes them.
 */
const GRANDFATHERED = new Set([
  'src/sim/Game.ts -> src/capture/Shots.ts',
  'src/sim/Game.ts -> src/input/Switch.ts',
]);

const TRANSITIONAL_TREES = ['src/capture/', 'src/input/'];

console.log('\x1b[1mADR-0008 — the reference does not depend on the client\x1b[0m');

group('src/sim/ holds no runtime import of the renderer');

const simFiles = tsFilesUnder(join(ROOT, 'src/sim')).sort();
ok(simFiles.length > 0, 'found the reference', `${simFiles.length} files under src/sim/`);

/** Every runtime (non-type) path import out of the reference, resolved. */
const runtimeEdges = simFiles.flatMap((file) => {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  return importsOf(readFileSync(file, 'utf8'))
    .filter((i) => !i.typeOnly)
    .map((i) => ({ from: rel, line: i.line, spec: i.spec, target: resolveSpec(file, i.spec) }))
    .filter((i): i is typeof i & { target: string } => i.target !== null);
});

for (const file of simFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const offenders = runtimeEdges.filter(
    (e) => e.from === rel && RENDERER_TREES.some((t) => e.target.startsWith(t)),
  );
  ok(
    offenders.length === 0,
    rel,
    offenders.map((o) => `line ${o.line} runs '${o.spec}'`).join('; '),
  );
}

group('the grandfathered capture/input adapters, exactly');

const transitional = runtimeEdges
  .filter((e) => TRANSITIONAL_TREES.some((t) => e.target.startsWith(t)))
  .map((e) => `${e.from} -> ${e.target}`);

for (const edge of new Set(transitional)) {
  ok(GRANDFATHERED.has(edge), `declared: ${edge}`, GRANDFATHERED.has(edge) ? '' : 'a new adapter — ADR-0008 forbids adding one');
}
for (const edge of GRANDFATHERED) {
  ok(
    transitional.includes(edge),
    `still present: ${edge}`,
    transitional.includes(edge) ? '' : 'gone — shorten GRANDFATHERED, the seam moved',
  );
}

/**
 * The stream every golden depends on has exactly one definition.
 *
 * Three copies of one xorshift128 is not a style problem: a golden is a claim
 * about a specific sequence of draws, so a copy that drifts by one constant
 * invalidates every fixture at once and the failure looks like a physics bug.
 * Counting the declarations is cruder than comparing their behaviour and it is
 * the check that fails at the moment a fourth copy is written, which is when it
 * is cheap to stop.
 */
group('one xorshift128, not several');

const referenceFiles = tsFilesUnder(join(ROOT, 'src/sim')).sort();
const declarers: string[] = [];
for (const file of referenceFiles) {
  const src = readFileSync(file, 'utf8');
  // The warm-up loop is the fingerprint: every copy of this generator discards
  // 16 draws in its constructor, and nothing else in the reference does.
  if (/for\s*\(let i = 0; i < 16; i\+\+\) this\.next\(\)/.test(src)) {
    declarers.push(relative(ROOT, file).replace(/\\/g, '/'));
  }
}
ok(
  declarers.length === 1,
  'the reference declares the generator once',
  `declared in ${declarers.length}: ${declarers.join(', ') || 'nowhere'}`,
);

/* ------------------------------------------------------------------ verdict */

console.log(`\n\x1b[1m${fail === 0 ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m ${pass} passed, ${fail} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
