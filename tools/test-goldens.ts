/**
 * tools/test-goldens.ts — the golden *tooling*, as assertions
 *
 *   node --experimental-strip-types tools/test-goldens.ts            full run
 *   node --experimental-strip-types tools/test-goldens.ts --quiet    suppress the per-check lines
 *   node --experimental-strip-types tools/test-goldens.ts --full     also run an unfiltered
 *                                                                   regeneration (minutes)
 *
 * Everything #41 asked for about goldens was prose in a workflow comment and a
 * docstring: which families reproduce across machines, that a named run rewrites
 * only what it names, that an unknown name writes nothing, that provenance has no
 * timestamp, that a stale fixture must be regenerated rather than hand-edited.
 * Prose does not fail. Each of those is a check below.
 *
 * ------------------------------------------------------------- where it runs
 *
 * In a throwaway detached worktree, never in the shared checkout. Two reasons,
 * both learned the hard way in this repository:
 *
 *   - Several agents share this tree, and a test that regenerates a fixture in it
 *     rewrites files it does not own — the exact failure `gen-goldens.ts`'s module
 *     filter exists to prevent (repository AGENTS.md).
 *   - Two of these checks need a *stale* fixture and a *dirty* `src/sim`, which
 *     cannot be arranged in a tree someone else is working in.
 *
 * The worktree path is unique per process, because AGENTS.md records two agents
 * racing for a fixed `/tmp/verify` and reading the loser's build failure as a
 * broken commit. The tools under test are copied in from the working tree rather
 * than taken from `HEAD`, so this tests what you are about to commit rather than
 * what you already did.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CANONICAL_PLATFORM } from './goldens/families.ts';

const QUIET = process.argv.includes('--quiet');
const FULL = process.argv.includes('--full');
const ROOT = join(import.meta.dirname, '..');
const GOLDENS = join('swift', 'Sources', 'SimChecks', 'Goldens');

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

/* ------------------------------------------------------------- the worktree */

const scratch = mkdtempSync(join(tmpdir(), `goldens-tooling-${process.pid}-`));
const tree = join(scratch, 'tree');

function git(args: string[], cwd = tree): { status: number; out: string } {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function node(args: string[], env: Record<string, string> = {}): { status: number; out: string } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', ...args], {
    cwd: tree,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const GEN = join('tools', 'gen-goldens.ts');
const CHECK = join('tools', 'check-goldens.ts');

function fixtures(): string[] {
  return readdirSync(join(tree, GOLDENS)).filter((f) => f.endsWith('.json'));
}
function mtimes(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of fixtures()) out[f] = statSync(join(tree, GOLDENS, f)).mtimeMs;
  return out;
}
function touched(before: Record<string, number>): string[] {
  const after = mtimes();
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((f) => before[f] !== after[f])
    .sort();
}
interface ProvenanceEntry {
  node?: string;
  platform?: string;
  commit?: string;
  dirty?: boolean;
}
function provenance(): Record<string, ProvenanceEntry> {
  return JSON.parse(readFileSync(join(tree, GOLDENS, 'provenance.json'), 'utf8')) as Record<
    string,
    ProvenanceEntry
  >;
}

function setUp(): void {
  execFileSync('git', ['worktree', 'add', '--detach', tree, 'HEAD'], { cwd: ROOT, stdio: 'pipe' });
  // `src/sim` imports `three`, so the generator cannot run without the dependency tree; a fresh
  // worktree has none. A symlink rather than a copy: 300 MB per run is not a test cost worth paying.
  symlinkSync(join(ROOT, 'node_modules'), join(tree, 'node_modules'));
  // The tools as they are right now, not as HEAD has them — otherwise this suite can only ever
  // report on the previous commit, which is the wrong commit to learn about.
  for (const p of [GEN, CHECK]) cpSync(join(ROOT, p), join(tree, p));
  cpSync(join(ROOT, 'tools', 'goldens'), join(tree, 'tools', 'goldens'), { recursive: true });
}

function tearDown(): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', tree], { cwd: ROOT, stdio: 'pipe' });
  } catch {
    /* the rmSync below is the backstop; a leaked worktree entry is pruned by git itself */
  }
  rmSync(scratch, { recursive: true, force: true });
}

