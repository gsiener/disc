/**
 * Which golden families reproduce across machines, and which do not.
 *
 * A golden regenerated at the very commit that wrote it does not reproduce on a
 * different machine, and the size of the difference is not proportional to
 * anything: `coeffs.json` moves 4 of 2,297 numbers by one or two ULP, and
 * `matchdiff.json` — eleven fifteen-minute matches, ~108,000 chaotic ticks
 * apiece — moves 35 % of its counts, because one ULP anywhere is enough. Both
 * were measured; see `.agents/friction-log/20260811070423-a-golden-regenerated/`
 * and #41.
 *
 * That is why this file exists as *data* rather than as prose in a workflow
 * comment. Two consumers need the same answer and used to disagree about it:
 * `gen-goldens.ts`, which should say so before rewriting a fixture on the wrong
 * machine, and `check-goldens.ts`, which must refuse to byte-compare a
 * libm-sensitive family off the canonical platform — a comparison whose failure
 * looks exactly like a behaviour change and is not one.
 *
 * ------------------------------------------------------------- the rule for entries
 *
 * A family belongs in `PLATFORM_INDEPENDENT` only with a *measurement* that it
 * reproduces across machines, and in `PLATFORM_SENSITIVE` only with a
 * measurement that it does not. A family in neither is unmeasured, which is the
 * honest default and the reason `check-goldens.ts` refuses to gate on it: it
 * neither claims reproducibility nor denies it. Record the measurement in the
 * `measured` string, not only in the issue — the string is what a failing check
 * prints, and a diagnostic that cannot cite its evidence gets ignored.
 */

/**
 * The platform the committed fixtures are attributed to.
 *
 * This is not an aspiration: it is what `Goldens/provenance.json` records for
 * every family regenerated since provenance landed, and `spelled platform/arch`
 * the way `process.platform`/`process.arch` spell it, because that is what the
 * generator writes and what a comparison has to match.
 */
export const CANONICAL_PLATFORM = 'darwin/arm64';

export interface FamilyEvidence {
  /** What was measured about this family's cross-platform reproduction, and where. */
  readonly measured: string;
}

/** Families measured to reproduce byte-identically on any platform. */
export const PLATFORM_INDEPENDENT: Readonly<Record<string, FamilyEvidence>> = {
  rng: {
    measured:
      'xorshift128 is integer and bitwise operations plus one division by 2^32, all of which ' +
      'IEEE 754 specifies exactly; no pow, exp, log or trig anywhere in its call graph, so no ' +
      'libm. CI regenerates it on ubuntu-latest every run and byte-compares it against fixtures ' +
      'attributed to darwin/arm64.',
  },
};

/** Families measured NOT to reproduce across platforms. Never byte-compare these elsewhere. */
export const PLATFORM_SENSITIVE: Readonly<Record<string, FamilyEvidence>> = {
  coeffs: {
    measured:
      '4 of 2,297 numbers differ between linux/x86_64 (node v22.22.2) and darwin/arm64, worst ' +
      'relative error 3.4e-16 — one or two ULP of V8 arithmetic in sweep[43].drag and three ' +
      'neighbours, measured at the commit that wrote the fixture, so no source change is ' +
      'involved (#41).',
  },
  matchdiff: {
    measured:
      '35 % of its counts move between linux/x86_64 and darwin/arm64 at one commit — pull-drop ' +
      '23 vs 15, attempts 1630 vs 1599 — because eleven fifteen-minute matches are ~108,000 ' +
      'chaotic ticks apiece and one ULP anywhere is enough. Regenerating it on the wrong machine ' +
      'silently rebases every band in MatchDiffTests, and did turn a red assertion green with ' +
      'nothing about either engine changed (#41).',
  },
};

export type Sensitivity = 'independent' | 'sensitive' | 'unmeasured';

export function sensitivity(family: string): Sensitivity {
  if (Object.hasOwn(PLATFORM_INDEPENDENT, family)) return 'independent';
  if (Object.hasOwn(PLATFORM_SENSITIVE, family)) return 'sensitive';
  return 'unmeasured';
}

export function evidenceFor(family: string): string {
  return (
    PLATFORM_INDEPENDENT[family]?.measured ??
    PLATFORM_SENSITIVE[family]?.measured ??
    'no cross-platform measurement recorded'
  );
}

/** Every family with a recorded measurement, independent first. */
export function measuredFamilies(): string[] {
  return [...Object.keys(PLATFORM_INDEPENDENT), ...Object.keys(PLATFORM_SENSITIVE)];
}

/**
 * The platform this process is running on, as `provenance.json` spells it.
 *
 * `GOLDENS_PLATFORM` overrides it, and exists for one reason: the refusal path in
 * `check-goldens.ts` — "this family cannot be byte-compared here" — is otherwise
 * only reachable by owning two machines, so nothing could test it. Every consumer
 * announces the override when it is set (see `platformOverride()`), because a
 * silent way to make a foreign machine claim to be canonical is the one thing
 * this file exists to prevent. CI never sets it.
 */
export function currentPlatform(): string {
  return process.env.GOLDENS_PLATFORM || `${process.platform}/${process.arch}`;
}

/** The override value if one is in effect, else null. Print it wherever it is used. */
export function platformOverride(): string | null {
  return process.env.GOLDENS_PLATFORM || null;
}

export function isCanonicalPlatform(): boolean {
  return currentPlatform() === CANONICAL_PLATFORM;
}
