/**
 * tools/check-goldens.ts — is a committed golden what the reference produces?
 *
 *   node --experimental-strip-types tools/check-goldens.ts freshness rng
 *   node --experimental-strip-types tools/check-goldens.ts freshness coeffs matchdiff
 *   node --experimental-strip-types tools/check-goldens.ts staleness [--strict] [family...]
 *
 * ADR-0001 makes `src/sim/` the oracle and the fixtures its output, and #15 found
 * that nothing executable enforced it: a change to the reference with no
 * regeneration leaves a stale fixture that is green in both engines at once.
 * `freshness` is that enforcement — regenerate, byte-compare, and say what to run.
 *
 * ------------------------------------------------------- why two modes, not one
 *
 * A byte comparison is only meaningful where the family reproduces. `coeffs`
 * moves 4 of 2,297 numbers across platforms and `matchdiff` moves 35 % of its
 * counts (see `tools/goldens/families.ts` for both measurements), so comparing
 * either one on a foreign runner fails for a reason that has nothing to do with
 * freshness — and its failure is indistinguishable from a real behaviour change.
 * That is a gate that gets switched off within a week, so this refuses to perform
 * that comparison at all: `freshness` on a platform-sensitive family off the
 * canonical platform exits without running the generator.
 *
 * `staleness` is what a foreign runner can honestly say instead. It never
 * regenerates and never compares bytes; it reads `provenance.json` and git
 * history and names the family, the canonical platform, and the *kind* of
 * staleness. It is diagnostic by default because history staleness has a known
 * false positive — the friction log's `20260811070423-a-golden-regenerated`
 * records a fixture reported stale by `git log` while being byte-current — while
 * `--strict` fails only on the two kinds that cannot be a false positive: a
 * fixture attributed to the wrong platform, or generated from a dirty tree.
 *
 * `provenance.json` itself is never byte-compared, in either mode. It records the
 * commit, so it changes on every regeneration by design; treating it as a
 * freshness fixture would make the one file that can never reproduce the one file
 * the gate depends on.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CANONICAL_PLATFORM,
  currentPlatform,
  evidenceFor,
  isCanonicalPlatform,
  measuredFamilies,
  platformOverride,
  sensitivity,
} from './goldens/families.ts';

const ROOT = join(import.meta.dirname, '..');
const GOLDENS = join('swift', 'Sources', 'SimChecks', 'Goldens');

const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const OFF = '\x1b[0m';

function usage(): never {
  console.error(`usage:
  check-goldens.ts freshness <family...>     regenerate and byte-compare (canonical platforms only)
  check-goldens.ts staleness [--strict] [family...]
                                             provenance/history diagnostics, no regeneration

measured families: ${measuredFamilies().join(' ')}
canonical platform: ${CANONICAL_PLATFORM}`);
  process.exit(2);
}

function git(args: string[]): { status: number; stdout: string } {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim() };
}

function fixturePath(family: string): string {
  return join(GOLDENS, `${family}.json`);
}

function generatorCommand(families: string[]): string {
  return `node --experimental-strip-types tools/gen-goldens.ts ${families.join(' ')}`;
}

/** Announce the platform every time, because a check that hides its configuration gets trusted wrongly. */
function announcePlatform(): void {
  const override = platformOverride();
  console.log(
    `platform ${currentPlatform()}${override ? ` ${YELLOW}(GOLDENS_PLATFORM override in effect)${OFF}` : ''}` +
      `  canonical ${CANONICAL_PLATFORM}`,
  );
}

/* ---------------------------------------------------------------- freshness */