/* ----------------------------------------------------------------- the checks */

function checkGeneratorScope(): void {
  group('generator scope (#41: a named run rewrites only what it names)');

  const before = mtimes();
  const named = node([GEN, 'rules', 'gamestate']);
  ok(named.status === 0, 'a named run succeeds', `exit ${named.status}`);
  const wrote = touched(before);
  ok(
    JSON.stringify(wrote) === JSON.stringify(['gamestate.json', 'provenance.json', 'rules.json']),
    'only the named families and the provenance sidecar are written',
    `wrote ${wrote.join(' ') || '(nothing)'}`,
  );
  // Byte-identity is not the evidence here — a regeneration of an unrequested family would
  // often produce identical bytes and leave no diff. The write itself is the observable.
  ok(
    named.out.includes('rules.json') && named.out.includes('gamestate.json'),
    'it names what it wrote',
  );

  const beforeUnknown = mtimes();
  const bogus = node([GEN, 'bogus']);
  ok(bogus.status !== 0, 'an unknown module exits nonzero', `exit ${bogus.status}`);
  ok(bogus.out.includes('bogus'), 'it names the unknown module');
  const known = knownFamilies(bogus.out);
  ok(known.length > 1, 'it lists the known modules', `${known.length} listed`);
  ok(touched(beforeUnknown).length === 0, 'and writes nothing at all');

  const onDisk = fixtures()
    .filter((f) => f !== 'provenance.json')
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
  ok(
    JSON.stringify(known.slice().sort()) === JSON.stringify(onDisk),
    'every fixture on disk has a generator and every generator has a fixture',
    `known ${known.length}, on disk ${onDisk.length}`,
  );

  if (FULL) {
    const beforeAll = mtimes();
    const all = node([GEN]);
    ok(all.status === 0, 'an unfiltered run succeeds', `exit ${all.status}`);
    const everything = touched(beforeAll).filter((f) => f !== 'provenance.json');
    ok(
      JSON.stringify(everything) === JSON.stringify(onDisk.map((f) => `${f}.json`)),
      'an unfiltered run rewrites every family',
      `${everything.length} of ${onDisk.length}`,
    );
  } else if (!QUIET) {
    console.log(
      `  \x1b[33mSKIP\x1b[0m an unfiltered run rewrites every family  (--full; matchdiff is eleven matches)`,
    );
  }
}

/** The `known: a b c` line the generator prints when it rejects a name. */
function knownFamilies(out: string): string[] {
  const line = out.split('\n').find((l) => l.startsWith('known:'));
  return line ? line.slice('known:'.length).trim().split(/\s+/) : [];
}

