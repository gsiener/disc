/**
 * THE DIVERGENCE REGISTRY — every place the Swift port deliberately disagrees with
 * the oracle, plus the machinery that stops the list from being a work of fiction.
 *
 * ADR-0007 decided option B: a divergence from `src/sim/` is allowed, and it must be
 * declared. This file is the declaration. `SimChecks/DivergenceTests.swift` is the
 * enforcement, and it reads what this file emits rather than a second copy typed by
 * hand — issue #21 is what happens when two sides of a fixture are both typed by a
 * human and nothing asserts they agree.
 *
 * ------------------------------------------------------------------- the two halves
 *
 * 1. **A declared divergence is still exactly the one declared.** Each entry names a
 *    *public Swift constant* and the *reference expression* it disagrees with. The
 *    reference's number is SCRAPED out of `src/sim/*.ts` here, never retyped: an edit
 *    to the literal changes `scraped`, a rename or a reshuffle of the expression drops
 *    the match count to zero, and either way the Swift assertion goes red against the
 *    `reference` the human declared. The Swift value is read from the live symbol on
 *    the other side, so a drift there is red too.
 *
 * 2. **An undeclared divergence fails.** `referenceConstants` is every module-scope
 *    numeric constant in `src/sim/AI.ts`, scraped, not listed. The Swift side binds
 *    each of those names to a live symbol and asserts equality; a name it cannot bind
 *    has to be classified explicitly. So a constant that drifts on either side is a
 *    red assertion, and a *new* reference constant fails until somebody says what the
 *    port does with it.
 *
 * ---------------------------------------------------------------- the honest limit
 *
 * Both halves only see values that are NAMED on the Swift side. `land.y > 1.85` in
 * `defenceInFlight` is a bare literal in both engines; nothing here can watch it,
 * because `SimChecks` links `UltimateSim` as a library and sees public symbols, not
 * source text — and it has to, because ADR-0002 requires the same assertions to run on
 * a phone where there is no checkout to read. Naming the constant is the price of
 * being policed, which is also why the registry's first entry is the one that had a
 * name and no callers.
 *
 * The second limit is the standing one for every fixture here: this file runs when
 * somebody runs it. A reference edit that is never regenerated is a stale golden, and
 * CI runs no TypeScript (ADR-0001, issue #15).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIELD } from '../../src/sim/Rules.ts';

const ROOT = join(import.meta.dirname, '..', '..');

/** One reference expression a declared divergence stands against. */
type Site = {
  /** Repo-relative, so the failure label points at something a reader can open. */
  file: string;
  /** What the expression decides, in words. */
  what: string;
  /**
   * Must capture the number in group 1, and must be tight enough that editing the
   * expression around it stops matching. A loose pattern is worse than no pattern:
   * it keeps passing while the thing it was watching moves.
   */
  pattern: RegExp;
  /** How many times it is expected to appear in that file. */
  count: number;
};

type Divergence = {
  /** The public Swift constant. Public because the checker reads the live symbol. */
  constant: string;
  /** What Swift is declared to hold. Asserted against the live symbol. */
  swift: number;
  /** What the reference is declared to hold. Asserted against the scrape below. */
  reference: number;
  reason: string;
  /** ISO date the divergence was declared. */
  declared: string;
  sites: Site[];
};

/* ------------------------------------------------------------------ the registry */

const REGISTRY: Divergence[] = [
  {
    constant: 'LAYOUT_CEILING',
    swift: 1.1,
    reference: 1.85,
    declared: '2026-08-10',
    reason:
      'The highest a disc can arrive and still be a DIVE. A layout is horizontal — ' +
      "`Locomotion.beginLayout` takes the body prone — so a prone body's reach ceiling " +
      'is a little over a metre. The reference guards the bid at 1.85 and NOTHING ' +
      'REACHES IT: `land.y` comes out of `predictCatchPoint` clamped to `CATCH_CEILING` ' +
      '(1.45). Measured over three full reference matches, 202k evaluations of this ' +
      'branch: max land.y 1.4498, zero above 1.45. So the reference guard is inert and a ' +
      'defender under a descending huck arriving at chest height leaves his feet for a ' +
      'disc he could only ever have jumped at, and spends two seconds on the turf when ' +
      'he misses. 1.10 is the height a prone body actually reaches. See ADR-0007.',
    sites: [
      {
        file: 'src/sim/AI.ts',
        what: 'defenceInFlight — the height guard on the bid branch',
        pattern: /p\.id === onPlay && land\.y < (\d+(?:\.\d+)?)/g,
        count: 1,
      },
    ],
  },
];

/* ------------------------------------------------------------------- the scraping */