function freshness(families: string[]): never {
  if (!families.length) usage();
  announcePlatform();

  for (const f of families) {
    const kind = sensitivity(f);
    if (kind === 'unmeasured') {
      console.error(
        `${RED}refusing${OFF} to gate on \`${f}\`: no cross-platform measurement is recorded for it.`,
      );
      console.error(
        `Measure whether it reproduces across machines, then declare it in tools/goldens/families.ts.`,
      );
      console.error(`measured families: ${measuredFamilies().join(' ')}`);
      process.exit(2);
    }
    // Before the generator runs, not after: the point is that the comparison never happens
    // on a machine where its failure would mean nothing.
    if (kind === 'sensitive' && !isCanonicalPlatform()) {
      console.error(
        `${RED}refusing${OFF} to byte-compare \`${f}\` on ${currentPlatform()} — it reproduces only on ${CANONICAL_PLATFORM}.`,
      );
      console.error(`  measured: ${evidenceFor(f)}`);
      console.error(
        `  A diff here would report a platform difference as a behaviour change. Run this on ${CANONICAL_PLATFORM},`,
      );
      console.error(
        `  or ask for what a foreign machine can honestly answer: check-goldens.ts staleness ${f}`,
      );
      process.exit(2);
    }
    if (!existsSync(join(ROOT, fixturePath(f)))) {
      console.error(`${RED}missing${OFF} fixture ${fixturePath(f)} — nothing to compare against.`);
      process.exit(2);
    }
  }

  // Kept so a *passing* check can hand it back untouched below.
  const sidecar = join(ROOT, GOLDENS, 'provenance.json');
  const sidecarBefore = existsSync(sidecar) ? readFileSync(sidecar) : null;

  console.log(`${BOLD}regenerating${OFF} ${families.join(' ')}`);
  const gen = spawnSync(
    process.execPath,
    ['--experimental-strip-types', join('tools', 'gen-goldens.ts'), ...families],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (gen.status !== 0) {
    console.error(`${RED}the generator failed${OFF} — that is the failure to fix, not a stale fixture.`);
    process.exit(gen.status ?? 1);
  }

  // Scoped to the fixtures, so a dirty `provenance.json` — which the regeneration above just
  // rewrote, by design — cannot fail this, and neither can an unrelated edit elsewhere.
  const paths = families.map(fixturePath);
  const diff = spawnSync('git', ['diff', '--exit-code', '--', ...paths], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (diff.status !== 0) {
    for (const f of families) {
      console.error(`::error file=${fixturePath(f)}::${f}.json may be stale — see the diff above.`);
    }
    console.error(
      `${RED}FAIL${OFF} ${families.join(' ')} — the committed fixture is not what the reference produces on ${currentPlatform()}.`,
    );
    console.error(`  Regenerate it: ${generatorCommand(families)}`);
    console.error(`  Never hand-edit a golden (ADR-0001) — the diff of a regeneration is the record of a`);
    console.error(`  deliberate behaviour change, and a hand edit is a claim about the reference that the`);
    console.error(`  reference does not make.`);
    console.error(`  Files: ${paths.join(' ')}`);
    // The sidecar is left as the generator wrote it here, on purpose: the fix is to commit
    // this regeneration, and then the machine that produced the new numbers is exactly what
    // provenance should say.
    process.exit(1);
  }

  // A passing check found nothing to record, so it records nothing. Left alone, running this
  // locally reports the commit you happen to be standing on for numbers that were produced
  // somewhere else — and leaves a dirty file in a checkout several agents share, which is how
  // one agent's verification ends up in another's commit.
  if (sidecarBefore && !readFileSync(sidecar).equals(sidecarBefore)) {
    writeFileSync(sidecar, sidecarBefore);
    console.log(`  provenance.json handed back unchanged — a passing check has nothing to record.`);
  }

  console.log(
    `${GREEN}PASS${OFF} ${families.join(' ')} — regenerated on ${currentPlatform()} and byte-identical to the commit.`,
  );
  process.exit(0);
}

/* ---------------------------------------------------------------- staleness */

/**
 * The kinds of staleness this can name. `hard` kinds cannot be a false positive:
 * they are claims `provenance.json` makes about itself. The rest are diagnostic —
 * history staleness in particular has been observed on a fixture that was in fact
 * byte-current, because a commit touching `src/sim` need not touch this family.
 */
const STALENESS = {
  'provenance-foreign-platform': { hard: true },
  'provenance-dirty': { hard: true },
  'provenance-missing': { hard: false },
  'provenance-commit-unknown': { hard: false },
  'history-source-newer': { hard: false },
  'history-unavailable': { hard: false },
  fresh: { hard: false },
} as const;
type StalenessKind = keyof typeof STALENESS;

interface Provenance {
  node?: string;
  platform?: string;
  commit?: string;
  dirty?: boolean;
}

interface Finding {
  family: string;
  kind: StalenessKind;
  detail: string;
}

function readProvenance(): Record<string, Provenance> {
  const path = join(ROOT, GOLDENS, 'provenance.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, Provenance>;
  } catch {
    return {};
  }
}

/**
 * The inputs a family's fixture is produced from: the oracle, plus that family's generator.
 *
 * `tools/gen-goldens.ts` is deliberately not in this list even though it writes the file. It
 * serialises rather than computes, so including it would report every family as possibly stale
 * on any commit that touched the index — a warning that fires for a comment change is a warning
 * that gets ignored. A change that does alter the bytes it writes is caught where it can be
 * caught properly: the byte comparison on the canonical runner.
 */
function inputsFor(family: string): string[] {
  return [join('src', 'sim'), join('tools', 'goldens', `${family}.ts`)];
}

function examine(family: string, provenance: Record<string, Provenance>): Finding {
  const entry = provenance[family];
  if (!entry) {
    return {
      family,
      kind: 'provenance-missing',
      detail:
        `no entry in ${join(GOLDENS, 'provenance.json')} — it has not been regenerated since provenance landed, ` +
        `so which machine produced it is unknown`,
    };
  }
  if (entry.platform !== CANONICAL_PLATFORM) {
    return {
      family,
      kind: 'provenance-foreign-platform',
      detail: `attributed to ${entry.platform ?? 'an unrecorded platform'}, not the canonical ${CANONICAL_PLATFORM}`,
    };
  }
  if (entry.dirty) {
    return {
      family,
      kind: 'provenance-dirty',
      detail: `generated from a dirty src/sim, so commit ${(entry.commit ?? '').slice(0, 7)} does not describe it`,
    };
  }

  if (git(['rev-parse', '--is-shallow-repository']).stdout === 'true') {
    return {
      family,
      kind: 'history-unavailable',
      detail: 'shallow clone — history staleness needs full history (actions/checkout fetch-depth: 0)',
    };
  }

  // Prefer the commit provenance records over the fixture's last commit: it is the commit the
  // numbers were actually produced at, which is the question, and a fixture can also be
  // regenerated to identical bytes and so carry an older last-commit than its regeneration.
  const basis = entry.commit && git(['cat-file', '-e', `${entry.commit}^{commit}`]).status === 0
    ? { commit: entry.commit, from: 'provenance' }
    : null;
  if (!basis) {
    return {
      family,
      kind: 'provenance-commit-unknown',
      detail: `records commit ${(entry.commit ?? '?').slice(0, 7)}, which is not in this clone`,
    };
  }

  const log = git(['log', '--oneline', `${basis.commit}..HEAD`, '--', ...inputsFor(family)]);
  if (log.status !== 0) {
    return {
      family,
      kind: 'history-unavailable',
      detail: `git could not compare ${basis.commit.slice(0, 7)}..HEAD`,
    };
  }
  const commits = log.stdout ? log.stdout.split('\n') : [];
  if (commits.length) {
    return {
      family,
      kind: 'history-source-newer',
      detail:
        `${commits.length} commit(s) touched ${inputsFor(family).join(' or ')} since it was generated at ` +
        `${basis.commit.slice(0, 7)} (newest: ${commits[0]})`,
    };
  }
  return {
    family,
    kind: 'fresh',
    detail: `nothing touched ${inputsFor(family).join(' or ')} since it was generated at ${basis.commit.slice(0, 7)}`,
  };
}

function staleness(families: string[], strict: boolean): never {
  announcePlatform();
  const provenance = readProvenance();
  const findings = families.map((f) => examine(f, provenance));

  for (const { family, kind, detail } of findings) {
    const hard = STALENESS[kind].hard;
    const tag = kind === 'fresh' ? `${GREEN}fresh${OFF}` : hard ? `${RED}STALE${OFF}` : `${YELLOW}stale?${OFF}`;
    console.log(
      `  ${tag} ${BOLD}${family}${OFF}  staleness=${kind}  canonical=${CANONICAL_PLATFORM}  ${detail}`,
    );
    if (kind !== 'fresh') {
      console.log(`        regenerate on ${CANONICAL_PLATFORM}: ${generatorCommand([family])}`);
      if (sensitivity(family) === 'sensitive') {
        console.log(`        why not here: ${evidenceFor(family)}`);
      }
    }
    if (hard) console.log(`::error::${family}: ${kind} — ${detail}`);
    else if (kind !== 'fresh') console.log(`::warning::${family}: ${kind} — ${detail}`);
  }

  const hard = findings.filter((f) => STALENESS[f.kind].hard);
  if (strict && hard.length) {
    console.error(
      `${RED}FAIL${OFF} ${hard.map((f) => f.family).join(' ')} — provenance says the committed fixture is untrustworthy.`,
    );
    process.exit(1);
  }
  console.log(
    `${GREEN}reported${OFF} ${findings.length} family/families; no byte comparison was performed on ${currentPlatform()}.`,
  );
  process.exit(0);
}

/* ------------------------------------------------------------------- driver */

const argv = process.argv.slice(2);
const mode = argv[0];
const strict = argv.includes('--strict');
const named = argv.slice(1).filter((a) => !a.startsWith('--')).map((a) => a.replace(/\.json$/, ''));

if (mode === 'freshness') freshness(named);
else if (mode === 'staleness') {
  const unknown = named.filter((f) => sensitivity(f) === 'unmeasured');
  if (unknown.length) {
    console.error(`no measurement recorded for: ${unknown.join(' ')}`);
    console.error(`measured families: ${measuredFamilies().join(' ')}`);
    process.exit(2);
  }
  // With no names: every family this repository has measured as platform-sensitive, which is
  // exactly the set a foreign runner cannot byte-compare and therefore the set it should report on.
  const sensitive = measuredFamilies().filter((f) => sensitivity(f) === 'sensitive');
  staleness(named.length ? named : sensitive, strict);
} else usage();