function checkProvenance(): void {
  group('provenance (#41: sidecar, deterministic, and honest about dirt)');

  const inherited = provenance();
  const first = node([GEN, 'rng']);
  ok(first.status === 0, 'generating one family succeeds', `exit ${first.status}`);
  const after = provenance();
  const head = git(['rev-parse', 'HEAD']).out.trim();

  ok(after.rng !== undefined, 'the requested family gets an entry');
  ok(after.rng?.node === process.version, 'it records the node version', String(after.rng?.node));
  ok(
    after.rng?.platform === `${process.platform}/${process.arch}`,
    'it records the platform and architecture',
    String(after.rng?.platform),
  );
  ok(after.rng?.commit === head, 'it records HEAD', String(after.rng?.commit).slice(0, 7));
  ok(after.rng?.dirty === undefined, 'no dirty flag when src/sim is clean');

  const others = Object.keys(inherited).filter((k) => k !== 'rng');
  ok(others.length > 0, 'the sidecar had other families to leave alone', others.join(' '));
  ok(
    others.every((k) => JSON.stringify(after[k]) === JSON.stringify(inherited[k])),
    'entries for families that were not requested are untouched',
  );

  const keys = Object.keys(after);
  ok(
    JSON.stringify(keys) === JSON.stringify(keys.slice().sort((a, b) => a.localeCompare(b))),
    'keys are alphabetical, so a one-family regeneration is one hunk',
  );

  const raw = readFileSync(join(tree, GOLDENS, 'provenance.json'), 'utf8');
  node([GEN, 'rng']);
  ok(
    readFileSync(join(tree, GOLDENS, 'provenance.json'), 'utf8') === raw,
    'repeating the generation at the same commit is byte-identical',
  );
  ok(
    !/\d{4}-\d{2}-\d{2}T|\b1[6-9]\d{11}\b|"(date|time|timestamp|generated(At)?)"/i.test(raw),
    'there is no wall clock in it — the commit is the timestamp that matters',
  );

  // A fixture with provenance baked in would have to be rewritten to add it, which for the
  // chaotic families means committing the very drift provenance exists to record.
  const metadata = ['node', 'platform', 'commit', 'dirty', 'generator', 'generatedAt'];
  const polluted = fixtures()
    .filter((f) => f !== 'provenance.json')
    .filter((f) => {
      const parsed: unknown = JSON.parse(readFileSync(join(tree, GOLDENS, f), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
      return metadata.some((k) => Object.hasOwn(parsed, k));
    });
  ok(polluted.length === 0, 'no fixture carries generator metadata of its own', polluted.join(' '));
}

function checkDirtyFlag(): void {
  group('provenance dirt is src/sim dirt, and nothing else');

  const oracleFile = join('src', 'sim', 'Rng.ts');
  appendFileSync(join(tree, oracleFile), '\n// provenance dirt probe\n');
  ok(node([GEN, 'rng']).status === 0, 'a dirty-oracle regeneration still succeeds');
  ok(provenance().rng?.dirty === true, 'a dirty src/sim is recorded as dirty');
  git(['checkout', '--', oracleFile]);

  // A dirty `swift/` or half-written doc does not make the numbers unattributable, and flagging
  // it would train people to ignore the flag.
  appendFileSync(join(tree, 'README.md'), '\nprovenance dirt probe\n');
  ok(node([GEN, 'rng']).status === 0, 'a regeneration with dirt outside src/sim succeeds');
  ok(provenance().rng?.dirty === undefined, 'dirt outside src/sim is not recorded as dirty');
  git(['checkout', '--', 'README.md']);
}

function checkFreshness(): void {
  group('freshness (#41: byte-compare only where bytes reproduce)');

  // The checks above have already regenerated families, so the sidecar differs from the commit
  // going in. That is the interesting starting state: it makes "provenance is not part of the
  // comparison" a claim with teeth rather than a tautology.
  const sidecar = (): string => readFileSync(join(tree, GOLDENS, 'provenance.json'), 'utf8');
  const sidecarBefore = sidecar();
  ok(
    git(['status', '--porcelain', '--', join(GOLDENS, 'provenance.json')]).out.trim() !== '',
    'the sidecar already differs from the commit when the check starts',
  );

  const fresh = node([CHECK, 'freshness', 'rng']);
  ok(fresh.status === 0, 'rng is fresh at HEAD and the check says so', `exit ${fresh.status}`);
  ok(fresh.out.includes('PASS'), 'it prints a verdict');
  ok(sidecar() === sidecarBefore, 'a passing check hands the sidecar back byte-identical');

  const beforeRefusal = mtimes();
  const foreign = node([CHECK, 'freshness', 'coeffs'], { GOLDENS_PLATFORM: 'linux/x64' });
  ok(foreign.status !== 0, 'a platform-sensitive family is refused off the canonical platform', `exit ${foreign.status}`);
  ok(foreign.out.includes('coeffs'), 'the refusal names the family');
  ok(foreign.out.includes('linux/x64'), 'the refusal names the platform it is on');
  ok(foreign.out.includes(CANONICAL_PLATFORM), 'the refusal names the canonical platform');
  ok(foreign.out.includes('staleness'), 'the refusal points at what a foreign machine can answer');
  ok(foreign.out.includes('GOLDENS_PLATFORM override'), 'a platform override announces itself');
  ok(touched(beforeRefusal).length === 0, 'and it refuses before the generator runs');

  const unmeasured = node([CHECK, 'freshness', 'flight']);
  ok(unmeasured.status !== 0, 'a family with no cross-platform measurement is refused', `exit ${unmeasured.status}`);
  ok(unmeasured.out.includes('families.ts'), 'it says where to declare the measurement');

  // The stale path, exercised rather than read: commit a hand-edited fixture in this throwaway
  // worktree, then let the check regenerate over it. A hand edit alone would be silently
  // overwritten by the regeneration, so committing it is what makes the fixture *stale*.
  const rngPath = join(tree, GOLDENS, 'rng.json');
  const doctored: { cases: { note?: string }[] } = JSON.parse(readFileSync(rngPath, 'utf8'));
  doctored.cases[0].note = 'hand-edited, which ADR-0001 forbids';
  writeFileSync(rngPath, `${JSON.stringify(doctored, null, 2)}\n`);
  git(['commit', '--only', '-m', 'stale rng for the freshness check', '--', join(GOLDENS, 'rng.json')]);
  const stale = node([CHECK, 'freshness', 'rng']);
  ok(stale.status === 1, 'a stale fixture fails', `exit ${stale.status}`);
  ok(stale.out.includes('rng.json'), 'the failure names the file');
  ok(
    stale.out.includes('node --experimental-strip-types tools/gen-goldens.ts rng'),
    'the failure names the exact command that fixes it',
  );
  ok(
    /hand-edit/i.test(stale.out) && stale.out.includes('ADR-0001'),
    'the failure forbids hand-editing the golden',
  );
  // The doctored commit is left where it is. It lives only in this worktree's detached HEAD,
  // which `tearDown` discards; unwinding it with `reset --hard` would also revert the tools
  // this suite copied in over HEAD's versions, and so test the wrong code from here on.
}

function checkStaleness(): void {
  group('staleness (#41: what a foreign runner can honestly say)');

  const before = mtimes();
  const report = node([CHECK, 'staleness'], { GOLDENS_PLATFORM: 'linux/x64' });
  ok(report.status === 0, 'the default report is diagnostic, not a gate', `exit ${report.status}`);
  for (const family of ['coeffs', 'matchdiff']) {
    ok(report.out.includes(family), `it reports on ${family}`);
  }
  ok(report.out.includes(`canonical=${CANONICAL_PLATFORM}`), 'every line names the canonical platform');
  ok(/staleness=[a-z-]+/.test(report.out), 'every line names a staleness kind');
  ok(touched(before).length === 0, 'it never regenerates anything');

  const path = join(tree, GOLDENS, 'provenance.json');
  const doctored = provenance();
  doctored.coeffs = { node: 'v22.22.2', platform: 'linux/x64', commit: git(['rev-parse', 'HEAD']).out.trim() };
  writeFileSync(path, `${JSON.stringify(doctored, null, 2)}\n`);
  const strict = node([CHECK, 'staleness', '--strict', 'coeffs'], { GOLDENS_PLATFORM: 'linux/x64' });
  ok(strict.status === 1, 'a fixture attributed to a foreign platform fails --strict', `exit ${strict.status}`);
  ok(strict.out.includes('provenance-foreign-platform'), 'and names that as the staleness kind');

  doctored.coeffs = { node: process.version, platform: CANONICAL_PLATFORM, commit: git(['rev-parse', 'HEAD']).out.trim(), dirty: true };
  writeFileSync(path, `${JSON.stringify(doctored, null, 2)}\n`);
  const dirty = node([CHECK, 'staleness', '--strict', 'coeffs'], { GOLDENS_PLATFORM: 'linux/x64' });
  ok(dirty.status === 1, 'a fixture generated from a dirty oracle fails --strict', `exit ${dirty.status}`);
  ok(dirty.out.includes('provenance-dirty'), 'and names that as the staleness kind');

  git(['checkout', '--', join(GOLDENS, 'provenance.json')]);
}

/* -------------------------------------------------------------------- driver */

try {
  setUp();
  checkGeneratorScope();
  checkProvenance();
  checkDirtyFlag();
  checkFreshness();
  checkStaleness();
} finally {
  tearDown();
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
if (fail) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