/**
 * Every module-scope `const NAME = <number>;` in a reference file, exported or not.
 *
 * `export ` is optional in the pattern and that is load-bearing rather than tidy. It
 * used to be absent, which made **adding an `export` to a constant delete it from this
 * map** — the constant would vanish from `referenceConstants`, and the binding in
 * `DivergenceTests.mirrored` would then fail with "the reference no longer declares it"
 * for a constant that had not moved an inch. A registry whose coverage depends on a
 * keyword unrelated to the value is a registry with a hole in it.
 */
function moduleConstants(file: string): Record<string, number> {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const out: Record<string, number> = {};
  const re = /^(?:export )?const ([A-Z][A-Z_0-9]*) = (-?\d+(?:\.\d+)?);/gm;
  for (const m of src.matchAll(re)) out[m[1]!] = Number(m[2]!);
  // Sorted, so the fixture's diff is about values rather than about declaration order.
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Reads a site's literal back out of the reference.
 *
 * Returns `scraped: null` rather than throwing when the pattern stops matching. A
 * throw here would only ever be seen by whoever ran the generator; a null lands in the
 * fixture and fails in the differential suite, which is where this repository keeps its
 * teeth and the only place the on-device run can see it.
 */
function scrape(site: Site): { file: string; what: string; scraped: number | null; found: number } {
  const src = readFileSync(join(ROOT, site.file), 'utf8');
  const values = [...src.matchAll(site.pattern)].map((m) => Number(m[1]!));
  const agreed = values.length > 0 && values.every((v) => v === values[0]);
  return {
    file: site.file,
    what: site.what,
    scraped: agreed && values.length === site.count ? values[0]! : null,
    found: values.length,
  };
}

export function divergenceGoldens() {
  const divergences = REGISTRY.map((d) => ({
    constant: d.constant,
    swift: d.swift,
    reference: d.reference,
    reason: d.reason,
    declared: d.declared,
    sites: d.sites.map((s) => ({ ...scrape(s), expected: s.count })),
  }));

  for (const d of divergences) {
    for (const s of d.sites) {
      if (s.scraped === null) {
        console.warn(
          `  !! ${d.constant}: "${s.what}" matched ${s.found}x in ${s.file}, expected ` +
            `${s.expected}. DivergenceTests will fail until the pattern in ` +
            `tools/goldens/divergences.ts is repointed.`,
        );
      }
    }
  }

  return {
    note:
      'Generated by tools/gen-goldens.ts from tools/goldens/divergences.ts. The ' +
      'declared values are typed by a human; `scraped` is read out of the reference ' +
      'source. swift/Sources/SimChecks/DivergenceTests.swift asserts they agree and ' +
      'that the live Swift symbols agree with `swift`. See ADR-0007.',
    divergences,
    referenceConstants: moduleConstants('src/sim/AI.ts'),
    referencePullConstants: pullConstants(),
  };
}

/**
 * The pull's seven fitted constants, out of `src/sim/Game.ts`.
 *
 * **This scrape exists because the port did not carry a single one of them.** ADR-0007's
 * third rule — equality with the oracle is asserted by default — was wired to `AI.ts`
 * only, and `doPull`'s constants live in `Game.ts`, so "a reference constant the port
 * does not carry under that name has to be classified with a reason" never applied to
 * them. `Engine.autoPull` was consequently an independently invented pull that aimed
 * 16.8 m short of every pull the reference throws, for the whole life of the feature,
 * with 2.25 M green assertions either side of it. See issue #2 and
 * `.agents/friction-log/20260811065754-the-port-s/`.
 *
 * Narrow on purpose: `PULL_*`, not all of `Game.ts`. That file is 173 KB of a Three.js
 * system and most of its constants are about a renderer the port does not have, so
 * scraping it whole would mean a long `unmirrored` list written in one sitting by
 * somebody who was not thinking about any of them. Widening this to the rest of
 * `Game.ts` is its own piece of work.
 *
 * `PULL_TARGET_Z` is an *expression* (`FIELD.GOAL_LINE + 4`) rather than a literal, so
 * `moduleConstants`' pattern cannot see it. It gets its own pattern, tight enough that
 * editing the expression stops matching — and a name that stops matching lands as `null`
 * in the fixture and fails on the Swift side, which is where the teeth are.
 */
function pullConstants(): Record<string, number | null> {
  const all = moduleConstants('src/sim/Game.ts');
  const out: Record<string, number | null> = {};
  for (const [name, value] of Object.entries(all)) {
    if (name.startsWith('PULL_')) out[name] = value;
  }
  const src = readFileSync(join(ROOT, 'src/sim/Game.ts'), 'utf8');
  const target = [
    ...src.matchAll(/^const PULL_TARGET_Z = FIELD\.GOAL_LINE \+ (\d+(?:\.\d+)?);/gm),
  ];
  out['PULL_TARGET_Z'] = target.length === 1 ? FIELD.GOAL_LINE + Number(target[0]![1]!) : null;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}
